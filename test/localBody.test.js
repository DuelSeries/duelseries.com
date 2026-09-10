'use strict';
/* The distortion on your own snake.

   Every other snake on screen is interpolated straight from server snapshots,
   and those were measured clean: median gap 6.67 world units, standard
   deviation 0.43, no near-duplicate points in 2806 samples. Only YOUR snake is
   built locally, by _lBuildSegs in public/js/game.js, and only your snake had
   the kink. That is why it followed Owen into an empty room with no bots.

   How it broke. _lBuildSegs keeps a store of coarse path points and resamples
   the drawn body off it at a fixed `settled` spacing walking back from the
   head. The store was sized `numSegs + 4` points, on the reasoning that stored
   points are inserted `sep` apart and the pull then compresses them "to about
   settled", so four spare points is comfortable slack.

   Measured off that same code, the pull settles them at 0.86 to 0.96 of
   `settled` — and lower for several seconds after the snake grows, because
   growth widens `settled` at once while the store only respaces one point per
   insertion. So the store runs a few percent SHORT of the arc the walk wants,
   and a few percent is a proportion while four points is a count. They cross
   over. Past the crossover the walk runs off the end of the path every frame,
   the tail-slide fallback fires early and the old duplicate-fill stacked points
   at identical coordinates: one gap at 0 to 45% of the spacing with every other
   gap in the body exact. A kink, in the tail half of your own snake, while you
   are eating. Which is all the time.

   Owen's own report, off the live game: 220 of 636 frames. This harness on the
   pre-fix code: 2250 of 2400 frames while growing, with 119270 stacked points.

   The test runs the REAL functions out of public/js/game.js rather than a copy,
   because a copy is exactly how this would come back. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const C = require('../shared/constants');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'game.js'), 'utf8')
  .replace(/\r\n/g, '\n');

/* Lift the two functions the local snake is made of, plus the ring buffer they
   share. Slicing source is ugly; loading a browser file that touches document,
   canvas and sockets at import time is uglier, and stubbing all of that tests
   the stubs. If either function is renamed this throws, which is the correct
   outcome — a silent skip here is how the bug returns. */
function lift(name) {
  const at = SRC.indexOf('\nfunction ' + name + '(');
  assert.ok(at >= 0, 'public/js/game.js no longer defines ' + name +
    ' — this test guards it, so update the test rather than deleting it');
  let depth = 0;
  for (let j = SRC.indexOf('{', at); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(at, j + 1);
  }
  throw new Error('unbalanced braces reading ' + name);
}

const ringDecls = SRC.slice(SRC.indexOf('const LP_SIZE'), SRC.indexOf('let _lNumSegs'));
const storeDecls = 'let _lsPts = [], _lsAccum = 0; let _segBuf = null;' +
                   ' function _lStoreReset() { _lsPts = []; _lsAccum = 0; }';

const ctx = vm.createContext({ CONSTANTS: C, Math, Float32Array, console });
vm.runInContext(
  ringDecls + storeDecls +
  'let _lReady = true, _latestMySnap = null, pingMs = 0, boostActive = false, cashoutSpeedMult = 1, _lLastSettled = 0;' +
  lift('_lAdvance') + lift('_lBuildSegs') + lift('_lCorrect') + lift('_lInit') +
  'function seed(x, y, a) { _lAngle = a; _lpHead = 0; _lpLen = 0;' +
  '  for (let i = 39; i >= 0; i--) { _lpX[_lpHead] = x - Math.cos(a) * i * 3; _lpY[_lpHead] = y - Math.sin(a) * i * 3;' +
  '    _lpHead = (_lpHead + 1) % LP_SIZE; if (_lpLen < LP_SIZE) _lpLen++; } _lStoreReset(); }' +
  'function setSnap(s) { _latestMySnap = s; }' +
  'function setBoost(b) { boostActive = b; }' +
  'function setPing(p) { pingMs = p; }' +
  'function notReady() { _lReady = false; }' +
  'function headNow() { const h = (_lpHead - 1 + LP_SIZE) % LP_SIZE;' +
  '  return { x: _lpX[h], y: _lpY[h] }; }' +
  'function p1AheadOfHead(settled) {' +
  '  if (_lsPts.length < 2) return 0;' +
  '  const fx = Math.cos(_lAngle), fy = Math.sin(_lAngle);' +
  '  return ((_lsPts[1].x - _lsPts[0].x) * fx + (_lsPts[1].y - _lsPts[0].y) * fy) / settled; }' +
  'function settledNow() { return _lLastSettled; }' +
  'function storeArc() { let a = 0; for (let i = 1; i < _lsPts.length; i++)' +
  '  a += Math.hypot(_lsPts[i].x - _lsPts[i-1].x, _lsPts[i].y - _lsPts[i-1].y); return a; }',
  ctx);

/* One run of the local snake. Returns how many frames came out with a gap in
   the drawn body that is not the spacing the body was resampled at. */
function play(opt) {
  const hz = opt.hz || 120, dtN = 1000 / hz;
  let len = opt.len, numSegs = opt.numSegs;
  ctx.setSnap({ length: len, boostRatio: 1 });
  ctx.seed(1000, 1000, 0);

  let frames = 0, kinked = 0, stacked = 0, worst = Infinity, worstAt = null, worstArc = Infinity;
  for (let f = 0; f < hz * (opt.secs || 12); f++) {
    if (opt.grow && f && f % opt.grow === 0) { len += 8; numSegs += 4; }
    if (opt.shrink && f && f % opt.shrink === 0 && numSegs > 12) { len -= 6; numSegs -= 3; }
    ctx.setSnap({ length: len, boostRatio: 1 });
    ctx.setBoost(!!opt.boost && (f % 300) < 150);
    // A frame hitch, clamped the way the game loop clamps dt.
    const dt = (opt.spikes && f && f % 97 === 0) ? 50 : dtN;

    ctx._lAdvance(dt, opt.angle(f / hz));
    const segs = ctx._lBuildSegs(numSegs);
    if (!segs) continue;
    const settled = ctx.settledNow();
    if (!(settled > 0) || segs.length < 8) continue;

    /* The property the fix rests on: the walk consumes (numSegs - 1) * settled
       of arc from the head, so the store has to hold at least that much. */
    const arcRatio = ctx.storeArc() / ((numSegs - 1) * settled);
    if (arcRatio < worstArc) worstArc = arcRatio;

    /* Excludes the final point, which is the sliding tail and is MEANT to be a
       fraction of a step. Every other gap is resampled at `settled`, so every
       other gap must BE `settled`. */
    frames++;
    let lo = Infinity;
    for (let i = 2; i < segs.length - 2; i += 2) {
      const g = Math.hypot(segs[i] - segs[i - 2], segs[i + 1] - segs[i - 1]) / settled;
      if (g < lo) lo = g;
      if (g < 0.05) stacked++;
    }
    if (lo < worst) { worst = lo; worstAt = { frame: f, numSegs }; }
    if (lo < 0.5) kinked++;
  }
  return { frames, kinked, stacked, worst, worstAt, worstArc, endSegs: numSegs };
}

const wander  = t => Math.sin(t * 0.9) * 2.2;   // a mouse moving around
const circle  = t => t * 4.0;                   // held hard over
const hairpin = t => (Math.floor(t * 1.5) % 2 ? Math.PI : 0);

const why = (r) => `${r.kinked}/${r.frames} frames kinked (${r.stacked} stacked points), ` +
  `worst gap ${r.worst.toFixed(2)} of a step at ${JSON.stringify(r.worstAt)}, ` +
  `store held ${r.worstArc.toFixed(3)} of the arc the resample walk needs`;

/* Growth is the case that matters, because in this game you are always eating.
   It is also the one that was worst: 94% of frames before the fix. */
test('your own snake keeps its spacing while it grows', () => {
  for (const hz of [60, 120, 240]) {
    const r = play({ len: 40, numSegs: 20, angle: wander, grow: 30, secs: 20, hz });
    assert.strictEqual(r.stacked, 0, `${hz}Hz: ` + why(r));
    assert.strictEqual(r.kinked, 0, `${hz}Hz: ` + why(r));
    assert.ok(r.worstArc >= 1, `${hz}Hz: ` + why(r));
  }
});

test('and while it grows and shrinks and boosts through frame hitches', () => {
  const r = play({ len: 60, numSegs: 30, angle: circle, boost: true, spikes: true, grow: 35, secs: 20 });
  assert.strictEqual(r.stacked, 0, why(r));
  assert.strictEqual(r.kinked, 0, why(r));
  assert.ok(r.worstArc >= 1, why(r));
});

test('at every size up to the 411 cap, including hairpins', () => {
  for (const [len, numSegs] of [[30, 15], [60, 30], [200, 50], [500, 125], [800, 200], [1650, 411]]) {
    for (const angle of [wander, circle, hairpin]) {
      const r = play({ len, numSegs, angle, secs: 8 });
      assert.strictEqual(r.kinked, 0, `${numSegs} points: ` + why(r));
      assert.ok(r.worstArc >= 1, `${numSegs} points: ` + why(r));
    }
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   THE SECOND KINK, at the head this time.

   The first fix above cured starvation at the tail, and Owen played a round and
   said it still distorts. His client then reported where: loAt 1 on all 25
   samples, in three separate reports. The first gap, head to first body point,
   at 0.01 to 0.5 of the spacing it should be, on about 30% of frames.

   The walk emits that point exactly one `settled` of ARC from the head, so a
   short straight line between them means the stored path leaves the head going
   forwards and immediately doubles back. Two things put it there:

     _lCorrect used to slide the predicted head toward the server's without
     moving the stored body with it. The local head runs AHEAD of the server's
     by design, so that correction is almost always backwards, several times a
     second, sliding the head back through its own first body point.

     the insertion then locked it in. It lays a point one separation behind the
     head measured from p1, as p1 + (head - p1) * (sep / d) — and sep/d exceeds
     1 whenever the head is nearer to p1 than a separation, which puts the new
     point PAST the head.

   None of this could be seen without the server in the loop, which is why the
   tests above missed it: they drove the body builder alone. This one runs the
   real server Snake, its real serialize() over a delayed wire, and _lCorrect. */
const Snake = require('../server/Snake');

/* A whole session: server ticking at 60Hz, snapshots at 25Hz over a wire with
   the latency profile his own report recorded, and a player steering at a
   moving point on screen so aim depends on where the head actually is. */
function session(opt) {
  let seed = 12345;                       // deterministic, so a failure repeats
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  const srv = new Snake('me', 'me', 1000, 1000, '#4af');
  const wire = [];
  let simT = 0, tickAcc = 0, snapAcc = 0, started = false, stallUntil = -1;
  let frames = 0, kinked = 0, aheadFrames = 0, worstAhead = 0;
  let worst = Infinity, worstAt = null;

  ctx.notReady();
  ctx.seed(1000, 1000, 0);

  for (let f = 0; f < 120 * 25; f++) {
    // 85fps with the occasional long frame, clamped the way the game loop clamps it
    const dt = rnd() < 0.004 ? 50 : 1000 / 85;
    simT += dt;

    tickAcc += dt;
    while (tickAcc >= 1000 / C.TICK_RATE) {
      tickAcc -= 1000 / C.TICK_RATE;
      srv.update();
      if (srv.length < 400) srv.grow(0.5);     // you are always eating
    }

    snapAcc += dt;
    if (snapAcc >= 1000 / 25) {
      snapAcc -= 1000 / 25;
      if (opt.stalls && rnd() < 0.004) stallUntil = simT + 700;   // his worst snapshot gap
      const ping = simT < 4000 ? opt.joinPing : opt.ping;
      wire.push({ at: Math.max(simT + ping / 2, stallUntil), s: srv.serialize(), ping });
    }
    while (wire.length && wire[0].at <= simT) {
      const w = wire.shift();
      ctx.setSnap(w.s);
      ctx.setPing(w.ping);
      if (!started) { ctx._lInit(w.s); started = true; } else { ctx._lCorrect(w.s); }
    }
    if (!started) continue;

    const h = ctx.headNow(), t = simT / 1000;
    const target = Math.atan2(1000 + Math.sin(t * opt.aim * 1.6) * 350 - h.y,
                              1000 + Math.cos(t * opt.aim) * 350 - h.x);
    srv.setInput(target, false);
    ctx._lAdvance(dt, target);

    const numSegs = srv.serialize().segs.length >> 1;
    const segs = ctx._lBuildSegs(numSegs);
    if (!segs || segs.length < 8) continue;
    const settled = ctx.settledNow();
    if (!(settled > 0)) continue;
    frames++;

    const ahead = ctx.p1AheadOfHead(settled);
    if (ahead > 0.02) { aheadFrames++; if (ahead > worstAhead) worstAhead = ahead; }

    let lo = Infinity, loAt = -1;
    for (let i = 2; i < segs.length - 2; i += 2) {
      const g = Math.hypot(segs[i] - segs[i - 2], segs[i + 1] - segs[i - 1]) / settled;
      if (g < lo) { lo = g; loAt = i / 2; }
    }
    if (lo < worst) { worst = lo; worstAt = { frame: f, gapIndex: loAt, numSegs }; }
    if (lo < 0.5) kinked++;
  }
  return { frames, kinked, aheadFrames, worstAhead, worst, worstAt };
}

const sessionWhy = (r) => `${r.kinked}/${r.frames} frames kinked, worst gap ` +
  `${r.worst.toFixed(3)} of a step at ${JSON.stringify(r.worstAt)}; the first stored ` +
  `point was in front of the head on ${r.aheadFrames} frames, by up to ` +
  `${r.worstAhead.toFixed(2)} steps — the stored path folds at the head and the ` +
  `resampler draws the fold`;

/* A body point in front of the head is never geometry, at any latency. This is
   the property both halves of the fix exist to hold, so assert it directly
   rather than only through the kink it causes. */
test('no body point is ever in front of the head', () => {
  for (const ping of [15, 60, 120, 250]) {
    const r = session({ ping, joinPing: 700, aim: 2.5, stalls: true });
    assert.strictEqual(r.aheadFrames, 0, `${ping}ms ping: ` + sessionWhy(r));
  }
});

test('and the neck keeps its spacing through server corrections', () => {
  for (const opt of [
    { label: 'quiet line',   ping: 15,  joinPing: 15,  aim: 0.8, stalls: false },
    { label: 'busy mouse',   ping: 20,  joinPing: 700, aim: 2.5, stalls: true  },
    { label: 'high latency', ping: 120, joinPing: 700, aim: 2.5, stalls: true  },
  ]) {
    const r = session(opt);
    assert.strictEqual(r.kinked, 0, `${opt.label}: ` + sessionWhy(r));
    assert.ok(r.worst > 0.9, `${opt.label}: ` + sessionWhy(r));
  }
});
