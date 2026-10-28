/* ─── Crossy Road: the picture ────────────────────────────────────────────────
   Draws the map, the traffic and the two hoppers with three.js. Every model
   here is OURS, built from boxes in this file (no file is loaded), drawn to the
   reference's measured sizes, heights and colours (docs/crossy-reference.md,
   "Models"): the reference's models were measured for their bounds and colour
   layers only, never copied.

   - an orthographic camera turned -45 deg down and 20 deg round (YXZ), 3.6
     units above and below the middle, zoomed by the screen's shape;
   - every surface lit per vertex the reference's way: its colour x (fill light
     from view (0,1,2) + key light from view (-1,1,1), each at 0.5, + ambient
     (0.5, 0.5, 0.7)) x 0.8;
   - shadows that darken what they fall on to 0.7, cast to the right (the sun
     sits at (-10, 10, 0) from what it lights), never twice on the same spot;
   - the deaths, the splash, the feathers, the log and lily dip and the rapids
     move by the reference's numbers (envelopes and particle physics, measured
     from its source; our own particles and our own shapes).

   The rules never read any of this: shared/crossySim.js decides; this shows. */
import * as THREE from 'three';

const Sim = window.CrossySim;
const C = Sim.C;

/* ── colours (the reference's measured vertex colours) ───────────────────── */
const COL = {
  // Grass: the playing field (|x| < 4.5) is lighter than the land beyond it; rows alternate.
  grassA: 0xa1cf4c, grassOutA: 0x8bb639, grassB: 0x9bc846, grassOutB: 0x84af34, earth: 0xa95555, earthIn: 0xba6868,
  road: 0x464b4b, roadOut: 0x3e4444, mark: 0x6a7171, markOut: 0x5f6969,
  water: 0x53b7d2, fringe: 0x6ecfeb, foam: 0xffffff,
  sleeper: 0x663931, rail: 0x847e87, bed: 0x464b4b, bedOut: 0x3e4444,
  leaf: 0x9bb519, leafLight: 0xacc721, trunk: 0x79473c, trunkDark: 0x6d372e,
  rock: 0xab9ba3, stumpTop: 0x8e614e,
  logEnd: 0x8e614e, logRing: 0x9a745a, logRing2: 0x9f7e67,
  lily: 0x1bb258, lilyDark: 0x0f9946,
  pole: 0xac3232, poleWhite: 0xffffff, head: 0x340b0b, lampOn: 0xfd5252, lampOff: 0x5a1414,
  white: 0xebfbff, boxWhite: 0xd1e1e5, tyre: 0x000000, trim: 0x7f7590, dark: 0x202020, tail: 0xd9331d, lamp: 0xfff3c4,
  trainBlue: 0x298cc9, trainSky: 0x5bbffd, trainGlass: 0x6fd4ff, trainPale: 0xecf3ff, trainYellow: 0xffe471, trainGrey: 0x9cb0d2, trainDark: 0x2b2a25,
  coin: 0xffe14d, coinDark: 0xe0a92a, coinShine: 0xfff6b8,
};
// Body paint per vehicle: [top, sides]. The reference's palette per model (measured).
const PAINT = {
  electric: [0x13c0cf, 0x049fb9, 0x058bac], purple: [0x8c76fb, 0x7e52d1, 0x764acc], muscle: [0xeb5f28, 0xe54120, 0xd9331d],
  sedan: [0xeb5f28, 0xe54120, 0xd9331d], truck: [0xe43334, 0xcd3042, 0xc72838], truckBlue: [0x049fb9, 0x058bac, 0x047d99],
  truckGreen: [0x549d89, 0x468977, 0xff6137],
};

/* ── the material: the reference's lighting formula, written again ──────────── */
const LIGHT = `
  vec3 light = clamp(dot(normalize(vec3(0.0, 1.0, 2.0)), n), 0.0, 1.0) * vec3(0.5)
             + clamp(dot(vec3(-1.0, 1.0, 1.0), n), 0.0, 1.0) * vec3(0.5)
             + vec3(0.5, 0.5, 0.7);`;
const VS = `
uniform float uOpacity;
varying vec4 vColor;
void main() {
  vec3 n = normalize(normalMatrix * normal);${LIGHT}
  vColor = vec4(color * light * 0.8, uOpacity);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
// The same light on instanced particles (one colour per emitter, baked into its box).
const VS_INST = `
varying vec4 vColor;
void main() {
  vec3 n = normalize(normalMatrix * mat3(instanceMatrix) * normal);${LIGHT}
  vColor = vec4(color * light * 0.8, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const FS = `
varying vec4 vColor;
void main() { gl_FragColor = vColor; }`;
function litMaterial(opacity, vs) {
  const m = new THREE.ShaderMaterial({ vertexShader: vs || VS, fragmentShader: FS, vertexColors: true,
    uniforms: { uOpacity: { value: opacity === undefined ? 1 : opacity } } });
  if (opacity !== undefined && opacity < 1) { m.transparent = true; m.depthWrite = true; }
  return m;
}
const MAT = litMaterial();
const MAT_INST = litMaterial(undefined, VS_INST);

/* Shadows: black at 0.3 (so 0.7 of the colour is left, the reference's), each pixel darkened once (stencil). */
const SHADOW_MAT = new THREE.MeshBasicMaterial({
  color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false,
  stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc,
  stencilZPass: THREE.ReplaceStencilOp, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
});

/* ── building models out of boxes ─────────────────────────────────────────── */
/* A box list -> one geometry with a colour per vertex. b = [x0, y0, z0, x1, y1, z1, colour, faces?]; the bottom
   face is left out (nothing ever sees it). faces, when given, colours single faces: top, front (+z), back (-z),
   side (+x), left (-x), or sides (all four upright ones). */
const FACES = [
  { n: [0, 1, 0], v: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], k: 'top' },
  { n: [0, 0, 1], v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], k: 'front' },
  { n: [0, 0, -1], v: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], k: 'back' },
  { n: [1, 0, 0], v: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], k: 'side' },
  { n: [-1, 0, 0], v: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], k: 'left' },
];
function boxes(list) {
  const pos = [], nor = [], col = [], idx = [];
  const c = new THREE.Color();
  for (const b of list) {
    const [x0, y0, z0, x1, y1, z1, colour, fc] = b;
    for (const f of FACES) {
      let hex = colour;
      if (fc) { if (fc[f.k] !== undefined) hex = fc[f.k]; else if (f.k !== 'top' && fc.sides !== undefined) hex = fc.sides; }
      c.setHex(hex, THREE.LinearSRGBColorSpace);
      const base = pos.length / 3;
      for (const v of f.v) {
        pos.push(v[0] ? x1 : x0, v[1] ? y1 : y0, v[2] ? z1 : z0);
        nor.push(f.n[0], f.n[1], f.n[2]);
        col.push(c.r, c.g, c.b);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
// A centred box: centre x, bottom y, centre z, size w (x), h (y), d (z).
const B = (cx, y, cz, w, h, d, colour, fc) => [cx - w / 2, y, cz - d / 2, cx + w / 2, y + h, cz + d / 2, colour, fc];
const GEO = {};
function geo(name, make) { return GEO[name] || (GEO[name] = make()); }

/* ── trees, rocks, stumps (the reference's sizes: docs/crossy-reference.md) ─────────────────
   A tree: a trunk 0.375 square and 0.375 tall, then a leaf block 0.625 square, banded every 0.375: a dark band
   0.125 high, then a light band 0.25 high, ..., and a dark band on top. Heights 0.875 / 1.25 / 1.625 / 2.0. */
const TREE_H = [0, 0.875, 1.25, 1.625, 2.0];
function treeBoxes(list, x, z, k) {
  list.push(B(x, 0, z, 0.375, 0.375, 0.375, COL.trunk, { front: COL.trunkDark, back: COL.trunkDark }));
  const H = TREE_H[k];
  let y = 0.375;
  list.push(B(x, y, z, 0.625, 0.125, 0.625, COL.leaf)); y += 0.125;
  while (y < H - 0.01) {
    list.push(B(x, y, z, 0.625, 0.25, 0.625, COL.leaf, { sides: COL.leafLight }));
    list.push(B(x, y + 0.25, z, 0.625, 0.125, 0.625, COL.leaf));
    y += 0.375;
  }
}
function treeGeo(k) { const L = []; treeBoxes(L, 0, 0, k); return boxes(L); }
// Our rock: three stepped slabs, 0.75 square at the foot, 0.625 tall (the reference's bounds).
const rockGeo = () => boxes([
  B(0, 0, 0, 0.75, 0.375, 0.75, COL.rock),
  B(0.0625, 0.375, -0.0625, 0.5, 0.125, 0.5, COL.rock),
  B(-0.0625, 0.5, -0.125, 0.375, 0.125, 0.25, COL.rock),
]);
// Our stump: 0.375 cube, a cut top band, a strip of lighter bark down the front.
const stumpGeo = () => boxes([
  B(0, 0, 0, 0.375, 0.25, 0.375, COL.trunkDark),
  B(0, 0.25, 0, 0.375, 0.125, 0.375, COL.stumpTop),
  B(0.0625, 0.0, 0.19, 0.125, 0.3125, 0.01, COL.trunk),
]);
const pieceGeo = {
  1: () => geo('tree1', () => treeGeo(1)), 2: () => geo('tree2', () => treeGeo(2)),
  3: () => geo('tree3', () => treeGeo(3)), 4: () => geo('tree4', () => treeGeo(4)),
  5: () => geo('rock', rockGeo), 9: () => geo('stump', stumpGeo),
};
const PIECE_H = { 1: 0.875, 2: 1.25, 3: 1.625, 4: 2.0, 5: 0.625, 9: 0.375 };
const PIECE_W = { 1: 0.625, 2: 0.625, 3: 0.625, 4: 0.625, 5: 0.75, 9: 0.375 };

/* The forest beyond each side: nine trees packed side by side, 5.625 wide, 1.25 to 2.0 tall (the reference's six
   forest pieces, measured: never the shortest tree, mostly the two tallest). */
function forestGeo(seed) {
  const R = Sim.rng(seed), list = [];
  for (let i = 0; i < 9; i++) { const q = R(); treeBoxes(list, -2.5 + i * 0.625, 0, q < 0.15 ? 2 : q < 0.55 ? 3 : 4); }
  return boxes(list);
}

/* ── vehicles: OUR shapes in the reference's envelopes ──────────────────────
   Long along x (travel), front at +x. Measured envelopes (length x width x height): electric 1.32 x 0.84 x 0.96,
   sedan and purple 1.8 x 1.08 x 0.96, muscle 2.04 x 1.08 x 0.72, trucks 3.0 x 1.08 x 1.32. Layers measured from
   the reference: trim 0.12-0.24, paint 0.24-0.6, black glass 0.6-0.84, white roof to the top; black tyres. */
const CAR_DIM = { electric: [1.32, 0.84, 0.96], purple: [1.8, 1.08, 0.96], sedan: [1.8, 1.08, 0.96], muscle: [2.04, 1.08, 0.72] };
function wheels(list, L, W, inset, r) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) list.push(B(sx * (L / 2 - inset), 0, sz * (W / 2 - 0.1), r, r, 0.14, COL.tyre, { side: COL.dark, left: COL.dark }));
}
function carGeo(id) {
  if (id.startsWith('truck')) return truckGeo(id);
  const [top, side, deep] = PAINT[id];
  const [L, W, H] = CAR_DIM[id];
  const list = [];
  const body = W - 0.24;                                     // the paint is the full width; the cabin and trim 0.24 in
  wheels(list, L, W, id === 'electric' ? 0.3 : 0.42, 0.36);
  list.push(B(0, 0.12, 0, L - 0.12, 0.12, body, COL.trim));
  if (id === 'muscle') {
    // Low and long: paint to 0.48 with a bonnet bulge, a short cabin set back, glass 0.48-0.6, roof 0.6-0.72.
    list.push(B(0, 0.24, 0, L, 0.24, W, top, { sides: side }));
    list.push(B(0.42, 0.48, 0, 0.6, 0.06, 0.36, deep));
    list.push(B(-0.18, 0.48, 0, 0.84, 0.12, body, COL.tyre));
    list.push(B(-0.18, 0.6, 0, 0.84, 0.12, body, COL.white));
    list.push(B(-L / 2 + 0.06, 0.48, 0, 0.12, 0.12, W, deep));              // a low rear lip
  } else {
    list.push(B(0, 0.24, 0, L, 0.36, W, top, { sides: side }));
    const cab = id === 'electric' ? 0.96 : 1.08, at = id === 'electric' ? -0.06 : -0.18;
    list.push(B(at, 0.6, 0, cab, 0.24, body, COL.tyre));
    for (const px of [at - cab / 2 + 0.06, at + cab / 2 - 0.06]) for (const pz of [-1, 1]) list.push(B(px, 0.6, pz * (body / 2 - 0.06), 0.12, 0.24, 0.12, COL.white));
    list.push(B(at, 0.84, 0, cab, H - 0.84, body, COL.white));
  }
  // Lamps: two pale squares in front, two dark-red ones behind.
  for (const sz of [-1, 1]) {
    list.push(B(L / 2 + 0.005, 0.36, sz * (body / 2 - 0.12), 0.01, 0.12, 0.12, COL.lamp));
    list.push(B(-L / 2 - 0.005, 0.36, sz * (body / 2 - 0.12), 0.01, 0.12, 0.12, COL.tail));
  }
  return boxes(list);
}
// Our truck: a cab in front (0.72 long), a white box behind it to 1.32 high, a coloured skirt along the bottom.
function truckGeo(id) {
  const [top, side, deep] = PAINT[id];
  const L = 3.0, W = 1.08, list = [];
  for (const x of [1.02, -0.6, -1.08]) for (const sz of [-1, 1]) list.push(B(x, 0, sz * (W / 2 - 0.1), 0.36, 0.36, 0.14, COL.tyre, { side: COL.dark, left: COL.dark }));
  list.push(B(0, 0.12, 0, L - 0.12, 0.12, W - 0.24, COL.trim));
  list.push(B(0, 0.24, 0, L, 0.12, W, side));                                   // the skirt, end to end
  list.push(B(1.14, 0.36, 0, 0.72, 0.24, W - 0.12, top, { sides: side }));       // the cab
  list.push(B(1.14, 0.6, 0, 0.72, 0.24, W - 0.24, COL.tyre));
  list.push(B(1.38, 0.6, 0, 0.24, 0.24, W - 0.12, top, { sides: side }));
  list.push(B(1.14, 0.84, 0, 0.72, 0.12, W - 0.24, top, { sides: side }));
  list.push(B(-0.39, 0.36, 0, 2.22, 0.96, W, COL.boxWhite, { top: COL.white }));
  list.push(B(-0.39, 0.72, 0, 2.22, 0.12, W + 0.01, deep));                     // our own band round the box
  for (const sz of [-1, 1]) list.push(B(L / 2 + 0.005, 0.36, sz * 0.3, 0.01, 0.12, 0.12, COL.lamp));
  return boxes(list);
}

/* Our train: an engine, five carriages and a tail, laid end to end over the hit box's 32 units, 1.875 tall
   (the reference's lengths: engine 4.875, carriages 4.5, tail 2.5; tail 1.625 tall). Leading end at +x. */
function trainGeo() {
  const list = [];
  const gap = (32 - (4.875 + 5 * 4.5 + 2.5)) / 6;
  const carriage = (cx, len, tall, nose) => {
    list.push(B(cx, 0, 0, len - 0.25, 0.375, 0.8, COL.tyre, { top: COL.trainDark }));            // bogies
    list.push(B(cx, 0.375, 0, len, 0.125, 1.0, COL.trainYellow));                               // the yellow sill
    list.push(B(cx, 0.5, 0, len, tall - 0.75, 1.0, COL.trainBlue, { side: COL.trainSky, left: COL.trainSky }));
    list.push(B(cx, tall - 0.25, 0, len - 0.25, 0.125, 0.9, COL.trainGrey));                      // the roof
    for (let w = -len / 2 + 0.5; w + 0.6 < len / 2 - (nose ? 1.4 : 0.3); w += 0.875)
      list.push(B(cx + w + 0.3, 0.875, 0, 0.6, 0.5, 1.01, COL.trainGlass, { top: COL.trainPale }));
    list.push(B(cx, tall - 0.125, 0, len * 0.4, 0.125, 0.5, COL.trainDark));                      // roof gear
  };
  let x = 16;
  // The engine: a stepped nose with a pale windscreen and a lamp.
  const e = x - 4.875 / 2;
  carriage(e, 4.875, 1.875, true);
  list.push(B(x - 0.7, 0.875, 0, 1.0, 0.5, 1.01, COL.trainPale, { top: COL.trainGrey }));
  list.push(B(x - 0.0625, 0.5, 0, 0.125, 0.375, 0.5, COL.trainYellow));
  list.push(B(x - 0.0625, 0.625, 0, 0.13, 0.125, 0.25, COL.lamp));
  x -= 4.875 + gap;
  for (let i = 0; i < 5; i++) { carriage(x - 2.25, 4.5, 1.875, false); list.push(B(x + gap / 2, 0.45, 0, gap + 0.05, 0.2, 0.3, COL.trainDark)); x -= 4.5 + gap; }
  carriage(x - 1.25, 2.5, 1.625, false);
  list.push(B(x + gap / 2, 0.45, 0, gap + 0.05, 0.2, 0.3, COL.trainDark));
  return boxes(list);
}

/* The crossing signal: our striped pole (red and white, 1.875 tall, 0.125 square) under a dark head with two
   lamps that flash in turn while a train is near (the reference's: warning 1.2 s before the train). */
function signalGeo(lit) {
  const list = [];
  for (let y = 0, i = 0; y < 1.5; y += 0.25, i++) list.push(B(0, y, 0, 0.125, Math.min(0.25, 1.5 - y), 0.125, i % 2 ? COL.poleWhite : COL.pole));
  list.push(B(0, 1.5, 0.0625, 0.625, 0.25, 0.25, COL.head));
  list.push(B(0, 1.75, 0, 0.125, 0.125, 0.125, COL.pole));
  list.push(B(-0.125, 1.5625, 0.19, 0.125, 0.125, 0.01, lit === 1 ? COL.lampOn : COL.lampOff));
  list.push(B(0.125, 1.5625, 0.19, 0.125, 0.125, 0.01, lit === 2 ? COL.lampOn : COL.lampOff));
  list.push(B(0, 0, 0, 0.375, 0.0625, 0.375, COL.head));
  return boxes(list);
}

// Our log: 0.5 x 0.5 by its length, bark in two browns, a pale cut at each end with a ring (the reference's sizes).
function logGeo(w) {
  const L = w, list = [];
  list.push(B(0, 0, 0, L - 0.25, 0.5, 0.5, COL.trunk));
  list.push(B(0, 0.125, 0, L - 0.25, 0.125, 0.51, COL.trunkDark, { top: COL.trunk }));
  for (let i = 0; i < w; i++) list.push(B(-L / 2 + 0.5 + i, 0.5, 0.0625, 0.375, 0.005, 0.125, COL.trunkDark));
  for (const s of [-1, 1]) {
    list.push(B(s * (L / 2 - 0.0625), 0, 0, 0.125, 0.5, 0.5, COL.logEnd));
    list.push(B(s * (L / 2 + 0.003), 0.125, 0, 0.006, 0.25, 0.25, COL.logRing));
    list.push(B(s * (L / 2 + 0.006), 0.25, -0.0625, 0.006, 0.125, 0.125, COL.logRing2));
  }
  return boxes(list);
}
const lilyGeo = () => geo('lily', () => boxes([
  B(0, 0, 0, 0.5, 0.125, 0.5, COL.lily),
  [0.0, 0.125, 0.125, 0.25, 0.13, 0.25, COL.lilyDark],      // our notch, a darker corner
]));
const coinGeo = () => geo('coin', () => boxes([
  B(0, 0, 0, 0.5, 0.5, 0.09, COL.coin, { side: COL.coinDark, left: COL.coinDark, top: COL.coinShine }),
  B(0, 0.17, 0.05, 0.16, 0.16, 0.04, COL.coinShine),            // a raised square pip, our own mark
  B(0, 0.1, 0.05, 0.06, 0.06, 0.04, COL.coinDark), B(0, 0.34, 0.05, 0.06, 0.06, 0.04, COL.coinDark),
]));

/* ── the critters: OUR characters, not anybody else's ───────────────────────
   Nugget (the default): our own hen. A plump golden-buff body wider than it is tall, a separate cream head set
   forward, a three-lobed rose comb lying front to back, a short gold beak with a red wattle, brown wings and an
   upswept dark tail. About 0.5 wide, 0.95 tall and 0.7 deep like the reference's hopper, facing -z.
   Pepper: the same hen in grey, worn by the rival when both seats wear Nugget. Sprout, Bloop, Pebble: free looks. */
const HEN = {
  nugget: { body: 0xfbd88e, body2: 0xfbd88e, head: 0xfff0c8, wing: 0xf0b85c, tail: 0xe9a24c, speck: 0xeab25c, leg: 0xf4b23a },
  pepper: { body: 0xc6d2e2, body2: 0xbccadc, head: 0xe9eef5, wing: 0x7d8ea6, tail: 0x5f7190, speck: 0x9fb0c6, leg: 0xf4b23a },
};
function henGeo(p) {
  // Built at 0.92 and drawn 1.08 times bigger: 0.52 wide, about 1.0 tall with the comb.
  const comb = 0xe8475e, comb2 = 0xc93349, beak = 0xf2a21b, eye = 0x241610;
  const L = [];
  for (const sx of [-1, 1]) {
    L.push(B(sx * 0.11, 0, 0.02, 0.06, 0.14, 0.06, p.leg));                                     // legs
    L.push(B(sx * 0.11, 0, -0.04, 0.12, 0.04, 0.16, p.leg));                                    // feet
  }
  L.push(B(0, 0.12, 0.05, 0.48, 0.4, 0.52, p.body, { sides: p.body2 }));                       // the body
  L.push(B(0, 0.52, 0.12, 0.4, 0.06, 0.38, p.body, { sides: p.body2 }));
  L.push(B(0, 0.16, -0.21, 0.36, 0.3, 0.02, p.head));                                          // the cream breast
  for (const sx of [-1, 1]) L.push(B(sx * 0.245, 0.24, 0.1, 0.03, 0.22, 0.34, p.wing));         // folded wings
  L.push(B(0, 0.44, 0.31, 0.28, 0.2, 0.1, p.tail), B(0, 0.6, 0.35, 0.18, 0.16, 0.08, p.tail)); // the tail, swept up
  L.push(B(0, 0.46, -0.12, 0.34, 0.36, 0.3, p.head));                                          // the head, set forward
  L.push(B(-0.07, 0.82, -0.2, 0.08, 0.08, 0.08, comb), B(-0.07, 0.82, -0.1, 0.08, 0.13, 0.08, comb2), B(-0.07, 0.82, 0.0, 0.08, 0.08, 0.08, comb));
  L.push(B(0, 0.6, -0.3, 0.12, 0.07, 0.08, beak, { top: 0xffc24a }));                         // the beak
  L.push(B(0, 0.5, -0.285, 0.06, 0.1, 0.04, comb));                                            // the wattle
  for (const sx of [-1, 1]) L.push(B(sx * 0.172, 0.66, -0.17, 0.01, 0.07, 0.07, eye));          // eyes, one each side
  L.push(B(0.12, 0.53, 0.2, 0.06, 0.005, 0.06, p.speck), B(-0.08, 0.53, 0.26, 0.06, 0.005, 0.06, p.speck), B(0.02, 0.53, 0.08, 0.05, 0.005, 0.05, p.speck));
  return boxes(L).scale(1.08, 1.08, 1.08);
}
function critterGeo(kind) {
  if (HEN[kind]) return henGeo(HEN[kind]);
  const L = [];
  if (kind === 'pebble') {
    // Pebble: a round grey stone with a cap of moss, two bright eyes and stubby feet.
    const s = 0x9aa3ad, s2 = 0x7b848f, moss = 0x6fbf4a, moss2 = 0x4f9a33;
    L.push(B(0, 0.1, 0, 0.54, 0.5, 0.58, s, { side: s2 }));
    L.push(B(0, 0.6, 0, 0.44, 0.14, 0.48, s, { side: s2 }));
    L.push(B(0, 0.74, 0.02, 0.36, 0.08, 0.4, moss, { side: moss2 }));
    L.push(B(-0.08, 0.82, 0.06, 0.12, 0.06, 0.12, moss, { side: moss2 }));
    L.push(B(-0.12, 0.42, -0.3, 0.13, 0.13, 0.03, 0xffffff), B(0.12, 0.42, -0.3, 0.13, 0.13, 0.03, 0xffffff));
    L.push(B(-0.1, 0.44, -0.32, 0.06, 0.07, 0.02, 0x111820), B(0.14, 0.44, -0.32, 0.06, 0.07, 0.02, 0x111820));
    L.push(B(-0.14, 0, -0.04, 0.16, 0.1, 0.2, s2), B(0.14, 0, -0.04, 0.16, 0.1, 0.2, s2));
  } else if (kind === 'sprout') {
    const g = 0x62c84a, g2 = 0x48a838, belly = 0xd8f2a8;
    L.push(B(0, 0.1, 0, 0.5, 0.62, 0.56, g, { side: g2 }));
    L.push(B(0, 0.72, 0.02, 0.42, 0.12, 0.48, g, { side: g2 }));
    L.push(B(0, 0.18, -0.29, 0.3, 0.34, 0.02, belly));
    L.push(B(-0.12, 0.5, -0.29, 0.12, 0.14, 0.03, 0xffffff), B(0.12, 0.5, -0.29, 0.12, 0.14, 0.03, 0xffffff));
    L.push(B(-0.1, 0.52, -0.31, 0.06, 0.08, 0.02, 0x15201a), B(0.14, 0.52, -0.31, 0.06, 0.08, 0.02, 0x15201a));
    L.push(B(0, 0.84, 0.02, 0.06, 0.16, 0.06, 0x3b7d2a));
    L.push(B(0.11, 0.96, 0.02, 0.2, 0.06, 0.14, 0x8fe05a, { side: 0x5fb83a }));
    L.push(B(-0.08, 0.98, 0.02, 0.14, 0.05, 0.1, 0x8fe05a, { side: 0x5fb83a }));
    L.push(B(-0.13, 0, -0.06, 0.14, 0.1, 0.24, 0xff9a2e, { side: 0xe07a12 }), B(0.13, 0, -0.06, 0.14, 0.1, 0.24, 0xff9a2e, { side: 0xe07a12 }));
  } else {
    const v = 0x9b6cff, v2 = 0x7a4fe0, pale = 0xe9dcff;
    L.push(B(0, 0.08, 0, 0.56, 0.6, 0.6, v, { side: v2 }));
    L.push(B(0, 0.68, 0, 0.46, 0.1, 0.5, v, { side: v2 }));
    L.push(B(0, 0.36, -0.31, 0.3, 0.26, 0.03, 0xffffff));
    L.push(B(0, 0.4, -0.33, 0.14, 0.14, 0.02, 0x1b1230));
    L.push(B(0.04, 0.48, -0.34, 0.05, 0.05, 0.01, 0xffffff));
    L.push(B(0, 0.16, -0.31, 0.2, 0.05, 0.02, pale));
    L.push(B(-0.15, 0.78, 0, 0.08, 0.16, 0.08, pale), B(0.15, 0.78, 0, 0.08, 0.16, 0.08, pale));
    L.push(B(-0.14, 0, 0, 0.16, 0.08, 0.2, v2), B(0.14, 0, 0, 0.16, 0.08, 0.2, v2));
  }
  return boxes(L);
}

// The eagle: our own bird (a slate hawk), wings out, 2.9 across like the reference's.
function eagleGeo() {
  const dark = 0x3a4250, dark2 = 0x2a303b, white = 0xf2efe6, beak = 0xffb02e;
  return boxes([
    B(0, 0, 0, 0.5, 0.42, 0.9, dark, { side: dark2 }),
    B(0, 0.1, -0.6, 0.36, 0.36, 0.36, white),
    B(0, 0.16, -0.84, 0.14, 0.12, 0.14, beak),
    B(-0.11, 0.3, -0.79, 0.06, 0.06, 0.02, 0x111111), B(0.11, 0.3, -0.79, 0.06, 0.06, 0.02, 0x111111),
    B(-0.85, 0.24, 0.05, 1.2, 0.08, 0.6, dark, { side: dark2 }), B(0.85, 0.24, 0.05, 1.2, 0.08, 0.6, dark, { side: dark2 }),
    B(-1.5, 0.22, 0.12, 0.3, 0.06, 0.4, white), B(1.5, 0.22, 0.12, 0.3, 0.06, 0.4, white),
    B(0, 0.08, 0.6, 0.4, 0.08, 0.36, white),
    B(-0.12, -0.12, -0.2, 0.08, 0.14, 0.08, beak), B(0.12, -0.12, -0.2, 0.08, 0.14, 0.08, beak),
  ]);
}

/* ── strips (the rows' ground), measured layer by layer ──────────────────── */
function stripGeo(row, prev) {
  const h = row.h, list = [];
  if (row.kind === 'grass') {
    // Earth below 0.25, a 0.125 band of grass on top; the playing field's top and earth are the lighter ones.
    const top = row.alt ? COL.grassA : COL.grassB, out = row.alt ? COL.grassOutA : COL.grassOutB;
    for (const [x0, x1, inner] of [[-12.5, -4.5, 0], [-4.5, 4.5, 1], [4.5, 12.5, 0]]) {
      list.push([x0, 0, -0.5, x1, 0.25, 0.5, inner ? COL.earthIn : COL.earth]);
      list.push([x0, 0.25, -0.5, x1, 0.375, 0.5, inner ? top : out, { sides: out }]);
    }
  } else if (row.kind === 'road') {
    list.push([-12.5, 0, -0.5, -4.5, 0.25, 0.5, COL.roadOut]);
    list.push([-4.5, 0, -0.5, 4.5, 0.25, 0.5, COL.road, { sides: COL.roadOut }]);
    list.push([4.5, 0, -0.5, 12.5, 0.25, 0.5, COL.roadOut]);
    // Lane marks where it meets the road before it: a cell-long dash on every even cell, 0.125 deep, at the near edge.
    if (prev && prev.kind === 'road') for (let x = -12; x <= 12; x += 2) list.push([x - 0.5, 0.25, 0.375, x + 0.5, 0.2525, 0.5, Math.abs(x) < 4.5 ? COL.mark : COL.markOut]);
  } else if (row.kind === 'water') {
    list.push([-12.5, 0, -0.5, 12.5, 0.125, 0.5, COL.water]);
    // White water at each edge of the playing field, our own ragged line: foam 0.125 a step, a pale fringe inside it.
    const R = Sim.rng((row.r * 7919) >>> 0);
    for (const s of [-1, 1]) for (let z = -0.5; z < 0.5; z += 0.125) {
      const inner = 4.5 - (R() < 0.5 ? 0.125 : 0), outer = 4.75 - (R() < 0.35 ? 0.125 : 0);
      const xs = [s * inner, s * outer].sort((a, b) => a - b), fs = [s * (inner - 0.125), s * inner].sort((a, b) => a - b);
      list.push([xs[0], 0.125, z, xs[1], 0.1275, z + 0.125, COL.foam]);
      list.push([fs[0], 0.125, z, fs[1], 0.1265, z + 0.125, COL.fringe]);
    }
  } else if (row.kind === 'rail') {
    list.push([-12.5, 0, -0.5, -4.5, 0.25, 0.5, COL.bedOut]);
    list.push([-4.5, 0, -0.5, 4.5, 0.25, 0.5, COL.bed, { sides: COL.bedOut }]);
    list.push([4.5, 0, -0.5, 12.5, 0.25, 0.5, COL.bedOut]);
    for (let k = -12; k <= 12; k++) list.push([k - 0.5, 0.25, -0.5, k - 0.375, 0.375, 0.5, COL.sleeper]);   // a sleeper a unit
    for (const z of [-0.3125, 0.3125]) list.push([-12.5, 0.375, z - 0.0625, 12.5, 0.5, z + 0.0625, COL.rail]);
  }
  return boxes(list);
}

/* ── envelopes and particles (the reference's, rebuilt) ──────────────────────
   env(t, pause, attack, sustain, release): 0 during the pause, rises to 1 over the attack, holds, falls over the
   release, 0 after. */
function env(t, p, a, s, r) {
  if (t < p) return 0; t -= p;
  if (t < a) return a > 0 ? t / a : 1; t -= a;
  if (t < s) return 1; t -= s;
  if (t < r) return 1 - t / r;
  return 0;
}
const easeOutQuint = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 5);

/* A burst of little boxes with the reference's particle physics: each starts within size/2 of the point, with
   momentum (offset + direction) x acceleration / k (k random 0.5..1.5); every 60th of a second gravity takes from
   the upward momentum; sideways speed is acceleration x momentum / distance out, so a burst spreads fast and then
   slows; stopAtGround freezes one that falls below 0.3. Pooled after 5 s. */
function makeBurst(scene, n, colour, box, o) {
  const g = boxes([B(0, -box[1] / 2, 0, box[0], box[1], box[2], colour)]);
  const mesh = new THREE.InstancedMesh(g, MAT_INST, n);
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);
  const P = Array.from({ length: n }, () => ({ p: new THREE.Vector3(), m: new THREE.Vector3(), r: new THREE.Euler() }));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  const at = new THREE.Vector3();
  let t = 99;
  return {
    fire(x, y, z) {
      at.set(x, y, z); t = 0; mesh.visible = true;
      for (const s of P) {
        const k = Math.random() + 0.5;
        const ox = (Math.random() - 0.5) * o.size, oy = (Math.random() - 0.5) * o.size, oz = (Math.random() - 0.5) * o.size;
        s.p.set(x + ox, y + oy, z + oz);
        s.m.set((ox + o.dir[0]) * o.acc / k, (oy + o.dir[1]) * o.acc / k, (oz + o.dir[2]) * o.acc / k);
        s.r.set(Math.random() * 6, Math.random() * 6, 0);
      }
    },
    tick(dt) {
      if (t > 5) { mesh.visible = false; return; }
      t += dt;
      const f = dt * 60;
      P.forEach((s, i) => {
        s.m.y -= o.grav * f;
        if (o.ground && s.p.y < 0.3) s.m.set(0, 0, 0);
        const dx = Math.max(0.02, Math.abs(s.p.x - at.x)), dz = Math.max(0.02, Math.abs(s.p.z - at.z));
        s.p.x += o.acc * (s.m.x / dx) * dt; s.p.y += o.acc * s.m.y * dt; s.p.z += o.acc * (s.m.z / dz) * dt;
        if (o.spin) { s.r.y += o.spin * dt * Math.random(); s.r.x += o.spin * 0.1 * dt * Math.random(); }
        m4.compose(s.p, q.setFromEuler(s.r), one);
        mesh.setMatrixAt(i, m4);
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
    stop() { t = 99; mesh.visible = false; },
  };
}

/* ── the scene ───────────────────────────────────────────────────────────── */
export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true, powerPreference: 'high-performance' });
  renderer.setClearColor(COL.grassOutB, 1);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // our colours are written straight out, as the reference's are
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-6.4, 6.4, 3.6, -3.6, -10, 25);
  camera.rotation.set(-Math.PI / 4, Math.PI / 9, 0, 'YXZ');
  const cam = { x: 2.688232, y: 10.75858, z: 9.5, zoom: 1, xExtra: 0.3, yExtra: 0.5, ready: false };

  let world = null;
  const rows = new Map();           // r -> { group, cars: Mesh[], logs: Map, train, signal, coin, lilies }
  const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  function shadow(parent, x0, x1, z0, z1, y) {
    const m = new THREE.Mesh(shadowGeo, SHADOW_MAT);
    m.scale.set(x1 - x0, 1, z1 - z0);
    m.position.set((x0 + x1) / 2, y + 0.004, (z0 + z1) / 2);
    m.renderOrder = 2;
    parent.add(m);
    return m;
  }

  /* Rapids: our white bubbles popping along both edges of every river row near the hopper (the reference's sit
     at x = +-4.55, y 0.1475). One instanced batch for all of them. */
  const RAPIDS = 160;
  const rapids = new THREE.InstancedMesh(boxes([B(0, 0, 0, 0.09, 0.09, 0.09, COL.foam)]), MAT_INST, RAPIDS);
  rapids.frustumCulled = false;
  scene.add(rapids);
  const bub = Array.from({ length: RAPIDS }, (_, i) => ({ seed: i * 0.6180339 % 1 }));
  const rm4 = new THREE.Matrix4(), rq = new THREE.Quaternion(), rv = new THREE.Vector3(), rs = new THREE.Vector3();

  function buildRow(r) {
    const row = world.row(r);
    const prev = world.row(r - 1);
    const g = new THREE.Group();
    g.position.z = -r;
    g.add(new THREE.Mesh(stripGeo(row, prev), MAT));
    const R = { group: g, cars: [], logs: new Map(), train: null, signal: null, coin: null, kind: row.kind, lilies: [] };
    if (row.kind === 'grass') {
      for (let i = 0; i < 9; i++) {
        const k = row.look[i];
        if (!row.cells[i]) continue;
        const m = new THREE.Mesh(pieceGeo[k](), MAT);
        m.position.set(i - 4, row.h, 0);
        g.add(m);
        const w = PIECE_W[k];
        shadow(g, i - 4 - w / 2, i - 4 + w / 2 + PIECE_H[k], -w / 2, w / 2, row.h);
      }
      for (const sx of [-1, 1]) {
        const f = new THREE.Mesh(geo('forest' + ((r * 2 + (sx > 0 ? 1 : 0)) % 6 + 6) % 6, () => forestGeo(r * 2 + sx)), MAT);
        f.position.set(sx * 7.5, row.h, -((r % 2 + 2) % 2) * 0.005);
        g.add(f);
      }
    } else if (row.kind === 'water' && row.type === 'lily') {
      // Lilies rest at 0.3 (the lane's 0.45 less 0.15, the reference's) and turn slowly.
      for (const x of row.lilies) { const m = new THREE.Mesh(lilyGeo(), MAT); m.position.set(x, 0.3, 0); m.userData.x = x; g.add(m); R.lilies.push(m); }
    } else if (row.kind === 'rail') {
      const t = new THREE.Mesh(geo('train', trainGeo), MAT);
      t.visible = false;
      t.rotation.y = row.dir > 0 ? 0 : Math.PI;
      g.add(t);
      R.train = t;
      R.trainShadow = shadow(g, -16, 16 + 1.875, -0.5, 0.5, 0.375);
      R.trainShadow.visible = false;
      R.signal = [0, 1, 2].map(lit => { const s = new THREE.Mesh(geo('signal' + lit, () => signalGeo(lit)), MAT); s.position.set(-0.45, row.h, 0.6); s.visible = lit === 0; g.add(s); return s; });
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x990000, transparent: true, opacity: 0.2, depthWrite: false }));
      glow.position.set(-0.45, 1.6 + row.h, 0.82);
      glow.visible = false;
      g.add(glow);
      R.glow = glow;
    }
    if (row.coin !== null) {
      const c = new THREE.Mesh(coinGeo(), MAT);
      c.position.set(row.coin, row.h + 0.12, 0);
      g.add(c);
      R.coin = c;
    }
    scene.add(g);
    rows.set(r, R);
    return R;
  }

  function dropRow(r) {
    const R = rows.get(r);
    if (!R) return;
    scene.remove(R.group);
    R.group.traverse(o => { if (o.geometry && o.geometry !== shadowGeo && !Object.values(GEO).includes(o.geometry)) o.geometry.dispose(); });
    rows.delete(r);
  }

  /* A log or lily dips 0.18 when a hopper lands on it (the reference's dip: attack 0.1, hold 0.1, release 0.1 s). */
  const dips = [];                  // per seat: { r, k (log id) or x (lily), t (s since landing) }
  function dipOf(r, key) {
    let v = 0;
    for (const d of dips) if (d && d.r === r && d.key === key) v = Math.max(v, env(d.t, 0, 0.1, 0.1, 0.1));
    return v * 0.18;
  }

  /* Moving things on a visible row at lane time d. */
  const tmp = [];
  function updateRow(r, R, d) {
    const row = world.row(r);
    if (row.kind === 'road') {
      const xs = Sim.carsAt(row, d, tmp);
      while (R.cars.length < xs.length) {
        const m = new THREE.Mesh(geo('car_' + row.car.id, () => carGeo(row.car.id)), MAT);
        m.rotation.y = row.dir > 0 ? 0 : Math.PI;
        R.group.add(m);
        const L = row.truck ? 3.0 : CAR_DIM[row.car.id][0], Hh = row.truck ? 1.32 : CAR_DIM[row.car.id][2];
        m.userData.sh = shadow(R.group, -L / 2, L / 2 + Hh, -0.45, 0.45, row.h);
        m.userData.shOff = Hh / 2;
        R.cars.push(m);
      }
      for (let i = 0; i < R.cars.length; i++) {
        const m = R.cars[i], on = i < xs.length;
        m.visible = on; m.userData.sh.visible = on;
        if (on) { m.position.set(xs[i], row.h, 0); m.userData.sh.position.x = xs[i] + m.userData.shOff; }
      }
    } else if (row.kind === 'water' && row.type === 'log') {
      const logs = Sim.logsAt(row, d, tmp);
      const seen = new Set();
      for (const L of logs) {
        seen.add(L.k);
        let m = R.logs.get(L.k);
        if (!m) {
          m = new THREE.Mesh(geo('log' + L.w, () => logGeo(L.w)), MAT);
          R.group.add(m);
          R.logs.set(L.k, m);
        }
        // Logs float at -0.13 (the reference's), so their tops sit at 0.37, level with the grass.
        m.position.set(L.x, -0.13 - dipOf(r, L.k), 0);
      }
      for (const [k, m] of R.logs) if (!seen.has(k)) { R.group.remove(m); R.logs.delete(k); }
    } else if (row.kind === 'water' && row.type === 'lily') {
      for (const m of R.lilies) {
        m.position.y = 0.3 - dipOf(r, m.userData.x);
        m.rotation.y = Math.sin(d * 0.5 + m.userData.x) * 0.12;     // a slow turn on the current
      }
    } else if (row.kind === 'rail') {
      const tr = Sim.trainAt(row, d);
      R.train.visible = tr.cx !== null;
      R.trainShadow.visible = tr.cx !== null;
      if (tr.cx !== null) {
        R.train.position.set(tr.cx, 0.375, 0);                      // the reference's train sits at 0.375
        R.trainShadow.position.x = tr.cx + 1.875 / 2;
      }
      // The two lamps take turns, a third of a second each (our flash rate).
      const ph = tr.warn ? 1 + (Math.floor(d * 3) % 2) : 0;
      for (let i = 0; i < 3; i++) R.signal[i].visible = i === ph;
      R.glow.visible = tr.warn;
      if (tr.warn) R.glow.position.x = ph === 1 ? -0.575 : -0.325;
    }
  }

  /* ── the hoppers ─────────────────────────────────────────────────────── */
  const crit = [0, 1].map(() => {
    const solid = new THREE.Mesh(critterGeo('nugget'), MAT);
    const holder = new THREE.Group();
    holder.add(solid);
    const sh = shadow(scene, -0.25, 0.25 + 0.95, -0.3, 0.3, 0);
    scene.add(holder);
    return { holder, solid, sh, squash: new THREE.Vector3(1, 1, 1), look: null, dead: null, carry: null, landKey: null };
  });
  const FACE = { 1: 0, 2: Math.PI, 3: Math.PI / 2, 4: -Math.PI / 2 };
  const eagle = new THREE.Mesh(eagleGeo(), MAT);
  eagle.visible = false;
  scene.add(eagle);
  // The splash (70 blue boxes, the reference's drown burst) and the feathers (our hen's, in her own colours).
  const splash = [0, 1].map(() => makeBurst(scene, 70, 0x449eff, [0.15, 0.15, 0.15], { acc: 1.9, grav: 0.3, size: 0.9, dir: [0, 1.5, 0], ground: true }));
  const feathers = [0, 1].map(() => ({}));
  function featherBurst(k, look) {
    const p = HEN[look] || HEN.nugget;
    const key = look in HEN ? look : 'nugget';
    if (!feathers[k][key]) feathers[k][key] = makeBurst(scene, 40, p.body, [0.1, 0.004, 0.02], { acc: 0.4, grav: 0.02, size: 1.6, dir: [3.5, 2, -3], spin: 3 });
    return feathers[k][key];
  }

  /* One hopper on screen. b: Sim.bodyAt; face: the move it faced; hold: a key is held (the reference squashes
     1.2, 0.7, 1.1 while it is down); dead: { type, age, side } or null; land: { r, key, t } while it rides a log or
     lily (the dip); wobble: seconds since the match started (the reference's start wobble). */
  const dq = new THREE.Quaternion(), de = new THREE.Euler();
  function drawHopper(k, b, face, ghost, hold, dead, dt, land, wobble) {
    const c = crit[k];
    c.holder.visible = true;
    dips[k] = land || null;
    let sx = 1, sy = 1, sz = 1, x = b.x, y = b.y, z = b.z;
    // The hop squash (the reference's movePasr scale: wider and shorter with the arc).
    const a = b.arc * 0.5;
    sx = 1 + a * 0.1; sy = 1 - a * 0.4;
    if (hold) { sx = 1.2; sy = 0.7; sz = 1.1; }
    if (!dead && wobble !== undefined && wobble >= 0 && wobble < 0.8 && env(wobble, 0, 0.4, 0, 0.4) > 0.5) { sx = 1.1; sy = 0.9; sz = 1.1; }
    if (land) y -= env(land.t, 0.01, 0.1, 0.17, 0.1) * 0.2;
    let yaw = FACE[face] || 0, roll = 0, snap = false;
    if (dead) {
      if (!c.dead || c.dead.type !== dead.type || dead.age < c.dead.age) startDeath(k, c, dead, b);
      c.dead.age = dead.age;
      const t = dead.age;
      if (dead.type === 'car' || dead.type === 'train') {
        if (c.carry) {
          // Hit from the side (or by a train): flattened against it and carried along.
          const m = c.carry.mesh;
          if (m && m.visible && (c.carry.train || Math.abs(m.position.x - c.carry.lastX) < 3)) c.carry.lastX = m.position.x;
          x = c.carry.lastX - c.carry.off;
          if (Math.abs(x) > 12) c.holder.visible = false;
          if (c.carry.side) { y = c.dead.ground + 0.3; z = b.z + 0.6; sx = 1; sy = 1.3; sz = env(t, 0, 0, 0, 0.1) + 0.15; yaw = Math.PI; roll = c.dead.roll; }
          else { y = c.dead.ground; sx = 1 + (1 - env(t, 0, 0, 0, 1)); sy = env(t, 0, 0, 0, 0.1) + 0.05; sz = 1; yaw = c.dead.yaw; }
        } else {
          // Run over: spread flat on the road (x to 2 over 1 s, y to 0.05 over 0.1 s), turned a little.
          y = c.dead.ground; sx = 1 + (1 - env(t, 0, 0, 0, 1)); sy = env(t, 0, 0, 0, 0.1) + 0.05; sz = 1; yaw = c.dead.yaw;
        }
        snap = true;
      } else if (dead.type === 'water' || dead.type === 'log') {
        // Sinks: 0.5 - easeOutQuint over 1 s to 1.4 down (the reference's drown), then gone.
        y = 0.5 - easeOutQuint(t) * 1.4;
        if (t > 1.05) c.holder.visible = false;
      } else if (dead.type === 'eagle') {
        const ez = b.z - 20 + t * 30;
        if (ez >= b.z) { z = ez; y = b.y + 0.2 + (ez - b.z) * 0.12; }
      }
    }
    const f = Math.min(0.5, 15 * dt);
    if (snap) c.squash.set(sx, sy, sz);
    else { c.squash.x += (sx - c.squash.x) * f; c.squash.y += (sy - c.squash.y) * f; c.squash.z += (sz - c.squash.z) * f; }
    c.holder.scale.copy(c.squash);
    c.holder.position.set(x, y, z);
    // Turning: a fifth of the way a frame at 60 fps (the reference's turn slerp at 5x over the 0.4 s move).
    dq.setFromEuler(de.set(0, yaw, roll));
    if (dead && (dead.type === 'car' || dead.type === 'train')) c.holder.quaternion.copy(dq);
    else c.holder.quaternion.slerp(dq, Math.min(1, dt * 12));
    const row = world ? world.row(Math.round(-b.z)) : null;
    const ground = row ? (row.kind === 'water' ? 0.125 : row.h) : 0.375;
    const onWater = row && row.kind === 'water' && !land;
    c.sh.visible = c.holder.visible && !(dead && dead.type !== 'car' && dead.type !== 'train') && !onWater;
    c.sh.position.set(x + 0.475 + Math.max(0, y - ground) * 0.5, (land ? y - 0.025 : ground) + 0.004, z);
    for (const s of [splash[k]]) s.tick(dt);
    for (const v of Object.values(feathers[k])) v.tick(dt);
    return c.holder.position;
  }
  function startDeath(k, c, dead, b) {
    const r = Math.round(-b.z), R = rows.get(r), row = world && world.row(r);
    c.dead = { type: dead.type, age: dead.age, ground: row ? row.h : 0.375, yaw: Math.random() * (Math.PI / 2) - Math.PI / 4, roll: Math.random() * (Math.PI / 2) - Math.PI / 4 };
    c.carry = null;
    if (dead.type === 'train' && R && R.train && R.train.visible) {
      c.carry = { mesh: R.train, lastX: R.train.position.x, off: R.train.position.x - b.x, side: false, train: true };
    } else if (dead.type === 'car' && dead.side && R) {
      let best = null;
      for (const m of R.cars) if (m.visible && (!best || Math.abs(m.position.x - b.x) < Math.abs(best.position.x - b.x))) best = m;
      if (best) c.carry = { mesh: best, lastX: best.position.x, off: best.position.x - b.x, side: true };
    }
    if (dead.type === 'water' || dead.type === 'log') splash[k].fire(b.x, 0.5, b.z);
    if ((dead.type === 'car' || dead.type === 'train') && (c.look in HEN || !c.look)) featherBurst(k, c.look).fire(b.x, b.y + 0.4, b.z);
  }
  /* Each seat's look (shared/crossyLooks.js ids; null = Nugget). When both seats wear Nugget, the one that is not
     yours (seat 1 for a watcher) wears Pepper, so the two hens tell apart at a glance. */
  function setLooks(ids, mySeat) {
    const want = [0, 1].map(k => (ids && ids[k]) || 'nugget');
    if (want[0] === 'nugget' && want[1] === 'nugget') want[mySeat === 1 ? 0 : 1] = 'pepper';
    for (let k = 0; k < 2; k++) {
      const c = crit[k];
      if (c.look === want[k]) continue;
      c.look = want[k];
      c.solid.geometry = critterGeo(want[k]);
    }
  }
  function hideHopper(k) { crit[k].holder.visible = false; crit[k].sh.visible = false; }

  /* The eagle swoops from 20 ahead at 30 units a second (the reference's), takes the hopper and flies on. */
  function drawEagle(on, x, z, age) {
    eagle.visible = on;
    if (!on) return;
    const ez = z - 20 + age * 30;
    eagle.position.set(x, ez < z ? 2.2 - Math.max(0, 1 - (z - ez) / 6) * 0.6 : 1.6 + (ez - z) * 0.12, ez);
    eagle.rotation.y = Math.PI;
  }

  /* ── the camera (the reference's resize and follow loop) ─────────────── */
  let W = 1, H = 1;
  function resize(w, h, dpr) {
    W = w; H = h;
    renderer.setPixelRatio(Math.min(dpr || 1, 2));
    renderer.setSize(w, h, false);
    const aspect = w / h;
    if (aspect < 0.75) { cam.zoom = 2 / 3; cam.xExtra = 1; cam.yExtra = 2.2; }
    else if (aspect > 1.25) { cam.zoom = 1; cam.xExtra = 0.3; cam.yExtra = 0.5; }
    else { const s = (aspect - 0.75) * 2; cam.zoom = 2 / 3 + s / 3; cam.xExtra = 1 + s * -0.7; cam.yExtra = 2.2 - s * 1.7; }
    /* The reference letterboxes a screen narrower than 9:16 (blue bars above and below); ours keeps its 9:16 width and
       shows more road above and below instead, so the world is the same size on a tall phone. */
    const a = Math.max(aspect, 0.5625);
    camera.left = -3.6 * a; camera.right = 3.6 * a; camera.top = 3.6 * a / aspect; camera.bottom = -3.6 * a / aspect;
    camera.updateProjectionMatrix();
  }
  /* Follow: x and z ease toward the target by dt a frame (the reference's lerp(.., .., deltaTime)). A dead hopper's
     camera eases in to 1.5 zoom on where it is drawn (the death cam: + (2.388232, 10.25858, 8)); one carried by a
     train is followed only while it is within 5 of the middle (the reference's). */
  function follow(b, eagleT, dt, dead, seat) {
    const tx = 2.388232 + cam.xExtra + b.x;
    const tz = b.z + 4 + (4 - (eagleT + 0.5));
    cam.y = 10.25858 + cam.yExtra;
    let zoom = cam.zoom;
    if (!cam.ready) { cam.x = tx; cam.z = tz; cam.ready = true; cam.deadZoom = cam.zoom; }
    if (dead) {
      cam.deadZoom += (1.5 - cam.deadZoom) * Math.min(1, dt * 2);
      zoom = cam.deadZoom;
      if (dead.type !== 'eagle') {
        const p = seat >= 0 ? crit[seat].holder.position : b;
        const px = dead.type === 'train' ? Math.max(-5, Math.min(5, p.x)) : p.x;
        const k = Math.min(1, dt * 1.5);
        cam.x += (px + 2.388232 - cam.x) * k; cam.z += (b.z + 8 - cam.z) * k;
      }
    } else {
      cam.deadZoom = cam.zoom;
      const k = Math.min(1, dt);
      cam.x += (tx - cam.x) * k; cam.z += (tz - cam.z) * k;
    }
    camera.position.set(cam.x, cam.y, cam.z);
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
  }

  /* ── a frame ─────────────────────────────────────────────────────────── */
  function setWorld(w) {
    for (const r of [...rows.keys()]) dropRow(r);
    world = w;
    cam.ready = false;
    for (const c of crit) { c.dead = null; c.carry = null; }
    for (const s of splash) s.stop();
    for (const f of feathers) for (const v of Object.values(f)) v.stop();
  }
  // Coins this screen has seen taken: the row's coin is hidden.
  const taken = new Set();
  function takeCoin(r) { taken.add(r); }
  function resetCoins() { taken.clear(); }

  function render(d, focusRow) {
    if (!world) return;
    const lo = focusRow - 10, hi = focusRow + 20;
    for (const r of [...rows.keys()]) if (r < lo || r > hi) dropRow(r);
    let nb = 0;
    for (let r = Math.max(C.FIRST_ROW, lo); r <= hi; r++) {
      const R = rows.get(r) || buildRow(r);
      updateRow(r, R, d);
      if (R.coin) {
        R.coin.visible = !taken.has(r);
        R.coin.rotation.y = 0.35 + Math.sin(d * 2.4) * 0.45;      // turned to the camera, rocking (our coin)
        R.coin.position.y = world.row(r).h + 0.12 + Math.sin(d * 3.1 + r) * 0.04;
      }
      // Rapids bubbles on the river rows near the hopper: each rises a little and is gone in 0.6 s.
      if (R.kind === 'water' && r >= focusRow - 4 && r <= focusRow + 10) {
        for (let i = 0; i < 10 && nb < RAPIDS; i++, nb++) {
          const s = bub[nb], ph = (d / 0.6 + s.seed * 7 + r * 0.37) % 1, cyc = Math.floor(d / 0.6 + s.seed * 7 + r * 0.37);
          const side = i % 2 ? 1 : -1, j = ((cyc * 9301 + nb * 49297) % 233280) / 233280;
          rv.set(side * (4.55 + (j - 0.5) * 0.3), 0.1475 + ph * 0.12, -r + (((cyc * 7 + i * 13) % 10) / 10 - 0.45));
          const sc = 1 - ph;
          rs.set(sc, sc, sc);
          rm4.compose(rv, rq, rs);
          rapids.setMatrixAt(nb, rm4);
        }
      }
    }
    rapids.count = nb;
    rapids.instanceMatrix.needsUpdate = true;
    renderer.render(scene, camera);
  }

  return { renderer, scene, camera, resize, follow, render, setWorld, drawHopper, hideHopper, drawEagle, takeCoin, resetCoins, setLooks,
    size: () => ({ w: W, h: H }) };
}
