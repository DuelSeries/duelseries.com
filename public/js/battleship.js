'use strict';
/* ─── Battleship, the client ──────────────────────────────────────────────────
   Draws two charts, lets you drag a fleet onto the left one, and lets you pick
   a square on the right one and commit it.

   IT KNOWS NOTHING IT SHOULD NOT. The server sends a view built for this player
   alone: my fleet in full, the shots that have landed on me, and — for the
   enemy chart — marks only, plus any ship I have actually sunk. There is no
   field in that payload for an enemy ship still afloat, so there is nothing
   here to accidentally draw. That is deliberate: hiding it in the client would
   be a decoration over a leak.

   Everything that decides anything happens on the server. This picks squares
   and draws what it is told. */

const socket = io();
// The ping and FPS readout every game shares (public/js/shared/dsPerfHud.js), timed on this socket.
if (window.DSPerfHud) window.DSPerfHud.mount({ socket });
const $ = (id) => document.getElementById(id);

const GRID = 10;
const LETTERS = 'ABCDEFGHIJ';

let st = null;            // the last view the server sent
let aimed = null;         // the square I have picked but not committed
let layout = new Map();   // key -> { x, y, horiz } while I am placing
let horiz = true;         // which way the next ship goes down
let dragging = null;      // { key, len, horiz } while one is under the pointer
let ghost = null;
let overShown = false;
let countTimer = 0;
let lastOver = null;      // the result on the card, with how long the match ran (ms) and my hits
let matchAt = 0;          // when this match's first view arrived, for the card's Time
let restake = null;       // { nonce, slow } while a paid Play again is with the lobby's wallet
let restakeLine = '';     // a restake's error, said on the card
let restakeTimer = 0;

const myName = (() => {
  try { return sessionStorage.getItem('playerName') || localStorage.getItem('duelseries_playername') || 'Player'; } catch (_) { return 'Player'; }
})();
const myWallet = (() => {
  try { return localStorage.getItem('duelseries_wallet') || null; } catch (_) { return null; }
})();
/* The buy-in and its proof, written by the wallet widget just before this page
   opens. Neither is trusted here: the server re-reads the token and takes the
   worth it recorded when it verified the transfer. */
const myStake = (() => {
  try { return Number(sessionStorage.getItem('stake')) || 0; } catch (_) { return 0; }
})();
/* Spent by the first queue (one use only), so it is let and cleared there. A
   paid Play again buys a fresh one through the lobby's wallet (askRestake). */
let myEntryToken = (() => {
  try { return sessionStorage.getItem('entryToken') || null; } catch (_) { return null; }
})();
/* In the lobby's frame, where a paid Play again can ask the wallet for the
   next buy-in. Opened on its own, a paid card sends you to the lobby instead. */
const FRAMED = (() => { try { return !!window.parent && window.parent !== window; } catch (_) { return true; } })();

/* A bought skin (docs/skin-purchases.md): the one the lobby's Customize picked for this game and the skin pass it got
   when it proved the wallet. Only carried across; the server wears the skin when the pass is genuine and lists it,
   and tells both screens what it chose (you.skin, them.skin, and per seat for a watcher). Read at each queue. */
function shopFields() {
  try {
    const shop = localStorage.getItem('duel.shop.battleship'), pass = localStorage.getItem('duel.skinpass');
    if (shop && pass && /^[a-z][a-z0-9]{0,23}$/.test(shop) && pass.length <= 4096) return { shop, skinPass: pass };
  } catch (_) { /* storage blocked: the free look */ }
  return {};
}

/* Run draw() with the game's hull colours swapped for a bought skin's, then put them straight back: drawShip reads
   BattleshipArt.HULL as it draws (the lobby's preview does the same, public/js/v2/shopArt.js). No skin, or a skin
   this page does not know, runs draw() untouched, so a free fleet is drawn exactly as before. */
function withHull(skinId, draw) {
  const SK = window.DS_SHOP_SKINS, BA = window.BattleshipArt;
  const k = skinId && SK && BA ? SK.byId('battleship', skinId) : null;
  if (!k) return draw();
  const H = BA.HULL, keep = {}, worn = SK.hullFor(k);
  for (const key in worn) { keep[key] = H[key]; H[key] = worn[key]; }
  try { return draw(); } finally { for (const key in keep) H[key] = keep[key]; }
}
/* Whose fleet is on a board decides its skin: mine are mine, the ones I sank are theirs, and a watcher's board is
   its seat's. */
const mySkin = () => (st && st.you && st.you.skin) || null;
const theirSkin = () => (st && st.them && st.them.skin) || null;
const seatSkin = (side) => {
  const p = st && (st.players || []).find(q => q.side === side);
  return (p && p.skin) || null;
};

/* WATCHING, NOT PLAYING. The lobby's Spectate writes 'dsWatch' with the game to
   watch just before it opens this page. Read once and removed at once, so the
   next Play is a Play, and honoured only when it names this game.

   In watch mode this page never queues, places or fires: connecting asks for a
   match to watch, and what comes back is the server's spectatorView, which is
   both boards as shots and sunk ships only, by seat. Seat 0's waters go on the
   first board (#theirs, left or on top) and seat 1's on the second (#mine),
   so the boards read in the same order as the names in the strip. */
const WATCH = (() => {
  try {
    const v = sessionStorage.getItem('dsWatch');
    if (v !== null) sessionStorage.removeItem('dsWatch');
    return v === 'battleship';
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
const WATCH_NEXT_MS = 3000;   // between asks while no match is running
const WATCH_OVER_MS = 2500;   // how long a finished match's result and fleets stay up before the next one
const WATCH_SWAP_MS = 1500;   // how long the arrows rest for an answer that never comes
/* The Spectate controls are the shared bar (public/js/shared/dsWatchBar.js): Lobby, previous, next and who is playing. */
const BAR = window.DSWatchBar || null;
let watchMatch = null;        // the match card: { id, names, stake, pot, turn, index, count }
let watchLastId = null;       // the match we were last on, for "the one before / after it"
let watchTimer = 0;
let swapping = false;         // Previous / Next is asked and not answered yet
let swapTimer = 0;
const watchCanvas = (side) => (side === 0 ? $('theirs') : $('mine'));
const watchWrap = (side) => (side === 0 ? $('wrapTheirs') : $('wrapMine'));
const watchName = (side) => {
  const p = st && (st.players || []).find(q => q.side === side);
  return (p && p.name) || (watchMatch && watchMatch.names[side]) || 'Player';
};
const watchBoard = (side) => ((st && st.boards) || [])[side] || { shots: [], sunk: [], squaresLeft: 17 };
/* A name short enough for the clock label in the middle of the strip. */
const shortName = (n) => (n.length > 10 ? n.slice(0, 9) + '…' : n);

/* ── geometry ──────────────────────────────────────────────────────────────
   Both charts are square, drawn at whatever CSS size the layout gives them,
   with a gutter along the top and left for the letters and numbers. One cell
   size for everything, worked out once per paint. */
function metrics(cv) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = cv.clientWidth || 520;
  if (cv.width !== Math.round(cssW * dpr)) {
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssW * dpr);
    cv.style.height = cssW + 'px';
  }
  const gutter = Math.max(16, cssW * 0.062);
  const cell = (cssW - gutter - 4) / GRID;
  return { dpr, cssW, gutter, cell };
}

const cellFromXY = (x, y) => y * GRID + x;

/* Which square a pointer is over, or null if it is off the grid. */
function squareAt(cv, clientX, clientY) {
  const m = metrics(cv);
  const r = cv.getBoundingClientRect();
  const x = Math.floor((clientX - r.left - m.gutter) / m.cell);
  const y = Math.floor((clientY - r.top - m.gutter) / m.cell);
  if (x < 0 || y < 0 || x >= GRID || y >= GRID) return null;
  return { x, y, cell: cellFromXY(x, y) };
}

/* ── drawing a chart ───────────────────────────────────────────────────── */

function drawBoard(cv, opts) {
  const m = metrics(cv);
  const ctx = cv.getContext('2d');
  ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
  ctx.clearRect(0, 0, m.cssW, m.cssW);

  const g0 = m.gutter;
  const size = m.cell * GRID;

  /* The water. */
  ctx.fillStyle = '#0a1622';
  roundRect(ctx, g0, g0, size, size, 8);
  ctx.fill();

  /* The rules of the grid, and the letters and numbers outside it. */
  ctx.strokeStyle = '#1d3348';
  ctx.lineWidth = 1;
  for (let i = 0; i <= GRID; i++) {
    const p = g0 + i * m.cell;
    ctx.beginPath(); ctx.moveTo(p, g0); ctx.lineTo(p, g0 + size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(g0, p); ctx.lineTo(g0 + size, p); ctx.stroke();
  }
  ctx.fillStyle = '#7c869a';
  ctx.font = '600 ' + Math.max(9, m.cell * 0.34).toFixed(0) + "px 'IBM Plex Mono', monospace";
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 0; i < GRID; i++) {
    ctx.fillText(LETTERS[i], g0 + i * m.cell + m.cell / 2, g0 * 0.55);
    ctx.fillText(String(i + 1), g0 * 0.5, g0 + i * m.cell + m.cell / 2);
  }

  /* Ships. On my chart these are my own fleet; on theirs, only what I have
     sunk — the server does not send me anything else, so there is nothing else
     that could be drawn here. */
  for (const s of (opts.ships || [])) {
    const sx = g0 + s.x * m.cell, sy = g0 + s.y * m.cell;
    withHull(opts.skin, () => window.BattleshipArt.drawShip(ctx, s.key, s.len || shipLen(s), sx, sy, m.cell,
      s.horiz !== false, s.sunk ? 0.95 : 0.88));
    if (s.sunk) {
      /* A sunk ship is stated, not implied. */
      ctx.save();
      ctx.globalAlpha = 0.30;
      ctx.fillStyle = '#e0554a';
      const w = (s.horiz !== false ? (s.len || shipLen(s)) : 1) * m.cell;
      const h = (s.horiz !== false ? 1 : (s.len || shipLen(s))) * m.cell;
      ctx.fillRect(sx, sy, w, h);
      ctx.restore();
    }
  }

  /* The marks. A white ring for a miss, a red cross for a hit: two shapes as
     well as two colours, so the board is still readable to somebody who cannot
     tell the two colours apart. */
  for (const mark of (opts.marks || [])) {
    const x = mark.cell % GRID, y = Math.floor(mark.cell / GRID);
    const cx = g0 + x * m.cell + m.cell / 2;
    const cy = g0 + y * m.cell + m.cell / 2;
    const r = m.cell * 0.22;
    if (mark.hit) {
      ctx.strokeStyle = '#e0554a';
      ctx.lineWidth = Math.max(2, m.cell * 0.11);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(238,242,247,0.78)';
      ctx.lineWidth = Math.max(1.5, m.cell * 0.07);
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2); ctx.stroke();
    }
  }

  /* Where a ship would land if it were dropped right now, and whether it can. */
  if (opts.preview) {
    const p = opts.preview;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = p.ok ? 'rgba(142,208,129,0.30)' : 'rgba(224,85,74,0.34)';
    ctx.strokeStyle = p.ok ? '#8ed081' : '#e0554a';
    ctx.lineWidth = 2;
    for (const c of p.cells) {
      const x = c % GRID, y = Math.floor(c / GRID);
      ctx.fillRect(g0 + x * m.cell + 1, g0 + y * m.cell + 1, m.cell - 2, m.cell - 2);
      ctx.strokeRect(g0 + x * m.cell + 1, g0 + y * m.cell + 1, m.cell - 2, m.cell - 2);
    }
    ctx.restore();
  }

  /* The square I have picked, before I commit it. */
  if (opts.aim !== null && opts.aim !== undefined) {
    const x = opts.aim % GRID, y = Math.floor(opts.aim / GRID);
    ctx.save();
    ctx.strokeStyle = '#f0a830';
    ctx.lineWidth = Math.max(2, m.cell * 0.08);
    ctx.strokeRect(g0 + x * m.cell + 2, g0 + y * m.cell + 2, m.cell - 4, m.cell - 4);
    /* Crosshair arms, so it reads as aiming rather than as a selected cell. */
    const cx = g0 + x * m.cell + m.cell / 2, cy = g0 + y * m.cell + m.cell / 2;
    ctx.lineWidth = Math.max(1, m.cell * 0.05);
    ctx.beginPath();
    ctx.moveTo(cx - m.cell * 0.62, cy); ctx.lineTo(cx - m.cell * 0.30, cy);
    ctx.moveTo(cx + m.cell * 0.30, cy); ctx.lineTo(cx + m.cell * 0.62, cy);
    ctx.moveTo(cx, cy - m.cell * 0.62); ctx.lineTo(cx, cy - m.cell * 0.30);
    ctx.moveTo(cx, cy + m.cell * 0.30); ctx.lineTo(cx, cy + m.cell * 0.62);
    ctx.stroke();
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shipLen(s) {
  const spec = (st && st.fleet || []).find(f => f.key === s.key);
  return spec ? spec.len : (s.cells ? s.cells.length : 1);
}

/* ── painting the whole screen ─────────────────────────────────────────── */

function paint() {
  if (!st) return;
  if (WATCH) {
    /* Each seat's own waters: the shots fired at it, and its ships the other
       side has sunk. There is nothing else in a watcher's view to draw. */
    for (const side of [0, 1]) {
      const b = watchBoard(side);
      drawBoard(watchCanvas(side), {
        ships: (b.sunk || []).map(s => Object.assign({ sunk: true }, s)),
        marks: b.shots || [],
        aim: null,
        skin: seatSkin(side),
      });
    }
    return;
  }
  const placing = st.state === 'placing';

  /* My chart: my fleet, plus every shot they have taken at me. */
  drawBoard($('mine'), {
    ships: placing ? previewFleet() : st.myShips,
    marks: st.shotsOnMe,
    preview: dragging ? dropPreview() : null,
    aim: null,
    skin: mySkin(),
  });

  /* Theirs: marks I have earned, and ships I have finished. */
  drawBoard($('theirs'), {
    ships: st.sunkOfTheirs.map(s => Object.assign({ sunk: true }, s)),
    marks: st.myShots,
    aim: aimed,
    skin: theirSkin(),
  });
}

/* While placing, my chart draws the ships I have put down so far. */
function previewFleet() {
  const out = [];
  for (const [key, pos] of layout) {
    const spec = (st.fleet || []).find(f => f.key === key);
    if (!spec) continue;
    out.push({ key, len: spec.len, x: pos.x, y: pos.y, horiz: pos.horiz, sunk: false });
  }
  return out;
}

/* ── laying the fleet out ──────────────────────────────────────────────── */

function cellsFor(x, y, len, hz) {
  const cells = [];
  for (let k = 0; k < len; k++) {
    const cx = hz ? x + k : x, cy = hz ? y : y + k;
    if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) return null;
    cells.push(cellFromXY(cx, cy));
  }
  return cells;
}

function occupied(exceptKey) {
  const used = new Set();
  for (const [key, pos] of layout) {
    if (key === exceptKey) continue;
    const spec = (st.fleet || []).find(f => f.key === key);
    if (!spec) continue;
    for (const c of cellsFor(pos.x, pos.y, spec.len, pos.horiz) || []) used.add(c);
  }
  return used;
}

function dropPreview() {
  if (!dragging || !dragging.at) return null;
  const cells = cellsFor(dragging.at.x, dragging.at.y, dragging.len, dragging.horiz);
  if (!cells) return { cells: [], ok: false };
  const used = occupied(dragging.key);
  const ok = cells.every(c => !used.has(c));
  return { cells, ok };
}

/* How big a ship is in the row under the board. Seventeen cells of ship have
   to sit side by side in the width of the board above them, so the cell is
   worked out from that rather than fixed: at a fixed size the five either
   wrapped onto a second line or ran off the edge, depending on the phone. */
let railCell = 18;

function fitRail() {
  const dock = $('dock');
  if (!dock || dock.hidden || !st) return;
  const fleet = (st.fleet || []);
  const cells = fleet.reduce((a, f) => a + f.len, 0) || 17;
  /* Each ship carries its own padding and border, and there is a gap between
     them; that is what is NOT available to the hulls. */
  const room = (dock.clientWidth || window.innerWidth) - fleet.length * 14 - 8;
  /* Bigger than they need to be, on purpose. These are drag handles before they
     are pictures: a 12px hull is a hard thing to get a thumb onto, and there is
     a screenful of empty space under them to spend. They are allowed up to two
     rows so the extra size does not have to come out of the width. */
  const oneRow = Math.floor(room / cells);
  const twoRows = Math.floor((room * 2) / cells);
  railCell = Math.max(12, Math.min(34, oneRow >= 20 ? oneRow : twoRows));
}

function buildTray() {
  const tray = $('tray');
  tray.innerHTML = '';
  for (const spec of (st.fleet || [])) {
    const el = document.createElement('div');
    el.className = 'trayShip' + (layout.has(spec.key) ? ' placed' : '')
      + (dragging && dragging.key === spec.key ? ' dragging' : '');
    el.dataset.key = spec.key;

    /* Drawn STANDING ON END, because that is how they sit in the rail. The art
       takes the orientation as an argument, so this is the same five ships the
       board draws and not a second set of pictures to keep in step. */
    const cell = railCell;
    const cv = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    /* Lying the way they will sit on the water, in a row under the board.
       Standing on end they were a short stubby row that wasted the width and
       did not look like the fleet you are about to place. */
    cv.width = spec.len * cell * dpr;
    cv.height = cell * dpr;
    cv.style.width = (spec.len * cell) + 'px';
    cv.style.height = cell + 'px';
    const c2 = cv.getContext('2d');
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    withHull(mySkin(), () => window.BattleshipArt.drawShip(c2, spec.key, spec.len, 0, 0, cell, true, 1));

    const nm = document.createElement('span');
    nm.className = 'trayName';
    nm.textContent = spec.name.slice(0, 4);

    el.appendChild(cv);
    el.appendChild(nm);
    tray.appendChild(el);
  }
  const left = (st.fleet || []).length - layout.size;
  $('railMsg').textContent = left ? left + ' to place' : 'Fleet ready';
}

/* ── PICKING A SHIP UP, MOVING IT, AND PUTTING IT DOWN ───────────────────────

   One gesture, and which one it was is decided by whether the pointer MOVED:

     drag and release  →  the ship lands on the squares under it
     press and release →  the ship stays in hand, and the next tap places it

   Owen: "I want to hold and drag my boat and then let go, and it should
   automatically go into whatever squares are highlighted. Right now it kinda
   just floats there." That was this: on a touch screen every press was treated
   as a pick-up, so releasing left the ship in hand rather than dropping it.
   Eight pixels of movement is the whole difference now.

   And a placed ship answers a TAP by turning on the spot, which is the other
   thing he asked for, while a drag on one picks it back up. */
const MOVE_SLOP = 8;

function startDrag(key, spec, x, y, el, fromBoard) {
  dragging = {
    key, len: spec.len, horiz: fromBoard ? fromBoard.horiz : horiz,
    at: null, el: el || null, held: false, moved: false, x0: x, y0: y,
  };
  if (fromBoard) horiz = fromBoard.horiz;
  if (el) el.classList.add('dragging');
  showGhost(x, y);
  paintRotFab();
}

$('tray').addEventListener('pointerdown', (e) => {
  if (WATCH) return;
  const el = e.target.closest('.trayShip');
  if (!el || !st || st.state !== 'placing') return;
  const key = el.dataset.key;
  const spec = (st.fleet || []).find(f => f.key === key);
  if (!spec) return;
  e.preventDefault();

  /* Tapping the ship already in hand puts it back. */
  if (dragging && dragging.held && dragging.key === key) { dropHeld(); return; }
  if (dragging && dragging.el) dragging.el.classList.remove('dragging');
  startDrag(key, spec, e.clientX, e.clientY, el, null);
});

/* A ship already on the water: a drag lifts it, a tap turns it. */
let boardPress = null;
$('mine').addEventListener('pointerdown', (e) => {
  if (WATCH || !st || st.state !== 'placing') return;
  const sq = squareAt($('mine'), e.clientX, e.clientY);

  /* Something in hand? This press is the drop. */
  if (dragging && dragging.held) { e.preventDefault(); placeHeldAt(sq); return; }
  if (dragging || !sq) return;

  for (const [key, pos] of layout) {
    const spec = (st.fleet || []).find(f => f.key === key);
    if (!spec) continue;
    const cells = cellsFor(pos.x, pos.y, spec.len, pos.horiz) || [];
    if (!cells.includes(sq.cell)) continue;
    e.preventDefault();
    boardPress = { key, spec, pos, x0: e.clientX, y0: e.clientY };
    return;
  }
});

window.addEventListener('pointermove', (e) => {
  /* A press on a placed ship only becomes a lift once it has actually moved.
     Without this, the tap that is meant to turn a ship picks it up instead. */
  if (boardPress) {
    if (Math.abs(e.clientX - boardPress.x0) + Math.abs(e.clientY - boardPress.y0) < MOVE_SLOP) return;
    const p = boardPress; boardPress = null;
    layout.delete(p.key);
    buildTray();
    startDrag(p.key, p.spec, e.clientX, e.clientY, null, p.pos);
    dragging.moved = true;
    paint();
  }
  if (!dragging) return;
  if (!dragging.moved
      && Math.abs(e.clientX - dragging.x0) + Math.abs(e.clientY - dragging.y0) >= MOVE_SLOP) {
    dragging.moved = true;
  }
  dragging.at = squareAt($('mine'), e.clientX, e.clientY);
  moveGhost(e.clientX, e.clientY);
  paint();
});

window.addEventListener('pointerup', () => {
  /* A tap on a placed ship, which never moved: turn it where it sits. */
  if (boardPress) {
    const p = boardPress; boardPress = null;
    turnPlaced(p.key, p.spec, p.pos);
    return;
  }
  if (!dragging) return;

  /* Never moved, so it was a tap: keep it in hand for the next one. */
  if (!dragging.moved) {
    dragging.held = true;
    $('railMsg').textContent = 'Tap a square';
    return;
  }
  dropHeld();
});
window.addEventListener('pointercancel', () => { boardPress = null; });

/* Put down whatever is in hand, at the square it is over. */
function dropHeld() {
  if (!dragging) return;
  const d = dragging;
  const ok = d.at && fits(d.at.x, d.at.y, d.len, d.horiz, d.key);
  if (ok) layout.set(d.key, { x: d.at.x, y: d.at.y, horiz: d.horiz });
  if (ok) snd('place');
  if (d.el) d.el.classList.remove('dragging');
  dragging = null;
  hideGhost();
  buildTray();
  paint();
  paintRotFab();
  maybeSubmit();
}

function placeHeldAt(sq) {
  if (!dragging) return;
  dragging.at = sq;
  if (!sq || !fits(sq.x, sq.y, dragging.len, dragging.horiz, dragging.key)) {
    $('railMsg').textContent = sq ? 'Will not fit' : 'Tap a square';
    return;
  }
  dropHeld();
}

function fits(x, y, len, hz, exceptKey) {
  const cells = cellsFor(x, y, len, hz);
  if (!cells) return false;
  const used = occupied(exceptKey);
  return cells.every(c => !used.has(c));
}

/* Turning a ship that is already down, about its own bow. Refused rather than
   nudged if the turned ship would not fit: quietly shifting somebody's ship a
   square sideways to make it work is a worse surprise than it not turning. */
function turnPlaced(key, spec, pos) {
  const want = !pos.horiz;
  if (!fits(pos.x, pos.y, spec.len, want, key)) {
    $('railMsg').textContent = 'No room to turn';
    return;
  }
  layout.set(key, { x: pos.x, y: pos.y, horiz: want });
  horiz = want;
  paint();
  maybeSubmit();
}

/* ── turning a ship ──────────────────────────────────────────────────────────
   R on a keyboard, right-click anywhere on your own waters, or the thumb
   button. All three work with a ship in hand, and the ghost under the cursor
   turns with it, so "will this fit" is answered while it is being asked. A
   ship already on the water is turned by tapping it instead — see turnPlaced. */
function turnShip() {
  horiz = !horiz;
  if (dragging) { dragging.horiz = horiz; showGhostFor(dragging); }
  paint();
}

window.addEventListener('keydown', (e) => {
  if (e.key !== 'r' && e.key !== 'R') return;
  if (WATCH || !st || st.state !== 'placing') return;
  e.preventDefault();
  turnShip();
});

$('mine').addEventListener('contextmenu', (e) => {
  if (WATCH || !st || st.state !== 'placing') return;
  e.preventDefault();
  turnShip();
});

$('rotFab').addEventListener('click', (e) => { e.preventDefault(); turnShip(); });
/* On a touch screen the press itself has to turn it: a finger already holding
   a ship never delivers a click to anything else. */
$('rotFab').addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  e.preventDefault();
  turnShip();
});

/* On screen only while there is something to turn. */
function paintRotFab() {
  const show = !WATCH && !!st && st.state === 'placing'
    && (dragging !== null || layout.size < (st.fleet || []).length);
  $('rotFab').hidden = !show;
}

/* Nobody should have to place five ships by hand who does not want to. */
$('auto').addEventListener('click', () => {
  if (WATCH || !st || st.state !== 'placing') return;
  if (dragging) { if (dragging.el) dragging.el.classList.remove('dragging'); dragging = null; hideGhost(); }
  layout = randomLayout();
  buildTray();
  paint();
  paintRotFab();
  maybeSubmit();
});

function randomLayout() {
  for (let attempt = 0; attempt < 300; attempt++) {
    const used = new Set();
    const out = new Map();
    let ok = true;
    for (const spec of (st.fleet || [])) {
      let done = false;
      for (let t = 0; t < 200 && !done; t++) {
        const hz = Math.random() < 0.5;
        const x = Math.floor(Math.random() * (hz ? GRID - spec.len + 1 : GRID));
        const y = Math.floor(Math.random() * (hz ? GRID : GRID - spec.len + 1));
        const cells = cellsFor(x, y, spec.len, hz);
        if (!cells || cells.some(c => used.has(c))) continue;
        for (const c of cells) used.add(c);
        out.set(spec.key, { x, y, horiz: hz });
        done = true;
      }
      if (!done) { ok = false; break; }
    }
    if (ok) return out;
  }
  return new Map();
}

/* The fleet goes up the moment it is complete. There is no separate Ready: a
   placed fleet IS ready, and a button that is only ever pressed once the work
   is done is a button that exists to be forgotten. */
/* NOTHING IS SENT UNTIL CONFIRM IS PRESSED.

   It used to go up the moment the fifth ship landed, which took the board away
   from somebody who had only just finished putting it down and might well want
   to move one. Now the button lights when the fleet is complete, and the match
   starts when it is pressed — or when the minute runs out, which the server
   handles by laying out whatever is missing. */
function maybeSubmit() {
  if (WATCH || !st || st.state !== 'placing') return;
  const total = (st.fleet || []).length;
  const done = layout.size === total;
  const btn = $('confirm');
  if (btn) {
    btn.disabled = !done || sentFleet;
    btn.textContent = sentFleet ? 'Waiting for them…' : 'Confirm fleet';
  }
  $('railMsg').textContent = sentFleet ? 'Fleet confirmed'
    : done ? 'Ready when you are'
    : (total - layout.size) + ' to place';
}

let sentFleet = false;

$('confirm').addEventListener('click', () => {
  if (WATCH || !st || st.state !== 'placing' || sentFleet) return;
  if (layout.size !== (st.fleet || []).length) return;
  sentFleet = true;
  socket.emit('bs:place', {
    layout: [...layout.entries()].map(([key, p]) => ({ key, x: p.x, y: p.y, horiz: p.horiz })),
  });
  maybeSubmit();
});

/* ── the ship under the cursor ─────────────────────────────────────────── */

function showGhost(x, y) {
  if (!ghost) {
    ghost = document.createElement('canvas');
    ghost.id = 'ghost';
    document.body.appendChild(ghost);
  }
  showGhostFor(dragging);
  moveGhost(x, y);
  ghost.style.display = 'block';
}

function showGhostFor(d) {
  if (!ghost || !d) return;
  const m = metrics($('mine'));
  const cell = m.cell;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = (d.horiz ? d.len : 1) * cell, h = (d.horiz ? 1 : d.len) * cell;
  ghost.width = w * dpr; ghost.height = h * dpr;
  ghost.style.width = w + 'px'; ghost.style.height = h + 'px';
  const c = ghost.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  withHull(mySkin(), () => window.BattleshipArt.drawShip(c, d.key, d.len, 0, 0, cell, d.horiz, 0.92));
  ghost._cell = cell;
}

function moveGhost(x, y) {
  if (!ghost) return;
  const cell = ghost._cell || 30;
  ghost.style.left = (x - cell / 2) + 'px';
  ghost.style.top = (y - cell / 2) + 'px';
}

function hideGhost() { if (ghost) ghost.style.display = 'none'; }

/* ── firing ──────────────────────────────────────────────────────────────────
   No Confirm button any more. One tap lines a square up, a second tap on the
   SAME square fires it.

   That covers both things at once: a double-tap fires straight away, and a
   square lined up during the other player's turn is fired by a single tap once
   the turn comes round — which is what the Confirm button used to be for. */
function fireAt(cell) {
  if (WATCH || cell === null || !st || !st.yourTurn) return false;
  socket.emit('bs:fire', { cell });
  aimed = null;
  paint();
  return true;
}

function aimOrFire(cell) {
  if (WATCH) return;                            // a watcher aims at nothing
  if (!st || (st.state !== 'playing' && st.state !== 'countdown')) return;
  if ((st.myShots || []).some(m => m.cell === cell)) return;   // already been there
  if (aimed === cell && st.yourTurn) { fireAt(cell); return; }
  aimed = cell;
  paint();
}

$('theirs').addEventListener('click', (e) => {
  const sq = squareAt($('theirs'), e.clientX, e.clientY);
  if (sq) aimOrFire(sq.cell);
});

/* dblclick as well, so a quick double on a fresh square fires without waiting
   for the two separate clicks to be noticed. */
$('theirs').addEventListener('dblclick', (e) => {
  if (WATCH || !st || !st.yourTurn) return;
  const sq = squareAt($('theirs'), e.clientX, e.clientY);
  if (!sq) return;
  if ((st.myShots || []).some(m => m.cell === sq.cell)) return;
  e.preventDefault();
  fireAt(sq.cell);
});

const name = (c) => LETTERS[c % GRID] + (Math.floor(c / GRID) + 1);

/* ── the furniture ─────────────────────────────────────────────────────── */

/* The bar is gone: what it said is now said by the ring round the live board,
   the clock, and the turn pill. A row of text under a board nobody was reading
   was a row of text taking up the one dimension a phone does not have. */
function paintBar() {}

/* WHICH BOARD IS LIVE. The ring goes round the board about to be acted on, so
   attention lands where the work is: their waters when it is your shot, your
   own while you are being shot at. */
function paintLive() {
  const mine = $('wrapMine'), theirs = $('wrapTheirs');
  const playing = st && st.state === 'playing';
  if (WATCH) {
    /* The ring goes round the board being fired at, which is the other seat's.
       Amber on both, since neither is the watcher's own. */
    const shooter = playing ? st.turn : null;
    const target = shooter === 0 ? 1 : shooter === 1 ? 0 : null;
    for (const side of [0, 1]) {
      const w = watchWrap(side);
      w.classList.toggle('live', target === side);
      w.classList.toggle('mine', false);
      w.classList.toggle('theirs', true);
    }
    const clock = $('clockNum').parentElement;
    clock.classList.toggle('mine', shooter === 0);
    clock.classList.toggle('theirs', shooter === 1);
    return;
  }
  mine.classList.toggle('live', !!(playing && !st.yourTurn));
  mine.classList.toggle('mine', true);
  theirs.classList.toggle('live', !!(playing && st.yourTurn));
  theirs.classList.toggle('theirs', true);
  const clock = $('clockNum').parentElement;
  clock.classList.toggle('mine', !!(playing && st.yourTurn));
  clock.classList.toggle('theirs', !!(playing && !st.yourTurn));
}

/* And the change of hands is announced once, rather than being something you
   have to notice. */
let callTimer = 0;
function callTurn(yours) {
  if (yours) snd('turn');
  const box = $('turnCall');
  $('turnCallText').textContent = yours ? 'Your shot' : 'Their shot';
  box.classList.toggle('theirs', !yours);
  box.hidden = false;
  /* Restart the animation rather than waiting for it: two turns can change
     hands inside two seconds when both players are quick. */
  const span = $('turnCallText');
  span.style.animation = 'none'; void span.offsetWidth; span.style.animation = '';
  clearTimeout(callTimer);
  callTimer = setTimeout(() => { box.hidden = true; }, 1900);
}

function paintTop() {
  if (!st) return;
  if (WATCH) {
    /* Seat 0 on the left of the strip and on the first board, seat 1 on the
       right (in the opponent's red) and on the second. */
    $('youName').textContent = watchName(0);
    $('themName').textContent = watchName(1);
    $('foeTitle').textContent = watchName(0) + "'s waters";
    $('myTitle').textContent = watchName(1) + "'s waters";
    $('foeTitle').classList.remove('them');
    $('myTitle').classList.add('them');
    $('youBar').setAttribute('aria-label', watchName(0) + "'s fleet");
    $('themBar').setAttribute('aria-label', watchName(1) + "'s fleet");
    ticks($('youBar'), watchBoard(0).squaresLeft);
    ticks($('themBar'), watchBoard(1).squaresLeft);
    return;
  }
  $('youName').textContent = st.you ? st.you.name : 'You';
  $('themName').textContent = (st.them ? st.them.name : 'Opponent') + (st.vsBot ? ' (bot)' : '');
  $('myTitle').textContent = (st.you ? st.you.name : 'You') + ' · your waters';
  $('foeTitle').textContent = (st.them ? st.them.name : 'Opponent') + ' · their waters';
  ticks($('youBar'), st.squaresLeftMine);
  ticks($('themBar'), st.squaresLeftTheirs);
}

function ticks(box, left) {
  const total = 17;
  if (box.childElementCount !== total) {
    box.innerHTML = '';
    for (let i = 0; i < total; i++) box.appendChild(document.createElement('i'));
  }
  [...box.children].forEach((el, i) => el.classList.toggle('gone', i >= left));
}

function paintClock() {
  if (!st) return;
  const num = $('clockNum'), lbl = $('clockLbl'), box = num.parentElement;
  if (st.state === 'placing') { lbl.textContent = WATCH ? 'Placing' : 'Place'; }
  else if (st.state === 'playing') {
    lbl.textContent = WATCH ? shortName(watchName(st.turn)) + ' to fire'
      : st.yourTurn ? 'Your shot' : 'Their shot';
  }
  else if (st.state === 'countdown') { lbl.textContent = 'Ready'; }
  else { lbl.textContent = ''; num.textContent = '—'; box.classList.remove('urgent'); return; }
  const left = Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000));
  num.textContent = String(left);
  box.classList.toggle('urgent', left <= 5);
}

let phaseEndsAt = 0;
setInterval(paintClock, 250);

/* ── the server ────────────────────────────────────────────────────────── */

/* Every connect, the first and every reconnect: a seat, or in watch mode a
   match to watch (the server forgets a watcher whose socket dropped). */
let myId = null;          // my socket id as of the last connect, for reading my own seat off the result
socket.on('connect', () => {
  myId = socket.id;
  if (WATCH) { swapping = false; watch(null); return; }
  // A reconnect while waiting takes the same seat back by the key the server sent (see knockout.js).
  if (waiting && resumeKey) { queue(null, resumeKey); return; }
  queue();
});

/* THE WAIT (Owen 2026-10-21), the same as Knockout's: a minute on screen, then a bot on a free table,
   while a paid one keeps looking for a person and Cancel gives the buy-in back at once. */
const WAIT_MS = window.DS_DUEL_WAIT_MS;   // shared/duelWait.js, the server's number too
let waiting = false, waitPaid = false, waitEndsAt = 0, waitTimer = 0, resumeKey = null;
function clockText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function paintWait() {
  if (!waiting) return;
  const left = waitEndsAt - Date.now();
  const table = '$' + myStake.toFixed(2) + ' table. ';
  if (left > 0) {
    $('waitMain').textContent = 'Looking for a player… ' + clockText(left);
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
socket.on('bs:queued', (q = {}) => {
  if (WATCH || st) return;                 // matched already: the wait card is not coming back
  if (typeof q.resumeKey === 'string') resumeKey = q.resumeKey;
  const total = Number(q.waitMs) > 0 ? Number(q.waitMs) : WAIT_MS;
  startWait(total - (Number(q.waitingMs) || 0));
});

/* "Playing a bot", said as the match starts and kept on the name above (Owen 2026-10-21). */
let botNoteTimer = 0;
function botNote() {
  const n = $('botNote');
  if (!n) return;
  n.hidden = false;
  clearTimeout(botNoteTimer);
  botNoteTimer = setTimeout(() => { n.hidden = true; }, 5000);
}

/* `token`: a paid Play again's fresh entry, from the lobby's wallet. Without
   one, the buy-in this page was opened with, the first time only. `resume`: a
   reconnect's key, asking for the seat it already had. */
function queue(token, resume) {
  overShown = false;
  lastOver = null;
  DSEnd.hide();
  chatShow(false);
  $('wait').hidden = false;
  waitSpin(true);
  waitPaid = myStake > 0;
  $('waitCancel').textContent = waitPaid ? 'Cancel and refund' : 'Back to the lobby';
  if (!resume) startWait(WAIT_MS);
  else paintWait();
  socket.emit('bs:queue', Object.assign({ name: myName, wallet: myWallet, stake: myStake,
    entryToken: token || myEntryToken, resume: resume || undefined }, shopFields()));
  /* One use only: re-sending it on a Play again would ask the server to spend a
     token it has already burned. */
  myEntryToken = null;
  try { sessionStorage.removeItem('entryToken'); } catch (_) {}
}

function waitSpin(on) {
  const s = document.querySelector('.waitSpin');
  if (s) s.hidden = !on;
}

/* CHAT. The one DuelSeries chat box (public/js/shared/dsChat.js): T to type, Enter to send (R still turns a ship, but
   not while the box has the keys). Only the two seated players can speak (the server refuses anybody else); a watcher
   reads. A line takes its seat's colour: cream for me, red for them, as the names above the boards; a watcher sees seat
   0 as cream. */
let chatLive = false;            // a match is on screen (not the wait card, not the result card)
const chat = DSChat.mount({
  send: (t) => { socket.emit('bs:chat', { text: t }); return true; },
  canSend: () => chatLive && !WATCH,        // where it sits is battleship.css: the boards leave no clear corner
});
function chatShow(on) { chatLive = on; chat.visible(on); }
const mySide = () => (!WATCH && st && st.you ? st.you.side : 0);
socket.on('bs:chat', (m) => {
  if (!m) return;
  const mine = m.side === mySide();
  chat.add({ name: m.name, color: mine ? '#f5f1e8' : '#e0554a', text: m.text, me: mine && !WATCH });
});
socket.on('bs:chatnote', (m) => { if (m) chat.add({ kind: 'sys', text: m.text }); });

/* WHAT JUST HAPPENED, AS A SOUND.

   Worked out by DIFFING the shots against the previous view rather than from an
   event, because the state message is the only thing that arrives: a shot
   landing on me and a shot landing on them both turn up as one more entry in a
   list. Comparing the counts says which, and whose, in two lines.

   Only ever one sound per message. A reconnect brings the whole board down at
   once and playing seventeen splashes into somebody's ear is not a summary of
   the match so far. */
let _sndMine = 0, _sndTheirs = 0, _sndSunk = 0;

/* The quiet moments (turn, ship down, result) go through here so a missing sound never breaks the page. */
function snd(k, a) { const S = window.BattleshipSound; if (S && S[k]) S[k](a); }

function soundFor(view) {
  const S = window.BattleshipSound;
  if (!S) return;
  const mine = (view.myShots || []).length;          // shots I have fired
  const theirs = (view.shotsOnMe || []).length;      // shots they have fired
  const sunk = (view.sunkOfTheirs || []).length;
  const hadMine = _sndMine, hadTheirs = _sndTheirs, hadSunk = _sndSunk;
  _sndMine = mine; _sndTheirs = theirs; _sndSunk = sunk;

  /* The first view of a match is not news. */
  if (!st) return;
  if (mine - hadMine > 1 || theirs - hadTheirs > 1) return;   // a resync, not a shot

  if (sunk > hadSunk) { S.sunk(); return; }                   // outranks the hit that caused it
  if (mine > hadMine) {
    const last = (view.myShots || [])[mine - 1];
    (last && last.hit) ? S.hit() : S.miss();
    return;
  }
  if (theirs > hadTheirs) {
    const last = (view.shotsOnMe || [])[theirs - 1];
    (last && last.hit) ? S.taken() : S.miss();
  }
}

socket.on('bs:state', (view) => {
  if (WATCH) { watchState(view); return; }
  const first = !st;
  if (first) {
    matchAt = Date.now();
    stopWait();
    resumeKey = null;                      // the seat is a match now, not a place in the queue
    if (view && view.vsBot) botNote();
  }
  const wasPlacing = st && st.state === 'placing';
  soundFor(view);
  st = view;
  phaseEndsAt = Date.now() + (view.phaseMs || 0);

  $('wait').hidden = true;
  $('top').hidden = false;
  if (!overShown) chatShow(true);
  $('stage').hidden = false;
  $('dock').hidden = view.state !== 'placing';
  document.body.classList.toggle('firing', view.state === 'playing' || view.state === 'settling');
  /* The dock only exists while placing, and on a phone the two boards are
     sized off whatever height is left over, so the layout has to know. */
  document.body.classList.toggle('placing', view.state === 'placing');

  if (first) { buildTray(); fitRail(); buildTray(); }
  if (wasPlacing && view.state === 'countdown') {
    /* The server lays a fleet for anybody who ran out of time, so take its word
       for where my ships are rather than keeping my half-finished attempt. */
    layout.clear();
    runCountdown(view.phaseMs || 3000);
  }
  /* An aim SURVIVES the other player's turn — that is the whole point of
     picking one early. It is only dropped if the square stopped being a legal
     target, which on their waters can only happen because I fired there. */
  if (aimed !== null && (view.myShots || []).some(m => m.cell === aimed)) aimed = null;

  /* Only when it actually changes hands, so it is not re-announced by every
     state message that happens to arrive during a turn. */
  if (view.state === 'playing' && view.yourTurn !== lastTurnWasMine) {
    lastTurnWasMine = view.yourTurn;
    callTurn(view.yourTurn);
  }
  if (view.state !== 'playing') lastTurnWasMine = null;

  paintTop();
  paintBar();
  paintLive();
  paintRotFab();
  paintClock();
  /* Twice: once to size the boards against the furniture this state shows, and
     again after, because hiding the dock changes what is left over. */
  fitRail();
  fitBoards();
  fitBoards();
  paint();
});

let lastTurnWasMine = null;

socket.on('bs:refused', ({ why } = {}) => {
  /* Out of a match it is the seat that was refused (a buy-in the server would
     not take), and the wait card is what is on screen, so it is said there and
     not in the hidden rail. */
  if (!WATCH && !st) {
    // A paid reconnect whose seat could not be taken back: never "unpaid", it was paid (see knockout.js).
    const lost = waiting && waitPaid && resumeKey;
    stopWait(); resumeKey = null; waitPaid = false;
    $('wait').hidden = false;
    waitSpin(false);
    $('waitMain').textContent = 'Not seated';
    $('waitSub').textContent = lost
      ? 'Your connection dropped while you waited. Your buy-in goes back to your wallet.'
      : (sentence(why) || 'The table did not let you in.');
    $('waitCancel').textContent = 'Back to the lobby';
    return;
  }
  $('railMsg').textContent = why ? 'Refused: ' + why : 'That was refused.';
});

/* Said in a sentence: the server's reasons are written as clauses. */
function sentence(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.');
}

socket.on('bs:unqueued', ({ refunded, why } = {}) => {
  if (WATCH || st) return;
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

socket.on('bs:over', (m) => {
  if (WATCH) { watchOver(m || {}); return; }
  if (overShown) return;
  overShown = true;
  m = m || {};
  chatShow(false);
  snd('over', m.won);
  /* Whose result it is, read now: a reconnect while the card is up changes
     the socket id, and the card is drawn again on every restake step. */
  lastOver = Object.assign({}, m, {
    me: socket.id || myId,
    ms: matchAt ? Date.now() - matchAt : 0,
    hits: ((st && st.myShots) || []).filter(s => s && s.hit).length,
  });
  restake = null; restakeLine = '';
  paintOver();

  /* Both fleets, now that it is over. Drawn onto the two charts so you can see
     where everything actually was, which is the thing everybody wants after a
     game of guessing. */
  if (Array.isArray(m.reveal) && st) {
    /* By socket id first: two players who both kept the default name used to
       get each other's fleets drawn on the wrong boards. */
    const mine = m.reveal.find(r => r.id === socket.id)
      || m.reveal.find(r => r.name === (st.you && st.you.name));
    const theirs = m.reveal.find(r => r !== mine);
    if (theirs) {
      drawBoard($('theirs'), {
        ships: theirs.ships.map(s => Object.assign({ len: s.cells.length }, s)),
        marks: st.myShots, aim: null, skin: theirs.skin || theirSkin(),
      });
    }
    if (mine) {
      drawBoard($('mine'), {
        ships: mine.ships.map(s => Object.assign({ len: s.cells.length }, s)),
        marks: st.shotsOnMe, aim: null, skin: mine.skin || mySkin(),
      });
    }
  }
});

/* ── the result card ───────────────────────────────────────────────────────
   The one card every DuelSeries game ends on (public/js/shared/dsEnd.js, Owen
   2026-10-16). Every amount on it is the server's own figure from bs:over's
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
  const won = m.won === true ? true : m.won === false ? false : null;
  const shots = Number(m.shots) || 0;
  const time = m.ms > 0 ? DSEnd.clock(m.ms) : '';
  const card = {
    tone: 'plain',
    verdict: won === true ? 'You win' : won === false ? (m.winner || 'Your opponent') + ' wins' : 'Draw',
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
    card.facts = [['Shots', DSEnd.int(shots)], ['Hits', DSEnd.int(m.hits)]];
    if (time) card.facts.push(['Time', time]);
  } else {
    card.hero = DSEnd.int(shots);
    card.unit = plural(shots, 'shot fired', 'shots fired');   /* yours, whoever won */
    card.facts = [['Hits', DSEnd.int(m.hits)]];
    if (time) card.facts.unshift(['Time', time]);
  }
  if (m.why === 'opponent left') card.notes.push('They left the match.');

  /* The same three buttons on every card, paid and free (Owen 2026-10-16):
     Lobby, Spectate, Play again. Lobby and Spectate are shut while the wallet
     is open: the lobby blanks this frame on game:done, and a token minted
     after that would have no page to seat; Spectate leaves the card too. */
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
    // Spectate is also shut for the whole buy-in, slow or not (a Play again buy-in still with the wallet, slow or not: a late stake needs this page in the frame)
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
  socket.emit('bs:leave');
  $('top').hidden = true;
  $('stage').hidden = true;
  st = null; aimed = null; layout.clear(); sentFleet = false;
  _sndMine = 0; _sndTheirs = 0; _sndSunk = 0;
  queue(token);
}

/* A PAID PLAY AGAIN BUYS A NEW ENTRY. The one this page opened with was spent
   on the first queue, so asking again with it is refused (and used to leave
   the player on "Waiting for a real opponent" with the refusal in a hidden
   line). The lobby's wallet stakes the same rung (duel:restake, answered by
   wallet-widget/src/restakeBridge.mjs) and posts the fresh token back, which
   goes straight into bs:queue and is never stored. Paper's and agar.io's
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
    window.parent.postMessage({ type: 'duel:restake', game: 'battleship', stake: myStake, nonce: restake.nonce }, '*');
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

/* ── the countdown ─────────────────────────────────────────────────────── */
function runCountdown(ms) {
  clearInterval(countTimer);
  const box = $('count'), num = $('countNum');
  let left = Math.max(1, Math.ceil(ms / 1000));
  box.hidden = false; num.textContent = String(left);
  countTimer = setInterval(() => {
    left--;
    if (left <= 0) { clearInterval(countTimer); box.hidden = true; return; }
    num.textContent = String(left);
    num.style.animation = 'none'; void num.offsetWidth; num.style.animation = '';
  }, 1000);
}

/* ── leaving ───────────────────────────────────────────────────────────── */
function toLobby() {
  if (restake && !restake.slow) return;     // the wallet is open: the way back is shut until it answers
  clearTimeout(watchTimer);
  clearTimeout(swapTimer);
  if (BAR) BAR.close();
  socket.emit(WATCH ? 'bs:unwatch' : 'bs:leave');
  if (window.parent && window.parent !== window) window.parent.postMessage('game:done', '*');
  else location.href = '/';
}
// Cancel on a waiting paid seat refunds first and says so; the next press goes to the lobby (see knockout.js).
$('waitCancel').addEventListener('click', () => {
  if (waiting && waitPaid && !st && !WATCH) {
    stopWait(); waitPaid = false; resumeKey = null;
    waitSpin(true);
    $('waitMain').textContent = 'Cancelling…';
    $('waitSub').textContent = 'Giving your buy-in back.';
    $('waitCancel').textContent = 'Back to the lobby';
    socket.emit('bs:unqueue');
    return;
  }
  toLobby();
});

/* SPECTATE, from a result card. The page reads its watch mark once, as it
   boots, so this does exactly what the lobby's Spectate does for this rung
   (public/js/v2/play.js spectate()): every money key out, the mark for this
   game, the rung in its own key for a paid table (dsWatchStake, never
   'stake'), then this page again, which comes up watching that rung. Nothing
   here seats anybody or stakes anything. Shut with Lobby while the wallet is
   open. A watcher's card asks for the next match instead. */
const WATCH_URL = '/battleship';
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
    sessionStorage.setItem('dsWatch', 'battleship');
    if (myStake > 0) sessionStorage.setItem('dsWatchStake', String(myStake));
    else sessionStorage.removeItem('dsWatchStake');
    /* Storage that will not hold the mark would reopen a Play: stay put. */
    if (sessionStorage.getItem('dsWatch') !== 'battleship') return;
  } catch (_) { return; }
  clearTimeout(watchTimer);
  socket.emit('bs:leave');
  reopen();
}
/* Play again on a watcher's card: a Free table is this page again with no
   mark (a Play, as the lobby's Free Play opens it); a paid table is bought
   in the lobby, so there it stays shut and says so. */
function playFromWatch() {
  if (WATCH_STAKE > 0) return;
  try {
    for (const k of MONEY_KEYS) sessionStorage.removeItem(k);
    sessionStorage.removeItem('dsWatch');
    sessionStorage.removeItem('dsWatchStake');
  } catch (_) {}
  clearTimeout(watchTimer);
  socket.emit('bs:unwatch');
  reopen();
}

/* ── BOTH BOARDS ON ONE SCREEN ───────────────────────────────────────────────
   Owen: "I want both of mine and the opponent's squares to fit on my one
   screen, I don't want to have to scroll."

   On a phone a board sized off the WIDTH is about 350px, and two of those is
   700px of board before any furniture. So on a narrow screen they are sized off
   what is LEFT: measure the strip, the bar, the dock and the two titles, halve
   the remainder, and cap the boards at that. They shrink rather than the page
   growing, which is the trade Owen offered.

   Measured rather than written into the stylesheet as a calc, because the
   furniture is not a fixed height — the dock is only there while placing, the
   safe-area inset differs per phone, and a font that renders a pixel taller
   moves all of it. The calc version got within eleven pixels, which is another
   way of saying it did not fit. */
function fitBoards() {
  /* ALWAYS, not just on a narrow screen. The guard here was max-width 760,
     which is exactly wrong for the case Owen asked about: a phone turned
     sideways is 880 by 400 — WIDE and short — so the fit never ran and the
     second board hung 74 pixels below the fold. Short matters as much as
     narrow. On a large screen the number it works out is bigger than the
     column anyway, so min(100%, --bmax) leaves the layout alone. */
  const boards = $('boards');
  if (!boards) return;
  const h = (el) => (el && !el.hidden ? el.offsetHeight : 0);
  const title = document.querySelector('.bt');
  const titles = title ? title.offsetHeight + 6 : 22;
  /* 10 for the gap between them, 6 top padding, and 8 of slack so a rounding
     error lands on the safe side of the fold rather than the wrong one. */
  /* The fleet sits UNDER the board now, so it takes height rather than width. */
  /* Watching, the watch bar sits where the fleet would and takes its height. */
  const dock = WATCH ? $('watchBar') : $('dock');
  const dockH = (dock && !dock.hidden) ? dock.offsetHeight + 12 : 0;
  const railW = 0;
  /* HOW MANY BOARDS ARE ACTUALLY ON SCREEN, which is not always two. While
     placing, the opponent's is hidden and yours has the lot — halving the
     height for a board with nothing beside it left it at two thirds the size it
     could have been, with the space it did not take sitting empty underneath.

     Upright they stack, so two of them share the HEIGHT. Turned sideways they
     sit in a row, so two of them share the WIDTH and each keeps the full
     height, which is the whole reason to turn the phone. */
  const placing = document.body.classList.contains('placing');
  const side = window.matchMedia('(orientation: landscape)').matches;
  const cols = (placing || !side) ? 1 : 2;
  const rows = (placing || side) ? 1 : 2;
  // The stage's own top padding too: without it the column ran 7 px past a 768-tall laptop and cut the dock's
  // "5 to place" line (site sweep 2026-10-28).
  const stagePad = parseFloat(getComputedStyle($('stage')).paddingTop) || 0;
  const avail = window.innerHeight - h($('top')) - dockH - titles * rows - 24 - stagePad;
  const byHeight = Math.floor(avail / rows);
  const byWidth = Math.floor((window.innerWidth - railW - 24) / cols) - 8;
  const max = Math.max(140, Math.min(byHeight, byWidth));
  const now = max + 'px';
  if (boards.style.getPropertyValue('--bmax') === now) return;   // no layout thrash
  boards.style.setProperty('--bmax', now);
}

window.addEventListener('resize', () => {
  fitRail();
  if (!WATCH && st && st.state === 'placing') buildTray();
  fitBoards();
  paint();
});
window.addEventListener('beforeunload', () => socket.emit(WATCH ? 'bs:unwatch' : 'bs:leave'));

/* ── watching ──────────────────────────────────────────────────────────────
   Somebody else's match. Everything below draws from spectatorView, by seat,
   and nothing here sends anything but bs:watch and bs:unwatch. */

/* Ask for a match. `after` is the one being left, so the server moves on from
   it rather than handing the same one back; dir 'prev' asks for the one before
   it instead of the one after. */
function watch(after, dir) {
  clearTimeout(watchTimer);
  const msg = after ? { after, stake: WATCH_STAKE } : { stake: WATCH_STAKE };
  if (after && dir === 'prev') msg.dir = 'prev';
  socket.emit('bs:watch', msg);
  publishWatch(watchMatch ? 'watching' : 'searching');
}

/* The Previous and Next of the shared bar: the match before or after this one,
   straight away, with nothing in between. The arrows rest until the answer
   comes (a second press waits for it), and open again on their own if it never
   does. */
function step(dir) {
  clearTimeout(watchTimer);
  clearTimeout(swapTimer);
  swapping = true;
  if (BAR) BAR.busy(true);
  swapTimer = setTimeout(() => { swapping = false; if (BAR) BAR.busy(false); }, WATCH_SWAP_MS);
  watch(watchMatch ? watchMatch.id : watchLastId, dir);
}

/* Moving on once this match is done: at once, or after a moment to read how it
   ended. */
function followOn(ms) {
  clearTimeout(watchTimer);
  if (ms > 0) watchTimer = setTimeout(() => watch(watchLastId), ms);
  else watch(watchLastId);
}

/* Nobody to follow: ask again in a moment, so the first match to start is picked
   up by itself. */
function nextSoon() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => watch(watchLastId), WATCH_NEXT_MS);
}

/* "A vs B" for the bar's plate, which holds 32 characters: a long name gives up
   its end (and a short one keeps all of its own) so the pair always fits. */
function vsLabel(names) {
  const room = 28;                                   // the plate's 32, less ' vs '
  const half = room / 2;
  const cut = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
  const a = String((names && names[0]) || 'Player').trim() || 'Player';
  const b = String((names && names[1]) || 'Player').trim() || 'Player';
  const x = a.length <= half ? a : b.length <= half ? cut(a, room - b.length) : cut(a, half);
  const y = b.length <= half ? b : a.length <= half ? cut(b, room - a.length) : cut(b, half);
  return x + ' vs ' + y;
}

/* What the page is doing, for a headless check to read without a screenshot. */
function publishWatch(mode) {
  try {
    window.__watch = {
      game: 'battleship', mode,
      matchId: watchMatch ? watchMatch.id : null,
      names: watchMatch ? watchMatch.names.slice() : [],
      index: watchMatch ? watchMatch.index : 0,
      count: watchMatch ? watchMatch.count : 0,
      stake: watchMatch ? watchMatch.stake : 0,
      state: st ? st.state : null,
    };
  } catch (_) {}
}

/* What just happened, in words, under the boards. */
function watchStatusText() {
  if (!st) return '';
  const placed = (st.players || []).filter(p => p.placed).map(p => p.name);
  if (st.state === 'placing') {
    return placed.length >= 2 ? 'Both fleets are placed'
      : placed.length === 1 ? placed[0] + ' has placed a fleet'
      : 'Both are placing their fleets';
  }
  if (st.state === 'countdown') return 'Starting';
  const ls = st.lastShot;
  const said = ls && ls.side !== null && ls.side !== undefined
    ? watchName(ls.side) + ' fired at ' + name(ls.cell) + '. '
      + (ls.sunk ? 'Sunk the ' + ls.sunk.name + '.' : ls.hit ? 'Hit.' : 'Miss.')
    : '';
  if (st.state === 'settling') return said || 'Fleet sunk';
  if (st.state === 'playing') return said || watchName(st.turn) + ' fires first';
  return said;
}

/* The line under the boards. Once the match is over it is the result, and stays. */
function paintWatch() {
  if (!overShown) $('watchStatus').textContent = watchStatusText();
  publishWatch(watchMatch ? 'watching' : 'searching');
}

/* One sound per shot, the same three a player hears. A late arrival's first
   view is not a shot. */
let _wShots = 0, _wSunk = 0;
function watchSound(view) {
  const S = window.BattleshipSound;
  const boards = (view && view.boards) || [];
  const shots = boards.reduce((n, b) => n + ((b && b.shots) || []).length, 0);
  const sunk = boards.reduce((n, b) => n + ((b && b.sunk) || []).length, 0);
  const had = _wShots, hadSunk = _wSunk;
  _wShots = shots; _wSunk = sunk;
  if (!S || !st || shots - had !== 1) return;
  if (sunk > hadSunk) { S.sunk(); return; }
  (view.lastShot && view.lastShot.hit) ? S.hit() : S.miss();
}

function watchState(view) {
  if (!view || (watchMatch && view.id !== watchMatch.id)) return;   // a straggler from the last match
  const was = st && st.state;
  watchSound(view);
  st = view;
  phaseEndsAt = Date.now() + (view.phaseMs || 0);

  $('wait').hidden = true;
  $('top').hidden = false;
  $('stage').hidden = false;
  $('dock').hidden = true;
  $('watchBar').hidden = false;
  chatShow(true);
  document.body.classList.toggle('firing', view.state === 'playing' || view.state === 'settling');
  if (view.state === 'countdown' && was !== 'countdown') runCountdown(view.phaseMs || 3000);

  paintTop();
  paintLive();
  paintClock();
  paintWatch();
  fitBoards();
  fitBoards();
  paint();
}

socket.on('bs:watching', (m) => {
  if (!WATCH || !m) return;
  clearTimeout(watchTimer);
  clearTimeout(swapTimer);
  const swap = swapping;
  swapping = false;
  if (!m.match || !m.state) {
    /* Nobody is playing (or every match has its fill of watchers): the empty
       table behind the bar, and an ask every few seconds so the first match to
       start is followed by itself. */
    watchMatch = null;
    st = null; overShown = false;
    $('top').hidden = true; $('stage').hidden = true; DSEnd.hide();
    clearInterval(countTimer); $('count').hidden = true;
    chatShow(false);
    if (BAR) BAR.empty();
    publishWatch(m.full ? 'full' : m.refused ? 'refused' : 'none');
    nextSoon();
    return;
  }

  /* Next with only one match running comes back with the same one. The boards
     on screen are that match, live, so they are left alone. */
  if (swap && watchMatch && st && !overShown && m.match.id === watchMatch.id) {
    watchMatch = m.match;
    if (BAR) BAR.watching(vsLabel(watchMatch.names));
    publishWatch('watching');
    return;
  }

  watchMatch = m.match;
  watchLastId = m.match.id;
  overShown = false;
  clearInterval(countTimer);
  $('count').hidden = true;
  st = null;
  _wShots = 0; _wSunk = 0;
  if (BAR) BAR.watching(vsLabel(watchMatch.names));
  watchState(m.state);
});

/* Where this match now sits among the ones running. */
socket.on('bs:matches', ({ index, count } = {}) => {
  if (!WATCH || !watchMatch) return;
  if (Number.isFinite(index)) watchMatch.index = index;
  if (Number.isFinite(count)) watchMatch.count = count;
  publishWatch('watching');
});

/* The match went away without a result. On to the next at once. */
socket.on('bs:ended', ({ id } = {}) => {
  if (!WATCH || overShown) return;
  if (watchMatch && id && id !== watchMatch.id) return;
  overShown = true;
  publishWatch('ended');
  followOn(0);
});

/* How it ended, on the line under the boards, and both fleets laid bare as the
   players get them; then on to the next match. No card: the arrows of the
   shared bar are there if the next match is wanted sooner. No money: nobody
   watching staked anything. */
function watchOver(m) {
  if (overShown) return;
  overShown = true;
  const side = m.winnerSide === 0 || m.winnerSide === 1 ? m.winnerSide : null;
  const shots = side !== null && Array.isArray(m.shots) ? (Number(m.shots[side]) || 0) : 0;
  const said = [m.winner ? m.winner + ' wins' : 'Draw'];
  if (side !== null) said.push(shots + ' ' + plural(shots, 'shot', 'shots'));
  if (m.why === 'opponent left') said.push((side !== null ? watchName(1 - side) : 'A player') + ' left the match');
  $('watchStatus').textContent = said.join('. ') + '.';

  /* Both fleets, now that it is over: the same reveal the players get. */
  if (Array.isArray(m.reveal) && st) {
    for (const r of m.reveal) {
      if (!r || (r.side !== 0 && r.side !== 1)) continue;
      drawBoard(watchCanvas(r.side), {
        ships: (r.ships || []).map(s => Object.assign({ len: (s.cells || []).length }, s)),
        marks: watchBoard(r.side).shots || [], aim: null, skin: r.skin || seatSkin(r.side),
      });
    }
  }
  publishWatch('over');
  followOn(WATCH_OVER_MS);
}

if (WATCH) {
  document.body.classList.add('watching');
  $('wait').hidden = true;                 // the bar speaks for a watcher, from the first moment
  if (BAR) {
    BAR.open({ game: 'battleship', stake: WATCH_STAKE, onPrev: () => step('prev'), onNext: () => step('next'), onLobby: toLobby,
      emptyArt: true });   // nobody playing: the card art behind the bar, not a blank page
    BAR.watching('Finding a match');
    BAR.busy(true);
  }
  publishWatch('searching');
}
