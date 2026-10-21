'use strict';
// The Bot bank wallet in SOL mode (server/botWallet.js): the bank is the wallet's SOL above its 0.003 SOL reserve,
// counted in micro-dollars at the price now; a seed going in rounds up, unspent seed going home rounds down.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Keypair, Transaction, SystemProgram, PublicKey } = require('@solana/web3.js');
const { createBotWallet, SOL_RESERVE } = require('../server/botWallet');

function fakeUsdc(balances, escrow) {
  const connection = {
    async getBalance(pk) { return balances[pk.toString()] || 0; },
    async getTokenAccountBalance() { throw new Error('a SOL-mode bank never reads USDC'); },
    async getLatestBlockhash() { return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 50 }; },
  };
  return { connection, USDC_MINT: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), USDC_DECIMALS: 6,
           escrowKeypair: () => escrow, withRetry: (fn) => fn() };
}
function transferOf(raw) {
  const tx = Transaction.from(Buffer.from(raw, 'base64'));
  const ix = tx.instructions.find((i) => i.programId.equals(SystemProgram.programId));
  const d = Buffer.from(ix.data);
  return { from: ix.keys[0].pubkey.toString(), to: ix.keys[1].pubkey.toString(), lamports: Number(d.readBigUInt64LE(4)), payer: tx.feePayer.toString() };
}

test('SOL mode: balance above the reserve in micro-dollars, seeds in round up, seeds home round down', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botw-'));
  const escrow = Keypair.generate();
  const balances = {};
  let rate = 100;
  const w = createBotWallet({ dataDir: dir, Usdc: fakeUsdc(balances, escrow), log: { warn() {} }, mode: 'sol', usdPerSol: () => rate });
  balances[w.address] = SOL_RESERVE + 52_345_678;
  assert.strictEqual(w.usdcMicro(), null);             // not read yet: never "empty"
  await w.refresh();
  assert.strictEqual(w.usdcMicro(), 5_234_567);          // 0.052345678 SOL at $100, rounded down
  const inn = transferOf((await w.build('in', 500_000)).raw);
  assert.deepStrictEqual(inn, { from: w.address, to: escrow.publicKey.toString(), lamports: 5_000_000, payer: w.address });
  rate = 107.58325494585523;
  const up = transferOf((await w.build('in', 500_000)).raw).lamports;
  const down = transferOf((await w.build('out', 500_000)).raw);
  assert.ok(up >= down.lamports && up - down.lamports <= 1);
  assert.deepStrictEqual([down.from, down.to, down.payer], [escrow.publicKey.toString(), w.address, escrow.publicKey.toString()]);
  rate = null;
  const noPrice = createBotWallet({ dataDir: dir, Usdc: fakeUsdc(balances, escrow), log: { warn() {} }, mode: 'sol',
    usdPerSol: () => { throw Object.assign(new Error('no price'), { code: 'payout-wait' }); } });
  await noPrice.refresh();
  assert.strictEqual(noPrice.usdcMicro(), null);
  await assert.rejects(noPrice.build('in', 500_000), /no price/);
  balances[w.address] = SOL_RESERVE - 1;
  await w.refresh();
  rate = 100;
  assert.strictEqual(w.usdcMicro(), 0);
  assert.throws(() => createBotWallet({ dataDir: dir, Usdc: fakeUsdc(balances, escrow), mode: 'sol' }), /needs a price/);
});
