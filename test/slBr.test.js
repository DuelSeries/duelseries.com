'use strict';
// The battle royale on the sl engine (server/slBr; Owen 2026-10-15: the event plays like the free /sl room, the
// wandering circle and spectate kept). The circle's rules (brZone), the match's state machine through a real SlRoom on
// a fake clock (brMatch + slRoom opts.br), the zone kill, food and bots inside the circle (slSim opts.zone), the held
// border, and the watcher seat.

const test = require('node:test');
const assert = require('node:assert');
const W = require('../shared/slWire.js');
const { SlRoom } = require('../server/sl/slRoom');
const { createSim } = require('../server/sl/slSim');
const { createRng } = require('../server/sl/slRng');
const { makeFixture } = require('./slLawsFixture');
const { fakeTimers, bareSocket, fakeView } = require('./slNetFakes');
const { BRZ, createZone, cruiseOf } = require('../server/slBr/brZone');
const { BRM, createBrMatch, msUntilNextStart } = require('../server/slBr/brMatch');
const { createHeldBorder } = require('../server/slBr/brBorder');

const LAWS = makeFixture();
const P = 42.67; // L7
const GRD = LAWS.L1.value;
const quiet = { log() {}, warn() {}, error() {} };

function seeded(seed) {
  const r = createRng(seed);
  return () => r.next();
}

function makeBr(o) {
  const opts = o || {};
  const ft = fakeTimers(1000);
  const decided = [];
  const match = createBrMatch({ laws: LAWS, log: quiet, rand: seeded(opts.seed || 5), now: () => 1.7e12,
    onDecided: (m) => decided.push(JSON.parse(JSON.stringify(m.winner))), lastStore: opts.lastStore,
    journal: opts.journal, onVoided: opts.onVoided });
  const room = new SlRoom(LAWS, Object.assign({ seed: 7, view: opts.realView ? undefined : fakeView(), br: match,
    clock: ft.clock, timers: ft.timers, autoTick: false, shippableOnly: false, prey: false, now: () => 1.7e12,
    log: quiet }, opts.room));
  return { ft, room, match, decided };
}

// the one bot of a room
function botOf(room) {
  let id = null;
  room.sim.forEachSnake((s) => {
    if (!room.humans.has(s.id)) id = s.id;
  });
  return id;
}

function layer(sock) {
  const out = [];
  for (const e of sock.emitted) if (e.name === 'sl:x') for (const m of e.data) out.push(m);
  return out;
}

// Steps the room ms of sim time; every person (seat) is turned toward the circle's centre (or the map's) every few
// steps, so a test of seconds never meets a wall it did not mean to.
function run(ft, room, ms) {
  const steps = Math.ceil(ms / P);
  for (let i = 0; i < steps; i++) {
    if (i % 6 === 0) {
      const z = room.sim.zoneNow();
      let k = 0;
      for (const seat of room.seats.values()) {
        const s = room.sim.snake(seat.snakeId);
        k++;
        if (!s) continue;
        // each person heads for their own point near the middle, so two people never meet head on
        const r = (z ? z.r : 1500) * 0.4;
        const tx = (z ? z.x : GRD) + Math.cos(k * 2.1) * r;
        const ty = (z ? z.y : GRD) + Math.sin(k * 2.1) * r;
        let a = Math.atan2(ty - s.hy, tx - s.hx);
        if (a < 0) a += 2 * Math.PI;
        room.onInput(seat, W.encodeInput([{ type: 'angle', q: Math.round(a / (2 * Math.PI) * 251) % 251 }]));
      }
    }
    ft.advance(P);
    room.wake();
  }
}

// a human with a seat, its snake parked at the map centre heading nowhere in particular
function human(room, nick, wallet) {
  const sock = bareSocket();
  const seat = room.seat(sock, { nick, cv: 1, wallet });
  assert.ok(seat, 'seated');
  return { sock, seat, id: seat.snakeId };
}

// ---------------------------------------------------------------------------------------------------------------
// brZone

test('brZone: every ring sits inside the last, never moves the wall faster than 0.7 x cruise, and ends at the floor', () => {
  const cruise = cruiseOf(LAWS);
  assert.ok(Math.abs(cruise - (5.39 + 0.4) / 4 * 125) < 1e-9, 'cruise is sp / 4 per 8 ms at sc 1');
  const z = createZone({ grd: GRD, cruise, rand: seeded(11) });
  assert.strictEqual(z.get(), null);
  z.begin(0, 3000);
  assert.deepStrictEqual(z.get(), { x: GRD, y: GRD, r: 3000 });
  let prev = { x: GRD, y: GRD, r: 3000 };
  let t = 0;
  let worst = 0;
  let rings = 0;
  let last = null;
  while (t < 20 * 60 * 1000) {
    t += P;
    if (z.update(t)) {
      rings++;
      const g = z.target();
      assert.ok(Math.hypot(g.x - prev.x, g.y - prev.y) + g.r <= prev.r + 1e-6, 'contained');
    }
    const c = z.get();
    // a boundary point moves at most dr + centre travel per step
    const v = (Math.abs(c.r - prev.r) + Math.hypot(c.x - prev.x, c.y - prev.y)) / (P / 1000);
    if (v > worst) worst = v;
    prev = { x: c.x, y: c.y, r: c.r };
    last = c;
    if (c.r <= BRZ.RING_MIN_RADIUS + 1e-9) break;
  }
  assert.ok(worst <= z.closeSpeed() + 1e-6, 'wall speed ' + worst.toFixed(1) + ' within ' + z.closeSpeed().toFixed(1));
  assert.strictEqual(Math.round(last.r), BRZ.RING_MIN_RADIUS);
  assert.ok(rings >= 15 && rings <= 25, rings + ' rings');
  assert.ok(t > 2 * 60 * 1000 && t < 6 * 60 * 1000, 'a match of minutes, not seconds: ' + Math.round(t / 1000) + ' s');
});

test('brZone: closesInMs says when the circle reaches the floor (the Events "Ends in"), counting down to 0 there', () => {
  const z = createZone({ grd: GRD, cruise: cruiseOf(LAWS), rand: seeded(11) });
  assert.strictEqual(z.closesInMs(0), 0, 'no rings, no clock');
  z.begin(0, 3000);
  const said = z.closesInMs(0);
  let t = 0;
  let rings = 1;
  let prevSaid = said;
  while (t < 20 * 60 * 1000) {
    t += P;
    if (z.update(t)) rings++;
    const left = z.closesInMs(t);
    // it only counts down: at most a step late per ring (the next ring is called on the first step after the rest)
    assert.ok(left <= prevSaid - P + rings * P + 1, 'never jumps up: ' + left + ' after ' + prevSaid);
    prevSaid = left;
    if (z.get().r <= BRZ.RING_MIN_RADIUS + 1e-9) break;
  }
  assert.ok(Math.abs(t - said) <= rings * P + P, 'said ' + said + ' ms, closed at ' + Math.round(t) + ' ms (' + rings + ' rings)');
  assert.strictEqual(z.closesInMs(t), 0, 'fully closed');
  z.freeze();
  assert.strictEqual(z.closesInMs(t), 0);
});

test('brZone: freeze holds the circle; reopen travels back to the arena centre in REOPEN_MS', () => {
  const z = createZone({ grd: GRD, cruise: cruiseOf(LAWS), rand: seeded(3) });
  z.begin(0, 2900);
  for (let t = 0; t < 60000; t += P) z.update(t);
  const held = Object.assign({}, z.get());
  z.freeze();
  for (let t = 60000; t < 65000; t += P) z.update(t);
  assert.deepStrictEqual(z.get(), held);
  assert.strictEqual(z.phase(65000), 'frozen');
  z.reopen(65000);
  z.update(65000 + BRZ.REOPEN_MS / 2);
  assert.ok(z.get().r > held.r && z.get().r < 2900);
  assert.strictEqual(z.reopened(65000 + BRZ.REOPEN_MS / 2), false);
  z.update(65000 + BRZ.REOPEN_MS);
  assert.deepStrictEqual(z.get(), { x: GRD, y: GRD, r: 2900 });
  assert.strictEqual(z.reopened(65000 + BRZ.REOPEN_MS), true);
  const d = z.desc(65000);
  assert.deepStrictEqual(d.t, [GRD, GRD, 2900]);
  z.clear();
  assert.strictEqual(z.get(), null);
});

// ---------------------------------------------------------------------------------------------------------------
// slSim opts.zone and makeBorder

test('slSim zone: a head outside the circle dies on the border; with no circle the free rule stands', () => {
  let circle = null;
  const sim = createSim(LAWS, { seed: 3, border: true, zone: { get: () => circle } });
  const s = sim.spawn({ x: GRD + 500, y: GRD, ang: 0, cv: 1 });
  for (let i = 0; i < 5; i++) sim.step();
  assert.ok(sim.snake(s.id), 'no circle: alive');
  circle = { x: GRD - 2000, y: GRD, r: 300 };
  const log = sim.step();
  assert.strictEqual(log.deaths.length, 1);
  assert.strictEqual(log.deaths[0].cause, 'border');
  assert.strictEqual(sim.zoneNow(), circle);
});

test('slSim zone: natural food spawns only inside the circle, and the food stream spends the same draws', () => {
  const circle = { x: GRD + 1500, y: GRD, r: 600 };
  const a = createSim(LAWS, { seed: 9, world: true, prey: false, zone: { get: () => circle } });
  let inside = 0;
  a.food.forEachInDisc(GRD, GRD, 6000, (f) => {
    const dx = f.x - circle.x;
    const dy = f.y - circle.y;
    assert.ok(dx * dx + dy * dy <= circle.r * circle.r, 'food outside the circle at ' + f.x + ',' + f.y);
    inside++;
  });
  assert.ok(inside > 0, 'the circle has food');
  // the same seed with no circle draws the same food stream (the refusals spend their draws)
  const b = createSim(LAWS, { seed: 9, world: true, prey: false, zone: { get: () => null } });
  const c = createSim(LAWS, { seed: 9, world: true, prey: false });
  assert.strictEqual(b.digest(), c.digest());
});

test('slSim zone: prey spawn only inside the circle and leave when it closes past them', () => {
  let circle = { x: GRD + 1200, y: GRD, r: 2500 };
  const sim = createSim(LAWS, { seed: 5, world: true, prey: true, zone: { get: () => circle } });
  // spawn passes straight away (each one's draws are the same with or without the circle)
  for (let i = 0; i < 400 && sim.preys.count() < 6; i++) sim.preys.pass(sim.flux());
  assert.ok(sim.preys.count() > 0, 'some prey spawned');
  const outside = () => {
    let n = 0;
    sim.preys.forEachPrey((p) => {
      const dx = p.x - circle.x;
      const dy = p.y - circle.y;
      if (dx * dx + dy * dy > circle.r * circle.r) n++;
    });
    return n;
  };
  assert.strictEqual(outside(), 0, 'none outside the circle');
  circle = { x: GRD - 2000, y: GRD, r: 200 };
  sim.step();
  assert.strictEqual(outside(), 0, 'the ones the circle left are gone');
});

test('brBorder: the crowd border, held where it is while a match runs and released at the L11.step rate', () => {
  const b = createHeldBorder(LAWS, { nowMs: 0, count: 60 });
  const r0 = b.radius();
  b.hold(true);
  let t = 0;
  for (; t < 30000; t += P) b.tick(t, 1);
  assert.strictEqual(b.radius(), r0, 'held');
  b.hold(false);
  const step = LAWS['L11.step'].value;
  let prev = b.radius();
  for (let i = 0; i < 400; i++, t += P) {
    b.tick(t, 1);
    assert.ok(Math.abs(b.radius() - prev) <= step.units, 'never a jump');
    prev = b.radius();
  }
  assert.ok(b.radius() < r0, 'moves toward the smaller crowd');
});

// ---------------------------------------------------------------------------------------------------------------
// the match through a real room

test('a solo run: one person and bots; the door shuts as it goes live, Q is refused, the last bot dies and they win (no prize flag)', () => {
  const { ft, room, match, decided } = makeBr();
  const me = human(room, 'Owen', 'W1');
  const bots = [room.spawnSnake({ nick: 'b1', cv: 2, isBot: true }), room.spawnSnake({ nick: 'b2', cv: 3, isBot: true })];
  run(ft, room, 200);
  assert.strictEqual(match.state, 'waiting');
  assert.strictEqual(match.canStart(), true);
  assert.strictEqual(match.startMatch('test'), true);
  assert.strictEqual(match.state, 'countdown');
  assert.strictEqual(match.startMatch('again'), false, 'one match at a time');
  assert.strictEqual(room.refusal(), null, 'the countdown keeps the door open');
  run(ft, room, BRM.COUNTDOWN_MS + 200);
  assert.strictEqual(match.state, 'running');
  assert.strictEqual(room.seat(bareSocket(), { nick: 'late', cv: 1 }), null);
  assert.strictEqual(room.refusal(), 'match');
  assert.strictEqual(room.onHold(me.seat, true), false, 'no Q while the match is fought');
  assert.ok(room.sim.zoneNow(), 'the circle is live');
  assert.strictEqual(match.publicState().startedWith, 1);
  assert.strictEqual(match.publicState().startedCount, 3, 'every snake alive at the start, bots too (the HUD: 3 of 3 left)');
  for (const b of bots) room.sim.kill(b.id);
  run(ft, room, 200);
  assert.strictEqual(match.state, 'over');
  assert.strictEqual(match.publicState().startedCount, 3, 'kept for the moment of the win');
  assert.strictEqual(match.winner.id, me.id);
  assert.strictEqual(match.winner.wallet, 'W1');
  assert.strictEqual(match.soloRun, true);
  assert.strictEqual(match.publicState().prize, 0, 'a solo run pays nothing');
  assert.strictEqual(decided.length, 1);
  // the winner's five seconds, then they leave as a cash-out does, then the arena reopens and the door opens
  run(ft, room, BRM.CASHOUT_DELAY_MS + 200);
  assert.ok(!room.sim.snake(me.id), 'the winner left the arena');
  assert.ok(layer(me.sock).some((m) => m.t === 'cashed'), 'their card');
  assert.strictEqual(match.state, 'reopening');
  run(ft, room, BRZ.REOPEN_MS + 200);
  assert.strictEqual(match.state, 'waiting');
  assert.strictEqual(room.sim.zoneNow(), null);
  assert.strictEqual(room.refusal(), null);
});

test('the prize needs two PEOPLE: a second tab of one wallet is refused, a seat with no proven wallet plays, prize held', () => {
  const { ft, room, match, decided } = makeBr();
  const a = human(room, 'Owen', 'W1');
  // a second tab of the same wallet: one snake per person (a death is out for the match)
  assert.strictEqual(room.seat(bareSocket(), { nick: 'Owen2', cv: 1, wallet: 'W1' }), null);
  assert.strictEqual(room.refusal({ wallet: 'W1' }), 'twice');
  assert.strictEqual(room.refusal({ wallet: 'W2' }), null, 'another wallet is welcome');
  const c = human(room, 'Script', null); // a socket that proved nothing
  const bot = room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  match.startMatch('test');
  assert.strictEqual(match.publicState().startedWith, 2);
  assert.strictEqual(match.soloRun, false, 'two seats: a real match');
  assert.strictEqual(match.prizeHeld, true, 'one proven wallet: no automatic prize');
  assert.strictEqual(match.publicState().prize, 0, 'the countdown promises nothing');
  run(ft, room, BRM.COUNTDOWN_MS + 200);
  room.sim.kill(bot.id);
  room.sim.kill(c.id);
  run(ft, room, 200);
  assert.strictEqual(match.state, 'over');
  assert.strictEqual(match.winner.id, a.id);
  assert.strictEqual(decided.length, 1, 'the server is told (it holds the prize and alerts the owner)');
  // and a solo seat with a proven wallet is a solo run from the start
  const s = makeBr();
  human(s.room, 'Solo', 'W9');
  s.room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  s.match.startMatch('test');
  assert.strictEqual(s.match.soloRun, true);
  assert.strictEqual(s.match.publicState().prize, 0);
});

test('a person who dies is out; the bots play on until one snake is left, and a bot that wins is paid nothing', () => {
  const { ft, room, match, decided } = makeBr();
  const me = human(room, 'Owen', 'W1');
  const b1 = room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  room.spawnSnake({ nick: 'b2', cv: 2, isBot: true });
  match.startMatch('test');
  run(ft, room, BRM.COUNTDOWN_MS + 200);
  room.sim.kill(me.id);
  run(ft, room, 200);
  assert.strictEqual(match.state, 'running', 'two bots left: the circle has not finished');
  assert.strictEqual(room.seat(bareSocket(), { nick: 'Owen', cv: 1, wallet: 'W1' }), null, 'out for the match');
  assert.strictEqual(room.refusal({ wallet: 'W1' }), 'match');
  assert.strictEqual(match.startMatch('again'), false, 'nobody starts another while it runs');
  room.sim.kill(b1.id);
  run(ft, room, 200);
  assert.strictEqual(match.state, 'over');
  assert.strictEqual(match.winner.name, 'b2');
  assert.strictEqual(match.winner.bot, true);
  assert.strictEqual(match.winner.wallet, null);
  assert.strictEqual(match.publicState().winner.bot, true);
  assert.strictEqual(match.publicState().prize, 0);
  assert.strictEqual(decided.length, 0, 'the prize hook never hears of a bot');
  assert.deepStrictEqual(match.podium.map((p) => p.name), ['b2', 'b1', 'Owen']);
  assert.strictEqual(match.startMatch('too soon'), false, 'finishing: still one at a time');
  // the bot stays in the arena (no cash-out for a bot), the circle reopens, and the next match can start
  run(ft, room, BRM.CASHOUT_DELAY_MS + BRZ.REOPEN_MS + 400);
  assert.strictEqual(match.state, 'waiting');
});

test('a match of bots alone: the minimum is snakes on the map, bots counted, and an empty arena does not start', () => {
  const { ft, room, match, decided } = makeBr();
  assert.strictEqual(match.canStart(), false, 'empty');
  room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  assert.strictEqual(match.canStart(), false, 'one snake has nobody to outlast');
  const b2 = room.spawnSnake({ nick: 'b2', cv: 2, isBot: true });
  assert.strictEqual(match.canStart(), true);
  assert.strictEqual(match.startMatch('auto'), true);
  assert.strictEqual(match.soloRun, true, 'nobody seated: no prize');
  run(ft, room, BRM.COUNTDOWN_MS + 200);
  assert.strictEqual(match.state, 'running', 'it runs with nobody watching');
  room.sim.kill(b2.id);
  run(ft, room, 200);
  assert.strictEqual(match.state, 'over');
  assert.strictEqual(match.winner.bot, true);
  assert.strictEqual(decided.length, 0);
});

test('two people: the last person standing wins, the podium is in falling order, the prize hook gets the proven wallet', () => {
  const { ft, room, match, decided } = makeBr();
  const a = human(room, 'Ann', 'WA');
  const b = human(room, 'Ben', 'WB');
  const c = human(room, 'Cat', null);
  room.spawnSnake({ nick: 'bot', cv: 2, isBot: true });
  match.startMatch('test');
  run(ft, room, BRM.COUNTDOWN_MS + 200);
  assert.strictEqual(match.publicState().startedWith, 3);
  assert.ok(room.sim.snake(c.id) && room.sim.snake(a.id) && room.sim.snake(b.id), 'all three alive at the start');
  const bot = botOf(room);
  if (bot !== null) room.sim.kill(bot);
  run(ft, room, 200);
  room.sim.kill(c.id);
  run(ft, room, 200);
  assert.strictEqual(match.state, 'running', 'two people still in it');
  room.sim.kill(a.id);
  run(ft, room, 200);
  assert.strictEqual(match.state, 'over');
  assert.deepStrictEqual(decided[0], { id: b.id, name: 'Ben', wallet: 'WB', bot: false });
  assert.deepStrictEqual(match.podium.map((p) => p.name), ['Ben', 'Ann', 'Cat']);
  assert.strictEqual(match.publicState().prize, 20);
  assert.strictEqual(match.soloRun, false);
});

test('abandon in the countdown or the match releases the circle and the border and opens the door', () => {
  const { ft, room, match } = makeBr();
  human(room, 'Owen', 'W1');
  room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  match.startMatch('test');
  assert.strictEqual(room.sim.border.held(), true);
  assert.strictEqual(match.abandon(), true);
  assert.strictEqual(match.state, 'waiting');
  assert.strictEqual(room.sim.border.held(), false);
  match.startMatch('test');
  run(ft, room, BRM.COUNTDOWN_MS + 2000);
  assert.ok(room.sim.zoneNow());
  match.abandon();
  assert.strictEqual(room.sim.zoneNow(), null);
  assert.strictEqual(room.refusal(), null);
  assert.strictEqual(match.abandon(), false, 'nothing to stop');
});

// Owen 2026-10-26: "not until the match actually starts after the 30-second timer has gone off that everything's
// locked". The doors stay open through a countdown and shut as the match goes live.
function journalFake() {
  const rows = [];
  return { rows, setLive: (r) => rows.push(r) };
}
function cashedOut(sock) {
  return layer(sock).some((m) => m.t === 'cashed');
}

test('the countdown keeps the doors open: a join is in the match, Q leaves, a death there comes back; at 0 it all locks', () => {
  const j = journalFake();
  const { ft, room, match } = makeBr({ journal: j });
  const ann = human(room, 'Ann', 'WA');
  const quinn = human(room, 'Quinn', 'WQ');
  const fay = human(room, 'Fay', 'WF');
  room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  room.spawnSnake({ nick: 'b2', cv: 2, isBot: true });
  assert.strictEqual(match.startMatch('owner'), true);
  assert.strictEqual(match.state, 'countdown');
  assert.strictEqual(match.acceptingPlayers(), true);
  assert.strictEqual(match.allowsHold(), true);
  assert.strictEqual(j.rows.length, 0, 'nothing is locked in yet: no journal row');
  run(ft, room, 1000);
  // a join in the middle of the countdown is seated and counted
  const lee = human(room, 'Lee', 'WL');
  run(ft, room, 200);
  assert.strictEqual(match.publicState().startedWith, 4, 'the count follows the joins');
  // Q in the countdown leaves the arena as a cash-out does
  assert.strictEqual(room.onHold(quinn.seat, true), true, 'Q works in the countdown');
  run(ft, room, room.R.holdMs + 300);
  assert.ok(!room.sim.snake(quinn.id), 'Quinn left');
  assert.ok(cashedOut(quinn.sock), 'their card');
  // a death in the countdown is not out of the match: their wallet may sit down again
  room.sim.kill(fay.id);
  run(ft, room, 200);
  assert.strictEqual(room.refusal({ wallet: 'WF' }), null);
  const fay2 = human(room, 'Fay', 'WF');
  assert.strictEqual(match.state, 'countdown', 'still counting down');
  run(ft, room, BRM.COUNTDOWN_MS);
  assert.strictEqual(match.state, 'running');
  const st = match.publicState();
  assert.strictEqual(st.startedWith, 3, 'Ann, Lee and Fay again: Quinn left before 0');
  assert.strictEqual(match.startedPeople, 3);
  assert.strictEqual(match.prizeHeld, false);
  assert.strictEqual(st.prize, 20);
  assert.strictEqual(j.rows.length, 1, 'the journal row is written as it goes live');
  assert.deepStrictEqual([j.rows[0].seats, j.rows[0].wallets], [3, 3]);
  assert.deepStrictEqual(match._fallen, [], 'a death in the countdown is not on the podium');
  // from 0: no joins, no Q
  assert.strictEqual(room.refusal({ wallet: 'WZ' }), 'match');
  assert.strictEqual(room.seat(bareSocket(), { nick: 'Zed', cv: 1, wallet: 'WZ' }), null);
  assert.strictEqual(room.onHold(ann.seat, true), false);
  assert.strictEqual(room.onHold(lee.seat, true), false);
  assert.ok(room.sim.snake(fay2.id), 'Fay plays the match');
});

test('a hold pressed in the countdown ends as the match goes live: nobody leaves after 0', () => {
  const { ft, room, match } = makeBr();
  const ann = human(room, 'Ann', 'WA');
  const ben = human(room, 'Ben', 'WB');
  room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  match.startMatch('owner');
  run(ft, room, BRM.COUNTDOWN_MS - 400);
  assert.strictEqual(room.onHold(ben.seat, true), true);
  run(ft, room, 400 + room.R.holdMs + 500);
  assert.strictEqual(match.state, 'running');
  assert.ok(room.sim.snake(ben.id), 'Ben is still in the match');
  assert.ok(!cashedOut(ben.sock), 'no cash-out card after 0');
  assert.ok(layer(ben.sock).some((m) => m.t === 'hold' && m.on === 0 && m.id === ben.id), 'their ring ended');
  assert.strictEqual(match.startedWith, 2);
  assert.ok(room.sim.snake(ann.id));
});

test('a hold that would finish on the very step it goes live: counted and in the match, or gone and not counted, never both', () => {
  // review 2026-10-26: the countdown ends inside the step (afterDeaths), and holds complete later in that same step
  const steps = Math.round(BRM.COUNTDOWN_MS / P);
  let crossed = 0;
  for (let k = -4; k <= 4; k++) {
    const j = journalFake();
    const { ft, room, match } = makeBr({ journal: j });
    human(room, 'Ann', 'WA');
    const ben = human(room, 'Ben', 'WB');
    room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
    match.startMatch('owner');
    // pressed so the hold's time is up within a step or so of the countdown's end
    const pressAt = steps - Math.ceil(room.R.holdMs / P) + k;
    for (let i = 0; i < steps + Math.ceil(room.R.holdMs / P) + 10; i++) {
      if (i === pressAt) assert.strictEqual(room.onHold(ben.seat, true), true);
      run(ft, room, P); // one step, the seats steered (and heard: a hold with no upstream ends)
    }
    assert.strictEqual(match.state, 'running');
    const gone = !room.sim.snake(ben.id);
    const counted = j.rows[0].seats === 2;
    assert.strictEqual(gone, cashedOut(ben.sock), 'gone only by the cash-out');
    assert.notStrictEqual(gone, counted, 'offset ' + k + ': gone ' + gone + ', counted ' + counted);
    assert.strictEqual(match.startedWith, counted ? 2 : 1);
    assert.strictEqual(match.prizeHeld, false);
    assert.strictEqual(match.soloRun, !counted, 'one person left in it is a solo run');
    if (counted) crossed++;
  }
  assert.ok(crossed > 0 && crossed < 9, 'the sweep crossed the boundary (' + crossed + ' of 9 stayed in)');
});

test('the prize counts who is in as it goes live: a second wallet joining in the countdown, or the only other leaving', () => {
  // one proven wallet at the start, a second joins in the countdown: a real match
  const a = makeBr();
  human(a.room, 'Ann', 'WA');
  a.room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  a.match.startMatch('owner');
  assert.strictEqual(a.match.soloRun, true, 'one person so far');
  assert.strictEqual(a.match.publicState().prize, 0);
  run(a.ft, a.room, 2000);
  human(a.room, 'Ben', 'WB');
  run(a.ft, a.room, BRM.COUNTDOWN_MS);
  assert.strictEqual(a.match.state, 'running');
  assert.strictEqual(a.match.soloRun, false);
  assert.strictEqual(a.match.prizeHeld, false);
  assert.strictEqual(a.match.publicState().prize, 20);
  // two wallets at the start, one cashes out in the countdown: a solo run, nothing promised
  const b = makeBr();
  human(b.room, 'Ann', 'WA');
  const ben = human(b.room, 'Ben', 'WB');
  b.room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  b.match.startMatch('owner');
  assert.strictEqual(b.match.publicState().prize, 20);
  assert.strictEqual(b.room.onHold(ben.seat, true), true);
  run(b.ft, b.room, BRM.COUNTDOWN_MS + 200);
  assert.strictEqual(b.match.state, 'running');
  assert.ok(cashedOut(ben.sock));
  assert.strictEqual(b.match.soloRun, true);
  assert.strictEqual(b.match.publicState().prize, 0);
  // and two seats of one wallet (one proven, one not) still hold it
  const c = makeBr();
  human(c.room, 'Ann', 'WA');
  c.room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  c.match.startMatch('owner');
  human(c.room, 'Script', null);
  run(c.ft, c.room, BRM.COUNTDOWN_MS + 200);
  assert.strictEqual(c.match.soloRun, false);
  assert.strictEqual(c.match.prizeHeld, true);
  assert.strictEqual(c.match.publicState().prize, 0);
});

test('the scheduled start goes straight live; a countdown that empties is called off; abandoning a countdown voids nothing', () => {
  const j = journalFake();
  const voided = [];
  const { ft, room, match } = makeBr({ journal: j, onVoided: (w) => voided.push(w) });
  const ann = human(room, 'Ann', 'WA');
  const bot = room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  // the owner's countdown, emptied: Ann leaves and the bot dies, so there is nobody to outlast at 0
  assert.strictEqual(match.startMatch('owner'), true);
  assert.strictEqual(room.onHold(ann.seat, true), true);
  run(ft, room, room.R.holdMs + 300);
  room.sim.kill(bot.id);
  run(ft, room, BRM.COUNTDOWN_MS);
  assert.strictEqual(match.state, 'waiting', 'called off');
  assert.strictEqual(match.matchId, null);
  assert.strictEqual(room.sim.zoneNow(), null);
  assert.strictEqual(room.sim.border.held(), false);
  assert.strictEqual(j.rows.length, 0);
  // a countdown abandoned (a room replacement): nobody was locked in, so no void push and no journal row
  human(room, 'Ben', 'WB');
  room.spawnSnake({ nick: 'b2', cv: 2, isBot: true });
  run(ft, room, 200);
  assert.strictEqual(match.startMatch('owner'), true);
  assert.strictEqual(match.abandon('the room was replaced'), true);
  assert.deepStrictEqual(voided, []);
  assert.strictEqual(j.rows.length, 0);
  // the scheduled start: straight live, the doors shut at once, the journal row written
  assert.strictEqual(match.startMatch('auto 20:00 ET', { countdownMs: 0 }), true);
  assert.strictEqual(match.state, 'running');
  assert.ok(room.sim.zoneNow(), 'the circle is live');
  assert.strictEqual(room.refusal({ wallet: 'WC' }), 'match');
  assert.strictEqual(match.allowsHold(), false);
  assert.strictEqual(j.rows.length, 1);
  assert.strictEqual(j.rows[0].seats, 1);
  // a match that went live and is cut off is voided as before
  assert.strictEqual(match.abandon('the room was replaced'), true);
  assert.strictEqual(voided.length, 1);
  assert.strictEqual(j.rows[j.rows.length - 1], null, 'its journal row cleared');
});

test('forceStart is a plain start now: refused mid-match and with fewer than two snakes in the arena', () => {
  const { ft, room, match } = makeBr();
  assert.strictEqual(match.forceStart('x'), false, 'nobody here');
  human(room, 'Owen', 'W1');
  assert.strictEqual(match.forceStart('x'), false, 'one snake has nobody to outlast');
  room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  assert.strictEqual(match.forceStart('x'), true);
  assert.strictEqual(match.forceStart('x'), false, 'already counting down');
  run(ft, room, 100);
});

test('every seat hears the match: sl:x {t: br} at the join, at each change and once a second while it runs', () => {
  const { ft, room, match } = makeBr();
  const me = human(room, 'Owen', 'W1');
  room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  assert.ok(layer(me.sock).some((m) => m.t === 'br' && m.state === 'waiting'), 'at the join');
  match.startMatch('test');
  run(ft, room, BRM.COUNTDOWN_MS + 3200);
  const brs = layer(me.sock).filter((m) => m.t === 'br');
  assert.ok(brs.some((m) => m.state === 'countdown' && m.countdownMs > 0));
  const live = brs.filter((m) => m.state === 'running');
  assert.ok(live.length >= 3, live.length + ' running updates');
  const z = live[live.length - 1].z;
  assert.ok(Array.isArray(z.f) && z.f.length === 3, 'the circle for the overlay');
  assert.strictEqual(typeof live[0].nextStartMs, 'number');
});

test('the idle pause never stops a match or a reopening; between matches it pauses as the free room', () => {
  const { ft, room, match } = makeBr({ room: { autoTick: true } });
  const me = human(room, 'Owen', 'W1');
  room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  match.startMatch('test');
  room.unseat(me.seat, 'leave');
  assert.strictEqual(match.canPause(), false);
  assert.strictEqual(match.state, 'countdown');
});

// ---------------------------------------------------------------------------------------------------------------
// watchers

test('a watcher follows a living person as its own snake, gets pongs and the match, never steers it, and leaving ends nothing', () => {
  const { ft, room, match } = makeBr();
  const me = human(room, 'Owen', 'W1');
  room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  run(ft, room, 200);
  const ws = bareSocket();
  const w = room.seatWatch(ws, {});
  assert.ok(w && w.watch);
  assert.strictEqual(w.snakeId, me.id, 'a person before a bot');
  assert.strictEqual(room.playerCount, 1, 'a watcher is not a player');
  assert.ok(layer(ws).some((m) => m.t === 'watch' && m.id === me.id && m.name === 'Owen'));
  assert.ok(layer(ws).some((m) => m.t === 'br'));
  const s = room.sim.snake(me.id);
  const ang = s.ang;
  room.onInput(ws.id, W.encodeInput([{ type: 'ping' }, { type: 'angle', q: 100 }, { type: 'boost', on: true }]));
  assert.ok(ws.emitted.some((e) => e.name === 'sl:f'), 'pong went out');
  run(ft, room, 400);
  assert.ok(room.sim.snake(me.id), 'still alive');
  assert.strictEqual(room.onHold(ws.id, true), false);
  assert.strictEqual(room.onChat(ws.id, 'hi'), false);
  assert.strictEqual(room.unseat(ws.id, 'disconnect'), true);
  run(ft, room, 200);
  assert.ok(room.sim.snake(me.id), 'the watched snake lives on');
  assert.strictEqual(room.watchers.size, 0);
  void ang;
  void match;
});

test('a watcher marks its seat dead when the followed snake ends; follow picks a named person; empty arena refuses', () => {
  const { ft, room } = makeBr();
  const a = human(room, 'Ann', 'WA');
  const b = human(room, 'Ben', 'WB');
  const ws = bareSocket();
  const w = room.seatWatch(ws, { follow: b.id });
  assert.strictEqual(w.snakeId, b.id);
  room.sim.kill(b.id);
  run(ft, room, 300);
  assert.strictEqual(w.dead, true);
  room.sim.kill(a.id);
  run(ft, room, 300);
  assert.strictEqual(room.seatWatch(bareSocket(), {}), null, 'nothing to watch');
});

test('Previous and Next (after, before): every living snake once round, the people first, the bots after them', () => {
  const { ft, room } = makeBr();
  const people = [human(room, 'Ann', 'WA'), human(room, 'Ben', 'WB')].map((h) => h.id);
  for (let i = 0; i < 3; i++) room.spawnSnake({ nick: 'b' + i, cv: 2, isBot: true });
  run(ft, room, 200);
  const at = (info) => room.seatWatch(bareSocket(), info).snakeId;
  const round = [at({})];
  for (let i = 0; i < 10 && round.length < 6; i++) round.push(at({ after: round[round.length - 1] }));
  assert.strictEqual(round[5], round[0], 'Next comes back round to the first');
  const ring = round.slice(0, 5);
  assert.strictEqual(new Set(ring).size, 5, 'every living snake once');
  assert.deepStrictEqual(ring.slice(0, 2).sort(), people.slice().sort(), 'the people first');
  for (let i = 0; i < 5; i++) assert.strictEqual(at({ before: ring[(i + 1) % 5] }), ring[i], 'Previous walks it back');
  assert.strictEqual(at({ follow: people[1], after: people[1] }), people[1], 'follow a person still wins');
  assert.strictEqual(at({ after: 65000 }), ring[0], 'a gone id: the first person');
});

test('a watcher on the real view gets the followed snake as its own (init, own add) with the real records', () => {
  const { ft, room } = makeBr({ realView: true });
  const me = human(room, 'Owen', 'W1');
  run(ft, room, 400);
  const ws = bareSocket();
  room.seatWatch(ws, {});
  run(ft, room, 400);
  const evs = [];
  for (const e of ws.emitted) if (e.name === 'sl:f') for (const r of W.decodeBundle(e.data)) evs.push(r);
  assert.ok(evs.length > 0, 'records went out');
  assert.ok(room.sim.snake(me.id));
});

test("a watcher's leaderboard never marks a row as its own (their client would write the viewer's nick over it)", () => {
  const { ft, room } = makeBr({ realView: true });
  human(room, 'Owen', 'W1');
  run(ft, room, 400);
  const ws = bareSocket();
  room.seatWatch(ws, {});
  run(ft, room, 3000);
  const lbs = [];
  for (const e of ws.emitted) if (e.name === 'sl:f') for (const r of W.decodeBundle(e.data)) if (r.type === 'leaderboard') lbs.push(r);
  assert.ok(lbs.length > 0 && lbs.some((l) => l.rows.length > 0), 'leaderboards with rows went out');
  for (const l of lbs) assert.strictEqual(l.myPos, 0);
  assert.ok(lbs.some((l) => l.rank >= 1), "the watched snake's rank still goes (their rank line)");
});

test('msUntilNextStart counts to the next slot of the 6 hour schedule (2 AM, 8 AM, 2 PM, 8 PM Eastern)', () => {
  assert.strictEqual(msUntilNextStart(Date.UTC(2026, 9, 16, 23, 0)), 60 * 60 * 1000); // 19:00 EDT: 8 PM
  assert.strictEqual(msUntilNextStart(Date.UTC(2026, 9, 16, 15, 30, 10)), (150 * 60 - 10) * 1000); // 11:30:10: 2 PM
  assert.strictEqual(msUntilNextStart(Date.UTC(2026, 9, 17, 1, 0)), 5 * 3600 * 1000); // 21:00: 2 AM
});

// ---------------------------------------------------------------------------------------------------------------
// slSockets: the event's slot (setBr)

const { rig, layerMsgs } = require('./slSockFakes');
const { SlBrArena } = require('../server/slBr/slBrArena');

function brRig(o, rigOpts) {
  const r = rig(rigOpts);
  const seen = [];
  const br = new SlBrArena(r.laws, Object.assign({ shippableOnly: false, autoTick: false, bots: false, seed: 21,
    clock: r.ft.clock, timers: r.ft.timers, now: () => r.wall.t, prey: false, log: quiet, rand: seeded(4),
    isOwner: (w) => w === 'OWNER' }, o));
  r.sockets.setBr({ arenas: br, identify: (p) => { seen.push(p); return p && p.ok ? p.wallet : null; } });
  return Object.assign(r, { br, seen });
}

// A watcher on another address than the players' (night review 2026-10-29: an address with a live snake in the event
// may not watch it; its own test is below).
const WATCH_IP = '10.0.0.2';

function refusedWith(s, why) {
  const last = s.emitted[s.emitted.length - 1];
  assert.ok(last && last.name === 'sl:x', 'the last emit is the sl:x refusal');
  assert.deepStrictEqual(last.data, [{ t: 'refused', why }]);
  assert.strictEqual(s.disconnected, true);
}

test('setBr: a br socket is seated in the event room with the wallet its proof names; a free socket stays free', () => {
  const r = brRig();
  const a = r.sock({ auth: { br: 1, cv: 3, idProof: { ok: true, wallet: 'OWNER' } } });
  a.fire('sl:join', { nick: 'Owen' });
  assert.strictEqual(r.br.room().seats.size, 1);
  assert.strictEqual(r.arenas.room().seats.size, 0, 'not the free room');
  assert.strictEqual(r.seen.length, 1);
  const msgs = layerMsgs(a).filter((m) => m.t === 'br');
  assert.ok(msgs.length && msgs[0].owner === true, 'the owner seat is told so');
  const f = r.sock({ auth: { cv: 3 } });
  f.fire('sl:join', { nick: 'Free' });
  assert.strictEqual(r.arenas.room().seats.size, 1, 'a plain socket is the free room');
  const b = r.sock({ auth: { br: 1, idProof: { ok: false } } });
  b.fire('sl:join', { nick: 'Ben' });
  const seat = r.br.room().seatOf(b.id);
  const brs = layerMsgs(b).filter((m) => m.t === 'br');
  assert.ok(seat && brs.length && brs[0].owner === undefined, 'no proven wallet: seated, no owner flag');
  // one snake per person: a second socket proving the same wallet is refused twice, out loud
  const twin = r.sock({ auth: { br: 1, idProof: { ok: true, wallet: 'OWNER' } } });
  twin.fire('sl:join', { nick: 'Owen' });
  refusedWith(twin, 'twice');
  assert.strictEqual(r.br.room().seats.size, 2);
});

test('setBr: once a match is under way a join is refused match; a watcher is seated; with nothing alive, nobody', () => {
  const r = brRig();
  const a = r.sock({ auth: { br: 1 } });
  a.fire('sl:join', { nick: 'Ann' });
  const b1 = r.br.room().spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  // the owner's countdown keeps the door open: a join then is seated
  assert.strictEqual(r.br.match.startMatch('test'), true);
  const early = r.sock({ auth: { br: 1 } });
  early.fire('sl:join', { nick: 'Early' });
  assert.ok(r.br.room().seatOf(early.id), 'seated in the countdown');
  const eId = r.br.room().seatOf(early.id).snakeId;
  early.fire('sl:leave');
  early.fire('disconnect', 'client namespace disconnect');
  r.br.room().sim.kill(eId);
  r.br.match.abandon('owner');
  // a match that went live shuts it
  assert.strictEqual(r.br.match.startMatch('test', { countdownMs: 0 }), true);
  assert.strictEqual(r.br.match.state, 'running');
  const late = r.sock({ auth: { br: 1 } });
  late.fire('sl:join', { nick: 'Late' });
  refusedWith(late, 'match');
  const pushes = r.pushes.length;
  const w = r.sock({ ip: WATCH_IP, auth: { br: 1, watch: 1 } });
  w.fire('sl:join', {});
  assert.strictEqual(r.br.room().watchers.size, 1);
  assert.ok(layerMsgs(w).some((m) => m.t === 'watch'));
  assert.strictEqual(r.pushes.length, pushes, 'a watcher is not a join push');
  w.fire('sl:leave');
  w.fire('disconnect', 'client namespace disconnect');
  assert.strictEqual(r.br.room().watchers.size, 0);
  const aId = r.br.room().seatOf(a.id).snakeId;
  // Previous and Next ride the handshake as snake ids, to the room's own stepping (people first, then snake id order);
  // junk is ignored (the leader)
  const room = r.br.room();
  for (const extra of [{ before: aId }, { after: aId }, { before: 'x', after: -1 }]) {
    const want = room._watchTarget(undefined, Number.isInteger(extra.after) && extra.after > 0 ? extra.after : undefined,
      Number.isInteger(extra.before) ? extra.before : undefined).id;
    const s = r.sock({ ip: WATCH_IP, auth: Object.assign({ br: 1, watch: 1 }, extra) });
    s.fire('sl:join', {});
    assert.strictEqual(layerMsgs(s).filter((m) => m.t === 'watch')[0].id, want, JSON.stringify(extra));
    s.fire('disconnect', 'client namespace disconnect');
  }
  assert.ok(r.br.room().sim.snake(aId), 'the player plays on');
  r.br.match.abandon();
  r.br.room().sim.kill(aId);
  if (r.br.room().sim.snake(b1.id)) r.br.room().sim.kill(b1.id);
  for (let i = 0; i < 4; i++) {
    r.ft.advance(P);
    r.br.room().wake();
  }
  const w2 = r.sock({ ip: WATCH_IP, auth: { br: 1, watch: 1 } });
  w2.fire('sl:join', {});
  refusedWith(w2, 'nobody');
});

test('an emergency close lets go of watchers too; the replacement room forgets the old seats and keeps its heartbeat', () => {
  const r = brRig();
  const a = r.sock({ auth: { br: 1, idProof: { ok: true, wallet: 'WA' } } });
  a.fire('sl:join', { nick: 'Ann' });
  const w = r.sock({ ip: WATCH_IP, auth: { br: 1, watch: 1 } });
  w.fire('sl:join', {});
  for (let i = 0; i < 30; i++) {
    r.ft.advance(P);
    r.br.room().wake();
  }
  const old = r.br.room();
  old.emergencyClose();
  assert.strictEqual(w.disconnected, true, 'the watcher is let go');
  assert.strictEqual(a.disconnected, true);
  const fresh = r.br.room();
  assert.notStrictEqual(fresh, old);
  const b = r.sock({ auth: { br: 1 } });
  b.fire('sl:join', { nick: 'Ben' });
  const before = layerMsgs(b).filter((m) => m.t === 'br').length;
  for (let i = 0; i < Math.ceil(6000 / P); i++) {
    r.ft.advance(P);
    fresh.wake();
  }
  assert.ok(layerMsgs(b).filter((m) => m.t === 'br').length > before, 'the waiting heartbeat runs in the new room');
});

test('an empty replacement room is started at most once a minute (no create, fail, close loop)', () => {
  const r = brRig();
  r.br.startRoom();
  assert.strictEqual(r.br.room().autoTick, true);
  r.br.room().emergencyClose();
  assert.strictEqual(r.br.room().autoTick, true, 'the first replacement starts');
  r.br.room().emergencyClose();
  assert.strictEqual(r.br.room().autoTick, false, 'an empty one a moment later waits for a person');
  r.wall.t += 61 * 1000;
  r.br.room().emergencyClose();
  assert.strictEqual(r.br.room().autoTick, true, 'a minute on, it starts again');
});

test('a hold ring reaches the watcher of the holding snake', () => {
  const r = brRig();
  const a = r.sock({ auth: { br: 1 } });
  a.fire('sl:join', { nick: 'Ann' });
  const w = r.sock({ ip: WATCH_IP, auth: { br: 1, watch: 1 } });
  w.fire('sl:join', {});
  r.br.room().onHold(a.id, true);
  for (let i = 0; i < 6; i++) {
    r.ft.advance(P);
    r.br.room().wake();
  }
  assert.ok(layerMsgs(w).some((m) => m.t === 'hold' && m.on === 1), 'the watcher sees the ring');
});

test('watchers are capped as seats are (C_HUMAN_CAP): one past it is refused full', () => {
  const r = brRig({}, { patch: { C_HUMAN_CAP: 2 } });
  const a = r.sock({ auth: { br: 1 } });
  a.fire('sl:join', { nick: 'Ann' });
  for (let i = 0; i < 2; i++) r.sock({ ip: WATCH_IP, auth: { br: 1, watch: 1 } }).fire('sl:join', {});
  assert.strictEqual(r.br.room().watchers.size, 2);
  const w = r.sock({ ip: WATCH_IP, auth: { br: 1, watch: 1 } });
  w.fire('sl:join', {});
  refusedWith(w, 'full');
});

// Night review 2026-10-29 (finding 6): a live snake's address cannot watch the event in another tab (a second view round
// every other snake), a snake seated from a watcher's address ends that watcher, and a dead snake's address watches.
test('a battle royale watch from the address of a live snake is refused nobody; a seat there ends the watchers of that address', () => {
  const r = brRig();
  const room = r.br.room();
  const a = r.sock({ ip: '10.0.0.7', auth: { br: 1 } });
  a.fire('sl:join', { nick: 'Ann' });
  room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  const twin = r.sock({ ip: '10.0.0.7', auth: { br: 1, watch: 1 } });
  twin.fire('sl:join', {});
  refusedWith(twin, 'nobody');
  assert.strictEqual(room.watchers.size, 0);
  assert.strictEqual(r.sockets.stats.watches, 0);
  const other = r.sock({ ip: WATCH_IP, auth: { br: 1, watch: 1 } });
  other.fire('sl:join', {});
  assert.strictEqual(room.watchers.size, 1, 'another address watches');
  // a watcher first, then a snake from the same address: the watcher goes, the other address keeps watching
  const spy = r.sock({ ip: '10.0.0.8', auth: { br: 1, watch: 1 } });
  spy.fire('sl:join', {});
  assert.strictEqual(room.watchers.size, 2);
  const b = r.sock({ ip: '10.0.0.8', auth: { br: 1 } });
  b.fire('sl:join', { nick: 'Ben' });
  assert.ok(room.seatOf(b.id) && !room.seatOf(b.id).watch, 'Ben is seated');
  refusedWith(spy, 'nobody');
  assert.strictEqual(room.watchers.size, 1);
  assert.strictEqual(other.disconnected, false);
  // Ann's snake dies: her address may watch again
  room.sim.kill(room.seatOf(a.id).snakeId);
  for (let i = 0; i < 4; i++) {
    r.ft.advance(P);
    room.wake();
  }
  assert.ok(!room.seatOf(a.id) || room.seatOf(a.id).dead, 'Ann is dead');
  const again = r.sock({ ip: '10.0.0.7', auth: { br: 1, watch: 1 } });
  again.fire('sl:join', {});
  assert.strictEqual(again.disconnected, false, 'the address of a dead snake watches');
  assert.strictEqual(room.watchers.size, 2);
});

test('the event directory: no board row, its slice read and reset, a replaced room ends the match with no winner', () => {
  const r = brRig();
  assert.deepStrictEqual(r.br.boardRows(), []);
  r.br.room().stats.maxSliceMs = 7;
  assert.strictEqual(r.br.maxSliceMs(), 7);
  assert.strictEqual(r.br.maxSliceMs(), 0);
  const a = r.sock({ auth: { br: 1 } });
  a.fire('sl:join', { nick: 'Ann' });
  r.br.room().spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  assert.strictEqual(r.br.match.startMatch('test'), true);
  const old = r.br.room();
  old.closed = true;
  r.br.sweep(Date.now());
  assert.notStrictEqual(r.br.room(), old, 'replaced');
  assert.strictEqual(r.br.match.state, 'waiting');
  assert.strictEqual(r.br.match.winner, null);
});

test('the last podium outlives a restart: a rebuilt match reports the saved podium, winner and prize while waiting, never as a payable winner', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createLastPodiumStore } = require('../server/slBr/brLastPodium');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brpod-')), 'br-last-podium.json');
  const store = () => createLastPodiumStore({ file, log: quiet });

  // before any match: nothing saved, nothing shown
  const first = makeBr({ lastStore: store() });
  assert.strictEqual(first.match.publicState().podium, null);

  // a real two-person match, decided: the file holds what publicState reported
  const { ft, room, match } = makeBr({ lastStore: store() });
  const a = human(room, 'Ann', 'WA');
  const b = human(room, 'Ben', 'WB');
  const c = human(room, 'Cat', null);
  const bot = room.spawnSnake({ nick: 'bot', cv: 2, isBot: true });
  match.startMatch('test');
  run(ft, room, BRM.COUNTDOWN_MS + 200);
  room.sim.kill(bot.id);
  run(ft, room, 200);
  room.sim.kill(c.id);
  run(ft, room, 200);
  room.sim.kill(a.id);
  run(ft, room, 200);
  assert.strictEqual(match.state, 'over');
  const before = match.publicState();
  assert.strictEqual(before.prize, 20);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!('wallet' in saved) && !JSON.stringify(saved).includes('WB'), 'no wallet on disk');

  // the restart: a new match on the same file, waiting
  const after = makeBr({ lastStore: store() });
  const s = after.match.publicState();
  assert.strictEqual(s.state, 'waiting');
  assert.deepStrictEqual(s.podium, before.podium);
  assert.deepStrictEqual(s.podium.map((p) => p.name), ['Ben', 'Ann', 'Cat']);
  assert.deepStrictEqual(s.winner, { name: 'Ben', id: null }, 'no snake id: a new snake of that number is not them');
  assert.strictEqual(s.prize, before.prize);
  assert.strictEqual(s.soloRun, false);
  assert.strictEqual(s.prizeHeld, false);
  assert.strictEqual(after.match.winner, null, 'the prize path (winner + matchId) never sees a restored match');
  assert.strictEqual(after.match.matchId, null);
  assert.strictEqual(s.matchId, null);
  assert.strictEqual(after.match.clientMsg().winner.id, null);

  // tonight's match starts: the old podium makes way for the empty seats
  human(after.room, 'Dee', 'WD');
  after.room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  assert.strictEqual(after.match.startMatch('test'), true);
  assert.strictEqual(after.match.publicState().podium, null);
  assert.strictEqual(after.match.publicState().winner, null);
  // abandoned before it was decided: the last finished match is shown again
  after.match.abandon();
  assert.deepStrictEqual(after.match.publicState().podium.map((p) => p.name), ['Ben', 'Ann', 'Cat']);
});

test('the last podium keeps a held or solo prize as reported (0), and a file that is not a podium is ignored', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createLastPodiumStore } = require('../server/slBr/brLastPodium');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brpod-')), 'br-last-podium.json');
  const store = () => createLastPodiumStore({ file, log: quiet });

  const { ft, room, match } = makeBr({ lastStore: store() });
  const me = human(room, 'Solo', 'WS');
  room.spawnSnake({ nick: 'bot', cv: 2, isBot: true });
  match.startMatch('test');
  run(ft, room, BRM.COUNTDOWN_MS + 200);
  room.sim.forEachSnake((sn) => { if (sn.id !== me.id) room.sim.kill(sn.id); });
  run(ft, room, 200);
  assert.strictEqual(match.state, 'over');
  const s = makeBr({ lastStore: store() }).match.publicState();
  assert.strictEqual(s.soloRun, true);
  assert.strictEqual(s.prize, 0, 'a solo run paid nothing, and says so after the restart too');
  assert.deepStrictEqual(s.winner, { name: 'Solo', id: null });

  for (const junk of ['not json', '{"podium":"x"}', JSON.stringify({ podium: [{ name: 'a'.repeat(500) }], winner: null, prize: 0 }),
    JSON.stringify({ podium: [], winner: null, prize: -5 })]) {
    fs.writeFileSync(file, junk);
    assert.strictEqual(store().load(), null, junk.slice(0, 20));
    assert.strictEqual(makeBr({ lastStore: store() }).match.publicState().podium, null);
  }
});
