'use strict';
/* Swim: the shared sim, the traffic, how a race is judged, and the seat and
   money rules of its lobby (the same rules as Knockout's, see duelQueue.js). */
const test = require('node:test');
const assert = require('node:assert');
const S = require('../shared/swimSim');
const { Spawner, occMask, ROOM } = require('../server/swim/swimTraffic');
const { SwimRoom, LAG_MAX } = require('../server/swim/SwimRoom');
const { SwimLobby, PAID_GIVE_UP_MS, FREE_WAIT_MS } = require('../server/swim/SwimLobby');

const fakeIo = () => {
  const sent = [];
  const room = (name) => ({
    emit: (ev, p) => sent.push({ to: name, ev, p }),
    volatile: { emit: (ev, p) => sent.push({ to: name, ev, p, volatile: true }) },
  });
  return { sent, to: room };
};
let sid = 0;
const sock = (id) => {
  const got = [];
  return { id: id || 'sock' + (++sid), got, emit: (ev, p) => got.push({ ev, p }), join() {}, leave() {} };
};

/* A room with the traffic under the test's control: no spawning, cars placed by hand. */
function bareRoom(now) {
  const io = fakeIo();
  const room = new SwimRoom(io);
  room.spawner = { run() {} };
  room.io = io;
  return { room, io, now };
}
const at = (room, tick) => room.goAt + tick * S.TICK_MS + 0.5;
/* Run the clock to `until`, each seat sending its input for the tick about to run just before
   it does (as a screen does). A seat with stall set stops sending after that tick. */
function run(room, until, codeA, codeB, stallB) {
  for (let t = room.clock + 1; t <= until && room.state === 'racing'; t++) {
    if (codeA != null) room.input('a', { t: t - 1, k: [codeA] });
    if (codeB != null && !(stallB != null && t - 1 > stallB)) room.input('b', { t: t - 1, k: [codeB] });
    room.tick(at(room, t));
  }
}
/* The tick a lone car driving straight with `code` first touches the record `rec`. */
function crashTickFor(side, rec, code) {
  const c = S.newCar(side), tr = new S.Traffic();
  tr.add(rec.slice());
  while (c.alive && c.tick < 100000) S.step(c, code, tr);
  return c.crashTick;
}

test('inputs pack and unpack', () => {
  for (const s of [-1, -0.5, 0, 0.26, 1]) for (const p of [-1, 0, 1]) {
    const c = S.packInput(s, p);
    assert.ok(S.validInput(c));
    assert.strictEqual(S.pedalOf(c), p);
    assert.ok(Math.abs(S.steerOf(c) - s) <= 1 / S.STEER_Q);
  }
  assert.strictEqual(S.validInput(-1), false);
  assert.strictEqual(S.validInput(S.INPUT_MAX + 1), false);
  assert.strictEqual(S.validInput(1.5), false);
});

test('the step is deterministic and stays on the road', () => {
  const a = S.newCar(0), b = S.newCar(0);
  const r = S.rng(7);
  for (let i = 0; i < 5000; i++) {
    const c = S.packInput(r() * 2 - 1, Math.floor(r() * 3) - 1);
    S.step(a, c, null); S.step(b, c, null);
  }
  assert.deepStrictEqual(a, b);
  assert.ok(Math.abs(a.x) <= S.WALL + 1e-9);
  assert.ok(a.v >= 0 && a.v <= S.topSpeed(a.tick) + 1e-9);
});

test('a traffic car is hit only when the boxes touch', () => {
  const tr = new S.Traffic();
  tr.add([1, 1, 0, 50, 0, 0]);                     // a sedan in lane 1 at z 50 on tick 0
  const hl = S.CAR.HL + S.TYPES[0].hl;
  assert.strictEqual(tr.hitAt(S.laneX(1), 50 - hl - 0.01, 0), -1);
  assert.strictEqual(tr.hitAt(S.laneX(1), 50 - hl + 0.01, 0), 1);
  assert.strictEqual(tr.hitAt(S.laneX(2), 50, 0), -1, 'the next lane is clear');
  // It moves at its lane's speed: one second later it is LANE_V[1] further on.
  assert.strictEqual(tr.hitAt(S.laneX(1), 50 + S.LANE_V[1], 60), 1);
  // Between two cars side by side there is just room.
  tr.add([2, 2, 0, 50, 0, 0]);
  assert.strictEqual(tr.hitAt(0, 50, 0), -1);
});

/* ── close passes and the wheel ───────────────────────────────────────── */
/* A lone car on gas, set sideways so that a sedan in lane 2 (z 30 on tick 0) goes by with `gap`
   metres of daylight. Returns every tick a close pass was seen, with the speed it would have had
   without one (the same step on a copy, no traffic). */
function passBy(gap, opts) {
  const o = opts || {};
  const sedan = S.TYPES[0];
  const car = S.newCar(0);
  if (o.tick) car.tick = o.tick;
  car.x = S.laneX(o.lane != null ? o.lane : 2) + (o.side || -1) * (S.CAR.HW + sedan.hw + gap);
  const tr = new S.Traffic();
  tr.add([1, o.lane != null ? o.lane : 2, 0, o.z != null ? o.z : 30, car.tick, 0]);
  const code = o.code != null ? o.code : S.packInput(0, 1);
  const seen = [], states = [];
  for (let i = 0; i < (o.ticks || 600) && car.alive; i++) {
    const plain = S.step(S.copyCar(car), code, null);
    const n = car.tick;
    S.step(car, code, tr);
    states.push(S.copyCar(car));
    if (car.close >= 0) seen.push({ n, close: car.close, v: car.v, plain: plain.v, top: S.topSpeed(n) });
    else assert.strictEqual(car.v, plain.v, 'no boost on a tick without a close pass (' + n + ')');
  }
  return { car, seen, states, tr };
}

test('a close pass boosts once, on the tick the car goes behind, by how close it was', () => {
  const near = passBy(0.05), mid = passBy(0.3), far = passBy(0.55);
  for (const [r, g] of [[near, 0.05], [mid, 0.3], [far, 0.55]]) {
    assert.strictEqual(r.car.alive, true);
    assert.strictEqual(r.seen.length, 1, 'once per car passed');
    const s = r.seen[0];
    assert.ok(Math.abs(s.close - g) < 1e-9, 'the clearance is measured side to side (' + s.close + ')');
    const want = Math.min(s.plain + S.BOOST_MAX * (1 - s.close / S.CLOSE_M), s.top + S.BOOST_MAX);
    assert.strictEqual(s.v, want);
    // The tick it fired is the one the sedan's front went behind our rear.
    const before = r.states[s.n - 1] || S.newCar(0);
    const rec = r.tr.all()[0], hl = S.TYPES[0].hl;
    assert.ok(S.zAt(rec, s.n) + hl >= (s.n === 0 ? 0 : before.z) - S.CAR.HL);
    assert.ok(S.zAt(rec, s.n + 1) + hl < r.states[s.n].z - S.CAR.HL);
  }
  const boost = (r) => r.seen[0].v - r.seen[0].plain;
  assert.ok(boost(near) > boost(mid) && boost(mid) > boost(far) && boost(far) > 0, 'closer pays more');
  assert.ok(boost(near) > 0.9 * S.BOOST_MAX);
});

test('no boost for a wide pass, a car that overtakes us, or a touch (that is a crash)', () => {
  const wide = passBy(S.CLOSE_M + 0.05);
  assert.strictEqual(wide.seen.length, 0);
  assert.strictEqual(wide.car.alive, true);
  // Braking (down to a stop) in lane 1 while a lane 0 car comes past on our left, 0.2 m away: it passes us, not us it.
  const passed = passBy(0.2, { lane: 0, side: 1, z: -30, code: S.packInput(0, -1) });
  assert.ok(passed.car.z < S.zAt(passed.tr.all()[0], passed.car.tick) - 10, 'it went by');
  assert.strictEqual(passed.seen.length, 0);
  // Overlapping by 5 cm is a crash, never a pass.
  const touch = passBy(-0.05);
  assert.strictEqual(touch.car.alive, false);
  assert.strictEqual(touch.car.hit, 1);
  assert.strictEqual(touch.seen.length, 0);
  // And closeAt alone never calls an overlap a pass: the same crossing at -0.1 m and at +0.2 m.
  const tr = new S.Traffic();
  tr.add([1, 2, 0, 0, 0, 0]);
  const hl = S.TYPES[0].hl, x = (g) => S.laneX(2) - (S.CAR.HW + S.TYPES[0].hw + g);
  const z0 = S.CAR.HL + hl - 0.01;                       // the sedan's front 1 cm ahead of our rear on tick 0
  const z1 = z0 + 0.5 + S.LANE_V[2] * S.DT;               // and behind it on tick 1
  assert.strictEqual(tr.closeAt(x(-0.1), z0, z1, 0), -1);
  assert.ok(Math.abs(tr.closeAt(x(0.2), z0, z1, 0) - 0.2) < 1e-9);
  assert.strictEqual(tr.closeAt(x(0.2), z0 + 0.02, z1, 0), -1, 'already behind on tick 0: not this tick');
});

test('a boost eases back down to the top speed, gas or not, never cut off at once', () => {
  for (const code of [S.packInput(0, 1), S.NEUTRAL]) {
    const r = passBy(0.02, { code: S.packInput(0, 1), ticks: 400 });
    const s = r.seen[0];
    assert.ok(s.v > s.top + 5, 'the boost went over the top');
    const car = r.states[s.n];
    let last = car.v, ticks = 0;
    while (car.v > S.topSpeed(car.tick) && ticks < 60 * 10) {
      S.step(car, code, null);
      assert.ok(car.v < last, 'falling every tick');
      assert.ok(last - car.v <= S.OVER_EASE * S.DT + (code === S.NEUTRAL ? 0 : 1e-12) + 1e-9, 'by OVER_EASE a second, not at once');
      last = car.v; ticks++;
    }
    // The top speed itself still climbs about 1 m/s a second this early, so the two meet a little sooner.
    assert.ok(ticks > 60 * (s.v - s.top) / (S.OVER_EASE + 1.5), 'it took its time (' + ticks + ' ticks)');
    assert.ok(ticks < 60 * ((s.v - s.top) / S.OVER_EASE + 1), 'and got there');
    for (let i = 0; i < 120; i++) { S.step(car, code, null); assert.ok(car.v <= S.topSpeed(car.tick)); }
  }
});

test('boosts cannot chain: none inside the cooldown, the next one after it', () => {
  const sedan = S.TYPES[0], hl = sedan.hl;
  const car = S.newCar(0);
  car.x = S.laneX(2) - (S.CAR.HW + sedan.hw + 0.1);
  const tr = new S.Traffic();
  // Three sedans in lane 2: the second 8 m past the first (gone by well inside 1.2 s), the third 60 m on.
  const recs = [[1, 2, 0, 30, 0, 0], [2, 2, 0, 38, 0, 0], [3, 2, 0, 98, 0, 0]];
  for (const r of recs) tr.add(r.slice());
  const code = S.packInput(0, 1), boosts = [], passed = {};
  for (let i = 0; i < 900 && car.alive; i++) {
    const n = car.tick, rear0 = car.z - S.CAR.HL, coolWas = car.cool;
    const plain = S.step(S.copyCar(car), code, null);
    S.step(car, code, tr);
    for (const r of recs) {
      if (S.zAt(r, n) + hl >= rear0 && S.zAt(r, n + 1) + hl < car.z - S.CAR.HL) passed[r[0]] = n;
    }
    if (car.close >= 0) { boosts.push(n); assert.strictEqual(car.cool, S.BOOST_COOL); assert.ok(coolWas <= 1); }
    else { assert.strictEqual(car.v, plain.v); assert.strictEqual(car.cool, coolWas > 0 ? coolWas - 1 : 0); }
  }
  assert.strictEqual(car.alive, true);
  assert.deepStrictEqual(Object.keys(passed).map(Number), [1, 2, 3], 'all three went by');
  assert.deepStrictEqual(boosts, [passed[1], passed[3]], 'the first and the third boosted, the second did not');
  assert.ok(passed[2] - passed[1] < S.BOOST_COOL, 'the second was passed inside the cooldown');
  assert.ok(passed[3] - passed[1] >= S.BOOST_COOL);
});

test('the line between the two left lanes is no safe corridor: a rider on it meets a wide car within seconds', () => {
  const START = 60 * 60;                                   // a minute in: mid-race density
  const secs = [];
  for (let seed = 1; seed <= 16; seed++) {
    const sp = new Spawner(seed), tr = new S.Traffic();
    const c = S.newCar(0);
    c.tick = START; c.x = (S.laneX(0) + S.laneX(1)) / 2; c.v = S.topSpeed(START);
    while (c.alive && c.tick < START + 60 * 60) {
      sp.run(tr, c.tick, c.z, c.v, null);
      S.step(c, S.packInput(0, 1), tr);
      tr.prune(c.z - 120, c.tick);
    }
    assert.strictEqual(c.alive, false, 'seed ' + seed + ': a line rider went a minute untouched');
    const rec = tr.byId.get(c.hit), hit = S.TYPES[rec[2]].id;
    const crossing = rec.length === 8 && c.tick > rec[6] && c.tick < rec[6] + S.MOVE;
    assert.ok((hit !== 'sedan' && hit !== 'hatch') || crossing, 'only a wide car, or one changing lane across it, shuts the line (' + hit + ')');
    secs.push((c.tick - START) / 60);
  }
  secs.sort((a, b) => a - b);
  const med = secs[secs.length >> 1];
  assert.ok(med < 6, 'median ' + med.toFixed(1) + ' s: ' + secs.map(x => x.toFixed(1)).join(' '));
});

test('the wheel is sharper slow than fast', () => {
  const SLOW = 15;                                         // the old speed floor: the sharpest the wheel gets
  assert.strictEqual(S.vxMax(SLOW), 11.5 - 0.075 * SLOW);
  assert.strictEqual(S.vxMax(500), S.VX_LO);
  // Below it the wheel is held to a share of the speed: a stopped car cannot slide out of anything's way.
  assert.strictEqual(S.vxMax(0), 0);
  assert.strictEqual(S.vxMax(10), S.VX_SLIP * 10);
  assert.ok(S.vxMax(SLOW) > S.vxMax(S.V0) && S.vxMax(S.V0) > S.vxMax(S.V1) && S.vxMax(S.V1) > S.vxMax(S.V1 * S.TOP_K));
  const late = 60 * 600;                                   // ten minutes in
  const slow = S.newCar(0), fast = S.newCar(0);
  slow.tick = fast.tick = late;
  slow.v = SLOW; fast.v = S.topSpeed(late);
  const limit = S.V1 * S.TOP_K * 3.6;
  assert.ok(limit > 345 && limit < 355, 'flat out heads for about 350 km/h (' + Math.round(limit) + ')');
  assert.ok(fast.v * 3.6 > 320, 'and is past 320 ten minutes in (' + Math.round(fast.v * 3.6) + ')');
  const x0 = slow.x;
  for (let i = 0; i < 30; i++) { S.step(slow, S.packInput(1, 0), null); S.step(fast, S.packInput(1, 1), null); }
  assert.ok(slow.x - x0 > 2 * (fast.x - x0), 'half a second of full lock: ' + (slow.x - x0).toFixed(2) + ' m slow, ' + (fast.x - x0).toFixed(2) + ' m fast');
  // A lane's width at full lock takes well under half a second slow and nearer a second flat out.
  const laneTime = (v, pedal) => {
    const c = S.newCar(0); c.tick = late; c.v = v;
    let n = 0;
    while (c.x - S.laneX(1) < S.LANE_W) { S.step(c, S.packInput(1, pedal), null); n++; }
    return n / 60;
  };
  assert.ok(laneTime(SLOW, 0) <= 0.45, 'coasting at 54 km/h (' + laneTime(SLOW, 0) + ' s)');
  assert.ok(laneTime(S.topSpeed(late), 1) > 0.8);
});

test('a server room and a screen replaying the same inputs agree to the bit through a boost', () => {
  /* Ann nudges right off the middle of lane 1 so a sedan in lane 2 goes by close; found by trying
     nudges on a lone car (the inputs are what a screen sends, nothing set by hand). */
  const sedan = [1, 2, 0, 40, 0, 0];
  const TICKS = 300;
  const plan = (k) => { const out = []; for (let t = 0; t < TICKS; t++) out.push(S.packInput(t < k ? 0.3 : 0, 1)); return out; };
  let codes = null;
  for (let k = 1; k < 120 && !codes; k++) {
    const c = S.newCar(0), tr = new S.Traffic();
    tr.add(sedan.slice());
    const p = plan(k);
    let boosted = false;
    for (let t = 0; t < TICKS && c.alive; t++) { S.step(c, p[t], tr); if (c.close >= 0 && c.close > 0.1 && c.close < 0.4) boosted = true; }
    if (boosted && c.alive) codes = p;
  }
  assert.ok(codes, 'a nudge that passes close');
  const { room } = racing();
  room.traffic.add(sedan.slice());
  const BOB = S.packInput(0, -1);                          // Bob, behind the sedan in lane 2, drops back out of its way
  let mid = null;
  for (let t = 1; t <= TICKS; t++) {
    room.input('a', { t: t - 1, k: [codes[t - 1]] });
    room.input('b', { t: t - 1, k: [BOB] });
    room.tick(at(room, t));
    const a = room.bySide(0).car;
    if (!mid && a.v > S.topSpeed(a.tick - 1) + 1) mid = room.carRows().find(r => r[0] === 0).slice();
  }
  assert.strictEqual(room.state, 'racing');
  const server = room.bySide(0);
  assert.strictEqual(server.car.tick, TICKS);
  assert.ok(mid, 'the server saw the boost');
  // A screen on its own: the same record, the same inputs, every tick compared.
  const tr = new S.Traffic();
  tr.add(sedan.slice());
  const mine = S.newCar(0);
  let closes = 0;
  for (let t = 0; t < TICKS; t++) {
    S.step(mine, codes[t], tr);
    if (mine.close >= 0) closes++;
    assert.strictEqual(mine.z, server.zHist[mine.tick % 1024], 'z on tick ' + mine.tick);
  }
  assert.strictEqual(closes, 1);
  for (const k of ['tick', 'z', 'x', 'v', 'vx', 'alive', 'wall', 'cool']) assert.strictEqual(mine[k], server.car[k], k);
  // Rebuilt from the server's row in the middle of the boost (what a correction does), the replay lands on the same bits.
  assert.strictEqual(mid.length, 9, 'the row carries the boost cooldown');
  assert.ok(mid[8] > 0, 'mid-boost, the cooldown is running');
  const re = { tick: mid[1], z: mid[2], x: mid[3], v: mid[4], vx: mid[5], alive: !!mid[6], crashTick: -1, hit: -1, wall: mid[7], cool: mid[8] };
  for (let t = re.tick; t < TICKS; t++) S.step(re, codes[t], tr);
  for (const k of ['tick', 'z', 'x', 'v', 'vx', 'alive', 'wall', 'cool']) assert.strictEqual(re[k], server.car[k], 'after a correction: ' + k);
});

test('the spawner fills to the horizon and never shuts all four lanes where it places a car', () => {
  const sp = new Spawner(99);
  const tr = new S.Traffic();
  let z = 0, bigLeft = 0, bigRight = 0;
  for (let t = 0; t < 60 * 240; t++) {
    const out = [];
    sp.run(tr, t, z, 50, out);
    for (const rec of out) {
      // The car just placed: at least one other lane is open beside it.
      tr.lanes[rec[1]].splice(tr.lanes[rec[1]].indexOf(rec), 1);
      const occ = rec.length === 8 ? occMask(rec[1], rec[7], rec[6], t) : occMask(rec[1], -1, -1, t);
      assert.strictEqual(sp.shuts(tr, occ, rec[3], rec[2], t), false, 'record ' + rec[0]);
      tr.lanes[rec[1]].push(rec);
      assert.ok(S.validRecord(rec));
      if (S.TYPES[rec[2]].right) { if (rec[1] >= 2) bigRight++; else bigLeft++; }
    }
    z += 50 / 60;
    tr.prune(z - 120, t);
  }
  assert.ok(tr.size > 20, 'there is traffic');
  assert.ok(bigLeft > 0 && bigLeft * 2 < bigRight, 'trucks and buses in every lane, mostly on the right (' + bigLeft + ' left, ' + bigRight + ' right)');
});

/* â”€â”€ traffic lane changes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
/* Every record the real spawner makes in `secs` seconds with the front car flat out, nothing pruned. */
function spawnAll(seed, secs) {
  const sp = new Spawner(seed), tr = new S.Traffic(), all = [];
  let z = 0;
  for (let t = 0; t < 60 * secs; t++) {
    sp.run(tr, t, z, S.topSpeed(t), all);
    z += S.topSpeed(t) * S.DT;
  }
  return { tr, all };
}

test('a lane change: in its own lane before, in the new one after, in both from the indicator, on a smooth line', () => {
  const ct = 600, rec = [1, 2, 0, 100, 0, 0, ct, 1];
  assert.ok(S.validRecord(rec) && S.validRecord(rec.slice(0, 6)));
  assert.strictEqual(S.validRecord([1, 2, 0, 100, 0, 0, ct, 0]), false, 'next lane only');
  assert.strictEqual(S.validRecord([1, 2, 0, 100, 0, 0, ct]), false);
  assert.strictEqual(S.validRecord([1, 2, 0, 100, 50, 0, 10, 1]), false, 'not before it was born');
  const tr = new S.Traffic();
  tr.add(rec.slice());
  const zz = (t) => S.zAt(rec, t);
  for (const t of [0, ct - S.SIGNAL - 1, ct - S.SIGNAL, ct]) {
    assert.strictEqual(tr.hitAt(S.laneX(2), zz(t), t), 1, 'its own lane before it moves (' + t + ')');
    assert.strictEqual(tr.hitAt(S.laneX(1), zz(t), t), -1);
  }
  for (const t of [ct + S.MOVE, ct + S.MOVE + 300]) {
    assert.strictEqual(tr.hitAt(S.laneX(1), zz(t), t), 1, 'the new lane once it has moved (' + t + ')');
    assert.strictEqual(tr.hitAt(S.laneX(2), zz(t), t), -1);
  }
  // x: lane 2 until the move, lane 1 after, sliding over without a jump, halfway at half time.
  assert.strictEqual(S.xAt(rec, ct), S.laneX(2));
  assert.strictEqual(S.xAt(rec, ct + S.MOVE), S.laneX(1));
  assert.ok(Math.abs(S.xAt(rec, ct + S.MOVE / 2) - 0) < 1e-9);
  for (let t = ct; t < ct + S.MOVE; t++) {
    const a = S.xAt(rec, t), b = S.xAt(rec, t + 1);
    assert.ok(b < a && a - b < 0.1, 'moving left, at most 6 m/s');
  }
  // The indicator from 2.5 s before, the brake lamps for the last second before it moves.
  assert.strictEqual(S.signalAt(rec, ct - S.SIGNAL - 1), 0);
  assert.strictEqual(S.signalAt(rec, ct - S.SIGNAL), -1);
  assert.strictEqual(S.signalAt(rec, ct + S.MOVE - 1), -1);
  assert.strictEqual(S.signalAt(rec, ct + S.MOVE), 0);
  assert.deepStrictEqual([ct - 61, ct - 60, ct - 1, ct].map(t => S.brakingAt(rec, t)), [false, false, false, false], 'traffic never slows, so its brake lamps never light');
  // Counted in both lanes from the indicator until it has moved over.
  const behind = (t) => zz(t) - 30;
  assert.strictEqual(tr.aheadIn(1, behind(ct - S.SIGNAL - 1), ct - S.SIGNAL - 1), null);
  assert.strictEqual(tr.aheadIn(1, behind(ct - S.SIGNAL), ct - S.SIGNAL)[0], 1);
  assert.strictEqual(tr.aheadIn(2, behind(ct + S.MOVE - 1), ct + S.MOVE - 1)[0], 1);
  assert.strictEqual(tr.aheadIn(2, behind(ct + S.MOVE), ct + S.MOVE), null);
});

test('lane changes: the server and a screen fed the same records agree on x and hits every tick, and a car is judged the same', () => {
  const { tr: server, all } = spawnAll(11, 150);
  const changers = all.filter(r => r.length === 8);
  assert.ok(changers.length >= 5, 'the spawner plans lane changes (' + changers.length + ' of ' + all.length + ')');
  const screen = new S.Traffic();
  for (const r of all.slice().reverse()) screen.add(JSON.parse(JSON.stringify(r)));   // over the wire, out of order
  for (const c of changers) {
    const sc = screen.byId.get(c[0]);
    for (let t = c[6] - S.SIGNAL - 5; t <= c[6] + S.MOVE + 5; t++) {
      assert.strictEqual(S.xAt(sc, t), S.xAt(c, t));
      const z = S.zAt(c, t);
      for (const px of [S.laneX(c[1]), (S.laneX(c[1]) + S.laneX(c[7])) / 2, S.laneX(c[7])]) {
        assert.strictEqual(screen.hitAt(px, z, t), server.hitAt(px, z, t));
      }
    }
  }
  /* A race: a sedan in lane 2 moves into Ann's lane 1 ahead of her and she drives straight into it.
     The server's verdict and a screen's own replay agree on the tick and the car. */
  const { room } = racing();
  const cut = [7, 2, 0, 120, 0, 3, 120, 1];
  room.traffic.add(cut.slice());
  const GO = S.packInput(0, 1);
  run(room, 1200, GO, GO);
  assert.strictEqual(room.state, 'over');
  const ann = room.bySide(0).car;
  assert.strictEqual(ann.alive, false);
  assert.strictEqual(ann.hit, 7);
  assert.ok(ann.crashTick > cut[6] + S.MOVE, 'hit in the new lane, after the move');
  const mine = S.newCar(0), tr = new S.Traffic();
  tr.add(JSON.parse(JSON.stringify(cut)));
  while (mine.alive && mine.tick < 1200) S.step(mine, GO, tr);
  assert.strictEqual(mine.crashTick, ann.crashTick);
  assert.strictEqual(mine.hit, 7);
  assert.strictEqual(mine.z, ann.z);
});

test('the spawner never plans a lane change into a gap that is not there', () => {
  let changes = 0;
  for (const seed of [3, 4, 5]) {
    const { all } = spawnAll(seed, 240);
    for (const c of all) {
      if (c.length !== 8) continue;
      changes++;
      const hc = S.TYPES[c[2]].L / 2;
      for (const r of all) {
        if (r === c) continue;
        const from = Math.max(c[6] - S.SIGNAL, r[4], S.occFrom(r, c[7]));
        const to = Math.min(c[6] + S.MOVE + 60, S.occTo(r, c[7]) - 1);
        for (let t = from; t <= to; t += 3) {
          const gap = Math.abs(S.zAt(c, t) - S.zAt(r, t)) - hc - S.TYPES[r[2]].L / 2;
          assert.ok(gap >= ROOM - 1e-6, 'record ' + c[0] + ' changing into lane ' + c[7] + ' comes within ' + gap.toFixed(2) + ' m of ' + r[0] + ' on tick ' + t);
        }
      }
    }
  }
  assert.ok(changes >= 20, 'enough lane changes to mean something (' + changes + ')');
});

function racing(seats) {
  const { room } = bareRoom();
  const a = sock('a'), b = sock('b');
  room.addPlayer(a, 'Ann', seats && seats.wa, seats && seats.worth, seats && seats.worth);
  room.addPlayer(b, 'Bob', seats && seats.wb, seats && seats.worth, seats && seats.worth);
  room.stake = seats && seats.worth ? seats.worth : 0;
  room.start(1000);
  room.tick(room.goAt);
  assert.strictEqual(room.state, 'racing');
  return { room, a, b };
}

test('a crash loses, judged on the own tick of the car that crashed, even when the other trails behind', () => {
  const { room } = racing();
  const rec = [1, 1, 0, 50, 0, 0];               // a sedan in Ann's lane 50 m on
  room.traffic.add(rec.slice());
  const c = crashTickFor(0, rec, S.NEUTRAL);
  assert.ok(c > 60);
  // Bob's inputs stop well before Ann's crash, so his car trails the clock by LAG_MAX.
  run(room, c + 10, S.NEUTRAL, S.packInput(0, 1), c - 40);
  assert.strictEqual(room.bySide(0).car.alive, false);
  assert.strictEqual(room.bySide(0).car.crashTick, c);
  assert.strictEqual(room.bySide(1).car.tick, c + 10 - LAG_MAX);
  assert.strictEqual(room.state, 'racing', 'not decided until Bob reaches the crash tick');
  run(room, c + 40, null, S.packInput(0, 1));
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.winner, 'b');
  assert.strictEqual(room.overWhy, 'crashed');
  assert.strictEqual(room.endTick, c);
});

test('a silent connection is moved on with its last input after LAG_MAX ticks', () => {
  const { room } = racing();
  run(room, 200, S.NEUTRAL, S.NEUTRAL, 10);
  assert.strictEqual(room.bySide(0).car.tick, 200);
  assert.strictEqual(room.bySide(1).car.tick, 200 - LAG_MAX);
});

test('inputs from the future, malformed ones and ones for ticks already run are ignored', () => {
  const { room } = racing();
  for (let t = 1; t <= 30; t++) room.tick(at(room, t));
  const p = room.bySide(0);
  assert.strictEqual(room.input('a', { t: 30 + 200, k: [S.packInput(1, 1)] }), false);
  assert.strictEqual(room.input('a', { t: 'x', k: [1] }), false);
  assert.strictEqual(room.input('a', { t: 40, k: new Array(13).fill(1) }), false);
  assert.strictEqual(room.input('a', null), false);
  assert.strictEqual(room.input('nobody', { t: 31, k: [1] }), false);
  room.input('a', { t: 31, k: [99999, S.packInput(1, 1)] });   // the bad code is skipped, the good one kept
  assert.strictEqual(p.codeTick[31 % 1024], 31);
  assert.strictEqual(p.codeTick[30 % 1024], -1);
});

test('200 m behind loses', () => {
  const { room } = racing();
  run(room, 3000, S.packInput(0, 1), S.packInput(0, -1));   // gas against brake
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.winner, 'a');
  assert.strictEqual(room.overWhy, 'fell behind');
  const gapAt = room.bySide(0).zHist[room.endTick % 1024] - room.bySide(1).zHist[room.endTick % 1024];
  assert.ok(gapAt >= S.BEHIND_LOSE && gapAt < S.BEHIND_LOSE + 1);
});

/* ── no auto-throttle (Owen 2026-10-28) ─────────────────────────────────────── */
test('no pedal never gains speed: the car coasts down to a stop, the gas alone climbs to the top, the brake beats coasting', () => {
  // Both cars start alike: tick 0 at V0, and the same inputs keep them alike but for the lane.
  const c0 = S.newCar(0), c1 = S.newCar(1);
  assert.strictEqual(c0.v, S.V0); assert.strictEqual(c1.v, S.V0);
  assert.strictEqual(c0.z, 0); assert.strictEqual(c1.z, 0); assert.strictEqual(c0.tick, 0); assert.strictEqual(c1.tick, 0);
  const r = S.rng(3);
  for (let i = 0; i < 2000; i++) {
    const code = S.packInput(0, Math.floor(r() * 3) - 1);
    S.step(c0, code, null); S.step(c1, code, null);
    assert.strictEqual(c0.v, c1.v); assert.strictEqual(c0.z, c1.z);
  }
  // From any speed, early or late, boosted or not, no pedal only ever loses speed, and never below 0.
  for (let i = 0; i < 3000; i++) {
    const c = S.newCar(0);
    c.tick = Math.floor(r() * 60 * 900);
    c.v = r() * (S.topSpeed(c.tick) + S.BOOST_MAX);
    const v0 = c.v;
    S.step(c, S.NEUTRAL, null);
    assert.ok(c.v < v0 || v0 === 0, 'coasting at ' + v0.toFixed(2) + ' went to ' + c.v);
    assert.ok(c.v >= 0);
    if (v0 <= S.topSpeed(c.tick)) assert.strictEqual(c.v, Math.max(0, v0 - S.coastDecel(v0) * S.DT));
    const b = S.newCar(0); b.tick = c.tick; b.v = v0;
    S.step(b, S.packInput(0, -1), null);
    assert.ok(b.v < c.v || b.v === 0, 'the brake bites harder than coasting');
  }
  // Let go at the start: the speed falls every tick and reaches 0 in under a minute, then stays there.
  const coast = S.newCar(0);
  let last = coast.v;
  while (coast.v > 0 && coast.tick < 60 * 60) { S.step(coast, S.NEUTRAL, null); assert.ok(coast.v < last); last = coast.v; }
  assert.strictEqual(coast.v, 0, 'stopped after ' + (coast.tick / 60).toFixed(1) + ' s');
  assert.ok(coast.tick > 60 * 15, 'a long roll, not a stop (' + (coast.tick / 60).toFixed(1) + ' s)');
  const z = coast.z;
  for (let i = 0; i < 120; i++) S.step(coast, S.packInput(1, 0), null);
  assert.strictEqual(coast.v, 0); assert.strictEqual(coast.z, z);
  assert.ok(Math.abs(coast.x - S.laneX(1)) < 1e-9, 'a stopped car cannot slide sideways');
  // The gas takes it back up, to the top speed and no further.
  for (let i = 0; i < 60 * 30; i++) { const t = coast.tick, v = coast.v; S.step(coast, S.packInput(0, 1), null); assert.ok(coast.v >= v && coast.v <= S.topSpeed(t)); }
  assert.strictEqual(coast.v, S.topSpeed(coast.tick - 1));
  // The numbers in the comment: 1.65 m/s a second at the start, about 4.5 flat out late on.
  assert.ok(Math.abs(S.coastDecel(S.V0) - 1.65) < 0.01 && Math.abs(S.coastDecel(S.V1 * S.TOP_K) - 4.5) < 0.05);
});

test('stopping is no way to win: a car that stops, or only coasts, falls 200 m behind one that keeps driving', () => {
  for (const lazy of [S.packInput(0, -1), S.NEUTRAL]) {
    const { room } = racing({ worth: 1, wa: 'WA', wb: 'WB' });
    const settled = [];
    room.onSettled = (x) => settled.push(x);
    let stopped = false;
    for (let t = room.clock + 1; t <= 60 * 120 && room.state === 'racing'; t++) {
      room.input('a', { t: t - 1, k: [S.packInput(0, 1)] });
      room.input('b', { t: t - 1, k: [lazy] });
      room.tick(at(room, t));
      if (room.bySide(1).car.v === 0) stopped = true;
    }
    if (lazy !== S.NEUTRAL) assert.ok(stopped, 'the brake took Bob to a standstill');
    assert.strictEqual(room.state, 'over');
    assert.strictEqual(room.winner, 'a');
    assert.strictEqual(room.overWhy, 'fell behind');
    assert.strictEqual(settled.length, 1);
    assert.strictEqual(settled[0].winnerId, 'a');
    assert.ok(room.endTick < 60 * 12, 'and soon (' + (room.endTick / 60).toFixed(1) + ' s)');
  }
});

/* Bob pulls into the slow lane (3) and crawls there at 5 to 7 m/s; Ann keeps her foot down in lane 1. */
function crawlRace(behind) {
  const { room } = racing({ worth: 1, wa: 'WA', wb: 'WB' });
  const settled = [];
  room.onSettled = (x) => settled.push(x);
  if (behind) room.traffic.add([1, 3, 0, -25, 0, 0]);           // a sedan in the slow lane, 25 m behind the start
  for (let t = room.clock + 1; t <= 60 * 120 && room.state === 'racing'; t++) {
    const bob = room.bySide(1).car;
    const e = S.laneX(3) - bob.x;
    const pedal = bob.v > 7 ? -1 : bob.v < 5 ? 1 : 0;
    room.input('a', { t: t - 1, k: [S.packInput(0, 1)] });
    room.input('b', { t: t - 1, k: [S.packInput(Math.abs(e) < 0.05 ? 0 : Math.max(-1, Math.min(1, e)), pedal)] });
    room.tick(at(room, t));
  }
  return { room, settled };
}

test('crawling in the slow lane loses: traffic comes up from behind and hits you, or you fall 200 m back', () => {
  const hit = crawlRace(true);
  assert.strictEqual(hit.room.state, 'over');
  assert.strictEqual(hit.room.overWhy, 'crashed');
  assert.strictEqual(hit.room.winner, 'a');
  const bob = hit.room.bySide(1).car;
  assert.strictEqual(bob.hit, 1);
  assert.ok(Math.abs(bob.x - S.laneX(3)) < 0.5, 'in the slow lane');
  assert.ok(S.zAt([1, 3, 0, -25, 0, 0], bob.crashTick) < bob.z, 'hit from behind');
  assert.strictEqual(hit.settled[0].winnerId, 'a');
  const alone = crawlRace(false);
  assert.strictEqual(alone.room.overWhy, 'fell behind');
  assert.strictEqual(alone.room.winner, 'a');
  assert.strictEqual(alone.settled[0].winnerId, 'a');
});

test('both stopping is a draw at the 30 minute cap that refunds both: nobody profits from it', () => {
  // The real spawner this time: traffic is only ever placed ahead, so nothing comes from behind two cars that never passed it.
  const io = fakeIo();
  const room = new SwimRoom(io);
  room.addPlayer(sock('a'), 'Ann', 'WA', 1, 1);
  room.addPlayer(sock('b'), 'Bob', 'WB', 1, 1);
  room.stake = 1;
  const settled = [];
  room.onSettled = (x) => settled.push(x);
  room.start(1000);
  room.tick(room.goAt);
  const STOP = S.packInput(0, -1);
  const { MAX_TICKS } = require('../server/swim/SwimRoom');
  for (let t = 1; t <= MAX_TICKS + 5 && room.state === 'racing'; t++) {
    room.input('a', { t: t - 1, k: [STOP] });
    room.input('b', { t: t - 1, k: [STOP] });
    room.tick(at(room, t));
    if (t % 6000 === 1) io.sent.length = 0;                     // the test keeps no wire history
  }
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.overWhy, 'time');
  assert.strictEqual(room.winner, null);
  assert.strictEqual(room.endTick, MAX_TICKS);
  assert.ok(room.bySide(0).car.alive && room.bySide(1).car.alive, 'nothing touched either');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, null, 'a draw: both stakes back, nobody paid');
  assert.strictEqual(settled[0].pot, 2);
  const over = io.sent.find(m => m.ev === 'sw:over');
  assert.ok(over.p.money && over.p.money.refunded, 'the card says refunded');
});

test('a server room and a screen replaying the same inputs agree to the bit through coasting, a stop and the gas again', () => {
  const plan = [];
  for (let t = 0; t < 1500; t++) {
    const steer = t >= 200 && t < 230 ? 0.6 : t >= 900 && t < 960 ? -0.4 : 0;
    plan.push(S.packInput(steer, t < 90 ? 1 : t < 520 ? 0 : t < 700 ? -1 : t < 780 ? 0 : 1));
  }
  const TICKS = plan.length;
  const { room } = racing();
  let mid = null;
  const zs = [];
  for (let t = 1; t <= TICKS; t++) {
    room.input('a', { t: t - 1, k: [plan[t - 1]] });
    room.input('b', { t: t - 1, k: [S.packInput(0, S.pedalOf(plan[t - 1]))] });   // Bob on the same pedals keeps level
    room.tick(at(room, t));
    const c = room.bySide(0).car;
    zs[c.tick] = c.z;
    if (t === 400) mid = room.carRows().find(r => r[0] === 0).slice();   // mid-coast
  }
  assert.strictEqual(room.state, 'racing');
  const server = room.bySide(0);
  assert.strictEqual(server.car.tick, TICKS);
  const mine = S.newCar(0);
  let stoppedAt = -1, regained = false;
  for (let t = 0; t < TICKS; t++) {
    S.step(mine, plan[t], null);
    assert.strictEqual(mine.z, zs[mine.tick], 'z on tick ' + mine.tick);
    if (mine.v === 0 && stoppedAt < 0) stoppedAt = mine.tick;
    if (stoppedAt >= 0 && mine.v > S.V0) regained = true;
  }
  assert.ok(stoppedAt > 520 && stoppedAt < 700, 'braked to a standstill (' + stoppedAt + ')');
  assert.ok(regained, 'and the gas took it back up');
  for (const k of ['tick', 'z', 'x', 'v', 'vx', 'alive', 'wall', 'cool']) assert.strictEqual(mine[k], server.car[k], k);
  const re = { tick: mid[1], z: mid[2], x: mid[3], v: mid[4], vx: mid[5], alive: !!mid[6], crashTick: -1, hit: -1, wall: mid[7], cool: mid[8] };
  assert.ok(re.v > 0 && re.v < S.V0, 'the row was taken mid-coast');
  for (let t = re.tick; t < TICKS; t++) S.step(re, plan[t], null);
  for (const k of ['tick', 'z', 'x', 'v', 'vx', 'alive', 'wall', 'cool']) assert.strictEqual(re[k], server.car[k], 'after a correction: ' + k);
});

test('both crashing on the same tick is a draw, and a paid draw settles once with no winner', () => {
  const { room } = racing({ worth: 1, wa: 'WA', wb: 'WB' });
  const settled = [];
  room.onSettled = (x) => settled.push(x);
  /* A car in each lane, placed so both cars (same speed, driving straight on the gas) first touch
     theirs on the same tick: Ann's in lane 1 at z 150, Bob's in lane 2 at the same distance from him then. */
  const GO = S.packInput(0, 1);
  room.traffic.add([1, 1, 0, 150, 0, 0]);
  const meet = crashTickFor(0, [1, 1, 0, 150, 0, 0], GO);
  const dz = S.zAt([1, 1, 0, 150, 0, 0], meet);
  room.traffic.add([2, 2, 0, dz - S.LANE_V[2] * meet * S.DT, 0, 0]);
  run(room, 2000, GO, GO);
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.overWhy, 'both crashed');
  assert.strictEqual(room.winner, null);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, null);
  assert.strictEqual(settled[0].pot, 2);
  room.finish('a', 'again');
  assert.strictEqual(settled.length, 1, 'never twice');
  const over = room.io.sent.find(m => m.ev === 'sw:over');
  assert.ok(over.p.money && over.p.money.refunded, 'the card says refunded');
  assert.ok(!JSON.stringify(over.p).includes('WA'), 'no wallet on the wire');
});

test('a paid win pays the pot less the cut on the card, and walking out loses', () => {
  const { room } = racing({ worth: 0.5, wa: 'WA', wb: 'WB' });
  const settled = [];
  room.onSettled = (x) => settled.push(x);
  for (let t = 1; t <= 30; t++) room.tick(at(room, t));
  room.removePlayer('a');
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, 'b');
  assert.strictEqual(settled[0].pot, 1);
  const over = room.io.sent.find(m => m.ev === 'sw:over');
  assert.strictEqual(over.p.money.netMicro, 900000);
  assert.strictEqual(over.p.money.cutMicro, 100000);
  assert.strictEqual(over.p.winnerSide, 1);
});

test('watchers get seats, never socket ids', () => {
  const { room } = racing();
  room.watchers = 1;
  room.broadcast('sw:chat', { name: 'Ann', side: 0, text: 'hi' });
  const snap = room.watchSnapshot(Date.now());
  assert.ok(!JSON.stringify(snap).includes('"a"') && !JSON.stringify(snap).includes('"b"'));
  assert.ok(snap.players.every(p => !('id' in p)));
});

/* ── the lobby ─────────────────────────────────────────────────────────── */
function lobbyWith() {
  const io = fakeIo();
  const lobby = new SwimLobby(io);
  const refunds = [], settles = [];
  lobby.onRefund = (r) => refunds.push(r);
  lobby.onSettled = (r) => settles.push(r);
  return { lobby, io, refunds, settles };
}

test('a free seat races the bot after a minute; a paid seat never does and is refunded after the give-up', () => {
  const { lobby, refunds } = lobbyWith();
  const f = sock(), p = sock();
  const t0 = 1e6;
  lobby.enqueue(f, 'Free', null, 0, 0, t0);
  lobby.enqueue(p, 'Paid', 'WP', 1, 1, t0, 1);
  lobby.tick(t0 + FREE_WAIT_MS - 1);
  assert.strictEqual(lobby.rooms.size, 0);
  lobby.tick(t0 + FREE_WAIT_MS + 1);
  assert.strictEqual(lobby.rooms.size, 1);
  const room = [...lobby.rooms.values()][0];
  assert.ok(room.bot && room.stake === 0 && room.players.has(f.id));
  assert.ok(lobby.queue.some(e => e.socket.id === p.id), 'the paid seat is still waiting');
  lobby.tick(t0 + PAID_GIVE_UP_MS - 1);
  assert.strictEqual(refunds.length, 0);
  lobby.tick(t0 + PAID_GIVE_UP_MS + 1);
  assert.strictEqual(refunds.length, 1);
  assert.deepStrictEqual([refunds[0].wallet, refunds[0].amount], ['WP', 1]);
  lobby.leave(p.id);
  assert.strictEqual(refunds.length, 1, 'refunded once');
});

test('cancel refunds at once; different rungs and the same wallet never pair; two people pair', () => {
  const { lobby, refunds } = lobbyWith();
  const a = sock(), b = sock(), c = sock(), d = sock();
  lobby.enqueue(a, 'A', 'W1', 0.5, 0.5, 1, 0.5);
  lobby.enqueue(b, 'B', 'W2', 1, 1, 2, 1);
  lobby.enqueue(c, 'C', 'W1', 0.5, 0.5, 3, 0.5);     // same wallet as A
  assert.strictEqual(lobby.rooms.size, 0);
  lobby.leave(c.id);
  assert.strictEqual(refunds.length, 1);
  lobby.enqueue(d, 'D', 'W3', 0.5, 0.5, 4, 0.5);
  assert.strictEqual(lobby.rooms.size, 1);
  const room = [...lobby.rooms.values()][0];
  assert.strictEqual(room.stake, 0.5);
  assert.strictEqual(room.pot(), 1);
  assert.ok(!room.bot);
});

test('a restart owes every paid seat it holds, queued or racing, and nothing twice', () => {
  const { lobby, refunds, settles } = lobbyWith();
  const a = sock(), b = sock(), q = sock();
  lobby.enqueue(a, 'A', 'WA', 1, 1, 1, 1);
  lobby.enqueue(b, 'B', 'WB', 1, 1, 2, 1);
  lobby.enqueue(q, 'Q', 'WQ', 0.5, 0.5, 3, 0.5);
  const rows = lobby.shutdownSettle('shutdown');
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows.map(r => r.micro).sort(), [1000000, 1000000, 500000]);
  assert.ok(rows.every(r => /^refund swim /.test(r.reason) && r.key.startsWith('agowed:')));
  assert.strictEqual(lobby.enqueue(sock(), 'Late', 'WL', 1, 1, 4, 1), false, 'nothing new is held');
  const room = [...lobby.rooms.values()][0];
  room.finish('a', 'crashed');
  assert.strictEqual(settles.length, 0, 'a settled room pays nothing after the restart owes it');
  assert.strictEqual(refunds.length, 0);
});

test('leaving mid-race gives the race to the other seat', () => {
  const { lobby, settles } = lobbyWith();
  const a = sock(), b = sock();
  lobby.enqueue(a, 'A', 'WA', 1, 1, 1, 1);
  lobby.enqueue(b, 'B', 'WB', 1, 1, 2, 1);
  const room = [...lobby.rooms.values()][0];
  lobby.tick(room.goAt + 100);
  lobby.leave(a.id);
  assert.strictEqual(settles.length, 1);
  assert.strictEqual(settles[0].winnerId, b.id);
  assert.strictEqual(lobby.rooms.size, 0);
});

test('a person turning up early in a bot race takes the bot\'s place', () => {
  const { lobby } = lobbyWith();
  const a = sock(), b = sock();
  lobby.enqueue(a, 'A', null, 0, 0, 1);
  lobby.tick(1 + FREE_WAIT_MS + 1);
  const botRoom = [...lobby.rooms.values()][0];
  assert.ok(botRoom.bot);
  lobby.enqueue(b, 'B', null, 0, 0, 2 + FREE_WAIT_MS);
  const room = [...lobby.rooms.values()][0];
  assert.ok(!room.bot && room.players.has(a.id) && room.players.has(b.id));
  assert.strictEqual(lobby.rooms.size, 1);
});

test('the bot drives a whole race on the real lobby clock', () => {
  const { lobby } = lobbyWith();
  const a = sock();
  lobby.enqueue(a, 'A', null, 0, 0, 1);
  lobby.tick(1 + FREE_WAIT_MS + 1);
  const room = [...lobby.rooms.values()][0];
  // The person sends nothing: their car runs on its last (neutral) input and soon hits something.
  let t = room.goAt;
  for (let i = 0; i < 60 * 120 && lobby.rooms.size; i++) { t += S.TICK_MS; lobby.tick(t); }
  assert.strictEqual(lobby.rooms.size, 0, 'the race ended and was swept');
});

test('the bot holds the gas itself, close passes with daylight, and lasts its first minute on the real traffic', () => {
  const { SwimBot } = require('../server/swim/swimBot');
  for (let seed = 1; seed <= 4; seed++) {
    const tr = new S.Traffic(), sp = new Spawner(seed), car = S.newCar(seed & 1), bot = new SwimBot(S.rng(seed));
    sp.run(tr, 0, 0, S.V0, null);
    let sv = 0, st = 0, gas = 0, passes = 0, closest = Infinity;
    for (let t = 0; t < 60 * 60 && car.alive; t++) {
      sp.run(tr, t, car.z, car.v, null);
      const code = bot.input(car, tr, t, null);
      assert.ok(S.validInput(code));
      if (S.pedalOf(code) > 0) gas++;
      S.step(car, code, tr);
      if (car.close >= 0) { passes++; closest = Math.min(closest, car.close); }
      tr.prune(car.z - 120, t + 1);
      sv += car.v; st += S.topSpeed(t);
    }
    assert.strictEqual(car.alive, true, 'seed ' + seed + ': crashed at ' + (car.crashTick / 60).toFixed(1) + ' s');
    assert.ok(gas > 0.6 * 3600, 'seed ' + seed + ': the gas held ' + (gas / 36).toFixed(0) + '% of the time');
    assert.ok(sv / st > 0.75, 'seed ' + seed + ': ' + (100 * sv / st).toFixed(0) + '% of the top speed on average');
    assert.ok(passes >= 8 && closest > 0.1, 'seed ' + seed + ': ' + passes + ' close passes, closest ' + closest.toFixed(2) + ' m');
  }
});

test('a server stall does not drive anyone blind: inputs sent in time are still used', () => {
  const { room } = racing();
  run(room, 60, S.NEUTRAL, S.NEUTRAL);
  /* The server stalls for 40 ticks (a GC pause). When it wakes, its timer runs before the packets the
     screens sent on time meanwhile are read: the clock jumps, and nobody may be driven blind for it. */
  room.tick(at(room, 100));
  const a = room.bySide(0), b = room.bySide(1);
  assert.strictEqual(a.car.tick, 60, 'nobody was moved on with a guessed input');
  for (let t = 60; t < 100; t += 4) {
    room.input('a', { t: t + 3, k: new Array(4).fill(S.packInput(1, 1)) });
    room.input('b', { t: t + 3, k: new Array(4).fill(S.packInput(-1, 1)) });
  }
  room.tick(at(room, 101));
  assert.strictEqual(a.car.tick, 100, 'the inputs that had been sent in time were used (it waits at 100 for 100)');
  // Every tick from 60 ran on the input actually sent for it (full right and gas), not a repeat of neutral.
  const ref = S.newCar(0);
  for (let t = 0; t < 60; t++) S.step(ref, S.NEUTRAL, room.traffic);
  for (let t = 60; t < 100; t++) S.step(ref, S.packInput(1, 1), room.traffic);
  assert.strictEqual(a.car.x, ref.x);
  assert.strictEqual(b.car.tick, 100);
  // A connection that really went quiet is still moved on once the floor catches up.
  for (let t = 101; t <= 160; t++) { room.input('b', { t: t - 1, k: [S.NEUTRAL] }); room.tick(at(room, t)); }
  assert.strictEqual(a.car.tick, 160 - LAG_MAX);
});

test('a socket already racing cannot queue a second seat', () => {
  const { lobby } = lobbyWith();
  const a = sock(), b = sock();
  lobby.enqueue(a, 'A', 'WA', 1, 1, 1, 1);
  lobby.enqueue(b, 'B', 'WB', 1, 1, 2, 1);
  assert.strictEqual(lobby.rooms.size, 1);
  assert.strictEqual(lobby.enqueue(a, 'A', 'WA', 1, 1, 3, 1), false);
  assert.strictEqual(lobby.queue.length, 0);
});

test('a crashed car does not win by walkover when the other leaves before the crash is judged', () => {
  const { room } = racing({ worth: 1, wa: 'WA', wb: 'WB' });
  const settled = [];
  room.onSettled = (x) => settled.push(x);
  const rec = [1, 1, 0, 50, 0, 0];
  room.traffic.add(rec.slice());
  const c = crashTickFor(0, rec, S.NEUTRAL);
  run(room, c + 5, S.NEUTRAL, S.NEUTRAL, c - 30);     // Ann crashes; Bob trails and has not reached it
  assert.strictEqual(room.bySide(0).car.alive, false);
  assert.strictEqual(room.state, 'racing');
  room.removePlayer('b');
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.overWhy, 'both out');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, null, 'a draw: every seat gets its own stake back');
  assert.deepStrictEqual(settled[0].seats.map(s => s.wallet).sort(), ['WA', 'WB']);
});

/* ── a dropped connection mid-race: five seconds to come back ─────────── */
/* A paid race between A (wallet WA) and B (WB) on the lobby's own clock, with the traffic emptied so
   nothing on the road decides it unless a test puts it there. */
function paidRace() {
  const { lobby, io, refunds, settles } = lobbyWith();
  const a = sock(), b = sock();
  lobby.enqueue(a, 'A', 'WA', 1, 1, 1, 1);
  lobby.enqueue(b, 'B', 'WB', 1, 1, 2, 1);
  const room = [...lobby.rooms.values()][0];
  room.traffic = new S.Traffic();
  room.spawner = { run() {} };
  lobby.tick(room.goAt);
  assert.strictEqual(room.state, 'racing');
  return { lobby, io, refunds, settles, room, a, b };
}
const keyOf = (s) => { const m = s.got.filter(x => x.ev === 'sw:seat').pop(); return m ? m.p.key : null; };
const gotEv = (s, ev) => s.got.filter(x => x.ev === ev);
/* Run the lobby to tick `until`; `codes` maps a socket id to the input it sends for every tick. */
function lobbyRun(lobby, room, until, codes) {
  for (let t = room.clock + 1; t <= until && lobby.rooms.has(room.id); t++) {
    for (const id of Object.keys(codes)) room.input(id, { t: t - 1, k: [codes[id]] });
    lobby.tick(at(room, t));
  }
}
const joinable = () => { const s = sock(); s.joined = []; s.join = (n) => s.joined.push(n); return s; };

test('each seat is sent its own key when the race starts, never broadcast', () => {
  const { io, room, a, b } = paidRace();
  const ka = keyOf(a), kb = keyOf(b);
  assert.ok(/^[0-9a-f]{32}$/.test(ka) && /^[0-9a-f]{32}$/.test(kb) && ka !== kb);
  assert.ok(!JSON.stringify(io.sent).includes(ka) && !JSON.stringify(io.sent).includes(kb), 'not to the room or the watchers');
  assert.ok(!JSON.stringify(a.got).includes(kb), 'nobody is sent the other seat key');
  assert.ok(!JSON.stringify(room.watchSnapshot(Date.now())).includes(ka));
});

test('a seat that reconnects inside 5 s keeps its stake and its wallet under the new socket, and wins the race normally', () => {
  const { lobby, settles, refunds, room, a, b } = paidRace();
  const pot = room.pot();
  const ka = keyOf(a);
  lobbyRun(lobby, room, 60, { [a.id]: S.NEUTRAL, [b.id]: S.NEUTRAL });
  assert.strictEqual(lobby.drop(a.id, at(room, 60)), true);
  assert.strictEqual(room.state, 'racing', 'a drop is not a leave any more');
  assert.strictEqual(settles.length, 0);
  // Four seconds away: the server drives the car on, straight, and the race is still on.
  lobbyRun(lobby, room, 300, { [b.id]: S.NEUTRAL });
  const seat = room.bySide(0);
  assert.strictEqual(room.state, 'racing');
  assert.ok(seat.car.tick >= 300 - LAG_MAX - 2 && seat.car.alive, 'driven on while away');
  assert.strictEqual(seat.car.x, S.newCar(0).x, 'straight');

  const a2 = joinable();
  const r = lobby.rejoin(a2, ka, at(room, 300));
  assert.strictEqual(r.ok, true);
  // Everything the money reads moved to the new id once, nothing left under the old one.
  assert.ok(room.players.has(a2.id) && !room.players.has(a.id));
  assert.ok(room.worth.has(a2.id) && !room.worth.has(a.id));
  assert.strictEqual(room.worth.get(a2.id), 1);
  assert.strictEqual(room.players.get(a2.id).wallet, 'WA', 'the wallet that paid, not one the new socket names');
  assert.strictEqual(room.players.get(a2.id).paid, 1);
  assert.strictEqual(room.players.get(a2.id), seat, 'the same seat and car');
  assert.strictEqual(room.seats[0].id, a2.id);
  assert.strictEqual(lobby.bySocket.get(a2.id), room.id);
  assert.ok(!lobby.bySocket.has(a.id));
  assert.strictEqual(room.pot(), pot, 'the pot is unchanged');
  assert.strictEqual(seat.away, 0);
  assert.ok(a2.joined.includes(room.socketRoomName), 'joined the race channel');
  const back = gotEv(a2, 'sw:rejoined')[0].p;
  assert.strictEqual(back.side, 0);
  assert.strictEqual(back.stake, 1);
  assert.strictEqual(back.pot, 2);
  assert.strictEqual(back.vsBot, false);
  assert.deepStrictEqual(back.players.map(p => [p.side, p.name]).sort(), [[0, 'A'], [1, 'B']]);
  assert.ok(Array.isArray(back.cars) && back.p.length === 2 && back.goAt === room.goAt && Number.isFinite(back.now));
  assert.ok(!JSON.stringify(back).includes('WA') && !JSON.stringify(back).includes('WB'), 'no wallet on the wire');
  const k2 = keyOf(a2);
  assert.ok(/^[0-9a-f]{32}$/.test(k2) && k2 !== ka, 'a fresh key for the next drop');
  // The old socket can no longer steer; the new one can.
  assert.strictEqual(room.input(a.id, { t: room.clock, k: [S.NEUTRAL] }), false);
  assert.strictEqual(room.input(a2.id, { t: room.clock, k: [S.packInput(0, 1)] }), true);

  // Gas against brake: A pulls 200 m clear and wins, paid to WA once.
  lobbyRun(lobby, room, 6000, { [a2.id]: S.packInput(0, 1), [b.id]: S.packInput(0, -1) });
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.overWhy, 'fell behind');
  assert.strictEqual(settles.length, 1);
  assert.strictEqual(settles[0].winnerId, a2.id);
  assert.strictEqual(settles[0].pot, pot);
  const win = settles[0].seats.find(s => s.id === settles[0].winnerId);
  assert.strictEqual(win.wallet, 'WA');
  assert.ok(!settles[0].seats.some(s => s.id === a.id), 'nothing under the old id');
  assert.strictEqual(settles[0].seats.reduce((n, s) => n + s.worth, 0), pot);
  // The old socket's late disconnect, and the new one leaving, change nothing.
  lobby.drop(a.id, Date.now()); lobby.leave(a.id); lobby.leave(a2.id);
  assert.strictEqual(settles.length, 1, 'settled once');
  assert.strictEqual(refunds.length, 0);
  assert.strictEqual(lobby.rooms.size, 0);
});

test('a seat that does not come back in 5 s loses, exactly as a disconnect did', () => {
  const { lobby, settles, refunds, room, a, b } = paidRace();
  const ka = keyOf(a);
  lobbyRun(lobby, room, 60, { [a.id]: S.NEUTRAL, [b.id]: S.NEUTRAL });
  lobby.drop(a.id, at(room, 60));
  lobbyRun(lobby, room, 359, { [b.id]: S.NEUTRAL });          // 4.98 s after the drop
  assert.strictEqual(room.state, 'racing');
  assert.strictEqual(settles.length, 0);
  lobbyRun(lobby, room, 362, { [b.id]: S.NEUTRAL });          // past 5 s
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.overWhy, 'opponent left');
  assert.strictEqual(settles.length, 1);
  assert.strictEqual(settles[0].winnerId, b.id);
  assert.strictEqual(settles[0].pot, 2);
  assert.strictEqual(settles[0].seats.find(s => s.id === b.id).wallet, 'WB');
  assert.strictEqual(lobby.rooms.size, 0);
  assert.strictEqual(lobby.bySocket.size, 0);
  // A reconnect now is too late: it is told the result, and nothing moves.
  const a2 = sock();
  assert.strictEqual(lobby.rejoin(a2, ka, at(room, 400)).ok, false);
  const fail = gotEv(a2, 'sw:rejoinfail')[0].p;
  assert.strictEqual(fail.side, 0);
  assert.strictEqual(fail.over.why, 'opponent left');
  assert.strictEqual(fail.over.winnerSide, 1);
  assert.ok(!JSON.stringify(fail).includes('WA') && !JSON.stringify(fail).includes('WB'));
  assert.strictEqual(lobby.rejoin(sock(), ka, at(room, 400)).ok, false, 'and only once');
  lobby.tick(at(room, 1000));
  assert.strictEqual(settles.length, 1);
  assert.strictEqual(refunds.length, 0);
});

test('a crash during the grace is judged normally, and the expiry never touches the ended race', () => {
  const { lobby, settles, room, a, b } = paidRace();
  const ka = keyOf(a);
  const rec = [1, 1, 0, 40, 0, 0];                             // a sedan in A's lane, met about 2.5 s after the drop
  room.traffic.add(rec.slice());
  const c = crashTickFor(0, rec, S.NEUTRAL);
  assert.ok(c > 90 && c + LAG_MAX + 5 < 60 + 300, 'the crash falls inside the grace (' + c + ')');
  lobbyRun(lobby, room, 60, { [a.id]: S.NEUTRAL, [b.id]: S.NEUTRAL });
  lobby.drop(a.id, at(room, 60));
  // A, away, is driven straight on into the sedan.
  lobbyRun(lobby, room, 400, { [b.id]: S.NEUTRAL });
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.overWhy, 'crashed');
  assert.strictEqual(room.endTick, c);
  assert.strictEqual(settles.length, 1);
  assert.strictEqual(settles[0].winnerId, b.id);
  lobby.tick(at(room, 2000));                                  // well past the grace
  assert.strictEqual(settles.length, 1, 'settled once');
  const a2 = sock();
  assert.strictEqual(lobby.rejoin(a2, ka, at(room, 2000)).ok, false);
  assert.strictEqual(gotEv(a2, 'sw:rejoinfail')[0].p.over.why, 'crashed');
});

test('a wrong key, a used key, a seated or queued socket and a race that ended cannot rejoin', () => {
  const { lobby, settles, room, a, b } = paidRace();
  const ka = keyOf(a);
  lobby.drop(a.id, at(room, 1));
  const tries = [
    [sock(), 'f'.repeat(32)],
    [sock(), 'not a key'],
    [sock(), null],
    [b, ka],                                                   // already seated in this race
  ];
  const q = sock();
  lobby.enqueue(q, 'Q', 'WQ', 0.5, 0.5, 3, 0.5);
  tries.push([q, ka]);                                         // holds a queue place
  for (const [s, k] of tries) {
    assert.strictEqual(lobby.rejoin(s, k, at(room, 2)).ok, false);
    assert.ok(gotEv(s, 'sw:rejoinfail').length >= 1);
  }
  assert.ok(room.players.has(a.id), 'the seat is still held for its own key');
  assert.ok(lobby.queue.some(e => e.socket.id === q.id), 'the queued seat is untouched');
  const a2 = sock();
  assert.strictEqual(lobby.rejoin(a2, ka, at(room, 3)).ok, true);
  assert.strictEqual(lobby.rejoin(sock(), ka, at(room, 4)).ok, false, 'a key works once');
  assert.ok(room.players.has(a2.id));
  // The fresh key takes a second drop back.
  lobby.drop(a2.id, at(room, 5));
  const a3 = sock();
  assert.strictEqual(lobby.rejoin(a3, keyOf(a2), at(room, 6)).ok, true);
  assert.strictEqual(room.pot(), 2);
  assert.strictEqual(room.worth.size, 2);
  lobby.leave(b.id);
  assert.strictEqual(settles.length, 1);
  assert.strictEqual(settles[0].winnerId, a3.id);
  assert.strictEqual(settles[0].seats.find(s => s.id === a3.id).wallet, 'WA');
  assert.strictEqual(lobby.rejoin(sock(), keyOf(a3), Date.now()).ok, false, 'the race is over');
});

test('a queued seat still leaves at once on a disconnect', () => {
  const { lobby, refunds } = lobbyWith();
  const q = sock();
  lobby.enqueue(q, 'Q', 'WQ', 1, 1, 1, 1);
  assert.strictEqual(lobby.drop(q.id, 2), false);
  assert.strictEqual(refunds.length, 1);
  assert.strictEqual(lobby.queue.length, 0);
});

test('a newcomer is never paired with a bot race whose person is away', () => {
  const { lobby } = lobbyWith();
  const a = sock(), b = sock();
  lobby.enqueue(a, 'A', null, 0, 0, 1);
  lobby.tick(1 + FREE_WAIT_MS + 1);
  const botRoom = [...lobby.rooms.values()][0];
  assert.ok(botRoom.bot);
  assert.strictEqual(lobby.drop(a.id, 2 + FREE_WAIT_MS), true);
  lobby.enqueue(b, 'B', null, 0, 0, 3 + FREE_WAIT_MS);
  assert.ok(lobby.rooms.get(botRoom.id) === botRoom && botRoom.players.has(a.id), 'the held seat stays in its own race');
  assert.ok(lobby.queue.some(e => e.socket.id === b.id), 'the newcomer waits');
});

test('both seats running out of grace together is a draw that refunds both, not a win for one', () => {
  const { lobby, settles, room, a, b } = paidRace();
  lobbyRun(lobby, room, 60, { [a.id]: S.NEUTRAL, [b.id]: S.NEUTRAL });
  lobby.drop(a.id, at(room, 60));
  lobby.drop(b.id, at(room, 60));
  lobbyRun(lobby, room, 362, {});
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.overWhy, 'both out');
  assert.strictEqual(settles.length, 1);
  assert.strictEqual(settles[0].winnerId, null);
  assert.deepStrictEqual(settles[0].seats.map(s => s.wallet).sort(), ['WA', 'WB']);
  assert.strictEqual(lobby.rooms.size, 0);
});

/* ── looks (Owen 2026-10-28): one choice of three cars, each with its own paint and engine, shown to the other
   seat and the watchers ──────────────────────────────────────────────────────────────────────────────────── */
const SwimLooks = require('../shared/swimLooks');

test('looks: anything not a listed car is the supercar; a colour or other field is dropped, nothing echoed', () => {
  assert.deepStrictEqual(SwimLooks.clean({ car: 'muscle' }), { car: 'muscle' });
  assert.deepStrictEqual(SwimLooks.clean({ car: 'hatch', colour: 'teal' }), { car: 'hatch' }, 'an older page\'s colour is ignored');
  for (const junk of [null, undefined, 7, 'muscle', [], { car: 'limo' }, { car: '__proto__' }, { car: 'constructor' },
    { car: { toString: () => 'muscle' } }, { car: 'Muscle' }, { car: ' hatch' }, { colour: 'gold' }]) {
    assert.deepStrictEqual(SwimLooks.clean(junk), { car: 'supercar' }, JSON.stringify(junk));
  }
  const sent = { car: 'hatch', colour: 'crimson', extra: '<script>' };
  const kept = SwimLooks.clean(sent);
  assert.notStrictEqual(kept, sent);
  assert.deepStrictEqual(Object.keys(kept), ['car'], 'only the car id, never other fields');
  assert.deepStrictEqual(SwimLooks.CARS.map(c => c.id), ['supercar', 'muscle', 'hatch']);
  const { room } = bareRoom();
  room.addPlayer(sock('x'), 'X', null, 0, 0, null, { car: 'tank', colour: 'rainbow' });
  assert.deepStrictEqual(room.bySide(0).look, { car: 'supercar' });
});

test('looks: each seat\'s car rides in sw:start players and the watcher state, by seat', () => {
  const { room, io } = bareRoom();
  room.addPlayer(sock('a'), 'Ann', null, 0, 0, null, { car: 'muscle', colour: 'crimson' });
  room.addPlayer(sock('b'), 'Bob', null, 0, 0, null, { car: 'nope' });
  room.start(1000);
  const start = io.sent.find(m => m.ev === 'sw:start').p;
  const bySide = (ps) => ps.slice().sort((x, y) => x.side - y.side).map(q => q.car);
  assert.deepStrictEqual(bySide(start.players), ['muscle', 'supercar']);
  assert.ok(start.players.every(q => !('colour' in q)), 'the paint comes from the car, never sent');
  const w = room.watchSnapshot(Date.now());
  assert.deepStrictEqual(bySide(w.players), ['muscle', 'supercar']);
  assert.ok(w.players.every(p => !('id' in p)), 'watchers get seats, never ids');
  // Through the lobby too: a queued car reaches the room's seats.
  const { lobby } = lobbyWith();
  const p1 = sock(), p2 = sock();
  lobby.enqueue(p1, 'P1', null, 0, 0, 1, undefined, null, { car: 'hatch' });
  lobby.enqueue(p2, 'P2', null, 0, 0, 2, undefined, null, { car: 'evil', colour: 'teal' });
  const r = lobby.rooms.get(lobby.bySocket.get(p1.id));
  assert.ok(r, 'the two were seated');
  assert.deepStrictEqual(r.players.get(p1.id).look, { car: 'hatch' });
  assert.deepStrictEqual(r.players.get(p2.id).look, { car: 'supercar' });
});

test('looks never touch the race: three different cars step bit for bit like default looks', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'shared', 'swimSim.js'), 'utf8');
  assert.ok(!/swimLooks|SWIM_LOOKS|\.look|\.colour|supercar|muscle/.test(src), 'nothing in the step reads a look');
  const runWith = (looks) => {
    const io = fakeIo();
    const room = new SwimRoom(io);
    room.io = io;
    room.seed = 0x1234abcd; room.spawner = new Spawner(room.seed);
    room.addPlayer(sock('a'), 'Ann', null, 0, 0, null, looks[0]);
    room.addPlayer(sock('b'), 'Bob', null, 0, 0, null, looks[1]);
    room.start(1000);
    room.tick(room.goAt);
    const rows = [];
    for (let t = 1; t <= 900 && room.state === 'racing'; t++) {
      const steerA = Math.sin(t / 37), steerB = Math.cos(t / 23);
      room.input('a', { t: t - 1, k: [S.packInput(steerA, t % 200 < 150 ? 1 : 0)] });
      room.input('b', { t: t - 1, k: [S.packInput(steerB, t % 170 < 120 ? 1 : -1)] });
      room.tick(at(room, t));
      if (t % 30 === 0) rows.push(JSON.stringify(room.carRows()));
    }
    return { rows, cars: [0, 1].map(s => JSON.stringify(room.bySide(s).car)), state: room.state, winner: room.winner };
  };
  const plain = runWith([undefined, undefined]);
  const dressed = runWith([{ car: 'muscle' }, { car: 'hatch', colour: 'teal' }]);
  assert.ok(plain.rows.length >= 5);
  assert.deepStrictEqual(dressed, plain);
});

