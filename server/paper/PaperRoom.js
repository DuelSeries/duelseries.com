'use strict';
// One Paper arena (design 5.1-5.9): the sim, its bank, its wire, and every seat. All money in
// the arena lives in the bank; the sim only reports deaths. Money leaves only through the hooks
// the directory wires to paperPayout (cash-out, refund, floor sweep). This file never touches
// money, db or Wallet directly.
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { makeArena, REASON, P, MP } = require('./ArenaGame');
const PaperBank = require('./PaperBank');
const { ArenaWire } = require('./arenaWire');
const arenaTrim = require('./arenaTrim');

// The territory trim is on: the T14 soak (test/paperSoak.test.js) passed three runs in a row
// (design 9.6). A room built with trim: null still runs without it.
const TRIM_ON = true;

const REQUIRED_HOOKS = ['onCashout', 'onTransfer', 'onRefund', 'onSweep', 'onBreach'];
const IN_RATE_MAX = 120; // pp:in per second per seat; more are ignored (6.2)
let roomSeq = 0; // makes every arena's socket.io room name unique for the process
const monotonicNow = () => performance.now();

function stakeLabel(stake) {
  return 's' + String(Number(stake)).replace('.', '_');
}

class PaperRoom {
  // now: the wall clock of every deadline (grace, stale hold, coin age). clock: the monotonic
  // clock the tick loop runs on (never steps with the wall clock).
  constructor({ stake = 0, region = 'na', index = 0, io = null, hooks = {}, now = Date.now, clock = monotonicNow, seed, directory = null, autoTick = true, trim } = {}) {
    for (const name of REQUIRED_HOOKS) {
      if (typeof hooks[name] !== 'function') throw new Error('PaperRoom: hook ' + name + ' must be a function');
    }
    this.stake = Number(stake) || 0;
    this.paid = this.stake > 0;
    this.region = region;
    this.index = index;
    this.lobbyType = 'paper_' + region + '_' + stakeLabel(this.stake) + (index > 0 ? '#' + index : '');
    // Unique per arena object: an arena re-created at a swept or closed index must not reach
    // sockets still sitting in the old one's io room.
    this.ioRoom = 'pp:' + this.lobbyType + ':' + ++roomSeq;
    this.io = io;
    this.hooks = hooks;
    this.now = now;
    this.clock = clock;
    this.directory = directory;
    this.autoTick = autoTick;
    this.stopped = false;
    this.warming = false;
    this.failCount = 0;
    this.closed = false; // the once-only emergency latch
    this.timer = null;
    this._onWake = () => this._timerWake();
    this.acc = 0;
    this.last = 0;
    this.pending = [];
    this.seats = new Map(); // unitId -> seat
    this.bySocket = new Map(); // socketId -> seat
    this.idleLogged = false;
    this.onClosed = null;

    this.bank = new PaperBank({
      onTransfer: (t) => hooks.onTransfer(Object.assign({}, t, { label: this.lobbyType })),
      onBreach: (b) => {
        console.error('[PAPER] LEDGER', this.lobbyType, JSON.stringify(b));
        hooks.onBreach(Object.assign({ lobbyType: this.lobbyType, kind: 'ledger' }, b));
      }
    });
    const useTrim = trim !== undefined ? trim : TRIM_ON ? arenaTrim : null;
    this.game = makeArena({
      stake: this.stake,
      seed: seed === undefined ? Math.random() : seed,
      trim: useTrim,
      hooks: {
        onDeath: (victim, killer, reason, at) => this.onDeath(victim, killer, reason, at),
        afterTick: () => this.afterTick(),
        onRadius: (r, prev) => this.onRadius(r, prev),
        onReseat: (unit) => this.pending.push(['mv', unit.id, unit.position.x, unit.position.y]),
        idReserved: (id) => this.bank.isOpen(id) || this.seats.has(id)
      }
    });
    // The hold starts and stops right after the inputs are applied, BEFORE movement, so the
    // client predictor (which stops on the key at once) agrees with the server tick for tick.
    const apply = this.game.applyInputs.bind(this.game);
    this.game.applyInputs = () => {
      apply();
      this._holdInputs();
    };
    // Bots the sim spawns mid-game are announced like joiners, so clients learn name and skin.
    const addUnit = this.game.addUnit.bind(this.game);
    this.game.addUnit = (unit) => {
      addUnit(unit);
      if (!unit.isHuman) {
        this.pending.push(['j', { id: unit.id, name: unit.name, skin: unit.skin ? unit.skin.name : null, bot: true, micro: 0, x: unit.position.x, y: unit.position.y }]);
      }
    };
    // A capture drives the owner's "+x.xx%" label.
    const handleReturn = this.game.handleReturn.bind(this.game);
    this.game.handleReturn = (unit) => {
      const before = unit.base.square;
      const r = handleReturn(unit);
      const gain = (unit.base.square - before) / this.game.square;
      if (!unit.death && gain > 0) this.pending.push(['cap', unit.id, gain]);
      return r;
    };
    this.wire = new ArenaWire(this.game, {
      queue: (e) => this.pending.push(e),
      microOf: (id) => this.bank.balance(id),
      holdingOf: (u) => !!(u.isHuman && u.locked)
    });
  }

  // ---------------------------------------------------------------------------------------
  // Seats
  // ---------------------------------------------------------------------------------------

  get liveHumans() {
    return this.seats.size;
  }

  get playerCount() {
    return this.seats.size;
  }

  get botCount() {
    return this.game.units.filter((u) => !u.isHuman).length;
  }

  isFree() {
    return this.stake === 0;
  }

  botsAllowed() {
    return this.isFree();
  }

  // Console contract (design 5.8): a paid arena never has bots.
  addBot() {
    if (!this.botsAllowed() || this.stopped) return null;
    const n = this.game.units.length;
    this.game._enter();
    this.game.spawnBot('random');
    return this.game.units.length > n ? this.game.units[this.game.units.length - 1] : null;
  }

  topUpBots() {
    if (!this.botsAllowed()) this.clearBots();
  }

  clearBots() {
    while (this.game.removeLowestBot()) { /* every bot */ }
  }

  findSpawn() {
    if (this.stopped) return null;
    return this.game.findSpawn();
  }

  hasLiveUnit(socketId) {
    const seat = this.bySocket.get(socketId);
    return !!(seat && !seat.unit.death);
  }

  seatOfSocket(socketId) {
    return this.bySocket.get(socketId) || null;
  }

  // The join (design 5.6 step 8). Throws when the arena cannot seat; the caller refunds. A
  // failed join never leaves a unit or an open account behind.
  //
  // A PAID seat starts UNCONFIRMED: the server cannot know that pp:joined (and the resumeKey in
  // it) ever reached the player until the first input arrives, because the client steers only
  // after pp:joined. Until then the seat can be taken back with the entry token that bought it
  // (proof = its sha256), and if its socket closes, or JOIN_CONFIRM_MS pass with no input, the
  // buy-in is refunded instead of the square being left to fly with nobody steering and its
  // money dropping on the floor (STATUS "BEFORE PAPER_PAID IS SWITCHED ON" item 2).
  addHuman(socket, { name, micro, wallet, spot, proof, paid }) {
    const game = this.game;
    game._enter();
    if (this.stopped) throw new Error('stopped');
    if (this.seats.size >= MP.MAX_HUMANS) throw new Error('full');
    if (!this.paid && game.units.length >= MP.FREE_SQUARES) game.removeLowestBot();
    const unit = game.spawnHuman({ name, socketId: socket.id }, spot || null);
    let seat = null;
    try {
      this.bank.deposit(unit.id, micro, wallet || null, name);
      seat = {
        room: this,
        unit,
        socketId: socket.id,
        resumeKey: crypto.randomUUID(),
        graceUntil: 0,
        wallet: wallet || null,
        name,
        inWindow: 0,
        inCount: 0,
        proof: this.paid && typeof proof === 'string' ? proof : null,
        paid: Number.isFinite(paid) ? paid : undefined, // what landed on-chain: bounds a refund
        deposit: micro,
        confirmed: !this.paid,
        confirmBy: this.paid ? this.now() + MP.JOIN_CONFIRM_MS : 0,
        released: false
      };
      this.seats.set(unit.id, seat);
      this.bySocket.set(socket.id, seat);
      if (this.directory) this.directory._seatAdded(seat);
      this.idleLogged = false;
      this.pending.push(['j', { id: unit.id, name: unit.name, skin: unit.skin ? unit.skin.name : null, bot: false, micro, x: unit.position.x, y: unit.position.y }]);
      this._flushPending(); // to the members already here, never to the joiner
      socket.join(this.ioRoom);
      socket.emit('pp:joined', MP.packBin(this.joinedPayload(seat, false)));
      this._ensureTicking();
      return seat;
    } catch (e) {
      if (this.bank.isOpen(unit.id)) this.bank.withdraw(unit.id); // the caller's refund pays it
      if (seat) this._forgetSeat(seat);
      game.removeHuman(unit.id, REASON.FORCED_EXIT);
      throw e;
    }
  }

  joinedPayload(seat, resumed) {
    const w = this.wire.joinPayload();
    return {
      you: seat.unit.id,
      arenaId: this.lobbyType,
      stake: this.stake,
      tick: w.tick,
      radius: w.radius,
      targetRadius: w.targetRadius,
      holdTicks: MP.HOLD_TICKS,
      resumeKey: seat.resumeKey,
      resumed: !!resumed,
      units: w.units,
      pickups: this.bank.pickups().map((p) => ({ pid: p.pid, x: p.x, y: p.y, micro: p.micro })),
      rings: w.rings,
      trails: w.trails
    };
  }

  // Disconnect (design 5.7): the hold is cancelled, the square keeps moving on its last angle.
  // An unconfirmed paid seat has nobody who ever steered it: its buy-in is refunded at once.
  beginGrace(seat) {
    if (!seat.confirmed) {
      this.releaseUnconfirmed(seat, 'join-lost');
      return;
    }
    const u = seat.unit;
    u.holdBit = false;
    u.locked = false;
    u.holdTicks = 0;
    this.game.resetInput(u.id);
    if (seat.socketId) this.bySocket.delete(seat.socketId);
    const prev = seat.socketId;
    seat.socketId = null;
    u.socketId = null;
    seat.graceUntil = this.now() + MP.DISCONNECT_GRACE_MS;
    if (this.directory) this.directory._seatSocket(seat, prev);
  }

  // Reconnect by resumeKey (design 5.7): no token, no deposit, the hold is not restored. Only a
  // player who got pp:joined holds the resumeKey, so that resume confirms the seat. byToken: an
  // unconfirmed seat taken back with the entry token that bought it (the page re-sends it when
  // its link dropped before pp:joined); nothing is consumed or deposited, the seat stays
  // unconfirmed until its first input, and pp:joined says resumed: false because this is the
  // first one that player sees.
  resume(socket, seat, byToken) {
    if (seat.room !== this || seat.unit.death || !this.seats.has(seat.unit.id) || seat.released) return false;
    if (byToken && seat.confirmed) return false;
    const prev = seat.socketId;
    if (prev && prev !== socket.id) {
      const old = this._socketById(prev);
      if (old) {
        old.emit('pp:replaced', { tick: this.game.tick });
        old.leave(this.ioRoom);
        old._ppRoom = null;
      } else if (this.io) {
        this.io.to(prev).emit('pp:replaced', { tick: this.game.tick });
      }
      this.bySocket.delete(prev);
    }
    const u = seat.unit;
    seat.graceUntil = 0;
    seat.socketId = socket.id;
    u.socketId = socket.id;
    u.holdBit = false;
    u.locked = false;
    u.holdTicks = 0;
    this.game.resetInput(u.id);
    this.bySocket.set(socket.id, seat);
    if (this.directory) this.directory._seatSocket(seat, prev);
    if (!byToken) this._confirm(seat);
    this._flushPending();
    socket.join(this.ioRoom);
    socket.emit('pp:joined', MP.packBin(this.joinedPayload(seat, !byToken)));
    return true;
  }

  _confirm(seat) {
    if (seat.confirmed) return;
    seat.confirmed = true;
    seat.confirmBy = 0;
    if (this.directory) this.directory._seatConfirmed(seat);
  }

  // An unconfirmed paid seat whose player never took control: its socket closed ('join-lost')
  // or JOIN_CONFIRM_MS passed with no input ('join-timeout'). The buy-in goes back through
  // onRefund exactly once, bounded by what landed (paperPayout.refund caps at seat.paid); any
  // money the square picked up meanwhile stays in the arena as a coin where it stood; the
  // square leaves with reason 10 (no coin, no pp:dead). All synchronous, latched by
  // seat.released, and the refund is dispatched even if the sim throws on the removal.
  releaseUnconfirmed(seat, why) {
    const u = seat.unit;
    if (seat.released || seat.confirmed || u.death || this.seats.get(u.id) !== seat) return false;
    seat.released = true;
    const socketId = seat.socketId;
    const w = this.bank.withdrawUpTo(u.id, seat.deposit);
    const rest = this.bank.balance(u.id);
    if (rest > 0) {
      const c = this._clampInside(u.position);
      const p = this.bank.drop(u.id, c.x, c.y, this.now());
      if (p) this.pending.push(['p+', p.pid, p.x, p.y, p.micro]);
    } else if (this.bank.isOpen(u.id)) {
      this.bank.drop(u.id, 0, 0, this.now()); // closes the emptied account
    }
    const refunded = !!(w && w.micro > 0);
    if (this.directory) this.directory._rememberRelease(seat, why, refunded);
    console.log('[PAPER] RELEASE ' + this.lobbyType + ' ' + why + ' refund=' + (w ? w.micro : 0) + ' rest=' + rest);
    try {
      this.game.removeHuman(u.id, REASON.FORCED_EXIT);
    } finally {
      if (this.seats.get(u.id) === seat) this._forgetSeat(seat);
      if (refunded) {
        try {
          this.hooks.onRefund({ wallet: w.wallet, name: w.name, micro: w.micro, paid: seat.paid, why });
        } catch (e) {
          console.error('[PAPER] RELEASE CRITICAL refund hook threw, owed ' + w.micro + ' micro to ' + w.wallet + ': ' + (e && e.message));
        }
      }
      if (socketId) {
        try {
          const s = this._socketById(socketId);
          if (s) {
            s.leave(this.ioRoom);
            if (s._ppRoom === this) s._ppRoom = null;
          }
          if (this.io) this.io.to(socketId).emit('pp:refused', { why, refunded });
        } catch (e) {
          console.error('[PAPER] RELEASE tell', e && e.message);
        }
      }
    }
    return true;
  }

  _socketById(id) {
    const io = this.io;
    if (io && io.sockets && io.sockets.sockets && typeof io.sockets.sockets.get === 'function') {
      return io.sockets.sockets.get(id) || null;
    }
    return null;
  }

  // One pp:in from a seated socket: an input integer, or an array of up to MP.INPUT_BATCH_MAX
  // of them in send order (every tick one client frame predicted). Each input counts against
  // the rate on its own. Anything malformed or over the rate is ignored.
  setInput(socketId, n) {
    if (Array.isArray(n)) {
      if (n.length < 1 || n.length > MP.INPUT_BATCH_MAX || !n.every(Number.isInteger)) return false;
      let any = false;
      for (let i = 0; i < n.length; i++) any = this._setOneInput(socketId, n[i]) || any;
      return any;
    }
    return this._setOneInput(socketId, n);
  }

  _setOneInput(socketId, n) {
    const seat = this.bySocket.get(socketId);
    if (!seat || seat.unit.death) return false;
    const now = this.now();
    if (now - seat.inWindow >= 1000) {
      seat.inWindow = now;
      seat.inCount = 0;
    }
    if (++seat.inCount > IN_RATE_MAX) return false;
    const d = MP.decodeInput(n);
    if (!d) return false;
    if (!seat.confirmed) this._confirm(seat); // the player has pp:joined: it is steering
    return this.game.setInput(seat.unit.id, d.seq, d.angle, d.hold, now);
  }

  // Deliberate exit (pp:leave) or any server-side removal.
  removeHuman(id, reason) {
    return this.game.removeHuman(id, reason);
  }

  geo(id) {
    return this.wire.geo(id);
  }

  _forgetSeat(seat) {
    this.seats.delete(seat.unit.id);
    if (seat.socketId && this.bySocket.get(seat.socketId) === seat) this.bySocket.delete(seat.socketId);
    if (this.directory) this.directory._seatFreed(seat);
    if (!this.seats.size) this._goIdle();
  }

  // ---------------------------------------------------------------------------------------
  // Money on death (design 5.2)
  // ---------------------------------------------------------------------------------------

  onDeath(victim, killer, reason, at) {
    const seat = victim.isHuman ? this.seats.get(victim.id) : null;
    if (reason === REASON.CASHOUT || reason === REASON.FORCED_EXIT) {
      this.pending.push(['k', victim.id, 0, reason, 0, 0]);
      if (seat) this._forgetSeat(seat);
      return;
    }
    const m = this.bank.balance(victim.id);
    let pid = 0;
    if (m > 0) {
      if (killer && killer.isHuman && this.bank.isOpen(killer.id) && this.bank.transferAll(victim.id, killer.id) >= 0) {
        this.pending.push(['m', killer.id, this.bank.balance(killer.id)]);
      } else {
        const c = this._clampInside(at);
        const p = this.bank.drop(victim.id, c.x, c.y, this.now());
        if (p) {
          pid = p.pid;
          this.pending.push(['p+', p.pid, p.x, p.y, p.micro]);
        }
      }
    } else if (victim.isHuman) {
      this.bank.drop(victim.id, 0, 0, this.now()); // closes a zero account
    }
    this.pending.push(['k', victim.id, killer ? killer.id : 0, reason, m, pid]);
    if (seat) {
      if (seat.socketId && this.io) {
        this.io.to(seat.socketId).emit('pp:dead', {
          reason,
          killerId: killer ? killer.id : 0,
          killerName: killer ? killer.name : null,
          lostMicro: m,
          tick: this.game.tick
        });
      }
      this._forgetSeat(seat);
    }
  }

  _clampInside(at) {
    const c = this.game.border.center;
    const r = this.game.border.radius - MP.PICKUP_WALL_INSET;
    const dx = at.x - c.x;
    const dy = at.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d <= r || d === 0) return { x: at.x, y: at.y };
    return { x: c.x + (dx * r) / d, y: c.y + (dy * r) / d };
  }

  onRadius(r, prev) {
    if (r >= prev) return;
    for (const p of this.bank.pickups()) {
      const c = this._clampInside(p);
      if (c.x !== p.x || c.y !== p.y) this.bank.movePickup(p.pid, c.x, c.y);
    }
  }

  // ---------------------------------------------------------------------------------------
  // The tick's post pass: pickups, the hour sweep, grace expiries, holds, wire, ledger
  // ---------------------------------------------------------------------------------------

  afterTick() {
    const now = this.now();
    this._collectPickups();
    this.sweepPickups(now);
    for (const seat of Array.from(this.seats.values())) {
      if (!seat.confirmed && seat.confirmBy && seat.confirmBy <= now && !seat.unit.death) {
        this.releaseUnconfirmed(seat, 'join-timeout');
      }
    }
    for (const seat of Array.from(this.seats.values())) {
      if (seat.graceUntil && seat.graceUntil <= now && !seat.unit.death) {
        this.game.removeHuman(seat.unit.id, REASON.DISCONNECT);
      }
    }
    for (const seat of Array.from(this.seats.values())) {
      const u = seat.unit;
      if (u.death || !u.locked) continue;
      u.holdTicks += 1;
      if (u.holdTicks >= MP.HOLD_TICKS) this.completeCashout(u);
    }
    this.wire.feed();
    this.bank.assertConserved();
    if (this.game.tick % MP.SNAPSHOT_EVERY === 0 || this._idleFlush) {
      this._idleFlush = false;
      this._snapshot();
    }
  }

  // IDLE -> HOLDING -> IDLE on the applied hold bit, before movement (design 5.4).
  _holdInputs() {
    const now = this.now();
    for (const seat of this.seats.values()) {
      const u = seat.unit;
      if (u.death) continue;
      const fresh = now - u.lastInputAt <= MP.HOLD_INPUT_STALE_MS;
      if (!u.locked) {
        if (u.holdBit && fresh && seat.socketId) {
          u.locked = true;
          u.holdTicks = 0;
        }
      } else if (!u.holdBit || !fresh || !seat.socketId) {
        u.locked = false;
        u.holdTicks = 0;
      }
    }
  }

  // All synchronous: zero and close FIRST, then remove the square; the order is dispatched
  // exactly once whenever the bank released money, even if the sim throws.
  completeCashout(unit) {
    const seat = this.seats.get(unit.id);
    const socketId = seat ? seat.socketId : unit.socketId;
    const w = this.bank.withdraw(unit.id);
    const order = w && {
      cashoutId: crypto.randomUUID(),
      socketId,
      wallet: w.wallet,
      name: w.name,
      grossMicro: w.micro,
      stake: this.stake,
      label: this.lobbyType
    };
    try {
      this.game.removeHuman(unit.id, REASON.CASHOUT);
    } finally {
      if (w && w.micro > 0) this.hooks.onCashout(order);
      else if (socketId && this.io) this.io.to(socketId).emit('pp:cashedout', { grossMicro: 0, cutMicro: 0, netMicro: 0 });
    }
  }

  _collectPickups() {
    const coins = this.bank.pickups();
    if (!coins.length) return;
    const r2 = MP.PICKUP_RADIUS * MP.PICKUP_RADIUS;
    for (const p of coins) {
      let best = null;
      let bestD = Infinity;
      for (const seat of this.seats.values()) {
        const u = seat.unit;
        if (u.death || !this.bank.isOpen(u.id)) continue;
        const dx = u.position.x - p.x;
        const dy = u.position.y - p.y;
        const d = dx * dx + dy * dy;
        if (d > r2) continue;
        if (d < bestD || (d === bestD && best && u.id < best.id)) {
          best = u;
          bestD = d;
        }
      }
      if (!best) continue;
      const got = this.bank.collect(p.pid, best.id);
      if (got > 0) {
        this.pending.push(['p-', p.pid, best.id, got]);
        this.pending.push(['m', best.id, this.bank.balance(best.id)]);
      }
    }
  }

  // Owner decision 1: a coin nobody collected within the hour goes to the house.
  sweepPickups(now) {
    for (const p of this.bank.pickups()) {
      if (now - p.droppedAt < MP.PICKUP_SWEEP_MS) continue;
      const s = this.bank.sweepPickup(p.pid);
      if (!s) continue;
      this.pending.push(['p-', p.pid, 0, s.micro]);
      this.hooks.onSweep({ sweepId: crypto.randomUUID(), micro: s.micro, srcWallet: s.srcWallet, srcName: s.srcName, label: this.lobbyType, pid: p.pid });
    }
  }

  _flushPending() {
    if (!this.pending.length) return;
    const ev = this.pending;
    this.pending = [];
    if (this.io) this.io.to(this.ioRoom).emit('pp:ev', MP.packBin({ tick: this.game.tick, ev }));
  }

  // The volatile frame goes out BEFORE the reliable bundle. Any send leaves a socket's transport
  // unwritable until its write completes (after this turn), and socket.io throws away a
  // volatile packet to an unwritable transport: frame after bundle lost the frame on every
  // snapshot tick that had an event (13 of 30 frames a second arrived, live and local; night
  // queue item 3). A frame that lands just before its own tick's bundle is harmless: entries
  // apply by tick, and the version compare waits RESYNC_AFTER_MS before it asks for anything.
  _snapshot() {
    if (this.io) {
      const buf = this.wire.frame(this.bank.pickups().map((p) => ({ pid: p.pid, x: p.x, y: p.y, micro: p.micro })));
      this.io.to(this.ioRoom).volatile.emit('pp:s', buf);
    }
    this._flushPending();
  }

  // ---------------------------------------------------------------------------------------
  // Clock, while anyone is seated: fixed STEP_MS steps against the monotonic clock. Each wake
  // runs every step that is due (at most MAX_STEPS_PER_WAKE: a longer stall drops the rest of
  // its backlog, never one long step and never a spiral) and then sleeps until the next step
  // is due, so ticks land every STEP_MS on average with no drift. The old setInterval(16) woke
  // at a fixed 16 ms whatever was due: on Linux a zero-step wake and a 33 ms gap about 2.5
  // times a second, on Windows (15.6 ms timer) two steps back to back every 31 ms.
  // ---------------------------------------------------------------------------------------

  _ensureTicking() {
    if (this.timer || this.stopped || !this.autoTick) return;
    this.last = this.clock();
    this.acc = 0;
    this._arm();
  }

  // Milliseconds until the next step is due (0 when one already is).
  _dueIn() {
    return Math.max(0, MP.STEP_MS - this.acc - (this.clock() - this.last));
  }

  // Timers are whole milliseconds: sleep to the first one at or after the due time.
  _arm() {
    this.timer = setTimeout(this._onWake, Math.max(1, Math.ceil(this._dueIn())));
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  // The last seat just went. The tick in progress (if any) still finishes, and its events
  // (the victim's own ['k'], a dropped coin) must reach the room before the clock stops.
  _goIdle() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this._inTick) this._idleFlush = true;
    else this._snapshot();
    if (this.paid && !this.idleLogged && this.bank.totalMicro() > 0) {
      this.idleLogged = true;
      const accounts = this.bank.openIds().map((id) => {
        const a = this.bank.accounts.get(id);
        return { wallet: a.wallet, name: a.name, micro: a.micro };
      });
      const coins = this.bank.pickups().map((p) => ({ pid: p.pid, srcWallet: p.srcWallet, micro: p.micro, droppedAt: p.droppedAt }));
      console.log('[PAPER] IDLE ' + this.lobbyType + ' ' + JSON.stringify({ accounts, coins }));
    }
  }

  // Every step is a whole tickOnce with its own afterTick (kills, holds, grace, snapshot), so
  // the cash-out hold (HOLD_TICKS) and every other count in ticks stay exact whatever the wake.
  wake() {
    const now = this.clock();
    this.acc += now - this.last;
    this.last = now;
    let steps = Math.floor(this.acc / MP.STEP_MS);
    if (steps > MP.MAX_STEPS_PER_WAKE) {
      steps = MP.MAX_STEPS_PER_WAKE;
      this.acc %= MP.STEP_MS; // extra backlog is dropped, never one long step
    } else {
      this.acc -= steps * MP.STEP_MS;
    }
    while (steps-- > 0 && !this.stopped) this.tickOnce();
  }

  // The timer's callback: the steps, then the next sleep while anyone is still seated.
  _timerWake() {
    this.timer = null;
    if (this.stopped) return;
    this.wake();
    if (!this.stopped && !this.timer && this.seats.size) this._arm();
  }

  // One guarded sim step. EMERGENCY_FAIL_TICKS throws in a row close the arena once.
  tickOnce() {
    if (this.stopped) return false;
    this._inTick = true;
    try {
      this.game.update(MP.STEP_MS);
      this.failCount = 0;
      return true;
    } catch (e) {
      this.failCount++;
      console.error('[PAPER] TICK threw', this.lobbyType, this.failCount, e && e.stack ? e.stack : e);
      if (this.failCount >= MP.EMERGENCY_FAIL_TICKS) this.emergencyClose();
      return false;
    } finally {
      this._inTick = false;
    }
  }

  // Free arena #1 at boot: the reference's warm-up, in chunks so it never stalls the process.
  warmUp(done) {
    this.warming = true;
    let left = this.game.config.prepareCounter;
    const chunk = () => {
      if (this.stopped) return;
      for (let i = 0; i < MP.WARM_CHUNK && left > 0; i++, left--) this.game.update(50 + Math.random());
      if (left > 0) setImmediate(chunk);
      else {
        this.warming = false;
        if (done) done();
      }
    };
    setImmediate(chunk);
  }

  // Design 5.9: every live account cashed out at the normal 90/10 through onCashout, every
  // floor coin refunded to its source once, then the arena stops for good.
  emergencyClose() {
    if (this.closed) return;
    this.closed = true;
    let accounts = 0;
    let coins = 0;
    let total = 0;
    for (const seat of Array.from(this.seats.values())) {
      const id = seat.unit.id;
      const w = this.bank.withdraw(id);
      this.seats.delete(id);
      if (seat.socketId) this.bySocket.delete(seat.socketId);
      if (this.directory) this.directory._seatFreed(seat);
      if (!w) continue;
      accounts++;
      total += w.micro;
      if (w.micro > 0) {
        try {
          this.hooks.onCashout({ cashoutId: crypto.randomUUID(), socketId: seat.socketId, wallet: w.wallet, name: w.name, grossMicro: w.micro, stake: this.stake, label: this.lobbyType });
        } catch (e) {
          console.error('[PAPER] EMERGENCY cashout hook', e && e.message);
        }
      }
    }
    for (const p of this.bank.pickups()) {
      const s = this.bank.sweepPickup(p.pid);
      if (!s) continue;
      coins++;
      total += s.micro;
      try {
        this.hooks.onRefund({ wallet: s.srcWallet, name: s.srcName, micro: s.micro, paid: undefined, why: 'emergency' });
      } catch (e) {
        console.error('[PAPER] EMERGENCY refund hook', e && e.message);
      }
    }
    console.error('[PAPER] EMERGENCY ' + this.lobbyType + ' accounts=' + accounts + ' coins=' + coins + ' micro=' + total);
    try {
      this.hooks.onBreach({ lobbyType: this.lobbyType, kind: 'emergency', accounts, coins, micro: total });
    } catch (e) {
      console.error('[PAPER] EMERGENCY alert hook', e && e.message);
    }
    this.stop();
    if (this.onClosed) this.onClosed(this);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      this.game.stop();
    } catch (e) {
      console.error('[PAPER] stop', e && e.message);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Solvency and ops (design 5.8)
  // ---------------------------------------------------------------------------------------

  liveStakeTotal() {
    return this.bank.totalMicro() / 1e6;
  }

  get floorWorth() {
    return this.bank.floorMicro() / 1e6;
  }

  // What ops.drainStatus reads: live paid humans (a seat in grace included).
  get snakes() {
    const m = new Map();
    if (!this.paid) return m;
    for (const seat of this.seats.values()) {
      m.set('pp' + seat.unit.id, { alive: !seat.unit.death, isBot: false, worth: this.bank.balance(seat.unit.id) / 1e6 });
    }
    return m;
  }
}

module.exports = { PaperRoom, TRIM_ON, stakeLabel };
