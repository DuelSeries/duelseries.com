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

/* My aims this turn: pieceId -> { ax, ay } in WORLD units. Kept here as well as
   on the server so the arrow stays drawn while I am still thinking. */
let aims = new Map();
let drag = null;             // { pieceId, x, y } while a finger or mouse is down

/* The name and wallet, read exactly the way the other own-page games read
   them: the lobby writes the name into sessionStorage immediately before it
   sets this page's src, and the wallet lives under the key the wallet widget
   writes. Inventing new keys here would mean somebody who named themselves in
   the lobby arrives in this game called "Player". */
const myName = (() => {
  try { return sessionStorage.getItem('playerName') || 'Player'; } catch (_) { return 'Player'; }
})();
const myWallet = (() => {
  try { return localStorage.getItem('duelseries_wallet') || null; } catch (_) { return null; }
})();

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
const toScreenX = (x) => VIEW.cx + x * VIEW.s;
const toScreenY = (y) => VIEW.cy + y * VIEW.s;
const toWorldX = (px) => (px - VIEW.cx) / VIEW.s;
const toWorldY = (py) => (py - VIEW.cy) / VIEW.s;

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

  const R = (tape ? tape.arenaR : st.arenaR) * VIEW.s;
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
  const danger = Math.max(0, (tape ? tape.arenaR : st.arenaR) - 220) * VIEW.s;
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
    if (!p.alive && !p.falling) continue;          // long gone, in an earlier turn
    const x = toScreenX(p.x), y = toScreenY(p.y);
    const isMine = mine(p);

    /* A piece on its way out keeps being drawn, shrinking and fading, so the
       fall is something you watch rather than something you are told. */
    let scale = 1, alpha = 1;
    if (p.falling) {
      const since = tapeAt - ((tape.out || []).find(o => o.id === p.id) || {}).frame;
      const t = Math.min(1, Math.max(0, since / 26));
      scale = 1 - t * 0.75; alpha = 1 - t;
    }
    if (alpha <= 0.02) continue;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.arc(x, y, pr * scale, 0, Math.PI * 2);
    ctx.fillStyle = isMine ? '#f4f1ea' : '#e0705f';
    ctx.fill();
    /* A darker inner disc, so a piece reads as an object with a top rather than
       a flat dot, and so the two colours stay apart at a glance. */
    ctx.beginPath(); ctx.arc(x, y - pr * 0.12 * scale, pr * 0.58 * scale, 0, Math.PI * 2);
    ctx.fillStyle = isMine ? 'rgba(0,0,0,0.13)' : 'rgba(0,0,0,0.20)';
    ctx.fill();
    ctx.restore();
  }

  /* My arrows. Only ever mine: the server does not send theirs, and this is the
     mode. */
  if (!tape && st.state === 'aiming') {
    for (const p of pieces) {
      if (!mine(p) || !p.alive) continue;
      const a = drag && drag.pieceId === p.id
        ? { ax: drag.x - p.x, ay: drag.y - p.y }
        : aims.get(p.id);
      if (a) drawArrow(p, a);
    }
  }
}

/* The arrow. Length is power, so it is drawn at its true length and the head
   sits where the piece is being sent — clamped, and shown clamped, because a
   drag past the cap that keeps growing on screen is the screen lying about how
   hard the shot will be. */
function drawArrow(p, a) {
  const maxPull = st.maxPull || 260;
  const len = Math.hypot(a.ax, a.ay);
  if (len < 4) return;
  const pull = Math.min(len, maxPull);
  const ux = a.ax / len, uy = a.ay / len;

  const x0 = toScreenX(p.x), y0 = toScreenY(p.y);
  const x1 = toScreenX(p.x + ux * pull), y1 = toScreenY(p.y + uy * pull);
  const full = pull >= maxPull - 0.5;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = full ? '#f0a830' : 'rgba(244,241,234,0.85)';
  ctx.lineWidth = full ? 4 : 3;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();

  const head = Math.max(9, 13 * VIEW.s * 6);
  const ang = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - Math.cos(ang - 0.42) * head, y1 - Math.sin(ang - 0.42) * head);
  ctx.lineTo(x1 - Math.cos(ang + 0.42) * head, y1 - Math.sin(ang + 0.42) * head);
  ctx.closePath();
  ctx.fillStyle = full ? '#f0a830' : 'rgba(244,241,234,0.85)';
  ctx.fill();
  ctx.restore();
}

/* ── the loop ──────────────────────────────────────────────────────────────
   One rAF. It advances the tape by WALL CLOCK rather than one frame per frame,
   so a client running at 30fps sees the same three seconds of action as one
   running at 144, just less smoothly. */
function frame() {
  refit();
  if (tape) {
    const elapsed = performance.now() - tapeStartedAt;
    tapeAt = Math.floor(elapsed / (1000 / 60));
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
  if (tape || st.state === 'resolving') {
    num.textContent = '—'; lbl.textContent = 'Resolving';
    box.classList.remove('urgent', 'locked');
    return;
  }
  if (st.state !== 'aiming') { num.textContent = '—'; lbl.textContent = ''; return; }
  const left = Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000));
  num.textContent = String(left);
  lbl.textContent = locked ? 'Locked' : 'Aim';
  box.classList.toggle('urgent', left <= 5 && !locked);
  box.classList.toggle('locked', locked);
}

/* ── aiming ────────────────────────────────────────────────────────────────
   Press on one of your pieces, drag, release. The arrow points where it goes.
   Pointer events so a mouse, a finger and a pen are all the same code. */

function pieceAt(wx, wy) {
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
  if (locked || !st || st.state !== 'aiming') return;
  locked = true;
  socket.emit('ko:lock');
  paintBar();
});

function paintBar() {
  const lock = $('lock'), hint = $('hint'), their = $('theirState');
  if (!st) return;
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
    hint.textContent = tape || st.state === 'resolving' ? 'Watching it play out'
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
  if (you) $('youName').textContent = 'You';
  if (them) $('themName').textContent = them.name || 'Opponent';
}

/* ── what the server says ──────────────────────────────────────────────── */

function apply(state) {
  st = state;
  phaseEndsAt = Date.now() + (state.phaseMs || 0);
  theirReady = (state.ready || []).some(id => id !== me);
  $('top').hidden = false;
  $('bar').hidden = false;
  $('wait').hidden = true;
  paintPips();
  paintBar();
}

socket.on('connect', () => {
  me = socket.id;
  queue();
});

function queue() {
  overShown = false;
  $('over').hidden = true;
  $('wait').hidden = false;
  $('waitMain').textContent = 'Looking for an opponent';
  $('waitSub').textContent = 'Free table. Nothing staked.';
  socket.emit('ko:queue', { name: myName, wallet: myWallet });
}

socket.on('ko:start', (state) => {
  me = socket.id;
  aims.clear(); drag = null; locked = false; tape = null;
  apply(state);
  runCountdown(state.phaseMs || 3000);
});

socket.on('ko:turn', (state) => {
  aims.clear(); drag = null; locked = false; tape = null;
  apply(state);
});

socket.on('ko:ready', ({ ready }) => {
  theirReady = (ready || []).some(id => id !== me);
  paintBar();
});

socket.on('ko:resolve', (msg) => {
  /* Play the tape, THEN take the state. The state already describes the board
     after everything has happened, so applying it first would snap every piece
     to its final position and then animate it getting there. */
  tape = { order: msg.order, frames: msg.frames, out: msg.out || [], arenaR: msg.arenaR };
  tapeAt = 0;
  tapeStartedAt = performance.now();
  drag = null; locked = false; theirReady = false;
  if (msg.state) { st = Object.assign({}, msg.state, { arenaR: msg.arenaR }); }
  aims.clear();
  paintBar();
});

socket.on('ko:over', (m) => {
  if (overShown) return;
  overShown = true;
  const won = m.winnerId ? m.winnerId === me : null;
  $('overEyebrow').textContent = won === true ? 'You win' : won === false ? 'Knocked out' : 'Draw';
  const who = $('overWho');
  who.textContent = won === true ? 'You win' : won === false ? (m.winner || 'Opponent') + ' wins' : 'Nobody won it';
  who.className = 'overWho' + (won === true ? ' won' : won === false ? ' lost' : '');
  $('overWhy').textContent =
    m.why === 'opponent left' ? 'They left the match.'
    : m.why === 'everyone went off' ? 'Both sides went off on the same turn.'
    : 'Last one standing after ' + (m.turn || 0) + (m.turn === 1 ? ' turn.' : ' turns.');
  $('over').hidden = false;
  $('bar').hidden = true;
});

socket.on('ko:refused', ({ why }) => {
  /* Every refusal says something. A silent one is indistinguishable from a
     control that does not work. */
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
  socket.emit('ko:leave');
  /* The lobby hosts this in an iframe and listens for exactly this, same as the
     other games. Falls back to a normal navigation when opened directly. */
  if (window.parent && window.parent !== window) window.parent.postMessage('game:done', '*');
  else location.href = '/';
}
$('waitCancel').addEventListener('click', toLobby);
$('lobbyBtn').addEventListener('click', toLobby);
$('againBtn').addEventListener('click', () => {
  socket.emit('ko:leave');
  $('over').hidden = true;
  $('top').hidden = true;
  st = null; tape = null; aims.clear();
  queue();
});

window.addEventListener('beforeunload', () => socket.emit('ko:leave'));
