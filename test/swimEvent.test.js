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

test('the saved podium keeps names only, cut to size', () => {
  assert.strictEqual(cleanLast(null), null);
  assert.strictEqual(cleanLast({ podium: [] }), null);
  const c = cleanLast({ podium: ['a'.repeat(40), 'b', 'c', 'd'], winner: 'a', lanes: 12, at: 5, people: 3, wallet: 'secret' });
  assert.deepStrictEqual(c.podium, ['a'.repeat(24), 'b', 'c']);
  assert.strictEqual(c.wallet, undefined);
});
