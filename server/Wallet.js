const {
  Connection, PublicKey, Keypair,
  Transaction, SystemProgram, LAMPORTS_PER_SOL, VersionedTransaction, SendTransactionError,
} = require('@solana/web3.js');
const crypto = require('crypto');
const { ed25519 } = require('@noble/curves/ed25519');
// bs58 to compute a tx's signature string BEFORE broadcasting it. v6 is ESM-first and exposes
// its API under `.default` in CJS, so unwrap defensively (works whichever shape ships).
const _bs58 = require('bs58');
const bs58  = (_bs58 && _bs58.default) ? _bs58.default : _bs58;

const NETWORK = process.env.SOLANA_NETWORK || 'mainnet-beta';
const RPC_URL = process.env.RPC_URL || (
  NETWORK === 'mainnet-beta'
    ? 'https://api.mainnet-beta.solana.com'
    : 'https://api.devnet.solana.com'
);

// Keep-alive HTTPS agent — see the note in Usdc.js. Without socket reuse every
// RPC call pays a fresh TLS handshake, which is synchronous crypto on the same
// core that runs the simulation.
const _https = require('https');
const rpcAgent = new _https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 16 });
const connection = new Connection(RPC_URL, { commitment: 'confirmed', httpAgent: rpcAgent });
// Log which RPC is active (host only — never the API key) so a deploy can confirm it's
// using a dedicated provider (e.g. helius) and not the rate-limited public endpoint.
try { console.log(`[WALLET] RPC endpoint: ${new URL(RPC_URL).host}`); } catch (_) {}
/* PUBLIC_RPC_URL (night review 2026-10-29, third pass, findings 1, 2 and 22): the key for the reads any visitor can
   cause, the /api/rpc relay and /api/sol-balance here, the Wallet tab's history and the balance's USDC in Usdc.js.
   The server-wide budgets (server/rpcBudget.js) hold those to a rate, which protects the key's per-second limit but
   not its month: a flood held at the rate all month still spends credits. Set to a second key (another Helius
   project or plan; https, like RPC_URL), strangers can only ever spend that one, and stake verifies, submits,
   payouts, the drainer, the sweeps and a send's blockhash keep RPC_URL's credits to themselves. Unset, it is
   RPC_URL and nothing changes. */
/* Fourth pass (night review 2026-10-29): /api/sol-balance's SOL read has a Connection of its own that never resends a
   429 by itself, even on the money key's URL. It was `connection` while PUBLIC_RPC_URL was unset, and web3.js resends a
   throttled call up to 5 times inside one call, where no budget sees it, so a budgeted balance became about six
   getBalance calls at a key already throttled. One request now; the route answers a failed read from the last one.
   Stakes, payouts and the escrow's balances keep `connection` and its retries. */
const PUBLIC_RPC_URL = process.env.PUBLIC_RPC_URL || RPC_URL;
const publicConnection = new Connection(PUBLIC_RPC_URL, { commitment: 'confirmed', httpAgent: rpcAgent, disableRetryOnRateLimit: true });
if (PUBLIC_RPC_URL !== RPC_URL) { try { console.log(`[WALLET] public reads RPC endpoint: ${new URL(PUBLIC_RPC_URL).host}`); } catch (_) {} }

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

// Build + sign an escrow→wallet transfer, returning everything needed to broadcast it AND to
// recover it later. The signature is deterministic from the signed bytes, so re-broadcasting
// the SAME bytes can only ever land ONCE — that property is what makes payout retries safe from
// double-paying. (Payouts are money-critical, so the reads here retry harder than the default.)
// opts.lamports (SOL mode, server/money.js): the exact integer amount, already converted from dollars, used
// instead of amountSol so no float round trip can move it by a lamport.
/* Every payout transaction is its own (night review 2026-10-29, finding 42). A transfer is only its recipient, its
   lamports and its blockhash, and an ed25519 signature is deterministic, so two payouts of the same amount to the same
   wallet built on the same blockhash (two paid tabs closed together, two equal rake sweeps) were the SAME bytes with
   the SAME signature: the chain ran it once and both were booked as paid. A random read-only, non-signer reference key
   on the transfer (the way Solana Pay marks its transfers; the System and Token programs ignore extra accounts) makes
   every build different. No memo and no compute-budget change, so the fee, the compute and what the wallet shows are
   as before. Re-sending a SAVED transaction re-sends its saved bytes, so the drainer's idempotency is unchanged. */
function payoutReference() {
  return { pubkey: new PublicKey(crypto.randomBytes(32)), isSigner: false, isWritable: false };
}
async function buildSignedPayout(toAddress, amountSol, opts) {
  const escrow   = getEscrowKeypair();
  const toPubkey = new PublicKey(toAddress);
  const exact    = opts && opts.lamports;
  const lamports = exact !== undefined && exact !== null ? Number(exact) : Math.floor(amountSol * LAMPORTS_PER_SOL);
  if (!Number.isSafeInteger(lamports) || lamports < 1) throw new Error('Payout amount is not a positive number of lamports');

  const [escrowBalance, rentMin] = await Promise.all([
    withRetry(() => connection.getBalance(escrow.publicKey), 8),
    withRetry(() => connection.getMinimumBalanceForRentExemption(0), 8),
  ]);
  const maxWithdrawable = escrowBalance - rentMin - 10000; // keep rent-exempt min + ~tx fee
  /* Nothing signed in either case, so both wait in the drainer's slow lane (PAYOUT_WAIT) instead of using up its
     attempt budget and silently dropping out of the queue while the escrow is topped up (Fable review 2026-10-21). */
  if (maxWithdrawable <= 0) throw Object.assign(new Error('Escrow has insufficient funds'), { code: PAYOUT_WAIT });
  if (lamports > maxWithdrawable) {
    throw Object.assign(new Error(`Amount too large. Max withdrawable: ${(maxWithdrawable / LAMPORTS_PER_SOL).toFixed(4)} SOL`), { code: PAYOUT_WAIT });
  }
  /* A transfer under the rent-exempt minimum to an address with nothing on it fails on-chain (the new account
     could not exist) and still costs the escrow its fee, every retry. Refused here, before anything is signed,
     with the drainer's wait code so the owed row waits in the slow lane until the wallet holds some SOL. */
  if (lamports < rentMin) {
    const toBal = await withRetry(() => connection.getBalance(toPubkey), 8);
    if (!(toBal > 0)) {
      const e = new Error(`Payout of ${lamports} lamports waits: the receiving wallet is empty and it is under the ${rentMin} lamport minimum`);
      e.code = PAYOUT_WAIT;
      throw e;
    }
  }

  const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash(), 8);
  const transfer = SystemProgram.transfer({ fromPubkey: escrow.publicKey, toPubkey, lamports });
  transfer.keys.push(payoutReference());
  const tx = new Transaction().add(transfer);
  tx.recentBlockhash = blockhash;
  tx.feePayer = escrow.publicKey;
  tx.sign(escrow);
  const raw = tx.serialize();
  const signature = bs58.encode(tx.signature); // == what sendRawTransaction will return
  return { raw, signedTx: raw.toString('base64'), signature, blockhash, lastValidBlockHeight };
}

// true = confirmed on-chain, false = errored on-chain, null = not found / still pending.
async function signatureLanded(signature) {
  const st = await withRetry(() => connection.getSignatureStatus(signature, { searchTransactionHistory: true }));
  const v = st && st.value;
  if (!v) return null;
  if (v.err) return false;
  return (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized') ? true : null;
}

// Poll a signature until it confirms or its blockhash expires. Returns true if it confirmed.
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

// Inline cash-out payout (happy path). On any failure it attaches `e.broadcast` — the exact
// signed bytes + signature — so the drainer can finish this same payout idempotently.
/* opts.beforeSend(broadcast) (night review 2026-10-29, finding 3; server/inlinePayout.js): awaited with the signed
   bytes BEFORE anything is sent, so the owed row the caller wrote first holds them. It is the drainer's
   compare-and-set (db.savePayoutSignature): false means another attempt saved its own transaction for that row, and
   this one is dropped unsent; a throw sends nothing either. A confirmation that reports an on-chain error is a failed
   payout (it used to read as paid), so the drainer builds it again. */
async function withdraw(toAddress, amountSol, opts) {
  const built = await buildSignedPayout(toAddress, amountSol, opts);
  const beforeSend = opts && typeof opts.beforeSend === 'function' ? opts.beforeSend : null;
  if (beforeSend) {
    const saved = await beforeSend({ signature: built.signature, signedTx: built.signedTx, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight });
    if (saved === false) {
      const e = new Error('another attempt saved its own transaction for this payout first; nothing sent');
      e.code = PAYOUT_SUPERSEDED;
      throw e;
    }
  }
  try {
    await withRetry(() => connection.sendRawTransaction(built.raw, { skipPreflight: false }), 6);
    const c = await withRetry(() => connection.confirmTransaction({ signature: built.signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight }), 6);
    if (c && c.value && c.value.err) throw new Error('Payout transaction failed on-chain: ' + JSON.stringify(c.value.err));
    return built.signature;
  } catch (e) {
    e.broadcast = { signature: built.signature, signedTx: built.signedTx, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight };
    throw e;
  }
}

// Idempotent payout attempt for the background drainer. NEVER double-pays:
//   • if the recorded tx already landed → reports paid, sends nothing;
//   • if it's still within its validity window → re-broadcasts the SAME bytes (same signature,
//     so it can only land once) and tries to confirm;
//   • only once that tx has provably expired without landing does it build a FRESH one.
// onFreshTx(broadcast) is awaited the instant a new tx is built — BEFORE it's sent — so the
// signature is saved first and a crash mid-send can never strand an un-tracked transfer.
// onFreshTx is a compare-and-set (db.savePayoutSignature): when it answers false another attempt
// saved its own tx for this row first, and this fresh one is dropped unsent (Usdc.js has the same).
const PAYOUT_SUPERSEDED = 'payout-superseded';
// "Nothing was signed; try this row again later" (no SOL price, or an empty wallet under the rent minimum).
// The drainer moves such a row to its slow lane (server/payoutDrainer.js noAccountCode). Same string as
// server/solPrice.js PRICE_WAIT.
const PAYOUT_WAIT = 'payout-wait';
// lamportsFor(row) (SOL mode): the exact lamports for a FRESH build only, so a row whose saved transaction is
// still valid or already landed is settled without needing a price at all.
async function attemptPayout(row, onFreshTx, lamportsFor) {
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
      // expired & never landed → fall through to a fresh build
    }
    // landed === false (errored on-chain) → build fresh
  }
  const opts = typeof lamportsFor === 'function' ? { lamports: lamportsFor(row) } : undefined;
  const built = await buildSignedPayout(row.wallet_address, row.amount_sol, opts);
  const saved = await onFreshTx({ signature: built.signature, signedTx: built.signedTx, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight });
  if (saved === false) {
    const e = new Error('another attempt saved its own transaction for this payout first; nothing sent');
    e.code = PAYOUT_SUPERSEDED;
    throw e;
  }
  await withRetry(() => connection.sendRawTransaction(built.raw, { skipPreflight: false }), 6);
  const ok = await confirmSig(built.signature, built.lastValidBlockHeight);
  return ok ? { paid: true, sig: built.signature } : { paid: false };
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
  // blockhash: which stake quote this payment was built from (SOL mode prices it at that quote's rate, money.js)
  // blockTime: when it landed (seconds), so the late-stake sweep can refuse a transaction that was on the chain
  // before its pending-verify row existed (night review 2026-10-29, finding 0; index.js owedForLateStake)
  return { payer: accountKeys[0].toString(), lamports, blockhash: tx.transaction.message.recentBlockhash,
           blockTime: tx.blockTime == null ? null : Number(tx.blockTime) };
}

async function getLatestBlockhash() {
  const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash());
  return { blockhash, lastValidBlockHeight };
}

/* Forward a JSON-RPC request to the server's Solana RPC so the BROWSER can make RPC calls via our
   backend instead of hitting a public RPC that 403s browser origins.

   It relays to our PAID provider key, from an unauthenticated route, so it is not an open relay
   (security review 2026-10-15, "open Helius relay"): one request per call (a JSON-RPC batch array
   is refused: one 100 kB body used to fan out into hundreds of billed calls), and only the methods
   the wallet widget's Privy SDK (@solana/kit, wallet-widget/src/main.jsx) actually calls, plus a
   few cheap reads of the same kind. Read off the built widget (public/wallet/widget.js): balances
   and token accounts (getBalance, getTokenAccountsByOwner, getAccountInfo, getMultipleAccounts),
   building and sending a transfer (getLatestBlockhash, getFeeForMessage, simulateTransaction,
   sendTransaction, getGenesisHash), confirming it (getSignatureStatuses, getEpochInfo,
   getBlockHeight, getSlot, getTransaction). The widget sends no batches. Anything that enumerates
   the chain or returns blocks (getProgramAccounts, getBlock, getBlocks, getSignaturesForAddress,
   getLargestAccounts, getSupply, ...) is refused. The forwarded body is rebuilt from the four
   JSON-RPC fields, the provider gets 10 s, and a reply over 2 MB is dropped rather than held in
   memory. */
const RPC_RELAY_METHODS = new Set([
  'getAccountInfo', 'getBalance', 'getBlockHeight', 'getEpochInfo', 'getFeeForMessage',
  'getGenesisHash', 'getHealth', 'getLatestBlockhash', 'getMinimumBalanceForRentExemption',
  'getMultipleAccounts', 'getRecentPrioritizationFees', 'getSignatureStatuses', 'getSlot',
  'getTokenAccountBalance', 'getTokenAccountsByOwner', 'getTokenSupply', 'getTransaction',
  'getVersion', 'isBlockhashValid', 'sendTransaction', 'simulateTransaction',
]);
const RPC_RELAY_TIMEOUT_MS = 10_000;
const RPC_RELAY_MAX_BYTES = 2 * 1024 * 1024;

// null when `body` may be relayed, otherwise why not (the route answers 400 with it).
function rpcRequestError(body) {
  if (Array.isArray(body)) return 'Batch requests are not supported';
  if (!body || typeof body !== 'object' || Buffer.isBuffer(body)) return 'Not a JSON-RPC request';
  if (typeof body.method !== 'string' || !RPC_RELAY_METHODS.has(body.method)) return 'RPC method not allowed';
  if (body.params !== undefined && !Array.isArray(body.params)) return 'Not a JSON-RPC request';
  const id = body.id;
  if (id !== undefined && id !== null && typeof id !== 'number' && !(typeof id === 'string' && id.length <= 64)) {
    return 'Not a JSON-RPC request';
  }
  return null;
}

function relayError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function forwardRpc(body) {
  const bad = rpcRequestError(body);
  if (bad) throw relayError(bad, 400);
  const payload = { jsonrpc: '2.0', id: body.id === undefined ? null : body.id, method: body.method };
  if (body.params !== undefined) payload.params = body.params;
  const r = await fetch(PUBLIC_RPC_URL, {   // a visitor's call: the public key when there is one (night review 2026-10-29)
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(RPC_RELAY_TIMEOUT_MS),
  });
  const declared = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > RPC_RELAY_MAX_BYTES) {
    try { if (r.body && typeof r.body.cancel === 'function') await r.body.cancel(); } catch (_) {}
    throw relayError('RPC reply too large', 502);
  }
  if (!r.body || typeof r.body.getReader !== 'function') {
    const text = await r.text();
    if (Buffer.byteLength(text) > RPC_RELAY_MAX_BYTES) throw relayError('RPC reply too large', 502);
    return text;
  }
  // Read it in chunks and stop at the cap, so a huge reply is never buffered whole.
  const reader = r.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RPC_RELAY_MAX_BYTES) {
      try { await reader.cancel(); } catch (_) {}
      throw relayError('RPC reply too large', 502);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

/* What a client-signed stake transaction says about itself, read from its own bytes before
   anything is sent (security review 2026-10-15, findings 3 and 5): its signature (the tx id, the
   fee payer's signature, which is exactly what sendRawTransaction returns), its fee payer (the
   wallet a stake is owed to; the verifier reads the same key off the landed tx) and its
   blockhash (the tx can land only while that is valid). The fee payer's signature over the
   message is checked here, so only bytes the payer really signed can ever claim a stake row.
   Throws on anything that is not such a transaction. */
function stakeTxInfo(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || []);
  let tx;
  try { tx = VersionedTransaction.deserialize(bytes); } catch (_) { throw new Error('Not a signed transaction'); }
  const n = tx.signatures.length;
  const sig = tx.signatures[0];
  const keys = tx.message.staticAccountKeys;
  if (!n || !sig || sig.length !== 64 || !keys || !keys.length) throw new Error('Not a signed transaction');
  // The signed message is everything after the compact-u16 signature count and the signatures.
  const message = bytes.subarray((n < 0x80 ? 1 : n < 0x4000 ? 2 : 3) + 64 * n);
  // Strict (RFC 8032) like the chain's own check, so a re-encoded copy of a real signature, which
  // the chain would refuse anyway, is refused here too.
  let ok = false;
  try { ok = ed25519.verify(sig, message, keys[0].toBytes(), { zip215: false }); } catch (_) { ok = false; }
  if (!ok) throw new Error('Stake transaction is not signed by its payer');
  return { signature: bs58.encode(sig), payer: keys[0].toBase58(), blockhash: tx.message.recentBlockhash };
}

/* Submit a client-signed transaction and wait for it to confirm via HTTP polling (no WebSocket;
   browsers can't reach the public RPC's WSS). Returns the signature.

   opts.beforeSend(info) (the stake route): awaited with stakeTxInfo(rawTx) BEFORE anything is
   sent. The route records the stake's pending-verify row there, keyed by the signature, so a
   second submit of the same bytes is refused before it reaches the chain and a stake that lands
   after this request has failed is still found and refunded (stakeLedger.sweep). If it throws,
   nothing is sent. /api/broadcast passes no opts and is unchanged.

   A read that fails while polling is not a failed transaction: the poll keeps going, bounded by
   40 looks and 45 s, instead of reporting a stake that may still land as failed.

   A first send the node refused at preflight throws with e.stakeUnsent = true (night review
   2026-10-29, finding 23): the node did not forward the bytes, and this server is the only sender
   (the widget signs only), so they can never land and the route closes their pending-verify row at
   once instead of leaving it for the sweep. */
async function submitStake(rawTx, opts) {
  /* Bytes of one transaction or nothing (night review 2026-10-29): a Solana transaction is at most
     1232 bytes (PACKET_DATA_SIZE), so anything else is refused before it is encoded or sent, and
     no caller can hand the RPC client a 100 MB buffer to copy on the game thread again. */
  if (!(rawTx instanceof Uint8Array) || rawTx.length === 0 || rawTx.length > 1232) throw new Error('Not a signed transaction');
  const beforeSend = opts && typeof opts.beforeSend === 'function' ? opts.beforeSend : null;
  let info = null;
  if (beforeSend) {
    info = stakeTxInfo(rawTx);
    await beforeSend(info);
  }
  let sig;
  try {
    sig = await connection.sendRawTransaction(rawTx, { skipPreflight: false, maxRetries: 5 });
  } catch (e) {
    if (info && preflightRefused(e)) e.stakeUnsent = true;
    throw e;
  }
  if (info && sig !== info.signature) throw new Error('Stake signature mismatch');
  const deadline = Date.now() + 45_000;
  for (let i = 0; i < 40 && Date.now() < deadline; i++) {
    // The same signed bytes again every few looks: a copy a leader dropped gets another chance
    // before its blockhash runs out. Same signature, so it can only ever land once.
    if (i > 0 && i % 3 === 0) {
      connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
    let v = null;
    try {
      const st = await connection.getSignatureStatus(sig);
      v = st && st.value;
    } catch (_) {
      v = null;                 // a failed read, not a failed transaction: look again
    }
    if (v) {
      if (v.err) throw new Error('Stake transaction failed on-chain');
      if (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized') return sig;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('Stake not confirmed in time — please try again');
}

/* A send the node provably did not forward: with preflight on, a JSON-RPC error comes back as a
   SendTransactionError 'Simulation failed', and the node's preflight refusal reads 'Transaction
   simulation failed: ...' (a dead blockhash, an empty payer, a failing instruction) or 'Transaction
   signature verification failure'; the node answers either before it forwards anything. Never
   'already been processed': those bytes DID land through someone else, and their row stays for the
   sweep. Every other error (a timeout, a 429, a reset, a node that is behind) also stays, as before.
   (night review 2026-10-29, finding 23) */
function preflightRefused(e) {
  if (!(e instanceof SendTransactionError)) return false;
  const m = String((e && e.message) || '');
  const why = String((e && e.transactionMessage) || '');
  if (!/^Simulation failed/.test(m)) return false;
  if (/already been processed|AlreadyProcessed/i.test(m + ' ' + why)) return false;
  return /Transaction simulation failed|signature verification failure/i.test(why);
}

/* For the pending-verify sweep (stakeLedger): what the chain says about a stake signature.
   'landed' (confirmed, no error), 'failed' (landed with an error: nothing moved but the fee), or
   'seen' (processed only, still settling: never expire it), or null (not seen yet). History is searched, so an old landing is found. */
async function stakeSigStatus(signature) {
  const st = await withRetry(() => connection.getSignatureStatus(signature, { searchTransactionHistory: true }));
  const v = st && st.value;
  if (!v) return null;
  if (v.err) return 'failed';
  // 'seen': on the chain at 'processed' only. Not landed yet, but not gone either: never expire it.
  return (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized') ? 'landed' : 'seen';
}

/* Whether a transaction with this blockhash can still land. Asked at 'finalized': a blockhash too
   old even for the finalized bank is too old for every later bank, so false means expired (the
   sweep only asks about rows minutes old, long after a fresh blockhash is finalized). */
async function blockhashValid(blockhash) {
  const r = await withRetry(() => connection.isBlockhashValid(blockhash, { commitment: 'finalized' }));
  return !!(r && r.value);
}

/* For /api/submit-stake, BEFORE its pending-verify row is written (night review 2026-10-29,
   finding 0): whether a stake built on this blockhash can still land. Asked at 'processed', the
   newest bank, because an honest stake's blockhash is seconds old (its quote's) and can read
   invalid at 'finalized' (blockhashValid above, which is for the sweep's minutes-old rows). */
async function stakeBlockhashLive(blockhash) {
  if (typeof blockhash !== 'string' || !blockhash) return false;
  const r = await withRetry(() => connection.isBlockhashValid(blockhash, { commitment: 'processed' }));
  return !!(r && r.value);
}

/* opts.lane 'public': a read a visitor asked for (/api/sol-balance), on PUBLIC_RPC_URL's key, one request and no
   retries (above); the escrow's own diagnostics stay on the money key. */
async function getAddressBalance(address, opts) {
  const conn = opts && opts.lane === 'public' ? publicConnection : connection;
  return (await conn.getBalance(new PublicKey(address))) / LAMPORTS_PER_SOL;
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

module.exports = { getEscrowPublicKey, getRecentSigs, withdraw, attemptPayout, getEscrowBalance, getAddressBalance, getEscrowDiagnostics, verifyStakeTransfer, getLatestBlockhash, forwardRpc, submitStake, NETWORK, setDb, seedUsedSignatures,
                   rpcRequestError, RPC_RELAY_METHODS, RPC_RELAY_MAX_BYTES, stakeTxInfo, stakeSigStatus, blockhashValid,
                   stakeBlockhashLive, preflightRefused, buildSignedPayout,
                   PAYOUT_SUPERSEDED, PAYOUT_WAIT, connection, publicConnection, withRetry };
