'use strict';
/* Night review 2026-10-29, finding 42: two payouts of the same amount to the same wallet, built on the same
   blockhash, were byte-identical (a transfer is only its recipient, lamports and blockhash, and ed25519 is
   deterministic), so the chain ran one and both were booked as paid: two paid tabs closed together got one refund,
   two equal rake sweeps moved one cut. Every payout now carries a random read-only reference key, so every build is
   its own transaction, while the transfer itself (program, data, from, to) is exactly what it was.

   Also here, finding 3's half in the money layer: Wallet.withdraw and Usdc.withdrawUsdc hand the signed bytes to
   opts.beforeSend before sending (the owed row saves them first), send nothing when it answers false, and report a
   confirmation with an on-chain error as a failure instead of a payout.

   The REAL builders run on a stubbed connection; nothing reaches a network. */
const test = require('node:test');
const assert = require('node:assert');
const { Keypair, PublicKey, Transaction, SystemProgram } = require('@solana/web3.js');
const { AccountLayout, ACCOUNT_SIZE, TOKEN_PROGRAM_ID } = require('@solana/spl-token');

// A throwaway escrow and an address that is never called, before the money modules load.
const escrow = Keypair.generate();
process.env.ESCROW_PRIVATE_KEY = Buffer.from(escrow.secretKey).toString('base64');
process.env.ESCROW_PUBLIC_KEY = '';
process.env.RPC_URL = 'https://rpc.invalid/never-called';
process.env.SOLANA_NETWORK = 'devnet';

const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const Wallet = require('../server/Wallet');
const Usdc = require('../server/Usdc');

const BLOCKHASH = Keypair.generate().publicKey.toBase58();   // one blockhash for every build: the collision case
const TO = Keypair.generate().publicKey;

function tokenAccount(owner, amount) {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({ mint: Usdc.USDC_MINT, owner, amount: BigInt(amount), delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 2039280, executable: false, rentEpoch: 0 };
}

// The chain: escrow is rich, every account exists, one fixed blockhash; sends are recorded.
function stubChain(conn, { confirmErr = null } = {}) {
  const sent = [];
  conn.getBalance = async () => 1_000 * 1e9;
  conn.getMinimumBalanceForRentExemption = async () => 890880;
  conn.getAccountInfo = async (addr) => tokenAccount(new PublicKey(addr), 1_000_000_000n);
  conn.getLatestBlockhash = async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1000 });
  conn.sendRawTransaction = async (raw) => { const sig = bs58.encode(Buffer.from(raw).subarray(1, 65)); sent.push(sig); return sig; };
  conn.confirmTransaction = async () => ({ context: { slot: 1 }, value: { err: confirmErr } });
  return { sent };
}

test('SOL: two payouts of one amount to one wallet on one blockhash are two different transactions', async () => {
  stubChain(Wallet.connection);
  const a = await Wallet.buildSignedPayout(TO.toBase58(), null, { lamports: 3_333_333 });
  const b = await Wallet.buildSignedPayout(TO.toBase58(), null, { lamports: 3_333_333 });
  assert.strictEqual(a.blockhash, b.blockhash);
  assert.notStrictEqual(a.signature, b.signature, 'distinct signatures, so the chain runs both');
  assert.notStrictEqual(a.signedTx, b.signedTx);
  for (const built of [a, b]) {
    const tx = Transaction.from(built.raw);
    assert.ok(tx.verifySignatures(), 'signed by the escrow');
    assert.ok(tx.feePayer.equals(escrow.publicKey));
    assert.strictEqual(tx.instructions.length, 1, 'still one instruction: no memo, no compute budget, same fee');
    const ix = tx.instructions[0];
    assert.ok(ix.programId.equals(SystemProgram.programId));
    // The transfer itself is byte for byte the plain SystemProgram.transfer of before.
    const plain = SystemProgram.transfer({ fromPubkey: escrow.publicKey, toPubkey: TO, lamports: 3_333_333 });
    assert.deepStrictEqual(Buffer.from(ix.data), Buffer.from(plain.data));
    assert.ok(ix.keys[0].pubkey.equals(escrow.publicKey) && ix.keys[0].isSigner && ix.keys[0].isWritable);
    assert.ok(ix.keys[1].pubkey.equals(TO) && ix.keys[1].isWritable);
    assert.strictEqual(ix.keys.length, 3);
    assert.strictEqual(ix.keys[2].isSigner, false, 'the reference never signs');
    assert.strictEqual(ix.keys[2].isWritable, false, 'and is never written');
    assert.ok(!ix.keys[2].pubkey.equals(escrow.publicKey) && !ix.keys[2].pubkey.equals(TO));
    assert.strictEqual(built.signature, bs58.encode(tx.signature), 'the saved signature is the signed bytes\' own');
  }
});

test('USDC: two payouts of one amount to one wallet on one blockhash are two different transactions', async () => {
  stubChain(Usdc.connection);
  const a = await Usdc.buildSignedUsdcPayout(TO.toBase58(), 0.45);
  const b = await Usdc.buildSignedUsdcPayout(TO.toBase58(), 0.45);
  assert.notStrictEqual(a.signature, b.signature);
  for (const built of [a, b]) {
    const tx = Transaction.from(built.raw);
    assert.ok(tx.verifySignatures());
    const ix = tx.instructions[tx.instructions.length - 1];
    assert.ok(ix.programId.equals(TOKEN_PROGRAM_ID));
    assert.strictEqual(ix.keys.length, 5, 'source, mint, destination, owner, then the reference');
    assert.ok(ix.keys[3].pubkey.equals(escrow.publicKey) && ix.keys[3].isSigner, 'the escrow still signs as the owner');
    assert.strictEqual(ix.keys[4].isSigner, false);
    assert.strictEqual(ix.keys[4].isWritable, false);
  }
});

test('the drainer re-sends a saved payout byte for byte: a retry is never a new transaction', async () => {
  const chain = stubChain(Wallet.connection);
  const built = await Wallet.buildSignedPayout(TO.toBase58(), null, { lamports: 1_000_000 });
  Wallet.connection.getBlockHeight = async () => 10;
  let rebuilt = 0;
  const row = { id: 1, wallet_address: TO.toBase58(), amount_sol: 0.1, signature: built.signature, signed_tx: built.signedTx,
                last_valid_block_height: built.lastValidBlockHeight };
  const once = async () => { rebuilt++; return true; };
  // Saved, still valid and not seen yet: the SAME bytes go out again, and land once sent.
  Wallet.connection.getSignatureStatus = async (sig) => ({ value: chain.sent.includes(sig) ? { confirmationStatus: 'confirmed', err: null } : null });
  const r = await Wallet.attemptPayout(row, once, () => 1_000_000);
  assert.deepStrictEqual(r, { paid: true, sig: built.signature });
  assert.deepStrictEqual(chain.sent, [built.signature], 'the saved bytes, not a fresh build');
  assert.strictEqual(rebuilt, 0);
});

for (const [mode, conn, pay] of [
  ['SOL', () => Wallet.connection, (b) => Wallet.withdraw(TO.toBase58(), null, { lamports: 2_000_000, beforeSend: b })],
  ['USDC', () => Usdc.connection, (b) => Usdc.withdrawUsdc(TO.toBase58(), 0.2, { beforeSend: b })],
]) {
  test(`${mode} withdraw: the signed bytes are handed to beforeSend before anything is sent`, async () => {
    const chain = stubChain(conn());
    const seen = [];
    const sig = await pay(async (b) => { seen.push({ ...b, sentSoFar: chain.sent.length }); return true; });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].sentSoFar, 0, 'saved first, sent after');
    assert.strictEqual(seen[0].signature, sig);
    assert.deepStrictEqual(chain.sent, [sig]);
    assert.strictEqual(bs58.encode(Buffer.from(seen[0].signedTx, 'base64').subarray(1, 65)), sig, 'the saved bytes are the sent bytes');
    assert.ok(seen[0].blockhash && seen[0].lastValidBlockHeight);
  });

  test(`${mode} withdraw: beforeSend answering false (another attempt saved its own tx) or throwing sends nothing`, async () => {
    const chain = stubChain(conn());
    await assert.rejects(pay(async () => false), (e) => e.code === Wallet.PAYOUT_SUPERSEDED && !e.broadcast);
    await assert.rejects(pay(async () => { throw new Error('db down'); }), /db down/);
    assert.deepStrictEqual(chain.sent, []);
  });

  test(`${mode} withdraw: a confirmation reporting an on-chain error is a failed payout, with its bytes for the drainer`, async () => {
    stubChain(conn(), { confirmErr: { InstructionError: [0, 'Custom'] } });
    await assert.rejects(pay(undefined), (e) => /failed on-chain/.test(e.message) && !!(e.broadcast && e.broadcast.signature));
  });
}

test('without beforeSend the inline payout is exactly as before', async () => {
  const chain = stubChain(Wallet.connection);
  const sig = await Wallet.withdraw(TO.toBase58(), null, { lamports: 2_000_000 });
  assert.deepStrictEqual(chain.sent, [sig]);
});
