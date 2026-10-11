'use strict';
// slView heap (task T8b; T15 soak finding 1, recordings/OURS-SOAK.md: heapUsed 26.3 MB at minute 5, 97.2 MB at
// minute 30). FIXTURE table only.
//
// The leak: every L10 minimap image cached its V form in a Map keyed by the image the seat held before it, so the
// newest image reached the one before it, and that one the one before it: every image ever made (its 136 x 136 bit
// image and its cell lists) stayed alive while any seat held the newest. The fix keys that cache weakly (a V form
// never refers back to its key) and a seat that leaves lets go of the image it held.
//
// The proof runs the room contract (createWorld, createSeatView) with the room's L10 clock firing on EVERY step, so
// one step makes one image (the room fires it every 2504.2 ms; the chain is the same, only longer per minute), then
// forces full collections: images no seat and no tick record can still reach must be collected (WeakRef), and the
// heap after many more images must stay flat (the leak kept every image: about 18.5 KB of bits each, plus cells).
// This file exposes gc to itself (v8 flag at run time), so it runs in its own process under node --test.

const test = require('node:test');
const assert = require('node:assert/strict');
const v8 = require('v8');
const vm = require('vm');

const { createSim } = require('../server/sl/slSim');
const { createWorld, createSeatView } = require('../server/sl/slView');
const { FIXTURE } = require('./slLawsFixture');

v8.setFlagsFromString('--expose-gc');
const gc = typeof global.gc === 'function' ? global.gc : vm.runInNewContext('gc');

const C = 32550; // L1 grd
const NONE = { lb: false, mm: false, zSlow: false, zFast: false, sweep: false };
const MM = Object.assign({}, NONE, { mm: true });

// heapUsed plus ArrayBuffer memory (each image's 136 x 136 bits is an ArrayBuffer, outside heapUsed)
function used() {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}

// A full collection after the current job ended (a WeakRef target made or read in this job is kept until it ends).
async function collect() {
  await new Promise((r) => setImmediate(r));
  gc();
  await new Promise((r) => setImmediate(r));
  gc();
}

// Seated snakes circling in their own corner (turning left each step), plus a few unseated ones, so every image has
// lit pixels that change from step to step. Returns the room-contract pieces and step().
function room(seed, seats) {
  const sim = createSim(FIXTURE, { seed, world: true, prey: false });
  const w = createWorld(FIXTURE, sim);
  const views = [];
  const ids = [];
  for (let k = 0; k < seats; k++) {
    const s = sim.spawn({ x: C - 1200 + 1200 * (k % 3), y: C - 1200 + 1200 * Math.floor(k / 3), ang: 0, cv: k });
    ids.push(s.id);
    const v = createSeatView(FIXTURE, { sim, world: w, ownId: s.id });
    v.join({});
    views.push(v);
  }
  for (let k = 0; k < 3; k++) ids.push(sim.spawn({ x: C - 600 + 600 * k, y: C + 1500, ang: 0, cv: 10 + k }).id);
  function step(clocks) {
    for (const id of ids) if (sim.snake(id)) sim.setInput(id, { type: 'turn', dir: 'left', v: 20 }, 0);
    sim.applyInputs();
    const f = { tick: sim.tick() + 1, locks: [], cashed: [], clocks: clocks || MM, board: null };
    f.log = sim.step();
    w.afterStep(f);
    for (const v of views) v.collect({});
  }
  return { sim, w, views, ids, step };
}

test('slView heap: minimap images no seat holds are collected; the heap stays flat over 1,500 more images', async () => {
  const r = room(31, 3);
  // the first 200 images, as the seats held them
  const refs = [];
  for (let t = 0; t < 200; t++) {
    r.step();
    refs.push(new WeakRef(r.views[0].seat.lastMap));
  }
  await collect();
  const heap0 = used();
  for (let t = 0; t < 1500; t++) r.step();
  for (const v of r.views) assert.equal(v.seat.gone, false, 'every seat still alive, so every step sent it an image');
  assert.equal(r.w.view.stats().mmV + r.w.view.stats().mmM, 3 * 1700, 'one image per step per seat');
  await collect();
  const heap1 = used();
  const alive = refs.filter((x) => x.deref() !== undefined).length;
  // the leak kept all 1,500 (at least 1,500 x 18,496 bytes of bits = 26.5 MB, plus their cell lists)
  const grewMb = (heap1 - heap0) / 1048576;
  const said = alive + ' of the first 200 images still reachable after 1,500 newer ones; heap and buffers grew ' + grewMb.toFixed(2) + ' MB';
  assert.equal(alive, 0, said);
  assert.ok(grewMb < 4, said);
});

test('slView heap: a seat that left, or one whose own snake ended, holds no chain of images', async () => {
  const r = room(32, 3);
  for (let t = 0; t < 20; t++) r.step();
  // seat 0 leaves (the room's unseat: view.leave), seat 1's own snake dies; the test keeps both seat objects
  const left = r.views[0].seat;
  const leftImg = new WeakRef(left.lastMap);
  r.views[0].leave();
  // (never hand an image to assert: inspecting the leaked chain alone runs out of memory)
  assert.ok(left.lastMap === null, 'leave lets go of the image');
  // newer images before the death, so the dead seat does not hold the left seat's image
  for (let t = 0; t < 20; t++) r.step();
  r.sim.kill(r.ids[1]);
  r.step(NONE); // the death step
  const dead = r.views[1].seat;
  assert.equal(dead.gone, true);
  const deadImg = new WeakRef(dead.lastMap);
  const after = [];
  for (let t = 0; t < 300; t++) {
    r.step();
    after.push(new WeakRef(r.views[2].seat.lastMap));
  }
  await collect();
  assert.ok(leftImg.deref() === undefined, 'the left seat\'s last image went once the tick records were pruned');
  assert.ok(deadImg.deref() !== undefined, 'the dead seat still holds the one image its client shows');
  assert.equal(after.slice(0, 290).filter((x) => x.deref() !== undefined).length, 0, 'no older image of the live seat');
  assert.equal(r.views[1].mirror().hasMap, true);
});
