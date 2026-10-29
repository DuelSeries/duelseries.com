'use strict';
// server/freeWins.js: a free duel won by a person is one row (game, name, wallet or null); a bot's win, a paid table
// and a draw never are (Owen 2026-10-28: the lobby's Live wins and the board show real results only).
const test = require('node:test');
const assert = require('node:assert');
const freeWins = require('../server/freeWins');

const W = 'AAAAbbbbccccddddeeeeffffgggghhhhiiiijjjjZZ11';
const room = (ev, players) => ({ ev, players: new Map(Object.entries(players)) });

test('only a person winning a free table is written; the game from the room, the wallet only when it is one', async () => {
  const sent = [];
  freeWins.setSink((sql, params) => { sent.push({ sql, params }); return Promise.resolve(); });
  const r = room('hs', { s1: { name: ' Owen ', wallet: W, socket: { _googleId: W } }, bot_hs_1: { name: 'Bot', wallet: null } });
  assert.strictEqual(freeWins.noteRoom(r, 's1', 0), true);
  assert.strictEqual(freeWins.noteRoom(r, 'bot_hs_1', 0), false, 'a bot\'s win never');
  assert.strictEqual(freeWins.noteRoom(r, 's1', 2), false, 'a paid table is the ledger\'s, never here');
  assert.strictEqual(freeWins.noteRoom(r, null, 0), false, 'a draw');
  assert.strictEqual(freeWins.noteRoom(room('bs', { g: { name: 'guest', wallet: 'not-a-wallet' } }), 'g', 0, 'battleship'), true);
  // a wallet the client only CLAIMED is never credited: anyone could name someone else's (Fable review)
  assert.strictEqual(freeWins.noteRoom(room('ko', { c: { name: 'claimer', wallet: W, socket: {} } }), 'c', 0), true);
  assert.strictEqual(freeWins.noteRoom(room('zz', { g: { name: 'x' } }), 'g', 0), false, 'an unknown game');
  assert.strictEqual(freeWins.noteRoom(room('ko', { g: { name: '  ' } }), 'g', 0), false, 'no name');
  await new Promise((r2) => setImmediate(r2));
  assert.deepStrictEqual(sent.map((s) => s.params), [['headsoccer', 'Owen', W], ['battleship', 'guest', null], ['knockout', 'claimer', null]]);
  assert.match(sent[0].sql, /^INSERT INTO free_wins \(game, name, wallet\)/);
  freeWins.setSink(null);
  assert.strictEqual(freeWins.noteRoom(r, 's1', 0), false, 'no database: nothing');
});

test('every duel room reports its free result through noteRoom, after the paid settle', () => {
  const fs = require('fs');
  for (const f of ['server/KnockoutRoom.js', 'server/BattleshipRoom.js', 'server/swim/SwimRoom.js']) {
    const s = fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8');
    assert.match(s, /freeWins\.noteRoom\(this, winnerId, pot/, f);
  }
});
