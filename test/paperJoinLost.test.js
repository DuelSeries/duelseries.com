'use strict';
// STATUS "BEFORE PAPER_PAID IS SWITCHED ON" item 2 (night queue item 5): a paid socket that drops
// after pp:join reached the server but before pp:joined reached the player never got a resumeKey,
// so its seat was orphaned: the square flew on with nobody steering and its money dropped on the
// floor when the grace ended. The stake must end up seated or refunded, exactly once, never lost
// and never double. A paid seat is now UNCONFIRMED until its first input: its entry token takes
// it back, a close refunds it at once, and JOIN_CONFIRM_MS with no input refunds it too.
const test = require('node:test');
const assert = require('node:assert');
const createPaperSockets = require('../server/paperSockets');
const { PaperArenas } = require('../server/paper/PaperArenas');
const { REASON, MP } = require('../server/paper/ArenaGame');
const { isStake } = require('../server/stakeRules');
const paperPayout = require('../server/paperPayout');

function world({ paidEnabled = true } = {}) {
  let t = 1000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const emits = [];
  const io = {
    to: (target) => ({
      emit: (ev, p) => emits.push([target, ev, p]),
      volatile: { emit() {} }
    })
  };
  const spy = { consume: [], storeConsume: [], refunds: [], withdraws: [], cashouts: [] };
  // The real payout module with a fake money layer, so the bound on what landed is the real one.
  const payout = paperPayout.create({
    money: { withdraw: (wallet, amt) => { spy.withdraws.push([wallet, Math.round(amt * 1e6)]); return Promise.resolve('SIG'); }, fiatValue: (x) => x },
    db: { recordEarnings: () => Promise.resolve(), recordFailedPayout: () => Promise.resolve() },
    trackEarning() {},
    sweepRake() {},
    io: null,
    REGION: 'na'
  });
  const hooks = {
    onCashout: (o) => spy.cashouts.push(o),
    onTransfer() {},
    onRefund: (r) => { spy.refunds.push(r); return payout.refund(r); },
    onSweep() {},
    onBreach: (b) => { throw new Error('ledger breach ' + JSON.stringify(b)); }
  };
  const arenas = new PaperArenas({ io, hooks, now: clock.now, paidEnabled, autoTick: false, warm: false });
  const tokens = new Map();
  const take = (token, stake) => {
    stake = Number(stake);
    if (stake === 0) return { ok: true, worth: 0 };
    const tk = typeof token === 'string' && tokens.get(token);
    if (!tk || Math.abs(tk.stake - stake) > 1e-9) return { ok: false, worth: 0 };
    tokens.delete(token);
    return { ok: true, worth: tk.worth, paid: tk.paid, walletAddress: tk.walletAddress };
  };
  const paper = createPaperSockets({
    arenas,
    ops: { get: () => ({ maintenance: false }) },
    socketRL: () => true,
    sanitizeName: (n) => String(n == null ? '' : n).slice(0, 20) || 'Player',
    isStake,
    consumePaidEntryAtStake(token, stake) {
      const r = take(token, stake);
      spy.consume.push([token, stake, r.ok]);
      return r;
    },
    entryStore: {
      consumeAtStake(token, stake) {
        const r = take(token, stake);
        spy.storeConsume.push([token, stake, r.ok]);
        return r;
      }
    },
    payout: { refund: (x) => { spy.refunds.push(x); return payout.refund(x); } },
    paidEnabled
  });
  let tn = 0;
  const mint = (stake, paid = stake, wallet) => {
    const token = 'tok-' + ++tn + '-' + Math.random().toString(36).slice(2);
    tokens.set(token, { stake, worth: stake, paid, walletAddress: wallet || 'WALLET' + tn });
    return token;
  };
  const tick = (room, n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(MP.STEP_MS);
      room.tickOnce();
    }
  };
  return { arenas, paper, spy, mint, clock, tick, emits };
}

let sn = 0;
function sock(w) {
  const s = {
    id: 'jl' + ++sn,
    handlers: {},
    got: [],
    rooms: new Set(),
    on(ev, fn) { this.handlers[ev] = fn; },
    emit(ev, p) { this.got.push([ev, p]); },
    join(r) { this.rooms.add(r); },
    leave(r) { this.rooms.delete(r); },
    fire(ev, p) { this.handlers[ev](p); },
    last(ev) { const g = this.got.filter(x => x[0] === ev); return g.length ? g[g.length - 1][1] : null; },
    all(ev) { return this.got.filter(x => x[0] === ev).map(x => x[1]); }
  };
  w.paper.attach(s);
  return s;
}

function roomAt(w, stake) {
  return w.arenas.all().find(r => r.stake === stake && r.liveHumans > 0) || w.arenas.all().find(r => r.stake === stake);
}

function conserved(room) {
  return room.bank.totalMicro() === room.bank.ledger.inMicro - room.bank.ledger.outMicro;
}

function steer(s, seq = 1) {
  s.fire('pp:in', MP.encodeInput(seq, 0, false));
}

test('a paid seat whose socket closes before its first input is refunded once, bounded by what landed, with no coin', async () => {
  const w = world();
  const a = sock(w);
  a.fire('pp:join', { name: 'ann', stake: 0.1, entryToken: w.mint(0.1, 0.099, 'WANN') });
  const j = a.last('pp:joined');
  assert.ok(j, 'seated');
  const room = roomAt(w, 0.1);
  const unit = room.seats.get(j.you).unit;
  w.paper.drop(a.id); // the link closed before any input: pp:joined may never have arrived
  assert.ok(unit.death, 'the square left at once, nobody flies it');
  assert.strictEqual(room.liveHumans, 0);
  assert.strictEqual(room.bank.pickups().length, 0, 'no coin: the money went back, not on the floor');
  assert.strictEqual(room.bank.totalMicro(), 0);
  assert.ok(conserved(room));
  assert.deepStrictEqual(w.spy.refunds.map(r => [r.wallet, r.micro, r.paid, r.why]), [['WANN', 100000, 0.099, 'join-lost']]);
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(w.spy.withdraws, [['WANN', 99000]], 'what landed on-chain, never the rung');
  // Nothing later pays it again: another close, the deadline, the grace, an hour of ticks.
  w.paper.drop(a.id);
  w.tick(room, Math.ceil((MP.DISCONNECT_GRACE_MS + MP.JOIN_CONFIRM_MS) / MP.STEP_MS) + 5);
  w.clock.advance(MP.PICKUP_SWEEP_MS + 1000);
  w.arenas.sweep(w.clock.now());
  assert.strictEqual(w.spy.refunds.length, 1);
  assert.strictEqual(w.spy.cashouts.length, 0);
});

test('the same token on a new socket takes the unconfirmed seat back: same square, same money, nothing spent twice', () => {
  const w = world();
  const a = sock(w);
  const tok = w.mint(0.1, 0.1, 'WBEN');
  a.fire('pp:join', { name: 'ben', stake: 0.1, entryToken: tok });
  const j = a.last('pp:joined');
  const room = roomAt(w, 0.1);
  const inMicro = room.bank.ledger.inMicro;
  room._socketById = (id) => (id === a.id ? a : null);
  // The server has not yet noticed a's link is dead; the page asks again on its new link.
  const b = sock(w);
  b.fire('pp:join', { name: 'ben', stake: 0.1, entryToken: tok });
  const again = b.last('pp:joined');
  assert.ok(again, 'seated again');
  assert.strictEqual(again.you, j.you, 'the same square');
  assert.strictEqual(again.resumed, false, 'the first pp:joined this player sees');
  assert.strictEqual(again.resumeKey, j.resumeKey);
  assert.ok(a.last('pp:replaced'), 'the dead link is told');
  assert.strictEqual(w.spy.consume.length, 1, 'the token was consumed once, by the first join');
  assert.strictEqual(room.bank.ledger.inMicro, inMicro, 'no second deposit');
  assert.strictEqual(room.bank.balance(j.you), 100000);
  assert.strictEqual(room.liveHumans, 1);
  // The old link's close changes nothing now.
  w.paper.drop(a.id);
  assert.strictEqual(room.liveHumans, 1);
  assert.strictEqual(w.spy.refunds.length, 0);
  // The player steers: confirmed. The token no longer names the seat.
  steer(b);
  const c = sock(w);
  c.fire('pp:join', { name: 'thief', stake: 0.1, entryToken: tok });
  assert.strictEqual(c.last('pp:joined'), null, 'a confirmed seat is never taken by its token');
  assert.strictEqual(c.last('pp:refused').why, 'entry');
  // And a close now follows the owner's normal grace, not a refund.
  w.paper.drop(b.id);
  assert.strictEqual(room.liveHumans, 1, 'in its grace');
  assert.strictEqual(w.spy.refunds.length, 0);
  assert.ok(conserved(room));
});

test('after the refund, the re-sent token and the resumeKey are told so, and nothing more is paid or spent', () => {
  const w = world();
  const a = sock(w);
  const tok = w.mint(1, 1, 'WCAL');
  a.fire('pp:join', { name: 'cal', stake: 1, entryToken: tok });
  const key = a.last('pp:joined').resumeKey;
  w.paper.drop(a.id);
  assert.strictEqual(w.spy.refunds.length, 1);
  const b = sock(w);
  b.fire('pp:join', { name: 'cal', stake: 1, entryToken: tok });
  assert.deepStrictEqual(b.last('pp:refused'), { why: 'join-lost', text: b.last('pp:refused').text, refunded: true });
  assert.match(b.last('pp:refused').text, /refunded/);
  const c = sock(w);
  c.fire('pp:join', { name: 'cal', stake: 1, resumeKey: key });
  assert.strictEqual(c.last('pp:refused').why, 'join-lost');
  assert.strictEqual(c.last('pp:refused').refunded, true);
  assert.strictEqual(w.spy.refunds.length, 1, 'refunded exactly once');
  assert.strictEqual(w.spy.consume.length, 1, 'the token was never consumed again');
  assert.strictEqual(w.spy.storeConsume.length, 0);
  assert.strictEqual(b.last('pp:joined'), null);
  assert.strictEqual(c.last('pp:joined'), null);
});

test('a paid seat with no input for JOIN_CONFIRM_MS is refunded once and its socket is told', () => {
  const w = world();
  const a = sock(w);
  a.fire('pp:join', { name: 'dee', stake: 0.1, entryToken: w.mint(0.1, 0.1, 'WDEE') });
  const room = roomAt(w, 0.1);
  room._socketById = (id) => (id === a.id ? a : null);
  const you = a.last('pp:joined').you;
  const steps = Math.floor(MP.JOIN_CONFIRM_MS / MP.STEP_MS) - 2;
  w.tick(room, steps);
  assert.strictEqual(room.liveHumans, 1, 'not before the deadline');
  assert.strictEqual(w.spy.refunds.length, 0);
  w.tick(room, 4);
  assert.strictEqual(room.liveHumans, 0);
  assert.deepStrictEqual(w.spy.refunds.map(r => [r.wallet, r.micro, r.why]), [['WDEE', 100000, 'join-timeout']]);
  const told = w.emits.filter(e => e[0] === a.id && e[1] === 'pp:refused').map(e => e[2]);
  assert.deepStrictEqual(told, [{ why: 'join-timeout', refunded: true }]);
  assert.strictEqual(a._ppRoom, null);
  assert.ok(!a.rooms.has(room.ioRoom));
  // A late first input changes nothing, and the timer never fires again.
  steer(a);
  w.tick(room, 400);
  assert.strictEqual(w.spy.refunds.length, 1);
  assert.strictEqual(room.bank.balance(you), 0);
  assert.ok(conserved(room));
});

test('an input in time confirms the seat: no deadline, and a close follows the normal grace and coin', () => {
  const w = world();
  const a = sock(w);
  a.fire('pp:join', { name: 'eve', stake: 0.1, entryToken: w.mint(0.1) });
  const room = roomAt(w, 0.1);
  steer(a);
  w.tick(room, Math.ceil(MP.JOIN_CONFIRM_MS / MP.STEP_MS) + 10);
  assert.strictEqual(room.liveHumans, 1);
  w.paper.drop(a.id);
  assert.strictEqual(room.liveHumans, 1, 'in its grace');
  w.tick(room, Math.ceil(MP.DISCONNECT_GRACE_MS / MP.STEP_MS) + 2);
  assert.strictEqual(room.liveHumans, 0);
  assert.strictEqual(w.spy.refunds.length, 0, 'a seat its player steered is not refunded');
  const coins = room.bank.pickups();
  assert.ok(coins.length === 1 && coins[0].micro === 100000 || room.bank.totalMicro() === 0, 'dropped (or collected) by the normal rules');
  assert.ok(conserved(room));
});

test('money won before the first input stays in the arena as a coin; only the buy-in goes back', () => {
  const w = world();
  const a = sock(w);
  a.fire('pp:join', { name: 'fay', stake: 0.1, entryToken: w.mint(0.1, 0.1, 'WFAY') });
  const b = sock(w);
  b.fire('pp:join', { name: 'gus', stake: 0.1, entryToken: w.mint(0.1, 0.1, 'WGUS') });
  steer(b);
  const room = roomAt(w, 0.1);
  const fa = room.seatOfSocket(a.id).unit;
  const gb = room.seatOfSocket(b.id).unit;
  room.game.kill(gb, fa, REASON.TRACK_CUT); // gus ran over fay's trail
  assert.strictEqual(room.bank.balance(fa.id), 200000);
  w.paper.drop(a.id);
  assert.deepStrictEqual(w.spy.refunds.map(r => [r.wallet, r.micro, r.why]), [['WFAY', 100000, 'join-lost']]);
  const coins = room.bank.pickups();
  assert.strictEqual(coins.length, 1);
  assert.strictEqual(coins[0].micro, 100000, "gus's money stays on the floor where fay stood");
  assert.strictEqual(room.bank.totalMicro(), 100000);
  assert.ok(conserved(room));
});

test('a refusal after the token was spent is told again to a re-sent token, never refunded twice', () => {
  const w = world();
  w.arenas.seatFor = () => null; // every table full
  const a = sock(w);
  const tok = w.mint(0.1, 0.1, 'WHAL');
  a.fire('pp:join', { name: 'hal', stake: 0.1, entryToken: tok });
  assert.strictEqual(a.last('pp:refused').why, 'full');
  const b = sock(w);
  b.fire('pp:join', { name: 'hal', stake: 0.1, entryToken: tok });
  assert.strictEqual(b.last('pp:refused').why, 'full');
  assert.strictEqual(b.last('pp:refused').refunded, true);
  assert.strictEqual(w.spy.refunds.length, 1);
  assert.strictEqual(w.spy.storeConsume.length, 1);
});

test('the token of an unconfirmed seat that was killed is refused as expired, with no refund', () => {
  const w = world();
  const a = sock(w);
  const tok = w.mint(0.1);
  a.fire('pp:join', { name: 'ivy', stake: 0.1, entryToken: tok });
  const room = roomAt(w, 0.1);
  room.game.kill(room.seatOfSocket(a.id).unit, undefined, REASON.WALL);
  const b = sock(w);
  b.fire('pp:join', { name: 'ivy', stake: 0.1, entryToken: tok });
  assert.strictEqual(b.last('pp:refused').why, 'expired');
  assert.strictEqual(b.last('pp:refused').refunded, false);
  assert.strictEqual(w.spy.refunds.length, 0);
  assert.strictEqual(w.spy.consume.length, 1);
});

test('free seats are untouched: a close starts the normal grace and nothing is refunded', () => {
  const w = world();
  const a = sock(w);
  a.fire('pp:join', { name: 'joe', stake: 0 });
  const room = roomAt(w, 0);
  w.paper.drop(a.id);
  assert.strictEqual(room.liveHumans, 1, 'in its grace');
  w.tick(room, Math.ceil(MP.JOIN_CONFIRM_MS / MP.STEP_MS) + 5);
  assert.strictEqual(w.spy.refunds.length, 0);
});

test('a hostile token (not a string, huge) names no seat and costs nothing', () => {
  const w = world();
  const a = sock(w);
  a.fire('pp:join', { name: 'kim', stake: 0.1, entryToken: w.mint(0.1) });
  const b = sock(w);
  for (const bad of [{ x: 1 }, 'x'.repeat(100000), 12345, null]) {
    b.fire('pp:join', { name: 'kim', stake: 0.1, entryToken: bad });
    assert.strictEqual(b.last('pp:refused').why, 'entry');
  }
  assert.strictEqual(b.last('pp:joined'), null);
  assert.strictEqual(roomAt(w, 0.1).liveHumans, 1);
});

test('a socket already playing cannot take a second, unconfirmed seat with its token', () => {
  const w = world();
  const a = sock(w);
  a.fire('pp:join', { name: 'lee', stake: 0.1, entryToken: w.mint(0.1) });
  steer(a);
  const b = sock(w);
  const tokB = w.mint(0.1);
  b.fire('pp:join', { name: 'lee2', stake: 0.1, entryToken: tokB });
  const room = roomAt(w, 0.1);
  const seatA = room.seatOfSocket(a.id);
  const seatB = room.seatOfSocket(b.id);
  a.fire('pp:join', { name: 'lee', stake: 0.1, entryToken: tokB });
  assert.ok(room.seatOfSocket(a.id) === seatA, 'a still steers its own seat');
  assert.ok(room.seatOfSocket(b.id) === seatB, 'b keeps its seat');
  assert.strictEqual(a.all('pp:joined').length, 1);
  assert.strictEqual(w.spy.consume.length, 2);
});
