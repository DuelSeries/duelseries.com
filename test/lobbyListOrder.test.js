'use strict';
/* Open lobbies (Owen 2026-10-17): "bots count as people playing" and "if anyone is in the paid lobbies, they should
   come up first before the free lobbies". Runs the real public/js/v2/board.js against a stubbed /api/live. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/js/v2/board.js'), 'utf8');

async function board(lobbies) {
  const win = {};
  const ctx = vm.createContext({
    window: win, document: { getElementById: () => null }, console,
    fetch: async () => ({ ok: true, json: async () => ({ lobbies, extras: [], counts: {} }) }),
  });
  vm.runInContext(SRC, ctx);
  await win.V2Board.load();
  return win.V2Board.rowsToShow().map(r => r.id);
}

test('a paid room with only bots is listed, and paid rooms with anyone in them come first, biggest buy-in on top', async () => {
  const ids = await board([
    { id: 'sl:na:s0', game: 'snake', stake: 0, players: 3, bots: 20, state: 'open' },
    { id: 'paper:na:s0', game: 'paper', stake: 0, players: 0, bots: 6, state: 'open' },
    { id: 'sl:na:s0.5', game: 'snake', stake: 0.5, players: 0, bots: 4, state: 'open' },
    { id: 'sl:na:s1', game: 'snake', stake: 1, players: 1, bots: 0, state: 'open' },
    { id: 'paper:na:s1', game: 'paper', stake: 1, players: 0, bots: 0, state: 'open' },
  ]);
  assert.deepStrictEqual(ids.slice(0, 4), ['sl:na:s1', 'sl:na:s0.5', 'sl:na:s0', 'paper:na:s0']);
  assert.ok(!ids.includes('paper:na:s1'), 'an empty paid room stays off the list');
});

test('the free rooms follow the lobby order: Pac-Man, Slither.io, Agar.io, Paper.io (Owen 2026-10-27)', async () => {
  const ids = await board([
    { id: 'sl:na:s0', game: 'snake', stake: 0, players: 0, bots: 20, state: 'open' },
    { id: 'paper:na:s0', game: 'paper', stake: 0, players: 0, bots: 6, state: 'open' },
    { id: 'ag:na:s0', game: 'agar', stake: 0, players: 0, bots: 8, state: 'open' },
    { id: 'chomp:na:s0', game: 'chomp', stake: 0, players: 0, bots: 3, state: 'open' },
    { id: 'paper:na:s1', game: 'paper', stake: 1, players: 1, bots: 0, state: 'open' },
  ]);
  assert.deepStrictEqual(ids.slice(0, 5), ['paper:na:s1', 'chomp:na:s0', 'sl:na:s0', 'ag:na:s0', 'paper:na:s0'],
    'a paid room with someone in it still comes first');
});
