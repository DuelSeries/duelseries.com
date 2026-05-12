'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const FOOD_RADIUS = 8;
const GRID_SIZE   = 60;
const CAM_LERP    = 0.14;
const SCALE_LERP  = 0.08;
const POS_LERP    = 0.38; // per frame lerp toward server position

// ─── State ────────────────────────────────────────────────────────────────────
let canvas, ctx, socket;
let myId        = null;
let myName      = 'Player';
let myColor     = '#6366f1';
let lobbyType   = 'free';

let serverPlayers = new Map();
let renderPlayers = new Map();

let foods       = new Map();
let worldSize   = 6000;
let camX        = 3000, camY = 3000, camScale = 1;
let tgtCamX     = 3000, tgtCamY = 3000, tgtScale = 1;
let screenMX    = 0, screenMY = 0;
let animId      = null;
let lastTime    = 0;
let gameTime    = 0;
let fpsEl       = null;
let fpsFrames   = 0;
let fpsLast     = 0;

// Spectate
let spectating    = false;
let spectateIdx   = 0;

// Admin console
let consoleOpen   = false;

// Q cashout
let qHeld             = false;
let qStartTime        = 0;
let cashedOut         = false;
let waitingToRespawn  = false;
const Q_HOLD_MS = 3000;

// ─── Joystick state ───────────────────────────────────────────────────────────
let joystickActive = false;
let joystickAngle  = null;
let joystickTouchId = null;

// ─── Lobby navigation ─────────────────────────────────────────────────────────
function goToLobby() {
  if (window.self !== window.top) {
    window.parent.postMessage('game:done', '*');
  } else {
    sessionStorage.setItem('returnToAgarLobby', '1');
    window.location.href = '/';
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  canvas  = document.getElementById('game-canvas');
  ctx     = canvas.getContext('2d');
  myName    = sessionStorage.getItem('playerName')  || 'Player';
  myColor   = localStorage.getItem('duelseries_skin_color') || '#6366f1';
  lobbyType = sessionStorage.getItem('lobbyType') || 'free';

  resize();
  window.addEventListener('resize', resize);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const t = e.touches[0];
    onMouseMove({ clientX: t.clientX, clientY: t.clientY });
  }, { passive: false });
  window.addEventListener('keydown', e => {
    if (consoleOpen) return;
    if (e.code === 'Space') { e.preventDefault(); socket && socket.emit('cell:split'); }
    if (e.key === '`')      { e.preventDefault(); openConsole(); }
    if (e.code === 'KeyQ' && !e.repeat && !qHeld) {
      e.preventDefault();
      qHeld = true;
      qStartTime = Date.now();
      socket && socket.emit('cell:lock');
    }
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'KeyQ' && qHeld) {
      e.preventDefault();
      const elapsed = Date.now() - qStartTime;
      qHeld = false;
      if (elapsed >= Q_HOLD_MS) {
        doCashout();
      } else {
        socket && socket.emit('cell:unlock');
      }
    }
  });

  document.getElementById('btn-respawn').addEventListener('click', () => {
    cashedOut = false;
    waitingToRespawn = true;
    const titleEl = document.getElementById('death-title');
    titleEl.textContent = 'YOU WERE EATEN';
    titleEl.style.color = '';
    titleEl.style.textShadow = '';
    document.getElementById('death-earned-row').style.display = 'none';
    document.getElementById('death-screen').classList.remove('active');
    exitSpectate();
    socket && socket.emit('cell:respawn');
  });
  document.getElementById('btn-death-lobby').addEventListener('click', () => {
    socket && socket.disconnect();
    goToLobby();
  });

  // Cashout screen buttons
  document.getElementById('btn-cashout-respawn').addEventListener('click', () => {
    cashedOut = false;
    waitingToRespawn = true;
    document.getElementById('cashout-overlay').classList.remove('active');
    exitSpectate();
    socket && socket.emit('cell:respawn');
  });
  document.getElementById('btn-cashout-spectate').addEventListener('click', () => {
    document.getElementById('cashout-overlay').classList.remove('active');
    enterSpectate();
  });
  document.getElementById('btn-cashout-lobby').addEventListener('click', () => {
    socket && socket.disconnect();
    goToLobby();
  });

  // Spectate buttons
  document.getElementById('btn-spectate').addEventListener('click', enterSpectate);
  document.getElementById('spectate-prev').addEventListener('click', () => {
    const n = getSpectateTargets().length;
    if (!n) return;
    spectateIdx = (spectateIdx - 1 + n) % n;
    updateSpectateLabel();
  });
  document.getElementById('spectate-next').addEventListener('click', () => {
    const n = getSpectateTargets().length;
    if (!n) return;
    spectateIdx = (spectateIdx + 1) % n;
    updateSpectateLabel();
  });
  document.getElementById('spectate-play-again').addEventListener('click', () => {
    cashedOut = false;
    waitingToRespawn = true;
    const titleEl = document.getElementById('death-title');
    titleEl.textContent = 'YOU WERE EATEN';
    titleEl.style.color = '';
    titleEl.style.textShadow = '';
    document.getElementById('death-earned-row').style.display = 'none';
    exitSpectate();
    socket && socket.emit('cell:respawn');
  });
  document.getElementById('spectate-stop').addEventListener('click', () => {
    socket && socket.disconnect();
    goToLobby();
  });

  // Joystick
  const joyZone = document.getElementById('agar-joystick-zone');
  const joyBase = document.getElementById('agar-joystick-base');
  const joyKnob = document.getElementById('agar-joystick-knob');
  if (joyZone) {
    const onJoyStart = e => {
      e.preventDefault();
      if (joystickTouchId !== null) return;
      const t = e.changedTouches[0];
      joystickTouchId = t.identifier;
      joystickActive = true;
    };
    const onJoyEnd = e => {
      for (const t of e.changedTouches) {
        if (t.identifier !== joystickTouchId) continue;
        joystickTouchId = null;
        joystickActive = false;
        joystickAngle = null;
        joyKnob.style.transform = 'translate(-50%, -50%)';
      }
    };
    const onJoyMove = e => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== joystickTouchId) continue;
        const rect = joyBase.getBoundingClientRect();
        const ox = t.clientX - (rect.left + rect.width  / 2);
        const oy = t.clientY - (rect.top  + rect.height / 2);
        const dist = Math.sqrt(ox * ox + oy * oy);
        const maxR = rect.width / 2;
        const nx = ox / dist * Math.min(dist, maxR);
        const ny = oy / dist * Math.min(dist, maxR);
        joyKnob.style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;
        if (dist > 6) joystickAngle = Math.atan2(oy, ox);
      }
    };
    joyZone.addEventListener('touchstart',  onJoyStart, { passive: false });
    joyZone.addEventListener('touchmove',   onJoyMove,  { passive: false });
    joyZone.addEventListener('touchend',    onJoyEnd,   { passive: false });
    joyZone.addEventListener('touchcancel', onJoyEnd,   { passive: false });
  }

  // Mobile action buttons
  const splitBtn    = document.getElementById('agar-btn-split');
  const cashoutBtn  = document.getElementById('agar-btn-cashout');
  if (splitBtn) {
    splitBtn.addEventListener('touchstart', e => {
      e.preventDefault();
      socket && socket.emit('cell:split');
    }, { passive: false });
  }
  if (cashoutBtn) {
    cashoutBtn.addEventListener('touchstart', e => {
      e.preventDefault();
      if (cashedOut || qHeld) return;
      qHeld = true;
      qStartTime = Date.now();
      cashoutBtn.classList.add('holding');
      socket && socket.emit('cell:lock');
    }, { passive: false });
    const onCashoutRelease = e => {
      e.preventDefault();
      if (!qHeld) return;
      const elapsed = Date.now() - qStartTime;
      qHeld = false;
      cashoutBtn.classList.remove('holding');
      if (elapsed >= Q_HOLD_MS) {
        doCashout();
      } else {
        socket && socket.emit('cell:unlock');
      }
    };
    cashoutBtn.addEventListener('touchend',    onCashoutRelease, { passive: false });
    cashoutBtn.addEventListener('touchcancel', onCashoutRelease, { passive: false });
  }

  // Admin console input
  const adminInput = document.getElementById('admin-input');
  adminInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitConsole(); }
    if (e.key === 'Escape') { e.preventDefault(); closeConsole(); }
    e.stopPropagation(); // prevent space/` from leaking to game
  });

  connectSocket();
});

function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}

// ─── Mouse world coords ───────────────────────────────────────────────────────
function mouseWorld() {
  return {
    x: (screenMX - canvas.width  / 2) / camScale + camX,
    y: (screenMY - canvas.height / 2) / camScale + camY,
  };
}

function onMouseMove(e) {
  screenMX = e.clientX;
  screenMY = e.clientY;
  if (cashedOut) return;
  const mw = mouseWorld();
  socket && socket.volatile.emit('cell:input', { mouseX: mw.x, mouseY: mw.y });
}

// ─── Socket ───────────────────────────────────────────────────────────────────
function connectSocket() {
  socket = io();

  // ── Ping tracker ────────────────────────────────────────────────────────
  const pingDotEl   = document.getElementById('agar-ping-dot');
  const pingValueEl = document.getElementById('agar-ping-value');
  let pingSentAt = null;
  function sendPing() { pingSentAt = performance.now(); socket.emit('ping_check'); }
  socket.on('pong_check', () => {
    if (pingSentAt === null) return;
    const ms = Math.round(performance.now() - pingSentAt);
    pingSentAt = null;
    pingValueEl.textContent = ms + ' ms';
    pingDotEl.className = 'ping-dot ' + (ms < 50 ? 'ping-green' : ms < 100 ? 'ping-orange' : 'ping-red');
  });
  setInterval(sendPing, 2000);
  sendPing();

  // ── FPS counter ─────────────────────────────────────────────────────────
  fpsEl   = document.getElementById('agar-fps-counter');
  fpsLast = performance.now();

  socket.on('connect', () => {
    const lobbyType = sessionStorage.getItem('lobbyType') || 'free';
    const googleId  = sessionStorage.getItem('googleId') || '';
    socket.emit('cell:join', { name: myName, color: myColor, lobbyType, googleId });
  });

  socket.on('cell:join:error', ({ message }) => {
    alert(message);
    sessionStorage.setItem('returnToAgarLobby', '1');
    window.location.href = '/';
  });

  socket.on('cell:joined', ({ playerId, worldSize: ws, foods: initFoods, players: initPlayers }) => {
    myId = playerId; worldSize = ws;
    foods.clear();
    for (const f of initFoods) foods.set(f.id, f);

    serverPlayers.clear(); renderPlayers.clear();
    for (const p of initPlayers) {
      serverPlayers.set(p.id, p);
      renderPlayers.set(p.id, snapRenderPlayer(p));
    }

    const me = renderPlayers.get(myId);
    if (me && me.cells.length) {
      camX = me.cells[0].rx; camY = me.cells[0].ry;
      tgtCamX = camX; tgtCamY = camY;
      camScale = calcScale(massSum(me.cells)); tgtScale = camScale;
    }

    if (!animId) { lastTime = performance.now(); animId = requestAnimationFrame(loop); }
  });

  socket.on('cell:state', ({ players: updates, removedFoods, addedFoods }) => {
    for (const p of updates) {
      // Once cashed out, ignore server state for own player so cells stay gone
      if (p.id === myId && cashedOut) continue;
      serverPlayers.set(p.id, p);
      if (!renderPlayers.has(p.id)) {
        renderPlayers.set(p.id, snapRenderPlayer(p));
      } else {
        const rp = renderPlayers.get(p.id);
        rp.alive = p.alive; rp.score = p.score; rp.worth = p.worth || 0;
        // Snap if cell count changed (split / merge)
        if (rp.cells.length !== p.cells.length) {
          rp.cells = p.cells.map(c => ({ rx: c.x, ry: c.y, mass: c.mass }));
        }
      }
    }
    for (const fid of removedFoods) foods.delete(fid);
    for (const f  of addedFoods)    foods.set(f.id, f);

    const me = serverPlayers.get(myId);
    if (me && !cashedOut) {
      if (me.alive) {
        waitingToRespawn = false;
        if (!renderPlayers.has(myId)) renderPlayers.set(myId, snapRenderPlayer(me));
      } else {
        renderPlayers.delete(myId);
      }
    }
    renderIngameLb();
  });

  socket.on('cell:died', ({ killedBy, score }) => {
    renderPlayers.delete(myId); // hide own circle immediately
    if (!spectating && !cashedOut && !waitingToRespawn) {
      document.getElementById('death-score-val').textContent = score || 0;
      document.getElementById('death-screen').classList.add('active');
    }
  });

  socket.on('cell:playerJoined', ({ id, name, color, cells }) => {
    const p = { id, name, color, cells, alive: true, score: 0, worth: 0 };
    serverPlayers.set(id, p);
    renderPlayers.set(id, snapRenderPlayer(p));
  });

  socket.on('cell:playerLeft', ({ id }) => {
    serverPlayers.delete(id);
    renderPlayers.delete(id);
  });

  socket.on('cell:worldSize', ({ size }) => { worldSize = size; });

  socket.on('cell:cashout:result', ({ newBalance, earnedCad, score }) => {
    document.getElementById('death-score-val').textContent = score || 0;
    const earnedRow = document.getElementById('death-earned-row');
    const earnedVal = document.getElementById('death-earned-val');
    if (earnedCad > 0) {
      earnedVal.textContent = '$' + earnedCad.toFixed(2) + ' CAD';
      earnedRow.style.display = '';
    } else {
      earnedRow.style.display = 'none';
    }
  });

  socket.on('cell:cashout:error', ({ message }) => {
    alert('Cashout error: ' + message);
  });
}

// ─── In-game leaderboard ──────────────────────────────────────────────────────
function renderIngameLb() {
  const el = document.getElementById('hud-lb-rows');
  if (!el) return;
  const isPaid = lobbyType !== 'free';
  const alive  = [...serverPlayers.values()].filter(p => p.alive && p.cells && p.cells.length);
  alive.sort((a, b) => isPaid ? b.worth - a.worth : b.score - a.score);
  const top = alive.slice(0, 10);
  el.innerHTML = top.map((p, i) => {
    const isMe  = p.id === myId;
    const val   = isPaid ? '$' + (p.worth || 0).toFixed(3) : String(p.score || 0);
    const cls   = isMe ? 'hud-lb-row hud-lb-me' : 'hud-lb-row';
    const name  = escHtml((p.name || 'Player').slice(0, 16));
    return `<div class="${cls}"><span class="hud-lb-rank">#${i+1}</span><span class="hud-lb-name">${name}</span><span class="hud-lb-val">${val}</span></div>`;
  }).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function snapRenderPlayer(p) {
  return {
    id: p.id, name: p.name, color: p.color, alive: p.alive, score: p.score, worth: p.worth || 0,
    cells: p.cells.map(c => ({ rx: c.x, ry: c.y, mass: c.mass })),
  };
}

function calcScale(totalMass) {
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  const base = Math.min(2.2, shortSide / 500);
  return Math.max(0.15, Math.min(2.2, base * Math.pow(20 / totalMass, 0.25)));
}

function massSum(cells) { return cells.reduce((s, c) => s + (c.mass || c.mass || 0), 0); }

function radius(mass) { return Math.sqrt(mass) * 10; }

function centerOfMass(cells) {
  let tw = 0, cx = 0, cy = 0;
  for (const c of cells) {
    const m = c.mass || 0;
    cx += c.rx * m; cy += c.ry * m; tw += m;
  }
  return tw ? { x: cx / tw, y: cy / tw } : { x: worldSize / 2, y: worldSize / 2 };
}

// ─── Spectate ─────────────────────────────────────────────────────────────────
function getSpectateTargets() {
  return [...renderPlayers.values()].filter(p => p.id !== myId && p.alive && p.cells.length);
}

function enterSpectate() {
  spectating  = true;
  spectateIdx = 0;
  document.getElementById('death-screen').classList.remove('active');
  document.getElementById('spectate-bar').classList.add('active');
  updateSpectateLabel();
}

function exitSpectate() {
  spectating = false;
  document.getElementById('spectate-bar').classList.remove('active');
}

function updateSpectateLabel() {
  const targets = getSpectateTargets();
  const label   = document.getElementById('spectate-label');
  if (!targets.length) { label.textContent = 'No players to spectate'; return; }
  label.textContent = 'Spectating: ' + (targets[spectateIdx % targets.length].name || 'Player');
}

// ─── Admin console ────────────────────────────────────────────────────────────
function openConsole() {
  consoleOpen = true;
  document.getElementById('admin-console').classList.remove('hidden');
  document.getElementById('admin-input').value = '';
  document.getElementById('admin-input').focus();
}

function closeConsole() {
  consoleOpen = false;
  document.getElementById('admin-console').classList.add('hidden');
}

function submitConsole() {
  const raw   = document.getElementById('admin-input').value.trim();
  closeConsole();
  if (!raw) return;
  const parts = raw.split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  if (cmd === 'bot') {
    const count = Math.min(20, Math.max(1, parseInt(parts[1]) || 1));
    for (let i = 0; i < count; i++) socket && socket.emit('cell:spawnbot');
  }
}

// ─── Loop ─────────────────────────────────────────────────────────────────────
function doCashout() {
  cashedOut = true;
  const sp = serverPlayers.get(myId);
  const score = sp ? sp.score : 0;
  renderPlayers.delete(myId);
  if (sp) { sp.alive = false; sp.cells = []; }
  socket && socket.emit('cell:cashout');
  const titleEl = document.getElementById('death-title');
  titleEl.textContent = 'CASHED OUT';
  titleEl.style.color = '#14F195';
  titleEl.style.textShadow = '0 0 24px rgba(20,241,149,0.6)';
  document.getElementById('death-score-val').textContent = score || 0;
  document.getElementById('death-earned-row').style.display = 'none';
  document.getElementById('death-screen').classList.add('active');
}

function loop(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  gameTime += dt;

  if (qHeld && Date.now() - qStartTime >= Q_HOLD_MS) {
    qHeld = false;
    doCashout();
    animId = requestAnimationFrame(loop);
    return;
  }

  // Re-emit input every frame so the circle keeps moving
  if (socket && myId && !cashedOut) {
    if (joystickActive && joystickAngle !== null) {
      const me = renderPlayers.get(myId);
      const cx = me && me.cells.length ? me.cells[0].rx : camX;
      const cy = me && me.cells.length ? me.cells[0].ry : camY;
      const DIST = 2000;
      socket.volatile.emit('cell:input', { mouseX: cx + Math.cos(joystickAngle) * DIST, mouseY: cy + Math.sin(joystickAngle) * DIST });
    } else {
      const mw = mouseWorld();
      socket.volatile.emit('cell:input', { mouseX: mw.x, mouseY: mw.y });
    }
  }

  lerpPositions(dt);
  if (spectating) updateSpectateLabel();

  if (spectating) {
    const targets = getSpectateTargets();
    if (targets.length) {
      const t = targets[spectateIdx % targets.length];
      tgtCamX = centerOfMass(t.cells).x;
      tgtCamY = centerOfMass(t.cells).y;
      tgtScale = calcScale(massSum(t.cells));
    }
  } else {
    const me = renderPlayers.get(myId);
    if (me && me.alive && me.cells.length) {
      const com = centerOfMass(me.cells);
      tgtCamX = com.x; tgtCamY = com.y;
      tgtScale = calcScale(massSum(me.cells));
    }
  }

  camX     += (tgtCamX  - camX)     * CAM_LERP;
  camY     += (tgtCamY  - camY)     * CAM_LERP;
  camScale += (tgtScale - camScale) * SCALE_LERP;

  render();

  fpsFrames++;
  if (now - fpsLast >= 500) {
    fpsEl.textContent = 'FPS: ' + Math.round(fpsFrames * 1000 / (now - fpsLast));
    fpsFrames = 0; fpsLast = now;
  }

  animId = requestAnimationFrame(loop);
}

function lerpPositions(dt) {
  const alpha = 1 - Math.pow(1 - POS_LERP, dt * 60);
  for (const [id, rp] of renderPlayers) {
    const sp = serverPlayers.get(id);
    if (!sp || !sp.alive || rp.cells.length !== sp.cells.length) continue;
    for (let i = 0; i < rp.cells.length; i++) {
      const rc = rp.cells[i], sc = sp.cells[i];
      rc.rx   += (sc.x    - rc.rx)   * alpha;
      rc.ry   += (sc.y    - rc.ry)   * alpha;
      rc.mass += (sc.mass - rc.mass) * alpha;
    }
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = '#dde3f5';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(W / 2 - camX * camScale, H / 2 - camY * camScale);
  ctx.scale(camScale, camScale);

  ctx.fillStyle = '#f0f4ff';
  ctx.fillRect(0, 0, worldSize, worldSize);

  drawGrid();
  drawBorder();

  for (const f of foods.values()) {
    wavyArc(f.x, f.y, f.r || FOOD_RADIUS, gameTime, 0.2);
    ctx.fillStyle = f.color;
    ctx.fill();
  }

  // Other players under own cells
  for (const [id, rp] of renderPlayers) {
    if (id === myId || !rp.alive) continue;
    const cellCount = rp.cells.length || 1;
    const cellWorth = rp.worth / cellCount;
    const sorted = [...rp.cells].sort((a, b) => b.mass - a.mass);
    for (const cell of sorted) drawCell(cell, rp.color, rp.name, cellWorth);
  }

  const me = renderPlayers.get(myId);
  if (me && me.alive) {
    const meSp = serverPlayers.get(myId);
    const meWorth = meSp ? meSp.worth : 0;
    const cellCount = me.cells.length || 1;
    const cellWorth = meWorth / cellCount;
    const sorted = [...me.cells].sort((a, b) => b.mass - a.mass);
    for (const cell of sorted) drawCell(cell, myColor, myName, cellWorth);
  }

  if (qHeld && me && me.alive && me.cells.length) {
    drawQRing(me);
  }

  ctx.restore();
}

function drawQRing(me) {
  const progress = Math.min(1, (Date.now() - qStartTime) / Q_HOLD_MS);
  for (const cell of me.cells) {
    const r  = radius(cell.mass);
    const lw = Math.max(4, r * 0.09);
    ctx.save();
    ctx.strokeStyle = '#22c55e';
    ctx.shadowColor = '#22c55e';
    ctx.shadowBlur  = 14;
    ctx.lineWidth   = lw;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.arc(cell.rx, cell.ry, r + lw, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    ctx.stroke();
    ctx.restore();
  }
}

function drawGrid() {
  const left   = -canvas.width  / 2 / camScale + camX;
  const top    = -canvas.height / 2 / camScale + camY;
  const right  =  canvas.width  / 2 / camScale + camX;
  const bottom =  canvas.height / 2 / camScale + camY;

  const x0 = Math.floor(left   / GRID_SIZE) * GRID_SIZE;
  const y0 = Math.floor(top    / GRID_SIZE) * GRID_SIZE;
  const x1 = Math.ceil (right  / GRID_SIZE) * GRID_SIZE;
  const y1 = Math.ceil (bottom / GRID_SIZE) * GRID_SIZE;

  ctx.strokeStyle = 'rgba(99,102,241,0.13)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += GRID_SIZE) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
  for (let y = y0; y <= y1; y += GRID_SIZE) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
  ctx.stroke();
}

function drawBorder() {
  ctx.strokeStyle = 'rgba(99,102,241,0.5)';
  ctx.lineWidth   = 8;
  ctx.strokeRect(0, 0, worldSize, worldSize);
}

function wavyArc(cx, cy, r, t, amp) {
  const WAVES = 7;
  const AMP   = amp !== undefined ? amp : Math.max(0.4, r * 0.010);
  const steps = 72;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const a  = (i / steps) * Math.PI * 2;
    const wr = r + AMP * Math.sin(WAVES * a) * Math.sin(t * 60.0);
    i === 0
      ? ctx.moveTo(cx + wr * Math.cos(a), cy + wr * Math.sin(a))
      : ctx.lineTo(cx + wr * Math.cos(a), cy + wr * Math.sin(a));
  }
  ctx.closePath();
}

function drawCell(cell, color, name, worth) {
  const r = radius(cell.mass);

  wavyArc(cell.rx, cell.ry, r, gameTime);
  ctx.fillStyle = color;
  ctx.fill();

  wavyArc(cell.rx, cell.ry, r, gameTime);
  ctx.strokeStyle = darken(color, 0.28);
  ctx.lineWidth   = Math.max(2, r * 0.07);
  ctx.stroke();

  if (r > 18) {
    const hasWorth = worth > 0;
    const fs = Math.max(10, Math.min(r * 0.36, 28));
    const nameY = hasWorth ? cell.ry - fs * 0.35 : cell.ry;
    ctx.font         = `700 ${fs}px Inter, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = 'rgba(255,255,255,0.92)';
    ctx.fillText(name, cell.rx, nameY);
    if (hasWorth) {
      const wfs = Math.max(8, Math.min(r * 0.26, 20));
      ctx.font      = `600 ${wfs}px Inter, sans-serif`;
      ctx.fillStyle = 'rgba(255,230,100,0.95)';
      ctx.fillText('$' + worth.toFixed(3), cell.rx, cell.ry + fs * 0.55);
    }
  }
}

function darken(hex, amt) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, ((n >> 16) & 0xff) - Math.round(255 * amt));
  const g = Math.max(0, ((n >>  8) & 0xff) - Math.round(255 * amt));
  const b = Math.max(0, ( n        & 0xff) - Math.round(255 * amt));
  return `rgb(${r},${g},${b})`;
}
