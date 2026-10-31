'use strict';
// Shared pieces of the capacity test (scripts/capacity/run.js; 2026-10-29, the live 150-player test).
//
// One simulated player = one socket.io connection (per namespace it uses) carrying its OWN X-Forwarded-For address, so the
// server counts it as its own network, the way 150 real people on 150 home connections would be counted. That only works
// from a box whose address nginx has been told (temporarily) to pass the header through; from anywhere else nginx appends
// the real address and the per-address caps see one client.
//
// A game module (scripts/capacity/games/<id>.js) exports { id, start(ctx) } and start returns { stop() }. ctx:
//   base   'https://duelseries.com' (no trailing slash)
//   ip     this player's address, e.g. '198.18.0.7' (RFC 2544 benchmark range, never a real network)
//   name   display name, e.g. 'Load7'
//   index  the player's number in the whole run (0..)
//   stats  a ClientStats (below): the module calls its methods as things happen
//   rand   () -> [0,1), seeded per player
//   opts   game options from the runner (e.g. { queueAt } for Swim)
//   log    (msg) -> void, rare lines only
// A module connects with openSocket (below), joins the FREE room only, plays like a person at the real page's input rate,
// decodes every world update it is sent, calls stats.snap() for each one, starts pingLoop on its game socket, and rejoins
// after a death the way a person pressing Play again would. Never paid: no entry token, no stake, no money route.

const { io } = require('socket.io-client');

function openSocket(base, nsp, ip, extra) {
  const url = String(base).replace(/\/+$/, '') + (nsp && nsp !== '/' ? nsp : '/');
  const o = Object.assign({
    transports: ['websocket'], forceNew: true, reconnection: false, timeout: 15000,
    extraHeaders: { 'x-forwarded-for': ip },
  }, extra || {});
  if (extra && extra.extraHeaders) o.extraHeaders = Object.assign({ 'x-forwarded-for': ip }, extra.extraHeaders);
  return io(url, o);
}

// Counts the bytes of every frame the socket receives (engine.io level, so every game is measured the same way).
function countBytes(socket, stats) {
  const hook = () => {
    const eng = socket.io && socket.io.engine;
    if (!eng || eng.__ltBytes) return;
    eng.__ltBytes = true;
    eng.on('data', (d) => {
      stats.bytes += typeof d === 'string' ? d.length : (d && (d.byteLength || d.length)) || 0;
    });
  };
  socket.on('connect', hook);
  hook();
}

// The ds:ping round trip the in-game ping readout uses (server/perfEcho.js answers it on every namespace): one every 2 s.
function pingLoop(socket, stats, everyMs) {
  const gap = everyMs || 2000;
  let out = false;
  const h = setInterval(() => {
    if (!socket.connected || out) return;
    out = true;
    const t0 = Date.now();
    socket.timeout(5000).emit('ds:ping', (err) => {
      out = false;
      if (err) stats.pingTimeout();
      else stats.ping(Date.now() - t0);
    });
  }, gap);
  if (h.unref) h.unref();
  return () => clearInterval(h);
}

// Per-player counters. Window counters are read and zeroed by takeWindow(); the rest only grow.
class ClientStats {
  constructor(game) {
    this.game = game;
    this.connected = false;
    this.seated = false;
    // window
    this.snaps = 0;
    this.bytes = 0;
    this.maxGap = 0;
    this.gaps100 = 0;
    this.gaps250 = 0;
    this.gaps1000 = 0;
    this.rtts = [];
    this.grtts = [];
    this.pingTimeouts = 0;
    this.lastSnapAt = 0;
    // cumulative
    this.connects = 0;
    this.connectErrors = 0;
    this.joins = 0;
    this.deaths = 0;
    this.drops = 0;
    this.refusals = {};
    this.errors = {};
    this.notes = {};
  }
  connectedNow() { this.connected = true; this.connects++; }
  connectError(why) { this.connectErrors++; this.bump(this.errors, 'connect:' + String(why || '?').slice(0, 60)); }
  joined() { this.seated = true; this.seatedAt = Date.now(); this.joins++; this.lastSnapAt = 0; }
  unseated() { this.seated = false; this.lastSnapAt = 0; }
  // One world update decoded (snapshot, bundle, frame). Gaps count only while seated.
  snap() {
    const t = Date.now();
    if (this.seated && this.lastSnapAt) {
      const g = t - this.lastSnapAt;
      if (g > this.maxGap) this.maxGap = g;
      if (g >= 100) this.gaps100++;
      if (g >= 250) this.gaps250++;
      if (g >= 1000) this.gaps1000++;
    }
    this.lastSnapAt = t;
    this.snaps++;
  }
  ping(ms) { if (this.rtts.length < 64) this.rtts.push(ms); }
  // The game's own ping (through the sim's queue), when the game has one; ds:ping above is the shared readout.
  gamePing(ms) { if (this.grtts.length < 64) this.grtts.push(ms); }
  pingTimeout() { this.pingTimeouts++; }
  dead() { this.deaths++; this.unseated(); }
  refused(why) { this.bump(this.refusals, String(why || '?').slice(0, 60)); }
  error(kind) { this.bump(this.errors, String(kind || '?').slice(0, 60)); }
  note(kind) { this.bump(this.notes, String(kind || '?').slice(0, 60)); }
  // A connection the client did not close itself.
  dropped(reason) { this.drops++; this.connected = false; this.unseated(); this.bump(this.errors, 'drop:' + String(reason || '?')); }
  closed() { this.connected = false; this.unseated(); }
  bump(m, k) { m[k] = (m[k] || 0) + 1; }
  // windowStart: when this window began; `whole` says the player was seated through all of it (its rate is a fair one).
  takeWindow(windowStart) {
    const w = { whole: this.seated && this.seatedAt <= (windowStart || 0), snaps: this.snaps, bytes: this.bytes, maxGap: this.maxGap, gaps100: this.gaps100, gaps250: this.gaps250,
      gaps1000: this.gaps1000, rtts: this.rtts, grtts: this.grtts, pingTimeouts: this.pingTimeouts, seated: this.seated, connected: this.connected };
    this.snaps = 0; this.bytes = 0; this.maxGap = 0; this.gaps100 = 0; this.gaps250 = 0; this.gaps1000 = 0;
    this.rtts = []; this.grtts = []; this.pingTimeouts = 0;
    return w;
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The address of player i: 198.18.x.y, y in 1..250. The benchmarking range (RFC 2544) is also the server's mark of a
// test player: a battle royale seat from it never wins, places or counts (server/clientAddr.js isLoadTestAddr).
function ipOf(i) {
  return '198.18.' + Math.floor(i / 250) + '.' + ((i % 250) + 1);
}

function toU8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

module.exports = { openSocket, countBytes, pingLoop, ClientStats, mulberry32, ipOf, toU8 };
