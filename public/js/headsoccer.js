'use strict';
/* ─── Head Soccer, the client ─────────────────────────────────────────────────
   Two big heads, one ball, two minutes on the clock. This page draws the match
   (public/js/headsoccer/hsArt.js paints it), reads your keys or thumbs, and
   sends the server what you are pressing.

   THE SERVER DECIDES. Goals, the clock, the score and who wins all come from
   server/HeadSoccerRoom.js. The page never scores and never runs the clock: the
   physics it runs (shared/hsSim.js, the very same file the server steps) is
   always run with live=false, which moves bodies and nothing else.

   BUT YOUR HEAD MOVES AT ONCE. Waiting a round trip for every key press feels
   like wading through mud, so the page predicts: it keeps the newest snapshot,
   replays the physics forward from it to the present with your own presses on
   top (rewind and replay), and draws that. The ball is in the same replay, so a
   ball you head on your screen bounces off your head on your screen, the same
   way it will on the server a moment later. When a snapshot disagrees with what
   was predicted, the difference is eased out over about a tenth of a second
   instead of jumping, unless it is a big one (a kick-off), which snaps.

   WORLD UNITS IN, PIXELS OUT. Everything happens in the reference's own frame
   (Heads Arena Euro Soccer: 1920 units high, as wide as the screen allows within
   its 4:3 to 2.29:1 limits; docs/head-soccer-reference.md); this file owns the
   one transform that fits that frame to the screen, and the phone buttons,
   which in portrait live under the pitch rather than on it.

   The shell around the match (the wait card, the bot note, the result card, the
   paid Play again, Spectate, chat, maintenance, the reconnect key) is Knockout's
   (public/js/knockout.js), behaviour for behaviour, with hs: event names. */

const socket = io();
// The ping and FPS readout every game shares (public/js/shared/dsPerfHud.js), timed on this socket.
if (window.DSPerfHud) window.DSPerfHud.mount({ socket });
const Sim = window.HSSim, HS = Sim.HS, IN = Sim.IN;
const $ = (id) => document.getElementById(id);
const cv = $('pitch');
const ctx = cv.getContext('2d', { alpha: false });
const art = window.HSArt.create();
const SND = window.HeadSoccerSound || null;
const GAME = 'headsoccer';

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
/* The head picked in the lobby's Customize (shared/hsHeads.js, stored under duel.headsoccer.head), sent with
   hs:queue; the server wears it only if it is on that list. */
function myHead() {
  try { const L = window.DS_HS_HEADS, id = localStorage.getItem(L ? L.KEY : 'duel.headsoccer.head'); return L && L.byId(id) ? id : undefined; }
  catch (_) { return undefined; }
}
function shopFields() {
  try {
    const shop = localStorage.getItem('duel.shop.headsoccer'), pass = localStorage.getItem('duel.skinpass');
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
let mySeat = -1;              // 0 left (defends the left goal), 1 right; -1 while watching
let phase = null;             // the server's state: countdown | playing | goal | settling | over
let phaseAt = 0;              // when this phase began here (KICK OFF's entrance)
let score = [0, 0];
let overShown = false;
let lastOver = null;          // the result on the card, with how long the match ran (ms)
let matchAt = 0;              // when this match started, for the card's Time
let restake = null;           // { nonce, slow } while a paid Play again is with the lobby's wallet
let restakeLine = '';         // a restake's error, said on the card
let restakeTimer = 0;

let clockC = HS.MATCH_MS, clockAt = 0, clockShown = HS.MATCH_MS;   // the server's msLeft, when it came, what is shown
let goldC = -1;               // in golden goal: its minute's ms left (the board counts it down), else -1
let clockText = '0200';       // the board's MMSS, the time left
let goalAt = -1e9;            // the GOAL! word's start
let goalGolden = false;       // that goal was the golden one
let goldenAt = -1e9;          // the GOLDEN GOAL call (level at 0:00)
let countAt = -1e9;           // the 3, 2, 1, 0 countdown's start (the opening one or a kick-off's)
let playAt = -1e9;            // when play last started (the 0 shows for 600 ms after it)
let lastCount = -1;           // the number last shown, for its tick
let platesOn = false;         // the score plate shows from the first whistle (S: _showScore)
let whistleAt = -1e9;         // full time: the score rises to the middle
let kickoffs = 0, firstKickAt = -1e9;
const series = { mine: 0, theirs: 0 };   // matches won on this visit, the plate's counters (S: matchHistory)
/* Each player's look, between frames: run steps, the kick's boot target, blinks, the face after a goal. */
const anim = [{ run: 0, kickMs: -1, kdx: 0, kdy: 0, blink: false, mood: 0 }, { run: 0, kickMs: -1, kdx: 0, kdy: 0, blink: false, mood: 0 }];
let moodUntil = 0;

/* ── the latest snapshot ──────────────────────────────────────────────────── */
const base = Sim.newMatch();  // unpacked, in HSSim's own shape
let haveBase = false, baseK = 0, baseAt = 0, baseFresh = false, baseAck = 0;
const wbuf = [];              // a watcher's last few snapshots: { k, b, p0, p1 }

/* ── prediction ───────────────────────────────────────────────────────────── */
const sim = Sim.newMatch();   // the present, as predicted
let predicting = false;
let clientTick = 0;           // the tick on screen (fractional), advanced by the wall clock
let frontier = 0;             // the newest tick ever stepped: events at or before it were already heard
let forceSnap = false;        // the next correction is a kick-off: snap, never ease
const off = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];   // eased corrections: seat 0, seat 1, ball
const was = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
const CORRECT_MS = 100;       // a correction is eased out over about this (the brief: 80 to 120 ms)
const SNAP_PX = [170, 340, 400]; // bigger than this snaps: your own head, theirs (guessed between snapshots), the ball

const inp = { held: 0, jumps: 0, kicks: 0, powers: 0 };   // what I am pressing; the counts only ever go up
const ZERO = { held: 0, jumps: 0, kicks: 0, powers: 0 };
let seq = 0;
const hist = [];              // every change of input: { seq, tick, held, jumps, kicks, powers }
const oppIn = { held: 0, jumps: 0, kicks: 0, powers: 0 };
let oppHeld = 0;
const inputs = [ZERO, ZERO];

/* What gets drawn: the predicted (or interpolated) bodies plus their eased corrections. */
const rp = [Sim.newPlayer(0), Sim.newPlayer(1)];
const rb = Sim.newBall();
let drawable = false;

/* ── latency ──────────────────────────────────────────────────────────────── */
/* One-way time to the server, from the server's own ping (index.js ping_check): the median of the last five round
   trips, so one slow answer (or the first one, often sent before the connection upgrades) does not swing it. Pinged
   twice a second until there are five, then every two seconds. Clamped to 0..150 ms one way: past that a guess
   further ahead costs more in corrections than it gains. */
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
   One scale and one offset, recomputed on resize. Landscape: the reference's
   way (Phaser SHOW_ALL with its ratio clamped): 1920 units high, as wide as the
   window up to its limits (4:3 to 2.29:1), centred on the halfway line. Portrait
   on a phone: the narrowest frame (4:3) fits the width at the top and the
   buttons get the space under it, where thumbs can reach them. */
let VIEW = { s: 1, ox: 0, oy: 0, dpr: 1, w: 0, h: 0, portrait: false, vw: HS.VIEW_W_REF };
let builtK = 0, builtVW = 0, resizeAt = 0;
let touchUI = (() => {
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
    return (navigator.maxTouchPoints || 0) > 0 && !(window.matchMedia && window.matchMedia('(pointer: fine)').matches);
  } catch (_) { return false; }
})();
let BTN = null;                // the button rects, CSS px: { L, R, K, J } each { x, y, w, h, cx, cy }

function fit() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  const portrait = touchUI && w / h < 1.25;
  let s, vw, oy;
  if (portrait) { vw = HS.VIEW_W_MIN; s = w / vw; oy = Math.max(0, Math.min(60, (h - HS.VIEW_H * s) * 0.15)); }
  else {
    vw = Math.max(HS.VIEW_W_MIN, Math.min(HS.VIEW_W_MAX, HS.VIEW_H * w / h));
    s = Math.min(h / HS.VIEW_H, w / vw);
    oy = (h - HS.VIEW_H * s) / 2;
  }
  VIEW = { s, ox: w / 2, oy, dpr, w, h, portrait, vw };
  const k = s * dpr;
  // The stadium is repainted at the new size, but not on every frame of a window being dragged.
  if (!builtK || Math.abs(k - builtK) / builtK > 0.01 || Math.abs(vw - builtVW) > 2) { if (!builtK) build(k); else resizeAt = performance.now(); }
  layoutButtons();
  placeOverlays();
}
function build(k) { builtK = k; builtVW = VIEW.vw; art.build(k, VIEW.vw); }

/* AND CHECKED EVERY FRAME, because a resize event is not a promise (knockout.js: the first measurement can be
   taken before the layout settles, and no resize ever comes to fix it). */
function refit() {
  if (cv.style.width !== window.innerWidth + 'px' || cv.style.height !== window.innerHeight + 'px') fit();
  if (resizeAt && performance.now() - resizeAt > 150) { resizeAt = 0; build(VIEW.s * VIEW.dpr); }
}
window.addEventListener('resize', fit);
window.addEventListener('orientationchange', fit);

/* World to CSS px. */
const sx = (x) => VIEW.ox + x * VIEW.s, sy = (y) => VIEW.oy + y * VIEW.s;

/* The phone buttons. Landscape: the reference's four touch zones along the bottom (S: MobileControls, 400 x 350
   units each: left and right from the left edge, kick then jump from the right edge), each drawn as a round button
   1.2 x its 101 px art (269 units) in the middle of its zone. Portrait: the same four in a row under the pitch,
   sized for thumbs. */
function layoutButtons() {
  const V = VIEW, r = {};
  const mk = (x, y, w, h) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), cx: x + w / 2, cy: y + h / 2 });
  if (V.portrait) {
    const m = 14, gap = 10, fieldBot = V.oy + HS.VIEW_H * V.s;
    const bh = Math.max(64, Math.min(120, Math.min(V.w * 0.24, (V.h - fieldBot) * 0.4)));
    const half = (V.w - 2 * m - gap) / 2, bw = (half - gap) / 2, y = V.h - m - bh - 8;
    r.L = mk(m, y, bw, bh); r.R = mk(m + bw + gap, y, bw, bh);
    r.K = mk(V.w / 2 + gap / 2, y, bw, bh); r.J = mk(V.w / 2 + gap / 2 + bw + gap, y, bw, bh);
  } else {
    const zw = 400 * V.s, zh = 350 * V.s, left = sx(-V.vw / 2), right = sx(V.vw / 2), bot = sy(HS.VIEW_H);
    const btn = (x0) => { const d = 269 * V.s, cx = x0 + zw / 2, cy = bot - zh / 2; return mk(cx - d / 2, cy - d / 2, d, d); };
    r.L = btn(left); r.R = btn(left + zw); r.J = btn(right - zw); r.K = btn(right - 2 * zw);
  }
  BTN = r;
}

/* Which button a finger is on: the reference's whole zones (a finger anywhere in a button's 400 x 350 strip of the
   bottom counts), the nearest centre winning where two reach. `moveOnly` asks only about L and R (a finger
   sliding from one arrow to the other). */
function hitButton(x, y, moveOnly) {
  if (!BTN) return null;
  const pad = VIEW.portrait ? 12 : (400 * VIEW.s - BTN.L.w) / 2;
  let best = null, bestD = Infinity;
  for (const k of moveOnly ? ['L', 'R'] : ['L', 'R', 'K', 'J']) {
    const b = BTN[k];
    const x0 = k === 'L' ? 0 : b.x - pad, x1 = k === 'J' ? VIEW.w : b.x + b.w + pad;
    const y0 = b.y - (VIEW.portrait ? pad : Math.max(pad, 40 * VIEW.s)), y1 = VIEW.h;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const d = Math.hypot(x - b.cx, y - b.cy);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}
function onPause(x, y) {
  const p = art.pauseAt();
  return Math.hypot(x - sx(p.x), y - sy(p.y)) <= p.r * VIEW.s * 1.15;
}

/* The bot note and the watch line sit under the board; chat sits above the key hint. */
function placeOverlays() {
  const V = VIEW, under = Math.round(sy(420));
  const note = $('botNote'); if (note) note.style.top = under + 'px';
  const line = $('watchLine'); if (line) line.style.top = under + 'px';
  if (chat && chat.el) {
    chat.el.style.setProperty('--dsc-t', (V.portrait ? Math.round(sy(HS.VIEW_H) + 10) : 70) + 'px');
    chat.el.style.setProperty('--dsc-b', Math.round(V.h - sy(1640)) + 'px');
  }
}

/* The pause button: an online match cannot stop, so it offers the way out (the same leave as the lobby's). */
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
   Every message is the whole state (held arrows and running counts of jump,
   kick and power presses), sent on every change and repeated every 250 ms while
   the match runs, so a dropped one never leaves a key stuck down and a dropped
   press is still counted by the next. A change goes reliably (it matters, and
   there are few); the repeats go volatile (they only heal). The server drops a
   flood past 40 in half a second, so this never sends more than 30. */
// The reference's keys (S: InputList player 1: arrows, up to jump, SPACE to kick), with A/D/W and K as well.
const KEYS = { KeyA: 'L', ArrowLeft: 'L', KeyD: 'R', ArrowRight: 'R', KeyW: 'J', ArrowUp: 'J',
               Space: 'K', KeyK: 'K' };
const downKeys = new Set();
let touchHeld = 0;
let sentAt = 0, winAt = 0, winN = 0, sendTimer = 0;

const canPlay = () => !WATCH && !!match && mySeat >= 0 && !overShown && phase !== 'over';

function sendInput(reliable) {
  if (!canPlay()) return;
  const t = performance.now();
  if (t - winAt > 500) { winAt = t; winN = 0; }
  if (winN >= 30) {
    if (!sendTimer) sendTimer = setTimeout(() => { sendTimer = 0; sendInput(true); }, Math.max(5, 505 - (t - winAt)));
    return;
  }
  winN++; sentAt = t;
  const msg = { s: seq, h: inp.held, j: inp.jumps, k: inp.kicks, p: inp.powers };
  if (reliable) socket.emit('hs:in', msg); else socket.volatile.emit('hs:in', msg);
}

/* A change of input, remembered with the tick it takes effect on (the next one stepped), so a replay from an older
   snapshot applies it at the same moment the server will. */
function inputChanged() {
  seq++;
  const last = hist.length ? hist[hist.length - 1].tick : 0;
  const t = predicting ? Math.max(last, sim.tick + 1) : last;
  hist.push({ seq, tick: t, held: inp.held, jumps: inp.jumps, kicks: inp.kicks, powers: inp.powers });
  if (hist.length > 120) hist.shift();
  sendInput(true);
}

function setHeld() {
  let h = touchHeld;
  for (const c of downKeys) h |= KEYS[c] === 'L' ? IN.LEFT : IN.RIGHT;
  if (h === inp.held) return;
  inp.held = h;
  inputChanged();
}

function press(a) {
  if (a === 'J') inp.jumps++;
  else if (a === 'K') inp.kicks++;
  else return;                             // no power shot (Owen 2026-10-27; the reference has none)
  inputChanged();
}

const typingIn = (e) => {
  const t = e.target;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};
window.addEventListener('keydown', (e) => {
  // An Escape that just closed DSDialog arrives here marked defaultPrevented: without this check the closed
  // "Leave the match?" opened again at once and Esc could never dismiss it (site sweep 2026-10-28).
  if (e.code === 'Escape' && canPlay() && !e.defaultPrevented) { pauseMenu(); return; }
  const a = KEYS[e.code];
  if (!a || typingIn(e) || !canPlay()) return;
  e.preventDefault();
  if (a === 'L' || a === 'R') { downKeys.add(e.code); setHeld(); return; }
  if (!e.repeat) press(a);
});
window.addEventListener('keyup', (e) => {
  if (!downKeys.has(e.code)) return;
  downKeys.delete(e.code);
  setHeld();
});
function releaseAll() {
  downKeys.clear(); fingers.clear(); touchHeld = 0;
  if (inp.held) { inp.held = 0; inputChanged(); }
}
window.addEventListener('blur', releaseAll);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

/* Fingers. Each pointer is tracked on its own, so a thumb can hold R while the other taps Jump; a thumb on an arrow
   can slide to the other arrow without lifting. Kick and Jump count the moment they are touched. */
const fingers = new Map();     // pointerId -> 'L' | 'R' | 'K' | 'J' | 'P' | null
function fingersChanged() {
  touchHeld = 0;
  for (const b of fingers.values()) { if (b === 'L') touchHeld |= IN.LEFT; else if (b === 'R') touchHeld |= IN.RIGHT; }
  setHeld();
}
function fingerOn(k) { for (const b of fingers.values()) if (b === k) return true; return false; }
cv.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch' && !touchUI) { touchUI = true; fit(); }
  if (match && !overShown && onPause(e.clientX, e.clientY)) { e.preventDefault(); pauseMenu(); return; }
  if (!touchUI || !canPlay()) return;
  e.preventDefault();
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  const b = hitButton(e.clientX, e.clientY, false);
  fingers.set(e.pointerId, b);
  if (b === 'K' || b === 'J') press(b);
  fingersChanged();
});
cv.addEventListener('pointermove', (e) => {
  if (!fingers.has(e.pointerId)) return;
  const cur = fingers.get(e.pointerId);
  if (cur === 'K' || cur === 'J') return;
  e.preventDefault();
  const b = hitButton(e.clientX, e.clientY, true);
  if (b !== cur) { fingers.set(e.pointerId, b); fingersChanged(); }
});
const lift = (e) => { if (fingers.delete(e.pointerId)) fingersChanged(); };
cv.addEventListener('pointerup', lift);
cv.addEventListener('pointercancel', lift);
cv.addEventListener('lostpointercapture', lift);
cv.addEventListener('contextmenu', (e) => e.preventDefault());

/* ── snapshots ─────────────────────────────────────────────────────────────── */
function guessHeld(p) { return p.vx > 20 ? IN.RIGHT : p.vx < -20 ? IN.LEFT : 0; }

function onSnap(s) {
  if (!match || !s || !Array.isArray(s.b) || !Array.isArray(s.p) || s.p.length < 2) return;
  const k = Number(s.k) || 0;
  if (haveBase && k < baseK) return;            // older than the one we have (a new match resets on hs:start)
  const t = performance.now();
  base.tick = k;
  base.ball = Sim.unpackBall(s.b);
  base.p[0] = Sim.unpackPlayer(s.p[0], 0);
  base.p[1] = Sim.unpackPlayer(s.p[1], 1);
  if (Array.isArray(s.sc) && s.sc.length === 2) score = [s.sc[0] | 0, s.sc[1] | 0];
  if (typeof s.c === 'number' && s.c >= 0) { clockC = s.c; clockAt = t; goldC = typeof s.g === 'number' && s.g >= 0 ? s.g : -1; }
  if (!WATCH && mySeat >= 0 && Array.isArray(s.a)) {
    baseAck = Number(s.a[mySeat]) || 0;
    // Changes the server has had are only needed back to the newest of them.
    while (hist.length > 1 && hist[1].seq <= baseAck) hist.shift();
  }
  if (typeof s.st === 'string') setPhase(s.st, t);
  oppHeld = mySeat >= 0 ? guessHeld(base.p[1 - mySeat]) : 0;
  baseK = k; baseAt = t; baseFresh = true; haveBase = true;
  if (WATCH) { wbuf.push({ k, b: base.ball, p0: base.p[0], p1: base.p[1] }); if (wbuf.length > 12) wbuf.shift(); }
}
socket.on('hs:snap', onSnap);

/* Phases: countdown (the opening one), kickoff (the same after a break), playing, goal, golden, settling,
   over. The pitch moves in all of them but over, so the replay runs through them all; only playing takes input. */
const LIVE_PHASES = { countdown: 1, kickoff: 1, playing: 1, goal: 1, golden: 1, settling: 1 };
function setPhase(p, t) {
  if (p === phase) return;
  const was = phase;
  phase = p;
  phaseAt = t || performance.now();
  if (p === 'countdown' || p === 'kickoff') { countAt = phaseAt; lastCount = -1; forceSnap = true; }
  if (p === 'playing' && (was === 'countdown' || was === 'kickoff')) { playAt = phaseAt; platesOn = true; }
  if (!LIVE_PHASES[p]) predicting = false;
}

/* ── the replay ──────────────────────────────────────────────────────────────
   The present is the newest snapshot's tick plus the time since it came plus
   the trip there and back: the server's clock now, plus the time a press sent
   now takes to reach it. Running that far ahead means a press is drawn the
   moment it is made AND lands on the server at the tick it was drawn at, so
   your own head is almost never corrected. The other player and the ball are
   guessed that much further ahead, which is what the eased corrections are for. */
function wantTick(now) { return baseK + (now - baseAt + 2 * oneWay()) * 0.06 + 0.5; }

/* My input for the step that makes tick t: the newest change the server has
   (acked in the snapshot), then any later change whose tick has come. */
function inputFor(t) {
  let best = null;
  for (let i = 0; i < hist.length; i++) {
    const h = hist[i];
    if (h.seq <= baseAck || h.tick <= t) best = h; else break;
  }
  return best || ZERO;
}

function stepSim() {
  const t = sim.tick + 1;
  const o = sim.p[1 - mySeat];
  // The other player: still walking the way it was, and no presses we have not been told about.
  oppIn.held = oppHeld; oppIn.jumps = o.jumps; oppIn.kicks = o.kicks; oppIn.powers = o.powers;
  inputs[mySeat] = inputFor(t);
  inputs[1 - mySeat] = oppIn;
  const ev = Sim.step(sim, inputs, HS.STEP, false, phase === 'playing');
  if (t > frontier) {
    frontier = t;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.s !== mySeat) continue;
      if ((e.e === 'kick' || e.e === 'swing' || e.e === 'jump') && SND) SND.local(e.e, e.s, sim.ball.x, e.v);
    }
  }
}
function advance(target, cap) {
  let n = 0;
  while (sim.tick < target && n < cap) { stepSim(); n++; }
}
function loadBase() {
  Object.assign(sim.p[0], base.p[0]);
  Object.assign(sim.p[1], base.p[1]);
  Object.assign(sim.ball, base.ball);
  sim.tick = base.tick;
}
function bodyOf(i) { return i < 2 ? sim.p[i] : sim.ball; }

function predict(now, dt) {
  const want = wantTick(now);
  if (!predicting) {
    predicting = true;
    clientTick = want;
    loadBase();
    baseFresh = false;
    frontier = Math.max(frontier, sim.tick);
    advance(Math.floor(clientTick), 12);
    for (const o of off) { o.x = 0; o.y = 0; }
  } else {
    clientTick += dt * 0.06;
    const err = want - clientTick;
    if (Math.abs(err) > 6) clientTick = want;          // a stall or a jump in latency: go straight there
    else clientTick += err * Math.min(1, dt / 400);    // else drift onto it, so the picture never stutters
  }
  const target = Math.floor(clientTick);
  advance(target, 4);                                  // the present carried on
  if (baseFresh) {
    baseFresh = false;
    for (let i = 0; i < 3; i++) { const b = bodyOf(i); was[i].x = b.x + off[i].x; was[i].y = b.y + off[i].y; }
    loadBase();
    advance(target, 12);
    for (let i = 0; i < 3; i++) {
      const b = bodyOf(i), o = off[i];
      o.x = was[i].x - b.x; o.y = was[i].y - b.y;
      const lim = i === 2 ? SNAP_PX[2] : i === mySeat ? SNAP_PX[0] : SNAP_PX[1];
      if (forceSnap || Math.hypot(o.x, o.y) > lim) { o.x = 0; o.y = 0; }
    }
    forceSnap = false;
  }
  const decay = Math.exp(-dt / CORRECT_MS);
  for (const o of off) { o.x *= decay; o.y *= decay; if (Math.abs(o.x) < 0.05) o.x = 0; if (Math.abs(o.y) < 0.05) o.y = 0; }
  // Between two steps, carried on by velocity, so a 144 Hz screen is as smooth as a 60 Hz one.
  const frac = Math.max(0, Math.min(1, clientTick - sim.tick));
  for (let i = 0; i < 2; i++) toRender(rp[i], sim.p[i], frac, off[i]);
  ballRender(sim.ball, frac, off[2]);
}

/* Carried on by velocity only when airborne or running: a body standing still on the grass stays put. */
function toRender(r, p, frac, o) {
  const dt = frac * HS.STEP;
  r.x = p.x + p.vx * dt + (o ? o.x : 0);
  r.y = p.y + (p.ground && Math.abs(p.vy) < 1 ? 0 : p.vy * dt) + (o ? o.y : 0);
  r.vx = p.vx; r.vy = p.vy; r.ground = p.ground; r.left = p.left; r.mv = p.mv;
  r.kickMs = p.kickMs;
}
function ballRender(b, frac, o) {
  const dt = frac * HS.STEP;
  rb.x = b.x + b.vx * dt + (o ? o.x : 0);
  rb.y = b.y + b.vy * dt + (o ? o.y : 0);
  rb.rot = b.rot;
}

/* A watcher has no seat to predict, so it draws the match about 100 ms behind the newest snapshot, between the two
   snapshots either side of that moment. A kick-off (a body jumping across the pitch) is not slid across. */
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
  const jump = (p, q) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y) > 300;
  const pl = (r, p, q) => {
    if (jump(p, q)) { toRender(r, u < 0.5 ? p : q, 0, null); return; }
    toRender(r, q, 0, null);
    r.x = lerp(p.x, q.x, u); r.y = lerp(p.y, q.y, u);
    r.kickMs = p.kickMs >= 0 && q.kickMs >= 0 ? lerp(p.kickMs, q.kickMs, u) : q.kickMs;
  };
  pl(rp[0], a.p0, b.p0); pl(rp[1], a.p1, b.p1);
  if (jump(a.b, b.b)) ballRender(u < 0.5 ? a.b : b.b, 0, null);
  else {
    ballRender(b.b, 0, null);
    rb.x = lerp(a.b.x, b.b.x, u); rb.y = lerp(a.b.y, b.b.y, u); rb.rot = lerp(a.b.rot, b.b.rot, u);
  }
}

/* ── the loop ─────────────────────────────────────────────────────────────── */
let lastFrame = performance.now();
const hud = { digits: '0000', score: [0, 0], names: ['', ''], hist: [0, 0], mine: -1, plate: false, keys: false, scoreBig: 0 };

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
  if (!match || !haveBase) return;
  if (WATCH) interpolate(now, dt);
  else if (mySeat >= 0 && LIVE_PHASES[phase]) predict(now, dt);
  else {
    for (let i = 0; i < 2; i++) toRender(rp[i], base.p[i], 0, null);
    ballRender(base.ball, 0, null);
  }
  drawable = true;
  // The whole input again every 250 ms while the match runs: a dropped message heals itself.
  if (canPlay() && phase !== 'settling' && now - sentAt > 250) sendInput(false);
  // The board: the time left (in golden goal, its minute's), run down smoothly between snapshots while play is live.
  let ms = clockC > 0 || goldC < 0 ? clockC : goldC;
  if (phase === 'playing') ms -= now - clockAt;
  ms = Math.max(0, ms);
  if (ms < clockShown || ms > clockShown + 600) clockShown = ms;
  clockText = Sim.clockDigits(clockShown);
  // The countdown's tick, once per number (S: doCountDown plays "countdown" each 600 ms, the whistle at 0).
  const n = countNumber(now);
  if (n !== lastCount) { lastCount = n; if (n >= 1 && SND && SND.count) SND.count(n); }
  // Faces: blink now and then; after a goal the scorer smiles and the other one frowns for 3 s (S: cheer / sad).
  for (let i = 0; i < 2; i++) {
    const a = anim[i], p = rp[i];
    a.blink = ((now / 1000 + i * 1.7) % 3.4) < 0.12;
    if (now > moodUntil) a.mood = 0;
    if (p.mv && p.ground && !(p.kickMs >= 0 && p.kickMs < HS.KICK_MS)) a.run += dt * 0.06;   // their run steps stop during a kick
    // A new kick: the boot's target is where the ball is right now (S: kick() moves the boot to the ball).
    if (p.kickMs >= 0 && (a.kickMs < 0 || p.kickMs < a.kickMs)) {
      const dx = (rb.x - HS.KICK_AIM_X * (i === 0 ? 1 : -1)) - p.x, dy = (rb.y - HS.KICK_AIM_Y) - p.y;
      const near = Math.hypot(dx, dy) < HS.KICK_RANGE;
      a.kdx = near ? dx * (p.left ? -1 : 1) : 100; a.kdy = near ? dy : 100;
    }
    a.kickMs = p.kickMs;
  }
}

/* Which countdown number shows now: 3, 2, 1 through the 2.4 s, then 0 for 600 ms as play starts (S: doCountDown
   shows each number 600 ms after the last, the first 600 ms after the call). -1 for none. */
function countNumber(now) {
  if (phase === 'countdown' || phase === 'kickoff') {
    const k = Math.floor((now - countAt) / HS.COUNT_STEP_MS);
    return k >= 1 && k <= 3 ? 4 - k : -1;
  }
  if (phase === 'playing' && now - playAt < HS.COUNT_STEP_MS) return 0;
  return -1;
}

function draw(now) {
  const V = VIEW, d = V.dpr;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.fillStyle = '#1d2a44';
  ctx.fillRect(0, 0, V.w, V.h);
  if (!art.bg) return;
  ctx.setTransform(V.s * d, 0, 0, V.s * d, V.ox * d, V.oy * d);
  ctx.save();
  ctx.beginPath(); ctx.rect(-V.vw / 2, 0, V.vw, HS.VIEW_H); ctx.clip();
  art.field(ctx, now, now - goalAt < 4000);
  if (drawable) {
    // The other player first, so mine is on top where two heads meet.
    const first = mySeat === 1 ? 0 : 1;
    drawPlayer(first, now); drawPlayer(1 - first, now);
    art.ballAt(ctx, rb.x, rb.y, rb.rot, goldC >= 0 && (phase === 'playing' || phase === 'kickoff' || phase === 'goal' || phase === 'settling'));
    art.goalFronts(ctx);
    if (mySeat >= 0 && (phase === 'countdown' || (kickoffs === 1 && now - firstKickAt < 1500))) art.youMark(ctx, rp[mySeat].x, rp[mySeat].y, now);
  }
  if (match) {
    hud.digits = clockText;
    hud.score[0] = score[0]; hud.score[1] = score[1];
    hud.names[0] = match.names[0]; hud.names[1] = match.names[1];
    hud.mine = mySeat;
    const mineSide = mySeat >= 0 ? mySeat : 0;
    hud.hist[mineSide] = mySeat >= 0 ? series.mine : 0; hud.hist[1 - mineSide] = mySeat >= 0 ? series.theirs : 0;
    hud.plate = platesOn;
    hud.keys = !touchUI && !WATCH && canPlay();
    hud.scoreBig = (phase === 'settling' || (phase === 'over' && !overShown)) ? Math.max(1, now - whistleAt) : 0;
    hud.sudden = goldC >= 0 && now - goldenAt >= 2000 && (phase === 'kickoff' || phase === 'playing' || phase === 'goal');
    art.hudDraw(ctx, hud, now);
    const n = countNumber(now);
    if (n >= 0) art.countText(ctx, n, n === 0 ? now - playAt : (now - countAt) % HS.COUNT_STEP_MS);
    const gm = now - goalAt;
    if (gm >= 0 && gm < 3000) art.goalFlash(ctx, gm, goalGolden);
    else if (now - goldenAt < 2000) art.flashText(ctx, 'SUDDEN DEATH', now - goldenAt);
  }
  ctx.restore();
  // The phone buttons, in CSS pixels.
  if (touchUI && canPlay() && BTN) {
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const a = V.portrait ? 1 : 0.85;
    art.button(ctx, 'L', BTN.L, fingerOn('L') || !!(inp.held & IN.LEFT), d, a);
    art.button(ctx, 'R', BTN.R, fingerOn('R') || !!(inp.held & IN.RIGHT), d, a);
    art.button(ctx, 'K', BTN.K, fingerOn('K'), d, a);
    art.button(ctx, 'J', BTN.J, fingerOn('J'), d, a);
    if (V.portrait) art.note(ctx, 'Turn your phone sideways for a bigger pitch', V.w / 2, (sy(HS.VIEW_H) + BTN.L.y) / 2, 13);
  }
}

function drawPlayer(side, now) {
  const p = rp[side];
  p.side = side;
  art.player(ctx, p, anim[side], rb.x, now);
}

/* ── chat ──────────────────────────────────────────────────────────────────
   The one DuelSeries chat box (public/js/shared/dsChat.js): T to type, Enter to send. Only the two seated players
   can speak; a watcher reads. On a computer it sits bottom left on the grass, clear of the strip; on a phone, its
   button top left (under the pitch in portrait). A line takes its seat's kit colour. */
let chatLive = false;          // a match is on screen (not the wait card, not the result card)
const chat = DSChat.mount({
  send: (t) => { socket.emit('hs:chat', { text: t }); return true; },
  canSend: () => chatLive && !WATCH,
  pc: { left: 14, bottom: 120 },
  phoneAt: { left: 10, top: 70 },
});
function chatShow(on) { chatLive = on; chat.visible(on); }
socket.on('hs:chat', (m) => {
  if (!m) return;
  const mine = !WATCH && m.side === mySeat;
  chat.add({ name: m.name, color: m.side === 1 ? '#8db8ff' : '#ff8a80', text: m.text, me: mine });
});
socket.on('hs:chatnote', (m) => { if (m) chat.add({ kind: 'sys', text: m.text }); });

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

const cut = (s, n) => { const t = String(s || 'Player'); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/* A match comes on screen: from hs:start, or a watcher's hs:watching. Everything about the last one is dropped. */
function startMatch(m) {
  const players = m.players || [];
  mySeat = -1;
  if (!WATCH) { const p = players.find(q => q.id === me); mySeat = p ? (p.side === 1 ? 1 : 0) : -1; }
  const names = ['', ''];
  for (const p of players) if (p.side === 0 || p.side === 1) names[p.side] = cut(p.name, 16);
  if (m.vsBot && mySeat >= 0) names[1 - mySeat] = cut(names[1 - mySeat] || 'Opponent', 12) + ' (bot)';
  match = { id: m.id, vsBot: !!m.vsBot, players, names, stake: m.stake, pot: m.pot };
  const SK = window.DS_SHOP_SKINS;
  const cols = [null, null];
  for (const p of players) {
    const sk = SK && p.skin ? SK.byId(GAME, p.skin) : null;
    if (sk && sk.col && (p.side === 0 || p.side === 1)) cols[p.side] = sk.col;
  }
  art.setKits(cols);
  // Each seat's head: a free head's id rides as its skin (shared/hsHeads.js); anything else is the seat's own face.
  const HL = window.DS_HS_HEADS, heads = [null, null];
  for (const p of players) if ((p.side === 0 || p.side === 1) && HL && HL.byId(p.skin)) heads[p.side] = p.skin;
  art.setHeads(heads);
  score = Array.isArray(m.score) && m.score.length === 2 ? [m.score[0] | 0, m.score[1] | 0] : [0, 0];
  clockC = typeof m.msLeft === 'number' ? m.msLeft : HS.MATCH_MS; clockAt = performance.now(); clockShown = clockC;
  overShown = false; lastOver = null;
  phase = null; setPhase(m.state || 'countdown');
  if (m.state === 'countdown') countAt = performance.now() - Math.max(0, HS.COUNTDOWN_MS - (Number(m.phaseMs) || HS.COUNTDOWN_MS));
  goalAt = -1e9; goldenAt = -1e9; whistleAt = -1e9; playAt = -1e9; goalGolden = false; goldC = -1;
  kickoffs = m.state === 'countdown' ? 0 : 1; firstKickAt = -1e9;
  platesOn = m.state !== 'countdown';
  countAt = performance.now() - Math.max(0, HS.COUNTDOWN_MS - (Number(m.phaseMs) || HS.COUNTDOWN_MS)); lastCount = -1;
  for (const a of anim) { a.run = 0; a.kickMs = -1; a.mood = 0; }
  // The input starts again at nothing: a new room counts from zero.
  inp.held = 0; inp.jumps = 0; inp.kicks = 0; inp.powers = 0; seq = 0; hist.length = 0; baseAck = 0;
  downKeys.clear(); fingers.clear(); touchHeld = 0;
  predicting = false; frontier = 0; forceSnap = true;
  for (const o of off) { o.x = 0; o.y = 0; }
  haveBase = false; baseFresh = false; wbuf.length = 0; baseK = 0;
  if (m.snap) onSnap(m.snap);
  $('wait').hidden = true;
  chatShow(true);
}

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
  /* A reconnect while waiting takes the same seat back (the key the server sent with hs:queued): the same place,
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
   Cancel gives the buy-in back at once. The server sends the real numbers in hs:queued; the minute starts here so
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
socket.on('hs:queued', (q = {}) => {
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
  socket.emit('hs:queue', Object.assign({
    name: myName, wallet: myWallet,
    stake: myStake, entryToken: token || myEntryToken,
    resume: resume || undefined, head: myHead(),
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

socket.on('hs:start', (raw) => {
  if (!raw) return;
  stopWait();
  resumeKey = null;                        // the seat is a match now, not a place in the queue
  if (WATCH) { if (watchMatch) startMatch(fromWatch(raw)); return; }   // a watcher's matches come by hs:watching
  if (raw.vsBot) botNote();
  me = socket.id;
  matchAt = Date.now();
  startMatch(raw);
});

/* Play starts: at the whistle, and again after every goal with both players back on their spots and a new ball
   dropping from the middle. */
socket.on('hs:kickoff', (m) => {
  if (!match) return;
  const t = performance.now();
  if (m && Array.isArray(m.score)) score = [m.score[0] | 0, m.score[1] | 0];
  if (m && typeof m.msLeft === 'number') { clockC = m.msLeft; clockAt = t; }
  kickoffs++;
  if (kickoffs === 1) firstKickAt = t;
  setPhase('playing', t);
});

/* Back to the spots after a goal or the golden-goal call, and the countdown again. */
socket.on('hs:count', (m) => {
  if (!match) return;
  const t = performance.now();
  if (m && Array.isArray(m.score)) score = [m.score[0] | 0, m.score[1] | 0];
  if (m && typeof m.msLeft === 'number') { clockC = m.msLeft; clockAt = t; }
  forceSnap = true;                        // the jump back to the spots is a jump, not something to ease
  setPhase('kickoff', t);
});
socket.on('hs:golden', () => {
  if (!match) return;
  const t = performance.now();
  goldenAt = t; clockC = 0; clockAt = t; goldC = HS.GOLDEN_MAX_MS;
  setPhase('golden', t);
});

socket.on('hs:goal', (m) => {
  if (!match || !m) return;
  const t = performance.now();
  goalGolden = goldC >= 0;
  goalAt = t;
  if (Array.isArray(m.score)) score = [m.score[0] | 0, m.score[1] | 0];
  // S: responseAnimations: the scorer cheers, the other is sad, for 3 s.
  const sc = m.s === 1 ? 1 : 0;
  anim[sc].mood = 1; anim[1 - sc].mood = -1; moodUntil = t + 3000;
  setPhase('goal', t);
});

socket.on('hs:whistle', (m) => {
  if (!match) return;
  if (m && Array.isArray(m.score)) score = [m.score[0] | 0, m.score[1] | 0];
  whistleAt = performance.now();
  setPhase('settling');
});

socket.on('hs:over', (m) => {
  if (WATCH) { watchOver(m || {}); return; }
  if (overShown) return;
  overShown = true;
  setPhase('over');
  releaseAll();
  /* Whose result it is, read now: a reconnect while the card is up changes the socket id, and the card is drawn
     again on every restake step. */
  lastOver = Object.assign({}, m || {}, { ms: matchAt ? Date.now() - matchAt : 0, me, seat: mySeat });
  if (m && m.winnerId) { if (m.winnerId === me) series.mine++; else series.theirs++; }
  restake = null; restakeLine = '';
  paintOver();
  chatShow(false);
});

/* ── the result card ───────────────────────────────────────────────────────
   The one card every DuelSeries game ends on (public/js/shared/dsEnd.js). Every amount on it is the server's own
   figure from hs:over's `money` (server/duelMoney.js: the split index.js pays), only formatted here; nothing on
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
  socket.emit('hs:leave');
  dropMatch();
  queue(token);
}

/* A PAID PLAY AGAIN BUYS A NEW ENTRY. The one this page opened with was spent on the first queue, so asking again
   with it is refused. The lobby's wallet stakes the same rung (duel:restake, answered by
   wallet-widget/src/restakeBridge.mjs) and posts the fresh token back, which goes straight into hs:queue and is
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
socket.on('hs:unqueued', ({ refunded, why } = {}) => {
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

socket.on('hs:refused', ({ why } = {}) => {
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
   pitch plays out, and a seat the server is holding keeps waiting (it hears hs:unqueued if anything changes). When
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
  socket.emit(WATCH ? 'hs:unwatch' : 'hs:leave');
  /* The lobby hosts this in an iframe and listens for exactly this, same as the other games. Falls back to a normal
     navigation when opened directly. */
  if (window.parent && window.parent !== window) window.parent.postMessage('game:done', '*');
  else location.href = '/';
}
/* Cancel on a paid seat that is still waiting hands the buy-in back first and says so (hs:unqueued); the next press
   goes to the lobby. Leaving any other way refunds it too (hs:leave, or the page closing). */
$('waitCancel').addEventListener('click', () => {
  if (waiting && waitPaid && !match && !WATCH) {
    stopWait(); waitPaid = false; resumeKey = null;
    waitSpin(true);
    $('waitMain').textContent = 'Cancelling…';
    $('waitSub').textContent = 'Giving your buy-in back.';
    $('waitCancel').textContent = 'Back to the lobby';
    socket.emit('hs:unqueue');
    return;
  }
  toLobby();
});

/* SPECTATE, from a result card. The page reads its watch mark once, as it boots, so this does exactly what the
   lobby's Spectate does for this rung (public/js/v2/play.js spectate()): every money key out, the mark for this
   game, the rung in its own key for a paid table (dsWatchStake, never 'stake'), then this page again, which comes
   up watching that rung. Nothing here seats anybody or stakes anything. */
const WATCH_URL = '/headsoccer';
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
  socket.emit('hs:leave');
  reopen();
}

window.addEventListener('beforeunload', () => socket.emit(WATCH ? 'hs:unwatch' : 'hs:leave'));

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
  socket.emit('hs:watch', msg);
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

socket.on('hs:watching', (m) => {
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
  /* Next with only one match running comes back with the same one. The pitch on screen is that match, live. */
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
socket.on('hs:matches', ({ index, count } = {}) => {
  if (!WATCH || !watchMatch) return;
  if (Number.isFinite(index)) watchMatch.index = index;
  if (Number.isFinite(count)) watchMatch.count = count;
  publishWatch('watching');
});

/* The match went away without a result. On to the next at once. */
socket.on('hs:ended', ({ id } = {}) => {
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

/* What the match looks like right now, for a headless check (the same idea as window.__watch). Read only. */
window.__hs = () => ({
  phase, mySeat, score: score.slice(), clock: clockText, predicting, rtt: Math.round(rtt), touchUI,
  portrait: VIEW.portrait, over: overShown, waiting, seq, ack: baseAck, view: { s: VIEW.s, vw: VIEW.vw, ox: VIEW.ox, oy: VIEW.oy },
  me: mySeat >= 0 ? { x: rp[mySeat].x, y: rp[mySeat].y, kickMs: rp[mySeat].kickMs, ground: rp[mySeat].ground } : null,
  them: mySeat >= 0 ? { x: rp[1 - mySeat].x, y: rp[1 - mySeat].y } : null,
  ball: { x: rb.x, y: rb.y }, corr: off.map(o => Math.round(Math.hypot(o.x, o.y) * 10) / 10), server: haveBase ? { k: baseK, me: mySeat >= 0 ? base.p[mySeat].x : null, ball: base.ball.x } : null,
  buttons: BTN && touchUI ? JSON.parse(JSON.stringify(BTN)) : null,
});

/* ── boot ──────────────────────────────────────────────────────────────── */
if (SND) SND.attach(socket, () => ({ me, mySide: mySeat, watch: WATCH, ballX: rb.x }));
fit();
/* The canvas lettering (GOAL!, KICK OFF, the scores, the ad board) is Archivo's heavy italics: once they have
   loaded, the parts painted ahead of time are painted again with them. */
if (document.fonts && document.fonts.load) {
  Promise.all(['italic 900 40px Archivo', 'italic 800 25px Archivo', '800 14px Archivo', '700 16px Archivo', '700 40px "Sofia Sans Extra Condensed"']
    .map(f => document.fonts.load(f).catch(() => null)))
    .then(() => build(VIEW.s * VIEW.dpr));
}
requestAnimationFrame(frame);

if (WATCH) {
  document.body.classList.add('watching');
  $('wait').hidden = true;                 // the bar speaks for a watcher, from the first moment
  if (BAR) {
    BAR.open({ game: GAME, stake: WATCH_STAKE, onPrev: () => stepWatch('prev'), onNext: () => stepWatch('next'), onLobby: toLobby });
    BAR.watching('Finding a match');
    BAR.busy(true);
  }
  publishWatch('searching');
}
