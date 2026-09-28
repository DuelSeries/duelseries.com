'use strict';
/* ─── Local, credential-free boot of the real server ─────────────────────────
   node scripts/dev-local.js        (the "duelseries-local" entry in .claude/launch.json)

   Boots server/index.js on http://localhost:4409 for LOCAL VERIFICATION ONLY:
   the lobby (/), the solo Paper page (/paper), and any multiplayer page against
   a live socket.io server, with every external dependency stubbed:

     Postgres   server/db.js is replaced in the require cache by an in-memory
                stub before index.js loads, so `pg` is never even required.
     Solana     RPC_URL points at a reserved .invalid host, no escrow key is
                set, SOLANA_NETWORK is devnet, and (the real guarantee) every
                outbound http/https/fetch call is refused and logged below.
     Privy      unset, so token auth is disabled. index.js already tolerates
                this and says so at boot.
     ntfy, PostHog, CoinGecko    disabled by env, and caught by the guard too.
     Paper money   PAPER_PAID + PAPER_DEV_TOKENS: the $0.10 and $1 arenas open,
                entry tokens come from a POST with no chain behind it, and
                cash-outs go through a fake withdraw that only logs.

   Nothing in server/ is edited: it is env + require-cache injection, the
   technique test/leaderboardFlush.test.js uses, with the same env values as
   test/joinSmoke.test.js (REGION na, MONEY_MODE usdc, empty DATABASE_URL).

   A throwaway owner keypair is generated on every boot and printed, so the
   owner console can be exercised locally; it holds nothing and is forgotten
   on exit. Never point this script at production: it refuses NODE_ENV=production. */

const path = require('path');
const fs   = require('fs');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.DEV_LOCAL_PORT || '4409';

if (process.env.NODE_ENV === 'production') {
  console.error('[dev-local] refusing to run with NODE_ENV=production');
  process.exit(1);
}

// ─── 1. Safe environment ───────────────────────────────────────────────────────
// A throwaway owner so /api/owner/* can be driven locally (same switch the
// owner smoke test uses; index.js refuses it outright in production).
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58  = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const ownerSecret = ed25519.utils.randomPrivateKey();
const ownerWallet = bs58.encode(ed25519.getPublicKey(ownerSecret));

Object.assign(process.env, {
  NODE_ENV: 'development',
  PORT,
  REGION: 'na',
  MONEY_MODE: 'usdc',
  SESSION_SECRET: 'dev-local',
  DATABASE_URL: '',
  // .invalid never resolves (RFC 2606). Must be https: Wallet.js/Usdc.js pair
  // the endpoint with an https.Agent and web3.js refuses an http URL with one.
  RPC_URL: 'https://rpc.invalid/never-called',
  SOLANA_NETWORK: 'devnet',                     // even the fallback RPC would not be mainnet
  ESCROW_PRIVATE_KEY: '',
  ESCROW_PUBLIC_KEY: '',
  PRIVY_APP_ID: '',
  PRIVY_APP_SECRET: '',
  NTFY_DISABLED: '1',
  POSTHOG_DISABLED: '1',
  ALLOW_TEST_OWNER: '1',
  TEST_OWNER_WALLET: ownerWallet,
  // Paper's paid rungs, bought with dev entry tokens: POST /api/submit-stake with
  // { stake, walletAddress } and no signedTx mints one, and Paper pays out with a
  // fake withdraw. index.js refuses this pair beside an escrow key or in production.
  PAPER_PAID: '1',
  PAPER_DEV_TOKENS: '1',
});

// ─── 2. dotenv is a no-op here ─────────────────────────────────────────────────
// index.js calls dotenv.config({ override: true }), which would let a .env on
// disk overwrite every value above. Local runs must stay hermetic.
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = { id: dotenvPath, filename: dotenvPath, loaded: true,
  exports: { config: () => {
    if (fs.existsSync(path.join(ROOT, '.env'))) console.warn('[dev-local] .env present and IGNORED');
    return { parsed: {} };
  } } };

// ─── 3. In-memory database ─────────────────────────────────────────────────────
// Every export of server/db.js, plus `pool.query` (leaderboard.js and
// agarLeaderboard.js query the pool directly). Return shapes match db.js.
const accounts     = new Map();   // id -> { name, totalEarnings, gamesPlayed, playTimeSeconds, nameHistory, createdAt }
const houseRevenue = [];
/* The stake rows and owed payouts (server/db.js STATUS items 7a and 7b), modelled statement for
   statement by scripts/memLedgerDb.js. DEV_LOCAL_SEED_STAKES (a JSON array of rows) plants
   stakes before the server boots, so a test can see the boot refund; the model is exported for
   tests that load this script in their own process. */
const ledgerDb = require('./memLedgerDb').createMemLedgerDb();
if (process.env.DEV_LOCAL_SEED_STAKES) {
  for (const row of JSON.parse(process.env.DEV_LOCAL_SEED_STAKES)) ledgerDb.seedStake(row);
}
const acct = (id, name) => {
  if (!accounts.has(id)) accounts.set(id, { id, name: name || 'Player', totalEarnings: 0, gamesPlayed: 0,
                                             playTimeSeconds: 0, nameHistory: [], createdAt: new Date() });
  return accounts.get(id);
};
const profileOf = (a) => ({ name: a.name, totalEarnings: a.totalEarnings, gamesPlayed: a.gamesPlayed,
                            playTimeSeconds: a.playTimeSeconds });
const dbStub = {
  pool: { query: async () => ({ rows: [], rowCount: 0 }) },
  init: async () => {},
  recordGameResult: async (id, score, secs) => { const a = acct(id); a.gamesPlayed++; a.playTimeSeconds += secs || 0; },
  recordAgarGameResult: async (id) => { acct(id).gamesPlayed++; },
  recordWithdrawal: async () => {},
  recordCollusionFlag: async () => {},
  getRecentCollusionFlags: async () => [],
  markStakeSig: ledgerDb.markStakeSig,
  claimStakeSig: ledgerDb.claimStakeSig,
  claimStakeSeat: ledgerDb.claimStakeSeat,
  refundStakeOwed: ledgerDb.refundStakeOwed,
  listUnsettledStakes: ledgerDb.listUnsettledStakes,
  recordFailedPayout: ledgerDb.recordFailedPayout,
  getFailedPayouts: ledgerDb.getFailedPayouts,
  // The drainer sees nothing due, ever: there is no escrow here to pay from. Owed rows stay in
  // ledgerDb.payouts for a test to read.
  claimDuePayout: async () => null,
  deferPayoutNoAccount: async () => {},
  returnPayoutToLane: async () => {},
  savePayoutSignature: async () => {},
  markPayoutPaid: async () => {},
  features: ledgerDb.features,
  NO_USDC_ACCOUNT: ledgerDb.NO_USDC_ACCOUNT,
  recordEarnings: async (id, name, amount) => { const a = acct(id, name); a.name = name || a.name; a.totalEarnings += Number(amount) || 0; },
  recordStake: async () => {},
  getTopEarners: async (n) => [...accounts.values()].filter(a => a.totalEarnings > 0)
    .sort((x, y) => y.totalEarnings - x.totalEarnings).slice(0, n)
    .map((a, i) => ({ rank: i + 1, name: a.name, earnings: a.totalEarnings })),
  getGlobalWinnings: async () => [...accounts.values()].reduce((s, a) => s + a.totalEarnings, 0),
  searchPlayerNames: async (q, limit = 8) => [...accounts.values()]
    .filter(a => a.name.toLowerCase().includes(String(q).toLowerCase())).slice(0, limit).map(a => a.name),
  setAccountName: async (id, name) => { const a = acct(id); a.nameHistory.push(a.name); a.name = name; },
  getMyProfile: async (id) => { const a = accounts.get(id); return a ? { ...profileOf(a), nameHistory: a.nameHistory,
    joinedAt: a.createdAt, games: [], stakes: [], totalStaked: 0, stakesTracked: false } : null; },
  getProfile: async (name) => { const a = [...accounts.values()].find(x => x.name.toLowerCase() === String(name).toLowerCase());
    return a ? { ...profileOf(a), history: { week: [], month: [], sixMonth: [], allTime: [] } } : null; },
  addCosmetic: async () => {},
  getOwnedCosmetics: async () => [],
  recordHouseRevenue: async (row) => { houseRevenue.push({ ...row, created_at: new Date() }); },
  getHouseRevenueSummary: async () => { const total = houseRevenue.reduce((s, r) => s + (Number(r.amountUsdc) || 0), 0);
    return { total, count: houseRevenue.length, today: total, last7: total, last30: total, bySource: [], byLobby: [] }; },
  getHouseRevenueDaily: async () => [],
  getRecentHouseRevenue: async () => [],
};
const dbPath = require.resolve(path.join(ROOT, 'server', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };

// ─── 4. Outbound network guard ─────────────────────────────────────────────────
// Refuses every outbound http/https/fetch from this process and logs the host
// once. This is what makes "never touches mainnet or a real database" a fact
// rather than a hope: even a value leaking in from somewhere cannot get out.
// (@solana/web3.js captures globalThis.fetch at load time, so this must run
// before server/index.js is required.)
const seenHosts = new Set();
const note = (host, via) => {
  if (seenHosts.has(host)) return;
  seenHosts.add(host);
  console.warn(`[dev-local] BLOCKED outbound ${via} -> ${host}`);
};
const hostOf = (a) => {
  try {
    if (typeof a === 'string') return new URL(a).host;
    if (a instanceof URL) return a.host;
    if (a && typeof a === 'object') return a.hostname || a.host || (a.url && new URL(a.url).host) || '?';
  } catch (_) {}
  return '?';
};
for (const [mod, label] of [[http, 'http'], [https, 'https']]) {
  for (const fn of ['request', 'get']) {
    mod[fn] = function blockedRequest(...args) {
      const host = hostOf(args[0]);
      note(host, `${label}.${fn}`);
      // A ClientRequest look-alike that fails asynchronously, so every caller's
      // own error handler runs (notify.js, the PostHog proxy, node-fetch).
      const req = new EventEmitter();
      Object.assign(req, { write: () => true, end: () => req, setTimeout: () => req, setHeader: () => req,
                           destroy: () => req, abort: () => req, flushHeaders: () => {} });
      process.nextTick(() => req.emit('error', new Error(`dev-local: outbound network blocked (${host})`)));
      return req;
    };
  }
}
globalThis.fetch = async (input) => {
  const host = hostOf(input);
  note(host, 'fetch');
  throw new Error(`dev-local: outbound network blocked (${host})`);
};

// ─── 5. Boot the real server ───────────────────────────────────────────────────
console.log(`[dev-local] pid ${process.pid}  port ${PORT}  db=in-memory  network=blocked`);
console.log(`[dev-local] throwaway owner wallet ${ownerWallet}`);
console.log(`[dev-local] throwaway owner secret (bs58, local only) ${bs58.encode(ownerSecret)}`);
require(path.join(ROOT, 'server', 'index.js'));
module.exports = { ledgerDb };
