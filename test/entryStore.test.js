'use strict';
/* These pin the CURRENT paid-entry behaviour, before the any-amount stake model
   changes it. Every one of them describes a way real money could be lost or
   minted if it stopped holding, so they are the safety net for that change
   rather than coverage for its own sake. */
const { test } = require('node:test');
const assert = require('node:assert');
const { makeEntryStore } = require('../server/entryStore');

const FEES = { free: 0, dime: 0.10, dollar: 1.00 };
const store = (ttlMs = 60000) => makeEntryStore({ ttlMs, fees: FEES });

test('a valid token yields the server-recorded worth', () => {
  const s = store();
  const tok = s.mint({ lobbyType: 'dollar', worth: 1.00, walletAddress: 'W1' });
  assert.deepEqual(s.consume(tok, 'dollar'),
    { ok: true, worth: 1.00, googleId: undefined, walletAddress: 'W1' });
});

test('a token is one-time — a replay mints nothing', () => {
  const s = store();
  const tok = s.mint({ lobbyType: 'dollar', worth: 1.00, walletAddress: 'W1' });
  assert.equal(s.consume(tok, 'dollar').ok, true);
  assert.deepEqual(s.consume(tok, 'dollar'), { ok: false, worth: 0 },
    'replaying a spent token must not buy a second seat');
});

test('a token bought for one tier cannot open a dearer one', () => {
  // The escrow-drain shape: pay 10c, claim the $1 room, cash out $1.
  const s = store();
  const tok = s.mint({ lobbyType: 'dime', worth: 0.10, walletAddress: 'W1' });
  assert.deepEqual(s.consume(tok, 'dollar'), { ok: false, worth: 0 });
});

test('an expired token is refused', () => {
  const s = store(-1);
  const tok = s.mint({ lobbyType: 'dollar', worth: 1.00, walletAddress: 'W1' });
  assert.deepEqual(s.consume(tok, 'dollar'), { ok: false, worth: 0 });
});

test('a forged or absent token is refused for a paid lobby', () => {
  const s = store();
  for (const bad of [undefined, null, '', 'not-a-real-token', 0]) {
    assert.deepEqual(s.consume(bad, 'dollar'), { ok: false, worth: 0 }, String(bad));
  }
});

test('free lobbies need no token and are always worth zero', () => {
  const s = store();
  assert.deepEqual(s.consume(undefined, 'free'), { ok: true, worth: 0 });
});

test('an unknown lobby type is treated as free, never as paid', () => {
  // The type arrives from the client. A junk value must not buy a paid seat,
  // and must not be worth anything either.
  const s = store();
  assert.deepEqual(s.consume(undefined, 'platinum'), { ok: true, worth: 0 });
  assert.deepEqual(s.consume(undefined, undefined), { ok: true, worth: 0 });
});

test('a free-lobby token cannot be spent on a paid lobby', () => {
  const s = store();
  const tok = s.mint({ lobbyType: 'free', worth: 0, walletAddress: 'W1' });
  assert.deepEqual(s.consume(tok, 'dollar'), { ok: false, worth: 0 });
});

test('expired tokens are swept so the map stays bounded', () => {
  const s = store(-1);
  s.mint({ lobbyType: 'dollar', worth: 1, walletAddress: 'W1' });
  s.mint({ lobbyType: 'dime', worth: 0.1, walletAddress: 'W2' });
  assert.equal(s.size, 2);
  s.sweep();
  assert.equal(s.size, 0);
});

test('spending one token leaves other tokens intact', () => {
  const s = store();
  const a = s.mint({ lobbyType: 'dollar', worth: 1, walletAddress: 'W1' });
  const b = s.mint({ lobbyType: 'dollar', worth: 1, walletAddress: 'W2' });
  s.consume(a, 'dollar');
  assert.equal(s.consume(b, 'dollar').walletAddress, 'W2');
});
