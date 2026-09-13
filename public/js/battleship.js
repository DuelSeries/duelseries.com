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

function buildTray() {
  const tray = $('tray');
  tray.innerHTML = '';
  for (const spec of (st.fleet || [])) {
    const el = document.createElement('div');
    el.className = 'trayShip' + (layout.has(spec.key) ? ' placed' : '');
    el.dataset.key = spec.key;

    const cell = 26;
    const cv = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = spec.len * cell * dpr;
    cv.height = cell * dpr;
    cv.style.width = (spec.len * cell) + 'px';
    cv.style.height = cell + 'px';
    const c2 = cv.getContext('2d');
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    window.BattleshipArt.drawShip(c2, spec.key, spec.len, 0, 0, cell, true, 1);

    const nm = document.createElement('span');
    nm.className = 'trayName';
    nm.textContent = spec.name;

    el.appendChild(cv);
    el.appendChild(nm);
    tray.appendChild(el);
  }
}

/* Picking a ship up, dragging it over the chart, and dropping it. Pointer
   events so a mouse and a finger are the same code. */
/* PICKING A SHIP UP.

   On a mouse this is a drag: press, move, release. On a finger it is a TAP —
   tap the ship, tap Turn as many times as you like, tap the square. Dragging
   with one finger while reaching for a rotate button with another works, but it
   is fiddly, and this is the same three taps without the holding.

   Both live in the same `dragging` object, so everything downstream — the
   ghost, the drop preview, the rotate — is one code path. `held` is the only
   thing that differs: a held ship stays picked up when the pointer lifts. */
$('tray').addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.trayShip');
  if (!el || !st || st.state !== 'placing') return;
  const key = el.dataset.key;
  const spec = (st.fleet || []).find(f => f.key === key);
  if (!spec) return;
  e.preventDefault();

  /* Already carrying this one? The tap puts it back down. */
  if (dragging && dragging.held && dragging.key === key) {
    clearHeld();
    return;
  }
  const touch = e.pointerType !== 'mouse';
  if (dragging && dragging.el) dragging.el.classList.remove('dragging');
  dragging = { key, len: spec.len, horiz, at: null, el, held: touch };
  el.classList.add('dragging');
  showGhost(e.clientX, e.clientY);
  paintRotFab();
  if (touch) $('dockMsg').textContent = spec.name + ' in hand. Tap a square to drop it.';
});

function clearHeld() {
  if (!dragging) return;
  if (dragging.el) dragging.el.classList.remove('dragging');
  dragging = null;
  hideGhost();
  buildTray();
  paint();
  paintRotFab();
  maybeSubmit();
}

/* A held ship lands on the square you tap. */
$('mine').addEventListener('click', (e) => {
  if (!dragging || !dragging.held || !st || st.state !== 'placing') return;
  const sq = squareAt($('mine'), e.clientX, e.clientY);
  if (!sq) return;
  const cells = cellsFor(sq.x, sq.y, dragging.len, dragging.horiz);
  if (!cells) { $('dockMsg').textContent = 'That hangs off the grid.'; return; }
  const used = occupied(dragging.key);
  if (cells.some(c => used.has(c))) { $('dockMsg').textContent = 'Something is already there.'; return; }
  layout.set(dragging.key, { x: sq.x, y: sq.y, horiz: dragging.horiz });
  clearHeld();
});

/* And it follows the finger between taps, so you can see where it will go. */
$('mine').addEventListener('pointermove', (e) => {
  if (!dragging || !dragging.held) return;
  const sq = squareAt($('mine'), e.clientX, e.clientY);
  dragging.at = sq;
  moveGhost(e.clientX, e.clientY);
  paint();
});

/* A ship already on the chart can be picked back up. */
$('mine').addEventListener('pointerdown', (e) => {
  if (!st || st.state !== 'placing' || dragging) return;
  const heldTap = e.pointerType !== 'mouse';
  const sq = squareAt($('mine'), e.clientX, e.clientY);
  if (!sq) return;
  for (const [key, pos] of layout) {
    const spec = (st.fleet || []).find(f => f.key === key);
    if (!spec) continue;
    const cells = cellsFor(pos.x, pos.y, spec.len, pos.horiz) || [];
    if (!cells.includes(sq.cell)) continue;
    e.preventDefault();
    layout.delete(key);
    horiz = pos.horiz;
    dragging = { key, len: spec.len, horiz: pos.horiz, at: null, el: null, held: heldTap };
    horiz = pos.horiz;
    buildTray();
    showGhost(e.clientX, e.clientY);
    paint();
    paintRotFab();
    if (heldTap) $('dockMsg').textContent = spec.name + ' in hand. Tap a square to drop it.';
    return;
  }
});

window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const sq = squareAt($('mine'), e.clientX, e.clientY);
  dragging.at = sq;
  moveGhost(e.clientX, e.clientY);
  paint();
});

window.addEventListener('pointerup', () => {
  if (!dragging) return;
  /* A held ship stays in hand when the finger lifts: that is the whole point
     of tapping rather than dragging. It is put down by tapping a square. */
  if (dragging.held) return;
  const d = dragging;
  hideGhost();
  if (d.el) d.el.classList.remove('dragging');
  dragging = null;

  const pv = d.at ? (() => {
    const cells = cellsFor(d.at.x, d.at.y, d.len, d.horiz);
    if (!cells) return null;
    const used = occupied(d.key);
    return cells.every(c => !used.has(c)) ? cells : null;
  })() : null;

  if (pv) layout.set(d.key, { x: d.at.x, y: d.at.y, horiz: d.horiz });
  buildTray();
  paint();
  paintRotFab();
  maybeSubmit();
});

/* TURNING A SHIP. Three ways in, one behaviour.

   The first version had a Rotate button in the dock that set a mode you had to
   decide BEFORE picking a ship up, which is backwards: you find out a ship does
   not fit while it is already in your hand. All three of these work mid-drag,
   and the ghost under the cursor turns with it, so the answer to "will this
   fit" is on screen while you are asking it.

   R is the one anybody who has played a game like this will try first.
   Right-click is the other. The button exists for the case where neither is
   available, which is a phone. */
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

/* Right-click anywhere on the board while placing. preventDefault so the
   browser menu does not open over the thing being turned. */
$('mine').addEventListener('contextmenu', (e) => {
  if (!st || st.state !== 'placing') return;
  e.preventDefault();
  turnShip();
});

$('rotFab').addEventListener('click', (e) => { e.preventDefault(); turnShip(); });
/* And on a touch screen the press itself has to turn it, because a finger that
   is already holding a ship never delivers a click to anything else. */
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

/* Somebody who does not want to place five ships by hand should not have to. */
$('auto').addEventListener('click', () => {
  if (!st || st.state !== 'placing') return;
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
   placed fleet IS ready, and a button that only ever gets pressed once the work
   is done is a button that exists to be forgotten. */
function maybeSubmit() {
  if (!st || st.state !== 'placing') return;
  if (layout.size !== (st.fleet || []).length) {
    $('dockMsg').textContent = ((st.fleet || []).length - layout.size) + ' still to place';
    return;
  }
  $('dockMsg').textContent = 'Fleet ready. Waiting for your opponent…';
  socket.emit('bs:place', {
    layout: [...layout.entries()].map(([key, p]) => ({ key, x: p.x, y: p.y, horiz: p.horiz })),
  });
}

/* ── the ghost under the cursor ────────────────────────────────────────── */

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

/* ── firing ────────────────────────────────────────────────────────────── */

/* AIM WHENEVER YOU LIKE, FIRE ON YOUR TURN.

   Owen: "while the other player is choosing their attack I want to be able to
   preselect where I want to shoot, and then once it's my turn I'll press
   confirm attack."

   That is also why the turn clock came down to ten seconds. Picking the square
   is the slow part and it now happens off the clock, so what is left on your
   own turn is pressing one button. */
$('theirs').addEventListener('click', (e) => {
  if (!st || (st.state !== 'playing' && st.state !== 'countdown')) return;
  const sq = squareAt($('theirs'), e.clientX, e.clientY);
  if (!sq) return;
  /* A square already fired at is not a target. The server refuses it too; this
     is so the crosshair never lands somewhere the Confirm will bounce off. */
  if ((st.myShots || []).some(m => m.cell === sq.cell)) {
    $('hint').textContent = 'You have already fired at ' + name(sq.cell) + '.';
    return;
  }
  aimed = sq.cell;
  paintBar();
  paint();
});

/* Aiming again clears an aim; tapping the same square twice is how somebody
   says "actually, not there". */


function fireAt(cell) {
  if (cell === null || !st || !st.yourTurn) return false;
  socket.emit('bs:fire', { cell });
  aimed = null;
  paintBar();
  paint();
  return true;
}

$('fire').addEventListener('click', () => { fireAt(aimed); });

/* Owen: "if I tap a slot twice then it would fire a shot there instead of
   dragging my mouse down to confirm every time."

   Only on your own turn, and only on a square you could actually fire at — a
   double-click out of turn still just leaves the square lined up, which is the
   same thing a single one does. Confirm stays for anybody who would rather not
   commit on a double-click. */
$('theirs').addEventListener('dblclick', (e) => {
  if (!st || !st.yourTurn) return;
  const sq = squareAt($('theirs'), e.clientX, e.clientY);
  if (!sq) return;
  if ((st.myShots || []).some(m => m.cell === sq.cell)) return;
  e.preventDefault();
  fireAt(sq.cell);
});

/* The same gesture with a finger. dblclick is unreliable on touch, so two taps
   on the same square inside half a second count. */
let lastTap = { cell: -1, at: 0 };
$('theirs').addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  if (!st || st.state !== 'playing') return;
  const sq = squareAt($('theirs'), e.clientX, e.clientY);
  if (!sq) return;
  const now = Date.now();
  const again = sq.cell === lastTap.cell && now - lastTap.at < 500;
  lastTap = { cell: sq.cell, at: now };
  if (!again || !st.yourTurn) return;
  if ((st.myShots || []).some(m => m.cell === sq.cell)) return;
  e.preventDefault();
  fireAt(sq.cell);
});

const name = (c) => LETTERS[c % GRID] + (Math.floor(c / GRID) + 1);

/* ── the furniture ─────────────────────────────────────────────────────── */

function paintBar() {
  if (!st) return;
  const fire = $('fire'), hint = $('hint');
  if (st.state === 'placing') {
    fire.disabled = true;
    hint.textContent = st.placed ? 'Fleet ready. Waiting for your opponent…'
      : 'Drag your five ships onto your waters.';
    return;
  }
  if (st.state === 'countdown') { fire.disabled = true; hint.textContent = 'Starting…'; return; }
  if (st.state === 'over' || st.state === 'settling') { fire.disabled = true; return; }

  if (st.yourTurn) {
    fire.disabled = aimed === null;
    fire.classList.toggle('ready', aimed !== null);
    hint.textContent = aimed === null
      ? 'Your shot. Pick a square on their waters.'
      : 'Attack ' + name(aimed) + '?';
  } else {
    fire.disabled = true;
    fire.classList.remove('ready');
    hint.textContent = aimed === null
      ? (st.them ? st.them.name : 'Your opponent') + ' is taking their shot. Line yours up now.'
      : name(aimed) + ' is lined up. Fires as soon as it is your shot.';
  }
}

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

socket.on('bs:state', (view) => {
  const first = !st;
  const wasPlacing = st && st.state === 'placing';
  st = view;
  phaseEndsAt = Date.now() + (view.phaseMs || 0);

  $('wait').hidden = true;
  $('top').hidden = false;
  $('boards').hidden = false;
  $('bar').hidden = false;
  $('dock').hidden = view.state !== 'placing';
  document.body.classList.toggle('firing', view.state === 'playing' || view.state === 'settling');
  /* The dock only exists while placing, and on a phone the two boards are
     sized off whatever height is left over, so the layout has to know. */
  document.body.classList.toggle('placing', view.state === 'placing');

  if (first) buildTray();
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
  fitBoards();
  fitBoards();
  paint();
});

let lastTurnWasMine = null;

socket.on('bs:refused', ({ why }) => {
  $('hint').textContent = why ? 'Refused: ' + why : 'That was refused.';
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
  $('bar').hidden = true;
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
  $('boards').hidden = true;
  st = null; aimed = null; layout.clear();
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
  const boards = $('boards');
  if (!boards || !window.matchMedia('(max-width: 760px)').matches) {
    if (boards) boards.style.removeProperty('--bmax');
    return;
  }
  const h = (el) => (el && !el.hidden ? el.offsetHeight : 0);
  const title = document.querySelector('.bt');
  const titles = title ? (title.offsetHeight + 4) * 2 : 44;
  /* 10 for the gap between them, 6 top padding, and 8 of slack so a rounding
     error lands on the safe side of the fold rather than the wrong one. */
  const avail = window.innerHeight - h($('top')) - h($('bar')) - h($('dock')) - titles - 30;
  const max = Math.max(140, Math.floor(avail / 2));
  const now = max + 'px';
  if (boards.style.getPropertyValue('--bmax') === now) return;   // no layout thrash
  boards.style.setProperty('--bmax', now);
}

window.addEventListener('resize', () => { fitBoards(); paint(); });
window.addEventListener('beforeunload', () => socket.emit('bs:leave'));
