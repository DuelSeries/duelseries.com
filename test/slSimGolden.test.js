'use strict';
// slSimGolden (SERVER-DESIGN 18.2 item 5; task T6): 3 seeds x 5000 ticks of scripted input on the FIXTURE table with
// the whole world on (border, food, prey, fill), hashed per 100 ticks: a sha256 of every record the sim logs in those
// ticks (updates, boost drops, deaths and their drops, food adds and eats, prey adds, moves, removes and eats, the
// flux) and sim.digest() at the window end. Any change to what the sim does shows up here.
//
// Re-cut ONLY with a law-table change or a reviewed sim change: SL_SIM_GOLDEN_CUT=1 node --test test/slSimGolden.test.js
// (T8 extends the windows with 4 seats' bundles once slView exists; that is a re-cut too.)

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { createSim } = require('../server/sl/slSim');
const { createRng } = require('../server/sl/slRng');
const { FIXTURE } = require('./slLawsFixture');

const GOLDEN = path.join(__dirname, 'slSimGolden.json');
const SEEDS = [1, 2, 3];
const TICKS = 5000;
const EVERY = 100;
const SLOTS = 12;

function j(...xs) {
  return xs.map(String).join(',');
}

function hashTick(h, sim, log) {
  h.update('T' + log.tick + ':' + sim.flux() + '\n');
  for (const u of log.updates) {
    h.update('u' + j(u.id, u.h, u.hFam, u.tails.join('/'), u.turning, u.move, u.moves, u.grow, u.abs, u.xx, u.yy, u.iang,
      u.fam) + '\n');
  }
  for (const d of log.drops) h.update('b' + j(d.id, d.x, d.y, d.b, d.cv, d.food ? d.food.id : 'x') + '\n');
  for (const d of log.deaths) {
    h.update('d' + j(d.id, d.cause, d.killer, d.headOn, d.x, d.y, d.sct, d.fam, d.cv, d.drops.length) + '\n');
    for (const q of d.drops) h.update('q' + j(q.x, q.y, q.b, q.cv, q.food ? q.food.id : 'x') + '\n');
  }
  const ft = sim.food.tick;
  for (const f of ft.adds) h.update('f' + j(f.id, f.b, f.cv, f.nat) + '\n');
  for (const e of ft.eats) h.update('e' + j(e.food.id, e.eater) + '\n');
  const pt = sim.preys.tick;
  for (const p of pt.adds) h.update('pa' + j(p.id, p.x, p.y, p.b, p.cv, p.ang) + '\n');
  for (const ev of pt.moves) h.update('pm' + j(ev.id, ev.xx, ev.yy, ev.dir, ev.ang, ev.wang, ev.sp) + '\n');
  for (const r of pt.removes) h.update('pr' + r.id + '\n');
  for (const e of pt.eats) h.update('pe' + j(e.id, e.eater) + '\n');
}

// The script: SLOTS snakes on the L42 rings; per live snake per tick an angle byte (10 percent), a boost press or
// release (3 percent), arrow ticks (2 percent), a disconnect kill (0.05 percent), a leave (0.03 percent); slot 0 holds
// Q every 400 ticks with the C_HOLD_RAMP shape, every other hold to the 3 s cash-out (removed), the others released
// after 30 ticks; a dead or gone slot respawns with chance 5 percent per tick. Slot 1 steers its angle byte at the
// nearest prey instead of a random one (task T14b: with random angles the 3 seeds ate 1 prey before the boost timeline
// change and 0 after it, too thin for the coverage line below).
// The L15 angle byte nearest the heading from the snake's head to the nearest prey (a random byte with no prey).
function preyByte(sim, id, r) {
  const s = sim.snake(id);
  const hx = s.pts[s.pts.length - 1].xx;
  const hy = s.pts[s.pts.length - 1].yy;
  let best = null;
  let bd = Infinity;
  sim.preys.forEachPrey((p) => {
    const d = (p.x - hx) * (p.x - hx) + (p.y - hy) * (p.y - hy);
    if (d < bd) {
      bd = d;
      best = p;
    }
  });
  if (!best) return r.int(251);
  let a = Math.atan2(best.y - hy, best.x - hx);
  if (a < 0) a += 2 * Math.PI;
  return Math.round(a / (2 * Math.PI) * 251) % 251;
}

function run(seed, ticks) {
  const sim = createSim(FIXTURE, { seed, world: true });
  const r = createRng((seed * 2654435761) >>> 0);
  const slots = [];
  for (let k = 0; k < SLOTS; k++) slots.push(sim.spawn({ cv: (k * 11) % 66, nick: 'g' + k }).id);
  const out = [];
  const seen = { snake: 0, border: 0, kill: 0, headOn: 0, eats: 0, preyEats: 0, preyMoves: 0, boostDrops: 0, held: 0 };
  let h = crypto.createHash('sha256');
  let holdFrom = -1;
  for (let t = 0; t < ticks; t++) {
    for (let i = 0; i < slots.length; i++) {
      const id = slots[i];
      if (!sim.snake(id)) {
        if (r.next() < 0.05) slots[i] = sim.spawn({ cv: r.int(66), nick: 'g' + i }).id;
        continue;
      }
      const off = r.int(43);
      const u = r.next();
      if (u < 0.1) sim.setInput(id, { type: 'angle', q: i === 1 ? preyByte(sim, id, r) : r.int(251) }, off);
      else if (u < 0.13) sim.setInput(id, { type: 'boost', on: r.next() < 0.6 }, off);
      else if (u < 0.15) sim.setInput(id, { type: 'turn', dir: r.next() < 0.5 ? 'left' : 'right', v: 1 + r.int(30) }, off);
      else if (u < 0.1505) sim.kill(id);
      else if (u < 0.1508) sim.remove(id);
    }
    sim.applyInputs(); // step 1, then the hold (step 2), as the room runs them (SERVER-DESIGN 5.3)
    if (sim.snake(slots[0])) {
      if (holdFrom < 0 && t % 400 === 50) holdFrom = t;
      if (holdFrom >= 0) {
        const ms = (t - holdFrom) * 42.67;
        const completes = Math.floor(holdFrom / 400) % 2 === 0; // every other hold runs to the cash-out
        if (ms >= 3000 && completes) {
          sim.remove(slots[0]); // cashed out: gone with no drops (C_CASHOUT_CODE)
          holdFrom = -1;
        } else if (!completes && t - holdFrom >= 30) {
          sim.setHold(slots[0], null);
          holdFrom = -1;
        } else {
          sim.setHold(slots[0], Math.max(0.2, 1 - 0.8 * ms / 3000), t % 43);
        }
      }
    } else {
      holdFrom = -1;
    }
    if (holdFrom >= 0) seen.held++;
    const log = sim.step();
    hashTick(h, sim, log);
    for (const d of log.deaths) {
      seen[d.cause]++;
      if (d.headOn) seen.headOn++;
    }
    seen.boostDrops += log.drops.length;
    seen.eats += sim.food.tick.eats.length;
    seen.preyEats += sim.preys.tick.eats.length;
    seen.preyMoves += sim.preys.tick.moves.length;
    if ((t + 1) % EVERY === 0) {
      out.push(h.digest('hex').slice(0, 16) + ' ' + sim.digest());
      h = crypto.createHash('sha256');
      const problems = sim.check();
      assert.equal(problems.length, 0, 'seed ' + seed + ' tick ' + t + ': ' + problems.slice(0, 3).join('; '));
    }
  }
  return { out, sim, seen };
}

const CUT = process.env.SL_SIM_GOLDEN_CUT === '1';

test('slSimGolden: 3 seeds x 5000 ticks, hash per 100 ticks, equal to the cut', () => {
  const now = {};
  const all = {};
  for (const seed of SEEDS) {
    const r = run(seed, TICKS);
    now[seed] = r.out;
    for (const k of Object.keys(r.seen)) all[k] = (all[k] || 0) + r.seen[k];
  }
  if (CUT) {
    const body = { what: 'slSim world golden: sha256 of the tick logs per 100 ticks (16 hex) and sim.digest() at the window end',
      ticks: TICKS, every: EVERY, slots: SLOTS, seeds: now };
    fs.writeFileSync(GOLDEN, JSON.stringify(body, null, 1) + '\n');
  } else {
    const g = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.equal(g.ticks, TICKS);
    assert.equal(g.every, EVERY);
    for (const seed of SEEDS) {
      const want = g.seeds[seed];
      const got = now[seed];
      assert.equal(got.length, want.length, 'seed ' + seed + ' windows');
      for (let i = 0; i < want.length; i++) {
        assert.ok(got[i] === want[i], 'seed ' + seed + ' differs first at ticks ' + (i * EVERY + 1) + ' to ' +
          ((i + 1) * EVERY) + ': ' + got[i] + ' (golden ' + want[i] + ')');
      }
    }
  }
  // the script reaches every part of the world half (cut 2026-10-11, task T14b: snake 64, border 83, kill 84, headOn 10
  // deaths, 18 prey eats; printed by the cut run)
  assert.ok(all.snake > 20 && all.border > 20 && all.kill > 5 && all.headOn > 0, JSON.stringify(all));
  assert.ok(all.eats > 5000 && all.boostDrops > 500 && all.preyMoves > 100 && all.preyEats > 0 && all.held > 100,
    JSON.stringify(all));
  if (CUT) console.log('slSimGolden coverage ' + JSON.stringify(all));
});
