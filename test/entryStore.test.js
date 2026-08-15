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

/* ─── any-amount stakes ───────────────────────────────────────────────────────
   The new model binds a token to the amount that actually landed on-chain
   rather than to a tier name. These are the same money-loss shapes as above,
   restated against that binding. */

const { isStake } = require('../server/stakeRules');
const amt = (ttlMs = 60000) => makeEntryStore({ ttlMs, fees: FEES, isStake });

test('a token opens exactly the lobby it was paid for', () => {
  const s = amt();
  const tok = s.mint({ stake: 0.50, worth: 0.50, walletAddress: 'W1' });
  assert.deepEqual(s.consumeAtStake(tok, 0.50),
    { ok: true, worth: 0.50, googleId: undefined, walletAddress: 'W1' });
});

test('paying a little and claiming a lot buys nothing', () => {
  // The whole point of the model: the amount is not the client's to choose.
  const s = amt();
  const tok = s.mint({ stake: 0.25, worth: 0.25, walletAddress: 'W1' });
  assert.deepEqual(s.consumeAtStake(tok, 50), { ok: false, worth: 0 });
  assert.deepEqual(s.consumeAtStake(tok, 0.50), { ok: false, worth: 0 },
    'not even slightly more');
});

test('an any-amount token is one-time', () => {
  const s = amt();
  const tok = s.mint({ stake: 1, worth: 1, walletAddress: 'W1' });
  assert.equal(s.consumeAtStake(tok, 1).ok, true);
  assert.equal(s.consumeAtStake(tok, 1).ok, false);
});

test('an expired any-amount token is refused', () => {
  const s = amt(-1);
  const tok = s.mint({ stake: 1, worth: 1, walletAddress: 'W1' });
  assert.deepEqual(s.consumeAtStake(tok, 1), { ok: false, worth: 0 });
});

test('a forged or absent any-amount token is refused', () => {
  const s = amt();
  for (const bad of [undefined, null, '', 'nope', 0])
    assert.deepEqual(s.consumeAtStake(bad, 1), { ok: false, worth: 0 }, String(bad));
});

test('stake 0 is free play: no token, no worth', () => {
  const s = amt();
  assert.deepEqual(s.consumeAtStake(undefined, 0), { ok: true, worth: 0 });
});

test('a nonsense stake is refused rather than treated as free', () => {
  const s = amt();
  for (const bad of [NaN, Infinity, -1, 'abc'])
    assert.deepEqual(s.consumeAtStake('x', bad), { ok: false, worth: 0 }, String(bad));
});

test('a stake off the ladder cannot be minted at all', () => {
  // A token is the only thing between a client and a room, so one must never
  // exist for an amount that has no room.
  const s = amt();
  for (const bad of [0.10, 0.26, 3, 37.42, 250])
    assert.throws(() => s.mint({ stake: bad, worth: bad }), /not on the ladder/, String(bad));
  for (const good of [0.25, 0.5, 1, 2, 5, 10, 20, 100])
    assert.doesNotThrow(() => s.mint({ stake: good, worth: good }), String(good));
});

test('a tier token cannot be spent through the any-amount door unless it matches', () => {
  // Both flows share one store during the migration, so they must not launder
  // into each other. A dime token is worth a dime, whichever door it uses.
  const s = amt();
  const tier = s.mint({ lobbyType: 'dime', worth: 0.10, walletAddress: 'W1' });
  assert.deepEqual(s.consumeAtStake(tier, 0.10), { ok: false, worth: 0 },
    'a token with no recorded stake opens no priced lobby');
});

test('an any-amount token cannot be spent through the tier door', () => {
  const s = amt();
  const tok = s.mint({ stake: 1.00, worth: 1.00, walletAddress: 'W1' });
  assert.deepEqual(s.consume(tok, 'dollar'), { ok: false, worth: 0 });
});
