'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const GameRoom = require('../server/GameRoom');
const C = require('../shared/constants');

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

test('the free room fills itself to the floor', () => {
  const r = room('na_free');
  assert.equal(r.botsAllowed(), true);
  assert.equal(r.botCount, 0, 'empty to begin with');
  r.topUpBots();
  assert.equal(r.botCount, C.BOT_FLOOR_FREE, 'filled');
});

test('the battle royale counts as free, which endsWith(\'free\') got wrong', () => {
  /* The specific bug this list exists to prevent: 'na_br' read as a paid room,
     so the battle royale silently refused every bot and could not be filled. */
  const r = room('na_br');
  assert.equal(r.botsAllowed(), true);
  r.topUpBots();
  assert.ok(r.botCount > 0, 'the br takes bots');
});

test('a bot that dies is replaced, which is the whole point', () => {
  const r = room('na_free');
  r.topUpBots();
  const before = r.botCount;

  // Kill half of them, the way the game would.
  const bots = [...r.snakes.values()].filter(s => s.isBot);
  for (let i = 0; i < 4; i++) bots[i].alive = false;
  assert.equal(r.botCount, before - 4, 'four fewer alive');

  r.topUpBots();
  assert.equal(r.botCount, before, 'and back to the floor a second later');
  /* The dead ones are gone rather than piling up: a dead snake is kept around
     so the client can play the death out, but a dead BOT nobody is watching is
     just a leak in a room that runs for the life of the process. */
  assert.equal([...r.snakes.values()].filter(s => s.isBot && !s.alive).length, 0);
});

test('bots make way for people, so the room is as busy either way', () => {
  const r = room('na_free');
  r.topUpBots();
  assert.equal(r.botCount, C.BOT_FLOOR_FREE);

  for (let i = 0; i < 3; i++) addHuman(r);
  r.topUpBots();
  assert.equal(r.humanCount, 3);
  assert.equal(r.botCount, C.BOT_FLOOR_FREE - 3, 'three fewer robots');
  assert.equal(r.humanCount + r.botCount, C.BOT_FLOOR_FREE, 'same size room');
});

test('the floor is measured against LIVE humans, not sockets in the room', () => {
  /* Somebody sitting on a death screen is not somebody to play against. A floor
     measured against player sockets would stop refilling exactly when a room
     had just been emptied out by a good player, which is when it matters. */
  const r = room('na_free');
  for (let i = 0; i < 5; i++) addHuman(r, false);      // five dead players
  r.topUpBots();
  assert.equal(r.players.size, 5, 'five sockets in the room');
  assert.equal(r.humanCount, 0, 'and nobody actually playing');
  assert.equal(r.botCount, C.BOT_FLOOR_FREE, 'so it is filled as if empty');
});

test('a bot spawned by hand is not culled by the top-up', () => {
  /* `bots:add 20` has to mean twenty. A control that quietly undoes itself a
     second later is useless for the thing it exists for, which is testing. */
  const r = room('na_free');
  r.topUpBots();
  const extra = [];
  for (let i = 0; i < 5; i++) {
    const b = r.addBot();
    b._manual = true;
    extra.push(b);
  }
  const swollen = r.botCount;
  assert.equal(swollen, C.BOT_FLOOR_FREE + 5);

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
