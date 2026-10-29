'use strict';
/* Security review 2026-10-15 (finder-2 #4, refute-core #4): the old snake engine's reconnect
   dropped the payout wallet.

   index.js sets socket._walletAddress (and _googleId) from the consumed entry token, and a
   reconnect is a NEW socket that consumed no token: PLAY with a held reconnectKey reattaches the
   snake and returns before any token is read. GameRoom.reattach moved the snake onto the new
   socket without those fields, so a cash-out on it zeroed the worth, swept the 10% rake and paid
   the 90% to nobody (doCashout pays only `if (socket._walletAddress)`). Now reattach carries both
   over from the old socket, exactly as they were. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const GameRoom = require('../server/GameRoom');

const io = { to: () => ({ emit: () => {} }), emit: () => {} };
function sock(id, extra = {}) {
  return Object.assign({ id, emit() {}, join() {}, leave() {}, rooms: new Set(), volatile: { emit() {} } }, extra);
}
function room() {
  const r = new GameRoom(io, 'dollar');
  r.broadcastSnapshot = () => {};
  r.topUpBots = () => {};
  return r;
}

test('a reconnected paid snake keeps the wallet that paid for it, and its identity', () => {
  const r = room();
  const old = sock('old-socket', { _walletAddress: 'PayerWallet1111', _googleId: 'PayerWallet1111' });
  const snake = r.addPlayer(old, 'P', 'PayerWallet1111', null, 1);
  r.markOrphan('old-socket', 'key-1', 60_000, () => {});
  // The new socket arrives with nothing, or with a client-claimed id that must not win.
  const fresh = sock('new-socket', { _googleId: 'SomeoneElse' });
  assert.strictEqual(r.reattach('key-1', fresh), snake);
  assert.strictEqual(fresh._walletAddress, 'PayerWallet1111', 'the cash-out target survives the reconnect');
  assert.strictEqual(fresh._googleId, 'PayerWallet1111');
  assert.strictEqual(r.players.get('new-socket').socket, fresh);
  assert.strictEqual(r.snakes.get('new-socket').worth, 1);
  clearTimeout(r.orphans.get('key-1') && r.orphans.get('key-1').timer);
});

test('a free snake stays without a payout wallet, whatever the new socket carried', () => {
  const r = room();
  const old = sock('a', { _googleId: 'FreeGuy' });
  r.addPlayer(old, 'F', null, null, 0);
  r.markOrphan('a', 'key-2', 60_000, () => {});
  const fresh = sock('b', { _walletAddress: 'Injected' });
  r.reattach('key-2', fresh);
  assert.strictEqual(fresh._walletAddress, undefined, 'never a wallet the snake was not paid from');
  assert.strictEqual(fresh._googleId, 'FreeGuy');
});

test('index.js: the reconnect branch returns before any token is read, and the cash-out pays only the socket\'s wallet', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const reattach = src.indexOf('room.reattach(reconnectKey, socket)');
  const consume = src.indexOf('consumePaidEntryAtStake(entryToken, Number(stake), \'snake\')');
  assert.ok(reattach > 0 && consume > reattach, 'so reattach is the only place the new socket can get its wallet');
  // The payout goes through inlinePayout since the night review (2026-10-29), still to the socket's own wallet.
  assert.match(src, /if \(socket\._walletAddress\) \{[\s\S]{0,1200}?const wallet = socket\._walletAddress;[\s\S]{0,200}inlinePayout\.pay\(\{ wallet, amount: playerShare/);
  const gr = fs.readFileSync(path.join(__dirname, '..', 'server', 'GameRoom.js'), 'utf8');
  const body = gr.slice(gr.indexOf('  reattach(key, newSocket) {'));
  assert.ok(body.indexOf('newSocket._walletAddress = oldSocket._walletAddress') < body.indexOf('player.socket = newSocket'),
    'copied before the swap');
});
