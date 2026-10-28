'use strict';
/* ─── Air Hockey, the client ──────────────────────────────────────────────────
   One puck, two mallets, a goal at each end. This page draws the table
   (public/js/airhockey/ahArt.js paints it), reads your mouse or finger, and
   sends the server where you are pointing.

   THE SERVER DECIDES. Goals, the clock, the score and who wins all come from
   server/AirHockeyRoom.js. The physics this page runs (shared/ahSim.js, the very
   same file the server steps) is always run with its rules off: it moves the
   mallets and the puck and nothing else.

   BUT YOUR MALLET AND THE PUCK MOVE AT ONCE. The page keeps the newest snapshot,
   replays the physics forward from it to the present with your own pointer on
   top (rewind and replay), and draws that. The page runs a few steps AHEAD of
   the server, by the time your pointer takes to get there, and stamps every
   pointer sample with the step it was drawn on; the server holds an early sample
   until that step and applies it then, so the hit you see is the hit the server
   makes and your own shots are almost never corrected. What cannot be known yet
   (the other player's hand) is guessed as staying where it was heading, and
   when a snapshot disagrees the difference is eased out over a tenth of a second
   instead of jumping, unless it is a big one (a serve), which snaps.

   YOUR GOAL IS ALWAYS AT THE BOTTOM. Seat 0 defends the world's bottom goal; for
   seat 1 the whole table is drawn turned 180 degrees, and the pointer is turned
   back before it is sent. The world itself never turns.

   The shell around the match (the wait card, the bot note, the result card, the
   paid Play again, Spectate, chat, maintenance, the reconnect key) is Head
   Soccer's and Knockout's, behaviour for behaviour, with ah: event names. */

const socket = io();
const Sim = window.AHSim, AH = Sim.AH;
const $ = (id) => document.getElementById(id);
const cv = $('table');
const ctx = cv.getContext('2d', { alpha: false });
const GAME = 'airhockey';
/* The table's look: the judge panel's pick is the default (docs/airhockey-design.md); ?look= shows another one. */
const DEFAULT_LOOK = 'rink';
const LOOK = (() => {
  try { const q = new URLSearchParams(location.search).get('look'); return q && window.AHArt.LOOKS[q] ? q : DEFAULT_LOOK; }
  catch (_) { return DEFAULT_LOOK; }
})();
const art = window.AHArt.create(LOOK);
const SND = window.AirHockeySound || null;
const RM = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } })();

/* The name and wallet, read exactly the way Knockout reads them: the lobby
   writes the name into sessionStorage immediately before it sets this page's
   src, and the wallet lives under the key the wallet widget writes. A page
   opened without that hand-off falls back to the name the lobby keeps. */
const myName = (() => {
  try { return sessionStorage.getItem('playerName') || localStorage.getItem('duelseries_playername') || 'Player'; } catch (_) { return 'Player'; }
})();
const myWallet = (() => {
  try { return localStorage.getItem('duelseries_wallet') || null; } catch (_) { return null; }
})();

/* The buy-in, and the proof it was paid. Both are written by the wallet widget
   immediately before it opens this page. Neither is trusted here or on the
   wire: the server re-reads the token, takes the worth it recorded when it
   verified the transfer on-chain, and refuses the seat if the token does not
   cover the rung being asked for. This is only how the two get carried across. */
const myStake = (() => {
  try { return Number(sessionStorage.getItem('stake')) || 0; } catch (_) { return 0; }
})();
/* Spent by the first queue (one use only), so it is let and cleared there. A
   paid Play again never reads a stored token: it buys a fresh one through the
   lobby's wallet (askRestake below) and hands it straight to queue(). */
let myEntryToken = (() => {
  try { return sessionStorage.getItem('entryToken') || null; } catch (_) { return null; }
})();

/* A bought skin (docs/skin-purchases.md): only carried across; the server wears it when the pass is genuine and
   lists it, and tells both screens what it chose (players[].skin). Read at each queue, so a Play again sees a change. */
function shopFields() {
  try {
    const shop = localStorage.getItem('duel.shop.airhockey'), pass = localStorage.getItem('duel.skinpass');
    if (shop && pass && /^[a-z][a-z0-9]{0,23}$/.test(shop) && pass.length <= 4096) return { shop, skinPass: pass };
  } catch (_) { /* storage blocked: the free look */ }
  return {};
}

/* In the lobby's frame, where a paid Play again can ask the wallet for the
   next buy-in. Opened on its own, a paid card sends you to the lobby instead. */
const FRAMED = (() => { try { return !!window.parent && window.parent !== window; } catch (_) { return true; } })();

/* WATCHING, NOT PLAYING. The lobby's Spectate writes 'dsWatch' with the game to
   watch just before it opens this page. Read once and removed at once, so the
   next Play from the lobby is a Play; and honoured only when it names this
   game. In watch mode the page never queues and never sends a key: connecting
   asks for a match to watch instead of a seat, and the server sends it by seat
   rather than by socket id. */
const WATCH = (() => {
  try {
    const v = sessionStorage.getItem('dsWatch');
    if (v !== null) sessionStorage.removeItem('dsWatch');
    return v === GAME;
  } catch (_) { return false; }
})();
/* The buy-in the lobby's Spectate was on (dsWatchStake; none means Free): only
   tables at that stake are shown. Never read as a buy-in of our own. */
const WATCH_STAKE = (() => {
  try {
    const s = Number(sessionStorage.getItem('dsWatchStake'));
    sessionStorage.removeItem('dsWatchStake');
    return Number.isFinite(s) && s > 0 ? s : 0;
  } catch (_) { return 0; }
})();
const WATCH_NEXT_MS = 3000;   // between asks while no match is running
const WATCH_OVER_MS = 1800;   // how long a finished match's result stays up before the next one
const WATCH_SWAP_MS = 1500;   // how long the arrows rest for an answer that never comes
const seatId = (side) => 's' + side;
const BAR = window.DSWatchBar || null;
let watchMatch = null;        // the match card: { id, names, stake, pot, turn, index, count }
let watchLastId = null;       // the match we were last on, for "the one before / after it"
let watchTimer = 0;
let swapping = false;         // Previous / Next is asked and not answered yet
let swapTimer = 0;


/* ── the match on screen ─────────────────────────────────────────────────── */
let me = null;                // my socket id, as the server knows it
let match = null;             // { id, vsBot, players, names, stake, pot } while a match is on screen
let mySeat = -1;              // 0 defends the bottom goal, 1 the top; -1 while watching
let phase = null;             // the server's state: countdown | playing | goal | settling | over
let phaseAt = 0;
let score = [0, 0];
let overShown = false;
let lastOver = null;          // the result on the card, with how long the match ran (ms)
let matchAt = 0;
let restake = null;           // { nonce, slow } while a paid Play again is with the lobby's wallet
let restakeLine = '';
let restakeTimer = 0;
const series = { mine: 0, theirs: 0 };

let clockC = AH.MATCH_MS, clockAt = 0, clockShown = AH.MATCH_MS;  // the server's msLeft, when it came, what is shown
let sdC = -1;                 // in sudden death: its minute's ms left, else -1
let countAt = -1e9, lastCount = -1, playAt = -1e9;
let goalAt = -1e9, goalSide = -1, suddenAt = -1e9, endAt = -1e9;
let stallNote = null;         // { at, to } the 7 second rule just moved the puck
let stall = null;             // [half, ms] from the newest snapshot, while the warning shows
let serveTo = 0;
let scorePop = [-1e9, -1e9];  // when each seat's number last changed

/* ── the latest snapshot ──────────────────────────────────────────────────── */
const base = Sim.newMatch();
let haveBase = false, baseK = 0, baseAt = 0, baseFresh = false;
const wbuf = [];              // a watcher's last few snapshots: { k, pk, m0, m1 }

/* ── prediction ───────────────────────────────────────────────────────────── */
const sim = Sim.newMatch();
let predicting = false;
let clientTick = 0;
let frontier = 0;             // the newest step ever run: its events were already seen and heard
let forceSnap = false;
const off = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];   // eased corrections: seat 0, seat 1, puck
const was = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
const CORRECT_MS = 90;
const SNAP_U = [140, 260, 280];   // a correction bigger than this snaps: your mallet, theirs, the puck (world units)
const LEAD_TICKS = 2;             // how far past the trip there the page runs: room for a little jitter

/* My pointer, in world units, and every step's sample of it: { t, x, y }. */
const aim = { x: AH.W / 2, y: AH.H - 130 };
const hist = [];
let lastHistT = -1, sentT = -1;
const inputs = [null, null];
const oppIn = { x: 0, y: 0 };

/* What gets drawn: the predicted (or interpolated) bodies plus their eased corrections. */
const rm = [{ x: 0, y: 0, vx: 0, vy: 0 }, { x: 0, y: 0, vx: 0, vy: 0 }];
const rpk = { x: 0, y: 0, vx: 0, vy: 0, live: false };
let drawable = false;
const trail = [];             // the puck's last drawn positions: { x, y, v, at }
const fx = [];                // rings and sparks: see ahArt.drawFx
const flash = { puck: 0, m: [0, 0] };
let shakeAmp = 0, shakeX = 0, shakeY = 0;

/* ── latency ──────────────────────────────────────────────────────────────── */
/* One-way time to the server, from the server's own ping (index.js ping_check): the median of the last five round
   trips. Pinged twice a second until there are five, then every two seconds. Clamped to 0..150 ms one way. */
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

/* ── the transform ───────────────────────────────────────────────────────────
   One scale and one offset. A computer: the table as tall as the window allows, centred, the score column to its
   right. A phone (or any narrow window): the table as wide as the screen allows under a score strip, with room
   left under it for a thumb, because a finger steers from just below its mallet. */
const RAIL = art.RAIL;
const TW_U = AH.W + 2 * RAIL, TH_U = AH.H + 2 * RAIL;
let VIEW = { s: 1, ox: 0, oy: 0, dpr: 1, w: 0, h: 0, phone: false, flip: false };
let builtK = 0, resizeAt = 0;
let touchUI = (() => {
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
    return (navigator.maxTouchPoints || 0) > 0 && !(window.matchMedia && window.matchMedia('(pointer: fine)').matches);
  } catch (_) { return false; }
})();
const STRIP = 60;             // the phone's score strip, CSS px
const PAUSE = { x: 0, y: 0, r: 18 };

function fit() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  const phone = w < 720 || w / h < 0.95;
  let s, ox, oy;
  if (phone) {
    const thumb = touchUI ? Math.min(110, h * 0.13) : 12;
    s = Math.min((w - 12) / TW_U, (h - STRIP - thumb - 6) / TH_U);
    ox = (w - TW_U * s) / 2 + RAIL * s;
    oy = STRIP + RAIL * s + Math.max(0, (h - STRIP - thumb - 6 - TH_U * s) * 0.25);
    PAUSE.x = 26; PAUSE.y = STRIP / 2; PAUSE.r = 17;
  } else {
    s = Math.min((h - 36) / TH_U, (w - 420) / TW_U);
    ox = (w - TW_U * s) / 2 + RAIL * s;
    oy = (h - TH_U * s) / 2 + RAIL * s;
    PAUSE.x = ox - RAIL * s - 40; PAUSE.y = oy - RAIL * s + 22; PAUSE.r = 18;
    if (PAUSE.x < 26) { PAUSE.x = 26; PAUSE.y = 26; }
  }
  VIEW = { s, ox, oy, dpr, w, h, phone, flip: VIEW.flip };
  const k = s * dpr;
  if (!builtK || Math.abs(k - builtK) / builtK > 0.01) { if (!builtK) build(k); else resizeAt = performance.now(); }
  placeOverlays();
}
function build(k) { builtK = k; art.build(k); }
function refit() {
  if (cv.style.width !== window.innerWidth + 'px' || cv.style.height !== window.innerHeight + 'px') fit();
  if (resizeAt && performance.now() - resizeAt > 150) { resizeAt = 0; build(VIEW.s * VIEW.dpr); }
}
window.addEventListener('resize', fit);
window.addEventListener('orientationchange', fit);

/* World to CSS px and back, the table turned for the top seat. */
const sx = (x) => (VIEW.flip ? VIEW.ox + (AH.W - x) * VIEW.s : VIEW.ox + x * VIEW.s);
const sy = (y) => (VIEW.flip ? VIEW.oy + (AH.H - y) * VIEW.s : VIEW.oy + y * VIEW.s);
const wx = (px) => (VIEW.flip ? AH.W - (px - VIEW.ox) / VIEW.s : (px - VIEW.ox) / VIEW.s);
const wy = (py) => (VIEW.flip ? AH.H - (py - VIEW.oy) / VIEW.s : (py - VIEW.oy) / VIEW.s);

function placeOverlays() {
  const top = VIEW.phone ? STRIP + 10 : Math.round(VIEW.oy + 60);
  const note = $('botNote'); if (note) note.style.top = top + 'px';
  const line = $('watchLine'); if (line) line.style.top = top + 'px';
}

/* The pause button: an online match cannot stop, so it offers the way out. */
let pauseAsk = false;
function onPause(x, y) { return Math.hypot(x - PAUSE.x, y - PAUSE.y) <= PAUSE.r * 1.4; }
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
   A MOUSE steers directly: the mallet goes where the pointer is (the sim keeps it on your half and caps how fast
   a hand can move it), and the cursor is hidden over the table, because the mallet is the cursor.
   A FINGER steers from below: touch anywhere and the mallet keeps its place above your finger (at least LIFT px
   above it, so the finger never covers it) and follows the finger from there. */
const LIFT = 62;
const finger = { id: null, dx: 0, dy: 0 };
const canPlay = () => !WATCH && !!match && mySeat >= 0 && !overShown && phase !== 'over';
const LIVE_PHASES = { countdown: 1, playing: 1, goal: 1, settling: 1 };

function aimAt(px, py) {
  aim.x = wx(px); aim.y = wy(py);
}
window.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') { if (canPlay()) aimAt(e.clientX, e.clientY); return; }
  if (finger.id !== e.pointerId || !canPlay()) return;
  e.preventDefault();
  aimAt(e.clientX + finger.dx, e.clientY + finger.dy);
}, { passive: false });
cv.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch' && !touchUI) { touchUI = true; fit(); }
  if (match && !overShown && onPause(e.clientX, e.clientY)) { e.preventDefault(); pauseMenu(); return; }
  if (!canPlay()) return;
  if (e.pointerType === 'mouse') { aimAt(e.clientX, e.clientY); return; }
  e.preventDefault();
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  // Anchored from where the mallet is now: within reach of the finger, and always above it.
  const m = rm[mySeat] || { x: aim.x, y: aim.y };
  const mx = sx(m.x), my = sy(m.y);
  finger.id = e.pointerId;
  finger.dx = Math.max(-70, Math.min(70, mx - e.clientX));
  finger.dy = Math.max(-LIFT - 110, Math.min(-LIFT, my - e.clientY));
  aimAt(e.clientX + finger.dx, e.clientY + finger.dy);
});
const lift = (e) => { if (finger.id === e.pointerId) finger.id = null; };
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
cv.addEventListener('lostpointercapture', lift);
cv.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && canPlay()) pauseMenu();
});
function releaseAll() { finger.id = null; }
window.addEventListener('blur', releaseAll);

/* The newest few samples, every frame a new step was drawn: each message repeats the last four, so a dropped one
   costs nothing. Volatile (the mobile netcode rule): a late sample is worth less than the next one. At most one a
   step, 60 a second; the server drops a flood past 40 in half a second. */
function sendInput() {
  if (!canPlay() || phase === 'settling' || lastHistT <= sentT || !hist.length) return;
  sentT = lastHistT;
  const n = Math.min(4, hist.length), p = [];
  for (let i = hist.length - n; i < hist.length; i++) p.push(hist[i].x, hist[i].y);
  socket.volatile.emit('ah:in', { t: lastHistT, p });
}

/* ── snapshots ─────────────────────────────────────────────────────────────── */
function onSnap(s) {
  if (!match || !s || !Array.isArray(s.pk) || !Array.isArray(s.m) || s.m.length < 2) return;
  const k = Number(s.k) || 0;
  if (haveBase && k < baseK) return;
  const t = performance.now();
  base.tick = k;
  base.puck = Sim.unpackPuck(s.pk);
  base.m[0] = Sim.unpackMallet(s.m[0], 0);
  base.m[1] = Sim.unpackMallet(s.m[1], 1);
  if (Array.isArray(s.sc) && s.sc.length === 2) setScore([s.sc[0] | 0, s.sc[1] | 0]);
  if (typeof s.c === 'number' && s.c >= 0) { clockC = s.c; clockAt = t; }
  sdC = typeof s.sd === 'number' && s.sd >= 0 ? s.sd : -1;
  stall = Array.isArray(s.sl) ? s.sl : null;
  if (typeof s.st === 'string') setPhase(s.st, t);
  baseK = k; baseAt = t; baseFresh = true; haveBase = true;
  if (WATCH) { wbuf.push({ k, pk: base.puck, m0: base.m[0], m1: base.m[1] }); if (wbuf.length > 12) wbuf.shift(); }
}
socket.on('ah:snap', onSnap);

function setScore(sc) {
  const t = performance.now();
  for (let i = 0; i < 2; i++) if (sc[i] !== score[i]) scorePop[i] = t;
  score = sc;
}

function setPhase(p, t) {
  if (p === phase) return;
  phase = p;
  phaseAt = t || performance.now();
  if (p === 'countdown') { countAt = phaseAt; lastCount = -1; forceSnap = true; }
  if (!LIVE_PHASES[p]) predicting = false;
}

/* ── the replay ──────────────────────────────────────────────────────────────
   The present is the newest snapshot's step plus the time since it came plus the trip there and back, plus a
   couple of steps for jitter: a sample taken now reaches the server just before the step it is stamped with. */
function wantTick(now) { return baseK + (now - baseAt + 2 * oneWay()) * 0.06 + LEAD_TICKS; }

// My sample for step t: the one stamped t, or the newest before it (null keeps the mallet's last target).
function myInputFor(t) {
  for (let i = hist.length - 1; i >= 0; i--) if (hist[i].t <= t) return hist[i];
  return null;
}
const r1 = (v) => Math.round(v * 10) / 10;

function stepSim() {
  const t = sim.tick + 1;
  if (t > lastHistT && canPlay()) {
    // A new step: the pointer as it is now becomes this step's sample (rounded as it is sent, so both sides agree).
    const c = Sim.clampMallet(mySeat, aim.x, aim.y);
    hist.push({ t, x: r1(c[0]), y: r1(c[1]) });
    lastHistT = t;
    if (hist.length > 240) hist.shift();
  }
  inputs[mySeat] = myInputFor(t);
  const o = base.m[1 - mySeat];
  oppIn.x = o.tx; oppIn.y = o.ty;               // the other hand: still heading where it last was
  inputs[1 - mySeat] = oppIn;
  const ev = Sim.step(sim, inputs, false);
  if (t > frontier) {
    frontier = t;
    for (let i = 0; i < ev.length; i++) effect(ev[i], true);
  }
}
function advance(target, cap) {
  let n = 0;
  while (sim.tick < target && n < cap) { stepSim(); n++; }
}
function loadBase() {
  for (let i = 0; i < 2; i++) Object.assign(sim.m[i], base.m[i]);
  Object.assign(sim.puck, base.puck);
  sim.tick = base.tick;
}
function bodyOf(i) { return i < 2 ? sim.m[i] : sim.puck; }

function predict(now, dt) {
  const want = wantTick(now);
  if (!predicting) {
    predicting = true;
    clientTick = want;
    loadBase();
    baseFresh = false;
    frontier = Math.max(frontier, sim.tick);
    advance(Math.floor(clientTick), 30);
    for (const o of off) { o.x = 0; o.y = 0; }
  } else {
    clientTick += dt * 0.06;
    const err = want - clientTick;
    if (Math.abs(err) > 8) clientTick = want;
    else clientTick += err * Math.min(1, dt / 400);
  }
  const target = Math.floor(clientTick);
  advance(target, 6);
  if (baseFresh) {
    baseFresh = false;
    for (let i = 0; i < 3; i++) { const b = bodyOf(i); was[i].x = b.x + off[i].x; was[i].y = b.y + off[i].y; }
    const puckWas = sim.puck.live;
    loadBase();
    advance(target, 30);
    for (let i = 0; i < 3; i++) {
      const b = bodyOf(i), o = off[i];
      o.x = was[i].x - b.x; o.y = was[i].y - b.y;
      const lim = i === 2 ? SNAP_U[2] : i === mySeat ? SNAP_U[0] : SNAP_U[1];
      if (forceSnap || Math.hypot(o.x, o.y) > lim || (i === 2 && puckWas !== sim.puck.live)) { o.x = 0; o.y = 0; }
    }
    forceSnap = false;
  }
  const decay = Math.exp(-dt / CORRECT_MS);
  for (const o of off) { o.x *= decay; o.y *= decay; if (Math.abs(o.x) < 0.05) o.x = 0; if (Math.abs(o.y) < 0.05) o.y = 0; }
  const frac = Math.max(0, Math.min(1, clientTick - sim.tick));
  for (let i = 0; i < 2; i++) toRender(rm[i], sim.m[i], frac, off[i]);
  puckRender(sim.puck, frac, off[2]);
}

function toRender(r, m, frac, o) {
  const dt = frac * AH.STEP;
  r.x = m.x + m.vx * dt + (o ? o.x : 0);
  r.y = m.y + m.vy * dt + (o ? o.y : 0);
  r.vx = m.vx; r.vy = m.vy;
}
function puckRender(p, frac, o) {
  const dt = p.live ? frac * AH.STEP : 0;
  rpk.x = p.x + p.vx * dt + (o ? o.x : 0);
  rpk.y = p.y + p.vy * dt + (o ? o.y : 0);
  rpk.vx = p.vx; rpk.vy = p.vy; rpk.live = p.live;
}

/* A watcher has no seat to predict, so it draws the match about 100 ms behind the newest snapshot, between the two
   snapshots either side of that moment. A serve (the puck jumping) is not slid across. */
let wTick = 0;
const lerp = (a, b, u) => a + (b - a) * u;
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
  const jump = (p, q) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y) > 200;
  const mm = (r, p, q) => {
    if (jump(p, q)) { toRender(r, u < 0.5 ? p : q, 0, null); return; }
    r.x = lerp(p.x, q.x, u); r.y = lerp(p.y, q.y, u); r.vx = q.vx; r.vy = q.vy;
  };
  mm(rm[0], a.m0, b.m0); mm(rm[1], a.m1, b.m1);
  if (jump(a.pk, b.pk) || a.pk.live !== b.pk.live) puckRender(u < 0.5 ? a.pk : b.pk, 0, null);
  else { rpk.x = lerp(a.pk.x, b.pk.x, u); rpk.y = lerp(a.pk.y, b.pk.y, u); rpk.vx = b.pk.vx; rpk.vy = b.pk.vy; rpk.live = b.pk.live; }
}

/* ── what a hit looks and sounds like ─────────────────────────────────────── */
const roleOf = (seat) => (WATCH ? (seat === 0 ? 'me' : 'them') : seat === mySeat ? 'me' : 'them');
function shake(a) { shakeAmp = Math.max(shakeAmp, a * (RM ? 0.4 : 1)); }
let theirHitAt = -1e9;        // the screen's own guess of the other player's last hit
function effect(e, local) {
  const now = performance.now();
  if (e.e === 'hit') {
    if (local && e.s !== mySeat) theirHitAt = now;
    const v = e.v || 0, col = art.colorOf(roleOf(e.s));
    fx.push({ kind: 'ring', x: e.x, y: e.y, at: now, life: 260, size: 30 + Math.min(70, v / 35), col });
    const n = v > 1400 ? 6 : v > 600 ? 4 : 0;
    const base0 = Math.atan2(e.y - (sim.m[e.s] ? sim.m[e.s].y : e.y), e.x - (sim.m[e.s] ? sim.m[e.s].x : e.x));
    for (let i = 0; i < n; i++) fx.push({ kind: 'spark', x: e.x, y: e.y, at: now, life: 220, size: 40, a: base0 + (i - (n - 1) / 2) * 0.42, col: null });
    flash.puck = Math.max(flash.puck, Math.min(1, v / 1600));
    flash.m[e.s] = Math.max(flash.m[e.s], Math.min(1, v / 2000));
    shake(Math.min(7, v / 380));
  } else if (e.e === 'rail' || e.e === 'post') {
    if (e.v > 500) fx.push({ kind: 'ring', x: e.x, y: e.y, at: now, life: 200, size: 18 + Math.min(30, e.v / 60), col: null });
    if (e.e === 'post') flash.puck = Math.max(flash.puck, 0.5);
    shake(Math.min(3, e.v / 800));
  }
  if (local && SND && SND.local) SND.local(e.e, e.s, e.v, e.x);
  if (fx.length > 40) fx.splice(0, fx.length - 40);
}

/* ── the loop ─────────────────────────────────────────────────────────────── */
let lastFrame = performance.now();
function frame() {
  const now = performance.now();
  const dt = Math.min(100, Math.max(0, now - lastFrame));
  lastFrame = now;
  refit();
  update(now, dt);
  draw(now, dt);
  requestAnimationFrame(frame);
}

function update(now, dt) {
  drawable = false;
  if (!match || !haveBase) return;
  if (WATCH) interpolate(now, dt);
  else if (mySeat >= 0 && LIVE_PHASES[phase]) predict(now, dt);
  else {
    for (let i = 0; i < 2; i++) toRender(rm[i], base.m[i], 0, null);
    puckRender(base.puck, 0, null);
  }
  drawable = true;
  sendInput();
  // The clock, run down smoothly between snapshots while play is live.
  let ms = sdC >= 0 ? sdC : clockC;
  if (phase === 'playing') ms -= now - clockAt;
  ms = Math.max(0, ms);
  if (ms < clockShown || ms > clockShown + 600) clockShown = ms;
  const n = countNumber(now);
  if (n !== lastCount) { lastCount = n; if (n >= 1 && SND && SND.count) SND.count(n); }
  // The trail: where the puck was drawn, the last tenth of a second or so.
  const sp = Math.hypot(rpk.vx, rpk.vy);
  if (rpk.live && phase !== 'countdown') trail.push({ x: rpk.x, y: rpk.y, v: sp, at: now });
  while (trail.length && (now - trail[0].at > 110 || trail.length > 14)) trail.shift();
  // Flashes and the shake fade.
  const f = Math.exp(-dt / 80);
  flash.puck *= f; flash.m[0] *= f; flash.m[1] *= f;
  shakeAmp *= Math.exp(-dt / 70);
  if (shakeAmp < 0.2) shakeAmp = 0;
  shakeX = (Math.random() * 2 - 1) * shakeAmp; shakeY = (Math.random() * 2 - 1) * shakeAmp;
  while (fx.length && now - fx[0].at > 700) fx.shift();
}

// 3, 2, 1 through the countdown, then "Go" for half a second. 0 is Go, -1 is nothing.
function countNumber(now) {
  if (phase === 'countdown') {
    const k = Math.floor((now - countAt) / 1000);
    return k >= 0 && k <= 2 ? 3 - k : -1;
  }
  if (phase === 'playing' && now - playAt < 550) return 0;
  return -1;
}

/* ── drawing ──────────────────────────────────────────────────────────────── */
const FONT = 'Archivo, ui-sans-serif, system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
function draw(now) {
  const V = VIEW, d = V.dpr, L = art.look;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.fillStyle = L.bg;
  ctx.fillRect(0, 0, V.w, V.h);
  VIEW.flip = !WATCH && mySeat === 1;
  // The world, turned for the top seat, shaken a little by a hard hit.
  const s = V.s * d;
  if (V.flip) ctx.setTransform(-s, 0, 0, -s, d * (V.ox + AH.W * V.s + shakeX), d * (V.oy + AH.H * V.s + shakeY));
  else ctx.setTransform(s, 0, 0, s, d * (V.ox + shakeX), d * (V.oy + shakeY));
  art.drawTable(ctx);
  if (match && drawable) {
    const goalPause = phase === 'goal' && now - goalAt > 260;
    art.drawGoals(ctx, roleOf(1), roleOf(0), now - goalAt, goalSide >= 0 ? roleOf(goalSide) : null);
    art.drawFx(ctx, fx, now);
    // The puck, clipped to the table so it drops out of sight into a pocket.
    if (!goalPause && phase !== 'over') {
      ctx.save();
      ctx.beginPath(); ctx.rect(-RAIL, -RAIL, AH.W + 2 * RAIL, AH.H + 2 * RAIL); ctx.clip();
      if (phase !== 'countdown') art.drawTrail(ctx, trail);
      art.drawPuck(ctx, rpk.x, rpk.y, flash.puck, Math.hypot(rpk.vx, rpk.vy), V.flip);
      if (phase === 'countdown') {
        // Whose serve: a ring that breathes round the puck in the server's colour.
        const u = 0.5 + 0.5 * Math.sin(now / 160);
        ctx.globalAlpha = 0.35 + 0.4 * u; ctx.strokeStyle = art.colorOf(roleOf(serveTo)); ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(rpk.x, rpk.y, AH.PUCK_R + 8 + 4 * u, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      }
      if (stall && phase === 'playing') {
        const frac = Math.max(0, Math.min(1, (stall[1] + (now - baseAt) - AH.STALL_WARN_MS) / (AH.STALL_MS - AH.STALL_WARN_MS)));
        art.drawStall(ctx, rpk.x, rpk.y, frac, '#ff5a4f');
      }
      ctx.restore();
    }
    for (let i = 0; i < 2; i++) art.drawMallet(ctx, rm[i].x, rm[i].y, roleOf(i), flash.m[i], V.flip);
  }
  ctx.setTransform(d, 0, 0, d, 0, 0);
  if (match) { drawHud(now); drawBanners(now); }
  drawPause();
}

function drawPause() {
  if (!match || overShown) return;
  const L = art.look;
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath(); ctx.arc(PAUSE.x, PAUSE.y, PAUSE.r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = L === art.LOOKS.arcade ? '#dfe9f3' : '#f5f1e8';
  const b = PAUSE.r * 0.36;
  ctx.fillRect(PAUSE.x - b * 0.9, PAUSE.y - b, b * 0.6, b * 2);
  ctx.fillRect(PAUSE.x + b * 0.3, PAUSE.y - b, b * 0.6, b * 2);
  ctx.restore();
}

function nameOf(seat) { return (match && match.names[seat]) || 'Player'; }
function drawHud(now) {
  const V = VIEW;
  const top = V.flip ? 0 : 1, bot = 1 - top;     // the seat whose goal is at the top of this screen, and at the bottom
  const clock = Sim.clockText(clockShown);
  const pop = (seat) => { const u = (now - scorePop[seat]) / 380; return u >= 0 && u < 1 ? 1 + 0.35 * Math.sin(u * Math.PI) : 1; };
  ctx.save();
  ctx.textBaseline = 'middle';
  if (V.phone) {
    // The strip: the top seat's score on the left, the clock in the middle, the bottom seat's on the right.
    const cy = STRIP / 2;
    ctx.textAlign = 'center';
    ctx.font = '600 ' + 22 + 'px ' + MONO;
    ctx.fillStyle = sdC >= 0 ? '#ff5a4f' : '#f5f1e8';
    ctx.fillText(clock, V.w / 2, cy - 4);
    ctx.font = '600 11px ' + FONT; ctx.fillStyle = 'rgba(214,222,232,0.85)';
    ctx.fillText(sdC >= 0 ? 'Next goal wins' : 'First to ' + AH.TO_WIN, V.w / 2, cy + 15);
    const side = (seat, x, align) => {
      ctx.textAlign = align;
      ctx.save();
      ctx.translate(x, cy); const k = pop(seat); ctx.scale(k, k);
      ctx.font = '900 34px ' + FONT; ctx.fillStyle = art.colorOf(roleOf(seat));
      ctx.fillText(String(score[seat]), 0, 0);
      ctx.restore();
      ctx.font = '600 13px ' + FONT; ctx.fillStyle = 'rgba(232,238,245,0.92)';
      const nx = align === 'left' ? x + 30 : x - 30;
      ctx.fillText(cutTo(seat === mySeat ? 'You' : nameOf(seat), 11), nx, cy);
    };
    side(top, 52, 'left');
    side(bot, V.w - 14, 'right');
  } else {
    // The column right of the table: their score by their goal at the top, yours by yours at the bottom.
    const x = V.ox + AH.W * V.s + RAIL * V.s + 44;
    const yTop = V.oy + 70, yBot = V.oy + AH.H * V.s - 70, yMid = V.oy + AH.H * V.s / 2;
    ctx.textAlign = 'left';
    const block = (seat, y, nameAbove) => {
      ctx.font = '600 15px ' + FONT; ctx.fillStyle = 'rgba(245,241,232,0.72)';
      ctx.fillText(cutTo(seat === mySeat ? 'You' : nameOf(seat), 18), x, nameAbove ? y - 52 : y + 52);
      ctx.save(); ctx.translate(x, y); const k = pop(seat); ctx.scale(k, k);
      ctx.font = '900 84px ' + FONT; ctx.fillStyle = art.colorOf(roleOf(seat));
      ctx.fillText(String(score[seat]), 0, 0);
      ctx.restore();
    };
    block(top, yTop + 30, true);
    block(bot, yBot - 30, false);
    ctx.font = '600 34px ' + MONO; ctx.fillStyle = sdC >= 0 ? '#ff5a4f' : '#f5f1e8';
    ctx.fillText(clock, x, yMid - 10);
    ctx.font = '600 13px ' + FONT; ctx.fillStyle = 'rgba(214,222,232,0.75)';
    ctx.fillText(sdC >= 0 ? 'Sudden death: next goal wins' : 'First to ' + AH.TO_WIN, x, yMid + 22);
    if (match.stake > 0) {
      ctx.fillStyle = 'rgba(240,168,48,0.85)';
      ctx.fillText('$' + (Number(match.pot) || 0).toFixed(2) + ' pot', x, yMid + 44);
    }
  }
  ctx.restore();
}
const cutTo = (s, n) => { const t = String(s || 'Player'); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/* The big words over the table: 3 2 1 Go, GOAL, sudden death, the 7 second rule, the final buzzer. */
function drawBanners(now) {
  const V = VIEW;
  const cx = V.ox + AH.W * V.s / 2, cy = V.oy + AH.H * V.s / 2;
  const unit = Math.max(0.6, Math.min(1.25, V.s * 1.4));
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const word = (text, size, col, alpha, scale, dy) => {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.translate(cx, cy + (dy || 0)); ctx.scale(scale, scale);
    ctx.font = 'italic 900 ' + Math.round(size * unit) + 'px ' + FONT;
    ctx.lineWidth = Math.max(3, size * unit * 0.09); ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineJoin = 'round';
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = col; ctx.fillText(text, 0, 0);
    ctx.restore();
  };
  const n = countNumber(now);
  if (n > 0) {
    const u = ((now - countAt) % 1000) / 1000;
    word(String(n), 120, '#f5f1e8', 1 - u * 0.6, 1.25 - 0.25 * Math.min(1, u * 4));
    if (serveTo === mySeat && !WATCH) word('Your serve', 26, art.colorOf('me'), 0.9, 1, 90 * unit);
  } else if (n === 0) {
    const u = (now - playAt) / 550;
    word('Go', 110, art.colorOf('me'), 1 - u, 1 + 0.3 * u);
  }
  const g = (now - goalAt) / 1500;
  if (g >= 0 && g < 1 && goalSide >= 0) {
    const inU = Math.min(1, g * 6);
    const sc = 1.6 - 0.6 * (1 - Math.pow(1 - inU, 3));
    const mine = !WATCH && goalSide === mySeat;
    word('GOAL', 120, art.colorOf(roleOf(goalSide)), g < 0.75 ? 1 : (1 - g) * 4, sc);
    word(WATCH ? nameOf(goalSide) + ' scores' : mine ? 'You score' : nameOf(goalSide) + ' scores', 24, '#f5f1e8',
      g < 0.75 ? Math.min(1, g * 5) : (1 - g) * 4, 1, 82 * unit);
  }
  const sd = (now - suddenAt) / 2200;
  if (sd >= 0 && sd < 1) {
    word('Sudden death', 58, '#ff5a4f', sd < 0.8 ? 1 : (1 - sd) * 5, 1);
    word('Next goal wins', 22, '#f5f1e8', sd < 0.8 ? 1 : (1 - sd) * 5, 1, 56 * unit);
  }
  if (stallNote) {
    const u = (now - stallNote.at) / 1800;
    if (u >= 1) stallNote = null;
    else word(stallNote.to === mySeat && !WATCH ? 'Held too long: your puck' : 'Held too long: their puck', 26, '#ff5a4f',
      u < 0.8 ? 1 : (1 - u) * 5, 1, -120 * unit);
  }
  const e = now - endAt;
  if (e >= 0 && phase === 'settling') {
    const [a, b] = score;
    const won = a === b ? null : (a > b ? 0 : 1);
    const text = won === null ? 'Draw' : WATCH ? nameOf(won) + ' wins' : won === mySeat ? 'You win' : nameOf(won) + ' wins';
    word(text, 70, won === null ? '#f5f1e8' : art.colorOf(roleOf(won)), Math.min(1, e / 200), 1.2 - 0.2 * Math.min(1, e / 250));
  }
  ctx.restore();
}

/* ── chat ──────────────────────────────────────────────────────────────────
   The one DuelSeries chat box (public/js/shared/dsChat.js): T to type, Enter to send. Only the two seated players
   can speak; a watcher reads. On a computer it sits bottom left, beside the table; on a phone, its
   button top left under the score strip. A line takes its mallet's colour. */
let chatLive = false;          // a match is on screen (not the wait card, not the result card)
const chat = DSChat.mount({
  send: (t) => { socket.emit('ah:chat', { text: t }); return true; },
  canSend: () => chatLive && !WATCH,
  pc: { left: 14, bottom: 20 },
  phoneAt: { left: 10, top: 70 },
});
function chatShow(on) { chatLive = on; chat.visible(on); }
socket.on('ah:chat', (m) => {
  if (!m) return;
  const mine = !WATCH && m.side === mySeat;
  chat.add({ name: m.name, color: art.colorOf(roleOf(m.side === 1 ? 1 : 0)), text: m.text, me: mine });
});
socket.on('ah:chatnote', (m) => { if (m) chat.add({ kind: 'sys', text: m.text }); });

/* "Playing a bot", said as the match starts and kept on the name in the strip (Owen 2026-10-21: the player has to
   know it is a bot). */
let botNoteTimer = 0;
function botNote() {
  const n = $('botNote');
  if (!n) return;
  n.hidden = false;
  clearTimeout(botNoteTimer);
  botNoteTimer = setTimeout(() => { n.hidden = true; }, 5000);
}


/* ── what the server says ──────────────────────────────────────────────── */

/* A match comes on screen: from ah:start, or a watcher's ah:watching. Everything about the last one is dropped. */
function startMatch(m) {
  const players = m.players || [];
  mySeat = -1;
  if (!WATCH) { const p = players.find(q => q.id === me); mySeat = p ? (p.side === 1 ? 1 : 0) : -1; }
  const names = ['', ''];
  for (const p of players) if (p.side === 0 || p.side === 1) names[p.side] = cut(p.name, 16);
  if (m.vsBot && mySeat >= 0) names[1 - mySeat] = cut(names[1 - mySeat] || 'Opponent', 12) + ' (bot)';
  match = { id: m.id, vsBot: !!m.vsBot, players, names, stake: m.stake, pot: m.pot };
  score = Array.isArray(m.score) && m.score.length === 2 ? [m.score[0] | 0, m.score[1] | 0] : [0, 0];
  scorePop = [-1e9, -1e9];
  clockC = typeof m.msLeft === 'number' ? m.msLeft : AH.MATCH_MS; clockAt = performance.now(); clockShown = clockC;
  sdC = m.sudden ? AH.SUDDEN_MS : -1;
  serveTo = m.serveTo === 1 ? 1 : 0;
  overShown = false; lastOver = null;
  phase = null; setPhase(m.state || 'countdown');
  countAt = performance.now() - Math.max(0, AH.COUNTDOWN_MS - (Number(m.phaseMs) || AH.COUNTDOWN_MS)); lastCount = -1;
  goalAt = -1e9; goalSide = -1; suddenAt = -1e9; endAt = -1e9; playAt = -1e9; stallNote = null; stall = null;
  // The pointer starts on my own mallet's spot; a new room counts its steps from zero.
  const home = Sim.newMallet(mySeat === 1 ? 1 : 0);
  aim.x = home.x; aim.y = home.y;
  hist.length = 0; lastHistT = -1; sentT = -1;
  finger.id = null;
  predicting = false; frontier = 0; forceSnap = true;
  for (const o of off) { o.x = 0; o.y = 0; }
  trail.length = 0; fx.length = 0; flash.puck = 0; flash.m[0] = 0; flash.m[1] = 0; shakeAmp = 0;
  haveBase = false; baseFresh = false; wbuf.length = 0; baseK = 0;
  VIEW.flip = !WATCH && mySeat === 1;
  cv.classList.toggle('playing', !WATCH && mySeat >= 0);
  if (m.snap) onSnap(m.snap);
  $('wait').hidden = true;
  chatShow(true);
}

const cut = (s, n) => { const t = String(s || 'Player'); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/* Every connect, the first and every reconnect after it: a seat, or in watch mode a match to watch. The server
   forgets a watcher whose socket dropped, so a reconnect asks again rather than assuming it is still on the list. */
socket.on('connect', () => {
  rtts.length = 0;
  ping();
  if (WATCH) { me = null; swapping = false; watch(null); return; }
  me = socket.id;
  /* The result card is up: it stays, and Play again queues from it. */
  if (overShown) return;
  /* A match this socket was in is gone with the old socket (walking out forfeits it on the server). */
  if (match) dropMatch();
  /* A reconnect while waiting takes the same seat back (the key the server sent with ah:queued): the same place,
     the same minute, and for a paid seat the same buy-in, with no new token. */
  if (waiting && resumeKey) { queue(null, resumeKey); return; }
  queue();
});

function dropMatch() {
  match = null; mySeat = -1; phase = null; haveBase = false; predicting = false;
  releaseAll();
}

/* THE WAIT (Owen 2026-10-21). A minute, counted down on screen, and the screen says what happens at 0:00 before
   it happens: a free table plays a bot, a paid one keeps looking for a person (a bot cannot cover a stake) and
   Cancel gives the buy-in back at once. The server sends the real numbers in ah:queued; the minute starts here so
   the clock is up before the answer. */
const WAIT_MS = window.DS_DUEL_WAIT_MS;   // shared/duelWait.js, the server's number too
let waiting = false, waitPaid = false, waitEndsAt = 0, waitTimer = 0, resumeKey = null, queuedOk = false, closed = false;
function waitClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function paintWait() {
  if (!waiting) return;
  const left = waitEndsAt - Date.now();
  const table = '$' + myStake.toFixed(2) + ' table. ';
  if (left > 0) {
    $('waitMain').textContent = 'Looking for a player… ' + waitClock(left);
    $('waitSub').textContent = waitPaid
      ? table + 'Real players only, never a bot. Cancel any time for a full refund.'
      : 'Free table. If nobody joins, you\'ll play a bot.';
  } else if (waitPaid) {
    $('waitMain').textContent = 'Still looking for a player';
    $('waitSub').textContent = table + 'Nobody yet. Cancel any time for a full refund.';
  } else {
    $('waitMain').textContent = 'Nobody joined. Playing a bot…';
    $('waitSub').textContent = 'Free table. Starting against a bot now.';
  }
}
function startWait(ms) {
  waiting = true;
  waitEndsAt = Date.now() + Math.max(0, ms);
  clearInterval(waitTimer);
  waitTimer = setInterval(paintWait, 250);
  paintWait();
}
function stopWait() {
  waiting = false;
  clearInterval(waitTimer);
}
socket.on('ah:queued', (q = {}) => {
  if (WATCH || match) return;              // matched already: the wait card is not coming back
  queuedOk = true;
  if (typeof q.resumeKey === 'string') resumeKey = q.resumeKey;
  const total = Number(q.waitMs) > 0 ? Number(q.waitMs) : WAIT_MS;
  startWait(total - (Number(q.waitingMs) || 0));
});

/* `token`: a paid Play again's fresh entry, from the lobby's wallet. Without one, the buy-in this page was opened
   with, the first time only. `resume`: a reconnect's key, asking for the seat it already had. */
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
  socket.emit('ah:queue', Object.assign({
    name: myName, wallet: myWallet,
    stake: myStake, entryToken: token || myEntryToken,
    resume: resume || undefined,
  }, shopFields()));
  /* One use only. Re-sending it on a Play again would be asking the server to spend a token it has already
     burned, and the seat would be refused with nothing to show for it. */
  myEntryToken = null;
  try { sessionStorage.removeItem('entryToken'); } catch (_) {}
}

function waitSpin(on) {
  const s = document.querySelector('.waitSpin');
  if (s) s.hidden = !on;
}

socket.on('ah:start', (raw) => {
  if (!raw) return;
  stopWait();
  resumeKey = null;
  if (WATCH) { if (watchMatch) startMatch(fromWatch(raw)); return; }
  if (raw.vsBot) botNote();
  me = socket.id;
  matchAt = Date.now();
  startMatch(raw);
});

// The first serve: the countdown is over and the puck is live.
socket.on('ah:play', (m) => {
  if (!match) return;
  const t = performance.now();
  if (m && Array.isArray(m.score)) setScore([m.score[0] | 0, m.score[1] | 0]);
  if (m && typeof m.msLeft === 'number') { clockC = m.msLeft; clockAt = t; }
  playAt = t;
  setPhase('playing', t);
});

// A serve after a goal, or after the 7 second rule: the puck appears on a spot, which is a jump, not a slide.
socket.on('ah:serve', (m) => {
  if (!match || !m) return;
  const t = performance.now();
  forceSnap = true;
  trail.length = 0;
  serveTo = m.to === 1 ? 1 : 0;
  if (m.why === 'stall') stallNote = { at: t, to: serveTo };
  if (Array.isArray(m.score)) setScore([m.score[0] | 0, m.score[1] | 0]);
  if (typeof m.msLeft === 'number') { clockC = m.msLeft; clockAt = t; }
  setPhase('playing', t);
});

socket.on('ah:goal', (m) => {
  if (!match || !m) return;
  const t = performance.now();
  goalAt = t; goalSide = m.s === 1 ? 1 : 0;
  if (Array.isArray(m.score)) setScore([m.score[0] | 0, m.score[1] | 0]);
  // The goal the puck went into: seat 0 scores in the top one (y = 0).
  fx.push({ kind: 'goal', x: AH.W / 2, y: goalSide === 0 ? 0 : AH.H, at: t, life: 900, size: 0, col: art.colorOf(roleOf(goalSide)) });
  shake(11);
  setPhase(m.s !== undefined ? 'goal' : phase, t);
});

/* Hits, rails and posts as the server saw them. A player already drew everything the screen predicted, so only the
   other player's hits come from here (when the screen did not guess that one); a watcher draws them all. */
socket.on('ah:ev', (list) => {
  if (!match || !Array.isArray(list)) return;
  for (let i = 0; i < list.length && i < 6; i++) {
    const e = list[i];
    if (!Array.isArray(e) || e.length < 5) continue;
    const kind = e[0] === 'h' ? 'hit' : e[0] === 'p' ? 'post' : 'rail';
    if (!WATCH && (kind !== 'hit' || e[1] === mySeat || performance.now() - theirHitAt < 160)) continue;
    effect({ e: kind, s: e[1] === 1 ? 1 : 0, v: Number(e[2]) || 0, x: Number(e[3]) || 0, y: Number(e[4]) || 0 }, false);
  }
});

socket.on('ah:sudden', () => {
  if (!match) return;
  suddenAt = performance.now();
  sdC = AH.SUDDEN_MS;
});

socket.on('ah:whistle', (m) => {
  if (!match) return;
  if (m && Array.isArray(m.score)) setScore([m.score[0] | 0, m.score[1] | 0]);
  endAt = performance.now();
  setPhase('settling');
});

socket.on('ah:over', (m) => {
  if (WATCH) { watchOver(m || {}); return; }
  if (overShown) return;
  overShown = true;
  setPhase('over');
  releaseAll();
  cv.classList.remove('playing');
  lastOver = Object.assign({}, m || {}, { ms: matchAt ? Date.now() - matchAt : 0, me, seat: mySeat });
  if (m && m.winnerId) { if (m.winnerId === me) series.mine++; else series.theirs++; }
  restake = null; restakeLine = '';
  paintOver();
  chatShow(false);
});

/* ── the result card ───────────────────────────────────────────────────────
   The one card every DuelSeries game ends on (public/js/shared/dsEnd.js). Every amount on it is the server's own
   figure from ah:over's `money` (server/duelMoney.js: the split index.js pays), only formatted here; nothing on
   this page works a payout out. Names go in as text. */
const RESTAKE_WAIT_MS = 120000;    // the lobby's wallet gets this long before the way back opens again
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
  const result = (sc[mine] | 0) + '-' + (sc[1 - mine] | 0);      // yours first
  const time = m.ms > 0 ? DSEnd.clock(m.ms) : '';
  const card = {
    tone: 'plain',
    verdict: won === true ? 'You win' : won === false ? (m.winner || 'Opponent') + ' wins' : 'Draw',
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
      /* The seat's own figure; the table's rung if the seat is somehow missing. */
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
  else if (m.why === 'a draw') card.notes.push('Still level after the minute of sudden death.');

  /* The same three buttons on every card, paid and free: Lobby, Spectate, Play again. Lobby and Spectate are shut
     while the wallet is open: the lobby blanks this frame on game:done, and a token minted after that would have
     no page to seat; Spectate leaves the card too. */
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
    // Spectate is shut for the whole buy-in, slow or not: a late stake needs this page in the frame.
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
  socket.emit('ah:leave');
  dropMatch();
  queue(token);
}

/* A PAID PLAY AGAIN BUYS A NEW ENTRY. The one this page opened with was spent on the first queue, so asking again
   with it is refused. The lobby's wallet stakes the same rung (duel:restake, answered by
   wallet-widget/src/restakeBridge.mjs) and posts the fresh token back, which goes straight into ah:queue and is
   never stored. Knockout's Play again, the same messages. */
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
    /* No answer yet: the way back opens again, and a late answer is still taken (the match is queued once it lands). */
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
/* The lobby's answer: only the parent frame, only this origin, only the request this page made (the nonce the
   bridge always echoes). */
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

/* Said in a sentence: the server's reasons are written as clauses. */
function sentence(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.');
}

/* The stake came back: nobody took the table, or they backed out. Said out loud, because money quietly returning
   is money a player thinks they lost. */
socket.on('ah:unqueued', ({ refunded, why } = {}) => {
  if (WATCH || match) return;
  /* A free seat whose match could not start: said, with the way back, rather than a clock that runs out. */
  if (!refunded) {
    if (why !== 'the match could not start') return;
    stopWait(); resumeKey = null;
    $('wait').hidden = false;
    waitSpin(false);
    $('waitMain').textContent = 'Could not start the match';
    $('waitSub').textContent = 'Go back to the lobby and press Play again.';
    $('waitCancel').textContent = 'Back to the lobby';
    return;
  }
  stopWait(); resumeKey = null; waitPaid = false;
  $('wait').hidden = false;
  waitSpin(false);                      // no longer looking
  $('waitMain').textContent = 'Buy-in refunded';
  $('waitSub').textContent = ({
    'nobody joined that table': 'Nobody joined that table, so your buy-in went back to your wallet.',
    'left the queue': 'Cancelled. Your full buy-in went back to your wallet.',
    'connection dropped': 'Your connection dropped while you waited, so your buy-in went back to your wallet.',
    'the match could not start': 'The match could not start, so your buy-in went back to your wallet.',
  })[why] || 'Your buy-in went back to your wallet.';
  $('waitCancel').textContent = 'Back to the lobby';
});

socket.on('ah:refused', ({ why } = {}) => {
  /* Every refusal says something. A silent one is indistinguishable from a control that does not work. Out of a
     match it is the seat that was refused (a buy-in the server would not take), said on the wait card. */
  if (WATCH || match) return;
  /* A paid reconnect whose seat could not be taken back (the server restarted, say): never "unpaid", because it
     was paid; a seat the server lost is refunded by the server. */
  const lost = waiting && waitPaid && resumeKey;
  stopWait(); resumeKey = null; waitPaid = false;
  $('wait').hidden = false;
  waitSpin(false);
  $('waitMain').textContent = 'Not seated';
  $('waitSub').textContent = lost
    ? 'Your connection dropped while you waited. Your buy-in goes back to your wallet.'
    : (sentence(why) || 'The table did not let you in.');
  $('waitCancel').textContent = 'Back to the lobby';
});

/* The owner closed the game for an update. A queue the server turned away for it says so; a match already on the
   table plays out, and a seat the server is holding keeps waiting (it hears ah:unqueued if anything changes). When
   the game opens again, a page that was turned away queues by itself. */
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
  if (restake && !restake.slow) return;     // the wallet is open: the way back is shut until it answers
  clearTimeout(watchTimer);
  clearTimeout(swapTimer);
  if (BAR) BAR.close();
  socket.emit(WATCH ? 'ah:unwatch' : 'ah:leave');
  /* The lobby hosts this in an iframe and listens for exactly this, same as the other games. Falls back to a normal
     navigation when opened directly. */
  if (window.parent && window.parent !== window) window.parent.postMessage('game:done', '*');
  else location.href = '/';
}
/* Cancel on a paid seat that is still waiting hands the buy-in back first and says so (ah:unqueued); the next press
   goes to the lobby. Leaving any other way refunds it too (ah:leave, or the page closing). */
$('waitCancel').addEventListener('click', () => {
  if (waiting && waitPaid && !match && !WATCH) {
    stopWait(); waitPaid = false; resumeKey = null;
    waitSpin(true);
    $('waitMain').textContent = 'Cancelling…';
    $('waitSub').textContent = 'Giving your buy-in back.';
    $('waitCancel').textContent = 'Back to the lobby';
    socket.emit('ah:unqueue');
    return;
  }
  toLobby();
});

/* SPECTATE, from a result card. The page reads its watch mark once, as it boots, so this does exactly what the
   lobby's Spectate does for this rung (public/js/v2/play.js spectate()): every money key out, the mark for this
   game, the rung in its own key for a paid table (dsWatchStake, never 'stake'), then this page again, which comes
   up watching that rung. Nothing here seats anybody or stakes anything. */
const WATCH_URL = '/airhockey';
const MONEY_KEYS = ['entryToken', 'entrySol', 'stake', 'slPaidLaunch', 'slxPaidCut', 'slBr', 'spectateOnly'];
function reopen() {
  try {
    if (typeof location.replace === 'function') location.replace(WATCH_URL);
    else location.href = WATCH_URL;
  } catch (_) { location.href = WATCH_URL; }
}
function spectate() {
  if (restake) return;   // a Play again buy-in still with the wallet, slow or not: a late stake needs this page in the frame
  if (WATCH) { watch(watchLastId); return; }
  try {
    for (const k of MONEY_KEYS) sessionStorage.removeItem(k);
    sessionStorage.setItem('dsWatch', GAME);
    if (myStake > 0) sessionStorage.setItem('dsWatchStake', String(myStake));
    else sessionStorage.removeItem('dsWatchStake');
    /* Storage that will not hold the mark would reopen a Play: stay put. */
    if (sessionStorage.getItem('dsWatch') !== GAME) return;
  } catch (_) { return; }
  clearTimeout(watchTimer);
  socket.emit('ah:leave');
  reopen();
}

window.addEventListener('beforeunload', () => socket.emit(WATCH ? 'ah:unwatch' : 'ah:leave'));

/* ── watching ──────────────────────────────────────────────────────────────
   The server sends a watcher the same moments a player gets, by seat where a player's messages have a socket id,
   and without the input acks. */
function fromWatch(s) {
  if (!s) return s;
  return Object.assign({}, s, { players: (s.players || []).map(p => Object.assign({}, p, { id: seatId(p.side) })) });
}

/* Ask for a match. `after` is the one being left, so the server moves on from it rather than handing the same one
   back; dir 'prev' asks for the one before it instead of the one after. */
function watch(after, dir) {
  clearTimeout(watchTimer);
  const msg = after ? { after, stake: WATCH_STAKE } : { stake: WATCH_STAKE };
  if (after && dir === 'prev') msg.dir = 'prev';
  socket.emit('ah:watch', msg);
  publishWatch(watchMatch ? 'watching' : 'searching');
}

/* The Previous and Next of the shared bar: the match before or after this one, straight away. The arrows rest
   until the answer comes, and open again on their own if it never does. */
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

/* "A vs B" for the bar's plate, which holds 32 characters: a long name gives up its end so the pair always fits. */
function vsLabel(names) {
  const room = 28, half = room / 2;
  const c = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
  const a = String((names && names[0]) || 'Player').trim() || 'Player';
  const b = String((names && names[1]) || 'Player').trim() || 'Player';
  const x = a.length <= half ? a : b.length <= half ? c(a, room - b.length) : c(a, half);
  const y = b.length <= half ? b : a.length <= half ? c(b, room - a.length) : c(b, half);
  return x + ' vs ' + y;
}

/* What the page is doing, for a headless check to read without a screenshot. */
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

socket.on('ah:watching', (m) => {
  if (!WATCH || !m) return;
  clearTimeout(watchTimer);
  clearTimeout(swapTimer);
  const swap = swapping;
  swapping = false;
  if (!m.match || !m.state) {
    /* Nobody is playing (or every match has its fill of watchers): the empty table behind the bar, and an ask
       every few seconds so the first match to start is followed by itself. */
    watchMatch = null;
    dropMatch(); overShown = false; watchLine('');
    chatShow(false);
    if (BAR) BAR.empty();
    publishWatch(m.full ? 'full' : m.refused ? 'refused' : 'none');
    nextSoon();
    return;
  }
  /* Next with only one match running comes back with the same one. The table on screen is that match, live. */
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

/* Where this match now sits among the ones running. */
socket.on('ah:matches', ({ index, count } = {}) => {
  if (!WATCH || !watchMatch) return;
  if (Number.isFinite(index)) watchMatch.index = index;
  if (Number.isFinite(count)) watchMatch.count = count;
  publishWatch('watching');
});

/* The match went away without a result. On to the next at once. */
socket.on('ah:ended', ({ id } = {}) => {
  if (!WATCH || overShown) return;
  if (watchMatch && id && id !== watchMatch.id) return;
  overShown = true;
  publishWatch('ended');
  followOn(0);
});

/* How it ended, in the line under the strip, then on to the next match. No card and no money: nobody watching
   staked anything. */
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
window.__ah = () => ({
  phase, mySeat, score: score.slice(), clock: Sim.clockText(clockShown), predicting, rtt: Math.round(rtt), touchUI,
  phone: VIEW.phone, flip: VIEW.flip, over: overShown, waiting, look: LOOK,
  view: { s: VIEW.s, ox: VIEW.ox, oy: VIEW.oy },
  me: mySeat >= 0 ? { x: rm[mySeat].x, y: rm[mySeat].y, sx: sx(rm[mySeat].x), sy: sy(rm[mySeat].y) } : null,
  them: mySeat >= 0 ? { x: rm[1 - mySeat].x, y: rm[1 - mySeat].y } : null,
  aim: { x: aim.x, y: aim.y }, finger: finger.id !== null,
  puck: { x: rpk.x, y: rpk.y, vx: rpk.vx, vy: rpk.vy, live: rpk.live },
  corr: off.map(o => Math.round(Math.hypot(o.x, o.y) * 10) / 10),
  ticks: { client: Math.round(clientTick * 10) / 10, base: baseK, sent: sentT },
  server: haveBase ? { puck: { x: base.puck.x, y: base.puck.y }, m: [{ x: base.m[0].x, y: base.m[0].y }, { x: base.m[1].x, y: base.m[1].y }] } : null,
});

// World units to CSS px on this screen (turned for the top seat), for the same checks.
window.__ahToScreen = (x, y) => [sx(x), sy(y)];

/* ── boot ──────────────────────────────────────────────────────────────── */
if (SND) SND.attach(socket, () => ({ me, mySide: mySeat, watch: WATCH, puckX: rpk.x }));
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
