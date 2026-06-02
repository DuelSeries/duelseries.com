const C = require('../shared/constants');
const Snake = require('./Snake');
const Bot   = require('./Bot');
const FoodManager = require('./Food');
const { v4: uuidv4 } = require('uuid');
const allTimeLb = require('./leaderboard');

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
        this.foodManager.spawnOne(this.worldRadius, d.x, d.y, d.value, cashPerDrop, d.color, d.size, d.dropped);
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
    this.borderDrift = Math.min(this.borderDrift + 120, 1200);
    return bot;
  }

  addPaidBot(entrySol) {
    const id = 'bot_' + uuidv4();
    const { x, y } = this.safeSpawnPoint();
    const bot = new Bot(id, x, y);
    bot.worth = entrySol || 0;
    this.snakes.set(id, bot);
    this.borderDrift = Math.min(this.borderDrift + 120, 1200);
    return bot;
  }

  tick() {
    // Border drifts outward on deaths, inward on joins, gradually fading back to base
    this.borderDrift *= 0.9975; // half-life ≈ 2.3 seconds at 60Hz
    const targetRadius = Math.max(C.MIN_WORLD_RADIUS,
      Math.min(C.MAX_WORLD_RADIUS, C.BASE_WORLD_RADIUS + this.borderDrift));
    this.worldRadius += (targetRadius - this.worldRadius) * 0.015; // ~2.5s to fully settle at 60Hz

    const foodList  = this.foodManager.getAll();
    const allSnakes = Array.from(this.snakes.values());
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

      // Food magnetism + collision — slither.io style:
      // proportional pull within radius, no committed tracking, food stays
      // put if the snake moves away. Disabled during sharp turns so food
      // doesn't spray around corners.
      let _aDelta = snake.targetAngle - snake.angle;
      if (_aDelta >  Math.PI) _aDelta -= Math.PI * 2;
      if (_aDelta < -Math.PI) _aDelta += Math.PI * 2;
      const turningSharp = Math.abs(_aDelta) > 0.25;

      const PULL_RADIUS = 35;
      const PULL_SPEED  = 6;
      for (const food of this.foodManager.getAll()) {
        const dx = snake.head.x - food.x;
        const dy = snake.head.y - food.y;
        const d  = Math.hypot(dx, dy);
        if (d < C.FOOD_EAT_RADIUS) {
          snake.grow(food.value);
          if (food.cashValue > 0) {
            snake.worth += food.cashValue;
            const p = this.players.get(snake.id);
            if (p) p.socket.emit('ate_dropped_food');
          }
          this.foodManager.remove(food.id);
        } else if (!turningSharp && d < PULL_RADIUS) {
          // Smooth proportional pull — stronger closer to the head
          const strength = (1 - d / PULL_RADIUS) * PULL_SPEED;
          food.x += (dx / d) * strength;
          food.y += (dy / d) * strength;
        }
      }
    }

    // Body collision — only kill when hitting another player's body, never self
    const BODY_BROAD_R2 = 600 * 600; // skip pairs whose heads are far apart
    for (const snake of allSnakes) {
      if (!snake.alive) continue;
      for (const other of allSnakes) {
        if (!other.alive) continue;
        if (other.id === snake.id) continue; // no self-collision
        // Broad-phase: skip if heads are far apart (body can't possibly be near)
        const bhx = snake.head.x - other.head.x;
        const bhy = snake.head.y - other.head.y;
        if (bhx * bhx + bhy * bhy > BODY_BROAD_R2) continue;
        for (let i = 0; i < other.segments.length; i++) {
          const seg = other.segments[i];
          const d = Math.hypot(snake.head.x - seg.x, snake.head.y - seg.y);
          if (d < C.SNAKE_HEAD_RADIUS + 6) {
            this.killSnake(snake, other.id);
            break;
          }
        }
        if (!snake.alive) break;
      }
    }

    // Refill food
    this.foodManager.refill(this.worldRadius);

    // Build and broadcast snapshot
    this.broadcastSnapshot();
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
      this.foodManager.spawnOne(this.worldRadius, d.x, d.y, d.value, cashPerDrop, d.color, d.size);
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

    const snakeData = [];
    for (const snake of this.snakes.values()) {
      if (snake.alive) snakeData.push(snake.serialize());
    }

    const snapshot = {
      t: Date.now(),
      worldRadius: this.worldRadius,
      snakes: snakeData,
      food: this.foodManager.getAll(),
      leaderboard: this.buildLeaderboard(),
    };

    // Broadcast to the whole room at once — Socket.IO serializes the payload
    // only once regardless of player count, vs N serializations with per-socket emit.
    this.io.to(this.socketRoomName).emit(C.EVENTS.SNAPSHOT, snapshot);
  }
}

module.exports = GameRoom;
