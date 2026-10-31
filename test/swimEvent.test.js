'use strict';
/* The Swim Race event (server/swim/SwimEvent.js) and the wider road under it (shared/swimSim.js Traffic(n),
   server/swim/swimTraffic.js Spawner { lanes }). */
const test = require('node:test');
const assert = require('node:assert');
const S = require('../shared/swimSim');
const { Spawner } = require('../server/swim/swimTraffic');
const { SwimEvent, MAX_FIELD, MIN_FIELD, WIN_LEAD } = require('../server/swim/SwimEvent');
const { cleanLast } = require('../server/swim/swimEventStore');

function fakeIo() {
  const sent = [];
  const room = (name) => ({ emit: (ev, p) => sent.push({ to: name, ev, p }), volatile: { emit: (ev, p) => sent.push({ to: name, ev, p, v: 1 }) } });
  return { to: room, sent };
}
function sock(id) { return { id, joined: new Set(), join(r) { this.joined.add(r); }, leave(r) { this.joined.delete(r); }, emit() {}, volatile: { emit() {} } }; }
function newEvent() {
  const clock = { t: 1e6 };
  const io = fakeIo();
  const ev = new SwimEvent(io, { now: () => clock.t, manual: true, maxTicks: 3 * 60 * S.HZ });
  ev.doorOpen = true;
  return { ev, io, clock };
}
function run(ev, clock, maxTicks) {
  for (let i = 0; i < maxTicks && ev.state !== 'over'; i++) { clock.t += S.TICK_MS; ev.tick(clock.t); }
}

test('a wide road: walls, lanes and hits agree with a plain scan of every car', () => {
  const tr = new S.Traffic(20);
  assert.strictEqual(tr.lanes.length, 20);
  assert.strictEqual(tr.wallR, S.WALL + 16 * S.LANE_W);
  assert.strictEqual(new S.Traffic().wallR, S.WALL);
  const sp = new Spawner(5, { lanes: 20 });
  sp.run(tr, 0, 0, S.V0, null);
  for (let t = 1; t < 600; t++) sp.run(tr, t, t * 1.2, 80, null);
  const plain = (x, z, tick) => {
    for (let l = 0; l < tr.n; l++) for (const r of tr.lanes[l]) {
      const T = S.TYPES[r[2]], dz = S.zAt(r, tick) - z;
      if (Math.abs(dz) < S.CAR.HL + T.hl && Math.abs(x - S.xAt(r, tick)) < S.CAR.HW + T.hw) return true;
    }
    return false;
  };
  let hits = 0;
  for (let k = 0; k < 4000; k++) {
    const x = -7 + (k * 0.731) % (20 * 3.6), z = (k * 3.17) % 700, tick = 300 + (k % 200);
    const a = tr.hitAt(x, z, tick) >= 0, b = plain(x, z, tick);
    assert.strictEqual(a, b, 'x ' + x + ' z ' + z);
    if (a) hits++;
  }
  assert.ok(hits > 20, 'some probes touch traffic (' + hits + ')');
  const car = S.newCar(0); car.x = tr.wallR - 0.01;
  S.step(car, S.packInput(1, 1), tr);
  assert.strictEqual(car.x, tr.wallR, 'the right barrier of a wide road stops the car');
});

test('a wide road: lane speeds repeat every four lanes, and no lane change crosses a carriageway line', () => {
  for (let l = 0; l < 50; l++) assert.strictEqual(S.laneV(l), S.LANE_V[l % 4]);
  const tr = new S.Traffic(22), sp = new Spawner(77, { lanes: 22 });
  for (let t = 0; t < 60 * 120; t++) sp.run(tr, t, t * 1.4, 90, null);
  let changes = 0;
  for (const r of tr.all()) {
    assert.ok(S.validRecord(r, 22));
    if (r.length === 8) { changes++; assert.strictEqual(r[1] >> 2, r[7] >> 2, 'record ' + r[0] + ' changes ' + r[1] + ' to ' + r[7]); }
    if (r[1] >= 20) assert.notStrictEqual(r.length === 8 && (r[7] < 20), true);
  }
  assert.ok(changes > 10, 'lane changes happen (' + changes + ')');
});

test('the event: nobody joined, no race; one person gets a road of 8 with 7 bots in full carriageways', () => {
  const { ev } = newEvent();
  assert.strictEqual(ev.start('t'), 'nobody joined');
  assert.strictEqual(ev.state, 'waiting');
  assert.ok(ev.join(sock('a'), 'Ann', null, { car: 'muscle' }).ok);
  assert.strictEqual(ev.start('t'), '');
  assert.strictEqual(ev.state, 'countdown');
  assert.strictEqual(ev.lanes, MIN_FIELD);
  const racers = ev.racers.filter(Boolean);
  assert.strictEqual(racers.length, 8);
  assert.strictEqual(racers.filter(r => r.bot).length, 7);
  const seats = new Set(racers.map(r => r.seat));
  assert.strictEqual(seats.size, 8, 'each car its own lane');
  for (const r of racers) assert.strictEqual(r.car.x, S.laneX(r.seat));
  assert.strictEqual(ev.join(sock('late'), 'Late', null, {}).ok, false, 'no joining once it has started');
});

test('the event: the door, the cap and one entry per socket', () => {
  const { ev } = newEvent();
  ev.doorOpen = false;
  assert.strictEqual(ev.join(sock('x'), 'X', null, {}).closed, true);
  ev.doorOpen = true;
  for (let i = 0; i < MAX_FIELD; i++) assert.ok(ev.join(sock('s' + i), 'P' + i, null, {}).ok);
  assert.ok(ev.join(sock('s3'), 'P3', null, {}).again, 'joining twice is the same seat');
  const r = ev.join(sock('one-more'), 'Z', null, {});
  assert.strictEqual(r.ok, false); assert.strictEqual(r.full, true); assert.strictEqual(r.why, 'Event full');
  ev.start('t');
  assert.strictEqual(ev.lanes, MAX_FIELD);
  assert.strictEqual(ev.racers.filter(r => r && r.bot).length, 0);
});

test('the event: a race of bots ends with every place given once, the podium saved, and the doors reopening', () => {
  const { ev, io, clock } = newEvent();
  let done = null;
  ev.onFinish = (x) => { done = x; };
  ev.join(sock('p'), 'Pat', null, {});
  ev.start('t');
  /* The person never sends anything: their car coasts and is soon hit; the bots race on. */
  run(ev, clock, 60 * 60 * 4);
  assert.strictEqual(ev.state, 'over');
  const m = ev.overMsg;
  assert.ok(['last car', 'lead', 'time'].includes(m.why), m.why);
  const places = m.places.map(p => p.place).sort((a, b) => a - b);
  assert.deepStrictEqual(places, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.strictEqual(m.places[0].name, m.winner.name);
  assert.deepStrictEqual(m.podium, m.places.slice(0, 3).map(p => p.name));
  assert.ok(done && done.last && done.last.podium.length === 3);
  assert.ok(io.sent.some(s => s.ev === 'se:ko'), 'knockouts are told');
  assert.ok(io.sent.filter(s => s.ev === 'se:s').every(s => s.v === 1), 'rows go volatile');
  assert.ok(io.sent.filter(s => s.ev === 'se:s').every(s => /^swev:[012]$/.test(s.to)), 'rows go to the snapshot groups');
  clock.t += 60000; ev.tick(clock.t);
  assert.strictEqual(ev.state, 'waiting');
  assert.ok(ev.last && ev.last.podium.length === 3, 'the last podium stays');
});

test('the event: a person only ever drives their own car, and a malformed packet is dropped', () => {
  const { ev, clock } = newEvent();
  const a = sock('a'), b = sock('b');
  ev.join(a, 'A', null, {}); ev.join(b, 'B', null, {});
  ev.start('t');
  clock.t += 10001; ev.tick(clock.t);
  assert.strictEqual(ev.state, 'racing');
  for (const bad of [null, 5, {}, { t: 'x', k: [] }, { t: 3, k: new Array(13).fill(0) }, { t: 1e9, k: [1] }]) assert.strictEqual(ev.input('a', bad), false);
  assert.strictEqual(ev.input('nobody', { t: 1, k: [S.packInput(1, 1)] }), false);
  const ra = ev.bySocket.get('a');
  assert.ok(ev.input('a', { t: 2, k: [S.packInput(1, 1), 99999, S.packInput(1, 1)] }));
  assert.strictEqual(ra.codes[1], -1, 'an invalid code is skipped');
  assert.strictEqual(ra.codes[2], S.packInput(1, 1));
  assert.strictEqual(ev.bySocket.get('b').codes[2], -1, 'the other car is untouched');
});

test('the event: leaving mid-race is out at once; a dropped socket keeps its seat for its key', () => {
  const { ev, clock } = newEvent();
  const a = sock('a'), b = sock('b');
  ev.join(a, 'A', null, {}); ev.join(b, 'B', null, {});
  ev.start('t');
  clock.t += 10001; ev.tick(clock.t);
  ev.leave('a');
  assert.ok(ev.bySocket.get('a').outPlace > 0);
  assert.strictEqual(ev.bySocket.get('a').outWhy, 'left');
  const rb = ev.bySocket.get('b');
  ev.drop('b');
  assert.ok(rb.away > 0);
  const nb = sock('b2');
  assert.strictEqual(ev.rejoin(nb, 'not-a-key'), null);
  assert.strictEqual(ev.rejoin(nb, rb.key), rb);
  assert.strictEqual(rb.away, 0);
  assert.strictEqual(ev.bySocket.get('b2'), rb);
  assert.strictEqual(ev.bySocket.has('b'), false);
});

test('the event: 500 m clear of second wins', () => {
  const { ev, clock } = newEvent();
  ev.join(sock('a'), 'A', null, {});
  ev.start('t');
  clock.t += 10001; ev.tick(clock.t);
  /* Put one car far ahead in its history and judge. */
  const lead = ev.racers.find(r => r && !r.bot);
  for (let i = 0; i < 4; i++) { clock.t += S.TICK_MS; ev.tick(clock.t); }
  const t = ev.judged + 1;
  for (const r of ev.racers) if (r) { r.car.tick = Math.max(r.car.tick, t); r.zHist[t % 1024] = r === lead ? 2000 : 1000; }
  assert.ok(ev.judge());
  assert.strictEqual(ev.overMsg.why, 'lead');
  assert.strictEqual(ev.overMsg.winner.seat, lead.seat);
  assert.ok(WIN_LEAD === 500);
});

test('the event: 1 km behind the leader is out, so parking never outlasts the drivers', () => {
  const { ev, clock } = newEvent();
  ev.join(sock('a'), 'A', null, {});
  ev.start('t');
  clock.t += 10001; ev.tick(clock.t);
  for (let i = 0; i < 4; i++) { clock.t += S.TICK_MS; ev.tick(clock.t); }
  const parked = ev.racers.find(r => r && !r.bot);
  const t = ev.judged + 1;
  /* Everyone level but the parked car, 1 km back. */
  for (const r of ev.racers) if (r) { r.car.tick = Math.max(r.car.tick, t); r.zHist[t % 1024] = r === parked ? 100 : 1100 + r.seat; }
  ev.judge();
  assert.strictEqual(parked.outWhy, 'fell behind');
  assert.strictEqual(parked.outPlace, 8);
  assert.notStrictEqual(ev.state, 'over', 'the others race on');
});

test('the lobby: random spots, no two cars in a lane, lanes 0 to n - 1 past 8, bots never moved', () => {
  /* Random: over many lobbies the first person in is spread over the first 8 lanes, not always lane 0. */
  const firstLanes = new Set();
  for (let k = 0; k < 60; k++) { const { ev } = newEvent(); firstLanes.add(ev.join(sock('a'), 'A', null, {}).lane); }
  assert.ok(firstLanes.size >= 6 && [...firstLanes].every(l => l >= 0 && l < MIN_FIELD), 'first car lanes: ' + [...firstLanes]);
  const { ev, io, clock } = newEvent();
  const moved = new Map();
  const mk = (id) => { const s = sock(id); s.emit = (e2, m) => { if (e2 === 'se:lane') moved.set(id, m.lane); }; return s; };
  for (let i = 0; i < 3; i++) ev.join(mk('p' + i), 'P' + i, null, {});
  ev.nextSlotAt = clock.t + 60000;
  for (let i = 0; i < 4 * 60 && ev.entrants.size < MIN_FIELD; i++) { clock.t += 250; ev.tick(clock.t); }
  assert.strictEqual(ev.entrants.size, MIN_FIELD);
  const lanes = () => [...ev.entrants.values()].map(e => e.lane).sort((a, b) => a - b);
  assert.deepStrictEqual(lanes(), [0, 1, 2, 3, 4, 5, 6, 7], 'eight cars, eight lanes, one each');
  const botLanes = new Map([...ev.entrants.values()].filter(e => e.bot).map(e => [e.id, e.lane]));
  for (let i = 3; i < 15; i++) {
    const r = ev.join(mk('p' + i), 'P' + i, null, {});
    assert.ok(r.ok && r.lane >= 0 && r.lane <= ev.entrants.size - 1);
    assert.deepStrictEqual(lanes(), Array.from({ length: ev.entrants.size }, (_, k) => k), 'lanes 0 to n - 1, no two in one');
  }
  for (const e of ev.entrants.values()) if (e.bot) assert.strictEqual(e.lane, botLanes.get(e.id), 'a bot never moves');
  for (const [id, lane] of moved) assert.strictEqual(ev.entrants.get(id).lane, lane, 'a moved person is told their new lane');
  /* Leaving: past the first 8 the highest car (a person) moves into the gap; the lanes stay 0 to n - 1. */
  const leaver = [...ev.entrants.values()].find(e => !e.bot && e.lane < 8);
  ev.leave(leaver.id);
  assert.deepStrictEqual(lanes(), Array.from({ length: ev.entrants.size }, (_, k) => k));
  for (const e of ev.entrants.values()) if (e.bot) assert.strictEqual(e.lane, botLanes.get(e.id));
  ev.lobby(0);
  const msg = io.sent.filter(m => m.ev === 'se:lobby').pop().p;
  assert.strictEqual(msg.cars.length, ev.entrants.size);
  assert.ok(!JSON.stringify(msg).includes('"p1"'), 'no socket ids');
  /* The start: every car in the lane it waited in, bots in lanes 0 to 7. */
  const waited = new Map([...ev.entrants.values()].map(e => [e.name, e.lane]));
  ev.start('t');
  assert.strictEqual(ev.lanes, waited.size);
  for (const r of ev.racers) assert.strictEqual(r.seat, waited.get(r.name));
  for (const r of ev.racers) if (r.bot) assert.ok(r.seat < MIN_FIELD);
});

test('the lobby: bots trickle in one at a time at uneven gaps before the start, never all at once, only below 8', () => {
  const { ev, clock } = newEvent();
  ev.join(sock('p'), 'Pat', null, {});
  ev.nextSlotAt = clock.t + 10 * 60 * 1000;               // the race in 10 minutes; bots come in its last 8
  const arrivals = [];
  for (let t = 0; t < 10 * 60 * 1000 && ev.state === 'waiting'; t += 250) {
    clock.t += 250;
    const before = ev.entrants.size;
    ev.tick(clock.t);
    if (ev.state === 'waiting' && ev.entrants.size > before) { assert.strictEqual(ev.entrants.size - before, 1, 'one at a time'); arrivals.push(t); }
  }
  assert.strictEqual(arrivals.length, MIN_FIELD - 1, 'seven bots join a lobby of one');
  assert.ok(arrivals[0] >= 2 * 60 * 1000 - 1, 'none before the last 8 minutes');
  const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]);
  assert.ok(new Set(gaps.map(g => Math.round(g / 1000))).size > 2, 'uneven gaps: ' + gaps.join(', '));
  const bots = [...ev.entrants.values()].filter(e => e.bot);
  assert.ok(bots.every(e => e.lane < MIN_FIELD), 'every bot in lanes 0 to 7');
  assert.ok(new Set(bots.map(e => e.name)).size === bots.length && bots.every(e => !/bot/i.test(e.name)), 'player names');
});

test('the lobby: the owner test race starts on its own clock with the bots trickled in, and needs a person', () => {
  const { ev, clock } = newEvent();
  assert.ok(ev.ownerOpen(60000));
  for (let i = 0; i < 70 * 4 && ev.state === 'waiting'; i++) { clock.t += 250; ev.tick(clock.t); }
  assert.strictEqual(ev.state, 'waiting', 'nobody joined: no race, the bots gone');
  assert.strictEqual(ev.entrants.size, 0);
  ev.join(sock('o'), 'Owen', null, {});
  ev.ownerOpen(60000);
  clock.t += 5000; ev.tick(clock.t);
  assert.ok(ev.ownerStartSoon(15000));
  let most = 0;
  for (let i = 0; i < 20 * 4 && ev.state === 'waiting'; i++) {
    const before = ev.entrants.size; clock.t += 250; ev.tick(clock.t);
    if (ev.state === 'waiting') most = Math.max(most, ev.entrants.size - before);
  }
  assert.strictEqual(ev.state, 'countdown', 'it started');
  assert.ok(most <= 1, 'never two bots in the same moment');
  assert.strictEqual(ev.lanes, MIN_FIELD);
});

test('a test player (capacity harness) races but never wins or places', () => {
  const { ev } = newEvent();
  ev.join(sock('t'), 'Load1', null, {}, true);
  ev.join(sock('p'), 'Pat', null, {});
  ev.start('t');
  const lt = ev.racers.find(r => r && r.lt);
  ev.finish(lt, 'last car');
  assert.notStrictEqual(ev.overMsg.winner.name, 'Load1');
  assert.ok(!ev.overMsg.places.some(p => p.name === 'Load1'));
  assert.ok(!ev.last.podium.includes('Load1'));
  assert.deepStrictEqual(ev.overMsg.places.map(p => p.place), ev.overMsg.places.map((_, i) => i + 1));
});

test('the saved podium keeps names only, cut to size', () => {
  assert.strictEqual(cleanLast(null), null);
  assert.strictEqual(cleanLast({ podium: [] }), null);
  const c = cleanLast({ podium: ['a'.repeat(40), 'b', 'c', 'd'], winner: 'a', lanes: 12, at: 5, people: 3, wallet: 'secret' });
  assert.deepStrictEqual(c.podium, ['a'.repeat(24), 'b', 'c']);
  assert.strictEqual(c.wallet, undefined);
});
