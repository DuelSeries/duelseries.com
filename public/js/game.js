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
/* Two ways a room can be named. The old lobby sets lobbyType; the redesigned
   one sets stake, a rung of the ladder. The widget clears whichever it did not
   set, so at most one is present and there is nothing to disambiguate. Both are
   echoed back on join and the server decides the room from whichever it got. */
const stakeRaw      = sessionStorage.getItem('stake');
const stake         = (stakeRaw === null || stakeRaw === '') ? null : Number(stakeRaw);
const lobbyType     = sessionStorage.getItem('lobbyType')     || (stake === null ? 'free' : null);
// "Paid" is about money, not about which name was used to ask for the room.
/* By the LIST, not by the name. lobbyType !== 'free' made the battle royale a
   paid room, so dying in one sent Play again off to buy an entry it does not
   sell: the widget correctly returned an empty token for a free lobby, the
   token read as falsy, and the respawn silently gave up. That is why the button
   did nothing. */
const FREE_TYPES    = new Set(CONSTANTS.FREE_LOBBY_TYPES || ['free']);
const isPaidRoom    = (stake !== null) ? stake > 0 : !FREE_TYPES.has(lobbyType);
/* The nightly event. Free to enter and paid by the house, so it is not a paid
   room in the staking sense — nothing here is staked and nothing is cashed out. */
const isBattleRoyale = lobbyType === 'br';
const entrySol      = parseFloat(sessionStorage.getItem('entrySol') || '0');
const entryToken    = sessionStorage.getItem('entryToken') || null;
const selectedRegion = sessionStorage.getItem('region') || 'na';
const spectateOnly  = sessionStorage.getItem('spectateOnly') === 'true';

// SOL/CAD rate — fetched once on load
let solCadRate = 200;
fetch('/api/prices').then(r => r.json()).then(d => { if (d.solCadRate) solCadRate = d.solCadRate; }).catch(() => {});
let moneyMode = 'sol';
let moneyNetwork = 'mainnet-beta';   // which cluster payout links should point at
fetch('/api/money-config').then(r => r.json()).then(c => {
  if (c && c.mode) moneyMode = c.mode;
  if (c && c.network) moneyNetwork = c.network;
}).catch(() => {});
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
let interpFoodMap   = null; // reused across frames — before-snapshot food by id
let interpFoodBuf   = null; // reused across frames — interpolated food list
let interpAfterIds  = null; // reused across frames — current snapshot's snake ids, for pruning _segPool
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
let _lBoostRamp = 0;  // local boost ramp 0..1 — mirrors the server's ramp/glide exactly
let _lNumSegs  = 0;   // smoothed segment count — prevents tail snap on boost drops
let _lReady    = false;
let _latestMySnap = null; // most recent server snapshot for local player
let cashoutSpeedMult = 1;    // smoothed speedMult sent to server during Q hold/release

// Displayed (interpolated) state used for rendering
let displayState = { snakes: [], food: [], worldRadius: CONSTANTS.BASE_WORLD_RADIUS,
                     worldCx: 0, worldCy: 0, leaderboard: [] };

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

// Fallback is a slither palette colour (was #E8756A, which wasn't one). The
// server re-checks this anyway and swaps anything off-palette for a random
// palette colour, so a stale value can't put a non-slither snake in play.
const snakeColor = sessionStorage.getItem('snakeColor') || localStorage.getItem('duelseries_skin_color') || '#c080ff';

socket.on('connect', () => {
  try { console.log('[net] transport:', socket.io.engine.transport.name); } catch (e) {}
  if (spectateOnly) {
    socket.emit('spectate:join', { lobbyType, stake, region: selectedRegion });
  } else {
    socket.emit(CONSTANTS.EVENTS.PLAY, { name: playerName, walletAddress, googleId, color: snakeColor, lobbyType, stake, entryToken, region: selectedRegion, reconnectKey });
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

/* The cash-out fanfare. The sound itself lives in js/cashoutSound.js because
   every game pays out with the SAME sound, and three copies of a sound do not
   stay identical. This one only supplies the context, the output and the
   volume the player has set. */
function playCashoutSound() {
  if (window.gameMuted) return;
  const ac = getAudioCtx(); if (!ac) return;
  const vol = (window.gameMasterVol ?? 1) * (window.gameSfxVol ?? 0.5);
  if (window.CashoutSound) window.CashoutSound.play(ac, ac.destination, vol);
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

socket.on(CONSTANTS.EVENTS.GAME_JOINED, ({ playerId, worldRadius, worldCx, worldCy, food, snake }) => {
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
  displayState = { snakes: snake ? [snake] : [], food: food || [], worldRadius,
                   worldCx: worldCx || 0, worldCy: worldCy || 0, leaderboard: [] };
  document.getElementById('death-screen').classList.remove('active');
  document.getElementById('cashout-screen').classList.remove('active');
  if (!spectateOnly) showTouchControls(true);
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
  if (window.__duelDiagSnapshot) window.__duelDiagSnapshot();
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

  // What the snake was carrying when it died is what the player just lost, so
  // the card says it. The last snapshot is the right source: every snake
  // carries worth, while the leaderboard only holds the top ten. Read BEFORE
  // _lReset, which clears it.
  const lost = isPaidRoom && _latestMySnap ? (_latestMySnap.worth || 0) : 0;

  _lReset();
  showTouchControls(false);

  const screen = document.getElementById('death-screen');
  screen.classList.toggle('dd-free', !(lost > 0));
  document.getElementById('dd-lost').textContent = fmtMoney(lost);
  document.getElementById('dd-sub').textContent = lost > 0
    ? 'lost with your snake'
    : (isPaidRoom ? 'Your snake was not carrying anything' : 'Free lobby, nothing was staked');

  // Playing again in a paid room means staking again, so the button says the
  // price rather than springing a wallet prompt on a tap labelled "Play again".
  const again = document.getElementById('btn-respawn');
  again.textContent = (isPaidRoom && stake > 0) ? `Play again ${fmtMoney(stake)}` : 'Play again';

  document.getElementById('cashout-screen').classList.remove('active');
  screen.classList.add('active');
  document.getElementById('death-length').textContent = length;
  document.getElementById('death-score').textContent = score;
});

/* The drawn world, for the console. Same reasoning as SHOOTER_STATE in the tank
   game: this is data the page has already been sent and already draws, so it
   gives nothing away — what it gives is a way to measure what is actually on
   screen when it looks wrong, instead of arguing about it. */
window.SNAKE_STATE = function () { return displayState; };
window.SNAKE_SNAPS = function () { return snapBuffer; };
window.SNAKE_ME = function () { return myId; };

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
        const esc = Math.min(6, 1 + ((s.length || 0) - CONSTANTS.SNAKE_MIN_SEGMENTS * 2) / CONSTANTS.SNAKE_SC_SEGS);
        const ebase = CONSTANTS.SNAKE_BASE_SPEED + CONSTANTS.SNAKE_SPEED_PER_SC * (esc - 1);
        const speed = ebase + (CONSTANTS.SNAKE_MAX_SPEED - ebase) * (s.boostRamp || 0);
        const dist = speed * extMs / msPerTick;
        // Advance the HEAD along its heading, then have every following segment
        // walk toward the one ahead of it — the body stays on the path it already
        // occupies. Translating every segment by the head's heading (which is what
        // this used to do) slides a curved snake sideways as a rigid block and it
        // visibly deforms, then snaps back when real snapshots resume. That made
        // any late snapshot look like the snake was glitching.
        const extSegs = s.segs.slice();
        extSegs[0] += Math.cos(s.angle) * dist;
        extSegs[1] += Math.sin(s.angle) * dist;
        for (let i = 2; i < extSegs.length; i += 2) {
          const px = extSegs[i - 2], py = extSegs[i - 1];   // already-moved predecessor
          const cx = s.segs[i], cy = s.segs[i + 1];         // this segment, pre-move
          const ddx = px - cx, ddy = py - cy;
          const d = Math.hypot(ddx, ddy);
          if (d > 1e-6) {
            const step = Math.min(dist, d);                 // never overshoot the one ahead
            extSegs[i]     = cx + (ddx / d) * step;
            extSegs[i + 1] = cy + (ddy / d) * step;
          }
        }
        return { ...s, segs: extSegs };
      });
      displayState = { ...latest.state, snakes: extSnakes };
    } else {
      displayState = { ...latest.state };
    }
    return;
  }

  const alpha = Math.max(0, Math.min(1, (renderTime - before.t) / (after.t - before.t)));

  /* Radius AND centre. A zone that closes in on somewhere off-centre moves both
     at once, and interpolating one without the other makes the ring appear to
     wobble as it shrinks. */
  displayState.worldRadius = lerp(before.state.worldRadius, after.state.worldRadius, alpha);
  displayState.worldCx = lerp(before.state.worldCx || 0, after.state.worldCx || 0, alpha);
  displayState.worldCy = lerp(before.state.worldCy || 0, after.state.worldCy || 0, alpha);
  /* NOT interpolated. The target is a fixed place the zone is travelling to,
     not a moving thing — lerping between two snapshots of it would slide the
     outline around for no reason, and it must sit exactly where the wall will
     stop or it is lying about where to stand. */
  displayState.zoneTo = after.state.zoneTo || null;
  /* HOW MUCH WORLD THE MINIMAP DRAWS, which is not how much of it is currently
     in play. A battle royale arena starts at the full world and only closes in,
     so the map is pinned to that from the outset — otherwise somebody arriving
     to watch the last ring gets a minimap of a 300-unit circle and no idea
     where anything is. Everywhere else the renderer's own high-water mark is
     right, because those worlds only grow. */
  displayState.mapRadius = isBattleRoyale ? CONSTANTS.MAX_WORLD_RADIUS : 0;
  displayState.leaderboard = after.state.leaderboard;
  displayState.mm = after.state.mm;     // all-snakes minimap feed (not view-culled)

  // Food: mostly static, but food being magnetized toward a mouth moves every server tick
  // and visibly stepped at 30Hz. Lerp only the food that actually moved between snapshots
  // (a handful at a time) — untouched food is passed through with zero allocation.
  if (!interpFoodMap) interpFoodMap = new Map(); else interpFoodMap.clear();
  for (const f of before.state.food) interpFoodMap.set(f.id, f);
  if (!interpFoodBuf) interpFoodBuf = [];
  interpFoodBuf.length = 0;
  for (const fa of after.state.food) {
    const fb = interpFoodMap.get(fa.id);
    if (fb && (fb.x !== fa.x || fb.y !== fa.y)) {
      // _pulled: this orb is being magnetized toward a mouth — the renderer suppresses
      // its idle hover so the suck-in reads as a clean straight pull.
      interpFoodBuf.push({ ...fa, x: lerp(fb.x, fa.x, alpha), y: lerp(fb.y, fa.y, alpha), _pulled: true });
    } else {
      interpFoodBuf.push(fa);
    }
  }
  displayState.food = interpFoodBuf;

  // Interpolate each snake — reuse persistent map to avoid per-frame allocation
  if (!interpBeforeMap) interpBeforeMap = new Map();
  else interpBeforeMap.clear();
  for (const s of before.state.snakes) interpBeforeMap.set(s.id, s);

  if (!interpSnakeBuf) interpSnakeBuf = [];
  interpSnakeBuf.length = 0;
  if (!interpAfterIds) interpAfterIds = new Set(); else interpAfterIds.clear();
  for (const snakeAfter of after.state.snakes) {
    interpAfterIds.add(snakeAfter.id);
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

  // Prune _segPool of snakes no longer present (died/despawned) — otherwise every
  // distinct snake id ever seen keeps its Float32Array alive for the whole session.
  if (_segPool.size > interpAfterIds.size) {
    for (const id of _segPool.keys()) {
      if (!interpAfterIds.has(id)) _segPool.delete(id);
    }
  }
}


function lerp(a, b, t) { return a + (b - a) * t; }
function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff > Math.PI)  diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

// ─── Local snake simulation helpers ─────────────────────────────────────────

function _lReset() { _lStoreReset(); _lReady = false; _lpHead = 0; _lpLen = 0; _latestMySnap = null; _lNumSegs = 0; _lBoostRamp = 0; }

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
  /* THE WHOLE SNAKE MOVES, not just its head.

     Being told the head is somewhere else means the whole snake was predicted
     in the wrong place, so the whole snake shifts. This used to slide the head
     alone and leave the stored body where it was, and since the local head
     runs ahead of the server's, the correction was almost always BACKWARDS —
     sliding the head back through its own first body point, several times a
     second, forever. The stored path then ran forward out of the head and
     doubled back, and the body resampler walked that fold and stacked the
     first drawn point on the head. Measured in a full client-and-server loop:
     the first stored point ended up 0.41 of a body step IN FRONT of the head,
     and every kink landed on the first gap — which is exactly what Owen's own
     client reported, loAt 1 on all 25 samples.

     Translating the body by the same delta costs one pass over points already
     in cache and keeps the snake rigid through a correction, which is what a
     position correction means. */
  const hi = (_lpHead - 1 + LP_SIZE) % LP_SIZE;
  const cdx = (s.segs[0] - _lpX[hi]) * 0.10 * corr;
  const cdy = (s.segs[1] - _lpY[hi]) * 0.10 * corr;
  _lpX[hi] += cdx;
  _lpY[hi] += cdy;
  for (let i = 0; i < _lsPts.length; i++) { _lsPts[i].x += cdx; _lsPts[i].y += cdy; }
  // Blend angle toward server — never snap, avoids visible direction changes
  let da = s.angle - _lAngle;
  while (da >  Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  _lAngle += da * 0.15 * corr;
  // No hard boost-ramp resync — local ramp and glide use the same rules as the server,
  // both are bounded 0..1, and the release decay converges to 0 on its own. (Snapping to
  // the ~100ms-stale server value here fought the local advance and caused micro-jitter.)
}

// Advance head by dt ms using targetAngle with server-matched turn rate
function _lAdvance(dt, targetAngle) {
  if (!_lReady) return;
  const msPerTick = 1000 / CONSTANTS.TICK_RATE;
  // Match server turn rate including the size penalty so angles don't diverge
  const snakeLen = _latestMySnap ? (_latestMySnap.length || 0) : 0;
  const minSegs  = CONSTANTS.SNAKE_MIN_SEGMENTS * 2;
  // Match the server's size-based turn curve so the predicted angle doesn't diverge
  const sc = Math.min(6, 1 + (snakeLen - minSegs) / CONSTANTS.SNAKE_SC_SEGS);
  const scang = 0.13 + 0.87 * Math.pow((7 - sc) / 6, 2);
  const tr = CONSTANTS.MAX_TURN_RATE * scang * (dt / msPerTick);
  let delta = targetAngle - _lAngle;
  while (delta >  Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  _lAngle += Math.abs(delta) > tr ? Math.sign(delta) * tr : delta;
  // Advance the boost ramp locally — don't wait for server snapshot (that's 1 tick stale).
  // Same slither-style dynamics as the server: linear ramp up over BOOST_RAMP_TICKS,
  // exponential glide down on release (dt-based so it's identical at any framerate).
  const hasFuel = _latestMySnap && (_latestMySnap.boostRatio || 0) > 0;
  if (boostActive && hasFuel) {
    _lBoostRamp = Math.min(1, _lBoostRamp + (dt / msPerTick) / CONSTANTS.BOOST_RAMP_TICKS);
  } else {
    _lBoostRamp *= Math.exp(-dt / CONSTANTS.BOOST_DECAY_MS);
    if (_lBoostRamp < 0.02) _lBoostRamp = 0;
  }
  const localBoostRamp = _lBoostRamp;
  // Match the server speed model: base rises with size, boost eases toward the cap.
  const baseSpeed   = CONSTANTS.SNAKE_BASE_SPEED + CONSTANTS.SNAKE_SPEED_PER_SC * (sc - 1);
  const targetSpeed = baseSpeed + (CONSTANTS.SNAKE_MAX_SPEED - baseSpeed) * localBoostRamp;
  const sm    = cashoutSpeedMult || 1;
  const dist  = targetSpeed * sm * (dt / msPerTick);
  const hi    = (_lpHead - 1 + LP_SIZE) % LP_SIZE;
  _lpX[_lpHead] = _lpX[hi] + Math.cos(_lAngle) * dist;
  _lpY[_lpHead] = _lpY[hi] + Math.sin(_lAngle) * dist;
  _lpHead = (_lpHead + 1) % LP_SIZE;
  if (_lpLen < LP_SIZE) _lpLen++;
}

/* THE LOCAL BODY RUNS THE SERVER'S MODEL: coarse stored points plus the pull.

   It must, because the pull makes the body ride inside the head's path. A plain
   resample of the recorded path would not coil, so the local snake would behave
   differently from every other snake on screen and from the server.

   Deliberately mirrors server/Snake.js line for line, same array operations in
   the same order. A hand-rolled shift here instead of splice/pop put the two
   0.59 body radii apart, about one stored point of phase, which is the kind of
   divergence that shows up as waves travelling down the body.

   Persistent state, advanced a frame at a time, never rebuilt: rebuilding per
   frame while the spacing changed with the snake caused the flickering tail. */
let _lsPts = [], _lsAccum = 0;
let _segBuf = null;

function _lStoreReset() { _lsPts = []; _lsAccum = 0; }

function _lBuildSegs(numSegs) {
  if (!_lReady || _lpLen < 2 || numSegs < 1) return null;
  const snakeLen = _latestMySnap ? (_latestMySnap.length || 0) : 0;
  const sc = Math.max(1, Math.min(6, 1 + (snakeLen - CONSTANTS.SNAKE_MIN_SEGMENTS * 2) / CONSTANTS.SNAKE_SC_SEGS));
  const settled = CONSTANTS.SNAKE_STORED_GAP_PER_R * CONSTANTS.SNAKE_HEAD_RADIUS * sc;
  const sep     = settled * CONSTANTS.SNAKE_INSERT_COMPENSATION;
  const pull    = CONSTANTS.SNAKE_BODY_PULL;
  /* Published so the geometry check compares against the step actually used
     rather than re-deriving it and agreeing with itself. */
  _lLastSettled = settled;

  /* Keep more stored points than the render needs.

     The body is resampled at a fixed `settled` spacing walking back from the
     head. Stored points sit `sep` apart and the pull then compresses them to
     about `settled`, which means a store of exactly numSegs points is almost
     exactly the arc length the resample wants. "Almost exactly" is the bug:
     it crosses the boundary constantly, so on some frames the walk fills every
     slot from real geometry and on others it runs out and the last point falls
     back to an interpolated slide. Measured frame to frame, the final segment
     length cycled 0, 0.05, 0.41, 0.78, 1.14, 1.49, then snapped to a full 6.69
     and back to 0, many times a second. That is the tail tip visibly growing
     and shrinking, which is what it looks like from the outside.

     Four points of slack is NOT enough, and that is the distortion.

     "The pull then compresses them to about `settled`" is the wrong word.
     Measured off this very code, the pull settles the stored gaps at 0.86 to
     0.96 of `settled` depending on size, and lower still for several seconds
     after the snake grows, because growth widens `settled` immediately while
     the store only respaces one point per insertion.

     So the store runs a few percent SHORT of the arc the walk wants, and that
     shortfall is a percentage while the slack was a fixed count of four. The
     two cross over. Measured: the walk starves past about 60 drawn points in
     steady play, and past about 30 while growing. From then on it runs off the
     end of the path every frame, the tail-slide fallback fires early, and two
     points land almost on top of each other — one gap at 5% to 45% of the
     spacing while every other gap in the body is exact. Which is what a kink
     in the body is.

     The fix is to size the store by the ARC IT MUST HOLD rather than by a
     point count, since arc length is what the walk actually consumes. The
     bound below is proportional so it cannot be outgrown, and the top-up after
     the extend loop makes short-store starvation structurally impossible
     rather than merely unlikely — it measures the store instead of trusting a
     constant, so retuning the pull can never quietly bring this back.

     This cannot change the drawn body anywhere it was already correct. The
     pull cascades strictly head-to-tail, so points added past the tail can
     never move a point ahead of them, and the walk stops as soon as it has
     numSegs points. The only thing extra store changes is whether the walk
     reaches the end of the path. */
  const needArc = (numSegs - 1) * settled;
  const STORE = Math.max(numSegs + 4, Math.ceil(needArc / (settled * 0.85)) + 4);

  const hi = (_lpHead - 1 + LP_SIZE) % LP_SIZE;
  const pi = (hi - 1 + LP_SIZE) % LP_SIZE;
  const hx = _lpX[hi], hy = _lpY[hi];

  // Fresh spawn: lay the body straight back from the head at the resting gap.
  if (_lsPts.length < 2) {
    _lsPts = [];
    for (let i = 0; i < STORE; i++) {
      _lsPts.push({ x: hx - Math.cos(_lAngle) * i * settled,
                    y: hy - Math.sin(_lAngle) * i * settled });
    }
    _lsAccum = 0;
  }

  _lsPts[0].x = hx; _lsPts[0].y = hy;
  _lsAccum += Math.hypot(hx - _lpX[pi], hy - _lpY[pi]);

  let guard = 0;
  while (_lsAccum >= sep && guard++ < 8) {
    _lsAccum -= sep;
    const p1 = _lsPts[1] || _lsPts[0];
    const dx = hx - p1.x, dy = hy - p1.y;
    const d  = Math.hypot(dx, dy) || 1;
    // Clamped so a point can never land in front of the head — see Snake.js,
    // which this mirrors line for line.
    const t  = Math.min(1, sep / d);
    _lsPts.splice(1, 0, { x: p1.x + dx * t, y: p1.y + dy * t });
    while (_lsPts.length > STORE) _lsPts.pop();

    // the pull, each point toward its leader's position at the start of the pass
    let leadX = _lsPts[0].x, leadY = _lsPts[0].y;
    for (let i = 1; i < _lsPts.length; i++) {
      const p = _lsPts[i];
      const oldX = p.x, oldY = p.y;
      const mv = pull * (i < 4 ? i / 4 : 1);
      p.x += (leadX - p.x) * mv;
      p.y += (leadY - p.y) * mv;
      leadX = oldX; leadY = oldY;
    }
  }
  while (_lsPts.length < STORE) {
    const t = _lsPts[_lsPts.length - 1];
    const u = _lsPts[_lsPts.length - 2];
    /* Extend along the tail heading rather than duplicating the last point.
       A duplicate adds no arc length, so the store would report the right
       number of points while being exactly as short as it was, and the walk
       would starve anyway. */
    let ux = u ? t.x - u.x : Math.cos(_lAngle + Math.PI) * settled;
    let uy = u ? t.y - u.y : Math.sin(_lAngle + Math.PI) * settled;
    const ul = Math.hypot(ux, uy) || 1;
    _lsPts.push({ x: t.x + ux / ul * sep, y: t.y + uy / ul * sep });
  }

  /* The guarantee the walk below depends on: the store holds at least the arc
     the walk will ask for. STORE is sized from a compression bound, and a
     bound is an assumption; this measures the real thing and extends the tail
     until it is true, so the walk cannot run off the end whatever the pull
     does. Costs one pass over points that are already in cache, and the loop
     normally runs zero times.

     Bounded so a degenerate store (every point stacked, so haveArc never
     rises) cannot spin: extendable points are capped at what the arc could
     possibly need at `sep` apart, plus the same four points of slack. */
  let haveArc = 0;
  for (let i = 1; i < _lsPts.length; i++) {
    haveArc += Math.hypot(_lsPts[i].x - _lsPts[i - 1].x, _lsPts[i].y - _lsPts[i - 1].y);
  }
  const capPts = Math.ceil(needArc / sep) + STORE + 4;
  while (haveArc < needArc && _lsPts.length < capPts) {
    const t = _lsPts[_lsPts.length - 1];
    const u = _lsPts[_lsPts.length - 2];
    let ux = u ? t.x - u.x : Math.cos(_lAngle + Math.PI) * settled;
    let uy = u ? t.y - u.y : Math.sin(_lAngle + Math.PI) * settled;
    const ul = Math.hypot(ux, uy) || 1;
    _lsPts.push({ x: t.x + ux / ul * sep, y: t.y + uy / ul * sep });
    haveArc += sep;
  }

  /* Reused between frames: a fresh Float32Array per frame is 237 throwaway
     arrays a second for one snake on a 240Hz display. */
  /* Resampled uniformly from the head, exactly as Snake.drawPoints does, with
     the tail sliding between the last two stored points.

     The raw stored points cannot be drawn: they are laid at discrete intervals
     while the head moves continuously, so the head-to-first-point gap cycles
     from zero to a full separation (24 units at a big size, more than a body
     radius) and the first segment stretches and snaps every cycle. That is the
     head blinking and appearing to spin through a turn. The tail retires a whole
     point at a time for the same reason, which was a 148%-of-a-body-radius jump
     before the slide was added. */
  const need = numSegs * 2;
  if (!_segBuf || _segBuf.length < need) _segBuf = new Float32Array(Math.ceil(need * 1.5));
  const out = _segBuf.length === need ? _segBuf : _segBuf.subarray(0, need);

  let w = 0;
  out[w++] = _lsPts[0].x; out[w++] = _lsPts[0].y;
  let cx = _lsPts[0].x, cy = _lsPts[0].y, look = settled;
  for (let i = 1; i < _lsPts.length && w < need; ) {
    const dx = _lsPts[i].x - cx, dy = _lsPts[i].y - cy;
    const d = Math.hypot(dx, dy);
    if (d < 1e-9) { i++; continue; }
    if (d >= look) {
      const t = look / d;
      cx += dx * t; cy += dy * t;
      out[w++] = cx; out[w++] = cy;
      look = settled;
    } else {
      look -= d; cx = _lsPts[i].x; cy = _lsPts[i].y; i++;
    }
  }
  // tail slides between the last two stored points, driven by the same
  // accumulator that triggers insertion, so the handover is seamless
  if (w < need && _lsPts.length >= 2) {
    const fr = Math.min(1, Math.max(0, _lsAccum / sep));
    const a = _lsPts[_lsPts.length - 1], c = _lsPts[_lsPts.length - 2];
    out[w++] = a.x + (c.x - a.x) * fr;
    out[w++] = a.y + (c.y - a.y) * fr;
  }
  /* Last resort, and it should now be unreachable: the store is guaranteed
     above to hold the arc this walk consumes. It used to copy the previous
     point, which produces a zero-length gap — two body circles stamped at the
     same place, the most visible kink of the lot. Extending along the last
     heading keeps the spacing right, so even if something upstream does go
     wrong the body stays smooth instead of folding. */
  while (w < need) {
    let ux = out[w - 2] - out[w - 4], uy = out[w - 1] - out[w - 3];
    let ul = Math.hypot(ux, uy);
    if (!(ul > 1e-9)) { ux = Math.cos(_lAngle + Math.PI); uy = Math.sin(_lAngle + Math.PI); ul = 1; }
    out[w] = out[w - 2] + ux / ul * settled;
    out[w + 1] = out[w - 1] + uy / ul * settled;
    w += 2;
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
/* ─── Touch steering ──────────────────────────────────────────────────────────
   This is slither.io's own scheme, read out of their client rather than guessed
   at (slither.io/s/game*.js, window.ontouchstart / ontouchmove / ontouchend).
   What they actually do, in full:

     ontouchmove   xm = touch.clientX - ww/2;  ym = touch.clientY - hh/2
     ontouchstart  same, plus: if this touch landed within 24px on BOTH axes of
                   the previous one and within 400ms of it, setAcceleration(1)
     ontouchend    setAcceleration(0)

   and the heading is Math.atan2(ym, xm), held at the current angle while
   xm² + ym² <= 256, i.e. inside a 16px radius of the screen centre.

   So there is no virtual joystick and no anchor at the touch-down point: the
   snake steers toward wherever your finger is, measured from the middle of the
   screen, which is where the head sits. Put a thumb anywhere and it turns to
   meet it. Boost is a double-tap, held for as long as the finger stays down.

   Ours measures from the head's real position instead of assuming it is dead
   centre, which is identical whenever the camera is settled and better when it
   is not. Everything else is their numbers. */
const TOUCH_DEADZONE_PX  = 10;    // below this the thumb has not asked for a turn
const TOUCH_FOLLOW_R     = 60;    // the anchor is never left further behind than this

let touchSteering = false;   // a finger is down and steering
let touchAngle    = null;    // heading the thumb has asked for; null means hold
/* THE HEADING TO HOLD AFTER THE THUMB COMES OFF.

   Lifting used to drop straight through to the mouse branch, which steers at
   the last touch COORDINATE — so letting go mid-turn sent the snake off toward
   wherever your finger happened to leave the glass, which is not a direction
   anybody aimed. Reported as "it goes in the direction of where I let off my
   finger, I want it to keep going where the arrow was pointing".

   The arrow is drawn from _lAngle, the snake's real heading, so that is what is
   captured here. Null on desktop and while a finger is down, which is what
   keeps the mouse path untouched. */
let touchHoldAngle = null;
let anchorX = 0, anchorY = 0;

/* Steering always tracks the FIRST finger down. A second finger is the boost
   pedal and must not move the snake, which is why this reads touches[0] and
   not changedTouches: on a second-finger press changedTouches is the new
   finger, and steering would jump to it. */
function touchPoint(e) {
  const t = e.touches[0] || e.changedTouches[0];
  return t ? { x: t.clientX, y: t.clientY } : null;
}

/* The heading is the direction from the anchor to the thumb, and the anchor is
   wherever the thumb first landed. Put a thumb at the bottom of the screen,
   slide it up a little, and the snake goes up.

   The anchor follows: once the thumb is further than TOUCH_FOLLOW_R away it is
   dragged along so it stays exactly that far behind. Without that, a long drag
   in one direction runs out of thumb travel and the stick pins at full lock;
   with it there is always room to turn back, in any direction, forever. */
function updateTouchAim(p) {
  mousePos.x = p.x;                     // kept in sync for anything else reading it
  mousePos.y = p.y;
  let dx = p.x - anchorX, dy = p.y - anchorY;
  const d = Math.hypot(dx, dy);
  if (d > TOUCH_FOLLOW_R) {
    anchorX = p.x - (dx / d) * TOUCH_FOLLOW_R;
    anchorY = p.y - (dy / d) * TOUCH_FOLLOW_R;
    dx = p.x - anchorX; dy = p.y - anchorY;
  }
  if (d > TOUCH_DEADZONE_PX) touchAngle = Math.atan2(dy, dx);
  // Inside the dead zone touchAngle is left alone, so the snake holds its line
  // rather than jittering under a resting thumb.
}

/* Boost is a second finger anywhere on the screen: hold it down to boost, lift
   it to stop, and the steering thumb never has to leave the glass.

   This replaced a double-tap, which is what slither's web client does. A
   double-tap means the boost only starts on a tap whose PREVIOUS tap was in
   almost the same spot, so boosting mid-turn meant lifting the thumb you were
   steering with, and the snake coasted straight for the gap. */
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (e.touches.length > 1) { boostActive = true; return; }   // pedal, not a turn
  const p = touchPoint(e);
  if (!p) return;
  touchSteering = true;
  // A new touch starts a fresh stick under the thumb, and asks for no turn yet.
  anchorX = p.x; anchorY = p.y;
  touchAngle = null;
  touchHoldAngle = null;       // the thumb is back; it is steering again
  mousePos.x = p.x; mousePos.y = p.y;
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const p = touchPoint(e);
  if (p) updateTouchAim(p);
}, { passive: false });

/* ── Battle Royale ────────────────────────────────────────────────────────────
   The server owns the match; this only draws what it says. Cash out is not
   merely hidden here — the server refuses it in this room — but the button has
   to go too, because a control that does nothing is worse than no control. */
const brHud = document.getElementById('br-hud');
/* The zone runs on rings now, not on a clock: it announces where the circle is
   going, travels there, and rests before calling the next one. The old clock
   phases are kept as aliases so a client that is mid-session against a server
   that has not restarted yet still has a word to show. */
const PHASE_WORDS = {
  waiting: 'Waiting', countdown: 'Starting',
  warning: 'Next circle', closing: 'Closing in', holding: 'The circle is set',
  roaming: 'The circle is moving', sudden: 'Sudden death', overtime: 'Overtime',
  over: 'Match over',
};
/* The count is driven by a LOCAL clock from a server deadline, not by a message
   per second. A ticking number needs to move smoothly and a snapshot every two
   seconds cannot do that; and if the connection hiccups at 3, the number must
   not freeze on 3 and then jump to GO. */
let brCountEnd = 0, brCountTimer = 0;
/* Whether the SERVER says this wallet is an owner. Sticky, because only the
   br:peek reply carries it — the room-wide br:state broadcasts cannot, since it
   is the one field that differs per listener. */
let _brIsOwner = false;

/* When the next match starts, as a local deadline, and how many are still in
   the current one. Kept so the death card can COUNT rather than restate a
   number that only refreshes every couple of seconds. */
let _brNextStartAt = 0;
let _brAlive = 0;
let _brWhenTimer = 0;

/* The line under the death card's buttons, in a battle royale.

   Two states, and they answer different questions. While a match runs the
   question is "why can I not press Play again", and the answer is that one is
   on and how many are left in it. Between matches it is "when can I play", and
   the answer is a clock. */
function paintDeathWhen(state) {
  const el = document.getElementById('dd-when');
  if (!el) return;
  if (!isBattleRoyale) { el.hidden = true; return; }

  const running = state === 'running' || state === 'countdown';
  const tick = () => {
    if (running) {
      el.textContent = _brAlive === 1
        ? 'A match is finishing. The next one opens right after.'
        : 'A match is under way, ' + _brAlive + ' still alive. Watch it, or wait for the next.';
      return;
    }
    if (!_brNextStartAt) { el.textContent = ''; return; }
    const left = Math.max(0, _brNextStartAt - Date.now());
    const h = Math.floor(left / 3600000);
    const m = Math.floor(left % 3600000 / 60000);
    const sec = Math.floor(left % 60000 / 1000);
    el.textContent = 'Next battle royale starts in '
      + (h ? h + 'h ' : '') + m + 'm ' + sec + 's';
  };
  tick();
  el.hidden = false;
  /* One timer, restarted rather than stacked: brApply runs on every state and
     a fresh interval each time would leave a dozen of them counting at once. */
  clearInterval(_brWhenTimer);
  _brWhenTimer = setInterval(tick, 1000);
}

/* Say something to the person pressing an owner control. It goes in the HUD
   subtitle, which the next state tick will overwrite a second or two later —
   long enough to read, and it cannot get stuck on screen. */
function brSay(message) {
  const sub = document.getElementById('br-sub');
  if (sub) sub.textContent = message;
}

function brRunCountdown(msLeft) {
  brCountEnd = Date.now() + msLeft;
  clearInterval(brCountTimer);
  const paint = () => {
    const left = brCountEnd - Date.now();
    if (left <= 0) {
      clearInterval(brCountTimer); brCountTimer = 0;
      showGameMessage('GO', { count: true });
      return;
    }
    showGameMessage('Starting in ' + Math.ceil(left / 1000), { count: true, hold: true });
  };
  paint();
  brCountTimer = setInterval(paint, 120);
}

function brApply(s) {
  if (!brHud || !isBattleRoyale) return;
  /* Counting down IS the match starting, so cash out closes here rather than
     ten seconds later. Nothing is gained by banking in the last ten seconds,
     and a control that works right up to the gun is a control people will try
     to use at the gun. */
  brRunning = s.state === 'running' || s.state === 'countdown';

  /* PLAY AGAIN IS OFF WHILE THE MATCH IS ON. This is last snake standing for a
     real prize: somebody who can rejoin cannot lose, and the server refuses it
     anyway. Watch and Lobby stay, so dying still leaves you two things to do
     rather than a dead button and a shrug. */
  const again = document.getElementById('btn-respawn');
  if (again) {
    again.disabled = brRunning;
    again.title = brRunning ? 'The match is under way. Watch, or wait for the next one.' : '';
    again.textContent = brRunning ? 'Match under way' : 'Play again';
  }
  /* Say how long the wait is. A disabled Play again with nothing beside it is
     indistinguishable from a broken one, and "wait for the next one" without a
     number is not an answer. Held here and ticked down locally between server
     states, so it counts rather than jumping every two seconds. */
  _brNextStartAt = (s.nextStartMs > 0) ? Date.now() + s.nextStartMs : 0;
  _brAlive = s.alive || 0;
  paintDeathWhen(s.state);
  podiumApply(s);
  brNextApply(s);
  if (s.state === 'countdown' && !brCountTimer) brRunCountdown(s.countdownMs || 0);
  if (s.state !== 'countdown' && brCountTimer) {
    clearInterval(brCountTimer); brCountTimer = 0;
    /* The count is pinned on screen with hold:true, which means nothing else
       will ever take it down. A cancelled match would otherwise leave
       'Starting in 4' sitting there for the rest of the session. */
    hideGameMessage();
  }
  brHud.hidden = false;
  brHud.dataset.phase = s.phase || s.state || 'waiting';
  document.getElementById('br-phase').textContent = PHASE_WORDS[s.phase] || 'Waiting';
  document.getElementById('br-alive').textContent = s.alive || 0;

  const sub = document.getElementById('br-sub');
  if (s.state === 'running') {
    /* There is no match clock any more, so there is no time remaining to show.
       The match runs until one snake is left; what there IS to count is the
       wall's next move, which is the only number here anybody can act on. */
    const solo = s.startedWith === 1 ? ' · solo run' : '';
    const secs = Math.ceil((s.zoneMs || 0) / 1000);
    sub.textContent = (
      s.phase === 'warning' ? 'The circle closes in ' + secs + 's'
      : s.phase === 'closing' ? 'The circle is closing. Get inside it.'
      : 'Ring ' + (s.ring || 1) + ' · last one alive wins') + solo;
  } else if (s.state === 'over') {
    sub.textContent = s.soloRun
      ? (s.winner ? 'You lasted the whole match' : 'The circle got you')
      : (s.winner ? s.winner.name + ' won' : 'Nobody survived');
  } else {
    sub.textContent = s.players >= s.minPlayers
      ? 'Ready when the host starts it'
      : 'Waiting for players (' + (s.players || 0) + '/' + (s.minPlayers || 2) + ')';
  }

  /* OWNER ONLY, and the server is what says who that is.

     This used to test `localStorage.duel_admin_token`, which the wallet widget
     writes for EVERY signed-in player — so every player who had ever logged in
     was shown an owner control that then failed silently when pressed. The
     server now answers `isOwner` on the br:peek reply, against the real
     OWNER_WALLETS set, and only that draws the button. */
  const btn = document.getElementById('br-start');
  if (btn) {
    if (s.isOwner !== undefined) _brIsOwner = !!s.isOwner;   // room broadcasts omit it
    btn.hidden = !(_brIsOwner && s.canStart);
  }

  /* The button follows the match, not the room. While the room is filling this
     is an ordinary game and cashing out is allowed; once the circle starts
     closing the server refuses it, so the control goes away rather than sitting
     there doing nothing when pressed. */
  const co = document.getElementById('cashout-btn-mobile');
  if (co) co.style.display = (s.state === 'running') ? 'none' : '';
}
if (isBattleRoyale) {
  socket.on('br:state', brApply);

/* ── the podium ────────────────────────────────────────────────────────────
   Up when a battle royale ends, down when the next one is waiting. It carries
   its own Play again because the death card behind it is the wrong place to
   put it: you may well have died four minutes before the match finished. */
function podiumApply(s) {
  const el = document.getElementById('podium');
  if (!el || !isBattleRoyale) return;
  const show = s.state === 'over' && !!(s.podium && s.podium.length);
  if (!show) { el.hidden = true; return; }
  if (!el.hidden) return;                 // already up; do not rebuild under them

  document.getElementById('pod-winner').textContent =
    s.winner ? s.winner.name : 'Nobody survived';
  document.getElementById('pod-list').innerHTML = s.podium.map(p =>
    '<li' + (p.place === 1 ? ' class="first"' : '') + '>' +
      '<span class="pl">' + p.place + '</span>' +
      '<span class="pn">' + escapeHtml(String(p.name || 'Player').slice(0, 18)) + '</span>' +
      '<span class="ps">' + (p.score || 0) + '</span>' +
    '</li>').join('');
  document.getElementById('pod-next').textContent =
    'The next match opens in this lobby. Play again to wait in it.';
  el.hidden = false;
}

function escapeHtml(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── between matches ────────────────────────────────────────────────────────
   The match is decided, the podium has had its moment, and the arena is
   travelling back out to full size. Nobody can join a half-open circle — the
   server refuses it — so this fills the gap with the reason rather than leaving
   a dead screen behind a button that bounces.

   Three states, and they follow the ROOM rather than a timer here:

     over        the podium is up; this stays out of its way
     reopening   the ring fills with the arena's real progress
     waiting     the ring is full, and there is a Play button

   The ring is driven by reopenPct, which is the circle's actual radius on its
   way back to the whole world. A fake progress bar would finish before the room
   was ready, and Play would then refuse — which is the exact failure this
   screen exists to stop. */
/* Whether we watched the arena reopen. Gates the Play half of the panel, so it
   is the tail of a match rather than a greeting for anyone who walks in. */
let _brSawReopen = false;

function brNextApply(s) {
  const el = document.getElementById('br-next');
  if (!el || !isBattleRoyale) return;

  /* Only once the podium is down. During 'over' the winner is being decided,
     read and cashed out, and two stacked cards is one too many. */
  const reopening = s.state === 'reopening';

  /* THIS IS THE END OF A MATCH, NOT A GREETING.

     The 'waiting' half only follows a reopening we actually watched. Without
     that, anyone arriving at a quiet room — a spectator especially — was met
     with "the next battle royale is open" and a Play button over the arena,
     which is a modal in front of a lobby they had just chosen to enter. The
     latch clears the moment they play, so it cannot come back uninvited. */
  if (reopening) _brSawReopen = true;
  if (s.state === 'running' || s.state === 'countdown') _brSawReopen = false;
  const openAgain = s.state === 'waiting' && _brSawReopen;

  /* Nothing to show to somebody who is alive and playing: they are in the
     lobby already and the arena is opening around them. This screen is for
     the people waiting to get back in. */
  const waitingToPlay = isDead || cashedOut || spectateOnly;
  const show = reopening || (openAgain && waitingToPlay);

  /* The spectate bar sits under this at a lower z-index, and it carries its own
     Play again and Lobby. Two sets of the same two buttons, one of them behind
     a blur, is a screen that cannot be read — so it steps aside while this is
     up. Visibility rather than the `active` class, so spectating is exactly
     where it was when the panel comes down. */
  const bar = document.getElementById('spectate-bar');
  if (bar) bar.style.visibility = show ? 'hidden' : '';

  if (!show) { el.hidden = true; return; }

  const ring = document.getElementById('brn-ring');
  const msg  = document.getElementById('brn-msg');
  const btns = document.getElementById('brn-btns');

  if (reopening) {
    const p = Math.max(0, Math.min(1, s.reopenPct || 0));
    if (ring) {
      /* Spin until there is real progress to report, then switch to the sweep.
         A ring sitting at zero reads as broken; a moving one reads as working. */
      ring.classList.toggle('spin', p < 0.02);
      ring.style.setProperty('--p', String(p));
    }
    if (msg) msg.textContent = 'Loading next battle royale lobby';
    if (btns) btns.hidden = true;
  } else {
    if (ring) { ring.classList.remove('spin'); ring.style.setProperty('--p', '1'); }
    if (msg) msg.textContent = 'The next battle royale is open';
    if (btns) btns.hidden = false;
  }
  el.hidden = false;
}

/* Play, once the arena is actually open. The panel only shows this button in
   the 'waiting' state, so respawn cannot be refused from here. */
document.getElementById('brn-play').addEventListener('click', () => {
  document.getElementById('br-next').hidden = true;
  _brSawReopen = false;              // the sequence is finished with
  doRespawn();
});
document.getElementById('brn-lobby').addEventListener('click', () => {
  document.getElementById('br-next').hidden = true;
  _brSawReopen = false;
  goToLobby();
});

document.getElementById('pod-again').addEventListener('click', () => {
  document.getElementById('podium').hidden = true;
  doRespawn();
});
document.getElementById('pod-lobby').addEventListener('click', () => {
  document.getElementById('podium').hidden = true;
  goToLobby();
});
  socket.on('br:locked', (s) => {
    brApply(s);
    document.getElementById('br-sub').textContent = 'A match is already running';
  });
  /* Ask the parent page's wallet to sign an owner action, and come back with
     the proof. Mirrors requestRestake: the widget lives out in the lobby, so
     the frame asks and the lobby answers. Resolves null if it cannot. */
  let _signSeq = 0;
  function requestSignedAction(action, args) {
    return new Promise((resolve) => {
      if (window.self === window.top) { resolve(null); return; }
      const id = ++_signSeq;
      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMsg);
        resolve(val);
      };
      const onMsg = (e) => {
        const d = e.data;
        if (!d || d.id !== id) return;
        if (d.type === 'duel:signaction:done') finish(d.proof || null);
        else if (d.type === 'duel:signaction:error') { brSay(d.message); finish(null); }
      };
      window.addEventListener('message', onMsg);
      window.parent.postMessage({ type: 'duel:signaction', id, action, args: args || {} }, '*');
      setTimeout(() => finish(null), 15000);
    });
  }

  const startBtn = document.getElementById('br-start');
  if (startBtn) startBtn.addEventListener('click', async () => {
    if (startBtn.disabled) return;
    /* Signing opens the wallet's own approval, which takes a moment and must
       not be asked for twice by an impatient second press. */
    startBtn.disabled = true;
    const wasLabel = startBtn.textContent;
    startBtn.textContent = 'Check your wallet…';
    try {
      const proof = await requestSignedAction('br:start', {});
      if (!proof) return;                       // brSay already explained why
      socket.emit('br:start', { proof });
    } finally {
      startBtn.disabled = false;
      startBtn.textContent = wasLabel;
    }
  });

  /* Every refusal says so. The old handler returned silently on a failed owner
     check, which is why a dead button looked identical to a working one. */
  socket.on('br:error', ({ message } = {}) => brSay(message || 'That did not work.'));

  // Ask on arrival, then keep the clock honest without waiting on the server.
  // The wallet rides along so the server can say whether to draw owner controls.
  const peek = () => socket.emit('br:peek', { wallet: walletAddress });
  socket.on('connect', peek);
  setInterval(peek, 2000);
}

function endTouch(e) {
  // Lifting the pedal stops the boost while the steering finger stays down.
  if (e.touches && e.touches.length > 0) {
    if (e.touches.length < 2) boostActive = false;
    return;
  }
  boostActive = false;
  touchSteering = false;
  touchAngle = null;
  /* Carry on the way the arrow is pointing, which is the heading the snake
     actually has — not the angle to wherever the finger left the screen. */
  touchHoldAngle = _lAngle;
}
/* A real mouse takes the wheel back. On a laptop with a touchscreen the hold
   would otherwise stick until the next tap, with the mouse doing nothing. */
canvas.addEventListener('mousemove', () => { touchHoldAngle = null; });
canvas.addEventListener('touchend', endTouch);
canvas.addEventListener('touchcancel', endTouch);

/* The heading arrow, sitting just ahead of the head and pointing exactly along
   the direction the snake is travelling.

   Transform order matters here and got it wrong the first time. CSS applies the
   rightmost function first, so a trailing translate(-50%,-50%) is applied in
   the element's own rotated frame: the centring offset spins with the heading
   and the arrow drifts off to one side by up to its own size, worst at the
   diagonals. Centring has to happen LAST in screen space, so it goes first. */
const dirArrowEl = document.getElementById('dir-arrow');
function updateDirArrow(headScreenX, headScreenY, angle) {
  if (!dirArrowEl) return;
  if (!touchSteering || isDead || cashedOut) {
    if (dirArrowEl.style.opacity !== '0') dirArrowEl.style.opacity = '0';
    return;
  }
  dirArrowEl.style.opacity = '1';
  dirArrowEl.style.transform =
    `translate(-50%, -50%) translate(${headScreenX}px, ${headScreenY}px) ` +
    `rotate(${angle}rad) translateX(46px)`;
}

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

/* ─── Q Cash-out ───────────────────────────────────────────────────────────────
   The server times this hold and applies the slowdown itself; these values are
   the same ones only so the ring and the local prediction agree with what the
   server is already doing. Changing them here changes the animation, not the
   rules — 'cashout' is refused until the server's own clock has run. */
const Q_HOLD_MS = CONSTANTS.CASHOUT_HOLD_MS;
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

/* brRunning is set from the server's own match state, so holding Q during a
   battle royale does not spin a ring that the server is going to ignore. The
   server refuses it either way — this only stops the UI promising something
   that is not going to happen. */
let brRunning = false;
function startQTimer() {
  if (isDead || cashedOut || !myId) return;
  if (brRunning) return;
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

// ─── Cash-out receipt ─────────────────────────────────────────────────────────
// Its own screen, not the death overlay wearing a green headline. Dying and
// walking away with money are the two outcomes a player most needs to tell
// apart, and they used to share a shaking red card.

// Counts the payout up so the number is watched rather than just present. Short
// enough that nobody waits on it, and skipped entirely for reduced motion.
function countUpMoney(el, target) {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !(target > 0)) { el.textContent = fmtMoney(target); return; }
  const DUR = 620, t0 = performance.now();
  (function step(now) {
    const p = Math.min(1, (now - t0) / DUR);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmtMoney(target * eased);
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}

// The cash-out button sits above the canvas, so without this it stays live
// under the receipt on a snake that is already gone.
function showTouchControls(on) {
  ['cashout-btn-mobile'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? '' : 'none';
  });
}

function setSettleState(state, text, sig) {
  const row = document.getElementById('co-settle');
  const link = document.getElementById('co-tx');
  if (!row) return;
  row.dataset.state = state;
  document.getElementById('co-settle-text').textContent = text;
  if (sig) {
    // devnet/testnet payouts live on a different cluster, so the link has to say which.
    const q = moneyNetwork && moneyNetwork !== 'mainnet-beta' ? `?cluster=${encodeURIComponent(moneyNetwork)}` : '';
    link.href = `https://solscan.io/tx/${encodeURIComponent(sig)}${q}`;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
}

socket.on('cashout:result', ({ newBalance, earnedSol, gross, cut, score, length, toWallet }) => {
  if (window.phEvent) window.phEvent('cashed_out', { game: 'snake', amount: earnedSol, score: score, length: length });
  playCashoutSound();
  // earnedSol holds the earned amount in the active unit: USDC after cutover, SOL before.
  const net  = Number(earnedSol) || 0;
  const paid = net > 0;
  // Fall back to deriving the gross from the 90% share for servers that predate
  // gross/cut being sent, so an older server still shows a coherent receipt.
  const grossVal = Number.isFinite(gross) ? gross : (paid ? net / 0.9 : 0);
  const cutVal   = Number.isFinite(cut)   ? cut   : Math.max(0, grossVal - net);

  const screen = document.getElementById('cashout-screen');
  screen.classList.toggle('co-free', !paid);

  document.getElementById('co-sub').textContent = paid
    ? (toWallet ? 'paid to your wallet' : 'added to your balance')
    : 'Free lobby, nothing was staked';
  document.getElementById('co-gross').textContent = fmtMoney(grossVal);
  document.getElementById('co-cut').textContent   = '-' + fmtMoney(cutVal);
  document.getElementById('co-net').textContent   = fmtMoney(net);
  document.getElementById('co-length').textContent = length || 0;
  document.getElementById('co-score').textContent  = score || 0;

  if (paid) setSettleState('pending', toWallet ? 'Sending to your wallet' : 'Added to your balance');
  countUpMoney(document.getElementById('co-amount'), net);

  // Never both. The death card's Play Again sits behind this one and, in a paid
  // room, re-stakes real money — a stray tap on the sliver around the receipt
  // would charge someone who had just taken their money out.
  document.getElementById('death-screen').classList.remove('active');
  screen.classList.add('active');
  showTouchControls(false);
  document.getElementById('btn-cashout-lobby').focus();
  if (newBalance !== null) sessionStorage.setItem('lastBalance', newBalance);
});

// Self-custody payout follow-ups (Phase 2): the escrow → wallet transfer confirms async.
// `sol` is the field name from before the USDC cutover; it carries whichever unit
// is active, which is why it is formatted rather than labelled SOL.
socket.on('cashout:paid', ({ sol, sig }) => {
  setSettleState('done', `${fmtMoney(Number(sol) || 0)} sent`, sig);
});
socket.on('cashout:error', ({ message }) => {
  setSettleState('fail', message || 'Payout failed, contact support');
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
document.getElementById('btn-cashout-respawn').addEventListener('click', doRespawn);
document.getElementById('btn-cashout-lobby').addEventListener('click', () => {
  goToLobby();
});

// ─── Spectate ─────────────────────────────────────────────────────────────────
let spectating   = false;
/* WHO is being watched, not WHERE they were in a list that rebuilds itself
   thirty times a second. See resolveSpectateTarget. */
let spectateId = null;
/* The last body actually handed to the camera, and how many frames the chosen
   target has been missing from the snapshot. A snake absent for a frame or two
   is a gap in the payload, not a snake that has gone — see
   resolveSpectateTarget, which is where the jitter was. */
let _specLast = null;
let _specMissing = 0;
const SPEC_GRACE_FRAMES = 45;   // about a third of a second at the 120Hz cap

/* WHO YOU CAN WATCH, IN A STABLE ORDER.

   `displayState.snakes` is view-culled and rebuilt from every snapshot, so its
   contents AND its order change thirty times a second as snakes drift in and
   out of the camera. Sorting by id gives the same list the same order twice
   running, which is what makes "next" mean the next snake rather than whichever
   one happens to be in slot 3 this frame. */
function getSpectateTargets() {
  return displayState.snakes
    .filter(s => s.id !== myId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* The snake being watched, resolved by ID rather than by position.

   THE BUG THIS FIXES: the target used to be an INDEX into the list above, and
   that list is rebuilt every snapshot from whatever is in view. The index
   stayed put while the list churned underneath it, so the camera hopped from
   snake to snake on its own — reported as "it glitches out and starts going
   through all the snakes really fast". Nobody was pressing anything.

   An id cannot drift. When the snake being watched dies or leaves the view
   there is a real decision to make, and it is made once, here, rather than
   implicitly by an index landing somewhere new. */
function resolveSpectateTarget() {
  const targets = getSpectateTargets();
  if (targets.length === 0) {
    /* Hold the last body rather than dropping to nothing. With no target the
       camera has nothing to follow and stops dead, then snaps when one comes
       back — which is a jump, not a loss of signal. */
    return _specLast;
  }

  if (spectateId !== null) {
    const found = targets.find(s => s.id === spectateId);
    if (found) { _specLast = found; _specMissing = 0; return found; }
  }

  /* MISSING FOR ONE FRAME IS NOT GONE.

     This switched target the instant the snake was absent from displayState,
     and displayState is rebuilt from whatever the last snapshot happened to
     carry. A snake can be missing from a single snapshot for reasons that have
     nothing to do with it dying: the payload is capped at the nearest
     SNAKES_PER_SNAPSHOT bodies per interest cell, and a snake near that
     boundary drops in and out as distances shift; the camera crossing a cell
     boundary swaps which payload arrives at all.

     So the camera jumped to another snake and back, frame after frame, which is
     exactly what "the snake I am spectating is jittering around" looks like
     from the outside. It was not the snake moving.

     A few frames of grace covers the flicker. Only a target that has genuinely
     stayed away gives up its place. */
  if (spectateId !== null && _specMissing < SPEC_GRACE_FRAMES) {
    _specMissing++;
    if (_specLast) return _specLast;          // keep the camera where it was
  }

  spectateId = targets[0].id;
  _specMissing = 0;
  _specLast = targets[0];
  return targets[0];
}

/* Step through the stable order. Works off the CURRENT target's position in
   that order, so a snake appearing or dying between presses shifts the list
   without also shifting where you were in it. */
function stepSpectate(dir) {
  const targets = getSpectateTargets();
  if (targets.length === 0) return;
  const at = targets.findIndex(s => s.id === spectateId);
  const from = at < 0 ? 0 : at;
  spectateId = targets[(from + dir + targets.length) % targets.length].id;
  _specMissing = 0; _specLast = null;     // a deliberate switch is not a gap
  updateSpectateLabel();
}

function enterSpectate() {
  spectating = true;
  spectateId = null;          // resolved to the first target on the next frame
  _specLast = null; _specMissing = 0;
  document.getElementById('death-screen').classList.remove('active');
  document.getElementById('spectate-bar').classList.add('active');
  updateSpectateLabel();
  ['cashout-btn-mobile'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function exitSpectate() {
  spectating = false;
  document.getElementById('spectate-bar').classList.remove('active');
  ['cashout-btn-mobile'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  });
}

function updateSpectateLabel() {
  const label = document.getElementById('spectate-label');
  if (!label) return;
  const t = resolveSpectateTarget();
  label.textContent = t ? ('Spectating: ' + (t.name || 'Player')) : 'No players to spectate';
}

document.getElementById('btn-spectate').addEventListener('click', enterSpectate);

document.getElementById('spectate-prev').addEventListener('click', () => stepSpectate(-1));
document.getElementById('spectate-next').addEventListener('click', () => stepSpectate(1));

document.getElementById('spectate-stop').addEventListener('click', () => {
  goToLobby();
});

// Ask the parent page's wallet widget to re-stake (Privy approval) for a paid respawn, and
// resolve with the fresh entry token. Resolves null if cancelled/failed or not in an iframe.
function requestRestake(game) {
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
    window.parent.postMessage({ type: 'duel:restake', game, lobbyType, stake }, '*');
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
    if (isPaidRoom) {
      // Paid lobbies are self-custody — re-stake from the wallet (Privy approval) right here,
      // then respawn in place. The prior stake was lost when the snake died.
      respawnToken = await requestRestake('snake');
      if (!respawnToken) return; // cancelled or failed — stay on the death screen
    }
    isDead = false;
    cashedOut = false;
    exitSpectate();
    socket.emit(CONSTANTS.EVENTS.RESPAWN, { entryToken: respawnToken });
    document.getElementById('death-screen').classList.remove('active');
    document.getElementById('cashout-screen').classList.remove('active');
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

/* THE RESOLUTION EXPERIMENT.

   Owen's own client says the game's JavaScript costs about 1ms a frame —
   interpolate 0.11, the local body 0.03, issuing every draw call 0.9 — while
   the frames themselves are 12ms apart. So eleven of those twelve milliseconds
   are spent somewhere no JS timer can see: the browser painting, compositing
   and presenting the canvas. Nothing in the game loop can be optimised to
   recover time it is not spending.

   The obvious suspect is how many pixels that canvas is. Desktop uses the
   raw devicePixelRatio, so a machine at 1.5 draws 2.25x the pixels and one at
   2 draws 4x, every frame. If the canvas is fill-rate bound, halving the
   linear resolution quarters the pixels and the framerate should jump.

   That is a question the code cannot answer and his machine can, so ask his
   machine: play at full resolution, drop to half for five seconds, put it
   back. The report carries the frame rate through all three, and the
   comparison is the answer. Five seconds of a softer picture, once, and then
   it is over — and this whole block comes out as soon as it has answered. */
/* The ablation run that used to live here has been removed: it answered.

   Each render layer switched off for four seconds in turn, against a 72Hz
   baseline on a 240Hz panel — background 78.6, food 82.2, snake bodies 79.8,
   the per-snake GL composite 76.2, snake overlays 72.9, minimap 74.5, and
   then border 233.5, 213.1, 217.

   One layer, three times the frame rate, and it was the one that usually
   draws nothing at all. See _drawBorder in Renderer.js. */

/* What the canvas actually is, which decides whether the above can matter. */
if (window.__duelDiagDisplay) {
  var _gl = null;
  try { _gl = document.createElement('canvas').getContext('webgl'); } catch (e) {}
  var _gpu = '';
  try {
    var _dbg = _gl && _gl.getExtension('WEBGL_debug_renderer_info');
    if (_dbg) _gpu = String(_gl.getParameter(_dbg.UNMASKED_RENDERER_WEBGL) || '');
  } catch (e) {}
  window.__duelDiagDisplay({
    dpr: window.devicePixelRatio || 1,
    cssW: window.innerWidth, cssH: window.innerHeight,
    canvasW: canvas.width, canvasH: canvas.height,
    gpu: _gpu.slice(0, 90),
  });
}

// Send input at 60Hz (matches server tick rate)
function sendInput() {
  if (!myId || isDead) return;
  const mySnake = displayState.snakes.find(s => s.id === myId);
  if (!mySnake) return;

  if (qHoldStart !== null && lockedAngle === null) lockedAngle = mySnake.angle;

  // A thumb on the screen owns the heading outright: its angle comes from the
  // anchor, not from a point in the world. Inside the dead zone touchAngle is
  // still null, which holds the current line rather than snapping anywhere.
  const angle = lockedAngle !== null
    ? lockedAngle
    : touchSteering
    ? (touchAngle !== null ? touchAngle : mySnake.angle)
    : Math.atan2(
        renderer.camera.screenToWorld(mousePos.x, mousePos.y, canvas.width, canvas.height).y - mySnake.segs[1],
        renderer.camera.screenToWorld(mousePos.x, mousePos.y, canvas.width, canvas.height).x - mySnake.segs[0]
      );

  /* Q held: ramp down to CASHOUT_MIN_SPEED_MULT, released: straight back to
     full. This is LOCAL PREDICTION ONLY — the same ramp runs on the server
     from its own clock and is what actually moves the snake. It is not sent,
     because a speed the client chooses is a penalty only for the players who
     do not edit it out. */
  if (qHoldStart) {
    const t = Math.min(1, (performance.now() - qHoldStart) / Q_HOLD_MS);
    const floor = CONSTANTS.CASHOUT_MIN_SPEED_MULT;
    cashoutSpeedMult = Math.max(floor, 1 - (1 - floor) * t);
  } else {
    cashoutSpeedMult = 1;
  }
  // VOLATILE: input is sent 60x/sec and each carries the absolute current angle, so a
  // dropped one is harmlessly superseded 16ms later. Reliable emits would queue on a
  // congested mobile uplink and back up the buffer (delaying ping_check too).
  socket.volatile.emit(CONSTANTS.EVENTS.INPUT, { angle, boost: boostActive && !qHoldStart });
}
setInterval(sendInput, 1000 / 60);

// ─── View radius (area-of-interest) ───────────────────────────────────────────
// Report how far we can currently see, in world units, so the server only sends
// snakes/food within range. Without it every snapshot carries the WHOLE map — fine
// on desktop, but it floods a phone's connection once the room fills with bots.
let _lastViewR = 0, _lastViewSentAt = 0, _lastViewX = 0, _lastViewY = 0;
function maybeSendView(now) {
  const cam = renderer.camera || {};
  const scale = cam.scale || 1;
  // radius of the circle that covers the whole screen rectangle, in world units
  const viewR = Math.hypot(window.innerWidth / 2, window.innerHeight / 2) / scale;

  /* WHERE the camera is, as well as how far it reaches.

     While you are alive the server can use your snake's head and does. While
     you are DEAD or spectating it has nothing to centre on, and the answer
     was to send you the whole world unculled — measured at 49KB a snapshot
     and nine megabits a second, against seven kilobytes and 1.3 alive. That
     is the death screen costing seven times what playing costs, and it is
     about to matter more now that there are Watch buttons. */
  const cx = Math.round(cam.worldX || 0), cy = Math.round(cam.worldY || 0);
  const moved = Math.hypot(cx - _lastViewX, cy - _lastViewY) > 300;

  // it's a control message, not per-frame state — only resend on a real change
  if (moved || Math.abs(viewR - _lastViewR) > _lastViewR * 0.15 ||
      now - _lastViewSentAt > 1000) {
    socket.emit('view', { r: Math.round(viewR), x: cx, y: cy });
    _lastViewR = viewR; _lastViewX = cx; _lastViewY = cy;
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
/* Coarse pointer, which is the same test the mobile CSS uses, so the row count
   and the styling can never disagree about what a phone is. Live, so rotating a
   tablet into a different mode is picked up. */
const _lbPhoneQuery = window.matchMedia("(pointer: coarse)");
let _lbIsPhone = _lbPhoneQuery.matches;
try { _lbPhoneQuery.addEventListener("change", e => { _lbIsPhone = e.matches; _lastLbHtml = null; }); } catch (_) {}

let _lastLbHtml = '';
function updateLeaderboard(snap) {
  /* Exactly what the server sent, unfiltered.

     This used to keep only the entries whose snake was also in snap.snakes —
     and snap.snakes is VIEW-CULLED. So the global top ten was cut down to
     whichever of them happened to be on your screen: a board that sat half
     empty, reshuffled every time you moved, and never showed the leader
     unless you were next to them. Which is what a leaderboard is for.

     The filter was presumably guarding against a player who died between the
     server building the board and this frame drawing it. The server rebuilds
     it from living snakes on every broadcast, so that window is one snapshot
     wide — and one stale row for 33ms is not worth hiding nine real ones. */
  /* TOP THREE ON A PHONE. Ten rows in the corner of a small screen is a panel
     you play around rather than glance at, and on a phone the corner it sits in
     is a corner you also need to see through. The cut is here rather than in
     CSS so the rows are never built at all — the board only redraws when the
     string changes, and a hidden row still forces that string to change every
     time somebody in eighth place scores. */
  const lbAll = snap.leaderboard || [];
  const lb = _lbIsPhone ? lbAll.slice(0, 3) : lbAll;
  const isPaid = isPaidRoom;
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
  // Feed the stall recorder: a round trip that spikes at the same moment
  // snapshots gap means the network, and one that stays flat means the
  // packets were late leaving rather than late arriving.
  if (window.__duelDiagPing) window.__duelDiagPing(pingMs);
  pingSentAt = null;
  pingValueEl.textContent = pingMs + ' ms';
  pingDotEl.className = 'ping-dot ' + (pingMs < 50 ? 'ping-green' : pingMs < 100 ? 'ping-orange' : 'ping-red');
});
setInterval(sendPing, 2000);
sendPing();

// FPS / perf counters
let fpsFrames = 0, fpsLast = performance.now(), fpsDisplay = 0;
const fpsEl   = document.getElementById('fps-counter');
/* Frames the DISPLAY offered, counted before the cap — what the monitor can do,
   as opposed to what we chose to draw out of it. */
let _rafFrames = 0;
const perfEl  = document.getElementById('perf-counter');
if (perfEl) perfEl.style.display = 'none';   // CPU/GPU counter removed

let _lastFrameTime = 0;
// Main render loop — runs at monitor refresh rate (60/144/240Hz)
/* ─── Frame cap ────────────────────────────────────────────────────────────
   The server produces 30 states a second. This loop rebuilds the world from
   them, and on a 240Hz display it was doing that 237 times a second: eight
   rebuilds per state, seven of which can only produce a picture identical to
   the one before it.

   That is not a small waste. Measured on a 240Hz machine, the tab's heap was
   sawtoothing between 60MB and 140MB every two seconds, about 25MB/s of
   allocation, and the resulting collections stopped the tab for 80-130ms.
   No long task was ever recorded, because a collection is not a task — which
   is exactly why this stayed invisible while three server-side fixes went
   after it.

   120Hz: four states per server snapshot, and it divides a 240Hz display
   exactly, so the cap lands on a clean 120fps. 90 did not divide it — three
   refreshes had to elapse before the budget was met, which quietly produced
   80fps rather than 90 and was visible in the counter.

   AND THAT SAME ALIASING WAS STILL HERE, on the displays most people game on.
   The test was "has a whole frame budget passed since the last one I drew",
   which on a refresh rate that does not divide the budget throws away every
   other frame. Replayed frame by frame:

        60Hz -> 60    120Hz -> 120    240Hz -> 120
       144Hz -> 72    165Hz ->  83    180Hz ->  90

   144 and 165 are the two commonest gaming monitors and both were running at
   half rate, in a visible draw-skip-draw pattern — which is what a dropped
   frame every other frame looks like, and it looks like lag.

   A DEADLINE fixes it. Ask whether this frame is past the time the next one
   was due, rather than whether a budget has elapsed since the last one drawn,
   and the skipped frames land where they have to instead of on every other
   one. Same 60/120/240 as before; 144, 165, 180 and 200 all reach 120. */
/* THE CAP IS NOW ADJUSTABLE FROM THE URL, so it can be settled by measurement
   instead of by argument.

   120 is not arbitrary — see the whole comment above — but the two things that
   justified it have since changed underneath it: food moved to the GPU (FoodGL)
   and snake bodies were batched into one pass, which is most of the per-frame
   allocation the sawtooth was made of. Whether the collector still stalls at
   240 is now an open question, and an open question is not something to answer
   by picking a number.

   The honest reason this is a switch rather than a new default: it cannot be
   measured from here. The preview surface this was developed against paints at
   1Hz, so 120 and 240 are indistinguishable on it. The machine that can tell
   them apart is the one with the 233Hz display in front of it.

       ?hz=240   uncap toward the display
       ?hz=0     no cap at all, draw every frame the display offers
       ?hz=120   the shipped default

   The choice sticks in localStorage, because the lobby launches the game in an
   iframe and a query string typed at the lobby does not survive into it.
   diag.js is already loaded and already records frame gaps, long tasks and the
   heap sawtooth, and posts the summary to the server — so the comparison is a
   reading, not an impression. */
const RENDER_HZ = (() => {
  const DEFAULT = 120;
  let v = null;
  try {
    const q = new URLSearchParams(location.search).get('hz');
    if (q !== null && q !== '') {
      v = Number(q);
      localStorage.setItem('duel_render_hz', String(v));
    } else {
      const saved = localStorage.getItem('duel_render_hz');
      if (saved !== null) v = Number(saved);
    }
  } catch (_) { v = null; }
  if (v === null || !isFinite(v) || v < 0) return DEFAULT;
  return v;                                  // 0 means "no cap"
})();
// 0 -> a zero budget, so the deadline is always already past and nothing is skipped.
const FRAME_MS  = RENDER_HZ > 0 ? 1000 / RENDER_HZ : 0;
let _nextFrameAt = 0;
let _meView = null;
let _lLastStep = 0;   // body-thinning step last seen from the server
let _lLastSettled = 0; // resample step the local body was last built at

function gameLoop(now) {
  // Counted before the cap, so this is what the DISPLAY offers rather than
  // what we choose to draw. The two answer different questions.
  if (window.__duelDiagRaf) window.__duelDiagRaf();
  _rafFrames++;                 // counted before the cap: this is the display's rate
  // Cheap and first: skip the whole frame before anything allocates.
  if (now < _nextFrameAt) {
    requestAnimationFrame(gameLoop);
    return;
  }
  /* Advance from the DEADLINE so the budget cannot drift, but never leave it
     behind `now` — otherwise a stall banks a debt and is paid off with a burst
     of catch-up frames the moment the tab wakes up. */
  _nextFrameAt = Math.max(now, _nextFrameAt + FRAME_MS);
  const dt = Math.min(_lastFrameTime ? now - _lastFrameTime : 16.67, 50);
  _lastFrameTime = now;

  // Advance local snake simulation every frame (no server wait)
  if (_lReady && !isDead && !cashedOut) {
    const localHeadX = _lpX[(_lpHead - 1 + LP_SIZE) % LP_SIZE];
    const localHeadY = _lpY[(_lpHead - 1 + LP_SIZE) % LP_SIZE];
    let targetAngle;
    if (lockedAngle !== null) {
      targetAngle = lockedAngle;
    } else if (touchSteering) {
      targetAngle = touchAngle !== null ? touchAngle : _lAngle;   // null: hold
    } else if (touchHoldAngle !== null) {
      /* Thumb is off the glass. Carry straight on the heading the arrow was
         showing, rather than falling through to the mouse branch below, which
         would steer at the pixel the finger last occupied. */
      targetAngle = touchHoldAngle;
    } else {
      const wm = renderer.camera.screenToWorld(mousePos.x, mousePos.y, canvas.width, canvas.height);
      targetAngle = Math.atan2(wm.y - localHeadY, wm.x - localHeadX);
    }
    _lAdvance(dt, targetAngle);
    // The arrow sits at the head, pointing the way it is actually turning.
    updateDirArrow(localHeadX * renderer.camera.scale + renderer.camera.x,
                   localHeadY * renderer.camera.scale + renderer.camera.y,
                   _lAngle);
  }

  var _tPhase = window.__duelDiagPhase ? performance.now() : 0;
  interpolateState(now);
  if (window.__duelDiagPhase) {
    window.__duelDiagPhase('interpolate', performance.now() - _tPhase);
    _tPhase = performance.now();
  }

  // Replace local snake in displayState with the locally-simulated version
  if (_lReady && myId && !isDead && !cashedOut && _latestMySnap) {
    const targetNumSegs = _latestMySnap.segs.length >> 1;

    /* The server thins the body as the snake grows: every 2nd point below
       length 400, every 3rd below 800, every 4th above (Snake.js serialize).
       Spacing widens to match, so the drawn snake should be the same.

       Crossing a threshold therefore drops the POINT COUNT by a third in one
       snapshot without the snake having lost anything. Decaying through that
       drop, while _lBuildSegs has already switched to the wider spacing,
       renders a body of the wrong length for about 200ms and then settles —
       which is seen as the body resizing toward the head for no reason.

       A step change is a change in how the body is described, not a change in
       the body, so it is adopted immediately. Genuine growth and boost-shrink
       keep the smoothing they need. */
    const _step = (() => { const L = _latestMySnap.length || 0; return L < 400 ? 2 : L < 800 ? 3 : 4; })();
    if (_step !== _lLastStep) { _lLastStep = _step; _lNumSegs = targetNumSegs; }
    // Grow instantly (eating food), shrink gradually (boost drops) — prevents tail snap.
    // dt-corrected (~200ms time constant) so the shrink rate is identical at 60/144/240Hz.
    else if (targetNumSegs > _lNumSegs) _lNumSegs = targetNumSegs;
    else _lNumSegs += (targetNumSegs - _lNumSegs) * (1 - Math.exp(-dt / 200));
    const simSegs = _lBuildSegs(Math.round(_lNumSegs));
    /* Checked against the spacing it was resampled at. This body is built
       from a fixed step, so every gap in it must be that step; anything else
       is the distortion, caught at the moment it happens. */
    if (simSegs && window.__duelDiagBody) {
      window.__duelDiagBody(simSegs, _lLastSettled, Math.round(_lNumSegs));
    }
    if (simSegs) {
      /* One reused object rather than a fresh spread per frame. `{...snap}`
         here copied every field of the snapshot 237 times a second on a 240Hz
         display, purely to change two of them. */
      const me = _meView || (_meView = {});
      for (const k in _latestMySnap) me[k] = _latestMySnap[k];
      me.segs = simSegs;
      me.angle = _lAngle;
      // Local ramp, not the snapshot's — the boost pulse should light up on the
      // frame you press boost, not a round trip later.
      me.boostRamp = _lBoostRamp;
      let found = false;
      for (let i = 0; i < displayState.snakes.length; i++) {
        if (displayState.snakes[i].id === myId) { displayState.snakes[i] = me; found = true; break; }
      }
      if (!found) displayState.snakes.push(me);
    }
  }

  if (window.__duelDiagPhase) window.__duelDiagPhase('localBody', performance.now() - _tPhase);

  let spectateSnake = null;
  if (spectating) spectateSnake = resolveSpectateTarget();
  const renderState = cashedOut
    ? { ...displayState, snakes: displayState.snakes.filter(s => s.id !== myId) }
    : displayState;
  /* The one that matters. Everything above is arithmetic on a few hundred
     points; this is every draw call for the world, the snakes and the food. */
  var _tRender = window.__duelDiagPhase ? performance.now() : 0;
  renderer.render(renderState, cashedOut ? null : myId, mousePos, spectateSnake, cashoutRings, dt);
  if (window.__duelDiagPhase) window.__duelDiagPhase('render', performance.now() - _tRender);


  // Tell the server our current view radius (area-of-interest culling) so it only
  // sends snakes/food we can actually see — keeps the snapshot small on mobile.
  maybeSendView(now);

  /* FPS, as two numbers when they differ.

     They answer different questions and conflating them is what made 120 look
     like a fault: the first is what we chose to DRAW, the second is what the
     display OFFERED. A 233Hz monitor showing "FPS: 120" is the cap working
     exactly as designed, not a frame rate problem — and there was no way to see
     that from inside the game, which is why it got reported as one.

     Only shown as a pair when the cap is actually biting, so an ordinary 60Hz
     machine still just sees one number. */
  fpsFrames++;
  if (now - fpsLast >= 500) {
    const secs = (now - fpsLast) / 1000;
    fpsDisplay = Math.round(fpsFrames / secs);
    const offered = Math.round(_rafFrames / secs);
    fpsFrames = 0; _rafFrames = 0; fpsLast = now;
    if (fpsEl) {
      /* ALWAYS both. Showing the pair only when they diverged meant the one
         moment you wanted to check the display rate — when the numbers happen
         to agree — was the moment it was hidden. */
      fpsEl.textContent = `FPS: ${fpsDisplay} · ${offered}Hz`;
      fpsEl.title = `Drawing ${fpsDisplay} of the ${offered} frames this display `
        + `offers (cap ${RENDER_HZ || 'off'}). ?hz=240 or ?hz=0 on the game URL changes it.`;
    }
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

/* ─── What the game says to everybody ─────────────────────────────────────────
   The owner's announcements and the countdown into a match share one banner,
   because they are the same thing from a player's point of view: the game
   telling the whole room something.

   How long it stays is worked out from the LENGTH of what was said. A fixed
   three seconds is too long for "GG" and nowhere near enough for two lines
   about a restart, and the person typing it should not have to think about
   timing at all. Roughly reading speed, with a floor and a ceiling. */
const gmsgEl = document.getElementById('gmsg');
let gmsgTimer = 0;
function showGameMessage(text, opts) {
  if (!gmsgEl || !text) return;
  const o = opts || {};
  gmsgEl.textContent = text;
  gmsgEl.classList.toggle('count', !!o.count);
  gmsgEl.classList.add('on');
  clearTimeout(gmsgTimer);
  if (o.hold) return;                       // the caller will clear it
  // ~13 characters a second, which is a comfortable read, plus a beat to notice it.
  const ms = Math.max(2600, Math.min(14000, 1400 + String(text).length * 75));
  gmsgTimer = setTimeout(() => gmsgEl.classList.remove('on'), ms);
}
function hideGameMessage() {
  if (!gmsgEl) return;
  clearTimeout(gmsgTimer);
  gmsgEl.classList.remove('on');
}
/* Sent by the owner console to everyone in a game. It was already being
   broadcast and nothing anywhere was listening for it. */
socket.on('announce', (m) => showGameMessage(m && m.text));
