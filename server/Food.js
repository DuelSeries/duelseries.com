const C = require('../shared/constants');

// Six-colour food palette (owner-chosen): red, orange, darker yellow, green, purple,
// darker pink. No white/pale or blue/teal orbs.
// slither.io's exact food palette, extracted from their client's rrs[]/ggs[]/bbs[]
// arrays. Their newFood does `if (cv > 9) cv %= 9`, so food is limited to these
// first nine entries of the 42-colour skin palette. Full set in
// snake-design/slither-palette.json.
const FOOD_COLORS = [
  '#c080ff', // purple
  '#9099ff', // periwinkle
  '#80d0d0', // teal
  '#80ff80', // green
  '#eeee70', // yellow
  '#ffa060', // orange
  '#ff9090', // salmon
  '#ff4040', // red
  '#e030e0', // magenta
];

// Food ids are plain incrementing integers, not uuids. The snapshot codec packs
// each pellet's id as a Uint32, and a 36-char uuid string was by far the biggest
// part of the ~141 bytes every pellet used to cost on the wire. The counter is
// process-wide so ids stay unique across rooms; it wraps at 2^32, which at the
// spawn rates here is years of continuous uptime.
let nextFoodId = 1;

class FoodManager {
  constructor() {
    this.items = new Map();
    /* A live array of the same pellets, kept in step with the Map.

       getAll() used to be Array.from(items.values()), and it is called from
       the 60Hz tick AND the 30Hz snapshot broadcast. At FOOD_SPAWN_COUNT of
       3600 that is a 3600-element array built NINETY times a second per busy
       room, about 2.6 MB/s of garbage from this one method before anything
       else in the snapshot path allocates.

       Nothing was wrong with any single call. The cost only shows up as the
       heap filling at a steady rate and the collector stopping the world for
       80-160ms when it does, which is felt as the whole game hitching at
       roughly regular intervals, in every room at once, attributable to no
       job — because a collection is not a job.

       Maintained here in O(1): append on spawn, swap-and-pop on remove, with
       each pellet remembering its own index. */
    this._all = [];
  }

  /* cx/cy default to the origin, which is where every mode but the battle
     royale keeps its world, so these signatures are additive. */
  spawnInitial(worldRadius, cx, cy) {
    for (let i = 0; i < C.FOOD_SPAWN_COUNT; i++) {
      this.spawnOne(worldRadius, undefined, undefined, undefined, undefined,
                    undefined, undefined, undefined, cx, cy);
    }
  }

  spawnOne(worldRadius, x, y, value, cashValue, color, size, dropped, cx, cy) {
    const id = nextFoodId = (nextFoodId + 1) >>> 0 || 1;
    let fx, fy;
    if (x !== undefined && y !== undefined) {
      fx = x;
      fy = y;
    } else {
      const angle = Math.random() * Math.PI * 2;
      // sqrt → even spread by area (no center clumping); + ~one view-distance pushes food well out
      // past the border (worldRadius) into the red zone, about as far as a player can typically see.
      const r = Math.sqrt(Math.random()) * (worldRadius + 1600);
      fx = (cx || 0) + Math.cos(angle) * r;
      fy = (cy || 0) + Math.sin(angle) * r;
    }
    const isGolden = cashValue > 0;
    const food = {
      id,
      x: fx,
      y: fy,
      color: isGolden ? '#FFD700' : (color || FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)]),
      // Normal food is small and fairly UNIFORM in slither (solid core ≈ 20% of a spawn
      // snake's width). r = FOOD_RADIUS(3) * size, so 0.5-0.9 → solid radius ~1.5-2.7.
      size: size !== undefined ? size : (isGolden ? 2.2 + Math.random() * 0.6 : 0.5 + Math.random() * 0.4),
      dropped: dropped || false,
      value: value !== undefined ? value : 1,
      cashValue: cashValue || 0,
      isGolden,
    };
    food._i = this._all.length;      // its own slot, so removal is O(1)
    this._all.push(food);
    this.items.set(id, food);
    return food;
  }

  refill(worldRadius, cx, cy) {
    const needed = C.FOOD_SPAWN_COUNT - this.items.size;
    const spawned = [];
    for (let i = 0; i < Math.min(needed, 30); i++) {
      spawned.push(this.spawnOne(worldRadius, undefined, undefined, undefined,
                                 undefined, undefined, undefined, undefined, cx, cy));
    }
    return spawned;
  }

  /* Swap-and-pop: move the last pellet into the hole and shorten the array, so
     removal costs the same whether there are 30 pellets or 3600. Order is not
     meaningful anywhere — every consumer either filters by position or encodes
     the whole set. */
  remove(id) {
    const food = this.items.get(id);
    if (food === undefined) return;
    this.items.delete(id);
    const i = food._i, last = this._all.pop();
    if (last !== food) { last._i = i; this._all[i] = last; }
  }

  serialize() {
    const result = [];
    for (const f of this.items.values()) {
      result.push(f.x, f.y, f.value, f.color, f.id);
    }
    return result;
  }

  /* Returns the live array, NOT a copy. Callers read it and may set fields on
     the pellets themselves (tick clears food.eaten), which is fine. What they
     must not do is push, splice or sort it — this manager owns its contents.
     Every current caller only iterates or filters into a new array. */
  getAll() {
    return this._all;
  }
}

module.exports = FoodManager;
