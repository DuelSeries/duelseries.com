'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Usdc = require('../server/Usdc');

const ESCROW = 'EscrowOwner11111111111111111111111111111111';
const MINT = Usdc.USDC_MINT.toString();

test('toUnits / toUsdc convert with USDC 6 decimals and round-trip', () => {
  assert.strictEqual(Usdc.toUnits(1).toString(), '1000000');
  assert.strictEqual(Usdc.toUnits(0.1).toString(), '100000');
  assert.strictEqual(Usdc.toUnits(1).toString(), '1000000');
  assert.strictEqual(Usdc.toUnits(0.000001).toString(), '1');
  assert.strictEqual(Usdc.toUsdc(1000000n), 1);
  assert.strictEqual(Usdc.toUsdc(100000n), 0.1);
});

test('stakeDeltaUnits reads the escrow USDC increase from pre/post token balances', () => {
  const meta = {
    preTokenBalances:  [{ owner: ESCROW, mint: MINT, uiTokenAmount: { amount: '5000000' } }],
    postTokenBalances: [{ owner: ESCROW, mint: MINT, uiTokenAmount: { amount: '6000000' } }],
  };
  assert.strictEqual(Usdc.stakeDeltaUnits(meta, ESCROW, MINT), 1000000n); // +1 USDC
});

test('stakeDeltaUnits treats a missing pre-balance as zero (escrow ATA created in this tx)', () => {
  const meta = {
    preTokenBalances:  [],
    postTokenBalances: [{ owner: ESCROW, mint: MINT, uiTokenAmount: { amount: '2500000' } }],
  };
  assert.strictEqual(Usdc.stakeDeltaUnits(meta, ESCROW, MINT), 2500000n); // +2.5 USDC
});

test('stakeDeltaUnits ignores other owners and other mints (anti-spoof)', () => {
  const meta = {
    preTokenBalances:  [{ owner: ESCROW, mint: MINT, uiTokenAmount: { amount: '1000000' } }],
    postTokenBalances: [
      { owner: 'someoneElse', mint: MINT,        uiTokenAmount: { amount: '9999999' } }, // not escrow
      { owner: ESCROW,        mint: 'OtherMint', uiTokenAmount: { amount: '8888888' } }, // not USDC
      { owner: ESCROW,        mint: MINT,        uiTokenAmount: { amount: '1000000' } }, // unchanged
    ],
  };
  assert.strictEqual(Usdc.stakeDeltaUnits(meta, ESCROW, MINT), 0n);
});

test('stakeDeltaUnits is negative when the escrow balance went DOWN (not a credit)', () => {
  const meta = {
    preTokenBalances:  [{ owner: ESCROW, mint: MINT, uiTokenAmount: { amount: '3000000' } }],
    postTokenBalances: [{ owner: ESCROW, mint: MINT, uiTokenAmount: { amount: '1000000' } }],
  };
  assert.ok(Usdc.stakeDeltaUnits(meta, ESCROW, MINT) < 0n);
});

test('ataNotFound recognizes the empty-message TokenAccountNotFoundError by NAME', () => {
  // Regression: @solana/spl-token throws this with an empty .message, so a message-only check
  // misses it and the payout wrongly skips creating the recipient's token account.
  assert.strictEqual(Usdc.ataNotFound({ name: 'TokenAccountNotFoundError', message: '' }), true);
  assert.strictEqual(Usdc.ataNotFound(new Error('could not find account')), true);
  assert.strictEqual(Usdc.ataNotFound(new Error('something else entirely')), false);
  assert.strictEqual(Usdc.ataNotFound(null), false);
});

test('stakeTargets reports a usable escrow ATA, mint, and 6 decimals', () => {
  process.env.ESCROW_PRIVATE_KEY = process.env.ESCROW_PRIVATE_KEY ||
    Buffer.from(require('@solana/web3.js').Keypair.generate().secretKey).toString('base64');
  const t = Usdc.stakeTargets();
  assert.strictEqual(t.decimals, 6);
  assert.strictEqual(t.usdcMint, MINT);
  assert.ok(t.escrowAta && t.escrowAta.length >= 32);
  assert.ok(t.escrowOwner && t.escrowOwner.length >= 32);
});
