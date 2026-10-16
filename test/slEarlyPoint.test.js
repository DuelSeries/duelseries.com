'use strict';
// The early point (turning smoothness, 2026-10-16; server/sl/slSnake.js travel and previewPoint, slSim previewPoint,
// slRoom _earlyPoints, slView earlyMove). Owen: "it turns and it's just not perfectly smooth when I'm turning left
// and right". Measured on the live room (frozen client at 240 Hz on his own replayed inputs): every new point reached
// the client 0 to 1 update late, the client put its head back on it, and the head was yanked 3.4 to 4.7 units back or
// forward on every point (along-track jump vs msl - v dt, corr 0.96); slither.io sends a point when the head reaches
// it (10,933 of 12,560 own points came with no rotation). The room now walks each update as PIECES straight pieces
// and sends the seat its own point at the end of the piece that reached it; the update then places exactly that point.

const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('../shared/slWire.js');
const { createSim } = require('../server/sl/slSim');
const slSnake = require('../server/sl/slSnake');
const slRoomMod = require('../server/sl/slRoom');
const { SlRoom } = slRoomMod;
const { FIXTURE, makeFixture } = require('./slLawsFixture');
const { fakeTimers, bareSocket } = require('./slNetFakes');

const PI2 = 2 * Math.PI;
const P = 42.67; // L7
const C = 32550; // L1 grd: the map centre

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Random steering inside each update window, fed in arrival order: at each piece end the records that arrived by then
// are in the slot, the point is worked out and committed as the room does, then the rest arrive and the update runs.
function drive(sim, s, updates, rnd, onUpdate) {
  const piece = P / slSnake.PIECES;
  let committed = 0;
  let placed = 0;
  for (let u = 0; u < updates; u++) {
    const recs = [];
    const n = Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) recs.push({ w: rnd() * P, q: Math.floor(rnd() * 251) });
    recs.sort((a, b) => a.w - b.w);
    let next = 0;
    let commit = null;
    for (let k = 1; k < slSnake.PIECES; k++) {
      const end = k * piece;
      // the room's whole-ms offsets (slRoom _steerOffsetNow): a record with window time w has offset round(P - w)
      for (; next < recs.length && P - Math.round(P - recs[next].w) <= end; next++) {
        sim.setInput(s.id, { type: 'angle', q: recs[next].q }, Math.round(P - recs[next].w));
      }
      if (commit) continue;
      const p = sim.previewPoint(s.id, end + 0.5);
      if (p) {
        assert.ok(sim.commitPoint(s.id, p));
        commit = p;
        committed++;
      }
    }
    for (; next < recs.length; next++) sim.setInput(s.id, { type: 'angle', q: recs[next].q }, Math.round(P - recs[next].w));
    sim.applyInputs();
    const log = sim.step();
    const rec = log.updates.find((r) => r.id === s.id);
    if (commit) {
      assert.ok(rec && rec.move, 'update ' + u + ': the committed point was placed');
      assert.equal(rec.iang, commit.iang, 'update ' + u + ': the update placed the point sent early');
      assert.equal(rec.grow, commit.grow, 'update ' + u + ': with the grow sent early');
      placed++;
    }
    if (onUpdate) onUpdate(rec, commit);
  }
  return { committed, placed };
}

test('early point: a point worked out before the update is exactly the one the update places (plain moves)', () => {
  const sim = createSim(FIXTURE, { seed: 3 });
  const s = sim.spawn({ x: C, y: C, ang: 0.3, cv: 3, fam: 0 });
  sim.applyInputs();
  sim.step(); // the first point after spawn is the absolute one (L48.abs): never early
  const rnd = mulberry32(11);
  let moves = 0;
  let early = 0;
  const r = drive(sim, s, 600, rnd, (rec, commit) => {
    if (rec && rec.move) moves++;
    if (commit) early++;
  });
  assert.equal(sim.commitStats.moved + sim.commitStats.grow + sim.commitStats.late, 0, JSON.stringify(sim.commitStats));
  assert.equal(r.committed, r.placed);
  // most points are reached before the last piece: about 3 in 4 go early
  assert.ok(early > 0.6 * moves && early < moves, 'early ' + early + ' of ' + moves + ' points');
});

test('early point: a sure grow goes early with its fam; an unsure one (fam near 1) waits for the update', () => {
  const sim = createSim(FIXTURE, { seed: 4 });
  const s = sim.spawn({ x: C, y: C, ang: 1.1, cv: 3, fam: 0 });
  sim.applyInputs();
  sim.step();
  s.fam = 40; // a long run of grows (no boost, so no L23 charge can take fam under 1 before the walk)
  const rnd = mulberry32(5);
  let grows = 0;
  drive(sim, s, 400, rnd, (rec, commit) => {
    if (commit && commit.grow) {
      grows++;
      assert.ok(Math.abs(commit.fam - rec.fam) < 1e-12, 'the early record carries the fam after the grow');
    }
  });
  assert.ok(grows > 20, 'grows sent early: ' + grows);
  assert.equal(sim.commitStats.grow, 0);
  // boosting with fam >= 1: a charge before the walk could make it a plain move, so nothing goes early
  s.fam = 1.2;
  s.boosting = true;
  assert.equal(sim.previewPoint(s.id, P), null);
  s.boosting = false;
  s.inBoost.push(1, 10); // a 253 waiting in the slot: same
  assert.equal(sim.previewPoint(s.id, P), null);
  s.inBoost.length = 0;
});

test('early point: one the walk did not reach (a lock dropped the window steering) still stands', () => {
  const sim = createSim(FIXTURE, { seed: 6 });
  const s = sim.spawn({ x: C, y: C, ang: 0, cv: 3, fam: 0 });
  sim.applyInputs();
  sim.step();
  // run straight until a window whose point is reached by its second piece, then turn hard early in that window
  let p = null;
  for (let u = 0; u < 200 && !p; u++) {
    const a = (s.ang + 1.5) % PI2;
    sim.setInput(s.id, { type: 'angle', q: Math.floor(a / PI2 * 251) % 251 }, 40);
    p = sim.previewPoint(s.id, 2 * P / slSnake.PIECES + 0.5);
    if (p) break;
    s.inSteer.length = 0; // not this window: go on straight
    sim.applyInputs();
    sim.step();
  }
  assert.ok(p, 'a point reached early');
  sim.commitPoint(s.id, p);
  slSnake.lockSteer(s, s.ang); // the glide lock (slRoom _simStep): the window's steering never applies
  const n0 = s.pts.length;
  sim.applyInputs();
  const rec = sim.step().updates.find((r) => r.id === s.id);
  assert.equal(rec.iang, p.iang, 'the point sent early is the one placed');
  assert.equal(s.pts.length, n0, 'a plain move');
  assert.equal(sim.commitStats.moved + sim.commitStats.late, 1, 'and it is counted');
});

function makeRoom() {
  const ft = fakeTimers(1000);
  const room = new SlRoom(makeFixture(), { seed: 7, clock: ft.clock, timers: ft.timers, autoTick: false,
    shippableOnly: false, prey: false, now: () => 1.7e12, log: { log() {}, warn() {}, error() {} } });
  return { ft, room };
}

// every own record the socket got, in order (own forms, and records that name the own snake by id: h, r)
function ownRecords(sock, from, id) {
  const out = [];
  for (const e of sock.emitted.slice(from)) {
    if (e.name !== 'sl:f') continue;
    for (const ev of W.decodeBundle(e.data)) if (ev.own || (id !== undefined && ev.id === id)) out.push(ev);
  }
  return out;
}

test('early point: the room sends the own point once, at the piece end, and not again with the update', () => {
  const { ft, room } = makeRoom();
  const sock = bareSocket();
  const seat = room.seat(sock, { nick: 'a', cv: 1 });
  const piece = room.P / slSnake.PIECES;
  const rnd = mulberry32(9);
  ft.advance(room.P);
  room.wake();
  ft.runImmediates();
  const s = room.sim.snake(seat.snakeId);
  let early = 0;
  let late = 0;
  let serverPts = 0;
  for (let u = 0; u < 300 && room.sim.snake(seat.snakeId); u++) {
    const t0 = room.stepRealAt;
    if (rnd() < 0.3) room.onInput(seat, W.encodeInput([{ type: 'angle', q: Math.floor(rnd() * 251) }]));
    ft.runImmediates();
    for (let k = 1; k < slSnake.PIECES; k++) {
      ft.advance(t0 + k * piece + 1 - ft.clock());
      const n0 = sock.emitted.length;
      room._earlyPoints();
      ft.runImmediates();
      const moves = ownRecords(sock, n0).filter((ev) => ev.type === 'snake_move');
      assert.ok(moves.length <= 1);
      early += moves.length;
    }
    ft.advance(t0 + room.P - ft.clock());
    const n1 = sock.emitted.length;
    room.wake();
    ft.runImmediates();
    const rec = room.sim.lastLog().updates.find((r) => r.id === s.id);
    const placed = !!(rec && rec.move);
    const moves = ownRecords(sock, n1).filter((ev) => ev.type === 'snake_move');
    if (moves.length) late++;
    if (placed) serverPts++;
  }
  assert.ok(early > 20, 'own points sent early: ' + early);
  assert.equal(early + late, serverPts,
    'each point the server placed went out exactly once (early ' + early + ', with the update ' + late + ', placed ' + serverPts + ')');
  assert.equal(room.sim.commitStats.moved + room.sim.commitStats.grow + room.sim.commitStats.late, 0);
  assert.equal(room.stats.early, early);
});

test('early point: owner switch off (sl:smooth:off) sends nothing early; a piece wake then does nothing', () => {
  const { ft, room } = makeRoom();
  const sock = bareSocket();
  room.seat(sock, { nick: 'a', cv: 1 });
  ft.advance(room.P);
  room.wake();
  try {
    assert.equal(slRoomMod.setSmooth(false), false);
    assert.equal(slRoomMod.smoothOn(), false);
    for (let u = 0; u < 20; u++) {
      ft.advance(room.P - 1);
      room._pieceWake();
      ft.advance(1);
      room.wake();
    }
    assert.equal(room.stats.early, 0);
    assert.equal(room.stats.pieceWakes, 0);
  } finally {
    slRoomMod.setSmooth(true);
  }
  assert.equal(slRoomMod.smoothOn(), true);
});

// Review finding (2026-10-16): a boost press after an early grow pays L23 charges before the walk. Two presses can take
// fam under 1: the grow sent early stands and the tail goes as a charge's does, with its r record; one press leaves
// the grow but moves fam, so the own seat gets that fam in a snake_fam record (its h and move were skipped).
function earlyGrowWindow(sim, s) {
  const K = sim.K;
  for (let u = 0; u < 400; u++) {
    let f = 1.2;
    for (let i = 0; i < 4; i++) f = 1 + slSnake.chargeHi(K, s.pts.length) * slSnake.famMult(K, s.pts.length, f) + 1e-9;
    s.fam = f; // just sure of the grow for ONE press (slSim previewPoint's bound)
    const p = sim.previewPoint(s.id, (slSnake.PIECES - 1) * P / slSnake.PIECES + 0.5);
    if (p && p.grow) return p;
    sim.applyInputs();
    sim.step();
  }
  return null;
}

test('early point: a grow sent early and then unaffordable (two boost presses) still ends with one body on every client', () => {
  const sim = createSim(FIXTURE, { seed: 8 });
  const s = sim.spawn({ x: C, y: C, ang: 0.4, cv: 3, sct: 30, fam: 0 });
  sim.applyInputs();
  sim.step();
  const p = earlyGrowWindow(sim, s);
  assert.ok(p, 'a grow reached early');
  sim.commitPoint(s.id, p);
  const n0 = s.pts.length;
  // 253, 254, 253 after the commit: two accepted presses, two first charges
  sim.setInput(s.id, { type: 'boost', on: true }, 6);
  sim.setInput(s.id, { type: 'boost', on: false }, 4);
  sim.setInput(s.id, { type: 'boost', on: true }, 2);
  sim.applyInputs();
  const rec = sim.step().updates.find((r) => r.id === s.id);
  assert.ok(rec.move && rec.grow, 'the grow sent early is the update\'s too');
  assert.equal(rec.iang, p.iang);
  assert.ok(s.fam >= 0 && s.fam < 1, 'fam ' + s.fam);
  assert.equal(s.pts.length, n0, 'the grow kept the tail and the repair took one: same length as a plain move');
  assert.equal(rec.tails[rec.tails.length - 1], s.fam, 'the r record carries the fam the snake ends on');
  assert.equal(sim.check().length, 0, sim.check().join('; '));
});

test('early point: one press after an early grow: the own seat gets the fam the update ended on', () => {
  const { ft, room } = makeRoom();
  const sock = bareSocket();
  const seat = room.seat(sock, { nick: 'a', cv: 1 });
  ft.advance(room.P);
  room.wake();
  ft.runImmediates();
  const s = room.sim.snake(seat.snakeId);
  const K = room.sim.K;
  const piece = room.P / slSnake.PIECES;
  let sent = null;
  for (let u = 0; u < 400 && !sent; u++) {
    const t0 = room.stepRealAt;
    s.fam = 1.5; // a grow at every point; not boosting, so sure of it
    s.famSent = s.fam;
    for (let k = 1; k < slSnake.PIECES && !sent; k++) {
      ft.advance(t0 + k * piece + 1 - ft.clock());
      const n0 = sock.emitted.length;
      room._earlyPoints();
      ft.runImmediates();
      const mv = ownRecords(sock, n0).find((ev) => ev.type === 'snake_move');
      if (mv) sent = mv;
    }
    if (!sent) {
      ft.advance(t0 + room.P - ft.clock());
      room.wake();
      ft.runImmediates();
    }
  }
  assert.ok(sent && sent.fam !== undefined, 'an early grow with its fam');
  const n1 = sock.emitted.length;
  room.onInput(seat, W.encodeInput([{ type: 'boost', on: true }])); // one press: a charge before the walk
  ft.runImmediates();
  ft.advance(room.stepRealAt + room.P - ft.clock());
  room.wake();
  ft.runImmediates();
  let fam = sent.fam;
  for (const ev of ownRecords(sock, n1, seat.snakeId)) if (ev.fam !== undefined) fam = ev.fam;
  const want = require('../server/sl/slQuant').fam24(Math.min(1, s.famSent), K.famRound !== undefined ? K.famRound : makeFixture()['L17.famRound'].value).v;
  assert.notEqual(fam, sent.fam, 'the charge moved fam');
  assert.equal(fam, want, 'the client ends on the server fam');
});
