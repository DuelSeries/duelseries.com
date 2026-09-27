'use strict';
// Own-square predictor (T10, design 8.2): exact agreement with the server sim, the input FIFO
// under jitter (and the old latest-wins rules failing), replay, lock, ack miss, and the
// exact-vertex sweeps that prove the guard stops the stock hang.
const test = require('node:test');
const assert = require('node:assert');
const { makeArena, P, MP } = require('../server/paper/ArenaGame');
const { step, Predictor } = require('../public/js/paper/mp/paperPredict.js');

const C = 1000;
const at = (r, a) => new P.Vec2(C + Math.cos(a) * r, C + Math.sin(a) * r);

function server({ stub = true, spot = at(500, 0.3) } = {}) {
  const g = makeArena({ stake: 0.1, seed: 0.71 });
  g.radiusTarget = () => 950;
  g.setRadiusNow(950);
  if (stub) g.rng = () => 0.5;
  // The lock follows the applied hold bit, in the same tick (what the room does, 5.4).
  const apply = g.applyInputs.bind(g);
  g.applyInputs = function () {
    apply();
    for (const h of this.humans) h.locked = h.holdBit;
  };
  const h = g.spawnHuman({ name: 'me' }, spot);
  return { g, h };
}

function client(h) {
  const border = MP.guardedBorder(new P.Vec2(C, C), 300, 950);
  const pred = new Predictor({ border, config: P.defaultPaperConfig });
  pred.reset({ x: h.position.x, y: h.position.y, dir: h.direction });
  return pred;
}

// 200 straight ticks, out to the wall and a counter-clockwise slide along it (157 ticks on the
// wall), then back inward with a slow weave: 600 ticks, the square survives.
function script(t) {
  if (t < 200) return 20;
  if (t < 460) return 35 + Math.floor((t - 200) / 40);
  return (163 + (((t >> 4) & 1) ? 5 : -5)) % 254;
}

function frameOf(h) {
  return { x: h.position.x, y: h.position.y, dir: h.direction, ack: h.seqAck, holding: h.locked };
}

test('bit-exact with the server over 600 ticks when the server dt draw is stubbed to 0.5', () => {
  const { g, h } = server();
  const pred = client(h);
  let slid = false;
  for (let t = 0; t < 600; t++) {
    const input = pred.next(script(t));
    const d = MP.decodeInput(input);
    g.setInput(h.id, d.seq, d.angle, d.hold, 0);
    g.update(MP.STEP_MS);
    assert.ok(!h.death, 'alive at ' + t);
    assert.ok(Math.abs(pred.state.x - h.position.x) < 1e-9 && Math.abs(pred.state.y - h.position.y) < 1e-9, 'tick ' + t + ' off by ' + Math.hypot(pred.state.x - h.position.x, pred.state.y - h.position.y));
    if (Math.hypot(h.position.x - C, h.position.y - C) > 949.9) slid = true;
  }
  assert.ok(slid, 'the script slides along the wall');
});

test('under RECONCILE_POS_EPS over 600 ticks against the unstubbed server', () => {
  const { g, h } = server({ stub: false });
  const pred = client(h);
  let worst = 0;
  for (let t = 0; t < 600; t++) {
    const d = MP.decodeInput(pred.next(script(t)));
    g.setInput(h.id, d.seq, d.angle, d.hold, 0);
    g.update(MP.STEP_MS);
    worst = Math.max(worst, Math.hypot(pred.state.x - h.position.x, pred.state.y - h.position.y));
  }
  assert.ok(!h.death);
  assert.ok(worst < MP.RECONCILE_POS_EPS, 'worst ' + worst);
});

// Drives server and client with in-order delivery delays (0..maxDelay ticks), frames every
// SNAPSHOT_EVERY ticks. `oldRules` replays the pre-FIFO design: a send every 2nd tick and the
// server applying the latest input at once.
function jitterRun({ maxDelay, seed, oldRules = false, drop = () => false, hold = () => false }) {
  const { g, h } = server();
  const pred = client(h);
  let s = seed;
  const rand = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  let starves = 0;
  let drops = 0;
  const fifoPush = g.setInput.bind(g);
  g.setInput = function (id, seq, angle, holdBit, when) {
    if (h._fifo.length >= MP.INPUT_QUEUE_MAX) drops++;
    return fifoPush(id, seq, angle, holdBit, when);
  };
  const apply = g.applyInputs.bind(g);
  g.applyInputs = function () {
    if (!oldRules && !h._fifo.length) starves++;
    apply();
  };
  const inflight = [];
  let lastDelivery = 0;
  let exactAcks = 0;
  let mismatches = 0;
  let lastInput = null;
  for (let t = 0; t < 600; t++) {
    pred.setHold(hold(t));
    const input = pred.next(script(t));
    lastInput = input;
    if (!drop(t) && (!oldRules || t % 2 === 1)) {
      const when = Math.max(lastDelivery, t + Math.floor(rand() * (maxDelay + 1)));
      lastDelivery = when;
      inflight.push({ when, input: oldRules ? lastInput : input });
    }
    while (inflight.length && inflight[0].when <= t) {
      const d = MP.decodeInput(inflight.shift().input);
      if (oldRules) {
        h.angle = d.angle;
        h.holdBit = d.hold;
        h.seqAck = d.seq;
      } else {
        g.setInput(h.id, d.seq, d.angle, d.hold, 0);
      }
    }
    g.update(MP.STEP_MS);
    if (h.death) break;
    if (g.tick % MP.SNAPSHOT_EVERY === 0) {
      const e = pred.entry(h.seqAck);
      if (e && Math.hypot(e.after.x - h.position.x, e.after.y - h.position.y) < 1e-9) exactAcks++;
      const r = pred.reconcile(frameOf(h));
      if (r !== 'ok') mismatches++;
    }
  }
  return { g, h, pred, starves, drops, exactAcks, mismatches, rebases: pred.stats.rebases, snaps: pred.stats.snaps };
}

test('FIFO: zero jitter means zero re-bases and exact agreement at every acked tick', () => {
  const r = jitterRun({ maxDelay: 0, seed: 1 });
  assert.ok(!r.h.death);
  assert.strictEqual(r.starves, 0);
  assert.strictEqual(r.drops, 0);
  assert.strictEqual(r.rebases, 0);
  assert.strictEqual(r.snaps, 0);
  assert.strictEqual(r.exactAcks, 300);
});

test('FIFO: 0 to 2 ticks of in-order bunching gives re-bases <= starves + drops; the old rules fail', () => {
  for (const seed of [3, 4, 5]) {
    const r = jitterRun({ maxDelay: 2, seed });
    assert.ok(!r.h.death);
    assert.ok(r.starves + r.drops > 0, 'the jitter did something');
    assert.ok(r.rebases <= r.starves + r.drops, `seed ${seed}: rebases ${r.rebases} > starves ${r.starves} + drops ${r.drops}`);
    assert.strictEqual(r.snaps, 0);
    const old = jitterRun({ maxDelay: 2, seed, oldRules: true });
    assert.ok(old.rebases > r.starves + r.drops && old.rebases > r.rebases, `seed ${seed}: the old rules should fail the bound (old ${old.rebases}, fifo ${r.rebases})`);
  }
});

test('replay after dropped inputs converges, and through a held stretch uses the stored hold bit', () => {
  const dropped = jitterRun({ maxDelay: 0, seed: 7, drop: (t) => t >= 100 && t < 106 });
  assert.ok(!dropped.h.death);
  assert.ok(dropped.rebases >= 1 && dropped.rebases <= dropped.starves + dropped.drops);
  const e = dropped.pred.entry(dropped.h.seqAck);
  assert.ok(e && Math.hypot(e.after.x - dropped.h.position.x, e.after.y - dropped.h.position.y) < 1e-9, 'exact again');

  const held = jitterRun({ maxDelay: 2, seed: 8, hold: (t) => t >= 250 && t < 330 });
  assert.ok(!held.h.death);
  assert.ok(held.rebases <= held.starves + held.drops, `held: ${held.rebases} vs ${held.starves + held.drops}`);
});

test('an ack not in the ring snaps, and the next in-ring ack resumes', () => {
  const { g, h } = server();
  const pred = client(h);
  for (let t = 0; t < 10; t++) {
    const d = MP.decodeInput(pred.next(20));
    g.setInput(h.id, d.seq, d.angle, d.hold, 0);
    g.update(MP.STEP_MS);
  }
  assert.strictEqual(pred.reconcile({ x: h.position.x + 3, y: h.position.y, dir: h.direction, ack: 200, holding: false }), 'snap');
  assert.strictEqual(pred.state.x, h.position.x + 3);
  for (let t = 0; t < 4; t++) {
    const d = MP.decodeInput(pred.next(20));
    g.setInput(h.id, d.seq, d.angle, d.hold, 0);
    g.update(MP.STEP_MS);
  }
  const r = pred.reconcile(frameOf(h));
  assert.ok(r === 'rebase' || r === 'ok');
  assert.strictEqual(pred.reconcile(frameOf(h)), 'ok');
});

test('the lock: zero displacement, no timer release, and a confirming frame releases it', () => {
  const { h } = server();
  const pred = client(h);
  pred.next(20);
  pred.setHold(true);
  const s0 = { ...pred.state };
  const sent = [];
  for (let t = 0; t < 24; t++) sent.push(MP.decodeInput(pred.next(90))); // 400 ms, no frames
  assert.strictEqual(Math.hypot(pred.state.x - s0.x, pred.state.y - s0.y).toFixed(3), '0.000');
  assert.ok(sent.every(d => d.hold), 'the hold bit is still sent');
  assert.strictEqual(pred.locked(), true);
  // The server says it is not holding, for an ack past the hold start: released.
  const e = pred.entry(sent[5].seq);
  pred.reconcile({ x: e.after.x, y: e.after.y, dir: e.after.dir, ack: sent[5].seq, holding: false });
  assert.strictEqual(pred.locked(), false);
  pred.next(90);
  assert.ok(Math.hypot(pred.state.x - s0.x, pred.state.y - s0.y) > 1, 'moving again');
});

function sweep(makeBorder, start, byte) {
  let maxCalls = 0;
  let ends = 0;
  let threw = 0;
  for (let k = 0; k < 150; k++) {
    const border = makeBorder();
    let calls = 0;
    const inner = border.intersections;
    border.intersections = function (seg) {
      calls++;
      return inner.call(this, seg);
    };
    let s = start(k);
    try {
      for (let t = 0; t < 120; t++) {
        calls = 0;
        s = step(s, byte, false, MP.STEP_MS + MP.PREDICT_DT_BIAS_MS, border, P.defaultPaperConfig, null);
        maxCalls = Math.max(maxCalls, calls);
      }
      if (MP.wallInside(border, s.x, s.y)) ends++;
    } catch (e) {
      threw++;
    }
  }
  return { maxCalls, ends, threw };
}

test('exact-vertex sweeps: no step over BORDER_GUARD_CALLS + 1 calls, under 1 s, inside at the end', () => {
  const guarded = () => MP.guardedBorder(new P.Vec2(C, C), 300, 950);
  const t0 = Date.now();
  const east = sweep(guarded, (k) => ({ x: 1900 + k * 0.01, y: 1000, dir: 0 }), 0);
  const north = sweep(guarded, (k) => ({ x: 1000, y: 1900 + k * 0.01, dir: Math.PI / 2 }), 64);
  const ms = Date.now() - t0;
  console.log('# sweeps: east max calls ' + east.maxCalls + ', north max calls ' + north.maxCalls + ', ' + ms + ' ms');
  for (const r of [east, north]) {
    assert.strictEqual(r.threw, 0);
    assert.ok(r.maxCalls <= MP.BORDER_GUARD_CALLS + 1, 'calls ' + r.maxCalls);
    assert.strictEqual(r.ends, 150);
  }
  assert.ok(ms < 1000, ms + ' ms');
});

test('control: the same east sweep on a plain stock border hangs (caught after 5000 calls)', () => {
  const plain = () => {
    const b = P.ArenaBorder.circular(new P.Vec2(C, C), 300, 950);
    b.pointCount = 300;
    let n = 0;
    b.resetGuard = function () { n = 0; };
    const inner = b.intersections;
    b.intersections = function (seg) {
      if (++n > 5000) throw new Error('stock wall loop hang');
      return inner.call(this, seg);
    };
    return b;
  };
  const r = sweep(plain, (k) => ({ x: 1900 + k * 0.01, y: 1000, dir: 0 }), 0);
  assert.ok(r.threw >= 1, 'at least one phase hangs the stock loop (threw ' + r.threw + ')');
});
