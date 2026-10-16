/* The first swipe into the Shop (2026-10-16): it froze for about a quarter
   of a second at its start, because the first snake preview built slither's
   body sprites (slSprites.js buildSprites, 347 frames pixel by pixel) right
   there on the main thread. They are built by public/js/v2/lookWorker.js now.
   (The Shop tab itself is gone since 2026-10-16; the worker still keeps the
   Customize chooser's first snake preview off the main thread.)

   That the worker's frames are the page's own build byte for byte, and that
   the swipe no longer stalls, was measured in Chrome with real touch events;
   these check the plumbing that keeps it that way. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const run = (box, f) => vm.runInContext(read(f), box, { filename: f });

/* A 2D context that takes every call; drawImage is remembered. */
function fakeCtx(draws) {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'drawImage') return (img) => draws.push(img);
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
function fakeCanvas(draws) {
  const ctx = fakeCtx(draws || []);
  return { width: 300, height: 120, getContext: () => ctx };
}
/* Stand-in sprites in the shape the worker sends: the ring and each colour's frames. */
function fakeSprites(n) {
  const img = (tag) => ({ tag });
  return {
    komc: img('komc'),
    per_color_imgs: Array.from({ length: n }, (_, i) => ({ kmcs: Array.from({ length: 7 }, (_, j) => img(i + ':' + j)), klp: true })),
  };
}

/* The lobby page as far as look.js can see it, with slither's real
   slSprites.js loaded first (as v2.html does) and its build counted. */
function lookPage({ offscreen = true, ready = 'complete' } = {}) {
  const box = { console, idle: [], workers: [], on: {}, builds: 0 };
  box.window = box; box.globalThis = box;
  box.document = { readyState: ready };
  box.requestIdleCallback = (fn) => box.idle.push(fn);
  box.addEventListener = (type, fn) => { box.on[type] = fn; };
  box.Worker = function (url) { this.url = url; this.terminate = () => { this.dead = true; }; box.workers.push(this); };
  if (offscreen) { box.OffscreenCanvas = function () {}; box.ImageBitmap = function () {}; }
  vm.createContext(box);
  run(box, 'public/js/sl/slSprites.js');
  const SS = box.DuelSlither.slSprites;
  SS.buildSprites = (S) => { box.builds++; Object.assign(S, fakeSprites(SS.rrs.length)); };
  run(box, 'public/js/v2/look.js');
  box.idleRun = () => { const q = box.idle.splice(0); q.forEach((f) => f()); };
  return box;
}

test('a snake preview never builds slither\'s sprites on the main thread when a worker can', () => {
  const box = lookPage();
  const draws = [];
  box.V2Look.paint(fakeCanvas(draws), 3, null, 0);
  assert.strictEqual(box.builds, 0, 'no build inside the paint');
  assert.strictEqual(draws.length, 0, 'nothing drawn before the sprites land');
  assert.strictEqual(box.workers.length, 1, 'the paint asked the worker');
  assert.strictEqual(box.workers[0].url, '/js/v2/lookWorker.js');
  box.idleRun();                                         // the load-time warm-up finds it already started
  assert.strictEqual(box.workers.length, 1, 'one worker, not two');

  const sp = fakeSprites(box.DuelSlither.slSprites.rrs.length);
  box.workers[0].onmessage({ data: sp });
  assert.ok(box.workers[0].dead, 'the worker is let go once it has answered');
  box.V2Look.paint(fakeCanvas(draws), [[2, 31], [2, 9]], null, 0.5);
  const known = new Set([sp.komc].concat(...sp.per_color_imgs.map((o) => o.kmcs)));
  assert.ok(draws.length > 50, 'the whole snake is drawn: ' + draws.length);
  assert.ok(draws.every((d) => known.has(d)), 'every circle is one of the worker\'s frames');
  assert.strictEqual(box.builds, 0, 'and the page never built its own');
});

test('the build starts by itself once the lobby has loaded', () => {
  const box = lookPage({ ready: 'loading' });
  assert.strictEqual(box.idle.length, 0, 'nothing while the page is still loading');
  box.on.load();
  box.idleRun();
  assert.strictEqual(box.workers.length, 1, 'in idle time after load');
});

test('a worker that fails, or a browser without OffscreenCanvas, builds in idle time, never inside a paint', () => {
  for (const how of ['error', 'reply', 'none']) {
    const box = lookPage({ offscreen: how !== 'none' });
    const draws = [];
    box.V2Look.paint(fakeCanvas(draws), 0, null, 0);
    if (how === 'error') box.workers[0].onerror(new Error('no'));
    if (how === 'reply') box.workers[0].onmessage({ data: { error: 'OffscreenCanvas 2d unsupported' } });
    if (how !== 'none') assert.ok(box.workers[0].dead, how + ': worker let go');
    else assert.strictEqual(box.workers.length, 0, 'no worker without OffscreenCanvas');
    box.V2Look.paint(fakeCanvas(draws), 0, null, 0);
    assert.strictEqual(box.builds, 0, how + ': still not built inside a paint');
    box.idleRun();
    assert.strictEqual(box.builds, 1, how + ': built once, in idle time');
    box.V2Look.paint(fakeCanvas(draws), 0, null, 0);
    assert.ok(draws.length > 50, how + ': then the snake draws');
  }
});

test('the worker runs slither\'s own build and sends back every sprite, moved not copied', () => {
  /* Run in this realm, not a vm sandbox: the pixel loops go through the
     sandbox's globals for every Math call and take twenty seconds there. */
  let ids = 0, sent = null;
  function OffscreenCanvas(w, h) {
    this.width = w; this.height = h;
    const ctx = fakeCtx([]);
    this.getContext = () => ctx;
    this.transferToImageBitmap = () => ({ bitmap: ++ids, w: this.width, h: this.height });
  }
  /* slSprites.js, outside a page, hangs its api on globalThis. */
  const importScripts = (p) => require(path.join(ROOT, 'public', p));
  const self = {
    get DuelSlither() { return globalThis.DuelSlither; },
    postMessage: (msg, transfer) => { sent = { msg, transfer }; },
  };
  new Function('self', 'importScripts', 'OffscreenCanvas', read('public/js/v2/lookWorker.js'))(self, importScripts, OffscreenCanvas);
  const { msg, transfer } = sent;
  assert.ok(!msg.error, String(msg.error));

  /* The same build straight onto the same stand-in canvases, as the page did it. */
  const S = {};
  globalThis.DuelSlither.slSprites.buildSprites(S, { document: { createElement: () => new OffscreenCanvas(1, 1) }, nsr: false });
  assert.strictEqual(msg.per_color_imgs.length, S.per_color_imgs.length, 'every colour');
  assert.strictEqual(msg.per_color_imgs.length, 42);
  msg.per_color_imgs.forEach((o, i) => {
    assert.strictEqual(o.kmcs.length, S.per_color_imgs[i].kmcs.length, 'colour ' + i + ' frames');
    assert.strictEqual(o.klp, S.per_color_imgs[i].klp, 'colour ' + i + ' ping-pong');
    assert.ok(o.kmcs.every((b) => b.w === 48 && b.h === 48), 'colour ' + i + ' frames are 48px');
  });
  assert.strictEqual(msg.per_color_imgs[36].kmcs.length, 60, 'colour 36 runs 60 frames');
  assert.strictEqual(msg.komc.w, 52, 'the outline ring');
  const all = [msg.komc].concat(...msg.per_color_imgs.map((o) => o.kmcs));
  assert.strictEqual(all.length, 348, '347 frames and the ring');
  assert.strictEqual(transfer.length, all.length, 'every bitmap is moved');
  assert.ok(all.every((b) => transfer.includes(b)), 'and only those');
});

test('the worker builds onto plain canvases, the ones that match the page byte for byte', () => {
  const src = read('public/js/v2/lookWorker.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(code.includes("importScripts('/js/sl/slSprites.js')"), 'the same frozen file the game uses');
  assert.ok(!/willReadFrequently/.test(code), 'willReadFrequently changed 347 of the 348 sprites');
  assert.ok(code.includes('nsr: false'), 'the same option look.js always passed');
});
