'use strict';
// The agar.io room directory for this region (build brief 9.1, 9.3): one free rung, a player cap per room (law
// L39), overflow rooms, the sweep of empty overflow rooms, and the lobby rows (boardRows, liveCount) in the shape
// paperArenas gives them (every rung's row is in /api/live lobbies, where the lobby's agar.io card reads its Free,
// $0.50 and $1.00). The free rung holds no money; the paid rungs (only while AG_PAID is on) are described below.
//
// Watchers and players: a socket that connects is seated at once as a watcher in the room a Play would land in
// (its page must be sent world updates before it can ask to play), without opening an overflow room for someone
// who may only watch. Its Play lands in that room while it has a player slot; when the room filled up meanwhile,
// the socket moves to a room that has one (its first bundle there starts with clearAll, so its page drops the
// old world), and only a Play when every room is full opens an overflow room.
//
// Watcher seats are capped per room (agRoom ROOM_TUNING WATCHERS_PER_SLOT): a connection goes to the room its Play
// would land in while that room has a watcher seat, else to another room with one; with none anywhere it is
// refused ('ag:refused' { why: 'full' }) and closed. A watcher still never opens a room.
//
// The directory refuses to open on a law table assertShippable rejects, like the rooms it makes.
//
// PAID rungs (PAID-AGAR-DESIGN.md 5.3): $0.50 and $1.00 from server/stakeRules.js, built only when AG_PAID was on at
// boot (`paid`), each with its own rooms (MAX_ROOMS per rung, no bots, no watchers), plus Paper's reconnect maps
// (resume key, entry-token proof), remembered outcomes, the release cooldown and one open paid seat per wallet
// (walletSeat, Owen Q8: agar only). `paidOpen` is the runtime door switch (owner console agar:paid:off/on): closed,
// new paid joins are refunded at the door while seated players keep playing, resume and cash out. A stopped paid room
// whose bank is not empty stays on `settling`, and all() includes it, so the solvency sum and the drain keep counting
// it. Paid sockets never take a free watcher seat: they connect seatless (connectPaid) and are seated only by the
// paid door (server/ag/agPaidDoor.js).

const { LAWS, assertShippable, assertLawsComplete } = require('./agLaws');
const { AgRoom } = require('./agRoom');
const { STAKE_TIERS } = require('../stakeRules');

// Copied from server/paper/PaperArenas.js (design 3.5): what became of a paid join whose answer may never have
// reached the page, and the unconfirmed-seat refund cooldown.
const OUTCOME_TTL_MS = 10 * 60 * 1000;     // PaperArenas.js:13
const OUTCOME_MAX = 5000;                  // PaperArenas.js:14
const RELEASE_MAX = 2;                     // PaperArenas.js:19
const RELEASE_WINDOW_MS = 10 * 60 * 1000;  // PaperArenas.js:20
const RELEASE_WALLETS_MAX = 5000;          // PaperArenas.js:21
const PAID_SEATLESS_MS = 15000;            // design 3.5 PAID_SEATLESS_MS: a paid hand-off socket must send ag:join by then

// CHOSEN directory numbers (ours; Paper's values; listed in the parity log with the other CHOSEN rows).
function chosen(value, note) {
  return Object.freeze({ value, status: 'CHOSEN', note });
}
const ARENA_TUNING = Object.freeze({
  MAX_ROOMS: chosen(8, "Paper's MAX_ARENAS_PER_STAKE: rooms on the free rung at most, overflow rooms included"),
  SWEEP_IDLE_MS: chosen(300000, "Paper's ARENA_SWEEP_MS: an overflow room with no socket this long is closed"),
  PORTRAIT_GAP_MS: chosen(1000, 'ag:portrait: least ms between two orientation changes of one socket\'s view box ' +
    '(PARITY-LOG 2026-10-09 P4). A page that flips back sooner gets its last report applied once the gap is up, so ' +
    'an honest page always ends on what it draws, and a flood of flips cannot show a page both boxes more than ' +
    'once a second'),
});
const MAX_ROOMS = ARENA_TUNING.MAX_ROOMS.value;
const SWEEP_IDLE_MS = ARENA_TUNING.SWEEP_IDLE_MS.value;
const PORTRAIT_GAP_MS = ARENA_TUNING.PORTRAIT_GAP_MS.value;

// A socket with no seat anywhere is told so and closed; it would otherwise stay connected with nothing sent.
function refuse(socket, why) {
  if (!socket) return;
  try {
    if (typeof socket.emit === 'function') socket.emit('ag:refused', { why });
  } catch (e) { /* closing it is what matters */ }
  try {
    if (typeof socket.disconnect === 'function') socket.disconnect(true);
  } catch (e) { /* already gone */ }
}

class AgArenas {
  // region: this server's region; game: the lobby key of the rows (the lobby name stays "agar.io", Q33)
  // laws, shippableOnly, clock, autoTick, log: handed to every room (see agRoom)
  // seed: tests only; room i gets seed + i
  // paid: AG_PAID at boot (the paid rungs exist only then); moneyHooks: the payout and alert hooks every paid room's
  // money controller needs (onCashout, onRefund, onTransfer, onFeed, onBreach, onStake, onHouse); timers: tests only
  constructor({ region = 'na', laws = LAWS, shippableOnly = true, now = Date.now, clock, autoTick = true, seed,
    makeRoom, game = 'agar', log = console, paid = false, moneyHooks = null, timers = null } = {}) {
    if (shippableOnly) assertShippable(laws);
    assertLawsComplete(laws, ['L39']);
    this.region = region;
    this.laws = laws;
    this.shippableOnly = shippableOnly;
    this.now = now;
    this.clock = clock;
    this.autoTick = autoTick;
    this.seed = seed;
    this.game = game;
    this.log = log || console;
    this.cap = laws.L39.value;
    this.makeRoom = makeRoom || ((opts) => new AgRoom(opts));
    this.rooms = [];                 // index order
    this.bySocket = new Map();       // socketId -> room
    this.cleared = new Set();        // socket ids whose page still holds a world from an earlier seat
    this.viewBelow = new Map();      // socketId -> rows its page draws under the reference view (ag:view), > 0 only
    this.portraitState = new Map();  // socketId -> { on, want, at } for sockets that ever reported portrait (ag:portrait)
    this.emptySince = new Map();     // room -> ms
    this._create(0);

    // Paid rungs (design 5.3).
    this.paidEnabled = paid === true;
    this.paidOpen = this.paidEnabled;
    this.stopping = false;           // set once by shutdownSettle: the process is going down
    this.moneyHooks = moneyHooks;
    if (this.paidEnabled) {
      const need = ['onCashout', 'onRefund', 'onTransfer', 'onFeed', 'onBreach', 'onStake', 'onHouse'];
      for (const k of need) {
        if (!moneyHooks || typeof moneyHooks[k] !== 'function') throw new Error('AgArenas: money hook ' + k + ' must be a function');
      }
    }
    this.timers = timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };
    this.rungs = new Map();          // stake -> paid rooms, index order
    if (this.paidEnabled) for (const s of STAKE_TIERS) this.rungs.set(s, []);
    this.settling = [];              // stopped paid rooms whose bank still holds money
    this.byKey = new Map();          // resume key -> { room, pid }
    this.byProof = new Map();        // sha256(entry token) -> { room, pid } of an UNCONFIRMED seat
    this.walletSeat = new Map();     // wallet -> { room, pid }: one open paid seat per wallet (Owen Q8)
    this.outcomes = new Map();       // 't:' + proof or 'k:' + resumeKey -> { why, refunded, at, extra }, oldest first
    this.releases = new Map();       // wallet -> times of its unconfirmed-seat refunds, oldest first
    this.paidSeatless = new Map();   // socketId -> timer: a paid hand-off socket waiting for its ag:join
  }

  _create(index) {
    const opts = {
      laws: this.laws, shippableOnly: this.shippableOnly, region: this.region, index,
      now: this.now, autoTick: this.autoTick, log: this.log,
      viewBelowOf: (socketId) => this.viewBelow.get(socketId) || 0,
      portraitOf: (socketId) => this.portraitOf(socketId),
    };
    if (this.clock) opts.clock = this.clock;
    if (this.seed !== undefined && this.seed !== null) opts.seed = this.seed + index;
    const room = this.makeRoom(opts);
    room.onClosed = (closed, sockets) => this._replace(closed, sockets);
    this.rooms.push(room);
    this.rooms.sort((a, b) => a.index - b.index);
    return room;
  }

  // An emergency-closed room gives its index to a fresh one, and its sockets are seated there as watchers (past
  // its watcher seats: in another room with one, else refused and closed).
  _replace(closed, sockets) {
    const i = this.rooms.indexOf(closed);
    if (i === -1) return;
    this.rooms.splice(i, 1);
    this.emptySince.delete(closed);
    const room = this._create(closed.index);
    for (const socket of sockets || []) {
      if (!socket || this.bySocket.get(socket.id) !== closed) continue;
      this.bySocket.delete(socket.id);
      let to = room.addSocket(socket, { clearFirst: true }) ? room : null;
      if (!to) {
        const other = this.roomForWatcher();
        if (other && other.addSocket(socket, { clearFirst: true })) to = other;
      }
      if (to) this.bySocket.set(socket.id, to);
      else refuse(socket, 'full');
    }
  }

  _freeIndex() {
    const used = new Set(this.rooms.map((r) => r.index));
    let n = 0;
    while (used.has(n)) n++;
    return n;
  }

  // Every room: the free rung, every paid rung, and stopped paid rooms still holding money (settling), so the owner
  // console, the solvency sum and the drain see all of them.
  all() {
    const out = this.rooms.slice();
    for (const list of this.rungs.values()) out.push(...list);
    for (const r of this.settling) if (!out.includes(r)) out.push(r);
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Paid rungs (design 5.3).

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
    const opts = {
      laws: this.laws, shippableOnly: this.shippableOnly, region: this.region, index, stake,
      now: this.now, autoTick: this.autoTick, log: this.log,
      viewBelowOf: (socketId) => this.viewBelow.get(socketId) || 0,
      portraitOf: (socketId) => this.portraitOf(socketId),
      onSeatless: (socket, room, outcome) => this._seatless(socket, room, outcome),
    };
    if (this.clock) opts.clock = this.clock;
    if (this.seed !== undefined && this.seed !== null) opts.seed = this.seed + 1000 * Math.round(stake * 100) + index;
    let room = null;
    opts.moneyHooks = this._moneyHooks(() => room);
    room = this.makeRoom(opts);
    room.onClosed = (closed) => this._replacePaid(closed);
    const list = this.rungs.get(stake);
    list.push(room);
    list.sort((a, b) => a.index - b.index);
    return room;
  }

  // The hooks one paid room's money controller gets: the payout and alerts from the server, plus this directory's
  // own maps (walletSeat, resume keys, token proofs, outcomes, the release cooldown).
  _moneyHooks(roomOf) {
    const h = this.moneyHooks;
    const label = () => (roomOf() ? roomOf().lobbyType : '');
    return {
      onCashout: (order) => h.onCashout(order),
      onRefund: (info) => h.onRefund(Object.assign({ label: label() }, info)),
      onTransfer: (t) => h.onTransfer(Object.assign({ lobbyType: label() }, t)),
      onFeed: (f) => h.onFeed(f),
      onBreach: (info) => h.onBreach(Object.assign({ lobbyType: label() }, info)),
      onStake: (s) => h.onStake(s),
      onHouse: (x) => h.onHouse(x),
      onAccountOpen: (acct) => this._accountOpened(roomOf(), acct),
      onAccountConfirmed: (acct) => this._accountConfirmed(roomOf(), acct),
      onAccountClosed: (acct, outcome, extra) => this._accountClosed(roomOf(), acct, outcome, extra),
    };
  }

  // One open paid seat per wallet (Owen Q8): set here, inside the door's synchronous turn, and cleared only when the
  // account closes (or its room stops).
  // The same test as walletSeatOf (_openSeat): an account stuck open in a stopped (settling) room does not hold the
  // wallet's seat, so the door's step 10 and this check always agree (review fix).
  _accountOpened(room, acct) {
    if (this._openSeat(this.walletSeat.get(acct.wallet))) {
      throw new Error('AgArenas: wallet already holds an open paid seat');
    }
    this.walletSeat.set(acct.wallet, { room, pid: acct.pid });
    this.byKey.set(acct.resumeKey, { room, pid: acct.pid });
    if (acct.proof) this.byProof.set(acct.proof, { room, pid: acct.pid });
    this._journal('open', acct, room);
  }

  // The money journal (agJournal, the optional hook moneyHooks.journal); a failed write never reaches a money path.
  _journal(kind, acct, room, outcome, extra) {
    const j = this.moneyHooks && this.moneyHooks.journal;
    if (!j) return;
    try {
      if (kind === 'open') j.open(acct, room ? room.lobbyType : '');
      else j.close(acct, outcome, extra, room ? room.lobbyType : '');
    } catch (e) {
      this.log.error('[AG] journal hook', e && e.message);
    }
  }

  // The player readied: its token no longer names the seat (only its resume key does).
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
    // A page re-sending the token of a seat that never readied hears what became of it.
    if (acct.proof && acct.confirmBy > 0 && outcome !== 'cashedout' && outcome !== 'settled') {
      this.rememberOutcome('t:' + acct.proof, why, refunded, keep);
    }
  }

  // A paid socket whose account just closed (or that another socket replaced): no longer in any room. It stays
  // connected and seatless (the end card, a restake through the door, or a free Play).
  _seatless(socket, room, outcome) {
    if (!socket || typeof socket.id !== 'string') return;
    if (this.bySocket.get(socket.id) === room) this.bySocket.delete(socket.id);
    this.cleared.add(socket.id);
    if (socket._agRoom === room) socket._agRoom = null;
  }

  // An emergency-closed paid room gives its index to a fresh one on the same rung; its money was refunded first
  // (agMoney.emergencySettle). A bank that still holds money keeps it on the settling list.
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

  // Wallet seats of a stopped room are released (design 5.3), so a wallet whose money is stuck there can still play.
  _forgetRoom(room) {
    for (const [wallet, s] of Array.from(this.walletSeat)) if (s.room === room) this.walletSeat.delete(wallet);
    for (const [key, s] of Array.from(this.byKey)) if (s.room === room) this.byKey.delete(key);
    for (const [proof, s] of Array.from(this.byProof)) if (s.room === room) this.byProof.delete(proof);
  }

  // A room of this rung with a player slot: the fullest first (excluding `exclude`), else a new one while the rung has
  // fewer than MAX_ROOMS, else null (design 5.3, PaperArenas.seatFor).
  seatFor(stake, exclude) {
    const rung = this._rungOf(stake);
    if (rung === null) return null;
    const list = this.rungs.get(rung);
    const open = list.filter((r) => r !== exclude && r.hasSpace())
      .sort((a, b) => b.liveHumans - a.liveHumans || a.index - b.index);
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

  // An UNCONFIRMED paid seat, named by the sha256 of the entry token that bought it.
  seatByProof(proof) {
    const s = typeof proof === 'string' ? this._openSeat(this.byProof.get(proof)) : null;
    return s && s.acct.state === 'unconfirmed' ? s : null;
  }

  walletSeatOf(wallet) {
    return typeof wallet === 'string' ? this._openSeat(this.walletSeat.get(wallet)) : null;
  }

  // The paid room this socket holds an open account in, or null (door step 3, ag:leave, the free join guard).
  paidRoomOf(socketId) {
    const room = this.bySocket.get(socketId);
    if (!room || !room.money) return null;
    const seat = room.seatOf(socketId);
    if (!seat) return null;
    const acct = room.money.account(seat.pid);
    return acct && acct.socketId === socketId ? room : null;
  }

  // The door seated this socket (a new account or a resume): it leaves any free room first (its page drops that
  // world: the paid seat starts with clearAll) and stops waiting for its join.
  _takeSocket(socket) {
    const had = this.bySocket.get(socket.id);
    if (had && !had.money) {
      had.removeSocket(socket.id);
      this.bySocket.delete(socket.id);
    }
    this._stopSeatlessTimer(socket.id);
  }

  _paidSeated(socket, room) {
    this.bySocket.set(socket.id, room);
    this.cleared.delete(socket.id);
    socket._agRoom = room;
    socket._agStake = room.stake;
  }

  // A socket that connected with auth.paid (a stake hand-off): no watcher seat, never refused as full; dropped when
  // it sends no ag:join within PAID_SEATLESS_MS (design 5.3).
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

  ready(socketId) {
    const room = this.bySocket.get(socketId);
    return room ? room.ready(socketId) : false;
  }

  hold(socketId, on) {
    const room = this.bySocket.get(socketId);
    return room ? room.hold(socketId, on) : false;
  }

  // -> { why, refunded, ...extra } | null, for 't:' + proof or 'k:' + resumeKey (PaperArenas.outcomeOf).
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

  // True while this wallet has had RELEASE_MAX unconfirmed-seat refunds within the window (PaperArenas).
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

  // Open paid accounts across every paid room (settling ones included).
  paidOpenCount() {
    let n = 0;
    for (const r of this.all()) n += r.openAccounts ? r.openAccounts() : 0;
    return n;
  }

  // A planned restart ('shutdown', design 5.9, Owen Q6) or a hard crash ('crash'): the door closes for good
  // (stopping: the door now refuses before it spends a token, agPaidDoor), every paid room stops ticking, and every
  // open balance is withdrawn and handed back as an owed REFUND row for the caller to write. Rows only; nothing is
  // paid here.
  shutdownSettle(why = 'shutdown') {
    this.stopping = true;
    this.paidOpen = false;
    const rows = [];
    const rooms = this.paidRooms().concat(this.settling);
    for (const room of rooms) {
      if (!room.money) continue;
      try {
        room.stop();
      } catch (e) { /* stopping the clock is best effort */ }
      try {
        rows.push(...room.money.shutdownSettle(why));
      } catch (e) {
        this.log.error('[AG] SHUTDOWN settle threw', room.lobbyType, e && e.stack ? e.stack : e);
      }
    }
    return rows;
  }

  roomOfSocket(socketId) {
    return this.bySocket.get(socketId) || null;
  }

  _withSpace() {
    return this.rooms
      .filter((r) => !r.stopped && r.liveHumans < this.cap)
      .sort((a, b) => b.liveHumans - a.liveHumans || a.index - b.index);
  }

  // A room with a player slot: the preferred one if it has a slot, else the fullest room with one, else a new
  // overflow room while there are fewer than MAX_ROOMS, else null.
  roomForPlayer(preferred) {
    if (preferred && this.rooms.includes(preferred) && preferred.hasSpace()) return preferred;
    const open = this._withSpace();
    if (open.length) return open[0];
    if (this.rooms.length < MAX_ROOMS) return this._create(this._freeIndex());
    return null;
  }

  // A room with a watcher seat for a fresh connection: where its Play would land (the fullest room with a player
  // slot) if it has one, else the next room with a player slot, else (every room full) the least full room. It
  // never opens a room by itself; null when no room has a watcher seat.
  roomForWatcher() {
    const open = this._withSpace().filter((r) => r.hasWatchSpace());
    if (open.length) return open[0];
    const live = this.rooms.filter((r) => r.hasWatchSpace())
      .sort((a, b) => a.liveHumans - b.liveHumans || a.index - b.index);
    return live.length ? live[0] : null;
  }

  // Seats a socket as a watcher (connection, or back after ag:leave). Returns its room, or null when no room has a
  // watcher seat (the socket layer then refuses and closes a fresh connection).
  connect(socket) {
    if (!socket || typeof socket.id !== 'string') return null;
    const had = this.bySocket.get(socket.id);
    if (had && !had.stopped && had.seatOf(socket.id)) return had;
    const room = this.roomForWatcher();
    if (!room) return null;
    if (!room.addSocket(socket, { clearFirst: this.cleared.has(socket.id) })) return null;
    this.cleared.delete(socket.id);
    this.bySocket.set(socket.id, room);
    return room;
  }

  // Play. Returns the room's answer ('ok', 'alive', 'full', ...).
  // A socket with no seat (back after ag:leave) is seated straight into a room with a player slot, so a full set
  // of watcher seats never stops a Play.
  // A socket holding an open paid account never takes a free seat this way ('paid': dropped); a seatless paid socket
  // (after death or cash-out, or a hand-off that chose free) is seated in a free room like any other.
  join(socket, name) {
    if (this.paidRoomOf(socket.id)) return 'paid';
    let room = this.bySocket.get(socket.id);
    if (room && room.money) {
      this.bySocket.delete(socket.id);
      room = null;
    }
    this._stopSeatlessTimer(socket.id);
    if (!room || room.stopped || !room.seatOf(socket.id)) {
      this.bySocket.delete(socket.id);
      room = this.roomForPlayer(null);
      if (!room || !room.addSocket(socket, { clearFirst: this.cleared.has(socket.id), forPlay: true })) return 'full';
      this.cleared.delete(socket.id);
      this.bySocket.set(socket.id, room);
    }
    const seat = room.seatOf(socket.id);
    if (!seat.joined && !room.hasSpace()) {
      const other = this.roomForPlayer(null);
      if (!other) return 'full';
      room.removeSocket(socket.id);
      if (!other.addSocket(socket, { clearFirst: true, forPlay: true })) {
        this.bySocket.delete(socket.id);
        return 'full';
      }
      this.bySocket.set(socket.id, other);
      room = other;
    }
    return room.join(socket.id, name);
  }

  // Spectate: a socket that left first watches again.
  spectate(socket) {
    let room = this.bySocket.get(socket.id);
    if (room && room.money) return false;   // no spectate on a paid rung (design 8 #13)
    if (!room) room = this.connect(socket);
    return room ? room.spectate(socket.id) : false;
  }

  target(socketId, x, y) {
    const room = this.bySocket.get(socketId);
    return room ? room.target(socketId, x, y) : false;
  }

  split(socketId) {
    const room = this.bySocket.get(socketId);
    return room ? room.split(socketId) : false;
  }

  eject(socketId) {
    const room = this.bySocket.get(socketId);
    return room ? room.eject(socketId) : false;
  }

  q(socketId) {
    const room = this.bySocket.get(socketId);
    return room ? room.q(socketId) : false;
  }

  // ag:view: the rows the page draws under the reference view, in world units at zoom 1 (agSockets checks it is a
  // whole number, 0 or more; the view caps it, law VIEW_BELOW). Kept per socket, seated or not, until it
  // disconnects, so a move to another room or a Play after ag:leave keeps it; every room reads it through
  // viewBelowOf when it builds that socket's view.
  view(socketId, below) {
    if (typeof socketId !== 'string') return false;
    if (below > 0) this.viewBelow.set(socketId, below);
    else this.viewBelow.delete(socketId);
    return true;
  }

  // ag:portrait: the page plays the phone portrait layout (true) or the reference layout (false). One boolean,
  // never a size: the view turns L4's own box (agView viewBoxFor). Kept per socket like ag:view. Rate limited
  // here, not dropped: the box changes orientation at most once per PORTRAIT_GAP_MS, and a report that comes
  // sooner waits and is applied when the gap is up (portraitOf), so the last report always wins.
  portrait(socketId, on) {
    if (typeof socketId !== 'string' || typeof on !== 'boolean') return false;
    let st = this.portraitState.get(socketId);
    if (!st) {
      if (!on) return true;          // false is every socket's start: nothing to keep
      st = { on: false, want: false, at: -Infinity };
      this.portraitState.set(socketId, st);
    }
    st.want = on;
    this._settlePortrait(st);
    return true;
  }

  // What that socket's view box uses now (read by every room build).
  portraitOf(socketId) {
    const st = this.portraitState.get(socketId);
    if (!st) return false;
    if (st.want !== st.on) this._settlePortrait(st);
    return st.on;
  }

  _settlePortrait(st) {
    if (st.want === st.on) return;
    const now = this.now();
    if (now - st.at < PORTRAIT_GAP_MS) return;
    st.on = st.want;
    st.at = now;
  }

  // ag:leave: the player and its cells go at once (LEAVE_RULE), the socket gets nothing more until it plays or
  // spectates again, and its next seat starts with clearAll.
  // A paid seat with an open account leaves alive only by cash-out ('cash-out-to-leave', design 4 step 7): false.
  leave(socketId) {
    const room = this.bySocket.get(socketId);
    if (!room) return false;
    if (room.money) return false;
    room.removeSocket(socketId);
    this.bySocket.delete(socketId);
    this.cleared.add(socketId);
    return true;
  }

  // The socket closed: the player and its cells go at once (LEAVE_RULE, CHOSEN until Owen picks a rule).
  // A paid seat goes into its disconnect grace (agRoom.removeSocket).
  disconnect(socketId) {
    const room = this.bySocket.get(socketId);
    if (room) room.removeSocket(socketId);
    this.bySocket.delete(socketId);
    this._stopSeatlessTimer(socketId);
    this.cleared.delete(socketId);
    this.viewBelow.delete(socketId);
    this.portraitState.delete(socketId);
  }

  // Every 60 s from the server: an OVERFLOW room with no socket (not even a watcher) for SWEEP_IDLE_MS closes.
  // Room 0 always stays.
  // A paid overflow room closes only with no seat, no open account and an empty bank (design 5.3); a settling room
  // is retried (any account its emergency settle left open) and dropped once its bank is empty.
  sweep(now) {
    for (const room of this.rooms.slice()) {
      if (room.index === 0 || room.seats.size > 0) {
        this.emptySince.delete(room);
        continue;
      }
      if (!this.emptySince.has(room)) this.emptySince.set(room, now);
      if (now - this.emptySince.get(room) >= SWEEP_IDLE_MS) {
        room.stop();
        this.rooms.splice(this.rooms.indexOf(room), 1);
        this.emptySince.delete(room);
      }
    }
    for (const list of this.rungs.values()) {
      for (const room of list.slice()) {
        const busy = room.seats.size > 0 || room.openAccounts() > 0 || room.money.bank.totalMicro() > 0;
        if (room.index === 0 || busy) {
          this.emptySince.delete(room);
          continue;
        }
        if (!this.emptySince.has(room)) this.emptySince.set(room, now);
        if (now - this.emptySince.get(room) >= SWEEP_IDLE_MS) {
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
      } catch (e) {
        this.log.error('[AG] settling retry', room.lobbyType, e && e.message);
      }
      if (room.money.bank.totalMicro() === 0) this.settling.splice(this.settling.indexOf(room), 1);
    }
  }

  // /api/live rows, the shape paperArenas.boardRows() gives: one row per rung, the id format 'ag:<region>:s<stake>'
  // (as Paper's, PaperArenas.js:261). A paid row (only while AG_PAID was on at boot) counts every open account in
  // players (away and frozen included, so rule 4b sees parked money), parked the away ones, no bots, and says
  // 'closed' while the owner's off switch is on (kept listed while it still has accounts).
  boardRows() {
    let players = 0;
    let bots = 0;
    for (const r of this.rooms) {
      if (r.stopped) continue;
      players += r.liveHumans;
      bots += r.botCount;
    }
    const rows = [{
      id: 'ag:' + this.region + ':s0',
      game: this.game,
      region: this.region,
      stake: 0,
      players,
      bots,
      capacity: this.cap,
      state: 'open',
    }];
    for (const [stake, list] of this.rungs) {
      let open = 0;
      let parked = 0;
      for (const r of list.concat(this.settling.filter((x) => x.stake === stake))) {
        if (!r.money) continue;
        open += r.money.openCount();
        parked += r.money.parkedCount();
      }
      rows.push({
        id: 'ag:' + this.region + ':s' + stake,
        game: this.game,
        region: this.region,
        stake,
        players: open,
        parked,
        bots: 0,
        capacity: this.cap,
        state: this.paidOpen ? 'open' : 'closed',
      });
    }
    return rows;
  }

  // Humans who joined, across every room (the lobby card's count). Bots and watchers are not players; paid
  // accounts count while their player is here (away ones are parked, design 5.3).
  liveCount() {
    let n = 0;
    for (const r of this.rooms) if (!r.stopped) n += r.liveHumans;
    for (const r of this.paidRooms()) if (!r.stopped) n += r.money.openCount() - r.money.parkedCount();
    return n;
  }

  // paperArenas' name for the same count, so liveCounts can read either.
  humanTotal() {
    return this.liveCount();
  }

  stop() {
    for (const r of this.rooms) r.stop();
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

module.exports = { AgArenas, ARENA_TUNING, refuse, OUTCOME_TTL_MS, OUTCOME_MAX, RELEASE_MAX, RELEASE_WINDOW_MS,
  PAID_SEATLESS_MS };
