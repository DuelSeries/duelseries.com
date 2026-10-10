'use strict';
// slither.io free room, server side: cached wire records and the kind-15 check (SERVER-DESIGN 8.5 and 18.2 item 1,
// task T2).
//
// A record is the bytes of `slWire.encodeBundle([ev], pv)` minus its version byte. A seat's bundle is the version
// byte plus its records, concatenated. That is byte-identical to `slWire.encodeBundle(seatEvents, pv)` because a
// record carries no state from the record before it; the one exception is the protocol version, which food records
// read (shared/slWire.js:600-609) and which only an `init` changes. So a cache works at ONE pv (the L6 protocol the
// room's `init` sends) and refuses an `init` that would switch to another.
//
// Each event is encoded once per tick however many seats receive it. `snake_rot` and `snake_move` have two variants:
// the receiving seat's own snake (no id; own move letters `G`, `N`) and everyone else's (id; letters `g`, `n`). The
// absolute forms `+` and `=` use the same letter for both (game.js:7666-7668). Every other event has one variant.
// The cache is keyed by the event object, so events must not be changed once a record was made from them.
//
// `scanBundle` decodes a bundle and finds every number slWire had to write as raw 8 bytes (kind 15), and every number
// that is off its field's grid on THEIR wire (slQuant GRIDS): proof that each number we send is one their server
// could have sent (parity contract P1). The kind test re-encodes each decoded number alone; slWire's number search is
// deterministic, so a value that came back from kind 15 goes back to kind 15 and any other value finds a kind again.

const W = require('../../shared/slWire.js');
const Q = require('./slQuant.js');

const KIND_F64 = 15;
const VARIANT = Object.freeze({ snake_rot: true, snake_move: true });
const OWN_CMD = Object.freeze({ g: 'G', G: 'G', n: 'N', N: 'N', '+': '+', '=': '=' });
const OTHER_CMD = Object.freeze({ g: 'g', G: 'g', n: 'n', N: 'n', '+': '+', '=': '=' });

function needPv(pv) {
  if (!Number.isInteger(pv) || pv < 0 || pv > 255) throw new RangeError('slRecordCache: pv must be an integer 0..255');
  return pv;
}

function needEvent(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') {
    throw new TypeError('slRecordCache: an event needs a type');
  }
  return ev;
}

// The event as the receiving seat gets it. Only `snake_rot` and `snake_move` change; others come back as given.
function variantOf(ev, own) {
  needEvent(ev);
  if (!VARIANT[ev.type]) return ev;
  if (typeof own !== 'boolean') throw new TypeError('slRecordCache: ' + ev.type + ' needs own true or false');
  const out = Object.assign({}, ev, { own: own });
  if (ev.type === 'snake_move') {
    const cmd = (own ? OWN_CMD : OTHER_CMD)[ev.cmd];
    if (cmd === undefined) throw new RangeError('slRecordCache: snake_move cmd ' + String(ev.cmd) + ' is not a move');
    out.cmd = cmd;
  }
  return out;
}

// One record, no cache.
function encodeRecord(ev, own, pv) {
  needPv(pv);
  const e = variantOf(ev, own);
  if (e.type === 'init' && e.pv !== undefined && e.pv !== pv) {
    throw new RangeError('slRecordCache: an init switching to pv ' + e.pv + ' cannot go through a pv ' + pv + ' cache');
  }
  return W.encodeBundle([e], pv).subarray(1);
}

// A seat's bundle from its records, in order.
function bundleBytes(records) {
  if (!Array.isArray(records)) throw new TypeError('slRecordCache: records must be an array');
  let total = 1;
  for (let i = 0; i < records.length; i++) {
    if (!(records[i] instanceof Uint8Array)) throw new TypeError('slRecordCache: record ' + i + ' is not bytes');
    total += records[i].length;
  }
  const out = new Uint8Array(total);
  out[0] = W.VERSION;
  let at = 1;
  for (let i = 0; i < records.length; i++) {
    out.set(records[i], at);
    at += records[i].length;
  }
  return out;
}

// A cache for one tick (call clear() at the start of the next, or make a new one). Entries are held weakly, so a
// tick's events and their bytes go together.
function createRecordCache(pv) {
  needPv(pv);
  let ownMap = new WeakMap();
  let otherMap = new WeakMap();
  const stats = { hits: 0, misses: 0 };
  function recordBytes(ev, own) {
    needEvent(ev);
    let map = otherMap;
    if (VARIANT[ev.type]) {
      if (typeof own !== 'boolean') throw new TypeError('slRecordCache: ' + ev.type + ' needs own true or false');
      if (own) map = ownMap;
    }
    let b = map.get(ev);
    if (b !== undefined) {
      stats.hits++;
      return b;
    }
    b = encodeRecord(ev, VARIANT[ev.type] ? own : false, pv);
    map.set(ev, b);
    stats.misses++;
    return b;
  }
  function clear() {
    ownMap = new WeakMap();
    otherMap = new WeakMap();
  }
  return { pv: pv, recordBytes: recordBytes, clear: clear, stats: stats };
}

// ------------------------------------------------------------------ kind-15 and grid check

// The kind byte slWire writes for one number: an `h` record [version, type 3, id 0, kind, ...].
function numKind(v) {
  return W.encodeBundle([{ type: 'snake_fam', id: 0, fam: v }], 1)[3];
}

// Every number field slWire writes with its kind search (the putNum fields of shared/slWire.js putEvent), and the
// grid THEIR wire puts it on at pv 19 (slQuant GRIDS). Lists name their own fields.
const FIELD_GRID = Object.freeze({
  init: { spangdv: 'init10', nsp1: 'init100', nsp2: 'init100', nsp3: 'init100', mamu: 'init1000', mamu2: 'init1000',
    cst: 'init1000' },
  snake_rot: { ang: 'ang8', wang: 'ang8', sp: 'sp18' },
  snake_fam: { fam: 'fam24' },
  snake_tail: { fam: 'fam24' },
  snake_move: { xx: 'u16', yy: 'u16', fam: 'fam24' },
  longest_msg: { fam: 'fam24' },
  snake_add: { ang: 'ang24', wang: 'ang24', sp: 'sp1000', fam: 'fam24', snx: 'pos5', sny: 'pos5' },
  food_add: { rad: 'rad5' },
  prey_move: { xx: 'prey3', yy: 'prey3', ang: 'ang24', wang: 'ang24', sp: 'sp1000' },
  prey_add: { xx: 'pos5', yy: 'pos5', rad: 'rad5', wang: 'ang24', ang: 'ang24', sp: 'sp1000' }
});
const LIST_GRID = Object.freeze({
  leaderboard: { list: 'rows', fields: { fam: 'fam24' } },
  food_sector: { list: 'foods', fields: { rad: 'rad5' } }
});

function checkNum(out, at, type, field, grid, v) {
  if (v === undefined) return;
  if (numKind(v) === KIND_F64) out.kind15.push({ at: at, type: type, field: field });
  if (!Q.onGrid(grid, v)) out.offGrid.push({ at: at, type: type, field: field, grid: grid });
}

// Decodes `bytes` and returns { events, kind15, offGrid, wireError }. kind15 lists every number slWire had to send as
// raw 8 bytes; offGrid every number that is not on its field's grid on THEIR wire (a stricter test: 1.3 finds the
// /10 kind but is not a /5 position). Entries are { at (event index), type, field }. A clean bundle has both lists
// empty and wireError null.
function scanBundle(bytes) {
  const out = { events: W.decodeBundle(bytes), kind15: [], offGrid: [], wireError: null };
  for (let i = 0; i < out.events.length; i++) {
    const ev = out.events[i];
    if (ev.type === 'wire_error') {
      out.wireError = ev;
      continue;
    }
    const fg = FIELD_GRID[ev.type];
    if (fg) for (const f of Object.keys(fg)) checkNum(out, i, ev.type, f, fg[f], ev[f]);
    const lg = LIST_GRID[ev.type];
    if (lg && Array.isArray(ev[lg.list])) {
      const list = ev[lg.list];
      for (let j = 0; j < list.length; j++) {
        for (const f of Object.keys(lg.fields)) {
          checkNum(out, i, ev.type, lg.list + '[' + j + '].' + f, lg.fields[f], list[j][f]);
        }
      }
    }
  }
  return out;
}

module.exports = {
  KIND_F64: KIND_F64,
  FIELD_GRID: FIELD_GRID,
  LIST_GRID: LIST_GRID,
  variantOf: variantOf,
  encodeRecord: encodeRecord,
  bundleBytes: bundleBytes,
  createRecordCache: createRecordCache,
  numKind: numKind,
  scanBundle: scanBundle
};
