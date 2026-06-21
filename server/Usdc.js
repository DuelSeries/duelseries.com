// USDC (SPL token) money layer — the USDC equivalent of Wallet.js's native-SOL functions.
// Built as a separate module so the live SOL path keeps working while this is developed + tested
// on devnet; the staking/cash-out endpoints get swapped over to it at cutover.
//
// Key differences from native SOL:
//   • Money lives in an Associated Token Account (ATA), not the wallet itself.
//   • Transfers are SPL token instructions (createTransferChecked), not SystemProgram.transfer.
//   • The escrow still needs a little SOL for tx fees + to create a recipient's ATA on cash-out.
//   • Amounts are integer base units (USDC has 6 decimals): 1 USDC = 1_000_000 units.
const {
  Connection, PublicKey, Keypair, Transaction,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync, createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction, getAccount,
} = require('@solana/spl-token');
const _bs58 = require('bs58');
const bs58  = (_bs58 && _bs58.default) ? _bs58.default : _bs58;

const NETWORK = process.env.SOLANA_NETWORK || 'mainnet-beta';
const RPC_URL = process.env.RPC_URL || (NETWORK === 'mainnet-beta'
  ? 'https://api.mainnet-beta.solana.com'
  : 'https://api.devnet.solana.com');
const connection = new Connection(RPC_URL, 'confirmed');

// USDC mint. Mainnet = Circle USDC; devnet defaults to Circle's devnet USDC. Override with
// USDC_MINT (e.g. point at a self-minted test token on devnet during development).
const USDC_MINT = new PublicKey(process.env.USDC_MINT || (NETWORK === 'mainnet-beta'
  ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'));
const USDC_DECIMALS = 6;
const toUnits = (usdc) => BigInt(Math.round(Number(usdc) * 1e6)); // USDC -> integer base units
const toUsdc  = (units) => Number(units) / 1e6;                   // base units -> USDC

let _escrowKp = null;
function escrowKeypair() {
  if (_escrowKp) return _escrowKp;
  const b64 = process.env.ESCROW_PRIVATE_KEY;
  if (!b64) throw new Error('ESCROW_PRIVATE_KEY not set');
  return (_escrowKp = Keypair.fromSecretKey(Buffer.from(b64, 'base64')));
}
function escrowPubkey() { return escrowKeypair().publicKey; }
function escrowAta()    { return getAssociatedTokenAddressSync(USDC_MINT, escrowPubkey()); }
// @solana/spl-token's getAccount throws TokenAccountNotFoundError when the ATA doesn't exist yet —
// and that error has an EMPTY .message, so we must match on .name (not just the message text).
function ataNotFound(e) {
  return !!e && (e.name === 'TokenAccountNotFoundError'
    || /could not find account|TokenAccountNotFound|account does not exist/i.test(e.message || ''));
}

// Retry transient RPC failures (429/5xx/timeouts) — mirrors Wallet.withRetry.
async function withRetry(fn, retries = 5, delay = 600) {
  try {
    return await fn();
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    const transient = /\b(429|502|503|504)\b|Too many|Service unavailable|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|timeout/i.test(msg);
    if (retries > 0 && transient) {
      await new Promise(r => setTimeout(r, delay));
      return withRetry(fn, retries - 1, Math.min(delay * 2, 8000));
    }
    throw e;
  }
}

// USDC balance (in USDC) of an owner's associated token account; 0 if the ATA doesn't exist yet.
async function usdcBalanceOf(ownerAddress) {
  const ata = getAssociatedTokenAddressSync(USDC_MINT, new PublicKey(ownerAddress));
  try {
    const acc = await withRetry(() => getAccount(connection, ata));
    return toUsdc(acc.amount);
  } catch (e) {
    if (ataNotFound(e)) return 0;
    throw e;
  }
}
async function escrowUsdcBalance() { return usdcBalanceOf(escrowPubkey().toString()); }

// What the client needs to build a stake (a USDC transfer into the escrow's ATA).
function stakeTargets() {
  return { escrowOwner: escrowPubkey().toString(), escrowAta: escrowAta().toString(), usdcMint: USDC_MINT.toString(), decimals: USDC_DECIMALS };
}

// Pure: how many base units `owner`'s holding of `mint` increased by in a tx, from the tx's
// recorded pre/post token balances. This is the security-critical parse (what we credit a
// staker), so it's a standalone testable function. Exported for unit tests.
function stakeDeltaUnits(meta, owner, mint) {
  const pick = (arr) => (arr || []).find(b => b && b.owner === owner && b.mint === mint);
  const pre  = BigInt((pick(meta && meta.preTokenBalances)  || { uiTokenAmount: { amount: '0' } }).uiTokenAmount.amount);
  const post = BigInt((pick(meta && meta.postTokenBalances) || { uiTokenAmount: { amount: '0' } }).uiTokenAmount.amount);
  return post - pre;
}

// Verify a stake tx actually credited the escrow's USDC ATA by >= minUsdc, by reading the token
// balance deltas the confirmed tx recorded. PURE read-only — one-time-use is enforced by the
// caller via db.markStakeSig. Returns { payer, usdc }.
async function verifyUsdcStake(signature, minUsdc) {
  if (typeof signature !== 'string' || !signature) throw new Error('Missing stake signature');
  const tx = await withRetry(() => connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }));
  if (!tx) throw new Error('Stake transaction not found or not yet confirmed');
  if (tx.meta && tx.meta.err) throw new Error('Stake transaction failed on-chain');
  const delta = stakeDeltaUnits(tx.meta, escrowPubkey().toString(), USDC_MINT.toString());
  const min = toUnits(minUsdc);
  if (delta < min) throw new Error(`Stake too small (${delta} < ${min} USDC units)`);
  const keys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
  return { payer: keys[0].toString(), usdc: toUsdc(delta) };
}

// Build + sign a USDC payout from escrow -> recipient, creating the recipient's ATA if missing
// (escrow pays that rent). Returns everything needed to broadcast AND recover it (same idempotent
// model as Wallet.buildSignedPayout — re-broadcasting the same bytes can only land once).
async function buildSignedUsdcPayout(toAddress, amountUsdc) {
  const escrow    = escrowKeypair();
  const recipient = new PublicKey(toAddress);
  const amount    = toUnits(amountUsdc);
  if (amount <= 0n) throw new Error('Payout amount must be positive');

  const fromAta = escrowAta();
  const toAta   = getAssociatedTokenAddressSync(USDC_MINT, recipient);

  const escAcc = await withRetry(() => getAccount(connection, fromAta));
  if (escAcc.amount < amount) throw new Error(`Escrow USDC too low (${escAcc.amount} < ${amount} units)`);

  const ixs = [];
  let toExists = true;
  try { await withRetry(() => getAccount(connection, toAta)); }
  catch (e) { if (ataNotFound(e)) toExists = false; else throw e; }
  if (!toExists) ixs.push(createAssociatedTokenAccountInstruction(escrow.publicKey, toAta, recipient, USDC_MINT));
  ixs.push(createTransferCheckedInstruction(fromAta, USDC_MINT, toAta, escrow.publicKey, amount, USDC_DECIMALS));

  const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash(), 8);
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = escrow.publicKey;
  tx.sign(escrow);
  const raw = tx.serialize();
  return { raw, signedTx: raw.toString('base64'), signature: bs58.encode(tx.signature), blockhash, lastValidBlockHeight };
}

// Inline cash-out payout (happy path). On failure attaches e.broadcast for the drainer, exactly
// like Wallet.withdraw, so the USDC payout queue can recover it idempotently.
async function withdrawUsdc(toAddress, amountUsdc) {
  const built = await buildSignedUsdcPayout(toAddress, amountUsdc);
  try {
    await withRetry(() => connection.sendRawTransaction(built.raw, { skipPreflight: false }), 6);
    await withRetry(() => connection.confirmTransaction({ signature: built.signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight }), 6);
    return built.signature;
  } catch (e) {
    e.broadcast = { signature: built.signature, signedTx: built.signedTx, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight };
    throw e;
  }
}

async function getLatestBlockhash() {
  const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash());
  return { blockhash, lastValidBlockHeight };
}

// true = confirmed, false = errored on-chain, null = not found / still pending.
async function signatureLanded(signature) {
  const st = await withRetry(() => connection.getSignatureStatus(signature, { searchTransactionHistory: true }));
  const v = st && st.value;
  if (!v) return null;
  if (v.err) return false;
  return (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized') ? true : null;
}

async function confirmSig(signature, lastValidBlockHeight, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const landed = await signatureLanded(signature);
    if (landed === true)  return true;
    if (landed === false) return false;
    try {
      const h = await withRetry(() => connection.getBlockHeight());
      if (lastValidBlockHeight && h > Number(lastValidBlockHeight)) return false; // expired, never landed
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

// Idempotent USDC payout for the drainer — identical guarantees to Wallet.attemptPayout: only
// ever re-broadcasts the SAME signed bytes (can't double-pay), builds a fresh tx only once the
// old one provably expired, and persists a fresh tx BEFORE sending via onFreshTx.
async function attemptPayout(row, onFreshTx) {
  if (row.signature) {
    const landed = await signatureLanded(row.signature);
    if (landed === true) return { paid: true, sig: row.signature };
    if (landed === null) {
      const height = await withRetry(() => connection.getBlockHeight());
      const lvbh   = Number(row.last_valid_block_height) || 0;
      if (row.signed_tx && lvbh && height <= lvbh) {
        try { await withRetry(() => connection.sendRawTransaction(Buffer.from(row.signed_tx, 'base64'), { skipPreflight: true }), 4); } catch (_) {}
        const ok = await confirmSig(row.signature, lvbh, 20);
        return ok ? { paid: true, sig: row.signature } : { paid: false };
      }
    }
  }
  const built = await buildSignedUsdcPayout(row.wallet_address, row.amount_sol);
  await onFreshTx({ signature: built.signature, signedTx: built.signedTx, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight });
  await withRetry(() => connection.sendRawTransaction(built.raw, { skipPreflight: false }), 6);
  const ok = await confirmSig(built.signature, built.lastValidBlockHeight);
  return ok ? { paid: true, sig: built.signature } : { paid: false };
}

module.exports = {
  connection, NETWORK, USDC_MINT, USDC_DECIMALS, toUnits, toUsdc, withRetry, ataNotFound,
  escrowKeypair, escrowPubkey, escrowAta, stakeTargets,
  usdcBalanceOf, escrowUsdcBalance, verifyUsdcStake, stakeDeltaUnits,
  buildSignedUsdcPayout, withdrawUsdc, attemptPayout, getLatestBlockhash,
};
