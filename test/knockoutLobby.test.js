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
  /* One clock reading for the stamp and both ticks. Reading it again per line
     adds the gap between them to the elapsed wait, so "not straight away" was
     one scheduling hiccup away from being wrong. */
  const T0 = Date.now();
  lob.enqueue(sock('A'), 'Owen', null, 0, 0, T0);
  lob.tick(T0 + BOT_AFTER_MS - 1);
  assert.strictEqual(lob.rooms.size, 0, 'not straight away');
  lob.tick(T0 + BOT_AFTER_MS + 1);
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
  /* STEPPED, the way the real lobby runs it, rather than jumped.

     The bot's think timer is SET on the first aiming tick and only checked on a
     later one, so a single leap forward sets the deadline instead of passing
     it. This used to jump straight from the countdown to +6000 and still see
     the arrows, but only because the room's clock was stamped off the real
     Date.now while the ticks ran on a synthetic one: the room thought it was
     already fifteen seconds old the moment it was made, and blew through every
     phase in one step. With the room on the lobby's own clock that drift is
     gone, and the honest way to advance is the way the timer does it. */
  const T0 = Date.now();
  lob.enqueue(sock('A'), 'Owen', null, 0, 0, T0);
  let t = T0 + BOT_AFTER_MS + 1;
  lob.tick(t);
  const room = lob.roomOf('A');
  for (let i = 0; i < 60 && !(room.aims.get(room.bot.id) || []).length; i++) {
    t += 200;                       // KnockoutLobby.start() ticks at 200ms
    lob.tick(t);
  }
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

test('the bot plays the game rather than falling into the pit', () => {
  /* THE BUG THIS EXISTS FOR. The first bot chose its power purely from the
     distance to its target and never asked whether that shot would carry it
     past the rim behind them. Measured against an opponent that never moved, it
     threw away most of its own pieces and a player could win without aiming
     once. It was not an opponent, it was a thing falling over.

     An opponent that never moves is the only way to attribute a loss honestly:
     every piece the bot loses here is one it threw away, and every piece the
     duck loses is one the bot really knocked off. */
  const io2 = { to: () => ({ emit: () => {} }) };
  let botLost = 0, duckLost = 0, botWins = 0;
  const N = 60;

  for (let m = 0; m < N; m++) {
    const lob = new KnockoutLobby(io2);
    const room = lob.makeMatch([{ socket: sock('duck'), name: 'Duck', wallet: null }], true);
    const bot = room.bot.id;
    let t = Date.now(), steps = 0;
    /* Stop once the ring bottoms out: past that the arena is deciding it, not
       the play, and nothing either side does can be read from the result. */
    while (room.state !== 'over' && steps < 20000 && room.arenaR > KO.ARENA_R_MIN) {
      t += 100; steps++;
      lob.botAim(room, t);              // the duck never aims
      room.tick(t);
    }
    botLost += 2 - room.piecesOf(bot).length;
    duckLost += 2 - room.piecesOf('duck').length;
    if (room.state === 'over' && room.winner === bot) botWins++;
  }

  assert.ok(duckLost > botLost * 1.5,
    'it takes far more pieces than it loses (' + duckLost + ' taken vs ' + botLost + ' thrown away)');
  /* Loose on purpose. This count includes pieces the closing ring took, which
     are not mistakes, and sixty matches of a deliberately imprecise bot is a
     noisy sample. The ratio above is the real signal; this is only here to
     catch a return to the old behaviour, where it lost nearly everything. */
  assert.ok(botLost / (N * 2) < 0.6,
    'and it does not mostly kill itself (' + (botLost / (N * 2) * 100).toFixed(0) + '% of its own)');
  assert.ok(botWins > N * 0.4,
    'it beats an opponent who does nothing, which is the floor for calling it an opponent ('
    + botWins + '/' + N + ')');
});

test('two people waiting never get a bot each', () => {
  /* THE BUG OWEN HIT. He and a friend pressed Play together and both ended up
     against bots. pump() only ran when somebody joined the queue — which is
     exactly the moment the second of them had not arrived yet — so when the bot
     timer came round the loop handed one bot to each waiting seat instead of
     handing them each other. */
  const lob = new KnockoutLobby(io);
  const now = Date.now();
  /* Both already waiting, both past the bot timer, and the tick arrives. */
  lob.queue.push({ socket: sock('A'), name: 'Owen', wallet: null, since: now - BOT_AFTER_MS - 1, stake: 0, worth: 0 });
  lob.queue.push({ socket: sock('B'), name: 'Nia', wallet: null, since: now - BOT_AFTER_MS - 1, stake: 0, worth: 0 });
  lob.tick(now);

  assert.strictEqual(lob.rooms.size, 1, 'one room, not two');
  const room = lob.roomOf('A');
  assert.ok(room && room.players.has('B'), 'they are in it together');
  assert.ok(!room.bot, 'and no bot was invented for either of them');
});

test('a late arrival pulls the first out of a bot match', () => {
  /* With two people on the whole game, a friend twenty seconds behind you is
     the normal case, not the edge one. Two people beats two bots. */
  const lob = new KnockoutLobby(io);
  lob.enqueue(sock('A'), 'Owen', null, 0, 0);
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  const botRoom = lob.roomOf('A');
  assert.ok(botRoom && botRoom.bot, 'A is against a bot');

  lob.enqueue(sock('B'), 'Nia', null, 0, 0);
  const room = lob.roomOf('A');
  assert.ok(room, 'A is still in a match');
  assert.ok(!room.bot, 'but not against a bot any more');
  assert.ok(room.players.has('B'), 'they are together');
  assert.strictEqual(lob.rooms.size, 1, 'the bot room is gone, not orphaned');
  assert.strictEqual(lob.queue.length, 0, 'and nobody is left waiting');
});

test('a match already under way is not broken up', () => {
  /* Pulling somebody out of a position they have been working on, to hand them
     an opponent they did not ask for, is worse than the problem it solves. */
  const lob = new KnockoutLobby(io);
  lob.enqueue(sock('A'), 'Owen', null, 0, 0);
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  const botRoom = lob.roomOf('A');
  botRoom.state = 'aiming';
  botRoom.turn = 4;                       // four turns in

  lob.enqueue(sock('B'), 'Nia', null, 0, 0);
  assert.strictEqual(lob.roomOf('A'), botRoom, 'A is left alone');
  assert.ok(lob.queue.some(e => e.socket.id === 'B'), 'B waits for their own match');
});

test('a paid seat is never rescued into, and never rescues', () => {
  /* A paid table has no bot match to be pulled out of, and a free seat must not
     be dragged into a room with money on it. */
  const lob = new KnockoutLobby(io);
  lob.enqueue(sock('A'), 'Owen', 'W1', 1, 1);          // paid, waiting
  lob.enqueue(sock('B'), 'Nia', null, 0, 0);           // free, waiting
  assert.strictEqual(lob.rooms.size, 0, 'different rungs do not match');
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  const free = lob.roomOf('B');
  assert.ok(free && free.bot, 'the free seat got its bot');
  assert.ok(lob.queue.some(e => e.socket.id === 'A'), 'the paid seat is still waiting');
});
