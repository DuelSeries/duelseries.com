'use strict';
/* THE DUELS' RECONNECT GRACE (KnockoutLobby drop / rejoin, KnockoutRoom's "a dropped connection"): Rooftop Snipers,
   Crossy Road, Air Hockey and 8 Ball Pool hold a dropped seat for five seconds (Swim's number), the match running on,
   and a reconnect that shows the seat's one-time key takes it back. For each of the four, through its own lobby and
   room classes:
     · a drop then a resume inside 5 s keeps the match and the seat (and the stake, the wallet, the pot)
     · a drop with no resume forfeits after 5 s, exactly then, exactly once, to the right seat
     · a wrong, guessed, foreign or reused key is refused
     · a drop during the result hold (Crossy: a match decided in the grace) settles by the result
   and around them: the other player and watchers are told by seat, a deliberate leave still forfeits at once, both
   seats running out together, the free bot match, the queue's own resume, and Knockout and Head Soccer unchanged. */

const test = require('node:test');
const assert = require('node:assert');
const { RooftopLobby } = require('../server/RooftopLobby');
const { AirHockeyLobby } = require('../server/AirHockeyLobby');
const { Pool8Lobby } = require('../server/Pool8Lobby');
const { P8R } = require('../server/Pool8Room');
const { CrossyLobby } = require('../server/crossy/CrossyLobby');
const { KnockoutLobby } = require('../server/KnockoutLobby');
const { HeadSoccerLobby } = require('../server/HeadSoccerLobby');
const { RECONNECT_GRACE_MS, FREE_WAIT_MS } = require('../server/duelQueue');
const { RT } = require('../shared/rtSim');
const { AH } = require('../shared/ahSim');
const CS = require('../shared/crossySim');

const GRACE = 5000;
const STEP = 1000 / 60;

function fakeIo() {
  const log = [];
  const to = (name) => ({ emit: (e, p) => log.push({ to: name, e, p }), volatile: { emit: (e, p) => log.push({ to: name, e, p }) } });
  return { log, to };
}
function sock(id) { const sent = []; return { id, sent, join() {}, leave() {}, emit(e, p) { sent.push({ e, p }); } }; }
const keyOf = (s, ev) => { const m = s.sent.filter(x => x.e === ev + ':seat').pop(); return m ? m.p.key : null; };
const lastTo = (s, e) => s.sent.filter(x => x.e === e).pop();

/* Crossy's test map: an empty field, nothing but the eagle (test/crossy.test.js handWorld). */
function handWorld() {
  const w = new CS.World(1);
  w.next = 1e9;
  const blank = (r) => ({ r, h: 0.375, cells: new Int8Array(9), look: new Int8Array(9), coin: null, alt: 0, kind: 'grass', type: 'grass', name: 'grass' });
  return new Proxy(w, { get(t, k) { if (k === 'row') return (r) => t.rows.get(r) || (t.rows.set(r, blank(r)), t.rows.get(r)); return t[k]; } });
}

/* Each game: its lobby, its event prefix, and how long until it is being played. Crossy's seats are fed hops (a
   forward hop every half second keeps the eagle off a seat that is still connected). */
const GAMES = {
  rooftop: { Lobby: RooftopLobby, ev: 'rt', on: RT.READY_MS + 300 },
  airhockey: { Lobby: AirHockeyLobby, ev: 'ah', on: AH.COUNTDOWN_MS + 300 },
  pool8: { Lobby: Pool8Lobby, ev: 'p8', on: P8R.VS_MS + 300 },
  crossy: { Lobby: CrossyLobby, ev: 'cr', on: CS.DUEL.COUNTDOWN_MS + 300 },
};

function setup(name, stake) {
  const g = GAMES[name];
  const io = fakeIo();
  const lob = new g.Lobby(io);
  const settled = [], refunds = [];
  lob.onSettled = (m) => settled.push(m);
  lob.onRefund = (m) => refunds.push(m);
  const a = sock('A'), b = sock('B');
  const s = stake === undefined ? 1 : stake;
  lob.enqueue(a, 'Ann', 'WA', s, s, 0, s);
  lob.enqueue(b, 'Bob', 'WB', s, s, 0, s);
  const room = lob.roomOf('A');
  assert.ok(room && room === lob.roomOf('B'), name + ': the two met');
  if (name === 'crossy') room.world = handWorld();
  const env = { g, io, lob, room, settled, refunds, a, b, t: 0, live: new Set(['A', 'B']) };
  return env;
}
/* Ticks the LOBBY (which ticks the room and runs the grace) up to `until`. */
function runTo(env, until) {
  const { lob, room } = env;
  for (let t = env.t + STEP; t <= until; t += STEP) {
    if (room.ev === 'cr' && room.state === 'playing') {
      const tick = Math.max(0, Math.floor((t - room.goAt) / CS.TICK_MS) - 1);
      for (const id of env.live) room.input(id, { t: tick, h: tick % 30 === 0 ? [[tick, CS.IN.FWD]] : [] });
    }
    lob.tick(t);
    env.t = t;
  }
  if (env.t < until) { lob.tick(until); env.t = until; }
}
function drop(env, id) {
  env.live.delete(id);
  // Crossy: a dropped hopper stands still; its eagle is pushed out of the way so the grace, not the eagle, is tested.
  if (env.room.ev === 'cr') { const p = env.room.players.get(id); if (p) p.cr.h.eagle = -60; }
  return env.lob.drop(id, env.t);
}

for (const name of Object.keys(GAMES)) {
  const ev = GAMES[name].ev;

  test(name + ': a drop then a resume inside 5 s keeps the match, the seat, the stake and the wallet', () => {
    const env = setup(name, 1);
    const { lob, room, io, settled, a } = env;
    runTo(env, env.g.on);
    assert.notStrictEqual(room.state, 'over');
    const key = keyOf(a, ev);
    assert.match(key, /^[0-9a-f]{32}$/, 'A was sent its seat key');
    assert.notStrictEqual(key, keyOf(env.b, ev), 'each seat its own key');
    assert.ok(!io.log.some(m => JSON.stringify(m.p || '').includes(key)), 'the key is never broadcast');
    const side = room.players.get('A').side;
    const T = env.t;
    assert.strictEqual(drop(env, 'A'), true, 'held');
    assert.ok(io.log.some(m => m.e === ev + ':away' && m.p.side === side && m.p.ms === GRACE), 'the other player is told, by seat');
    runTo(env, T + 3000);
    assert.notStrictEqual(room.state, 'over', 'the match ran on');
    assert.strictEqual(settled.length, 0);
    assert.strictEqual(lob.roomOf('A'), room, 'the seat is held');

    const a2 = sock('A2');
    const r = lob.rejoin(a2, key, env.t);
    assert.ok(r.ok, 'the key takes the seat back');
    const back = lastTo(a2, ev + ':rejoined');
    assert.ok(back && back.p.side === side && back.p.players.some(p => p.id === 'A2'), 'the match as it is, by the new socket');
    assert.strictEqual(lob.roomOf('A2'), room);
    assert.strictEqual(lob.roomOf('A'), null);
    assert.ok(!room.players.has('A') && room.players.get('A2').wallet === 'WA', 'the seat keeps the wallet that paid');
    assert.strictEqual(room.worth.get('A2'), 1);
    assert.ok(!room.worth.has('A'));
    assert.strictEqual(room.pot(), 2, 'the pot is the same sum');
    assert.strictEqual(room.seats[side].id, 'A2');
    assert.ok(io.log.some(m => m.e === ev + ':back' && m.p.side === side), 'and told it is back');
    const key2 = keyOf(a2, ev);
    assert.match(key2, /^[0-9a-f]{32}$/);
    assert.notStrictEqual(key2, key, 'a fresh key after every rejoin');
    env.live.add('A2');
    runTo(env, T + GRACE + 3000);
    assert.notStrictEqual(room.state, 'over', 'no forfeit when the grace would have run out');
    assert.strictEqual(settled.length, 0);
    // The match goes on to a result as usual: here Bob walks out, so the seat that came back is paid, once.
    lob.leave('B');
    runTo(env, env.t + 1500);
    assert.strictEqual(settled.length, 1);
    assert.strictEqual(settled[0].winnerId, 'A2');
    assert.strictEqual(settled[0].seats.find(s => s.id === 'A2').wallet, 'WA');
    assert.strictEqual(settled[0].pot, 2);
  });

  test(name + ': a drop with no resume forfeits after exactly 5 s, once, to the seat that stayed', () => {
    const env = setup(name, 1);
    const { lob, room, settled, refunds, a } = env;
    runTo(env, env.g.on);
    const key = keyOf(a, ev);
    const T = env.t;
    drop(env, 'A');
    runTo(env, T + GRACE - 1);
    assert.strictEqual(settled.length, 0, 'nothing decided inside the grace');
    assert.strictEqual(lob.roomOf('A'), room, 'still held at 4.999 s');
    runTo(env, T + GRACE);
    assert.strictEqual(lob.roomOf('A'), null, 'let go at 5 s');
    runTo(env, T + GRACE + 1500);               // Crossy gives the stayer's timeline a moment to reach the leave
    assert.strictEqual(room.state, 'over');
    assert.strictEqual(settled.length, 1, 'settled once');
    assert.strictEqual(settled[0].winnerId, 'B');
    assert.strictEqual(settled[0].why, 'opponent left', 'the old forfeit exactly');
    assert.strictEqual(refunds.length, 0);
    runTo(env, env.t + 2000);
    lob.leave('B'); lob.leave('A'); lob.drop('A', env.t);
    assert.strictEqual(settled.length, 1, 'never a second time');
    // A reconnect after it ended is shown that result, by the id its seat had, and cannot sit down again.
    const late = sock('A3');
    assert.strictEqual(lob.rejoin(late, key, env.t).ok, false);
    const fail = lastTo(late, ev + ':rejoinfail');
    assert.ok(fail.p.over && fail.p.over.winnerId === 'B' && fail.p.you === 'A', 'the real result');
    assert.strictEqual(lob.roomOf('A3'), null);
    const again = sock('A4');
    lob.rejoin(again, key, env.t);
    assert.ok(!lastTo(again, ev + ':rejoinfail').p.over, 'the result is told once');
  });

  test(name + ': a wrong, guessed, foreign or reused key is refused', () => {
    const env = setup(name, 1);
    const { lob, room } = env;
    runTo(env, env.g.on);
    const keyA = keyOf(env.a, ev), keyB = keyOf(env.b, ev);
    // A second table, to try its key here.
    const c = sock('C'), d = sock('D');
    lob.enqueue(c, 'Cat', 'WC', 1, 1, env.t, 1);
    lob.enqueue(d, 'Dan', 'WD', 1, 1, env.t, 1);
    const other = lob.roomOf('C');
    assert.ok(other && other !== room);
    drop(env, 'A');
    const tries = [undefined, null, '', 'A', 'B', room.id, '0'.repeat(32), keyA.toUpperCase(), keyA + '0', { key: keyA }, [keyA]];
    for (const k of tries) {
      const s = sock('X' + Math.random());
      assert.strictEqual(lob.rejoin(s, k, env.t).ok, false, 'refused: ' + JSON.stringify(k));
      assert.ok(lastTo(s, ev + ':rejoinfail'));
      assert.strictEqual(lob.roomOf(s.id), null);
    }
    // A socket already seated somewhere cannot take another seat with a key.
    assert.strictEqual(lob.rejoin(c, keyA, env.t).ok, false, 'a seated socket');
    // A key opens only its own seat at its own table: B's key takes B's seat (B is still connected), never A's.
    assert.strictEqual(room.seatByKey(keyB).id, 'B');
    assert.strictEqual(other.seatByKey(keyA), null, 'nothing at the other table');
    assert.strictEqual(room.seatByKey(keyOf(c, ev)), null);
    const a2 = sock('A2');
    assert.ok(lob.rejoin(a2, keyA, env.t).ok, 'the right key, once');
    const a3 = sock('A3');
    assert.strictEqual(lob.rejoin(a3, keyA, env.t).ok, false, 'used: dead');
    assert.strictEqual(lob.roomOf('A3'), null);
    assert.strictEqual(lob.roomOf('A2'), room, 'and the seat stays with the socket that took it');
    assert.strictEqual(room.pot(), 2);
  });
}

test('rooftop: a drop during the winning fall\'s hold settles by the score, to the seat that dropped', () => {
  const env = setup('rooftop', 0.5);
  const { room, settled } = env;
  runTo(env, RT.READY_MS + 200);
  room.match.score = [2, 4];
  const b = room.match.p[0].body;                // red falls: blue reaches five
  b.x = -700; b.y = RT.DEATH_Y + 5; b.vy = 50;
  runTo(env, env.t + 100);
  assert.strictEqual(room.state, 'settling');
  const blue = room.seats[1].id;
  drop(env, blue);
  runTo(env, env.t + GRACE + 2000);
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, blue, 'the score decides, not who was connected');
  assert.notStrictEqual(settled[0].why, 'opponent left');
});

test('airhockey: a drop during the hold after the winning goal settles by the score', () => {
  const env = setup('airhockey', 1);
  const { room, settled } = env;
  runTo(env, AH.COUNTDOWN_MS + 100);
  room.score = [AH.TO_WIN - 1, 0];
  room.whistle(env.t, 'goal');
  room.score = [AH.TO_WIN, 0];
  assert.strictEqual(room.state, 'settling');
  const winner = room.seats[0].id;
  drop(env, winner);
  runTo(env, env.t + GRACE + 1000);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, winner);
  assert.strictEqual(settled[0].why, 'first to ' + AH.TO_WIN);
});

test('pool8: a drop during the result hold settles by the verdict, whether the hold or the grace ends first', () => {
  for (const holdMs of [2000, 20000]) {
    const env = setup('pool8', 1);
    const { room, settled } = env;
    runTo(env, P8R.VS_MS + 100);
    room.pending = { winner: 0, why: 'potted the 8' };
    room.state = 'settling';
    room.phaseEndsAt = env.t + holdMs;
    const winner = room.seats[0].id;
    drop(env, winner);
    runTo(env, env.t + GRACE + 1000);
    if (holdMs > GRACE) assert.strictEqual(room.state, 'over', 'the grace ran out first: the verdict, not the walk-out');
    runTo(env, env.t + holdMs);
    assert.strictEqual(settled.length, 1, 'once (hold ' + holdMs + ')');
    assert.strictEqual(settled[0].winnerId, winner);
    assert.strictEqual(settled[0].why, 'potted the 8');
  }
});

test('crossy: a match decided inside the grace settles by its result, to the seat that dropped', () => {
  const env = setup('crossy', 1);
  const { room, settled } = env;
  runTo(env, CS.DUEL.COUNTDOWN_MS + 300);
  const T = env.t;
  drop(env, 'A');                                // A stands still (its eagle pushed back)
  env.live.delete('B');                          // and Bob, still connected, stops hopping a second from the eagle
  room.players.get('B').cr.h.eagle = CS.C.EAGLE_S - 1;
  runTo(env, T + GRACE - 1);
  assert.strictEqual(room.state, 'over', 'decided inside the grace');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, 'A', 'the result, not who was connected');
  assert.strictEqual(settled[0].why, 'taken by the eagle');
});

/* ── around the grace ─────────────────────────────────────────────────── */

test('watchers are told who is reconnecting by seat, never by socket id', () => {
  const env = setup('rooftop', 1);
  const { lob, room, io } = env;
  runTo(env, RT.READY_MS + 300);
  const w = sock('W');
  assert.ok(lob.watch(w, {}).ok);
  drop(env, 'A');
  const seen = io.log.filter(m => m.to === room.watchRoomName && (m.e === 'rt:away' || m.e === 'rt:back'));
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(Object.keys(seen[0].p).sort(), ['ms', 'side']);
  lob.rejoin(sock('A2'), keyOf(env.a, 'rt'), env.t);
  const back = io.log.filter(m => m.to === room.watchRoomName && m.e === 'rt:back');
  assert.strictEqual(back.length, 1);
  assert.ok(!JSON.stringify(back[0].p).includes('A2'));
});

test('a deliberate leave still forfeits at once: the rejoined seat, and the stayer while the other is away', () => {
  let env = setup('rooftop', 1);
  runTo(env, RT.READY_MS + 300);
  drop(env, 'A');
  const a2 = sock('A2');
  env.lob.rejoin(a2, keyOf(env.a, 'rt'), env.t);
  env.lob.leave('A2');                           // rt:leave from the socket that came back
  assert.strictEqual(env.settled.length, 1);
  assert.strictEqual(env.settled[0].winnerId, 'B');

  env = setup('pool8', 1);
  runTo(env, P8R.VS_MS + 300);
  drop(env, 'A');
  env.lob.leave('B');                            // Bob walks out while Ann is reconnecting: Ann wins
  assert.strictEqual(env.settled.length, 1);
  assert.strictEqual(env.settled[0].winnerId, 'A');
  assert.strictEqual(env.settled[0].seats.find(s => s.id === 'A').wallet, 'WA');
});

test('both seats running out on the same deadline is a draw, each its own stake; in the result hold, the result', () => {
  let env = setup('airhockey', 1);
  runTo(env, AH.COUNTDOWN_MS + 300);
  drop(env, 'A'); drop(env, 'B');
  runTo(env, env.t + GRACE);
  assert.strictEqual(env.settled.length, 1);
  assert.strictEqual(env.settled[0].winnerId, null);
  assert.strictEqual(env.settled[0].why, 'both out');
  assert.deepStrictEqual(env.settled[0].seats.map(s => [s.wallet, s.refund]).sort(), [['WA', 1], ['WB', 1]]);

  env = setup('pool8', 1);
  runTo(env, P8R.VS_MS + 300);
  env.room.pending = { winner: 1, why: 'potted the 8' };
  env.room.state = 'settling';
  env.room.phaseEndsAt = env.t + 60000;
  drop(env, 'A'); drop(env, 'B');
  runTo(env, env.t + GRACE);
  assert.strictEqual(env.settled.length, 1);
  assert.strictEqual(env.settled[0].winnerId, env.room.seats[1].id);
  assert.strictEqual(env.settled[0].why, 'potted the 8');

  // One after the other: the first to run out is the one who left, as before.
  env = setup('rooftop', 1);
  runTo(env, RT.READY_MS + 300);
  drop(env, 'B');
  runTo(env, env.t + 1000);
  drop(env, 'A');
  runTo(env, env.t + GRACE);
  assert.strictEqual(env.settled.length, 1);
  assert.strictEqual(env.settled[0].winnerId, 'A');
});

test('the free bot match: a drop is held too, a resume plays on, no resume hands it to the bot with no money', () => {
  const io = fakeIo();
  const lob = new RooftopLobby(io);
  const settled = [];
  lob.onSettled = (m) => settled.push(m);
  const a = sock('A');
  lob.enqueue(a, 'Owen', null, 0, 0, 0);
  lob.tick(FREE_WAIT_MS + 1);
  const room = lob.roomOf('A');
  assert.ok(room && room.bot && room.pot() === 0);
  const key = keyOf(a, 'rt');
  assert.ok(key, 'a key for the person');
  assert.strictEqual(room.seatKeys.size, 1, 'none for the bot');
  let t = FREE_WAIT_MS + 1;
  for (; t < FREE_WAIT_MS + 2000; t += STEP) lob.tick(t);
  lob.drop('A', t);
  // A newcomer is never paired with a bot match whose person is away.
  lob.enqueue(sock('N'), 'New', null, 0, 0, t);
  assert.ok(lob.rooms.has(room.id), 'the bot match was not dissolved');
  assert.strictEqual(lob.roomOf('A'), room);
  assert.ok(lob.rejoin(sock('A2'), key, t + 1000).ok);
  for (const end = t + 8000; t < end; t += STEP) lob.tick(t);
  assert.notStrictEqual(room.state, 'over');
  lob.drop('A2', t);
  const T = t;
  for (const end = T + GRACE + 100; t < end; t += STEP) lob.tick(t);
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.winner, room.bot.id);
  assert.strictEqual(settled.length, 0, 'a free table never settles money');
});

test('a queued seat that drops is the old rule: out at once, a paid one refunded once, and its resume key says so', () => {
  const lob = new CrossyLobby(fakeIo());
  const refunds = [];
  lob.onRefund = (m) => refunds.push(m);
  const a = sock('A');
  lob.enqueue(a, 'Ann', 'WA', 1, 1, 0, 1);
  const rk = lob.resumeKeyOf('A');
  assert.strictEqual(lob.drop('A', 10), false, 'not held: it is not at a table');
  assert.strictEqual(lob.queue.length, 0);
  assert.deepStrictEqual(refunds.map(r => [r.wallet, r.amount]), [['WA', 1]]);
  assert.deepStrictEqual(lob.resume(sock('A2'), rk), { refunded: true });

  // And the queue's own resume still takes a waiting seat back (duelQueue.resumeSeat), untouched by the grace.
  const lob2 = new Pool8Lobby(fakeIo());
  const b = sock('B');
  lob2.enqueue(b, 'Bob', 'WB', 1, 1, 0, 1);
  const r = lob2.resume(sock('B2'), lob2.resumeKeyOf('B'));
  assert.ok(r && r.resumed && r.resumed.socket.id === 'B2');
  assert.strictEqual(lob2.queue.length, 1);
});

test('a restart: a held seat is still owed its stake, and a rejoin is told the server is restarting', () => {
  const env = setup('rooftop', 1);
  runTo(env, RT.READY_MS + 300);
  drop(env, 'A');
  const rows = env.lob.shutdownSettle('shutdown');
  assert.deepStrictEqual(rows.map(r => [r.wallet, r.micro]).sort(), [['WA', 1e6], ['WB', 1e6]]);
  const s = sock('A2');
  assert.strictEqual(env.lob.rejoin(s, keyOf(env.a, 'rt'), env.t).ok, false);
  assert.strictEqual(lastTo(s, 'rt:rejoinfail').p.restart, true);
});

test('rooftop: the seat that comes back carries on its input counts from where the server has them', () => {
  const env = setup('rooftop', 1);
  const { room, lob } = env;
  runTo(env, RT.READY_MS + 300);
  const side = room.players.get('A').side;
  room.setInput('A', { s: 7, j: 3, d: 2, r: 2, n: 5 });
  drop(env, 'A');
  const a2 = sock('A2');
  lob.rejoin(a2, keyOf(env.a, 'rt'), env.t);
  const m = lastTo(a2, 'rt:rejoined').p;
  assert.deepStrictEqual(m.inp, { j: 3, d: 2, r: 2, n: 5 });
  assert.strictEqual(m.ack, 7);
  assert.strictEqual(room.sideOfSocket('A2'), side);
  assert.ok(room.setInput('A2', { s: 8, j: 4, d: 2, r: 2, n: 5 }), 'the new socket presses for the seat');
  assert.strictEqual(room.inputs[side].j, 4);
  assert.strictEqual(room.setInput('A', { s: 9, j: 9 }), false, 'the old socket presses nothing');
});

test('Knockout and Head Soccer keep the old rule: no seat key, and a drop is a leave at once', () => {
  for (const L of [KnockoutLobby, HeadSoccerLobby]) {
    const lob = new L(fakeIo());
    const settled = [];
    lob.onSettled = (m) => settled.push(m);
    const a = sock('A'), b = sock('B');
    lob.enqueue(a, 'Ann', 'WA', 1, 1, 0, 1);
    lob.enqueue(b, 'Bob', 'WB', 1, 1, 0, 1);
    assert.strictEqual(lob.graceMs, 0);
    assert.ok(!a.sent.some(x => /:seat$/.test(x.e)), 'no key sent');
    assert.strictEqual(lob.drop('A', 10), false);
    assert.strictEqual(settled.length, 1);
    assert.strictEqual(settled[0].winnerId, 'B');
  }
});

test('the grace is Swim\'s number', () => {
  assert.strictEqual(RECONNECT_GRACE_MS, 5000);
  for (const name of Object.keys(GAMES)) assert.strictEqual(new GAMES[name].Lobby(fakeIo()).graceMs, RECONNECT_GRACE_MS);
});

/* ── the page side (public/js/shared/dsSeatHold.js) ─────────────────────── */

test('the page keeps its key, says Reconnecting..., asks for its seat back once, and names the other player', () => {
  require('../public/js/shared/dsSeatHold.js');
  const H = globalThis.DSSeatHold;
  const fake = () => {
    const on = {}, out = [];
    return { on: (e, f) => { on[e] = f; }, emit: (e, p) => out.push({ e, p }), fire: (e, p) => on[e] && on[e](p), out };
  };
  const el = (text) => ({ textContent: text, hidden: true });
  const s = fake(), pill = el('Playing a bot'), line = el('');
  let live = true;
  const hold = H.create({ socket: s, ev: 'rt', watch: false, pill, line, live: () => live, nameOf: (side) => ['Ann', 'Bob'][side], mySeat: () => 0 });
  assert.strictEqual(hold.rejoin(), false, 'no key yet: nothing to ask');
  s.fire('rt:seat', { key: 'nope' });
  assert.strictEqual(hold.rejoin(), false, 'only a real key is kept');
  const key = 'ab'.repeat(16);
  s.fire('rt:seat', { key });
  s.fire('disconnect');
  assert.strictEqual(pill.hidden, false);
  assert.strictEqual(pill.textContent, 'Reconnecting...');
  assert.strictEqual(hold.rejoin(), true);
  assert.deepStrictEqual(s.out, [{ e: 'rt:rejoin', p: { key } }]);
  hold.back();
  assert.strictEqual(pill.hidden, true);
  assert.strictEqual(pill.textContent, 'Playing a bot', 'the pill gets its own words back');
  s.fire('rt:away', { side: 0, ms: 5000 });
  assert.strictEqual(pill.hidden, true, 'never about my own seat');
  s.fire('rt:away', { side: 1, ms: 5000 });
  assert.strictEqual(pill.textContent, 'Bob is reconnecting...');
  s.fire('rt:back', { side: 1 });
  assert.strictEqual(pill.hidden, true);
  hold.done();
  assert.strictEqual(hold.rejoin(), false, 'a finished match forgets its key');
  live = false;
  s.fire('rt:seat', { key });
  assert.strictEqual(hold.rejoin(), false, 'nothing to rejoin with no match on screen');

  // A watcher: the line, by seat.
  const w = fake(), wline = el('');
  H.create({ socket: w, ev: 'rt', watch: true, pill: el(''), line: wline, live: () => true, nameOf: () => '', mySeat: () => -1 });
  w.fire('rt:seat', { key });
  w.fire('rt:away', { side: 0, ms: 5000 });
  assert.strictEqual(wline.textContent, 'A player is reconnecting...', 'a watcher with no name to hand');
  w.fire('rt:back', { side: 0 });
  assert.strictEqual(wline.hidden, true);
  assert.strictEqual(wline.textContent, '');
});
