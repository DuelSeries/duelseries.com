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
const ops       = require('./ops');       // maintenance mode
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

// Active money mode — tells the wallet widget whether to build SOL or USDC transfers and how to
// label balances. usdcMint is null in SOL mode.
app.get('/api/money-config', (req, res) => {
  // network lets the client build an explorer link that points at the cluster the
  // payout actually happened on, instead of guessing mainnet.
  res.json({ mode: money.mode, unit: money.unit, usdcMint: money.usdcMint || null, decimals: money.decimals || 6, network: process.env.SOLANA_NETWORK || 'mainnet-beta' });
});

// ─── Cross-region stats: EU pushes to NA instantly on every change ────────────
/* The old agar.io game's agarPlayerCount used to ride along here. Nothing ever read it (the lobby
   cards count from /api/live), so it went with that game; an old EU server still sending it is
   simply ignored. */
let remoteStats = { playerCount: 0, liveStakesSol: 0 };
const STATS_SECRET = process.env.SESSION_SECRET || 'duelseries-dev-secret';

// Both servers expose their local counts (used by EU to self-report)
app.get('/api/stats', (req, res) => {
  res.json({ playerCount: totalInGame() });
});

// NA server receives pushed stats from EU
if (REGION === 'na') {
  app.post('/api/stats/push', express.json(), (req, res) => {
    if (req.headers['x-stats-secret'] !== STATS_SECRET) return res.sendStatus(403);
    remoteStats = { playerCount: req.body.playerCount || 0, liveStakesSol: req.body.liveStakesSol || 0 };
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
   a sweep runs, long after boot. */
/* Every verified stake has a durable row (server/stakeLedger.js, STATUS item 7a): a door claims
   it before seating, a refund claims it with its owed payout row, and at boot every stake an
   earlier boot of this server verified but never seated or refunded is refunded once. BOOT_ID
   names this process's rows, so the boot sweep leaves this boot's live tokens alone. */
const BOOT_ID = crypto.randomUUID();
const stakeLedger = require('./stakeLedger').createStakeLedger({
  db,
  region: REGION,
  bootId: BOOT_ID,
  kickDrain: () => kickDrain(),
});

const refundExpiredEntry = require('./entryExpiry').createExpiryRefund({
  money,
  db,
  ledger: stakeLedger,
  devRefund: PAPER_DEV_TOKENS
    ? (t) => (t.onlyGame === 'agar' ? agPayout : paperPayout).refund({ wallet: t.walletAddress, name: 'Player', micro: Math.round(Number(t.worth) * 1e6), paid: t.paid, why: 'unspent' })
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
         absent, 'paper' or 'agar', nothing else, checked before anything reads it. */
      || (devGame !== undefined && devGame !== 'paper' && devGame !== 'agar')) {
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
       Scoped to Paper (or to paid agar.io with devGame 'agar'): only those two
       pay it out through their fake withdraw, and any other game would pay,
       refund or rake it through the real one. */
    if (!signedTx && PAPER_DEV_TOKENS) {
      if (typeof walletAddress !== 'string' || !walletAddress || walletAddress.length > 64) {
        return res.status(400).json({ error: 'Missing wallet address' });
      }
      const rung = tierFor(want);
      const onlyGame = devGame === 'agar' ? 'agar' : 'paper';
      const entryToken = entryStore.mint({ stake: rung, worth: rung, paid: rung, walletAddress, onlyGame });
      console.warn(`[PAPER] DEV token ${rung} (${onlyGame}) for ${walletAddress.slice(0, 8)}`);
      return res.json({ ok: true, entryToken, worth: rung, stake: rung, paid: rung, dev: true });
    }
    if (!signedTx) return res.status(400).json({ error: 'Missing signed transaction' });
    // USDC only, refused before the broadcast (ladderPriced). Dev tokens above touch no chain.
    if (!ladderPriced()) return res.status(503).json({ error: LADDER_NEEDS_USDC });
    try {
      const sig = await Wallet.submitStake(Buffer.from(signedTx, 'base64'));
      const { payer, worth } = await money.verifyStake(sig, money.amountFor(want));
      const rung = tierFor(worth);
      if (!rung) return res.status(400).json({ error: 'Payment did not cover any buy-in' });
      // Atomic one-time claim AFTER verify, as in the tier path below. The same INSERT writes
      // the stake's durable row (who is owed, what a refund pays: what landed, capped at the
      // rung), so a restart before the join refunds it instead of losing it (STATUS item 7a).
      const rec = await stakeLedger.record(sig, { wallet: payer, amount: refundBound(rung, worth), label: 'stake ' + rung });
      if (!rec.claimed) return res.status(400).json({ error: 'Stake already used' });
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
    }
  }

  // Own keys only: 'constructor' used to find Object here and go on to verify and mint a token
  // for a lobby that does not exist.
  const fee = ownKey(LOBBY_FEES, lobbyType) ? LOBBY_FEES[lobbyType] : undefined;
  if (fee === undefined || fee === 0) return res.status(400).json({ error: 'Not a paid lobby' });
  if (!signedTx) return res.status(400).json({ error: 'Missing signed transaction' });
  try {
    const sig = await Wallet.submitStake(Buffer.from(signedTx, 'base64')); // broadcast (works for any signed tx)
    // Verify the stake landed in escrow and read the SERVER-recorded worth (SOL or USDC, per mode).
    const { payer, worth } = await money.verifyStake(sig, money.feeFor(lobbyType));
    // Atomic one-time claim AFTER verify — closes the double-mint race (two concurrent
    // requests with the same sig can't both pass) without burning a valid sig on a transient
    // verify failure. If it returns false, another request already consumed this stake.
    const rec = await stakeLedger.record(sig, { wallet: payer, amount: refundBound(worth), label: 'lobby ' + lobbyType });
    if (!rec.claimed) return res.status(400).json({ error: 'Stake already used' });
    // Same rule as the ladder path above: pay out to who actually paid, and a
    // request naming someone else is logged, never left holding a claimed stake.
    if (walletAddress && walletAddress !== payer) {
      console.warn(`[STAKE] request named ${String(walletAddress).slice(0, 12)} but ${payer} paid ${sig}: minted to the payer`);
    }
    const entryToken = entryStore.mint({ lobbyType, worth, walletAddress: payer, stakeSig: rec.durable ? sig : undefined });
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
  const br = gameRooms[REGION] && gameRooms[REGION].br;
  const rooms = ALL_ROOMS().map(r => ({
    id: r.lobbyType,
    game: r.isBattleRoyale ? 'battle royale'
        : r.lobbyType === 'tanks' ? 'Awesome Tanks'
        : String(r.lobbyType).startsWith('paper_') ? 'Paper'
        : String(r.lobbyType).startsWith('ag_') ? 'agar.io' : 'slither.io',
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
  const action = strOr(req.body && req.body.action, '');
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
      return done('Maintenance on. New games refused.');
    case 'maintenance:off':
      ops.set({ on: false });
      io.emit('maintenance', ops.get());
      if (agArenas) io.of('/ag').emit('maintenance', ops.get());
      return done('Maintenance off. The game is open.');

    /* Paid agar.io's own instant door switch (PAID-AGAR-DESIGN.md 5.7): off,
       every new paid join is refunded at the door ('not-open') and the rows say
       closed, while seated players keep playing, resume and cash out. No
       restart. On only reopens rungs that AG_PAID built at boot. */
    case 'agar:paid:off':
      if (!agArenas || !agArenas.paidEnabled) return refuse('Paid agar.io is not on (AG_PAID)');
      agArenas.paidOpen = false;
      console.warn('[AG] owner console: paid door CLOSED');
      return done('Paid agar.io closed to new players. Seated players finish.');
    case 'agar:paid:on':
      if (!agArenas || !agArenas.paidEnabled) return refuse('Paid agar.io is not on (AG_PAID)');
      if (agArenas.stopping) return refuse('The server is restarting');
      agArenas.paidOpen = true;
      console.warn('[AG] owner console: paid door OPEN');
      return done('Paid agar.io open.');
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
  const wallet = strOr(req.query.wallet, '').trim();   // a string only: ?wallet[]=a threw
  if (!wallet) return res.status(400).json({ error: 'No wallet' });
  try {
    const rows = await Usdc.usdcHistory(wallet, 12);
    res.json({ transactions: rows });
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
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '../public/v2.html')));
app.get('/v2', (_req, res) => res.sendFile(path.join(__dirname, '../public/v2.html')));
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
const slGate = require('./slRoutes');
slGate.slRoutes(app, {
  open: slGate.slSwitch(process.env.SL_ENABLED),
  file: path.join(__dirname, '../public/sl.html'),
});

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
const KO_HOUSE_CUT = 0.10;

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
   nothing is pushed while /api/live shows a human in a paid room, since a push restarts the
   server and money already seated is lost on a restart. */
const { PaperArenas } = require('./paper/PaperArenas');
function paperPaidSwitch(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '' || v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  console.error(`[PAPER] PAPER_PAID=${JSON.stringify(String(raw).slice(0, 20))} is not a switch value; paid rungs stay OFF`);
  return false;
}
const PAPER_PAID = paperPaidSwitch(process.env.PAPER_PAID);
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
  hooks: {
    onCashout: paperPayout.payCashout,
    onTransfer: (t) => collusion.record(t.srcWallet, t.dstWallet, t.micro / 1e6, { lobbyType: t.label }),
    onRefund: paperPayout.refund,
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
/* Agar money in flight (payouts, refunds, door claims), for the shutdown settle to
   wait on (server/ag/agShutdown.js). */
const agShutdown = require('./ag/agShutdown');
const agInflight = agShutdown.createInflight();
/* The paid agar money journal (server/ag/agJournal.js, Owen Q6): every paid
   account's open and close, written synchronously to a local file, so a crash's
   refunds reach the database at the next boot and a killed process's open
   balances are flagged to Owen. Rotated here, before any account can open;
   replayed once the database is up (the boot block at the top of this file).
   A journal left by an earlier boot is replayed even with AG_PAID now off. */
const agJournal = require('./ag/agJournal').createAgJournal({
  file: process.env.AG_JOURNAL_PATH || undefined,
  bootId: BOOT_ID,
});
{
  const waiting = agJournal.rotate();
  if (waiting.length) console.warn(`[AG] JOURNAL ${waiting.length} file(s) to replay once the database is up`);
}
function replayAgJournal() {
  agJournal.replay({
    writeOwedOnce: (r) => db.recordOwedOnce(r.key, r.wallet, r.micro / 1e6, r.name || 'Player', r.reason),
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
});
const agArenas = agBoot.arenas;
const AG_PAID_ON = !!agBoot.paid;

/* Shutdown settle (design 5.9, Owen Q6; server/ag/agShutdown.js): a planned
   restart (pm2 sends SIGINT, then kills after its 1.6 s timeout) must not erase
   seated agar money, so every open agar balance is withdrawn from its room and
   written as an owed REFUND row (100%, no rake: a restart is our fault, one row
   per key, db.recordOwedOnce) for the drainer to pay after the restart, each
   also journaled and logged as one [AG] SHUTDOWN-OWED line. The handler never
   ends the process while the leaderboard also listens (production): pm2's kill
   timeout does, exactly as before, so Paper and snake money in flight keeps its
   whole window. Installed only while the paid rungs exist. */
if (AG_PAID_ON) {
  agShutdown.installAgShutdown({
    arenas: agArenas,
    writeRow: (r) => db.recordOwedOnce(r.key, r.wallet, r.micro / 1e6, r.name || 'Player', r.reason),
    inflight: agInflight,
  });
  /* A hard crash leaves no time to write: every open balance is closed into the
     money journal (synchronous) and logged as one [AG] CRASH-OWED line before
     Node's own crash handler runs; the next boot writes the owed rows (Owen Q6). */
  agShutdown.installAgCrashLog({ arenas: agArenas });
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
function liveBoard() {
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
  const room = gameRooms[REGION] && gameRooms[REGION].br;
  if (!room) return null;
  const st = room.publicState();
  const { hour, minute } = easternNow();
  return {
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
    joinable: room.acceptingPlayers(),
    /* The wall clock, from the box that runs the schedule. Eastern hour and
       minute rather than a UTC offset, for the daylight-saving reason written
       at BR_AUTOSTART_HOUR. */
    startHour: BR_AUTOSTART_HOUR,
    startMin: BR_AUTOSTART_MIN,
    etHour: hour,
    etMin: minute,
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
    const lobbies = liveBoard().concat(paperArenas.boardRows(), agRows);
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
  /* Outlasting nobody is not winning. A solo run exists so the mode can be
     tested at all, and paying $20 out of escrow for being alone in a room is
     escrow paying somebody to test the game. */
  if (room.soloRun) {
    console.log(`[BR] ${matchId} was a solo test run — no prize paid`);
    return;
  }
  if (_brPaid.has(matchId)) return;          // a reconnect or a double event must not pay twice
  _brPaid.add(matchId);
  if (!w.wallet) {
    console.warn(`[BR] ${matchId} won by ${w.name} but they have no wallet — nothing paid`);
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
  makeRoom: (game, rgn, stake) => {
    const r = new GameRoom(io, `${rgn}_s${String(stake).replace('.', '_')}`);
    /* What it costs to sit down, on the room itself. Everything that has to
       know whether this room is free asks the room, rather than trying to
       read a price out of its name. */
    r.stake = Number(stake);
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

  on('lobby:join', ({ googleId } = {}) => {
    lobbyConnections.add(socket);
    if (typeof googleId === 'string' && googleId) {
      socket._googleId = googleId;
      lobbySocketsByGoogleId.set(googleId, socket);
    }
    broadcastLobbyState();
  });

  on(C.EVENTS.PLAY, ({ name, walletAddress, googleId, color, lobbyType, stake, entryToken, region, reconnectKey } = {}) => {
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
    googleId = strOr(googleId, undefined);
    walletAddress = strOr(walletAddress, undefined);
    reconnectKey = strOr(reconnectKey, undefined);
    /* A buy-in the ladder does not offer is refused, never seated (BACKLOG 2.1). */
    if (isRetiredBuyIn({ lobbyType, stake })) {
      socket.emit(C.EVENTS.ERROR, { message: RETIRED_BUYIN });
      return;
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
      if (entry.googleId) socket._googleId = entry.googleId;
      if (entry.walletAddress) socket._walletAddress = entry.walletAddress;
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
    const room = gameRooms[REGION] && gameRooms[REGION].br;
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
    const room = gameRooms[REGION] && gameRooms[REGION].br;
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
  on('ko:queue', ({ name, wallet, stake, entryToken } = {}) => {
    if (!socketRL(socket, 'koq', 1000)) return;
    if (ops.get().maintenance) { socket.emit('maintenance', ops.get()); return; }

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
        worth > 0 ? payTo : (strOr(wallet, null) || socket._walletAddress || null), rung, worth, undefined, paid);
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

  /* ── Battleship ───────────────────────────────────────────────────────────
     The client sends a fleet layout and, on its turn, one square. Everything
     else — whether that square holds a ship, whose turn it is next, and who has
     won — is decided in BattleshipRoom and pushed back per player. The one
     thing that must never travel is the opponent's layout, which is why state
     is sent with viewFor rather than broadcast to the room. */
  on('bs:queue', ({ name, wallet, stake, entryToken } = {}) => {
    if (!socketRL(socket, 'bsq', 1000)) return;
    if (ops.get().maintenance) { socket.emit('maintenance', ops.get()); return; }

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
        worth > 0 ? payTo : (strOr(wallet, null) || socket._walletAddress || null), rung, worth, paid);
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
    if (socket._googleId) lobbySocketsByGoogleId.delete(socket._googleId);
    lobbyConnections.delete(socket);
    broadcastLobbyState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
