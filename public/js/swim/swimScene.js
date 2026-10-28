/* ─── Swim: the 3D road ──────────────────────────────────────────────────────
   Draws the race and nothing else: the game page (swimMain.js) owns the
   clock, the netcode, the HUD and the controls, and hands this a picture to
   draw every frame through frame(f).

   WORLD. Metres, as in shared/swimSim.js: x across the road (right +), z down
   it (forward +), y up. Three.js looks down its -z, so a sim point (x, z) is
   drawn at (x, -(z - z0)), where z0 is the followed car's z: a floating
   origin, so a 50 km race is drawn with the same small numbers as the first
   metre.

   TREADMILL. The road, verge, barriers and light poles are one static set of
   meshes inside `ground`, laid out for a BLOCK-metre pattern (lane dashes
   every 12 m, posts every 4 m, poles every 24 m). `ground` sits at
   z0 mod BLOCK, so everything on it is pinned to the world exactly: the
   dashes go by at the car's true speed and never slide. Trees and rocks are
   placed per world slot by a hash, so they never repeat, and are re-laid only
   when the block changes (a few times a second at top speed).

   COST. About 30 draw calls in a race, no shadow maps, no post passes, no
   per-frame allocation: traffic is one instanced mesh per vehicle type for the
   paint and one for the fixed-colour details (glass, tyres, lights), sharing
   one matrix buffer, and every effect is instanced. */
import * as THREE from 'three';

const DEG = Math.PI / 180;
const BLOCK = 48;                // the static pattern repeats every 48 m
/* How far ahead the road is seen, set by the server's horizon (server/swim/swimTraffic.js H_AHEAD
   520): a traffic car is born 60 m past where the fog is solid and drifts into sight, never pops
   in, and is in clear view (under 70% fog, about 370 m) for over 4 s before a car flat out meets it
   in the slowest lane (Owen 2026-10-28: 350 km/h). */
const AHEAD = 465;               // nothing is drawn past this (the fog has it all by 460)
const BEHIND = 16;               // nor further back than this (the camera is 6.5 m back)
const FOG_NEAR = 160, FOG_FAR = 460;
const TRAFFIC_CAP = 72;          // per vehicle type on screen at once
const SHADOW_CAP = 200;
const SCATTER_CAP = 200;
const STREAKS = 64, BURSTS = 24;
const PARTS = 64;

/* ── colours (sRGB hex; THREE.Color converts them to linear) ─────────── */
const C = {
  zenith: 0x1c1942, upper: 0x4a2c68, low: 0xc95a72, horizon: 0xf2a46e, sun: 0xffe2ac,
  hemiSky: 0xffd6bc, hemiGround: 0x46324e, sunLight: 0xffc792,
  glass: 0x1b2532, tyre: 0x141518, trim: 0x202228, tail: 0xff2a1c, head: 0xfff2d4,
  plate: 0xdcd9d0, hub: 0x8d929b, box: 0xd9d5cc,
  rail: 0xaeb3bb, post: 0x5f646c, pole: 0x535860, lampOn: 0xffecc4, housing: 0x3a3d44,
  reflL: 0xffb340, reflR: 0xf6f0e2,
  rock: 0x8c5a45, trunk: 0x4a3627, leaf: 0x5d6c3c,
  sign: 0x1d6a45, signInk: 0xf2f1ea,
  farHill: 0xb46a84, nearHill: 0x6c3b5c, city: 0x3a2d52, window: 0xffc878,
};
/* Ten believable paints, none of them the players' gold or cyan. */
const PAINTS = [0xe9e7e2, 0xb9bec5, 0x5a5f66, 0x1e2126, 0xa3212a, 0x23406e, 0x5b84b1, 0x2f5a43, 0xcbb68e, 0x6b2430];
const SIDE_PAINT = [0xe8b84a, 0x4fc3d9];
const SIDE_STREAK = [0xffd27e, 0x9ef0ff];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const ease = (dt, k) => 1 - Math.exp(-dt * k);

function hash(k, salt) {
  let h = (Math.imul(k | 0, 0x9E3779B1) ^ Math.imul((salt | 0) + 0x632BE5AB, 0x85EBCA77)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── geometry built in code ──────────────────────────────────────────────
   Non-indexed triangles with one colour and one `glow` (0 lit, 1 drawn at
   full colour, for lamps) per vertex, so every face gets its own normal:
   flat shading for free. Convex parts are wound outward automatically. */
const _c = new THREE.Color();
class Mesher {
  constructor() { this.p = []; this.c = []; this.g = []; }
  tri(a, b, c, hex, glow, o) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-14) return;
    if (o) {
      const mx = (a[0] + b[0] + c[0]) / 3 - o[0], my = (a[1] + b[1] + c[1]) / 3 - o[1], mz = (a[2] + b[2] + c[2]) / 3 - o[2];
      if (nx * mx + ny * my + nz * mz < 0) { const t = b; b = c; c = t; }
    }
    _c.set(hex);
    for (const q of [a, b, c]) { this.p.push(q[0], q[1], q[2]); this.c.push(_c.r, _c.g, _c.b); this.g.push(glow); }
  }
  quad(a, b, c, d, hex, glow, o) { this.tri(a, b, c, hex, glow, o); this.tri(a, c, d, hex, glow, o); }
  /* A six-sided block from a bottom rectangle to a top one: boxes, tapers, wedges. */
  hexa(xl0, xr0, zf0, zb0, y0, xl1, xr1, zf1, zb1, y1, hex, glow) {
    const b0 = [xl0, y0, zf0], b1 = [xr0, y0, zf0], b2 = [xr0, y0, zb0], b3 = [xl0, y0, zb0];
    const t0 = [xl1, y1, zf1], t1 = [xr1, y1, zf1], t2 = [xr1, y1, zb1], t3 = [xl1, y1, zb1];
    const o = [(xl0 + xr0 + xl1 + xr1) / 4, (y0 + y1) / 2, (zf0 + zb0 + zf1 + zb1) / 4];
    this.quad(b0, b1, b2, b3, hex, glow, o); this.quad(t0, t1, t2, t3, hex, glow, o);
    this.quad(b0, b1, t1, t0, hex, glow, o); this.quad(b3, b2, t2, t3, hex, glow, o);
    this.quad(b0, b3, t3, t0, hex, glow, o); this.quad(b1, b2, t2, t1, hex, glow, o);
  }
  /* Centred on x = cx: width w0 at the bottom, w1 at the top; z front/back per level. */
  part(w0, w1, zf0, zb0, zf1, zb1, y0, y1, hex, glow, cx = 0) {
    this.hexa(cx - w0 / 2, cx + w0 / 2, zf0, zb0, y0, cx - w1 / 2, cx + w1 / 2, zf1, zb1, y1, hex, glow);
  }
  box(cx, cy, cz, w, h, d, hex, glow = 0) {
    this.hexa(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, cy - h / 2, cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, cy + h / 2, hex, glow);
  }
  /* A wheel: an n-sided prism along x. */
  cylX(cx, cy, cz, r, w, n, hex, glow = 0) {
    const o = [cx, cy, cz], x0 = cx - w / 2, x1 = cx + w / 2;
    for (let i = 0; i < n; i++) {
      const a0 = (i + 0.5) / n * Math.PI * 2, a1 = (i + 1.5) / n * Math.PI * 2;
      const y0 = cy + r * Math.cos(a0), z0 = cz + r * Math.sin(a0), y1 = cy + r * Math.cos(a1), z1 = cz + r * Math.sin(a1);
      this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z1], [x0, y1, z1], hex, glow, o);
      this.tri([x0, cy, cz], [x0, y0, z0], [x0, y1, z1], hex, glow, o);
      this.tri([x1, cy, cz], [x1, y0, z0], [x1, y1, z1], hex, glow, o);
    }
  }
  /* Any three.js geometry, transformed; its own winding is kept. */
  geo(g, m, hex, glow = 0, shade) {
    const src = g.index ? g.toNonIndexed() : g;
    const p = src.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      this.p.push(v.x, v.y, v.z);
      _c.set(hex);
      if (shade) { const k = shade(v); _c.r *= k; _c.g *= k; _c.b *= k; }
      this.c.push(_c.r, _c.g, _c.b); this.g.push(glow);
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('glow', new THREE.Float32BufferAttribute(this.g, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/* Lambert with a per-vertex `glow`: lamps and lenses keep their full colour
   whatever the light, and still sink into the fog with the rest. */
function litMaterial(params) {
  const m = new THREE.MeshLambertMaterial(Object.assign({ vertexColors: true }, params));
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;')
      .replace('#include <color_vertex>', '#include <color_vertex>\n\tvGlow = glow;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;')
      .replace('#include <opaque_fragment>', 'outgoingLight = mix(outgoingLight, diffuseColor.rgb, vGlow);\n\t#include <opaque_fragment>');
  };
  m.customProgramCacheKey = () => 'swimGlow';
  return m;
}

/* ── the players' cars: three of our own, picked in Customize ────────────
   Front is -z. Paint parts are white (the material carries the colour).
   LOOKS ONLY: all three are drawn on the same footprint (about 4.3 m long,
   1.8 m wide) and race on the same hitbox and handling, because nothing in
   shared/swimSim.js reads a look; the server keeps only the listed ids
   (shared/swimLooks.js). They share the lamp anchors the indicators, brake
   lamps and exhaust flames are built on (tail lights at y 0.70 on the tail,
   pipes at x 0.42, y 0.36), so every lamp lands on every car. Original
   shapes, no maker's design, no badges.

   The supercar: a low wedge with a wing (the gold car Swim always had). */
function buildSupercar() {
  const P = 0xffffff, paint = new Mesher(), det = new Mesher();
  paint.part(1.80, 1.74, -2.08, 2.10, -1.22, 2.14, 0.30, 0.80, P, 0);      // body, long sloped nose
  paint.part(1.76, 1.66, 0.55, 2.13, 0.95, 2.08, 0.80, 0.92, P, 0);        // rear deck
  paint.part(1.20, 1.10, -0.30, 0.74, -0.24, 0.66, 1.12, 1.18, P, 0);      // roof
  paint.part(1.76, 1.76, 1.80, 2.12, 1.86, 2.16, 1.03, 1.09, P, 0);        // wing
  for (const s of [-1, 1]) paint.box(s * 0.92, 0.88, -0.55, 0.14, 0.08, 0.16, P, 0);  // mirrors
  det.part(1.58, 1.16, -0.98, 1.08, -0.30, 0.70, 0.80, 1.13, C.glass, 0);  // glasshouse
  for (const s of [-1, 1]) {
    det.box(s * 0.55, 0.97, 1.98, 0.06, 0.14, 0.18, C.trim, 0);            // wing struts
    det.box(s * 0.89, 1.03, 1.98, 0.03, 0.20, 0.40, C.trim, 0);            // end plates
    det.box(s * 0.56, 0.70, 2.13, 0.52, 0.11, 0.08, C.tail, 1);            // tail lights
    det.box(s * 0.42, 0.36, 2.17, 0.16, 0.08, 0.05, 0x2b2b30, 0);          // exhausts
    det.box(s * 0.56, 0.58, -1.66, 0.42, 0.07, 0.30, C.head, 1);           // headlights
    det.box(s * 0.91, 0.35, 0, 0.05, 0.10, 1.9, C.trim, 0);                // side skirts
    for (const z of [-1.33, 1.32]) {
      det.cylX(s * 0.79, 0.33, z, 0.33, 0.27, 10, C.tyre);
      det.cylX(s * 0.93, 0.33, z, 0.20, 0.02, 10, C.hub);
    }
  }
  det.box(0, 0.70, 2.135, 0.62, 0.035, 0.06, C.tail, 0.85);                // light bar
  det.part(1.66, 1.70, 1.86, 2.12, 1.90, 2.17, 0.24, 0.44, C.trim, 0);     // diffuser
  det.box(0, 0.53, 2.125, 0.40, 0.10, 0.04, C.plate, 0.3);                 // plate
  det.part(1.74, 1.70, -2.18, -1.90, -2.14, -1.90, 0.24, 0.34, C.trim, 0); // splitter
  return { paint: paint.build(), det: det.build() };
}

/* The muscle car: a long hood with a scoop, the cabin set well back, a short
   ducktail, wide hips and a flat nose. */
function buildMuscle() {
  const P = 0xffffff, paint = new Mesher(), det = new Mesher();
  paint.part(1.82, 1.80, -2.14, 2.13, -2.10, 2.11, 0.30, 0.80, P, 0);      // body, a slab with a flat nose
  paint.part(0.66, 0.54, -1.98, -0.70, -1.90, -0.76, 0.80, 0.87, P, 0);    // power dome down the hood
  paint.part(1.76, 1.72, 0.78, 2.11, 0.86, 2.09, 0.80, 0.88, P, 0);        // rear deck
  paint.part(1.70, 1.70, 1.96, 2.13, 2.02, 2.15, 0.88, 0.95, P, 0);        // ducktail
  paint.part(1.26, 1.18, 0.02, 0.86, 0.08, 0.80, 1.14, 1.19, P, 0);        // roof, set back
  for (const s of [-1, 1]) {
    paint.box(s * 0.865, 0.50, -1.38, 0.11, 0.34, 0.98, P, 0);             // front haunch
    paint.box(s * 0.875, 0.52, 1.30, 0.13, 0.38, 1.08, P, 0);              // rear haunch, wider
    paint.box(s * 0.92, 0.90, -0.42, 0.14, 0.08, 0.16, P, 0);              // mirrors
  }
  det.part(1.62, 1.22, -0.52, 1.30, 0.02, 0.84, 0.80, 1.14, C.glass, 0);   // glasshouse, fastback rake
  det.part(0.40, 0.30, -1.56, -1.06, -1.46, -1.12, 0.87, 0.95, C.trim, 0); // hood scoop
  det.box(0, 0.58, -2.15, 1.34, 0.22, 0.04, C.trim, 0);                    // grille, full width
  det.part(1.84, 1.84, -2.22, -2.06, -2.22, -2.06, 0.26, 0.40, C.trim, 0); // front bumper
  det.part(1.84, 1.84, 2.06, 2.20, 2.06, 2.20, 0.26, 0.42, C.trim, 0);     // rear bumper
  for (const s of [-1, 1]) {
    det.box(s * 0.66, 0.60, -2.17, 0.22, 0.15, 0.04, C.head, 1);           // headlights in the grille
    det.box(s * 0.56, 0.70, 2.13, 0.52, 0.11, 0.08, C.tail, 1);            // tail lights
    det.box(s * 0.42, 0.36, 2.21, 0.20, 0.10, 0.06, 0x2b2b30, 0);          // big twin pipes
    det.box(s * 0.92, 0.35, 0, 0.05, 0.10, 1.7, C.trim, 0);                // sills
    for (const z of [-1.40, 1.30]) {
      const r = z > 0 ? 0.36 : 0.34;
      det.cylX(s * 0.80, r, z, r, 0.30, 10, C.tyre);
      det.cylX(s * 0.955, r, z, r * 0.6, 0.02, 10, C.hub);
    }
  }
  det.box(0, 0.70, 2.135, 0.62, 0.11, 0.06, C.tail, 0.85);                 // tail lights run the full width
  det.box(0, 0.53, 2.125, 0.40, 0.10, 0.04, C.plate, 0.3);                 // plate
  return { paint: paint.build(), det: det.build() };
}

/* The hot hatch: short hood, a tall cabin, a raked hatch glass under a roof
   spoiler, and boxy arches. */
function buildHatch() {
  const P = 0xffffff, paint = new Mesher(), det = new Mesher();
  paint.part(1.80, 1.76, -2.06, 2.08, -1.92, 2.08, 0.30, 0.88, P, 0);      // body
  paint.part(1.72, 1.64, -1.92, -0.92, -1.86, -0.88, 0.88, 0.94, P, 0);    // short hood
  paint.part(1.52, 1.46, -0.30, 1.42, -0.26, 1.38, 1.36, 1.42, P, 0);      // roof
  paint.part(1.46, 1.42, 1.26, 1.60, 1.32, 1.66, 1.40, 1.47, P, 0);        // roof spoiler
  for (const s of [-1, 1]) {
    paint.box(s * 0.865, 0.50, -1.36, 0.11, 0.36, 0.92, P, 0);             // front arch
    paint.box(s * 0.865, 0.51, 1.34, 0.11, 0.36, 0.92, P, 0);              // rear arch
    paint.box(s * 0.93, 0.90, -0.56, 0.14, 0.09, 0.16, P, 0);              // mirrors
  }
  det.part(1.68, 1.50, -0.90, 2.04, -0.30, 1.44, 0.92, 1.36, C.glass, 0);  // glasshouse, steep screen, raked hatch
  det.box(0, 0.62, -2.07, 1.10, 0.18, 0.04, C.trim, 0);                    // grille
  det.part(1.82, 1.82, -2.12, -1.98, -2.12, -1.98, 0.26, 0.42, C.trim, 0); // front bumper
  det.part(1.70, 1.70, 2.04, 2.16, 2.04, 2.16, 0.26, 0.40, C.trim, 0);     // rear bumper
  det.box(0, 0.70, 2.125, 0.62, 0.11, 0.04, C.trim, 0);                    // tail panel (the third lamp lights on it)
  for (const s of [-1, 1]) {
    det.box(s * 0.62, 0.76, -1.95, 0.34, 0.12, 0.10, C.head, 1);           // headlights
    det.box(s * 0.56, 0.70, 2.11, 0.52, 0.13, 0.08, C.tail, 1);            // tail lights
    det.box(s * 0.42, 0.36, 2.19, 0.16, 0.10, 0.05, 0x2b2b30, 0);          // pipes
    det.box(s * 0.91, 0.35, 0, 0.05, 0.10, 1.8, C.trim, 0);                // sills
    for (const z of [-1.36, 1.34]) {
      det.cylX(s * 0.79, 0.33, z, 0.33, 0.27, 10, C.tyre);
      det.cylX(s * 0.93, 0.33, z, 0.21, 0.02, 10, C.hub);
    }
  }
  det.box(0, 0.53, 2.125, 0.40, 0.10, 0.04, C.plate, 0.3);                 // plate
  return { paint: paint.build(), det: det.build() };
}

/* ── traffic: one model per SwimSim.TYPES entry, sized from it ───────── */
function carShape(T, p) {
  const P = 0xffffff, paint = new Mesher(), det = new Mesher();
  const hl = T.L / 2, hw = T.W / 2, W = T.W, H = T.H;
  paint.part(W, W - 0.06, -hl + 0.04, hl - 0.04, -hl + p.nose, hl - p.tail, p.y0, p.yb, P, 0);
  det.part(W * p.gw0, W * p.gw1, p.cf0, p.cb0, p.cf1, p.cb1, p.yb, H - 0.07, C.glass, 0);
  paint.part(W * p.gw1 + 0.05, W * p.gw1, p.cf1 - 0.03, p.cb1 + 0.03, p.cf1 + 0.02, p.cb1 - 0.02, H - 0.08, H, P, 0);
  /* where the sloped tail and nose surfaces are, at a height */
  const tailZ = (y) => hl - 0.04 - (y - p.y0) / (p.yb - p.y0) * (p.tail - 0.04);
  const noseZ = (y) => -hl + 0.04 + (y - p.y0) / (p.yb - p.y0) * (p.nose - 0.04);
  const ly = p.y0 + (p.yb - p.y0) * 0.72;
  for (const s of [-1, 1]) {
    det.box(s * (hw - 0.22), ly, tailZ(ly) + 0.01, 0.36, p.lamp, 0.12, C.tail, 1);
    det.box(s * (hw - 0.24), ly, noseZ(ly) - 0.01, 0.34, 0.09, 0.12, C.head, 1);
    for (const z of [-(hl - p.wz), hl - p.wz]) det.cylX(s * (hw - 0.13), p.r, z, p.r, 0.24, 8, C.tyre);
  }
  det.part(W - 0.02, W - 0.02, hl - 0.3, hl + 0.03, hl - 0.3, hl + 0.03, p.y0 - 0.06, p.y0 + 0.14, C.trim, 0);
  det.part(W - 0.02, W - 0.02, -hl - 0.03, -hl + 0.3, -hl - 0.03, -hl + 0.3, p.y0 - 0.06, p.y0 + 0.14, C.trim, 0);
  const py = p.y0 + 0.24;
  det.box(0, py, tailZ(py) + 0.01, 0.42, 0.11, 0.08, C.plate, 0.3);
  return { paint, det };
}
function buildVan(T) {
  const P = 0xffffff, paint = new Mesher(), det = new Mesher();
  const hl = T.L / 2, hw = T.W / 2, W = T.W, H = T.H;
  paint.part(W, W, -hl + 0.05, hl, -hl + 0.35, hl, 0.36, 1.1, P, 0);
  paint.part(W - 0.04, W - 0.04, -hl + 0.75, hl, -hl + 1.35, hl - 0.02, 1.1, H, P, 0);
  const sz = (y) => -hl + 0.75 + (y - 1.1) / (H - 1.1) * 0.6;
  det.part(W - 0.3, W - 0.3, sz(1.2) - 0.03, sz(1.2) + 0.02, sz(1.95) - 0.03, sz(1.95) + 0.02, 1.2, 1.95, C.glass, 0);
  for (const s of [-1, 1]) {
    det.box(s * (hw - 0.01), 1.58, -hl + 1.75, 0.04, 0.55, 0.85, C.glass, 0);
    det.box(s * 0.46, 1.68, hl + 0.005, 0.72, 0.42, 0.03, C.glass, 0);
    det.box(s * (hw - 0.12), 0.98, hl + 0.01, 0.17, 0.46, 0.05, C.tail, 1);
    det.box(s * (hw - 0.25), 0.82, -hl + 0.12, 0.34, 0.1, 0.1, C.head, 1);
    for (const z of [-(hl - 0.95), hl - 0.95]) det.cylX(s * (hw - 0.14), 0.36, z, 0.36, 0.26, 8, C.tyre);
  }
  det.box(0, 1.58, hl + 0.006, 0.04, 1.0, 0.03, C.trim, 0);
  det.box(0, 0.36, hl + 0.02, W - 0.02, 0.22, 0.12, C.trim, 0);
  det.box(0, 0.36, -hl + 0.04, W - 0.02, 0.22, 0.12, C.trim, 0);
  det.box(0, 0.6, hl + 0.01, 0.44, 0.11, 0.04, C.plate, 0.3);
  return { paint, det };
}
function buildTruck(T) {
  const P = 0xffffff, paint = new Mesher(), det = new Mesher();
  const hl = T.L / 2, hw = T.W / 2, W = T.W, H = T.H;
  paint.part(W - 0.1, W - 0.2, -hl, -hl + 2.2, -hl + 0.2, -hl + 2.2, 0.55, 2.95, P, 0);         // cab
  paint.part(W - 0.2, W - 0.5, -hl + 0.3, -hl + 2.2, -hl + 1.0, -hl + 2.2, 2.95, 3.22, P, 0);  // roof fairing
  det.box(0, 2.1, -hl + 0.1, W - 0.5, 0.9, 0.06, C.glass, 0);
  det.part(W, W, -hl + 2.4, hl, -hl + 2.4, hl, 1.05, H, C.box, 0);                              // box body
  det.box(0, 0.82, 0.6, 1.0, 0.36, T.L - 1.2, C.trim, 0);                                       // chassis
  det.box(0, 0.62, hl - 0.06, W - 0.2, 0.14, 0.12, C.trim, 0);                                  // under-run bar
  det.box(0, 2.15, hl + 0.006, 0.05, 2.1, 0.03, 0x9a978f, 0);                                   // door seam
  det.box(0, 1.12, hl + 0.006, W - 0.1, 0.06, 0.03, 0x9a978f, 0);
  for (const s of [-1, 1]) {
    det.box(s * (W - 0.1) / 2, 2.2, -hl + 1.2, 0.05, 0.75, 0.9, C.glass, 0);
    det.box(s * (hw - 0.32), 0.84, hl - 0.02, 0.38, 0.15, 0.08, C.tail, 1);
    det.box(s * (hw - 0.1), H - 0.1, hl + 0.01, 0.1, 0.07, 0.04, 0xffa030, 1);
    det.box(s * (hw - 0.3), 1.0, -hl - 0.01, 0.36, 0.14, 0.06, C.head, 1);
    det.box(s * 0.6, 2.15, hl + 0.006, 0.04, 1.9, 0.03, 0x9a978f, 0);
    for (const z of [-hl + 1.25, hl - 1.3, hl - 2.45]) det.cylX(s * (hw - 0.3), 0.5, z, 0.5, 0.5, 8, C.tyre);
  }
  return { paint, det };
}
function buildBus(T) {
  const P = 0xffffff, paint = new Mesher(), det = new Mesher();
  const hl = T.L / 2, hw = T.W / 2, W = T.W, H = T.H;
  paint.part(W, W - 0.08, -hl + 0.1, hl, -hl + 0.3, hl - 0.05, 0.38, H, P, 0);
  det.box(0, H + 0.08, 0.5, 1.2, 0.18, 2.6, 0xc9c6bf, 0);
  det.box(0, 2.0, -hl + 0.19, W - 0.3, 1.7, 0.06, C.glass, 0);
  det.box(0, 2.3, hl - 0.015, W - 0.6, 0.85, 0.06, C.glass, 0);
  det.box(0, 0.48, hl + 0.02, W - 0.04, 0.22, 0.1, C.trim, 0);
  det.box(0, 0.75, hl + 0.01, 0.48, 0.12, 0.04, C.plate, 0.3);
  for (const s of [-1, 1]) {
    det.box(s * (hw - 0.012), 2.05, 0.0, 0.05, 1.2, T.L - 1.5, C.glass, 0);
    det.box(s * (hw - 0.15), 1.0, hl + 0.01, 0.2, 0.62, 0.06, C.tail, 1);
    det.box(s * (hw - 0.35), 0.75, -hl + 0.09, 0.4, 0.14, 0.08, C.head, 1);
    for (const z of [-hl + 2.5, hl - 3.0]) det.cylX(s * (hw - 0.28), 0.5, z, 0.5, 0.42, 8, C.tyre);
  }
  return { paint, det };
}
function buildTrafficModel(T) {
  let m;
  if (T.id === 'sedan') m = carShape(T, { y0: 0.30, yb: 0.80, nose: 0.55, tail: 0.30, cf0: -0.95, cb0: 1.15, cf1: -0.30, cb1: 0.72, gw0: 0.88, gw1: 0.70, r: 0.31, wz: 0.80, lamp: 0.13 });
  else if (T.id === 'hatch') m = carShape(T, { y0: 0.30, yb: 0.84, nose: 0.50, tail: 0.12, cf0: -0.75, cb0: 1.70, cf1: -0.15, cb1: 1.55, gw0: 0.88, gw1: 0.72, r: 0.30, wz: 0.65, lamp: 0.2 });
  else if (T.id === 'suv') m = carShape(T, { y0: 0.40, yb: 1.02, nose: 0.45, tail: 0.12, cf0: -0.95, cb0: 2.15, cf1: -0.35, cb1: 2.00, gw0: 0.90, gw1: 0.78, r: 0.37, wz: 0.85, lamp: 0.2 });
  else if (T.id === 'van') m = buildVan(T);
  else if (T.id === 'truck') m = buildTruck(T);
  else if (T.id === 'bus') m = buildBus(T);
  else m = carShape(T, { y0: 0.30, yb: 0.80, nose: 0.5, tail: 0.3, cf0: -T.L * 0.2, cb0: T.L * 0.25, cf1: -T.L * 0.06, cb1: T.L * 0.16, gw0: 0.88, gw1: 0.7, r: 0.31, wz: 0.8, lamp: 0.13 });
  return { paint: m.paint.build(), det: m.det.build() };
}

/* ── textures drawn on canvases ──────────────────────────────────────── */
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
/* The road across x = -10..10 m and 12 m along: asphalt, worn tracks, lane
   dashes (3 m on, 9 m off), a yellow left edge, a white right edge, gravel. */
function roadTexture(aniso) {
  const W = 1024, H = 640, cv = canvas(W, H), g = cv.getContext('2d'), rnd = mulberry(11);
  const pxm = W / 20, X = (m) => (m + 10) * pxm, pzm = H / 12;
  g.fillStyle = '#6b5246'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(30,18,16,0.35)' : 'rgba(210,170,140,0.18)';
    g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 3, 1 + rnd() * 3);
  }
  g.fillStyle = '#3d3b45'; g.fillRect(X(-8), 0, X(8) - X(-8), H);
  g.fillStyle = '#46434d'; g.fillRect(X(-8), 0, X(-7.2) - X(-8), H); g.fillRect(X(7.2), 0, X(8) - X(7.2), H);
  for (let i = 0; i < 4; i++) {
    const lx = -5.4 + i * 3.6;
    g.fillStyle = 'rgba(14,12,20,0.16)';
    for (const o of [-0.85, 0.85]) g.fillRect(X(lx + o - 0.3), 0, 0.6 * pxm, H);
  }
  for (let i = 0; i < 30000; i++) {
    const x = X(-8) + rnd() * (X(8) - X(-8)), y = rnd() * H, s = 1 + rnd() * 2.2;
    g.fillStyle = rnd() < 0.55 ? `rgba(0,0,0,${0.10 + rnd() * 0.16})` : `rgba(255,236,226,${0.04 + rnd() * 0.07})`;
    g.fillRect(x, y, s, s);
  }
  for (let i = 0; i < 40; i++) {           // tar seams and patches
    g.fillStyle = `rgba(18,16,22,${0.12 + rnd() * 0.12})`;
    g.fillRect(X(-8) + rnd() * 16 * pxm, rnd() * H, (0.4 + rnd() * 2.5) * pxm, (0.05 + rnd() * 0.12) * pzm);
  }
  g.fillStyle = '#ece6da';
  for (const lx of [-3.6, 0, 3.6]) g.fillRect(X(lx - 0.075), 0, 0.15 * pxm, 3 * pzm);
  g.fillStyle = '#e8b648'; g.fillRect(X(-7.15), 0, 0.15 * pxm, H);
  g.fillStyle = '#ece6da'; g.fillRect(X(7.0), 0, 0.15 * pxm, H);
  for (let i = 0; i < 5000; i++) {           // paint wear
    g.fillStyle = 'rgba(40,38,46,0.35)';
    g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}
/* Desert sand, 24 m square, tiling. */
function sandTexture(aniso) {
  const S = 256, cv = canvas(S, S), g = cv.getContext('2d'), rnd = mulberry(23);
  g.fillStyle = '#946650'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 70; i++) {
    const x = rnd() * S, y = rnd() * S, r = 10 + rnd() * 40, dark = rnd() < 0.55;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, dark ? 'rgba(70,40,40,0.20)' : 'rgba(200,150,110,0.16)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(50,28,26,0.25)' : 'rgba(230,190,150,0.16)';
    g.fillRect(rnd() * S, rnd() * S, 1, 1);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}
function blobTexture(stops) {
  const S = 64, cv = canvas(S, S), g = cv.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  for (const [o, c] of stops) gr.addColorStop(o, c);
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ── the scene ─────────────────────────────────────────────────────────
   opts: { sim (default window.SwimSim), touch (a phone: lower caps),
   maxPixelRatio (1.5), antialias (default off on touch), adaptive (true:
   drops the pixel ratio a step at a time if frames stay slow) } */
export function createScene(canvasEl, opts = {}) {
  const S = opts.sim || (typeof window !== 'undefined' ? window.SwimSim : null);
  if (!S) throw new Error('swimScene: SwimSim is not loaded');
  const phone = opts.touch != null ? !!opts.touch
    : (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  const maxDpr = opts.maxPixelRatio || 1.5;
  const minDpr = phone ? 1 : 0.75;
  const adaptive = opts.adaptive !== false;

  const renderer = new THREE.WebGLRenderer({
    canvas: canvasEl, antialias: opts.antialias != null ? !!opts.antialias : !phone,
    powerPreference: 'high-performance', alpha: false, stencil: false,
  });
  renderer.info.autoReset = false;
  const aniso = Math.min(phone ? 4 : 8, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  const fogCol = new THREE.Color(C.horizon);
  scene.background = fogCol.clone();
  scene.fog = new THREE.Fog(fogCol.clone(), FOG_NEAR, FOG_FAR);
  const camera = new THREE.PerspectiveCamera(62, 1, 0.5, 1300);
  scene.add(camera);

  scene.add(new THREE.HemisphereLight(C.hemiSky, C.hemiGround, 1.9));
  const sunLight = new THREE.DirectionalLight(C.sunLight, 1.9);
  sunLight.position.set(-0.45, 0.62, 0.66);   // from behind and above: the backs we look at are lit
  scene.add(sunLight);

  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };

  /* sky: a gradient dome with a low sun ahead, drawn last at the far plane
     so only the pixels nothing else covered pay for it */
  const sunDir = new THREE.Vector3(-0.33, 0.06, -1).normalize();
  const skyMat = keep(new THREE.ShaderMaterial({
    uniforms: {
      cTop: { value: new THREE.Color(C.zenith) }, cUp: { value: new THREE.Color(C.upper) },
      cLow: { value: new THREE.Color(C.low) }, cHor: { value: fogCol.clone() },
      cSun: { value: new THREE.Color(C.sun) }, sunDir: { value: sunDir },
    },
    vertexShader: 'varying vec3 vDir;\nvoid main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = vec4(p.xy, p.w * 0.99999, p.w); }',
    fragmentShader: [
      'uniform vec3 cTop, cUp, cLow, cHor, cSun; uniform vec3 sunDir; varying vec3 vDir;',
      'void main(){',
      '  vec3 d = normalize(vDir); float h = max(d.y, 0.0);',
      '  vec3 col = mix(cHor, cLow, smoothstep(0.0, 0.10, h));',
      '  col = mix(col, cUp, smoothstep(0.08, 0.34, h));',
      '  col = mix(col, cTop, smoothstep(0.30, 0.95, h));',
      '  float s = max(dot(d, sunDir), 0.0);',
      '  col += cSun * (smoothstep(0.99935, 0.99965, s) * 1.2 + pow(s, 90.0) * 0.45 + pow(s, 10.0) * 0.14);',
      '  gl_FragColor = vec4(col, 1.0);',
      '  #include <tonemapping_fragment>',
      '  #include <colorspace_fragment>',
      '}'].join('\n'),
    depthWrite: false, fog: false,
  }));
  const sky = new THREE.Mesh(keep(new THREE.SphereGeometry(50, 32, 16)), skyMat);
  sky.material.side = THREE.BackSide;
  sky.frustumCulled = false; sky.renderOrder = 10;
  scene.add(sky);

  let backdrop = null;
  /* far backdrop: two ridges of mesas and a city on the right, at "infinity"
     (they follow the camera), fog-coloured at the foot like distant haze */
  {
    const pos = [], col = [], cb = new THREE.Color(), ct = new THREE.Color();
    const v = (phi, R, y, c) => { pos.push(R * Math.sin(phi), y, -R * Math.cos(phi)); col.push(c.r, c.g, c.b); };
    const strip = (p0, p1, R, yb, h0, h1, c0, c1) => {
      v(p0, R, yb, c0); v(p1, R, yb, c0); v(p1, R, h1, c1);
      v(p0, R, yb, c0); v(p1, R, h1, c1); v(p0, R, h0, c1);
    };
    const N = 180, A = 2.1;
    const farH = (p) => Math.max(8, 30 + 16 * Math.sin(3 * p + 1) + 9 * Math.sin(7.3 * p + 2) + 5 * Math.sin(15 * p));
    const cityGap = (p) => 1 - smooth(0.22, 0.30, p) * (1 - smooth(0.62, 0.70, p));
    const nearH = (p) => {
      const n = 0.6 * Math.sin(2.3 * p + 0.5) + 0.3 * Math.sin(5.1 * p + 1.3) + 0.12 * Math.sin(11 * p);
      return (4 + 50 * smooth(0.05, 0.3, n) * (0.85 + 0.15 * Math.sin(17 * p))) * cityGap(p);
    };
    cb.copy(fogCol); ct.copy(fogCol).lerp(new THREE.Color(C.farHill), 0.32);
    for (let i = 0; i < N; i++) { const p0 = -A + 2 * A * i / N, p1 = -A + 2 * A * (i + 1) / N; strip(p0, p1, 1000, -2, farH(p0), farH(p1), cb, ct); }
    const cityTop = fogCol.clone().lerp(new THREE.Color(C.city), 0.5), cityFoot = fogCol.clone().lerp(new THREE.Color(C.city), 0.22);
    const win = new THREE.Color(C.window).lerp(fogCol, 0.25), red = new THREE.Color(0xff3020);
    const rnd = mulberry(5);
    for (let p = 0.30; p < 0.62;) {
      const w = 0.012 + rnd() * 0.02, mid = 1 - Math.abs(p - 0.46) / 0.18;
      const h = 22 + rnd() * 30 + 55 * Math.max(0, mid) * rnd();
      strip(p, p + w, 920, -2, h, h, cityFoot, cityTop);
      for (let y = 8; y < h - 4; y += 6) for (let q = p + 0.003; q < p + w - 0.003; q += 0.0055) {
        if (rnd() < 0.2) strip(q, q + 0.0026, 919, y, y + 2.2, y + 2.2, win, win);
      }
      if (h > 70) strip(p + w / 2 - 0.0015, p + w / 2 + 0.0015, 918, h + 1, h + 3.5, h + 3.5, red, red);
      p += w + rnd() * 0.004;
    }
    cb.copy(fogCol); ct.copy(fogCol).lerp(new THREE.Color(C.nearHill), 0.55);
    for (let i = 0; i < N; i++) { const p0 = -A + 2 * A * i / N, p1 = -A + 2 * A * (i + 1) / N; strip(p0, p1, 760, -2, nearH(p0), nearH(p1), cb, ct); }
    const g = keep(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    backdrop = new THREE.Mesh(g, keep(new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide })));
    backdrop.frustumCulled = false; backdrop.renderOrder = 9;
    scene.add(backdrop);
  }

  /* the treadmill: everything pinned to the world in a 48 m pattern */
  const ground = new THREE.Group();
  scene.add(ground);
  const Z_BACK = BLOCK, Z_FRONT = -(AHEAD + BLOCK + 24);         // local z range the static set covers
  {
    // road and gravel, x -10..10; v counts 12 m periods of world z
    const rg = keep(new THREE.BufferGeometry()), rp = [], ru = [];
    const segs = 24, len = Z_BACK - (-744);
    for (let i = 0; i < segs; i++) {
      const za = Z_BACK - len * i / segs, zb = Z_BACK - len * (i + 1) / segs;
      rp.push(-10, 0, za, 10, 0, za, 10, 0, zb, -10, 0, za, 10, 0, zb, -10, 0, zb);
      ru.push(0, -za / 12, 1, -za / 12, 1, -zb / 12, 0, -za / 12, 1, -zb / 12, 0, -zb / 12);
    }
    rg.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
    rg.setAttribute('uv', new THREE.Float32BufferAttribute(ru, 2));
    const road = new THREE.Mesh(rg, keep(new THREE.MeshBasicMaterial({ map: keep(roadTexture(aniso)) })));
    road.frustumCulled = false;
    ground.add(road);
    // sand either side, 24 m tiles
    const sg = keep(new THREE.BufferGeometry()), sp = [], su = [];
    for (const [x0, x1] of [[-700, -10], [10, 700]]) {
      const za = Z_BACK, zb = -744;
      sp.push(x0, 0, za, x1, 0, za, x1, 0, zb, x0, 0, za, x1, 0, zb, x0, 0, zb);
      su.push(x0 / 24, -za / 24, x1 / 24, -za / 24, x1 / 24, -zb / 24, x0 / 24, -za / 24, x1 / 24, -zb / 24, x0 / 24, -zb / 24);
    }
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    sg.setAttribute('uv', new THREE.Float32BufferAttribute(su, 2));
    const sand = new THREE.Mesh(sg, keep(new THREE.MeshBasicMaterial({ map: keep(sandTexture(aniso)) })));
    sand.frustumCulled = false;
    ground.add(sand);
  }
  const propMat = keep(litMaterial({}));
  {
    // barriers (posts every 4 m, reflectors every 12 m) and light poles (every 24 m, alternate sides)
    const m = new Mesher(), len = Z_BACK - Z_FRONT, mid = (Z_BACK + Z_FRONT) / 2;
    for (const s of [-1, 1]) {
      m.box(s * 7.72, 0.58, mid, 0.10, 0.34, len, C.rail);
      m.box(s * 7.665, 0.58, mid, 0.03, 0.07, len, 0x7c8189);
      for (let z = Z_BACK; z >= Z_FRONT; z -= 4) m.box(s * 7.84, 0.40, z, 0.12, 0.80, 0.14, C.post);
      for (let z = Z_BACK; z >= Z_FRONT; z -= 12) m.box(s * 7.655, 0.66, z, 0.03, 0.06, 0.12, s < 0 ? C.reflL : C.reflR, 1);
    }
    for (let z = Z_BACK; z >= Z_FRONT; z -= 24) {
      const s = (Math.round(z / 24) & 1) ? 1 : -1;
      m.box(s * 9.5, 4.9, z, 0.22, 9.8, 0.22, C.pole);
      m.box(s * 9.5, 0.4, z, 0.5, 0.8, 0.5, 0x6b6f76);
      m.box(s * 8.15, 9.62, z, 2.7, 0.14, 0.14, C.pole);
      m.box(s * 6.75, 9.64, z, 1.0, 0.16, 0.44, C.housing);
      m.box(s * 6.75, 9.53, z, 0.86, 0.06, 0.34, C.lampOn, 1);
    }
    const props = new THREE.Mesh(keep(m.build()), propMat);
    props.frustumCulled = false;
    ground.add(props);

    // soft light: a warm pool on the road under each lamp, a halo round each head
    const gp = [], gc = [], gu = [], pool = new THREE.Color(0xffb878), halo = new THREE.Color(0xffdcae);
    const quad = (pts, c, a) => {
      const uv = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]], ix = [0, 1, 2, 0, 2, 3];
      for (let k = 0; k < 6; k++) { const p = pts[ix[k]]; gp.push(p[0], p[1], p[2]); gc.push(c.r, c.g, c.b, a); gu.push(uv[k][0], uv[k][1]); }
    };
    for (let z = Z_BACK; z >= Z_FRONT; z -= 24) {
      const s = (Math.round(z / 24) & 1) ? 1 : -1, x = s * 4.6, y = 0.025;
      quad([[x - 7, y, z + 9], [x + 7, y, z + 9], [x + 7, y, z - 9], [x - 7, y, z - 9]], pool, 0.20);
      const hx = s * 6.75, hy = 9.45, hz = z + 0.3;
      quad([[hx - 1.3, hy - 1.3, hz], [hx + 1.3, hy - 1.3, hz], [hx + 1.3, hy + 1.3, hz], [hx - 1.3, hy + 1.3, hz]], halo, 0.55);
    }
    const gg = keep(new THREE.BufferGeometry());
    gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    gg.setAttribute('color', new THREE.Float32BufferAttribute(gc, 4));
    gg.setAttribute('uv', new THREE.Float32BufferAttribute(gu, 2));
    const glowTex = keep(blobTexture([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.6)'], [0.6, 'rgba(255,255,255,0.16)'], [1, 'rgba(255,255,255,0)']]));
    const glows = new THREE.Mesh(gg, keep(new THREE.MeshBasicMaterial({ map: glowTex, vertexColors: true, transparent: true, depthWrite: false })));
    glows.frustumCulled = false; glows.renderOrder = 1;
    ground.add(glows);
  }

  /* scattered scenery, laid per world slot by a hash (never repeats) */
  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const _e = new THREE.Euler(), _up = new THREE.Vector3(0, 1, 0), _col = new THREE.Color();
  function scatterMesh(geo, cap) {
    const im = new THREE.InstancedMesh(keep(geo), propMat, cap);
    im.frustumCulled = false; im.count = 0;
    im.setColorAt(0, _col.setRGB(1, 1, 1));
    ground.add(im);
    return im;
  }
  const rockGeo = (() => {
    const ico = new THREE.IcosahedronGeometry(1, 0), p = ico.attributes.position;
    for (let i = 0; i < p.count; i++) {        // the same jitter for the same corner: no cracks
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 0.78 + 0.4 * hash(Math.round(x * 1000) * 7 + Math.round(y * 1000) * 131 + Math.round(z * 1000) * 1031, 9);
      p.setXYZ(i, x * k * 1.3, Math.max(-0.35, y * k * 0.75), z * k * 1.05);
    }
    const m = new Mesher();
    m.geo(ico, new THREE.Matrix4().makeTranslation(0, 0.3, 0), C.rock, 0, (v) => 0.8 + 0.25 * clamp01(v.y));
    return m.build();
  })();
  const treeGeo = (() => {
    const m = new Mesher();
    m.part(0.32, 0.2, -0.16, 0.16, -0.1, 0.1, 0, 2.0, C.trunk, 0);
    m.part(0.16, 0.1, -0.08, 0.08, -0.05, 0.05, 1.5, 2.6, C.trunk, 0, 0.5);
    const ico = new THREE.IcosahedronGeometry(1, 0);
    m.geo(ico, new THREE.Matrix4().makeTranslation(0, 2.6, 0).multiply(new THREE.Matrix4().makeScale(2.0, 0.85, 1.9)), C.leaf, 0, (v) => 0.75 + 0.3 * clamp01((v.y - 2) / 1.2));
    m.geo(ico, new THREE.Matrix4().makeTranslation(0.7, 3.1, 0.2).multiply(new THREE.Matrix4().makeScale(1.2, 0.6, 1.1)), C.leaf, 0, () => 1.05);
    return m.build();
  })();
  const gantryGeo = (() => {
    const m = new Mesher();
    for (const s of [-1, 1]) m.box(s * 9.9, 3.8, 0, 0.32, 7.6, 0.32, 0x6a6f77);
    m.box(0, 7.3, 0, 20.1, 0.34, 0.34, 0x6a6f77); m.box(0, 6.7, 0, 20.1, 0.18, 0.18, 0x6a6f77);
    const panel = (cx, cy, w, h) => {
      m.box(cx, cy, 0.26, w, h, 0.12, C.sign, 0.18);
      m.box(cx, cy + h / 2 - 0.1, 0.33, w - 0.12, 0.06, 0.02, C.signInk, 0.6);
      m.box(cx, cy - h / 2 + 0.1, 0.33, w - 0.12, 0.06, 0.02, C.signInk, 0.6);
      m.box(cx - w / 2 + 0.1, cy, 0.33, 0.06, h - 0.12, 0.02, C.signInk, 0.6);
      m.box(cx + w / 2 - 0.1, cy, 0.33, 0.06, h - 0.12, 0.02, C.signInk, 0.6);
      m.box(cx - w * 0.12, cy + h * 0.18, 0.33, w * 0.55, h * 0.16, 0.02, C.signInk, 0.6);
      m.box(cx - w * 0.2, cy - h * 0.12, 0.33, w * 0.38, h * 0.12, 0.02, C.signInk, 0.6);
      m.box(cx + w * 0.3, cy - h * 0.1, 0.33, h * 0.1, h * 0.42, 0.02, C.signInk, 0.6);
    };
    panel(-3.6, 8.3, 6.6, 2.7); panel(3.9, 8.1, 4.6, 2.3);
    return m.build();
  })();
  /* a desert butte: stacked tapers with a flat top and a darker band */
  const butteGeo = (() => {
    const m = new Mesher();
    m.part(2.0, 1.7, -1.0, 1.0, -0.85, 0.85, -0.1, 0.45, 0x8e5640, 0);
    m.part(1.7, 1.5, -0.85, 0.85, -0.74, 0.74, 0.45, 0.62, 0x6e4034, 0);
    m.part(1.5, 1.26, -0.74, 0.74, -0.62, 0.62, 0.62, 1.0, 0x94604a, 0);
    m.part(1.26, 1.16, -0.62, 0.62, -0.56, 0.56, 1.0, 1.06, 0x7a4a3a, 0);
    return m.build();
  })();
  const rocks = scatterMesh(rockGeo, SCATTER_CAP);
  const buttes = scatterMesh(butteGeo, 24);
  const trees = scatterMesh(treeGeo, 128);
  const gantries = scatterMesh(gantryGeo, 2);
  const scatterMeshes = [rocks, buttes, trees, gantries];
  let sceneryBase = NaN;
  function scatter(im, n, base, spacing, salt, prob, x0, x1, s0, s1, y0, y1, c0, c1) {
    const k0 = Math.floor((base - BEHIND - 30) / spacing), k1 = Math.ceil((base + BLOCK + AHEAD + 10) / spacing);
    for (let k = k0; k <= k1; k++) {
      for (let side = 0; side < 2; side++) {
        const sl = salt + side * 17;
        if (hash(k, sl) >= prob) continue;
        if (n >= im.instanceMatrix.count) return n;
        const h1 = hash(k, sl + 1), h2 = hash(k, sl + 2), h3 = hash(k, sl + 3), h4 = hash(k, sl + 4);
        const wz = (k + h1) * spacing, sc = s0 + (s1 - s0) * h3;
        _p.set((side ? 1 : -1) * (x0 + (x1 - x0) * h2 * h2), 0, -(wz - base));
        _q.setFromAxisAngle(_up, h4 * 6.2832);
        _s.set(sc, sc * (y0 + (y1 - y0) * h4), sc);
        im.setMatrixAt(n, _m.compose(_p, _q, _s));
        const sh = c0 + (c1 - c0) * hash(k, sl + 5);
        im.setColorAt(n, _col.setRGB(sh * (0.96 + 0.08 * h2), sh, sh * (0.94 + 0.1 * h1)));
        n++;
      }
    }
    return n;
  }
  function layScenery(base) {
    sceneryBase = base;
    let n = scatter(rocks, 0, base, 7, 100, 0.42, 10.6, 50, 0.3, 1.2, 0.7, 1.3, 0.8, 1.15);
    rocks.count = n;
    buttes.count = scatter(buttes, 0, base, 60, 200, 0.55, 110, 320, 14, 34, 0.5, 0.9, 0.75, 1.05);
    trees.count = scatter(trees, 0, base, 12, 300, 0.45, 11.5, 75, 0.8, 1.5, 0.85, 1.2, 0.8, 1.1);
    let g = 0;
    for (let k = Math.floor((base - 40) / 768); k <= Math.ceil((base + BLOCK + AHEAD) / 768); k++) {
      if (g >= 2) break;
      _p.set(0, 0, -(k * 768 + 300 - base));
      gantries.setMatrixAt(g++, _m.compose(_p, _q.identity(), _s.set(1, 1, 1)));
    }
    gantries.count = g;
    for (let i = 0; i < scatterMeshes.length; i++) {
      const im = scatterMeshes[i];
      im.visible = im.count > 0;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }

  /* traffic: per type, paint (tinted per car) + details, sharing one matrix buffer */
  const paintLin = PAINTS.map((h) => new THREE.Color(h));
  const trafficPaintMat = keep(litMaterial({}));
  const tmesh = S.TYPES.map((T) => {
    const g = buildTrafficModel(T);
    const paint = new THREE.InstancedMesh(keep(g.paint), trafficPaintMat, TRAFFIC_CAP);
    const det = new THREE.InstancedMesh(keep(g.det), propMat, TRAFFIC_CAP);
    paint.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    det.instanceMatrix = paint.instanceMatrix;
    paint.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TRAFFIC_CAP * 3), 3);
    paint.instanceColor.setUsage(THREE.DynamicDrawUsage);
    for (const im of [paint, det]) { im.frustumCulled = false; im.count = 0; im.visible = false; scene.add(im); }
    const mat = paint.instanceMatrix.array;
    for (let i = 0; i < TRAFFIC_CAP; i++) { mat[i * 16] = 1; mat[i * 16 + 5] = 1; mat[i * 16 + 10] = 1; mat[i * 16 + 15] = 1; }
    return { paint, det, mat, col: paint.instanceColor.array };
  });
  const tcount = new Int32Array(S.TYPES.length);

  /* blob shadows: one instanced quad for every car on the road */
  const shadowTex = keep(blobTexture([[0, 'rgba(0,0,0,0.62)'], [0.5, 'rgba(0,0,0,0.5)'], [0.8, 'rgba(0,0,0,0.18)'], [1, 'rgba(0,0,0,0)']]));
  const shadows = new THREE.InstancedMesh(keep(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
    keep(new THREE.MeshBasicMaterial({ color: 0x000000, map: shadowTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 })), SHADOW_CAP);
  shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shadows.frustumCulled = false; shadows.count = 0; shadows.renderOrder = 1;
  const shm = shadows.instanceMatrix.array;
  for (let i = 0; i < SHADOW_CAP; i++) { shm[i * 16 + 5] = 1; shm[i * 16 + 13] = 0.02; shm[i * 16 + 15] = 1; }
  scene.add(shadows);

  /* the two players' cars: solid when followed, a ghost (they pass through each other) when not */
  const MODELS = { supercar: buildSupercar(), muscle: buildMuscle(), hatch: buildHatch() };
  for (const k in MODELS) { keep(MODELS[k].paint); keep(MODELS[k].det); }
  const pg = MODELS.supercar;
  const sidePaint = SIDE_PAINT.slice();      // each seat's paint, from setLooks
  /* Exhaust flames for the backfire: glowing quads at the pipes, facing back, one mesh per car, shown and
     scaled only for a moment after each bang (backfire). */
  const flameGeo = (() => {
    const p = [], uv = [];
    for (const [cx, cy, cz, w, h] of [[-0.42, 0.37, 2.32, 0.62, 0.42], [0.42, 0.37, 2.32, 0.62, 0.42],
                                      [-0.42, 0.37, 2.30, 0.28, 0.2], [0.42, 0.37, 2.30, 0.28, 0.2]]) {
      const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
      p.push(x0, y0, cz, x1, y0, cz, x1, y1, cz, x0, y0, cz, x1, y1, cz, x0, y1, cz);
      uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return keep(g);
  })();
  const detSolid = keep(litMaterial({}));
  const detGhost = keep(litMaterial({ transparent: true, opacity: 0.45 }));

  /* Indicators and brake lamps (Owen 2026-10-28): unlit boxes over the car's
     own lamps, each with a soft halo facing back at the camera, built once
     and only shown or hidden each frame (poseCar). Indicators sit under the
     tail lights, on the nose corners and on the backs of the mirrors; the
     brake lamps cover the tail lights and the light bar, a hotter red than
     the tail lights' own. */
  const lampGlow = keep(blobTexture([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.8)'], [0.55, 'rgba(255,255,255,0.3)'], [1, 'rgba(255,255,255,0)']]));
  const haloMat = (hex, a) => keep(new THREE.MeshBasicMaterial({ color: hex, map: lampGlow, transparent: true, opacity: a, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide }));
  const amberLamp = keep(new THREE.MeshBasicMaterial({ color: 0xffa31a, toneMapped: false }));
  const brakeLamp = keep(new THREE.MeshBasicMaterial({ color: 0xff7a5e, toneMapped: false }));
  const amberHalo = haloMat(0xff9a1c, 0.9), brakeHalo = haloMat(0xff2a14, 1);
  function haloGeo(list) {               // [cx, cy, cz, w, h]: quads square to z, facing back
    const p = [], uv = [];
    for (const [cx, cy, cz, w, h] of list) {
      const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
      p.push(x0, y0, cz, x1, y0, cz, x1, y1, cz, x0, y0, cz, x1, y1, cz, x0, y1, cz);
      uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return keep(g);
  }
  const indGeo = [-1, 1].map((s) => {
    const m = new Mesher();
    m.box(s * 0.72, 0.585, 2.13, 0.20, 0.06, 0.08, 0);       // rear, under the tail light
    m.box(s * 0.83, 0.56, -1.62, 0.08, 0.07, 0.22, 0);       // nose corner
    m.box(s * 0.95, 0.88, -0.465, 0.08, 0.05, 0.03, 0);      // back of the mirror
    return { lamp: keep(m.build()), halo: haloGeo([[s * 0.72, 0.585, 2.21, 0.8, 0.5], [s * 0.95, 0.88, -0.43, 0.4, 0.28]]) };
  });
  const brakeGeo = (() => {
    const m = new Mesher();
    for (const s of [-1, 1]) m.box(s * 0.56, 0.70, 2.135, 0.54, 0.125, 0.09, 0);
    m.box(0, 0.70, 2.14, 0.64, 0.05, 0.07, 0);
    return { lamp: keep(m.build()), halo: haloGeo([[-0.56, 0.70, 2.24, 1.6, 0.8], [0.56, 0.70, 2.24, 1.6, 0.8]]) };
  })();
  function lampSet(geo, lampMat, halo) {
    const g = new THREE.Group(), a = new THREE.Mesh(geo.lamp, lampMat), b = new THREE.Mesh(geo.halo, halo);
    a.frustumCulled = b.frustumCulled = false;
    b.renderOrder = 4;                   // after the ghost body, so a ghost's lamps still glow
    g.add(a, b);
    g.visible = false;
    return g;
  }
  const BLINK_HZ = 1.5, BLINK_HOLD = 0.4;   // flashes a second; how long it keeps going after the wheel is let go

  const cars = [0, 1].map((side) => {
    const solid = keep(litMaterial({ color: SIDE_PAINT[side], emissive: new THREE.Color(SIDE_PAINT[side]).multiplyScalar(0.12) }));
    const ghost = keep(litMaterial({ color: SIDE_PAINT[side], emissive: new THREE.Color(SIDE_PAINT[side]).multiplyScalar(0.2), transparent: true, opacity: 0.45 }));
    const group = new THREE.Group();
    group.rotation.order = 'YXZ';
    const paint = new THREE.Mesh(pg.paint, solid), det = new THREE.Mesh(pg.det, detSolid);
    paint.frustumCulled = det.frustumCulled = false;
    group.add(paint, det);
    const ind = [lampSet(indGeo[0], amberLamp, amberHalo), lampSet(indGeo[1], amberLamp, amberHalo)];
    const brake = lampSet(brakeGeo, brakeLamp, brakeHalo);
    group.add(ind[0], ind[1], brake);
    const flameMat = keep(new THREE.MeshBasicMaterial({ color: 0xff8a2a, map: lampGlow, transparent: true, opacity: 1, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide }));
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.frustumCulled = false; flame.renderOrder = 5; flame.visible = false;
    group.add(flame);
    group.visible = false;
    scene.add(group);
    return { side, group, paint, det, solid, ghost, ind, brake, flame, flameMat, roll: 0, pitch: 0, acc: 0, lastV: -1, lastVx: 0,
             blinkSide: 0, blinkT: 0, blinkHold: 0, flameT: 0, flameLeft: 0, flameNext: 0 };
  });

  /* Traffic lamps (Owen 2026-10-28): a car about to change lane flashes its
     indicator (front and back corners, the back one with a halo) from 2.5 s
     before until it has moved over, and lights its brake lamps for the last
     second before it pulls out (SwimSim.signalAt, brakingAt). One instanced
     box and one instanced halo for every lamp lit on the road, written in
     place each frame. */
  const TLAMP_CAP = 64;
  const LAMP_Y = { sedan: 0.66, hatch: 0.69, suv: 0.85, van: 0.98, truck: 0.84, bus: 1.0 };
  const lampYOf = S.TYPES.map((T) => LAMP_Y[T.id] || 0.7);
  const tLamps = new THREE.InstancedMesh(keep(new THREE.BoxGeometry(1, 1, 1)), keep(new THREE.MeshBasicMaterial({ toneMapped: false })), TLAMP_CAP);
  const tHalos = new THREE.InstancedMesh(keep(new THREE.PlaneGeometry(1, 1)), keep(new THREE.MeshBasicMaterial({ map: lampGlow, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide })), TLAMP_CAP);
  for (const im of [tLamps, tHalos]) {
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TLAMP_CAP * 3), 3);
    im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false; im.count = 0; im.visible = false;
    scene.add(im);
  }
  tHalos.renderOrder = 4;
  const tlm = tLamps.instanceMatrix.array, tlc = tLamps.instanceColor.array;
  const thm = tHalos.instanceMatrix.array, thc = tHalos.instanceColor.array;
  const AMBER_L = [1, 0.64, 0.1], AMBER_H = [1, 0.6, 0.11], RED_L = [1, 0.36, 0.26], RED_H = [1, 0.17, 0.08];
  const TL = { n: 0, h: 0 };            // lamps and halos written this frame
  /* One lamp (and maybe a halo) at local (ox, oy, oz) of a traffic car at (x, zs) turned by (c, sn). */
  function tLamp(x, zs, c, sn, ox, oy, oz, col, hcol, hw, hh) {
    if (TL.n >= TLAMP_CAP) return;
    const px = x + c * ox + sn * oz, pz = zs - sn * ox + c * oz;
    let o = TL.n * 16;
    tlm[o] = 0.2; tlm[o + 5] = 0.11; tlm[o + 10] = 0.08; tlm[o + 12] = px; tlm[o + 13] = oy; tlm[o + 14] = pz;
    tlc[TL.n * 3] = col[0]; tlc[TL.n * 3 + 1] = col[1]; tlc[TL.n * 3 + 2] = col[2];
    TL.n++;
    if (!hcol || TL.h >= TLAMP_CAP) return;
    o = TL.h * 16;
    thm[o] = hw; thm[o + 5] = hh; thm[o + 10] = 1; thm[o + 12] = px; thm[o + 13] = oy; thm[o + 14] = pz + 0.1;
    thc[TL.h * 3] = hcol[0]; thc[TL.h * 3 + 1] = hcol[1]; thc[TL.h * 3 + 2] = hcol[2];
    TL.h++;
  }

  /* speed lines: thin streaks round the edge of the view, riding with the camera */
  const streakGeo = (() => {
    const g = new THREE.BoxGeometry(0.02, 0.02, 1).toNonIndexed(), p = g.attributes.position, c = [];
    for (let i = 0; i < p.count; i++) { const k = p.getZ(i) > 0 ? 1 : 0; c.push(k, k, k); }
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    g.deleteAttribute('normal'); g.deleteAttribute('uv');
    return g;
  })();
  const streaks = new THREE.InstancedMesh(keep(streakGeo), keep(new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false,
  })), STREAKS + BURSTS);
  streaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  streaks.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array((STREAKS + BURSTS) * 3), 3);
  streaks.instanceColor.setUsage(THREE.DynamicDrawUsage);
  streaks.frustumCulled = false; streaks.renderOrder = 3; streaks.count = 0; streaks.visible = false;
  camera.add(streaks);
  const stm = streaks.instanceMatrix.array, stc = streaks.instanceColor.array;
  for (let i = 0; i < STREAKS + BURSTS; i++) { stm[i * 16] = 1; stm[i * 16 + 5] = 1; stm[i * 16 + 15] = 1; }
  const sx = new Float32Array(STREAKS + BURSTS), sy = new Float32Array(STREAKS + BURSTS), sz = new Float32Array(STREAKS + BURSTS), sr = new Float32Array(STREAKS + BURSTS);
  const R = { seed: 12345 };
  const rand = () => { R.seed = (Math.imul(R.seed, 1664525) + 1013904223) >>> 0; return R.seed / 4294967296; };
  function placeStreak(i, z) {
    // round the edges of the view only: wide to the sides, low over the road, clear of the car
    const s = rand() < 0.5 ? -1 : 1;
    sx[i] = s * (2.3 + rand() * 2.4);
    sy[i] = -1.1 + rand() * 2.0;
    sz[i] = z; sr[i] = rand();
  }
  for (let i = 0; i < STREAKS; i++) placeStreak(i, -2 - rand() * 32);
  const streakBase = new THREE.Color(0xfff0dc), burstCol = new THREE.Color();

  /* crash bits: sparks and debris, one instanced mesh */
  const parts = new THREE.InstancedMesh(keep(new THREE.BoxGeometry(1, 1, 1)), keep(new THREE.MeshBasicMaterial({ fog: false, toneMapped: false })), PARTS);
  parts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  parts.frustumCulled = false; parts.count = 0; parts.visible = false;
  parts.setColorAt(0, _col.setRGB(1, 1, 1));
  scene.add(parts);
  const P = {
    x: new Float64Array(PARTS), y: new Float32Array(PARTS), z: new Float64Array(PARTS),
    vx: new Float32Array(PARTS), vy: new Float32Array(PARTS), vz: new Float32Array(PARTS),
    life: new Float32Array(PARTS), life0: new Float32Array(PARTS), size: new Float32Array(PARTS),
    rx: new Float32Array(PARTS), ry: new Float32Array(PARTS), wr: new Float32Array(PARTS), spark: new Uint8Array(PARTS),
  };
  let partsAlive = 0;

  /* ── state ───────────────────────────────────────────────────────── */
  /* Numbers that change every frame live on one object: V8 keeps its double
     fields in place, where a closure `let` would box a new number each write. */
  const K = { time: 0, fov: 62, camX: 0, lookX: 0, camRoll: 0, camOffZ: 0, lastZ0: NaN, nmT: 0, rev: 0, lurchT: 9, lurchDir: 1,
    crashT: 0, crashYaw: 0, crashW: 0, shakeCrash: 0, lastFollowV: 30, slowEma: 1 / 60, adaptCool: 2 };
  let cssW = 1, cssH = 1, dpr = 1, dprDrop = 0, snap = true;
  let lastSide = -1, nmSide = 0, nmPending = null;
  let crashPending = false, crashOn = false, crashSide = 0, crashDir = 1;
  const NM_LEN = 0.45;

  function resize() {
    cssW = Math.max(1, canvasEl.clientWidth | 0); cssH = Math.max(1, canvasEl.clientHeight | 0);
    const dev = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    dpr = Math.max(Math.min(minDpr, dev), Math.min(dev, maxDpr) - dprDrop);
    renderer.setPixelRatio(dpr);
    renderer.setSize(cssW, cssH, false);
    camera.aspect = cssW / cssH;
    camera.updateProjectionMatrix();
  }

  /* Pull a car's paint/details over to solid or ghost and set its pose. `wheel` is the driver's own
     steering when this screen has it (our car), else null: its indicators then go by sideways speed. */
  function poseCar(car, st, z0, ghost, steer, dt, wheel) {
    const g = car.group;
    if (!st) { g.visible = false; return; }
    g.visible = true;
    car.paint.material = ghost ? car.ghost : car.solid;
    car.det.material = ghost ? detGhost : detSolid;
    car.paint.renderOrder = car.det.renderOrder = ghost ? 2 : 0;
    const v = st.v || 0, vx = st.vx || 0;
    if (car.lastV < 0 || snap) { car.lastV = v; car.lastVx = vx; }
    const a = clamp((v - car.lastV) / Math.max(dt, 1e-3), -25, 25);
    const lat = clamp((vx - car.lastVx) / Math.max(dt, 1e-3) / 46, -1, 1);
    car.lastV = v; car.lastVx = vx;
    car.acc += (a - car.acc) * ease(dt, 6);
    const rollT = steer != null ? steer : lat;
    car.roll += (rollT * 0.055 - car.roll) * ease(dt, 8);
    car.pitch += (clamp(car.acc * 0.0035, -0.07, 0.04) - car.pitch) * ease(dt, 8);
    const sp = clamp01((v * 3.6 - 100) / 180);
    /* Looks only (the step never sees them): revving on the start line squats the tail and rocks the body on
       its mounts; a shift dips the nose as the drive cuts, then squats and surges for about 0.3 s. */
    let dPitch = 0, dRoll = 0, dY = 0;
    if (!ghost) {
      const rv = K.rev;
      if (rv > 0.001) {
        dPitch += 0.024 * rv;
        dRoll += 0.009 * rv * Math.sin(K.time * 38);
        dY += 0.006 * rv * Math.sin(K.time * 61);
      }
      dPitch += lurchPitch();
    }
    g.position.set(st.x, 0.006 * Math.sin(K.time * 23 + car.side) * sp + dY, -(st.z - z0));
    g.rotation.set(car.pitch + dPitch, -Math.atan2(vx, Math.max(v, 8)) * 0.85, car.roll + dRoll);
    if (ghost && st.alive === false) { g.rotation.y = 0.6; g.rotation.z = 0; }   // the other car has crashed: show it skewed
    if (crashOn && car.side === crashSide && !ghost) {
      const t = K.crashT;
      g.position.y += t < 0.4 ? 0.22 * Math.sin(Math.PI * t / 0.4) : 0;
      g.position.z += 0.35 * (1 - Math.exp(-t * 12));
      g.rotation.y = K.crashYaw;
      g.rotation.x = 0.13 * Math.exp(-t * 5) * Math.sin(t * 26);
      g.rotation.z = 0.08 * crashDir * Math.exp(-t * 4);
    }
    /* Indicators flash while it steers (held a moment, so a quick tap still flashes once); the brake
       lamps are lit while it brakes. Nothing on a crashed car. */
    const alive = st.alive !== false;
    const sig = !alive ? 0 : wheel != null ? (wheel > 0.15 ? 1 : wheel < -0.15 ? -1 : 0) : (vx > 1.5 ? 1 : vx < -1.5 ? -1 : 0);
    if (sig !== 0) {
      if (sig !== car.blinkSide) { car.blinkSide = sig; car.blinkT = 0; }
      car.blinkHold = BLINK_HOLD;
    } else if (car.blinkSide !== 0) {
      car.blinkHold -= dt;
      if (car.blinkHold <= 0 || !alive) car.blinkSide = 0;
    }
    car.blinkT += dt;
    const lit = car.blinkSide !== 0 && (car.blinkT * BLINK_HZ) % 1 < 0.5;
    car.ind[0].visible = lit && car.blinkSide < 0;
    car.ind[1].visible = lit && car.blinkSide > 0;
    car.brake.visible = alive && !!st.brake;
    /* Backfire: each bang a short flame at the pipes; a remote car's run is spaced out here. */
    if (car.flameLeft > 0) {
      car.flameNext -= dt;
      if (car.flameNext <= 0) { car.flameLeft--; car.flameT = 0.09 + rand() * 0.05; car.flameNext = 0.12 + rand() * 0.22; }
    }
    if (car.flameT > 0 && alive) {
      car.flameT -= dt;
      const k = clamp01(car.flameT / 0.1);
      car.flame.visible = true;
      car.flameMat.opacity = (ghost ? 0.6 : 1) * (0.45 + 0.55 * k) * (0.8 + 0.2 * rand());   // a flicker, no resizing
    } else car.flame.visible = false;
  }
  /* The shift lurch: a nose dip as the drive cuts (first 0.09 s), then the squat and surge to 0.3 s. A
     downshift is a softer dip. */
  function lurchPitch() {
    const t = K.lurchT;
    if (t >= 0.32) return 0;
    const dip = t < 0.09 ? Math.sin(Math.PI * t / 0.09) : 0;
    const surge = t > 0.06 ? Math.sin(Math.PI * clamp01((t - 0.06) / 0.26)) : 0;
    return K.lurchDir > 0 ? -0.014 * dip + 0.03 * surge : -0.012 * (dip + surge * 0.5);
  }

  /* Send only the used front of an instance buffer, through one range object
     kept per buffer (addUpdateRange would make a new one every frame). */
  function upload(attr, count) {
    let r = attr.userRange;
    if (!r) r = attr.userRange = { start: 0, count: 0 };
    r.start = 0; r.count = count;
    const list = attr.updateRanges;
    if (list.length !== 1 || list[0] !== r) { list.length = 0; list.push(r); }
    attr.needsUpdate = true;
  }

  function carShadow(car, ns) {
    if (!car.group.visible || ns >= SHADOW_CAP) return ns;
    const so = ns * 16;
    shm[so] = 1.8 * 1.3; shm[so + 10] = 4.3 * 1.12; shm[so + 12] = car.group.position.x; shm[so + 14] = car.group.position.z;
    return ns + 1;
  }

  function startCrash(fol, traffic, tick, side) {
    crashOn = true; K.crashT = 0; crashSide = side; K.crashYaw = 0; K.shakeCrash = 1;
    /* where it hit: the nearest traffic car, else the nose */
    let ix = 0, iz = 2.0, best = 1e9;
    if (traffic && traffic.lanes) {
      for (let l = 0; l < S.LANES; l++) {
        const list = traffic.lanes[l];
        for (let i = 0; i < list.length; i++) {
          const dz = S.zAt(list[i], tick) - fol.z;
          if (dz > 14) break;
          if (dz < -14) continue;
          const dx = S.xAt(list[i], tick) - fol.x, d = dx * dx + dz * dz;
          if (d < best) { best = d; ix = clamp(dx * 0.5, -0.9, 0.9); iz = clamp(dz, -2.1, 2.1); }
        }
      }
    }
    crashDir = ix >= 0 ? 1 : -1;
    K.crashW = (iz >= 0 ? 1 : -1) * crashDir * (4.2 + rand() * 2.2);
    const v = Math.max(K.lastFollowV, 12), paint = sidePaint[side];
    partsAlive = 0;
    for (let i = 0; i < PARTS; i++) {
      const spark = i < 40;
      P.spark[i] = spark ? 1 : 0;
      P.x[i] = fol.x + ix + (rand() - 0.5) * 0.6; P.y[i] = 0.35 + rand() * 0.5; P.z[i] = fol.z + iz + (rand() - 0.5) * 0.4;
      const fwd = v * (spark ? 0.35 + rand() * 0.6 : 0.25 + rand() * 0.5);
      P.vx[i] = (rand() - 0.5) * (spark ? 8 : 10) + ix * 3; P.vy[i] = (spark ? 1.5 : 2.5) + rand() * 5; P.vz[i] = fwd + (rand() - 0.5) * 4;
      P.life0[i] = P.life[i] = spark ? 0.45 + rand() * 0.7 : 1.6 + rand() * 1.2;
      P.size[i] = spark ? 0.05 + rand() * 0.05 : 0.1 + rand() * 0.22;
      P.rx[i] = rand() * 6; P.ry[i] = rand() * 6; P.wr[i] = (rand() - 0.5) * 18;
      if (spark) _col.setRGB(1, 0.75 + rand() * 0.25, 0.3 + rand() * 0.4);
      else { const k = rand(); _col.set(k < 0.5 ? paint : k < 0.8 ? C.trim : C.glass); }
      parts.setColorAt(i, _col);
    }
    partsAlive = PARTS;
    parts.count = PARTS; parts.visible = true;
    parts.instanceColor.needsUpdate = true;
  }

  function stepParts(dt, z0) {
    if (!partsAlive) return;
    let alive = 0;
    for (let i = 0; i < PARTS; i++) {
      let life = P.life[i];
      if (life <= 0) { _m.makeScale(0, 0, 0); parts.setMatrixAt(i, _m); continue; }
      life -= dt; P.life[i] = life;
      const spark = P.spark[i] === 1;
      P.vy[i] -= (spark ? 11 : 9.8) * dt;
      const drag = Math.exp(-dt * (spark ? 1.4 : 0.7));
      P.vx[i] *= drag; P.vz[i] *= drag;
      P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt; P.z[i] += P.vz[i] * dt;
      const half = P.size[i] / 2;
      if (P.y[i] < half) {
        P.y[i] = half; P.vy[i] = -P.vy[i] * 0.3; P.vx[i] *= 0.6; P.vz[i] *= 0.6; P.wr[i] *= 0.6;
        if (spark) P.life[i] -= dt * 2;
      }
      P.rx[i] += P.wr[i] * dt; P.ry[i] += P.wr[i] * 0.7 * dt;
      const fade = spark ? life / P.life0[i] : Math.min(1, life / 0.35);
      const s = P.size[i] * clamp01(fade);
      _p.set(P.x[i], P.y[i], -(P.z[i] - z0));
      _q.setFromEuler(_e.set(P.rx[i], P.ry[i], 0));
      if (spark) _s.set(s, s, s * 3.2); else _s.set(s, s * 0.6, s * 1.3);
      parts.setMatrixAt(i, _m.compose(_p, _q, _s));
      if (life > 0) alive++;
    }
    partsAlive = alive;
    parts.instanceMatrix.needsUpdate = true;
    if (!alive) { parts.count = 0; parts.visible = false; }
  }

  function nearSideFrom(fol, traffic, tick) {
    let side = 0, best = 1e9;
    if (!traffic || !traffic.lanes) return 0;
    for (let l = 0; l < S.LANES; l++) {
      const list = traffic.lanes[l];
      for (let i = 0; i < list.length; i++) {
        const dz = S.zAt(list[i], tick) - fol.z;
        if (dz > 10) break;
        if (dz < -14) continue;
        const dx = S.xAt(list[i], tick) - fol.x;
        if (Math.abs(dx) < 0.6 || Math.abs(dx) > 4.5) continue;
        const d = Math.abs(dz) + Math.abs(dx);
        if (d < best) { best = d; side = dx > 0 ? 1 : -1; }
      }
    }
    return side;
  }

  function stepStreaks(dt, v, side) {
    const sF = smooth(30, 72, v) * 0.42;
    const burst = K.nmT > 0 ? Math.pow(K.nmT / NM_LEN, 1.4) : 0;
    let n = 0;
    if (sF > 0.01) {
      const len = clamp(v * 0.032, 0.5, 2.4);
      for (let i = 0; i < STREAKS; i++) {
        sz[i] += v * 0.85 * (0.75 + 0.5 * sr[i]) * dt;
        if (sz[i] > 0.5) placeStreak(i, sz[i] - 34);
        const z = sz[i], k = sF * (0.3 + 0.7 * sr[i]) * smooth(-34, -22, z) * (1 - smooth(-4, 0.5, z));
        const o = n * 16;
        stm[o] = stm[o + 5] = 1; stm[o + 10] = len * (0.7 + 0.6 * sr[i]); stm[o + 12] = sx[i]; stm[o + 13] = sy[i]; stm[o + 14] = z;
        stc[n * 3] = streakBase.r * k; stc[n * 3 + 1] = streakBase.g * k; stc[n * 3 + 2] = streakBase.b * k;
        n++;
      }
    }
    if (burst > 0) {
      burstCol.set(SIDE_STREAK[side]);
      for (let j = 0; j < BURSTS; j++) {
        const i = STREAKS + j;
        sz[i] += (v * 1.1 + 20) * (0.8 + 0.5 * sr[i]) * dt;
        if (sz[i] > -1.5) sz[i] -= 15;
        const k = burst * 1.0 * (0.45 + 0.55 * sr[i]) * smooth(-16.5, -12, sz[i]) * (1 - smooth(-3.5, -1.5, sz[i]));
        const o = n * 16;
        stm[o] = stm[o + 5] = 2; stm[o + 10] = 1.0 + 1.2 * sr[i]; stm[o + 12] = sx[i]; stm[o + 13] = sy[i]; stm[o + 14] = sz[i];
        stc[n * 3] = burstCol.r * k; stc[n * 3 + 1] = burstCol.g * k; stc[n * 3 + 2] = burstCol.b * k;
        n++;
      }
    }
    streaks.count = n; streaks.visible = n > 0;
    if (n) {
      upload(streaks.instanceMatrix, n * 16); upload(streaks.instanceColor, n * 3);
    }
  }

  function frame(f) {
    if (!f || !f.follow) return;
    let dt = +f.dt;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;
    K.time += dt;
    const fol = f.follow, oth = f.other || null, side = f.followSide === 1 ? 1 : 0;
    K.rev = clamp01(+f.rev || 0);
    K.lurchT += dt;
    const tick = +f.tick || 0, traffic = f.traffic || null;
    const z0 = +fol.z || 0;
    if (side !== lastSide) {
      // a new car to follow: glide over to it if it is close, else cut
      if (lastSide >= 0 && Math.abs(z0 - K.lastZ0) < 250) K.camOffZ = z0 - K.lastZ0; else snap = true;
      lastSide = side;
    } else if (!(Math.abs(z0 - K.lastZ0) < 60)) snap = true;
    K.lastZ0 = z0;
    if (fol.alive !== false) K.lastFollowV = fol.v || 0;

    /* the treadmill */
    const base = Math.floor(z0 / BLOCK) * BLOCK;
    if (base !== sceneryBase) layScenery(base);
    ground.position.z = z0 - base;

    /* traffic */
    tcount.fill(0);
    TL.n = 0; TL.h = 0;
    let ns = 0;
    if (traffic && traffic.lanes) {
      for (let l = 0; l < S.LANES; l++) {
        const list = traffic.lanes[l];
        for (let i = 0; i < list.length; i++) {
          const r = list[i], dz = S.zAt(r, tick) - z0;
          if (dz < -BEHIND) continue;
          if (dz > AHEAD + 7) break;
          const t = r[2], n = tcount[t];
          if (n >= TRAFFIC_CAP) continue;
          tcount[t] = n + 1;
          const tm = tmesh[t], o = n * 16, lx = S.xAt(r, tick);
          /* A car changing lane turns into its line while it moves: the slope of the 3s^2 - 2s^3 ease. */
          let c = 1, sn = 0;
          if (r.length >= 8) {
            const k = tick - r[6];
            if (k > 0 && k < S.MOVE) {
              const s = k / S.MOVE, vx = (S.laneX(r[7]) - S.laneX(r[1])) * 6 * s * (1 - s) / (S.MOVE * S.DT);
              const yaw = -Math.atan2(vx, S.LANE_V[r[1]]);
              c = Math.cos(yaw); sn = Math.sin(yaw);
            }
            const sig = S.signalAt(r, tick), T = S.TYPES[t], y = lampYOf[t], hl = T.L / 2;
            if (sig !== 0 && ((tick - r[6] + S.SIGNAL) * S.DT * BLINK_HZ) % 1 < 0.5) {
              const ox = sig * (T.W / 2 - 0.12);
              tLamp(lx, -dz, c, sn, ox, y - 0.1, hl + 0.02, AMBER_L, AMBER_H, 0.9, 0.6);
              tLamp(lx, -dz, c, sn, ox, y - 0.1, -hl - 0.02, AMBER_L, null, 0, 0);
            }
            if (S.brakingAt(r, tick)) {
              for (let s2 = -1; s2 <= 1; s2 += 2) tLamp(lx, -dz, c, sn, s2 * (T.W / 2 - 0.25), y, hl + 0.03, RED_L, RED_H, 1.3, 0.7);
            }
          }
          tm.mat[o] = c; tm.mat[o + 2] = -sn; tm.mat[o + 8] = sn; tm.mat[o + 10] = c;
          tm.mat[o + 12] = lx; tm.mat[o + 14] = -dz;
          const pc = paintLin[((r[5] % 10) + 10) % 10];
          tm.col[n * 3] = pc.r; tm.col[n * 3 + 1] = pc.g; tm.col[n * 3 + 2] = pc.b;
          if (ns < SHADOW_CAP) {
            const T = S.TYPES[t], so = ns * 16;
            shm[so] = T.W * 1.25; shm[so + 10] = T.L * 1.1; shm[so + 12] = lx; shm[so + 14] = -dz;
            ns++;
          }
        }
      }
    }
    tLamps.count = TL.n; tLamps.visible = TL.n > 0;
    tHalos.count = TL.h; tHalos.visible = TL.h > 0;
    if (TL.n) { upload(tLamps.instanceMatrix, TL.n * 16); upload(tLamps.instanceColor, TL.n * 3); }
    if (TL.h) { upload(tHalos.instanceMatrix, TL.h * 16); upload(tHalos.instanceColor, TL.h * 3); }
    for (let t = 0; t < tmesh.length; t++) {
      const tm = tmesh[t], n = tcount[t];
      tm.paint.count = tm.det.count = n;
      tm.paint.visible = tm.det.visible = n > 0;
      if (n) {
        const im = tm.paint.instanceMatrix, ic = tm.paint.instanceColor;
        upload(im, n * 16); upload(ic, n * 3);
      }
    }

    /* the players */
    if (crashOn) {
      K.crashT += dt;
      K.crashYaw += K.crashW * dt;
      K.crashW *= Math.exp(-dt * 2.6);
      if (fol.alive !== false && K.crashT > 0.5 && crashSide === side) clearCrash();
    }
    if (crashPending) { crashPending = false; startCrash(fol, traffic, tick, side); }
    const carF = cars[side], carO = cars[1 - side];
    const wheel = f.steer == null ? null : clamp(+f.steer || 0, -1, 1);
    poseCar(carF, fol, z0, false, wheel === null ? 0 : wheel, dt, wheel);
    poseCar(carO, oth, z0, true, null, dt, null);
    ns = carShadow(carF, ns); ns = carShadow(carO, ns);
    shadows.count = ns; shadows.visible = ns > 0;
    if (ns) upload(shadows.instanceMatrix, ns * 16);

    /* effects */
    if (nmPending !== null) {
      nmSide = nmPending || nearSideFrom(fol, traffic, tick) || (rand() < 0.5 ? -1 : 1);
      nmPending = null; K.nmT = NM_LEN;
      for (let j = 0; j < BURSTS; j++) {
        const i = STREAKS + j;
        sx[i] = nmSide * (1.4 + rand() * 1.3); sy[i] = -1.1 + rand() * 1.6; sz[i] = -2 - rand() * 14; sr[i] = rand();
      }
    }
    if (K.nmT > 0) K.nmT = Math.max(0, K.nmT - dt);
    const v = fol.alive === false ? 0 : (fol.v || 0);
    stepStreaks(dt, v, side);
    stepParts(dt, z0);

    /* the camera: behind and above, lagging on x, wider and shakier with speed */
    const aspect = camera.aspect;
    const port = clamp01((1.25 - aspect) / 0.75);
    const sp = clamp01((v * 3.6 - 100) / 180);
    let want = 62 + 16 * sp;
    const hMin = (50 + 10 * sp) * DEG;
    const fromH = 2 * Math.atan(Math.tan(hMin / 2) / aspect) / DEG;
    if (fromH > want) want = Math.min(fromH, 100);
    const toH = 2 * Math.atan(Math.tan((96 + 8 * sp) * DEG / 2) / aspect) / DEG;
    if (toH < want) want = toH;                       // a very wide screen: keep the sides from stretching
    const nm = K.nmT > 0 ? Math.sin(Math.PI * (1 - K.nmT / NM_LEN)) : 0;
    want += nm * 2.5;
    if (snap) { K.fov = want; K.camX = fol.x; K.lookX = fol.x; K.camRoll = 0; K.camOffZ = 0; }
    K.fov += (want - K.fov) * ease(dt, 4);
    K.camX += (fol.x - K.camX) * ease(dt, 5);
    K.lookX += (fol.x - K.lookX) * ease(dt, 9);
    K.camOffZ *= Math.exp(-dt * 3.5);
    if (Math.abs(K.camOffZ) < 0.01) K.camOffZ = 0;
    K.camRoll += ((crashOn ? 0 : clamp(+f.steer || 0, -1, 1)) - K.camRoll) * ease(dt, 5);
    const ch = 2.6 + 3.4 * port, cb = 6.5 + 3.5 * port, la = 12 + 2 * port;
    const shake = 0.004 + 0.028 * sp * sp;
    const n1 = Math.sin(K.time * 31.7) * 0.6 + Math.sin(K.time * 17.3 + 1.2) * 0.4;
    const n2 = Math.sin(K.time * 27.1 + 0.5) * 0.6 + Math.sin(K.time * 13.9 + 2.1) * 0.4;
    let jx = n1 * shake, jy = n2 * shake;
    if (K.shakeCrash > 0.001) {
      jx += (rand() - 0.5) * 0.7 * K.shakeCrash; jy += (rand() - 0.5) * 0.5 * K.shakeCrash;
      K.shakeCrash *= Math.exp(-dt * 3.2);
    }
    camera.fov = K.fov;
    camera.updateProjectionMatrix();
    /* A shift: the camera dips with the nose, then is pulled back a touch as the car surges. */
    const lt = K.lurchT, lk = K.lurchDir > 0 ? 1 : 0.4;
    const camDip = lt < 0.12 ? 0.05 * lk * Math.sin(Math.PI * lt / 0.12) : 0;
    const camPull = lt < 0.34 ? 0.2 * lk * Math.sin(Math.PI * clamp01((lt - 0.05) / 0.29)) : 0;
    camera.position.set(K.camX + jx - nm * nmSide * 0.1, ch + jy - camDip, K.camOffZ + cb + camPull);
    camera.lookAt(K.lookX + jx * 0.5, 0.65 - 0.25 * port, K.camOffZ - la);
    camera.rotateZ(-K.camRoll * 0.022);
    snap = false;

    sky.position.copy(camera.position);
    backdrop.position.set(camera.position.x, 0, camera.position.z);

    /* a frame that stays slow drops the pixel ratio a step (never mid-burst) */
    if (adaptive) {
      K.slowEma += (Math.min(dt, 0.05) - K.slowEma) * 0.04;
      K.adaptCool -= dt;
      if (K.adaptCool <= 0 && K.slowEma > 1 / 48 && dpr > minDpr + 0.01) {
        dprDrop += 0.25; K.adaptCool = 3; K.slowEma = 1 / 60; resize();
      }
    }

    renderer.info.reset();
    renderer.render(scene, camera);
  }

  function clearCrash() {
    crashOn = false; crashPending = false; K.crashT = 0; K.crashYaw = 0; K.crashW = 0; K.shakeCrash = 0;
    partsAlive = 0; parts.count = 0; parts.visible = false;
    for (let i = 0; i < PARTS; i++) P.life[i] = 0;
  }

  resize();
  // compile every program now (solid and ghost), not on the first frames of the race
  for (const im of [parts, streaks, shadows, rocks, buttes, trees, gantries, tLamps, tHalos, ...tmesh.flatMap((t) => [t.paint, t.det])]) im.visible = true;
  for (const c of cars) { c.group.visible = true; c.ind[0].visible = c.ind[1].visible = c.brake.visible = true; }
  renderer.compile(scene, camera);
  for (const c of cars) { c.paint.material = c.ghost; c.det.material = detGhost; }
  renderer.compile(scene, camera);
  for (const c of cars) {
    c.paint.material = c.solid; c.det.material = detSolid; c.group.visible = false;
    c.ind[0].visible = c.ind[1].visible = c.brake.visible = false;
  }
  for (const im of [parts, streaks, shadows, tLamps, tHalos, ...tmesh.flatMap((t) => [t.paint, t.det])]) im.visible = false;

  return {
    resize,
    frame,
    nearMiss(side) { nmPending = side === 1 || side === -1 ? side : 0; },
    crash() { crashPending = true; },
    /* Each seat's look, by seat: [{ car: 'supercar' | 'muscle' | 'hatch', paint: '#rrggbb' }, ...]. Swaps the
       model and the paint, nothing else (looks never reach the step). */
    setLooks(list) {
      for (const car of cars) {
        const l = list && list[car.side];
        const m = (l && MODELS[l.car]) || MODELS.supercar;
        car.paint.geometry = m.paint; car.det.geometry = m.det;
        const hex = l && typeof l.paint === 'string' && /^#[0-9a-f]{6}$/i.test(l.paint) ? parseInt(l.paint.slice(1), 16) : SIDE_PAINT[car.side];
        sidePaint[car.side] = hex;
        car.solid.color.setHex(hex); car.solid.emissive.setHex(hex).multiplyScalar(0.12);
        car.ghost.color.setHex(hex); car.ghost.emissive.setHex(hex).multiplyScalar(0.2);
      }
    },
    /* A gear change heard on the car being followed: 1 up (the lurch), -1 down (a softer dip). */
    shift(dir) { K.lurchT = 0; K.lurchDir = dir > 0 ? 1 : -1; },
    /* A backfire on a seat's car: n 0 is one flame now (your own car, on each bang heard), else a run of n. */
    backfire(side, n) {
      const car = cars[side === 1 ? 1 : 0];
      if (!n) { car.flameT = 0.09 + rand() * 0.05; return; }
      car.flameLeft = Math.min(7, n); car.flameNext = 0;
    },
    reset() {
      clearCrash();
      K.nmT = 0; nmPending = null; snap = true;
      for (const c of cars) { c.lastV = -1; c.roll = c.pitch = c.acc = 0; c.blinkSide = 0; c.blinkHold = 0; c.flameT = 0; c.flameLeft = 0; }
      K.rev = 0; K.lurchT = 9;
    },
    info() {
      const r = renderer.info;
      return { looks: cars.map(c => ({ car: Object.keys(MODELS).find(k => MODELS[k].paint === c.paint.geometry), paint: '#' + c.solid.color.getHexString() })),
               calls: r.render.calls, triangles: r.render.triangles, dpr, programs: r.programs ? r.programs.length : 0, geometries: r.memory.geometries, textures: r.memory.textures };
    },
    dispose() {
      for (const d of disposables) if (d && d.dispose) d.dispose();
      for (const t of tmesh) { t.paint.dispose(); t.det.dispose(); }
      for (const im of [shadows, streaks, parts, rocks, buttes, trees, gantries, tLamps, tHalos]) im.dispose();
      renderer.dispose();
    },
    renderer, scene, camera,
  };
}
