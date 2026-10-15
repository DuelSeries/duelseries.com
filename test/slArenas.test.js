'use strict';
// slArenas (SERVER-DESIGN 12.1, 13 items 4, 8, 16.2; task T11): ONE free room, one board row sl:<region>:s0 with stake
// 0, the door, isLive() both ways, no worth anywhere, the emergency replacement, the governor sample, the console
// contract. Paid task T4 (PAID-SL-DESIGN 1, D2-m9): extraLoad, the paid rooms' slice in the governor's sample.
const test = require('node:test');
const assert = require('node:assert');
const { rig, layerMsgs } = require('./slSockFakes');
const { SlArenas, GOVERNOR_SAMPLE_MS } = require('../server/sl/slArenas');
const { LAWS, ENTRIES, tableFrom } = require('../server/sl/slLaws');
const { makeFixture } = require('./slLawsFixture');
const ops = require('../server/ops');

test('the real table opens the room (every row settled 2026-10-11); one row not shippable keeps it closed', () => {
  const A = new SlArenas(LAWS, { autoTick: false, bots: false, log: { log() {}, warn() {}, error() {} } });
  assert.strictEqual(A.all().length, 1);
  A.close();
  const open = tableFrom(ENTRIES.map((e) => (e.id === 'C_ROOM_CAP' ? Object.assign({}, e, { status: 'NEEDS_MORE', value: null }) : e)));
  assert.throws(() => new SlArenas(open, { autoTick: false, bots: false }), /C_ROOM_CAP \(NEEDS_MORE/);
});

test('ONE free room; one board row sl:<region>:s0, game snake, stake 0, capacity null', () => {
  const r = rig();
  const A = r.arenas;
  assert.strictEqual(A.all().length, 1);
  assert.strictEqual(A.all()[0], A.room());
  assert.strictEqual(A.room().lobbyType, 'sl_na_s0');
  assert.deepStrictEqual(A.boardRows(), [{ id: 'sl:na:s0', game: 'snake', region: 'na', stake: 0, players: 0, bots: 0,
    capacity: null, state: 'open' }]);
  const eu = rig({ arenas: { region: 'eu' } });
  assert.strictEqual(eu.arenas.boardRows()[0].id, 'sl:eu:s0');
  assert.strictEqual(eu.arenas.room().lobbyType, 'sl_eu_s0');
});

test('players: seats with a live snake plus gliding ones; a dead seat waiting for its close does not count', () => {
  const r = rig();
  const a = r.sock();
  const b = r.sock();
  a.fire('sl:join', { nick: 'a' });
  b.fire('sl:join', { nick: 'b' });
  assert.strictEqual(r.arenas.humanTotal(), 2);
  assert.strictEqual(r.arenas.boardRows()[0].players, 2);
  a.fire('sl:leave');
  assert.strictEqual(r.arenas.humanTotal(), 2, 'a leaving live snake glides (C_DISCONNECT) and still counts');
  const room = r.room();
  room.seatOf(b.id).dead = true;
  assert.strictEqual(r.arenas.humanTotal(), 1);
  assert.deepStrictEqual(r.arenas.liveCounts(), { humans: 1, bots: 0 });
});

test('door off: no board row, isLive false, joins refused closed; on: all back, no restart', () => {
  const r = rig();
  const A = r.arenas;
  const seated = r.sock();
  seated.fire('sl:join', { nick: 'stays' });
  assert.strictEqual(A.door(false), false);
  assert.strictEqual(A.isLive(), false);
  assert.deepStrictEqual(A.boardRows(), []);
  const s = r.sock();
  s.fire('sl:join', { nick: 'late' });
  assert.deepStrictEqual(layerMsgs(s), [{ t: 'refused', why: 'closed' }]);
  assert.ok(A.room().seatOf(seated.id), 'seated players finish');
  assert.strictEqual(A.door(true), true);
  assert.strictEqual(A.isLive(), true);
  assert.strictEqual(A.boardRows().length, 1);
  assert.strictEqual(A.door('junk'), true, 'only a boolean moves the door');
});

test('isLive() flips both ways on the last boardRows() call (SERVER-DESIGN 16.2 rollback predicate)', () => {
  const r = rig();
  const A = r.arenas;
  assert.strictEqual(A.isLive(), true);
  const real = A.humanTotal.bind(A);
  A.humanTotal = () => { throw new Error('count failed'); };
  assert.deepStrictEqual(A.boardRows(), []);
  assert.strictEqual(A.isLive(), false);
  A.humanTotal = real;
  assert.strictEqual(A.boardRows().length, 1);
  assert.strictEqual(A.isLive(), true);
  A.close();
  assert.strictEqual(A.isLive(), false);
  assert.deepStrictEqual(A.boardRows(), []);
  assert.deepStrictEqual(A.all(), []);
});

test('no worth anywhere: snakes worth 0, no stake, drainStatus safe with a human playing', () => {
  const r = rig();
  const s = r.sock();
  s.fire('sl:join', { nick: 'free' });
  const room = r.room();
  assert.strictEqual(room.liveStakeTotal(), 0);
  assert.strictEqual(room.floorWorth, undefined);
  for (const v of room.snakes.values()) assert.strictEqual(v.worth, 0);
  const d = ops.drainStatus(r.arenas.all(), { count: 0, worth: 0 });
  assert.strictEqual(d.playing, 1);
  assert.strictEqual(d.paid, 0);
  assert.strictEqual(d.safe, true);
  for (const row of r.arenas.boardRows()) assert.strictEqual(row.stake, 0);
});

test('an emergency-closed room is replaced at once; its sockets are let go; the next join plays', () => {
  const r = rig();
  const A = r.arenas;
  const s = r.sock();
  s.fire('sl:join', { nick: 'x' });
  A.setTop({ t: 'top', name: 'w', amount: 9 });
  const old = A.room();
  old.emergencyClose();
  assert.notStrictEqual(A.room(), old);
  assert.strictEqual(A.replaced, 1);
  assert.strictEqual(s.disconnected, true);
  const s2 = r.sock();
  s2.fire('sl:join', { nick: 'y' });
  assert.ok(A.room().seatOf(s2.id));
  assert.deepStrictEqual(A.room().top, { t: 'top', name: 'w', amount: 9 }, 'the box message carried over');
  // the sweep replaces a room that closed without telling
  const before = A.room();
  before.closed = true;
  assert.deepStrictEqual(A.sweep(5), { replaced: true, at: 5 });
  assert.notStrictEqual(A.room(), before);
  assert.deepStrictEqual(A.sweep(6), { replaced: false, at: 6 });
});

test('setTop reaches every seat and is kept for new ones', () => {
  const r = rig();
  const a = r.sock();
  a.fire('sl:join', { nick: 'a' });
  r.arenas.setTop({ t: 'top', name: null, amount: null });
  r.ft.runImmediates();
  assert.deepStrictEqual(layerMsgs(a).filter((m) => m.t === 'top'), [{ t: 'top', name: null, amount: null }]);
  const b = r.sock();
  b.fire('sl:join', { nick: 'b' });
  assert.deepStrictEqual(layerMsgs(b).filter((m) => m.t === 'top'), [{ t: 'top', name: null, amount: null }]);
});

test('the governor sample: paid seats make the room yield; a loop stall engages it and addBot refuses', () => {
  const r = rig({ bots: true });
  const A = r.arenas;
  const room = A.room();
  assert.strictEqual(room.paidBusy(), false);
  room.stats.maxSliceMs = 4.5;
  A.sampleLoad(1000, { loopP99Ms: 1, paidPlayers: 2, paid: [] });
  assert.strictEqual(room.paidBusy(), true);
  assert.strictEqual(room.stats.maxSliceMs, 0, 'read and reset: the slice since the last sample');
  assert.strictEqual(A.maxSliceEverMs, 4.5);
  assert.strictEqual(A.lastSample.sliceMaxMs, 4.5);
  A.sampleLoad(2000, { loopP99Ms: 1, paidPlayers: 0, paid: [] });
  assert.strictEqual(room.paidBusy(), false);
  assert.ok(room.addBot(), 'a bot by hand while the governor rests');
  assert.strictEqual(A.sampleLoad(3000, { loopP99Ms: 16, paidPlayers: 0, paid: [] }), 'engaged', 'p99 over 15 ms');
  assert.strictEqual(room.addBot(), null, 'refused while engaged');
  assert.strictEqual(A.sampleLoad(4000, { loopP99Ms: 1, paidPlayers: 0, paid: [] }), 'recovered');
  assert.strictEqual(A.governor.stats().engagements, 1);
});

test('extraLoad: the paid rooms\' slice reaches the governor; the larger of the two counts; a fault reads as 0', () => {
  const r = rig({ bots: true });
  const A = r.arenas;
  const room = A.room();
  let paidSlice = 0;
  assert.strictEqual(A.setExtraLoad(() => paidSlice), true);
  room.stats.maxSliceMs = 2;
  paidSlice = 30;
  assert.strictEqual(A.sampleLoad(1000, { loopP99Ms: 1, paidPlayers: 0, paid: [] }), 'engaged', 'a 30 ms paid slice engages it');
  assert.strictEqual(A.governor.stats().engagements, 1);
  assert.strictEqual(A.lastSample.sliceMaxMs, 30);
  assert.strictEqual(A.lastSample.paidSliceMs, 30);
  assert.strictEqual(A.maxSliceEverMs, 2, 'the free room\'s own maximum stays its own');
  paidSlice = 0;
  room.stats.maxSliceMs = 1;
  assert.strictEqual(A.sampleLoad(2000, { loopP99Ms: 1, paidPlayers: 0, paid: [] }), 'recovered');
  assert.strictEqual(A.lastSample.sliceMaxMs, 1, 'the free slice when it is the larger');
  for (const bad of [() => { throw new Error('boom'); }, () => NaN, () => -5, () => 'x', () => Infinity]) {
    A.setExtraLoad(bad);
    room.stats.maxSliceMs = 1;
    assert.doesNotThrow(() => A.sampleLoad(3000, { loopP99Ms: 1, paidPlayers: 0, paid: [] }));
    assert.strictEqual(A.lastSample.paidSliceMs, 0);
    assert.strictEqual(A.lastSample.sliceMaxMs, 1);
  }
  assert.strictEqual(A.setExtraLoad(null), false, 'anything but a function clears it');
  assert.strictEqual(A.extraLoad, null);
  // the option at construction, and a directory without bots still reads (and resets) it
  let reads = 0;
  const B = rig({ arenas: { extraLoad: () => { reads++; return 4; } } }).arenas;
  assert.strictEqual(B.sampleLoad(1000, { loopP99Ms: 0, paidPlayers: 0, paid: [] }), null);
  assert.strictEqual(reads, 1);
});

test('startTimers: one sample every GOVERNOR_SAMPLE_MS; the first one starts the loop histogram afresh; p99 over the floor', () => {
  const r = rig({ bots: true });
  let fn = null;
  let period = 0;
  const hist = { p: 16e6, resets: 0, enabled: 0, percentile() { return this.p; }, reset() { this.resets++; },
    enable() { this.enabled++; } };
  const elu = { idle: 0, active: 0 }; // the loop's cumulative idle and busy ms (perf_hooks eventLoopUtilization)
  let paid = 0;
  r.arenas.startTimers({ monitor: hist, elu: () => elu, now: () => r.wall.t, paidLoad: () => ({ paidPlayers: paid, paid: [] }),
    every: (f, ms) => { fn = f; period = ms; return { stop() { fn = null; } }; } });
  assert.strictEqual(period, GOVERNOR_SAMPLE_MS);
  assert.strictEqual(GOVERNOR_SAMPLE_MS, 1000);
  assert.strictEqual(hist.enabled, 1);
  fn();
  assert.strictEqual(hist.resets, 1, 'boot stalls are not game load');
  assert.strictEqual(r.arenas.lastSample.loopP99Ms, 0);
  r.wall.t += 1000;
  elu.idle += 990;
  elu.active += 10;
  fn();
  assert.strictEqual(r.arenas.lastSample.loopFloorMs, 16, 'a calm second (busy 0.01): its p99 is the idle floor');
  assert.strictEqual(r.arenas.lastSample.loopP99Ms, 0);
  paid = 1;
  hist.p = 20e6;
  r.wall.t += 1000;
  elu.idle += 990;
  elu.active += 10;
  fn();
  assert.strictEqual(r.arenas.lastSample.loopP99Ms, 4, 'the histogram p99 over the idle floor, in ms');
  assert.strictEqual(r.arenas.lastSample.loopRawP99Ms, 20);
  assert.strictEqual(r.arenas.lastSample.loopFloorMs, 16);
  assert.strictEqual(r.arenas.room().paidBusy(), true);
  r.arenas.close();
  assert.strictEqual(fn, null, 'close stops the timer');
  // The busy share reaches the probe: a loop busy most of the second is not calm, so no floor (1 ms resolution).
  hist.p = 20e6;
  const r2 = rig({ bots: true });
  const busy = { idle: 0, active: 0 };
  r2.arenas.startTimers({ monitor: hist, elu: () => busy, now: () => r2.wall.t,
    every: (f2) => { fn = f2; return { stop() { fn = null; } }; } });
  fn();
  busy.idle += 300;
  busy.active += 700;
  r2.wall.t += 1000;
  fn();
  assert.strictEqual(r2.arenas.lastSample.loopFloorMs, 1);
  assert.strictEqual(r2.arenas.lastSample.loopP99Ms, 19);
  r2.arenas.close();
});

test('the owner console contract: lobbyType, counts, botsAllowed, addBot, clearBots', () => {
  const r = rig({ bots: true });
  const room = r.arenas.room();
  assert.strictEqual(room.botsAllowed(), true);
  assert.strictEqual(room.playerCount, 0);
  const b = room.addBot();
  assert.ok(b && typeof b === 'object');
  assert.strictEqual(room.botCount, 1);
  assert.strictEqual(r.arenas.botTotal(), 1);
  assert.strictEqual(room.clearBots(), 1);
  assert.strictEqual(room.botCount, 0);
  const capped = rig({ bots: true, patch: { C_ROOM_CAP: 1 } });
  assert.ok(capped.arenas.room().addBot());
  assert.strictEqual(capped.arenas.room().addBot(), null, 'refused above C_ROOM_CAP');
});

test('a FIXTURE table opens only with shippableOnly false (the dev boot)', () => {
  assert.throws(() => new SlArenas(makeFixture(), { autoTick: false }), /not shippable/);
  const A = new SlArenas(makeFixture(), { autoTick: false, shippableOnly: false, bots: false, log: { log() {}, warn() {}, error() {} } });
  assert.strictEqual(A.isOpen(), true);
  A.close();
  assert.strictEqual(A.isOpen(), false);
});
