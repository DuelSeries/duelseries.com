'use strict';
/* ─── 8 Ball Pool, the client ─────────────────────────────────────────────────
   One table, two players, turn by turn. This page draws the table
   (public/js/pool8/p8Art.js paints it), lets you aim, set spin, place a cue ball
   in hand and pull the power, and sends the server ONE message per shot: the
   angle, the power, the spin, where the cue ball was put and the pocket called
   for the 8.

   THE SERVER DECIDES. Where every ball goes, fouls, ball in hand, groups and who
   wins come from server/Pool8Room.js, which plays each shot through
   shared/pool8Sim.js and judges it with shared/pool8Rules.js. This page plays
   the server's tape back ball by ball; the only physics it runs is the aim
   guide's geometry (where the cue ball would first touch something).

   The shell around the match (the wait card, the bot note, the result card, the
   paid Play again, Spectate, chat, maintenance, the reconnect key) is Head
   Soccer's and Knockout's (public/js/headsoccer.js), behaviour for behaviour,
   with p8: event names. */

const socket = io();
const Sim = window.P8Sim;
const Art = window.P8Art;
const $ = (id) => document.getElementById(id);
const cv = $('table');
const ctx = cv.getContext('2d', { alpha: false });
const SND = window.Pool8Sound || null;
const GAME = 'pool8';
/* The free look picked in the lobby's Customize (shared/pool8Looks.js, stored under duel.pool8.look): my cloth on my
   screen, and my cue on every screen once the server has worn it (players[].skin). */
const LOOKS = window.DS_POOL8_LOOKS || null;
const myLook = (() => { try { return LOOKS ? LOOKS.byId(localStorage.getItem(LOOKS.KEY)) : null; } catch (_) { return null; } })();
let seatCue = [null, null];

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
    const shop = localStorage.getItem('duel.shop.pool8'), pass = localStorage.getItem('duel.skinpass');
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
let match = null;             // { id, vsBot, players, names, initials, stake, pot } while a match is on screen
let mySeat = -1;              // 0 or 1; -1 while watching
let phase = null;             // the server's state: countdown | aiming | rolling | settling | over
let phaseAt = 0;
let overShown = false;
// Wins this sitting, like rooftop.js. It was never declared, so every finished match threw at the result card and
// the table froze with no Lobby or Play again (site sweep 2026-10-28).
const series = { mine: 0, theirs: 0 };
let lastOver = null;          // the result on the card, with how long the match ran (ms)
let matchAt = 0;              // when this match started, for the card's Time
let restake = null;           // { nonce, slow } while a paid Play again is with the lobby's wallet
let restakeLine = '';         // a restake's error, said on the card
let restakeTimer = 0;
let score = [0, 0];           // each side's group balls potted, the card's score
let vsUntil = 0;              // the two player cards show until then

/* ── the table as shown ─────────────────────────────────────────────────── */
const view = [];              // per ball: { n, x, y, on, art, potAt, pocket, retIdx }
for (let n = 0; n < 16; n++) view.push({ n, x: 0, y: 0, on: false, art: Art.makeBall(n), potAt: -1, pocket: -1 });
const returned = [];          // the potted balls lined up in the ball-return rail, in the order they went down
const rules = { turn: 0, inHand: null, groups: [null, null], onEight: [false, false], broken: false, shots: 0 };
let turnEndsAt = 0, shotMs = 30000;
let tape = null;              // the shot being played: { at, by, ev, evI, dur, done }
let pendingTurn = null;       // a turn that arrived while a tape was still rolling
let banner = { text: '', until: 0 };

/* ── my shot ─────────────────────────────────────────────────────────────── */
const aim = { a: Math.PI, p: 0, spin: { x: 0, y: 0 }, call: null, called: false, cx: 0, cy: 0, placing: false, ok: true };
let opp = null;               // the shooter's aim on the other screen: { a, p, x, y, at }
let spinOpen = false;
let drag = null;              // { kind: 'pull' | 'bar' | 'cue' | 'turn' | 'fine', ... }
let aimSentAt = 0, aimDirty = false;

// Offline no shot is taken: the server holds the seat as it was (the seat hold below), so the screen does the same.
const myTurn = () => !WATCH && match && mySeat >= 0 && phase === 'aiming' && rules.turn === mySeat && !overShown && !tape && socket.connected;
const cueBall = () => view[0];

/* ── the transform ───────────────────────────────────────────────────────────
   The game is drawn in the reference's frame (Art.DESIGN), scaled to fit the window. A phone held upright gets the
   frame turned a quarter (rot), so the table fills the long side, the same as turning the phone. */
const D = Art.DESIGN;
let VIEW = { s: 1, ox: 0, oy: 0, dpr: 1, w: 0, h: 0, rot: false };
let tableCanvas = null, tableS = 0;
function fit() {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  const rot = h > w * 1.1;
  const fw = rot ? D.h : D.w, fh = rot ? D.w : D.h;
  const s = Math.min(w / fw, h / fh);
  VIEW = { s, dpr, w, h, rot, ox: (w - fw * s) / 2, oy: (h - fh * s) / 2 };
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  tableS = 0;
  placeOverlays();
}
window.addEventListener('resize', fit);
window.addEventListener('orientationchange', fit);
function base() {
  const d = VIEW.dpr;
  if (VIEW.rot) ctx.setTransform(0, 1, -1, 0, (VIEW.ox + D.h * VIEW.s) * d, VIEW.oy * d);
  else ctx.setTransform(1, 0, 0, 1, VIEW.ox * d, VIEW.oy * d);
}
// Screen (CSS px) to design units.
function toDesign(X, Y) {
  if (VIEW.rot) return { x: (Y - VIEW.oy) / VIEW.s, y: D.h - (X - VIEW.ox) / VIEW.s };
  return { x: (X - VIEW.ox) / VIEW.s, y: (Y - VIEW.oy) / VIEW.s };
}

function placeOverlays() {
  const top = VIEW.rot ? 0 : Math.round(VIEW.oy + (Art.LAYOUT.bar.h + 6) * VIEW.s);
  const note = $('botNote'); if (note) note.style.top = (top + 4) + 'px';
  const line = $('watchLine'); if (line) line.style.top = (top + 4) + 'px';
  if (typeof chat !== 'undefined' && chat && chat.el) {
    chat.el.style.setProperty('--dsc-t', (top + 8) + 'px');
    chat.el.style.setProperty('--dsc-b', '70px');
  }
}

/* ── what the server says about the table ──────────────────────────────── */
function setBalls(packed) {
  if (!Array.isArray(packed)) return;
  const wasOn = view.map(b => b.on);
  for (let i = 0; i + 3 < packed.length; i += 4) {
    const b = view[packed[i]];
    if (!b) continue;
    b.x = packed[i + 1] / 10; b.y = packed[i + 2] / 10; b.on = packed[i + 3] === 1;
    if (b.on) { b.potAt = -1; const r = returned.indexOf(b.n); if (r >= 0) returned.splice(r, 1); }
    else if (wasOn[b.n] !== false && b.n !== 0 && !returned.includes(b.n)) returned.push(b.n);
  }
  aim.cx = cueBall().x; aim.cy = cueBall().y;
  recount();
}
function recount() {
  for (let s = 0; s < 2; s++) {
    const g = rules.groups[s];
    if (!g) { score[s] = 0; continue; }
    score[s] = view.filter(b => !b.on && Sim.groupOf(b.n) === g).length;
  }
}
function setRules(r) {
  if (!r) return;
  rules.turn = r.turn === 1 ? 1 : 0;
  rules.inHand = r.inHand || null;
  rules.groups = Array.isArray(r.groups) ? r.groups.slice(0, 2) : [null, null];
  rules.onEight = Array.isArray(r.onEight) ? r.onEight.slice(0, 2) : [false, false];
  rules.broken = !!r.broken;
  rules.shots = r.shots | 0;
  if (typeof r.shotMs === 'number') shotMs = r.shotMs;
  if (typeof r.ms === 'number') turnEndsAt = performance.now() + r.ms;
  if (r.balls) setBalls(r.balls);
}

function setPhase(p) { phase = p; phaseAt = performance.now(); }

function startMatch(m, resumed) {
  const players = m.players || [];
  mySeat = -1;
  if (!WATCH) { const p = players.find(q => q.id === me); mySeat = p ? (p.side === 1 ? 1 : 0) : -1; }
  const names = ['', ''];
  for (const p of players) if (p.side === 0 || p.side === 1) names[p.side] = cut(p.name, 18);
  if (m.vsBot && mySeat >= 0) names[1 - mySeat] = cut(names[1 - mySeat] || 'Opponent', 13) + ' (bot)';
  const initials = names.map(n => (String(n).trim().charAt(0) || '?'));
  match = { id: m.id, vsBot: !!m.vsBot, players, names, initials, stake: m.stake, pot: m.pot };
  seatCue = [null, null];
  for (const p of players) { const lk = LOOKS && LOOKS.byId(p.skin); if (lk && (p.side === 0 || p.side === 1)) seatCue[p.side] = lk.cue; }
  overShown = false; lastOver = null;
  tape = null; pendingTurn = null; opp = null; drag = null; spinOpen = false;
  returned.length = 0;
  for (const b of view) { b.on = false; b.potAt = -1; b.art = Art.makeBall(b.n); }
  aim.spin.x = 0; aim.spin.y = 0; aim.call = null; aim.called = false; aim.p = 0;
  setRules(m.rules);
  setPhase(m.state || 'countdown');
  vsUntil = m.state === 'countdown' ? performance.now() + Math.max(0, Number(m.phaseMs) || 0) : 0;
  // The first aim: from the cue ball at the head ball.
  aimAtRack();
  if (resumed) { /* a seat back after a reconnect: the table as it is, no break banner */ }
  else if (rules.turn === mySeat && rules.inHand === 'kitchen') say('You are breaking, good luck!', 4000);
  else if (mySeat >= 0) say((match.names[rules.turn] || 'Opponent') + ' is breaking', 4000);
  myShots = 0; groupBanner = { text: '', at: -1e9 };
  $('wait').hidden = true;
  chatShow(true);
}

function aimAtRack() {
  const c = cueBall();
  let best = null;
  for (const b of view) if (b.on && b.n !== 0 && (!best || b.x < best.x)) best = b;
  if (best) aim.a = Math.atan2(best.y - c.y, best.x - c.x);
}

/* The black pill at the foot: one line at a time, a second one queued behind it ("<name> potted the cue ball", then
   "You have the ball in hand"). */
let sayNext = null;
function say(text, ms, then) {
  banner = { text, until: performance.now() + (ms || 3000) };
  sayNext = then || null;
}
let groupBanner = { text: '', at: -1e9 };

socket.on('p8:turn', (m) => {
  if (!match || !m) return;
  if (tape && !tape.done) { pendingTurn = m; return; }
  applyTurn(m);
});
/* A cue ball in hand that is not on the cloth (it went down) is put on the first free spot along the baulk line, the
   same spot the server would choose, so there is a ball to drag. */
function placeInHand() {
  const c = cueBall(), P8 = Sim.P8;
  if (!rules.inHand) return;
  const kitchen = rules.inHand === 'kitchen';
  if (c.on && Sim.placeOk(view, c.x, c.y, kitchen)) return;
  const hx = P8.HEAD_X * P8.L, cy = P8.W / 2;
  for (let k = 0; k < 24; k++) {
    const y = cy + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * P8.R * 2.2;
    if (Sim.placeOk(view, hx, y, kitchen)) { c.x = hx; c.y = y; c.on = true; c.potAt = -1; return; }
  }
  c.x = hx; c.y = cy; c.on = true; c.potAt = -1;
}

function applyTurn(m) {
  pendingTurn = null;
  setRules(m);
  placeInHand();
  setPhase('aiming');
  opp = null;
  aim.p = 0; aim.call = null; aim.called = false; aim.spin.x = 0; aim.spin.y = 0;
  const mine = rules.turn === mySeat;
  const nameOf = (s) => (s === mySeat ? 'You' : match.names[s] || 'Opponent');
  if (m.msg) {
    // The side that just played fouled: what they did, then who has the ball in hand.
    const by = 1 - rules.turn, you = by === mySeat;
    const what = m.msg === 'Time ran out' ? (you ? 'You ran out of time' : nameOf(by) + ' ran out of time')
      : m.msg === 'The cue ball was potted' ? nameOf(by) + ' potted the cue ball'
      : m.msg === 'No ball was hit' ? nameOf(by) + (you ? ' did not hit a ball' : ' did not hit a ball')
      : m.msg === 'The wrong ball was hit first' ? nameOf(by) + ' hit the wrong ball first'
      : m.msg === 'No ball hit a cushion' ? 'No ball hit a cushion' : m.msg;
    say(what, 1900, { text: mine ? 'You have the ball in hand' : nameOf(rules.turn) + ' has the ball in hand', ms: 2400 });
  } else if (mySeat >= 0) {
    say(mine ? 'It\u2019s your turn.' : nameOf(rules.turn) + '\u2019s turn', 1800);
  }
  if (mine && rules.onEight[mySeat]) say('Pick a pocket for the 8 ball', 3000);
  else if (mine && rules.inHand === 'table' && !m.msg) say('Drag to place the white ball.', 2600);
  if (SND && mine) SND.play('turn', 1);
}

socket.on('p8:aim', (m) => {
  if (!match || !m || myTurn()) return;
  opp = { a: Number(m.a) || 0, p: Number(m.p) || 0, at: performance.now() };
  if (typeof m.x === 'number' && typeof m.y === 'number') { cueBall().x = m.x; cueBall().y = m.y; cueBall().on = true; }
});

socket.on('p8:timeout', (m) => {
  if (!match || !m) return;
  if (SND) SND.play('foul', 1);
});

/* A shot: the server's tape, played back ball by ball, and the verdict once the balls stop. */
socket.on('p8:shot', (m) => {
  if (!match || !m || !m.tape) return;
  drag = null; spinOpen = false;
  const c = cueBall();
  if (m.cue) { c.x = m.cue.x; c.y = m.cue.y; c.on = true; }
  tape = { at: performance.now() + 160, by: Sim.indexTape(m.tape.kf || []), ev: m.ev || [], evI: 0,
           dur: m.tape.dur | 0, done: false, m, a: m.shot ? m.shot.a : aim.a, p: m.shot ? m.shot.p : 0.5, shooter: m.shooter };
  setPhase('rolling');
  opp = null;
});

function finishTape(now) {
  const m = tape.m;
  tape.done = true;
  const hadGroups = !!rules.groups[0];
  rules.groups = Array.isArray(m.groups) ? m.groups.slice(0, 2) : rules.groups;
  if (!hadGroups && rules.groups[0]) {
    const g = (s) => (rules.groups[s] === 'solids' ? 'Solids' : 'Stripes');
    groupBanner = { text: mySeat >= 0 ? 'You are ' + g(mySeat) + '!' : (match.names[m.shooter] || 'Player') + ' is ' + g(m.shooter), at: now };
  }
  setBalls(m.balls);
  if (m.pots && m.pots.length && !m.foul && mySeat >= 0 && m.groups && m.groups[m.shooter] && !rules._said) { /* nothing more to say */ }
  if (m.over) {
    const w = m.over.winnerSide;
    say(mySeat < 0 ? (match.names[w] || 'Player') + ' wins' : w === mySeat ? 'You win!' : (match.names[w] || 'Opponent') + ' wins', 4000);
    setPhase('settling');
  }
  tape = null;
  if (pendingTurn) applyTurn(pendingTurn);
}

/* ── input ────────────────────────────────────────────────────────────────────
   PC: the cue follows the mouse; press, drag back and let go to shoot (the power is how far back). The wheel or the
   arrow keys turn the aim a little at a time. Phone: drag on the table to turn the aim around the cue ball, tap a
   ball to aim at it, the strip on the right edge turns it finely, and the power bar on the left is pulled down and
   let go. Both: the cue ball button sets spin, a cue ball in hand is dragged where you want it, and on the 8 you
   tap the pocket you are calling. */
const L = Art.LAYOUT;
const COARSE = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch (_) { return false; } })();
const PULL_FULL = 500;        // px of drag back for full power with the mouse (the reference's longest measured pull)
/* How far the cue tip sits back from its rest for a power (MEASURED: 26 px from the ball's centre at rest, 61, 97, 126,
   135 and 161 px for pulls of 96 to 500 px; this curve fits within 15 px). */
const pullOf = (p) => 135 * Math.pow(Math.max(0, Math.min(1, p)), 0.6);
function inRect(p, r, pad) { pad = pad || 0; return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad; }
function cueDesign() { const c = cueBall(); return { x: Art.tx(c.x), y: Art.ty(c.y) }; }
function pocketAt(p) {
  for (let i = 0; i < Sim.POCKETS.length; i++) {
    const q = Sim.POCKETS[i];
    if (Math.hypot(p.x - Art.tx(q.x), p.y - Art.ty(q.y)) < q.r * Art.k * 1.6 + 10) return i;
  }
  return -1;
}
function aimToward(p) {
  const c = cueDesign();
  if (Math.hypot(p.x - c.x, p.y - c.y) < 4) return;
  aim.a = Math.atan2(p.y - c.y, p.x - c.x);
  aimDirty = true;
}
function setSpin(p, pk) {
  let x = (p.x - pk.cx) / pk.r, y = -(p.y - pk.cy) / pk.r;
  const l = Math.hypot(x, y);
  if (l > 1) { x /= l; y /= l; }
  aim.spin.x = Math.round(x * 100) / 100; aim.spin.y = Math.round(y * 100) / 100;
}
let picker = null;

cv.addEventListener('pointerdown', (e) => {
  if (SND) SND.unlock();
  const p = toDesign(e.clientX, e.clientY);
  const touch = e.pointerType === 'touch';
  if (spinOpen) {
    if (picker && Math.hypot(p.x - picker.cx, p.y - picker.cy) <= picker.R) { setSpin(p, picker); drag = { kind: 'spin', id: e.pointerId }; }
    else spinOpen = false;
    return;
  }
  if (Math.hypot(p.x - L.menu.x - L.menu.w / 2, p.y - L.menu.y - L.menu.h / 2) < L.menu.w * 0.7) { pauseMenu(); return; }
  if (!myTurn()) return;
  if (Math.hypot(p.x - L.spin.x, p.y - L.spin.y) < L.spin.r * 1.3) { spinOpen = true; return; }
  if (touch && inRect(p, L.power, 14)) {
    drag = { kind: 'bar', id: e.pointerId };
    aim.p = Math.max(0, Math.min(1, (p.y - L.power.y - 10) / (L.power.h - 20)));
    cv.setPointerCapture(e.pointerId);
    return;
  }
  const c = cueDesign(), R = Sim.P8.R * Art.k;
  if (rules.inHand && Math.hypot(p.x - c.x, p.y - c.y) < R * (touch ? 2.6 : 1.6)) {
    drag = { kind: 'cue', id: e.pointerId, dx: c.x - p.x, dy: c.y - p.y };
    aim.placing = true;
    cv.setPointerCapture(e.pointerId);
    return;
  }
  if (rules.onEight[mySeat]) {
    const k = pocketAt(p);
    if (k >= 0) { aim.call = k; aim.called = true; if (SND) SND.play('tick', 1); return; }
  }
  if (touch) {
    if (inRect(p, L.fine, 12)) { drag = { kind: 'fine', id: e.pointerId, y: p.y }; cv.setPointerCapture(e.pointerId); return; }
    drag = { kind: 'turn', id: e.pointerId, at: performance.now(), x0: p.x, y0: p.y, last: Math.atan2(p.y - c.y, p.x - c.x), moved: 0 };
    cv.setPointerCapture(e.pointerId);
    return;
  }
  // The mouse: the aim locks where it is, and the drag back is the power.
  aimToward(p);
  drag = { kind: 'pull', id: e.pointerId, x0: p.x, y0: p.y };
  cv.setPointerCapture(e.pointerId);
});

cv.addEventListener('pointermove', (e) => {
  const p = toDesign(e.clientX, e.clientY);
  if (drag && drag.id !== e.pointerId) return;
  if (drag && drag.kind === 'spin') { setSpin(p, picker); return; }
  if (!myTurn()) { drag = null; return; }
  if (!drag) return;
  if (drag.kind === 'bar') {
    aim.p = Math.max(0, Math.min(1, (p.y - L.power.y - 10) / (L.power.h - 20)));
  } else if (drag.kind === 'pull') {
    const ux = Math.cos(aim.a), uy = Math.sin(aim.a);
    const back = -((p.x - drag.x0) * ux + (p.y - drag.y0) * uy);
    aim.p = Math.max(0, Math.min(1, back / PULL_FULL));
  } else if (drag.kind === 'cue') {
    const kitchen = rules.inHand === 'kitchen';
    let x = Art.fx(p.x + drag.dx), y = Art.fy(p.y + drag.dy);
    const P8 = Sim.P8;
    x = Math.max(P8.R, Math.min((kitchen ? P8.HEAD_X * P8.L : P8.L - P8.R), x));
    y = Math.max(P8.R, Math.min(P8.W - P8.R, y));
    const c = cueBall();
    c.x = x; c.y = y; c.on = true;
    aim.ok = Sim.placeOk(view, x, y, kitchen);
    aimDirty = true;
  } else if (drag.kind === 'turn') {
    const c = cueDesign();
    const ang = Math.atan2(p.y - c.y, p.x - c.x);
    let d = ang - drag.last;
    if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
    drag.last = ang;
    drag.moved += Math.abs(d);
    // Turning slows down close to the cue ball, where a finger's move is a big angle.
    const near = Math.hypot(p.x - c.x, p.y - c.y);
    aim.a += d * Math.min(1, near / 160);
    aimDirty = true;
  } else if (drag.kind === 'fine') {
    aim.a += (p.y - drag.y) * 0.0016;
    drag.y = p.y;
    aimDirty = true;
  }
});

function endDrag(e, cancel) {
  if (!drag || drag.id !== e.pointerId) return;
  const d = drag;
  drag = null;
  if (d.kind === 'spin') return;
  if (d.kind === 'cue') { aim.placing = false; return; }
  if (d.kind === 'turn') {
    const p = toDesign(e.clientX, e.clientY);
    // A tap (no turn, no travel): aim at the point tapped.
    if (d.moved < 0.02 && Math.hypot(p.x - d.x0, p.y - d.y0) < 8 && performance.now() - d.at < 400) aimToward(p);
    return;
  }
  if ((d.kind === 'bar' || d.kind === 'pull') && !cancel && myTurn() && aim.p >= 0.02) shoot();
  else aim.p = 0;
}
cv.addEventListener('pointerup', (e) => endDrag(e, false));
cv.addEventListener('pointercancel', (e) => endDrag(e, true));
cv.addEventListener('wheel', (e) => {
  if (!myTurn()) return;
  e.preventDefault();
  aim.a += Math.sign(e.deltaY) * (e.shiftKey ? 0.0175 : 0.0026);
  aimDirty = true;
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  // Escape asks "Leave the match?", as in Rooftop Snipers and Air Hockey (site sweep 2026-10-28).
  // An Escape that just closed DSDialog arrives here marked defaultPrevented: without this check the closed
  // "Leave the match?" opened again at once and Esc could never dismiss it (site sweep 2026-10-28).
  if (e.code === 'Escape' && match && !overShown && !e.defaultPrevented) { pauseMenu(); return; }
  if (!myTurn()) return;
  if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') { aim.a -= e.shiftKey ? 0.0175 : 0.0026; aimDirty = true; e.preventDefault(); }
  if (e.code === 'ArrowRight' || e.code === 'ArrowDown') { aim.a += e.shiftKey ? 0.0175 : 0.0026; aimDirty = true; e.preventDefault(); }
});

function releaseAll() { drag = null; aim.p = 0; spinOpen = false; }
window.addEventListener('blur', releaseAll);

function shoot() {
  const c = cueBall();
  if (rules.inHand && !Sim.placeOk(view, c.x, c.y, rules.inHand === 'kitchen')) {
    say('The cue ball cannot go there', 1800);
    aim.p = 0;
    return;
  }
  const msg = { a: aim.a, p: aim.p, sx: aim.spin.x, sy: aim.spin.y };
  if (rules.inHand) { msg.x = c.x; msg.y = c.y; }
  if (rules.onEight[mySeat]) msg.call = aim.call === null ? autoCall() : aim.call;
  socket.emit('p8:shot', msg);
  myShots++;
  // Played as soon as the server's tape arrives; until then the cue stays drawn back.
}

/* The pocket the 8 would go toward on this aim (when nobody has tapped one). */
function autoCall() {
  const c = cueBall();
  const g = Sim.aimGuide(view, c.x, c.y, aim.a);
  const e = view[8];
  let ox = Math.cos(aim.a), oy = Math.sin(aim.a), fromX = c.x, fromY = c.y;
  if (g.kind === 'ball' && g.n === 8) { ox = g.ox; oy = g.oy; fromX = e.x; fromY = e.y; }
  let best = 0, bd = Infinity;
  for (let i = 0; i < Sim.POCKETS.length; i++) {
    const q = Sim.POCKETS[i];
    const vx = q.x - fromX, vy = q.y - fromY, along = vx * ox + vy * oy;
    if (along <= 0) continue;
    const off = Math.abs(vx * oy - vy * ox);
    if (off < bd) { bd = off; best = i; }
  }
  return best;
}

function sendAim(now) {
  if (!myTurn() || !aimDirty || now - aimSentAt < 100) return;
  aimDirty = false; aimSentAt = now;
  const c = cueBall();
  const m = { a: Math.round(aim.a * 1000) / 1000, p: Math.round(aim.p * 100) / 100 };
  if (rules.inHand) { m.x = Math.round(c.x); m.y = Math.round(c.y); }
  socket.volatile.emit('p8:aim', m);
}

/* ── the loop ─────────────────────────────────────────────────────────────── */
let lastFrame = performance.now();
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  update(now, dt);
  draw(now);
}

function update(now) {
  if (tape && !tape.done) {
    const t = now - tape.at;
    for (const n in tape.by) {
      const b = view[n];
      const pos = Sim.posAt(tape.by[n], Math.max(0, t));
      if (!pos) continue;
      if (t >= 0) Art.roll(b.art, pos.x - b.x, pos.y - b.y);
      b.x = pos.x; b.y = pos.y;
    }
    // Sounds, and balls dropping, as their moment comes.
    while (tape.evI < tape.ev.length && tape.ev[tape.evI] <= t) {
      const i = tape.evI;
      const kind = tape.ev[i + 1], a = tape.ev[i + 2], bb = tape.ev[i + 3], v = tape.ev[i + 4];
      if (kind === 4) {
        const b = view[a];
        b.potAt = now; b.pocket = bb;
        if (a !== 0 && !returned.includes(a)) returned.push(a);
      }
      if (SND) SND.play(kind === 1 ? 'cue' : kind === 2 ? 'ball' : kind === 3 ? 'rail' : 'pocket', kind === 1 ? v / 100 : Math.min(1, v / 1500));
      tape.evI += 5;
    }
    if (t >= tape.dur + 120) finishTape(now);
  }
  if (myTurn() && rules.onEight[mySeat] && !aim.called) aim.call = autoCall();
  sendAim(now);
}

function draw(now) {
  const d = VIEW.dpr, s = VIEW.s * d;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = Art.C.bg;
  ctx.fillRect(0, 0, cv.width, cv.height);
  base();
  if (!tableCanvas || tableS !== s) {
    tableCanvas = tableCanvas || document.createElement('canvas');
    tableCanvas.width = Math.ceil(D.w * s); tableCanvas.height = Math.ceil(D.h * s);
    Art.paintTable(tableCanvas.getContext('2d'), s, WATCH ? null : myLook);
    tableS = s;
    for (const b of view) b.art.dirty = true;
  }
  ctx.drawImage(tableCanvas, 0, 0);
  if (!match) { drawIdle(s); return; }

  // Potted balls in the return rail, bottom first.
  for (let i = 0; i < returned.length; i++) {
    const b = view[returned[i]];
    if (b.potAt > 0 && now - b.potAt < 260) continue;
    const at = Art.retPos(i);
    Art.drawBall(ctx, b.art, at.x, at.y, s);
  }

  // Shadows, then balls.
  for (const b of view) if (b.on && b.potAt < 0) Art.drawShadow(ctx, Art.tx(b.x), Art.ty(b.y), s);
  for (const b of view) {
    if (b.potAt > 0) {
      // Dropping: shrinks into the pocket for a quarter of a second.
      const f = (now - b.potAt) / 260;
      if (f < 1 && tape) {
        ctx.save();
        const x = Art.tx(b.x) * s, y = Art.ty(b.y) * s;
        ctx.translate(x, y); ctx.scale(1 - f * 0.55, 1 - f * 0.55); ctx.translate(-x, -y);
        Art.drawBall(ctx, b.art, Art.tx(b.x), Art.ty(b.y), s, 1 - f * 0.7);
        ctx.restore();
      }
      continue;
    }
    if (!b.on) continue;
    Art.drawBall(ctx, b.art, Art.tx(b.x), Art.ty(b.y), s);
  }

  const c = cueBall(), cd = cueDesign();
  const mine = myTurn();
  // The aim: mine while it is my turn, the shooter's (as sent) on everybody else's screen.
  if (phase === 'aiming' && !tape && c.on && performance.now() >= vsUntil) {
    const a = mine ? aim.a : opp ? opp.a : null;
    if (a !== null) {
      const gd = Sim.aimGuide(view, c.x, c.y, a);
      const warn = gd.kind === 'ball' && !legalFirst(gd.n, rules.turn);
      if (mine || opp) Art.drawGuide(ctx, cd.x, cd.y, gd, s, warn);
      const pull = pullOf(mine ? aim.p : opp ? opp.p : 0);
      if (!(mine && aim.placing)) Art.drawCue(ctx, cd.x, cd.y, a, pull, s, seatCue[rules.turn]);
    }
    if (mine && rules.inHand) Art.drawInHand(ctx, cd.x, cd.y, s, Sim.placeOk(view, c.x, c.y, rules.inHand === 'kitchen'));
    if (rules.onEight[rules.turn] && mine && aim.call !== null) Art.drawCall(ctx, aim.call, s, (Math.sin(now / 160) + 1) / 2);
  }
  // The strike: the cue thrusts through the cue ball and fades as the tape begins.
  if (tape && !tape.done) {
    const t = now - tape.at + 160;
    if (t < 260) {
      const k0 = Math.min(1, t / 160);
      const start = cueStart || { x: cd.x, y: cd.y };
      ctx.globalAlpha = 1 - Math.max(0, (t - 160) / 100);
      Art.drawCue(ctx, start.x, start.y, tape.a, pullOf(tape.p) * (1 - k0) - k0 * 14, s, seatCue[tape.shooter]);
      ctx.globalAlpha = 1;
    }
  } else cueStart = { x: cd.x, y: cd.y };

  if (COARSE) Art.drawFine(ctx, mine ? aim.a : 0, s);
  // The power bar (mine while it is my turn, theirs as they pull).
  if (COARSE) Art.drawPower(ctx, mine ? aim.p : opp && phase === 'aiming' ? opp.p : 0, s, mine);

  // The top bar.
  const active = phase === 'aiming' && !tape ? rules.turn : -1;
  const potted = [[], []];
  for (let side = 0; side < 2; side++) for (const b of view) if (!b.on && b.n > 0 && b.n !== 8) potted[side].push(b.n);
  Art.drawBar(ctx, {
    names: match.names, initials: match.initials, active,
    timeFrac: active >= 0 ? (turnEndsAt - now) / shotMs : -1,
    groups: rules.groups, potted: potted[0], spin: aim.spin,
    late: active >= 0 && turnEndsAt - now < 7000 && turnEndsAt - now > 0,
  }, s);
  if (groupBanner.text && now - groupBanner.at < 2200) Art.drawBanner(ctx, groupBanner.text, s, Math.min(1, (2200 - (now - groupBanner.at)) / 400));

  // Words: the hint under the bar on my turn, the message box at the foot.
  // The reference's first-turn tutorial lines (until the first shot you take in a match).
  if (mine && !spinOpen && myShots === 0) {
    if (COARSE) Art.drawHint(ctx, 'To apply power to the cue', s, 'Pull the power bar down and let go');
    else Art.drawHint(ctx, 'To apply power to the cue', s, 'Press button, drag mouse, and release');
  }
  if (banner.text && now >= banner.until && sayNext) { const n = sayNext; say(n.text, n.ms); }
  if (banner.text && now < banner.until) Art.drawMsg(ctx, banner.text, s, Math.min(1, (banner.until - now) / 300));

  if (spinOpen) picker = Art.drawSpinPicker(ctx, aim.spin, s);
  if (now < vsUntil) {
    const f = 1 - (vsUntil - now) / 3000;
    Art.drawVS(ctx, match.names, match.initials, match.stake > 0 ? '$' + Number(match.stake).toFixed(2) : 'FREE GAME', Math.max(0, f), s);
  }
}
let cueStart = null;
let myShots = 0;              // shots I have taken this match (the tutorial lines show until the first)

/* May the shooter hit this ball first? (red guide circle when not) */
function legalFirst(n, side) {
  if (!rules.broken) return true;
  const g = rules.groups[side];
  if (!g) return n !== 8;
  if (rules.onEight[side]) return n === 8;
  return Sim.groupOf(n) === g;
}

// Before a match: the empty table.
function drawIdle(s) {
  if (COARSE) Art.drawPower(ctx, 0, s, false);
}

/* The menu button: an online match cannot stop, so it offers the way out (the same leave as the lobby's). */
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
/* ── chat ──────────────────────────────────────────────────────────────────
   The one DuelSeries chat box (public/js/shared/dsChat.js): T to type, Enter to send. Only the two seated players
   can speak; a watcher reads. On a computer it sits bottom left on the grass, clear of the strip; on a phone, its
   button top left (under the pitch in portrait). A line takes its seat's kit colour. */
let chatLive = false;          // a match is on screen (not the wait card, not the result card)
const chat = DSChat.mount({
  send: (t) => { socket.emit('p8:chat', { text: t }); return true; },
  canSend: () => chatLive && !WATCH,
  pc: { left: 14, bottom: 120 },
  phoneAt: { left: 10, top: 70 },
});
function chatShow(on) { chatLive = on; chat.visible(on); }
socket.on('p8:chat', (m) => {
  if (!m) return;
  const mine = !WATCH && m.side === mySeat;
  chat.add({ name: m.name, color: m.side === 1 ? '#8db8ff' : '#ff8a80', text: m.text, me: mine });
});
socket.on('p8:chatnote', (m) => { if (m) chat.add({ kind: 'sys', text: m.text }); });

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

/* Every connect, the first and every reconnect after it: a seat, or in watch mode a match to watch. The server
   forgets a watcher whose socket dropped, so a reconnect asks again rather than assuming it is still on the list. */
socket.on('connect', () => {
  if (WATCH) { me = null; swapping = false; watch(null); return; }
  me = socket.id;
  /* The result card is up: it stays, and Play again queues from it. */
  if (overShown) return;
  /* A match this socket was in: the server holds the seat for five seconds and the seat's key takes it back
     (p8:rejoined below). Without a key, or too late, the drop was a walk-out (it forfeits on the server). */
  if (match && seatHold && seatHold.rejoin()) return;
  if (match) dropMatch();
  /* A reconnect while waiting takes the same seat back (the key the server sent with hs:queued): the same place,
     the same minute, and for a paid seat the same buy-in, with no new token. */
  if (waiting && resumeKey) { queue(null, resumeKey); return; }
  queue();
});

/* THE SEAT HOLD (public/js/shared/dsSeatHold.js, server/KnockoutLobby.js drop / rejoin): a connection that blinks
   mid-match keeps its seat for five seconds while the match runs on (the shot clock too); "Reconnecting..." on the
   small pill meanwhile, and the other player and watchers are told the same. */
const seatHold = window.DSSeatHold ? window.DSSeatHold.create({
  socket, ev: 'p8', watch: WATCH, pill: $('botNote'), line: $('watchLine'),
  live: () => !!match && !overShown, nameOf: (s) => match && match.names[s], mySeat: () => mySeat,
}) : null;
// The seat back on this socket: the table as the server has it now.
socket.on('p8:rejoined', (m) => {
  if (WATCH || !m || !match || overShown) return;
  if (seatHold) seatHold.back();
  me = socket.id;
  startMatch(m, true);
});
socket.on('p8:rejoinfail', (m) => {
  if (WATCH) return;
  if (seatHold) seatHold.done();
  if (overShown || !match) return;
  /* The match ended while the link was down (it was decided, or the five seconds ran out): its own result card, read
     with the id the seat had in it. */
  if (m && m.over && typeof m.you === 'string') { showOver(m.over, m.you); return; }
  dropMatch();
  if (waiting && resumeKey) { queue(null, resumeKey); return; }
  queue();
});

function dropMatch() {
  // A match dropped before its result is a walk-out (the server forfeits it); after the card it is nothing.
  trackStep('end', { result: 'left', reason: 'disconnected' });
  match = null; mySeat = -1; phase = null; tape = null; pendingTurn = null; opp = null;
  releaseAll();
}

/* THE WAIT (Owen 2026-10-21). A minute, counted down on screen, and the screen says what happens at 0:00 before
   it happens: a free table plays a bot, a paid one keeps looking for a person (a bot cannot cover a stake) and
   Cancel gives the buy-in back at once. The server sends the real numbers in hs:queued; the minute starts here so
   the clock is up before the answer. */
const WAIT_MS = window.DS_DUEL_WAIT_MS;   // shared/duelWait.js, the server's number too
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
function stopWait() {
  waiting = false;
  clearInterval(waitTimer);
}
socket.on('p8:queued', (q = {}) => {
  if (WATCH || match) return;              // matched already: the wait card is not coming back
  queuedOk = true;
  if (typeof q.resumeKey === 'string') resumeKey = q.resumeKey;
  const total = Number(q.waitMs) > 0 ? Number(q.waitMs) : WAIT_MS;
  startWait(total - (Number(q.waitingMs) || 0), total);
  trackStep('queue');
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
  socket.emit('p8:queue', Object.assign({
    name: myName, wallet: myWallet,
    stake: myStake, entryToken: token || myEntryToken, look: myLook ? myLook.id : undefined,
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

socket.on('p8:start', (raw) => {
  if (!raw) return;
  stopWait();
  resumeKey = null;                        // the seat is a match now, not a place in the queue
  if (seatHold) seatHold.done();                   // this match's seat key follows in p8:seat
  if (WATCH) { if (watchMatch) startMatch(fromWatch(raw)); return; }   // a watcher's matches come by hs:watching
  if (raw.vsBot) botNote();
  me = socket.id;
  matchAt = Date.now();
  startMatch(raw);
  trackStep('start', { vs_bot: !!raw.vsBot, room: raw.id });
});

socket.on('p8:over', (m) => {
  if (seatHold) seatHold.done();
  if (WATCH) { watchOver(m || {}); return; }
  showOver(m, me);
});
// who: the id this seat has in the result (this socket's, or the one it had before a reconnect: p8:rejoinfail).
function showOver(m, who) {
  if (overShown) return;
  overShown = true;
  setPhase('over');
  releaseAll();
  /* Whose result it is, read now: a reconnect while the card is up changes the socket id, and the card is drawn
     again on every restake step. */
  lastOver = Object.assign({}, m || {}, { ms: matchAt ? Date.now() - matchAt : 0, me: who, seat: mySeat, vsBot: !!(match && match.vsBot) });   // the card names the bot as a bot (site sweep 2026-10-28)
  if (m && m.winnerId) { if (m.winnerId === who) series.mine++; else series.theirs++; }
  restake = null; restakeLine = '';
  paintOver();
  chatShow(false);
  // The score is my balls potted.
  const sc = Array.isArray(lastOver.score) && lastOver.score.length === 2 ? lastOver.score : score;
  trackStep('end', { result: trackResult(lastOver.winnerId ? lastOver.winnerId === who : null, lastOver.why),
    score: sc[lastOver.seat === 1 ? 1 : 0] | 0, reason: lastOver.why });
}

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
      /* The seat's own figure; the table's rung if the seat is somehow missing. */
      card.hero = DSEnd.usd(-(seat ? seat.stakeMicro : Math.round((Number(m.stake) || 0) * 1e6)));
      card.unit = 'lost';
    }
    card.facts = [['Balls potted', result]];
    if (time) card.facts.push(['Time', time]);
  } else {
    card.hero = result;
    card.unit = 'balls potted';
    card.facts = time ? [['Time', time]] : [];
  }
  if (m.why === 'opponent left') card.notes.push('They left the match.');
  else if (m.why && m.why !== 'potted the 8') card.notes.push(sentence((m.winnerId === m.me ? 'They ' : 'You ') + m.why));

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
  socket.emit('p8:leave');
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
socket.on('p8:unqueued', ({ refunded, why } = {}) => {
  if (WATCH || match) return;
  /* A free seat whose match could not start: said, with the way back, rather than a clock that runs out. */
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

socket.on('p8:refused', ({ why } = {}) => {
  /* Every refusal says something. A silent one is indistinguishable from a control that does not work. Out of a
     match it is the seat that was refused (a buy-in the server would not take), said on the wait card. */
  if (WATCH || match) return;
  /* A paid reconnect whose seat could not be taken back (the server restarted, say): never "unpaid", because it
     was paid; a seat the server lost is refunded by the server. */
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
  socket.emit(WATCH ? 'p8:unwatch' : 'p8:leave');
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
    socket.emit('p8:unqueue');
    return;
  }
  toLobby();
});

/* SPECTATE, from a result card. The page reads its watch mark once, as it boots, so this does exactly what the
   lobby's Spectate does for this rung (public/js/v2/play.js spectate()): every money key out, the mark for this
   game, the rung in its own key for a paid table (dsWatchStake, never 'stake'), then this page again, which comes
   up watching that rung. Nothing here seats anybody or stakes anything. */
const WATCH_URL = '/pool8';
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
  socket.emit('p8:leave');
  reopen();
}

window.addEventListener('beforeunload', () => socket.emit(WATCH ? 'p8:unwatch' : 'p8:leave'));

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
  socket.emit('p8:watch', msg);
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

socket.on('p8:watching', (m) => {
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
socket.on('p8:matches', ({ index, count } = {}) => {
  if (!WATCH || !watchMatch) return;
  if (Number.isFinite(index)) watchMatch.index = index;
  if (Number.isFinite(count)) watchMatch.count = count;
  publishWatch('watching');
});

/* The match went away without a result. On to the next at once. */
socket.on('p8:ended', ({ id } = {}) => {
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
window.__p8 = () => ({
  phase, mySeat, over: overShown, waiting, rules: JSON.parse(JSON.stringify(rules)), aim: { a: aim.a, p: aim.p, spin: aim.spin, call: aim.call },
  balls: view.map(b => ({ n: b.n, x: Math.round(b.x), y: Math.round(b.y), on: b.on })), rolling: !!tape, view: VIEW, names: match ? match.names : null,
});

/* ── boot ──────────────────────────────────────────────────────────────── */
fit();
if (document.fonts && document.fonts.load) {
  Promise.all(['800 19px Archivo', '900 42px Archivo'].map(f => document.fonts.load(f).catch(() => null)))
    .then(() => { tableS = 0; for (const b of view) b.art.dirty = true; });
}
// The ping and FPS readout every game shares (public/js/shared/dsPerfHud.js), timed on this socket.
if (window.DSPerfHud) window.DSPerfHud.mount({ socket });
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
