'use strict';
// The main server's link to the slither process (the server split, spec 5, 7 and 8). SL_SPLIT=1 (and SL_ENABLED on)
// forks server/split/slChild.js, which runs the free slither room and the battle royale on the sl engine on its own
// thread; everything that holds money (paid slither, every payout, the journals, the bot bank, the battle royale's
// prize) stays in the main server. Off (the default), create() returns an inert link: remote false, every method a
// no-op, and server/index.js runs today's code paths.
//
// create({ enabled, port, heapMb, inspectPort, staleMs, hangMs, ops, notify, log, now, fork, timers, childPath }):
//   remote, port                 split on, and the child's 127.0.0.1 port
//   fresh(), stale(), snap(), ageMs()   the last snapshot (about 1 Hz) and whether it is under staleMs old on THIS
//                                process's clock, from the child running now. Stale is unknown, never 0 (slProxies).
//   mirrorGovernor(), freeProxy(local), brProxy(), decisionProxy(d), noteDecided(d), room(lobbyType)
//   useHelpers({ paidLoad })     slBoot's remote branch: the paid seats count the 1 Hz load message carries
//   doorWanted()                 the free door the owner last set (default open), sent again in every init
//   start({ init, onJoin, onPush, onLive, onDecided, onExit, brOnSl })   fork and supervise (below)
//   call(op, args)               an owner command: -> Promise<{ ok, note?, why?, result? }>, 5 s, NEVER retried
//   send(msg), emit(ev, data)    fire and forget to the child
//   ownsCommand(action, args)    does this /api/owner/do action belong to the child (spec X6)
//   debug()                      for /api/debug/tick; undefined while off (that answer stays as it was)
//   stop()                       shutdown, then SIGTERM after 300 ms; no refork after it
//
// Supervisor (spec 8.3): a child that exits is stale at once and its pending commands answer "restarting". When its
// IPC channel has closed (so every message it sent has been read: a decision is never lost to the exit racing it),
// onExit runs (index.js voids a battle royale the child was running) and a new child is forked after 1, 2, 5, 10, then
// 30 s (back to 1 s once a child lived 120 s). More than 10 exits in 10 minutes: no more forks, logged, Owen pushed
// once. A ready child that sends nothing for hangMs is killed (SIGKILL) and handled as an exit; so is one that never
// gets ready. A graceful exit (the child said bye) is reforked without counting.
//
// A child that is starting (init sent, not ready) refuses commands with "restarting". The owner's free door and a
// switch of the battle royale to the sl engine are kept here and in index.js all the same, so one made in that window
// is sent when the child says ready (the init it got had the old value, and the refused command never reached it).

const path = require('path');
const env = require('./ipcEnvelope');
const proxies = require('./slProxies');

const BACKOFF_MS = Object.freeze([1000, 2000, 5000, 10000, 30000]);
const BACKOFF_RESET_MS = 120 * 1000;
const GIVE_UP_EXITS = 10;
const GIVE_UP_WINDOW_MS = 10 * 60 * 1000;
const CALL_TIMEOUT_MS = 5000;
const LOAD_EVERY_MS = 1000;
const WATCH_EVERY_MS = 5000;
const STOP_KILL_MS = 300;
// The child's exit was seen and its channel's close was not: the supervisor runs anyway after this long, unless the
// channel is still connected (this process has not read the child's pipe to its end: a loop that stalled past the
// wait runs its timers before it reads, and a decision the child sent before it died may be waiting there). Then it
// waits again, up to CLOSE_WAIT_MAX_MS in all.
const CLOSE_WAIT_MS = 2000;
const CLOSE_WAIT_MAX_MS = 30000;

const WHY_TIMEOUT = 'The slither process did not answer in time; it may still have done it, check the console';
const WHY_RESTARTING = 'The slither process is restarting; try again';
const GAVE_UP_TEXT = 'The slither process keeps crashing; free slither and the battle royale are closed. ' +
  'Run scripts/sl-split.sh off';

const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t; };

// Single mode: nothing here does anything, and index.js keeps its direct calls.
function inert(port) {
  const no = () => {};
  const view = { send: () => false, call: () => Promise.resolve({ ok: false, why: WHY_RESTARTING }) };
  return {
    remote: false,
    port,
    fresh: () => false,
    stale: () => false,
    snap: () => null,
    ageMs: () => null,
    mirrorGovernor: () => null,
    freeProxy: () => null,
    brProxy: () => null,
    decisionProxy: (d) => proxies.decisionProxy(d, view),
    noteDecided: no,
    room: () => null,
    useHelpers: no,
    doorWanted: () => true,
    start: no,
    call: () => Promise.resolve({ ok: false, why: 'The slither process is not running' }),
    send: () => false,
    emit: no,
    ownsCommand: () => false,
    debug: () => undefined,
    stop: no,
  };
}

function create(opts) {
  const o = opts || {};
  const port = posInt(o.port, Number(process.env.PORT || 3000) + 1);
  if (!o.enabled) return inert(port);

  const now = typeof o.now === 'function' ? o.now : Date.now;
  const T = o.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
  const log = o.log || console;
  const forkFn = typeof o.fork === 'function' ? o.fork : require('child_process').fork;
  const childPath = typeof o.childPath === 'string' && o.childPath ? o.childPath : path.join(__dirname, 'slChild.js');
  const staleMs = posInt(o.staleMs, 5000);
  const hangMs = posInt(o.hangMs, 30000);
  const heapMb = posInt(o.heapMb, 192);
  const inspectPort = posInt(o.inspectPort, 9230);
  const ops = o.ops || null;
  const notify = o.notify || null;
  const dropped = env.dropLog(log, now);

  let hooks = null;          // start()'s
  let child = null;          // the ChildProcess, from fork until its channel closed
  let exited = false;        // that child's exit was seen (stale at once)
  let closeWait = null;
  let boot = null;           // its hello's boot id
  let sentInit = null;       // { door, brOnNew } its init carried, until it is ready
  let pid = null;
  let ready = false;
  let readyAt = 0;
  let forkedAt = 0;
  let byeSeen = false;
  let unflushed = 0;         // sends whose callback has not come yet: the load message waits while any are queued
  let lastSnap = null;
  let snapAt = null;
  let snapBoot = null;
  let lastSeq = 0;
  let lastDecided = null;    // the last decision block seen (message or snapshot), kept after the child died
  let lastDecidedId = null;
  let lastLoad = null;
  const pending = new Map(); // command id -> { resolve, timer }
  let nextId = 0;
  let stopping = false;
  let gaveUp = false;
  let backoffIdx = 0;
  let restarts = 0;
  const exits = [];
  let paidLoadFn = null;
  let extraLoadFn = null;
  let doorOpen = true;
  let loadTimer = null;
  let watchTimer = null;
  let reforkTimer = null;

  function safe(fn, label) {
    try {
      return fn();
    } catch (e) {
      try { log.error('[SPLIT] ' + label + ' failed: ' + (e && e.message)); } catch (_) { /* never */ }
      return undefined;
    }
  }

  function fresh() {
    return !!child && !exited && boot !== null && snapBoot === boot && snapAt !== null && now() - snapAt < staleMs;
  }

  // A message to this child, as written (no check): true when it was handed to the channel.
  function sendRaw(c, msg) {
    if (!c || !c.connected) return false;
    try {
      unflushed++;
      c.send(msg, (err) => {
        unflushed = Math.max(0, unflushed - 1);
        if (err) log.warn('[SPLIT] a ' + msg.t + ' message to the slither process was not sent: ' + err.message);
      });
      return true;
    } catch (e) {
      unflushed = Math.max(0, unflushed - 1);
      log.warn('[SPLIT] a ' + msg.t + ' message to the slither process was not sent: ' + (e && e.message));
      return false;
    }
  }

  // Fire and forget: checked against the envelope first, so a bad one is dropped here, not in the child.
  function send(msg) {
    const m = env.make(msg && msg.t, Object.assign({}, msg));
    const chk = env.check('toChild', m);
    if (!chk.ok) {
      dropped(m.t, chk.why);
      return false;
    }
    return sendRaw(child, m);
  }

  function answerPending(why) {
    for (const [id, p] of pending) {
      pending.delete(id);
      T.clearTimeout(p.timer);
      p.resolve({ ok: false, why });
    }
  }

  function call(op, args) {
    return new Promise((resolve) => {
      if (!child || exited || !ready || stopping) return resolve({ ok: false, why: WHY_RESTARTING });
      const id = ++nextId;
      const msg = env.make('cmd', { id, op, args: env.isObj(args) ? args : {} });
      const chk = env.check('toChild', msg);
      if (!chk.ok) {
        dropped('cmd', chk.why);
        return resolve({ ok: false, why: 'The slither process cannot take that (' + chk.why + ')' });
      }
      const timer = T.setTimeout(() => {
        if (!pending.delete(id)) return;
        log.warn('[SPLIT] the slither process did not answer ' + op + ' within ' + CALL_TIMEOUT_MS + ' ms');
        resolve({ ok: false, why: WHY_TIMEOUT });
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      if (!sendRaw(child, msg)) {
        pending.delete(id);
        T.clearTimeout(timer);
        resolve({ ok: false, why: WHY_RESTARTING });
      }
    });
  }

  // The load the child's governor reads (spec 5.3 load). consume: read (and so reset) the paid rooms' slice.
  function loadNow(consume) {
    let paidPlayers = 0;
    if (paidLoadFn) {
      const p = safe(paidLoadFn, 'paidLoad');
      if (p && Number.isInteger(p.paidPlayers) && p.paidPlayers > 0) paidPlayers = p.paidPlayers;
    }
    let extraSliceMs = 0;
    if (consume && extraLoadFn) {
      const x = safe(extraLoadFn, 'extraLoad');
      if (Number.isFinite(x) && x > 0) extraSliceMs = x;
    }
    const maintenance = !!(ops && typeof ops.get === 'function' && (safe(() => ops.get(), 'ops') || {}).maintenance);
    return { paidPlayers, extraSliceMs, maintenance };
  }

  // Once a second: sent when a field changed or the paid rooms' slice is above 0, never while sends are queued (the
  // slice is not read then, so it is not lost).
  function loadTick() {
    if (!child || exited || !ready || unflushed > 0) return;
    const l = loadNow(true);
    const same = !!lastLoad && lastLoad.paidPlayers === l.paidPlayers && lastLoad.maintenance === l.maintenance;
    if (same && !(l.extraSliceMs > 0)) return;
    if (sendRaw(child, env.make('load', l))) lastLoad = l;
  }

  function watchdog() {
    if (!child || exited) return;
    const since = ready ? (snapBoot === boot && snapAt !== null ? snapAt : readyAt) : forkedAt;
    if (now() - since < hangMs) return;
    log.error('[SPLIT] the slither process (pid ' + pid + ') sent nothing for ' + (now() - since) + ' ms: killing it');
    try { child.kill('SIGKILL'); } catch (e) { log.error('[SPLIT] kill failed: ' + (e && e.message)); }
  }

  // A snapshot from the child running now with a higher seq replaces the last one; its decided block is noted.
  function acceptSnap(s) {
    if (!s || boot === null || s.boot !== boot || !(s.seq > lastSeq)) return false;
    lastSeq = s.seq;
    lastSnap = s;
    snapBoot = s.boot;
    snapAt = now();
    const d = s.br && s.br.decided ? s.br.decided : null;
    if (d) {
      const isNew = d.matchId !== lastDecidedId;
      lastDecided = d;
      lastDecidedId = d.matchId;
      // the snapshot's path to the prize (spec M8): the main server pays once per match id whichever path is first
      if (isNew && hooks && hooks.onDecided) safe(() => hooks.onDecided(d), 'onDecided');
    } else if (lastDecided) {
      lastDecided = null;
      lastDecidedId = null;
    }
    return true;
  }

  // br.decided (and the tests): the decision is kept for the match proxy, then handed to the main server's prize.
  function noteDecided(d) {
    if (!env.isObj(d)) return;
    lastDecided = d;
    lastDecidedId = d.matchId;
  }

  // At ready: the owner's free door, or a switch of the battle royale to the sl engine, made after this child's init
  // went (its call was refused "restarting", so the child never had it). Sent once each; a switch back to the old
  // engine needs nothing (as in one process, the sl room stays open and starts no match).
  function catchUp() {
    const was = sentInit;
    sentInit = null;
    if (!was) return;
    const tell = (op, args, what) => {
      log.warn('[SPLIT] ' + what + ' while the slither process was starting: sending it now');
      call(op, args).then((r) => {
        if (!r.ok) log.warn('[SPLIT] ' + what + ' did not reach the slither process: ' + r.why);
      });
    };
    if (was.door !== doorOpen) tell('door', { open: doorOpen }, 'the free door was ' + (doorOpen ? 'opened' : 'closed'));
    const onSl = !!(hooks && typeof hooks.brOnSl === 'function' && safe(() => hooks.brOnSl(), 'brOnSl'));
    if (onSl && !was.brOnNew) tell('br:startRoom', {}, 'the battle royale moved to the sl engine');
  }

  function onMessage(c, m) {
    if (c !== child) return;
    const chk = env.check('toMain', m);
    if (!chk.ok) return dropped(m && m.t, chk.why);
    const h = hooks || {};
    switch (m.t) {
      case 'hello': {
        boot = m.boot;
        pid = m.pid;
        lastSeq = 0;
        const fields = Object.assign({}, typeof h.init === 'function' ? h.init() : {});
        fields.door = doorOpen;
        if (!env.isObj(fields.load)) fields.load = loadNow(false);
        lastLoad = { paidPlayers: fields.load.paidPlayers, maintenance: fields.load.maintenance };
        const init = env.make('init', fields);
        const ok = env.check('toChild', init);
        if (!ok.ok) {
          // the child exits when no init comes (10 s) and is forked again: this is logged every time
          log.error('[SPLIT] the init message is not valid (' + ok.why + '): the slither process will not start');
          return undefined;
        }
        if (sendRaw(c, init)) sentInit = { door: init.door, brOnNew: init.brOnNew === true };
        return undefined;
      }
      case 'ready':
        if (m.boot !== boot) return undefined;
        ready = true;
        readyAt = now();
        log.log('[SPLIT] the slither process (pid ' + pid + ') serves /sl-io/ on 127.0.0.1:' + m.port +
          (m.dev ? ' (DEV law table)' : ''));
        catchUp();
        return undefined;
      case 'snap':
        acceptSnap(m);
        return undefined;
      case 'join':
        if (h.onJoin) h.onJoin(m);
        return undefined;
      case 'push':
        if (h.onPush) h.onPush(m);
        return undefined;
      case 'br.live':
        if (h.onLive) h.onLive(m.rec);
        return undefined;
      case 'br.decided':
        noteDecided(m.d);
        if (h.onDecided) h.onDecided(m.d);
        return undefined;
      case 'reply': {
        if (m.snap) acceptSnap(m.snap);
        const p = pending.get(m.re);
        if (!p) return undefined;
        pending.delete(m.re);
        T.clearTimeout(p.timer);
        p.resolve({ ok: m.ok, note: m.note, why: m.ok ? m.why : m.why || 'The slither process refused that',
          result: m.result });
        return undefined;
      }
      case 'bye':
        byeSeen = true;
        return undefined;
      default:
        return undefined;
    }
  }

  function onExit(c, code, signal) {
    if (c !== child || exited) return;
    exited = true;
    ready = false;
    answerPending(WHY_RESTARTING);
    log.warn('[SPLIT] the slither process (pid ' + pid + ') exited (' + (signal || 'code ' + code) + ')' +
      (stopping ? '' : byeSeen ? ', it said goodbye' : ''));
    const exitAt = now();
    const wait = () => {
      closeWait = T.setTimeout(() => {
        closeWait = null;
        if (c !== child) return;
        // not read to its end yet: what it sent (a decision) is still to come, then its close
        if (c.connected && now() - exitAt < CLOSE_WAIT_MAX_MS) return wait();
        onClose(c, code, signal);
      }, CLOSE_WAIT_MS);
    };
    wait();
  }

  function onClose(c, code, signal) {
    if (c !== child) return;
    if (!exited) onExit(c, code, signal);
    if (closeWait) T.clearTimeout(closeWait);
    closeWait = null;
    child = null;
    boot = null;
    sentInit = null;
    ready = false;
    answerPending(WHY_RESTARTING);
    if (stopping) return;
    if (hooks && hooks.onExit) safe(() => hooks.onExit({ code, signal }), 'onExit');
    const t = now();
    if (!byeSeen) exits.push(t);
    while (exits.length && t - exits[0] > GIVE_UP_WINDOW_MS) exits.shift();
    if (exits.length > GIVE_UP_EXITS) {
      gaveUp = true;
      log.error('[SPLIT] gave up: the slither process exited ' + exits.length + ' times in 10 minutes. Free slither ' +
        'and the battle royale stay closed until a restart; scripts/sl-split.sh off goes back to one process');
      if (notify && typeof notify.pushOwner === 'function') {
        safe(() => notify.pushOwner(GAVE_UP_TEXT, { title: 'Slither process down', priority: 'high' }), 'push');
      }
      return;
    }
    if (t - forkedAt >= BACKOFF_RESET_MS) backoffIdx = 0;
    const wait = byeSeen ? BACKOFF_MS[0] : BACKOFF_MS[Math.min(backoffIdx++, BACKOFF_MS.length - 1)];
    restarts++;
    log.warn('[SPLIT] starting the slither process again in ' + wait + ' ms');
    reforkTimer = unref(T.setTimeout(spawn, wait));
  }

  function spawn() {
    reforkTimer = null;
    if (stopping || gaveUp || child) return;
    let c;
    forkedAt = now();
    try {
      c = forkFn(childPath, [], {
        // the whole environment on purpose: slBoot refuses the dev law table only where it can see an escrow key or a
        // database (loadSlLaws), and the child reads nothing secret it could not read from .env itself
        env: Object.assign({}, process.env, { SL_CHILD_PORT: String(port) }),
        execArgv: ['--max-old-space-size=' + heapMb, '--inspect-port=127.0.0.1:' + inspectPort],
        serialization: 'json',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
    } catch (e) {
      log.error('[SPLIT] could not start the slither process: ' + (e && e.message));
      exits.push(now());
      reforkTimer = unref(T.setTimeout(spawn, BACKOFF_MS[BACKOFF_MS.length - 1]));
      return;
    }
    child = c;
    exited = false;
    boot = null;
    sentInit = null;
    pid = c.pid;
    ready = false;
    readyAt = 0;
    byeSeen = false;
    unflushed = 0;
    lastSeq = 0;
    lastLoad = null;
    c.on('message', (m) => safe(() => onMessage(c, m), 'message'));
    c.on('exit', (code, signal) => safe(() => onExit(c, code, signal), 'exit'));
    c.on('close', (code, signal) => safe(() => onClose(c, code, signal), 'close'));
    c.on('error', (e) => {
      log.error('[SPLIT] the slither process: ' + (e && e.message));
      // a fork that never started has no exit to wait for
      if (c === child && !c.pid) safe(() => onClose(c, null, null), 'close');
    });
    log.log('[SPLIT] the slither process started (pid ' + c.pid + ')');
  }

  function start(h) {
    if (hooks || stopping) return;
    hooks = h || {};
    loadTimer = unref(T.setInterval(() => safe(loadTick, 'load'), LOAD_EVERY_MS));
    watchTimer = unref(T.setInterval(() => safe(watchdog, 'watchdog'), WATCH_EVERY_MS));
    spawn();
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    for (const t of [loadTimer, watchTimer]) if (t) T.clearInterval(t);
    if (reforkTimer) T.clearTimeout(reforkTimer);
    loadTimer = watchTimer = reforkTimer = null;
    answerPending(WHY_RESTARTING);
    const c = child;
    if (!c || exited) return;
    sendRaw(c, env.make('shutdown', { why: 'the main server is stopping' }));
    T.setTimeout(() => {
      if (c.exitCode === null && c.signalCode === null) {
        try { c.kill('SIGTERM'); } catch (_) { /* gone */ }
      }
    }, STOP_KILL_MS);
  }

  function knownRooms() {
    return lastSnap && Array.isArray(lastSnap.rooms) ? lastSnap.rooms.map((r) => r.lobbyType) : [];
  }

  // /api/owner/do (spec X6): the battle royale's Start and Stop while the event is on the sl engine, and the bot
  // controls of a room the child reported. Everything else is the main server's own.
  function ownsCommand(action, args) {
    if (!hooks) return false;
    if (action === 'br:start' || action === 'br:stop') return !!(typeof hooks.brOnSl === 'function' && hooks.brOnSl());
    if (action === 'bots:add' || action === 'bots:clear' || action === 'bots:set') {
      const room = args && typeof args.room === 'string' ? args.room : null;
      return !!room && knownRooms().includes(room);
    }
    return false;
  }

  const view = {
    snap: () => lastSnap,
    fresh,
    send,
    call,
    decided: () => lastDecided,
    setDoorWanted: (open) => { if (open === true || open === false) doorOpen = open; },
    setExtraLoad: (fn) => { extraLoadFn = typeof fn === 'function' ? fn : null; },
  };
  let gov = null;
  let free = null;
  let br = null;

  return {
    remote: true,
    port,
    fresh,
    stale: () => !fresh(),
    snap: () => lastSnap,
    ageMs: () => (snapAt === null ? null : now() - snapAt),
    mirrorGovernor() {
      if (!gov) gov = proxies.mirrorGovernor(view);
      return gov;
    },
    freeProxy(local) {
      if (!free) free = proxies.freeProxy(view, local);
      return free;
    },
    brProxy() {
      if (!br) br = proxies.brProxy(view);
      return br;
    },
    decisionProxy: (d) => proxies.decisionProxy(d, view),
    noteDecided,
    // The last room proxy the child reported by that name, even while it is not reporting (the console's label).
    room: (lobbyType) => proxies.roomsOf(lastSnap).find((r) => r.lobbyType === lobbyType) || null,
    useHelpers(hp) {
      paidLoadFn = hp && typeof hp.paidLoad === 'function' ? hp.paidLoad : null;
    },
    doorWanted: () => doorOpen,
    start,
    call,
    send,
    emit: (ev, data) => send({ t: 'emit', ev, data }),
    ownsCommand,
    debug() {
      const p = lastSnap && env.isObj(lastSnap.proc) ? lastSnap.proc : {};
      return { mode: 'split', fresh: fresh(), ready, ageMs: snapAt === null ? null : now() - snapAt, pid,
        rssMb: p.rssMb, heapMb: p.heapMb, elu: p.elu, loopP99Ms: p.loopP99Ms, restarts, gaveUp };
    },
    stop,
  };
}

module.exports = { create, BACKOFF_MS, BACKOFF_RESET_MS, GIVE_UP_EXITS, GIVE_UP_WINDOW_MS, CALL_TIMEOUT_MS,
  LOAD_EVERY_MS, WATCH_EVERY_MS, CLOSE_WAIT_MS, CLOSE_WAIT_MAX_MS, WHY_TIMEOUT, WHY_RESTARTING, GAVE_UP_TEXT };
