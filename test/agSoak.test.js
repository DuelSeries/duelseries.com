'use strict';
// agar.io soak (build brief 9.3 agSoak card), on the FIXTURE law table and on the real (approved) table: one scripted
// human plus the room's bots for 20,000 ticks each. Every tick: no NaN; every centre inside the border by the L3 rule
// (food inside the border; a piece of a player with 2+ cells may end a tick less than its own size past its box,
// since the own-cell push runs after the border step, measured);
// the mass ledger closes (live mass = created minus every destroyed cause); no id is ever used twice; every eaten
// id is removed in the same bundle (U_EAT_REMOVE 'sameBundle'); and the human's decoded stream stays consistent
// with a client model (eats and removals name only cells it holds, and every own cell's id is announced before the
// first world or sync record that carries it, checked as each record arrives).
// The script plays, splits, ejects, dies, respawns, spectates, backs up its socket and leaves and comes back.
// Rooms are never compared with assert.strictEqual (Paper lesson 12): only numbers and ids are.
const test = require('node:test');
const assert = require('node:assert');
const W = require('../shared/agWire');
const { AgRoom } = require('../server/ag/agRoom');
const { FIXTURE } = require('./agLawsFixture');
const { LAWS } = require('../server/ag/agLaws');

const TICKS = 20000;
const quiet = { error() {}, warn() {}, log() {} };

function soak(laws, label) {
  const room = new AgRoom({ laws, shippableOnly: laws === LAWS, seed: 2026, autoTick: false, log: quiet });
  const sim = room.sim;
  const k = laws.L3.value.radiusFactor;
  const depth = laws.WIRE_BACKLOG.value;

  // Capture each step's events.
  let ev = null;
  const step = sim.step;
  sim.step = () => { ev = step(); return ev; };

  const bundles = [];
  const sock = { id: 'human', conn: { writeBuffer: [] }, emit(e, buf) { assert.strictEqual(e, 'ag:f'); bundles.push(buf); } };

  // Client model of what the human's page holds.
  const known = new Set();
  const announced = new Set();
  const counts = { eats: 0, merges: 0, deaths: 0, spawns: 0, splits: 0, ejects: 0, syncs: 0, cams: 0, boards: 0, clears: 0,
    maxPushOut: 0 };
  // own: the human's cell ids in the sim after this tick (the bundle was built from that state).
  let ownFirsts = 0;
  function applyBundle(buf, own) {
    const recs = W.decodeBundle(buf);
    for (const r of recs) {
      assert.notStrictEqual(r.t, 'error', 'bundle decodes');
      if (r.t === 'clearAll') { known.clear(); announced.clear(); counts.clears++; continue; }
      if (r.t === 'own') { announced.add(r.id); continue; }
      if (r.t === 'cam') { counts.cams++; assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y) && r.zoom > 0); continue; }
      if (r.t === 'board') { counts.boards++; continue; }
      if (r.t !== 'world' && r.t !== 'sync') continue;
      const removed = new Set(r.removed);
      for (const [eater, eaten] of r.eats) {
        assert.ok(known.has(eater) && known.has(eaten), 'an eat names cells the client holds');
        assert.ok(removed.has(eaten), 'eaten id ' + eaten + ' removed in the same bundle');
        counts.eats++;
      }
      for (const c of r.cells) {
        assert.ok(Number.isInteger(c.x) && Number.isInteger(c.y) && Number.isInteger(c.size) && c.id !== 0);
        if (!known.has(c.id)) {
          assert.ok(c.rgb, 'a new cell carries its colour');
          if (own.has(c.id)) {
            assert.ok(announced.has(c.id), 'own id ' + c.id + ' announced before the first record with its cell');
            ownFirsts++;
          }
        }
      }
      for (const id of r.removed) assert.ok(known.has(id) || r.cells.some((c) => c.id === id), 'removal of a held cell');
      // Process order on the client: eats, records, removals (protocol semantics 3.8 item 6).
      for (const c of r.cells) known.add(c.id);
      for (const id of r.removed) { known.delete(id); announced.delete(id); }
      if (r.t === 'sync') {
        counts.syncs++;
        const listed = new Set(r.cells.map((c) => c.id));
        for (const id of Array.from(known)) if (!listed.has(id)) known.delete(id);
      }
    }
  }

  room.addSocket(sock);
  room.join(sock.id, 'Soaker');
  const seen = new Set();
  let spectateNext = false;
  let left = false;

  for (let t = 0; t < TICKS; t++) {
    // The script.
    const seat = room.seatOf(sock.id);
    const info = seat ? sim.playerInfo(seat.pid) : null;
    if (t === 10000 && !left) {
      room.removeSocket(sock.id);
      left = true;
    } else if (t === 10010 && left) {
      room.addSocket(sock, { clearFirst: true });
      room.join(sock.id, 'Soaker');
    } else if (info && info.cells.length) {
      let cx = 0, cy = 0;
      for (const id of info.cells) { const c = sim.getCell(id); cx += c.x; cy += c.y; }
      cx /= info.cells.length;
      cy /= info.cells.length;
      const a = t / 60;
      room.target(sock.id, Math.round(cx + Math.cos(a) * 400), Math.round(cy + Math.sin(a) * 400));
      if (t % 211 === 0) { room.split(sock.id); counts.splits++; }
      if (t % 97 === 0) { room.eject(sock.id); counts.ejects++; }
    } else if (seat && seat.joined && !seat.spawnQueued) {
      if (spectateNext && !seat.spectating) room.spectate(sock.id);
      else if (!spectateNext || t % 150 === 0) { room.join(sock.id, 'Soaker'); counts.spawns++; spectateNext = !spectateNext; }
    }
    // A backed-up socket now and then.
    sock.conn.writeBuffer = t % 1000 >= 500 && t % 1000 < 503 ? new Array(depth + 1) : [];

    const ownerBefore = new Map();
    const sizeBefore = new Map();
    sim.forEachCell((c) => { ownerBefore.set(c.id, c.owner); sizeBefore.set(c.id, c.size); });
    const sent = bundles.length;
    ev = null;
    assert.strictEqual(room.tickOnce(), true, 'tick ' + t);
    assert.ok(ev, 'the room stepped the sim');
    assert.ok(bundles.length - sent <= 1, 'one bundle per tick');
    const seatAfter = room.seatOf(sock.id);
    const infoAfter = seatAfter ? sim.playerInfo(seatAfter.pid) : null;
    if (bundles.length > sent) applyBundle(bundles[bundles.length - 1], new Set(infoAfter ? infoAfter.cells : []));

    // Sim events: every eaten id is removed this tick; no id ever comes back; a merge is never an eat record
    // (U_EAT_REMOVE, measured), only a removal of an own cell whose player still has cells.
    const removedNow = new Set(ev.removed);
    const eatenNow = new Set();
    for (const [eater, eaten] of ev.eats) {
      assert.ok(removedNow.has(eaten));
      eatenNow.add(eaten);
      assert.ok(!(ownerBefore.get(eater) !== null && ownerBefore.get(eater) === ownerBefore.get(eaten)), 'merge listed');
    }
    for (const id of ev.removed) {
      const owner = ownerBefore.get(id);
      if (!owner || eatenNow.has(id)) continue;
      const p = sim.playerInfo(owner);
      if (p && p.cells.length) counts.merges++;
    }
    for (const id of ev.added) {
      assert.ok(!seen.has(id), 'id reused ' + id + ' at tick ' + t);
      seen.add(id);
    }
    counts.deaths += ev.died.filter((pid) => seat && pid === seat.pid).length;

    // World invariants. Every cell is kept inside its L3 box by the movement phase; a cell that then ate in the
    // eat phase of the same tick has grown since, so until its next move it is only held to the border itself (an own
    // merge is such a growth too, but it is a plain removal, not an eat record (U_EAT_REMOVE), so a player cell that
    // grew this tick counts as one that ate: player cells grow only by eating or merging); a
    // piece of a player with 2+ cells may have been pushed by its own pieces after the border step (measured order),
    // and then sits less than its own size past that.
    const b = ev.border;
    const ate = new Set(ev.eats.map((e) => e[0]));
    sim.forEachCell((c) => { if (c.kind === 'player' && sizeBefore.has(c.id) && c.size > sizeBefore.get(c.id)) ate.add(c.id); });
    sim.forEachCell((c) => {
      if (!(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.size) && c.size > 0)) {
        assert.fail('bad cell ' + JSON.stringify([c.id, c.kind, c.x, c.y, c.size]) + ' at tick ' + t);
      }
      if (c.kind === 'food') {
        if (c.x < b.minX || c.x > b.maxX || c.y < b.minY || c.y > b.maxY) assert.fail('food outside at tick ' + t);
        return;
      }
      const pushed = c.kind === 'player' && sim.playerInfo(c.owner).cells.length > 1;
      const r = (ate.has(c.id) ? 0 : k * c.size) - (pushed ? c.size : 0);
      if (pushed) {
        const out = Math.max(b.minX + k * c.size - c.x, c.x - (b.maxX - k * c.size), b.minY + k * c.size - c.y,
          c.y - (b.maxY - k * c.size), 0);
        if (out / c.size > counts.maxPushOut) counts.maxPushOut = out / c.size;
      }
      const ex = b.maxX - b.minX < 2 * r;
      const ey = b.maxY - b.minY < 2 * r;
      if (!ex && (c.x < b.minX + r - 1e-9 || c.x > b.maxX - r + 1e-9)) assert.fail('x out of the L3 box at tick ' + t + ' ' + JSON.stringify([c.id, c.kind, c.owner, c.x, c.y, c.size, c.born, c.boost, b]));
      if (!ey && (c.y < b.minY + r - 1e-9 || c.y > b.maxY - r + 1e-9)) assert.fail('y out of the L3 box at tick ' + t + ' ' + JSON.stringify([c.id, c.kind, c.owner, c.x, c.y, c.size, c.born, c.boost, ate.has(c.id), pushed, b]));
    });
    {
      const l = sim.ledger();
      const destroyed = l.decay + l.eject + l.eat + l.virus + l.cap + l.left + l.trim;
      const live = sim.totalMass();
      assert.ok(Math.abs(live - (l.created - destroyed)) / live < 1e-9, 'ledger at tick ' + t);
    }
    const seatNow = room.seatOf(sock.id);
    assert.strictEqual(room.botCount + (seatNow && seatNow.joined ? 1 : 0), laws.L39.value, 'bots fill the room at tick ' + t);
  }

  assert.strictEqual(room.failCount, 0);
  assert.strictEqual(room.stats.buildErrors, 0);
  assert.ok(counts.eats > 100, 'eats seen ' + counts.eats);
  assert.ok(counts.syncs >= 10, 'syncs after backlogs ' + counts.syncs);
  assert.ok(counts.boards >= TICKS * laws.L1.value / laws.U_BOARD.value.periodMs - 40, 'boards ' + counts.boards);
  assert.ok(counts.merges > 0, 'merges seen ' + counts.merges);
  assert.strictEqual(counts.clears, 1, 'one clearAll after the leave');
  assert.ok(ownFirsts >= counts.spawns, 'own cells checked on arrival ' + ownFirsts);
  assert.ok(room.stats.skipped >= 30);
  // Final world agrees with the client model for the human's own cells.
  const seat = room.seatOf(sock.id);
  for (const id of sim.playerInfo(seat.pid).cells) assert.ok(known.has(id) && announced.has(id), 'own cell ' + id + ' held');
  console.log('soak (' + label + ') counts ' + JSON.stringify(counts) + ' ticks ' + room.stats.ticks + ' bytes ' +
    room.stats.bytes);
  room.stop();
}

test('soak: 1 scripted human plus bots for 20,000 ticks keeps every invariant (FIXTURE table)', { timeout: 600000 }, () => {
  soak(FIXTURE, 'FIXTURE');
});

test('soak: the same 20,000 ticks on the real (approved) table', { timeout: 600000 }, () => {
  soak(LAWS, 'real table');
});
