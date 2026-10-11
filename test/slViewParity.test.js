'use strict';
// slView parity (task T8; SERVER-DESIGN 18.2 items 1 to 4 and the slView rows of 18.1). FIXTURE table only.
// Scripted worlds (test/slViewHarness.js): 16 to 40 snakes, 4 seats that die, leave and are replaced, angle, boost and
// arrow inputs, disconnect kills and leaves, wakes of 1 tick and of 1 to 3 ticks (catch-up). Every seat bundle goes
// through the harness's stream mirror (item 1: no kind-15 or off-grid number; item 2: never-sent types; item 3: at
// most one move of a snake per tick; item 4: forms; plus no ghost and no duplicate). Here, against the server state
// after every assemble:
//   - the view's mirror and the stream mirror hold the same snakes and prey;
//   - L8.snakeAdd: every live snake with a pulled point in a kept sector is held; L8.snake: a held snake with none is
//     removed (code 0) at the first assemble 4400 ms or more after it was first found without one, never sooner;
//   - prey held iff it lies in a kept sector; the client's foods in every kept sector equal the server's;
//   - L50: a death reaches every seat that held the snake as removal code 1 and no other seat; L41 own dead first;
//   - L40: kill_count only to the killer's own seat, with the sim's kill count;
//   - L9: rank = 1 + the snakes ahead by (sct, fam), myPos = rank when in the top 10; after the own death myPos 0;
//   - L10: the image the client holds equals a raster of every pulled body point at the current flux;
//   - L11: after every slow slot the seat's last z equals the current integer flux.
// Literals: L8.snake keepMs 4400; L9 period 3008.4, 10 rows; L10 size 136; L11.slow 1504.31; L7 42.67.

const test = require('node:test');
const assert = require('node:assert/strict');

const { runWorld } = require('./slViewHarness');

const KEEP_MS = 4400; // L8.snake
const P = 42.67; // L7
const ROWS = 10; // L9
const N = 136; // L10 size
const SLOW = 1504.31; // L11.slow
const C = 32550; // L1

function rankOf(sim, id) {
  let r = 1;
  const me = sim.snake(id);
  sim.forEachSnake((s) => {
    const a = s.pts.length;
    const b = me.pts.length;
    if (a > b || (a === b && (s.fam > me.fam || (s.fam === me.fam && s.id < me.id)))) r++;
  });
  return r;
}

function rasterOf(sim) {
  const bits = new Uint8Array(N * N);
  const flux = sim.flux();
  sim.forEachSnake((s) => {
    for (const p of s.pts) {
      const x = Math.floor(67.5 * (1 + (p.xx - C) / flux));
      const y = Math.floor(67.5 * (1 + (p.yy - C) / flux));
      if (x >= 0 && x < N && y >= 0 && y < N) bits[y * N + x] = 1;
    }
  });
  return bits;
}

function check(cfg) {
  const problems = [];
  const fail = (what) => {
    if (problems.length < 30) problems.push(what);
  };
  const unseen = new Map(); // seat rec -> Map snake id -> ms first found without a pulled point in a kept sector
  const seen = { retentionRemovals: 0, deathRemovals: 0, kills: 0, lbs: 0, mms: 0, slowSlots: 0, foodChecks: 0, prey: 0,
    ownDeaths: 0, lingerKept: 0 };
  let slowDue = SLOW;
  const slotDone = new Set();
  const slotTicks = new Set();
  let wakes = 0;
  const out = runWorld(Object.assign({}, cfg, {
    onAssemble({ sim, view, rec, entries, res, before, logs }) {
      const seat = rec.seat;
      const mir = view.mirror(seat);
      const sm = rec.mirror;
      const now = sim.nowMs();
      const where = 'seed ' + cfg.seed + ' tick ' + sim.tick() + ' own ' + rec.own + ': ';
      // the two mirrors agree
      const a = mir.snakes.slice().sort((x, y) => x - y).join(',');
      const b = Array.from(sm.snakes.keys()).sort((x, y) => x - y).join(',');
      if (a !== b) fail(where + 'view holds [' + a + '] but the stream gave [' + b + ']');
      const pa = mir.prey.slice().sort((x, y) => x - y).join(',');
      const pb = Array.from(sm.prey).sort((x, y) => x - y).join(',');
      if (pa !== pb) fail(where + 'view prey [' + pa + '] but the stream gave [' + pb + ']');
      // L8.snakeAdd and L8.snake
      const kept = new Set(mir.kept);
      seen.lingerKept += mir.lingering.length;
      const grid = sim.grid;
      const watched = (id) => {
        for (const si of kept) if (grid.countIn(si, id) > 0) return true;
        return false;
      };
      sim.forEachSnake((s) => {
        if (watched(s.id) && !mir.snakes.includes(s.id)) fail(where + 'snake ' + s.id + ' has a point in a kept sector but is not held');
      });
      let u = unseen.get(rec);
      if (!u) unseen.set(rec, (u = new Map()));
      const removedNow = new Set(res.events.filter((e) => e.type === 'snake_remove' && !e.kill).map((e) => e.id));
      for (const id of before.snakes) {
        const s = sim.snake(id);
        if (!s || id === rec.own) {
          u.delete(id);
          continue;
        }
        if (watched(id)) {
          if (removedNow.has(id)) fail(where + 'snake ' + id + ' removed while a pulled point is kept');
          u.delete(id);
          continue;
        }
        if (!u.has(id)) u.set(id, now);
        const since = now - u.get(id);
        if (removedNow.has(id)) {
          seen.retentionRemovals++;
          if (since < KEEP_MS) fail(where + 'snake ' + id + ' removed after ' + since + ' ms unwatched');
          u.delete(id);
        } else if (since >= KEEP_MS) {
          fail(where + 'snake ' + id + ' unwatched ' + since + ' ms but still held');
        }
      }
      // prey by sector
      if (sim.preys) {
        sim.preys.forEachPrey((p) => {
          const inKept = kept.has(grid.sectorAt(p.x, p.y));
          if (inKept !== mir.prey.includes(p.id)) fail(where + 'prey ' + p.id + ' in kept ' + inKept + ' but held ' + !inKept);
          if (inKept) seen.prey++;
        });
      }
      // foods: every kept sector holds on the client exactly what it holds on the server (every 20th wake)
      if (wakes % 20 === 0 && sim.food) {
        seen.foodChecks++;
        const server = new Set();
        for (const si of kept) grid.forEachFoodIn(si, (id) => server.add(id));
        for (const id of server) if (!sm.foods.has(id)) { fail(where + 'food ' + id + ' missing on the client'); break; }
        for (const id of sm.foods) if (!server.has(id)) { fail(where + 'ghost food ' + id + ' on the client'); break; }
      }
      // deaths: removal code 1 to every holder, nothing to others; the own dead first (L41, L50)
      for (const l of logs) {
        for (const d of l.deaths) {
          const rm = res.events.findIndex((e) => e.type === 'snake_remove' && e.id === d.id && e.kill === true);
          if (before.snakes.includes(d.id)) {
            if (rm < 0) fail(where + 'held snake ' + d.id + ' died but no removal code 1');
            seen.deathRemovals++;
            if (d.id === rec.own) {
              seen.ownDeaths++;
              if (rm < 1 || res.events[rm - 1].type !== 'dead') fail(where + 'own removal not right after dead');
            }
          } else if (rm >= 0) {
            fail(where + 'removal code 1 for snake ' + d.id + ' the seat did not hold');
          }
          // L40: the killer's own seat only
          const k = res.events.find((e) => e.type === 'kill_count');
          if (d.killer === rec.own && !seat.gone) {
            const ks = sim.snake(d.killer);
            if (!k) fail(where + 'kill by the own snake without kill_count');
            else if (ks && k.count !== ks.kills) fail(where + 'kill_count ' + k.count + ' not ' + ks.kills);
            seen.kills++;
          }
        }
      }
      if (res.events.some((e) => e.type === 'kill_count') && !logs.some((l) => l.deaths.some((d) => d.killer === rec.own))) {
        fail(where + 'kill_count without a kill by the own snake');
      }
      // L9: rank and myPos
      for (let i = 0; i < res.events.length; i++) {
        const e = res.events[i];
        if (e.type !== 'leaderboard' || entries[i].tick !== sim.tick()) continue; // made at an earlier step of the wake
        seen.lbs++;
        if (e.count !== sim.count()) fail(where + 'count ' + e.count + ' not ' + sim.count());
        if (e.rows.length !== Math.min(ROWS, sim.count())) fail(where + 'rows ' + e.rows.length);
        for (let i = 1; i < e.rows.length; i++) {
          const p = e.rows[i - 1];
          const q = e.rows[i];
          if (p.sct < q.sct || (p.sct === q.sct && p.fam < q.fam)) fail(where + 'rows out of order');
        }
        if (!seat.gone && sim.snake(rec.own)) {
          const r = rankOf(sim, rec.own);
          if (e.rank !== r) fail(where + 'rank ' + e.rank + ' not ' + r);
          if (e.myPos !== (r <= ROWS ? r : 0)) fail(where + 'myPos ' + e.myPos + ' at rank ' + r);
        } else if (e.myPos !== 0) {
          fail(where + 'myPos ' + e.myPos + ' with the own snake gone');
        }
      }
      // L10: the client's image is the raster of every pulled point (one tick per wake only)
      if (cfg.wakeMax === 1 && res.events.some((e) => e.type === 'minimap')) {
        seen.mms++;
        const bits = rasterOf(sim);
        for (let i = 0; i < bits.length; i++) {
          if (bits[i] !== sm.mm[i]) {
            fail(where + 'minimap pixel ' + i + ' is ' + sm.mm[i] + ' not ' + bits[i]);
            break;
          }
        }
      }
      // at most one own move per bundle on a one-tick wake (L7)
      if (cfg.wakeMax === 1 && res.events.filter((e) => e.type === 'snake_move' && e.own).length > 1) fail(where + 'two own moves');
      // L11: after a slow slot (fired at the wake's last tick) every seat that joined before it holds the current flux
      for (const l of logs) {
        if (slotDone.has(l.tick)) continue;
        slotDone.add(l.tick);
        const ms = l.tick * P;
        if (ms >= slowDue) {
          slotTicks.add(l.tick);
          seen.slowSlots++;
          while (slowDue <= ms) slowDue += SLOW;
        }
      }
      const lastT = logs.length ? logs[logs.length - 1].tick : -1;
      if (slotTicks.has(lastT) && rec.joinTick < lastT && sm.lastFlux !== sim.flux()) {
        fail(where + 'after the slow slot the client holds z ' + sm.lastFlux + ', flux is ' + sim.flux());
      }
    },
    onWake() {
      wakes++;
    },
  }));
  return { out, problems, seen };
}

test('slView parity: one-tick wakes, 16 snakes, 4 seats, 4000 ticks', () => {
  const { out, problems, seen } = check({ seed: 11, ticks: 4000, snakes: 16, seats: 4, wakeMax: 1 });
  const stream = out.seats.flatMap((s) => s.mirror.problems);
  assert.deepEqual(stream.slice(0, 10), []);
  assert.deepEqual(problems.slice(0, 10), []);
  assert.ok(out.seats.length > 4, 'seats were replaced');
  assert.ok(seen.retentionRemovals > 0 && seen.deathRemovals > 0 && seen.ownDeaths > 0, JSON.stringify(seen));
  assert.ok(seen.lbs > 100 && seen.mms > 50 && seen.foodChecks > 50 && seen.lingerKept > 0, JSON.stringify(seen));
});

test('slView parity: catch-up wakes of 1 to 3 ticks, 40 snakes (moving border), 4 seats, 4000 ticks', () => {
  const { out, problems, seen } = check({ seed: 12, ticks: 4000, snakes: 40, seats: 4, wakeMax: 3 });
  const stream = out.seats.flatMap((s) => s.mirror.problems);
  assert.deepEqual(stream.slice(0, 10), []);
  assert.deepEqual(problems.slice(0, 10), []);
  assert.ok(out.sim.flux() > 2923, 'the border grew (z changes)');
  assert.ok(out.seats.some((s) => s.mirror.fluxCount > 3), 'z went out more than once');
  assert.ok(seen.retentionRemovals > 0 && seen.deathRemovals > 0, JSON.stringify(seen));
});

test('slView parity: one-tick wakes, 40 snakes, prey on, 3 seeds of 2500 ticks', () => {
  let prey = 0;
  let kills = 0;
  for (const seed of [21, 22, 23]) {
    const { out, problems, seen } = check({ seed, ticks: 2500, snakes: 40, seats: 4, wakeMax: 1 });
    const stream = out.seats.flatMap((s) => s.mirror.problems);
    assert.deepEqual(stream.slice(0, 10), [], 'seed ' + seed);
    assert.deepEqual(problems.slice(0, 10), [], 'seed ' + seed);
    prey += seen.prey;
    kills += seen.kills;
  }
  assert.ok(prey > 0, 'a seat held prey');
  assert.ok(kills > 0, 'an own snake killed one');
});
