/* ─── Crossy Road: the one step (server, bot and page) ─────────────────────────
   Two hoppers on the SAME seeded map at the same time. The first one hit,
   drowned, carried off the edge or taken by the eagle loses; both on the same
   tick is a draw (server/crossy/CrossyRoom.js judges it).

   EVERY NUMBER HERE IS THE REFERENCE'S (Poki's Crossy Road, the "original"
   world), read from its decoded source or measured from it running headless:
   docs/crossy-reference.md has each one with where it came from, and marks the
   few that are ours (the duel's start, its pressure ramp, its safety stop).

   DETERMINISTIC. The map is a pure function of the seed: rows are made in
   order (a lane can depend on the lane before it, as in the reference), and
   every moving thing on a lane is a closed-form function of the lane clock, so
   the server, the bot and both pages agree on where every car, log and train
   is on every tick without sending any of it. A hopper is a pure function of
   the map and its own hops, which is what lets the server run each seat on its
   own timeline (see CrossyRoom) and a page predict its own hopper exactly.
   No Math.random, no Date, no trigonometry: only + - * / and Math.imul, which
   every JavaScript engine computes the same.

   Loaded as a plain script it is window.CrossySim; required, module.exports. */
(function (root) {
  'use strict';

  const NAME = 'Crossy Road';
  /* The step's version. A page running an older step would predict a different
     game from the one the server judges, so the server only seats a page that
     says this number (cr:queue v). Bump it with any change to the rules. */
  const VERSION = 1;

  const HZ = 60;
  const DT = 1 / HZ;
  const TICK_MS = 1000 / HZ;

  /* ── the rules' numbers (docs/crossy-reference.md) ─────────────────────── */
  const C = {
    HOP_DELAY: 9,            // ticks: hopDelay 0.15 s before the next hop may start
    WATER_TEST: 14,          // ticks: the hop's arc envelope (attack 0.07, release 0.12 s) reaches stage 4 on the 14th frame
    GLIDE_S: 0.4,            // movePasr release 0.4 s, eased 1 - easeInCubic
    ARC_ATTACK: 0.07, ARC_RELEASE: 0.12, HOP_HEIGHT: 0.5,
    PLAYER_W: 0.29, PLAYER_D: 0.52,
    EDGE: 4.5,               // carried past |x| > 4.5 is dead ("log")
    SIDE: 3.5,               // a side hop only while target x < 3.5 (or > -3.5)
    START_ROW: -2,           // targetPosition (0, 0.375, 2): row = -z
    BACK_ROW: -4,            // back only while target z <= 4
    EAGLE_S: 5,              // eagle timeOut
    EAGLE_SPEED: 30,
    SPAWN_X: 12.5,           // xSpawnDistance
    CAR_GONE: 14,            // pooled past |x| > 14
    CAR_GAP: 12, CAR_MINI_GAP: 6,
    MINI_GAPS: [0, 0, 0, 1, 2, 3],
    CAR_PREWARM: 7, LOG_PREWARM: 15,
    TRUCK_OVER: 0.831,
    RAPIDS: 3,
    TRAIN_SPEED: 60, TRAIN_WARN: 1.2, TRAIN_OFFSET: 20, TRAIN_HALF: 16, TRAIN_HZ: 0.9,
    ROW_AHEAD: 18,           // rows are made 18 ahead of the player: the reference's CurrentRow when a row was made
    FIRST_ROW: -8,           // K5 = -8
    COIN_CHANCE: 0.09,
  };

  /* Cars: hitBoxScale [x, y, z] by variation, picked by weight (electric, purple, muscle, sedan; truck). The look
     is ours (public/js/crossy/crossyScene.js); the sizes and weights are the reference's. */
  const CARS = [
    { id: 'electric', w: 0.2, hx: 1.1 },
    { id: 'purple', w: 0.2, hx: 1.6 },
    { id: 'muscle', w: 0.003, hx: 1.8 },
    { id: 'sedan', w: 0.2, hx: 1.6 },
  ];
  const TRUCKS = [{ id: 'truck', w: 0.799, hx: 2.8 }, { id: 'truckBlue', w: 0.15, hx: 2.8 }, { id: 'truckGreen', w: 0.05, hx: 2.8 }];
  const CAR_HZ = 0.7;
  /* What stands in a blocked cell (blocking-object-tall / -short): 1-4 trees of rising height, 5 a rock, 9 a stump. */
  const TALL = [1, 2, 3, 4, 9], TALL_W = [25, 25, 25, 25, 2];
  const SHORT = [1, 2, 5, 9], SHORT_W = [33, 33, 33, 2];
  function pickIndex(ws, R) {
    let tot = 0;
    for (const w of ws) tot += w;
    let u = R() * tot;
    for (let i = 0; i < ws.length; i++) if ((u -= ws[i]) < 0) return i;
    return ws.length - 1;
  }

  /* The chunk table, lane names only: [name, rarity, lanes]. Chunks whose base rarity is "Never" are left out:
     the reference's rarity events compare against a static that is never set (u66.lastScoreThreshold), so they
     never fire and those chunks never come up. */
  const CHUNKS = [
    ['grassy-nothing', 'MostEpic', ['grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass']],
    ['grass-single', 'Common', ['grass']],
    ['water-lily-a', 'Epic', ['log-left-poop', 'water-lilypad-rand', 'log-left-poop', 'log-right-poop', 'log-left-poop', 'water-lilypad-rand']],
    ['water-left-3', 'Rarer', ['water-lilypad-rand', 'log-left-poop-slow', 'log-left-poop-fast', 'log-right-poop']],
    ['train-1', 'Rare', ['train']],
    ['water-lily-rand', 'Rarer', ['water-lilypad-rand']],
    ['train-2', 'Epic', ['train', 'train']],
    ['train-1b', 'Rare', ['train']],
    ['train-3', 'Epic', ['train', 'train']],
    ['train-road-alternate', 'MostEpic', ['road', 'train', 'road', 'train', 'road', 'train']],
    ['trainfield', 'MostEpic', ['grass-hole', 'grass', 'grass', 'grass', 'train', 'grass', 'train', 'train', 'grass', 'grass', 'train', 'train', 'train', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass', 'grass-hole']],
    ['water-easy', 'Rarer', ['log-right-poop', 'log-left-poop']],
    ['road-harder', 'Rarer', ['grass', 'road', 'road', 'road']],
    ['log-poop-4-alt-b', 'Rarer', ['log-right-poop', 'log-left-poop', 'log-right-poop']],
    ['train-road', 'MostEpic', ['road', 'road', 'train', 'road', 'train', 'grass-hole']],
    ['road-single', 'Common', ['road']],
    ['log-poop-4-alt', 'Epic', ['log-left-poop', 'log-right-poop', 'log-left-poop', 'log-right-poop']],
    ['road-highway', 'MostEpic', ['road', 'road', 'road', 'road', 'road', 'road', 'road', 'road', 'road', 'road']],
    ['road-easy', 'Common', ['grass', 'road', 'road']],
    ['road-5', 'Epic', ['road', 'road', 'road', 'road', 'road']],
  ];

  /* ── the duel's own numbers (CHOSEN, docs/crossy-reference.md) ─────────── */
  const DUEL = {
    COUNTDOWN_MS: 3000,
    RAMP_AFTER: 45,          // s of match before the traffic starts speeding up
    RAMP_RATE: 0.012,        // +1.2% a second
    RAMP_MAX: 2.0,           // reached at 45 + 1/0.012 = 128.3 s
    MAX_TICKS: 5 * 60 * HZ,  // safety stop: 5 minutes, then the one further ahead wins
  };

  /* ── a seeded generator (mulberry32) ───────────────────────────────────── */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // A row's own stream: the same row on the same seed always draws the same numbers, whatever was made before it.
  function rowSeed(seed, r) { return (Math.imul((seed >>> 0) ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul(r + 0x7F4A7C15, 0xC2B2AE35)) >>> 0; }

  function pick(list, R) {
    let tot = 0;
    for (const v of list) tot += v.w;
    let u = R() * tot;
    for (const v of list) { if ((u -= v.w) < 0) return v; }
    return list[list.length - 1];
  }

  /* The reference's lane speed (CarSpawner/LogSpawner.GetNewSpeed), on the row the player stood on when it was made. */
  function laneSpeed(row, R) {
    const cur = Math.max(row - C.ROW_AHEAD, 0);
    let f = 2 + Math.min(cur / 1000, 5);
    if (cur > 300) f += cur / 300;
    return Math.min(2 + R() * f, 7);
  }

  /* ── the lane clock: the duel's pressure ramp, as a time warp ──────────────
     Everything that moves runs on d = D(t), t the match's seconds since GO. Before RAMP_AFTER, d = t. After it the
     rate dd/dt climbs by RAMP_RATE a second to RAMP_MAX and stays: cars, logs and trains all move faster and come
     more often, with the same gaps in metres. A closed form, so any tick's lane time is exact on every machine. */
  const T_MAX = DUEL.RAMP_AFTER + (DUEL.RAMP_MAX - 1) / DUEL.RAMP_RATE;
  const D_MAX = T_MAX + 0.5 * DUEL.RAMP_RATE * (T_MAX - DUEL.RAMP_AFTER) * (T_MAX - DUEL.RAMP_AFTER);
  function laneTime(tick) {
    const t = tick * DT;
    if (t <= DUEL.RAMP_AFTER) return t;
    if (t <= T_MAX) { const u = t - DUEL.RAMP_AFTER; return t + 0.5 * DUEL.RAMP_RATE * u * u; }
    return D_MAX + DUEL.RAMP_MAX * (t - T_MAX);
  }
  function rampAt(tick) {
    const t = tick * DT;
    return t <= DUEL.RAMP_AFTER ? 1 : Math.min(DUEL.RAMP_MAX, 1 + DUEL.RAMP_RATE * (t - DUEL.RAMP_AFTER));
  }

  /* ── the map ─────────────────────────────────────────────────────────────── */
  const RARITY = (u) => (u >= 99.9 ? 'MostEpic' : u >= 98.9 ? 'Epic' : u >= 94 ? 'Rarer' : u >= 84.9 ? 'Rare' : u >= 70 ? 'Uncommon' : 'Common');
  const BY_RARITY = {};
  for (const ch of CHUNKS) (BY_RARITY[ch[1]] = BY_RARITY[ch[1]] || []).push(ch);

  function World(seed) {
    this.seed = seed >>> 0;
    this.rows = new Map();
    this.next = C.FIRST_ROW;
    this.R = rng(this.seed ^ 0x2545F491);    // the chunk stream: which chunk comes next
    this.chunk = [];
    this.startLeft = 9;
    this.prevType = 'grass';
    this.prevDirIsRight = undefined;         // set by log lanes only, as in the reference
    this.prevLaneSpeed = undefined;
  }

  World.prototype.row = function (r) {
    while (this.next <= r) this.make(this.next++);
    return this.rows.get(r);
  };
  // Rows well behind everybody are never reached again (the reference drops them 10 behind).
  World.prototype.forget = function (below) {
    for (const k of this.rows.keys()) if (k < below) this.rows.delete(k);
  };

  World.prototype.nextStrip = function () {
    if (this.startLeft > 0) {
      this.startLeft--;
      return this.startLeft > 7 ? 'field-mid' : this.startLeft > 5 ? 'start-forest' : 'grass-start';
    }
    while (!this.chunk.length) {
      const list = BY_RARITY[RARITY(this.R() * 100)];
      if (!list) continue;                   // no chunk of that rarity: the reference re-rolls (GetChunk recursion)
      const ch = list[Math.floor(this.R() * list.length)];
      this.chunk = ch[2].slice().reverse();
    }
    return this.chunk.pop();
  };

  World.prototype.make = function (r) {
    const name = this.nextStrip();
    const R = rng(rowSeed(this.seed, r));
    const row = {
      r, name, kind: 'grass', h: 0.375, cells: new Int8Array(9), look: new Int8Array(9), coin: null,
      dir: 0, speed: 0, R, alt: (r % 2 + 2) % 2,
    };
    const cur = Math.max(r - C.ROW_AHEAD, 0);
    const block = (x, tall) => {
      if (row.cells[x + 4]) return;
      const t = tall || x < -2 || x > 2 || R() < 0.1;
      row.cells[x + 4] = t ? 2 : 1;
      // Which piece: tall = one of four trees (or a rare stump), short = small tree, rock or stump (weights 25/2, 33/2).
      row.look[x + 4] = (t ? TALL : SHORT)[pickIndex(t ? TALL_W : SHORT_W, R)];
    };
    const coinAt = (x) => { if (R() < C.COIN_CHANCE) row.coin = x; };
    if (name === 'road') {
      row.kind = 'road'; row.h = 0.25;
      row.edge = this.prevType !== 'car' && this.prevType !== 'truck';   // strip-road-2: the first road after something else
      row.dir = R() > 0.5 ? 1 : -1;
      const truck = R() > C.TRUCK_OVER;
      row.speed = laneSpeed(r, R);
      row.t0 = -C.CAR_PREWARM + R() * (C.CAR_GAP / row.speed);
      row.mini = C.MINI_GAPS[Math.floor(R() * C.MINI_GAPS.length)];
      row.car = pick(truck ? TRUCKS : CARS, R);
      row.truck = truck;
      row.type = truck ? 'truck' : 'car';
      row.spawns = [];
      row.gapN = 0;
      coinAt(Math.floor(R() * 9) - 4);
    } else if (name.startsWith('log-')) {
      row.kind = 'water'; row.h = 0.395; row.type = 'log';
      const right = name.startsWith('log-right');
      row.dir = right ? -1 : 1;               // a "left" lane spawns on the left and drifts right
      row.speed = 1 + R() * laneSpeed(r, R);
      row.gapMax = 1 + R() * 3;
      row.w0 = this.logWidth(cur, R);
      row.t0 = R() * ((0.3 + row.gapMax + row.w0) / row.speed);
      row.poop = name.indexOf('poop') >= 0;
      row.cur = cur;
      if (name.endsWith('slow')) { row.speed *= 1.2; row.gapMax = 2.0; }
      else if (name.endsWith('fast')) { row.speed = Math.max(row.speed, 2.2); row.gapMax = 1.1; }
      if ((this.prevType === 'car' || this.prevType === 'log') && right === this.prevDirIsRight) {
        if (!(Math.abs(this.prevLaneSpeed - row.speed) < 1)) row.speed = this.prevLaneSpeed + 1;
      }
      this.prevLaneSpeed = row.speed;
      this.prevDirIsRight = right;
      row.t0 -= C.LOG_PREWARM;
      row.spawns = [];
      row.ws = [];
    } else if (name === 'water-lilypad-rand') {
      row.kind = 'water'; row.h = 0.45; row.type = 'lily';
      let u = 0, f = 0;
      while (u === 0) u = Math.floor(R() * 6 - 3);
      while (f === u || f === 0) f = Math.floor(R() * 6 - 3);
      row.lilies = [0];
      if (R() < 0.5) row.lilies.push(u);
      if (R() < 0.5) row.lilies.push(f);
      coinAt(row.lilies[Math.floor(R() * row.lilies.length)]);
    } else if (name === 'train') {
      row.kind = 'rail'; row.h = 0.25; row.type = 'train';
      row.dir = R() > 0.5 ? 1 : -1;
      row.t0 = R() * 10;
      row.trains = [];
      coinAt(Math.floor(R() * 9) - 4);
    } else {
      row.type = 'grass';
      if (name === 'grass') {
        const free = [0];
        for (let x = -4; x <= 4; x++) { if (x === 0) continue; if (R() < 0.333) block(x); else free.push(x); }
        coinAt(free[Math.floor(R() * free.length)]);
      } else if (name === 'grass-hole') {
        for (let x = -4; x <= 4; x++) if (x !== 0) block(x);
        coinAt(0);
      } else if (name === 'start-forest') {
        for (let x = -4; x <= 4; x++) block(x);
      } else if (name === 'grass-empty') {
        const x = Math.round(R() * 4 - 4);
        if (R() > 0.55) row.coin = x;
      }
    }
    this.prevType = row.type;
    this.rows.set(r, row);
  };

  // A log's length: 1 only from row 100 (scoreRequired), else 2 or 3, equal weights.
  World.prototype.logWidth = function (cur, R) { return logLen(cur, R); };

  /* ── what is on a lane at lane time d ─────────────────────────────────────── */

  /* Each lane's schedule is made in order, as far as it is asked about, from the lane's own stream; a query
     binary-searches it, so asking about any tick in any order gives the same answer. */
  function firstAtOrAfter(arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
    return lo;
  }

  // Cars (CarSpawner.tick): a short gap `mini` times in a row, then a long one.
  function carsUpTo(row, d) {
    const s = row.spawns;
    if (!s.length) s.push(row.t0);
    while (s[s.length - 1] <= d) {
      const gap = row.gapN < row.mini ? C.CAR_MINI_GAP : C.CAR_GAP;
      row.gapN = row.gapN < row.mini ? row.gapN + 1 : 0;
      s.push(s[s.length - 1] + gap / row.speed);
    }
  }
  /* The cars on a road at lane time d, as their x. A car lives (12.5 + 14) / speed of lane time. */
  function carsAt(row, d, out) {
    out.length = 0;
    carsUpTo(row, d);
    const s = row.spawns, life = (C.SPAWN_X + C.CAR_GONE) / row.speed;
    for (let k = firstAtOrAfter(s, d - life); k < s.length && s[k] <= d; k++) {
      out.push(-row.dir * C.SPAWN_X + row.dir * row.speed * (d - s[k]));
    }
    return out;
  }

  // Logs (LogSpawner.tick): every (gap + the lane's first width + random 3) / speed; a poop lane re-rolls each log's length.
  function logsUpTo(row, d) {
    const s = row.spawns;
    if (!s.length) { s.push(row.t0); row.ws.push(row.poop ? logLen(row.cur, row.R) : row.w0); }
    while (s[s.length - 1] <= d) {
      s.push(s[s.length - 1] + (row.gapMax + row.w0 + row.R() * 3) / row.speed);
      row.ws.push(row.poop ? logLen(row.cur, row.R) : row.w0);
    }
  }
  function logLen(cur, R) { return cur >= 100 ? 1 + Math.floor(R() * 3) : 2 + Math.floor(R() * 2); }
  /* A log's x at age a (lane seconds since it spawned): three times as fast in the rapids past |x| > 4.5 + w/2. */
  function logX(row, w, a) {
    const v = row.speed, E = C.EDGE + w / 2, x0 = C.SPAWN_X;
    const a1 = (x0 - E) / (C.RAPIDS * v), a2 = a1 + 2 * E / v;
    let off;
    if (a < a1) off = C.RAPIDS * v * a;
    else if (a < a2) off = (x0 - E) + v * (a - a1);
    else off = (x0 + E) + C.RAPIDS * v * (a - a2);
    return row.dir * (off - x0);
  }
  function logLife(row, w) {
    const v = row.speed, E = C.EDGE + w / 2, x0 = C.SPAWN_X;
    return (x0 - E) / (C.RAPIDS * v) + 2 * E / v + (C.CAR_GONE - E) / (C.RAPIDS * v);
  }
  /* The logs on a river at lane time d: { x, w, k } each (k: its place in the lane's schedule, its id). */
  function logsAt(row, d, out) {
    out.length = 0;
    logsUpTo(row, d);
    const s = row.spawns;
    for (let k = firstAtOrAfter(s, d - logLife(row, 1) - 0.01); k < s.length && s[k] <= d; k++) {
      const w = row.ws[k], a = d - s[k];
      if (a > logLife(row, w)) continue;
      out.push({ x: logX(row, w, a), w, k });
    }
    return out;
  }
  function logById(row, k, d) {
    logsUpTo(row, d);
    if (k < 0 || k >= row.spawns.length) return null;
    const a = d - row.spawns[k], w = row.ws[k];
    if (a < 0 || a > logLife(row, w)) return null;
    return { x: logX(row, w, a), w, k };
  }

  // Trains (TrainSpawner): the first at lane time t0 (random 0..10 s), then every 9 + random 4 s.
  function trainsUpTo(row, d) {
    const s = row.trains;
    if (!s.length) s.push(row.t0);
    while (s[s.length - 1] <= d + C.TRAIN_WARN) s.push(s[s.length - 1] + 9 + row.R() * 4);
  }
  /* The train on a rail at lane time d: its hit box centre (or null) and whether the warning light is on. The front
     starts 20 units back from the spawn point ((12.5 dir - 20) dir); the box's centre is middle[2], 13.5 behind
     the front; the box is 32 long. */
  function trainAt(row, d) {
    trainsUpTo(row, d);
    const s = row.trains;
    const k = firstAtOrAfter(s, d + 1e-9) - 1;      // the last train that has left (-1: none yet)
    const next = s[k + 1];
    const warn = next - d <= C.TRAIN_WARN;
    let cx = null;
    if (k >= 0) {
      const front = (C.SPAWN_X * row.dir - C.TRAIN_OFFSET) * row.dir;
      const c = front - 13.5 + row.dir * C.TRAIN_SPEED * (d - s[k]);
      if (Math.abs(c) < C.TRAIN_HALF + 8) cx = c;
    }
    return { cx, warn, k };
  }

  /* ── a hopper ─────────────────────────────────────────────────────────────── */
  const IN = { NONE: 0, FWD: 1, BACK: 2, LEFT: 3, RIGHT: 4 };

  function newHopper() {
    return {
      tick: 0,                 // the next tick this hopper will step
      x: 0, r: C.START_ROW,    // the target cell (x is fractional while riding a log)
      px: 0, pr: C.START_ROW,  // where the last hop started
      face: IN.FWD,
      hopAt: -1000,            // the tick the last hop started
      wait: 0,                 // ticks before the next hop may start
      pend: 0,                 // the move waiting to happen (kept while it is blocked, as in the reference)
      water: false, waterAt: 0,
      log: -1,                 // the log being ridden (its spawn index on this row), or -1
      lily: false,
      eagle: 0,                // seconds; the eagle comes past EAGLE_S
      alive: true, death: '', deadTick: -1,
      best: C.START_ROW,
      coins: 0, got: [],       // rows whose coin this hopper took
      hops: 0,
    };
  }
  function copyHopper(h) {
    const o = Object.assign({}, h);
    o.got = h.got.slice();
    return o;
  }
  const score = (h) => h.best + 2;

  /* A hopper as a flat list for the wire (the room's snapshots), and back. Everything a step reads, so a page can
     take the server's hopper and step on from it exactly. Not the coins' rows (looks only). */
  const DEATHS = ['', 'car', 'train', 'water', 'log', 'eagle'];
  function packHopper(h) {
    return [h.tick, h.x, h.r, h.px, h.pr, h.face, h.hopAt, h.wait, h.pend, h.water ? 1 : 0, h.waterAt, h.log,
      h.eagle, h.alive ? 1 : 0, DEATHS.indexOf(h.death), h.deadTick, h.best, h.coins, h.hops];
  }
  function unpackHopper(a, into) {
    const h = into || newHopper();
    if (!Array.isArray(a) || a.length < 19) return null;
    h.tick = a[0]; h.x = a[1]; h.r = a[2]; h.px = a[3]; h.pr = a[4]; h.face = a[5]; h.hopAt = a[6]; h.wait = a[7];
    h.pend = a[8]; h.water = !!a[9]; h.waterAt = a[10]; h.log = a[11]; h.eagle = a[12]; h.alive = !!a[13];
    h.death = DEATHS[a[14]] || ''; h.deadTick = a[15]; h.best = a[16]; h.coins = a[17]; h.hops = a[18];
    return h;
  }

  const blocked = (row, x) => !row || (row.kind === 'grass' && row.cells[Math.round(x) + 4] !== 0) || Math.abs(Math.round(x)) > 4;

  /* Landing on water (CheckWaterObjects): on a log (snapped to its cells), on a lily, or not (the test runs again
     when the hop's arc ends, and failing it then is drowning). dx is the side hop, for the reference's fudge when a
     side hop leaves a log. */
  function landWater(world, h, d, dx, prevLog, prevRow) {
    const row = world.row(h.r);
    h.log = -1; h.lily = false;
    if (!row || row.kind !== 'water') { h.water = false; return false; }
    if (row.type === 'lily') {
      for (const lx of row.lilies) if (lx === h.x) { h.lily = true; return false; }
    } else {
      const logs = logsAt(row, d, SCRATCH);
      for (const L of logs) {
        if (Math.abs(h.x - L.x) < (0.05 + L.w + 0.5) / 2) {
          h.log = L.k;
          h.water = false;
          const g = -1.5 + L.w / 2;
          let k = h.x - L.x + g;
          k -= Math.round(k);
          h.x -= k;
          const i = Math.round(h.x - L.x + g + 1), n = Math.round(L.w);
          if (i < 0) h.x += -i;
          else if (i >= n) h.x -= n - i + 1;
          return false;
        }
      }
    }
    h.water = true;
    if (prevLog >= 0 && prevRow) {
      const L = logById(prevRow, prevLog, d);
      if (L) {
        const v = prevRow.dir * prevRow.speed * (Math.abs(L.x) > C.EDGE + L.w / 2 ? C.RAPIDS : 1) * rampAt(h.tick);
        if ((v < 0 && dx < 0) || (v > 0 && dx > 0)) h.x += v * (C.ARC_ATTACK + C.ARC_RELEASE) * 2;
      }
    }
    return true;
  }
  const SCRATCH = [];
  const SCRATCH2 = [];

  function die(h, why) {
    if (!h.alive) return;
    h.alive = false; h.death = why; h.deadTick = h.tick;
  }

  /* One tick of one hopper. `press` is a move pressed on this tick (IN.*), or 0. Returns nothing; read h. */
  function step(world, h, press) {
    if (!h.alive) { h.tick++; return; }
    const tick = h.tick;
    const d = laneTime(tick), d0 = laneTime(tick - 1);
    if (press >= 1 && press <= 4) h.pend = press;
    if (h.wait > 0) h.wait--;
    // The arc ended over water: on a log or a lily by now, or drowned.
    if (h.water && tick - h.hopAt >= C.WATER_TEST) {
      landWater(world, h, d, 0, -1, null);
      if (h.water) { die(h, 'water'); h.tick++; return; }
    }
    if (h.wait <= 0 && !h.water && h.pend) {
      let dx = 0, dr = 0;
      const p = h.pend;
      if (p === IN.RIGHT) { if (h.x < C.SIDE && !blocked(world.row(h.r), h.x + 1)) dx = 1; }
      else if (p === IN.LEFT) { if (h.x > -C.SIDE && !blocked(world.row(h.r), h.x - 1)) dx = -1; }
      else if (p === IN.FWD) { if (!blocked(world.row(h.r + 1), h.x)) dr = 1; }
      else if (p === IN.BACK) { if (h.r >= C.BACK_ROW && !blocked(world.row(h.r - 1), h.x)) dr = -1; }
      h.face = p;
      if (dx || dr) {
        const prevLog = h.log, prevRow = world.row(h.r);
        h.pend = 0;
        h.px = h.x; h.pr = h.r;
        h.x += dx; h.r += dr;
        h.hopAt = tick; h.wait = C.HOP_DELAY; h.hops++;
        if (dr > 0) h.eagle = Math.max(0, h.eagle - 1);
        else if (dr < 0) h.eagle += 1;
        landWater(world, h, d, dx, prevLog, prevRow);
        if (h.r > h.best) h.best = h.r;
        const row = world.row(h.r);
        if (row.coin !== null && row.coin === h.x && h.got.indexOf(h.r) < 0) { h.got.push(h.r); h.coins++; }
      }
    }
    // Riding: moved with the log, by exactly as far as the log moved this tick.
    if (h.log >= 0) {
      const row = world.row(h.r);
      const now = logById(row, h.log, d), was = logById(row, h.log, d0);
      if (now && was) h.x += now.x - was.x;
      else h.log = -1;
    } else if (!h.water) h.x = Math.round(h.x);
    if (Math.abs(h.x) > C.EDGE) { die(h, 'log'); h.tick++; return; }
    h.eagle += DT;
    if (h.eagle > C.EAGLE_S) { die(h, 'eagle'); h.tick++; return; }
    // Hit: anything overlapping the TARGET cell (the reference checks the target, not where the body is drawn).
    const row = world.row(h.r);
    if (row.kind === 'road') {
      const hx = row.car.hx;
      for (const cx of carsAt(row, d, SCRATCH2)) {
        if (Math.abs(h.x - cx) < (C.PLAYER_W + hx) / 2) { die(h, 'car'); break; }
      }
    } else if (row.kind === 'rail') {
      const tr = trainAt(row, d);
      if (tr.cx !== null && Math.abs(h.x - tr.cx) < (C.PLAYER_W + 2 * C.TRAIN_HALF) / 2) die(h, 'train');
    }
    h.tick++;
  }

  /* Where the body is drawn at fractional tick ft (the page's glide and arc): { x, z, y } in world units, with
     z = -row and y above the row's ground. The rules never read this. */
  function bodyAt(world, h, ft) {
    const a = Math.max(0, (ft - h.hopAt) * DT);
    const g = Math.min(1, a / C.GLIDE_S);
    const e = 1 - (1 - g) * (1 - g) * (1 - g);      // 1 - easeInCubic(1 - g)
    const rowTo = world.row(h.r), rowFrom = world.row(h.pr);
    const hTo = rowTo ? rowTo.h : 0.375, hFrom = rowFrom ? rowFrom.h : 0.375;
    let arc = 0;
    if (a < C.ARC_ATTACK) arc = a / C.ARC_ATTACK;
    else if (a < C.ARC_ATTACK + C.ARC_RELEASE) arc = 1 - (a - C.ARC_ATTACK) / C.ARC_RELEASE;
    arc = arc * (2 - arc);                            // easeOutQuad
    return {
      x: h.px + (h.x - h.px) * e,
      z: -(h.pr + (h.r - h.pr) * e),
      y: hFrom + (hTo + arc * C.HOP_HEIGHT - hFrom) * e,
      arc,
    };
  }

  const api = {
    NAME, VERSION, HZ, DT, TICK_MS, C, DUEL, IN, CARS, TRUCKS, CAR_HZ, CHUNKS,
    rng, World, laneTime, rampAt, carsAt, logsAt, logById, trainAt,
    newHopper, copyHopper, step, bodyAt, score, blocked, packHopper, unpackHopper,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CrossySim = api;
})(typeof window !== 'undefined' ? window : null);
