'use strict';
/* These pin the CURRENT paid-entry behaviour, before the any-amount stake model
   changes it. Every one of them describes a way real money could be lost or
   minted if it stopped holding, so they are the safety net for that change
   rather than coverage for its own sake. */
const { test } = require('node:test');
const assert = require('node:assert');
const { makeEntryStore } = require('../server/entryStore');

// A fixture: a cheaper tier beside the dollar, so a dearer door can be tried. The server's own
// table (money.js) has only free, br and dollar since the ten cent tier was retired.
const FEES = { free: 0, cheap: 0.50, dollar: 1.00 };
const store = (ttlMs = 60000) => makeEntryStore({ ttlMs, fees: FEES });

test('a valid token yields the server-recorded worth', () => {
  const s = store();
  const tok = s.mint({ lobbyType: 'dollar', worth: 1.00, walletAddress: 'W1' });
  assert.deepEqual(s.consume(tok, 'dollar'),
    { ok: true, worth: 1.00, paid: undefined, googleId: undefined, walletAddress: 'W1' });
});

test('a token is one-time — a replay mints nothing', () => {
  const s = store();
  const tok = s.mint({ lobbyType: 'dollar', worth: 1.00, walletAddress: 'W1' });
  assert.equal(s.consume(tok, 'dollar').ok, true);
  assert.deepEqual(s.consume(tok, 'dollar'), { ok: false, worth: 0 },
    'replaying a spent token must not buy a second seat');
});

test('a token bought for one tier cannot open a dearer one', () => {
  // The escrow-drain shape: pay 50c, claim the $1 room, cash out $1.
  const s = store();
  const tok = s.mint({ lobbyType: 'cheap', worth: 0.50, walletAddress: 'W1' });
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
  s.mint({ lobbyType: 'cheap', worth: 0.5, walletAddress: 'W2' });
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
    { ok: true, worth: 0.50, paid: undefined, googleId: undefined, walletAddress: 'W1' });
});

test('paying a little and claiming a lot buys nothing', () => {
  // The whole point of the model: the amount is not the client's to choose.
  const s = amt();
  const tok = s.mint({ stake: 0.50, worth: 0.50, walletAddress: 'W1' });
  assert.deepEqual(s.consumeAtStake(tok, 50), { ok: false, worth: 0 });
  assert.deepEqual(s.consumeAtStake(tok, 1), { ok: false, worth: 0 },
    'not even one rung up');
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
  // Amounts that WERE rungs before the ladder was cut to three are the
  // sharpest cases here: they are plausible, and they must now be refused.
  for (const bad of [0.05, 0.10, 0.25, 0.26, 2, 3, 5, 37.42, 100, 250])
    assert.throws(() => s.mint({ stake: bad, worth: bad }), /not on the ladder/, String(bad));
  for (const good of [0.50, 1])
    assert.doesNotThrow(() => s.mint({ stake: good, worth: good }), String(good));
});

test('a tier token cannot be spent through the any-amount door unless it matches', () => {
  // Both flows share one store during the migration, so they must not launder
  // into each other. A cheap tier token is worth its price, whichever door it uses.
  const s = amt();
  const tier = s.mint({ lobbyType: 'cheap', worth: 0.50, walletAddress: 'W1' });
  assert.deepEqual(s.consumeAtStake(tier, 0.50), { ok: false, worth: 0 },
    'a token with no recorded stake opens no priced lobby');
});

test('an any-amount token cannot be spent through the tier door', () => {
  const s = amt();
  /* Sharper now that the ladder and the fee table agree: a cheap tier token and
     the cheap door are the SAME money, and they still must not interchange, because
     what separates them is which flow minted the token and not the amount. */
  const tok = s.mint({ stake: 0.50, worth: 0.50, walletAddress: 'W1' });
  assert.deepEqual(s.consume(tok, 'cheap'), { ok: false, worth: 0 });
});

/* ─── what landed on-chain ───────────────────────────────────────────────────
   The verifier accepted 99 percent of the rung, so 0.495 bought a $0.50 token. A
   refund of a join the server refused has to be bounded by what landed, not
   by the rung, or every refused join mints the gap. The token carries it. */

test('the amount that landed rides the token through the ladder door', () => {
  const s = amt();
  const tok = s.mint({ stake: 0.50, worth: 0.50, paid: 0.495, walletAddress: 'W1' });
  const r = s.consumeAtStake(tok, 0.50);
  assert.equal(r.ok, true);
  assert.equal(r.worth, 0.50, 'worth stays the rung');
  assert.equal(r.paid, 0.495, 'paid is what landed');
  assert.equal(r.walletAddress, 'W1');
});

test('the amount that landed rides the token through the tier door', () => {
  const s = store();
  const tok = s.mint({ lobbyType: 'dollar', worth: 1.00, paid: 0.995, walletAddress: 'W1' });
  const r = s.consume(tok, 'dollar');
  assert.equal(r.ok, true);
  assert.equal(r.worth, 1.00);
  assert.equal(r.paid, 0.995);
});

test('a token minted without paid reports it as undefined, never 0 or NaN', () => {
  // undefined is what makes a refund fall back to the rung; a 0 would refund nothing.
  const s = amt();
  const tok = s.mint({ stake: 1, worth: 1, walletAddress: 'W1' });
  const r = s.consumeAtStake(tok, 1);
  assert.equal(r.ok, true);
  assert.strictEqual(r.paid, undefined);
  const t = store();
  const tier = t.mint({ lobbyType: 'cheap', worth: 0.50, walletAddress: 'W1' });
  assert.strictEqual(t.consume(tier, 'cheap').paid, undefined);
});

test('paid comes from the mint only: a refused or spent token carries none', () => {
  const s = amt();
  const tok = s.mint({ stake: 1, worth: 1, paid: 1.5, walletAddress: 'W1' });
  assert.strictEqual(s.consumeAtStake(tok, 0.50).paid, undefined, 'wrong rung');
  assert.equal(s.consumeAtStake(tok, 1).paid, 1.5, 'the right rung still works after that');
  assert.strictEqual(s.consumeAtStake(tok, 1).paid, undefined, 'a replay carries nothing');
  assert.strictEqual(s.consumeAtStake(undefined, 0).paid, undefined, 'free play carries nothing');
});

/* ─── a token scoped to one game ─────────────────────────────────────────────
   Paper's dev entry tokens have no chain behind them and are paid out only by
   Paper's fake withdraw. Every other game pays, refunds and sweeps through the
   real money module, so an unbacked token spent there would become a real
   owed-payout row. A token minted with onlyGame opens that game's door only. */

test('a token scoped to one game opens that game only', () => {
  const s = amt();
  const tok = s.mint({ stake: 1, worth: 1, paid: 1, walletAddress: 'W1', onlyGame: 'paper' });
  for (const game of ['snake', 'knockout', 'battleship', undefined, '', 'PAPER']) {
    assert.deepEqual(s.consumeAtStake(tok, 1, game), { ok: false, worth: 0 }, 'refused for ' + game);
  }
  assert.deepEqual(s.consumeAtStake(tok, 1, 'paper'),
    { ok: true, worth: 1, paid: 1, googleId: undefined, walletAddress: 'W1' },
    'a refusal at another door does not spend it');
  assert.deepEqual(s.consumeAtStake(tok, 1, 'paper'), { ok: false, worth: 0 }, 'and it is still one-time');
});

test('a scoped token never opens the tier door', () => {
  const s = makeEntryStore({ ttlMs: 60000, fees: FEES, isStake: (x) => [0.50, 1].includes(x) });
  const tok = s.mint({ lobbyType: 'cheap', stake: 0.50, worth: 0.50, walletAddress: 'W1', onlyGame: 'paper' });
  assert.deepEqual(s.consume(tok, 'cheap'), { ok: false, worth: 0 });
  assert.equal(s.consumeAtStake(tok, 0.50, 'paper').ok, true, 'still good at its own door');
});

test('an unscoped token still opens every game, as before', () => {
  const s = amt();
  for (const game of ['paper', 'snake', 'knockout', 'battleship', undefined]) {
    const tok = s.mint({ stake: 1, worth: 1, walletAddress: 'W1' });
    assert.equal(s.consumeAtStake(tok, 1, game).ok, true, 'opens ' + game);
  }
});
