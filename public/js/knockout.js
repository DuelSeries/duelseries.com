'use strict';
/* ─── Knockout, the client ────────────────────────────────────────────────────
   Draws the disc, lets you drag an arrow out of each of your pieces, and plays
   back the tape the server sends when the turn resolves.

   IT DECIDES NOTHING. Every position on screen came from the server: either the
   board in a state message, or a frame of the resolution tape. The client never
   runs the physics, never works out what hit what, and never knows where a
   piece will end up before the server has already decided. That is the same
   arrangement the artillery duel uses, and on a product that will eventually
   pay out it is the only defensible one.

   WORLD UNITS IN, PIXELS OUT. The server talks in a fixed world where the disc
   starts at radius 420; this file owns the one transform that turns that into
   whatever screen is in front of it. Everything below the transform is in world
   units, which is what lets a phone and a desktop play exactly the same game —
   including the drag, which is measured in world units so a bigger screen
   cannot buy a harder shot. */

const socket = io();
const $ = (id) => document.getElementById(id);
const cv = $('board');
const ctx = cv.getContext('2d');

let me = null;               // my socket id, as the server knows it
let st = null;               // the last state message
let tape = null;             // the resolution being played back
let tapeAt = 0;              // which frame of it
let tapeStartedAt = 0;
let phaseEndsAt = 0;         // wall clock, for the turn timer
let locked = false;
let theirReady = false;
let overShown = false;
let lastOver = null;         // the result on the card, with how long the match ran (ms)
let matchAt = 0;             // when this match started, for the card's Time
let restake = null;          // { nonce, slow } while a paid Play again is with the lobby's wallet
let restakeLine = '';        // a restake's error, said on the card
let restakeTimer = 0;

/* My aims this turn: pieceId -> { ax, ay } in WORLD units. Kept here as well as
   on the server so the arrow stays drawn while I am still thinking. */
let aims = new Map();
let drag = null;             // { pieceId, x, y } while a finger or mouse is down

/* THE BOARD IS TURNED AROUND FOR SEAT 1. The server has one fixed layout, seat
   0 along the bottom and seat 1 along the top, and each client rotates it half
   a turn if it is sitting in seat 1. Every player then sees their own pieces
   nearest them and their opponent's across the disc, which is how every board
   game works and is what Owen asked for. A rotation rather than a mirror,
   because a mirror would flip left and right too and an arrow dragged right
   would fire left. */
let flip = false;

/* Both sets of arrows, held on screen before the tape runs. */
let reveal = null;           // [{ pieceId, owner, ax, ay }]
let revealUntil = 0;

/* The wall eases in rather than jumping. Drawn radius chases the real one. */
let drawR = 0;

/* Pieces the closing ring took this turn, and when we started dropping them,
   so they fall over the edge instead of blinking out. */
let ringFall = new Map();    // pieceId -> start timestamp

/* The name and wallet, read exactly the way the other own-page games read
   them: the lobby writes the name into sessionStorage immediately before it
   sets this page's src, and the wallet lives under the key the wallet widget
   writes. Inventing new keys here would mean somebody who named themselves in
   the lobby arrives in this game called "Player". A page opened without that
   hand-off falls back to the name the lobby keeps (duelseries_playername), as
   /sl and agar.io do. */
const myName = (() => {
  try { return sessionStorage.getItem('playerName') || localStorage.getItem('duelseries_playername') || 'Player'; } catch (_) { return 'Player'; }
})();
const myWallet = (() => {
  try { return localStorage.getItem('duelseries_wallet') || null; } catch (_) { return null; }
})();

/* The buy-in, and the proof it was paid. Both are written by the wallet widget
   immediately before it opens this page, exactly as the snake game reads them.
   Neither is trusted here or on the wire: the server re-reads the token, takes
   the worth it recorded when it verified the transfer on-chain, and refuses the
   seat if the token does not cover the rung being asked for. This is only how
   the two get carried across. */
const myStake = (() => {
  try { return Number(sessionStorage.getItem('stake')) || 0; } catch (_) { return 0; }
})();
/* Spent by the first queue (one use only), so it is let and cleared there. A
   paid Play again never reads a stored token: it buys a fresh one through the
   lobby's wallet (askRestake below) and hands it straight to queue(). */
let myEntryToken = (() => {
  try { return sessionStorage.getItem('entryToken') || null; } catch (_) { return null; }
})();

/* A bought skin (docs/skin-purchases.md): the one the lobby's Customize picked for this game and the skin pass it got
   when it proved the wallet. Only carried across; the server wears the skin when the pass is genuine and lists it,
   and tells both screens what it chose (st.players[].skin). Read at each queue, so a Play again sees a change. */
function shopFields() {
  try {
    const shop = localStorage.getItem('duel.shop.knockout'), pass = localStorage.getItem('duel.skinpass');
    if (shop && pass && /^[a-z][a-z0-9]{0,23}$/.test(shop) && pass.length <= 4096) return { shop, skinPass: pass };
  } catch (_) { /* storage blocked: the free look */ }
  return {};
}

/* The skin an owner's pieces wear, from the state the server sent: a shared/shopSkins.js entry, else null (today's
   bone and red). The server decided it, so a page cannot dress itself or its opponent in anything it was not given. */
function skinOf(ownerId) {
  const SK = window.DS_SHOP_SKINS;
  if (!SK || !st) return null;
  const pl = (st.players || []).find(q => q.id === ownerId);
  return pl && pl.skin ? SK.byId('knockout', pl.skin) : null;
}

/* In the lobby's frame, where a paid Play again can ask the wallet for the
   next buy-in. Opened on its own, a paid card sends you to the lobby instead. */
const FRAMED = (() => { try { return !!window.parent && window.parent !== window; } catch (_) { return true; } })();

/* WATCHING, NOT PLAYING. The lobby's Spectate writes 'dsWatch' with the game to
   watch just before it opens this page. Read once and removed at once, so the
   next Play from the lobby is a Play; and honoured only when it names this
   game, so a mark meant for another game cannot turn this one into a viewer.

   In watch mode this page is read-only: it never queues, never aims and never
   locks, and connecting asks for a match to watch instead of a seat. The
   server sends the match by SEAT rather than by socket id, and the page dresses
   that up as the shape it already draws, with seat 0 standing in for "me" so
   seat 0 is bone and seat 1 red, exactly the pair a player sees. Nothing
   grabbable comes of it: pieceAt refuses everything while watching. */
const WATCH = (() => {
  try {
    const v = sessionStorage.getItem('dsWatch');
    if (v !== null) sessionStorage.removeItem('dsWatch');
    return v === 'knockout';
  } catch (_) { return false; }
})();
/* The buy-in the lobby's Spectate was on (dsWatchStake; none means Free):
   only tables at that stake are shown. Never read as a buy-in of our own. */
const WATCH_STAKE = (() => {
  try {
    const s = Number(sessionStorage.getItem('dsWatchStake'));
    sessionStorage.removeItem('dsWatchStake');
    return Number.isFinite(s) && s > 0 ? s : 0;
  } catch (_) { return 0; }
})();
const WATCH_NEXT_MS = 3000;   // the pause before moving on, and between retries
const seatId = (side) => 's' + side;
let watchMatch = null;        // the match card: { id, names, stake, pot, turn, index, count }
let watchLastId = null;       // the match we were last on, for "the next one after it"
let watchTimer = 0;
let watchReady = [];          // which seats have locked in this turn, as seatIds

/* ── the transform ─────────────────────────────────────────────────────────
   One scale, one centre, recomputed on resize. The disc is fitted with room
   around it so a piece sailing off the edge is still visible while it goes,
   because watching it leave is the best part of the turn. */
let VIEW = { s: 1, cx: 0, cy: 0, dpr: 1 };

function fit() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  /* Fitted against the FIRST radius, not the current one, so the board does not
     zoom in every time the ring closes. The disc shrinking should look like the
     disc shrinking, not like the camera pushing in. */
  const R = 420;
  const pad = 1.34;                      // the margin a piece falls out into
  const usable = Math.min(w, h - 92);    // the strip and the bar own the rest
  VIEW = { s: (usable / 2) / (R * pad), cx: w / 2, cy: h / 2, dpr };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
const toScreenX = (x) => VIEW.cx + (flip ? -x : x) * VIEW.s;
const toScreenY = (y) => VIEW.cy + (flip ? -y : y) * VIEW.s;
const toWorldX = (px) => { const v = (px - VIEW.cx) / VIEW.s; return flip ? -v : v; };
const toWorldY = (py) => { const v = (py - VIEW.cy) / VIEW.s; return flip ? -v : v; };

window.addEventListener('resize', fit);
window.addEventListener('orientationchange', fit);
fit();

/* AND CHECKED EVERY FRAME, because a resize event is not a promise.

   Fitted once at load, the board came out a third of the window and pinned to
   the top-left: the page had been measured before the layout settled and
   nothing ever measured it again. A resize listener does not save you there,
   because no resize happened — the window was always that size, the first
   measurement was just wrong. Two comparisons a frame is a cheap price for a
   board that is never the wrong size. */
function refit() {
  if (cv.style.width === window.innerWidth + 'px'
   && cv.style.height === window.innerHeight + 'px') return;
  fit();
}

/* ── the board we are drawing ──────────────────────────────────────────────
   Either the last state message, or the frame of the tape we are up to. One
   function so the renderer never has to know which of the two it is looking
   at. */
function livePieces() {
  if (!st) return [];
  if (tape) {
    const f = tape.frames[Math.min(tapeAt, tape.frames.length - 1)];
    return tape.order.map((id, i) => {
      const base = st.pieces.find(p => p.id === id) || { id, owner: null };
      /* A piece is drawn as still on the disc until the frame it actually left
         on. Reading `alive` off the state instead would have every piece that
         loses this turn vanish the moment the tape starts. */
      const gone = (tape.out || []).find(o => o.id === id);
      return {
        id, owner: base.owner,
        x: f[i * 2], y: f[i * 2 + 1],
        alive: !gone || tapeAt < gone.frame,
        falling: !!gone && tapeAt >= gone.frame,
      };
    });
  }
  return st.pieces.map(p => Object.assign({ falling: false }, p));
}

const mine = (p) => p.owner === me;

/* ── drawing ───────────────────────────────────────────────────────────── */

function draw() {
  const w = cv.width / VIEW.dpr, h = cv.height / VIEW.dpr;
  ctx.clearRect(0, 0, w, h);
  if (!st) return;

  const R = drawR * VIEW.s;
  const cx = VIEW.cx, cy = VIEW.cy;

  /* The disc. Lit from above so it reads as a surface with a top, and with a
     hard bright rim, because the rim is the entire game. */
  const g = ctx.createRadialGradient(cx, cy - R * 0.35, R * 0.1, cx, cy, R);
  g.addColorStop(0, '#241d16');
  g.addColorStop(1, '#171310');
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = g; ctx.fill();

  /* A ring inside the edge marking the band where a clean hit will take you
     off. It is the one piece of information the physics has that the picture
     otherwise does not, and without it "stay in the middle" is folklore rather
     than something the screen told you. */
  const danger = Math.max(0, drawR - 220) * VIEW.s;
  if (danger > 8) {
    ctx.beginPath(); ctx.arc(cx, cy, danger, 0, Math.PI * 2);
    ctx.setLineDash([5, 9]);
    ctx.strokeStyle = 'rgba(240,168,48,0.20)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = '#f0a830'; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(240,168,48,0.16)'; ctx.lineWidth = 10; ctx.stroke();

  const pieces = livePieces();
  const pr = st.pieceR * VIEW.s;

  for (const p of pieces) {
    const dropping = ringFall.get(p.id);
    if (!p.alive && !p.falling && dropping === undefined) continue;   // long gone
    const x = toScreenX(p.x), y = toScreenY(p.y);
    const isMine = mine(p);

    /* A piece on its way out keeps being drawn, shrinking and fading, so the
       fall is something you watch rather than something you are told. */
    let scale = 1, alpha = 1;
    if (p.falling) {
      const since = tapeAt - ((tape.out || []).find(o => o.id === p.id) || {}).frame;
      const t = Math.min(1, Math.max(0, since / 26));
      scale = 1 - t * 0.75; alpha = 1 - t;
    } else if (dropping !== undefined) {
      /* Taken by the wall rather than by a hit. Same fall, timed off the clock
         rather than off a tape, and started only once the wall has actually
         reached it — so you see the ring arrive and then the piece go. */
      const t = Math.min(1, Math.max(0, (performance.now() - dropping) / 480));
      scale = 1 - t * 0.8; alpha = 1 - t;
      /* THE ENTRY STAYS once the fall has finished. Deleting it was a loop: the
         frame below re-adds any piece in st.ringOut that is not already in this
         map, so the moment the fade ended the piece was signed up for another
         one. Owen: "the circle blinks a lot and it does not fully disappear
         even though it is dead." It was dying on repeat, several times a
         second, for the rest of the match. */
      if (t >= 1) continue;
    }
    if (alpha <= 0.02) continue;

    ctx.save();
    ctx.globalAlpha = alpha;
    const skin = skinOf(p.owner);
    if (skin) {
      /* A bought skin: its own disc and design. A skin can sit close to the other side's colour (ruby next to their
         red, marble next to the bone), so a thin ring in the team colour goes round the rim: bone is mine, red is
         theirs, whatever the piece is wearing. */
      const r = pr * scale;
      window.DS_SHOP_SKINS.knockoutPiece(ctx, skin, x, y, r, isMine ? 0.13 : 0.20);
      const rw = Math.max(1.5, r * 0.16);
      ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r - rw / 2), 0, Math.PI * 2);
      ctx.strokeStyle = isMine ? '#f4f1ea' : '#e0705f';
      ctx.lineWidth = rw;
      ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(x, y, pr * scale, 0, Math.PI * 2);
      ctx.fillStyle = isMine ? '#f4f1ea' : '#e0705f';
      ctx.fill();
      /* A darker inner disc, so a piece reads as an object with a top rather than
         a flat dot, and so the two colours stay apart at a glance. */
      ctx.beginPath(); ctx.arc(x, y - pr * 0.12 * scale, pr * 0.58 * scale, 0, Math.PI * 2);
      ctx.fillStyle = isMine ? 'rgba(0,0,0,0.13)' : 'rgba(0,0,0,0.20)';
      ctx.fill();
    }
    ctx.restore();
  }

  /* My arrows while I am aiming. Only ever mine: the server does not send
     theirs during a turn, and that is the mode. */
  if (!tape && !reveal && st.state === 'aiming') {
    for (const p of pieces) {
      if (!mine(p) || !p.alive) continue;
      const a = drag && drag.pieceId === p.id
        ? { ax: drag.x - p.x, ay: drag.y - p.y }
        : aims.get(p.id);
      if (a) drawArrow(p, a, true);
    }
  }

  /* And EVERYBODY'S, for the beat before anything moves. This is the moment the
     two blind commitments are laid side by side, which is the whole point of
     the mode, so it gets held on screen rather than being over before it has
     registered. */
  if (reveal) {
    for (const a of reveal) {
      const p = pieces.find(q => q.id === a.pieceId);
      if (!p || !p.alive) continue;
      drawArrow(p, a, a.owner === me);
    }
  }
}

/* The arrow. Length is power, so it is drawn at its true length and the head
   sits where the piece is being sent — clamped, and shown clamped, because a
   drag past the cap that keeps growing on screen is the screen lying about how
   hard the shot will be. */
function drawArrow(p, a, isMine) {
  const maxPull = st.maxPull || 260;
  const len = Math.hypot(a.ax, a.ay);
  if (len < 4) return;
  const pull = Math.min(len, maxPull);
  const ux = a.ax / len, uy = a.ay / len;

  const x0 = toScreenX(p.x), y0 = toScreenY(p.y);
  const x1 = toScreenX(p.x + ux * pull), y1 = toScreenY(p.y + uy * pull);
  const full = pull >= maxPull - 0.5;
  /* Their arrow is their colour. During the reveal both are on screen at once
     and telling them apart is the entire thing you are looking at. */
  const tint = isMine ? (full ? '#f0a830' : 'rgba(244,241,234,0.9)') : '#e0705f';

  /* SIZED OFF THE PIECE, not off the screen. The first version used a fixed
     pixel width and a head worked out from the zoom, which came out thick and
     blunt — an arrow as wide as a third of the circle it belongs to reads as a
     bar, and it covers the board it is pointing across. Tied to the piece
     radius it stays in proportion at any zoom and on any phone. */
  const pr = (st.pieceR || 26) * VIEW.s;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = tint;
  ctx.lineWidth = Math.max(1.5, pr * (full ? 0.20 : 0.16));
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();

  const head = Math.max(6, pr * 0.62);
  const ang = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - Math.cos(ang - 0.42) * head, y1 - Math.sin(ang - 0.42) * head);
  ctx.lineTo(x1 - Math.cos(ang + 0.42) * head, y1 - Math.sin(ang + 0.42) * head);
  ctx.closePath();
  ctx.fillStyle = tint;
  ctx.fill();
  ctx.restore();
}

/* ── the loop ──────────────────────────────────────────────────────────────
   One rAF. It advances the tape by WALL CLOCK rather than one frame per frame,
   so a client running at 30fps sees the same three seconds of action as one
   running at 144, just less smoothly. */
function frame() {
  refit();
  const now = performance.now();

  /* THE WALL EASES IN. The server moves it in one step, because the physics has
     to be unambiguous about where the edge is; the picture does not. Chasing the
     real radius at a fixed fraction per frame turns a jump into a close, which
     is all Owen asked for — the same distance per turn, arriving over about half
     a second instead of between two frames. */
  const wantR = tape ? tape.arenaR : (st ? st.arenaR : 0);
  if (!drawR) drawR = wantR;
  else if (Math.abs(drawR - wantR) < 0.4) drawR = wantR;
  else drawR += (wantR - drawR) * 0.10;

  /* A piece the wall closed past drops as the wall REACHES it, not when the
     message arrived, so the ring visibly arrives and then takes it. */
  if (st && st.ringOut && st.ringOut.length) {
    for (const id of st.ringOut) {
      if (ringFall.has(id)) continue;
      const p = (st.pieces || []).find(q => q.id === id);
      if (!p) continue;
      if (Math.hypot(p.x, p.y) >= drawR - 1) ringFall.set(id, now);
    }
  }

  /* The reveal holds the board on frame zero, arrows over the top of it. */
  if (reveal) {
    tapeAt = 0;
    if (now >= revealUntil) { reveal = null; tapeStartedAt = now; }
  } else if (tape && tapeStartedAt) {
    tapeAt = Math.floor((now - tapeStartedAt) / (1000 / 60));
    if (tapeAt >= tape.frames.length + 30) { tape = null; tapeAt = 0; }
  }
  paintClock();
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function paintClock() {
  const num = $('clockNum'), lbl = $('clockLbl'), box = num && num.parentElement;
  if (!num || !st) return;
  if (reveal) {
    num.textContent = '—'; lbl.textContent = 'Go';
    box.classList.remove('urgent', 'locked');
    return;
  }
  if (st.state === 'settling') {
    num.textContent = '—'; lbl.textContent = '';
    box.classList.remove('urgent', 'locked');
    return;
  }
  if (tape || st.state === 'resolving') {
    num.textContent = '—'; lbl.textContent = 'Resolving';
    box.classList.remove('urgent', 'locked');
    return;
  }
  if (st.state !== 'aiming') { num.textContent = '—'; lbl.textContent = ''; return; }
  const left = Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000));
  num.textContent = String(left);
  lbl.textContent = WATCH ? 'Aiming' : locked ? 'Locked' : 'Aim';
  box.classList.toggle('urgent', left <= 5 && !locked);
  box.classList.toggle('locked', locked);
}

/* ── aiming ────────────────────────────────────────────────────────────────
   Press on one of your pieces, drag, release. The arrow points where it goes.
   Pointer events so a mouse, a finger and a pen are all the same code. */

function pieceAt(wx, wy) {
  if (WATCH) return null;                       // a watcher moves nothing
  if (!st || st.state !== 'aiming' || tape || locked) return null;
  /* A generous radius: on a phone the piece is a small target and the penalty
     for missing it is losing the turn you were halfway through aiming. */
  const grab = st.pieceR * 1.9;
  let best = null, bestD = Infinity;
  for (const p of st.pieces) {
    if (!p.alive || p.owner !== me) continue;
    const d = Math.hypot(p.x - wx, p.y - wy);
    if (d < grab && d < bestD) { bestD = d; best = p; }
  }
  return best;
}

cv.addEventListener('pointerdown', (e) => {
  const wx = toWorldX(e.clientX), wy = toWorldY(e.clientY);
  const p = pieceAt(wx, wy);
  if (!p) return;
  e.preventDefault();
  cv.setPointerCapture(e.pointerId);
  drag = { pieceId: p.id, x: wx, y: wy };
});

cv.addEventListener('pointermove', (e) => {
  if (!drag) return;
  e.preventDefault();
  drag.x = toWorldX(e.clientX);
  drag.y = toWorldY(e.clientY);
});

function endDrag(e) {
  if (!drag) return;
  const p = st && st.pieces.find(q => q.id === drag.pieceId);
  if (p) {
    const ax = drag.x - p.x, ay = drag.y - p.y;
    if (Math.hypot(ax, ay) >= 6) {
      aims.set(p.id, { ax, ay });
      sendAims();
    } else {
      /* A tap with no drag clears that piece's arrow, which is how somebody
         expects to say "actually, this one stays put". */
      aims.delete(p.id);
      sendAims();
    }
  }
  drag = null;
  if (e && e.pointerId !== undefined && cv.hasPointerCapture && cv.hasPointerCapture(e.pointerId)) {
    cv.releasePointerCapture(e.pointerId);
  }
  paintBar();
}
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);

function sendAims() {
  socket.emit('ko:aim', {
    aims: [...aims.entries()].map(([pieceId, a]) => ({ pieceId, ax: a.ax, ay: a.ay })),
  });
}

$('lock').addEventListener('click', () => {
  if (WATCH || locked || !st || st.state !== 'aiming') return;
  locked = true;
  socket.emit('ko:lock');
  paintBar();
});

function paintBar() {
  const lock = $('lock'), hint = $('hint'), their = $('theirState');
  if (!st) return;
  if (WATCH) { paintWatchBar(); return; }
  const alive = st.pieces.filter(p => p.owner === me && p.alive);
  const aimed = alive.filter(p => aims.has(p.id)).length;

  if (st.state === 'aiming' && !tape) {
    lock.disabled = locked;
    lock.textContent = locked ? 'Locked in' : 'Lock in';
    hint.textContent = locked
      ? 'Waiting for the other move'
      : aimed === 0 ? 'Drag from each of your pieces to aim'
      : aimed < alive.length ? (alive.length - aimed) + ' still to aim, or lock in as you are'
      : 'Both aimed. Lock in, or keep adjusting.';
  } else {
    lock.disabled = true;
    lock.textContent = 'Lock in';
    hint.textContent = reveal ? 'Both moves are in'
      : st.state === 'settling' ? ''
      : tape || st.state === 'resolving' ? 'Watching it play out'
      : st.state === 'countdown' ? 'Starting' : '';
  }
  their.textContent = theirReady ? 'They are ready' : '';
  their.classList.toggle('ready', theirReady);
}

function paintPips() {
  if (!st) return;
  for (const [side, box] of [['you', $('youPips')], ['them', $('themPips')]]) {
    const who = st.players.find(p => side === 'you' ? p.id === me : p.id !== me);
    if (!box) continue;
    const left = who ? who.left : 0;
    const total = 2;
    box.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const el = document.createElement('span');
      el.className = 'pip' + (i < left ? '' : ' gone');
      box.appendChild(el);
    }
  }
  const you = st.players.find(p => p.id === me);
  const them = st.players.find(p => p.id !== me);
  /* Watching, both sides are somebody else, so both get their names. */
  if (you) $('youName').textContent = WATCH ? (you.name || 'Player') : 'You';
  if (them) $('themName').textContent = them.name || 'Opponent';
}

/* ── chat ──────────────────────────────────────────────────────────────────
   The one DuelSeries chat box (public/js/shared/dsChat.js): T to type, Enter to send. Only the two seated players can
   speak (the server refuses anybody else); a watcher reads. On a computer it sits bottom left, above the bar's hint and
   clear of the disc; on a phone, top left under the strip (and under the watch tag when watching). A line takes its
   seat's colour: bone for me, red for them, the pair the pieces wear (a watcher sees seat 0 as bone). */
let chatLive = false;            // a match is on screen (not the wait card, not the result card)
const chat = DSChat.mount({
  send: (t) => { socket.emit('ko:chat', { text: t }); return true; },
  canSend: () => chatLive && !WATCH,
  pc: { left: 14, bottom: 76 },
  phoneAt: { left: 10, top: WATCH ? 104 : 70 },
});
function chatShow(on) { chatLive = on; chat.visible(on); }
const mySide = () => {
  const p = st && (st.players || []).find(q => q.id === me);
  return p ? p.side : 0;
};
socket.on('ko:chat', (m) => {
  if (!m) return;
  const mine = m.side === mySide();
  chat.add({ name: m.name, color: mine ? '#f4f1ea' : '#e0705f', text: m.text, me: mine && !WATCH });
});
socket.on('ko:chatnote', (m) => { if (m) chat.add({ kind: 'sys', text: m.text }); });

/* ── what the server says ──────────────────────────────────────────────── */

function apply(state) {
  const prev = st;
  st = state;
  /* Which end of the board am I? Seat 1 sees it turned around, so both players
     play from the bottom. Settled once per match, from the seat the server
     gave us. */
  const seat = (state.players || []).find(p => p.id === me);
  if (seat) flip = seat.side === 1;
  /* Where the wall is coming FROM, so the ease has somewhere to start. */
  if (!prev && state.prevArenaR) drawR = state.prevArenaR;
  phaseEndsAt = Date.now() + (state.phaseMs || 0);
  theirReady = (state.ready || []).some(id => id !== me);
  if (WATCH) watchReady = (state.ready || []).slice();
  $('top').hidden = false;
  $('bar').hidden = false;
  $('wait').hidden = true;
  chatShow(true);
  paintPips();
  paintBar();
}

/* Every connect, the first and every reconnect after it: a seat, or in watch
   mode a match to watch. The server forgets a watcher whose socket dropped, so
   a reconnect asks again rather than assuming it is still on the list. */
socket.on('connect', () => {
  if (WATCH) { me = seatId(0); watch(null); return; }
  me = socket.id;
  queue();
});

/* `token`: a paid Play again's fresh entry, from the lobby's wallet. Without
   one, the buy-in this page was opened with, the first time only. */
function queue(token) {
  overShown = false;
  lastOver = null;
  DSEnd.hide();
  chatShow(false);
  $('wait').hidden = false;
  waitSpin(true);
  $('waitMain').textContent = 'Looking for an opponent';
  /* A paid table says what is on it and that it is waiting for a PERSON,
     because it is: a bot cannot cover a stake, so this queue does not get one
     the way the free one does. */
  $('waitSub').textContent = myStake > 0
    ? '$' + myStake.toFixed(2) + ' table. Waiting for a real opponent.'
    : 'Free table. Nothing staked.';
  socket.emit('ko:queue', Object.assign({
    name: myName, wallet: myWallet,
    stake: myStake, entryToken: token || myEntryToken,
  }, shopFields()));
  /* One use only. Re-sending it on a Play again would be asking the server to
     spend a token it has already burned, and the seat would be refused with
     nothing to show for it. */
  myEntryToken = null;
  try { sessionStorage.removeItem('entryToken'); } catch (_) {}
}

function waitSpin(on) {
  const s = document.querySelector('.waitSpin');
  if (s) s.hidden = !on;
}

socket.on('ko:start', (raw) => {
  const state = WATCH ? fromWatch(raw) : raw;
  me = WATCH ? seatId(0) : socket.id;
  matchAt = Date.now();
  aims.clear(); drag = null; locked = false; tape = null;
  reveal = null; ringFall.clear(); drawR = 0;
  apply(state);
  runCountdown(state.phaseMs || 3000);
});

socket.on('ko:turn', (raw) => {
  aims.clear(); drag = null; locked = false; tape = null;
  reveal = null;
  apply(WATCH ? fromWatch(raw) : raw);
});

socket.on('ko:ready', ({ ready } = {}) => {
  if (WATCH) { watchReady = (ready || []).map(seatId); paintBar(); return; }
  theirReady = (ready || []).some(id => id !== me);
  paintBar();
});

socket.on('ko:resolve', (raw) => {
  const msg = WATCH ? fromWatchResolve(raw) : raw;
  if (WATCH) watchReady = [];
  /* Both arrows first, held still, THEN the tape. The state already describes
     the board after everything has happened, so it is taken now but the tape is
     what is drawn from — applying the state alone would snap every piece to its
     final position and then animate it getting there. */
  const t = { order: msg.order, frames: msg.frames, out: msg.out || [], arenaR: msg.arenaR };
  drag = null; locked = false; theirReady = false;
  if (msg.state) { st = Object.assign({}, msg.state, { arenaR: msg.arenaR, ringOut: [] }); }
  aims.clear();

  tape = t; tapeAt = 0;
  if (msg.reveal && msg.reveal.length) {
    reveal = msg.reveal;
    revealUntil = performance.now() + (msg.revealMs || 2000);
    tapeStartedAt = 0;                  // held at frame zero until the reveal ends
  } else {
    reveal = null;
    tapeStartedAt = performance.now();
  }
  paintBar();
});

/* The winner sitting on the board for a moment before the card. The board is
   already drawn and the tape has finished, so there is nothing to do but stop
   calling it 'resolving' - the clock kept saying so through the whole hold,
   because this arrives as its own event rather than as a state message. */
socket.on('ko:settling', () => {
  if (st) st.state = 'settling';
  reveal = null;
  paintBar();
});

socket.on('ko:over', (m) => {
  if (WATCH) { watchOver(m || {}); return; }
  if (overShown) return;
  overShown = true;
  /* Whose result it is, read now: a reconnect while the card is up changes
     the socket id, and the card is drawn again on every restake step. */
  lastOver = Object.assign({}, m || {}, { ms: matchAt ? Date.now() - matchAt : 0, me });
  restake = null; restakeLine = '';
  paintOver();
  $('bar').hidden = true;
  chatShow(false);
});

/* ── the result card ───────────────────────────────────────────────────────
   The one card every DuelSeries game ends on (public/js/shared/dsEnd.js, Owen
   2026-10-16). Every amount on it is the server's own figure from ko:over's
   `money` (server/duelMoney.js: the split index.js pays), only formatted
   here; nothing on this page works a payout out. Names go in as text. */
const RESTAKE_WAIT_MS = 120000;    // the lobby's wallet gets this long before the way back opens again
const TEXT = {
  againAsk: 'Confirm in your wallet...',
  againSlow: 'Waiting for your wallet...',
  againSlowLine: 'Your wallet has not answered yet. If you approved the stake, wait here: the round starts once it lands.',
  againFailed: 'Stake failed',
  lobbyOnly: 'Buy a new entry in the lobby to play again.',
};
function plural(n, one, many) { return n === 1 ? one : many; }

function paintOver() {
  const m = lastOver;
  if (!m) return;
  const money = m.money && typeof m.money === 'object' ? m.money : null;
  const seat = money && money.seats ? money.seats[m.me] || null : null;
  const won = m.winnerId ? m.winnerId === m.me : null;
  const turns = Number(m.turn) || 0;
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
    card.facts = [['Turns', DSEnd.int(turns)]];
    if (time) card.facts.push(['Time', time]);
  } else {
    card.hero = DSEnd.int(turns);
    card.unit = plural(turns, 'turn', 'turns');
    card.facts = time ? [['Time', time]] : [];
  }
  if (m.why === 'opponent left') card.notes.push('They left the match.');
  else if (m.why === 'everyone went off') card.notes.push('Both sides went off on the same turn.');

  const paid = myStake > 0;
  const buttons = [];
  if (paid && !FRAMED) {
    card.notes.push(TEXT.lobbyOnly);
  } else if (restake) {
    buttons.push({ id: 'again', text: restake.slow ? TEXT.againSlow : TEXT.againAsk, primary: true, disabled: true });
    if (restake.slow) card.notes.push(TEXT.againSlowLine);
  } else {
    buttons.push({ id: 'again', text: paid ? 'Play again ' + DSEnd.usd(Math.round(myStake * 1e6)) : 'Play again',
      primary: true, onClick: playAgain });
  }
  if (restakeLine) card.notes.push(restakeLine);
  /* Shut while the wallet is open: the lobby blanks this frame on game:done,
     and a token minted after that would have no page to seat. */
  buttons.push({ id: 'lobby', text: 'Lobby', primary: !buttons.length, disabled: !!restake && !restake.slow, onClick: toLobby });
  card.buttons = buttons;
  DSEnd.show(card);
}

function playAgain() {
  if (WATCH) { watch(watchLastId); return; }
  if (myStake > 0) { askRestake(); return; }
  requeue(null);
}

function requeue(token) {
  socket.emit('ko:leave');
  $('top').hidden = true;
  st = null; tape = null; aims.clear();
  queue(token);
}

/* A PAID PLAY AGAIN BUYS A NEW ENTRY. The one this page opened with was spent
   on the first queue, so asking again with it is refused (and used to leave
   the player on "Waiting for a real opponent" with the refusal in a hidden
   line). The lobby's wallet stakes the same rung (duel:restake, answered by
   wallet-widget/src/restakeBridge.mjs) and posts the fresh token back, which
   goes straight into ko:queue and is never stored. Paper's and agar.io's
   Play again, the same messages. */
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
    /* No answer yet: the way back opens again, and a late answer is still
       taken (the match is queued once it lands). */
    if (!restake) return;
    restake.slow = true;
    paintOver();
  }, RESTAKE_WAIT_MS);
  paintOver();
  try {
    window.parent.postMessage({ type: 'duel:restake', game: 'knockout', stake: myStake, nonce: restake.nonce }, '*');
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
/* The lobby's answer: only the parent frame, only this origin, only the
   request this page made (the nonce the bridge always echoes). */
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

/* The stake came back: nobody took the table, or they backed out. Said out
   loud, because money quietly returning is money a player thinks they lost. */
socket.on('ko:unqueued', ({ refunded, why } = {}) => {
  if (!refunded) return;
  $('wait').hidden = false;
  waitSpin(false);                      // no longer looking
  $('waitMain').textContent = 'Buy-in refunded';
  $('waitSub').textContent = (why === 'nobody joined that table'
    ? 'Nobody joined that table, so your buy-in went back to your wallet.'
    : 'Your buy-in went back to your wallet.');
});

socket.on('ko:refused', ({ why } = {}) => {
  /* Every refusal says something. A silent one is indistinguishable from a
     control that does not work. Out of a match it is the seat that was
     refused (a buy-in the server would not take), and the wait card is what
     is on screen, so it is said there and not in the hidden bar. */
  if (!WATCH && !st) {
    $('wait').hidden = false;
    waitSpin(false);
    $('waitMain').textContent = 'Not seated';
    $('waitSub').textContent = sentence(why) || 'The table did not let you in.';
    return;
  }
  $('hint').textContent = why ? 'That aim was refused: ' + why : 'That aim was refused.';
});

/* ── the three seconds ─────────────────────────────────────────────────── */
let countTimer = 0;
function runCountdown(ms) {
  clearInterval(countTimer);
  const box = $('count'), num = $('countNum');
  let left = Math.max(1, Math.ceil(ms / 1000));
  box.hidden = false; num.textContent = String(left);
  countTimer = setInterval(() => {
    left--;
    if (left <= 0) { clearInterval(countTimer); box.hidden = true; return; }
    /* Re-created so the beat animation restarts on each number. */
    num.textContent = String(left);
    num.style.animation = 'none'; void num.offsetWidth; num.style.animation = '';
  }, 1000);
}

/* ── leaving ───────────────────────────────────────────────────────────── */
function toLobby() {
  if (restake && !restake.slow) return;     // the wallet is open: the way back is shut until it answers
  clearTimeout(watchTimer);
  socket.emit(WATCH ? 'ko:unwatch' : 'ko:leave');
  /* The lobby hosts this in an iframe and listens for exactly this, same as the
     other games. Falls back to a normal navigation when opened directly. */
  if (window.parent && window.parent !== window) window.parent.postMessage('game:done', '*');
  else location.href = '/';
}
$('waitCancel').addEventListener('click', toLobby);

window.addEventListener('beforeunload', () => socket.emit(WATCH ? 'ko:unwatch' : 'ko:leave'));

/* ── watching ──────────────────────────────────────────────────────────────
   The server sends a watcher the same moments a player gets, with `side` where
   a player's messages have a socket id. These turn that back into the shape
   the rest of this file draws, with seatId(side) standing in for the id. */
function fromWatch(s) {
  if (!s) return s;
  return Object.assign({}, s, {
    players: (s.players || []).map(p => Object.assign({}, p, { id: seatId(p.side) })),
    pieces: (s.pieces || []).map(p => Object.assign({}, p, { owner: seatId(p.side) })),
    ready: (s.ready || []).map(seatId),
  });
}
function fromWatchReveal(list) {
  return (list || []).map(a => Object.assign({}, a, { owner: seatId(a.side) }));
}
function fromWatchResolve(m) {
  return Object.assign({}, m, { state: fromWatch(m && m.state), reveal: fromWatchReveal(m && m.reveal) });
}

const seatName = (id) => {
  const p = st && (st.players || []).find(q => q.id === id);
  return (p && p.name) || 'Player';
};

/* Ask for a match. `after` is the one being left, so the server moves on from
   it rather than handing the same one back. */
function watch(after) {
  clearTimeout(watchTimer);
  socket.emit('ko:watch', after ? { after, stake: WATCH_STAKE } : { stake: WATCH_STAKE });
  publishWatch(watchMatch ? 'watching' : 'searching');
}

function showWatchWait(main, sub) {
  DSEnd.hide();
  $('wait').hidden = false;
  $('waitMain').textContent = main;
  $('waitSub').textContent = sub;
}

function nextSoon() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => watch(watchLastId), WATCH_NEXT_MS);
}

/* What the page is doing, for a headless check to read without a screenshot. */
function publishWatch(mode) {
  try {
    window.__watch = {
      game: 'knockout', mode,
      matchId: watchMatch ? watchMatch.id : null,
      names: watchMatch ? watchMatch.names.slice() : [],
      index: watchMatch ? watchMatch.index : 0,
      count: watchMatch ? watchMatch.count : 0,
      stake: watchMatch ? watchMatch.stake : 0,
      state: st ? st.state : null,
    };
  } catch (_) {}
}

function paintWatch() {
  const m = watchMatch;
  $('watchTag').hidden = !m;
  if (m) {
    const n = m.names || [];
    $('watchLabel').textContent = 'Watching ' + (n[0] || 'Player') + ' vs ' + (n[1] || 'Player');
    $('watchMeta').textContent = (m.stake > 0 ? '$' + Number(m.stake).toFixed(2) + ' table' : 'Free table')
      + (m.count > 1 ? ' · match ' + m.index + ' of ' + m.count : '');
  }
  $('watchNext').hidden = false;
  $('watchNext').disabled = !m || !(m.count > 1);
  $('watchLobby').hidden = false;
  $('lock').hidden = true;
  publishWatch(m ? 'watching' : 'searching');
}

/* The bar while watching: what is happening, in words, since there is
   nothing to do. Who has locked in is the one thing worth saying mid-turn. */
function paintWatchBar() {
  const hint = $('hint');
  $('theirState').textContent = '';
  const n = watchReady.length;
  hint.textContent = reveal ? 'Both moves are in'
    : st.state === 'aiming' && !tape
      ? (n >= 2 ? 'Both locked in' : n === 1 ? seatName(watchReady[0]) + ' is locked in' : 'Both are aiming')
    : st.state === 'settling' ? ''
    : tape || st.state === 'resolving' ? 'Watching it play out'
    : st.state === 'countdown' ? 'Starting' : '';
}

socket.on('ko:watching', (m) => {
  if (!WATCH || !m) return;
  clearTimeout(watchTimer);
  if (!m.match || !m.state) {
    /* Nothing to show yet. Ask again in a moment rather than leaving a page
       that can only ever say no. */
    watchMatch = null;
    $('top').hidden = true; $('bar').hidden = true; $('watchTag').hidden = true;
    st = null; tape = null; reveal = null;
    chatShow(false);
    showWatchWait(
      m.full ? 'Every match is full of watchers' : m.refused ? 'You are in a match' : 'Nobody is playing right now',
      'Checking again every few seconds.');
    publishWatch(m.full ? 'full' : m.refused ? 'refused' : 'none');
    nextSoon();
    return;
  }

  /* A match, possibly part way through a turn. Start from a clean board. */
  watchMatch = m.match;
  watchLastId = m.match.id;
  overShown = false;
  DSEnd.hide();
  aims.clear(); drag = null; locked = false; tape = null; reveal = null;
  ringFall.clear(); drawR = 0; st = null; watchReady = [];
  const state = fromWatch(m.state);
  if (state.state === 'resolving') state.ringOut = [];
  apply(state);

  clearInterval(countTimer);
  $('count').hidden = true;
  if (state.state === 'countdown') runCountdown(state.phaseMs || 3000);

  /* Arriving during a reveal or a tape: join it where it is. */
  const r = m.state.resolve;
  if (r && state.state === 'resolving' && Array.isArray(r.frames)) {
    const elapsed = Math.max(0, Number(r.elapsedMs) || 0);
    const holdMs = r.revealMs || 2000;
    tape = { order: r.order || [], frames: r.frames, out: r.out || [], arenaR: r.arenaR };
    tapeAt = 0;
    if (elapsed < holdMs && r.reveal && r.reveal.length) {
      reveal = fromWatchReveal(r.reveal);
      revealUntil = performance.now() + (holdMs - elapsed);
      tapeStartedAt = 0;
    } else {
      reveal = null;
      tapeStartedAt = performance.now() - (elapsed - holdMs);
    }
  }
  paintWatch();
  paintBar();
});

/* Where this match now sits among the ones running. Next match is on offer
   only when there is a next match. */
socket.on('ko:matches', ({ index, count } = {}) => {
  if (!WATCH || !watchMatch) return;
  if (Number.isFinite(index)) watchMatch.index = index;
  if (Number.isFinite(count)) watchMatch.count = count;
  paintWatch();
});

/* The match went away without a result (the two of them were paired off
   elsewhere, or it simply stopped). Said, then on to the next. */
socket.on('ko:ended', ({ id } = {}) => {
  if (!WATCH || overShown) return;
  if (watchMatch && id && id !== watchMatch.id) return;
  overShown = true;
  DSEnd.show({ verdict: 'That match ended', notes: ['Finding the next one.'], buttons: watchButtons() });
  $('bar').hidden = true;
  publishWatch('ended');
  nextSoon();
});

/* A watcher's card: who won it and in how many turns, then on to the next
   match by itself. No money: nobody watching staked anything. */
function watchButtons() {
  return [
    { id: 'again', text: 'Next match', primary: true, onClick: () => watch(watchLastId) },
    { id: 'lobby', text: 'Lobby', onClick: toLobby },
  ];
}
function watchOver(m) {
  if (overShown) return;
  overShown = true;
  const names = watchMatch ? watchMatch.names : [];
  const loser = m.winnerSide === 0 ? names[1] : m.winnerSide === 1 ? names[0] : null;
  const turns = Number(m.turn) || 0;
  const notes = [];
  if (m.why === 'opponent left') notes.push((loser || 'A player') + ' left the match.');
  else if (m.why === 'everyone went off') notes.push('Both sides went off on the same turn.');
  notes.push('Next match in a few seconds.');
  DSEnd.show({
    verdict: m.winner ? m.winner + ' wins' : 'Draw',
    hero: DSEnd.int(turns), unit: plural(turns, 'turn', 'turns'),
    notes, buttons: watchButtons(),
  });
  $('bar').hidden = true;
  publishWatch('over');
  nextSoon();
}

if (WATCH) {
  document.body.classList.add('watching');
  $('waitMain').textContent = 'Finding a match to watch';
  $('waitSub').textContent = 'Watching only. You are not playing.';
  $('watchNext').hidden = false;
  $('watchLobby').hidden = false;
  $('lock').hidden = true;
  $('watchNext').addEventListener('click', () => { if (watchMatch) watch(watchMatch.id); });
  $('watchLobby').addEventListener('click', toLobby);
  publishWatch('searching');
}
