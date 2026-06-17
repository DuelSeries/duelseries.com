// Headless load tester: spawns N socket.io clients that join the free lobby and
// send input like real players, ramping through LEVELS. Reads server-side tick
// cost from /api/debug/tick. Server-side ticksPerSec is the authoritative health
// metric (should stay ~60); client snap/s and MB/s are secondary (and, when run on
// the SAME machine as the server, share its CPU — so treat local numbers as rough).
//
// NOTE: the /api/debug/tick endpoint was removed in 5a2a7c9 once the FPS issue was
// solved, so the tickAvg/tickMax/ticks-per-sec/snakes columns currently show "-".
// The connection/snap-rate/bandwidth columns still work. Re-add the endpoint in
// server/index.js (returning [{ region, room, avgMs, maxMs, ticksPerSec, snakes }])
// to restore the server-side tick metrics.
//
// Usage: npm run loadtest   (env: LT_URL, LT_LEVELS, LT_HZ, LT_SAMPLE, LT_REGION, LT_LOBBY)
const { io } = require('socket.io-client');
const http   = require('http');
const https  = require('https');
const { decodeSnapshot } = require('../shared/snapshotCodec');

const URL       = process.env.LT_URL    || 'http://localhost:3000';
const LEVELS    = (process.env.LT_LEVELS || '25,50,100,200').split(',').map(Number);
const INPUT_HZ  = +(process.env.LT_HZ     || 20);
const SAMPLE_MS = +(process.env.LT_SAMPLE || 5000);
const REGION    = process.env.LT_REGION || 'na';
const LOBBY     = process.env.LT_LOBBY  || 'free';

const clients = [];
let nextId = 0;

function spawn() {
  const id = nextId++;
  const c = { id, snaps: 0, bytes: 0, connected: false, joined: false, err: null, angle: Math.random() * 6.28 };
  const sock = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true, timeout: 10000 });
  c.sock = sock;
  sock.on('connect', () => {
    c.connected = true;
    sock.emit('play', { name: 'LT' + id, lobbyType: LOBBY, region: REGION, color: '#888', entrySol: 0 });
    sock.emit('view', { r: 1200 });
  });
  sock.on('game_joined', () => { c.joined = true; });
  sock.on('snapshot', (meta, coords) => {
    c.snaps++;
    c.bytes += (meta ? JSON.stringify(meta).length : 0) + (coords ? (coords.byteLength || 0) : 0);
    if (c.snaps === 1) { try { const s = decodeSnapshot(meta, coords); c.decOk = !!(s && Array.isArray(s.snakes)); } catch (e) { c.decErr = e.message; } }
  });
  sock.on('connect_error', (e) => { c.err = e.message; });
  clients.push(c);
}

setInterval(() => {
  for (const c of clients) {
    if (c.connected && c.joined) {
      c.angle += 0.02;
      c.sock.volatile.emit('input', { angle: c.angle, boost: false, speedMult: 1 });
    }
  }
}, 1000 / INPUT_HZ);

function getTickStats() {
  const mod = URL.startsWith('https') ? https : http;
  return new Promise((resolve) => {
    mod.get(URL + '/api/debug/tick', (r) => {
      let d = ''; r.on('data', x => d += x); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log(`Load test -> ${URL}  (lobby=${LOBBY} region=${REGION}, input ${INPUT_HZ}Hz, sample ${SAMPLE_MS}ms)\n`);
  console.log(' target | conn | joind | snap/s/cli | tickAvg | tickMax | ticks/s | MB/s | snakes');
  console.log('--------+------+-------+------------+---------+---------+---------+------+-------');
  for (const L of LEVELS) {
    while (clients.length < L) { spawn(); await sleep(15); }
    await sleep(2500); // settle
    for (const c of clients) { c.snaps = 0; c.bytes = 0; }
    const t0 = Date.now();
    await sleep(SAMPLE_MS);
    const dt = (Date.now() - t0) / 1000;
    const conn   = clients.filter(c => c.connected).length;
    const joined = clients.filter(c => c.joined).length;
    const snaps  = clients.reduce((a, c) => a + c.snaps, 0);
    const bytes  = clients.reduce((a, c) => a + c.bytes, 0);
    const snapPerCli = joined ? snaps / joined / dt : 0;
    const mbps   = (bytes / dt) / 1e6;
    const stats  = await getTickStats();
    const room   = stats.find(s => s.region === REGION && String(s.room).endsWith(LOBBY)) || {};
    console.log(
      `${String(L).padStart(7)} | ${String(conn).padStart(4)} | ${String(joined).padStart(5)} | ` +
      `${snapPerCli.toFixed(1).padStart(10)} | ${String(room.avgMs ?? '-').padStart(7)} | ${String(room.maxMs ?? '-').padStart(7)} | ` +
      `${String(room.ticksPerSec ?? '-').padStart(7)} | ${mbps.toFixed(2).padStart(4)} | ${String(room.snakes ?? '-').padStart(6)}`
    );
    const errs = clients.filter(c => c.err);
    if (errs.length) console.log(`   ! ${errs.length} connect errors (e.g. "${errs[0].err}")`);
  }
  const decOk = clients.filter(c => c.decOk).length;
  const decErr = clients.filter(c => c.decErr);
  console.log(`\ndecode: ${decOk}/${clients.length} clients decoded a snapshot OK` + (decErr.length ? `, ${decErr.length} ERRORS (e.g. "${decErr[0].decErr}")` : ''));
  console.log('done; disconnecting.');
  for (const c of clients) c.sock.close();
  process.exit(0);
}
run();
