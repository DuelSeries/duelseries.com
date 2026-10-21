'use strict';
// The paid sl directory (PAID-SL-DESIGN.md 1, 2, 7.2, 7.5; task T4): the $0.50 and $1 snake rooms on the sl engine.
// It owns ONLY paid rooms; the free SlArenas (server/sl/slArenas.js) keeps its one room and its routing, and slSockets
// sends a socket here only when its handshake said paid (setPaid, st.dir). No server/sl file requires this one
// (critic C-2, test/slNoMoney.test.js): the server builds it and hands it to slSockets.
//
// Rooms: plain SlRooms built with { money, lobbyType, humanCap: C_PAID_HUMAN_CAP, emergencyFails: 1, no bots, seed:
// crypto.randomInt(1, 2^31 - 1) (never sent or logged, D2-m4), prey as the free room }, each with its own money
// controller (server/slPaid/slMoney.js) on the server's hooks plus this directory's walletSeat. Up to ROOMS_PER_RUNG
// rooms per rung, opened lazily, fullest with space first (agar's seatFor); labels sl_<region>_s0_5, then
// sl_<region>_s0_5#1 to #3, and sl_<region>_s1 ... (the journal keys records by them).
//
//   rungs            Map stake -> [room], index order (only while paid: SL_PAID built the directory)
//   paidEnabled      the rungs exist; paidOpen the owner's switch (sl:paid:off/on); stopping set once by shutdownSettle
//   settling         emergency-closed rooms whose bank still holds money or whose settle left an account open: all()
//                    keeps them, so the drain and the solvency sum count them, and the sweep retries them
//   walletSeat       Map wallet -> { room, snakeId }: one open paid snake per wallet across every paid room (Owen,
//                    OWEN-QUESTION 3). Set by onAccountOpen (which throws when the wallet is already seated) and
//                    cleared ONLY by onAccountClosed, so an account an emergency settle left open in a settling room
//                    still holds its wallet's seat (one account per wallet, MONEY INVARIANT 4; checkWalletSeats)
//   roomOf(id)       the live room whose seats hold this socket id (a scan of at most 8 rooms): a resume moves the
//                    seat to the new socket's id (slRoom.resume), so routing follows it with no index to keep in step
//   roomForKey(k)    the live room whose keys hold this resume key (slSockets onBack, paid sockets)
//   leave, disconnect, input, hold, vis, chat, diag   slSockets' calls by socket id, as SlArenas names them (a
//                    watcher's socket too: roomOf looks in the watchers)
//   isOpen(), watch(socket, {stake, after})  a read-only watcher of the rung's busiest room (the lobby's Spectate)
//   seatFor(stake, exclude)  a room with space (the door's step 11); hasSpace(stake) the same without opening one
//   walletSeatOf(wallet), hasAccount(jid), labelOf(stake, index), setPaidOpen(on)
//   boardRows()      one row per rung for /api/live: players = open accounts (live, gliding or parked, each once),
//                    parked = gliding accounts, bots 0, capacity C_PAID_HUMAN_CAP x rooms; 'closed' under the switch,
//                    while stopping, or while no room of the rung can seat anyone (hasSpace false), and then listed only
//                    while it still holds an account (rule 4b never blind); a room that cannot be counted is counted by
//                    its seats and marks its row unknown (the count is a floor, not the truth)
//   all()            every rung room plus settling; humanTotal() the open accounts of the live rooms
//   maxSliceMs()     the largest synchronous slice of any paid room since the last call, read and reset (the free
//                    directory's extraLoad: the bot governor sees paid tick cost, D2-m9)
//   sweep(now)       every 60 s: a room with no account, seat, orphan or parked seat for FLOOR_SWEEP_MS books its floor
//                    to the house (money.sweepFloor, one sweep per source wallet) and retires (an account opened or
//                    closed since a sample restarts the clock, so a life between two samples is never missed); a
//                    settling room is retried (emergencySettle while an account is open, else sweepFloor) and dropped
//                    once empty. Nothing runs while stopping (no money moves in the exit window).
//   setBotTarget(stake, n)  the owner's bots for a rung (Owen 2026-10-16): n bots held in the rung's room #0 (opened
//                    if none is), saved through opts.botStore so a deploy keeps them; while n > 0 that room stays awake
//                    and is never retired. The bots play for the gold and never cash out (slMoney botFrom): a bot's
//                    money drops back into play when it dies, and any other way out, the room's unclaimed floor
//                    included, goes back to the players it came from, never to the house; nobody in the room for
//                    FLOOR_SWEEP_MS releases it (sweep). botTarget(stake) reads it, botCount(stake) the live bots.
//   shutdownSettle(why)  a planned restart or a crash (design 7.2): stopping, then for each room the money rows FIRST
//                    (money.shutdownSettle: 100% of every current balance, journaled, the floor booked abandoned), then
//                    room.halt() (the clock only). Returns the rows for the caller to write.

const crypto = require('crypto');
const { SlRoom } = require('../sl/slRoom');
const { assertLawsComplete } = require('../sl/slLaws');
const { createSlMoney, REQUIRED_HOOKS } = require('./slMoney');
const { STAKE_TIERS } = require('../stakeRules');
const { ROOMS_PER_RUNG, FLOOR_SWEEP_MS } = require('./slPaidConst');

// The hooks the server hands in; onAccountOpen and onAccountClosed are this directory's own (walletSeat).
const SERVER_HOOKS = Object.freeze(REQUIRED_HOOKS.filter((k) => k !== 'onAccountOpen' && k !== 'onAccountClosed'));
const ROOM_KEYS = Object.freeze(['clock', 'now', 'timers', 'autoTick', 'view', 'prey']);
const SEED_MAX = 2 ** 31 - 1;
// The owner's bots per paid rung (room #0), on top of its C_PAID_HUMAN_CAP people (the paid border is pinned, so they
// never move it); the room's own C_ROOM_CAP still bounds people and bots together.
const PAID_BOT_MAX = 40; // design 1: crypto.randomInt(1, 2^31 - 1)

class SlPaidArenas {
  // laws: the law table. opts:
  //   region         'na' (row ids sl:<region>:s<stake>, labels sl_<region>_s...)
  //   paid           true: the rungs exist (SL_PAID built the directory); false: none, closed (the door refunds)
  //   moneyHooks     onCashout, onOwed, onFloor, onHouse, onBreach, onTransfer, journal (slMoney REQUIRED_HOOKS)
  //   shippableOnly  false only for the dev law table and tests
  //   clock, now, timers, autoTick, view, prey   handed to each room; checkEvery to each controller (tests 1)
  //   seed           tests only: room n gets seed + n (a whole number >= 1); default crypto.randomInt per room
  //   makeRoom(laws, opts), makeMoney(opts)      tests
  //   log
  constructor(laws, opts) {
    const o = opts || {};
    assertLawsComplete(laws, ['C_PAID_HUMAN_CAP']);
    this.laws = laws;
    this.region = typeof o.region === 'string' && o.region ? o.region : 'na';
    this.log = o.log || console;
    this.opts = o;
    this.shippableOnly = o.shippableOnly !== false;
    this.paidEnabled = o.paid === true;
    this.paidOpen = this.paidEnabled;
    this.stopping = false;
    if (this.paidEnabled) {
      const h = o.moneyHooks || {};
      for (const k of SERVER_HOOKS) {
        if (k === 'journal' ? !(h.journal && typeof h.journal.open === 'function' && typeof h.journal.close === 'function')
          : typeof h[k] !== 'function') {
          throw new Error('SlPaidArenas: moneyHooks.' + k + ' is required');
        }
      }
    }
    if (o.seed !== undefined && (!Number.isSafeInteger(o.seed) || o.seed < 1)) {
      throw new Error('SlPaidArenas: opts.seed must be a whole number >= 1 (tests only)');
    }
    this.moneyHooks = o.moneyHooks || null;
    this.makeRoom = typeof o.makeRoom === 'function' ? o.makeRoom : ((l, ro) => new SlRoom(l, ro));
    this.makeMoney = typeof o.makeMoney === 'function' ? o.makeMoney : createSlMoney;
    this.cap = laws.C_PAID_HUMAN_CAP.value;
    this.rungs = new Map(); // stake -> rooms, index order
    if (this.paidEnabled) for (const s of STAKE_TIERS) this.rungs.set(s, []);
    this.settling = [];
    this.walletSeat = new Map(); // wallet -> { room, snakeId }
    this.place = new WeakMap(); // room -> { stake, index }
    this.emptySince = new Map(); // room -> { at: wall ms the sweep first saw it empty, act: its activity then }
    this.activity = new WeakMap(); // room -> accounts opened and closed in it so far (_touch)
    this.created = 0;
    this.retired = 0;
    this.closedRooms = 0;
    // the owner's paid bots: opts.botDriver() -> a fresh slBots driver per room #0; opts.botStore { load, save }
    this.botDriver = typeof o.botDriver === 'function' ? o.botDriver : null;
    this.botBank = o.botBank && typeof o.botBank.take === 'function' ? o.botBank : null;
    this.botStore = o.botStore && typeof o.botStore.load === 'function' ? o.botStore : null;
    this.botTargets = new Map(); // stake -> n
    if (this.paidEnabled && this.botDriver && this.botStore) {
      let saved = null;
      try {
        saved = this.botStore.load();
      } catch (e) {
        this.log.error('[SLP] paid bots: saved targets unreadable: ' + (e && e.message));
      }
      for (const st of this.rungs.keys()) {
        const n = saved ? saved[String(st)] : undefined;
        if (Number.isInteger(n) && n > 0 && n <= PAID_BOT_MAX) this.botTargets.set(st, n);
      }
    }
  }

  // Opens room #0 of every rung with a saved bot target (boot), so Owen's bots are back after a deploy.
  // A fund from the Bot bank wallet landed: spawn the bots that were waiting for it (only counts Owen asked for).
  resumeBots() {
    if (!this.botBank || !this.botWant || this.stopping) return;
    for (const [stake, more] of Array.from(this.botWant)) {
      try {
        this._applyBots(stake, this.botCount(stake) + more);
      } catch (e) {
        this.botWant.delete(stake);
        this.log.error('[BOTS] paid bots not resumed at ' + stake + ': ' + (e && e.message));
      }
    }
    this._saveTargets();
  }

  startBots() {
    if (!this.botBank) return;
    for (const [stake, n] of Array.from(this.botTargets)) if (n > 0) this._applyBots(stake, n);
    this._saveTargets();
  }

  botTarget(stake) {
    const st = this._rungOf(stake);
    return st === null ? null : (this.botTargets.get(st) || 0);
  }

  botCount(stake) {
    const st = this._rungOf(stake);
    if (st === null) return 0;
    let n = 0;
    for (const r of this.rungs.get(st) || []) n += Number(r.botCount) || 0;
    return n;
  }

  // Bounty bots (Owen 2026-10-17): n live bots in the rung's room #0, each spawned carrying the rung's stake from the
  // owner's bot bank (opts.botBank). Fewer: the extra bots leave now (their seed back to the bank, what they picked up
  // back to its players). More: one at a time while the bank covers a seed and today's cap allows it; the first
  // refusal stops and says why. A killed bot is never replaced (no respawn): the count only rises by Control.
  // -> { ok, live, held, why?, saved } or { ok: false, why }
  setBotTarget(stake, n) {
    const st = this._rungOf(stake);
    if (!this.paidEnabled || st === null) return { ok: false, why: 'No paid snake rung at ' + stake };
    if (!this.botDriver || !this.botBank) return { ok: false, why: 'Paid snake bots are not wired on this server' };
    if (this.stopping) return { ok: false, why: 'The server is stopping' };
    if (!Number.isInteger(n) || n < 0 || n > PAID_BOT_MAX) return { ok: false, why: 'Bots: a whole number from 0 to ' + PAID_BOT_MAX };
    let r;
    try {
      r = this._applyBots(st, n);
    } catch (e) {
      // a bank refusal (the ceiling) while taking a bot out: logged and refused, never thrown into the owner's request
      this.log.error('[SLP] paid bots: set ' + st + ' to ' + n + ' failed: ' + (e && e.message));
      this._saveTargets();
      return { ok: false, why: 'Paid bots could not be changed just now: ' + String(e && e.message).slice(0, 120) };
    }
    this._saveTargets();
    return Object.assign({ ok: true, held: n }, r);
  }

  _saveTargets() {
    for (const st of this.rungs.keys()) {
      // bots still waiting for their seed to reach escrow count too, so a restart meanwhile keeps them
      const live = this.botCount(st) + ((this.botWant && this.botWant.get(st)) || 0);
      if (live > 0) this.botTargets.set(st, live);
      else this.botTargets.delete(st);
    }
    if (!this.botStore || typeof this.botStore.save !== 'function') return false;
    try {
      const obj = {};
      for (const [k, v] of this.botTargets) obj[String(k)] = v;
      return this.botStore.save(obj) !== false;
    } catch (e) {
      this.log.error('[SLP] paid bots: counts not saved: ' + (e && e.message));
      return false;
    }
  }

  // -> { live, why } (why: null, or why it stopped short: the bank or today's cap)
  _applyBots(stake, n) {
    // a count still waiting on a seed moving from the Bot bank wallet (resumeBots finishes it once it lands)
    if (!this.botWant) this.botWant = new Map();
    this.botWant.delete(stake);
    const list = this.rungs.get(stake) || [];
    let room = list.find((r) => this.place.get(r).index === 0 && !r.stopped && !r.closed) || null;
    if (!room && n > 0) {
      try {
        room = this._create(stake, 0);
      } catch (e) {
        this.log.error('[SLP] paid bots: room for ' + stake + ' not opened: ' + (e && e.message));
        return { live: 0, why: 'The room did not open' };
      }
    }
    if (!room || !room.bots || room.paidBots !== true) return { live: 0, why: n > 0 ? 'The room takes no bots' : null };
    let why = null;
    const have = Number(room.botCount) || 0;
    if (have > n) room.bots.removeBots(room, have - n);
    const seed = Math.round(stake * 1e6);
    for (let i = Number(room.botCount) || 0; i < n; i++) {
      const no = this.botBank.whyNot(seed);
      if (no) {
        // only the bots still to come (a bot killed meanwhile is not replaced: no respawn)
        if (no === 'funding') this.botWant.set(stake, n - (Number(room.botCount) || 0));
        why = no === 'cap' ? 'The daily bot limit is reached' : no === 'funding'
          ? 'The rest join in a few seconds, once their money has moved from the Bot bank wallet to escrow'
          : 'The bot bank cannot cover another $' + stake + ' bot';
        break;
      }
      const rec = room.addBot();
      if (!rec) {
        why = 'The room would not take another bot just now';
        break;
      }
      rec.manual = true; // never refilled by the fill (no respawn)
      if (!this.botBank.take(seed, room.lobbyType)) {
        room.removeBot(rec.id);
        why = 'The bot bank refused the seed';
        break;
      }
      try {
        room.money.seedBot(rec.id, seed, rec.nick);
      } catch (e) {
        this.botBank.giveBack(seed, 'seed-failed', room.lobbyType, true);
        room.removeBot(rec.id);
        this.log.error('[SLP] paid bots: seed of ' + rec.id + ' refused, given back: ' + (e && e.message));
        why = 'The room refused the seed';
        break;
      }
    }
    room.setAwake((Number(room.botCount) || 0) > 0);
    return { live: Number(room.botCount) || 0, why };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Rooms

  _rungOf(stake) {
    if (typeof stake !== 'number') return null;
    for (const s of this.rungs.keys()) if (Math.abs(s - stake) <= 1e-9) return s;
    return null;
  }

  // sl_na_s0_5, sl_na_s0_5#1, sl_na_s1, ...
  labelOf(stake, index) {
    const i = Number.isInteger(index) && index > 0 ? '#' + index : '';
    return 'sl_' + this.region + '_s' + String(stake).replace('.', '_') + i;
  }

  stakeOf(room) {
    const p = this.place.get(room);
    return p ? p.stake : null;
  }

  rooms() {
    const out = [];
    for (const list of this.rungs.values()) out.push(...list);
    return out;
  }

  // Every room: the rungs, then settling (owner console, drain, solvency).
  all() {
    const out = this.rooms();
    for (const r of this.settling) if (!out.includes(r)) out.push(r);
    return out;
  }

  _seed() {
    if (this.opts.seed !== undefined) return this.opts.seed + this.created;
    return crypto.randomInt(1, SEED_MAX);
  }

  _create(stake, index) {
    const label = this.labelOf(stake, index);
    let room = null;
    const mo = { stake, label, hooks: this._hooks(() => room), log: this.log, walletSeat: this.walletSeat,
      laws: this.laws };
    if (this.opts.now !== undefined) mo.now = this.opts.now;
    if (this.opts.checkEvery !== undefined) mo.checkEvery = this.opts.checkEvery;
    const money = this.makeMoney(mo);
    const ro = { money, lobbyType: label, humanCap: this.cap, emergencyFails: 1, seed: this._seed(),
      region: this.region, shippableOnly: this.shippableOnly, log: this.log };
    for (const k of ROOM_KEYS) if (this.opts[k] !== undefined) ro[k] = this.opts[k];
    // room #0 of each rung can hold the owner's bots (setBotTarget); its driver starts held at 0, so it never fills
    // by itself
    const driver = index === 0 && this.botDriver ? this.botDriver() : null;
    if (driver) {
      ro.bots = driver;
      ro.paidBots = true;
    }
    room = this.makeRoom(this.laws, ro);
    // the fill paused for good: only Control's bots, never refilled (a manual bot is never retired by the fill)
    if (driver) room._botsPausedUntil = Number.MAX_SAFE_INTEGER;
    this.created++;
    this.place.set(room, { stake, index });
    room.onClosed = (closed, sockets) => this._closed(closed, sockets);
    const list = this.rungs.get(stake);
    list.push(room);
    list.sort((a, b) => this.place.get(a).index - this.place.get(b).index);
    return room;
  }

  // One room's controller hooks: the server's, plus walletSeat through this directory.
  _hooks(roomOf) {
    const h = this.moneyHooks || {};
    return {
      onCashout: (order) => h.onCashout(order),
      onOwed: (row) => h.onOwed(row),
      onFloor: (sweep) => h.onFloor(sweep),
      onHouse: (incident) => h.onHouse(incident),
      onBreach: (info) => h.onBreach(info),
      onTransfer: (t) => h.onTransfer(t),
      onAccountOpen: (acct) => this._accountOpened(roomOf(), acct),
      onAccountClosed: (acct) => this._accountClosed(roomOf(), acct),
      // a bounty bot's unspent seed back to the owner's bot bank (slMoney _owedRows); throws when there is none, so the
      // controller logs it CRITICAL and alerts rather than losing it quietly
      onSeedBack: (micro, why, label, live) => {
        if (!this.botBank) throw new Error('no bot bank');
        if (!this.botBank.giveBack(micro, why, label, live)) throw new Error('the bot bank refused ' + micro);
      },
      // a bot died: its seed is in play now, no longer held by a live bot (the bank's hard-stop recovery)
      onSeedSpent: (micro) => { if (this.botBank) this.botBank.spent(micro); },
      journal: h.journal,
    };
  }

  // The wallet check comes FIRST and throws, so the controller rolls its deposit back before any journal write.
  _accountOpened(room, acct) {
    if (this.walletSeat.has(acct.wallet)) throw new Error('SlPaidArenas: wallet already holds an open paid snake');
    this.walletSeat.set(acct.wallet, { room, snakeId: acct.snakeId });
    this._touch(room);
  }

  _accountClosed(room, acct) {
    const w = this.walletSeat.get(acct.wallet);
    if (w && w.room === room && w.snakeId === acct.snakeId) this.walletSeat.delete(acct.wallet);
    this._touch(room);
  }

  // Every seat, orphan and parked seat of a paid room holds an account opened after the sweep's last sample or still
  // open at it, so a count of opens and closes tells the sweep of a whole life that fell between two samples.
  _touch(room) {
    if (room) this.activity.set(room, (this.activity.get(room) || 0) + 1);
  }

  // The room closed itself (emergencyClose, after its money settled): it leaves its rung, so the next join opens a
  // fresh one; a room whose settle left an account open or money in its bank goes on settling; its sockets are let go
  // (each seat was told {t:'closed'} first).
  _closed(room, sockets) {
    const stake = this.stakeOf(room);
    const list = stake === null ? null : this.rungs.get(stake);
    const i = list ? list.indexOf(room) : -1;
    if (i !== -1) list.splice(i, 1);
    this.emptySince.delete(room);
    this.closedRooms++;
    if (this._holds(room) && !this.settling.includes(room)) this.settling.push(room);
    for (const s of sockets || []) {
      try {
        if (s && typeof s.disconnect === 'function') s.disconnect(true);
      } catch (e) { /* already gone */ }
    }
  }

  // Money still inside a room: an open account or bank micro (the settle's left, design 7.4).
  _holds(room) {
    const m = room.money;
    if (!m) return false;
    if (m.openCount() > 0) return true;
    return m.bank && typeof m.bank.totalMicro === 'function' ? m.bank.totalMicro() > 0 : m.liveStakeTotal() > 0;
  }

  // Seats can open here now: live, under its cap, its controller neither settled nor tainted.
  _open(room) {
    return !room.stopped && !room.closed && room.refusal() === null && !room.money.stopped && !room.money.tainted;
  }

  _humans(room) {
    return room.seats.size + room.orphans.size;
  }

  // A room of this rung with space: the fullest first (not exclude), else a new one while the rung has fewer than
  // ROOMS_PER_RUNG, else null.
  seatFor(stake, exclude) {
    const rung = this._rungOf(stake);
    if (rung === null) return null;
    const list = this.rungs.get(rung);
    const open = list.filter((r) => r !== exclude && this._open(r))
      .sort((a, b) => this._humans(b) - this._humans(a) || this.place.get(a).index - this.place.get(b).index);
    if (open.length) return open[0];
    if (list.length < ROOMS_PER_RUNG) {
      const used = new Set(list.map((r) => this.place.get(r).index));
      let n = 0;
      while (used.has(n)) n++;
      return this._create(rung, n);
    }
    return null;
  }

  // The door's step 5: would seatFor find or open a room? Opens nothing.
  hasSpace(stake) {
    const rung = this._rungOf(stake);
    if (rung === null) return false;
    const list = this.rungs.get(rung);
    return list.length < ROOMS_PER_RUNG || list.some((r) => this._open(r));
  }

  walletSeatOf(wallet) {
    return typeof wallet === 'string' ? this.walletSeat.get(wallet) || null : null;
  }

  // Any paid room (settling included) holds an open account for this jid.
  hasAccount(jid) {
    for (const r of this.all()) if (r.money && r.money.account(jid)) return true;
    return false;
  }

  // sl:paid:off / sl:paid:on. Reopening is refused while stopping or when the rungs were never built.
  setPaidOpen(on) {
    if (on !== true && on !== false) return { ok: false, why: 'bad-value', open: this.paidOpen };
    if (on && !this.paidEnabled) return { ok: false, why: 'not-built', open: false };
    if (on && this.stopping) return { ok: false, why: 'stopping', open: false };
    this.paidOpen = on;
    return { ok: true, open: on };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Routing (slSockets, by socket id)

  roomOf(socketId) {
    for (const list of this.rungs.values()) {
      for (const r of list) if (!r.stopped && (r.seats.has(socketId) || r.watchers.has(socketId))) return r;
    }
    return null;
  }

  // Watching a rung (the lobby's Spectate on a $0.50 or $1 rung; slSockets: a watch handshake with watchStake):
  // the busiest live room of that stake, read only (slRoom seatWatch: never a seat, never money). Watchers are capped
  // per room as players are (C_PAID_HUMAN_CAP), and a rung with nobody playing has nothing to watch. Opens nothing.
  isOpen() {
    return this.paidEnabled && !this.stopping;
  }

  watch(socket, info) {
    if (!this.isOpen()) return 'closed';
    const rung = this._rungOf(info && info.stake);
    if (rung === null) return 'closed';
    // a room with people, else the room the owner's bots are playing in
    const busy = (r) => this._humans(r) * 1000 + (Number(r.botCount) || 0);
    const live = this.rungs.get(rung).filter((r) => !r.stopped && !r.closed && busy(r) > 0)
      .sort((a, b) => busy(b) - busy(a) || this.place.get(a).index - this.place.get(b).index);
    if (!live.length) return 'nobody';
    const room = live[0];
    if (room.watchers.size >= room.R.humanCap) return 'full';
    return room.seatWatch(socket, { after: info && info.after, before: info && info.before }) ? true : 'nobody';
  }

  roomForKey(key) {
    if (typeof key !== 'string') return null;
    for (const list of this.rungs.values()) {
      for (const r of list) if (!r.stopped && r.keys.has(key)) return r;
    }
    return null;
  }

  leave(socketId, onEnd) {
    const r = this.roomOf(socketId);
    return r ? r.unseat(socketId, 'leave', onEnd) : false;
  }

  disconnect(socketId, onEnd) {
    const r = this.roomOf(socketId);
    return r ? r.unseat(socketId, 'disconnect', onEnd) : false;
  }

  input(socketId, bytes) {
    const r = this.roomOf(socketId);
    return r ? r.onInput(socketId, bytes) : false;
  }

  hold(socketId, on) {
    const r = this.roomOf(socketId);
    return r ? r.onHold(socketId, on) : false;
  }

  vis(socketId, hidden) {
    const r = this.roomOf(socketId);
    return r ? r.onVis(socketId, hidden) : false;
  }

  chat(socketId, text) {
    const r = this.roomOf(socketId);
    return r ? r.onChat(socketId, text) : false;
  }

  diag(socketId, d) {
    const r = this.roomOf(socketId);
    return r ? r.onDiag(socketId, d) : false;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Counts and the board

  boardRows() {
    if (!this.paidEnabled) return [];
    const rows = [];
    const on = this.paidOpen && !this.stopping;
    for (const [stake, list] of this.rungs) {
      let players = 0;
      let parked = 0;
      let unknown = 0;
      for (const r of list.concat(this.settling.filter((x) => this.stakeOf(x) === stake))) {
        // one room that cannot be read never hides the others (review OPS-2): it counts its seats and orphans, and
        // the row says unknown, which /api/live reports as unknown ['slpaid'] (rule 4b: cannot tell, never "nobody")
        try {
          players += r.money.openCount();
          for (const id of r.orphans.keys()) if (r.money.account(id)) parked++;
        } catch (e) {
          unknown++;
          try {
            players += r.seats.size + r.orphans.size;
          } catch (_) { /* nothing more to count */ }
          this.log.error('[SLP] board row: room ' + r.lobbyType + ' could not be counted: ' + (e && e.message));
        }
      }
      // a rung where no room can seat anyone (every room full, tainted or settled) is not open (review LOBBY-1): the
      // same /api/live answer then lists the old engine's row for this stake, so the lobby stops taking stakes the
      // door would refuse 'full'
      let space = false;
      try {
        space = this.hasSpace(stake);
      } catch (e) {
        unknown++;
        this.log.error('[SLP] board row: rung ' + stake + ' space unknown: ' + (e && e.message));
      }
      const open = on && space;
      if (!open && players === 0 && !unknown) continue;
      const row = {
        id: 'sl:' + this.region + ':s' + stake,
        game: 'snake',
        region: this.region,
        stake,
        players,
        parked,
        bots: list.reduce((n, r) => n + (Number(r.botCount) || 0), 0),
        capacity: this.cap * list.length,
        state: open ? 'open' : 'closed',
      };
      if (unknown) row.unknown = unknown;
      rows.push(row);
    }
    return rows;
  }

  humanTotal() {
    let n = 0;
    for (const r of this.rooms()) if (!r.stopped) n += r.money.openCount();
    return n;
  }

  maxSliceMs() {
    let max = 0;
    for (const r of this.rooms()) {
      if (!r.stats) continue;
      const s = Number.isFinite(r.stats.maxSliceMs) ? r.stats.maxSliceMs : 0;
      if (s > max) max = s;
      r.stats.maxSliceMs = 0;
    }
    return max;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Periodic and the end

  sweep(now) {
    const out = { retired: 0, settled: 0 };
    if (!this.paidEnabled || this.stopping) return out;
    // no respawn: the saved counts follow the live bots (a killed bot is gone until Control adds one)
    try {
      this._saveTargets();
    } catch (e) {
      this.log.error('[SLP] paid bots: counts not saved: ' + (e && e.message));
    }
    for (const list of this.rungs.values()) {
      for (const room of list.slice()) {
        // a room that closed itself but is still listed (its close hook never ran): let it go the same way now
        if (room.closed) {
          this._closed(room, []);
          continue;
        }
        const held = this.place.get(room).index === 0 && (Number(room.botCount) || 0) > 0;
        const people = room.money.openCount() > 0 || room.seats.size > 0 || room.orphans.size > 0 || room.parked.size > 0;
        if (people || room.stopped) {
          this.emptySince.delete(room);
          continue;
        }
        if (held) {
          // the owner's bots keep the room, but money never sits with them for good: nobody here for FLOOR_SWEEP_MS,
          // what the bots picked up goes back to the players it came from (the floor stays money on the board, slMoney
          // releaseBots), and the clock starts again
          const act = this.activity.get(room) || 0;
          const e = this.emptySince.get(room);
          if (!e || e.act !== act) this.emptySince.set(room, { at: now, act });
          else if (now - e.at >= FLOOR_SWEEP_MS) {
            try {
              room.money.releaseBots('idle');
            } catch (err) {
              this.log.error('[SLP] paid bots: idle release of ' + room.lobbyType + ' failed: ' + (err && err.message));
            }
            this.emptySince.set(room, { at: now, act });
          }
          continue;
        }
        // empty since the first sample that saw it so with no account opened or closed after it: a paid life that
        // began and ended between two samples starts the clock again (design 7.5: FLOOR_SWEEP_MS of real emptiness)
        const act = this.activity.get(room) || 0;
        const e = this.emptySince.get(room);
        if (!e || e.act !== act) this.emptySince.set(room, { at: now, act });
        else if (now - e.at >= FLOOR_SWEEP_MS && this._retire(room, list)) out.retired++;
      }
    }
    for (const room of this.settling.slice()) {
      try {
        if (room.money.openCount() > 0) room.money.emergencySettle('retry');
        else if (this._holds(room)) room.money.sweepFloor('retry');
      } catch (e) {
        this.log.error('[SLP] settling retry ' + room.lobbyType + ': ' + (e && e.message));
      }
      if (!this._holds(room)) {
        this.settling.splice(this.settling.indexOf(room), 1);
        out.settled++;
      }
    }
    return out;
  }

  // An idle room books its floor to the house, then stops and leaves its rung. A refused or failed booking keeps
  // the room as it is (the next sweep tries again); a room with an account is never retired (sweepFloor refuses).
  _retire(room, list) {
    let swept = null;
    try {
      swept = room.money.sweepFloor('idle');
    } catch (e) {
      this.log.error('[SLP] idle retire of ' + room.lobbyType + ' kept the room, its floor sweep failed: ' + (e && e.message));
      return false;
    }
    if (!swept || this._holds(room)) return false;
    list.splice(list.indexOf(room), 1);
    this.emptySince.delete(room);
    this.retired++;
    try {
      room.stop();
    } catch (e) {
      this.log.error('[SLP] idle retire stop ' + room.lobbyType + ': ' + (e && e.message));
    }
    if (swept.micro > 0) this.log.log('[SLP] RETIRE ' + room.lobbyType + ' floor ' + swept.micro + ' micro ' +
      (swept.returned ? 'back to the players who dropped it' : 'to the house'));
    return true;
  }

  // Design 7.2: money rows first (every room, settling included), then each room's clock stops. Never throws.
  shutdownSettle(why) {
    this.stopping = true;
    this.paidOpen = false;
    const rows = [];
    for (const room of this.all()) {
      try {
        rows.push(...room.money.shutdownSettle(why));
      } catch (e) {
        this.log.error('[SLP] SHUTDOWN settle threw ' + room.lobbyType + ': ' + (e && e.stack ? e.stack : e));
      }
      try {
        room.halt();
      } catch (e) { /* stopping the clock is best effort */ }
    }
    return rows;
  }

  stats() {
    const rungs = {};
    for (const [stake, list] of this.rungs) rungs[stake] = list.map((r) => ({ lobbyType: r.lobbyType, seats: r.seats.size,
      accounts: r.money.openCount(), tainted: !!r.money.tainted }));
    return { paidEnabled: this.paidEnabled, paidOpen: this.paidOpen, stopping: this.stopping, rungs,
      settling: this.settling.length, walletSeats: this.walletSeat.size, created: this.created, retired: this.retired,
      closedRooms: this.closedRooms };
  }
}

module.exports = { SlPaidArenas, SERVER_HOOKS };
