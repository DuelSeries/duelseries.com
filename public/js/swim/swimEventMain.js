/* ─── Swim Race, the page ─────────────────────────────────────────────────────
   The scheduled race (server/swim/SwimEvent.js): wait for the start, race on a
   road with one lane per racer, and watch once you are out. The duel's page
   (swimMain.js) is the model for everything a car does here: the same step on
   our own inputs at once, corrected to the server's copy (se:me), every other
   car drawn from the server's rows (se:s) carried forward to the moment on
   screen. It decides nothing: the server says who is out and who won.

   ONE STREAM. Every car's row comes in se:s, ten a second, exactly (the
   event's cars are kept on a grid after every step, shared/swimSim.js
   quantize, here as on the server); our own row is how our prediction is
   checked. A row that is not what we predicted for its tick (a late input, a
   crash we did not see) is taken, and our inputs since are replayed on it.

   Opened from the Events tab: Join sets sessionStorage seJoin, so the page
   joins on connect; Spectate opens it bare, and it just watches.

   THE LOBBY (Owen 2026-10-30). Join any time between races: your car waits
   parked on the start line in your own lane, every other car that joined
   parked beside it, the road as wide as the field so far, and a banner says
   "Waiting for players to join" with how many are in and the time to the
   start. Nothing moves until the countdown, but the gas revs the engine (Owen:
   rev it up while you wait): the revs climb and fall, the body rocks, the pipes
   pop. The owner gets a small bar to run a test race (the server checks it is
   him on every press).

   SOUND (Owen 2026-10-30). Your own engine, or the watched car's when you are
   out or watching, and the cars around it heard where they are: the nearest few
   get an engine each, panned to their side and quieter with distance
   (swimSound.js, f.others). */
import { createScene } from './swimScene.js';

const S = window.SwimSim;
const $ = (id) => document.getElementById(id);
const socket = io();
if (window.DSPerfHud) window.DSPerfHud.mount({ socket });
const SOUND = window.SwimSound || { play() {}, frame() {}, stop() {} };
const LOOKS = window.DS_SWIM_LOOKS || null;
const R = 1024;                       // ticks of input and state kept for replay
const TOUCH = (() => { try { return matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window; } catch (_) { return false; } })();
/* What a frame draws (measured 2026-10-30, 50 lanes, scripts/swimEventPerf.js): a phone's narrow view sees fewer
   lanes, and its CPU is the limit, so it draws traffic five lanes either side of the camera, a computer ten. */
const GHOSTS = TOUCH ? 7 : 11;        // other cars drawn at once, the nearest
const LANE_SPAN = TOUCH ? 5 : 10;     // lanes either side of the camera whose traffic is drawn
if (TOUCH) document.body.classList.add('touch');


const myName = (() => { try { return sessionStorage.getItem('playerName') || localStorage.getItem('duelseries_playername') || 'Player'; } catch (_) { return 'Player'; } })();
const myWallet = (() => { try { return localStorage.getItem('duelseries_wallet') || null; } catch (_) { return null; } })();
const WANT_JOIN = (() => {
  try { const v = sessionStorage.getItem('seJoin'); sessionStorage.removeItem('seJoin'); return v === '1'; }
  catch (_) { return false; }
})();
/* Product tracking (public/js/shared/dsTrack.js, every name in shared/trackPlan.js): this page as a free Swim game
   in 'event' mode: the race started, how it ended for us (place of the field), or watching. Never breaks the game. */
const TRACKER = (() => { try { return window.DSTrack ? window.DSTrack.game('swim', { paid: false, stake: 0, mode: 'event' }) : null; } catch (_) { return null; } })();
function track(step, arg) { try { if (TRACKER) TRACKER[step](arg); } catch (_) { /* analytics never breaks the game */ } }
function myLook() {
  let car = null;
  try { car = localStorage.getItem(LOOKS ? LOOKS.KEY : ''); } catch (_) {}
  return LOOKS ? LOOKS.clean({ car }) : { car: 'supercar' };
}
const paintHex = (car) => (LOOKS ? LOOKS.paintOf(car) : '#e2363f');
const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const metres = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.max(0, Math.round(m)) + ' m');

/* ── the road: one scene for the page, as wide as the field (setLanes) ──── */
let scene = null, noGl = false;
function sceneFor(lanes) {
  if (noGl) return null;
  if (scene) { scene.setLanes(lanes); return scene; }
  try {
    scene = createScene($('road'), { touch: TOUCH, lanes, ghosts: GHOSTS, laneSpan: LANE_SPAN, trafficCap: TOUCH ? 90 : 150, shadowCap: TOUCH ? 220 : 360 });
  } catch (e) {
    console.error('[swimrace] no WebGL:', e);
    noGl = true; scene = null;
    $('nogl').hidden = false; $('wait').hidden = true;
  }
  return scene;
}
sceneFor(8);
$('noglBack').addEventListener('click', () => toLobby());
window.addEventListener('resize', () => { if (scene) scene.resize(); });

/* ── the server's clock (the duel's) ───────────────────────────────────── */
const clock = { off: null, want: null, samples: [], rtt: 0 };
const serverNow = () => performance.now() + (clock.off === null ? 0 : clock.off);
const ping = () => socket.emit('se:ping', { c: performance.now() });
socket.on('se:pong', ({ c, s } = {}) => {
  const r = performance.now(), rtt = r - c;
  if (!(rtt >= 0) || rtt > 4000 || !Number.isFinite(s)) return;
  clock.samples.push({ rtt, off: s - (c + r) / 2 });
  if (clock.samples.length > 12) clock.samples.shift();
  const best = clock.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  clock.want = best.off; clock.rtt = best.rtt;
  if (clock.off === null) clock.off = best.off;
});
function pingBurst() { for (let i = 0; i < 5; i++) setTimeout(ping, i * 120); }
function slewClock() {
  if (clock.want === null || clock.off === null) return;
  const d = clock.want - clock.off;
  clock.off += Math.abs(d) > 250 ? d : Math.max(-0.5, Math.min(0.5, d));
}
setInterval(() => { if (race && race.state !== 'over') ping(); }, 2000);

/* ── the controls (the duel's) ─────────────────────────────────────────── */
const keys = new Set();
const KEYMAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
addEventListener('keydown', (e) => {
  const k = KEYMAP[e.code];
  const mine = (race && race.me !== null && !race.out && race.state !== 'over') || (joined && (!race || race.state === 'over'));
  if (k && mine) { keys.add(k); e.preventDefault(); }
});
addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keys.delete(k); });
addEventListener('blur', () => keys.clear());
const touch = { steer: 0, id: null, x0: 0, gas: false, brake: false };
(function pads() {
  const zone = $('steerZone'), knob = $('steerKnob');
  zone.addEventListener('pointerdown', (e) => {
    touch.id = e.pointerId; touch.x0 = e.clientX; touch.steer = 0;
    knob.style.left = e.clientX + 'px'; knob.style.top = (e.clientY - zone.getBoundingClientRect().top) + 'px';
    knob.classList.add('on');
    try { zone.setPointerCapture(e.pointerId); } catch (_) {}
  });
  zone.addEventListener('pointermove', (e) => { if (e.pointerId === touch.id) touch.steer = Math.max(-1, Math.min(1, (e.clientX - touch.x0) / 56)); });
  const end = (e) => { if (e.pointerId !== touch.id) return; touch.id = null; touch.steer = 0; knob.classList.remove('on'); };
  zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
  const hold = (btn, key) => {
    const on = (v) => (e) => { touch[key] = v; btn.classList.toggle('on', v); if (e && e.cancelable) e.preventDefault(); };
    btn.addEventListener('pointerdown', on(true));
    btn.addEventListener('pointerup', on(false)); btn.addEventListener('pointercancel', on(false)); btn.addEventListener('pointerleave', on(false));
  };
  hold($('gas'), 'gas'); hold($('brake'), 'brake');
})();
function controls() {
  /* A headless check's driver (scripts/swimEventPerf.js) can steer this page's own car; it is only ever this page's
     own wheel and pedal, which the server checks like any other. */
  if (typeof window.__swimraceDriver === 'function') {
    try { const d = window.__swimraceDriver(); if (d) return { steer: +d.steer || 0, pedal: d.pedal > 0 ? 1 : d.pedal < 0 ? -1 : 0 }; } catch (_) {}
  }
  const steer = touch.id !== null ? touch.steer : (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
  const pedal = (keys.has('up') || touch.gas ? 1 : 0) - (keys.has('down') || touch.brake ? 1 : 0);
  return { steer, pedal };
}

/* ── the race ─────────────────────────────────────────────────────────── */
let race = null;
let lobby = { n: 0, max: 50, min: 8, open: false, names: [] };
let joined = false, seatKey = null, live = null;
/* race = { id, lanes, goAt, state, traffic, seats: Map seat -> { seat, name, car, look, out },
            me (my seat or null), car (my predicted car), inputs, hist, sentTo, rows: Map seat -> row,
            disp: Map seat -> { z, x }, out (my place once out), follow (seat watched), ... } */
function newRace(m) {
  const lanes = Number(m.lanes) || 8;
  const traffic = new S.Traffic(lanes);
  for (const rec of m.cars || []) traffic.add(rec);
  const seats = new Map();
  for (const p of m.seats || []) {
    const car = LOOKS ? LOOKS.carOf(p.car) : 'supercar';
    seats.set(p.seat, { seat: p.seat, name: String(p.name || 'Player'), car, look: { car, paint: paintHex(car) }, out: Number(p.out) || 0 });
  }
  const r = {
    id: m.id, lanes, goAt: Number(m.goAt) || 0, state: m.state === 'racing' ? 'racing' : 'countdown', traffic, seats,
    winLead: Number(m.winLead) || 500, outBehind: Number(m.outBehind) || 1000,
    me: null, car: null, inputs: new Int16Array(R), hist: new Array(R).fill(null), sentTo: -1,
    rows: new Map(), disp: new Map(), views: new Map(), slowing: new Map(), out: 0, outAt: 0, outShown: false, follow: null, countShown: -1,
    closes: 0, topV: 0, startedAt: 0, corrections: 0, crashed: false, rev: 0, steer: 0, pedal: 0,
    seenUp: 0, seenDown: 0, seenPops: 0, placeWas: '', overMsg: null,
  };
  for (const row of m.p || []) takeRow(r, row);
  for (const k of m.ko || []) { const s = seats.get(k.seat); if (s) s.out = k.place; }
  if (clock.off === null && Number.isFinite(m.now)) clock.off = m.now - performance.now();
  if (window.SwimSound && SwimSound.state) { const st = SwimSound.state(); r.seenUp = st.up; r.seenDown = st.down; r.seenPops = st.pops; }
  sceneFor(lanes);
  if (scene) scene.reset();
  return r;
}
const tickNow = () => (race ? (serverNow() - race.goAt) / S.TICK_MS : 0);

/* My seat, from se:you: my car on the start line in its lane, and my look on the followed car. */
function seatMe(r, seat) {
  if (!r.seats.has(seat)) return;
  r.me = seat; r.follow = seat;
  const row = r.rows.get(seat);
  const c = S.quantize(S.newCar(0));
  c.x = row ? row[3] : S.quantize({ z: 0, v: 0, x: S.laneX(seat), vx: 0 }).x;
  if (row && row[1] > 0) { c.tick = row[1]; c.z = row[2]; c.v = row[4]; c.vx = row[5]; c.alive = !!row[6]; }
  r.car = c;
  r.hist[c.tick % R] = S.copyCar(c);
  if (scene && scene.followLook) scene.followLook(r.seats.get(seat).look);
}

const SLOWING = 7;
function takeRow(r, row) {
  if (!Array.isArray(row) || row.length < 7) return;
  const seat = row[0], prev = r.rows.get(seat);
  if (prev && prev[1] > row[1]) return;
  if (prev && row[1] > prev[1]) r.slowing.set(seat, (prev[4] - row[4]) / ((row[1] - prev[1]) * S.DT) > SLOWING);
  r.rows.set(seat, row);
  if (seat === r.me && r.car && !r.out) reconcile(r, row);
}

/* My own row, [seat, tick, z, x, v, vx, alive, wall, cool], exact (see the top). Not what I predicted for its
   tick: take it and replay my inputs since. */
function reconcile(r, a) {
  const me = r.car;
  if (!me || !Array.isArray(a) || a.length < 9) return;
  const t = a[1];
  const c = { tick: t, z: a[2], x: a[3], v: a[4], vx: a[5], alive: !!a[6], crashTick: a[6] ? -1 : t, hit: -1, wall: a[7] || 0, cool: a[8] || 0, close: -1 };
  if (t > me.tick) { r.car = c; r.hist[t % R] = S.copyCar(c); r.corrections++; return; }
  const h = r.hist[t % R];
  if (!h || h.tick !== t) return;
  if (h.alive === c.alive && h.cool === c.cool && h.z === c.z && h.x === c.x && h.v === c.v && h.vx === c.vx) return;
  r.hist[t % R] = S.copyCar(c);
  for (let k = t; k < me.tick; k++) { S.quantize(S.step(c, r.inputs[k % R], r.traffic)); r.hist[(k + 1) % R] = S.copyCar(c); }
  const wasDead = !me.alive;
  r.car = c; r.corrections++;
  if (wasDead && c.alive && scene) { scene.reset(); r.crashed = false; }
}

function drive(r) {
  const target = Math.floor(tickNow()) + 1;
  if (target - r.car.tick > 30) { const row = r.rows.get(r.me); if (row) { r.car.tick = row[1]; r.car.z = row[2]; r.car.x = row[3]; r.car.v = row[4]; r.car.vx = row[5]; } return; }
  const offline = !socket.connected;
  const { steer, pedal } = offline || r.out ? { steer: 0, pedal: 0 } : controls();
  const code = S.packInput(steer, pedal);
  while (r.car.tick < target) {
    const c = r.car;
    r.inputs[c.tick % R] = code;
    const alive = c.alive;
    S.quantize(S.step(c, code, r.traffic));
    r.hist[c.tick % R] = S.copyCar(c);
    if (alive && c.alive && c.close >= 0) closePass(r);
    if (alive && !c.alive) crashed(r);
    if (c.wall !== 0 && steer * c.wall > 0) SOUND.play('sw.scrape', { vol: 0.8 });
  }
  r.steer = steer; r.pedal = pedal;
  if (r.car.v > r.topV) r.topV = r.car.v;
  const last = r.car.tick - 1;
  if (!offline && r.car.alive && !r.out && last >= 0 && last - r.sentTo >= 2) {
    const from = Math.max(0, last - 11, Math.min(r.sentTo + 1, last - 5));
    const k = [];
    for (let t = from; t <= last; t++) k.push(r.inputs[t % R]);
    socket.volatile.emit('se:in', { t: last, k });
    r.sentTo = last;
  }
}

let closeTimer = 0;
function closePass(r) {
  r.closes++;
  if (scene) scene.nearMiss();
  SOUND.play('sw.whoosh');
  const el = $('close');
  $('closeCount').textContent = r.closes > 1 ? 'x' + r.closes : '';
  el.hidden = false; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  clearTimeout(closeTimer); closeTimer = setTimeout(() => { el.hidden = true; }, 700);
  flash('close');
}
function flash(kind) { const f = $('flash'); f.className = ''; void f.offsetWidth; f.className = kind; }
function crashed(r) {
  if (r.crashed) return;
  r.crashed = true;
  if (scene) scene.crash();
  SOUND.play('g.death');
  flash('crash');
}

/* A car we only hear about, carried forward from its last row to tick `at` and eased onto that line. */
function remote(r, seat, at, dt) {
  const row = r.rows.get(seat);
  if (!row) return null;
  const going = !!row[6];
  const ahead = going ? Math.max(-6, Math.min(30, at - row[1])) : 0;
  const tz = row[2] + row[4] * ahead * S.DT;
  const tx = Math.max(r.traffic.wallL, Math.min(r.traffic.wallR, row[3] + row[5] * Math.min(ahead, 8) * S.DT));
  let d = r.disp.get(seat);
  if (!d || Math.abs(d.z - tz) > 40) { d = { z: tz, x: tx }; r.disp.set(seat, d); }
  else {
    d.z += row[4] * dt * (going ? 1 : 0); d.x += row[5] * dt * (going ? 1 : 0);
    d.z += (tz - d.z) * 0.22; d.x += (tx - d.x) * 0.22;
  }
  /* One object per seat, written in place each frame (no garbage at 60 a second for 50 cars). */
  const s = r.seats.get(seat);
  let o = r.views.get(seat);
  if (!o) { o = { z: 0, x: 0, v: 0, vx: 0, alive: true, brake: false, look: null, seat, d: 0 }; r.views.set(seat, o); }
  o.z = d.z; o.x = d.x; o.v = row[4]; o.vx = row[5]; o.alive = going; o.brake = going && !!r.slowing.get(seat); o.look = s ? s.look : null;
  return o;
}

/* Standings from the rows: cars still in by distance, then the cars out by the place they went out with. */
function standings(r, myZ) {
  const going = [], out = [];
  for (const [seat, s] of r.seats) {
    const row = r.rows.get(seat);
    if (s.out) { out.push({ seat, name: s.name, z: row ? row[2] : 0, place: s.out }); continue; }
    let z = row ? row[2] : 0;
    if (seat === r.me && myZ !== null) z = myZ;
    going.push({ seat, name: s.name, z });
  }
  going.sort((a, b) => b.z - a.z);
  going.forEach((g, i) => { g.place = i + 1; });
  out.sort((a, b) => a.place - b.place);
  return { going, out, all: going.concat(out) };
}

/* ── one frame ─────────────────────────────────────────────────────────── */
let lastFrame = performance.now();
const fpsWin = [];
let idleZ = 0;
const EMPTY = new S.Traffic(8);
const othersBuf = [], candBuf = [];
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  fpsWin.push(dt); if (fpsWin.length > 120) fpsWin.shift();
  slewClock();
  const r = race;
  let follow = null, steer = null, tickF = 0;
  othersBuf.length = 0;
  if (r && (r.state === 'countdown' || r.state === 'racing' || r.state === 'over')) {
    tickF = tickNow();
    if (r.state === 'countdown') countdown(r, tickF);
    const mine = r.car && !r.out;
    const revving = r.state === 'countdown' && mine;
    const gasHeld = revving && controls().pedal > 0;
    r.rev += ((gasHeld ? 1 : 0) - r.rev) * (1 - Math.exp(-dt / (gasHeld ? 0.22 : 0.35)));
    r.revving = revving; r.gasHeld = gasHeld;
    if (r.state === 'countdown' && tickF >= 0) { r.state = 'racing'; r.startedAt = performance.now(); }
    if (r.state === 'racing' && r.car && !r.out) drive(r);
    const at = tickF - 4;
    /* My own car, and for a moment after I am out, my crash. */
    if (r.car && (!r.out || performance.now() - r.outAt < 1300)) {
      const a = r.car, p = r.hist[(a.tick - 1 + R) % R];
      const alpha = Math.max(0, Math.min(1, tickF - (a.tick - 1)));
      const brake = r.state === 'racing' && r.pedal < 0;
      follow = p && p.tick === a.tick - 1 && a.alive
        ? { z: p.z + (a.z - p.z) * alpha, x: p.x + (a.x - p.x) * alpha, v: a.v, vx: a.vx, alive: a.alive, brake }
        : { z: a.z, x: a.x, v: a.v, vx: a.vx, alive: a.alive, brake };
      steer = r.steer || 0;
    } else {
      /* Watching (or out): the chosen car, else whoever leads. */
      if (r.follow === null || !r.seats.has(r.follow) || (r.seats.get(r.follow).out && r.state === 'racing' && !followPinned)) r.follow = leaderSeat(r);
      if (r.follow !== null) {
        const f = remote(r, r.follow, at, dt);
        if (f) { follow = f; if (scene && scene.followLook && f.look) scene.followLook(f.look); }
      }
    }
    if (follow) {
      /* The nearest other cars, as ghosts. */
      const cand = candBuf;
      cand.length = 0;
      sndBuf.length = 0;
      const mine = r.car && (!r.out || performance.now() - r.outAt < 1300) ? r.me : r.follow;
      for (const [seat, row] of r.rows) {
        if (seat === mine || row[2] - follow.z > 480 || follow.z - row[2] > 40) continue;   // nowhere near the picture
        const o = remote(r, seat, at, dt);
        if (o) heard(r, seat, o, follow);
        /* Nothing from behind: a ghost between the camera and our car only hides the road (the camera looks ahead). */
        if (!o || o.z - follow.z > 470 || follow.z - o.z > 2.5) continue;
        o.d = Math.abs(o.z - follow.z) + 3 * Math.abs(o.x - follow.x);
        cand.push(o);
      }
      cand.sort((a, b) => a.d - b.d);
      for (let i = 0; i < Math.min(GHOSTS, cand.length); i++) othersBuf.push(cand[i]);
      let minZ = Infinity;
      for (const [seat, row] of r.rows) if (row[6] && !(r.seats.get(seat) || {}).out) minZ = Math.min(minZ, row[2]);
      if (Number.isFinite(minZ)) r.traffic.prune(Math.min(minZ, follow.z) - 150, Math.floor(tickF));
      hud(r, follow);
    }
  }
  lobbyOn = false;
  if (!follow && (!r || r.state === 'over') && !overShown()) { follow = lobbyView(); lobbyOn = !!follow; }
  if (!follow) {
    idleZ += 26 * dt;
    follow = { z: idleZ, x: S.laneX(1), v: 26, vx: 0, alive: true };
  }
  /* The lobby: our car parked, the gas only revs it (as on the start line in the countdown). */
  const inLobby = lobbyOn && joined;
  if (inLobby) {
    const gas = controls().pedal > 0;
    LOB.rev += ((gas ? 1 : 0) - LOB.rev) * (1 - Math.exp(-dt / (gas ? 0.22 : 0.35)));
    LOB.gas = gas;
  } else LOB.rev = 0;
  const revving = !!(r && r.revving) || inLobby;
  const racingSound = !!(r && r.state === 'racing' && follow && follow.alive);
  const soundOn = racingSound || revving;
  const gasHeld = inLobby ? LOB.gas : !!(r && r.gasHeld);
  const watching = !!(r && !(r.car && !r.out));
  SOUND.frame({ on: soundOn, v: revving ? 0 : follow ? follow.v : 0, pedal: revving ? (gasHeld ? 1 : 0) : r && !watching ? r.pedal : 1, rev: revving,
    engine: watching && r.follow !== null && r.seats.has(r.follow) ? engineOf(r.seats.get(r.follow).car) : '',
    others: racingSound ? sndBuf : sndNone });
  const st = SOUND.state ? SOUND.state() : null;
  if (st && (inLobby || (r && r.car && !r.out))) engineMoments(inLobby ? LOB : r, st, inLobby);
  if (scene) scene.frame({ follow, others: othersBuf, followSide: 0, traffic: r && !lobbyOn ? r.traffic : EMPTY, tick: tickF, dt, steer,
    rev: inLobby ? LOB.rev : revving ? r.rev : 0 });
  if (inLobby) lobbyTach(st);
  else if (r) tach(r, st, follow);
  else if (!$('dash').hidden) $('dash').hidden = true;            // left the lobby: no rev counter
  const padsOff = !TOUCH || !(inLobby || (r && r.car && !r.out && r.state !== 'over'));
  if ($('pads').hidden !== padsOff) $('pads').hidden = padsOff;
  publish(r, follow);
}
/* The lobby on the road: every car that joined parked on the start line in its lane, ours solid with the camera
   behind it (or, before we join, the first car's), the others as ghosts, the road as wide as the field so far. */
const lobbyLooks = new Map();      // 'name|car' -> the look object the scene keeps (so it is not swapped each frame)
const lobbyCars = [];
function lookFor(name, car) {
  const k = name + '|' + car;
  let l = lobbyLooks.get(k);
  if (!l) { const c = LOOKS ? LOOKS.carOf(car) : 'supercar'; l = { car: c, paint: paintHex(c) }; lobbyLooks.set(k, l); }
  return l;
}
function lobbyView() {
  const cars = Array.isArray(lobby.cars) ? lobby.cars : [];
  if (!cars.length && !joined) return null;
  sceneFor(Math.max(lobby.min || 8, lobby.n || 0, myLane !== null ? myLane + 1 : 0));
  const meLane = joined && myLane !== null ? myLane : cars.length ? cars[0][0] : 1;
  const mine = cars.find(c => c[0] === meLane);
  const myL = joined ? lookFor(myName, myLook().car) : mine ? lookFor(mine[1], mine[2]) : lookFor('', 'supercar');
  if (scene && scene.followLook) scene.followLook(myL);
  lobbyCars.length = 0;
  for (const c of cars) {
    if (c[0] === meLane) continue;
    lobbyCars.push({ z: 0, x: S.laneX(c[0]), v: 0, vx: 0, alive: true, brake: false, look: lookFor(c[1], c[2]), d: Math.abs(c[0] - meLane) });
  }
  lobbyCars.sort((a, b) => a.d - b.d);
  for (let i = 0; i < Math.min(GHOSTS, lobbyCars.length); i++) othersBuf.push(lobbyCars[i]);
  return { z: 0, x: S.laneX(meLane), v: 0, vx: 0, alive: true, brake: false };
}
const overShown = () => !!(window.DSEnd && DSEnd.shown && DSEnd.shown());

let followPinned = false;
function leaderSeat(r) {
  let best = null, bz = -Infinity;
  for (const [seat, s] of r.seats) {
    if (s.out) continue;
    const row = r.rows.get(seat);
    if (row && row[2] > bz) { bz = row[2]; best = seat; }
  }
  if (best === null) for (const seat of r.seats.keys()) { best = seat; break; }
  return best;
}
/* The cars heard: every other car near the one the camera rides with, where it is from it (swimSound.js picks the
   nearest few). One object per seat, reused. */
const engineOf = (car) => (LOOKS ? LOOKS.engineOf(car) : 'v12');
const sndBuf = [], sndNone = [], sndBySeat = new Map();
function heard(r, seat, o, f) {
  const dz = o.z - f.z, dx = o.x - f.x;
  if (dz > 130 || dz < -130 || !o.alive) return;
  let h = sndBySeat.get(seat);
  if (!h) { h = { key: seat, engine: 'v12', v: 0, thr: 1, dx: 0, dz: 0, alive: true }; sndBySeat.set(seat, h); }
  const st = r.seats.get(seat);
  h.engine = st ? engineOf(st.car) : 'v12'; h.v = o.v; h.thr = o.brake ? -1 : 1; h.dx = dx; h.dz = dz; h.alive = true;
  sndBuf.push(h);
}
/* The lobby's revving: our own counts of what the engine did (shifts never happen in neutral; pops do). */
let lobbyOn = false;
const LOB = { rev: 0, gas: false, seenUp: 0, seenDown: 0, seenPops: 0, state: 'lobby' };
let lobTachWas = -1;
function lobbyTach(st) {
  const d = $('dash');
  if (d.hidden) d.hidden = false;
  if (!d.classList.contains('revving')) { d.classList.add('revving', 'mine'); revWas = null; }
  const k = st && st.rev > 0 ? Math.max(0, Math.min(1, (st.rev - 0.1) / 0.85)) : LOB.rev;
  const q = Math.round(k * 100);
  if (q !== lobTachWas) { lobTachWas = q; $('tachFill').style.width = q + '%'; $('tach').classList.toggle('red', q >= 88); }
  if (gearWas !== 'N') { gearWas = 'N'; $('gearNum').textContent = 'N'; $('gearNum').hidden = false; }
  $('spdNum').textContent = '0'; $('distText').textContent = 'On the start line';
}
function engineMoments(r, st, lobbyRev) {
  if (lobbyRev) {
    if (st.pops !== r.seenPops) {
      const n = Math.min(3, st.pops - r.seenPops);
      if (scene && scene.backfire && n > 0) for (let i = 0; i < n; i++) scene.backfire(0, 0);
      r.seenPops = st.pops;
    }
    r.seenUp = st.up; r.seenDown = st.down;
    return;
  }
  if (st.up !== r.seenUp) { if (scene && scene.shift && r.state === 'racing') scene.shift(1); r.seenUp = st.up; }
  if (st.down !== r.seenDown) { if (scene && scene.shift && r.state === 'racing') scene.shift(-1); r.seenDown = st.down; }
  if (st.pops !== r.seenPops) {
    const n = Math.min(3, st.pops - r.seenPops);
    if (scene && scene.backfire && n > 0) for (let i = 0; i < n; i++) scene.backfire(0, 0);
    r.seenPops = st.pops;
  }
}
let tachWas = -1, gearWas = '', revWas = null;
function tach(r, st, f) {
  const mine = !!(r.car && !r.out);
  const revving = mine && r.state === 'countdown';
  if (revving !== revWas) { $('dash').classList.toggle('revving', revving); $('dash').classList.toggle('mine', mine); revWas = revving; }
  let k = 0;
  if (mine) {
    if (st && st.rev > 0) k = Math.max(0, Math.min(1, (st.rev - 0.1) / 0.85));
    else k = revving ? r.rev : Math.max(0, Math.min(1, (f ? f.v : 0) / 97));
  }
  const q = Math.round(k * 100);
  if (q !== tachWas) { tachWas = q; $('tachFill').style.width = q + '%'; $('tach').classList.toggle('red', q >= 88); }
  const g = !mine ? '' : revving ? 'N' : st && st.gear > 0 ? String(st.gear) : '';
  if (g !== gearWas) { gearWas = g; const el = $('gearNum'); el.textContent = g; el.hidden = !g; }
}

/* ── where you stand ───────────────────────────────────────────────────── */
let hudAt = 0;
/* Every frame: text is only written when it changes, as the same text written again still costs a style and
   layout pass (phone speed pass 2026-10-31). */
function put(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
function hud(r, f) {
  put($('spdNum'), String(Math.round(f.v * 3.6)));
  put($('distText'), metres(f.z));
  const t = performance.now();
  if (t - hudAt < 120) return;                      // the board eight times a second is plenty
  hudAt = t;
  const mine = r.car && !r.out;
  const seat = mine ? r.me : r.follow;
  const sd = standings(r, mine ? f.z : null);
  const going = sd.going, n = r.seats.size;
  const meRow = sd.all.find(g => g.seat === seat);
  if (!meRow) return;
  const place = meRow.place;
  put($('placeNum'), ord(place));
  put($('placeOf'), (mine ? 'of ' : (r.seats.get(seat) ? r.seats.get(seat).name + ', ' : '') + 'of ') + n);
  const gl = $('gapLine');
  let text = '', lead = false;
  if (r.seats.get(seat) && r.seats.get(seat).out) text = 'Out';
  else if (going.length < 2) text = 'Last car left';
  else if (place === 1) {
    const by = going[0].z - going[1].z;
    lead = true;
    text = Math.round(by) + ' m clear, ' + Math.max(0, Math.round(r.winLead - by)) + ' to win';
  } else text = Math.round(going[0].z - meRow.z) + ' m behind ' + (mine ? 'the leader' : going[0].name);
  if (text !== r.placeWas) { gl.textContent = text; gl.classList.toggle('lead', lead); r.placeWas = text; }
  /* The duel's warning: nearly too far behind the leader to stay in. */
  const warn = $('warn'), back = going.length > 1 && place > 1 ? going[0].z - meRow.z : 0;
  if (mine && r.state === 'racing' && back > r.outBehind - 250) {
    warn.textContent = 'Catch up: ' + Math.max(0, Math.round(r.outBehind - back)) + ' m left';
    if (warn.hidden) { warn.hidden = false; SOUND.play('g.warn'); }
  } else if (!warn.hidden) warn.hidden = true;
  ribbon(r, going, seat);
}
/* The ribbon (Owen's pick, 2026-10-30): the last 500 m of road behind the leader, a dot for every car still in, yours
   gold, the win line at the right end. */
function ribbon(r, going, seat) {
  const box = $('ribbonDots');
  if (!going.length) { box.textContent = ''; return; }
  const top = going[0].z, span = r.winLead;
  while (box.children.length > going.length) box.lastChild.remove();
  while (box.children.length < going.length) box.append(document.createElement('i'));
  going.forEach((g, k) => {
    const i = box.children[k];
    const p = Math.max(0, Math.min(1, 1 - (top - g.z) / span));
    i.style.left = (p * 100).toFixed(2) + '%';
    i.className = g.seat === seat ? 'me' : '';
  });
}

/* The knockouts, newest on top; each fades after a few seconds. */
function feed(k) {
  const ol = $('feed');
  const li = document.createElement('li');
  const mine = race && k.seat === race.me;
  if (mine) li.className = 'me';
  const b = document.createElement('b');
  b.textContent = mine ? 'You' : String(k.name || 'Player');
  const why = k.why === 'left' ? ' left the race' : k.why === 'fell behind' ? ' fell 1 km behind' : ' crashed';
  const i = document.createElement('i');
  i.textContent = ord(k.place);
  li.append(b, document.createTextNode(why), i);
  ol.prepend(li);
  while (ol.children.length > 5) ol.lastChild.remove();
  setTimeout(() => { li.classList.add('gone'); setTimeout(() => li.remove(), 700); }, 5000);
}

function countdown(r, tickF) {
  const left = Math.ceil(-tickF * S.TICK_MS / 1000);
  const box = $('count'), num = $('countNum');
  if (left > 0 && left <= 10) {
    if (left !== r.countShown) {
      r.countShown = left;
      box.hidden = false; num.textContent = String(left);
      num.style.animation = 'none'; void num.offsetWidth; num.style.animation = '';
      if (left <= 3) SOUND.play('g.tick');
    }
  } else if (left <= 0 && r.countShown !== 0) { r.countShown = 0; box.hidden = true; SOUND.play('g.go'); }
}

let publishAt = 0;
function publish(r, f) {
  const now = performance.now();
  if (now - publishAt < 250) return;                // four times a second is plenty for a headless check
  publishAt = now;
  try {
    const avg = fpsWin.reduce((a, b) => a + b, 0) / Math.max(1, fpsWin.length);
    window.__swimrace = {
      state: r ? r.state : 'lobby', joined, lanes: r ? r.lanes : 0, me: r ? r.me : null, out: r ? r.out : 0,
      follow: r ? r.follow : null, tick: r ? Math.floor(tickNow()) : 0,
      car: r && r.car ? { z: r.car.z, x: r.car.x, v: r.car.v, alive: r.car.alive, tick: r.car.tick } : null,
      cars: r ? r.traffic.size : 0, seats: r ? r.seats.size : 0, ghosts: othersBuf.length,
      fps: avg > 0 ? Math.round(1 / avg) : 0, rtt: Math.round(clock.rtt || 0), corrections: r ? r.corrections : 0,
      scene: scene ? scene.info() : null, lobby, over: r ? r.overMsg : null, place: f ? $('placeNum').textContent : '',
    };
  } catch (_) {}
}
requestAnimationFrame(frame);
window.__swimraceTraffic = () => (race ? race.traffic : EMPTY);
window.__swimraceRace = () => race;

/* ── the start card (before joining) and the banner (after) ─────────────── */
let myLane = null, lobbyRecv = 0;
function startsIn() {
  if (lobby && Number.isFinite(lobby.startIn)) return Math.max(0, Math.round((lobby.startIn - (performance.now() - lobbyRecv)) / 1000));
  const L = live;
  return L && Number.isFinite(L.nextInSec) ? Math.max(0, L.nextInSec - Math.floor((Date.now() - liveAt) / 1000)) : null;
}
function clockText(secs) {
  if (secs === null) return '--:--';
  const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, x = secs % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0');
}
function paintLobby() {
  if (race && race.state !== 'over') { $('lobbyBar').hidden = true; return; }
  if (race && race.state === 'over' && overShown()) { $('wait').hidden = true; $('lobbyBar').hidden = true; return; }
  const secs = startsIn(), n = lobby.n || 0, L = live;
  /* Joined: the road shows our car parked; the banner says what we are waiting for. */
  $('wait').hidden = noGl || joined;
  $('lobbyBar').hidden = noGl || !joined;
  $('lbCount').textContent = n === 1 ? '1 joined' : n + ' joined';
  $('lbClock').textContent = secs === null ? '' : 'Starts in ' + clockText(secs);
  $('lbTest').hidden = !lobby.test;
  if (joined) return;
  $('seClock').textContent = clockText(secs);
  const when = $('seWhen');
  if (lobby.test) when.textContent = 'A test race, started by the owner';
  else if (L && Number.isInteger(L.startHour)) {
    const h12 = ((L.startHour + 11) % 12) + 1, ap = L.startHour < 12 ? 'AM' : 'PM';
    when.textContent = 'Starts at ' + h12 + ':' + String(L.startMin || 0).padStart(2, '0') + ' ' + ap + ' ET, every ' + (L.every || 6) + ' hours';
  } else when.textContent = '';
  $('seCount').textContent = String(n);
  $('seCountOf').textContent = (n === 1 ? 'racer in' : 'racers in') + (n >= lobby.max ? ', full' : '');
  const names = $('seNames');
  names.textContent = '';
  for (const nm of (lobby.names || []).slice(0, 24)) {
    const li = document.createElement('li');
    li.textContent = nm;
    names.append(li);
  }
  const btn = $('seJoin'), note = $('seNote');
  if (n >= lobby.max) { btn.hidden = true; note.textContent = 'Event full. Watch it from here when it starts.'; }
  else if (lobby.open !== false) {
    btn.hidden = false; btn.textContent = 'Join the race'; btn.classList.add('seGo');
    note.textContent = refusedNote || 'Free. Join any time before the start: your car waits on the start line in its own lane.';
  } else { btn.hidden = true; note.textContent = refusedNote || 'The game is updating. Back in a minute.'; }
}
let liveAt = 0, refusedNote = '';
function pullLive() {
  fetch('/api/live', { cache: 'no-store' }).then(r => r.json()).then(j => {
    if (j && j.swimEvent) { live = j.swimEvent; liveAt = Date.now(); if (!race) lobby.open = !!live.joinOpen; }
    paintLobby();
  }).catch(() => {});
}
pullLive();
setInterval(pullLive, 5000);
setInterval(paintLobby, 1000);

$('seJoin').addEventListener('click', () => join());
$('lbLeave').addEventListener('click', () => { socket.emit('se:leave'); joined = false; myLane = null; paintLobby(); });
$('seBack').addEventListener('click', () => toLobby());
function join() {
  refusedNote = '';
  const look = myLook();
  socket.emit('se:join', { name: myName, wallet: myWallet, car: look.car, v: S.VERSION });
}

/* ── the owner's test race ─────────────────────────────────────────────────
   Shown only to the owner: a device signed into Control (its session cookie, asked at /api/owner/session), or the
   lobby's wallet when the server says it is an owner's (then each press is signed in the lobby, over the bridge
   play.js keeps for game frames). Either way the server checks it on every press (/api/owner/do). */
const OWNER = { via: null, busy: false };
function ownerCheck() {
  fetch('/api/owner/session', { credentials: 'same-origin', headers: { 'X-DS-Owner': '1' } })
    .then(r => r.json()).then(j => {
      if (j && j.signedIn) { OWNER.via = 'session'; paintOwner(); return; }
      if (!myWallet || !window.parent || window.parent === window) return;
      return fetch('/api/br/owner', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: myWallet }) })
        .then(r => r.json()).then(k => { if (k && k.isOwner) { OWNER.via = 'wallet'; paintOwner(); } });
    }).catch(() => {});
}
function paintOwner() {
  const bar = $('ownerBar');
  if (!OWNER.via) { bar.hidden = true; return; }
  bar.hidden = false;
  const on = race && (race.state === 'countdown' || race.state === 'racing');
  $('ownOpen').hidden = !!on; $('ownStart').hidden = !!on; $('ownStop').hidden = !on;
  for (const id of ['ownOpen', 'ownStart', 'ownStop']) $(id).disabled = OWNER.busy;
}
let signId = 0;
function signInLobby(action) {
  return new Promise((resolve, reject) => {
    const id = 'se' + (++signId), origin = location.origin;
    const done = (e) => {
      const d = e.data;
      if (e.source !== window.parent || e.origin !== origin || !d || d.id !== id) return;
      window.removeEventListener('message', done);
      if (d.type === 'duel:signaction:done' && d.proof) resolve(d.proof); else reject(new Error(d.message || 'The wallet did not sign.'));
    };
    window.addEventListener('message', done);
    window.parent.postMessage({ type: 'duel:signaction', id, action, args: {} }, origin);
    setTimeout(() => { window.removeEventListener('message', done); reject(new Error('The wallet did not answer.')); }, 15000);
  });
}
function ownerDo(action) {
  if (OWNER.busy || !OWNER.via) return;
  OWNER.busy = true; paintOwner();
  const body = OWNER.via === 'session' ? Promise.resolve({ action, args: {} }) : signInLobby(action);
  body.then(b => fetch('/api/owner/do', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'X-DS-Owner': '1' }, body: JSON.stringify(b) }))
    .then(r => r.json().then(j => note(r.ok ? (j.note || 'Done') : (j.error || 'Refused'), 4000)))
    .catch(e => note((e && e.message) || 'Could not reach the server', 4000))
    .then(() => { OWNER.busy = false; paintOwner(); pullLive(); });
}
$('ownOpen').addEventListener('click', () => ownerDo('se:open'));
$('ownStart').addEventListener('click', () => ownerDo('se:start'));
$('ownStop').addEventListener('click', () => ownerDo('se:stop'));
ownerCheck();

/* ── the server ────────────────────────────────────────────────────────── */
socket.on('connect', () => {
  pingBurst();
  if (race && race.state !== 'over' && seatKey) { socket.emit('se:rejoin', { key: seatKey, v: S.VERSION }); return; }
  socket.emit('se:watch');
  if (WANT_JOIN || joined) { joined = false; join(); }
});
socket.on('disconnect', () => { if (race && race.car && !race.out && race.state !== 'over') note('Reconnecting...', 6000); });
socket.on('se:lobby', (m) => { if (!m) return; lobby = Object.assign(lobby, m); lobbyRecv = performance.now(); paintLobby(); });
socket.on('se:joined', (m) => {
  joined = true; refusedNote = '';
  if (m && Number.isInteger(m.lane)) myLane = m.lane;
  if (m && m.state === 'waiting') { lobby = Object.assign(lobby, m); lobbyRecv = performance.now(); }
  SOUND.play('g.join');
  paintLobby();
});
/* Our parked car moved lane: somebody left, or a newcomer drew our lane (SwimEvent.placeNew, closeGap). */
socket.on('se:lane', (m) => { if (m && Number.isInteger(m.lane)) myLane = m.lane; });
socket.on('se:refused', (m) => {
  joined = false;
  const why = m && typeof m.why === 'string' ? m.why : 'not seated';
  refusedNote = why.charAt(0).toUpperCase() + why.slice(1) + '.';
  paintLobby();
});
/* The full picture: on watch, on a rejoin, or arriving mid-race. */
socket.on('se:state', (m) => {
  if (!m) return;
  if (m.state === 'waiting' && race && race.state !== 'over' && m.id !== race.id) calledOff();   // the server restarted
  if (m.state === 'waiting') { if (!race || race.state === 'over') { lobby = Object.assign(lobby, m); paintLobby(); } return; }
  if (m.state === 'over') { if (!race && m.over) lastPodium(m.over); return; }
  const mySeat = race && race.me !== null && race.id === m.id ? race.me : null;
  const was = race;
  race = newRace(m);
  if (mySeat !== null) {
    seatMe(race, mySeat);
    if (was) { race.closes = was.closes; race.topV = was.topV; race.startedAt = was.startedAt; race.out = was.out; }
    hideNote();
  } else enterWatch();
  showRaceUi();
});
socket.on('se:start', (m) => {
  if (!m) return;
  myLane = null; lobbyOn = false;
  $('dash').classList.remove('revving'); revWas = null; gearWas = ''; tachWas = -1;
  race = newRace(m);
  seatKey = null;
  showRaceUi();
  pingBurst();
  if (!joined) enterWatch();
  else setTimeout(() => { if (race && race.id === m.id && race.me === null) { joined = false; enterWatch(); } }, 3000);
});
socket.on('se:you', (m) => {
  if (!race || !m || m.id !== race.id || !Number.isInteger(m.seat)) return;
  seatKey = typeof m.key === 'string' ? m.key : null;
  if (race.me === null) {
    seatMe(race, m.seat);
    leaveWatch();
    showRaceUi();
    if (!race.firstShown) { race.firstShown = true; keysHint(); }
    track('start', { room: race.id, players: race.seats.size });
  }
});
socket.on('se:rejoinfail', (m) => {
  seatKey = null;
  if (m && m.state === 'waiting') { calledOff(); socket.emit('se:watch'); return; }   // the server restarted mid-race
  if (race && race.car && !race.out) { race.out = -1; enterWatch(); }
  socket.emit('se:watch');
});
/* The race this screen was in no longer exists (the server restarted for an update): say so, nothing else. */
function calledOff() {
  if (!race || race.state === 'over') return;
  race.state = 'over'; joined = false; seatKey = null;
  $('count').hidden = true; $('pads').hidden = true; hideNote();
  if (BAR && barOpen) { BAR.close(); barOpen = false; }
  if (window.DSEnd) DSEnd.show({ tone: 'plain', verdict: 'Race called off', hero: '-', notes: ['The game restarted for an update, so this race was stopped. The next one is on the Events tab.'],
    buttons: [{ id: 'lobby', text: 'Lobby', primary: true, onClick: toLobby }] });
}
socket.on('se:go', () => {});
socket.on('se:s', (m) => {
  if (!race || !m || !Array.isArray(m.p)) return;
  if (Number.isInteger(m.T) && race.goAt && clock.off !== null && race.car && !race.out) {
    const ahead = serverNow() - (race.goAt + m.T * S.TICK_MS);
    if (ahead > (clock.rtt || 0) + 150 || ahead < -40) { clock.off -= ahead - (clock.rtt || 0) / 2; clock.want = clock.off; clock.samples = []; }
  }
  for (const row of m.p) takeRow(race, row);
});
socket.on('se:cars', (m) => { if (race && m && Array.isArray(m.add)) for (const rec of m.add) race.traffic.add(rec); });
socket.on('se:ko', (k) => {
  if (!race || !k) return;
  const s = race.seats.get(k.seat);
  if (s) s.out = Number(k.place) || 0;
  feed(k);
  if (k.seat === race.me && !race.out) knockedOut(k);
  else if (k.seat === race.follow && race.me === null) setTimeout(() => { if (race) { race.follow = leaderSeat(race); watchName(); } }, 1500);
  else if (k.seat !== race.me) SOUND.play('g.tick', { vol: 0.5 });
});
socket.on('se:over', (m) => {
  if (!race || !m) return;
  race.state = 'over'; race.overMsg = m;
  paintOwner();
  seatKey = null; joined = false;
  for (const p of m.places || []) { const s = race.seats.get(p.seat); if (s) s.out = p.place; }
  $('count').hidden = true; $('pads').hidden = true;
  setTimeout(() => finalCard(m), race.crashed && !race.outShown ? 900 : 300);
});

/* ── out, watching, the cards ──────────────────────────────────────────── */
function showRaceUi() {
  if (!race) return;
  $('wait').hidden = true; $('lobbyBar').hidden = true;
  paintOwner();
  $('board').hidden = false; $('dash').hidden = false;
  $('pads').hidden = !TOUCH || !(race.car && !race.out);
  if (window.DSEnd) DSEnd.hide();
}
function keysHint() {
  const k = $('keys');
  k.innerHTML = TOUCH ? 'Drag on the left to steer. Hold Gas or Brake on the right.'
    : 'Hold <kbd>W</kbd> to speed up, <kbd>S</kbd> to brake, <kbd>A</kbd> <kbd>D</kbd> to steer';
  k.hidden = false;
  setTimeout(() => { k.hidden = true; }, 7000);
}
function knockedOut(k) {
  const r = race;
  r.out = Number(k.place) || r.seats.size;
  track('end', { result: k.why === 'left' ? 'left' : 'lost', place: r.out, players: r.seats.size,
    score: Math.max(0, Math.round(k.z || 0)), reason: k.why });
  r.outAt = performance.now();
  if (!r.crashed) crashed(r);
  $('pads').hidden = true; $('warn').hidden = true;
  keys.clear();
  setTimeout(() => {
    if (race !== r || r.state === 'over') return;
    r.outShown = true;
    enterWatch();
    const n = r.seats.size;
    DSEnd.show({
      tone: 'loss', verdict: k.why === 'left' ? 'You left the race' : k.why === 'fell behind' ? 'You fell 1 km behind the leader' : 'You touched a car',
      hero: ord(r.out), unit: 'of ' + n,
      facts: [['Distance', metres(k.z || (r.car ? r.car.z : 0))], ['Top speed', Math.round(r.topV * 3.6) + ' km/h'], ['Close passes', String(r.closes)]],
      notes: ['The race goes on: watch who wins.'],
      buttons: [
        { id: 'lobby', text: 'Lobby', onClick: toLobby },
        { id: 'watch', text: 'Watch the race', primary: true, onClick: () => DSEnd.hide() },
      ],
    });
  }, 1200);
}
function finalCard(m) {
  const r = race;
  if (!r || !window.DSEnd) return;
  const win = m.winner;
  const mine = r.me !== null ? (m.places || []).find(p => p.seat === r.me) : null;
  if (m.void) {
    DSEnd.show({ tone: 'plain', verdict: 'Race called off', hero: '-', notes: ['The race was stopped before anyone won.'],
      buttons: [{ id: 'lobby', text: 'Lobby', primary: true, onClick: toLobby }] });
    return;
  }
  const why = { lead: win ? win.name + ' got 500 m clear.' : '', 'last car': 'Last car on the road.', time: 'Ten minutes up: the leader takes it.' }[m.why] || '';
  const podium = (m.places || []).slice(0, 3).map(p => ({ rank: p.place, name: p.name, me: r.me !== null && p.seat === r.me }));
  if (mine) {
    const won = mine.place === 1;
    if (!r.out) track('end', { result: won ? 'won' : 'lost', place: mine.place, players: (m.places || []).length,
      score: Math.max(0, Math.round(mine.z || 0)), reason: m.why });
    SOUND.play(won ? 'g.win' : 'g.lose');
    DSEnd.show({
      tone: won ? 'win' : 'plain', verdict: won ? 'You win the Swim Race' : (win ? win.name + ' wins' : 'Race over'),
      hero: ord(mine.place), unit: 'of ' + (m.places || []).length, podium,
      facts: [['Distance', metres(mine.z)], ['Top speed', Math.round(r.topV * 3.6) + ' km/h'], ['Close passes', String(r.closes)]],
      notes: why ? [why] : [],
      buttons: [{ id: 'lobby', text: 'Lobby', primary: true, onClick: toLobby }],
    });
  } else {
    DSEnd.show({
      tone: 'plain', verdict: win ? win.name + ' wins' : 'Race over', hero: String((m.places || []).length), unit: 'cars raced', podium,
      notes: why ? [why] : [], buttons: [{ id: 'lobby', text: 'Lobby', primary: true, onClick: toLobby }],
    });
  }
  if (BAR) BAR.close();
}
function lastPodium() { /* the Events tab shows the last podium; this page simply waits for the next race */ }

const BAR = window.DSWatchBar || null;
let barOpen = false;
function enterWatch() {
  if (!document.body.classList.contains('watching') && !(race && race.out)) track('spectate');
  document.body.classList.add('watching');
  $('pads').hidden = true;
  if (!BAR || !race) return;
  if (!barOpen) {
    BAR.open({ game: 'swim', onPrev: () => cycle(-1), onNext: () => cycle(1), onLobby: toLobby });
    barOpen = true;
  }
  watchName();
}
function leaveWatch() {
  document.body.classList.remove('watching');
  if (BAR && barOpen) { BAR.close(); barOpen = false; }
}
function watchName() {
  if (!BAR || !barOpen || !race) return;
  const s = race.follow !== null ? race.seats.get(race.follow) : null;
  BAR.watching(s ? s.name : 'Finding a car');
}
/* Previous and next: the cars still in the race, in their order on the road. */
function cycle(dir) {
  const r = race;
  if (!r) return;
  const list = standings(r, null).going;
  if (!list.length) return;
  let i = list.findIndex(g => g.seat === r.follow);
  i = i < 0 ? 0 : (i + dir + list.length) % list.length;
  r.follow = list[i].seat; followPinned = true;
  r.disp.delete(r.follow);
  watchName();
}

let noteTimer = 0;
function note(text, ms) { const n = $('botNote'); n.textContent = text; n.hidden = false; clearTimeout(noteTimer); noteTimer = setTimeout(() => { n.hidden = true; }, ms || 4000); }
function hideNote() { clearTimeout(noteTimer); $('botNote').hidden = true; }

function toLobby() {
  try { socket.emit(joined || (race && race.car && !race.out && race.state !== 'over') ? 'se:leave' : 'se:unwatch'); } catch (_) {}
  if (BAR && barOpen) BAR.close();
  SOUND.stop();
  if (window.parent && window.parent !== window) window.parent.postMessage('game:done', '*');
  else location.href = '/';
}
window.addEventListener('beforeunload', () => { if (joined) socket.emit('se:leave'); });
paintLobby();
