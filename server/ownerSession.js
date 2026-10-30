'use strict';
/* ─── The owner's always-signed-in session (the owner console, "Control") ─────
   Every owner request used to be its own wallet signature: the console signed
   'state' four times a minute and 'owner:alerts' on every socket connect, which
   only works while the Privy login in that browser is alive. This lets ONE
   signature, over the action 'owner:session:create', set an HttpOnly cookie
   that keeps that device signed in for a year (Owen's choice: fixed from sign-in,
   never slid), revocable per device or all at once. The signature path stays as
   it is, as the way to sign in and as a fallback.

   What the cookie is: base64url(JSON {v, w, sid, iat, exp}) '.' base64url(HMAC-SHA256).
   The HMAC only says this server wrote it. The AUTHORITY is the allow-list: a
   cookie is accepted only when its sid is listed (as sha256(sid), so the file
   alone signs nobody in), not revoked, not expired, listed for the same wallet,
   and that wallet is in the owner list RIGHT NOW (isOwner is asked on every
   request, so the owner constant in index.js stays the one source of truth).

   The key is its own: 32 random bytes in server/data/owner-session.key, made on
   first use (OWNER_SESSION_KEY overrides it). Not SESSION_SECRET: that value also
   travels between regions as a raw header. Deleting the key file or the list
   signs every device out.

   Signing in needs more than a valid proof, because the proof mints something
   that lasts a year: a server nonce from GET /api/owner/session/challenge, held
   in a short-lived HttpOnly challenge cookie AND inside the signed args, the
   request's own host inside the signed args, and the exact action name. A proof
   captured anywhere (a log, a hostile script in the lobby asking the silent
   signer) is useless on another machine, because the challenge cookie that
   redeems it lives only in the browser that asked for it.

   Cross-site requests: the cookie is SameSite=Strict and, in production,
   __Host- (so a sibling subdomain such as eu. cannot plant or overwrite it). A
   write must also carry X-DS-Owner: 1 (a cross-origin page cannot send it
   without a preflight our CORS block never allows), an Origin equal to this
   host (or Sec-Fetch-Site same-origin / none), and no body type but JSON. All of
   that is checked here, in check(), so no route can forget it.

   Never logged or pushed: the cookie, the sid, the key, a nonce or a ticket. The
   audit names a device by the last 6 characters of its sid hash. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isOurHost } = require('./securityHeaders');

const SESSION_MS = 365 * 24 * 60 * 60 * 1000;    // one year from sign-in, fixed
const CHALLENGE_MS = 5 * 60 * 1000;               // time to sign the nonce
const TICKET_MS = 60 * 1000;                      // an alerts socket ticket
const MAX_DEVICES = 10;                           // the 11th sign-in signs out the least recently seen
const MAX_RECORDS = 50;                           // live plus recently revoked, so the file stays tiny
const KEEP_REVOKED_MS = 30 * 24 * 60 * 60 * 1000; // a revoked device stays in the file a month, then goes
const SEEN_SAVE_MS = 10 * 60 * 1000;              // lastSeen reaches the file at most this often per device
const MAX_COOKIE = 1024;
const MAX_TICKETS = 200;
const MAX_NONCES = 2000;
const CREATE_ACTION = 'owner:session:create';
const REVOKE_ACTION = 'owner:session:revoke';
const HEADER = 'x-ds-owner';

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => typeof v === 'number' && Number.isFinite(v);

/* "Chrome on Windows". A label for the devices list, never an identity: the user agent is the client's word. */
function uaSummary(ua) {
  const s = typeof ua === 'string' ? ua.slice(0, 512) : '';
  const browser = /Edg(e|A|iOS)?\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /SamsungBrowser/.test(s) ? 'Samsung Internet'
    : /Firefox\/|FxiOS/.test(s) ? 'Firefox'
    : /Chrome\/|CriOS/.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : 'A browser';
  const os = /iPhone/.test(s) ? 'iPhone'
    : /iPad/.test(s) ? 'iPad'
    : /Android/.test(s) ? 'Android'
    : /Windows/.test(s) ? 'Windows'
    : /CrOS/.test(s) ? 'ChromeOS'
    : /Mac OS X|Macintosh/.test(s) ? 'Mac'
    : /Linux/.test(s) ? 'Linux'
    : null;
  return os ? browser + ' on ' + os : browser;
}

// The device name the console signed in with (it is inside the signature), cut to plain text.
function cleanLabel(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[^A-Za-z0-9 .,()'_+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

// Cookie values by name, from a raw Cookie header. Every value a name has, since a dev cookie can be doubled.
function cookieValues(req, name) {
  const raw = req && req.headers && req.headers.cookie;
  if (typeof raw !== 'string' || !raw || raw.length > 8192) return [];
  const out = [];
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const v = part.slice(eq + 1).trim();
    if (v && v.length <= MAX_COOKIE) out.push(v);
  }
  return out;
}

function hostOf(req) {
  const h = req && req.headers && req.headers.host;
  if (typeof h !== 'string' || !h || h.length > 255) return '';
  const low = h.toLowerCase();
  return /^[a-z0-9.\-[\]:]+$/.test(low) ? low : '';
}

/* file           the allow-list (server/data/owner-sessions.json, OWNER_SESSIONS_PATH)
   keyFile        the HMAC key (owner-session.key beside the list unless named)
   key            a key string that replaces the file (OWNER_SESSION_KEY)
   isOwner(w)     the server's owner list, asked on every request
   verifyProof(b) ownerAuth.walletForAction: verifies AND spends a signed owner action, -> wallet | null
   production     cookies are __Host- and Secure; otherwise only on a duelseries.com host
   now, randomBytes, fsx, log: injectable for the tests */
function createOwnerSessions({
  file, keyFile, key = process.env.OWNER_SESSION_KEY, isOwner, verifyProof,
  production = process.env.NODE_ENV === 'production',
  now = () => Date.now(), randomBytes = crypto.randomBytes, fsx = fs, log = console,
} = {}) {
  if (typeof file !== 'string' || !file) throw new Error('ownerSession: file is required');
  if (typeof isOwner !== 'function') throw new Error('ownerSession: isOwner is required');
  if (typeof verifyProof !== 'function') throw new Error('ownerSession: verifyProof is required');
  const keyPath = keyFile || path.join(path.dirname(file), 'owner-session.key');

  /* ── the key ─────────────────────────────────────────────────────────────── */
  let keyBuf;            // undefined: not loaded yet; null: unusable, sign-in is off (fail closed)
  function theKey() {
    if (keyBuf !== undefined) return keyBuf;
    if (typeof key === 'string' && key) {
      keyBuf = crypto.createHmac('sha256', key).update('duelseries owner session v1').digest();
      return keyBuf;
    }
    let text = null;
    try {
      text = fsx.readFileSync(keyPath, 'utf8');
    } catch (e) {
      if (!e || e.code !== 'ENOENT') {
        log.error('[OWNER] CRITICAL the owner session key is unreadable; owner sign-in is OFF until it is fixed or deleted: '
          + (e && e.message));
        keyBuf = null;
        return keyBuf;
      }
    }
    if (text !== null) {
      const hex = String(text).trim();
      if (!/^[0-9a-f]{64}$/i.test(hex)) {
        log.error('[OWNER] CRITICAL the owner session key file is not a key; owner sign-in is OFF until it is deleted ('
          + keyPath + ')');
        keyBuf = null;
        return keyBuf;
      }
      keyBuf = Buffer.from(hex, 'hex');
      return keyBuf;
    }
    // First use: make one. It is written before anything is signed with it, so a restart keeps every device in.
    const fresh = randomBytes(32);
    try {
      fsx.mkdirSync(path.dirname(keyPath), { recursive: true });
      const tmp = keyPath + '.tmp-' + process.pid;
      fsx.writeFileSync(tmp, fresh.toString('hex') + '\n', { mode: 0o600 });
      fsx.renameSync(tmp, keyPath);
      keyBuf = fresh;
    } catch (e) {
      if (production) {
        log.error('[OWNER] CRITICAL the owner session key could not be saved; owner sign-in is OFF: ' + (e && e.message));
        keyBuf = null;
      } else {
        // A dev PC: a key for this process only. A restart just means signing in again.
        log.warn('[OWNER] the owner session key could not be saved; using one for this process only');
        keyBuf = fresh;
      }
    }
    return keyBuf;
  }
  const mac = (kind, body) => crypto.createHmac('sha256', theKey()).update(kind + '|' + body).digest();
  function seal(kind, payload) {
    const body = b64u(JSON.stringify(payload));
    return body + '.' + b64u(mac(kind, body));
  }
  // The payload of a token this server sealed for `kind`, or null. Never throws.
  function unseal(kind, token) {
    try {
      if (typeof token !== 'string' || !token || token.length > MAX_COOKIE || !theKey()) return null;
      const dot = token.indexOf('.');
      if (dot < 1 || dot !== token.lastIndexOf('.')) return null;
      const body = token.slice(0, dot);
      const got = unb64u(token.slice(dot + 1));
      const want = mac(kind, body);
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
      const p = JSON.parse(unb64u(body).toString('utf8'));
      return isPlain(p) ? p : null;
    } catch (_) {
      return null;
    }
  }

  /* ── the allow-list ──────────────────────────────────────────────────────── */
  const records = new Map();   // sidHash -> { sidHash, wallet, device, createdAt, lastSeen, exp, revokedAt }
  const savedSeen = new Map(); // sidHash -> the lastSeen the file holds
  let loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    let text;
    try {
      text = fsx.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return;
      log.error('[OWNER] CRITICAL the owner session list is unreadable; no owner session is accepted until a new'
        + ' sign-in rewrites it: ' + (e && e.message));
      return;
    }
    let list;
    try {
      const j = JSON.parse(text);
      list = j && j.v === 1 && Array.isArray(j.sessions) ? j.sessions : null;
    } catch (_) { list = null; }
    if (!list) {
      log.error('[OWNER] CRITICAL the owner session list is not a session list; no owner session is accepted until a'
        + ' new sign-in rewrites it (' + file + ')');
      return;
    }
    const t = now();
    let dropped = 0;
    for (const r of list) {
      const ok = isPlain(r) && typeof r.sidHash === 'string' && /^[0-9a-f]{64}$/.test(r.sidHash)
        && typeof r.wallet === 'string' && r.wallet.length > 0 && r.wallet.length <= 64
        && num(r.createdAt) && num(r.lastSeen) && num(r.exp) && (r.revokedAt === null || num(r.revokedAt));
      if (!ok) { dropped++; continue; }
      if (!r.revokedAt && !isOwner(r.wallet)) { dropped++; continue; }   // not an owner any more: gone at boot
      const rec = { sidHash: r.sidHash, wallet: r.wallet, device: cleanLabel(r.device) || 'A browser',
                    createdAt: r.createdAt, lastSeen: r.lastSeen, exp: r.exp, revokedAt: r.revokedAt || null };
      if (rec.exp <= t) continue;
      records.set(rec.sidHash, rec);
      savedSeen.set(rec.sidHash, rec.lastSeen);
    }
    if (dropped) log.warn('[OWNER] ' + dropped + ' owner session record(s) dropped at load (malformed or no longer an owner)');
  }
  function prune() {
    const t = now();
    for (const [h, r] of records) {
      if (r.exp <= t || (r.revokedAt && t - r.revokedAt > KEEP_REVOKED_MS)) { records.delete(h); savedSeen.delete(h); }
    }
    if (records.size > MAX_RECORDS) {
      // revoked ones first, oldest first
      const order = [...records.values()].sort((a, b) => (!!b.revokedAt - !!a.revokedAt) || (a.lastSeen - b.lastSeen));
      for (const r of order.slice(0, records.size - MAX_RECORDS)) { records.delete(r.sidHash); savedSeen.delete(r.sidHash); }
    }
  }
  // Atomic: a tmp file then a rename, so a crash mid-write never leaves half a list. -> true when on disk.
  function save() {
    prune();
    const body = JSON.stringify({ v: 1, sessions: [...records.values()] }, null, 1) + '\n';
    const tmp = file + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex');
    try {
      fsx.mkdirSync(path.dirname(file), { recursive: true });
      fsx.writeFileSync(tmp, body, { mode: 0o600 });
      fsx.renameSync(tmp, file);
      for (const r of records.values()) savedSeen.set(r.sidHash, r.lastSeen);
      return true;
    } catch (e) {
      log.error('[OWNER] CRITICAL the owner session list was not saved: ' + (e && e.message));
      try { fsx.unlinkSync(tmp); } catch (_) { /* nothing was written */ }
      return false;
    }
  }
  const live = (r, t = now()) => !!r && !r.revokedAt && r.exp > t && isOwner(r.wallet);
  const view = (r) => ({ wallet: r.wallet, sidHash: r.sidHash, id: r.sidHash.slice(-12), tag: r.sidHash.slice(-6),
                         device: r.device, createdAt: r.createdAt, lastSeen: r.lastSeen, exp: r.exp });

  const revokeListeners = [];
  function onRevoke(fn) { if (typeof fn === 'function') revokeListeners.push(fn); }
  function tellRevoked(hashes) {
    if (!hashes.length) return;
    for (const [t, x] of tickets) if (hashes.includes(x.sidHash)) tickets.delete(t);
    for (const fn of revokeListeners) {
      try { fn(hashes.slice()); } catch (e) { log.error('[OWNER] revoke listener failed: ' + (e && e.message)); }
    }
  }

  /* ── cookies and the cross-site gate ─────────────────────────────────────── */
  const secureFor = (req) => !!production || isOurHost(req) || !!(req && req.secure === true);
  const namesFor = (req) => (secureFor(req)
    ? { session: '__Host-ds_owner', challenge: '__Host-ds_owner_ch' }
    : { session: 'ds_owner', challenge: 'ds_owner_ch' });
  // Secure is decided by production / our host, never by req.secure alone: the live nginx sends no X-Forwarded-Proto.
  function cookie(req, name, value, maxAgeSec) {
    return name + '=' + value + '; Path=/; HttpOnly; SameSite=Strict' + (secureFor(req) ? '; Secure' : '')
      + '; Max-Age=' + Math.max(0, Math.floor(maxAgeSec));
  }
  const clearCookie = (req) => cookie(req, namesFor(req).session, '', 0);
  const clearChallenge = (req) => cookie(req, namesFor(req).challenge, '', 0);

  /* Is this request from our own page? For a read, only "not from another site" (SameSite=Strict already keeps
     the cookie off cross-site requests, and no GET changes anything). For a write: X-DS-Owner: 1, JSON or no body,
     and an Origin equal to this host (or, with no Origin, Sec-Fetch-Site same-origin / none). asRead (ownerDevice
     only) takes any method as a read. */
  function csrfOk(req, asRead) {
    if (!req || !req.headers) return false;
    const h = req.headers;
    const host = hostOf(req);
    const want = (secureFor(req) ? 'https://' : 'http://') + host;
    const site = h['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
    const origin = h.origin;
    const hasOrigin = typeof origin === 'string' && origin !== '';
    if (hasOrigin && (!host || origin.toLowerCase() !== want)) return false;
    const m = String(req.method || 'GET').toUpperCase();
    if (asRead === true || m === 'GET' || m === 'HEAD') return true;
    if (h[HEADER] !== '1') return false;
    const type = h['content-type'];
    if (typeof type === 'string' && type && !/^application\/json\s*(;|$)/i.test(type)) return false;
    if (hasOrigin) return true;
    return site === 'same-origin' || site === 'none';
  }

  /* The session a request carries: { sess, why, hadCookie }. sess is { wallet, sidHash, id, tag, device,
     createdAt, lastSeen, exp } or null; why says which rule refused it ('none', 'csrf', 'nokey', 'forged',
     'expired', 'unlisted', 'revoked', 'wallet', 'not-owner'). Never throws. */
  function check(req) { return checkAs(req, false); }
  function checkAs(req, asRead) {
    try {
      const vals = cookieValues(req, namesFor(req).session);
      if (!vals.length) return { sess: null, why: 'none', hadCookie: false };
      if (!csrfOk(req, asRead)) return { sess: null, why: 'csrf', hadCookie: true };
      if (!theKey()) return { sess: null, why: 'nokey', hadCookie: true };
      load();
      const t = now();
      let why = 'forged';
      for (const v of vals) {
        const p = unseal('session', v);
        if (!p || p.v !== 1 || typeof p.w !== 'string' || typeof p.sid !== 'string' || !/^[0-9a-f]{32}$/.test(p.sid)
          || !num(p.iat) || !num(p.exp)) continue;
        if (p.exp <= t) { why = 'expired'; continue; }
        const r = records.get(sha256(p.sid));
        if (!r) { why = 'unlisted'; continue; }
        if (r.revokedAt) { why = 'revoked'; continue; }
        if (r.exp <= t) { why = 'expired'; continue; }
        if (r.wallet !== p.w) { why = 'wallet'; continue; }
        if (!isOwner(r.wallet)) { why = 'not-owner'; continue; }
        r.lastSeen = t;
        if (t - (savedSeen.get(r.sidHash) || 0) >= SEEN_SAVE_MS) save();
        return { sess: view(r), why: null, hadCookie: true };
      }
      return { sess: null, why, hadCookie: true };
    } catch (e) {
      log.error('[OWNER] session check failed: ' + (e && e.message));
      return { sess: null, why: 'error', hadCookie: true };
    }
  }
  const fromRequest = (req) => check(req).sess;
  /* Is this the owner's own browser? check()'s cookie rules with only the read gate, whatever the method: for a
     POST from our page that carries no X-DS-Owner (the visit beacon) and for a socket's handshake (socket.request).
     It keeps the owner's own visits and joins off his phone (server/visitAlerts.js, server/joinAlerts.js) and
     AUTHORISES NOTHING: a route or socket that acts as the owner uses check() or a ticket, never this. -> boolean.
     Never throws. */
  const ownerDevice = (req) => !!checkAs(req, true).sess;

  /* ── signing in ──────────────────────────────────────────────────────────── */
  // -> { nonce, host, cookie } or null when sign-in is off (no usable key).
  function challenge(req) {
    if (!theKey()) return null;
    const host = hostOf(req);
    if (!host) return null;
    const nonce = randomBytes(16).toString('hex');
    const value = seal('challenge', { v: 1, n: nonce, h: host, exp: now() + CHALLENGE_MS });
    return { nonce, host, cookie: cookie(req, namesFor(req).challenge, value, CHALLENGE_MS / 1000) };
  }
  const usedNonces = new Map();   // nonce -> when its challenge expires
  function spendNonce(n, exp) {
    const t = now();
    for (const [k, e] of usedNonces) if (e <= t) usedNonces.delete(k);
    if (usedNonces.size >= MAX_NONCES) usedNonces.delete(usedNonces.keys().next().value);
    usedNonces.set(n, exp);
  }

  // Signs out the least recently seen live devices until there is room for one more.
  function makeRoom() {
    const t = now();
    const liveOnes = [...records.values()].filter((r) => live(r, t)).sort((a, b) => a.lastSeen - b.lastSeen);
    const out = [];
    while (liveOnes.length - out.length >= MAX_DEVICES) out.push(liveOnes[out.length]);
    for (const r of out) r.revokedAt = t;
    return out;
  }

  /* POST /api/owner/session/login. The order matters: nothing is spent until the action, the host and the
     challenge all match, and the nonce is spent BEFORE the signature is checked, so one challenge can never be
     tried twice. -> { ok, status, error } or { ok: true, sess, cookie }. */
  function login(req) {
    const fail = (status, error) => ({ ok: false, status, error });
    if (!csrfOk(req)) return fail(403, 'Cross-site request refused');
    const body = req.body;
    if (!isPlain(body) || body.action !== CREATE_ACTION || !isPlain(body.args)) return fail(400, 'Not a sign-in proof');
    const args = body.args;
    const host = hostOf(req);
    if (!host || typeof args.host !== 'string' || args.host.toLowerCase() !== host) {
      return fail(403, 'This sign-in was signed for another site');
    }
    if (!theKey()) return fail(503, 'Owner sign-in is off on this server');
    const ch = cookieValues(req, namesFor(req).challenge).map((v) => unseal('challenge', v))
      .find((p) => p && p.v === 1 && typeof p.n === 'string' && num(p.exp)) || null;
    if (!ch || ch.exp <= now() || ch.h !== host) return fail(403, 'No sign-in challenge: ask for a new one');
    if (typeof args.nonce !== 'string' || args.nonce !== ch.n) return fail(403, 'The sign-in does not match its challenge');
    if (usedNonces.has(ch.n)) return fail(403, 'That challenge was already used');
    spendNonce(ch.n, ch.exp);
    let wallet = null;
    try { wallet = verifyProof(body); } catch (_) { wallet = null; }
    if (typeof wallet !== 'string' || !wallet) return fail(403, 'The signature did not verify');
    if (!isOwner(wallet)) return fail(403, 'Not an owner');
    load();
    const t = now();
    const sid = randomBytes(16).toString('hex');
    const rec = { sidHash: sha256(sid), wallet, device: cleanLabel(args.label) || uaSummary(req.headers['user-agent']),
                  createdAt: t, lastSeen: t, exp: t + SESSION_MS, revokedAt: null };
    const evicted = makeRoom();
    records.set(rec.sidHash, rec);
    if (!save()) {
      records.delete(rec.sidHash);
      for (const r of evicted) r.revokedAt = null;
      return fail(503, 'The session could not be saved on the server');
    }
    tellRevoked(evicted.map((r) => r.sidHash));
    const value = seal('session', { v: 1, w: wallet, sid, iat: t, exp: rec.exp });
    return { ok: true, sess: view(rec), cookie: cookie(req, namesFor(req).session, value, SESSION_MS / 1000) };
  }

  /* ── the devices list and revoking ───────────────────────────────────────── */
  function list(current) {
    load();
    const t = now();
    return [...records.values()].filter((r) => live(r, t)).sort((a, b) => b.lastSeen - a.lastSeen)
      .map((r) => ({ id: r.sidHash.slice(-12), device: r.device, createdAt: r.createdAt, lastSeen: r.lastSeen,
                     exp: r.exp, current: !!current && current.sidHash === r.sidHash }));
  }
  /* which: { id } one device, { all: true } every device, { others: true } every device but `current`.
     -> { ok, count, saved, revokedCurrent } or { ok: false, status, error }. */
  function revoke(which, current) {
    load();
    const w = isPlain(which) ? which : {};
    const t = now();
    const liveOnes = [...records.values()].filter((r) => live(r, t));
    let hit;
    if (w.all === true) hit = liveOnes;
    else if (w.others === true) {
      if (!current) return { ok: false, status: 400, error: 'Signing out the other devices needs this one signed in' };
      hit = liveOnes.filter((r) => r.sidHash !== current.sidHash);
    } else if (typeof w.id === 'string' && /^[0-9a-f]{12}$/.test(w.id)) {
      hit = liveOnes.filter((r) => r.sidHash.slice(-12) === w.id);
      if (!hit.length) return { ok: false, status: 404, error: 'No such device' };
    } else return { ok: false, status: 400, error: 'Say which device: id, all or others' };
    for (const r of hit) r.revokedAt = t;
    const saved = hit.length ? save() : true;
    // In memory it is revoked either way. A list that did not save would bring them back at the next restart.
    if (!saved) log.error('[OWNER] CRITICAL revoked owner sessions were not saved; they return after a restart');
    const hashes = hit.map((r) => r.sidHash);
    tellRevoked(hashes);
    return { ok: true, count: hit.length, saved, revokedCurrent: !!current && hashes.includes(current.sidHash) };
  }
  function isLive(sidHash) {
    if (typeof sidHash !== 'string') return false;
    load();
    return live(records.get(sidHash));
  }

  /* ── alert socket tickets ─────────────────────────────────────────────────
     A socket never reads the cookie off its handshake (Engine.IO does not check Origin on a websocket
     upgrade, so a sibling site could ride it). The page asks POST /api/owner/ticket instead and sends the
     ticket in lobby:join: one use, 60 seconds, bound to the session that asked. */
  const tickets = new Map();   // ticket -> { sidHash, wallet, exp }
  function issueTicket(sess) {
    if (!sess || typeof sess.sidHash !== 'string') return null;
    const t = now();
    for (const [k, x] of tickets) if (x.exp <= t) tickets.delete(k);
    while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value);
    const ticket = b64u(randomBytes(24));
    tickets.set(ticket, { sidHash: sess.sidHash, wallet: sess.wallet, exp: t + TICKET_MS });
    return ticket;
  }
  // -> { wallet, session } for a live ticket (spent here, whatever the answer), else null. Never throws.
  function ticketWallet(ticket) {
    if (typeof ticket !== 'string' || !ticket || ticket.length > 64) return null;
    const x = tickets.get(ticket);
    if (!x) return null;
    tickets.delete(ticket);
    if (x.exp <= now() || !isLive(x.sidHash) || !isOwner(x.wallet)) return null;
    return { wallet: x.wallet, session: x.sidHash };
  }

  return {
    check, fromRequest, ownerDevice, csrfOk: (req) => csrfOk(req), challenge, login, list, revoke, isLive, onRevoke,
    issueTicket, ticketWallet, clearCookie, clearChallenge, names: namesFor, verifyProof, isOwner, file, keyFile: keyPath,
  };
}

module.exports = {
  createOwnerSessions, uaSummary, cleanLabel, CREATE_ACTION, REVOKE_ACTION, SESSION_MS, TICKET_MS, CHALLENGE_MS,
  MAX_DEVICES,
};
