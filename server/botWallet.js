'use strict';
// The Bot bank's own wallet (Owen 2026-10-17): a hot wallet with its own address, separate from escrow. Anything sent
// to its address is bot money. The server only ever moves USDC between this wallet and escrow:
//   'in'  bot wallet -> escrow  (a bot's seed, before the bot spawns; the bot wallet signs and pays the fee)
//   'out' escrow -> bot wallet  (unspent seed going home; escrow signs, pays the fee and, once, the bot wallet's
//         USDC account rent)
// No other destination exists in this module, so bot money can never be sent to the house or a player from here.
//
// The key: BOT_BANK_PRIVATE_KEY (base64 secret key, the ESCROW_PRIVATE_KEY pattern) when set; otherwise generated once
// on the server and kept in the data folder (bot-bank-key.json, mode 600, never in git). The secret is never logged.
//
// Reads are single RPC calls (never batched: Helius Free 429s every batch), the balances cached 20 s.
//
// SOL mode (MONEY_MODE=sol, 2026-10-17): the bank is the wallet's SOL above a 0.003 SOL reserve (its own fees and
// rent), and the same two directions move plain SOL. The bank still counts in micro-dollars (server/botBank.js):
// usdcMicro() answers the SOL above the reserve in micro-dollars at the price now (rounded down, null with no price),
// a seed going 'in' converts its dollars rounding UP (escrow always receives at least what it now owes), unspent seed
// going 'out' rounds DOWN (escrow never sends more than it owes).

const fs = require('fs');
const path = require('path');
const { Keypair, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } = require('@solana/web3.js');
const { lamportsUp, lamportsDown, microDown } = require('./solPrice');
const { getAssociatedTokenAddressSync, createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction } = require('@solana/spl-token');

const CU_LIMIT = 80000;
const CU_PRICE = 100000; // micro-lamports per compute unit, the stake tx's priority fee (a72884b)
const CACHE_MS = 20000;
const SOL_RESERVE = 3_000_000;   // SOL mode: 0.003 SOL stays in the bot wallet for its own fees and rent

function loadKeypair(dataDir, { env = process.env, fsx = fs, log = console } = {}) {
  if (env.BOT_BANK_PRIVATE_KEY) return Keypair.fromSecretKey(Buffer.from(env.BOT_BANK_PRIVATE_KEY, 'base64'));
  const file = path.join(dataDir, 'bot-bank-key.json');
  try {
    const raw = JSON.parse(fsx.readFileSync(file, 'utf8'));
    return Keypair.fromSecretKey(Buffer.from(raw.secret, 'base64'));
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) throw new Error('bot-bank-key.json unreadable; refusing to make a new wallet over it');
  }
  const kp = Keypair.generate();
  fsx.mkdirSync(dataDir, { recursive: true });
  fsx.writeFileSync(file, JSON.stringify({ address: kp.publicKey.toString(),
    secret: Buffer.from(kp.secretKey).toString('base64') }) + '\n', { mode: 0o600, flag: 'wx' });
  log.warn('[BOTBANK] new Bot bank wallet made: ' + kp.publicKey.toString() + ' (key in ' + file + ')');
  return kp;
}

// -> the chain side botBank.js drives. Usdc = server/Usdc.js (connection, mint, escrow key, retry).
// mode 'sol': usdPerSol() -> the money path's SOL price (money.price.usdPerSol, throws when there is none)
function createBotWallet({ dataDir, Usdc, env, log = console, mode = 'usdc', usdPerSol = null }) {
  const sol_ = mode === 'sol';
  if (sol_ && typeof usdPerSol !== 'function') throw new Error('botWallet: SOL mode needs a price');
  const kp = loadKeypair(dataDir, { env, log });
  const conn = Usdc.connection;
  const mint = Usdc.USDC_MINT;
  const botAta = getAssociatedTokenAddressSync(mint, kp.publicKey);
  let usdc = { v: null, at: 0 }, sol = { v: null, at: 0 }, reading = null;
  // true = confirmed, false = errored on-chain, null = not found or not confirmed yet (one read, never batched)
  async function landed(sig) {
    const r = await Usdc.withRetry(() => conn.getSignatureStatus(sig, { searchTransactionHistory: true }));
    const v = r && r.value;
    if (!v) return null;
    if (v.err) return false;
    return v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized' ? true : null;
  }

  async function refresh() {
    if (reading) return reading;
    reading = (async () => {
      if (!sol_) try {
        const b = await Usdc.withRetry(() => conn.getTokenAccountBalance(botAta));
        usdc = { v: Number(b.value.amount), at: Date.now() };
      } catch (e) {
        if (/could not find account|Invalid param/i.test(String(e && e.message))) usdc = { v: 0, at: Date.now() };
        else log.warn('[BOTBANK] wallet USDC not read: ' + (e && e.message));
      }
      try {
        sol = { v: await Usdc.withRetry(() => conn.getBalance(kp.publicKey)), at: Date.now() };
      } catch (e) {
        log.warn('[BOTBANK] wallet SOL not read: ' + (e && e.message));
      }
    })().finally(() => { reading = null; });
    return reading;
  }

  return {
    address: kp.publicKey.toString(),
    // cached reads (null until the first read); a stale cache starts a refresh
    usdcMicro() {
      if (sol_) {
        if (Date.now() - sol.at > CACHE_MS) refresh();
        if (!Number.isSafeInteger(sol.v)) return null;
        let rate;
        try { rate = usdPerSol(); } catch (_) { return null; }    // no price: not read yet, never "empty"
        return sol.v > SOL_RESERVE ? microDown(sol.v - SOL_RESERVE, rate) : 0;
      }
      if (Date.now() - usdc.at > CACHE_MS) refresh();
      return usdc.v;
    },
    solLamports() {
      if (Date.now() - sol.at > CACHE_MS) refresh();
      return sol.v;
    },
    refresh,
    // Build and sign one transfer, sent by broadcast() after the caller saved it. -> { sig, raw, lvbh }
    async build(dir, micro) {
      if (dir !== 'in' && dir !== 'out') throw new Error('botWallet: direction');
      if (!Number.isSafeInteger(micro) || micro < 1) throw new Error('botWallet: amount');
      const escrow = Usdc.escrowKeypair();
      const from = dir === 'in' ? kp : escrow;
      const toOwner = dir === 'in' ? escrow.publicKey : kp.publicKey;
      const fromAta = getAssociatedTokenAddressSync(mint, from.publicKey);
      const toAta = getAssociatedTokenAddressSync(mint, toOwner);
      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }))
        .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE }));
      if (sol_) {
        const rate = usdPerSol();                                   // throws with no price: nothing built
        const lamports = dir === 'in' ? lamportsUp(micro / 1e6, rate) : lamportsDown(micro / 1e6, rate);
        if (!(lamports > 0)) throw new Error('botWallet: amount');
        tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: toOwner, lamports }));
      } else {
        if (dir === 'out') tx.add(createAssociatedTokenAccountIdempotentInstruction(escrow.publicKey, toAta, toOwner, mint));
        tx.add(createTransferCheckedInstruction(fromAta, mint, toAta, from.publicKey, BigInt(micro), Usdc.USDC_DECIMALS));
      }
      const { blockhash, lastValidBlockHeight } = await Usdc.withRetry(() => conn.getLatestBlockhash(), 6);
      tx.recentBlockhash = blockhash;
      tx.feePayer = from.publicKey;
      tx.sign(from);
      const bs = require('bs58');
      const sig = (bs.default || bs).encode(tx.signature);
      return { sig, raw: tx.serialize().toString('base64'), lvbh: lastValidBlockHeight };
    },
    async broadcast(raw) {
      try {
        await conn.sendRawTransaction(Buffer.from(raw, 'base64'), { skipPreflight: true, maxRetries: 0 });
      } catch (e) {
        log.warn('[BOTBANK] send: ' + (e && e.message));
      }
    },
    // -> 'landed', 'failed' (errored on-chain), 'expired' (past its block height and not found on this read; the
    // bank only gives up after several such reads in a row) or 'pending'
    async status(sig, lvbh) {
      const l = await landed(sig);
      if (l === true) return 'landed';
      if (l === false) return 'failed';
      const h = await Usdc.withRetry(() => conn.getBlockHeight());
      return h <= Number(lvbh) ? 'pending' : 'expired';
    },
  };
}

module.exports = { createBotWallet, loadKeypair, SOL_RESERVE };
