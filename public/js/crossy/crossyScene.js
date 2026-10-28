/* ─── Crossy Road: the picture ────────────────────────────────────────────────
   Draws the map, the traffic and the two hoppers with three.js. Every model
   here is ours, built from boxes in this file (no file is loaded); the camera,
   the lighting formula, the colours and the sizes are the reference's, measured
   (docs/crossy-reference.md):

   - an orthographic camera turned -45 deg down and 20 deg round (YXZ), 3.6
     units above and below the middle, zoomed by the screen's shape;
   - every surface lit per vertex the reference's way: its colour x (fill light
     from view (0,1,2) + key light from view (-1,1,1), each at 0.5, + ambient
     (0.5, 0.5, 0.7)) x 0.8;
   - shadows that darken what they fall on to 0.7, cast to the right (the sun
     sits at (-10, 10, 0) from what it lights), never twice on the same spot.

   The rules never read any of this: shared/crossySim.js decides; this shows. */
import * as THREE from 'three';

const Sim = window.CrossySim;
const C = Sim.C;

/* ── colours (the reference's vertex colours; docs/crossy-reference.md) ─────── */
const COL = {
  grassA: 0xa1cf4c, grassB: 0x9bc846, grassSideA: 0x8bb639, grassSideB: 0x84af34, earth: 0xa95555, earth2: 0xba6868,
  road: 0x3e4444, road2: 0x464b4b, mark: 0x6a7171, mark2: 0x5f6969,
  water: 0x53b7d2, water2: 0x6ecfeb, foam: 0xffffff,
  sleeper: 0x663931, rail: 0x847e87, bed: 0x3e4444, bed2: 0x464b4b,
  leaf: 0x9bb519, leaf2: 0xacc721, trunk: 0x79473c, trunk2: 0x6d372e,
  rock: 0xab9ba3, stump: 0x8e614e, stump2: 0x6d372e,
  log: 0x79473c, log2: 0x6d372e, logEnd: 0x9a745a, logEnd2: 0x8e614e,
  lily: 0x1bb258, lily2: 0x0f9946,
  lightOn: 0xfd5252, lightRed: 0xac3232, lightOff: 0x340b0b, post: 0x847e87, postDark: 0x2b2a25,
  glass: 0xebfbff, tyre: 0x000000, trim: 0x7f7590, hub: 0x202020,
  trainBlue: 0x298cc9, trainSky: 0x5bbffd, trainPale: 0xecf3ff, trainYellow: 0xffe471, trainDark: 0x2b2a25, trainGrey: 0x9cb0d2,
  coin: 0xffd23f, coinDark: 0xd99a1e, coinShine: 0xfff3a8,
};
const CAR_PAINT = {
  electric: [0x13c0cf, 0x049fb9], purple: [0x8c76fb, 0x7e52d1], muscle: [0xe54120, 0xd9331d], sedan: [0xeb5f28, 0xe54120],
  truck: [0xcd3042, 0xe43334], truckBlue: [0x058bac, 0x049fb9], truckGreen: [0x549d89, 0x468977],
};

/* ── the material: the reference's lighting formula, written again ──────────── */
const VS = `
uniform float uOpacity;
varying vec4 vColor;
void main() {
  vec3 n = normalize(normalMatrix * normal);
  vec3 light = clamp(dot(normalize(vec3(0.0, 1.0, 2.0)), n), 0.0, 1.0) * vec3(0.5)
             + clamp(dot(vec3(-1.0, 1.0, 1.0), n), 0.0, 1.0) * vec3(0.5)
             + vec3(0.5, 0.5, 0.7);
  vColor = vec4(color * light * 0.8, uOpacity);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FS = `
varying vec4 vColor;
void main() { gl_FragColor = vColor; }`;
function litMaterial(opacity) {
  const m = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, vertexColors: true,
    uniforms: { uOpacity: { value: opacity === undefined ? 1 : opacity } } });
  if (opacity !== undefined && opacity < 1) { m.transparent = true; m.depthWrite = true; }
  return m;
}
const MAT = litMaterial();

/* Shadows: black at 0.3 (so 0.7 of the colour is left, the reference's sm), each pixel darkened once (stencil). */
const SHADOW_MAT = new THREE.MeshBasicMaterial({
  color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false,
  stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc,
  stencilZPass: THREE.ReplaceStencilOp, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
});

/* ── building models out of boxes ─────────────────────────────────────────── */
/* A box list -> one geometry with a colour per vertex. b = [x0, y0, z0, x1, y1, z1, colour, faceColours?]; the
   bottom face is left out (nothing ever sees it). faceColours, when given, is { top, side, front } for that box. */
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
      const hex = fc && fc[f.k] !== undefined ? fc[f.k] : colour;
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

/* ── the pieces ──────────────────────────────────────────────────────────── */
// Trees: a trunk and a leafy block, 0.625 wide, 0.875 / 1.25 / 1.625 / 2.0 tall (the reference's four heights).
const TREE_H = [0, 0.875, 1.25, 1.625, 2.0];
function treeGeo(k) {
  const H = TREE_H[k], trunkH = 0.3;
  const list = [B(0, 0, 0, 0.25, trunkH, 0.25, COL.trunk, { side: COL.trunk2 })];
  // Leaves in bands of the two greens, the lighter band every other one.
  const top = H - trunkH, bands = Math.max(1, Math.round(top / 0.29));
  for (let i = 0; i < bands; i++) {
    const y0 = trunkH + (top * i) / bands, y1 = trunkH + (top * (i + 1)) / bands;
    list.push([-0.3125, y0, -0.3125, 0.3125, y1, 0.3125, i % 2 ? COL.leaf2 : COL.leaf]);
  }
  return boxes(list);
}
const GEO = {};
function geo(name, make) { return GEO[name] || (GEO[name] = make()); }
const pieceGeo = {
  1: () => geo('tree1', () => treeGeo(1)), 2: () => geo('tree2', () => treeGeo(2)),
  3: () => geo('tree3', () => treeGeo(3)), 4: () => geo('tree4', () => treeGeo(4)),
  5: () => geo('rock', () => boxes([B(0, 0, 0, 0.75, 0.42, 0.7, COL.rock), B(-0.05, 0.42, 0.02, 0.56, 0.2, 0.5, COL.rock)])),
  9: () => geo('stump', () => boxes([B(0, 0, 0, 0.375, 0.375, 0.375, COL.stump, { top: COL.logEnd, side: COL.stump2 })])),
};
const PIECE_H = { 1: 0.875, 2: 1.25, 3: 1.625, 4: 2.0, 5: 0.62, 9: 0.375 };
const PIECE_W = { 1: 0.625, 2: 0.625, 3: 0.625, 4: 0.625, 5: 0.75, 9: 0.375 };

// The forest beyond each side: a wall of trees of mixed heights, 5.6 wide (the reference's forest pieces).
function forestGeo(seed) {
  const R = Sim.rng(seed), list = [];
  for (let i = 0; i < 6; i++) {
    const x = -2.5 + i * 1.0 + (R() - 0.5) * 0.1, k = 2 + Math.floor(R() * 3), H = TREE_H[k];
    list.push(B(x, 0, 0, 0.25, 0.3, 0.25, COL.trunk, { side: COL.trunk2 }));
    const bands = Math.max(1, Math.round((H - 0.3) / 0.29));
    for (let j = 0; j < bands; j++) {
      const y0 = 0.3 + ((H - 0.3) * j) / bands, y1 = 0.3 + ((H - 0.3) * (j + 1)) / bands;
      list.push([x - 0.3125, y0, -0.3125, x + 0.3125, y1, 0.3125, j % 2 ? COL.leaf2 : COL.leaf]);
    }
  }
  return boxes(list);
}

// Cars, our own shapes at the reference's sizes (long along x: electric 1.32, sedan 1.8, muscle 2.04, truck 3.0).
function carGeo(id) {
  const [paint, paint2] = CAR_PAINT[id];
  const truck = id.startsWith('truck');
  const L = truck ? 3.0 : id === 'electric' ? 1.32 : id === 'muscle' ? 2.04 : 1.8;
  const W = id === 'electric' ? 0.84 : 1.08, H = truck ? 1.32 : id === 'muscle' ? 0.72 : 0.96;
  const list = [];
  const wheel = (x, z) => list.push(B(x, 0, z, 0.3, 0.3, 0.12, COL.tyre, { side: COL.hub }));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) wheel(sx * (L / 2 - (truck ? 0.45 : 0.32)), sz * (W / 2 - 0.02));
  if (truck) {
    // A cab at the front (+x) and a box behind it.
    list.push(B(L / 2 - 0.45, 0.15, 0, 0.9, 0.62, W, paint, { side: paint2 }));
    list.push(B(L / 2 - 0.4, 0.77, 0, 0.62, 0.36, W * 0.92, COL.glass, { top: paint }));
    list.push(B(-0.4, 0.15, 0, L - 0.9 - 0.05, H - 0.15, W, COL.trainPale, { side: COL.trim }));
    list.push(B(-0.4, 0.15, 0, L - 0.95, 0.12, W + 0.02, paint2));
  } else {
    list.push(B(0, 0.15, 0, L, H * 0.45, W, paint, { side: paint2 }));
    list.push(B(-L * 0.06, 0.15 + H * 0.45, 0, L * 0.55, H * 0.4, W * 0.86, COL.glass, { top: paint, front: COL.glass }));
    list.push(B(-L * 0.06, 0.15 + H * 0.45 + H * 0.4 - 0.02, 0, L * 0.5, 0.06, W * 0.8, paint));
    list.push(B(L / 2 - 0.02, 0.3, W / 2 - 0.16, 0.06, 0.1, 0.16, COL.trainYellow));
    list.push(B(L / 2 - 0.02, 0.3, -W / 2 + 0.16, 0.06, 0.1, 0.16, COL.trainYellow));
  }
  return boxes(list);
}

function logGeo(w) {
  const L = w, list = [B(0, 0, 0, L - 0.08, 0.5, 0.5, COL.log, { side: COL.log2, top: COL.log })];
  list.push(B(L / 2 - 0.04, 0.02, 0, 0.08, 0.46, 0.46, COL.logEnd, { side: COL.logEnd, top: COL.log }));
  list.push(B(-L / 2 + 0.04, 0.02, 0, 0.08, 0.46, 0.46, COL.logEnd2));
  for (let i = 0; i < w; i++) list.push(B(-L / 2 + 0.5 + i, 0.5, 0.12, 0.3, 0.02, 0.08, COL.log2));
  return boxes(list);
}
const lilyGeo = () => geo('lily', () => boxes([B(0, 0, 0, 0.5, 0.1, 0.5, COL.lily, { side: COL.lily2 }), B(0.12, 0.1, -0.1, 0.16, 0.025, 0.16, COL.lily2)]));
const coinGeo = () => geo('coin', () => boxes([
  B(0, 0, 0, 0.5, 0.5, 0.09, COL.coin, { side: COL.coinDark, top: COL.coinShine }),
  B(0, 0.17, 0.05, 0.16, 0.16, 0.04, COL.coinShine),            // a raised square pip, our own mark
  B(0, 0.1, 0.05, 0.06, 0.06, 0.04, COL.coinDark), B(0, 0.34, 0.05, 0.06, 0.06, 0.04, COL.coinDark),
]));

// The train: an engine at the leading end, five carriages, a tail; 1.875 tall, the hit box's 32 units long.
function trainGeo() {
  const list = [];
  const car = (cx, len, colour, colour2) => {
    list.push(B(cx, 0.12, 0, len - 0.16, 0.3, 0.9, COL.trainDark));
    list.push(B(cx, 0.42, 0, len - 0.1, 1.2, 1.0, colour, { side: colour2 }));
    list.push(B(cx, 1.62, 0, len - 0.3, 0.2, 0.9, COL.trainGrey));
    for (let w = -len / 2 + 0.6; w < len / 2 - 0.4; w += 0.9) list.push(B(cx + w + 0.2, 0.95, 0.01, 0.5, 0.4, 1.02, COL.trainPale));
    list.push(B(cx, 0.48, 0.01, len - 0.1, 0.12, 1.02, COL.trainYellow));
  };
  // Leading end at +x (the model is turned for a train going the other way).
  list.push(B(13.6, 0.12, 0, 4.6, 0.3, 0.9, COL.trainDark));
  list.push(B(13.4, 0.42, 0, 4.0, 1.25, 1.0, COL.trainBlue, { side: COL.trainSky }));
  list.push(B(15.6, 0.42, 0, 0.6, 0.9, 1.0, COL.trainYellow));
  list.push(B(12.4, 1.67, 0, 1.8, 0.2, 0.9, COL.trainGrey));
  list.push(B(14.6, 1.0, 0.01, 0.9, 0.45, 1.02, COL.trainPale));
  for (let i = 0; i < 5; i++) car(9.0 - 4.5 * i, 4.4, i % 2 ? COL.trainSky : COL.trainBlue, i % 2 ? COL.trainBlue : COL.trainSky);
  list.push(B(-14.2, 0.42, 0, 2.4, 1.0, 1.0, COL.trainBlue, { side: COL.trainSky }));
  return boxes(list);
}

// The crossing signal: a post with a two-lamp head, lit red while a train is coming (1.2 s, the reference's).
function signalGeo(on) {
  return boxes([
    B(0, 0, 0, 0.16, 1.35, 0.16, COL.post, { side: COL.postDark }),
    B(0, 1.35, 0, 0.62, 0.36, 0.2, COL.postDark),
    B(-0.16, 1.41, 0.08, 0.2, 0.24, 0.06, on ? COL.lightOn : COL.lightOff),
    B(0.16, 1.41, 0.08, 0.2, 0.24, 0.06, on ? COL.lightRed : COL.lightOff),
    B(0, 0, 0, 0.36, 0.08, 0.36, COL.postDark),
  ]);
}

/* ── the two critters: OUR characters, not anybody else's ───────────────────
   Sprout (seat 0): a green bean with a leaf on top, big dot eyes, orange feet.
   Bloop (seat 1): a violet jelly with one big eye and two little horns.
   Both about 0.5 wide, 0.7 deep and 0.95 tall (the hopper's size), facing -z. */
function critterGeo(kind) {
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
    return boxes(L);
  }
  if (kind === 'bloop') kind = 1;
  if (kind === 'sprout') kind = 0;
  if (kind === 0) {
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

// The eagle that takes a hopper who stands still too long: our own bird (a slate hawk), wings out, about 2.5 wide.
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

/* ── strips (the rows' ground) ───────────────────────────────────────────── */
function stripGeo(row, prev) {
  const h = row.h, list = [];
  if (row.kind === 'grass') {
    const top = row.alt ? COL.grassA : COL.grassB, side = row.alt ? COL.grassSideA : COL.grassSideB;
    list.push([-12.5, h - 0.06, -0.5, 12.5, h, 0.5, top, { front: side, back: side }]);
    list.push([-12.5, 0, -0.5, 12.5, h - 0.06, 0.5, COL.earth, { top, side: COL.earth2 }]);
  } else if (row.kind === 'road') {
    // Top 464b4b, sides 3e4444: the reference's road renders 535864 on top, which is 464b4b lit (measured 2026-10-28).
    list.push([-12.5, 0, -0.5, 12.5, h, 0.5, COL.road2, { front: COL.road, side: COL.road }]);
    // Lane marks where it meets the road before it (strip-road-1); the first road after something else has none.
    if (prev && prev.kind === 'road') for (let x = -12; x < 12.5; x += 1.5) list.push([x, h, 0.47, x + 0.7, h + 0.005, 0.53, COL.mark]);
  } else if (row.kind === 'water') {
    list.push([-12.5, 0, -0.5, 12.5, 0.125, 0.5, COL.water, { top: COL.water }]);
    // The rapids at each edge of the playing field (the reference's at +-4.55): a strip of foam.
    for (const sx of [-1, 1]) list.push([sx * 4.55 - 0.08, 0.125, -0.5, sx * 4.55 + 0.08, 0.13, 0.5, COL.water2]);
  } else if (row.kind === 'rail') {
    list.push([-12.5, 0, -0.5, 12.5, h, 0.5, COL.bed2, { front: COL.bed, side: COL.bed }]);
    for (let x = -12.25; x < 12.5; x += 0.5) list.push([x - 0.1, h, -0.42, x + 0.1, h + 0.06, 0.42, COL.sleeper]);
    for (const z of [-0.26, 0.26]) list.push([-12.5, h + 0.06, z - 0.05, 12.5, h + 0.16, z + 0.05, COL.rail, { side: COL.postDark }]);
  }
  return boxes(list);
}

/* ── the scene ───────────────────────────────────────────────────────────── */
export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true, powerPreference: 'high-performance' });
  renderer.setClearColor(COL.grassB, 1);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // our colours are written straight out, as the reference's are
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-6.4, 6.4, 3.6, -3.6, -10, 25);
  camera.rotation.set(-Math.PI / 4, Math.PI / 9, 0, 'YXZ');
  const cam = { x: 2.688232, y: 10.75858, z: 9.5, zoom: 1, xExtra: 0.3, yExtra: 0.5, ready: false };

  let world = null;
  const rows = new Map();           // r -> { group, cars: Mesh[], logs: Map, train, signal, coin }
  const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const ghostMat = litMaterial(0.45);

  function shadow(parent, x0, x1, z0, z1, y) {
    const m = new THREE.Mesh(shadowGeo, SHADOW_MAT);
    m.scale.set(x1 - x0, 1, z1 - z0);
    m.position.set((x0 + x1) / 2, y + 0.004, (z0 + z1) / 2);
    m.renderOrder = 2;
    parent.add(m);
    return m;
  }

  function buildRow(r) {
    const row = world.row(r);
    const prev = world.row(r - 1);
    const g = new THREE.Group();
    g.position.z = -r;
    g.add(new THREE.Mesh(stripGeo(row, prev), MAT));
    const R = { group: g, cars: [], logs: new Map(), train: null, signal: null, coin: null, kind: row.kind };
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
        f.position.set(sx * 7.5, row.h, 0);
        g.add(f);
      }
    } else if (row.kind === 'water' && row.type === 'lily') {
      for (const x of row.lilies) { const m = new THREE.Mesh(lilyGeo(), MAT); m.position.set(x, 0.15, 0); g.add(m); }
    } else if (row.kind === 'rail') {
      const t = new THREE.Mesh(geo('train', trainGeo), MAT);
      t.visible = false;
      t.rotation.y = row.dir > 0 ? 0 : Math.PI;
      g.add(t);
      R.train = t;
      R.trainShadow = shadow(g, -16, 17.9, -0.5, 0.5, row.h);
      R.trainShadow.visible = false;
      const s0 = new THREE.Mesh(geo('signalOff', () => signalGeo(false)), MAT);
      const s1 = new THREE.Mesh(geo('signalOn', () => signalGeo(true)), MAT);
      for (const s of [s0, s1]) { s.position.set(-0.45, row.h, 0.6); g.add(s); }
      s1.visible = false;
      R.signal = [s0, s1];
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x990000, transparent: true, opacity: 0.2, depthWrite: false }));
      glow.position.set(-0.45, 1.5 + row.h, 0.62);
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
        const L = row.car.hx;
        m.userData.sh = shadow(R.group, -L / 2, L / 2 + (row.truck ? 1.32 : 0.96), -0.45, 0.45, row.h);
        R.cars.push(m);
      }
      for (let i = 0; i < R.cars.length; i++) {
        const m = R.cars[i], on = i < xs.length;
        m.visible = on; m.userData.sh.visible = on;
        if (on) { m.position.set(xs[i], row.h, 0); m.userData.sh.position.x = xs[i] + (row.truck ? 0.66 : 0.48); }
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
        m.position.set(L.x, 0.125 - 0.13 + 0.0, 0);
      }
      for (const [k, m] of R.logs) if (!seen.has(k)) { R.group.remove(m); R.logs.delete(k); }
    } else if (row.kind === 'rail') {
      const tr = Sim.trainAt(row, d);
      R.train.visible = tr.cx !== null;
      R.trainShadow.visible = tr.cx !== null;
      if (tr.cx !== null) {
        // The model's middle is 0.95 behind the hit box's centre on its leading side.
        R.train.position.set(tr.cx, row.h, 0);
        R.trainShadow.position.x = tr.cx + 0.95;
      }
      R.signal[0].visible = !tr.warn; R.signal[1].visible = tr.warn;
      R.glow.visible = tr.warn && (Math.floor(d * 6) % 2 === 0);
    }
  }

  /* ── the hoppers ─────────────────────────────────────────────────────── */
  const crit = [0, 1].map(k => {
    const solid = new THREE.Mesh(critterGeo(k), MAT);
    const ghost = new THREE.Mesh(critterGeo(k), ghostMat);
    const holder = new THREE.Group();
    holder.add(solid); holder.add(ghost);
    const sh = shadow(scene, -0.25, 0.25 + 0.95, -0.3, 0.3, 0);
    scene.add(holder);
    return { holder, solid, ghost, sh, squash: new THREE.Vector3(1, 1, 1), quat: new THREE.Quaternion(), visible: false };
  });
  const FACE = { 1: Math.PI * 0, 2: Math.PI, 3: Math.PI / 2, 4: -Math.PI / 2 };
  const eagle = new THREE.Mesh(eagleGeo(), MAT);
  eagle.visible = false;
  scene.add(eagle);

  /* One hopper on screen. b: Sim.bodyAt; face: the move it faced; ghost: drawn see-through (the rival);
     hold: a key is held (the reference squashes 1.2, 0.7, 1.1 while it is down); dead: { type, age } or null. */
  function drawHopper(k, b, face, ghost, hold, dead, dt) {
    const c = crit[k];
    c.visible = true;
    c.holder.visible = true;
    c.solid.visible = !ghost; c.ghost.visible = ghost;
    let sx = 1 + b.arc * 0.5 / 0.95 * 0.1, sy = 1 - b.arc * 0.5 / 0.95 * 0.4, sz = 1;
    if (hold) { sx = 1.2; sy = 0.7; sz = 1.1; }
    let y = b.y;
    if (dead) {
      const a = dead.age;
      if (dead.type === 'car' || dead.type === 'train') { sx = 1 + Math.min(1, a * 10) * 0.6; sy = Math.max(0.05, 1 - a * 10); sz = 1.3; }
      else if (dead.type === 'water' || dead.type === 'log') { y = b.y - Math.min(1.2, a * 1.6); }
      else if (dead.type === 'eagle') { y = b.y + Math.max(0, a - 0.35) * 6; }
    }
    const f = Math.min(0.5, 15 * dt);
    c.squash.x += (sx - c.squash.x) * f; c.squash.y += (sy - c.squash.y) * f; c.squash.z += (sz - c.squash.z) * f;
    if (dead && (dead.type === 'car' || dead.type === 'train')) c.squash.set(sx, sy, sz);
    c.holder.scale.copy(c.squash);
    c.holder.position.set(b.x, y, b.z);
    const want = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, FACE[face] || 0, 0));
    c.holder.quaternion.slerp(want, Math.min(1, dt * 12));
    const ground = world ? (world.row(Math.round(-b.z)) || { h: 0.375 }).h : 0.375;
    c.sh.visible = !(dead && (dead.type === 'water' || dead.type === 'log' || dead.type === 'eagle'));
    c.sh.position.set(b.x + 0.475 + Math.max(0, y - ground) * 0.5, ground + 0.004, b.z);
    c.sh.material = SHADOW_MAT;
  }
  // Each seat's look (shared/crossyLooks.js ids; null = the seat's own: Sprout, Bloop).
  function setLooks(ids) {
    for (let k = 0; k < 2; k++) {
      const id = ids && ids[k] ? ids[k] : k;
      const c = crit[k];
      if (c.look === id) continue;
      c.look = id;
      const g = critterGeo(id);
      c.solid.geometry = g;
      c.ghost.geometry = g;
    }
  }
  function hideHopper(k) { crit[k].holder.visible = false; crit[k].sh.visible = false; }

  /* The eagle swoops from 20 ahead at 30 units a second (the reference's), takes the hopper and flies on. */
  function drawEagle(on, x, z, age) {
    eagle.visible = on;
    if (!on) return;
    const ez = z - 20 + Math.min(age, 1.2) * 30;
    eagle.position.set(x + 0.8, ez > z - 0.2 ? 1.2 + (age - 0.67) * 5 : 2, ez);
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
    camera.left = -3.6 * aspect; camera.right = 3.6 * aspect; camera.top = 3.6; camera.bottom = -3.6;
    camera.updateProjectionMatrix();
  }
  /* Follow: x and z ease toward the target by dt a frame (the reference's lerp(.., .., deltaTime)). A dead hopper's
     camera eases in to 1.5 zoom on it instead. */
  function follow(b, eagleT, dt, dead) {
    const tx = 2.388232 + cam.xExtra + b.x;
    const tz = b.z + 4 + (4 - (eagleT + 0.5));
    cam.y = 10.25858 + cam.yExtra;
    let zoom = cam.zoom;
    if (!cam.ready) { cam.x = tx; cam.z = tz; cam.ready = true; cam.deadZoom = cam.zoom; }
    if (dead) {
      cam.deadZoom += (1.5 - cam.deadZoom) * Math.min(1, dt * 2);
      zoom = cam.deadZoom;
      if (dead.age < 1 && dead.type !== 'log') {
        const k = Math.min(1, dt * 1.5);
        cam.x += (b.x + 2.388232 - cam.x) * k; cam.z += (b.z + 8 - cam.z) * k;
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
    for (const c of crit) c.quat.identity();
  }
  // Coins this screen has seen taken: the row's coin is hidden.
  const taken = new Set();
  function takeCoin(r) { taken.add(r); }
  function resetCoins() { taken.clear(); }

  function render(d, focusRow) {
    if (!world) return;
    const lo = focusRow - 10, hi = focusRow + 20;
    for (const r of [...rows.keys()]) if (r < lo || r > hi) dropRow(r);
    for (let r = Math.max(C.FIRST_ROW, lo); r <= hi; r++) {
      const R = rows.get(r) || buildRow(r);
      updateRow(r, R, d);
      if (R.coin) {
        R.coin.visible = !taken.has(r);
        R.coin.rotation.y = d * 2.4;
      }
    }
    renderer.render(scene, camera);
  }

  return { renderer, scene, camera, resize, follow, render, setWorld, drawHopper, hideHopper, drawEagle, takeCoin, resetCoins, setLooks,
    size: () => ({ w: W, h: H }) };
}
