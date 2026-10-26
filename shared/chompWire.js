// Chomp's snapshot wire: one small binary frame per snapshot, encoded once on the server and sent to every socket in
// the room (volatile, so a slow phone drops frames instead of queueing them). Positions are 1/64 tile.
//
//   header  10 B  u8 version, u8 mode (0 scatter, 1 chase), u16 players, u16 ghosts, u32 tick
//   player  14 B  u16 id, i16 x, i16 y, u8 dir+1, u8 flags, u16 seq (last input), u16 since (ticks since it), u8 power
//                 (ticks left / 6), u8 spare
//   ghost    8 B  i16 x, i16 y, u8 dir, u8 kind | state << 2, u8 fright (ticks left / 6), u8 spare
// Ghosts always come in the same order, so the browser knows each one by its place in the list.
(function (root) {
  'use strict';
  var VERSION = 1, SUB = 64, HEAD = 10, PL = 14, GH = 8;
  var F = { MOVING: 1, POWER: 2, SAFE: 4, DYING: 8 };
  var GSTATE = ['active', 'house', 'leaving', 'eyes', 'entering'];
  var GKIND = ['blinky', 'pinky', 'inky', 'clyde'];

  function clamp16(v) { v = Math.round(v * SUB); return v < -32768 ? -32768 : v > 32767 ? 32767 : v; }

  // players: [{ id, x, y, dir, flags, seq, since, power }], ghosts: [{ x, y, dir, kind, state, fright }]
  function encode(tick, mode, players, ghosts) {
    var buf = new ArrayBuffer(HEAD + players.length * PL + ghosts.length * GH);
    var v = new DataView(buf), o = 0;
    v.setUint8(o, VERSION); v.setUint8(o + 1, mode); v.setUint16(o + 2, players.length, true);
    v.setUint16(o + 4, ghosts.length, true); v.setUint32(o + 6, tick >>> 0, true); o = HEAD;
    for (var i = 0; i < players.length; i++, o += PL) {
      var p = players[i];
      v.setUint16(o, p.id & 0xffff, true);
      v.setInt16(o + 2, clamp16(p.x), true);
      v.setInt16(o + 4, clamp16(p.y), true);
      v.setUint8(o + 6, (p.dir + 1) & 0xff);
      v.setUint8(o + 7, p.flags & 0xff);
      v.setUint16(o + 8, p.seq & 0xffff, true);
      v.setUint16(o + 10, Math.min(65535, Math.max(0, p.since | 0)), true);
      v.setUint8(o + 12, Math.min(255, Math.max(0, Math.ceil(p.power / 6))));
    }
    for (var j = 0; j < ghosts.length; j++, o += GH) {
      var g = ghosts[j];
      v.setInt16(o, clamp16(g.x), true);
      v.setInt16(o + 2, clamp16(g.y), true);
      v.setUint8(o + 4, g.dir & 3);
      v.setUint8(o + 5, (g.kind & 3) | (g.state << 2));
      v.setUint8(o + 6, Math.min(255, Math.max(0, Math.ceil(g.fright / 6))));
    }
    return buf;
  }

  function decode(buf) {
    if (buf && buf.buffer && !(buf instanceof ArrayBuffer)) buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    var v = new DataView(buf);
    if (v.byteLength < HEAD || v.getUint8(0) !== VERSION) return null;
    var nP = v.getUint16(2, true), nG = v.getUint16(4, true);
    if (v.byteLength < HEAD + nP * PL + nG * GH) return null;
    var out = { mode: v.getUint8(1), tick: v.getUint32(6, true), players: [], ghosts: [] }, o = HEAD;
    for (var i = 0; i < nP; i++, o += PL) {
      out.players.push({
        id: v.getUint16(o, true), x: v.getInt16(o + 2, true) / SUB, y: v.getInt16(o + 4, true) / SUB,
        dir: v.getUint8(o + 6) - 1, flags: v.getUint8(o + 7), seq: v.getUint16(o + 8, true),
        since: v.getUint16(o + 10, true), power: v.getUint8(o + 12) * 6
      });
    }
    for (var j = 0; j < nG; j++, o += GH) {
      var ks = v.getUint8(o + 5);
      out.ghosts.push({
        x: v.getInt16(o, true) / SUB, y: v.getInt16(o + 2, true) / SUB, dir: v.getUint8(o + 4) & 3,
        kind: ks & 3, state: ks >> 2, fright: v.getUint8(o + 6) * 6
      });
    }
    return out;
  }

  var Wr = { VERSION: VERSION, SUB: SUB, F: F, GSTATE: GSTATE, GKIND: GKIND, encode: encode, decode: decode };
  if (typeof module === 'object' && module.exports) module.exports = Wr;
  else root.ChompWire = Wr;
})(typeof self !== 'undefined' ? self : this);
