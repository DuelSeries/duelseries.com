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
const rpcBudget = require('./rpcBudget');   // the server-wide budget history reads take from (night review 2026-10-29)

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
/* The Wallet tab's history reads (usdcHistory, usdcTransfers) have a Connection of their own that never resends a 429
   by itself (night review 2026-10-29, findings 1 and 22). web3.js retries a throttled call up to 5 times inside one
   call, where no budget can see it, and withRetry wrapped that up to 6 times, so one history read became up to 30
   requests at a key that was already throttled. Here each attempt is one request, and every one takes a token from
   the history budget below (historyRead, historySigPage). Stakes, payouts and balances keep `connection` and its
   retries exactly as they were. */
/* PUBLIC_RPC_URL (night review 2026-10-29, third pass; Wallet.js has the same line and says why): the reads any visitor
   can cause, history and /api/sol-balance's USDC, go to this key when it is set, so strangers can never spend the
   credits stakes and payouts run on. Unset, it is RPC_URL and nothing changes. */
const PUBLIC_RPC_URL = process.env.PUBLIC_RPC_URL || RPC_URL;
const publicConnection = PUBLIC_RPC_URL === RPC_URL ? connection
  : new Connection(PUBLIC_RPC_URL, { commitment: 'confirmed', httpAgent: rpcAgent });
const historyConnection = new Connection(PUBLIC_RPC_URL, { commitment: 'confirmed', httpAgent: rpcAgent, disableRetryOnRateLimit: true });

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

/* opts.lane 'public': a read a visitor asked for (/api/sol-balance), on PUBLIC_RPC_URL's key; anything else (the
   escrow, the solvency monitor) stays on the money key. */
async function usdcBalanceOf(ownerAddress, opts) {
  const ata = ataForOwnerCached(ownerAddress);
  const conn = opts && opts.lane === 'public' ? publicConnection : connection;
  try {
    const acc = await withRetry(() => getAccount(conn, ata));
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
  // every owner whose USDC went down in this tx (the real senders, whoever paid the fee): read only, for callers
  // that must know who the money came from (the bot bank's top-up)
  const senders = [];
  const pre = (tx.meta && tx.meta.preTokenBalances) || [];
  for (const b of pre) {
    if (!b || b.mint !== USDC_MINT.toString() || !b.owner || senders.includes(b.owner)) continue;
    if (stakeDeltaUnits(tx.meta, b.owner, USDC_MINT.toString()) < 0n) senders.push(b.owner);
  }
  return { payer: keys[0].toString(), usdc: toUsdc(delta), senders };
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
/* Night review 2026-10-29 (findings 1, 2 and 22): the gate capped how many reads were in flight, never how many a
   second, so it refilled as fast as the provider answered (about 28 a second from ONE IP asking /api/my-transfers for
   an exchange's wallet every 2 s), and the 1000-signature pages went around it. Every history call (signature pages
   and transaction reads alike, each retry too) now also takes a token from one server-wide bucket: HISTORY_RPS a
   second (2 by default since the second pass) after a burst of HISTORY_BURST (60, about one long wallet screen
   opening at full speed as before). However many people or scripts ask, history is held to that, and the rest of the key stays with stake
   verifies, submits and payouts, which never touch it. Raise both in .env with a bigger Helius plan.
   The queue is about 30 s of reads at that rate; past it, or when a token is more than 15 s away, the call fails at
   once ('history reads busy': the route's 502, and the Wallet tab's "Tap refresh").
   At 2 a second here and the public routes' 3, 5 of the key's 10 a second stay with stakes and payouts.
   Third pass (night review 2026-10-29, review problems 0 and 1): the day's cap the second pass added
   (HISTORY_PER_DAY) is gone. It lived in memory and every deploy restarted it full, and a cap strangers can spend
   is one they can empty for everyone. Instead each asking address has a share of the rate: half of it, with the
   whole burst (one screen still opens at full speed), waited for in turn like the rate itself, so one address
   flooding history is paced at half and the other half stays for everyone else, and a player's long history is
   paced, never refused for being long. The owner's own session takes the rate only, no share (the route passes
   rpcBudget.UNMETERED). Each read takes its token before its gate slot, so a read waiting on its address's share
   never holds one of the four slots other people's reads need. */
const HISTORY_RPS = rpcBudget.envNumber('HISTORY_RPS', 2);
const HISTORY_BURST = rpcBudget.envNumber('HISTORY_BURST', 60);
const HISTORY_QUEUE_MAX = Math.max(40, Math.ceil(HISTORY_RPS * 30));
const HISTORY_WAIT_MAX_MS = 15_000;
const _historyBudget = rpcBudget.createBudget({ perSec: HISTORY_RPS, burst: HISTORY_BURST,
  perKey: { perSec: HISTORY_RPS / 2, burst: HISTORY_BURST } });
const _historyBusy = rpcBudget.refusalLogs('history reads');
rpcBudget.usageLog('history reads', _historyBudget);
async function historyGate(fn) {
  if (_historyInFlight >= HISTORY_READS_AT_ONCE) {
    if (_historyQueue.length >= HISTORY_QUEUE_MAX) { _historyBusy.rate(); throw new Error('history reads busy'); }
    await new Promise(r => _historyQueue.push(r));
  }
  _historyInFlight++;
  try { return await fn(); } finally {
    _historyInFlight--;
    const next = _historyQueue.shift();
    if (next) next();
  }
}
// A token from the history budget, waited for in turn (the server-wide rate and the asking address's share); a flood
// that would wait past HISTORY_WAIT_MAX_MS fails at once. `key` is the asking IP (or rpcBudget.UNMETERED for the owner).
async function historyToken(key) {
  const r = _historyBudget.reserve(1, HISTORY_WAIT_MAX_MS, key);
  if (r.refused) { _historyBusy[r.refused](); throw new Error('history reads busy'); }
  if (r.wait > 0) await new Promise(res => setTimeout(res, r.wait));
}
/* One transaction read: a token, then a gate slot, for each attempt (a retry is a request too). The token comes first
   (night review 2026-10-29, third pass) so a read waiting its turn holds no slot. */
function historyRead(fn, key) {
  return withRetry(async () => { await historyToken(key); return historyGate(fn); });
}
/* One signature page: a token for each attempt, no gate slot. A page is what an ask needs before any of its reads, so
   it never waits behind them: asked while the transaction list's reads are still under way, the add funds list
   shares those instead of reading them again, as it always has. The budget is what bounds pages; a waiting page
   holds no slot. */
function historySigPage(fn, key) {
  return withRetry(async () => { await historyToken(key); return fn(); });
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

/* The house's own wallets besides the escrow (index.js names the revenue wallet, which the old
   cosmetics shop was paid into). Money to or from any of them is game money, not the player's
   own add funds or withdrawal. */
const _houseAddrs = new Set();
function markHouseAddress(address) { if (address) _houseAddrs.add(String(address)); }
/* The escrow's address for labels only. Without the private key (a local server, a test) the
   public one from the environment still names game money; with neither, nothing is a game. */
function historyEscrow() {
  try { return escrowPubkey().toString(); } catch (_) { return process.env.ESCROW_PUBLIC_KEY || null; }
}

/* One read per transaction, ever: two asks for the same one at once (the transaction list and
   the add funds list open together) share the read instead of making it twice (and the budget
   counts it to the ask that started it, `budgetKey`). */
const _historyReading = new Map();
function historyRow(owner, sig, escrow, budgetKey) {
  const key = owner + ':' + sig.signature;
  if (_historyRows.has(key)) return Promise.resolve(_historyRows.get(key));
  if (_historyReading.has(key)) return _historyReading.get(key);
  const p = readHistoryRow(owner, sig, escrow, key, budgetKey);
  _historyReading.set(key, p);
  const done = () => _historyReading.delete(key);
  p.then(done, done);
  return p;
}
async function readHistoryRow(owner, sig, escrow, key, budgetKey) {
  const tx = await historyRead(() => historyConnection.getTransaction(sig.signature,
    { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }), budgetKey);
  if (!tx) return null;                 // not visible yet: asked again next time, never kept
  const row = (tx.meta && !tx.meta.err) ? historyRowOf(tx, owner, escrow, sig) : null;
  if (_historyRows.size >= HISTORY_ROWS_MAX) _historyRows.delete(_historyRows.keys().next().value);
  _historyRows.set(key, row);
  return row;
}

/* What one confirmed transaction did with `owner`'s money, as a history row, or null when it moved
   none of it. Since card top-ups arrive as SOL (Owen, 2026-10-15: "Accept both, play in USDC"),
   a row is one of:
     usdc        USDC in or out, as before; with the escrow or the house it is a game (stake, payout)
     sol         SOL in or out by a plain transfer (a MoonPay top-up, a send from an exchange)
     convert     the wallet's SOL into USDC (Convert to USDC): +usdc, `sol` given
     convertSol  the wallet's USDC into its own SOL: +sol, `usdc` given
     withdrawSol USDC out as SOL to another address (Withdraw as SOL): `usdc` given, `sol` that
                 address got, `peer` that address
   A swap is one row however many legs it has, and one transaction is one row however many of the
   wallet's accounts it touched. SOL under SOL_DUST is never a row: dust from a look-alike address is
   how address poisoning puts a fake "recent recipient" in a wallet's history. */
const SOL_DUST = 1_000_000n;            // 0.001 SOL
const SYSTEM_ID = '11111111111111111111111111111111';
const SWAP_PROGRAMS = new Set(['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', '61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH']);
function txAccountKeys(tx) {
  const m = tx.transaction && tx.transaction.message;
  if (!m) return [];
  const stat = (m.staticAccountKeys || m.accountKeys || []).map(k => k.toString());
  const la = (tx.meta && tx.meta.loadedAddresses) || {};
  return stat.concat((la.writable || []).map(String), (la.readonly || []).map(String));
}
// Every System transfer in the transaction, top level and inner: { from, to, lamports }.
function systemTransfers(tx, keys) {
  const out = [];
  const take = (pidIdx, accts, data) => {
    if (keys[pidIdx] !== SYSTEM_ID || !data || data.length !== 12 || data.readUInt32LE(0) !== 2) return;
    out.push({ from: keys[accts[0]], to: keys[accts[1]], lamports: data.readBigUInt64LE(4) });
  };
  const m = tx.transaction && tx.transaction.message;
  if (!m) return out;
  for (const ix of (m.compiledInstructions || [])) take(ix.programIdIndex, ix.accountKeyIndexes, Buffer.from(ix.data));
  for (const g of (tx.meta.innerInstructions || [])) {
    for (const ix of (g.instructions || [])) {
      let data = null;
      try { data = Buffer.from(bs58.decode(ix.data)); } catch (_) { data = null; }
      take(ix.programIdIndex, ix.accounts || [], data);
    }
  }
  return out;
}
// The purchase ref in a skin payment's memo ('ds-skin:<ref>', server/skinShop.js), or null. Display only: what a
// purchase is worth and who owns what is decided by skinShop, never by this.
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
function skinRefOf(msg, keys) {
  for (const ix of (msg && msg.compiledInstructions) || []) {
    if (keys[ix.programIdIndex] !== MEMO_PROGRAM) continue;
    let text = '';
    try { text = Buffer.from(typeof ix.data === 'string' ? bs58.decode(ix.data) : (ix.data || [])).toString('utf8'); } catch (_) { text = ''; }
    const m = /^ds-skin:([1-9A-HJ-NP-Za-km-z]{16,32})$/.exec(text);
    if (m) return m[1];
  }
  return null;
}

function historyRowOf(tx, owner, escrow, sig) {
  const meta = tx.meta;
  const at = sig && sig.blockTime ? sig.blockTime * 1000 : (tx.blockTime ? tx.blockTime * 1000 : null);
  const base = { signature: sig ? sig.signature : null, at };
  const mint = USDC_MINT.toString();
  const delta = stakeDeltaUnits(meta, owner, mint);
  const keys = txAccountKeys(tx);
  const idx = keys.indexOf(owner);
  const lam = idx >= 0 ? BigInt(meta.postBalances[idx]) - BigInt(meta.preBalances[idx]) : 0n;
  const solNet = lam + (idx === 0 ? BigInt(meta.fee || 0) : 0n);   // SOL in or out, the fee left out
  const msg = tx.transaction && tx.transaction.message;
  const programs = new Set(((msg && msg.compiledInstructions) || []).map(ix => keys[ix.programIdIndex]));
  const swap = [...programs].some(p => SWAP_PROGRAMS.has(p));
  const sol = (l) => Number(l) / 1e9;
  if (delta !== 0n && swap) {
    if (delta > 0n && solNet < 0n) {
      return Object.assign(base, { kind: 'convert', usdc: toUsdc(delta), sol: sol(-solNet), direction: 'in', game: false, peer: null });
    }
    if (delta < 0n && solNet >= SOL_DUST) {
      return Object.assign(base, { kind: 'convertSol', usdc: toUsdc(-delta), sol: sol(solNet), direction: 'out', game: false, peer: null });
    }
    if (delta < 0n) {
      // Withdraw as SOL: the address whose SOL rose the most, the wallet and the fee payer aside.
      let best = null, bestLam = 0n;
      keys.forEach((k, i) => {
        if (k === owner || i === 0 || i >= meta.postBalances.length) return;
        const d = BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i]);
        if (d > bestLam) { best = k; bestLam = d; }
      });
      return Object.assign(base, { kind: 'withdrawSol', usdc: toUsdc(-delta), sol: bestLam > 0n ? sol(bestLam) : null,
                                   direction: 'out', game: !!best && (best === escrow || _houseAddrs.has(best)), peer: best });
    }
  }
  // A skin bought from this wallet (server/skinShop.js): its memo names the purchase. It pays the revenue wallet, a
  // house address, so it used to read as a game entry (Owen, 2026-10-16). The route fills in which skin (skinRef).
  const skinRef = delta < 0n || (delta === 0n && solNet < 0n) ? skinRefOf(msg, keys) : null;
  if (skinRef && delta === 0n) {
    // SOL mode: the skin was paid in SOL (plain transfer to the revenue wallet with the memo)
    return Object.assign(base, { kind: 'skin', usdc: 0, direction: 'out', game: false, peer: null, sol: sol(-solNet), skinRef });
  }
  if (skinRef) {
    return Object.assign(base, { kind: 'skin', usdc: toUsdc(-delta), direction: 'out', game: false,
                                 peer: counterpartyOf(meta, owner, mint), sol: null, skinRef });
  }
  if (delta !== 0n) {
    // Who sent it (money in) or got it (money out). Public on the chain, like the rest of the row.
    const peer = counterpartyOf(meta, owner, mint);
    return Object.assign(base, {
      kind: 'usdc',
      usdc: toUsdc(delta < 0n ? -delta : delta),
      direction: delta > 0n ? 'in' : 'out',
      // A stake goes to the escrow and a payout comes from it; anything else is the player's own.
      game: !!peer && (peer === escrow || _houseAddrs.has(peer)),
      peer,
      sol: null,
    });
  }
  // SOL only: plain transfers to or from the wallet, netted; the other side is the biggest one.
  let inSum = 0n, outSum = 0n, inPeer = null, inBig = 0n, outPeer = null, outBig = 0n;
  for (const t of systemTransfers(tx, keys)) {
    if (t.to === owner && t.from !== owner) { inSum += t.lamports; if (t.lamports > inBig) { inBig = t.lamports; inPeer = t.from; } }
    else if (t.from === owner && t.to !== owner) { outSum += t.lamports; if (t.lamports > outBig) { outBig = t.lamports; outPeer = t.to; } }
  }
  const net = inSum - outSum;
  const inb = net > 0n;
  const peer = inb ? inPeer : outPeer;
  const game = !!peer && (peer === escrow || _houseAddrs.has(peer));
  // SOL mode: a stake or a payout with the house is a game row however small (a $0.05 win is under the dust)
  if (net >= SOL_DUST || -net >= SOL_DUST || (game && net !== 0n)) {
    return Object.assign(base, { kind: 'sol', usdc: 0, sol: sol(inb ? net : -net), direction: inb ? 'in' : 'out', game, peer });
  }
  return null;
}

// { rows, next }: up to `limit` signatures' worth of rows, newest first; `next` is the cursor
// for the page after (pass it back as `before`), null once the wallet's history is exhausted.
/* opts.sol (SOL mode): the Transactions list is the SOL games and skins of the wallet itself (its own signatures, not
   its USDC account's), each priced in dollars at its day's price (opts.priceOn), like Add funds and Withdrawals.
   opts.budgetKey: who the history budget counts the reads to (the asking IP; rpcBudget.UNMETERED for the owner). */
async function usdcHistory(ownerAddress, opts) {
  const owner = String(ownerAddress);
  const o = opts || {};
  const limit = Math.max(1, Math.min(HISTORY_PAGE_MAX, Number(o.limit) || 25));
  const ata = o.sol ? new PublicKey(owner) : new PublicKey(ataFor(owner));
  const escrow = historyEscrow();
  const rows = [];
  let before = o.before || undefined;
  // A page can hold only failed or zero-change transactions; read on, a few pages at most, so
  // "show more" never answers with nothing while there is more to show.
  for (let pages = 0; pages < 3; pages++) {
    let sigs;
    try {
      sigs = await historySigPage(() => historyConnection.getSignaturesForAddress(ata, { limit, before }), o.budgetKey);
    } catch (e) {
      if (ataNotFound(e)) return { rows: [], next: null };   // never held USDC: no account, no history
      throw e;
    }
    sigs = sigs || [];
    const ok = sigs.filter(s => s && !s.err);
    const got = await Promise.all(ok.map(s => historyRow(owner, s, escrow, o.budgetKey)));
    // The Transactions list is the USDC that moved; SOL-only rows belong to Add funds and Withdrawals.
    for (const r of got) {
      if (!r) continue;
      if (o.sol ? (r.sol > 0 && (r.game || r.kind === 'skin')) : r.usdc > 0) rows.push(r);
    }
    if (sigs.length < limit) { before = null; break; }
    before = sigs[sigs.length - 1].signature;
    if (rows.length) break;
  }
  if (o.sol) await priceSolRows(rows, o.priceOn);
  return { rows, next: before || null };
}

/* The player's own money in and out (the Wallet tab's "Add funds and Withdrawals"): every USDC
   transfer whose other side is not the house. These are a few rows among many games, so paging
   the history 20 at a time could show an empty page for a long while; this walks the wallet's
   signatures (one cheap read per 1000) and reads the transactions newest first, through the same
   kept rows, gate and single reads as usdcHistory.

   At most `reads` transactions not read before are read per ask, so one ask costs a bounded
   amount however long the wallet's history is. When it stops short the answer says so
   (complete: false) and holds every transfer newer than where it stopped, never one with a gap
   above it; the next ask starts over from the newest, where everything is already kept, and
   reads on. Rows are newest first: { signature, at, usdc, direction, peer }. The newest 200 at
   most (a player's own transfers, years of them): every answer is kept in memory a while, so a
   wallet with thousands of transfers (an exchange's, asked for on purpose) must not be able to
   make one answer that size. */
/* The newest 2000 signatures of each address at most, two pages each (night review 2026-10-29, finding 1): 5000 was
   ten 1000-signature pages an ask for any busy wallet, about 2 MB held per ask while it waited on the budget. 2000 is
   a thousand games of stakes and payouts, far more than a player's own list has needed. */
const TRANSFER_SIGS_MAX = 2000;
const TRANSFER_READS_PER_ASK = 60;
const TRANSFER_ROWS_MAX = 200;
/* The signature walk of an answer that stopped short, kept for the ask after it (night review 2026-10-29, second
   pass). The Wallet tab asks again 600 ms after each such answer ("Looking further back", up to 40 times), and every
   ask walked the same 1000-signature pages again before its reads: budget and seconds spent on a list that had not
   changed. A walk is kept 30 s after the last ask that used it and 2 minutes at most (so a new transfer is never left
   out of a list for longer than that), for the newest TRANSFER_WALKS_MAX wallets, as the three fields a row needs.
   A complete answer drops it: the route keeps that answer itself. */
const TRANSFER_WALK_IDLE_MS = 30_000;
const TRANSFER_WALK_MAX_AGE_MS = 120_000;
const TRANSFER_WALKS_MAX = 16;
const _transferWalks = new Map();     // owner -> { madeAt, usedAt, ok: [{ signature, slot, blockTime }] }
async function usdcTransfers(ownerAddress, opts) {
  const owner = String(ownerAddress);
  const o = opts || {};
  const budget = Math.max(1, Math.min(TRANSFER_READS_PER_ASK, Number(o.reads) || TRANSFER_READS_PER_ASK));
  const ata = new PublicKey(ataFor(owner));
  const escrow = historyEscrow();
  const startedAt = Date.now();
  let walk = _transferWalks.get(owner) || null;
  if (walk && (startedAt - walk.usedAt >= TRANSFER_WALK_IDLE_MS || startedAt - walk.madeAt >= TRANSFER_WALK_MAX_AGE_MS)) {
    _transferWalks.delete(owner);
    walk = null;
  }
  let ok;
  if (walk) ok = walk.ok;
  else {
    /* Both of the wallet's addresses: its USDC account (USDC arriving from anyone names only that)
       and the wallet itself (SOL arriving, SOL sent, a conversion). A transaction that touched both is
       one signature, read once, one row. */
    const bySig = new Map();
    for (const addr of [ata, new PublicKey(owner)]) {
      let before, n = 0;
      for (;;) {
        let page;
        try {
          page = await historySigPage(() => historyConnection.getSignaturesForAddress(addr, { limit: 1000, before }), o.budgetKey);
        } catch (e) {
          if (ataNotFound(e)) break;            // never held USDC: no account, nothing there
          throw e;
        }
        page = page || [];
        for (const s of page) if (s && s.signature && !bySig.has(s.signature)) bySig.set(s.signature, s);
        n += page.length;
        if (page.length < 1000 || n >= TRANSFER_SIGS_MAX) break;
        before = page[page.length - 1].signature;
      }
    }
    // Newest first across both lists (a slot is the chain's order; the time only breaks ties).
    const sigs = [...bySig.values()].sort((a, b) => (b.slot || 0) - (a.slot || 0) || (b.blockTime || 0) - (a.blockTime || 0));
    ok = sigs.slice(0, TRANSFER_SIGS_MAX).filter(s => s && !s.err)
      .map(s => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime }));
  }
  const rows = [];
  let i = 0, fresh = 0;
  while (i < ok.length) {
    const chunk = [];
    while (i < ok.length && chunk.length < 20) {
      if (!_historyRows.has(owner + ':' + ok[i].signature)) {
        if (fresh >= budget) break;
        fresh++;
      }
      chunk.push(ok[i++]);
    }
    if (!chunk.length) break;
    const got = await Promise.all(chunk.map(s => historyRow(owner, s, escrow, o.budgetKey)));
    for (const r of got) {
      // a skin bought is neither money added nor a withdraw (it shows in the Transactions list)
      if (r && !r.game && r.kind !== 'skin') rows.push(r);
    }
    if (rows.length >= TRANSFER_ROWS_MAX) break;
  }
  const out = rows.slice(0, TRANSFER_ROWS_MAX);
  const complete = out.length >= TRANSFER_ROWS_MAX || i >= ok.length;
  _transferWalks.delete(owner);
  if (!complete) {
    _transferWalks.set(owner, { madeAt: walk ? walk.madeAt : startedAt, usedAt: Date.now(), ok });
    if (_transferWalks.size > TRANSFER_WALKS_MAX) _transferWalks.delete(_transferWalks.keys().next().value);
  }
  await priceSolRows(out, o.priceOn);
  return {
    rows: out.map(r => ({ signature: r.signature, at: r.at, kind: r.kind || 'usdc', usdc: r.usdc, sol: r.sol == null ? null : r.sol,
                          usd: r.usd == null ? null : r.usd, direction: r.direction, peer: r.peer || null })),
    complete,
  };
}

/* A SOL row's dollar value then (Owen, 2026-10-15: "+0.157 SOL with its $ value at the time if
   available"): SOL times that day's price from priceOn(ms), a dollars-per-SOL or null. Kept on the
   row once found (a day's price never changes); at most PRICE_LOOKUPS_PER_ASK days are asked for in
   one answer, so a long history fills in over a few asks instead of in one burst. */
const PRICE_LOOKUPS_PER_ASK = 4;
async function priceSolRows(rows, priceOn) {
  if (typeof priceOn !== 'function') return;
  let asked = 0;
  for (const r of rows) {
    if (r.kind !== 'sol' || r.usd != null || !r.at || !(r.sol > 0)) continue;   // a SOL skin row gets its sale price (index.js withSkinItems)
    if (asked >= PRICE_LOOKUPS_PER_ASK) break;
    asked++;
    let p = null;
    try { p = await priceOn(r.at); } catch (_) { p = null; }
    if (p > 0) r.usd = Math.round(r.sol * p * 100) / 100;
  }
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
  connection, publicConnection, historyConnection, HISTORY_RPS, HISTORY_BURST, HISTORY_QUEUE_MAX, TRANSFER_SIGS_MAX, NETWORK, USDC_MINT, USDC_DECIMALS, toUnits, toUsdc, withRetry, ataNotFound,
  escrowKeypair, escrowPubkey, escrowAta, stakeTargets,
  usdcBalanceOf, escrowUsdcBalance, verifyUsdcStake, verifyUsdcCredit, stakeDeltaUnits, ataFor,
  usdcHistory, usdcTransfers, markHouseAddress, TRANSFER_ROWS_MAX, historyRowOf, SOL_DUST,
  buildSignedUsdcPayout, withdrawUsdc, attemptPayout, getLatestBlockhash,
  RECIPIENT_NO_USDC_ACCOUNT, allowAccountRentFor, PAYOUT_SUPERSEDED,
};
