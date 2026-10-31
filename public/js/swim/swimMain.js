/* ─── Swim, the page ──────────────────────────────────────────────────────────
   The road (swimScene.js), the controls, the HUD, and everything a duel page
   does around a match: the queue and its minute, the paid hand-off, the result
   card, Spectate and chat, all exactly as Knockout's page does them
   (public/js/knockout.js), with sw: in place of ko:.

   IT DECIDES NOTHING. The server runs both cars and the traffic and says who
   won. This page runs the SAME step (shared/swimSim.js) on its own inputs the
   moment the keys change, so the car answers at once, and keeps every state it
   predicted; when the server's copy of a tick disagrees (an input of ours got
   there late, say) it takes the server's state and replays its inputs on top.
   The other car is drawn from the server's snapshots, carried forward at its
   own speed to the moment on screen.

   THE CLOCK. Our car runs on the server's ticks: sw:ping measures the gap
   between this page's clock and the server's, and tick n is simulated at the
   moment the server's clock reaches it, so our inputs arrive just after the
   server needs them and it never has to guess. */
import { createScene } from './swimScene.js';

const S = window.SwimSim;
const $ = (id) => document.getElementById(id);
const socket = io();
// The ping and FPS readout every game shares (public/js/shared/dsPerfHud.js), timed on this socket.
if (window.DSPerfHud) window.DSPerfHud.mount({ socket });
const SOUND = window.SwimSound || { play() {}, frame() {}, stop() {} };
/* The car you picked in Customize (shared/swimLooks.js), sent with sw:queue so the other player and the
   watchers see it; its paint comes with it, and its engine is the one you hear (swimSound.js). Looks only:
   the server keeps a listed car alone and the step never reads it. */
const LOOKS = window.DS_SWIM_LOOKS || null;
function myLook() {
  let car = null;
  try { car = localStorage.getItem(LOOKS ? LOOKS.KEY : ''); } catch (_) {}
  return LOOKS ? LOOKS.clean({ car }) : { car: 'supercar' };
}
function lookOf(p) { return LOOKS ? LOOKS.clean(p) : { car: 'supercar' }; }
function paintHex(car) { return LOOKS ? LOOKS.paintOf(car) : '#e2363f'; }
const NAME = S.NAME;
const R = 1024;                      // ticks of input and state kept for replay

/* ── the hand-off from the lobby (Knockout's keys, for the same reasons) ── */
const myName = (() => { try { return sessionStorage.getItem('playerName') || localStorage.getItem('duelseries_playername') || 'Player'; } catch (_) { return 'Player'; } })();
const myWallet = (() => { try { return localStorage.getItem('duelseries_wallet') || null; } catch (_) { return null; } })();
const myStake = (() => { try { return Number(sessionStorage.getItem('stake')) || 0; } catch (_) { return 0; } })();
let myEntryToken = (() => { try { return sessionStorage.getItem('entryToken') || null; } catch (_) { return null; } })();
const FRAMED = (() => { try { return !!window.parent && window.parent !== window; } catch (_) { return true; } })();
const WATCH = (() => {
  try { const v = sessionStorage.getItem('dsWatch'); if (v !== null) sessionStorage.removeItem('dsWatch'); return v === 'swim'; }
  catch (_) { return false; }
})();
const WATCH_STAKE = (() => {
  try { const s = Number(sessionStorage.getItem('dsWatchStake')); sessionStorage.removeItem('dsWatchStake'); return Number.isFinite(s) && s > 0 ? s : 0; }
  catch (_) { return 0; }
})();
/* Product tracking (public/js/shared/dsTrack.js; every event name is in shared/trackPlan.js), as knockout.js does
   it: one session for this page, the wait, each race and its result, or Spectate. A paid race's start and end are
   the server's to send; leaving mid-race is the helper's own. Never lets a failure reach the game. */
const TRACKER = (() => {
  try {
    if (!window.DSTrack) return null;
    const stake = WATCH ? WATCH_STAKE : myStake;
    const t = window.DSTrack.game('swim', { paid: stake > 0, stake, mode: stake > 0 ? 'paid' : 'free' });
    if (WATCH) t.spectate();
    return t;
  } catch (_) { return null; }
})();
function trackStep(step, arg) {
  if (!TRACKER) return;
  try {
    if (step === 'queue') {
      if (TRACKER.stage === 'queue') return;              // a reconnect's resumed seat is the same wait
      TRACKER.set({ vs_bot: undefined, room: undefined });   // the last race's, not this queue's
    }
    TRACKER[step](arg);
  } catch (_) { /* analytics never breaks the game */ }
}
// won, lost or draw; lost because this car's own connection stayed down is 'left' (see knockout.js).
function trackResult(won, why) {
  return won === true ? 'won' : won === false ? (why === 'opponent left' ? 'left' : 'lost') : 'draw';
}
const TOUCH = (() => { try { return matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window; } catch (_) { return false; } })();
if (TOUCH) document.body.classList.add('touch');
document.title = NAME + ' · DuelSeries';

/* ── the road ──────────────────────────────────────────────────────────── */
let scene = null;
try { scene = createScene($('road'), { touch: TOUCH }); }
catch (e) {
  console.error('[swim] no WebGL:', e);
  $('nogl').hidden = false;
  $('wait').hidden = true;
}
$('noglBack').addEventListener('click', () => toLobby());
window.addEventListener('resize', () => { if (scene) scene.resize(); });

/* ── the server's clock ────────────────────────────────────────────────── */
const clock = { off: null, want: null, samples: [], rtt: 0 };
function serverNow() { return performance.now() + (clock.off === null ? 0 : clock.off); }
function ping() { socket.emit('sw:ping', { c: performance.now() }); }
socket.on('sw:pong', ({ c, s } = {}) => {
  const r = performance.now(), rtt = r - c;
  if (!(rtt >= 0) || rtt > 4000 || !Number.isFinite(s)) return;
  clock.samples.push({ rtt, off: s - (c + r) / 2 });
  if (clock.samples.length > 12) clock.samples.shift();
  const best = clock.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  clock.want = best.off; clock.rtt = best.rtt;
  if (clock.off === null) clock.off = best.off;
});
function pingBurst() { for (let i = 0; i < 5; i++) setTimeout(ping, i * 120); }
/* Small steps toward the best estimate, so a correction never jumps the car. */
function slewClock() {
  if (clock.want === null || clock.off === null) return;
  const d = clock.want - clock.off;
  clock.off += Math.abs(d) > 250 ? d : Math.max(-0.5, Math.min(0.5, d));
}
setInterval(() => { if (race && race.state !== 'over') ping(); }, 2000);

/* ── the controls ──────────────────────────────────────────────────────── */
const keys = new Set();
const typing = () => { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable); };
const KEYMAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
addEventListener('keydown', (e) => {
  if (typing()) return;
  const k = KEYMAP[e.code];
  if (k) { keys.add(k); e.preventDefault(); }
});
addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keys.delete(k); });
addEventListener('blur', () => keys.clear());
const touch = { steer: 0, id: null, x0: 0, gas: false, brake: false };
function pads() {
  const zone = $('steerZone'), knob = $('steerKnob');
  zone.addEventListener('pointerdown', (e) => {
    touch.id = e.pointerId; touch.x0 = e.clientX; touch.steer = 0;
    knob.style.left = e.clientX + 'px'; knob.style.top = (e.clientY - zone.getBoundingClientRect().top) + 'px';
    knob.classList.add('on');
    try { zone.setPointerCapture(e.pointerId); } catch (_) {}
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== touch.id) return;
    touch.steer = Math.max(-1, Math.min(1, (e.clientX - touch.x0) / 56));
  });
  const end = (e) => { if (e.pointerId !== touch.id) return; touch.id = null; touch.steer = 0; knob.classList.remove('on'); };
  zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
  const hold = (btn, key) => {
    const on = (v) => (e) => { touch[key] = v; btn.classList.toggle('on', v); if (e && e.cancelable) e.preventDefault(); };
    btn.addEventListener('pointerdown', on(true));
    btn.addEventListener('pointerup', on(false)); btn.addEventListener('pointercancel', on(false)); btn.addEventListener('pointerleave', on(false));
  };
  hold($('gas'), 'gas'); hold($('brake'), 'brake');
}
pads();
function controls() {
  const steer = touch.id !== null ? touch.steer : (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
  const pedal = (keys.has('up') || touch.gas ? 1 : 0) - (keys.has('down') || touch.brake ? 1 : 0);
  return { steer, pedal };
}

/* ── the race ─────────────────────────────────────────────────────────── */
let race = null;
/* race = { id, side (mine, or null watching), names, vsBot, stake, pot, goAt, state,
            traffic, me, inputs, hist, sentTo, rows: [row side 0, row side 1], disp: [{z,x,v,vx}],
            slowing: [side 0, side 1], crashed, closes, topV, startedAt, follow } */
function newRace(m, side) {
  const traffic = new S.Traffic();
  for (const rec of m.cars || []) traffic.add(rec);
  const r = {
    id: m.id, side, vsBot: !!m.vsBot, stake: Number(m.stake) || 0, pot: Number(m.pot) || 0,
    names: [0, 1].map(s => { const p = (m.players || []).find(q => q.side === s); return p ? p.name : 'Player'; }),
    goAt: Number(m.goAt) || 0, state: 'countdown', traffic,
    me: side === null ? null : S.newCar(side),
    inputs: new Int16Array(R), hist: new Array(R).fill(null), sentTo: -1, lastSend: 0,
    rows: [null, null], disp: [null, null], seen: [0, 0], slowing: [false, false],
    crashed: false, closes: 0, topV: 0, startedAt: 0, follow: 0, countShown: -1,
    corrections: 0, scrapeWas: 0,
    /* Each seat's car, by seat (the server's cleaned id), drawn by the scene in the car's own paint. */
    looks: [0, 1].map(s => lookOf((m.players || []).find(q => q.side === s))),
    /* The start line and the engine: revs shown, the engine's counts already acted on, lift-offs seen. */
    rev: 0, seenUp: 0, seenDown: 0, seenPops: 0, lifting: [false, false],
  };
  if (scene && scene.setLooks) scene.setLooks(r.looks.map(l => ({ car: l.car, paint: paintHex(l.car) })));
  if (window.SwimSound && SwimSound.state) { const st = SwimSound.state(); r.seenUp = st.up; r.seenDown = st.down; r.seenPops = st.pops; }
  if (r.me) r.hist[0] = S.copyCar(r.me);
  for (const row of m.p || []) takeRow(r, row);
  if (clock.off === null && Number.isFinite(m.now)) clock.off = m.now - performance.now();
  return r;
}
const tickNow = () => (race ? (serverNow() - race.goAt) / S.TICK_MS : 0);

function rowCar(row) {
  return { tick: row[1], z: row[2], x: row[3], v: row[4], vx: row[5], alive: !!row[6],
           crashTick: row[6] ? -1 : row[1], hit: -1, wall: row[7] || 0, cool: row[8] || 0, close: -1 };
}
const SLOWING = 7;                   // m/s lost per second that lights a remote car's brake lights
function takeRow(r, row) {
  if (!Array.isArray(row) || row.length < 8) return;
  const side = row[0];
  if (side !== 0 && side !== 1) return;
  const prev = r.rows[side];
  if (prev && prev[1] > row[1]) return;            // an older snapshot arriving late
  /* Brake lights for a car we only hear about: lit while it loses more than SLOWING m/s a second
     between two rows. That is the brake pedal (22) or the barrier, not coasting (at most 5.6) or a
     boost bleeding off (4), so it lights when ours would. */
  if (prev && row[1] > prev[1]) {
    const decel = (prev[4] - row[4]) / ((row[1] - prev[1]) * S.DT);
    r.slowing[side] = decel > SLOWING;
    /* A car we only hear about lifting off at speed: a short run of exhaust flames on it (looks only). */
    const lift = decel > 2 && row[4] > 30 && !!row[6];
    if (lift && !r.lifting[side] && side !== r.side && scene && scene.backfire) scene.backfire(side, 3);
    r.lifting[side] = lift;
  }
  r.rows[side] = row;
  if (side === r.side) reconcile(r, row);
}

/* The server's state of our own car on some tick: if it is not what we
   predicted for that tick, take it and replay every input since. */
function reconcile(r, row) {
  const me = r.me;
  if (!me) return;
  const t = row[1];
  if (t > me.tick) {                               // the server is ahead of us (a stalled tab): jump to it
    r.me = rowCar(row); r.hist[t % R] = S.copyCar(r.me); r.corrections++;
    return;
  }
  const h = r.hist[t % R];
  if (!h || h.tick !== t) return;
  const same = h.alive === !!row[6] && h.z === row[2] && h.x === row[3] && h.v === row[4] && h.vx === row[5]
    && h.cool === (row[8] || 0);
  if (same) return;
  const c = rowCar(row);
  r.hist[t % R] = S.copyCar(c);
  for (let k = t; k < me.tick; k++) {
    S.step(c, r.inputs[k % R], r.traffic);
    r.hist[(k + 1) % R] = S.copyCar(c);
  }
  const wasDead = !me.alive;
  r.me = c;
  r.corrections++;
  if (wasDead && c.alive && scene) { scene.reset(); r.crashed = false; }
}

/* Step our car to the tick the clock is on, one input a tick from the controls as they are now. */
function drive(r) {
  const me = r.me;
  const target = Math.floor(tickNow()) + 1;
  if (target - me.tick > 30) {                     // far behind (a hidden tab): wait for the server's state
    if (r.rows[r.side]) r.me = rowCar(r.rows[r.side]);
    return;
  }
  /* While the link is down the server drives this car straight with no pedal (its five second grace),
     so the screen does the same, and nothing is sent: the picture matches what the server is judging. */
  const offline = !socket.connected;
  const { steer, pedal } = offline ? { steer: 0, pedal: 0 } : controls();
  const code = S.packInput(steer, pedal);
  while (r.me.tick < target) {
    const c = r.me;
    r.inputs[c.tick % R] = code;
    const alive = c.alive;
    S.step(c, code, r.traffic);
    r.hist[c.tick % R] = S.copyCar(c);
    if (alive && c.alive && c.close >= 0) closePass(r);
    if (alive && !c.alive) crashed(r);
    if (c.wall !== 0 && steer * c.wall > 0) SOUND.play('sw.scrape', { vol: 0.8 });
  }
  r.steer = steer; r.pedal = pedal;
  if (r.me.v > r.topV) r.topV = r.me.v;
  /* Send every other tick: everything since the last packet and at least the last six, so a dropped
     packet costs nothing and a slow frame leaves no tick unsent (the server takes up to 12). */
  const last = r.me.tick - 1;
  if (!offline && r.me.alive && last >= 0 && last - r.sentTo >= 2) {
    const from = Math.max(0, last - 11, Math.min(r.sentTo + 1, last - 5));
    const k = [];
    for (let t = from; t <= last; t++) k.push(r.inputs[t % R]);
    socket.volatile.emit('sw:in', { t: last, k });
    r.sentTo = last;
  }
}

/* A CLOSE PASS: the step itself saw a car go by with under S.CLOSE_M to spare and gave the boost
   (car.close, shared/swimSim.js), so the server agrees it happened. Said on the predicted tick; a
   correction replays without saying it again. */
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
function flash(kind) {
  const f = $('flash');
  f.className = ''; void f.offsetWidth; f.className = kind;
}
function crashed(r) {
  if (r.crashed) return;
  r.crashed = true;
  if (scene) scene.crash();
  SOUND.play('g.death');
  flash('crash');
}

/* ── one frame ─────────────────────────────────────────────────────────── */
let lastFrame = performance.now();
const fpsWin = [];
let idleZ = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  fpsWin.push(dt); if (fpsWin.length > 90) fpsWin.shift();
  slewClock();
  const r = race;
  /* steer stays null unless it is our own wheel: the scene then reads a car's indicators from its sideways speed. */
  let follow = null, other = null, followSide = 0, steer = null, tickF = 0;
  if (r && (r.state === 'countdown' || r.state === 'racing' || r.state === 'over')) {
    tickF = tickNow();
    if (r.state === 'countdown') countdown(r, tickF);
    /* The start line: holding gas revs the engine (out of gear, speed 0). Nothing is sent and the car does
       not move: drive() only runs from GO, and every car starts tick 0 the same. */
    const revving = r.state === 'countdown' && !!r.me;
    const gasHeld = revving && controls().pedal > 0;
    r.rev += ((gasHeld ? 1 : 0) - r.rev) * (1 - Math.exp(-dt / (gasHeld ? 0.22 : 0.35)));
    r.revving = revving; r.gasHeld = gasHeld;
    if (r.state === 'countdown' && tickF >= 0) { r.state = 'racing'; r.startedAt = performance.now(); }
    if (r.state === 'racing' && r.me) drive(r);
    if (r.me) {
      // Between the last two predicted ticks, for a smooth picture at any refresh rate.
      const a = r.me, p = r.hist[(a.tick - 1 + R) % R];
      const alpha = Math.max(0, Math.min(1, tickF - (a.tick - 1)));
      const brake = r.state === 'racing' && (r.pedal || 0) < 0;
      follow = p && p.tick === a.tick - 1 && a.alive
        ? { z: p.z + (a.z - p.z) * alpha, x: p.x + (a.x - p.x) * alpha, v: a.v, vx: a.vx, alive: a.alive, brake }
        : { z: a.z, x: a.x, v: a.v, vx: a.vx, alive: a.alive, brake };
      followSide = r.side;
      other = remote(r, 1 - r.side, a.tick - 1 + alpha, dt);
      steer = r.steer || 0;
    } else {
      // Watching: both cars from the server, a moment behind its clock; the camera rides the leader.
      const at = tickF - 4;
      const c0 = remote(r, 0, at, dt), c1 = remote(r, 1, at, dt);
      if (c0 && c1) {
        if (c1.z > c0.z + 12) r.follow = 1; else if (c0.z > c1.z + 12) r.follow = 0;
      }
      followSide = r.follow;
      follow = followSide === 0 ? c0 : c1;
      other = followSide === 0 ? c1 : c0;
      if (!follow) { follow = other; other = null; followSide = 1 - followSide; }
    }
    if (follow) {
      r.traffic.prune(Math.min(follow.z, other ? other.z : follow.z) - 120, Math.floor(tickF));
      hud(r, follow, other);
    }
  }
  if (!follow) {
    // Nobody on the road yet: an empty highway rolls by behind the card.
    idleZ += 26 * dt;
    follow = { z: idleZ, x: S.laneX(1), v: 26, vx: 0, alive: true };
  }
  const revving = !!(r && r.revving && r.state === 'countdown');
  SOUND.frame({ on: !!(r && ((r.state === 'racing' && follow && follow.alive) || revving)), v: revving ? 0 : follow ? follow.v : 0,
    pedal: revving ? (r.gasHeld ? 1 : 0) : r ? r.pedal : 0, rev: revving,
    /* Watching: the watched car's engine. Racing or watching: the other car heard where it is (swimSound.js). */
    engine: r && r.side === null && r.looks && r.looks[followSide] ? engineOf(r.looks[followSide].car) : '',
    others: soundOthers(r, follow, other, followSide) });
  const st = SOUND.state ? SOUND.state() : null;
  if (r && r.me && st) engineMoments(r, st);
  if (scene) scene.frame({ follow, other, followSide, traffic: r ? r.traffic : EMPTY, tick: tickF, dt, steer,
    rev: revving ? r.rev : 0 });
  if (r) tach(r, st, follow);
  publish(r, follow, other);
}
const EMPTY = new S.Traffic();
/* The other car for the sound: where it is from the car the camera rides with (one object, reused). */
const engineOf = (car) => (LOOKS ? LOOKS.engineOf(car) : 'v12');
const sndOther = { key: 'o', engine: 'v12', v: 0, thr: 1, dx: 0, dz: 0, alive: true }, sndList = [sndOther], sndNone = [];
function soundOthers(r, f, o, side) {
  if (!r || !f || !o || r.state !== 'racing') return sndNone;
  const os = side === 1 ? 0 : 1;
  sndOther.key = 's' + os; sndOther.engine = r.looks && r.looks[os] ? engineOf(r.looks[os].car) : 'v12';
  sndOther.v = o.v || 0; sndOther.thr = o.brake ? -1 : 1; sndOther.alive = o.alive !== false;
  sndOther.dx = o.x - f.x; sndOther.dz = o.z - f.z;
  return sndList;
}

/* Shifts and backfire, as the engine is heard (SwimSound.state counts them): the car lurches on an upshift,
   dips softly on a downshift, and a flame flashes at its pipes with each bang. All looks: the race's speed is
   only ever what the step says. */
function engineMoments(r, st) {
  if (st.up !== r.seenUp) { if (scene && scene.shift && r.state === 'racing') scene.shift(1); r.seenUp = st.up; }
  if (st.down !== r.seenDown) { if (scene && scene.shift && r.state === 'racing') scene.shift(-1); r.seenDown = st.down; }
  if (st.pops !== r.seenPops) {
    const n = Math.min(3, st.pops - r.seenPops);
    if (scene && scene.backfire && n > 0) for (let i = 0; i < n; i++) scene.backfire(r.side, 0);
    r.seenPops = st.pops;
  }
}
/* The tach under the speed and the gear beside it: big on the start line (the rev counter), a slim bar in the
   race. N on the start line; hidden when no engine is running (sound blocked) or when watching. */
let tachWas = -1, gearWas = '', revWas = null;
function tach(r, st, f) {
  const mine = !!r.me;
  const revving = mine && r.state === 'countdown';
  if (revving !== revWas) { $('dash').classList.toggle('revving', revving); $('dash').classList.toggle('mine', mine); revWas = revving; }
  let k = 0;
  if (mine) {
    if (st && st.rev > 0) k = Math.max(0, Math.min(1, (st.rev - 0.1) / 0.85));   // the engine's own rpm, idle at the left
    else k = revving ? r.rev : Math.max(0, Math.min(1, (f ? f.v : 0) / 97));
  }
  const q = Math.round(k * 100);
  if (q !== tachWas) { tachWas = q; $('tachFill').style.width = q + '%'; $('tach').classList.toggle('red', q >= 88); }
  const g = !mine ? '' : revving ? 'N' : st && st.gear > 0 ? String(st.gear) : '';
  if (g !== gearWas) { gearWas = g; const el = $('gearNum'); el.textContent = g; el.hidden = !g; }
}

/* A car we only hear about, carried forward from its last row to tick `at`
   and eased onto that line so a new row never makes it jump. */
function remote(r, side, at, dt) {
  const row = r.rows[side];
  if (!row) return null;
  const ahead = row[6] ? Math.max(-6, Math.min(30, at - row[1])) : 0;
  const tz = row[2] + row[4] * ahead * S.DT;
  const tx = Math.max(-S.WALL, Math.min(S.WALL, row[3] + row[5] * Math.min(ahead, 8) * S.DT));
  let d = r.disp[side];
  if (!d || Math.abs(d.z - tz) > 40) d = r.disp[side] = { z: tz, x: tx };
  else {
    d.z += row[4] * dt * (row[6] ? 1 : 0); d.x += row[5] * dt * (row[6] ? 1 : 0);
    d.z += (tz - d.z) * 0.22; d.x += (tx - d.x) * 0.22;
  }
  return { z: d.z, x: d.x, v: row[4], vx: row[5], alive: !!row[6], brake: !!row[6] && r.slowing[side] };
}

/* ── the HUD ───────────────────────────────────────────────────────────── */
function hud(r, f, o) {
  const kmh = Math.round(f.v * 3.6);
  $('spdNum').textContent = String(kmh);
  $('distText').textContent = f.z >= 1000 ? (f.z / 1000).toFixed(2) + ' km' : Math.max(0, Math.round(f.z)) + ' m';
  if (!o) return;
  const gap = f.z - o.z;
  const a = Math.min(1, Math.abs(gap) / S.BEHIND_LOSE);
  const fill = $('ropeFill'), rope = $('rope');
  fill.style.width = (a * 50) + '%';
  fill.style.left = gap >= 0 ? '50%' : (50 - a * 50) + '%';
  rope.classList.toggle('behind', gap < 0);
  const mine = r.side !== null;
  const danger = mine && gap < -S.BEHIND_LOSE * 0.7;
  rope.classList.toggle('danger', danger);
  const m = Math.round(Math.abs(gap));
  let text;
  if (!mine) text = m < 3 ? 'Level' : r.names[gap > 0 ? r.follow : 1 - r.follow] + ' leads by ' + m + ' m';
  else text = m < 3 ? 'Level' : gap > 0 ? m + ' m ahead' : m + ' m behind';
  $('gapText').textContent = text;
  const warn = $('warn');
  if (danger && r.state === 'racing') {
    warn.textContent = 'Catch up: ' + Math.max(0, S.BEHIND_LOSE - m) + ' m left';
    if (warn.hidden) { warn.hidden = false; SOUND.play('g.warn'); }
  } else warn.hidden = true;
}

function countdown(r, tickF) {
  const left = Math.ceil(-tickF * S.TICK_MS / 1000);
  const box = $('count'), num = $('countNum');
  if (left > 0 && left <= 3) {
    if (left !== r.countShown) {
      r.countShown = left;
      box.hidden = false; num.textContent = String(left);
      num.style.animation = 'none'; void num.offsetWidth; num.style.animation = '';
      SOUND.play('g.tick');
    }
  } else if (left <= 0 && r.countShown !== 0) {
    r.countShown = 0; box.hidden = true; SOUND.play('g.go');
  }
}

function publish(r, f, o) {
  try {
    const avg = fpsWin.reduce((a, b) => a + b, 0) / Math.max(1, fpsWin.length);
    window.__swim = {
      mode: WATCH ? 'watch' : 'play', state: r ? r.state : (waiting ? 'waiting' : 'idle'),
      id: r ? r.id : null, side: r ? r.side : null, tick: r ? Math.floor(tickNow()) : 0,
      me: r && r.me ? { z: r.me.z, x: r.me.x, v: r.me.v, alive: r.me.alive, tick: r.me.tick } : null,
      gap: f && o ? f.z - o.z : null, closes: r ? r.closes : 0, corrections: r ? r.corrections : 0,
      cars: r ? r.traffic.size : 0, fps: avg > 0 ? Math.round(1 / avg) : 0, rtt: Math.round(clock.rtt || 0),
      scene: scene ? scene.info() : null,
      looks: r ? r.looks : null, rev: r ? Math.round(r.rev * 1000) / 1000 : 0,
      engine: SOUND.state ? Object.assign({}, SOUND.state()) : null,
      names: r ? r.names.slice() : [], watch: watchMatch ? { id: watchMatch.id, index: watchMatch.index, count: watchMatch.count } : null,
    };
  } catch (_) {}
}
requestAnimationFrame(frame);
/* For a headless check's driver: the traffic this page knows (what it draws anyway). */
window.__swimTraffic = () => (race ? race.traffic : EMPTY);

/* ── chat (dsChat.js), as in every duel ───────────────────────────────── */
let chatLive = false;
const chat = window.DSChat ? DSChat.mount({
  send: (t) => { socket.emit('sw:chat', { text: t }); return true; },
  canSend: () => chatLive && !WATCH,
  pc: { left: 14, bottom: 76 },
  phoneAt: { left: 10, top: WATCH ? 104 : 104 },
}) : { add() {}, visible() {} };
function chatShow(on) { chatLive = on; chat.visible(on); }
socket.on('sw:chat', (m) => {
  if (!m) return;
  const mine = race && m.side === race.side;
  chat.add({ name: m.name, color: m.side === 0 ? '#f0b440' : '#4fc3d9', text: m.text, me: !!mine && !WATCH });
});
socket.on('sw:chatnote', (m) => { if (m) chat.add({ kind: 'sys', text: m.text }); });

/* ── the queue and the wait (Knockout's, word for word) ───────────────── */
const WAIT_MS = window.DS_DUEL_WAIT_MS;   // shared/duelWait.js, the server's number too
let waiting = false, waitPaid = false, waitEndsAt = 0, waitFrom = 0, waitTimer = 0, resumeKey = null, overShown = false, lastOver = null;
/* The seat's secret for a reconnect mid-race (sw:seat, sent to this socket only, new after every rejoin). */
let seatKey = null;
let restake = null, restakeLine = '', restakeTimer = 0, firstRace = true;
function clockText(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function paintWait() {
  if (!waiting) return;
  const left = waitEndsAt - Date.now();
  const table = '$' + myStake.toFixed(2) + ' table. ';
  if (waitPaid) {
    // A paid table is one card from stake to match (Owen 2026-10-30): the clock counts up, nothing changes at 0:00.
    $('waitMain').textContent = 'Looking for a player… ' + clockText(Math.floor((Date.now() - waitFrom) / 1000) * 1000);
    $('waitSub').textContent = table + 'Real players only, never a bot. Cancel any time for a full refund.';
  } else if (left > 0) {
    $('waitMain').textContent = 'Looking for a player… ' + clockText(left);
    $('waitSub').textContent = 'Free table. If nobody joins, you\'ll race a bot.';
  } else {
    $('waitMain').textContent = 'Nobody joined. Racing a bot…';
    $('waitSub').textContent = 'Free table. Starting against a bot now.';
  }
}
function startWait(ms, total = WAIT_MS) { waiting = true; waitEndsAt = Date.now() + Math.max(0, ms); waitFrom = Date.now() + ms - total; clearInterval(waitTimer); waitTimer = setInterval(paintWait, 250); paintWait(); }
function stopWait() { waiting = false; clearInterval(waitTimer); }
function waitSpin(on) { const s = document.querySelector('.waitSpin'); if (s) s.hidden = !on; }

socket.on('connect', () => {
  pingBurst();
  if (!scene) return;                              // no road to drive on: never take a seat, never spend a token
  if (WATCH) { swapping = false; watch(null); return; }
  if (waiting && resumeKey) { queue(null, resumeKey); return; }
  if (race && race.state === 'over') return;       // the result card is up: it stays, with its own buttons
  if (race && race.state !== 'over') {
    /* A reconnect mid-race: the server holds the seat for five seconds, and the key takes it back
       (sw:rejoined). Without a key, or too late, it counted the drop as leaving. */
    if (seatKey && race.me) { socket.emit('sw:rejoin', { key: seatKey, v: S.VERSION }); return; }
    connectionLost();
    return;
  }
  queue();
});
function connectionLost(restart) {
  if (!race) return;
  trackStep('end', restart ? { result: 'ended', reason: 'server restarted' } : { result: 'left', reason: 'disconnected' });
  if (restart) {
    /* The server restarted for an update mid-race: a paid race is refunded in full (duelQueue.shutdownRows). */
    race.state = 'over'; seatKey = null; hideNote();
    $('top').hidden = true; $('dash').hidden = true; $('pads').hidden = true; $('warn').hidden = true;
    chatShow(false);
    $('wait').hidden = false; waitSpin(false);
    $('waitMain').textContent = 'The game restarted for an update';
    $('waitSub').textContent = myStake > 0 ? 'The race was called off and your buy-in goes back to your wallet.'
      : 'The race was called off. Go back to the lobby to race again.';
    $('waitCancel').textContent = 'Back to the lobby';
    return;
  }
  race.state = 'over'; seatKey = null;
  hideNote();
  $('top').hidden = true; $('dash').hidden = true; $('pads').hidden = true; $('warn').hidden = true;
  chatShow(false);
  $('wait').hidden = false; waitSpin(false);
  $('waitMain').textContent = 'Your connection dropped';
  $('waitSub').textContent = 'Leaving mid-race counts as a loss. Go back to the lobby to race again.';
  $('waitCancel').textContent = 'Back to the lobby';
}
socket.on('disconnect', () => {
  if (WATCH || !race || race.state === 'over' || !race.me) return;
  note('Reconnecting...', 60000);
});
socket.on('sw:seat', (m) => {
  if (WATCH || !m || typeof m.key !== 'string') return;
  seatKey = m.key;
});
/* The seat back on this socket: the race as the server has it now. The road and the counts so far stay;
   the car is the server's row (newRace takes it), and the next inputs carry on from there. */
socket.on('sw:rejoined', (m) => {
  if (WATCH || !m || !race || race.state === 'over' || (m.side !== 0 && m.side !== 1)) return;
  const was = race;
  race = newRace(m, m.side);
  race.state = m.state === 'racing' ? 'racing' : 'countdown';
  race.startedAt = was.startedAt; race.countShown = was.countShown;
  race.closes = was.closes; race.topV = was.topV;
  const row = (m.p || []).find(q => Array.isArray(q) && q[0] === m.side);
  if (was.crashed && row && row[6] && scene) scene.reset();   // a crash only this screen predicted
  else race.crashed = was.crashed;
  hideNote();
  pingBurst();
});
socket.on('sw:rejoinfail', (m) => {
  if (WATCH || !race || race.state === 'over') return;
  hideNote();
  /* The race ended while the link was down (a crash, or the five seconds ran out): its own result card. */
  if (m && m.over && m.side === race.side) { showOver(m.over); return; }
  connectionLost(!!(m && m.restart));
});
socket.on('sw:queued', (q = {}) => {
  if (WATCH || (race && race.state !== 'over')) return;
  if (typeof q.resumeKey === 'string') resumeKey = q.resumeKey;
  const total = Number(q.waitMs) > 0 ? Number(q.waitMs) : WAIT_MS;
  startWait(total - (Number(q.waitingMs) || 0), total);
  trackStep('queue');
});
function queue(token, resume) {
  overShown = false; lastOver = null;
  if (window.DSEnd) DSEnd.hide();
  chatShow(false);
  if (scene) $('wait').hidden = false;
  waitSpin(true);
  waitPaid = myStake > 0;
  $('waitCancel').textContent = waitPaid ? 'Cancel and refund' : 'Back to the lobby';
  if (!resume) startWait(WAIT_MS); else paintWait();
  const look = myLook();
  socket.emit('sw:queue', { name: myName, wallet: myWallet, stake: myStake, entryToken: token || myEntryToken, resume: resume || undefined, v: S.VERSION,
    car: look.car });
  myEntryToken = null;
  try { sessionStorage.removeItem('entryToken'); } catch (_) {}
}

let botNoteTimer = 0;
function note(text, ms) {
  const n = $('botNote');
  n.textContent = text; n.hidden = false;
  clearTimeout(botNoteTimer); botNoteTimer = setTimeout(() => { n.hidden = true; }, ms || 5000);
}
function hideNote() { clearTimeout(botNoteTimer); $('botNote').hidden = true; }

function showRaceUi(r) {
  $('wait').hidden = true;
  $('top').hidden = false; $('dash').hidden = false;
  $('pads').hidden = !TOUCH || WATCH;
  $('youName').textContent = r.side === null ? r.names[0] : r.names[r.side];
  $('themName').textContent = r.side === null ? r.names[1] : r.names[1 - r.side];
  chatShow(true);
  if (!WATCH && firstRace) {
    firstRace = false;
    const k = $('keys');
    k.innerHTML = TOUCH ? 'Drag on the left to steer. Hold Gas or Brake on the right.'
      : 'Hold <kbd>W</kbd> to speed up, <kbd>S</kbd> to brake, <kbd>A</kbd> <kbd>D</kbd> to steer';
    k.hidden = false;
    setTimeout(() => { k.hidden = true; }, 7000);
  }
}

socket.on('sw:start', (m) => {
  if (WATCH || !m) return;
  stopWait(); resumeKey = null; seatKey = null;   // this race's key follows in sw:seat
  const me = (m.players || []).find(p => p.id === socket.id);
  if (!me) return;
  race = newRace(m, me.side);
  overShown = false;
  if (scene) scene.reset();
  if (m.vsBot) note('Playing a bot');
  SOUND.play('g.join');
  pingBurst();
  showRaceUi(race);
  trackStep('start', { vs_bot: !!m.vsBot, room: m.id });
});
socket.on('sw:go', () => { /* the clock already knows; the server says it for watchers that arrive late */ });
socket.on('sw:s', (m) => {
  if (!race || !m || !Array.isArray(m.p)) return;
  /* The server's clock was at tick T when it sent this, so ours, now, is at least that plus the trip.
     Far off either way (a ping estimate that went wrong) and our ticks are moved back in line. */
  if (Number.isInteger(m.T) && race.goAt && clock.off !== null) {
    const ahead = serverNow() - (race.goAt + m.T * S.TICK_MS);
    if (ahead > (clock.rtt || 0) + 150 || ahead < -40) {
      clock.off -= ahead - (clock.rtt || 0) / 2; clock.want = clock.off; clock.samples = [];
    }
  }
  for (const row of m.p) takeRow(race, row);
});
socket.on('sw:cars', (m) => {
  if (!race || !m || !Array.isArray(m.add)) return;
  for (const rec of m.add) race.traffic.add(rec);
});

/* ── the result card (dsEnd.js), every amount the server's own ────────── */
const RESTAKE_WAIT_MS = 120000;
const TEXT = {
  againAsk: 'Confirm in your wallet...', againSlow: 'Waiting for your wallet...',
  againSlowLine: 'Your wallet has not answered yet. If you approved the stake, wait here: the race starts once it lands.',
  againFailed: 'Stake failed', lobbyOnly: 'Buy a new entry in the lobby to play again.',
};
socket.on('sw:over', (m) => {
  if (WATCH) { watchOver(m || {}); return; }
  showOver(m || {});
});
function showOver(m) {
  if (overShown || !race) return;
  overShown = true; seatKey = null;
  hideNote();
  race.state = 'over';
  const ms = race.startedAt ? performance.now() - race.startedAt : 0;
  const mine = (m.cars || [])[race.side];
  lastOver = Object.assign({}, m || {}, { ms, side: race.side, closes: race.closes, topKmh: Math.round(race.topV * 3.6),
                                          metres: mine ? mine.z : Math.round(race.me ? race.me.z : 0) });
  const won = m.winnerSide === race.side;
  if (m.winnerSide === null || m.winnerSide === undefined) SOUND.play('g.lose');
  else SOUND.play(won ? 'g.win' : 'g.lose');
  // The score is the metres driven.
  trackStep('end', { result: trackResult(m.winnerSide === null || m.winnerSide === undefined ? null : won, m.why),
    score: Math.max(0, Math.round(lastOver.metres || 0)), reason: m.why });
  if (!won && m.why === 'crashed' && !race.crashed) crashed(race);
  restake = null; restakeLine = '';
  $('warn').hidden = true; $('pads').hidden = true;
  chatShow(false);
  setTimeout(paintOver, race.crashed ? 900 : 300);
}
function paintOver() {
  const m = lastOver;
  if (!m || !window.DSEnd) return;
  const money = m.money && typeof m.money === 'object' ? m.money : null;
  const seat = money && money.seats ? money.seats['s' + m.side] || null : null;
  const won = m.winnerSide === null || m.winnerSide === undefined ? null : m.winnerSide === m.side;
  const time = m.ms > 0 ? DSEnd.clock(m.ms) : '';
  const card = { tone: 'plain', verdict: won === true ? 'You win' : won === false ? (m.winner || 'Opponent') + ' wins' : 'Draw', notes: [] };
  const facts = [['Distance', DSEnd.int(Math.max(0, Math.round(m.metres || 0))) + ' m'], ['Top speed', m.topKmh + ' km/h'], ['Close passes', DSEnd.int(m.closes || 0)]];
  if (time) facts.push(['Time', time]);
  if (money) {
    if (money.refunded) { card.hero = DSEnd.usd(seat ? seat.refundMicro : 0); card.unit = 'refunded'; }
    else if (won === true) {
      card.tone = 'win'; card.hero = DSEnd.usd(money.netMicro); card.unit = 'to your wallet';
      card.ledger = [['Pot', DSEnd.usd(money.potMicro)], ['House 10%', DSEnd.usd(-money.cutMicro)], ['You receive', DSEnd.usd(money.netMicro)]];
    } else {
      card.tone = 'loss';
      card.hero = DSEnd.usd(-(seat ? seat.stakeMicro : Math.round((Number(m.stake) || 0) * 1e6)));
      card.unit = 'lost';
    }
    card.facts = facts;
  } else {
    card.tone = won === true ? 'win' : won === false ? 'loss' : 'plain';
    card.hero = DSEnd.int(Math.max(0, Math.round(m.metres || 0)));
    card.unit = 'metres';
    card.facts = facts.slice(1);
  }
  const why = {
    crashed: won ? 'They touched a car.' : 'You touched a car.',
    'fell behind': won ? 'They fell 200 m behind.' : 'You fell 200 m behind.',
    'both crashed': 'You both touched a car at the same moment.',
    'opponent left': won === false ? 'Your connection dropped for more than 5 seconds.' : 'They left the race.',
    time: 'Thirty minutes and nobody crashed, so it is a draw.',
    error: 'The race stopped, so it is a draw.',
    'both out': 'They left after your crash had already happened, so it is a draw.',
  }[m.why];
  if (why) card.notes.push(why);
  const paid = myStake > 0;
  const price = paid ? 'Play again ' + DSEnd.usd(Math.round(myStake * 1e6)) : 'Play again';
  const shut = !!restake && !restake.slow;
  let again;
  if (paid && !FRAMED) { again = { id: 'again', text: price, primary: true, disabled: true }; card.notes.push(TEXT.lobbyOnly); }
  else if (restake) {
    again = { id: 'again', text: restake.slow ? TEXT.againSlow : TEXT.againAsk, primary: true, disabled: true };
    if (restake.slow) card.notes.push(TEXT.againSlowLine);
  } else again = { id: 'again', text: price, primary: true, onClick: playAgain };
  if (restakeLine) card.notes.push(restakeLine);
  card.buttons = [
    { id: 'lobby', text: 'Lobby', disabled: shut, onClick: toLobby },
    { id: 'spectate', text: 'Spectate', disabled: shut || !!restake, onClick: spectate },
    again,
  ];
  DSEnd.show(card);
}
function playAgain() { if (myStake > 0) { askRestake(); return; } requeue(null); }
function requeue(token) {
  socket.emit('sw:leave');
  race = null; seatKey = null;
  $('top').hidden = true; $('dash').hidden = true; $('pads').hidden = true;
  if (scene) scene.reset();
  queue(token);
}
function newNonce() {
  try { const a = new Uint32Array(4); crypto.getRandomValues(a); return Array.prototype.map.call(a, (n) => n.toString(36)).join(''); }
  catch (_) { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
}
function askRestake() {
  if (!FRAMED || restake || !(myStake > 0)) return;
  restake = { nonce: newNonce(), slow: false };
  restakeLine = '';
  clearTimeout(restakeTimer);
  restakeTimer = setTimeout(() => { if (!restake) return; restake.slow = true; paintOver(); }, RESTAKE_WAIT_MS);
  paintOver();
  try { window.parent.postMessage({ type: 'duel:restake', game: 'swim', stake: myStake, nonce: restake.nonce }, '*'); }
  catch (_) { restakeDone(TEXT.againFailed); }
}
function restakeDone(line) { restake = null; clearTimeout(restakeTimer); restakeLine = line || ''; paintOver(); }
window.addEventListener('message', (e) => {
  const d = e && e.data;
  if (!restake || !d || typeof d !== 'object') return;
  if (e.source !== window.parent) return;
  if (!e.origin || e.origin !== location.origin) return;
  if (typeof d.nonce !== 'string' || d.nonce !== restake.nonce) return;
  if (d.type === 'duel:restake:done' && typeof d.entryToken === 'string' && d.entryToken) {
    restake = null; restakeLine = ''; clearTimeout(restakeTimer); requeue(d.entryToken);
  } else if (d.type === 'duel:restake:error') restakeDone(String(d.message || TEXT.againFailed));
});

function sentence(s) { const t = String(s || '').trim(); if (!t) return ''; return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.'); }
socket.on('sw:unqueued', ({ refunded, why } = {}) => {
  if (WATCH || (race && race.state !== 'over')) return;
  if (!refunded) {
    if (why !== 'the match could not start') return;
    trackStep('unqueue', why);
    stopWait(); resumeKey = null;
    $('wait').hidden = false; waitSpin(false);
    $('waitMain').textContent = 'Could not start the race';
    $('waitSub').textContent = 'Go back to the lobby and press Play again.';
    $('waitCancel').textContent = 'Back to the lobby';
    return;
  }
  trackStep('unqueue', why || 'refunded');
  stopWait(); resumeKey = null; waitPaid = false;
  $('wait').hidden = false; waitSpin(false);
  $('waitMain').textContent = 'Buy-in refunded';
  $('waitSub').textContent = ({
    'nobody joined that table': 'Nobody joined that table, so your buy-in went back to your wallet.',
    'left the queue': 'Cancelled. Your full buy-in went back to your wallet.',
    'connection dropped': 'Your connection dropped while you waited, so your buy-in went back to your wallet.',
    'the match could not start': 'The race could not start, so your buy-in went back to your wallet.',
  })[why] || 'Your buy-in went back to your wallet.';
  $('waitCancel').textContent = 'Back to the lobby';
});
socket.on('sw:refused', ({ why } = {}) => {
  if (WATCH || (race && race.state !== 'over')) return;
  const lost = waiting && waitPaid && resumeKey;
  trackStep('unqueue', 'refused');
  stopWait(); resumeKey = null; waitPaid = false;
  $('wait').hidden = false; waitSpin(false);
  $('waitMain').textContent = 'Not seated';
  $('waitSub').textContent = lost ? 'Your connection dropped while you waited. Your buy-in goes back to your wallet.'
    : (sentence(why) || 'The table did not let you in.');
  $('waitCancel').textContent = 'Back to the lobby';
});
socket.on('maintenance', () => {
  if (race && race.state !== 'over') return;
  trackStep('unqueue', 'maintenance');
  stopWait();
  $('wait').hidden = false; waitSpin(false);
  $('waitMain').textContent = 'Back in a minute';
  $('waitSub').textContent = 'The game is updating. Nothing was staked.';
  $('waitCancel').textContent = 'Back to the lobby';
});

/* ── leaving ───────────────────────────────────────────────────────────── */
function toLobby() {
  if (restake && !restake.slow) return;
  clearTimeout(watchTimer); clearTimeout(swapTimer);
  if (BAR) BAR.close();
  socket.emit(WATCH ? 'sw:unwatch' : 'sw:leave');
  SOUND.stop();
  if (window.parent && window.parent !== window) window.parent.postMessage('game:done', '*');
  else location.href = '/';
}
$('waitCancel').addEventListener('click', () => {
  if (waiting && waitPaid && !WATCH && !(race && race.state !== 'over')) {
    stopWait(); waitPaid = false; resumeKey = null; waitSpin(true);
    $('waitMain').textContent = 'Cancelling…';
    $('waitSub').textContent = 'Giving your buy-in back.';
    $('waitCancel').textContent = 'Back to the lobby';
    socket.emit('sw:unqueue');
    return;
  }
  toLobby();
});
const WATCH_URL = '/swim';
const MONEY_KEYS = ['entryToken', 'entrySol', 'stake', 'slPaidLaunch', 'slxPaidCut', 'slBr', 'spectateOnly'];
function reopen() { try { location.replace(WATCH_URL); } catch (_) { location.href = WATCH_URL; } }
function spectate() {
  if (restake) return;
  if (WATCH) { watch(watchLastId); return; }
  try {
    for (const k of MONEY_KEYS) sessionStorage.removeItem(k);
    sessionStorage.setItem('dsWatch', 'swim');
    if (myStake > 0) sessionStorage.setItem('dsWatchStake', String(myStake)); else sessionStorage.removeItem('dsWatchStake');
    if (sessionStorage.getItem('dsWatch') !== 'swim') return;
  } catch (_) { return; }
  socket.emit('sw:leave');
  reopen();
}
window.addEventListener('beforeunload', () => socket.emit(WATCH ? 'sw:unwatch' : 'sw:leave'));

/* ── watching (Knockout's, by seat) ────────────────────────────────────── */
const BAR = window.DSWatchBar || null;
const WATCH_NEXT_MS = 3000, WATCH_OVER_MS = 2200, WATCH_SWAP_MS = 1500;
let watchMatch = null, watchLastId = null, watchTimer = 0, swapping = false, swapTimer = 0;
function watch(after, dir) {
  clearTimeout(watchTimer);
  const msg = after ? { after, stake: WATCH_STAKE } : { stake: WATCH_STAKE };
  if (after && dir === 'prev') msg.dir = 'prev';
  socket.emit('sw:watch', msg);
}
function step(dir) {
  clearTimeout(watchTimer); clearTimeout(swapTimer);
  swapping = true; if (BAR) BAR.busy(true);
  swapTimer = setTimeout(() => { swapping = false; if (BAR) BAR.busy(false); }, WATCH_SWAP_MS);
  watch(watchMatch ? watchMatch.id : watchLastId, dir);
}
function followOn(ms) { clearTimeout(watchTimer); watchTimer = setTimeout(() => watch(watchLastId), ms); }
function vsLabel(names) {
  const room = 28, half = room / 2;
  const cut = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
  const a = String((names && names[0]) || 'Player').trim() || 'Player';
  const b = String((names && names[1]) || 'Player').trim() || 'Player';
  const x = a.length <= half ? a : b.length <= half ? cut(a, room - b.length) : cut(a, half);
  const y = b.length <= half ? b : a.length <= half ? cut(b, room - a.length) : cut(b, half);
  return x + ' vs ' + y;
}
socket.on('sw:watching', (m) => {
  if (!WATCH || !m) return;
  clearTimeout(watchTimer); clearTimeout(swapTimer);
  const swap = swapping; swapping = false;
  if (!m.match || !m.state) {
    watchMatch = null; race = null; overShown = false;
    $('top').hidden = true; $('dash').hidden = true; $('count').hidden = true;
    chatShow(false);
    if (BAR) BAR.empty();
    watchTimer = setTimeout(() => watch(watchLastId), WATCH_NEXT_MS);
    return;
  }
  if (swap && watchMatch && race && !overShown && m.match.id === watchMatch.id) {
    watchMatch = m.match; if (BAR) BAR.watching(vsLabel(watchMatch.names)); return;
  }
  watchMatch = m.match; watchLastId = m.match.id; overShown = false;
  race = newRace(m.state, null);
  if (m.state.state === 'racing') { race.state = 'racing'; race.startedAt = performance.now(); race.countShown = 0; }
  if (scene) scene.reset();
  showRaceUi(race);
  if (BAR) BAR.watching(vsLabel(watchMatch.names));
});
socket.on('sw:matches', ({ index, count } = {}) => {
  if (!WATCH || !watchMatch) return;
  if (Number.isFinite(index)) watchMatch.index = index;
  if (Number.isFinite(count)) watchMatch.count = count;
});
socket.on('sw:ended', ({ id } = {}) => {
  if (!WATCH || overShown) return;
  if (watchMatch && id && id !== watchMatch.id) return;
  overShown = true;
  followOn(0);
});
function watchOver(m) {
  if (overShown) return;
  overShown = true;
  if (race) race.state = 'over';
  const said = m.winner ? m.winner + ' wins' : 'Draw';
  note(said, WATCH_OVER_MS);
  followOn(WATCH_OVER_MS);
}
if (WATCH) {
  document.body.classList.add('watching');
  $('wait').hidden = true;
  if (BAR) {
    BAR.open({ game: 'swim', stake: WATCH_STAKE, onPrev: () => step('prev'), onNext: () => step('next'), onLobby: toLobby });
    BAR.watching('Finding a race');
    BAR.busy(true);
  }
}
