// agRender: the world renderer of the agar.io redo, checked call for call with a fake 2D
// context recorder (client-render spec sections 2 to 9; numbers from the module card in the
// build brief, section 9.2, and the spec's worked values in sections 9 and 13.2).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

require('../public/js/ag/agMath.js');
const R = require('../public/js/ag/agRender.js');

const f = Math.fround;
const TAU = 6.283185307179586;

// ---- fake canvas + recorder (method calls, property writes, canvas size writes, in order)
function makeRecorder() {
  const log = [];
  let nextId = 0;
  function fakeCanvas(label) {
    const id = label || 'c' + (nextId++);
    let w = 300, h = 150;
    const canvas = {
      id,
      get width() { return w; }, set width(v) { log.push([id, '=canvas.width', v]); w = v; },
      get height() { return h; }, set height(v) { log.push([id, '=canvas.height', v]); h = v; },
      getContext() { return ctx; }
    };
    const props = {};
    const ctx = new Proxy({ canvas }, {
      get(t, k) {
        if (k === 'canvas') return canvas;
        if (k in props) return props[k];
        if (k === 'measureText') return (s) => { log.push([id, 'measureText', s]); const px = parseFloat(props.font) || 10; return { width: 0.55 * px * s.length }; };
        if (k === 'createPattern') return (c, rep) => { log.push([id, 'createPattern', '<canvas ' + c.width + 'x' + c.height + '>', rep]); return { pattern: c }; };
        return (...a) => { log.push([id, k].concat(a.map((v) => (v && v.getContext ? '<canvas ' + v.width + 'x' + v.height + '>' : v)))); };
      },
      set(t, k, v) { props[k] = v; log.push([id, '=' + k, v && v.pattern ? '<pattern>' : v]); return true; }
    });
    return canvas;
  }
  return { log, fakeCanvas, main: fakeCanvas('main') };
}

function counter() {
  let n = 0;
  let seed = 7;
  const rand = () => {                       // mulberry32, as the harness seeds Math.random
    n++;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { rand, count: () => n };
}

function node(o) {
  const x = f(o.x), y = f(o.y), s = f(o.size);
  return Object.assign({ id: o.id, x, y, size: s, fromX: x, fromY: y, fromSize: s, toX: x, toY: y, toSize: s,
    updateTime: 0, dying: false, food: false, virus: false, agitated: false, ejected: false, highlight: false,
    rgb: [0, 0, 0], name: '' }, o, { x, y, size: s });
}

function setup(nodes, opts = {}) {
  const rec = makeRecorder();
  const rng = counter();
  const r = R.createRenderer({ createCanvas: () => rec.fakeCanvas(), random: rng.rand });
  const view = Object.assign({ W: 1280, H: 720, s: 1, camX: 0, camY: 0, targetScale: 1 }, opts.view);
  for (const n of nodes) r.initNode(n, view.targetScale, view.s);
  const lists = { main: nodes.slice(), fading: [], ownIds: new Set(opts.own || []), ownCells: [], border: { minX: -7000, minY: -7000, maxX: 7000, maxY: 7000 } };
  return { rec, rng, r, view, lists };
}

// group the world-pass calls of the main canvas into one array per node (save .. restore)
function nodeGroups(log) {
  const main = log.filter((c) => c[0] === 'main').map((c) => c.slice(1));
  const wi = main.findIndex((c, k) => c[0] === 'translate' && main[k + 1] && main[k + 1][0] === 'scale' && main[k + 2] && main[k + 2][0] === 'translate');
  const groups = []; let depth = 0, cur = null;
  for (let k = wi + 3; k < main.length; k++) {
    const c = main[k];
    if (c[0] === 'restore' && depth === 0) break;
    if (c[0] === 'save') { depth++; if (depth === 1) { cur = []; groups.push(cur); } }
    cur.push(c);
    if (c[0] === 'restore') depth--;
  }
  return groups;
}

test('card: grid tile alpha and line width at s = 0.64^0.4 * 1280/1920 on 1280x720', () => {
  const s = Math.pow(0.64, 0.4) * 1280 / 1920;
  assert.strictEqual(s, 0.5576744280486791);
  const { rec, r } = setup([]);
  r.drawBackground(rec.main.getContext(), { W: 1280, H: 720, s, camX: 0, camY: 0, targetScale: s }, {});
  const tile = rec.log.filter((c) => c[0] !== 'main');
  assert.deepStrictEqual(tile.map((c) => c.slice(1)), [
    ['=canvas.width', 50], ['=canvas.height', 50],
    ['=fillStyle', 'rgb(242,251,255)'], ['fillRect', 0, 0, 50, 50], ['=strokeStyle', 'rgb(0,0,0)'],
    ['=globalAlpha', s * 0.2], ['=lineWidth', 1.7931609371063193], ['beginPath'],
    ['moveTo', 0.5, 0.5], ['lineTo', 0.5, 50.5], ['moveTo', 0.5, 0.5], ['lineTo', 50.5, 0.5], ['stroke']]);
  // card value 0.1115348856097358 is (u * 0.2) * (2/3); the spec rule is alpha = s * 0.2, one ulp away here
  assert.ok(Math.abs(s * 0.2 - 0.1115348856097358) < 1e-16);
  const main = rec.log.filter((c) => c[0] === 'main').map((c) => c.slice(1));
  const tx = ((f(640 / s - 0) % 50) + 50) % 50, ty = ((f(360 / s - 0) % 50) + 50) % 50;
  assert.deepStrictEqual(main, [['save'], ['createPattern', '<canvas 50x50>', null], ['scale', s, s], ['save'],
    ['translate', f(f(tx) - 50), f(f(ty) - 50)], ['=fillStyle', '<pattern>'], ['fillRect', 0, 0, 1280 / s + 50, 720 / s + 50],
    ['restore'], ['restore']]);
});

test('grid tile at the reference client scale 0.557674428048679 (their logged values, exact)', () => {
  const { rec, r } = setup([]);
  r.drawBackground(rec.main.getContext(), { W: 1280, H: 720, s: 0.557674428048679, camX: 0, camY: 0 }, {});
  const tile = rec.log.filter((c) => c[0] !== 'main').map((c) => c.slice(1));
  assert.deepStrictEqual(tile[5], ['=globalAlpha', 0.11153488560973579]);
  assert.deepStrictEqual(tile[6], ['=lineWidth', 1.7931609371063197]);
});

test('spec worked values: Bob and Owen names, Owen mass text before and after its font update (8.3, 8.4)', () => {
  const ts = 0.557674428048679;
  const owen = node({ id: 1, x: 0, y: 0, size: 100, rgb: [255, 7, 128] });
  const bob = node({ id: 2, x: 320, y: 40, size: 60, rgb: [7, 200, 255] });
  const { rec, r, lists } = setup([owen, bob], { own: [1], view: { s: ts, targetScale: ts } });
  lists.ownCells = [owen];
  r.setName(owen, 'Owen'); r.setName(bob, 'Bob');
  const view = { W: 1280, H: 720, s: ts, camX: 0, camY: 0, targetScale: ts };
  const draws = () => rec.log.filter((c) => c[0] === 'main' && c[1] === 'drawImage').map((c) => c.slice(2));
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, a + ' vs ' + b);
  for (let i = 0; i < 8; i++) r.beginFrame();
  rec.log.length = 0;
  r.drawWorld(rec.main.getContext(), lists, view, { showMass: true }, 1000);   // counter 8: Bob starts
  let d = draws();
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0][0], '<canvas 55x37>');
  [284.71234, 16, 70.57534, 48].forEach((v, k) => near(d[0][5 + k], v));
  r.beginFrame(); rec.log.length = 0;
  r.drawWorld(rec.main.getContext(), lists, view, { showMass: true }, 1000);   // counter 9: Owen starts
  d = draws();
  const own = d.filter((x) => x[5] < 0);
  assert.strictEqual(own[0][0], '<canvas 125x67>');
  [-74.70319, -40, 149.40639, 80].forEach((v, k) => near(own[0][5 + k], v));
  assert.strictEqual(own[1][0], '<canvas 45x30>');
  [-29.285715, 24, 58.571430, 40].forEach((v, k) => near(own[1][5 + k], v));
  assert.ok(Math.abs(owen.massText.fs - 22.307) < 1e-3);   // the spec prints 3 decimals
  r.beginFrame(); rec.log.length = 0;
  r.drawWorld(rec.main.getContext(), lists, view, { showMass: true }, 1000);
  const m = draws().filter((x) => x[5] < 0)[1];
  assert.deepStrictEqual(m.slice(5), [-30, 24, 60, 40]);
});

test('grid: the 1280x630 golden frame offsets, and the tile is rebuilt only past a 0.1 scale change or a theme change', () => {
  const { rec, r } = setup([]);
  const ctx = rec.main.getContext();
  const s = 1280 / 1920;
  r.drawBackground(ctx, { W: 1280, H: 630, s, camX: 0, camY: 0 }, {});
  const tr = rec.log.find((c) => c[0] === 'main' && c[1] === 'translate');
  assert.deepStrictEqual(tr.slice(2), [-40, -27.5]);
  const fr = rec.log.find((c) => c[0] === 'main' && c[1] === 'fillRect');
  assert.deepStrictEqual(fr.slice(2), [0, 0, 1970, 995]);
  const tiles = () => rec.log.filter((c) => c[1] === 'createPattern').length;
  r.drawBackground(ctx, { W: 1280, H: 630, s: s + 0.1, camX: 0, camY: 0 }, {});
  assert.strictEqual(tiles(), 1);
  r.drawBackground(ctx, { W: 1280, H: 630, s: s + 0.1001, camX: 0, camY: 0 }, {});
  assert.strictEqual(tiles(), 2);
  r.drawBackground(ctx, { W: 1280, H: 630, s: s + 0.1001, camX: 0, camY: 0 }, { dark: true });
  assert.strictEqual(tiles(), 3);
  const dk = rec.log.filter((c) => c[0] !== 'main' && (c[1] === '=fillStyle' || c[1] === '=strokeStyle')).slice(-2).map((c) => c[2]);
  assert.deepStrictEqual(dk, ['rgb(17,17,17)', 'rgb(170,170,170)']);
});

test('card: a size-14 cell at (-300,-200) in circle mode draws the dark ring then its colour', () => {
  const n = node({ id: 6, x: -300, y: -200, size: 14, rgb: [200, 7, 255] });
  const { rec, r, view, lists } = setup([n], { view: { s: 1 } });
  r.drawWorld(rec.main.getContext(), lists, view, {}, 1000);
  const g = nodeGroups(rec.log);
  assert.strictEqual(g.length, 1);
  assert.deepStrictEqual(g[0], [['save'], ['=lineWidth', 10], ['=lineCap', 'round'], ['=lineJoin', 'round'],
    ['beginPath'], ['arc', -300, -200, 19, 0, TAU, 0], ['closePath'], ['=fillStyle', 'rgb(180,6,229)'], ['fill'],
    ['beginPath'], ['arc', -300, -200, 14, 0, TAU, 0], ['closePath'], ['=fillStyle', 'rgb(200,7,255)'], ['fill'],
    ['restore']]);
});

test('card: a virus of size 100 has 100 membrane points, max(floor(size), 30)', () => {
  assert.strictEqual(R.pointCount({ virus: true, size: 100 }, 1, 1), 100);
  assert.strictEqual(R.pointCount({ virus: true, size: 12 }, 1, 1), 30);
  assert.strictEqual(R.pointCount({ virus: true, size: 101.9 }, 0.1, 0.1), 101);
  // players and food: min(targetScale, s, 1) * floor(size), floors 10 and 20
  assert.strictEqual(R.pointCount({ size: 120 }, 2 / 3, 2 / 3), 80);
  assert.strictEqual(R.pointCount({ size: 120 }, 0.557674428048679, 0.6), 66);
  assert.strictEqual(R.pointCount({ size: 120 }, 2, 3), 120);
  assert.strictEqual(R.pointCount({ size: 12 }, 1, 1), 12);
  assert.strictEqual(R.pointCount({ size: 9 }, 1, 1), 10);
  assert.strictEqual(R.pointCount({ food: true, size: 12 }, 1, 1), 20);
  const v = node({ id: 4, x: 30, y: -330, size: 100, virus: true, rgb: [51, 255, 51] });
  const { r } = setup([v]);
  assert.strictEqual(v.pts.length, 100);
  assert.ok(r);
});

test('card: food is drawn 5 units bigger, in its own colour, with no edge (circle and polygon)', () => {
  const a = node({ id: 3, x: -220, y: 60, size: 12, food: true, rgb: [255, 7, 69] });
  const { rec, r, view, lists } = setup([a], { view: { s: 0.5 } });
  r.drawWorld(rec.main.getContext(), lists, view, {}, 1000);
  assert.deepStrictEqual(nodeGroups(rec.log)[0], [['save'], ['=lineWidth', 10], ['=lineCap', 'round'], ['=lineJoin', 'round'],
    ['beginPath'], ['arc', -220, 60, 17, 0, TAU, 0], ['closePath'], ['=fillStyle', 'rgb(255,7,69)'], ['fill'], ['restore']]);
  // polygon food: one ring at point radius + 5, own colour, and nothing else
  const b = node({ id: 5, x: 0, y: 0, size: 40, food: true, rgb: [7, 133, 255] });
  const t = setup([b], { view: { s: 1 } });
  t.r.updateMembranes(t.lists, t.view, {}, 1000);
  assert.strictEqual(b.circle, 0);
  t.r.drawWorld(t.rec.main.getContext(), t.lists, t.view, {}, 1000);
  const g = nodeGroups(t.rec.log)[0];
  const ops = g.map((c) => c[0]);
  assert.strictEqual(ops.filter((o) => o === 'fill').length, 1);
  assert.strictEqual(ops.filter((o) => o === 'lineTo').length, b.pts.length);
  const p0 = b.pts[0];
  const mv = g.find((c) => c[0] === 'moveTo');
  assert.deepStrictEqual(mv.slice(1), [f(b.x + f(p0.cx * f(5 + p0.r))), f(f(p0.sy * f(5 + p0.r)) + b.y)]);
  assert.deepStrictEqual(g[g.length - 3], ['=fillStyle', 'rgb(7,133,255)']);
});

test('card: each new node draws exactly one Math.random at creation', () => {
  const rng = counter();
  const rec = makeRecorder();
  const r = R.createRenderer({ createCanvas: () => rec.fakeCanvas(), random: rng.rand });
  const kinds = [{ size: 10, food: true }, { size: 100, virus: true }, { size: 300 }, { size: 14 }, { size: 38, ejected: true }];
  kinds.forEach((k, i) => {
    const before = rng.count();
    const n = node(Object.assign({ id: i + 1, x: 0, y: 0 }, k));
    r.initNode(n, 1, 1);
    assert.strictEqual(rng.count() - before, 1);
    assert.ok(n.pts.length >= 10);
    assert.ok(n.pts.every((p) => p.v === n.pts[0].v && p.r === n.size && p.cid === n.id));
  });
});

test('wobble draws one Math.random per point of in-view polygon nodes only', () => {
  const inV = node({ id: 1, x: 0, y: 0, size: 100, rgb: [200, 7, 255] });
  const far = node({ id: 2, x: 5000, y: 0, size: 100, rgb: [200, 7, 255] });
  const small = node({ id: 3, x: 50, y: 50, size: 9, rgb: [200, 7, 255] });
  const { rng, r, view, lists } = setup([inV, far, small]);
  const c0 = rng.count();
  r.updateMembranes(lists, view, {}, 1000);
  assert.strictEqual(rng.count() - c0, 100);           // first frame: circle -> polygon reset, then wobble
  assert.strictEqual(inV.circle, 0); assert.strictEqual(far.circle, 0); assert.strictEqual(small.circle, 1);
  const c1 = rng.count();
  assert.strictEqual(r.updateMembranes(lists, view, {}, 1016), false);   // once per drawn frame
  assert.strictEqual(rng.count() - c1, 0);
  r.endFrame();
  r.updateMembranes(lists, view, {}, 1033);
  assert.strictEqual(rng.count() - c1, 100);
  r.endFrame();
  const c2 = rng.count();
  r.updateMembranes(lists, view, { quality: 4 }, 1050);   // VeryLow: non-virus nodes are circles
  assert.strictEqual(rng.count() - c2, 0);
  assert.strictEqual(inV.circle, 1);
});

test('idle pass: membranes if still allowed, then fading and main re-interpolated at the client clock', () => {
  const a = node({ id: 1, x: 0, y: 0, size: 100 });
  const d = node({ id: 2, x: 0, y: 0, size: 50, dying: true });
  const { rng, r, view, lists } = setup([a, d]);
  lists.main = [a]; lists.fading = [d];
  Object.assign(a, { toX: 100, updateTime: 1000 }); Object.assign(d, { toX: -100, updateTime: 1000 });
  const c0 = rng.count();
  r.idle(lists, view, {}, 1050);
  assert.strictEqual(rng.count() - c0, a.pts.length + d.pts.length);
  assert.strictEqual(a.x, 50); assert.strictEqual(d.x, -50);
  const c1 = rng.count();
  r.idle(lists, view, {}, 1100);                          // already used this frame: interpolation only
  assert.strictEqual(rng.count(), c1);
  assert.strictEqual(a.x, 100);
  r.drawWorld(makeRecorder().main.getContext(), lists, view, {}, 1100);   // a drawn world pass allows it again
  r.idle(lists, view, {}, 1100);
  assert.ok(rng.count() > c1);
});

test('circle to polygon resets a perfect ring with double sin/cos', () => {
  const n = node({ id: 9, x: 10, y: -20, size: 50 });
  const { r, view, lists } = setup([n]);
  // a far camera keeps it out of view, so only the reset runs
  r.updateMembranes(lists, Object.assign({}, view, { camX: 9000 }), {}, 1000);
  const cnt = n.pts.length;
  assert.strictEqual(cnt, 50);
  n.pts.forEach((p, d) => {
    const q = d * TAU / cnt;
    assert.strictEqual(p.sy, f(Math.sin(q))); assert.strictEqual(p.cx, f(Math.cos(q)));
    assert.strictEqual(p.r, n.size); assert.strictEqual(p.v, 0);
    assert.strictEqual(p.px, f(f(p.cx * n.size) + n.x)); assert.strictEqual(p.py, f(f(p.sy * n.size) + n.y));
  });
});

test('polygon cell: dark ring at point radius + 5 under its colour at point radius - 5; virus spikes on even points', () => {
  const v = node({ id: 11, x: 0, y: 0, size: 101, virus: true, rgb: [51, 255, 51] });
  const { rec, r, view, lists } = setup([v]);
  r.updateMembranes(lists, view, {}, 1000);
  r.drawWorld(rec.main.getContext(), lists, view, {}, 1000);
  const g = nodeGroups(rec.log)[0];
  assert.deepStrictEqual(g.slice(0, 4), [['save'], ['=lineWidth', 10], ['=lineCap', 'round'], ['=lineJoin', 'miter']]);
  const n = v.pts.length;
  assert.strictEqual(n, 101);
  const paths = []; let cur;
  for (const c of g) { if (c[0] === 'beginPath') { cur = []; paths.push(cur); } else if (c[0] === 'moveTo' || c[0] === 'lineTo') cur.push(c); }
  assert.strictEqual(paths.length, 2);
  for (const [k, sub] of [[0, (pr) => f(5 + pr)], [1, (pr) => f(pr - 5)]]) {
    const P = paths[k];
    assert.strictEqual(P.length, n + 1);
    for (let d = 0; d <= n; d++) {
      const i = d === n ? 0 : d;
      let w = sub(v.pts[i].r); if (!(d & 1)) w = f(w + 5);
      assert.deepStrictEqual(P[d].slice(1), [f(v.x + f(v.pts[i].cx * w)), f(f(v.pts[i].sy * w) + v.y)]);
    }
  }
  // odd count: the closing vertex (d = n, odd) has no spike although the moveTo (d = 0) had one
  assert.notDeepStrictEqual(paths[0][0].slice(1), paths[0][n].slice(1));
  const fills = g.filter((c) => c[0] === '=fillStyle').map((c) => c[1]);
  assert.deepStrictEqual(fills, ['rgb(45,229,45)', 'rgb(51,255,51)']);
});

test('highlight: gold rings in circle mode, gold strokes in polygon mode, ring width min(5/s, trunc(q*20))', () => {
  assert.strictEqual(R.ringWidth(false, 0.1, 1920, 1080), 5);
  assert.strictEqual(R.ringWidth(true, 2, 1920, 1080), 2.5);
  assert.strictEqual(R.ringWidth(true, 0.1, 1920, 1080), 20);
  assert.strictEqual(R.ringWidth(true, 0.5, 1280, 630), 10);
  const a = node({ id: 10, x: 300, y: -250, size: 25, highlight: true, rgb: [255, 7, 173] });
  const { rec, r, view, lists } = setup([a], { view: { s: 0.25 } });   // r = min(5/0.25, trunc(720/1080*20)) = 13
  r.drawWorld(rec.main.getContext(), lists, view, { names: true }, 1000);
  const g = nodeGroups(rec.log)[0];
  assert.deepStrictEqual(g.slice(4, 18), [['beginPath'], ['arc', 300, -250, 38, 0, TAU, 0], ['closePath'],
    ['=fillStyle', 'rgb(255,174,0)'], ['fill'], ['beginPath'], ['arc', 300, -250, 31.5, 0, TAU, 0], ['closePath'],
    ['=fillStyle', 'rgb(240,236,0)'], ['fill'], ['beginPath'], ['arc', 300, -250, 25, 0, TAU, 0], ['closePath'],
    ['=fillStyle', 'rgb(255,7,173)']]);
  const b = node({ id: 12, x: 0, y: 0, size: 60, highlight: true, rgb: [7, 63, 255] });
  const t = setup([b], { view: { s: 1 } });
  t.r.updateMembranes(t.lists, t.view, {}, 1000);
  t.r.drawWorld(t.rec.main.getContext(), t.lists, t.view, {}, 1000);
  const ops = nodeGroups(t.rec.log)[0].filter((c) => c[0] !== 'moveTo' && c[0] !== 'lineTo');
  assert.deepStrictEqual(ops.slice(4), [['beginPath'], ['closePath'], ['=fillStyle', 'rgb(6,56,229)'], ['fill'],
    ['beginPath'], ['closePath'], ['=fillStyle', 'rgb(7,63,255)'], ['=lineWidth', 10], ['=strokeStyle', 'rgb(255,174,0)'],
    ['stroke'], ['=lineWidth', 5], ['=strokeStyle', 'rgb(240,236,0)'], ['stroke'], ['fill'], ['restore']]);
});

test('no-colours mode fills white over a grey edge', () => {
  const a = node({ id: 6, x: 0, y: 0, size: 14, rgb: [200, 7, 255] });
  const { rec, r, view, lists } = setup([a]);
  r.drawWorld(rec.main.getContext(), lists, view, { colors: false }, 1000);
  const fills = nodeGroups(rec.log)[0].filter((c) => c[0] === '=fillStyle').map((c) => c[1]);
  assert.deepStrictEqual(fills, ['rgb(170,170,170)', 'rgb(255,255,255)']);
});

test('fading nodes draw first, with alpha 1 - (now - updateTime)/100', () => {
  const live = node({ id: 1, x: 0, y: 0, size: 14, rgb: [1, 2, 3] });
  const dead = node({ id: 2, x: 0, y: 0, size: 14, rgb: [4, 5, 6], dying: true, updateTime: 1000 });
  const { rec, r, view, lists } = setup([live, dead]);
  lists.main = [live]; lists.fading = [dead];
  r.drawWorld(rec.main.getContext(), lists, view, {}, 1030);
  const g = nodeGroups(rec.log);
  assert.deepStrictEqual(g[0].slice(0, 2), [['save'], ['=globalAlpha', 1 - 0.3]]);
  assert.strictEqual(1 - 0.3, 0.7);
  assert.deepStrictEqual(g[1][1], ['=lineWidth', 10]);
});

test('world transform: integer W/2 and H/2, then scale, then minus the camera', () => {
  const { rec, r, lists } = setup([]);
  r.drawWorld(rec.main.getContext(), lists, { W: 1281, H: 631, s: 0.75, camX: 12.5, camY: -3 }, {}, 0);
  const main = rec.log.filter((c) => c[0] === 'main').map((c) => c.slice(1));
  assert.deepStrictEqual(main, [['save'], ['translate', 640, 315], ['scale', 0.75, 0.75], ['translate', -12.5, 3], ['restore']]);
});

test('interpolation: 100 ms window, size snaps on the interpolated size', () => {
  const n = { fromX: 0, toX: 100, fromY: 0, toY: 0, fromSize: 50, toSize: f(50.005), updateTime: 1000 };
  R.interpolate(n, 1050);
  assert.strictEqual(n.x, 50);
  assert.strictEqual(n.size, f(50.005));
  R.interpolate(n, 1100); assert.strictEqual(n.x, 100);
  R.interpolate(n, 900); assert.strictEqual(n.x, 0);
  const m = { fromX: 7, toX: 7, fromY: 0, toY: 0, fromSize: f(40), toSize: f(40), updateTime: 0 };
  R.interpolate(m, 50); assert.strictEqual(m.size, 40); assert.strictEqual(m.x, 7);   // new node: from = to
});

test('name cache: four measured levels on scratch canvases, then four fresh copies; freed with its last user', () => {
  const { rec, r } = setup([]);
  const a = node({ id: 2, x: 0, y: 0, size: 60 }), b = node({ id: 3, x: 0, y: 0, size: 60 });
  r.initNode(a, 1, 1); r.initNode(b, 1, 1);
  rec.log.length = 0;
  r.setName(a, 'Bob');
  const seq = rec.log.map((c) => c.slice(1));
  const lvl = [['=canvas.width', 300], ['=canvas.height', 150], ['=font', '100px Ubuntu'], ['measureText', 'Bob']];
  const bare = [['=canvas.width', 300], ['=canvas.height', 150]];
  assert.deepStrictEqual(seq, [].concat(lvl, lvl, lvl, lvl, bare, bare, bare, bare));
  const e = r.nameEntry('Bob');
  assert.deepStrictEqual(e.levels.map((T) => T.fs), [27, 48.599998474121094, 87.47999572753906, 157.4639892578125]);
  rec.log.length = 0;
  r.setName(b, 'Bob'); r.setName(a, 'Bob');
  assert.strictEqual(rec.log.length, 0);
  assert.strictEqual(e.refs, 2);
  r.dropName(a);
  assert.ok(r.nameEntry('Bob'));
  r.dropName(b);
  assert.strictEqual(r.nameEntry('Bob'), null);
  assert.strictEqual(a.name, 'Bob');                     // the node keeps its string
  // a 20-character name is shrunk so the estimate is at most ten font sizes
  r.setName(a, 'WWWWWWWWWWWWWWWWWWWW');
  const L0 = r.nameEntry('WWWWWWWWWWWWWWWWWWWW').levels[0];
  const est = Math.trunc((27 * 0.1 + 27 * 0.1) * 2 + (0.55 * 100 * 20) / 100 * 27);
  assert.strictEqual(L0.fs, f(27 / f(est / f(27 * 10))));
});

test('names: stagger by (id + frame) % 10, fit in 3*size by 0.8*size, level from the on-screen height', () => {
  const bob = node({ id: 2, x: 320, y: 40, size: 60, rgb: [7, 255, 100] });
  const { rec, r, view, lists } = setup([bob], { view: { s: 0.5576744280486791, targetScale: 0.5576744280486791 } });
  r.setName(bob, 'Bob');
  const ctx = rec.main.getContext();
  const drawnAt = [];
  for (let fr = 1; fr <= 12; fr++) {
    r.beginFrame();
    rec.log.length = 0;
    r.drawWorld(ctx, lists, view, {}, 1000);
    if (rec.log.some((c) => c[0] === 'main' && c[1] === 'drawImage')) drawnAt.push(fr);
  }
  assert.strictEqual(drawnAt[0], 8);                     // (2 + 8) % 10 == 0
  assert.deepStrictEqual(drawnAt, [8, 9, 10, 11, 12]);   // started once, drawn every frame after
  const T3 = r.nameEntry('Bob').levels[3];
  const pad3 = T3.fs * 0.2;
  const texW = f(Math.trunc((pad3 + pad3) + T3.m100 / 100 * T3.fs)), texH = f(Math.trunc(T3.fs + Math.trunc(T3.fs * 0.4)));
  const maxW = f(180), maxH = f(60 * 0.8);
  let w, h;
  if (f(texW / texH) > f(maxW / maxH)) { w = maxW; h = f(maxH / f(f(f(maxH / texH) * texW) / maxW)); } else { h = maxH; w = f(maxW / f(f(f(maxW / texW) * texH) / maxH)); }
  const di = rec.log.find((c) => c[0] === 'main' && c[1] === 'drawImage');
  assert.deepStrictEqual(di.slice(3), [0, 0, di[2].match(/\d+/g).map(Number)[0], di[2].match(/\d+/g).map(Number)[1], f(320 - w * 0.5), f(40 - h * 0.5), w, h]);
  // on-screen h * targetScale = 26.8 px -> level 0 (27 px font)
  assert.strictEqual(di[2], '<canvas ' + Math.trunc((0.55 * 27 * 3) + 27 * 0.4) + 'x' + Math.trunc(27 + Math.trunc(27 * 0.4)) + '>');
});

test('text texture rendering: font, size, baseline, outline then fill (8.5), only while dirty', () => {
  const owen = node({ id: 1, x: 0, y: 0, size: 100, rgb: [7, 255, 7] });
  const { rec, r, view, lists } = setup([owen], { own: [1], view: { s: 1, targetScale: 1 } });
  lists.ownCells = [owen];
  r.setName(owen, 'Owen');
  for (let i = 0; i < 9; i++) r.beginFrame();            // (1 + 9) % 10 == 0
  rec.log.length = 0;
  r.drawWorld(rec.main.getContext(), lists, view, { showMass: true }, 1000);
  const off = rec.log.filter((c) => c[0] !== 'main').map((c) => c.slice(1));
  // name: h = 80 world -> 80 px -> level ceil(log2(80/15)) - 1 = 2 (87 px font)
  assert.deepStrictEqual(off.slice(0, 12), [['=font', '87px Ubuntu'], ['measureText', 'Owen'], ['=canvas.width', Math.trunc(0.55 * 87 * 4 + 87.47999572753906 * 0.4)],
    ['=canvas.height', 121], ['=textBaseline', 'middle'], ['=font', '87px Ubuntu'], ['=globalAlpha', 1], ['=lineWidth', 87.47999572753906 * 0.1],
    ['=strokeStyle', 'rgb(0,0,0)'], ['=fillStyle', 'rgb(255,255,255)'], ['strokeText', 'Owen', 17, 60], ['fillText', 'Owen', 17, 60]]);
  // mass text: set (measure at 100 px), font size updated (22.3 px after the first frame), rendered
  assert.deepStrictEqual(off.slice(12, 14), [['=font', '100px Ubuntu'], ['measureText', '100']]);
  const mainDi = rec.log.filter((c) => c[0] === 'main' && c[1] === 'drawImage');
  assert.strictEqual(mainDi.length, 2);
  const m = mainDi[1].slice(3);
  // spec 8.4 worked value: owen size 100 with name, top = h*0.3 + y = 24, hgt 40
  assert.strictEqual(m[5], 24); assert.strictEqual(m[7], 40);
  rec.log.length = 0;
  r.drawWorld(rec.main.getContext(), lists, view, { showMass: true }, 1000);
  assert.strictEqual(rec.log.filter((c) => c[0] !== 'main').length, 0);
});

test('mass text is off by default and shown for everyone only with no own cells', () => {
  const a = node({ id: 10, x: 0, y: 0, size: 100, rgb: [7, 255, 7] });
  const { rec, r, view, lists } = setup([a], { own: [] });
  r.setName(a, 'x');
  rec.log.length = 0;                                    // (10 + 0) % 10 == 0 on frame counter 0
  r.drawWorld(rec.main.getContext(), lists, view, {}, 1000);
  assert.strictEqual(rec.log.filter((c) => c[0] === 'main' && c[1] === 'drawImage').length, 1);
  rec.log.length = 0;
  r.drawWorld(rec.main.getContext(), lists, view, { showMass: true }, 1000);
  assert.strictEqual(rec.log.filter((c) => c[0] === 'main' && c[1] === 'drawImage').length, 2);
  lists.ownCells = [node({ id: 99, x: 0, y: 0, size: 10 })];
  rec.log.length = 0;
  r.drawWorld(rec.main.getContext(), lists, view, { showMass: true }, 1000);
  assert.strictEqual(rec.log.filter((c) => c[0] === 'main' && c[1] === 'drawImage').length, 1);
});

test('no text on food, viruses or ejected blobs, and names off hides other players only', () => {
  const kinds = [{ food: true }, { virus: true }, { ejected: true }];
  for (const k of kinds) {
    const a = node(Object.assign({ id: 10, x: 0, y: 0, size: 100, rgb: [7, 255, 7] }, k));
    const { rec, r, view, lists } = setup([a]);
    r.setName(a, 'x');
    rec.log.length = 0;
    r.drawWorld(rec.main.getContext(), lists, view, { showMass: true }, 1000);
    assert.strictEqual(rec.log.filter((c) => c[1] === 'drawImage').length, 0);
  }
  const other = node({ id: 10, x: 0, y: 0, size: 100, rgb: [7, 255, 7] });
  const mine = node({ id: 20, x: 0, y: 0, size: 100, rgb: [7, 255, 7] });
  const { rec, r, view, lists } = setup([other, mine], { own: [20] });
  r.setName(other, 'x'); r.setName(mine, 'me');
  rec.log.length = 0;
  r.drawWorld(rec.main.getContext(), lists, view, { names: false }, 1000);
  assert.strictEqual(rec.log.filter((c) => c[0] === 'main' && c[1] === 'drawImage').length, 1);
});

test('party icon: default icon at half size above the centre, unclipped (spec 8.1.1 worked value)', () => {
  const rec = makeRecorder();
  const icon = { width: 64, height: 64, complete: true, getContext: () => null };
  const r = R.createRenderer({ createCanvas: () => rec.fakeCanvas(), random: () => 0.5, partyIcon: icon });
  const n = node({ id: 9, x: -260, y: 200, size: 60, highlight: true, rgb: [7, 63, 255] });
  r.initNode(n, 1, 1);
  for (let i = 0; i < 1; i++) r.beginFrame();            // (9 + 1) % 10 == 0
  const lists = { main: [n], fading: [], ownIds: new Set(), ownCells: [], border: { minX: -1, minY: -1, maxX: 1, maxY: 1 } };
  r.drawWorld(rec.main.getContext(), lists, { W: 1280, H: 720, s: 1, camX: 0, camY: 0, targetScale: 1 }, {}, 0);
  const di = rec.log.find((c) => c[1] === 'drawImage');
  assert.deepStrictEqual(di.slice(3), [0, 0, 64, 64, -275, 155, 30, 30]);
});

test('sortMain is the unstable introsort on displayed size (40-node tie order from the card)', () => {
  const { r } = setup([]);
  const sizes = [10, 12, 10, 14, 100, 10, 12, 45];
  const arr = [];
  for (let i = 1; i <= 40; i++) arr.push({ id: i, size: sizes[i % 8] });
  r.sortMain(arr);
  assert.strictEqual(arr.map((n) => n.id).join(','),
    '21,2,37,34,5,32,29,8,26,10,24,40,13,18,16,17,14,22,25,9,30,6,33,38,1,19,11,27,35,3,15,23,7,31,39,20,12,28,4,36');
});

test('collision and border push the wobbling points (5.4)', () => {
  const a = node({ id: 1, x: 0, y: 0, size: 100, rgb: [1, 1, 1] });
  const b = node({ id: 2, x: 150, y: 0, size: 100, rgb: [1, 1, 1] });
  const alone = node({ id: 3, x: 0, y: 0, size: 100, rgb: [1, 1, 1] });
  const run = (nodes, border) => {
    const t = setup(nodes, { view: { s: 1, targetScale: 1 } });
    t.lists.border = border;
    t.r.updateMembranes(t.lists, t.view, {}, 1000);     // reset to rings
    t.r.endFrame();
    t.r.updateMembranes(t.lists, t.view, {}, 1016);
    return nodes[0].pts.map((p) => p.r);
  };
  const wide = { minX: -9000, minY: -9000, maxX: 9000, maxY: 9000 };
  const ra = run([a, b], wide), rs = run([alone, node({ id: 4, x: 9000, y: 0, size: 100 })], wide);
  // same seed, same randoms for node 1's points: only the overlap with node 2 differs
  assert.notDeepStrictEqual(ra, rs);
  const tight = run([node({ id: 3, x: 0, y: 0, size: 100 }), node({ id: 4, x: 9000, y: 0, size: 100 })], { minX: -50, minY: -50, maxX: 50, maxY: 50 });
  assert.ok(Math.max(...tight) < Math.max(...rs));
});

test('clean room: no reference line citations in the shipped file', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ag', 'agRender.js'), 'utf8');
  assert.ok(!/\b[DW]\s*\d{3,}/.test(src));
  assert.ok(!/dcmp|\bwat\b|f_[a-z]{2}\b/.test(src));
  assert.ok(!/Math\.random\(\)\s*[-*]/.test(src.replace(/return Math\.random\(\);/, '')));
});

// Review fix (robustness): our reconnect drops every cached name; the reference's clear-all keeps them.
test('clearNames empties the name cache (our reconnect path)', () => {
  const { r } = setup([]);
  const a = node({ id: 2, x: 0, y: 0, size: 60 }), b = node({ id: 3, x: 0, y: 0, size: 60 });
  r.initNode(a, 1, 1); r.initNode(b, 1, 1);
  r.setName(a, 'Bob'); r.setName(b, 'Ann');
  assert.strictEqual(r.nameCount(), 2);
  r.clearNames();
  assert.strictEqual(r.nameCount(), 0);
  assert.strictEqual(r.nameEntry('Bob'), null);
  const c = node({ id: 4, x: 0, y: 0, size: 60 });
  r.initNode(c, 1, 1);
  r.setName(c, 'Bob');
  assert.strictEqual(r.nameEntry('Bob').refs, 1, 'a name seen again after the reset starts at one user');
});

// Review fix (robustness): one cell far outside any map must not make the bucket grid allocate rows x cols over a
// huge box. That frame fits the rings and picks circle or polygon, but buckets and wobbles nothing.
test('membranes: a node box far bigger than the map skips the buckets and the wobble instead of throwing', () => {
  const near = node({ id: 1, x: 0, y: 0, size: 100, rgb: [200, 7, 255] });
  const far = node({ id: 2, x: 1500000, y: 1500000, size: 100, rgb: [200, 7, 255] });
  const { rng, r, view, lists } = setup([near, far]);
  const c0 = rng.count();
  for (let k = 0; k < 10; k++) {
    assert.doesNotThrow(() => r.updateMembranes(lists, view, {}, 1000 + 17 * k));
    r.endFrame();
  }
  assert.strictEqual(rng.count(), c0, 'no wobble draws while the box is too big');
  assert.strictEqual(near.circle, 0, 'the circle or polygon step still runs');
  assert.strictEqual(near.pts.length, 100);
  // Back to a normal box: buckets and wobble resume.
  lists.main = [near];
  r.updateMembranes(lists, view, {}, 2000);
  assert.strictEqual(rng.count() - c0, 100);
});
