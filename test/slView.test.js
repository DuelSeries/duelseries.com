'use strict';
// slView unit tests (task T8; SERVER-BUILD-BRIEF section 8 row slView, SERVER-DESIGN 8 and 18.1). FIXTURE table only.
// Every expected number is a LITERAL from the SERVER-LAWS row of its id (or computed here from that row's formula
// with its literal constants), never read back from the code under test:
//   L1 grd 32550; L2 sector 300 (217 sectors per axis); L6 pv 19, realSid 0; L7 42.67
//   L8.anchor continuous head + (48.2 + 7.66 sp) along ang (last point: 69.24 + 7.727 sp); L8.R2 13 (45 sectors) or
//   20 (69 sectors), 20 iff own sct >= 92 at the recompute; L8.sweep 503.91; L8.linger 2700; L8.snake 4400
//   L9 3008.4 ms, 10 rows; L10 2504.2 ms, 136 px, first full; L11 slow 1504.31, fast 127.43, T 2500
//   L17.famRound and L48.angRound floor; L48.rot refresh 205 ms; L50 died 1, left view 0; C_CASHOUT_CODE 0
//   L20 spawn sp 5.79; border 2923 at 22 snakes or fewer (C_R_MIN, BUILD-DECISIONS T7)

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSim } = require('../server/sl/slSim');
const SV = require('../server/sl/slView');
const slSnake = require('../server/sl/slSnake');
const Q = require('../server/sl/slQuant');
const W = require('../shared/slWire.js');
const { encodeRecord } = require('../server/sl/slRecordCache');
const { FIXTURE, makeFixture } = require('./slLawsFixture');
const { createMirror, applyBundle } = require('./slViewHarness');

const { createView, createWorld, createSeatView, bundleOf, byte8, uvBytes, offsetsFor } = SV;

const C = 32550; // L1
const SS = 300; // L2
const P = 42.67; // L7
const PI2 = 2 * Math.PI;

function world(o) {
  const opt = o || {};
  const laws = opt.laws || FIXTURE;
  const sim = createSim(laws, Object.assign({ seed: 1, border: true, food: false, prey: false }, opt.sim));
  const view = createView(laws, sim, opt.view);
  return { sim, view, laws };
}

function step(sim, view) {
  sim.applyInputs();
  const log = sim.step();
  view.tick(log);
  return log;
}

function decode(entries) {
  return W.decodeBundle(bundleOf(entries));
}

function sec(view, si) {
  const g = view.sim.grid;
  return [g.sectorX(si), g.sectorY(si)];
}

function headOf(s) {
  return [slSnake.headX(s), slSnake.headY(s)];
}

// A seat with the stream mirror of test/slViewHarness.js fed with everything it is sent.
function seatFor(view, own) {
  const j = view.join(own);
  const mirror = createMirror(own);
  const ctx = { tick: view.sim.tick(), absAt: new Map(), iangAt: new Map(), mmSize: 136 };
  applyBundle(mirror, j.entries, ctx);
  return { seat: j.seat, mirror, join: j.entries, bundles: [] };
}

// One wake of k steps, then every seat's assemble (fed to its mirror). Returns the per-seat entries.
function wake(sim, view, seats, k) {
  const absAt = new Map();
  const iangAt = new Map();
  for (let i = 0; i < (k || 1); i++) {
    sim.applyInputs();
    const log = sim.step();
    const a = new Set();
    const g = new Map();
    for (const u of log.updates) {
      if (u.move) {
        g.set(u.id, u.iang);
        if (u.abs) a.add(u.id);
      }
    }
    absAt.set(log.tick, a);
    iangAt.set(log.tick, g);
    view.tick(log);
  }
  const out = [];
  for (const s of seats) {
    const e = view.assemble(s.seat);
    applyBundle(s.mirror, e, { tick: sim.tick(), absAt, iangAt, mmSize: 136 });
    s.bundles.push(e);
    out.push(e);
  }
  view.endWake();
  return out;
}

function noProblems(seats) {
  assert.deepEqual(seats.flatMap((s) => s.mirror.problems).slice(0, 8), []);
}

// ------------------------------------------------------------------ the law rows

test('slView laws: the values it reads (literals by law id) and the forms it refuses', () => {
  const V = SV.viewLaws(FIXTURE);
  assert.equal(V.anchorFromHead, true);
  assert.equal(V.anchorA, 48.2);
  assert.equal(V.anchorB, 7.66);
  assert.equal(V.r2Small, 13);
  assert.equal(V.r2Large, 20);
  assert.equal(V.r2StepSct, 92);
  assert.equal(V.sweepMs, 503.91);
  assert.equal(V.lingerMs, 2700);
  assert.equal(V.keepMs, 4400);
  assert.equal(V.lbMs, 3008.4);
  assert.equal(V.lbRows, 10);
  assert.equal(V.mmMs, 2504.2);
  assert.equal(V.mmSize, 136);
  assert.equal(V.zSlowMs, 1504.31);
  assert.equal(V.zFastMs, 127.43);
  assert.equal(V.zT, 2500);
  assert.equal(V.famRound, 'floor');
  assert.equal(V.angRound, 'floor');
  assert.equal(V.rotRefreshMs, 205);
  assert.equal(V.cashKill, false);
  assert.equal(V.quarantineMs, 30000);
  assert.equal(V.pv, 19);
  assert.equal(V.msl, 42);
  const lp = SV.viewLaws(makeFixture({ 'L8.anchor': Object.assign({}, FIXTURE['L8.anchor'].value, { from: 'lastPoint' }) }));
  assert.equal(lp.anchorFromHead, false);
  assert.equal(lp.anchorA, 69.24);
  assert.equal(lp.anchorB, 7.727);

  const v = (id) => FIXTURE[id].value;
  const refuse = (patch, re) => assert.throws(() => SV.viewLaws(makeFixture(patch)), re);
  refuse({ 'L48.order': ['rot', 'tailFam', 'move', 'foodEat', 'preyEat'] }, /L48\.order/);
  refuse({ C_SEND_6: true }, /C_SEND_6/);
  refuse({ C_FOOD_FULL_FORMS: false }, /C_FOOD_FULL_FORMS/);
  refuse({ C_LB_BOTS: false }, /C_LB_BOTS/);
  refuse({ L10: Object.assign({}, v('L10'), { firstFull: false }) }, /L10/);
  refuse({ 'L8.R2': Object.assign({}, v('L8.R2'), { recompute: 'always' }) }, /L8\.R2/);
  refuse({ L50: Object.assign({}, v('L50'), { died: 2 }) }, /L50/);
  refuse({ 'L8.anchor': Object.assign({}, v('L8.anchor'), { from: 'wantedAngle' }) }, /L8\.anchor/);
  refuse({ 'L11.cadence': Object.assign({}, v('L11.cadence'), { firstCheckAlways: false }) }, /L11\.cadence/);
  refuse({ 'L8.adds': Object.assign({}, v('L8.adds'), { emptySends: true }) }, /L8\.adds/);
  refuse({ 'L48.rot': Object.assign({}, v('L48.rot'), { angWhileTurning: false }) }, /L48\.rot/);
  refuse({ L9: Object.assign({}, v('L9'), { order: 'scoreDesc' }) }, /L9/);
  refuse({ C_CASHOUT_CODE: 3 }, /C_CASHOUT_CODE/);
  assert.throws(() => createView(FIXTURE, createSim(FIXTURE, { seed: 1 })), /border/);
});

test('slView wire bytes: every 8-bit grid angle is its own byte (slQuant.rotAng floor misses 22 of 256), uv as slWire', () => {
  let rotMiss = 0;
  for (let r = 0; r < 256; r++) {
    const a = r * 2 * Math.PI / 256;
    assert.equal(byte8(a, 'floor'), r);
    if (Q.rotAng(a, 'floor').raw !== r) rotMiss++;
  }
  assert.equal(rotMiss, 22);
  for (let b = 0; b <= 250; b++) assert.equal(byte8(Q.wangFromInput(b).v, 'floor'), Math.floor(256 * b / 251));
  assert.equal(byte8(0.01, 'floor'), 0); // floor(0.01 x 256 / 2 pi) = 0
  assert.equal(byte8(PI2 - 1e-9, 'floor'), 255);
  assert.equal(byte8(1.0, 'floor'), 40); // floor(40.74)
  assert.equal(byte8(1.0, 'round'), 41);
  for (const n of [0, 1, 127, 128, 255, 300, 16383, 16384, 65535, 2097152]) {
    const rec = W.encodeBundle([{ type: 'dead', code: n }], 19);
    assert.deepEqual(uvBytes(n), Array.from(rec.subarray(2)), 'uv ' + n);
  }
  const s13 = offsetsFor(13);
  const s20 = offsetsFor(20);
  assert.equal(s13.length, 45); // L8: R2 = 13 (45 sectors)
  assert.equal(s20.length, 69); // L8: R2 = 20 (69 sectors)
  assert.deepEqual(s13[0], [0, 0]);
  for (let i = 1; i < s20.length; i++) {
    const d = (o) => o[0] * o[0] + o[1] * o[1];
    assert.ok(d(s20[i]) >= d(s20[i - 1]), 'walk order: nearest first');
    assert.ok(d(s20[i]) <= 20);
  }
});

// ------------------------------------------------------------------ the join bundle

test('slView join: init, the own snake_add first, then only F, snake_add and prey_add over the whole 45-sector set', () => {
  const { sim, view } = world({ sim: { seed: 3, food: true } });
  const ids = [];
  for (let k = 0; k < 8; k++) ids.push(sim.spawn({ cv: k, nick: 'j' + k }).id);
  for (let t = 0; t < 30; t++) step(sim, view);
  const own = sim.snake(ids[0]);
  const { seat, entries } = view.join(own.id);
  const evs = decode(entries);
  assert.equal(evs[0].type, 'init');
  assert.equal(evs[0].pv, 19);
  assert.equal(evs[0].realSid, 0);
  assert.equal(evs[0].grd, C);
  assert.equal(evs[0].sectorSize, SS);
  assert.equal(evs[0].sectorCount, 102);
  assert.equal(evs[0].fluxGrd, sim.flux());
  assert.equal(evs[0].fluxGrd, 2923);
  const a = evs[1];
  assert.equal(a.type, 'snake_add');
  assert.equal(a.id, own.id);
  const [hx, hy] = headOf(own);
  assert.equal(a.snx, Math.round(5 * hx) / 5); // pos5: the continuous head, u24 / 5
  assert.equal(a.sny, Math.round(5 * hy) / 5);
  assert.equal(a.ang, Math.round(own.ang / PI2 * 16777215) * 2 * Math.PI / 16777215);
  assert.equal(a.sp, 5.79); // L20
  assert.equal(a.fam, Math.floor(Math.min(1, own.fam) * 16777215) / 16777215);
  assert.ok(a.raw.pts.length >= 2 && a.raw.pts[a.raw.pts.length - 1].iang !== undefined);
  const types = new Set(evs.slice(2).map((e) => e.type));
  for (const t of types) assert.ok(['food_sector', 'snake_add', 'prey_add'].includes(t), t);
  const m = view.mirror(seat);
  assert.equal(m.set.length, 45);
  assert.equal(m.kept.length, 45);
  const grid = sim.grid;
  const withFood = m.set.filter((si) => grid.foodCountIn(si) > 0).length;
  assert.equal(evs.filter((e) => e.type === 'food_sector').length, withFood, 'one F per non-empty sector, none for an empty one');
  assert.ok(withFood > 0 && withFood < 45);
  const want = [];
  sim.forEachSnake((s) => {
    if (m.set.some((si) => grid.countIn(si, s.id) > 0)) want.push(s.id);
  });
  assert.deepEqual(evs.filter((e) => e.type === 'snake_add').map((e) => e.id).sort((x, y) => x - y), want.sort((x, y) => x - y));
  const mir = createMirror(own.id);
  applyBundle(mir, entries, { tick: sim.tick(), absAt: new Map(), iangAt: new Map(), mmSize: 136 });
  assert.deepEqual(mir.problems, []);
});

test('slView L8.anchor: continuous head + (48.2 + 7.66 sp) along ang; the last-point row gives 69.24 + 7.727 sp', () => {
  // a fresh snake (d = 0) at x 31100 heading +x: 31100 + 92.55 = 31192.55 is sector 103, 31100 + 113.98 is sector 104
  for (const [from, sx] of [['continuousHead', 103], ['lastPoint', 104]]) {
    const laws = makeFixture({ 'L8.anchor': Object.assign({}, FIXTURE['L8.anchor'].value, { from }) });
    const { sim, view } = world({ laws });
    const s = sim.spawn({ x: 31100, y: C, ang: 0, cv: 1 });
    const { seat } = view.join(s.id);
    assert.deepEqual(sec(view, view.mirror(seat).anchor), [sx, 108], from);
  }
  // the anchor follows the head between updates: after n updates the head is n x 5.79 x 42.67 / 32 further on
  const { sim, view } = world();
  const s = sim.spawn({ x: 30800, y: C, ang: 0, cv: 1 });
  const seats = [seatFor(view, s.id)];
  for (let n = 1; n <= 80; n++) {
    wake(sim, view, seats, 1);
    const ax = 30800 + n * 5.79 * (P / 8) / 4 + 48.2 + 7.66 * 5.79;
    assert.equal(sec(view, view.mirror(seats[0].seat).anchor)[0], Math.floor(ax / SS), 'update ' + n);
  }
  noProblems(seats);
});

test('slView L8.R2: recomputed only when the anchor enters a new sector, R2 20 iff own sct >= 92 at that moment', () => {
  const { sim, view } = world();
  // sct 91 with fam 1: the first point (update 6) is a grow to 92; the anchor starts at x 30910 and reaches the next
  // sector edge 31200 only at update 36 (8.17 units per update at the L12 speed of sct 91)
  const s = sim.spawn({ x: 30910 - (48.2 + 7.66 * 6.125849056603773), y: C, ang: 0, cv: 1, sct: 91, fam: 1 });
  const seats = [seatFor(view, s.id)];
  let m = view.mirror(seats[0].seat);
  assert.equal(m.r2, 13);
  assert.equal(m.set.length, 45);
  let prev = m;
  let grewBeforeChange = false;
  let changes = 0;
  let to20 = false;
  let to13 = false;
  for (let t = 0; t < 300; t++) {
    if (t === 120) sim.setInput(s.id, { type: 'boost', on: true }, 0); // the first charge takes a point: sct 91
    if (t === 123) sim.setInput(s.id, { type: 'boost', on: false }, 0);
    wake(sim, view, seats, 1);
    m = view.mirror(seats[0].seat);
    const sct = sim.snake(s.id).pts.length;
    if (m.anchor === prev.anchor) {
      assert.equal(m.r2, prev.r2, 'R2 changed without an anchor sector change at tick ' + sim.tick());
      assert.deepEqual(m.set, prev.set);
      if (sct >= 92 && m.r2 === 13) grewBeforeChange = true;
    } else {
      changes++;
      assert.equal(m.r2, sct >= 92 ? 20 : 13, 'R2 at the recompute, sct ' + sct);
      assert.equal(m.set.length, m.r2 === 20 ? 69 : 45);
      if (prev.r2 === 13 && m.r2 === 20) to20 = true;
      if (prev.r2 === 20 && m.r2 === 13) to13 = true;
    }
    prev = m;
  }
  assert.ok(grewBeforeChange, 'sct 92 with R2 still 13 until the next anchor sector change');
  assert.ok(to20 && to13 && changes > 3, 'R2 stepped up at a change and back down after the snake shrank (L8.R2.shrink)');
  noProblems(seats);
});

test('slView L8.sweep and L8.linger: a sector out of the set goes at the first 503.91 ms sweep 2700 ms after, never sooner', () => {
  const { sim, view } = world({ sim: { food: true, seed: 5 } });
  const s = sim.spawn({ x: 30000, y: C + 10, ang: 0, cv: 2 });
  const seats = [seatFor(view, s.id)];
  const out = new Map(); // sector -> ms it left the set
  let prev = view.mirror(seats[0].seat);
  let removals = 0;
  let back = 0;
  for (let t = 0; t < 520; t++) {
    // turn round at tick 260: trailing sectors come back into the set before their sweep
    if (t === 260) sim.setInput(s.id, { type: 'angle', q: 125 }, 0);
    const [e] = wake(sim, view, seats, 1);
    const now = sim.nowMs();
    const m = view.mirror(seats[0].seat);
    for (const si of prev.set) if (!m.set.includes(si) && m.kept.includes(si)) out.set(si, now);
    for (const si of m.set) {
      if (out.has(si)) {
        back++;
        out.delete(si);
      }
    }
    const evs = decode(e);
    for (const ev of evs.filter((x) => x.type === 'sector_remove')) {
      const si = sim.grid.sectorIndex(ev.sx, ev.sy);
      assert.ok(out.has(si), 'removed a sector that was not lingering');
      const lingered = now - out.get(si);
      assert.ok(lingered >= 2700 && lingered < 2700 + 503.91 + P, 'lingered ' + lingered);
      // the sweep clock: the first step at or after k x 503.91 from the room start
      const k = Math.floor(now / 503.91);
      assert.ok(now - k * 503.91 < P, 'removal off the sweep clock at ' + now);
      out.delete(si);
      removals++;
    }
    for (const ev of evs.filter((x) => x.type === 'food_sector')) {
      assert.ok(!prev.kept.includes(sim.grid.sectorIndex(ev.sx, ev.sy)), 'F for a sector the seat kept');
    }
    prev = m;
  }
  assert.ok(removals > 5 && back > 0, removals + ' removals, ' + back + ' back in the set');
  noProblems(seats);
});

test('slView L8.snake: a snake with no pulled point in a kept sector is removed (code 0) at 4400 ms, not before', () => {
  const { sim, view } = world({ sim: { seed: 9 } });
  const a = sim.spawn({ x: C, y: C, ang: 0, cv: 1 });
  const b = sim.spawn({ x: C + 300, y: C + 60, ang: 0, cv: 2 });
  const seats = [seatFor(view, a.id)];
  assert.ok(view.mirror(seats[0].seat).snakes.includes(b.id));
  let firstUnseen = -1;
  let removedAt = -1;
  for (let t = 0; t < 330 && removedAt < 0; t++) {
    sim.setInput(a.id, { type: 'turn', dir: 'left', v: 20 }, 0); // a circles where it is
    const [e] = wake(sim, view, seats, 1);
    const m = view.mirror(seats[0].seat);
    const seen = m.kept.some((si) => sim.grid.countIn(si, b.id) > 0);
    if (!seen && firstUnseen < 0) firstUnseen = sim.nowMs();
    if (seen) firstUnseen = -1;
    const rm = decode(e).find((x) => x.type === 'snake_remove' && x.id === b.id);
    if (rm) {
      assert.equal(rm.kill, false);
      removedAt = sim.nowMs();
    } else if (m.snakes.includes(b.id) && firstUnseen >= 0) {
      assert.ok(sim.nowMs() - firstUnseen < 4400);
    }
  }
  assert.ok(sim.snake(b.id), 'b still alive (it left the view, it did not die)');
  assert.ok(firstUnseen >= 0 && removedAt - firstUnseen >= 4400 && removedAt - firstUnseen < 4400 + P,
    'removed ' + (removedAt - firstUnseen) + ' ms after it was first unwatched');
  noProblems(seats);
});

test('slView adds: a snake entering view in a 3-step wake gets its add and none of that wake\'s other records', () => {
  const { sim, view } = world({ sim: { seed: 4 } });
  const a = sim.spawn({ x: C, y: C, ang: 0, cv: 1 });
  const b = sim.spawn({ x: C - 2400, y: C + 40, ang: 0, cv: 3 });
  const seats = [seatFor(view, a.id)];
  assert.ok(!view.mirror(seats[0].seat).snakes.includes(b.id));
  let added = false;
  let laterMoves = 0;
  for (let t = 0; t < 120; t++) {
    sim.setInput(a.id, { type: 'turn', dir: 'left', v: 20 }, 0);
    const [e] = wake(sim, view, seats, 3);
    const evs = decode(e);
    const i = evs.findIndex((x) => x.type === 'snake_add' && x.id === b.id);
    if (i >= 0) {
      added = true;
      assert.equal(evs.filter((x) => (x.type === 'snake_move' || x.type === 'snake_rot' || x.type === 'snake_fam') && x.id === b.id).length, 0);
    } else if (added) {
      laterMoves += evs.filter((x) => x.type === 'snake_move' && x.id === b.id).length;
    }
  }
  assert.ok(added && laterMoves > 0);
  noProblems(seats);
});

test('slView snake_add: the client rebuilds the last point on the server head within 0.25, also while it is the absolute first point', () => {
  const K64A = 2 * Math.PI / 65536; // game.js:127, the 16-bit move angle
  for (const sct of [2, 5, 40]) {
    const { sim, view } = world({ sim: { seed: 20 + sct } });
    const own = sim.spawn({ x: C - 300, y: C - 300, ang: 0.3, cv: 1 });
    const s = sim.spawn({ x: C + 0.37, y: C + 0.81, ang: 1.234, cv: 2, sct });
    const { seat } = view.join(own.id);
    let absHead = 0;
    let headIsAbs = false;
    for (let t = 0; t < 16; t++) {
      const log = step(sim, view);
      const u = log.updates.find((r) => r.id === s.id);
      if (u.move) headIsAbs = u.abs;
      const add = decode(view.resync(seat)).find((x) => x.type === 'snake_add' && x.id === s.id);
      view.endWake();
      // the client's rebuild (slApply.js buildBody): x / 5, then (b - 127) / 2 steps, then msl along the iang
      const p = add.raw.pts;
      let x = p[0].x / 5;
      let y = p[0].y / 5;
      for (let i = 1; i < p.length - 1; i++) {
        x += (p[i].bx - 127) / 2;
        y += (p[i].by - 127) / 2;
      }
      x += Math.cos(p[p.length - 1].iang * K64A) * 42;
      y += Math.sin(p[p.length - 1].iang * K64A) * 42;
      const body = sim.snake(s.id).pts;
      const h = body[body.length - 1];
      const err = Math.max(Math.abs(x - h.xx), Math.abs(y - h.yy));
      assert.ok(err <= 0.25 + 1e-9, 'sct ' + sct + ' tick ' + sim.tick() + ': last point ' + err + ' off (head abs ' + headIsAbs + ')');
      if (headIsAbs) absHead++;
    }
    assert.ok(absHead > 0, 'the head was the absolute first point at some add');
  }
});

// ------------------------------------------------------------------ ends, kills, periodic records

test('slView deaths: own dead code 0 then own removal code 1 then the drops; code 1 to every holder; kill_count to the killer only', () => {
  const { sim, view } = world({ sim: { seed: 2, food: true, fill: false } });
  const a = sim.spawn({ x: C + 200, y: C, ang: 0, cv: 1, sct: 20 }); // body from x 31402 to 32750 along y = C
  const b = sim.spawn({ x: C - 100, y: C - 160, ang: Math.PI / 2, cv: 2 }); // heads down into a's body
  const far = sim.spawn({ x: C, y: C + 2200, ang: Math.PI, cv: 3 });
  const seats = [seatFor(view, a.id), seatFor(view, b.id), seatFor(view, far.id)];
  assert.ok(!view.mirror(seats[2].seat).snakes.includes(b.id));
  let death = null;
  for (let t = 0; t < 60 && !death; t++) {
    const [ea, eb, ef] = wake(sim, view, seats, 1);
    if (!sim.snake(b.id)) {
      death = { ea: decode(ea), eb: decode(eb), ef: decode(ef) };
    }
  }
  assert.ok(death, 'b ran into a');
  const { ea, eb, ef } = death;
  const i = eb.findIndex((x) => x.type === 'dead');
  assert.ok(i >= 0);
  assert.equal(eb[i].code, 0);
  assert.equal(eb[i + 1].type, 'snake_remove');
  assert.equal(eb[i + 1].id, b.id);
  assert.equal(eb[i + 1].kill, true);
  assert.ok(eb.slice(i + 2).filter((x) => x.type === 'food_add' && x.rapid === true).length > 0, 'the drops after the removal');
  assert.ok(!eb.some((x) => x.type === 'kill_count'));
  const ra = ea.find((x) => x.type === 'snake_remove' && x.id === b.id);
  assert.equal(ra.kill, true);
  const k = ea.find((x) => x.type === 'kill_count');
  assert.equal(k.id, a.id);
  assert.equal(k.count, 1);
  assert.equal(sim.snake(a.id).kills, 1);
  assert.ok(!ef.some((x) => x.type === 'snake_remove' || x.type === 'kill_count'), 'nothing to a seat that did not hold b');
  // after the own death: leaderboards with myPos 0 and the rank b had, no minimap
  const rankAtDeath = seats[1].seat.frozenRank;
  assert.ok(rankAtDeath >= 1);
  for (let t = 0; t < 160; t++) wake(sim, view, seats, 1);
  const after = seats[1].bundles.slice(-160).flatMap((e) => decode(e));
  const lbs = after.filter((x) => x.type === 'leaderboard');
  assert.ok(lbs.length >= 2);
  for (const l of lbs) {
    assert.equal(l.myPos, 0);
    assert.equal(l.rank, rankAtDeath);
  }
  assert.equal(after.filter((x) => x.type === 'minimap').length, 0);
  assert.ok(seats[0].bundles.slice(-160).flatMap((e) => decode(e)).some((x) => x.type === 'minimap'), 'others still get it');
  noProblems(seats);
});

test('slView cash-out: the own seat gets dead code 0 and its removal code 1, others C_CASHOUT_CODE 0, no drops', () => {
  const { sim, view } = world({ sim: { seed: 6, food: true, fill: false } });
  const a = sim.spawn({ x: C, y: C, ang: 0, cv: 1 });
  const b = sim.spawn({ x: C - 200, y: C + 100, ang: 0, cv: 2 });
  const seats = [seatFor(view, a.id), seatFor(view, b.id)];
  for (let t = 0; t < 5; t++) wake(sim, view, seats, 1);
  sim.remove(a.id); // the room's cash-out takes the snake out with no food (C_CASHOUT_CODE)
  const [ea, eb] = wake(sim, view, seats, 1).map(decode);
  const i = ea.findIndex((x) => x.type === 'dead');
  assert.equal(ea[i].code, 0);
  assert.deepEqual([ea[i + 1].type, ea[i + 1].id, ea[i + 1].kill], ['snake_remove', a.id, true]);
  const rb = eb.find((x) => x.type === 'snake_remove' && x.id === a.id);
  assert.equal(rb.kill, false);
  assert.ok(!ea.concat(eb).some((x) => x.type === 'food_add'), 'no drops');
  assert.equal(seats[0].seat.gone, true);
  noProblems(seats);
});

test('slView L10: the first image is a full M; later the smaller of M and V (long snakes: V); none after the own end', () => {
  const { sim, view } = world({ sim: { seed: 8 } });
  const own = sim.spawn({ x: C, y: C + 1200, ang: 0, cv: 1 });
  // four snakes of 40 points (1638 units) side by side heading +x: many lit pixels, few change in 2.5 s
  for (let k = 0; k < 4; k++) sim.spawn({ x: C - 1000, y: C - 600 + 400 * k, ang: 0, cv: k, sct: 40 });
  const seats = [seatFor(view, own.id)];
  const cmds = [];
  for (let t = 0; t < 180; t++) {
    sim.setInput(own.id, { type: 'turn', dir: 'left', v: 20 }, 0);
    const [e] = wake(sim, view, seats, 1);
    for (const ev of decode(e)) {
      if (ev.type !== 'minimap') continue;
      cmds.push(ev.cmd);
      // the client's image equals the raster of every pulled point now (L10 mapping, 136 px)
      const N = 136;
      const bits = new Uint8Array(N * N);
      sim.forEachSnake((s) => {
        for (const p of s.pts) {
          const x = Math.floor(67.5 * (1 + (p.xx - C) / sim.flux()));
          const y = Math.floor(67.5 * (1 + (p.yy - C) / sim.flux()));
          if (x >= 0 && x < N && y >= 0 && y < N) bits[y * N + x] = 1;
        }
      });
      assert.deepEqual(Array.from(seats[0].mirror.mm).join(''), Array.from(bits).join(''));
    }
  }
  assert.equal(cmds[0], 'M');
  assert.ok(cmds.includes('V'), 'V was smaller at least once: ' + cmds.join(''));
  sim.kill(own.id);
  let after = 0;
  for (let t = 0; t < 70; t++) after += decode(wake(sim, view, seats, 1)[0]).filter((x) => x.type === 'minimap').length;
  assert.equal(after, 0);
  noProblems(seats);
});

test('slView L11: the first check after the join sends z, then only an integer change; fast checks within 2500 of the border', () => {
  // 40 snakes: the target radius grows from 2923 (the start, C_R_MIN) by 6 per fast check, so z changes
  const { sim, view } = world({ sim: { seed: 10 } });
  const ids = [];
  for (let k = 0; k < 40; k++) ids.push(sim.spawn({ cv: k % 9 }).id);
  const centre = sim.spawn({ x: C, y: C, ang: 0, cv: 1 });
  const edge = sim.spawn({ x: C - 2700, y: C, ang: Math.PI / 2, cv: 2 });
  const seats = [seatFor(view, centre.id), seatFor(view, edge.id)];
  const z = [[], []];
  let slowAfter = 0;
  let due = 1504.31;
  for (let t = 0; t < 200; t++) {
    sim.setInput(centre.id, { type: 'turn', dir: 'left', v: 20 }, 0);
    sim.setInput(edge.id, { type: 'turn', dir: 'right', v: 20 }, 0);
    const es = wake(sim, view, seats, 1);
    const now = sim.nowMs();
    const slow = now >= due;
    if (slow) while (due <= now) due += 1504.31;
    for (let k = 0; k < 2; k++) {
      for (const ev of decode(es[k]).filter((x) => x.type === 'flux')) z[k].push({ v: ev.fluxGrd, t: sim.tick() });
      if (slow) {
        assert.equal(seats[k].mirror.lastFlux, sim.flux(), 'after a slow slot the seat holds the flux');
        slowAfter++;
      }
    }
  }
  assert.ok(sim.flux() > 2923);
  for (let k = 0; k < 2; k++) {
    assert.ok(z[k].length > 0);
    for (let i = 1; i < z[k].length; i++) assert.notEqual(z[k][i].v, z[k][i - 1].v, 'z only on an integer change');
  }
  // the first z of the centre seat comes at the first slow slot (tick 36: 36 x 42.67 >= 1504.31); the edge seat's
  // at the first fast check (tick 3: 3 x 42.67 >= 127.43) and then with every change
  assert.equal(z[0][0].t, 36);
  assert.equal(z[1][0].t, 3);
  assert.ok(z[1].length > 3 * z[0].length, z[1].length + ' z near the border against ' + z[0].length);
  assert.ok(slowAfter >= 8);
  noProblems(seats);
});

test('slView fam: an eat goes as h at the next update, first among that snake\'s records; a grow move carries fam; wire fam <= 1', () => {
  const { sim, view } = world();
  const a = sim.spawn({ x: C, y: C, ang: 0, cv: 1, sct: 10 });
  const b = sim.spawn({ x: C - 100, y: C + 200, ang: 0, cv: 2 });
  const seats = [seatFor(view, a.id), seatFor(view, b.id)];
  wake(sim, view, seats, 1);
  sim.feed(a.id, 30); // L18: fam += K b^2 mult
  const fam1 = sim.snake(a.id).fam;
  const [ea, eb] = wake(sim, view, seats, 1).map(decode);
  for (const evs of [ea, eb]) {
    const mine = evs.filter((x) => (x.own ? a.id : x.id) === a.id && /^snake_/.test(x.type));
    assert.equal(mine[0].type, 'snake_fam');
    assert.equal(mine[0].fam, Math.floor(fam1 * 16777215) / 16777215);
  }
  // past fam 1: h carries the clamped 1, the next move is a grow carrying fam - 1
  for (let i = 0; i < 40; i++) sim.feed(a.id, 60);
  assert.ok(sim.snake(a.id).fam > 1.5);
  let grow = null;
  let hMax = 0;
  for (let t = 0; t < 12 && !grow; t++) {
    const [e] = wake(sim, view, seats, 1);
    for (const ev of decode(e)) {
      if (ev.type === 'snake_fam' && ev.id === a.id) hMax = Math.max(hMax, ev.fam);
      if (ev.type === 'snake_move' && ev.own && ev.cmd === 'N') grow = ev;
    }
  }
  assert.equal(hMax, 1);
  assert.ok(grow && grow.fam > 0 && grow.fam <= 1);
  assert.equal(grow.fam, Math.floor(Math.min(1, sim.snake(a.id).fam) * 16777215) / 16777215);
  noProblems(seats);
});

// ------------------------------------------------------------------ rotation records (L48.rot)

test('slView L48.rot: a long turn sends dir+wang once, then ang alone every 205 ms or more; a late watcher gets dir first', () => {
  const { sim, view } = world({ sim: { seed: 12 } });
  const big = sim.spawn({ x: C, y: C, ang: 0, cv: 1, sct: 300 });
  const watch = sim.spawn({ x: C + 300, y: C + 300, ang: 0, cv: 2 });
  const seats = [seatFor(view, watch.id)];
  for (let t = 0; t < 3; t++) wake(sim, view, seats, 1);
  sim.setInput(big.id, { type: 'angle', q: 125 }, 0); // wang byte floor(256 x 125 / 251) = 127
  const recs = [];
  let late = null;
  let lateFirst = null;
  for (let t = 0; t < 80; t++) {
    if (t === 20) late = seatFor(view, sim.spawn({ x: C - 300, y: C - 300, ang: 0, cv: 3 }).id);
    const list = late ? seats.concat([late]) : seats;
    const es = wake(sim, view, list, 1);
    for (const ev of decode(es[0])) if (ev.type === 'snake_rot' && ev.id === big.id) recs.push({ ev, ms: sim.nowMs() });
    if (late && !lateFirst) {
      // the late watcher's first rotation record of the big snake carries dir and wang even though the shared one is
      // ang only
      lateFirst = decode(es[1]).find((x) => x.type === 'snake_rot' && x.id === big.id) || null;
      if (lateFirst) {
        assert.ok(lateFirst.dir !== undefined && lateFirst.wang === 127 * 2 * Math.PI / 256, JSON.stringify(lateFirst));
        assert.ok(lateFirst.ang !== undefined);
      }
    }
  }
  assert.ok(recs.length > 4);
  assert.ok(lateFirst, 'the late watcher got a rotation record');
  assert.equal(recs[0].ev.wang, 127 * 2 * Math.PI / 256);
  assert.ok(recs[0].ev.dir === 1 || recs[0].ev.dir === 2);
  assert.ok(recs[0].ev.ang !== undefined, 'ang while turning');
  for (let i = 1; i < recs.length; i++) {
    const ev = recs[i].ev;
    assert.deepEqual(Object.keys(ev).filter((k) => ['dir', 'ang', 'wang', 'sp'].includes(k)), ['ang']);
    assert.ok(recs[i].ms - recs[i - 1].ms >= 205, 'refresh after ' + (recs[i].ms - recs[i - 1].ms) + ' ms');
    assert.ok(recs[i].ms - recs[i - 1].ms < 205 + P);
  }
  noProblems(seats.concat([late]));
});

test('slView own echo: dir and wang the own client already holds are dropped from its tick record, others still get them', () => {
  const { sim, view } = world({ sim: { seed: 13 } });
  const a = sim.spawn({ x: C, y: C, ang: 0, cv: 1 });
  const b = sim.spawn({ x: C + 200, y: C + 200, ang: 0, cv: 2 });
  const seats = [seatFor(view, a.id), seatFor(view, b.id)];
  for (let t = 0; t < 3; t++) wake(sim, view, seats, 1);
  // the room on arrival: the input goes into the slot, the echo carries the wang byte and dir the step will apply
  sim.setInput(a.id, { type: 'angle', q: 60 }, 5);
  const w = Q.wangFromInput(60);
  const gap = slSnake.angleGap(w.v, sim.snake(a.id).ang);
  const echo = seats[0].seat.ownEcho(gap < 0 ? 1 : 2, w.v);
  applyBundle(seats[0].mirror, [echo], { tick: sim.tick(), absAt: new Map(), iangAt: new Map(), mmSize: 136 });
  assert.deepEqual(decode([echo])[0], { type: 'snake_rot', own: true, dir: 2, wang: w.raw * 2 * Math.PI / 256 });
  const [ea, eb] = wake(sim, view, seats, 1).map(decode);
  const ra = ea.filter((x) => x.type === 'snake_rot' && x.own);
  const rb = eb.filter((x) => x.type === 'snake_rot' && x.id === a.id);
  assert.equal(rb.length, 1);
  assert.equal(rb[0].dir, 2);
  assert.equal(rb[0].wang, w.raw * 2 * Math.PI / 256);
  for (const r of ra) assert.equal(r.wang, undefined, 'the own seat already holds the wang');
  noProblems(seats);
});

// ------------------------------------------------------------------ seats, resync, ids

test('slView seats: nothing of the ticks before a join; idBlocked while held and for 30000 ms after the end', () => {
  const { sim, view } = world({ sim: { seed: 14 } });
  const a = sim.spawn({ x: C, y: C, ang: 0, cv: 1 });
  const b = sim.spawn({ x: C + 200, y: C, ang: Math.PI / 2, cv: 2 });
  for (let t = 0; t < 5; t++) step(sim, view);
  const s = seatFor(view, a.id);
  const joinTick = sim.tick();
  const e = view.assemble(s.seat);
  for (const x of e) assert.ok(x.tick >= joinTick);
  assert.ok(!e.some((x) => x.type === 'snake_move'), 'no move of the ticks before the join');
  view.endWake();
  assert.equal(view.idBlocked(b.id), true, 'held by the seat');
  assert.equal(view.idBlocked(60000), false);
  sim.kill(b.id);
  wake(sim, view, [s], 1);
  assert.ok(!sim.snake(b.id));
  assert.equal(view.idBlocked(b.id), true, 'ended under 30000 ms ago');
  for (let t = 0; t < Math.ceil(30000 / P) + 2; t++) {
    sim.setInput(a.id, { type: 'turn', dir: 'left', v: 20 }, 0);
    wake(sim, view, [s], 1);
  }
  assert.equal(view.idBlocked(b.id), false);
  noProblems([s]);
});

test('slView resync: removals of everything held but the own snake, then the re-adds; the stream stays clean', () => {
  const { sim, view } = world({ sim: { seed: 15, food: true, prey: true } });
  const ids = [];
  for (let k = 0; k < 14; k++) ids.push(sim.spawn({ cv: k }).id);
  const seats = [seatFor(view, ids[0])];
  for (let t = 0; t < 200; t++) wake(sim, view, seats, 1);
  const before = view.mirror(seats[0].seat);
  const e = view.resync(seats[0].seat);
  view.endWake();
  applyBundle(seats[0].mirror, e, { tick: sim.tick(), absAt: new Map(), iangAt: new Map(), mmSize: 136 });
  const evs = decode(e);
  const rmSnakes = evs.filter((x) => x.type === 'snake_remove').map((x) => x.id);
  assert.deepEqual(rmSnakes.sort((x, y) => x - y), before.snakes.filter((id) => id !== ids[0]).sort((x, y) => x - y));
  assert.equal(evs.filter((x) => x.type === 'sector_remove').length, before.kept.length);
  assert.ok(!evs.some((x) => x.type === 'init'));
  const after = view.mirror(seats[0].seat);
  assert.deepEqual(after.lingering, [], 'a fresh set: nothing lingers');
  const want = [];
  sim.forEachSnake((sn) => {
    if (sn.id === ids[0] || after.kept.some((si) => sim.grid.countIn(si, sn.id) > 0)) want.push(sn.id);
  });
  assert.deepEqual(after.snakes.slice().sort((x, y) => x - y), want.sort((x, y) => x - y));
  assert.equal(after.hasMap, false, 'the next minimap is full');
  for (let t = 0; t < 200; t++) wake(sim, view, seats, 1);
  noProblems(seats);
});

// ------------------------------------------------------------------ the room's contract

test('slView room contract: createWorld and createSeatView (join, collect, noteOwnRot, resync) on the room frames', () => {
  const sim = createSim(FIXTURE, { seed: 16, world: true, prey: false });
  const w = createWorld(FIXTURE, sim);
  const a = sim.spawn({ x: C, y: C, ang: 0, cv: 1 });
  const b = sim.spawn({ x: C + 200, y: C + 100, ang: 0, cv: 2 });
  const va = createSeatView(FIXTURE, { sim, world: w, ownId: a.id });
  const vb = createSeatView(FIXTURE, { sim, world: w, ownId: b.id });
  const ja = va.join({ tick: sim.tick(), simMs: sim.nowMs(), flux: sim.flux(), frames: [], dead: false });
  vb.join({});
  assert.equal(ja[0].type, 'init');
  assert.equal(ja[1].type, 'snake_add');
  assert.equal(ja[1].id, a.id);
  const none = { lb: false, mm: false, zSlow: false, zFast: false, sweep: false };
  const frame = (o) => Object.assign({ tick: sim.tick() + 1, locks: [], cashed: [], clocks: none, board: null }, o);
  const run = (o) => {
    sim.applyInputs();
    const f = frame(o);
    f.log = sim.step();
    w.afterStep(f);
    return f;
  };
  // the room's clocks drive the records: nothing periodic without them
  run();
  let ea = va.collect({});
  assert.ok(!ea.some((e) => e.type === 'leaderboard' || e.type === 'minimap' || e.type === 'flux'));
  // the L9 step with the room's order (count 99 proves the room's count is the one sent)
  const order = [];
  sim.forEachSnake((s) => order.push({ id: s.id, sct: s.pts.length, fam: s.fam, nick: s.nick, cv: s.cv }));
  order.sort(SV.lbCompare);
  run({ clocks: Object.assign({}, none, { lb: true, mm: true, zSlow: true }), board: { order, count: 99, rows: 10 } });
  ea = va.collect({});
  const lb = ea.find((e) => e.type === 'leaderboard');
  assert.equal(lb.count, 99);
  assert.equal(lb.rows.length, 2);
  assert.ok(lb.rank >= 1 && lb.rank <= 2 && lb.myPos === lb.rank);
  assert.equal(ea.find((e) => e.type === 'minimap').cmd, 'M');
  assert.equal(ea.find((e) => e.type === 'flux').fluxGrd, sim.flux());
  // a hold lock (the room's record) is the snake's one rotation record of that step for every holder
  sim.setHold(a.id, 1, 0);
  const raw = Q.rotAng(sim.snake(a.id).ang, 'floor').raw;
  const lock = { type: 'snake_rot', id: a.id, dir: 1, ang: raw * PI2 / 256, wang: raw * PI2 / 256 };
  run({ locks: [lock] });
  const rb = vb.collect({}).filter((e) => e.type === 'snake_rot' && e.id === a.id);
  assert.equal(rb.length, 1);
  assert.deepEqual([rb[0].dir, rb[0].ang, rb[0].wang], [1, lock.ang, lock.wang]);
  va.collect({});
  sim.setHold(a.id, null, 0);
  // noteOwnRot: the own seat drops dir and wang it already holds from the room's echo
  run();
  va.collect({});
  vb.collect({});
  sim.setInput(a.id, { type: 'angle', q: 200 }, 0);
  const wv = Q.wangFromInput(200);
  const dir = slSnake.angleGap(wv.v, sim.snake(a.id).ang) < 0 ? 1 : 2;
  va.noteOwnRot({ dir, wangRaw: wv.raw });
  run();
  const ownRot = va.collect({}).filter((e) => e.type === 'snake_rot' && e.id === a.id);
  for (const r of ownRot) assert.equal(r.wang, undefined);
  assert.ok(vb.collect({}).some((e) => e.type === 'snake_rot' && e.id === a.id && e.wang === wv.raw * PI2 / 256));
  // resync: forget, then the next collect re-adds (no init, no removals: the queue makes those)
  va.resync();
  const again = va.collect({ frames: [] });
  assert.ok(again.some((e) => e.type === 'snake_add' && e.id === b.id));
  assert.ok(again.some((e) => e.type === 'food_sector'));
  assert.ok(!again.some((e) => e.type === 'init' || e.type === 'snake_remove' || e.type === 'sector_remove'));
  assert.equal(va.mirror().snakes.includes(a.id), true);
  // a seat the room stopped collecting (it closed; the contract has no leave call) is let go after 4 x C_MAX_STEPS
  // (16) steps, so the snakes it held are no longer pinned; a late collect gets nothing
  const c = sim.spawn({ x: C - 300, y: C, ang: 0, cv: 3 });
  const vc = createSeatView(FIXTURE, { sim, world: w, ownId: c.id });
  vc.join({});
  for (let t = 0; t < 16; t++) {
    run();
    va.collect({});
    vb.collect({});
  }
  assert.equal(w.view.seats().length, 3, 'still 3 seats after 16 steps');
  run();
  va.collect({});
  vb.collect({});
  assert.equal(w.view.seats().length, 2, 'the stale seat went at the 17th');
  assert.deepEqual(vc.collect({}), []);
  assert.equal(w.view.stats().staleSeats, 1);
  // room mode needs the room's clocks on every step
  sim.applyInputs();
  const log = sim.step();
  assert.throws(() => w.afterStep({ tick: log.tick, log, locks: [], cashed: [], clocks: null }), /frame clocks/);
  assert.throws(() => createSeatView(FIXTURE, { sim, world: null, ownId: a.id }), /world/);
});

test('slView record bytes: every entry is encodeBundle([ev]) minus its version byte at pv 19 (leaderboards too)', () => {
  const { sim, view } = world({ sim: { seed: 17, food: true } });
  const ids = [];
  for (let k = 0; k < 10; k++) ids.push(sim.spawn({ cv: k, nick: 'r' + k }).id);
  const seats = [seatFor(view, ids[0]), seatFor(view, ids[1])];
  let lbs = 0;
  for (let t = 0; t < 150; t++) {
    const es = wake(sim, view, seats, 1);
    for (const e of es) {
      for (const x of e) {
        const want = encodeRecord(x.ev, x.own, 19);
        assert.deepEqual(Array.from(x.rec), Array.from(want), x.type);
        if (x.type === 'leaderboard') lbs++;
      }
    }
  }
  assert.ok(lbs >= 4);
  noProblems(seats);
});
