'use strict';
// slBots (SERVER-DESIGN 11, 18.1; task T12): our own bots for the free slither room. On the FIXTURE table.
// Brain determinism, inputs inside the client gates (in a fake world and in the live sim), the three personalities,
// fill = curve minus humans, retire only unseen, the pacer, the governor on a fake timer (refuses addBot while engaged
// and above the cap), the loop probe, skins, names, spawns outside human views, and the file's own hygiene.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const B = require('../server/sl/slBots');
const { createSim } = require('../server/sl/slSim');
const { createRng } = require('../server/sl/slRng');
const W = require('../shared/slWire');
const C = require('../shared/constants');
const { FIXTURE, makeFixture } = require('./slLawsFixture');

const SRC = path.join(__dirname, '../server/sl/slBots.js');
const K = B.brainLaws(FIXTURE);
const P = FIXTURE.L7.value; // 42.67

// ---------------------------------------------------------------------------------------------------------------
// A small fake world (the sense contract of createBotSense).

// A snake whose head is at (x, y) heading ang, len points msl apart trailing behind it (tail first, as the sim holds).
function snakeAt(id, x, y, ang, len, opt) {
  const o = opt || {};
  const pts = [];
  for (let i = len - 1; i >= 0; i--) pts.push({ xx: x - Math.cos(ang) * 42 * i, yy: y - Math.sin(ang) * 42 * i });
  return { id, alive: true, hx: x, hy: y, ang, sp: o.sp || 5.79, sc: o.sc || 1, fam: 0, pts };
}

function fakeSense(world) {
  const w = Object.assign({ grd: 1000, flux: 900, snakes: [], foods: [] }, world);
  return {
    grd: w.grd,
    flux: () => w.flux,
    snake: (id) => w.snakes.find((s) => s.id === id) || null,
    forEachSnake: (fn) => w.snakes.forEach(fn),
    forEachPointNear: (x, y, r, fn) => {
      for (const s of w.snakes) for (const p of s.pts) if (Math.abs(p.xx - x) <= r && Math.abs(p.yy - y) <= r) fn(p, s.id);
    },
    forEachFoodNear: (x, y, r, fn) => {
      let n = 0;
      for (const f of w.foods) {
        if (Math.hypot(f.x - x, f.y - y) <= r) {
          fn(f);
          n++;
        }
      }
      return n;
    },
  };
}

// Steps a brain `ticks` updates; returns every record with its tick time.
function drive(brain, self, sense, ticks, t0) {
  const recs = [];
  const out = [];
  for (let t = 0; t < ticks; t++) {
    const tickMs = (t0 || 0) + (t + 1) * P;
    brain.step(self, tickMs, sense, out);
    for (const o of out) recs.push({ tickMs, rec: o.rec, offsetMs: o.offsetMs });
  }
  return recs;
}

function lastAngle(recs) {
  for (let i = recs.length - 1; i >= 0; i--) if (recs[i].rec.type === 'angle') return recs[i].rec.q;
  return null;
}

// The heading of an angle byte, as the server reads it back (L15: 2 pi floor(256 q / 251) / 256), in (-pi, pi].
function byteAngle(q) {
  let a = (2 * Math.PI * Math.floor((256 * q) / 251)) / 256;
  if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

// Checks the client gates on one bot's records: offsets in [0, P), angle bytes 0..250 sent only on change and more
// than 33 ms apart, boost changes alternating and more than 50 ms apart, nothing else. Returns the violation count.
function gateViolations(recs) {
  let bad = 0;
  let lastA = -Infinity;
  let lastB = -Infinity;
  let lastQ = -1;
  let on = false;
  for (const r of recs) {
    const t = r.tickMs - r.offsetMs;
    if (!(r.offsetMs >= 0 && r.offsetMs < P)) bad++;
    if (r.rec.type === 'angle') {
      if (!Number.isInteger(r.rec.q) || r.rec.q < 0 || r.rec.q > 250 || r.rec.q === lastQ) bad++;
      if (!(t - lastA > 33)) bad++;
      lastA = t;
      lastQ = r.rec.q;
    } else if (r.rec.type === 'boost') {
      if (r.rec.on === on) bad++;
      if (!(t - lastB > 50)) bad++;
      lastB = t;
      on = r.rec.on;
    } else {
      bad++;
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------------------------------------------
// Hygiene.

test('tuning: every number CHOSEN with a note; no other number, Math.random, Date or fixture in the code', () => {
  for (const k of Object.keys(B.BOT_TUNING)) {
    const e = B.BOT_TUNING[k];
    assert.equal(e.status, 'CHOSEN', k);
    assert.ok(typeof e.value === 'number' && Number.isFinite(e.value), k);
    assert.ok(typeof e.note === 'string' && e.note.length > 10, k);
  }
  const src = fs.readFileSync(SRC, 'utf8');
  const code = src.replace(/\/\/.*$/gm, '');
  assert.ok(!/Math\.random|Date\.now|new Date/.test(code), 'no Math.random or Date');
  assert.ok(!/slLawsFixture/.test(src), 'never imports the fixture');
  const cut = (s, a, b) => {
    const i = s.indexOf(a);
    const j = s.indexOf(b);
    assert.ok(i > 0 && j > i, a);
    return s.slice(0, i) + s.slice(j);
  };
  const rest = cut(cut(src, '// BEGIN BOT_TUNING', '// END BOT_TUNING'), '// BEGIN DATA', '// END DATA')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  const nums = (rest.match(/(?<![\w.])\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) || []).filter((n) => !['0', '1', '2'].includes(n));
  assert.deepEqual(nums, [], 'numbers outside BOT_TUNING and DATA: ' + nums.join(', '));
});

test('imports: only the law table, the streams and botTarget; never registerRoom; no money code', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const reqs = (src.match(/require\('([^']+)'\)/g) || []).map((s) => s.slice(9, -2));
  assert.deepEqual(reqs, ['./slLaws', './slRng', '../botPopulation']);
  const code = src.replace(/\/\/.*$/gm, '');
  assert.ok(!/registerRoom|unregisterRoom/.test(code), 'the sl room never takes a share of the event bot budget (Q21)');
  assert.ok(!/money|wallet|escrow|stake|usdc|payout|\bdb\b/i.test(code), 'no money words in the code');
  const pop = fs.readFileSync(path.join(__dirname, '../server/botPopulation.js'), 'utf8');
  const popReqs = (pop.match(/require\('([^']+)'\)/g) || []).map((s) => s.slice(9, -2));
  assert.deepEqual(popReqs, ['../shared/constants'], 'botTarget brings no money module with it');
});

// ---------------------------------------------------------------------------------------------------------------
// Personalities, laws, angle bytes.

test('personalities: agar shares 0.6 casual, 0.15 hunter, 0.25 shy; drawPersonality follows them', () => {
  assert.equal(B.personalityProfile('casual').SHARE, 0.6);
  assert.equal(B.personalityProfile('hunter').SHARE, 0.15);
  assert.equal(B.personalityProfile('shy').SHARE, 0.25);
  assert.equal(B.personalityProfile('boss'), null);
  const r = createRng(11);
  const n = { casual: 0, hunter: 0, shy: 0 };
  for (let i = 0; i < 20000; i++) n[B.drawPersonality(r)]++;
  assert.ok(Math.abs(n.casual / 20000 - 0.6) < 0.015, 'casual ' + n.casual);
  assert.ok(Math.abs(n.hunter / 20000 - 0.15) < 0.015, 'hunter ' + n.hunter);
  assert.ok(Math.abs(n.shy / 20000 - 0.25) < 0.015, 'shy ' + n.shy);
});

test('brain laws by id: L1, L7, L15, L22, L35, BOT_KINDS, BOT_GATES; a labelled or wrong kind list is refused', () => {
  assert.equal(K.grd, 32550);
  assert.equal(K.P, 42.67);
  assert.equal(K.maxAngle, 250);
  assert.equal(K.steps, 251);
  assert.equal(K.minL, 2.14);
  assert.equal(K.a, 14.5);
  assert.equal(K.angleMs, 33);
  assert.equal(K.boostMs, 50);
  const kinds = FIXTURE.BOT_KINDS.value;
  assert.throws(() => B.brainLaws(makeFixture({ BOT_KINDS: Object.assign({}, kinds, { label: true }) })), /BOT_KINDS/);
  assert.throws(() => B.brainLaws(makeFixture({ BOT_KINDS: Object.assign({}, kinds, { personalities: ['casual', 'hunter'] }) })),
    /BOT_KINDS/);
  assert.throws(() => B.createBotBrain(1, 'boss', FIXTURE), /personality/);
  assert.throws(() => B.createBotBrain(NaN, 'casual', FIXTURE), /seed/);
});

test('angleByte is the client expression floor(251 a / 2 pi) on [0, 2 pi)', () => {
  assert.equal(B.angleByte(K, 0), 0);
  assert.equal(B.angleByte(K, Math.PI), 125);
  assert.equal(B.angleByte(K, 0.49), 19);
  assert.equal(B.angleByte(K, -0.1), 247);
  assert.equal(B.angleByte(K, 2 * Math.PI), 0);
  assert.equal(B.angleByte(K, 2 * Math.PI - 1e-15), 250);
  assert.equal(B.angleByte(K, 7 * Math.PI), 125);
});

// ---------------------------------------------------------------------------------------------------------------
// The brain in a fake world.

test('casual: heads for food ahead and sends the angle byte of it', () => {
  const me = snakeAt(1, 1000, 1000, 0, 5);
  const sense = fakeSense({ snakes: [me], foods: [{ id: 9, x: 1150, y: 1000, b: 50 }] });
  const brain = B.createBotBrain(3, 'casual', FIXTURE);
  const recs = drive(brain, me, sense, 10);
  assert.equal(brain.mode(), 'food');
  const q = lastAngle(recs);
  assert.ok(q >= 245 || q <= 5, 'q ' + q); // 0 +- the casual aim error 0.15
  assert.equal(gateViolations(recs), 0);
});

test('food behind a body is skipped and the bot turns away from the body', () => {
  const me = snakeAt(1, 1000, 1000, 0, 5);
  const wall = { id: 2, alive: true, hx: 1100, hy: 1300, ang: Math.PI / 2, sp: 5.79, sc: 1, fam: 0, pts: [] };
  for (let y = 700; y <= 1300; y += 20) wall.pts.push({ xx: 1100, yy: y });
  for (let seed = 1; seed <= 20; seed++) {
    const sense = fakeSense({ snakes: [me, wall], foods: [{ id: 9, x: 1200, y: 1000, b: 80 }] });
    const brain = B.createBotBrain(seed, 'casual', FIXTURE);
    const recs = drive(brain, me, sense, 7);
    assert.equal(brain.mode(), 'wander', 'seed ' + seed);
    assert.ok(Math.abs(byteAngle(lastAngle(recs))) > 1.0, 'seed ' + seed + ' q ' + lastAngle(recs));
  }
});

test('shy: turns away from a bigger body; casual does not', () => {
  const me = snakeAt(1, 1000, 1000, 0, 5);
  const big = snakeAt(2, 1150, 600, -Math.PI / 2, 40); // a body along x = 1150 from y 600 to 2238, 150 east of the head
  const sense = fakeSense({ snakes: [me, big] });
  const shy = B.createBotBrain(4, 'shy', FIXTURE);
  const recs = drive(shy, me, sense, 6);
  assert.equal(shy.mode(), 'flee');
  const q = lastAngle(recs);
  assert.ok(q >= 121 && q <= 129, 'q ' + q); // west, pi +- the shy aim error 0.1
  const casual = B.createBotBrain(4, 'casual', FIXTURE);
  drive(casual, me, sense, 7);
  assert.notEqual(casual.mode(), 'flee');
  assert.equal(casual.stats().flee, 0);
});

test('hunter: cuts in front of a clearly smaller snake and boosts; never chases one not 1.5 x smaller', () => {
  const me = snakeAt(1, 1000, 1000, 0, 40);
  const small = snakeAt(2, 1300, 1000, Math.PI / 2, 10);
  const brain = B.createBotBrain(5, 'hunter', FIXTURE);
  const recs = drive(brain, me, fakeSense({ snakes: [me, small] }), 40);
  assert.equal(brain.mode(), 'hunt');
  assert.ok(brain.stats().chases >= 1);
  const a = byteAngle(lastAngle(recs));
  assert.ok(a > 0.35 && a < 0.65, 'aim ' + a); // atan2(160, 300) = 0.49: 160 ahead of the prey head
  assert.ok(recs.some((r) => r.rec.type === 'boost' && r.rec.on === true), 'short boost');
  assert.equal(gateViolations(recs), 0);
  const peer = snakeAt(2, 1300, 1000, Math.PI / 2, 30); // 40 / 30 < 1.5
  const b2 = B.createBotBrain(5, 'hunter', FIXTURE);
  drive(b2, me, fakeSense({ snakes: [me, peer] }), 40);
  assert.equal(b2.stats().chases, 0);
  const tiny = snakeAt(1, 1000, 1000, 0, 15); // under HUNT_MIN_L 20: no chase
  const b3 = B.createBotBrain(5, 'hunter', FIXTURE);
  drive(b3, tiny, fakeSense({ snakes: [tiny, snakeAt(2, 1300, 1000, Math.PI / 2, 3)] }), 40);
  assert.equal(b3.stats().chases, 0);
});

test('the border: outside 0.92 of the radius the bot heads for the middle', () => {
  const me = snakeAt(1, 1000 + 850, 1000, 0, 5);
  const brain = B.createBotBrain(6, 'casual', FIXTURE);
  const recs = drive(brain, me, fakeSense({ snakes: [me] }), 7);
  assert.equal(brain.mode(), 'border');
  const q = lastAngle(recs);
  assert.ok(q >= 119 && q <= 130, 'q ' + q);
  assert.throws(() => drive(B.createBotBrain(6, 'casual', FIXTURE), me, fakeSense({ snakes: [me], flux: null }), 7), /border/);
});

test('brain determinism: the same seed and world give the same records; another seed does not', () => {
  const run = (seed) => {
    const me = snakeAt(1, 1000, 1000, 0, 30);
    const foods = [];
    const r = createRng(99);
    for (let i = 0; i < 60; i++) foods.push({ id: i, x: 400 + r.int(1200), y: 400 + r.int(1200), b: 20 + r.int(60) });
    const sense = fakeSense({ snakes: [me, snakeAt(2, 1300, 1000, Math.PI / 2, 10), snakeAt(3, 700, 800, 0, 50)], foods });
    const brain = B.createBotBrain(seed, 'hunter', FIXTURE);
    const recs = drive(brain, me, sense, 300);
    return recs.map((x) => x.tickMs.toFixed(2) + ':' + x.rec.type + (x.rec.q === undefined ? '' : x.rec.q) +
      (x.rec.on === undefined ? '' : x.rec.on) + '@' + x.offsetMs.toFixed(6)).join(',') + '|' + brain.rngState();
  };
  const a = run(77);
  assert.ok(a.length > 50);
  assert.ok(a === run(77), 'same seed, same records');
  assert.ok(a !== run(78), 'another seed, other records');
});

test('gates in a fake world: a goal that moves every update still keeps 33 ms and 50 ms', () => {
  const me = snakeAt(1, 1000, 1000, 0, 60);
  const prey = snakeAt(2, 1250, 1000, 0, 5);
  const sense = fakeSense({ snakes: [me, prey] });
  const brain = B.createBotBrain(8, 'hunter', FIXTURE);
  const recs = [];
  const out = [];
  for (let t = 0; t < 2000; t++) {
    prey.ang = (t * 0.7) % (2 * Math.PI); // the cut point swings round every update
    prey.hx = 1000 + 250 * Math.cos(t * 0.05);
    prey.hy = 1000 + 250 * Math.sin(t * 0.05);
    const tickMs = (t + 1) * P;
    brain.step(me, tickMs, sense, out);
    for (const o of out) recs.push({ tickMs, rec: o.rec, offsetMs: o.offsetMs });
  }
  assert.ok(recs.filter((r) => r.rec.type === 'angle').length > 100);
  assert.ok(recs.filter((r) => r.rec.type === 'boost').length >= 2);
  assert.equal(gateViolations(recs), 0);
  const dead = Object.assign({}, me, { alive: false });
  assert.equal(brain.step(dead, 1e6, sense, out).length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// The live sim: bots exactly as the room drives them.

function liveRun(seed, nBots, ticks) {
  const sim = createSim(FIXTURE, { seed, border: true, food: true });
  const sense = B.createBotSense(sim);
  const names = B.createNameBook();
  const bots = new Map();
  const kinds = {};
  const all = [];
  const add = () => {
    const spec = B.drawBotSpec(sim.rng.bot, FIXTURE, names);
    const s = B.spawnBot(sim, spec, null);
    const b = { brain: B.createBotBrain(spec.seed, spec.personality, FIXTURE), spec, s, recs: [] };
    bots.set(s.id, b);
    all.push(b);
  };
  for (let i = 0; i < nBots; i++) add();
  const out = [];
  let wireBad = 0;
  for (let t = 0; t < ticks; t++) {
    const tickMs = sim.nowMs() + P;
    for (const [id, b] of bots) {
      b.brain.step(b.s, tickMs, sense, out);
      for (const o of out) {
        b.recs.push({ tickMs, rec: o.rec, offsetMs: o.offsetMs });
        const back = W.decodeInput(W.encodeInput([o.rec]));
        if (back.length !== 1 || back[0].type !== o.rec.type || back[0].q !== o.rec.q || back[0].on !== o.rec.on) wireBad++;
        assert.equal(sim.setInput(id, o.rec, o.offsetMs), true);
      }
    }
    sim.applyInputs();
    const log = sim.step();
    for (const d of log.deaths) {
      const b = bots.get(d.id);
      if (b) {
        names.release(b.spec.nick);
        bots.delete(d.id);
      }
    }
    while (bots.size < nBots) add();
  }
  for (const b of all) {
    const k = kinds[b.spec.personality] || (kinds[b.spec.personality] = {});
    const st = b.brain.stats();
    for (const key of Object.keys(st)) k[key] = (k[key] || 0) + st[key];
  }
  return { sim, all, kinds, wireBad };
}

test('live sim: 40 bots for 3000 updates keep the client gates, send valid wire records, show all three personalities', () => {
  const r = liveRun(21, 40, 3000);
  let bad = 0;
  let n = 0;
  for (const b of r.all) {
    bad += gateViolations(b.recs);
    n += b.recs.length;
  }
  assert.ok(n > 10000, 'records ' + n);
  assert.equal(bad, 0);
  assert.equal(r.wireBad, 0);
  assert.ok(r.kinds.hunter.chases > 0 && r.kinds.hunter.boosts > 0, 'hunters chase and boost');
  assert.ok(r.kinds.shy.flee > 0 && r.kinds.shy.boosts === 0, 'shy bots turn away and never boost');
  assert.ok(r.kinds.casual.food > 0 && r.kinds.casual.hunt === 0, 'casual bots eat and never chase');
  assert.equal(r.sim.check().length, 0);
});

test('live sim determinism: the same room seed gives the same world twice', () => {
  const a = liveRun(5, 20, 600);
  const b = liveRun(5, 20, 600);
  assert.ok(a.sim.digest() === b.sim.digest());
  const c = liveRun(6, 20, 600);
  assert.ok(a.sim.digest() !== c.sim.digest());
});

// ---------------------------------------------------------------------------------------------------------------
// Fill.

test('fill = curve minus humans (BOT_FILL), held to the cap; the curve is botTarget (22 to 101)', () => {
  const f = (o) => B.planBotFill(o, FIXTURE);
  assert.deepEqual(f({ target: 22, humans: 0, bots: 0 }), { want: 22, add: 22, remove: 0 });
  assert.deepEqual(f({ target: 101, humans: 30, bots: 80 }), { want: 71, add: 0, remove: 9 });
  assert.deepEqual(f({ target: 50, humans: 60, bots: 3 }), { want: 0, add: 0, remove: 3 });
  assert.deepEqual(f({ target: 101, humans: 10, bots: 0, cap: 80 }), { want: 70, add: 70, remove: 0 });
  assert.deepEqual(f({ target: 101, humans: 100, bots: 5, cap: 80 }), { want: 0, add: 0, remove: 5 });
  assert.deepEqual(f({ target: 40, humans: 4, bots: 36, cap: null }), { want: 36, add: 0, remove: 0 });
  assert.throws(() => f({ target: -1, humans: 0, bots: 0 }), /target/);
  assert.throws(() => f({ target: 1.5, humans: 0, bots: 0 }), /target/);
  assert.throws(() => B.planBotFill({ target: 1, humans: 0, bots: 0 }, makeFixture({ BOT_FILL: { rule: 'toRoomSize' } })), /rule/);
  // botTarget at fixed wall times (Eastern clock; literals from server/botPopulation.js as it stands)
  assert.equal(B.curveTarget(1791615600000), 34); // 2026-10-10 03:00 ET
  assert.equal(B.curveTarget(1791649800000), 72); // 12:30 ET
  assert.equal(B.curveTarget(1791677700000), 99); // 20:15 ET
  assert.equal(B.curveTarget(1791684000000), 85); // 22:00 ET
  assert.equal(C.BOT_MIN, 22);
  assert.equal(C.BOT_MAX, 101);
  for (let h = 0; h < 48; h++) {
    const t = B.curveTarget(1791604800000 + h * 1800000);
    assert.ok(t >= 22 && t <= 101, 'hour ' + h / 2 + ': ' + t);
  }
  assert.throws(() => B.curveTarget(undefined), /wall clock/);
});

test('pickRetiree: the shortest unseen bot, ties to the lower id; null when all are seen; force takes a seen one', () => {
  const s = (id, len, fam) => ({ id, pts: new Array(len), fam });
  const bots = [s(5, 30, 0.5), s(3, 10, 0.2), s(9, 10, 0.2), s(4, 8, 0)];
  assert.equal(B.pickRetiree(bots, () => false).id, 4);
  assert.equal(B.pickRetiree(bots, (id) => id === 4).id, 3);
  assert.equal(B.pickRetiree(bots, (id) => id === 4 || id === 3).id, 9);
  assert.equal(B.pickRetiree(bots, () => true), null);
  assert.equal(B.pickRetiree(bots, () => true, true).id, 4);
});

test('pacer: one change per 125 ms, real players replace bots, retire only unseen, forced only over the cap', () => {
  const fill = B.createBotFill(FIXTURE);
  const calls = [];
  const unseen = { id: 7 };
  const retiree = (force) => {
    calls.push(force);
    return unseen;
  };
  assert.deepEqual(fill.step(0, { target: 22, humans: 0, bots: 0, retiree }), { op: 'add', want: 22 });
  assert.equal(fill.step(42.67, { target: 22, humans: 0, bots: 1, retiree }), null);
  assert.equal(fill.step(124.99, { target: 22, humans: 0, bots: 1, retiree }), null);
  assert.deepEqual(fill.step(125, { target: 22, humans: 0, bots: 1, retiree }), { op: 'add', want: 22 });
  assert.equal(fill.step(1000, { target: 22, humans: 0, bots: 22, retiree }), null);
  assert.deepEqual(fill.step(2000, { target: 22, humans: 5, bots: 22, retiree }), { op: 'remove', id: 7, want: 17, forced: false });
  assert.equal(fill.step(2100, { target: 22, humans: 5, bots: 21, retiree }), null);
  assert.equal(fill.step(2200, { target: 22, humans: 5, bots: 21, retiree: () => null }), null); // every bot seen
  assert.deepEqual(fill.step(2300, { target: 22, humans: 5, bots: 21, cap: 20, retiree }),
    { op: 'remove', id: 7, want: 15, forced: true });
  assert.deepEqual(calls, [false, true]);
  // the governor's multiplier lowers the target (floor), never below the humans
  assert.deepEqual(fill.step(3000, { target: 100, humans: 0, bots: 90, mult: 0.9, retiree }), null);
  assert.deepEqual(fill.step(4000, { target: 100, humans: 0, bots: 91, mult: 0.9, retiree }), { op: 'remove', id: 7, want: 90, forced: false });
  assert.deepEqual(fill.step(5000, { target: 100, humans: 3, bots: 0, mult: 0, retiree }), null);
  assert.throws(() => fill.step(6000, { target: 100, humans: 0, bots: 0, mult: 1.5 }), /mult/);
  assert.deepEqual(fill.stats(), { adds: 2, removes: 3, blocked: 1, forced: 1 });
});

// ---------------------------------------------------------------------------------------------------------------
// The governor (C_GOV) on a fake timer.

const calm = (o) => Object.assign({ loopP99Ms: 0, sliceMaxMs: 0, paidPlayers: 0, paid: [] }, o);
const near = (a, b) => Math.abs(a - b) < 1e-12;

test('governor: engages over 15 ms loop p99, steps 0.9 every 30 s, refuses addBot while engaged, recovers under half', () => {
  const g = B.createBotGovernor(FIXTURE);
  assert.equal(g.sample(0, calm({ loopP99Ms: 10, sliceMaxMs: 3 })), null);
  assert.equal(g.mult(), 1);
  assert.deepEqual(g.admitBot({ snakes: 50, cap: 200 }), { ok: true, why: '' });
  assert.equal(g.sample(1000, calm({ loopP99Ms: 16 })), 'engaged');
  assert.ok(g.engaged() && near(g.mult(), 0.9));
  assert.deepEqual(g.admitBot({ snakes: 50, cap: 200 }), { ok: false, why: 'governor' });
  assert.equal(g.sample(2000, calm({ loopP99Ms: 10 })), null); // between half and the threshold: still engaged
  assert.equal(g.sample(30999, calm({ loopP99Ms: 10 })), null);
  assert.equal(g.sample(31000, calm({ loopP99Ms: 10 })), 'down');
  assert.ok(near(g.mult(), 0.81));
  assert.equal(g.sample(32000, calm({ loopP99Ms: 7, sliceMaxMs: 5, paid: [{ latePct: 3, baselinePct: 2.6 }] })), 'recovered');
  assert.equal(g.engaged(), false);
  assert.deepEqual(g.admitBot({ snakes: 50, cap: 200 }), { ok: true, why: '' });
  assert.equal(g.sample(61999, calm()), null);
  assert.equal(g.sample(62000, calm()), 'up');
  assert.ok(near(g.mult(), 0.9));
  assert.equal(g.sample(92000, calm()), 'up');
  assert.equal(g.mult(), 1);
  assert.equal(g.sample(200000, calm()), null);
  const st = g.stats();
  assert.equal(st.engagements, 1);
  assert.equal(st.steps, 2);
  assert.equal(st.why, 'loop');
});

test('governor: slice over 2 x 6 ms, paid late share over baseline + 1 point, thresholds halved with paid players', () => {
  const at = (inp) => B.createBotGovernor(FIXTURE).sample(0, calm(inp));
  assert.equal(at({ sliceMaxMs: 12 }), null);
  assert.equal(at({ sliceMaxMs: 12.5 }), 'engaged');
  assert.equal(at({ paid: [{ latePct: 4, baselinePct: 3 }] }), null);
  assert.equal(at({ paid: [{ latePct: 2, baselinePct: 3 }, { latePct: 4.1, baselinePct: 3 }] }), 'engaged');
  assert.equal(at({ loopP99Ms: 15 }), null);
  assert.equal(at({ loopP99Ms: 8 }), null);
  assert.equal(at({ loopP99Ms: 8, paidPlayers: 1 }), 'engaged'); // 7.5 while paid
  assert.equal(at({ sliceMaxMs: 6.5, paidPlayers: 2 }), 'engaged'); // 6 while paid
  assert.equal(at({ paid: [{ latePct: 3.6, baselinePct: 3 }], paidPlayers: 1 }), 'engaged'); // 0.5 point while paid
  assert.throws(() => at({ loopP99Ms: NaN }), /loopP99Ms/);
  assert.throws(() => at({ paidPlayers: -1 }), /paidPlayers/);
});

test('governor: addBot refused above the cap even when calm; cap null means none yet', () => {
  const g = B.createBotGovernor(FIXTURE);
  assert.deepEqual(g.admitBot({ snakes: 199, cap: 200 }), { ok: true, why: '' });
  assert.deepEqual(g.admitBot({ snakes: 200, cap: 200 }), { ok: false, why: 'cap' });
  assert.deepEqual(g.admitBot({ snakes: 500, cap: null }), { ok: true, why: '' });
  g.sample(0, calm({ loopP99Ms: 20 }));
  assert.deepEqual(g.admitBot({ snakes: 0, cap: 200 }), { ok: false, why: 'governor' });
});

test('loop probe: p99 in ms over a 30 s window, the last whole window kept until the next one ends', () => {
  const mon = {
    v: 0,
    resets: 0,
    percentile(p) {
      assert.equal(p, 99);
      return this.v;
    },
    reset() {
      this.v = 0;
      this.resets++;
    },
  };
  const probe = B.createLoopProbe(mon, FIXTURE);
  mon.v = 5e6;
  assert.equal(probe.read(0), 5);
  mon.v = 8e6;
  assert.equal(probe.read(29999), 8);
  assert.equal(probe.read(30000), 8);
  assert.equal(mon.resets, 1);
  mon.v = 2e6;
  assert.equal(probe.read(45000), 8);
  assert.equal(probe.read(60000), 2);
  mon.v = NaN;
  assert.equal(probe.read(61000), 2);
  assert.throws(() => B.createLoopProbe({}, FIXTURE), /monitorEventLoopDelay/);
});

// ---------------------------------------------------------------------------------------------------------------
// New bots.

test('skins: uniform over the shipped 0 to 65; the 12 picture skins only with the PICTURE_SKINS switch on', () => {
  const off = B.botSkins(FIXTURE);
  assert.equal(off.length, 54);
  assert.ok(off.includes(0) && off.includes(65) && !off.includes(66));
  for (const cv of B.PICTURE_SKIN_CVS) assert.ok(!off.includes(cv), 'picture skin ' + cv + ' while off');
  // fixer pass (2026-10-10): one switch for all 12, so on needs every file reviewed; anything else is refused
  const ALL = ['kwk6.png', 'jmou3.png', 'pewd.png', 'sest5.png', 'play.png', 'bonkers2.png', 'leaf.png', 'swiss.png',
    'moldova.png', 'vietnam.png', 'argentina.png', 'mov2.png'];
  assert.deepEqual(Array.from(B.PICTURE_FILES), ALL);
  const skinsJs = fs.readFileSync(path.join(__dirname, '../public/js/slx/slxSkins.js'), 'utf8');
  assert.deepEqual([...skinsJs.matchAll(/\['\w+', '([\w.]+\.png)', (?:true|false)\]/g)].map((m) => m[1]), ALL, 'the layer loads the same 12 files');
  assert.throws(() => B.botSkins(makeFixture({ PICTURE_SKINS: { on: true, reviewed: [] } })), /not every picture file is reviewed/);
  assert.throws(() => B.botSkins(makeFixture({ PICTURE_SKINS: { on: true, reviewed: ALL.slice(1) } })), /kwk6.png/);
  assert.throws(() => B.botSkins(makeFixture({ PICTURE_SKINS: { on: false, reviewed: ['x.png'] } })), /not one of the 12/);
  assert.throws(() => B.botSkins(makeFixture({ PICTURE_SKINS: { on: false } })), /reviewed list/);
  assert.equal(B.botSkins(makeFixture({ PICTURE_SKINS: { on: false, reviewed: ALL.slice(0, 3) } })).length, 54, 'a partial review keeps it off');
  const on = B.botSkins(makeFixture({ PICTURE_SKINS: { on: true, reviewed: ALL } }));
  assert.equal(on.length, 66);
  // the frozen client names the same 12 picture skins and the same last skin
  const spr = fs.readFileSync(path.join(__dirname, '../public/js/sl/slSprites.js'), 'utf8');
  assert.ok(spr.includes('(skins 37, 39-42, 45-49, 59, 62)'));
  assert.deepEqual(Array.from(B.PICTURE_SKIN_CVS), [37, 39, 40, 41, 42, 45, 46, 47, 48, 49, 59, 62]);
  assert.ok(spr.includes('Body colour lists of skins 9..65'));
  assert.equal(B.SKIN_MAX, 65);
  // a draw never lands on a picture skin while off, and reaches every allowed one
  const r = createRng(3);
  const names = B.createNameBook();
  const seen = new Set();
  for (let i = 0; i < 20000; i++) {
    const spec = B.drawBotSpec(r, FIXTURE, names);
    assert.ok(!B.PICTURE_SKIN_CVS.includes(spec.cv));
    seen.add(spec.cv);
    names.release(spec.nick);
  }
  assert.equal(seen.size, 54);
});

test('names: ordinary, unique, more than BOT_MAX, each passes their name rules and the frozen gdnm, no bot label', () => {
  require('../shared/slCore.js');
  require('../public/js/sl/slApply.js');
  const A = globalThis.DuelSlither.slApply;
  A.initApplyState({});
  const list = B.BOT_NAMES;
  assert.equal(new Set(list).size, list.length);
  assert.ok(list.length > C.BOT_MAX, 'names ' + list.length);
  for (const n of list) {
    assert.ok(typeof n === 'string' && n.length >= 1 && n.length <= 24, n);
    for (let i = 0; i < n.length; i++) assert.ok(n.charCodeAt(i) >= 32 && n.charCodeAt(i) <= 126, n);
    assert.notEqual(n.toLowerCase(), 'gameweek2016');
    assert.equal(A.gdnm(n), true, n);
    assert.ok(!/bot|slither\.?io/i.test(n), n);
  }
});

test('name book: free names first, reused only when none is free, released on leave', () => {
  const book = B.createNameBook(['a', 'b', 'c']);
  const r = createRng(1);
  const got = [book.take(r), book.take(r), book.take(r)];
  assert.deepEqual(got.slice().sort(), ['a', 'b', 'c']);
  assert.ok(['a', 'b', 'c'].includes(book.take(r)));
  book.release('b');
  book.release('b');
  book.release('zzz');
  assert.equal(book.take(r), 'b');
  assert.throws(() => B.createNameBook([]), /names/);
});

test('drawBotSpec: seed, personality, skin, name in that order, four draws from the bot stream', () => {
  const r1 = createRng(5);
  const s1 = B.drawBotSpec(r1, FIXTURE, B.createNameBook());
  const r2 = createRng(5);
  for (let i = 0; i < 4; i++) r2.next();
  assert.equal(r1.state(), r2.state());
  const r3 = createRng(5);
  const s3 = B.drawBotSpec(r3, FIXTURE, B.createNameBook());
  assert.deepEqual(s1, s3);
  assert.ok(Number.isInteger(s1.seed) && s1.seed >= 0 && s1.seed < 4294967296);
  assert.ok(B.PERSONALITIES.includes(s1.personality));
  assert.ok(B.BOT_NAMES.includes(s1.nick));
});

test('spawnBot: on an L42 ring, outside every human view set when possible; the last draw stays', () => {
  const sim = createSim(FIXTURE, { seed: 4, border: true });
  const grd = FIXTURE.L1.value;
  for (let i = 0; i < 30; i++) {
    const s = B.spawnBot(sim, { cv: 3, nick: 'x' }, (x, y) => x < grd && y < grd); // one quarter seen
    assert.ok(!(s.hx < grd && s.hy < grd), 'spawn ' + i + ' at ' + s.hx + ', ' + s.hy);
  }
  assert.equal(sim.count(), 30);
  const s = B.spawnBot(sim, { cv: 3, nick: 'x' }, () => true);
  assert.ok(sim.snake(s.id));
  assert.equal(sim.count(), 31);
  assert.equal(sim.check().length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// The room's bot driver, on a real sim behind a small host (the slRoom surface it reads).

function makeHost(laws, seed, wall) {
  const sim = createSim(laws, { seed, border: true, food: true });
  const seen = new Set();
  const host = {
    sim,
    wall,
    now: () => host.wall,
    playerCount: 0,
    spawnSnake: (spec) => {
      assert.equal(spec.isBot, true);
      return sim.spawn({ cv: spec.cv, nick: spec.nick });
    },
    names: new Map(),
    freedAt: new Map(),
    world: { idBlocked: (id) => host.allSeen || seen.has(id) },
    seats: new Map(),
    allSeen: false,
    _botsPausedUntil: 0,
  };
  return { host, sim, seen };
}

function steps(driver, host, n, each) {
  for (let i = 0; i < n; i++) {
    driver.beforeInputs(host, host.sim.nowMs() + P);
    host.sim.applyInputs();
    const log = host.sim.step();
    driver.afterStep(host, log, host.sim.nowMs());
    if (each) each(i);
  }
}

test('driver: fills to the curve one bot per 125 ms, humans replace bots, retire only unseen, forced over the cap', () => {
  const { host, sim } = makeHost(FIXTURE, 31, 1791615600000); // curve 34
  const recs = [];
  const driver = B.createBotDriver(FIXTURE, { onRecord: (id, rec, offsetMs, tickMs) => recs.push({ id, rec, offsetMs, tickMs }) });
  let most = 0;
  steps(driver, host, 60, () => {
    most = Math.max(most, driver.count());
  });
  assert.equal(most, 20); // 60 updates of 42.67 ms = 2560 ms, one add per 3 updates (128 ms)
  steps(driver, host, 120, () => {
    most = Math.max(most, driver.count());
  });
  assert.equal(most, 34);
  assert.ok(driver.count() >= 32, 'deaths are refilled: ' + driver.count());
  assert.equal(driver.stats().names, driver.count());
  // gates and the wire, per bot
  const byBot = new Map();
  for (const r of recs) {
    if (!byBot.has(r.id)) byBot.set(r.id, []);
    byBot.get(r.id).push(r);
  }
  let bad = 0;
  for (const list of byBot.values()) bad += gateViolations(list);
  assert.ok(recs.length > 500);
  assert.equal(bad, 0);
  // ten humans: bots go down to 24, unseen ones only
  host.playerCount = 10;
  steps(driver, host, 60);
  assert.ok(driver.count() <= 25 && driver.count() >= 22, 'after humans joined: ' + driver.count());
  // every bot seen: none is retired, however many humans
  host.allSeen = true;
  host.playerCount = 20;
  const before = driver.count();
  const blocked0 = driver.stats().blocked;
  steps(driver, host, 30);
  assert.ok(driver.count() <= before);
  assert.ok(driver.stats().blocked > blocked0);
  assert.equal(driver.stats().removes, driver.stats().kinds.casual.retired + driver.stats().kinds.hunter.retired +
    driver.stats().kinds.shy.retired);
  for (const id of host.names.keys()) assert.ok(!driver.isBot(id) || sim.snake(id));
  assert.equal(sim.check().length, 0);
});

test('driver: over the room cap a seen bot yields to the humans at once', () => {
  const laws = makeFixture({ C_ROOM_CAP: 30 });
  const { host } = makeHost(laws, 32, 1791649800000); // curve 72, capped at 30
  const driver = B.createBotDriver(laws);
  steps(driver, host, 120);
  assert.equal(driver.count(), 30);
  host.allSeen = true;
  host.playerCount = 10; // 10 + 30 > 30: bots yield even though every one is seen
  steps(driver, host, 90);
  assert.ok(driver.count() <= 21, 'bots ' + driver.count());
  assert.ok(driver.stats().forced >= 9);
});

test('driver: hand-added bots are refused while the governor is engaged; manual bots stay; clear and its pause', () => {
  const { host, sim } = makeHost(FIXTURE, 33, 1791615600000);
  const gov = B.createBotGovernor(FIXTURE);
  const driver = B.createBotDriver(FIXTURE, { governor: gov });
  const rec = driver.add(host);
  assert.ok(rec && driver.isBot(rec.id) && sim.snake(rec.id));
  rec.manual = true; // the console marks it (server/index.js:1258)
  steps(driver, host, 150);
  assert.equal(driver.count(), 35); // 34 from the curve plus the hand-added one
  gov.sample(0, calm({ loopP99Ms: 20 }));
  assert.equal(driver.add(host), null);
  const n = driver.count();
  steps(driver, host, 30); // engaged: no adds (deaths are not refilled), the target is 0.9 x 34 = 30 (floor)
  assert.ok(driver.count() <= n);
  const left = driver.count();
  assert.equal(driver.clear(host), left);
  assert.equal(driver.count(), 0);
});

test('driver: clear removes every bot and the console pause keeps the room empty until it ends', () => {
  const { host, sim } = makeHost(FIXTURE, 34, 1791615600000);
  const driver = B.createBotDriver(FIXTURE);
  steps(driver, host, 120);
  const n = driver.count();
  assert.ok(n > 30);
  assert.equal(driver.clear(host), n);
  assert.equal(driver.count(), 0);
  assert.equal(sim.count(), 0);
  assert.equal(host.names.size, 0);
  host._botsPausedUntil = host.wall + 600000;
  steps(driver, host, 60);
  assert.equal(driver.count(), 0);
  host.wall += 600000;
  steps(driver, host, 60);
  assert.equal(driver.count(), 20);
});

test('driver determinism: the same room seed and clock give the same world twice', () => {
  const run = (seed) => {
    const { host, sim } = makeHost(FIXTURE, seed, 1791677700000);
    const driver = B.createBotDriver(FIXTURE);
    steps(driver, host, 400, (i) => {
      if (i === 200) host.playerCount = 7;
    });
    return sim.digest() + ':' + driver.count() + ':' + JSON.stringify(driver.stats().kinds);
  };
  const a = run(41);
  assert.ok(a === run(41));
  assert.ok(a !== run(42));
});
