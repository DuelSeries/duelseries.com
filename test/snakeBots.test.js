'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const GameRoom = require('../server/GameRoom');
const C = require('../shared/constants');
const { botTarget } = require('../server/botPopulation');

/* ─── Keeping a free lobby populated ─────────────────────────────────────────
   Bots existed here long before this file did. What was missing was anything to
   keep them coming: they were added by hand from the owner console, they died,
   and nothing replaced them, so the room drained back to empty on its own.

   The room is built and then STOPPED, because start() runs a 60Hz interval and
   a test that leaves one running never lets the process exit. topUpBots is
   called directly instead, which is what the tick loop does once a second. */

const io = { to: () => ({ emit: () => {} }) };

function room(lobbyType) {
  const r = new GameRoom(io, lobbyType, 'na');
  r.stop();
  return r;
}

/* SETTLE THE ROOM, the way a second of real time would.

   topUpBots adds at most eight per call now, because the target moves across
   the day and the first call after a quiet night would otherwise drop sixty
   snakes into the arena in one tick. The tick loop calls it once a second, so a
   test that calls it once is testing one second of filling, not the outcome.

   Called until it stops changing, with a cap so a bug cannot hang the suite. */
function fill(r) {
  let last = -1;
  for (let i = 0; i < 60 && r.botCount !== last; i++) { last = r.botCount; r.topUpBots(); }
  return r.botCount;
}

/* What the room is aiming at RIGHT NOW. It is no longer a constant: it walks a
   daily curve between BOT_MIN and BOT_MAX, so the tests ask rather than assume.
   Read once per assertion — it moves by at most one a minute, and these run in
   milliseconds. */

/* A human in the room, alive, without needing a socket or the join path. */
let n = 0;
function addHuman(r, alive = true) {
  const id = 'human' + (++n);
  const bot = r.addBot();                 // borrow the spawn, then make it a person
  assert.ok(bot, 'the room would take a snake');
  r.snakes.delete(bot.id);
  bot.id = id;
  bot.isBot = false;
  bot.alive = alive;
  r.snakes.set(id, bot);
  r.players.set(id, { socket: { emit() {} } });
  return bot;
}

test('THE ONE RULE: a paid room gets no bots, and loses any it somehow has', () => {
  /* The guard that matters. House robots among people who have staked real
     money is the single thing most likely to end a real-money game. */
  const r = room('na_dollar');
  assert.equal(r.botsAllowed(), false);
  assert.equal(r.addBot(), null, 'refused outright');

  // Even one smuggled in directly is swept on the next pass.
  const smuggled = new (require('../server/Bot'))('sneaky', 0, 0);
  r.snakes.set('sneaky', smuggled);
  r.topUpBots();
  assert.equal(r.snakes.has('sneaky'), false, 'and taken straight back out');
  assert.equal(r.botCount, 0);
});

test('the free room fills itself to whatever the day is asking for', () => {
  const r = room('na_free');
  assert.equal(r.botsAllowed(), true);
  assert.equal(r.botCount, 0, 'empty to begin with');
  const want = botTarget();
  fill(r);
  assert.equal(r.botCount, want, 'filled to whatever the day is asking for');
});

test('the battle royale counts as free, which endsWith(\'free\') got wrong', () => {
  /* The specific bug this list exists to prevent: 'na_br' read as a paid room,
     so the battle royale silently refused every bot and could not be filled. */
  const r = room('na_br');
  assert.equal(r.botsAllowed(), true);
  fill(r);
  assert.ok(r.botCount > 0, 'the br takes bots');
});

test('a bot that dies is replaced, which is the whole point', () => {
  const r = room('na_free');
  fill(r);
  const before = r.botCount;

  // Kill half of them, the way the game would.
  const bots = [...r.snakes.values()].filter(s => s.isBot);
  for (let i = 0; i < 4; i++) bots[i].alive = false;
  assert.equal(r.botCount, before - 4, 'four fewer alive');

  fill(r);
  assert.equal(r.botCount, before, 'and back to the target');
  /* The dead ones are gone rather than piling up: a dead snake is kept around
     so the client can play the death out, but a dead BOT nobody is watching is
     just a leak in a room that runs for the life of the process. */
  assert.equal([...r.snakes.values()].filter(s => s.isBot && !s.alive).length, 0);
});

test('the target is the ROOM, so bots fill whatever people do not', () => {
  /* Twenty bodies in here, players and robots together. Five people means
     fifteen robots; twenty people means none. */
  const r = room('na_free');
  for (let i = 0; i < 5; i++) addHuman(r);
  const want = botTarget();
  fill(r);
  assert.equal(r.humanCount, 5);
  assert.equal(r.botCount, want - 5, 'the rest are robots');
  assert.equal(r.humanCount + r.botCount, want, 'the room holds what the day asked for');
});

test('a full room of people gets no bots at all', () => {
  /* The thing that must never happen: fifty real players and robots still
     arriving to join them. */
  const r = room('na_free');
  for (let i = 0; i < C.BOT_MAX + 30; i++) addHuman(r);
  fill(r);
  assert.equal(r.botCount, 0, 'nobody needs company in a full room');
  r.topUpBots();
  assert.equal(r.botCount, 0, 'and asking again does not add any');
});

test('being over the target is left alone, never corrected by deleting a snake', () => {
  /* A room that is too full is not a problem to be fixed: robots die on their
     own and are simply not replaced, so it drains back to people by itself.
     Deleting live ones to hold a number is a snake vanishing out from under
     whoever was chasing it. */
  const r = room('na_free');
  const want = botTarget();
  fill(r);
  const ids = [...r.snakes.values()].filter(s => s.isBot).map(s => s.id);
  assert.equal(ids.length, want);

  for (let i = 0; i < 12; i++) addHuman(r);      // a crowd turns up
  fill(r);
  assert.equal(r.botCount, want, 'every robot is still alive and still here');
  ids.forEach(id => assert.ok(r.snakes.has(id), 'including ' + id));

  /* And as they die they are not replaced, so it converges on its own. */
  const bots = [...r.snakes.values()].filter(s => s.isBot);
  for (let i = 0; i < 15; i++) bots[i].alive = false;
  fill(r);
  assert.equal(r.humanCount, 12);
  assert.equal(r.botCount, want - 12, 'down to what the room is short by');
});

test('the floor is measured against LIVE humans, not sockets in the room', () => {
  /* Somebody sitting on a death screen is not somebody to play against. A floor
     measured against player sockets would stop refilling exactly when a room
     had just been emptied out by a good player, which is when it matters. */
  const r = room('na_free');
  for (let i = 0; i < 5; i++) addHuman(r, false);      // five dead players
  const want = botTarget();
  fill(r);
  assert.equal(r.players.size, 5, 'five sockets in the room');
  assert.equal(r.humanCount, 0, 'and nobody actually playing');
  assert.equal(r.botCount, want, 'so it is filled as if empty');
});

test('a bot spawned by hand is not culled by the top-up', () => {
  /* `bots:add 20` has to mean twenty. A control that quietly undoes itself a
     second later is useless for the thing it exists for, which is testing. */
  const r = room('na_free');
  const want = botTarget();
  fill(r);
  const extra = [];
  for (let i = 0; i < 5; i++) {
    const b = r.addBot();
    b._manual = true;
    extra.push(b);
  }
  const swollen = r.botCount;
  assert.equal(swollen, want + 5);

  r.topUpBots();
  assert.equal(r.botCount, swollen, 'all still there');
  extra.forEach(b => assert.ok(r.snakes.has(b.id), 'including every hand-placed one'));
});

test('bots are snakes, so they look and move exactly like a player does', () => {
  /* Not a detail. Bot extends Snake, which means one movement model, one body,
     one renderer: there is no second implementation that could drift, and a bot
     cannot turn faster or move quicker than the person playing against it. */
  const Snake = require('../server/Snake');
  const r = room('na_free');
  const bot = r.addBot();
  assert.ok(bot instanceof Snake, 'a bot IS a snake');
  assert.equal(bot.update, Snake.prototype.update, 'the same movement, not a copy of it');

  const palette = new Set((C.SNAKE_COLORS || []).map(String));
  if (palette.size) {
    assert.ok(palette.has(String(bot.color)),
      'and a real skin colour: ' + bot.color);
  }
});

/* ── one population, shared across rooms ─────────────────────────────────────
   There is more than one free snake room: the fixed `na_free` tier, the
   ladder's free rung `na_s0`, and the battle royale's waiting room. The target
   was applied to each of them independently, so a target of 55 meant a hundred
   and sixty-five snakes simulated and shipped on one core — three times the
   number, and three times what was measured before it shipped.

   Owen's own console showed it: na_free 8, na_br 55, na_s0 55, agar 20. */

const { registerRoom, unregisterRoom } = require('../server/botPopulation');

function freeRooms(names) {
  return names.map(n => {
    const r = room(n);
    if (/_s\d/.test(n)) r.stake = 0;      // the ladder sets this on its rungs
    registerRoom(r);
    return r;
  });
}
function settleAll(rooms) {
  for (let i = 0; i < 80; i++) for (const r of rooms) r.topUpBots();
}

test('three free rooms share ONE population, they do not each take it', () => {
  const rooms = freeRooms(['na_free', 'na_br', 'na_s0']);
  try {
    const target = botTarget();
    settleAll(rooms);

    const total = rooms.reduce((a, r) => a + r.botCount, 0);
    assert.ok(total <= target + 2,
      'the whole game holds the target, not the target times three '
      + '(got ' + total + ' against a target of ' + target + ')');
    assert.ok(total >= target - 4, 'and it does actually fill (got ' + total + ')');

    /* Every room gets a share. The first version handed out global headroom
       first-come-first-served and the last room to tick got ZERO — which on the
       lobby board is a table advertised with nobody at it. */
    for (const r of rooms) {
      assert.ok(r.botCount > 0, r.lobbyType + ' is not left empty (' + r.botCount + ')');
    }
  } finally { rooms.forEach(unregisterRoom); }
});

test('clearing a room actually empties it, and it stays empty', () => {
  /* The console's Clear removed every bot and the once-a-second top-up put them
     straight back, so the button appeared to do nothing — four clears in two
     minutes in the ops log, each reporting success. */
  const rooms = freeRooms(['na_free']);
  try {
    settleAll(rooms);
    const r = rooms[0];
    assert.ok(r.botCount > 0, 'it filled first');

    for (const [id, s] of [...r.snakes]) if (s && s.isBot) r.snakes.delete(id);
    r._botsPausedUntil = Date.now() + 60000;          // what bots:clear sets

    for (let i = 0; i < 60; i++) r.topUpBots();
    assert.equal(r.botCount, 0, 'still empty a minute of top-ups later');

    /* And it heals: the pause is a window, not a switch, so a forgotten click
       cannot leave a room dead forever. */
    r._botsPausedUntil = Date.now() - 1;
    settleAll(rooms);
    assert.ok(r.botCount > 0, 'once the window passes it fills again');
  } finally { rooms.forEach(unregisterRoom); }
});

test('a paused room does not hold the others hostage', () => {
  /* The paused room still counts toward the shared population. If its share
     were reserved, clearing one room would starve the rest. */
  const rooms = freeRooms(['na_free', 'na_br']);
  try {
    rooms[0]._botsPausedUntil = Date.now() + 60000;
    settleAll(rooms);
    assert.equal(rooms[0].botCount, 0, 'the cleared one stays empty');
    assert.ok(rooms[1].botCount > 0, 'and the other one still fills');
  } finally { rooms.forEach(unregisterRoom); }
});
