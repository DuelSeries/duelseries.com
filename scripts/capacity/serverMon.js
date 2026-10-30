'use strict';
// The server side of the capacity test (2026-10-29): run ON the game box while scripts/capacity/run.js plays.
//
//   NODE_PATH=/home/ubuntu/duelseries/node_modules node serverMon.js --pid <node pid> --out /tmp/lt/mon.jsonl [--inspect]
//
// Every 2 s one JSON line:
//   os      whole-box CPU (user, system, steal, idle %), the game process's and nginx's CPU % of one core, memory
//           available, the process's RSS, network in/out MB/s on ens5
//   probe   GET http://127.0.0.1:3000/healthz four times a second: its latency is the event loop's queueing delay as an
//           outside request feels it (p50, p95, max ms in the window)
//   inproc  (--inspect only) from inside the game process, through the Node inspector the script opens with SIGUSR1 on
//           127.0.0.1 (never reachable from outside the box): event-loop utilisation, event-loop delay p50/p99/max, GC
//           pauses, heap, and for every slither.io and agar.io room its TickTimer deltas (ticks per second, mean step
//           cost, steps over 10 and 20 ms, late wakes, dropped backlog) plus the size of each room's Maps (seats, ...).
//           Rooms are found once with a heap query (a short pause, logged); touch /tmp/lt/refresh to find them again.
// It reads; it changes nothing in the game. On exit (SIGINT/SIGTERM) it removes what it installed and closes the
// inspector (inspector.close()), so the process is as it was.

const fs = require('fs');
const http = require('http');
const { execSync } = require('child_process');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const PID = Number(arg('pid', 0));
const OUT = arg('out', '/tmp/lt/mon.jsonl');
const INSPECT = arg('inspect', false) === true;
const NO_ROOMS = arg('no-rooms', false) === true; // skip the heap query (it pauses the game loop once)
const EVERY = Number(arg('every', 2000));
const APP = arg('app', '/home/ubuntu/duelseries');
const PORT = Number(arg('port', 3000));
const NIC = arg('nic', 'ens5');
const out = fs.createWriteStream(OUT, { flags: 'a' });
const TICK = 100; // jiffies per second (CONFIG_HZ USER_HZ on Ubuntu)

function procCpu(pid) {
  try {
    const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]); // utime + stime
  } catch (_) {
    return NaN;
  }
}
function procRss(pid) {
  try {
    const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8'));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch (_) {
    return null;
  }
}
function nginxPids() {
  try {
    return execSync('pgrep nginx').toString().trim().split('\n').map(Number).filter(Boolean);
  } catch (_) {
    return [];
  }
}
function boxCpu() {
  const l = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal
  return { user: l[0] + l[1], system: l[2] + l[5] + l[6], idle: l[3] + l[4], steal: l[7] || 0 };
}
function net() {
  const line = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').find((x) => x.trim().startsWith(NIC + ':'));
  const f = line.split(':')[1].trim().split(/\s+/).map(Number);
  return { rx: f[0], tx: f[8] };
}
function memAvail() {
  const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

// ---- healthz probe
let lat = [];
function probe() {
  const t0 = process.hrtime.bigint();
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/healthz', timeout: 5000, agent: false }, (res) => {
    res.resume();
    res.on('end', () => lat.push(Number(process.hrtime.bigint() - t0) / 1e6));
  });
  req.on('timeout', () => { lat.push(5000); req.destroy(); });
  req.on('error', () => lat.push(-1));
}
setInterval(probe, 250);

// ---- inspector
let ws = null;
let seq = 0;
const waiting = new Map();
function cdp(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error('cdp timeout ' + method)); } }, 15000);
  });
}
async function evalJson(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

const SETUP = `(() => {
  if (globalThis.__lt) return 'already';
  const req = process.mainModule.require;
  const ph = req('perf_hooks');
  const h = ph.monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const gc = { n: 0, ms: 0, max: 0 };
  const obs = new ph.PerformanceObserver((list) => { for (const e of list.getEntries()) { gc.n++; gc.ms += e.duration; if (e.duration > gc.max) gc.max = e.duration; } });
  obs.observe({ entryTypes: ['gc'] });
  globalThis.__lt = { h, gc, obs, elu: ph.performance.eventLoopUtilization(), ph, rooms: [], prev: new Map() };
  return 'ok';
})()`;

const SAMPLE = `(() => {
  const L = globalThis.__lt;
  if (!L) return null;
  const now = Date.now();
  const elu = L.ph.performance.eventLoopUtilization(L.elu);
  L.elu = L.ph.performance.eventLoopUtilization();
  const ms = (x) => Math.round(x / 1e5) / 10;
  const o = { elu: Math.round(elu.utilization * 1000) / 10, loopP50: ms(L.h.percentile(50)), loopP99: ms(L.h.percentile(99)),
    loopMax: ms(L.h.max), gcN: L.gc.n, gcMs: Math.round(L.gc.ms), gcMax: Math.round(L.gc.max),
    heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), rooms: [] };
  L.h.reset(); L.gc.n = 0; L.gc.ms = 0; L.gc.max = 0;
  for (const { kind, r } of L.rooms) {
    const row = { kind, id: r.id || r.lobbyType || r.roomId || r.key || null };
    const maps = {};
    for (const k of Object.keys(r)) { const v = r[k]; if (v instanceof Map || v instanceof Set) { if (v.size) maps[k] = v.size; } }
    row.maps = maps;
    const t = r.timing;
    if (t && t.tickHist) {
      const p = L.prev.get(r) || { at: now, steps: t.steps, n: t.tickHist.n, sum: t.tickHist.sum, c: Array.from(t.tickHist.counts), late: Array.from(t.lateHist.counts), wakes: t.wakes, dropped: t.droppedSteps };
      const dt = (now - p.at) / 1000;
      if (dt > 0) {
        const dn = t.tickHist.n - p.n;
        const dc = Array.from(t.tickHist.counts).map((c, i) => c - p.c[i]);
        const dl = Array.from(t.lateHist.counts).map((c, i) => c - p.late[i]);
        // edges 1,2,5,10,20,50 -> buckets [0-1,1-2,2-5,5-10,10-20,20-50,50+]
        row.tps = Math.round((t.steps - p.steps) / dt * 10) / 10;
        row.stepMs = dn ? Math.round((t.tickHist.sum - p.sum) / dn * 100) / 100 : null;
        row.stepOver10 = dc[4] + dc[5] + dc[6];
        row.stepOver20 = dc[5] + dc[6];
        row.stepOver50 = dc[6];
        row.lateOver10 = dl[4] + dl[5] + dl[6];
        row.lateOver20 = dl[5] + dl[6];
        row.lateOver50 = dl[6];
        row.dropped = t.droppedSteps - p.dropped;
        row.periodMs = t.periodMs;
      }
      L.prev.set(r, { at: now, steps: t.steps, n: t.tickHist.n, sum: t.tickHist.sum, c: Array.from(t.tickHist.counts), late: Array.from(t.lateHist.counts), wakes: t.wakes, dropped: t.droppedSteps });
    }
    if (r.stats && typeof r.stats === 'object') {
      const s = r.stats;
      row.seats = s.seats;
    }
    o.rooms.push(row);
  }
  return o;
})()`;

const CLASSES = [
  ['sl', 'server/sl/slRoom.js', 'SlRoom'],
  ['ag', 'server/ag/agRoom.js', 'AgRoom'],
  ['paper', 'server/paper/PaperRoom.js', 'PaperRoom'],
  ['chomp', 'server/chomp/chompRoom.js', 'ChompRoom'],
  ['swim', 'server/swim/SwimLobby.js', 'SwimLobby'],
];

async function findRooms() {
  const t0 = Date.now();
  await evalJson('globalThis.__lt.rooms = []; globalThis.__lt.prev = new Map(); 1');
  for (const [kind, file, cls] of CLASSES) {
    const p = await cdp('Runtime.evaluate', { expression: `process.mainModule.require(${JSON.stringify(APP + '/' + file)}).${cls}.prototype` });
    if (!p.result || !p.result.objectId) continue;
    const q = await cdp('Runtime.queryObjects', { prototypeObjectId: p.result.objectId });
    await cdp('Runtime.callFunctionOn', {
      objectId: q.objects.objectId,
      functionDeclaration: `function () { for (const r of this) globalThis.__lt.rooms.push({ kind: ${JSON.stringify(kind)}, r }); return this.length; }`,
      returnByValue: true,
    });
    await cdp('Runtime.releaseObject', { objectId: q.objects.objectId });
    await cdp('Runtime.releaseObject', { objectId: p.result.objectId });
  }
  const n = await evalJson('globalThis.__lt.rooms.map(x => x.kind + ":" + (x.r.id || x.r.lobbyType || x.r.roomId || "?")).join(",")');
  out.write(JSON.stringify({ type: 'rooms', at: Date.now(), tookMs: Date.now() - t0, rooms: n }) + '\n');
}

async function openInspector() {
  process.kill(PID, 'SIGUSR1');
  let url = null;
  for (let i = 0; i < 40 && !url; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const list = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:9229/json/list', (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
        }).on('error', reject);
      });
      url = list[0] && list[0].webSocketDebuggerUrl;
    } catch (_) { /* not up yet */ }
  }
  if (!url) throw new Error('inspector did not open');
  const WebSocket = require('ws');
  ws = new WebSocket(url, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) w.reject(new Error(JSON.stringify(m.error)));
      else w.resolve(m.result);
    }
  });
  out.write(JSON.stringify({ type: 'inspector', at: Date.now(), setup: await evalJson(SETUP) }) + '\n');
  if (!NO_ROOMS) await findRooms();
}

async function cleanup() {
  if (!ws) return;
  try {
    await evalJson(`(() => { const L = globalThis.__lt; if (L) { L.h.disable(); L.obs.disconnect(); delete globalThis.__lt; } return 'cleared'; })()`);
    // closing from inside: the inspector stops listening on 9229, as before SIGUSR1
    await cdp('Runtime.evaluate', { expression: `setTimeout(() => process.mainModule.require('inspector').close(), 200); 'closing'` });
    out.write(JSON.stringify({ type: 'inspector', at: Date.now(), closed: true }) + '\n');
  } catch (e) {
    out.write(JSON.stringify({ type: 'inspector', at: Date.now(), cleanupError: e.message }) + '\n');
  }
}

// ---- the loop
let prev = null;
async function sample() {
  const now = Date.now();
  const nginx = nginxPids();
  const cur = { at: now, cpu: boxCpu(), node: procCpu(PID), nginx: nginx.reduce((a, p) => a + (procCpu(p) || 0), 0), net: net() };
  const rec = { type: 'sample', at: now };
  if (prev) {
    const dt = (now - prev.at) / 1000;
    const d = (k) => cur.cpu[k] - prev.cpu[k];
    const tot = d('user') + d('system') + d('idle') + d('steal');
    rec.os = {
      userPct: Math.round(d('user') / tot * 1000) / 10, sysPct: Math.round(d('system') / tot * 1000) / 10,
      stealPct: Math.round(d('steal') / tot * 1000) / 10, idlePct: Math.round(d('idle') / tot * 1000) / 10,
      nodePct: Math.round((cur.node - prev.node) / TICK / dt * 1000) / 10,
      nginxPct: Math.round((cur.nginx - prev.nginx) / TICK / dt * 1000) / 10,
      memAvailMB: memAvail(), nodeRssMB: procRss(PID),
      rxMBs: Math.round((cur.net.rx - prev.net.rx) / dt / 1048576 * 100) / 100,
      txMBs: Math.round((cur.net.tx - prev.net.tx) / dt / 1048576 * 100) / 100,
    };
  }
  prev = cur;
  const l = lat.filter((x) => x >= 0).sort((a, b) => a - b);
  rec.probe = { n: lat.length, errors: lat.filter((x) => x < 0).length,
    p50: l.length ? Math.round(l[Math.floor(l.length * 0.5)] * 10) / 10 : null,
    p95: l.length ? Math.round(l[Math.min(l.length - 1, Math.floor(l.length * 0.95))] * 10) / 10 : null,
    max: l.length ? Math.round(l[l.length - 1] * 10) / 10 : null };
  lat = [];
  if (ws) {
    try {
      if (fs.existsSync('/tmp/lt/refresh')) {
        fs.unlinkSync('/tmp/lt/refresh');
        await findRooms();
      }
      rec.inproc = await evalJson(SAMPLE);
    } catch (e) {
      rec.inprocError = e.message;
    }
  }
  out.write(JSON.stringify(rec) + '\n');
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await cleanup();
  out.end(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

(async () => {
  if (!PID) throw new Error('--pid needed');
  if (INSPECT) await openInspector();
  setInterval(() => { sample().catch((e) => out.write(JSON.stringify({ type: 'error', at: Date.now(), e: e.message }) + '\n')); }, EVERY);
})().catch((e) => {
  out.write(JSON.stringify({ type: 'fatal', at: Date.now(), e: e.message }) + '\n');
  process.exit(1);
});
