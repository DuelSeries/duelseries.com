'use strict';
/* The owner session's HTTP routes (server/ownerSession.js holds the rules). All JSON, all no-store, and every
   POST must carry X-DS-Owner: 1 (check() and login() refuse one without it):

     GET  /api/owner/session            -> { signedIn: true, device, createdAt, exp } or { signedIn: false }
     GET  /api/owner/session/challenge  -> { nonce, host }, and a 5 minute HttpOnly challenge cookie
     POST /api/owner/session/login      body: the signed proof of 'owner:session:create' over { nonce, host, label }
                                        -> { ok: true, device, exp }, and the session cookie
     GET  /api/owner/sessions           -> { sessions: [{ id, device, createdAt, lastSeen, exp, current }] }
     POST /api/owner/session/revoke     { id } | { all: true } | { others: true } -> { ok: true }
     POST /api/owner/session/logout     -> { ok: true }, the cookie cleared
     POST /api/owner/ticket             -> { ticket }: one use, 60 s, for the alerts socket's lobby:join

   Revoke also takes the old signed proof (action 'owner:session:revoke', args as above), so a device that lost
   its own session can still sign the others out. */
const { rateLimit } = require('express-rate-limit');
const { REVOKE_ACTION } = require('./ownerSession');

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pass = (req, res, next) => next();

/* sessions     createOwnerSessions()
   readLimiter  the limiter the other owner routes share (index.js sigLimiter)
   audit        ownerAuth.audit(action, args, who, ok, note)
   push         notify.pushOwner(text, opts): the phone hears of every new device
   region       'na' / 'eu', for the push */
function mountOwnerSessionRoutes(app, {
  sessions, readLimiter = pass, loginLimiter, challengeLimiter, audit = () => {}, push = () => {}, region = '',
  log = console,
} = {}) {
  if (!sessions) throw new Error('ownerSessionRoutes: sessions is required');
  // About 10 sign-ins per 10 minutes per address: a person needs one, a script grinding challenges gets nowhere.
  const login = loginLimiter || rateLimit({ windowMs: 10 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Wait a few minutes.' } });
  const challenge = challengeLimiter || rateLimit({ windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true,
    legacyHeaders: false, message: { error: 'Too many sign-in attempts. Wait a few minutes.' } });

  /* The server's general no-store middleware is registered after the owner routes, so these answers (session JSON,
     Set-Cookie) set it themselves, and so does everything else under /api/owner. */
  app.use('/api/owner', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const clear = (req, res) => res.append('Set-Cookie', sessions.clearCookie(req));
  // A request whose cookie failed: 403 when it was the cross-site gate (and the cookie is left alone, so a hostile
  // page cannot sign the owner out), else 401 with the dead cookie cleared.
  function refuse(req, res, c) {
    if (c.why === 'csrf') return res.status(403).json({ error: 'Cross-site request refused' });
    if (c.hadCookie) clear(req, res);
    return res.status(401).json({ error: 'Not signed in' });
  }

  app.get('/api/owner/session', readLimiter, (req, res) => {
    const c = sessions.check(req);
    if (!c.sess) {
      if (c.hadCookie && c.why !== 'csrf') clear(req, res);
      return res.json({ signedIn: false });
    }
    res.json({ signedIn: true, device: c.sess.device, createdAt: c.sess.createdAt, exp: c.sess.exp });
  });

  app.get('/api/owner/session/challenge', challenge, (req, res) => {
    const ch = sessions.challenge(req);
    if (!ch) return res.status(503).json({ error: 'Owner sign-in is off on this server' });
    res.append('Set-Cookie', ch.cookie);
    res.json({ nonce: ch.nonce, host: ch.host });
  });

  app.post('/api/owner/session/login', login, (req, res) => {
    const r = sessions.login(req);
    // The challenge is spent or useless after any attempt: the browser forgets it either way.
    res.append('Set-Cookie', sessions.clearChallenge(req));
    if (!r.ok) {
      if (r.status !== 400) log.warn('[OWNER] owner sign-in refused: ' + r.error);
      return res.status(r.status).json({ error: r.error });
    }
    res.append('Set-Cookie', r.cookie);
    audit('session:create', { device: r.sess.device }, 'session:' + r.sess.tag, true, 'Signed in on ' + r.sess.device);
    // No sid, ticket, IP or wallet in the text: the topic is public by obscurity only.
    push('The owner console was signed in on ' + r.sess.device + (region ? ' (' + String(region).toUpperCase() + ')' : '')
      + '. If this was not you, open Control and sign that device out.', { title: 'Owner sign-in', priority: 'high', tags: 'key' });
    res.json({ ok: true, device: r.sess.device, exp: r.sess.exp });
  });

  app.get('/api/owner/sessions', readLimiter, (req, res) => {
    const c = sessions.check(req);
    if (!c.sess) return refuse(req, res, c);
    res.json({ sessions: sessions.list(c.sess) });
  });

  app.post('/api/owner/session/revoke', readLimiter, (req, res) => {
    const c = sessions.check(req);
    let who = c.sess ? 'session:' + c.sess.tag : null;
    let which = req.body;
    if (!who && isPlain(req.body) && req.body.action === REVOKE_ACTION) {
      // The signature path: the args are inside the signature, so they are what is revoked.
      let w = null;
      try { w = sessions.verifyProof(req.body); } catch (_) { w = null; }
      if (typeof w === 'string' && w && sessions.isOwner(w)) { who = w; which = req.body.args; }
    }
    if (!who) return refuse(req, res, c);
    const r = sessions.revoke(which, c.sess);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    if (r.revokedCurrent) clear(req, res);
    const note = 'Signed out ' + r.count + ' device' + (r.count === 1 ? '' : 's')
      + (r.saved ? '' : ' (NOT saved: they come back after a restart)');
    // Only what was asked, never the client's whole body, reaches the audit log.
    const asked = which.all === true ? { all: true } : which.others === true ? { others: true } : { id: which.id };
    audit('session:revoke', asked, who, r.saved, note);
    res.json({ ok: true, count: r.count, saved: r.saved, note });
  });

  app.post('/api/owner/session/logout', readLimiter, (req, res) => {
    if (!sessions.csrfOk(req)) return res.status(403).json({ error: 'Cross-site request refused' });
    const c = sessions.check(req);
    if (c.sess) {
      sessions.revoke({ id: c.sess.id }, c.sess);
      audit('session:logout', undefined, 'session:' + c.sess.tag, true, 'Signed out ' + c.sess.device);
    }
    clear(req, res);
    res.json({ ok: true });
  });

  app.post('/api/owner/ticket', readLimiter, (req, res) => {
    const c = sessions.check(req);
    if (!c.sess) return refuse(req, res, c);
    const ticket = sessions.issueTicket(c.sess);
    if (!ticket) return res.status(503).json({ error: 'No ticket' });
    res.json({ ticket });
  });
}

module.exports = { mountOwnerSessionRoutes };
