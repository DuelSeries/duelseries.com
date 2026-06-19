'use strict';
const agarLb = require('./agarLeaderboard');
const collusion = require('./CollusionMonitor');
const SpatialGrid = require('./SpatialGrid');

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
const SPEED_BASE     = 1500; // divided by mass^0.4 per cell
const EAT_RATIO      = 1.25;
// Spatial-grid bucket size (world units) for broad-phase food/cell eating. Range queries expand
// it by each cell's radius, so it just needs to be a reasonable bucket vs the world (6k–18k).
const AGAR_GRID      = 300;

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
  get botCount()    { let n = 0; for (const b of this.bots.values()) if (b.alive) n++; return n; }

  start() {
    this._spawnFoods(FOOD_TARGET);
    this._interval = setInterval(() => this._tick(), 1000 / TICK_RATE);
    console.log(`[AgarRoom] ${this.roomName} started`);
  }

  stop() {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  addPlayer(socket, name, color, worth, googleId) {
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
      worth:      worth || 0,
      entryFee:   worth || 0,
      googleId:   googleId || null,
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
    const p = this.players.get(socketId);
    agarLb.record(p.googleId || p.name, p.name, p.score);
    const name = p.name;
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

  respawnPlayer(socketId, entryWorth) {
    const p = this.players.get(socketId);
    if (!p) return;
    const ws = this.worldSize;
    const x = ws * 0.15 + Math.random() * ws * 0.7;
    const y = ws * 0.15 + Math.random() * ws * 0.7;
    p.cells = [this._makeCell(0, x, y, 20, 0, 0)];
    p.nextCellId = 1;
    p.mouseX = x; p.mouseY = y;
    p.alive = true; p.score = 0; p.worth = entryWorth || 0;
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

  addPaidBot(worthCad) {
    const bot = this.addBot();
    bot.worth    = worthCad;
    bot.entryFee = worthCad;
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
    // Broadcast at ~30Hz (every other 60Hz sim tick) — the client interpolates, so the skipped
    // frames are invisible and bandwidth halves.
    this._bcTick = (this._bcTick || 0) + 1;
    if (this._bcTick % 2 === 0) this._broadcast();
  }

  _updatePlayer(p, dt) {
    for (const cell of p.cells) {
      // Each cell's speed based on its own mass — smaller split cells move faster
      const speed = SPEED_BASE / Math.pow(cell.mass, 0.4);

      cell.vx *= Math.pow(0.15, dt);
      cell.vy *= Math.pow(0.15, dt);

      const dx   = p.mouseX - cell.x;
      const dy   = p.mouseY - cell.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const r    = Math.sqrt(cell.mass) * 10;

      const slowZone  = r * 0.5;
      const speedMult = Math.min(1, dist / slowZone);
      const nx = dx / dist, ny = dy / dist;
      cell.x += (nx * speed * speedMult + cell.vx) * dt;
      cell.y += (ny * speed * speedMult + cell.vy) * dt;

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
    // Broad-phase: bucket food into a spatial grid once per tick (food barely moves), so each
    // cell only tests the food within its own radius instead of all ~3000 foods. Same result.
    const grid = this._foodGrid || (this._foodGrid = new SpatialGrid(AGAR_GRID));
    grid.clear();
    for (const food of this.foods.values()) grid.insert(food.x, food.y, food);

    for (const p of [...this.players.values(), ...this.bots.values()]) {
      if (!p.alive) continue;
      for (const cell of p.cells) {
        const r = Math.sqrt(cell.mass) * 10;
        grid.forEachInRange(cell.x, cell.y, r, (food) => {
          if (food._eaten) return false;
          const rMin = r - food.r * 0.4;
          const dx = cell.x - food.x, dy = cell.y - food.y;
          if (dx * dx + dy * dy < rMin * rMin) {
            cell.mass += FOOD_MASS;
            food._eaten = true;
            this.foods.delete(food.id);
            this._removedFoods.push(food.id);
          }
          return false;
        });
      }
    }
  }

  _checkPlayerEating() {
    const entities = [...this.players.values(), ...this.bots.values()];
    // Broad-phase: bucket every live cell (tagged with its owner) into a grid, so each eater
    // cell only tests the cells within its own radius instead of every other entity's cells.
    // The eat condition, worth transfer, and death handling below are unchanged from the old
    // all-pairs scan; _consumed guards a cell from being eaten twice in one tick.
    const grid = this._cellGrid || (this._cellGrid = new SpatialGrid(AGAR_GRID));
    grid.clear();
    for (const ent of entities) {
      if (!ent.alive) continue;
      for (const c of ent.cells) { c._owner = ent; c._consumed = false; grid.insert(c.x, c.y, c); }
    }

    for (const eater of entities) {
      if (!eater.alive) continue;
      for (const ec of eater.cells) {
        const er = Math.sqrt(ec.mass) * 10;
        grid.forEachInRange(ec.x, ec.y, er, (tc) => {
          const target = tc._owner;
          if (tc._consumed || target === eater || !target.alive) return false;
          if (ec.mass < tc.mass * EAT_RATIO) return false;
          const tr = Math.sqrt(tc.mass) * 10;
          const dx = ec.x - tc.x, dy = ec.y - tc.y;
          if (dx * dx + dy * dy >= (er - tr * 0.4) ** 2) return false;

          ec.mass += tc.mass;
          // Transfer this cell's proportional share of worth to the eater
          if (target.worth > 0 && target.cells.length > 0) {
            const share = target.worth / target.cells.length;
            eater.worth = (eater.worth || 0) + share;
            target.worth -= share;
            // Value moved from the eaten account to the eater — feed the collusion monitor.
            if (target.googleId && eater.googleId) collusion.record(target.googleId, eater.googleId, share, { lobbyType: this.roomName });
          }
          tc._consumed = true;
          const idx = target.cells.indexOf(tc);
          if (idx !== -1) target.cells.splice(idx, 1);
          if (target.cells.length === 0) {
            target.worth = 0; // sanity reset
            if (target.isBot) {
              target.alive = false;
              this._updateWorldSize();
            } else {
              agarLb.record(target.googleId || target.name, target.name, target.score);
              target.alive = false;
              const sock = this.io.sockets.sockets.get(target.id);
              if (sock) sock.emit('cell:died', { killedBy: eater.name, score: target.score });
            }
          }
          return false;
        });
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
      const food = { id, x, y, color: FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)], r: 10 + Math.floor(Math.random() * 6) };
      this.foods.set(id, food);
      this._addedFoods.push(food);
    }
  }

  _broadcast() {
    // Flush food deltas regardless of who's listening (they're global + small per tick).
    const removedFoods = this._removedFoods, addedFoods = this._addedFoods;
    this._removedFoods = [];
    this._addedFoods   = [];

    const roomSet = this.io.sockets.adapter.rooms.get(this.roomName);
    if (!roomSet || roomSet.size === 0) return;

    // Serialize every entity ONCE, with a bounding circle over its cells (incl. their radii) for
    // a cheap "is it in this view?" test.
    const all = [], bounds = [];
    for (const p of [...this.players.values(), ...this.bots.values()]) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of p.cells) {
        const r = Math.sqrt(c.mass) * 10;
        if (c.x - r < minX) minX = c.x - r;
        if (c.x + r > maxX) maxX = c.x + r;
        if (c.y - r < minY) minY = c.y - r;
        if (c.y + r > maxY) maxY = c.y + r;
      }
      if (minX === Infinity) { minX = maxX = minY = maxY = 0; }
      all.push({ id: p.id, name: p.name, color: p.color, alive: p.alive, score: p.score, worth: p.worth || 0,
                 cells: p.cells.map(c => ({ x: c.x, y: c.y, mass: c.mass })) });
      bounds.push({ cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, br: Math.hypot(maxX - minX, maxY - minY) / 2 });
    }

    // ── Interest-group AOI broadcast ──────────────────────────────────────────
    // Bucket each live player into a coarse world cell and send ONE culled payload per occupied
    // cell via a Socket.IO room — encodes scale with occupied cells, not players². The client
    // time-evicts anyone it stops hearing about, so players that leave its view disappear.
    // VOLATILE so a client that can't keep up drops frames instead of backing up its buffer.
    const CELL = 1500, DEFAULT_VIEW = 1200, MARGIN = 200;
    const cells = new Map();
    const fullSends = [];

    for (const sid of roomSet) {
      const sock = this.io.sockets.sockets.get(sid);
      if (!sock) continue;
      const me = this.players.get(sid);
      if (!me || !me.alive || !me.cells.length) {
        if (sock._agarCellRoom) { sock.leave(sock._agarCellRoom); sock._agarCellRoom = null; }
        fullSends.push(sock);
        continue;
      }
      let sx = 0, sy = 0;
      for (const c of me.cells) { sx += c.x; sy += c.y; }
      sx /= me.cells.length; sy /= me.cells.length;
      const ci = Math.floor(sx / CELL), cj = Math.floor(sy / CELL);
      const key = ci + ',' + cj;
      const roomName = 'aoi_' + this.roomName + '_' + key;
      if (sock._agarCellRoom !== roomName) {
        if (sock._agarCellRoom) sock.leave(sock._agarCellRoom);
        sock.join(roomName);
        sock._agarCellRoom = roomName;
      }
      let cell = cells.get(key);
      if (!cell) { cell = { ci, cj, roomName, maxV: 0 }; cells.set(key, cell); }
      const v = sock._agarViewR || DEFAULT_VIEW;
      if (v > cell.maxV) cell.maxV = v;
    }

    // One culled payload per occupied cell, padded by the widest view among its players.
    for (const cell of cells.values()) {
      const pad = cell.maxV + MARGIN;
      const cx = cell.ci * CELL + CELL / 2, cy = cell.cj * CELL + CELL / 2;
      const halfW = CELL / 2 + pad, halfH = CELL / 2 + pad;
      const players = [];
      for (let i = 0; i < all.length; i++) {
        const b = bounds[i];
        if (Math.abs(b.cx - cx) <= halfW + b.br && Math.abs(b.cy - cy) <= halfH + b.br) players.push(all[i]);
      }
      this.io.to(cell.roomName).volatile.emit('cell:state', { players, removedFoods, addedFoods });
    }

    // Dead / spectator sockets get the full set (rare and transient).
    for (const sock of fullSends) {
      sock.volatile.emit('cell:state', { players: all, removedFoods, addedFoods });
    }
  }

  _serializePlayers() {
    const arr = [];
    for (const p of [...this.players.values(), ...this.bots.values()]) {
      arr.push({
        id: p.id, name: p.name, color: p.color, alive: p.alive, score: p.score, worth: p.worth || 0,
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
