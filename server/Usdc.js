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
// Keep-alive HTTPS agent. Without one, every RPC call opens a fresh TLS
// connection, and the handshake is synchronous crypto on the same single core
// that runs the 60Hz simulation. The solvency monitor only fires once a minute,
// which is long enough that any pooled socket would otherwise be gone, so it
// paid a full handshake every time and stalled the game loop. Reusing sockets
// removes that cost entirely.
const _https = require('https');
const rpcAgent = new _https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 16 });
const connection = new Connection(RPC_URL, { commitment: 'confirmed', httpAgent: rpcAgent });

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
// ATA derivation runs findProgramAddressSync, which is a synchronous sha256
// loop. Cheap once, but it was being redone on every balance poll on the same
// thread as the sim, so memoise per owner.
const _ataMemo = new Map();
function ataForOwnerCached(ownerAddress) {
  let a = _ataMemo.get(ownerAddress);
  if (!a) {
    a = getAssociatedTokenAddressSync(USDC_MINT, new PublicKey(ownerAddress));
    if (_ataMemo.size > 5000) _ataMemo.clear();
    _ataMemo.set(ownerAddress, a);
  }
  return a;
}

async function usdcBalanceOf(ownerAddress) {
  const ata = ataForOwnerCached(ownerAddress);
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

// Generalized version of verifyUsdcStake for ANY recipient owner — used by the cosmetics shop,
// which pays the house/owner wallet instead of the escrow. Verifies a confirmed tx credited
// `recipientOwner`'s USDC account by >= minUsdc. Returns { payer, usdc }.
async function verifyUsdcCredit(signature, recipientOwner, minUsdc) {
  if (typeof signature !== 'string' || !signature) throw new Error('Missing transaction signature');
  const tx = await withRetry(() => connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }));
  if (!tx) throw new Error('Transaction not found or not yet confirmed');
  if (tx.meta && tx.meta.err) throw new Error('Transaction failed on-chain');
  const delta = stakeDeltaUnits(tx.meta, String(recipientOwner), USDC_MINT.toString());
  const min = toUnits(minUsdc);
  if (delta < min) throw new Error(`Payment too small (${delta} < ${min} USDC units)`);
  const keys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
  return { payer: keys[0].toString(), usdc: toUsdc(delta) };
}

// The USDC associated-token-account address for any owner (where a client sends a payment).
function ataFor(ownerAddress) { return getAssociatedTokenAddressSync(USDC_MINT, new PublicKey(ownerAddress)).toString(); }

/* Money in and out of a player's own wallet, read off the chain.

   There is no ledger to read instead. The old deposits/withdrawals tables are
   vestigial from the custodial system, and self-custody means these transfers
   never touch our server — the chain is the only place they exist. Listing
   anything else would be inventing it.

   The signed delta of the owner's USDC balance IS the entry: positive is money
   arriving, negative is money leaving, and the same pre/post-balance parse the
   stake verifier trusts is what produces it. A tx that nets to zero for this
   owner is not their transaction and is dropped.

   Signatures are fetched for the token account a page at a time (newest
   first, `before` the last one shown), then each transaction is read on its
   own. They used to come in ONE JSON-RPC batch of up to 36, and the Helius
   plan answers every batch with 429 (measured on the server 2026-10-15: the
   signatures came back in 163 ms, the batch was refused five times running,
   while the same 20 reads sent one by one, even all at once, all landed). A
   retry resends the same batch, so the wallet screen never loaded a single
   row. A confirmed transaction never changes, so a row read once is kept and
   a returning wallet only pays for what is new. */
const HISTORY_PAGE_MAX = 50;
const HISTORY_READS_AT_ONCE = 4;
const HISTORY_ROWS_MAX = 20000;
const _historyRows = new Map();        // owner + ':' + signature -> row, or null (not this owner's money)
/* At most HISTORY_READS_AT_ONCE history reads in flight across EVERY wallet, so two people paging
   at once cannot double the burst: these reads share the key's rate limit with stake verifies
   and payouts, which must never be the ones left waiting. */
let _historyInFlight = 0;
const _historyQueue = [];
const HISTORY_QUEUE_MAX = 600;          // ~30 s of reads waiting; past it a page fails fast (502)
async function historyGate(fn) {
  if (_historyInFlight >= HISTORY_READS_AT_ONCE) {
    if (_historyQueue.length >= HISTORY_QUEUE_MAX) throw new Error('history reads busy');
    await new Promise(r => _historyQueue.push(r));
  }
  _historyInFlight++;
  try { return await fn(); } finally {
    _historyInFlight--;
    const next = _historyQueue.shift();
    if (next) next();
  }
}

// Who was on the other side of `owner`'s change: the holder of the same mint whose balance
// moved the opposite way by the most. null when the tx shows nobody (a mint or a burn).
function counterpartyOf(meta, owner, mint) {
  const amt = (arr, who) => {
    const b = (arr || []).find(x => x && x.owner === who && x.mint === mint);
    return BigInt(b ? b.uiTokenAmount.amount : '0');
  };
  const own = amt(meta.postTokenBalances, owner) - amt(meta.preTokenBalances, owner);
  const others = new Set();
  for (const b of (meta.preTokenBalances || []).concat(meta.postTokenBalances || [])) {
    if (b && b.mint === mint && b.owner && b.owner !== owner) others.add(b.owner);
  }
  let best = null, bestAmt = 0n;
  for (const who of others) {
    const d = amt(meta.postTokenBalances, who) - amt(meta.preTokenBalances, who);
    const opposite = own > 0n ? -d : d;
    if (opposite > bestAmt) { best = who; bestAmt = opposite; }
  }
  return best;
}

async function historyRow(owner, sig, escrow) {
  const key = owner + ':' + sig.signature;
  if (_historyRows.has(key)) return _historyRows.get(key);
  const tx = await historyGate(() => withRetry(() => connection.getTransaction(sig.signature,
    { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })));
  if (!tx) return null;                 // not visible yet: asked again next time, never kept
  let row = null;
  if (tx.meta && !tx.meta.err) {
    const mint = USDC_MINT.toString();
    const delta = stakeDeltaUnits(tx.meta, owner, mint);
    if (delta !== 0n) {
      row = {
        signature: sig.signature,
        at: (sig.blockTime ? sig.blockTime * 1000 : (tx.blockTime ? tx.blockTime * 1000 : null)),
        usdc: toUsdc(delta < 0n ? -delta : delta),
        direction: delta > 0n ? 'in' : 'out',
        // A stake goes to the escrow and a payout comes from it; anything else is the player's own.
        game: !!escrow && counterpartyOf(tx.meta, owner, mint) === escrow,
      };
    }
  }
  if (_historyRows.size >= HISTORY_ROWS_MAX) _historyRows.delete(_historyRows.keys().next().value);
  _historyRows.set(key, row);
  return row;
}

// { rows, next }: up to `limit` signatures' worth of rows, newest first; `next` is the cursor
// for the page after (pass it back as `before`), null once the wallet's history is exhausted.
async function usdcHistory(ownerAddress, opts) {
  const owner = String(ownerAddress);
  const o = opts || {};
  const limit = Math.max(1, Math.min(HISTORY_PAGE_MAX, Number(o.limit) || 25));
  const ata = new PublicKey(ataFor(owner));
  let escrow = null;
  try { escrow = escrowPubkey().toString(); } catch (_) { /* no escrow key here: no game labels */ }
  const rows = [];
  let before = o.before || undefined;
  // A page can hold only failed or zero-change transactions; read on, a few pages at most, so
  // "show more" never answers with nothing while there is more to show.
  for (let pages = 0; pages < 3; pages++) {
    let sigs;
    try {
      sigs = await withRetry(() => connection.getSignaturesForAddress(ata, { limit, before }));
    } catch (e) {
      if (ataNotFound(e)) return { rows: [], next: null };   // never held USDC: no account, no history
      throw e;
    }
    sigs = sigs || [];
    const ok = sigs.filter(s => s && !s.err);
    const got = await Promise.all(ok.map(s => historyRow(owner, s, escrow)));
    for (const r of got) if (r) rows.push(r);
    if (sigs.length < limit) return { rows, next: null };
    before = sigs[sigs.length - 1].signature;
    if (rows.length) break;
  }
  return { rows, next: before || null };
}

/* Escrow never pays the rent for a player's USDC account (review finding, night queue item 5).
   It used to create a missing recipient account on every payout, about 0.002 SOL of escrow SOL
   each time. A stake tx can move a wallet's last USDC in and close its now-empty account in the
   same tx (the rent goes back to the player, and the verifier only reads the escrow's side);
   Paper's refund before a first input then sent the stake back AND had escrow re-open the
   account: a free loop that drained escrow SOL until every payout on the site failed. A real
   player always has the account, because they staked from it. So a payout to a wallet with no
   USDC account now throws RECIPIENT_NO_USDC_ACCOUNT before anything is signed or sent: the
   callers record it owed in failed_payouts, and the drainer pays it once the wallet has an
   account again (the player makes it, at their own cost). Only addresses the server names here
   (the house's revenue wallet) or a payout that asks for it (the house-funded Battle Royale
   prize, one a night, whose winner may never have staked) may have the account created. */
const RECIPIENT_NO_USDC_ACCOUNT = 'recipient-no-usdc-account';
const _rentOk = new Set();
function allowAccountRentFor(address) {
  if (address) _rentOk.add(String(address));
}

// Build + sign a USDC payout from escrow -> recipient. Returns everything needed to broadcast
// AND recover it (same idempotent model as Wallet.buildSignedPayout: re-broadcasting the same
// bytes can only land once). opts.payRent: create the recipient's account if missing (escrow
// pays the rent); otherwise a missing account throws RECIPIENT_NO_USDC_ACCOUNT.
async function buildSignedUsdcPayout(toAddress, amountUsdc, opts) {
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
  if (!toExists) {
    const payRent = !!(opts && opts.payRent) || _rentOk.has(recipient.toString());
    if (!payRent) {
      const e = new Error(RECIPIENT_NO_USDC_ACCOUNT + ': the wallet has no USDC account; paid once it has one again');
      e.code = RECIPIENT_NO_USDC_ACCOUNT;
      throw e;
    }
    ixs.push(createAssociatedTokenAccountInstruction(escrow.publicKey, toAta, recipient, USDC_MINT));
  }
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
async function withdrawUsdc(toAddress, amountUsdc, opts) {
  const built = await buildSignedUsdcPayout(toAddress, amountUsdc, opts);
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

/* onFreshTx answered false: the row no longer held the signature this attempt was claimed with,
   so another attempt saved (and sends) its own transaction for it. Nothing is sent by this one.
   The drainer (server/payoutDrainer.js SUPERSEDED) knows this code. */
const PAYOUT_SUPERSEDED = 'payout-superseded';
function superseded() {
  const e = new Error('another attempt saved its own transaction for this payout first; nothing sent');
  e.code = PAYOUT_SUPERSEDED;
  return e;
}

// Idempotent USDC payout for the drainer — identical guarantees to Wallet.attemptPayout: only
// ever re-broadcasts the SAME signed bytes (can't double-pay), builds a fresh tx only once the
// old one provably expired, and persists a fresh tx BEFORE sending via onFreshTx. onFreshTx is
// a compare-and-set (db.savePayoutSignature): when it answers false the fresh tx is dropped
// unsent, so two overlapping attempts on one row can never both send a transaction.
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
  const saved = await onFreshTx({ signature: built.signature, signedTx: built.signedTx, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight });
  if (saved === false) throw superseded();
  await withRetry(() => connection.sendRawTransaction(built.raw, { skipPreflight: false }), 6);
  const ok = await confirmSig(built.signature, built.lastValidBlockHeight);
  return ok ? { paid: true, sig: built.signature } : { paid: false };
}

module.exports = {
  connection, NETWORK, USDC_MINT, USDC_DECIMALS, toUnits, toUsdc, withRetry, ataNotFound,
  escrowKeypair, escrowPubkey, escrowAta, stakeTargets,
  usdcBalanceOf, escrowUsdcBalance, verifyUsdcStake, verifyUsdcCredit, stakeDeltaUnits, ataFor,
  usdcHistory,
  buildSignedUsdcPayout, withdrawUsdc, attemptPayout, getLatestBlockhash,
  RECIPIENT_NO_USDC_ACCOUNT, allowAccountRentFor, PAYOUT_SUPERSEDED,
};
