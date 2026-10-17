'use strict';
// Spectate on the client: ArenaNet's watch mode (pp:watch out, pp:watching in, frames and bundles with no
// `you`), the mirror's follow (the followed square stands in for player with no _local, no prediction, no
// reconcile, no input), and an end to end run of a real PaperRoom watched through the net into the mirror.
const test = require('node:test');
const assert = require('node:assert');
const { PaperRoom } = require('../server/paper/PaperRoom');
const { P, MP, REASON } = require('../server/paper/ArenaGame');
require('../public/js/paper/mp/paperPredict.js');
const Net = require('../public/js/paper/mp/paperNet.js');
const Mirror = require('../public/js/paper/mp/paperMirror.js');

const STEP = MP.STEP_MS;
const QPOS = Math.SQRT2 / (2 * MP.POS_SCALE); // worst rounding of a wire position
const PAL = P.playerColorPalette;

function socketDouble() {
  const s = {
    handlers: {},
    sent: [],
    on(ev, fn) { this.handlers[ev] = fn; },
    emit(ev, p) { this.sent.push([ev, p]); },
    fire(ev, p) { if (this.handlers[ev]) this.handlers[ev](p); },
    names() { return this.sent.map((x) => x[0]); }
  };
  s.volatile = { emit: (ev, p) => s.sent.push([ev, p, 'volatile']) };
  return s;
}

function sinkDouble() {
  return {
    joined: [],
    watched: [],
    entries: [],
    frames: [],
    applyJoined(p) { this.joined.push(p); },
    applyWatching(p) { this.watched.push(p); },
    applyEntry(e, tick) { this.entries.push([tick, e]); },
    onFrame(f) { this.frames.push(f); }
  };
}

function circle(x, y, r = 30, n = 50) {
  return P.makeCirclePoints(new P.Vec2(x, y), n, r).map((p) => ({ x: p.x, y: p.y }));
}

// pp:watching's state, hand-built: pp:joined's fields with no you and no resumeKey, plus follow.
function watching(units, extra = {}) {
  return Object.assign({
    arenaId: 'test',
    stake: 0,
    tick: 100,
    radius: 950,
    targetRadius: 950,
    holdTicks: MP.HOLD_TICKS,
    follow: units.length ? units[0].id : 0,
    units: units.map((u) => ({
      id: u.id, name: u.name || 'u' + u.id, skin: u.skin || null, bot: !!u.bot, x: u.x, y: u.y, dir: 0,
      inId: u.id, micro: u.micro || 0, pct: u.pct || 0.001, ver: 1, epoch: 0
    })),
    rings: units.map((u) => MP.encodePoints(circle(u.x, u.y))),
    trails: units.map(() => MP.encodePoints([])),
    pickups: []
  }, extra);
}

function four() {
  return [
    { id: 4, name: 'dee', skin: PAL[3], x: 1300, y: 1300, pct: 0.05 },
    { id: 1, name: 'ann', skin: PAL[0], x: 700, y: 700, pct: 0.3 },
    { id: 2, name: 'bob', skin: PAL[1], x: 1300, y: 700, pct: 0.2 },
    { id: 3, name: 'cat', skin: PAL[2], x: 700, y: 1300, pct: 0.1, bot: true }
  ];
}

function frame(tick, units = [], extra = {}) {
  return MP.encodeFrame(Object.assign({ tick, radius: 950, targetRadius: 950, units, pickups: [] }, extra));
}

function frameUnit(id, extra = {}) {
  return Object.assign({ id, x: 500, y: 500, dir: 0, pct: 0.01, baseVer: 0, trailEpoch: 0, trailCount: 0, tail: [] }, extra);
}

// ---- ArenaNet ------------------------------------------------------------------------------

test('watch sends pp:watch { stake: 0 } and nothing else; frames wait for the state; nothing applies on receipt', () => {
  const clock = { t: 100000 };
  const socket = socketDouble();
  const sink = sinkDouble();
  const net = new Net.ArenaNet({ socket, now: () => clock.t, sink, onError: (w, e) => { throw e; } });
  net.watch();
  assert.deepStrictEqual(socket.sent, [['pp:watch', { stake: 0 }]]);
  net.watch({ after: 7 });
  assert.deepStrictEqual(socket.sent[1], ['pp:watch', { stake: 0, after: 7 }]);
  // a paid rung's table (the page sets watchStake from the lobby's dsWatchStake): the stake to watch, nothing else
  net.watchStake = 0.5;
  net.watch();
  assert.deepStrictEqual(socket.sent[2], ['pp:watch', { stake: 0.5 }]);
  net.watchStake = 0;
  socket.sent.splice(2, 1);
  // Before the state: frames and bundles are not taken.
  socket.fire('pp:s', frame(101, [frameUnit(1)]));
  socket.fire('pp:ev', { tick: 101, ev: [['p+', 9, 1, 1, 100]] });
  assert.strictEqual(sink.frames.length, 0);
  assert.strictEqual(net.timeline.length, 0);
  socket.fire('pp:watching', watching(four()));
  assert.strictEqual(sink.watched.length, 1);
  assert.strictEqual(sink.joined.length, 0);
  assert.strictEqual(net.you, 0);
  assert.strictEqual(net.seated, false);
  assert.ok(net.watchOn);
  socket.fire('pp:s', frame(102, [frameUnit(1)]));
  assert.strictEqual(sink.frames.length, 1, 'frames apply while watching');
  // 'p+' names nobody (subject 0) and you is 0: it must wait for renderTick, never apply on receipt.
  socket.fire('pp:ev', { tick: 103, ev: [['p+', 9, 1, 1, 100], ['m', 1, 500], ['k', 2, 1, 3, 0, 0]] });
  assert.strictEqual(sink.entries.length, 0, 'nothing applied on receipt');
  assert.strictEqual(net.timeline.length, 3);
  // No input or ping ever goes out from a watcher.
  net.queueInput(5);
  net.flushInputs();
  net.update(clock.t + 5000);
  assert.ok(!socket.names().some((n) => n === 'pp:in' || n === 'pp:ping' || n === 'pp:join'), socket.names().join());
});

test('nothing to watch: none answers stop the stream; a pp:joined never comes from a watch; leave ends it', () => {
  const socket = socketDouble();
  const sink = sinkDouble();
  const net = new Net.ArenaNet({ socket, now: () => 1000, sink, onError: (w, e) => { throw e; } });
  const said = [];
  net.on('watching', (p) => said.push(p));
  // An answer nobody asked for is ignored.
  socket.fire('pp:watching', watching(four()));
  assert.strictEqual(sink.watched.length, 0);
  net.watch();
  socket.fire('pp:watching', { none: true, why: 'nobody' });
  assert.deepStrictEqual(said, [{ none: true, why: 'nobody' }]);
  assert.strictEqual(net.watchOn, false);
  socket.fire('pp:watching', watching(four()));
  assert.ok(net.watchOn);
  socket.fire('pp:watching', { none: true, why: 'closed' });
  socket.fire('pp:s', frame(150, [frameUnit(1)]));
  assert.strictEqual(sink.frames.length, 0, 'a dropped watcher takes no frames');
  net.leave();
  assert.deepStrictEqual(socket.sent[socket.sent.length - 1], ['pp:leave', undefined]);
  assert.strictEqual(net.watching, false);
  socket.fire('pp:watching', watching(four()));
  assert.strictEqual(sink.watched.length, 1, 'after leave, no state is taken');
});

test('a reconnect asks again once (no resumeKey); an ask buffered while the link was down is not doubled', () => {
  const socket = socketDouble();
  const net = new Net.ArenaNet({ socket, now: () => 1000, sink: sinkDouble(), onError: (w, e) => { throw e; } });
  net.watch(); // the first ask, made before the first connect (socket.io buffers it)
  socket.fire('connect');
  assert.strictEqual(socket.names().filter((n) => n === 'pp:watch').length, 1, 'the buffered ask is the one');
  socket.fire('pp:watching', watching(four()));
  socket.fire('disconnect', 'transport close');
  assert.strictEqual(net.watchOn, false);
  socket.fire('connect');
  const asks = socket.sent.filter((x) => x[0] === 'pp:watch');
  assert.strictEqual(asks.length, 2);
  assert.deepStrictEqual(asks[1][1], { stake: 0 }, 'no resumeKey, no token, no name');
  // Down again; the page asks while down (buffered), then the link comes back: still one ask.
  socket.fire('disconnect', 'transport close');
  net.watch();
  socket.fire('connect');
  assert.strictEqual(socket.sent.filter((x) => x[0] === 'pp:watch').length, 3);
  assert.ok(!socket.names().includes('pp:join'));
});

// ---- Mirror --------------------------------------------------------------------------------

function mirror() {
  const m = Mirror.create({ seed: 0.5 });
  m.onError = (e) => { throw e; };
  return m;
}

test('applyWatching follows the server pick as player, never _local; follow and followNext walk the score order', () => {
  const m = mirror();
  const follows = [];
  m.onFollow = (u) => follows.push(u ? u.id : 0);
  const pr = m.predictor;
  const stateBefore = JSON.stringify(pr.state);
  m.applyWatching(watching(four(), { follow: 2 }));
  assert.ok(m.watching);
  assert.strictEqual(m.you, 0);
  assert.strictEqual(m.player.id, 2);
  assert.strictEqual(m.followId, 2);
  assert.ok(m.units.every((u) => u._local === false), 'no square is the page\'s own');
  assert.strictEqual(JSON.stringify(pr.state), stateBefore, 'the predictor was never reset onto it');
  assert.ok(m.player.isPlayer, 'the stock labels show over the followed square');
  assert.deepStrictEqual(m.ranked().map((u) => u.id), [1, 2, 3, 4]);
  assert.strictEqual(m.followNext().id, 3);
  assert.strictEqual(m.followNext().id, 4);
  assert.strictEqual(m.followNext().id, 1, 'wraps round to the leader');
  assert.strictEqual(m.byId.get(4)._followed, false, 'only one square is followed');
  assert.strictEqual(m.follow(999), false);
  assert.strictEqual(m.player.id, 1);
  assert.deepStrictEqual(follows, [2, 3, 4, 1]);
  // followPrev (the Spectate bar's previous button) walks the other way, the leader round to the last.
  assert.strictEqual(m.followPrev().id, 4, 'wraps round to the last');
  assert.strictEqual(m.followPrev().id, 3);
  assert.strictEqual(m.followNext().id, 4);
  assert.strictEqual(m.followPrev().id, 3);
  assert.strictEqual(m.byId.get(4)._followed, false, 'only one square is followed');
  m.byId.get(3).death = true;
  assert.strictEqual(m.followPrev().id, 1, 'from a dead square: the leader');
  m.byId.get(3).death = false;
  m.watching = false;
  assert.strictEqual(m.followPrev(), null, 'never outside watch mode');
  m.watching = true;
  // A reconnect's state keeps the same square when it is still there, whatever the server picks.
  m.applyWatching(watching(four(), { follow: 4 }));
  assert.strictEqual(m.player.id, 1);
  // ... and takes the server pick when it is gone.
  m.applyWatching(watching(four().filter((u) => u.id !== 1), { follow: 3 }));
  assert.strictEqual(m.player.id, 3);
  m.update(STEP);
  assert.strictEqual(m.errors, 0);
});

test('a followed square is placed from the frames like a remote one: no reconcile, no prediction, no pp:in', () => {
  const clock = { t: 100000 };
  const socket = socketDouble();
  const net = new Net.ArenaNet({ socket, now: () => clock.t, onError: (w, e) => { throw e; } });
  const m = Mirror.create({ net, seed: 0.5 });
  m.onError = (e) => { throw e; };
  net.watch();
  socket.fire('pp:watching', watching(four(), { follow: 1 }));
  assert.strictEqual(m.player.id, 1);
  const recs = (tick, x) => [frameUnit(1, { x, y: 700, pct: 0.3 }), frameUnit(2, { x: 1300, y: 700, pct: 0.2 }),
    frameUnit(3, { x: 700, y: 1300, pct: 0.1 }), frameUnit(4, { x: 1300, y: 1300, pct: 0.05 })];
  for (let k = 1; k <= 30; k++) {
    clock.t += STEP * 2;
    socket.fire('pp:s', frame(100 + 2 * k, recs(100 + 2 * k, 700 + 2 * k)));
    m.update(STEP * 2);
  }
  assert.strictEqual(m.lastReconcile, null, 'never reconciled');
  assert.strictEqual(m.predictor.stats.compares, 0);
  assert.ok(m.player.position.x > 720 && m.player.position.x <= 760.01, 'it moves with its frames: ' + m.player.position.x);
  assert.ok(m.player.wire, 'its fields came from the frame');
  m.setHold(true);
  assert.ok(!m.predictor.holdKey, 'a watcher holds nothing');
  assert.ok(!socket.names().some((n) => n === 'pp:in' || n === 'pp:ping'), socket.names().join());
  // A reseat of the followed square snaps it, never the predictor.
  const before = JSON.stringify(m.predictor.state);
  m.applyEntry(['mv', 1, 900, 900], 200);
  assert.strictEqual(JSON.stringify(m.predictor.state), before);
  assert.strictEqual(m.errors, 0);
});

test('when the followed square dies the camera stays for the killer glide, then follows the leader', () => {
  const m = mirror();
  m.config.enemyKillDelay = 2000;
  m.config.selfKillDelay = 1000;
  m.applyWatching(watching(four(), { follow: 2 }));
  const two = m.player;
  // 1 cuts 2: player stays on the dead square, its killer set (the stock followKiller glide).
  m.applyEntry(['k', 2, 1, 3, 0, 0], 101);
  assert.ok(m.player === two && two.death && two.killer === m.byId.get(1));
  for (let t = 0; t < 1900; t += STEP) m.update(STEP);
  assert.strictEqual(m.player, two, 'still gliding to the killer');
  for (let t = 0; t < 200; t += STEP) m.update(STEP);
  assert.strictEqual(m.player.id, 1, 'the leader after the glide');
  assert.strictEqual(two._followed, false);
  // A death with no killer moves on after the shorter delay; Next during the wait moves at once.
  m.applyEntry(['k', 1, 0, 2, 0, 0], 102);
  for (let t = 0; t < 1100; t += STEP) m.update(STEP);
  assert.strictEqual(m.player.id, 3, 'the next leader');
  m.applyEntry(['k', 3, 0, 2, 0, 0], 103);
  m.followNext();
  assert.strictEqual(m.player.id, 4);
  // The last square gone: nobody is followed (the camera goes to the arena centre).
  m.applyEntry(['k', 4, 0, 2, 0, 0], 104);
  for (let t = 0; t < 1100; t += STEP) m.update(STEP);
  assert.strictEqual(m.player, null);
  assert.strictEqual(m.followId, 0);
  // A square arriving later is followed straight away.
  m.applyEntry(['j', { id: 9, name: 'new', skin: PAL[4], bot: false, micro: 0, x: 900, y: 900 }], 105);
  m.update(STEP);
  assert.strictEqual(m.player.id, 9);
  assert.strictEqual(m.errors, 0);
});

test('a seated page never follows: follow and followNext do nothing outside watch mode', () => {
  const m = mirror();
  const p = watching(four());
  p.you = 1;
  p.resumeKey = 'RK';
  m.applyJoined(p);
  assert.ok(m.player._local && m.player.id === 1);
  assert.strictEqual(m.follow(2), false);
  assert.strictEqual(m.followNext(), null);
  assert.strictEqual(m.player.id, 1);
  assert.ok(m.player._local);
});

// ---- End to end: a real arena watched through the net into the mirror -----------------------

test('end to end: a watcher of a real PaperRoom sees every square where the server has it, and sends no input', () => {
  const clock = { t: 1000000 };
  const q = [];
  const io = {
    to: (target) => ({
      emit: (ev, p) => q.push([target, ev, p]),
      volatile: { emit: (ev, p) => q.push([target, ev, p]) }
    })
  };
  const hooks = {};
  for (const h of ['onCashout', 'onTransfer', 'onRefund', 'onSweep', 'onBreach']) hooks[h] = () => {};
  const room = new PaperRoom({ stake: 0, io, hooks, now: () => clock.t, autoTick: false, seed: 0.42 });
  for (let i = 0; i < 200; i++) {
    clock.t += STEP;
    room.tickOnce();
  }
  const playerSock = { id: 'p1', rooms: new Set(), join(r) { this.rooms.add(r); }, leave(r) { this.rooms.delete(r); }, emit() {} };
  const seat = room.addHuman(playerSock, { name: 'pat', micro: 0, wallet: null, spot: room.findSpawn() });
  q.length = 0;
  // The watcher: its server-side socket and the client socket the net listens on.
  const handlers = {};
  const sent = [];
  const client = {
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev, p) {
      sent.push([ev, p]);
      if (ev === 'pp:watch') room.addWatcher(server, p.after);
      if (ev === 'pp:need') q.push(['w1', 'pp:geo', MP.packBin(room.geo(p.id))]);
    },
    volatile: { emit(ev, p) { sent.push([ev, p]); } }
  };
  const server = {
    id: 'w1', rooms: new Set(),
    join(r) { this.rooms.add(r); }, leave(r) { this.rooms.delete(r); },
    emit(ev, p) { q.push(['w1', ev, p]); }
  };
  function deliver() {
    while (q.length) {
      const [target, ev, p] = q.shift();
      if (target !== 'w1' && !(target === room.ioRoom && server.rooms.has(room.ioRoom))) continue;
      if (handlers[ev]) handlers[ev](p);
    }
  }
  const net = new Net.ArenaNet({ socket: client, now: () => clock.t, onError: (w, e) => { throw e; } });
  const m = Mirror.create({ net, seed: 0.5 });
  m.onError = (e) => { throw e; };
  net.watch();
  deliver();
  assert.ok(net.watchOn, 'the state arrived');
  assert.strictEqual(room.liveHumans, 1);
  assert.strictEqual(room.watchers.size, 1);
  const leader = room.followFor(0);
  assert.strictEqual(m.player.id, leader);
  const steer = (tick) => (tick * 2 * Math.PI) / 180;
  let seq = 0;
  for (let i = 0; i < 240; i++) {
    room.setInput('p1', MP.encodeInput(++seq & 255, Math.round((steer(room.game.tick) * 127) / Math.PI), false));
    clock.t += STEP;
    m.update(STEP);
    room.tickOnce();
    deliver();
  }
  // Land the render clock on the newest frame and compare every square.
  const T = net.lastFrameTick;
  clock.t = Math.max(clock.t, (T + 1e-6 + (MP.INTERP_DELAY_MS + net.jitterBuf) / STEP) * STEP - net.clockOffset);
  m.update(1e-4);
  assert.strictEqual(room.game.tick, T);
  assert.deepStrictEqual(m.units.map((u) => u.id).sort((a, b) => a - b), room.game.units.map((u) => u.id).sort((a, b) => a - b));
  let compared = 0;
  for (const u of room.game.units) {
    const mu = m.byId.get(u.id);
    assert.ok(mu, 'the mirror has square ' + u.id);
    const err = Math.hypot(mu.position.x - u.position.x, mu.position.y - u.position.y);
    assert.ok(err <= QPOS + 1e-9, 'square ' + u.id + ' off by ' + err);
    compared++;
  }
  assert.ok(compared >= 3, 'compared ' + compared);
  assert.ok(m.player && !m.player._local);
  assert.strictEqual(m.errors, 0);
  assert.strictEqual(net.stats.badFrames, 0);
  assert.ok(!sent.some((s) => s[0] === 'pp:in' || s[0] === 'pp:join' || s[0] === 'pp:ping'), sent.map((s) => s[0]).join());
  // The player's own seat is untouched by the watch, and the watcher is no seat.
  assert.ok(room.hasLiveUnit('p1'));
  assert.strictEqual(room.seatOfSocket('w1'), null);
  assert.strictEqual(room.bank.openIds().length, 1);
  // The player leaves: the arena stops ticking and the watcher hears it.
  const told = [];
  net.on('watching', (p) => told.push(p));
  room.removeHuman(seat.unit.id, REASON.FORCED_EXIT);
  deliver();
  assert.deepStrictEqual(told, [{ none: true, why: 'nobody' }]);
  assert.strictEqual(net.watchOn, false);
});
