'use strict';
/* Reconcile escrow USDC inflows against the stake ledger. READ ONLY: it sends nothing, signs
   nothing and writes nothing.

   Why it exists (BACKLOG 2.1 review). A deploy restarts the server. /api/submit-stake broadcasts
   a signed stake, then waits for it to confirm (up to about 30 s), then claims its signature in
   used_stake_sigs. A restart inside that wait leaves USDC in escrow with no row: no entry token,
   no refund, and the boot sweep cannot see it, because it reads rows. The same holds for an old
   process that keeps taking stakes during a deploy's drain. Usdc.usdcHistory cannot answer this:
   it reads at most 50 signatures, outflows included. This pages through every signature in the
   window.

   Run it on the server, from the app directory, after a deploy:
     node scripts/reconcile-stakes.js --from 2026-10-10T15:00:00Z [--to <time>] [--escrow <owner>]
   --from: when maintenance went on (or a little before). --to: defaults to now; use at least 60 s
   after the new boot. --escrow: the escrow wallet's public key; defaults to ESCROW_PUBLIC_KEY, then
   to the key ESCROW_PRIVATE_KEY derives. Needs RPC_URL and DATABASE_URL (from .env).

   Every inflow is printed with its row state. 'NO ROW' is money that landed with no record. Check
   each one by hand before refunding it: an owner float top-up has no row either, and is not owed.
   Exit code 0 when every inflow has a row, 2 when at least one has none, 1 on an error. */
const path = require('path');

const MAX_SIGS = 20000;     // a runaway window stops here and says so
const BATCH = 25;           // transactions fetched per RPC call

/* Pure: the escrow's USDC inflows among `sigInfos` (getSignaturesForAddress rows) and the parsed
   transactions fetched for them, in the same order, inside [fromMs, toMs]. The amount is the same
   pre/post token balance delta the stake verifier credits (Usdc.stakeDeltaUnits). */
function inflowsFrom(sigInfos, txs, { owner, mint, fromMs, toMs, deltaUnits, toUsdc }) {
  const out = [];
  for (let i = 0; i < sigInfos.length; i++) {
    const s = sigInfos[i];
    const tx = txs[i];
    if (!s || s.err || !tx || !tx.meta || tx.meta.err) continue;
    const at = s.blockTime ? s.blockTime * 1000 : null;
    if (at !== null && (at < fromMs || at > toMs)) continue;
    const delta = deltaUnits(tx.meta, owner, mint);
    if (delta <= 0n) continue;
    const keys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [];
    const k0 = keys[0];
    const payer = k0 ? String(k0.pubkey || k0) : null;
    out.push({ signature: s.signature, at, payer, units: delta, usdc: toUsdc(delta) });
  }
  return out;
}

/* Pure: each inflow joined on its signature to its used_stake_sigs row, if it has one. */
function reconcile(inflows, rows) {
  const bySig = new Map((rows || []).map(r => [r.sig, r]));
  return inflows.map(f => {
    const r = bySig.get(f.signature);
    return Object.assign({}, f, {
      recorded: !!r,
      state: r ? (r.state || 'claimed (legacy row)') : null,
      label: r ? (r.label || null) : null,
    });
  });
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--from' || k === '--to' || k === '--escrow') a[k.slice(2)] = argv[++i];
  }
  return a;
}

function toMs(v, name) {
  if (v === undefined) return null;
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} is not a time: ${v}`);
  return n;
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
  const args = parseArgs(process.argv.slice(2));
  const fromMs = toMs(args.from, 'from');
  if (fromMs === null) throw new Error('--from is required (when maintenance went on)');
  const untilMs = toMs(args.to, 'to') || Date.now();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  const Usdc = require('../server/Usdc');
  const { PublicKey } = require('@solana/web3.js');
  const owner = String(args.escrow || process.env.ESCROW_PUBLIC_KEY || Usdc.escrowPubkey().toString());
  const ata = new PublicKey(Usdc.ataFor(owner));
  const mint = Usdc.USDC_MINT.toString();

  // Every signature on the escrow's USDC account, newest first, back to --from.
  const sigInfos = [];
  let before;
  for (;;) {
    const page = await Usdc.withRetry(() => Usdc.connection.getSignaturesForAddress(ata, { before, limit: 1000 }));
    if (!page || !page.length) break;
    sigInfos.push(...page);
    before = page[page.length - 1].signature;
    const oldest = page[page.length - 1].blockTime;
    if (oldest && oldest * 1000 < fromMs) break;
    if (sigInfos.length >= MAX_SIGS) { console.warn(`[RECONCILE] stopped at ${MAX_SIGS} signatures; narrow the window`); break; }
  }
  const inWindow = sigInfos.filter(s => !s.err && (!s.blockTime || (s.blockTime * 1000 >= fromMs && s.blockTime * 1000 <= untilMs)));

  const txs = [];
  for (let i = 0; i < inWindow.length; i += BATCH) {
    const chunk = inWindow.slice(i, i + BATCH).map(s => s.signature);
    const got = await Usdc.withRetry(() => Usdc.connection.getParsedTransactions(chunk,
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }));
    txs.push(...(got || chunk.map(() => null)));
  }
  const inflows = inflowsFrom(inWindow, txs, { owner, mint, fromMs, toMs: untilMs,
    deltaUnits: Usdc.stakeDeltaUnits, toUsdc: Usdc.toUsdc });

  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false } });
  let rows = [];
  try {
    if (inflows.length) {
      const r = await pool.query(
        'SELECT sig, state, label, wallet_address, refund_amount, created_at FROM used_stake_sigs WHERE sig = ANY($1::text[])',
        [inflows.map(f => f.signature)]);
      rows = r.rows;
    }
  } finally {
    await pool.end();
  }

  const out = reconcile(inflows, rows);
  console.log(`[RECONCILE] escrow ${owner}, USDC account ${ata.toString()}`);
  console.log(`[RECONCILE] window ${new Date(fromMs).toISOString()} to ${new Date(untilMs).toISOString()}: ` +
    `${inWindow.length} signature(s), ${out.length} inflow(s)`);
  for (const f of out) {
    const when = f.at ? new Date(f.at).toISOString() : 'time unknown';
    console.log(`${f.recorded ? 'ok    ' : 'NO ROW'} ${when} ${f.usdc} USDC from ${f.payer} ${f.signature}` +
      (f.recorded ? ` (${f.state}${f.label ? ', ' + f.label : ''})` : ''));
  }
  const missing = out.filter(f => !f.recorded);
  const total = missing.reduce((n, f) => n + f.units, 0n);
  console.log(`[RECONCILE] ${missing.length} inflow(s) with no stake row, ${Usdc.toUsdc(total)} USDC in all.` +
    (missing.length ? ' Check each one before refunding: an owner top-up has no row either.' : ''));
  return missing.length ? 2 : 0;
}

if (require.main === module) {
  main().then(code => process.exit(code), e => { console.error('[RECONCILE] ' + (e && e.message)); process.exit(1); });
}

module.exports = { inflowsFrom, reconcile, parseArgs };
