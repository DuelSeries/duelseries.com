'use strict';
// agar.io FFA: what one player is sent each tick (the server view).
//
// The room turns the sim's state after a tick into one shared FRAME (makeFrame, once per tick), then asks each
// player's VIEWER for that player's records (viewer.build) and encodes them with shared/agWire.js (viewer.encode,
// or viewer.bundle for both). The records are the mirror messages of the build brief (section 6), so the client
// world, the wire and the replay harness all speak the same shapes.
//
// The stream follows the server contract of the protocol spec (protocol semantics 2 and 3.8):
//   - join order: hello, border (with the FFA mode), at least one world record, and only then own ids;
//   - every tick carries exactly one world record (the client times world arrivals, protocol semantics 1.1 and 3.7),
//     even when nothing changed;
//   - a cell's first record carries its full flags, its colour (a new cell without colour is black, protocol
//     semantics T2) and its name when it has one; later records only when something on the wire changed, with the
//     flags every time and colour or name only when they changed (an empty name never clears one, so it is not sent);
//   - an own id is announced once, in the same bundle and before the world record that first carries the cell
//     (T4: a cell is own only when announced AND then sent);
//   - eats are sent only when the client knows both cells (it skips an eat with an unknown id, protocol semantics
//     3.2), and every eaten id the client knows is removed in the same bundle (law U_EAT_REMOVE); merges are simply
//     eats between two cells of one player and pass through the same way;
//   - a cell that left the view, or that the sim deleted, is removed; a removed id that comes back is a new node.
//
// Which cells are in view is server law L4 (UNKNOWN until Owen approves): a box centred on the plain average of
// the player's cells, half width (baseW + pad) / s / 2 and half height (baseH + pad) / s / 2 with
// s = max(pow(min(ref / sum of own sizes, 1), exp), minScale). A cell is in view when its disc's bounding box
// touches that box (any part of a cell can be on screen, protocol semantics 13), and the player's own cells are
// always in view (the client camera and score are built from them). The approved L4 must cover the least area the
// client can show (K_VIEW_FLOOR); creation refuses one that does not.
//
// The sim, not this file, decides colours, names, ids and positions; this file only rounds x, y and size to wire
// integers with the approved rule (U_ROUND) and maps cell kinds to wire flags by the CHOSEN WIRE_FLAGS row.
// No io, no timers, no randomness and no clock: the same frames always give the same bytes.

const agWire = require('../../shared/agWire');
const { assertLawsComplete } = require('./agLaws');

const VIEW_LAW_IDS = Object.freeze(['K_VIEW_FLOOR', 'L4', 'L37', 'U_ROUND', 'U_EAT_REMOVE', 'WIRE_FLAGS']);
const FRAME_LAW_IDS = Object.freeze(['U_ROUND', 'WIRE_FLAGS']);

// Our wire's border mode for FFA (build brief section 8: mode 0 = FFA).
const FFA_MODE = 0;

// Spatial index used to find the cells in a view box. Speed only: the records never depend on these numbers (a
// test checks the index against a plain scan). CHOSEN internals.
const GRID = 1024;              // index cell side, world units
const MAX_SPAN = 64;            // a cell covering more index cells than this goes in a list every query checks
const GRID_LIMIT = 1 << 21;     // index coordinates are clamped to +-this (keys stay exact doubles)

const BIT = agWire.CELL_BIT;
const KINDS = new Set(['player', 'food', 'virus', 'ejected']);
const FRAME_MARK = Symbol('agView.frame');
const NO_CELLS = Object.freeze([]);

let stampCounter = 0;           // query stamps; each build takes a fresh one (shared frames, sequential builds)

// ---------------------------------------------------------------------------------------------------------------
// Laws.

function roundRule(rule) {
  switch (rule) {
    case 'nearest': return (v) => Math.round(v) + 0;   // + 0 turns -0 into 0
    case 'floor': return (v) => Math.floor(v) + 0;
    case 'trunc': return (v) => Math.trunc(v) + 0;
    default: throw new Error("agView: U_ROUND rule '" + rule + "' is not supported (nearest, floor or trunc)");
  }
}

function finite(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError('agView: ' + what + ' must be a finite number');
  return v;
}

// The L4 value shape (agLaws unit): { baseW, baseH, pad, ref, exp, minScale }.
function checkViewLaw(v, floor) {
  if (!v || typeof v !== 'object') throw new TypeError('agView: L4 must be { baseW, baseH, pad, ref, exp, minScale }');
  for (const k of ['baseW', 'baseH', 'pad', 'ref', 'exp', 'minScale']) finite(v[k], 'L4.' + k);
  if (!(v.ref > 0) || !(v.minScale > 0)) throw new RangeError('agView: L4 ref and minScale must be above 0');
  if (!floor || !(v.baseW + v.pad >= floor.w) || !(v.baseH + v.pad >= floor.h)) {
    throw new RangeError('agView: L4 sends less than the client can show (K_VIEW_FLOOR ' +
      (floor && floor.w) + ' x ' + (floor && floor.h) + ')');
  }
  return v;
}

// View scale s for a total own size (0 when the player has no cells, which gives s = 1 before any clamp).
function scaleFor(sumSize, v) {
  const ratio = sumSize > 0 ? Math.min(v.ref / sumSize, 1) : 1;
  return Math.max(Math.pow(ratio, v.exp), v.minScale);
}

function viewBoxFor(cx, cy, s, v) {
  const hw = (v.baseW + v.pad) / s / 2;
  const hh = (v.baseH + v.pad) / s / 2;
  return { minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh, cx, cy, scale: s };
}

// ---------------------------------------------------------------------------------------------------------------
// Frames: one per tick, shared by every viewer.

function checkId(v, what) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 4294967295) {
    throw new RangeError('agView: ' + what + ' must be an integer id in [1, 2^32 - 1], got ' + v);
  }
  return v;
}

function cellsOf(cells) {
  if (cells === undefined || cells === null) return NO_CELLS;
  if (cells instanceof Map) return cells.values();
  if (typeof cells[Symbol.iterator] === 'function') return cells;
  throw new TypeError('agView: frame cells must be an array, a Map or an iterable');
}

function entryOf(c, round, wf) {
  if (!c || typeof c !== 'object') throw new TypeError('agView: a frame cell is not an object');
  const id = checkId(c.id, 'cell id');
  const x = finite(c.x, 'cell ' + id + ' x');
  const y = finite(c.y, 'cell ' + id + ' y');
  const size = finite(c.size, 'cell ' + id + ' size');
  if (size < 0) throw new RangeError('agView: cell ' + id + ' size is negative');
  const kind = c.kind;
  if (kind !== undefined && !KINDS.has(kind)) throw new TypeError('agView: cell ' + id + ' has unknown kind ' + kind);
  const rgb = c.rgb;
  if (!rgb || rgb.length !== 3) {
    throw new TypeError('agView: cell ' + id + ' needs rgb [r, g, b] (a new cell without colour is black)');
  }
  for (let i = 0; i < 3; i++) {
    if (!Number.isInteger(rgb[i]) || rgb[i] < 0 || rgb[i] > 255) {
      throw new RangeError('agView: cell ' + id + ' colour channel ' + i + ' must be an integer 0 to 255');
    }
  }
  const name = c.name === undefined || c.name === null ? '' : String(c.name);
  const virus = kind === 'virus' || c.virus === true;
  const food = kind === 'food' || c.food === true;
  const ejected = wf.ejectedOnBlobs === true && (kind === 'ejected' || c.ejected === true);
  const agitated = wf.agitated === true && c.agitated === true;
  const flag40 = wf.flag40 === true && c.flag40 === true;
  const party = wf.party === true && c.party === true;
  // Only player cells can be someone's own cells; an ejected blob may remember who shot it, but it is not theirs.
  const blob = kind === 'ejected' || c.ejected === true;
  const owner = c.owner === undefined || c.owner === null || virus || food || blob ? null : c.owner;
  let bits = 0;
  if (virus) bits |= BIT.virus;
  if (food) bits |= BIT.food;
  if (ejected) bits |= BIT.ejected;
  if (agitated) bits |= BIT.agitated;
  if (flag40) bits |= BIT.flag40;
  if (party) bits |= BIT.party;
  return {
    id, x, y, size,
    owner,
    wx: round(x), wy: round(y), wsize: round(size),
    bits, virus, food, ejected, agitated, flag40, party,
    r: rgb[0], g: rgb[1], b: rgb[2], name,
    stamp: 0,
  };
}

function gridIndex(v) {
  const g = Math.floor(v / GRID);
  return g < -GRID_LIMIT ? -GRID_LIMIT : g > GRID_LIMIT ? GRID_LIMIT : g;
}

function gridKey(gx, gy) {
  return (gx + GRID_LIMIT) * (4 * GRID_LIMIT) + (gy + GRID_LIMIT);
}

// input: { border: { minX, minY, maxX, maxY }, cells, eats?: [[eaterId, eatenId]], removed?: [id] }
//   cells: every live cell after the tick, each { id, x, y, size, owner? (player cells only), kind? ('player', 'food', 'virus',
//          'ejected') or the booleans virus/food/ejected/agitated/flag40/party, rgb: [r, g, b], name? }
//   eats: this tick's eats in sim order (merges included)
//   removed: ids the sim deleted this tick; needed only to tell a reused id from the old cell (a deleted id that
//          is absent from cells is found without it)
function makeFrame(input, laws) {
  assertLawsComplete(laws, FRAME_LAW_IDS);
  const round = roundRule(laws.U_ROUND.value);
  const wf = laws.WIRE_FLAGS.value;
  if (!wf || typeof wf !== 'object') throw new TypeError('agView: WIRE_FLAGS must be an object');
  if (!input || typeof input !== 'object') throw new TypeError('agView: makeFrame needs { border, cells }');
  const bd = input.border;
  if (!bd || typeof bd !== 'object') throw new TypeError('agView: frame border must be { minX, minY, maxX, maxY }');
  const border = {
    minX: finite(bd.minX, 'border minX'), minY: finite(bd.minY, 'border minY'),
    maxX: finite(bd.maxX, 'border maxX'), maxY: finite(bd.maxY, 'border maxY'),
  };

  const byId = new Map();
  const byOwner = new Map();
  const grid = new Map();
  const big = [];
  const list = [];
  for (const c of cellsOf(input.cells)) {
    const e = entryOf(c, round, wf);
    if (byId.has(e.id)) throw new Error('agView: cell id ' + e.id + ' appears twice in one frame');
    byId.set(e.id, e);
    list.push(e);
    if (e.owner !== null) {
      const mine = byOwner.get(e.owner);
      if (mine) mine.push(e); else byOwner.set(e.owner, [e]);
    }
    const gx0 = gridIndex(e.x - e.size), gx1 = gridIndex(e.x + e.size);
    const gy0 = gridIndex(e.y - e.size), gy1 = gridIndex(e.y + e.size);
    if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > MAX_SPAN) { big.push(e); continue; }
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const k = gridKey(gx, gy);
        const bucket = grid.get(k);
        if (bucket) bucket.push(e); else grid.set(k, [e]);
      }
    }
  }

  const eats = [];
  const rawEats = input.eats === undefined || input.eats === null ? NO_CELLS : input.eats;
  if (!Array.isArray(rawEats)) throw new TypeError('agView: frame eats must be an array of [eaterId, eatenId]');
  for (const pair of rawEats) {
    if (!pair || pair.length !== 2) throw new TypeError('agView: an eat must be [eaterId, eatenId]');
    eats.push([checkId(pair[0], 'eater id'), checkId(pair[1], 'eaten id')]);
  }

  const removedIds = new Set();
  const rawRemoved = input.removed === undefined || input.removed === null ? NO_CELLS : input.removed;
  if (!Array.isArray(rawRemoved)) throw new TypeError('agView: frame removed must be an array of ids');
  for (const id of rawRemoved) removedIds.add(checkId(id, 'removed id'));

  return { [FRAME_MARK]: true, border, byId, byOwner, list, grid, big, eats, removedIds };
}

function overlaps(e, box) {
  return e.x - e.size <= box.maxX && e.x + e.size >= box.minX &&
    e.y - e.size <= box.maxY && e.y + e.size >= box.minY;
}

// Appends every unstamped entry overlapping the box to `out` and stamps it.
function query(frame, box, stamp, out) {
  const gx0 = gridIndex(box.minX), gx1 = gridIndex(box.maxX);
  const gy0 = gridIndex(box.minY), gy1 = gridIndex(box.maxY);
  const span = (gx1 - gx0 + 1) * (gy1 - gy0 + 1);
  if (span > frame.grid.size) {
    for (const e of frame.list) {
      if (e.stamp !== stamp && overlaps(e, box)) { e.stamp = stamp; out.push(e); }
    }
    return out;
  }
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gy = gy0; gy <= gy1; gy++) {
      const bucket = frame.grid.get(gridKey(gx, gy));
      if (!bucket) continue;
      for (const e of bucket) {
        if (e.stamp !== stamp && overlaps(e, box)) { e.stamp = stamp; out.push(e); }
      }
    }
  }
  for (const e of frame.big) {
    if (e.stamp !== stamp && overlaps(e, box)) { e.stamp = stamp; out.push(e); }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Records.

function cellRecord(e) {
  return {
    id: e.id, x: e.wx, y: e.wy, size: e.wsize,
    virus: e.virus, food: e.food, ejected: e.ejected, agitated: e.agitated, flag40: e.flag40, party: e.party,
  };
}

// The first record of a cell for this client: flags, colour always, name when it has one.
function fullRecord(e) {
  const rec = cellRecord(e);
  rec.rgb = [e.r, e.g, e.b];
  if (e.name !== '') rec.name = e.name;
  return rec;
}

// What the client holds for a cell after a record (name = the last non-empty name sent).
function stateOf(e, prevName) {
  return { wx: e.wx, wy: e.wy, wsize: e.wsize, bits: e.bits, r: e.r, g: e.g, b: e.b,
    name: e.name !== '' ? e.name : prevName };
}

function borderEqual(a, b) {
  return a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;
}

// ---------------------------------------------------------------------------------------------------------------
// The viewer: one per connected socket, holding what that client has been sent.

function createViewer(playerId, opts) {
  if (playerId === undefined || playerId === null) throw new TypeError('agView: createViewer needs a player id');
  const laws = opts && opts.laws;
  assertLawsComplete(laws, VIEW_LAW_IDS);
  const view = checkViewLaw(laws.L4.value, laws.K_VIEW_FLOOR.value);
  roundRule(laws.U_ROUND.value);
  if (laws.U_EAT_REMOVE.value !== 'sameBundle') {
    throw new Error("agView: U_EAT_REMOVE '" + laws.U_EAT_REMOVE.value + "' is not supported; only 'sameBundle' " +
      'is built (a later-bundle rule needs its delay approved first)');
  }
  const wireOpts = { maxNameBytes: laws.L37.value };
  agWire.bundleSize([], wireOpts);          // validates the name cap now, not on the first tick

  const known = new Map();                  // id -> what the client holds (stateOf)
  const announced = new Set();              // own ids announced and not yet removed
  let helloSent = false;
  let worldSent = false;
  let lastBorder = null;
  let centre = null;                        // { x, y, s }: the last view centre and scale
  let box = null;
  let syncNext = false;

  // extra: { focus?: { x, y, zoom }, board?: rows, sync?: true }
  //   focus: the spectate camera the room picked while the player has no cells (law U_SPECTATE is the room's);
  //          it becomes the view centre and scale, and a cam record is sent with it every build it is given
  //   board: leaderboard rows for this player (law U_BOARD is the room's), appended as a board record
  //   sync:  send a sync record instead of world (every visible cell in full; the client drops the rest)
  // Every bundle built must reach the client: to skip a tick for a backed-up socket, do not call build.
  function build(frame, extra) {
    if (!frame || frame[FRAME_MARK] !== true) throw new TypeError('agView: build needs a frame from makeFrame');
    const focus = extra && extra.focus;
    const board = extra && extra.board;
    const sync = !!(extra && extra.sync) || syncNext;
    syncNext = false;
    const records = [];

    if (!helloSent) {
      records.push({ t: 'hello' });
      records.push({ t: 'border', minX: frame.border.minX, minY: frame.border.minY,
        maxX: frame.border.maxX, maxY: frame.border.maxY, mode: FFA_MODE });
      helloSent = true;
      lastBorder = frame.border;
    } else if (!borderEqual(lastBorder, frame.border)) {
      // A resend without the mode moves only the border (protocol semantics 6.2, T10).
      records.push({ t: 'border', minX: frame.border.minX, minY: frame.border.minY,
        maxX: frame.border.maxX, maxY: frame.border.maxY });
      lastBorder = frame.border;
    }

    // The view box.
    const own = frame.byOwner.get(playerId) || NO_CELLS;
    if (focus !== undefined && focus !== null) {
      if (typeof focus !== 'object') throw new TypeError('agView: focus must be { x, y, zoom }');
      finite(focus.x, 'focus x'); finite(focus.y, 'focus y'); finite(focus.zoom, 'focus zoom');
      if (!(focus.zoom > 0)) throw new RangeError('agView: focus zoom must be above 0');
    }
    if (own.length) {
      let sx = 0, sy = 0, sum = 0;
      for (const e of own) { sx += e.x; sy += e.y; sum += e.size; }
      centre = { x: sx / own.length, y: sy / own.length, s: scaleFor(sum, view) };
    } else if (focus) {
      centre = { x: focus.x, y: focus.y, s: Math.max(focus.zoom, view.minScale) };
    } else if (!centre) {
      centre = { x: (frame.border.minX + frame.border.maxX) / 2, y: (frame.border.minY + frame.border.maxY) / 2,
        s: scaleFor(0, view) };
    }
    box = viewBoxFor(centre.x, centre.y, centre.s, view);

    const stamp = ++stampCounter;
    const visible = [];
    for (const e of own) { e.stamp = stamp; visible.push(e); }
    query(frame, box, stamp, visible);
    visible.sort((a, b) => a.id - b.id);

    // Eats the client can apply, and the eaten ids it knows (removed in this bundle).
    const eaten = new Set();
    const eats = [];
    for (const pair of frame.eats) {
      const eatenId = pair[1];
      if (!known.has(eatenId) || eaten.has(eatenId)) continue;
      eaten.add(eatenId);
      if (known.has(pair[0])) eats.push([pair[0], eatenId]);
    }

    // Removals: eaten, deleted, out of view, or deleted and reused within this tick.
    const removed = [];
    for (const id of known.keys()) {
      if (eaten.has(id)) { removed.push(id); continue; }
      const e = frame.byId.get(id);
      if (!e || e.stamp !== stamp || frame.removedIds.has(id)) removed.push(id);
    }

    // Cell records. A reused id goes in a second world record after the removal of the old one.
    const cells = [];
    const ownNew = [];
    const reborn = [];
    const rebornOwn = [];
    const sent = [];
    for (const e of visible) {
      if (eaten.has(e.id)) continue;
      const prev = known.get(e.id);
      const mine = e.owner === playerId;
      if (prev && frame.removedIds.has(e.id)) {
        reborn.push(fullRecord(e));
        if (mine) rebornOwn.push(e.id);
        sent.push(e);
        continue;
      }
      if (!prev) {
        cells.push(fullRecord(e));
        if (mine && !announced.has(e.id)) ownNew.push(e.id);
        sent.push(e);
        continue;
      }
      const announce = mine && !announced.has(e.id);
      const rgbChanged = prev.r !== e.r || prev.g !== e.g || prev.b !== e.b;
      const nameChanged = e.name !== '' && e.name !== prev.name;
      if (!(sync || announce || rgbChanged || nameChanged || prev.wx !== e.wx || prev.wy !== e.wy ||
          prev.wsize !== e.wsize || prev.bits !== e.bits)) continue;
      const rec = cellRecord(e);
      if (sync || rgbChanged) rec.rgb = [e.r, e.g, e.b];
      if (sync ? e.name !== '' || prev.name !== '' : nameChanged) {
        const nm = e.name !== '' ? e.name : prev.name;
        if (nm !== '') rec.name = nm;
      }
      cells.push(rec);
      if (announce) ownNew.push(e.id);
      sent.push(e);
    }

    // Bookkeeping: what the client holds after this bundle.
    for (const id of removed) { known.delete(id); announced.delete(id); }
    for (const e of sent) {
      const prev = known.get(e.id);
      known.set(e.id, stateOf(e, prev ? prev.name : ''));
    }
    for (const id of ownNew) announced.add(id);
    for (const id of rebornOwn) announced.add(id);

    // Assembly, in the order the client must process it.
    if (!worldSent && ownNew.length) records.push({ t: 'world', eats: [], cells: [], removed: [] });
    for (const id of ownNew) records.push({ t: 'own', id });
    records.push({ t: sync ? 'sync' : 'world', eats, cells, removed });
    if (reborn.length) {
      for (const id of rebornOwn) records.push({ t: 'own', id });
      records.push({ t: 'world', eats: [], cells: reborn, removed: [] });
    }
    worldSent = true;
    if (focus) records.push({ t: 'cam', x: focus.x, y: focus.y, zoom: focus.zoom });
    if (board !== undefined && board !== null) records.push({ t: 'board', rows: board });
    return records;
  }

  function encode(records) {
    return agWire.encodeBundle(records, wireOpts);
  }

  return {
    playerId,
    build,
    encode,
    bundle(frame, extra) { return encode(build(frame, extra)); },
    // The next build sends a sync record (every visible cell in full; the client drops what is not listed).
    resync() { syncNext = true; },
    box() { return box && Object.assign({}, box); },
    isKnown(id) { return known.has(id); },
    isAnnounced(id) { return announced.has(id); },
    knownIds() { return Array.from(known.keys()); },
    knownCount() { return known.size; },
  };
}

module.exports = {
  VIEW_LAW_IDS,
  FRAME_LAW_IDS,
  FFA_MODE,
  makeFrame,
  createViewer,
  scaleFor,
  viewBoxFor,
  checkViewLaw,
};
