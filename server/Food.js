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
  spawnInitial(worldRadius, cx, cy, margin) {
    const m = (margin === undefined) ? C.FOOD_SPAWN_MARGIN : margin;
    const n = this.targetFor(worldRadius + m);
    for (let i = 0; i < n; i++) {
      this.spawnOne(worldRadius, undefined, undefined, undefined, undefined,
                    undefined, undefined, undefined, cx, cy, m);
    }
  }

  spawnOne(worldRadius, x, y, value, cashValue, color, size, dropped, cx, cy, margin) {
    const id = nextFoodId = (nextFoodId + 1) >>> 0 || 1;
    let fx, fy;
    if (x !== undefined && y !== undefined) {
      fx = x;
      fy = y;
    } else {
      const angle = Math.random() * Math.PI * 2;
      // sqrt → even spread by area (no center clumping); the margin pushes food out
      // past the border into the red zone, about as far as a player can typically see.
      // A battle royale passes 0: outside its circle is instant death, so food there
      // is bait nobody can take.
      const m = (margin === undefined) ? C.FOOD_SPAWN_MARGIN : margin;
      const r = Math.sqrt(Math.random()) * (worldRadius + m);
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

  /* How many pellets belong in a disc of this radius.

     DENSITY ALL THE WAY UP, with no headcount cap on top. The cap used to be
     FOOD_SPAWN_COUNT, and it meant the arena got thinner the bigger it grew:
     the world expands with the crowd up to MAX_WORLD_RADIUS, and past about
     2000 the count pinned at 3,600 while the area kept going. A full-size arena
     ran at less than a quarter of the density a quiet one did — so the busier
     the room, the less food each part of it held. Exactly backwards.

     Now the same patch of ground holds the same amount of food whatever size
     the world is. The cost of that is bounded and measured: the world itself is
     capped at MAX_WORLD_RADIUS, which puts the ceiling near 16,000 pellets, and
     what a PLAYER receives does not change at all — they are sent the food in
     their own view, and constant density means that is a constant amount.
     Measured at 100 bots on a full-size world, one viewer:

       food    | tick    | KB/s per player
        3,200  | 1.15ms  | 405
       15,000  | 2.24ms  | 435

     The wire is flat, as it must be; the tick pays a little more for holding
     more of the world in memory, after the per-cell food cull was moved onto a
     grid. FOOD_SPAWN_COUNT survives as what the density is CALIBRATED from —
     see FOOD_DENSITY — not as a ceiling.

     ABSOLUTE_MAX is a seatbelt, not a policy: if the world ever grew without
     bound this would too, and a runaway here is a runaway on the wire. */
  targetFor(spawnRadius) {
    const want = Math.round(C.FOOD_DENSITY * Math.PI * spawnRadius * spawnRadius);
    return Math.min(C.FOOD_ABSOLUTE_MAX, want);
  }

  /* Keep the PLAYABLE area stocked, and reclaim what has been left outside it.

     The old version counted every pellet in the room and topped up to a fixed
     3600. That is correct only while the arena never moves. In a battle royale
     the circle shrinks and travels, and the pellets it leaves behind are still
     in the Map — so the count said "full" while the part of the world anyone
     could reach was empty. Measured: zero food inside the zone from ~165s on,
     with 3711 pellets in the room.

     Two changes. The census counts only what is inside the disc, so stranded
     food cannot mask a shortage. And a slice of the array is swept each tick
     for pellets the arena has abandoned, which frees both the headroom and the
     wire budget they were holding.

     `margin` is how far past the border food may sit — a view distance in an
     ordinary room, zero in a battle royale where outside the circle is death. */
  refill(worldRadius, cx, cy, opts) {
    const margin = (opts && opts.margin !== undefined) ? opts.margin : C.FOOD_SPAWN_MARGIN;
    const R  = Math.max(1, worldRadius + margin);
    const R2 = R * R;
    const ox = cx || 0, oy = cy || 0;

    /* THE SWEEP, amortised. Walking 3600 pellets every tick to find strays is
       216k distance checks a second for a job whose answer changes slowly, and
       this codebase has already paid once for a per-tick cost that looked free
       in isolation. A thirtieth of the array per tick covers everything twice a
       second and costs ~120 checks.

       Strays are removed rather than moved, because a pellet that teleports is
       a pellet that vanishes from under a snake already turning toward it. The
       refill below puts fresh ones inside the disc in the same tick. */
    const all = this._all;
    const n = all.length;
    if (n) {
      const slice = Math.max(1, Math.ceil(n / 30));
      let i = (this._sweep || 0) % n;
      /* A pellet is only reclaimed once it is well outside — 1.25x the disc —
         so food skimming the border is not churned every time the wall breathes. */
      const cull2 = (R * 1.25) * (R * 1.25);
      for (let k = 0; k < slice; k++) {
        const f = all[i];
        if (f === undefined) break;
        const dx = f.x - ox, dy = f.y - oy;
        /* NEVER SWEEP FOOD THAT IS WORTH ANYTHING.

           Dropped food is somebody's death or boost and is the reward for a
           kill; culling it would delete a payoff a player just earned. Cash
           food is stronger than that — `GameRoom` does `snake.worth +=
           food.cashValue`, so a pellet with cashValue on it IS real money, and
           deleting one destroys funds.

           The test is `cashValue`, the field the money actually rides on,
           rather than the derived `isGolden` flag. Today `isGolden` is exactly
           `cashValue > 0`, so the two agree; keying on the money itself means
           they cannot silently stop agreeing later. */
        const worthless = !f.dropped && !(f.cashValue > 0) && !f.isGolden;
        if (worthless && dx * dx + dy * dy > cull2) {
          this.remove(f.id);
          if (i >= this._all.length) break;   // swap-and-pop moved the tail in
          continue;                           // re-test whatever landed in this slot
        }
        i++; if (i >= this._all.length) i = 0;
      }
      this._sweep = i;
    }

    /* The census: only pellets inside the disc count toward the target. */
    let inPlay = 0;
    for (let i = 0; i < all.length; i++) {
      const dx = all[i].x - ox, dy = all[i].y - oy;
      if (dx * dx + dy * dy <= R2) inPlay++;
    }

    const target = this.targetFor(R);
    const needed = target - inPlay;

    /* HOW FAST IT REFILLS, AND WHY IT IS COUNTED IN TICKS.

       This was a flat thirty per call, and per CALL is the first problem: an
       empty room deliberately ticks at a tenth of the rate to save CPU, so the
       same code filled ten times slower in exactly the room nobody was watching
       yet. The second is that thirty was chosen when an arena held 3,600
       pellets. Food is a density now, so a full-size battle royale holds about
       16,000 - and a battle royale ENDS with its arena almost bare, because the
       circle shrank to a couple of hundred units and the sweep quite correctly
       reclaimed everything outside it. Refilling that at thirty a tick took
       nine seconds at full rate and a minute and a half idle, which is why the
       arena looked empty until a match started.

       So: a share of the TARGET per second. A big arena refills proportionally
       faster than a small one.

       Counted in TICKS, not off the wall clock. The first version read
       Date.now() and refilled nothing at all under test, because a harness
       steps thousands of ticks inside a single millisecond, and a sim that
       stops working when it is not run in real time is a sim that cannot be
       measured. `ticks` is how many sim ticks this call stands for: one
       normally, ten from an idle room, which is what puts the idle case back on
       the same footing without the food manager needing to know what idle means.

       Still rate-limited, deliberately. Dumping sixteen thousand pellets into
       one snapshot is its own spike, and food arriving over a couple of seconds
       reads as the arena coming back rather than as a switch being flipped. */
    const ticks = (opts && opts.ticks) || 1;
    const perTick = target / (C.FOOD_REFILL_SECONDS * C.TICK_RATE);
    /* Carried between calls, because a few thousand a second is a fraction of a
       pellet per tick — truncating that to zero every time refills nothing. */
    this._refillOwed = (this._refillOwed || 0) + perTick * ticks;
    const budget = Math.floor(this._refillOwed);
    this._refillOwed -= budget;

    const spawned = [];
    for (let i = 0; i < Math.min(needed, budget); i++) {
      spawned.push(this.spawnOne(worldRadius, undefined, undefined, undefined,
                                 undefined, undefined, undefined, undefined,
                                 ox, oy, margin));
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
