// Compact snapshot codec.
//
// A snapshot is mostly coordinates: every snake's body points + every food's
// position. As JSON those are bulky decimal strings (e.g. "1234.5"). This packs all
// the coordinates into ONE little-endian Int16 buffer (2 bytes each, quantized to
// whole world units — invisible on screen since snakes are drawn thick and motion is
// interpolated), and keeps the light metadata (ids, names, colours, flags) as a plain
// object. Result: much smaller + faster than JSON for the part that dominates the
// payload, with no change to what the client ultimately sees.
//
// Wire shape: emit('snapshot', meta, coordsBuffer). Same module runs on the server
// (encode) and in the browser (decode) so the two can never disagree on the layout.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SnapshotCodec = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function clamp16(v) { v = Math.round(v); return v < -32768 ? -32768 : (v > 32767 ? 32767 : v); }

  // snap = { t, worldRadius, snakes:[{id,name,color,segs:[x,y,...],angle,boosting,
  //          boostRamp,hatId,boostId,score,length,boostRatio,worth}],
  //          food:[{id,x,y,color,size,dropped,isGolden,...}], leaderboard, mm }
  // -> { meta (no coords), coords: ArrayBuffer of Int16 }
  function encodeSnapshot(snap) {
    let n = 0;
    for (let i = 0; i < snap.snakes.length; i++) n += snap.snakes[i].segs.length;
    n += snap.food.length * 2;

    const ab = new ArrayBuffer(n * 2);
    const dv = new DataView(ab);
    let o = 0;

    const snakes = new Array(snap.snakes.length);
    for (let i = 0; i < snap.snakes.length; i++) {
      const s = snap.snakes[i], segs = s.segs;
      for (let k = 0; k < segs.length; k++) { dv.setInt16(o, clamp16(segs[k]), true); o += 2; }
      snakes[i] = {
        id: s.id, name: s.name, color: s.color, angle: s.angle,
        boosting: s.boosting, boostRamp: s.boostRamp, hatId: s.hatId, boostId: s.boostId,
        score: s.score, length: s.length, boostRatio: s.boostRatio, worth: s.worth,
        nseg: segs.length,
      };
    }

    const food = new Array(snap.food.length);
    for (let i = 0; i < snap.food.length; i++) {
      const f = snap.food[i];
      dv.setInt16(o, clamp16(f.x), true); o += 2;
      dv.setInt16(o, clamp16(f.y), true); o += 2;
      // value/cashValue intentionally dropped — the client never reads them.
      food[i] = { id: f.id, color: f.color, size: f.size, dropped: f.dropped, isGolden: f.isGolden };
    }

    const meta = {
      t: snap.t, worldRadius: snap.worldRadius,
      snakes, food, leaderboard: snap.leaderboard, mm: snap.mm,
    };
    return { meta, coords: ab };
  }

  // (meta, coords) -> the full snapshot the client expects (snakes get .segs back,
  // food gets .x/.y back). Mutates and returns `meta` for speed. `coords` may be an
  // ArrayBuffer (browser) or a Buffer/typed-array view (Node).
  function decodeSnapshot(meta, coords) {
    let ab = coords;
    if (coords && !(coords instanceof ArrayBuffer) && coords.buffer) {
      ab = coords.buffer.slice(coords.byteOffset || 0, (coords.byteOffset || 0) + coords.byteLength);
    }
    const dv = new DataView(ab);
    let o = 0;

    for (let i = 0; i < meta.snakes.length; i++) {
      const s = meta.snakes[i], nseg = s.nseg;
      const segs = new Array(nseg);
      for (let k = 0; k < nseg; k++) { segs[k] = dv.getInt16(o, true); o += 2; }
      s.segs = segs;
      delete s.nseg;
    }
    for (let i = 0; i < meta.food.length; i++) {
      const f = meta.food[i];
      f.x = dv.getInt16(o, true); o += 2;
      f.y = dv.getInt16(o, true); o += 2;
    }
    return meta;
  }

  return { encodeSnapshot, decodeSnapshot };
});
