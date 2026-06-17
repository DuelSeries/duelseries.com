const {
  Connection, PublicKey, Keypair,
  Transaction, SystemProgram, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');

const NETWORK = process.env.SOLANA_NETWORK || 'mainnet-beta';
const RPC_URL = process.env.RPC_URL || (
  NETWORK === 'mainnet-beta'
    ? 'https://api.mainnet-beta.solana.com'
    : 'https://api.devnet.solana.com'
);

const connection = new Connection(RPC_URL, 'confirmed');
// Log which RPC is active (host only — never the API key) so a deploy can confirm it's
// using a dedicated provider (e.g. helius) and not the rate-limited public endpoint.
try { console.log(`[WALLET] RPC endpoint: ${new URL(RPC_URL).host}`); } catch (_) {}

function getEscrowKeypair() {
  const b64 = process.env.ESCROW_PRIVATE_KEY;
  if (!b64) throw new Error('ESCROW_PRIVATE_KEY not set');
  return Keypair.fromSecretKey(Buffer.from(b64, 'base64'));
}

function getEscrowPublicKey() {
  return process.env.ESCROW_PUBLIC_KEY || getEscrowKeypair().publicKey.toString();
}

// In-memory cache of used sigs — DB is the source of truth
const usedSignatures = new Set();
let db = null;
function setDb(dbModule) { db = dbModule; }

// On startup, mark all existing escrow transactions as seen so old
// deposits aren't re-credited after a database reset or server restart.
async function seedUsedSignatures() {
  try {
    const escrow = new PublicKey(getEscrowPublicKey());
    const sigs = await withRetry(() =>
      connection.getSignaturesForAddress(escrow, { limit: 100 })
    );
    for (const s of sigs) usedSignatures.add(s.signature);
    console.log(`[WALLET] Seeded ${sigs.length} existing signatures`);
  } catch (e) {
    console.error('[WALLET] Seed failed:', e.message);
  }
}

// Retry wrapper for transient RPC failures — public/free RPCs frequently return 429
// (rate limit) AND 503/502/504 (overloaded), plus the odd network blip. All of these
// resolve on a retry, so back off and try again rather than failing the user's stake/cashout.
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

// Send SOL from escrow to a user wallet
async function withdraw(toAddress, amountSol) {
  const escrow = getEscrowKeypair();
  const toPubkey = new PublicKey(toAddress);
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  // Ensure escrow keeps enough for rent-exempt minimum + tx fee
  const [escrowBalance, rentMin] = await Promise.all([
    withRetry(() => connection.getBalance(escrow.publicKey)),
    withRetry(() => connection.getMinimumBalanceForRentExemption(0)),
  ]);
  const feeBuffer = 10000; // ~0.00001 SOL for tx fee
  const maxWithdrawable = escrowBalance - rentMin - feeBuffer;

  if (maxWithdrawable <= 0) throw new Error('Escrow has insufficient funds');
  if (lamports > maxWithdrawable) {
    throw new Error(
      `Amount too large. Max withdrawable: ${(maxWithdrawable / LAMPORTS_PER_SOL).toFixed(4)} SOL`
    );
  }

  const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash());
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: escrow.publicKey,
      toPubkey,
      lamports,
    })
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = escrow.publicKey;
  tx.sign(escrow);

  const signature = await withRetry(() => connection.sendRawTransaction(tx.serialize()));
  await withRetry(() => connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }));
  return signature;
}

async function getEscrowBalance() {
  const bal = await withRetry(() => connection.getBalance(new PublicKey(getEscrowPublicKey())));
  return bal / LAMPORTS_PER_SOL;
}

// Phase 1 (self-custody): verify a player's stake transfer actually landed in the escrow.
// PURE read-only check: the tx must be confirmed and have credited the escrow at least
// `minLamports`. Returns { payer, lamports }. One-time-use is enforced atomically by the
// caller via db.markStakeSig (the DB is the source of truth) — NOT here — so a transient
// verify failure can never strand a valid stake by marking its sig "used" in memory.
async function verifyStakeTransfer(signature, minLamports) {
  if (typeof signature !== 'string' || !signature) throw new Error('Missing stake signature');
  const escrowPubkey = getEscrowPublicKey();
  const tx = await withRetry(() =>
    connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  );
  if (!tx) throw new Error('Stake transaction not found or not yet confirmed');
  if (tx.meta && tx.meta.err) throw new Error('Stake transaction failed on-chain');
  const accountKeys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
  const idx = accountKeys.findIndex(k => k.toString() === escrowPubkey);
  if (idx === -1) throw new Error('Stake did not pay the escrow');
  const lamports = tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
  if (lamports < minLamports) throw new Error(`Stake too small (${lamports} < ${minLamports} lamports)`);
  return { payer: accountKeys[0].toString(), lamports };
}

async function getLatestBlockhash() {
  const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash());
  return { blockhash, lastValidBlockHeight };
}

// Forward a JSON-RPC request to the server's Solana RPC so the BROWSER can make RPC calls
// via our backend instead of hitting a public RPC that 403s browser origins.
async function forwardRpc(body) {
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await r.text();
}

// Submit a client-signed stake transaction and wait for it to confirm via HTTP polling
// (no WebSocket — browsers can't reach the public RPC's WSS). Returns the signature.
async function submitStake(rawTx) {
  const sig = await connection.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 5 });
  for (let i = 0; i < 40; i++) {
    const st = await connection.getSignatureStatus(sig);
    const v = st && st.value;
    if (v) {
      if (v.err) throw new Error('Stake transaction failed on-chain');
      if (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized') return sig;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('Stake not confirmed in time — please try again');
}

async function getAddressBalance(address) {
  return (await connection.getBalance(new PublicKey(address))) / LAMPORTS_PER_SOL;
}

// Diagnose WHERE deposited SOL actually is. Withdrawals pay FROM the address derived
// from ESCROW_PRIVATE_KEY; sweeps send deposits TO getEscrowPublicKey() (= ESCROW_PUBLIC_KEY
// if set, else the same keypair). If those differ, deposits accumulate at `sweepsGoTo`
// while withdrawals fail from an empty `withdrawsPayFrom` — the classic env misconfig.
async function getEscrowDiagnostics() {
  const withdrawsPayFrom = getEscrowKeypair().publicKey.toString();
  const sweepsGoTo       = getEscrowPublicKey();
  const [payFromBal, sweepBal] = await Promise.all([
    getAddressBalance(withdrawsPayFrom),
    getAddressBalance(sweepsGoTo),
  ]);
  return {
    network: NETWORK,
    withdrawsPayFrom, withdrawWalletBalanceSol: payFromBal,
    sweepsGoTo,       sweepWalletBalanceSol:    sweepBal,
    addressesMatch:   withdrawsPayFrom === sweepsGoTo,
  };
}

async function getRecentSigs() {
  const escrow = new PublicKey(getEscrowPublicKey());
  const sigs = await withRetry(() =>
    connection.getSignaturesForAddress(escrow, { limit: 10 })
  );
  return sigs.map(s => ({
    sig: s.signature.slice(0, 16) + '...',
    err: s.err,
    blockTime: s.blockTime,
    used: usedSignatures.has(s.signature),
  }));
}

module.exports = { getEscrowPublicKey, getRecentSigs, withdraw, getEscrowBalance, getAddressBalance, getEscrowDiagnostics, verifyStakeTransfer, getLatestBlockhash, forwardRpc, submitStake, NETWORK, setDb, seedUsedSignatures };
