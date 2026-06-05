// Uniform spatial grid (spatial hash) for broad-phase proximity queries, rebuilt
// every tick. Turns the O(n²·segments) snake-vs-snake and O(n·food) collision scans
// into roughly linear work: a query only visits the 3×3 block of cells around a
// point instead of walking the whole world. Cell size must be >= the largest
// interaction radius so a hit can never fall outside the 3×3 neighbourhood.
class SpatialGrid {
  constructor(cellSize) {
    this.cell = cellSize;
    this.map  = new Map(); // packed cell key -> array of items
  }

  clear() { this.map.clear(); }

  // Pack cell coords into one number. The +8192 offset keeps both axes positive so
  // the pack never collides; cy stays below the 16384 multiplier. World coords are
  // a few thousand units, so cell indices stay well within range.
  _cellKey(cx, cy) { return (cx + 8192) * 16384 + (cy + 8192); }

  insert(x, y, item) {
    const k = this._cellKey(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let arr = this.map.get(k);
    if (!arr) { arr = []; this.map.set(k, arr); }
    arr.push(item);
  }

  // Visit every item in the 3×3 block of cells around (x, y). The callback may
  // return true to stop early (e.g. once a collision is found).
  forEachNear(x, y, fn) {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const arr = this.map.get(this._cellKey(gx, gy));
        if (arr) { for (let i = 0; i < arr.length; i++) { if (fn(arr[i])) return; } }
      }
    }
  }
}

module.exports = SpatialGrid;
