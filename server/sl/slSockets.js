'use strict';
// slither.io free room: the /sl socket handlers (SERVER-DESIGN 12.1, 12.2, 13 item 9; task T11). Agar's structure
// (server/ag/agSockets.js): a namespace middleware with a per-address cap, every handler through one guard that
// catches and counts, plain-object checks (the default namespace's isSocketMsg, server/index.js:97, does not cover
// /sl), every number checked finite and in range before it reaches the room.
//
// In:  sl:join {nick} once per socket (C_CONN joinOnce); sl:i one binary input bundle per emit (shared/slWire.js
//      encodeInput, C_RATE_INPUT); sl:hold {on}; sl:vis {hidden}; sl:chat {text}; sl:diag {counters}; sl:leave;
//      disconnect. The frozen client sends sl:join, sl:i and sl:leave (public/js/sl/slNet.js:165-183); the rest is
//      the layer's (SERVER-DESIGN 15.2).
// Out: sl:f and sl:x leave through the room's send queue (slSendQueue); this file emits only a refusal.
//
// Refusals (SERVER-DESIGN 12.1, finalize pass C28). Every one sends sl:x [{t: 'refused', why}] and THEN disconnects,
// because the frozen client left open would stay "connecting" with Play locked. why is one of:
//   'limit'        the address already holds C_SL_PER_IP sockets on /sl
//   'not-open'     sl:join carried a money field (stake, entryToken or resumeKey): the free door never reads one
//   'maintenance'  the owner's maintenance switch is on (server/ops.js)
//   'closed'       the door is off (owner console sl:door:off) or the room is closed
//   'full'         the room refused a seat (C_HUMAN_CAP or C_ROOM_CAP; bots yield first)
//   'flood'        sustained input abuse over the C_RATE_INPUT window; or a resume over C_RESUME (per seat, or an
//                  address that sent too many unusable keys)
//   'gone'         sl:back named no life the room still holds (task T16b: ended, never issued, already used, or a
//                  stream the room cannot continue)
//   'taken'        to the OLD socket of a seat another socket took back with the current key (task T16b)
//
// Resume (task T16b, server/sl/slResume.js, slRoom resume): sl:back {k, n, p} INSTEAD of sl:join, once per socket,
// from the layer's transport after a drop. k is the key the room gave that seat (exact UUID shape, else never looked
// up), n and p whole numbers 0 to INT32_MAX. No maintenance or door check: it is the same life, not a new seat. A
// socket the server itself ended (a refusal: flood, taken; or the queue's own kick) is never parked: its disconnect is
// a leave, so its snake glides and dies as before.
//
// Input (C_RATE_INPUT, SERVER-DESIGN 12.2, finalize pass C3, C15, C42): NO burst limit. Records are merged per tick
// (slSim.setInput), so a burst after a stall costs nothing; a socket is disconnected only on SUSTAINED abuse: over a
// sliding window of windowMs, more than recordsPerSec x windowMs / 1000 records or bytesPerSec x windowMs / 1000 bytes.
// Never thinned (a dropped 254 would leave a snake boosting).
//
// Rates (C_RATE, CHOSEN; per socket through the server's socketRL): join, leave, chat, diag as given. sl:hold and
// sl:vis are states, so (agar's rule for a hold release, server/ag/agSockets.js:247) only their "on" side is limited:
// {on: 1} at most once per C_RATE.hold, and a release reaches the room only when the last accepted message of that
// socket was a press; the same for {hidden: 1} and {hidden: 0} with C_RATE.vis, except that a limited {hidden: 1} waits
// as pending until its window ends (onVis). A flood of either is bounded and a release is never lost.
//
// Handshake (C_CONN): auth.cv a whole number in the shipped skin set (slBots.botSkins: cv 0 to 65, the picture skins
// only while PICTURE_SKINS is on) is the seat's skin; anything else, or none, is a random plain colour 0 to 8 as their
// login does (badSkin 'random0to8'), drawn from this namespace's own seeded stream. Nothing else is read from the
// handshake (no token, no wallet: the free door holds no money).
//
// Owner phone push (C_PUSH, SERVER-DESIGN 13 item 9): after a seat is given, at most one push per player name per
// perNameMs AND at most maxPerWindow pushes per windowMs in total, the name as cleanNick left it.
//
// attachSlSockets(nsp, arenas, helpers): nsp is io.of('/sl') (null: attach sockets by hand, tests). arenas is
// slArenas (join, leave, disconnect, input, hold, vis, chat, diag, isOpen, laws). helpers: { socketRL (required),
// ops, notifyJoin(name), clientIp(socket), now() wall ms for the input window, seed, log }.

const W = require('../../shared/slWire.js');
const { assertLawsComplete } = require('./slLaws');
const { createRng, streamSeed } = require('./slRng');
const { cleanNick } = require('./slNames');
const { botSkins } = require('./slBots');
const { safeCall, safeAsync, safeTimeout, createSafeStats, REAL_TIMERS } = require('./slSafe');
const { resumeLaws, isKey, count, createBadKeyGate, WHY_GONE, WHY_TAKEN } = require('./slResume');

const SOCK_LAW_IDS = Object.freeze(['C_SL_PER_IP', 'C_RATE', 'C_RATE_INPUT', 'C_CONN', 'C_PUSH', 'PICTURE_SKINS', 'L45']);
// sl:join fields a free seat never takes (SERVER-DESIGN 12.2: agar refuses a paid payload with no door,
// server/ag/agSockets.js:186). Only their presence is checked, never their value.
const MONEY_FIELDS = Object.freeze(['stake', 'entryToken', 'resumeKey']);
// C_CONN badSkin modes built: 'random0to8' = one of the 9 plain colours 0 to 8 (their login, G:8963-8969).
const BAD_SKIN_MODES = Object.freeze({ random0to8: 9 });
const REFUSALS = Object.freeze(['limit', 'not-open', 'maintenance', 'closed', 'full', 'flood', WHY_GONE, WHY_TAKEN]);
// sl:diag fields (SERVER-DESIGN 12.2): whole or fractional counters, each a finite number from 0 to INT32_MAX; and
// lastClose, one short enum the layer names (T17), kept only as up to L45 nameMax letters, digits, '_', '-' or ':'.
const DIAG_NUMBERS = Object.freeze(['applyThrows', 'wireErrors', 'fps', 'lag', 'lagEntries', 'pongP95', 'maxGapMs',
  'maxOwnChl']);
const INT32_MAX = 2147483647;

function bad(id, what) {
  throw new Error('slSockets: law ' + id + ' ' + what);
}

function posInt(v, id, what) {
  if (!Number.isInteger(v) || v <= 0) bad(id, what + ' must be a whole number above 0');
  return v;
}

// Every value this file reads, once.
function sockLaws(laws) {
  assertLawsComplete(laws, SOCK_LAW_IDS);
  const rate = laws.C_RATE.value;
  const inp = laws.C_RATE_INPUT.value;
  const conn = laws.C_CONN.value;
  const push = laws.C_PUSH.value;
  if (!rate || typeof rate !== 'object') bad('C_RATE', 'is not {join, hold, vis, chat, diag, leave}');
  for (const k of ['join', 'hold', 'vis', 'chat', 'diag', 'leave']) posInt(rate[k], 'C_RATE', k);
  if (!inp || typeof inp !== 'object') bad('C_RATE_INPUT', 'is not the input row');
  for (const k of ['minBytes', 'maxBytes', 'windowMs', 'recordsPerSec', 'bytesPerSec']) posInt(inp[k], 'C_RATE_INPUT', k);
  if (inp.minBytes > inp.maxBytes) bad('C_RATE_INPUT', 'minBytes is above maxBytes');
  if (!conn || !Object.prototype.hasOwnProperty.call(BAD_SKIN_MODES, conn.badSkin)) {
    bad('C_CONN', 'badSkin ' + JSON.stringify(conn && conn.badSkin) + ' is not built (built: random0to8)');
  }
  if (conn.joinOnce !== true) bad('C_CONN', 'joinOnce must be true (the only mode built)');
  if (!push || typeof push !== 'object') bad('C_PUSH', 'is not {perNameMs, windowMs, maxPerWindow}');
  for (const k of ['perNameMs', 'windowMs', 'maxPerWindow']) posInt(push[k], 'C_PUSH', k);
  const nameMax = laws.L45.value && laws.L45.value.nameMax;
  posInt(nameMax, 'L45', 'nameMax');
  return Object.freeze({
    perIp: posInt(laws.C_SL_PER_IP.value, 'C_SL_PER_IP', 'sockets per address'),
    rate: Object.freeze(Object.assign({}, rate)),
    input: Object.freeze(Object.assign({}, inp)),
    badSkinCount: BAD_SKIN_MODES[conn.badSkin],
    push: Object.freeze(Object.assign({}, push)),
    skins: new Set(botSkins(laws)),
    nameMax,
    resume: resumeLaws(laws),
  });
}

// The real table's values, for the console and docs (SERVER-DESIGN 3.1 names them SL_RATE and SL_CONN).
function realTables() {
  const { LAWS } = require('./slLaws');
  return {
    SL_RATE: Object.freeze(Object.assign({}, LAWS.C_RATE.value, { input: LAWS.C_RATE_INPUT.value })),
    SL_CONN: Object.freeze(Object.assign({ PER_IP: LAWS.C_SL_PER_IP.value }, LAWS.C_CONN.value)),
  };
}
const { SL_RATE, SL_CONN } = realTables();

// ---------------------------------------------------------------------------------------------------------------
// Shapes

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// The value of an own DATA property, never calling a getter (a hand-made payload in a direct call could carry one).
function field(obj, key) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d && Object.prototype.hasOwnProperty.call(d, 'value') ? d.value : undefined;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// 0, 1, false or true -> the boolean; anything else null.
function flag(v) {
  if (v === 1 || v === true) return true;
  if (v === 0 || v === false) return false;
  return null;
}

// A Buffer or Uint8Array (socket.io hands a binary attachment to a node handler as a Buffer).
function bytesOf(v) {
  return v instanceof Uint8Array ? v : null;
}

// sl:diag: a fresh object with only the known fields, each checked; null when nothing usable came.
function cleanDiag(msg, nameMax) {
  const out = {};
  let any = false;
  for (const k of DIAG_NUMBERS) {
    const v = field(msg, k);
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= INT32_MAX) {
      out[k] = v;
      any = true;
    }
  }
  const lc = field(msg, 'lastClose');
  if (typeof lc === 'string' && lc.length <= nameMax && /^[A-Za-z0-9_:-]*$/.test(lc)) {
    out.lastClose = lc;
    any = true;
  }
  return any ? out : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Addresses (agar's, server/ag/agSockets.js:59-112, copied: requiring agSockets would load agar's paid door)

// The client address under 'trust proxy' 1: the last X-Forwarded-For entry when the header is there, else the
// socket's own address.
function clientIp(socket) {
  const hs = socket && socket.handshake;
  if (!hs) return '';
  const xff = hs.headers && hs.headers['x-forwarded-for'];
  let ip = '';
  if (typeof xff === 'string' && xff) {
    const at = xff.lastIndexOf(',');
    ip = xff.slice(at + 1).trim();
  }
  if (!ip) ip = typeof hs.address === 'string' ? hs.address : '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// Open sockets per address.
function createConnGate(limit, ipOf) {
  const open = new Map();
  const held = new WeakMap(); // socket -> the address it was counted under
  return {
    full(socket) {
      return (open.get(ipOf(socket)) || 0) >= limit;
    },
    add(socket) {
      if (held.has(socket)) return true;
      const ip = ipOf(socket);
      const n = open.get(ip) || 0;
      if (n >= limit) return false;
      open.set(ip, n + 1);
      held.set(socket, ip);
      return true;
    },
    remove(socket) {
      if (!held.has(socket)) return;
      const ip = held.get(socket);
      held.delete(socket);
      const n = (open.get(ip) || 0) - 1;
      if (n > 0) open.set(ip, n);
      else open.delete(ip);
    },
    count(ip) {
      return open.get(ip) || 0;
    },
    addresses() {
      return open.size;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The input window (C_RATE_INPUT): exact sums over the last windowMs, one entry per emit.

function createInputMeter(input) {
  const maxRecs = input.recordsPerSec * input.windowMs / 1000;
  const maxBytes = input.bytesPerSec * input.windowMs / 1000;
  const at = [];
  const recs = [];
  const bytes = [];
  let head = 0;
  let sumRecs = 0;
  let sumBytes = 0;
  return {
    // One emit; true when the window is now over a limit (sustained abuse).
    add(now, nRecs, nBytes) {
      while (head < at.length && at[head] <= now - input.windowMs) {
        sumRecs -= recs[head];
        sumBytes -= bytes[head];
        head++;
      }
      if (head > 1024 && head * 2 > at.length) {
        at.splice(0, head);
        recs.splice(0, head);
        bytes.splice(0, head);
        head = 0;
      }
      at.push(now);
      recs.push(nRecs);
      bytes.push(nBytes);
      sumRecs += nRecs;
      sumBytes += nBytes;
      return sumRecs > maxRecs || sumBytes > maxBytes;
    },
    sums: () => ({ records: sumRecs, bytes: sumBytes }),
  };
}

// C_PUSH: at most one push per name per perNameMs and maxPerWindow in any windowMs.
function createPushGate(push) {
  const lastByName = new Map();
  const times = [];
  return {
    allow(name, now) {
      for (const [n, t] of lastByName) if (now - t >= push.perNameMs) lastByName.delete(n);
      while (times.length && now - times[0] >= push.windowMs) times.shift();
      if (lastByName.has(name)) return false;
      if (times.length >= push.maxPerWindow) return false;
      lastByName.set(name, now);
      times.push(now);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------

// sl:x refusal, then the disconnect (SERVER-DESIGN 12.1).
function refuse(socket, why, stats) {
  if (!socket) return;
  if (stats) stats.refused[why] = (stats.refused[why] || 0) + 1;
  try {
    if (typeof socket.emit === 'function') socket.emit('sl:x', [{ t: 'refused', why }]);
  } catch (e) { /* closing it is what matters */ }
  try {
    if (typeof socket.disconnect === 'function') socket.disconnect(true);
  } catch (e) { /* already gone */ }
}

function attachSlSockets(nsp, arenas, helpers) {
  const h = helpers || {};
  const socketRL = h.socketRL;
  if (typeof socketRL !== 'function') throw new TypeError('slSockets: helpers.socketRL must be a function');
  if (!arenas || !arenas.laws) throw new TypeError('slSockets: arenas with a law table is required');
  const ops = h.ops || null;
  const log = h.log || console;
  const now = typeof h.now === 'function' ? h.now : Date.now;
  const timers = h.timers || REAL_TIMERS; // the pending sl:vis timer (tests pass fake timers)
  const notifyJoin = typeof h.notifyJoin === 'function' ? h.notifyJoin : null;
  const ipOf = typeof h.clientIp === 'function' ? h.clientIp : clientIp;
  const L = sockLaws(arenas.laws);
  const gate = createConnGate(L.perIp, ipOf);
  const pushGate = createPushGate(L.push);
  const seed = typeof h.seed === 'number' && Number.isFinite(h.seed) ? h.seed : (Date.now() % 2147483647);
  const skinRng = createRng(streamSeed(seed, 'conn'));
  const safeStats = createSafeStats();
  const states = new Map(); // socket id -> per-socket state
  const stats = { connects: 0, joins: 0, refused: {}, guarded: 0, floods: 0, inputEmits: 0, inputBytes: 0,
    inputRecords: 0, inputDropped: 0, pushes: 0, backs: 0, backsBad: 0, takeovers: 0, safe: safeStats };
  const badKeys = createBadKeyGate(L.resume.badKeys, ipOf);

  function limited(socket, kind) {
    return socketRL(socket, 'sl' + kind, L.rate[kind]);
  }

  function stateOf(socket) {
    return states.get(socket.id) || null;
  }

  function skinOf(socket) {
    const hs = socket.handshake;
    const auth = hs && isPlainObject(hs.auth) ? hs.auth : null;
    const cv = auth ? field(auth, 'cv') : undefined;
    // -0 is an integer and the Set matches it to 0, but the wire cannot carry it (slWire refuses snake_add.cv -0)
    if (Number.isInteger(cv) && L.skins.has(cv)) return cv === 0 ? 0 : cv;
    return skinRng.int(L.badSkinCount);
  }

  // sl:join {nick}: once per socket; a money field refused before anything else is read.
  function onJoin(socket, msg) {
    const st = stateOf(socket);
    if (!st || st.joined) return;
    if (msg !== undefined && !isPlainObject(msg)) return;
    if (msg !== undefined) {
      for (const k of MONEY_FIELDS) if (hasOwn(msg, k)) return refuse(socket, 'not-open', stats);
    }
    if (!limited(socket, 'join')) return;
    if (ops && typeof ops.get === 'function') {
      const o = ops.get();
      if (o && o.maintenance) return refuse(socket, 'maintenance', stats);
    }
    if (!arenas.isOpen()) return refuse(socket, 'closed', stats);
    const raw = msg === undefined ? '' : field(msg, 'nick');
    const nick = cleanNick(typeof raw === 'string' ? raw : '', arenas.laws);
    st.joined = true;
    let r;
    try {
      r = arenas.join(socket, { nick, cv: st.cv });
    } catch (e) {
      // a seat that could not be made is a closed door for this socket, never a socket left hanging
      log.error('[SL] join failed', e && e.stack ? e.stack : e);
      r = 'closed';
    }
    if (r !== true) return refuse(socket, REFUSALS.includes(r) ? r : 'closed', stats);
    stats.joins++;
    if (notifyJoin && pushGate.allow(nick, now())) {
      stats.pushes++;
      safeAsync(() => notifyJoin(nick), 'sl.notifyJoin', safeStats, { log });
    }
  }

  // A refusal by the server itself on a socket that may hold a seat: its disconnect must never park the seat.
  function kickOut(socket, st, why) {
    if (st) st.noResume = true;
    refuse(socket, why, stats);
  }

  // sl:back {k, n, p} (task T16b): the layer asks for its life back on this new socket. Once per socket, instead of
  // sl:join. A bad shape or a key no life holds counts against the address (C_RESUME badKeys).
  function onBack(socket, msg) {
    const st = stateOf(socket);
    if (!st || st.joined) return;
    st.joined = true;
    const t = now();
    if (badKeys.blocked(socket, t)) return refuse(socket, 'flood', stats);
    const k = isPlainObject(msg) ? field(msg, 'k') : undefined;
    const n = isPlainObject(msg) ? count(field(msg, 'n')) : null;
    const pv = isPlainObject(msg) ? field(msg, 'p') : undefined;
    const p = pv === undefined ? 0 : count(pv);
    const room = arenas && typeof arenas.room === 'function' ? arenas.room() : null;
    let r = WHY_GONE;
    if (isKey(k) && n !== null && p !== null && room && typeof room.resume === 'function') {
      try {
        r = room.resume(socket, k, n, p);
      } catch (e) {
        log.error('[SL] resume failed', e && e.stack ? e.stack : e);
        r = WHY_GONE;
      }
    }
    if (!r || typeof r !== 'object') {
      if (r !== 'flood') {
        stats.backsBad++;
        badKeys.add(socket, t);
      }
      return refuse(socket, r === 'flood' ? 'flood' : WHY_GONE, stats);
    }
    stats.backs++;
    const old = r.replaced;
    if (old && old !== socket) {
      stats.takeovers++;
      kickOut(old, stateOf(old), WHY_TAKEN);
    }
  }

  // One emit into the window. Every sl:i emit counts at least ONE record (their client sends one record per emit), so
  // empty, undecodable or non-binary emits can never run unmetered (fixer pass, 2026-10-10: 500,000 empty binaries in
  // 10 s were never a flood). True when the socket was refused.
  function meterInput(socket, st, t, nRecs, nBytes) {
    if (!st.meter.add(t, nRecs > 0 ? nRecs : 1, nBytes)) return false;
    stats.floods++;
    log.warn('[SL] input flood from ' + ipOf(socket) + ': ' + JSON.stringify(st.meter.sums()) + ' in the window');
    kickOut(socket, st, 'flood');
    return true;
  }

  // sl:i: one input bundle. Size checked; every emit counts toward the window; never thinned.
  function onInput(socket, data) {
    const st = stateOf(socket);
    if (!st) return;
    const b = bytesOf(data);
    const t = now();
    if (!b) {
      stats.inputDropped++;
      meterInput(socket, st, t, 0, 0);
      return;
    }
    stats.inputEmits++;
    stats.inputBytes += b.length;
    let nRecs = 0;
    let ok = b.length >= L.input.minBytes && b.length <= L.input.maxBytes;
    if (ok) {
      const recs = W.decodeInput(b);
      for (let i = 0; i < recs.length; i++) {
        if (recs[i].type === 'wire_error') break;
        nRecs++;
      }
      stats.inputRecords += nRecs;
    }
    if (meterInput(socket, st, t, nRecs, b.length)) return;
    if (!ok || nRecs === 0) {
      stats.inputDropped++;
      return;
    }
    arenas.input(socket.id, b);
  }

  function onHold(socket, msg) {
    const st = stateOf(socket);
    if (!st || !isPlainObject(msg)) return;
    const on = flag(field(msg, 'on'));
    if (on === null) return;
    if (on) {
      if (!limited(socket, 'hold')) return;
      st.holdPressed = true;
    } else {
      if (!st.holdPressed) return;
      st.holdPressed = false;
    }
    arenas.hold(socket.id, on);
  }

  // sl:vis is a STATE (fixer pass, 2026-10-10): the layer sends it once per change and never again (slxNet sendVis), so
  // a {hidden: 1} inside C_RATE.vis of the last applied one is kept PENDING and applied when the window ends, never
  // dropped; a {hidden: 0} that arrives first cancels it (the newest state wins). Dropping it left the server sure a
  // hidden tab was visible after a quick hidden, visible, hidden flick.
  function stopVisPending(st) {
    if (st.visTimer) st.visTimer.stop();
    st.visTimer = null;
    st.visPending = false;
  }

  function applyHidden(socket, st) {
    if (!limited(socket, 'vis')) {
      st.visPending = true;
      if (!st.visTimer) {
        st.visTimer = safeTimeout(() => {
          st.visTimer = null;
          if (!st.visPending || stateOf(socket) !== st) return;
          st.visPending = false;
          if (!st.hidden) applyHidden(socket, st);
        }, L.rate.vis, 'sl.vis.pending', safeStats, { log, timers });
      }
      return;
    }
    stopVisPending(st);
    st.hidden = true;
    arenas.vis(socket.id, true);
  }

  function onVis(socket, msg) {
    const st = stateOf(socket);
    if (!st || !isPlainObject(msg)) return;
    const hidden = flag(field(msg, 'hidden'));
    if (hidden === null) return;
    if (hidden) {
      if (st.hidden) return; // already hidden: nothing changes
      applyHidden(socket, st);
      return;
    }
    if (st.visPending) {
      stopVisPending(st); // the hidden never applied: the server already counts the tab visible
      return;
    }
    if (!st.hidden) return;
    st.hidden = false;
    arenas.vis(socket.id, false);
  }

  function onChat(socket, msg) {
    const st = stateOf(socket);
    if (!st || !st.joined || !isPlainObject(msg)) return;
    const text = field(msg, 'text');
    if (typeof text !== 'string') return;
    if (!limited(socket, 'chat')) return;
    arenas.chat(socket.id, text);
  }

  function onDiag(socket, msg) {
    const st = stateOf(socket);
    if (!st || !isPlainObject(msg)) return;
    const d = cleanDiag(msg, L.nameMax);
    if (!d) return;
    if (!limited(socket, 'diag')) return;
    arenas.diag(socket.id, d);
  }

  // C_SL_PER_IP counts live snakes, not only open sockets (fixer pass, 2026-10-10): a seat's snake that glides after a
  // leave or a disconnect (C_DISCONNECT) stays charged to its address until the glide ends, so join-then-close cycles
  // from one address never hold more than C_SL_PER_IP sockets plus gliding snakes.
  function settle(socket, st) {
    if (st.charged && !st.open && !st.gliding) {
      st.charged = false;
      gate.remove(socket);
    }
  }

  // Unseats through call(onEnd); returns nothing. The charge is held while the room says the snake glides.
  function unseatCharged(socket, st, call) {
    const was = st.gliding;
    st.gliding = true;
    const r = call(() => {
      st.gliding = false;
      settle(socket, st);
    });
    if (r !== 'glide') st.gliding = was;
  }

  function onLeave(socket) {
    const st = stateOf(socket);
    if (!st) return;
    if (!limited(socket, 'leave')) return;
    unseatCharged(socket, st, (onEnd) => arenas.leave(socket.id, onEnd));
  }

  function guard(name, fn) {
    return function () {
      try {
        fn.apply(null, arguments);
      } catch (e) {
        stats.guarded++;
        try {
          log.error('[SL] handler ' + name, e && e.stack ? e.stack : e);
        } catch (_) { /* a broken logger never throws out */ }
      }
    };
  }

  // Handlers take only the first argument and never call an acknowledgement a client may have asked for.
  function attach(socket) {
    socket.on('sl:join', guard('sl:join', (msg) => onJoin(socket, msg)));
    socket.on('sl:back', guard('sl:back', (msg) => onBack(socket, msg)));
    socket.on('sl:i', guard('sl:i', (data) => onInput(socket, data)));
    socket.on('sl:hold', guard('sl:hold', (msg) => onHold(socket, msg)));
    socket.on('sl:vis', guard('sl:vis', (msg) => onVis(socket, msg)));
    socket.on('sl:chat', guard('sl:chat', (msg) => onChat(socket, msg)));
    socket.on('sl:diag', guard('sl:diag', (msg) => onDiag(socket, msg)));
    socket.on('sl:leave', guard('sl:leave', () => onLeave(socket)));
    // socket.io runs an event's handler on the next tick and drops it when the socket closed in between
    // (node_modules/socket.io/dist/socket.js dispatch: 'ignore packet received after disconnection'). Their client
    // ends a life with emit('sl:leave') then disconnect() (public/js/sl/slNet.js:181-182), and both packets arrive in
    // one batch, so the leave handler never ran and the seat was PARKED as a drop: 646 parks in 1,923 lives with 36
    // blips in a 16 minute soak (2026-10-11). onAny runs at once, before the DISCONNECT packet: the socket is marked
    // and its disconnect is a leave. A close with no sl:leave (a blip, the layer dropping a resume attempt) still parks.
    socket.onAny(guard('sl:leave.mark', (name) => {
      if (name !== 'sl:leave') return;
      const st = stateOf(socket);
      if (st) st.leaving = true;
    }));
    socket.on('disconnect', guard('disconnect', () => {
      const st = stateOf(socket);
      if (!st) {
        gate.remove(socket);
        return;
      }
      stopVisPending(st);
      states.delete(socket.id);
      st.open = false;
      // a socket the server ended itself leaves (never parked for a resume); any other drop may come back (T16b)
      if (st.noResume || st.leaving) unseatCharged(socket, st, (onEnd) => arenas.leave(socket.id, onEnd));
      else unseatCharged(socket, st, (onEnd) => arenas.disconnect(socket.id, onEnd));
      settle(socket, st);
    }));
    guard('connect', () => {
      stats.connects++;
      if (!gate.add(socket)) return refuse(socket, 'limit', stats);
      states.set(socket.id, {
        cv: skinOf(socket),
        joined: false,
        holdPressed: false,
        hidden: false,
        visPending: false,
        visTimer: null,
        charged: true, // gate.add counted this socket under its address
        open: true,
        gliding: false,
        noResume: false, // the server refused this socket itself: its disconnect is a leave (T16b)
        leaving: false, // an sl:leave arrived: its disconnect is a leave even if socket.io dropped the handler
        meter: createInputMeter(L.input),
      });
    })();
  }

  // The handshake gate on the namespace: an address at the cap never gets a connection (io.use on the main
  // namespace does not cover /sl). A refused handshake fails with { why: 'limit' }.
  function admit(socket, next) {
    let over = false;
    try {
      over = gate.full(socket);
    } catch (e) {
      log.error('[SL] connection gate', e && e.stack ? e.stack : e);
    }
    if (!over) return next();
    stats.refused.limit = (stats.refused.limit || 0) + 1;
    const err = new Error('too many connections from this address');
    err.data = { why: 'limit' };
    return next(err);
  }

  if (nsp && typeof nsp.use === 'function') nsp.use(admit);
  if (nsp && typeof nsp.on === 'function') nsp.on('connection', (socket) => safeCall(() => attach(socket), 'sl.attach', safeStats, { log }));

  return { attach, admit, gate, badKeys, stats, laws: L, sockets: () => states.size };
}

module.exports = {
  attachSlSockets,
  sockLaws,
  SOCK_LAW_IDS,
  SL_RATE,
  SL_CONN,
  MONEY_FIELDS,
  REFUSALS,
  isPlainObject,
  field,
  clientIp,
  createConnGate,
  createInputMeter,
  createPushGate,
  cleanDiag,
  refuse,
};
