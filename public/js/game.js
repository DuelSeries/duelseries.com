// Navigate back to lobby — postMessage if inside the lobby iframe (keeps fullscreen);
// otherwise (standalone / self-custody full-page launch) navigate there directly.
function goToLobby() {
  if (window.self !== window.top) window.parent.postMessage('game:done', '*');
  else window.location.href = '/';
}

// Game client
const canvas = document.getElementById('game-canvas');
const renderer = new Renderer(canvas);

// Minimap is drawn directly onto the game canvas by renderer._drawMinimap

// Player info from lobby
const playerName    = sessionStorage.getItem('playerName')    || 'Player';
const walletAddress = sessionStorage.getItem('walletAddress') || null;
const googleId      = sessionStorage.getItem('googleId')      || null;
if (window.phIdentify && walletAddress) window.phIdentify(walletAddress); // link in-game analytics to this player
const lobbyType     = sessionStorage.getItem('lobbyType')     || 'free';
const entrySol      = parseFloat(sessionStorage.getItem('entrySol') || '0');
const entryToken    = sessionStorage.getItem('entryToken') || null;
const selectedRegion = sessionStorage.getItem('region') || 'na';
const spectateOnly  = sessionStorage.getItem('spectateOnly') === 'true';

// SOL/CAD rate — fetched once on load
let solCadRate = 200;
fetch('/api/prices').then(r => r.json()).then(d => { if (d.solCadRate) solCadRate = d.solCadRate; }).catch(() => {});
let moneyMode = 'sol';
fetch('/api/money-config').then(r => r.json()).then(c => { if (c && c.mode) moneyMode = c.mode; }).catch(() => {});
// Format a money value for display. USDC mode: the value already IS US dollars. SOL mode: it's SOL,
// converted to CAD via the live rate. (Pre-cutover this stayed CAD; post-cutover worth is in USDC.)
function fmtMoney(v) { v = Number(v) || 0; return moneyMode === 'usdc' ? '$' + v.toFixed(2) : 'C$' + (v * solCadRate).toFixed(2); }

let myId = null;
let isDead = false;
let mousePos = { x: 0, y: 0 };
let boostActive  = false;

// --- Interpolation buffers ---
let snapBuffer   = [];
let clockOffset  = null;
let interpBeforeMap = null; // reused across frames to avoid Map allocation
let interpSnakeBuf  = null; // reused across frames to avoid array allocation
const _segPool      = new Map(); // snake id → Float32Array, reused to avoid GC
const INTERP_DELAY_MS = 70; // ~2 snapshot periods at the 30Hz SNAPSHOT_RATE — absorbs jitter without over-delaying
let spawnTime        = null;  // performance.now() when last joined — used to ramp up interp delay

// Adaptive jitter buffer — on mobile the network periodically stalls and several
// snapshots arrive late, bunched together. A fixed 50ms buffer can't absorb that,
// so other snakes dead-reckon then snap when the burst lands (the "ping spike"
// glitch). We measure how late each snapshot arrives and temporarily widen the
// buffer to cover the spike, then shrink it back when the network is calm.
const SNAP_PERIOD_MS = 1000 / (CONSTANTS.SNAPSHOT_RATE || CONSTANTS.TICK_RATE); // expected gap between snapshots
let _lastSnapAt = 0;   // client time the previous snapshot arrived
let _jitterBuf  = 0;   // adaptive extra buffer (ms), 0..MAX_JITTER_BUF
const MAX_JITTER_BUF = 180;

// ─── Local snake simulation ──────────────────────────────────────────────────
// Ring buffer of head positions recorded every frame. Body segments are placed
// along this path at fixed spacing — same technique slither.io uses.
const LP_SIZE = 2048;
const _lpX = new Float32Array(LP_SIZE); // head path x coords
const _lpY = new Float32Array(LP_SIZE); // head path y coords
let _lpHead = 0;   // next write index
let _lpLen  = 0;   // valid entry count (≤ LP_SIZE)
let _lAngle    = 0;   // current head angle
let _lBoostAge = 0;   // local boost tick accumulator — matches server boostRamp logic
let _lNumSegs  = 0;   // smoothed segment count — prevents tail snap on boost drops
let _lReady    = false;
let _latestMySnap = null; // most recent server snapshot for local player
let cashoutSpeedMult = 1;    // smoothed speedMult sent to server during Q hold/release

// Displayed (interpolated) state used for rendering
let displayState = { snakes: [], food: [], worldRadius: CONSTANTS.BASE_WORLD_RADIUS, leaderboard: [] };

// Socket — connect to EU EC2 for low ping when EU region is selected
const SERVER_URLS = { na: '', eu: 'https://eu.duelseries.com' };
// Default transport (polling, then upgrade to websocket) — identical to desktop.
// NOTE: forcing websocket-only / polling-only on mobile was tried before and
// reverted (commits 65775be / 363f0b2 / b510915) because mobile carriers throttle
// raw websockets; the default is the known-good config. Don't re-litigate this
// without testing on a real phone first.
const socket = io(SERVER_URLS[selectedRegion] || '');

// Stable id for THIS play session, sent with every PLAY. Survives socket
// reconnects (the page doesn't reload on reconnect), so after a brief network
// drop the server can put us back on the snake it kept alive instead of spawning
// a fresh one. New each page load = new session.
const reconnectKey = (window.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'rk_' + Date.now() + '_' + Math.random().toString(36).slice(2);

const snakeColor = sessionStorage.getItem('snakeColor') || localStorage.getItem('duelseries_skin_color') || '#E8756A';
const hatId      = sessionStorage.getItem('hatId')      || 'none';
const boostId    = sessionStorage.getItem('boostId')    || 'default';

socket.on('connect', () => {
  try { console.log('[net] transport:', socket.io.engine.transport.name); } catch (e) {}
  if (spectateOnly) {
    socket.emit('spectate:join', { lobbyType, region: selectedRegion });
  } else {
    socket.emit(CONSTANTS.EVENTS.PLAY, { name: playerName, walletAddress, googleId, color: snakeColor, lobbyType, entryToken, hatId, boostId, region: selectedRegion, reconnectKey });
  }
});

// Shared AudioContext — mobile browsers suspend audio until a real user
// gesture resumes it, and limit how many contexts you can create. One shared
// context, unlocked on first touch/click, fixes both.
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { return null; }
  }
  if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
  return _audioCtx;
}
// Unlock on the first user interaction. Includes mousemove/mousedown/click because players steer
// by MOVING the mouse (not clicking) — without these the audio context stayed suspended until the
// first click/keypress (~1s in), so the join sound queued up and only fired then. The game iframe
// inherits the lobby's "Play"-click activation (same origin), so resuming on first move works.
['pointerdown', 'mousedown', 'mousemove', 'touchstart', 'touchmove', 'keydown', 'click'].forEach(evt => {
  window.addEventListener(evt, () => getAudioCtx(), { once: true, passive: true });
});

function playMoneySound() {
  if (window.gameMuted) return;
  const ac = getAudioCtx();
  if (!ac) return;
  try {
    [[880, 0], [1100, 0.07], [1320, 0.13], [1760, 0.19]].forEach(([freq, delay]) => {
      const osc  = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const t = ac.currentTime + delay;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.25, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      osc.start(t);
      osc.stop(t + 0.28);
    });
  } catch(e) {}
}

// Smooth "power-down" when YOUR snake dies — a soft sine glide downward + a low thump for weight.
function playDeathSound() {
  if (window.gameMuted) return;
  const ac = getAudioCtx(); if (!ac) return;
  try {
    const t = ac.currentTime;
    // soft descending glide (sine = mellow, not buzzy)
    const osc = ac.createOscillator(), gain = ac.createGain();
    osc.connect(gain); gain.connect(ac.destination);
    osc.type = 'sine'; osc.frequency.setValueAtTime(523, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.55);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.3, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    osc.start(t); osc.stop(t + 0.62);
    // low "thump" underneath for a bit of weight
    const o2 = ac.createOscillator(), g2 = ac.createGain();
    o2.connect(g2); g2.connect(ac.destination);
    o2.type = 'sine'; o2.frequency.setValueAtTime(160, t);
    o2.frequency.exponentialRampToValueAtTime(55, t + 0.25);
    g2.gain.setValueAtTime(0.28, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o2.start(t); o2.stop(t + 0.32);
  } catch (e) {}
}

// Punchy zap when YOU eliminate another snake.
function playKillSound() {
  if (window.gameMuted) return;
  const ac = getAudioCtx(); if (!ac) return;
  try {
    const t = ac.currentTime;
    const osc = ac.createOscillator(), gain = ac.createGain();
    osc.connect(gain); gain.connect(ac.destination);
    osc.type = 'square'; osc.frequency.value = 660;
    osc.frequency.exponentialRampToValueAtTime(170, t + 0.12);
    gain.gain.setValueAtTime(0.28, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.start(t); osc.stop(t + 0.16);
    const o2 = ac.createOscillator(), g2 = ac.createGain();
    o2.connect(g2); g2.connect(ac.destination);
    o2.type = 'square'; o2.frequency.value = 1320;
    g2.gain.setValueAtTime(0.14, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o2.start(t); o2.stop(t + 0.09);
  } catch (e) {}
}

// Triumphant "win" fanfare when YOU cash out — a quick rising flourish, then a HELD major chord +
// sparkle on top. Deliberately bigger/longer than the quick money-pickup blip so they're distinct.
function playCashoutSound() {
  if (window.gameMuted) return;
  const ac = getAudioCtx(); if (!ac) return;
  try {
    const t0 = ac.currentTime;
    const vol = (window.gameMasterVol ?? 1) * (window.gameSfxVol ?? 0.5);
    // 1) quick rising flourish
    [[392, 0], [523, 0.07], [659, 0.14]].forEach(([f, d]) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      o.connect(g); g.connect(ac.destination);
      const t = t0 + d;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.2 * vol, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      o.start(t); o.stop(t + 0.2);
    });
    // 2) sustained major chord (C5-E5-G5-C6) — the "you won" payoff
    const ct = t0 + 0.22;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = (i === 3) ? 'triangle' : 'sine'; o.frequency.value = f;
      o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0, ct);
      g.gain.linearRampToValueAtTime(0.16 * vol, ct + 0.03);
      g.gain.setValueAtTime(0.16 * vol, ct + 0.35);
      g.gain.exponentialRampToValueAtTime(0.001, ct + 0.85);
      o.start(ct); o.stop(ct + 0.88);
    });
    // 3) sparkle gliding up over the chord
    const s = ac.createOscillator(), sg = ac.createGain();
    s.type = 'sine';
    s.frequency.setValueAtTime(1568, ct + 0.05);
    s.frequency.exponentialRampToValueAtTime(2093, ct + 0.3);
    s.connect(sg); sg.connect(ac.destination);
    sg.gain.setValueAtTime(0.0001, ct);
    sg.gain.linearRampToValueAtTime(0.1 * vol, ct + 0.09);
    sg.gain.exponentialRampToValueAtTime(0.0001, ct + 0.5);
    s.start(ct); s.stop(ct + 0.52);
  } catch (e) {}
}

socket.on('ate_dropped_food', playMoneySound);
socket.on(CONSTANTS.EVENTS.PLAYER_KILLED, () => playKillSound()); // satisfying zap when YOU kill another snake

// ─── In-game chat (press T to type) ───────────────────────────────────────────
(function () {
  const messages = document.getElementById('chat-messages');
  const input    = document.getElementById('chat-input');
  const hint     = document.getElementById('chat-hint');
  if (!messages || !input) return;
  window._chatTyping = false;

  function openChat() {
    window._chatTyping = true;
    input.classList.add('open');
    if (hint) hint.style.display = 'none';
    input.value = '';
    setTimeout(() => input.focus(), 0);
  }
  function closeChat() {
    window._chatTyping = false;
    input.classList.remove('open');
    if (hint) hint.style.display = '';
    if (document.activeElement === input) input.blur();
  }
  function addMessage(name, text, isMe) {
    const atBottom = messages.scrollTop + messages.clientHeight >= messages.scrollHeight - 6;
    const el = document.createElement('div');
    el.className = 'chat-msg' + (isMe ? ' me' : '');
    const n = document.createElement('span'); n.className = 'chat-name'; n.textContent = name + ':';
    el.appendChild(n);
    el.appendChild(document.createTextNode(' ' + text)); // text node = can't inject HTML
    messages.appendChild(el);
    while (messages.children.length > 50) messages.removeChild(messages.firstChild); // keep last 50 for scrollback
    if (atBottom) messages.scrollTop = messages.scrollHeight; // stick to newest unless you scrolled up to read
  }
  // Red kill-feed line: "💀 killer killed victim" (or "💀 victim died" with no killer).
  function addKillMessage(killer, victim) {
    const atBottom = messages.scrollTop + messages.clientHeight >= messages.scrollHeight - 6;
    const el = document.createElement('div');
    el.className = 'chat-msg chat-kill';
    el.appendChild(document.createTextNode('💀 '));
    const v = document.createElement('span'); v.className = 'kf-victim'; v.textContent = victim || 'a snake';
    if (killer) {
      const k = document.createElement('span'); k.className = 'kf-killer'; k.textContent = killer;
      el.appendChild(k);
      el.appendChild(document.createTextNode(' killed '));
      el.appendChild(v);
    } else {
      el.appendChild(v);
      el.appendChild(document.createTextNode(' died'));
    }
    messages.appendChild(el);
    while (messages.children.length > 50) messages.removeChild(messages.firstChild);
    if (atBottom) messages.scrollTop = messages.scrollHeight;
  }

  // Press T (when not already typing or focused in another field) to open the chat input.
  window.addEventListener('keydown', (e) => {
    if (window._chatTyping) return;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
    if (e.key === 't' || e.key === 'T') { e.preventDefault(); openChat(); }
  });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep game keys (space/q) from firing while typing
    if (e.key === 'Enter') {
      const text = input.value.trim();
      if (text) socket.emit(CONSTANTS.EVENTS.CHAT, { text });
      closeChat();
    } else if (e.key === 'Escape') {
      closeChat();
    }
  });
  input.addEventListener('blur', closeChat);

  socket.on(CONSTANTS.EVENTS.CHAT, (data) => {
    if (data && data.kind === 'kill') { addKillMessage(data.killer, data.victim); return; }
    addMessage((data && data.name) || 'Player', (data && data.text) || '', !!(data && data.self));
  });
})();

function playJoinSound() {
  if (window.gameMuted) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    // Three ascending notes: C5 → E5 → G5, quick staggered chime
    const notes = [
      { freq: 523.25, t: 0.00 },
      { freq: 659.25, t: 0.13 },
      { freq: 783.99, t: 0.26 },
    ];
    notes.forEach(({ freq, t }) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      // Add a second sine one octave up for brightness
      const osc2  = ctx.createOscillator();
      const gain2 = ctx.createGain();

      osc.type  = 'sine';
      osc2.type = 'sine';
      osc.frequency.value  = freq;
      osc2.frequency.value = freq * 2;

      osc.connect(gain);   gain.connect(ctx.destination);
      osc2.connect(gain2); gain2.connect(ctx.destination);

      const start = ctx.currentTime + t;
      gain.gain.setValueAtTime(0, start);
      const vol = (window.gameMasterVol ?? 1) * (window.gameSfxVol ?? 0.5);
      gain.gain.linearRampToValueAtTime(0.28 * vol, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);

      gain2.gain.setValueAtTime(0, start);
      gain2.gain.linearRampToValueAtTime(0.07, start + 0.018);
      gain2.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);

      osc.start(start);  osc.stop(start + 0.6);
      osc2.start(start); osc2.stop(start + 0.4);
    });
  } catch (e) { /* audio not supported */ }
}

socket.on(CONSTANTS.EVENTS.GAME_JOINED, ({ playerId, worldRadius, food, snake }) => {
  myId = playerId;
  isDead = spectateOnly;
  cashedOut = false;
  cashoutSpeedMult = 1;
  lockedAngle = null;
  cancelQTimer();
  cashoutRings.clear();
  snapBuffer = [];
  clockOffset = null;
  _lastSnapAt = 0;
  _jitterBuf = 0;
  spawnTime = performance.now();
  displayState = { snakes: snake ? [snake] : [], food: food || [], worldRadius, leaderboard: [] };
  document.getElementById('death-screen').classList.remove('active');
  document.getElementById('cashout-screen').classList.remove('active');
  _lReset();
  if (snake) _lInit(snake);
  // Snap the camera straight to the correct zoom/position so the spawn doesn't
  // start zoomed-out and animate in.
  if (renderer && renderer.camera) renderer.camera.snapNextUpdate = true;
  if (spectateOnly) {
    enterSpectate();
  } else {
    playJoinSound();
  }
});

socket.on(CONSTANTS.EVENTS.SNAPSHOT, (meta, coords) => {
  // Snapshots arrive packed: light metadata + an Int16 buffer of all coordinates.
  // Rebuild the full snapshot object the rest of this handler expects.
  const snap = SnapshotCodec.decodeSnapshot(meta, coords);
  // Track clock offset as an exponential moving average of (server_time - client_time).
  // A fixed first-snap offset is fragile — if that packet had unusually high latency,
  // serverNow underestimates actual server time and renderTime falls outside the buffer.
  const arrival = performance.now();
  const sample = snap.t - arrival;
  if (clockOffset === null) {
    clockOffset = sample;
  } else {
    // Blend 10% toward each new sample — adapts within ~10 snaps (~165ms at 60Hz)
    clockOffset += (sample - clockOffset) * 0.1;
  }

  // Adaptive jitter buffer: how much later than expected did this snapshot land?
  // Grow fast on a spike (so we always have a real snapshot to lerp toward),
  // shrink slowly when calm so latency returns to normal once the network settles.
  if (_lastSnapAt) {
    const late = Math.max(0, (arrival - _lastSnapAt) - SNAP_PERIOD_MS);
    if (late > _jitterBuf) _jitterBuf = Math.min(late, MAX_JITTER_BUF);
    else _jitterBuf += (late - _jitterBuf) * 0.03;
  }
  _lastSnapAt = arrival;

  snapBuffer.push({ t: snap.t, state: snap });
  if (snapBuffer.length > 30) snapBuffer.shift();
  const mySnap = snap.snakes.find(s => s.id === myId);
  if (mySnap) {
    _latestMySnap = mySnap;
    if (!_lReady) _lInit(mySnap);
    else _lCorrect(mySnap);
  }
  updateHUD(snap);
  updateLeaderboard(snap);
});

socket.on(CONSTANTS.EVENTS.PLAYER_DIED, ({ score, length }) => {
  isDead = true;
  playDeathSound();
  _lReset();
  const earnedEl = document.getElementById('cashout-earned-inline');
  if (earnedEl) earnedEl.textContent = '';
  const deathH2 = document.querySelector('#death-screen h2');
  deathH2.textContent = 'YOU DIED';
  deathH2.style.color = '';
  document.getElementById('death-screen').classList.add('active');
  document.getElementById('death-length').textContent = length;
  document.getElementById('death-score').textContent = score;
});

// --- Interpolation ---
function interpolateState(now) {
  if (snapBuffer.length === 0 || clockOffset === null) return;

  // Convert client performance.now() to server time so we can compare against snap.t
  const serverNow = now + clockOffset;
  // Ramp interp delay from 0→full over first 500ms after spawn to avoid initial lag
  const spawnAge = spawnTime ? now - spawnTime : Infinity;
  const baseDelay = (spawnAge < 500 ? INTERP_DELAY_MS * (spawnAge / 500) : INTERP_DELAY_MS) + _jitterBuf;
  const renderTime = serverNow - baseDelay;

  // Find the two snapshots that bracket renderTime
  let before = null, after = null;
  for (let i = 0; i < snapBuffer.length - 1; i++) {
    if (snapBuffer[i].t <= renderTime && snapBuffer[i + 1].t >= renderTime) {
      before = snapBuffer[i];
      after  = snapBuffer[i + 1];
      break;
    }
  }

  // If renderTime is older than the buffer, show the oldest available snapshot (not current).
  // This is what makes the cashout slowdown work — we clamp to the oldest state we have.
  if (!before || !after) {
    if (renderTime <= snapBuffer[0].t) {
      displayState = { ...snapBuffer[0].state };
      return;
    }
    // renderTime is newer than latest — dead-reckon forward
    const latest = snapBuffer[snapBuffer.length - 1];
    const extMs = Math.max(0, Math.min(renderTime - latest.t, 200));
    if (extMs > 0) {
      const msPerTick = 1000 / CONSTANTS.TICK_RATE;
      const extSnakes = latest.state.snakes.map(s => {
        if (!s.segs || s.segs.length < 2) return s;
        const speed = CONSTANTS.SNAKE_BASE_SPEED * (1 + (s.boostRamp || 0) * 2);
        const dist = speed * extMs / msPerTick;
        const dx = Math.cos(s.angle) * dist;
        const dy = Math.sin(s.angle) * dist;
        const extSegs = s.segs.slice();
        for (let i = 0; i < extSegs.length; i += 2) { extSegs[i] += dx; extSegs[i + 1] += dy; }
        return { ...s, segs: extSegs };
      });
      displayState = { ...latest.state, snakes: extSnakes };
    } else {
      displayState = { ...latest.state };
    }
    return;
  }

  const alpha = Math.max(0, Math.min(1, (renderTime - before.t) / (after.t - before.t)));

  // Interpolate world radius
  displayState.worldRadius = lerp(before.state.worldRadius, after.state.worldRadius, alpha);
  displayState.leaderboard = after.state.leaderboard;
  displayState.food = after.state.food; // food doesn't need interpolation
  displayState.mm = after.state.mm;     // all-snakes minimap feed (not view-culled)

  // Interpolate each snake — reuse persistent map to avoid per-frame allocation
  if (!interpBeforeMap) interpBeforeMap = new Map();
  else interpBeforeMap.clear();
  for (const s of before.state.snakes) interpBeforeMap.set(s.id, s);

  if (!interpSnakeBuf) interpSnakeBuf = [];
  interpSnakeBuf.length = 0;
  for (const snakeAfter of after.state.snakes) {
    const snakeBefore = interpBeforeMap.get(snakeAfter.id);
    if (!snakeBefore) { interpSnakeBuf.push(snakeAfter); continue; }
    const len = Math.min(snakeBefore.segs.length, snakeAfter.segs.length);
    let segs = _segPool.get(snakeAfter.id);
    if (!segs || segs.length !== snakeAfter.segs.length) {
      segs = new Float32Array(snakeAfter.segs.length);
      _segPool.set(snakeAfter.id, segs);
    }
    for (let i = 0; i < len; i++) segs[i] = lerp(snakeBefore.segs[i], snakeAfter.segs[i], alpha);
    for (let i = len; i < segs.length; i++) segs[i] = snakeAfter.segs[i];
    interpSnakeBuf.push({ ...snakeAfter, segs, angle: lerpAngle(snakeBefore.angle, snakeAfter.angle, alpha) });
  }
  displayState.snakes = interpSnakeBuf;
}


function lerp(a, b, t) { return a + (b - a) * t; }
function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI)  diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// ─── Local snake simulation helpers ─────────────────────────────────────────

function _lReset() { _lReady = false; _lpHead = 0; _lpLen = 0; _latestMySnap = null; _lNumSegs = 0; _lBoostAge = 0; }

function _lInit(s) {
  if (!s || !s.segs || s.segs.length < 2) return;
  _lpHead = 0; _lpLen = 0;
  // Fill ring buffer tail→head so most-recent entry = snake head
  const n = s.segs.length >> 1;
  for (let i = n - 1; i >= 0; i--) {
    _lpX[_lpHead] = s.segs[i * 2];
    _lpY[_lpHead] = s.segs[i * 2 + 1];
    _lpHead = (_lpHead + 1) % LP_SIZE;
    if (_lpLen < LP_SIZE) _lpLen++;
  }
  _lAngle = s.angle || 0;
  _lReady = true;
}

// Gentle correction toward server head position — 15% per snapshot, no snapping.
// On a high-ping link the server snapshot is stale AND arrives in bursts, so
// correcting hard toward it fights the player's own turning (the snake "won't
// turn / goes straight") and kinks the body. Below ~60ms ping (typical desktop)
// we correct fully as before; above that we scale the correction down so local
// input stays responsive on mobile. The server is still authoritative — this only
// changes how quickly the *visual* local snake is pulled back into sync.
function _lCorrect(s) {
  if (!_lReady || !s || !s.segs || s.segs.length < 2) return;
  const ping = pingMs || 0;
  const corr = ping < 60 ? 1 : Math.max(0.2, 1 - (ping - 60) / 250);
  const hi = (_lpHead - 1 + LP_SIZE) % LP_SIZE;
  _lpX[hi] += (s.segs[0] - _lpX[hi]) * 0.10 * corr;
  _lpY[hi] += (s.segs[1] - _lpY[hi]) * 0.10 * corr;
  // Blend angle toward server — never snap, avoids visible direction changes
  let da = s.angle - _lAngle;
  while (da >  Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  _lAngle += da * 0.15 * corr;
  // Only reset boost age when boost stops — re-syncing every tick fights the local advance and causes micro-jitter
  if ((s.boostRamp || 0) === 0) _lBoostAge = 0;
}

// Advance head by dt ms using targetAngle with server-matched turn rate
function _lAdvance(dt, targetAngle) {
  if (!_lReady) return;
  const msPerTick = 1000 / CONSTANTS.TICK_RATE;
  // Match server turn rate including the size penalty so angles don't diverge
  const snakeLen = _latestMySnap ? (_latestMySnap.length || 0) : 0;
  const minSegs  = CONSTANTS.SNAKE_MIN_SEGMENTS * 2;
  const sizePenalty = Math.min(0.55, (snakeLen - minSegs) / 500);
  const tr = CONSTANTS.MAX_TURN_RATE * (1 - sizePenalty) * (dt / msPerTick);
  let delta = targetAngle - _lAngle;
  while (delta >  Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  _lAngle += Math.abs(delta) > tr ? Math.sign(delta) * tr : delta;
  // Advance boost age locally — don't wait for server snapshot (that's 1 tick stale)
  const hasFuel = _latestMySnap && (_latestMySnap.boostRatio || 0) > 0;
  if (boostActive && hasFuel) {
    _lBoostAge += dt / msPerTick;
  } else {
    _lBoostAge = 0;
  }
  const localBoostRamp = _lBoostAge <= 0  ? 0
    : _lBoostAge <= 6  ? _lBoostAge / 6 * 0.5
    : _lBoostAge <= 12 ? 0.5 + (_lBoostAge - 6) / 6 * 0.5
    : 1;
  const boost = 1 + localBoostRamp * 2;
  const sm    = cashoutSpeedMult || 1;
  const dist  = CONSTANTS.SNAKE_BASE_SPEED * boost * sm * (dt / msPerTick);
  const hi    = (_lpHead - 1 + LP_SIZE) % LP_SIZE;
  _lpX[_lpHead] = _lpX[hi] + Math.cos(_lAngle) * dist;
  _lpY[_lpHead] = _lpY[hi] + Math.sin(_lAngle) * dist;
  _lpHead = (_lpHead + 1) % LP_SIZE;
  if (_lpLen < LP_SIZE) _lpLen++;
}

// Walk path backward from head, placing numSegs segments at fixed spacing
function _lBuildSegs(numSegs) {
  if (!_lReady || _lpLen < 2 || numSegs < 1) return null;
  // Match the adaptive step used in Snake.js serialize()
  const snakeLen = _latestMySnap ? (_latestMySnap.length || 0) : 0;
  const step = snakeLen < 400 ? 2 : snakeLen < 800 ? 3 : 4;
  const SEG_SPACING = CONSTANTS.SNAKE_SEGMENT_SPACING * step;
  const out = new Float32Array(numSegs * 2);
  let idx = (_lpHead - 1 + LP_SIZE) % LP_SIZE;
  let cx = _lpX[idx], cy = _lpY[idx];
  out[0] = cx; out[1] = cy;
  let remaining = SEG_SPACING;
  let used = 1;
  for (let seg = 1; seg < numSegs; seg++) {
    let placed = false;
    while (true) {
      if (used >= _lpLen) { out[seg*2] = cx; out[seg*2+1] = cy; placed = true; break; }
      const pi = (idx - 1 + LP_SIZE) % LP_SIZE;
      const dx = _lpX[pi] - cx, dy = _lpY[pi] - cy;
      const d  = Math.hypot(dx, dy);
      if (d >= remaining) {
        const t = remaining / d;
        cx += dx * t; cy += dy * t;
        out[seg*2] = cx; out[seg*2+1] = cy;
        remaining = SEG_SPACING;
        placed = true;
        break;
      }
      remaining -= d;
      cx = _lpX[pi]; cy = _lpY[pi];
      idx = pi; used++;
    }
    if (!placed) break;
  }
  return out;
}

// --- Input ---
canvas.addEventListener('mousemove', (e) => {
  mousePos.x = e.clientX;
  mousePos.y = e.clientY;
});
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('mousedown', (e) => { if (e.button === 0 || e.button === 2) boostActive = true; });
canvas.addEventListener('mouseup',   (e) => { if (e.button === 0 || e.button === 2) boostActive = false; });
window.addEventListener('keydown', (e) => { if (window._chatTyping) return; if (e.code === 'Space') { e.preventDefault(); boostActive = true; } });
window.addEventListener('keyup',   (e) => { if (e.code === 'Space') boostActive = false; });
// ─── Virtual Joystick ────────────────────────────────────────────────────────
{
  const joystickZone = document.getElementById('joystick-zone');
  const joystickBase = document.getElementById('joystick-base');
  const joystickKnob = document.getElementById('joystick-knob');
  const boostBtn     = document.getElementById('boost-btn');
  const BASE_R = 55; // half of 110px base
  const KNOB_CLAMP = BASE_R - 6;

  let joystickActive = false;
  let joystickAngle  = null;
  let joystickTouchId = null;

  function onJoyStart(e) {
    e.preventDefault();
    if (joystickTouchId !== null) return;
    const t = e.changedTouches[0];
    joystickTouchId = t.identifier;
    joystickActive = true;
    updateKnob(t.clientX, t.clientY);
  }
  function onJoyMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== joystickTouchId) continue;
      updateKnob(t.clientX, t.clientY);
    }
  }
  function onJoyEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== joystickTouchId) continue;
      joystickTouchId = null;
      joystickActive = false;
      joystickAngle = null;
      joystickKnob.style.transform = 'translate(-50%, -50%)';
    }
  }
  function updateKnob(cx, cy) {
    const rect = joystickBase.getBoundingClientRect();
    const ox = cx - (rect.left + BASE_R);
    const oy = cy - (rect.top  + BASE_R);
    const dist = Math.sqrt(ox * ox + oy * oy);
    const clampDist = Math.min(dist, KNOB_CLAMP);
    const nx = dist === 0 ? 0 : (ox / dist) * clampDist;
    const ny = dist === 0 ? 0 : (oy / dist) * clampDist;
    joystickKnob.style.transform = `translate(calc(-50% + ${nx}px), calc(-50% + ${ny}px))`;
    if (dist > 6) joystickAngle = Math.atan2(oy, ox);
  }

  joystickZone.addEventListener('touchstart', onJoyStart, { passive: false });
  joystickZone.addEventListener('touchmove',  onJoyMove,  { passive: false });
  joystickZone.addEventListener('touchend',   onJoyEnd,   { passive: false });
  joystickZone.addEventListener('touchcancel',onJoyEnd,   { passive: false });

  // Boost button
  boostBtn.addEventListener('touchstart', (e) => { e.preventDefault(); boostActive = true; boostBtn.classList.add('active'); },    { passive: false });
  boostBtn.addEventListener('touchend',   (e) => { e.preventDefault(); boostActive = false; boostBtn.classList.remove('active'); }, { passive: false });
  boostBtn.addEventListener('touchcancel',(e) => { boostActive = false; boostBtn.classList.remove('active'); }, { passive: false });

  // Expose for sendInput
  window._joystick = { get active() { return joystickActive; }, get angle() { return joystickAngle; } };
}

// Canvas touch (finger steering) — only used when joystick not active
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (window._joystick && window._joystick.active) return;
  const t = e.touches[0];
  mousePos.x = t.clientX;
  mousePos.y = t.clientY;
}, { passive: false });
canvas.addEventListener('touchstart', (e) => { if (e.touches.length > 1) boostActive = true; });
canvas.addEventListener('touchend',   (e) => { if (e.touches.length === 0) boostActive = false; });

// Mobile cash-out button — wired after startQTimer/cancelQTimer are defined below
document.addEventListener('DOMContentLoaded', () => {});
(function wireCashoutBtn() {
  const coBtn = document.getElementById('cashout-btn-mobile');
  if (!coBtn) return;
  coBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    coBtn.classList.add('holding');
    if (typeof startQTimer === 'function') startQTimer();
  }, { passive: false });
  coBtn.addEventListener('touchend', (e) => {
    e.preventDefault();
    coBtn.classList.remove('holding');
    if (typeof cancelQTimer === 'function') cancelQTimer();
  }, { passive: false });
  coBtn.addEventListener('touchcancel', () => {
    coBtn.classList.remove('holding');
    if (typeof cancelQTimer === 'function') cancelQTimer();
  });
})();

// ─── Q Cash-out ───────────────────────────────────────────────────────────────
const Q_HOLD_MS = 3000;
const RING_CIRC = 213.6;
let qHoldStart   = null;
let qHoldTimer   = null;
let cashedOut    = false;
let lockedAngle  = null;

const qTimerEl   = document.getElementById('q-timer');
const qRingEl    = document.getElementById('q-timer-ring');
const qTimerText = document.getElementById('q-timer-text');

// Tracks which snakes are currently cashing out: id -> { start, duration }
const cashoutRings = new Map();

function startQTimer() {
  if (isDead || cashedOut || !myId) return;
  boostActive = false; // disable boost while cashing out
  qHoldStart = performance.now();
  qTimerEl.classList.add('active');
  qRingEl.style.strokeDashoffset = RING_CIRC;
  socket.emit('cashout:start');

  qHoldTimer = setInterval(() => {
    const elapsed = performance.now() - qHoldStart;
    const t = Math.min(elapsed / Q_HOLD_MS, 1);
    qRingEl.style.strokeDashoffset = RING_CIRC * (1 - t);

    if (elapsed >= Q_HOLD_MS) {
      clearInterval(qHoldTimer);
      qHoldTimer = null;
      triggerCashOut();
    }
  }, 30);
}

function cancelQTimer() {
  if (qHoldTimer) { clearInterval(qHoldTimer); qHoldTimer = null; }
  qHoldStart = null;
  lockedAngle = null;
  qTimerEl.classList.remove('active');
  qRingEl.style.strokeDashoffset = RING_CIRC;
  socket.emit('cashout:cancel');
}

function triggerCashOut() {
  cashedOut = true;
  isDead = true;
  cashoutRings.delete(myId);
  qTimerEl.classList.remove('active');
  qTimerText.textContent = 'Q';
  socket.emit('cashout');
}

socket.on('cashout:started', ({ id }) => {
  cashoutRings.set(id, { start: performance.now(), duration: Q_HOLD_MS });
});
socket.on('cashout:cancelled', ({ id }) => {
  cashoutRings.delete(id);
});

socket.on('cashout:result', ({ newBalance, earnedSol, score, length, toWallet }) => {
  if (window.phEvent) window.phEvent('cashed_out', { game: 'snake', amount: earnedSol, score: score, length: length });
  playCashoutSound();
  // earnedSol holds the earned amount in the active unit: USDC after cutover, SOL before.
  // Show death screen with cashout message
  document.getElementById('death-score').textContent = score || 0;
  document.getElementById('death-length').textContent = length || 0;
  // Inject earned line if not already there
  let earnedEl = document.getElementById('cashout-earned-inline');
  if (!earnedEl) {
    earnedEl = document.createElement('p');
    earnedEl.id = 'cashout-earned-inline';
    earnedEl.style.cssText = 'color:#14F195;font-size:1.05rem;font-weight:700;margin:8px 0 0;';
    document.querySelector('#death-screen .death-stats').insertAdjacentElement('afterend', earnedEl);
  }
  earnedEl.textContent = earnedSol > 0
    ? (moneyMode === 'usdc'
        ? `+$${earnedSol.toFixed(2)} ${toWallet ? 'sent to' : 'deposited to'} your wallet`
        : (toWallet ? `Sending ${earnedSol.toFixed(4)} SOL to your wallet…` : `+C$${(earnedSol * solCadRate).toFixed(2)} deposited to your wallet`))
    : '';
  const h2 = document.querySelector('#death-screen h2');
  h2.textContent = 'SUCCESSFULLY CASHED OUT';
  h2.style.color = '#14F195';
  document.getElementById('death-screen').classList.add('active');
  if (newBalance !== null) sessionStorage.setItem('lastBalance', newBalance);
});

// Self-custody payout follow-ups (Phase 2): the escrow → wallet transfer confirms async.
socket.on('cashout:paid', ({ sol, sig }) => {
  const el = document.getElementById('cashout-earned-inline');
  if (el) { el.textContent = `✓ ${Number(sol).toFixed(4)} SOL sent to your wallet`; el.style.color = '#14F195'; }
});
socket.on('cashout:error', ({ message }) => {
  const el = document.getElementById('cashout-earned-inline');
  if (el) { el.textContent = message || 'Payout failed — contact support'; el.style.color = '#ff7a7a'; }
});

window.addEventListener('keydown', (e) => {
  if (window._chatTyping) return;
  if ((e.key === 'q' || e.key === 'Q') && !e.repeat && !isDead && !cashedOut) {
    e.preventDefault();
    startQTimer();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'q' || e.key === 'Q') {
    if (!cashedOut) cancelQTimer();
  }
});

document.getElementById('btn-cashout-spectate').addEventListener('click', () => {
  document.getElementById('cashout-screen').classList.remove('active');
  enterSpectate();
});
document.getElementById('btn-cashout-lobby').addEventListener('click', () => {
  goToLobby();
});

// ─── Spectate ─────────────────────────────────────────────────────────────────
let spectating   = false;
let spectateIndex = 0;

function getSpectateTargets() {
  return displayState.snakes.filter(s => s.id !== myId);
}

function enterSpectate() {
  spectating = true;
  spectateIndex = 0;
  document.getElementById('death-screen').classList.remove('active');
  document.getElementById('spectate-bar').classList.add('active');
  updateSpectateLabel();
  ['joystick-zone', 'boost-btn', 'cashout-btn-mobile'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function exitSpectate() {
  spectating = false;
  document.getElementById('spectate-bar').classList.remove('active');
  ['joystick-zone', 'boost-btn', 'cashout-btn-mobile'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  });
}

function updateSpectateLabel() {
  const targets = getSpectateTargets();
  const label = document.getElementById('spectate-label');
  if (targets.length === 0) {
    label.textContent = 'No players to spectate';
  } else {
    const t = targets[spectateIndex % targets.length];
    label.textContent = 'Spectating: ' + (t.name || 'Player');
  }
}

document.getElementById('btn-spectate').addEventListener('click', enterSpectate);

document.getElementById('spectate-prev').addEventListener('click', () => {
  const n = getSpectateTargets().length;
  if (n === 0) return;
  spectateIndex = (spectateIndex - 1 + n) % n;
  updateSpectateLabel();
});

document.getElementById('spectate-next').addEventListener('click', () => {
  const n = getSpectateTargets().length;
  if (n === 0) return;
  spectateIndex = (spectateIndex + 1) % n;
  updateSpectateLabel();
});

document.getElementById('spectate-stop').addEventListener('click', () => {
  goToLobby();
});

// Ask the parent page's wallet widget to re-stake (Privy approval) for a paid respawn, and
// resolve with the fresh entry token. Resolves null if cancelled/failed or not in an iframe.
function requestRestake(game, lobbyType) {
  return new Promise((resolve) => {
    if (window.self === window.top) { resolve(null); return; }
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; window.removeEventListener('message', onMsg); resolve(val); };
    const onMsg = (e) => {
      const d = e.data;
      if (!d || (d.type !== 'duel:restake:done' && d.type !== 'duel:restake:error')) return;
      if (d.type === 'duel:restake:error') { if (d.message) alert(d.message); finish(null); }
      else finish(d.entryToken || '');
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type: 'duel:restake', game, lobbyType }, '*');
    setTimeout(() => finish(null), 120000); // safety: don't hang forever
  });
}

// Shared respawn logic used by both the death screen and spectate bar
let respawning = false;
async function doRespawn() {
  if (!isDead || respawning) return;
  respawning = true;
  try {
    let respawnToken = null;
    if (lobbyType !== 'free') {
      // Paid lobbies are self-custody — re-stake from the wallet (Privy approval) right here,
      // then respawn in place. The prior stake was lost when the snake died.
      respawnToken = await requestRestake('snake', lobbyType);
      if (!respawnToken) return; // cancelled or failed — stay on the death screen
    }
    isDead = false;
    cashedOut = false;
    exitSpectate();
    socket.emit(CONSTANTS.EVENTS.RESPAWN, { entryToken: respawnToken });
    document.getElementById('death-screen').classList.remove('active');
    const earnedEl = document.getElementById('cashout-earned-inline');
    if (earnedEl) earnedEl.textContent = '';
  } finally {
    respawning = false;
  }
}

document.getElementById('btn-respawn').addEventListener('click', doRespawn);
document.getElementById('spectate-play-again').addEventListener('click', spectateOnly ? goToLobby : doRespawn);
document.getElementById('btn-lobby').addEventListener('click', () => {
  goToLobby();
});

// ─── All-Time Leaderboard Modal ───────────────────────────────────────────────
(function() {
  const modal   = document.getElementById('modal-alltime');
  const listEl  = document.getElementById('alltime-list');
  const openBtn = document.getElementById('btn-alltime-lb');
  const closeBtn = document.getElementById('modal-alltime-close');

  function escHtmlLocal(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // Event delegation — works regardless of when items are rendered
  listEl.addEventListener('click', (e) => {
    const el = e.target.closest('[data-player-name]');
    if (!el) return;
    modal.classList.add('hidden');
    window.openProfile(el.dataset.playerName);
  });

  openBtn.addEventListener('click', () => {
    modal.classList.remove('hidden');
    listEl.innerHTML = '<li style="color:#555">Loading…</li>';
    fetch('/api/leaderboard')
      .then(r => r.json())
      .then(data => {
        if (!data.length) {
          listEl.innerHTML = '<li style="color:#555">No scores recorded yet</li>';
          return;
        }
        listEl.innerHTML = data.map(p =>
          `<li data-player-name="${escHtmlLocal(p.name)}">` +
          `<span class="al-rank">#${p.rank}</span>` +
          `<span class="al-name al-name-link">${escHtmlLocal(p.name)}</span>` +
          `<span class="al-score">${p.score}</span></li>`
        ).join('');
      })
      .catch(() => { listEl.innerHTML = '<li style="color:#c33">Failed to load</li>'; });
  });

  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
})();

// Resize
function resize() { renderer.resize(); }
resize();
window.addEventListener('resize', resize);

// Send input at 60Hz (matches server tick rate)
function sendInput() {
  if (!myId || isDead) return;
  const mySnake = displayState.snakes.find(s => s.id === myId);
  if (!mySnake) return;

  if (qHoldStart !== null && lockedAngle === null) lockedAngle = mySnake.angle;

  const joy = window._joystick;
  const angle = lockedAngle !== null
    ? lockedAngle
    : (joy && joy.active && joy.angle !== null)
    ? joy.angle
    : Math.atan2(
        renderer.camera.screenToWorld(mousePos.x, mousePos.y, canvas.width, canvas.height).y - mySnake.segs[1],
        renderer.camera.screenToWorld(mousePos.x, mousePos.y, canvas.width, canvas.height).x - mySnake.segs[0]
      );

  // Q held: ramp speed down to 0.2x. Released: instant full speed (no lag to clear).
  if (qHoldStart) {
    const t = Math.min(1, (performance.now() - qHoldStart) / Q_HOLD_MS);
    cashoutSpeedMult = Math.max(0.2, 1 - 0.8 * t);
  } else {
    cashoutSpeedMult = 1;
  }
  // VOLATILE: input is sent 60x/sec and each carries the absolute current angle, so a
  // dropped one is harmlessly superseded 16ms later. Reliable emits would queue on a
  // congested mobile uplink and back up the buffer (delaying ping_check too).
  socket.volatile.emit(CONSTANTS.EVENTS.INPUT, { angle, boost: boostActive && !qHoldStart, speedMult: cashoutSpeedMult });
}
setInterval(sendInput, 1000 / 60);

// ─── View radius (area-of-interest) ───────────────────────────────────────────
// Report how far we can currently see, in world units, so the server only sends
// snakes/food within range. Without it every snapshot carries the WHOLE map — fine
// on desktop, but it floods a phone's connection once the room fills with bots.
let _lastViewR = 0, _lastViewSentAt = 0;
function maybeSendView(now) {
  const scale = (renderer.camera && renderer.camera.scale) || 1;
  // radius of the circle that covers the whole screen rectangle, in world units
  const viewR = Math.hypot(window.innerWidth / 2, window.innerHeight / 2) / scale;
  // it's a control message, not per-frame state — only resend on a real change
  if (Math.abs(viewR - _lastViewR) > _lastViewR * 0.15 || now - _lastViewSentAt > 1000) {
    socket.emit('view', { r: Math.round(viewR) });
    _lastViewR = viewR;
    _lastViewSentAt = now;
  }
}

// HUD (updated on each snapshot, not each frame)
function updateHUD(snap) {
  const mySnake = snap.snakes.find(s => s.id === myId);
  if (mySnake) {
    const lengthEl = document.getElementById('hud-length');
    const scoreEl  = document.getElementById('hud-score');
    if (lengthEl) lengthEl.textContent = mySnake.length;
    if (scoreEl)  scoreEl.textContent  = mySnake.score;
    const pct  = Math.round((mySnake.boostRatio || 0) * 100);
    const fill = document.getElementById('boost-bar-fill');
    if (fill) fill.style.width = pct + '%';
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Leaderboard — updated from snapshot (60Hz max), not render loop
let _lastLbHtml = '';
function updateLeaderboard(snap) {
  const aliveIds = new Set(snap.snakes.map(s => s.id));
  const lb = (snap.leaderboard || []).filter(p => aliveIds.has(p.id));
  const isPaid = lobbyType !== 'free';
  const html = lb.map(p => {
    const val = isPaid
      ? fmtMoney(p.worth)
      : p.score;
    return `<li class="${p.id === myId ? 'me' : ''}" data-player-name="${escHtml(p.name)}">` +
      `<span class="lb-rank">#${p.rank}</span>` +
      `<span class="lb-name">${escHtml(p.name)}</span>` +
      `<span class="lb-score">${val}</span></li>`;
  }).join('') || '<li style="color:#555">—</li>';
  if (html !== _lastLbHtml) {
    const lbEl = document.getElementById('leaderboard-list');
    if (lbEl) lbEl.innerHTML = html;
    _lastLbHtml = html;
  }
}

// Ping tracker
const pingDotEl   = document.getElementById('ping-dot');
const pingValueEl = document.getElementById('ping-value');
let pingMs = null;
let pingSentAt = null;

function sendPing() {
  pingSentAt = performance.now();
  socket.emit('ping_check');
}
socket.on('pong_check', () => {
  if (pingSentAt === null) return;
  pingMs = Math.round(performance.now() - pingSentAt);
  pingSentAt = null;
  pingValueEl.textContent = pingMs + ' ms';
  pingDotEl.className = 'ping-dot ' + (pingMs < 50 ? 'ping-green' : pingMs < 100 ? 'ping-orange' : 'ping-red');
});
setInterval(sendPing, 2000);
sendPing();

// FPS / perf counters
let fpsFrames = 0, fpsLast = performance.now(), fpsDisplay = 0;
const fpsEl   = document.getElementById('fps-counter');
const perfEl  = document.getElementById('perf-counter');
if (perfEl) perfEl.style.display = 'none';   // CPU/GPU counter removed

let _lastFrameTime = 0;
// Main render loop — runs at monitor refresh rate (60/144/240Hz)
function gameLoop(now) {
  const dt = Math.min(_lastFrameTime ? now - _lastFrameTime : 16.67, 50);
  _lastFrameTime = now;

  // Advance local snake simulation every frame (no server wait)
  if (_lReady && !isDead && !cashedOut) {
    const joy = window._joystick;
    const localHeadX = _lpX[(_lpHead - 1 + LP_SIZE) % LP_SIZE];
    const localHeadY = _lpY[(_lpHead - 1 + LP_SIZE) % LP_SIZE];
    let targetAngle;
    if (lockedAngle !== null) {
      targetAngle = lockedAngle;
    } else if (joy && joy.active && joy.angle !== null) {
      targetAngle = joy.angle;
    } else {
      const wm = renderer.camera.screenToWorld(mousePos.x, mousePos.y, canvas.width, canvas.height);
      targetAngle = Math.atan2(wm.y - localHeadY, wm.x - localHeadX);
    }
    _lAdvance(dt, targetAngle);
  }

  interpolateState(now);

  // Replace local snake in displayState with the locally-simulated version
  if (_lReady && myId && !isDead && !cashedOut && _latestMySnap) {
    const targetNumSegs = _latestMySnap.segs.length >> 1;
    // Grow instantly (eating food), shrink gradually (boost drops) — prevents tail snap
    if (targetNumSegs > _lNumSegs) _lNumSegs = targetNumSegs;
    else _lNumSegs += (targetNumSegs - _lNumSegs) * 0.08;
    const simSegs = _lBuildSegs(Math.round(_lNumSegs));
    if (simSegs) {
      let found = false;
      for (let i = 0; i < displayState.snakes.length; i++) {
        if (displayState.snakes[i].id === myId) {
          displayState.snakes[i] = { ..._latestMySnap, segs: simSegs, angle: _lAngle };
          found = true; break;
        }
      }
      if (!found) displayState.snakes.push({ ..._latestMySnap, segs: simSegs, angle: _lAngle });
    }
  }

  let spectateSnake = null;
  if (spectating) {
    const targets = getSpectateTargets();
    if (targets.length > 0) spectateSnake = targets[spectateIndex % targets.length];
  }
  const renderState = cashedOut
    ? { ...displayState, snakes: displayState.snakes.filter(s => s.id !== myId) }
    : displayState;
  renderer.render(renderState, cashedOut ? null : myId, mousePos, spectateSnake, cashoutRings, dt);


  // Tell the server our current view radius (area-of-interest culling) so it only
  // sends snakes/food we can actually see — keeps the snapshot small on mobile.
  maybeSendView(now);

  // FPS
  fpsFrames++;
  if (now - fpsLast >= 500) {
    fpsDisplay = Math.round(fpsFrames * 1000 / (now - fpsLast));
    fpsFrames = 0; fpsLast = now;
    if (fpsEl) fpsEl.textContent = `FPS: ${fpsDisplay}`;
  }

  requestAnimationFrame(gameLoop);
}
requestAnimationFrame(gameLoop);

// ─── Admin console (press ` to toggle) ───────────────────────────────────────
(function() {
  const consoleEl  = document.getElementById('admin-console');
  const inputEl    = document.getElementById('admin-input');
  const feedbackEl = document.getElementById('admin-feedback');

  function openConsole() {
    consoleEl.classList.add('open');
    inputEl.value = '';
    feedbackEl.textContent = '';
    inputEl.focus();
  }
  function closeConsole() { consoleEl.classList.remove('open'); }

  window.addEventListener('keydown', (e) => {
    if (e.key === '`' || e.key === '~') {
      e.preventDefault();
      consoleEl.classList.contains('open') ? closeConsole() : openConsole();
      return;
    }
    if (e.key === 'Escape' && consoleEl.classList.contains('open')) closeConsole();
  });

  inputEl.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    const raw = inputEl.value.trim().toLowerCase();
    if (!raw) { closeConsole(); return; }

    const parts = raw.split(/\s+/);
    const cmd   = parts[0];

    if (cmd === 'bot' || cmd === 'bots') {
      const count = parseInt(parts[1]) || 1;
      socket.emit('admin:spawnbot', { count, idToken: localStorage.getItem('duel_admin_token') || undefined });
      feedbackEl.textContent = `Requesting ${count} bot(s)...`;
    } else {
      feedbackEl.textContent = 'Commands: bot [n]';
    }
    inputEl.value = '';
  });

  socket.on('admin:ack', ({ message }) => {
    feedbackEl.textContent = '✓ ' + message;
    setTimeout(closeConsole, 1800);
  });
})();

// ─── Player Profile Modal ─────────────────────────────────────────────────────
(function() {
  const modal      = document.getElementById('modal-profile');
  const closeBtn   = document.getElementById('modal-profile-close');
  const nameEl     = document.getElementById('profile-name');
  const earningsEl = document.getElementById('profile-earnings');
  const gamesEl    = document.getElementById('profile-games');
  const timeEl     = document.getElementById('profile-time');
  const chartCanvas= document.getElementById('profile-chart');
  const loadingEl  = document.getElementById('profile-loading');
  const intervalBtns = document.querySelectorAll('.interval-btn');

  let currentProfile = null;
  let currentPeriod  = 'week';

  function formatPlayTime(s) {
    if (s < 60) return s + 's';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function formatPeriodLabel(dateStr, period) {
    const d = new Date(dateStr);
    if (period === 'week' || period === 'month') {
      return (d.getMonth()+1) + '/' + d.getDate();
    } else if (period === 'sixMonth') {
      return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ' W' + Math.ceil(d.getDate()/7);
    } else {
      return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ' ' + d.getFullYear().toString().slice(2);
    }
  }

  function drawChart(historyData, period) {
    const ctx = chartCanvas.getContext('2d');
    const W = chartCanvas.width, H = chartCanvas.height;
    const rate = moneyMode === 'usdc' ? 1 : (typeof solCadRate !== 'undefined' ? solCadRate : 200);
    const sym = moneyMode === 'usdc' ? '$' : 'C$';
    ctx.clearRect(0, 0, W, H);

    if (!historyData || historyData.length === 0) {
      ctx.fillStyle = '#444';
      ctx.font = '13px Segoe UI';
      ctx.textAlign = 'center';
      ctx.fillText('No data for this period', W/2, H/2);
      return;
    }

    const pad = { top: 12, right: 12, bottom: 28, left: 48 };
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top - pad.bottom;

    const vals = historyData.map(d => d.total * rate);
    const maxAbs = Math.max(Math.abs(Math.min(...vals)), Math.abs(Math.max(...vals)), 0.01);
    const barW = Math.max(4, Math.floor(cW / historyData.length) - 2);

    // Zero line y
    const zeroY = pad.top + cH / 2;

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (cH / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    }

    // Zero line
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.left, zeroY); ctx.lineTo(W - pad.right, zeroY); ctx.stroke();

    // Y axis labels
    ctx.fillStyle = '#555';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    const topVal = (maxAbs * rate).toFixed(2);
    ctx.fillText('+' + sym + topVal, pad.left - 4, pad.top + 4);
    ctx.fillText('-' + sym + topVal, pad.left - 4, H - pad.bottom - 4);
    ctx.fillText('0', pad.left - 4, zeroY + 4);

    // Bars
    historyData.forEach((d, i) => {
      const val = d.total * rate;
      const barH = Math.abs(val) / maxAbs * (cH / 2);
      const x = pad.left + i * (cW / historyData.length) + (cW / historyData.length - barW) / 2;
      const y = val >= 0 ? zeroY - barH : zeroY;
      ctx.fillStyle = val >= 0 ? '#14F195' : '#ef4444';
      ctx.beginPath();
      ctx.roundRect(x, y, barW, Math.max(barH, 2), 2);
      ctx.fill();
    });

    // X axis labels — show up to 7 evenly spaced
    ctx.fillStyle = '#555';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    const labelCount = Math.min(7, historyData.length);
    const step = Math.max(1, Math.floor(historyData.length / labelCount));
    for (let i = 0; i < historyData.length; i += step) {
      const x = pad.left + i * (cW / historyData.length) + (cW / historyData.length) / 2;
      ctx.fillText(formatPeriodLabel(historyData[i].period, period), x, H - pad.bottom + 12);
    }
  }

  function renderProfile() {
    if (!currentProfile) return;
    const rate = moneyMode === 'usdc' ? 1 : (typeof solCadRate !== 'undefined' ? solCadRate : 200);
    const sym = moneyMode === 'usdc' ? '$' : 'C$';
    const cad = (currentProfile.totalEarnings * rate).toFixed(2);
    const sign = currentProfile.totalEarnings >= 0 ? '+' : '';
    earningsEl.textContent = sign + sym + cad;
    earningsEl.style.color = currentProfile.totalEarnings >= 0 ? '#14F195' : '#ef4444';
    gamesEl.textContent = currentProfile.gamesPlayed;
    timeEl.textContent = formatPlayTime(currentProfile.playTimeSeconds);
    drawChart(currentProfile.history[currentPeriod], currentPeriod);
  }

  window.openProfile = async function openProfile(playerName) {
    modal.classList.remove('hidden');
    nameEl.textContent = playerName;
    earningsEl.textContent = '—';
    gamesEl.textContent = '—';
    timeEl.textContent = '—';
    loadingEl.style.display = 'block';
    chartCanvas.style.display = 'none';
    currentProfile = null;
    try {
      const res = await fetch('/api/profile/' + encodeURIComponent(playerName));
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      currentProfile = data;
      loadingEl.style.display = 'none';
      chartCanvas.style.display = 'block';
      renderProfile();
    } catch (e) {
      loadingEl.textContent = 'Failed to load profile';
    }
  }

  // Leaderboard click
  document.getElementById('leaderboard-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-player-name]');
    if (li) openProfile(li.dataset.playerName);
  });

  // Interval buttons
  intervalBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      intervalBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPeriod = btn.dataset.period;
      if (currentProfile) drawChart(currentProfile.history[currentPeriod], currentPeriod);
    });
  });

  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
})();
