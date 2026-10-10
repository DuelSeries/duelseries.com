// slither.io redo: our own binary wire for the snake game (build brief section 7, decision D5).
//
// This is NOT their protocol. There are no packet letters, no length prefixes of theirs and no
// handshake. A bundle carries the in-play events of build brief section 6.2, and only the fields
// slApply consumes, so the client applies the same events whether they came from their bytes
// (decoded by the reference decoder) or from ours.
//
// One module for both ends: node requires it (CommonJS) and the browser loads it as a plain script
// from /shared, where it lands on DuelSlither.slWire. It defines no other global.
//
// Numbers never lose precision. Every number is written as a small "kind" byte plus an unsigned
// integer, where the kind is one of the client's own scale expressions (section 7.3). The encoder
// searches for a kind and an integer that give back the IDENTICAL double (Object.is). When none
// does, it writes the 8 raw bytes of the double (kind 15), which also carries -0. So decode(encode(x))
// equals x exactly for every finite x, and two builds always give the same bytes. Kind 15 can also hold
// NaN or Infinity, but the decoder refuses them: their byte protocol cannot carry such a value, so one
// can only come from a server bug, and it must not reach the client state.
//
// Rules this module keeps:
// - Encode throws on a value it cannot carry: wrong type, an integer out of range, a string char
//   code above 255, minimap cells out of scan order or outside the grid.
// - Decode never throws. A bad or truncated bundle gives the events decoded so far plus one
//   { type: 'wire_error', reason, offset } (offset = first byte of the bad record) and stops.
//   Every count is checked against the bytes left before its loop, so a hostile count cannot make
//   it allocate more than the buffer holds.
// - Food records depend on the protocol version the client holds (their branches at
//   game.js:8591, 8618, 8663, 8694, 8736, 8758). The encoder picks the form from its current pv
//   and writes the form into the record, so the decoder needs no pv.
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    var D = root.DuelSlither = root.DuelSlither || {};
    D.slWire = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var VERSION = 1;
  var MAXU = 4294967295;
  var KIND_F64 = 15;

  // Scale kinds 0..10 (build brief 7.3). `value` is the client's expression for the wire integer,
  // kept in the client's operator order so the double matches bit for bit. `guess` is the
  // encoder's first try for the integer; it then tries guess - 1 and guess + 1.
  var KINDS = [
    { value: function (r) { return r; },
      guess: function (v) { return v; } },
    { value: function (r) { return r * 2 * Math.PI / 256; },             // game.js:7401
      guess: function (v) { return Math.round(v * 256 / (2 * Math.PI)); } },
    { value: function (r) { return r * 2 * Math.PI / 65535; },           // game.js:7540
      guess: function (v) { return Math.round(v * 65535 / (2 * Math.PI)); } },
    { value: function (r) { return r * 2 * Math.PI / 16777215; },        // game.js:7558, 8423
      guess: function (v) { return Math.round(v * 16777215 / (2 * Math.PI)); } },
    { value: function (r) { return r / 18; },                            // game.js:7405
      guess: function (v) { return Math.round(v * 18); } },
    { value: function (r) { return r / 1E3; },                           // game.js:7301, 7566, 8430
      guess: function (v) { return Math.round(v * 1E3); } },
    { value: function (r) { return r / 16777215; },                      // game.js:7605
      guess: function (v) { return Math.round(v * 16777215); } },
    { value: function (r) { return r / 5; },                             // game.js:8437, 8610
      guess: function (v) { return Math.round(v * 5); } },
    { value: function (r) { return 1 + r * 3; },                         // game.js:8798
      guess: function (v) { return Math.round((v - 1) / 3); } },
    { value: function (r) { return r / 10; },                            // game.js:7292
      guess: function (v) { return Math.round(v * 10); } },
    { value: function (r) { return r / 100; },                           // game.js:7294
      guess: function (v) { return Math.round(v * 100); } }
  ];

  // Record type numbers (build brief 7.4).
  var T_IGNORED = 0, T_INIT = 1, T_ROT = 2, T_FAM = 3, T_TAIL = 4, T_RSC = 5, T_MOVE = 6, T_LB = 7,
    T_DEAD = 8, T_SECT_ADD = 9, T_SECT_REM = 10, T_SECT_W = 11, T_LONGEST = 12, T_PONG = 13,
    T_MAP = 14, T_ADD = 15, T_REMOVE = 16, T_FOOD_SECT = 17, T_FOOD_ADD = 18, T_FOOD_EAT = 19,
    T_PREY_MOVE = 20, T_PREY_REM = 21, T_PREY_EATEN = 22, T_PREY_ADD = 23, T_KILLS = 24, T_FLUX = 25;

  // Event types the client only counts (build brief 6.2 last row), in the order of their `which` byte.
  var IGNORED = ['server_version', 'admin_info', 'team_scores', 'session_id', 'debug_point', 'unknown',
    'malformed', 'empty'];
  var INIT_NUMS = ['spangdv', 'nsp1', 'nsp2', 'nsp3', 'mamu', 'mamu2', 'cst'];
  var INIT_OPT = ['pv', 'defaultMsl', 'realSid', 'fluxGrd', 'gameMode', 'extraB'];
  var MOVE_CMDS = 'gGnN+=';
  var GROW_CMDS = 'nN+';
  var MAP_CMDS = 'UMVuL';
  var EAT_CMDS = 'cC<';
  var MAP_LIMIT = 512;     // game.js:8080 (minimap size capped at 512)
  var MAP_U_SIZE = 80;     // game.js:8303-8337 (`u` is always 80 x 80)

  // Food form by protocol version: 0 at pv >= 14, 1 at pv 4..13, 2 below 4.
  function foodForm(pv) { return pv >= 14 ? 0 : pv >= 4 ? 1 : 2; }

  // ------------------------------------------------------------------ checks (encode side)

  function show(v) {
    if (typeof v === 'number' && Object.is(v, -0)) return '-0';
    if (typeof v === 'string') return JSON.stringify(v.length > 40 ? v.slice(0, 40) + '...' : v);
    if (v === undefined) return 'undefined';
    try { return String(JSON.stringify(v)).slice(0, 60); } catch (e) { return typeof v; }
  }
  function fail(what, v) { throw new RangeError('slWire: cannot carry ' + what + ' = ' + show(v)); }
  function isUint(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAXU && !Object.is(v, -0);
  }
  function needPv(pv) { if (!Number.isInteger(pv)) fail('pv', pv); return pv; }
  function needBool(v, what) { if (typeof v !== 'boolean') fail(what, v); return v; }
  function needCmd(v, list, what) {
    if (typeof v !== 'string' || v.length !== 1 || list.indexOf(v) < 0) fail(what, v);
    return list.indexOf(v);
  }
  function has(o, k) { return o[k] !== undefined; }

  // ------------------------------------------------------------------ writer

  function Writer() { this.b = new Uint8Array(256); this.n = 0; }
  Writer.prototype.room = function (k) {
    if (this.n + k <= this.b.length) return;
    var len = this.b.length * 2;
    while (len < this.n + k) len *= 2;
    var nb = new Uint8Array(len);
    nb.set(this.b.subarray(0, this.n));
    this.b = nb;
  };
  Writer.prototype.u8 = function (v) { this.room(1); this.b[this.n++] = v; };
  // Unsigned LEB128: 7 bits per byte, low group first, high bit = more bytes follow.
  // Plain arithmetic, not bit operators, so values above 2^31 stay exact.
  Writer.prototype.uv = function (v) {
    var x = v;
    for (;;) {
      var low = x % 128;
      x = (x - low) / 128;
      if (x === 0) { this.u8(low); return; }
      this.u8(low + 128);
    }
  };
  Writer.prototype.f64 = function (v) {
    this.room(8);
    new DataView(this.b.buffer, this.b.byteOffset + this.n, 8).setFloat64(0, v, true);
    this.n += 8;
  };
  Writer.prototype.bytes = function () { return this.b.slice(0, this.n); };

  // Each put* checks the value, writes it and returns the value as the decoder will give it back.
  function putByte(w, v, what) {
    if (!isUint(v) || v > 255) fail(what, v);
    w.u8(v);
    return v;
  }
  function putU(w, v, what) {
    if (!isUint(v)) fail(what, v);
    w.uv(v);
    return v;
  }
  // Zigzag, then LEB128 (used for `dir`, which can be negative at pv < 3: `u8 - 48`, game.js:7553).
  function putS(w, v, what) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < -2147483648 || v > 2147483647 || Object.is(v, -0)) {
      fail(what, v);
    }
    w.uv(v >= 0 ? 2 * v : -2 * v - 1);
    return v;
  }
  function putNum(w, v, what) {
    if (typeof v !== 'number') fail(what, v);
    for (var k = 0; k < KINDS.length; k++) {
      var r0 = KINDS[k].guess(v);
      for (var t = 0; t < 3; t++) {
        var r = t === 0 ? r0 : t === 1 ? r0 - 1 : r0 + 1;
        if (isUint(r) && Object.is(KINDS[k].value(r), v)) {
          w.u8(k);
          w.uv(r);
          return v;
        }
      }
    }
    w.u8(KIND_F64);
    w.f64(v);
    return v;
  }
  function putStr(w, s, what) {
    if (typeof s !== 'string') fail(what, s);
    for (var i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) fail(what + ' (char code above 255)', s);
    w.uv(s.length);
    for (var j = 0; j < s.length; j++) w.u8(s.charCodeAt(j));
    return s;
  }
  function putBytes(w, a, what) {
    if (!a || typeof a !== 'object' || !(Array.isArray(a) || ArrayBuffer.isView(a)) || typeof a.length !== 'number') {
      fail(what, a);
    }
    var copy = [];
    for (var i = 0; i < a.length; i++) {
      var v = a[i];
      if (!isUint(v) || v > 255) fail(what + '[' + i + ']', v);
      copy.push(v);
    }
    w.uv(copy.length);
    for (var j = 0; j < copy.length; j++) w.u8(copy[j]);
    return copy;
  }
  // Minimap cells as gaps between scan indexes. Backward scan (U, M, V, L) starts at
  // (dim - 1, dim - 1), x going down, then the row above (game.js:8077-8302); forward (u) starts at
  // (0, 0) (game.js:8303-8337).
  function putCells(w, list, dim, forward, what) {
    if (!Array.isArray(list)) fail(what, list);
    var out = [], prev = -1;
    w.uv(list.length);
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!Array.isArray(c) || c.length !== 2) fail(what + '[' + i + ']', c);
      var x = c[0], y = c[1];
      if (!isUint(x) || !isUint(y) || x >= dim || y >= dim) fail(what + '[' + i + '] (outside the grid)', c);
      var idx = forward ? y * dim + x : (dim - 1 - y) * dim + (dim - 1 - x);
      if (idx <= prev) fail(what + '[' + i + '] (out of scan order)', c);
      w.uv(idx - prev - 1);
      prev = idx;
      out.push([x, y]);
    }
    return out;
  }

  // ------------------------------------------------------------------ encode one event

  // Writes `ev` and returns its projection: the consumed fields of build brief 6.2, named as the
  // reference decoder names them. decodeBundle gives back exactly this object.
  function putEvent(w, ev, pv) {
    if (!ev || typeof ev !== 'object') fail('event', ev);
    var type = ev.type, o = { type: type }, i, flags, raw;
    var which = IGNORED.indexOf(type);
    if (which >= 0) {
      w.u8(T_IGNORED);
      w.u8(which);
      return o;
    }
    switch (type) {
      case 'init': {                                                   // game.js:7274-7383
        w.u8(T_INIT);
        o.grd = putU(w, ev.grd, 'init.grd');
        o.mscps = putU(w, ev.mscps, 'init.mscps');
        o.sectorSize = putU(w, ev.sectorSize, 'init.sectorSize');
        o.sectorCount = putU(w, ev.sectorCount, 'init.sectorCount');
        for (i = 0; i < INIT_NUMS.length; i++) o[INIT_NUMS[i]] = putNum(w, ev[INIT_NUMS[i]], 'init.' + INIT_NUMS[i]);
        var nOpt = 0;
        while (nOpt < INIT_OPT.length && has(ev, INIT_OPT[nOpt])) nOpt++;
        for (i = nOpt; i < INIT_OPT.length; i++) {
          if (has(ev, INIT_OPT[i])) fail('init.' + INIT_OPT[i] + ' (optional fields must be a prefix)', ev[INIT_OPT[i]]);
        }
        w.u8(nOpt);
        for (i = 0; i < nOpt; i++) o[INIT_OPT[i]] = putU(w, ev[INIT_OPT[i]], 'init.' + INIT_OPT[i]);
        return o;
      }
      case 'snake_rot': {                                              // game.js:7384-7594
        var rOwn = needBool(ev.own, 'snake_rot.own');
        flags = (rOwn ? 1 : 0) | (has(ev, 'dir') ? 2 : 0) | (has(ev, 'ang') ? 4 : 0) |
          (has(ev, 'wang') ? 8 : 0) | (has(ev, 'sp') ? 16 : 0);
        w.u8(T_ROT);
        w.u8(flags);
        o.own = rOwn;
        if (!rOwn) o.id = putU(w, ev.id, 'snake_rot.id');
        if (flags & 2) o.dir = putS(w, ev.dir, 'snake_rot.dir');
        if (flags & 4) o.ang = putNum(w, ev.ang, 'snake_rot.ang');
        if (flags & 8) o.wang = putNum(w, ev.wang, 'snake_rot.wang');
        if (flags & 16) o.sp = putNum(w, ev.sp, 'snake_rot.sp');
        return o;
      }
      case 'snake_fam':                                                // game.js:7602-7611
        w.u8(T_FAM);
        o.id = putU(w, ev.id, 'snake_fam.id');
        o.fam = putNum(w, ev.fam, 'snake_fam.fam');
        return o;
      case 'snake_tail':                                               // game.js:7612-7635
        flags = has(ev, 'fam') ? 1 : 0;
        w.u8(T_TAIL);
        w.u8(flags);
        o.id = putU(w, ev.id, 'snake_tail.id');
        if (flags & 1) o.fam = putNum(w, ev.fam, 'snake_tail.fam');
        return o;
      case 'own_rsc':                                                  // game.js:7636-7638
        w.u8(T_RSC);
        o.rsc = putU(w, ev.rsc, 'own_rsc.rsc');
        return o;
      case 'snake_move': {                                             // game.js:7662-7903
        var ci = needCmd(ev.cmd, MOVE_CMDS, 'snake_move.cmd');
        var mOwn = needBool(ev.own, 'snake_move.own');
        var hasXY = has(ev, 'xx') || has(ev, 'yy');
        raw = ev.raw && typeof ev.raw === 'object' ? ev.raw : null;
        var hasRel = !!raw && (has(raw, 'bx') || has(raw, 'by'));
        flags = (mOwn ? 1 : 0) | (has(ev, 'iang') ? 2 : 0) | (hasXY ? 4 : 0) | (hasRel ? 8 : 0);
        w.u8(T_MOVE);
        w.u8(ci);
        w.u8(flags);
        o.cmd = ev.cmd;
        o.own = mOwn;
        if (!mOwn) o.id = putU(w, ev.id, 'snake_move.id');
        if (flags & 2) o.iang = putU(w, ev.iang, 'snake_move.iang');
        if (flags & 4) {
          o.xx = putNum(w, ev.xx, 'snake_move.xx');
          o.yy = putNum(w, ev.yy, 'snake_move.yy');
        }
        if (flags & 8) {
          o.raw = {
            bx: putByte(w, raw.bx, 'snake_move.raw.bx'),
            by: putByte(w, raw.by, 'snake_move.raw.by')
          };
        }
        if (GROW_CMDS.indexOf(ev.cmd) >= 0) o.fam = putNum(w, ev.fam, 'snake_move.fam');  // game.js:7751-7754
        return o;
      }
      case 'leaderboard': {                                            // game.js:7904-7967
        var rows = ev.rows;
        if (!Array.isArray(rows)) fail('leaderboard.rows', rows);
        w.u8(T_LB);
        o.myPos = putU(w, ev.myPos, 'leaderboard.myPos');
        o.rank = putU(w, ev.rank, 'leaderboard.rank');
        o.count = putU(w, ev.count, 'leaderboard.count');
        w.uv(rows.length);
        o.rows = [];
        for (i = 0; i < rows.length; i++) {
          var row = rows[i];
          if (!row || typeof row !== 'object' || !row.raw || typeof row.raw !== 'object') fail('leaderboard.rows[' + i + ']', row);
          var pr = {};
          pr.sct = putU(w, row.sct, 'leaderboard.rows[' + i + '].sct');
          pr.fam = putNum(w, row.fam, 'leaderboard.rows[' + i + '].fam');
          pr.raw = { cv: putByte(w, row.raw.cv, 'leaderboard.rows[' + i + '].raw.cv') };
          pr.nick = putStr(w, row.nick, 'leaderboard.rows[' + i + '].nick');
          o.rows.push({ sct: pr.sct, fam: pr.fam, nick: pr.nick, raw: pr.raw });
        }
        return o;
      }
      case 'dead':                                                     // game.js:7968-7977
        w.u8(T_DEAD);
        o.code = putU(w, ev.code, 'dead.code');
        return o;
      case 'sector_add':                                               // game.js:7978-7987
      case 'sector_remove':                                            // game.js:7988-8031 (pv >= 8)
        w.u8(type === 'sector_add' ? T_SECT_ADD : T_SECT_REM);
        o.sx = putU(w, ev.sx, type + '.sx');
        o.sy = putU(w, ev.sy, type + '.sy');
        return o;
      case 'sector_w':                                                 // game.js:7988-8031 (pv < 8)
        w.u8(T_SECT_W);
        o.mode = putU(w, ev.mode, 'sector_w.mode');
        o.sx = putU(w, ev.sx, 'sector_w.sx');
        o.sy = putU(w, ev.sy, 'sector_w.sy');
        return o;
      case 'longest_msg':                                              // game.js:8032-8069
        w.u8(T_LONGEST);
        o.sct = putU(w, ev.sct, 'longest_msg.sct');
        o.fam = putNum(w, ev.fam, 'longest_msg.fam');
        o.nick = putStr(w, ev.nick, 'longest_msg.nick');
        o.msg = putStr(w, ev.msg, 'longest_msg.msg');
        return o;
      case 'pong':                                                     // game.js:8070-8076
        w.u8(T_PONG);
        return o;
      case 'minimap':                                                  // game.js:8077-8337
        return putMinimap(w, ev, o);
      case 'snake_add':                                                // game.js:8418-8572
        return putSnakeAdd(w, ev, o);
      case 'snake_remove':                                             // game.js:8573-8589
        w.u8(T_REMOVE);
        o.id = putU(w, ev.id, 'snake_remove.id');
        o.kill = needBool(ev.kill, 'snake_remove.kill');
        w.u8(o.kill ? 1 : 0);
        return o;
      case 'food_sector':                                              // game.js:8590-8660
        return putFoodSector(w, ev, o, foodForm(pv));
      case 'food_add':                                                 // game.js:8661-8730
        return putFoodAdd(w, ev, o, foodForm(pv));
      case 'food_eat':                                                 // game.js:8731-8794
        return putFoodEat(w, ev, o, foodForm(pv));
      case 'prey_move':                                                // game.js:8795-8869
        flags = (has(ev, 'dir') ? 1 : 0) | (has(ev, 'ang') ? 2 : 0) | (has(ev, 'wang') ? 4 : 0) | (has(ev, 'sp') ? 8 : 0);
        w.u8(T_PREY_MOVE);
        o.id = putU(w, ev.id, 'prey_move.id');
        o.xx = putNum(w, ev.xx, 'prey_move.xx');
        o.yy = putNum(w, ev.yy, 'prey_move.yy');
        w.u8(flags);
        if (flags & 1) o.dir = putS(w, ev.dir, 'prey_move.dir');
        if (flags & 2) o.ang = putNum(w, ev.ang, 'prey_move.ang');
        if (flags & 4) o.wang = putNum(w, ev.wang, 'prey_move.wang');
        if (flags & 8) o.sp = putNum(w, ev.sp, 'prey_move.sp');
        return o;
      case 'prey_remove':                                              // game.js:8870-8912
        w.u8(T_PREY_REM);
        o.id = putU(w, ev.id, 'prey_remove.id');
        return o;
      case 'prey_eaten':
        w.u8(T_PREY_EATEN);
        o.id = putU(w, ev.id, 'prey_eaten.id');
        o.eater = putU(w, ev.eater, 'prey_eaten.eater');
        return o;
      case 'prey_add':
        w.u8(T_PREY_ADD);
        o.id = putU(w, ev.id, 'prey_add.id');
        o.cv = putU(w, ev.cv, 'prey_add.cv');
        o.xx = putNum(w, ev.xx, 'prey_add.xx');
        o.yy = putNum(w, ev.yy, 'prey_add.yy');
        o.rad = putNum(w, ev.rad, 'prey_add.rad');
        o.dir = putS(w, ev.dir, 'prey_add.dir');
        o.wang = putNum(w, ev.wang, 'prey_add.wang');
        o.ang = putNum(w, ev.ang, 'prey_add.ang');
        o.sp = putNum(w, ev.sp, 'prey_add.sp');
        return o;
      case 'kill_count':                                               // game.js:8913-8917
        w.u8(T_KILLS);
        o.id = putU(w, ev.id, 'kill_count.id');
        o.count = putU(w, ev.count, 'kill_count.count');
        return o;
      case 'flux':                                                     // game.js:8918-8928
        w.u8(T_FLUX);
        o.fluxGrd = putU(w, ev.fluxGrd, 'flux.fluxGrd');
        return o;
      default:
        return fail('event type', type);
    }
  }

  function putMinimap(w, ev, o) {
    var ci = needCmd(ev.cmd, MAP_CMDS, 'minimap.cmd');
    var cmd = ev.cmd, raw, dim, i;
    w.u8(T_MAP);
    w.u8(ci);
    o.cmd = cmd;
    if (cmd === 'U' || cmd === 'M' || cmd === 'L') {
      raw = ev.raw && typeof ev.raw === 'object' ? ev.raw : {};
      var rawSize = putU(w, raw.size, 'minimap.raw.size');
      dim = Math.min(MAP_LIMIT, rawSize);
      if (ev.size !== dim) fail('minimap.size (must be min(512, raw.size))', ev.size);
      if (cmd === 'L') {
        o.teamCount = putU(w, ev.teamCount, 'minimap.teamCount');
        if (!Array.isArray(ev.teams) || ev.teams.length !== ev.teamCount) fail('minimap.teams (one list per team)', ev.teams);
        o.raw = { size: rawSize };
        o.size = dim;
        o.teams = [];
        for (i = 0; i < ev.teams.length; i++) o.teams.push(putCells(w, ev.teams[i], dim, false, 'minimap.teams[' + i + ']'));
      } else {
        o.raw = { size: rawSize };
        o.size = dim;
        o.pixels = putCells(w, ev.pixels, dim, false, 'minimap.pixels');
      }
    } else if (cmd === 'V') {
      o.size = putU(w, ev.size, 'minimap.size');
      o.toggles = putCells(w, ev.toggles, ev.size, false, 'minimap.toggles');
    } else {
      if (ev.size !== MAP_U_SIZE) fail('minimap.size (u is 80)', ev.size);
      o.size = MAP_U_SIZE;
      o.pixels = putCells(w, ev.pixels, MAP_U_SIZE, true, 'minimap.pixels');
    }
    return o;
  }

  // Body points as the wire gives them: the first point {x, y} (u24 each), then deltas {bx, by}
  // (u8 each), then at pv >= 15 an optional last point {iang} (game.js:8460-8530).
  function putSnakeAdd(w, ev, o) {
    var raw = ev.raw && typeof ev.raw === 'object' ? ev.raw : null;
    var pts = raw ? raw.pts : undefined;
    if (!Array.isArray(pts)) fail('snake_add.raw.pts', pts);
    var n = pts.length, hasFirst = n > 0, hasIang = false, i;
    for (i = 0; i < n; i++) {
      if (!pts[i] || typeof pts[i] !== 'object') fail('snake_add.raw.pts[' + i + ']', pts[i]);
    }
    if (hasFirst && (!has(pts[0], 'x') || !has(pts[0], 'y'))) fail('snake_add.raw.pts[0] (first point needs x, y)', pts[0]);
    if (n > 1 && has(pts[n - 1], 'iang')) hasIang = true;
    var nDeltas = hasFirst ? n - 1 - (hasIang ? 1 : 0) : 0;
    w.u8(T_ADD);
    o.id = putU(w, ev.id, 'snake_add.id');
    o.ang = putNum(w, ev.ang, 'snake_add.ang');
    o.wang = putNum(w, ev.wang, 'snake_add.wang');
    o.sp = putNum(w, ev.sp, 'snake_add.sp');
    o.fam = putNum(w, ev.fam, 'snake_add.fam');
    o.cv = putU(w, ev.cv, 'snake_add.cv');
    o.snx = putNum(w, ev.snx, 'snake_add.snx');
    o.sny = putNum(w, ev.sny, 'snake_add.sny');
    o.nick = putStr(w, ev.nick, 'snake_add.nick');
    var hasSkin = has(ev, 'skin');
    w.u8((hasSkin ? 1 : 0) | (hasFirst ? 2 : 0) | (hasIang ? 4 : 0));
    if (hasSkin) o.skin = putBytes(w, ev.skin, 'snake_add.skin');
    var outPts = [];
    if (hasFirst) {
      outPts.push({ x: putU(w, pts[0].x, 'snake_add.raw.pts[0].x'), y: putU(w, pts[0].y, 'snake_add.raw.pts[0].y') });
    }
    w.uv(nDeltas);
    for (i = 1; i <= nDeltas; i++) {
      var p = pts[i];
      if (has(p, 'iang')) fail('snake_add.raw.pts[' + i + '] (an iang point must be last)', p);
      outPts.push({ bx: putByte(w, p.bx, 'snake_add.raw.pts[' + i + '].bx'), by: putByte(w, p.by, 'snake_add.raw.pts[' + i + '].by') });
    }
    if (hasIang) outPts.push({ iang: putU(w, pts[n - 1].iang, 'snake_add.raw.pts[' + (n - 1) + '].iang') });
    o.raw = { pts: outPts };
    return o;
  }

  function putFoodSector(w, ev, o, form) {
    var foods = ev.foods, i;
    if (!Array.isArray(foods)) fail('food_sector.foods', foods);
    w.u8(T_FOOD_SECT);
    w.u8(form);
    if (form !== 1) {
      o.sx = putU(w, ev.sx, 'food_sector.sx');
      o.sy = putU(w, ev.sy, 'food_sector.sy');
    }
    w.uv(foods.length);
    o.foods = [];
    for (i = 0; i < foods.length; i++) {
      var f = foods[i], q = {}, at = 'food_sector.foods[' + i + ']';
      if (!f || typeof f !== 'object') fail(at, f);
      if (form === 2) q.id = putU(w, f.id, at + '.id');
      q.cv = putU(w, f.cv, at + '.cv');
      if (form === 1) {
        q.xx = putU(w, f.xx, at + '.xx');
        q.yy = putU(w, f.yy, at + '.yy');
      } else {
        q.rx = putU(w, f.rx, at + '.rx');
        q.ry = putU(w, f.ry, at + '.ry');
      }
      q.rad = putNum(w, f.rad, at + '.rad');
      o.foods.push(q);
    }
    return o;
  }

  function putFoodAdd(w, ev, o, form) {
    var rapid = needBool(ev.rapid, 'food_add.rapid');
    w.u8(T_FOOD_ADD);
    w.u8(form);
    o.rapid = rapid;
    if (form === 0) {
      var sLast = needBool(ev.sectorFromLast, 'food_add.sectorFromLast');
      var cLast = needBool(ev.cvFromLast, 'food_add.cvFromLast');
      w.u8((rapid ? 1 : 0) | (sLast ? 2 : 0) | (cLast ? 4 : 0));
      o.sectorFromLast = sLast;
      if (!sLast) {
        o.sx = putU(w, ev.sx, 'food_add.sx');
        o.sy = putU(w, ev.sy, 'food_add.sy');
      }
      o.rx = putU(w, ev.rx, 'food_add.rx');
      o.ry = putU(w, ev.ry, 'food_add.ry');
      o.cvFromLast = cLast;
      if (!cLast) o.cv = putU(w, ev.cv, 'food_add.cv');
      o.rad = putNum(w, ev.rad, 'food_add.rad');
      return o;
    }
    if (ev.noop !== undefined && ev.noop !== true && ev.noop !== false) fail('food_add.noop', ev.noop);
    var noop = ev.noop === true;
    w.u8((rapid ? 1 : 0) | (noop ? 8 : 0));
    if (form === 1) {
      o.cv = putU(w, ev.cv, 'food_add.cv');
      if (noop) { o.noop = true; return o; }
      o.xx = putU(w, ev.xx, 'food_add.xx');
      o.yy = putU(w, ev.yy, 'food_add.yy');
      o.rad = putNum(w, ev.rad, 'food_add.rad');
      return o;
    }
    o.id = putU(w, ev.id, 'food_add.id');
    if (noop) { o.noop = true; return o; }
    o.cv = putU(w, ev.cv, 'food_add.cv');
    o.sx = putU(w, ev.sx, 'food_add.sx');
    o.sy = putU(w, ev.sy, 'food_add.sy');
    o.rx = putU(w, ev.rx, 'food_add.rx');
    o.ry = putU(w, ev.ry, 'food_add.ry');
    o.rad = putNum(w, ev.rad, 'food_add.rad');
    return o;
  }

  function putFoodEat(w, ev, o, form) {
    var ci = needCmd(ev.cmd, EAT_CMDS, 'food_eat.cmd');
    w.u8(T_FOOD_EAT);
    w.u8(ci);
    w.u8(form);
    o.cmd = ev.cmd;
    if (form === 0) {
      var sLast = needBool(ev.sectorFromLast, 'food_eat.sectorFromLast');
      w.u8(sLast ? 1 : 0);
      o.sectorFromLast = sLast;
      if (!sLast) {
        o.sx = putU(w, ev.sx, 'food_eat.sx');
        o.sy = putU(w, ev.sy, 'food_eat.sy');
      }
      o.rx = putU(w, ev.rx, 'food_eat.rx');
      o.ry = putU(w, ev.ry, 'food_eat.ry');
      if (ev.cmd === '<') o.eater = putU(w, ev.eater, 'food_eat.eater');
      return o;
    }
    w.u8(0);
    if (form === 1) {
      o.xx = putU(w, ev.xx, 'food_eat.xx');
      o.yy = putU(w, ev.yy, 'food_eat.yy');
    } else {
      o.id = putU(w, ev.id, 'food_eat.id');
    }
    o.eater = putU(w, ev.eater, 'food_eat.eater');
    return o;
  }

  // ------------------------------------------------------------------ public encode side

  // `pv` = the protocol version the client holds when the first event is applied. An `init` that
  // carries `pv` switches it for the events after it, as the client does (game.js:7308).
  function encodeBundle(events, pv) {
    if (!Array.isArray(events)) fail('events', events);
    var cur = needPv(pv), w = new Writer();
    w.u8(VERSION);
    for (var i = 0; i < events.length; i++) {
      var o = putEvent(w, events[i], cur);
      if (o.type === 'init' && o.pv !== undefined) cur = o.pv;
    }
    return w.bytes();
  }

  function projectEvent(ev, pv) {
    return putEvent(new Writer(), ev, needPv(pv));
  }

  function projectFrame(events, pv) {
    if (!Array.isArray(events)) fail('events', events);
    var cur = needPv(pv), out = [];
    for (var i = 0; i < events.length; i++) {
      var o = putEvent(new Writer(), events[i], cur);
      if (o.type === 'init' && o.pv !== undefined) cur = o.pv;
      out.push(o);
    }
    return out;
  }

  // ------------------------------------------------------------------ reader (decode side)

  function WireError(reason) { this.reason = reason; }

  function Reader(b, m) { this.b = b; this.m = m; this.end = b.length; }
  Reader.prototype.left = function () { return this.end - this.m; };
  Reader.prototype.u8 = function () {
    if (this.m >= this.end) throw new WireError('short');
    return this.b[this.m++];
  };
  Reader.prototype.uv = function () {
    var v = 0, mul = 1;
    for (var i = 0; i < 5; i++) {
      var c = this.u8();
      if (i === 4 && c > 15) throw new WireError('value');   // more than 32 bits
      v += (c & 127) * mul;
      if (c < 128) return v;
      mul *= 128;
    }
    throw new WireError('value');
  };
  Reader.prototype.sv = function () {
    var z = this.uv();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  };
  Reader.prototype.num = function () {
    var k = this.u8();
    if (k < KINDS.length) return KINDS[k].value(this.uv());
    if (k !== KIND_F64) throw new WireError('value');
    if (this.left() < 8) throw new WireError('short');
    var v = new DataView(this.b.buffer, this.b.byteOffset + this.m, 8).getFloat64(0, true);
    if (!isFinite(v)) throw new WireError('value');          // NaN and Infinity are refused (see the header)
    this.m += 8;
    return v;
  };
  Reader.prototype.count = function (minBytesEach) {
    var n = this.uv();
    if (n * minBytesEach > this.left()) throw new WireError('count');
    return n;
  };
  Reader.prototype.str = function () {
    var n = this.count(1), s = '';
    for (var i = 0; i < n; i++) s += String.fromCharCode(this.b[this.m++]);
    return s;
  };
  Reader.prototype.bytes = function () {
    var n = this.count(1), out = [];
    for (var i = 0; i < n; i++) out.push(this.b[this.m++]);
    return out;
  };
  Reader.prototype.bool = function () {
    var v = this.u8();
    if (v > 1) throw new WireError('value');
    return v === 1;
  };
  Reader.prototype.flags = function (allowed) {
    var f = this.u8();
    if (f & ~allowed) throw new WireError('value');
    return f;
  };
  Reader.prototype.index = function (list) {
    var i = this.u8();
    if (i >= list.length) throw new WireError('value');
    return i;
  };
  Reader.prototype.cells = function (dim, forward) {
    var n = this.count(1), out = [], prev = -1, total = dim * dim;
    for (var i = 0; i < n; i++) {
      var idx = prev + 1 + this.uv();
      if (idx >= total) throw new WireError('value');
      prev = idx;
      var a = idx % dim, q = (idx - a) / dim;
      out.push(forward ? [a, q] : [dim - 1 - a, dim - 1 - q]);
    }
    return out;
  };

  function readEvent(r) {
    var t = r.u8(), o, f, i, n;
    switch (t) {
      case T_IGNORED:
        return { type: IGNORED[r.index(IGNORED)] };
      case T_INIT: {
        o = { type: 'init' };
        o.grd = r.uv();
        o.mscps = r.uv();
        o.sectorSize = r.uv();
        o.sectorCount = r.uv();
        for (i = 0; i < INIT_NUMS.length; i++) o[INIT_NUMS[i]] = r.num();
        n = r.u8();
        if (n > INIT_OPT.length) throw new WireError('value');
        for (i = 0; i < n; i++) o[INIT_OPT[i]] = r.uv();
        return o;
      }
      case T_ROT:
        f = r.flags(31);
        o = { type: 'snake_rot', own: (f & 1) !== 0 };
        if (!(f & 1)) o.id = r.uv();
        if (f & 2) o.dir = r.sv();
        if (f & 4) o.ang = r.num();
        if (f & 8) o.wang = r.num();
        if (f & 16) o.sp = r.num();
        return o;
      case T_FAM:
        o = { type: 'snake_fam' };
        o.id = r.uv();
        o.fam = r.num();
        return o;
      case T_TAIL:
        f = r.flags(1);
        o = { type: 'snake_tail' };
        o.id = r.uv();
        if (f & 1) o.fam = r.num();
        return o;
      case T_RSC:
        return { type: 'own_rsc', rsc: r.uv() };
      case T_MOVE: {
        var cmd = MOVE_CMDS.charAt(r.index(MOVE_CMDS));
        f = r.flags(15);
        o = { type: 'snake_move', cmd: cmd, own: (f & 1) !== 0 };
        if (!(f & 1)) o.id = r.uv();
        if (f & 2) o.iang = r.uv();
        if (f & 4) {
          o.xx = r.num();
          o.yy = r.num();
        }
        if (f & 8) {
          var bx = r.u8();
          o.raw = { bx: bx, by: r.u8() };
        }
        if (GROW_CMDS.indexOf(cmd) >= 0) o.fam = r.num();
        return o;
      }
      case T_LB: {
        o = { type: 'leaderboard' };
        o.myPos = r.uv();
        o.rank = r.uv();
        o.count = r.uv();
        n = r.count(5);                    // a row is at least 5 bytes: sct, fam (kind + 1), cv, nick length
        o.rows = [];
        for (i = 0; i < n; i++) {
          var sct = r.uv(), fam = r.num(), cv = r.u8();
          o.rows.push({ sct: sct, fam: fam, nick: r.str(), raw: { cv: cv } });
        }
        return o;
      }
      case T_DEAD:
        return { type: 'dead', code: r.uv() };
      case T_SECT_ADD:
      case T_SECT_REM:
        o = { type: t === T_SECT_ADD ? 'sector_add' : 'sector_remove' };
        o.sx = r.uv();
        o.sy = r.uv();
        return o;
      case T_SECT_W:
        o = { type: 'sector_w' };
        o.mode = r.uv();
        o.sx = r.uv();
        o.sy = r.uv();
        return o;
      case T_LONGEST:
        o = { type: 'longest_msg' };
        o.sct = r.uv();
        o.fam = r.num();
        o.nick = r.str();
        o.msg = r.str();
        return o;
      case T_PONG:
        return { type: 'pong' };
      case T_MAP:
        return readMinimap(r);
      case T_ADD:
        return readSnakeAdd(r);
      case T_REMOVE:
        o = { type: 'snake_remove' };
        o.id = r.uv();
        o.kill = r.bool();
        return o;
      case T_FOOD_SECT:
        return readFoodSector(r);
      case T_FOOD_ADD:
        return readFoodAdd(r);
      case T_FOOD_EAT:
        return readFoodEat(r);
      case T_PREY_MOVE:
        o = { type: 'prey_move' };
        o.id = r.uv();
        o.xx = r.num();
        o.yy = r.num();
        f = r.flags(15);
        if (f & 1) o.dir = r.sv();
        if (f & 2) o.ang = r.num();
        if (f & 4) o.wang = r.num();
        if (f & 8) o.sp = r.num();
        return o;
      case T_PREY_REM:
        return { type: 'prey_remove', id: r.uv() };
      case T_PREY_EATEN:
        o = { type: 'prey_eaten' };
        o.id = r.uv();
        o.eater = r.uv();
        return o;
      case T_PREY_ADD:
        o = { type: 'prey_add' };
        o.id = r.uv();
        o.cv = r.uv();
        o.xx = r.num();
        o.yy = r.num();
        o.rad = r.num();
        o.dir = r.sv();
        o.wang = r.num();
        o.ang = r.num();
        o.sp = r.num();
        return o;
      case T_KILLS:
        o = { type: 'kill_count' };
        o.id = r.uv();
        o.count = r.uv();
        return o;
      case T_FLUX:
        return { type: 'flux', fluxGrd: r.uv() };
      default:
        throw new WireError('type');
    }
  }

  function readMinimap(r) {
    var cmd = MAP_CMDS.charAt(r.index(MAP_CMDS)), o = { type: 'minimap', cmd: cmd }, rawSize, dim, i;
    if (cmd === 'U' || cmd === 'M') {
      rawSize = r.uv();
      dim = Math.min(MAP_LIMIT, rawSize);
      o.raw = { size: rawSize };
      o.size = dim;
      o.pixels = r.cells(dim, false);
    } else if (cmd === 'V') {
      o.size = r.uv();
      o.toggles = r.cells(o.size, false);
    } else if (cmd === 'u') {
      o.size = MAP_U_SIZE;
      o.pixels = r.cells(MAP_U_SIZE, true);
    } else {
      rawSize = r.uv();
      dim = Math.min(MAP_LIMIT, rawSize);
      o.teamCount = r.count(1);            // each team list is at least its 1-byte count
      o.raw = { size: rawSize };
      o.size = dim;
      o.teams = [];
      for (i = 0; i < o.teamCount; i++) o.teams.push(r.cells(dim, false));
    }
    return o;
  }

  function readSnakeAdd(r) {
    var o = { type: 'snake_add' }, i;
    o.id = r.uv();
    o.ang = r.num();
    o.wang = r.num();
    o.sp = r.num();
    o.fam = r.num();
    o.cv = r.uv();
    o.snx = r.num();
    o.sny = r.num();
    o.nick = r.str();
    var f = r.flags(7);
    if (f & 1) o.skin = r.bytes();
    var pts = [];
    if (f & 2) {
      var x = r.uv();
      pts.push({ x: x, y: r.uv() });
    }
    var nd = r.count(2);                   // each delta is 2 bytes
    if (nd > 0 && !(f & 2)) throw new WireError('value');
    for (i = 0; i < nd; i++) {
      var bx = r.u8();
      pts.push({ bx: bx, by: r.u8() });
    }
    if (f & 4) {
      if (!(f & 2)) throw new WireError('value');
      pts.push({ iang: r.uv() });
    }
    o.raw = { pts: pts };
    return o;
  }

  function readFoodSector(r) {
    var form = r.u8(), o = { type: 'food_sector' }, i;
    if (form > 2) throw new WireError('value');
    if (form !== 1) {
      o.sx = r.uv();
      o.sy = r.uv();
    }
    var n = r.count(form === 2 ? 6 : 5);   // smallest food record: ints of 1 byte, rad of 2
    o.foods = [];
    for (i = 0; i < n; i++) {
      var q = {};
      if (form === 2) q.id = r.uv();
      q.cv = r.uv();
      if (form === 1) {
        q.xx = r.uv();
        q.yy = r.uv();
      } else {
        q.rx = r.uv();
        q.ry = r.uv();
      }
      q.rad = r.num();
      o.foods.push(q);
    }
    return o;
  }

  function readFoodAdd(r) {
    var form = r.u8(), o = { type: 'food_add' }, f;
    if (form > 2) throw new WireError('value');
    f = r.flags(form === 0 ? 7 : 9);
    o.rapid = (f & 1) !== 0;
    if (form === 0) {
      o.sectorFromLast = (f & 2) !== 0;
      if (!o.sectorFromLast) {
        o.sx = r.uv();
        o.sy = r.uv();
      }
      o.rx = r.uv();
      o.ry = r.uv();
      o.cvFromLast = (f & 4) !== 0;
      if (!o.cvFromLast) o.cv = r.uv();
      o.rad = r.num();
      return o;
    }
    var noop = (f & 8) !== 0;
    if (form === 1) {
      o.cv = r.uv();
      if (noop) { o.noop = true; return o; }
      o.xx = r.uv();
      o.yy = r.uv();
      o.rad = r.num();
      return o;
    }
    o.id = r.uv();
    if (noop) { o.noop = true; return o; }
    o.cv = r.uv();
    o.sx = r.uv();
    o.sy = r.uv();
    o.rx = r.uv();
    o.ry = r.uv();
    o.rad = r.num();
    return o;
  }

  function readFoodEat(r) {
    var cmd = EAT_CMDS.charAt(r.index(EAT_CMDS)), form = r.u8(), o = { type: 'food_eat', cmd: cmd }, f;
    if (form > 2) throw new WireError('value');
    f = r.flags(form === 0 ? 1 : 0);
    if (form === 0) {
      o.sectorFromLast = (f & 1) !== 0;
      if (!o.sectorFromLast) {
        o.sx = r.uv();
        o.sy = r.uv();
      }
      o.rx = r.uv();
      o.ry = r.uv();
      if (cmd === '<') o.eater = r.uv();
      return o;
    }
    if (form === 1) {
      o.xx = r.uv();
      o.yy = r.uv();
    } else {
      o.id = r.uv();
    }
    o.eater = r.uv();
    return o;
  }

  function asBytes(u8) {
    if (u8 instanceof Uint8Array) return u8;
    if (typeof ArrayBuffer !== 'undefined') {
      if (u8 instanceof ArrayBuffer) return new Uint8Array(u8);
      if (u8 && ArrayBuffer.isView(u8)) return new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
    }
    return null;
  }

  function wireError(reason, offset) { return { type: 'wire_error', reason: reason, offset: offset }; }

  // Runs `readOne` over the records after the version byte. Never throws.
  function decodeRecords(u8, readOne) {
    var out = [];
    var b = asBytes(u8);
    if (!b) { out.push(wireError('input', 0)); return out; }
    if (b.length < 1 || b[0] !== VERSION) { out.push(wireError('version', 0)); return out; }
    var r = new Reader(b, 1);
    while (r.m < r.end) {
      var start = r.m;
      try {
        out.push(readOne(r));
      } catch (e) {
        out.push(wireError(e instanceof WireError ? e.reason : 'internal', start));
        return out;
      }
    }
    return out;
  }

  function decodeBundle(u8) { return decodeRecords(u8, readEvent); }

  // ------------------------------------------------------------------ input bundle (client to server)

  // Records: 1 angle + u8 q (0..250, game.js:4728); 2 turn + u8 (left v, right v + 128, the byte
  // their client puts after 252, game.js:4514-4536); 3 boost + u8 on; 4 ping (no body).
  var I_ANGLE = 1, I_TURN = 2, I_BOOST = 3, I_PING = 4;

  function encodeInput(list) {
    if (!Array.isArray(list)) fail('input events', list);
    var w = new Writer();
    w.u8(VERSION);
    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      if (!ev || typeof ev !== 'object') fail('input event', ev);
      if (ev.type === 'angle') {
        if (!isUint(ev.q) || ev.q > 250) fail('angle.q', ev.q);
        w.u8(I_ANGLE);
        w.u8(ev.q);
      } else if (ev.type === 'turn') {
        if (ev.dir !== 'left' && ev.dir !== 'right') fail('turn.dir', ev.dir);
        if (!isUint(ev.v) || ev.v > 127) fail('turn.v', ev.v);
        w.u8(I_TURN);
        w.u8(ev.dir === 'right' ? ev.v + 128 : ev.v);
      } else if (ev.type === 'boost') {
        needBool(ev.on, 'boost.on');
        w.u8(I_BOOST);
        w.u8(ev.on ? 1 : 0);
      } else if (ev.type === 'ping') {
        w.u8(I_PING);
      } else {
        fail('input event type', ev.type);
      }
    }
    return w.bytes();
  }

  function readInput(r) {
    var t = r.u8(), b;
    if (t === I_ANGLE) {
      b = r.u8();
      if (b > 250) throw new WireError('value');
      return { type: 'angle', q: b };
    }
    if (t === I_TURN) {
      b = r.u8();
      return b >= 128 ? { type: 'turn', dir: 'right', v: b - 128 } : { type: 'turn', dir: 'left', v: b };
    }
    if (t === I_BOOST) return { type: 'boost', on: r.bool() };
    if (t === I_PING) return { type: 'ping' };
    throw new WireError('type');
  }

  function decodeInput(u8) { return decodeRecords(u8, readInput); }

  return {
    VERSION: VERSION,
    encodeBundle: encodeBundle,
    decodeBundle: decodeBundle,
    projectEvent: projectEvent,
    projectFrame: projectFrame,
    encodeInput: encodeInput,
    decodeInput: decodeInput
  };
});
