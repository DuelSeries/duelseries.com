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
const io     = new Server(server, {
  cors: {
    origin: ['https://duelseries.com', 'https://www.duelseries.com', 'https://eu.duelseries.com', 'http://localhost:3000'],
    credentials: true,
  },
  pingInterval: 5000,   // heartbeat every 5s (default 25s) — keeps mobile WiFi radio awake
  pingTimeout:  10000,  // declare dead after 10s of no response (default 20s)
});

// Prevent Render 502s — match their load balancer keep-alive timeout
server.keepAliveTimeout = 120000;
server.headersTimeout   = 121000;

app.set('trust proxy', 1); // Render runs behind a proxy

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

// ─── Cross-region stats: EU pushes to NA instantly on every change ────────────
let remoteStats = { playerCount: 0, agarPlayerCount: 0 };
const STATS_SECRET = process.env.SESSION_SECRET || 'duelseries-dev-secret';

// Both servers expose their local counts (used by EU to self-report)
app.get('/api/stats', (req, res) => {
  res.json({ playerCount: totalInGame(), agarPlayerCount: totalAgarInGame() });
});

// NA server receives pushed stats from EU
if (REGION === 'na') {
  app.post('/api/stats/push', express.json(), (req, res) => {
    if (req.headers['x-stats-secret'] !== STATS_SECRET) return res.sendStatus(403);
    remoteStats = { playerCount: req.body.playerCount || 0, agarPlayerCount: req.body.agarPlayerCount || 0 };
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
      body: JSON.stringify({ playerCount: totalInGame(), agarPlayerCount: totalAgarInGame() }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

// ─── HTTP rate limiters ───────────────────────────────────────────────────────
const walletDepositLimiter = rateLimit({ windowMs: 5 * 1000, max: 1, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many deposit checks. Wait 5 seconds.' } });
const walletWithdrawLimiter = rateLimit({ windowMs: 10 * 1000, max: 3, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many withdrawals. Please wait.' } });
const entryFeeLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down.' } });

// ─── Entry fee ────────────────────────────────────────────────────────────────
const LOBBY_FEES_CAD = { free: 0, dime: 0.10, dollar: 1.00 };

// Server-authorised paid-entry tokens. /api/submit-stake mints one after verifying the
// player's on-chain stake landed in the escrow; PLAY / RESPAWN / cell:join verify + consume
// it and take the snake's cash worth from THIS server value — never from the client's
// claimed entrySol (a modified client could otherwise inflate it and mint money on
// cash-out). One-time use; carries the staker's wallet for the on-chain cash-out.
const crypto = require('crypto');
const entryTokens = new Map(); // opaque token -> { lobbyType, worthSol, exp }
const ENTRY_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;
// Sweep expired (paid-but-never-used) tokens so the map stays bounded.
setInterval(() => { const now = Date.now(); for (const [k, v] of entryTokens) if (now > v.exp) entryTokens.delete(k); }, ENTRY_TOKEN_MAX_AGE_MS);

// Verify + consume an opaque paid-entry token the client echoes back from the
// /api/submit-stake response. The token is server-generated, unguessable, one-time, and
// carries the SERVER-recorded worth, so the client can neither forge it nor inflate the
// worth — that's what closes the entrySol escrow-drain hole. Needs no socket auth (the
// socket session is empty) and works for join + respawn identically.
function consumePaidEntry(entryToken, shortType) {
  if (!(shortType in LOBBY_FEES_CAD)) shortType = 'free';
  if (shortType === 'free') return { ok: true, worthSol: 0 }; // free lobbies carry no worth
  const t = entryToken && entryTokens.get(entryToken);
  if (!t || t.lobbyType !== shortType || Date.now() > t.exp) return { ok: false, worthSol: 0 };
  entryTokens.delete(entryToken); // one-time use
  return { ok: true, worthSol: t.worthSol, googleId: t.googleId, walletAddress: t.walletAddress };
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
    const escrowBalance = await Wallet.getEscrowBalance();
    // Self-custody: the escrow only owes the stakes currently live in-game (players hold
    // their own funds otherwise). The old `accounts.balance` sum is vestigial custodial
    // data and would show a phantom liability / false "underfunded" warning, so ignore it.
    const totalOwed = sumLiveSelfCustodyStakes();
    const profit = escrowBalance - totalOwed;
    res.json({ escrowBalance, totalOwed, profit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// (Phase 4d: /admin/reset-wallet removed along with the custodial server-wallet system.)

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/healthz', (req, res) => res.sendStatus(200));

// On-chain SOL balance for any address (public; reads via the server's Solana RPC so the
// browser never hits a rate-limited public RPC). Used by the self-custody wallet widget.
app.get('/api/sol-balance', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'address required' });
  try {
    const sol = await Wallet.getAddressBalance(address);
    res.json({ address, sol });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Browser → server Solana RPC proxy: the frontend's wallet SDK makes its RPC calls here
// so they go through our server's RPC instead of a public endpoint that blocks browser
// origins (403). Same-origin, so no CORS.
app.post('/api/rpc', async (req, res) => {
  try {
    res.type('application/json').send(await Wallet.forwardRpc(req.body));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Latest blockhash for the wallet to build a transfer (self-custody Cash Out / generic send).
app.get('/api/blockhash', async (req, res) => {
  try {
    const { blockhash } = await Wallet.getLatestBlockhash();
    res.json({ blockhash });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Broadcast a user-signed transaction (e.g. a self-custody Cash Out: wallet → external wallet).
// The tx is already signed by the player's own wallet; we just relay it + confirm over HTTP.
app.post('/api/broadcast', express.json({ limit: '256kb' }), async (req, res) => {
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
app.get('/api/stake-quote', async (req, res) => {
  const lobbyType = req.query.lobbyType;
  const feeCad = LOBBY_FEES_CAD[lobbyType];
  if (feeCad === undefined) return res.status(400).json({ error: 'Unknown lobby' });
  if (feeCad === 0) return res.json({ lobbyType, escrowAddress: null, lamports: 0, feeSol: 0 });
  try {
    const feeSol = prices.cadToSol(feeCad);
    const { blockhash } = await Wallet.getLatestBlockhash();
    res.json({ lobbyType, escrowAddress: Wallet.getEscrowPublicKey(), lamports: Math.round(feeSol * 1e9), feeSol, blockhash });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Submit a client-SIGNED stake (Privy signs only; we send + confirm over HTTP), then
// issue the entry token. This avoids the browser WebSocket the public RPC blocks.
app.post('/api/submit-stake', express.json({ limit: '256kb' }), async (req, res) => {
  const { lobbyType, signedTx, walletAddress } = req.body || {};
  const feeCad = LOBBY_FEES_CAD[lobbyType];
  if (feeCad === undefined || feeCad === 0) return res.status(400).json({ error: 'Not a paid lobby' });
  if (!signedTx) return res.status(400).json({ error: 'Missing signed transaction' });
  try {
    const sig = await Wallet.submitStake(Buffer.from(signedTx, 'base64'));
    if (await db.isStakeSigUsed(sig)) return res.status(400).json({ error: 'Stake already used' });
    const feeSol = prices.cadToSol(feeCad);
    const minLamports = Math.round(feeSol * 1e9 * 0.95);
    const { payer, lamports } = await Wallet.verifyStakeTransfer(sig, minLamports);
    await db.markStakeSig(sig);
    const worthSol = lamports / 1e9;
    const entryToken = crypto.randomUUID();
    entryTokens.set(entryToken, { lobbyType, worthSol, walletAddress: walletAddress || payer, exp: Date.now() + ENTRY_TOKEN_MAX_AGE_MS });
    res.json({ ok: true, entryToken, worthSol });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Verify a stake the CLIENT already sent (legacy path; kept for the signAndSend flow).
app.post('/api/verify-stake', express.json(), async (req, res) => {
  const { lobbyType, signature, walletAddress } = req.body || {};
  const feeCad = LOBBY_FEES_CAD[lobbyType];
  if (feeCad === undefined || feeCad === 0) return res.status(400).json({ error: 'Not a paid lobby' });
  try {
    if (await db.isStakeSigUsed(signature)) return res.status(400).json({ error: 'Stake already used' });
    const feeSol = prices.cadToSol(feeCad);
    const minLamports = Math.round(feeSol * 1e9 * 0.95); // tolerate small price drift since the quote
    const { payer, lamports } = await Wallet.verifyStakeTransfer(signature, minLamports);
    await db.markStakeSig(signature);
    const worthSol = lamports / 1e9; // actual staked amount becomes the snake's worth
    const entryToken = crypto.randomUUID();
    entryTokens.set(entryToken, { lobbyType, worthSol, walletAddress: walletAddress || payer, exp: Date.now() + ENTRY_TOKEN_MAX_AGE_MS });
    res.json({ ok: true, entryToken, worthSol });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

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

app.get('/api/stats/winnings', async (req, res) => {
  try {
    const totalCad = await db.getGlobalWinnings();
    res.json({ totalCad: totalCad + 294 });
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
        if (p && p.alive && p.worth > 0) total += prices.cadToSol(p.worth);
      }
    }
  }
  return total;
}
async function checkSolvency() {
  try {
    const escrow = await Wallet.getEscrowBalance();
    const liveStakes = sumLiveSelfCustodyStakes();
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
    const playerName = (name || 'Player').slice(0, 20);
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
    const shortType = (lobbyType in LOBBY_FEES_CAD) ? lobbyType : 'free';
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
    console.log(`[>] ${playerName} joins ${lobbyType || 'free'} lobby (worth: ${entry.worthSol} SOL)`);
    room.addPlayer(socket, playerName, walletAddress || null, color || null, entry.worthSol, hatId || 'none', boostId || 'default');
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
        db.recordEarnings(socket._walletAddress, snake.name, playerShare, playerShare * prices.getSolCadRate()).catch(() => {});
        Wallet.withdraw(socket._walletAddress, playerShare)
          .then((sig) => {
            console.log(`[CASHOUT] self-custody ${playerShare.toFixed(6)} SOL → ${socket._walletAddress.slice(0, 8)}… sig ${String(sig).slice(0, 12)}`);
            socket.emit('cashout:paid', { sol: playerShare, sig });
          })
          .catch((e) => {
            console.error(`[CASHOUT] CRITICAL: self-custody payout failed for ${socket._walletAddress} — owed ${playerShare.toFixed(6)} SOL: ${e.message}`);
            socket.emit('cashout:error', { message: 'Payout to your wallet failed — contact support.' });
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
    socket._room.respawnPlayer(socket.id, entry.worthSol);
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
    const feeCad = LOBBY_FEES_CAD[shortType] || 0;
    const feeSol = prices.cadToSol(feeCad);
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      try {
        await db.recordWithdrawal(OWNER_WALLET, null, feeSol, 'paid_bot_entry');
        room.addPaidBot(feeSol);
        spawned++;
      } catch (e) {
        console.error('[BOT] Paid bot spawn failed:', e.message);
        break;
      }
    }
    socket.emit('admin:ack', { message: `Spawned ${spawned} paid bot(s) worth ${feeCad * spawned}¢` });
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
    const shortType = (lobbyType in LOBBY_FEES_CAD) ? lobbyType : 'free';
    socket._agarShortType = shortType; // remembered for the in-game re-stake on respawn
    const entry = consumePaidEntry(entryToken, shortType);
    if (!entry.ok) {
      socket.emit('cell:join:error', { message: 'Entry fee not verified. Please return to lobby.' });
      return;
    }
    if (entry.googleId) { socket._googleId = entry.googleId; lobbySocketsByGoogleId.set(entry.googleId, socket); }
    if (entry.walletAddress) socket._walletAddress = entry.walletAddress; // self-custody cash-out target
    const entryWorth = LOBBY_FEES_CAD[shortType] || 0; // agar worth is the CAD fee

    room.addPlayer(socket, name, color, entryWorth, socket._googleId || null);
    lobbyConnections.delete(socket);
    broadcastLobbyState();
  });

  socket.on('cell:spawnbot', async ({ idToken } = {}) => {
    if (!(await isOwnerToken(idToken))) return;
    const room = socket._agarRoom || agarRooms['na']['free'];

    // Determine lobby type from room name (e.g. 'agar_dime' → 'dime')
    const lobbyType = room.roomName.replace('agar_', '');
    const feeCad = LOBBY_FEES_CAD[lobbyType] || 0;

    if (feeCad > 0) {
      const feeSol = prices.cadToSol(feeCad);
      try {
        await db.recordWithdrawal(OWNER_WALLET, null, feeSol, 'paid_agar_bot_entry');
        room.addPaidBot(feeCad);
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
    room.respawnPlayer(socket.id, LOBBY_FEES_CAD[shortType] || 0);
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

    const worthCad   = player.worth || 0;
    agarLb.record(socket._googleId || player.name, player.name, player.score);
    room.cashoutPlayer(socket.id); // kills player, clears cells

    const HOUSE_CUT    = 0.10;
    const ownerShare   = worthCad * HOUSE_CUT;
    const playerShare  = worthCad - ownerShare;

    // Self-custody: escrow sends the player's 90% (converted CAD→SOL) back to their own
    // wallet on-chain; the 10% house cut stays in the escrow. No custodial ledger involved.
    if (socket._walletAddress) {
      const playerShareSol = prices.cadToSol(playerShare);
      socket.emit('cell:cashout:result', { newBalance: null, earnedCad: playerShare, earnedSol: playerShareSol, score: player.score, toWallet: true });
      if (worthCad > 0) {
        // Both games feed ONE combined top-earners board (the shared total_earnings column).
        db.recordEarnings(socket._walletAddress, player.name, playerShareSol, playerShare).catch(() => {});
        Wallet.withdraw(socket._walletAddress, playerShareSol)
          .then((sig) => {
            console.log(`[AGAR CASHOUT] self-custody ${playerShareSol.toFixed(6)} SOL → ${socket._walletAddress.slice(0, 8)}… sig ${String(sig).slice(0, 12)}`);
            socket.emit('cell:cashout:paid', { sol: playerShareSol, sig });
          })
          .catch((e) => {
            console.error(`[AGAR CASHOUT] CRITICAL: self-custody payout failed for ${socket._walletAddress} — owed ${playerShareSol.toFixed(6)} SOL: ${e.message}`);
            socket.emit('cell:cashout:error', { message: 'Payout to your wallet failed — contact support.' });
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
