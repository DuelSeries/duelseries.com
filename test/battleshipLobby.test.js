'use strict';
/* BATTLESHIP: getting two fleets onto the water, the opponent, and the money.

   The money rules are the same ones Knockout plays by, deliberately: a paid
   table works the same way in every game on this product or it does not work at
   all. They are tested again here rather than assumed, because "it is the same
   code" is a thing that stops being true quietly. */

const test = require('node:test');
const assert = require('node:assert');
const L = require('../server/BattleshipLobby');
const { BattleshipLobby, BOT_AFTER_MS, BOT_AFTER_MIN_MS, PAID_WAIT_MS, cellAt } = L;
const { isBotName } = require('../server/botNames');
const { BS } = require('../server/BattleshipRoom');

const io = { to: () => ({ emit: () => {} }) };
function sock(id) { const sent = []; return { id, sent, join() {}, emit(e, p) { sent.push({ e, p }); } }; }

function lobby() {
  const lob = new BattleshipLobby(io);
  const settled = [], refunds = [];
  lob.onSettled = (m) => settled.push(m);
  lob.onRefund = (m) => refunds.push(m);
  return { lob, settled, refunds };
}

/* ── matchmaking ────────────────────────────────────────────────────────── */

test('two people at the same buy-in are matched with each other', () => {
  const { lob } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 0, 0);
  lob.enqueue(sock('B'), 'Nia', 'W2', 0, 0);
  assert.strictEqual(lob.rooms.size, 1);
  assert.ok(!lob.roomOf('A').bot, 'and no bot was invented for them');
});

test('waiting alone on a FREE table gets a bot', () => {
  const { lob } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 0, 0);
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  const room = lob.roomOf('A');
  assert.ok(room && room.bot, 'matched with a bot');
  assert.ok(room.players.get(room.bot.id).name, 'which has a name on screen');
});

test('a PAID table is never given a bot', () => {
  /* A bot has no wallet and stakes nothing. A paid match against one either
     pays out of an escrow nobody paid into, or takes a real buy-in for a
     machine. */
  const { lob } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 1, 1);
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  assert.strictEqual(lob.rooms.size, 0, 'still waiting for a person');

  /* And not even if something asks directly. */
  const room = lob.makeMatch([{ socket: sock('Z'), name: 'Z', wallet: 'W9', stake: 1, worth: 1 }], true);
  assert.ok(!room.bot, 'makeMatch refuses it too');
});

test('seats are matched by rung, not by who is next in line', () => {
  const { lob } = lobby();
  lob.enqueue(sock('A'), 'A', 'W1', 1, 1);
  lob.enqueue(sock('B'), 'B', 'W2', 0.50, 0.50);
  assert.strictEqual(lob.rooms.size, 0, 'a dollar does not play fifty cents');
  lob.enqueue(sock('C'), 'C', 'W3', 1, 1);
  assert.strictEqual(lob.rooms.size, 1);
  assert.ok(lob.roomOf('A').players.has('C'));
  assert.strictEqual(lob.roomOf('A').pot(), 2);
});

/* ── money ──────────────────────────────────────────────────────────────── */

test('the winner is owed the pot, and a table settles exactly once', () => {
  const { lob, settled } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 1, 1);
  lob.enqueue(sock('B'), 'Nia', 'W2', 1, 1);
  const room = lob.roomOf('A');
  room.finish('A', 'fleet sunk');
  room.finish('A', 'fleet sunk');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].pot, 2);
  assert.strictEqual(settled[0].winnerId, 'A');
});

test('a free table never settles anything', () => {
  const { lob, settled } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 0, 0);
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  lob.roomOf('A').finish('A', 'fleet sunk');
  assert.strictEqual(settled.length, 0);
});

test('every way out of a paid queue hands the money back', () => {
  for (const exit of ['back button', 'timeout']) {
    const { lob, refunds } = lobby();
    const s = sock('A');
    lob.enqueue(s, 'Owen', 'W1', 1, 1);
    if (exit === 'timeout') lob.tick(Date.now() + PAID_WAIT_MS + 1);
    else lob.leave('A');
    assert.strictEqual(refunds.length, 1, 'refunded on ' + exit);
    assert.strictEqual(refunds[0].amount, 1);
    const told = s.sent.find(m => m.e === 'bs:unqueued');
    assert.ok(told && told.p.refunded, 'and they are told');
  }
});

test('a stake is only ever handed back once', () => {
  const { lob, refunds } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 1, 1);
  lob.leave('A');
  lob.leave('A');
  lob.tick(Date.now() + PAID_WAIT_MS + 1);
  assert.strictEqual(refunds.length, 1);
});

test('quitting a paid MATCH is not a refund', () => {
  /* Losing and closing the tab must not be a way to get a buy-in back. */
  const { lob, settled, refunds } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 1, 1);
  lob.enqueue(sock('B'), 'Nia', 'W2', 1, 1);
  lob.leave('B');
  assert.strictEqual(refunds.length, 0);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, 'A');
});

/* ── the opponent ───────────────────────────────────────────────────────── */

test('the bot lays a legal fleet, and not the instant the match opens: a drawn 3 to 12 seconds', () => {
  const took = [];
  for (let i = 0; i < 40; i++) {
    const { lob } = lobby();
    lob.enqueue(sock('A'), 'Owen', 'W1', 0, 0);
    const t0 = Date.now() + BOT_AFTER_MS + 1;
    lob.tick(t0);
    const room = lob.roomOf('A');
    const board = room.boards.get(room.bot.id);
    assert.strictEqual(board.placed, false, 'it is still thinking about it');
    let t = t0;
    while (!board.placed && t < t0 + 30000) { t += 200; lob.tick(t); }
    assert.strictEqual(board.placed, true);
    assert.strictEqual(board.cellsUsed().size, 17, 'a legal fleet');
    took.push(t - t0);
  }
  assert.ok(Math.min(...took) >= L.BOT_PLACE_MIN_MS && Math.max(...took) <= L.BOT_PLACE_MAX_MS + 400, took.join(','));
  assert.ok(new Set(took).size > 10, 'drawn, not fixed');
});

test('once your fleet is down, the bot is never the thing keeping you waiting for long', () => {
  for (let i = 0; i < 40; i++) {
    const { lob } = lobby();
    lob.enqueue(sock('A'), 'Owen', 'W1', 0, 0);
    const t0 = Date.now() + BOT_AFTER_MS + 1;
    lob.tick(t0);
    const room = lob.roomOf('A');
    room.boards.get('A').placeRandom(); // the person is quick: the Random button
    let t = t0;
    while (room.state === 'placing' && t < t0 + 30000) { t += 200; lob.tick(t); }
    assert.ok(t - t0 <= 5400, 'the match moved on after ' + (t - t0) + ' ms');
  }
});

test('the bot looks like a player: a person kind of name, never yours, a wait that is never the same twice', () => {
  const names = new Set();
  const waits = [];
  for (let i = 0; i < 200; i++) {
    const { lob } = lobby();
    const T0 = Date.now();
    lob.enqueue(sock('A'), 'jake', 'W1', 0, 0);
    let t = T0;
    while (!lob.roomOf('A') && t < T0 + 60000) { t += 200; lob.tick(t); }
    waits.push(t - T0);
    const room = lob.roomOf('A');
    const n = room.players.get(room.bot.id).name;
    assert.ok(isBotName(n, 15) && !/bot/i.test(n), n);
    assert.notStrictEqual(n.toLowerCase(), 'jake');
    names.add(n);
    assert.ok(String(room.bot.id).startsWith('bot_'), 'still a bot underneath');
  }
  assert.ok(names.size > 100, 'not the same few names: ' + names.size);
  assert.ok(Math.min(...waits) >= BOT_AFTER_MIN_MS - 50 && Math.max(...waits) <= BOT_AFTER_MS + 250, waits.join(','));
  assert.ok(new Set(waits).size > 30, 'drawn, not fixed');
});

test('the bot takes a drawn second or two a shot (longer after a sink), and its id never reaches a client', () => {
  const lob = new BattleshipLobby(io);
  const A = sock('H');
  const room = lob.makeMatch([{ socket: A, name: 'Owen', stake: 0, worth: 0 }], true);
  room.boards.get('H').placeRandom();
  room.boards.get(room.bot.id).placeRandom();
  room.state = 'playing';
  const gaps = [];
  let t = 0;
  for (let i = 0; i < 400 && !room.boards.get('H').allSunk(); i++) {
    room.turn = room.bot.id;
    const start = t;
    const before = room.boards.get('H').shotsAt.size;
    while (room.boards.get('H').shotsAt.size === before && t - start < 9000) { lob.botTurn(room, t); t += 50; }
    gaps.push(t - start);
    room.phaseEndsAt = Infinity;
  }
  assert.ok(Math.min(...gaps) >= L.BOT_THINK_MIN_MS, 'never instant: ' + Math.min(...gaps));
  assert.ok(Math.max(...gaps) <= L.BOT_THINK_MAX_MS + L.BOT_AFTER_SINK_MS + 100, 'well inside the shot clock: ' + Math.max(...gaps));
  assert.ok(new Set(gaps).size > 10, 'drawn, not 1100 every time');
  // what the person was sent: the bot's shots, the result and both fleets, never its 'bot_' id
  room.finish(room.bot.id, 'fleet sunk');
  const json = JSON.stringify(A.sent);
  assert.ok(A.sent.some(m => m.e === 'bs:state' && m.p.lastShot), 'shots were sent');
  assert.ok(!json.includes('bot_'), 'the bot id reached the client');
  const over = A.sent.find(m => m.e === 'bs:over');
  assert.strictEqual(over.p.won, false);
  assert.ok(over.p.reveal.some(r => r.id === 'H'), 'the page still finds its own fleet by its socket id');
  const alias = over.p.reveal.find(r => r.id !== 'H').id;
  assert.ok(/^[A-Za-z0-9_-]{20}$/.test(alias), alias);
  const shots = A.sent.filter(m => m.e === 'bs:state' && m.p.lastShot).map(m => m.p.lastShot.by);
  assert.ok(shots.every(by => by === alias), 'one neutral id for its shots all match long');
});

test('the bot finishes a fleet far faster than random fire', () => {
  /* The only unit that means anything: shots to clear a board. Firing blind
     averages about 95 of the 100 squares. Hunting on parity and then working
     along the line of hits lands in the fifties. A full probability solver gets
     to the low forties and is unbeatable, which is not what this is for. */
  const lob = new BattleshipLobby(io);
  const runs = [];
  for (let i = 0; i < 40; i++) {
    const room = lob.makeMatch([{ socket: sock('H'), name: 'Owen', stake: 0, worth: 0 }], true);
    room.boards.get('H').placeRandom();
    room.boards.get(room.bot.id).placeRandom();
    room.state = 'playing';
    let fired = 0, t = 0;
    while (!room.boards.get('H').allSunk() && fired < 250) {
      t += 5000;
      room.turn = room.bot.id;
      const before = room.boards.get('H').shotsAt.size;
      lob.botTurn(room, t); lob.botTurn(room, t);
      if (room.boards.get('H').shotsAt.size > before) fired++;
    }
    runs.push(fired);
  }
  const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
  assert.ok(avg < 75, 'its targeting actually works (averaged ' + avg.toFixed(1) + ' shots)');
  assert.ok(avg > 45, 'and it is not a solver nobody can beat (' + avg.toFixed(1) + ')');
  assert.ok(Math.max(...runs) < 250, 'it always finishes');
});

test('the bot never fires off the edge of the board', () => {
  /* cellAt returns null for a square past the edge, and a wounded ship against
     a wall produces exactly that. A null reaching the shot handler is a wasted
     turn, silently. */
  assert.strictEqual(cellAt(-1, 3), null, 'left of A');
  assert.strictEqual(cellAt(10, 3), null, 'right of J');
  assert.strictEqual(cellAt(3, -1), null, 'above row 1');
  assert.strictEqual(cellAt(3, 10), null, 'below row 10');
  assert.strictEqual(cellAt(0, 0), 0);
  assert.strictEqual(cellAt(9, 9), 99);

  const lob = new BattleshipLobby(io);
  const room = lob.makeMatch([{ socket: sock('H'), name: 'Owen', stake: 0, worth: 0 }], true);
  room.boards.get('H').placeRandom();
  room.boards.get(room.bot.id).placeRandom();
  room.state = 'playing';
  let t = 0;
  for (let i = 0; i < 200 && !room.boards.get('H').allSunk(); i++) {
    t += 5000; room.turn = room.bot.id;
    lob.botTurn(room, t); lob.botTurn(room, t);
  }
  for (const c of room.boards.get('H').shotsAt.keys()) {
    assert.ok(Number.isInteger(c) && c >= 0 && c < BS.CELLS, 'every shot landed on the grid: ' + c);
  }
});

test('a finished room is cleared away', () => {
  const { lob } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 0, 0);
  lob.tick(Date.now() + BOT_AFTER_MS + 1);
  const room = lob.roomOf('A');
  room.finish('A', 'fleet sunk');
  lob.tick(Date.now() + BOT_AFTER_MS + 2);
  assert.strictEqual(lob.rooms.size, 0);
  assert.strictEqual(lob.roomOf('A'), null);
});
