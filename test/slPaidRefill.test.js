'use strict';
// A cell eaten and filled again in ONE step (task T8, found by the paid soak: 12 doubleFood in one minute of the
// 30 minute soak, every client watching the cell at once). A step's food adds go out before its eats (slView, L25),
// and their client applies an eat to the NEWEST food of that id (public/js/sl/slApply.js:1110-1121), so the add of
// the new food landed beside the eaten one and the eat then took the new one: the eaten food stayed on screen as a
// ghost and the new one (in a paid room, gold) was invisible. In a dense gold pile a death drop's nearest free cell
// is often the one a head just ate. The paid room's view (createWorld opts.eatThenRefill, slView refillsOf) sends
// the eat first; the free room's order is untouched (its goldens pin it). The client here is the soak's own model
// (scripts/slLoad.js createTracker: a second food in a cell it holds is a doubleFood, an eat of a cell it holds
// nothing in an unknownFood).
const test = require('node:test');
const assert = require('node:assert/strict');

const { createSim } = require('../server/sl/slSim');
const { createView, bundleOf } = require('../server/sl/slView');
const slSnake = require('../server/sl/slSnake');
const { SlRoom } = require('../server/sl/slRoom');
const { createSlMoney } = require('../server/slPaid/slMoney');
const { createTracker } = require('../scripts/slLoad');
const { FIXTURE, makeFixture } = require('./slLawsFixture');
const { fakeTimers } = require('./slNetFakes');

const C = FIXTURE.L1.value;
const GOLD = FIXTURE.C_PAID_CASH_BYTE.value; // 68: the client draws it at rad 13.6

// A seat watching a food world, its client model fed with every bundle; refill(sim, own) runs inside the step,
// after the sim's own step and before the view hears of it, and returns the cell it refilled.
function run(eatThenRefill, refill) {
  const sim = createSim(FIXTURE, { seed: 5, border: true, food: true, prey: false });
  const view = createView(FIXTURE, sim, { eatThenRefill });
  const s = sim.spawn({ x: 30000, y: C + 10, ang: 0, cv: 2 });
  const j = view.join(s.id);
  const tr = createTracker();
  tr.onBundle(bundleOf(j.entries));
  for (let i = 0; i < 3; i++) {
    sim.applyInputs();
    view.tick(sim.step());
    tr.onBundle(bundleOf(view.assemble(j.seat)));
  }
  sim.applyInputs();
  const log = sim.step();
  const cell = refill(sim, s.id, j.seat);
  view.tick(log);
  const entries = view.assemble(j.seat);
  const ops = entries.filter((e) => (e.type === 'food_add' || e.type === 'food_eat') &&
    ((e.ev.sx << 24) | (e.ev.sy << 16) | (e.ev.rx << 8) | e.ev.ry) === cell.id)
    .map((e) => (e.type === 'food_add' ? 'add ' + e.ev.rad : 'eat'));
  tr.onBundle(bundleOf(entries));
  const held = (tr.cells.get(cell.id) || []).map((f) => f.rad);
  return { ops, held, fail: Object.assign({}, tr.fail), cell };
}

// A natural food the seat holds, near its head (a kept sector that was dumped to it).
function heldFood(sim, own, seat) {
  const s = sim.snake(own);
  let pick = null;
  sim.food.forEachInDisc(slSnake.headX(s), slSnake.headY(s), 600, (f) => {
    if (!pick && f.nat && seat.kept.has(f.si)) pick = f;
  });
  assert.ok(pick, 'a food in view');
  return pick;
}

// Eat a held food with the own snake, then drop a gold pellet at its position: the freed cell takes it.
function eatThenDrop(sim, own, seat) {
  const x = heldFood(sim, own, seat);
  sim.food.eat(x, own);
  const y = sim.food.drop(x.x, x.y, GOLD, 3);
  assert.ok(y && y.id === x.id && y !== x, 'the drop took the cell just eaten');
  return x;
}

test('slPaidRefill: a paid view sends the eat before the gold that fills the same cell in that step', () => {
  const paid = run(true, eatThenDrop);
  assert.deepEqual(paid.ops, ['eat', 'add ' + GOLD / 5]);
  assert.equal(paid.fail.doubleFood, 0);
  assert.equal(paid.fail.unknownFood, 0);
  assert.deepEqual(paid.held, [GOLD / 5], 'the client holds the gold, and only the gold');
});

test('slPaidRefill: the free view keeps its order (the ghost this fixes, pinned so a change to it is seen)', () => {
  const free = run(false, eatThenDrop);
  assert.deepEqual(free.ops, ['add ' + GOLD / 5, 'eat']);
  assert.equal(free.fail.doubleFood, 1);
  assert.equal(free.held.length, 1);
  assert.notEqual(free.held[0], GOLD / 5, 'the eat took the new gold and left the eaten food on screen');
});

test('slPaidRefill: a cell refilled twice in one step goes out as its chain (eat, add, eat, add)', () => {
  const paid = run(true, (sim, own, seat) => {
    const x = heldFood(sim, own, seat);
    sim.food.eat(x, own);
    const y = sim.food.drop(x.x, x.y, GOLD, 3);
    sim.food.eat(y, own);
    const z = sim.food.drop(x.x, x.y, GOLD + 5, 4);
    assert.ok(y.id === x.id && z.id === x.id, 'one cell, three foods');
    return x;
  });
  assert.deepEqual(paid.ops, ['eat', 'add ' + GOLD / 5, 'eat', 'add ' + (GOLD + 5) / 5]);
  assert.equal(paid.fail.doubleFood, 0);
  assert.equal(paid.fail.unknownFood, 0);
  assert.deepEqual(paid.held, [(GOLD + 5) / 5]);
});

test('slPaidRefill: a food dropped into an empty cell and eaten in its own step still goes out add, eat', () => {
  const paid = run(true, (sim, own, seat) => {
    const x = heldFood(sim, own, seat);
    // an empty cell of the same kept sector, along the row from the held food
    const cell = sim.grid.sectorSize / 256;
    let at = null;
    for (let d = 1; d < 64 && at === null; d++) {
      const fid = sim.grid.foodIdAt(x.x + d * cell, x.y);
      if (fid >>> 16 === x.id >>> 16 && !sim.food.get(fid)) at = x.x + d * cell;
    }
    assert.ok(at !== null, 'an empty cell');
    const y = sim.food.drop(at, x.y, GOLD, 3);
    sim.food.eat(y, own);
    return y;
  });
  assert.deepEqual(paid.ops, ['add ' + GOLD / 5, 'eat']);
  assert.equal(paid.fail.doubleFood + paid.fail.unknownFood, 0);
  assert.deepEqual(paid.held, []);
});

test('slPaidRefill: a paid room builds its view with eatThenRefill, the free room without', () => {
  const laws = makeFixture();
  const ft = fakeTimers(1000);
  const quiet = { log() {}, warn() {}, error() {} };
  const free = new SlRoom(laws, { clock: ft.clock, timers: ft.timers, autoTick: false, shippableOnly: false, seed: 3,
    prey: false, log: quiet });
  assert.equal(free.world.view.eatThenRefill, false);
  const noop = () => undefined;
  const hooks = { onCashout: noop, onOwed: noop, onFloor: noop, onHouse: noop, onBreach: noop, onTransfer: noop,
    onAccountOpen: noop, onAccountClosed: noop, journal: { open: () => true, close: () => true } };
  const money = createSlMoney({ stake: 0.5, label: 'sl_na_s0_5', hooks, log: quiet, checkEvery: 1, laws });
  const paid = new SlRoom(laws, { money, lobbyType: 'sl_na_s0_5', humanCap: 22, seed: 3, clock: ft.clock,
    timers: ft.timers, autoTick: false, shippableOnly: false, prey: false, log: quiet });
  assert.equal(paid.world.view.eatThenRefill, true);
});
