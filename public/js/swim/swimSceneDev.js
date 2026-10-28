/* The dev page's driver (public/dev-swim-scene.html): fake traffic and a weaving car for the perf script. */
import { createScene } from '/js/swim/swimScene.js';

const S = window.SwimSim;
const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? +q.get(k) : d);
const SECS = num('secs', 0), SYNC = q.get('sync') === '1', FIXED = q.get('fixed') === '1', DEMO = q.get('demo') === '1';
const CRASH_AT = num('crashAt', -1);
const hud = document.getElementById('hud');
if (q.get('hud') === '0') hud.hidden = true;

const canvas = document.getElementById('c');
const opts = { adaptive: q.get('adaptive') !== '0' };
if (q.has('maxdpr')) opts.maxPixelRatio = +q.get('maxdpr');
if (q.has('aa')) opts.antialias = q.get('aa') === '1';
const scene = createScene(canvas, opts);
addEventListener('resize', () => scene.resize());
const gl = scene.renderer.getContext();
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const GPU = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a';

/* ── made-up traffic, filled lane by lane to 520 m past the leader, the gap
   shrinking from ~95 m towards 17 m with race time like the server's ── */
const rand = S.rng(num('seed', 7));
let traffic = new S.Traffic(), nextId = 1, last = [null, null, null, null], need = [0, 0, 0, 0];
function laneGap(t) { return 17 + 78 * 75 / (75 + t); }
function pickType(lane, t) {
  const big = lane >= 2, later = t / (t + 120);
  let total = 0; const w = S.TYPES.map((T) => { const k = T.right && !big ? 0 : T.right ? T.w * (1 + 0.8 * later) : T.w; total += k; return k; });
  let x = rand() * total;
  for (let i = 0; i < w.length; i++) { x -= w[i]; if (x < 0) return i; }
  return 0;
}
function fill(tick, leadZ, raceT) {
  const tk = Math.round(tick);
  for (let l = 0; l < S.LANES; l++) {
    for (let guard = 0; guard < 40; guard++) {
      const lst = last[l];
      const back = lst ? S.zAt(lst, tk) + S.TYPES[lst[2]].L / 2 : leadZ - 60;
      const type = pickType(l, raceT);
      const z = back + need[l] + S.TYPES[type].L / 2;
      if (z > leadZ + 520) break;
      const rec = [nextId++, l, type, Math.round(z * 100) / 100, tk, Math.floor(rand() * 10)];
      traffic.add(rec); last[l] = rec;
      need[l] = laneGap(raceT) * (0.55 + rand() * 0.9);
    }
  }
}

/* ── two fake drivers: pick the lane with the most room, steer like the sim ── */
function driver(side, phase) {
  return { side, phase, z: 0, x: S.laneX(side ? 2 : 1), v: 40, vx: 0, alive: true, lane: side ? 2 : 1, next: 0, steer: 0 };
}
const me = driver(0, 0), op = driver(1, 2.1);
function drive(c, t, tick, dt) {
  if (!c.alive) { c.steer = 0; return; }
  c.v = (185 + 65 * Math.sin(t * 0.21 + c.phase)) / 3.6;
  if (t >= c.next) {
    let best = c.lane, room = -1;
    for (let l = 0; l < S.LANES; l++) {
      if (Math.abs(l - c.lane) > 1) continue;
      const r = traffic.aheadIn(l, c.z, tick);
      const d = r ? S.zAt(r, tick) - S.TYPES[r[2]].hl - c.z : 999;
      const score = d + (l === c.lane ? 25 : 0) + rand() * 10;
      if (score > room) { room = score; best = l; }
    }
    c.lane = best; c.next = t + 0.5 + rand() * 0.9;
  }
  const want = clamp((S.laneX(c.lane) - c.x) * 0.9 - c.vx * 0.18, -1, 1);
  c.steer = want;
  const tv = want * S.vxMax(c.v), dv = S.vxAcc(c.v) * dt;
  c.vx = c.vx < tv ? Math.min(tv, c.vx + dv) : Math.max(tv, c.vx - dv);
  c.x = clamp(c.x + c.vx * dt, -S.WALL, S.WALL);
  c.z += c.v * dt;
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

let raceT = num('t', 20), tick = raceT * 60, followSide = num('side', 0) === 1 ? 1 : 0;
// start both cars 0 m in at race time t: the traffic is laid round them
fill(tick, 0, raceT);
let nextNear = 2.5, crashed = false;

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'n') scene.nearMiss();
  if (k === 'c') doCrash();
  if (k === 'r') { me.alive = true; crashed = false; scene.reset(); }
  if (k === 'f') followSide = 1 - followSide;
  if (k === 'h') hud.hidden = !hud.hidden;
});
function doCrash() { if (crashed) return; crashed = true; me.alive = false; scene.crash(); }

/* ── measurement: rAF intervals (with sync=1 each includes the GPU finishing) ── */
const RING = 4096, deltas = new Float32Array(RING), cpu = new Float32Array(RING);
let nd = 0, frames = 0, measureFrom = -1, t0 = performance.now(), lastNow = t0;
const px = new Uint8Array(4);
const view = { follow: { z: 0, x: 0, v: 0, vx: 0, alive: true, brake: false }, other: { z: 0, x: 0, v: 0, vx: 0, alive: true, brake: false } };
window.__swimPerf = { done: false };
function stats() {
  const n = Math.min(nd, RING), a = Array.from(deltas.subarray(0, n)).sort((x, y) => x - y), b = Array.from(cpu.subarray(0, n)).sort((x, y) => x - y);
  const mean = a.reduce((s, x) => s + x, 0) / Math.max(1, n), pick = (arr, p) => arr.length ? +arr[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(2) : 0;
  const inf = scene.info();
  return { fps: +(1000 / mean).toFixed(1), frameMs: { mean: +mean.toFixed(2), p50: pick(a, 0.5), p95: pick(a, 0.95), p99: pick(a, 0.99), max: pick(a, 1) },
    jsMs: { p50: pick(b, 0.5), p95: pick(b, 0.95) }, calls: inf.calls, triangles: inf.triangles, dpr: inf.dpr, programs: inf.programs,
    canvas: canvas.width + 'x' + canvas.height, gpu: GPU, frames: n, traffic: traffic.size };
}

function loop(now) {
  const dtReal = (now - lastNow) / 1000; lastNow = now;
  const dt = FIXED ? 1 / 60 : Math.min(0.1, dtReal);
  const c0 = performance.now();
  raceT += dt; tick += dt * 60;
  drive(me, raceT, tick, dt); drive(op, raceT, tick, dt);
  if (me.alive) op.z = me.z + 11 + 9 * Math.sin(raceT * 0.23);   // keep the other car nearby, mostly just ahead
  if (frames % 20 === 0) { fill(tick, Math.max(me.z, op.z), raceT); traffic.prune(Math.min(me.z, op.z) - 60, Math.floor(tick)); }
  if (DEMO && raceT - num('t', 20) > nextNear) { nextNear += 2.5; scene.nearMiss(); }
  if (CRASH_AT >= 0 && !crashed && raceT - num('t', 20) > CRASH_AT) doCrash();
  const a = followSide === 0 ? me : op, b = followSide === 0 ? op : me;
  const F = view.follow, O = view.other;
  F.z = a.z; F.x = a.x; F.v = a.alive ? a.v : 0; F.vx = a.vx; F.alive = a.alive;
  O.z = b.z; O.x = b.x; O.v = b.alive ? b.v : 0; O.vx = b.vx; O.alive = b.alive;
  // brake lamps while a fake driver's speed curve is falling, so the perf numbers include them
  F.brake = Math.cos(raceT * 0.21 + a.phase) < 0; O.brake = Math.cos(raceT * 0.21 + b.phase) < 0;
  scene.frame({ follow: F, other: O, followSide, traffic, tick, dt, steer: a.steer });
  if (SYNC) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const c1 = performance.now();
  frames++;
  const el = (now - t0) / 1000;
  if (measureFrom < 0 && el > 1.5) measureFrom = now;
  if (measureFrom >= 0 && !window.__swimPerf.done) {
    deltas[nd % RING] = dtReal * 1000; cpu[nd % RING] = c1 - c0; nd++;
    if (SECS > 0 && now - measureFrom > SECS * 1000) Object.assign(window.__swimPerf, stats(), { done: true });
  }
  if (!hud.hidden && frames % 30 === 0) {
    if (nd > 30 && !window.__swimPerf.done) Object.assign(window.__swimPerf, stats());
    const s = window.__swimPerf, inf = scene.info();
    hud.textContent = `${Math.round(a.v * 3.6)} km/h  z ${a.z.toFixed(0)} m  traffic ${traffic.size}\n` +
      `calls ${inf.calls}  tris ${inf.triangles}  dpr ${inf.dpr}\n` +
      (s.fps ? `fps ${s.fps}  p50 ${s.frameMs.p50} ms  p95 ${s.frameMs.p95} ms\n` : '') +
      `N near miss  C crash  R reset  F follow other`;
  }
  requestAnimationFrame(loop);
}
/* A small PNG of the current picture, drawn straight after a frame (no preserveDrawingBuffer needed). */
window.__snap = (w, levels) => new Promise((res) => requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const c = document.createElement('canvas'), k = w / canvas.width;
    c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
    // render one more frame so the drawing buffer is fresh in this task
    const F = view.follow;
    scene.frame({ follow: F, other: view.other, followSide, traffic, tick, dt: 1 / 60, steer: (followSide ? op : me).steer });
    g.drawImage(canvas, 0, 0, c.width, c.height);
    if (levels) {   // fewer shades per channel: a much smaller PNG for notes
      const im = g.getImageData(0, 0, c.width, c.height), d = im.data, k = 255 / (levels - 1);
      const B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];   // 4x4 ordered dither: no banding in the sky
      for (let i = 0; i < d.length; i += 4) {
        const p = i >> 2, t = (B[((p / c.width | 0) & 3) * 4 + (p % c.width & 3)] / 16 - 0.47) * k;
        for (let j = 0; j < 3; j++) d[i + j] = Math.max(0, Math.min(255, Math.round(Math.round((d[i + j] + t) / k) * k)));
      }
      g.putImageData(im, 0, 0);
    }
    res(c.toDataURL('image/png'));
  });
}));
window.__dev = { me, op, scene, get raceT() { return raceT; } };
requestAnimationFrame(loop);
