'use strict';
/* BATTLESHIP: watching somebody else's match (the lobby's Spectate).

   This game is one secret, so a watcher is the most dangerous kind of
   spectator there is: a third screen that must learn where the ships are no
   sooner than the players do. The test that matters is the second one. It
   watches a whole match and checks, at the instant of every message a watcher
   is sent, that every square in it is a square somebody has already fired at:
   which means no ship that is still afloat can appear in it, by any field. */

const test = require('node:test');
const assert = require('node:assert');
const { BattleshipLobby, BOT_AFTER_MS, WATCH_CAP } = require('../server/BattleshipLobby');
const { BS } = require('../server/BattleshipRoom');
const { liveCounts } = require('../server/liveCounts');

function rig(onRoomEmit) {
  const roomSent = [];
  const io = {
    to: (room) => ({
      emit: (ev, p) => { roomSent.push({ room, ev, p }); if (onRoomEmit) onRoomEmit(room, ev, p); },
    }),
  };
  const lob = new BattleshipLobby(io);
  const settled = [], refunds = [];
  lob.onSettled = (m) => settled.push(m);
  lob.onRefund = (m) => refunds.push(m);
  return { lob, roomSent, settled, refunds };
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
const json = (p) => JSON.stringify(p);
const NEAT = [
  { key: 'carrier',    x: 0, y: 0, horiz: true },
  { key: 'battleship', x: 0, y: 1, horiz: true },
  { key: 'cruiser',    x: 0, y: 2, horiz: true },
  { key: 'submarine',  x: 0, y: 3, horiz: true },
  { key: 'destroyer',  x: 0, y: 4, horiz: true },
];

/* Every square a watcher payload names, per seat's board, against what has
   really been fired at that board right now. A fired square is public; any
   other square is a leak, whatever the field it turned up in. */
function assertOnlyFiredSquares(room, p, label) {
  const j = json(p);
  for (const k of ['myShips', 'shotsOnMe', 'myShots', 'sunkOfTheirs', '"you"', '"them"', 'yourTurn']) {
    assert.ok(!j.includes(k), label + ' carries a player field: ' + k);
  }
  for (const s of [0, 1]) {
    const seat = room.seats[s];
    if (!seat) continue;
    assert.ok(!j.includes(seat.id), label + ' names a socket');
    const board = room.boards.get(seat.id);
    const view = p.boards[s];
    for (const shot of view.shots) {
      assert.ok(board.shotsAt.has(shot.cell), label + ': seat ' + s + ' shot at an unfired square');
      assert.strictEqual(shot.hit, board.shotsAt.get(shot.cell) === 'hit');
    }
    for (const ship of view.sunk) {
      const real = board.ships.find(x => x.key === ship.key);
      assert.ok(real && real.sunk, label + ': a ship shown sunk that is afloat');
      for (const c of ship.cells) assert.ok(board.shotsAt.has(c), label + ': a sunk ship square never fired at');
    }
    /* And the other way round: no square of a ship still afloat that has not
       been hit appears in this seat's view at all. */
    const named = new Set(view.shots.map(x => x.cell));
    for (const sh of view.sunk) for (const c of sh.cells) named.add(c);
    for (const ship of board.ships) {
      if (ship.sunk) continue;
      for (const c of ship.cells) if (!board.shotsAt.has(c)) assert.ok(!named.has(c), label + ': an unhit ship square');
    }
  }
  if (p.lastShot) {
    assert.ok(p.lastShot.side === 0 || p.lastShot.side === 1);
    const target = room.boards.get(room.seats[1 - p.lastShot.side].id);
    assert.ok(target.shotsAt.has(p.lastShot.cell), label + ': the last shot is a fired square');
  }
}

test('watching takes no seat, no queue entry and no count, and is a room of its own', () => {
  const { lob } = rig();
  const A = sock('sockA-7f3c'), B = sock('sockB-91de'), W = sock('watcher-1');
  lob.enqueue(A, 'Owen', null, 0, 0);
  lob.enqueue(B, 'Nia', null, 0, 0);
  const room = lob.roomOf(A.id);
  const before = liveCounts({ battleship: lob }).battleship;
  assert.strictEqual(before, 2);
  assert.strictEqual(lob.watch(W, {}).ok, true);
  assert.strictEqual(lob.queue.length, 0);
  assert.ok(!room.players.has(W.id) && !room.boards.has(W.id) && !lob.bySocket.has(W.id));
  assert.strictEqual(liveCounts({ battleship: lob }).battleship, before, 'not counted');
  assert.ok(W.rooms.has('bsw_' + room.id) && !W.rooms.has(room.socketRoomName));

  const m = W.last('bs:watching');
  assert.deepStrictEqual(m.match.names, ['Owen', 'Nia']);
  assert.strictEqual(m.state.state, 'placing');
  assert.strictEqual(m.state.turn, null);
  assert.deepStrictEqual(m.state.players.map(p => p.side), [0, 1]);
  assertOnlyFiredSquares(room, m.state, 'bs:watching');

  /* The players still get their own views, and a watcher never gets one. */
  room.placeFleet(A.id, NEAT);
  assert.ok(A.last('bs:state').myShips.length === 5, 'a player still sees their own fleet');
  assert.ok(!W.sent.some(s => s.ev === 'bs:state'), 'the watcher is never sent a player view');
});

test('a whole bot match, watched start to finish: no ship afloat is ever shown, no id ever', () => {
  /* Checked at the instant of sending, against the boards as they are then.
     Kept as a list rather than thrown: the room's send is wrapped so that
     nothing can throw out of it, which would swallow the failure. */
  let room = null, checked = 0, overSeen = null;
  const leaks = [];
  const { lob, roomSent } = rig((channel, ev, p) => {
    if (!room || channel !== room.watchRoomName) return;
    if (ev === 'bs:state') {
      try { assertOnlyFiredSquares(room, p, ev + ' #' + checked); } catch (e) { leaks.push(e.message); }
      checked++;
    }
    if (ev === 'bs:over') overSeen = p;
  });
  const A = sock('sockA-7f3c'), W = sock('watcher-1');
  const T0 = 3000000;
  lob.enqueue(A, 'Owen', null, 0, 0);
  for (const e of lob.queue) e.since = T0;
  lob.tick(T0 + BOT_AFTER_MS + 1);
  room = lob.roomOf(A.id);
  assert.ok(room && room.bot, 'Owen is against the bot');
  lob.watch(W, {});
  assertOnlyFiredSquares(room, W.last('bs:watching').state, 'bs:watching');

  /* Owen places, then fires at random on every one of his turns. */
  room.placeFleet(A.id, NEAT);
  let t = T0 + BOT_AFTER_MS + 1;
  for (let i = 0; i < 20000 && room.state !== 'over'; i++) {
    if (room.state === 'playing' && room.turn === A.id) {
      const foe = room.boards.get(room.bot.id);
      const open = [];
      for (let c = 0; c < BS.CELLS; c++) if (!foe.shotsAt.has(c)) open.push(c);
      room.fire(A.id, open[Math.floor(Math.random() * open.length)], t);
    }
    t += 200;
    lob.tick(t);
  }
  assert.strictEqual(room.state, 'over', 'the match finished');
  assert.deepStrictEqual(leaks.slice(0, 3), [], 'a watcher was shown something it should not have been');
  assert.ok(checked > 30, 'every shot reached the watcher (' + checked + ' views checked)');

  /* Only the result carries whole fleets, and it carries both, by seat. */
  assert.ok(overSeen, 'the watcher got the result');
  assert.ok(!json(overSeen).includes(A.id) && !json(overSeen).includes('bot_'));
  assert.ok(overSeen.winnerSide === 0 || overSeen.winnerSide === 1);
  assert.deepStrictEqual(overSeen.reveal.map(r => r.side), [0, 1]);
  for (const r of overSeen.reveal) assert.strictEqual(r.ships.length, 5);
  for (const s of roomSent.filter(x => x.room === room.watchRoomName && x.ev !== 'bs:over')) {
    assert.ok(!('reveal' in s.p) && !json(s.p).includes('"ships"'), s.ev + ' carried a fleet before the end');
  }
  assert.strictEqual(lob.watchers.size, 0, 'let go with the room');
});

test('Next match steps through the running matches', () => {
  const { lob } = rig();
  const rooms = [];
  for (let i = 0; i < 3; i++) {
    lob.enqueue(sock('a' + i), 'A' + i, null, 0, 0);
    lob.enqueue(sock('b' + i), 'B' + i, null, 0, 0);
    rooms.push(lob.roomOf('a' + i));
  }
  rooms[2].state = 'playing'; rooms[2].shotLog = [{}, {}, {}];
  const W = sock('w');
  assert.strictEqual(lob.watch(W, {}).roomId, rooms[2].id, 'fresh: the one furthest in');
  assert.strictEqual(lob.watch(W, { after: rooms[2].id }).roomId, rooms[0].id, 'round to the start');
  assert.strictEqual(lob.watch(W, { after: rooms[0].id }).roomId, rooms[1].id);
  rooms[0].state = 'over'; rooms[2].state = 'over';
  assert.strictEqual(lob.watch(W, { after: rooms[1].id }).roomId, rooms[1].id, 'one left: it stays');
  assert.strictEqual(lob.watchers.size, 1);
});

test('the end of a match is said, and its watchers let go', () => {
  const { lob, roomSent } = rig();
  const A = sock('sockA-7f3c'), B = sock('sockB-91de'), W = sock('w');
  assert.strictEqual(lob.watch(W, {}).ok, false);
  assert.deepStrictEqual(W.last('bs:watching'), { none: true });
  lob.enqueue(A, 'Owen', null, 0, 0); lob.enqueue(B, 'Nia', null, 0, 0);
  const room = lob.roomOf(A.id);
  lob.watch(W, {});
  lob.leave(B.id);
  const over = roomSent.find(s => s.room === room.watchRoomName && s.ev === 'bs:over');
  assert.ok(over);
  assert.strictEqual(over.p.winnerSide, 0);
  assert.strictEqual(over.p.winner, 'Owen');
  assert.strictEqual(over.p.why, 'opponent left');
  assert.strictEqual(lob.watchers.size, 0);
  assert.ok(!W.rooms.has(room.watchRoomName));
});

test('watchers of a bot match follow the human when a person arrives', () => {
  const { lob } = rig();
  const A = sock('a'), B = sock('b'), W = sock('w');
  lob.enqueue(A, 'Owen', null, 0, 0);
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  const botRoom = lob.roomOf('a');
  assert.ok(botRoom && botRoom.bot && botRoom.state === 'placing');
  lob.watch(W, {});
  lob.enqueue(B, 'Nia', null, 0, 0);
  const room = lob.roomOf('a');
  assert.ok(room && !room.bot && room.id !== botRoom.id);
  assert.strictEqual(W.last('bs:watching').match.id, room.id, 'moved and told');
  assert.ok(W.rooms.has(room.watchRoomName) && !W.rooms.has(botRoom.watchRoomName));
  assert.strictEqual(room.watchers, 1);

  /* Gone any other way: said on the next tick. */
  lob.rooms.delete(room.id);
  lob.tick();
  assert.deepStrictEqual(W.last('bs:ended'), { id: room.id });
  assert.strictEqual(lob.watchers.size, 0);
});

test('a queued or seated socket cannot watch, and a watcher who queues stops watching', () => {
  const { lob } = rig();
  const A = sock('a'), B = sock('b'), C = sock('c'), W = sock('w');
  lob.enqueue(A, 'Owen', null, 0, 0); lob.enqueue(B, 'Nia', null, 0, 0); lob.enqueue(C, 'Cy', null, 0, 0);
  for (const s of [A, C]) {
    assert.strictEqual(lob.watch(s, {}).ok, false);
    assert.strictEqual(s.last('bs:watching').refused, true);
  }
  assert.strictEqual(lob.watchers.size, 0);
  lob.watch(W, {});
  lob.enqueue(W, 'Wes', null, 0, 0);
  assert.ok(!lob.watchers.has('w'));
  assert.strictEqual(lob.roomOf('a').watchers, 0);
});

test('the cap, hostile input, and a disconnect', () => {
  const { lob } = rig();
  lob.enqueue(sock('a'), 'A', null, 0, 0); lob.enqueue(sock('b'), 'B', null, 0, 0);
  const room = lob.roomOf('a');
  for (let i = 0; i < WATCH_CAP; i++) lob.watch(sock('w' + i), {});
  const extra = sock('extra');
  lob.watch(extra, {});
  assert.deepStrictEqual(extra.last('bs:watching'), { full: true });
  assert.strictEqual(room.watchers, WATCH_CAP);

  assert.doesNotThrow(() => {
    lob.watch(null); lob.watch({}); lob.watch(extra, null); lob.watch(extra, 'x');
    for (const after of [{ toString: 1 }, 7, [1], '', 'y'.repeat(5000), '__proto__']) lob.watch(extra, { after });
    lob.unwatch(undefined); lob.unwatch({});
  });
  lob.leave('w0');
  lob.unwatch('w1');
  assert.strictEqual(room.watchers, WATCH_CAP - 2);
  assert.strictEqual(lob.watchers.size, WATCH_CAP - 2);
});

test('the money never sees a watcher', () => {
  const { lob, settled, refunds } = rig();
  lob.enqueue(sock('a'), 'Owen', 'WA', 1, 1);
  lob.enqueue(sock('b'), 'Nia', 'WB', 1, 1);
  const room = lob.roomOf('a');
  lob.watch(sock('w'), {});
  assert.strictEqual(room.pot(), 2);
  lob.leave('a');
  assert.strictEqual(settled.length, 1);
  assert.deepStrictEqual(settled[0].seats.map(s => s.id), ['b']);
  assert.strictEqual(settled[0].pot, 2);
  lob.leave('w');
  assert.strictEqual(refunds.length, 0);
});
