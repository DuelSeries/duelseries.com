
// ─── Shared WebGL snake-body renderer for lobby previews/demo snakes ──────────
const _lobbyGL = (typeof SnakeGL !== 'undefined') ? (function(){ try { return new SnakeGL(); } catch(e){ return null; } })() : null;
function _lobbyParseColor(c) {
  let r=110,g=174,b=175;
  if (typeof c==='string' && c[0]==='#') {
    if (c.length===7){ r=parseInt(c.slice(1,3),16); g=parseInt(c.slice(3,5),16); b=parseInt(c.slice(5,7),16); }
    else if (c.length===4){ r=parseInt(c[1]+c[1],16); g=parseInt(c[2]+c[2],16); b=parseInt(c[3]+c[3],16); }
  }
  return { r, g, b };
}
// Render a snake body via GL onto ctx. pts: array of {x,y}, head first. Returns true if drawn.
function glSnakeBody(ctx, pts, R, colorHex) {
  if (!_lobbyGL || !_lobbyGL.ok || pts.length < 2) return false;
  _lobbyGL.ensureSize(ctx.canvas.width, ctx.canvas.height);
  const N = pts.length, segs = new Float32Array(N*2);
  for (let i=0;i<N;i++){ segs[i*2]=pts[i].x; segs[i*2+1]=pts[i].y; }
  const r = _lobbyGL.renderBody(segs, N, R, _lobbyParseColor(colorHex), 1);
  if (!r) return false;
  ctx.drawImage(_lobbyGL.canvas, 0, _lobbyGL.canvas.height - r.offH, r.offW, r.offH, r.minX, r.minY, r.bw, r.bh);
  return true;
}

// ─── Hex background ───────────────────────────────────────────────────────────
(function() {
  const canvas = document.getElementById('bg-canvas');
  const ctx = canvas.getContext('2d');

  const size    = 48;
  const gap     = 14.6;
  const colStep = Math.sqrt(3) * size + gap;
  const rowStep = 1.5 * size + Math.sqrt(3) / 2 * gap;
  const faceR   = size - gap / 2;
  const SCROLL_SPEED = 80; // px per second in grid space

  let W = window.innerWidth, H = window.innerHeight;
  let scrollX = 0, lastTime = null;

  window.addEventListener('resize', () => { W = window.innerWidth; H = window.innerHeight; });

  function hexPath(cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i + Math.PI / 6;
      ctx.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
    }
    ctx.closePath();
  }

  function draw(now) {
    if (lastTime !== null) scrollX = (scrollX + (now - lastTime) * SCROLL_SPEED / 1000) % colStep;
    lastTime = now;

    canvas.width  = W;
    canvas.height = H;

    ctx.fillStyle = 'rgb(15,25,38)';   // dark navy gap
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-0.285);
    ctx.scale(1.45, 1.45);
    ctx.translate(-W / 2, -H / 2);
    ctx.translate(scrollX, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';

    for (let row = -4; row < H / rowStep + 5; row++) {
      for (let col = -5; col < W / colStep + 6; col++) {
        const cx = col * colStep + (row % 2 === 1 ? colStep / 2 : 0);
        const cy = row * rowStep;

        // soft shadow (lower-left)
        hexPath(cx - faceR * 0.10, cy + faceR * 0.12, faceR);
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fill();

        // navy face — vertical gradient (light top -> dark bottom)
        hexPath(cx, cy, faceR);
        const face = ctx.createLinearGradient(cx, cy - faceR, cx, cy + faceR);
        face.addColorStop(0, 'rgb(35,49,70)');
        face.addColorStop(1, 'rgb(17,27,39)');
        ctx.fillStyle = face;
        ctx.fill();

        // black outline
        hexPath(cx, cy, faceR);
        ctx.strokeStyle = 'rgb(8,13,19)';
        ctx.lineWidth = faceR * 0.13;
        ctx.stroke();
      }
    }

    ctx.restore();
    hexBgRaf = requestAnimationFrame(draw);
  }

  let hexBgRaf = requestAnimationFrame(draw);
  window._pauseLobbyAnims  = () => { cancelAnimationFrame(hexBgRaf); hexBgRaf = null; };
  window._resumeLobbyAnims = () => { if (!hexBgRaf) hexBgRaf = requestAnimationFrame(draw); };
})();

// ─── Agar.io lobby background ─────────────────────────────────────────────────
(function() {
  const canvas = document.getElementById('bg-canvas-2');
  const ctx    = canvas.getContext('2d');
  const ZOOM   = 2.0;

  const PLAYER_DATA = [
    { r: 110, color: '#33CC33', name: ''          },
    { r:  88, color: '#00CCFF', name: ''          },
    { r:  70, color: '#FF2244', name: ''          },
    { r:  54, color: '#FF6600', name: ''          },
    { r:  38, color: '#CC33FF', name: ''          },
    { r:  24, color: '#FFCC00', name: ''          },
  ];
  const FOOD_COLORS = [
    '#FF2244','#FF6600','#FFCC00','#33CC33','#00CCFF',
    '#0055FF','#CC33FF','#FF33CC','#00EE88','#FF4488',
    '#FF3300','#66EE00','#00AAFF','#FFAA00',
  ];

  function darken(hex) {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${Math.max(0,(n>>16)-60)},${Math.max(0,((n>>8)&0xff)-60)},${Math.max(0,(n&0xff)-60)})`;
  }

  const cells = [];

  function placeCell(r, W, H) {
    const edge = r > 140 ? -r * 0.5 : r + 20;
    const edgeR = r > 140 ? W + r * 0.5 : W - r - 20;
    const edgeB = r > 140 ? H + r * 0.5 : H - r - 20;
    for (let attempt = 0; attempt < 150; attempt++) {
      const x = edge + Math.random() * (edgeR - edge);
      const y = edge + Math.random() * (edgeB - edge);
      let ok = true;
      for (const c of cells) {
        const dx = c.x - x, dy = c.y - y;
        if (Math.sqrt(dx*dx + dy*dy) < c.r + r + 12) { ok = false; break; }
      }
      if (ok) return { x, y };
    }
    return null;
  }

  function makeCells() {
    cells.length = 0;
    const W = canvas.width / ZOOM, H = canvas.height / ZOOM;

    // Player cells — defined sizes and colors
    for (const pd of PLAYER_DATA) {
      const pos = placeCell(pd.r, W, H);
      if (!pos) continue;
      const spd = 0.8 / Math.pow(pd.r / 25, 0.55); // bigger = slower
      cells.push({
        x: pos.x, y: pos.y,
        vx: (Math.random() - 0.5) * spd * 2,
        vy: (Math.random() - 0.5) * spd * 2,
        r: pd.r, color: pd.color, name: pd.name,
        baseSpeed: spd, isFood: false,
        fleeTimer: 0, chaseTarget: null,
      });
    }

    // Food pellets
    for (let i = 0; i < 85; i++) {
      const r = 5 + Math.random() * 7;
      const pos = placeCell(r, W, H);
      if (!pos) continue;
      cells.push({
        x: pos.x, y: pos.y,
        vx: 0, vy: 0,
        r, color: FOOD_COLORS[i % FOOD_COLORS.length],
        name: '', baseSpeed: 0, isFood: true,
        fleeTimer: 0, chaseTarget: null,
      });
    }
  }

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    makeCells();
  }

  function drawGrid(W, H) {
    const STEP = 50;
    ctx.save();
    ctx.strokeStyle = 'rgba(100,140,210,0.16)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = 0; x <= W; x += STEP) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 0; y <= H; y += STEP) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.restore();
  }

  function drawCell(cell) {
    const { x, y, r, color, name, isFood } = cell;

    wavyArc(ctx, x, y, r, cellGameTime, isFood ? 0.15 : undefined);
    ctx.fillStyle = color;
    ctx.fill();

    if (!isFood) {
      wavyArc(ctx, x, y, r, cellGameTime);
      ctx.strokeStyle = darken(color);
      ctx.lineWidth   = Math.max(2, r * 0.07);
      ctx.stroke();
    }

  }

  // ── AI: repulsion only — circles keep a wide personal space ─────────────
  function applyAI() {
    const players = cells.filter(c => !c.isFood);

    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i], b = players[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const nx = dx / dist, ny = dy / dist;

        // Soft repulsion — push apart when within personal space
        const repelD = (a.r + b.r) * 3.5;
        if (dist < repelD) {
          const force = ((repelD - dist) / repelD) * 0.06;
          a.vx -= nx * force; a.vy -= ny * force;
          b.vx += nx * force; b.vy += ny * force;
        }

        // Hard separation — never let them overlap
        const minD = a.r + b.r + 15;
        if (dist < minD) {
          const push = (minD - dist) / 2;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
          a.vx -= nx * 0.05; a.vy -= ny * 0.05;
          b.vx += nx * 0.05; b.vy += ny * 0.05;
        }

        // Cap speed after repulsion
        for (const c of [a, b]) {
          const spd = Math.hypot(c.vx, c.vy);
          if (spd > c.baseSpeed * 1.5) { c.vx *= c.baseSpeed * 1.5 / spd; c.vy *= c.baseSpeed * 1.5 / spd; }
        }
      }
    }
  }

  let rafId = null;
  let cellGameTime = 0, lastTickTime = null;

  function wavyArc(ctx, cx, cy, r, t, amp) {
    const WAVES = 7;
    const AMP   = amp !== undefined ? amp : Math.max(0.4, Math.min(1.5, r * 0.010));
    const steps = Math.max(72, Math.round(r * 1.2));
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

  function tick(t) {
    if (lastTickTime !== null) cellGameTime += (t - lastTickTime) / 1000;
    lastTickTime = t;
    const W = canvas.width, H = canvas.height;
    const WW = W / ZOOM, WH = H / ZOOM;

    ctx.fillStyle = '#eef2f7';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.scale(ZOOM, ZOOM);

    drawGrid(WW, WH);
    applyAI();

    // Sort so large cells render on top of small ones
    cells.sort((a, b) => a.r - b.r);

    for (const cell of cells) {
      // Move
      cell.x += cell.vx;
      cell.y += cell.vy;

      // Dampen
      cell.vx *= 0.992;
      cell.vy *= 0.992;

      // Gentle random drift every frame — keeps cells moving without sudden jolts
      if (!cell.isFood) {
        cell.vx += (Math.random() - 0.5) * cell.baseSpeed * 0.08;
        cell.vy += (Math.random() - 0.5) * cell.baseSpeed * 0.08;
        // Soft speed cap
        const spd = Math.hypot(cell.vx, cell.vy);
        if (spd > cell.baseSpeed) { cell.vx *= cell.baseSpeed / spd; cell.vy *= cell.baseSpeed / spd; }
      }

      // Wrap around world edges
      if (cell.x + cell.r < 0)   cell.x = WW + cell.r;
      if (cell.x - cell.r > WW)  cell.x = -cell.r;
      if (cell.y + cell.r < 0)   cell.y = WH + cell.r;
      if (cell.y - cell.r > WH)  cell.y = -cell.r;

      drawCell(cell);
    }

    ctx.restore();
    rafId = requestAnimationFrame(tick);
  }

  window.addEventListener('resize', resize);
  resize();

  window._agarBg = {
    start() { if (!rafId) rafId = requestAnimationFrame(tick); },
    stop()  { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } },
  };
})();

// ─── App ──────────────────────────────────────────────────────────────────────
const socket = io();
let account = null;
let walletAddress = null;

// ─── Login modal ──────────────────────────────────────────────────────────────
function showLoginModal() {
  document.getElementById('login-modal').classList.remove('hidden');
}
function hideLoginModal() {
  document.getElementById('login-modal').classList.add('hidden');
}
document.getElementById('btn-close-login-modal').addEventListener('click', hideLoginModal);
document.getElementById('login-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideLoginModal();
});
document.getElementById('btn-login-modal').addEventListener('click', showLoginModal);

// ─── Guest mode (not logged in) ───────────────────────────────────────────────
function showGuestMode() {
  const lockIds = ['btn-add-funds', 'btn-withdraw', 'btn-add-funds-2', 'btn-withdraw-2', 'btn-save-name', 'btn-save-name-2'];
  lockIds.forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('guest-locked'); });
  const nameInput  = document.getElementById('player-name');
  const nameInput2 = document.getElementById('player-name-2');
  if (nameInput)  { nameInput.disabled  = true; nameInput.placeholder  = 'Sign in to set a name'; }
  if (nameInput2) { nameInput2.disabled = true; nameInput2.placeholder = 'Sign in to set a name'; }
  const signout = document.querySelector('.btn-signout');
  if (signout) signout.style.display = 'none';
  showArrows();
}

// Check if logged in via Google session
fetch('/auth/me')
  .then(r => r.json())
  .then(({ loggedIn, account: acc }) => {
    if (loggedIn && acc) {
      account = acc;
      showLobby();
    } else {
      showGuestMode();
    }
  })
  .catch(() => { showGuestMode(); });

// Check for auth error param
if (new URLSearchParams(location.search).get('error') === 'auth') {
  alert('Google sign-in failed. Please try again.');
}

// ─── Region selection ─────────────────────────────────────────────────────────
let selectedRegion = localStorage.getItem('duelseries_region') || 'na';

function applyRegionSelection(region) {
  selectedRegion = region;
  localStorage.setItem('duelseries_region', region);
  document.querySelectorAll('[data-region]').forEach(el => {
    el.classList.toggle('region-selected', el.dataset.region === region);
  });
}

document.querySelectorAll('[data-region]').forEach(el => {
  el.style.cursor = 'pointer';
  el.addEventListener('click', () => applyRegionSelection(el.dataset.region));
});

applyRegionSelection(selectedRegion);

// ─── Socket ───────────────────────────────────────────────────────────────────
socket.on(CONSTANTS.EVENTS.LOBBY_STATE, ({ playerCount, lobbyCount, leaderboard, agarPlayerCount, agarLobbyCount, agarLeaderboard }) => {
  const ig = document.getElementById('stat-players-ingame');
  const il = document.getElementById('stat-players-inlobby');
  const b  = document.getElementById('stat-players-login');
  if (ig) ig.textContent = playerCount;
  if (il) il.textContent = lobbyCount ?? 0;
  if (b)  b.textContent  = (playerCount || 0) + (lobbyCount || 0);
  const ig2 = document.getElementById('stat-players-ingame-2');
  const il2 = document.getElementById('stat-players-inlobby-2');
  if (ig2) ig2.textContent = agarPlayerCount ?? 0;
  if (il2) il2.textContent = agarLobbyCount  ?? 0;
  updateLobbyLeaderboard(leaderboard);
});

socket.on(CONSTANTS.EVENTS.WALLET_BALANCE, ({ balance }) => {
  setBalance(balance);
});

socket.on(CONSTANTS.EVENTS.ERROR, ({ message }) => alert('Error: ' + message));

socket.on('connect', () => {
  if (account) socket.emit('lobby:join', { googleId: account.googleId });
});

// ─── Lobby navigation ─────────────────────────────────────────────────────────
let currentLobby = 1;
const lobbies = [
  document.getElementById('lobby-screen'),
  document.getElementById('lobby-screen-2'),
];
const arrowLeft  = document.getElementById('lobby-arrow-left');
const arrowRight = document.getElementById('lobby-arrow-right');

function showArrows() {
  arrowLeft.classList.add('visible');
  arrowRight.classList.add('visible');
}
function hideArrows() {
  arrowLeft.classList.remove('visible');
  arrowRight.classList.remove('visible');
}

const bgCanvas1   = document.getElementById('bg-canvas');
const bgCanvas2   = document.getElementById('bg-canvas-2');
const snakeCanvas = document.getElementById('snake-canvas');

function switchLobby(direction) {
  const total     = lobbies.length;
  const nextIndex = ((currentLobby - 1 + direction + total) % total);
  const current   = lobbies[currentLobby - 1];
  const next      = lobbies[nextIndex];

  const outClass = direction === 1 ? 'slide-out-left'  : 'slide-out-right';
  const inClass  = direction === 1 ? 'slide-in-right'  : 'slide-in-left';
  const goingToArena = nextIndex === 1;

  hideArrows();

  // Start agar animation before fade so it's ready
  if (goingToArena) window._agarBg.start();

  // Crossfade backgrounds simultaneously with the content slide
  if (goingToArena) {
    bgCanvas2.style.opacity = '1';
    bgCanvas1.style.opacity = '0';
    snakeCanvas.style.opacity = '0';
  } else {
    bgCanvas1.style.opacity = '1';
    snakeCanvas.style.opacity = '1';
    bgCanvas2.style.opacity = '0';
  }

  // Slide content
  current.classList.add(outClass);
  setTimeout(() => {
    current.classList.add('hidden');
    current.classList.remove(outClass);
    next.classList.remove('hidden');
    next.classList.add(inClass);

    // Stop agar after fade-out completes when leaving arena
    if (!goingToArena) setTimeout(() => window._agarBg.stop(), 650);

    setTimeout(() => {
      next.classList.remove(inClass);
      // Tint arrows for light vs dark background
      document.querySelectorAll('.lobby-nav-arrow').forEach(a => {
        a.dataset.theme = goingToArena ? 'light' : 'dark';
      });
      showArrows();
    }, 340);
  }, 320);

  currentLobby = nextIndex + 1;
}

arrowRight.addEventListener('click', () => switchLobby(1));
arrowLeft.addEventListener('click',  () => switchLobby(-1));

// ─── Swipe to switch lobby (mobile) ───────────────────────────────────────────
(function() {
  let swipeStartX = null, swipeStartY = null;
  const SWIPE_MIN = 50, SWIPE_MAX_Y = 80;
  document.addEventListener('touchstart', (e) => {
    // Ignore touches on interactive elements
    if (e.target.closest('button, input, select, a, .modal-overlay')) return;
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (swipeStartX === null) return;
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const dy = e.changedTouches[0].clientY - swipeStartY;
    swipeStartX = null;
    if (Math.abs(dx) < SWIPE_MIN || Math.abs(dy) > SWIPE_MAX_Y) return;
    switchLobby(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

// ─── Lobby UI ─────────────────────────────────────────────────────────────────
function showLobby() {
  hideLoginModal();
  showArrows();

  document.getElementById('stat-highscore').textContent   = account.highScore     || 0;
  document.getElementById('stat-games').textContent       = account.gamesPlayed   || 0;
  document.getElementById('stat-highscore-2').textContent = account.agarHighScore   || 0;
  document.getElementById('stat-games-2').textContent     = account.agarGamesPlayed || 0;
  const savedName = account.name || localStorage.getItem('duelseries_playername') || '';
  document.getElementById('player-name').value          = savedName;
  document.getElementById('topbar-name').textContent    = account.name || '';

  // Topbar avatar
  const tav = document.getElementById('topbar-avatar');
  if (account.avatar) { tav.src = account.avatar; }
  document.getElementById('topbar-user').classList.remove('hidden');
  document.getElementById('topbar-login-btn').classList.add('hidden');
  document.getElementById('topbar-username').textContent = account.name || '';

  // Populate lobby 2 fields with same data
  const savedName2 = account.name || localStorage.getItem('duelseries_playername') || '';
  document.getElementById('player-name-2').value = savedName2;

  setBalance(account.balance || 0);
  socket.emit('lobby:join', { googleId: account.googleId });
  fetchGlobalWinnings();

  // Jump straight to lobby 2 if returning from the agar game — no animation
  if (sessionStorage.getItem('returnToAgarLobby') === '1') {
    sessionStorage.removeItem('returnToAgarLobby');
    lobbies[0].classList.add('hidden');
    lobbies[1].classList.remove('hidden');
    bgCanvas2.style.opacity = '1';
    bgCanvas1.style.opacity = '0';
    snakeCanvas.style.opacity = '0';
    document.querySelectorAll('.lobby-nav-arrow').forEach(a => { a.dataset.theme = 'light'; });
    showArrows();
    window._agarBg.start();
    currentLobby = 2;
  }
}

function fetchGlobalWinnings() {
  fetch('/api/stats/winnings')
    .then(r => r.json())
    .then(({ totalCad }) => {
      const display = `C$${(totalCad || 0).toFixed(2)}`;
      const el  = document.getElementById('stat-global-winnings');
      const el2 = document.getElementById('stat-global-winnings-2');
      if (el)  el.textContent  = display;
      if (el2) el2.textContent = display;
    })
    .catch(() => {});
}

// Strip spaces as the user types
['player-name', 'player-name-2'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => {
    const pos = el.selectionStart;
    el.value = el.value.replace(/\s/g, '');
    el.setSelectionRange(pos, pos);
    // Mirror both inputs
    const other = id === 'player-name' ? 'player-name-2' : 'player-name';
    document.getElementById(other).value = el.value;
  });
});

function setNameMsg(el, text, type) {
  el.textContent = text;
  el.classList.toggle('is-error',   type === 'error');
  el.classList.toggle('is-success', type === 'success');
}

async function saveName(inputId, errorId, btnId) {
  const input   = document.getElementById(inputId);
  const msgEl   = document.getElementById(errorId);
  const btn     = document.getElementById(btnId);
  const name    = input.value.replace(/[^a-zA-Z0-9]/g, '');
  setNameMsg(msgEl, '', '');
  if (!name) { setNameMsg(msgEl, 'Name cannot be empty.', 'error'); return; }
  btn.disabled = true;
  try {
    const res  = await fetch('/auth/update-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = (data.error || '').toLowerCase().includes('taken')
        ? 'This name is already taken.'
        : (data.error || 'Could not save name.');
      setNameMsg(msgEl, msg, 'error');
      return;
    }
    account = data.account;
    document.getElementById('player-name').value           = account.name;
    document.getElementById('player-name-2').value         = account.name;
    document.getElementById('topbar-name').textContent     = account.name;
    document.getElementById('topbar-username').textContent = account.name;
    setNameMsg(document.getElementById('name-error'),   'Successfully saved!', 'success');
    setNameMsg(document.getElementById('name-error-2'), 'Successfully saved!', 'success');
    setTimeout(() => {
      setNameMsg(document.getElementById('name-error'),   '', '');
      setNameMsg(document.getElementById('name-error-2'), '', '');
    }, 3000);
  } catch { setNameMsg(msgEl, 'Network error. Try again.', 'error'); }
  finally  { btn.disabled = false; }
}

document.getElementById('btn-save-name').addEventListener('click',   () => saveName('player-name',   'name-error',   'btn-save-name'));
document.getElementById('btn-save-name-2').addEventListener('click', () => saveName('player-name-2', 'name-error-2', 'btn-save-name-2'));

// Strip symbols as the player types — only letters and numbers allowed
['player-name', 'player-name-2'].forEach(id => {
  document.getElementById(id).addEventListener('input', function() {
    const pos = this.selectionStart;
    const cleaned = this.value.replace(/[^a-zA-Z0-9]/g, '');
    if (this.value !== cleaned) {
      this.value = cleaned;
      this.setSelectionRange(pos - 1, pos - 1);
    }
  });
});

let _lobbyEarnings = []; // cached top earners for lobby leaderboard

function refreshEarningsBoard() {
  fetch('/api/earningsboard')
    .then(r => r.json())
    .then(data => {
      _lobbyEarnings = data;
      renderLobbyLeaderboard();
    }).catch(() => {});
}

function renderLobbyLeaderboard() {
  const el = document.getElementById('lobby-leaderboard');
  if (!el) return;
  if (!_lobbyEarnings.length) {
    el.innerHTML = '<li><span class="lb-name" style="color:#555">No earnings yet</span></li>';
    return;
  }
  el.innerHTML = _lobbyEarnings.slice(0, 3).map(p => {
    const cad = p.earnings * (_solCadRate || 200);
    return `<li><span class="rank">#${p.rank}</span><span class="lb-name">${escHtml(p.name)}</span><span class="lb-score" style="color:#14F195">C$${cad.toFixed(2)}</span></li>`;
  }).join('');
}

// ─── Agar earnings leaderboard (separate from snake) ─────────────────────────
let _agarEarnings = [];

function refreshAgarEarningsBoard() {
  fetch('/api/agar-earningsboard')
    .then(r => r.json())
    .then(data => { _agarEarnings = data; renderAgarLeaderboard(); })
    .catch(() => {});
}

function renderAgarLeaderboard() {
  const el = document.getElementById('lobby2-leaderboard');
  if (!el) return;
  if (!_agarEarnings.length) {
    el.innerHTML = '<li><span class="lb-name" style="color:#9ca3af">No earnings yet</span></li>';
    return;
  }
  el.innerHTML = _agarEarnings.slice(0, 3).map(p => {
    const cad = p.earnings * (_solCadRate || 200);
    return `<li><span class="rank">#${p.rank}</span><span class="lb-name">${escHtml(p.name)}</span><span class="lb-score" style="color:#14F195">C$${cad.toFixed(2)}</span></li>`;
  }).join('');
}

refreshAgarEarningsBoard();
setInterval(refreshAgarEarningsBoard, 30000);

// refresh earnings leaderboard every 30 seconds
refreshEarningsBoard();
setInterval(refreshEarningsBoard, 30000);

// store rate for CAD conversion
let _solCadRate = 200;
fetch('/api/prices').then(r => r.json()).then(d => { if (d.solCadRate) _solCadRate = d.solCadRate; }).catch(() => {});

function updateLobbyLeaderboard(lb) {
  // live lobby state now just triggers a re-render of earnings board
  renderLobbyLeaderboard();
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── All-Time Leaderboard Modal (lobby) ───────────────────────────────────────
(function() {
  const openBtn  = document.getElementById('btn-lobby-leaderboard');
  const modal    = document.getElementById('modal-lobby-leaderboard');
  const closeBtn = document.getElementById('close-lobby-leaderboard');
  const listEl   = document.getElementById('lobby-alltime-list');
  if (!openBtn || !modal) return;

  openBtn.addEventListener('click', () => {
    modal.style.display = 'flex';
    listEl.innerHTML = '<li style="color:#555">Loading…</li>';
    fetch('/api/earningsboard')
      .then(r => r.json())
      .then(data => {
        if (!data.length) { listEl.innerHTML = '<li style="color:#555">No earnings recorded yet</li>'; return; }
        listEl.innerHTML = data.map(p => {
          const cad = (p.earnings * (_solCadRate || 200)).toFixed(2);
          return `<li><span class="al-rank">#${p.rank}</span>` +
            `<span class="al-name">${escHtml(p.name)}</span>` +
            `<span class="al-score" style="color:#14F195">C$${cad}</span></li>`;
        }).join('');
      })
      .catch(() => { listEl.innerHTML = '<li style="color:#c33">Failed to load</li>'; });
  });

  closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
})();

// ─── Wallet ───────────────────────────────────────────────────────────────────
let walletInfo = null;
let solPriceUsd = null;

fetch('/wallet/info').then(r => r.json()).then(info => {
  if (info && info.escrowAddress) walletInfo = info;
}).catch(() => {});

// Fetch SOL/CAD price once, then refresh balance display with correct CAD value
fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=cad')
  .then(r => r.json())
  .then(d => {
    solPriceUsd = d?.solana?.cad || null;
    if (account) setBalance(account.balance || 0);
  })
  .catch(() => {});

function setBalance(bal) {
  const sol = parseFloat(bal) || 0;
  if (account) account.balance = sol;
  const cadStr = solPriceUsd !== null ? 'CA$' + (sol * solPriceUsd).toFixed(2) : 'CA$—';
  const solStr = sol.toFixed(4) + ' SOL';
  // Update both lobbies
  ['game-balance', 'game-balance-2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = solStr;
  });
  ['game-balance-usd', 'game-balance-usd-2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = cadStr;
  });
  const sb = document.getElementById('sidebar-balance');
  if (sb) sb.textContent = sol.toFixed(4);
}

function walletStatus(msg, isError) {
  ['wallet-status', 'wallet-status-2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; el.style.color = isError ? '#ff6666' : '#14F195'; }
  });
}

fetch('/auth/me').then(r => r.json()).then(({ account: acc }) => {
  if (acc) setBalance(acc.balance || 0);
});

document.getElementById('btn-refresh-balance').addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh-balance');
  btn.textContent = '↻ Checking...';
  btn.disabled = true;
  try {
    const res = await fetch('/wallet/deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.status === 202) {
      // No new deposit — just refresh balance from account
      const meRes = await fetch('/auth/me');
      const { account: acc } = await meRes.json();
      if (acc) setBalance(acc.balance || 0);
      walletStatus('Balance up to date');
    } else {
      const data = await res.json();
      if (data.error) {
        walletStatus(data.error, true);
      } else {
        setBalance(data.balance);
        walletStatus(`Deposit received: ${data.amount.toFixed(4)} SOL ✓`);
      }
    }
  } catch (e) {
    walletStatus('Refresh failed', true);
  }
  btn.textContent = '↻ Refresh';
  btn.disabled = false;
});

// ─── Add Funds ────────────────────────────────────────────────────────────────
let depositPollTimer = null;

function stopDepositPoll() {
  if (depositPollTimer) { clearInterval(depositPollTimer); depositPollTimer = null; }
}

async function pollForDeposit() {
  const statusEl = document.getElementById('deposit-status');
  try {
    const res = await fetch('/wallet/deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.status === 401) {
      stopDepositPoll();
      statusEl.style.color = '#ff6666';
      statusEl.textContent = 'Session expired — please refresh the page.';
      return;
    }
    if (res.status === 202) return; // no deposit yet, keep waiting
    const data = await res.json();
    if (data.error) { console.warn('[deposit poll]', data.error); return; }
    // Deposit found!
    stopDepositPoll();
    setBalance(data.balance);
    statusEl.style.color = '#14F195';
    statusEl.textContent = `Received ${data.amount.toFixed(4)} SOL ✓`;
    walletStatus(`Deposit received: ${data.amount.toFixed(4)} SOL ✓`);
    setTimeout(() => document.getElementById('modal-receive').classList.remove('active'), 2500);
  } catch (e) { /* network hiccup, keep waiting */ }
}

document.getElementById('btn-add-funds').addEventListener('click', async () => {
  let addr = account?.walletAddress;
  if (!addr) {
    walletStatus('Setting up your wallet...', false);
    try {
      const r = await fetch('/wallet/provision', { method: 'POST', credentials: 'include' });
      const d = await r.json();
      if (!d.address) { walletStatus(d.error || 'Wallet setup failed — try again.', true); return; }
      if (account) account.walletAddress = d.address;
      addr = d.address;
    } catch (e) {
      walletStatus('Wallet setup failed — try again.', true); return;
    }
  }
  document.getElementById('receive-address-short').textContent = addr.slice(0, 6) + '...' + addr.slice(-4);
  const statusEl = document.getElementById('deposit-status');
  statusEl.style.color = '#555';
  statusEl.textContent = 'Waiting for your deposit...';

  const qrEl = document.getElementById('receive-qr');
  qrEl.innerHTML = '';
  // Solana Pay URL — Phantom scans this and opens with recipient pre-filled
  const solanaPayUrl = `solana:${addr}?label=DuelSeries&message=Add%20Funds%20to%20DuelSeries`;
  new QRCode(qrEl, {
    text: solanaPayUrl,
    width: 190,
    height: 190,
    colorDark: '#ffffff',
    colorLight: '#141828',
    correctLevel: QRCode.CorrectLevel.M,
  });
  document.getElementById('modal-receive').classList.add('active');

  // Poll immediately, then every 12 seconds while modal is open
  stopDepositPoll();
  pollForDeposit();
  depositPollTimer = setInterval(pollForDeposit, 12000);
});

document.getElementById('btn-check-now').addEventListener('click', () => {
  document.getElementById('deposit-status').style.color = '#aaa';
  document.getElementById('deposit-status').textContent = 'Checking...';
  pollForDeposit();
});

document.getElementById('close-receive').addEventListener('click', () => {
  stopDepositPoll();
  document.getElementById('modal-receive').classList.remove('active');
});
document.getElementById('modal-receive').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) { stopDepositPoll(); document.getElementById('modal-receive').classList.remove('active'); }
});

document.getElementById('btn-copy-address').addEventListener('click', () => {
  if (!account?.walletAddress) return;
  navigator.clipboard.writeText(account.walletAddress).then(() => {
    const btn = document.getElementById('btn-copy-address');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
});

// ─── Withdraw ─────────────────────────────────────────────────────────────────
function openWithdrawModal() {
  const balEl = document.getElementById('withdraw-balance-display');
  if (balEl && solPriceUsd && account) {
    balEl.textContent = 'CA$' + (account.balance * solPriceUsd).toFixed(2);
  }
  document.getElementById('modal-withdraw').classList.add('active');
}
document.getElementById('btn-withdraw').addEventListener('click', openWithdrawModal);
document.getElementById('cancel-withdraw').addEventListener('click', () =>
  document.getElementById('modal-withdraw').classList.remove('active'));
document.getElementById('modal-withdraw').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) document.getElementById('modal-withdraw').classList.remove('active');
});

document.getElementById('withdraw-max').addEventListener('click', () => {
  const bal = account?.balance || 0;
  const maxCad = solPriceUsd ? Math.floor(bal * solPriceUsd * 100) / 100 : 0;
  document.getElementById('withdraw-amount').value = maxCad > 0 ? maxCad : '';
  document.getElementById('withdraw-amount').dispatchEvent(new Event('input'));
});

document.getElementById('withdraw-amount').addEventListener('input', () => {
  const cad = parseFloat(document.getElementById('withdraw-amount').value);
  const preview = document.getElementById('withdraw-cad-preview');
  if (cad > 0 && solPriceUsd) {
    preview.textContent = '≈ ' + (cad / solPriceUsd).toFixed(4) + ' SOL';
  } else {
    preview.textContent = '';
  }
});

document.getElementById('confirm-withdraw').addEventListener('click', async () => {
  const walletAddress = document.getElementById('withdraw-wallet').value.trim();
  const cadAmount = parseFloat(document.getElementById('withdraw-amount').value);
  if (!walletAddress) { alert('Enter your Phantom or Coinbase wallet address.'); return; }
  if (!cadAmount || cadAmount <= 0) return;
  if (!solPriceUsd) { walletStatus('Price data not loaded — try again.', true); return; }
  const amount = Math.floor((cadAmount / solPriceUsd) * 10000) / 10000;

  document.getElementById('modal-withdraw').classList.remove('active');
  walletStatus('Processing withdrawal...');

  try {
    const res = await fetch('/wallet/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, walletAddress }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    setBalance(data.balance);
    walletStatus(`Withdrew CA$${cadAmount.toFixed(2)} ✓`);
  } catch (e) {
    walletStatus('Withdrawal failed: ' + (e.message || e), true);
  }
  document.getElementById('withdraw-amount').value = '';
  document.getElementById('withdraw-wallet').value = '';
  document.getElementById('withdraw-cad-preview').textContent = '';
});

// ─── Lobby 2 wallet buttons (share same modals/functions as lobby 1) ──────────
document.getElementById('btn-refresh-balance-2').addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh-balance-2');
  btn.textContent = '↻ Checking...';
  btn.disabled = true;
  try {
    const res = await fetch('/wallet/deposit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    if (res.status === 202) {
      const meRes = await fetch('/auth/me');
      const { account: acc } = await meRes.json();
      if (acc) setBalance(acc.balance || 0);
      walletStatus('Balance up to date');
    } else {
      const data = await res.json();
      if (data.error) walletStatus(data.error, true);
      else { setBalance(data.balance); walletStatus(`Deposit received: ${data.amount.toFixed(4)} SOL ✓`); }
    }
  } catch (e) { walletStatus('Refresh failed', true); }
  btn.textContent = '↻ Refresh';
  btn.disabled = false;
});

document.getElementById('btn-add-funds-2').addEventListener('click', () =>
  document.getElementById('btn-add-funds').click()
);
document.getElementById('btn-withdraw-2').addEventListener('click', openWithdrawModal);

// ─── Lobby 2 lobby type selection ─────────────────────────────────────────────
const LOBBY_LABELS_2 = { free: 'FREE PLAY', dime: '▶ 10¢ LOBBY', dollar: '▶ $1 LOBBY' };
let selectedLobbyType2 = localStorage.getItem('duelseries_lobbytype2') || 'free';

(function restoreLobby2Selection() {
  const btn = document.querySelector(`.btn-lobby-type-2[data-type="${selectedLobbyType2}"]`);
  if (btn) {
    document.querySelectorAll('.btn-lobby-type-2').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const pb = document.getElementById('btn-play-2');
    if (pb) pb.textContent = (selectedLobbyType2 === 'free' ? '▶ ' : '') + LOBBY_LABELS_2[selectedLobbyType2];
  }
})();

document.querySelectorAll('.btn-lobby-type-2').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btn-lobby-type-2').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedLobbyType2 = btn.dataset.type;
    localStorage.setItem('duelseries_lobbytype2', selectedLobbyType2);
    const pb = document.getElementById('btn-play-2');
    pb.textContent = (selectedLobbyType2 === 'free' ? '▶ ' : '') + LOBBY_LABELS_2[selectedLobbyType2];
  });
});

document.getElementById('btn-play-2').addEventListener('click', async () => {
  if (!account) { showLoginModal(); return; }
  const name = document.getElementById('player-name-2').value.replace(/[^a-zA-Z0-9]/g, '');
  if (!name || name.length < 3) {
    setNameMsg(document.getElementById('name-error-2'), 'Choose a name (3+ characters) to play.', 'error');
    return;
  }
  if (account && name !== account.name) {
    const r = await fetch('/auth/update-name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const d = await r.json();
    if (d.error) { setNameMsg(document.getElementById('name-error-2'), d.error, 'error'); return; }
    account.name = d.account.name;
  }

  // Deduct entry fee for paid lobbies
  let entryToken = '';
  if (selectedLobbyType2 !== 'free') {
    const feeRes = await fetch('/wallet/entry-fee', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lobbyType: selectedLobbyType2 }) });
    const feeData = await feeRes.json();
    if (feeData.error) {
      const errEl = document.getElementById('play-error-2');
      if (errEl) { errEl.textContent = feeData.error; setTimeout(() => { errEl.textContent = ''; }, 3000); }
      else alert(feeData.error);
      return;
    }
    entryToken = feeData.entryToken || '';
    if (account) account.balance = feeData.balance;
    setBalance(feeData.balance);
  }

  localStorage.setItem('duelseries_playername', name);
  sessionStorage.setItem('playerName',    name);
  sessionStorage.setItem('walletAddress', account?.walletAddress || '');
  sessionStorage.setItem('googleId',      account?.googleId || '');
  sessionStorage.setItem('lobbyType',     selectedLobbyType2);
  sessionStorage.setItem('gameMode',      'cell');
  sessionStorage.setItem('entryToken',    entryToken);
  sessionStorage.setItem('region',        selectedRegion);
  sessionStorage.removeItem('spectateOnly');
  const agarFrame = document.getElementById('agar-frame');
  if (window._pauseLobbyAnims) window._pauseLobbyAnims();
  agarFrame.src = '/agar.html';
  agarFrame.style.display = 'block';
  agarFrame.addEventListener('load', () => {
    try { agarFrame.contentWindow.focus(); } catch (e) {}
  }, { once: true });
});

document.getElementById('player-name-2').addEventListener('input', function() {
  this.value = this.value.replace(/\s/g, '');
  const v = this.value;
  if (v) localStorage.setItem('duelseries_playername', v);
  document.getElementById('play-username-2').textContent = v || '';
});

// ─── Save custom name to localStorage as user types ───────────────────────────
document.getElementById('player-name').addEventListener('input', function() {
  this.value = this.value.replace(/\s/g, '');
  const v = this.value;
  if (v) localStorage.setItem('duelseries_playername', v);
  document.getElementById('play-username').textContent = v || '';
});

// ─── Lobby type selection ──────────────────────────────────────────────────────
const LOBBY_LABELS = { free: 'FREE PLAY', dime: '▶ 10¢ LOBBY', dollar: '▶ $1 LOBBY' };
let selectedLobbyType = localStorage.getItem('duelseries_lobbytype') || 'free';

// Restore saved selection on page load
(function restoreLobbySelection() {
  const btn = document.querySelector(`.btn-lobby-type[data-type="${selectedLobbyType}"]`);
  if (btn) {
    document.querySelectorAll('.btn-lobby-type').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const playBtn = document.getElementById('btn-play');
    if (playBtn) playBtn.textContent = (selectedLobbyType === 'free' ? '▶ ' : '') + LOBBY_LABELS[selectedLobbyType];
  }
})();

document.querySelectorAll('.btn-lobby-type').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btn-lobby-type').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedLobbyType = btn.dataset.type;
    localStorage.setItem('duelseries_lobbytype', selectedLobbyType);
    const playBtn = document.getElementById('btn-play');
    playBtn.textContent = (selectedLobbyType === 'free' ? '▶ ' : '') + LOBBY_LABELS[selectedLobbyType];
    window.dispatchEvent(new CustomEvent('duel:lobbychange', { detail: selectedLobbyType }));
  });
});

// ─── Play ─────────────────────────────────────────────────────────────────────
document.getElementById('btn-play').addEventListener('click', async () => {
  if (!account) { showLoginModal(); return; }
  const gameFrame = document.getElementById('game-frame');
  if (gameFrame && gameFrame.style.display !== 'none') return; // already in game
  const name = document.getElementById('player-name').value.replace(/[^a-zA-Z0-9]/g, '');
  if (!name || name.length < 3) {
    setNameMsg(document.getElementById('name-error'), 'Choose a name (3+ characters) to play.', 'error');
    return;
  }
  if (account && name !== account.name) {
    const r = await fetch('/auth/update-name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const d = await r.json();
    if (d.error) { setNameMsg(document.getElementById('name-error'), d.error, 'error'); return; }
    account.name = d.account.name;
  }

  // ── Phase 4a: self-custody — paid lobbies stake from the connected wallet ──────
  // If a self-custody wallet is connected, route paid play through it (the widget stakes +
  // launches). Free lobbies, and players without a connected wallet, fall through to the
  // custodial flow below.
  if (selectedLobbyType !== 'free' && window.duelWallet && window.duelWallet.authenticated && window.duelWallet.address) {
    localStorage.setItem('duelseries_playername', name);
    window.dispatchEvent(new CustomEvent('duel:play', { detail: selectedLobbyType }));
    return;
  }

  // Deduct entry fee for paid lobbies
  let entrySol = 0, entryToken = '';
  if (selectedLobbyType !== 'free') {
    const feeRes = await fetch('/wallet/entry-fee', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lobbyType: selectedLobbyType }) });
    const feeData = await feeRes.json();
    if (feeData.error) {
      const errEl = document.getElementById('play-error');
      if (errEl) { errEl.textContent = feeData.error; setTimeout(() => { errEl.textContent = ''; }, 3000); }
      return;
    }
    entrySol = feeData.feeSol;
    entryToken = feeData.entryToken || '';
    if (account) account.balance = feeData.balance;
    setBalance(feeData.balance);
  }

  localStorage.setItem('duelseries_playername', name);
  sessionStorage.setItem('playerName',    name);
  sessionStorage.setItem('walletAddress', account?.walletAddress || '');
  sessionStorage.setItem('googleId',      account?.googleId || '');
  sessionStorage.setItem('snakeColor',    localStorage.getItem('duelseries_skin_color') || '#E8756A');
  sessionStorage.setItem('hatId',         localStorage.getItem('duelseries_hat_id')   || 'none');
  sessionStorage.setItem('boostId',       localStorage.getItem('duelseries_boost_id') || 'default');
  sessionStorage.setItem('lobbyType',     selectedLobbyType);
  sessionStorage.setItem('entrySol',      entrySol);
  sessionStorage.setItem('entryToken',    entryToken);
  sessionStorage.setItem('region',        selectedRegion);
  sessionStorage.removeItem('spectateOnly');
  // Load game in iframe so fullscreen stays active
  if (window._pauseLobbyAnims) window._pauseLobbyAnims();
  gameFrame.src = '/game.html';
  gameFrame.style.display = 'block';
  document.getElementById('btn-play').blur(); // prevent spacebar re-firing this button
  gameFrame.addEventListener('load', () => {
    try { gameFrame.contentWindow.focus(); } catch (e) {}
  }, { once: true });
});

// ─── Spectate from lobby ──────────────────────────────────────────────────────
document.getElementById('btn-spectate-lobby').addEventListener('click', () => {
  const gameFrame = document.getElementById('game-frame');
  if (gameFrame && gameFrame.style.display !== 'none') return;
  sessionStorage.setItem('spectateOnly', 'true');
  sessionStorage.setItem('lobbyType', selectedLobbyType);
  sessionStorage.setItem('region', selectedRegion);
  if (window._pauseLobbyAnims) window._pauseLobbyAnims();
  gameFrame.src = '/game.html';
  gameFrame.style.display = 'block';
});

document.getElementById('btn-spectate-lobby-2').addEventListener('click', () => {
  const agarFrame = document.getElementById('agar-frame');
  if (agarFrame && agarFrame.style.display !== 'none') return;
  sessionStorage.setItem('spectateOnly', 'true');
  sessionStorage.setItem('lobbyType', selectedLobbyType2);
  sessionStorage.setItem('region', selectedRegion);
  if (window._pauseLobbyAnims) window._pauseLobbyAnims();
  agarFrame.src = '/agar.html';
  agarFrame.style.display = 'block';
});

// ─── Customize / Appearance Screen ───────────────────────────────────────────
(function() {
  const SKINS = [
    { id: 'coral',   name: 'Coral Red',  color: '#E8756A', locked: false },
    { id: 'teal',    name: 'Teal',       color: '#4FC3C3', locked: false },
    { id: 'gold',    name: 'Gold',       color: '#F5C842', locked: false },
    { id: 'pink',    name: 'Pink',       color: '#E87FD4', locked: false },
    { id: 'purple',  name: 'Purple',     color: '#8B5CF6', locked: false },
    { id: 'cyan',    name: 'Cyan',       color: '#22D3EE', locked: false },
    { id: 'green',   name: 'Emerald',    color: '#10B981', locked: false },
    { id: 'orange',  name: 'Orange',     color: '#F97316', locked: false },
    { id: 'blue',    name: 'Blue',       color: '#3B82F6', locked: false },
    { id: 'crimson', name: 'Crimson',    color: '#EF4444', locked: true  },
    { id: 'mint',    name: 'Mint',       color: '#6EE7B7', locked: true  },
    { id: 'indigo',  name: 'Indigo',     color: '#6366F1', locked: true  },
    { id: 'rose',    name: 'Rose',       color: '#FB7185', locked: true  },
    { id: 'amber',   name: 'Amber',      color: '#F59E0B', locked: true  },
    { id: 'sky',     name: 'Sky',        color: '#38BDF8', locked: true  },
    { id: 'lime',    name: 'Lime',       color: '#84CC16', locked: true  },
    { id: 'galaxy',  name: 'Galaxy',     color: '#7C3AED', locked: true  },
    { id: 'shadow',  name: 'Shadow',     color: '#374151', locked: true  },
  ];

  const HATS = [
    { id: 'none',    name: 'No Hat',      locked: false },
    { id: 'crown',   name: 'Crown',       locked: false },
    { id: 'tophat',  name: 'Top Hat',     locked: false },
    { id: 'cap',     name: 'Cap',         locked: false },
    { id: 'wizard',  name: 'Wizard Hat',  locked: true  },
    { id: 'cowboy',  name: 'Cowboy Hat',  locked: true  },
    { id: 'party',   name: 'Party Hat',   locked: true  },
    { id: 'halo',    name: 'Halo',        locked: true  },
  ];

  const BOOSTS = [
    { id: 'default',   name: 'Default',       locked: false },
    { id: 'fire',      name: 'Fire Trail',     locked: false },
    { id: 'ice',       name: 'Ice Trail',      locked: false },
    { id: 'rainbow',   name: 'Rainbow',        locked: true  },
    { id: 'lightning', name: 'Lightning',      locked: true  },
    { id: 'smoke',     name: 'Smoke Trail',    locked: true  },
    { id: 'stars',     name: 'Star Burst',     locked: true  },
    { id: 'galaxy',    name: 'Galaxy Trail',   locked: true  },
  ];

  const CATS = { skins: SKINS, hats: HATS, boosts: BOOSTS };

  let equippedId  = localStorage.getItem('duelseries_skin_id')  || 'coral';
  let equippedHat = localStorage.getItem('duelseries_hat_id')   || 'none';
  let equippedBoost = localStorage.getItem('duelseries_boost_id') || 'default';

  let previewBycat = {
    skins:  Math.max(0, SKINS.findIndex(s => s.id === equippedId)),
    hats:   Math.max(0, HATS.findIndex(h => h.id === equippedHat)),
    boosts: Math.max(0, BOOSTS.findIndex(b => b.id === equippedBoost)),
  };

  let apCat      = 'skins';
  let apMode     = 'inventory';
  let apAnimT    = 0;
  let apAnimRaf  = null;
  let apSrcLobby = 1;
  let miniAnimT  = 0;
  let miniAnimRaf = null;

  // The change-appearance preview snake animates at 60fps on a canvas (and resizes it
  // every frame, forcing a reflow). It was left running while the game iframe is up —
  // stealing the shared main thread and tanking the game's framerate. Extend the
  // global lobby pause/resume (the background module defines the originals) so these
  // preview animations also stop during gameplay and restart on return.
  (function () {
    const _origPause  = window._pauseLobbyAnims;
    const _origResume = window._resumeLobbyAnims;
    window._pauseLobbyAnims = () => {
      if (_origPause) _origPause();
      if (miniAnimRaf) { cancelAnimationFrame(miniAnimRaf); miniAnimRaf = null; }
      if (apAnimRaf)   { cancelAnimationFrame(apAnimRaf);   apAnimRaf = null; }
    };
    window._resumeLobbyAnims = () => {
      if (_origResume) _origResume();
      if (!miniAnimRaf && document.getElementById('customize-preview')) startMiniAnim();
    };
  })();

  // ── Shared drawing helpers ───────────────────────────────────────────────────
  function drawMiniSnake(canvas, color) {
    const W = canvas.width  = canvas.offsetWidth  || 400;
    const H = canvas.height = canvas.offsetHeight || 130;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const R  = Math.max(9, H * 0.085);
    const cx = W * 0.78, cy = H * 0.5;
    const amp = H * 0.22, freq = 0.055, step = 3.5;
    const N = Math.floor((W * 0.85) / step);

    const pts = [];
    for (let i = 0; i < N; i++) {
      pts.push({ x: cx - i * step, y: cy + Math.sin(i * freq) * amp });
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const hx = pts[0].x, hy = pts[0].y;
    const ang = Math.atan2(pts[0].y - pts[1].y, pts[0].x - pts[1].x);

    // Body via WebGL shader (same look as in-game); falls back to flat style
    const glDrawn = glSnakeBody(ctx, pts, R, color);
    if (!glDrawn) {
      ctx.beginPath();
      ctx.moveTo(pts[N-1].x, pts[N-1].y);
      for (let i = N-2; i >= 1; i--) {
        const mx = (pts[i].x + pts[i-1].x) / 2, my = (pts[i].y + pts[i-1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.lineTo(pts[0].x, pts[0].y);
      ctx.lineWidth = R * 2; ctx.strokeStyle = color; ctx.stroke();
      ctx.beginPath(); ctx.arc(hx, hy, R, 0, Math.PI*2); ctx.fillStyle = color; ctx.fill();
    }

    // Eyes (drawn on top in 2D either way)
    const fwdX = Math.cos(ang), fwdY = Math.sin(ang);
    const perpX = -Math.sin(ang), perpY = Math.cos(ang);
    const eyeR = R * 0.38, pupilR = eyeR * 0.60;
    const eyeSide = R * 0.43, eyeFwd = R * 0.40;
    for (const s of [-1, 1]) {
      const ex = hx + fwdX*eyeFwd + perpX*eyeSide*s;
      const ey = hy + fwdY*eyeFwd + perpY*eyeSide*s;
      ctx.beginPath(); ctx.arc(ex, ey, eyeR, 0, Math.PI*2);
      ctx.fillStyle = '#FFFFFF'; ctx.fill();
      const ps = eyeR - pupilR;
      ctx.beginPath(); ctx.arc(ex + fwdX*ps, ey + fwdY*ps, pupilR, 0, Math.PI*2);
      ctx.fillStyle = '#060606'; ctx.fill();
    }
    ctx.restore();
  }

  function darkenHex(hex) {
    const n = parseInt(hex.replace('#',''), 16);
    return `rgb(${Math.max(0,(n>>16)-60)},${Math.max(0,((n>>8)&0xff)-60)},${Math.max(0,(n&0xff)-60)})`;
  }

  function drawMiniCell(canvas, color) {
    const W = canvas.width  = canvas.offsetWidth  || canvas.width  || 100;
    const H = canvas.height = canvas.offsetHeight || canvas.height || 100;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const r = Math.min(W, H) * 0.38;
    const cx = W / 2, cy = H / 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    // Dark border
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = darkenHex(color);
    ctx.lineWidth = r * 0.08; ctx.stroke();
  }

  // Short snake that slithers in place inside the lobby change-appearance box —
  // same animated renderer as the customize screen, just shorter to fit fully.
  function startMiniAnim() {
    const c1 = document.getElementById('customize-preview');
    if (!c1) return;
    if (miniAnimRaf) cancelAnimationFrame(miniAnimRaf);
    function loop() {
      const skin = SKINS.find(s => s.id === equippedId) || SKINS[0];
      drawAnimSnake(c1, skin.color, miniAnimT, equippedHat, equippedBoost, { spanFrac: 0.19, ampFrac: 0.13 });
      miniAnimT += 0.022;
      miniAnimRaf = requestAnimationFrame(loop);
    }
    loop();
  }

  function refreshMiniCanvas() {
    const skin = SKINS.find(s => s.id === equippedId) || SKINS[0];
    if (!miniAnimRaf) startMiniAnim();   // animated, reads the equipped skin each frame
    const c2 = document.getElementById('customize-preview-2');
    if (c2) drawMiniCell(c2, skin.color);
  }

  // ── Animated snake for the appearance screen ─────────────────────────────────
  function drawAnimSnake(canvas, color, t, hatId, boostId, opts) {
    opts = opts || {};
    const W = canvas.width  = canvas.offsetWidth  || 520;
    const H = canvas.height = canvas.offsetHeight || 260;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const N  = opts.N || 80;
    const R  = Math.min(W * 0.068, H * 0.13);
    const cx = W / 2, cy = H / 2;
    const spanX = W * (opts.spanFrac != null ? opts.spanFrac : 0.28); // half-length of the body
    const amp   = H * (opts.ampFrac  != null ? opts.ampFrac  : 0.16); // wave amplitude

    // Horizontal snake: head (pts[0]) on right, tail (pts[N-1]) on left
    const pts = [];
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1); // 0=head, 1=tail
      pts.push({
        x: cx + spanX * (1 - u * 2),
        y: cy + Math.sin(u * Math.PI * 1.4 - t * 2) * amp * (0.3 + u * 0.7),
      });
    }

    // Boost trail — drawn BEFORE body so snake renders on top
    if (boostId && boostId !== 'default') {
      const tdx = pts[N-1].x-pts[N-2].x, tdy = pts[N-1].y-pts[N-2].y;
      const tlen = Math.sqrt(tdx*tdx+tdy*tdy)||1;
      const sX = tdx/tlen, sY = tdy/tlen;
      const pX = -sY, pY = sX;
      // Trail starts inside the body (BODY_STEPS back from tail tip) so snake covers it
      const BODY_STEPS = 7, TRAIL_STEPS = 22;
      const tp = [];
      for (let i=0;i<BODY_STEPS+TRAIL_STEPS;i++) {
        const step=i-BODY_STEPS; // negative=inside body, 0=tail tip, positive=outside
        const tx=pts[N-1].x+sX*step*tlen, ty=pts[N-1].y+sY*step*tlen;
        const ef=Math.max(0, Math.min(1, tx/(R*2.5), (W-tx)/(R*2.5), ty/(R*2.5), (H-ty)/(R*2.5)));
        const f=Math.max(0, 1-Math.max(0,step)/TRAIL_STEPS); // 1 at tail tip→0 at end, 1 inside body
        tp.push({x:tx, y:ty, ef, f});
      }

      if (boostId==='fire') {
        ctx.save(); ctx.globalCompositeOperation='lighter';
        for (let i=0;i<tp.length;i++){const fade=tp[i].f*tp[i].ef,flk=0.75+0.25*Math.sin(t*14+i*1.3); ctx.fillStyle=`rgba(200,15,0,${(fade*0.35).toFixed(2)})`; ctx.beginPath(); ctx.arc(tp[i].x,tp[i].y,R*1.3*fade*flk,0,Math.PI*2); ctx.fill(); ctx.fillStyle=`rgba(255,80,0,${(fade*0.55).toFixed(2)})`; ctx.beginPath(); ctx.arc(tp[i].x,tp[i].y,R*0.75*fade*flk,0,Math.PI*2); ctx.fill(); ctx.fillStyle=`rgba(255,220,0,${(fade*0.75).toFixed(2)})`; ctx.beginPath(); ctx.arc(tp[i].x,tp[i].y,R*0.35*fade,0,Math.PI*2); ctx.fill();}
        for (let i=0;i<tp.length;i+=2){const fade=tp[i].f*tp[i].ef; ctx.fillStyle=`rgba(255,160,0,${(fade*0.95).toFixed(2)})`; ctx.beginPath(); ctx.arc(tp[i].x+pX*Math.sin(t*5+i*2.3)*R*1.1,tp[i].y+pY*Math.sin(t*5+i*2.3)*R*1.1,R*0.13*fade,0,Math.PI*2); ctx.fill();}
        ctx.restore();
      } else if (boostId==='ice') {
        ctx.save(); ctx.globalCompositeOperation='lighter';
        for (let i=0;i<tp.length;i++){const fade=tp[i].f*tp[i].ef; ctx.fillStyle=`rgba(80,180,255,${(fade*0.35).toFixed(2)})`; ctx.beginPath(); ctx.arc(tp[i].x,tp[i].y,R*1.2*fade,0,Math.PI*2); ctx.fill(); ctx.fillStyle=`rgba(180,235,255,${(fade*0.55).toFixed(2)})`; ctx.beginPath(); ctx.arc(tp[i].x,tp[i].y,R*0.55*fade,0,Math.PI*2); ctx.fill();}
        ctx.restore(); ctx.save();
        for (let i=0;i<tp.length;i+=3){const fade=tp[i].f*tp[i].ef; if(fade<0.1)continue; const cr=R*0.32*fade,ang=t*1.2+i*0.9; ctx.strokeStyle=`rgba(210,245,255,${(fade*0.9).toFixed(2)})`; ctx.lineWidth=R*0.08; for(let arm=0;arm<6;arm++){const a=ang+arm*Math.PI/3; ctx.beginPath(); ctx.moveTo(tp[i].x,tp[i].y); ctx.lineTo(tp[i].x+Math.cos(a)*cr,tp[i].y+Math.sin(a)*cr); ctx.stroke();}}
        ctx.restore();
      } else if (boostId==='rainbow') {
        ctx.save(); ctx.globalCompositeOperation='lighter';
        for (let i=0;i<tp.length;i++){const fade=tp[i].f*tp[i].ef,h1=((t*150-i*16)%360+360)%360; ctx.fillStyle=`hsla(${h1},100%,60%,${(fade*0.55).toFixed(2)})`; ctx.beginPath(); ctx.arc(tp[i].x,tp[i].y,R*1.0*fade,0,Math.PI*2); ctx.fill(); ctx.fillStyle=`hsla(${(h1+120)%360},100%,80%,${(fade*0.4).toFixed(2)})`; ctx.beginPath(); ctx.arc(tp[i].x,tp[i].y,R*0.5*fade,0,Math.PI*2); ctx.fill();}
        ctx.restore();
      } else if (boostId==='lightning') {
        ctx.save(); ctx.globalCompositeOperation='lighter';
        for (let i=0;i<tp.length;i++){const fade=tp[i].f*tp[i].ef; ctx.fillStyle=`rgba(80,80,255,${(fade*0.3).toFixed(2)})`; ctx.beginPath(); ctx.arc(tp[i].x,tp[i].y,R*1.1*fade,0,Math.PI*2); ctx.fill();}
        for (let bolt=0;bolt<2;bolt++){ctx.beginPath(); ctx.moveTo(tp[0].x,tp[0].y); for(let i=1;i<tp.length;i++){ctx.lineTo(tp[i].x+pX*Math.sin(t*18+i*3.5+bolt*Math.PI)*R*0.6,tp[i].y+pY*Math.sin(t*18+i*3.5+bolt*Math.PI)*R*0.6);} ctx.strokeStyle=`rgba(255,255,255,${bolt===0?0.95:0.5})`; ctx.lineWidth=R*(bolt===0?0.12:0.06); ctx.lineCap='round'; ctx.stroke();}
        ctx.restore();
      } else if (boostId==='smoke') {
        ctx.save();
        for (let i=0;i<tp.length;i++){const fade=tp[i].f*tp[i].ef,grow=1+i*0.10,ox=pX*Math.sin(i*0.6+t*0.8)*R*0.45,oy=pY*Math.sin(i*0.6+t*0.8)*R*0.45,grey=Math.floor(130+fade*60); ctx.fillStyle=`rgba(${grey},${grey},${grey},${(fade*0.22).toFixed(2)})`; ctx.beginPath(); ctx.arc(tp[i].x+ox,tp[i].y+oy,R*grow*0.7,0,Math.PI*2); ctx.fill();}
        ctx.restore();
      } else if (boostId==='stars') {
        ctx.save(); ctx.globalCompositeOperation='lighter';
        for (let i=0;i<tp.length;i++){const fade=tp[i].f*tp[i].ef,twinkle=0.55+0.45*Math.sin(t*9+i*1.8),sr=R*0.6*fade,sa=t*2.5+i*0.55; ctx.beginPath(); for(let s=0;s<10;s++){const a=s*Math.PI/5+sa,rad=s%2===0?sr:sr*0.38; s===0?ctx.moveTo(tp[i].x+Math.cos(a)*rad,tp[i].y+Math.sin(a)*rad):ctx.lineTo(tp[i].x+Math.cos(a)*rad,tp[i].y+Math.sin(a)*rad);} ctx.closePath(); ctx.fillStyle=`rgba(255,240,100,${(fade*0.75*twinkle).toFixed(2)})`; ctx.fill();}
        ctx.restore();
      } else if (boostId==='galaxy') {
        ctx.save(); ctx.globalCompositeOperation='lighter';
        for (let i=0;i<tp.length;i++){const fade=tp[i].f*tp[i].ef; ctx.fillStyle=`rgba(100,0,200,${(fade*0.4).toFixed(2)})`; ctx.beginPath(); ctx.arc(tp[i].x,tp[i].y,R*1.1*fade,0,Math.PI*2); ctx.fill(); for(let arm=0;arm<3;arm++){const sa=t*4+i*0.5+arm*Math.PI*2/3; ctx.fillStyle=`hsla(${260+arm*50},100%,70%,${(fade*0.65).toFixed(2)})`; ctx.beginPath(); ctx.arc(tp[i].x+Math.cos(sa)*R*0.33*fade,tp[i].y+Math.sin(sa)*R*0.33*fade,R*0.28*fade,0,Math.PI*2); ctx.fill();}}
        ctx.restore();
      }
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const hx = pts[0].x, hy = pts[0].y;
    const ang = Math.atan2(pts[0].y-pts[1].y, pts[0].x-pts[1].x);

    // Body via WebGL shader (same look as in-game); falls back to flat style
    const glDrawn = glSnakeBody(ctx, pts, R, color);
    if (!glDrawn) {
      ctx.beginPath();
      ctx.moveTo(pts[N-1].x, pts[N-1].y);
      for (let i = N-2; i >= 1; i--) {
        const mx = (pts[i].x + pts[i-1].x) / 2, my = (pts[i].y + pts[i-1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.lineTo(pts[0].x, pts[0].y);
      ctx.lineWidth = R * 2; ctx.strokeStyle = color; ctx.stroke();
      const CREASE_SPACING = R * 1.76, PASSES = 15, SEGS = 8;
      const taperedArc = (ox, oy, fa, r, ba, lw) => {
        for (let s = 0; s < SEGS; s++) {
          const t0 = s/SEGS, t1 = (s+1)/SEGS;
          const taper = Math.sin((t0+t1)/2*Math.PI);
          ctx.beginPath();
          ctx.arc(ox, oy, r, fa+Math.PI*0.5+t0*Math.PI, fa+Math.PI*0.5+t1*Math.PI, false);
          ctx.strokeStyle = `rgba(0,0,0,${ba*taper})`;
          ctx.lineWidth = lw; ctx.lineCap = 'butt'; ctx.stroke();
        }
      };
      let dist = -R * 0.35;
      for (let i = 1; i < N-1; i++) {
        const dx = pts[i].x-pts[i-1].x, dy = pts[i].y-pts[i-1].y;
        dist += Math.sqrt(dx*dx+dy*dy);
        if (dist < CREASE_SPACING) continue;
        dist -= CREASE_SPACING;
        const pi = Math.max(0,i-2), ni = Math.min(N-1,i+2);
        const fa = Math.atan2(pts[pi].y-pts[ni].y, pts[pi].x-pts[ni].x);
        for (let p = 0; p < PASSES; p++) {
          const tt = p/(PASSES-1);
          taperedArc(pts[i].x, pts[i].y, fa, R*(0.88+tt*0.12), R*(0.50*Math.pow(1-tt,1.5)+0.035), 0.001+Math.pow(tt,2.5)*0.042);
        }
      }
      ctx.beginPath(); ctx.arc(hx, hy, R, 0, Math.PI*2); ctx.fillStyle = color; ctx.fill();
      for (let p = 0; p < PASSES; p++) {
        const tt = p/(PASSES-1);
        taperedArc(hx, hy, ang, R*(0.88+tt*0.12), R*(0.50*Math.pow(1-tt,1.5)+0.035), 0.001+Math.pow(tt,2.5)*0.042);
      }
    }
    const fwdX = Math.cos(ang), fwdY = Math.sin(ang);
    const perpX = -Math.sin(ang), perpY = Math.cos(ang);
    const eyeR = R*0.38, pupilR = eyeR*0.60, eyeSide = R*0.43, eyeFwd = R*0.40;
    for (const ss of [-1,1]) {
      const ex = hx + fwdX*eyeFwd + perpX*eyeSide*ss;
      const ey = hy + fwdY*eyeFwd + perpY*eyeSide*ss;
      ctx.beginPath(); ctx.arc(ex, ey, eyeR, 0, Math.PI*2); ctx.fillStyle='#FFF'; ctx.fill();
      const ps = eyeR - pupilR;
      ctx.beginPath(); ctx.arc(ex+fwdX*ps, ey+fwdY*ps, pupilR, 0, Math.PI*2); ctx.fillStyle='#060606'; ctx.fill();
    }

    // Hat — drawn above head in local space rotated to head angle
    if (hatId && hatId !== 'none') {
      ctx.save();
      ctx.translate(hx, hy);
      ctx.rotate(ang - Math.PI / 2); // "up" in local space = above head visually
      const by = -R * 1.08; // base of hat just above head circle

      if (hatId === 'crown') {
        const w = R*1.5, h = R*0.95;
        ctx.fillStyle = '#FFD700'; ctx.strokeStyle = '#B8860B'; ctx.lineWidth = 0.8;
        ctx.fillRect(-w/2, by - h*0.32, w, h*0.32);
        ctx.beginPath();
        ctx.moveTo(-w/2, by - h*0.32);
        ctx.lineTo(-w/3, by - h); ctx.lineTo(-w/8, by - h*0.48);
        ctx.lineTo(0, by - h);    ctx.lineTo(w/8, by - h*0.48);
        ctx.lineTo(w/3, by - h);  ctx.lineTo(w/2, by - h*0.32);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        for (const [rx, col] of [[-w/3,'#ff3333'],[0,'#3399ff'],[w/3,'#ff3333']]) {
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.arc(rx, by - h*0.16, R*0.1, 0, Math.PI*2); ctx.fill();
        }

      } else if (hatId === 'tophat') {
        const w = R*1.3, bw = R*1.75, bh = R*1.1;
        ctx.fillStyle = '#111'; ctx.strokeStyle = '#333'; ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.ellipse(0, by, bw/2, R*0.2, 0, 0, Math.PI*2);
        ctx.fill(); ctx.stroke();
        ctx.fillRect(-w/2, by - bh, w, bh); ctx.strokeRect(-w/2, by - bh, w, bh);
        ctx.fillStyle = '#880000';
        ctx.fillRect(-w/2, by - bh*0.25, w, bh*0.18);

      } else if (hatId === 'cap') {
        const w = R*1.35;
        ctx.fillStyle = '#2255cc'; ctx.strokeStyle = '#1133aa'; ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.arc(0, by, w/2, Math.PI, 0); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(w*0.3, by, w*0.52, R*0.15, -0.25, 0, Math.PI*2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(0, by - w/2, R*0.09, 0, Math.PI*2); ctx.fill();

      } else if (hatId === 'wizard') {
        const bw = R*1.7;
        ctx.fillStyle = '#7722cc'; ctx.strokeStyle = '#5511aa'; ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.ellipse(0, by, bw/2, R*0.2, 0, 0, Math.PI*2);
        ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-R*0.62, by); ctx.lineTo(0, by - R*2.2); ctx.lineTo(R*0.62, by);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#FFD700'; ctx.font = `${R*0.5}px serif`; ctx.textAlign = 'center';
        ctx.fillText('★', R*0.08, by - R*0.7); ctx.fillText('✦', -R*0.08, by - R*1.35);

      } else if (hatId === 'cowboy') {
        const w = R*1.3, bw = R*2.0;
        ctx.fillStyle = '#8B4513'; ctx.strokeStyle = '#5c2d0a'; ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.ellipse(0, by, bw/2, R*0.22, 0, 0, Math.PI*2);
        ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-w/2, by);
        ctx.bezierCurveTo(-w/2, by - R*1.1, -R*0.1, by - R*1.25, 0, by - R*1.25);
        ctx.bezierCurveTo(R*0.1, by - R*1.25, w/2, by - R*1.1, w/2, by);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#FFD700';
        ctx.fillRect(-w/2, by - R*0.28, w, R*0.17);

      } else if (hatId === 'party') {
        ctx.fillStyle = '#ff3399'; ctx.strokeStyle = '#cc0077'; ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.moveTo(-R*0.58, by); ctx.lineTo(0, by - R*1.85); ctx.lineTo(R*0.58, by);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#FFD700';
        for (const [px, py] of [[-R*0.22, by-R*0.4],[R*0.1, by-R*0.9],[-R*0.05, by-R*1.4]]) {
          ctx.beginPath(); ctx.arc(px, py, R*0.1, 0, Math.PI*2); ctx.fill();
        }
        ctx.beginPath(); ctx.arc(0, by - R*1.9, R*0.18, 0, Math.PI*2); ctx.fill();

      } else if (hatId === 'halo') {
        ctx.strokeStyle = '#FFD700'; ctx.lineWidth = R*0.18;
        ctx.shadowColor = '#FFD700'; ctx.shadowBlur = R*0.7;
        ctx.beginPath(); ctx.ellipse(0, by - R*0.6, R*0.75, R*0.22, 0, 0, Math.PI*2);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      ctx.restore();
    }

    ctx.restore();
  }

  function startApAnim() {
    const canvas = document.getElementById('ap-canvas');
    if (!canvas) return;
    if (apAnimRaf) cancelAnimationFrame(apAnimRaf);
    function loop() {
      const skin = SKINS[previewBycat.skins] || SKINS[0];
      if (apSrcLobby === 2) {
        drawMiniCell(canvas, skin.color);
      } else {
        const hatId   = apCat === 'hats'   ? (HATS[previewBycat.hats]     || HATS[0]).id   : equippedHat;
        const boostId = apCat === 'boosts' ? (BOOSTS[previewBycat.boosts] || BOOSTS[0]).id : equippedBoost;
        drawAnimSnake(canvas, skin.color, apAnimT, hatId, boostId);
        apAnimT += 0.022;
      }
      apAnimRaf = requestAnimationFrame(loop);
    }
    loop();
  }

  function stopApAnim() {
    if (apAnimRaf) { cancelAnimationFrame(apAnimRaf); apAnimRaf = null; }
  }

  // ── Selector UI ──────────────────────────────────────────────────────────────
  function updateApSelector() {
    const list = CATS[apCat];
    const item = list ? list[previewBycat[apCat]] : null;
    const nameEl  = document.getElementById('ap-sel-name');
    const lockEl  = document.getElementById('ap-sel-lock');
    const saveBtn = document.getElementById('ap-save');
    if (item) {
      nameEl.textContent = item.name;
      lockEl.classList.toggle('hidden', !item.locked);
      saveBtn.disabled = !!item.locked;
    } else {
      nameEl.textContent = '—';
      lockEl.classList.add('hidden');
      saveBtn.disabled = true;
    }
  }

  function setApCat(cat) {
    apCat = cat;
    document.querySelectorAll('.ap-cat').forEach(b => b.classList.toggle('ap-cat-active', b.dataset.apcat === cat));
    document.getElementById('ap-prev').disabled = false;
    document.getElementById('ap-next').disabled = false;
    updateApSelector();
  }

  function setApMode(mode) {
    apMode = mode;
    document.getElementById('ap-tab-inv').classList.toggle('ap-htab-active', mode === 'inventory');
    document.getElementById('ap-tab-shop').classList.toggle('ap-htab-active', mode === 'shop');
    const isShop = mode === 'shop';
    document.getElementById('ap-preview-wrap').classList.toggle('hidden', isShop);
    document.getElementById('ap-catbar').classList.toggle('hidden', isShop);
    document.getElementById('ap-selector').classList.toggle('hidden', isShop);
    document.getElementById('ap-save-row').classList.toggle('hidden', isShop);
    document.getElementById('ap-shop-wrap').classList.toggle('hidden', !isShop);
  }

  // ── Open / close ─────────────────────────────────────────────────────────────
  function openAppearanceScreen(lobbyNum) {
    apSrcLobby = lobbyNum || 1;
    previewBycat.skins  = Math.max(0, SKINS.findIndex(s => s.id === equippedId));
    previewBycat.hats   = Math.max(0, HATS.findIndex(h => h.id === equippedHat));
    previewBycat.boosts = Math.max(0, BOOSTS.findIndex(b => b.id === equippedBoost));
    apCat = 'skins';
    apMode = 'inventory';
    const snakeCanvas = document.getElementById('snake-canvas');
    if (snakeCanvas) snakeCanvas.style.opacity = '0';
    if (lobbyNum === 2) {
      if (window._agarBg) window._agarBg.stop();
      bgCanvas2.style.opacity = '0';
      document.getElementById('appearance-screen').classList.add('ap-cell-mode');
    }

    document.getElementById('appearance-screen').classList.remove('hidden');
    document.getElementById('lobby-screen').classList.add('hidden');
    document.getElementById('lobby-screen-2').classList.add('hidden');
    document.querySelectorAll('.lobby-nav-arrow').forEach(el => el.classList.add('hidden'));

    document.querySelectorAll('.ap-cat').forEach(b => {
      b.classList.toggle('ap-cat-active', b.dataset.apcat === 'skins');
      // Hide hats/boosts for the cell game — only color matters
      if (lobbyNum === 2) b.style.display = b.dataset.apcat === 'skins' ? '' : 'none';
      else b.style.display = '';
    });
    document.getElementById('ap-tab-inv').classList.add('ap-htab-active');
    document.getElementById('ap-tab-shop').classList.remove('ap-htab-active');
    document.getElementById('ap-preview-wrap').classList.remove('hidden');
    document.getElementById('ap-catbar').classList.remove('hidden');
    document.getElementById('ap-selector').classList.remove('hidden');
    document.getElementById('ap-save-row').classList.remove('hidden');
    document.getElementById('ap-shop-wrap').classList.add('hidden');
    document.getElementById('ap-prev').disabled = false;
    document.getElementById('ap-next').disabled = false;

    updateApSelector();
    startApAnim();
  }

  function closeAppearanceScreen() {
    stopApAnim();
    document.getElementById('appearance-screen').classList.add('hidden');
    document.querySelectorAll('.lobby-nav-arrow').forEach(el => el.classList.remove('hidden'));
    const snakeCanvas = document.getElementById('snake-canvas');
    if (snakeCanvas) snakeCanvas.style.opacity = apSrcLobby === 2 ? '0' : '';
    if (apSrcLobby === 2) {
      document.getElementById('lobby-screen-2').classList.remove('hidden');
      bgCanvas2.style.opacity = '1';
      if (window._agarBg) window._agarBg.start();
      document.getElementById('appearance-screen').classList.remove('ap-cell-mode');
    } else {
      document.getElementById('lobby-screen').classList.remove('hidden');
    }
  }

  // ── Event listeners ──────────────────────────────────────────────────────────
  document.getElementById('btn-change-appearance').addEventListener('click',   () => openAppearanceScreen(1));
  document.getElementById('btn-change-appearance-2').addEventListener('click', () => openAppearanceScreen(2));
  document.getElementById('ap-back').addEventListener('click', closeAppearanceScreen);

  document.getElementById('ap-tab-inv').addEventListener('click',  () => setApMode('inventory'));
  document.getElementById('ap-tab-shop').addEventListener('click', () => setApMode('shop'));

  document.querySelectorAll('.ap-cat').forEach(b => {
    b.addEventListener('click', () => setApCat(b.dataset.apcat));
  });

  document.getElementById('ap-prev').addEventListener('click', () => {
    const list = CATS[apCat]; if (!list) return;
    previewBycat[apCat] = (previewBycat[apCat] - 1 + list.length) % list.length;
    updateApSelector();
  });

  document.getElementById('ap-next').addEventListener('click', () => {
    const list = CATS[apCat]; if (!list) return;
    previewBycat[apCat] = (previewBycat[apCat] + 1) % list.length;
    updateApSelector();
  });

  document.getElementById('ap-save').addEventListener('click', () => {
    const list = CATS[apCat]; if (!list) return;
    const item = list[previewBycat[apCat]];
    if (!item || item.locked) return;
    if (apCat === 'skins') {
      equippedId = item.id;
      localStorage.setItem('duelseries_skin_id',    item.id);
      localStorage.setItem('duelseries_skin_color', item.color);
      refreshMiniCanvas();
    } else if (apCat === 'hats') {
      equippedHat = item.id;
      localStorage.setItem('duelseries_hat_id', item.id);
    } else if (apCat === 'boosts') {
      equippedBoost = item.id;
      localStorage.setItem('duelseries_boost_id', item.id);
    }
    closeAppearanceScreen();
  });

  // Draw mini canvas on load
  setTimeout(refreshMiniCanvas, 100);
})();

// ─── Lobby snake animation ────────────────────────────────────────────────────
(function() {
  const canvas = document.getElementById('snake-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const COLORS = [
    '#1ECEA8', '#F5C020', '#E85DA8',
    '#5B8CFF', '#FF6B35', '#A855F7',
  ];

  const R      = 17;
  const SPEED  = 0.8;
  const TURN   = 0.032;
  const TRAILS = [160, 220, 180, 260, 200, 240]; // varied lengths per snake

  function pickTarget(W, H) {
    // Pick anywhere on screen including slightly beyond edges
    return { tx: -W * 0.1 + Math.random() * W * 1.2, ty: -H * 0.1 + Math.random() * H * 1.2 };
  }

  function makeSnake(color, W, H, trailLen) {
    const angle = Math.random() * Math.PI * 2;
    const x = Math.random() * W;
    const y = Math.random() * H;
    const trail = [];
    for (let t = 0; t < trailLen; t++)
      trail.push({ x: x - Math.cos(angle) * t * SPEED, y: y - Math.sin(angle) * t * SPEED });
    return { x, y, angle, color, r: R, trailLen, trail, ...pickTarget(W, H), targetTimer: 200 + Math.random() * 300 };
  }

  let snakes = [];
  function resize() {
    const uiZoom = parseFloat(getComputedStyle(document.getElementById('ui-root')).zoom) || 1;
    canvas.width  = Math.round(window.innerWidth  / uiZoom);
    canvas.height = Math.round(window.innerHeight / uiZoom);
    snakes = COLORS.map((c, i) => makeSnake(c, canvas.width, canvas.height, TRAILS[i]));
  }
  resize();
  window.addEventListener('resize', resize);

  function update(s) {
    const W = canvas.width, H = canvas.height;

    // Pick a new target when timer expires or close enough
    s.targetTimer--;
    const distToTarget = Math.hypot(s.tx - s.x, s.ty - s.y);
    if (s.targetTimer <= 0 || distToTarget < 60) {
      Object.assign(s, pickTarget(W, H));
      s.targetTimer = 250 + Math.random() * 350;
    }

    // Separation — steer away from nearby snakes
    let avoidX = 0, avoidY = 0;
    for (const other of snakes) {
      if (other === s) continue;
      const dx = s.x - other.x, dy = s.y - other.y;
      const dist = Math.hypot(dx, dy) || 1;
      const minDist = 380;
      if (dist < minDist) {
        const strength = (minDist - dist) / minDist;
        avoidX += (dx / dist) * strength;
        avoidY += (dy / dist) * strength;
      }
    }

    // Blend target direction with avoidance
    const toTargetX = s.tx - s.x, toTargetY = s.ty - s.y;
    const tLen = Math.hypot(toTargetX, toTargetY) || 1;
    const dirX = toTargetX / tLen + avoidX * 3.0;
    const dirY = toTargetY / tLen + avoidY * 3.0;

    const desired = Math.atan2(dirY, dirX);
    let delta = desired - s.angle;
    while (delta >  Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    s.angle += Math.sign(delta) * Math.min(Math.abs(delta), TURN);

    s.x += Math.cos(s.angle) * SPEED;
    s.y += Math.sin(s.angle) * SPEED;

    // Wrap around screen edges
    const pad = s.r * 3;
    if (s.x < -pad)    s.x += W + pad * 2;
    if (s.x > W + pad) s.x -= W + pad * 2;
    if (s.y < -pad)    s.y += H + pad * 2;
    if (s.y > H + pad) s.y -= H + pad * 2;

    s.trail.unshift({ x: s.x, y: s.y });
    if (s.trail.length > s.trailLen) s.trail.pop();
  }

  function drawTrailPass(t, len, wrapThresh, strokeStyle, lineWidth) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth   = lineWidth;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < len; i++) {
      if (i > 0) {
        const dx = Math.abs(t[i].x - t[i-1].x), dy = Math.abs(t[i].y - t[i-1].y);
        if (dx > wrapThresh || dy > wrapThresh) {
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(t[i].x, t[i].y);
          started = true;
          continue;
        }
      }
      if (!started || i === 0) { ctx.moveTo(t[i].x, t[i].y); started = true; }
      else ctx.lineTo(t[i].x, t[i].y);
    }
    ctx.stroke();
  }

  function drawSnake(s) {
    if (s.trail.length < 4) return;
    const t = s.trail, len = t.length;
    const W = canvas.width, H = canvas.height;
    const R = s.r;
    const wrapThresh = Math.min(W, H) * 0.35;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const hx = s.x, hy = s.y;
    const glOK = (typeof glSnakeBody === 'function') && _lobbyGL && _lobbyGL.ok;

    if (glOK) {
      // Body via WebGL shader; split the trail at screen-wrap jumps into runs
      let run = [{ x: t[0].x, y: t[0].y }];
      const flush = () => { if (run.length >= 2) glSnakeBody(ctx, run, R, s.color); };
      for (let i = 1; i < len; i++) {
        const dx = Math.abs(t[i].x - t[i-1].x), dy = Math.abs(t[i].y - t[i-1].y);
        if (dx > wrapThresh || dy > wrapThresh) { flush(); run = []; }
        run.push({ x: t[i].x, y: t[i].y });
      }
      flush();
    } else {
      // Fallback: flat body + tapered arc creases + head
      ctx.strokeStyle = s.color;
      ctx.lineWidth = R * 2;
      let bi = len - 1;
      while (bi >= 0) {
        ctx.beginPath();
        ctx.moveTo(t[bi].x, t[bi].y);
        bi--;
        while (bi >= 0) {
          const wdx = Math.abs(t[bi+1].x - t[bi].x), wdy = Math.abs(t[bi+1].y - t[bi].y);
          if (wdx > wrapThresh || wdy > wrapThresh) break;
          if (bi > 0) {
            const ndx = Math.abs(t[bi].x - t[bi-1].x), ndy = Math.abs(t[bi].y - t[bi-1].y);
            if (ndx <= wrapThresh && ndy <= wrapThresh) {
              const mx = (t[bi].x + t[bi-1].x) / 2, my = (t[bi].y + t[bi-1].y) / 2;
              ctx.quadraticCurveTo(t[bi].x, t[bi].y, mx, my);
            } else { ctx.lineTo(t[bi].x, t[bi].y); }
          } else { ctx.lineTo(t[bi].x, t[bi].y); }
          bi--;
        }
        ctx.stroke();
      }
      const CREASE_SPACING = R * 1.76, PASSES = 15, SEGS = 8;
      const taperedArc = (cx, cy, fwdAngle, r, baseAlpha, lw) => {
        for (let sg = 0; sg < SEGS; sg++) {
          const t0 = sg / SEGS, t1 = (sg+1) / SEGS;
          const taper = Math.sin((t0+t1) / 2 * Math.PI);
          ctx.beginPath();
          ctx.arc(cx, cy, r, fwdAngle + Math.PI*0.5 + t0*Math.PI, fwdAngle + Math.PI*0.5 + t1*Math.PI, false);
          ctx.strokeStyle = `rgba(0,0,0,${baseAlpha * taper})`;
          ctx.lineWidth = lw; ctx.lineCap = 'butt'; ctx.stroke();
        }
      };
      let dist = -R * 0.35;
      for (let i = 1; i < len - 1; i++) {
        const dx = t[i].x - t[i-1].x, dy = t[i].y - t[i-1].y;
        const d = Math.sqrt(dx*dx + dy*dy);
        if (d > wrapThresh) { dist = -R * 0.35; continue; }
        dist += d;
        if (dist < CREASE_SPACING) continue;
        dist -= CREASE_SPACING;
        const pi = Math.max(0, i-2), ni = Math.min(len-1, i+2);
        const fwdAngle = Math.atan2(t[pi].y - t[ni].y, t[pi].x - t[ni].x);
        for (let p = 0; p < PASSES; p++) {
          const tv = p / (PASSES-1);
          taperedArc(t[i].x, t[i].y, fwdAngle, R*(0.88+tv*0.12), R*(0.50*Math.pow(1-tv,1.5)+0.035), 0.001+Math.pow(tv,2.5)*0.042);
        }
      }
      ctx.beginPath(); ctx.arc(hx, hy, R, 0, Math.PI*2); ctx.fillStyle = s.color; ctx.fill();
      for (let p = 0; p < PASSES; p++) {
        const tv = p / (PASSES-1);
        taperedArc(hx, hy, s.angle, R*(0.88+tv*0.12), R*(0.50*Math.pow(1-tv,1.5)+0.035), 0.001+Math.pow(tv,2.5)*0.042);
      }
    }

    const fwdX = Math.cos(s.angle), fwdY = Math.sin(s.angle);
    const perpX = -Math.sin(s.angle), perpY = Math.cos(s.angle);
    const eyeR = R * 0.38, pupilR = eyeR * 0.60;
    const eyeSide = R * 0.43, eyeFwd = R * 0.40;
    for (const side of [-1, 1]) {
      const ex = hx + fwdX*eyeFwd + perpX*eyeSide*side;
      const ey = hy + fwdY*eyeFwd + perpY*eyeSide*side;
      ctx.beginPath(); ctx.arc(ex, ey, eyeR, 0, Math.PI*2);
      ctx.fillStyle = '#FFFFFF'; ctx.fill();
      const ps = eyeR - pupilR;
      ctx.beginPath(); ctx.arc(ex + fwdX*ps, ey + fwdY*ps, pupilR, 0, Math.PI*2);
      ctx.fillStyle = '#060606'; ctx.fill();
    }

    ctx.restore();
  }

  function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    snakes.forEach(s => { update(s); drawSnake(s); });
    requestAnimationFrame(loop);
  }
  loop();
})();

// ─── My Profile Modal ─────────────────────────────────────────────────────────
(function () {
  const modal       = document.getElementById('modal-my-profile');
  // ── Mute toggle ───────────────────────────────────────────────────────
  window.gameMuted = localStorage.getItem('duelseries_muted') === 'true';
  const muteBtn = document.getElementById('btn-mute');
  function applyMuteState() {
    muteBtn.classList.toggle('muted', window.gameMuted);
    muteBtn.querySelector('.icon-sound-on').classList.toggle('hidden', window.gameMuted);
    muteBtn.querySelector('.icon-sound-off').classList.toggle('hidden', !window.gameMuted);
  }
  applyMuteState(); // restore saved state on load
  muteBtn.addEventListener('click', () => {
    window.gameMuted = !window.gameMuted;
    localStorage.setItem('duelseries_muted', window.gameMuted);
    applyMuteState();
  });

  // ── Settings Modal ────────────────────────────────────────────────────
  (function initSettings() {
    const overlay = document.getElementById('modal-settings');
    document.getElementById('btn-settings').addEventListener('click', () => {
      // Populate account tab with live data
      document.getElementById('st-username').textContent = sessionStorage.getItem('playerName') || '—';
      const addr = account?.walletAddress || '—';
      document.getElementById('st-sol-address').textContent = addr.length > 12 ? addr.slice(0,6) + '…' + addr.slice(-4) : addr;
      // Member since / login streak placeholders — real data from account if available
      const acct = window._accountData || {};
      document.getElementById('st-member-since').textContent = acct.memberSince || '—';
      document.getElementById('st-login-streak').textContent = acct.loginStreak ? acct.loginStreak + ' days' : '—';
      overlay.style.display = 'flex';
    });
    document.getElementById('close-settings').addEventListener('click', () => overlay.style.display = 'none');
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.style.display = 'none'; });

    // Tab switching (re-use existing pm-nav-tab class scoped to settings)
    overlay.querySelectorAll('.pm-nav-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.pm-nav-tab').forEach(b => b.classList.remove('active'));
        overlay.querySelectorAll('.st-panel').forEach(p => p.classList.add('hidden'));
        btn.classList.add('active');
        document.getElementById('st-panel-' + btn.dataset.stab).classList.remove('hidden');
      });
    });

    // Audio settings — load from localStorage, wire sliders
    const audioEnabled = document.getElementById('st-audio-enabled');
    const masterSlider = document.getElementById('st-master-vol');
    const sfxSlider    = document.getElementById('st-sfx-vol');
    const musicSlider  = document.getElementById('st-music-vol');

    function loadAudioPrefs() {
      audioEnabled.checked     = localStorage.getItem('ds_audio_enabled') !== 'false';
      masterSlider.value       = localStorage.getItem('ds_master_vol')    ?? 100;
      sfxSlider.value          = localStorage.getItem('ds_sfx_vol')       ?? 50;
      musicSlider.value        = localStorage.getItem('ds_music_vol')      ?? 30;
      document.getElementById('st-master-vol-val').textContent = masterSlider.value + '%';
      document.getElementById('st-sfx-vol-val').textContent    = sfxSlider.value    + '%';
      document.getElementById('st-music-vol-val').textContent  = musicSlider.value  + '%';
      window.gameMuted = !audioEnabled.checked;
      applyMuteState();
    }
    loadAudioPrefs();

    audioEnabled.addEventListener('change', () => {
      localStorage.setItem('ds_audio_enabled', audioEnabled.checked);
      window.gameMuted = !audioEnabled.checked;
      localStorage.setItem('duelseries_muted', window.gameMuted);
      applyMuteState();
    });
    function wireSlider(el, key, valId) {
      el.addEventListener('input', () => {
        document.getElementById(valId).textContent = el.value + '%';
        localStorage.setItem(key, el.value);
        window.gameMasterVol = parseInt(masterSlider.value) / 100;
        window.gameSfxVol    = parseInt(sfxSlider.value)    / 100;
        window.gameMusicVol  = parseInt(musicSlider.value)  / 100;
      });
    }
    wireSlider(masterSlider, 'ds_master_vol', 'st-master-vol-val');
    wireSlider(sfxSlider,    'ds_sfx_vol',    'st-sfx-vol-val');
    wireSlider(musicSlider,  'ds_music_vol',  'st-music-vol-val');

    // Expose volume globals for game.js
    window.gameMasterVol = parseInt(masterSlider.value) / 100;
    window.gameSfxVol    = parseInt(sfxSlider.value)    / 100;
    window.gameMusicVol  = parseInt(musicSlider.value)  / 100;
  })();

  const closeBtn    = document.getElementById('close-my-profile');
  const openBtn     = document.getElementById('btn-profile');
  const chartCanvas = document.getElementById('pm-chart');
  const navTabs     = document.querySelectorAll('.pm-nav-tab');

  let profileData = null;
  let activeTab   = 'profile';

  // ── Tab switching ──────────────────────────────────────────────────────
  function showTab(tab) {
    activeTab = tab;
    navTabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.pm-tab-panel').forEach(p => p.classList.add('hidden'));
    document.getElementById('pm-panel-' + tab).classList.remove('hidden');
    if (tab === 'leaderboard') loadLeaderboard();
    if (tab === 'profile' && profileData) drawChart();
  }
  navTabs.forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

  // ── Leaderboard ────────────────────────────────────────────────────────
  function loadLeaderboard() {
    const listEl = document.getElementById('pm-lb-list');
    listEl.innerHTML = '<li style="color:#555;padding:10px 0">Loading…</li>';
    fetch('/api/earningsboard')
      .then(r => r.json())
      .then(data => {
        if (!data.length) { listEl.innerHTML = '<li style="color:#555;padding:10px 0">No earnings recorded yet</li>'; return; }
        listEl.innerHTML = data.map((p, i) =>
          `<li>
            <span class="pm-lb-rank">#${i + 1}</span>
            <span class="pm-lb-name">${escHtmlLobby(p.name)}</span>
            <span class="pm-lb-val">C$${(p.earnings * (_solCadRate || 200)).toFixed(2)}</span>
          </li>`
        ).join('');
      })
      .catch(() => { listEl.innerHTML = '<li style="color:#c33">Failed to load</li>'; });
  }

  // ── Search ─────────────────────────────────────────────────────────────
  const searchInput    = document.getElementById('pm-search-input');
  const searchDropdown = document.getElementById('pm-search-dropdown');
  const searchResult   = document.getElementById('pm-search-result');
  let searchDebounce   = null;

  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const q = searchInput.value.trim();
    if (!q) { hideDropdown(); return; }
    searchDebounce = setTimeout(() => fetchSuggestions(q), 180);
  });

  searchInput.addEventListener('keydown', e => {
    const items = searchDropdown.querySelectorAll('li');
    const active = searchDropdown.querySelector('li.active');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = active ? active.nextElementSibling : items[0];
      if (active) active.classList.remove('active');
      if (next) next.classList.add('active');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = active ? active.previousElementSibling : items[items.length - 1];
      if (active) active.classList.remove('active');
      if (prev) prev.classList.add('active');
    } else if (e.key === 'Enter') {
      const sel = searchDropdown.querySelector('li.active');
      if (sel) selectName(sel.textContent);
      else if (searchInput.value.trim()) selectName(searchInput.value.trim());
    } else if (e.key === 'Escape') {
      hideDropdown();
    }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.pm-search-field')) hideDropdown();
  });

  function fetchSuggestions(q) {
    fetch('/api/players/search?q=' + encodeURIComponent(q))
      .then(r => r.json())
      .then(names => {
        if (!names.length) { hideDropdown(); return; }
        searchDropdown.innerHTML = names
          .map(n => `<li>${escHtmlLobby(n)}</li>`)
          .join('');
        searchDropdown.querySelectorAll('li').forEach(li => {
          li.addEventListener('click', () => selectName(li.textContent));
        });
        searchDropdown.classList.remove('hidden');
      })
      .catch(() => hideDropdown());
  }

  function hideDropdown() { searchDropdown.classList.add('hidden'); }

  function selectName(name) {
    searchInput.value = name;
    hideDropdown();
    searchResult.innerHTML = '<p style="color:#555;font-size:0.85rem;padding:8px 0">Loading…</p>';
    fetch('/api/profile/' + encodeURIComponent(name))
      .then(r => r.json())
      .then(data => {
        if (data.error) { searchResult.innerHTML = `<p style="color:#ef4444;font-size:0.85rem;padding:8px 0">Player not found.</p>`; return; }
        const cad  = (data.totalEarnings * (_solCadRate || 200)).toFixed(2);
        const time = fmtTime(data.playTimeSeconds || 0);
        searchResult.innerHTML = `
          <div class="pm-search-card">
            <div class="pm-sc-name">${escHtmlLobby(data.name)}</div>
            <div class="pm-sc-row"><span class="pm-sc-lbl">Total Earnings</span><span class="pm-sc-val">C$${cad}</span></div>
            <div class="pm-sc-row"><span class="pm-sc-lbl">Games Played</span><span class="pm-sc-val">${data.gamesPlayed || 0}</span></div>
            <div class="pm-sc-row"><span class="pm-sc-lbl">Time Played</span><span class="pm-sc-val">${time}</span></div>
          </div>`;
      })
      .catch(() => { searchResult.innerHTML = '<p style="color:#c33;font-size:0.85rem;padding:8px 0">Network error.</p>'; });
  }

  // ── Helpers ────────────────────────────────────────────────────────────
  function fmtTime(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function fmtCad(sol) {
    const cad = sol * (_solCadRate || 200);
    return `C$${cad.toFixed(2)}`;
  }

  function drawChart() {
    if (!profileData) return;
    const games = profileData.games || [];
    const ctx   = chartCanvas.getContext('2d');
    const W = chartCanvas.offsetWidth  || 440;
    const H = chartCanvas.offsetHeight || 160;
    chartCanvas.width  = W * devicePixelRatio;
    chartCanvas.height = H * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.clearRect(0, 0, W, H);

    if (games.length === 0) {
      ctx.fillStyle = '#555';
      ctx.font = '13px Segoe UI';
      ctx.textAlign = 'center';
      ctx.fillText('No game earnings yet', W / 2, H / 2 + 5);
      return;
    }

    const pad  = { top: 16, right: 20, bottom: 32, left: 52 };
    const cW   = W - pad.left - pad.right;
    const cH   = H - pad.top  - pad.bottom;
    const n    = games.length;
    const vals = games.map(g => g.amount);

    const rawMax = Math.max(...vals, 0);
    const rawMin = Math.min(...vals, 0);
    // Add 15% headroom above and below so dots don't sit on the edge
    const span   = rawMax - rawMin || 0.001;
    const maxV   = rawMax + span * 0.15;
    const minV   = rawMin - span * 0.15;
    const range  = maxV - minV;

    const xOf = i => pad.left + (n === 1 ? cW / 2 : (i / (n - 1)) * cW);
    const yOf = v => pad.top + cH - ((v - minV) / range) * cH;
    const zeroY = yOf(0);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth   = 1;
    for (let t = 0; t <= 4; t++) {
      const y = pad.top + (t / 4) * cH;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    }

    // Zero baseline
    if (zeroY >= pad.top && zeroY <= pad.top + cH) {
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(W - pad.right, zeroY); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Gradient fill above zero
    const gradUp = ctx.createLinearGradient(0, pad.top, 0, zeroY);
    gradUp.addColorStop(0,   'rgba(20,241,149,0.22)');
    gradUp.addColorStop(1,   'rgba(20,241,149,0.03)');

    // Gradient fill below zero (red tint)
    const gradDown = ctx.createLinearGradient(0, zeroY, 0, pad.top + cH);
    gradDown.addColorStop(0,   'rgba(239,68,68,0.04)');
    gradDown.addColorStop(1,   'rgba(239,68,68,0.20)');

    // Fill above zero
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, pad.top, cW, Math.max(0, zeroY - pad.top));
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(vals[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(xOf(i), yOf(vals[i]));
    ctx.lineTo(xOf(n - 1), zeroY);
    ctx.lineTo(xOf(0), zeroY);
    ctx.closePath();
    ctx.fillStyle = gradUp;
    ctx.fill();
    ctx.restore();

    // Fill below zero
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, zeroY, cW, Math.max(0, pad.top + cH - zeroY));
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(vals[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(xOf(i), yOf(vals[i]));
    ctx.lineTo(xOf(n - 1), zeroY);
    ctx.lineTo(xOf(0), zeroY);
    ctx.closePath();
    ctx.fillStyle = gradDown;
    ctx.fill();
    ctx.restore();

    // Main line — colour each segment by direction
    for (let i = 1; i < n; i++) {
      const rising = vals[i] >= vals[i - 1];
      ctx.beginPath();
      ctx.moveTo(xOf(i - 1), yOf(vals[i - 1]));
      ctx.lineTo(xOf(i),     yOf(vals[i]));
      ctx.strokeStyle = rising ? '#14F195' : '#ef4444';
      ctx.lineWidth   = 2;
      ctx.lineJoin    = 'round';
      ctx.stroke();
    }

    // Dots — green if positive, red if negative
    for (let i = 0; i < n; i++) {
      const pos = vals[i] >= 0;
      ctx.beginPath();
      ctx.arc(xOf(i), yOf(vals[i]), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = pos ? '#14F195' : '#ef4444';
      ctx.fill();
      ctx.strokeStyle = '#111';
      ctx.lineWidth   = 1;
      ctx.stroke();
    }

    // Y-axis labels
    ctx.fillStyle = '#6b7280';
    ctx.font      = '10px Segoe UI';
    ctx.textAlign = 'right';
    for (let t = 0; t <= 4; t++) {
      const v = minV + (1 - t / 4) * range;
      const y = pad.top + (t / 4) * cH;
      ctx.fillText(v.toFixed(3), pad.left - 6, y + 3.5);
    }

    // X-axis: first and last date
    ctx.textAlign = 'left';
    ctx.fillStyle = '#6b7280';
    const fmtDate = d => new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
    ctx.fillText(fmtDate(games[0].at), pad.left, H - 8);
    if (n > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(fmtDate(games[n - 1].at), W - pad.right, H - 8);
    }

    // Game count label
    ctx.textAlign = 'center';
    ctx.fillStyle = '#4b5563';
    ctx.fillText(`${n} cashout${n === 1 ? '' : 's'}`, W / 2, H - 8);
  }

  function openModal() {
    if (!account) return;
    modal.style.display = 'flex';
    showTab('profile');

    const pmAvImg = document.getElementById('pm-avatar-img');
    const pmAvFb  = document.getElementById('pm-avatar-fallback');
    document.getElementById('pm-name').textContent = account.name || '(no name set)';
    if (account.avatar) {
      pmAvImg.src = account.avatar; pmAvImg.classList.remove('hidden'); pmAvFb.classList.add('hidden');
    } else {
      pmAvFb.textContent = (account.name || '?')[0].toUpperCase();
      pmAvFb.classList.remove('hidden'); pmAvImg.classList.add('hidden');
    }

    fetch('/api/my-profile')
      .then(r => r.json())
      .then(data => {
        profileData = data;
        document.getElementById('pm-earnings').textContent  = fmtCad(data.totalEarnings);
        document.getElementById('pm-games').textContent     = data.gamesPlayed;
        document.getElementById('pm-playtime').textContent  = fmtTime(data.playTimeSeconds);
        const namesRow = document.getElementById('pm-names-row');
        const names = (data.nameHistory || []).filter(Boolean);
        namesRow.innerHTML = names.length
          ? names.map(n => `<span class="pm-name-tag">${escHtmlLobby(n)}</span>`).join('')
          : '<span style="color:#555;font-size:0.82rem">No name history yet</span>';
        drawChart();
      })
      .catch(() => {});
  }

  function escHtmlLobby(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  if (openBtn)  openBtn.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

  window.addEventListener('resize', () => {
    if (modal.style.display !== 'none' && activeTab === 'profile' && profileData) drawChart();
  });
})();

// ── Mobile fullscreen button ──────────────────────────────────────────────
(function() {
  const btn = document.getElementById('btn-fullscreen-lobby');
  if (!btn) return;

  function isInFS() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  function requestFS() {
    const el = document.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen || function(){}).call(el);
  }
  function exitFS() {
    (document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen || function(){}).call(document);
  }
  function updateIcon() {
    btn.innerHTML = isInFS()
      ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`
      : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
    localStorage.setItem('ds_wants_fullscreen', isInFS() ? '1' : '0');
  }

  btn.addEventListener('click', () => { if (isInFS()) exitFS(); else requestFS(); });
  document.addEventListener('fullscreenchange', updateIcon);
  document.addEventListener('webkitfullscreenchange', updateIcon);
})();

// ── Listen for game iframe signalling "back to lobby" ────────────────────
window.addEventListener('message', (e) => {
  if (e.data === 'game:done') {
    const gameFrame = document.getElementById('game-frame');
    if (gameFrame) { gameFrame.style.display = 'none'; gameFrame.src = ''; }
    const agarFrame = document.getElementById('agar-frame');
    if (agarFrame) { agarFrame.style.display = 'none'; agarFrame.src = ''; }
    if (window._resumeLobbyAnims) window._resumeLobbyAnims();
  }
});
