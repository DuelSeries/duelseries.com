const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const session    = require('express-session');
const passport   = require('passport');
const cookieParser = require('cookie-parser');
const pgSession = require('connect-pg-simple')(session);
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const C        = require('../shared/constants');
const GameRoom = require('./GameRoom');
const AgarRoom = require('./AgarRoom');
const db     = require('./db');
const Wallet = require('./Wallet');
const allTimeLb = require('./leaderboard');
const { sendVerificationCode } = require('./Email');
const prices = require('./prices');

Wallet.setDb(db);
allTimeLb.setDb(db);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

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
app.use(cookieParser());
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
    secure: true,   // HTTPS only (Render uses HTTPS)
    sameSite: 'lax',
  },
});
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// Share session + passport with Socket.io so admin checks use verified identity
const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
io.use(wrap(sessionMiddleware));
io.use(wrap(passport.initialize()));
io.use(wrap(passport.session()));

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID     || 'PLACEHOLDER',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'PLACEHOLDER',
  callbackURL:  process.env.GOOGLE_CALLBACK_URL  || 'http://localhost:3000/auth/google/callback',
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const account = await db.getOrCreateAccount({
      googleId: profile.id,
      email:    profile.emails?.[0]?.value || '',
      name:     profile.displayName || 'Player',
      avatar:   profile.photos?.[0]?.value || '',
    });
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
      req.logout(() => {
        req.session.pendingVerification = pendingId;
        req.session.save(() => {
          res.redirect('/verify.html');
          sendVerificationCode(emailAddr, code).catch(e =>
            console.error('[2FA] Email send failed:', e.message)
          );
        });
      });
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
  if (req.session.pendingVerification) return res.json({ loggedIn: false, needsVerification: true });

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
  const googleId = req.session.pendingVerification;
  if (!googleId) return res.status(400).json({ error: 'No pending verification' });

  const code = (req.body.code || '').trim();
  const valid = await db.verifyCode(googleId, code);
  if (!valid) return res.status(400).json({ error: 'Invalid or expired code' });

  // Code correct — log user in, issue trusted device cookie
  const account = await db.getAccountByGoogleId(googleId);
  if (!account) return res.status(500).json({ error: 'Account not found' });

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

  res.json({ ok: true });
});

app.post('/auth/resend-code', express.json(), async (req, res) => {
  const googleId = req.session.pendingVerification;
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
  const name = (req.body.name || '').replace(/\s/g, '').slice(0, 20);
  if (!name) return res.status(400).json({ error: 'Invalid name' });
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

// ─── Entry fee ────────────────────────────────────────────────────────────────
const LOBBY_FEES_CAD = { free: 0, dime: 0.10, dollar: 1.00 };

app.post('/wallet/entry-fee', express.json(), async (req, res) => {
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
  res.json({ ok: true, feeSol, balance: newBalance });
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

app.post('/wallet/deposit', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  try {
    const result = await Wallet.findLatestDeposit();
    if (!result) return res.status(202).json({ pending: true });
    const newBalance = await db.recordDeposit(
      req.user.googleId, result.sig, result.amount, result.fromAddress
    );
    req.user.balance = newBalance;
    console.log(`[WALLET] Credited ${result.amount} SOL to ${req.user.name}`);
    res.json({ ok: true, amount: result.amount, balance: newBalance });
  } catch (e) {
    console.error('[WALLET] Deposit error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.post('/wallet/withdraw', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  const { amount, walletAddress } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!walletAddress) return res.status(400).json({ error: 'Wallet address required' });
  const acc = await db.getAccountByGoogleId(req.user.googleId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (acc.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
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

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/healthz', (req, res) => res.sendStatus(200));

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
    res.json({ totalCad });
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

// ─── Game rooms (one per lobby type) ─────────────────────────────────────────
const gameRooms = {
  free:   new GameRoom(io, 'free'),
  dime:   new GameRoom(io, 'dime'),
  dollar: new GameRoom(io, 'dollar'),
};
Object.values(gameRooms).forEach(r => r.start());

// ─── Agar rooms ───────────────────────────────────────────────────────────────
const agarRooms = {
  free:   new AgarRoom(io, 'agar_free'),
  dime:   new AgarRoom(io, 'agar_dime'),
  dollar: new AgarRoom(io, 'agar_dollar'),
};
Object.values(agarRooms).forEach(r => r.start());

function getRoomForType(t) {
  return gameRooms[t] || gameRooms.free;
}

const lobbySocketsByGoogleId = new Map();
const lobbyConnections = new Set();

function totalInGame() {
  return Object.values(gameRooms).reduce((s, r) => s + r.playerCount + r.botCount, 0);
}

function broadcastLobbyState() {
  const state = {
    playerCount: totalInGame(),
    lobbyCount:  lobbyConnections.size,
    leaderboard: allTimeLb.getTop(3),
  };
  for (const sock of lobbyConnections) sock.emit(C.EVENTS.LOBBY_STATE, state);
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  socket.emit(C.EVENTS.LOBBY_STATE, {
    playerCount: totalInGame(),
    lobbyCount:  lobbyConnections.size,
    leaderboard: allTimeLb.getTop(3),
  });

  socket.on('lobby:join', ({ googleId } = {}) => {
    lobbyConnections.add(socket);
    if (googleId) {
      socket._googleId = googleId;
      lobbySocketsByGoogleId.set(googleId, socket);
    }
    broadcastLobbyState();
  });

  socket.on(C.EVENTS.PLAY, ({ name, walletAddress, googleId, color, lobbyType, entrySol, hatId, boostId } = {}) => {
    // Ignore duplicate PLAY events (e.g. from socket reconnect while alive)
    if (socket._room) {
      const existingSnake = socket._room.snakes.get(socket.id);
      if (existingSnake && existingSnake.alive) return;
    }
    const playerName = (name || 'Player').slice(0, 20);
    if (googleId) {
      socket._googleId = googleId;
      lobbySocketsByGoogleId.set(googleId, socket);
    }
    const room = getRoomForType(lobbyType);
    socket._room = room;
    socket._joinTime = Date.now();
    console.log(`[>] ${playerName} joins ${lobbyType || 'free'} lobby (worth: ${entrySol || 0} SOL)`);
    room.addPlayer(socket, playerName, walletAddress || null, color || null, entrySol || 0, hatId || 'none', boostId || 'default');
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

  socket.on(C.EVENTS.RESPAWN, ({ entrySol } = {}) => {
    if (!socket._room) return;
    const existing = socket._room.snakes.get(socket.id);
    if (existing && existing.alive) return; // block respawn while alive
    socket._room.respawnPlayer(socket.id, entrySol || 0);
  });

  socket.on('ping_check', () => socket.emit('pong_check'));

  socket.on('admin:spawnbot', async ({ count } = {}) => {
    const ownerGoogleId = process.env.OWNER_GOOGLE_ID;
    const verifiedGoogleId = socket.request.user?.googleId;
    if (!ownerGoogleId || verifiedGoogleId !== ownerGoogleId) return;
    const n = Math.min(Math.max(1, parseInt(count) || 1), 10);
    const room = socket._room || gameRooms.free;

    if (room.lobbyType === 'free') {
      for (let i = 0; i < n; i++) room.addBot();
      socket.emit('admin:ack', { message: `Spawned ${n} free bot(s)` });
      return;
    }

    // Paid lobby — deduct entry fee from owner wallet per bot
    const LOBBY_FEES_CAD = { dime: 0.10, dollar: 1.00 };
    const feeCad = LOBBY_FEES_CAD[room.lobbyType] || 0;
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
  });

  // ── Agar events ──────────────────────────────────────────────────────────
  socket.on('cell:join', ({ name, color, lobbyType, googleId } = {}) => {
    if (googleId) {
      socket._googleId = googleId;
      lobbySocketsByGoogleId.set(googleId, socket);
    }
    const room = agarRooms[lobbyType] || agarRooms.free;
    socket._agarRoom = room;
    room.addPlayer(socket, name, color);
    lobbyConnections.delete(socket);
    broadcastLobbyState();
  });

  socket.on('cell:spawnbot', () => {
    const ownerGoogleId = process.env.OWNER_GOOGLE_ID;
    const verifiedGoogleId = socket.request.user?.googleId;
    if (!ownerGoogleId || verifiedGoogleId !== ownerGoogleId) return;
    const room = socket._agarRoom || agarRooms.free;
    room.addBot();
  });

  socket.on('cell:input', ({ mouseX, mouseY } = {}) => {
    if (socket._agarRoom) socket._agarRoom.handleInput(socket.id, mouseX, mouseY);
  });

  socket.on('cell:split', () => {
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

  socket.on('cell:cashout', () => {
    if (socket._agarRoom) socket._agarRoom.cashoutPlayer(socket.id);
  });

  socket.on('disconnect', async () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    if (socket._agarRoom) socket._agarRoom.removePlayer(socket.id);
    const room = socket._room;
    if (room) {
      const snake = room.snakes && room.snakes.get(socket.id);
      if (snake && socket._googleId) {
        const duration = socket._joinTime ? Math.round((Date.now() - socket._joinTime) / 1000) : 0;
        await db.recordGameResult(socket._googleId, snake.score, duration).catch(() => {});
      }
      room.removePlayer(socket.id);
    }
    if (socket._googleId) lobbySocketsByGoogleId.delete(socket._googleId);
    lobbyConnections.delete(socket);
    broadcastLobbyState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
