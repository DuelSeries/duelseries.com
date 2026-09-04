require('dotenv').config({ override: true });
const express    = require('express');
const http       = require('http');
const https      = require('https');
const { Server } = require('socket.io');
const path       = require('path');
const { rateLimit } = require('express-rate-limit');
const C        = require('../shared/constants');
const GameRoom = require('./GameRoom');
const AgarRoom      = require('./AgarRoom');
const { BattleRoyaleRoom, BR } = require('./BattleRoyaleRoom');
const agarLb        = require('./agarLeaderboard');
const db     = require('./db');
const collusion = require('./CollusionMonitor');
const profiler = require('./profiler');
const Wallet = require('./Wallet');
const allTimeLb = require('./leaderboard');
const prices = require('./prices');
const money = require('./money'); // SOL- or USDC-denominated money backend (picked by MONEY_MODE)
const Usdc  = require('./Usdc');  // USDC primitives — used directly by the cosmetics shop (always USDC)
const notify = require('./notify'); // owner phone pushes (ntfy) — e.g. new-player alerts
const analytics = require('./analytics'); // server-side PostHog capture (money events)
const nameProof = require('./nameProof'); // a wallet signing for its own name change
const ownerAuth = require('./ownerAuth'); // the owner wallet signing for an owner action
const ops       = require('./ops');       // maintenance mode

const REGION = process.env.REGION || 'na';

// Record a house money event to BOTH our own ledger (source of truth) and PostHog (dashboards).
// amountUsdc is signed: positive = revenue (rake, skins), negative = cost (bot entries).
function trackEarning(opts) {
  db.recordHouseRevenue(opts).catch(() => {});
  analytics.captureEarning(opts);
}

// All house revenue sweeps to the owner's OWN Phantom wallet ("DuelSeries earned"), kept separate
// from the escrow (player funds) and from the embedded owner/login wallet.
const REVENUE_WALLET = '24tf4BRDWvnAjFhpPxKczZSnWdUjKkVbXAc8x7Yj4Fff';

// Move a rake cut out of the escrow to the revenue wallet. Best-effort + non-blocking: the player's
// payout already happened, so a failed sweep is queued to the failed-payout drainer (retried
// idempotently, money never lost). The very first sweep also creates the revenue wallet's USDC ATA.
function sweepRake(amountUsdc, label) {
  if (!(amountUsdc > 0)) return;
  money.withdraw(REVENUE_WALLET, amountUsdc)
    .then((sig) => console.log(`[RAKE] swept ${Number(amountUsdc).toFixed(6)} ${money.unit} -> revenue wallet (${label}) sig ${String(sig).slice(0, 12)}`))
    .catch((e) => {
      console.error(`[RAKE] sweep failed (${label}) for ${amountUsdc}: ${e.message}`);
      db.recordFailedPayout(REVENUE_WALLET, amountUsdc, 'rake-sweep', `rake ${label}: ${e.message}`, e.broadcast).catch(() => {});
    });
}

// (Phase 4d: the old per-account Privy SERVER wallet provisioning was removed — players use
// their own client-side Privy embedded wallet now, so no server wallet is created on login.)

// ─── Socket rate limiter ──────────────────────────────────────────────────────
// Returns false (and drops the event) if the socket fires it too quickly.
function socketRL(socket, key, minMs) {
  const now = Date.now();
  if (!socket._rl) socket._rl = {};
  if (socket._rl[key] && now - socket._rl[key] < minMs) return false;
  socket._rl[key] = now;
  return true;
}

// Sanitize a player-supplied display name: strip markup (< >) and control characters, trim, and
// cap length. Defense in depth — the client escapes names on render today, but names are stored,
// used as leaderboard keys, and broadcast to every other player, so they must never carry markup
// or control chars in the first place. Falls back to 'Player' if nothing usable remains.
function sanitizeName(name) {
  return (String(name == null ? '' : name).replace(/[<>]/g, '').trim().slice(0, 20)) || 'Player';
}

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET env var is not set in production.');
  process.exit(1);
}

Wallet.setDb(db);
Wallet.seedUsedSignatures();
allTimeLb.setDb(db);
agarLb.setDb(db);

const app    = express();
const server = http.createServer(app);
// Origins allowed to call this server cross-origin: the NA + EU domains (so the lobby on
// duelseries.com can stake against the EU game server it's about to play on) plus local dev.
const ALLOWED_ORIGINS = ['https://duelseries.com', 'https://www.duelseries.com', 'https://eu.duelseries.com', 'http://localhost:3000'];
const io     = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    credentials: true,
  },
  pingInterval: 5000,   // heartbeat every 5s (default 25s) — keeps mobile WiFi radio awake
  pingTimeout:  10000,  // declare dead after 10s of no response (default 20s)
});

// Prevent Render 502s — match their load balancer keep-alive timeout
server.keepAliveTimeout = 120000;
server.headersTimeout   = 121000;

app.set('trust proxy', 1); // Render runs behind a proxy

// CORS for the HTTP API. Paid play must stake against the REGIONAL game server (e.g.
// eu.duelseries.com) so the one-time entry token is minted on the same server that consumes
// it on join — otherwise paid EU lobbies never load. Echo allowed origins + answer preflight.
const _allowedOriginSet = new Set(ALLOWED_ORIGINS);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && _allowedOriginSet.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Init DB in background with retries — server listens immediately so health checks pass
(async () => {
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      await db.init();
      console.log('[DB] Connected');
      return;
    } catch (e) {
      console.error(`[DB] Init attempt ${attempt}/8 failed: ${e.message}`);
      await new Promise(r => setTimeout(r, Math.min(attempt * 2000, 15000)));
    }
  }
  console.warn('[DB] Could not connect — sessions may not persist');
})();

// ─── Privy server-side auth (Phase B: Privy is the ONLY login) ─────────────────
// Passport/Google OAuth, express-session, the trusted-device auto-login, and the
// Socket.io session sharing were all removed in Phase B2 — identity is the Privy
// wallet now (verified below), so there is no server session to maintain.
let PrivyClient = null;
try { ({ PrivyClient } = require('@privy-io/server-auth')); }
catch (e) { console.warn('[AUTH] @privy-io/server-auth unavailable — owner token auth disabled:', e.message); }
const privyServer = (PrivyClient && process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET)
  ? new PrivyClient(process.env.PRIVY_APP_ID, process.env.PRIVY_APP_SECRET)
  : null;
/* Owner's embedded game wallet — what the Privy login resolves to. Public, not
   a secret: it is an address, and it is on-chain anyway.

   ONE OWNER, AND IT IS WRITTEN HERE. The OWNER_WALLET env var used to add a
   second, and a second one had been sitting on the live box long enough that
   Owen no longer recognised it — an old wallet or a different account, still
   holding every control on the server. Nobody had done anything with it, but
   nobody knew it was there either, and that is the part worth fixing.

   Reading it from the environment is what made that possible. A value in a
   file on a box is invisible to code review, survives every deploy, and is
   remembered by nobody. In the code it shows up in a diff, and removing an
   owner is a commit rather than an SSH session. */
const OWNER_WALLET = 'C5cnzckMwH459eEURA8NwuZcKVFMExpRcbRSAuULH3m9';
const OWNER_WALLETS = new Set([OWNER_WALLET]);
if (process.env.OWNER_WALLET && process.env.OWNER_WALLET !== OWNER_WALLET) {
  console.warn('[AUTH] OWNER_WALLET is set in the environment to '
    + process.env.OWNER_WALLET + ' and is IGNORED. Owners are listed in the code.'
    + ' Delete the line from .env when convenient.');
}
/* The smoke test boots a real server and needs a key it actually holds. Gated
   behind a switch named for what it is, and refused outright in production, so
   it can never quietly become the hole this just closed. */
if (process.env.ALLOW_TEST_OWNER === '1' && process.env.TEST_OWNER_WALLET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[AUTH] ALLOW_TEST_OWNER is set in PRODUCTION. Refusing.');
    process.exit(1);
  }
  OWNER_WALLETS.add(process.env.TEST_OWNER_WALLET);
  console.warn('[AUTH] test owner wallet registered — not for production');
}

if (!privyServer) {
  console.warn('[AUTH] PRIVY_APP_ID / PRIVY_APP_SECRET not set — every token check will fail, '
    + 'so nothing that needs a signed-in player (naming, owner actions) can work.');
}

// userId -> Solana wallet. getUser(userId) is documented as "subject to strict rate
// limits", and it used to run on EVERY authenticated request; one hand on a phone and
// one on a laptop is enough to start getting throttled, and a throttle came back as an
// indistinguishable null. So it is looked up once and kept.
//
// Ten minutes, not forever: this feeds the OWNER check as well as naming, and a wallet
// CAN change under a user if they link a different one. A cache that never expires would
// hold an owner grant, or an account identity, past the moment it stopped being true.
const _walletForUser = new Map();
const WALLET_CACHE_MS = 10 * 60 * 1000;

/* Resolve the Solana wallet behind a Privy login.
 *
 * Returns { wallet, reason }. The reason is the whole point of the rewrite: this used
 * to be one try/catch returning null, so "Privy is not configured on this server",
 * "your token expired", "Privy throttled us" and "this account has no Solana wallet"
 * were the same answer, and the player was told the same useless thing for all four.
 *
 * Two tokens are accepted. The identity token is preferred because getUser({idToken})
 * carries the linked accounts with it and is not rate limited; the access token is the
 * fallback, since identity tokens have to be switched on for the app and an older
 * cached login only has the access one. */
async function walletFromIdToken(accessToken, identityToken) {
  if (!privyServer) return { wallet: null, reason: 'privy-not-configured' };
  if (!accessToken && !identityToken) return { wallet: null, reason: 'no-token' };

  const solanaOf = user => {
    for (const a of ((user && user.linkedAccounts) || [])) {
      if (a && a.type === 'wallet' && (a.chainType === 'solana' || a.chain_type === 'solana') && a.address) return a.address;
    }
    return null;
  };

  if (identityToken) {
    try {
      const wallet = solanaOf(await privyServer.getUser({ idToken: identityToken }));
      if (wallet) return { wallet, reason: 'ok' };
      return { wallet: null, reason: 'no-solana-wallet' };
    } catch (e) {
      // Fall through to the access token rather than failing here: an identity token
      // is only present when the app has them enabled, and a stale one is not a reason
      // to reject a login that is otherwise good.
      console.warn('[AUTH] identity token rejected:', e.message);
    }
  }

  /* Before this rewrite the privy-id-token header was read as an ACCESS token and
     verified as one. Nothing we ship sends it that way, but anything that does must
     not start failing, so a rejected identity token gets one more try down the old
     path rather than being dropped. */
  const bearer = accessToken || identityToken;
  let claims;
  try {
    claims = await privyServer.verifyAuthToken(bearer);        // local JWT check
  } catch (e) {
    console.warn('[AUTH] access token rejected:', e.message);
    return { wallet: null, reason: accessToken ? 'bad-token' : 'bad-identity-token' };
  }
  const hit = _walletForUser.get(claims.userId);
  if (hit && Date.now() - hit.at < WALLET_CACHE_MS) return { wallet: hit.wallet, reason: 'ok' };
  try {
    const wallet = solanaOf(await privyServer.getUser(claims.userId));
    if (!wallet) return { wallet: null, reason: 'no-solana-wallet' };
    _walletForUser.set(claims.userId, { wallet, at: Date.now() });
    return { wallet, reason: 'ok' };
  } catch (e) {
    console.warn('[AUTH] getUser failed:', e.message);
    return { wallet: null, reason: 'privy-lookup-failed' };
  }
}

/* Both tokens off a request, however the caller sent them. */
function tokensFrom(req) {
  const auth = req.headers.authorization || '';
  return {
    access: auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['privy-access-token'] || null),
    identity: req.headers['privy-id-token'] || null,
  };
}
async function isOwnerToken(idToken) {
  if (!idToken) return false;
  const { wallet } = await walletFromIdToken(idToken, null);
  return !!wallet && OWNER_WALLETS.has(wallet);
}
/* An owner-signed action, or null. The signature is checked first because it
   depends on nothing outside this process: no Privy, no app id, no network, no
   expiry. The token stays as a second route so anything already working keeps
   working. */
function ownerFromSignature(body) {
  const wallet = ownerAuth.walletForAction(body);
  return (wallet && OWNER_WALLETS.has(wallet)) ? wallet : null;
}
// Owner check for HTTP routes — a signature from an owner wallet, or a Privy token.
async function isOwnerReq(req) {
  if (ownerFromSignature(req.body)) return true;
  const { access, identity } = tokensFrom(req);
  const { wallet } = await walletFromIdToken(access, identity);
  return !!wallet && OWNER_WALLETS.has(wallet);
}

// ─── PostHog reverse proxy ───────────────────────────────────────────────────
// Route analytics through our own domain so ad blockers can't block tracking.
// Registered BEFORE the JSON body parser so we can stream the raw request straight
// through untouched. /ingest/static/* -> the posthog-js asset host; everything else
// (capture, flags, session recording) -> the capture host.
app.all('/ingest/*', (req, res) => {
  const isStatic = req.path.startsWith('/ingest/static/');
  const host = isStatic ? 'us-assets.i.posthog.com' : 'us.i.posthog.com';
  const upstreamPath = req.originalUrl.replace(/^\/ingest/, '') || '/';
  const headers = { ...req.headers, host };
  const upstream = https.request({ hostname: host, port: 443, path: upstreamPath, method: req.method, headers }, (up) => {
    const h = { ...up.headers };
    delete h.connection; delete h['transfer-encoding'];
    res.writeHead(up.statusCode || 502, h);
    up.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.status(502).end(); });
  req.pipe(upstream);
});

app.use(express.json());
// (Phase B2: all /auth/* routes — Google OAuth, logout, /auth/me, the 2FA verify/resend
// flow, and /auth/update-name — were removed. Login is Privy-only; the display name is a
// client-side localStorage value, no longer a server-validated account field.)

// ─── Prices API ───────────────────────────────────────────────────────────────
app.get('/api/prices', (req, res) => {
  res.json({ solCadRate: prices.getSolCadRate() });
});

// Active money mode — tells the wallet widget whether to build SOL or USDC transfers and how to
// label balances. usdcMint is null in SOL mode.
app.get('/api/money-config', (req, res) => {
  // network lets the client build an explorer link that points at the cluster the
  // payout actually happened on, instead of guessing mainnet.
  res.json({ mode: money.mode, unit: money.unit, usdcMint: money.usdcMint || null, decimals: money.decimals || 6, network: process.env.SOLANA_NETWORK || 'mainnet-beta' });
});

// ─── Cross-region stats: EU pushes to NA instantly on every change ────────────
let remoteStats = { playerCount: 0, agarPlayerCount: 0, liveStakesSol: 0 };
const STATS_SECRET = process.env.SESSION_SECRET || 'duelseries-dev-secret';

// Both servers expose their local counts (used by EU to self-report)
app.get('/api/stats', (req, res) => {
  res.json({ playerCount: totalInGame(), agarPlayerCount: totalAgarInGame() });
});

// NA server receives pushed stats from EU
if (REGION === 'na') {
  app.post('/api/stats/push', express.json(), (req, res) => {
    if (req.headers['x-stats-secret'] !== STATS_SECRET) return res.sendStatus(403);
    remoteStats = { playerCount: req.body.playerCount || 0, agarPlayerCount: req.body.agarPlayerCount || 0, liveStakesSol: req.body.liveStakesSol || 0 };
    broadcastLobbyState();
    res.sendStatus(204);
  });
}

// EU server pushes its counts to NA whenever broadcastLobbyState runs
const NA_PUSH_URL = 'https://duelseries.com/api/stats/push';
async function pushStatsToNA() {
  if (REGION !== 'eu') return;
  try {
    await fetch(NA_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-stats-secret': STATS_SECRET },
      body: JSON.stringify({ playerCount: totalInGame(), agarPlayerCount: totalAgarInGame(), liveStakesSol: sumLiveSelfCustodyStakes() }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

// ─── HTTP rate limiters ───────────────────────────────────────────────────────
const walletWithdrawLimiter = rateLimit({ windowMs: 10 * 1000, max: 3, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many withdrawals. Please wait.' } });
const entryFeeLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down.' } });
// RPC/relay endpoints proxy to our paid Helius node — cap per-IP abuse without breaking the
// wallet's normal burst of calls. Generous to tolerate shared IPs / NAT.
const rpcLimiter = rateLimit({ windowMs: 10 * 1000, max: 100, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down.' } });

// ─── Entry fee ────────────────────────────────────────────────────────────────
const LOBBY_FEES = money.lobbyFees; // { free, dime, dollar } — the active money mode's fee table (keys validate lobby type)

// Server-authorised paid-entry tokens. /api/submit-stake mints one after verifying the
// player's on-chain stake landed in the escrow; PLAY / RESPAWN / cell:join verify + consume
// it and take the snake's cash worth from THIS server value — never from the client's
// claimed entrySol (a modified client could otherwise inflate it and mint money on
// cash-out). One-time use; carries the staker's wallet for the on-chain cash-out.
const crypto = require('crypto');
const { makeEntryStore } = require('./entryStore');
const ENTRY_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;

// The stake ladder: free, 0.25, 0.50, 1, 2, 5, 10, 20, 100. A closed set, so an
// amount is either on it or refused. See server/stakeRules.js.
const { STAKE_TIERS, ALL_STAKES, MIN_STAKE, MAX_STAKE,
        isStake, tierFor, stakeRangeError } = require('./stakeRules');

// The store is the same logic that used to be inline here, moved out so it can
// be tested directly (test/entryStore.test.js). The tier behaviour is unchanged.
const entryStore = makeEntryStore({ ttlMs: ENTRY_TOKEN_MAX_AGE_MS, fees: LOBBY_FEES,
                                    isStake: isStake });
// Sweep expired (paid-but-never-used) tokens so the map stays bounded.
setInterval(() => entryStore.sweep(), ENTRY_TOKEN_MAX_AGE_MS);

// Verify + consume an opaque paid-entry token the client echoes back from the
// /api/submit-stake response. The token is server-generated, unguessable, one-time, and
// carries the SERVER-recorded worth, so the client can neither forge it nor inflate the
// worth — that's what closes the entrySol escrow-drain hole. Needs no socket auth (the
// socket session is empty) and works for join + respawn identically.
/* The ladder's door. Same one-time, server-worth guarantee as the tier door
   below, but the token has to have been bought for this exact rung. */
function consumePaidEntryAtStake(entryToken, stake, game) {
  return recordEntry(entryStore.consumeAtStake(entryToken, stake), game);
}
function consumePaidEntry(entryToken, shortType, game) {
  return recordEntry(entryStore.consume(entryToken, shortType), game);
}
function recordEntry(r, game) {
  /* Record the buy-in here rather than at each call site: this is the one
     place every paid entry passes through, so the four join and respawn
     handlers cannot drift apart or forget one. Fire and forget, never awaited
     — a failed stats write must cost someone a row, never their seat in a
     game they have already paid for on-chain. */
  if (r.ok && r.worth > 0 && r.walletAddress) {
    db.recordStake(r.walletAddress, r.worth, game || null)
      .catch(e => console.error('[STAKE]', e.message));
  }
  return r;
}

// Phase 4d: the custodial entry-fee is gone — paid play stakes from the self-custody wallet
// (/api/stake-quote + /api/submit-stake issue the entry token). entryStore/consumePaidEntry
// stay; only what backs the token changed (a real on-chain stake, not a ledger debit).

// ─── Wallet API ───────────────────────────────────────────────────────────────

app.get('/wallet/debug', async (req, res) => {
  try {
    const sigs = await Wallet.getRecentSigs();
    res.json({ escrowPubkey: Wallet.getEscrowPublicKey(), sigs });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/wallet/info', (req, res) => {
  try {
    res.json({ escrowAddress: Wallet.getEscrowPublicKey(), network: Wallet.NETWORK });
  } catch (e) {
    res.status(500).json({ error: 'Wallet not configured on server' });
  }
});

// (Phase 4d: /wallet/provision removed — no server wallet to provision anymore.)

// Phase 4d: the custodial money system is gone. Deposits, withdrawals, the migration
// "settle" helper, and custodial-balance lookups are all removed — funding is the
// self-custody wallet (send SOL to it) and cash-out pays out on-chain to that wallet.
// `accounts.balance` + the `withdrawals` table are now vestigial.

// ─── Admin finance dashboard ──────────────────────────────────────────────────
app.get('/admin/finance', async (req, res) => {
  if (!(await isOwnerReq(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    const escrowBalance = await money.escrowBalance();
    // Self-custody: the escrow only owes the stakes currently live in-game (players hold
    // their own funds otherwise). The old `accounts.balance` sum is vestigial custodial data
    // and would show a phantom liability. Count BOTH regions since the escrow is shared.
    const totalOwed = totalLiveStakesSol();
    const profit = escrowBalance - totalOwed;
    res.json({ escrowBalance, totalOwed, profit, unit: money.unit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// (Phase 4d: /admin/reset-wallet removed along with the custodial server-wallet system.)

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/healthz', (req, res) => res.sendStatus(200));

// On-chain SOL balance for any address (public; reads via the server's Solana RPC so the
// browser never hits a rate-limited public RPC). Used by the self-custody wallet widget.
app.get('/api/sol-balance', rpcLimiter, async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'address required' });
  try {
    const sol = await money.balanceOf(address); // native unit (SOL or USDC); `sol` field kept for client back-compat
    res.json({ address, sol, balance: sol, unit: money.unit });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Browser → server Solana RPC proxy: the frontend's wallet SDK makes its RPC calls here
// so they go through our server's RPC instead of a public endpoint that blocks browser
// origins (403). Same-origin, so no CORS.
app.post('/api/rpc', rpcLimiter, async (req, res) => {
  try {
    res.type('application/json').send(await Wallet.forwardRpc(req.body));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Latest blockhash for the wallet to build a transfer (self-custody Cash Out / generic send).
app.get('/api/blockhash', rpcLimiter, async (req, res) => {
  try {
    const { blockhash } = await Wallet.getLatestBlockhash();
    res.json({ blockhash });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Broadcast a user-signed transaction (e.g. a self-custody Cash Out: wallet → external wallet).
// The tx is already signed by the player's own wallet; we just relay it + confirm over HTTP.
app.post('/api/broadcast', walletWithdrawLimiter, express.json({ limit: '256kb' }), async (req, res) => {
  const { signedTx } = req.body || {};
  if (!signedTx) return res.status(400).json({ error: 'Missing signed transaction' });
  try {
    const sig = await Wallet.submitStake(Buffer.from(signedTx, 'base64'));
    res.json({ ok: true, sig });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Self-custody staking (Phase 1) ───────────────────────────────────────────
// Quote how much SOL to stake for a paid lobby and where (the escrow), plus a fresh
// blockhash for the client to build the transfer. No custodial balance is touched.
app.get('/api/stake-quote', entryFeeLimiter, async (req, res) => {
  // Any-amount path, used by the redesigned lobby. Taken only when a `stake` is
  // supplied, so the tier path below is byte-for-byte what it was for the live
  // client. The two run side by side until cutover.
  if (req.query.stake !== undefined) {
    const stake = Number(req.query.stake);
    const bad = stakeRangeError(stake);
    if (bad) return res.status(400).json({ error: bad });
    if (stake === 0) return res.json({ stake: 0, escrowAddress: null, lamports: 0, feeSol: 0 });
    try {
      return res.json({ stake, ...(await money.stakeQuoteFor(stake)) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const lobbyType = req.query.lobbyType;
  const fee = LOBBY_FEES[lobbyType];
  if (fee === undefined) return res.status(400).json({ error: 'Unknown lobby' });
  if (fee === 0) return res.json({ lobbyType, escrowAddress: null, lamports: 0, feeSol: 0 });
  try {
    // The quote shape is money-mode specific (SOL: escrowAddress/lamports/feeSol; USDC:
    // escrowAta/usdcMint/units/amountUsdc). The client builds the matching transfer.
    res.json({ lobbyType, ...(await money.stakeQuote(lobbyType)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Submit a client-SIGNED stake (Privy signs only; we send + confirm over HTTP), then
// issue the entry token. This avoids the browser WebSocket the public RPC blocks.
app.post('/api/submit-stake', entryFeeLimiter, express.json({ limit: '256kb' }), async (req, res) => {
  const { lobbyType, stake, signedTx, walletAddress } = req.body || {};

  /* Ladder path. The requested rung is only a floor passed to verifyStake; the
     token is minted against what actually landed in escrow, resolved down to
     the largest rung that payment covers. So the room a player may enter is
     derived from what they really paid, never from what the request claimed:
     ask for the $100 room having paid $0.25 and you get the $0.25 room.

     Snapping down rather than demanding an exact match matters because by this
     point the stake has settled on-chain. A small overpay must still buy the
     rung it covers; refusing would leave someone out of pocket with no seat. */
  if (stake !== undefined) {
    const want = Number(stake);
    const bad = stakeRangeError(want);
    if (bad) return res.status(400).json({ error: bad });
    if (want === 0) return res.status(400).json({ error: 'Free play needs no stake' });
    if (!signedTx) return res.status(400).json({ error: 'Missing signed transaction' });
    try {
      const sig = await Wallet.submitStake(Buffer.from(signedTx, 'base64'));
      const { payer, worth } = await money.verifyStake(sig, money.amountFor(want));
      const rung = tierFor(worth);
      if (!rung) return res.status(400).json({ error: 'Payment did not cover any buy-in' });
      // Atomic one-time claim AFTER verify, as in the tier path below.
      if (!(await db.markStakeSig(sig))) return res.status(400).json({ error: 'Stake already used' });
      /* worth is the rung, not the raw payment: everyone in a room has to be
         worth the same on entry or the eat-and-take rule stops being symmetric.
         Any excess over the rung stays in escrow. */
      /* The payout address is the VERIFIED on-chain payer, never the one in
         the request. This used to be `walletAddress || payer`, so the address
         escrow eventually pays out to came from an unauthenticated field —
         the one client-supplied value in the money path that was still being
         trusted, after worth was carefully taken out of the client's hands.
         The real client always sets the tx fee payer to the player's own
         wallet, so the two agree; a request where they do not is either a bug
         or someone redirecting a payout, and is worth refusing loudly. */
      if (walletAddress && walletAddress !== payer) {
        return res.status(400).json({ error: 'Stake was paid by a different wallet' });
      }
      const entryToken = entryStore.mint({ stake: rung, worth: rung, walletAddress: payer });
      return res.json({ ok: true, entryToken, worth: rung, stake: rung, paid: worth });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  const fee = LOBBY_FEES[lobbyType];
  if (fee === undefined || fee === 0) return res.status(400).json({ error: 'Not a paid lobby' });
  if (!signedTx) return res.status(400).json({ error: 'Missing signed transaction' });
  try {
    const sig = await Wallet.submitStake(Buffer.from(signedTx, 'base64')); // broadcast (works for any signed tx)
    // Verify the stake landed in escrow and read the SERVER-recorded worth (SOL or USDC, per mode).
    const { payer, worth } = await money.verifyStake(sig, money.feeFor(lobbyType));
    // Atomic one-time claim AFTER verify — closes the double-mint race (two concurrent
    // requests with the same sig can't both pass) without burning a valid sig on a transient
    // verify failure. If it returns false, another request already consumed this stake.
    if (!(await db.markStakeSig(sig))) return res.status(400).json({ error: 'Stake already used' });
    // Same rule as the ladder path above: pay out to who actually paid.
    if (walletAddress && walletAddress !== payer) {
      return res.status(400).json({ error: 'Stake was paid by a different wallet' });
    }
    const entryToken = entryStore.mint({ lobbyType, worth, walletAddress: payer });
    res.json({ ok: true, entryToken, worth, worthSol: worth }); // worthSol kept for current client back-compat
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// (The cosmetics shop was removed — every skin is free now, so there is nothing
// to sell. db.addCosmetic/getOwnedCosmetics and the cosmetics_owned table are
// left in place like the other vestigial tables; historical revenue rows with
// source 'cosmetic' still show in the owner earnings feed.)

// (Phase B2 security: the legacy /api/verify-stake endpoint was removed — it duplicated
// /api/submit-stake's token minting and was unused by the client, so it only widened the
// attack surface. The silent-sign flow uses /api/submit-stake exclusively.)

// Owner-only: review collusion flags (persisted) + the current live suspicious pairs.
app.get('/api/admin/collusion', async (req, res) => {
  if (!(await isOwnerReq(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    const flags = await db.getRecentCollusionFlags(100);
    res.json({ flags, live: collusion.topPairs(25), config: collusion._config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Owner-only: where deposited SOL actually is (withdraw wallet vs sweep destination vs
// your own Privy deposit wallet). Pinpoints "balance credited but escrow empty".
app.get('/api/admin/escrow', async (req, res) => {
  if (!(await isOwnerReq(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    const diag = await Wallet.getEscrowDiagnostics();
    res.json(diag);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Owner-only: live solvency snapshot (escrow vs custodial ledger + live self-custody stakes).
app.get('/api/admin/solvency', async (req, res) => {
  if (!(await isOwnerReq(req))) return res.status(403).json({ error: 'Forbidden' });
  await checkSolvency();
  res.json(_lastSolvency || { error: 'no data yet' });
});

// Owner-only: cash-out payouts that failed on-chain (e.g. an RPC outage) and are owed but
// unpaid. Lets the owner see who's owed what and pay it out manually until an automatic
// drainer exists. `paid` rows are kept for the audit trail.
app.get('/api/admin/failed-payouts', async (req, res) => {
  if (!(await isOwnerReq(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    res.json(await db.getFailedPayouts(200));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Owner earnings: total house take (game rake + cosmetic sales) with a live feed.
app.get('/api/admin/earnings', async (req, res) => {
  if (!(await isOwnerReq(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    const [summary, recent, daily] = await Promise.all([
      db.getHouseRevenueSummary(),
      db.getRecentHouseRevenue(40),
      db.getHouseRevenueDaily(30),
    ]);
    res.json({ ...summary, recent, daily, unit: money.unit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Region / ping ────────────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, region: REGION, ts: Date.now() });
});

// Someone opened the site — ping the owner's phone (every top-level page load, per request).
// Obvious bots/crawlers/monitors are skipped so the pings stay real humans.
app.post('/api/track/visit', express.json({ limit: '8kb' }), (req, res) => {
  res.json({ ok: true });
  try {
    const ua = String(req.headers['user-agent'] || '');
    if (/bot|crawl|spider|slurp|bingpreview|monitor|uptime|headless|curl|wget|python-requests|facebookexternalhit/i.test(ua)) return;
    const page = String((req.body && req.body.page) || '/').slice(0, 40);
    const ref  = String((req.body && req.body.ref) || '').slice(0, 60);
    const country = req.headers['cf-ipcountry'] || '';
    notify.pushOwner(
      `Someone opened your site (${page})` + (country && country !== 'XX' ? ` from ${country}` : '') + (ref ? ` via ${ref}` : ''),
      { title: 'Site visit', tags: 'eyes' }
    );
  } catch (_) {}
});

// ─── Static files ─────────────────────────────────────────────────────────────
// All-time leaderboard API
app.get('/api/leaderboard', (req, res) => {
  res.json(allTimeLb.getTop(10));
});

app.get('/api/earningsboard', async (req, res) => {
  try {
    const top = await db.getTopEarners(10);
    res.json(top);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/profile/:name', async (req, res) => {
  try {
    const profile = await db.getProfile(req.params.name);
    if (!profile) return res.status(404).json({ error: 'Player not found' });
    res.json(profile);
  } catch (e) {
    console.error('[PROFILE]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// CAD genuinely paid out BEFORE the self-custody era's earnings_history (cad_amount) tracking
// existed. Added to the live tracked total so the public "winnings paid" figure reflects ALL
// real payouts — not a marketing inflation. Bump only when more historical payouts are reconciled.
const PRE_TRACKING_WINNINGS_CAD = 294;
app.get('/api/stats/winnings', async (req, res) => {
  try {
    const totalCad = await db.getGlobalWinnings();
    res.json({ totalCad: totalCad + PRE_TRACKING_WINNINGS_CAD });
  } catch (e) {
    res.json({ totalCad: 0 });
  }
});

app.get('/api/players/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const names = await db.searchPlayerNames(q);
    res.json(names);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/my-profile', async (req, res) => {
  // Identity is the Privy wallet now — the client passes its address. Stats/earnings are
  // recorded under the wallet (recordGameResult / recordEarnings), so this resolves them.
  const wallet = (req.query.wallet || '').trim();
  if (!wallet) return res.status(401).json({ error: 'No wallet' });
  try {
    const profile = await db.getMyProfile(wallet);
    if (!profile) return res.json({ totalEarnings: 0, gamesPlayed: 0, playTimeSeconds: 0, nameHistory: [], games: [] });
    res.json(profile);
  } catch (e) {
    console.error('[MY-PROFILE]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/* Set the display name for the signed-in account.

   The wallet is taken from the VERIFIED Privy token, never from the body. A
   body-supplied wallet would let anyone rename anyone: /api/my-profile already
   trusts a query wallet, but that only reads, and a write has to be the
   account it claims to be. */
app.post('/api/my-name', async (req, res) => {
  /* The wallet's own signature first, because it depends on nothing that can be
     misconfigured or throttled. The token stays as the fallback so older clients
     and anything already working keep working. */
  let wallet = nameProof.verifyNameProof(req.body), reason = 'ok';
  if (!wallet) {
    const { access, identity } = tokensFrom(req);
    ({ wallet, reason } = await walletFromIdToken(access, identity));
  }
  /* The reason travels to the client. Naming yourself failing with a shrug is
     what sent this round in circles: every distinct cause read as "could not
     reach your account", so there was nothing to act on. */
  if (!wallet) return res.status(401).json({ error: 'Sign in first', reason });
  const name = sanitizeName(req.body && req.body.name);
  if (!name || name.length < 3) return res.status(400).json({ error: 'Name too short' });
  try {
    await db.setAccountName(wallet, name);
    res.json({ ok: true, name });
  } catch (e) {
    if (e && e.code === 'NAME_TAKEN') return res.status(409).json({ error: 'Name taken' });
    console.error('[MY-NAME]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ─── The owner console ──────────────────────────────────────────────────────
   One endpoint for every control, because the alternative is a route per button
   and a new auth mistake with each one. The action name is inside the signed
   message, so a signature for 'bots' cannot be replayed as 'maintenance'.

   Everything here is refused unless an OWNER wallet signed it. A signature is
   good for two minutes and exactly once. */
const ALL_SNAKE_ROOMS = () => {
  const out = [];
  for (const rgn of Object.keys(gameRooms)) {
    for (const k of Object.keys(gameRooms[rgn] || {})) out.push(gameRooms[rgn][k]);
  }
  if (typeof ladder !== 'undefined' && ladder && ladder.rooms) {
    for (const e of ladder.rooms.values()) if (e && e.room) out.push(e.room);
  }
  return out;
};
const ALL_ROOMS = () => {
  const out = ALL_SNAKE_ROOMS();
  for (const rgn of Object.keys(agarRooms)) {
    for (const k of Object.keys(agarRooms[rgn] || {})) out.push(agarRooms[rgn][k]);
  }
  return out;
};

/* What the console shows. Readable by an owner only: it carries live player
   counts and staked worth, which is nobody else's business. */
function opsSnapshot() {
  const br = gameRooms[REGION] && gameRooms[REGION].br;
  const rooms = ALL_ROOMS().map(r => ({
    id: r.lobbyType,
    game: r.isBattleRoyale ? 'battle royale' : (String(r.lobbyType).startsWith('agar') ? 'agar.io' : 'slither.io'),
    players: r.playerCount !== undefined ? r.playerCount : (r.players ? r.players.size : 0),
    bots: r.botCount !== undefined ? r.botCount : 0,
  }));
  return {
    now: Date.now(),
    region: REGION,
    uptimeSec: Math.round(process.uptime()),
    maintenance: ops.get(),
    drain: ops.drainStatus(ALL_ROOMS()),
    battleRoyale: br ? br.publicState() : null,
    rooms,
    audit: ownerAuth.auditLog.slice(0, 25),
  };
}

app.post('/api/owner/state', async (req, res) => {
  if (!(await isOwnerReq(req))) return res.status(403).json({ error: 'Not an owner' });
  res.json(opsSnapshot());
});

app.post('/api/owner/do', async (req, res) => {
  const who = ownerFromSignature(req.body);
  if (!who && !(await isOwnerReq(req))) {
    return res.status(403).json({ error: 'Not an owner' });
  }
  const action = String((req.body && req.body.action) || '');
  const args = (req.body && req.body.args) || {};
  const done = (note) => { ownerAuth.audit(action, args, who || 'token', true, note);
                           res.json({ ok: true, note, state: opsSnapshot() }); };
  const refuse = (why) => { ownerAuth.audit(action, args, who || 'token', false, why);
                            res.status(409).json({ error: why, state: opsSnapshot() }); };

  const br = gameRooms[REGION] && gameRooms[REGION].br;

  switch (action) {
    /* Start the nightly match. `force` is for testing it alone: the two-player
       minimum is there to stop a real match being 'won' by the only person in
       the room, and the owner deliberately overriding that on an empty evening
       is not the case it protects against. */
    case 'br:start': {
      if (!br) return refuse('No battle royale room');
      if (br.state === 'running') return refuse('A match is already running');
      if (args.force) {
        if (br.livingCount() < 1) return refuse('Nobody is in the room to start with');
        br.forceStart('owner override');
        return done('Started with ' + br.livingCount() + ' player(s), minimum overridden');
      }
      if (!br.canStart()) return refuse('Needs ' + br.publicState().minPlayers + ' players');
      br.startMatch('owner');
      return done('Started with ' + br.livingCount() + ' players');
    }
    case 'br:stop': {
      if (!br || br.state !== 'running') return refuse('No match is running');
      br.abandon();
      return done('Match stopped, no prize paid');
    }

    /* Bots, per room and reversible. The old control could only add, could only
       add to whatever room the owner's own socket happened to be in, and had no
       way to take them out again. */
    case 'bots:add':
    case 'bots:clear': {
      const room = ALL_SNAKE_ROOMS().find(r => r.lobbyType === args.room);
      if (!room) return refuse('No room called ' + args.room);
      if (action === 'bots:clear') {
        let removed = 0;
        for (const [id, s] of [...room.snakes]) {
          if (s && s.isBot) { room.snakes.delete(id); removed++; }
        }
        broadcastLobbyState();
        return done('Removed ' + removed + ' bot(s) from ' + room.lobbyType);
      }
      const n = Math.min(Math.max(1, parseInt(args.count, 10) || 1), 30);
      if (!room.addBot) return refuse('That room does not take bots');
      for (let i = 0; i < n; i++) room.addBot();
      broadcastLobbyState();
      return done('Added ' + n + ' bot(s) to ' + room.lobbyType);
    }

    /* Maintenance. Turning it ON is always allowed — the point of it is to stop
       the bleeding — but calling the game DOWN while somebody has a stake on
       the table is refused, with the number, because their worth only exists
       while their snake does. */
    case 'maintenance:on':
      ops.set({ on: true, message: args.message, minutes: args.minutes });
      io.emit('maintenance', ops.get());
      return done('Maintenance on. New games refused.');
    case 'maintenance:off':
      ops.set({ on: false });
      io.emit('maintenance', ops.get());
      return done('Maintenance off. The game is open.');
    case 'maintenance:check': {
      const d = ops.drainStatus(ALL_ROOMS());
      return d.safe ? done('Safe to restart: nobody has money on the table.')
                    : refuse(d.reason + ' (' + d.paidWorth + ' USDC live)');
    }

    /* Something to say to everyone who is currently in a game. */
    case 'announce': {
      const text = String(args.text || '').slice(0, 200);
      if (!text) return refuse('Nothing to say');
      io.emit('announce', { text, at: Date.now() });
      return done('Sent to everyone in a game');
    }

    default:
      return refuse('Unknown action: ' + action);
  }
});

/* Why owner auth is failing, without leaking anything that is a secret. A Privy
   app id is not one — it ships inside the browser bundle — and the whole reason
   this exists is that a flat 401 gave nothing to act on. */
/* Owner-only, like everything else here. It was ungated so it could be used
   WHEN owner auth was broken — but it also answered with the list of wallets
   that control the server, to anyone who asked, which is a map for somebody
   deciding what to attack. The signature path does not depend on Privy, so it
   still works in exactly the case this exists for. */
app.post('/api/owner/diagnose', async (req, res) => {
  /* Verified ONCE and the answer kept. A signature is good for a single use, so
     checking the gate and then checking it again inside the handler burns it on
     the way in and reports the caller as a forgery. */
  const signed = ownerFromSignature(req.body);
  if (!signed && !(await isOwnerReq(req))) return res.status(403).json({ error: 'Not an owner' });
  const { access, identity } = tokensFrom(req);
  const out = {
    privyConfigured: !!privyServer,
    serverAppId: process.env.PRIVY_APP_ID || null,
    ownerWallets: [...OWNER_WALLETS],
    sentAccessToken: !!access,
    sentIdentityToken: !!identity,
    signature: null, token: null,
  };
  out.signature = signed
    ? { wallet: signed, isOwner: OWNER_WALLETS.has(signed) }
    : { wallet: null, isOwner: false };
  if (access || identity) {
    const r = await walletFromIdToken(access, identity);
    out.token = { wallet: r.wallet, reason: r.reason, isOwner: !!r.wallet && OWNER_WALLETS.has(r.wallet) };
  }
  /* The token's own audience, read WITHOUT verifying it. If this and
     serverAppId differ, that is the whole bug: the box is checking tokens
     against a different Privy app than the one that minted them. */
  if (access) {
    try {
      const payload = JSON.parse(Buffer.from(access.split('.')[1], 'base64').toString('utf8'));
      out.tokenAudience = payload.aud || null;
      out.tokenExpired = payload.exp ? (payload.exp * 1000 < Date.now()) : null;
      out.audienceMatchesServer = out.serverAppId ? (String(payload.aud) === String(out.serverAppId)) : null;
    } catch (_) { out.tokenAudience = 'unreadable'; }
  }
  res.json(out);
});

/* A wallet's own money in and out. Read-only and entirely public information —
   it is the chain — so this takes the address as a query param the way
   /api/my-profile does, rather than requiring a token to look at something
   anybody can already look at in an explorer. */
app.get('/api/my-transactions', async (req, res) => {
  const wallet = (req.query.wallet || '').trim();
  if (!wallet) return res.status(400).json({ error: 'No wallet' });
  try {
    const rows = await Usdc.usdcHistory(wallet, 12);
    res.json({ transactions: rows });
  } catch (e) {
    console.error('[MY-TX]', e.message);
    res.status(502).json({ error: 'Could not reach the chain' });
  }
});

app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

/* The lobby. Declared BEFORE express.static, which would otherwise serve a
   file for '/' and win.

   /v2 is kept as an alias because it was the migration URL and is in people's
   history and in the docs; it costs one line and breaks nothing.

   The old lobby and its /legacy escape hatch were deleted 2026-08-19, after
   the redesign had held on mainnet through real entry and cash-out. The way
   back now is git, which is what it should have been once the new one was
   carrying real money. */
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '../public/v2.html')));
app.get('/v2', (_req, res) => res.sendFile(path.join(__dirname, '../public/v2.html')));
/* The owner console, without the file extension. The page itself is not a
   secret and does not need to be — it shows nothing and does nothing until an
   owner wallet signs for it, and every route behind it checks that server-side.
   Keeping the URL obscure would be the only protection it did NOT have. */
app.get('/owner', (_req, res) => res.sendFile(path.join(__dirname, '../public/owner.html')));

app.use(express.static(path.join(__dirname, '../public')));
app.use('/shared', express.static(path.join(__dirname, '../shared')));

// ─── Game rooms (one per region + lobby type) ────────────────────────────────
const REGIONS = ['na', 'eu'];
const gameRooms = {};
const agarRooms = {};
// Only host the rooms for THIS server's region. Building every region on every
// server meant the NA box ran 6 snake rooms + 6 agar rooms — 12 loops at 60Hz on
// a single vCPU — half of them for a region whose server is stopped and which is
// crossed out in the lobby, so nobody could reach them. That constant background
// load is what kept ~2% of ticks running late even between the periodic spikes.
// The room lookups fall back to this region, so a stale client asking for another
// region still lands somewhere valid.
for (const rgn of [REGION]) {
  gameRooms[rgn] = {
    free:   new GameRoom(io, `${rgn}_free`),
    dime:   new GameRoom(io, `${rgn}_dime`),
    dollar: new GameRoom(io, `${rgn}_dollar`),
    /* The nightly event. Its own room and its own lobby type, deliberately NOT
       on the buy-in ladder: entry is free and the prize comes from the house,
       so there is no stake here to get wrong. */
    br:     new BattleRoyaleRoom(io, `${rgn}_br`),
  };
  agarRooms[rgn] = {
    free:   new AgarRoom(io, `agar_${rgn}_free`),
    dime:   new AgarRoom(io, `agar_${rgn}_dime`),
    dollar: new AgarRoom(io, `agar_${rgn}_dollar`),
  };
  Object.values(gameRooms[rgn]).forEach(r => r.start());
  Object.values(agarRooms[rgn]).forEach(r => r.start());
}

/* ─── The live board ──────────────────────────────────────────────────────────
   One flat list of what a player can join right now, which is what the
   redesigned lobby renders instead of a per-game page.

   This reports the rooms that exist TODAY, keyed by tier, translated into the
   board's shape. It deliberately does not use LobbyRegistry yet: swapping the
   live room lifecycle is the one part of the stake migration that can strand a
   player mid-game, so it happens at cutover behind the mainnet gate, not here.
   The shape is already the any-amount one, so the client does not change when
   the rooms underneath it do.

   Bot-seeded rooms mean `players` is never the whole story — a room with only
   bots still shows as joinable, which is the point: the board is never empty. */
function liveBoard() {
  /* The ladder only. The fixed tier rooms still exist and still serve
     index.html, but they are not on this board: listing both would show a $1
     room twice under two different names, and would offer the $0.10 tier,
     which is not a rung anyone can pick here.

     Every rung is listed whether or not a room exists for it yet, because a
     rung with no room is precisely what a player needs to be able to open. A
     board showing only rooms somebody already made is the cold start this
     redesign exists to avoid. */
  const live = new Map(ladder.list()
    .filter(l => l.game === 'snake')
    .map(l => [l.stake, l]));
  const out = ALL_STAKES.map(rung => {
    const hit = live.get(rung);
    return {
      id: `snake:${REGION}:s${rung}`,
      game: 'snake', region: REGION,
      stake: rung,
      players: hit ? hit.players : 0,
      bots: hit ? (hit.bots || 0) : 0,
      /* Null, not a number. Persistent rooms have no seat limit: the world
         grows with the crowd rather than filling up, so there is nothing to
         be "7 of" and the prototype's /30 was invented. */
      capacity: null,
      state: 'open',
    };
  });
  // Busiest first: players converge on rooms that already have people, and that
  // convergence is what stops the player base fragmenting across empty rooms.
  return out.sort((a, b) => b.players - a.players);
}
app.get('/api/live', (_req, res) => {
  try {
    /* The ladder ships with the board so the buy-in control offers exactly the
       rungs the server will accept. A client with its own copy is a client
       that can drift out of step and offer an amount that gets refused. */
    res.json({ lobbies: liveBoard(), stakes: ALL_STAKES });
  } catch (e) { console.error('[LIVE]', e.message); res.json({ lobbies: [], stakes: ALL_STAKES }); }
});

/* ─── Ladder rooms ────────────────────────────────────────────────────────────
   Created on demand, one per (game, region, rung), and swept when they have
   been empty a while. They sit BESIDE the fixed tier rooms rather than
   replacing them: index.html players keep going to gameRooms exactly as
   before, and only a client that names a stake reaches these. That is what
   makes this safe to deploy before the ladder has been tested with real money
   — nothing routes here until a client asks. */
/* ── The nightly event: the clock, and the prize ─────────────────────────────

   Eastern wall clock read straight from Intl, never UTC plus a fixed offset. A
   hardcoded -5 is wrong for two thirds of the year and -4 for the other third,
   and the failure is silent — the event simply runs an hour out and nothing
   says which hour was right. Working in wall-clock seconds means the daylight
   saving switch takes care of itself. Same reasoning as the lobby countdown. */
const BR_PRIZE_USDC = 20;
const BR_AUTOSTART_HOUR = 20, BR_AUTOSTART_MIN = 5;   // 8:05pm Eastern
let _brFmt = null;
try {
  _brFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    hour12: false, hour: '2-digit', minute: '2-digit', year: 'numeric',
    month: '2-digit', day: '2-digit' });
} catch (_) { _brFmt = null; }
function easternNow() {
  const d = new Date();
  if (!_brFmt) return { hour: d.getHours(), minute: d.getMinutes(), day: d.toDateString() };
  const o = {};
  _brFmt.formatToParts(d).forEach(p => { if (p.type !== 'literal') o[p.type] = p.value; });
  const hour = Number(o.hour) === 24 ? 0 : Number(o.hour);   // some engines say 24 at midnight
  return { hour, minute: Number(o.minute), day: o.year + '-' + o.month + '-' + o.day };
}

/* Paid ONCE per match, keyed to the match id, by the server. Nothing the
   winning client sends is involved: the winner is the last snake the SERVER had
   alive, and this is called from the room, not from a socket. */
const _brPaid = new Set();
async function payBattleRoyaleWinner(room) {
  const w = room && room.winner;
  const matchId = room && room.matchId;
  if (!w || !matchId) return;
  if (_brPaid.has(matchId)) return;          // a reconnect or a double event must not pay twice
  _brPaid.add(matchId);
  if (!w.wallet) {
    console.warn(`[BR] ${matchId} won by ${w.name} but they have no wallet — nothing paid`);
    return;
  }
  try {
    const sig = await money.withdraw(w.wallet, BR_PRIZE_USDC);
    console.log(`[BR] paid ${BR_PRIZE_USDC} to ${w.name} (${w.wallet}) for ${matchId}: ${sig}`);
    try { await db.recordEarnings(w.wallet, w.name, BR_PRIZE_USDC); } catch (_) {}
    try {
      notify.pushOwner(`${w.name} took ${BR_PRIZE_USDC} USDC in ${matchId}`,
        { title: 'Battle Royale winner' });
    } catch (_) {}
  } catch (e) {
    /* Left in the set deliberately. A retry loop on a payout is how somebody
       gets paid twice; this surfaces instead so it can be settled by hand. */
    console.error(`[BR] PAYOUT FAILED for ${matchId} to ${w.wallet}:`, e.message);
    try {
      notify.pushOwner(`${matchId} to ${w.name}: ${e.message}`,
        { title: 'Battle Royale payout FAILED', priority: 'high' });
    } catch (_) {}
  }
}

/* One timer for the whole event: start it if nobody has by 8:05, and pay the
   winner the moment a match is decided. Ten seconds is plenty — the match runs
   for minutes and the payout only has to be prompt, not instant. */
let _brLastAutoDay = null;
setInterval(() => {
  const room = gameRooms[REGION] && gameRooms[REGION].br;
  if (!room) return;

  if (room.state === 'over' && room.winner && !_brPaid.has(room.matchId)) {
    payBattleRoyaleWinner(room).catch(e => console.error('[BR]', e.message));
  }

  const { hour, minute, day } = easternNow();
  const due = hour > BR_AUTOSTART_HOUR ||
              (hour === BR_AUTOSTART_HOUR && minute >= BR_AUTOSTART_MIN);
  /* Once a day, and only in the event's own hour. Without the day stamp a room
     that emptied and refilled at 9:40pm would start a second match nobody was
     expecting. */
  if (due && hour === BR_AUTOSTART_HOUR && _brLastAutoDay !== day && room.canStart()) {
    _brLastAutoDay = day;
    room.startMatch('auto 8:05pm ET');
  }
}, 10 * 1000);

const { LobbyRegistry } = require('./LobbyRegistry');
const ladder = new LobbyRegistry({
  emptyMs: 5 * 60 * 1000,
  makeRoom: (game, rgn, stake) =>
    new GameRoom(io, `${rgn}_s${String(stake).replace('.', '_')}`),
});
// Withdrawing rooms nobody is in is scheduled further down, through
// everyStaggered, along with every other periodic job.

/* Which room a join lands in. A stake wins when present, because only the
   ladder client sends one; everything else is the original tier lookup,
   untouched. */
function getRoomForJoin({ lobbyType, stake, region }) {
  const rgn = (region && gameRooms[region]) ? region : REGION;
  if (stake !== undefined && stake !== null && isStake(stake)) {
    return ladder.get('snake', rgn, Number(stake));
  }
  return getRoomForType(lobbyType, rgn);
}

function getRoomForType(lobbyType, region) {
  const rgn = (region && gameRooms[region]) ? region : REGION;
  return gameRooms[rgn][lobbyType] || gameRooms[rgn].free;
}

function getAgarRoomForType(lobbyType, region) {
  const rgn = (region && agarRooms[region]) ? region : REGION;
  return agarRooms[rgn][lobbyType] || agarRooms[rgn].free;
}

const lobbySocketsByGoogleId = new Map();
const lobbyConnections = new Set();

// Collusion monitor: persist flags to the DB and push a live alert to the owner's socket.
collusion.init({
  db,
  onFlag: (flag) => {
    const s = lobbySocketsByGoogleId.get(OWNER_WALLET);
    if (s) s.emit('admin:collusion_flag', flag);
  },
});

// ── Solvency monitor ─────────────────────────────────────────────────────────
// Continuously verify the escrow holds at least what it owes: the custodial ledger
// balances PLUS the live self-custody stakes currently sitting in escrow. Alerts the
// owner + logs the moment it drifts short (would have caught the ledger>escrow gap).
let _lastSolvency = null;
// Total SOL the escrow currently owes: every live, paid stake still in play across both
// games. Snake worth is already SOL; agar worth is CAD (converted). Paid play requires a
// connected wallet, so any live entity carrying worth > 0 is a self-custody staker. This —
// NOT the vestigial custodial `accounts.balance` — is the escrow's real liability.
function sumLiveSelfCustodyStakes() {
  let total = 0; // SOL
  const sumRoom = (room) => {
    for (const [sid, snake] of room.snakes) {
      if (!snake || !snake.alive) continue;
      const p = room.players.get(sid);
      if (p && p.socket && p.socket._walletAddress) total += snake.worth || 0;
    }
  };
  /* Ladder rooms hold real stakes exactly as the tier rooms do, so they are
     part of what the escrow owes. Counting only gameRooms under-reported the
     liability, which is the one number the solvency monitor exists to get
     right — it would have reported the escrow solvent while owing money. */
  for (const l of ladder.rooms.values()) sumRoom(l.room);
  for (const rgn of REGIONS) {
    for (const lt of Object.keys(gameRooms[rgn] || {})) {
      sumRoom(gameRooms[rgn][lt]);
    }
    for (const lt of Object.keys(agarRooms[rgn] || {})) {
      const room = agarRooms[rgn][lt];
      for (const p of room.players.values()) {
        if (p && p.alive && p.worth > 0) total += p.worth; // worth is in the active unit (SOL or USDC)
      }
    }
  }
  return total;
}
// The escrow is SHARED across the NA + EU servers, so its true liability is the live stakes
// on BOTH. Each region's local sum is reported cross-region (remoteStats.liveStakesSol, via
// the EU→NA push), and the NA dashboard/solvency add them. The owner reads the NA dashboard.
function totalLiveStakesSol() {
  return sumLiveSelfCustodyStakes() + (remoteStats.liveStakesSol || 0);
}
async function checkSolvency() {
  try {
    const escrow = await money.escrowBalance();
    const liveStakes = totalLiveStakesSol();
    const surplus = escrow - liveStakes;
    const solvent = surplus >= -1e-6;
    _lastSolvency = { escrowSol: escrow, liveStakesSol: liveStakes, requiredSol: liveStakes, surplusSol: surplus, solvent, ts: Date.now() };
    if (!solvent) {
      console.warn(`[SOLVENCY] SHORTFALL ${(-surplus).toFixed(6)} SOL — escrow ${escrow.toFixed(6)} < live stakes ${liveStakes.toFixed(6)}`);
      const s = lobbySocketsByGoogleId.get(OWNER_WALLET);
      if (s) s.emit('admin:solvency_alert', _lastSolvency);
    }
  } catch (e) {
    console.error('[SOLVENCY] check failed:', e.message);
  }
}
// Tick-lag readout. The sim, snapshots and every periodic job share one thread,
// so a blocked thread shows up to players as a ping spike. This reports how late
// ticks ran, with timestamps, so a spike can be lined up against the periodic
// jobs below (solvency 60s, payouts 30s, leaderboard flushes 30s). Perf timings
// only — no player, wallet or money data.
/* ── Garbage-collection pauses ────────────────────────────────────────────────
   With every periodic job now measured and all of them reporting zero, a stall
   that hits all rooms on the same tick has one remaining explanation on a
   single-threaded server: the collector stopped the world.

   That is a real candidate here rather than a shrug. The snapshot path
   allocates hard 30 times a second per room — a serialized copy of every
   snake, a bounds array, a minimap array, a fresh snakes/food array per
   interest cell, and typed arrays inside encodeSnapshot. Steady allocation at
   that rate gives major collections that arrive at roughly regular intervals
   and pause for exactly the 80-160ms being seen.

   This costs nothing when nothing is collecting, and it turns the last of the
   guesswork into timestamps that line up against the tick log. */
const _gc = { pauses: 0, totalMs: 0, worstMs: 0, worstAt: 0, recent: [] };
try {
  const { PerformanceObserver } = require('perf_hooks');
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const ms = e.duration;
      _gc.pauses++;
      _gc.totalMs += ms;
      if (ms > _gc.worstMs) { _gc.worstMs = ms; _gc.worstAt = Date.now(); }
      // A tick is 16.7ms, so anything near that can push one late on its own,
      // and a run of 10ms pauses is felt as jitter even though none is dramatic.
      if (ms > 10) {
        _gc.recent.push({ ms: Math.round(ms), at: Date.now(),
                          kind: (e.detail && e.detail.kind) || null });
        if (_gc.recent.length > 40) _gc.recent.shift();
      }
    }
  }).observe({ entryTypes: ['gc'] });
} catch (e) {
  console.warn('[GC] observer unavailable:', e.message);
}

/* ── Client stall reports ─────────────────────────────────────────────────────
   The hitch is only visible in the browser, so the browser measures it and
   posts a summary here. Kept in memory, last 30 reports, perf numbers only —
   no player, wallet or money data, and nothing that identifies a person beyond
   a truncated user-agent.

   This exists because three fixes were reasoned from server code toward a
   symptom only the player can see, and all three missed. */
const _clientReports = [];
app.post('/api/debug/client', express.json({ limit: '64kb' }), (req, res) => {
  const b = req.body || {};
  _clientReports.push({ at: Date.now(), ip: null, ...b });
  if (_clientReports.length > 30) _clientReports.shift();
  res.json({ ok: true });
});
app.get('/api/debug/client', (_req, res) => {
  res.json({
    now: Date.now(),
    reports: _clientReports.map(r => ({ ...r, agoSec: Math.round((Date.now() - r.at) / 1000) })),
  });
});

/* The one instrument that can NAME the blocker. Tick lag says the thread died
   and the job timers say it was no job, so what remains is a stack trace from
   inside the stall. See server/profiler.js. */
app.get('/api/debug/profile', (_req, res) => res.json(profiler.report()));

app.get('/api/debug/tick', (_req, res) => {
  const mem = process.memoryUsage();
  const out = {
    now: Date.now(), tickRate: C.TICK_RATE, upSec: Math.round(process.uptime()),
    jobs: _jobStats,
    gc: {
      pauses: _gc.pauses,
      totalMs: Math.round(_gc.totalMs),
      worstMs: Math.round(_gc.worstMs),
      worstAgoSec: _gc.worstAt ? Math.round((Date.now() - _gc.worstAt) / 1000) : null,
      recent: _gc.recent.map(g => ({ ms: g.ms, agoSec: Math.round((Date.now() - g.at) / 1000), kind: g.kind })),
    },
    heap: {
      usedMB: Math.round(mem.heapUsed / 1048576),
      totalMB: Math.round(mem.heapTotal / 1048576),
      rssMB: Math.round(mem.rss / 1048576),
    },
    rooms: {},
  };
  for (const rgn of REGIONS) {
    for (const type of ['free', 'dime', 'dollar']) {
      const room = gameRooms[rgn] && gameRooms[rgn][type];
      const lag = room && room._lag;
      if (!lag || !lag.ticks) continue;
      const bc = room._bc;
      out.rooms[`${rgn}_${type}`] = {
        ticks: lag.ticks,
        lateTicks: lag.late,
        latePct: +(100 * lag.late / lag.ticks).toFixed(3),
        worstMs: Math.round(lag.worst),
        worstAgoSec: lag.worstAt ? Math.round((Date.now() - lag.worstAt) / 1000) : null,
        recent: lag.recent.map(r => ({ ms: r.ms, agoSec: Math.round((Date.now() - r.at) / 1000) })),
        // Whether the SERVER failed to send, as opposed to the packet arriving
        // late. The client sees 110-200ms snapshot gaps with no stall in the
        // tab; if these match, it is ours, and if these stay near 33ms it is
        // the network.
        broadcast: bc ? {
          sends: bc.count,
          lateSends: bc.late,
          worstMs: Math.round(bc.worst),
          worstAgoSec: bc.worstAt ? Math.round((Date.now() - bc.worstAt) / 1000) : null,
          recent: bc.recent.map(r => ({ ms: r.ms, agoSec: Math.round((Date.now() - r.at) / 1000) })),
        } : null,
      };
    }
  }
  res.json(out);
});

// Every background job here runs on a 30s or 60s period and they all start at
// boot, so every 60 seconds they fire on the SAME tick. The sim, the snapshot
// broadcast and all of these share one thread, so that pile-up is what players
// felt as a ping spike and half a second of jitter once a minute. Staggering
// gives each job its own offset so they can never land together. Nothing about
// what any job DOES changes — only when it runs.
const _jobStats = {};
/* How long to keep watching the loop after a job's promise settles. See the
   note by `settle` below: the expensive part of an async job happens after the
   await, not during it. */
const TAIL_MS = 3000;
function everyStaggered(fn, periodMs, offsetMs, label) {
  setTimeout(() => {
    const run = () => {
      const t0 = Date.now();
      let done = false;
      // Sample event-loop lag WHILE the job is in flight. The synchronous part of
      // an async job is usually trivial; the stall shows up when its promise
      // settles and the response is processed (TLS, parsing, retries). A timer
      // that should fire every 20ms but arrives much later means the loop was
      // blocked, and this attributes that to the job by name.
      let worstLag = 0, last = Date.now(), settledAt = 0;
      const probe = setInterval(() => {
        const now = Date.now();
        const lag = (now - last) - 20;
        if (lag > worstLag) worstLag = lag;
        last = now;
        if (done) clearInterval(probe);
      }, 20);
      probe.unref?.();
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(probe);
        if (worstLag > 50) {
          console.warn(`[JOB ${label}] ran ${settledAt - t0}ms, worst loop lag within ${TAIL_MS}ms of it ${Math.round(worstLag)}ms`);
        }
        _jobStats[label] = { lastMs: settledAt - t0, worstLagMs: Math.round(worstLag), at: Date.now() };
      };
      /* Keep sampling AFTER the promise settles. This is the blind spot that let
         solvency report worstLag 1 while a 60s stall kept happening: an async
         job's cost does not land while it is awaiting, it lands afterwards, as
         the response is parsed and the garbage it produced is collected. The
         old probe stopped at exactly the moment the interesting part began. */
      const settle = () => {
        if (settledAt) return;
        settledAt = Date.now();
        setTimeout(finish, TAIL_MS).unref?.();
      };
      try { Promise.resolve(fn()).then(settle, e => { console.error(`[JOB ${label}]`, e.message); settle(); }); }
      catch (e) { console.error(`[JOB ${label}]`, e.message); settle(); }
    };
    run();
    const t = setInterval(run, periodMs);
    t.unref?.();
  }, offsetMs).unref?.();
}

/* EVERY periodic job goes through here. Two things matter and both were missed
   last time this was "fixed": the offset keeps jobs off each other's tick, and
   the wrapper TIMES them, so /api/debug/tick can name whichever one is stalling
   the loop.

   Only solvency and payouts were ever wrapped. The leaderboard flush, the lobby
   sweeper and the collusion evaluator ran on bare intervals started at boot, so
   they collided every 60 seconds and nothing was measuring any of them. The
   flush was the expensive one: it issued a sequential UPDATE per cached player,
   up to a thousand round trips, while the simulation waited. */
/* OFF by default, and it must stay that way while anyone is playing.
   It did its job — it named the spatial-grid reallocation that no amount of
   reasoning had found — but leaving it on made it the worst blocker on the box.
   Its 15-second window boundary showed up in the client trace as a snapshot gap
   every 15 seconds, and the windows it chose to keep were the biggest gaps of
   the session, because noticing a stall triggers the work that causes one.
   Enable deliberately with PROFILER=on, read /api/debug/profile, turn it off. */
if (process.env.PROFILER === 'on') profiler.start();

/* 45s, not 60s, and deliberately so — this is a causal test, not a tuning
   change. What is left of the hitch still arrives on a 60-second cycle (client
   snapshot gaps at 63s, 124s, 243s), and the only two 60s jobs are this and the
   lobby sweep, which measures 0ms against this one's 76ms and a Solana RPC
   round trip. If the remaining stalls move to a 45-second spacing, this is the
   cause and the fix goes here. If they stay on 60s, it is neither job and the
   period is coming from somewhere outside the app.

   Safe either way: running the solvency monitor MORE often cannot weaken it,
   and it is the check that alerts when escrow drops below live stakes. */
everyStaggered(checkSolvency, 45000, 3000, 'solvency');
checkSolvency();
/* Offsets are chosen MOD 30s, because most of these repeat every 30s and a
   60s job still lands on a 30s slot. Reduced: solvency 3, collusion 7,
   payouts 11, lobby-sweep 14, lb-flush 19, agar-lb 25. No two share a second,
   and the tightest gap is 3s. Picking 41 for the sweep looked staggered and
   was not: 41 mod 30 is 11, exactly where payouts already lands. */
everyStaggered(() => allTimeLb.flush(),    30000, 19000, 'lb-flush');
everyStaggered(() => agarLb.flush(),       30000, 25000, 'agar-lb-flush');
everyStaggered(() => ladder.sweep(),       60000, 44000, 'lobby-sweep');
everyStaggered(() => collusion.evaluate(), 30000, 37000, 'collusion');

// ── Failed-payout drainer (NA only) ───────────────────────────────────────────
// Retries cash-out payouts that failed (e.g. an RPC outage) so a player's winnings are never
// stranded. money.attemptPayout is idempotent — it only ever re-broadcasts the SAME signed tx
// (so it can't double-pay) and saves a freshly-built tx BEFORE sending it. Runs only on NA so
// the two servers never race the same payout; the DB row claim (SKIP LOCKED) is a 2nd safeguard.
async function drainPayouts() {
  try {
    for (let i = 0; i < 5; i++) {              // drain a few per tick, then yield
      const row = await db.claimDuePayout(30, 200);
      if (!row) break;
      try {
        const r = await money.attemptPayout(row, (b) => db.savePayoutSignature(row.id, b));
        if (r && r.paid) {
          await db.markPayoutPaid(row.id, r.sig);
          // Earnings count on actual payout — record now that the recovery landed (it was not
          // recorded at failure time), so the board reflects this real payout exactly once.
          db.recordEarnings(row.wallet_address, row.name, row.amount_sol, money.fiatValue(row.amount_sol)).catch(() => {});
          console.log(`[PAYOUT] recovered ${row.amount_sol} SOL → ${String(row.wallet_address).slice(0, 8)}… sig ${String(r.sig).slice(0, 12)} (attempt ${row.attempts})`);
        } else {
          console.warn(`[PAYOUT] ${row.amount_sol} SOL to ${String(row.wallet_address).slice(0, 8)}… still pending (attempt ${row.attempts})`);
        }
      } catch (e) {
        console.error(`[PAYOUT] retry errored for ${String(row.wallet_address).slice(0, 8)}…: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('[PAYOUT] drainer tick failed:', e.message);
  }
}
if (REGION === 'na') everyStaggered(drainPayouts, 30000, 11000, 'payouts');

// How long to keep a disconnected player's snake gliding before giving up on a
// reconnect. Covers a typical mobile network blip without leaving dead snakes around.
const RECONNECT_GRACE_MS = 8000;

// Guard the region lookup: a server only hosts its own region's rooms now, so
// gameRooms[rgn] is undefined for the others.
function totalInGame() {
  return REGIONS.reduce((t, rgn) =>
    t + Object.values(gameRooms[rgn] || {}).reduce((s, r) => s + r.playerCount + r.botCount, 0), 0);
}

function totalAgarInGame() {
  return REGIONS.reduce((t, rgn) =>
    t + Object.values(agarRooms[rgn] || {}).reduce((s, r) => s + r.playerCount + r.botCount, 0), 0);
}

function broadcastLobbyState() {
  const state = {
    playerCount:      totalInGame()     + (remoteStats.playerCount     || 0),
    lobbyCount:       lobbyConnections.size,
    leaderboard:      allTimeLb.getTop(3),
    agarPlayerCount:  totalAgarInGame() + (remoteStats.agarPlayerCount || 0),
    agarLobbyCount:   lobbyConnections.size,
    agarLeaderboard:  agarLb.getTop(3),
    region:           REGION,
  };
  for (const sock of lobbyConnections) sock.emit(C.EVENTS.LOBBY_STATE, state);
  pushStatsToNA();
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  socket.emit(C.EVENTS.LOBBY_STATE, {
    playerCount:      totalInGame()     + (remoteStats.playerCount     || 0),
    lobbyCount:       lobbyConnections.size,
    leaderboard:      allTimeLb.getTop(3),
    agarPlayerCount:  totalAgarInGame() + (remoteStats.agarPlayerCount || 0),
    agarLobbyCount:   lobbyConnections.size,
    agarLeaderboard:  agarLb.getTop(3),
    region:           REGION,
  });

  socket.on('lobby:join', ({ googleId } = {}) => {
    lobbyConnections.add(socket);
    if (googleId) {
      socket._googleId = googleId;
      lobbySocketsByGoogleId.set(googleId, socket);
    }
    broadcastLobbyState();
  });

  socket.on(C.EVENTS.PLAY, ({ name, walletAddress, googleId, color, lobbyType, stake, entryToken, region, reconnectKey } = {}) => {
    // Ignore duplicate PLAY events (e.g. from socket reconnect while alive)
    if (socket._room) {
      const existingSnake = socket._room.snakes.get(socket.id);
      if (existingSnake && existingSnake.alive) return;
    }
    const playerName = sanitizeName(name);
    // Identity = the wallet address the client sends as googleId (self-custody single login).
    const verifiedId = googleId || null;
    if (verifiedId) {
      socket._googleId = verifiedId;
      lobbySocketsByGoogleId.set(verifiedId, socket);
    }
    /* A stake names a rung of the ladder, a lobbyType names a fixed tier. Only
       the redesigned lobby sends the former, so existing clients keep landing
       in exactly the rooms they always did. */
    const byStake = stake !== undefined && stake !== null && isStake(stake);
    const room = getRoomForJoin({ lobbyType, stake, region: region || REGION });
    /* Maintenance stops new games starting and says why. Refusing silently is
       what makes a real-money game look broken rather than busy, and a player
       who thinks it is broken does not come back. Anybody already playing is
       left alone — see ops.js. */
    if (ops.get().maintenance) {
      socket.emit('maintenance', ops.get());
      return;
    }
    /* A battle royale is shut once it starts. Turning up two minutes late to a
       closing circle is not joining a match, it is being handed a death, and it
       would let somebody wait out the dangerous part and walk into the end of
       it. Refused here on the server; the lobby also hides the button, but a
       hidden button is not a rule. */
    if (room && room.isBattleRoyale && !room.acceptingPlayers()) {
      socket.emit('br:locked', room.publicState());
      return;
    }
    socket._stake = byStake ? Number(stake) : null;
    // One human-readable name for the room, used in logs and owner alerts.
    const roomLabel = byStake
      ? (Number(stake) === 0 ? 'free' : '$' + Number(stake).toFixed(2))
      : ((lobbyType in LOBBY_FEES) ? lobbyType : 'free');

    // Reconnect: if we kept this player's snake alive after a recent drop, put them
    // back on it (and their staked worth) instead of charging/spawning a fresh one.
    if (reconnectKey) {
      socket._reconnectKey = reconnectKey;
      const reSnake = room.reattach(reconnectKey, socket);
      if (reSnake) {
        socket._room = room;
        socket._joinTime = socket._joinTime || Date.now();
        lobbyConnections.delete(socket);
        broadcastLobbyState();
        console.log(`[~] ${playerName} reconnected to held snake`);
        return;
      }
    }

    /* Never trust the client's entrySol — take the snake's cash worth from a
       server-verified paid-entry token (0 for free lobbies).

       On the ladder the token must have been bought for THIS rung: a $0.25
       token cannot open the $20 room, which is the same guarantee the tier
       door gives, restated against amounts. A client that sends a stake it did
       not pay for gets nothing, because the amount is checked against the
       token and not against the request. */
    const entry = byStake
      ? consumePaidEntryAtStake(entryToken, Number(stake), 'snake')
      : consumePaidEntry(entryToken, (lobbyType in LOBBY_FEES) ? lobbyType : 'free', 'snake');
    if (!entry.ok) {
      socket.emit(C.EVENTS.ERROR, { message: 'Entry fee not verified. Please return to the lobby and try again.' });
      return;
    }
    // Server-verified identity from the paid token — overrides the client-claimed
    // googleId so cash-out credits the account that actually paid.
    if (entry.googleId) {
      socket._googleId = entry.googleId;
      lobbySocketsByGoogleId.set(entry.googleId, socket);
    }
    if (entry.walletAddress) socket._walletAddress = entry.walletAddress; // self-custody cash-out target
    socket._room = room;
    socket._joinTime = Date.now();
    console.log(`[>] ${playerName} joins ${roomLabel} lobby (worth: ${entry.worth} ${money.unit})`);
    room.addPlayer(socket, playerName, walletAddress || null, color || null, entry.worth);
    notify.pushOwner(
      `${playerName} joined the ${roomLabel} lobby` +
        (entry.worth ? ` for ${entry.worth} ${money.unit}` : ' (free)') +
        ` in ${(region || REGION).toUpperCase()}`,
      { title: 'New player: slither.io', tags: 'video_game' }
    );
    lobbyConnections.delete(socket);
    broadcastLobbyState();
  });

  /* Cashing out is a HELD action, and the hold is what makes it risky: you
     crawl, and a ring over your head tells everyone in the room to come and
     take it. Both halves are timed and applied here rather than in the client,
     because a client-side penalty in a real-money game is a penalty only for
     the people who did not edit it out. */
  function clearCashoutHold(snake) {
    if (snake) snake.cashoutStartedAt = null;
    if (socket._cashoutTimer) { clearTimeout(socket._cashoutTimer); socket._cashoutTimer = null; }
  }

  socket.on('cashout:start', () => {
    /* The hold is the real cash-out path — it pays out on its own timer — so
       blocking only the legacy 'cashout' event below would have left the whole
       thing wide open in a battle royale. */
    if (socket._room && socket._room.isBattleRoyale) return;
    const room = socket._room;
    if (!room) return;
    const snake = room.snakes && room.snakes.get(socket.id);
    if (!snake || !snake.alive) return;
    if (snake.cashoutStartedAt) return;                  // already holding
    snake.cashoutStartedAt = Date.now();                 // starts the slowdown too
    /* The SERVER completes the hold, rather than waiting to be told the hold
       finished. The client starts its countdown when it sends this and the
       server starts when it arrives, so the client's clock always runs ahead
       by about one trip — asking it to tell us when three seconds were up
       would have every honest player asking a fraction too early and being
       refused. Owning the clock end to end avoids inventing a tolerance to
       paper over that, and the tolerance is exactly what a cheat would aim at. */
    socket._cashoutTimer = setTimeout(() => {
      socket._cashoutTimer = null;
      doCashout().catch(e => console.error('[CASHOUT]', e.message));
    }, C.CASHOUT_HOLD_MS);
    socket.to(room.socketRoomName).emit('cashout:started', { id: socket.id });
    socket.emit('cashout:started', { id: socket.id });   // echo to self for own ring
  });

  socket.on('cashout:cancel', () => {
    const room = socket._room;
    if (!room) return;
    clearCashoutHold(room.snakes && room.snakes.get(socket.id));   // full speed again
    socket.to(room.socketRoomName).emit('cashout:cancelled', { id: socket.id });
    socket.emit('cashout:cancelled', { id: socket.id });
  });

  socket.on('disconnect', () => clearCashoutHold(
    socket._room && socket._room.snakes && socket._room.snakes.get(socket.id)));

  /* Kept so an older client that still drives this itself keeps working, but
     it grants nothing: the hold must have run, and the timer above will have
     paid out already in the normal case. */
  socket.on('cashout', () => {
    if (!socketRL(socket, 'cashout', 1000)) return;
    /* Not available in a battle royale, and refused HERE rather than only
       hidden in the client: you play for the placing, and if banking your worth
       mid-match were possible it would be the correct move every time and the
       mode would collapse into normal play with extra steps. */
    if (socket._room && socket._room.isBattleRoyale) return;
    const room = socket._room;
    const snake = room && room.snakes && room.snakes.get(socket.id);
    if (!snake || !snake.alive) return;
    const held = snake.cashoutStartedAt ? Date.now() - snake.cashoutStartedAt : -1;
    if (held < C.CASHOUT_HOLD_MS) return;   // no hold, no money
    doCashout().catch(e => console.error('[CASHOUT]', e.message));
  });

  async function doCashout() {
    const room = socket._room;
    if (!room) return;
    const snake = room.snakes && room.snakes.get(socket.id);
    if (!snake || !snake.alive) return;
    const worth = snake.worth;
    snake.worth = 0;
    // Mark snake as dead without dropping any food
    snake.alive = false;
    room.borderDrift = Math.max(room.borderDrift - 120, -1000);
    allTimeLb.record(socket._googleId || snake.name, snake.name, snake.score);

    const HOUSE_CUT = 0.10; // 10%
    const ownerShare = worth * HOUSE_CUT;
    const playerShare = worth - ownerShare;

    // The 10% house cut: record it (ledger + PostHog) and sweep it out of escrow to the revenue wallet.
    if (worth > 0) {
      trackEarning({
        source: 'game_rake', game: 'slither', amountUsdc: ownerShare,
        wallet: socket._walletAddress || null, name: snake.name,
        lobbyType: room.lobbyType || null, region: REGION,
      });
      sweepRake(ownerShare, 'slither ' + (room.lobbyType || ''));
    }

    // Self-custody (Phase 2): the escrow sends the player's 90% back to their own wallet
    // on-chain; the 10% house cut simply stays in the escrow. No custodial ledger involved.
    if (socket._walletAddress) {
      // gross/cut are for the receipt only — the payout below is computed here and
      // never read back from the client, so these are display values, not inputs.
      socket.emit('cashout:result', { newBalance: null, earnedSol: playerShare, gross: worth, cut: ownerShare, score: Math.floor(snake.score), length: snake.length, toWallet: true });
      if (worth > 0) {
        money.withdraw(socket._walletAddress, playerShare)
          .then((sig) => {
            console.log(`[CASHOUT] self-custody ${playerShare.toFixed(6)} ${money.unit} → ${socket._walletAddress.slice(0, 8)}… sig ${String(sig).slice(0, 12)}`);
            // Earnings count only once the payout actually lands (so the leaderboard + global
            // winnings reflect real payouts, not amounts a failed tx may never have delivered).
            db.recordEarnings(socket._walletAddress, snake.name, playerShare, money.fiatValue(playerShare)).catch(() => {});
            socket.emit('cashout:paid', { sol: playerShare, sig });
          })
          .catch((e) => {
            console.error(`[CASHOUT] CRITICAL: self-custody payout failed for ${socket._walletAddress} — owed ${playerShare.toFixed(6)} SOL: ${e.message}`);
            // Record the owed amount durably so it's never silently lost (owner reconciles via
            // /api/admin/failed-payouts). No auto-retry — a re-send could double-pay.
            db.recordFailedPayout(socket._walletAddress, playerShare, snake.name, `snake ${room.lobbyType}: ${e.message}`, e.broadcast).catch(() => {});
            socket.emit('cashout:error', { message: 'Payout delayed — your winnings are recorded and will be sent. Contact support if they don\'t arrive.' });
          });
      }
      return;
    }

    // No wallet here means a free/worthless player (paid play requires a connected wallet),
    // so there's nothing to pay out.
    socket.emit('cashout:result', { newBalance: null, earnedSol: 0, score: Math.floor(snake.score), length: snake.length });
  }

  // speedMult is no longer read from the client: the only thing it carried was
  // the cash-out slowdown, and the server times that itself now.
  socket.on(C.EVENTS.INPUT, ({ angle, boost }) => {
    if (typeof angle !== 'number' || !Number.isFinite(angle)) return;
    if (socket._room) socket._room.handleInput(socket.id, angle, !!boost);
  });

  // In-game chat — re-broadcast a player's message to everyone in their game room (incl. themselves).
  socket.on(C.EVENTS.CHAT, ({ text } = {}) => {
    const room = socket._room;
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;                                            // spectators can't chat
    const now = Date.now();
    if (socket._lastChat && now - socket._lastChat < 600) return;   // simple anti-spam throttle
    socket._lastChat = now;
    const msg = String(text || '').replace(/[<>]/g, '').slice(0, 120).trim();
    if (!msg) return;
    const name = String(player.name || 'Player').slice(0, 24);
    socket.emit(C.EVENTS.CHAT, { name, text: msg, self: true });   // echo to sender (highlighted)
    socket.to(room.socketRoomName).emit(C.EVENTS.CHAT, { name, text: msg }); // to everyone else
  });

  // Client reports how far it can see (world units) for area-of-interest culling —
  // the snapshot broadcaster only sends each player snakes/food within this radius.
  socket.on('view', ({ r } = {}) => {
    if (typeof r === 'number' && isFinite(r) && r > 0) socket._viewR = Math.min(Math.max(r, 200), 20000);
  });

  socket.on('spectate:join:agar', ({ lobbyType, region } = {}) => {
    const room = getAgarRoomForType(lobbyType || 'free', region || REGION);
    socket.join(room.roomName);
    socket._agarRoom = room;
    socket._spectating = true;
    socket.emit('cell:joined', {
      playerId:  socket.id,
      worldSize: room.worldSize,
      foods:     [...room.foods.values()],
      players:   room._serializePlayers(),
    });
  });

  socket.on('spectate:join', ({ lobbyType, stake, region } = {}) => {
    // Watching costs nothing, so no token is consumed; it only has to resolve
    // to the same room the player would have joined.
    const room = getRoomForJoin({ lobbyType: lobbyType || 'free', stake, region: region || REGION });
    socket.join(room.socketRoomName);
    socket._room = room;
    socket._spectating = true;
    socket.emit(C.EVENTS.GAME_JOINED, {
      playerId: socket.id,
      worldRadius: room.worldRadius,
      food: room.foodManager.getAll(),
      snake: null,
      spectateOnly: true,
    });
  });

  socket.on(C.EVENTS.RESPAWN, ({ entryToken } = {}) => {
    if (!socket._room) return;
    const existing = socket._room.snakes.get(socket.id);
    if (existing && existing.alive) return; // block respawn while alive
    /* Server-verified worth from the echoed entry token — the client's entrySol
       is ignored. A respawn re-buys the room the socket is ALREADY in, taken
       from socket._stake rather than from anything the client sends now, so a
       player cannot die in the $0.25 room and respawn into the $20 one. */
    const onLadder = socket._stake !== null && socket._stake !== undefined;
    const roomLabel = onLadder
      ? (socket._stake === 0 ? 'free' : '$' + Number(socket._stake).toFixed(2))
      : socket._room.lobbyType.replace(/^(na|eu)_/, '');
    const entry = onLadder
      ? consumePaidEntryAtStake(entryToken, socket._stake, 'snake')
      : consumePaidEntry(entryToken, socket._room.lobbyType.replace(/^(na|eu)_/, ''), 'snake');
    if (!entry.ok) {
      socket.emit(C.EVENTS.ERROR, { message: 'Entry fee not verified. Please return to the lobby and try again.' });
      return;
    }
    if (entry.googleId) socket._googleId = entry.googleId;
    if (entry.walletAddress) socket._walletAddress = entry.walletAddress;
    socket._room.respawnPlayer(socket.id, entry.worth);
    const _rs = socket._room.snakes.get(socket.id);
    notify.pushOwner(
      `${(_rs && _rs.name) || 'A player'} pressed play again in the ${roomLabel} lobby` +
        (entry.worth ? ` for ${entry.worth} ${money.unit}` : ' (free)'),
      { title: 'Player respawned: slither.io', tags: 'arrows_counterclockwise' }
    );
  });

  socket.on('ping_check', () => socket.emit('pong_check'));

  socket.on('admin:spawnbot', async ({ count, idToken } = {}) => {
    if (!(await isOwnerToken(idToken))) return;
    const n = Math.min(Math.max(1, parseInt(count) || 1), 10);
    const room = socket._room || gameRooms[REGION].free;

    const shortType = room.lobbyType.replace(/^(na|eu)_/, '');
    if (shortType === 'free') {
      for (let i = 0; i < n; i++) room.addBot();
      socket.emit('admin:ack', { message: `Spawned ${n} free bot(s)` });
      broadcastLobbyState();
      return;
    }

    // Paid lobby — the bot's stake is funded by the escrow (the owner's own SOL). There's no
    // custodial balance to debit anymore; just log each bot's cost so it can be tracked as an
    // owner expense, then spawn the bot carrying the entry worth.
    const feeAmt = money.feeFor(shortType); // stake the bot carries, in the active unit
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      try {
        await db.recordWithdrawal(OWNER_WALLET, null, feeAmt, 'paid_bot_entry');
        room.addPaidBot(feeAmt);
        trackEarning({ source: 'bot_cost', game: 'slither', amountUsdc: -feeAmt, lobbyType: shortType, region: REGION });
        spawned++;
      } catch (e) {
        console.error('[BOT] Paid bot spawn failed:', e.message);
        break;
      }
    }
    socket.emit('admin:ack', { message: `Spawned ${spawned} paid bot(s) worth ${(feeAmt * spawned).toFixed(4)} ${money.unit}` });
    broadcastLobbyState();
  });

  // ── Agar events ──────────────────────────────────────────────────────────
  socket.on('cell:join', ({ name, color, lobbyType, googleId, region, entryToken } = {}) => {
    // Identity = the wallet address the client sends as googleId (self-custody single login).
    const verifiedId = googleId || null;
    if (verifiedId) {
      socket._googleId = verifiedId;
      lobbySocketsByGoogleId.set(verifiedId, socket);
    }
    const room = getAgarRoomForType(lobbyType, region || REGION);
    socket._agarRoom = room;
    // Verify the entry fee server-side (same one-time token the snake game uses) and
    // take the cell's worth from the server, never from the client.
    const shortType = (lobbyType in LOBBY_FEES) ? lobbyType : 'free';
    socket._agarShortType = shortType; // remembered for the in-game re-stake on respawn
    const entry = consumePaidEntry(entryToken, shortType, 'agar');
    if (!entry.ok) {
      socket.emit('cell:join:error', { message: 'Entry fee not verified. Please return to lobby.' });
      return;
    }
    if (entry.googleId) { socket._googleId = entry.googleId; lobbySocketsByGoogleId.set(entry.googleId, socket); }
    if (entry.walletAddress) socket._walletAddress = entry.walletAddress; // self-custody cash-out target
    const entryWorth = entry.worth; // worth from the verified stake token (native unit), same as the snake game

    room.addPlayer(socket, sanitizeName(name), color, entryWorth, socket._googleId || null);
    notify.pushOwner(
      `${sanitizeName(name)} joined the ${shortType} lobby` +
        (entryWorth ? ` for ${entryWorth} ${money.unit}` : ' (free)') +
        ` in ${(region || REGION).toUpperCase()}`,
      { title: 'New player: agar.io', tags: 'video_game' }
    );
    lobbyConnections.delete(socket);
    broadcastLobbyState();
  });

  socket.on('cell:spawnbot', async ({ idToken } = {}) => {
    if (!(await isOwnerToken(idToken))) return;
    const room = socket._agarRoom || agarRooms[REGION].free;

    // Determine lobby type from room name (e.g. 'agar_dime' → 'dime')
    const lobbyType = room.roomName.replace('agar_', '');
    const feeAmt = money.feeFor(lobbyType);

    if (feeAmt > 0) {
      try {
        await db.recordWithdrawal(OWNER_WALLET, null, feeAmt, 'paid_agar_bot_entry');
        room.addPaidBot(feeAmt);
        trackEarning({ source: 'bot_cost', game: 'agar', amountUsdc: -feeAmt, lobbyType, region: REGION });
        broadcastLobbyState();
      } catch (e) {
        console.error('[AGAR BOT] Paid bot spawn failed:', e.message);
      }
    } else {
      room.addBot();
      broadcastLobbyState();
    }
  });

  socket.on('cell:input', ({ mouseX, mouseY } = {}) => {
    if (socket._agarRoom) socket._agarRoom.handleInput(socket.id, mouseX, mouseY);
  });

  // Client reports how far it can see (world units) so the agar broadcaster only sends each
  // player the entities within their view (area-of-interest culling).
  socket.on('cell:view', ({ r } = {}) => {
    if (typeof r === 'number' && isFinite(r) && r > 0) socket._agarViewR = Math.min(Math.max(r, 300), 12000);
  });

  /* Owner-only, verified against a real Privy token by the same check the bot
     spawner uses. Nothing about this trusts the client beyond the token. */
  socket.on('br:start', async ({ idToken } = {}) => {
    if (!socketRL(socket, 'brstart', 2000)) return;
    if (!(await isOwnerToken(idToken))) return;
    const room = gameRooms[REGION] && gameRooms[REGION].br;
    if (!room) return;
    if (!room.canStart()) { socket.emit('br:state', room.publicState()); return; }
    room.startMatch('owner');
  });

  /* Anyone in the room may ASK what the match is doing. It is the same thing
     they can already see out of the window. */
  socket.on('br:peek', () => {
    const room = gameRooms[REGION] && gameRooms[REGION].br;
    if (room) socket.emit('br:state', room.publicState());
  });

  socket.on('cell:split', () => {
    if (!socketRL(socket, 'split', 100)) return;
    if (socket._agarRoom) socket._agarRoom.handleSplit(socket.id);
  });

  socket.on('cell:respawn', ({ entryToken } = {}) => {
    const room = socket._agarRoom;
    if (!room) return;
    // Paid respawns re-stake (same one-time token the snake game uses); free respawns carry none.
    const shortType = socket._agarShortType || 'free';
    const entry = consumePaidEntry(entryToken, shortType, 'agar');
    if (!entry.ok) {
      socket.emit('cell:join:error', { message: 'Entry fee not verified. Please return to lobby.' });
      return;
    }
    if (entry.walletAddress) socket._walletAddress = entry.walletAddress;
    room.respawnPlayer(socket.id, entry.worth);
    const _rp = room.players.get(socket.id);
    notify.pushOwner(
      `${(_rp && _rp.name) || 'A player'} pressed play again in the ${shortType} lobby` +
        (entry.worth ? ` for ${entry.worth} ${money.unit}` : ' (free)'),
      { title: 'Player respawned: agar.io', tags: 'arrows_counterclockwise' }
    );
  });

  socket.on('cell:lock', () => {
    if (socket._agarRoom) socket._agarRoom.lockPlayer(socket.id);
  });

  socket.on('cell:unlock', () => {
    if (socket._agarRoom) socket._agarRoom.unlockPlayer(socket.id);
  });

  socket.on('cell:cashout', async () => {
    if (!socketRL(socket, 'cell:cashout', 5000)) return;
    const room = socket._agarRoom;
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;

    const worth = player.worth || 0; // in the active unit (SOL or USDC), same as the snake game
    agarLb.record(socket._googleId || player.name, player.name, player.score);
    room.cashoutPlayer(socket.id); // kills player, clears cells

    const HOUSE_CUT    = 0.10;
    const playerShare  = worth - worth * HOUSE_CUT; // 90% to the player, 10% house cut stays in escrow

    // The 10% house cut: record it (ledger + PostHog) and sweep it out of escrow to the revenue wallet.
    if (worth > 0) {
      const rake = worth * HOUSE_CUT;
      trackEarning({
        source: 'game_rake', game: 'agar', amountUsdc: rake,
        wallet: socket._walletAddress || null, name: player.name,
        lobbyType: room.lobbyType || null, region: REGION,
      });
      sweepRake(rake, 'agar ' + (room.lobbyType || ''));
    }

    if (socket._walletAddress) {
      socket.emit('cell:cashout:result', { newBalance: null, earnedCad: money.fiatValue(playerShare), earnedSol: playerShare, score: player.score, toWallet: true });
      if (worth > 0) {
        money.withdraw(socket._walletAddress, playerShare)
          .then((sig) => {
            console.log(`[AGAR CASHOUT] self-custody ${playerShare.toFixed(6)} ${money.unit} → ${socket._walletAddress.slice(0, 8)}… sig ${String(sig).slice(0, 12)}`);
            // Earnings count only on actual payout. Both games feed ONE combined top-earners
            // board (the shared total_earnings column).
            db.recordEarnings(socket._walletAddress, player.name, playerShare, money.fiatValue(playerShare)).catch(() => {});
            socket.emit('cell:cashout:paid', { sol: playerShare, sig });
          })
          .catch((e) => {
            console.error(`[AGAR CASHOUT] CRITICAL: self-custody payout failed for ${socket._walletAddress} — owed ${playerShare.toFixed(6)} ${money.unit}: ${e.message}`);
            db.recordFailedPayout(socket._walletAddress, playerShare, player.name, `agar ${room.roomName}: ${e.message}`, e.broadcast).catch(() => {});
            socket.emit('cell:cashout:error', { message: 'Payout delayed — your winnings are recorded and will be sent. Contact support if they don\'t arrive.' });
          });
      }
      return;
    }

    // No wallet here means a free/worthless player (paid play requires a connected wallet),
    // so there's nothing to pay out.
    socket.emit('cell:cashout:result', { newBalance: null, earnedCad: 0, score: player.score });
  });

  socket.on('disconnect', async () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    if (socket._agarRoom) {
      const agarPlayer = socket._agarRoom.players.get(socket.id);
      if (agarPlayer && socket._googleId) {
        db.recordAgarGameResult(socket._googleId, agarPlayer.score || 0).catch(() => {});
      }
      socket._agarRoom.removePlayer(socket.id);
    }
    const room = socket._room;
    if (room) {
      const snake = room.snakes && room.snakes.get(socket.id);
      const gid = socket._googleId, joinTime = socket._joinTime;
      const finalize = () => {
        const s = room.snakes.get(socket.id);
        if (s && gid) {
          const duration = joinTime ? Math.round((Date.now() - joinTime) / 1000) : 0;
          db.recordGameResult(gid, s.score, duration).catch(() => {});
        }
        room.removePlayer(socket.id);
        broadcastLobbyState();
      };
      if (snake && snake.alive && socket._reconnectKey) {
        // Likely a brief network drop (very common on mobile). Keep the snake
        // gliding for a grace period so a reconnect lands the player back on it
        // instead of wiping their progress / staked worth.
        room.markOrphan(socket.id, socket._reconnectKey, RECONNECT_GRACE_MS, finalize);
      } else {
        if (snake && socket._googleId) {
          const duration = socket._joinTime ? Math.round((Date.now() - socket._joinTime) / 1000) : 0;
          await db.recordGameResult(socket._googleId, snake.score, duration).catch(() => {});
        }
        room.removePlayer(socket.id);
      }
    }
    if (socket._googleId) lobbySocketsByGoogleId.delete(socket._googleId);
    lobbyConnections.delete(socket);
    broadcastLobbyState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
