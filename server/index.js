require('dotenv').config({ override: true });
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const session    = require('express-session');
const passport   = require('passport');
const cookieParser = require('cookie-parser');
const pgSession = require('connect-pg-simple')(session);
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { rateLimit } = require('express-rate-limit');
const C        = require('../shared/constants');
const GameRoom = require('./GameRoom');
const AgarRoom      = require('./AgarRoom');
const agarLb        = require('./agarLeaderboard');
const db     = require('./db');
const collusion = require('./CollusionMonitor');
const Wallet = require('./Wallet');
const allTimeLb = require('./leaderboard');
const { sendVerificationCode } = require('./Email');
const prices = require('./prices');

const REGION = process.env.REGION || 'na';

// ─── Privy server wallets ─────────────────────────────────────────────────────
const PRIVY_APP_ID     = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;

async function createPrivyWallet() {
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) throw new Error('Privy credentials not set');
  const creds = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString('base64');
  const res = await fetch('https://api.privy.io/v1/wallets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'privy-app-id': PRIVY_APP_ID,
      'Authorization': `Basic ${creds}`,
    },
    body: JSON.stringify({ chain_type: 'solana' }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Privy ${res.status}: ${err}`);
  }
  const data = await res.json();
  return { walletId: data.id, address: data.address };
}

async function ensurePrivyWallet(account) {
  if (account.privyWalletId) return; // already set up
  try {
    const { walletId, address } = await createPrivyWallet();
    await db.setPrivyWallet(account.googleId, address, walletId);
    account.walletAddress = address;
    account.privyWalletId = walletId;
    console.log(`[PRIVY] Wallet created for ${account.name}: ${address.slice(0,8)}...`);
  } catch (e) {
    console.error('[PRIVY] Wallet creation failed:', e.message);
  }
}

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

// ─── Session & Passport ───────────────────────────────────────────────────────
app.use(cookieParser(process.env.SESSION_SECRET || 'duelseries-dev-secret'));
const sessionMiddleware = session({
  store: new pgSession({
    pool: db.pool,
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || 'duelseries-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    secure: true,
    sameSite: 'lax',
  },
});
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// Auto-login via trusted device cookie for all routes
app.use(async (req, res, next) => {
  if (req.isAuthenticated()) return next();
  const deviceToken = req.cookies.ds_device;
  if (!deviceToken) return next();
  try {
    const googleId = await db.getGoogleIdByDeviceToken(deviceToken);
    if (googleId) {
      const account = await db.getAccountByGoogleId(googleId);
      if (account) {
        await new Promise((resolve, reject) =>
          req.login(account, err => err ? reject(err) : resolve())
        );
        await new Promise((resolve, reject) =>
          req.session.save(err => err ? reject(err) : resolve())
        );
      }
    }
  } catch (e) {
    console.error('[AUTO-LOGIN] Middleware error:', e.message);
  }
  next();
});

// Share session + passport with Socket.io using engine.use() for real req/res
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID     || 'PLACEHOLDER',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'PLACEHOLDER',
  callbackURL:  process.env.GOOGLE_CALLBACK_URL  || 'http://localhost:3000/auth/google/callback',
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const account = await db.getOrCreateAccount({
      googleId: profile.id,
      email:    profile.emails?.[0]?.value || '',
      name:     '',
      avatar:   profile.photos?.[0]?.value || '',
    });
    await ensurePrivyWallet(account);
    done(null, account);
  } catch (e) { done(e); }
}));

passport.serializeUser((user, done) => done(null, user.googleId));
passport.deserializeUser(async (id, done) => {
  try {
    const acc = await db.getAccountByGoogleId(id);
    done(null, acc || false);
  } catch (e) { done(e); }
});

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth' }),
  async (req, res) => {
    try {
      const deviceToken = req.cookies.ds_device;
      console.log(`[2FA] Login attempt for ${req.user.googleId}, cookie: ${deviceToken ? deviceToken.slice(0,8)+'...' : 'NONE'}`);
      const trusted = await db.isDeviceTrusted(req.user.googleId, deviceToken);
      console.log(`[2FA] Device trusted: ${trusted}`);
      if (trusted) return res.redirect('/');

      // Device was previously verified for a different account — skip 2FA, trust this account too
      if (req.cookies.ds_device_verified === 'true') {
        const token = await db.addTrustedDevice(req.user.googleId);
        res.cookie('ds_device', token, {
          httpOnly: true,
          maxAge: 30 * 24 * 60 * 60 * 1000,
          sameSite: 'lax',
          secure: true,
        });
        return res.redirect('/');
      }

      // New device — send 2FA code
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await db.saveVerificationCode(req.user.googleId, code);
      const pendingId = req.user.googleId;
      const emailAddr = req.user.email;
      // Use a signed cookie for pending 2FA — more reliable than session
      // since session state can be lost across OAuth redirects on new devices.
      delete req.session.passport;
      req.user = null;
      res.cookie('ds_2fa_pending', pendingId, {
        signed: true,
        httpOnly: true,
        maxAge: 10 * 60 * 1000, // 10 minutes
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      });
      res.redirect('/verify.html');
      sendVerificationCode(emailAddr, code).catch(e =>
        console.error('[2FA] Email send failed:', e.message)
      );
    } catch (e) {
      console.error('[2FA] Error in callback:', e.message);
      res.redirect('/?error=auth');
    }
  }
);
app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    res.clearCookie('ds_device');
    res.redirect('/');
  });
});
app.get('/auth/me', async (req, res) => {
  if (req.isAuthenticated()) return res.json({ loggedIn: true, account: req.user });
  if (req.signedCookies.ds_2fa_pending || req.session.pendingVerification) return res.json({ loggedIn: false, needsVerification: true });

  // Auto-login via trusted device cookie — no button press needed
  const deviceToken = req.cookies.ds_device;
  console.log(`[AUTO-LOGIN] cookies: ${JSON.stringify(Object.keys(req.cookies))}, ds_device: ${deviceToken ? deviceToken.slice(0,8)+'...' : 'NONE'}`);
  if (deviceToken) {
    try {
      const googleId = await db.getGoogleIdByDeviceToken(deviceToken);
      console.log(`[AUTO-LOGIN] googleId found: ${googleId || 'NONE'}`);
      if (googleId) {
        const account = await db.getAccountByGoogleId(googleId);
        if (account) {
          await new Promise((resolve, reject) =>
            req.login(account, err => err ? reject(err) : resolve())
          );
          await new Promise((resolve, reject) =>
            req.session.save(err => err ? reject(err) : resolve())
          );
          console.log(`[AUTO-LOGIN] Success for ${account.name}`);
          return res.json({ loggedIn: true, account });
        }
      }
    } catch (e) {
      console.error('[AUTO-LOGIN] Error:', e.message);
    }
  }

  res.json({ loggedIn: false });
});

// ─── 2FA verify routes ────────────────────────────────────────────────────────

app.post('/auth/verify', express.json(), async (req, res) => {
  const googleId = req.signedCookies.ds_2fa_pending || req.session.pendingVerification;
  if (!googleId) return res.status(400).json({ error: 'No pending verification' });

  const code = (req.body.code || '').trim();
  const valid = await db.verifyCode(googleId, code);
  if (!valid) return res.status(400).json({ error: 'Invalid or expired code' });

  // Code correct — log user in, issue trusted device cookie
  const account = await db.getAccountByGoogleId(googleId);
  if (!account) return res.status(500).json({ error: 'Account not found' });

  res.clearCookie('ds_2fa_pending');
  req.session.pendingVerification = null;
  const token = await db.addTrustedDevice(googleId);

  res.cookie('ds_device', token, {
    httpOnly: true,
    maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
  });
  // Long-lived device marker — never cleared on logout so switching accounts skips 2FA
  res.cookie('ds_device_verified', 'true', {
    httpOnly: true,
    maxAge:   365 * 24 * 60 * 60 * 1000, // 1 year
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
  });

  await new Promise((resolve, reject) =>
    req.login(account, err => err ? reject(err) : resolve())
  );
  await new Promise((resolve, reject) =>
    req.session.save(err => err ? reject(err) : resolve())
  );

  res.json({ ok: true });
});

app.post('/auth/resend-code', express.json(), async (req, res) => {
  const googleId = req.signedCookies.ds_2fa_pending || req.session.pendingVerification;
  if (!googleId) return res.status(400).json({ error: 'No pending verification' });

  const account = await db.getAccountByGoogleId(googleId);
  if (!account) return res.status(500).json({ error: 'Account not found' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await db.saveVerificationCode(googleId, code);
  await sendVerificationCode(account.email, code);
  res.json({ ok: true });
});

app.use(express.json());

app.post('/auth/update-name', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const name = (req.body.name || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  if (!name || name.length < 3) return res.status(400).json({ error: 'Name must be at least 3 characters' });
  const taken = await db.isNameTaken(name, req.user.googleId);
  if (taken) return res.status(400).json({ error: 'Name already taken' });
  const acc = await db.saveAccount(req.user.googleId, { name });
  req.user.name = acc.name;
  allTimeLb.rename(req.user.googleId, acc.name);
  db.pushNameHistory(req.user.googleId, name).catch(() => {});
  res.json({ account: acc });
});

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

// Server-authorised paid-entry tokens. /wallet/entry-fee records one when a player
// ACTUALLY pays; PLAY / RESPAWN / cell:join verify + consume it and take the snake's
// cash worth from THIS server value — never from the client's claimed entrySol (a
// modified client could otherwise inflate it and mint money on cash-out). Keyed by
// the authenticated Google id so it survives the reconnect/respawn flow; one-time use.
const crypto = require('crypto');
const entryTokens = new Map(); // opaque token -> { lobbyType, worthSol, exp }
const ENTRY_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;
// Sweep expired (paid-but-never-used) tokens so the map stays bounded.
setInterval(() => { const now = Date.now(); for (const [k, v] of entryTokens) if (now > v.exp) entryTokens.delete(k); }, ENTRY_TOKEN_MAX_AGE_MS);

// Verify + consume an opaque paid-entry token the client echoes back from the
// /wallet/entry-fee response. The token is server-generated, unguessable, one-time, and
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

app.post('/wallet/entry-fee', entryFeeLimiter, express.json(), async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { lobbyType } = req.body;
  const feeCad = LOBBY_FEES_CAD[lobbyType] || 0;
  if (feeCad === 0) return res.json({ ok: true, feeSol: 0, balance: req.user.balance });

  const feeSol = prices.cadToSol(feeCad);
  const acc = await db.getAccountByGoogleId(req.user.googleId);
  if (!acc || acc.balance < feeSol) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }
  const newBalance = await db.recordWithdrawal(req.user.googleId, null, feeSol, 'entry_fee');
  req.user.balance = newBalance;
  // Deduct entry fee from net earnings so leaderboard shows true profit/loss
  await db.addEarnings(req.user.googleId, -feeSol, -feeCad);
  // Hand the client a one-time, server-authorised entry token. It echoes this back in
  // PLAY / RESPAWN / cell:join; the server takes the worth from the token, never from the
  // client's claimed entrySol. Unguessable + one-time, so it can't be forged or replayed.
  const entryToken = crypto.randomUUID();
  entryTokens.set(entryToken, { lobbyType, worthSol: feeSol, googleId: req.user.googleId, exp: Date.now() + ENTRY_TOKEN_MAX_AGE_MS });
  res.json({ ok: true, feeSol, balance: newBalance, entryToken });
});

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

app.post('/wallet/provision', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  if (req.user.walletAddress) return res.json({ address: req.user.walletAddress });
  try {
    const { walletId, address } = await createPrivyWallet();
    await db.setPrivyWallet(req.user.googleId, address, walletId);
    req.user.walletAddress = address;
    req.user.privyWalletId = walletId;
    res.json({ address });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/wallet/deposit', walletDepositLimiter, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const userWallet = req.user.walletAddress;
  if (!userWallet) return res.status(202).json({ pending: true });
  try {
    const deposits = await Wallet.findDepositsForAddress(userWallet);
    if (!deposits.length) return res.status(202).json({ pending: true });
    let totalAmount = 0;
    let finalBalance = req.user.balance;
    for (const d of deposits) {
      finalBalance = await db.recordDeposit(req.user.googleId, d.sig, d.amount, d.fromAddress);
      totalAmount += d.amount;
      console.log(`[WALLET] Credited ${d.amount} SOL to ${req.user.name}`);
    }
    req.user.balance = finalBalance;
    res.json({ ok: true, amount: totalAmount, balance: finalBalance });

    // Sweep Privy wallet → escrow after responding so it never delays the user
    if (req.user.privyWalletId && req.user.walletAddress) {
      Wallet.sweepFromPrivyWallet(req.user.walletAddress, req.user.privyWalletId)
        .catch(e => console.error('[PRIVY] Sweep failed:', e.message));
    }
  } catch (e) {
    console.error('[WALLET] Deposit error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.post('/wallet/withdraw', walletWithdrawLimiter, async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { amount, walletAddress } = req.body;
  const MIN_WITHDRAWAL_SOL = 0.01;
  if (!amount || amount < MIN_WITHDRAWAL_SOL) return res.status(400).json({ error: `Minimum withdrawal is ${MIN_WITHDRAWAL_SOL} SOL` });
  if (!walletAddress) return res.status(400).json({ error: 'Wallet address required' });
  const acc = await db.getAccountByGoogleId(req.user.googleId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (acc.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
  // Velocity cap: limit total real SOL withdrawn per rolling 24h per account — a brake
  // on how fast funds can leave if any other hole is ever found. Tune via env.
  const DAILY_WITHDRAWAL_CAP_SOL = Number(process.env.DAILY_WITHDRAWAL_CAP_SOL) || 10;
  const withdrawn24h = await db.getWithdrawnSince(req.user.googleId, Date.now() - 24 * 60 * 60 * 1000);
  if (withdrawn24h + amount > DAILY_WITHDRAWAL_CAP_SOL) {
    return res.status(429).json({ error: `Daily withdrawal limit is ${DAILY_WITHDRAWAL_CAP_SOL} SOL. You've withdrawn ${withdrawn24h.toFixed(3)} SOL in the last 24h.` });
  }
  try {
    // Deduct balance first to prevent double-spend from concurrent requests
    const { balance: pendingBalance, id: withdrawalId } = await db.recordPendingWithdrawal(req.user.googleId, amount, walletAddress);
    let sig;
    try {
      sig = await Wallet.withdraw(walletAddress, amount);
    } catch (txErr) {
      // TX failed — refund the deducted balance
      await db.refundWithdrawal(req.user.googleId, amount);
      console.error('[WALLET] TX failed, balance refunded:', txErr.message);
      return res.status(400).json({ error: txErr.message });
    }
    await db.updateWithdrawalSig(withdrawalId, sig);
    req.user.balance = pendingBalance;
    res.json({ ok: true, signature: sig, balance: pendingBalance });
  } catch (e) {
    console.error('[WALLET] Withdraw error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ─── Admin finance dashboard ──────────────────────────────────────────────────
app.get('/admin/finance', async (req, res) => {
  if (!req.isAuthenticated() || req.user.googleId !== process.env.OWNER_GOOGLE_ID) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const [escrowBalance, summary] = await Promise.all([
      Wallet.getEscrowBalance(),
      db.getFinancialSummary(),
    ]);
    const profit = escrowBalance - summary.totalOwed;
    res.json({
      escrowBalance,
      totalOwed: summary.totalOwed,
      profit,
      playersWithBalance: summary.playersWithBalance,
      totalAccounts: summary.totalAccounts,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin: reset a broken Privy wallet ──────────────────────────────────────
app.post('/admin/reset-wallet', async (req, res) => {
  if (!req.isAuthenticated() || req.user.googleId !== process.env.OWNER_GOOGLE_ID) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const acc = await db.getAccountByEmail(email);
  if (!acc) return res.status(404).json({ error: `No account found for ${email}` });
  await db.clearPrivyWallet(acc.googleId);
  try {
    const { walletId, address } = await createPrivyWallet();
    await db.setPrivyWallet(acc.googleId, address, walletId);
    console.log(`[ADMIN] Reset wallet for ${email}: ${address.slice(0, 8)}...`);
    return res.json({ success: true, email, address, walletId });
  } catch (e) {
    console.error(`[ADMIN] Privy wallet creation failed for ${email}:`, e.message);
    return res.status(500).json({ error: e.message, clearedOldWallet: true });
  }
});

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

// Verify the player's on-chain stake landed in the escrow, then issue the SAME entry
// token PLAY already consumes — now backed by a real self-custody stake instead of a
// custodial ledger debit. The snake's worth becomes the actual amount staked.
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
  if (!req.isAuthenticated() || req.user.googleId !== process.env.OWNER_GOOGLE_ID) {
    return res.status(403).json({ error: 'Forbidden' });
  }
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
  if (!req.isAuthenticated() || req.user.googleId !== process.env.OWNER_GOOGLE_ID) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const diag = await Wallet.getEscrowDiagnostics();
    if (req.user.walletAddress) {
      diag.yourPrivyWallet = req.user.walletAddress;
      diag.yourPrivyWalletBalanceSol = await Wallet.getAddressBalance(req.user.walletAddress);
    }
    res.json(diag);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Owner-only: manually run the Privy->escrow sweep for your own deposit wallet. Both
// recovers stuck deposits (moves them into the escrow so withdrawals can pay out) and
// surfaces the exact Privy error if the auto-sweep on deposit is failing.
app.get('/api/admin/sweep', async (req, res) => {
  if (!req.isAuthenticated() || req.user.googleId !== process.env.OWNER_GOOGLE_ID) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { walletAddress, privyWalletId } = req.user;
  if (!walletAddress) return res.status(400).json({ error: 'No deposit wallet on this account' });
  if (!privyWalletId) {
    return res.status(400).json({
      error: 'Account has a wallet address but no privyWalletId — the sweep in /wallet/deposit can never fire. This is the root cause.',
      walletAddress,
    });
  }
  try {
    const sig = await Wallet.sweepFromPrivyWallet(walletAddress, privyWalletId);
    res.json({ ok: true, sweptFrom: walletAddress, sig: sig || null });
  } catch (e) {
    res.status(500).json({ error: e.message, walletAddress });
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

app.get('/api/agar-earningsboard', async (req, res) => {
  try {
    const top = await db.getAgarTopEarners(10);
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
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  try {
    const profile = await db.getMyProfile(req.user.googleId);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
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
    const owner = process.env.OWNER_GOOGLE_ID;
    if (!owner) return;
    const s = lobbySocketsByGoogleId.get(owner);
    if (s) s.emit('admin:collusion_flag', flag);
  },
});

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
    // Always prefer the server-verified session ID over the client-supplied one
    const verifiedId = socket.request.user?.googleId || googleId || null;
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

    let newBalance = null;
    if (worth > 0 && socket._googleId) {
      try {
        // Credit player their 90%
        newBalance = await db.recordDeposit(socket._googleId, 'cashout_' + Date.now() + '_' + socket.id, playerShare, 'cashout');
        const playerShareCad = playerShare * prices.getSolCadRate();
        await db.addEarnings(socket._googleId, playerShare, playerShareCad);
        console.log(`[CASHOUT] ${snake.name} cashed out ${playerShare.toFixed(6)} SOL (owner cut: ${ownerShare.toFixed(6)} SOL)`);
      } catch (e) {
        console.error(`[CASHOUT] CRITICAL: DB credit failed for ${snake.name} — lost ${playerShare.toFixed(6)} SOL. Error: ${e.message}`);
        socket.emit('cashout:error', { message: 'Balance credit failed. Please contact support immediately.' });
        return;
      }
      // Credit 10% to owner's in-game balance (free, no transaction fee)
      const ownerGoogleId = process.env.OWNER_GOOGLE_ID;
      if (ownerGoogleId && ownerShare > 0) {
        db.recordDeposit(ownerGoogleId, 'owner_cut_' + Date.now() + '_' + socket.id, ownerShare, 'house_cut')
          .catch(e => console.error('[CASHOUT] Owner cut credit failed:', e.message));
      }
    }
    socket.emit('cashout:result', { newBalance, earnedSol: playerShare, score: Math.floor(snake.score), length: snake.length });
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
    socket._room.respawnPlayer(socket.id, entry.worthSol);
  });

  socket.on('ping_check', () => socket.emit('pong_check'));

  socket.on('admin:spawnbot', async ({ count } = {}) => {
    const ownerGoogleId = process.env.OWNER_GOOGLE_ID;
    const verifiedGoogleId = socket.request.user?.googleId || socket._googleId;
    if (!ownerGoogleId || verifiedGoogleId !== ownerGoogleId) return;
    const n = Math.min(Math.max(1, parseInt(count) || 1), 10);
    const room = socket._room || gameRooms['na']['free'];

    const shortType = room.lobbyType.replace(/^(na|eu)_/, '');
    if (shortType === 'free') {
      for (let i = 0; i < n; i++) room.addBot();
      socket.emit('admin:ack', { message: `Spawned ${n} free bot(s)` });
      broadcastLobbyState();
      return;
    }

    // Paid lobby — deduct entry fee from owner wallet per bot
    const feeCad = LOBBY_FEES_CAD[shortType] || 0;
    const feeSol = prices.cadToSol(feeCad);
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      try {
        const acc = await db.getAccountByGoogleId(ownerGoogleId);
        if (!acc || acc.balance < feeSol) {
          socket.emit('admin:ack', { message: `Spawned ${spawned}/${n} — insufficient balance` });
          return;
        }
        await db.recordWithdrawal(ownerGoogleId, null, feeSol, 'paid_bot_entry');
        room.addPaidBot(feeSol);
        spawned++;
      } catch (e) {
        console.error('[BOT] Paid bot fee failed:', e.message);
        break;
      }
    }
    socket.emit('admin:ack', { message: `Spawned ${spawned} paid bot(s) worth ${feeCad * spawned}¢` });
    broadcastLobbyState();
  });

  // ── Agar events ──────────────────────────────────────────────────────────
  socket.on('cell:join', ({ name, color, lobbyType, googleId, region, entryToken } = {}) => {
    // Always prefer the server-verified session ID over the client-supplied one
    const verifiedId = socket.request.user?.googleId || googleId || null;
    if (verifiedId) {
      socket._googleId = verifiedId;
      lobbySocketsByGoogleId.set(verifiedId, socket);
    }
    const room = getAgarRoomForType(lobbyType, region || REGION);
    socket._agarRoom = room;
    // Verify the entry fee server-side (same one-time token the snake game uses) and
    // take the cell's worth from the server, never from the client.
    const shortType = (lobbyType in LOBBY_FEES_CAD) ? lobbyType : 'free';
    const entry = consumePaidEntry(entryToken, shortType);
    if (!entry.ok) {
      socket.emit('cell:join:error', { message: 'Entry fee not verified. Please return to lobby.' });
      return;
    }
    if (entry.googleId) { socket._googleId = entry.googleId; lobbySocketsByGoogleId.set(entry.googleId, socket); }
    const entryWorth = LOBBY_FEES_CAD[shortType] || 0; // agar worth is the CAD fee

    room.addPlayer(socket, name, color, entryWorth, socket._googleId || null);
    lobbyConnections.delete(socket);
    broadcastLobbyState();
  });

  socket.on('cell:spawnbot', async () => {
    const ownerGoogleId = process.env.OWNER_GOOGLE_ID;
    const verifiedGoogleId = socket.request.user?.googleId || socket._googleId;
    if (!ownerGoogleId || verifiedGoogleId !== ownerGoogleId) return;
    const room = socket._agarRoom || agarRooms['na']['free'];

    // Determine lobby type from room name (e.g. 'agar_dime' → 'dime')
    const lobbyType = room.roomName.replace('agar_', '');
    const feeCad = LOBBY_FEES_CAD[lobbyType] || 0;

    if (feeCad > 0) {
      const feeSol = prices.cadToSol(feeCad);
      try {
        const acc = await db.getAccountByGoogleId(ownerGoogleId);
        if (!acc || acc.balance < feeSol) {
          socket.emit('admin:ack', { message: 'Insufficient balance for paid bot' });
          return;
        }
        await db.recordWithdrawal(ownerGoogleId, null, feeSol, 'paid_agar_bot_entry');
        room.addPaidBot(feeCad);
        broadcastLobbyState();
      } catch (e) {
        console.error('[AGAR BOT] Paid bot fee failed:', e.message);
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

  socket.on('cell:respawn', () => {
    if (socket._agarRoom) socket._agarRoom.respawnPlayer(socket.id);
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

    let newBalance = null;
    if (worthCad > 0 && socket._googleId) {
      try {
        const playerShareSol = prices.cadToSol(playerShare);
        const ownerShareSol  = prices.cadToSol(ownerShare);
        newBalance = await db.recordDeposit(socket._googleId, 'agar_cashout_' + Date.now() + '_' + socket.id, playerShareSol, 'cashout');
        // Net profit = cashout received minus entry fee paid
        const entryFee      = player.entryFee || 0;
        const netCad        = playerShare - entryFee;
        const netSol        = prices.cadToSol(netCad);
        await db.addAgarEarnings(socket._googleId, netSol, netCad);
        await db.addEarnings(socket._googleId, netSol, netCad);
        console.log(`[AGAR CASHOUT] ${player.name} cashed out $${playerShare.toFixed(2)} CAD (net $${netCad.toFixed(3)})`);
        const ownerGoogleId = process.env.OWNER_GOOGLE_ID;
        if (ownerGoogleId && ownerShareSol > 0) {
          db.recordDeposit(ownerGoogleId, 'agar_owner_cut_' + Date.now() + '_' + socket.id, ownerShareSol, 'house_cut')
            .catch(e => console.error('[AGAR CASHOUT] Owner cut failed:', e.message));
        }
      } catch (e) {
        console.error(`[AGAR CASHOUT] DB credit failed for ${player.name}:`, e.message);
        socket.emit('cell:cashout:error', { message: 'Balance credit failed. Contact support.' });
        return;
      }
    }
    socket.emit('cell:cashout:result', { newBalance, earnedCad: playerShare, score: player.score });
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
