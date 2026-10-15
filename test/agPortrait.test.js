'use strict';
// Phone portrait (Owen 2026-10-08, FIX-PLAN P4): the layout math. The "turn your phone sideways" card is gone
// (Owen 2026-10-15); agPortrait.js keeps only isPortrait.
// The portrait layout is the reference screen turned on its side: the camera's draw scale and the HUD scale use their
// formulas with the two sides swapped, so a W x H portrait canvas gets exactly what an H x W landscape canvas gets,
// turned. Owen's numbers: about 1080 world units across and 1920 down at wheel 1 (the turned reference screen; a
// phone taller than 9:16 shows all 1920 down and a little less across, as a landscape window wider than 16:9 shows
// all 1920 across).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const AG = path.join(__dirname, '..', 'public', 'js', 'ag');
const C = require(path.join(AG, 'agCamera.js'));
const H = require(path.join(AG, 'agHud.js'));
const R = require(path.join(AG, 'agRender.js'));
const P = require(path.join(AG, 'agPortrait.js'));
const { LAWS } = require('../server/ag/agLaws');

const PHONE = { w: 390, h: 844, dpr: 3 };            // the size the plan and the live check use
const PW = PHONE.w * PHONE.dpr, PH = PHONE.h * PHONE.dpr;   // 1170 x 2532 canvas px

test('isPortrait: a touch screen taller than wide; a mouse screen of any shape never', () => {
  assert.strictEqual(P.isPortrait(390, 844, true), true);
  assert.strictEqual(P.isPortrait(844, 390, true), false);
  assert.strictEqual(P.isPortrait(500, 500, true), false, 'square counts as sideways');
  assert.strictEqual(P.isPortrait(390, 844, false), false, 'the parity harness phone config (mouse) keeps the reference');
});

test('draw scale: portrait is the landscape formula with the sides swapped, exactly', () => {
  const sizes = [[1170, 2532], [1080, 1920], [750, 1334], [1536, 2048], [1284, 2778], [600, 601], [1, 3]];
  for (const [w, h] of sizes) {
    assert.strictEqual(C.screenFactor(w, h, true), C.screenFactor(h, w, false), w + 'x' + h);
    assert.strictEqual(C.screenFactor(w, h, false), C.screenFactor(w, h), 'false is the reference formula');
    for (const z of [1, 0.6, 0.27]) {
      const p = C.visibleWorld(w, h, z, true), l = C.visibleWorld(h, w, z, false);
      assert.deepStrictEqual([p.w, p.h], [l.h, l.w], 'the landscape view, turned');
    }
  }
  // 390 x 844 at DPR 3, wheel 1, a fresh cell (zoom 1): draw scale 2532 / 1920 = 1.31875 (the plan's figure),
  // 887.2 x 1920 world units, inside the turned 1080 x 1920 reference screen. Before: 2.094 (the ghost-strip
  // landscape formula), 558.6 x 1080 above the strip rows (1209 with them).
  assert.strictEqual(C.screenFactor(PW, PH, true), 1.31875);
  const v = C.visibleWorld(PW, PH, 1, true);
  assert.ok(Math.abs(v.h - 1920) < 1e-9, String(v.h));
  assert.ok(Math.abs(v.w - 887.2037914691943) < 1e-9, String(v.w));
  const before = C.visibleWorld(PW, Math.trunc((PHONE.h - 90) * PHONE.dpr), 1, false);
  assert.ok(Math.abs(before.h - 1080) < 1e-9 && Math.abs(before.w - 558.62) < 0.01, JSON.stringify(before));
  // A 9:16 phone sees exactly the turned reference screen, and the same phone sideways sees it unturned.
  assert.deepStrictEqual(C.visibleWorld(1080, 1920, 1, true), { w: 1080, h: 1920 });
  assert.deepStrictEqual(C.visibleWorld(1920, 1080, 1, false), { w: 1920, h: 1080 });
});

test('camera: setPortrait switches the draw scale on the next stepZoom; reset keeps it', () => {
  const cam = C.createCamera();
  cam.setCanvasSize(PW, PH);
  cam.stepZoom([{ x: 0, y: 0, size: 32 }]);
  assert.strictEqual(cam.scale, C.screenFactor(PW, PH));
  cam.setPortrait(true);
  cam.stepZoom([{ x: 0, y: 0, size: 32 }]);
  assert.strictEqual(cam.scale, 1.31875, 'zoom 1 at size 32');
  assert.strictEqual(cam.targetScale(), 1.31875);
  cam.reset();
  assert.strictEqual(cam.portrait, true, 'a reconnect does not turn the screen');
  cam.setPortrait(false);
  assert.strictEqual(cam.portrait, false);
});

test('HUD scale: the turned formula, and the board rows at 390 x 844 are bigger than the same phone sideways', () => {
  for (const [w, h] of [[1170, 2532], [1080, 1920], [1536, 2048], [700, 3000]]) {
    assert.strictEqual(H.hudScale(w, h, true), H.hudScale(h, w, false), w + 'x' + h);
    assert.strictEqual(H.hudScale(w, h, false), H.hudScale(w, h));
  }
  const q = H.hudScale(PW, PH, true);
  assert.strictEqual(q, 1170 / 1080);
  const lay = H.layoutLeaderboard(PW, PH, 10, 0, false, true);
  assert.deepStrictEqual([lay.rowFont, lay.titleFont, lay.scale], [19, 32, 1.2]);
  assert.strictEqual(+(lay.rowFont / PHONE.dpr).toFixed(2), 6.33, 'row text 6.33 CSS px');
  // The same phone sideways (844 x 390, the ghost layout 2532 x 900): q 0.833, rows 15 px = 5 CSS px. Before this
  // change, upright (1170 x 2262 layout): q 0.609, rows 10 px = 3.33 CSS px.
  const side = H.layoutLeaderboard(2532, 900, 10, 0, false, false);
  assert.strictEqual(side.rowFont, 15);
  const upBefore = H.layoutLeaderboard(1170, 2262, 10, 0, false, false);
  assert.strictEqual(upBefore.rowFont, 10);
  assert.ok(lay.rowFont > side.rowFont && side.rowFont > upBefore.rowFont);
  // The whole board stays on the canvas: 10 rows tall and the full width, at the top right.
  assert.ok(lay.x >= 0 && lay.y + lay.height < PH / 2, JSON.stringify([lay.x, lay.y, lay.width, lay.height]));
});

test('HUD: setPortrait re-renders the board at the turned scale at once', () => {
  const calls = [];
  const ctx = () => new Proxy({ canvas: {} }, {
    get(t, k) { if (k in t) return t[k]; if (k === 'measureText') return (s) => ({ width: 10 * s.length }); return (...a) => calls.push([k, a]); },
    set(t, k, v) { if (k === 'font') calls.push(['font', v]); t[k] = v; return true; }
  });
  const hud = H.createHud({ createContext: ctx });
  hud.frameStart(PW, PH);
  hud.setBoard([{ name: 'a' }, { name: 'b' }], '');
  const fonts = () => calls.filter((c) => c[0] === 'font').map((c) => c[1]);
  assert.ok(fonts().includes('10px Ubuntu') && fonts().includes('18px Ubuntu'), 'reference scale first: ' + fonts().join(','));
  calls.length = 0;
  hud.setPortrait(true);
  assert.ok(fonts().includes('19px Ubuntu') && fonts().includes('32px Ubuntu'), fonts().join(','));
  calls.length = 0;
  hud.setPortrait(true);
  assert.strictEqual(calls.length, 0, 'no change, no re-render');
});

test('ring width: the turned cap in portrait, the reference cap otherwise', () => {
  assert.strictEqual(R.ringWidth(true, 0.01, PW, PH, false), Math.trunc(Math.min(PH / 1080, PW / 1920) * 20));
  assert.strictEqual(R.ringWidth(true, 0.01, PW, PH, true), Math.trunc(Math.min(PH / 1920, PW / 1080) * 20));
  assert.strictEqual(R.ringWidth(false, 0.01, PW, PH, true), 5);
});

test('stick reach in portrait: full speed sideways at every size up to 1856 (the live page falls short from 1526)', () => {
  // The stick puts the target at the canvas edge (agCamera.stickPoint); the server slows a cell inside
  // zoneSizes * size of its target (law L6). Sideways is the short way in portrait: half the canvas width over the
  // draw scale, with the camera on one cell of that size at wheel 1.
  const zone = LAWS.L6.value.zoneSizes;
  let worst = Infinity;
  for (let size = 32; size <= 1856; size += 8) {
    const s = C.sizeZoom(size) * C.screenFactor(PW, PH, true);
    worst = Math.min(worst, (PW / 2) / s / (zone * size));
  }
  assert.ok(worst >= 1, 'short half over the slow zone ' + worst);
  assert.ok(worst > 1.41, 'the worst is size 1856: ' + worst);
  // Before (the ghost-strip landscape formula upright, the live page): under 1 from size 1526 up, 0.889 at 1856.
  const layout0 = Math.trunc((PHONE.h - 90) * PHONE.dpr);
  const before = (size) => (PW / 2) / (C.sizeZoom(size) * C.screenFactor(PW, layout0, false)) / (zone * size);
  assert.ok(before(1525) >= 1 && before(1526) < 1 && before(1856) < 0.89, [before(1525), before(1526), before(1856)].join(' '));
  // And the stick point itself lands on the side edge.
  const cam = C.createCamera();
  cam.setPortrait(true);
  cam.setCanvasSize(PW, PH);
  cam.stepZoom([{ x: 0, y: 0, size: 1500 }]);
  const p = cam.stickPoint([{ x: 0, y: 0, size: 1500 }], 1, 0);
  assert.deepStrictEqual([p.x, p.y], [PW, Math.trunc(PH / 2)]);
});

test('no turn-sideways card any more (Owen 2026-10-15): agPortrait exports the layout rule only', () => {
  assert.deepStrictEqual(Object.keys(P), ['isPortrait']);
  const src = require('fs').readFileSync(path.join(AG, 'agPortrait.js'), 'utf8');
  assert.doesNotMatch(src, /ag-rotate|Turn your phone sideways/);
});
