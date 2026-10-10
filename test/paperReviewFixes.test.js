'use strict';
// Night queue item 5, the CONFIRMED money findings of the adversarial review, Paper side. Each
// test reproduces a finding's scenario against the real paperSockets, PaperArenas, PaperRoom and
// paperPayout (only the money layer is fake) and fails on the code before its fix.
const test = require('node:test');
const assert = require('node:assert');
const createPaperSockets = require('../server/paperSockets');
const { PaperArenas, RELEASE_MAX, RELEASE_WINDOW_MS } = require('../server/paper/PaperArenas');
const { REASON, MP } = require('../server/paper/ArenaGame');
const { isStake } = require('../server/stakeRules');
const { makeEntryStore } = require('../server/entryStore');
const paperPayout = require('../server/paperPayout');

// The real entry store (the one index.js uses), bound to Paper's door as index.js binds it.
function world({ paidEnabled = true } = {}) {
  let t = 1000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const emits = [];
  const io = {
    to: (target) => ({ emit: (ev, p) => emits.push([target, ev, p]), volatile: { emit() {} } })
  };
  const spy = { refunds: [], withdraws: [], cashouts: [], rake: [], stakes: [] };
  const payout = paperPayout.create({
    money: { withdraw: (wallet, amt) => { spy.withdraws.push([wallet, Math.round(amt * 1e6)]); return Promise.resolve('SIG'); }, fiatValue: (x) => x },
    db: { recordEarnings: () => Promise.resolve(), recordFailedPayout: () => Promise.resolve() },
    trackEarning() {},
    sweepRake: (amt) => spy.rake.push(Math.round(amt * 1e6)),
    io: null,
    REGION: 'na'
  });
  const hooks = {
    onCashout: (o) => { spy.cashouts.push(o); return payout.payCashout(o); },
    onTransfer() {},
    onRefund: (r) => { spy.refunds.push(r); return payout.refund(r); },
    onSweep() {},
    onBreach: (b) => { if (b.kind !== 'emergency') throw new Error('ledger breach ' + JSON.stringify(b)); },
    onStake: (s) => spy.stakes.push([s.wallet, s.worth])
  };
  const arenas = new PaperArenas({ io, hooks, now: clock.now, paidEnabled, autoTick: false, warm: false });
  const store = makeEntryStore({ ttlMs: 5 * 60 * 1000, isStake, now: clock.now });
  const door = { consumeAtStake: (token, stake) => store.consumeAtStake(token, stake, 'paper') };
  const paper = createPaperSockets({
    arenas,
    ops: { get: () => ({ maintenance: false }) },
    socketRL: () => true,
    sanitizeName: (n) => String(n == null ? '' : n).slice(0, 20) || 'Player',
    isStake,
    consumePaidEntryAtStake: door.consumeAtStake, // index.js: Paper's door writes no stake row
    entryStore: door,
    payout: { refund: (x) => { spy.refunds.push(x); return payout.refund(x); } },
    paidEnabled
  });
  let n = 0;
  const mint = (stake, paid = stake, wallet) => store.mint({ stake, worth: stake, paid, walletAddress: wallet || 'W' + ++n });
  const tick = (room, k = 1) => {
    for (let i = 0; i < k; i++) {
      clock.advance(MP.STEP_MS);
      room.tickOnce();
    }
  };
  return { arenas, paper, spy, mint, clock, tick, emits, store };
}

let sn = 0;
function sock(w) {
  const s = {
    id: 'rv' + ++sn,
    handlers: {},
    got: [],
    rooms: new Set(),
    on(ev, fn) { this.handlers[ev] = fn; },
    emit(ev, p) { this.got.push([ev, p]); },
    join(r) { this.rooms.add(r); },
    leave(r) { this.rooms.delete(r); },
    fire(ev, p) { this.handlers[ev](p); },
    last(ev) { const g = this.got.filter(x => x[0] === ev); return g.length ? g[g.length - 1][1] : null; }
  };
  w.paper.attach(s);
  return s;
}

const steer = (s, seq = 1, hold = false) => s.fire('pp:in', MP.encodeInput(seq, 0, hold));
const seatOf = (w, wallet) => {
  for (const r of w.arenas.all()) for (const s of r.seats.values()) if (s.wallet === wallet) return s;
  return null;
};
const conserved = (room) => room.bank.totalMicro() === room.bank.ledger.inMicro - room.bank.ledger.outMicro;
const settle = () => new Promise(r => setImmediate(r));

// ---- Finding 1: an off-rung stake with no token set the stake of the rung's arena ----------------

test('a no-token join at an off-rung stake is refused bad-stake and creates or relabels no arena', () => {
  const w = world();
  const before = w.arenas.all().map(r => [r.stake, r.lobbyType]);
  for (const stake of [0.10499, 1.00499, 0.1049, 0.004, 0.0049, 0.105, 1.004]) {
    const s = sock(w);
    s.fire('pp:join', { name: 'x', stake });
    assert.strictEqual(s.last('pp:refused').why, 'bad-stake', String(stake));
  }
  assert.deepStrictEqual(w.arenas.all().map(r => [r.stake, r.lobbyType]), before, 'no arena was opened');
  // The directory itself never builds a room from a message's number either.
  assert.strictEqual(w.arenas.seatFor(0.10499), null);
  assert.strictEqual(w.arenas.seatFor(0.004), null);
  assert.deepStrictEqual(w.arenas.all().map(r => r.stake), before.map(b => b[0]));
});

test('honest $0.50 and $1 players after an off-rung probe get the exact rung, and Play again and a new link work', async () => {
  const w = world();
  sock(w).fire('pp:join', { name: 'probe', stake: 0.10499 });
  sock(w).fire('pp:join', { name: 'probe', stake: 1.00499 });
  for (const rung of [0.5, 1]) {
    const a = sock(w);
    a.fire('pp:join', { name: 'hon', stake: rung, entryToken: w.mint(rung, rung, 'WH' + rung) });
    const j = a.last('pp:joined');
    assert.ok(j, 'seated at ' + rung);
    assert.strictEqual(j.stake, rung, 'pp:joined says the rung itself');
    const room = w.arenas.all().find(r => r.stake === rung && r.liveHumans > 0);
    assert.strictEqual(room.lobbyType, 'paper_na_' + (rung === 1 ? 's1' : 's0_5'));
    steer(a);
    // Reconnect by resumeKey: the socket's stake is the rung, so a respawn token for it is taken.
    w.paper.drop(a.id);
    const b = sock(w);
    b.fire('pp:join', { name: 'hon', stake: rung, resumeKey: j.resumeKey });
    assert.ok(b.last('pp:joined'), 'resumed');
    room.game.kill(room.seatOfSocket(b.id).unit, undefined, REASON.WALL);
    const again = w.mint(rung, rung, 'WH' + rung);
    b.fire('pp:respawn', { name: 'hon', entryToken: again });
    assert.strictEqual(b.last('pp:refused'), null, 'the Play again token for the rung is accepted');
    assert.strictEqual(b.got.filter(x => x[0] === 'pp:joined').length, 2);
  }
  await settle();
});

// ---- Finding 2: a real token offered while paid tables are shut was never refunded -------------------

test('a real token at a shut paid table is refunded what landed, once, and a re-send is told so', async () => {
  const w = world({ paidEnabled: false });
  const a = sock(w);
  const tok = w.mint(1, 1, 'WSHUT');
  a.fire('pp:join', { name: 'sam', stake: 1, entryToken: tok });
  assert.deepStrictEqual(a.last('pp:refused'), { why: 'not-open', text: a.last('pp:refused').text, refunded: true });
  assert.strictEqual(w.store.size, 0, 'the token was spent by the refund, not left to expire');
  await settle();
  assert.deepStrictEqual(w.spy.withdraws, [['WSHUT', 1000000]]);
  const b = sock(w);
  b.fire('pp:join', { name: 'sam', stake: 1, entryToken: tok });
  assert.strictEqual(b.last('pp:refused').why, 'not-open');
  assert.strictEqual(b.last('pp:refused').refunded, true);
  // No token at all: nothing to refund, nothing claimed.
  const c = sock(w);
  c.fire('pp:join', { name: 'x', stake: 0.5 });
  assert.deepStrictEqual([c.last('pp:refused').why, c.last('pp:refused').refunded], ['not-open', false]);
  await settle();
  assert.strictEqual(w.spy.withdraws.length, 1, 'refunded exactly once');
});

// ---- Finding 4: an emergency close cashed out an unconfirmed seat at 90/10 -----------------------------

test('an emergency close refunds an unconfirmed paid seat in full (bounded by what landed) and says so', async () => {
  const w = world();
  const a = sock(w);
  const tok = w.mint(0.5, 0.495, 'WANN');
  a.fire('pp:join', { name: 'ann', stake: 0.5, entryToken: tok });
  const key = a.last('pp:joined').resumeKey;
  const b = sock(w);
  b.fire('pp:join', { name: 'bob', stake: 0.5, entryToken: w.mint(0.5, 0.5, 'WBOB') });
  steer(b); // bob played: his seat is cashed out at 90/10 as design 5.9 says
  const room = w.arenas.all().find(r => r.stake === 0.5 && r.liveHumans === 2);
  room.game.update = () => { throw new Error('boom'); };
  for (let i = 0; i < MP.EMERGENCY_FAIL_TICKS; i++) { w.clock.advance(MP.STEP_MS); room.tickOnce(); }
  assert.ok(room.closed && room.stopped);
  assert.deepStrictEqual(w.spy.refunds.map(r => [r.wallet, r.micro, r.paid, r.why]), [['WANN', 500000, 0.495, 'emergency']]);
  assert.deepStrictEqual(w.spy.cashouts.map(o => [o.wallet, o.grossMicro]), [['WBOB', 500000]], 'only the seat that played pays the cut');
  assert.deepStrictEqual(w.spy.rake, [50000]);
  await settle();
  assert.deepStrictEqual(w.spy.withdraws.sort(), [['WANN', 495000], ['WBOB', 450000]]);
  assert.ok(conserved(room));
  assert.ok(w.emits.some(e => e[0] === a.id && e[1] === 'pp:refused' && e[2].why === 'emergency' && e[2].refunded === true), 'the open socket is told');
  // The re-sent token and the resumeKey hear the truth: refunded, not "dropped where you stood".
  const c = sock(w);
  c.fire('pp:join', { name: 'ann', stake: 0.5, entryToken: tok });
  assert.deepStrictEqual([c.last('pp:refused').why, c.last('pp:refused').refunded], ['emergency', true]);
  assert.match(c.last('pp:refused').text, /refunded/);
  const d = sock(w);
  d.fire('pp:join', { name: 'ann', stake: 0.5, resumeKey: key });
  assert.deepStrictEqual([d.last('pp:refused').why, d.last('pp:refused').refunded], ['emergency', true]);
  assert.strictEqual(w.spy.refunds.length, 1, 'refunded once');
});

// ---- Finding 6: a reconnect after a completed cash-out (or a kill) was told its money dropped --------

test('a reconnect after the hold finished on a dead link is told it cashed out, with the real amounts', () => {
  const w = world();
  const a = sock(w);
  a.fire('pp:join', { name: 'wal', stake: 0.5, entryToken: w.mint(0.5, 0.5, 'WAL1') });
  const key = a.last('pp:joined').resumeKey;
  const room = w.arenas.all().find(r => r.stake === 0.5 && r.liveHumans > 0);
  let seq = 0;
  // Q held; the link dies in the last 500 ms but the inputs are still fresh, so the hold ends.
  for (let i = 0; i < MP.HOLD_TICKS - 25; i++) { steer(a, ++seq & 255, true); w.clock.advance(MP.STEP_MS); room.tickOnce(); }
  w.tick(room, 40);
  assert.deepStrictEqual(w.spy.cashouts.map(o => [o.wallet, o.grossMicro]), [['WAL1', 500000]]);
  w.paper.drop(a.id);
  const b = sock(w);
  b.fire('pp:join', { name: 'wal', stake: 0.5, resumeKey: key });
  assert.strictEqual(b.last('pp:refused'), null, 'not told "expired"');
  const c = b.last('pp:cashedout');
  assert.ok(c, 'told it cashed out');
  assert.deepStrictEqual([c.grossMicro, c.cutMicro, c.netMicro], [500000, 50000, 450000]);
  assert.strictEqual(c.cashoutId, w.spy.cashouts[0].cashoutId);
  assert.strictEqual(w.spy.cashouts.length, 1, 'telling it pays nothing again');
});

test('a reconnect after being cut during the grace is told who took the money, and a plain drop is still "expired"', () => {
  const w = world();
  const a = sock(w);
  a.fire('pp:join', { name: 'ada', stake: 1, entryToken: w.mint(1, 1, 'WADA') });
  const keyA = a.last('pp:joined').resumeKey;
  const b = sock(w);
  b.fire('pp:join', { name: 'kai', stake: 1, entryToken: w.mint(1, 1, 'WKAI') });
  steer(a);
  steer(b);
  const room = w.arenas.all().find(r => r.stake === 1 && r.liveHumans === 2);
  w.paper.drop(a.id); // ada's link drops: her square is in its grace
  room.game.kill(seatOf(w, 'WADA').unit, seatOf(w, 'WKAI').unit, REASON.TRACK_CUT);
  assert.strictEqual(room.bank.balance(seatOf(w, 'WKAI').unit.id), 2000000, 'kai took the money');
  const c = sock(w);
  c.fire('pp:join', { name: 'ada', stake: 1, resumeKey: keyA });
  assert.strictEqual(c.last('pp:refused').why, 'killed');
  assert.doesNotMatch(c.last('pp:refused').text, /dropped/);
  // Cut before its first input: the re-sent token hears the same, not "expired".
  const f = sock(w);
  const tokF = w.mint(1, 1, 'WFLO');
  f.fire('pp:join', { name: 'flo', stake: 1, entryToken: tokF });
  room.game.kill(seatOf(w, 'WFLO').unit, seatOf(w, 'WKAI').unit, REASON.TRACK_CUT);
  const g = sock(w);
  g.fire('pp:join', { name: 'flo', stake: 1, entryToken: tokF });
  assert.deepStrictEqual([g.last('pp:refused').why, g.last('pp:refused').refunded], ['killed', false]);
  // A square whose money really dropped (no killer) still hears "expired".
  const d = sock(w);
  d.fire('pp:join', { name: 'dan', stake: 1, entryToken: w.mint(1, 1, 'WDAN') });
  steer(d);
  const keyD = d.last('pp:joined').resumeKey;
  w.paper.drop(d.id);
  const dan = seatOf(w, 'WDAN');
  dan.room.game.kill(dan.unit, undefined, REASON.WALL);
  const e = sock(w);
  e.fire('pp:join', { name: 'dan', stake: 1, resumeKey: keyD });
  assert.strictEqual(e.last('pp:refused').why, 'expired');
});

// ---- Finding 8: the unconfirmed seat was a free option with no limit -----------------------------------

test('after RELEASE_MAX unconfirmed refunds a wallet is paused (refunded in full), others are not, and it lifts', async () => {
  const w = world();
  for (let i = 0; i < RELEASE_MAX; i++) {
    const s = sock(w);
    s.fire('pp:join', { name: 'opt', stake: 1, entryToken: w.mint(1, 1, 'WOPT') });
    assert.ok(s.last('pp:joined'));
    w.paper.drop(s.id); // join-lost: refunded
  }
  assert.strictEqual(w.spy.refunds.length, RELEASE_MAX);
  const s = sock(w);
  const tok = w.mint(1, 0.995, 'WOPT');
  s.fire('pp:join', { name: 'opt', stake: 1, entryToken: tok });
  assert.strictEqual(s.last('pp:joined'), null, 'not seated');
  assert.deepStrictEqual([s.last('pp:refused').why, s.last('pp:refused').refunded], ['cooldown', true]);
  assert.deepStrictEqual(w.spy.refunds.slice(-1).map(r => [r.wallet, r.micro, r.paid, r.why]), [['WOPT', 1000000, 0.995, 'cooldown']]);
  await settle();
  assert.deepStrictEqual(w.spy.withdraws.slice(-1), [['WOPT', 995000]], 'what landed, never the rung');
  // A re-send of that token hears the same answer and is not paid twice.
  const s2 = sock(w);
  s2.fire('pp:join', { name: 'opt', stake: 1, entryToken: tok });
  assert.strictEqual(s2.last('pp:refused').why, 'cooldown');
  assert.strictEqual(w.spy.refunds.length, RELEASE_MAX + 1);
  // Another wallet plays normally.
  const o = sock(w);
  o.fire('pp:join', { name: 'oth', stake: 1, entryToken: w.mint(1, 1, 'WOTHER') });
  assert.ok(o.last('pp:joined'));
  // The pause lifts once the window has passed.
  w.clock.advance(RELEASE_WINDOW_MS + 1);
  const late = sock(w);
  late.fire('pp:join', { name: 'opt', stake: 1, entryToken: w.mint(1, 1, 'WOPT') });
  assert.ok(late.last('pp:joined'), 'seated again after the window');
});

test('a server-caused refund (emergency close) or a kill before the first input does not count toward the pause', () => {
  const w = world();
  for (let i = 0; i < RELEASE_MAX + 1; i++) {
    const s = sock(w);
    s.fire('pp:join', { name: 'k', stake: 0.5, entryToken: w.mint(0.5, 0.5, 'WK') });
    assert.ok(s.last('pp:joined'), 'seated after ' + i + ' kills');
    const seat = seatOf(w, 'WK');
    seat.room.game.kill(seat.unit, undefined, REASON.WALL);
  }
  for (let i = 0; i < RELEASE_MAX + 1; i++) {
    const s = sock(w);
    s.fire('pp:join', { name: 'e', stake: 1, entryToken: w.mint(1, 1, 'WE') });
    assert.ok(s.last('pp:joined'), 'seated after ' + i + ' emergency closes');
    const room = seatOf(w, 'WE').room;
    room.game.update = () => { throw new Error('boom'); };
    for (let k = 0; k < MP.EMERGENCY_FAIL_TICKS; k++) { w.clock.advance(MP.STEP_MS); room.tickOnce(); }
  }
  assert.strictEqual(w.spy.refunds.filter(r => r.why === 'emergency').length, RELEASE_MAX + 1);
});

// ---- Finding 13: refunded seats kept a buy-in row --------------------------------------------------

test('the buy-in row is written once when a paid seat is first steered, never for a seat refunded before that', () => {
  const w = world();
  const a = sock(w);
  a.fire('pp:join', { name: 'lost', stake: 1, entryToken: w.mint(1, 1, 'WLOST') });
  w.paper.drop(a.id); // join-lost
  const b = sock(w);
  b.fire('pp:join', { name: 'slow', stake: 0.5, entryToken: w.mint(0.5, 0.5, 'WSLOW') });
  const room = w.arenas.all().find(r => r.seatOfSocket(b.id));
  w.tick(room, Math.ceil(MP.JOIN_CONFIRM_MS / MP.STEP_MS) + 2); // join-timeout
  assert.strictEqual(w.spy.refunds.length, 2);
  assert.deepStrictEqual(w.spy.stakes, [], 'no buy-in row for money that went back');
  const c = sock(w);
  c.fire('pp:join', { name: 'play', stake: 1, entryToken: w.mint(1, 1, 'WPLAY') });
  steer(c, 1);
  steer(c, 2);
  const key = c.last('pp:joined').resumeKey;
  w.paper.drop(c.id);
  const d = sock(w);
  d.fire('pp:join', { name: 'play', stake: 1, resumeKey: key }); // a resume does not write another
  steer(d, 3);
  assert.deepStrictEqual(w.spy.stakes, [['WPLAY', 1]]);
  // A free seat never writes one.
  const f = sock(w);
  f.fire('pp:join', { name: 'free', stake: 0 });
  steer(f);
  assert.deepStrictEqual(w.spy.stakes, [['WPLAY', 1]]);
});
