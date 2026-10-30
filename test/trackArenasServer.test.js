'use strict';
// Product analytics of the paid arenas' results (server/ag/agTrack.js through each money controller's optional
// hooks.analytics): one game_ended per paid life at the server's own decision, after its money moved (died,
// cashed_out net of the 10% cut, left, refunded with its stake_refunded, ended), stake_refunded alone for a seat that
// never started, and nothing at all from a controller built without analytics. Driven the way each arena's own money
// tests drive it (agMoney.test.js, chompMoney.test.js, paperRoomMoney.test.js, slMoney.test.js), with the real
// server/analytics.js capturing through _setTransport.
const test = require('node:test');
const assert = require('node:assert');
const analytics = require('../server/analytics');
const agTrack = require('../server/ag/agTrack');
const { AgRoom } = require('../server/ag/agRoom');
const { AG_MONEY } = require('../server/ag/agMoney');
const { FIXTURE: AG_FIXTURE } = require('./agLawsFixture');
const { ChompRoom } = require('../server/chomp/chompRoom');
const R = require('../shared/chompRules');
const { PaperRoom } = require('../server/paper/PaperRoom');
const { REASON, P, MP } = require('../server/paper/ArenaGame');
const { createSlMoney } = require('../server/slPaid/slMoney');

const quiet = { error() {}, warn() {}, log() {} };

// Every event the real analytics module would POST, read back from its batch bodies.
function capture() {
  const got = [];
  analytics._reset();
  analytics._setTransport((body) => { for (const e of JSON.parse(body).batch) got.push(e); });
  const all = () => { analytics.flush(); return got; };
  return {
    all,
    of: (name, wallet) => all().filter((e) => e.event === name && (wallet === undefined || e.distinct_id === wallet))
      .map((e) => e.properties),
  };
}
test.afterEach(() => { analytics._setTransport(null); analytics._reset(); });

let sn = 0;
function sock(id) {
  return {
    id: id || 'ts' + ++sn,
    conn: { writeBuffer: [] },
    rooms: new Set(),
    events: [],
    got: [],
    join(r) { this.rooms.add(r); },
    leave(r) { this.rooms.delete(r); },
    emit(ev, p) { this.events.push([ev, p]); this.got.push([ev, p]); },
    of(ev) { return this.events.filter((e) => e[0] === ev).map((e) => e[1]); },
  };
}

// ---------------------------------------------------------------- paid agar (agMoney), as agMoney.test.js

function agWorld(withAnalytics = true) {
  const clock = { t: 1000000 };
  const calls = { cashout: [], refund: [] };
  const hooks = {
    onCashout: (o) => calls.cashout.push(o),
    onRefund: (o) => calls.refund.push(o),
    onTransfer: () => {}, onFeed: () => {}, onBreach: () => {}, onHouse: () => {},
    // recordEntry's paid game_started (server/index.js), at the seat's ready
    onStake: (s) => analytics.gameStarted({ wallet: s.wallet, game: 'agar', stake: s.worth }),
    onAccountOpen: () => {}, onAccountConfirmed: () => {}, onAccountClosed: () => {},
  };
  if (withAnalytics) hooks.analytics = analytics;
  const r = new AgRoom({ laws: AG_FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: quiet, stake: 0.1,
    moneyHooks: hooks, now: () => clock.t, onSeatless: () => {} });
  return { r, clock, calls };
}

function agJoin(w, name, ready = true) {
  const s = sock(name);
  const acct = w.r.addPaidHuman(s, { name, micro: 100000, wallet: 'W-' + name, paid: 0.1, ip: '' });
  assert.ok(acct && typeof acct === 'object', 'seated: ' + acct);
  if (ready) {
    w.r.tickOnce();
    assert.strictEqual(w.r.ready(s.id), true, name + ' readies');
  }
  return { s, pid: acct.pid, acct };
}

function agCells(r, pid) {
  const info = r.sim.playerInfo(pid);
  return info ? info.cells.map((id) => r.sim.getCell(id)) : [];
}

function smother(r, eater, victim) {
  const v = agCells(r, victim)[0];
  const e = agCells(r, eater)[0];
  e.x = v.x; e.y = v.y; e.size = 300;
  r.sim.setInput(eater, { x: v.x, y: v.y });
  r.sim.setInput(victim, { x: v.x, y: v.y });
}

test('paid agar: died on the last eat, cashed_out net of the cut, left on the dormant cash-out, once per life', () => {
  const cap = capture();
  const w = agWorld();
  const { r, clock } = w;
  const a = agJoin(w, 'a');
  const b = agJoin(w, 'b');
  assert.strictEqual(cap.of('game_started').length, 2, 'recordEntry stand-in: one start per readied seat');
  smother(r, b.pid, a.pid);
  r.tickOnce();
  assert.strictEqual(r.money.account(a.pid), null, 'a was eaten');
  const died = cap.of('game_ended', 'W-a');
  assert.strictEqual(died.length, 1);
  assert.strictEqual(died[0].game, 'agar');
  assert.strictEqual(died[0].result, 'died');
  assert.strictEqual(died[0].amount, 0);
  assert.strictEqual(died[0].stake, 0.1);
  assert.strictEqual(died[0].net, -0.1);
  assert.strictEqual(died[0].paid, true);
  assert.strictEqual(died[0].room, r.lobbyType);
  assert.strictEqual(died[0].reason, 'eaten');
  assert.ok(died[0].duration_s >= 0, 'its start was found');
  // the wallet is the person (distinct_id), never one of the event's own properties
  for (const k of Object.keys(died[0])) {
    if (k !== 'distinct_id') assert.doesNotMatch(String(died[0][k]), /^W-/, 'no wallet in a property: ' + k);
  }

  // b holds 200000 now: a finished hold pays 180000 (90/10)
  r.target(b.s.id, 3000, 3000);
  r.tickOnce();
  assert.ok(r.hold(b.s.id, true));
  for (let i = 0; i < AG_MONEY.HOLD_TICKS.value; i++) r.tickOnce();
  assert.strictEqual(w.calls.cashout.length, 1, 'the money went first');
  const cashed = cap.of('game_ended', 'W-b');
  assert.strictEqual(cashed.length, 1);
  assert.deepStrictEqual([cashed[0].result, cashed[0].amount, cashed[0].net, cashed[0].reason], ['cashed_out', 0.18, 0.08, 'hold']);
  assert.strictEqual(cashed[0].amount, agTrack.cashNet(w.calls.cashout[0].grossMicro));

  // d drops out: grace, dormant, then the server cashes it out to its wallet: 'left' with what that paid
  const d = agJoin(w, 'd');
  r.removeSocket(d.s.id);
  clock.t += AG_MONEY.DISCONNECT_GRACE_MS.value;
  r.tickOnce();
  clock.t += AG_MONEY.DORMANT_SETTLE_MS.value + 1000;
  r.tickOnce();
  const left = cap.of('game_ended', 'W-d');
  assert.strictEqual(left.length, 1);
  assert.deepStrictEqual([left[0].result, left[0].amount, left[0].reason], ['left', 0.09, 'dormant']);

  for (let i = 0; i < 20; i++) r.tickOnce();
  assert.strictEqual(cap.of('game_ended').length, 3, 'no second event for any life');
  assert.strictEqual(cap.of('stake_refunded').length, 0, 'nothing was refunded');
});

test('paid agar: a seat that never readied sends stake_refunded only; an emergency refunds a playing seat (refunded)', () => {
  const cap = capture();
  const w = agWorld();
  const { r } = w;
  const c = agJoin(w, 'c', false);
  r.removeSocket(c.s.id);
  assert.strictEqual(w.calls.refund.length, 1);
  assert.strictEqual(cap.of('game_ended', 'W-c').length, 0, 'it never started');
  const back = cap.of('stake_refunded', 'W-c');
  assert.strictEqual(back.length, 1);
  assert.deepStrictEqual([back[0].game, back[0].stake, back[0].amount, back[0].reason], ['agar', 0.1, 0.1, 'join-lost']);

  const e = agJoin(w, 'e');
  const f = agJoin(w, 'f', false);
  r.emergencyClose();
  const ended = cap.of('game_ended', 'W-e');
  assert.strictEqual(ended.length, 1);
  assert.deepStrictEqual([ended[0].result, ended[0].amount, ended[0].reason], ['refunded', 0.1, 'emergency']);
  assert.strictEqual(cap.of('stake_refunded', 'W-e').length, 1);
  assert.strictEqual(cap.of('game_ended', 'W-f').length, 0, 'never readied: no game_ended');
  assert.strictEqual(cap.of('stake_refunded', 'W-f')[0].amount, 0.1);
  void e; void f;
});

test('paid agar built without hooks.analytics sends nothing (every money test, a dev token)', () => {
  const cap = capture();
  const w = agWorld(false);
  const a = agJoin(w, 'a');
  const b = agJoin(w, 'b');
  smother(w.r, b.pid, a.pid);
  w.r.tickOnce();
  const c = agJoin(w, 'c', false);
  w.r.removeSocket(c.s.id);
  assert.strictEqual(cap.of('game_ended').length, 0);
  assert.strictEqual(cap.of('stake_refunded').length, 0);
});

// ---------------------------------------------------------------- paid Chomp (chompMoney on agMoney), as chompMoney.test.js

test('paid Chomp: a ghost catch is died (amount 0), a hold is cashed_out net of the cut', () => {
  const cap = capture();
  const clock = { t: 5000000 };
  const cashouts = [];
  const hooks = {
    onCashout: (o) => cashouts.push(o), onRefund: () => {}, onTransfer: () => {}, onFeed: () => {}, onBreach: () => {},
    onStake: () => {}, onHouse: () => {}, onOwed: () => {}, onSeedBack: () => {}, onSeedSpent: () => {},
    onSweep: () => {}, onFloor: () => {}, onAccountOpen: () => {}, onAccountConfirmed: () => {},
    onAccountClosed: () => {}, analytics,
  };
  const r = new ChompRoom({ mx: 1, my: 1, seed: 11, stake: 0.5, moneyHooks: hooks, now: () => clock.t, log: quiet });
  r.ghosts = [];
  const step = (n = 1) => { for (let i = 0; i < n; i++) { r.step(); clock.t += 1000 / R.TICK_HZ; } };
  const join = (name) => {
    const s = sock(name);
    const acct = r.addPaidHuman(s, { name, micro: 500000, wallet: 'W-' + name, paid: 0.5 });
    assert.ok(acct && typeof acct === 'object');
    assert.strictEqual(r.ready(s.id), true);
    const p = r.players.get(acct.pid);
    p.safe = 0;
    return { s, acct, p };
  };
  const ann = join('ann');
  r.kill(ann.p, null, { kind: 'blinky' });
  step();
  const died = cap.of('game_ended', 'W-ann');
  assert.strictEqual(died.length, 1);
  assert.deepStrictEqual([died[0].game, died[0].result, died[0].amount, died[0].reason], ['chomp', 'died', 0, 'ghost']);

  const bo = join('bo');
  r.hold(bo.s.id, true);
  for (let i = 0; i < 200 && r.money.account(bo.acct.pid); i++) { r.hold(bo.s.id, true); step(); }
  assert.strictEqual(r.money.account(bo.acct.pid), null, 'cashed out');
  assert.strictEqual(cashouts.length, 1);
  const cashed = cap.of('game_ended', 'W-bo');
  assert.strictEqual(cashed.length, 1);
  assert.deepStrictEqual([cashed[0].game, cashed[0].result, cashed[0].amount], ['chomp', 'cashed_out', 0.45]);
});

// ---------------------------------------------------------------- paid Paper (PaperRoom), as paperRoomMoney.test.js

function paperKit(withAnalytics = true) {
  let t = 5000000;
  const calls = { cashout: [], refund: [] };
  const io = { to: () => ({ emit: () => {}, volatile: { emit: () => {} } }) };
  const hooks = {
    onCashout: (o) => calls.cashout.push(o), onTransfer: () => {}, onRefund: (x) => calls.refund.push(x),
    onSweep: () => {}, onBreach: () => {},
  };
  if (withAnalytics) hooks.analytics = analytics;
  const room = new PaperRoom({ stake: 0.1, io, hooks, now: () => t, autoTick: false, seed: 0.3 });
  room.game.radiusTarget = () => 950;
  room.game.setRadiusNow(950);
  return { room, calls, g: room.game, advance: (ms) => { t += ms; } };
}
const C = 1000;
const at = (rad, a) => new P.Vec2(C + Math.cos(a) * rad, C + Math.sin(a) * rad);
function paperJoin(k, spot, confirm = true) {
  const s = sock();
  const seat = k.room.addHuman(s, { name: s.id, micro: 100000, wallet: 'W' + s.id, spot });
  seat.unit.locked = false;
  if (confirm) k.room._confirm(seat);
  return { s, seat, u: seat.unit, wallet: 'W' + s.id };
}

test('paid Paper: a kill is died, a leave is left, a hold is cashed_out net of the cut, each once', () => {
  const cap = capture();
  const k = paperKit();
  const a = paperJoin(k, at(300, 0.3));
  const b = paperJoin(k, at(300, 1.8));
  const c = paperJoin(k, at(300, 3.3));
  k.g.kill(b.u, a.u, REASON.TRACK_CUT);
  const died = cap.of('game_ended', b.wallet);
  assert.strictEqual(died.length, 1);
  assert.deepStrictEqual([died[0].game, died[0].result, died[0].amount, died[0].stake, died[0].reason],
    ['paper', 'died', 0, 0.1, 'track_cut']);
  k.room.removeHuman(c.u.id, REASON.LEAVE);
  const left = cap.of('game_ended', c.wallet);
  assert.strictEqual(left.length, 1);
  assert.deepStrictEqual([left[0].result, left[0].amount, left[0].reason], ['left', 0, 'leave']);
  k.room.completeCashout(a.u);
  assert.strictEqual(k.calls.cashout.length, 1, 'the money went first');
  const cashed = cap.of('game_ended', a.wallet);
  assert.strictEqual(cashed.length, 1);
  assert.deepStrictEqual([cashed[0].result, cashed[0].amount, cashed[0].reason], ['cashed_out', 0.09, 'hold']);
  assert.strictEqual(cap.of('game_ended').length, 3);
});

test('paid Paper: an unsteered seat released is stake_refunded only; the emergency close ends a playing seat once', () => {
  const cap = capture();
  const k = paperKit();
  const u = paperJoin(k, at(300, 0.3), false);
  k.room.releaseUnconfirmed(u.seat, 'join-lost');
  assert.strictEqual(k.calls.refund.length, 1);
  assert.strictEqual(cap.of('game_ended', u.wallet).length, 0, 'it never started');
  assert.deepStrictEqual(cap.of('stake_refunded', u.wallet).map((p) => [p.game, p.amount, p.reason]), [['paper', 0.1, 'join-lost']]);
  const a = paperJoin(k, at(300, 1.8));
  k.room.emergencyClose();
  const ended = cap.of('game_ended', a.wallet);
  assert.strictEqual(ended.length, 1);
  assert.deepStrictEqual([ended[0].result, ended[0].amount, ended[0].reason], ['ended', 0.09, 'emergency']);
});

test('a free Paper arena, and a paid one built without hooks.analytics, send nothing', () => {
  const cap = capture();
  const k = paperKit(false);
  const a = paperJoin(k, at(300, 0.3));
  const b = paperJoin(k, at(300, 1.8));
  k.g.kill(b.u, a.u, REASON.TRACK_CUT);
  k.room.completeCashout(a.u);
  let t = 0;
  const free = new PaperRoom({ stake: 0, io: { to: () => ({ emit: () => {}, volatile: { emit: () => {} } }) },
    hooks: { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {}, analytics },
    now: () => t, autoTick: false, seed: 0.3 });
  const s = sock();
  const seat = free.addHuman(s, { name: 'x', micro: 0, wallet: 'Wfree', spot: at(300, 0.3) });
  free.removeHuman(seat.unit.id, REASON.LEAVE);
  assert.strictEqual(cap.all().length, 0);
  void MP;
});

// ---------------------------------------------------------------- paid slither (slMoney), as slMoney.test.js

function slSpy() {
  const calls = [];
  const hook = (name) => (...a) => { calls.push([name].concat(a)); };
  const hooks = {
    onCashout: hook('onCashout'), onOwed: hook('onOwed'), onFloor: hook('onFloor'), onHouse: hook('onHouse'),
    onBreach: hook('onBreach'), onTransfer: hook('onTransfer'), onAccountOpen: () => {}, onAccountClosed: () => {},
    journal: { open: () => true, close: () => true, floor: () => true },
    analytics,
  };
  return { hooks, calls };
}
let un = 0;
const uuid = () => '00000000-0000-4000-8000-' + String(++un).padStart(12, '0');
const jidOf = (n) => 'a0000000-0000-4000-8000-' + String(n).padStart(12, '0');
const slEntry = (n) => ({ jid: jidOf(n), micro: 500000, wallet: 'W' + n, name: 'p' + n, paid: 0.5 });
let foodN = 1;
const slDrops = (n) => Array.from({ length: n }, () => ({ food: { id: foodN++, x: 100, y: 100, b: 70, nat: false } }));

test('paid slither: a death is died, a glide that ran out is left, a hold is cashed_out net, an emergency refunded', () => {
  const cap = capture();
  const s = slSpy();
  const m = createSlMoney({ stake: 0.5, label: 'sl_na_s0_5', hooks: s.hooks, uuid, log: quiet, now: () => 1000, checkEvery: 1 });
  m.open(1, slEntry(1));
  m.open(2, slEntry(2));
  m.open(3, slEntry(3));
  m.open(4, slEntry(4));
  m.applyFacts({ tick: 1, deaths: [{ id: 1, cause: 'snake', killer: 3, drops: slDrops(4) },
    { id: 2, cause: 'kill', killer: 0, drops: slDrops(4) }] }, []);
  const died = cap.of('game_ended', 'W1');
  assert.strictEqual(died.length, 1);
  assert.deepStrictEqual([died[0].game, died[0].result, died[0].amount, died[0].stake, died[0].reason, died[0].room],
    ['slither', 'died', 0, 0.5, 'snake', 'sl_na_s0_5']);
  assert.deepStrictEqual(cap.of('game_ended', 'W2').map((p) => [p.result, p.reason]), [['left', 'disconnect']]);
  const o = m.cashOut(3, 'sock-3');
  assert.strictEqual(s.calls.filter((c) => c[0] === 'onCashout').length, 1, 'the order went out first');
  const cashed = cap.of('game_ended', 'W3');
  assert.strictEqual(cashed.length, 1);
  assert.deepStrictEqual([cashed[0].result, cashed[0].amount], ['cashed_out', o.net / 1e6]);
  assert.strictEqual(cashed[0].amount, 0.45);
  m.emergencySettle();
  const refunded = cap.of('game_ended', 'W4');
  assert.deepStrictEqual(refunded.map((p) => [p.result, p.amount, p.reason]), [['refunded', 0.5, 'emergency']]);
  assert.deepStrictEqual(cap.of('stake_refunded', 'W4').map((p) => [p.game, p.amount]), [['slither', 0.5]]);
  assert.strictEqual(cap.of('game_ended').length, 4, 'one per account');
});

// ---------------------------------------------------------------- the shared helper and the doors

test('agTrack: cashNet is paperPayout\'s 90/10 integers; a door refund is capped at what landed; nothing throws', () => {
  assert.strictEqual(agTrack.cashNet(100000), 0.09);
  assert.strictEqual(agTrack.cashNet(123457), (123457 - 12345) / 1e6);
  assert.strictEqual(agTrack.cashNet(0), 0);
  assert.strictEqual(agTrack.cashNet('x'), 0);
  const cap = capture();
  assert.strictEqual(agTrack.doorRefunded(analytics, 'agar', { walletAddress: 'Wd', worth: 0.5, paid: 0.48 }, 'full'), true);
  assert.deepStrictEqual(cap.of('stake_refunded', 'Wd').map((p) => [p.game, p.stake, p.amount, p.reason]),
    [['agar', 0.5, 0.48, 'full']]);
  assert.strictEqual(agTrack.doorRefunded(null, 'agar', { walletAddress: 'Wd', worth: 0.5 }, 'full'), false);
  assert.strictEqual(agTrack.doorRefunded(analytics, 'agar', null, 'full'), false);
  const boom = { gameEnded() { throw new Error('x'); }, track() { throw new Error('x'); } };
  assert.strictEqual(agTrack.ended(boom, { wallet: 'W' }), false);
  assert.strictEqual(agTrack.refunded(boom, 'W', { amount: 1 }), false);
});

test('the agar door: a spent token it refuses (maintenance) sends stake_refunded once, after the refund went out', () => {
  const cap = capture();
  const { createAgPaidDoor } = require('../server/ag/agPaidDoor');
  const order = [];
  const door = createAgPaidDoor({
    arenas: { paidRoomOf: () => null, seatByProof: () => null, outcomeOf: () => null, rememberOutcome() {}, stopping: false },
    consumeAtStake: () => ({ ok: true, worth: 0.5, paid: 0.5, walletAddress: 'Wdoor' }),
    refund: () => { order.push('refund'); return Promise.resolve('sig'); },
    ops: { get: () => ({ maintenance: true }) },
    cleanName: (n) => String(n || ''),
    analytics: { track: (...a) => { order.push('track'); return analytics.track(...a); } },
    log: quiet,
  });
  const s = sock();
  door.join(s, { entryToken: 'tok', stake: 0.5, name: 'x' });
  assert.deepStrictEqual(order, ['refund', 'track']);
  assert.deepStrictEqual(cap.of('stake_refunded', 'Wdoor').map((p) => [p.game, p.stake, p.amount, p.reason]),
    [['agar', 0.5, 0.5, 'maintenance']]);
  assert.strictEqual(cap.of('game_ended').length, 0, 'a door refund never started a game');
});
