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
const { monitorEventLoopDelay } = require('perf_hooks');

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

test('imports: only the law table, the streams, botTarget and the name pool; never registerRoom; no money code', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const reqs = (src.match(/require\('([^']+)'\)/g) || []).map((s) => s.slice(9, -2));
  // perf_hooks: the loop probe's busy share; ../botNames: the shared bot names (data and a generator, no requires)
  assert.deepEqual(reqs, ['./slLaws', './slRng', '../botPopulation', '../botNames', 'perf_hooks']);
  const names = fs.readFileSync(path.join(__dirname, '../server/botNames.js'), 'utf8');
  assert.equal((names.match(/require\(/g) || []).length, 0, 'the name pool brings no module with it');
  const code = src.replace(/\/\/.*$/gm, '');
  assert.ok(!/registerRoom|unregisterRoom/.test(code), 'the sl room never takes a share of the event bot budget (Q21)');
  assert.ok(!/money|wallet|escrow|stake|usdc|payout|\bdb\b/i.test(code), 'no money words in the code');
  const pop = fs.readFileSync(path.join(__dirname, '../server/botPopulation.js'), 'utf8');
  const popReqs = (pop.match(/require\('([^']+)'\)/g) || []).map((s) => s.slice(9, -2));
  assert.deepEqual(popReqs, ['../shared/constants'], 'botTarget brings no money module with it');
});

// ---------------------------------------------------------------------------------------------------------------
// Personalities, laws, angle bytes.

test('personalities: 0.55 casual, 0.25 hunter, 0.2 shy (more hunters, Owen 2026-10-16); drawPersonality follows them', () => {
  assert.equal(B.personalityProfile('casual').SHARE, 0.55);
  assert.equal(B.personalityProfile('hunter').SHARE, 0.25);
  assert.equal(B.personalityProfile('shy').SHARE, 0.2);
  assert.equal(B.personalityProfile('boss'), null);
  const r = createRng(11);
  const n = { casual: 0, hunter: 0, shy: 0 };
  for (let i = 0; i < 20000; i++) n[B.drawPersonality(r)]++;
  assert.ok(Math.abs(n.casual / 20000 - 0.55) < 0.015, 'casual ' + n.casual);
  assert.ok(Math.abs(n.hunter / 20000 - 0.25) < 0.015, 'hunter ' + n.hunter);
  assert.ok(Math.abs(n.shy / 20000 - 0.2) < 0.015, 'shy ' + n.shy);
  // who does what: casual bots chase only far smaller snakes and rarely; only hunters coil; shy bots never chase
  assert.ok(B.personalityProfile('casual').HUNT_RATIO > B.personalityProfile('hunter').HUNT_RATIO);
  assert.ok(B.personalityProfile('casual').CHASE_CHANCE < B.personalityProfile('hunter').CHASE_CHANCE);
  assert.deepEqual(B.PERSONALITIES.map((p) => B.personalityProfile(p).COILS), [0, 1, 0]);
  assert.equal(B.personalityProfile('shy').HUNTS, 0);
  for (const p of B.PERSONALITIES) assert.equal(B.personalityProfile(p).SCAVENGES, 1, p);
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

test('hunter: cuts in front of a clearly smaller snake at the intercept point and boosts; never chases one not 1.5 x smaller', () => {
  const me = snakeAt(1, 1000, 1000, 0, 40);
  const small = snakeAt(2, 1300, 1000, Math.PI / 2, 10);
  const brain = B.createBotBrain(5, 'hunter', FIXTURE);
  const recs = drive(brain, me, fakeSense({ snakes: [me, small] }), 40);
  assert.equal(brain.mode(), 'hunt');
  assert.ok(brain.stats().chases >= 1);
  // the intercept: 300 away at the same speed, so the aim point is 300 ahead of the prey head, atan2(300, 300)
  const a = byteAngle(lastAngle(recs));
  assert.ok(a > 0.66 && a < 0.92, 'aim ' + a);
  assert.ok(recs.some((r) => r.rec.type === 'boost' && r.rec.on === true), 'short boost');
  assert.ok(brain.stats().chaseBoosts >= 1, 'a chase boost');
  assert.equal(gateViolations(recs), 0);
  // a faster hunter needs less lead: boosting at 14 against 5.79, the aim point is 300 x 5.79 / 14 = 124 ahead
  const fast = Object.assign(snakeAt(1, 1000, 1000, 0, 40), { sp: 14 });
  const b4 = B.createBotBrain(5, 'hunter', FIXTURE);
  const r4 = drive(b4, fast, fakeSense({ snakes: [fast, small] }), 40);
  const a4 = byteAngle(lastAngle(r4));
  assert.ok(a4 > 0.25 && a4 < 0.55, 'aim with the speed ratio ' + a4); // atan2(124, 300) = 0.39
  // a snake holding Q to cash out (steering locked, crawling) is never prey, and a chase on one that starts holding ends
  const holder = Object.assign(snakeAt(2, 1300, 1000, Math.PI / 2, 10), { holdMult: 0.5 });
  const bh = B.createBotBrain(5, 'hunter', FIXTURE);
  drive(bh, me, fakeSense({ snakes: [me, holder] }), 40);
  assert.equal(bh.stats().chases, 0, 'no chase on a cash-out');
  const later = snakeAt(2, 1300, 1000, Math.PI / 2, 10);
  const bl = B.createBotBrain(5, 'hunter', FIXTURE);
  const sl = fakeSense({ snakes: [me, later] });
  drive(bl, me, sl, 20);
  assert.equal(bl.mode(), 'hunt');
  later.holdMult = 0.7333;
  drive(bl, me, sl, 20, 20 * P);
  assert.notEqual(bl.mode(), 'hunt', 'the chase ends when it starts holding');
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

const boosted = (recs) => recs.some((r) => r.rec.type === 'boost' && r.rec.on === true);

test('flee: every personality turns away from a bigger head aimed at it and boosts; not from one aimed elsewhere or smaller', () => {
  for (const p of B.PERSONALITIES) {
    for (let seed = 1; seed <= 5; seed++) {
      const me = snakeAt(1, 1000, 1000, 0, 30);
      const big = snakeAt(2, 1150, 1000, Math.PI, 80); // 150 east, heading straight at the bot head
      const brain = B.createBotBrain(seed, p, FIXTURE);
      const recs = drive(brain, me, fakeSense({ snakes: [me, big] }), 8);
      assert.equal(brain.mode(), 'flee', p + ' seed ' + seed);
      assert.ok(Math.cos(byteAngle(lastAngle(recs))) < 0, p + ' seed ' + seed + ' runs west, away from it');
      assert.ok(boosted(recs) && brain.stats().fleeBoosts >= 1, p + ' seed ' + seed + ' boosts away');
      assert.equal(gateViolations(recs), 0);
    }
  }
  // the same snake heading north (not at the bot), and a smaller one heading straight at it: no flee for casual
  const me = snakeAt(1, 1000, 1000, 0, 30);
  for (const other of [snakeAt(2, 1150, 1000, -Math.PI / 2, 80), snakeAt(2, 1150, 1000, Math.PI, 10)]) {
    const brain = B.createBotBrain(3, 'casual', FIXTURE);
    drive(brain, me, fakeSense({ snakes: [me, other] }), 8);
    assert.notEqual(brain.mode(), 'flee');
    assert.equal(brain.stats().fleeBoosts, 0);
  }
  // a bigger head cutting across in front of it (aimed 140 ahead of the head, not at it) counts too
  for (let seed = 1; seed <= 5; seed++) {
    const cutter = snakeAt(2, 1140, 1150, -Math.PI / 2, 80);
    const brain = B.createBotBrain(seed, 'casual', FIXTURE);
    drive(brain, me, fakeSense({ snakes: [me, cutter] }), 8);
    assert.equal(brain.mode(), 'flee', 'seed ' + seed);
    assert.ok(brain.stats().fleeBoosts >= 1, 'seed ' + seed + ' (205 away, under FLEE_BOOST_RANGE)');
  }
  // too short to boost at all (BOOST_MIN_L): it still turns away, without boosting
  const tiny = snakeAt(1, 1000, 1000, 0, 8);
  const b2 = B.createBotBrain(4, 'shy', FIXTURE);
  const r2 = drive(b2, tiny, fakeSense({ snakes: [tiny, snakeAt(2, 1150, 1000, Math.PI, 80)] }), 8);
  assert.equal(b2.mode(), 'flee');
  assert.ok(!boosted(r2));
});

test('the wall: a bot outside 0.97 of the radius boosts once it is turned inward; outside the battle royale circle too', () => {
  const inward = snakeAt(1, 1000 + 880, 1000, Math.PI, 30);
  const b1 = B.createBotBrain(6, 'casual', FIXTURE);
  const r1 = drive(b1, inward, fakeSense({ snakes: [inward] }), 7);
  assert.equal(b1.mode(), 'border');
  assert.ok(boosted(r1) && b1.stats().panicBoosts >= 1, 'sprints back in');
  // still facing out: it turns first (a boost would only widen the turn)
  const outward = snakeAt(1, 1000 + 880, 1000, 0, 30);
  const b2 = B.createBotBrain(6, 'casual', FIXTURE);
  const r2 = drive(b2, outward, fakeSense({ snakes: [outward] }), 7);
  assert.equal(b2.mode(), 'border');
  assert.ok(!boosted(r2) && b2.stats().panicBoosts === 0);
  // inside 0.97: no sprint
  const near = snakeAt(1, 1000 + 850, 1000, Math.PI, 30);
  const b3 = B.createBotBrain(6, 'casual', FIXTURE);
  drive(b3, near, fakeSense({ snakes: [near] }), 7);
  assert.equal(b3.stats().panicBoosts, 0);
  // the battle royale circle: outside it at all, turned inward, every personality sprints
  for (const p of B.PERSONALITIES) {
    const me = snakeAt(1, 1000 + 600, 1000, Math.PI, 30);
    const sense = Object.assign(fakeSense({ snakes: [me] }), { zone: () => ({ x: 1000, y: 1000, r: 500 }) });
    const b = B.createBotBrain(2, p, FIXTURE);
    const r = drive(b, me, sense, 7);
    assert.equal(b.mode(), 'border', p);
    assert.ok(boosted(r) && b.stats().panicBoosts >= 1, p + ' sprints back into the circle');
  }
});

test('coil: a hunter close to and ahead of a much smaller snake circles its head; casual bots never coil', () => {
  let coiled = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const me = snakeAt(1, 1000, 1000, 0, 100);
    const prey = snakeAt(2, 850, 1000, 0, 10); // 150 behind the hunter head, heading at it: the hunter is ahead
    const brain = B.createBotBrain(seed, 'hunter', FIXTURE);
    drive(brain, me, fakeSense({ snakes: [me, prey] }), 60);
    if (brain.mode() === 'coil') coiled++;
    assert.ok(brain.stats().chases >= 1, 'seed ' + seed);
    const casual = B.createBotBrain(seed, 'casual', FIXTURE);
    drive(casual, me, fakeSense({ snakes: [me, prey] }), 60);
    assert.equal(casual.stats().coils, 0);
  }
  assert.ok(coiled >= 8, 'hunters coiled in ' + coiled + ' of 10');
  // behind the prey (it heads away): a chase, not a coil
  const me = snakeAt(1, 1000, 1000, 0, 100);
  const away = snakeAt(2, 1150, 1000, 0, 10);
  const b = B.createBotBrain(2, 'hunter', FIXTURE);
  drive(b, me, fakeSense({ snakes: [me, away] }), 60);
  assert.equal(b.stats().coils, 0);
});

test('piles: a fresh big death pile draws a bot over with a boost; a stale, small or guarded one does not', () => {
  const pile = (at, size) => [{ at, size, pts: [1500, 1000, 1520, 1010] }];
  for (const p of B.PERSONALITIES) {
    const me = snakeAt(1, 1000, 1000, 0, 30);
    const b = B.createBotBrain(9, p, FIXTURE);
    const r = drive(b, me, Object.assign(fakeSense({ snakes: [me] }), { piles: () => pile(0, 120) }), 8);
    assert.equal(b.mode(), 'pile', p);
    const a = byteAngle(lastAngle(r));
    assert.ok(Math.abs(a) < 0.25, p + ' heads for it: ' + a);
    assert.ok(boosted(r) && b.stats().pileBoosts >= 1, p + ' boosts to a big one');
  }
  const me = snakeAt(1, 1000, 1000, 0, 30);
  const run = (piles, others) => {
    const b = B.createBotBrain(9, 'casual', FIXTURE);
    drive(b, me, Object.assign(fakeSense({ snakes: [me].concat(others || []) }), { piles: () => piles }), 8);
    return b;
  };
  assert.notEqual(run(pile(-10000, 120)).mode(), 'pile', 'stale');
  assert.notEqual(run(pile(0, 20)).mode(), 'pile', 'a death too short to cross the map for');
  const smallPile = run(pile(0, 50));
  assert.equal(smallPile.mode(), 'pile', 'worth going for');
  assert.equal(smallPile.stats().pileBoosts, 0, 'but not worth a boost');
  // a bigger snake's head beside it, nearer than the bot: left alone
  assert.notEqual(run(pile(0, 120), [snakeAt(2, 1550, 1000, -Math.PI / 2, 80)]).mode(), 'pile', 'guarded');
  // within PILE_HANDOFF the food goal takes over
  assert.notEqual(run([{ at: 0, size: 120, pts: [1100, 1000] }]).mode(), 'pile');
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
  // the chasers (hunters and, now and then, casual bots); which of them meets prey first in 2 sim minutes is luck
  const chases = r.kinds.hunter.chases + r.kinds.casual.chases;
  const chaseBoosts = (r.kinds.hunter.chaseBoosts || 0) + (r.kinds.casual.chaseBoosts || 0);
  assert.ok(chases > 0 && chaseBoosts > 0, 'bots chase and boost toward the cut: ' + chases + ', ' + chaseBoosts);
  assert.ok(r.kinds.shy.flee > 0 && r.kinds.shy.hunt === 0 && r.kinds.shy.chases === 0, 'shy bots turn away and never chase');
  assert.ok(r.kinds.casual.food > 0, 'casual bots eat');
  const flee = B.PERSONALITIES.reduce((n, p) => n + (r.kinds[p].fleeBoosts || 0), 0);
  assert.ok(flee > 0, 'somebody boosted away from a bigger head (' + flee + ')');
  assert.ok(r.kinds.casual.boosts > 0, 'casual bots boost');
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

// A fake monitorEventLoopDelay histogram (nanoseconds): hold(p99) says what the current window's p99 is, in ms;
// reset() empties it, as the real one does. A fake event-loop utilization beside it: busy(share, ms) adds ms of loop
// time, that share of it busy, to its cumulative idle and active time, as perf_hooks eventLoopUtilization counts them.
function fakeLoop(p99Ms) {
  return {
    p99: p99Ms * 1e6,
    resets: 0,
    get count() {
      return this.p99 > 0 ? 100 : 0;
    },
    percentile(q) {
      assert.equal(q, 99);
      return this.p99;
    },
    reset() {
      this.p99 = 0;
      this.resets++;
    },
    hold(ms) {
      this.p99 = ms * 1e6;
    },
  };
}
function fakeElu() {
  const e = { idle: 0, active: 0 };
  const f = () => e;
  f.busy = (share, ms) => {
    e.active += share * ms;
    e.idle += (1 - share) * ms;
  };
  return f;
}
// The Windows idle loop measured on Owen's box (2026-10-11): a bare process p99 16.5 ms; the whole local server with
// the sl room running, busy 0.04 to 0.09 of the time.
const WIN_P99 = 16.5;
const close = (a, b) => Math.abs(a - b) < 1e-9;

test('loop probe: the first read starts afresh; then p99 over a 30 s window minus the idle floor (the quietest calm p99)', () => {
  const mon = fakeLoop(90); // boot stalls, before the first read
  const elu = fakeElu();
  const probe = B.createLoopProbe(mon, FIXTURE, elu);
  assert.equal(probe.read(0), 0, 'the first read');
  assert.equal(mon.resets, 1, 'boot stalls are not game load');
  assert.deepEqual(probe.stats(),
    { rawP99Ms: 0, floorMs: 1, settled: false, loopP99Ms: 0, busy: NaN, windows: 0, calmReads: 0 });
  mon.hold(WIN_P99);
  elu.busy(0.05, 1000);
  const quiet = probe.read(1000);
  assert.equal(quiet, 0);
  const st = probe.stats();
  assert.deepEqual([st.rawP99Ms, st.floorMs, st.settled, st.loopP99Ms, st.windows, st.calmReads], [16.5, 16.5, false, 0, 0, 1]);
  assert.ok(close(st.busy, 0.05), 'the busy share over the span: ' + st.busy);
  assert.equal(B.createBotGovernor(FIXTURE).sample(0, calm({ loopP99Ms: WIN_P99 })), 'engaged', 'the old bare reading');
  assert.equal(B.createBotGovernor(FIXTURE).sample(0, calm({ loopP99Ms: quiet })), null, 'above the floor');
  mon.hold(40); // a 40 ms stall in a calm window: it never lifts the floor
  elu.busy(0.05, 1000);
  assert.equal(probe.read(2000), 23.5);
  assert.equal(probe.stats().calmReads, 2);
  mon.hold(45); // a busy stretch: not calm
  elu.busy(0.9, 20000);
  assert.equal(probe.read(3000), 28.5);
  mon.hold(60);
  assert.equal(probe.read(4000), 43.5);
  assert.deepEqual([probe.stats().floorMs, probe.stats().calmReads], [16.5, 2]);
  assert.equal(probe.read(30000), 43.5, 'the window ends (busy, so it sets no floor): its p99 is kept');
  assert.equal(mon.resets, 2);
  assert.deepEqual([probe.stats().windows, probe.stats().settled], [1, false]);
  mon.hold(17);
  elu.busy(0.05, 15000);
  assert.equal(probe.read(45000), 43.5, 'the last whole window still counts');
  assert.equal(probe.read(60000), 0, 'one quiet whole window later');
  assert.deepEqual([probe.stats().floorMs, probe.stats().settled], [17, true], 'the whole calm window replaces the early floor');
  mon.hold(16); // once settled, only whole windows move the floor
  elu.busy(0.05, 1000);
  assert.equal(probe.read(61000), 0);
  assert.equal(probe.stats().floorMs, 17);
  assert.equal(probe.read(90000), 0, 'a quieter whole window');
  assert.equal(probe.stats().floorMs, 16);
  mon.hold(NaN);
  assert.equal(probe.read(91000), 0, 'no sample: the last whole window');
  mon.hold(100);
  elu.busy(0.05, 1000);
  assert.equal(probe.read(92000), 84);
  assert.equal(probe.read(120000), 84, 'a calm whole window with a long p99');
  assert.equal(probe.stats().floorMs, 16, 'once settled the floor never rises');
  assert.throws(() => B.createLoopProbe({}, FIXTURE, elu), /monitorEventLoopDelay/);
  assert.throws(() => B.createLoopProbe(mon, FIXTURE, 'elu'), /elu/);
  assert.throws(() => probe.read(NaN), /nowMs/);
});

test('loop probe: until a calm read the floor is the 1 ms resolution (over-reads, never under-reads); a busy second is dropped', () => {
  const mon = fakeLoop(0);
  const elu = fakeElu();
  const probe = B.createLoopProbe(mon, FIXTURE, elu);
  probe.read(0);
  mon.hold(40); // the server still booting: the loop busy 90 percent of the second
  elu.busy(0.9, 1000);
  assert.equal(probe.read(1000), 39);
  assert.equal(probe.stats().floorMs, B.LOOP_RESOLUTION_MS);
  assert.equal(B.createBotGovernor(FIXTURE).sample(0, calm({ loopP99Ms: 39 })), 'engaged');
  assert.equal(mon.resets, 2, 'not calm and no floor yet: the window starts afresh');
  mon.hold(19.5); // the next second is calm on its own (0.12); with the busy one it would read 0.51
  elu.busy(0.12, 1000);
  assert.equal(probe.read(2000), 0);
  assert.equal(probe.stats().floorMs, 19.5);
  assert.ok(close(probe.stats().busy, 0.12));
  assert.equal(mon.resets, 2);
  mon.hold(45); // once there is a floor, a busy second no longer restarts the window
  elu.busy(0.9, 1000);
  assert.equal(probe.read(3000), 25.5);
  assert.equal(mon.resets, 2);
});

test('loop probe: a span busy for LOOP_CALM_BUSY of its time or more, or with a busy share it cannot read, is never calm', () => {
  for (const share of [B.LOOP_CALM_BUSY, 0.7, 1]) {
    const mon = fakeLoop(0);
    const elu = fakeElu();
    const probe = B.createLoopProbe(mon, FIXTURE, elu);
    probe.read(0);
    mon.hold(20);
    elu.busy(share, 1000);
    assert.equal(probe.read(1000), 19, 'busy ' + share);
    assert.equal(probe.stats().calmReads, 0);
  }
  for (const bad of [() => null, () => ({}), () => ({ idle: NaN, active: 1 }), () => ({ idle: 0, active: 0 })]) {
    const mon = fakeLoop(0);
    const probe = B.createLoopProbe(mon, FIXTURE, bad);
    probe.read(0);
    mon.hold(WIN_P99);
    assert.equal(probe.read(1000), 15.5, 'unreadable busy share: no floor');
    assert.equal(probe.stats().calmReads, 0);
  }
  assert.equal(B.LOOP_CALM_BUSY, 0.5);
});

// The verifier's case (2026-10-11): a process that boots straight into a loop blocked 40 ms in every 100 (busy 0.4,
// under LOOP_CALM_BUSY) took a 40 ms floor and read 0 against the 15 ms bar for as long as the load lasted.
test('loop probe: the floor is never above LOOP_FLOOR_MAX_MS, so a loaded boot still reads its load', () => {
  assert.equal(B.LOOP_FLOOR_MAX_MS, 20);
  const mon = fakeLoop(0);
  const elu = fakeElu();
  const probe = B.createLoopProbe(mon, FIXTURE, elu);
  probe.read(0);
  let read = 0;
  for (let s = 1; s <= 120; s++) {
    mon.hold(40);
    elu.busy(0.4, 1000);
    read = probe.read(s * 1000);
    assert.ok(probe.stats().floorMs <= B.LOOP_FLOOR_MAX_MS, 'second ' + s + ': floor ' + probe.stats().floorMs);
  }
  assert.equal(probe.stats().settled, true, 'whole calm windows were taken');
  assert.equal(probe.stats().floorMs, 20);
  assert.equal(read, 20, '40 ms blocks read 20 above the floor');
  assert.equal(B.createBotGovernor(FIXTURE).sample(0, calm({ loopP99Ms: read })), 'engaged');
  for (let s = 121; s <= 240; s++) {
    mon.hold(60);
    elu.busy(0.48, 1000);
    read = probe.read(s * 1000);
  }
  assert.equal(read, 40, '60 ms blocks read 40');
  // a quiet floor under the cap is untouched (the measured Windows rest p99)
  const q = fakeLoop(0);
  const e2 = fakeElu();
  const p2 = B.createLoopProbe(q, FIXTURE, e2);
  p2.read(0);
  for (let s = 1; s <= 31; s++) {
    q.hold(WIN_P99);
    e2.busy(0.05, 1000);
    p2.read(s * 1000);
  }
  assert.deepEqual([p2.stats().floorMs, p2.stats().settled], [WIN_P99, true]);
});

test('loop probe: on a Linux-like 1 ms timer the reading is the lateness itself', () => {
  const mon = fakeLoop(0);
  const elu = fakeElu();
  const probe = B.createLoopProbe(mon, FIXTURE, elu);
  probe.read(0);
  mon.hold(1.5);
  elu.busy(0.1, 1000);
  assert.equal(probe.read(1000), 0);
  assert.equal(probe.stats().floorMs, 1.5);
  mon.hold(17.5); // a 16 ms stall
  elu.busy(0.1, 1000);
  assert.equal(probe.read(2000), 16);
  assert.equal(B.createBotGovernor(FIXTURE).sample(2000, calm({ loopP99Ms: 16 })), 'engaged');
});

test('loop probe on a real histogram and the real busy share: an empty histogram is no sample; boot uses 1 ms', () => {
  assert.equal(B.LOOP_RESOLUTION_MS, 1);
  const mon = monitorEventLoopDelay({ resolution: B.LOOP_RESOLUTION_MS });
  assert.equal(mon.count, 0);
  assert.equal(mon.percentile(99), 511, 'what an empty histogram answers (Node 24)');
  const probe = B.createLoopProbe(mon, FIXTURE); // the default busy share: perf_hooks eventLoopUtilization
  assert.equal(probe.read(0), 0);
  assert.equal(probe.read(1000), 0);
  assert.equal(probe.stats().calmReads, 0, 'no floor from an empty histogram');
  const boot = fs.readFileSync(path.join(__dirname, '../server/sl/slBoot.js'), 'utf8');
  assert.match(boot, /monitorEventLoopDelay\(\{ resolution: require\('\.\/slBots'\)\.LOOP_RESOLUTION_MS \}\)/);
});

test('governor on a fake timer: an idle Windows-like loop fills to the curve; a burn engages it and stops the fill', () => {
  const { host } = makeHost(FIXTURE, 35, 1791615600000); // curve 34
  const mon = fakeLoop(WIN_P99);
  const elu = fakeElu();
  const probe = B.createLoopProbe(mon, FIXTURE, elu);
  const gov = B.createBotGovernor(FIXTURE);
  const driver = B.createBotDriver(FIXTURE, { governor: gov });
  const seen = [];
  let burn = false;
  let next = 0;
  const sample = () => {
    const t = host.sim.nowMs();
    if (t < next) return;
    next += 1000;
    mon.hold(burn ? 45 : WIN_P99); // each second's histogram (the first read emptied it)
    elu.busy(burn ? 0.7 : 0.05, 1000);
    const r = gov.sample(t, calm({ loopP99Ms: probe.read(t) }));
    if (r) seen.push(r);
  };
  let most = 0;
  steps(driver, host, 180, () => {
    sample();
    most = Math.max(most, driver.count());
  });
  assert.equal(most, 34, 'the curve');
  assert.deepEqual(seen, [], 'never engaged while idle');
  assert.equal(gov.stats().samples, 8);
  assert.equal(probe.stats().floorMs, WIN_P99);
  burn = true; // a forced CPU burn: 45 ms stalls, the loop busy 70 percent of the time
  const before = driver.count();
  steps(driver, host, 30, sample);
  assert.deepEqual(seen, ['engaged']);
  assert.equal(gov.stats().why, 'loop');
  assert.equal(probe.stats().floorMs, WIN_P99, 'the burn never became the floor');
  assert.ok(driver.count() <= before, 'nothing added while engaged');
  assert.equal(driver.add(host), null, 'addBot refused');
});

test('real monitor: a forced CPU burn engages the governor against this process own idle floor', async () => {
  const mon = monitorEventLoopDelay({ resolution: B.LOOP_RESOLUTION_MS });
  mon.enable();
  try {
    const probe = B.createLoopProbe(mon, FIXTURE);
    const gov = B.createBotGovernor(FIXTURE);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    probe.read(Date.now());
    await sleep(1000);
    const idleRead = probe.read(Date.now());
    const idle = probe.stats();
    assert.ok(idle.floorMs >= B.LOOP_RESOLUTION_MS, 'the floor: ' + JSON.stringify(idle));
    for (let i = 0; i < 12; i++) {
      const t = Date.now();
      while (Date.now() - t < 60) { /* burn */ }
      await sleep(1);
    }
    const loop = probe.read(Date.now());
    const bar = FIXTURE.C_GOV.value.loopP99Ms;
    assert.ok(loop > bar, 'burn ' + JSON.stringify(probe.stats()) + ' idle ' + JSON.stringify(idle) + ' ' + idleRead);
    assert.ok(probe.stats().floorMs <= idle.floorMs, 'the burn never raised the floor');
    assert.equal(gov.sample(0, calm({ loopP99Ms: loop })), 'engaged');
  } finally {
    mon.disable();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// New bots.

test('skins: about 6 in 10 a plain colour 0 to 8, the rest spread over every other shipped skin, one draw', () => {
  assert.equal(B.PLAIN_SKINS, 9);
  const skins = B.botSkins(FIXTURE);
  assert.equal(B.skinOf(skins, 0), 0);
  assert.equal(B.skinOf(skins, 0.5999), 8);
  assert.equal(B.skinOf(skins, 0.6), 9);
  assert.equal(B.skinOf(skins, 0.9999999), 65);
  const r = createRng(17);
  const names = B.createNameBook();
  const per = new Map();
  let plain = 0;
  const N = 30000;
  for (let i = 0; i < N; i++) {
    const s = B.drawBotSpec(r, FIXTURE, names);
    names.release(s.nick);
    if (s.cv < 9) plain++;
    per.set(s.cv, (per.get(s.cv) || 0) + 1);
  }
  assert.ok(Math.abs(plain / N - 0.6) < 0.015, 'plain share ' + plain / N);
  assert.equal(per.size, 54, 'every allowed skin is worn');
  for (const [cv, n] of per) {
    const want = cv < 9 ? (0.6 * N) / 9 : (0.4 * N) / 45;
    assert.ok(Math.abs(n - want) < want * 0.25, 'cv ' + cv + ': ' + n + ' of about ' + want.toFixed(0));
  }
  // with the picture skins on, they join the patterned share
  const ALL = Array.from(B.PICTURE_FILES);
  const on = B.botSkins(makeFixture({ PICTURE_SKINS: { on: true, reviewed: ALL } }));
  assert.equal(B.skinOf(on, 0.99999), 65);
  const reach = new Set();
  for (let i = 0; i < 20000; i++) reach.add(B.skinOf(on, i / 20000));
  assert.equal(reach.size, 66);
  for (const cv of B.PICTURE_SKIN_CVS) assert.ok(reach.has(cv), 'picture skin ' + cv);
});

test('skins: the shipped 0 to 65; the 12 picture skins only with the PICTURE_SKINS switch on', () => {
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
  const { cleanNick } = require('../server/sl/slNames');
  const list = B.BOT_NAMES;
  assert.equal(new Set(list.map((n) => n.toLowerCase())).size, list.length);
  assert.ok(list.length > 4 * C.BOT_MAX, 'names ' + list.length);
  const check = (n) => {
    assert.ok(typeof n === 'string' && n.length >= 3 && n.length <= B.NICK_MAX, n); // a real account needs 3
    for (let i = 0; i < n.length; i++) assert.ok(n.charCodeAt(i) >= 32 && n.charCodeAt(i) <= 126, n);
    assert.equal(n.trim(), n);
    assert.notEqual(n.toLowerCase(), 'gameweek2016');
    assert.equal(A.gdnm(n), true, n);
    assert.equal(cleanNick(n), n, n);
    assert.ok(!/bot|slither\.?io/i.test(n), n);
  };
  for (const n of list) check(n);
  // and every name the room's book hands out: 20,000 draws, reaching thousands of different names
  const book = B.createNameBook();
  const r = createRng(23);
  const seen = new Set();
  let decorated = 0;
  for (let i = 0; i < 20000; i++) {
    const n = book.take(r);
    check(n);
    seen.add(n);
    if (!list.includes(n)) decorated++;
    book.release(n);
  }
  assert.ok(seen.size > 5000, 'different names ' + seen.size);
  assert.ok(decorated > 20000 * 0.3 && decorated < 20000 * 0.7, 'dressed up (digits, case, xX) ' + decorated);
});

test('names: the book never gives two live bots the same name, nor a name a seated person wears', () => {
  const book = B.createNameBook();
  const r = createRng(5);
  const live = new Set();
  for (let i = 0; i < 400; i++) {
    const n = book.take(r);
    assert.ok(!live.has(n.toLowerCase()), 'twice: ' + n);
    live.add(n.toLowerCase());
  }
  assert.equal(book.inUse(), 400);
  // what the next draw would be, then the same draw with a person in the room wearing that name (any case)
  const probe = createRng(77);
  const next = B.createNameBook().take(probe);
  const again = B.createNameBook().take(createRng(77), new Set([next.toUpperCase().toLowerCase()]));
  assert.notEqual(again.toLowerCase(), next.toLowerCase());
  // a list book (tools) skips the people's names too
  const lb = B.createNameBook(['Amy', 'Bo1', 'Cy2']);
  for (let i = 0; i < 20; i++) {
    const n = lb.take(createRng(i), new Set(['amy', 'bo1']));
    assert.equal(n, 'Cy2');
    lb.release(n);
  }
});

test('driver: a new bot never takes the name of a person seated in the room', () => {
  const { host, sim } = makeHost(FIXTURE, 61, 1791615600000);
  // the name the driver's first bot would get: its spec is the first draw set of the room's bot stream
  const clone = createRng(0);
  clone.setState(sim.rng.bot.state());
  const first = B.drawBotSpec(clone, FIXTURE, B.createNameBook()).nick;
  const person = sim.spawn({ cv: 1, nick: first.toUpperCase() });
  host.humans = new Set([person.id]);
  host.names.set(person.id, first.toUpperCase());
  const driver = B.createBotDriver(FIXTURE);
  steps(driver, host, 3);
  assert.equal(driver.count(), 1);
  let botNick = null;
  sim.forEachSnake((s) => {
    if (driver.isBot(s.id)) botNick = s.nick;
  });
  assert.ok(botNick && botNick.toLowerCase() !== first.toLowerCase(), first + ' vs ' + botNick);
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
  assert.ok(require('../server/botNames').isBotName(s1.nick, B.NICK_MAX), s1.nick);
  // a person's name to avoid changes the name only, never the draw count
  const r4 = createRng(5);
  B.drawBotSpec(r4, FIXTURE, B.createNameBook(), new Set([s1.nick.toLowerCase()]));
  assert.equal(r4.state(), r2.state());
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

// ---------------------------------------------------------------------------------------------------------------
// The owner console's controls and the refill wait (Control, 2026-10-16).

test('driver: setTarget holds an exact live count at the fill pace, people do not displace it, null returns to the curve', () => {
  const { host, sim } = makeHost(FIXTURE, 71, 1791615600000); // curve 34
  const driver = B.createBotDriver(FIXTURE);
  assert.equal(typeof driver.setTarget, 'function');
  assert.equal(typeof driver.target, 'function');
  assert.equal(typeof driver.removeBots, 'function');
  steps(driver, host, 150);
  assert.equal(driver.target(host), null, 'on the curve');
  assert.equal(driver.setTarget(host, 10), 10);
  assert.equal(driver.target(host), 10);
  steps(driver, host, 100); // 24 retirements at one per 125 ms, about 71 updates
  assert.equal(driver.count(), 10);
  host.playerCount = 5; // people arrive: the held count stays
  steps(driver, host, 30);
  assert.equal(driver.count(), 10);
  assert.equal(driver.setTarget(host, 60), 60);
  let most = 0;
  let waitingSeen = 0;
  steps(driver, host, 200, () => {
    most = Math.max(most, driver.count());
    waitingSeen = Math.max(waitingSeen, driver.waiting());
  });
  assert.equal(most, 60);
  assert.ok(driver.count() >= 58, 'a held count refills deaths at once: ' + driver.count());
  assert.equal(waitingSeen, 0, 'no refill wait under a held count');
  // hand-added bots count toward the held number too
  const extra = driver.add(host);
  extra.manual = true;
  steps(driver, host, 10);
  assert.ok(driver.count() <= 60);
  // back to the curve: 34 minus the 5 people
  assert.equal(driver.setTarget(host, null), null);
  assert.equal(driver.target(host), null);
  steps(driver, host, 400);
  assert.ok(driver.count() + driver.waiting() <= 30 && driver.count() + driver.waiting() >= 27,
    'the curve again: ' + driver.count() + ' + ' + driver.waiting() + ' waiting');
  assert.equal(sim.check().length, 0);
  // refusals
  for (const bad of [-1, 1.5, B.TARGET_MAX + 1, '5', NaN]) assert.throws(() => driver.setTarget(host, bad), RangeError, String(bad));
  assert.throws(() => driver.setTarget(null, 5), TypeError);
  assert.equal(driver.setTarget(host, B.TARGET_MAX), B.TARGET_MAX);
  assert.equal(driver.setTarget(host, 0), 0);
  steps(driver, host, 300);
  assert.equal(driver.count(), 0, 'held at zero');
  // the room cap still holds bots and people together
  const laws = makeFixture({ C_ROOM_CAP: 30 });
  const h2 = makeHost(laws, 72, 1791615600000).host;
  const d2 = B.createBotDriver(laws);
  d2.setTarget(h2, 150);
  h2.playerCount = 8;
  steps(d2, h2, 200);
  assert.equal(d2.count(), 22, 'cap 30 minus 8 people');
});

test('driver: a held count wins over an old Clear pause; Clear drops the held count', () => {
  const { host } = makeHost(FIXTURE, 73, 1791615600000);
  const driver = B.createBotDriver(FIXTURE);
  host._botsPausedUntil = host.wall + 600000; // the console's Clear window
  steps(driver, host, 30);
  assert.equal(driver.count(), 0);
  driver.setTarget(host, 12);
  steps(driver, host, 60);
  assert.equal(driver.count(), 12, 'the newer order');
  assert.equal(driver.clear(host), 12);
  assert.equal(driver.target(host), null, 'Clear is back to the curve, which the pause holds at zero');
  steps(driver, host, 60);
  assert.equal(driver.count(), 0);
});

test('driver: removeBots retires n bots now, unseen ones first, the way clear takes them out', () => {
  const { host, sim, seen } = makeHost(FIXTURE, 74, 1791615600000);
  const driver = B.createBotDriver(FIXTURE);
  steps(driver, host, 150);
  const before = driver.count();
  assert.ok(before >= 30);
  const ids = [];
  sim.forEachSnake((s) => {
    if (driver.isBot(s.id)) ids.push(s.id);
  });
  const watched = ids.slice(0, 5);
  for (const id of watched) seen.add(id);
  const namesBefore = host.names.size;
  assert.equal(driver.removeBots(host, before - 5), before - 5);
  assert.equal(driver.count(), 5);
  for (const id of watched) assert.ok(driver.isBot(id) && sim.snake(id), 'the seen ones stay while unseen ones are left');
  for (const id of ids) {
    if (!watched.includes(id)) {
      assert.equal(sim.snake(id), null);
      assert.ok(host.freedAt.has(id), 'its id is quarantined like any other removal');
    }
  }
  assert.ok(host.names.size <= namesBefore);
  assert.equal(driver.stats().names, 5, 'their names are free again');
  // more than there are: every bot, seen ones last; returns how many went
  assert.equal(driver.removeBots(host, 50), 5);
  assert.equal(driver.count(), 0);
  assert.equal(driver.removeBots(host, 3), 0);
  assert.throws(() => driver.removeBots(host, -1), RangeError);
  assert.throws(() => driver.removeBots(null, 1), TypeError);
  assert.equal(sim.check().length, 0);
  // on the curve the fill brings them back at its pace
  steps(driver, host, 60);
  assert.ok(driver.count() >= 18, 'refilled ' + driver.count());
});

test('driver: a dead bot is replaced after a random wait (exponential, mean about 6 s, at most 20 s), not at once', () => {
  const { host, sim } = makeHost(FIXTURE, 75, 1791677700000); // curve 99
  const driver = B.createBotDriver(FIXTURE);
  let waitingSeen = 0;
  let worst = 0;
  let offSum = 0;
  let offN = 0;
  steps(driver, host, 6000, (i) => {
    waitingSeen = Math.max(waitingSeen, driver.waiting());
    if (i > 1500) {
      const off = 99 - driver.count() - driver.waiting();
      worst = Math.max(worst, off);
      offSum += off;
      offN++;
    }
  });
  const st = driver.stats();
  assert.ok(st.refillDelays >= 60, 'deaths with a wait: ' + st.refillDelays);
  assert.ok(st.refillMeanMs > 4000 && st.refillMeanMs < 8500, 'mean wait ' + st.refillMeanMs);
  assert.ok(st.refillMaxMs <= 20000, 'longest wait ' + st.refillMaxMs);
  assert.ok(waitingSeen >= 2, 'places stood empty for a while');
  // bots plus waiting places track the curve; a few places freed together wait on the 125 ms pacer
  assert.ok(worst <= 5, 'bots plus waiting places track the curve: off by ' + worst);
  assert.ok(offSum / offN < 0.5, 'off on average by ' + offSum / offN);
  assert.equal(sim.check().length, 0);
  // people arriving take a waiting place first, before any live bot is retired
  host.playerCount = 3;
  const live = driver.count();
  const waiting = driver.waiting();
  steps(driver, host, 3);
  if (waiting > 0) assert.ok(driver.count() >= live - 1 && driver.waiting() <= waiting);
});

test('driver: death piles reach the brains through sense.piles, fresh ones only', () => {
  const { host, sim } = makeHost(FIXTURE, 76, 1791677700000);
  const driver = B.createBotDriver(FIXTURE);
  let piles = 0;
  steps(driver, host, 3000, () => {
    piles = Math.max(piles, driver.stats().piles);
  });
  assert.ok(piles >= 1, 'deaths left piles');
  assert.ok(piles <= B.BOT_TUNING.PILE_MAX.value);
  const kinds = driver.stats().kinds;
  const pileThinks = B.PERSONALITIES.reduce((n, p) => n + (kinds[p].pile || 0), 0);
  assert.ok(pileThinks > 0, 'bots went for them: ' + pileThinks);
  assert.equal(sim.check().length, 0);
});
