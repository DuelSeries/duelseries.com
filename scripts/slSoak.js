'use strict';
// The LOCAL long soak of the new /sl room (task T15; SERVER-BUILD-BRIEF 1.2 "Soak"; SERVER-DESIGN 18.4; PLAN Phase 3
// bars). No load test, no remote server: one local process serves /sl, a child process plays the wanderers.
//
// The server is the real boot path: an http server and socket.io with server/index.js's options (pingInterval 5000,
// pingTimeout 10000), server/sl/slBoot.js openSl with SL_ENABLED=1 and SL_DEV_LAWS = scripts/slSoakLaws.js (the shipped
// law table with the two caps at the curve peak and the approved prey rows), the real helpers that do not reach the
// network (server/ops.js, the socketRL of server/index.js:69-75), and a wall clock shifted onto the daily curve's peak
// (a window where server/botPopulation.js botTarget is 101 at every second), so the bot driver fills to 101 snakes
// minus the seated wanderers. The wanderers (scripts/slLoad.js, forked) join over long-polling and WebSocket, each from
// its own X-Forwarded-For address.
//
// Measured and checked:
//   every step       scripts/slSoakCheck.js through the room's bot driver hooks (no NaN, the L38 border rule, the
//                    length ledger, death drops, food and prey totals, id quarantine)
//   every second     the full store recount (sim.check)
//   3 sampled seats  the client mirror on the server side of their sockets (every inserted point, every move, fam on
//                    grows, 0 snake ghosts after every bundle, 0 food and prey ghosts about every 0.7 s), plus one
//                    forced resync of a sampled seat a minute, whose bundle is measured against C_PENDING_CAP
//   all wanderers    every bundle decoded (no wire_error, no kind-15 or off-grid number, no unknown id, foods by cell)
//   resume blips     15 percent of lives go deaf (bundles lost) and come back with sl:back inside the glide, half
//                    with the old socket dropped (parked), half with it left open (taken over); every one must come
//                    back, and the resumed lives' streams go through the same strict client model (slLoad.js)
//   timing           each wake's synchronous room time (its sim steps and seat slices, the harness's own time taken
//                    out), each step's sim time, wake lateness, dropped steps, event-loop delay, CPU, GC
//   heap             heapUsed after two forced full GCs at minute 5 and at the end (--expose-gc)
//
// Usage: node scripts/slSoak.js [--minutes 30] [--clients 30] [--polling 0.5] [--seed 1] [--heap-at 5] [--governor real]
//        --governor shadow: the room's governor never acts; a twin gets the same samples and is reported (a box whose
//        CPU is throttled, on battery, cannot hold the curve peak with the real one; the soak's bars are about the
//        server at the peak).
//        [--out ../slither-reference/recordings/OURS-SOAK.md]
// Exit code 1 when any bar fails.

const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const { fork, spawnSync } = require('child_process');
const { performance, monitorEventLoopDelay, PerformanceObserver } = require('perf_hooks');

if (typeof global.gc !== 'function') {
  const r = spawnSync(process.execPath, ['--expose-gc', __filename].concat(process.argv.slice(2)), { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

const { botTarget } = require('../server/botPopulation');
const { LAWS, SOAK_PEAK } = require('./slSoakLaws');
const { createSoakCheck, createInsertLog, createSeatMirror, createFailures, hookRoom } = require('./slSoakCheck');
const { createHist } = require('./slLoad');
const { createBotGovernor } = require('../server/sl/slBots');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const MINUTES = Number(arg('minutes', '30'));
const CLIENTS = Number(arg('clients', '30'));
const POLLING = Number(arg('polling', '0.5'));
const SEED = Number(arg('seed', '1'));
const HEAP_AT_MIN = Number(arg('heap-at', '5'));
const GOV_MODE = arg('governor', 'real');
if (GOV_MODE !== 'real' && GOV_MODE !== 'shadow') throw new Error('slSoak: --governor is real or shadow');
const OUT = arg('out', '');
const MIRRORS = 3; // SERVER-BUILD-BRIEF 1.2: "mirror equal for 3 sampled seats"
const FULL_EVERY_MS = 1000;
const RESYNC_EVERY_MS = 60000;
const PROGRESS_MS = 60000;
const P = LAWS.L7.value;
const PENDING_CAP = LAWS.C_PENDING_CAP.value;
const HEAP_BAR = 0.10; // SERVER-BUILD-BRIEF 1.2: heap at the end within 10 percent of minute 5

// server/index.js:69-75, copied (index.js cannot be required without booting the whole server)
function socketRL(socket, key, minMs) {
  const now = Date.now();
  if (!socket._rl) socket._rl = {};
  if (socket._rl[key] && now - socket._rl[key] < minMs) return false;
  socket._rl[key] = now;
  return true;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// The first wall time at or after 2026-10-10 00:00 UTC (20:00 ET) where botTarget is the peak at every second of the
// run plus two minutes.
function findPeak(minutes) {
  const need = (minutes + 2) * 60000;
  let t = Date.UTC(2026, 9, 10, 0, 0, 0);
  const end = Date.UTC(2027, 0, 1);
  for (; t < end; t += 60000) {
    let ok = true;
    for (let u = t; u < t + need; u += 1000) {
      if (botTarget(u) !== SOAK_PEAK) {
        ok = false;
        break;
      }
    }
    if (ok) return t;
  }
  throw new Error('slSoak: no window at the curve peak');
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const mb = (b) => Math.round(b / 1048576 * 10) / 10;

async function main() {
  const git0 = gitState(); // the code this process loads now
  const power0 = powerState();
  const port = await freePort();
  const peakWall = findPeak(MINUTES);
  const realStart = Date.now();
  const wallNow = () => peakWall + (Date.now() - realStart);

  // ---- the server
  const { Server } = require('socket.io');
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const io = new Server(server, { pingInterval: 5000, pingTimeout: 10000 });
  // The wanderers connect on /sl-io/, the page's path for a free socket; served here as server/index.js serves it
  // while the server is not split (its alias of /socket.io/).
  const ioOpts = require('../server/ioOptions');
  ioOpts.installPathAlias(server, ioOpts.SL_IO_PATH, '/socket.io/');
  const logLines = [];
  const log = {
    log: (...a) => logLines.push('log ' + a.join(' ')),
    warn: (...a) => logLines.push('warn ' + a.join(' ')),
    error: (...a) => logLines.push('error ' + a.join(' ')),
  };
  const slBoot = require('../server/sl/slBoot');
  const opened = slBoot.openSl({
    env: { SL_ENABLED: '1', SL_DEV_LAWS: path.join(__dirname, 'slSoakLaws.js') },
    io, region: 'na', seed: SEED, now: wallNow, log,
    helpers: { socketRL, ops: require('../server/ops'), notifyJoin() {}, paidLoad: () => ({ paidPlayers: 0, paid: [] }) },
  });
  if (!opened.arenas) throw new Error('slSoak: /sl did not open: ' + opened.why + '\n' + logLines.join('\n'));
  const arenas = opened.arenas;
  const room = arenas.room();

  // The bot governor runs for real (slBoot's 1 Hz sample: loop delay p99 above this process's own idle floor, the
  // room's largest slice; commit f27a296 made it fill on Windows, where the old raw p99 sat on the 15.6 ms timer
  // step). It is only watched here: its inputs and every transition are recorded, its result is returned unchanged.
  const gov = arenas.governor;
  const twin = gov && GOV_MODE === 'shadow' ? createBotGovernor(LAWS) : null;
  const judge = twin || gov; // the governor whose state is reported
  const govLog = [];
  const govIn = { loopMax: 0, sliceMax: 0, samples: 0 };
  if (gov) {
    const realSample = gov.sample;
    gov.sample = function watched(nowMs, inp) {
      const r = twin ? twin.sample(nowMs, inp) : realSample.call(this, nowMs, inp);
      govIn.samples++;
      if (inp.loopP99Ms > govIn.loopMax) govIn.loopMax = inp.loopP99Ms;
      if (inp.sliceMaxMs > govIn.sliceMax) govIn.sliceMax = inp.sliceMaxMs;
      if (r && govLog.length < 40) {
        govLog.push({ atS: Math.round((Date.now() - realStart) / 1000), result: r, loopP99Ms: r2(inp.loopP99Ms),
          sliceMaxMs: r2(inp.sliceMaxMs), mult: r2(judge.mult()) });
      }
      return twin ? null : r;
    };
  }
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  // ---- the checks on the room
  const check = createSoakCheck(LAWS);
  const inserts = createInsertLog();
  const mfails = createFailures();
  const mstats = { bundles: 0, events: 0, adds: 0, removes: 0, moves: 0, exactMoves: 0, offsetMoves: 0, maxOffset: 0,
    maxDrift: 0, grows: 0, ghostChecks: 0, foodGhostChecks: 0, behindBundles: 0 };
  let mirrorMs = 0;
  const harnessMs = () => check.hookMs() + inserts.hookMs() + mirrorMs;
  const snakeCount = createHist(1, 400, true);
  const botCount = createHist(1, 400, true);
  let stepsAtPeak = 0;
  let stepsSeen = 0;
  hookRoom(room, {
    check, inserts,
    onAfterStep(r) {
      const n = r.sim.count();
      stepsSeen++;
      if (n === SOAK_PEAK) stepsAtPeak++;
      snakeCount.add(n);
      botCount.add(arenas.driver ? arenas.driver.count() : 0);
    },
  });

  // ---- timing: each wake's synchronous room time, each step's sim time, lateness (the harness's own time taken out)
  const proto = Object.getPrototypeOf(room);
  const jobMs = new WeakMap();
  const wakeHist = createHist(0.05, 500);
  const stepHist = createHist(0.05, 500);
  const lateHist = createHist(0.5, 5000);
  let wakeMin = createHist(0.05, 500); // this minute (the timeline)
  const stepsPerWake = {};
  let wakesOverHalfP = 0;
  room._runJob = function runJob(sync) {
    const job = this._job;
    const t0 = performance.now();
    const h0 = harnessMs();
    try {
      return proto._runJob.call(this, sync);
    } finally {
      const d = performance.now() - t0 - (harnessMs() - h0);
      if (job) {
        const total = (jobMs.get(job) || 0) + d;
        jobMs.set(job, total);
        if (this._job !== job) {
          wakeHist.add(total);
          wakeMin.add(total);
          if (total > P / 2) wakesOverHalfP++;
          stepsPerWake[job.ran] = (stepsPerWake[job.ran] || 0) + 1;
        }
      }
    }
  };
  // The governor's slice input (room.stats.maxSliceMs, written in _noteSlice from the slice's start, at a yield and at
  // a wake's end) without the harness's own time inside that slice (the step checks and the mirrors run synchronously
  // in the room's slices): the same correction as the wake and step numbers. Only the recorded length changes; when
  // the room yields does not.
  let harnessAtSlice = 0;
  room._jobBody = function jobBody(job, sync) {
    harnessAtSlice = harnessMs();
    return proto._jobBody.call(this, job, sync);
  };
  room._noteSlice = function noteSlice(sliceStart) {
    return proto._noteSlice.call(this, sliceStart + (harnessMs() - harnessAtSlice));
  };
  room._simStep = function simStep(job) {
    const t0 = performance.now();
    const h0 = harnessMs();
    proto._simStep.call(this, job);
    stepHist.add(performance.now() - t0 - (harnessMs() - h0));
  };
  // the room's own kick reasons (stall, cap, dead, ...), by name
  const kickWhy = {};
  room._onKick = function onKick(seat, reason) {
    kickWhy[reason] = (kickWhy[reason] || 0) + 1;
    return proto._onKick.call(this, seat, reason);
  };
  room.wake = function wake() {
    if (Number.isFinite(this._dueAt)) lateHist.add(this.clock() - this._dueAt);
    return proto.wake.call(this);
  };

  // ---- the sampled seats' mirrors and the bundle sizes
  const joinBytes = createHist(64, 262144);
  const resyncBytes = createHist(64, 262144);
  const backBytes = createHist(64, 262144); // the first bundle on a resume socket (replay, removals, re-adds)
  let backSockets = 0;
  const resyncs = [];
  const mirrors = new Map(); // socket -> { m, resyncPending }
  let mirroredLives = 0;
  const nsp = io.of('/sl');
  nsp.on('connection', (sock) => {
    let first = true;
    let entry = null;
    if (mirrors.size < MIRRORS) {
      const behind = () => {
        const seat = room.seats.get(sock.id);
        return !!seat && room._seatPending(seat);
      };
      const m = createSeatMirror(LAWS, inserts, () => arenas.room().sim, { fails: mfails, stats: mstats, behind });
      entry = { m, resyncPending: false };
      mirrors.set(sock, entry);
      mirroredLives++;
      sock.on('disconnect', () => mirrors.delete(sock));
    }
    // A resume socket (sl:back, task T16b) carries a life from its middle: a mirror built from a join cannot follow it
    // (the old socket's mirror saw the bundles the client lost), so it is not mirrored; its client still checks every
    // bundle. onAny runs as the packet arrives, before the room answers on this socket.
    sock.onAny((ev) => {
      if (ev !== 'sl:back' || !first) return;
      first = false;
      backSockets++;
      sock._slBack = true;
      if (entry) {
        mirrors.delete(sock);
        mirroredLives--;
        entry = null;
      }
    });
    const emit = sock.emit;
    sock.emit = function tapped(name, data, ...rest) {
      if (name === 'sl:f') {
        const t0 = performance.now();
        const len = data && data.length !== undefined ? data.length : data.byteLength;
        if (first) {
          first = false;
          joinBytes.add(len);
        } else if (sock._slBack === true) {
          sock._slBack = false;
          backBytes.add(len);
        }
        if (entry) {
          if (entry.resyncPending) {
            entry.resyncPending = false;
            resyncBytes.add(len);
            resyncs.push(len);
          }
          try {
            const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
            entry.m.onBundle(u8);
          } catch (e) {
            mfails.add('mirrorThrow', e && e.stack);
          }
        }
        mirrorMs += performance.now() - t0;
      }
      return emit.call(this, name, data, ...rest);
    };
  });

  // A forced resync of one sampled seat (exactly the room's own branch, slRoom.js _seatPart), between wakes: the next
  // bundle it gets is the resync bundle (removals, then the re-adds of everything in view).
  function forceResync() {
    if (room._job) return false;
    for (const [sock, entry] of mirrors) {
      const seat = room.seats.get(sock.id);
      if (!seat || seat.closed || seat.dead || !room.sim.snake(seat.snakeId)) continue;
      const tick = room.sim.tick();
      const now = room.clock();
      seat.queue.resync(tick, now);
      room.stats.resyncs++;
      seat.view.resync();
      const again = seat.view.collect({ tick, simMs: room.sim.nowMs(), flux: room.sim.flux(), frames: [], dead: seat.dead });
      room._pushEvents(seat, tick, again);
      entry.resyncPending = true;
      seat.queue.flush(room.clock());
      return true;
    }
    return false;
  }

  // ---- process measures
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const loopMin = monitorEventLoopDelay({ resolution: 10 });
  loopMin.enable();
  let gcMs = 0;
  let gcMajor = 0;
  const gcObs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      gcMs += e.duration;
      if (e.detail && e.detail.kind === 4) gcMajor++;
    }
  });
  gcObs.observe({ entryTypes: ['gc'] });
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();

  function heapNow() {
    global.gc();
    global.gc();
    return process.memoryUsage().heapUsed;
  }

  // ---- the wanderers
  const child = fork(path.join(__dirname, 'slLoad.js'), ['--ipc', '--url', 'http://127.0.0.1:' + port, '--clients',
    String(CLIENTS), '--polling', String(POLLING), '--seed', String(SEED), '--minutes', '0', '--path', ioOpts.SL_IO_PATH],
  { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let lastClient = null;
  let finalClient = null;
  child.on('message', (m) => {
    if (m && m.type === 'progress') lastClient = m.report;
    if (m && m.type === 'report') finalClient = m.report;
  });
  const childExit = new Promise((resolve) => child.on('exit', resolve));

  // ---- timers
  const fullTimer = setInterval(() => check.full(arenas.room().sim), FULL_EVERY_MS);
  const resyncTimer = setInterval(() => {
    // between wakes: try now, then on the next turns until no sliced job is running
    let tries = 0;
    const go = () => {
      if (!forceResync() && room._job && tries++ < 20) setImmediate(go);
    };
    go();
  }, RESYNC_EVERY_MS);
  const timeline = [];
  let heapAt5 = null;
  const heapSamples = [];
  const progressTimer = setInterval(() => {
    child.send({ cmd: 'progress' });
    const minute = Math.round((performance.now() - t0) / 60000);
    const row = {
      minute, snakes: room.sim.count(), humans: arenas.humanTotal(), bots: arenas.botTotal(),
      food: room.sim.grid.foodTotal(), prey: room.sim.preys ? room.sim.preys.stats().live : 0,
      wakeP99: r2(wakeMin.pct(0.99)), wakeMax: r2(wakeMin.max), loopP99: r1(loopMin.percentile(99) / 1e6),
      heapMB: mb(process.memoryUsage().heapUsed), gov: judge ? r2(judge.mult()) : null,
      loopRaw: arenas.lastSample && arenas.lastSample.loopRawP99Ms !== null ? r1(arenas.lastSample.loopRawP99Ms) : null,
      loopFloor: arenas.lastSample && arenas.lastSample.loopFloorMs !== null ? r1(arenas.lastSample.loopFloorMs) : null,
      checkFails: check.fails.total(), mirrorFails: mfails.total(),
      clientFails: lastClient ? lastClient.failures : 0, kicks: lastClient ? lastClient.kickTotal : 0,
      drops: lastClient ? lastClient.dropTotal : 0,
    };
    timeline.push(row);
    loopMin.reset();
    wakeMin = createHist(0.05, 500);
    console.log('[slSoak] ' + JSON.stringify(row));
  }, PROGRESS_MS);
  const heapTimer = setTimeout(() => {
    heapAt5 = heapNow();
    heapSamples.push({ minute: HEAP_AT_MIN, heapUsed: heapAt5 });
    console.log('[slSoak] heap at minute ' + HEAP_AT_MIN + ': ' + mb(heapAt5) + ' MB');
  }, HEAP_AT_MIN * 60000);

  await new Promise((resolve) => setTimeout(resolve, MINUTES * 60000));

  // ---- the end: heap at full load first, then the clients stop
  const heapEnd = heapNow();
  heapSamples.push({ minute: MINUTES, heapUsed: heapEnd });
  const wallMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const loopP = { p50: r2(loop.percentile(50) / 1e6), p99: r2(loop.percentile(99) / 1e6), max: r2(loop.max / 1e6) };
  clearInterval(fullTimer);
  clearInterval(resyncTimer);
  clearInterval(progressTimer);
  clearTimeout(heapTimer);
  check.full(arenas.room().sim);
  // (no ghost walk here: a seat may still have records queued; the walks inside the emit taps see the whole queue)
  const roomStats = Object.assign({}, room.stats);
  const arenaStats = arenas.stats();
  const cs = check.stats();
  const checkFails = { total: check.fails.total(), by: Object.assign({}, check.fails.by), samples: check.fails.samples.slice() };
  const mirrorFails = { total: mfails.total(), by: Object.assign({}, mfails.by), samples: mfails.samples.slice() };
  const mirrorStats = Object.assign({ lives: mirroredLives }, mstats);
  child.send({ cmd: 'stop' });
  await Promise.race([childExit, new Promise((r) => setTimeout(r, 30000))]);
  if (!finalClient) finalClient = lastClient;
  gcObs.disconnect();
  arenas.close();
  io.close();
  server.close();

  // ---- the bars
  const client = finalClient || { failures: -1, kickTotal: -1, refusalTotal: -1, fail: {}, samples: ['no client report'] };
  let liveKicks = 0;
  for (const k of Object.keys(kickWhy)) if (k !== 'dead') liveKicks += kickWhy[k];
  const heapDelta = heapAt5 ? (heapEnd - heapAt5) / heapAt5 : NaN;
  const botsMinRow = timeline.length ? Math.min(...timeline.map((r) => r.bots)) : 0;
  const res = client.resume || { started: {}, back: {}, fails: {}, lives: 0, failures: -1, bundles: 0 };
  const kinds = ['parked', 'takeover'];
  const bars = [
    ['every step checked', cs.steps === roomStats.steps && cs.steps > 0, cs.steps + ' of ' + roomStats.steps + ' steps'],
    ['0 server invariant failures', checkFails.total === 0, checkFails.total + ' ' + JSON.stringify(checkFails.by)],
    ['0 mirror failures (3 sampled seats)', mirrorFails.total === 0 && mirrorStats.moves > 0, mirrorFails.total + ' ' + JSON.stringify(mirrorFails.by)],
    ['0 client stream failures (every bundle of every wanderer)', client.failures === 0, client.failures + ' ' + JSON.stringify(client.fail)],
    ['every resume blip came back inside the glide, parked and taken over', kinds.every((k) => res.back[k] > 0) &&
      Object.keys(res.fails).length === 0,
      'started ' + JSON.stringify(res.started) + ', back ' + JSON.stringify(res.back) + ' (a blip still away at the stop is neither), failed ' +
      JSON.stringify(res.fails) + '; away ms ' + JSON.stringify(res.awayMs) + '; the room: ' + roomStats.parks + ' parks, ' +
      roomStats.takeovers + ' takeovers, ' + roomStats.backs + ' backs (' + roomStats.backsDead + ' after the snake died), refused ' +
      JSON.stringify(roomStats.backsRefused)],
    ['0 stream failures on the resumed lives (no snake or prey removed or moved that the client never got)', res.lives > 0 &&
      res.failures === 0, res.failures + ' in ' + res.lives + ' resumed lives (' + res.bundles + ' bundles)'],
    ['0 kicks of a live seat and 0 refusals', client.kickTotal === 0 && liveKicks === 0 && client.refusalTotal === 0,
      'the room kicked ' + JSON.stringify(kickWhy) + ' (dead: a dead seat with no ping for C_DEAD_SEAT_MS, the designed close); the wanderers saw kicks ' +
      JSON.stringify(client.kicks) + ', refusals ' + JSON.stringify(client.refusals)],
    ['0 dropped connections on a clean local link', client.dropTotal === 0,
      'drops ' + JSON.stringify(client.drops) + ', failed reconnects ' + client.connectErrors],
    ['0 failed wakes, 0 caught throws, the room never replaced', roomStats.failedWakes === 0 && arenaStats.replaced === 0 &&
      room.safeStats.total === 0 && arenaStats.safe.total === 0,
      'failedWakes ' + roomStats.failedWakes + ', replaced ' + arenaStats.replaced + ', room throws ' + room.safeStats.total +
      ', arenas throws ' + arenaStats.safe.total],
    ['heap at the end within 10 percent of minute ' + HEAP_AT_MIN, Number.isFinite(heapDelta) && Math.abs(heapDelta) <= HEAP_BAR,
      mb(heapAt5 || 0) + ' MB to ' + mb(heapEnd) + ' MB (' + (100 * heapDelta).toFixed(1) + ' percent)'],
    ['bots in the room at every minute (the governor ' + (twin ? 'in shadow mode' : 'on') + ')', timeline.length > 0 && botsMinRow > 0 && botCount.count > 0,
      'bots per step mean ' + r1(botCount.sum / Math.max(1, botCount.count)) + ', max ' + botCount.max + '; fewest at a minute row ' +
      botsMinRow + '; governor mult at the end ' + (judge ? r2(judge.mult()) : 'none') + ', ' + (judge ? judge.stats().engagements : 0) + ' engagements'],
  ];
  const ok = bars.every((b) => b[1]);
  const summary = {
    ok, minutes: MINUTES, clients: CLIENTS, polling: POLLING, seed: SEED, port, peakWall: new Date(peakWall).toISOString(),
    wallMs: Math.round(wallMs), P,
    bars: bars.map((b) => ({ bar: b[0], pass: b[1], value: b[2] })),
    check: cs, checkSamples: checkFails.samples,
    mirror: mirrorStats, mirrorSamples: mirrorFails.samples,
    timing: {
      wakeMs: wakeHist.json(), stepMs: stepHist.json(), lateMs: lateHist.json(), wakesOverHalfP, stepsPerWake,
      droppedSteps: roomStats.droppedSteps, maxSliceEverMs: r2(arenaStats.maxSliceEverMs),
      harnessMs: Math.round(harnessMs()),
    },
    loopMs: loopP,
    cpu: { userS: r1(cpu.user / 1e6), systemS: r1(cpu.system / 1e6), shareOfOneCore: r2((cpu.user + cpu.system) / 1000 / wallMs) },
    gc: { ms: Math.round(gcMs), shareOfWall: r2(gcMs / wallMs * 100) / 100, major: gcMajor },
    heap: { at5MB: mb(heapAt5 || 0), endMB: mb(heapEnd), deltaPct: r2(100 * heapDelta), samples: heapSamples.map((h) => ({ minute: h.minute, mb: mb(h.heapUsed) })) },
    snakes: { mean: r1(snakeCount.sum / Math.max(1, snakeCount.count)), min: snakeCount.pct(0), p50: snakeCount.pct(0.5),
      max: snakeCount.max, atPeakShare: r2(stepsAtPeak / Math.max(1, stepsSeen)) },
    bots: { mean: r1(botCount.sum / Math.max(1, botCount.count)), max: botCount.max },
    governor: { mode: GOV_MODE, stats: judge ? judge.stats() : null, mult: judge ? r2(judge.mult()) : null, last: arenas.lastSample,
      inputs: { samples: govIn.samples, loopP99MaxMs: r2(govIn.loopMax), sliceMaxMs: r2(govIn.sliceMax) }, log: govLog },
    botDriver: arenaStats.botDriver ? {
      adds: arenaStats.botDriver.adds, removes: arenaStats.botDriver.removes, blocked: arenaStats.botDriver.blocked,
      forced: arenaStats.botDriver.forced } : null,
    room: Object.assign({ kickWhy }, roomStats),
    bundles: { joinBytes: joinBytes.json(), resyncBytes: resyncBytes.json(), resyncs: resyncs.length, pendingCap: PENDING_CAP,
      backBytes: backBytes.json(), backSockets },
    client, timeline, log: logLines.slice(0, 40),
    git: git0,
    machine: { node: process.version, platform: process.platform + ' ' + os.release(), cpu: os.cpus()[0].model, cores: os.cpus().length,
      memGB: Math.round(os.totalmem() / 1073741824), power: { start: power0, end: powerState() } },
  };
  console.log(JSON.stringify(summary.bars, null, 1));
  if (OUT) {
    fs.writeFileSync(OUT, report(summary));
    console.log('[slSoak] wrote ' + OUT);
  }
  fs.writeFileSync(path.join(os.tmpdir(), 'slSoak-last.json'), JSON.stringify(summary, null, 1));
  process.exit(ok ? 0 : 1);
}

// AC or battery (Windows; a laptop on battery throttles its CPU). Never fatal.
function powerState() {
  if (process.platform !== 'win32') return 'unknown';
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object -First 1).PowerOnline'],
  { encoding: 'utf8', timeout: 15000 });
  const v = r.status === 0 ? String(r.stdout).trim() : '';
  return v === 'True' ? 'AC' : v === 'False' ? 'battery' : 'unknown';
}

// The code the soak ran: HEAD and any uncommitted server/sl or shared file (other tasks work in the same tree).
function gitState() {
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  const dirty = run(['status', '--porcelain', '--', 'server/sl', 'shared']).split(/\r?\n/).filter(Boolean).map((l) => l.trim());
  return { head: run(['rev-parse', '--short', 'HEAD']), dirty };
}

// ---------------------------------------------------------------------------------------------------------------
// The report (plain words, numbers by name)

function report(s) {
  const L = [];
  const c = s.client;
  const t = s.timing;
  L.push('# OURS-SOAK: the local 30-minute soak of our /sl server (task T15)');
  L.push('');
  L.push('Written by `slither-clone/scripts/slSoak.js` on ' + new Date().toISOString() + '. ' + (s.ok ? 'ALL BARS PASS.' : 'A BAR FAILED.'));
  L.push('Local only: one process served /sl, a second process played the wanderers. No load test, no remote server.');
  L.push('');
  L.push('## Setup');
  L.push('');
  L.push('- Machine: ' + s.machine.cpu + ', ' + s.machine.cores + ' logical cores, ' + s.machine.memGB + ' GB, ' + s.machine.platform + ', node ' + s.machine.node + '.');
  L.push('- Server: the real boot path (`server/sl/slBoot.js` openSl, `SL_ENABLED=1`), socket.io with the index.js options (ping 5000 / 10000 ms).');
  L.push('- Law table: `scripts/slSoakLaws.js` = the shipped table, with C_ROOM_CAP and C_HUMAN_CAP set to the curve peak ' + SOAK_PEAK + ' (the load test sets the real ones), and the five SUGGESTED prey rows approved (Owen 2026-10-10), so prey ran.');
  L.push('- Curve peak: the wall clock was shifted to ' + s.peakWall + ' (20:00 ET), where `botTarget` is ' + SOAK_PEAK + ' at every second of the run.');
  L.push('- Wanderers: ' + s.clients + ' (' + Math.round(s.polling * s.clients) + ' long-polling, the rest WebSocket), each from its own address; seed ' + s.seed + '.');
  L.push(s.governor.mode === 'shadow'
    ? '- Bot governor: SHADOW mode (--governor shadow). The room governor never acts; a twin gets the same samples (loop delay p99 at 1 ms resolution above the process idle floor, and the room largest slice without the harness time) and is reported below. So this PASS is the server at the curve peak with the governor watching only: the real-governor configuration is NOT proven by it and stays unproven until the Linux load test.'
    : '- Bot governor: ON, the real one (slBoot 1 Hz sample: loop delay p99 at 1 ms resolution above the process idle floor, and the room largest slice without the harness time; commit f27a296). The soak only watches it (inputs and transitions below).');
  L.push('- Power: ' + s.machine.power.start + ' at the start, ' + s.machine.power.end + ' at the end (on battery this laptop runs its CPU at about 1.85 GHz).');
  L.push('- Wanderer HTTP: each long-polling wanderer keeps its connections open between requests (keep-alive, as a browser does).');
  L.push('- Code: HEAD ' + s.git.head + (s.git.dirty.length ? ', with uncommitted changes from other tasks in ' + s.git.dirty.join('; ') : ', clean') + '.');
  L.push('- Length: ' + s.minutes + ' minutes (' + Math.round(s.wallMs / 1000) + ' s of wall time). L7 period P = ' + s.P + ' ms.');
  L.push('');
  L.push('## Bars');
  L.push('');
  L.push('| Bar | Result | Numbers |');
  L.push('|---|---|---|');
  for (const b of s.bars) L.push('| ' + b.bar + ' | ' + (b.pass ? 'PASS' : 'FAIL') + ' | ' + String(b.value).replace(/\|/g, '/') + ' |');
  L.push('');
  L.push('## Tick time');
  L.push('');
  L.push('| Measure | p50 | p99 | max | n |');
  L.push('|---|---|---|---|---|');
  L.push('| Wake (all due steps plus the seat part, synchronous ms) | ' + t.wakeMs.p50 + ' | ' + t.wakeMs.p99 + ' | ' + t.wakeMs.max + ' | ' + t.wakeMs.n + ' |');
  L.push('| One sim step (ms) | ' + t.stepMs.p50 + ' | ' + t.stepMs.p99 + ' | ' + t.stepMs.max + ' | ' + t.stepMs.n + ' |');
  L.push('| Wake lateness after its timer was due (ms) | ' + t.lateMs.p50 + ' | ' + t.lateMs.p99 + ' | ' + t.lateMs.max + ' | ' + t.lateMs.n + ' |');
  L.push('| Event-loop delay (ms, resolution 10) | ' + s.loopMs.p50 + ' | ' + s.loopMs.p99 + ' | ' + s.loopMs.max + ' | |');
  L.push('');
  L.push('- Wake p99 ' + t.wakeMs.p99 + ' ms is ' + (100 * t.wakeMs.p99 / s.P).toFixed(1) + ' percent of P. The load test bar (on the test server, SERVER-BUILD-BRIEF 1.2) is under 50 percent of P (' + (s.P / 2).toFixed(2) + ' ms); ' + t.wakesOverHalfP + ' wakes went over it here.');
  L.push('- Steps per wake: ' + JSON.stringify(t.stepsPerWake) + '; dropped steps ' + t.droppedSteps + '; largest synchronous slice ' + t.maxSliceEverMs + ' ms (the governor input).');
  L.push('- The harness\'s own time (checks, insert log, mirrors: ' + t.harnessMs + ' ms in all) is taken out of the wake and step numbers.');
  L.push('- Process CPU: ' + s.cpu.userS + ' s user + ' + s.cpu.systemS + ' s system = ' + s.cpu.shareOfOneCore + ' of one core (server process, harness included). GC ' + s.gc.ms + ' ms (' + (100 * s.gc.shareOfWall).toFixed(2) + ' percent of wall time), ' + s.gc.major + ' major.');
  L.push('');
  L.push('## Heap');
  L.push('');
  L.push('heapUsed after two forced full GCs: ' + s.heap.samples.map((h) => 'minute ' + h.minute + ' ' + h.mb + ' MB').join(', ') + '; change ' + s.heap.deltaPct + ' percent (bar: within 10).');
  L.push('');
  L.push('## The room');
  L.push('');
  L.push('- Snakes per step: mean ' + s.snakes.mean + ', median ' + s.snakes.p50 + ', min ' + s.snakes.min + ', max ' + s.snakes.max + '; ' + (100 * s.snakes.atPeakShare).toFixed(1) + ' percent of steps at exactly ' + SOAK_PEAK + '. Bots mean ' + s.bots.mean + ', max ' + s.bots.max + '.');
  L.push('- Governor (' + (s.governor.mode === 'shadow' ? 'shadow twin' : 'real') + ', see Setup): ' + s.governor.inputs.samples + ' samples (largest loop p99 input above the floor ' + s.governor.inputs.loopP99MaxMs + ' ms, largest slice ' + s.governor.inputs.sliceMaxMs + ' ms); ended at mult ' + s.governor.mult + ', ' + JSON.stringify(s.governor.stats) + '; last sample ' + JSON.stringify(s.governor.last) + '; transitions ' + JSON.stringify(s.governor.log.slice(0, 12)) + '. Bot fill: ' + JSON.stringify(s.botDriver) + '.');
  const rs = s.room;
  L.push('- Room: ' + rs.steps + ' steps, ' + rs.joins + ' joins, ' + rs.leaves + ' leaves, ' + rs.deaths + ' deaths, ' + rs.cashouts + ' cash-outs, ' + rs.glides + ' glides (' + rs.glideDeaths + ' ended in death), ' + rs.resyncs + ' resyncs, ' + rs.kicks + ' kicks ' + JSON.stringify(rs.kickWhy) + ', ' + rs.killLines + ' kill lines, ' + rs.chats + ' chats, ' + rs.inputs + ' inputs, ' + rs.pongs + ' pongs, ' + rs.echoes + ' echoes.');
  const k = s.check;
  L.push('- Checked every step: ' + k.snakeSteps + ' snake updates, ' + k.eatsFood + ' food eats and ' + k.eatsPrey + ' prey eats replayed exactly, ' + k.charges + ' charges, ' + k.boostDrops + ' boost drops, ' + k.grows + ' grows, ' + k.deaths + ' deaths (' + k.borderDeaths + ' at the border) with ' + k.deathDrops + ' drops, ' + k.newIds + ' new ids (' + k.reusedIds + ' reused after quarantine), ' + k.fullChecks + ' full store recounts. Longest snake ' + k.maxSct + ' points; most food ' + k.maxFood + '; most prey ' + k.maxPrey + '.');
  L.push('- Death drop value over the victim\'s length (sct + fam): mean ' + r2(k.shareMean) + ', min ' + r2(k.shareMin) + ', max ' + r2(k.shareMax) + ' (exactly (2 sct + 1) K18 b(sct)^2 by L39; SERVER-LAWS reported 1.061 for their length mix).');
  L.push('');
  L.push('## The mirrored seats (3 at a time)');
  L.push('');
  const m = s.mirror;
  L.push('- ' + m.lives + ' lives mirrored, ' + m.bundles + ' bundles, ' + m.moves + ' moves rebuilt with the client arithmetic: ' + m.exactMoves + ' exact (held since spawn), ' + m.offsetMoves + ' at a constant offset (largest ' + m.maxOffset + ', bar 0.25; drift at most ' + m.maxDrift + '), ' + m.grows + ' grow fams, ' + m.ghostChecks + ' snake ghost checks, ' + m.foodGhostChecks + ' food and prey ghost walks; ' + m.behindBundles + ' bundles went out between the slices of a wake before that seat had its turn (a long-polling GET flushes the queue on the transport ready event), the ghost checks skipped those.');
  L.push('- Forced resyncs (one a minute, the room\'s own branch): ' + s.bundles.resyncs + '; resync bundle bytes ' + JSON.stringify(s.bundles.resyncBytes) + '. Join bundle bytes ' + JSON.stringify(s.bundles.joinBytes) + '. C_PENDING_CAP is ' + s.bundles.pendingCap + ' bytes.');
  L.push('- Resume sockets (sl:back) are not mirrored: ' + s.bundles.backSockets + ' of them; the first bundle on each (the replay, the removals, the re-adds) bytes ' + JSON.stringify(s.bundles.backBytes) + '.');
  L.push('');
  L.push('## The wanderers (client side)');
  L.push('');
  L.push('- ' + c.lives + ' lives, ' + c.joins + ' joins, ' + c.deaths + ' deaths, ' + c.cashouts + ' cash-outs, ' + c.holds + ' holds (' + c.releases + ' let go), ' + c.blips + ' blips, ' + c.leaves + ' leaves, ' + c.chats + ' chats, ' + c.diags + ' diags.');
  L.push('- ' + c.bundles + ' bundles (' + mb(c.bytes) + ' MB, ' + c.events + ' events) decoded; failures ' + c.failures + ' ' + JSON.stringify(c.fail) + '; kicks ' + JSON.stringify(c.kicks) + '; dropped connections ' + JSON.stringify(c.drops) + ' (failed reconnects ' + c.connectErrors + '); refusals ' + JSON.stringify(c.refusals) + '; server closes after an end ' + JSON.stringify(c.serverClosed) + '.');
  L.push('- Pong round trip ms ' + JSON.stringify(c.rttMs) + '; gap between bundles ms ' + JSON.stringify(c.gapMs) + '; life seconds ' + JSON.stringify(c.lifeS) + '.');
  L.push('- Inputs sent: ' + JSON.stringify(c.inputs) + '; layer messages received: ' + JSON.stringify(c.layer) + '.');
  const cr = c.resume || {};
  L.push('- Resume blips (deaf from the blip on: every later bundle lost, nothing sent; parked: the old socket dropped 0.3 to 1 s later with no sl:leave, sl:back 0.3 to 1.5 s after that; taken over: the old socket left open, sl:back 1 to 2.5 s after the blip): started ' + JSON.stringify(cr.started) + ', back ' + JSON.stringify(cr.back) + ', failed ' + JSON.stringify(cr.fails) + '; away ms ' + JSON.stringify(cr.awayMs) + '; ' + cr.lives + ' resumed lives, ' + cr.bundles + ' bundles on them, ' + cr.failures + ' stream failures on them (the same strict client model as every bundle: init once, every snake and prey id held, no double add, foods by cell).');
  L.push('- The room: ' + s.room.parks + ' parks, ' + s.room.takeovers + ' takeovers, ' + s.room.backs + ' backs (' + s.room.backsDead + ' after the snake died), refused ' + JSON.stringify(s.room.backsRefused) + '; ' + s.room.glides + ' glides, ' + s.room.glideDeaths + ' glide deaths.');
  L.push('');
  L.push('## Timeline (one row a minute)');
  L.push('');
  L.push('| min | snakes | humans | bots | food | prey | wake p99 | wake max | loop p99 | governor raw / floor | heap MB (no GC) | governor mult | fails (check/mirror/client) | kicks | drops |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of s.timeline) {
    L.push('| ' + r.minute + ' | ' + r.snakes + ' | ' + r.humans + ' | ' + r.bots + ' | ' + r.food + ' | ' + r.prey + ' | ' + r.wakeP99 + ' | ' + r.wakeMax + ' | ' + r.loopP99 + ' | ' + r.loopRaw + ' / ' + r.loopFloor + ' | ' + r.heapMB + ' | ' + r.gov + ' | ' + r.checkFails + '/' + r.mirrorFails + '/' + r.clientFails + ' | ' + r.kicks + ' | ' + r.drops + ' |');
  }
  if (s.checkSamples.length || s.mirrorSamples.length || (c.samples && c.samples.length)) {
    L.push('');
    L.push('## Failure samples');
    L.push('');
    for (const x of s.checkSamples.concat(s.mirrorSamples, c.samples || [])) L.push('- ' + x);
  }
  if (s.log.length) {
    L.push('');
    L.push('## Server log (first 40 lines)');
    L.push('');
    for (const x of s.log) L.push('- ' + x.replace(/\|/g, '/'));
  }
  L.push('');
  return L.join('\n');
}

main().catch((e) => {
  console.error(e && e.stack);
  process.exit(1);
});
