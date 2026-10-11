'use strict';
// slither.io free room: one ordered send queue per seat (SERVER-DESIGN 9, SERVER-BUILD-BRIEF 7 and D1 to D4; task T9).
//
// Bundles stay RELIABLE and ordered (the stream is incremental: one lost move corrupts a body). The backlog that
// backed phones up in the old game is prevented a different way: every record for a seat waits in ONE ordered queue
// here and leaves only when the transport can take it at once.
//
// What the queue holds, in order: wire records (bytes of one slWire event each, slRecordCache), each tagged with its
// tick and kind and with the snake, sector or prey it adds or removes; plus, beside them, the layer messages (sl:x)
// of the same ticks. A flush emits the sl:x batch first, then ONE sl:f bundle of every queued record, oldest first
// (SERVER-DESIGN 5.3 step 10, C10). Nothing ever skips the queue (D2): a pong or an own wanted-angle echo that
// overtook an older queued own rotation would leave the client on a stale wang (slApply.js:567-570).
//
// ready() = transport.writable && conn.writeBuffer.length === 0 && !ackLate() (D1). engine.io 6.6.11 flushes its
// writeBuffer only while the transport is writable (engine.io/build/socket.js:415-433), and long-polling is writable
// only while a GET is parked (transports/polling.js:77-78), so an empty writeBuffer alone does not mean "the client
// can take data now". Flush points: the end of each wake (the room), the transport's 'ready' event (bound here,
// re-bound on engine.io 'upgrade'), and the setImmediate after an arrival (the room).
//
// CORK (found in this task, engine.io 6.6.11 + socket.io 4.8.4): socket.io writes a binary event as TWO engine.io
// packets (the header and the attachment, socket.io/dist/client.js:172-183), and engine.io flushes after EVERY packet
// (socket.js:386-408). On polling the first flush answers the parked GET (polling.js:193-194 sets writable false at
// once), so the attachment, and any second event, wait for the NEXT poll: every binary emit costs one extra poll round
// trip. A flush here therefore marks the transport not writable while it emits sl:x and sl:f, then restores it and
// calls engine.io's own flush once: one transport.send, one poll response, every packet. Pinned by the engine.io
// version test and by a real polling test (test/slSendQueue.test.js).
//
// ackLate (C_ACK_LATE_MS, SERVER-DESIGN 9.1, C7): on WebSocket engine.io empties writeBuffer as soon as ws takes the
// write, and the kernel send buffer can hide seconds of stream before writable ever goes false. Their client pings
// again only after the pong AND 250 ms after its previous ping (slInput.js:257-265), so "no pong owed and the last
// pong left more than max(minMs, pingMult x the median ping interval) ago" means the downstream is late. It holds data
// here (where it coalesces); it never counts toward the stall kick, and it is off while the layer says the tab is
// hidden (a hidden tab stops pinging, slLoop.js:632-637).
// One more condition (fixer pass, 2026-10-10): some other upstream message (an input, hold, vis, chat or diag; the
// room calls heard()) arrived MORE than that limit after the last pong left. A lost upstream segment holds back every
// upstream byte behind it (TCP head of line; polling sends one POST at a time), so a late ping alone cannot tell a
// late downstream from a late upstream, and holding on upstream loss froze a healthy downstream (real socket.io on
// WebSocket, 300 ms round trip, 2 percent of upstream writes 600 ms late: bundle gap max 935 ms against 222 ms for the
// same seat with ackLate off). A message that arrives after the deadline while the ping does not was sent after a
// healthy client would have pinged, so the client has not had the pong: the downstream is late. With no other
// upstream traffic (a still mouse) nothing is held, and transport.writable, the cap and the resync still apply.
//
// Coalescing (9.2): latest-value records (leaderboard, flux) are replaced in place; a minimap whose older queued
// minimap never left is sent as its full form (the view passes the M bytes as alt), since a V against an image the
// client never got would be wrong.
//
// Resync (9.3, D4, C5): above C_PENDING_CAP bytes the queue drops every record EXCEPT own-snake records, pongs, own
// echoes and every REMOVAL, and queues removals for the union of what was delivered and what the dropped records
// added (own snake excepted; a removal of an id the client does not hold is a no-op, slApply.js:971-990,
// 1156-1164). The room then resets the seat's view so it re-adds everything. One resync per C_RESYNC_GAP_MS; a
// second cap hit inside it is a stall kick.
//
// Stall kick: the TRANSPORT not ready (writable false or writeBuffer not empty; never ackLate) for longer than
// C_STALL_KICK_MS: socket.disconnect(true). The clock starts at the first wake that finds it not ready and resets
// whenever the transport is seen ready: at a wake, at a flush that sends, AND at its 'ready' event (fixer pass,
// 2026-10-10). On polling the transport is ready only while a GET is parked, and the queue's own 'ready' listener
// answers each GET the moment it lands (the queue holds that tick's own records), so with a round trip above one tick
// no GET is ever parked at a wake; a clock reset only at wakes kicked every healthy phone seat 15 s into its life
// (real socket.io through a delay proxy: polling at 150 and 300 ms round trip, kicked 'stall' at 15.1 and 15.3 s).
// A GET arriving is the client taking data, so it is proof of a live transport.
//
// Resume after a blip (task T16b, server/sl/slResume.js). A seat whose socket dropped is DETACHED, not closed: it keeps
// queueing (the room still collects its view, so no own record of the glide is ever skipped), never flushes, never
// stall-kicks, and over the cap it resyncs (never a cap kick: nobody is reading yet). Lost bundles are the problem: a
// flush hands bytes to engine.io, and on a dead link the client never gets them, so the own records in them would be
// gone and the client's own body would be wrong for the rest of the life. So every flushed bundle gets a sequence
// number (sentSeq, one per sl:f) and its records the client must not miss (own records, echoes, pongs and removals:
// the KEPT kinds of a resync) are RETAINED, plus the ids an OTHER record took off the client (prey_eaten), until the
// client proves it got them. The proof costs nothing on the wire: their client keeps one ping in flight and pings again
// only after the pong arrived (public/js/sl/slInput.js:257-265), so a ping arriving now proves the bundle that carried
// the previous pong (and every bundle before it, the stream is ordered) was received. Retention is capped at
// C_PENDING_CAP bytes (oldest first; a hidden tab stops pinging); a resume from before what was dropped is refused.
// On resume(n) the retained records of every bundle after n go back to the FRONT of the queue (older than what queued
// while detached), the ids the lost bundles took off are put back in the delivered set, a pong is added when the
// client sent a ping the server never heard (p, at most one: one ping in flight), and the normal resync (9.3) runs:
// every other record dropped, removals for what the client may hold, the room re-adds the view. The client's counter
// and sentSeq agree again (sentSeq = n: the lost bundles' records now ride in new ones).
// Layer messages are not part of the counted stream (an sl:x may leave with no sl:f). The few a life must not miss
// (the room's 'cashed', which titles the card) are queued with keep: they are retained with the sl:f they led, and a
// resume puts the ones of lost bundles back at the head of the next sl:x, right after the room's 'back'.

const { bundleBytes, encodeRecord } = require('./slRecordCache');
const { assertLawsComplete, STATUS } = require('./slLaws');
const { safeCall } = require('./slSafe');

// The engine.io version this file's readiness and cork reasoning was checked against (test/slSendQueue.test.js reads
// node_modules/engine.io/package.json and fails on any other version).
const ENGINE_IO_VERSION = '6.6.11';

const QUEUE_TABLE_IDS = Object.freeze(['L6', 'C_PENDING_CAP', 'C_RESYNC_GAP_MS', 'C_STALL_KICK_MS', 'C_ACK_LATE_MS']);

// Our own row the queue needs that the law table does not hold (the slSim WORLD_ROWS precedent; slLaws.js is not
// this task's file). The table wins when it has the id. T1 follow-up: copy it into slLaws.js and SERVER-LAWS N.
const QUEUE_ROWS = Object.freeze({
  C_PING_WINDOW: Object.freeze({
    id: 'C_PING_WINDOW',
    name: 'ackLate and the hold safety net read the median and p95 of this many most recent ping intervals of the seat',
    status: STATUS.CHOSEN,
    value: 32,
    unit: 'intervals',
    source: 'CHOSEN: engineering (task T9, BUILD-DECISIONS). C_ACK_LATE_MS says "median ping interval" with no ' +
      'window; 32 intervals is at least 8 s at their fastest ping (one per 250 ms, slInput.js:257-265), so one slow ' +
      'ping does not move it, and a seat that changed network shows within a few seconds. A player cannot see it.',
  }),
});
const QUEUE_ROW_IDS = Object.freeze(Object.keys(QUEUE_ROWS));
const QUEUE_LAW_IDS = Object.freeze(QUEUE_TABLE_IDS.concat(QUEUE_ROW_IDS));

const EV_FRAME = 'sl:f';
const EV_LAYER = 'sl:x';

// Record kinds. Kept on a resync: OWN, ECHO, PONG, REMOVE. Dropped: ADD, LATEST, MAP, OTHER.
const KIND = Object.freeze({
  OWN: 1,     // init, the own snake's records, dead, kill_count
  ECHO: 2,    // the own wanted-angle echo of an input (5.2); at most one queued, a newer one replaces it
  PONG: 3,    // one per ping (L47)
  REMOVE: 4,  // snake_remove (either code), sector_remove, prey_remove
  ADD: 5,     // snake_add (others), food_sector, prey_add
  LATEST: 6,  // leaderboard, flux: only the newest matters
  MAP: 7,     // minimap
  OTHER: 8,   // every other record (others' moves, food, eats, prey moves)
});
const KEPT = new Set([KIND.OWN, KIND.ECHO, KIND.PONG, KIND.REMOVE]);

const SNAKE = 1;
const SECTOR = 2;
const PREY = 3;

function sectorKey(sx, sy) {
  return sx * 256 + sy;
}

// The kind of one event for a seat whose own snake is ownId, and what it adds or removes.
// Returns [kind, what (0 | SNAKE | SECTOR | PREY), op (0 none, 1 add, -1 remove), ref, latestKey].
function tagOf(ev, ownId) {
  switch (ev.type) {
    case 'init':
    case 'dead':
    case 'kill_count':
      return [KIND.OWN, 0, 0, 0, null];
    case 'pong':
      return [KIND.PONG, 0, 0, 0, null];
    case 'snake_add':
      return ev.id === ownId ? [KIND.OWN, SNAKE, 1, ev.id, null] : [KIND.ADD, SNAKE, 1, ev.id, null];
    case 'snake_remove':
      return [KIND.REMOVE, SNAKE, -1, ev.id, null];
    case 'snake_rot':
    case 'snake_move':
    case 'snake_fam':
    case 'snake_tail':
      return ev.id === ownId || ev.own === true ? [KIND.OWN, 0, 0, 0, null] : [KIND.OTHER, 0, 0, 0, null];
    case 'food_sector':
      return [KIND.ADD, SECTOR, 1, sectorKey(ev.sx, ev.sy), null];
    case 'food_add':
      // a food into a watched sector that never had a dump (L8.emptySector) puts that sector on the client too, so a
      // resync must remove it before the view dumps it again (task T14: without this the client kept a second copy of
      // every such food after a resync, seen as ghost foods in slMirror); dropped on a resync like any OTHER record
      return [KIND.OTHER, SECTOR, 1, sectorKey(ev.sx, ev.sy), null];
    case 'sector_remove':
      return [KIND.REMOVE, SECTOR, -1, sectorKey(ev.sx, ev.sy), null];
    case 'prey_add':
      return [KIND.ADD, PREY, 1, ev.id, null];
    case 'prey_remove':
      return [KIND.REMOVE, PREY, -1, ev.id, null];
    case 'prey_eaten':
      // the client drops an eaten prey (slApply.js:1156-1164), so delivery takes it out of the delivered set and a later
      // resync never sends prey_remove for it (task T15 found 4 in a 30 minute run; their server never sends that). Kept
      // OTHER: a resync may drop it, and the resync then removes the prey itself.
      return [KIND.OTHER, PREY, -1, ev.id, null];
    case 'leaderboard':
      return [KIND.LATEST, 0, 0, 0, 'l'];
    case 'flux':
      return [KIND.LATEST, 0, 0, 0, 'z'];
    case 'minimap':
      return [KIND.MAP, 0, 0, 0, null];
    default:
      return [KIND.OTHER, 0, 0, 0, null];
  }
}

function queueTable(laws) {
  assertLawsComplete(laws, QUEUE_TABLE_IDS);
  const t = {};
  for (const id of QUEUE_TABLE_IDS) t[id] = laws[id];
  for (const id of QUEUE_ROW_IDS) t[id] = Object.prototype.hasOwnProperty.call(laws, id) ? laws[id] : QUEUE_ROWS[id];
  return t;
}

function posInt(v, id) {
  if (!Number.isInteger(v) || v <= 0) throw new Error('slSendQueue: law ' + id + ' must be a whole number above 0');
  return v;
}

function posNum(v, id) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error('slSendQueue: law ' + id + ' must be above 0');
  return v;
}

// Every number the queue reads, once.
function queueLaws(laws) {
  const t = queueTable(laws);
  const v = (id) => t[id].value;
  const pv = v('L6');
  if (!pv || !Number.isInteger(pv.protocol)) throw new Error('slSendQueue: law L6 has no protocol');
  const ack = v('C_ACK_LATE_MS');
  if (!ack || typeof ack !== 'object') throw new Error('slSendQueue: law C_ACK_LATE_MS is not {minMs, pingMult}');
  for (const k of Object.keys(ack)) if (k !== 'minMs' && k !== 'pingMult') throw new Error('slSendQueue: C_ACK_LATE_MS parameter ' + k + ' is not built');
  return Object.freeze({
    pv: pv.protocol,
    cap: posInt(v('C_PENDING_CAP'), 'C_PENDING_CAP'),
    resyncGapMs: posNum(v('C_RESYNC_GAP_MS'), 'C_RESYNC_GAP_MS'),
    stallKickMs: posNum(v('C_STALL_KICK_MS'), 'C_STALL_KICK_MS'),
    ackMinMs: posNum(ack.minMs, 'C_ACK_LATE_MS'),
    ackPingMult: posNum(ack.pingMult, 'C_ACK_LATE_MS'),
    pingWindow: posInt(v('C_PING_WINDOW'), 'C_PING_WINDOW'),
  });
}

// Linear-interpolation quantile of the first n values of a (sorted copy taken here).
function quantileOf(a, n, p, scratch) {
  if (n <= 0) return NaN;
  for (let i = 0; i < n; i++) scratch[i] = a[i];
  const s = scratch.subarray(0, n).sort();
  const x = (n - 1) * p;
  const lo = Math.floor(x);
  const hi = Math.ceil(x);
  return s[lo] + (s[hi] - s[lo]) * (x - lo);
}

// Emits the events so every engine.io packet of them leaves in ONE transport.send (see CORK in the header). Without a live engine.io
// connection (tests with a bare emitter), the events are emitted in order.
function corkedEmit(socket, names, datas) {
  const conn = socket && socket.conn;
  const t = conn && conn.transport;
  // a binary event alone is already two engine.io packets, so even one event is corked
  const cork = names.length > 0 && !!t && t.writable === true && typeof conn.flush === 'function';
  if (cork) t.writable = false;
  try {
    for (let i = 0; i < names.length; i++) socket.emit(names[i], datas[i]);
  } finally {
    if (cork) {
      t.writable = true;
      conn.flush();
    }
  }
}

function transportReadyOf(socket) {
  const conn = socket && socket.conn;
  if (!conn) return false;
  const t = conn.transport;
  if (!t || t.writable !== true) return false;
  const wb = conn.writeBuffer;
  return !wb || wb.length === 0;
}

// opts:
//   socket   the socket.io socket (emit, disconnect, conn: { transport, writeBuffer, flush, on, removeListener })
//   ownId    the seat's own snake id (0 until it has one; setOwn changes it)
//   stats    shared counters (made when absent)
//   onKick   (reason) after the queue disconnected the socket
//   log      { error } for slSafe
function createSendQueue(laws, opts) {
  const Q = queueLaws(laws);
  const o = opts || {};
  let socket = o.socket;
  if (!socket || typeof socket.emit !== 'function') throw new TypeError('slSendQueue: socket with emit is required');
  const stats = o.stats || {};
  for (const k of ['flushes', 'bundles', 'bytes', 'layerBatches', 'records', 'pongs', 'echoes', 'echoReplaced',
    'latestReplaced', 'mapsToFull', 'resyncs', 'kicks', 'ackLateHolds', 'readyFlushes', 'detaches', 'resumes',
    'replayed', 'pongsAdded', 'retainDropped']) {
    if (typeof stats[k] !== 'number') stats[k] = 0;
  }
  if (!stats.safe) stats.safe = { total: 0, byLabel: {}, last: null };
  const PONG_BYTES = encodeRecord({ type: 'pong' }, false, Q.pv);

  let ownId = Number.isInteger(o.ownId) ? o.ownId : 0;
  const items = []; // { tick, kind, what, op, ref, key, bytes }
  let layer = [];
  let queuedBytes = 0;
  let pongsQueued = 0;
  let echoAt = -1; // index of the queued echo, -1 when none
  let closed = false;
  let hidden = false;
  let lastPongAt = NaN;
  let lastPingAt = NaN;
  let lastHeardAt = NaN; // the newest upstream arrival of any kind (heard)
  let notReadySince = NaN;
  let lastResyncAt = -Infinity;
  const pingGaps = new Float64Array(Q.pingWindow);
  const scratch = new Float64Array(Q.pingWindow);
  let pingN = 0;
  let pingHead = 0;
  let reportedRttP95 = NaN;

  const delivered = { snakes: new Set(), sectors: new Set(), preys: new Set() };

  // resume (see the header): the bundles sent, the retained records (each item gets .seq), the proof by ping
  let detached = false;
  let sentSeq = 0; // sl:f bundles emitted for this seat, over every socket it had
  let lastPongSeq = 0; // the newest bundle that carried a pong
  let pingsHeard = 0;
  const kept = []; // retained items, oldest first from keptHead
  let keptHead = 0;
  let keptBytes = 0;
  let lostThrough = 0; // retained records of bundles up to this seq were dropped: a resume needs n >= it
  const sticky = new WeakSet(); // layer messages queued with keep (see the header)
  let keptLayer = []; // { seq, msg }: the sticky messages that led a sent bundle, oldest first

  function setOf(what) {
    return what === SNAKE ? delivered.snakes : what === SECTOR ? delivered.sectors : delivered.preys;
  }

  function add(item) {
    items.push(item);
    queuedBytes += item.bytes.length;
  }

  function removeAt(i) {
    const it = items[i];
    items.splice(i, 1);
    queuedBytes -= it.bytes.length;
    if (echoAt > i) echoAt--;
    else if (echoAt === i) echoAt = -1;
    return it;
  }

  // One record. ev is the event (for its tag), bytes its record for this seat. alt: for a minimap, the full M
  // record's bytes, used when an older queued minimap is replaced.
  function push(tick, ev, bytes, alt) {
    if (closed) return false;
    if (!(bytes instanceof Uint8Array)) throw new TypeError('slSendQueue: record bytes must be a Uint8Array');
    const tag = tagOf(ev, ownId);
    const kind = tag[0];
    if (kind === KIND.LATEST) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].key === tag[4]) {
          queuedBytes += bytes.length - items[i].bytes.length;
          items[i].bytes = bytes;
          items[i].tick = tick;
          stats.latestReplaced++;
          return true;
        }
      }
    } else if (kind === KIND.MAP) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === KIND.MAP) {
          if (alt instanceof Uint8Array) {
            removeAt(i);
            add({ tick, kind, what: 0, op: 0, ref: 0, key: null, bytes: alt });
            stats.mapsToFull++;
            return true;
          }
          break; // no full form given: both go, in order (still correct)
        }
      }
    }
    add({ tick, kind, what: tag[1], op: tag[2], ref: tag[3], key: tag[4], bytes });
    stats.records++;
    return true;
  }

  // The own wanted-angle echo of an input (SERVER-DESIGN 5.2 step 3). An echo still queued is replaced by the newer
  // one, which goes LAST, after every older own rotation record, so the client ends on the newest wang.
  function echo(tick, bytes) {
    if (closed) return false;
    if (echoAt >= 0) {
      removeAt(echoAt);
      stats.echoReplaced++;
    }
    add({ tick, kind: KIND.ECHO, what: 0, op: 0, ref: 0, key: null, bytes });
    echoAt = items.length - 1;
    stats.echoes++;
    return true;
  }

  // A ping arrived (L47): its pong joins the queue now, in order with everything else. The ping is also the client's
  // proof it got the bundle of the previous pong (see the header): the records retained up to it are let go.
  function pong(tick, nowMs) {
    if (closed) return false;
    pingsHeard++;
    confirm(lastPongSeq);
    if (Number.isFinite(lastPingAt) && nowMs >= lastPingAt) {
      pingGaps[pingHead] = nowMs - lastPingAt;
      pingHead = (pingHead + 1) % pingGaps.length;
      if (pingN < pingGaps.length) pingN++;
    }
    lastPingAt = nowMs;
    add({ tick, kind: KIND.PONG, what: 0, op: 0, ref: 0, key: null, bytes: PONG_BYTES });
    pongsQueued++;
    stats.pongs++;
    return true;
  }

  // A layer message (sl:x) of this tick. keep: retained like an own record until a ping proves it arrived (resume).
  function message(tick, msg, keep) {
    if (closed) return false;
    layer.push(msg);
    if (keep === true && msg !== null && typeof msg === 'object') sticky.add(msg);
    return true;
  }

  function medianPingGap() {
    return quantileOf(pingGaps, pingN, 0.5, scratch);
  }

  function pingGapP95() {
    return quantileOf(pingGaps, pingN, 0.95, scratch);
  }

  // The seat's pong round trip p95 for the hold safety net: the layer's own measure when it sent one (sl:diag
  // pongP95), else the p95 of the ping intervals the server saw, which is never below the round trip (their client
  // pings again only after the pong, slInput.js:257-265).
  function rttP95() {
    if (Number.isFinite(reportedRttP95) && reportedRttP95 > 0) return reportedRttP95;
    const g = pingGapP95();
    return Number.isFinite(g) ? g : 0;
  }

  function reportRtt(ms) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) reportedRttP95 = ms;
  }

  function ackLate(nowMs) {
    if (hidden || pongsQueued > 0 || !Number.isFinite(lastPongAt)) return false;
    if (Number.isFinite(lastPingAt) && lastPingAt > lastPongAt) return false;
    const med = medianPingGap();
    const lim = Number.isFinite(med) && Q.ackPingMult * med > Q.ackMinMs ? Q.ackPingMult * med : Q.ackMinMs;
    // the upstream still flows after the deadline (see the header): only then is the missing ping a late downstream
    if (!(Number.isFinite(lastHeardAt) && lastHeardAt - lastPongAt > lim)) return false;
    return nowMs - lastPongAt > lim;
  }

  // Any upstream message of the seat arrived now (the room's _heard: inputs, pings, hold, vis, chat, diag).
  function heard(nowMs) {
    if (typeof nowMs === 'number' && Number.isFinite(nowMs)) lastHeardAt = nowMs;
  }

  function transportReady() {
    return transportReadyOf(socket);
  }

  function ready(nowMs) {
    return !closed && transportReady() && !ackLate(nowMs);
  }

  // Sends everything queued if the transport can take it now. Returns true when something left.
  function flush(nowMs) {
    if (closed) return false;
    if (!items.length && !layer.length) return false;
    if (!transportReady()) return false;
    notReadySince = NaN;
    if (ackLate(nowMs)) {
      stats.ackLateHolds++;
      return false;
    }
    const names = [];
    const datas = [];
    if (layer.length) {
      names.push(EV_LAYER);
      datas.push(layer);
      stats.layerBatches++;
    }
    let sentPong = false;
    if (items.length) {
      const seq = ++sentSeq;
      for (let i = 0; i < layer.length; i++) if (sticky.has(layer[i])) keptLayer.push({ seq, msg: layer[i] });
      const recs = new Array(items.length);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        recs[i] = it.bytes;
        if (it.kind === KIND.PONG) sentPong = true;
        if (it.op === 1) setOf(it.what).add(it.ref);
        else if (it.op === -1) setOf(it.what).delete(it.ref);
        // retained until a ping proves the client got this bundle (resume, see the header)
        if (KEPT.has(it.kind) || it.op === -1) {
          it.seq = seq;
          kept.push(it);
          keptBytes += it.bytes.length;
        }
      }
      if (sentPong) lastPongSeq = seq;
      trimKept();
      const bundle = bundleBytes(recs);
      names.push(EV_FRAME);
      datas.push(bundle);
      stats.bundles++;
      stats.bytes += bundle.length;
    }
    items.length = 0;
    queuedBytes = 0;
    echoAt = -1;
    layer = [];
    if (sentPong) {
      lastPongAt = nowMs;
      pongsQueued = 0;
    }
    stats.flushes++;
    corkedEmit(socket, names, datas);
    return true;
  }

  // ------------------------------------------------------------------ resume (task T16b, see the header)

  function compactKept() {
    if (keptHead > 1024 && keptHead * 2 > kept.length) {
      kept.splice(0, keptHead);
      keptHead = 0;
    }
  }

  // Retention over C_PENDING_CAP bytes: the oldest go, and a resume from before them is refused.
  function trimKept() {
    while (keptBytes > Q.cap && keptHead < kept.length) {
      const it = kept[keptHead++];
      keptBytes -= it.bytes.length;
      if (it.seq > lostThrough) lostThrough = it.seq;
      stats.retainDropped++;
    }
    compactKept();
    if (keptLayer.length && keptLayer[0].seq <= lostThrough) keptLayer = keptLayer.filter((e) => e.seq > lostThrough);
  }

  // The client got every bundle up to seq: let their retained records go.
  function confirm(seq) {
    while (keptHead < kept.length && kept[keptHead].seq <= seq) {
      keptBytes -= kept[keptHead].bytes.length;
      keptHead++;
    }
    if (keptHead === kept.length) {
      kept.length = 0;
      keptHead = 0;
    } else {
      compactKept();
    }
    if (keptLayer.length && keptLayer[0].seq <= seq) keptLayer = keptLayer.filter((e) => e.seq > seq);
  }

  // The seat's socket went: nothing is sent until attach(); the queue keeps filling.
  function detach() {
    if (closed || detached) return;
    detached = true;
    unbind();
    socket = null;
    notReadySince = NaN;
    stats.detaches++;
  }

  // A new socket for the seat (a resume): the ack clocks start over, the tab counts as visible (slSockets starts every
  // socket so), and the transport's 'ready' is bound to the new one.
  function attach(sock) {
    if (closed) return false;
    if (!sock || typeof sock.emit !== 'function') throw new TypeError('slSendQueue: attach needs a socket with emit');
    if (socket) unbind();
    socket = sock;
    detached = false;
    hidden = false;
    lastPongAt = NaN;
    lastPingAt = NaN;
    lastHeardAt = NaN;
    notReadySince = NaN;
    pingN = 0;
    pingHead = 0;
    bind();
    return true;
  }

  // Can the stream continue for a client that got n bundles this life (its own count, never trusted beyond this)?
  function canResume(n) {
    return !closed && Number.isInteger(n) && n >= lostThrough && n <= sentSeq;
  }

  // The client got n bundles and sent p pings (see the header). first: layer messages that lead the next sl:x (the
  // room's 'back'). Returns the removal lists the resync queued, or null when n cannot resume.
  function resume(n, p, tick, nowMs, first) {
    if (!canResume(n)) return null;
    const replay = [];
    let bytes = 0;
    for (let i = keptHead; i < kept.length; i++) {
      const it = kept[i];
      if (it.seq <= n) continue;
      // what a lost bundle took off the client, the client still holds: back in the delivered set, so the resync keeps
      // a replayed removal of it (and removes a prey a lost prey_eaten took) instead of reading it as never delivered
      if (it.op === -1) setOf(it.what).add(it.ref);
      if (KEPT.has(it.kind)) {
        replay.push(it);
        bytes += it.bytes.length;
      }
    }
    const again = [];
    for (const e of keptLayer) if (e.seq > n) again.push(e.msg); // sticky layer messages of the lost bundles
    keptLayer = [];
    kept.length = 0;
    keptHead = 0;
    keptBytes = 0;
    lostThrough = n;
    sentSeq = n;
    if (lastPongSeq > n) lastPongSeq = n;
    if (replay.length) {
      items.unshift(...replay);
      queuedBytes += bytes;
      if (echoAt >= 0) echoAt += replay.length;
      for (const it of replay) if (it.kind === KIND.PONG) pongsQueued++;
      stats.replayed += replay.length;
    }
    // a ping the client sent that never arrived (lost with the old socket): its pong, once (one ping in flight)
    if (Number.isInteger(p) && p > pingsHeard) {
      pingsHeard++;
      add({ tick, kind: KIND.PONG, what: 0, op: 0, ref: 0, key: null, bytes: PONG_BYTES });
      pongsQueued++;
      stats.pongsAdded++;
    }
    const lead = Array.isArray(first) ? first.concat(again) : again;
    if (lead.length) layer = lead.concat(layer); // again stays sticky: retained with the bundle it leads now
    const out = resync(tick, nowMs);
    stats.resumes++;
    return out;
  }

  // Called at each wake: the stall clock (transport not ready, never ackLate). Returns true when it kicked.
  function checkStall(nowMs) {
    if (closed || detached) return false; // a detached seat has no transport to wait on (resume)
    if (transportReady()) {
      notReadySince = NaN;
      return false;
    }
    if (!Number.isFinite(notReadySince)) {
      notReadySince = nowMs;
      return false;
    }
    if (nowMs - notReadySince > Q.stallKickMs) {
      kick('stall');
      return true;
    }
    return false;
  }

  // Called after the room queued a wake's records. 'ok', 'resync' (the room resets the seat's view) or 'kick'.
  function checkCap(tick, nowMs) {
    if (closed) return 'kick';
    if (queuedBytes <= Q.cap) return 'ok';
    // detached (resume): nobody reads yet, so the queue only sheds what a resync sheds, never a cap kick
    if (!detached && nowMs - lastResyncAt < Q.resyncGapMs) {
      kick('cap');
      return 'kick';
    }
    resync(tick, nowMs);
    return 'resync';
  }

  // SERVER-DESIGN 9.3: keep own records, echoes, pongs and the removals; then remove everything else the client holds.
  // What it holds is followed through the kept records in queue order (task T8b, 2026-10-11): a dropped add never
  // reaches the client, so it gets no removal; a kept removal settles its id, so it gets no second one; a kept removal
  // of an id the client will not hold (its add was dropped with the rest) is dropped too. Their server never sends a
  // removal of an id its client does not hold (P1; scripts/slLoad.js, the load-test bar, counts one as an unknown id).
  // The union this replaces (delivered plus every id a dropped record added) sent one for every add a resync dropped
  // and a second one for every kept removal: in-process 97 unknown snake and 20 unknown prey removals in 606 resyncs
  // with records queued, and on every cap resync of a backed-up seat (test/slViewResync.test.js). Returns the removal
  // lists it queued.
  function resync(tick, nowMs) {
    const gone = { snakes: new Set(delivered.snakes), sectors: new Set(delivered.sectors), preys: new Set(delivered.preys) };
    const keep = [];
    let echoKeep = -1;
    let bytes = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!KEPT.has(it.kind)) continue; // dropped: it never reaches the client
      if (it.what) {
        const held = it.what === SNAKE ? gone.snakes : it.what === SECTOR ? gone.sectors : gone.preys;
        if (it.op === -1 && !held.delete(it.ref)) continue; // the client will not hold it: no removal
        if (it.op === 1) held.add(it.ref); // a kept own add
      }
      if (it.kind === KIND.ECHO) echoKeep = keep.length;
      keep.push(it);
      bytes += it.bytes.length;
    }
    items.length = 0;
    for (const it of keep) items.push(it);
    queuedBytes = bytes;
    echoAt = echoKeep;
    if (ownId) gone.snakes.delete(ownId);
    const out = { snakes: Array.from(gone.snakes).sort((a, b) => a - b),
      sectors: Array.from(gone.sectors).sort((a, b) => a - b),
      preys: Array.from(gone.preys).sort((a, b) => a - b) };
    for (const id of out.snakes) {
      const ev = { type: 'snake_remove', id, kill: false };
      push(tick, ev, encodeRecord(ev, false, Q.pv));
    }
    for (const k of out.sectors) {
      const ev = { type: 'sector_remove', sx: Math.floor(k / 256), sy: k % 256 };
      push(tick, ev, encodeRecord(ev, false, Q.pv));
    }
    for (const id of out.preys) {
      const ev = { type: 'prey_remove', id };
      push(tick, ev, encodeRecord(ev, false, Q.pv));
    }
    lastResyncAt = nowMs;
    stats.resyncs++;
    return out;
  }

  function kick(reason) {
    if (closed) return;
    closed = true;
    stats.kicks++;
    unbind();
    items.length = 0;
    layer = [];
    queuedBytes = 0;
    const sock = socket;
    safeCall(() => {
      if (sock && typeof sock.disconnect === 'function') sock.disconnect(true);
    }, 'sl.kick', stats.safe, { log: o.log });
    if (typeof o.onKick === 'function') safeCall(() => o.onKick(reason), 'sl.onKick', stats.safe, { log: o.log });
  }

  // ------------------------------------------------------------------ transport 'ready' (SERVER-DESIGN 9.1 (b))

  let boundTransport = null;
  let boundConn = null;
  const onReady = () => {
    if (closed) return;
    notReadySince = NaN; // a GET landed (polling) or a write completed (WebSocket): the transport takes data
    safeCall(() => {
      if (flush(nowFn())) stats.readyFlushes++;
    }, 'sl.flush.ready', stats.safe, { log: o.log });
  };
  const onUpgrade = () => {
    bindTransport(boundConn && boundConn.transport);
  };
  const nowFn = typeof o.clock === 'function' ? o.clock : () => Date.now();

  function bindTransport(t) {
    if (boundTransport && typeof boundTransport.removeListener === 'function') boundTransport.removeListener('ready', onReady);
    boundTransport = null;
    if (t && typeof t.on === 'function') {
      t.on('ready', onReady);
      boundTransport = t;
    }
  }

  function bind() {
    const conn = socket && socket.conn;
    if (!conn) return;
    boundConn = conn;
    bindTransport(conn.transport);
    if (typeof conn.on === 'function') conn.on('upgrade', onUpgrade);
  }

  function unbind() {
    bindTransport(null);
    if (boundConn && typeof boundConn.removeListener === 'function') boundConn.removeListener('upgrade', onUpgrade);
    boundConn = null;
  }

  function close() {
    closed = true;
    unbind();
    items.length = 0;
    layer = [];
    queuedBytes = 0;
    kept.length = 0;
    keptHead = 0;
    keptBytes = 0;
    keptLayer = [];
  }

  bind();

  return {
    Q,
    push,
    echo,
    pong,
    message,
    flush,
    ready,
    ackLate,
    transportReady,
    checkStall,
    checkCap,
    resync,
    kick,
    close,
    detach,
    attach,
    canResume,
    resume,
    confirm,
    setOwn(id) {
      ownId = Number.isInteger(id) ? id : 0;
    },
    setHidden(h) {
      hidden = !!h;
    },
    reportRtt,
    heard,
    rttP95,
    medianPingGap,
    holdsSnake(id) {
      if (delivered.snakes.has(id)) return true;
      for (let i = 0; i < items.length; i++) if (items[i].what === SNAKE && items[i].op === 1 && items[i].ref === id) return true;
      return false;
    },
    get delivered() {
      return delivered;
    },
    get length() {
      return items.length;
    },
    get layerLength() {
      return layer.length;
    },
    get bytes() {
      return queuedBytes;
    },
    get closed() {
      return closed;
    },
    get detached() {
      return detached;
    },
    get socket() {
      return socket;
    },
    get sentSeq() {
      return sentSeq;
    },
    get keptLength() {
      return kept.length - keptHead;
    },
    get keptBytes() {
      return keptBytes;
    },
    get keptLayerLength() {
      return keptLayer.length;
    },
    get lostThrough() {
      return lostThrough;
    },
    get pingsHeard() {
      return pingsHeard;
    },
    get hidden() {
      return hidden;
    },
    get lastPongAt() {
      return lastPongAt;
    },
    get pongsQueued() {
      return pongsQueued;
    },
    stats,
  };
}

module.exports = {
  ENGINE_IO_VERSION,
  QUEUE_LAW_IDS,
  QUEUE_TABLE_IDS,
  QUEUE_ROWS,
  KIND,
  EV_FRAME,
  EV_LAYER,
  tagOf,
  queueLaws,
  corkedEmit,
  transportReadyOf,
  createSendQueue,
};
