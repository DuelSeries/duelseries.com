'use strict';
// Night queue item 5, review findings "a paid entry token that is never spent is never refunded"
// (both lenses) and "the pre-restart money check ignores Paper floor coins". The store hands an
// expired token over exactly once, the refund pays what landed to the verified wallet (or owes it
// as a 'refund' row), dev tokens never touch the real escrow, and drainStatus is unsafe while a
// token is pending or a coin lies on a Paper floor.
const test = require('node:test');
const assert = require('node:assert');
const { makeEntryStore } = require('../server/entryStore');
const { createExpiryRefund } = require('../server/entryExpiry');
const { isStake } = require('../server/stakeRules');
const ops = require('../server/ops');
const { PaperRoom } = require('../server/paper/PaperRoom');
const { REASON } = require('../server/paper/ArenaGame');

const TTL = 5 * 60 * 1000;
const quiet = { log() {}, warn() {}, error() {} };

function clockStore(onExpire) {
  let t = 1e9;
  const store = makeEntryStore({ ttlMs: TTL, fees: { free: 0, cheap: 0.5, dollar: 1 }, isStake, onExpire, now: () => t });
  return { store, advance: (ms) => { t += ms; } };
}

test('an unspent paid token is handed to onExpire exactly once when it expires, and never while it can still be used', () => {
  const got = [];
  const { store, advance } = clockStore((v) => got.push(v));
  const a = store.mint({ stake: 1, worth: 1, paid: 0.995, walletAddress: 'WA' });
  const b = store.mint({ lobbyType: 'cheap', worth: 0.5, walletAddress: 'WB' });
  const used = store.mint({ stake: 0.5, worth: 0.5, paid: 0.5, walletAddress: 'WC' });
  assert.strictEqual(store.consumeAtStake(used, 0.5).ok, true, 'a spent token is never refunded');
  assert.strictEqual(store.sweep(), 0);
  assert.deepStrictEqual(got, []);
  advance(TTL + 1);
  // A late join cannot spend it, and does not remove it either: only the sweep does.
  assert.strictEqual(store.consumeAtStake(a, 1).ok, false);
  assert.strictEqual(store.consume(b, 'cheap').ok, false);
  assert.strictEqual(store.size, 2);
  assert.strictEqual(store.sweep(), 2);
  assert.deepStrictEqual(got.map(v => [v.walletAddress, v.worth, v.paid]).sort(), [['WA', 1, 0.995], ['WB', 0.5, undefined]]);
  assert.strictEqual(store.size, 0);
  store.sweep();
  assert.strictEqual(got.length, 2, 'handed over once');
  assert.strictEqual(store.consumeAtStake(a, 1).ok, false, 'and never spendable afterwards');
});

test('a throwing expiry hook cannot stop the sweep or leave a token behind', () => {
  const got = [];
  const { store, advance } = clockStore((v) => { got.push(v.walletAddress); throw new Error('boom'); });
  store.mint({ stake: 1, worth: 1, paid: 1, walletAddress: 'W1' });
  store.mint({ stake: 1, worth: 1, paid: 1, walletAddress: 'W2' });
  advance(TTL + 1);
  const err = console.error;
  console.error = () => {};
  try { store.sweep(); } finally { console.error = err; }
  assert.deepStrictEqual(got.sort(), ['W1', 'W2']);
  assert.strictEqual(store.size, 0);
});

test('pending() is every unspent token at what its refund would pay; backedOnly leaves out dev tokens', () => {
  const { store } = clockStore(null);
  store.mint({ stake: 1, worth: 1, paid: 0.995, walletAddress: 'WA' });
  store.mint({ stake: 0.5, worth: 0.5, paid: 0.5, walletAddress: 'WB' });
  store.mint({ stake: 1, worth: 1, paid: 1, walletAddress: 'WDEV', onlyGame: 'paper' });
  const all = store.pending();
  assert.strictEqual(all.count, 3);
  assert.strictEqual(Math.round(all.worth * 1e6), 2495000);
  const real = store.pending({ backedOnly: true });
  assert.strictEqual(real.count, 2);
  assert.strictEqual(Math.round(real.worth * 1e6), 1495000);
});

test('the expiry refund pays what landed (never the rung) to the token wallet, with no rake and no earnings', async () => {
  const sent = [];
  const owed = [];
  const refund = createExpiryRefund({
    money: { unit: 'USDC', withdraw: async (w, amt) => { sent.push([w, Math.round(amt * 1e6)]); return 'SIG1'; } },
    db: { recordFailedPayout: async (...a) => owed.push(a), recordEarnings: () => { throw new Error('a refund is not earnings'); } },
    log: quiet
  });
  await refund({ stake: 1, worth: 1, paid: 0.995, walletAddress: 'WA' });
  await refund({ lobbyType: 'cheap', worth: 0.5, walletAddress: 'WB' }); // tier token: worth IS what landed
  await refund({ stake: 0.5, worth: 0.5, paid: 0.75, walletAddress: 'WC' }); // an overpay: the rung, never more
  assert.deepStrictEqual(sent, [['WA', 995000], ['WB', 500000], ['WC', 500000]]);
  assert.deepStrictEqual(owed, []);
});

test('a failed expiry refund is owed as a failed_payouts row whose reason starts with "refund"', async () => {
  const owed = [];
  const refund = createExpiryRefund({
    money: { withdraw: async () => { const e = new Error('rpc down'); e.broadcast = { signature: 'S' }; throw e; } },
    db: { recordFailedPayout: async (...a) => owed.push(a) },
    log: quiet
  });
  assert.strictEqual(await refund({ stake: 1, worth: 1, paid: 1, walletAddress: 'WA' }), null);
  assert.strictEqual(owed.length, 1);
  const [wallet, amount, , reason, broadcast] = owed[0];
  assert.deepStrictEqual([wallet, amount], ['WA', 1]);
  assert.match(reason, /^refund /, 'the drainer must not count it as winnings');
  assert.deepStrictEqual(broadcast, { signature: 'S' });
});

test('dev tokens never reach the real escrow: Paper ones go to Paper\'s own refund, others are dropped', async () => {
  const sent = [];
  const dev = [];
  const refund = createExpiryRefund({
    money: { withdraw: async (w, a) => { sent.push([w, a]); return 'REAL'; } },
    db: { recordFailedPayout: async () => {} },
    devRefund: (t) => dev.push(t.walletAddress),
    log: quiet
  });
  await refund({ stake: 1, worth: 1, paid: 1, walletAddress: 'WDEV', onlyGame: 'paper' });
  await refund({ stake: 1, worth: 1, paid: 1, walletAddress: 'WOTHER', onlyGame: 'snake' });
  const noDev = createExpiryRefund({ money: { withdraw: async (w, a) => { sent.push([w, a]); } }, db: {}, log: quiet });
  await noDev({ stake: 1, worth: 1, paid: 1, walletAddress: 'WDEV2', onlyGame: 'paper' });
  assert.deepStrictEqual(dev, ['WDEV']);
  assert.deepStrictEqual(sent, [], 'nothing from the real money module');
});

test('index.js wires the expiry refund into the store and sweeps every minute', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../server/index.js'), 'utf8');
  assert.match(src, /makeEntryStore\(\{[^}]*onExpire: refundExpiredEntry/);
  assert.match(src, /setInterval\(\(\) => \{\s*entryStore\.sweep\(\);[^}]*\}, 60 \* 1000\)/);
  assert.match(src, /total \+= entryStore\.pending\(\{ backedOnly: true \}\)\.worth/, 'unspent tokens count as liability');
  assert.match(src, /ops\.drainStatus\(ALL_ROOMS\(\), entryStore\.pending\(\)\)/);
});

// ---- drainStatus -----------------------------------------------------------------------------

function paperRoom(stake) {
  return new PaperRoom({
    stake,
    hooks: { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {} },
    autoTick: false,
    seed: 7
  });
}

test('drainStatus is unsafe while a coin lies on a Paper floor with nobody seated', () => {
  const room = paperRoom(1);
  const sock = { id: 'd1', emit() {}, join() {}, leave() {} };
  const seat = room.addHuman(sock, { name: 'x', micro: 1000000, wallet: 'WX' });
  assert.strictEqual(ops.drainStatus([room]).safe, false, 'seated');
  room.game.kill(seat.unit, undefined, REASON.SELF_CROSS);
  assert.strictEqual(room.bank.floorMicro(), 1000000);
  const d = ops.drainStatus([room]);
  assert.strictEqual(d.paid, 0);
  assert.strictEqual(d.safe, false, 'the coin is memory only; a restart would lose it');
  assert.strictEqual(d.floorWorth, 1);
  assert.match(d.reason, /1 USDC on Paper floors/);
  room.stop();
});

test('drainStatus is unsafe while a paid entry token is minted and not yet joined', () => {
  const d = ops.drainStatus([], { count: 2, worth: 1.1 });
  assert.strictEqual(d.safe, false);
  assert.strictEqual(d.pendingEntries, 2);
  assert.strictEqual(d.pendingWorth, 1.1);
  assert.match(d.reason, /2 paid entries have not joined yet/);
  assert.strictEqual(ops.drainStatus([], { count: 0, worth: 0 }).safe, true);
  assert.strictEqual(ops.drainStatus([]).safe, true);
});

test('paid agar.io dev tokens go to devRefund too (the server routes them to agar\'s own payout); never the real escrow', async () => {
  const sent = [];
  const dev = [];
  const refund = createExpiryRefund({
    money: { withdraw: async (w, a) => { sent.push([w, a]); return 'REAL'; } },
    db: { recordFailedPayout: async () => {} },
    devRefund: (t) => dev.push([t.onlyGame, t.walletAddress]),
    log: quiet
  });
  await refund({ stake: 0.5, worth: 0.5, paid: 0.5, walletAddress: 'WAG', onlyGame: 'agar' });
  await refund({ stake: 1, worth: 1, paid: 1, walletAddress: 'WPP', onlyGame: 'paper' });
  await refund({ stake: 1, worth: 1, paid: 1, walletAddress: 'WSN', onlyGame: 'snake' });
  assert.deepStrictEqual(dev, [['agar', 'WAG'], ['paper', 'WPP']]);
  assert.deepStrictEqual(sent, []);
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(src, /\(t\.onlyGame === 'agar' \? agPayout : paperPayout\)\.refund\(/, 'index.js routes agar dev expiries to agPayout');
});
