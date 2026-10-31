'use strict';
/* ─── Rooftop Snipers, the client ─────────────────────────────────────────────
   Two wobbly snipers on a roof. This page draws the match (public/js/rooftop/
   rtArt.js paints it), reads your keys or thumbs, and sends the server what you
   are pressing.

   THE SERVER DECIDES. Falls, points, the score and who wins all come from
   server/RooftopRoom.js. The page runs the very same step (shared/rtSim.js) only
   to draw your own presses at once: it keeps the newest snapshot, replays the
   physics forward from it to the present with your own presses on top (rewind
   and replay), and draws that. When a snapshot disagrees with what was
   predicted, the difference is eased out over about a tenth of a second.

   THE PICTURE IS THE REFERENCE'S WAY OF DRAWING. Rooftop Snipers renders its
   world into a 1024 x 600 view widened to the window's shape (Godot's "viewport"
   stretch with "expand"), then scales that up without smoothing, which is where
   its chunky pixels come from. This page does the same: everything is painted
   into a small base canvas in the reference's own pixels, then blown up.

   The shell around the match (the wait card, the bot note, the result card, the
   paid Play again, Spectate, chat, maintenance, the reconnect key) is Head
   Soccer's (public/js/headsoccer.js), behaviour for behaviour, with rt: names. */

const socket = io();
if (window.DSPerfHud) DSPerfHud.mount({ socket });   // the shared ping + FPS box (public/js/shared/dsPerfHud.js)
const Sim = window.RTSim, RT = Sim.RT;
const $ = (id) => document.getElementById(id);
const cv = $('roof');
const ctx = cv.getContext('2d', { alpha: false });
const baseCv = document.createElement('canvas');
const g = baseCv.getContext('2d', { alpha: false });
const art = window.RTArt.create();
const SND = window.RooftopSound || null;
const GAME = 'rooftop';

const myName = (() => {
  try { return sessionStorage.getItem('playerName') || localStorage.getItem('duelseries_playername') || 'Player'; } catch (_) { return 'Player'; }
})();
const myWallet = (() => {
  try { return localStorage.getItem('duelseries_wallet') || null; } catch (_) { return null; }
})();
/* The buy-in and the proof it was paid, written by the wallet widget just before it opens this page. Neither is
   trusted here or on the wire: the server re-reads the token and takes the worth it recorded on-chain. */
const myStake = (() => {
  try { return Number(sessionStorage.getItem('stake')) || 0; } catch (_) { return 0; }
})();
let myEntryToken = (() => {
  try { return sessionStorage.getItem('entryToken') || null; } catch (_) { return null; }
})();
function shopFields() {
  try {
    const shop = localStorage.getItem('duel.shop.rooftop'), pass = localStorage.getItem('duel.skinpass');
    if (shop && pass && /^[a-z][a-z0-9]{0,23}$/.test(shop) && pass.length <= 4096) return { shop, skinPass: pass };
  } catch (_) { /* storage blocked: the free look */ }
  return {};
}
/* The free look picked in the lobby's Customize (shared/rtLooks.js, stored under duel.rooftop.look): an id on the
   list, else nothing (Random, a different sniper each round). The server keeps only a listed id and tells both
   screens and every watcher which sniper each seat wears (players[].look). */
function lookField() {
  try {
    const L = window.DS_RT_LOOKS, id = L ? localStorage.getItem(L.KEY) : null;
    if (L && L.byId(id)) return { look: id };
  } catch (_) { /* storage blocked: Random */ }
  return {};
}
const FRAMED =(() => { try { return !!window.parent && window.parent !== window; } catch (_) { return true; } })();

/* WATCHING, NOT PLAYING: the lobby's Spectate writes 'dsWatch' with the game just before it opens this page. Read
   once and removed at once; honoured only when it names this game. A watcher never queues and never sends a key. */
const WATCH = (() => {
  try {
    const v = sessionStorage.getItem('dsWatch');
    if (v !== null) sessionStorage.removeItem('dsWatch');
    return v === GAME;
  } catch (_) { return false; }
})();
const WATCH_STAKE = (() => {
  try {
    const s = Number(sessionStorage.getItem('dsWatchStake'));
    sessionStorage.removeItem('dsWatchStake');
    return Number.isFinite(s) && s > 0 ? s : 0;
  } catch (_) { return 0; }
})();

/* PRODUCT TRACKING (public/js/shared/dsTrack.js; every event name is in shared/trackPlan.js), as knockout.js does
   it: one session for this page, the wait, each match and its result, or Spectate. A paid match's start and end are
   the server's to send; leaving mid-match is the helper's own. Never lets a failure reach the game. */
const TRACKER = (() => {
  try {
    if (!window.DSTrack) return null;
    const stake = WATCH ? WATCH_STAKE : myStake;
    const t = window.DSTrack.game(GAME, { paid: stake > 0, stake, mode: stake > 0 ? 'paid' : 'free' });
    if (WATCH) t.spectate();
    return t;
  } catch (_) { return null; }
})();
function trackStep(step, arg) {
  if (!TRACKER) return;
  try {
    if (step === 'queue') {
      if (TRACKER.stage === 'queue') return;              // a reconnect's resumed seat is the same wait
      TRACKER.set({ vs_bot: undefined, room: undefined });   // the last match's, not this queue's
    }
    TRACKER[step](arg);
  } catch (_) { /* analytics never breaks the game */ }
}
// won, lost or draw; lost because this seat's own connection stayed down is 'left' (see knockout.js).
function trackResult(won, why) {
  return won === true ? 'won' : won === false ? (why === 'opponent left' ? 'left' : 'lost') : 'draw';
}
const WATCH_NEXT_MS = 3000;
const WATCH_OVER_MS = 1800;
const WATCH_SWAP_MS = 1500;
const seatId = (side) => 's' + side;
const BAR = window.DSWatchBar || null;
let watchMatch = null, watchLastId = null, watchTimer = 0, swapping = false, swapTimer = 0;

/* ── the match on screen ─────────────────────────────────────────────────── */
let me = null;
let match = null;             // { id, vsBot, players, names, stake, pot } while a match is on screen
let mySeat = -1;              // 0 red (starts left), 1 blue (starts right); -1 while watching
let phase = null;             // the server's state: countdown (ready-up) | playing | settling | over
let score = [0, 0];
let overShown = false;
let lastOver = null;
let matchAt = 0;
let restake = null, restakeLine = '', restakeTimer = 0;
const series = { mine: 0, theirs: 0 };

/* ── the latest snapshot ──────────────────────────────────────────────────── */
const base = Sim.newMatch(1);
let haveBase = false, baseK = 0, baseAt = 0, baseFresh = false, baseAck = 0, lastSnap = null;
const wbuf = [];              // a watcher's last few snapshots

/* ── prediction ───────────────────────────────────────────────────────────── */
const sim = Sim.newMatch(1);  // the present, as predicted
let predicting = false;
let clientTick = 0;
let frontier = 0;             // the newest tick ever stepped: events at or before it were already heard
let forceSnap = false;
const off = [{ x: 0, y: 0, a: 0 }, { x: 0, y: 0, a: 0 }];
const was = [{ x: 0, y: 0, a: 0 }, { x: 0, y: 0, a: 0 }];
const CORRECT_MS = 100;
const SNAP_PX = [120, 260];

const inp = { j: 0, d: 0, r: 0, n: 0 };    // running counts; n is the last shot's hold in ticks
let seq = 0;
const hist = [];              // every change of input: { seq, tick, j, d, r, n }
let downTick = -1;            // the tick my shoot press takes effect on (to count the hold)

/* What gets drawn: each player's body (predicted or interpolated, plus eased corrections) and the look. */
const rp = [mkRender(), mkRender()];
function mkRender() { return { x: 0, y: 0, a: 0, sx: 1, raising: false, arm: 0, enabled: false }; }
let drawable = false;

/* ── latency (the server's ping, the median of the last five, clamped) ── */
let rtt = 80, pingSentAt = 0, pingTimer = 0;
const rtts = [];
const oneWay = () => Math.max(0, Math.min(150, rtt / 2));
socket.on('pong_check', () => {
  if (!pingSentAt) return;
  const r = performance.now() - pingSentAt;
  pingSentAt = 0;
  if (!(r >= 0 && r < 3000)) return;
  rtts.push(r);
  if (rtts.length > 5) rtts.shift();
  const sorted = rtts.slice().sort((a, b) => a - b);
  rtt = sorted[sorted.length >> 1];
});
function ping() {
  if (socket.connected) { pingSentAt = performance.now(); socket.emit('ping_check'); }
  clearTimeout(pingTimer);
  pingTimer = setTimeout(ping, rtts.length < 5 ? 500 : 2000);
}

/* ── the view ────────────────────────────────────────────────────────────────
   The reference's: a 1024 x 600 view, widened (or heightened) to the window's shape, never cropped, then scaled
   to fill the window. Held sideways or on a computer that is a strip of sky and roof; held upright the reference
   covers everything with a "turn your phone" card (OrientationManager: width / height < 1), and so does this. */
let VIEW = { w: 0, h: 0, dpr: 1, bw: 1024, bh: 600, k: 1, portrait: false };
let touchUI = (() => {
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
    return (navigator.maxTouchPoints || 0) > 0 && !(window.matchMedia && window.matchMedia('(pointer: fine)').matches);
  } catch (_) { return false; }
})();

function fit() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  const ar = w / Math.max(1, h);
  let bw, bh;
  if (ar >= 1024 / 600) { bh = 600; bw = Math.round(600 * ar); } else { bw = 1024; bh = Math.round(1024 / ar); }
  if (baseCv.width !== bw || baseCv.height !== bh) { baseCv.width = bw; baseCv.height = bh; }
  VIEW = { w, h, dpr, bw, bh, k: w / bw, portrait: ar < 1 };
  $('rotate').hidden = !VIEW.portrait || !match || WATCH;
  placeOverlays();
}
function refit() {
  if (cv.style.width !== window.innerWidth + 'px' || cv.style.height !== window.innerHeight + 'px') fit();
}
window.addEventListener('resize', fit);
window.addEventListener('orientationchange', fit);

/* The two phone buttons and the pause button, in base pixels (T: GameCanvas PlayerButtons/1Player, 150 x 100 each,
   60 in from each side and 19 up from the bottom; TopBar/PauseButton 72 x 90 in the top left corner). */
function buttonRects() {
  const bw = VIEW.bw, bh = VIEW.bh;
  return {
    J: { x: 60, y: bh - 119, w: 150, h: 100 },
    S: { x: bw - 210, y: bh - 119, w: 150, h: 100 },
    P: { x: 0, y: 0, w: 72, h: 90 },
  };
}
const toBase = (x, y) => [x / VIEW.k, y / VIEW.k];
function hitButton(cx, cy) {
  const [x, y] = toBase(cx, cy), B = buttonRects();
  for (const k of ['J', 'S']) {
    const b = B[k], pad = 24;
    if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) return k;
  }
  // Anywhere on the left or right third of the bottom half counts too: thumbs miss.
  if (y > VIEW.bh * 0.5) { if (x < VIEW.bw / 3) return 'J'; if (x > VIEW.bw * 2 / 3) return 'S'; }
  return null;
}
function onPause(cx, cy) {
  const [x, y] = toBase(cx, cy), b = buttonRects().P;
  return x >= b.x && x <= b.x + b.w + 10 && y >= b.y && y <= b.y + b.h + 10;
}
/* SOUND: the speaker rtArt draws in the top right corner (the pause button's mirror, 82 x 100 base px to tap) and the
   M key both switch the music and the effects together; rooftopSound.js remembers it on this device. */
function onSound(cx, cy) {
  const [x, y] = toBase(cx, cy);
  return !!SND && x >= VIEW.bw - 82 && y <= 100;
}
function toggleSound() { if (SND) SND.toggle(); }

function placeOverlays() {
  // Under "Press JUMP button to ready up" (drawn at 150), not on it (site sweep 2026-10-28).
  const note = $('botNote'); if (note) note.style.top = Math.round(200 * VIEW.k) + 'px';
  const line = $('watchLine'); if (line) line.style.top = Math.round(150 * VIEW.k) + 'px';
  if (chat && chat.el) {
    chat.el.style.setProperty('--dsc-t', '70px');
    chat.el.style.setProperty('--dsc-b', Math.round(140 * VIEW.k) + 'px');
  }
}

/* The pause button: an online match cannot stop, so it offers the way out. */
let pauseAsk = false;
function pauseMenu() {
  if (pauseAsk || !match || overShown) return;
  if (WATCH) { toLobby(); return; }
  if (!window.DSDialog) { toLobby(); return; }
  pauseAsk = true;
  releaseAll();
  window.DSDialog.confirm({
    title: 'Leave the match?',
    line: 'The match keeps going without a pause. Leaving now hands it to your opponent.',
    ok: 'Leave', cancel: 'Keep playing',
  }).then((yes) => { pauseAsk = false; if (yes) toLobby(); }, () => { pauseAsk = false; });
}

/* ── input ────────────────────────────────────────────────────────────────────
   The reference's keys: W to jump, E held to raise the gun and let go to fire (its player 2's I and O work too).
   Every message is the whole state (running counts of jumps, shoot presses and releases, and how many ticks the
   last shot was held), sent on every change and repeated every 250 ms while the match runs, so a dropped one never
   loses a press. A change goes reliably; the repeats go volatile. Never more than 30 in half a second. */
const KEYS = { KeyW: 'J', KeyI: 'J', KeyE: 'S', KeyO: 'S' };
let shootDown = false;
let sentAt = 0, winAt = 0, winN = 0, sendTimer = 0;
// Offline nothing is pressed: the server holds the seat as it was (the seat hold below), so the screen does the same.
const canPlay = () => !WATCH && !!match && mySeat >= 0 && !overShown && phase !== 'over' && socket.connected;

function sendInput(reliable) {
  if (!canPlay()) return;
  const t = performance.now();
  if (t - winAt > 500) { winAt = t; winN = 0; }
  if (winN >= 30) {
    if (!sendTimer) sendTimer = setTimeout(() => { sendTimer = 0; sendInput(true); }, Math.max(5, 505 - (t - winAt)));
    return;
  }
  winN++; sentAt = t;
  const msg = { s: seq, j: inp.j, d: inp.d, r: inp.r, n: inp.n };
  if (reliable) socket.emit('rt:in', msg); else socket.volatile.emit('rt:in', msg);
}
/* A change of input, remembered with the tick it takes effect on (the next one stepped), so a replay from an older
   snapshot applies it at the same moment the server will. */
function nextTick() {
  const last = hist.length ? hist[hist.length - 1].tick : 0;
  return predicting ? Math.max(last, sim.tick + 1) : last;
}
function inputChanged(t) {
  seq++;
  hist.push({ seq, tick: t, j: inp.j, d: inp.d, r: inp.r, n: inp.n });
  if (hist.length > 200) hist.shift();
  sendInput(true);
}
function jumpPress() { if (!canPlay()) return; inp.j++; inputChanged(nextTick()); }
function shootPress() {
  if (!canPlay() || shootDown) return;
  shootDown = true;
  const t = nextTick();
  downTick = t;
  inp.d++;
  inputChanged(t);
}
function shootRelease() {
  if (!shootDown) return;
  shootDown = false;
  if (!canPlay()) return;
  const t = nextTick();
  // The hold, in ticks, from the press's tick to this one: the arm turns 6 degrees a tick (S: 360 * delta).
  inp.n = Math.max(0, Math.min(RT.MAX_HELD, t - Math.max(0, downTick)));
  inp.r++;
  inputChanged(t);
}
const typingIn = (e) => {
  const t = e.target;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};
window.addEventListener('keydown', (e) => {
  // An Escape that just closed DSDialog arrives here marked defaultPrevented: without this check the closed
  // "Leave the match?" opened again at once and Esc could never dismiss it (site sweep 2026-10-28).
  if (e.code === 'Escape' && canPlay() && !e.defaultPrevented) { pauseMenu(); return; }
  if (e.code === 'KeyM' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !typingIn(e)) { toggleSound(); return; }
  const a = KEYS[e.code];
  if (!a || typingIn(e) || !canPlay()) return;
  e.preventDefault();
  if (e.repeat) return;
  if (a === 'J') jumpPress(); else shootPress();
});
window.addEventListener('keyup', (e) => {
  const a = KEYS[e.code];
  if (a === 'S') shootRelease();
});
function releaseAll() {
  fingers.clear();
  if (shootDown) shootRelease();
}
window.addEventListener('blur', releaseAll);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

/* Fingers: each pointer on its own, so one thumb can hold Shoot while the other taps Jump. */
const fingers = new Map();     // pointerId -> 'J' | 'S' | null
const fingerOn = (k) => { for (const b of fingers.values()) if (b === k) return true; return false; };
cv.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch' && !touchUI) touchUI = true;
  if (match && !overShown && onPause(e.clientX, e.clientY)) { e.preventDefault(); pauseMenu(); return; }
  if (match && onSound(e.clientX, e.clientY)) { e.preventDefault(); toggleSound(); return; }
  if (!touchUI || !canPlay()) return;
  e.preventDefault();
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  const b = hitButton(e.clientX, e.clientY);
  fingers.set(e.pointerId, b);
  if (b === 'J') jumpPress();
  else if (b === 'S') shootPress();
});
const lift = (e) => {
  if (!fingers.has(e.pointerId)) return;
  const b = fingers.get(e.pointerId);
  fingers.delete(e.pointerId);
  if (b === 'S' && !fingerOn('S')) shootRelease();
};
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
cv.addEventListener('lostpointercapture', lift);
cv.addEventListener('contextmenu', (e) => e.preventDefault());

/* ── snapshots ─────────────────────────────────────────────────────────────── */
function onSnap(s) {
  if (!match || !s || !Array.isArray(s.p) || s.p.length < 2) return;
  const k = Number(s.k) || 0;
  if (haveBase && k < baseK) return;
  const t = performance.now();
  try { Sim.unpack(base, s); } catch (_) { return; }
  lastSnap = s;
  if (Array.isArray(s.sc) && s.sc.length === 2) score = [s.sc[0] | 0, s.sc[1] | 0];
  if (!WATCH && mySeat >= 0 && Array.isArray(s.a)) {
    baseAck = Number(s.a[mySeat]) || 0;
    while (hist.length > 1 && hist[1].seq <= baseAck) hist.shift();
  }
  if (typeof s.st === 'string') setPhase(s.st);
  if (typeof s.rm === 'number') readyLeft = { ms: s.rm, at: t };
  baseK = k; baseAt = t; baseFresh = true; haveBase = true;
  if (WATCH) { wbuf.push({ k, s }); if (wbuf.length > 12) wbuf.shift(); }
}
socket.on('rt:snap', onSnap);
let readyLeft = { ms: 0, at: 0 };

const LIVE_PHASES = { countdown: 1, playing: 1, settling: 1 };
function setPhase(p) {
  if (p === phase) return;
  phase = p;
  if (!LIVE_PHASES[p]) predicting = false;
}

/* ── the replay ──────────────────────────────────────────────────────────────
   The present is the newest snapshot's tick plus the time since it came plus the trip there and back: a press
   sent now lands on the server at the tick it was drawn at. */
function wantTick(now) { return baseK + (now - baseAt + 2 * oneWay()) * 0.06 + 0.5; }
function inputFor(t) {
  let best = null;
  for (let i = 0; i < hist.length; i++) {
    const h = hist[i];
    if (h.seq <= baseAck || h.tick <= t) best = h; else break;
  }
  return best || { j: 0, d: 0, r: 0, n: 0 };
}
const oppIn = { j: 0, d: 0, r: 0, n: 0 };
function stepSim() {
  const t = sim.tick + 1;
  const o = sim.p[1 - mySeat];
  // The other player: no presses we have not been told about.
  oppIn.j = o.nj; oppIn.d = o.nd; oppIn.r = o.nr; oppIn.n = 0;
  const inputs = [null, null];
  inputs[mySeat] = inputFor(t);
  inputs[1 - mySeat] = oppIn;
  const roundWas = sim.round;
  const ev = Sim.tick(sim, inputs);
  if (t > frontier) {
    frontier = t;
    for (const e of ev) {
      if (e.s !== mySeat) continue;
      if (e.e === 'shot') { addTracer(e, true); if (SND) SND.local('shot', e.s, e.f[0], !!e.hit); }
      else if (e.e === 'rocket') { arms[e.s].kick = performance.now(); if (SND) SND.local('rocket', e.s, e.f[0]); }
      else if (e.e === 'toss') { arms[e.s].kick = performance.now(); if (SND) SND.local('toss', e.s, 0); }
      else if (e.e === 'jump' && SND) SND.local('jump', e.s, sim.p[e.s].body.x);
    }
  }
  if (sim.round !== roundWas) newRoundLook(sim.round);
}
function advance(target, cap) {
  let n = 0;
  while (sim.tick < target && n < cap) { stepSim(); n++; }
}
function loadBase() { if (lastSnap) Sim.unpack(sim, lastSnap); }

function predict(now, dt) {
  const want = wantTick(now);
  if (!predicting) {
    predicting = true;
    clientTick = want;
    loadBase();
    baseFresh = false;
    frontier = Math.max(frontier, sim.tick);
    advance(Math.floor(clientTick), 12);
    for (const o of off) { o.x = 0; o.y = 0; o.a = 0; }
  } else {
    clientTick += dt * 0.06;
    const err = want - clientTick;
    if (Math.abs(err) > 6) clientTick = want;
    else clientTick += err * Math.min(1, dt / 400);
  }
  const target = Math.floor(clientTick);
  advance(target, 4);
  if (baseFresh) {
    baseFresh = false;
    for (let i = 0; i < 2; i++) { const b = sim.p[i].body; was[i].x = b.x + off[i].x; was[i].y = b.y + off[i].y; was[i].a = b.a + off[i].a; }
    const roundWas = sim.round;
    loadBase();
    advance(target, 12);
    for (let i = 0; i < 2; i++) {
      const b = sim.p[i].body, o = off[i];
      o.x = was[i].x - b.x; o.y = was[i].y - b.y; o.a = angleDiff(was[i].a, b.a);
      if (forceSnap || sim.round !== roundWas || Math.hypot(o.x, o.y) > SNAP_PX[i === mySeat ? 0 : 1]) { o.x = 0; o.y = 0; o.a = 0; }
    }
    forceSnap = false;
  }
  const decay = Math.exp(-dt / CORRECT_MS);
  for (const o of off) { o.x *= decay; o.y *= decay; o.a *= decay; }
  const frac = Math.max(0, Math.min(1, clientTick - sim.tick));
  for (let i = 0; i < 2; i++) toRender(rp[i], sim.p[i], frac * sim.ts, off[i]);
  cur = sim;
}
const angleDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
function toRender(r, p, frac, o) {
  const b = p.body, dt = frac * RT.STEP;
  r.x = b.x + b.vx * dt + (o ? o.x : 0);
  r.y = b.y + b.vy * dt + (o ? o.y : 0);
  r.a = b.a + b.w * dt + (o ? o.a : 0);
  r.sx = p.sx; r.raising = p.raising; r.arm = p.arm; r.enabled = p.enabled;
}

/* A watcher draws the match about 100 ms behind the newest snapshot, between the two either side of that moment. */
let wTick = 0;
const wsim = Sim.newMatch(1), wsim2 = Sim.newMatch(1);
let cur = sim;                 // the match whose round, score and modifiers are on screen
function interpolate(now, dt) {
  if (!wbuf.length) return;
  const last = wbuf[wbuf.length - 1];
  const want = last.k + (now - baseAt) * 0.06 - 6;
  wTick += dt * 0.06;
  if (Math.abs(want - wTick) > 20) wTick = want; else wTick += (want - wTick) * Math.min(1, dt / 400);
  let a = last, b = last;
  if (wTick < last.k) {
    a = wbuf[0]; b = wbuf[0];
    for (let i = wbuf.length - 1; i > 0; i--) { if (wbuf[i - 1].k <= wTick) { a = wbuf[i - 1]; b = wbuf[i]; break; } }
  }
  const u = b.k > a.k ? Math.max(0, Math.min(1, (wTick - a.k) / (b.k - a.k))) : 1;
  Sim.unpack(wsim, a.s); Sim.unpack(wsim2, b.s);
  const roundNow = wsim2.round;
  for (let i = 0; i < 2; i++) {
    const p = wsim.p[i].body, q = wsim2.p[i].body, r = rp[i];
    toRender(r, wsim2.p[i], 0, null);
    if (wsim.round === wsim2.round && Math.abs(p.x - q.x) + Math.abs(p.y - q.y) < 300) {
      r.x = p.x + (q.x - p.x) * u; r.y = p.y + (q.y - p.y) * u; r.a = p.a + angleDiff(q.a, p.a) * u;
    }
  }
  if (roundNow !== shownRound) newRoundLook(roundNow);
  cur = wsim2;
}

/* ── the look between frames: camera, arms, tracers, sparks ───────────────── */
// S: CameraFollow.gd. Each round starts zoomed out at 1.65 (the scene's Camera2D) and settles on the two players.
const cam = { x: 0, y: -150, z: 1.65, tz: 1, target: -1, speed: 5 };
let shownRound = 0;
const arms = [{ wa: 0, w: 0, kick: -1 }, { wa: 0, w: 0, kick: -1 }];   // each hanging arm's angle in the world
const tracers = [];           // { fx, fy, hx, hy, strong, t0, side }
const sparks = [];            // blood bits: { x, y, vx, vy, life, t, size }
let labelAt = -1e9, pointAt = -1e9, pointSide = -1, fallAt = -1e9, goAt = -1e9, endAt = -1e9, roundAt = -1e9;
let firstRoundOfMatch = true;

function newRoundLook(r) {
  shownRound = r;
  cam.x = 0; cam.y = -150; cam.z = 1.65; cam.tz = 1; cam.target = -1; cam.speed = 5;
  for (const a of arms) { a.wa = 0; a.w = 0; a.kick = -1; }
  tracers.length = 0; sparks.length = 0;
  roundAt = performance.now();
  pointAt = -1e9; fallAt = -1e9;
  if (r > 1) { labelAt = roundAt; firstRoundOfMatch = false; }
  art.newRound(r);
}
function camStep(dt, m) {
  const p0 = rp[0], p1 = rp[1];
  let px, py;
  if (cam.target < 0) {
    const dist = p0.x - p1.x, mid = dist / 2, x = p0.x - mid;
    const scaleDiff = Math.max(0, Math.min(600, Math.abs(mid) - 350));
    cam.tz = Math.max(1, Math.min(5, (350 + scaleDiff) / 350));
    px = x; py = cam.y;
  } else { px = rp[cam.target].x; py = rp[cam.target].y; }
  const u = Math.min(1, dt * cam.speed);
  cam.x = Math.round(cam.x + (px - cam.x) * u);
  cam.y = Math.round(cam.y + (py - cam.y) * u);
  cam.z = cam.z + (cam.tz - cam.z) * Math.min(1, dt * 3);
}
// The arm after a shot hangs from its pin and swings back down (T: the arm's own RigidBody2D, gravity 98, angular
// damp 4, its weight 14 below the pin): a pendulum, drawn only.
function armStep(dt, i) {
  const r = rp[i], a = arms[i];
  if (r.raising) { a.wa = r.a + r.arm * r.sx * Math.PI / 180; a.w = 0; return; }
  const k = 0.05 * 98 * 14 / 19.3;
  a.w += -k * Math.sin(a.wa) * dt;
  a.w *= Math.max(0, 1 - 4 * dt);
  a.wa += a.w * dt;
}
function addTracer(e, local) {
  const now = performance.now();
  // The server's copy of my own predicted shot replaces it rather than drawing a second line.
  if (!local && e.s === mySeat && !WATCH) {
    for (const t of tracers) if (t.side === e.s && t.local && now - t.t0 < 600) { t.hx = e.h[0]; t.hy = e.h[1]; t.local = false; if (e.hit && !t.hit) { t.hit = true; blood(e); } return; }
  }
  tracers.push({ fx: e.f[0], fy: e.f[1], hx: e.h[0], hy: e.h[1], strong: !!e.strong, t0: now, side: e.s, local: !!local, hit: !!e.hit });
  if (tracers.length > 12) tracers.shift();
  arms[e.s].kick = now;
  if (e.hit) blood(e);
}
// T: BloodParticles: 12 bits, 600 px/s (65% random), 20 degrees around the shot, gravity 700, half a second.
function blood(e) {
  const dx = e.h[0] - e.f[0], dy = e.h[1] - e.f[1], l = Math.hypot(dx, dy) || 1, base = Math.atan2(dy, dx);
  for (let i = 0; i < 12; i++) {
    const ang = base + (Math.random() - 0.5) * (20 * Math.PI / 180) * 2;
    const v = 600 * (1 - Math.random() * 0.65);
    sparks.push({ x: e.h[0], y: e.h[1], vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, life: 0.5 * (1 - Math.random() * 0.25), t: 0, size: 8 * (1 - Math.random() * 0.4) });
  }
  void l;
}
// T: ExplosionParticles (our own burst): a ring of hot squares that grow, cool and fade over half a second.
function boom(x, y) {
  for (let i = 0; i < 18; i++) {
    const ang = Math.random() * Math.PI * 2, v = 120 + Math.random() * 260;
    sparks.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v - 60, life: 0.45 + Math.random() * 0.2, t: 0, size: 14 + Math.random() * 10, fire: true });
  }
}
function sparkStep(dt) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.t += dt;
    if (s.t >= s.life) { sparks.splice(i, 1); continue; }
    const d = Math.max(0, Math.hypot(s.vx, s.vy) - 100 * dt), sp = Math.hypot(s.vx, s.vy) || 1;
    s.vx = s.vx / sp * d; s.vy = s.vy / sp * d + (s.fire ? 0 : 700 * dt);
    s.x += s.vx * dt; s.y += s.vy * dt;
  }
}

/* ── the loop ─────────────────────────────────────────────────────────────── */
let lastFrame = performance.now();
function frame() {
  const now = performance.now();
  const dt = Math.min(100, Math.max(0, now - lastFrame));
  lastFrame = now;
  refit();
  update(now, dt);
  draw(now);
  requestAnimationFrame(frame);
}

function update(now, dt) {
  drawable = false;
  if (!match && WATCH) { art.tick(dt / 1000, EMPTY_CAM, VIEW.bw, VIEW.bh); return; }   // the empty roof's clouds
  if (!match || !haveBase) return;
  if (WATCH) interpolate(now, dt);
  else if (mySeat >= 0 && LIVE_PHASES[phase]) predict(now, dt);
  else {
    for (let i = 0; i < 2; i++) toRender(rp[i], base.p[i], 0, null);
    cur = base;
    if (base.round !== shownRound) newRoundLook(base.round);
  }
  drawable = true;
  if (cur && cur.round !== shownRound) newRoundLook(cur.round);
  if (canPlay() && now - sentAt > 250) sendInput(false);
  const ts = cur.ts || 1, sdt = dt / 1000 * ts;
  camStep(sdt, cur);
  for (let i = 0; i < 2; i++) armStep(sdt, i);
  sparkStep(sdt);
  art.tick(sdt, cam, VIEW.bw, VIEW.bh);
}

function draw(now) {
  const V = VIEW;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!match && WATCH) { emptyRoof(now); return; }
  if (!match || !drawable) {
    ctx.fillStyle = '#6dd9e8';
    ctx.fillRect(0, 0, cv.width, cv.height);
    return;
  }
  const m = cur;
  const scene = {
    now, cam, bw: V.bw, bh: V.bh, mods: m.mods, round: m.round, chars: m.chars || [0, 1],
    players: [0, 1].map(i => ({ x: rp[i].x, y: rp[i].y, a: rp[i].a, sx: rp[i].sx, armA: arms[i].wa, kick: arms[i].kick,
                                raising: rp[i].raising, side: i, reloaded: m.p[i].reloaded })),
    tracers, sparks, ts: m.ts || 1,
    rockets: (m.objs || []).filter(r => !r.k).map(r => ({ x: r.body.x, y: r.body.y, a: r.body.a, side: r.side })),
    // the round's other objects (tomahawks, civilians, beach balls) and the Elevator's car and doors
    objs: (m.objs || []).filter(r => r.k).map(r => ({ k: r.k, x: r.body.x, y: r.body.y, a: r.body.a, side: r.side, ch: r.ch, fl: r.fl })),
    lift: Sim.liftY(m), doors: Sim.doorsShut(m.anim || 0),
  };
  art.world(g, scene);
  const B = buttonRects();
  const ready = phase === 'countdown';
  const hud = {
    now, bw: V.bw, bh: V.bh, score, label: Sim.modLabel(m.mods), labelAt, pointAt, pointSide, roundAt,
    first: m.round === 1, playTo: RT.PLAY_TO, goAt, endAt, winner: m.winner, timeUpAt,
    matchPoint: m.round > 1 && (RT.PLAY_TO - score[0] <= 1 || RT.PLAY_TO - score[1] <= 1),
    pause: !overShown && phase !== 'over',
    sound: SND ? (SND.muted() ? 'off' : 'on') : null,      // the speaker, top right (onSound)
    ready, readyMine: mySeat, readyFlags: m.ready || [false, false],
    readyMs: ready ? Math.max(0, readyLeft.ms - (now - readyLeft.at)) : 0,
    buttons: (touchUI || ready) && canPlay() ? B : null, touch: touchUI,   // S: on a computer only while readying up
    pressed: { J: fingerOn('J'), S: fingerOn('S') || shootDown }, mySeat, watch: WATCH,
    names: match.names, tags: [tagAt(0), tagAt(1)],
  };
  art.hud(g, hud);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(baseCv, 0, 0, cv.width, cv.height);
}
/* Where a seat's name goes on screen: over the top of its head, kept upright whatever the body's tilt (the body's
   middle is 44 above its feet pin and it stands 72 either side of that; rtArt drawBody). */
function tagAt(i) {
  const p = rp[i], z = cam.z || 1;
  const mx = p.x + 44 * Math.sin(p.a), my = p.y - 44 * Math.cos(p.a);
  return { x: (mx - cam.x) / z + VIEW.bw / 2, y: (my - cam.y) / z + VIEW.bh / 2 - 72 / z, name: match.names[i] };
}
/* Spectate with nobody to follow: the empty roof (the normal map, no snipers) behind the Spectate bar's "Nobody is
   playing yet", as Head Soccer shows its empty pitch, instead of a blank sky. */
const EMPTY_CAM = { x: 0, y: -150, z: 1 };
const EMPTY_MODS = [0, 0, 0, 0, 0];
let emptyClouds = false;
function emptyRoof(now) {
  if (!emptyClouds) { art.newRound(); emptyClouds = true; }
  art.world(g, {
    now, cam: EMPTY_CAM, bw: VIEW.bw, bh: VIEW.bh, mods: EMPTY_MODS, round: 1, chars: [0, 1], players: [],
    tracers: [], sparks: [], ts: 1, rockets: [], objs: [], lift: -180, doors: false,
  });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(baseCv, 0, 0, cv.width, cv.height);
}

/* ── chat ── the one DuelSeries chat box: T to type, Enter to send. Only the two seated players can speak. */
let chatLive = false;
const chat = DSChat.mount({
  send: (t) => { socket.emit('rt:chat', { text: t }); return true; },
  canSend: () => chatLive && !WATCH,
  pc: { left: 14, bottom: 150 },
  phoneAt: { left: 84, top: 10 },
});
function chatShow(on) { chatLive = on; chat.visible(on); }
socket.on('rt:chat', (m) => {
  if (!m) return;
  const mine = !WATCH && m.side === mySeat;
  chat.add({ name: m.name, color: m.side === 1 ? '#8db8ff' : '#ff8a80', text: m.text, me: mine });
});
socket.on('rt:chatnote', (m) => { if (m) chat.add({ kind: 'sys', text: m.text }); });

let botNoteTimer = 0;
function botNote() {
  const n = $('botNote');
  if (!n) return;
  n.hidden = false;
  clearTimeout(botNoteTimer);
  botNoteTimer = setTimeout(() => { n.hidden = true; }, 5000);
}

/* ── what the server says ──────────────────────────────────────────────── */
const cut = (s, n) => { const t = String(s || 'Player'); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function startMatch(m) {
  const players = m.players || [];
  mySeat = -1;
  if (!WATCH) { const p = players.find(q => q.id === me); mySeat = p ? (p.side === 1 ? 1 : 0) : -1; }
  const names = ['', ''];
  for (const p of players) if (p.side === 0 || p.side === 1) names[p.side] = cut(p.name, 16);
  if (m.vsBot && mySeat >= 0) names[1 - mySeat] = cut(names[1 - mySeat] || 'Opponent', 12) + ' (bot)';
  match = { id: m.id, vsBot: !!m.vsBot, players, names, stake: m.stake, pot: m.pot };
  score = Array.isArray(m.score) && m.score.length === 2 ? [m.score[0] | 0, m.score[1] | 0] : [0, 0];
  overShown = false; lastOver = null;
  phase = null; setPhase(m.state || 'countdown');
  inp.j = 0; inp.d = 0; inp.r = 0; inp.n = 0; seq = 0; hist.length = 0; baseAck = 0; shootDown = false; downTick = -1;
  fingers.clear();
  predicting = false; frontier = 0; forceSnap = true;
  for (const o of off) { o.x = 0; o.y = 0; o.a = 0; }
  haveBase = false; baseFresh = false; wbuf.length = 0; baseK = 0; lastSnap = null;
  shownRound = 0; firstRoundOfMatch = true; goAt = m.state === 'countdown' ? -1e9 : performance.now() - 5000; endAt = -1e9;
  timeUpAt = -1e9;   // a timed-out match's "Time up" never carries into the next one
  emptyClouds = false;
  if (m.snap) onSnap(m.snap);
  // Each seat's free look from the server (players[].look, shared/rtLooks.js); a seat without one stays random.
  const looks = [null, null];
  for (const p of players) if ((p.side === 0 || p.side === 1) && typeof p.look === 'string') looks[p.side] = p.look;
  art.setLooks(looks);
  $('wait').hidden = true;
  fit();
  chatShow(true);
  if (SND) SND.music(m.state !== 'over');   // the match's music, until the result (rooftopSound.js)
}

socket.on('connect', () => {
  rtts.length = 0;
  ping();
  if (WATCH) { me = null; swapping = false; watch(null); return; }
  me = socket.id;
  if (overShown) return;
  /* A match this socket was in: the server holds the seat for five seconds and the seat's key takes it back
     (rt:rejoined below). Without a key, or too late, the drop was a walk-out, as it always was. */
  if (match && seatHold && seatHold.rejoin()) return;
  if (match) dropMatch();
  if (waiting && resumeKey) { queue(null, resumeKey); return; }
  queue();
});

/* THE SEAT HOLD (public/js/shared/dsSeatHold.js, server/KnockoutLobby.js drop / rejoin): a connection that blinks
   mid-match keeps its seat for five seconds while the match runs on; "Reconnecting..." on the small pill meanwhile,
   and the other player and watchers are told the same. */
const seatHold = window.DSSeatHold ? window.DSSeatHold.create({
  socket, ev: 'rt', watch: WATCH, pill: $('botNote'), line: $('watchLine'),
  live: () => !!match && !overShown, nameOf: (s) => match && match.names[s], mySeat: () => mySeat,
}) : null;
/* The seat back on this socket: the match as the server has it now, and this seat's input counts and sequence carried
   on from the server's (a count only ever goes up, so counting from zero again would press nothing). */
socket.on('rt:rejoined', (m) => {
  if (WATCH || !m || !match || overShown) return;
  if (seatHold) seatHold.back();
  me = socket.id;
  startMatch(m);
  const c = m.inp || {};
  inp.j = c.j | 0; inp.d = c.d | 0; inp.r = c.r | 0; inp.n = c.n | 0;
  seq = Number(m.ack) | 0; baseAck = seq;
});
socket.on('rt:rejoinfail', (m) => {
  if (WATCH) return;
  if (seatHold) seatHold.done();
  if (overShown || !match) return;
  /* The match ended while the link was down (it was decided, or the five seconds ran out): its own result card, read
     with the id the seat had in it. */
  if (m && m.over && typeof m.you === 'string') { if (SND) SND.music(false); showOver(m.over, m.you); return; }
  dropMatch();
  if (waiting && resumeKey) { queue(null, resumeKey); return; }
  queue();
});

function dropMatch() {
  // A match dropped before its result is a walk-out (the server forfeits it); after the card it is nothing.
  trackStep('end', { result: 'left', reason: 'disconnected' });
  match = null; mySeat = -1; phase = null; haveBase = false; predicting = false;
  releaseAll();
  if (SND) SND.music(false);
  fit();
}

/* THE WAIT: a minute counted down; a free table then plays a bot, a paid one keeps looking for a person and
   Cancel gives the buy-in back at once. */
const WAIT_MS = window.DS_DUEL_WAIT_MS;
let waiting = false, waitPaid = false, waitEndsAt = 0, waitFrom = 0, waitTimer = 0, resumeKey = null, queuedOk = false, closed = false;
function waitClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function paintWait() {
  if (!waiting) return;
  const left = waitEndsAt - Date.now();
  const table = '$' + myStake.toFixed(2) + ' table. ';
  if (waitPaid) {
    // A paid table is one card from stake to match (Owen 2026-10-30): the clock counts up, nothing changes at 0:00.
    $('waitMain').textContent = 'Looking for a player… ' + waitClock(Math.floor((Date.now() - waitFrom) / 1000) * 1000);
    $('waitSub').textContent = table + 'Real players only, never a bot. Cancel any time for a full refund.';
  } else if (left > 0) {
    $('waitMain').textContent = 'Looking for a player… ' + waitClock(left);
    $('waitSub').textContent = 'Free table. If nobody joins, you\'ll play a bot.';
  } else {
    $('waitMain').textContent = 'Nobody joined. Playing a bot…';
    $('waitSub').textContent = 'Free table. Starting against a bot now.';
  }
}
function startWait(ms, total = WAIT_MS) {
  waiting = true;
  waitEndsAt = Date.now() + Math.max(0, ms);
  waitFrom = Date.now() + ms - total;
  clearInterval(waitTimer);
  waitTimer = setInterval(paintWait, 250);
  paintWait();
}
function stopWait() { waiting = false; clearInterval(waitTimer); }
socket.on('rt:queued', (q = {}) => {
  if (WATCH || match) return;
  queuedOk = true;
  if (typeof q.resumeKey === 'string') resumeKey = q.resumeKey;
  const total = Number(q.waitMs) > 0 ? Number(q.waitMs) : WAIT_MS;
  startWait(total - (Number(q.waitingMs) || 0), total);
  trackStep('queue');
});

function queue(token, resume) {
  overShown = false;
  lastOver = null;
  queuedOk = false;
  DSEnd.hide();
  chatShow(false);
  $('wait').hidden = false;
  waitSpin(true);
  waitPaid = myStake > 0;
  $('waitCancel').textContent = waitPaid ? 'Cancel and refund' : 'Back to the lobby';
  if (!resume) startWait(WAIT_MS);
  else paintWait();
  socket.emit('rt:queue', Object.assign({
    name: myName, wallet: myWallet,
    stake: myStake, entryToken: token || myEntryToken,
    resume: resume || undefined,
  }, shopFields(), lookField()));
  myEntryToken = null;      // one use only
  try { sessionStorage.removeItem('entryToken'); } catch (_) {}
}
function waitSpin(on) {
  const s = document.querySelector('.waitSpin');
  if (s) s.hidden = !on;
}

socket.on('rt:start', (raw) => {
  if (!raw) return;
  stopWait();
  resumeKey = null;
  if (seatHold) seatHold.done();     // this match's seat key follows in rt:seat
  if (WATCH) { if (watchMatch) startMatch(fromWatch(raw)); return; }
  if (raw.vsBot) botNote();
  me = socket.id;
  matchAt = Date.now();
  startMatch(raw);
  trackStep('start', { vs_bot: !!raw.vsBot, room: raw.id });
});
socket.on('rt:go', () => { if (match) goAt = performance.now(); });
socket.on('rt:ev', (list) => {
  if (!match || !Array.isArray(list)) return;
  for (const e of list) {
    if (!Array.isArray(e)) continue;
    if (e[0] === 'shot') addTracer({ s: e[1] | 0, f: [e[2], e[3]], h: [e[4], e[5]], hit: e[6], strong: e[7] }, false);
    else if ((e[0] === 'rocket' || e[0] === 'toss') && (WATCH || (e[1] | 0) !== mySeat)) arms[e[1] | 0].kick = performance.now();
    else if (e[0] === 'boom') boom(e[2], e[3]);
  }
});
socket.on('rt:fall', (m) => {
  if (!match || !m) return;
  fallAt = performance.now();
  // S: round_over -> Camera2D.set_target_player: follow the one who fell, zoom 0.85, faster.
  cam.target = m.s === 1 ? 1 : 0; cam.tz = 0.85; cam.speed = 10;
});
socket.on('rt:point', (m) => {
  if (!match || !m) return;
  pointAt = performance.now(); pointSide = m.s === 1 ? 1 : 0;
  if (Array.isArray(m.score)) score = [m.score[0] | 0, m.score[1] | 0];
});
socket.on('rt:round', () => { /* the snapshot carries the round; its look starts when the round is drawn */ });
socket.on('rt:end', (m) => { if (match && m) endAt = performance.now(); });
// Ten minutes of play without a winner (a paid table cannot run for ever): the score as it stands decides it.
socket.on('rt:timeup', (m) => { if (match && m) { timeUpAt = performance.now(); if (Array.isArray(m.score)) score = [m.score[0] | 0, m.score[1] | 0]; } });
let timeUpAt = -1e9;

socket.on('rt:over', (m) => {
  if (seatHold) seatHold.done();
  if (WATCH) { watchOver(m || {}); return; }
  showOver(m, me);
});
// who: the id this seat has in the result (this socket's, or the one it had before a reconnect: rt:rejoinfail).
function showOver(m, who) {
  if (overShown) return;
  overShown = true;
  setPhase('over');
  releaseAll();
  lastOver = Object.assign({}, m || {}, { ms: matchAt ? Date.now() - matchAt : 0, me: who, seat: mySeat, vsBot: !!(match && match.vsBot) });   // the card names the bot as a bot (site sweep 2026-10-28)
  if (m && m.winnerId) { if (m.winnerId === who) series.mine++; else series.theirs++; }
  restake = null; restakeLine = '';
  paintOver();
  chatShow(false);
  // The score is my rounds won.
  const sc = Array.isArray(lastOver.score) && lastOver.score.length === 2 ? lastOver.score : score;
  trackStep('end', { result: trackResult(lastOver.winnerId ? lastOver.winnerId === who : null, lastOver.why),
    score: sc[lastOver.seat === 1 ? 1 : 0] | 0, reason: lastOver.why });
}

/* ── the result card (public/js/shared/dsEnd.js). Every amount is the server's own figure from rt:over's money. */
const RESTAKE_WAIT_MS = 120000;
const TEXT = {
  againAsk: 'Confirm in your wallet...',
  againSlow: 'Waiting for your wallet...',
  againSlowLine: 'Your wallet has not answered yet. If you approved the stake, wait here: the round starts once it lands.',
  againFailed: 'Stake failed',
  lobbyOnly: 'Buy a new entry in the lobby to play again.',
};
function paintOver() {
  const m = lastOver;
  if (!m) return;
  const money = m.money && typeof m.money === 'object' ? m.money : null;
  const seat = money && money.seats ? money.seats[m.me] || null : null;
  const won = m.winnerId ? m.winnerId === m.me : null;
  const sc = Array.isArray(m.score) && m.score.length === 2 ? m.score : score;
  const mine = m.seat === 1 ? 1 : 0;
  const result = (sc[mine] | 0) + '-' + (sc[1 - mine] | 0);
  const time = m.ms > 0 ? DSEnd.clock(m.ms) : '';
  const card = {
    tone: 'plain',
    verdict: won === true ? 'You win' : won === false ? (m.winner || 'Opponent') + (m.vsBot && m.winner ? ' (bot)' : '') + ' wins' : 'Draw',
    notes: [],
  };
  if (money) {
    if (money.refunded) {
      card.hero = DSEnd.usd(seat ? seat.refundMicro : 0);
      card.unit = 'refunded';
    } else if (won === true) {
      card.tone = 'win';
      card.hero = DSEnd.usd(money.netMicro);
      card.unit = 'to your wallet';
      card.ledger = [['Pot', DSEnd.usd(money.potMicro)], ['House 10%', DSEnd.usd(-money.cutMicro)],
        ['You receive', DSEnd.usd(money.netMicro)]];
    } else {
      card.tone = 'loss';
      card.hero = DSEnd.usd(-(seat ? seat.stakeMicro : Math.round((Number(m.stake) || 0) * 1e6)));
      card.unit = 'lost';
    }
    card.facts = [['Score', result]];
    if (time) card.facts.push(['Time', time]);
  } else {
    card.hero = result;
    card.unit = 'score';
    card.facts = time ? [['Time', time]] : [];
  }
  if (m.why === 'opponent left') card.notes.push('They left the match.');
  else if (m.why === 'a draw') card.notes.push('Level when the ten minutes ran out.');
  else if (m.why === 'time up') card.notes.push('Ahead when the ten minutes ran out.');
  const paid = myStake > 0;
  const price = paid ? 'Play again ' + DSEnd.usd(Math.round(myStake * 1e6)) : 'Play again';
  const shut = !!restake && !restake.slow;
  let again;
  if (paid && !FRAMED) {
    again = { id: 'again', text: price, primary: true, disabled: true };
    card.notes.push(TEXT.lobbyOnly);
  } else if (restake) {
    again = { id: 'again', text: restake.slow ? TEXT.againSlow : TEXT.againAsk, primary: true, disabled: true };
    if (restake.slow) card.notes.push(TEXT.againSlowLine);
  } else {
    again = { id: 'again', text: price, primary: true, onClick: playAgain };
  }
  if (restakeLine) card.notes.push(restakeLine);
  card.buttons = [
    { id: 'lobby', text: 'Lobby', disabled: shut, onClick: toLobby },
    { id: 'spectate', text: 'Spectate', disabled: shut || !!restake, onClick: spectate },
    again,
  ];
  DSEnd.show(card);
}
function playAgain() {
  if (myStake > 0) { askRestake(); return; }
  requeue(null);
}
function requeue(token) {
  socket.emit('rt:leave');
  dropMatch();
  queue(token);
}
/* A PAID PLAY AGAIN BUYS A NEW ENTRY through the lobby's wallet (duel:restake, wallet-widget restakeBridge.mjs);
   the fresh token goes straight into rt:queue and is never stored. */
function newNonce() {
  try {
    const a = new Uint32Array(4);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, (n) => n.toString(36)).join('');
  } catch (_) {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}
function askRestake() {
  if (!FRAMED || restake || !(myStake > 0)) return;
  restake = { nonce: newNonce(), slow: false };
  restakeLine = '';
  clearTimeout(restakeTimer);
  restakeTimer = setTimeout(() => {
    if (!restake) return;
    restake.slow = true;
    paintOver();
  }, RESTAKE_WAIT_MS);
  paintOver();
  try {
    window.parent.postMessage({ type: 'duel:restake', game: GAME, stake: myStake, nonce: restake.nonce }, '*');
  } catch (_) {
    restakeDone(TEXT.againFailed);
  }
}
function restakeDone(line) {
  restake = null;
  clearTimeout(restakeTimer);
  restakeLine = line || '';
  paintOver();
}
window.addEventListener('message', (e) => {
  const d = e && e.data;
  if (!restake || !d || typeof d !== 'object') return;
  if (e.source !== window.parent) return;
  if (!e.origin || e.origin !== location.origin) return;
  if (typeof d.nonce !== 'string' || d.nonce !== restake.nonce) return;
  if (d.type === 'duel:restake:done' && typeof d.entryToken === 'string' && d.entryToken) {
    restake = null; restakeLine = '';
    clearTimeout(restakeTimer);
    requeue(d.entryToken);
  } else if (d.type === 'duel:restake:error') {
    restakeDone(String(d.message || TEXT.againFailed));
  }
});

function sentence(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.');
}

socket.on('rt:unqueued', ({ refunded, why } = {}) => {
  if (WATCH || match) return;
  if (!refunded) {
    if (why !== 'the match could not start') return;
    trackStep('unqueue', why);
    stopWait(); resumeKey = null;
    $('wait').hidden = false;
    waitSpin(false);
    $('waitMain').textContent = 'Could not start the match';
    $('waitSub').textContent = 'Go back to the lobby and press Play again.';
    $('waitCancel').textContent = 'Back to the lobby';
    return;
  }
  trackStep('unqueue', why || 'refunded');
  stopWait(); resumeKey = null; waitPaid = false;
  $('wait').hidden = false;
  waitSpin(false);
  $('waitMain').textContent = 'Buy-in refunded';
  $('waitSub').textContent = ({
    'nobody joined that table': 'Nobody joined that table, so your buy-in went back to your wallet.',
    'left the queue': 'Cancelled. Your full buy-in went back to your wallet.',
    'connection dropped': 'Your connection dropped while you waited, so your buy-in went back to your wallet.',
    'the match could not start': 'The match could not start, so your buy-in went back to your wallet.',
  })[why] || 'Your buy-in went back to your wallet.';
  $('waitCancel').textContent = 'Back to the lobby';
});

socket.on('rt:refused', ({ why } = {}) => {
  if (WATCH || match) return;
  const lost = waiting && waitPaid && resumeKey;
  trackStep('unqueue', 'refused');
  stopWait(); resumeKey = null; waitPaid = false;
  $('wait').hidden = false;
  waitSpin(false);
  $('waitMain').textContent = 'Not seated';
  $('waitSub').textContent = lost
    ? 'Your connection dropped while you waited. Your buy-in goes back to your wallet.'
    : (sentence(why) || 'The table did not let you in.');
  $('waitCancel').textContent = 'Back to the lobby';
});

socket.on('maintenance', (m) => {
  if (WATCH) return;
  if (m && m.maintenance) {
    if (match || (waiting && queuedOk)) return;
    closed = true;
    stopWait(); resumeKey = null;
    $('wait').hidden = false;
    waitSpin(false);
    $('waitMain').textContent = 'The game is closed right now';
    $('waitSub').textContent = (m && m.message) || 'Back shortly.';
    $('waitCancel').textContent = 'Back to the lobby';
  } else if (closed) {
    closed = false;
    if (!match && !overShown) queue();
  }
});

/* ── leaving ───────────────────────────────────────────────────────────── */
function toLobby() {
  if (restake && !restake.slow) return;
  clearTimeout(watchTimer);
  clearTimeout(swapTimer);
  if (BAR) BAR.close();
  socket.emit(WATCH ? 'rt:unwatch' : 'rt:leave');
  if (window.parent && window.parent !== window) window.parent.postMessage('game:done', '*');
  else location.href = '/';
}
$('waitCancel').addEventListener('click', () => {
  if (waiting && waitPaid && !match && !WATCH) {
    stopWait(); waitPaid = false; resumeKey = null;
    waitSpin(true);
    $('waitMain').textContent = 'Cancelling…';
    $('waitSub').textContent = 'Giving your buy-in back.';
    $('waitCancel').textContent = 'Back to the lobby';
    socket.emit('rt:unqueue');
    return;
  }
  toLobby();
});

/* SPECTATE from a result card: what the lobby's Spectate does for this rung, then this page again. */
const WATCH_URL = '/rooftop';
const MONEY_KEYS = ['entryToken', 'entrySol', 'stake', 'slPaidLaunch', 'slxPaidCut', 'slBr', 'spectateOnly'];
function reopen() {
  try {
    if (typeof location.replace === 'function') location.replace(WATCH_URL);
    else location.href = WATCH_URL;
  } catch (_) { location.href = WATCH_URL; }
}
function spectate() {
  if (restake) return;
  if (WATCH) { watch(watchLastId); return; }
  try {
    for (const k of MONEY_KEYS) sessionStorage.removeItem(k);
    sessionStorage.setItem('dsWatch', GAME);
    if (myStake > 0) sessionStorage.setItem('dsWatchStake', String(myStake));
    else sessionStorage.removeItem('dsWatchStake');
    if (sessionStorage.getItem('dsWatch') !== GAME) return;
  } catch (_) { return; }
  clearTimeout(watchTimer);
  socket.emit('rt:leave');
  reopen();
}
window.addEventListener('beforeunload', () => socket.emit(WATCH ? 'rt:unwatch' : 'rt:leave'));

/* ── watching ── the same moments a player gets, by seat, without the input acks. */
function fromWatch(s) {
  if (!s) return s;
  return Object.assign({}, s, { players: (s.players || []).map(p => Object.assign({}, p, { id: seatId(p.side) })) });
}
function watch(after, dir) {
  clearTimeout(watchTimer);
  const msg = after ? { after, stake: WATCH_STAKE } : { stake: WATCH_STAKE };
  if (after && dir === 'prev') msg.dir = 'prev';
  socket.emit('rt:watch', msg);
  publishWatch(watchMatch ? 'watching' : 'searching');
}
function stepWatch(dir) {
  clearTimeout(watchTimer);
  clearTimeout(swapTimer);
  swapping = true;
  if (BAR) BAR.busy(true);
  swapTimer = setTimeout(() => { swapping = false; if (BAR) BAR.busy(false); }, WATCH_SWAP_MS);
  watch(watchMatch ? watchMatch.id : watchLastId, dir);
}
function followOn(ms) {
  clearTimeout(watchTimer);
  if (ms > 0) watchTimer = setTimeout(() => watch(watchLastId), ms);
  else watch(watchLastId);
}
function nextSoon() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => watch(watchLastId), WATCH_NEXT_MS);
}
function vsLabel(names) {
  const room = 28, half = room / 2;
  const c = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
  const a = String((names && names[0]) || 'Player').trim() || 'Player';
  const b = String((names && names[1]) || 'Player').trim() || 'Player';
  const x = a.length <= half ? a : b.length <= half ? c(a, room - b.length) : c(a, half);
  const y = b.length <= half ? b : a.length <= half ? c(b, room - a.length) : c(b, half);
  return x + ' vs ' + y;
}
function publishWatch(mode) {
  try {
    window.__watch = {
      game: GAME, mode,
      matchId: watchMatch ? watchMatch.id : null,
      names: watchMatch ? watchMatch.names.slice() : [],
      index: watchMatch ? watchMatch.index : 0,
      count: watchMatch ? watchMatch.count : 0,
      stake: watchMatch ? watchMatch.stake : 0,
      state: phase,
    };
  } catch (_) {}
}
function watchLine(text) {
  const l = $('watchLine');
  l.textContent = text || '';
  l.hidden = !text;
}
socket.on('rt:watching', (m) => {
  if (!WATCH || !m) return;
  clearTimeout(watchTimer);
  clearTimeout(swapTimer);
  const swap = swapping;
  swapping = false;
  if (!m.match || !m.state) {
    watchMatch = null;
    dropMatch(); overShown = false; watchLine('');
    chatShow(false);
    if (BAR) BAR.empty();
    publishWatch(m.full ? 'full' : m.refused ? 'refused' : 'none');
    nextSoon();
    return;
  }
  if (swap && watchMatch && match && !overShown && m.match.id === watchMatch.id) {
    watchMatch = m.match;
    if (BAR) BAR.watching(vsLabel(watchMatch.names));
    publishWatch('watching');
    return;
  }
  watchMatch = m.match;
  watchLastId = m.match.id;
  overShown = false;
  watchLine('');
  startMatch(fromWatch(m.state));
  if (BAR) BAR.watching(vsLabel(watchMatch.names));
  publishWatch('watching');
});
socket.on('rt:matches', ({ index, count } = {}) => {
  if (!WATCH || !watchMatch) return;
  if (Number.isFinite(index)) watchMatch.index = index;
  if (Number.isFinite(count)) watchMatch.count = count;
  publishWatch('watching');
});
socket.on('rt:ended', ({ id } = {}) => {
  if (!WATCH || overShown) return;
  if (watchMatch && id && id !== watchMatch.id) return;
  overShown = true;
  publishWatch('ended');
  followOn(0);
});
function watchOver(m) {
  if (overShown) return;
  overShown = true;
  setPhase('over');
  const names = watchMatch ? watchMatch.names : [];
  const loser = m.winnerSide === 0 ? names[1] : m.winnerSide === 1 ? names[0] : null;
  const sc = Array.isArray(m.score) && m.score.length === 2 ? m.score : score;
  const said = [m.winner ? m.winner + ' wins ' + Math.max(sc[0], sc[1]) + '-' + Math.min(sc[0], sc[1]) : 'Draw'];
  if (m.why === 'opponent left') said.push((loser || 'A player') + ' left the match');
  watchLine(said.join('. ') + '.');
  publishWatch('over');
  followOn(WATCH_OVER_MS);
}

/* What the match looks like right now, for a headless check. Read only. */
window.__rt = () => ({
  phase, mySeat, score: score.slice(), predicting, rtt: Math.round(rtt), touchUI, portrait: VIEW.portrait,
  over: overShown, waiting, seq, ack: baseAck, view: { bw: VIEW.bw, bh: VIEW.bh, k: VIEW.k },
  round: cur ? cur.round : 0, label: cur ? Sim.modLabel(cur.mods) : '', cam: Object.assign({}, cam),
  me: mySeat >= 0 ? { x: rp[mySeat].x, y: rp[mySeat].y, a: rp[mySeat].a, raising: rp[mySeat].raising, arm: rp[mySeat].arm } : null,
  them: mySeat >= 0 ? { x: rp[1 - mySeat].x, y: rp[1 - mySeat].y, a: rp[1 - mySeat].a } : null,
  corr: off.map(o => Math.round(Math.hypot(o.x, o.y) * 10) / 10),
  server: haveBase ? { k: baseK, ph: base.phase } : null, tracers: tracers.length,
});

/* ── boot ──────────────────────────────────────────────────────────────── */
if (SND) SND.attach(socket, () => ({
  me, mySide: mySeat, watch: WATCH, xOf: (s) => rp[s] ? rp[s].x : 0,
  matchPoint: () => RT.PLAY_TO - score[0] <= 1 || RT.PLAY_TO - score[1] <= 1,
}));
fit();
requestAnimationFrame(frame);

if (WATCH) {
  document.body.classList.add('watching');
  $('wait').hidden = true;
  if (BAR) {
    BAR.open({ game: GAME, stake: WATCH_STAKE, onPrev: () => stepWatch('prev'), onNext: () => stepWatch('next'), onLobby: toLobby });
    BAR.watching('Finding a match');
    BAR.busy(true);
  }
  publishWatch('searching');
}
