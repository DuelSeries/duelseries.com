// agar.io redo: our own binary wire for the free FFA game (build brief section 8, CHOSEN layout).
// One module for both ends: the server requires it (CommonJS) and the browser loads it as a plain
// script from /shared, where it lands on DuelAgarLib.agWire. The encoder and the decoder therefore
// can never disagree.
//
// A bundle is one tick for one socket, sent on `ag:f`:
//   u8 version (1), then records to the end of the buffer, each `u8 kind` + body, in the order the
//   client must process them. Little endian throughout.
//
// The records ARE the mirror messages of build brief section 6 (the contract between the wire, the
// net layer, the client world and the replay harness): encodeBundle takes an array of them and
// decodeBundle gives the same array back. Cell fields follow the world update of the protocol
// spec (protocol-semantics 3.1, 3.3): integer x, y, size; the six flag booleans every record;
// rgb and name only when the server sends them (absent = unchanged; a new cell without rgb is
// black on the client, so the view layer always sends rgb first time).
//
// Rules this module keeps:
// - It never rounds. Positions and sizes must already be integers (the server rounds with the
//   approved rounding rule, PARITY-LOG U-round); a non-integer throws on encode.
// - Id 0 is never valid (protocol-semantics 3.8 item 4); encode throws on it.
// - The name cap is an input (server law L37, in UTF-8 bytes after sanitizeName). The only
//   built-in ceiling is the u8 length byte of this layout (255), which is a property of the
//   format, not a game rule. Names are cut on a UTF-8 character boundary.
// - Decode never throws. A truncated or malformed bundle yields the records decoded before the
//   bad one, then one { t: 'error', reason, offset, kind } record, and stops. Counts are checked
//   against the bytes left before any loop, so a hostile count cannot make it allocate more
//   than the buffer holds.
(function (root, factory) {
  'use strict';
  var W = factory();
  var A = root.DuelAgarLib = root.DuelAgarLib || {};
  A.agWire = W;
  if (typeof module === 'object' && module.exports) module.exports = W;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var VERSION = 1;             // bundle format version (first byte)
  var PROTOCOL_VERSION = 1;    // carried by the hello record (CHOSEN)
  var NAME_BYTES_MAX = 255;    // u8 length byte: the format's own ceiling

  var KIND = {
    hello: 1,
    border: 2,
    own: 3,
    clearOwn: 4,
    clearAll: 5,
    world: 6,
    cam: 7,
    board: 8,
    sync: 9
  };
  var KIND_NAME = {};
  Object.keys(KIND).forEach(function (k) { KIND_NAME[KIND[k]] = k; });

  // Cell bits byte (section 8).
  var CELL_BIT = {
    virus: 1,
    food: 2,
    ejected: 4,
    agitated: 8,
    flag40: 16,
    party: 32,
    hasRgb: 64,
    hasName: 128
  };

  // Board row bits byte (section 8).
  var ROW_BIT = { me: 1, hasName: 2, hasRank: 4 };

  // Fixed sizes.
  var CELL_FIXED = 4 + 4 + 4 + 2 + 1;   // id, x, y, size, bits = 15
  var EAT_BYTES = 8;                    // u32 eater, u32 eaten
  var REMOVED_BYTES = 4;                // u32 id
  var BORDER_FIXED = 8 * 4 + 1;         // four f64 + hasMode = 33

  // ---------------------------------------------------------------------------------------
  // UTF-8 (TextEncoder/TextDecoder exist in every browser we support and in node 11+).
  // ---------------------------------------------------------------------------------------

  var encoder = new TextEncoder();
  var decoder = new TextDecoder('utf-8');

  // UTF-8 bytes of a name, cut to at most `cap` bytes on a character boundary.
  function nameBytes(name, cap) {
    var b = encoder.encode(String(name));
    if (b.length <= cap) return b;
    var cut = cap;
    // A byte of the form 10xxxxxx continues a character; never cut just before one.
    while (cut > 0 && (b[cut] & 0xC0) === 0x80) cut--;
    return b.subarray(0, cut);
  }

  function resolveCap(opts) {
    var cap = opts && opts.maxNameBytes;
    if (cap === undefined || cap === null) return NAME_BYTES_MAX;
    if (typeof cap !== 'number' || !(cap >= 0) || Math.floor(cap) !== cap) {
      throw new RangeError('agWire: maxNameBytes must be a non-negative integer');
    }
    return Math.min(cap, NAME_BYTES_MAX);
  }

  // ---------------------------------------------------------------------------------------
  // Encoder validation (server side: a bad value is our own bug, so it throws loudly).
  // ---------------------------------------------------------------------------------------

  function checkInt(v, lo, hi, what) {
    if (typeof v !== 'number' || Math.floor(v) !== v || v < lo || v > hi) {
      throw new RangeError('agWire: ' + what + ' must be an integer in [' + lo + ', ' + hi + '], got ' + v);
    }
    return v;
  }
  function checkId(v, what) { return checkInt(v, 1, 4294967295, what); }
  function checkFinite(v, what) {
    if (typeof v !== 'number' || !isFinite(v)) throw new RangeError('agWire: ' + what + ' must be finite');
    return v;
  }
  function checkList(v, what) {
    if (!Array.isArray(v)) throw new TypeError('agWire: ' + what + ' must be an array');
    if (v.length > 65535) throw new RangeError('agWire: ' + what + ' holds more than 65535 entries');
    return v;
  }
  function has(v) { return v !== undefined && v !== null; }

  // ---------------------------------------------------------------------------------------
  // Encode: measure every record first, allocate once, then write.
  // ---------------------------------------------------------------------------------------

  // Prepared names are cached per record during one encode so each string is UTF-8 encoded once.
  function prepCells(cells, cap) {
    var out = new Array(cells.length);
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (!c || typeof c !== 'object') throw new TypeError('agWire: cell ' + i + ' is not an object');
      checkId(c.id, 'cell id');
      checkInt(c.x, -2147483648, 2147483647, 'cell x');
      checkInt(c.y, -2147483648, 2147483647, 'cell y');
      checkInt(c.size, 0, 65535, 'cell size');
      if (has(c.rgb)) {
        if (!c.rgb || c.rgb.length !== 3) throw new TypeError('agWire: cell rgb must be [r, g, b]');
        checkInt(c.rgb[0], 0, 255, 'cell r');
        checkInt(c.rgb[1], 0, 255, 'cell g');
        checkInt(c.rgb[2], 0, 255, 'cell b');
      }
      out[i] = has(c.name) ? nameBytes(c.name, cap) : null;
    }
    return out;
  }

  function prepRows(rows, cap) {
    if (!Array.isArray(rows)) throw new TypeError('agWire: board rows must be an array');
    if (rows.length > 255) throw new RangeError('agWire: board holds more than 255 rows');
    var out = new Array(rows.length);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || typeof r !== 'object') throw new TypeError('agWire: board row ' + i + ' is not an object');
      if (has(r.rank)) checkInt(r.rank, 0, 65535, 'board rank');
      out[i] = has(r.name) ? nameBytes(r.name, cap) : null;
    }
    return out;
  }

  function worldSize(rec, names) {
    var n = 1 + 2 + rec.eats.length * EAT_BYTES + 2 + 2 + rec.removed.length * REMOVED_BYTES;
    for (var i = 0; i < rec.cells.length; i++) {
      var c = rec.cells[i];
      n += CELL_FIXED;
      if (has(c.rgb)) n += 3;
      if (names[i]) n += 1 + names[i].length;
    }
    return n;
  }

  // Validate one record and return { size, extra } where extra holds the prepared names.
  function measure(rec, cap) {
    if (!rec || typeof rec !== 'object') throw new TypeError('agWire: record is not an object');
    switch (rec.t) {
      case 'hello':
        if (has(rec.protocol)) checkInt(rec.protocol, 0, 65535, 'hello protocol');
        return { size: 1 + 2 };
      case 'border':
        checkFinite(rec.minX, 'border minX'); checkFinite(rec.minY, 'border minY');
        checkFinite(rec.maxX, 'border maxX'); checkFinite(rec.maxY, 'border maxY');
        if (has(rec.mode)) { checkInt(rec.mode, 0, 255, 'border mode'); return { size: 1 + BORDER_FIXED + 1 }; }
        return { size: 1 + BORDER_FIXED };
      case 'own':
        checkId(rec.id, 'own id');
        return { size: 1 + 4 };
      case 'clearOwn':
      case 'clearAll':
        return { size: 1 };
      case 'world':
      case 'sync': {
        checkList(rec.eats, rec.t + ' eats');
        checkList(rec.cells, rec.t + ' cells');
        checkList(rec.removed, rec.t + ' removed');
        for (var i = 0; i < rec.eats.length; i++) {
          var e = rec.eats[i];
          if (!e || e.length !== 2) throw new TypeError('agWire: eat ' + i + ' must be [eaterId, eatenId]');
          checkId(e[0], 'eater id'); checkId(e[1], 'eaten id');
        }
        for (var j = 0; j < rec.removed.length; j++) checkId(rec.removed[j], 'removed id');
        var names = prepCells(rec.cells, cap);
        return { size: worldSize(rec, names), extra: names };
      }
      case 'cam':
        checkFinite(rec.x, 'cam x'); checkFinite(rec.y, 'cam y'); checkFinite(rec.zoom, 'cam zoom');
        return { size: 1 + 12 };
      case 'board': {
        var rowNames = prepRows(rec.rows, cap);
        var n = 1 + 1;
        for (var k = 0; k < rec.rows.length; k++) {
          n += 1;
          if (has(rec.rows[k].rank)) n += 2;
          if (rowNames[k]) n += 1 + rowNames[k].length;
        }
        return { size: n, extra: rowNames };
      }
      default:
        throw new TypeError('agWire: unknown record type ' + rec.t);
    }
  }

  function Writer(buf) {
    this.b = buf;
    this.v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.p = 0;
  }
  Writer.prototype.u8 = function (x) { this.b[this.p++] = x; };
  Writer.prototype.u16 = function (x) { this.v.setUint16(this.p, x, true); this.p += 2; };
  Writer.prototype.u32 = function (x) { this.v.setUint32(this.p, x, true); this.p += 4; };
  Writer.prototype.i32 = function (x) { this.v.setInt32(this.p, x, true); this.p += 4; };
  Writer.prototype.f32 = function (x) { this.v.setFloat32(this.p, x, true); this.p += 4; };
  Writer.prototype.f64 = function (x) { this.v.setFloat64(this.p, x, true); this.p += 8; };
  Writer.prototype.bytes = function (src) { this.b.set(src, this.p); this.p += src.length; };

  function writeCell(w, c, name) {
    var bits = 0;
    if (c.virus) bits |= CELL_BIT.virus;
    if (c.food) bits |= CELL_BIT.food;
    if (c.ejected) bits |= CELL_BIT.ejected;
    if (c.agitated) bits |= CELL_BIT.agitated;
    if (c.flag40) bits |= CELL_BIT.flag40;
    if (c.party) bits |= CELL_BIT.party;
    if (has(c.rgb)) bits |= CELL_BIT.hasRgb;
    if (name) bits |= CELL_BIT.hasName;
    w.u32(c.id); w.i32(c.x); w.i32(c.y); w.u16(c.size); w.u8(bits);
    if (has(c.rgb)) { w.u8(c.rgb[0]); w.u8(c.rgb[1]); w.u8(c.rgb[2]); }
    if (name) { w.u8(name.length); w.bytes(name); }
  }

  function writeRecord(w, rec, extra) {
    w.u8(KIND[rec.t]);
    switch (rec.t) {
      case 'hello':
        w.u16(has(rec.protocol) ? rec.protocol : PROTOCOL_VERSION);
        break;
      case 'border':
        w.f64(rec.minX); w.f64(rec.minY); w.f64(rec.maxX); w.f64(rec.maxY);
        if (has(rec.mode)) { w.u8(1); w.u8(rec.mode); } else w.u8(0);
        break;
      case 'own':
        w.u32(rec.id);
        break;
      case 'clearOwn':
      case 'clearAll':
        break;
      case 'world':
      case 'sync': {
        var i;
        w.u16(rec.eats.length);
        for (i = 0; i < rec.eats.length; i++) { w.u32(rec.eats[i][0]); w.u32(rec.eats[i][1]); }
        w.u16(rec.cells.length);
        for (i = 0; i < rec.cells.length; i++) writeCell(w, rec.cells[i], extra[i]);
        w.u16(rec.removed.length);
        for (i = 0; i < rec.removed.length; i++) w.u32(rec.removed[i]);
        break;
      }
      case 'cam':
        w.f32(rec.x); w.f32(rec.y); w.f32(rec.zoom);
        break;
      case 'board':
        w.u8(rec.rows.length);
        for (var k = 0; k < rec.rows.length; k++) {
          var r = rec.rows[k], bits = 0;
          if (r.me) bits |= ROW_BIT.me;
          if (extra[k]) bits |= ROW_BIT.hasName;
          if (has(r.rank)) bits |= ROW_BIT.hasRank;
          w.u8(bits);
          if (has(r.rank)) w.u16(r.rank);
          if (extra[k]) { w.u8(extra[k].length); w.bytes(extra[k]); }
        }
        break;
    }
  }

  // records: array of mirror messages. opts.maxNameBytes: the approved L37 cap (bytes).
  // Returns a Uint8Array holding exactly the bundle.
  function encodeBundle(records, opts) {
    if (!Array.isArray(records)) throw new TypeError('agWire: records must be an array');
    var cap = resolveCap(opts);
    var total = 1;
    var plans = new Array(records.length);
    for (var i = 0; i < records.length; i++) {
      plans[i] = measure(records[i], cap);
      total += plans[i].size;
    }
    var buf = new Uint8Array(total);
    var w = new Writer(buf);
    w.u8(VERSION);
    for (var j = 0; j < records.length; j++) writeRecord(w, records[j], plans[j].extra);
    return buf;
  }

  // Byte length a record set would encode to (for view budgeting and tests).
  function bundleSize(records, opts) {
    var cap = resolveCap(opts);
    var total = 1;
    for (var i = 0; i < records.length; i++) total += measure(records[i], cap).size;
    return total;
  }

  // ---------------------------------------------------------------------------------------
  // Decode: never throws, never trusts a count it cannot back with bytes.
  // ---------------------------------------------------------------------------------------

  // Accept Uint8Array (and node Buffer), ArrayBuffer, or any ArrayBuffer view. The checks work
  // across realms (an iframe or a vm context), where instanceof would not.
  function asBytes(buf) {
    if (buf === null || typeof buf !== 'object') return null;
    if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (Object.prototype.toString.call(buf) === '[object ArrayBuffer]') return new Uint8Array(buf);
    return null;
  }

  function Short(reason) { this.reason = reason; }

  function Reader(b) {
    this.b = b;
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    this.p = 0;
  }
  Reader.prototype.left = function () { return this.b.length - this.p; };
  Reader.prototype.need = function (n, what) { if (this.b.length - this.p < n) throw new Short('truncated ' + what); };
  Reader.prototype.u8 = function () { return this.b[this.p++]; };
  Reader.prototype.u16 = function () { var x = this.v.getUint16(this.p, true); this.p += 2; return x; };
  Reader.prototype.u32 = function () { var x = this.v.getUint32(this.p, true); this.p += 4; return x; };
  Reader.prototype.i32 = function () { var x = this.v.getInt32(this.p, true); this.p += 4; return x; };
  Reader.prototype.f32 = function () { var x = this.v.getFloat32(this.p, true); this.p += 4; return x; };
  Reader.prototype.f64 = function () { var x = this.v.getFloat64(this.p, true); this.p += 8; return x; };
  Reader.prototype.str = function (what) {
    this.need(1, what + ' length');
    var len = this.u8();
    this.need(len, what);
    var s = decoder.decode(this.b.subarray(this.p, this.p + len));
    this.p += len;
    return s;
  };

  function readId(r, what) {
    var id = r.u32();
    if (id === 0) throw new Short('id 0 in ' + what);
    return id;
  }

  function readWorld(r, t) {
    r.need(2, 'eat count');
    var nEats = r.u16();
    r.need(nEats * EAT_BYTES, 'eats');
    var eats = [];
    for (var i = 0; i < nEats; i++) eats.push([readId(r, 'eat'), readId(r, 'eat')]);

    r.need(2, 'cell count');
    var nCells = r.u16();
    r.need(nCells * CELL_FIXED, 'cells');      // lower bound; each cell is checked again below
    var cells = [];
    for (var j = 0; j < nCells; j++) {
      r.need(CELL_FIXED, 'cell');
      var c = { id: readId(r, 'cell'), x: r.i32(), y: r.i32(), size: r.u16() };
      var bits = r.u8();
      c.virus = (bits & CELL_BIT.virus) !== 0;
      c.food = (bits & CELL_BIT.food) !== 0;
      c.ejected = (bits & CELL_BIT.ejected) !== 0;
      c.agitated = (bits & CELL_BIT.agitated) !== 0;
      c.flag40 = (bits & CELL_BIT.flag40) !== 0;
      c.party = (bits & CELL_BIT.party) !== 0;
      if (bits & CELL_BIT.hasRgb) { r.need(3, 'cell rgb'); c.rgb = [r.u8(), r.u8(), r.u8()]; }
      if (bits & CELL_BIT.hasName) c.name = r.str('cell name');
      cells.push(c);
    }

    r.need(2, 'removal count');
    var nRemoved = r.u16();
    r.need(nRemoved * REMOVED_BYTES, 'removals');
    var removed = [];
    for (var k = 0; k < nRemoved; k++) removed.push(readId(r, 'removal'));
    return { t: t, eats: eats, cells: cells, removed: removed };
  }

  function readRecord(r, kind) {
    switch (kind) {
      case KIND.hello:
        r.need(2, 'hello');
        return { t: 'hello', protocol: r.u16() };
      case KIND.border: {
        r.need(BORDER_FIXED, 'border');
        var a = r.f64(), b = r.f64(), c = r.f64(), d = r.f64();
        // Only a server bug sends a non-finite border; refusing it keeps NaN out of the camera.
        if (!isFinite(a) || !isFinite(b) || !isFinite(c) || !isFinite(d)) throw new Short('non-finite border');
        // Either corner order is accepted, as their client does (protocol-semantics 6.1).
        var m = { t: 'border', minX: Math.min(a, c), minY: Math.min(b, d), maxX: Math.max(a, c), maxY: Math.max(b, d) };
        var hasMode = r.u8();
        if (hasMode > 1) throw new Short('bad border mode flag');
        if (hasMode) { r.need(1, 'border mode'); m.mode = r.u8(); }
        return m;
      }
      case KIND.own:
        r.need(4, 'own');
        return { t: 'own', id: readId(r, 'own') };
      case KIND.clearOwn:
        return { t: 'clearOwn' };
      case KIND.clearAll:
        return { t: 'clearAll' };
      case KIND.world:
        return readWorld(r, 'world');
      case KIND.sync:
        return readWorld(r, 'sync');
      case KIND.cam:
        r.need(12, 'cam');
        var cx = r.f32(), cy = r.f32(), cz = r.f32();
        // A NaN or infinite value (or a zoom that is not positive) would stick in the camera for
        // the rest of the connection; only a server bug sends one, so it is refused.
        if (!isFinite(cx) || !isFinite(cy) || !(cz > 0) || !isFinite(cz)) throw new Short('bad cam value');
        return { t: 'cam', x: cx, y: cy, zoom: cz };
      case KIND.board: {
        r.need(1, 'board count');
        var n = r.u8();
        r.need(n, 'board rows');
        var rows = [];
        for (var i = 0; i < n; i++) {
          r.need(1, 'board row');
          var bits = r.u8(), row = {};
          if (bits & ROW_BIT.me) row.me = true;
          if (bits & ROW_BIT.hasRank) { r.need(2, 'board rank'); row.rank = r.u16(); }
          if (bits & ROW_BIT.hasName) row.name = r.str('board name');
          rows.push(row);
        }
        return { t: 'board', rows: rows };
      }
      default:
        throw new Short('unknown record kind');
    }
  }

  // Returns an array of mirror messages. On a bad bundle the last entry is
  // { t: 'error', reason, offset, kind } (offset = where the failing record starts).
  function decodeBundle(buf) {
    var out = [];
    var b = asBytes(buf);
    if (!b) { out.push({ t: 'error', reason: 'not binary', offset: 0, kind: null }); return out; }
    if (b.length < 1) { out.push({ t: 'error', reason: 'empty bundle', offset: 0, kind: null }); return out; }
    if (b[0] !== VERSION) { out.push({ t: 'error', reason: 'unknown version ' + b[0], offset: 0, kind: null }); return out; }
    var r = new Reader(b);
    r.p = 1;
    while (r.p < b.length) {
      var start = r.p;
      var kind = r.u8();
      try {
        out.push(readRecord(r, kind));
      } catch (e) {
        // Short = bad input. Anything else would be a bug here; it is still reported, never thrown,
        // because a throw inside the socket handler would kill the client's message loop.
        var reason = e instanceof Short ? e.reason : 'internal: ' + (e && e.message);
        out.push({ t: 'error', reason: reason, offset: start, kind: kind });
        return out;
      }
    }
    return out;
  }

  return {
    VERSION: VERSION,
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    NAME_BYTES_MAX: NAME_BYTES_MAX,
    KIND: KIND,
    KIND_NAME: KIND_NAME,
    CELL_BIT: CELL_BIT,
    ROW_BIT: ROW_BIT,
    encodeBundle: encodeBundle,
    decodeBundle: decodeBundle,
    bundleSize: bundleSize,
    nameBytes: nameBytes
  };
});
