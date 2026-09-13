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

const myName = (() => {
  try { return sessionStorage.getItem('playerName') || 'Player'; } catch (_) { return 'Player'; }
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
const myEntryToken = (() => {
  try { return sessionStorage.getItem('entryToken') || null; } catch (_) { return null; }
})();

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
    window.BattleshipArt.drawShip(ctx, s.key, s.len || shipLen(s), sx, sy, m.cell,
      s.horiz !== false, s.sunk ? 0.95 : 0.88);
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
  const placing = st.state === 'placing';

  /* My chart: my fleet, plus every shot they have taken at me. */
  drawBoard($('mine'), {
    ships: placing ? previewFleet() : st.myShips,
    marks: st.shotsOnMe,
    preview: dragging ? dropPreview() : null,
    aim: null,
  });

  /* Theirs: marks I have earned, and ships I have finished. */
  drawBoard($('theirs'), {
    ships: st.sunkOfTheirs.map(s => Object.assign({ sunk: true }, s)),
    marks: st.myShots,
    aim: aimed,
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
    window.BattleshipArt.drawShip(c2, spec.key, spec.len, 0, 0, cell, true, 1);

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
  if (!st || st.state !== 'placing') return;
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
  if (!st || st.state !== 'placing') return;
  e.preventDefault();
  turnShip();
});

$('mine').addEventListener('contextmenu', (e) => {
  if (!st || st.state !== 'placing') return;
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
  const show = !!st && st.state === 'placing'
    && (dragging !== null || layout.size < (st.fleet || []).length);
  $('rotFab').hidden = !show;
}

/* Nobody should have to place five ships by hand who does not want to. */
$('auto').addEventListener('click', () => {
  if (!st || st.state !== 'placing') return;
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
  if (!st || st.state !== 'placing') return;
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
  if (!st || st.state !== 'placing' || sentFleet) return;
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
  window.BattleshipArt.drawShip(c, d.key, d.len, 0, 0, cell, d.horiz, 0.92);
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
  if (cell === null || !st || !st.yourTurn) return false;
  socket.emit('bs:fire', { cell });
  aimed = null;
  paint();
  return true;
}

function aimOrFire(cell) {
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
  if (!st || !st.yourTurn) return;
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
  $('youName').textContent = st.you ? st.you.name : 'You';
  $('themName').textContent = st.them ? st.them.name : 'Opponent';
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
  if (st.state === 'placing') { lbl.textContent = 'Place'; }
  else if (st.state === 'playing') { lbl.textContent = st.yourTurn ? 'Your shot' : 'Their shot'; }
  else if (st.state === 'countdown') { lbl.textContent = 'Ready'; }
  else { lbl.textContent = ''; num.textContent = '—'; box.classList.remove('urgent'); return; }
  const left = Math.max(0, Math.ceil((phaseEndsAt - Date.now()) / 1000));
  num.textContent = String(left);
  box.classList.toggle('urgent', left <= 5);
}

let phaseEndsAt = 0;
setInterval(paintClock, 250);

/* ── the server ────────────────────────────────────────────────────────── */

socket.on('connect', () => queue());

function queue() {
  overShown = false;
  $('over').hidden = true;
  $('wait').hidden = false;
  $('waitMain').textContent = 'Looking for an opponent';
  $('waitSub').textContent = myStake > 0
    ? '$' + myStake.toFixed(2) + ' table. Waiting for a real opponent.'
    : 'Free table. Nothing staked.';
  socket.emit('bs:queue', { name: myName, wallet: myWallet, stake: myStake, entryToken: myEntryToken });
  /* One use only: re-sending it on a Play again would ask the server to spend a
     token it has already burned. */
  try { sessionStorage.removeItem('entryToken'); } catch (_) {}
}

/* WHAT JUST HAPPENED, AS A SOUND.

   Worked out by DIFFING the shots against the previous view rather than from an
   event, because the state message is the only thing that arrives: a shot
   landing on me and a shot landing on them both turn up as one more entry in a
   list. Comparing the counts says which, and whose, in two lines.

   Only ever one sound per message. A reconnect brings the whole board down at
   once and playing seventeen splashes into somebody's ear is not a summary of
   the match so far. */
let _sndMine = 0, _sndTheirs = 0, _sndSunk = 0;

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
  const first = !st;
  const wasPlacing = st && st.state === 'placing';
  soundFor(view);
  st = view;
  phaseEndsAt = Date.now() + (view.phaseMs || 0);

  $('wait').hidden = true;
  $('top').hidden = false;
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

socket.on('bs:refused', ({ why }) => {
  $('railMsg').textContent = why ? 'Refused: ' + why : 'That was refused.';
});

socket.on('bs:unqueued', ({ refunded, why } = {}) => {
  if (!refunded) return;
  $('wait').hidden = false;
  $('waitMain').textContent = 'Buy-in refunded';
  $('waitSub').textContent = why === 'nobody joined that table'
    ? 'Nobody joined that table, so your buy-in went back to your wallet.'
    : 'Your buy-in went back to your wallet.';
});

socket.on('bs:over', (m) => {
  if (overShown) return;
  overShown = true;
  $('overEyebrow').textContent = m.won === true ? 'Victory' : m.won === false ? 'Defeated' : 'Match over';
  const who = $('overWho');
  who.textContent = m.won === true ? 'You win' : m.won === false ? (m.winner || 'Your opponent') + ' wins' : 'Nobody won it';
  who.className = 'overWho' + (m.won === true ? ' won' : m.won === false ? ' lost' : '');
  $('overWhy').textContent = m.why === 'opponent left' ? 'They left the match.'
    : 'Fleet sunk in ' + (m.shots || 0) + ' shots.';

  /* Both fleets, now that it is over. Drawn onto the two charts so you can see
     where everything actually was, which is the thing everybody wants after a
     game of guessing. */
  if (Array.isArray(m.reveal) && st) {
    const mine = m.reveal.find(r => r.name === (st.you && st.you.name));
    const theirs = m.reveal.find(r => r !== mine);
    if (theirs) {
      drawBoard($('theirs'), {
        ships: theirs.ships.map(s => Object.assign({ len: s.cells.length }, s)),
        marks: st.myShots, aim: null,
      });
    }
    if (mine) {
      drawBoard($('mine'), {
        ships: mine.ships.map(s => Object.assign({ len: s.cells.length }, s)),
        marks: st.shotsOnMe, aim: null,
      });
    }
  }
  $('over').hidden = false;
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
  socket.emit('bs:leave');
  if (window.parent && window.parent !== window) window.parent.postMessage('game:done', '*');
  else location.href = '/';
}
$('waitCancel').addEventListener('click', toLobby);
$('lobbyBtn').addEventListener('click', toLobby);
$('againBtn').addEventListener('click', () => {
  socket.emit('bs:leave');
  $('over').hidden = true;
  $('top').hidden = true;
  $('stage').hidden = true;
  st = null; aimed = null; layout.clear(); sentFleet = false;
  _sndMine = 0; _sndTheirs = 0; _sndSunk = 0;
  queue();
});

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
  const dock = $('dock');
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
  const avail = window.innerHeight - h($('top')) - dockH - titles * rows - 24;
  const byHeight = Math.floor(avail / rows);
  const byWidth = Math.floor((window.innerWidth - railW - 24) / cols) - 8;
  const max = Math.max(140, Math.min(byHeight, byWidth));
  const now = max + 'px';
  if (boards.style.getPropertyValue('--bmax') === now) return;   // no layout thrash
  boards.style.setProperty('--bmax', now);
}

window.addEventListener('resize', () => {
  fitRail();
  if (st && st.state === 'placing') buildTray();
  fitBoards();
  paint();
});
window.addEventListener('beforeunload', () => socket.emit('bs:leave'));
