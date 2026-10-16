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
    onDecided: (m) => decided.push(JSON.parse(JSON.stringify(m.winner))), lastStore: opts.lastStore });
  const room = new SlRoom(LAWS, Object.assign({ seed: 7, view: opts.realView ? undefined : fakeView(), br: match,
    clock: ft.clock, timers: ft.timers, autoTick: false, shippableOnly: false, prey: false, now: () => 1.7e12,
    log: quiet }, opts.room));
  return { ft, room, match, decided };
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

test('a solo run: one person and bots; the door shuts at start, Q is refused, the last bot dies and they win (no prize flag)', () => {
  const { ft, room, match, decided } = makeBr();
  const me = human(room, 'Owen', 'W1');
  const bots = [room.spawnSnake({ nick: 'b1', cv: 2, isBot: true }), room.spawnSnake({ nick: 'b2', cv: 3, isBot: true })];
  run(ft, room, 200);
  assert.strictEqual(match.state, 'waiting');
  assert.strictEqual(match.canStart(), true);
  assert.strictEqual(match.startMatch('test'), true);
  assert.strictEqual(match.state, 'countdown');
  assert.strictEqual(match.startMatch('again'), false, 'one match at a time');
  assert.strictEqual(room.seat(bareSocket(), { nick: 'late', cv: 1 }), null);
  assert.strictEqual(room.refusal(), 'match');
  assert.strictEqual(room.onHold(me.seat, true), false, 'no Q while the match is fought');
  run(ft, room, BRM.COUNTDOWN_MS + 200);
  assert.strictEqual(match.state, 'running');
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

test('the prize needs two PEOPLE: two seats of one wallet plus a seat with no proven wallet play it out, prize held', () => {
  const { ft, room, match, decided } = makeBr();
  const a = human(room, 'Owen', 'W1');
  const b = human(room, 'Owen2', 'W1'); // a second tab of the same wallet
  const c = human(room, 'Script', null); // a socket that proved nothing
  room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  match.startMatch('test');
  assert.strictEqual(match.publicState().startedWith, 3);
  assert.strictEqual(match.soloRun, false, 'three seats: last person standing');
  assert.strictEqual(match.prizeHeld, true, 'one proven wallet: no automatic prize');
  assert.strictEqual(match.publicState().prize, 0, 'the countdown promises nothing');
  run(ft, room, BRM.COUNTDOWN_MS + 200);
  room.sim.kill(b.id);
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

test('a solo run the person loses: the bots outlast them and nobody wins', () => {
  const { ft, room, match } = makeBr();
  const me = human(room, 'Owen', 'W1');
  room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  room.spawnSnake({ nick: 'b2', cv: 2, isBot: true });
  match.startMatch('test');
  run(ft, room, BRM.COUNTDOWN_MS + 200);
  room.sim.kill(me.id);
  run(ft, room, 200);
  assert.strictEqual(match.state, 'over');
  assert.strictEqual(match.winner, null, 'dying does not win a solo run');
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
  room.sim.kill(c.id);
  run(ft, room, 200);
  assert.strictEqual(match.state, 'running', 'two people still in it');
  room.sim.kill(a.id);
  run(ft, room, 200);
  assert.strictEqual(match.state, 'over');
  assert.deepStrictEqual(decided[0], { id: b.id, name: 'Ben', wallet: 'WB' });
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

test('forceStart relaxes only the minimum: refused mid-match and with nobody in the room', () => {
  const { ft, room, match } = makeBr();
  assert.strictEqual(match.forceStart('x'), false, 'nobody here');
  human(room, 'Owen', 'W1');
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

test('msUntilNextStart counts to the next 8:05 pm Eastern', () => {
  const ms = msUntilNextStart(Date.UTC(2026, 9, 16, 23, 0)); // 19:00 EDT
  assert.strictEqual(ms, 65 * 60 * 1000);
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
});

test('setBr: once a match is under way a join is refused match; a watcher is seated; with nothing alive, nobody', () => {
  const r = brRig();
  const a = r.sock({ auth: { br: 1 } });
  a.fire('sl:join', { nick: 'Ann' });
  assert.strictEqual(r.br.match.startMatch('test'), true);
  const late = r.sock({ auth: { br: 1 } });
  late.fire('sl:join', { nick: 'Late' });
  refusedWith(late, 'match');
  const pushes = r.pushes.length;
  const w = r.sock({ auth: { br: 1, watch: 1 } });
  w.fire('sl:join', {});
  assert.strictEqual(r.br.room().watchers.size, 1);
  assert.ok(layerMsgs(w).some((m) => m.t === 'watch'));
  assert.strictEqual(r.pushes.length, pushes, 'a watcher is not a join push');
  w.fire('sl:leave');
  w.fire('disconnect', 'client namespace disconnect');
  assert.strictEqual(r.br.room().watchers.size, 0);
  const aId = r.br.room().seatOf(a.id).snakeId;
  assert.ok(r.br.room().sim.snake(aId), 'the player plays on');
  r.br.match.abandon();
  r.br.room().sim.kill(aId);
  for (let i = 0; i < 4; i++) {
    r.ft.advance(P);
    r.br.room().wake();
  }
  const w2 = r.sock({ auth: { br: 1, watch: 1 } });
  w2.fire('sl:join', {});
  refusedWith(w2, 'nobody');
});

test('an emergency close lets go of watchers too; the replacement room forgets the old seats and keeps its heartbeat', () => {
  const r = brRig();
  const a = r.sock({ auth: { br: 1, idProof: { ok: true, wallet: 'WA' } } });
  a.fire('sl:join', { nick: 'Ann' });
  const w = r.sock({ auth: { br: 1, watch: 1 } });
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
  const w = r.sock({ auth: { br: 1, watch: 1 } });
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
  for (let i = 0; i < 2; i++) r.sock({ auth: { br: 1, watch: 1 } }).fire('sl:join', {});
  assert.strictEqual(r.br.room().watchers.size, 2);
  const w = r.sock({ auth: { br: 1, watch: 1 } });
  w.fire('sl:join', {});
  refusedWith(w, 'full');
});

test('the event directory: no board row, its slice read and reset, a replaced room ends the match with no winner', () => {
  const r = brRig();
  assert.deepStrictEqual(r.br.boardRows(), []);
  r.br.room().stats.maxSliceMs = 7;
  assert.strictEqual(r.br.maxSliceMs(), 7);
  assert.strictEqual(r.br.maxSliceMs(), 0);
  const a = r.sock({ auth: { br: 1 } });
  a.fire('sl:join', { nick: 'Ann' });
  r.br.match.startMatch('test');
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
  room.spawnSnake({ nick: 'bot', cv: 2, isBot: true });
  match.startMatch('test');
  run(ft, room, BRM.COUNTDOWN_MS + 200);
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
  after.match.startMatch('test');
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
