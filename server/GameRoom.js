const C = require('../shared/constants');
const Snake = require('./Snake');
const Bot   = require('./Bot');
const FoodManager = require('./Food');
const collusion = require('./CollusionMonitor');
const { v4: uuidv4 } = require('uuid');
const allTimeLb = require('./leaderboard');
const SpatialGrid = require('./SpatialGrid');
const { encodeSnapshot } = require('../shared/snapshotCodec');

// Spatial-grid cell size (world units). Must be >= the largest interaction radius
// (food pull = 35, body hit up to ~46 for a max-scale snake) so a hit always lands
// within the 3×3 query block.
const GRID_CELL = 80;

class GameRoom {
  constructor(io, lobbyType) {
    this.io = io;
    this.lobbyType = lobbyType || 'free';
    this.roomId = uuidv4();
    this.socketRoomName = 'game_' + this.roomId;
    this.snakes = new Map();      // socketId -> Snake
    this.players = new Map();     // socketId -> { socket, name, walletAddress }
    this.orphans = new Map();     // reconnectKey -> { socketId, timer } — snakes kept alive across a brief drop
    this.foodManager = new FoodManager();
    this.worldRadius = C.BASE_WORLD_RADIUS;
    this.borderDrift = 0;  // positive = expanded, negative = contracted
    this.tickInterval = null;
    this.leaderboard = [];
  }

  get playerCount() { return this.players.size; }
  get botCount() {
    let n = 0;
    for (const s of this.snakes.values()) if (s.isBot && s.alive) n++;
    return n;
  }

  start() {
    this.foodManager.spawnInitial(this.worldRadius);
    this.tickInterval = setInterval(() => this.tick(), 1000 / C.TICK_RATE);
  }

  stop() {
    if (this.tickInterval) clearInterval(this.tickInterval);
  }

  addPlayer(socket, name, walletAddress, color, entrySol, hatId, boostId) {
    socket.join(this.socketRoomName);
    this.players.set(socket.id, { socket, name, walletAddress, color, hatId, boostId });

    const { x, y } = this.safeSpawnPoint();
    const snake = new Snake(socket.id, name, x, y, color, hatId, boostId);
    snake.worth = entrySol || 0;
    this.snakes.set(socket.id, snake);

    socket.emit(C.EVENTS.GAME_JOINED, {
      playerId: socket.id,
      worldRadius: this.worldRadius,
      snakeColor: snake.color,
      food: this.foodManager.getAll(),
      snake: snake.serialize(),
    });

    // Each player joining expands the border
    this.borderDrift = Math.min(this.borderDrift + 200, 1200);

    return snake;
  }

  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (player) player.socket.leave(this.socketRoomName);
    const snake = this.snakes.get(socketId);
    if (snake && snake.alive) {
      const gid = player?.socket?._googleId;
      allTimeLb.record(gid || snake.name, snake.name, snake.score);
      // Player leaving counts as a death — shrink the border
      this.borderDrift = Math.max(this.borderDrift - 120, -1000);
      const drops = snake.die();
      const safeR = this.worldRadius * 0.95;
      const cashPerDrop = drops.length > 0 && snake.worth > 0 ? snake.worth / drops.length : 0;
      drops.forEach(d => {
        const dist = Math.hypot(d.x, d.y);
        if (dist > safeR) { const sc = safeR / dist; d.x *= sc; d.y *= sc; }
        const f = this.foodManager.spawnOne(this.worldRadius, d.x, d.y, d.value, cashPerDrop, d.color, d.size, d.dropped);
        if (f && gid) f._srcGid = gid; // tag dropped cash with its source account (collusion tracking)
      });
    }
    this.snakes.delete(socketId);
    this.players.delete(socketId);
  }

  // A player's socket dropped but they may just be reconnecting (common on mobile).
  // Keep their snake in the world, gliding straight, for a grace period instead of
  // killing it. If they don't return in time, onExpire() is invoked so the caller
  // can record the result and remove the player normally.
  markOrphan(socketId, key, graceMs, onExpire) {
    const snake = this.snakes.get(socketId);
    if (!snake || !snake.alive || !key) { onExpire(); return; }
    snake._orphan = true;
    snake.setInput(snake.angle, false, 1);  // stop turning/boosting — glide straight
    const prev = this.orphans.get(key);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => { this.orphans.delete(key); onExpire(); }, graceMs);
    this.orphans.set(key, { socketId, timer });
  }

  // A player reconnected: if we're still holding their snake, move it onto the new
  // socket (re-key the maps, the snake's id, and rejoin the room) and re-send the
  // join payload so they snap back onto it. Returns the snake, or null if none held.
  reattach(key, newSocket) {
    const o = key && this.orphans.get(key);
    if (!o) return null;
    clearTimeout(o.timer);
    this.orphans.delete(key);
    const oldId  = o.socketId;
    const snake  = this.snakes.get(oldId);
    const player = this.players.get(oldId);
    if (!snake || !snake.alive || !player) {
      this.removePlayer(oldId);   // died during the grace window — clean up the stale entry
      return null;
    }

    this.snakes.delete(oldId);
    this.players.delete(oldId);
    snake.id = newSocket.id;
    snake._orphan = false;
    player.socket = newSocket;
    this.snakes.set(newSocket.id, snake);
    this.players.set(newSocket.id, player);
    newSocket.join(this.socketRoomName);

    newSocket.emit(C.EVENTS.GAME_JOINED, {
      playerId: newSocket.id,
      worldRadius: this.worldRadius,
      snakeColor: snake.color,
      food: this.foodManager.getAll(),
      snake: snake.serialize(),
    });
    return snake;
  }

  handleInput(socketId, targetAngle, boosting, speedMult) {
    const snake = this.snakes.get(socketId);
    if (snake && snake.alive) {
      snake.setInput(targetAngle, boosting, speedMult);
    }
  }

  adjustBorder(playerJoined) {
    if (playerJoined) {
      this.worldRadius = Math.min(C.MAX_WORLD_RADIUS,
        this.worldRadius + C.BORDER_GROW_PER_JOIN);
    } else {
      this.worldRadius = Math.max(C.MIN_WORLD_RADIUS,
        this.worldRadius - C.BORDER_SHRINK_PER_DEATH);
    }
  }

  safeSpawnPoint() {
    const maxR = this.worldRadius * 0.7;
    for (let attempt = 0; attempt < 20; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const r = 100 + Math.random() * (maxR - 100);
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      let safe = true;
      for (const snake of this.snakes.values()) {
        if (!snake.alive) continue;
        const d = Math.hypot(snake.head.x - x, snake.head.y - y);
        if (d < 150) { safe = false; break; }
      }
      if (safe) return { x, y };
    }
    return { x: 0, y: 0 };
  }

  addBot() {
    if (!this.lobbyType.endsWith('free')) return null; // no free bots in paid lobbies
    const id = 'bot_' + uuidv4();
    const { x, y } = this.safeSpawnPoint();
    const bot = new Bot(id, x, y);
    this.snakes.set(id, bot);
    this.borderDrift = Math.min(this.borderDrift + 200, 1200); // a bot join expands the border the same as a real player
    return bot;
  }

  addPaidBot(entrySol) {
    const id = 'bot_' + uuidv4();
    const { x, y } = this.safeSpawnPoint();
    const bot = new Bot(id, x, y);
    bot.worth = entrySol || 0;
    this.snakes.set(id, bot);
    this.borderDrift = Math.min(this.borderDrift + 200, 1200); // a bot join expands the border the same as a real player
    return bot;
  }

  tick() {
    // Border drifts outward on deaths, inward on joins, gradually fading back to base
    this.borderDrift *= 0.9975; // half-life ≈ 2.3 seconds at 60Hz
    // World grows with the crowd — EVERY snake counts, bots included (intended: a
    // lobby populated with bots spreads out and feels alive too). Keeps view-culling
    // effective and the arena playable as it fills up.
    const crowdFloor = Math.min(C.MAX_WORLD_RADIUS,
      C.BASE_WORLD_RADIUS + C.WORLD_RADIUS_PER_PLAYER * Math.max(0, this.snakes.size - 1));
    const targetRadius = Math.max(C.MIN_WORLD_RADIUS,
      Math.min(C.MAX_WORLD_RADIUS, Math.max(C.BASE_WORLD_RADIUS + this.borderDrift, crowdFloor)));
    this.worldRadius += (targetRadius - this.worldRadius) * 0.015; // ~2.5s to fully settle at 60Hz

    const foodList  = this.foodManager.getAll();
    const allSnakes = Array.from(this.snakes.values());

    // Spatial grid of food, built once from pre-magnetism positions. Food only drifts
    // a few units per tick, so its insert cell stays valid for the queries below.
    const foodGrid = this._foodGrid || (this._foodGrid = new SpatialGrid(GRID_CELL));
    foodGrid.clear();
    for (const food of foodList) { food.eaten = false; foodGrid.insert(food.x, food.y, food); }

    const EAT_R2      = C.FOOD_EAT_RADIUS * C.FOOD_EAT_RADIUS;
    const PULL_RADIUS = 35;
    const PULL_R2     = PULL_RADIUS * PULL_RADIUS;
    const PULL_SPEED  = 6;

    // Update snakes
    for (const snake of allSnakes) {
      if (!snake.alive) continue;
      if (snake.isBot) snake.updateAI(foodList, this.worldRadius, allSnakes);
      snake.update();

      // Spawn food from boost drops
      if (snake.boostDrops.length > 0) {
        const safeR = this.worldRadius * 0.95;
        for (const drop of snake.boostDrops) {
          const dist = Math.hypot(drop.x, drop.y);
          if (dist <= safeR) this.foodManager.spawnOne(this.worldRadius, drop.x, drop.y, drop.value, 0, drop.color, undefined, drop.dropped);
        }
        snake.boostDrops = [];
      }

      // Border collision
      const headDist = Math.hypot(snake.head.x, snake.head.y);
      if (headDist >= this.worldRadius) {
        this.killSnake(snake, null);
        continue;
      }

      // Food magnetism + collision — slither.io style: proportional pull within
      // radius, eat within FOOD_EAT_RADIUS, disabled during sharp turns so food
      // doesn't spray around corners. Only the food in the cells around the head is
      // considered (the grid) instead of every food on the map.
      let _aDelta = snake.targetAngle - snake.angle;
      if (_aDelta >  Math.PI) _aDelta -= Math.PI * 2;
      if (_aDelta < -Math.PI) _aDelta += Math.PI * 2;
      const turningSharp = Math.abs(_aDelta) > 0.25;

      const hx = snake.head.x, hy = snake.head.y;
      foodGrid.forEachNear(hx, hy, (food) => {
        if (food.eaten) return false;
        const dx = hx - food.x, dy = hy - food.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < EAT_R2) {
          snake.grow(food.value);
          if (food.cashValue > 0) {
            snake.worth += food.cashValue;
            const p = this.players.get(snake.id);
            if (p) p.socket.emit('ate_dropped_food');
            // Value moved from the source account to the eater — feed the collusion monitor.
            const eaterGid = p && p.socket && p.socket._googleId;
            if (food._srcGid && eaterGid) collusion.record(food._srcGid, eaterGid, food.cashValue, { lobbyType: this.lobbyType });
          }
          food.eaten = true;
          this.foodManager.remove(food.id);
        } else if (!turningSharp && d2 < PULL_R2) {
          // Smooth proportional pull — stronger closer to the head
          const d = Math.sqrt(d2) || 1;
          const strength = (1 - d / PULL_RADIUS) * PULL_SPEED;
          food.x += (dx / d) * strength;
          food.y += (dy / d) * strength;
        }
        return false; // keep scanning the rest of the nearby food
      });
    }

    // Body collision via a spatial grid of every live snake's segments — replaces the
    // old O(players²·segments) all-pairs scan. Each snake only tests its head against
    // the segments in the cells around it. Behaviour matches the old code: a snake
    // dies when its head touches ANOTHER live snake's body (never its own), and in a
    // head-on the first-iterated snake wins (the other is already dead, so skipped).
    const segGrid = this._segGrid || (this._segGrid = new SpatialGrid(GRID_CELL));
    segGrid.clear();
    for (const snake of allSnakes) {
      if (!snake.alive) continue;
      // Fatter snakes are bigger targets: precompute this snake's body kill-radius² from its scale.
      const kr = C.SNAKE_HEAD_RADIUS + 6 * snake.scale;
      snake._killR2 = kr * kr;
      const segs = snake.segments;
      for (let i = 0; i < segs.length; i++) {
        segs[i]._o = snake;                 // tag owner (no allocation) so queries can skip self / dead
        segGrid.insert(segs[i].x, segs[i].y, segs[i]);
      }
    }

    for (const snake of allSnakes) {
      if (!snake.alive) continue;
      const hx = snake.head.x, hy = snake.head.y;
      segGrid.forEachNear(hx, hy, (seg) => {
        if (seg._o === snake || !seg._o.alive) return false; // skip own body + already-dead snakes
        const dx = hx - seg.x, dy = hy - seg.y;
        if (dx * dx + dy * dy < seg._o._killR2) { this.killSnake(snake, seg._o.id); return true; }
        return false;
      });
    }

    // Refill food
    this.foodManager.refill(this.worldRadius);

    // Broadcast a snapshot at SNAPSHOT_RATE (lower than the sim TICK_RATE) so weaker
    // clients receive ~half the data. Simulation still runs every tick.
    const everyN = Math.max(1, Math.round(C.TICK_RATE / (C.SNAPSHOT_RATE || C.TICK_RATE)));
    this._tickN = (this._tickN || 0) + 1;
    if (this._tickN % everyN === 0) this.broadcastSnapshot();
  }

  killSnake(snake, killerId) {
    if (!snake.alive) return;
    const kPlayer = this.players.get(snake.id);
    const kGid = kPlayer?.socket?._googleId;
    allTimeLb.record(kGid || snake.name, snake.name, snake.score);
    // Each death shrinks the border
    this.borderDrift = Math.max(this.borderDrift - 120, -1000);
    const drops = snake.die();
    const safeR = this.worldRadius * 0.95;
    const cashPerDrop = drops.length > 0 && snake.worth > 0 ? snake.worth / drops.length : 0;
    drops.forEach(d => {
      const dist = Math.hypot(d.x, d.y);
      if (dist > safeR) {
        const scale = safeR / dist;
        d.x *= scale;
        d.y *= scale;
      }
      const f = this.foodManager.spawnOne(this.worldRadius, d.x, d.y, d.value, cashPerDrop, d.color, d.size);
      if (f && kGid) f._srcGid = kGid; // tag dropped cash with its source account (collusion tracking)
    });

    const player = this.players.get(snake.id);
    if (player) {
      player.socket.emit(C.EVENTS.PLAYER_DIED, {
        score: snake.score,
        length: snake.length,
        killerId,
      });
    }

    if (killerId) {
      const killerPlayer = this.players.get(killerId);
      if (killerPlayer) {
        killerPlayer.socket.emit(C.EVENTS.PLAYER_KILLED, {
          victimId: snake.id,
          victimName: snake.name,
        });
      }
    }

    // Kill-feed line in the chat. Only broadcast when a HUMAN is involved (skips bot-vs-bot spam).
    const victimIsHuman = this.players.has(snake.id);
    const killerIsHuman = !!killerId && this.players.has(killerId);
    const victimName = String(snake.name || 'a snake').slice(0, 24);
    if (killerId && (killerIsHuman || victimIsHuman)) {
      const killerSnake = this.snakes.get(killerId);
      const killerName = String((killerSnake && killerSnake.name) || 'A snake').slice(0, 24);
      this.io.to(this.socketRoomName).emit(C.EVENTS.CHAT, { kind: 'kill', killer: killerName, victim: victimName });
    } else if (!killerId && victimIsHuman) {
      this.io.to(this.socketRoomName).emit(C.EVENTS.CHAT, { kind: 'kill', killer: null, victim: victimName });
    }
  }

  respawnPlayer(socketId, entrySol) {
    const player = this.players.get(socketId);
    if (!player) return;
    const existing = this.snakes.get(socketId);
    if (existing && existing.alive) return; // don't respawn an alive snake
    const { x, y } = this.safeSpawnPoint();
    const snake = new Snake(socketId, player.name, x, y, player.color, player.hatId, player.boostId);
    snake.worth = entrySol || 0;
    this.snakes.set(socketId, snake);

    player.socket.emit(C.EVENTS.GAME_JOINED, {
      playerId: socketId,
      worldRadius: this.worldRadius,
      snakeColor: snake.color,
      food: this.foodManager.getAll(),
      snake: snake.serialize(),
    });
  }

  buildLeaderboard() {
    const isPaid = this.lobbyType !== 'free';
    return Array.from(this.snakes.values())
      .filter(s => s.alive)
      .sort((a, b) => isPaid ? b.worth - a.worth : b.score - a.score)
      .slice(0, 10)
      .map((s, i) => ({ rank: i + 1, id: s.id, name: s.name, score: s.score, worth: s.worth, length: s.length }));
  }

  broadcastSnapshot() {
    // Broadcast whenever anyone is in the room — players OR spectators. (Spectators
    // join the socket room but aren't tracked as players, and bots aren't players
    // either, so gating on players.size froze the world for spectators.)
    const roomSet = this.io.sockets.adapter.rooms.get(this.socketRoomName);
    if (!roomSet || roomSet.size === 0) return;

    const t           = Date.now();
    const worldRadius = this.worldRadius;
    const leaderboard = this.buildLeaderboard();
    const allFood     = this.foodManager.getAll();

    // Serialize every alive snake ONCE. Alongside each, keep a bounding circle
    // (centre + radius) for cheap "is this snake in that player's view?" tests, plus
    // a tiny minimap dot (head only) so the minimap still shows the whole map even
    // though the heavy per-snake body data gets culled per player below.
    const snakesSer = [];
    const bounds    = [];
    const mm        = [];
    for (const snake of this.snakes.values()) {
      if (!snake.alive) continue;
      const s = snake.serialize();
      const sg = s.segs;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < sg.length; i += 2) {
        const x = sg[i], y = sg[i + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      snakesSer.push(s);
      bounds.push({ cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, br: Math.hypot(maxX - minX, maxY - minY) / 2 });
      const h = snake.head;
      mm.push({ x: Math.round(h.x), y: Math.round(h.y), c: snake.color, id: snake.id });
    }

    // ── Interest-group broadcast ──────────────────────────────────────────────
    // Each player only needs the snakes/food near them, but emitting a separate
    // payload per socket meant N JSON serializations per snapshot — O(players²) work
    // that pegged one core around ~100 players. Instead we bucket players into coarse
    // world cells and send ONE payload per occupied cell through a Socket.IO room, so
    // the payload is encoded once and fanned out to everyone in that cell. Encodes now
    // scale with occupied cells, not players — and a dense fight (the worst case for
    // per-socket) collapses to a single encode.
    // VOLATILE: a client that can't keep up DROPS snapshots rather than backing up its
    // buffer (which would inflate latency for everything, incl. ping_check).
    const CELL           = 2000; // interest-cell size (world units)
    const DEFAULT_VIEW_R = 3000; // until the client reports its real view radius
    const MARGIN         = 400;  // slack so nothing pops in at screen edges

    const cells     = new Map(); // cellKey -> { ci, cj, roomName, maxV }
    const fullSends = [];        // dead / spectator sockets get the unculled set

    for (const sid of roomSet) {
      const sock = this.io.sockets.sockets.get(sid);
      if (!sock) continue;
      const mine = this.snakes.get(sid);

      if (!mine || !mine.alive) {
        if (sock._cellRoom) { sock.leave(sock._cellRoom); sock._cellRoom = null; }
        fullSends.push(sock);
        continue;
      }

      const ci = Math.floor(mine.head.x / CELL), cj = Math.floor(mine.head.y / CELL);
      const key = ci + ',' + cj;
      const roomName = 'aoi_' + this.roomId + '_' + key;
      // keep the socket in exactly its current cell room (cheap; only changes when it
      // crosses a 2000-unit boundary, every few hundred ticks)
      if (sock._cellRoom !== roomName) {
        if (sock._cellRoom) sock.leave(sock._cellRoom);
        sock.join(roomName);
        sock._cellRoom = roomName;
      }
      let cell = cells.get(key);
      if (!cell) { cell = { ci, cj, roomName, maxV: 0 }; cells.set(key, cell); }
      const v = sock._viewR || DEFAULT_VIEW_R;
      if (v > cell.maxV) cell.maxV = v;
    }

    // One encoded payload per occupied cell. Region = the cell expanded by the widest
    // view among its players (+margin), so even a zoomed-out player in that cell sees
    // everything it should; players with a tighter view just get a little extra.
    for (const cell of cells.values()) {
      const pad   = cell.maxV + MARGIN;
      const cx    = cell.ci * CELL + CELL / 2;
      const cy    = cell.cj * CELL + CELL / 2;
      const halfW = CELL / 2 + pad, halfH = CELL / 2 + pad;

      const snakes = [];
      for (let i = 0; i < snakesSer.length; i++) {
        const b = bounds[i];
        if (Math.abs(b.cx - cx) <= halfW + b.br && Math.abs(b.cy - cy) <= halfH + b.br) snakes.push(snakesSer[i]);
      }
      const food = [];
      for (const f of allFood) {
        if (Math.abs(f.x - cx) <= halfW && Math.abs(f.y - cy) <= halfH) food.push(f);
      }
      const enc = encodeSnapshot({ t, worldRadius, snakes, food, leaderboard, mm });
      this.io.to(cell.roomName).volatile.emit(C.EVENTS.SNAPSHOT, enc.meta, enc.coords);
    }

    // Dead / spectator sockets: full snapshot (rare and transient).
    for (const sock of fullSends) {
      const enc = encodeSnapshot({ t, worldRadius, snakes: snakesSer, food: allFood, leaderboard, mm });
      sock.volatile.emit(C.EVENTS.SNAPSHOT, enc.meta, enc.coords);
    }
  }
}

module.exports = GameRoom;
