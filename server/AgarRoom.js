'use strict';

const TICK_RATE      = 60;
const WORLD_BASE     = 6000;
const WORLD_PER_PLAYER = 200;
const WORLD_MAX      = 18000;
const FOOD_TARGET    = 3000;
const FOOD_RADIUS    = 8;
const FOOD_MASS      = 1;
const MIN_SPLIT_MASS = 36;
const MAX_CELLS      = 16;
const SPLIT_SPEED    = 650;
const MERGE_DELAY    = 12000;
const SPEED_BASE     = 1000; // divided by sqrt(maxCellMass)
const EAT_RATIO      = 1.25;

const FOOD_COLORS = [
  '#f87171','#fb923c','#fbbf24','#4ade80',
  '#34d399','#60a5fa','#a78bfa','#f472b6',
  '#2dd4bf','#e879f9','#f97316','#84cc16',
];

const BOT_NAMES  = ['Alpha','Beta','Gamma','Delta','Sigma','Omega','Nova','Apex','Blaze','Echo'];
const BOT_COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#8b5cf6','#ec4899','#14b8a6','#f43f5e','#a3e635'];

let _foodIdSeq = 1;
let _botIdSeq  = 1;

class AgarRoom {
  constructor(io, roomName) {
    this.io        = io;
    this.roomName  = roomName;
    this.players   = new Map(); // socketId → player
    this.bots      = new Map(); // botId → bot
    this.foods     = new Map(); // foodId → food
    this.worldSize = WORLD_BASE;
    this._addedFoods   = [];
    this._removedFoods = [];
    this._interval     = null;
    this._lastTick     = Date.now();
  }

  get playerCount() { return this.players.size; }

  start() {
    this._spawnFoods(FOOD_TARGET);
    this._interval = setInterval(() => this._tick(), 1000 / TICK_RATE);
    console.log(`[AgarRoom] ${this.roomName} started`);
  }

  stop() {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  addPlayer(socket, name, color) {
    const ws = this.worldSize;
    const x  = ws * 0.15 + Math.random() * ws * 0.7;
    const y  = ws * 0.15 + Math.random() * ws * 0.7;
    const player = {
      id:         socket.id,
      name:       (name || 'Player').slice(0, 20),
      color:      color || '#6366f1',
      cells:      [this._makeCell(0, x, y, 20, 0, 0)],
      nextCellId: 1,
      mouseX:     x,
      mouseY:     y,
      alive:      true,
      score:      0,
      locked:     false,
    };
    this.players.set(socket.id, player);
    socket.join(this.roomName);
    this._updateWorldSize();

    socket.emit('cell:joined', {
      playerId:  socket.id,
      worldSize: this.worldSize,
      foods:     [...this.foods.values()],
      players:   this._serializePlayers(),
    });
    socket.to(this.roomName).emit('cell:playerJoined', {
      id: socket.id, name: player.name, color: player.color, cells: player.cells,
    });
    console.log(`[AgarRoom] ${player.name} joined (${this.players.size} players)`);
  }

  removePlayer(socketId) {
    if (!this.players.has(socketId)) return;
    const name = this.players.get(socketId).name;
    this.players.delete(socketId);
    this.io.to(this.roomName).emit('cell:playerLeft', { id: socketId });
    this._updateWorldSize();
    console.log(`[AgarRoom] ${name} left (${this.players.size} players)`);
  }

  handleInput(socketId, mouseX, mouseY) {
    const p = this.players.get(socketId);
    if (p && p.alive) { p.mouseX = mouseX; p.mouseY = mouseY; }
  }

  handleSplit(socketId) {
    const p = this.players.get(socketId);
    if (!p || !p.alive) return;
    const toAdd = [];
    for (const cell of p.cells) {
      if (p.cells.length + toAdd.length >= MAX_CELLS) break;
      if (cell.mass < MIN_SPLIT_MASS) continue;
      const dx  = p.mouseX - cell.x, dy = p.mouseY - cell.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx  = dx / len, ny = dy / len;
      const half = cell.mass / 2;
      cell.mass = half;
      cell.mergeTimer = MERGE_DELAY;
      const r = Math.sqrt(half) * 10;
      toAdd.push(this._makeCell(p.nextCellId++,
        cell.x + nx * r * 1.1,
        cell.y + ny * r * 1.1,
        half, nx * SPLIT_SPEED, ny * SPLIT_SPEED
      ));
      toAdd[toAdd.length - 1].mergeTimer = MERGE_DELAY;
    }
    p.cells.push(...toAdd);
  }

  lockPlayer(socketId) {
    const p = this.players.get(socketId);
    if (!p || !p.alive) return;
    p.locked = true;
    for (const c of p.cells) { c.vx = 0; c.vy = 0; }
  }

  unlockPlayer(socketId) {
    const p = this.players.get(socketId);
    if (p) p.locked = false;
  }

  cashoutPlayer(socketId) {
    const p = this.players.get(socketId);
    if (!p) return;
    p.alive  = false;
    p.locked = false;
    p.cells  = [];
  }

  respawnBot(botId) {
    const b = this.bots.get(botId);
    if (!b) return;
    const ws = this.worldSize;
    b.cells = [this._makeCell(0, ws * 0.1 + Math.random() * ws * 0.8, ws * 0.1 + Math.random() * ws * 0.8, 20, 0, 0)];
    b.nextCellId = 1; b.alive = true; b.score = 0;
    b.wanderTimer = 0; b.wanderTarget = null;
  }

  respawnPlayer(socketId) {
    const p = this.players.get(socketId);
    if (!p) return;
    const ws = this.worldSize;
    const x = ws * 0.15 + Math.random() * ws * 0.7;
    const y = ws * 0.15 + Math.random() * ws * 0.7;
    p.cells = [this._makeCell(0, x, y, 20, 0, 0)];
    p.nextCellId = 1;
    p.mouseX = x; p.mouseY = y;
    p.alive = true; p.score = 0;
  }

  // ── Bot spawning ──────────────────────────────────────────────────────────

  addBot() {
    const ws  = this.worldSize;
    const x   = ws * 0.1 + Math.random() * ws * 0.8;
    const y   = ws * 0.1 + Math.random() * ws * 0.8;
    const id  = 'bot_' + (_botIdSeq++);
    const bot = {
      id,
      name:          BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
      color:         BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)],
      cells:         [this._makeCell(0, x, y, 20, 0, 0)],
      nextCellId:    1,
      mouseX:        x, mouseY: y,
      alive:         true,
      score:         0,
      isBot:         true,
      wanderTarget:  null,
      wanderTimer:   0,
    };
    this.bots.set(id, bot);
    this._updateWorldSize();
    this.io.to(this.roomName).emit('cell:playerJoined', {
      id, name: bot.name, color: bot.color, cells: bot.cells,
    });
    console.log(`[AgarRoom] Bot "${bot.name}" spawned`);
    return bot;
  }

  // ── Tick ──────────────────────────────────────────────────────────────────

  _tick() {
    const now = Date.now();
    const dt  = Math.min((now - this._lastTick) / 1000, 0.05);
    this._lastTick = now;

    for (const p of this.players.values()) {
      if (p.alive && !p.locked) this._updatePlayer(p, dt);
    }
    for (const b of this.bots.values()) {
      if (b.alive) this._tickBot(b, dt);
    }
    this._checkFoodEating();
    this._checkPlayerEating();
    this._refillFood();
    this._broadcast();
  }

  _updatePlayer(p, dt) {
    const maxMass = p.cells.reduce((m, c) => Math.max(m, c.mass), 0);
    const speed   = SPEED_BASE / Math.sqrt(maxMass);

    for (const cell of p.cells) {
      cell.vx *= Math.pow(0.15, dt);
      cell.vy *= Math.pow(0.15, dt);

      const dx   = p.mouseX - cell.x;
      const dy   = p.mouseY - cell.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const r    = Math.sqrt(cell.mass) * 10;

      // Always move toward mouse; scale speed down as mouse nears cell center
      const slowZone = r * 0.5;
      const speedMult = Math.min(1, dist / slowZone);
      const nx = dx / dist, ny = dy / dist;
      {
        cell.x += (nx * speed * speedMult + cell.vx) * dt;
        cell.y += (ny * speed * speedMult + cell.vy) * dt;
      }

      const ws = this.worldSize;
      cell.x = Math.max(r, Math.min(ws - r, cell.x));
      cell.y = Math.max(r, Math.min(ws - r, cell.y));
      if (cell.mergeTimer > 0) cell.mergeTimer -= dt * 1000;
    }

    this._attractMergeCells(p.cells, dt);
    this._separateCells(p.cells);
    this._mergeCells(p.cells);
    p.score = Math.floor(p.cells.reduce((s, c) => s + c.mass, 0));
  }

  _tickBot(bot, dt) {
    bot.wanderTimer -= dt;
    const ws      = this.worldSize;
    const anchor  = bot.cells[0]; // use first cell as reference
    const maxMass = bot.cells.reduce((m, c) => Math.max(m, c.mass), 0);

    let tx = bot.mouseX, ty = bot.mouseY;
    let foundTarget = false;

    // Flee from any larger entity cell nearby
    for (const entity of [...this.players.values(), ...this.bots.values()]) {
      if (entity === bot || !entity.alive) continue;
      for (const ec of entity.cells) {
        if (ec.mass <= maxMass * 1.1) continue;
        const dx = ec.x - anchor.x, dy = ec.y - anchor.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 350) {
          // Run away
          tx = anchor.x - dx; ty = anchor.y - dy;
          foundTarget = true; break;
        }
      }
      if (foundTarget) break;
    }

    if (!foundTarget) {
      // Chase nearest food within radius
      let best = 600, foodTarget = null;
      for (const food of this.foods.values()) {
        const dx = food.x - anchor.x, dy = food.y - anchor.y;
        const d  = Math.sqrt(dx * dx + dy * dy);
        if (d < best) { best = d; foodTarget = food; }
      }
      if (foodTarget) {
        tx = foodTarget.x; ty = foodTarget.y;
        foundTarget = true;
      }
    }

    if (!foundTarget || bot.wanderTimer <= 0) {
      // Pick a new wander target
      if (!bot.wanderTarget || bot.wanderTimer <= 0) {
        bot.wanderTarget = {
          x: ws * 0.1 + Math.random() * ws * 0.8,
          y: ws * 0.1 + Math.random() * ws * 0.8,
        };
        bot.wanderTimer = 3 + Math.random() * 4;
      }
      tx = bot.wanderTarget.x; ty = bot.wanderTarget.y;
      // Reset when close enough
      const dx = tx - anchor.x, dy = ty - anchor.y;
      if (Math.sqrt(dx * dx + dy * dy) < 120) bot.wanderTimer = 0;
    }

    bot.mouseX = tx; bot.mouseY = ty;
    this._updatePlayer(bot, dt);
  }

  _separateCells(cells) {
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i], b = cells[j];
        // Don't push apart cells that are ready to merge — let them overlap
        if (a.mergeTimer <= 0 && b.mergeTimer <= 0) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d  = Math.sqrt(dx * dx + dy * dy) || 0.001;
        const minD = Math.sqrt(a.mass) * 10 + Math.sqrt(b.mass) * 10;
        if (d < minD) {
          const push = (minD - d) / 2 * 0.3;
          const nx = dx / d, ny = dy / d;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
        }
      }
    }
  }

  _attractMergeCells(cells, dt) {
    if (cells.length < 2) return;
    const ready = cells.filter(c => c.mergeTimer <= 0);
    if (ready.length < 2) return;
    let cx = 0, cy = 0, tm = 0;
    for (const c of ready) { cx += c.x * c.mass; cy += c.y * c.mass; tm += c.mass; }
    cx /= tm; cy /= tm;
    for (const c of ready) {
      const dx = cx - c.x, dy = cy - c.y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const force = Math.min(d * 0.12, 80);
      c.x += (dx / d) * force * dt;
      c.y += (dy / d) * force * dt;
    }
  }

  _mergeCells(cells) {
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i], b = cells[j];
        if (a.mergeTimer > 0 || b.mergeTimer > 0) continue;
        const dx = a.x - b.x, dy = a.y - b.y;
        if (Math.sqrt(dx * dx + dy * dy) < Math.sqrt(a.mass) * 10 * 0.6) {
          const tm = a.mass + b.mass;
          a.x  = (a.x * a.mass + b.x * b.mass) / tm;
          a.y  = (a.y * a.mass + b.y * b.mass) / tm;
          a.vx = (a.vx * a.mass + b.vx * b.mass) / tm;
          a.vy = (a.vy * a.mass + b.vy * b.mass) / tm;
          a.mass = tm;
          cells.splice(j, 1);
          j--;
        }
      }
    }
  }

  _checkFoodEating() {
    for (const p of [...this.players.values(), ...this.bots.values()]) {
      if (!p.alive) continue;
      for (const cell of p.cells) {
        const r = Math.sqrt(cell.mass) * 10;
        const rMin = r - FOOD_RADIUS * 0.4;
        const rMin2 = rMin * rMin;
        for (const [fid, food] of this.foods) {
          const dx = cell.x - food.x, dy = cell.y - food.y;
          if (dx * dx + dy * dy < rMin2) {
            cell.mass += FOOD_MASS;
            this.foods.delete(fid);
            this._removedFoods.push(fid);
          }
        }
      }
    }
  }

  _checkPlayerEating() {
    const list = [...this.players.values(), ...this.bots.values()];
    for (const eater of list) {
      if (!eater.alive) continue;
      for (const target of list) {
        if (eater === target || !target.alive) continue;
        for (const ec of eater.cells) {
          const er = Math.sqrt(ec.mass) * 10;
          for (let k = target.cells.length - 1; k >= 0; k--) {
            const tc = target.cells[k];
            if (ec.mass < tc.mass * EAT_RATIO) continue;
            const dx = ec.x - tc.x, dy = ec.y - tc.y;
            const tr = Math.sqrt(tc.mass) * 10;
            if (dx * dx + dy * dy < (er - tr * 0.4) ** 2) {
              ec.mass += tc.mass;
              target.cells.splice(k, 1);
              if (target.cells.length === 0) {
                if (target.isBot) {
                  target.alive = false;
                  this._updateWorldSize();
                } else {
                  target.alive = false;
                  const sock = this.io.sockets.sockets.get(target.id);
                  if (sock) sock.emit('cell:died', { killedBy: eater.name, score: target.score });
                }
              }
            }
          }
        }
      }
    }
  }

  _refillFood() {
    const need = FOOD_TARGET - this.foods.size;
    if (need > 0) this._spawnFoods(Math.min(need, 20));
  }

  _spawnFoods(count) {
    const ws  = this.worldSize;
    const rim = 2000; // how far outside the border food can spawn
    for (let i = 0; i < count; i++) {
      const id = _foodIdSeq++;
      let x, y;
      if (Math.random() < 0.25) {
        // Place in the rim zone just outside the border (min 50 units past border)
        const edge = Math.floor(Math.random() * 4);
        if (edge === 0) { x = -(50 + rim * Math.random());         y = -rim + Math.random() * (ws + rim * 2); }
        else if (edge === 1) { x = ws + 50 + rim * Math.random(); y = -rim + Math.random() * (ws + rim * 2); }
        else if (edge === 2) { x = -rim + Math.random() * (ws + rim * 2); y = -(50 + rim * Math.random()); }
        else                 { x = -rim + Math.random() * (ws + rim * 2); y = ws + 50 + rim * Math.random(); }
      } else {
        x = Math.random() * ws;
        y = Math.random() * ws;
      }
      const food = { id, x, y, color: FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)] };
      this.foods.set(id, food);
      this._addedFoods.push(food);
    }
  }

  _broadcast() {
    this.io.to(this.roomName).emit('cell:state', {
      players:      this._serializePlayers(),
      removedFoods: this._removedFoods,
      addedFoods:   this._addedFoods,
    });
    this._removedFoods = [];
    this._addedFoods   = [];
  }

  _serializePlayers() {
    const arr = [];
    for (const p of [...this.players.values(), ...this.bots.values()]) {
      arr.push({
        id: p.id, name: p.name, color: p.color, alive: p.alive, score: p.score,
        cells: p.cells.map(c => ({ x: c.x, y: c.y, mass: c.mass })),
      });
    }
    return arr;
  }

  _updateWorldSize() {
    const n       = this.players.size + this.bots.size;
    const newSize = Math.min(WORLD_MAX, Math.max(WORLD_BASE, WORLD_BASE + n * WORLD_PER_PLAYER));
    if (newSize !== this.worldSize) {
      this.worldSize = newSize;
      this.io.to(this.roomName).emit('cell:worldSize', { size: this.worldSize });
    }
  }

  _makeCell(id, x, y, mass, vx, vy) {
    return { id, x, y, mass, vx, vy, mergeTimer: 0 };
  }
}

module.exports = AgarRoom;
