'use strict';
// The capacity test runner (2026-10-29): simulated players in DuelSeries' FREE rooms, ramped in levels, measured from the
// client side. Server-side numbers come from scripts/capacity/serverMon.js on the game box at the same time.
//
//   node scripts/capacity/run.js --base https://duelseries.com --mix sl=150 --ramp 25,50,100,150 --hold 90 --out A.jsonl
//   --mix      game=count at the top level, comma separated (sl, ag, paper, chomp, swim); each level scales it
//   --ramp     the levels (total players); default 25,50,100,150
//   --hold     seconds each level runs before the next (the last one too); default 90
//   --last-hold  seconds the top level runs; default --hold
//   --stagger  ms between two joins inside a level; default 60 (0 with --sync)
//   --sync     every player added in a level gets the same opts.queueAt (now + 10 s): Swim's "all press at once"
//   --opts     per-game options as JSON, e.g. '{"sl":{"br":1}}'
//   --first    the first player's number (its address and name); default 0
//   --workers  processes; default 6
//   --report   seconds between lines; default 5
// Free rooms only: the game modules never send a token, a stake or a wallet. Ctrl-C (or the end) stops every player.

const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const BASE = String(arg('base', 'http://127.0.0.1:4409')).replace(/\/+$/, '');
const MIX = String(arg('mix', 'sl=150')).split(',').map((x) => x.split('=')).map(([g, n]) => ({ game: g.trim(), n: Number(n) }));
const TOP = MIX.reduce((a, m) => a + m.n, 0);
const RAMP = String(arg('ramp', '25,50,100,150')).split(',').map(Number).filter((x) => x > 0);
const HOLD = Number(arg('hold', 90));
const LAST_HOLD = Number(arg('last-hold', HOLD)); // the top level's own hold (seconds)
const SYNC = arg('sync', false) === true;
const STAGGER = Number(arg('stagger', SYNC ? 0 : 60));
const OPTS = JSON.parse(arg('opts', '{}'));
const FIRST = Number(arg('first', 0));
const WORKERS = Number(arg('workers', 6));
const REPORT = Number(arg('report', 5));
const OUT = arg('out', null);
const LABEL = arg('label', MIX.map((m) => m.game + m.n).join('+'));

const workers = [];
for (let i = 0; i < WORKERS; i++) {
  const w = fork(path.join(__dirname, 'worker.js'), [], { env: Object.assign({}, process.env, { LT_BASE: BASE }) });
  w.pending = null;
  w.on('message', (m) => {
    if (m && m.type === 'window') w.pending = m;
    else if (m && m.type === 'log') console.log(m.text);
  });
  workers.push(w);
}

const counts = {}; // game -> players added so far
let nextIndex = FIRST;
let rr = 0;
let level = 0;
const t0 = Date.now();
let out = OUT ? fs.createWriteStream(OUT, { flags: 'a' }) : null;

function targetFor(total) {
  // each game's share of this level, rounded so the shares add up to the level
  const raw = MIX.map((m) => ({ game: m.game, x: (m.n / TOP) * total }));
  const fl = raw.map((r) => ({ game: r.game, n: Math.floor(r.x), rem: r.x - Math.floor(r.x) }));
  let left = total - fl.reduce((a, r) => a + r.n, 0);
  fl.slice().sort((a, b) => b.rem - a.rem).forEach((r) => { if (left > 0) { r.n++; left--; } });
  return fl;
}

async function goLevel(total) {
  level = total;
  const tg = targetFor(total);
  const queueAt = SYNC ? Date.now() + 10000 : 0;
  const adds = [];
  for (const t of tg) {
    const have = counts[t.game] || 0;
    for (let k = have; k < t.n; k++) adds.push(t.game);
    counts[t.game] = Math.max(have, t.n);
  }
  // interleave games so a mixed level fills every game at once
  adds.sort(() => 0);
  log({ type: 'level', level: total, adding: adds.length, queueAt: queueAt || undefined });
  for (const game of adds) {
    const w = workers[rr++ % workers.length];
    const opts = Object.assign({}, OPTS[game] || {}, queueAt ? { queueAt } : {});
    w.send({ cmd: 'add', game, index: nextIndex++, opts });
    if (STAGGER) await sleep(STAGGER);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pct(arr, p) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function round(x, d) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = Math.pow(10, d || 0);
  return Math.round(x * f) / f;
}

function merge(windows) {
  const g = {};
  const wk = [];
  let dt = 0;
  for (const w of windows) {
    dt = Math.max(dt, w.dt);
    wk.push(w.worker);
    for (const [id, x] of Object.entries(w.byGame)) {
      const a = g[id] || (g[id] = { n: 0, connected: 0, seated: 0, rates: [], bytes: 0, gaps100: 0, gaps250: 0, gaps1000: 0,
        maxGap: 0, rtts: [], grtts: [], pingTimeouts: 0, joins: 0, deaths: 0, drops: 0, connects: 0, connectErrors: 0,
        refusals: {}, errors: {}, notes: {} });
      for (const k of ['n', 'connected', 'seated', 'bytes', 'gaps100', 'gaps250', 'gaps1000', 'pingTimeouts', 'joins', 'deaths',
        'drops', 'connects', 'connectErrors']) a[k] += x[k];
      a.maxGap = Math.max(a.maxGap, x.maxGap);
      a.rates.push(...x.rates);
      a.rtts.push(...x.rtts);
      a.grtts.push(...x.grtts);
      for (const m of ['refusals', 'errors', 'notes']) for (const k in x[m]) a[m][k] = (a[m][k] || 0) + x[m][k];
    }
  }
  const games = {};
  for (const [id, a] of Object.entries(g)) {
    const mean = a.rates.length ? a.rates.reduce((p, c) => p + c, 0) / a.rates.length : null;
    games[id] = {
      n: a.n, connected: a.connected, seated: a.seated,
      ups: round(mean, 1), upsP5: round(pct(a.rates, 0.05), 1), upsMin: round(a.rates.length ? Math.min(...a.rates) : null, 1),
      mbps: round(a.bytes / dt / 1048576, 2), kbpsPerSeated: a.seated ? round(a.bytes / dt / 1024 / a.seated, 1) : null,
      gaps100: a.gaps100, gaps250: a.gaps250, gaps1000: a.gaps1000, maxGap: a.maxGap,
      pingP50: pct(a.rtts, 0.5), pingP95: pct(a.rtts, 0.95), pingMax: a.rtts.length ? Math.max(...a.rtts) : null,
      gpingP50: pct(a.grtts, 0.5), gpingP95: pct(a.grtts, 0.95), gpingMax: a.grtts.length ? Math.max(...a.grtts) : null,
      pingTimeouts: a.pingTimeouts, joins: a.joins, deaths: a.deaths, drops: a.drops, connects: a.connects,
      connectErrors: a.connectErrors, refusals: a.refusals, errors: a.errors, notes: a.notes,
    };
  }
  const box = { load1: round(os.loadavg()[0], 2), cpus: os.cpus().length, freeMB: Math.round(os.freemem() / 1048576),
    workerCpuMax: Math.max(...wk.map((w) => w.cpuPct)), workerLoopP99Max: Math.max(...wk.map((w) => w.loopP99)),
    workerLoopMax: Math.max(...wk.map((w) => w.loopMax)) };
  return { games, box, dt: round(dt, 2) };
}

function log(obj) {
  const rec = Object.assign({ at: Date.now(), t: Math.round((Date.now() - t0) / 1000), label: LABEL }, obj);
  if (out) out.write(JSON.stringify(rec) + '\n');
  if (obj.type === 'window') {
    const parts = Object.entries(obj.games).map(([id, x]) => id + ' ' + x.seated + '/' + x.n + ' seated, ups ' + x.ups +
      ' (p5 ' + x.upsP5 + ', min ' + x.upsMin + '), gaps>250 ' + x.gaps250 + ' >1s ' + x.gaps1000 + ' max ' + x.maxGap +
      'ms, ping ' + x.pingP50 + '/' + x.pingP95 + '/' + x.pingMax + (x.gpingP50 !== null ? ' game ' + x.gpingP50 + '/' + x.gpingP95 + '/' + x.gpingMax : '') +
      ' ms, ' + x.mbps + ' MB/s, joins ' + x.joins + ' deaths ' + x.deaths + ' drops ' + x.drops + ' cerr ' + x.connectErrors +
      (Object.keys(x.refusals).length ? ' ref ' + JSON.stringify(x.refusals) : '') +
      (Object.keys(x.errors).length ? ' err ' + JSON.stringify(x.errors) : '') +
      (Object.keys(x.notes).length ? ' notes ' + JSON.stringify(x.notes) : ''));
    console.log('[+' + rec.t + 's L' + level + '] ' + parts.join(' | ') + ' || box load ' + obj.box.load1 + ' wcpu ' +
      obj.box.workerCpuMax + '% wloop p99 ' + obj.box.workerLoopP99Max + 'ms');
  } else {
    console.log('[+' + rec.t + 's] ' + JSON.stringify(obj));
  }
}

async function collect() {
  for (const w of workers) { w.pending = null; w.send({ cmd: 'window' }); }
  const until = Date.now() + 2000;
  while (Date.now() < until && workers.some((w) => !w.pending)) await sleep(50);
  const got = workers.map((w) => w.pending).filter(Boolean);
  if (got.length) log(Object.assign({ type: 'window' }, merge(got)));
}

let stopping = false;
async function stopAll() {
  if (stopping) return;
  stopping = true;
  log({ type: 'stop' });
  for (const w of workers) w.send({ cmd: 'stop' });
  await sleep(2500);
  if (out) out.end();
  process.exit(0);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

(async () => {
  log({ type: 'start', base: BASE, mix: MIX, ramp: RAMP, hold: HOLD, sync: SYNC, opts: OPTS, first: FIRST, workers: WORKERS });
  const rep = setInterval(() => { collect().catch((e) => console.log('collect', e.message)); }, REPORT * 1000);
  for (let i = 0; i < RAMP.length; i++) {
    await goLevel(RAMP[i]);
    await sleep((i === RAMP.length - 1 ? LAST_HOLD : HOLD) * 1000);
  }
  clearInterval(rep);
  await collect();
  await stopAll();
})();
