'use strict';
// Chomp's rooms for this region: the one free arena (warm from boot, bots on the day curve) and, while CHOMP_PAID is
// on, the paid rungs ($0.50 and $1 from server/stakeRules.js), each with its own rooms. The paid half is agar.io's
// directory (server/ag/agArenas.js) for the same door (server/ag/agPaidDoor.js): the reconnect maps (resume key,
// entry-token proof), remembered outcomes, the release cooldown, one open paid seat per wallet, the owner's bounty
// bots in room #0 of a rung (Bot bank seeds, never cashed out, never back once caught), the shutdown settle and the
// sweep. `paidOpen` is the runtime door switch (owner console chomp:paid:off/on): closed, new paid joins are refunded
// at the door while seated players keep playing, resume and cash out. A stopped paid room whose bank still holds money
// stays on `settling`, and all() includes it, so the solvency sum and the drain keep counting it.
//
// Paid sockets never take a free seat: they connect seatless (connectPaid, auth { paid: 1 }) and are seated only by
// the door; a seat that ends stays in its room as a read-only watcher (the page keeps the maze behind its end card).

const { ChompRoom } = require('./chompRoom');
const { STAKE_TIERS } = require('../stakeRules');

// agArenas' (and Paper's) numbers
const OUTCOME_TTL_MS = 10 * 60 * 1000;
const OUTCOME_MAX = 5000;
const RELEASE_MAX = 2;
const RELEASE_WINDOW_MS = 10 * 60 * 1000;
const RELEASE_WALLETS_MAX = 5000;
const PAID_SEATLESS_MS = 15000;     // a paid hand-off socket must send its c:join by then
const MAX_ROOMS = 4;                // CHOSEN: paid rooms per rung (40 chompers each, chompRules MAX_PLAYERS)
const SWEEP_IDLE_MS = 300000;       // Paper's ARENA_SWEEP_MS: an empty paid overflow room closes after this
const PAID_BOT_MAX = 40;            // the owner's bots per paid rung (room #0), as agar's

function refuse(socket, why) {
  if (!socket) return;
  try {
    if (typeof socket.emit === 'function') socket.emit('c:refused', { why });
  } catch (e) { /* closing it is what matters */ }
  try {
    if (typeof socket.disconnect === 'function') socket.disconnect(true);
  } catch (e) { /* already gone */ }
}

class ChompArenas {
  // nsp: the /chomp namespace (null in tests); region; botCurve: () -> the free room's bots now; paid: CHOMP_PAID at
  // boot; moneyHooks: the payout and alert hooks every paid room's money needs; botStore, botBank: the owner's bots;
  // makeRoom, now, log, timers, mx, my, seed: tests
  constructor({ nsp = null, region = 'na', botCurve = null, paid = false, moneyHooks = null, botStore = null,
    botBank = null, makeRoom = null, now = Date.now, log = console, timers = null, mx, my, seed } = {}) {
    this.nsp = nsp;
    this.region = region;
    this.now = now;
    this.log = log || console;
    this.mx = mx;
    this.my = my;
    this.seed = seed;
    this.makeRoom = makeRoom || ((opts) => new ChompRoom(opts));
    this.botCurve = botCurve || undefined;
    this.free = this.makeRoom({ nsp, region, botFill: this.botCurve, mx, my, seed, log: this.log, now });
    this.free.onClosed = (closed) => this._replaceFree(closed);
    this.paidEnabled = paid === true;
    this.paidOpen = this.paidEnabled;
    this.stopping = false;
    this.moneyHooks = moneyHooks;
    if (this.paidEnabled) {
      for (const k of ['onCashout', 'onRefund', 'onTransfer', 'onBreach', 'onStake', 'onHouse', 'onOwed', 'onSweep']) {
        if (!moneyHooks || typeof moneyHooks[k] !== 'function') throw new Error('ChompArenas: money hook ' + k + ' must be a function');
      }
    }
    this.timers = timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };
    this.rungs = new Map();          // stake -> paid rooms, index order
    if (this.paidEnabled) for (const s of STAKE_TIERS) this.rungs.set(s, []);
    this.settling = [];
    this.bySocket = new Map();       // socketId -> paid room (a seat or a watcher there)
    this.byKey = new Map();
    this.byProof = new Map();
    this.walletSeat = new Map();
    this.outcomes = new Map();
    this.releases = new Map();
    this.paidSeatless = new Map();
    this.emptySince = new Map();
    this.botStore = botStore && typeof botStore.load === 'function' ? botStore : null;
    this.botBank = botBank && typeof botBank.take === 'function' ? botBank : null;
    this.botTargets = new Map();
    this.botWant = new Map();
    if (this.paidEnabled && this.botStore) {
      let saved = null;
      try {
        saved = this.botStore.load();
      } catch (e) {
        this.log.error('[CHOMP] paid bots: saved targets unreadable: ' + (e && e.message));
      }
      for (const st of this.rungs.keys()) {
        const n = saved ? saved[String(st)] : undefined;
        if (Number.isInteger(n) && n > 0 && n <= PAID_BOT_MAX) this.botTargets.set(st, n);
      }
    }
  }

  // Every room that ticks this frame (chompBoot's loop): the free room and every paid room with someone in it.
  liveRooms() {
    const out = [this.free];
    for (const list of this.rungs.values()) for (const r of list) if (r.needsTick()) out.push(r);
    return out;
  }

  // Every room the owner console, the solvency sum and the drain read: free, every paid rung, and settling rooms.
  all() {
    const out = [this.free];
    for (const list of this.rungs.values()) out.push(...list);
    for (const r of this.settling) if (!out.includes(r)) out.push(r);
    return out;
  }

  paidRooms() {
    const out = [];
    for (const list of this.rungs.values()) out.push(...list);
    return out;
  }

  _rungOf(stake) {
    for (const s of this.rungs.keys()) if (Math.abs(s - Number(stake)) <= 1e-9) return s;
    return null;
  }

  _createPaid(stake, index) {
    let room = null;
    room = this.makeRoom({
      nsp: this.nsp, region: this.region, stake, index, mx: this.mx, my: this.my, log: this.log, now: this.now,
      seed: this.seed !== undefined && this.seed !== null ? this.seed + 1000 * Math.round(stake * 100) + index : undefined,
      paidBots: index === 0,
      moneyHooks: this._moneyHooks(() => room),
      onSeatless: (socket, r, outcome) => this._seatless(socket, r, outcome),
    });
    room.onClosed = (closed) => this._replacePaid(closed);
    const list = this.rungs.get(stake);
    list.push(room);
    list.sort((a, b) => a.index - b.index);
    return room;
  }

  // The free arena closed itself (EMERGENCY_FAIL_TICKS throwing ticks): a fresh one takes its place, every socket that
  // saw it gets the new arena (c:init: a player is back on the title card), and its bots fill again. agArenas' rule
  // for its free room; before paid Chomp a throwing tick ended the process instead.
  _replaceFree(closed) {
    if (closed !== this.free) return;
    const fresh = this.makeRoom({ nsp: this.nsp, region: this.region, botFill: this.botCurve, mx: this.mx, my: this.my,
      log: this.log, now: this.now });
    fresh.onClosed = (c) => this._replaceFree(c);
    this.free = fresh;
    const ids = this.nsp && this.nsp.adapter && this.nsp.adapter.rooms ? this.nsp.adapter.rooms.get(closed.ioRoom) : null;
    for (const id of Array.from(ids || [])) {
      const s = this.nsp.sockets.get(id);
      if (!s) continue;
      s._chRoom = null;
      fresh.attach(s);
    }
    fresh.fillBots();
    this.log.error('[CHOMP] free arena replaced after an emergency close');
  }

  // agArenas._moneyHooks: the server's payout and alert hooks plus this directory's own maps.
  _moneyHooks(roomOf) {
    const h = this.moneyHooks;
    const label = () => (roomOf() ? roomOf().lobbyType : '');
    return {
      onCashout: (order) => h.onCashout(order),
      onRefund: (info) => h.onRefund(Object.assign({ label: label() }, info)),
      onTransfer: (t) => h.onTransfer(Object.assign({ lobbyType: label() }, t)),
      onFeed: () => {},
      onBreach: (info) => h.onBreach(Object.assign({ lobbyType: label() }, info)),
      onStake: (s) => h.onStake(s),
      onHouse: (x) => h.onHouse(x),
      onSeedBack: (micro, why, lbl, live) => {
        if (!this.botBank || !this.botBank.giveBack(micro, why, lbl, live)) throw new Error('the bot bank refused ' + micro);
      },
      onSeedSpent: (micro) => { if (this.botBank) this.botBank.spent(micro); },
      onOwed: (row, live) => h.onOwed(Object.assign({ label: label() }, row), live),
      onSweep: (x) => h.onSweep(Object.assign({ label: label() }, x)),
      // a restart's or crash's coins for the house: one money-journal floor record, booked at the next boot
      onFloor: (rec) => {
        const j = h.journal;
        if (!j || typeof j.floor !== 'function' || !j.floor(Object.assign({ room: label() }, rec))) {
          throw new Error('the journal did not take the floor record');
        }
      },
      onAccountOpen: (acct) => this._accountOpened(roomOf(), acct),
      onAccountConfirmed: (acct) => this._accountConfirmed(roomOf(), acct),
      onAccountClosed: (acct, outcome, extra) => this._accountClosed(roomOf(), acct, outcome, extra),
    };
  }

  _accountOpened(room, acct) {
    if (this._openSeat(this.walletSeat.get(acct.wallet))) throw new Error('ChompArenas: wallet already holds an open paid seat');
    this.walletSeat.set(acct.wallet, { room, pid: acct.pid });
    this.byKey.set(acct.resumeKey, { room, pid: acct.pid });
    if (acct.proof) this.byProof.set(acct.proof, { room, pid: acct.pid });
    this._journal('open', acct, room);
  }

  _journal(kind, acct, room, outcome, extra) {
    const j = this.moneyHooks && this.moneyHooks.journal;
    if (!j) return;
    try {
      if (kind === 'open') j.open(acct, room ? room.lobbyType : '');
      else j.close(acct, outcome, extra, room ? room.lobbyType : '');
    } catch (e) {
      this.log.error('[CHOMP] journal hook', e && e.message);
    }
  }

  _accountConfirmed(room, acct) {
    const p = acct.proof ? this.byProof.get(acct.proof) : null;
    if (p && p.room === room && p.pid === acct.pid) this.byProof.delete(acct.proof);
  }

  _accountClosed(room, acct, outcome, extra) {
    this._journal('close', acct, room, outcome, extra);
    const w = this.walletSeat.get(acct.wallet);
    if (w && w.room === room && w.pid === acct.pid) this.walletSeat.delete(acct.wallet);
    const k = this.byKey.get(acct.resumeKey);
    if (k && k.room === room && k.pid === acct.pid) this.byKey.delete(acct.resumeKey);
    const p = acct.proof ? this.byProof.get(acct.proof) : null;
    if (p && p.room === room && p.pid === acct.pid) this.byProof.delete(acct.proof);
    if (outcome === 'aborted') return;
    const x = extra || {};
    let why = outcome;
    let refunded = false;
    let keep = null;
    if (outcome === 'released') {
      why = x.why || 'released';
      refunded = !!x.refunded;
      if (refunded && (why === 'join-lost' || why === 'join-timeout')) this._noteRelease(acct.wallet);
    } else if (outcome === 'refunded') {
      why = x.why || 'emergency';
      refunded = (x.refundedMicro || 0) > 0;
    } else if (outcome === 'cashedout' || outcome === 'settled') {
      keep = { grossMicro: x.grossMicro || 0, cashoutId: x.cashoutId || null };
    } else if (outcome === 'eaten') {
      keep = { lostMicro: x.lostMicro || 0, by: x.by || '' };
    }
    this.rememberOutcome('k:' + acct.resumeKey, why, refunded, keep);
    if (acct.proof && acct.confirmBy > 0 && outcome !== 'cashedout' && outcome !== 'settled') {
      this.rememberOutcome('t:' + acct.proof, why, refunded, keep);
    }
  }

  // A paid seat ended (or another socket took it): the socket stays in that room as a watcher; the directory keeps
  // routing it there (its next paid join leaves it).
  _seatless(socket, room) {
    if (!socket || typeof socket.id !== 'string') return;
    if (!room.stopped) this.bySocket.set(socket.id, room);
    else if (this.bySocket.get(socket.id) === room) this.bySocket.delete(socket.id);
  }

  _replacePaid(closed) {
    const list = this.rungs.get(closed.stake);
    if (!list) return;
    const i = list.indexOf(closed);
    if (i === -1) return;
    list.splice(i, 1);
    this.emptySince.delete(closed);
    this._forgetRoom(closed);
    if (closed.money && closed.money.bank.totalMicro() > 0 && !this.settling.includes(closed)) this.settling.push(closed);
    this._createPaid(closed.stake, closed.index);
  }

  _forgetRoom(room) {
    for (const [wallet, s] of Array.from(this.walletSeat)) if (s.room === room) this.walletSeat.delete(wallet);
    for (const [key, s] of Array.from(this.byKey)) if (s.room === room) this.byKey.delete(key);
    for (const [proof, s] of Array.from(this.byProof)) if (s.room === room) this.byProof.delete(proof);
    for (const [sid, r] of Array.from(this.bySocket)) if (r === room) this.bySocket.delete(sid);
  }

  // A room of this rung with space: the fullest first (excluding `exclude`), else a new one while the rung has fewer
  // than MAX_ROOMS, else null.
  seatFor(stake, exclude) {
    const rung = this._rungOf(stake);
    if (rung === null) return null;
    const list = this.rungs.get(rung);
    const open = list.filter((r) => r !== exclude && !r.stopped && r.hasSpace())
      .sort((a, b) => b.humanCount - a.humanCount || a.index - b.index);
    if (open.length) return open[0];
    if (list.length < MAX_ROOMS) {
      const used = new Set(list.map((r) => r.index));
      let n = 0;
      while (used.has(n)) n++;
      return this._createPaid(rung, n);
    }
    return null;
  }

  _openSeat(s) {
    if (!s || s.room.stopped || !s.room.money) return null;
    const acct = s.room.money.account(s.pid);
    return acct ? { room: s.room, pid: s.pid, acct } : null;
  }

  seatByKey(resumeKey) {
    return typeof resumeKey === 'string' ? this._openSeat(this.byKey.get(resumeKey)) : null;
  }

  seatByProof(proof) {
    const s = typeof proof === 'string' ? this._openSeat(this.byProof.get(proof)) : null;
    return s && s.acct.state === 'unconfirmed' ? s : null;
  }

  walletSeatOf(wallet) {
    return typeof wallet === 'string' ? this._openSeat(this.walletSeat.get(wallet)) : null;
  }

  // The paid room this socket holds an open account in, or null.
  paidRoomOf(socketId) {
    const room = this.bySocket.get(socketId);
    if (!room || !room.money) return null;
    const seat = room.seatOf(socketId);
    if (!seat) return null;
    const acct = room.money.account(seat.pid);
    return acct && acct.socketId === socketId ? room : null;
  }

  roomOfSocket(socketId) {
    return this.bySocket.get(socketId) || null;
  }

  // The door seated this socket: it stops being a watcher anywhere else and stops waiting for its join.
  _takeSocket(socket) {
    const had = this.bySocket.get(socket.id);
    if (had && had.isWatchOnly(socket.id)) had.removeSocket(socket.id);
    if (this.free.bySocket.has(socket.id)) this.free.removePlayer(this.free.bySocket.get(socket.id));
    this._stopSeatlessTimer(socket.id);
  }

  _paidSeated(socket, room) {
    this.bySocket.set(socket.id, room);
    room.attach(socket);
  }

  connectPaid(socket) {
    if (!socket || typeof socket.id !== 'string') return false;
    this._stopSeatlessTimer(socket.id);
    const t = this.timers.setTimeout(() => {
      this.paidSeatless.delete(socket.id);
      if (this.bySocket.has(socket.id)) return;
      refuse(socket, 'join-timeout');
    }, PAID_SEATLESS_MS);
    if (t && typeof t.unref === 'function') t.unref();
    this.paidSeatless.set(socket.id, t);
    return true;
  }

  _stopSeatlessTimer(socketId) {
    const t = this.paidSeatless.get(socketId);
    if (t === undefined) return;
    this.paidSeatless.delete(socketId);
    try {
      this.timers.clearTimeout(t);
    } catch (e) { /* gone */ }
  }

  // The lobby's Spectate on a paid rung: a read-only watcher in that rung's room with the most open accounts (or its
  // bounty bots). Never opens a room; null when nobody plays there.
  connectWatch(socket, stake) {
    if (!socket || typeof socket.id !== 'string') return null;
    const rung = this._rungOf(stake);
    if (rung === null || !(rung > 0)) return null;
    const list = (this.rungs.get(rung) || []).filter((r) => !r.stopped && (r.openAccounts() > 0 || r.botCount > 0))
      .sort((a, b) => b.openAccounts() - a.openAccounts() || a.index - b.index);
    if (!list.length) return null;
    const room = list[0];
    if (!room.addWatcher(socket)) return null;
    this.bySocket.set(socket.id, room);
    return room;
  }

  ready(socketId) {
    const room = this.bySocket.get(socketId);
    return room ? room.ready(socketId) : false;
  }

  hold(socketId, on) {
    const room = this.bySocket.get(socketId);
    return room ? room.hold(socketId, on) : false;
  }

  disconnect(socketId) {
    const room = this.bySocket.get(socketId);
    if (room) room.removeSocket(socketId);
    this.bySocket.delete(socketId);
    this._stopSeatlessTimer(socketId);
  }

  outcomeOf(key) {
    const o = this.outcomes.get(key);
    if (!o) return null;
    if (this.now() - o.at > OUTCOME_TTL_MS) {
      this.outcomes.delete(key);
      return null;
    }
    return Object.assign({}, o.extra || {}, { why: o.why, refunded: o.refunded });
  }

  rememberOutcome(key, why, refunded, extra) {
    if (typeof key !== 'string' || !key) return;
    this.outcomes.delete(key);
    this.outcomes.set(key, { why, refunded: !!refunded, at: this.now(), extra: extra || null });
    while (this.outcomes.size > OUTCOME_MAX) this.outcomes.delete(this.outcomes.keys().next().value);
  }

  releaseCooldown(wallet) {
    if (typeof wallet !== 'string' || !wallet) return false;
    const list = this.releases.get(wallet);
    if (!list) return false;
    const now = this.now();
    while (list.length && now - list[0] >= RELEASE_WINDOW_MS) list.shift();
    if (!list.length) {
      this.releases.delete(wallet);
      return false;
    }
    return list.length >= RELEASE_MAX;
  }

  _noteRelease(wallet) {
    if (typeof wallet !== 'string' || !wallet) return;
    const list = this.releases.get(wallet) || [];
    list.push(this.now());
    while (list.length > RELEASE_MAX) list.shift();
    this.releases.delete(wallet);
    this.releases.set(wallet, list);
    while (this.releases.size > RELEASE_WALLETS_MAX) this.releases.delete(this.releases.keys().next().value);
  }

  paidOpenCount() {
    let n = 0;
    for (const r of this.all()) n += r.openAccounts();
    return n;
  }

  // A planned restart ('shutdown') or a hard crash ('crash'): the door closes for good, every paid room stops, and
  // every open balance and every coin is handed back as owed REFUND rows for the caller to write.
  shutdownSettle(why = 'shutdown') {
    this.stopping = true;
    this.paidOpen = false;
    const rows = [];
    for (const room of this.paidRooms().concat(this.settling)) {
      if (!room.money) continue;
      try {
        room.stop();
      } catch (e) { /* best effort */ }
      try {
        rows.push(...room.money.shutdownSettle(why));
      } catch (e) {
        this.log.error('[CHOMP] SHUTDOWN settle threw', room.lobbyType, e && e.stack ? e.stack : e);
      }
    }
    return rows;
  }

  // ---------------------------------------------------------------------------------------------------------
  // The owner's bounty bots (agArenas' rules).

  resumeBots() {
    if (!this.botBank || !this.botWant.size || this.stopping) return;
    for (const [stake, more] of Array.from(this.botWant)) {
      try {
        this._applyBots(stake, this.botCount(stake) + more);
      } catch (e) {
        this.botWant.delete(stake);
        this.log.error('[BOTS] chomp paid bots not resumed at ' + stake + ': ' + (e && e.message));
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
    for (const r of this.rungs.get(st) || []) n += r.botCount;
    return n;
  }

  setBotTarget(stake, n) {
    const st = this._rungOf(stake);
    if (!this.paidEnabled || st === null) return { ok: false, why: 'No paid Chomp rung at ' + stake };
    if (!this.botBank) return { ok: false, why: 'Paid Chomp bots are not wired on this server' };
    if (this.stopping) return { ok: false, why: 'The server is stopping' };
    if (!Number.isInteger(n) || n < 0 || n > PAID_BOT_MAX) return { ok: false, why: 'Bots: a whole number from 0 to ' + PAID_BOT_MAX };
    let r;
    try {
      r = this._applyBots(st, n);
    } catch (e) {
      this.log.error('[CHOMP] paid bots: set ' + st + ' to ' + n + ' failed: ' + (e && e.message));
      this._saveTargets();
      return { ok: false, why: 'Paid bots could not be changed just now: ' + String(e && e.message).slice(0, 120) };
    }
    this._saveTargets();
    return Object.assign({ ok: true, held: n }, r);
  }

  _saveTargets() {
    for (const st of this.rungs.keys()) {
      const live = this.botCount(st) + (this.botWant.get(st) || 0);
      if (live > 0) this.botTargets.set(st, live);
      else this.botTargets.delete(st);
    }
    if (!this.botStore || typeof this.botStore.save !== 'function') return false;
    const obj = {};
    for (const [k, v] of this.botTargets) obj[String(k)] = v;
    try {
      return this.botStore.save(obj) !== false;
    } catch (e) {
      return false;
    }
  }

  // n live bounty bots in the rung's room #0, each seeded with the rung's stake from the bot bank. Fewer: the newest
  // leave now (seed back, what they took back to its players). More: one at a time while the bank covers a seed.
  _applyBots(stake, n) {
    this.botWant.delete(stake);
    const list = this.rungs.get(stake) || [];
    let room = list.find((r) => r.index === 0 && !r.stopped) || null;
    if (!room && n > 0) room = this._createPaid(stake, 0);
    if (!room || room.paidBots !== true || !room.money) return { live: 0, why: n > 0 ? 'The room takes no bots' : null };
    const bots = room.paidBotList();
    for (let i = 0; i < bots.length - n; i++) room._removeBot(bots[i]);
    const seed = Math.round(stake * 1e6);
    let why = null;
    for (let i = room.botCount; i < n; i++) {
      const no = this.botBank.whyNot(seed);
      if (no) {
        if (no === 'funding') this.botWant.set(stake, n - room.botCount);
        why = no === 'cap' ? 'The daily bot limit is reached' : no === 'funding'
          ? 'The rest join in a few seconds, once their money has moved from the Bot bank wallet to escrow'
          : 'The bot bank cannot cover another $' + stake + ' bot';
        break;
      }
      const bot = room._spawnBot();
      if (!bot) {
        why = 'The room would not take another bot just now';
        break;
      }
      if (!this.botBank.take(seed, room.lobbyType)) {
        room.removePlayer(bot);
        why = 'The bot bank refused the seed';
        break;
      }
      try {
        room.money.seedBot(bot.id, seed, bot.name);
      } catch (e) {
        this.botBank.giveBack(seed, 'seed-failed', room.lobbyType, true);
        room.removePlayer(bot);
        this.log.error('[CHOMP] paid bots: seed of ' + bot.id + ' refused, given back: ' + (e && e.message));
        why = 'The room refused the seed';
        break;
      }
    }
    room.setAwake(room.botCount > 0);
    return { live: room.botCount, why };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Every 60 s from the server: coins older than an hour go back, an idle paid overflow room closes (no seat, no
  // account, no coin), a settling room is retried and dropped once its bank is empty.
  sweep(now) {
    if (!this.stopping) this._saveTargets();
    for (const list of this.rungs.values()) {
      for (const room of list.slice()) {
        try {
          room.money.sweepFloor(now);
        } catch (e) {
          this.log.error('[CHOMP] floor sweep', room.lobbyType, e && e.message);
        }
        const busy = room.players.size > 0 || room.openAccounts() > 0 || room.money.bank.totalMicro() > 0;
        if (room.index === 0 || busy) {
          this.emptySince.delete(room);
          continue;
        }
        if (!this.emptySince.has(room)) this.emptySince.set(room, now);
        if (now - this.emptySince.get(room) >= SWEEP_IDLE_MS) {
          for (const [sid, socket] of Array.from(room.watchers)) {
            room.removeSocket(sid);
            this.bySocket.delete(sid);
            room.detach(socket);
          }
          room.stop();
          list.splice(list.indexOf(room), 1);
          this.emptySince.delete(room);
          this._forgetRoom(room);
        }
      }
    }
    for (const room of this.settling.slice()) {
      try {
        if (room.openAccounts() > 0) room.money.emergencySettle();
        else if (room.money.bank.totalMicro() > 0) room.money.emergencyCoins();   // an emergency's coins go back
      } catch (e) {
        this.log.error('[CHOMP] settling retry', room.lobbyType, e && e.message);
      }
      if (room.money.bank.totalMicro() === 0) this.settling.splice(this.settling.indexOf(room), 1);
    }
  }

  // /api/live rows, agArenas' shape: one row per rung, id 'chomp:<region>:s<stake>'. A paid row counts every open
  // account in players (away ones too, so the deploy check sees parked money), parked the away ones, and says
  // 'closed' while the owner's off switch is on.
  boardRows() {
    const rows = [{
      id: 'chomp:' + this.region + ':s0', game: 'chomp', region: this.region, stake: 0,
      players: this.free.humanCount, bots: this.free.botCount, capacity: 40, state: 'open',
    }];
    for (const [stake, list] of this.rungs) {
      let open = 0, parked = 0, bots = 0;
      for (const r of list.concat(this.settling.filter((x) => x.stake === stake))) {
        if (!r.money) continue;
        open += r.money.openCount();
        parked += r.money.parkedCount();
      }
      for (const r of list) bots += r.botCount;
      rows.push({ id: 'chomp:' + this.region + ':s' + stake, game: 'chomp', region: this.region, stake,
        players: open, parked, bots, capacity: 40, state: this.paidOpen ? 'open' : 'closed' });
    }
    return rows;
  }

  // People playing now (the lobby card's count): the free room's people, and paid seats whose player is here.
  liveCount() {
    let n = this.free.humanCount;
    for (const r of this.paidRooms()) if (!r.stopped) n += r.money.openCount() - r.money.parkedCount();
    return n;
  }

  humanTotal() {
    return this.liveCount();
  }

  stop() {
    this.free.stop();
    for (const r of this.paidRooms()) {
      r.stop();
      this._forgetRoom(r);
    }
    for (const t of this.paidSeatless.values()) {
      try {
        this.timers.clearTimeout(t);
      } catch (e) { /* gone */ }
    }
    this.paidSeatless.clear();
  }
}

module.exports = { ChompArenas, refuse, PAID_SEATLESS_MS, MAX_ROOMS, PAID_BOT_MAX };
