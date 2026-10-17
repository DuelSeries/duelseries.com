'use strict';
/* KNOCKOUT: watching somebody else's match (the lobby's Spectate).

   A watcher is a third person who must never be a player in any way that
   counts: not in the queue, not in a room's players, not counted on the live
   board, not anywhere the money reads. And never told more than the two
   players are: in this mode that means nobody's arrows before the turn has
   closed, and nobody's socket id ever (a watcher is told seats, 0 and 1). */

const test = require('node:test');
const assert = require('node:assert');
const { KnockoutLobby, BOT_AFTER_MS, WATCH_CAP } = require('../server/KnockoutLobby');
const { KO } = require('../server/KnockoutRoom');
const { liveCounts } = require('../server/liveCounts');

/* An io that remembers every room emit, and sockets that remember what they
   were sent and which socket.io rooms they are in. */
function rig() {
  const roomSent = [];
  const io = { to: (room) => ({ emit: (ev, p) => roomSent.push({ room, ev, p }) }) };
  const lob = new KnockoutLobby(io);
  const settled = [], refunds = [];
  lob.onSettled = (m) => settled.push(m);
  lob.onRefund = (m) => refunds.push(m);
  return { io, lob, roomSent, settled, refunds };
}
function sock(id) {
  const sent = [], rooms = new Set();
  return {
    id, sent, rooms,
    join(r) { rooms.add(r); }, leave(r) { rooms.delete(r); },
    emit(ev, p) { sent.push({ ev, p }); },
    last(ev) { for (let i = sent.length - 1; i >= 0; i--) if (sent[i].ev === ev) return sent[i].p; return null; },
  };
}
const humans = (lob) => liveCounts({ knockout: lob }).knockout;
const json = (p) => JSON.stringify(p);

test('watching takes no seat, no queue entry and no count, and is a room of its own', () => {
  const { lob } = rig();
  const A = sock('sockA-7f3c'), B = sock('sockB-91de'), W = sock('watcher-1');
  lob.enqueue(A, 'Owen', null, 0, 0);
  lob.enqueue(B, 'Nia', null, 0, 0);
  const room = lob.roomOf(A.id);
  assert.ok(room, 'a match is running');
  const before = humans(lob);
  assert.strictEqual(before, 2);

  const r = lob.watch(W, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(lob.queue.length, 0, 'nobody is queued');
  assert.ok(!room.players.has(W.id), 'not a player');
  assert.ok(!lob.bySocket.has(W.id), 'holds no seat');
  assert.strictEqual(humans(lob), before, 'the live count does not move');
  assert.ok(W.rooms.has('kow_' + room.id), 'in the watcher room');
  assert.ok(!W.rooms.has(room.socketRoomName), 'and never in the players\' room');
  assert.strictEqual(room.watchers, 1);

  const m = W.last('ko:watching');
  assert.ok(m && m.match && m.state, 'told what it is watching straight away');
  assert.deepStrictEqual(m.match.names, ['Owen', 'Nia']);
  assert.strictEqual(m.match.id, room.id);
  assert.strictEqual(m.match.count, 1);
  assert.strictEqual(m.match.index, 1);
  for (const p of m.state.players) assert.ok(!('id' in p), 'players by seat, not by id');
  for (const p of m.state.pieces) {
    assert.ok(!('owner' in p), 'pieces by seat, not by owner');
    assert.ok(p.side === 0 || p.side === 1);
  }
  assert.ok(!json(m).includes(A.id) && !json(m).includes(B.id), 'no socket id anywhere');
});

test('no arrow reaches a watcher before the turn closes, and the reveal comes by seat', () => {
  const { lob, roomSent } = rig();
  const A = sock('sockA-7f3c'), B = sock('sockB-91de'), W = sock('watcher-1'), W2 = sock('watcher-2');
  const T0 = 1000000;
  lob.enqueue(A, 'Owen', null, 0, 0, T0);
  lob.enqueue(B, 'Nia', null, 0, 0, T0);
  const room = lob.roomOf(A.id);
  lob.watch(W, {});
  for (let t = T0; room.state !== 'aiming'; t += 200) lob.tick(t);

  const mine = room.piecesOf(A.id);
  room.submitAim(A.id, [{ pieceId: mine[0].id, ax: 137, ay: -91 }]);
  room.lockIn(A.id);
  room.broadcast('ko:ready', { ready: [...room.ready] });       // what index.js does on ko:lock

  /* Somebody arriving now, with one side's arrows already committed. */
  lob.watch(W2, {});
  const late = W2.last('ko:watching');
  assert.strictEqual(late.state.state, 'aiming');
  assert.ok(!('resolve' in late.state), 'no tape and no arrows while aiming');
  assert.ok(!/"ax"|"ay"/.test(json(late)), 'nothing shaped like an aim');

  const toWatchers = () => roomSent.filter(s => s.room === room.watchRoomName);
  for (const s of toWatchers()) {
    assert.ok(!/"ax"|"ay"|"reveal"/.test(json(s.p)), s.ev + ' carried an aim before the turn closed');
  }
  const ready = toWatchers().find(s => s.ev === 'ko:ready');
  assert.deepStrictEqual(ready.p, { ready: [0] }, 'who has locked in, as a seat');

  /* Close the turn. */
  let t = T0 + 60000;
  while (room.state === 'aiming') { lob.tick(t); t += 200; }
  const res = toWatchers().find(s => s.ev === 'ko:resolve');
  assert.ok(res, 'the watchers get the resolution');
  assert.ok(res.p.reveal.length >= 1);
  for (const a of res.p.reveal) {
    assert.ok(!('owner' in a));
    assert.ok(a.side === 0 || a.side === 1);
  }
  assert.ok(res.p.reveal.some(a => a.side === 0 && a.ax === 137 && a.ay === -91), 'Owen\'s arrow, now that it is out');
  for (const s of toWatchers()) {
    assert.ok(!json(s.p).includes(A.id) && !json(s.p).includes(B.id), s.ev + ' named a socket');
  }

  /* And somebody arriving during the tape joins it, with the arrows. */
  const W3 = sock('watcher-3');
  lob.watch(W3, {});
  const mid = W3.last('ko:watching');
  assert.strictEqual(mid.state.state, 'resolving');
  assert.ok(mid.state.resolve && Array.isArray(mid.state.resolve.frames), 'the tape comes along');
  assert.ok(mid.state.resolve.reveal.every(a => a.side === 0 || a.side === 1));
});

test('a whole bot match, watched start to finish, never shows an id or an early arrow', () => {
  const { lob, roomSent } = rig();
  const A = sock('sockA-7f3c'), W = sock('watcher-1');
  const T0 = 2000000;
  lob.enqueue(A, 'Owen', null, 0, 0, T0);
  lob.tick(T0 + BOT_AFTER_MS + 1);
  const room = lob.roomOf(A.id);
  assert.ok(room && room.bot, 'Owen is against the bot');
  lob.watch(W, {});

  /* Owen aims at random every turn, so both sides commit. */
  let t = T0 + BOT_AFTER_MS + 1, aimedTurn = 0;
  for (let i = 0; i < 20000 && room.state !== 'over'; i++) {
    if (room.state === 'aiming' && aimedTurn !== room.turn) {
      aimedTurn = room.turn;
      room.submitAim(A.id, room.piecesOf(A.id).map(p => ({
        pieceId: p.id, ax: (Math.random() * 2 - 1) * KO.MAX_PULL, ay: (Math.random() * 2 - 1) * KO.MAX_PULL,
      })));
    }
    t += 200;
    lob.tick(t);
  }
  assert.strictEqual(room.state, 'over', 'the match finished');

  const sent = roomSent.filter(s => s.room === room.watchRoomName);
  assert.ok(sent.length > 3, 'the watcher was sent the match');
  const reveals = sent.filter(s => s.ev === 'ko:resolve');
  assert.ok(reveals.length >= 1, 'at least one turn was played out');
  assert.ok(reveals.some(s => s.p.reveal.some(a => a.side === 0)) && reveals.some(s => s.p.reveal.some(a => a.side === 1)),
    'both sides\' arrows were shown, by seat');
  for (const s of sent) {
    const j = json(s.p);
    assert.ok(!j.includes(A.id) && !j.includes('bot_'), s.ev + ' named a socket');
    if (s.ev !== 'ko:resolve') assert.ok(!/"ax"|"ay"/.test(j), s.ev + ' carried an aim');
  }
  const over = sent.find(s => s.ev === 'ko:over');
  assert.ok(over, 'the result reached the watcher');
  assert.ok(!('winnerId' in over.p));
  assert.ok(over.p.winnerSide === 0 || over.p.winnerSide === 1 || over.p.winnerSide === null);
  assert.strictEqual(lob.watchers.size, 0, 'and the watcher was let go with the room');
  assert.ok(!W.rooms.has(room.watchRoomName), 'out of the watcher room');
});

test('Next match steps through the running matches, and stays put when there is one', () => {
  const { lob } = rig();
  const rooms = [];
  for (let i = 0; i < 3; i++) {
    lob.enqueue(sock('a' + i), 'A' + i, null, 0, 0);
    lob.enqueue(sock('b' + i), 'B' + i, null, 0, 0);
    rooms.push(lob.roomOf('a' + i));
  }
  rooms[0].state = 'aiming'; rooms[0].turn = 2;
  rooms[1].state = 'aiming'; rooms[1].turn = 5;          // the furthest in
  rooms[2].state = 'aiming'; rooms[2].turn = 1;
  const W = sock('w');
  assert.strictEqual(lob.watch(W, {}).roomId, rooms[1].id, 'fresh: the one furthest in');
  assert.strictEqual(lob.watch(W, { after: rooms[0].id }).roomId, rooms[1].id, 'after the first: the second');
  assert.strictEqual(lob.watch(W, { after: rooms[1].id }).roomId, rooms[2].id);
  assert.strictEqual(lob.watch(W, { after: rooms[2].id }).roomId, rooms[0].id, 'and round to the start');
  assert.strictEqual(lob.watchers.size, 1, 'one entry per watcher, however often they move');
  assert.strictEqual(rooms.reduce((n, r) => n + r.watchers, 0), 1, 'counted on one room only');
  const m = W.last('ko:watching').match;
  assert.strictEqual(m.index, 1); assert.strictEqual(m.count, 3);

  /* A match about to show its result goes to the back. */
  rooms[1].state = 'settling';
  assert.strictEqual(lob.watch(W, {}).roomId, rooms[0].id, 'not the one already ending');

  /* One match left: Next keeps you on it. */
  rooms[0].state = 'over'; rooms[1].state = 'over';
  assert.strictEqual(lob.watch(W, { after: rooms[2].id }).roomId, rooms[2].id);
  /* The one being left has gone already: still the next one after it. */
  lob.rooms.delete(rooms[0].id);
  assert.strictEqual(lob.watch(W, { after: rooms[0].id }).roomId, rooms[2].id);
});

test('Previous steps back through the running matches, round to the end, and Next undoes it', () => {
  const { lob } = rig();
  const rooms = [];
  for (let i = 0; i < 3; i++) {
    lob.enqueue(sock('a' + i), 'A' + i, null, 0, 0);
    lob.enqueue(sock('b' + i), 'B' + i, null, 0, 0);
    rooms.push(lob.roomOf('a' + i));
  }
  for (const r of rooms) { r.state = 'aiming'; r.turn = 1; }
  const W = sock('w');
  const prev = (after) => lob.watch(W, { after, dir: 'prev' }).roomId;
  const next = (after) => lob.watch(W, { after }).roomId;
  assert.strictEqual(prev(rooms[2].id), rooms[1].id, 'the one made just before');
  assert.strictEqual(prev(rooms[1].id), rooms[0].id);
  assert.strictEqual(prev(rooms[0].id), rooms[2].id, 'and round to the end');
  assert.strictEqual(next(prev(rooms[1].id)), rooms[1].id, 'Next after Previous is where you were');
  assert.strictEqual(lob.watch(W, { after: rooms[2].id, dir: 'next' }).roomId, rooms[0].id, 'dir next is the old Next');
  assert.strictEqual(lob.watch(W, { after: rooms[2].id, dir: 'sideways' }).roomId, rooms[0].id, 'any other dir is Next');
  assert.strictEqual(lob.watch(W, { dir: 'prev' }).roomId, lob.watch(W, {}).roomId, 'no match to leave: the same fresh pick');
  assert.strictEqual(lob.watchers.size, 1, 'one entry per watcher, however often they move');
  assert.strictEqual(rooms.reduce((n, r) => n + r.watchers, 0), 1, 'counted on one room only');
  assert.strictEqual(W.last('ko:watching').match.count, 3);

  /* The one being left has ended already: still the one before it. */
  rooms[1].state = 'over';
  assert.strictEqual(prev(rooms[1].id), rooms[0].id);
  assert.strictEqual(prev(rooms[0].id), rooms[2].id);
  rooms[1].state = 'aiming';

  /* A match about to show its result goes to the back, going either way. */
  rooms[0].state = 'settling';
  assert.strictEqual(prev(rooms[2].id), rooms[1].id);
  assert.strictEqual(prev(rooms[1].id), rooms[2].id, 'the ending one is skipped');
  rooms[0].state = 'aiming';

  /* One match left: Previous keeps you on it. */
  rooms[0].state = 'over'; rooms[1].state = 'over';
  assert.strictEqual(prev(rooms[2].id), rooms[2].id);
  rooms[0].state = 'aiming'; rooms[1].state = 'aiming';

  /* Previous at a buy-in stays at that buy-in. */
  rooms[0].stake = 0.5; rooms[2].stake = 0.5;
  assert.strictEqual(lob.watch(W, { after: rooms[2].id, dir: 'prev', stake: 0.5 }).roomId, rooms[0].id, 'the other $0.50 table');
  assert.strictEqual(lob.watch(W, { after: rooms[0].id, dir: 'prev', stake: 0.5 }).roomId, rooms[2].id, 'round, skipping the Free one');
  assert.strictEqual(lob.watch(W, { after: rooms[1].id, dir: 'prev', stake: 0 }).roomId, rooms[1].id, 'the only Free table: it stays');
});

test('nothing running is said, and the end of a match lets its watchers gonothing running is said, and the end of a match lets its watchers go', () => {
  const { lob, roomSent } = rig();
  const W = sock('w');
  assert.strictEqual(lob.watch(W, {}).ok, false);
  assert.deepStrictEqual(W.last('ko:watching'), { none: true });
  assert.strictEqual(lob.watchers.size, 0);

  const A = sock('sockA-7f3c'), B = sock('sockB-91de');
  lob.enqueue(A, 'Owen', null, 0, 0);
  lob.enqueue(B, 'Nia', null, 0, 0);
  const room = lob.roomOf(A.id);
  lob.watch(W, {});
  lob.leave(A.id);                                     // Owen closes the tab
  const over = roomSent.find(s => s.room === room.watchRoomName && s.ev === 'ko:over');
  assert.ok(over, 'the watcher is told the result');
  assert.strictEqual(over.p.winnerSide, 1);
  assert.strictEqual(over.p.winner, 'Nia');
  assert.strictEqual(over.p.why, 'opponent left');
  assert.strictEqual(lob.watchers.size, 0, 'let go when the room went');
  assert.ok(!W.rooms.has(room.watchRoomName));

  /* A room that goes any other way is said too, on the next tick. */
  const C = sock('c'), D = sock('d');
  lob.enqueue(C, 'C', null, 0, 0); lob.enqueue(D, 'D', null, 0, 0);
  const r2 = lob.roomOf(C.id);
  lob.watch(W, {});
  lob.rooms.delete(r2.id);
  lob.tick();
  assert.deepStrictEqual(W.last('ko:ended'), { id: r2.id });
  assert.strictEqual(lob.watchers.size, 0);
});

test('watchers of a bot match follow the human when a person arrives', () => {
  const { lob } = rig();
  const A = sock('sockA-7f3c'), B = sock('sockB-91de'), W = sock('w');
  lob.enqueue(A, 'Owen', null, 0, 0);
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  const botRoom = lob.roomOf(A.id);
  assert.ok(botRoom && botRoom.bot);
  lob.watch(W, {});
  assert.strictEqual(W.last('ko:watching').match.id, botRoom.id);

  lob.enqueue(B, 'Nia', null, 0, 0);                  // rescueFromBot dissolves the bot match
  const room = lob.roomOf(A.id);
  assert.ok(room && !room.bot && room.id !== botRoom.id, 'a person-against-person match');
  const m = W.last('ko:watching');
  assert.strictEqual(m.match.id, room.id, 'the watcher was moved to it and told');
  assert.ok(m.match.names.includes('Owen') && m.match.names.includes('Nia'));
  assert.strictEqual(lob.watchers.get(W.id).roomId, room.id);
  assert.ok(W.rooms.has(room.watchRoomName) && !W.rooms.has(botRoom.watchRoomName));
  assert.strictEqual(room.watchers, 1);
  assert.ok(!room.players.has(W.id));
});

test('a queued or seated socket cannot watch, and a watcher who queues stops watching', () => {
  const { lob } = rig();
  const A = sock('a'), B = sock('b'), C = sock('c'), W = sock('w');
  lob.enqueue(A, 'Owen', null, 0, 0);
  lob.enqueue(B, 'Nia', null, 0, 0);
  lob.enqueue(C, 'Cy', null, 0, 0);                   // alone in the queue
  for (const s of [A, C]) {
    assert.strictEqual(lob.watch(s, {}).ok, false);
    assert.strictEqual(s.last('ko:watching').refused, true);
  }
  assert.strictEqual(lob.watchers.size, 0);
  assert.ok(lob.queue.some(e => e.socket.id === 'c'), 'the queued seat is untouched');
  assert.ok(lob.roomOf('a'), 'and so is the seated one');

  lob.watch(W, {});
  const ch = lob.watchers.get('w').channel;
  lob.enqueue(W, 'Wes', null, 0, 0);
  assert.ok(!lob.watchers.has('w'), 'queueing stopped the watching');
  assert.ok(!W.rooms.has(ch));
  assert.strictEqual(lob.roomOf('a').watchers, 0);
});

test('a match takes so many watchers, and the next goes to another match', () => {
  const { lob } = rig();
  lob.enqueue(sock('a'), 'A', null, 0, 0); lob.enqueue(sock('b'), 'B', null, 0, 0);
  const one = lob.roomOf('a');
  for (let i = 0; i < WATCH_CAP; i++) assert.strictEqual(lob.watch(sock('w' + i), {}).roomId, one.id);
  const extra = sock('extra');
  assert.strictEqual(lob.watch(extra, {}).ok, false);
  assert.deepStrictEqual(extra.last('ko:watching'), { full: true });

  lob.enqueue(sock('c'), 'C', null, 0, 0); lob.enqueue(sock('d'), 'D', null, 0, 0);
  const two = lob.roomOf('c');
  assert.strictEqual(lob.watch(extra, {}).roomId, two.id, 'room elsewhere');
});

test('hostile input to watching is ignored without throwing', () => {
  const { lob } = rig();
  lob.enqueue(sock('a'), 'A', null, 0, 0); lob.enqueue(sock('b'), 'B', null, 0, 0);
  const room = lob.roomOf('a');
  const W = sock('w');
  assert.doesNotThrow(() => {
    lob.watch(null); lob.watch(undefined, {}); lob.watch({}); lob.watch({ id: 5 });
    for (const after of [{ toString: 1 }, 5, ['ko_1'], null, true, '', 'x'.repeat(5000), '__proto__', 'constructor']) {
      const r = lob.watch(W, { after });
      assert.strictEqual(r.roomId, room.id, 'junk after is ignored: ' + String(typeof after));
    }
    lob.watch(W, null); lob.watch(W, 'x'); lob.watch(W, [1]);
    lob.unwatch(undefined); lob.unwatch(null); lob.unwatch({}); lob.unwatch('nobody');
  });
  assert.strictEqual(lob.watchers.size, 1);
  assert.strictEqual(room.watchers, 1, 'the count never drifted');
});

test('a watcher\'s disconnect clears them out', () => {
  const { lob } = rig();
  lob.enqueue(sock('a'), 'A', null, 0, 0); lob.enqueue(sock('b'), 'B', null, 0, 0);
  const room = lob.roomOf('a');
  const W = sock('w');
  lob.watch(W, {});
  lob.leave('w');                                     // the disconnect handler's first call
  assert.strictEqual(lob.unwatch('w'), false, 'and its second finds nothing left');
  assert.strictEqual(lob.watchers.size, 0);
  assert.strictEqual(room.watchers, 0);
  assert.strictEqual(room.state === 'over', false, 'the match carried on');
});

test('the money never sees a watcher', () => {
  const { lob, settled, refunds } = rig();
  const A = sock('a'), B = sock('b'), W = sock('w');
  lob.enqueue(A, 'Owen', 'WA', 1, 1);
  lob.enqueue(B, 'Nia', 'WB', 1, 1);
  const room = lob.roomOf('a');
  assert.strictEqual(room.pot(), 2);
  lob.watch(W, {});
  assert.strictEqual(room.pot(), 2, 'watching adds nothing to the pot');
  assert.strictEqual(lob.watch(W, {}).ok, true, 'a paid match can be watched');
  lob.leave('w');
  assert.strictEqual(refunds.length, 0, 'a watcher leaving is not a refund');
  lob.watch(sock('w2'), {});                          // and one still watching at the end
  lob.leave('a');
  assert.strictEqual(settled.length, 1);
  /* The seats at the moment it settled: Nia (Owen left, which is why it
     ended). Never a watcher. */
  const ids = settled[0].seats.map(s => s.id);
  assert.deepStrictEqual(ids, ['b']);
  assert.strictEqual(settled[0].pot, 2, 'the pot is the two stakes and nothing else');
  assert.strictEqual(refunds.length, 0);
});

test('the matches a watcher can step through are kept up to date', () => {
  const { lob, roomSent } = rig();
  lob.enqueue(sock('a'), 'A', null, 0, 0); lob.enqueue(sock('b'), 'B', null, 0, 0);
  const one = lob.roomOf('a');
  lob.watch(sock('w'), {});
  lob.tick();
  lob.enqueue(sock('c'), 'C', null, 0, 0); lob.enqueue(sock('d'), 'D', null, 0, 0);
  lob.tick();
  const told = roomSent.filter(s => s.room === one.watchRoomName && s.ev === 'ko:matches');
  assert.deepStrictEqual(told[told.length - 1].p, { index: 1, count: 2 }, 'a second match is on offer');
});

test('watching by stake (the lobby\'s Spectate on a buy-in): only tables at that stake, none when nothing runs there', () => {
  const { lob } = rig();
  const A = sock('sockA-1'), B = sock('sockB-1');
  lob.enqueue(A, 'Owen', null, 0, 0);
  lob.enqueue(B, 'Nia', null, 0, 0);
  const room = lob.roomOf(A.id);
  room.stake = 0.5; // stands for a paid table: watchers are sent the same public state whatever the stake
  const W = sock('w-half');
  assert.strictEqual(lob.watch(W, { stake: 0.5 }).roomId, room.id);
  const N = sock('w-one');
  assert.strictEqual(lob.watch(N, { stake: 1 }).ok, false);
  assert.deepStrictEqual(N.last('ko:watching'), { none: true });
  const F = sock('w-free');
  assert.strictEqual(lob.watch(F, { stake: 0 }).ok, false, 'Free shows Free tables only');
  const Any = sock('w-any');
  assert.strictEqual(lob.watch(Any, {}).roomId, room.id, 'no stake: every table, as before');
});
