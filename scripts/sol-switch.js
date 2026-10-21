'use strict';
/* Switch night for USDC -> SOL money (docs/sol-switch-runbook.md). Run ON THE SERVER from the app dir so keys and the
   database come from .env and are never printed:
     node -r dotenv/config scripts/sol-switch.js check            read only: is it safe to flip?
     node -r dotenv/config scripts/sol-switch.js convert --yes    the house's USDC (escrow + Bot bank wallet) -> SOL
   check reads: stake rows still 'verifying' (must be 0: a cross-mode verify would reject them), unpaid owed rows,
   escrow SOL and USDC, the Bot bank wallet's SOL and USDC, and the SOL price from all three sources.
   convert swaps each wallet's whole USDC to SOL in that same wallet through server/swap.js (Jupiter, every check the
   players' Convert gets), signed here by the wallet's own key. Nothing else is ever signed by this script. */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { VersionedTransaction, PublicKey } = require('@solana/web3.js');
const Wallet = require('../server/Wallet');
const Usdc = require('../server/Usdc');
const Swap = require('../server/swap');
const { createSolPrice } = require('../server/solPrice');
const { loadKeypair } = require('../server/botWallet');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'server', 'data');

async function usdcUnits(owner) {
  try {
    const b = await Usdc.withRetry(() => Usdc.connection.getTokenAccountBalance(new PublicKey(Usdc.ataFor(owner))));
    return BigInt(b.value.amount);
  } catch (e) {
    if (/could not find account|Invalid param/i.test(String(e && e.message))) return 0n;
    throw e;
  }
}
// The Bot bank's key, never a new one: loadKeypair would make a wallet when there is none, which is not this job.
function botKeypair() {
  if (!process.env.BOT_BANK_PRIVATE_KEY && !fs.existsSync(path.join(DATA_DIR, 'bot-bank-key.json'))) return null;
  return loadKeypair(DATA_DIR);
}

async function check({ quiet = false } = {}) {
  const out = {};
  const price = createSolPrice({ log: null });
  await price.poll();
  out.price = {};
  for (const [k, v] of price._last) out.price[k] = v.usd;
  try { out.price.used = price.current().usd; } catch (e) { out.price.used = null; out.price.problem = e.message; }
  const escrow = Usdc.escrowPubkey().toString();
  const botKp = botKeypair();
  out.escrow = { address: escrow, sol: (await Wallet.getAddressBalance(escrow)), usdc: Number(await usdcUnits(escrow)) / 1e6 };
  if (botKp) {
    const bot = botKp.publicKey.toString();
    out.botWallet = { address: bot, sol: (await Wallet.getAddressBalance(bot)), usdc: Number(await usdcUnits(bot)) / 1e6 };
  } else out.botWallet = null;
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'off' ? false : undefined });
    try {
      const v = await pool.query(`SELECT COUNT(*)::int AS n FROM used_stake_sigs WHERE state = 'verifying'`).catch(() => ({ rows: [{ n: null }] }));
      const p = await pool.query(`SELECT COUNT(*)::int AS n FROM used_stake_sigs WHERE state = 'pending'`).catch(() => ({ rows: [{ n: null }] }));
      const o = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_sol), 0)::float AS usd FROM failed_payouts WHERE paid = false`);
      out.stakes = { verifying: v.rows[0].n, unseatedTokens: p.rows[0].n };
      out.owed = { rows: o.rows[0].n, usd: o.rows[0].usd };
    } finally { await pool.end(); }
  }
  const usd = out.price.used;
  if (usd) out.escrow.solUsd = Math.round(out.escrow.sol * usd * 100) / 100;
  out.safeToFlip = out.stakes ? out.stakes.verifying === 0 && !!usd : false;
  if (!quiet) console.log(JSON.stringify(out, null, 2));
  return out;
}

async function convertOne(label, kp, swap) {
  const wallet = kp.publicKey.toString();
  const units = await usdcUnits(wallet);
  if (units < BigInt(Swap.RULES.MIN_USDC_CONVERT)) { console.log(label + ': no USDC to convert (' + units + ' units)'); return; }
  const q = await swap.quote({ wallet, dir: 'usdcToSol', amount: units.toString() });
  console.log(label + ': ' + units + ' USDC units -> at least ' + q.minOut + ' lamports (quote ' + q.outAmount + ')');
  const tx = VersionedTransaction.deserialize(Buffer.from(q.transaction, 'base64'));
  tx.sign([kp]);
  const r = await swap.execute({ requestId: q.requestId, signedTransaction: Buffer.from(tx.serialize()).toString('base64') });
  console.log(label + ': ' + JSON.stringify(r));
}

async function convert() {
  if (!process.argv.includes('--yes')) { console.log('convert moves real money: add --yes'); process.exit(2); }
  // Only when check is clean (no verifying stake, an agreed price, no owed rows), unless --force (Fable finding 8)
  const c = await check({ quiet: true });
  const clean = c.safeToFlip && c.owed && c.owed.rows === 0;
  if (!clean && !process.argv.includes('--force')) {
    console.log('not converting: check is not clean (verifying ' + (c.stakes && c.stakes.verifying) + ', owed rows ' + (c.owed && c.owed.rows)
      + ', price ' + c.price.used + '). Fix that first, or add --force.');
    process.exit(3);
  }
  const price = createSolPrice({ log: null });
  await price.poll();
  const swap = Swap.createSwap({
    chain: Swap.chainFromConnection(Wallet.connection),
    jupiter: Swap.createJupiter({ apiKey: process.env.JUP_API_KEY || '' }),
    usdcMint: () => Usdc.USDC_MINT.toString(),
    refSolUsd: () => price.peek(),
    log: (m) => console.log('[SWAP] ' + m),
  });
  await convertOne('escrow', Usdc.escrowKeypair(), swap);
  const botKp = botKeypair();
  if (botKp) await convertOne('bot wallet', botKp, swap);
}

const cmd = process.argv[2];
(cmd === 'check' ? check() : cmd === 'convert' ? convert() : Promise.reject(new Error('usage: check | convert --yes')))
  .then(() => process.exit(0))
  .catch((e) => { console.error(e && (e.publicMessage || e.message)); process.exit(1); });
