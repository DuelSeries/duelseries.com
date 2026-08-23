'use strict';
/* FoodManager keeps the same pellets in two places: a Map by id, and a live
   array for the hot paths. They must never disagree.

   Why the array exists: getAll() was Array.from(items.values()), and it is
   called from the 60Hz tick AND the 30Hz snapshot broadcast. At
   FOOD_SPAWN_COUNT of 3600 that is a 3600-element array built ninety times a
   second per busy room, roughly 2.6 MB/s of garbage from one method. Nothing
   was wrong with any single call; the cost only appeared as the heap filling
   at a steady rate and the collector stopping the world for 80-160ms when it
   did, which players felt as the whole game hitching at roughly regular
   intervals, in every room at once, attributable to no job — because a
   collection is not a job.

   Removal is swap-and-pop, which is the part that can go quietly wrong, so
   these tests hammer it. */
const { test } = require('node:test');
const assert = require('node:assert');
const FoodManager = require('../server/Food');
const C = require('../shared/constants');

function invariant(fm, note) {
  const arr = fm.getAll();
  assert.equal(arr.length, fm.items.size, `array and map agree in size (${note})`);
  const ids = new Set();
  for (let i = 0; i < arr.length; i++) {
    const f = arr[i];
    assert.equal(f._i, i, `pellet ${f.id} knows its own slot (${note})`);
    assert.ok(fm.items.has(f.id), `pellet ${f.id} is still in the map (${note})`);
    assert.ok(!ids.has(f.id), `pellet ${f.id} appears once (${note})`);
    ids.add(f.id);
  }
  for (const id of fm.items.keys())
    assert.ok(ids.has(id), `map entry ${id} is in the array (${note})`);
}

test('getAll does not allocate a new array each call', () => {
  const fm = new FoodManager();
  fm.spawnInitial(1500);
  assert.ok(fm.getAll().length > 0, 'there is food');
  assert.strictEqual(fm.getAll(), fm.getAll(),
    'the same array object comes back, so the hot paths allocate nothing');
});

test('spawn and remove keep the map and array identical', () => {
  const fm = new FoodManager();
  for (let i = 0; i < 50; i++) fm.spawnOne(1000);
  invariant(fm, 'after spawning');

  const ids = fm.getAll().map(f => f.id);
  fm.remove(ids[0]);                    // first
  invariant(fm, 'after removing the first');
  fm.remove(ids[ids.length - 1]);       // last, the swap-with-self case
  invariant(fm, 'after removing the last');
  fm.remove(ids[25]);                   // middle
  invariant(fm, 'after removing a middle one');
});

test('removing every pellet, in a shuffled order, leaves nothing behind', () => {
  const fm = new FoodManager();
  for (let i = 0; i < 300; i++) fm.spawnOne(1200);
  const ids = fm.getAll().map(f => f.id);
  // deterministic shuffle so a failure is reproducible
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  for (let k = 0; k < ids.length; k++) {
    fm.remove(ids[k]);
    if (k % 37 === 0) invariant(fm, `after ${k + 1} removals`);
  }
  invariant(fm, 'after removing all');
  assert.equal(fm.getAll().length, 0, 'array is empty');
  assert.equal(fm.items.size, 0, 'map is empty');
});

test('removing an id that is not there changes nothing', () => {
  const fm = new FoodManager();
  for (let i = 0; i < 10; i++) fm.spawnOne(800);
  const before = fm.getAll().length;
  fm.remove(999999);
  fm.remove(undefined);
  assert.equal(fm.getAll().length, before, 'nothing was popped');
  invariant(fm, 'after bogus removes');
});

test('refill tops back up to the target and stays consistent', () => {
  const fm = new FoodManager();
  fm.spawnInitial(1500);
  const full = fm.items.size;
  assert.equal(full, C.FOOD_SPAWN_COUNT, 'starts at the configured count');

  const ids = fm.getAll().map(f => f.id).slice(0, 100);
  for (const id of ids) fm.remove(id);
  invariant(fm, 'after eating 100');
  assert.equal(fm.items.size, full - 100);

  // refill is capped per call, so it takes several ticks to catch up
  for (let i = 0; i < 10; i++) fm.refill(1500);
  invariant(fm, 'after refilling');
  assert.equal(fm.items.size, full, 'back to the configured count');
});

test('a pellet removed while the array is being iterated cannot be read as undefined', () => {
  /* The tick reads the live array and removes food from inside the spatial-grid
     walk in the same pass, so the array can shrink mid-iteration. for...of
     re-checks length each step and stops early rather than yielding a hole,
     but that has to stay true or the sim throws on a null pellet. */
  const fm = new FoodManager();
  for (let i = 0; i < 200; i++) fm.spawnOne(1000);
  let seen = 0;
  for (const f of fm.getAll()) {
    assert.ok(f && typeof f.id === 'number', 'never yields a hole');
    seen++;
    if (seen % 3 === 0) fm.remove(f.id);      // remove while iterating
  }
  invariant(fm, 'after removing during iteration');
});
