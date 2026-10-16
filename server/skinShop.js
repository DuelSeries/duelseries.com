'use strict';
/* Buying a skin with USDC (docs/skin-purchases.md). A MONEY PATH: real USDC moves from the player's own wallet to
   the house revenue wallet, and what it buys is recorded for good. Every dependency is injected (store = the
   database, chain = the Solana reads and the broadcast), so test/skinShop.test.js runs it on fakes.

   A purchase row (skin_purchases) goes:

     open      --buy: the signed bytes check out, BEFORE they are broadcast-------------> submitted (sig, unique)
     submitted --a preflight refusal: certain nothing was sent-------------------------> open (sig cleared)
     submitted --the tx landed and verifies (buy, the page asking again, or the sweep)-> paid  (+ owned, + ledger)
     submitted --the chain says it failed, or its blockhash expired unlanded----------> failed | expired
     open      --never submitted in 30 minutes------------------------------------------> expired

   Each arrow is one conditional UPDATE (the row's state and signature in its WHERE), so of the request, the page's
   check and the sweep exactly one settles a row, and a signature claims one row ever (UNIQUE). At most one row per
   wallet and item is open or submitted at a time (a partial unique index), so a double click or a second tab can
   never pay twice for one skin. No refunds (Owen, 2026-10-16): a payment that landed always becomes the skin. */
const crypto = require('crypto');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const { VersionedTransaction, PublicKey } = require('@solana/web3.js');
const catalog = require('./skinCatalog');
const { isWalletString } = require('./b58Caps');

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const TRANSFER_CHECKED = 12;
const MEMO_PREFIX = 'ds-skin:';
const REF_RE = /^[1-9A-HJ-NP-Za-km-z]{16,32}$/;
const MAX_SIGNED_B64 = 4096;

const memoFor = (ref) => MEMO_PREFIX + ref;
function newRef() { return bs58.encode(crypto.randomBytes(16)); }

function u64le(bytes, at) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]);
  return v;
}

/* Pure, BEFORE the broadcast: why these signed bytes are not exactly the payment for this row, or null when they
   are. expect = { wallet, units (BigInt), mint, revenueAta, ref }. Exactly one USDC transferChecked of exactly the
   row's units from an account the wallet controls (the wallet is its authority) to the revenue wallet's USDC
   account, exactly one memo naming the ref, the wallet as fee payer, Compute Budget allowed, nothing else (no other
   program, no address lookup table). A refusal here sends nothing, so it costs the player nothing. */
function paymentProblem(raw, expect) {
  let tx;
  try { tx = VersionedTransaction.deserialize(raw); } catch (_) { return 'not a transaction'; }
  const msg = tx.message;
  const keys = (msg.staticAccountKeys || []).map((k) => k.toBase58());
  if (!keys.length || keys[0] !== expect.wallet) return 'the payer is not this purchase\'s wallet';
  if ((msg.addressTableLookups || []).length) return 'lookup tables are not accepted';
  let transfers = 0;
  let memos = 0;
  for (const ix of msg.compiledInstructions || []) {
    const prog = keys[ix.programIdIndex];
    const data = Buffer.from(ix.data || []);
    const acct = (n) => keys[ix.accountKeyIndexes[n]];
    if (prog === COMPUTE_BUDGET) continue;
    if (prog === MEMO_PROGRAM) {
      memos++;
      if (data.toString('utf8') !== memoFor(expect.ref)) return 'the memo does not name this purchase';
      continue;
    }
    if (prog === TOKEN_PROGRAM) {
      transfers++;
      if (data.length !== 10 || data[0] !== TRANSFER_CHECKED) return 'not a checked token transfer';
      if ((ix.accountKeyIndexes || []).length !== 4) return 'unexpected transfer accounts';
      if (acct(1) !== expect.mint) return 'not USDC';
      if (acct(2) !== expect.revenueAta) return 'not paid to the shop';
      if (acct(3) !== expect.wallet) return 'not authorised by this wallet';
      if (acct(0) === expect.revenueAta) return 'not paid from this wallet';
      if (u64le(data, 1) !== expect.units) return 'not the price';
      if (data[9] !== 6) return 'wrong decimals';
      continue;
    }
    return 'an instruction the shop does not accept';
  }
  if (transfers !== 1) return 'not exactly one payment';
  if (memos !== 1) return 'not exactly one memo';
  return null;
}

/* Pure, AFTER it landed (getTransaction, confirmed): why the landed tx is not this row's payment, or null. Checked
   again although the bytes were checked before sending (the signature binds them): what is granted is what the
   chain shows. Returns { problem, usdc }. */
function landedProblem(tx, expect) {
  if (!tx) return { problem: 'not found' };
  if (tx.meta && tx.meta.err) return { problem: 'failed on-chain' };
  if (!tx.meta) return { problem: 'no balances' };
  const m = tx.transaction && tx.transaction.message;
  if (!m) return { problem: 'no message' };
  const stat = (m.staticAccountKeys || m.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.toBase58()));
  const loaded = tx.meta.loadedAddresses || {};
  const all = stat.concat((loaded.writable || []).map(String), (loaded.readonly || []).map(String));
  if (all[0] !== expect.wallet) return { problem: 'payer is not this purchase\'s wallet' };
  const bal = (arr) => {
    const b = (arr || []).find((x) => x && all[x.accountIndex] === expect.revenueAta && x.mint === expect.mint);
    return BigInt(b ? b.uiTokenAmount.amount : '0');
  };
  const delta = bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances);
  if (delta < expect.units) return { problem: `paid ${delta} < ${expect.units} units` };
  const ixs = m.compiledInstructions || [];
  const memo = memoFor(expect.ref);
  const hasMemo = ixs.some((ix) => all[ix.programIdIndex] === MEMO_PROGRAM
    && Buffer.from(typeof ix.data === 'string' ? bs58.decode(ix.data) : (ix.data || [])).toString('utf8') === memo);
  if (!hasMemo) return { problem: 'memo missing' };
  return { problem: null, usdc: Number(delta) / 1e6 };
}

/* A send error that proves nothing was broadcast: the node's preflight simulation refused it (no USDC, no SOL for
   the fee, no USDC account). Anything else (a timeout, a dropped connection) may have gone out. */
function preflightRefused(e) {
  const m = (e && e.message) || '';
  return /simulation failed|Simulation failed|insufficient (funds|lamports)|could not find account|AccountNotFound|InvalidAccountData|custom program error|Attempt to debit/i.test(m)
    && !/timeout|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i.test(m);
}

function friendlySend(e) {
  const m = (e && e.message) || '';
  if (/insufficient lamports|Attempt to debit|insufficient funds for fee|no record of a prior credit/i.test(m)) {
    return 'Your wallet needs a little SOL for the network fee. Add funds and try again.';
  }
  if (/insufficient funds|custom program error: 0x1\b/i.test(m)) return 'Not enough USDC. Add funds and try again.';
  if (/could not find account|AccountNotFound|InvalidAccountData/i.test(m)) return 'Not enough USDC. Add funds and try again.';
  return 'The payment was refused by the network. Nothing was charged.';
}

const NOT_SELLING = 'Skins cannot be bought right now. Try again soon.';

/* deps:
   store   the database (server/db.js skin* functions; a fake in the tests)
   chain   { txInfo(raw) -> {signature, payer, blockhash}, send(raw) -> sig, status(sig) -> 'landed'|'failed'|'seen'|null,
             getTx(sig) -> tx|null, finalizedHeight() -> number, blockhashValid(bh) -> bool (at 'finalized'),
             latestBlockhash() -> {blockhash, lastValidBlockHeight} }
   mint, revenueAta   USDC's mint and the revenue wallet's USDC account (base58)
   paused()           true while the owner has the site in maintenance (no new purchases)
   ready()            false when the database could not create the purchase table (nothing is sold) */
function createSkinShop({ store, chain, mint, revenueAta, paused = () => false, ready = () => true, log = console,
                          now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
                          confirmMs = 40_000, pollMs = 1000, sweepAfterMs = 60_000, openTtlMs = 30 * 60 * 1000,
                          onPaid = () => {} } = {}) {
  if (!store || !chain || !mint || !revenueAta) throw new Error('skinShop: store, chain, mint and revenueAta are required');
  const inFlight = new Set();        // signatures this process is broadcasting or settling right now
  /* blockhash -> its last valid block height, for every quote this process issued (newest 2000). A payment must
     carry one of these, so its row knows exactly when it can no longer land (settle, provablyExpired). A payment
     signed against a quote from before a restart is refused unsent: the page simply asks again. */
  const issued = new Map();
  function remember(blockhash, lastValid) {
    if (typeof blockhash !== 'string' || !(Number(lastValid) > 0)) return;
    issued.delete(blockhash);
    issued.set(blockhash, Number(lastValid));
    while (issued.size > 2000) issued.delete(issued.keys().next().value);
  }
  const lastLook = new Map();        // ref -> when the page last made us ask the chain (one look per 3 s per ref)

  const expectOf = (row) => ({ wallet: row.wallet, units: BigInt(row.units), mint, revenueAta, ref: row.ref });

  // POST /api/skins/intent: a row to pay, or why not. Returns { status, body }.
  async function intent(body) {
    const b = body && typeof body === 'object' ? body : {};
    const { game, skin, wallet } = b;
    if (typeof game !== 'string' || typeof skin !== 'string' || typeof wallet !== 'string') return { status: 400, body: { error: 'Malformed request' } };
    if (!isWalletString(wallet)) return { status: 400, body: { error: 'Not a wallet' } };
    try { if (new PublicKey(wallet).toBytes().length !== 32) throw new Error('bad'); } catch (_) { return { status: 400, body: { error: 'Not a wallet' } }; }
    const it = catalog.itemOf(game, skin);
    if (!it) return { status: 400, body: { error: 'That skin is not for sale' } };
    if (!ready()) return { status: 503, body: { error: NOT_SELLING } };
    if (paused()) return { status: 503, body: { error: NOT_SELLING } };
    if (await store.ownsItem(wallet, it.item)) return { status: 200, body: { owned: true, item: it.item } };
    const fresh = () => store.skinOpen({ ref: newRef(), wallet, item: it.item, game: it.game, skin: it.skin, units: it.units.toString() });
    let row = await fresh();
    if (!row) return { status: 503, body: { error: NOT_SELLING } };
    if (row.state === 'submitted') return { status: 200, body: { pending: true, ref: row.ref, item: row.item } };
    // An open row from before a price change (Owen edited the price list since) is closed unpaid and a new one opened
    // at today's price, so a quote is always the price the page shows.
    if (String(row.units) !== it.units.toString()) {
      await store.skinExpire(row.ref);
      row = await fresh();
      if (!row || row.state !== 'open' || String(row.units) !== it.units.toString()) return { status: 503, body: { error: NOT_SELLING } };
    }
    const { blockhash, lastValidBlockHeight } = await chain.latestBlockhash();
    remember(blockhash, lastValidBlockHeight);
    return { status: 200, body: {
      ref: row.ref, item: row.item, units: String(row.units), amountUsdc: Number(row.units) / 1e6,
      mint, decimals: 6, payTo: revenueAta, memo: memoFor(row.ref), memoProgram: MEMO_PROGRAM, blockhash,
    } };
  }

  /* Settle a submitted row from the chain: 'paid' | 'failed' | 'expired' | 'pending' | 'review'. Shared by the buy,
     the page asking again and the sweep; the store's conditional UPDATEs make whichever comes second a no-op. */
  async function settle(row) {
    const sig = row.sig;
    const st = await chain.status(sig);
    if (st === 'landed') {
      const tx = await chain.getTx(sig);
      if (!tx) return 'pending';                       // a node a little behind: ask again later
      const { problem, usdc } = landedProblem(tx, expectOf(row));
      if (problem) {
        // Cannot happen for bytes that passed paymentProblem; never granted, kept for the owner to look at.
        log.error(`[SKINS] CRITICAL ${row.ref} landed but does not verify (${problem}): ${sig}`);
        await store.skinClose(row.ref, sig, 'review');
        return 'review';
      }
      const g = await store.skinGrant(row.ref, sig, { usdc });
      if (g && g.granted) {
        log.log(`[SKINS] sold ${row.item} to ${row.wallet.slice(0, 8)} for ${usdc} USDC: ${sig}`);
        try { onPaid({ wallet: row.wallet, item: row.item, game: row.game, skin: row.skin, usdc, sig }); } catch (_) {}
        return 'paid';
      }
      const again = await store.skinRow(row.ref);
      return again && again.state === 'paid' ? 'paid' : 'pending';
    }
    if (st === 'failed') {
      await store.skinClose(row.ref, sig, 'failed');
      return 'failed';
    }
    if (st === 'seen') return 'pending';
    /* Not seen at all. 'expired' is the one answer that tells a player no USDC moved, so it is given only when the
       payment provably can never land: the chain's FINALIZED block height is past the last block its blockhash is
       valid for (every later block is higher, and every block at or below it is final, so the status read above
       would have found it), and one more status read still finds nothing.
       (Owen's first test buy, 2026-10-16: this asked isBlockhashValid at 'finalized' about a blockhash seconds old.
       The finalized bank had not seen it yet, so it read as expired, the page said no USDC moved, and the payment
       landed ten seconds later. He paid twice.) */
    if (!(await provablyExpired(row))) return 'pending';
    const last = await chain.status(sig);
    if (last == null) {
      await store.skinClose(row.ref, sig, 'expired');
      return 'expired';
    }
    if (last === 'failed') {
      await store.skinClose(row.ref, sig, 'failed');
      return 'failed';
    }
    return 'pending';
  }

  // True only when this row's payment can no longer land. Rows carry the blockhash's last valid block height from
  // the quote this server issued; a row without one (made before that field existed) is judged only after 15 minutes,
  // when its blockhash (at most about 90 seconds of life) is long final and long expired.
  async function provablyExpired(row) {
    const lv = Number(row.last_valid_height) || 0;
    if (lv > 0) return (await chain.finalizedHeight()) > lv;
    const at = row.submitted_at || row.submittedAt;
    const age = at ? now() - new Date(at).getTime() : 0;
    return age > 15 * 60 * 1000 && !!row.blockhash && !(await chain.blockhashValid(row.blockhash));
  }

  // A settled row's state as answer() names it.
  const closedState = (row) => (['paid', 'failed', 'review'].includes(row.state) ? row.state : 'expired');
  const answer = (row, state) => {
    if (state === 'paid') return { status: 200, body: { ok: true, state: 'paid', item: row.item } };
    if (state === 'failed') return { status: 400, body: { state: 'failed', error: 'The payment failed on the network, so no USDC moved. Try again.' } };
    if (state === 'expired') return { status: 400, body: { state: 'expired', error: 'The payment never went through, so no USDC moved. Try again.' } };
    if (state === 'review') return { status: 500, body: { state: 'review', error: 'Something went wrong checking this payment. It has been flagged for the owner.' } };
    return { status: 202, body: { pending: true, state: 'pending', ref: row.ref, item: row.item } };
  };

  // POST /api/skins/buy: check the signed payment, claim the row, broadcast, confirm, grant.
  async function buy(body) {
    const b = body && typeof body === 'object' ? body : {};
    const { ref, signedTx } = b;
    if (typeof ref !== 'string' || !REF_RE.test(ref) || typeof signedTx !== 'string' || !signedTx || signedTx.length > MAX_SIGNED_B64) {
      return { status: 400, body: { error: 'Malformed request' } };
    }
    if (!ready()) return { status: 503, body: { error: NOT_SELLING } };
    const row = await store.skinRow(ref);
    if (!row) return { status: 404, body: { error: 'No such purchase' } };
    if (row.state !== 'open' && row.state !== 'submitted') return answer(row, closedState(row));
    const raw = Buffer.from(signedTx, 'base64');
    let info;
    try { info = chain.txInfo(raw); } catch (_) { return { status: 400, body: { error: 'Not a signed payment' } }; }
    if (row.state === 'submitted') {
      // The same bytes again (a retry after a dropped answer): settle that one. Different bytes: refused unsent.
      if (row.sig !== info.signature) return { status: 409, body: { error: 'A payment for this skin is already on its way.', pending: true, ref } };
      return answer(row, await waitFor(row));
    }
    if (paused()) return { status: 503, body: { error: NOT_SELLING } };
    const lastValid = issued.get(info.blockhash);
    if (!lastValid) return { status: 400, body: { error: 'That payment was for an old price check. Nothing was sent. Try again.', state: 'open' } };
    const problem = paymentProblem(raw, expectOf(row));
    if (problem) {
      log.warn(`[SKINS] refused unsent ${ref}: ${problem}`);
      return { status: 400, body: { error: 'That payment does not match this skin. Nothing was sent.' } };
    }
    if (await store.ownsItem(row.wallet, row.item)) return { status: 409, body: { error: 'You already own this skin. Nothing was sent.', owned: true } };
    if (inFlight.has(info.signature)) return { status: 409, body: { error: 'A payment for this skin is already on its way.', pending: true, ref } };
    inFlight.add(info.signature);
    try {
      // The claim, BEFORE anything is sent: one row, one signature, once.
      const claimed = await store.skinSubmit(ref, info.signature, info.blockhash, lastValid);
      if (!claimed) return { status: 409, body: { error: 'A payment for this skin is already on its way.', pending: true, ref } };
      const sub = Object.assign({}, row, { state: 'submitted', sig: info.signature, blockhash: info.blockhash,
        last_valid_height: lastValid, submittedAt: now() });
      try {
        await chain.send(raw);
      } catch (e) {
        if (preflightRefused(e)) {
          await store.skinReopen(ref, info.signature);
          log.warn(`[SKINS] preflight refused ${ref}: ${(e && e.message || '').slice(0, 160)}`);
          return { status: 400, body: { error: friendlySend(e), state: 'open' } };
        }
        // It may have gone out: the confirm below, the page and the sweep find out.
        log.warn(`[SKINS] send of ${ref} unclear, settling from the chain: ${(e && e.message || '').slice(0, 160)}`);
      }
      return answer(sub, await waitFor(sub));
    } finally {
      inFlight.delete(info.signature);
    }
  }

  async function waitFor(row) {
    const end = now() + confirmMs;
    let state = 'pending';
    for (;;) {
      try { state = await settle(row); } catch (e) { state = 'pending'; log.warn(`[SKINS] settle ${row.ref}: ${e && e.message}`); }
      if (state !== 'pending' || now() >= end) return state;
      await sleep(pollMs);
    }
  }

  // GET /api/skins/purchase/:ref: where a purchase stands (a reloaded page resuming). Asks the chain at most once
  // per 3 s per purchase.
  async function purchase(ref) {
    if (typeof ref !== 'string' || !REF_RE.test(ref)) return { status: 400, body: { error: 'Malformed request' } };
    const row = await store.skinRow(ref);
    if (!row) return { status: 404, body: { error: 'No such purchase' } };
    if (row.state === 'open') return { status: 200, body: { state: 'open', ref, item: row.item } };
    if (row.state !== 'submitted') return answer(row, closedState(row));
    const t = now();
    if (inFlight.has(row.sig) || t - (lastLook.get(ref) || 0) < 3000) return answer(row, 'pending');
    lastLook.set(ref, t);
    if (lastLook.size > 5000) lastLook.clear();
    let state = 'pending';
    try { state = await settle(row); } catch (e) { log.warn(`[SKINS] check ${ref}: ${e && e.message}`); }
    return answer(row, state);
  }

  /* Every minute: settle submitted rows a minute old (a page that went away, a restart mid-purchase), one at a time
     and never batched (Helius Free answers a batch with 429), then close open rows nobody paid in 30 minutes. */
  let sweeping = false;
  async function sweep({ limit = 10 } = {}) {
    if (sweeping || !ready()) return { settled: 0 };
    sweeping = true;
    let settled = 0;
    try {
      const rows = await store.skinDue({ olderThanMs: sweepAfterMs, limit });
      for (const row of rows) {
        if (inFlight.has(row.sig)) continue;
        try {
          const s = await settle(row);
          if (s !== 'pending') settled++;
        } catch (e) {
          log.warn(`[SKINS] sweep ${row.ref}: ${e && e.message}`);
        }
      }
      await store.skinExpireOpen({ olderThanMs: openTtlMs });
      // The net under 'expired': rows closed expired 3 to 10 minutes ago (on the first sweep after a boot, every one)
      // are read once more. 'expired' must never be wrong, and once it was.
      const late = await store.skinExpiredDue({ minAgeMs: 3 * 60 * 1000, maxAgeMs: rechecked ? 10 * 60 * 1000 : null,
                                                limit: rechecked ? limit : 50 });
      rechecked = true;
      for (const row of late) {
        try { if (await lateLanding(row)) settled++; } catch (e) { log.warn(`[SKINS] recheck ${row.ref}: ${e && e.message}`); }
      }
    } catch (e) {
      log.warn(`[SKINS] sweep: ${e && e.message}`);
    } finally {
      sweeping = false;
    }
    return { settled };
  }
  let rechecked = false;

  /* A row closed 'expired' whose payment landed after all: the skin is granted, or, when the wallet already owns it
     (it paid twice, as Owen did on 2026-10-16), the row goes to 'review' with a CRITICAL line naming the refund owed.
     Never granted twice, never silently kept. */
  async function lateLanding(row) {
    if (!row || !row.sig || (await chain.status(row.sig)) !== 'landed') return false;
    const tx = await chain.getTx(row.sig);
    if (!tx) return false;
    const { problem, usdc } = landedProblem(tx, expectOf(row));
    if (problem) {
      log.error(`[SKINS] CRITICAL ${row.ref} landed after it was closed expired and does not verify (${problem}): ${row.sig}`);
      return store.skinClose(row.ref, row.sig, 'review', 'expired');
    }
    if (await store.ownsItem(row.wallet, row.item)) {
      log.error(`[SKINS] CRITICAL double charge: ${row.ref} (${row.item}) landed after it was closed expired, and ${row.wallet} `
        + `already owns it. ${usdc} USDC is owed back to that wallet: ${row.sig}`);
      return store.skinClose(row.ref, row.sig, 'review', 'expired');
    }
    const g = await store.skinGrant(row.ref, row.sig, { usdc, from: 'expired' });
    if (!g || !g.granted) return false;
    log.log(`[SKINS] sold ${row.item} to ${row.wallet.slice(0, 8)} for ${usdc} USDC (it landed after it was closed): ${row.sig}`);
    try { onPaid({ wallet: row.wallet, item: row.item, game: row.game, skin: row.skin, usdc, sig: row.sig }); } catch (_) {}
    return true;
  }

  // GET /api/skins/owned: the items a wallet owns (public facts: the payments are on-chain).
  async function owned(wallet) {
    if (typeof wallet !== 'string' || !isWalletString(wallet)) return { status: 400, body: { error: 'Not a wallet' } };
    const items = (await store.owned(wallet)).filter((i) => catalog.parseItem(i) || /^[a-z0-9]+:[a-z0-9]+$/.test(i));
    return { status: 200, body: { items } };
  }

  return { intent, buy, purchase, sweep, owned, settle };
}

/* The live chain: Wallet.js's signed-bytes reader, its broadcast-only send, Usdc.js's connection. Never batched;
   every read retries 429 and 5xx with backoff (withRetry). */
function liveChain({ Wallet, Usdc }) {
  const conn = Usdc.connection;
  return {
    txInfo: (raw) => Wallet.stakeTxInfo(raw),
    send: (raw) => conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 }),
    status: (sig) => Wallet.stakeSigStatus(sig),
    getTx: (sig) => Usdc.withRetry(() => conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })),
    finalizedHeight: () => Usdc.withRetry(() => conn.getBlockHeight('finalized')),
    blockhashValid: (bh) => Wallet.blockhashValid(bh),
    latestBlockhash: () => Usdc.getLatestBlockhash(),
  };
}

module.exports = { createSkinShop, liveChain, paymentProblem, landedProblem, preflightRefused, memoFor, newRef,
                   MEMO_PROGRAM, TOKEN_PROGRAM, COMPUTE_BUDGET, MEMO_PREFIX, REF_RE };
