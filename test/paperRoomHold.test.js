'use strict';
// The cash-out hold (T7, design 5.4): counted in whole sim ticks, death wins a same-tick tie,
// stale input and disconnects cancel, and the order is dispatched exactly once.
const test = require('node:test');
const assert = require('node:assert');
const { PaperRoom } = require('../server/paper/PaperRoom');
const { REASON, P, MP } = require('../server/paper/ArenaGame');

const C = 1000;
const at = (r, a) => new P.Vec2(C + Math.cos(a) * r, C + Math.sin(a) * r);

function kit(stake = 0.1) {
  let t = 1000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const calls = { cashout: [], transfer: [] };
  const emits = [];
  const io = { to: (id) => ({ emit: (ev, p) => emits.push([id, ev, p]), volatile: { emit() {} } }) };
  const hooks = {
    onCashout: (o) => calls.cashout.push(o),
    onTransfer: (x) => calls.transfer.push(x),
    onRefund() {},
    onSweep() {},
    onBreach() {}
  };
  const room = new PaperRoom({ stake, io, hooks, now: clock.now, autoTick: false, seed: 0.2 });
  room.game.radiusTarget = () => 950;
  room.game.setRadiusNow(950);
  return { room, clock, calls, emits, g: room.game, bank: room.bank };
}

let n = 0;
function sock() {
  return { id: 'h' + ++n, got: [], join() {}, leave() {}, emit(ev, p) { this.got.push([ev, p]); } };
}

function seat(k, spot, micro = 100000) {
  const s = sock();
  const st = k.room.addHuman(s, { name: s.id, micro, wallet: 'W' + s.id, spot });
  return { s, seat: st, u: st.unit, seq: 0 };
}

// One tick with this player's input (hold bit and angle).
function play(k, p, hold, angle = 20) {
  p.seq = (p.seq + 1) & 255;
  k.room.setInput(p.s.id, MP.encodeInput(p.seq, angle, hold));
  k.clock.advance(MP.STEP_MS);
  k.room.tickOnce();
}

test('a room with a missing hook throws at construction', () => {
  for (const missing of ['onCashout', 'onTransfer', 'onRefund', 'onSweep', 'onBreach']) {
    const hooks = { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {} };
    delete hooks[missing];
    assert.throws(() => new PaperRoom({ stake: 0.1, hooks, autoTick: false }), new RegExp(missing));
  }
});

test('the hold locks movement and clearing the bit restores steering', () => {
  const k = kit();
  const p = seat(k, at(300, 1.0));
  play(k, p, false);
  play(k, p, true);
  assert.ok(p.u.locked);
  const p0 = p.u.position.clone();
  for (let i = 0; i < 30; i++) play(k, p, true);
  assert.strictEqual(p.u.position.distance(p0).toFixed(3), '0.000');
  play(k, p, false);
  assert.strictEqual(p.u.locked, false);
  for (let i = 0; i < 10; i++) play(k, p, false);
  assert.ok(p.u.position.distance(p0) > 10);
});

test('HOLD_TICKS - 1 ticks pays nothing; HOLD_TICKS ticks pays exactly once, account closed, square gone', () => {
  const k = kit();
  const p = seat(k, at(300, 1.0));
  const other = seat(k, at(300, 4.0));
  for (let i = 0; i < MP.HOLD_TICKS - 1; i++) play(k, p, true);
  assert.strictEqual(k.calls.cashout.length, 0);
  assert.ok(!p.u.death);
  assert.strictEqual(p.u.holdTicks, MP.HOLD_TICKS - 1);
  play(k, p, true);
  assert.strictEqual(k.calls.cashout.length, 1);
  const o = k.calls.cashout[0];
  assert.strictEqual(o.grossMicro, 100000);
  assert.strictEqual(o.wallet, 'W' + p.s.id);
  assert.strictEqual(o.socketId, p.s.id);
  assert.ok(/^[0-9a-f-]{36}$/.test(o.cashoutId));
  assert.strictEqual(k.bank.isOpen(p.u.id), false, 'the account closed before dispatch');
  assert.ok(p.u.death);
  assert.strictEqual(k.room.liveHumans, 1);
  for (let i = 0; i < 20; i++) play(k, other, false);
  assert.strictEqual(k.calls.cashout.length, 1, 'the receipt is single');
});

test('killed on the completing tick pays the KILLER, not the holder', () => {
  const k = kit();
  const p = seat(k, at(300, 1.0));
  const killer = seat(k, at(300, 4.0));
  for (let i = 0; i < MP.HOLD_TICKS - 1; i++) play(k, p, true);
  const move = k.g.handleUnitMovements.bind(k.g);
  k.g.handleUnitMovements = function (dt) {
    this.handleUnitMovements = move;
    this.kill(p.u, killer.u, REASON.TRACK_CUT); // inside super.update, before the holds
    return move(dt);
  };
  play(k, p, true);
  assert.strictEqual(k.calls.cashout.length, 0);
  assert.strictEqual(k.bank.balance(killer.u.id), 200000);
});

test('die mid-hold, respawn: the new life has no hold', () => {
  const k = kit();
  const p = seat(k, at(300, 1.0));
  for (let i = 0; i < 100; i++) play(k, p, true);
  k.g.kill(p.u, undefined, REASON.SELF_CROSS);
  const again = seat(k, at(300, 2.5));
  assert.strictEqual(again.u.holdTicks, 0);
  assert.strictEqual(again.u.locked, false);
  for (let i = 0; i < MP.HOLD_TICKS - 100; i++) play(k, again, false);
  assert.strictEqual(k.calls.cashout.length, 0);
});

test('input stale for HOLD_INPUT_STALE_MS cancels the hold', () => {
  const k = kit();
  const p = seat(k, at(300, 1.0));
  for (let i = 0; i < 20; i++) play(k, p, true);
  assert.ok(p.u.locked);
  const ticks = Math.ceil((MP.HOLD_INPUT_STALE_MS + 20) / MP.STEP_MS);
  for (let i = 0; i < ticks; i++) { k.clock.advance(MP.STEP_MS); k.room.tickOnce(); }
  assert.strictEqual(p.u.locked, false);
  assert.strictEqual(p.u.holdTicks, 0);
  assert.strictEqual(k.calls.cashout.length, 0);
});

test('a disconnect mid-hold cancels it and a resume does not restore it', () => {
  const k = kit();
  const p = seat(k, at(300, 1.0));
  for (let i = 0; i < 90; i++) play(k, p, true);
  k.room.beginGrace(p.seat);
  assert.strictEqual(p.u.locked, false);
  const s2 = sock();
  k.room.resume(s2, p.seat);
  p.s = s2;
  p.seq = 0;
  assert.strictEqual(p.u.locked, false);
  assert.strictEqual(p.u.holdTicks, 0);
  for (let i = 0; i < MP.HOLD_TICKS - 1; i++) play(k, p, true);
  assert.strictEqual(k.calls.cashout.length, 0, 'the count restarted from the fresh keydown');
  play(k, p, true);
  assert.strictEqual(k.calls.cashout.length, 1);
});

test('a removeHuman that throws on the completing tick still dispatches the order once', (t) => {
  t.mock.method(console, 'error', () => {});
  const k = kit();
  const p = seat(k, at(300, 1.0));
  for (let i = 0; i < MP.HOLD_TICKS - 1; i++) play(k, p, true);
  k.g.removeHuman = () => { throw new Error('sim broke'); };
  play(k, p, true);
  assert.strictEqual(k.calls.cashout.length, 1);
  assert.strictEqual(k.bank.isOpen(p.u.id), false);
  assert.strictEqual(k.room.failCount, 1, 'the tick guard still saw the throw');
});

test('a free cash-out is a clean exit with one zero receipt', () => {
  const k = kit(0);
  const p = seat(k, null, 0);
  for (let i = 0; i < MP.HOLD_TICKS; i++) play(k, p, true);
  assert.ok(p.u.death);
  assert.strictEqual(k.calls.cashout.length, 0);
  const receipts = k.emits.filter(e => e[0] === p.s.id && e[1] === 'pp:cashedout');
  assert.strictEqual(receipts.length, 1);
  assert.deepStrictEqual(receipts[0][2], { grossMicro: 0, cutMicro: 0, netMicro: 0 });
});
