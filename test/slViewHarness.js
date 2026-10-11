'use strict';
// Shared driver for the slView tests (task T8). TEST ONLY (it reads the FIXTURE table). No test runs here: node --test
// loads every .js under test/, and this file only defines functions.
//
// runWorld(opts) drives a world sim (border, food, prey, fill) with scripted inputs, a view and N seats, assembling
// every seat after every wake (a wake is 1 to opts.wakeMax ticks), and feeds every seat's decoded bundle to a STREAM
// MIRROR: an event-level copy of what their client would hold (snakes by id with the last point's iang, foods by
// their client id, prey by id, the minimap bits, the last z, the death). The mirror records a problem string for
// every record that their client could not have been sent:
//   - a kind-15 number or a number off its wire grid (slRecordCache.scanBundle), a wire_error;
//   - a never-sent type (SERVER-DESIGN 8.4), a food_eat other than '<';
//   - a record for a snake, food or prey the client does not hold (ghosts), a second add of one it holds;
//   - a move form other than the law's (L48.move angle form iff iang changed, L48.abs only on the sim's first point),
//     more than one move of a snake for one tick, a rotation field set outside the seven legal ones, dir not 1 or 2;
//   - a wire fam above 1; the own dead not followed by the own removal code 1 (L41); a minimap after the own dead;
//   - a snake_add with fewer than 2 points or not ending angle-coded; an eat before its eater's add in one bundle.
// Each case's server-side checks run in the test file through opts.onAssemble.

const { createSim } = require('../server/sl/slSim');
const { createView, bundleOf, NEVER_SENT } = require('../server/sl/slView');
const { scanBundle, encodeRecord } = require('../server/sl/slRecordCache');
const { createRng } = require('../server/sl/slRng');
const { FIXTURE } = require('./slLawsFixture');

const PV = 19; // L6 protocol
const ROT_FIELDS = ['dir', 'ang', 'wang', 'sp'];

function foodId(sx, sy, rx, ry) {
  return (sx << 24) | (sy << 16) | (rx << 8) | ry;
}

// ------------------------------------------------------------------ the stream mirror (one per seat)

function createMirror(expectOwn) {
  const m = {
    expectOwn,
    started: false,
    ownId: 0,
    snakes: new Map(), // id -> { iang }
    foods: new Set(),
    prey: new Set(),
    mm: null, // Uint8Array of the client's minimap bits (136 x 136)
    mmCount: 0,
    lastFlux: null,
    fluxCount: 0,
    dead: false,
    deadRank: null,
    killCount: 0,
    lbCount: 0,
    lastLb: null,
    problems: [],
  };
  return m;
}

function bad(m, where, what) {
  if (m.problems.length < 50) m.problems.push(where + ': ' + what);
}

// Applies one seat bundle. ctx: { tick (last tick of the wake), absAt (tick -> Set of ids whose move was absolute),
// iangAt (tick -> Map id -> server iang of the move), mmSize }.
function applyBundle(m, entries, ctx) {
  const bytes = bundleOf(entries);
  const sc = scanBundle(bytes);
  const where = 'tick ' + ctx.tick + ' seat own ' + m.expectOwn;
  if (sc.wireError) bad(m, where, 'wire_error ' + JSON.stringify(sc.wireError));
  if (sc.kind15.length) bad(m, where, 'kind 15 ' + JSON.stringify(sc.kind15.slice(0, 3)));
  if (sc.offGrid.length) bad(m, where, 'off grid ' + JSON.stringify(sc.offGrid.slice(0, 3)));
  const evs = sc.events;
  if (evs.length !== entries.length) bad(m, where, 'decoded ' + evs.length + ' events from ' + entries.length + ' records');
  const movedAt = new Map(); // `${tick}:${id}` -> count
  const addedHere = new Set();
  const preyAddedHere = new Set();
  let expectOwnRemove = false;
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    const t = entries[i] ? entries[i].tick : ctx.tick;
    const w = where + ' #' + i + ' ' + ev.type;
    if (NEVER_SENT.indexOf(ev.type) >= 0) bad(m, w, 'never-sent type');
    // a snake or prey added in this bundle gets none of this bundle's other records (the add carries the state now)
    const subject = ev.type === 'snake_move' || ev.type === 'snake_rot' ? (ev.own ? m.ownId : ev.id)
      : ev.type === 'snake_fam' || ev.type === 'snake_tail' ? ev.id : 0;
    if (subject && addedHere.has(subject)) bad(m, w, 'record for snake ' + subject + ' after its add in the same bundle');
    if (ev.type === 'prey_move' && preyAddedHere.has(ev.id)) bad(m, w, 'prey move after its add in the same bundle');
    if (expectOwnRemove) {
      if (ev.type !== 'snake_remove' || ev.id !== m.ownId || ev.kill !== true) bad(m, w, 'own dead not followed by own removal code 1');
      expectOwnRemove = false;
    }
    if (!m.started) {
      if (ev.type !== 'init') bad(m, w, 'first record is not init');
      m.started = true;
      continue;
    }
    switch (ev.type) {
      case 'init':
        bad(m, w, 'second init');
        break;
      case 'snake_add': {
        if (m.ownId === 0) {
          m.ownId = ev.id;
          if (ev.id !== m.expectOwn) bad(m, w, 'first snake_add is ' + ev.id + ', not the own snake');
        }
        if (m.snakes.has(ev.id)) bad(m, w, 'second add of held snake ' + ev.id);
        const pts = ev.raw.pts;
        if (pts.length < 2) bad(m, w, 'fewer than 2 points');
        const last = pts[pts.length - 1];
        if (last.iang === undefined) bad(m, w, 'does not end angle-coded');
        if (!(ev.fam >= 0 && ev.fam <= 1)) bad(m, w, 'fam ' + ev.fam);
        m.snakes.set(ev.id, { iang: last.iang });
        addedHere.add(ev.id);
        break;
      }
      case 'snake_remove':
        if (!m.snakes.has(ev.id)) bad(m, w, 'removal of a snake not held ' + ev.id);
        m.snakes.delete(ev.id);
        break;
      case 'snake_move': {
        const id = ev.own ? m.ownId : ev.id;
        if (ev.own && m.dead) bad(m, w, 'own move after the own dead');
        if (!ev.own && id === m.ownId) bad(m, w, 'own snake move without the own flag');
        const sn = m.snakes.get(id);
        if (!sn) {
          bad(m, w, 'move of a snake not held ' + id);
          break;
        }
        const k = t + ':' + id;
        movedAt.set(k, (movedAt.get(k) || 0) + 1);
        if (movedAt.get(k) > 1) bad(m, w, 'two moves of snake ' + id + ' in tick ' + t);
        const abs = ev.cmd === '+' || ev.cmd === '=';
        const absSet = ctx.absAt.get(t);
        const serverAbs = !!(absSet && absSet.has(id));
        if (abs !== serverAbs) bad(m, w, 'absolute form ' + abs + ' but the sim point abs ' + serverAbs);
        const iangs = ctx.iangAt.get(t);
        const si = iangs ? iangs.get(id) : undefined;
        if (si === undefined) bad(m, w, 'no sim move for snake ' + id);
        if (abs) {
          if (ev.iang !== si) bad(m, w, 'absolute move iang ' + ev.iang + ' not ' + si);
        } else if (ev.iang !== undefined) {
          if (ev.iang === sn.iang) bad(m, w, 'angle form with an unchanged iang');
          if (ev.iang !== si) bad(m, w, 'angle form iang ' + ev.iang + ' not ' + si);
        } else if (si !== sn.iang) {
          bad(m, w, 'short form but the iang changed (' + sn.iang + ' -> ' + si + ')');
        }
        sn.iang = si;
        if (ev.fam !== undefined && !(ev.fam >= 0 && ev.fam <= 1)) bad(m, w, 'fam ' + ev.fam);
        break;
      }
      case 'snake_rot': {
        const id = ev.own ? m.ownId : ev.id;
        if (!m.snakes.has(id)) bad(m, w, 'rotation of a snake not held ' + id);
        if (!ev.own && id === m.ownId) bad(m, w, 'own rotation without the own flag');
        const keys = ROT_FIELDS.filter((f) => ev[f] !== undefined);
        if (keys.length === 0) bad(m, w, 'empty rotation record');
        if ((ev.dir !== undefined) !== (ev.wang !== undefined)) bad(m, w, 'illegal field set ' + keys.join('+'));
        if (ev.dir !== undefined && ev.dir !== 1 && ev.dir !== 2) bad(m, w, 'dir ' + ev.dir);
        break;
      }
      case 'snake_fam':
      case 'snake_tail':
        if (!m.snakes.has(ev.id)) bad(m, w, 'record of a snake not held ' + ev.id);
        if (ev.fam !== undefined && !(ev.fam >= 0 && ev.fam <= 1)) bad(m, w, 'fam ' + ev.fam);
        if (ev.type === 'snake_tail' && ev.fam === undefined) bad(m, w, 'r without fam');
        break;
      case 'food_sector':
        for (const f of ev.foods) {
          const id = foodId(ev.sx, ev.sy, f.rx, f.ry);
          if (m.foods.has(id)) bad(m, w, 'dump repeats a food the client holds');
          m.foods.add(id);
        }
        if (ev.foods.length === 0) bad(m, w, 'empty dump');
        break;
      case 'food_add': {
        if (ev.sectorFromLast || ev.cvFromLast) bad(m, w, 'short food form');
        const id = foodId(ev.sx, ev.sy, ev.rx, ev.ry);
        if (m.foods.has(id)) bad(m, w, 'food added twice');
        m.foods.add(id);
        break;
      }
      case 'food_eat': {
        if (ev.cmd !== '<') bad(m, w, 'food_eat ' + ev.cmd);
        const id = foodId(ev.sx, ev.sy, ev.rx, ev.ry);
        if (!m.foods.has(id)) bad(m, w, 'eat of a food the client does not hold');
        m.foods.delete(id);
        for (let j = i + 1; j < evs.length; j++) {
          if (evs[j].type === 'snake_add' && evs[j].id === ev.eater) bad(m, w, 'eat before its eater add');
        }
        break;
      }
      case 'sector_remove':
        for (const id of Array.from(m.foods)) if (((id >>> 24) & 255) === ev.sx && ((id >>> 16) & 255) === ev.sy) m.foods.delete(id);
        break;
      case 'prey_add':
        if (m.prey.has(ev.id)) bad(m, w, 'prey added twice');
        m.prey.add(ev.id);
        preyAddedHere.add(ev.id);
        break;
      case 'prey_move':
        if (!m.prey.has(ev.id)) bad(m, w, 'move of a prey not held');
        break;
      case 'prey_remove':
      case 'prey_eaten':
        if (!m.prey.has(ev.id)) bad(m, w, 'end of a prey not held');
        m.prey.delete(ev.id);
        break;
      case 'dead':
        if (ev.code !== 0) bad(m, w, 'dead code ' + ev.code);
        if (m.dead) bad(m, w, 'second dead');
        m.dead = true;
        expectOwnRemove = true;
        break;
      case 'leaderboard':
        m.lbCount++;
        m.lastLb = ev;
        if (m.dead) {
          if (ev.myPos !== 0) bad(m, w, 'myPos ' + ev.myPos + ' after the own dead');
          if (m.deadRank === null) m.deadRank = ev.rank;
          else if (ev.rank !== m.deadRank) bad(m, w, 'rank moved after the own dead');
        }
        for (const r of ev.rows) if (!(r.fam >= 0 && r.fam <= 1)) bad(m, w, 'row fam ' + r.fam);
        break;
      case 'minimap': {
        if (m.dead) bad(m, w, 'minimap after the own dead');
        const N = ctx.mmSize;
        const prev = m.mm;
        const next = new Uint8Array(N * N);
        if (ev.cmd === 'M') {
          for (const [x, y] of ev.pixels) next[y * N + x] = 1;
        } else if (ev.cmd === 'V') {
          if (!prev) bad(m, w, 'V before any M');
          else next.set(prev);
          for (const [x, y] of ev.toggles) next[y * N + x] ^= 1;
        } else {
          bad(m, w, 'minimap ' + ev.cmd);
        }
        // L10.mv: the chosen record is the smaller of M and the XOR against what the client held (equal: M)
        if (prev) {
          const px = [];
          const tg = [];
          for (let y = N - 1; y >= 0; y--) {
            for (let x = N - 1; x >= 0; x--) {
              if (next[y * N + x]) px.push([x, y]);
              if (next[y * N + x] !== prev[y * N + x]) tg.push([x, y]);
            }
          }
          const lm = encodeRecord({ type: 'minimap', cmd: 'M', raw: { size: N }, size: N, pixels: px }, false, PV).length;
          const lv = encodeRecord({ type: 'minimap', cmd: 'V', size: N, toggles: tg }, false, PV).length;
          const want = lv < lm ? 'V' : 'M';
          if (ev.cmd !== want) bad(m, w, 'minimap ' + ev.cmd + ' but ' + want + ' is smaller (' + lm + ' / ' + lv + ')');
        } else if (ev.cmd !== 'M') {
          bad(m, w, 'first minimap is not M');
        }
        m.mm = next;
        m.mmCount++;
        break;
      }
      case 'flux':
        if (m.lastFlux !== null && ev.fluxGrd === m.lastFlux) bad(m, w, 'z repeats ' + ev.fluxGrd);
        m.lastFlux = ev.fluxGrd;
        m.fluxCount++;
        break;
      case 'kill_count':
        if (ev.id !== m.ownId) bad(m, w, 'kill_count for another snake');
        if (m.dead) bad(m, w, 'kill_count after the own dead');
        m.killCount = ev.count;
        break;
      case 'pong':
        break;
      default:
        bad(m, w, 'unexpected type');
    }
  }
  if (expectOwnRemove) bad(m, where, 'own dead is the last record');
  return { events: evs, bytes, addedHere };
}

// ------------------------------------------------------------------ the scripted world

// opts: seed, ticks, snakes (live target), seats, wakeMax (ticks per wake, 1 = one view per tick), laws, onAssemble
// (ctx) called after each seat's assemble, onWake (ctx) after each wake, leaveAfter (ticks a dead seat stays).
function runWorld(opts) {
  const o = Object.assign({ seed: 1, ticks: 1000, snakes: 16, seats: 4, wakeMax: 1, laws: FIXTURE, leaveAfter: 60 }, opts);
  const sim = createSim(o.laws, { seed: o.seed, world: true });
  const view = createView(o.laws, sim);
  const r = createRng((o.seed * 2654435761 + 12345) >>> 0);
  const N = view.V.mmSize;
  const live = []; // snake ids the script drives (bots and seats alike)
  for (let k = 0; k < o.snakes; k++) live.push(sim.spawn({ cv: (k * 7) % 66, nick: 'n' + k }).id);
  const seats = []; // { seat, mirror, own, goneAt, joinTick, bundles }
  function joinSeat(own) {
    const j = view.join(own);
    const mirror = createMirror(own);
    const ctx = { tick: sim.tick(), absAt: new Map(), iangAt: new Map(), mmSize: N };
    const res = applyBundle(mirror, j.entries, ctx);
    const rec = { seat: j.seat, mirror, own, goneAt: -1, joinTick: sim.tick(), joinMs: sim.nowMs(), bundles: 1, join: j, joinRes: res };
    seats.push(rec);
    if (o.onJoin) o.onJoin({ sim, view, rec, entries: j.entries, res });
    return rec;
  }
  for (let k = 0; k < o.seats && k < live.length; k++) joinSeat(live[k]);
  const absAt = new Map();
  const iangAt = new Map();
  let t = 0;
  while (t < o.ticks) {
    const k = o.wakeMax > 1 ? 1 + r.int(o.wakeMax) : 1;
    const logs = [];
    for (let s = 0; s < k && t < o.ticks; s++, t++) {
      // respawns (before the step, so the state an assemble sees is the state right after the last step)
      for (let i = 0; i < live.length; i++) {
        if (!sim.snake(live[i]) && r.next() < 0.05) live[i] = sim.spawn({ cv: r.int(66), nick: 'r' + i }).id;
      }
      // inputs for every live snake (angle, boost, arrow), rare disconnect kills and leaves; respawns keep the count
      for (let i = 0; i < live.length; i++) {
        const id = live[i];
        if (!sim.snake(id)) continue;
        const u = r.next();
        const off = r.int(43);
        if (u < 0.08) sim.setInput(id, { type: 'angle', q: r.int(251) }, off);
        else if (u < 0.105) sim.setInput(id, { type: 'boost', on: r.next() < 0.6 }, off);
        else if (u < 0.12) sim.setInput(id, { type: 'turn', dir: r.next() < 0.5 ? 'left' : 'right', v: 1 + r.int(30) }, off);
        else if (u < 0.1203) sim.kill(id);
        else if (u < 0.1205 && !seats.some((x) => x.own === id)) sim.remove(id);
      }
      sim.applyInputs();
      const log = sim.step();
      const abs = new Set();
      const iang = new Map();
      for (const u of log.updates) {
        if (u.move) {
          iang.set(u.id, u.iang);
          if (u.abs) abs.add(u.id);
        }
      }
      absAt.set(log.tick, abs);
      iangAt.set(log.tick, iang);
      view.tick(log);
      logs.push({ tick: log.tick, deaths: log.deaths.map((d) => ({ id: d.id, killer: d.killer })) });
    }
    for (const rec of seats) {
      if (rec.seat.left) continue;
      const before = view.mirror(rec.seat);
      const entries = view.assemble(rec.seat);
      const ctx = { tick: sim.tick(), absAt, iangAt, mmSize: N };
      const res = applyBundle(rec.mirror, entries, ctx);
      rec.bundles++;
      if (o.onAssemble) o.onAssemble({ sim, view, rec, entries, res, before, logs, wake: k });
    }
    view.endWake();
    if (o.onWake) o.onWake({ sim, view, seats, logs });
    // seats whose snake is gone leave after a while; a new snake joins in their place
    for (const rec of seats) {
      if (rec.seat.left) continue;
      if (rec.seat.gone && rec.goneAt < 0) rec.goneAt = sim.tick();
      if (rec.goneAt >= 0 && sim.tick() - rec.goneAt >= o.leaveAfter) view.leave(rec.seat);
    }
    const active = seats.filter((x) => !x.seat.left).length;
    if (active < o.seats) {
      const free = live.find((id) => sim.snake(id) && !seats.some((x) => !x.seat.left && x.own === id));
      if (free !== undefined) joinSeat(free);
    }
    for (const key of Array.from(absAt.keys())) if (key < sim.tick() - 4) absAt.delete(key);
    for (const key of Array.from(iangAt.keys())) if (key < sim.tick() - 4) iangAt.delete(key);
  }
  return { sim, view, seats };
}

module.exports = { runWorld, createMirror, applyBundle, foodId };
