'use strict';
// slxNoTouch: the DuelSeries layer is inert in the parity goldens (SERVER-DESIGN 15.6 item 4, 15.2; task T16).
//
// The gate's 10 golden streams plus full-mobile are replayed on the gate's own vm page (test/slVmPage.js, a copy of
// the gate's, so test/slParityGate.test.js is never edited) with every frozen script of public/sl.html AND every
// layer script of the composed page's tail (server/sl/slBoot.js SLX_TAIL, in its order). The page presets its
// harness transport, so the layer must stay inert: every per-frame hash (canvas calls, the full S walk with
// P.timers.length and P.raf.length, the data-sl DOM, outbound bytes), the frames before the socket opened and the
// run totals equal test/slGoldenFrames.json.gz. Then the zero-registration check: loading the layer after the frozen
// client adds no timer, animation frame, listener, image load, element, window property or S key, and changes no
// hook, transport, io or render_mode. A planted registration is caught, so the replay can see one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const V = require('./slVmPage');
const B = require('../server/sl/slBoot');

const LAYER = [...B.SLX_TAIL.matchAll(/<script src="\/js\/slx\/([^"]+)"><\/script>/g)].map((m) => 'public/js/slx/' + m[1]);
const LAYER_SRC = LAYER.map((f) => [f, fs.readFileSync(path.join(V.ROOT, f), 'utf8')]);
const SCRIPTS = V.SRC.concat(LAYER_SRC);

test('the layer of the composed page: slxNet first, then slxMain and slxDirect, every file on disk', () => {
  assert.deepStrictEqual(LAYER.slice(0, 3), ['public/js/slx/slxNet.js', 'public/js/slx/slxMain.js', 'public/js/slx/slxDirect.js']);
  const onDisk = fs.readdirSync(path.join(V.ROOT, 'public/js/slx')).filter((f) => f.endsWith('.js'));
  assert.strictEqual(LAYER.length, onDisk.length, 'every layer file is in the tail');
  assert.strictEqual(SCRIPTS.length, V.SRC.length + LAYER.length);
});

function counts(P) {
  const sum = (o) => Object.keys(o).reduce((n, k) => n + o[k].length, 0);
  const D = P.win.DuelSlither;
  const h = D.slLoop.hooks;
  return {
    winListeners: sum(P.winListeners), docListeners: sum(P.docListeners), timers: P.timers.length, raf: P.raf.length,
    loads: P.loads.length, els: P.els.length, nextObj: P.nextObj, ncalls: P.ncalls, rng: P.rng, logs: P.logs,
    errors: P.errors.length,
    winKeys: Object.keys(P.win).join(','), dKeys: Object.keys(D).filter((k) => k !== 'slx').join(','),
    sKeys: Object.keys(D.S).join(','), renderMode: D.S.render_mode,
    hooks: [h.connect, h.onMenuShow, h.onMenuFade, h.onMenuDone], transport: P.win.DuelSlitherConfig.transport,
    io: P.win.io, handlers: ['onmousemove', 'onmousedown', 'ontouchstart', 'ontouchmove', 'ontouchend',
      'oncontextmenu'].map((k) => P.win[k]).concat([P.doc.onkeydown, P.doc.onkeyup])
  };
}

for (const ua of ['desktop', 'mobile']) {
  test('zero registrations (' + ua + '): the layer loaded after the frozen client changes nothing but DuelSlither.slx', () => {
    const H = Object.assign({}, V.loadStreams().streams.full.harness, ua === 'mobile' ? { ua: 'mobile' } : {});
    const P = V.makePage(H, [], { scripts: V.SRC });
    P.boot();
    const before = counts(P);
    for (const [f, src] of LAYER_SRC) vm.runInContext(src, P.win, { filename: f });
    const after = counts(P);
    for (const k of Object.keys(before)) {
      if (Array.isArray(before[k])) before[k].forEach((v, i) => assert.strictEqual(after[k][i], v, k + '[' + i + ']'));
      else assert.strictEqual(after[k], before[k], k);
    }
    const slx = P.win.DuelSlither.slx;
    assert.strictEqual(slx.active, false);
    assert.deepStrictEqual(Object.keys(slx), ['active']);
    assert.strictEqual(P.win.DuelSlither.S.render_mode, ua === 'mobile' ? 1 : 2, 'render_mode untouched while inert');
  });
}

test('a planted registration is caught by the replay (negative control)', () => {
  const planted = SCRIPTS.concat([['planted.js', 'window.setTimeout(function () {}, 60000);']]);
  const want = V.loadFrames().goldens;
  const r = V.runGolden('synth-60hz', { scripts: planted });
  assert.notStrictEqual(V.compareGolden(want['synth-60hz'], r), null);
});

const WANT = V.loadFrames().goldens;
for (const name of V.NAMES) {
  test('golden ' + name + ' with the layer loaded: identical to the frozen client', () => {
    const r = V.runGolden(name, { scripts: SCRIPTS });
    assert.strictEqual(V.compareGolden(WANT[name], r), null, name);
    assert.deepStrictEqual(r.errors, []);
  });
}
