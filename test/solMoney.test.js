'use strict';
// SOL mode money (server/money.js solBackend + server/solPrice.js): games count in dollars, SOL moves only at the
// doors. Price rules, exact lamport conversion, the quote-locked rate, the verify, payouts, and a ledger per game:
// at one price the escrow never sends more SOL than it took in, and keeps the 10 percent to the lamport.
process.env.MONEY_MODE = 'sol';
process.env.SOL_PRICE_POLL = 'off';
const test = require('node:test');
const assert = require('node:assert');
const { createSolPrice, lamportsUp, lamportsDown, microDown, PRICE_WAIT } = require('../server/solPrice');
const Wallet = require('../server/Wallet');
const money = require('../server/money');
const paperPayout = require('../server/paperPayout');
const { Keypair } = require('@solana/web3.js');

const T0 = 1_800_000_000_000;
function priceAt(readings, t = T0) {
  const p = createSolPrice({ now: () => t, log: null, sources: [] });
  for (const [name, usd, age] of readings) p._last.set(name, { usd, at: t - (age || 0) });
  return p;
}
function seed(usd) {
  money.price._last.clear();
  const t = Date.now();
  money.price._last.set('a', { usd, at: t });
  money.price._last.set('b', { usd, at: t });
}

test('price: needs two fresh sources within 1.5 percent, else PRICE_WAIT; median of the agreeing ones', () => {
  assert.throws(() => priceAt([]).current(), (e) => e.code === PRICE_WAIT);
  assert.throws(() => priceAt([['a', 100]]).current(), (e) => e.code === PRICE_WAIT);
  assert.throws(() => priceAt([['a', 100], ['b', 102]]).current(), (e) => e.code === PRICE_WAIT);       // 2 percent apart
  assert.throws(() => priceAt([['a', 100], ['b', 100.5, 61_000]]).current(), (e) => e.code === PRICE_WAIT); // one stale
  assert.strictEqual(priceAt([['a', 100], ['b', 101]]).current().usd, 100.5);
  // an outlier is outvoted, not averaged in
  assert.strictEqual(priceAt([['a', 100], ['b', 100.4], ['c', 140]]).current().usd, 100.2);
  assert.strictEqual(priceAt([['a', 100], ['b', 100.4], ['c', 140]]).current().sources, 2);
  assert.strictEqual(priceAt([]).peek(), null);
});

test('price: each source reply is read, a bad reply keeps nothing', async () => {
  const replies = {
    'https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112': { So11111111111111111111111111111111111111112: { usdPrice: 107.58 } },
    'https://api.coinbase.com/v2/prices/SOL-USD/spot': { data: { amount: '107.61', currency: 'USD' } },
    'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd': { solana: { usd: 'nope' } },
  };
  const fetchImpl = async (url) => ({ ok: true, json: async () => replies[url] });
  const p = createSolPrice({ fetchImpl, now: () => T0, log: null });
  await p.poll();
  assert.deepStrictEqual([...p._last.keys()].sort(), ['coinbase', 'jupiter']);
  assert.ok(Math.abs(p.current().usd - 107.595) < 1e-9);
});

test('conversion is integer-exact: stakes round up, payouts round down, never off by float noise', () => {
  for (const rate of [107.58325494585523, 133.33, 99.999999, 250, 12.5]) {
    for (const usd of [0.5, 1, 0.45, 0.05, 20, 5, 0.000001]) {
      const up = lamportsUp(usd, rate), down = lamportsDown(usd, rate);
      assert.ok(Number.isSafeInteger(up) && Number.isSafeInteger(down));
      assert.ok(up - down <= 1 && up >= down);
      assert.ok(microDown(up, rate) >= Math.round(usd * 1e6) - 1);  // what a stake buys covers the dollars
      assert.ok(microDown(down, rate) <= Math.round(usd * 1e6));     // what a payout sends never exceeds them
    }
  }
  assert.strictEqual(lamportsUp(0.5, 100), 5_000_000);
  assert.strictEqual(lamportsDown(0.45, 100), 4_500_000);
  assert.throws(() => lamportsUp(1, 0));
});

test('quote: dollars in, lamports at a rate locked to the blockhash; a later quote on it reuses that rate', async (t) => {
  t.mock.method(Wallet, 'getLatestBlockhash', async () => ({ blockhash: 'BH-lock', lastValidBlockHeight: 9 }));
  t.mock.method(Wallet, 'getEscrowPublicKey', () => 'ESCROW');
  seed(100);
  const q1 = await money.stakeQuoteFor(0.5);
  assert.strictEqual(q1.mode, 'sol');
  assert.strictEqual(q1.lamports, 5_000_000);
  assert.strictEqual(q1.escrowAddress, 'ESCROW');
  seed(125);
  const q2 = await money.stakeQuoteFor(1);
  assert.strictEqual(q2.rate, 100);                 // same blockhash, same rate
  assert.strictEqual(q2.lamports, 10_000_000);
  assert.strictEqual(money.unit, 'USD');
  assert.strictEqual(money.feeFor('dollar'), 1);
});

test('quote: no good price -> PRICE_WAIT before anything is built', async (t) => {
  t.mock.method(Wallet, 'getLatestBlockhash', async () => ({ blockhash: 'BH-none', lastValidBlockHeight: 9 }));
  money.price._last.clear();
  await assert.rejects(money.stakeQuoteFor(0.5), (e) => e.code === PRICE_WAIT && e.code === money.waitCode);
});

test('verify: a stake that paid its quote is worth exactly the dollars; a short one reports what landed', async (t) => {
  t.mock.method(Wallet, 'getLatestBlockhash', async () => ({ blockhash: 'BH-v', lastValidBlockHeight: 9 }));
  t.mock.method(Wallet, 'getEscrowPublicKey', () => 'ESCROW');
  seed(107.58);
  const q = await money.stakeQuoteFor(0.5);
  seed(90);                                          // the price moves after the quote: the quote's rate still rules
  let landed = q.lamports;
  t.mock.method(Wallet, 'verifyStakeTransfer', async () => ({ payer: 'PAYER', lamports: landed, blockhash: 'BH-v' }));
  const v = await money.verifyStake('SIG', 0.5);
  assert.deepStrictEqual([v.payer, v.worth], ['PAYER', 0.5]);
  landed = q.lamports - 1;
  await assert.rejects(money.verifyStake('SIG', 0.5), (e) => /too small/.test(e.message)
    && e.payer === 'PAYER' && e.landedUsd > 0.4999 && e.landedUsd < 0.5);
});

test('verify: a blockhash this process never quoted is priced at the rate now', async (t) => {
  seed(200);
  t.mock.method(Wallet, 'verifyStakeTransfer', async () => ({ payer: 'P', lamports: 2_500_000, blockhash: 'BH-unknown' }));
  assert.strictEqual((await money.verifyStake('S', 0.5)).worth, 0.5);
  t.mock.method(Wallet, 'verifyStakeTransfer', async () => ({ payer: 'P', lamports: 2_499_999, blockhash: 'BH-unknown' }));
  await assert.rejects(money.verifyStake('S', 0.5), /too small/);
});

test('payout: dollars become lamports rounded down at the rate of the build; no price -> nothing signed', async (t) => {
  const sent = [];
  t.mock.method(Wallet, 'withdraw', async (to, sol, opts) => { sent.push([to, sol, opts.lamports]); return 'SIG'; });
  seed(100);
  await money.withdraw('W', 0.45);
  assert.deepStrictEqual(sent[0], ['W', null, 4_500_000]);
  money.price._last.clear();
  assert.throws(() => money.withdraw('W', 0.45), (e) => e.code === PRICE_WAIT);
  assert.strictEqual(sent.length, 1);
});

test('drainer: a row is converted only when a fresh transaction is built', async (t) => {
  let asked = 0;
  t.mock.method(Wallet, 'attemptPayout', async (row, fn, lamportsFor) => { asked++; return { paid: true, lam: lamportsFor(row) }; });
  seed(50);
  const r = await money.attemptPayout({ amount_sol: 0.9, wallet_address: 'W' }, () => true);
  assert.strictEqual(r.lam, 18_000_000);
  assert.strictEqual(asked, 1);
});

test('Wallet: dust to an empty wallet waits (nothing signed, nothing sent); to a funded wallet it builds', async (t) => {
  const kp = Keypair.generate();
  process.env.ESCROW_PRIVATE_KEY = Buffer.from(kp.secretKey).toString('base64');
  const to = Keypair.generate().publicKey.toString();
  let toBalance = 0, sends = 0;
  const c = Wallet.connection;
  t.mock.method(c, 'getBalance', async (pk) => (pk.toString() === to ? toBalance : 5_000_000_000));
  t.mock.method(c, 'getMinimumBalanceForRentExemption', async () => 890_880);
  t.mock.method(c, 'getLatestBlockhash', async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 }));
  t.mock.method(c, 'sendRawTransaction', async () => { sends++; return 'x'; });
  t.mock.method(c, 'confirmTransaction', async () => ({ value: { err: null } }));
  await assert.rejects(Wallet.withdraw(to, null, { lamports: 400_000 }), (e) => e.code === Wallet.PAYOUT_WAIT);
  assert.strictEqual(sends, 0);
  toBalance = 1;
  await Wallet.withdraw(to, null, { lamports: 400_000 });
  assert.strictEqual(sends, 1);
  await assert.rejects(Wallet.withdraw(to, null, { lamports: 1.5 }), /positive number of lamports/);
  delete process.env.ESCROW_PRIVATE_KEY;
});

/* The ledger, per game. Every paid game pays through paperPayout (slither on the sl engine, agar.io, Paper.io: one
   seat's gross in micro-dollars, 90 to the player, 10 to the house) or through money.withdraw directly with dollar
   amounts (duels' pot, the old engine's 90 percent, the battle royale's $20). At one price, SOL out (player +
   rake) never exceeds SOL in (the stakes) and the house keeps its tenth to within a lamport per transfer. */
function ledgerRun(t, game, stakesUsd, cashouts) {
  const out = [];
  t.mock.method(Wallet, 'withdraw', async (to, sol, opts) => { out.push([to, opts.lamports]); return 'SIG' + out.length; });
  const deps = {
    money, REGION: 'na',
    db: { recordEarnings: async () => {}, recordFailedPayout: async () => {} },
    io: { to: () => ({ emit: () => {} }) },
    trackEarning: () => {},
    sweepRake: (usd) => { money.withdraw('REVENUE', usd); },
  };
  t.mock.method(console, 'log', () => {});
  const pay = paperPayout.create(Object.assign(deps, { game }));
  return { out, pay, lamIn: stakesUsd.reduce((s, u) => s + lamportsUp(u, money.price.usdPerSol()), 0), cashouts };
}
for (const game of ['slither', 'agar', 'paper']) {
  test('ledger ' + game + ': two $0.50 stakes, the winner cashes out $1.00 gross', async (t) => {
    seed(107.58325494585523);
    const { out, pay, lamIn } = ledgerRun(t, game, [0.5, 0.5]);
    await pay.payCashout({ cashoutId: game + '-1', grossMicro: 1_000_000, wallet: 'WINNER', name: 'w', label: game + '_s0_5', socketId: 's' });
    await new Promise((r) => setImmediate(r));
    const toPlayer = out.filter((o) => o[0] === 'WINNER').reduce((s, o) => s + o[1], 0);
    const toHouse = out.filter((o) => o[0] === 'REVENUE').reduce((s, o) => s + o[1], 0);
    assert.strictEqual(toPlayer, lamportsDown(0.9, 107.58325494585523));
    assert.strictEqual(toHouse, lamportsDown(0.1, 107.58325494585523));
    assert.ok(toPlayer + toHouse <= lamIn, 'never more SOL out than in');
    assert.ok(lamIn - (toPlayer + toHouse) <= 4, 'nothing lost beyond rounding');
  });
}
test('ledger duels, old engine and battle royale: dollar amounts out at one rate', async (t) => {
  seed(133.33);
  const sent = [];
  t.mock.method(Wallet, 'withdraw', async (to, sol, opts) => { sent.push(opts.lamports); return 'S'; });
  const lamIn = lamportsUp(0.5, 133.33) * 2;
  await money.withdraw('KO-WINNER', 0.9);  // duel pot $1.00, 10 percent cut
  await money.withdraw('REVENUE', 0.1);
  assert.ok(sent[0] + sent[1] <= lamIn && lamIn - (sent[0] + sent[1]) <= 4);
  await money.withdraw('BR-WINNER', 20);   // the $20 prize from the house
  assert.strictEqual(sent[2], lamportsDown(20, 133.33));
});
