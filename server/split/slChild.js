'use strict';
// The slither process (the server split, spec 8.1): free slither and the battle royale on the sl engine, on their own
// thread. The main server forks it (server/split/slLink.js) when SL_SPLIT=1; nginx sends the engine.io path /sl-io/
// here (127.0.0.1:SL_CHILD_PORT) and to the main server only as its backup.
//
// It HOLDS NO MONEY and loads nothing that does: no database, no money module, no journal, no entry tokens, no bot
// bank, no ntfy, no analytics, no owner sessions, no express, no dotenv (the environment is the main server's, as
// forked). test/slChild.test.js checks the whole require graph. A paid handshake (paid 1 or any watchStake) is refused
// 'closed' at connect, before the address gate counts it and before any join: its entry token is never read here and
// stays spendable at the main server. The battle royale's prize is decided and paid by the main server: this process
// sends the decision (br.decided) and the live-match record (br.live) and nothing else about it.
//
// Boot: hello, then the main server's init (within 10 s, else exit 1): the mirrors (maintenance, the free door, the
// turning switch, the owners, the battle royale's engine), then the rooms, then listen on 127.0.0.1:SL_CHILD_PORT (a
// port still held by a predecessor is tried every 250 ms for 10 s), then ready and a snapshot every second. Joins are
// refused 'maintenance' until init says otherwise. It exits on the main server's shutdown, SIGINT, SIGTERM, or the IPC
// channel closing (the main server died).
//
// snapshotOf (exported, also run by test/slProxies.test.js on in-process rooms) builds the 1 Hz snapshot: the free
// room's board row FIRST (it sets the room's lastBoardOk, which isLive reads), counts per room, the governor, the
// battle royale's match and its decision. No money field: stake appears only as the free row's 0.

const http = require('http');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const envelope = require('./ipcEnvelope');
const ownerConsole = require('../ownerConsole');

// A room as the snapshot reports it (ipcEnvelope roomRow): humans are the seats whose snake is alive (the rule of
// SlRoom's snakes getter, without building its Map).
function roomRowOf(r, kind) {
  let humans = 0;
  if (r.seats && typeof r.seats.values === 'function' && r.sim && typeof r.sim.snake === 'function') {
    for (const seat of r.seats.values()) if (r.sim.snake(seat.snakeId)) humans++;
  }
  const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  let aim = null;
  if (typeof r.botCurve === 'function') aim = int(r.botCurve());
  return {
    lobbyType: String(r.lobbyType),
    kind,
    index: int(r.index) || 0,
    playerCount: int(r.playerCount) || 0,
    botCount: int(r.botCount) || 0,
    humans,
    botsAllowed: typeof r.botsAllowed === 'function' && r.botsAllowed() === true,
    botTarget: int(ownerConsole.roomBotTarget(r)),
    botAim: aim,
    botsHeld: int(r._botsHeld),
    pausedUntil: Number.isFinite(r._botsPausedUntil) ? r._botsPausedUntil : 0,
  };
}

// The decision the main server pays from (payBattleRoyaleWinner): the winner's proven wallet, the prize rule's
// fields and the proven seats as the doors shut.
function decisionOf(m) {
  const w = m.winner;
  return {
    matchId: m.matchId,
    winner: { id: Number.isInteger(w.id) ? w.id : null, name: String(w.name || ''),
      wallet: typeof w.wallet === 'string' && w.wallet ? w.wallet : null, bot: w.bot === true },
    soloRun: !!m.soloRun,
    prizeHeld: m.prizeHeld,
    startedPeople: m.startedPeople,
    startedWith: m.startedWith,
    seats: typeof m.startedSeats === 'function' ? m.startedSeats() : [],
  };
}

// o: { boot, seq, arenas (the free SlArenas), slBr (SlBrArena or null), proc, now }
function snapshotOf(o) {
  const arenas = o.arenas;
  const slBr = o.slBr || null;
  let rows = null;
  let rowsErr = null;
  try {
    rows = arenas.boardRows();
  } catch (e) {
    rowsErr = String((e && e.message) || 'board rows failed').slice(0, 500);
  }
  const free = { rows, rowsErr, live: arenas.isLive(), humans: arenas.humanTotal() };
  const rooms = arenas.all().map((r) => roomRowOf(r, 'free'));
  let br = null;
  if (slBr) {
    for (const r of slBr.all()) rooms.push(roomRowOf(r, 'br'));
    const m = slBr.match;
    const room = slBr.room();
    br = {
      open: slBr.isOpen(),
      room: room ? String(room.lobbyType) : null,
      humans: slBr.humanTotal(),
      match: { matchId: m.matchId || null, state: String(m.state), public: m.publicState(), canStart: !!m.canStart(),
        accepting: !!m.acceptingPlayers(), humanLiving: m.humanLiving(), livingCount: m.livingCount() },
      decided: m.winner && m.matchId ? decisionOf(m) : null,
    };
  }
  const g = arenas.governor;
  return envelope.make('snap', {
    boot: o.boot,
    seq: o.seq,
    at: typeof o.now === 'number' ? o.now : Date.now(),
    proc: o.proc || {},
    gov: { engaged: !!(g && g.engaged()), mult: g ? g.mult() : 1 },
    smooth: !!require('../sl/slRoom').smoothOn(),
    door: arenas.doorOpen !== false,
    free,
    rooms,
    br,
  });
}

// The cookie header reduced to the owner session's two names (ownerSession.js namesFor): all the main server's
// ownerDevice reads, so nothing else a player's browser holds crosses.
function ownerCookies(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  const keep = [];
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === '__Host-ds_owner' || name === 'ds_owner') keep.push(part.trim());
  }
  return keep.join('; ').slice(0, 8192);
}

function joinHeaders(socket) {
  const hs = socket && socket.handshake && socket.handshake.headers ? socket.handshake.headers : {};
  const h = {};
  for (const k of ['host', 'origin', 'sec-fetch-site']) if (typeof hs[k] === 'string') h[k] = hs[k].slice(0, 8192);
  const c = ownerCookies(hs.cookie);
  if (c) h.cookie = c;
  return h;
}

function main() {
  const { Server } = require('socket.io');
  const ioOpts = require('../ioOptions');
  const perfEcho = require('../perfEcho');
  const { socketRL } = require('../socketRL');
  const slBoot = require('../sl/slBoot');
  const slRoom = require('../sl/slRoom');
  const { safeEvery, createSafeStats } = require('../sl/slSafe');
  const { SlBrArena } = require('../slBr/slBrArena');
  const { createLastPodiumStore } = require('../slBr/brLastPodium');
  const { ownerStartBr } = require('../slBr/brOwnerStart');
  const ownerAuth = require('../ownerAuth');
  const nameProof = require('../nameProof');

  const log = console;
  // the name ps and pm2's tree show (on Windows it would retitle the shared console window instead)
  if (process.platform !== 'win32') process.title = 'duelseries-sl';
  const boot = crypto.randomUUID();
  const port = Number(process.env.SL_CHILD_PORT);
  // closed until the main server says otherwise (init, emit maintenance, load)
  let opsMirror = { maintenance: true, message: '' };
  const load = { paidPlayers: 0, extraSliceMs: 0 };
  let owners = new Set();
  let botsPauseMs = 15 * 60 * 1000;
  let started = false;
  let arenas = null;
  let slBr = null;
  let io = null;
  let server = null;
  let seq = 0;
  let snapping = false;
  let leaving = false;
  let elu = performance.eventLoopUtilization();
  const safeStats = createSafeStats();
  const dropped = envelope.dropLog(log);
  let initTimer = null;

  function send(msg, cb) {
    const m = envelope.make(msg.t, msg);
    const chk = envelope.check('toMain', m);
    if (!chk.ok) {
      dropped(m.t, chk.why);
      return false;
    }
    if (!process.connected) return false;
    try {
      process.send(m, cb);
      return true;
    } catch (e) {
      log.error('[SL-CHILD] send ' + m.t + ' failed: ' + (e && e.message));
      return false;
    }
  }

  function proc() {
    const mem = process.memoryUsage();
    const e = performance.eventLoopUtilization(elu);
    elu = performance.eventLoopUtilization();
    const s = arenas && arenas.lastSample ? arenas.lastSample : null;
    const p99 = s && Number.isFinite(s.loopRawP99Ms) ? s.loopRawP99Ms : s && Number.isFinite(s.loopP99Ms) ? s.loopP99Ms
      : null;
    return { pid: process.pid, rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576),
      elu: Math.round(e.utilization * 1000) / 1000, loopP99Ms: p99 };
  }

  function snapNow() {
    return snapshotOf({ boot, seq: ++seq, arenas, slBr, proc: proc(), now: Date.now() });
  }

  // Once a second; skipped while the last one is still being written (the main server reads them when it can).
  function snapTick() {
    if (!arenas || snapping || leaving) return;
    snapping = true;
    if (!send(snapNow(), () => { snapping = false; })) snapping = false;
  }

  function leave(why) {
    if (leaving) return;
    leaving = true;
    log.log('[SL-CHILD] stopping (' + why + ')');
    const done = () => process.exit(0);
    const t = setTimeout(done, 500);
    try {
      if (io) io.close();
    } catch (_) { /* closing is best effort */ }
    send({ t: 'bye', why: String(why).slice(0, 200) }, () => { clearTimeout(t); done(); });
  }

  // A free or BR seat passed slSockets' own push pre-filter: the main server's join gates decide the push.
  function notifyJoin(name, where, socket) {
    send({ t: 'join', name: String(name || '').slice(0, 64), where: where === 'br' ? 'br' : 'free', h: joinHeaders(socket) });
  }

  // The live-match record (brMatch journal.setLive): forwarded in order, except that a clear waits one tick, so a
  // decision made in the same turn (brMatch clears the record just before it calls onDecided) reaches the main server
  // FIRST. A process that dies between the two then leaves the main server a decision it pays once and a record it
  // clears, never a cleared record with the decision lost.
  let clearHeld = false;
  function forwardLive(rec) {
    if (rec === null || rec === undefined) {
      if (clearHeld) return;
      clearHeld = true;
      process.nextTick(() => {
        if (!clearHeld) return;
        clearHeld = false;
        send({ t: 'br.live', rec: null });
      });
      return;
    }
    if (clearHeld) {
      clearHeld = false;
      send({ t: 'br.live', rec: null });
    }
    send({ t: 'br.live', rec });
  }

  function roomNamed(name) {
    const all = (arenas ? arenas.all() : []).concat(slBr ? slBr.all() : []);
    return all.find((r) => r.lobbyType === name) || null;
  }

  // An owner command (spec 5.3): -> { ok, note?, why?, result? }
  function runCmd(op, args) {
    const a = args || {};
    switch (op) {
      case 'bots:add':
      case 'bots:clear': {
        const out = ownerConsole.botsAddClear(roomNamed(a.room), op, a, { now: Date.now(), pauseMs: botsPauseMs });
        const result = {};
        for (const k of ['made', 'removed', 'paper']) if (out[k] !== undefined) result[k] = out[k];
        return { ok: !!out.ok, why: out.ok ? undefined : out.why, result };
      }
      case 'bots:set': {
        const r = ownerConsole.setBots(roomNamed(a.room), a);
        return { ok: !!r.ok, why: r.ok ? undefined : r.why, result: r };
      }
      case 'br:start': {
        const r = ownerStartBr(slBr ? slBr.match : null, !!a.force);
        return r.ok ? { ok: true, note: r.note } : { ok: false, why: r.why };
      }
      case 'br:stop': {
        const br = slBr ? slBr.match : null;
        if (!br || (br.state !== 'running' && br.state !== 'countdown')) return { ok: false, why: 'No match is running' };
        br.abandon('owner');
        return { ok: true, note: 'Match stopped, no prize paid' };
      }
      case 'br:startRoom':
        if (slBr) slBr.startRoom();
        return { ok: true, result: {} };
      case 'br:autoStart': {
        const m = slBr ? slBr.match : null;
        if (!m || m.state !== 'waiting' || !m.canStart()) {
          // decided on a snapshot up to a second old (spec 7.3): the main server has marked the slot, so say why
          log.log('[BR] slot start not made: the arena is ' + (m ? m.state : 'gone') + (m && m.state === 'waiting'
            ? ' with ' + m.livingCount() + ' snake(s)' : ''));
          return { ok: false, why: 'state changed' };
        }
        m.startMatch(typeof a.why === 'string' ? a.why : 'slot', { countdownMs: 0 });
        return { ok: true, result: {} };
      }
      case 'door':
        return { ok: true, result: { door: arenas.door(a.open) } };
      case 'snap.now':
        return { ok: true, result: {} };
      case 'debug.modules':
        if (process.env.DS_SPLIT_DEBUG !== '1') return { ok: false, why: 'off' };
        return { ok: true, result: { modules: Object.keys(require.cache), resources: process.getActiveResourcesInfo() } };
      default:
        return { ok: false, why: 'unknown command' };
    }
  }

  function onCmd(m) {
    let r;
    try {
      r = arenas ? runCmd(m.op, m.args) : { ok: false, why: 'The slither process is starting' };
    } catch (e) {
      log.error('[SL-CHILD] ' + m.op + ' threw: ' + (e && e.message));
      r = { ok: false, why: 'The slither process could not do that (' + String(e && e.message).slice(0, 200) + ')' };
    }
    const reply = { t: 'reply', re: m.id, ok: !!r.ok };
    for (const k of ['note', 'why']) if (typeof r[k] === 'string') reply[k] = r[k].slice(0, 2000);
    if (r.result !== undefined) reply.result = r.result;
    if (arenas) reply.snap = snapNow();
    if (!send(reply)) {
      delete reply.result;
      send(reply);
    }
  }

  function listen(cb) {
    const since = Date.now();
    let up = false;
    server.on('error', (e) => {
      if (up) return log.error('[SL-CHILD] server: ' + (e && e.message));
      if (e && e.code === 'EADDRINUSE' && Date.now() - since < 10000) {
        setTimeout(() => server.listen(port, '127.0.0.1'), 250);
        return undefined;
      }
      log.error('[SL-CHILD] cannot listen on 127.0.0.1:' + port + ': ' + (e && e.message));
      return process.exit(1);
    });
    server.once('listening', () => {
      up = true;
      cb();
    });
    server.listen(port, '127.0.0.1');
  }

  // A boot that fails part way exits, so the main server forks a fresh one (and backs off) instead of waiting for a
  // half-built process to go silent.
  function onInit(m) {
    if (started) return;
    started = true;
    clearTimeout(initTimer);
    try {
      build(m);
    } catch (e) {
      log.error('[SL-CHILD] boot failed: ' + (e && e.stack || e));
      process.exit(1);
    }
  }

  function build(m) {
    opsMirror = Object.assign({}, m.ops, { maintenance: !!(m.ops.maintenance || m.load.maintenance) });
    load.paidPlayers = m.load.paidPlayers;
    load.extraSliceMs = m.load.extraSliceMs;
    owners = new Set(m.owners);
    botsPauseMs = m.botsPauseMs > 0 ? m.botsPauseMs : botsPauseMs;
    slRoom.setSmooth(m.smooth);

    server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        return res.end('ok');
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    });
    server.keepAliveTimeout = ioOpts.KEEPALIVE.keepAliveTimeout;
    server.headersTimeout = ioOpts.KEEPALIVE.headersTimeout;
    io = new Server(server, Object.assign({}, ioOpts.IO_OPTIONS, { path: ioOpts.SL_IO_PATH, serveClient: false }));
    perfEcho.install(io);
    ioOpts.tagEngine(io, 'sl');
    // only /sl lives here
    io.of('/').use((_s, next) => next(new Error('no')));

    const opened = slBoot.openSl({
      env: process.env,
      io,
      region: m.region,
      role: 'free',
      topCashout: null,
      awake: true,
      helpers: {
        socketRL,
        ops: { get: () => opsMirror },
        notifyJoin,
        // the main server's join gates know the owner (his session cookie); here every join spends the pre-filter
        ownerSocket: () => false,
        paidLoad: () => ({ paidPlayers: load.paidPlayers, paid: [] }),
      },
    });
    if (!opened.arenas) {
      log.error('[SL-CHILD] the free room did not open (' + opened.why + ')');
      process.exit(1);
    }
    arenas = opened.arenas;
    slBr = new SlBrArena(arenas.laws, {
      region: m.region,
      shippableOnly: arenas.shippableOnly,
      governor: arenas.governor,
      isOwner: (w) => owners.has(w),
      journal: { setLive: forwardLive },
      // the same rule as server/index.js: a whole number or nothing
      seatsPerAddr: /^\d{1,3}$/.test(process.env.BR_SEATS_PER_ADDR || '') ? Number(process.env.BR_SEATS_PER_ADDR) : undefined,
      onVoided: (was) => send({ t: 'push',
        text: `Battle royale ${was.matchId} was cut off (${was.why}) with ${was.seats} player(s). No winner, no prize.`,
        title: 'Battle Royale voided' }),
      onDecided: (mt) => send({ t: 'br.decided', d: decisionOf(mt) }),
      paidBusy: () => !!arenas.paidBusyNow,
      lastStore: createLastPodiumStore({ file: m.podiumFile }),
    });
    opened.sockets.setBr({
      arenas: slBr,
      identify: (p) => (p && p.action === 'play:identify'
        ? ownerAuth.walletForPlayerAction(p) : nameProof.verifyIdentityProof(p)),
    });
    // the governor sees the main server's paid slice (from load, read and reset) and the battle royale's
    arenas.setExtraLoad(() => {
      const x = load.extraSliceMs;
      load.extraSliceMs = 0;
      return Math.max(x, slBr.maxSliceMs());
    });
    if (m.brOnNew) slBr.startRoom();
    arenas.door(m.door);

    const sweepStart = setTimeout(() => {
      safeEvery(() => arenas.sweep(Date.now()), 60000, 'sl-sweep', safeStats, { log });
    }, 26000);
    sweepStart.unref();
    listen(() => {
      send({ t: 'ready', boot, port, dev: !!opened.dev });
      snapTick();
      setInterval(snapTick, 1000).unref();
    });
  }

  function onMessage(m) {
    const chk = envelope.check('toChild', m);
    if (!chk.ok) return dropped(m && m.t, chk.why);
    try {
      switch (m.t) {
        case 'init': return onInit(m);
        case 'load':
          load.paidPlayers = m.paidPlayers;
          if (m.extraSliceMs > load.extraSliceMs) load.extraSliceMs = m.extraSliceMs;
          if (opsMirror.maintenance !== m.maintenance) opsMirror = Object.assign({}, opsMirror, { maintenance: m.maintenance });
          return undefined;
        case 'emit':
          if (m.ev === 'maintenance') opsMirror = Object.assign({}, m.data, { maintenance: !!m.data.maintenance });
          if (io) io.of('/sl').emit(m.ev, m.data);
          return undefined;
        case 'smooth':
          slRoom.setSmooth(m.on);
          return undefined;
        case 'br.hold':
          if (slBr) slBr.match.holdPrize(m.matchId);
          return undefined;
        case 'cmd':
          return onCmd(m);
        case 'shutdown':
          return leave('shutdown');
        default:
          return undefined;
      }
    } catch (e) {
      log.error('[SL-CHILD] ' + m.t + ' failed: ' + (e && e.message));
      return undefined;
    }
  }

  if (typeof process.send !== 'function') {
    log.error('[SL-CHILD] started without the main server (no IPC channel): exiting');
    process.exit(1);
  }
  process.on('disconnect', () => process.exit(0));
  process.on('SIGINT', () => leave('SIGINT'));
  process.on('SIGTERM', () => leave('SIGTERM'));
  process.on('message', onMessage);
  initTimer = setTimeout(() => {
    log.error('[SL-CHILD] no init from the main server within 10 s: exiting');
    process.exit(1);
  }, 10000);
  send({ t: 'hello', boot, pid: process.pid, node: process.version });
}

if (require.main === module) main();

module.exports = { snapshotOf, decisionOf, roomRowOf, ownerCookies, joinHeaders };
