'use strict';
// Night queue item 5, review findings: "escrow pays the rent for a player's missing USDC account
// on every payout" (a stake that closes the payer's account, then Paper's no-input refund, was a
// free loop draining escrow SOL) and "the USDC verifier tolerance plus cent rounding lets a
// hand-built transfer buy a full seat for less than the rung". No network: the chain is stubbed
// on the real Usdc module, with a throwaway escrow key.
const { Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const spl = require('@solana/spl-token');

process.env.SOLANA_NETWORK = 'mainnet-beta';
process.env.RPC_URL = 'https://rpc.invalid/never-called';
process.env.ESCROW_PRIVATE_KEY = Buffer.from(Keypair.generate().secretKey).toString('base64');
process.env.MONEY_MODE = 'usdc';

const test = require('node:test');
const assert = require('node:assert');
const Usdc = require('../server/Usdc');
const money = require('../server/money');
const { tierFor } = require('../server/stakeRules');

const escrow = Usdc.escrowPubkey();
const escrowAta = Usdc.escrowAta();
const player = Keypair.generate().publicKey;
const playerAta = spl.getAssociatedTokenAddressSync(Usdc.USDC_MINT, player);
const existing = new Set([escrowAta.toBase58()]);

function tokenAccountInfo(owner, amount) {
  const data = Buffer.alloc(spl.AccountLayout.span);
  spl.AccountLayout.encode({
    mint: Usdc.USDC_MINT, owner, amount: BigInt(amount), delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default
  }, data);
  return { data, executable: false, lamports: 2039280, owner: spl.TOKEN_PROGRAM_ID, rentEpoch: 0 };
}
Usdc.connection.getAccountInfo = async (addr) => (existing.has(addr.toBase58())
  ? tokenAccountInfo(addr.equals(escrowAta) ? escrow : player, addr.equals(escrowAta) ? 10_000_000 : 0) : null);
Usdc.connection.getLatestBlockhash = async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 });
const sent = [];
Usdc.connection.sendRawTransaction = async (raw) => { sent.push(raw); return 'SIG'; };
Usdc.connection.confirmTransaction = async () => ({ value: { err: null } });

const createsAccount = (raw) => Transaction.from(raw).instructions.some(ix => ix.programId.equals(spl.ASSOCIATED_TOKEN_PROGRAM_ID));

test('a payout to a wallet with no USDC account is refused before anything is signed or sent', async () => {
  existing.delete(playerAta.toBase58());
  await assert.rejects(Usdc.buildSignedUsdcPayout(player.toBase58(), 0.1), (e) => e.code === Usdc.RECIPIENT_NO_USDC_ACCOUNT);
  await assert.rejects(money.withdraw(player.toBase58(), 0.1), (e) => e.code === Usdc.RECIPIENT_NO_USDC_ACCOUNT);
  assert.strictEqual(sent.length, 0, 'nothing broadcast');
  // The drainer's path refuses too, so an owed row waits instead of paying the rent later.
  await assert.rejects(Usdc.attemptPayout({ wallet_address: player.toBase58(), amount_sol: 0.1 }, async () => {}),
    (e) => e.code === Usdc.RECIPIENT_NO_USDC_ACCOUNT);
  assert.strictEqual(sent.length, 0);
});

test('once the wallet has its account again the same payout goes through, with no account creation', async () => {
  existing.add(playerAta.toBase58());
  const built = await Usdc.buildSignedUsdcPayout(player.toBase58(), 0.1);
  assert.strictEqual(createsAccount(built.raw), false);
  existing.delete(playerAta.toBase58());
});

test('only the named house wallet, or a payout that asks (the Battle Royale prize), may open an account', async () => {
  const house = Keypair.generate().publicKey.toBase58();
  money.allowAccountRentFor(house);
  assert.strictEqual(createsAccount((await Usdc.buildSignedUsdcPayout(house, 0.5)).raw), true);
  assert.strictEqual(createsAccount((await Usdc.buildSignedUsdcPayout(player.toBase58(), 5, { payRent: true })).raw), true);
  await assert.rejects(Usdc.buildSignedUsdcPayout(player.toBase58(), 0.1), (e) => e.code === Usdc.RECIPIENT_NO_USDC_ACCOUNT);
  const src = require('fs').readFileSync(require('path').join(__dirname, '../server/index.js'), 'utf8');
  assert.match(src, /money\.allowAccountRentFor\(REVENUE_WALLET\)/);
  assert.match(src, /money\.withdraw\(w\.wallet, BR_PRIZE_USDC, \{ payRent: true \}\)/);
  assert.strictEqual((src.match(/payRent: true/g) || []).length, 1, 'no other payout pays account rent');
});

test('the USDC stake verifier asks for the exact rung, with no 1 percent tolerance', async () => {
  const asked = [];
  const real = Usdc.verifyUsdcStake;
  Usdc.verifyUsdcStake = async (sig, min) => { asked.push(min); return { payer: 'P', usdc: min }; };
  try {
    await money.verifyStake('s1', money.amountFor(0.5));
    await money.verifyStake('s2', money.amountFor(1));
  } finally {
    Usdc.verifyUsdcStake = real;
  }
  assert.deepStrictEqual(asked, [0.5, 1]);
  assert.strictEqual(Usdc.toUnits(asked[0]), 500000n, 'what the quote asks the widget to sign');
});

test('a payment is never rounded up to a rung it did not cover', () => {
  assert.strictEqual(tierFor(0.495), 0, '495000 units do not buy the $0.50 seat');
  assert.strictEqual(tierFor(0.499999), 0);
  assert.strictEqual(tierFor(0.1), 0, '100000 units (the retired $0.10) buy no paid seat');
  assert.strictEqual(tierFor(0.995), 0.5, '995000 units do not buy the $1 seat');
  assert.strictEqual(tierFor(0.999999), 0.5);
  assert.strictEqual(tierFor(0.5), 0.5);
  assert.strictEqual(tierFor(1), 1);
  assert.strictEqual(tierFor(1.04), 1);
});
