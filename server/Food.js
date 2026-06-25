const { v4: uuidv4 } = require('uuid');
const C = require('../shared/constants');

const FOOD_COLORS = [
  '#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#ff922b',
  '#cc5de8', '#20c997', '#f06595', '#74c0fc', '#a9e34b',
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
      // sqrt → even spread by area (no center clumping); 1.15x pushes food out past the border
      // (worldRadius) into the red zone, which looks better.
      const r = Math.sqrt(Math.random()) * (worldRadius * 1.15);
      fx = Math.cos(angle) * r;
      fy = Math.sin(angle) * r;
    }
    const isGolden = cashValue > 0;
    const food = {
      id,
      x: fx,
      y: fy,
      color: isGolden ? '#FFD700' : (color || FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)]),
      size: size !== undefined ? size : (isGolden ? 2.2 + Math.random() * 0.6 : 0.6 + Math.random() * 1.0),
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
