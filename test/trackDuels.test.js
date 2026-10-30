'use strict';
/* PRODUCT ANALYTICS FOR THE DUELS: every duel lobby calls onMatchStart once when a match room is made and its seats
   are in it (index.js trackDuelLobby turns that into each paid seat's game_started). These pin who it names, that it
   says when the opponent is a bot, that it fires once per room, and that a lobby with nothing assigned (or a hook
   that throws) still plays the match and moves no money. Knockout, Battleship and Swim have their own makeMatch;
   Head Soccer, 8 Ball Pool, Air Hockey, Rooftop and Crossy share Knockout's. */

const test = require('node:test');
const assert = require('node:assert');
const { KnockoutLobby, FREE_WAIT_MS } = require('../server/KnockoutLobby');
const { BattleshipLobby } = require('../server/BattleshipLobby');
const { SwimLobby } = require('../server/swim/SwimLobby');
const { HeadSoccerLobby } = require('../server/HeadSoccerLobby');
const { Pool8Lobby } = require('../server/Pool8Lobby');
const { AirHockeyLobby } = require('../server/AirHockeyLobby');
const { RooftopLobby } = require('../server/RooftopLobby');
const { CrossyLobby } = require('../server/crossy/CrossyLobby');

const chan = { emit() {}, volatile: { emit() {} } };
chan.to = () => chan;
const io = { to: () => chan, in: () => chan };
function sock(id) { const sent = []; return { id, sent, join() {}, leave() {}, emit(e, p) { sent.push({ e, p }); } }; }

/* Battleship's enqueue has no clock argument; every other lobby's has the Knockout shape. */
const LOBBIES = [
  ['knockout', () => new KnockoutLobby(io)],
  ['battleship', () => new BattleshipLobby(io), true],
  ['swim', () => new SwimLobby(io)],
  ['headsoccer', () => new HeadSoccerLobby(io)],
  ['pool8', () => new Pool8Lobby(io)],
  ['airhockey', () => new AirHockeyLobby(io)],
  ['rooftop', () => new RooftopLobby(io)],
  ['crossy', () => new CrossyLobby(io)],
];
function queue(lob, noClock, s, name, wallet, stake, now) {
  return noClock ? lob.enqueue(s, name, wallet, stake, stake, stake || undefined)
                 : lob.enqueue(s, name, wallet, stake, stake, now, stake || undefined);
}
function recorder(lob) {
  const calls = [];
  lob.onMatchStart = (o) => calls.push(JSON.parse(JSON.stringify(o)));
  return calls;
}

for (const [game, make, noClock] of LOBBIES) {
  test(game + ': a paid pair starts one match, both seats named with their wallet and stake, no bot', () => {
    const lob = make();
    const calls = recorder(lob);
    const refunds = [];
    lob.onRefund = (o) => refunds.push(o);
    const T0 = Date.now();
    queue(lob, noClock, sock('A'), 'Owen', 'WALLET_A', 1, T0);
    assert.strictEqual(calls.length, 0, 'a queue is not a match');
    queue(lob, noClock, sock('B'), 'Nia', 'WALLET_B', 1, T0);
    const room = lob.roomOf('A');
    assert.ok(room && room.players.has('B'), 'seated together');
    assert.strictEqual(calls.length, 1, 'once');
    const c = calls[0];
    assert.strictEqual(c.roomId, room.id);
    assert.strictEqual(c.vsBot, false);
    const byId = new Map(c.seats.map(s => [s.id, s]));
    assert.deepStrictEqual(byId.get('A'), { id: 'A', wallet: 'WALLET_A', worth: 1 });
    assert.deepStrictEqual(byId.get('B'), { id: 'B', wallet: 'WALLET_B', worth: 1 });
    assert.strictEqual(c.seats.length, 2);
    // Ticking the running match never starts it again.
    lob.tick(T0 + 50);
    lob.tick(T0 + 100);
    assert.strictEqual(calls.length, 1, 'still once');
    assert.strictEqual(refunds.length, 0, 'no money moved');
  });

  test(game + ': a free seat alone gets a bot match, said to be against a bot', () => {
    const lob = make();
    const calls = recorder(lob);
    const T0 = Date.now();
    queue(lob, noClock, sock('A'), 'Owen', null, 0, T0);
    lob.tick(T0 + FREE_WAIT_MS + 1000);
    const room = lob.roomOf('A');
    assert.ok(room && room.bot, 'a bot match');
    assert.strictEqual(calls.length, 1, 'once');
    assert.strictEqual(calls[0].roomId, room.id);
    assert.strictEqual(calls[0].vsBot, true);
    const me = calls[0].seats.find(s => s.id === 'A');
    const bot = calls[0].seats.find(s => s.id !== 'A');
    assert.deepStrictEqual(me, { id: 'A', wallet: null, worth: 0 }, 'a free seat stakes nothing');
    assert.ok(bot && bot.wallet === null && bot.worth === 0, 'the bot has no wallet and stakes nothing');
  });

  test(game + ': without onMatchStart the match still starts', () => {
    const lob = make();
    const T0 = Date.now();
    queue(lob, noClock, sock('A'), 'Owen', 'WALLET_A', 1, T0);
    queue(lob, noClock, sock('B'), 'Nia', 'WALLET_B', 1, T0);
    const room = lob.roomOf('A');
    assert.ok(room && room.players.size === 2 && room.state !== 'waiting', 'started');
    assert.strictEqual(lob.queue.length, 0);
  });

  test(game + ': an onMatchStart that throws breaks nothing and refunds nothing', () => {
    const lob = make();
    const refunds = [];
    lob.onRefund = (o) => refunds.push(o);
    lob.onMatchStart = () => { throw new Error('analytics down'); };
    const T0 = Date.now();
    queue(lob, noClock, sock('A'), 'Owen', 'WALLET_A', 1, T0);
    queue(lob, noClock, sock('B'), 'Nia', 'WALLET_B', 1, T0);
    const room = lob.roomOf('A');
    assert.ok(room && room.players.size === 2 && room.state !== 'waiting', 'started');
    assert.strictEqual(lob.rooms.size, 1);
    assert.strictEqual(refunds.length, 0, 'the seats are held, not handed back');
    assert.ok(!room.settled, 'and the table can still settle');
  });
}

test('knockout: the wallets named at the start are the ones the settle pays', () => {
  const lob = new KnockoutLobby(io);
  const calls = recorder(lob);
  const settled = [];
  lob.onSettled = (o) => settled.push(o);
  const T0 = Date.now();
  queue(lob, false, sock('A'), 'Owen', 'WALLET_A', 1, T0);
  queue(lob, false, sock('B'), 'Nia', 'WALLET_B', 1, T0);
  lob.leave('A');
  assert.strictEqual(settled.length, 1);
  const startSeat = calls[0].seats.find(s => s.id === 'B');
  const settleSeat = settled[0].seats.find(s => s.id === 'B');
  assert.strictEqual(settled[0].roomId, calls[0].roomId);
  assert.strictEqual(settleSeat.wallet, startSeat.wallet);
  assert.strictEqual(settleSeat.worth, startSeat.worth);
  assert.match(settled[0].why, /forfeit|left|leave|disconnect|quit|abandon|resign/i, 'a walk-out reads as one');
});

test('knockout: a person pulled out of a young bot match starts a new match, each room once', () => {
  const lob = new KnockoutLobby(io);
  const calls = recorder(lob);
  const T0 = Date.now();
  queue(lob, false, sock('A'), 'Owen', null, 0, T0);
  lob.tick(T0 + FREE_WAIT_MS + 1000);
  const botRoom = lob.roomOf('A');
  assert.ok(botRoom && botRoom.bot);
  queue(lob, false, sock('B'), 'Nia', null, 0, T0 + FREE_WAIT_MS + 1500);
  const room = lob.roomOf('B');
  assert.ok(room && room !== botRoom && room.players.has('A'), 'the two people together');
  assert.strictEqual(calls.length, 2);
  assert.notStrictEqual(calls[0].roomId, calls[1].roomId);
  assert.strictEqual(calls[1].roomId, room.id);
  assert.strictEqual(calls[1].vsBot, false);
});

test('battleship and swim: the wallets named at the start are the ones the settle pays', () => {
  for (const [make, noClock] of [[() => new BattleshipLobby(io), true], [() => new SwimLobby(io), false]]) {
    const lob = make();
    const calls = recorder(lob);
    const settled = [];
    lob.onSettled = (o) => settled.push(o);
    const T0 = Date.now();
    queue(lob, noClock, sock('A'), 'Owen', 'WALLET_A', 1, T0);
    queue(lob, noClock, sock('B'), 'Nia', 'WALLET_B', 1, T0);
    lob.leave('A');
    assert.strictEqual(settled.length, 1);
    assert.strictEqual(settled[0].roomId, calls[0].roomId);
    const s = settled[0].seats.find(x => x.id === 'B');
    assert.strictEqual(s.wallet, 'WALLET_B');
    assert.strictEqual(s.worth, calls[0].seats.find(x => x.id === 'B').worth);
  }
});
