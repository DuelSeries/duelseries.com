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
const SOUND = window.SwimSound || { play() {}, frame() {}, stop() {} };
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
            crashed, near: Map, closes, topV, startedAt, follow } */
function newRace(m, side) {
  const traffic = new S.Traffic();
  for (const rec of m.cars || []) traffic.add(rec);
  const r = {
    id: m.id, side, vsBot: !!m.vsBot, stake: Number(m.stake) || 0, pot: Number(m.pot) || 0,
    names: [0, 1].map(s => { const p = (m.players || []).find(q => q.side === s); return p ? p.name : 'Player'; }),
    goAt: Number(m.goAt) || 0, state: 'countdown', traffic,
    me: side === null ? null : S.newCar(side),
    inputs: new Int16Array(R), hist: new Array(R).fill(null), sentTo: -1, lastSend: 0,
    rows: [null, null], disp: [null, null], seen: [0, 0],
    crashed: false, near: new Map(), closes: 0, topV: 0, startedAt: 0, follow: 0, countShown: -1,
    corrections: 0, scrapeWas: 0,
  };
  if (r.me) r.hist[0] = S.copyCar(r.me);
  for (const row of m.p || []) takeRow(r, row);
  if (clock.off === null && Number.isFinite(m.now)) clock.off = m.now - performance.now();
  return r;
}
const tickNow = () => (race ? (serverNow() - race.goAt) / S.TICK_MS : 0);

function rowCar(row) {
  return { tick: row[1], z: row[2], x: row[3], v: row[4], vx: row[5], alive: !!row[6],
           crashTick: row[6] ? -1 : row[1], hit: -1, wall: row[7] || 0 };
}
function takeRow(r, row) {
  if (!Array.isArray(row) || row.length < 8) return;
  const side = row[0];
  if (side !== 0 && side !== 1) return;
  const prev = r.rows[side];
  if (prev && prev[1] > row[1]) return;            // an older snapshot arriving late
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
  const same = h.alive === !!row[6] && h.z === row[2] && h.x === row[3] && h.v === row[4] && h.vx === row[5];
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
  const { steer, pedal } = controls();
  const code = S.packInput(steer, pedal);
  while (r.me.tick < target) {
    const c = r.me;
    r.inputs[c.tick % R] = code;
    const alive = c.alive;
    S.step(c, code, r.traffic);
    r.hist[c.tick % R] = S.copyCar(c);
    if (alive && c.alive) nearMiss(r, c);
    if (alive && !c.alive) crashed(r);
    if (c.wall !== 0 && steer * c.wall > 0) SOUND.play('sw.scrape', { vol: 0.8 });
  }
  r.steer = steer; r.pedal = pedal;
  if (r.me.v > r.topV) r.topV = r.me.v;
  /* Send every other tick: everything since the last packet and at least the last six, so a dropped
     packet costs nothing and a slow frame leaves no tick unsent (the server takes up to 12). */
  const last = r.me.tick - 1;
  if (r.me.alive && last >= 0 && last - r.sentTo >= 2) {
    const from = Math.max(0, last - 11, Math.min(r.sentTo + 1, last - 5));
    const k = [];
    for (let t = from; t <= last; t++) k.push(r.inputs[t % R]);
    socket.volatile.emit('sw:in', { t: last, k });
    r.sentTo = last;
  }
}

/* A CLOSE PASS: a car that went by within half a metre, said once per car. */
const CLOSE_M = 0.55;
function nearMiss(r, c) {
  for (let l = 0; l < S.LANES; l++) {
    const dx = Math.abs(c.x - S.laneX(l));
    if (dx > S.CAR.HW + 1.25 + CLOSE_M) continue;
    for (const rec of r.traffic.lanes[l]) {
      const t = S.TYPES[rec[2]];
      const dz = S.zAt(rec, c.tick) - c.z;
      if (dz > S.CAR.HL + t.hl + 2) break;
      if (dz < -(S.CAR.HL + t.hl + 2)) continue;
      const gap = dx - (S.CAR.HW + t.hw);
      const id = rec[0];
      if (Math.abs(dz) < S.CAR.HL + t.hl) {
        const was = r.near.get(id);
        r.near.set(id, was === undefined ? gap : Math.min(was, gap));
      } else if (dz < 0 && r.near.has(id)) {
        const g = r.near.get(id);
        r.near.delete(id);
        r.near.set(-id, 0);                         // never twice for the same car
        if (g < CLOSE_M && g >= 0) closePass(r);
      }
    }
  }
  if (r.near.size > 64) r.near.clear();
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
  let follow = null, other = null, followSide = 0, steer = 0, tickF = 0;
  if (r && (r.state === 'countdown' || r.state === 'racing' || r.state === 'over')) {
    tickF = tickNow();
    if (r.state === 'countdown') countdown(r, tickF);
    if (r.state === 'countdown' && tickF >= 0) { r.state = 'racing'; r.startedAt = performance.now(); }
    if (r.state === 'racing' && r.me) drive(r);
    if (r.me) {
      // Between the last two predicted ticks, for a smooth picture at any refresh rate.
      const a = r.me, p = r.hist[(a.tick - 1 + R) % R];
      const alpha = Math.max(0, Math.min(1, tickF - (a.tick - 1)));
      follow = p && p.tick === a.tick - 1 && a.alive
        ? { z: p.z + (a.z - p.z) * alpha, x: p.x + (a.x - p.x) * alpha, v: a.v, vx: a.vx, alive: a.alive }
        : { z: a.z, x: a.x, v: a.v, vx: a.vx, alive: a.alive };
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
  if (scene) scene.frame({ follow, other, followSide, traffic: r ? r.traffic : EMPTY, tick: tickF, dt, steer });
  SOUND.frame({ on: !!(r && r.state === 'racing' && follow && follow.alive), v: follow ? follow.v : 0, pedal: r ? r.pedal : 0 });
  publish(r, follow, other);
}
const EMPTY = new S.Traffic();

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
  return { z: d.z, x: d.x, v: row[4], vx: row[5], alive: !!row[6] };
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
let waiting = false, waitPaid = false, waitEndsAt = 0, waitTimer = 0, resumeKey = null, overShown = false, lastOver = null;
let restake = null, restakeLine = '', restakeTimer = 0, firstRace = true;
function clockText(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function paintWait() {
  if (!waiting) return;
  const left = waitEndsAt - Date.now();
  const table = '$' + myStake.toFixed(2) + ' table. ';
  if (left > 0) {
    $('waitMain').textContent = 'Looking for a player… ' + clockText(left);
    $('waitSub').textContent = waitPaid ? table + 'Real players only, never a bot. Cancel any time for a full refund.'
      : 'Free table. If nobody joins, you\'ll race a bot.';
  } else if (waitPaid) {
    $('waitMain').textContent = 'Still looking for a player';
    $('waitSub').textContent = table + 'Nobody yet. Cancel any time for a full refund.';
  } else {
    $('waitMain').textContent = 'Nobody joined. Racing a bot…';
    $('waitSub').textContent = 'Free table. Starting against a bot now.';
  }
}
function startWait(ms) { waiting = true; waitEndsAt = Date.now() + Math.max(0, ms); clearInterval(waitTimer); waitTimer = setInterval(paintWait, 250); paintWait(); }
function stopWait() { waiting = false; clearInterval(waitTimer); }
function waitSpin(on) { const s = document.querySelector('.waitSpin'); if (s) s.hidden = !on; }

socket.on('connect', () => {
  pingBurst();
  if (!scene) return;                              // no road to drive on: never take a seat, never spend a token
  if (WATCH) { swapping = false; watch(null); return; }
  if (waiting && resumeKey) { queue(null, resumeKey); return; }
  if (race && race.state === 'over') return;       // the result card is up: it stays, with its own buttons
  if (race && race.state !== 'over') {
    /* A reconnect mid-race: the server counted the drop as leaving (Knockout's rule), so the race is lost. */
    race.state = 'over';
    $('top').hidden = true; $('dash').hidden = true; $('pads').hidden = true; $('warn').hidden = true;
    chatShow(false);
    $('wait').hidden = false; waitSpin(false);
    $('waitMain').textContent = 'Your connection dropped';
    $('waitSub').textContent = 'Leaving mid-race counts as a loss. Go back to the lobby to race again.';
    $('waitCancel').textContent = 'Back to the lobby';
    return;
  }
  queue();
});
socket.on('sw:queued', (q = {}) => {
  if (WATCH || (race && race.state !== 'over')) return;
  if (typeof q.resumeKey === 'string') resumeKey = q.resumeKey;
  const total = Number(q.waitMs) > 0 ? Number(q.waitMs) : WAIT_MS;
  startWait(total - (Number(q.waitingMs) || 0));
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
  socket.emit('sw:queue', { name: myName, wallet: myWallet, stake: myStake, entryToken: token || myEntryToken, resume: resume || undefined, v: S.VERSION });
  myEntryToken = null;
  try { sessionStorage.removeItem('entryToken'); } catch (_) {}
}

let botNoteTimer = 0;
function note(text, ms) {
  const n = $('botNote');
  n.textContent = text; n.hidden = false;
  clearTimeout(botNoteTimer); botNoteTimer = setTimeout(() => { n.hidden = true; }, ms || 5000);
}

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
  stopWait(); resumeKey = null;
  const me = (m.players || []).find(p => p.id === socket.id);
  if (!me) return;
  race = newRace(m, me.side);
  overShown = false;
  if (scene) scene.reset();
  if (m.vsBot) note('Playing a bot');
  SOUND.play('g.join');
  pingBurst();
  showRaceUi(race);
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
  if (overShown || !race) return;
  overShown = true;
  race.state = 'over';
  const ms = race.startedAt ? performance.now() - race.startedAt : 0;
  const mine = (m.cars || [])[race.side];
  lastOver = Object.assign({}, m || {}, { ms, side: race.side, closes: race.closes, topKmh: Math.round(race.topV * 3.6),
                                          metres: mine ? mine.z : Math.round(race.me ? race.me.z : 0) });
  const won = m.winnerSide === race.side;
  if (m.winnerSide === null || m.winnerSide === undefined) SOUND.play('g.lose');
  else SOUND.play(won ? 'g.win' : 'g.lose');
  if (!won && m.why === 'crashed' && !race.crashed) crashed(race);
  restake = null; restakeLine = '';
  $('warn').hidden = true; $('pads').hidden = true;
  chatShow(false);
  setTimeout(paintOver, race.crashed ? 900 : 300);
});
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
    'opponent left': 'They left the race.',
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
  race = null;
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
    stopWait(); resumeKey = null;
    $('wait').hidden = false; waitSpin(false);
    $('waitMain').textContent = 'Could not start the race';
    $('waitSub').textContent = 'Go back to the lobby and press Play again.';
    $('waitCancel').textContent = 'Back to the lobby';
    return;
  }
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
  stopWait(); resumeKey = null; waitPaid = false;
  $('wait').hidden = false; waitSpin(false);
  $('waitMain').textContent = 'Not seated';
  $('waitSub').textContent = lost ? 'Your connection dropped while you waited. Your buy-in goes back to your wallet.'
    : (sentence(why) || 'The table did not let you in.');
  $('waitCancel').textContent = 'Back to the lobby';
});
socket.on('maintenance', () => {
  if (race && race.state !== 'over') return;
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
