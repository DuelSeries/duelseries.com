/* ─── Crossy Road, the client ─────────────────────────────────────────────────
   Two hoppers on one seeded map. This page draws it (crossyScene.js), reads
   your keys, clicks, taps and swipes, and tells the server when you hopped.

   THE SERVER DECIDES (server/crossy/CrossyRoom.js): who was hit, who drowned,
   who the eagle took, who won. The page runs the very same step
   (shared/crossySim.js) to show you your own hopper the moment you press, and
   checks it against the server's 20 times a second; if they ever differ (a hop
   that reached the server too late), it takes the server's and replays your
   later hops on top. Nothing on the map is sent: it is the seed, and every car,
   log and train is worked out from it on both ends.

   THE CONTROLS ARE THE REFERENCE'S (docs/crossy-reference.md): pressing a key,
   the mouse or a finger squashes and turns the hopper; letting go hops. Arrow
   keys or WASD (space is forward); a click or tap that moves under 10 px is
   forward, a drag or swipe is its direction (sideways when it is 1.1 times
   wider than tall).

   The shell around the match (the wait card, the bot note, the result card, the
   paid Play again, Spectate, chat, maintenance, the reconnect key) is Head
   Soccer's (public/js/headsoccer.js), behaviour for behaviour, with cr: names. */
import { createScene } from './crossyScene.js';

const Sim = window.CrossySim, IN = Sim.IN;
const socket = io();
if (window.DSPerfHud) window.DSPerfHud.mount({ socket });
const $ = (id) => document.getElementById(id);
const GAME = 'crossy';
const SND = window.CrossySound;
const SFX = window.DSSfx;
const sfx = (n) => { try { if (SFX) SFX.play(n); } catch (_) {} };

const view = createScene($('world'));
const hud = $('hud'), hx = hud.getContext('2d');

/* ── who, what stake, and the proof it was paid (exactly as Head Soccer reads them) ─────────────────────────── */
const myName = (() => { try { return sessionStorage.getItem('playerName') || localStorage.getItem('duelseries_playername') || 'Player'; } catch (_) { return 'Player'; } })();
const myWallet = (() => { try { return localStorage.getItem('duelseries_wallet') || null; } catch (_) { return null; } })();
const myStake = (() => { try { return Number(sessionStorage.getItem('stake')) || 0; } catch (_) { return 0; } })();
let myEntryToken = (() => { try { return sessionStorage.getItem('entryToken') || null; } catch (_) { return null; } })();
const FRAMED = (() => { try { return !!window.parent && window.parent !== window; } catch (_) { return true; } })();
const WATCH = (() => {
  try { const v = sessionStorage.getItem('dsWatch'); if (v !== null) sessionStorage.removeItem('dsWatch'); return v === GAME; } catch (_) { return false; }
})();
const WATCH_STAKE = (() => {
  try { const s = Number(sessionStorage.getItem('dsWatchStake')); sessionStorage.removeItem('dsWatchStake'); return Number.isFinite(s) && s > 0 ? s : 0; } catch (_) { return 0; }
})();
const WATCH_NEXT_MS = 3000, WATCH_OVER_MS = 2400, WATCH_SWAP_MS = 1500;
const BAR = window.DSWatchBar || null;
let watchMatch = null, watchLastId = null, watchTimer = 0, swapping = false, swapTimer = 0;
const touchUI = (() => {
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
    return (navigator.maxTouchPoints || 0) > 0 && !(window.matchMedia && window.matchMedia('(pointer: fine)').matches);
  } catch (_) { return false; }
})();

/* ── the match on screen ─────────────────────────────────────────────────── */
let me = null;                  // my socket id
let match = null;               // { id, seed, vsBot, players, names, stake, pot, goAt, offset }
let mySeat = -1;
let phase = null;               // countdown | playing | over
let world = null;
let mine = null;                // my hopper, predicted
const hist = new Array(256);    // my hopper after each tick, for checking the server's rows
const presses = new Map();      // tick -> move I pressed
let sentT = -1;                 // the last tick a message has spoken for
let lastBeat = 0;
const seen = [null, null];      // the server's latest row per seat: { h, at }
const shown = [Sim.newHopper(), Sim.newHopper()];   // what is drawn for the other seat(s), stepped on from `seen`
let overShown = false, lastOver = null, matchAt = 0, deadAt = [0, 0], overAt = 0;
let restake = null, restakeLine = '', restakeTimer = 0;
let hold = 0;                   // a key or finger is down (the squash)
let hinted = false;             // the first hop has been made (the key hint goes)
let corrections = 0;
const series = { mine: 0, theirs: 0 };

/* ── the clock: the server's, lined up from cr:start and the ping ───────── */
let rtt = 80, pingSentAt = 0, pingTimer = 0;
const rtts = [];
const oneWay = () => Math.max(0, Math.min(150, rtt / 2));
socket.on('pong_check', () => {
  if (!pingSentAt) return;
  const r = performance.now() - pingSentAt;
  pingSentAt = 0;
  if (!(r >= 0 && r < 3000)) return;
  rtts.push(r);
  if (rtts.length > 5) rtts.shift();
  const s = rtts.slice().sort((a, b) => a - b);
  rtt = s[s.length >> 1];
});
function ping() {
  if (socket.connected) { pingSentAt = performance.now(); socket.emit('ping_check'); }
  clearTimeout(pingTimer);
  pingTimer = setTimeout(ping, rtts.length < 5 ? 500 : 2000);
}
const serverNow = () => (match ? performance.now() + match.offset : 0);
const matchFt = () => (match ? (serverNow() - match.goAt) / Sim.TICK_MS : 0);   // the match's tick, fractional

/* ── input ───────────────────────────────────────────────────────────────── */
const KEYS = { ArrowUp: IN.FWD, KeyW: IN.FWD, Space: IN.FWD, ArrowDown: IN.BACK, KeyS: IN.BACK,
  ArrowLeft: IN.LEFT, KeyA: IN.LEFT, ArrowRight: IN.RIGHT, KeyD: IN.RIGHT };
const down = new Set();
const canPlay = () => !WATCH && match && phase === 'playing' && mySeat >= 0 && mine && mine.alive;
function press(m) {
  if (!canPlay()) return;
  const t = mine.tick;                 // the next tick my hopper steps: the press is read on it
  presses.set(t, m);
  hinted = true;
  // Said at once, reliably: a hop is a few a second at most, and one lost on the way would be a hop that never was.
  socket.emit('cr:in', { t: Math.max(sentT, t), h: [[t, m]] });
  sentT = Math.max(sentT, t);
}
window.addEventListener('keydown', (e) => {
  if (chatTyping()) return;
  const m = KEYS[e.code];
  if (!m) return;
  e.preventDefault();
  if (down.has(e.code)) return;
  down.add(e.code);
  hold = performance.now();
  if (canPlay()) faceOnly = m;
});
window.addEventListener('keyup', (e) => {
  const m = KEYS[e.code];
  if (!m || !down.has(e.code)) return;
  down.delete(e.code);
  if (!down.size) hold = 0;
  faceOnly = 0;
  press(m);
});
let faceOnly = 0;               // pressed and not let go: the hopper turns to face it (the reference's keydown)
let pt = null;                  // the pointer that is down: { id, x, y }
function ptrDown(x, y, id) { if (!canPlay()) return; pt = { id, x, y }; hold = performance.now(); faceOnly = IN.FWD; }
function ptrUp(x, y, id) {
  if (!pt || pt.id !== id) return;
  const dx = pt.x - x, dy = pt.y - y;
  pt = null; hold = 0; faceOnly = 0;
  if (Math.abs(dx) < 10 && Math.abs(dy) < 10) { press(IN.FWD); return; }
  if (Math.abs(dx) > Math.abs(dy) * 1.1) press(dx > 0 ? IN.LEFT : IN.RIGHT);
  else press(dy > 0 ? IN.FWD : IN.BACK);
}
const world$ = $('world');
world$.addEventListener('pointerdown', (e) => { if (e.button > 0) return; ptrDown(e.clientX, e.clientY, e.pointerId); });
window.addEventListener('pointerup', (e) => ptrUp(e.clientX, e.clientY, e.pointerId));
window.addEventListener('pointercancel', () => { pt = null; hold = 0; faceOnly = 0; });
window.addEventListener('blur', () => { down.clear(); pt = null; hold = 0; faceOnly = 0; });

/* ── chat (the one DuelSeries chat box) ─────────────────────────────────── */
let chatLive = false;
const chat = window.DSChat ? window.DSChat.mount({
  send: (t) => { socket.emit('cr:chat', { text: t }); return true; },
  canSend: () => chatLive && !WATCH,
  pc: { left: 14, bottom: 14 },
  phoneAt: { left: 10, top: 120 },
}) : { visible() {}, add() {}, typing: () => false };
function chatTyping() { try { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); } catch (_) { return false; } }
function chatShow(on) { chatLive = on; chat.visible(on); }
socket.on('cr:chat', (m) => {
  if (!m) return;
  chat.add({ name: m.name, color: m.side === 1 ? '#c9a8ff' : '#9fe07a', text: m.text, me: !WATCH && m.side === mySeat });
});
socket.on('cr:chatnote', (m) => { if (m) chat.add({ kind: 'sys', text: m.text }); });

let botNoteTimer = 0;
function botNote() {
  const n = $('botNote');
  n.hidden = false;
  clearTimeout(botNoteTimer);
  botNoteTimer = setTimeout(() => { n.hidden = true; }, 5000);
}

/* ── a match comes on screen ─────────────────────────────────────────────── */
const cut = (s, n) => { const t = String(s || 'Player'); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function startMatch(m) {
  const players = m.players || [];
  mySeat = -1;
  if (!WATCH) { const p = players.find(q => q.id === me); mySeat = p ? (p.side === 1 ? 1 : 0) : -1; }
  const names = ['', ''];
  for (const p of players) if (p.side === 0 || p.side === 1) names[p.side] = cut(p.name, 16);
  if (m.vsBot && mySeat >= 0) names[1 - mySeat] = cut(names[1 - mySeat] || 'Opponent', 12) + ' (bot)';
  // The server's clock now = its `now` plus the trip here.
  const offset = (Number(m.now) || Date.now()) + oneWay() - performance.now();
  match = { id: m.id, seed: m.seed >>> 0, vsBot: !!m.vsBot, players, names, stake: m.stake, pot: m.pot, goAt: Number(m.goAt) || 0, offset };
  world = new Sim.World(match.seed);
  view.setWorld(world);
  view.resetCoins();
  mine = mySeat >= 0 ? Sim.newHopper() : null;
  hist.fill(null); presses.clear(); sentT = -1; lastBeat = 0; corrections = 0;
  seen[0] = seen[1] = null;
  shown[0] = Sim.newHopper(); shown[1] = Sim.newHopper();
  overShown = false; lastOver = null; deadAt = [0, 0]; overAt = 0; hinted = false;
  phase = m.state === 'playing' ? 'playing' : 'countdown';
  for (const row of m.p || []) takeRow(row);
  $('wait').hidden = true;
  $('leave').hidden = WATCH;
  chatShow(true);
}
function dropMatch() { match = null; mySeat = -1; phase = null; mine = null; $('tag').hidden = true; $('leave').hidden = true; }

/* A server row: [side, ...packed hopper]. Mine is checked against my prediction for that tick; the other is drawn. */
function takeRow(row) {
  if (!Array.isArray(row)) return;
  const side = row[0];
  const h = Sim.unpackHopper(row.slice(1));
  if (!h || (side !== 0 && side !== 1)) return;
  const was = seen[side];
  if (was && was.h.tick > h.tick) return;
  if (!h.alive && !deadAt[side]) deadAt[side] = performance.now();
  seen[side] = { h, at: performance.now() };
  if (side === mySeat && mine) check(h);
}
function same(a, b) {
  return a && b && a.r === b.r && Math.abs(a.x - b.x) < 1e-6 && a.alive === b.alive && a.wait === b.wait
    && a.pend === b.pend && a.log === b.log && a.water === b.water && Math.abs(a.eagle - b.eagle) < 1e-6;
}
function check(s) {
  const mineAt = hist[s.tick & 255];
  if (mineAt && mineAt.tick === s.tick && same(mineAt, s)) return;
  if (!mineAt || mineAt.tick !== s.tick) { if (s.tick <= mine.tick) return; }
  // They differ: the server's hopper it is, with my hops after it replayed on top.
  const got = mine.got;
  const target = mine.tick;
  mine = Sim.copyHopper(s);
  mine.got = got;
  corrections++;
  while (mine.tick < target && mine.alive) stepMine();
}
function stepMine() {
  const t = mine.tick;
  const was = mine.hops, coins = mine.coins;
  Sim.step(world, mine, presses.get(t) || 0);
  hist[mine.tick & 255] = Sim.copyHopper(mine);
  presses.delete(t - 600);
  return { hopped: mine.hops !== was, coin: mine.coins !== coins };
}

/* ── what the server says ─────────────────────────────────────────────────── */
socket.on('connect', () => {
  rtts.length = 0;
  ping();
  if (WATCH) { me = null; swapping = false; watch(null); return; }
  me = socket.id;
  if (overShown) return;
  if (match) dropMatch();
  if (waiting && resumeKey) { queue(null, resumeKey); return; }
  queue();
});

socket.on('cr:start', (raw) => {
  if (!raw) return;
  stopWait();
  resumeKey = null;
  if (WATCH) { if (watchMatch) startMatch(fromWatch(raw)); return; }
  if (raw.v !== Sim.VERSION) { location.reload(); return; }
  if (raw.vsBot) botNote();
  me = socket.id;
  matchAt = Date.now();
  sfx('g.join');
  startMatch(raw);
});
socket.on('cr:go', () => { if (match) phase = 'playing'; });
socket.on('cr:s', (m) => {
  if (!match || !m || !Array.isArray(m.p)) return;
  if (phase === 'countdown' && m.T > 0) phase = 'playing';
  for (const row of m.p) takeRow(row);
});

socket.on('cr:over', (m) => {
  if (WATCH) { watchOver(m || {}); return; }
  if (overShown || !match) return;
  overShown = true;
  phase = 'over';
  lastOver = Object.assign({}, m || {}, { ms: matchAt ? Date.now() - matchAt : 0, me, seat: mySeat });
  if (m && m.winnerId) { if (m.winnerId === me) series.mine++; else series.theirs++; }
  restake = null; restakeLine = '';
  // The death plays out first: the card comes up 1.6 s after the first one went.
  const first = Math.min(deadAt[0] || Infinity, deadAt[1] || Infinity, mine && !mine.alive ? (mine.diedAt || Infinity) : Infinity);
  const delay = Number.isFinite(first) ? Math.max(0, 1600 - (performance.now() - first)) : 600;
  overAt = performance.now() + delay;
  setTimeout(() => {
    if (!lastOver) return;
    sfx(m && m.winnerId === me ? 'g.win' : m && m.winnerId ? 'g.lose' : 'g.tick');
    paintOver();
    chatShow(false);
  }, delay);
});

/* ── the wait (Head Soccer's, word for word) ──────────────────────────────── */
const WAIT_MS = window.DS_DUEL_WAIT_MS;
let waiting = false, waitPaid = false, waitEndsAt = 0, waitTimer = 0, resumeKey = null, queuedOk = false, closed = false;
function waitClock(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function paintWait() {
  if (!waiting) return;
  const left = waitEndsAt - Date.now();
  const table = '$' + myStake.toFixed(2) + ' table. ';
  if (left > 0) {
    $('waitMain').textContent = 'Looking for a player… ' + waitClock(left);
    $('waitSub').textContent = waitPaid ? table + 'Real players only, never a bot. Cancel any time for a full refund.'
      : 'Free table. If nobody joins, you\'ll play a bot.';
  } else if (waitPaid) {
    $('waitMain').textContent = 'Still looking for a player';
    $('waitSub').textContent = table + 'Nobody yet. Cancel any time for a full refund.';
  } else {
    $('waitMain').textContent = 'Nobody joined. Playing a bot…';
    $('waitSub').textContent = 'Free table. Starting against a bot now.';
  }
}
function startWait(ms) { waiting = true; waitEndsAt = Date.now() + Math.max(0, ms); clearInterval(waitTimer); waitTimer = setInterval(paintWait, 250); paintWait(); }
function stopWait() { waiting = false; clearInterval(waitTimer); }
function waitSpin(on) { const s = document.querySelector('.waitSpin'); if (s) s.hidden = !on; }
socket.on('cr:queued', (q = {}) => {
  if (WATCH || match) return;
  queuedOk = true;
  if (typeof q.resumeKey === 'string') resumeKey = q.resumeKey;
  const total = Number(q.waitMs) > 0 ? Number(q.waitMs) : WAIT_MS;
  startWait(total - (Number(q.waitingMs) || 0));
});
function queue(token, resume) {
  overShown = false; lastOver = null; queuedOk = false;
  if (window.DSEnd) DSEnd.hide();
  chatShow(false);
  $('wait').hidden = false;
  waitSpin(true);
  waitPaid = myStake > 0;
  $('waitCancel').textContent = waitPaid ? 'Cancel and refund' : 'Back to the lobby';
  if (!resume) startWait(WAIT_MS); else paintWait();
  socket.emit('cr:queue', {
    name: myName, wallet: myWallet, stake: myStake, entryToken: token || myEntryToken,
    resume: resume || undefined, v: Sim.VERSION,
  });
  myEntryToken = null;   // one use only
  try { sessionStorage.removeItem('entryToken'); } catch (_) {}
}

/* ── the result card (the shared one, public/js/shared/dsEnd.js) ─────────── */
const RESTAKE_WAIT_MS = 120000;
const TEXT = {
  againAsk: 'Confirm in your wallet...', againSlow: 'Waiting for your wallet...',
  againSlowLine: 'Your wallet has not answered yet. If you approved the stake, wait here: the round starts once it lands.',
  againFailed: 'Stake failed', lobbyOnly: 'Buy a new entry in the lobby to play again.',
};
const DEATH_WORDS = { car: 'hit by a car', train: 'hit by a train', water: 'fell in the river', log: 'carried off the edge', eagle: 'taken by the eagle' };
function paintOver() {
  const m = lastOver;
  if (!m || !window.DSEnd) return;
  const money = m.money && typeof m.money === 'object' ? m.money : null;
  const seat = money && money.seats ? money.seats[m.me] || null : null;
  const won = m.winnerId ? m.winnerId === m.me : null;
  const sc = Array.isArray(m.score) && m.score.length === 2 ? m.score : [0, 0];
  const s = m.seat === 1 ? 1 : 0;
  const time = m.ms > 0 ? DSEnd.clock(m.ms) : '';
  const card = { tone: 'plain', verdict: won === true ? 'You win' : won === false ? (m.winner || 'Opponent') + ' wins' : 'Draw', notes: [] };
  if (money) {
    if (money.refunded) { card.hero = DSEnd.usd(seat ? seat.refundMicro : 0); card.unit = 'refunded'; }
    else if (won === true) {
      card.tone = 'win'; card.hero = DSEnd.usd(money.netMicro); card.unit = 'to your wallet';
      card.ledger = [['Pot', DSEnd.usd(money.potMicro)], ['House 10%', DSEnd.usd(-money.cutMicro)], ['You receive', DSEnd.usd(money.netMicro)]];
    } else {
      card.tone = 'loss';
      card.hero = DSEnd.usd(-(seat ? seat.stakeMicro : Math.round((Number(m.stake) || 0) * 1e6)));
      card.unit = 'lost';
    }
    card.facts = [['Score', (sc[s] | 0) + ' to ' + (sc[1 - s] | 0)]];
    if (time) card.facts.push(['Time', time]);
  } else {
    card.hero = String(sc[s] | 0);
    card.unit = 'your score';
    card.facts = [['Theirs', String(sc[1 - s] | 0)]];
    if (time) card.facts.push(['Time', time]);
  }
  const deaths = Array.isArray(m.deaths) ? m.deaths : [];
  if (m.why === 'opponent left') card.notes.push('They left the match.');
  else if (m.why === 'both out') card.notes.push('You were both out on the same moment.');
  else if (m.why === 'time') card.notes.push('Five minutes up: the one further along wins.');
  else if (won === true && deaths[1 - s]) card.notes.push('They were ' + (DEATH_WORDS[deaths[1 - s]] || 'out') + '.');
  else if (won === false && deaths[s]) card.notes.push('You were ' + (DEATH_WORDS[deaths[s]] || 'out') + '.');
  const paid = myStake > 0;
  const price = paid ? 'Play again ' + DSEnd.usd(Math.round(myStake * 1e6)) : 'Play again';
  const shut = !!restake && !restake.slow;
  let again;
  if (paid && !FRAMED) { again = { id: 'again', text: price, primary: true, disabled: true }; card.notes.push(TEXT.lobbyOnly); }
  else if (restake) {
    again = { id: 'again', text: restake.slow ? TEXT.againSlow : TEXT.againAsk, primary: true, disabled: true };
    if (restake.slow) card.notes.push(TEXT.againSlowLine);
  } else again = { id: 'again', text: price, primary: true, onClick: playAgain };
  if (restakeLine) card.notes.push(restakeLine);
  card.buttons = [
    { id: 'lobby', text: 'Lobby', disabled: shut, onClick: toLobby },
    { id: 'spectate', text: 'Spectate', disabled: shut || !!restake, onClick: spectate },
    again,
  ];
  DSEnd.show(card);
}
function playAgain() { if (myStake > 0) { askRestake(); return; } requeue(null); }
function requeue(token) { socket.emit('cr:leave'); dropMatch(); queue(token); }
function newNonce() {
  try { const a = new Uint32Array(4); crypto.getRandomValues(a); return Array.prototype.map.call(a, (n) => n.toString(36)).join(''); }
  catch (_) { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
}
function askRestake() {
  if (!FRAMED || restake || !(myStake > 0)) return;
  restake = { nonce: newNonce(), slow: false };
  restakeLine = '';
  clearTimeout(restakeTimer);
  restakeTimer = setTimeout(() => { if (!restake) return; restake.slow = true; paintOver(); }, RESTAKE_WAIT_MS);
  paintOver();
  try { window.parent.postMessage({ type: 'duel:restake', game: GAME, stake: myStake, nonce: restake.nonce }, '*'); }
  catch (_) { restakeDone(TEXT.againFailed); }
}
function restakeDone(line) { restake = null; clearTimeout(restakeTimer); restakeLine = line || ''; paintOver(); }
window.addEventListener('message', (e) => {
  const d = e && e.data;
  if (!restake || !d || typeof d !== 'object') return;
  if (e.source !== window.parent) return;
  if (!e.origin || e.origin !== location.origin) return;
  if (typeof d.nonce !== 'string' || d.nonce !== restake.nonce) return;
  if (d.type === 'duel:restake:done' && typeof d.entryToken === 'string' && d.entryToken) {
    restake = null; restakeLine = ''; clearTimeout(restakeTimer); requeue(d.entryToken);
  } else if (d.type === 'duel:restake:error') restakeDone(String(d.message || TEXT.againFailed));
});
function sentence(s) { const t = String(s || '').trim(); if (!t) return ''; return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.'); }

socket.on('cr:unqueued', ({ refunded, why } = {}) => {
  if (WATCH || match) return;
  if (!refunded) {
    if (why !== 'the match could not start') return;
    stopWait(); resumeKey = null;
    $('wait').hidden = false; waitSpin(false);
    $('waitMain').textContent = 'Could not start the match';
    $('waitSub').textContent = 'Go back to the lobby and press Play again.';
    $('waitCancel').textContent = 'Back to the lobby';
    return;
  }
  stopWait(); resumeKey = null; waitPaid = false;
  $('wait').hidden = false; waitSpin(false);
  $('waitMain').textContent = 'Buy-in refunded';
  $('waitSub').textContent = ({
    'nobody joined that table': 'Nobody joined that table, so your buy-in went back to your wallet.',
    'left the queue': 'Cancelled. Your full buy-in went back to your wallet.',
    'connection dropped': 'Your connection dropped while you waited, so your buy-in went back to your wallet.',
    'the match could not start': 'The match could not start, so your buy-in went back to your wallet.',
  })[why] || 'Your buy-in went back to your wallet.';
  $('waitCancel').textContent = 'Back to the lobby';
});
socket.on('cr:refused', ({ why } = {}) => {
  if (WATCH || match) return;
  const lost = waiting && waitPaid && resumeKey;
  stopWait(); resumeKey = null; waitPaid = false;
  $('wait').hidden = false; waitSpin(false);
  $('waitMain').textContent = 'Not seated';
  $('waitSub').textContent = lost ? 'Your connection dropped while you waited. Your buy-in goes back to your wallet.'
    : (sentence(why) || 'The table did not let you in.');
  $('waitCancel').textContent = 'Back to the lobby';
});
socket.on('maintenance', (m) => {
  if (WATCH) return;
  if (m && m.maintenance) {
    if (match || (waiting && queuedOk)) return;
    closed = true; stopWait(); resumeKey = null;
    $('wait').hidden = false; waitSpin(false);
    $('waitMain').textContent = 'The game is closed right now';
    $('waitSub').textContent = (m && m.message) || 'Back shortly.';
    $('waitCancel').textContent = 'Back to the lobby';
  } else if (closed) { closed = false; if (!match && !overShown) queue(); }
});

/* ── leaving ───────────────────────────────────────────────────────────── */
function toLobby() {
  if (restake && !restake.slow) return;
  clearTimeout(watchTimer); clearTimeout(swapTimer);
  if (BAR) BAR.close();
  socket.emit(WATCH ? 'cr:unwatch' : 'cr:leave');
  if (window.parent && window.parent !== window) window.parent.postMessage('game:done', '*');
  else location.href = '/';
}
$('waitCancel').addEventListener('click', () => {
  if (waiting && waitPaid && !match && !WATCH) {
    stopWait(); waitPaid = false; resumeKey = null; waitSpin(true);
    $('waitMain').textContent = 'Cancelling…';
    $('waitSub').textContent = 'Giving your buy-in back.';
    $('waitCancel').textContent = 'Back to the lobby';
    socket.emit('cr:unqueue');
    return;
  }
  toLobby();
});
$('leave').addEventListener('click', async () => {
  if (!match || overShown) { toLobby(); return; }
  const ok = window.DSDialog ? await window.DSDialog.confirm({ title: 'Leave this match?', line: 'Leaving counts as a loss.', ok: 'Leave', cancel: 'Keep playing' })
    : window.confirm('Leave this match? Leaving counts as a loss.');
  if (ok) toLobby();
});
const WATCH_URL = '/crossy';
const MONEY_KEYS = ['entryToken', 'entrySol', 'stake', 'slPaidLaunch', 'slxPaidCut', 'slBr', 'spectateOnly'];
function reopen() { try { if (typeof location.replace === 'function') location.replace(WATCH_URL); else location.href = WATCH_URL; } catch (_) { location.href = WATCH_URL; } }
function spectate() {
  if (restake) return;
  if (WATCH) { watch(watchLastId); return; }
  try {
    for (const k of MONEY_KEYS) sessionStorage.removeItem(k);
    sessionStorage.setItem('dsWatch', GAME);
    if (myStake > 0) sessionStorage.setItem('dsWatchStake', String(myStake)); else sessionStorage.removeItem('dsWatchStake');
    if (sessionStorage.getItem('dsWatch') !== GAME) return;
  } catch (_) { return; }
  clearTimeout(watchTimer);
  socket.emit('cr:leave');
  reopen();
}
window.addEventListener('beforeunload', () => socket.emit(WATCH ? 'cr:unwatch' : 'cr:leave'));

/* ── watching ──────────────────────────────────────────────────────────── */
const seatId = (side) => 's' + side;
function fromWatch(s) { if (!s) return s; return Object.assign({}, s, { players: (s.players || []).map(p => Object.assign({}, p, { id: seatId(p.side) })) }); }
function watch(after, dir) {
  clearTimeout(watchTimer);
  const msg = after ? { after, stake: WATCH_STAKE } : { stake: WATCH_STAKE };
  if (after && dir === 'prev') msg.dir = 'prev';
  socket.emit('cr:watch', msg);
  publishWatch(watchMatch ? 'watching' : 'searching');
}
function stepWatch(dir) {
  clearTimeout(watchTimer); clearTimeout(swapTimer);
  swapping = true;
  if (BAR) BAR.busy(true);
  swapTimer = setTimeout(() => { swapping = false; if (BAR) BAR.busy(false); }, WATCH_SWAP_MS);
  watch(watchMatch ? watchMatch.id : watchLastId, dir);
}
function followOn(ms) { clearTimeout(watchTimer); if (ms > 0) watchTimer = setTimeout(() => watch(watchLastId), ms); else watch(watchLastId); }
function nextSoon() { clearTimeout(watchTimer); watchTimer = setTimeout(() => watch(watchLastId), WATCH_NEXT_MS); }
function vsLabel(names) {
  const room = 28, half = room / 2;
  const c = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
  const a = String((names && names[0]) || 'Player').trim() || 'Player';
  const b = String((names && names[1]) || 'Player').trim() || 'Player';
  const x = a.length <= half ? a : b.length <= half ? c(a, room - b.length) : c(a, half);
  const y = b.length <= half ? b : a.length <= half ? c(b, room - a.length) : c(b, half);
  return x + ' vs ' + y;
}
function publishWatch(mode) {
  try {
    window.__watch = { game: GAME, mode, matchId: watchMatch ? watchMatch.id : null, names: watchMatch ? watchMatch.names.slice() : [],
      index: watchMatch ? watchMatch.index : 0, count: watchMatch ? watchMatch.count : 0, stake: watchMatch ? watchMatch.stake : 0, state: phase };
  } catch (_) {}
}
function watchLine(text) { const l = $('watchLine'); l.textContent = text || ''; l.hidden = !text; }
socket.on('cr:watching', (m) => {
  if (!WATCH || !m) return;
  clearTimeout(watchTimer); clearTimeout(swapTimer);
  const swap = swapping;
  swapping = false;
  if (!m.match || !m.state) {
    watchMatch = null;
    dropMatch(); overShown = false; watchLine('');
    chatShow(false);
    if (BAR) BAR.empty();
    publishWatch(m.full ? 'full' : m.refused ? 'refused' : 'none');
    nextSoon();
    return;
  }
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
socket.on('cr:matches', ({ index, count } = {}) => {
  if (!WATCH || !watchMatch) return;
  if (Number.isFinite(index)) watchMatch.index = index;
  if (Number.isFinite(count)) watchMatch.count = count;
  publishWatch('watching');
});
socket.on('cr:ended', ({ id } = {}) => {
  if (!WATCH || overShown) return;
  if (watchMatch && id && id !== watchMatch.id) return;
  overShown = true;
  publishWatch('ended');
  followOn(0);
});
function watchOver(m) {
  if (overShown) return;
  overShown = true;
  phase = 'over';
  const names = watchMatch ? watchMatch.names : [];
  const loser = m.winnerSide === 0 ? names[1] : m.winnerSide === 1 ? names[0] : null;
  const said = [m.winner ? m.winner + ' wins' : 'Draw'];
  if (m.why === 'opponent left') said.push((loser || 'A player') + ' left the match');
  else if (loser && m.why) said.push(loser + ' was ' + m.why);
  watchLine(said.join('. ') + '.');
  publishWatch('over');
  followOn(WATCH_OVER_MS);
}

/* ── the HUD: our own pixel lettering (5 x 7), drawn like the reference's (white, a hard black shadow) ──── */
const GLYPH = {
  0: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'], 1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00110', '01000', '10000', '11111'], 3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], 5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'], 7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'], 9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'], O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
};
function pixText(str, x, y, p, fill, align) {
  const chars = String(str).split('');
  const w = chars.length * 6 * p - p;
  let cx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  for (const ch of chars) {
    const g = GLYPH[ch];
    if (g) for (let pass = 0; pass < 2; pass++) {
      hx.fillStyle = pass ? fill : '#000';
      const o = pass ? 0 : Math.max(2, Math.round(p * 0.5));
      for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r][c] === '1') hx.fillRect(cx + c * p + o, y + r * p + o, p, p);
    }
    cx += 6 * p;
  }
  return w;
}
function coinIcon(x, y, s) {
  hx.fillStyle = '#000'; hx.fillRect(x + 3, y + 3, s, s);
  hx.fillStyle = '#d99a1e'; hx.fillRect(x, y, s, s);
  hx.fillStyle = '#ffd23f'; hx.fillRect(x + s * 0.12, y + s * 0.12, s * 0.76, s * 0.76);
  hx.fillStyle = '#fff3a8'; hx.fillRect(x + s * 0.36, y + s * 0.36, s * 0.28, s * 0.28);
}
function drawHud(W, H, dpr) {
  hx.setTransform(dpr, 0, 0, dpr, 0, 0);
  hx.clearRect(0, 0, W, H);
  if (!match) return;
  const u = Math.max(4, Math.round(Math.min(H, W * 0.75) * 0.0125));   // the score's pixel (9 px on a 720-high screen)
  const top = Math.max(10, u * 1.2);
  const meH = mySeat >= 0 ? mine : (shown[0] && shown[1] ? (Sim.score(shown[0]) >= Sim.score(shown[1]) ? shown[0] : shown[1]) : null);
  if (meH) pixText(Sim.score(meH), top, top, u, '#fff');
  // The rival: their name and score, small, under yours.
  if (mySeat >= 0) {
    const o = shown[1 - mySeat];
    hx.font = '700 ' + Math.max(12, Math.round(u * 1.6)) + 'px Archivo, system-ui, sans-serif';
    hx.textBaseline = 'top';
    const yy = top + u * 8.6, label = (match.names[1 - mySeat] || 'Rival') + ' ';
    hx.fillStyle = '#000'; hx.fillText(label, top + 2, yy + 2);
    hx.fillStyle = '#fff'; hx.fillText(label, top, yy);
    const lw = hx.measureText(label).width;
    pixText(o ? Sim.score(o) : 0, top + lw + 4, yy + 1, Math.max(2, Math.round(u * 0.4)), '#fff');
  }
  // Coins, top right, yellow, with our coin.
  const cu = Math.max(3, Math.round(u * 0.7));
  const coins = meH ? meH.coins : 0;
  const iconS = cu * 7;
  coinIcon(W - top - iconS, top, iconS);
  pixText(coins, W - top - iconS - cu * 2, top, cu, '#ffe100', 'right');
  // The countdown, then GO.
  const ft = matchFt();
  if (phase === 'countdown' || (phase === 'playing' && ft < 40)) {
    const left = -ft / Sim.HZ;
    const big = Math.round(u * 2.2);
    const txt = left > 0 ? String(Math.ceil(left)) : 'GO!';
    pixText(txt, W / 2, H * 0.36, big, '#fff', 'center');
  }
  // The key hint until the first hop (the reference shows its arrow keys at the bottom).
  if (!hinted && mySeat >= 0 && !overShown) {
    if (touchUI) {
      hx.font = '700 15px Archivo, system-ui, sans-serif'; hx.textAlign = 'center'; hx.textBaseline = 'bottom';
      hx.fillStyle = '#000'; hx.fillText('Tap to hop forward. Swipe to hop any way.', W / 2 + 2, H - 30);
      hx.fillStyle = '#fff'; hx.fillText('Tap to hop forward. Swipe to hop any way.', W / 2, H - 32);
      hx.textAlign = 'left';
    } else {
      const k = Math.max(26, Math.round(u * 4.2)), g = Math.round(k * 0.12), cx = W / 2, by = H - k * 2 - g - 24;
      const key = (x, y, dir) => {
        hx.fillStyle = 'rgba(0,0,0,0.85)'; hx.fillRect(x, y, k, k);
        hx.fillStyle = '#fff'; hx.fillRect(x + 3, y + 3, k - 6, k - 6);
        hx.fillStyle = '#000';
        const m = k / 2, s = k * 0.18;
        hx.beginPath();
        if (dir === 'u') { hx.moveTo(x + m, y + m - s); hx.lineTo(x + m + s, y + m + s * 0.6); hx.lineTo(x + m - s, y + m + s * 0.6); }
        if (dir === 'd') { hx.moveTo(x + m, y + m + s); hx.lineTo(x + m + s, y + m - s * 0.6); hx.lineTo(x + m - s, y + m - s * 0.6); }
        if (dir === 'l') { hx.moveTo(x + m - s, y + m); hx.lineTo(x + m + s * 0.6, y + m - s); hx.lineTo(x + m + s * 0.6, y + m + s); }
        if (dir === 'r') { hx.moveTo(x + m + s, y + m); hx.lineTo(x + m - s * 0.6, y + m - s); hx.lineTo(x + m - s * 0.6, y + m + s); }
        hx.fill();
      };
      key(cx - k / 2, by, 'u');
      key(cx - k / 2 - k - g, by + k + g, 'l'); key(cx - k / 2, by + k + g, 'd'); key(cx + k / 2 + g, by + k + g, 'r');
    }
  }
}

/* ── the frame ───────────────────────────────────────────────────────── */
let lastFrame = performance.now(), W = 0, H = 0, DPR = 1;
let trainNear = new Set();
function fit() {
  const w = window.innerWidth, h = window.innerHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (w === W && h === H && dpr === DPR) return;
  W = w; H = h; DPR = dpr;
  view.resize(w, h, dpr);
  hud.width = Math.round(w * dpr); hud.height = Math.round(h * dpr);
}
window.addEventListener('resize', fit);

function frame(now) {
  requestAnimationFrame(frame);
  fit();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!match || !world) { drawHud(W, H, DPR); return; }
  const ftNow = matchFt();
  const ft = Math.max(0, ftNow);
  // My hopper, stepped to the server's tick now (hops are read on the tick they were pressed for).
  if (mine && phase === 'playing') {
    const target = Math.floor(ft);
    let n = 0;
    while (mine.tick < target && mine.alive && n++ < 240) {
      const o = stepMine();
      if (o.hopped) { if (SND) SND.play('cr.hop', { rate: mine.hops % 2 ? 1 : 1.06 }); }
      if (o.coin) { if (SND) SND.play('cr.coin'); view.takeCoin(mine.r); }
      if (!mine.alive) {
        mine.diedAt = performance.now();
        deadAt[mySeat] = deadAt[mySeat] || mine.diedAt;
        if (SND) SND.play(mine.death === 'water' || mine.death === 'log' ? 'cr.splash' : mine.death === 'eagle' ? 'cr.eagle' : 'cr.squash');
      }
    }
    // Where my hopper's timeline has got to, a few times a second (never past what has been stepped).
    if (now - lastBeat > 50 && mine.tick - 1 > sentT && phase === 'playing') {
      sentT = mine.tick - 1;
      lastBeat = now;
      socket.volatile.emit('cr:in', { t: sentT });
    }
  }
  // The other seat(s): the server's latest, stepped on to now with nothing pressed (logs carry it smoothly).
  for (const s of [0, 1]) {
    if (s === mySeat || !seen[s]) continue;
    const base = seen[s].h;
    if (shown[s].tick !== base.tick || shown[s].baseAt !== seen[s].at) { shown[s] = Sim.copyHopper(base); shown[s].baseAt = seen[s].at; }
    let n = 0;
    while (shown[s].tick < Math.floor(ft) && shown[s].alive && n++ < 30) Sim.step(world, shown[s], 0);
  }
  if (mine && mySeat >= 0) shown[mySeat] = mine;

  // The camera follows my hopper (a watcher's follows whoever is further along).
  const focusSeat = mySeat >= 0 ? mySeat : (Sim.score(shown[0]) >= Sim.score(shown[1]) ? 0 : 1);
  const fh = shown[focusSeat];
  const d = Sim.laneTime(ft);
  const deadInfo = (h, s) => (!h.alive ? { type: h.death, age: Math.max(0, (performance.now() - (deadAt[s] || performance.now())) / 1000) } : null);
  if (fh) {
    const b = Sim.bodyAt(world, fh, ft);
    view.follow(b, fh.eagle, dt, deadInfo(fh, focusSeat));
    for (const s of [0, 1]) {
      const h = shown[s];
      if (!h || (!seen[s] && s !== mySeat)) { view.hideHopper(s); continue; }
      const bb = Sim.bodyAt(world, h, ft);
      const mineNow = s === mySeat;
      view.drawHopper(s, bb, mineNow && faceOnly ? faceOnly : h.face, mySeat >= 0 && !mineNow, mineNow && hold && !!faceOnly, deadInfo(h, s), dt);
    }
    const dead = deadInfo(fh, focusSeat);
    view.drawEagle(!!dead && dead.type === 'eagle', fh.x, -fh.r, dead ? dead.age : 0);
    // Crossing bells for trains about to cross a row near the hopper you follow.
    for (let r = fh.r - 2; r <= fh.r + 4; r++) {
      const row = world.row(r);
      if (!row || row.kind !== 'rail') continue;
      const tr = Sim.trainAt(row, d);
      const key = r + ':' + tr.k;
      if (tr.warn && !trainNear.has(key)) { trainNear.add(key); if (SND) SND.play('cr.bell'); setTimeout(() => SND && SND.play('cr.train'), 900); }
    }
    if (trainNear.size > 64) trainNear = new Set([...trainNear].slice(-16));
    view.render(d, fh.r);
    placeTag(ft);
  }
  drawHud(W, H, DPR);
}

/* The rival's name, over their see-through hopper. */
const tagV = { x: 0, y: 0, z: 0 };
function placeTag(ft) {
  const t = $('tag');
  if (mySeat < 0 || !match || !seen[1 - mySeat]) { t.hidden = true; return; }
  const h = shown[1 - mySeat];
  const b = Sim.bodyAt(world, h, ft);
  tagV.x = b.x; tagV.y = b.y + 1.15; tagV.z = b.z;
  const v = new (view.camera.position.constructor)(tagV.x, tagV.y, tagV.z).project(view.camera);
  if (v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2) { t.hidden = true; return; }
  t.hidden = false;
  t.textContent = match.names[1 - mySeat] || 'Rival';
  t.style.transform = 'translate(' + Math.round((v.x + 1) / 2 * W) + 'px,' + Math.round((1 - v.y) / 2 * H) + 'px) translate(-50%,-100%)';
}

/* What the match looks like right now, for a headless check. Read only. */
window.__cr = () => ({
  phase, mySeat, seed: match ? match.seed : null, tick: mine ? mine.tick : null, ft: Math.round(matchFt()),
  me: mine ? { x: mine.x, r: mine.r, alive: mine.alive, death: mine.death, score: Sim.score(mine), coins: mine.coins, eagle: mine.eagle } : null,
  them: mySeat >= 0 && seen[1 - mySeat] ? { r: seen[1 - mySeat].h.r, alive: seen[1 - mySeat].h.alive } : null,
  corrections, rtt: Math.round(rtt), over: overShown, waiting, touchUI,
});

/* ── boot ──────────────────────────────────────────────────────────────── */
fit();
requestAnimationFrame(frame);
if (WATCH) {
  document.body.classList.add('watching');
  $('wait').hidden = true;
  if (BAR) {
    BAR.open({ game: GAME, stake: WATCH_STAKE, onPrev: () => stepWatch('prev'), onNext: () => stepWatch('next'), onLobby: toLobby });
    BAR.watching('Finding a match');
    BAR.busy(true);
  }
  publishWatch('searching');
}
