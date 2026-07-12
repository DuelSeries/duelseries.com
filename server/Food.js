const { v4: uuidv4 } = require('uuid');
const C = require('../shared/constants');

// Palette read off a slither.io reference frame: saturated primaries PLUS the pale
// lavender/near-white orbs that make up much of slither's field (the last three).
const FOOD_COLORS = [
  '#ff5b5b', '#ff9f3d', '#ffe14d', '#5be35b', '#33dcc0',
  '#6fb6ff', '#b98bff', '#ff74d4', '#cdd8fb', '#e6ecff',
];

class FoodManager {
  constructor() {
    this.items = new Map();
  }

  spawnInitial(worldRadius) {
    for (let i = 0; i < C.FOOD_SPAWN_COUNT; i++) {
      this.spawnOne(worldRadius);
    }
  }

  spawnOne(worldRadius, x, y, value, cashValue, color, size, dropped) {
    const id = uuidv4();
    let fx, fy;
    if (x !== undefined && y !== undefined) {
      fx = x;
      fy = y;
    } else {
      const angle = Math.random() * Math.PI * 2;
      // sqrt → even spread by area (no center clumping); + ~one view-distance pushes food well out
      // past the border (worldRadius) into the red zone, about as far as a player can typically see.
      const r = Math.sqrt(Math.random()) * (worldRadius + 1600);
      fx = Math.cos(angle) * r;
      fy = Math.sin(angle) * r;
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
    this.items.set(id, food);
    return food;
  }

  refill(worldRadius) {
    const needed = C.FOOD_SPAWN_COUNT - this.items.size;
    const spawned = [];
    for (let i = 0; i < Math.min(needed, 30); i++) {
      spawned.push(this.spawnOne(worldRadius));
    }
    return spawned;
  }

  remove(id) {
    this.items.delete(id);
  }

  serialize() {
    const result = [];
    for (const f of this.items.values()) {
      result.push(f.x, f.y, f.value, f.color, f.id);
    }
    return result;
  }

  getAll() {
    return Array.from(this.items.values());
  }
}

module.exports = FoodManager;
