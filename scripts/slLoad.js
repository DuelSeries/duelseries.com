'use strict';
// Wanderer clients for the /sl room (task T15; SERVER-DESIGN 14.1 and 18.4; SERVER-BUILD-BRIEF section 8, row
// scripts/slLoad.js: "decode every bundle; unknown id or wire_error is a failure").
//
// Each wanderer is one player the way the frozen client plays (public/js/sl/slNet.js:133-186): socket.io namespace
// /sl, one connection per life, reconnection off, sl:join {nick} once, one input record per sl:i emit. It steers
// inside the border (a new wanted angle byte every 100 to 250 ms, only when the byte changes, toward the centre past
// 0.6 of the border radius), pings once per pong at most every 250 ms (their slInput.js:257-265 gate), boosts in
// bursts, and now and then holds Q (sl:hold, to a cash-out or let go early), chats, sends sl:diag, drops its
// connection mid-life (a blip: the server's 3 s glide) or leaves, and some lives drive straight out into the border. After its own `dead` it closes 1.6 s later (their
// death timing, OWNER-ANSWERS Q11) and plays again on a new socket.
//
// Every bundle goes through createTracker, a client model of the decoded stream: init first and once, the own snake
// first, every snake and prey id an event names must be held (added and not removed), no double add; foods by cell as
// the client keeps them (an eat must find a food, a cell never gets a second food while it holds one), no wire_error, no kind-15 number and no number off its wire grid (slRecordCache.scanBundle,
// SERVER-BUILD-BRIEF P1). Any of those is a failure.
//
// netem (SERVER-DESIGN 14.2): delay and loss are applied by the Linux test box itself (tc qdisc ... netem), never by
// this script; on a local run the link is clean, so a kick or a refusal is reported as a failure by slSoak.
//
// Usage: node scripts/slLoad.js --url http://127.0.0.1:4409 [--clients 30] [--minutes 10] [--polling 0.5] [--seed 1]
//        [--ip-base 198.18.0.] [--json out.json]
// Forked with --ipc (scripts/slSoak.js): progress and the final report go to the parent; {cmd: 'stop'} ends the run.
// Exit code 1 when any bundle failed.

const W = require('../shared/slWire.js');
const core = require('../shared/slCore.js');
const { scanBundle } = require('../server/sl/slRecordCache');

const PI2 = 2 * Math.PI;
const ANGLE_BYTES = 251; // angle records carry q 0..250 (shared/slWire.js encodeInput, game.js:4728)
const PING_GAP_MS = 250; // their client pings at most every 250 ms, after the pong (slInput.js:257-265)
const DEATH_CLOSE_MS = 1600; // their 1.6 s from the own death to the close (OWNER-ANSWERS Q11)
const DIAG_EVERY_MS = 30000; // sl:diag well under its C_RATE.diag gate (10000 ms)
const SAMPLE_CAP = 20;

// ---------------------------------------------------------------------------------------------------------------
// The client's body arithmetic (public/js/sl/slApply.js), for the own head and for the soak mirror

// The last point of an `s` add body (slApply.js buildBody, game.js:8470-8534): the first point absolute (x / 5),
// each later one a default_msl step along its own 16-bit angle or a half-unit byte offset. -> {x, y, iang} where
// iang is the last point's angle or undefined.
function addEnd(raw, defaultMsl) {
  let x = 0;
  let y = 0;
  let iang;
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (i === 0) {
      x = e.x / 5;
      y = e.y / 5;
      iang = undefined;
    } else if (e.iang !== undefined) {
      iang = e.iang;
      const a = e.iang * core.K64A;
      x += Math.cos(a) * defaultMsl;
      y += Math.sin(a) * defaultMsl;
    } else {
      x += (e.bx - 127) / 2;
      y += (e.by - 127) / 2;
      iang = undefined;
    }
  }
  return { x, y, iang };
}

// Where a move puts the new head point at pv >= 15 (slApply.js headPoint, game.js:7712-7750): + and = carry it
// absolute; g and n step msl along the move's angle or the last point's. -> {x, y, iang}.
function movePoint(ev, last, msl) {
  if (ev.cmd === '+' || ev.cmd === '=') return { x: ev.xx, y: ev.yy, iang: ev.iang };
  const a = ev.iang !== undefined ? ev.iang : last.iang;
  const p = core.headStep(last.x, last.y, a, msl);
  return { x: p[0], y: p[1], iang: a };
}

// ---------------------------------------------------------------------------------------------------------------
// The decoded-stream client model

const FAIL_KINDS = Object.freeze(['wireError', 'kind15', 'offGrid', 'beforeInit', 'badInit', 'unknownSnake',
  'doubleSnake', 'emptyBody', 'noOwn', 'foodForm', 'unknownFood', 'doubleFood', 'unknownPrey', 'doublePrey', 'noAngle',
  'killCount']);

const sectorKey = (sx, sy) => sx * 65536 + sy;

function createTracker() {
  const fail = {};
  for (const k of FAIL_KINDS) fail[k] = 0;
  const samples = [];
  const byType = {};
  const st = { bundles: 0, bytes: 0, events: 0 };
  const snakes = new Set();
  const cells = new Map(); // food id (the cell, slApply.js:1053) -> foods the client holds there, oldest first
  const sectorCells = new Map(); // sector -> Set of cells holding a food
  const preys = new Set();
  const t = {
    init: null, ownId: 0, own: null, ownDead: false, flux: 0, grd: 0, msl: 42, lastSx: -1, lastSy: -1, lastEx: -1,
    lastEy: -1, lastCv: 0,
    fail, samples, byType, st, snakes, cells, sectorCells, preys,
  };

  function bad(kind, what) {
    fail[kind]++;
    if (samples.length < SAMPLE_CAP) samples.push(kind + ': ' + what);
  }
  function needSnake(id, what) {
    if (!snakes.has(id)) bad('unknownSnake', what + ' ' + id);
  }
  // A food arrives (F or food_add): the client pushes it (slApply.js newFood). A second food in a cell it already
  // holds one in is a failure: their eat finds the NEWEST food of an id (slApply.js:1110-1121), so the older one would
  // stay on screen.
  function addFood(sx, sy, rx, ry, rad, cv, what) {
    const id = (sx << 24) | (sy << 16) | (rx << 8) | ry;
    let list = cells.get(id);
    if (list && list.length) bad('doubleFood', what + ' into cell ' + sx + ',' + sy + ',' + rx + ',' + ry + ' that holds a food');
    if (!list) cells.set(id, (list = []));
    list.push({ rad, cv });
    const sk = sectorKey(sx, sy);
    let set = sectorCells.get(sk);
    if (!set) sectorCells.set(sk, (set = new Set()));
    set.add(id);
  }
  // An eat takes the newest food of that id; an eat of a cell the client holds nothing in is a failure.
  function eatFood(sx, sy, rx, ry) {
    const id = (sx << 24) | (sy << 16) | (rx << 8) | ry;
    const list = cells.get(id);
    if (!list || !list.length) {
      bad('unknownFood', 'eat of cell ' + sx + ',' + sy + ',' + rx + ',' + ry);
      return;
    }
    list.pop();
    if (!list.length) {
      cells.delete(id);
      const set = sectorCells.get(sectorKey(sx, sy));
      if (set) set.delete(id);
    }
  }

  function one(ev) {
    byType[ev.type] = (byType[ev.type] || 0) + 1;
    if (ev.type === 'wire_error') {
      bad('wireError', ev.reason + ' at ' + ev.offset);
      return;
    }
    if (!t.init && ev.type !== 'init') {
      bad('beforeInit', ev.type);
      return;
    }
    switch (ev.type) {
      case 'init':
        if (t.init) bad('badInit', 'a second init');
        else if (!(ev.pv >= 15)) bad('badInit', 'pv ' + ev.pv);
        t.init = ev;
        t.grd = ev.grd;
        if (ev.defaultMsl !== undefined) t.msl = ev.defaultMsl;
        if (ev.fluxGrd !== undefined) t.flux = ev.fluxGrd;
        break;
      case 'snake_add': {
        if (snakes.has(ev.id)) bad('doubleSnake', 'add ' + ev.id);
        if (!ev.raw || ev.raw.pts.length < 2) bad('emptyBody', 'add ' + ev.id + ' with ' + (ev.raw ? ev.raw.pts.length : 0) + ' points');
        snakes.add(ev.id);
        if (!t.ownId) {
          t.ownId = ev.id;
          t.own = addEnd(ev.raw.pts, t.msl);
        }
        break;
      }
      case 'snake_remove':
        if (!snakes.delete(ev.id)) bad('unknownSnake', 'remove ' + ev.id);
        if (ev.id === t.ownId) t.own = null;
        break;
      case 'snake_move': {
        const id = ev.own ? t.ownId : ev.id;
        if (ev.own && (!t.ownId || !snakes.has(t.ownId))) {
          bad('noOwn', 'own move');
          break;
        }
        needSnake(id, 'move');
        if (ev.own && t.own) {
          if (ev.cmd !== '+' && ev.cmd !== '=' && ev.iang === undefined && t.own.iang === undefined) bad('noAngle', 'own move');
          t.own = movePoint(ev, t.own, t.msl);
        }
        break;
      }
      case 'snake_rot':
        if (ev.own) {
          if (!t.ownId || !snakes.has(t.ownId)) bad('noOwn', 'own rotation');
        } else {
          needSnake(ev.id, 'rotation');
        }
        break;
      case 'snake_tail':
      case 'snake_fam':
        needSnake(ev.id, ev.type);
        break;
      case 'dead':
        t.ownDead = true;
        break;
      case 'kill_count':
        if (ev.id !== t.ownId) bad('killCount', 'kill_count for ' + ev.id + ', own ' + t.ownId);
        break;
      case 'food_sector':
        // our server sends the full form only (C_FOOD_FULL_FORMS): sector, then cv, rx, ry, rad per food
        if (ev.sx === undefined || (ev.foods.length && ev.foods[0].rx === undefined)) {
          bad('foodForm', 'food_sector not in the full form');
          break;
        }
        for (const f of ev.foods) addFood(ev.sx, ev.sy, f.rx, f.ry, f.rad, f.cv, 'F');
        break;
      case 'sector_add':
        bad('foodForm', 'sector_add is on the never-sent list');
        break;
      case 'sector_remove': {
        // the client drops every food of the sector (slApply.js removeSector); a sector with none is fine
        const set = sectorCells.get(sectorKey(ev.sx, ev.sy));
        if (set) {
          for (const id of set) cells.delete(id);
          sectorCells.delete(sectorKey(ev.sx, ev.sy));
        }
        break;
      }
      case 'food_add':
      case 'food_eat': {
        if (ev.noop || (ev.sx === undefined && !ev.sectorFromLast) || ev.rx === undefined) {
          bad('foodForm', ev.type + ' not in the sector form');
          break;
        }
        // their two 'from last' memories: lfsx/lfsy for adds, lfvsx/lfvsy for eats (slApply.js:1042-1050, 1086-1094)
        if (ev.type === 'food_add') {
          if (!ev.sectorFromLast) {
            t.lastSx = ev.sx;
            t.lastSy = ev.sy;
          }
          addFood(t.lastSx, t.lastSy, ev.rx, ev.ry, ev.rad, ev.cvFromLast ? t.lastCv : (t.lastCv = ev.cv), 'food_add');
        } else {
          if (!ev.sectorFromLast) {
            t.lastEx = ev.sx;
            t.lastEy = ev.sy;
          }
          eatFood(t.lastEx, t.lastEy, ev.rx, ev.ry);
        }
        break;
      }
      case 'prey_add':
        if (preys.has(ev.id)) bad('doublePrey', 'add ' + ev.id);
        preys.add(ev.id);
        break;
      case 'prey_move':
        if (!preys.has(ev.id)) bad('unknownPrey', 'move ' + ev.id);
        break;
      case 'prey_remove':
      case 'prey_eaten':
        if (!preys.delete(ev.id)) bad('unknownPrey', ev.type + ' ' + ev.id);
        break;
      case 'flux':
        t.flux = ev.fluxGrd;
        break;
      default:
        break;
    }
  }

  // One sl:f bundle: -> its events.
  t.onBundle = function onBundle(u8) {
    st.bundles++;
    st.bytes += u8.length;
    const sc = scanBundle(u8);
    if (sc.kind15.length) bad('kind15', sc.kind15.length + ' numbers, first ' + JSON.stringify(sc.kind15[0]));
    if (sc.offGrid.length) bad('offGrid', sc.offGrid.length + ' numbers, first ' + JSON.stringify(sc.offGrid[0]));
    st.events += sc.events.length;
    for (let i = 0; i < sc.events.length; i++) one(sc.events[i]);
    return sc.events;
  };
  t.failures = () => FAIL_KINDS.reduce((n, k) => n + fail[k], 0);
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// A fixed-bucket histogram (bucket ms wide, up to maxMs; above it counts in the last bucket). A percentile reads the
// bucket's upper edge (a time is never reported shorter than it was), or its lower edge with lower true (whole counts
// in buckets of 1 read exactly).
function createHist(bucketMs, maxMs, lower) {
  const n = Math.ceil(maxMs / bucketMs) + 1;
  const c = new Float64Array(n);
  let count = 0;
  let max = 0;
  let sum = 0;
  return {
    add(v) {
      const x = v > 0 ? v : 0;
      c[Math.min(n - 1, Math.floor(x / bucketMs))]++;
      count++;
      sum += x;
      if (x > max) max = x;
    },
    merge(h) {
      for (let i = 0; i < n; i++) c[i] += h.c[i];
      count += h.count;
      sum += h.sum;
      if (h.max > max) max = h.max;
    },
    pct(p) {
      if (!count) return 0;
      let k = Math.max(1, Math.ceil(p * count));
      for (let i = 0; i < n; i++) {
        k -= c[i];
        if (k <= 0) return lower ? i * bucketMs : Math.min(max, (i + 1) * bucketMs);
      }
      return max;
    },
    get c() { return c; },
    get count() { return count; },
    get sum() { return sum; },
    get max() { return max; },
    json() {
      return { n: count, mean: count ? +(sum / count).toFixed(2) : 0, p50: this.pct(0.5), p95: this.pct(0.95),
        p99: this.pct(0.99), max: +max.toFixed(2) };
    },
  };
}

function toU8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(0);
}

function bump(m, k, n) {
  m[k] = (m[k] || 0) + (n === undefined ? 1 : n);
}

// ---------------------------------------------------------------------------------------------------------------
// The wanderers

// opts: { url, clients, polling (share 0..1 on long-polling, the rest WebSocket), seed, ipBase, nickBase, now }
function createWanderers(opts) {
  const o = opts || {};
  const { io } = require('socket.io-client');
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const url = String(o.url || 'http://127.0.0.1:4409').replace(/\/+$/, '') + '/sl';
  const n = Number.isInteger(o.clients) && o.clients > 0 ? o.clients : 30;
  const pollShare = typeof o.polling === 'number' ? o.polling : 0.5;
  const ipBase = typeof o.ipBase === 'string' ? o.ipBase : '198.18.0.'; // RFC 2544 benchmark range
  const agg = {
    lives: 0, connects: 0, joins: 0, connectErrors: 0, deaths: 0, cashouts: 0, holds: 0, releases: 0, blips: 0,
    leaves: 0, chats: 0, diags: 0, refusals: {}, kicks: {}, serverClosed: {}, layer: {}, inputs: {}, fail: {}, samples: [],
    bundles: 0, bytes: 0, events: 0, byType: {},
  };
  const rtt = createHist(0.5, 2000);
  const gap = createHist(1, 10000);
  const lifeMs = createHist(1000, 600000);
  let stopped = false;
  const all = [];

  function fold(t) {
    if (!t || t.folded) return;
    t.folded = true;
    agg.bundles += t.st.bundles;
    agg.bytes += t.st.bytes;
    agg.events += t.st.events;
    for (const k of Object.keys(t.byType)) bump(agg.byType, k, t.byType[k]);
    for (const k of FAIL_KINDS) if (t.fail[k]) bump(agg.fail, k, t.fail[k]);
    for (const s of t.samples) if (agg.samples.length < SAMPLE_CAP) agg.samples.push(s);
  }

  function makeOne(k) {
    const r = mulberry32(((o.seed >>> 0) * 2654435761 + k * 40503 + 1) >>> 0);
    const w = {
      k, sock: null, tr: null, transport: k < Math.round(n * pollShare) ? 'polling' : 'websocket',
      ip: ipBase + ((k % 254) + 1), nick: (o.nickBase || 'Wanderer') + ' ' + k, cv: k % 9,
      joined: false, closing: false, life: 0, lifeStart: 0, plan: null, lastBundleAt: 0,
      pingOut: false, pingAt: 0, nextPingAt: 0, nextAngleAt: 0, nextTurnAt: 0, target: r() * PI2, lastQ: -1,
      boosting: false, boostUntil: 0, holding: false, holdEnd: 0, nextDiagAt: 0, deadAt: 0, reconnectTimer: null,
      cashed: false,
    };

    function send(rec) {
      if (!w.sock || !w.sock.connected) return;
      w.sock.emit('sl:i', W.encodeInput([rec]));
      bump(agg.inputs, rec.type);
    }

    // One life's plan (times from the join; a wanderer among bots lives about 15 to 20 s, so the events come early):
    // hold Q 30 percent of lives (to the cash-out 60 percent of those, else let go after 0.8 to 2.2 s), a blip or a
    // leave 15 percent, a chat 30 percent, and 10 percent drive straight out into the border.
    function plan() {
      const t0 = now();
      return {
        holdAt: r() < 0.3 ? t0 + 4000 + r() * 26000 : Infinity,
        holdMs: r() < 0.6 ? 3600 : 800 + r() * 1400,
        leaveAt: r() < 0.15 ? t0 + 5000 + r() * 35000 : Infinity,
        blip: r() < 0.5,
        chatAt: r() < 0.3 ? t0 + 3000 + r() * 27000 : Infinity,
        runAt: r() < 0.1 ? t0 + 3000 + r() * 12000 : Infinity,
      };
    }

    function endLife(why) {
      if (w.closing) return;
      w.closing = true;
      if (w.lifeStart) lifeMs.add(now() - w.lifeStart);
      const s = w.sock;
      if (s) {
        if (why === 'blip') {
          // a dropped connection: no sl:leave (the frozen client's own close path sends one)
          s.disconnect();
        } else {
          if (s.connected) s.emit('sl:leave');
          s.disconnect();
        }
      }
      fold(w.tr);
      scheduleReconnect(500 + r() * 1000);
    }

    function scheduleReconnect(ms) {
      if (stopped) return;
      clearTimeout(w.reconnectTimer);
      w.reconnectTimer = setTimeout(connect, ms);
    }

    function connect() {
      if (stopped) return;
      w.life++;
      agg.lives++;
      w.joined = false;
      w.closing = false;
      w.cashed = false;
      w.refused = false;
      w.holding = false;
      w.boosting = false;
      w.pingOut = false;
      w.lastQ = -1;
      w.lastBundleAt = 0;
      w.tr = createTracker();
      w.plan = plan();
      w.lifeStart = 0;
      const s = io(url, {
        transports: [w.transport], forceNew: true, reconnection: false, timeout: 10000,
        extraHeaders: { 'x-forwarded-for': w.ip }, auth: { cv: w.cv },
      });
      w.sock = s;
      s.on('connect', () => {
        if (w.sock !== s) return;
        agg.connects++;
        s.emit('sl:join', { nick: w.nick });
      });
      s.on('connect_error', () => {
        if (w.sock !== s) return;
        agg.connectErrors++;
        w.closing = true;
        s.close();
        scheduleReconnect(2000);
      });
      s.on('sl:f', (data) => {
        if (w.sock !== s) return;
        const u8 = toU8(data);
        const t = now();
        if (w.lastBundleAt) gap.add(t - w.lastBundleAt);
        w.lastBundleAt = t;
        const evs = w.tr.onBundle(u8);
        for (let i = 0; i < evs.length; i++) {
          const ev = evs[i];
          if (ev.type === 'init' && !w.joined) {
            w.joined = true;
            agg.joins++;
            w.lifeStart = t;
            w.nextPingAt = t;
            w.nextAngleAt = t;
            w.nextDiagAt = t + DIAG_EVERY_MS;
          } else if (ev.type === 'pong' && w.pingOut) {
            w.pingOut = false;
            rtt.add(t - w.pingAt);
            w.nextPingAt = Math.max(t, w.pingAt + PING_GAP_MS);
          } else if (ev.type === 'dead' && !w.deadAt) {
            w.deadAt = t;
            if (!w.cashed) agg.deaths++;
          }
        }
      });
      s.on('sl:x', (arr) => {
        if (w.sock !== s || !Array.isArray(arr)) return;
        for (const m of arr) {
          if (!m || typeof m !== 'object') continue;
          bump(agg.layer, String(m.t));
          if (m.t === 'refused') {
            w.refused = true;
            bump(agg.refusals, String(m.why));
          }
          if (m.t === 'cashed') {
            w.cashed = true;
            agg.cashouts++;
          }
        }
      });
      s.on('disconnect', (reason) => {
        if (w.sock !== s) return;
        if (!w.closing) {
          // after a refusal or the own end the server may close first; anything else is a kick
          if (w.refused || w.deadAt) bump(agg.serverClosed, String(reason));
          else bump(agg.kicks, String(reason));
          w.closing = true;
          if (w.lifeStart) lifeMs.add(now() - w.lifeStart);
          fold(w.tr);
          scheduleReconnect(1000 + r() * 1000);
        }
      });
      w.deadAt = 0;
    }

    // One control step (every 50 ms).
    w.step = function step(t) {
      const s = w.sock;
      if (!s || !s.connected || !w.joined || w.closing) return;
      if (w.deadAt) {
        if (t - w.deadAt >= DEATH_CLOSE_MS) endLife('death');
        return;
      }
      const tr = w.tr;
      if (!tr.own) return;
      // ping
      if (!w.pingOut && t >= w.nextPingAt) {
        w.pingOut = true;
        w.pingAt = t;
        send({ type: 'ping' });
      }
      // leave or blip
      if (t >= w.plan.leaveAt) {
        if (w.plan.blip) agg.blips++;
        else agg.leaves++;
        endLife(w.plan.blip ? 'blip' : 'leave');
        return;
      }
      // chat
      if (t >= w.plan.chatAt) {
        w.plan.chatAt = Infinity;
        s.emit('sl:chat', { text: 'gg ' + w.k });
        agg.chats++;
      }
      // diag
      if (t >= w.nextDiagAt) {
        w.nextDiagAt = t + DIAG_EVERY_MS;
        s.emit('sl:diag', { applyThrows: 0, wireErrors: tr.fail.wireError, fps: 60, lag: 0, lagEntries: 0,
          pongP95: Math.round(rtt.pct(0.95)), maxGapMs: Math.round(gap.max), maxOwnChl: 0 });
        agg.diags++;
      }
      // hold Q (no boosting while holding: OWNER-ANSWERS 17:00)
      if (!w.holding && t >= w.plan.holdAt) {
        w.plan.holdAt = Infinity;
        if (w.boosting) {
          w.boosting = false;
          send({ type: 'boost', on: false });
        }
        w.holding = true;
        w.holdEnd = t + w.plan.holdMs;
        s.emit('sl:hold', { on: 1 });
        agg.holds++;
      } else if (w.holding && t >= w.holdEnd) {
        w.holding = false;
        s.emit('sl:hold', { on: 0 });
        agg.releases++;
      }
      // steering
      if (t >= w.nextAngleAt) {
        w.nextAngleAt = t + 100 + r() * 150;
        const grd = tr.grd;
        const hx = tr.own.x - grd;
        const hy = tr.own.y - grd;
        const lim = 0.6 * (tr.flux || grd);
        if (t >= w.plan.runAt) {
          w.target = Math.atan2(hy, hx); // straight out, into the border (L38)
        } else if (hx * hx + hy * hy > lim * lim) {
          w.target = Math.atan2(-hy, -hx);
        } else if (t >= w.nextTurnAt) {
          w.nextTurnAt = t + 500 + r() * 1500;
          w.target += (r() - 0.5) * 1.6;
        }
        w.target = ((w.target % PI2) + PI2) % PI2;
        let q = Math.floor((ANGLE_BYTES * w.target) / PI2) % ANGLE_BYTES;
        if (r() < 0.3) q = (q + (r() < 0.5 ? 1 : ANGLE_BYTES - 1)) % ANGLE_BYTES; // hand jitter
        if (q !== w.lastQ) {
          w.lastQ = q;
          send({ type: 'angle', q });
        }
      }
      // boost bursts
      if (!w.holding) {
        if (!w.boosting && r() < 0.01) {
          w.boosting = true;
          w.boostUntil = t + 300 + r() * 1500;
          send({ type: 'boost', on: true });
        } else if (w.boosting && t >= w.boostUntil) {
          w.boosting = false;
          send({ type: 'boost', on: false });
        }
      }
    };
    w.connect = connect;
    w.stop = () => {
      clearTimeout(w.reconnectTimer);
      if (w.sock) {
        w.closing = true;
        if (w.lifeStart) lifeMs.add(now() - w.lifeStart);
        if (w.sock.connected) w.sock.emit('sl:leave');
        w.sock.disconnect();
      }
      fold(w.tr);
    };
    return w;
  }

  for (let k = 0; k < n; k++) all.push(makeOne(k));
  let loop = null;

  return {
    start() {
      all.forEach((w, i) => setTimeout(() => w.connect(), i * 40)); // a 40 ms stagger: no handshake storm
      loop = setInterval(() => {
        const t = now();
        for (const w of all) w.step(t);
      }, 50);
    },
    stop() {
      stopped = true;
      clearInterval(loop);
      for (const w of all) w.stop();
    },
    // Live trackers are not folded yet: they are added to a copy.
    summary() {
      const live = all.map((w) => w.tr).filter((t) => t && !t.folded);
      const out = JSON.parse(JSON.stringify(agg));
      for (const t of live) {
        out.bundles += t.st.bundles;
        out.bytes += t.st.bytes;
        out.events += t.st.events;
        for (const k of Object.keys(t.byType)) bump(out.byType, k, t.byType[k]);
        for (const k of FAIL_KINDS) if (t.fail[k]) bump(out.fail, k, t.fail[k]);
        for (const s of t.samples) if (out.samples.length < SAMPLE_CAP) out.samples.push(s);
      }
      out.clients = n;
      out.polling = all.filter((w) => w.transport === 'polling').length;
      out.failures = Object.values(out.fail).reduce((a, b) => a + b, 0);
      out.kickTotal = Object.values(out.kicks).reduce((a, b) => a + b, 0);
      out.refusalTotal = Object.values(out.refusals).reduce((a, b) => a + b, 0);
      out.rttMs = rtt.json();
      out.gapMs = gap.json();
      out.lifeS = { n: lifeMs.count, mean: lifeMs.count ? +(lifeMs.sum / lifeMs.count / 1000).toFixed(1) : 0,
        p50: lifeMs.pct(0.5) / 1000, max: +(lifeMs.max / 1000).toFixed(1) };
      out.seated = all.filter((w) => w.joined && !w.closing).length;
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function main() {
  const ipc = process.argv.includes('--ipc') && typeof process.send === 'function';
  const minutes = Number(arg('minutes', ipc ? '0' : '10'));
  const run = createWanderers({
    url: arg('url', 'http://127.0.0.1:4409'),
    clients: Number(arg('clients', '30')),
    polling: Number(arg('polling', '0.5')),
    seed: Number(arg('seed', '1')),
    ipBase: arg('ip-base', '198.18.0.'),
  });
  run.start();
  const finish = () => {
    run.stop();
    const sum = run.summary();
    if (ipc) {
      process.send({ type: 'report', report: sum }, () => process.exit(0));
      return;
    }
    const out = arg('json', '');
    if (out) require('fs').writeFileSync(out, JSON.stringify(sum, null, 2));
    console.log(JSON.stringify(sum, null, 2));
    const ok = sum.failures === 0;
    console.log((ok ? 'PASS' : 'FAIL') + ' every bundle decoded, no unknown id, no wire_error (' + sum.bundles + ' bundles)');
    setTimeout(() => process.exit(ok ? 0 : 1), 200);
  };
  if (ipc) {
    process.on('message', (m) => {
      if (m && m.cmd === 'stop') finish();
      else if (m && m.cmd === 'progress') process.send({ type: 'progress', report: run.summary() });
    });
    process.on('disconnect', () => process.exit(0));
  }
  if (minutes > 0) setTimeout(finish, minutes * 60000);
}

if (require.main === module) main();

module.exports = { createTracker, createWanderers, addEnd, movePoint, createHist, mulberry32, FAIL_KINDS };
