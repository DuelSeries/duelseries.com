require('dotenv').config({ override: true });
const express    = require('express');
const http       = require('http');
const https      = require('https');
const { Server } = require('socket.io');
const path       = require('path');
const { rateLimit } = require('express-rate-limit');
const C        = require('../shared/constants');
const GameRoom = require('./GameRoom');
const { BattleRoyaleRoom, BR } = require('./BattleRoyaleRoom');
const { TanksLobby } = require('./TanksLobby');   // the artillery duel
const { KnockoutLobby } = require('./KnockoutLobby'); // the shrinking-disc duel
const { BattleshipLobby } = require('./BattleshipLobby'); // the two-grid duel
const { ShooterRoom, SH: SHOOTER } = require('./ShooterRoom'); // the top-down tank arena
/* Games switched off for now (Awesome Tanks, Bowmasters): no room, no socket
   messages, no /api/live rows, pages sent to the lobby. The list is
   shared/lockedGames.js, which the lobby reads too. */
const { LOCKED_GAMES, isLocked } = require('../shared/lockedGames');
const db     = require('./db');
const collusion = require('./CollusionMonitor');
const profiler = require('./profiler');
const debugTick = require('./debugTick');
const Wallet = require('./Wallet');
const allTimeLb = require('./leaderboard');
const prices = require('./prices');
const money = require('./money'); // SOL- or USDC-denominated money backend (picked by MONEY_MODE)
const Usdc  = require('./Usdc');  // USDC primitives — used directly by the cosmetics shop (always USDC)
const notify = require('./notify'); // owner phone pushes (ntfy) — e.g. new-player alerts
const analytics = require('./analytics'); // server-side PostHog capture (money events)
const nameProof = require('./nameProof'); // a wallet signing for its own name change
const ownerAuth = require('./ownerAuth'); // the owner wallet signing for an owner action
const { isWalletString } = require('./b58Caps');     // a client address is a key's size before any decode
const Swap = require('./swap');                      // SOL <-> USDC in the player's own wallet
const { TRUST_PROXY } = require('./clientAddr');     // X-Forwarded-For only from nginx (loopback / private)
const { securityHeaders } = require('./securityHeaders');
const ops       = require('./ops');       // maintenance mode
const { createSkinShop, liveChain } = require('./skinShop');   // buying skins with USDC
const { sharedPass: sharedSkinPass } = require('./skinPass');   // the pass a game checks before wearing a paid skin
const skinCatalog = require('./skinCatalog');                   // what is for sale, at the server's prices
const { liveCounts, withBoardBots } = require('./liveCounts'); // per-game totals, for the lobby cards

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
/* The one address escrow may open a USDC account for (Usdc.js: escrow never pays a
   player's account rent). Needed only if the revenue wallet's account were ever closed. */
money.allowAccountRentFor(REVENUE_WALLET);
// Money to or from it is the house's, so a player's wallet history never lists it as their own.
Usdc.markHouseAddress(REVENUE_WALLET);

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
// A string or a number only: String() on a client-built object THROWS ({"toString":1} has no
// callable toString), and inside a socket handler a throw ends the whole process.
function sanitizeName(name) {
  const s = typeof name === 'string' ? name : (typeof name === 'number' ? String(name) : '');
  return (s.replace(/[<>]/g, '').trim().slice(0, 20)) || 'Player';
}

/* ─── What a socket message may be ───────────────────────────────────────────
   Nothing or a plain object, and nothing else. Every handler below destructures its message,
   and destructuring null throws (a default of {} covers undefined only). This process has no
   uncaughtException handler, so ONE such throw from one hand-made client used to end every live
   game on the box, paid ones included. The handlers are registered through on() (inside the
   connection handler), which drops any other shape before the handler runs, so a dropped
   message has changed nothing. 'disconnect' is not a client message (its argument is a reason
   string) and stays on socket.on. Fields inside the object are still the handler's to check:
   pinning each to its one type is done at the top of the handler that reads it. */
function isSocketMsg(p) {
  return p === undefined || (p !== null && typeof p === 'object' && !Array.isArray(p)
    && !Buffer.isBuffer(p) && !ArrayBuffer.isView(p) && !(p instanceof ArrayBuffer));
}
const strOr = (v, dflt) => (typeof v === 'string' ? v : dflt);

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET env var is not set in production.');
  process.exit(1);
}

Wallet.setDb(db);
Wallet.seedUsedSignatures();
allTimeLb.setDb(db);

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
  /* The largest message one client may send (default 1 MB). Every honest client
     message in every game is a small object, well under 2 KB (the biggest are the
     sl:diag stats, a join with its entry token, Battleship's ship placement), so
     64 KB is over 30x headroom. A 1 MB message was enough to hand a handler a
     megabyte string, which is what made the quadratic base58 decode a 20-minute
     stall. The served socket.io client reads this limit from the handshake and
     splits a polling batch to fit under it. */
  maxHttpBufferSize: 64 * 1024,
});

// Keep idle connections from nginx open longer than its upstream keep-alive, so a reused one is never cut mid-request.
server.keepAliveTimeout = 120000;
server.headersTimeout   = 121000;

/* nginx on this box terminates TLS and proxies to us, so X-Forwarded-For is believed
   only when the peer is loopback or a private address (nginx), never from a client
   that reached port 3000 directly. With the old hop count (1) a direct client could
   set X-Forwarded-For to anything and dodge every req.ip rate limit. The socket
   per-address caps use the same rule (server/clientAddr.js). */
app.set('trust proxy', TRUST_PROXY);

/* frame-ancestors / X-Frame-Options / nosniff / Referrer-Policy on everything, HSTS on
   https (server/securityHeaders.js). The games are same-origin frames of the lobby, so
   they still load. */
app.use(securityHeaders);

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
      /* The boot refund (STATUS item 7a): every stake an earlier boot of this server verified and
         never seated or refunded is owed back now, once, through the owed-payout lane. */
      stakeLedger.sweep({ boot: true }).catch((e) => console.error('[STAKE] boot sweep', e.message));
      /* Paid agar crash refunds and killed-process flags (server/ag/agJournal.js). */
      replayAgJournal();
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
/* Paper dev entry tokens, so the paid Paper HUD and money path can be driven on
   a dev PC before real money. /api/submit-stake then mints a token with no
   chain behind it, and Paper pays out through a fake withdraw. Honoured only
   where there is nothing to pay with and nothing to write to: no escrow key
   (an empty string counts as unset, as in Wallet.js), no database and not
   production. Any one of them set refuses to boot, so the switch can never
   mint an unbacked token on a server that could cash it out for real, nor put
   a fake stake, earning or owed-payout row into a database that a keyed
   server reads and pays from. dev-local.js stubs the database in memory. */
const PAPER_DEV_TOKENS = process.env.PAPER_DEV_TOKENS === '1';
if (PAPER_DEV_TOKENS) {
  if (process.env.ESCROW_PRIVATE_KEY) {
    console.error('[PAPER] PAPER_DEV_TOKENS=1 is set on a server holding ESCROW_PRIVATE_KEY. Refusing.');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('[PAPER] PAPER_DEV_TOKENS=1 is set in PRODUCTION. Refusing.');
    process.exit(1);
  }
  if (String(process.env.DATABASE_URL || '').trim()) {
    console.error('[PAPER] PAPER_DEV_TOKENS=1 is set with a DATABASE_URL. Refusing: dev money must not reach a real database.');
    process.exit(1);
  }
  console.warn('[PAPER] PAPER_DEV_TOKENS=1: unbacked dev entry tokens and a fake Paper withdraw. Not for production.');
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
  if (!idToken || typeof idToken !== 'string') return false;   // the client's: a token is text
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

/* Where Pay with card opens (Owen, 2026-10-16: at the minimum, not 0.25 SOL). MoonPay's minimum
   for a Canadian card is C$30 with its fees included (its public currency list: cad
   minBuyAmount 30; sol 0.048), which Owen saw come to 0.156 SOL; at CoinGecko's C$149.5 a SOL
   that day that is C$23.30 of SOL, and C$23.50 leaves room for the price moving between our feed
   and MoonPay's (a start under the minimum would open on MoonPay's error). It follows the live
   price so the screen keeps opening at the minimum; with no
   recent price it opens at the 0.156 Owen saw, and never under MoonPay's own 0.048 SOL. */
const CARD_MIN_NET_CAD = 23.5;
function cardStartSol() {
  const cad = prices.getSolCadFresh();
  const sol = cad > 0 ? CARD_MIN_NET_CAD / cad : 0.156;
  return Math.max(0.048, Math.ceil(sol * 1000) / 1000);
}

// Active money mode — tells the wallet widget whether to build SOL or USDC transfers and how to
// label balances. usdcMint is null in SOL mode.
app.get('/api/money-config', (req, res) => {
  // network lets the client build an explorer link that points at the cluster the
  // payout actually happened on, instead of guessing mainnet.
  res.json({ mode: money.mode, unit: money.unit, usdcMint: money.usdcMint || null, decimals: money.decimals || 6, network: process.env.SOLANA_NETWORK || 'mainnet-beta',
             // SOL <-> USDC in the player's own wallet (server/swap.js): what the Wallet tab offers.
             swap: money.mode === 'usdc', solReserve: Swap.RULES.RESERVE_LAMPORTS / 1e9,
             minConvertSol: Swap.RULES.MIN_SOL_IN / 1e9, minWithdrawSolUsd: Swap.RULES.MIN_USDC_IN / 1e6,
             cardStartSol: cardStartSol(),
             /* Coinbase Onramp's row in Add funds: held back while Coinbase caps this app at about
                US$5 a buy (wallet-widget/src/holdCoinbase.mjs); COINBASE_ONRAMP=on once raised. */
             coinbaseOnramp: process.env.COINBASE_ONRAMP === 'on' });
});

// ─── Cross-region stats: EU pushes to NA instantly on every change ────────────
/* The old agar.io game's agarPlayerCount used to ride along here. Nothing ever read it (the lobby
   cards count from /api/live), so it went with that game; an old EU server still sending it is
   simply ignored. */
let remoteStats = { playerCount: 0, liveStakesSol: 0 };
/* No public fallback secret on a deployed server (server/statsPush.js, security review 2026-10-15):
   without SESSION_SECRET there, NA refuses every push and EU sends none. */
const statsPush = require('./statsPush');
const STATS_SECRET = statsPush.statsSecret(process.env);
if (!STATS_SECRET) console.error('[STATS] CRITICAL SESSION_SECRET is not set: the EU stats push is refused here and never sent');

// Both servers expose their local counts (used by EU to self-report)
app.get('/api/stats', (req, res) => {
  res.json({ playerCount: totalInGame() });
});

// NA server receives pushed stats from EU
if (REGION === 'na') {
  app.post('/api/stats/push', express.json(), (req, res) => {
    if (!statsPush.secretOk(STATS_SECRET, req.headers['x-stats-secret'])) return res.sendStatus(403);
    remoteStats = statsPush.readStatsPush(req.body);
    broadcastLobbyState();
    res.sendStatus(204);
  });
}

// EU server pushes its counts to NA whenever broadcastLobbyState runs
const NA_PUSH_URL = 'https://duelseries.com/api/stats/push';
async function pushStatsToNA() {
  if (REGION !== 'eu' || !STATS_SECRET) return;
  try {
    await fetch(NA_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-stats-secret': STATS_SECRET },
      body: JSON.stringify({ playerCount: totalInGame(), liveStakesSol: sumLiveSelfCustodyStakes() }),
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
/* Every route that verifies a wallet signature or an owner token (/api/my-name, /api/owner/*,
   /admin/finance, /api/admin/*, the owner-gated debug reads). Signature checks are local
   arithmetic but not free, and none of these is called often by an honest browser: the owner
   console refreshes every 15 s, a rename is one click. 30 a minute per address. */
const sigLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down.' } });
/* /api/debug/client stays open (it is how a browser reports a stall), so it gets its own cap:
   diag.js posts every 20 s, so 6 a minute per address is double that. */
const clientReportLimiter = rateLimit({ windowMs: 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down.' } });
// /api/my-transactions costs a signature read plus one read per new transaction (a page is 20) per page it
// has not answered in the last 30 s. The wallet screen asks once when it opens, so 30 a minute
// per IP is far above any person and far below a loop (security review 2026-10-15).
// /api/my-transfers shares this one count (the same reads, the same screen): at most 60 new reads an
// ask, and the screen asks again only while the answer says it stopped short.
const txHistoryLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down.' } });
// Social search and profiles share one count: each answer is a database read. The search box asks at most
// every 250 ms while someone types, so 40 in 10 s is far above a person and well below a script.
const socialLimiter = rateLimit({ windowMs: 10 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down.' } });

// ─── Entry fee ────────────────────────────────────────────────────────────────
const LOBBY_FEES = money.lobbyFees; // { free, br, dollar }: the active money mode's fee table (keys validate lobby type)

// Server-authorised paid-entry tokens. /api/submit-stake mints one after verifying the
// player's on-chain stake landed in the escrow; PLAY / RESPAWN and the duel queues verify + consume
// it and take the snake's cash worth from THIS server value — never from the client's
// claimed entrySol (a modified client could otherwise inflate it and mint money on
// cash-out). One-time use; carries the staker's wallet for the on-chain cash-out.
const crypto = require('crypto');
const { makeEntryStore } = require('./entryStore');
const ENTRY_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;

// The stake ladder: free, 0.50, 1 (shared/stakeLadder.js). A closed set, so an
// amount is either on it or refused. See server/stakeRules.js.
const { STAKE_TIERS, ALL_STAKES, MIN_STAKE, MAX_STAKE,
        isStake, rungOf, tierFor, stakeRangeError, refundBound } = require('./stakeRules');

/* A paid token that expires unspent is a stake that landed and bought nothing:
   it is refunded, once, what landed, to the verified payer (server/entryExpiry.js,
   review finding). Paper's dev tokens go back through Paper's own payout, which is
   the fake withdraw in dev; paperPayout is defined further down and only read when
   a sweep runs, long after boot. Paid agar.io's and paid snake's on the sl engine
   ('slither', PAID-SL-DESIGN.md 11.1, critic C-10) go back through their own
   payouts the same way (agPayout, slPayout, both defined further down). */
/* Every verified stake has a durable row (server/stakeLedger.js, STATUS item 7a): a door claims
   it before seating, a refund claims it with its owed payout row, and at boot every stake an
   earlier boot of this server verified but never seated or refunded is refunded once. BOOT_ID
   names this process's rows, so the boot sweep leaves this boot's live tokens alone. */
const BOOT_ID = crypto.randomUUID();
/* Stake signatures this process is broadcasting or verifying right now (/api/submit-stake). The
   pending-verify sweep leaves them to their request, and while the database has no ledger
   columns this set alone refuses a second submit of the same bytes while the first is in flight. */
const stakeInFlight = new Set();
/* A stake that landed while its submit-stake request did not finish (security review 2026-10-15,
   finding 3) is owed what landed, capped at what it was for, exactly as a token's refund would
   be: the rung it covers for a ladder stake ('stake <rung>'), what landed for a tier stake. It is
   never minted late. A verify that says it paid short, failed, or did not pay the escrow is owed
   nothing (as at the request); any other error (the RPC, a lagging node) is asked again later. */
async function owedForLateStake(row) {
  const expected = Number(row.refund_amount);
  if (!(expected > 0)) return { reject: 'no amount on record' };
  let v;
  try {
    v = await money.verifyStake(row.sig, expected);
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/too small|did not pay the escrow|failed on-chain/i.test(m)) return { reject: m };
    throw e;
  }
  const ladder = String(row.label || '').startsWith('stake ');
  const amount = ladder ? refundBound(tierFor(v.worth) || 0, v.worth) : refundBound(v.worth);
  return { payer: v.payer, amount };
}
const stakeLedger = require('./stakeLedger').createStakeLedger({
  db,
  region: REGION,
  bootId: BOOT_ID,
  kickDrain: () => kickDrain(),
  chain: {
    status: (sig) => Wallet.stakeSigStatus(sig),
    blockhashValid: (blockhash) => Wallet.blockhashValid(blockhash),
    owed: (row) => owedForLateStake(row),
  },
  inFlight: (sig) => stakeInFlight.has(sig),
});

const refundExpiredEntry = require('./entryExpiry').createExpiryRefund({
  money,
  db,
  ledger: stakeLedger,
  devRefund: PAPER_DEV_TOKENS
    ? (t) => (t.onlyGame === 'slither' ? slPayout : t.onlyGame === 'agar' ? agPayout : paperPayout).refund({ wallet: t.walletAddress, name: 'Player', micro: Math.round(Number(t.worth) * 1e6), paid: t.paid, why: 'unspent' })
    : null,
});

// The store is the same logic that used to be inline here, moved out so it can
// be tested directly (test/entryStore.test.js). The tier behaviour is unchanged.
const entryStore = makeEntryStore({ ttlMs: ENTRY_TOKEN_MAX_AGE_MS, fees: LOBBY_FEES,
                                    isStake: isStake, onExpire: refundExpiredEntry });
// Sweep expired (paid-but-never-used) tokens: each one is refunded by onExpire.
// Every minute, so a refund goes out within a minute of its token's 5 minutes.
// Also retries any stake refund the database could not take yet.
setInterval(() => {
  entryStore.sweep();
  stakeLedger.retryQueued().catch((e) => console.error('[STAKE] retry', e.message));
}, 60 * 1000);

// Verify + consume an opaque paid-entry token the client echoes back from the
// /api/submit-stake response. The token is server-generated, unguessable, one-time, and
// carries the SERVER-recorded worth, so the client can neither forge it nor inflate the
// worth — that's what closes the entrySol escrow-drain hole. Needs no socket auth (the
// socket session is empty) and works for join + respawn identically.
/* The ladder's door. Same one-time, server-worth guarantee as the tier door
   below, but the token has to have been bought for this exact rung. `game`
   is also the door a scoped token is checked against: a Paper dev token opens
   Paper only, never a game that pays through the real money module. */
/* A durable entry (r.stakeSig) is recorded by enterPaid once it is seated, not here: its
   stake row is claimed first and the seat can still be refused after that. */
function consumePaidEntryAtStake(entryToken, stake, game) {
  const r = entryStore.consumeAtStake(entryToken, stake, game);
  return r.stakeSig ? r : recordEntry(r, game);
}
function consumePaidEntry(entryToken, shortType, game) {
  const r = entryStore.consume(entryToken, shortType);
  return r.stakeSig ? r : recordEntry(r, game);
}

/* EVERY PAID DOOR BUT PAPER'S (paperSockets.js has its own, same rules): snake PLAY and RESPAWN,
   ko:queue, bs:queue. agar.io has no paid door: the old game's cell:join and cell:respawn were
   deleted with it, and the new one (server/ag, the /ag namespace) reads no token at all.

   `entry` is what the consume returned (the token already left memory, one-time as before). A
   free, dev or non-durable entry is seated right here, synchronously, exactly as before. A
   durable one (STATUS item 7a) claims its stake row in the database FIRST, and only a won claim
   is seated, so a stake can never be both seated and refunded by a restart's sweep:
   - the database did not answer: nothing is seated, and the token goes back (nothing spent);
   - the row was refunded already (a sweep got there first): nothing is seated;
   - claimed, but the seat is refused by then (the socket went away while the claim was in
     flight, or seat() says no because the room changed meanwhile): the claim is turned into an
     owed refund, through the same row, once.
   seat(entry) returns false to decline; if it THROWS the seat may half exist, so nothing is
   refunded automatically (never pay twice) and the owed amount is logged for the owner.
   refuse(why): why is undefined (not verified), 'unavailable', 'settled' or 'refunded'. */
function enterPaid(socket, game, entry, seat, refuse) {
  if (!entry || !entry.ok) { refuse(undefined); return; }
  if (!entry.stakeSig) { seat(entry); return; }
  stakeLedger.claimSeat(entry).then((c) => {
    if (c === 'error') { if (entry.restore) entry.restore(); refuse('unavailable'); return; }
    if (c !== 'ok') { refuse('settled'); return; }
    let seated = false;
    if (socket.disconnected !== true) {
      try {
        seated = seat(entry) !== false;
      } catch (e) {
        console.error(`[ENTRY] CRITICAL ${game} seat threw after its stake was claimed; not refunded automatically, `
          + `owed at most ${entry.worth} to ${entry.walletAddress} (stake ${String(entry.stakeSig).slice(0, 16)}): ${e && e.stack ? e.stack : e}`);
        return;
      }
    }
    if (seated) { recordEntry(entry, game); return; }
    stakeLedger.refund(entry.stakeSig, `refund ${game} entry not seated`, entry.claimKey);
    if (socket.disconnected !== true) refuse('refunded');
  }).catch((e) => console.error('[ENTRY] door', game, e && e.stack ? e.stack : e));
}
const ENTRY_REFUSED = {
  unavailable: 'Could not confirm your entry right now. An entry that is never used is refunded within a few minutes.',
  settled: 'This entry was already refunded.',
  refunded: 'Could not seat you. Your entry was refunded.',
};
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

/* ledger: whether this boot's stake-ledger migrations went through (db.ensureLedgerSchema). Two
   booleans and nothing else, so the owner can confirm without server access that paid stakes are
   durable across a restart and that owed payouts use the two lanes (STATUS item 7e). Read before
   the RPC call so a Solana outage cannot hide it. */
function ledgerFlags() {
  return { durableStakes: db.features.durableStakes === true, payoutLanes: db.features.payoutLanes === true };
}

app.get('/wallet/debug', async (req, res) => {
  const ledger = ledgerFlags();
  try {
    const sigs = await Wallet.getRecentSigs();
    res.json({ escrowPubkey: Wallet.getEscrowPublicKey(), sigs, ledger });
  } catch (e) { res.json({ error: e.message, ledger }); }
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
app.get('/admin/finance', sigLimiter, async (req, res) => {
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
  // A key's size and alphabet before new PublicKey() decodes it (quadratic: server/b58Caps.js).
  if (!isWalletString(address)) return res.status(400).json({ error: 'Invalid address' });
  try {
    const sol = await money.balanceOf(address); // native unit (SOL or USDC); `sol` field kept for client back-compat
    /* The SOL beside the dollars (Owen, 2026-10-15: "Accept both, play in USDC"): card top-ups and
       exchange sends arrive as SOL, and the Wallet tab shows it under the balance with Convert. */
    // A failed SOL read never costs the dollar balance: it is shown as unknown instead.
    let solNative = null;
    if (money.mode === 'usdc') { try { solNative = await Wallet.getAddressBalance(address); } catch (_) { solNative = null; } }
    res.json({ address, sol, balance: sol, unit: money.unit, solNative });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Browser → server Solana RPC proxy: the frontend's wallet SDK makes its RPC calls here
// so they go through our server's RPC instead of a public endpoint that blocks browser
// origins (403). Same-origin, so no CORS. Not an open relay to our paid key (Wallet.forwardRpc,
// security review 2026-10-15): one request per call and only the wallet SDK's methods, else 400.
app.post('/api/rpc', rpcLimiter, async (req, res) => {
  const bad = Wallet.rpcRequestError(req.body);
  if (bad) return res.status(400).json({ error: bad });
  try {
    res.type('application/json').send(await Wallet.forwardRpc(req.body));
  } catch (e) {
    res.status(e && e.status === 400 ? 400 : 502).json({ error: e.message });
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

/* SOL <-> USDC in the player's own wallet (server/swap.js): the one-tap Convert to USDC, and
   Withdraw as SOL. Jupiter builds the transaction, the server checks it (the order, then a
   simulation read as balances) before the player is asked to sign, and execute sends only the
   message that passed, signed by the player, once. No escrow, stake or payout is involved, and
   nothing here signs anything: the player's wallet does. USDC mode only. */
const swap = Swap.createSwap({
  chain: Swap.chainFromConnection(Wallet.connection),
  jupiter: Swap.createJupiter({ apiKey: process.env.JUP_API_KEY || '' }),
  usdcMint: () => money.usdcMint,
  refSolUsd: () => prices.getSolUsdRate(),
  log: (m) => console.log('[SWAP] ' + m),
});
const swapQuoteLimiter = rateLimit({ windowMs: 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down.' } });
const swapExecLimiter = rateLimit({ windowMs: 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down.' } });
const SWAP_OFF = 'Converting is not available right now.';
function swapFail(res, e, what) {
  if (e && e.publicMessage) return res.status(400).json({ error: e.publicMessage, signature: e.signature || undefined });
  console.warn('[SWAP] ' + what + ' error: ' + (e && e.message));
  res.status(502).json({ error: what === 'execute'
    ? 'This is still confirming. Check your balance in a minute before trying again.'
    : 'Could not get a price. Try again.' });
}
app.get('/api/swap/quote', swapQuoteLimiter, async (req, res) => {
  if (money.mode !== 'usdc') return res.status(400).json({ error: SWAP_OFF });
  try {
    res.json(await swap.quote({ wallet: strOr(req.query.wallet, ''), dir: strOr(req.query.dir, ''),
                                amount: strOr(req.query.amount, ''), receiver: strOr(req.query.receiver, '') || null }));
  } catch (e) { swapFail(res, e, 'quote'); }
});
app.post('/api/swap/execute', swapExecLimiter, express.json({ limit: '16kb' }), async (req, res) => {
  if (money.mode !== 'usdc') return res.status(400).json({ error: SWAP_OFF });
  const b = req.body || {};
  try {
    res.json(await swap.execute({ requestId: strOr(b.requestId, ''), signedTransaction: strOr(b.signedTransaction, '') }));
  } catch (e) { swapFail(res, e, 'execute'); }
});

/* Maintenance stops new STAKES, not only new joins (BACKLOG 2.1, map 4.8). Joins were already
   refused while it was on, but a stake could still be quoted, signed and broadcast: it was
   refunded at the refused join, yet the drain never settled while stakes kept landing, and a
   broadcast cut short by the restart could land with no row and no token. So both the quote
   and the submit refuse while maintenance is on, before any wallet prompt or broadcast: a
   transfer signed just before it went on is never sent, and expires with nothing moved. Free
   quotes still answer, since they move no money. */
function stakePaused() {
  const m = ops.get();
  return { error: 'Paid games are paused for maintenance. ' + (m.message || 'Back shortly.'), maintenance: true };
}
/* The ladder is priced in dollars, so it is staked in USDC only. Under MONEY_MODE=sol (the
   documented rollback) verifyStake reports what landed in SOL, tierFor compared about 0.003 SOL
   against the $0.50 rung, found none, and answered 400 AFTER the broadcast and before the stake
   row was written: the money sat in escrow with no record and no refund. So every paid ladder
   quote and submit is refused in any other mode, before a wallet prompt or a broadcast. */
const LADDER_NEEDS_USDC = 'Paid buy-ins are not available right now. Free play still works.';
const ladderPriced = () => money.mode === 'usdc';

/* The pending-verify claim, made BEFORE a client-signed stake is broadcast (security review
   2026-10-15, findings 3 and 5; server/stakeLedger.js). Wallet.submitStake reads the signature,
   the fee payer and the blockhash off the signed bytes and awaits this first; a throw here means
   nothing is sent. The row it writes ('verifying', keyed by the signature) refuses a second
   submit of the same bytes before it reaches the chain, so whoever saw the bytes after we sent
   them cannot take the stake's token, and if this request then fails (a status read that throws,
   the confirm timeout, a lagging node, a restart) the stake sweep finds the row and refunds what
   landed to the payer the chain shows. `expected` is what the verify needs to see land, `label`
   names the rung or tier ('stake <rung>' or 'lobby <type>'). pre.sig marks this request's own
   entry in stakeInFlight (removed when the request ends); pre.durable says the row was written,
   so the claim after the verify is that row's. */
const STAKE_SETTLED_LATE = 'This stake took too long to confirm. It was not used, and it is being refunded to your wallet.';
function preclaimStake(expected, label, pre) {
  return async (info) => {
    if (stakeInFlight.has(info.signature)) throw new Error('Stake already used');
    stakeInFlight.add(info.signature);
    pre.sig = info.signature;
    const c = await stakeLedger.preclaim(info.signature, { wallet: info.payer, amount: expected, label, blockhash: info.blockhash });
    if (!c.claimed) throw new Error('Stake already used');
    pre.durable = c.durable;
  };
}

// ── Self-custody staking (Phase 1) ───────────────────────────────────────────
// Quote how much SOL to stake for a paid lobby and where (the escrow), plus a fresh
// blockhash for the client to build the transfer. No custodial balance is touched.
app.get('/api/stake-quote', entryFeeLimiter, async (req, res) => {
  // Any-amount path, used by the redesigned lobby. Taken only when a `stake` is
  // supplied, so the tier path below is byte-for-byte what it was for the live
  // client. The two run side by side until cutover.
  if (req.query.stake !== undefined) {
    const bad = stakeRangeError(Number(req.query.stake));
    if (bad) return res.status(400).json({ error: bad });
    // Quoted at the ladder's own number, never the request's (review finding: 0.10499 was
    // quoted as 104990 units and then bought the $0.10 rung, a rung at the time).
    const stake = rungOf(Number(req.query.stake));
    if (stake === null) return res.status(400).json({ error: 'Not an amount' });
    if (stake === 0) return res.json({ stake: 0, escrowAddress: null, lamports: 0, feeSol: 0 });
    if (!ladderPriced()) return res.status(503).json({ error: LADDER_NEEDS_USDC });
    if (ops.get().maintenance) return res.status(503).json(stakePaused());
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
  if (ops.get().maintenance) return res.status(503).json(stakePaused());
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
  const { lobbyType, stake, signedTx, walletAddress, devGame } = req.body || {};
  /* Each field pinned to its type before anything reads it, and refused here, before the
     signed transaction is broadcast, so a refusal costs nobody anything. This is an async route
     and Express 4 does not catch a rejection from one: a stake of {"toString":1} threw in
     Number() below and ended the whole process, every live paid game with it. A walletAddress
     of that shape got further, past the stake's one-time claim, and then threw in the log line
     that names it, stranding a claimed stake with no token. An honest client sends strings and
     a number, which all pass exactly as before. */
  if ((stake !== undefined && typeof stake !== 'number' && typeof stake !== 'string')
      || (lobbyType !== undefined && typeof lobbyType !== 'string')
      || (signedTx !== undefined && signedTx !== null && typeof signedTx !== 'string')
      || (walletAddress !== undefined && walletAddress !== null && typeof walletAddress !== 'string')
      /* devGame names the game a DEV token is scoped to (PAPER_DEV_TOKENS only, PAID-AGAR-DESIGN.md 5.7):
         absent, 'paper', 'agar' or 'slither' (paid snake on the sl engine, PAID-SL-DESIGN.md 6), nothing
         else, checked before anything reads it. */
      || (devGame !== undefined && devGame !== 'paper' && devGame !== 'agar' && devGame !== 'slither')) {
    return res.status(400).json({ error: 'Malformed request' });
  }
  // No new stake while maintenance is on, refused before anything is broadcast (stakePaused).
  if (ops.get().maintenance) return res.status(503).json(stakePaused());

  /* Ladder path. The requested rung is only a floor passed to verifyStake; the
     token is minted against what actually landed in escrow, resolved down to
     the largest rung that payment covers. So the room a player may enter is
     derived from what they really paid, never from what the request claimed:
     ask for the $1.00 room having paid $0.50 and you get the $0.50 room.

     Snapping down rather than demanding an exact match matters because by this
     point the stake has settled on-chain. A small overpay must still buy the
     rung it covers; refusing would leave someone out of pocket with no seat. */
  if (stake !== undefined) {
    const bad = stakeRangeError(Number(stake));
    if (bad) return res.status(400).json({ error: bad });
    // The ladder's own number from here on: verified, minted and answered as the rung.
    const want = rungOf(Number(stake));
    if (want === null) return res.status(400).json({ error: 'Not an amount' });
    if (want === 0) return res.status(400).json({ error: 'Free play needs no stake' });
    /* Dev entry tokens (PAPER_DEV_TOKENS, refused at boot beside an escrow key
       or in production). No chain and no signature to claim, but the token is
       minted through the same store at the rung, so the join order, the
       one-time consume and recordEntry all run exactly as for real money.
       Scoped to Paper (or to paid agar.io with devGame 'agar', or to paid
       snake on the sl engine with devGame 'slither'): only those three pay it
       out through their fake withdraw, and any other game would pay, refund or
       rake it through the real one. */
    if (!signedTx && PAPER_DEV_TOKENS) {
      if (typeof walletAddress !== 'string' || !walletAddress || walletAddress.length > 64) {
        return res.status(400).json({ error: 'Missing wallet address' });
      }
      const rung = tierFor(want);
      const onlyGame = devGame === 'agar' ? 'agar' : 'paper';
      // the sl door's scope (slPaidDoor GAME): opened by no other door, refunded by slPayout when it expires
      const scope = devGame === 'slither' ? 'slither' : onlyGame;
      const entryToken = entryStore.mint({ stake: rung, worth: rung, paid: rung, walletAddress, onlyGame: scope });
      console.warn(`[PAPER] DEV token ${rung} (${scope}) for ${walletAddress.slice(0, 8)}`);
      return res.json({ ok: true, entryToken, worth: rung, stake: rung, paid: rung, dev: true });
    }
    if (!signedTx) return res.status(400).json({ error: 'Missing signed transaction' });
    // USDC only, refused before the broadcast (ladderPriced). Dev tokens above touch no chain.
    if (!ladderPriced()) return res.status(503).json({ error: LADDER_NEEDS_USDC });
    const pre = { sig: null, durable: false };
    try {
      // The pending-verify row is written before the bytes are broadcast (preclaimStake).
      const sig = await Wallet.submitStake(Buffer.from(signedTx, 'base64'),
        { beforeSend: preclaimStake(money.amountFor(want), 'stake ' + want, pre) });
      const { payer, worth } = await money.verifyStake(sig, money.amountFor(want));
      const rung = tierFor(worth);
      if (!rung) return res.status(400).json({ error: 'Payment did not cover any buy-in' });
      // Atomic one-time claim AFTER verify, as in the tier path below. The same statement writes
      // the stake's durable row (who is owed, what a refund pays: what landed, capped at the
      // rung), so a restart before the join refunds it instead of losing it (STATUS item 7a).
      // With a pending-verify row it is that row's 'verifying' -> 'pending'.
      const rec = await stakeLedger.record(sig, { wallet: payer, amount: refundBound(rung, worth), label: 'stake ' + rung, preclaimed: pre.durable });
      if (!rec.claimed) return res.status(400).json({ error: pre.durable ? STAKE_SETTLED_LATE : 'Stake already used' });
      /* worth is the rung, not the raw payment: everyone in a room has to be
         worth the same on entry or the eat-and-take rule stops being symmetric.
         Any excess over the rung stays in escrow. */
      /* The payout address is the VERIFIED on-chain payer, never the one in
         the request. This used to be `walletAddress || payer`, so the address
         escrow eventually pays out to came from an unauthenticated field —
         the one client-supplied value in the money path that was still being
         trusted, after worth was carefully taken out of the client's hands.
         A request naming another wallet is logged loudly but still minted, to
         the payer: by here the signature is claimed and the transfer can never
         be submitted again, so refusing stranded the stake in escrow with no
         token and no retry (review finding). Nothing is redirected either way:
         the token, its refunds and its cash-out all go to the payer. */
      if (walletAddress && walletAddress !== payer) {
        console.warn(`[STAKE] request named ${String(walletAddress).slice(0, 12)} but ${payer} paid ${sig}: minted to the payer`);
      }
      /* paid is what landed. In USDC mode that is at least the rung now (the
         verifier is exact; SOL mode still allows 5 percent under). It rides the
         token only to bound a refund: a join the server refuses sends back what
         landed, never more than the rung. */
      const entryToken = entryStore.mint({ stake: rung, worth: rung, paid: worth, walletAddress: payer,
                                           stakeSig: rec.durable ? sig : undefined });
      return res.json({ ok: true, entryToken, worth: rung, stake: rung, paid: worth });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    } finally {
      if (pre.sig) stakeInFlight.delete(pre.sig);
    }
  }

  // Own keys only: 'constructor' used to find Object here and go on to verify and mint a token
  // for a lobby that does not exist.
  const fee = ownKey(LOBBY_FEES, lobbyType) ? LOBBY_FEES[lobbyType] : undefined;
  if (fee === undefined || fee === 0) return res.status(400).json({ error: 'Not a paid lobby' });
  if (!signedTx) return res.status(400).json({ error: 'Missing signed transaction' });
  const pre = { sig: null, durable: false };
  try {
    // Broadcast (works for any signed tx), after the pending-verify row is written (preclaimStake).
    const sig = await Wallet.submitStake(Buffer.from(signedTx, 'base64'),
      { beforeSend: preclaimStake(money.feeFor(lobbyType), 'lobby ' + lobbyType, pre) });
    // Verify the stake landed in escrow and read the SERVER-recorded worth (SOL or USDC, per mode).
    const { payer, worth } = await money.verifyStake(sig, money.feeFor(lobbyType));
    // Atomic one-time claim AFTER verify — closes the double-mint race (two concurrent
    // requests with the same sig can't both pass) without burning a valid sig on a transient
    // verify failure. If it returns false, another request already consumed this stake.
    const rec = await stakeLedger.record(sig, { wallet: payer, amount: refundBound(worth), label: 'lobby ' + lobbyType, preclaimed: pre.durable });
    if (!rec.claimed) return res.status(400).json({ error: pre.durable ? STAKE_SETTLED_LATE : 'Stake already used' });
    // Same rule as the ladder path above: pay out to who actually paid, and a
    // request naming someone else is logged, never left holding a claimed stake.
    if (walletAddress && walletAddress !== payer) {
      console.warn(`[STAKE] request named ${String(walletAddress).slice(0, 12)} but ${payer} paid ${sig}: minted to the payer`);
    }
    const entryToken = entryStore.mint({ lobbyType, worth, walletAddress: payer, stakeSig: rec.durable ? sig : undefined });
    res.json({ ok: true, entryToken, worth, worthSol: worth }); // worthSol kept for current client back-compat
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    if (pre.sig) stakeInFlight.delete(pre.sig);
  }
});

/* ── Buying skins (docs/skin-purchases.md; server/skinShop.js holds the money logic and its reasons) ──
   The player's own wallet pays USDC straight to REVENUE_WALLET; the server checks the signed bytes before it
   broadcasts them, verifies what landed, claims the signature once and records the skin and the sale together.
   Prices are the server's own reading of the price list (server/skinCatalog.js). USDC mode only; nothing is sold
   while the owner has the site in maintenance or the purchase table could not be made. */
const skinShop = createSkinShop({
  store: {
    ownsItem: (w, item) => db.ownsCosmetic(w, item),
    owned: (w) => db.getOwnedCosmetics(w),
    skinOpen: (r) => db.skinOpen(r), skinRow: (ref) => db.skinRow(ref),
    skinSubmit: (ref, sig, bh, lv) => db.skinSubmit(ref, sig, bh, lv), skinReopen: (ref, sig) => db.skinReopen(ref, sig),
    skinClose: (ref, sig, st, from) => db.skinClose(ref, sig, st, from), skinGrant: (ref, sig, o) => db.skinGrant(ref, sig, o),
    skinDue: (o) => db.skinDue(o), skinExpiredDue: (o) => db.skinExpiredDue(o),
    skinExpire: (ref) => db.skinExpire(ref), skinExpireOpen: (o) => db.skinExpireOpen(o),
  },
  chain: liveChain({ Wallet, Usdc }),
  mint: Usdc.USDC_MINT.toString(),
  revenueAta: Usdc.ataFor(REVENUE_WALLET),
  ready: () => money.mode === 'usdc' && !!db.features.skinShop,
  paused: () => !!ops.get().maintenance,
  // The sale's ledger row is written by db.skinGrant in the same transaction; this is PostHog's copy.
  onPaid: ({ wallet, item, game, usdc }) => analytics.captureEarning({ source: 'cosmetic', amountUsdc: usdc, game, lobbyType: item, wallet }),
});
const skinPasses = sharedSkinPass();
setInterval(() => { skinShop.sweep().catch(() => {}); }, 60 * 1000).unref();
const skinIntentLimiter = rateLimit({ windowMs: 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down.' } });
const skinBuyLimiter = rateLimit({ windowMs: 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down.' } });
const skinReadLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down.' } });
function skinReply(res, p) {
  return p.then((r) => res.status(r.status).json(r.body)).catch((e) => {
    console.error('[SKINS] route error:', e && e.message);
    res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
  });
}
app.post('/api/skins/intent', skinIntentLimiter, express.json({ limit: '4kb' }), (req, res) => skinReply(res, skinShop.intent(req.body)));
app.post('/api/skins/buy', skinBuyLimiter, express.json({ limit: '16kb' }), (req, res) => skinReply(res, skinShop.buy(req.body)));
app.get('/api/skins/purchase/:ref', skinReadLimiter, (req, res) => skinReply(res, skinShop.purchase(req.params.ref)));
app.get('/api/skins/owned', skinReadLimiter, (req, res) => skinReply(res, skinShop.owned(req.query.wallet)));
/* The skin pass a game page sends with its join (server/skinPass.js): a one-time signature by the wallet over
   action 'skins:pass' (ownerAuth's message; /api/owner/do runs no such action), answered with the items it owns. */
app.post('/api/skins/pass', sigLimiter, express.json({ limit: '4kb' }), async (req, res) => {
  const proof = req.body && typeof req.body === 'object' ? req.body.proof : null;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || proof.action !== 'skins:pass') {
    return res.status(400).json({ error: 'Malformed request' });
  }
  const wallet = ownerAuth.walletForAction(proof);
  if (!wallet) return res.status(401).json({ error: 'Could not confirm your wallet. Try again.' });
  try {
    const items = (await db.getOwnedCosmetics(wallet)).filter((i) => skinCatalog.parseItem(i) || /^[a-z0-9]+:[a-z0-9]+$/.test(i));
    const { pass, exp } = skinPasses.mint(wallet, items);
    res.json({ pass, exp, items });
  } catch (e) {
    console.error('[SKINS] pass:', e && e.message);
    res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
  }
});

// (Phase B2 security: the legacy /api/verify-stake endpoint was removed — it duplicated
// /api/submit-stake's token minting and was unused by the client, so it only widened the
// attack surface. The silent-sign flow uses /api/submit-stake exclusively.)

// Owner-only: review collusion flags (persisted) + the current live suspicious pairs.
app.get('/api/admin/collusion', sigLimiter, async (req, res) => {
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
app.get('/api/admin/escrow', sigLimiter, async (req, res) => {
  if (!(await isOwnerReq(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    const diag = await Wallet.getEscrowDiagnostics();
    res.json(diag);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Owner-only: live solvency snapshot (escrow vs custodial ledger + live self-custody stakes).
app.get('/api/admin/solvency', sigLimiter, async (req, res) => {
  if (!(await isOwnerReq(req))) return res.status(403).json({ error: 'Forbidden' });
  await checkSolvency();
  res.json(_lastSolvency || { error: 'no data yet' });
});

// Owner-only: cash-out payouts that failed on-chain (e.g. an RPC outage) and are owed but
// unpaid. Lets the owner see who's owed what and pay it out manually until an automatic
// drainer exists. `paid` rows are kept for the audit trail.
app.get('/api/admin/failed-payouts', sigLimiter, async (req, res) => {
  if (!(await isOwnerReq(req))) return res.status(403).json({ error: 'Forbidden' });
  try {
    res.json(await db.getFailedPayouts(200));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Owner earnings: total house take (game rake + cosmetic sales) with a live feed.
app.get('/api/admin/earnings', sigLimiter, async (req, res) => {
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

app.get('/api/profile/:name', socialLimiter, async (req, res) => {
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
/* totalUsd is what the lobby shows (Owen, 2026-10-15: keep the tile, fix the
   number). The old answer added CAD (SOL-era rows, the 294 above) to USD (every
   row since the USDC cutover) and the lobby printed the mix with a bare "$".
   Now the CAD part is turned into dollars at the live CAD-per-USD rate
   (prices.getUsdCadRate); with no rate yet it is null and the tile shows a
   dash rather than a guess. totalCad stays for anything still reading it. */
app.get('/api/stats/winnings', async (req, res) => {
  try {
    const totalCad = await db.getGlobalWinnings();
    let totalUsd = null;
    const rate = prices.getUsdCadRate();
    if (rate && db.getGlobalWinningsSplit) {
      const s = await db.getGlobalWinningsSplit();
      totalUsd = Math.round((s.usd + (s.cad + PRE_TRACKING_WINNINGS_CAD) / rate) * 100) / 100;
    }
    res.json({ totalCad: totalCad + PRE_TRACKING_WINNINGS_CAD, totalUsd });
  } catch (e) {
    res.json({ totalCad: 0, totalUsd: null });
  }
});

/* The lobby's "Players have cashed out $X" strip (server/earnings), and
   Social's "Global player winnings" (/api/earnings/total, the same total from
   the same cache). Read only, one cached read a minute plus one per landed
   cash-out; the off switch is server/earnings/config.js SHOW, or the owner
   console's earnings:off, and it hides both. */
const earnings = require('./earnings').createEarnings({
  query: process.env.DATABASE_URL ? (sql, params) => db.pool.query(sql, params) : null,
  excludeWallets: [...OWNER_WALLETS, REVENUE_WALLET],
  previewExclude: [REVENUE_WALLET],
  switchFile: process.env.EARNINGS_SWITCH_PATH || path.join(__dirname, 'data', 'earnings-switch.json'),
});
earnings.route(app);
// A landed cash-out refreshes the figure within seconds (Social's live Global player winnings).
if (typeof db.onEarningsRecorded === 'function') db.onEarningsRecorded(() => earnings.poke());

app.get('/api/players/search', socialLimiter, async (req, res) => {
  const q = strOr(req.query.q, '').trim();   // ?q[]=a is an array: .trim() threw, process gone
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
  const wallet = strOr(req.query.wallet, '').trim();   // a string only: ?wallet[]=a threw
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
app.post('/api/my-name', sigLimiter, async (req, res) => {
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
/* A battle royale has begun the moment the count starts, not when it reaches
   zero. Written once so the two cash-out paths cannot drift apart. */
/* How long a room stays empty after the console's Clear. Long enough to
   actually measure something with the bots out of the way, short enough that a
   forgotten click heals itself. */
const BOTS_PAUSE_MS = 15 * 60 * 1000;

const brClosed = (room) => room.state === 'running' || room.state === 'countdown';

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
  /* The tanks arena too. It is one room for the whole region rather than a
     ladder, and it answers to the same playerCount / botCount / addBot /
     clearBots the console already uses. Anything here that wants `.snakes`
     skips it on its own — drainStatus does exactly that — so this adds a room
     to the console without adding a case to everything that reads the list. */
  if (typeof shooterRoom !== 'undefined' && shooterRoom) out.push(shooterRoom);
  /* Every Paper arena, overflow ones included. Each answers to the same
     playerCount / botCount / addBot / clearBots, its `snakes` lists the live
     paid squares and its `floorWorth` the coins on its floor, so drainStatus
     counts both kinds of Paper money before a push. */
  if (typeof paperArenas !== 'undefined' && paperArenas) out.push(...paperArenas.all());
  /* The agar.io rooms (server/ag, only while AG_ENABLED opened them): the same
     playerCount / botCount / botsAllowed / addBot / clearBots. The free rung
     holds no money; a paid room's `snakes` lists every open account with its
     worth (away and frozen ones included) and settling rooms are in all(), so
     drainStatus counts agar money before a push. */
  if (typeof agArenas !== 'undefined' && agArenas) out.push(...agArenas.all());
  /* The new slither.io free room (server/sl, only while SL_ENABLED opened it):
     the same playerCount / botCount / botsAllowed / addBot / clearBots; its
     snakes carry worth 0, so drainStatus counts its players and never money. */
  if (typeof slArenas !== 'undefined' && slArenas) out.push(...slArenas.all());
  /* The battle royale's room on the sl engine (server/slBr): free, no money. */
  if (typeof slBr !== 'undefined' && slBr) out.push(...slBr.all());
  /* Paid snake on the sl engine (server/slPaid, only while openSlPaid built
     it): every paid room, settling ones included. A room's `snakes` lists every
     open account (live, gliding or parked) with its worth and its `floorWorth`
     the gold on its floor, both in dollars (PAID-SL-DESIGN.md 7.5), so
     drainStatus counts paid snake money before a push; it takes no bots. */
  if (typeof slPaid !== 'undefined' && slPaid) out.push(...slPaid.all());
  return out;
};

/* A room's name in words, for the owner console. `na_free` and `ag_na_s0#1`
   are what the code calls them; nobody should have to translate that in their
   head while looking for the free slither table. */
function roomLabel(r) {
  const raw = String(r.lobbyType || '');
  if (raw === 'tanks') return 'Awesome Tanks';
  // Paper arenas are `paper_na_s0_5#2`: the rung, then which overflow arena.
  if (raw.startsWith('paper_')) {
    return 'Paper · ' + (r.stake === 0 ? 'Free' : '$' + Number(r.stake).toFixed(2))
      + (r.index > 0 ? ' #' + r.index : '');
  }
  /* The new slither.io free room (server/sl) is `sl_na_s0`; the paid rooms
     (server/slPaid) are `sl_na_s0_5#1` / `sl_na_s1`: the rung, then which room. */
  if (raw.startsWith('sl_')) {
    if (r.isBattleRoyale) return 'slither.io (new) · Battle royale';
    const m = /^sl_[a-z]+_s(\d+(?:_\d+)?)(?:#(\d+))?$/.exec(raw);
    const stake = m ? Number(m[1].replace('_', '.')) : 0;
    return 'slither.io (new) · ' + (stake > 0 ? '$' + stake.toFixed(2) : 'Free')
      + (m && m[2] ? ' #' + m[2] : '');
  }
  // The agar.io rooms are `ag_na_s0#1` / `ag_na_s0_5#2`: the rung, then which overflow room.
  if (raw.startsWith('ag_')) {
    return 'agar.io · ' + (Number(r.stake) > 0 ? '$' + Number(r.stake).toFixed(2) : 'Free')
      + (r.index > 0 ? ' #' + r.index : '');
  }
  // Everything left is the slither.io game: the fixed tiers, the nightly event and the ladder rungs.
  const type = raw.replace(/^(na|eu)_/, '');
  const game = 'slither.io';

  /* A LADDER RUNG NAMES ITS OWN PRICE. These rooms are called `na_s0` and
     `na_s0_5`, and this printed the raw id, so the one room every free snake
     player is actually in came up as "slither.io · s0" — which reads like a
     debug artefact sitting underneath a row called "slither.io · Free" that
     nobody is routed to on purpose. Adding bots to the wrong one of those two
     is a control that looks broken while working perfectly, and it cost an
     afternoon. */
  const rung = /^s(\d+(?:_\d+)?)$/.exec(type);
  if (rung) {
    const stake = Number(rung[1].replace('_', '.'));
    return game + ' · ' + (stake === 0 ? 'Free' : '$' + stake.toFixed(2));
  }

  /* SAY WHICH ROOMS ARE THE OLD ONES. The snake fixed tiers pre-date the
     ladder and nothing on the lobby board points at them any more — they are
     kept only as the fallback `getRoomForType` lands on. The nightly event is
     NOT one of these: it is on the lobby, so it is not marked. */
  const oldTier = !r.isBattleRoyale;
  const tier = type === 'free'   ? (oldTier ? 'Free (old tier, off the board)' : 'Free')
             : type === 'br'     ? 'Battle royale'
             : type === 'dollar' ? '$1' + (oldTier ? ' (old tier, off the board)' : '')
             : type;
  return game + ' · ' + tier;
}

/* What the console shows. Readable by an owner only: it carries live player
   counts and staked worth, which is nobody else's business. */
function opsSnapshot() {
  const br = activeBr();
  const rooms = ALL_ROOMS().map(r => ({
    id: r.lobbyType,
    game: r.isBattleRoyale ? 'battle royale'
        : r.lobbyType === 'tanks' ? 'Awesome Tanks'
        : String(r.lobbyType).startsWith('paper_') ? 'Paper'
        : String(r.lobbyType).startsWith('ag_') ? 'agar.io'
        : String(r.lobbyType).startsWith('sl_') ? 'slither.io (new)' : 'slither.io',
    players: r.playerCount !== undefined ? r.playerCount : (r.players ? r.players.size : 0),
    bots: r.botCount !== undefined ? r.botCount : 0,
    /* Whether this room can hold bots AT ALL, asked of the room rather than
       worked out again on the client. The console used to offer every room in
       one dropdown and refuse most of them after the fact, so the control that
       adds bots mostly did nothing and never said why beforehand. */
    takesBots: typeof r.botsAllowed === 'function' ? r.botsAllowed() : false,
    label: roomLabel(r),
    /* Paper only (undefined, so absent, for every other room): money lying on
       an arena floor. It is memory only like a live stake but the drain does
       not count it, so this is where to look before a push. */
    floorWorth: r.floorWorth,
    /* Paid agar.io only (PAID-AGAR-DESIGN.md 8.2): eject-feed pairs of the last
       24 h (count, value, same address) and the seats that are away. */
    feedFlags: r.money && typeof r.money.feedFlags === 'function' ? r.money.feedFlags() : undefined,
    parked: r.money && typeof r.money.parkedCount === 'function' ? r.money.parkedCount() : undefined,
  }));
  return {
    now: Date.now(),
    region: REGION,
    uptimeSec: Math.round(process.uptime()),
    maintenance: ops.get(),
    drain: ops.drainStatus(ALL_ROOMS(), entryStore.pending()),
    battleRoyale: br ? Object.assign(br.publicState(), { engine: brOnSl() ? 'sl' : 'old' }) : null,
    /* Paid snake on the new engine's door, for the owner page's readout: built
       (SL_PAID), open (sl:paid:off/on), saved (a close that outlives a restart). */
    slPaid: slPaid ? { enabled: !!slPaid.paidEnabled, open: !!slPaid.paidOpen, stopping: !!slPaid.stopping,
                       saved: slPaidSwitch.saved() } : null,
    /* The same readout for paid agar.io and paid Paper (agar:paid:off/on,
       paper:paid:off/on; both saved across restarts, security review item b). */
    agPaid: agArenas ? { enabled: !!agArenas.paidEnabled, open: !!agArenas.paidOpen, stopping: !!agArenas.stopping,
                         saved: agPaidSwitch.saved() } : null,
    paperPaid: paperArenas ? { enabled: !!paperArenas.paidEnabled, open: !!paperArenas.paidOpen,
                               stopping: !!paperArenas.stopping, saved: paperPaidSwitch.saved() } : null,
    earnings: earnings.stats(),
    rooms,
    audit: ownerAuth.auditLog.slice(0, 25),
  };
}

app.post('/api/owner/state', sigLimiter, async (req, res) => {
  if (!(await isOwnerReq(req))) return res.status(403).json({ error: 'Not an owner' });
  res.json(opsSnapshot());
});

app.post('/api/owner/do', sigLimiter, async (req, res) => {
  const who = ownerFromSignature(req.body);
  if (!who && !(await isOwnerReq(req))) {
    return res.status(403).json({ error: 'Not an owner' });
  }
  const action = strOr(req.body && req.body.action, '');
  const args = (req.body && req.body.args) || {};
  const done = (note) => { ownerAuth.audit(action, args, who || 'token', true, note);
                           res.json({ ok: true, note, state: opsSnapshot() }); };
  const refuse = (why) => { ownerAuth.audit(action, args, who || 'token', false, why);
                            res.status(409).json({ error: why, state: opsSnapshot() }); };

  const br = activeBr();

  switch (action) {
    /* Start the nightly match. `force` is for testing it alone: the two-player
       minimum is there to stop a real match being 'won' by the only person in
       the room, and the owner deliberately overriding that on an empty evening
       is not the case it protects against. */
    case 'br:start': {
      if (!br) return refuse('No battle royale room');
      // Not just 'running' — a countdown is one starting, and over/reopening
      // is one finishing. Any of them means a match is already under way.
      if (br.state !== 'waiting') return refuse('A match is already under way');
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
      if (!br || (br.state !== 'running' && br.state !== 'countdown')) {
        return refuse('No match is running');
      }
      br.abandon();
      return done('Match stopped, no prize paid');
    }
    /* Which engine runs the event (server/slBr). Saved, so it lasts across a
       restart or a deploy. Refused while a match is under way on the current
       one: that match finishes where it started. */
    case 'br:engine:old':
    case 'br:engine:sl': {
      const toNew = action === 'br:engine:sl';
      if (toNew && !slBr) return refuse('The new slither.io room is not open (SL_ENABLED)');
      if (br && br.state !== 'waiting') return refuse('A match is under way; stop it or let it finish first');
      const left = br && typeof br.humanLiving === 'function' ? br.humanLiving() : 0;
      brOnNew = toNew;
      if (toNew) slBr.startRoom(); // filled before anybody arrives, as at boot
      const kept = brEngineSwitch.save(toNew);
      console.warn('[BR] owner console: battle royale on the ' + (toNew ? 'NEW' : 'OLD') + ' engine' +
        (kept.ok ? ' (saved)' : ' (NOT saved: ' + kept.why + ')'));
      return done('The battle royale now runs on the ' + (toNew ? 'new slither.io engine' : 'old engine') + '. ' +
        (left ? left + ' player(s) still in the other engine\'s room keep playing there; the next match starts here. ' : '') +
        (kept.ok ? 'It stays there across restarts and deploys.'
          : 'This could not be saved (' + kept.why + '), so it lasts only until the next restart.'));
    }

    /* Bots, per room and reversible. The old control could only add, could only
       add to whatever room the owner's own socket happened to be in, and had no
       way to take them out again. */
    case 'bots:add':
    case 'bots:clear': {
      /* Every room, not just the snake ones. agar and the tanks arena answer
         to the same addBot/clearBots, so the console did not need to learn
         about either of them — it needed to stop looking in one list. */
      const room = ALL_ROOMS().find(r => r.lobbyType === args.room);
      if (!room) return refuse('No room called ' + args.room);
      if (action === 'bots:clear') {
        let removed = 0;
        if (typeof room.clearBots === 'function') {
          /* Counted when the room does not say: PaperRoom.clearBots returns
             nothing, and the console reported 'Removed undefined'. */
          const before = room.botCount;
          const n = room.clearBots();
          removed = typeof n === 'number' ? n : Math.max(0, (before || 0) - (room.botCount || 0));
        } else if (room.snakes) {
          for (const [id, s] of [...room.snakes]) {
            if (s && s.isBot) { room.snakes.delete(id); removed++; }
          }
        }
        /* AND THEY STAY GONE. The automatic top-up runs once a second, so
           clearing a room used to last about one second — the ops log shows
           four clears in two minutes, each reporting success, because each one
           really did remove them and the next tick really did put them back.
           The button is for taking the bots off to see what the game costs
           without them, and it could not do that.

           A window rather than a switch: a room cannot be left permanently
           empty by a click somebody forgot about, and the console says how long
           it has. Adding bots by hand lifts it immediately. */
        /* Paper has no such window: the free arena tops its own bots back up
           within seconds, and a paid one never has any, so the console says
           that instead of promising a pause. */
        if (String(room.lobbyType).startsWith('paper_')) {
          broadcastLobbyState();
          return done('Removed ' + removed + ' bot(s) from ' + room.lobbyType
            + (room.botsAllowed()
              ? '. This arena tops its bots back up on its own within seconds.'
              : '. A paid Paper arena never has bots.'));
        }
        room._botsPausedUntil = Date.now() + BOTS_PAUSE_MS;
        broadcastLobbyState();
        return done('Removed ' + removed + ' bot(s) from ' + room.lobbyType
          + ' — staying empty for ' + Math.round(BOTS_PAUSE_MS / 60000) + ' minutes');
      }
      /* By hand means by hand. The automatic floor is a floor, not a ceiling,
         and an owner asking for a hundred bots to test something with should
         get a hundred. The only thing that still refuses is a room that takes
         a stake, and that one is not negotiable. */
      const n = Math.min(Math.max(1, parseInt(args.count, 10) || 1), 500);
      if (!room.addBot) return refuse('That room does not take bots');
      /* COUNTED, not assumed. addBot returns null when it refuses, and this
         reported 'Added 3' for three refusals — a console that lies about what
         it just did is worse than one that fails out loud. */
      /* Asking for bots lifts a Clear. Otherwise +5 during a pause would look
         exactly as broken as Clear did, in the other direction. */
      room._botsPausedUntil = 0;
      let made = 0;
      for (let i = 0; i < n; i++) {
        const b = room.addBot();
        if (!b) continue;
        /* Marked by hand, so the room's own top-up leaves it alone. Asking for
           twenty and getting eight because the floor is eight would make this
           control useless for the thing it is for, which is testing. */
        if (typeof b === 'object') b._manual = b.manual = true;
        made++;
      }
      broadcastLobbyState();
      if (!made) return refuse('That room would not take any bots');
      return done('Added ' + made + ' bot(s) to ' + room.lobbyType);
    }

    /* Maintenance. Turning it ON is always allowed — the point of it is to stop
       the bleeding — but calling the game DOWN while somebody has a stake on
       the table is refused, with the number, because their worth only exists
       while their snake does. */
    case 'maintenance:on':
      ops.set({ on: true, message: args.message, minutes: args.minutes });
      io.emit('maintenance', ops.get());
      /* io.emit reaches the main namespace only; agar.io lives on /ag. */
      if (agArenas) io.of('/ag').emit('maintenance', ops.get());
      if (slArenas) io.of('/sl').emit('maintenance', ops.get());
      return done('Maintenance on. New games refused.');
    /* The lobby's cashed-out strip (server/earnings): hide or show it, saved
       across restarts and deploys. Display only, no money is touched. */
    case 'earnings:off': {
      const kept = earnings.setHidden(true);
      return done('Earnings strip hidden.' + (kept.ok ? ' It stays hidden across restarts until you press Show.'
        : ' Not saved (' + kept.why + '), so a restart shows it again.'));
    }
    case 'earnings:on': {
      const kept = earnings.setHidden(false);
      return done((earnings.shown() ? 'Earnings strip shown.' : 'Console hide cleared, but SHOW is false in server/earnings/config.js.')
        + (kept.ok ? '' : ' Not saved (' + kept.why + ').'));
    }
    case 'maintenance:off':
      ops.set({ on: false });
      io.emit('maintenance', ops.get());
      if (agArenas) io.of('/ag').emit('maintenance', ops.get());
      if (slArenas) io.of('/sl').emit('maintenance', ops.get());
      return done('Maintenance off. The game is open.');

    /* Paid agar.io's own instant door switch (PAID-AGAR-DESIGN.md 5.7): off,
       every new paid join is refunded at the door ('not-open') and the rows say
       closed, while seated players keep playing, resume and cash out. No
       restart. On only reopens rungs that AG_PAID built at boot. The close is
       saved (agPaidSwitch, security review item b: it used to live in memory
       only, so the next deploy reopened it), so it lasts until agar:paid:on. */
    case 'agar:paid:off': {
      if (!agArenas || !agArenas.paidEnabled) return refuse('Paid agar.io is not on (AG_PAID)');
      agArenas.paidOpen = false;
      const kept = agPaidSwitch.save(false);
      console.warn('[AG] owner console: paid door CLOSED' + (kept.ok ? ' (saved)' : ' (NOT saved: ' + kept.why + ')'));
      return done('Paid agar.io closed to new players. Seated players finish. ' +
        (kept.ok ? 'It stays closed across restarts and deploys until you press Open.'
          : 'The close could not be saved (' + kept.why + '), so it lasts only until the next restart; for a lasting ' +
            'close set AG_PAID=0 in .env.'));
    }
    case 'agar:paid:on': {
      if (!agArenas || !agArenas.paidEnabled) return refuse('Paid agar.io is not on (AG_PAID)');
      if (agArenas.stopping) return refuse('The server is restarting');
      agArenas.paidOpen = true;
      const kept = agPaidSwitch.save(true);
      console.warn('[AG] owner console: paid door OPEN' + (kept.ok ? '' : ' (the saved close NOT cleared: ' + kept.why + ')'));
      return done('Paid agar.io open.' + (kept.ok ? ''
        : ' The saved close could not be cleared (' + kept.why + '), so the next restart opens it closed again.'));
    }
    /* Paid Paper's instant door switch (security review item b), the same
       contract as agar's above: off, every NEW paid Paper join is refunded at the
       door ('not-open') and the paid rows say closed, while seated players keep
       playing, resume and cash out; saved, so it outlives a restart until
       paper:paid:on. On only reopens rungs that PAPER_PAID built at boot. */
    case 'paper:paid:off': {
      if (!paperArenas || !paperArenas.paidEnabled) return refuse('Paid Paper is not on (PAPER_PAID)');
      paperArenas.paidOpen = false;
      const kept = paperPaidSwitch.save(false);
      console.warn('[PAPER] owner console: paid door CLOSED' + (kept.ok ? ' (saved)' : ' (NOT saved: ' + kept.why + ')'));
      return done('Paid Paper closed to new players. Seated players finish. ' +
        (kept.ok ? 'It stays closed across restarts and deploys until you press Open.'
          : 'The close could not be saved (' + kept.why + '), so it lasts only until the next restart; for a lasting ' +
            'close set PAPER_PAID=0 in .env.'));
    }
    case 'paper:paid:on': {
      if (!paperArenas || !paperArenas.paidEnabled) return refuse('Paid Paper is not on (PAPER_PAID)');
      if (paperArenas.stopping) return refuse('The server is restarting');
      paperArenas.paidOpen = true;
      const kept = paperPaidSwitch.save(true);
      console.warn('[PAPER] owner console: paid door OPEN' + (kept.ok ? '' : ' (the saved close NOT cleared: ' + kept.why + ')'));
      return done('Paid Paper open.' + (kept.ok ? ''
        : ' The saved close could not be cleared (' + kept.why + '), so the next restart opens it closed again.'));
    }
    /* The new slither.io free room's door (SERVER-DESIGN 13 item 4, 16.2): off
       refuses new joins (the page gets a 'closed' refusal), seated players
       finish. In memory like agar's paid switch, so a restart reopens it. */
    case 'sl:door:off':
      if (!slArenas) return refuse('The new slither.io room is not open (SL_ENABLED)');
      slArenas.door(false);
      console.warn('[SL] owner console: door CLOSED');
      return done('New slither.io closed to new players until the next restart; seated players finish. For a lasting close set SL_ENABLED=0.');
    case 'sl:door:on':
      if (!slArenas) return refuse('The new slither.io room is not open (SL_ENABLED)');
      slArenas.door(true);
      console.warn('[SL] owner console: door OPEN');
      return done('New slither.io open.');
    /* Paid snake on the sl engine's instant switch (PAID-SL-DESIGN.md 10): off,
       every new paid join at /sl is refunded at the door ('not-open'), the sl
       rows say closed (listed while an account is open) and the SAME /api/live
       answer lists the old engine's paid rows open, so the next paid snake opens
       the old game; seated sl players finish and cash out. No restart. On
       reopens only rungs that SL_PAID built at boot, never while the shutdown
       settle runs. The close is saved (slPaidSwitch), so a restart or a deploy
       keeps it closed until sl:paid:on; a save that fails says so, and then
       only SL_PAID=0 in .env lasts. */
    case 'sl:paid:off': {
      if (!slPaid || !slPaid.paidEnabled) return refuse('Paid snake on the new engine is not on (SL_PAID)');
      slPaid.setPaidOpen(false);
      const kept = slPaidSwitch.save(false);
      console.warn('[SLP] owner console: paid door CLOSED' + (kept.ok ? ' (saved)' : ' (NOT saved: ' + kept.why + ')'));
      return done('Paid snake on the new engine closed to new players; paid snake opens the old game. Seated players finish. ' +
        (kept.ok ? 'It stays closed across restarts and deploys until you press Open.'
          : 'The close could not be saved (' + kept.why + '), so it lasts only until the next restart; for a lasting ' +
            'close set SL_PAID=0 in .env.'));
    }
    case 'sl:paid:on': {
      if (!slPaid || !slPaid.paidEnabled) return refuse('Paid snake on the new engine is not on (SL_PAID)');
      if (slPaid.stopping) return refuse('The server is restarting');
      const r = slPaid.setPaidOpen(true);
      if (!r.ok) return refuse('Paid snake on the new engine stays closed (' + r.why + ')');
      const kept = slPaidSwitch.save(true);
      console.warn('[SLP] owner console: paid door OPEN' + (kept.ok ? '' : ' (the saved close NOT cleared: ' + kept.why + ')'));
      return done('Paid snake on the new engine open.' + (kept.ok ? ''
        : ' The saved close could not be cleared (' + kept.why + '), so the next restart opens it closed again.'));
    }
    case 'maintenance:check': {
      /* Unsafe while any stake exists only in this process: a live paid seat,
         a Paper floor coin, or a paid entry token minted and not yet joined
         (each refunds itself within about 6 minutes; turn maintenance on and
         wait). A restart would lose all three with no record. */
      const d = ops.drainStatus(ALL_ROOMS(), entryStore.pending());
      const live = Math.round((d.paidWorth + d.floorWorth + d.pendingWorth) * 1e6) / 1e6;
      return d.safe ? done('Safe to restart: nobody has money on the table.')
                    : refuse(d.reason + ' (' + live + ' USDC in memory)');
    }

    /* Something to say to everyone who is currently in a game. */
    case 'announce': {
      const text = String(args.text || '').slice(0, 200);
      if (!text) return refuse('Nothing to say');
      io.emit('announce', { text, at: Date.now() });
      if (slArenas) io.of('/sl').emit('announce', { text, at: Date.now() });
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
app.post('/api/owner/diagnose', sigLimiter, async (req, res) => {
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
/* Each new page costs our paid RPC a signature read and up to 20 transaction reads (a read is kept
   for good once made), and the route is public, so
   (security review 2026-10-15): a per-IP limiter, a wallet must look like a Solana address before
   anything is asked of the chain, and one answer per wallet is shared for 30 s (concurrent asks
   for the same wallet share one lookup). Only successful answers are kept. */
const TX_HISTORY_TTL_MS = 30 * 1000;
const TX_HISTORY_MAX = 2000;
const txHistoryCache = new Map();   // wallet + page cursor -> { at, page } or { at, pending }
const TX_PAGE = 20;
/* A skin row (Usdc.historyRowOf: a payment whose memo names a purchase) gets the item it bought, '<game>:<skin>',
   from that purchase's row, when the row is this wallet's; the page names it ("Skin: Candy Cane"). Display only, a
   database read and no chain call; a row it cannot name stays "Skin". */
async function withSkinItems(wallet, page) {
  for (const t of (page && page.rows) || []) {
    if (!t || t.kind !== 'skin' || !t.skinRef || t.skinItem) continue;
    try {
      const row = await db.skinRow(t.skinRef);
      if (row && row.wallet === wallet && skinCatalog.ID.test(row.game) && skinCatalog.ID.test(row.skin)) t.skinItem = row.game + ':' + row.skin;
    } catch (_) { /* no database: the row stays "Skin" */ }
  }
  return page;
}
function txHistoryFor(wallet, before) {
  const now = Date.now();
  const key = wallet + ':' + (before || '');
  const hit = txHistoryCache.get(key);
  if (hit && (hit.pending || now - hit.at < TX_HISTORY_TTL_MS)) return hit.pending || Promise.resolve(hit.page);
  if (txHistoryCache.size >= TX_HISTORY_MAX) {
    for (const [k, v] of txHistoryCache) {
      if (!v.pending && now - v.at >= TX_HISTORY_TTL_MS) txHistoryCache.delete(k);
    }
    if (txHistoryCache.size >= TX_HISTORY_MAX) txHistoryCache.delete(txHistoryCache.keys().next().value);
  }
  const pending = Usdc.usdcHistory(wallet, { limit: TX_PAGE, before }).then((page) => withSkinItems(wallet, page)).then(
    (page) => { txHistoryCache.set(key, { at: Date.now(), page }); return page; },
    (e) => { txHistoryCache.delete(key); throw e; });
  txHistoryCache.set(key, { at: now, pending });
  return pending;
}
// A transaction signature: 64 bytes of base58, so 64 to 88 characters of its alphabet.
const isTxSignature = (s) => /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s);
/* The Wallet tab's "Add funds and Withdrawals": the wallet's USDC transfers whose other side is
   not the house, each with that other side's address (Usdc.usdcTransfers). Public on the chain
   like the list above, so it takes the address the same way and with the same checks. A complete
   answer is shared for 30 s; one that stopped short is not kept, so the next ask reads on. At
   most 500 wallets' answers are kept (each is 200 rows at most, Usdc.TRANSFER_ROWS_MAX). */
const TX_TRANSFERS_MAX = 500;
const txTransfersCache = new Map();  // wallet -> { at, page } or { at, pending }
function txTransfersFor(wallet) {
  const now = Date.now();
  const hit = txTransfersCache.get(wallet);
  if (hit && (hit.pending || now - hit.at < TX_HISTORY_TTL_MS)) return hit.pending || Promise.resolve(hit.page);
  if (txTransfersCache.size >= TX_TRANSFERS_MAX) {
    for (const [k, v] of txTransfersCache) {
      if (!v.pending && now - v.at >= TX_HISTORY_TTL_MS) txTransfersCache.delete(k);
    }
    if (txTransfersCache.size >= TX_TRANSFERS_MAX) txTransfersCache.delete(txTransfersCache.keys().next().value);
  }
  const pending = Usdc.usdcTransfers(wallet, { priceOn: prices.solUsdAt }).then(
    (page) => {
      if (page.complete) txTransfersCache.set(wallet, { at: Date.now(), page });
      else txTransfersCache.delete(wallet);
      return page;
    },
    (e) => { txTransfersCache.delete(wallet); throw e; });
  txTransfersCache.set(wallet, { at: now, pending });
  return pending;
}
app.get('/api/my-transfers', txHistoryLimiter, async (req, res) => {
  const wallet = strOr(req.query.wallet, '').trim();
  if (!wallet) return res.status(400).json({ error: 'No wallet' });
  if (!isWalletString(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
  try {
    const page = await txTransfersFor(wallet);
    res.json({ transfers: page.rows, complete: page.complete });
  } catch (e) {
    console.error('[MY-TRANSFERS]', e.message);
    res.status(502).json({ error: 'Could not reach the chain' });
  }
});
app.get('/api/my-transactions', txHistoryLimiter, async (req, res) => {
  const wallet = strOr(req.query.wallet, '').trim();   // a string only: ?wallet[]=a threw
  if (!wallet) return res.status(400).json({ error: 'No wallet' });
  // A key's size and alphabet before new PublicKey() decodes it (quadratic: server/b58Caps.js).
  if (!isWalletString(wallet)) return res.status(400).json({ error: 'Invalid wallet' });
  // The page cursor: the last signature the screen already shows. Absent is the newest page.
  const before = strOr(req.query.before, '').trim();
  if (before && !isTxSignature(before)) return res.status(400).json({ error: 'Invalid cursor' });
  try {
    const page = await txHistoryFor(wallet, before || undefined);
    res.json({ transactions: page.rows, next: page.next });
  } catch (e) {
    console.error('[MY-TX]', e.message);
    res.status(502).json({ error: 'Could not reach the chain' });
  }
});

/* no-store everywhere, deliberately (public/sw.js says why: a stored copy is how
   a phone shows yesterday's balance or an old staking client). One exception,
   Owen's pick (2026-10-08): agar.io's client scripts are no-cache. The browser
   may keep a copy but must ask before every use; express.static answers with
   the ETag it already sends and a 304 when nothing changed, so a repeat visit
   skips the download and can still never run a stale build. */
const revalidate = (p) => p.startsWith('/js/ag/');
app.use((req, res, next) => {
  res.setHeader('Cache-Control', revalidate(req.path) ? 'no-cache' : 'no-store');
  next();
});

/* The lobby. Declared BEFORE express.static, which would otherwise serve a
   file for '/' and win.

   /v2 is kept as an alias because it was the migration URL and is in people's
   history and in the docs; it costs one line and breaks nothing.

   The old lobby and its /legacy escape hatch were deleted 2026-08-19, after
   the redesign had held on mainnet through real entry and cash-out. The way
   back now is git, which is what it should have been once the new one was
   carrying real money. */
/* A preview link (?leaderboard=preview fills the Social board with sample
   players in that one browser; ?earnings=preview shows the owner's own
   cash-outs) is never a page a search engine should keep. */
const PREVIEW_QUERY = ['leaderboard', 'earnings'];
function noindexPreview(req, res, next) {
  if (PREVIEW_QUERY.some((k) => req.query && req.query[k] !== undefined)) res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
}
app.get('/', noindexPreview, (_req, res) => res.sendFile(path.join(__dirname, '../public/v2.html')));
app.get('/v2', noindexPreview, (_req, res) => res.sendFile(path.join(__dirname, '../public/v2.html')));
/* The owner console, without the file extension. The page itself is not a
   secret and does not need to be — it shows nothing and does nothing until an
   owner wallet signs for it, and every route behind it checks that server-side.
   Keeping the URL obscure would be the only protection it did NOT have. */
app.get('/owner', (_req, res) => res.sendFile(path.join(__dirname, '../public/owner.html')));
/* A locked game's page (shared/lockedGames.js) sends the browser to the lobby,
   by its short URL and by its file name alike: express.static below would
   otherwise hand out tanks.html or shooter.html to anybody who typed it. 302,
   like /agar, so no browser keeps the redirect once the game is unlocked. */
const gamePage = (id, file) => (_req, res) => (isLocked(id)
  ? res.redirect(302, '/')
  : res.sendFile(path.join(__dirname, '../public/' + file)));
app.get(['/tanks', '/tanks.html'], gamePage('tanks', 'tanks.html'));
app.get('/knockout', (_req, res) => res.sendFile(path.join(__dirname, '../public/knockout.html')));
app.get('/battleship', (_req, res) => res.sendFile(path.join(__dirname, '../public/battleship.html')));
app.get(['/shooter', '/shooter.html'], gamePage('omgshooter', 'shooter.html'));
app.get('/paper', (_req, res) => res.sendFile(path.join(__dirname, '../public/paper.html')));
app.get('/paper-arena', (_req, res) => res.sendFile(path.join(__dirname, '../public/paper-arena.html')));
/* The new agar.io page is only ever served by /ag (below, 503 while the game
   is closed). Without this, express.static would hand out public/ag.html at
   /ag.html even with AG off: a dead page that cannot connect. */
app.get('/ag.html', (_req, res) => res.redirect(302, '/ag'));
/* The old agar.io game's page was deleted when the lobby moved to the new one
   (agario-reference/PLAN.md, Phase 6). A bookmark or an old link to it lands on
   the new game instead of a 404. 302, not 301: a browser never caches it, so
   the address stays free to mean something else later. */
app.get(['/agar', '/agar.html'], (_req, res) => res.redirect(302, '/ag'));
/* The new slither.io client (public/sl.html) is only ever served by /sl, and
   only while SL_ENABLED is on (OFF by default: its game server is not built
   yet). Closed, /sl and every path express.static would resolve to the file
   answer a 503 "not open yet" page (server/slRoutes.js says why an exact
   /sl.html route is not enough). Must stay above express.static. */
/* ── slither.io (new): the free room on /sl (server/sl, task T11) ────────────
   OFF by default (SL_ENABLED, the same switch as the routes below); junk fails
   closed. On, it opens only when the law table passes assertShippable (or on
   the dev FIXTURE via SL_DEV_LAWS, refused in production, with an escrow key
   or a DATABASE_URL), and then /sl serves public/sl.html with the layer tail
   (server/sl/slBoot.js composePage); any refusal keeps /sl on the closed page
   and logs why. ONE free room, its own socket.io namespace /sl, at most
   C_SL_PER_IP (30) sockets per address. It holds no money: it gets no db and
   no money module, and its row is stake 0 with worth 0 snakes.
   It IS the lobby's free snake now (the Phase 6 swap, SERVER-DESIGN 16.2):
   while slFreeLive() its row is the snake Free row on /api/live, liveBoard()
   leaves out the old free rung, and that rung stops seeding bots but stays
   reachable as the fallback. sl:door:off is the rollback without a restart.
   The owner console sees it (ALL_ROOMS, sl:door:off/on), maintenance and
   announce reach /sl too. */
const slBoot = require('./sl/slBoot');
const slOpened = slBoot.openSl({
  env: process.env,
  io,
  region: REGION,
  helpers: {
    socketRL,
    ops,
    /* SERVER-DESIGN 13 item 9: slSockets throttles (C_PUSH) before calling this. */
    notifyJoin: (name, where) => notify.pushOwner(
      `${name || 'A player'} joined ${where === 'br' ? 'the Battle Royale' : 'slither.io (new) Free'} in ${REGION.toUpperCase()}`,
      { title: where === 'br' ? 'New player: Battle Royale' : 'New player: slither.io (new)', tags: 'video_game' }),
    /* The bot governor's paid-seat input, once a second (SERVER-DESIGN 11). */
    paidLoad: () => ({ paidPlayers: ops.drainStatus(ALL_ROOMS(), entryStore.pending()).paid, paid: [] }),
  },
  /* No biggest cash-out box (Owen 2026-10-16, "this was a bad idea"): no
     topCashout read, so slBoot starts none and no seat is sent {t: 'top'}. */
  topCashout: null,
  /* Full of bots from boot: the free room ticks before anybody comes, so its
     lobby card counts real snakes from the first poll (slArenas keepAwake has
     the measured cost). Paid rooms are a separate directory and stay bot-free. */
  awake: true,
});
const slArenas = slOpened.arenas;
/* The one swap predicate (SERVER-DESIGN 16.2): the new room is open, its door
   is open and its last board row was made. Read on every call, never cached,
   so sl:door:off hands the old free rung its row and its bots back at once. */
function slFreeLive() { return !!(slArenas && slArenas.isLive()); }
app.get('/sl', slBoot.slPageRoute(slOpened));
const slGate = require('./slRoutes');
slGate.slRoutes(app, {
  open: slGate.slSwitch(process.env.SL_ENABLED),
  file: path.join(__dirname, '../public/sl.html'),
});

/* Old and developer-only pages stay in the repo for local use but are not
   served by the live site (Owen, 2026-10-15): the pre-owner-console admin page
   and the art/sound tools. Production only (NODE_ENV, which dev-local refuses),
   and above express.static, which would otherwise hand them out. */
const DEV_ONLY_PAGES = ['/admin.html', '/dev-bake-tiles.html', '/dev-soundcheck.html',
  '/dev-tankart.html', '/preview_snake.html'];
if (process.env.NODE_ENV === 'production') {
  app.get(DEV_ONLY_PAGES, (_req, res) => res.status(404).sendFile(path.join(__dirname, '../public/404.html')));
}

app.use(express.static(path.join(__dirname, '../public')));
app.use('/shared', express.static(path.join(__dirname, '../shared')));

// ─── Game rooms (one per region + lobby type) ────────────────────────────────
const REGIONS = ['na', 'eu'];
const gameRooms = {};
// Only host the rooms for THIS server's region. Building every region on every
// server meant the NA box ran 6 snake rooms + 6 old agar rooms — 12 loops at 60Hz on
// a single vCPU — half of them for a region whose server is stopped and which is
// crossed out in the lobby, so nobody could reach them. That constant background
// load is what kept ~2% of ticks running late even between the periodic spikes.
// The room lookups fall back to this region, so a stale client asking for another
// region still lands somewhere valid.
/* One queue and its rooms, for the artillery duel. Free only while the mode is
   new: there is no stake to verify and nothing to pay out, so none of the money
   path is involved in it at all. */
/* null while Bowmasters is locked (shared/lockedGames.js): every reader below
   checks for that, so no queue, no bot stand-in and no timer exist for it. */
const tanksLobby = isLocked('tanks') ? null : new TanksLobby(io);
const knockoutLobby = new KnockoutLobby(io);

/* ─── Paying out a Knockout table ─────────────────────────────────────────────
   The room decides who won; this moves the money, and it is the only thing that
   does. Same split as everywhere else in the product: the winner takes the pot
   less a ten percent house cut, which stays in escrow and is swept to revenue.

   A DRAW REFUNDS, it does not split. Both sides being knocked off on the same
   reveal is a real outcome of this game, and taking a rake off a match nobody
   won would be charging two people for nothing. Each seat gets its own stake
   back rather than half a pot, because the two are only the same number while
   both seats paid the same, and that is an assumption rather than a fact.

   Paid once per room, keyed by room id, for the same reason the battle royale
   payout is: "pay the winner" is not a thing to run twice, and a reconnect, a
   double event or a retry must not become a second transfer. */
const _koPaid = new Set();
/* 10%, from the one place the duels' result cards read it too (server/duelMoney.js), so the
   split a card shows is the split paid here. */
const KO_HOUSE_CUT = require('./duelMoney').DUEL_HOUSE_CUT;

knockoutLobby.onSettled = ({ roomId, winnerId, why, pot, seats }) => {
  if (!roomId || !(pot > 0)) return;
  if (_koPaid.has(roomId)) return;
  _koPaid.add(roomId);

  const winner = seats.find(s => s.id === winnerId) || null;

  /* Nobody won it: a draw, or a winner who has no wallet to pay. Hand every
     seat its own stake back. */
  if (!winner || !winner.wallet) {
    for (const s of seats) {
      if (!(s.worth > 0) || !s.wallet) continue;
      koSend(s.wallet, s.refund, s.name, 'knockout refund (' + (why || 'no winner') + ')');
    }
    console.log('[KO] ' + roomId + ' refunded ' + pot.toFixed(2) + ' — ' + (why || 'no winner'));
    return;
  }

  const cut = pot * KO_HOUSE_CUT;
  const prize = pot - cut;
  trackEarning({
    source: 'game_rake', game: 'knockout', amountUsdc: cut,
    wallet: winner.wallet, name: winner.name, lobbyType: 'knockout', region: REGION,
  });
  sweepRake(cut, 'knockout');
  koSend(winner.wallet, prize, winner.name, 'knockout ' + roomId);
  console.log('[KO] ' + roomId + ' pot ' + pot.toFixed(2) + ' -> ' + winner.name
    + ' ' + prize.toFixed(2) + ' (cut ' + cut.toFixed(2) + ')');
};

const battleshipLobby = new BattleshipLobby(io);

/* Battleship settles exactly the way Knockout does, through the same helper.
   Two duels paying out by two different sets of rules would be two sets of
   rules to keep right, and the split is a product decision rather than a
   per-game one. */
const _bsPaid = new Set();
battleshipLobby.onSettled = ({ roomId, winnerId, why, pot, seats }) => {
  if (!roomId || !(pot > 0) || _bsPaid.has(roomId)) return;
  _bsPaid.add(roomId);
  const winner = seats.find(s => s.id === winnerId) || null;
  if (!winner || !winner.wallet) {
    for (const s of seats) {
      if (!(s.worth > 0) || !s.wallet) continue;
      koSend(s.wallet, s.refund, s.name, 'battleship refund (' + (why || 'no winner') + ')');
    }
    console.log('[BS] ' + roomId + ' refunded ' + pot.toFixed(2) + ' — ' + (why || 'no winner'));
    return;
  }
  const cut = pot * KO_HOUSE_CUT;
  const prize = pot - cut;
  trackEarning({
    source: 'game_rake', game: 'battleship', amountUsdc: cut,
    wallet: winner.wallet, name: winner.name, lobbyType: 'battleship', region: REGION,
  });
  sweepRake(cut, 'battleship');
  koSend(winner.wallet, prize, winner.name, 'battleship ' + roomId);
  console.log('[BS] ' + roomId + ' pot ' + pot.toFixed(2) + ' -> ' + winner.name
    + ' ' + prize.toFixed(2) + ' (cut ' + cut.toFixed(2) + ')');
};

battleshipLobby.onRefund = ({ wallet, name, amount, why }) => {
  if (!wallet || !(amount > 0)) return;
  console.log('[BS] refunding ' + amount.toFixed(2) + ' to ' + name + ' — ' + why);
  koSend(wallet, amount, name, 'battleship refund');
};

/* A stake handed back because a paid table never found an opponent. Same
   one-time guarantee: the lobby marks the entry refunded before calling. */
knockoutLobby.onRefund = ({ wallet, name, amount, why }) => {
  if (!wallet || !(amount > 0)) return;
  console.log('[KO] refunding ' + amount.toFixed(2) + ' to ' + name + ' — ' + why);
  koSend(wallet, amount, name, 'knockout refund');
};

/* One place that actually moves it, so a failed transfer is recorded the same
   way whoever it was going to. A payout that fails is written down rather than
   retried: a re-send is how you pay twice. */
function koSend(wallet, amount, name, note) {
  money.withdraw(wallet, amount)
    .then((sig) => {
      console.log('[KO] sent ' + amount.toFixed(6) + ' ' + money.unit + ' -> '
        + String(wallet).slice(0, 8) + '… sig ' + String(sig).slice(0, 12));
      db.recordEarnings(wallet, name || 'Player', amount, money.fiatValue(amount)).catch(() => {});
    })
    .catch((e) => {
      console.error('[KO] CRITICAL: payout failed for ' + wallet + ' — owed '
        + amount.toFixed(6) + ': ' + e.message);
      db.recordFailedPayout(wallet, amount, name || 'Player', note + ': ' + e.message, e.broadcast)
        .catch(() => {});
    });
}
/* ONE arena for the whole region, not one per player. The shooter is a
   free-for-all: everybody who presses Play lands in the same map, which is
   the entire point of it and the reason it cannot be a room per socket.

   The room starts itself when the first player arrives and stops itself when
   the last one leaves — an empty arena still ticks thirty times a second and
   still drives five bots around, for nobody. */
/* null while Awesome Tanks is locked (shared/lockedGames.js). */
const shooterRoom = isLocked('omgshooter') ? null : new ShooterRoom(io, REGION);
function endShooter(socketId) { if (shooterRoom) shooterRoom.removePlayer(socketId); }

/* ── Paper (the territory arena, docs/paper-multiplayer-design.md 6.4) ───────
   Arenas per rung for this region. Money in an arena lives in its bank and
   leaves only through these hooks: a cash-out at 90/10, a refund bounded by
   what landed on-chain, the hour sweep of floor money to the house. Every
   hook must be a function or the PaperRoom constructor throws HERE, at boot,
   rather than at the first paid cash-out (the free arena never pays one).
   The paid rungs ($0.50 and $1.00) are ON by default since 2026-10-01 (STATUS item 7: e and f
   closed). Production env lives only in the box's .env, which no deploy touches, so the default
   is what the live server runs. PAPER_PAID=0 (or false, off, no) shuts them; 1 (true, on, yes)
   or unset opens them; any other value shuts them and says so, so a typo fails closed. Tests
   and scripts/dev-local.js set PAPER_PAID explicitly. Owner's rule with paid Paper on (7f):
   nothing is pushed while /api/live shows a human in a paid room. Since security review item
   a a restart or a crash no longer loses seated Paper money (every balance is refunded 100%
   through the owed lane, as paid agar's and snake's: paidShutdownDirs below), but a push still
   ends every seated game. The instant off switch is the owner console's paper:paid:off. */
/* Paid money in flight (payouts, refunds, door claims) of paid agar, paid snake and
   paid Paper, for the shutdown settle to wait on (server/ag/agShutdown.js). */
const agShutdown = require('./ag/agShutdown');
const agInflight = agShutdown.createInflight();
/* The paid money journal (server/ag/agJournal.js, Owen Q6), shared by paid agar,
   paid snake and paid Paper (records told apart by room): every paid account's
   open and close, written synchronously to a local file, so a crash's refunds
   reach the database at the next boot and a killed process's open balances are
   flagged to Owen. Rotated here, before any account can open; replayed once the
   database is up (the boot block at the top of this file). A journal left by an
   earlier boot is replayed even with AG_PAID now off. */
const agJournal = require('./ag/agJournal').createAgJournal({
  file: process.env.AG_JOURNAL_PATH || undefined,
  bootId: BOOT_ID,
});
{
  const waiting = agJournal.rotate();
  if (waiting.length) console.warn(`[AG] JOURNAL ${waiting.length} file(s) to replay once the database is up`);
}
/* The owner's paid switches outlive a restart (review OPS-1 for sl:paid:off,
   security review item b for agar:paid:off and paper:paid:off): a close is a small
   file beside the money journal (server/data/, gitignored, kept by the deploy's
   reset), read once at boot; the matching :on removes it. A file that cannot be
   read fails CLOSED. *_PAID_SWITCH_PATH moves each one. */
const { createPaidSwitchStore } = require('./slPaid/slPaidBoot');
const agPaidSwitch = createPaidSwitchStore({
  file: process.env.AG_PAID_SWITCH_PATH || path.join(path.dirname(agJournal.file), 'ag-paid-switch.json'),
  tag: '[AG]', what: 'paid agar.io',
});
const paperPaidSwitch = createPaidSwitchStore({
  file: process.env.PAPER_PAID_SWITCH_PATH || path.join(path.dirname(agJournal.file), 'paper-paid-switch.json'),
  tag: '[PAPER]', what: 'paid Paper',
});

const { PaperArenas } = require('./paper/PaperArenas');
function paperPaidSwitchValue(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '' || v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  console.error(`[PAPER] PAPER_PAID=${JSON.stringify(String(raw).slice(0, 20))} is not a switch value; paid rungs stay OFF`);
  return false;
}
const PAPER_PAID = paperPaidSwitchValue(process.env.PAPER_PAID);
console.log(`[PAPER] paid rungs ${PAPER_PAID ? 'on' : 'OFF'}`);
/* Dev entry tokens pay with a fake withdraw, for Paper only: the global money
   module is untouched. The house side is faked too. An unbacked token's rake
   must never become a failed_payouts row that a real drainer later pays out
   of the real escrow, nor a revenue row or a PostHog event on the owner's
   real books. */
const paperDevMoney = {
  unit: money.unit,
  fiatValue: (amt) => money.fiatValue(amt),
  withdraw: async (wallet, amt) => {
    const sig = 'DEV' + crypto.randomUUID().replace(/-/g, '');
    console.log(`[PAPER] DEV withdraw ${amt} ${money.unit} -> ${wallet} sig ${sig}`);
    return sig;
  },
};
const paperPayout = require('./paperPayout').create({
  money: PAPER_DEV_TOKENS ? paperDevMoney : money,
  db,
  trackEarning: PAPER_DEV_TOKENS
    ? (e) => console.log(`[PAPER] DEV earning ${e.source} ${e.amountUsdc} (${e.lobbyType}) not recorded`)
    : trackEarning,
  sweepRake: PAPER_DEV_TOKENS
    ? (amt, label) => console.log(`[PAPER] DEV rake ${amt} (${label}) not swept`)
    : sweepRake,
  io,
  REGION,
});
/* A ledger breach or an emergency close. Each is latched once per arena, so
   this cannot flood. Same two routes the other money alerts take: the owner's
   socket if it is connected, and a push to the owner's phone. */
function paperOwnerAlert(info) {
  try {
    const s = lobbySocketsByGoogleId.get(OWNER_WALLET);
    if (s) s.emit('admin:paper_alert', info);
    notify.pushOwner(`${info.kind} in ${info.lobbyType}: ${JSON.stringify(info)}`,
      { title: 'Paper money alert', priority: 'high' });
  } catch (e) {
    console.error('[PAPER] owner alert', e.message);
  }
}
const paperArenas = new PaperArenas({
  region: REGION,
  io,
  paidEnabled: PAPER_PAID,
  /* Every paid seat's account opened and closed in the shared money journal, so a
     restart's or crash's owed rows reach the database at the next boot (security
     review item a; the settle itself is installed with paid agar's and snake's,
     paidShutdownDirs below). */
  journal: agJournal,
  hooks: {
    /* Tracked, so a shutdown waits for a Paper payout in flight like agar's and snake's. */
    onCashout: (order) => agInflight.track(paperPayout.payCashout(order)),
    onTransfer: (t) => collusion.record(t.srcWallet, t.dstWallet, t.micro / 1e6, { lobbyType: t.label }),
    onRefund: (info) => agInflight.track(paperPayout.refund(info)),
    onSweep: paperPayout.sweepFloor,
    onBreach: paperOwnerAlert,
    /* The buy-in row, written when a paid seat is first steered rather than
       when its token is spent: a seat refunded before its first input
       (join-lost, join-timeout, seat-failed, an emergency close, a cooldown)
       must not show on the player's profile as a stake they lost (review
       finding). Through recordEntry, still the one place a buy-in is written. */
    onStake: ({ wallet, worth }) => { recordEntry({ ok: true, worth, walletAddress: wallet }, 'paper'); },
  },
});
const paper = require('./paperSockets')({
  arenas: paperArenas,
  ops,
  socketRL,
  sanitizeName,
  isStake,
  /* Paper's door spends the token WITHOUT recordEntry's stake row: the row is
     written by onStake above, once the seat is steered. */
  consumePaidEntryAtStake: (token, stake) => entryStore.consumeAtStake(token, stake, 'paper'),
  /* Bound to Paper's door. paperSockets consumes directly (no stake row) for a
     refusal it refunds, and a Paper-scoped dev token must open that door too. */
  entryStore: { consumeAtStake: (token, stake) => entryStore.consumeAtStake(token, stake, 'paper') },
  payout: paperPayout,
  /* A real token's stake row: claimed before the seat, and every refund at the door goes
     through it to the owed-payout lane (STATUS item 7a). Dev tokens have no row. */
  ledger: stakeLedger,
  paidEnabled: PAPER_PAID,
});
/* The owner's paper:paid:off outlives a restart (security review item b): a close
   saved before this boot opens the paid rungs with their door shut until
   paper:paid:on (new paid joins refunded 'not-open', seated players finish). */
if (PAPER_PAID) {
  let c = { closed: true, why: 'threw' };
  try { c = paperPaidSwitch.closedAtBoot(); }
  catch (e) { console.error('[PAPER] CRITICAL paid switch read threw, the paid door starts CLOSED:', e && e.message); }
  if (c.closed) {
    paperArenas.paidOpen = false;
    console.warn(`[PAPER] paid door CLOSED at boot (${c.why}): the owner's paper:paid:off outlived the restart; ` +
      'new paid joins are refunded until paper:paid:on');
  }
}

/* ── agar.io (the free FFA copy, our own code: server/ag/) ───────────────────
   ON by default (since 2026-10-07); AG_ENABLED=0, false, off or no turns it
   off, and any other value that is not a switch says so and fails closed.
   It is the lobby's agar.io card since the lobby swap (2026-10-07): the card
   opens /ag in the lobby's agar frame, and its count and rows come from these
   rooms (/api/live lobbies via agArenas.boardRows(), liveGameCounts). It is on
   the stake ladder like Paper (Free, $0.50, $1.00; PAID-AGAR-DESIGN.md 7): the
   lobby offers a paid rung only while /api/live lists it open, so with AG_PAID
   off the card shows them struck through. The
   rooms run on their own socket.io namespace, /ag, so no other game ever sees
   them, and /ag serves public/ag.html. The old agar.io game (AgarRoom, the
   cell:* events, agar.html) is deleted; /agar sends the browser here.
   Money: the paid rungs and their door exist only behind AG_PAID (see the
   paid agar.io block below); the free rung reads no stake, token or payout.

   The rooms refuse to open unless the law table passes assertShippable and
   the sim has built every rule it names. Today's table passes both (every
   row approved by Owen 2026-10-02, every rule built), so the switch alone
   decides, production included. AG_DEV_LAWS=<file> boots a local
   server on another table (the test FIXTURE) to exercise the game; it is
   refused in production (or with an escrow key or a DATABASE_URL set), where
   the game then stays closed. Seats, watchers and connections per address
   are capped in server/ag (agRoom, agSockets). The switch and the gate live in
   server/ag/agBoot.js (tested in test/agBoot.test.js). */
/* ── Paid agar.io (PAID-AGAR-DESIGN.md, Owen's answers 2026-10-08) ───────────
   The paid rungs ($0.50, $1.00) exist only with AG_PAID on (server/ag/agBoot.js:
   ON by default since 2026-10-09, unset/1/true/on/yes on, 0/false/off/no off,
   anything else off and logged, so a typo fails closed; the instant off switch is
   the owner console's agar:paid:off). Paper's machinery, reused: the stake
   hand-off, the one-time entry token at the paid door (server/ag/agPaidDoor.js),
   the durable stake row, an integer micro-USDC bank per room (server/ag/agBank.js),
   the 90/10 cash-out through the parameterized payout below, the owed-payout
   drainer, and the liability and drain sums. agar-specific: hold-Q 3 s cash-out
   (every room), share-at-eat money on split cells, a dropped player frozen 3 min
   then cashed out 90/10 to their wallet, one paid seat per wallet, and a crash
   or restart refunds 100% of every open balance (Owen Q6). The instant off
   switch is the owner console's agar:paid:off (new joins refunded at the door,
   seated players finish); maintenance:on reaches /ag too. */
const agPayout = require('./paperPayout').create({
  money: PAPER_DEV_TOKENS ? paperDevMoney : money,
  db,
  trackEarning: PAPER_DEV_TOKENS
    ? (e) => console.log(`[AG] DEV earning ${e.source} ${e.amountUsdc} (${e.lobbyType}) not recorded`)
    : trackEarning,
  sweepRake: PAPER_DEV_TOKENS
    ? (amt, label) => console.log(`[AG] DEV rake ${amt} (${label}) not swept`)
    : sweepRake,
  io: io.of('/ag'),        // emitTo uses socket ids, which are per namespace
  REGION,
  game: 'agar',
  prefix: 'ag',
  floorSource: 'agar_floor',
  breachSource: 'agar_breach',
  tag: '[AG]',
});
/* A ledger breach, a zombie account, an emergency close, a refused share, accounts
   left open by a killed process (the journal replay). The ntfy topic is public, so
   the push carries the kind, the room and amounts only, never a wallet; the owner's
   socket gets the same. One alert per room per kind per 10 minutes, the next one
   counting the ones held back (server/ag/agAlert.js). */
const agOwnerAlert = require('./ag/agAlert').createAgOwnerAlert({
  toOwner: (safe) => {
    const s = lobbySocketsByGoogleId.get(OWNER_WALLET);
    if (s) s.emit('admin:agar_alert', safe);
  },
  push: (text) => notify.pushOwner(text, { title: 'agar.io money alert', priority: 'high' }),
});
/* agShutdown, agInflight and agJournal are built above the Paper block (paid Paper
   shares them since security review item a). */
function replayAgJournal() {
  agJournal.replay({
    writeOwedOnce: (r) => db.recordOwedOnce(r.key, r.wallet, r.micro / 1e6, r.name || 'Player', r.reason),
    /* Paid snake's floor gold left at a restart or crash (Owen 2026-10-14: the
       house keeps it as slither floor income): one sweep per source wallet on
       the idle retire's own path (slither_floor, then the rake sweep). The
       journal calls this at most once per record (its booked marker). */
    /* Paid Paper's floor coins at a restart or crash ('ppfloor:' keys, security
       review item a) go the same way on Paper's own path (paper_floor), as its
       hourly sweep sends an uncollected coin to the house. */
    bookFloor: (rec) => {
      const payout = String(rec.key).startsWith('ppfloor:') ? paperPayout : slPayout;
      rec.bySource.forEach((s, i) => payout.sweepFloor({ sweepId: rec.key + ':' + i, micro: s.micro,
        srcWallet: s.srcWallet, srcName: s.srcName, label: rec.room, pid: rec.why || 'restart' }));
    },
    /* A paid snake door's journal open with no close and no seat after it (the
       server stopped after the door claimed the stake, before the seat): its stake
       row is refunded with the token's claimKey, a conditional update that pays at
       most once (security review item d). */
    refundStake: (sig, reason, claimKey) => stakeLedger.refund(sig, reason, claimKey),
    alert: agOwnerAlert,
  }).then((s) => { if (s.owed) kickDrain(); })
    .catch((e) => console.error('[AG] JOURNAL replay', e && e.message));
}
const agMoneyHooks = {
  onCashout: (order) => agInflight.track(agPayout.payCashout(order)),
  onRefund: (info) => agInflight.track(agPayout.refund(info)),
  /* One record per (victim life, eater) bucket, in Paper's units (dollars). */
  onTransfer: (t) => collusion.record(t.srcWallet, t.dstWallet, t.micro / 1e6, { lobbyType: t.lobbyType || t.label }),
  /* Eject-feeds stay in the room's own 24 h tally (owner snapshot); never a phone push. */
  onFeed: () => {},
  onBreach: agOwnerAlert,
  /* The buy-in row, written on ag:ready (a seat refunded before it readied leaves no stake on the profile). */
  onStake: ({ wallet, worth }) => { recordEntry({ ok: true, worth, walletAddress: wallet }, 'agar'); },
  onHouse: agPayout.houseIncident,
  journal: agJournal,
};
const agPaidDoorDeps = {
  /* The 'agar' door: a token scoped to another game (a Paper dev token) does not open it. */
  consumeAtStake: (token, stake) => entryStore.consumeAtStake(token, stake, 'agar'),
  ledger: stakeLedger,
  refund: agPayout.refund,
  track: agInflight.track,
};
const agBoot = require('./ag/agBoot').openAg({
  env: process.env,
  io,
  region: REGION,
  helpers: { socketRL, sanitizeName, ops },
  money: { hooks: agMoneyHooks, door: agPaidDoorDeps },
  /* A saved agar:paid:off opens the paid door shut (security review item b). */
  paidSwitch: agPaidSwitch,
});
const agArenas = agBoot.arenas;
const AG_PAID_ON = !!agBoot.paid;

/* ── Paid snake on the sl engine (PAID-SL-DESIGN.md, Owen's answers 2026-10-12
   and 2026-10-14) ───────────────────────────────────────────────────────────────
   The $0.50 and $1 snake rungs on the new engine (server/slPaid), behind SL_PAID
   (server/slPaid/slPaidBoot.js: ON by default since the switch-on commit;
   unset/empty/1/true/on/yes on, 0/false/off/no off, anything else off and logged) and
   only while /sl itself opened (SL_ENABLED). Wired here, after the agar block,
   because it shares agar's money journal (one file, one rotation, one replay;
   records told apart by room), agInflight and the owner alert. Worth comes only
   from the token the paid door consumes ('slither' scope); a death splits the
   snake's worth over the gold it drops, an eat moves a pellet's share, a hold-Q
   cash-out pays 90/10 through slPayout below, and a restart, crash, room
   emergency or orphan refunds 100% of the current balance through the owed lane.
   The instant off switch is the owner console's sl:paid:off. */
/* Built even with SL_PAID off: an unspent 'slither' dev token is refunded through
   it when it expires (devRefund above). */
const slPayout = require('./paperPayout').create({
  money: PAPER_DEV_TOKENS ? paperDevMoney : money,
  db,
  trackEarning: PAPER_DEV_TOKENS
    ? (e) => console.log(`[SLP] DEV earning ${e.source} ${e.amountUsdc} (${e.lobbyType}) not recorded`)
    : trackEarning,
  sweepRake: PAPER_DEV_TOKENS
    ? (amt, label) => console.log(`[SLP] DEV rake ${amt} (${label}) not swept`)
    : sweepRake,
  io: null,                // the frozen client closes its socket after a cash-out: the card polls the status below
  REGION,
  game: 'slither',
  prefix: 'sl',
  floorSource: 'slither_floor',
  breachSource: 'slither_breach',
  tag: '[SLP]',
});
const slPaidBoot = require('./slPaid/slPaidBoot');
/* The cash-out card's status (GET /api/sl/cashout/:cid): pending when the order
   goes out, then sent or delayed (an owed failed_payouts row the drainer pays). */
const slCashoutStatus = slPaidBoot.createCashoutStatus();
/* The owed lane (design 7.4): an emergency or orphan refund of 100% of the
   current balance, one failed_payouts row per key (in dollars), then the
   drainer. The room already closed the journal with this row's key. A write the
   database refuses is kept and written again on the slpaid-sweep tick below
   until it lands (review T5-R3), so a mid-run close never waits for the next
   boot; that boot's replay stays the backstop, once per key. */
const slOwedLane = slPaidBoot.createOwedLane({
  write: (row) => db.recordOwedOnce(row.key, row.wallet, row.micro / 1e6, String(row.name || '').replace(/[<>"'&]/g, '') || 'Player', row.reason),
  kick: kickDrain,
  track: agInflight.track,
});
const slMoneyHooks = {
  /* The room closed the journal 'cashedout' with this order before it came
     here; the payout record below says the payout answered (sent, or failed
     with its failed_payouts row for the drainer). A process that dies first
     leaves the close without one, and the next boot flags it to Owen as
     CASHOUT-UNCONFIRMED-AT-BOOT with the wallet, net and cashoutId. */
  onCashout: (order) => {
    slCashoutStatus.set(order.cashoutId, 'pending');
    /* The name lands in accounts.name (recordEarnings), which every public board reads, so
       it goes in with no markup characters at all. cleanNick already strips them at the
       join; this is the same rule at the database's door. */
    const dbOrder = { ...order, name: String(order.name || '').replace(/[<>"'&]/g, '') };
    return agInflight.track(slPayout.payCashout(dbOrder).then((sig) => {
      slCashoutStatus.set(order.cashoutId, sig ? 'sent' : 'delayed');
      agJournal.payout(order.jid, order.cashoutId, sig ? 'sent' : 'failed', order.label);
      return sig;
    }));
  },
  onOwed: slOwedLane.onOwed,
  onFloor: slPayout.sweepFloor,
  onHouse: slPayout.houseIncident,
  onBreach: agOwnerAlert,
  /* One record per (source wallet, eater wallet) pair per minute, in dollars. */
  onTransfer: (t) => collusion.record(t.srcWallet, t.dstWallet, t.micro / 1e6, { lobbyType: t.lobbyType || t.label }),
  journal: agJournal,
};
/* The owner's sl:paid:off outlives a restart (review OPS-1): a close is a file
   beside the money journal (server/data/, gitignored, kept by the deploy's
   reset), read once here; sl:paid:on removes it. SL_PAID_SWITCH_PATH moves it. */
const slPaidSwitch = slPaidBoot.createPaidSwitchStore({
  file: process.env.SL_PAID_SWITCH_PATH || path.join(path.dirname(agJournal.file), 'sl-paid-switch.json'),
});
const slPaidOpened = slPaidBoot.openSlPaid({
  env: process.env,
  sockets: slOpened.sockets,
  laws: slArenas ? slArenas.laws : null,
  shippableOnly: !slOpened.dev,
  region: REGION,
  hooks: slMoneyHooks,
  paidSwitch: slPaidSwitch,
  door: {
    /* The 'slither' door: a token scoped to another game (a Paper or agar dev token) does not open it. */
    consumeAtStake: (token, stake) => entryStore.consumeAtStake(token, stake, 'slither'),
    ledger: stakeLedger,
    slPayout,
    journal: agJournal,
    ops,
    /* The buy-in row, written once the seat holds the money (the old snake's label). */
    recordEntry: (entry, label) => recordEntry(entry, label),
    alert: agOwnerAlert,
    track: agInflight.track,
  },
});
/* The paid directory, or null when /sl is not open (no sl rows on /api/live, the
   old engine's paid rows stay open: critic C-4). With SL_PAID off it exists with
   no rungs, so a paid /sl page is refunded 'not-open' and never seated free. */
const slPaid = slPaidOpened.arenas;
/* ── The nightly battle royale on the sl engine (server/slBr; Owen 2026-10-15) ──
   The event plays like the free /sl room (the same snakes, bots, food, client
   and Customize skin) with its own rules on top: the wandering circle, the
   joining window, spectate, the podium and the $20 prize. One room, built
   beside the free one and sharing its bot governor (one core, one budget).

   br:engine:old (owner console) sends the event back to the old engine at once
   and is SAVED like sl:paid:off, so a restart or a deploy keeps it there until
   br:engine:sl; a switch file that cannot be read keeps the old engine (the
   safe side). activeBr() is the one place that answers "which room is the
   event": the schedule, the prize, the owner buttons, /api/live and the console
   all read it. */
const { SlBrArena } = require('./slBr/slBrArena');
const brEngineSwitch = slPaidBoot.createPaidSwitchStore({
  file: process.env.BR_ENGINE_SWITCH_PATH || path.join(path.dirname(agJournal.file), 'br-engine-old.json'),
  tag: '[BR]', what: 'the battle royale on the new engine',
});
let brOnNew = !brEngineSwitch.closedAtBoot().closed;
/* The Clips tab (server/clips.js): player clips that play from X, YouTube or TikTok, approved by the owner before
   they show. A small file beside the money journal, like the podium below; CLIPS_PATH moves it. Nothing here touches
   money. The player's name is the server's (their profile), never one the page sends. */
const clipsMod = require('./clips');
const clipStore = clipsMod.createClipStore({
  file: process.env.CLIPS_PATH || path.join(path.dirname(agJournal.file), 'clips.json'),
});
clipsMod.mountClipRoutes(app, {
  store: clipStore,
  isOwner: (w) => OWNER_WALLETS.has(w),
  walletForAction: (b) => ownerAuth.walletForAction(b),
  nameOf: async (w) => { const p = await db.getMyProfile(w); return (p && p.name) || ''; },
  limiter: sigLimiter,
  readLimiter: socialLimiter,
  audit: ownerAuth.audit,
});
/* The last finished match's podium, winner's name and prize outlive a restart
   (Owen 2026-10-16: the Events tab shows them all day while waiting, and every
   deploy emptied it). For showing only: no wallet or match id is kept, so
   payBattleRoyaleWinner never sees a restored match. BR_PODIUM_PATH moves it. */
const { createLastPodiumStore } = require('./slBr/brLastPodium');
const brLastPodium = createLastPodiumStore({
  file: process.env.BR_PODIUM_PATH || path.join(path.dirname(agJournal.file), 'br-last-podium.json'),
});
const slBr = slArenas ? new SlBrArena(slArenas.laws, {
  region: REGION,
  shippableOnly: slArenas.shippableOnly,
  governor: slArenas.governor,
  isOwner: (w) => OWNER_WALLETS.has(w),
  /* Paid once per match id by payBattleRoyaleWinner (its _brPaid latch); the
     10 s event timer below is the backstop. The winner's wallet is the one
     their socket proved at the join (slSockets setBr identify), never claimed. */
  onDecided: (m) => { payBattleRoyaleWinner(m).catch(e => console.error('[BR]', e.message)); },
  /* The free directory's "a paid seat is occupied" sample: this one runs no
     governor timer, and its catch-up steps yield to busy paid rooms the same way. */
  paidBusy: () => !!slArenas.paidBusyNow,
  lastStore: brLastPodium,
}) : null;
/* Filled from boot like the old room, so 8:05 never starts in an empty arena. */
if (slBr && brOnNew) slBr.startRoom();
if (slBr && slOpened.sockets) {
  slOpened.sockets.setBr({
    arenas: slBr,
    /* The same one-time proofs the main namespace accepts (socketIdentity):
       the widget's silent play:identify signature by the player's own wallet. */
    identify: (p) => (p && p.action === 'play:identify'
      ? ownerAuth.walletForAction(p) : nameProof.verifyIdentityProof(p)),
  });
}
function brOnSl() { return !!(slBr && brOnNew); }
function activeBr() {
  if (brOnSl()) return slBr.match;
  return (gameRooms[REGION] && gameRooms[REGION].br) || null;
}
/* The free room's bot governor also sees the paid rooms' and the event's tick cost (D2-m9). */
if (slArenas && (slPaid || slBr)) {
  slArenas.setExtraLoad(() => Math.max(slPaid ? slPaid.maxSliceMs() : 0, slBr ? slBr.maxSliceMs() : 0));
}
/* The cash-out card's status poll. The id is the order's uuid: a cid that is
   not a lowercase uuid is a 404 before the map is read, and so is an unknown one. */
app.get('/api/sl/cashout/:cid', (req, res) => {
  const cid = String(req.params.cid || '');
  const state = slPaidBoot.isCashoutId(cid) ? slCashoutStatus.get(cid) : null;
  if (!state) return res.status(404).json({ error: 'Not found' });
  res.json({ state });
});

/* Shutdown settle (design 5.9, Owen Q6; server/ag/agShutdown.js): a planned
   restart (pm2 sends SIGINT, then kills after its 1.6 s timeout) must not erase
   seated paid money, so every open paid agar, paid snake AND paid Paper balance
   (Paper since security review item a: before it, every restart or crash lost
   every seated Paper balance) is withdrawn from its room and written as an owed
   REFUND row (100%, no rake: a restart is our fault, one row per key,
   db.recordOwedOnce) for the drainer to pay after the restart, each also
   journaled and logged as one [AG] SHUTDOWN-OWED line. The handler never ends
   the process while the leaderboard also listens (production): pm2's kill
   timeout does, exactly as before, so old snake money in flight keeps its whole
   window. ONE handler for every game (PAID-SL-DESIGN.md 7.1): each directory
   settles in its own try, so a throw in one never keeps the others' rows from the
   journal, and the one wait covers the money of all of them in flight
   (agInflight). Installed while any paid directory exists. */
const paidShutdownDirs = [AG_PAID_ON ? agArenas : null, slPaid, PAPER_PAID ? paperArenas : null];
if (paidShutdownDirs.some(Boolean)) {
  const paidAll = slPaidBoot.composePaidShutdown(paidShutdownDirs);
  agShutdown.installAgShutdown({
    arenas: paidAll,
    writeRow: (r) => db.recordOwedOnce(r.key, r.wallet, r.micro / 1e6, r.name || 'Player', r.reason),
    inflight: agInflight,
  });
  /* A hard crash leaves no time to write: every open balance is closed into the
     money journal (synchronous) and logged as one [AG] CRASH-OWED line before
     Node's own crash handler runs; the next boot writes the owed rows (Owen Q6). */
  agShutdown.installAgCrashLog({ arenas: paidAll });
}
/* Closed (switched off, or the law gate refused): the lobby card still opens
   this address in its full-screen frame, so the answer is a page with a way
   back (game:done, the message every game page sends), not bare text that
   would leave the player stuck in the frame. */
const AG_CLOSED_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1"><title>agar.io - DuelSeries</title></head>'
  + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
  + 'background:#100e0b;color:#f5f1e8;font:16px Arial,sans-serif;text-align:center">'
  + '<div><p>agar.io is not open right now.</p>'
  + '<button id="back" type="button" style="font:600 16px Arial,sans-serif;padding:10px 22px;border:0;'
  + 'border-radius:8px;background:#f0a830;color:#100e0b;cursor:pointer">Back to the lobby</button></div>'
  + '<script>document.getElementById("back").onclick=function(){'
  + 'if(window.parent&&window.parent!==window){window.parent.postMessage("game:done","*")}'
  + 'else{location.href="/"}};</script></body></html>';
app.get('/ag', (_req, res) => {
  if (!agArenas) return res.status(503).type('html').send(AG_CLOSED_PAGE);
  res.sendFile(path.join(__dirname, '../public/ag.html'));
});

for (const rgn of [REGION]) {
  gameRooms[rgn] = {
    free:   new GameRoom(io, `${rgn}_free`),
    /* No dime room: the $0.10 tier was retired with the ten cent rung (BACKLOG 2.1). money.js no
       longer prices it, so nothing can be staked or quoted for it, and a stale PLAY that names it
       is refused at the door (isRetiredBuyIn). */
    dollar: new GameRoom(io, `${rgn}_dollar`),
    /* The nightly event. Its own room and its own lobby type, deliberately NOT
       on the buy-in ladder: entry is free and the prize comes from the house,
       so there is no stake here to get wrong. */
    br:     new BattleRoyaleRoom(io, `${rgn}_br`),
  };
  /* THE SNAKE FIXED TIERS ARE A FALLBACK, NOT A DESTINATION.

     They pre-date the ladder. liveBoard lists rungs only, index.html is gone,
     and the play path sends every snake player to a rung — so the only way into
     one of these now is getRoomForType failing to recognise a name. They stay
     for exactly that reason and are still perfectly playable if somebody lands
     in one.

     What they stop doing is drawing a crowd. `na_free` was holding a third of
     the game's whole bot budget and simulating it on one core for a room the
     lobby does not list, which is both the wasted CPU and the reason the rooms
     people ARE in looked quieter than the target. The battle royale room is
     deliberately not marked: it is free, it is on the lobby, and it needs a
     waiting room that looks alive. */
  for (const t of ['free', 'dollar']) gameRooms[rgn][t].fallbackOnly = true;
  /* While the event runs on the sl engine the old room is only the fallback:
     it stops drawing bots (read on every call, so br:engine:old gives them back). */
  Object.defineProperty(gameRooms[rgn].br, 'fallbackOnly', { get: () => brOnSl(), configurable: true, enumerable: true });
  /* THE WINNER IS CASHED OUT WHERE THEY STAND, five seconds after the match is
     decided. The room owns the timing; it does not own the money, and this is
     the seam between the two.

     Everything about the payout stays where it already was: doCashout reads
     worth off the SERVER's snake, takes the house cut here, and sends the
     player's share to the wallet the server has for them. Nothing about the
     amount comes from the winning client, and the room is only saying WHO and
     WHEN — the same two facts it already had to know to seat the podium.

     The $20 prize is a separate payment on its own one-time-per-match latch
     (payBattleRoyaleWinner / _brPaid) and is untouched by this. */
  gameRooms[rgn].br.onWinnerCashout = (winner, matchId) => {
    if (!winner || !winner.id) return;
    const room = gameRooms[rgn].br;
    const entry = room.players.get(winner.id);
    const sock = entry && entry.socket;
    if (!sock || typeof sock._doCashout !== 'function') {
      // A winner who has already left. The prize still pays: it goes to the
      // wallet recorded on the room, not to whoever happens to be connected.
      console.log(`[BR] ${matchId} winner ${winner.name} is no longer connected — nothing to cash out`);
      return;
    }
    /* THE SAME ROOM, STILL. doCashout reads socket._room fresh, so if this
       player has since walked into another lobby, calling it here would cash
       them out of THAT room using its worth — money moved on the strength of
       a battle royale they are no longer in. Five seconds is plenty of time to
       press Lobby and join something else. */
    if (sock._room !== room) {
      console.log(`[BR] ${matchId} winner ${winner.name} has left the arena — not cashing out`);
      return;
    }
    sock._doCashout()
      .then(() => console.log(`[BR] ${matchId} cashed out ${winner.name}`))
      .catch(e => console.error(`[BR] winner cash-out failed for ${matchId}:`, e.message));
  };

  Object.values(gameRooms[rgn]).forEach(r => r.start());
  if (tanksLobby) tanksLobby.start();
  knockoutLobby.start();
  battleshipLobby.start();
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
function liveBoard(opts = {}) {
  /* The ladder only. The fixed tier rooms still exist and still serve
     index.html, but they are not on this board: listing both would show a $1
     room twice under two different names, and would offer the old fixed tiers,
     which are not rungs anyone can pick here.

     Every rung is listed whether or not a room exists for it yet, because a
     rung with no room is precisely what a player needs to be able to open. A
     board showing only rooms somebody already made is the cold start this
     redesign exists to avoid. */
  const live = new Map(ladder.list()
    .filter(l => l.game === 'snake')
    .map(l => [l.stake, l]));
  /* The old free rung leaves the board while the new slither.io room has a
     row in the SAME /api/live answer (opts.skipFree), so the lobby never lists
     two Free snake rooms and never lists none. */
  /* opts.slRungs: the paid stakes whose sl row (paid snake on the new engine,
     server/slPaid) is OPEN in the SAME /api/live answer. Each paid stake then
     has exactly one open snake row (PAID-SL-DESIGN.md 2, critic C-3): the old
     row of such a stake is left out while its room is empty, and listed closed
     while it still has players (rule 4b never goes blind). With the sl row
     closed or absent the old rows are exactly as before. */
  const slOpen = (rung) => (opts.slRungs || []).some(s => Math.abs(s - rung) <= 1e-9);
  const out = [];
  for (const rung of ALL_STAKES) {
    if (opts.skipFree && rung === 0) continue;
    const hit = live.get(rung);
    const handed = rung > 0 && slOpen(rung);
    if (handed && !(hit && hit.players > 0)) continue;
    out.push({
      id: `snake:${REGION}:s${rung}`,
      game: 'snake', region: REGION,
      stake: rung,
      players: hit ? hit.players : 0,
      bots: hit ? (hit.bots || 0) : 0,
      /* Null, not a number. Persistent rooms have no seat limit: the world
         grows with the crowd rather than filling up, so there is nothing to
         be "7 of" and the prototype's /30 was invented. */
      capacity: null,
      state: handed ? 'closed' : 'open',
    });
  }
  // Busiest first: players converge on rooms that already have people, and that
  // convergence is what stops the player base fragmenting across empty rooms.
  return out.sort((a, b) => b.players - a.players);
}
/* The free rooms that are NOT on the stake ladder: the tank arena and
   Bowmasters. The lobby pins a row for each of them and had nothing to put in
   the count, so both read "0 playing" however busy they were.

   Kept out of `lobbies` on purpose. The lobby builds each game's rung buttons
   from that list; a row carrying no stake would put a blank rung on the
   control. agar.io is not here any more: its rooms are rungs now (Free, $0.50,
   $1.00, PAID-AGAR-DESIGN.md 5.7 and 7), so its rows are in `lobbies` like
   Paper's, and listing it here too would count its bots twice on the card
   (withBoardBots adds the bots of lobbies and extras alike). */
function liveExtras() {
  const out = [];
  if (typeof shooterRoom !== 'undefined' && shooterRoom) {
    /* WHAT YOU WILL FIND, not what is there with nobody looking.

       An empty shooter arena deletes its bots and stops ticking — a room that
       drives five tanks around for nobody is CPU spent on an empty room — so
       the lobby asked an idle arena how busy it was and was correctly told
       nothing. Owen: "it says zero playing but there's bots in there." Both
       true, a second apart.

       So an idle arena reports the floor it fills to the moment somebody
       arrives. That is not a guess or a decoration: join it and those tanks
       are there. A busy one keeps reporting its real count. */
    const shBots = shooterRoom.playerCount > 0
      ? (shooterRoom.botCount || 0)
      : SHOOTER.BOT_FLOOR;
    out.push({ id: 'omgshooter:free', game: 'omgshooter', region: REGION,
      players: shooterRoom.playerCount || 0, bots: shBots });
  }
  if (typeof tanksLobby !== 'undefined' && tanksLobby) {
    /* Bowmasters is a queue that makes rooms, so its population is whoever is
       waiting plus whoever is already in a match. A bot stand-in (id bot_...)
       goes under bots rather than players: the row's total is the same, and the
       game card, which adds the rows' bots to its human count, then agrees. */
    let humans = 0, bots = 0;
    const tally = id => { if (String(id).startsWith('bot_')) bots++; else humans++; };
    try {
      for (const q of (tanksLobby.queue || [])) tally(q && q.socket ? q.socket.id : '');
      for (const r of tanksLobby.rooms.values()) if (r.players) for (const id of r.players.keys()) tally(id);
    } catch (_) {}
    out.push({ id: 'tanks:free', game: 'tanks', region: REGION, players: humans, bots });
  }
  if (typeof knockoutLobby !== 'undefined' && knockoutLobby) {
    /* Counting only the HUMANS on a disc. A bot stand-in sits in a room's
       players map like anybody else, so counting the map would have an empty
       game reporting two people playing it. */
    let inGame = 0;
    try {
      for (const r of knockoutLobby.rooms.values()) {
        for (const id of r.players.keys()) if (!String(id).startsWith('bot_')) inGame++;
      }
    } catch (_) {}
    out.push({ id: 'knockout:free', game: 'knockout', region: REGION,
      players: (knockoutLobby.queue ? knockoutLobby.queue.length : 0) + inGame, bots: 0 });
  }
  if (typeof battleshipLobby !== 'undefined' && battleshipLobby) {
    let inGame = 0;
    try {
      for (const r of battleshipLobby.rooms.values()) {
        for (const id of r.players.keys()) if (!String(id).startsWith('bot_')) inGame++;
      }
    } catch (_) {}
    out.push({ id: 'battleship:free', game: 'battleship', region: REGION,
      players: (battleshipLobby.queue ? battleshipLobby.queue.length : 0) + inGame, bots: 0 });
  }
  return out;
}

/* WHAT THE NIGHTLY EVENT IS ACTUALLY DOING.

   The Events tab used to run on a wall clock of its own: START=20, END=21 in
   the page, and it called the event "Live now" between eight and nine whether
   or not a match existed. It had no way to say "in progress" because it had no
   idea, and its Watch button appeared on the hour rather than on a match.

   The schedule is sent too, rather than duplicated in the page. The server
   already owns BR_AUTOSTART_HOUR/MIN and starts the thing; a second copy in the
   client is a copy that can disagree, and the failure is silent — a countdown
   that is simply an hour out with nothing to say which hour was right.

   `joinable` is the same question the door answers (acceptingPlayers), so the
   lobby and the server cannot disagree about whether you may come in. It is a
   courtesy for the UI: the rule is enforced on join, where it already is. */
function liveBattleRoyale() {
  const room = activeBr();
  if (!room) return null;
  const st = room.publicState();
  const { hour, minute, second } = easternNow();
  return {
    /* Which engine runs it: 'sl' opens /sl (the lobby's play.js), 'old' /game.html. */
    engine: brOnSl() ? 'sl' : 'old',
    state: st.state,
    alive: st.alive,
    players: st.players,
    /* People, not bodies. The lobby fills with bots between matches, so
       `players` reported "20 waiting" for a room nobody was in. */
    humans: st.humans,
    ring: st.ring,
    phase: st.phase,
    countdownMs: st.countdownMs,
    winner: st.winner,
    podium: st.podium,
    /* The page's between-lives poll (public/js/slx/slxBr.js) shows these. */
    prize: st.prize,
    soloRun: !!st.soloRun,
    /* How many the match started with ("8 of 12 left"); 0 from the old engine. */
    startedCount: st.startedCount || 0,
    joinable: room.acceptingPlayers(),
    /* The wall clock, from the box that runs the schedule. Eastern hour and
       minute rather than a UTC offset, for the daylight-saving reason written
       at BR_AUTOSTART_HOUR. */
    startHour: BR_AUTOSTART_HOUR,
    startMin: BR_AUTOSTART_MIN,
    etHour: hour,
    etMin: minute,
    /* The Events countdown re-anchors on every 3 s poll; without the second it
       restarted from :00 each time and never counted down. */
    etSec: second,
  };
}

/* Humans in every room of each game, for the count on each lobby card. The
   /api/live handler adds the board rows' bots (withBoardBots) so the card and
   the rows agree. Every snake room counts: the fixed tiers, the nightly event and every ladder
   rung. See server/liveCounts.js for where each kind of room keeps its humans. */
function liveGameCounts() {
  const snakeRooms = Object.values(gameRooms[REGION] || {});
  for (const e of ladder.rooms.values()) if (e.game === 'snake') snakeRooms.push(e.room);
  const counts = liveCounts({
    snakeRooms,
    agar: agArenas,                 // every agar.io room (null while the game is closed)
    /* the new slither.io free room and the event's room on the same engine (null while SL_ENABLED is off) */
    sl: slArenas ? { humanTotal: () => slArenas.humanTotal() + (slBr ? slBr.humanTotal() : 0) } : null,
    slPaid,                         // paid snake on the sl engine: its open accounts (null while not built)
    shooter: typeof shooterRoom !== 'undefined' ? shooterRoom : null,
    tanks: typeof tanksLobby !== 'undefined' ? tanksLobby : null,
    knockout: typeof knockoutLobby !== 'undefined' ? knockoutLobby : null,
    battleship: typeof battleshipLobby !== 'undefined' ? battleshipLobby : null,
    paper: paperArenas,
  });
  /* A locked game has no room to count, and a 0 for it would still put it on
     the board's books, so it is not listed at all. */
  for (const id of LOCKED_GAMES) delete counts[id];
  return counts;
}

app.get('/api/live', (_req, res) => {
  try {
    /* The ladder ships with the board so the buy-in control offers exactly the
       rungs the server will accept. A client with its own copy is a client
       that can drift out of step and offer an amount that gets refused. */
    /* agar.io's rows, one per rung (PAID-AGAR-DESIGN.md 5.7): the free rung
       'ag:<region>:s0' (humans who pressed Play, and the bots), which the lobby
       pins like Paper's, and the paid rungs only while AG_PAID built them, with
       players = every open account (away ones too, so rule 4b sees parked
       money), parked, no bots, and state 'closed' under the owner's off switch.
       No agar row at all while the game is closed, so its card reads 0.
       Read in its own try (review fix): an agar fault must not blank snake's
       and Paper's rows too. The answer then says `unknown: ['agar']`, and the
       whole-board fault below says `unknown: ['all']`, so a pre-push check
       (deploy rule 4b, never push over a seated paid player) reads a missing
       row as "cannot tell", never as "nobody there". */
    let agRows = [];
    const unknown = [];
    if (agArenas) {
      try {
        agRows = agArenas.boardRows();
      } catch (e) {
        console.error('[LIVE] agar rows', e.message);
        unknown.push('agar');
      }
    }
    /* The new slither.io free room's row (server/sl), in its own try like
       agar's. Made BEFORE liveBoard so the old free rung is left out only when
       this very answer carries the new row. */
    let slRows = [];
    if (slArenas) {
      try {
        slRows = slArenas.boardRows();
      } catch (e) {
        console.error('[LIVE] sl rows', e.message);
        unknown.push('sl');
      }
    }
    /* Paid snake on the sl engine (server/slPaid, only while openSlPaid built
       it): one row per rung, players = every open account (gliding and parked
       ones too, rule 4b), state 'closed' under sl:paid:off or while the shutdown
       settles and then listed only while an account is open. Read in its own
       try BEFORE liveBoard: a fault says unknown: ['slpaid'] and lists no sl row,
       so the old rows stay open. Each paid stake whose sl row is open in THIS
       answer is handed to it (slRungs), so every paid stake has exactly one open
       snake row in every state (PAID-SL-DESIGN.md 2, critic C-3). */
    let slPaidRows = [];
    if (slPaid) {
      try {
        const rows = slPaid.boardRows();
        if (!Array.isArray(rows)) throw new Error('boardRows is not a list');
        slPaidRows = rows;
        /* A room it could not count is still listed, counted by its seats,
           and the answer says it cannot tell (rule 4b). */
        if (rows.some(r => r && r.unknown)) unknown.push('slpaid');
      } catch (e) {
        console.error('[LIVE] sl paid rows', e.message);
        unknown.push('slpaid');
      }
    }
    const slRungs = slPaidRows.filter(r => r && r.state === 'open').map(r => r.stake);
    const lobbies = liveBoard({ skipFree: slRows.length > 0, slRungs })
      .concat(slRows, slPaidRows, paperArenas.boardRows(), agRows);
    const extras = liveExtras();
    /* Card counts: every human of the game plus the bots in its rows, from these
       same rows, so a card never reads 0 above a row saying 20 playing. */
    const out = { lobbies, stakes: ALL_STAKES, extras,
                  br: liveBattleRoyale(), counts: withBoardBots(liveGameCounts(), lobbies.concat(extras)) };
    if (unknown.length) out.unknown = unknown;
    res.json(out);
  } catch (e) {
    console.error('[LIVE]', e.message);
    res.json({ lobbies: [], stakes: ALL_STAKES, extras: [], br: null, counts: null, unknown: ['all'] });
  }
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
const BR_PRIZE_USDC = C.BR_PRIZE_USDC;
const BR_AUTOSTART_HOUR = C.BR_AUTOSTART_HOUR, BR_AUTOSTART_MIN = C.BR_AUTOSTART_MIN;  // 8:05pm Eastern
let _brFmt = null;
try {
  _brFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    hour12: false, hour: '2-digit', minute: '2-digit', year: 'numeric',
    month: '2-digit', day: '2-digit' });
} catch (_) { _brFmt = null; }
function easternNow() {
  const d = new Date();
  /* Seconds are the same in every whole-minute zone, so they come from the same
     Date rather than the formatter (one Date, so a minute boundary cannot fall
     between the minute and the second). */
  if (!_brFmt) return { hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(), day: d.toDateString() };
  const o = {};
  _brFmt.formatToParts(d).forEach(p => { if (p.type !== 'literal') o[p.type] = p.value; });
  const hour = Number(o.hour) === 24 ? 0 : Number(o.hour);   // some engines say 24 at midnight
  return { hour, minute: Number(o.minute), second: d.getSeconds(), day: o.year + '-' + o.month + '-' + o.day };
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
  /* Settled from here on, whatever happens below: the event timer's backstop
     reads a winner until the next match starts, and a solo run or a winner
     with no wallet must be logged and pushed once, not every ten seconds. */
  _brPaid.add(matchId);
  /* Outlasting nobody is not winning. A solo run exists so the mode can be
     tested at all, and paying $20 out of escrow for being alone in a room is
     escrow paying somebody to test the game. */
  if (room.soloRun) {
    console.log(`[BR] ${matchId} was a solo test run — no prize paid`);
    return;
  }
  /* A real match (two or more seats) whose players proved fewer than two
     different wallets (the new engine's match, server/slBr/brMatch.js). One
     person in two tabs must not farm the prize, and a real player whose
     wallet could not sign is not paid automatically either: Owen decides. */
  if (room.prizeHeld) {
    console.warn(`[BR] ${matchId} won by ${w.name}, ${room.startedWith} players but ${room.startedPeople} proven wallet(s): prize held`);
    try {
      notify.pushOwner(`${w.name} won ${matchId}: ${room.startedWith} players, only ${room.startedPeople} proven wallet(s). The ${BR_PRIZE_USDC} USDC prize was not paid. Settle it by hand if it was a real match.`,
        { title: 'Battle Royale prize held', priority: 'high' });
    } catch (_) {}
    return;
  }
  /* w.wallet is the wallet the winner's socket PROVED (a paid token's payer, or a wallet
     signature checked once per socket), never the walletAddress a client claims in PLAY
     (security review, finder-4: the prize went to whatever wallet the client named). A winner
     with no proven wallet is not paid automatically: Owen is told, to settle it by hand. */
  if (!w.wallet) {
    console.warn(`[BR] ${matchId} won by ${w.name} but they have no proven wallet — nothing paid (settle by hand)`);
    try {
      notify.pushOwner(`${w.name} won ${matchId} with no proven wallet: the ${BR_PRIZE_USDC} USDC prize was not paid. Settle it by hand.`,
        { title: 'Battle Royale prize unpaid', priority: 'high' });
    } catch (_) {}
    return;
  }
  try {
    /* payRent: the Battle Royale is free to enter, so its winner may never
       have held USDC, and this house-funded prize (one a night, won, not
       farmable) may open their account. Every other payout refuses to
       (Usdc.js, review finding). */
    const sig = await money.withdraw(w.wallet, BR_PRIZE_USDC, { payRent: true });
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
  const room = activeBr();
  if (!room) return;

  /* Not only while 'over': that lasts five seconds and this runs every ten, so
     a winner decided between two runs was never paid (found moving the event
     to the sl engine, 2026-10-15). The winner stays set until the next start
     or a stop, and _brPaid keys it to the match, so this pays once. Both
     engines' rooms, not just the active one: an engine switch in the seconds
     after a decision must not strand that winner's prize. */
  for (const r of [gameRooms[REGION] && gameRooms[REGION].br, slBr && slBr.match]) {
    if (r && r.winner && r.matchId && !_brPaid.has(r.matchId)) {
      payBattleRoyaleWinner(r).catch(e => console.error('[BR]', e.message));
    }
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
  makeRoom: (game, rgn, stake) => {
    const r = new GameRoom(io, `${rgn}_s${String(stake).replace('.', '_')}`);
    /* What it costs to sit down, on the room itself. Everything that has to
       know whether this room is free asks the room, rather than trying to
       read a price out of its name. */
    r.stake = Number(stake);
    /* The old free rung drains while the new slither.io room is the lobby's
       Free (SERVER-DESIGN 16.2): no new bots, nobody thrown out, still
       reachable from a stale tab. A getter, so the event takes the whole bot
       budget (Owen Q21) and sl:door:off brings these bots back without a
       restart. */
    if (game === 'snake' && r.stake === 0) {
      Object.defineProperty(r, 'fallbackOnly', { get: slFreeLive, configurable: true, enumerable: true });
    }
    return r;
  },
});
/* The free rung is opened at boot rather than on the first join.

   Ladder rooms are made on demand, and the free one is already exempt from
   the sweeper — but a room that does not exist yet cannot be filled with
   bots and cannot report a count, so the lobby board showed the free table
   as empty until somebody walked into it. That is the cold start the board
   exists to avoid, and it was showing 0 while twenty snakes were ready to
   play. Opening it here means it is populated before anyone looks. */
ladder.get('snake', REGION, 0);

// Withdrawing rooms nobody is in is scheduled further down, through
// everyStaggered, along with every other periodic job.

/* Own keys only: a client-sent 'constructor' used to resolve to Object (or to no room at all,
   for a region) instead of the free room. Every real region and lobby type resolves as before.
   The snake lookups below use it too: there, 'constructor' as a lobby type resolved to the
   Object function as a ROOM, and '__proto__' as a region to a room that does not exist, and
   either one crashed the process at the first room method called on it. */
const ownKey = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/* A snake join that names a buy-in the ladder does not offer (BACKLOG 2.1): a stake that is
   not a rung (the retired $0.10 one, or any other number), or the retired 'dime' tier. Either
   used to fall through to getRoomForType and seat the player FREE in the off-board free room:
   money-safe, since no token exists for an off-ladder stake (entryStore mints rungs only) and
   the dime has no price, but a player who paid before a deploy sat alone at worth 0 and was
   never told. Refused instead, and told. Their stake was never spent: a pending stake row from
   before the restart is refunded once by the boot sweep (stakeLedger), so a refusal here moves
   no money. stake is a number or a string by here (PLAY pins it; spectate:join is checked the
   same way); anything else names no stake. */
const RETIRED_TIERS = new Set(['dime']);
const RETIRED_BUYIN = 'That buy-in is no longer offered. Go back to the lobby and pick one.';
function isRetiredBuyIn({ lobbyType, stake }) {
  if ((typeof stake === 'number' || typeof stake === 'string') && !isStake(stake)) return true;
  return typeof lobbyType === 'string' && RETIRED_TIERS.has(lobbyType);
}

/* Which room a join lands in. A stake wins when present, because only the
   ladder client sends one; everything else is the original tier lookup,
   untouched. */
function getRoomForJoin({ lobbyType, stake, region }) {
  const rgn = ownKey(gameRooms, region) ? region : REGION;
  if (stake !== undefined && stake !== null && isStake(stake)) {
    // The ladder's own number: a room is never built from a request's 0.10499.
    return ladder.get('snake', rgn, rungOf(stake));
  }
  return getRoomForType(lobbyType, rgn);
}

/* Throttle state for the warning below. Two numbers, deliberately: the thing
   being logged is client-supplied, so anything that grew per distinct value
   would be a memory leak with a stranger holding the pen. */
let _unknownLobbyAt = 0, _unknownLobbySkipped = 0;
const UNKNOWN_LOBBY_EVERY_MS = 30000;

function getRoomForType(lobbyType, region) {
  const rgn = ownKey(gameRooms, region) ? region : REGION;
  const hit = ownKey(gameRooms[rgn], lobbyType) ? gameRooms[rgn][lobbyType] : null;
  /* THE CATCH-ALL IS LOUD NOW. Any lobbyType this server does not recognise
     lands in the snake fixed tier, and that tier is off the lobby board — so a
     client sending a stale or unknown name ends up alone in a room nothing
     else routes to, and until now nothing anywhere said so.

     The behaviour is deliberately unchanged: this fallback is what keeps a bad
     join from failing outright. The one tier that was retired (dime, BACKLOG
     2.1) never gets here: isRetiredBuyIn refuses it at the door first. It just
     stops being invisible.

     THE VALUE COMES FROM THE CLIENT, so the line is written defensively:
     only a string is quoted (anything else is named by its type, because
     String() on a client-built object can throw), slice() caps the length, and
     JSON.stringify escapes the newlines that would otherwise let somebody
     forge a log entry. Rate-limited because the alternative is a stranger
     choosing how much disk this box writes — one core, and pm2 keeps the
     stdout. The suppressed count is carried so throttling never reads as
     quiet. */
  if (!hit) {
    const now = Date.now();
    if (now - _unknownLobbyAt > UNKNOWN_LOBBY_EVERY_MS) {
      console.warn('[ROOM] unrecognised lobbyType '
        + (typeof lobbyType === 'string' ? JSON.stringify(lobbyType.slice(0, 40)) : '(' + typeof lobbyType + ')')
        + ' in ' + rgn + ' — falling back to the ' + rgn + '_free tier'
        + (_unknownLobbySkipped ? ' (+' + _unknownLobbySkipped + ' more since)' : ''));
      _unknownLobbyAt = now;
      _unknownLobbySkipped = 0;
    } else if (_unknownLobbySkipped < Number.MAX_SAFE_INTEGER) {
      _unknownLobbySkipped++;
    }
  }
  return hit || gameRooms[rgn].free;
}

/* Paid agar.io. The old game's paid gate (AGAR_PAID, closed 2026-09-30) went with the old game:
   its cell:join and cell:respawn doors no longer exist. The new game's only paid door is
   server/ag/agPaidDoor.js on the /ag namespace (ag:join with an entryToken), consuming at the
   'agar' door and seating only on the rungs AG_PAID built at boot (on by default). A token that
   reaches it while paid agar is off or closed is refunded at the door ('not-open'); a token
   nobody spends expires and the sweep refunds it through its stake row (entryExpiry.js). */

/* Holds ONE entry at most: the owner's alert socket, under OWNER_WALLET, put there only by an
   owner signature (socketIdentity.ownerAlerts, security review item e). Every owner alert
   looks it up by OWNER_WALLET. */
const lobbySocketsByGoogleId = new Map();
const lobbyConnections = new Set();
/* A socket's wallet comes only from proof: a paid entry token's verified payer, or a wallet
   signature checked once per socket. A claimed googleId binds nothing (security review item e). */
const socketIdentity = require('./socketIdentity').createSocketIdentity({
  verifyIdentityProof: (p) => nameProof.verifyIdentityProof(p),
  walletForAction: (p) => ownerAuth.walletForAction(p),
  isOwner: (w) => OWNER_WALLETS.has(w),
  alertKey: OWNER_WALLET,
  ownerSockets: lobbySocketsByGoogleId,
});

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
// Total the escrow currently owes: every live, paid stake still in play across every
// game, in the active unit (SOL or USDC). Paid play requires a
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
  }
  /* Paid agar.io: each paid room's whole bank (every open account, away and
     frozen ones included), settling rooms too (agArenas.all()); free rooms add 0. */
  if (agArenas) for (const r of agArenas.all()) total += r.liveStakeTotal ? r.liveStakeTotal() : 0;
  /* Paper: each arena's whole bank, which is every live square (a seat in its
     disconnect grace included) PLUS floor money nobody has picked up yet, each
     dollar once. A coin swept to the house after the hour has left the bank,
     so the liability drops by exactly what the paper_floor ledger row says. */
  for (const r of paperArenas.all()) total += r.liveStakeTotal();
  /* Paid snake on the sl engine: each paid room's whole bank in dollars, every
     open account (live, gliding or parked) plus the gold on its floor, settling
     rooms too (slPaid.all(); PAID-SL-DESIGN.md 7.5). */
  if (slPaid) for (const r of slPaid.all()) total += r.liveStakeTotal();
  /* Paid entry tokens minted and not yet spent: the stake is in escrow and is
     owed to somebody, as a seat or as the refund its expiry pays. Dev tokens
     have no chain behind them and are left out. */
  total += entryStore.pending({ backedOnly: true }).worth;
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
  if (money.mode === 'usdc' && process.env.ESCROW_PRIVATE_KEY) await checkEscrowSol();
}

/* Escrow SOL pays the fee of every USDC payout, refund and rake sweep; when it
   runs out they all fail into failed_payouts. The USDC check above cannot see
   it, and a leak of it (review finding: escrow paying players' account rent)
   went unnoticed. Below the floor: logged every check, the owner told at most
   once an hour. 0.01 SOL is about 2000 payouts at 5000 lamports each. */
const ESCROW_SOL_FLOOR = 0.01;
let _escrowSolAlertAt = 0;
async function checkEscrowSol() {
  try {
    const lamports = await Usdc.withRetry(() => Usdc.connection.getBalance(Usdc.escrowPubkey()));
    const sol = lamports / 1e9;
    if (_lastSolvency) _lastSolvency.escrowFeeSol = sol;
    if (!(sol < ESCROW_SOL_FLOOR)) return;
    console.warn(`[SOLVENCY] escrow SOL low: ${sol.toFixed(6)} SOL left for payout fees (floor ${ESCROW_SOL_FLOOR})`);
    if (Date.now() - _escrowSolAlertAt < 60 * 60 * 1000) return;
    _escrowSolAlertAt = Date.now();
    const s = lobbySocketsByGoogleId.get(OWNER_WALLET);
    if (s) s.emit('admin:solvency_alert', Object.assign({}, _lastSolvency, { escrowFeeSol: sol, feeSolLow: true }));
    notify.pushOwner(`Escrow has ${sol.toFixed(4)} SOL left for payout fees. Top it up or payouts will start failing.`,
      { title: 'Escrow SOL low', priority: 'high' });
  } catch (e) {
    console.error('[SOLVENCY] escrow SOL check failed:', e.message);
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
/* Writing stays open (it is how a browser reports a stall) but bounded: 64 KB a report, a plain
   object only, 6 a minute per address, the newest 30 kept. Reading is the owner's only: the
   reports carry user agents and perf internals, and nothing outside the owner reads them. */
const _clientReports = [];
app.post('/api/debug/client', clientReportLimiter, express.json({ limit: '64kb' }), (req, res) => {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ error: 'Bad report' });
  _clientReports.push({ ...b, at: Date.now(), ip: null });
  if (_clientReports.length > 30) _clientReports.shift();
  res.json({ ok: true });
});
app.get('/api/debug/client', sigLimiter, async (req, res) => {
  if (!(await isOwnerReq(req))) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    now: Date.now(),
    reports: _clientReports.map(r => ({ ...r, agoSec: Math.round((Date.now() - r.at) / 1000) })),
  });
});

/* The one instrument that can NAME the blocker. Tick lag says the thread died
   and the job timers say it was no job, so what remains is a stack trace from
   inside the stall. See server/profiler.js. Owner only: it is stack traces of this process. */
app.get('/api/debug/profile', sigLimiter, async (req, res) => {
  if (!(await isOwnerReq(req))) return res.status(403).json({ error: 'Forbidden' });
  res.json(profiler.report());
});

/* /api/debug/tick below and /wallet/debug above stay unauthenticated on purpose:
   scripts/loadtest.js reads /api/debug/tick with no credentials for its server-tick columns,
   and test/durableStakeServer.test.js reads /wallet/debug's ledger flags the same way (the
   owner's no-login check that paid stakes are durable). Neither carries a secret. */

app.get('/api/debug/tick', (req, res) => {
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
    /* Every room on this process (server/debugTick.js): the snake rooms
       (fixed tiers, the battle royale and every ladder rung) with their
       tick-lag and broadcast-gap logs, each stall with its absolute time; the
       agar.io rooms with their full tick timing (wake lateness, steps per
       wake, step cost, send intervals, dropped backlog, the last 60 s of
       ticks); the Paper arenas and the tanks arena with their counts.
       ?recent=N (or all) sets how many raw agar ticks each row carries. */
    rooms: debugTick.roomRows({
      snakeRooms: ALL_SNAKE_ROOMS(),
      agRooms: agArenas ? agArenas.all() : [],
      paperRooms: paperArenas ? paperArenas.all() : [],
      shooterRooms: shooterRoom ? [shooterRoom] : [],
      now: Date.now(),
      recent: debugTick.parseRecent(req.query && req.query.recent),
    }),
  };
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
   payouts 11, lobby-sweep 14, lb-flush 19, paper-sweep 29. No two share a second,
   and the tightest gap is 3s. Picking 41 for the sweep looked staggered and
   was not: 41 mod 30 is 11, exactly where payouts already lands. The old agar.io
   game's high-score flush (agar-lb, 25) went with that game: its board was sent
   to every lobby socket and nothing ever read it. */
everyStaggered(() => allTimeLb.flush(),    30000, 19000, 'lb-flush');
everyStaggered(() => ladder.sweep(),       60000, 44000, 'lobby-sweep');
everyStaggered(() => collusion.evaluate(), 30000, 37000, 'collusion');
/* Paper: deletes an empty overflow arena, and runs the hour sweep of floor money
   on any arena that has gone idle and stopped ticking. 29 mod 30 sits 4s from
   solvency (3) and 7s from stake-sweep (22). */
everyStaggered(() => paperArenas.sweep(Date.now()), 60000, 29000, 'paper-sweep');
/* The agar.io rooms (only while AG_ENABLED opened them): closes an empty
   overflow room. 16.5 mod 30 sits in the widest free gap, 2.5s from lobby-sweep
   (44, so 14) and 2.5s from lb-flush (19); stake-sweep already holds 22. */
if (agArenas) everyStaggered(() => agArenas.sweep(Date.now()), 60000, 16500, 'ag-sweep');
/* The new slither.io free room (only while SL_ENABLED opened it): replaces a
   room that closed itself. 26 mod 30 sits 3s from paper-sweep (29) and 4s from
   stake-sweep (22). */
if (slArenas) everyStaggered(() => slArenas.sweep(Date.now()), 60000, 26000, 'sl-sweep');
/* Paid snake on the sl engine (only while openSlPaid built it): a paid room
   empty for FLOOR_SWEEP_MS books its floor gold to the house and retires, and a
   settling room is retried (PAID-SL-DESIGN.md 7.5), and so is an owed row the
   database refused (slOwedLane, review T5-R3). 9 mod 30 sits 2s from
   collusion (7) and from payouts (11). */
if (slPaid) everyStaggered(() => {
  const owed = slOwedLane.retry();
  slPaid.sweep(Date.now());
  return owed;
}, 60000, 9000, 'slpaid-sweep');

// ── Failed-payout drainer (NA only) ───────────────────────────────────────────
// Retries payouts that failed (e.g. an RPC outage) so a player's winnings are never stranded.
// server/payoutDrainer.js: money.attemptPayout is idempotent (it only ever re-broadcasts the SAME
// signed tx and saves a freshly built one BEFORE sending it), the row claim (SKIP LOCKED) keeps
// two runs off one row, and rows whose wallet has no USDC account wait in their own slow lane so
// they can never hold up anybody else's payout (STATUS item 7b). Runs only on NA so the two
// servers never race the same payout.
const payoutDrainer = require('./payoutDrainer').createPayoutDrainer({
  db,
  money,
  noAccountCode: Usdc.RECIPIENT_NO_USDC_ACCOUNT,
});
/* One drain at a time (security review 2026-10-15, "drainer double pay"): this tick and kickDrain
   below both land here, and a call made while a drain is running merges into one follow-up run
   instead of starting a second drain beside it (payoutDrainer.drain), whose 30 s claim lease a
   slow build could outlast. The signature save is a compare-and-set too (db.savePayoutSignature). */
function drainPayouts() {
  return payoutDrainer.drain();
}
if (REGION === 'na') everyStaggered(drainPayouts, 30000, 11000, 'payouts');
/* A stake refund just became an owed row (server/stakeLedger.js): drain soon rather than on the
   next 30 s tick, so the player sees it within seconds. NA only, like the drainer; EU's owed rows
   are paid by NA's next tick. At most one pending kick. */
let _drainKick = null;
function kickDrain() {
  if (REGION !== 'na' || _drainKick) return;
  _drainKick = setTimeout(() => {
    _drainKick = null;
    drainPayouts().catch((e) => console.error('[PAYOUT] kick', e.message));
  }, 1500);
  if (_drainKick.unref) _drainKick.unref();
}
/* Stakes verified but never seated or refunded: refunded once through their rows. At boot (after
   the DB is up, below) this region's rows from earlier boots of this server, whose tokens died
   with it; every 5 minutes any row older than 30 minutes. Offset 22 mod 30 is free (19 and 25
   are the nearest). */
everyStaggered(() => stakeLedger.sweep({ boot: false }), 300000, 22000, 'stake-sweep');

// How long to keep a disconnected player's snake gliding before giving up on a
// reconnect. Covers a typical mobile network blip without leaving dead snakes around.
const RECONNECT_GRACE_MS = 8000;

// Guard the region lookup: a server only hosts its own region's rooms now, so
// gameRooms[rgn] is undefined for the others.
function totalInGame() {
  return REGIONS.reduce((t, rgn) =>
    t + Object.values(gameRooms[rgn] || {}).reduce((s, r) => s + r.playerCount + r.botCount, 0), 0);
}

/* LOBBY_STATE used to carry the old agar.io game's agarPlayerCount, agarLobbyCount and
   agarLeaderboard as well. No lobby code read any of them (the cards count from /api/live), so
   they went with that game. */
function broadcastLobbyState() {
  const state = {
    playerCount:      totalInGame()     + (remoteStats.playerCount     || 0),
    lobbyCount:       lobbyConnections.size,
    leaderboard:      allTimeLb.getTop(3),
    region:           REGION,
  };
  for (const sock of lobbyConnections) sock.emit(C.EVENTS.LOBBY_STATE, state);
  pushStatsToNA();
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // Every client message goes through here: anything but nothing-or-a-plain-object is dropped
  // before its handler runs (isSocketMsg, above). Only the first argument is passed on.
  const on = (ev, fn) => socket.on(ev, (msg) => { if (isSocketMsg(msg)) fn(msg); });

  socket.emit(C.EVENTS.LOBBY_STATE, {
    playerCount:      totalInGame()     + (remoteStats.playerCount     || 0),
    lobbyCount:       lobbyConnections.size,
    leaderboard:      allTimeLb.getTop(3),
    region:           REGION,
  });

  /* A googleId sent here binds nothing (security review item e): the socket's wallet comes
     from idProof ({ wallet, ts, sig } over nameProof.identityMessage, checked once per socket),
     and the owner's live alerts only from ownerProof (an owner signature over the action
     'owner:alerts', ownerAuth). Without them the socket is an anonymous lobby watcher. */
  on('lobby:join', ({ idProof, ownerProof } = {}) => {
    lobbyConnections.add(socket);
    socketIdentity.fromProof(socket, idProof);
    socketIdentity.ownerAlerts(socket, ownerProof);
    broadcastLobbyState();
  });

  /* walletAddress and googleId are the client's claims and are NOT used for identity or for
     any payout (security review items e and 5): the socket's wallet comes from idProof (or a
     paid token's payer, in enterPaid below), and the room is told only that proven wallet. */
  on(C.EVENTS.PLAY, ({ name, color, lobbyType, stake, entryToken, region, reconnectKey, idProof } = {}) => {
    // Ignore duplicate PLAY events (e.g. from socket reconnect while alive)
    if (socket._room) {
      const existingSnake = socket._room.snakes.get(socket.id);
      if (existingSnake && existingSnake.alive) return;
    }
    /* EVERY FIELD BELOW IS THE CLIENT'S, so each is pinned to the one type it may be before
       anything reads it. Unpinned, one message took the whole process down (no
       uncaughtException handler): region ['na'], {} or 1 passed the room lookup and then threw
       in the owner notice's toUpperCase; region '__proto__' or 'constructor' found no room and
       threw at addPlayer; a lobbyType, stake or name of {"toString":1} threw in the lookup
       itself. The region is resolved ONCE, to a region this server hosts, and that one value is
       used for the room and the notice alike (the notice used to name whatever was sent). A
       real client sends strings and a number, which all pass through exactly as before. */
    const rgn = ownKey(gameRooms, region) ? region : REGION;
    lobbyType = strOr(lobbyType, undefined);
    if (typeof stake !== 'number' && typeof stake !== 'string') stake = undefined;
    reconnectKey = strOr(reconnectKey, undefined);
    /* A buy-in the ladder does not offer is refused, never seated (BACKLOG 2.1). */
    if (isRetiredBuyIn({ lobbyType, stake })) {
      socket.emit(C.EVENTS.ERROR, { message: RETIRED_BUYIN });
      return;
    }
    const playerName = sanitizeName(name);
    // Identity = the wallet the socket PROVED (security review item e): a signature checked once
    // per socket here, or a paid token's verified payer below. A claimed googleId is ignored.
    socketIdentity.fromProof(socket, idProof);
    /* A stake names a rung of the ladder, a lobbyType names a fixed tier. Only
       the redesigned lobby sends the former, so existing clients keep landing
       in exactly the rooms they always did. */
    const byStake = stake !== undefined && stake !== null && isStake(stake);
    const room = getRoomForJoin({ lobbyType, stake, region: rgn });
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
    socket._stake = byStake ? rungOf(stake) : null;
    // One human-readable name for the room, used in logs and owner alerts.
    const roomLabel = byStake
      ? (Number(stake) === 0 ? 'free' : '$' + Number(stake).toFixed(2))
      : (ownKey(LOBBY_FEES, lobbyType) ? lobbyType : 'free');

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
    const consumed = byStake
      ? consumePaidEntryAtStake(entryToken, Number(stake), 'snake')
      : consumePaidEntry(entryToken, ownKey(LOBBY_FEES, lobbyType) ? lobbyType : 'free', 'snake');
    // A paid entry is seated only once its stake row is claimed (enterPaid, STATUS item 7a).
    enterPaid(socket, 'snake', consumed, (entry) => {
      // Server-verified identity from the paid token: the on-chain payer the stake came from
      // (the token never carried a googleId, so the old override here never ran).
      if (entry.walletAddress) {
        socket._walletAddress = entry.walletAddress; // self-custody cash-out target
        socketIdentity.fromEntry(socket, entry);
      }
      socket._room = room;
      socket._joinTime = Date.now();
      console.log(`[>] ${playerName} joins ${roomLabel} lobby (worth: ${entry.worth} ${money.unit})`);
      /* The wallet the room pays (the Battle Royale prize, BattleRoyaleRoom winner): the
         verified payer, else the wallet this socket proved, else none. Never the client's
         walletAddress (finder-4: the free BR prize went to whatever wallet the client named). */
      room.addPlayer(socket, playerName, entry.walletAddress || socketIdentity.proven(socket) || null, color || null, entry.worth);
      notify.pushOwner(
        `${playerName} joined the ${roomLabel} lobby` +
          (entry.worth ? ` for ${entry.worth} ${money.unit}` : ' (free)') +
          ` in ${rgn.toUpperCase()}`,
        { title: 'New player: slither.io', tags: 'video_game' }
      );
      lobbyConnections.delete(socket);
      broadcastLobbyState();
    }, (why) => {
      socket.emit(C.EVENTS.ERROR, { message: ENTRY_REFUSED[why] || 'Entry fee not verified. Please return to the lobby and try again.' });
    });
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

  on('cashout:start', () => {
    /* Blocked by the MATCH, not by the room. Owen's call and the better rule:
       while the room is filling it is an ordinary game and there is no reason
       to take the control away. Once the circle starts closing you are playing
       for the placing, and banking your worth would be the correct move every
       time — which would collapse the mode into normal play with extra steps.

       The hold is the real cash-out path: it pays out on its own timer, so
       blocking only the legacy 'cashout' event below leaves this wide open. */
    if (socket._room && socket._room.isBattleRoyale && brClosed(socket._room)) return;
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

  on('cashout:cancel', () => {
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
  on('cashout', () => {
    if (!socketRL(socket, 'cashout', 1000)) return;
    // Same rule as the hold above: only while a match is actually running.
    if (socket._room && socket._room.isBattleRoyale && brClosed(socket._room)) return;
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

  /* Reachable from outside this connection, so the battle royale can cash its
     winner out without a round trip through the winning client.

     Deliberately the SAME function the hold pays through, not a copy: worth is
     read off the server's snake, the house cut is taken here, and the payout is
     computed here and never read back from anything sent in. A second
     implementation of "pay this player" is the last thing this file needs. */
  socket._doCashout = doCashout;

  // speedMult is no longer read from the client: the only thing it carried was
  // the cash-out slowdown, and the server times that itself now.
  on(C.EVENTS.INPUT, ({ angle, boost } = {}) => {
    if (typeof angle !== 'number' || !Number.isFinite(angle)) return;
    if (socket._room) socket._room.handleInput(socket.id, angle, !!boost);
  });

  // In-game chat — re-broadcast a player's message to everyone in their game room (incl. themselves).
  on(C.EVENTS.CHAT, ({ text } = {}) => {
    const room = socket._room;
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;                                            // spectators can't chat
    const now = Date.now();
    if (socket._lastChat && now - socket._lastChat < 600) return;   // simple anti-spam throttle
    socket._lastChat = now;
    const msg = strOr(text, '').replace(/[<>]/g, '').slice(0, 120).trim();
    if (!msg) return;
    const name = String(player.name || 'Player').slice(0, 24);
    socket.emit(C.EVENTS.CHAT, { name, text: msg, self: true });   // echo to sender (highlighted)
    socket.to(room.socketRoomName).emit(C.EVENTS.CHAT, { name, text: msg }); // to everyone else
  });

  // Client reports how far it can see (world units) for area-of-interest culling —
  // the snapshot broadcaster only sends each player snakes/food within this radius.
  on('view', ({ r, x, y } = {}) => {
    if (typeof r === 'number' && isFinite(r) && r > 0) socket._viewR = Math.min(Math.max(r, 200), 20000);
    /* Where the camera is looking, which is the only way to cull for somebody
       who has no snake to be centred on. Bounded to the world so a bad value
       cannot push the interest cell somewhere absurd. */
    if (typeof x === 'number' && isFinite(x)) socket._viewX = Math.max(-1e5, Math.min(1e5, x));
    if (typeof y === 'number' && isFinite(y)) socket._viewY = Math.max(-1e5, Math.min(1e5, y));
  });

  /* WATCHING IS FOR A SOCKET WITH NO SEAT, in the spectate handler below. It repoints
     the socket's room, and disconnect only ever clears the room the socket points at, so a
     player who sent a spectate stayed seated in the room they were playing in, with nothing
     left to remove them: alive and unsteered for good, counted as a human in that room's
     /api/live row (the row the no-push-while-paid rule reads), and in a paid snake room holding
     its worth until somebody happened to kill it. An honest client never does this (it sends a
     spectate only as the first message of a fresh socket, in watch-only mode), so a seated
     socket is refused and nothing about its seat changes; no stake moves either way. A watcher
     switching rooms leaves the one it was watching, or it would be sent both. (The old agar.io
     game had a second one, spectate:join:agar; it went with that game. The new agar.io keeps its
     own watcher seats in server/ag.) */
  on('spectate:join', ({ lobbyType, stake, region } = {}) => {
    // Watching costs nothing, so no token is consumed; it only has to resolve
    // to the same room the player would have joined.
    const prev = socket._room;
    if (prev && prev.players.has(socket.id)) return;   // seated: refused (above)
    // A retired rung has no room to watch either (BACKLOG 2.1); the same refusal as PLAY.
    if (isRetiredBuyIn({ lobbyType, stake })) {
      socket.emit(C.EVENTS.ERROR, { message: RETIRED_BUYIN });
      return;
    }
    const room = getRoomForJoin({ lobbyType: lobbyType || 'free', stake, region: region || REGION });
    if (prev && prev !== room) {
      // Its interest-cell room belongs to the old room's broadcaster too (GameRoom.broadcastSnapshot).
      socket.leave(prev.socketRoomName);
      if (socket._cellRoom) { socket.leave(socket._cellRoom); socket._cellRoom = null; }
    }
    socket.join(room.socketRoomName);
    socket._room = room;
    socket._spectating = true;
    socket.emit(C.EVENTS.GAME_JOINED, {
      playerId: socket.id,
      worldRadius: room.worldRadius,
      /* NO FOOD HERE. This handed over every pellet in the room, and the room
         holds a lot more of them than it used to: food is a constant DENSITY
         now, so a full-size arena carries about 16,000 rather than 3,600. That
         is roughly 600KB in one message, and the client then draws all sixteen
         thousand until the first real snapshot replaces them a thirtieth of a
         second later — a spike on exactly the frame somebody just pressed
         Spectate, which is the worst moment to have one.

         The snapshot that arrives next carries the culled set for wherever the
         camera actually is, which is all this ever needed to be. Playing never
         sent it; only watching did. */
      food: [],
      snake: null,
      spectateOnly: true,
    });
  });

  on(C.EVENTS.RESPAWN, ({ entryToken } = {}) => {
    if (!socket._room) return;
    const existing = socket._room.snakes.get(socket.id);
    if (existing && existing.alive) return; // block respawn while alive
    /* And the room gets a say. A battle royale refuses once its match is
       running: it is last snake standing for a real prize, so coming back
       after dying would make it unloseable. */
    if (typeof socket._room.allowsRespawn === 'function' && !socket._room.allowsRespawn()) {
      socket.emit(C.EVENTS.ERROR, { message: 'The match is under way. Wait for the next one.' });
      return;
    }
    /* Server-verified worth from the echoed entry token — the client's entrySol
       is ignored. A respawn re-buys the room the socket is ALREADY in, taken
       from socket._stake rather than from anything the client sends now, so a
       player cannot die in the $0.50 room and respawn into the $1.00 one. */
    const onLadder = socket._stake !== null && socket._stake !== undefined;
    const roomLabel = onLadder
      ? (socket._stake === 0 ? 'free' : '$' + Number(socket._stake).toFixed(2))
      : socket._room.lobbyType.replace(/^(na|eu)_/, '');
    const consumed = onLadder
      ? consumePaidEntryAtStake(entryToken, socket._stake, 'snake')
      : consumePaidEntry(entryToken, socket._room.lobbyType.replace(/^(na|eu)_/, ''), 'snake');
    const room = socket._room;
    enterPaid(socket, 'snake', consumed, (entry) => {
      /* A durable entry gets here after its stake claim, a moment later: the checks above are
         made again, because respawnPlayer silently does nothing for a socket that left the room
         or already has a live snake, and a paid respawn must never be spent on nothing. */
      if (socket._room !== room || !room.players.has(socket.id)) return false;
      const live = room.snakes.get(socket.id);
      if (live && live.alive) return false;
      if (entry.walletAddress) {
        socket._walletAddress = entry.walletAddress;
        socketIdentity.fromEntry(socket, entry); // the verified payer (security review item e)
      }
      room.respawnPlayer(socket.id, entry.worth);
      const _rs = room.snakes.get(socket.id);
      notify.pushOwner(
        `${(_rs && _rs.name) || 'A player'} pressed play again in the ${roomLabel} lobby` +
          (entry.worth ? ` for ${entry.worth} ${money.unit}` : ' (free)'),
        { title: 'Player respawned: slither.io', tags: 'arrows_counterclockwise' }
      );
    }, (why) => {
      socket.emit(C.EVENTS.ERROR, { message: ENTRY_REFUSED[why] || 'Entry fee not verified. Please return to the lobby and try again.' });
    });
  });

  on('ping_check', () => socket.emit('pong_check'));

  on('admin:spawnbot', async ({ count, idToken } = {}) => {
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

  /* Owner-only, verified by an ed25519 SIGNATURE from the owner wallet.

     It used to take a Privy token and call isOwnerToken, and that is precisely
     the route server/ownerAuth.js exists to replace: "It is what owner auth
     used before and it is what stopped working." The in-game button was the one
     caller never migrated, so pressing Start match did nothing — and because
     the refusal was a bare `return`, it did nothing SILENTLY, with no error to
     show and nothing in the log.

     The signature path depends on nothing outside this process: no Privy, no
     app id, no network, no expiry. The message names the action and the second
     it was signed, so a captured signature cannot be replayed or re-aimed.

     Every refusal now says so. A control that refuses without a word is
     indistinguishable from a broken one, which is exactly how this survived. */
  on('br:start', ({ proof, force } = {}) => {
    /* Even the rate limit says something. A silent drop here is the same
       failure as the silent auth refusal above: the button does nothing and
       nothing anywhere says why. */
    if (!socketRL(socket, 'brstart', 2000)) {
      socket.emit('br:error', { message: 'Give it a second, then try again.' });
      return;
    }
    const room = activeBr();
    if (!room) { socket.emit('br:error', { message: 'No battle royale room' }); return; }
    if (!ownerFromSignature(proof)) {
      socket.emit('br:error', { message: 'That did not come from the owner wallet.' });
      return;
    }
    /* ONE AT A TIME. Not just 'running': a countdown is a match starting, and
       'over' / 'reopening' are one finishing. Beginning another on top of any of
       them is a second battle royale. */
    if (room.state !== 'waiting') {
      socket.emit('br:error', { message: 'A match is already under way' });
      return;
    }
    /* `force` overrides the player minimum, the same override the owner console
       has. It is not a lowering of the rule: canStart() still says no, and the
       caller has to ask for it by name. */
    if (force) {
      if (room.livingCount() < 1) {
        socket.emit('br:error', { message: 'Nobody is in the room to start with' });
        return;
      }
      room.forceStart('owner override');
      return;
    }
    if (!room.canStart()) {
      socket.emit('br:error', {
        message: 'Needs ' + room.publicState().minPlayers + ' player(s) in the room',
      });
      socket.emit('br:state', room.publicState());
      return;
    }
    room.startMatch('owner');
  });

  /* Anyone in the room may ASK what the match is doing. It is the same thing
     they can already see out of the window.

     `isOwner` rides on THIS reply rather than on the room broadcast, because it
     is the one field that differs per listener and the broadcast goes to
     everybody at once. It decides whether the Start match button is drawn, and
     nothing more: the wallet named here is merely claimed, so a forged one buys
     a button whose action still has to carry a real signature. Visibility is a
     courtesy; the signature is the rule.

     This replaces a check on `localStorage.duel_admin_token`, which the wallet
     widget writes for EVERY signed-in player. Every player who had ever logged
     in was being shown an owner control. */
  on('br:peek', ({ wallet } = {}) => {
    const room = activeBr();
    if (!room) return;
    const st = room.publicState();
    st.isOwner = typeof wallet === 'string' && !!wallet && OWNER_WALLETS.has(wallet);
    socket.emit('br:state', st);
  });

  /* ── Tanks ────────────────────────────────────────────────────────────────
     A duel, so the whole surface is four messages: get in the queue, get out,
     fire, and leave. Everything about what a shot DOES is decided in the room
     and sent back; nothing here trusts a number from the client beyond the two
     the player is entitled to choose. */
  /* While Bowmasters is locked there is no lobby, and each of these returns
     before doing anything (shared/lockedGames.js). */
  on('tanks:queue', ({ name, wallet } = {}) => {
    if (!tanksLobby) return;
    if (!socketRL(socket, 'tanksq', 1000)) return;
    if (ops.get().maintenance) { socket.emit('maintenance', ops.get()); return; }
    tanksLobby.enqueue(socket, sanitizeName(name), strOr(wallet, null) || socket._walletAddress || null);
    socket.emit('tanks:queued', { waitingMs: tanksLobby.queuedFor(socket.id) || 0 });
  });

  on('tanks:unqueue', () => {
    if (!tanksLobby) return;
    tanksLobby.dequeue(socket.id);
    socket.emit('tanks:unqueued', {});
  });

  on('tanks:fire', ({ angle, power } = {}) => {
    if (!tanksLobby) return;
    if (!socketRL(socket, 'tanksfire', 300)) return;
    const room = tanksLobby.roomOf(socket.id);
    if (!room) return;
    const shot = room.fire(socket.id, angle, power);
    if (!shot.ok) { socket.emit('tanks:refused', { why: shot.why }); return; }
    room.broadcast('tanks:shot', shot.result);
  });

  on('tanks:leave', () => { if (tanksLobby) tanksLobby.leave(socket.id); });

  /* ── Knockout ─────────────────────────────────────────────────────────────
     A duel on a shrinking disc. The client sends an arrow per piece and a
     lock-in, and that is the entire surface: where the pieces end up, what hit
     what, and who won are all decided in KnockoutRoom and sent back. An aim is
     clamped there rather than believed, so a patched client that sends a pull
     of ten thousand gets the same shot as a player who dragged to the edge of
     their screen. */
  on('ko:queue', ({ name, wallet, stake, entryToken, shop, skinPass } = {}) => {
    if (!socketRL(socket, 'koq', 1000)) return;
    if (ops.get().maintenance) { socket.emit('maintenance', ops.get()); return; }

    /* A BOUGHT SKIN IS PROVED, NOT CLAIMED, the same as a stake. The page names a skin and sends the lobby's skin
       pass (docs/skin-purchases.md); the seat wears it only when the pass is genuine, unexpired and lists
       knockout:<skin>, else null (the free look). Strings only, and decided once here for the free and paid seat
       alike: the room just carries the answer, so both players and every watcher are shown what the server chose. */
    const skin = skinPasses.wornFrom('knockout', {
      shop: typeof shop === 'string' ? shop : null,
      skinPass: typeof skinPass === 'string' ? skinPass : null,
    });

    /* A PAID SEAT IS PROVED, NOT CLAIMED. The stake is whatever the server
       recorded when it verified the on-chain transfer and minted a one-time
       token; nothing the client says about what it paid is read. A seat with no
       valid token is a free seat, and a client asking for a paid table without
       one is refused rather than quietly seated for nothing. */
    // A number or a string only: Number() on a client-built object can throw.
    const wants = (typeof stake === 'number' || typeof stake === 'string') ? Number(stake) || 0 : 0;
    /* The ladder's own number, never the client's. The queue is keyed by the rung, so 0.5000000005
       (inside the token's 1e-9 match) used to open a bucket of its own that never matched. */
    const want = wants > 0 ? rungOf(wants) : 0;
    const seat = (entry) => {
      let worth = 0, rung = 0, paid, payTo = null;
      if (entry) {
        worth = entry.worth;
        rung = want;
        paid = entry.paid;               // what landed: bounds a refund (stakeRules.refundBound)
        payTo = entry.walletAddress || null;
        if (entry.walletAddress) socket._walletAddress = entry.walletAddress;
      }

      /* A paid seat's prize or refund goes to the wallet that paid (from the token), never to
         a wallet the client names; a free seat pays nothing, so its name is only a label. */
      knockoutLobby.enqueue(socket, sanitizeName(name),
        worth > 0 ? payTo : (strOr(wallet, null) || socket._walletAddress || null), rung, worth, undefined, paid, skin);
      socket.emit('ko:queued', {
        waitingMs: knockoutLobby.queuedFor(socket.id) || 0,
        stake: rung, worth,
        /* So the screen can say how long it will wait before giving the money
           back, rather than the player finding out by being refunded. */
        paidWaitMs: rung > 0 ? KnockoutLobby.PAID_WAIT_MS : 0,
      });
    };
    if (!(wants > 0)) return seat(null);
    // Off the ladder (the retired 0.1 too): refused before the token is touched, so it stays unspent.
    if (!want) { socket.emit('ko:refused', { why: RETIRED_BUYIN }); return; }
    // A paid seat is queued only once its stake row is claimed (enterPaid, STATUS item 7a).
    enterPaid(socket, 'knockout', consumePaidEntryAtStake(entryToken, want, 'knockout'), seat, (why) => {
      socket.emit('ko:refused', { why: ENTRY_REFUSED[why] || 'that buy-in was not paid for' });
    });
  });

  on('ko:unqueue', () => {
    /* leave(), not dequeue(). dequeue only forgets the seat; on a PAID table the
       buy-in has already settled on-chain by the time somebody is standing in
       the queue, so dropping them without handing it back is taking their money
       for a match that never happened. leave() refunds, once, and tells them. */
    knockoutLobby.leave(socket.id);
  });

  on('ko:aim', ({ aims } = {}) => {
    if (!socketRL(socket, 'koaim', 120)) return;
    const room = knockoutLobby.roomOf(socket.id);
    if (!room) return;
    const r = room.submitAim(socket.id, aims);
    if (!r.ok) { socket.emit('ko:refused', { why: r.why }); return; }
    socket.emit('ko:aimed', { count: r.count });
  });

  on('ko:lock', () => {
    const room = knockoutLobby.roomOf(socket.id);
    if (!room) return;
    if (room.lockIn(socket.id)) room.broadcast('ko:ready', { ready: [...room.ready] });
  });

  on('ko:leave', () => knockoutLobby.leave(socket.id));

  /* WATCHING A MATCH, from the lobby's Spectate. Read-only: the lobby never
     seats, queues or counts a watcher, refuses one that is queued or seated,
     and sends them the match with every socket id swapped for a seat. `after`
     is the match being watched now, so Next match moves on from it; anything
     but a short string is ignored rather than read. */
  on('ko:watch', (msg) => {
    try {
      if (!socketRL(socket, 'kowatch', 500)) return;
      const after = msg && typeof msg.after === 'string' && msg.after.length <= 40 ? msg.after : null;
      const stake = msg && typeof msg.stake === 'number' && isStake(msg.stake) ? msg.stake : undefined;
      knockoutLobby.watch(socket, { after, stake });
    } catch (e) { console.error('[KO] watch failed:', e.message); }
  });
  on('ko:unwatch', () => {
    try { knockoutLobby.unwatch(socket.id); } catch (e) { console.error('[KO] unwatch failed:', e.message); }
  });

  /* ── Battleship ───────────────────────────────────────────────────────────
     The client sends a fleet layout and, on its turn, one square. Everything
     else — whether that square holds a ship, whose turn it is next, and who has
     won — is decided in BattleshipRoom and pushed back per player. The one
     thing that must never travel is the opponent's layout, which is why state
     is sent with viewFor rather than broadcast to the room. */
  on('bs:queue', ({ name, wallet, stake, entryToken, shop, skinPass } = {}) => {
    if (!socketRL(socket, 'bsq', 1000)) return;
    if (ops.get().maintenance) { socket.emit('maintenance', ops.get()); return; }

    // A bought skin is proved, not claimed (see ko:queue): the seat's fleet wears it only on a genuine pass, else null.
    const skin = skinPasses.wornFrom('battleship', {
      shop: typeof shop === 'string' ? shop : null,
      skinPass: typeof skinPass === 'string' ? skinPass : null,
    });

    // A number or a string only: Number() on a client-built object can throw.
    const wants = (typeof stake === 'number' || typeof stake === 'string') ? Number(stake) || 0 : 0;
    const want = wants > 0 ? rungOf(wants) : 0;   // the ladder's own number, as in ko:queue
    const seat = (entry) => {
      let worth = 0, rung = 0, paid, payTo = null;
      if (entry) {
        worth = entry.worth;
        rung = want;
        paid = entry.paid;               // what landed: bounds a refund (stakeRules.refundBound)
        payTo = entry.walletAddress || null;
        if (entry.walletAddress) socket._walletAddress = entry.walletAddress;
      }

      /* A paid seat's prize or refund goes to the wallet that paid (from the token). */
      battleshipLobby.enqueue(socket, sanitizeName(name),
        worth > 0 ? payTo : (strOr(wallet, null) || socket._walletAddress || null), rung, worth, paid, skin);
      socket.emit('bs:queued', {
        waitingMs: battleshipLobby.queuedFor(socket.id) || 0,
        stake: rung, worth,
        paidWaitMs: rung > 0 ? BattleshipLobby.PAID_WAIT_MS : 0,
      });
    };
    if (!(wants > 0)) return seat(null);
    if (!want) { socket.emit('bs:refused', { why: RETIRED_BUYIN }); return; }   // token left unspent
    // A paid seat is queued only once its stake row is claimed (enterPaid, STATUS item 7a).
    enterPaid(socket, 'battleship', consumePaidEntryAtStake(entryToken, want, 'battleship'), seat, (why) => {
      socket.emit('bs:refused', { why: ENTRY_REFUSED[why] || 'that buy-in was not paid for' });
    });
  });

  on('bs:unqueue', () => battleshipLobby.leave(socket.id));

  on('bs:place', ({ layout } = {}) => {
    if (!socketRL(socket, 'bsplace', 250)) return;
    const room = battleshipLobby.roomOf(socket.id);
    if (!room) return;
    const r = room.placeFleet(socket.id, layout);
    if (!r.ok) { socket.emit('bs:refused', { why: r.why }); return; }
    socket.emit('bs:placed', {});
  });

  on('bs:fire', ({ cell } = {}) => {
    if (!socketRL(socket, 'bsfire', 250)) return;
    const room = battleshipLobby.roomOf(socket.id);
    if (!room) return;
    const r = room.fire(socket.id, cell);
    if (!r.ok) { socket.emit('bs:refused', { why: r.why }); return; }
  });

  on('bs:leave', () => battleshipLobby.leave(socket.id));

  /* Watching, the same as Knockout's. A watcher is sent spectatorView, which is
     both boards as shots and sunk ships only, and never viewFor. */
  on('bs:watch', (msg) => {
    try {
      if (!socketRL(socket, 'bswatch', 500)) return;
      const after = msg && typeof msg.after === 'string' && msg.after.length <= 40 ? msg.after : null;
      const stake = msg && typeof msg.stake === 'number' && isStake(msg.stake) ? msg.stake : undefined;
      battleshipLobby.watch(socket, { after, stake });
    } catch (e) { console.error('[BS] watch failed:', e.message); }
  });
  on('bs:unwatch', () => {
    try { battleshipLobby.unwatch(socket.id); } catch (e) { console.error('[BS] unwatch failed:', e.message); }
  });
  /* ── Shooter ──────────────────────────────────────────────────────────────
     Free, solo, and server-simulated anyway. The client sends which keys are
     down and where it is aiming; it never says that it hit something, took a
     coin or cleared a level. There is no money in this mode today, and the
     day there is, none of this has to be rewritten. */
  /* While Awesome Tanks is locked there is no arena, and each of these returns
     before doing anything (shared/lockedGames.js). */
  on('sh:join', ({ name, weapon } = {}) => {
    if (!shooterRoom) return;
    if (!socketRL(socket, 'shjoin', 1000)) return;
    if (ops.get().maintenance) { socket.emit('maintenance', ops.get()); return; }
    shooterRoom.removePlayer(socket.id);         // a second Play replaces the first
    shooterRoom.addPlayer(socket, sanitizeName(name), strOr(weapon, ''));
    socket.emit('sh:map', shooterRoom.mapPayload());
  });

  on('sh:input', (input) => {
    if (!shooterRoom || !input || typeof input !== 'object') return;
    shooterRoom.setInput(socket.id, input);
  });

  /* Switching guns mid-round is free and instant. They are all free anyway —
     the choice is what you want to play, not what you can afford — so the only
     thing this has to refuse is a weapon that does not exist. */
  on('sh:weapon', ({ weapon } = {}) => {
    if (!shooterRoom) return;
    if (!socketRL(socket, 'shweapon', 150)) return;
    if (!shooterRoom.setWeapon(socket.id, strOr(weapon, ''))) {
      socket.emit('sh:refused', { why: 'no such weapon' });
    }
  });

  /* Asked for by a dead player. Nothing else puts them back in the arena, so
     dying is a full stop rather than a two-second interruption. */
  on('sh:respawn', () => {
    if (!shooterRoom) return;
    if (!socketRL(socket, 'shrespawn', 400)) return;
    shooterRoom.respawn(socket.id);
  });

  on('sh:leave', () => endShooter(socket.id));

  /* ── Paper ─────────────────────────────────────────────────────────────────
     pp:join, pp:respawn, pp:in, pp:need, pp:leave, pp:ping. Every handler is
     wrapped so nothing a client sends can throw out of socket.io, and the worth
     of a paid seat comes from the one-time entry token only. */
  paper.attach(socket);

  socket.on('disconnect', async () => {
    /* Dropping out of a duel hands the other player the win, and takes this
       socket out of the queue if it never got into one. Without it a closed tab
       leaves an opponent staring at a turn that will never come. */
    if (tanksLobby) tanksLobby.leave(socket.id);
    knockoutLobby.leave(socket.id);
    battleshipLobby.leave(socket.id);
    knockoutLobby.unwatch(socket.id);            // a watcher holds no seat, only a place on the list
    battleshipLobby.unwatch(socket.id);
    endShooter(socket.id);
    paper.drop(socket.id);                       // a Paper seat enters its 5 s grace
    console.log(`[-] Disconnected: ${socket.id}`);
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
    socketIdentity.forget(socket);   // only this socket's own owner-alert registration, if it had one
    lobbyConnections.delete(socket);
    broadcastLobbyState();
  });
});

/* Nothing matched. Registered last, after every route above (all of which are
   registered synchronously at load, none later), so it can only ever answer
   what would have been Express's bare white "Cannot GET /path" page: the
   site's own 404 for a page, plain JSON for /api. */
// Every browser asks for /favicon.ico whatever the page links; the PNG mark answers it.
app.get('/favicon.ico', (_req, res) => res.type('png').sendFile(path.join(__dirname, '../public/img/favicon-32.png')));
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(__dirname, '../public/404.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
