'use strict';
/* Crossy Road: the shared step (the reference's rules), how a duel is judged on two timelines, and the seat and
   money rules of its lobby (Knockout's, through KnockoutLobby / KnockoutRoom and duelQueue.js). */
const test = require('node:test');
const assert = require('node:assert');
const S = require('../shared/crossySim');
const { CrossyRoom, LAG_MAX } = require('../server/crossy/CrossyRoom');
const { CrossyLobby } = require('../server/crossy/CrossyLobby');
const { CrossyBot, SHARP } = require('../server/crossy/crossyBot');
const { IN } = S;

const fakeIo = () => {
  const sent = [];
  const room = (name) => ({
    emit: (ev, p) => sent.push({ to: name, ev, p }),
    volatile: { emit: (ev, p) => sent.push({ to: name, ev, p, volatile: true }) },
  });
  return { sent, to: room };
};
let sid = 0;
const sock = (id) => {
  const got = [];
  return { id: id || 'sock' + (++sid), got, emit: (ev, p) => got.push({ ev, p }), join() {}, leave() {} };
};

/* A safe map to test rules on: rows chosen by hand. */
function handWorld(rows) {
  const w = new S.World(1);
  for (const [r, row] of Object.entries(rows)) w.rows.set(Number(r), Object.assign({ r: Number(r), h: 0.375, cells: new Int8Array(9), look: new Int8Array(9), coin: null, alt: 0 }, row));
  w.next = 1e9;
  const grass = { kind: 'grass', type: 'grass', name: 'grass' };
  return new Proxy(w, { get(t, k) { if (k === 'row') return (r) => t.rows.get(r) || (t.rows.set(r, Object.assign({ r, h: 0.375, cells: new Int8Array(9), look: new Int8Array(9), coin: null, alt: 0 }, grass)), t.rows.get(r)); return t[k]; } });
}

/* ── the map ─────────────────────────────────────────────────────────── */
test('the map is the same on every machine: same seed, same rows, same traffic, asked in any order', () => {
  const a = new S.World(777), b = new S.World(777);
  b.row(60);                                     // made ahead of time on one, not the other
  for (let r = -8; r < 60; r++) {
    const x = a.row(r), y = b.row(r);
    assert.strictEqual(x.name, y.name);
    assert.deepStrictEqual([...x.cells], [...y.cells]);
    if (x.kind === 'road') {
      assert.deepStrictEqual(S.carsAt(x, 40.25, []), S.carsAt(y, 40.25, []));
      assert.deepStrictEqual(S.carsAt(x, 3.5, []), S.carsAt(y, 3.5, []), 'an earlier time after a later one');
    }
    if (x.type === 'log') assert.deepStrictEqual(S.logsAt(x, 33.3, []).map(l => [l.x, l.w]), S.logsAt(y, 33.3, []).map(l => [l.x, l.w]));
    if (x.kind === 'rail') assert.deepStrictEqual(S.trainAt(x, 50), S.trainAt(y, 50));
  }
});

test('the start is the reference\'s: a field row, two full forest rows, six open grass rows, then chunks', () => {
  const w = new S.World(5);
  assert.strictEqual(w.row(-8).name, 'field-mid');
  assert.strictEqual(w.row(-7).name, 'start-forest');
  assert.strictEqual(w.row(-6).name, 'start-forest');
  for (let r = -5; r <= 0; r++) assert.strictEqual(w.row(r).name, 'grass-start');
  assert.ok([...w.row(-6).cells].every(c => c !== 0), 'the forest row is a wall');
  // A grass row never blocks the middle column (x = 0), so there is always a way forward on grass.
  for (let r = 1; r < 400; r++) { const row = w.row(r); if (row.name === 'grass') assert.strictEqual(row.cells[4], 0); }
});

test('car and log speeds stay in the reference\'s range at the start (2..4, logs 1..5)', () => {
  const w = new S.World(9);
  for (let r = 1; r < 300; r++) {
    const row = w.row(r);
    // min(2 + random x F, 7), F = 2 + min((row - 18) / 1000, 5): 2 to just over 4 this early
    if (row.kind === 'road') assert.ok(row.speed >= 2 && row.speed < 4 + Math.max(0, r - 18) / 1000, 'car ' + row.speed);
  }
});

test('the ramp: lane time runs at 1x for 45 s, then speeds up to 2x and stays', () => {
  assert.strictEqual(S.laneTime(45 * 60), 45);
  assert.ok(Math.abs(S.rampAt(60 * 60) - 1.18) < 1e-9);
  assert.strictEqual(S.rampAt(200 * 60), 2);
  const a = S.laneTime(200 * 60), b = S.laneTime(201 * 60);
  assert.ok(Math.abs(b - a - 2) < 1e-9);
});

/* ── the hopper ─────────────────────────────────────────────────────── */
test('a hop: one cell, the next only after 9 ticks, a blocked move waits (and is kept), the side limit holds', () => {
  const w = handWorld({ [-1]: { kind: 'grass', type: 'grass' } });
  const tree = w.row(-1); tree.cells[4] = 2;     // a tree straight ahead
  const h = S.newHopper();
  S.step(w, h, IN.FWD);
  assert.strictEqual(h.r, -2, 'blocked: no hop');
  assert.strictEqual(h.pend, IN.FWD, 'and the move is kept, as in the reference');
  S.step(w, h, IN.RIGHT);
  assert.strictEqual(h.x, 1);
  for (let i = 0; i < 8; i++) S.step(w, h, i === 0 ? IN.FWD : 0);
  assert.strictEqual(h.r, -2, 'too soon');
  S.step(w, h, 0);
  assert.strictEqual(h.r, -1, 'the kept forward fires once allowed');
  const g = S.newHopper(); g.x = 3.6;
  S.step(w, g, IN.RIGHT);
  assert.strictEqual(g.x, 4, 'snapped to the cell on grass');
});

test('the eagle comes after 5 s without moving forward; a forward hop buys a second, a back hop costs one', () => {
  const w = handWorld({});
  const h = S.newHopper();
  for (let i = 0; i < 302 && h.alive; i++) S.step(w, h, 0);
  assert.strictEqual(h.alive, false);
  assert.strictEqual(h.death, 'eagle');
  assert.strictEqual(h.deadTick, 300, 'the eagle comes once its clock is past 5 s');
  const g = S.newHopper();
  for (let i = 0; i < 240; i++) S.step(w, g, 0);
  S.step(w, g, IN.FWD);
  assert.ok(Math.abs(g.eagle - (241 / 60 - 1)) < 1e-9);
  for (let i = 0; i < 9; i++) S.step(w, g, 0);
  S.step(w, g, IN.BACK);
  assert.ok(g.eagle > 241 / 60 - 1 + 9 / 60 + 1 - 1e-9);
});

test('a car on the target cell is a hit at once; the next lane over is not', () => {
  const road = { kind: 'road', type: 'car', h: 0.25, dir: 1, speed: 2, t0: -3, mini: 0, gapN: 0, spawns: [], car: { id: 'sedan', hx: 1.6 } };
  const w = handWorld({ [-1]: road });
  // The first car spawned at x = -12.5 at lane time -3 s.
  const h = S.newHopper();
  for (let i = 0; i < 280 && h.alive; i++) S.step(w, h, i === 0 ? IN.FWD : 0);
  // standing in the road: hit when |x - car| < (0.29 + 1.6) / 2, i.e. car x > -0.945
  assert.strictEqual(h.alive, false);
  assert.strictEqual(h.death, 'car');
  const hitAt = h.deadTick * S.DT;
  assert.ok(Math.abs(hitAt - ((12.5 - 0.945) / 2 - 3)) < 1 / 30, 'hit at ' + hitAt);
});

test('water: landing with no log or lily drowns when the arc ends (14 ticks); a log carries you, off the edge is out', () => {
  const lily = { kind: 'water', type: 'lily', h: 0.45, lilies: [0] };
  const w = handWorld({ [-1]: lily });
  const h = S.newHopper(); h.x = 1;
  S.step(w, h, IN.FWD);
  assert.ok(h.water);
  for (let i = 0; i < 13; i++) S.step(w, h, 0);
  assert.strictEqual(h.alive, true);
  S.step(w, h, 0);
  assert.strictEqual(h.alive, false);
  assert.strictEqual(h.death, 'water');
  const ok = S.newHopper();
  S.step(w, ok, IN.FWD);
  for (let i = 0; i < 30; i++) S.step(w, ok, 0);
  assert.strictEqual(ok.alive, true, 'on the lily');

  const logs = { kind: 'water', type: 'log', h: 0.395, dir: 1, speed: 1, gapMax: 2, w0: 3, t0: -100, poop: false, cur: 0, spawns: [], ws: [], R: S.rng(1) };
  const w2 = handWorld({ [-1]: logs });
  const L = S.logsAt(logs, 0, []).find(l => Math.abs(l.x) < 4);
  assert.ok(L, 'a log is in the field');
  const g = S.newHopper(); g.x = Math.round(L.x);
  S.step(w2, g, IN.FWD);
  g.eagle = -1e9;                                // no eagle in this one
  assert.ok(g.log >= 0, 'on the log');
  const x0 = g.x;
  for (let i = 0; i < 60 && g.alive; i++) S.step(w2, g, 0);
  if (g.alive) assert.ok(Math.abs(g.x - x0 - 1) < 0.05, 'carried 1 unit in a second');
  for (let i = 0; i < 900 && g.alive; i++) S.step(w2, g, 0);
  assert.strictEqual(g.death, 'log', 'carried off the edge');
});

test('a hop from a log onto a lily lands on the lily (it used to drown every time)', () => {
  const logs = { kind: 'water', type: 'log', h: 0.395, dir: 1, speed: 1, gapMax: 2, w0: 3, t0: -100, poop: false, cur: 0, spawns: [], ws: [], R: S.rng(1) };
  const lily = { kind: 'water', type: 'lily', h: 0.45, lilies: [-4, -3, -2, -1, 0, 1, 2, 3, 4] };
  const w = handWorld({ [-1]: logs, [0]: lily });
  const L = S.logsAt(logs, 0, []).find(l => Math.abs(l.x) < 3);
  assert.ok(L, 'a log is in the field');
  const h = S.newHopper(); h.x = Math.round(L.x); h.eagle = -1e9;
  S.step(w, h, IN.FWD);
  assert.ok(h.log >= 0, 'on the log');
  for (let i = 0; i < 20; i++) S.step(w, h, 0);
  assert.ok(h.x !== Math.round(h.x), 'riding between cells');
  S.step(w, h, IN.FWD);
  for (let i = 0; i < 30; i++) S.step(w, h, 0);
  assert.strictEqual(h.alive, true, 'died: ' + h.death);
  assert.strictEqual(h.r, 0);
  assert.strictEqual(h.lily, true);
  assert.strictEqual(h.water, false);
  assert.strictEqual(h.x, Math.round(h.x), 'on a lily cell');
});

test('a hopper packs and unpacks to the same hopper', () => {
  const w = new S.World(3), h = S.newHopper();
  for (let i = 0; i < 100; i++) S.step(w, h, i % 12 === 0 ? IN.FWD : 0);
  const back = S.unpackHopper(S.packHopper(h));
  const a = S.copyHopper(h), b = S.copyHopper(back);
  for (let i = 0; i < 60; i++) { S.step(w, a, i === 3 ? IN.FWD : 0); S.step(w, b, i === 3 ? IN.FWD : 0); }
  assert.deepStrictEqual(S.packHopper(a), S.packHopper(b));
});

/* ── the room: two timelines ───────────────────────────────────────────── */
function duel(now) {
  const io = fakeIo();
  const room = new CrossyRoom(io);
  room.world = handWorld({});          // an empty field: nothing but the eagle
  room.addPlayer(sock('a'), 'Ann', 'WA', 1, 1);
  room.addPlayer(sock('b'), 'Bob', 'WB', 1, 1);
  room.stake = 1;
  const settles = [];
  room.onSettled = (r) => settles.push(r);
  room.start(now);
  return { room, io, settles };
}
const at = (room, tick) => room.goAt + tick * S.TICK_MS + 0.5;

test('the first one out loses; it is only decided once both timelines have reached that tick', () => {
  const { room, settles } = duel(1000);
  room.tick(at(room, 0));
  // Ann hops forward every 30 ticks; Bob never does, so the eagle takes him at tick 300.
  for (let t = 1; t <= 400 && room.state === 'playing'; t++) {
    room.input('a', { t: t - 1, h: (t - 1) % 30 === 0 ? [[t - 1, IN.FWD]] : [] });
    room.input('b', { t: t - 1 });
    room.tick(at(room, t));
  }
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.winner, 'a');
  assert.strictEqual(room.endTick, 300);
  assert.strictEqual(settles.length, 1);
  assert.strictEqual(settles[0].pot, 2);
});

test('both out on the same tick is a draw, and settles once', () => {
  const { room, settles, io } = duel(1000);
  room.tick(at(room, 0));
  for (let t = 1; t <= 320 && room.state === 'playing'; t++) {
    room.input('a', { t: t - 1 }); room.input('b', { t: t - 1 });
    room.tick(at(room, t));
  }
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.winner, null);
  assert.strictEqual(room.overWhy, 'both out');
  assert.strictEqual(settles.length, 1);
  assert.strictEqual(settles[0].winnerId, null);
  room.finish('a', 'again');
  assert.strictEqual(settles.length, 1, 'never twice');
  const over = io.sent.filter(m => m.ev === 'cr:over');
  assert.strictEqual(over.length, 1);
  assert.ok(over[0].p.money && over[0].p.money.refunded);
});

test('both out on the same tick with more coins wins (Owen 2026-10-28)', () => {
  const { room, settles } = duel(1000);
  room.tick(at(room, 0));
  room.players.get('b').cr.h.coins = 2;
  room.players.get('a').cr.h.coins = 1;
  for (let t = 1; t <= 320 && room.state === 'playing'; t++) {
    room.input('a', { t: t - 1 }); room.input('b', { t: t - 1 });
    room.tick(at(room, t));
  }
  assert.strictEqual(room.winner, 'b');
  assert.strictEqual(room.overWhy, 'more coins');
  assert.strictEqual(settles.length, 1);
  assert.strictEqual(settles[0].winnerId, 'b');
});

test('a stalled seat is moved on with nothing pressed once it is LAG_MAX behind; late hops are not replayed into the past', () => {
  const { room } = duel(1000);
  room.tick(at(room, 0));
  for (let t = 1; t <= 120; t++) { room.input('a', { t: t - 1 }); room.tick(at(room, t)); }
  const b = room.players.get('b').cr.h;
  assert.ok(b.tick >= 120 - LAG_MAX - 2, 'b moved on: ' + b.tick);
  const before = b.r;
  room.input('b', { t: 10, h: [[10, IN.FWD]] });        // a hop for a tick long gone
  room.tick(at(room, 121));
  assert.strictEqual(b.r, before, 'ignored');
});

test('hops are checked: only whole ticks, only moves 1-4, never ahead of the clock, a few at a time', () => {
  const { room } = duel(1000);
  room.tick(at(room, 0));
  room.tick(at(room, 5));
  assert.strictEqual(room.input('a', { t: 5 + 999, h: [] }), false, 'too far ahead');
  assert.strictEqual(room.input('a', { t: 1.5 }), false);
  assert.strictEqual(room.input('a', { t: 5, h: new Array(9).fill([5, 1]) }), false, 'too many');
  assert.strictEqual(room.input('a', null), false);
  room.input('a', { t: 6, h: [[6, 9], [6, 'x'], ['6', 1], [6]] });
  for (let t = 6; t <= 8; t++) room.tick(at(room, t));
  assert.strictEqual(room.players.get('a').cr.h.r, S.C.START_ROW, 'nothing malformed moved it');
  assert.strictEqual(room.input('zz', { t: 6 }), false, 'not a seat');
});

test('walking out forfeits to the one who stayed, while both are still alive', () => {
  const a = duel(1000);
  a.room.tick(at(a.room, 0));
  for (let t = 1; t <= 10; t++) { a.room.input('a', { t: t - 1 }); a.room.input('b', { t: t - 1 }); a.room.tick(at(a.room, t)); }
  a.room.removePlayer('a');
  assert.strictEqual(a.settles.length, 0, 'the stayer gets a moment to reach the leave on its own timeline');
  assert.strictEqual(a.room.input('a', { t: 11, h: [[11, IN.FWD]] }), false, 'nothing more from the seat that left');
  for (let t = 11; t <= 60 && a.room.state === 'playing'; t++) { a.room.input('b', { t: t - 1 }); a.room.tick(at(a.room, t)); }
  assert.strictEqual(a.room.winner, 'b');
  assert.strictEqual(a.room.overWhy, 'opponent left');
  assert.strictEqual(a.settles[0].winnerId, 'b');
});

test('a slow event loop cannot let a silent seat trail without limit (Opus review 2026-10-28)', () => {
  // A sends nothing (the eagle takes it at 300); B hops on time and dies later. Ticked at 20 Hz, A is still judged.
  const { room } = duel(1000);
  room.tick(at(room, 0));
  for (let t = 3; t <= 420 && room.state === 'playing'; t += 3) {
    room.input('b', { t: t - 1, h: (t - 3) % 30 === 0 && t < 330 ? [[t - 1, IN.FWD]] : [] });
    room.tick(at(room, t));
  }
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.winner, 'b');
  assert.strictEqual(room.overWhy, 'taken by the eagle');
});

test('a room that throws ends as a draw with refunds, and takes nothing else down', () => {
  const { room, settles } = duel(1000);
  room.tick(at(room, 0));
  room.tickInner = () => { throw new Error('boom'); };
  room.tick(at(room, 5));
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(settles[0].winnerId, null);
});

test('leaving never undoes a death the timelines decide (Fable review 2026-10-28)', () => {
  // B is taken by the eagle at tick 300; A has been hopping forward but its timeline trails. A leaves at once:
  // stepped to the clock with what it sent, A is alive past 300, so B was out first and A is paid.
  const x = duel(1000);
  x.room.tick(at(x.room, 0));
  for (let t = 1; t <= 305; t++) {
    if (t < 280) x.room.input('a', { t: t - 1, h: (t - 1) % 30 === 0 ? [[t - 1, IN.FWD]] : [] });
    x.room.input('b', { t: t - 1 });
    x.room.tick(at(x.room, t));
  }
  assert.strictEqual(x.room.state, 'playing', 'not judged yet: A trails');
  x.room.removePlayer('a');
  assert.strictEqual(x.room.winner, 'a');
  assert.strictEqual(x.settles[0].winnerId, 'a');
  // A is out (eagle at 300) ahead of B's timeline, then leaves: B is judged as its hops arrive, alive past 300, wins.
  const y = duel(1000);
  y.room.tick(at(y.room, 0));
  for (let t = 1; t <= 310; t++) {
    y.room.input('a', { t: t - 1 });
    if (t < 250) y.room.input('b', { t: t - 1, h: (t - 1) % 30 === 0 ? [[t - 1, IN.FWD]] : [] });
    y.room.tick(at(y.room, t));
  }
  assert.ok(!y.room.players.get('a').cr.h.alive);
  y.room.removePlayer('a');
  assert.strictEqual(y.settles.length, 0, 'kept until the timeline of B gets there');
  for (let t = 311; t <= 330 && y.room.state === 'playing'; t++) { y.room.input('b', { t: t - 1 }); y.room.tick(at(y.room, t)); }
  assert.strictEqual(y.room.winner, 'b');
  assert.strictEqual(y.settles.length, 1);
});

test('the safety stop: five minutes, further along wins', () => {
  const { room } = duel(1000);
  for (const id of ['a', 'b']) { const h = room.players.get(id).cr.h; h.tick = S.DUEL.MAX_TICKS + 1; }
  room.players.get('a').cr.h.best = 40;
  room.players.get('b').cr.h.best = 39;
  room.state = 'playing';
  assert.strictEqual(room.judge(), true);
  assert.strictEqual(room.winner, 'a');
  assert.strictEqual(room.overWhy, 'time');
});

test('watchers get seats, never socket ids', () => {
  const { room } = duel(1000);
  const ws = room.watchSnapshot(Date.now());
  const j = JSON.stringify(ws);
  assert.ok(!j.includes('"a"') && !j.includes('"b"'));
  assert.ok(ws.players.every(p => !('id' in p)));
  assert.strictEqual(room.forWatchers('cr:in', {}), null);
});

/* ── the lobby: Knockout's seats and money ───────────────────────────── */
function lobbyWith() {
  const io = fakeIo();
  const lobby = new CrossyLobby(io);
  const refunds = [], settles = [];
  lobby.onRefund = (r) => refunds.push(r);
  lobby.onSettled = (r) => settles.push(r);
  return { lobby, io, refunds, settles };
}

test('a free seat plays the bot after the wait; a paid seat never does, and Cancel refunds once', () => {
  const { lobby, refunds } = lobbyWith();
  const f = sock(), p = sock();
  const t0 = 1e6;
  lobby.enqueue(f, 'Free', null, 0, 0, t0);
  lobby.enqueue(p, 'Paid', 'WP', 1, 1, t0, 1);
  lobby.tick(t0 + CrossyLobby.FREE_WAIT_MS + 1);
  const room = [...lobby.rooms.values()][0];
  assert.ok(room && room.bot && room.stake === 0 && room.players.has(f.id));
  assert.ok(room.players.get(room.bot.id).cr.bot, 'the bot seat has its driver');
  assert.ok(lobby.queue.some(e => e.socket.id === p.id), 'the paid seat is still waiting');
  lobby.leave(p.id);
  lobby.leave(p.id);
  assert.strictEqual(refunds.length, 1);
  assert.deepStrictEqual([refunds[0].wallet, refunds[0].amount], ['WP', 1]);
});

test('two paid people at the same rung meet; the pot is both stakes; leaving mid-match pays the other once', () => {
  const { lobby, settles } = lobbyWith();
  const a = sock(), b = sock();
  lobby.enqueue(a, 'A', 'WA', 0.5, 0.5, 1, 0.5);
  lobby.enqueue(b, 'B', 'WB', 0.5, 0.5, 2, 0.5);
  const room = [...lobby.rooms.values()][0];
  assert.ok(room && !room.bot);
  assert.strictEqual(room.pot(), 1);
  lobby.tick(room.goAt + 100);
  lobby.leave(a.id);
  lobby.leave(a.id);
  // The one who stayed is given a moment to reach the leave on its own timeline, then wins it.
  for (let ms = 120; ms < 1200 && settles.length === 0; ms += 17) {
    room.input(b.id, { t: Math.max(0, Math.floor(ms / S.TICK_MS) - 1) });
    lobby.tick(room.goAt + ms);
  }
  assert.strictEqual(settles.length, 1);
  assert.strictEqual(settles[0].winnerId, b.id);
});

test('a restart owes every paid seat it holds, queued or playing, and nothing twice', () => {
  const { lobby, refunds, settles } = lobbyWith();
  const a = sock(), b = sock(), q = sock();
  lobby.enqueue(a, 'A', 'WA', 1, 1, 1, 1);
  lobby.enqueue(b, 'B', 'WB', 1, 1, 2, 1);
  lobby.enqueue(q, 'Q', 'WQ', 0.5, 0.5, 3, 0.5);
  const rows = lobby.shutdownSettle('shutdown');
  assert.strictEqual(rows.length, 3);
  assert.ok(rows.every(r => /^refund crossy /.test(r.reason) && r.key.startsWith('agowed:')));
  const room = [...lobby.rooms.values()][0];
  room.finish('a', 'x');
  assert.strictEqual(settles.length, 0);
  assert.strictEqual(refunds.length, 0);
});

test('the bot plays by the same rules and gets somewhere', () => {
  const w = new S.World(4242), h = S.newHopper(), bot = new CrossyBot(S.rng(7));
  for (let t = 0; t < 1800 && h.alive; t++) S.step(w, h, bot.input(w, h));
  assert.ok(S.score(h) >= 5, 'score ' + S.score(h));
});

/* ── the map on the wire: lanes, never a seed (Owen 2026-10-28) ─────────────── */
const crypto = require('crypto');
const keyedWorld = (key) => {
  const h = (s) => crypto.createHmac('sha256', key).update(s).digest().readUInt32LE(0);
  let n = 0;
  return new S.World({ chunk: () => h('chunk:' + (n++)) / 4294967296, row: (r) => h('row:' + r) });
};

test('a screen\'s map made only from the lanes it was sent steps every hopper exactly as the server\'s', () => {
  for (const k of [1, 2, 3]) {
    const key = crypto.createHash('sha256').update('lanes' + k).digest();
    const server = keyedWorld(key);
    const page = S.World.fromLanes([]);
    let sent = S.C.FIRST_ROW - 1;
    const feed = (front) => {               // CrossyRoom.pushLanes: up to 24 beyond the furthest hopper, through JSON
      const hi = front + 24, out = [];
      for (let r = sent + 1; r <= hi; r++) out.push(S.packRow(server.row(r)));
      sent = Math.max(sent, hi);
      page.add(JSON.parse(JSON.stringify(out)));
    };
    const hs = S.newHopper(), hp = S.newHopper(), bot = new CrossyBot(S.rng(k * 977), SHARP);
    feed(hs.r);
    let t = 0;
    for (; t < 6000 && hs.alive; t++) {
      const press = bot.input(server, hs);
      S.step(server, hs, press);
      S.step(page, hp, press);
      assert.deepStrictEqual(S.packHopper(hp), S.packHopper(hs), 'tick ' + t + ' map ' + k);
      feed(hs.r);
    }
    // The traffic on every lane the page holds is the server's, asked about at any time, in any order.
    for (const d of [90, 3, 40.5, 12, 200]) for (let r = Math.max(S.C.FIRST_ROW, hs.r - 5); r <= hs.r + 20; r++) {
      const a = server.row(r), b = page.row(r);
      if (!a || !b) continue;
      if (a.kind === 'road') assert.deepStrictEqual(S.carsAt(b, d, []), S.carsAt(a, d, []), 'cars r' + r + ' d' + d);
      else if (a.type === 'log') assert.deepStrictEqual(S.logsAt(b, d, []), S.logsAt(a, d, []), 'logs r' + r + ' d' + d);
      else if (a.kind === 'rail') assert.deepStrictEqual(S.trainAt(b, d), S.trainAt(a, d), 'train r' + r + ' d' + d);
    }
    assert.ok(S.score(hs) >= 5, 'the bot got somewhere: ' + S.score(hs));
  }
});

test('a lane the page has not been sent blocks the hop (it is never made up)', () => {
  const server = keyedWorld(crypto.randomBytes(32)), lanes = [];
  for (let r = S.C.FIRST_ROW; r <= S.C.START_ROW; r++) lanes.push(S.packRow(server.row(r)));
  const page = S.World.fromLanes(lanes);   // up to the hopper's own lane, none beyond
  const h = S.newHopper();
  for (let i = 0; i < 30; i++) S.step(page, h, i === 0 ? IN.FWD : 0);
  assert.strictEqual(h.r, S.C.START_ROW, 'no lane ahead, no hop');
});

test('the room never sends a seed or its key: cr:start and every watcher see lanes only, never more than 24 ahead', () => {
  const io = fakeIo();
  const room = new CrossyRoom(io);
  room.addPlayer(sock('a'), 'Ann', 'WA', 1, 1);
  room.addPlayer(sock('b'), 'Bob', 'WB', 1, 1);
  room.start(1000);
  const st = io.sent.find((m) => m.ev === 'cr:start').p;
  assert.ok(!('seed' in st) && !('key' in st), 'no seed in cr:start');
  assert.ok(Array.isArray(st.lanes) && st.lanes.length > 0);
  assert.strictEqual(Math.max(...st.lanes.map((l) => l.r)), S.C.START_ROW + 24);
  const json = JSON.stringify(st);
  assert.ok(!/seed|key/i.test(json.replace(/"lanes"/, '')), 'nothing named seed or key on the wire');
  // Ann hops forward every 12 ticks; the lanes keep 24 ahead of her and no further.
  const at = (t) => room.goAt + t * S.TICK_MS + 0.5;
  room.tick(at(0));
  let top = S.C.START_ROW + 24;
  for (let t = 1; t <= 200 && room.state === 'playing'; t++) {
    room.input('a', { t: t - 1, h: (t - 1) % 12 === 0 ? [[t - 1, IN.FWD]] : [] });
    room.input('b', { t: t - 1 });
    room.tick(at(t));
    for (const m of io.sent.filter((x) => x.ev === 'cr:lanes')) {
      assert.ok(!m.volatile, 'lanes are sent reliably');
      for (const l of m.p.rows) { assert.strictEqual(l.r, top + 1, 'lanes come in order, none skipped'); top = l.r; }
    }
    io.sent.length = 0;
    const lead = Math.max(...[...room.players.values()].map((p) => p.cr.h.r));
    assert.ok(top <= lead + 24, 'never more than 24 lanes ahead of the furthest hopper');
  }
  assert.ok(top > S.C.START_ROW + 24, 'more lanes followed as Ann moved on');
  const w = room.watchSnapshot(at(200));
  assert.ok(!('seed' in w) && Array.isArray(w.lanes) && Math.max(...w.lanes.map((l) => l.r)) === top);
});

test('a page back mid-match holds only the lanes near the hoppers: it never throws, and seated from the server it steps as the server does', () => {
  const server = keyedWorld(crypto.createHash('sha256').update('rejoin').digest());
  const hs = S.newHopper(), bot = new CrossyBot(S.rng(31), SHARP);
  for (let t = 0; t < 6000 && hs.alive && hs.r < 14; t++) S.step(server, hs, bot.input(server, hs));
  assert.ok(hs.alive && hs.r >= 14, 'the bot got past row 14: ' + hs.r);
  // What a rejoin carries (CrossyRoom.lanesNow): from 12 behind the last hopper to 24 beyond the furthest.
  const lanes = [];
  for (let r = hs.r - 12; r <= hs.r + 24; r++) lanes.push(S.packRow(server.row(r)));
  const page = S.World.fromLanes(JSON.parse(JSON.stringify(lanes)));
  const fresh = S.newHopper();                       // stepped from the start on lanes the page does not hold
  assert.doesNotThrow(() => { for (let i = 0; i < 240; i++) S.step(page, fresh, 0); });
  const hp = S.unpackHopper(S.packHopper(hs));      // crossyMain.startMatch seats it from the server's row
  hp.got = hs.got.slice();
  let sent = hs.r + 24;
  for (let t = 0; t < 600 && hs.alive; t++) {
    // More lanes as the hopper moves on (CrossyRoom.pushLanes: 24 beyond the furthest).
    while (sent < hs.r + 24) page.add(JSON.parse(JSON.stringify([S.packRow(server.row(++sent))])));
    const press = bot.input(server, hs);
    S.step(server, hs, press); S.step(page, hp, press);
    assert.deepStrictEqual(S.packHopper(hp), S.packHopper(hs), 'tick ' + t);
  }
});

test('no lane on the wire carries its name (it would tell which chunk is under way)', () => {
  const server = keyedWorld(crypto.randomBytes(32));
  for (let r = S.C.FIRST_ROW; r < 40; r++) assert.ok(!('n' in S.packRow(server.row(r))));
});
