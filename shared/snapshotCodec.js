// Compact snapshot codec.
//
// A snapshot is mostly food and coordinates. As JSON those are bulky decimal
// strings (e.g. "1234.5"), so everything that repeats per-entity is packed into
// ONE little-endian binary buffer and only the genuinely light metadata (snake
// ids, names, leaderboard) stays a plain object.
//
// Coordinates are Int16, quantized to whole world units — invisible on screen
// since snakes are drawn thick and motion is interpolated.
//
// FOOD is packed whole, not just its coordinates. It used to ride along as a
// JSON object per pellet, {id: <36-char uuid>, color: "#ff4040", size:
// 0.8634566789226366, dropped: false, isGolden: false}, which measured 141
// bytes per pellet on the wire. At ~1050 visible pellets that is 150 KB per
// snapshot and ~4.5 MB/s per player at 30Hz — enough to back up a phone's
// connection on its own, and it scaled straight up with the pellet count. Now
// each pellet is 12 fixed bytes:
//
//     x   Int16    world units
//     y   Int16    world units
//     id  Uint32   food id (server hands out integers; see server/Food.js)
//     ci  Uint16   index into meta.fc, the snapshot's colour palette
//     sz  Uint8    size * SIZE_Q  (range 0..5.1, step 0.02 — r = 3*size, so
//                  the quantization is well under a world unit)
//     fl  Uint8    bit0 dropped, bit1 isGolden
//
// Colours are indirected through a per-snapshot palette because a snapshot only
// ever contains a handful of distinct colours (the 9 food colours, gold, and
// one per dead snake whose drops are in view) but repeats them across every
// pellet. The index is Uint16 rather than Uint8 so an unusually colourful
// snapshot can never overflow it.
//
// Wire shape: emit('snapshot', meta, coordsBuffer). Same module runs on the
// server (encode) and in the browser (decode) so the two can never disagree on
// the layout.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SnapshotCodec = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FOOD_BYTES = 12;   // per pellet, see the layout above
  const SIZE_Q     = 50;   // size quantization steps per unit

  function clamp16(v) { v = Math.round(v); return v < -32768 ? -32768 : (v > 32767 ? 32767 : v); }

  // snap = { t, worldRadius, snakes:[{id,name,color,segs:[x,y,...],angle,boosting,
  //          boostRamp,score,length,boostRatio,worth}],
  //          food:[{id,x,y,color,size,dropped,isGolden,...}], leaderboard, mm }
  // -> { meta (no coords, no food array), coords: ArrayBuffer }
  function encodeSnapshot(snap) {
    let nSeg = 0;
    for (let i = 0; i < snap.snakes.length; i++) nSeg += snap.snakes[i].segs.length;
    const nFood = snap.food.length;

    const ab = new ArrayBuffer(nSeg * 2 + nFood * FOOD_BYTES);
    const dv = new DataView(ab);
    let o = 0;

    const snakes = new Array(snap.snakes.length);
    for (let i = 0; i < snap.snakes.length; i++) {
      const s = snap.snakes[i], segs = s.segs;
      for (let k = 0; k < segs.length; k++) { dv.setInt16(o, clamp16(segs[k]), true); o += 2; }
      snakes[i] = {
        id: s.id, name: s.name, color: s.color, angle: s.angle,
        boosting: s.boosting, boostRamp: s.boostRamp,
        score: s.score, length: s.length, boostRatio: s.boostRatio, worth: s.worth,
        nseg: segs.length,
      };
    }

    // Colour palette, built as we go — a snapshot has ~10-40 distinct colours
    // across ~1000 pellets, so this collapses the biggest repeated field.
    const fc = [];
    const cidx = new Map();
    for (let i = 0; i < nFood; i++) {
      const f = snap.food[i];
      dv.setInt16(o, clamp16(f.x), true); o += 2;
      dv.setInt16(o, clamp16(f.y), true); o += 2;
      dv.setUint32(o, f.id >>> 0, true);  o += 4;

      const col = f.color;
      let ci = cidx.get(col);
      if (ci === undefined) { ci = fc.length; fc.push(col); cidx.set(col, ci); }
      dv.setUint16(o, ci, true); o += 2;

      let q = Math.round(f.size * SIZE_Q);
      if (q < 0) q = 0; else if (q > 255) q = 255;
      dv.setUint8(o, q); o += 1;

      dv.setUint8(o, (f.dropped ? 1 : 0) | (f.isGolden ? 2 : 0)); o += 1;
      // value/cashValue intentionally dropped — the client never reads them.
    }

    const meta = {
      t: snap.t, worldRadius: snap.worldRadius,
      wcx: snap.worldCx || 0, wcy: snap.worldCy || 0,
      snakes, nfood: nFood, fc,
      leaderboard: snap.leaderboard, mm: snap.mm,
    };
    return { meta, coords: ab };
  }

  // (meta, coords) -> the full snapshot the client expects (snakes get .segs
  // back, food is rebuilt from the buffer). Mutates and returns `meta` for
  // speed. `coords` may be an ArrayBuffer (browser) or a Buffer/typed-array
  // view (Node).
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

    const nFood = meta.nfood || 0, fc = meta.fc || [];
    const food = new Array(nFood);
    for (let i = 0; i < nFood; i++) {
      const x  = dv.getInt16(o, true);  o += 2;
      const y  = dv.getInt16(o, true);  o += 2;
      const id = dv.getUint32(o, true); o += 4;
      const ci = dv.getUint16(o, true); o += 2;
      const sz = dv.getUint8(o);        o += 1;
      const fl = dv.getUint8(o);        o += 1;
      food[i] = {
        id, x, y,
        color: fc[ci],
        size: sz / SIZE_Q,
        dropped:  (fl & 1) !== 0,
        isGolden: (fl & 2) !== 0,
      };
    }
    meta.food = food;
    /* Short on the wire, long in the client. The rest of the client already
       says worldRadius, so the centre that goes with it says worldCx/worldCy
       rather than leaving two spellings of the same idea in the codebase. */
    meta.worldCx = meta.wcx || 0;
    meta.worldCy = meta.wcy || 0;
    delete meta.wcx;
    delete meta.wcy;
    delete meta.nfood;
    delete meta.fc;
    return meta;
  }

  return { encodeSnapshot, decodeSnapshot };
});
