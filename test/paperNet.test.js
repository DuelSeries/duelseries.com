'use strict';
// Client net layer (T11, design 8.3, 7.2, 7.5, 6.2-6.3) against a socket double: the clock
// offset EMA, renderTick, the adaptive jitter buffer, the event timeline, the pp:need resync
// safety net and its rate limits, and the reconnect by resumeKey.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const MP = require('../public/js/paper/mp/paperWire.js');
const Net = require('../public/js/paper/mp/paperNet.js');

const ROOT = path.join(__dirname, '..');
const STEP = MP.STEP_MS;
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

function socketDouble() {
  const s = {
    handlers: {},
    sent: [],
    on(ev, fn) { this.handlers[ev] = fn; },
    emit(ev, p) { this.sent.push([ev, p]); },
    fire(ev, p) { if (this.handlers[ev]) this.handlers[ev](p); }
  };
  s.volatile = { emit: (ev, p) => s.sent.push([ev, p, 'volatile']) };
  return s;
}

function sinkDouble() {
  return {
    joined: [],
    entries: [],
    frames: [],
    applyJoined(p) { this.joined.push(p); },
    applyEntry(e, tick) { this.entries.push([tick, e]); },
    onFrame(f) { this.frames.push(f); }
  };
}

function kit({ you = 1, units = [], tick = 100, at = 100000 } = {}) {
  const clock = { t: at };
  const socket = socketDouble();
  const sink = sinkDouble();
  const net = new Net.ArenaNet({ socket, now: () => clock.t, sink, onError: (w, e) => { throw e; } });
  const trails = units.map(() => MP.encodePoints([]));
  const rings = units.map(() => MP.encodePoints([{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }]));
  socket.fire('pp:joined', { you, tick, radius: 950, targetRadius: 950, resumeKey: 'RK', resumed: false, units, rings, trails, pickups: [] });
  return { clock, socket, sink, net };
}

function unit(id, extra = {}) {
  return Object.assign({ id, x: 500, y: 500, dir: 0, pct: 0.01, baseVer: 0, trailEpoch: 0, trailCount: 0, tail: [] }, extra);
}

function frame(tick, units = [], extra = {}) {
  return MP.encodeFrame(Object.assign({ tick, radius: 950, targetRadius: 950, units, pickups: [] }, extra));
}

test('both modules load under require with no DuelPaperLib at load time', () => {
  const script = [
    "const Net = require('./public/js/paper/mp/paperNet.js');",
    "const Mirror = require('./public/js/paper/mp/paperMirror.js');",
    'const P = globalThis.DuelPaperLib;',
    "let threw = '';",
    'try { Mirror.create({}); } catch (e) { threw = e.message; }',
    'console.log(JSON.stringify({ net: typeof Net.ArenaNet, mirror: typeof Mirror.create, hasNet: P.Net === Net,',
    '  hasMirror: P.Mirror === Mirror, mp: !!P.MP, game: !!P.Game, threw }));'
  ].join('\n');
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: ROOT }).toString().trim());
  assert.strictEqual(out.net, 'function');
  assert.strictEqual(out.mirror, 'function');
  assert.ok(out.hasNet && out.hasMirror, 'both register on DuelPaperLib');
  assert.strictEqual(out.mp, false, 'nothing else was loaded');
  assert.strictEqual(out.game, false);
  assert.match(out.threw, /load the solo paper modules/, 'the solo modules are looked up only when called');
});

test('clock offset EMA: the first sample sets it, later ones blend 10 percent', () => {
  const LAT = 40;
  const { clock, socket, net } = kit({ tick: 100, at: 100 * STEP + LAT });
  assert.ok(close(net.clockOffset, -LAT), 'pp:joined seeds the clock');
  for (let k = 1; k <= 10; k++) {
    clock.t = (100 + 2 * k) * STEP + LAT;
    socket.fire('pp:s', frame(100 + 2 * k));
  }
  assert.ok(close(net.clockOffset, -LAT, 1e-6), 'steady latency keeps the offset');
  clock.t = 122 * STEP + LAT + 20;
  socket.fire('pp:s', frame(122));
  assert.ok(close(net.clockOffset, -LAT - 20 * Net.CLOCK_EMA, 1e-6), 'one late sample moves it by 10 percent: ' + net.clockOffset);
  let expect = -LAT - 20 * Net.CLOCK_EMA;
  for (let k = 1; k <= 30; k++) {
    clock.t = (122 + 2 * k) * STEP + LAT;
    socket.fire('pp:s', frame(122 + 2 * k));
    expect += (-LAT - expect) * Net.CLOCK_EMA;
  }
  assert.ok(close(net.clockOffset, expect, 1e-6));
  assert.ok(Math.abs(net.clockOffset + LAT) < 0.1, 'converges back');
  assert.strictEqual(net.serverTick(clock.t), (clock.t + net.clockOffset) / STEP);
});

test('renderTick = serverTick - (INTERP_DELAY_MS + jitterBuf) / STEP_MS, null before any clock', () => {
  const s = socketDouble();
  const idle = new Net.ArenaNet({ socket: s, now: () => 0 });
  assert.strictEqual(idle.renderTick(0), null);
  assert.strictEqual(idle.bracket(0), null);
  const { clock, socket, net } = kit({ tick: 300, at: 300 * STEP + 25 });
  for (let k = 1; k <= 5; k++) {
    clock.t = (300 + 2 * k) * STEP + 25;
    socket.fire('pp:s', frame(300 + 2 * k));
  }
  assert.ok(net.jitterBuf < 1e-9, 'on time: ' + net.jitterBuf);
  net.jitterBuf = 0;
  const now = clock.t + 7;
  const rt = net.renderTick(now);
  assert.ok(close(rt, (now - 25) / STEP - MP.INTERP_DELAY_MS / STEP, 1e-9), 'rt ' + rt);
  assert.ok(close(net.serverTick(now) - rt, MP.INTERP_DELAY_MS / STEP, 1e-9));
  net.jitterBuf = 50;
  assert.ok(close(net.serverTick(now) - net.renderTick(now), (MP.INTERP_DELAY_MS + 50) / STEP, 1e-9));
});

test('jitter buffer: grows at once to the lateness (capped at MAX_JITTER_BUF_MS) and decays slowly', () => {
  const { clock, socket, net } = kit({ tick: 0, at: 1000 });
  let tick = 0;
  let at = 1000;
  const on = (late = 0) => {
    tick += 2;
    at += 2 * STEP;
    clock.t = at + late;
    socket.fire('pp:s', frame(tick));
  };
  for (let i = 0; i < 5; i++) on();
  assert.ok(net.jitterBuf < 1e-9, 'on-time frames leave it at 0: ' + net.jitterBuf);
  on(100);
  assert.ok(close(net.jitterBuf, 100, 1e-6), 'a 100 ms late frame grows it to 100: ' + net.jitterBuf);
  let expect = 100;
  for (let i = 0; i < 20; i++) {
    on();
    expect += (0 - expect) * Net.JITTER_DECAY;
    assert.ok(close(net.jitterBuf, expect, 1e-6), 'decay step ' + i + ': ' + net.jitterBuf + ' vs ' + expect);
  }
  assert.ok(net.jitterBuf < 60 && net.jitterBuf > 50, 'slow: still ' + net.jitterBuf.toFixed(1) + ' after 20 calm frames');
  on(500);
  assert.strictEqual(net.jitterBuf, MP.MAX_JITTER_BUF_MS, 'a stall is capped');
  // pp:joined is a full reset.
  clock.t = at + 2 * STEP;
  socket.fire('pp:joined', { you: 1, tick: tick + 2, resumeKey: 'RK2', resumed: true, units: [], rings: [], trails: [], pickups: [] });
  assert.strictEqual(net.jitterBuf, 0);
  assert.strictEqual(net.frames.length, 0);
  assert.strictEqual(net.lastSnapAt, 0);
  tick += 2;
  at += 2 * STEP;
  for (let i = 0; i < 5; i++) on();
  assert.ok(net.jitterBuf < 1e-9);
  // A dropped volatile frame: the next one lands one snapshot period late.
  tick += 2;
  at += 2 * STEP;
  on();
  assert.ok(close(net.jitterBuf, 2 * STEP, 1e-6), 'one period: ' + net.jitterBuf);
});

test('bracket: interpolation between frames, the oldest before the buffer, dead reckoning capped past it', () => {
  const { clock, socket, net } = kit({ tick: 10, at: 10 * STEP });
  for (const t of [12, 14, 18]) {
    clock.t = t * STEP;
    socket.fire('pp:s', frame(t, [unit(2)]));
  }
  let b = net.bracket(13);
  assert.strictEqual(b.before.tick, 12);
  assert.strictEqual(b.after.tick, 14);
  assert.ok(close(b.alpha, 0.5));
  b = net.bracket(15);
  assert.strictEqual(b.before.tick, 14);
  assert.strictEqual(b.after.tick, 18, 'a dropped frame (16) is bridged');
  assert.ok(close(b.alpha, 0.25));
  b = net.bracket(5);
  assert.strictEqual(b.before.tick, 12);
  assert.strictEqual(b.after, null);
  assert.strictEqual(b.extMs, 0);
  b = net.bracket(19);
  assert.strictEqual(b.before.tick, 18);
  assert.ok(close(b.extMs, STEP));
  b = net.bracket(100);
  assert.strictEqual(b.extMs, MP.DEAD_RECKON_MS, 'capped');
  assert.ok(b.before.byId.get(2), 'frames are indexed by id');
  // Stale and repeated frames are dropped.
  clock.t = 20 * STEP;
  socket.fire('pp:s', frame(18));
  socket.fire('pp:s', frame(16));
  assert.strictEqual(net.frames.length, 3);
});

test('event timeline: tick order, arrival order within a tick, local entries on receipt', () => {
  const ring = MP.encodePoints([{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }]);
  const { socket, sink, net } = kit({ you: 7, units: [{ id: 3, ver: 1, epoch: 0 }, { id: 7, ver: 1, epoch: 0 }] });
  socket.fire('pp:ev', { tick: 10, ev: [['m', 3, 5], ['m', 7, 1], ['p+', 1, 10, 10, 5], ['t', 3, 0, 0, MP.encodePoints([{ x: 1, y: 2 }])]] });
  socket.fire('pp:ev', { tick: 14, ev: [['m', 4, 6], ['k', 9, 7, 3, 0, 0]] });
  socket.fire('pp:geo', { tick: 12, ev: [['b', 3, 2, 0.1, ring]] });
  socket.fire('pp:ev', { tick: 14, ev: [['p-', 1, 7, 5], ['b', 7, 2, 0.2, ring], ['cap', 7, 0.01]] });
  // The local square's entries (and a coin it collected) apply at once, in arrival order; the
  // collected coin's own ['p+'], still waiting, is applied just before its ['p-'].
  assert.deepStrictEqual(sink.entries.map(([t, e]) => [t, e[0], e[1]]), [[10, 'm', 7], [10, 'p+', 1], [14, 'p-', 1], [14, 'b', 7], [14, 'cap', 7]]);
  assert.strictEqual(net.timeline.length, 5);
  const at11 = net.takeDue(11).map(d => [d.tick, d.entry[0], d.entry[1]]);
  assert.deepStrictEqual(at11, [[10, 'm', 3], [10, 't', 3]]);
  assert.deepStrictEqual(net.takeDue(11.9), []);
  assert.deepStrictEqual(net.takeDue(13).map(d => [d.tick, d.entry[0]]), [[12, 'b']], 'the geo reply sits at its own tick');
  assert.deepStrictEqual(net.takeDue(14).map(d => [d.tick, d.entry[0], d.entry[1]]), [[14, 'm', 4], [14, 'k', 9]]);
  assert.deepStrictEqual(net.takeDue(1e9), []);
  // A killer that is the local square does not make the victim's kill local.
  assert.strictEqual(Net.subjectOf(['k', 9, 7, 3, 0, 0]), 9);
  assert.strictEqual(Net.subjectOf(['j', { id: 4 }]), 4);
  assert.strictEqual(Net.subjectOf(['p+', 1, 0, 0, 1]), 0);
  // Malformed bundles and entries are ignored, never thrown.
  socket.fire('pp:ev', null);
  socket.fire('pp:ev', { tick: 20, ev: 'nope' });
  socket.fire('pp:ev', { tick: 20, ev: [null, 5, ['x']] });
  assert.strictEqual(net.timeline.length, 1, 'only the well-formed ["x"] entry is queued (the mirror ignores unknown types)');
});

test("a coin the local square collects before its ['p+'] is due: the ['p+'] goes first, never after the ['p-']", () => {
  const { socket, sink, net } = kit({ you: 1, units: [{ id: 1, ver: 1, epoch: 0 }, { id: 2, ver: 1, epoch: 0 }] });
  socket.fire('pp:ev', { tick: 102, ev: [['p+', 7, 760, 700, 5000], ['k', 2, 0, 2, 5000, 7], ['p+', 8, 10, 10, 1]] });
  assert.deepStrictEqual(sink.entries, [], 'nothing names the local square yet');
  socket.fire('pp:ev', { tick: 104, ev: [['p-', 7, 1, 5000], ['m', 1, 5000]] });
  assert.deepStrictEqual(sink.entries.map(([t, e]) => [t, e[0], e[1]]), [[102, 'p+', 7], [104, 'p-', 7], [104, 'm', 1]]);
  assert.deepStrictEqual(net.takeDue(1e9).map(d => [d.tick, d.entry[0], d.entry[1]]), [[102, 'k', 2], [102, 'p+', 8]],
    'the collected coin left the timeline; every other entry waits as before');
  // A coin another square collects stays on the timeline, in tick order.
  socket.fire('pp:ev', { tick: 110, ev: [['p+', 9, 10, 10, 1]] });
  socket.fire('pp:ev', { tick: 112, ev: [['p-', 9, 2, 1]] });
  assert.strictEqual(sink.entries.length, 3);
  assert.deepStrictEqual(net.takeDue(1e9).map(d => [d.tick, d.entry[0]]), [[110, 'p+'], [112, 'p-']]);
});

test('the 7.2 trail rule: older epochs, repeats and gaps are ignored; overlaps append only the new part', () => {
  const held = { epoch: 3, count: 5 };
  assert.strictEqual(Net.trailMerge(held, 2, 0, 9), null, 'older epoch');
  assert.strictEqual(Net.trailMerge(held, 3, 0, 5), null, 'nothing newer');
  assert.strictEqual(Net.trailMerge(held, 3, 2, 3), null, 'nothing newer (overlap only)');
  assert.strictEqual(Net.trailMerge(held, 3, 6, 2), null, 'a gap');
  assert.deepStrictEqual(Net.trailMerge(held, 3, 5, 2), { reset: false, skip: 0, epoch: 3, count: 7 });
  assert.deepStrictEqual(Net.trailMerge(held, 3, 0, 8), { reset: false, skip: 5, epoch: 3, count: 8 }, 'a geo reply from 0');
  assert.deepStrictEqual(Net.trailMerge(held, 4, 0, 2), { reset: true, skip: 0, epoch: 4, count: 2 });
  assert.strictEqual(Net.trailMerge(held, 4, 3, 2), null, 'a new epoch that does not start at 0');
  assert.deepStrictEqual(Net.trailMerge({ epoch: 255, count: 1 }, 0, 0, 1).reset, true, 'the epoch wraps');
  assert.deepStrictEqual(Net.trailMerge({ epoch: -1, count: 0 }, 9, 0, 1).reset, true, 'nothing held takes any epoch from 0');
  assert.ok(Net.verNewer(1, 0) && Net.verNewer(0, 65535) && !Net.verNewer(3, 3) && !Net.verNewer(2, 3));
  assert.strictEqual(Net.blobCount(MP.encodePoints([{ x: 1, y: 1 }, { x: 2, y: 2 }])), 2);
  assert.strictEqual(Net.blobCount(new ArrayBuffer(1)), -1);
  assert.strictEqual(Net.blobCount('x'), -1);
});

test('pp:need after RESYNC_AFTER_MS of a version mismatch, within the 250 ms and 2000 ms limits', () => {
  const ring = MP.encodePoints([{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }]);
  const { clock, socket, net } = kit({ you: 1, tick: 0, at: 0, units: [{ id: 1, ver: 1, epoch: 0 }, { id: 5, ver: 3, epoch: 0 }] });
  const needs = () => socket.sent.filter(s => s[0] === 'pp:need').map(s => s[1].id);
  let tick = 0;
  const feed = (units, ms = 2 * STEP) => {
    tick += 2;
    clock.t += ms;
    socket.fire('pp:s', frame(tick, units));
  };
  const me = unit(1, { baseVer: 1 });
  for (let i = 0; i < 10; i++) feed([me, unit(5, { baseVer: 3 })]);
  assert.deepStrictEqual(needs(), [], 'in step: nothing asked');
  // The frame names ring version 4, only 3 was received.
  const start = clock.t + 2 * STEP;
  while (clock.t + 2 * STEP < start + MP.RESYNC_AFTER_MS) feed([me, unit(5, { baseVer: 4 })]);
  assert.deepStrictEqual(needs(), [], 'not before RESYNC_AFTER_MS');
  feed([me, unit(5, { baseVer: 4 })]);
  assert.deepStrictEqual(needs(), [5], 'asked once the mismatch is RESYNC_AFTER_MS old');
  const first = clock.t;
  while (clock.t + 2 * STEP < first + Net.NEED_UNIT_MS) feed([me, unit(5, { baseVer: 4 })]);
  assert.deepStrictEqual(needs(), [5], 'not again within 250 ms');
  feed([me, unit(5, { baseVer: 4 })]);
  assert.deepStrictEqual(needs(), [5, 5], 'again after 250 ms while still missing');
  socket.fire('pp:geo', { tick, ev: [['b', 5, 4, 0.1, ring]] });
  for (let i = 0; i < 40; i++) feed([me, unit(5, { baseVer: 4 })]);
  assert.deepStrictEqual(needs(), [5, 5], 'the reply ends it');
  // A lost trail batch: the frame says 3 corners went reliably, none arrived.
  const tStart = clock.t;
  while (clock.t < tStart + MP.RESYNC_AFTER_MS + 3 * STEP) feed([me, unit(5, { baseVer: 4, trailCount: 3 })]);
  assert.deepStrictEqual(needs(), [5, 5, 5], 'a trail count mismatch asks too');
  socket.fire('pp:geo', { tick, ev: [['t', 5, 0, 0, MP.encodePoints([{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }])]] });
  // A tail at the cap cannot be judged.
  for (let i = 0; i < 40; i++) feed([me, unit(5, { baseVer: 4, trailCount: 9, tail: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }] })]);
  // A new epoch whose corners are all still in the tail needs nothing.
  for (let i = 0; i < 40; i++) feed([me, unit(5, { baseVer: 4, trailEpoch: 1, trailCount: 2, tail: [{ x: 1, y: 1 }, { x: 2, y: 2 }] })]);
  assert.deepStrictEqual(needs(), [5, 5, 5]);
  // Many unknown squares at once: one request for everything, at most every 2000 ms.
  const five = unit(5, { baseVer: 4, trailCount: 3 });
  const many = [me, five];
  for (let id = 20; id < 26; id++) many.push(unit(id, { baseVer: 1 }));
  const mStart = clock.t;
  while (clock.t < mStart + MP.RESYNC_AFTER_MS + 3 * STEP) feed(many);
  assert.deepStrictEqual(needs(), [5, 5, 5, 0]);
  const allAt = clock.t;
  while (clock.t + 2 * STEP < allAt + Net.NEED_ALL_MS) feed(many);
  assert.deepStrictEqual(needs(), [5, 5, 5, 0], 'no burst of single requests in its wake');
  feed(many);
  assert.deepStrictEqual(needs(), [5, 5, 5, 0, 0], 'again after 2000 ms');
  // A square that leaves the frames stops counting.
  for (let i = 0; i < 80; i++) feed([me, five]);
  assert.deepStrictEqual(needs(), [5, 5, 5, 0, 0]);
  assert.strictEqual(net.mismatch.size, 0);
});

test('a reconnect sends pp:join with the resumeKey and no entryToken; a dead seat is not resumed', () => {
  const clock = { t: 0 };
  const socket = socketDouble();
  const net = new Net.ArenaNet({ socket, now: () => clock.t, onError: (w, e) => { throw e; } });
  net.join({ name: 'Ann', stake: 0.1, entryToken: 'TOKEN-1' });
  assert.deepStrictEqual(socket.sent, [['pp:join', { name: 'Ann', stake: 0.1, entryToken: 'TOKEN-1' }]]);
  socket.fire('connect');
  assert.strictEqual(socket.sent.length, 1, 'no resume before a seat exists');
  socket.fire('pp:joined', { you: 3, tick: 50, stake: 0.1, resumeKey: 'RK-9', resumed: false, units: [], rings: [], trails: [], pickups: [] });
  assert.strictEqual(net.seated, true);
  net.sendInput(MP.encodeInput(0, 10, false));
  assert.deepStrictEqual(socket.sent[1], ['pp:in', MP.encodeInput(0, 10, false), 'volatile']);
  socket.fire('disconnect', 'transport close');
  assert.strictEqual(net.connected, false);
  socket.fire('connect');
  const resume = socket.sent[socket.sent.length - 1];
  assert.deepStrictEqual(resume, ['pp:join', { name: 'Ann', stake: 0.1, resumeKey: 'RK-9' }]);
  assert.ok(!('entryToken' in resume[1]), 'no token key at all');
  assert.ok(!JSON.stringify(socket.sent.slice(1)).includes('TOKEN-1'), 'the token was sent exactly once');
  // The resumed state is a full reset, applied like a first join.
  socket.fire('pp:joined', { you: 3, tick: 400, stake: 0.1, resumeKey: 'RK-9', resumed: true, units: [], rings: [], trails: [], pickups: [] });
  assert.strictEqual(net.joinTick, 400);
  assert.strictEqual(net.stats.joins, 2);
  // Once the seat is gone (dead, cashed out, refused, replaced) nothing is resumed.
  socket.fire('pp:dead', { reason: 3, killerId: 4, killerName: 'x', lostMicro: 0, tick: 410 });
  assert.strictEqual(net.seated, false);
  const n = socket.sent.length;
  socket.fire('disconnect');
  socket.fire('connect');
  net.sendInput(1);
  assert.strictEqual(socket.sent.length, n, 'no pp:join and no pp:in for a dead seat');
  // An expired seat on reconnect (pp:refused) ends it too.
  const s2 = socketDouble();
  const n2 = new Net.ArenaNet({ socket: s2, now: () => 0 });
  const got = [];
  n2.on('pp:refused', (p) => got.push(p.why));
  n2.join({ name: 'B', stake: 0 });
  s2.fire('pp:joined', { you: 5, tick: 1, resumeKey: 'K2', units: [], rings: [], trails: [], pickups: [] });
  s2.fire('disconnect');
  s2.fire('connect');
  assert.deepStrictEqual(s2.sent[s2.sent.length - 1], ['pp:join', { name: 'B', stake: 0, resumeKey: 'K2' }]);
  s2.fire('pp:refused', { why: 'expired', text: 'gone', refunded: false });
  assert.deepStrictEqual(got, ['expired']);
  assert.strictEqual(n2.resumeKey, null);
});

test('no pp:in from the disconnect until the resume is joined (an old seq would shut out the fresh stream)', () => {
  const socket = socketDouble();
  const net = new Net.ArenaNet({ socket, now: () => 0, onError: (w, e) => { throw e; } });
  const ins = () => socket.sent.filter(s => s[0] === 'pp:in').length;
  net.join({ name: 'Ann', stake: 0, entryToken: 'T' });
  socket.fire('pp:joined', { you: 3, tick: 50, resumeKey: 'RK', units: [], rings: [], trails: [], pickups: [] });
  net.sendInput(MP.encodeInput(104, 10, false));
  assert.strictEqual(ins(), 1);
  assert.strictEqual(net.resuming, false);
  socket.fire('disconnect', 'transport close');
  assert.strictEqual(net.resuming, true);
  net.sendInput(MP.encodeInput(105, 10, false));
  socket.fire('connect');
  assert.deepStrictEqual(socket.sent[socket.sent.length - 1], ['pp:join', { name: 'Ann', stake: 0, resumeKey: 'RK' }]);
  assert.strictEqual(net.resuming, true, 'still resuming until pp:joined');
  net.sendInput(MP.encodeInput(106, 10, false));
  net.sendInput(MP.encodeInput(107, 10, false));
  assert.strictEqual(ins(), 1, 'nothing sent between the disconnect and pp:joined');
  socket.fire('pp:joined', { you: 3, tick: 120, resumeKey: 'RK', resumed: true, units: [], rings: [], trails: [], pickups: [] });
  assert.strictEqual(net.resuming, false);
  net.sendInput(MP.encodeInput(0, 10, false));
  assert.deepStrictEqual(socket.sent[socket.sent.length - 1], ['pp:in', MP.encodeInput(0, 10, false), 'volatile']);
  // A resume that ends the seat (refused, dead, replaced) ends the resume too.
  socket.fire('disconnect');
  socket.fire('connect');
  socket.fire('pp:refused', { why: 'expired' });
  assert.strictEqual(net.resuming, false);
  assert.strictEqual(net.seated, false);
  // A page that was never seated is never resuming.
  const s2 = socketDouble();
  const n2 = new Net.ArenaNet({ socket: s2, now: () => 0 });
  s2.fire('disconnect');
  s2.fire('connect');
  assert.strictEqual(n2.resuming, false);
});

test('ping at 1 Hz while seated; pong gives the round trip; respawn and leave', () => {
  const { clock, socket, net } = kit({ at: 5000 });
  net.update(5000);
  net.update(5500);
  net.update(6000);
  const pings = socket.sent.filter(s => s[0] === 'pp:ping');
  assert.deepStrictEqual(pings.map(p => p[1].t), [5000, 6000]);
  clock.t = 6080;
  socket.fire('pp:pong', { t: 6000, tick: 1 });
  assert.strictEqual(net.rtt, 80);
  net.respawn('TOK');
  net.respawn();
  net.leave();
  assert.deepStrictEqual(socket.sent.slice(-3), [['pp:respawn', { entryToken: 'TOK' }], ['pp:respawn', {}], ['pp:leave', undefined]]);
  assert.strictEqual(net.seated, false);
  net.update(9000);
  assert.strictEqual(socket.sent.filter(s => s[0] === 'pp:ping').length, 2, 'no ping once left');
});

// A socket that throws volatile emits away the way socket.io-client does: every send leaves the
// engine's transport unwritable until its drain (a microtask on a websocket), and a volatile
// emit made while it is unwritable is discarded. `drain()` is that microtask.
function engineSocket() {
  const s = socketDouble();
  s.discarded = [];
  const engine = {
    transport: { writable: true },
    listeners: [],
    once(ev, fn) { if (ev === 'drain') this.listeners.push(fn); }
  };
  s.io = { engine };
  const send = (ev, p, how) => {
    if (how === 'volatile' && !s.io.engine.transport.writable) {
      s.discarded.push([ev, p]);
      return;
    }
    s.sent.push(how ? [ev, p, how] : [ev, p]);
    s.io.engine.transport.writable = false;
  };
  s.emit = (ev, p) => send(ev, p);
  s.volatile = { emit: (ev, p) => send(ev, p, 'volatile') };
  s.drain = () => {
    const eng = s.io.engine;
    eng.transport.writable = true;
    const fns = eng.listeners;
    eng.listeners = [];
    fns.forEach((fn) => fn());
  };
  return s;
}

function seatedOn(socket, clock) {
  const net = new Net.ArenaNet({ socket, now: () => clock.t, onError: (w, e) => { throw e; } });
  net.join({ name: 'Ann', stake: 0 });
  socket.drain();
  socket.fire('pp:joined', { you: 3, tick: 50, resumeKey: 'RK', units: [], rings: [], trails: [], pickups: [] });
  socket.sent.length = 0;
  return net;
}

test('a frame\'s inputs leave as one pp:in: an integer for one tick, an array in order for more, at most INPUT_BATCH_MAX', () => {
  const { socket, net } = kit();
  const ins = () => socket.sent.filter(s => s[0] === 'pp:in');
  net.queueInput(11);
  assert.strictEqual(ins().length, 0, 'queued, not sent');
  net.flushInputs();
  assert.deepStrictEqual(ins(), [['pp:in', 11, 'volatile']]);
  net.queueInput(12);
  net.queueInput(13);
  net.flushInputs();
  assert.deepStrictEqual(ins()[1], ['pp:in', [12, 13], 'volatile']);
  net.flushInputs();
  assert.strictEqual(ins().length, 2, 'nothing waiting, nothing sent');
  for (let i = 0; i < MP.INPUT_BATCH_MAX + 3; i++) net.queueInput(100 + i);
  net.flushInputs();
  const big = ins()[2][1];
  assert.strictEqual(big.length, MP.INPUT_BATCH_MAX);
  assert.strictEqual(big[big.length - 1], 100 + MP.INPUT_BATCH_MAX + 2, 'the newest are kept');
});

test('nothing volatile is thrown away while the transport is busy: the ping and a second emit wait for the drain', () => {
  const clock = { t: 5000 };
  const socket = engineSocket();
  // The double is faithful: two volatile emits in one task lose the second.
  socket.volatile.emit('x', 1);
  socket.volatile.emit('x', 2);
  assert.deepStrictEqual(socket.discarded, [['x', 2]]);
  socket.drain();
  socket.discarded.length = 0;
  const net = seatedOn(socket, clock);
  // A frame: its input, then the ping that fell due (the old order lost the input to the ping).
  net.sendInput(21);
  net.update(clock.t);
  assert.deepStrictEqual(socket.sent, [['pp:in', 21, 'volatile']]);
  clock.t = 5000.4;
  socket.drain();
  assert.deepStrictEqual(socket.sent[1], ['pp:ping', { t: 5000.4 }, 'volatile'], 'the round trip starts when it leaves');
  socket.drain();
  // Two flushes in one task (a long frame split into sub-steps): the second waits.
  net.queueInput(22);
  net.flushInputs();
  net.queueInput(23);
  net.queueInput(24);
  net.flushInputs();
  assert.strictEqual(socket.sent.length, 3);
  socket.drain();
  assert.deepStrictEqual(socket.sent.slice(2), [['pp:in', 22, 'volatile'], ['pp:in', [23, 24], 'volatile']]);
  assert.deepStrictEqual(socket.discarded, [], 'nothing was discarded');
  assert.ok(net.stats.drainWaits >= 2);
});

test('a disconnect drops the inputs waiting for a drain; a wait left on the old engine never blocks the new one', () => {
  const clock = { t: 0 };
  const socket = engineSocket();
  const net = seatedOn(socket, clock);
  net.sendInput(31);
  net.sendInput(32);
  assert.deepStrictEqual(socket.sent, [['pp:in', 31, 'volatile']]);
  const oldEngine = socket.io.engine;
  socket.fire('disconnect', 'transport close');
  socket.io.engine = { transport: { writable: true }, listeners: [], once(ev, fn) { if (ev === 'drain') this.listeners.push(fn); } };
  socket.fire('connect');
  assert.deepStrictEqual(socket.sent[1], ['pp:join', { name: 'Ann', stake: 0, resumeKey: 'RK' }]);
  oldEngine.transport.writable = true;
  oldEngine.listeners.forEach((fn) => fn());
  socket.drain();
  assert.strictEqual(socket.sent.filter(s => s[0] === 'pp:in').length, 1, 'the old stream\'s input never went out');
  socket.fire('pp:joined', { you: 3, tick: 90, resumeKey: 'RK', resumed: true, units: [], rings: [], trails: [], pickups: [] });
  net.sendInput(0);
  net.sendInput(1);
  socket.drain();
  assert.deepStrictEqual(socket.sent.filter(s => s[0] === 'pp:in').slice(1), [['pp:in', 0, 'volatile'], ['pp:in', 1, 'volatile']]);
  assert.deepStrictEqual(socket.discarded, []);
});
