require('dotenv').config({ override: true });
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const { rateLimit } = require('express-rate-limit');
const C        = require('../shared/constants');
const GameRoom = require('./GameRoom');
const AgarRoom      = require('./AgarRoom');
const agarLb        = require('./agarLeaderboard');
const db     = require('./db');
const collusion = require('./CollusionMonitor');
const Wallet = require('./Wallet');
const allTimeLb = require('./leaderboard');
const prices = require('./prices');
const money = require('./money'); // SOL- or USDC-denominated money backend (picked by MONEY_MODE)

const REGION = process.env.REGION || 'na';

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
// Owner's embedded game wallet — what your Privy login resolves to (public, not a secret).
// Always recognized; the OWNER_WALLET env var can register an ADDITIONAL owner wallet.
const OWNER_WALLET = 'C5cnzckMwH459eEURA8NwuZcKVFMExpRcbRSAuULH3m9';
const OWNER_WALLETS = new Set([OWNER_WALLET, process.env.OWNER_WALLET].filter(Boolean));

// Resolve the Solana wallet for a Privy identity token (local verification of the signed
// token — no API rate limit, scales). Returns the wallet address or null.
async function walletFromIdToken(token) {
  if (!privyServer || !token) return null;
  try {
    // Verify the owner's access token (local JWT check), then look up their Solana wallet.
    const claims = await privyServer.verifyAuthToken(token);
    const user = await privyServer.getUser(claims.userId);
    for (const a of (user.linkedAccounts || [])) {
      if (a && a.type === 'wallet' && (a.chainType === 'solana' || a.chain_type === 'solana') && a.address) return a.address;
    }
    return null;
  } catch (e) { return null; }
}
async function isOwnerToken(idToken) {
  if (!idToken) return false;
  const wallet = await walletFromIdToken(idToken);
  return !!wallet && OWNER_WALLETS.has(wallet);
}
// Owner check for HTTP routes — a verified Privy id token whose wallet is an owner wallet.
async function isOwnerReq(req) {
  const auth = req.headers.authorization || '';
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['privy-id-token'] || null);
  return isOwnerToken(idToken);
}

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
  res.json({ mode: money.mode, unit: money.unit, usdcMint: money.usdcMint || null, decimals: money.decimals || 6 });
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
const entryTokens = new Map(); // opaque token -> { lobbyType, worth, walletAddress, exp }
const ENTRY_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;
// Sweep expired (paid-but-never-used) tokens so the map stays bounded.
setInterval(() => { const now = Date.now(); for (const [k, v] of entryTokens) if (now > v.exp) entryTokens.delete(k); }, ENTRY_TOKEN_MAX_AGE_MS);

// Verify + consume an opaque paid-entry token the client echoes back from the
// /api/submit-stake response. The token is server-generated, unguessable, one-time, and
// carries the SERVER-recorded worth, so the client can neither forge it nor inflate the
// worth — that's what closes the entrySol escrow-drain hole. Needs no socket auth (the
// socket session is empty) and works for join + respawn identically.
function consumePaidEntry(entryToken, shortType) {
  if (!(shortType in LOBBY_FEES)) shortType = 'free';
  if (shortType === 'free') return { ok: true, worth: 0 }; // free lobbies carry no worth
  const t = entryToken && entryTokens.get(entryToken);
  if (!t || t.lobbyType !== shortType || Date.now() > t.exp) return { ok: false, worth: 0 };
  entryTokens.delete(entryToken); // one-time use
  return { ok: true, worth: t.worth, googleId: t.googleId, walletAddress: t.walletAddress };
}

// Phase 4d: the custodial entry-fee is gone — paid play stakes from the self-custody wallet
// (/api/stake-quote + /api/submit-stake issue the entry token). entryTokens/consumePaidEntry
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
  const { lobbyType, signedTx, walletAddress } = req.body || {};
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
    const entryToken = crypto.randomUUID();
    entryTokens.set(entryToken, { lobbyType, worth, walletAddress: walletAddress || payer, exp: Date.now() + ENTRY_TOKEN_MAX_AGE_MS });
    res.json({ ok: true, entryToken, worth, worthSol: worth }); // worthSol kept for current client back-compat
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

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

// ─── Region / ping ────────────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, region: REGION, ts: Date.now() });
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

app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, '../public')));
app.use('/shared', express.static(path.join(__dirname, '../shared')));

// ─── Game rooms (one per region + lobby type) ────────────────────────────────
const REGIONS = ['na', 'eu'];
const gameRooms = {};
const agarRooms = {};
for (const rgn of REGIONS) {
  gameRooms[rgn] = {
    free:   new GameRoom(io, `${rgn}_free`),
    dime:   new GameRoom(io, `${rgn}_dime`),
    dollar: new GameRoom(io, `${rgn}_dollar`),
  };
  agarRooms[rgn] = {
    free:   new AgarRoom(io, `agar_${rgn}_free`),
    dime:   new AgarRoom(io, `agar_${rgn}_dime`),
    dollar: new AgarRoom(io, `agar_${rgn}_dollar`),
  };
  Object.values(gameRooms[rgn]).forEach(r => r.start());
  Object.values(agarRooms[rgn]).forEach(r => r.start());
}

function getRoomForType(lobbyType, region) {
  const rgn = (region && gameRooms[region]) ? region : 'na';
  return gameRooms[rgn][lobbyType] || gameRooms[rgn].free;
}

function getAgarRoomForType(lobbyType, region) {
  const rgn = (region && agarRooms[region]) ? region : 'na';
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
  for (const rgn of REGIONS) {
    for (const lt of Object.keys(gameRooms[rgn] || {})) {
      const room = gameRooms[rgn][lt];
      for (const [sid, snake] of room.snakes) {
        if (!snake || !snake.alive) continue;
        const p = room.players.get(sid);
        if (p && p.socket && p.socket._walletAddress) total += snake.worth || 0;
      }
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
setInterval(checkSolvency, 60000).unref?.();
checkSolvency();

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
if (REGION === 'na') setInterval(drainPayouts, 30000).unref?.();

// How long to keep a disconnected player's snake gliding before giving up on a
// reconnect. Covers a typical mobile network blip without leaving dead snakes around.
const RECONNECT_GRACE_MS = 8000;

function totalInGame() {
  return REGIONS.reduce((t, rgn) =>
    t + Object.values(gameRooms[rgn]).reduce((s, r) => s + r.playerCount + r.botCount, 0), 0);
}

function totalAgarInGame() {
  return REGIONS.reduce((t, rgn) =>
    t + Object.values(agarRooms[rgn]).reduce((s, r) => s + r.playerCount + r.botCount, 0), 0);
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

  socket.on(C.EVENTS.PLAY, ({ name, walletAddress, googleId, color, lobbyType, entryToken, hatId, boostId, region, reconnectKey } = {}) => {
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
    const room = getRoomForType(lobbyType, region || REGION);

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

    // Never trust the client's entrySol — take the snake's cash worth from a
    // server-verified paid-entry token (0 for free lobbies).
    const shortType = (lobbyType in LOBBY_FEES) ? lobbyType : 'free';
    const entry = consumePaidEntry(entryToken, shortType);
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
    console.log(`[>] ${playerName} joins ${lobbyType || 'free'} lobby (worth: ${entry.worth} ${money.unit})`);
    room.addPlayer(socket, playerName, walletAddress || null, color || null, entry.worth, hatId || 'none', boostId || 'default');
    lobbyConnections.delete(socket);
    broadcastLobbyState();
  });

  socket.on('cashout:start', () => {
    if (socket._room) {
      socket.to(socket._room.socketRoomName).emit('cashout:started', { id: socket.id });
      socket.emit('cashout:started', { id: socket.id }); // echo to self for own ring
    }
  });

  socket.on('cashout:cancel', () => {
    if (socket._room) {
      socket.to(socket._room.socketRoomName).emit('cashout:cancelled', { id: socket.id });
      socket.emit('cashout:cancelled', { id: socket.id });
    }
  });

  socket.on('cashout', async () => {
    if (!socketRL(socket, 'cashout', 5000)) return;
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

    // Self-custody (Phase 2): the escrow sends the player's 90% back to their own wallet
    // on-chain; the 10% house cut simply stays in the escrow. No custodial ledger involved.
    if (socket._walletAddress) {
      socket.emit('cashout:result', { newBalance: null, earnedSol: playerShare, score: Math.floor(snake.score), length: snake.length, toWallet: true });
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
  });

  socket.on(C.EVENTS.INPUT, ({ angle, boost, speedMult }) => {
    if (typeof angle !== 'number') return;
    if (socket._room) socket._room.handleInput(socket.id, angle, !!boost, speedMult);
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

  socket.on('spectate:join', ({ lobbyType, region } = {}) => {
    const room = getRoomForType(lobbyType || 'free', region || REGION);
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
    // Server-verified worth from the echoed entry token — the client's entrySol is ignored.
    const shortType = socket._room.lobbyType.replace(/^(na|eu)_/, '');
    const entry = consumePaidEntry(entryToken, shortType);
    if (!entry.ok) {
      socket.emit(C.EVENTS.ERROR, { message: 'Entry fee not verified. Please return to the lobby and try again.' });
      return;
    }
    if (entry.googleId) socket._googleId = entry.googleId;
    if (entry.walletAddress) socket._walletAddress = entry.walletAddress;
    socket._room.respawnPlayer(socket.id, entry.worth);
  });

  socket.on('ping_check', () => socket.emit('pong_check'));

  socket.on('admin:spawnbot', async ({ count, idToken } = {}) => {
    if (!(await isOwnerToken(idToken))) return;
    const n = Math.min(Math.max(1, parseInt(count) || 1), 10);
    const room = socket._room || gameRooms['na']['free'];

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
    const entry = consumePaidEntry(entryToken, shortType);
    if (!entry.ok) {
      socket.emit('cell:join:error', { message: 'Entry fee not verified. Please return to lobby.' });
      return;
    }
    if (entry.googleId) { socket._googleId = entry.googleId; lobbySocketsByGoogleId.set(entry.googleId, socket); }
    if (entry.walletAddress) socket._walletAddress = entry.walletAddress; // self-custody cash-out target
    const entryWorth = entry.worth; // worth from the verified stake token (native unit), same as the snake game

    room.addPlayer(socket, sanitizeName(name), color, entryWorth, socket._googleId || null);
    lobbyConnections.delete(socket);
    broadcastLobbyState();
  });

  socket.on('cell:spawnbot', async ({ idToken } = {}) => {
    if (!(await isOwnerToken(idToken))) return;
    const room = socket._agarRoom || agarRooms['na']['free'];

    // Determine lobby type from room name (e.g. 'agar_dime' → 'dime')
    const lobbyType = room.roomName.replace('agar_', '');
    const feeAmt = money.feeFor(lobbyType);

    if (feeAmt > 0) {
      try {
        await db.recordWithdrawal(OWNER_WALLET, null, feeAmt, 'paid_agar_bot_entry');
        room.addPaidBot(feeAmt);
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

  socket.on('cell:split', () => {
    if (!socketRL(socket, 'split', 100)) return;
    if (socket._agarRoom) socket._agarRoom.handleSplit(socket.id);
  });

  socket.on('cell:respawn', ({ entryToken } = {}) => {
    const room = socket._agarRoom;
    if (!room) return;
    // Paid respawns re-stake (same one-time token the snake game uses); free respawns carry none.
    const shortType = socket._agarShortType || 'free';
    const entry = consumePaidEntry(entryToken, shortType);
    if (!entry.ok) {
      socket.emit('cell:join:error', { message: 'Entry fee not verified. Please return to lobby.' });
      return;
    }
    if (entry.walletAddress) socket._walletAddress = entry.walletAddress;
    room.respawnPlayer(socket.id, entry.worth);
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
