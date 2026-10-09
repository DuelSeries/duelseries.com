'use strict';
// Owen's hold-Q cash-out in the FREE room (OWNER-ANSWERS 2026-10-08: every agar lobby, free included): hold Q, the
// movement locks at once, 3 s (75 ticks) later the run ends with no money (ag:cashedout { free: true }, the cells go at
// the next step); let go early and nothing happens; edible while holding, death wins a same-tick tie. A free room in
// which nobody holds runs exactly as before.
const test = require('node:test');
const assert = require('node:assert');
const { AgRoom } = require('../server/ag/agRoom');
const { AG_MONEY } = require('../server/ag/agMoney');
const { FIXTURE } = require('./agLawsFixture');

const quiet = { error() {}, warn() {}, log() {} };
const HOLD = AG_MONEY.HOLD_TICKS.value;

function room(opts) {
  const clock = { t: 5000000 };
  const r = new AgRoom(Object.assign({ laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: quiet,
    now: () => clock.t }, opts));
  return { r, clock };
}

let sn = 0;
function sock(id) {
  return {
    id: id || 'fs' + ++sn,
    conn: { writeBuffer: [] },
    events: [],
    emit(ev, p) { this.events.push([ev, p]); },
    of(ev) { return this.events.filter((e) => e[0] === ev).map((e) => e[1]); },
  };
}

function player(r, name) {
  const s = sock(name);
  r.addSocket(s, {});
  assert.strictEqual(r.join(s.id, name), 'ok');
  r.tickOnce();
  const pid = r.seatOf(s.id).pid;
  assert.strictEqual(r.sim.playerInfo(pid).cells.length, 1);
  return { s, pid };
}

function cellsOf(r, pid) {
  return r.sim.playerInfo(pid).cells.map((id) => r.sim.getCell(id));
}

test('75 held ticks end the free run: ag:cashedout { free: true }, the cells go next step, the seat can play again', () => {
  const { r } = room();
  const a = player(r, 'a');
  assert.ok(r.hold(a.s.id, true));
  for (let i = 0; i < HOLD - 1; i++) r.tickOnce();
  assert.deepStrictEqual(a.s.of('ag:holding'), [{ on: 1, need: HOLD }]);
  assert.deepStrictEqual(a.s.of('ag:cashedout'), [], 'not at 74');
  assert.strictEqual(cellsOf(r, a.pid).length, 1);
  r.tickOnce();
  assert.deepStrictEqual(a.s.of('ag:cashedout'), [{ free: true }], 'at 75');
  r.tickOnce();
  assert.strictEqual(r.sim.playerInfo(a.pid).cells.length, 0, 'the cells are gone');
  assert.ok(r.seatOf(a.s.id), 'the seat stays (results screen, then Play)');
  assert.strictEqual(r.join(a.s.id, 'a'), 'ok');
  r.tickOnce();
  assert.strictEqual(r.sim.playerInfo(a.pid).cells.length, 1, 'plays again');
});

test('the movement locks at once and split and eject are refused; letting go early does nothing', () => {
  const { r } = room();
  const a = player(r, 'a');
  const c = cellsOf(r, a.pid)[0];
  c.size = 150;
  r.target(a.s.id, Math.round(c.x) + 3000, Math.round(c.y));
  r.tickOnce();
  r.hold(a.s.id, true);
  r.tickOnce();
  const x = cellsOf(r, a.pid)[0].x;
  assert.strictEqual(r.split(a.s.id), false);
  assert.strictEqual(r.eject(a.s.id), false);
  for (let i = 0; i < 30; i++) r.tickOnce();
  assert.strictEqual(cellsOf(r, a.pid)[0].x, x, 'held still');
  assert.strictEqual(cellsOf(r, a.pid).length, 1);
  r.hold(a.s.id, false);
  r.tickOnce();
  assert.deepStrictEqual(a.s.of('ag:holding').pop(), { on: 0 });
  for (let i = 0; i < HOLD; i++) r.tickOnce();
  assert.deepStrictEqual(a.s.of('ag:cashedout'), [], 'released early: nothing happens');
  assert.ok(cellsOf(r, a.pid)[0].x > x, 'and it moves again');
});

test('a stale hold (no message for more than 500 ms) ends with nothing; a watcher or a dead seat cannot hold', () => {
  const { r, clock } = room();
  const a = player(r, 'a');
  r.hold(a.s.id, true);
  for (let i = 0; i < 20; i++) r.tickOnce();
  clock.t += AG_MONEY.HOLD_INPUT_STALE_MS.value + 1;
  for (let i = 0; i < HOLD; i++) r.tickOnce();
  assert.deepStrictEqual(a.s.of('ag:cashedout'), []);
  const w = sock('watcher');
  r.addSocket(w, {});
  assert.strictEqual(r.hold(w.id, true), false, 'a watcher holds nothing');
  assert.strictEqual(r.hold('nobody', true), false);
});

test('edible while holding, and death wins the tie in the completing tick', () => {
  const { r } = room();
  const a = player(r, 'a');
  const b = player(r, 'b');
  r.hold(a.s.id, true);
  for (let i = 0; i < HOLD - 1; i++) r.tickOnce();
  const va = cellsOf(r, a.pid)[0];
  const vb = cellsOf(r, b.pid)[0];
  vb.x = va.x;
  vb.y = va.y;
  vb.size = 400;
  r.sim.setInput(b.pid, { x: va.x, y: va.y });
  r.tickOnce();
  assert.strictEqual(r.sim.playerInfo(a.pid).cells.length, 0, 'eaten');
  assert.deepStrictEqual(a.s.of('ag:cashedout'), [], 'no cash-out for an eaten player');
});

test('a free room where nobody holds runs exactly as before (same seed, same state, with refused holds sent)', () => {
  const run = (sendHolds) => {
    const { r } = room({ seed: 11 });
    const w = sock('w');
    r.addSocket(w, {});
    for (let i = 0; i < 300; i++) {
      if (sendHolds) r.hold(w.id, true);     // a watcher's hold is refused: nothing may change
      r.tickOnce();
    }
    return JSON.stringify(r.sim.snapshot());
  };
  assert.strictEqual(run(true), run(false));
});

test('a seat that leaves while holding takes nothing with it; bots never hold', () => {
  const { r } = room();
  const a = player(r, 'a');
  r.hold(a.s.id, true);
  for (let i = 0; i < 10; i++) r.tickOnce();
  r.removeSocket(a.s.id);
  for (let i = 0; i < HOLD; i++) r.tickOnce();
  assert.strictEqual(r.still.size, 0, 'the freeze set is empty again');
  assert.deepStrictEqual(a.s.of('ag:cashedout'), []);
  assert.ok(r.botCount > 0);
});
