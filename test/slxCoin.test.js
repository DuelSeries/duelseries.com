'use strict';
// slxCoin: the gold coin every cash pellet is drawn as (public/js/slx/slxCoin.js, Owen's pick 2026-10-15). Display only:
// the gold rule and the worths are slxPaid's and the server's (test/slxPaidPage.test.js). Here: the file is inert unless
// the layer is active; the coin turns all the way round (front with its $, a solid edge, the back with its star, never a
// frame where it vanishes); draw depends on r and a only (so caching it is safe); the atlas cache (one bucket per size,
// pop-in borrows, the per frame budget, the memory caps); and a browser that cannot draw it falls back to the disc.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'slx', 'slxCoin.js'), 'utf8');
const PI = Math.PI;

// A 2D context that records every call; gradients are stubs. no: method names to leave out (an old browser).
function makeCtx(no) {
  const calls = [];
  const ctx = { calls, p: {} };
  for (const m of ['save', 'restore', 'beginPath', 'arc', 'stroke', 'fill', 'setTransform', 'moveTo', 'lineTo', 'rect',
    'clip', 'translate', 'scale', 'ellipse', 'bezierCurveTo', 'quadraticCurveTo', 'closePath', 'fillRect', 'drawImage']) {
    ctx[m] = function () { calls.push([m].concat([].slice.call(arguments))); };
  }
  for (const m of ['createLinearGradient', 'createRadialGradient', 'createConicGradient']) {
    ctx[m] = function () { calls.push([m]); return { addColorStop() {} }; };
  }
  ctx.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  for (const k of ['strokeStyle', 'fillStyle', 'lineWidth', 'globalAlpha', 'lineCap', 'lineJoin', 'globalCompositeOperation']) {
    Object.defineProperty(ctx, k, { get() { return ctx.p[k]; }, set(v) { calls.push(['set ' + k, v]); ctx.p[k] = v; } });
  }
  for (const m of no || []) delete ctx[m];
  return ctx;
}

// Loads slxCoin.js on a fake window. o: { active (default true), no (ctx methods missing) }
function load(o) {
  const opts = o || {};
  const clock = { now: 1000 };
  const canvases = [];
  const doc = {
    createElement(tag) {
      assert.strictEqual(tag, 'canvas');
      const cv = { tagName: 'CANVAS', width: 300, height: 150, ctx: null };
      cv.getContext = (k) => { assert.strictEqual(k, '2d'); return cv.ctx || (cv.ctx = makeCtx(opts.no)); };
      canvases.push(cv);
      return cv;
    }
  };
  const win = { DuelSlither: { slx: { active: opts.active !== false } }, document: doc, performance: { now: () => clock.now } };
  win.window = win;
  vm.runInNewContext(SRC, win, { filename: 'slxCoin.js' });
  return { win, coin: win.DuelSlither.slx.coin, canvases, clock };
}

test('inert unless the layer is active; loading makes no canvas', () => {
  const off = load({ active: false });
  assert.strictEqual(off.coin, undefined);
  assert.strictEqual(off.canvases.length, 0);
  const on = load();
  assert.ok(on.coin);
  assert.strictEqual(on.canvases.length, 0, 'no atlas until a coin is drawn');
});

test('the spin: one full turn every SPIN_MS over FRAMES frames, shifted by the pellet phase', () => {
  const { coin } = load();
  const seen = new Set();
  for (let t = 0; t < coin.SPIN_MS; t += coin.SPIN_MS / coin.FRAMES) seen.add(coin.frameAt(t + 0.01, 0));
  assert.strictEqual(seen.size, coin.FRAMES, 'every frame once per turn');
  assert.strictEqual(coin.frameAt(0, 0), coin.frameAt(coin.SPIN_MS, 0), 'a turn later, the same frame');
  assert.strictEqual(coin.frameAt(0, 0.5), coin.FRAMES / 2, 'phase 0.5 is half a turn on');
  assert.strictEqual(coin.angleOf(0), 0);
  assert.ok(Math.abs(coin.angleOf(coin.FRAMES / 4) - PI / 2) < 1e-12);
  for (const t of [-5, 1e12, NaN]) {
    const f = coin.frameAt(t, 0.3);
    assert.ok(f >= 0 && f < coin.FRAMES, 'always a real frame (t ' + t + ')');
  }
});

// The outer edge ellipse of a drawn frame (the last full ellipse: ellipse(cx, 0, rx, R, 0, 0, 2 PI)).
function outline(calls) {
  const e = calls.filter((c) => c[0] === 'ellipse' && c[6] === 0 && Math.abs(c[7] - 2 * PI) < 1e-12);
  return e[e.length - 1];
}
// The edge band: the two half ellipses of bandPath (start -PI/2 or PI/2), their centres.
function band(calls) {
  return calls.filter((c) => c[0] === 'ellipse' && Math.abs(Math.abs(c[6]) - PI / 2) < 1e-12);
}

test('a full turn: the face narrows to |cos a|, the edge shows the real thickness, the coin never vanishes', () => {
  const { coin } = load();
  const r = 14;
  for (let f = 0; f < coin.FRAMES; f++) {
    const a = coin.angleOf(f);
    const ctx = makeCtx();
    coin.draw(ctx, r, a);
    const o = outline(ctx.calls);
    assert.ok(o, 'an outline at frame ' + f);
    assert.ok(Math.abs(o[3] - Math.max(r * Math.abs(Math.cos(a)), 1e-4)) < 1e-9, 'face half width r |cos a| at frame ' + f);
    assert.strictEqual(o[4], r, 'full height');
    const b = band(ctx.calls);
    const w = Math.abs(0.22 * r * Math.sin(a));
    if (w * 1 > 0.05) {
      assert.strictEqual(b.length >= 2, true, 'the edge band at frame ' + f);
      assert.ok(Math.abs(Math.abs(b[0][1] - b[1][1]) - w) < 1e-9, 'band as wide as the thickness shows, frame ' + f);
    }
    // what is on screen at this frame is at least the face or a band one pixel wide
    assert.ok(Math.max(2 * r * Math.abs(Math.cos(a)), w) >= 1, 'something solid at frame ' + f);
    assert.ok(ctx.calls.filter((c) => c[0] === 'save').length === ctx.calls.filter((c) => c[0] === 'restore').length,
      'save and restore balance at frame ' + f);
  }
  // edge on: a solid band of the full thickness, no face drawn
  const edge = makeCtx();
  coin.draw(edge, r, PI / 2);
  assert.ok(Math.abs(Math.abs(band(edge.calls)[0][1] - band(edge.calls)[1][1]) - 0.22 * r) < 1e-9);
});

test('the front shows the $, the back the star', () => {
  const { coin } = load();
  const count = (calls, m) => calls.filter((c) => c[0] === m).length;
  for (const a of [0, 0.4, 2 * PI - 0.4]) {
    const ctx = makeCtx();
    coin.draw(ctx, 14, a);
    assert.ok(count(ctx.calls, 'bezierCurveTo') >= 18, 'the $ (three strokes of its six curves) at a = ' + a);
  }
  for (const a of [PI, PI - 0.4, PI + 0.4]) {
    const ctx = makeCtx();
    coin.draw(ctx, 14, a);
    assert.strictEqual(count(ctx.calls, 'bezierCurveTo'), 0, 'no $ on the back at a = ' + a);
    assert.ok(count(ctx.calls, 'closePath') >= 11, 'the star shadow and its ten facets at a = ' + a);
  }
});

test('draw depends on r and a only: the same frame twice is the same drawing', () => {
  const { coin } = load();
  for (const a of [0, 1, 2.5, 4]) {
    const x = makeCtx(), y = makeCtx();
    coin.draw(x, 15, a);
    coin.draw(y, 15, a);
    assert.strictEqual(JSON.stringify(x.calls), JSON.stringify(y.calls));
  }
});

test('the atlas: one per size bucket, each frame drawn once, the coin scaled from its bucket to the exact size', () => {
  const { coin, canvases } = load();
  const target = makeCtx();
  coin.beginFrame();
  assert.strictEqual(coin.blit(target, 100, 80, 14, 1, 0, 0, true), true);
  assert.strictEqual(canvases.length, 1, 'one atlas');
  const st = coin.stats();
  assert.strictEqual(st.buckets.length, 1);
  assert.strictEqual(st.made, 1, 'only the frame needed');
  const img = target.calls.filter((c) => c[0] === 'drawImage')[0];
  assert.strictEqual(img[1], canvases[0]);
  const [, , sx, sy, sw, sh, dx, dy, dw, dh] = img;
  assert.deepStrictEqual([sx, sy, sw, sh], [0, 0, st.buckets[0].cell, st.buckets[0].cell], 'frame 0 is the first cell');
  assert.ok(Math.abs(dx + dw / 2 - 100) < 1e-9 && Math.abs(dy + dh / 2 - 80) < 1e-9, 'centred');
  assert.ok(Math.abs(dw / sw * st.buckets[0].br - 14) < 1e-9 && dw === dh, 'scaled to r 14');
  // the atlas cell holds the coin drawn at the bucket radius, with nothing outside the cell
  const a = canvases[0].ctx.calls;
  assert.deepStrictEqual(a.filter((c) => c[0] === 'rect')[0], ['rect', 0, 0, st.buckets[0].cell, st.buckets[0].cell]);
  // the same frame again draws nothing new; a size within the bucket uses it too
  coin.beginFrame();
  coin.blit(target, 10, 10, 14.05, 1, 0, 0, true);
  assert.strictEqual(coin.stats().made, 1);
  assert.strictEqual(canvases.length, 1);
  // DPR 2: twice the device pixels, a new bucket
  coin.blit(target, 10, 10, 14, 2, 0, 0, true);
  assert.strictEqual(coin.stats().buckets.length, 2);
});

test('pop-in: a coin not grown yet borrows the nearest bucket and never makes an atlas; with none it is the caller\'s disc', () => {
  const { coin, canvases } = load();
  const target = makeCtx();
  coin.beginFrame();
  assert.strictEqual(coin.blit(target, 0, 0, 5, 1, 0, 0, false), false, 'nothing cached yet: the caller draws a disc');
  assert.strictEqual(canvases.length, 0);
  coin.blit(target, 0, 0, 14, 1, 0, 0, true);
  for (let r = 4.5; r < 14; r += 0.37) assert.strictEqual(coin.blit(target, 0, 0, r, 1, 0, 0, false), true, 'r ' + r);
  assert.strictEqual(canvases.length, 1, 'one atlas through the whole pop-in');
  assert.strictEqual(coin.blit(target, 0, 0, 1, 1, 0, 0, true), false, 'below MIN_DEV: the disc');
});

test('the budget: at most 12 new frames per animation frame; past it a coin shows the nearest frame already drawn', () => {
  const { coin } = load();
  const target = makeCtx();
  coin.beginFrame();
  let drawn = 0;
  for (let f = 0; f < 40; f++) if (coin.blit(target, 0, 0, 14, 1, f * coin.SPIN_MS / coin.FRAMES + 1, 0, true)) drawn++;
  assert.strictEqual(drawn, 40, 'every coin drawn');
  assert.strictEqual(coin.stats().made, 12, 'only 12 new frames this frame');
  const imgs = target.calls.filter((c) => c[0] === 'drawImage');
  assert.deepStrictEqual(imgs[39].slice(2, 4), imgs[11].slice(2, 4), 'frame 39 borrows frame 11, the nearest drawn');
  coin.beginFrame();
  coin.blit(target, 0, 0, 14, 1, 39 * coin.SPIN_MS / coin.FRAMES + 1, 0, true);
  assert.strictEqual(coin.stats().made, 13, 'the next animation frame draws it');
});

test('memory: at most 5 atlases (least recently used goes), sizes past 36 device px share the 36 bucket', () => {
  const { coin, canvases } = load();
  const target = makeCtx();
  for (let i = 0; i < 9; i++) {
    coin.beginFrame();
    coin.blit(target, 0, 0, 8 * Math.pow(1.2, i), 1, 0, 0, true);
  }
  assert.strictEqual(coin.stats().buckets.length, 5);
  assert.strictEqual(canvases.filter((c) => c.width === 0).length, canvases.length - 5, 'evicted atlases let their bitmap go');
  const big = load();
  big.coin.beginFrame();
  big.coin.blit(target, 0, 0, 30, 3, 0, 0, true);
  big.coin.blit(target, 0, 0, 40, 3, 0, 0, true);
  const st = big.coin.stats();
  assert.strictEqual(st.buckets.length, 1, '90 and 120 device px both draw from the capped bucket');
  assert.ok(st.buckets[0].br <= 36 * 1.031 && st.buckets[0].br >= 36 / 1.031);
  assert.ok(big.canvases[0].width <= 10 * 90, 'the atlas stays near 900 px wide');
});

test('a browser that cannot draw the coin: blit says no (the caller\'s plain disc) and stays no', () => {
  const { coin } = load({ no: ['createLinearGradient'] });
  const target = makeCtx();
  coin.beginFrame();
  assert.strictEqual(coin.blit(target, 0, 0, 14, 1, 0, 0, true), false);
  assert.strictEqual(coin.stats().broken, true);
  coin.beginFrame();
  assert.strictEqual(coin.blit(target, 0, 0, 14, 1, 0, 0, true), false);
  assert.strictEqual(target.calls.filter((c) => c[0] === 'drawImage').length, 0);
});

test('the twinkle: off most of the time with no canvas call, a short four point sparkle when on', () => {
  const { coin } = load();
  let on = 0, offCalls = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    const ctx = makeCtx();
    const t = i * 3200 / N;
    if (coin.sparkle(ctx, 50, 50, 14, t, 0.2)) {
      on++;
      assert.ok(ctx.calls.some((c) => c[0] === 'set globalCompositeOperation' && c[1] === 'lighter'));
      assert.strictEqual(ctx.calls.filter((c) => c[0] === 'save').length, ctx.calls.filter((c) => c[0] === 'restore').length);
    } else offCalls += ctx.calls.length;
  }
  assert.strictEqual(offCalls, 0, 'nothing drawn while off');
  assert.ok(on > N * 0.1 && on < N * 0.16, 'on about 13% of the time (' + on + ' of ' + N + ')');
});
