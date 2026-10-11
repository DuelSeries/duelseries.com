'use strict';
// The sim and stream fixes of the T14 law check (SERVER-DESIGN 18.3, 19 task T14): each one a line of
// analysis/run-all.js that failed on our local recording and passed on Owen's slither.io recordings. FIXTURE table,
// literal vectors from the law rows by id.
//   L12, L13  the ramp down lands on the base at the length when it lands (their data: 47 of 47 grown ramps)
//   L24       a snake's boost drop goes after its h and before its r, rotation and move (theirs: 204 of 204 drops
//             before the same snake's r, 'h DROP' 54, never 'DROP h')
//   L11.slow  the slow z checks run on the half slots of the L9 leaderboard timer (723 of 723), never a clock of
//             their own that drifts off it
//   L48.rot   the own echo carries ang with dir and wang (theirs: never dir+wang alone on the own snake); the room
//             test (slRoom.test.js) holds its literal vector
//   queue     a food add into a never-dumped watched sector puts that sector on the client, so a resync removes it
//             (slMirror found a second copy of such a food after a resync)

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSim } = require('../server/sl/slSim');
const slSnake = require('../server/sl/slSnake');
const SV = require('../server/sl/slView');
const SQ = require('../server/sl/slSendQueue');
const RC = require('../server/sl/slRecordCache');
const { SlRoom } = require('../server/sl/slRoom');
const W = require('../shared/slWire.js');
const { FIXTURE, makeFixture } = require('./slLawsFixture');
const { fakeSocket, fakeTimers } = require('./slNetFakes');

const C = 32550; // L1
const P = 42.67; // L7
const PV = 19; // L6

// L12: sp(m) = nsp1 + nsp2 min(6, 1 + (m - 2) / 106), wire byte trunc(18 sp) (literals: 5.39, 0.4, 106)
const sp12 = (m) => 5.39 + 0.4 * Math.min(6, 1 + (m - 2) / 106);

test('L12 and L13: a snake that grows while ramping down lands on the base of its length at the landing', () => {
  const K = slSnake.snakeLaws(FIXTURE);
  // the literal pair this law check found: a snake that ended its boost at sct 28 and grew to 31 on the way down
  assert.equal(Math.trunc(18 * sp12(28)), 105);
  assert.equal(Math.trunc(18 * sp12(31)), 106);
  assert.equal(slSnake.speedBase(K, 28), sp12(28));
  const sim = createSim(FIXTURE, { seed: 3 });
  const s = sim.spawn({ x: C, y: C, ang: 0, cv: 1, sct: 28, fam: 0.9 });
  sim.setInput(s.id, { type: 'boost', on: true }, 0);
  for (let i = 0; i < 10; i++) {
    sim.applyInputs();
    sim.step();
  }
  assert.ok(s.boosting && s.sp > 10, 'boosting at ' + s.sp);
  const sct0 = s.pts.length;
  sim.setInput(s.id, { type: 'boost', on: false }, 0);
  s.fam += 3; // food eaten on the way down: three grow moves (one point per move, L18)
  let landed = -1;
  for (let i = 0; i < 60 && landed < 0; i++) {
    sim.applyInputs();
    sim.step();
    if (!s.boosting && !s.rampDown) landed = s.pts.length;
  }
  assert.ok(landed > sct0, 'grew while ramping down: ' + sct0 + ' to ' + landed);
  assert.equal(s.spCore, slSnake.speedBase(K, landed), 'landed on the base at the landing length');
  assert.equal(Math.trunc(18 * s.sp), Math.trunc(18 * sp12(landed)));
  // after the landing the base never moves with growth (L12)
  const base = s.spBase;
  s.fam += 2;
  for (let i = 0; i < 30; i++) {
    sim.applyInputs();
    sim.step();
  }
  assert.ok(s.pts.length > landed);
  assert.equal(s.spBase, base);
  assert.equal(s.sp, base);
});

test('L24: a snake\'s boost drop goes after its h and before its r, rotation and move', () => {
  const sim = createSim(FIXTURE, { seed: 5, border: true, food: true, prey: false });
  const view = SV.createView(FIXTURE, sim);
  const s = sim.spawn({ x: C, y: C, ang: 0, cv: 2, sct: 12, fam: 0.02 });
  const j = view.join(s.id);
  sim.setInput(s.id, { type: 'boost', on: true }, 0);
  let checked = 0;
  for (let t = 0; t < 120 && s.alive; t++) {
    sim.applyInputs();
    const log = sim.step();
    view.tick(log);
    const evs = W.decodeBundle(SV.bundleOf(view.assemble(j.seat)));
    const mine = [];
    evs.forEach((e, i) => {
      if (e.type === 'food_add' && e.rapid) mine.push(['DROP', i]);
      else if (e.id === s.id && e.type === 'snake_fam') mine.push(['h', i]);
      else if (e.id === s.id && e.type === 'snake_tail') mine.push(['r', i]);
      else if (e.type === 'snake_rot' && e.own) mine.push(['rot', i]);
      else if (e.type === 'snake_move' && e.own) mine.push(['mv', i]);
    });
    const at = (k) => mine.filter((m) => m[0] === k).map((m) => m[1]);
    const drops = at('DROP');
    if (!drops.length) continue;
    for (const d of drops) {
      for (const i of at('h')) assert.ok(i < d, 'h before the drop');
      for (const k of ['r', 'rot', 'mv']) for (const i of at(k)) assert.ok(d < i, 'the drop before ' + k);
    }
    if (at('r').length) checked++;
  }
  assert.ok(checked >= 3, 'tail drops seen with an r in the same bundle: ' + checked);
});

test('L11.slow: the slow z clock is half the L9 period from the same start; a row that disagrees is refused', () => {
  const ft = fakeTimers(0);
  const room = new SlRoom(makeFixture({ C_ROOM_CAP: 100, C_HUMAN_CAP: 100 }), {
    seed: 1, shippableOnly: false, autoTick: false, clock: ft.now, now: () => 0, timers: ft.timers, prey: false,
    log: { log() {}, warn() {}, error() {} },
  });
  assert.equal(room.R.zSlowMs, 1504.2); // 3008.4 / 2 (L9), the row says 1504.31 (measured, within 0.5 ms)
  let lb = 0;
  let z = 0;
  let both = 0;
  for (let n = 0; n < 3000; n++) {
    const l0 = room.clocks.lb.fires;
    const z0 = room.clocks.zSlow.fires;
    room.tickOnce();
    const lf = room.clocks.lb.fires !== l0;
    const zf = room.clocks.zSlow.fires !== z0;
    if (lf) lb++;
    if (zf) z++;
    if (lf && zf) both++;
  }
  assert.equal(lb, Math.floor(3000 * P / 3008.4));
  assert.equal(both, lb, 'every leaderboard slot is a slow z slot');
  assert.ok(z === 2 * lb || z === 2 * lb + 1, z + ' slow z for ' + lb + ' leaderboards');
  assert.throws(() => new SlRoom(makeFixture({ C_ROOM_CAP: 100, C_HUMAN_CAP: 100, 'L11.slow': 1600 }), {
    seed: 1, shippableOnly: false, autoTick: false, clock: ft.now, now: () => 0, timers: ft.timers, prey: false,
  }), /half the L9/);
});

test('send queue: a food add into a never-dumped sector is delivered state, and a resync removes that sector', () => {
  const K = SQ.KIND;
  assert.deepEqual(SQ.tagOf({ type: 'food_add', sx: 3, sy: 4 }, 5), [K.OTHER, 2, 1, 772, null]);
  const L = makeFixture({ C_PENDING_CAP: 300 });
  let now = 0;
  const sock = fakeSocket('polling', () => now);
  const q = SQ.createSendQueue(L, { socket: sock, ownId: 5, clock: () => now });
  const push = (tick, ev) => q.push(tick, ev, RC.encodeRecord(ev, false, PV));
  // a boost drop into watched sector (7, 9), which never had a dump: the client now holds a food there
  push(1, { type: 'food_add', rapid: true, sectorFromLast: false, sx: 7, sy: 9, rx: 10, ry: 20, cvFromLast: false, cv: 3,
    rad: 5 });
  sock.conn.transport.park();
  assert.deepEqual(Array.from(q.delivered.sectors), [7 * 256 + 9]);
  // a stall: past the cap, the queue resyncs
  sock.conn.transport.writable = false;
  let k = 0;
  while (q.bytes <= q.Q.cap) push(2, { type: 'snake_rot', own: false, id: 200 + (k++ % 50), ang: 0 });
  now = 1000;
  assert.equal(q.checkCap(2, now), 'resync');
  sock.conn.transport.park();
  const all = sock.emitted.filter((e) => e.name === 'sl:f').map((e) => W.decodeBundle(e.data));
  const last = all[all.length - 1];
  assert.ok(last.some((e) => e.type === 'sector_remove' && e.sx === 7 && e.sy === 9), 'the resync removes the sector');
});
