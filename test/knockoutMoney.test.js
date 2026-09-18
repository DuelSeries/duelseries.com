'use strict';
/* KNOCKOUT, WITH REAL MONEY ON THE TABLE.

   Every test here is about a way a player could lose money they should have
   kept, or take money that was never paid in. The rules being held:

     · a paid table never seats a bot, because a bot cannot cover a stake
     · two seats are only matched when they paid the SAME rung
     · a table settles exactly once, however it ended
     · a draw refunds each seat its own stake, and takes no cut
     · walking out of a paid queue gives the stake back
     · a free table never triggers a payout at all

   The room and the lobby decide who is owed what; moving it is index.js's job,
   so these drive the hooks rather than the chain. */

const test = require('node:test');
const assert = require('node:assert');
const { KnockoutLobby, PAID_WAIT_MS, BOT_AFTER_MS } = require('../server/KnockoutLobby');
const { KnockoutRoom, KO } = require('../server/KnockoutRoom');

const io = { to: () => ({ emit: () => {} }) };
function sock(id) { const sent = []; return { id, sent, join() {}, emit(e, p) { sent.push({ e, p }); } }; }

function lobby() {
  const lob = new KnockoutLobby(io);
  const settled = [], refunds = [];
  lob.onSettled = (m) => settled.push(m);
  lob.onRefund = (m) => refunds.push(m);
  return { lob, settled, refunds };
}

test('a paid table is never given a bot', () => {
  /* The single most important line in the whole feature. A bot has no wallet
     and stakes nothing, so a paid match against one either mints money out of
     escrow or takes a real stake for a machine. */
  const { lob } = lobby();
  const s = sock('A');
  lob.enqueue(s, 'Owen', 'W1', 1, 1);
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  assert.strictEqual(lob.rooms.size, 0, 'no bot match was made');
  assert.ok(lob.queue.length === 1, 'it is still waiting for a person');
});

test('a free table still gets one, because there is nothing to lose', () => {
  const { lob } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 0, 0);
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  const room = lob.roomOf('A');
  assert.ok(room && room.bot, 'matched with a bot');
  assert.strictEqual(room.stake, 0);
  assert.strictEqual(room.pot(), 0, 'and there is no money on it');
});

test('even if something asks for one, a paid room refuses the bot', () => {
  /* Belt and braces. The rule above lives in tick(); this is the guard inside
     makeMatch, so a future caller cannot route around it. */
  const { lob } = lobby();
  const room = lob.makeMatch([{ socket: sock('A'), name: 'Owen', wallet: 'W1', stake: 1, worth: 1 }], true);
  assert.ok(!room.bot, 'no bot was seated on a paid table');
});

test('seats are matched by buy-in, not by who is next in line', () => {
  /* Two seats that paid different amounts have no honest way to split a pot. */
  const { lob } = lobby();
  lob.enqueue(sock('A'), 'A', 'W1', 1, 1);
  lob.enqueue(sock('B'), 'B', 'W2', 0.10, 0.10);
  assert.strictEqual(lob.rooms.size, 0, 'a dollar does not play a dime');

  lob.enqueue(sock('C'), 'C', 'W3', 1, 1);
  assert.strictEqual(lob.rooms.size, 1, 'but a dollar plays a dollar');
  const room = lob.roomOf('A');
  assert.ok(room.players.has('C'), 'matched with the one at the same rung');
  assert.strictEqual(room.pot(), 2, 'and the pot is both stakes');
  assert.ok(lob.queue.some(e => e.socket.id === 'B'), 'the dime seat is still waiting');
});

test('the winner is owed the pot, and it settles exactly once', () => {
  const { lob, settled } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 1, 1);
  lob.enqueue(sock('B'), 'Nia', 'W2', 1, 1);
  const room = lob.roomOf('A');

  room.finish('A', 'last one standing');
  room.finish('A', 'last one standing');      // a retry, a reconnect, a double event
  assert.strictEqual(settled.length, 1, 'settled once, not twice');
  assert.strictEqual(settled[0].pot, 2);
  assert.strictEqual(settled[0].winnerId, 'A');
  const seats = settled[0].seats;
  assert.strictEqual(seats.length, 2);
  assert.ok(seats.every(s => s.worth === 1), 'each seat records what it paid');
});

test('a draw hands each seat its own stake back', () => {
  /* Both sides going off on the same reveal is a real outcome of this game.
     Splitting a pot would be fine only while both seats paid the same, which is
     an assumption; and taking a cut off a match nobody won would be charging
     two people for nothing. */
  const { lob, settled } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 1, 1);
  lob.enqueue(sock('B'), 'Nia', 'W2', 1, 1);
  const room = lob.roomOf('A');

  room.finish(null, 'everyone went off');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, null, 'nobody won it');
  for (const s of settled[0].seats) {
    assert.strictEqual(s.worth, 1, s.name + ' is owed exactly what they put in');
  }
});

test('a free table never settles anything', () => {
  /* No pot, no hook, no payout code anywhere near it. */
  const { lob, settled } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 0, 0);
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  const room = lob.roomOf('A');
  room.finish('A', 'last one standing');
  assert.strictEqual(settled.length, 0, 'nothing to settle');
});

test('a paid seat that nobody joins gets its money back', () => {
  const { lob, refunds } = lobby();
  const s = sock('A');
  /* ONE CLOCK READING, passed in, used for both the stamp and the ticks.

     This read Date.now() again on each tick line. The gap between enqueue
     stamping `since` and the next line running is added to the elapsed wait, so
     under a loaded machine "one millisecond short of giving up" had already
     given up and the seat was refunded before the assertion. It failed exactly
     that way during a pre-deploy run, which is the worst possible moment for a
     test to be wrong about something it is not testing. */
  const T0 = Date.now();
  lob.enqueue(s, 'Owen', 'W1', 1, 1, T0);

  lob.tick(T0 + PAID_WAIT_MS - 1);
  assert.strictEqual(refunds.length, 0, 'not while it is still waiting');

  lob.tick(T0 + PAID_WAIT_MS + 1);
  assert.strictEqual(refunds.length, 1, 'refunded once the wait is up');
  assert.strictEqual(refunds[0].amount, 1);
  assert.strictEqual(refunds[0].wallet, 'W1');
  assert.strictEqual(lob.queue.length, 0, 'and the seat is given up');
  const told = s.sent.find(m => m.e === 'ko:unqueued');
  assert.ok(told && told.p.refunded, 'and the player is told it was refunded');
});

test('backing out of a paid queue is a refund, not just a dequeue', () => {
  /* The stake settled on-chain before they were ever standing in the queue. */
  const { lob, refunds } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 0.10, 0.10);
  lob.leave('A');
  assert.strictEqual(refunds.length, 1);
  assert.strictEqual(refunds[0].amount, 0.10);
});

test('a stake is only ever handed back once', () => {
  /* Leaving, then the wait expiring, then leaving again is three routes to the
     same money. */
  const { lob, refunds } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 1, 1);
  lob.leave('A');
  lob.leave('A');
  lob.tick(Date.now() + PAID_WAIT_MS + 1);
  assert.strictEqual(refunds.length, 1, 'exactly one refund');
});

test('leaving a paid MATCH hands the table to the other player', () => {
  /* Not a refund: the match started, and somebody quitting a game they are
     losing must not be a way to get a stake back. */
  const { lob, settled, refunds } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 1, 1);
  lob.enqueue(sock('B'), 'Nia', 'W2', 1, 1);
  const room = lob.roomOf('A');
  room.start(1000);

  lob.leave('B');
  assert.strictEqual(refunds.length, 0, 'quitting is not a refund');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, 'A', 'the player still there takes it');
  assert.strictEqual(settled[0].pot, 2);
});

test('the room never reports a pot bigger than what was staked into it', () => {
  /* The pot is the one number the payout multiplies against, so it is worth
     one test on its own that it is a sum of recorded stakes and nothing else. */
  const r = new KnockoutRoom(io, 'p1');
  r.addPlayer(sock('A'), 'Owen', 'W1', 1);
  r.addPlayer(sock('B'), 'Nia', 'W2', 1);
  assert.strictEqual(r.pot(), 2);

  /* Nothing a client sends can reach it. */
  r.stake = 999;
  assert.strictEqual(r.pot(), 2, 'the advertised rung is not the money');
});

test('what the clients are told about the money is the same on both screens', () => {
  const r = new KnockoutRoom(io, 'p2');
  r.stake = 1;
  r.addPlayer(sock('A'), 'Owen', 'W1', 1);
  r.addPlayer(sock('B'), 'Nia', 'W2', 1);
  const st = r.publicState();
  assert.strictEqual(st.stake, 1);
  assert.strictEqual(st.pot, 2);
  /* And never anybody's wallet. */
  assert.ok(!JSON.stringify(st).includes('W1'), 'no wallet address goes out');
});

test('every way out of a paid queue hands the money back', () => {
  /* There are three: the player presses back, the socket drops, and the wait
     runs out. The first of them used to call dequeue(), which only forgets the
     seat — the buy-in has already settled on-chain by then, so that was taking
     their money for a match that never happened. */
  for (const exit of ['leave', 'disconnect', 'timeout']) {
    const { lob, refunds } = lobby();
    lob.enqueue(sock('A'), 'Owen', 'W1', 1, 1);
    if (exit === 'timeout') lob.tick(Date.now() + PAID_WAIT_MS + 1);
    else lob.leave('A');                       // both the button and the drop route here
    assert.strictEqual(refunds.length, 1, 'refunded when they ' + exit);
    assert.strictEqual(refunds[0].amount, 1);
  }
});
