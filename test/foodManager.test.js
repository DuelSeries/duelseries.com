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
  /* The target is a DENSITY over the spawnable disc now, not a flat headcount,
     so it is asked for rather than assumed. A standard room still comes out at
     exactly FOOD_SPAWN_COUNT — that is what the density is calibrated on — and
     the case below deliberately uses a smaller world to prove the target really
     does follow the area. */
  const fm = new FoodManager();
  fm.spawnInitial(1500);
  const full = fm.items.size;
  assert.equal(full, fm.targetFor(1500 + C.FOOD_SPAWN_MARGIN),
    'starts at the density target for its own world');
  assert.ok(full < C.FOOD_SPAWN_COUNT,
    'a world smaller than the base one gets proportionally less food');

  const ids = fm.getAll().map(f => f.id).slice(0, 100);
  for (const id of ids) fm.remove(id);
  invariant(fm, 'after eating 100');
  assert.equal(fm.items.size, full - 100);

  // refill is capped per call, so it takes several ticks to catch up
  for (let i = 0; i < 10; i++) fm.refill(1500);
  invariant(fm, 'after refilling');
  assert.equal(fm.items.size, full, 'back to the density target');
});

test('a standard room is unchanged: the density target is exactly FOOD_SPAWN_COUNT', () => {
  const fm = new FoodManager();
  fm.spawnInitial(C.BASE_WORLD_RADIUS);
  assert.equal(fm.items.size, C.FOOD_SPAWN_COUNT,
    'the density is calibrated so an ordinary room keeps the count it always had');
});

test('a zone that shrinks and walks away never leaves the arena empty', () => {
  /* THE BUG THIS EXISTS FOR. refill used to ask `FOOD_SPAWN_COUNT - items.size`,
     which counts pellets the battle royale's circle has already abandoned out in
     the red zone. Measured on the real room, the playable area held ZERO food
     from about 165s onward while 3711 pellets sat in the Map — the count said
     full, so nothing ever spawned, and the arena was bare.

     Here the circle starts wide and centred, then shrinks to a twentieth of its
     radius somewhere else entirely, which is exactly the move that stranded the
     food. Nothing is eaten: every pellet lost is one the zone walked away from. */
  const fm = new FoodManager();
  fm.spawnInitial(6000, 0, 0, 0);
  assert.ok(fm.items.size > 0, 'starts stocked');

  let R = 6000, cx = 0, cy = 0;
  const inside = () => {
    let n = 0;
    for (const f of fm.getAll()) {
      const dx = f.x - cx, dy = f.y - cy;
      if (dx * dx + dy * dy <= R * R) n++;
    }
    return n;
  };

  for (let step = 0; step < 40; step++) {
    R = Math.max(300, R * 0.9);
    cx += 90; cy += 60;                       // the circle travels as it closes
    for (let t = 0; t < 60; t++) fm.refill(R, cx, cy, { margin: 0 });
    assert.ok(inside() > 0,
      `food inside the zone at step ${step} (R=${Math.round(R)})`);
    invariant(fm, 'step ' + step);
  }

  const want = fm.targetFor(R);
  const got = inside();
  assert.ok(got >= want * 0.5,
    `settles near the density target inside the final zone (got ${got}, target ${want})`);
});

test('death drops are never swept up, even when the zone leaves them behind', () => {
  /* Dropped food is the payoff for a kill. The sweep reclaims pellets the arena
     has abandoned, and it must not reclaim these — deleting them takes back a
     reward a player has already earned. */
  const fm = new FoodManager();
  const far = fm.spawnOne(500, 40000, 40000, undefined, undefined, undefined,
                          undefined, true /* dropped */, 0, 0);
  for (let t = 0; t < 400; t++) fm.refill(500, 0, 0, { margin: 0 });
  assert.ok(fm.items.has(far.id), 'the death drop is still there');
  invariant(fm, 'after sweeping around a death drop');
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

test('cash food is never swept, because sweeping it would destroy real money', () => {
  /* GameRoom does `snake.worth += food.cashValue`, so a pellet carrying
     cashValue is real USDC worth. The sweep reclaims abandoned food, and it
     must never reclaim one of these. Keyed on cashValue rather than the derived
     isGolden flag, so the two cannot quietly stop agreeing. */
  const fm = new FoodManager();
  const cash = fm.spawnOne(500, 40000, 40000, 1, 2.5 /* cashValue */);
  assert.ok(cash.cashValue > 0, 'the pellet really carries worth');
  for (let t = 0; t < 400; t++) fm.refill(500, 0, 0, { margin: 0 });
  assert.ok(fm.items.has(cash.id), 'the cash pellet survived the sweep');
  invariant(fm, 'after sweeping around cash food');
});

test('the same patch of ground holds the same food, whatever size the arena is', () => {
  /* THE CAP MADE A BIG ARENA A THIN ONE.

     The world grows with the crowd, up to MAX_WORLD_RADIUS. The pellet target
     used to be min(FOOD_SPAWN_COUNT, density * area), so past about radius 2000
     the count pinned at 3,600 while the area kept expanding — a full arena ran
     at under a quarter of the density of a quiet one. The busier the room got,
     the emptier the ground under your snake. Exactly backwards.

     Density is the whole spec now: same food per unit of area, always. */
  const fm = new FoodManager();
  const density = (r) => {
    const disc = r + C.FOOD_SPAWN_MARGIN;
    return fm.targetFor(disc) / (Math.PI * disc * disc);
  };

  const base = density(C.BASE_WORLD_RADIUS);
  for (const r of [1200, 2000, 3000, 4000, 5000, C.MAX_WORLD_RADIUS]) {
    const d = density(r);
    assert.ok(Math.abs(d - base) / base < 0.01,
      'world radius ' + r + ' runs at the same density as the base one '
      + '(' + (d * 1e6).toFixed(1) + ' vs ' + (base * 1e6).toFixed(1) + ' per 1e6u2)');
  }

  /* And the total really does climb with the area, rather than flattening. */
  assert.ok(fm.targetFor(C.MAX_WORLD_RADIUS + C.FOOD_SPAWN_MARGIN)
            > fm.targetFor(C.BASE_WORLD_RADIUS + C.FOOD_SPAWN_MARGIN) * 3,
    'a full-size arena holds several times the pellets a small one does');
});

test('the seatbelt is above anything the world can actually reach', () => {
  /* FOOD_ABSOLUTE_MAX exists so an unbounded world cannot become an unbounded
     wire. It must not be low enough to quietly reintroduce the thinning it
     replaced. */
  const fm = new FoodManager();
  const biggest = fm.targetFor(C.MAX_WORLD_RADIUS + C.FOOD_SPAWN_MARGIN);
  assert.ok(biggest < C.FOOD_ABSOLUTE_MAX,
    'the largest arena the world can reach is under the seatbelt '
    + '(' + biggest + ' < ' + C.FOOD_ABSOLUTE_MAX + ')');
});

test('an empty arena refills in FOOD_REFILL_SECONDS, at 60Hz or at the idle 6Hz', () => {
  /* Owen: "in battle royale the food doesn't start spawning until I start the
     battle royale." It did spawn; it crawled. Refill was a flat 30 per CALL,
     and an idle room deliberately runs one tick in ten, so the arena nobody had
     joined yet filled at 180/sec instead of 1800 — about 90 seconds to fill a
     density-sized battle royale, which reads as "no food" to anyone looking.

     The rate is now a share of the target per SECOND, and a throttled room says
     how many ticks its one call stands for. Both paths must reach full in the
     same wall-clock time; that equality is the whole fix. */
  const R = 6000, secs = C.FOOD_REFILL_SECONDS;

  const fillTime = (ticksPerCall) => {
    const fm = new FoodManager();
    const target = fm.targetFor(R);
    const callsPerSecond = C.TICK_RATE / ticksPerCall;
    for (let s = 1; s <= secs + 2; s++) {
      for (let i = 0; i < callsPerSecond; i++) {
        fm.refill(R, 0, 0, { margin: 0, ticks: ticksPerCall });
      }
      if (fm.items.size >= target * 0.95) return s;
    }
    return null;
  };

  const busy = fillTime(1);    // a room with somebody in it
  const idle = fillTime(10);   // a room nobody has joined, ticking at ~6Hz

  assert.ok(busy !== null && busy <= secs,
    `a busy room fills within ${secs}s (took ${busy})`);
  assert.strictEqual(idle, busy,
    `an idle room fills just as fast (idle ${idle}s vs busy ${busy}s)`);
});

test('refill does not depend on the wall clock', () => {
  /* The first version of the rate limit read Date.now(), and it spawned nothing
     at all under test: a harness steps thousands of ticks inside one
     millisecond, so the elapsed time was always zero and the budget always
     truncated to zero. A simulation that only works when it is run in real time
     cannot be measured, which means it cannot be trusted. Freezing the clock
     must change nothing. */
  const realNow = Date.now;
  Date.now = () => 1600000000000;              // time stands completely still
  try {
    const fm = new FoodManager();
    for (let i = 0; i < C.TICK_RATE; i++) fm.refill(2000, 0, 0, { margin: 0 });
    assert.ok(fm.items.size > 0, 'pellets still spawn with a frozen clock');
    assert.ok(Math.abs(fm.items.size - fm.targetFor(2000) / C.FOOD_REFILL_SECONDS)
              <= 2, 'and at the same one-second share of the target');
    invariant(fm, 'after refilling with a frozen clock');
  } finally {
    Date.now = realNow;
  }
});
