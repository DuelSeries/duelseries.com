'use strict';
// slither.io free room: reconnect and resume after a connection blip (task T16b; Owen Q10, OWNER-ANSWERS.md:108,
// "glide 3 s from the start ... the snake glides straight about 3 s while reconnecting, then dies if not back").
//
// What the old game does (server/index.js:2762-2763, 2869-2880, 3536-3540; server/GameRoom.js:306-345;
// public/js/game.js:116-133): the page makes its OWN reconnect key, socket.io reconnects by itself, and PLAY carries
// the key; the server keeps a dropped snake gliding for RECONNECT_GRACE_MS and moves it onto the new socket when the
// key comes back. Ours keeps the idea and fixes what the old one trusted:
//   - The key is SERVER-ISSUED (crypto.randomUUID, agar's resumeKey precedent, server/ag/agMoney.js:169), sent only
//     to the seat's own socket (sl:x {t: 'seat', k, ms}) and ROTATED on every resume (sl:x {t: 'back', k, ms}), so a
//     key works once: two tabs presenting one key get one seat between them and the other is refused.
//   - It is NOT named resumeKey: sl:join refuses that name as a money field (slSockets MONEY_FIELDS), and the free
//     door reads no money. The resume is its own event, sl:back {k, n, p}, never sl:join.
//   - Nothing the client says is believed about the world. n (the sl:f bundles it got this life) and p (the pings it
//     sent) only choose which of the server's OWN retained records to send again; a lie only hurts the liar's screen.
//   - The frozen client (public/js/sl/*) never sees the blip: the layer's transport (public/js/slx/slxNet.js) keeps
//     one transport object for the life and swaps sockets under it, so their client sees a late stream (lag mode)
//     and then a resync, exactly what a long stall looks like (SERVER-DESIGN 9.2, 9.3).
//
// The window: a parked live snake glides C_DISCONNECT glideMs (3000, APPROVED) and then dies with its drops as
// before. A parked seat whose snake died is kept C_DEAD_SEAT_MS noPingMs after the death (the same rule that closes
// a dead seat with no ping, slRoom._deadSeatDone), so a client back at 3.5 s gets its own death and the normal
// results card; later it is 'gone' and the card says the connection was lost.
//
// This file: the C_RESUME row (CHOSEN, a player cannot see it), the key, the shapes, the per-address gate.

const crypto = require('crypto');
const { STATUS } = require('./slLaws');

// The refusal whys a resume adds to slSockets REFUSALS.
const WHY_GONE = 'gone';    // no parked or seated life holds that key now (ended, never issued, or already used)
const WHY_TAKEN = 'taken';  // sent to the OLD socket of a seat that another socket took back with the current key

// Our own row (the slSim WORLD_ROWS precedent). The table wins when it has the id. T1 follow-up: copy it into
// slLaws.js and SERVER-LAWS N.
const RESUME_ROWS = Object.freeze({
  C_RESUME: Object.freeze({
    id: 'C_RESUME',
    name: 'Resume after a blip: at most perSeat.max resumes of one seat per perSeat.windowMs; an address that sent ' +
      'badKeys.max unusable sl:back within badKeys.windowMs is refused sl:back until the window clears',
    status: STATUS.CHOSEN,
    value: Object.freeze({
      perSeat: Object.freeze({ max: 10, windowMs: 60000 }),
      badKeys: Object.freeze({ max: 20, windowMs: 60000 }),
    }),
    unit: 'count per ms',
    source: 'CHOSEN: engineering (task T16b, BUILD-DECISIONS). Each resume costs one resync bundle (measured mean ' +
      '1,773 bytes, max 3,567, recordings/OURS-SOAK.md); 10 a minute is a phone that blips every 6 s, already ' +
      'unplayable, and caps a resume loop at about 0.3 KB/s. A real client only ever presents keys the server gave ' +
      'it and stops at its first refusal, so 20 unusable keys a minute from one address is a guesser (a key is a ' +
      '122-bit random UUID) or a whole address whose seats all ended at once (a restart: those clients get the ' +
      'same "connection lost" card either way). A player cannot see it.',
  }),
});
const RESUME_ROW_IDS = Object.freeze(Object.keys(RESUME_ROWS));

function rowOf(laws, id) {
  return laws && Object.prototype.hasOwnProperty.call(laws, id) ? laws[id] : RESUME_ROWS[id];
}

function posInt(v, what) {
  if (!Number.isInteger(v) || v <= 0) throw new Error('slResume: law C_RESUME ' + what + ' must be a whole number above 0');
  return v;
}

// Every value of C_RESUME, once.
function resumeLaws(laws) {
  const v = rowOf(laws, 'C_RESUME').value;
  if (!v || typeof v !== 'object') throw new Error('slResume: law C_RESUME is not {perSeat, badKeys}');
  for (const k of Object.keys(v)) if (k !== 'perSeat' && k !== 'badKeys') throw new Error('slResume: C_RESUME parameter ' + k + ' is not built');
  const out = {};
  for (const k of ['perSeat', 'badKeys']) {
    const r = v[k];
    if (!r || typeof r !== 'object') throw new Error('slResume: law C_RESUME ' + k + ' is not {max, windowMs}');
    out[k] = Object.freeze({ max: posInt(r.max, k + '.max'), windowMs: posInt(r.windowMs, k + '.windowMs') });
  }
  return Object.freeze(out);
}

// A fresh key: a random v4 UUID (122 random bits), as agar's resumeKey.
function makeKey() {
  return crypto.randomUUID();
}

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The exact shape makeKey gives; anything else is never looked up.
function isKey(k) {
  return typeof k === 'string' && k.length === 36 && KEY_RE.test(k);
}

const INT32_MAX = 2147483647;

// A whole number 0 to INT32_MAX, else null.
function count(v) {
  return Number.isInteger(v) && v >= 0 && v <= INT32_MAX ? v : null;
}

// Times in a sliding window, oldest first; true from add() when the window now holds more than max.
function createWindow(max, windowMs) {
  const at = [];
  return {
    prune(now) {
      while (at.length && now - at[0] >= windowMs) at.shift();
      return at.length;
    },
    full(now) {
      return this.prune(now) >= max;
    },
    add(now) {
      this.prune(now);
      at.push(now);
      return at.length > max;
    },
    get size() {
      return at.length;
    },
  };
}

// C_RESUME badKeys per address: unusable sl:back (a malformed payload, an unknown, used or ended key).
// Bounded against many addresses (an IPv6 block hands out plenty): a full sweep at most once per windowMs once the map
// holds SWEEP_AT addresses, and never more than MAX_ADDRESSES (the oldest address goes first).
const SWEEP_AT = 4096;
const MAX_ADDRESSES = 65536;
function createBadKeyGate(badKeys, ipOf) {
  const byIp = new Map();
  let sweptAt = -Infinity;
  function sweep(now) {
    sweptAt = now;
    for (const [ip, w] of byIp) if (w.prune(now) === 0) byIp.delete(ip);
  }
  return {
    blocked(socket, now) {
      const w = byIp.get(ipOf(socket));
      return !!w && w.full(now);
    },
    add(socket, now) {
      if (byIp.size >= SWEEP_AT && now - sweptAt >= badKeys.windowMs) sweep(now);
      const ip = ipOf(socket);
      let w = byIp.get(ip);
      if (!w) {
        if (byIp.size >= MAX_ADDRESSES) byIp.delete(byIp.keys().next().value);
        w = createWindow(badKeys.max, badKeys.windowMs);
        byIp.set(ip, w);
      }
      w.add(now);
    },
    addresses() {
      return byIp.size;
    },
  };
}

module.exports = {
  RESUME_ROWS,
  RESUME_ROW_IDS,
  WHY_GONE,
  WHY_TAKEN,
  resumeLaws,
  makeKey,
  isKey,
  count,
  createWindow,
  createBadKeyGate,
  MAX_ADDRESSES,
};
