'use strict';
/* KNOCKOUT: getting two players onto a disc, and the opponent for when there is
   only one of you.

   The bot matters more here than in most places. This game has no players yet,
   so for now the bot IS the game: if it stalls, suicides, or cannot lose, then
   what Owen plays is not the thing that will eventually go live. */

const test = require('node:test');
const assert = require('node:assert');
const { KnockoutLobby, BOT_AFTER_MS } = require('../server/KnockoutLobby');
const { KO } = require('../server/KnockoutRoom');

const io = { to: () => ({ emit: () => {} }) };
function sock(id) { return { id, join() {}, emit() {}, rooms: new Set() }; }

test('two people waiting are matched with each other, not with bots', () => {
  const lob = new KnockoutLobby(io);
  lob.enqueue(sock('A'), 'Owen', null);
  lob.enqueue(sock('B'), 'Nia', null);
  assert.strictEqual(lob.queue.length, 0, 'the queue emptied');
  assert.strictEqual(lob.rooms.size, 1, 'into one room');
  const room = lob.roomOf('A');
  assert.ok(room && room.players.has('B'), 'together');
  assert.ok(!room.bot, 'and no bot was invented for them');
});

test('waiting alone gets you a bot rather than a spinner', () => {
  const lob = new KnockoutLobby(io);
  lob.enqueue(sock('A'), 'Owen', null);
  lob.tick(Date.now() + BOT_AFTER_MS - 1);
  assert.strictEqual(lob.rooms.size, 0, 'not straight away');
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  const room = lob.roomOf('A');
  assert.ok(room, 'matched');
  assert.ok(room.bot, 'with a bot');
  assert.strictEqual(room.players.size, 2);
});

test('the bot is named as one rather than passed off as a person', () => {
  /* You should know who you are playing. Quietly substituting a machine for an
     opponent on a game that will take money is the kind of thing that is very
     hard to explain afterwards. */
  const lob = new KnockoutLobby(io);
  lob.enqueue(sock('A'), 'Owen', null);
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  const room = lob.roomOf('A');
  const them = room.players.get(room.bot.id);
  assert.ok(them && them.name && them.name.length, 'it has a name on screen');
  assert.ok(String(room.bot.id).startsWith('bot_'), 'and it is a bot underneath');
});

test('the bot does not answer the instant the turn opens', () => {
  /* Committing before a person has finished reading the board is the one tell
     that would give it away every single turn. */
  const lob = new KnockoutLobby(io);
  lob.enqueue(sock('A'), 'Owen', null);
  let t = Date.now() + BOT_AFTER_MS + 1;
  lob.tick(t);
  const room = lob.roomOf('A');
  t += KO.COUNTDOWN_MS + 10;
  lob.tick(t);
  assert.strictEqual(room.state, 'aiming');
  lob.tick(t + 50);
  assert.strictEqual(room.ready.size, 0, 'it is still thinking');
  lob.tick(t + 6000);
  assert.ok(room.ready.has(room.bot.id), 'and it commits within a few seconds');
});

test('the bot actually moves its pieces', () => {
  const lob = new KnockoutLobby(io);
  lob.enqueue(sock('A'), 'Owen', null);
  let t = Date.now() + BOT_AFTER_MS + 1;
  lob.tick(t);
  const room = lob.roomOf('A');
  t += KO.COUNTDOWN_MS + 10;
  lob.tick(t);
  lob.tick(t + 6000);
  const aims = room.aims.get(room.bot.id) || [];
  assert.strictEqual(aims.length, KO.PIECES_EACH, 'an arrow on each of its pieces');
  for (const a of aims) assert.ok(Math.hypot(a.ax, a.ay) > 1, 'a real one');
});

test('a bot match plays itself out and ends, every time', () => {
  /* Driven through the real clock. The failure this is guarding against is a
     match that never resolves: two bots that both sit still, or a turn loop
     that never reaches an end state, would leave a player stuck on a board
     forever with no way to tell whether it is their move. */
  const results = [];
  for (let i = 0; i < 30; i++) results.push(playOut());
  assert.strictEqual(results.filter(r => r.over).length, 30, 'all thirty finished');

  const turns = results.map(r => r.turns);
  const avg = turns.reduce((a, b) => a + b, 0) / turns.length;
  assert.ok(avg >= 2 && avg <= 9,
    'a match is a handful of turns, not one and not forty (avg ' + avg.toFixed(1) + ')');
});

test('neither seat has the better half of the board', () => {
  /* The opening is symmetrical and has to stay that way. This game is meant to
     take a buy-in eventually, and a side that wins 70% of the time because of
     where it starts is a rigged table however good the physics is. */
  const wins = { A: 0, bot: 0, draw: 0 };
  for (let i = 0; i < 120; i++) {
    const r = playOut();
    if (!r.winner) wins.draw++;
    else if (r.winner === 'A') wins.A++;
    else wins.bot++;
  }
  const decided = wins.A + wins.bot;
  const share = wins.A / decided;
  assert.ok(share > 0.35 && share < 0.65,
    'neither seat runs away with it (seat A took ' + (share * 100).toFixed(0) + '% of ' + decided + ')');
});

test('a finished room is cleared away', () => {
  /* Otherwise the map grows for the life of the process, and a player who
     finishes a match is still pointed at the old room and can never be matched
     into a new one. */
  const lob = new KnockoutLobby(io);
  lob.enqueue(sock('A'), 'Owen', null);
  let t = Date.now() + BOT_AFTER_MS + 1;
  lob.tick(t);
  const room = lob.roomOf('A');
  assert.ok(room);

  room.finish('A', 'last one standing');
  lob.tick(t + 1);
  assert.strictEqual(lob.rooms.size, 0, 'the room is gone');
  assert.strictEqual(lob.roomOf('A'), null, 'and the seat with it');
});

test('leaving mid-match frees you to queue again', () => {
  const lob = new KnockoutLobby(io);
  lob.enqueue(sock('A'), 'Owen', null);
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  assert.ok(lob.roomOf('A'));
  lob.leave('A');
  assert.strictEqual(lob.roomOf('A'), null);
  assert.strictEqual(lob.rooms.size, 0, 'a room with nobody human in it goes too');
});

/* Two bot brains, one on each seat, run through the real room clock. */
function playOut() {
  const lob = new KnockoutLobby(io);
  const room = lob.makeMatch([{ socket: sock('A'), name: 'Owen', wallet: null }], true);
  /* A second brain wearing the human's seat, so both sides really play. */
  const stand = {
    bot: { id: 'A', aimedTurn: 0 },
    get state() { return room.state; },
    get turn() { return room.turn; },
    get arenaR() { return room.arenaR; },
    opponentOf: (id) => room.opponentOf(id),
    piecesOf: (id) => room.piecesOf(id),
    submitAim: (id, a) => room.submitAim(id, a),
    lockIn: (id) => room.lockIn(id),
  };

  let t = Date.now(), steps = 0;
  while (room.state !== 'over' && steps < 20000) {
    t += 100; steps++;
    lob.botAim(room, t);
    lob.botAim(stand, t);
    room.tick(t);
  }
  return { over: room.state === 'over', winner: room.winner, turns: room.turn };
}
