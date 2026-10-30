'use strict';
// The owner's always-signed-in session (server/ownerSession.js, server/ownerSessionRoutes.js). One wallet signature
// over 'owner:session:create', bound to a server nonce held in a challenge cookie and to this host, sets an HttpOnly
// cookie good for a year; the allow-list (sha256 of the sid) and the owner list decide every request, writes need
// X-DS-Owner and our own Origin, and the alerts socket gets one-time tickets. Real ed25519 keys and the real
// ownerAuth verifier throughout; the routes run on a real express app over real HTTP, and the last test boots
// server/index.js itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const ownerAuth = require('../server/ownerAuth');
const { createOwnerSessions, uaSummary, CREATE_ACTION, REVOKE_ACTION, SESSION_MS, TICKET_MS, CHALLENGE_MS,
  MAX_DEVICES } = require('../server/ownerSession');
const { mountOwnerSessionRoutes } = require('../server/ownerSessionRoutes');

function keypair() {
  const secret = ed25519.utils.randomPrivateKey();
  return { secret, wallet: bs58.encode(ed25519.getPublicKey(secret)) };
}
const OWNER = keypair();
function proofFor(k, action, args) {
  const ts = Date.now();
  const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(ownerAuth.actionMessage(action, args, k.wallet, ts)), k.secret));
  return { action, args, wallet: k.wallet, ts, sig };
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const unb64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const payloadOf = (cookieValue) => JSON.parse(unb64u(cookieValue.split('.')[0]).toString('utf8'));
const pass = (req, res, next) => next();

function request(base, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, headers);
    if (data !== null) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers: h }, (x) => {
      let d = '';
      x.on('data', (c) => { d += c; });
      x.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch (_) { /* not JSON */ }
        resolve({ status: x.statusCode, headers: x.headers, body: j, text: d });
      });
    });
    r.on('error', reject);
    r.setTimeout(8000, () => r.destroy(new Error('timeout')));
    if (data !== null) r.write(data);
    r.end();
  });
}
const setCookies = (res) => [].concat(res.headers['set-cookie'] || []);

// A browser of sorts: a cookie jar, our own Origin and the owner header on every POST unless told otherwise.
function client(base, host, scheme = 'http') {
  const jar = new Map();
  const c = {
    jar, host, origin: scheme + '://' + host,
    take(res) {
      for (const sc of setCookies(res)) {
        const nv = sc.split(';')[0];
        const eq = nv.indexOf('=');
        const name = nv.slice(0, eq).trim();
        const val = nv.slice(eq + 1).trim();
        const age = /max-age=(\d+)/i.exec(sc);
        if (!val || (age && age[1] === '0')) jar.delete(name); else jar.set(name, val);
      }
      return res;
    },
    cookie() { return [...jar].map(([k, v]) => k + '=' + v).join('; '); },
    async get(p, { headers = {} } = {}) {
      const h = Object.assign({ Host: host }, jar.size ? { Cookie: c.cookie() } : {}, headers);
      return c.take(await request(base, 'GET', p, { headers: h }));
    },
    async post(p, body = {}, { headers = {}, omit = [] } = {}) {
      const h = Object.assign({ Host: host, Origin: c.origin, 'X-DS-Owner': '1', 'Content-Type': 'application/json' },
        jar.size ? { Cookie: c.cookie() } : {}, headers);
      for (const k of omit) delete h[k];
      return c.take(await request(base, 'POST', p, { headers: h, body }));
    },
  };
  return c;
}

const quiet = () => {
  const lines = { warn: [], error: [], log: [] };
  return { lines, warn: (m) => lines.warn.push(String(m)), error: (m) => lines.error.push(String(m)), log: (m) => lines.log.push(String(m)) };
};

/* A store and its routes on a real express app. clock.off moves the store's clock (the proofs keep real time, as
   ownerAuth checks them against Date.now). */
async function rig(t, { production = false, owners, dir, file, realLimits = false, key } = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'ownersess-'));
  owners = owners || new Set([OWNER.wallet]);
  const clock = { off: 0 };
  const log = quiet();
  const sessions = createOwnerSessions({
    file: file || path.join(dir, 'owner-sessions.json'), key, production,
    isOwner: (w) => owners.has(w), verifyProof: (b) => ownerAuth.walletForAction(b),
    now: () => Date.now() + clock.off, log,
  });
  const revoked = [];
  sessions.onRevoke((h) => revoked.push(...h));
  const audits = [];
  const pushes = [];
  const app = express();
  app.use(express.json());
  mountOwnerSessionRoutes(app, {
    sessions, loginLimiter: realLimits ? undefined : pass, challengeLimiter: realLimits ? undefined : pass, region: 'na', log,
    audit: (...a) => audits.push(a), push: (...a) => pushes.push(a),
  });
  // a stand-in for any owner route, to see what the gate lets through
  const probe = (req, res) => { const s = sessions.fromRequest(req); res.json({ sess: s ? s.wallet : null }); };
  app.get('/api/owner/probe', probe);
  app.post('/api/owner/probe', probe);
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  return { sessions, dir, owners, clock, log, audits, pushes, revoked, base, host: '127.0.0.1:' + server.address().port,
           browser: (host, scheme) => client(base, host || '127.0.0.1:' + server.address().port, scheme) };
}

async function signIn(c, k = OWNER, { label = 'Test PC', host } = {}) {
  const ch = await c.get('/api/owner/session/challenge');
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  const proof = proofFor(k, CREATE_ACTION, { nonce: ch.body.nonce, host: host || c.host, label });
  const res = await c.post('/api/owner/session/login', proof);
  return Object.assign(res, { proof, nonce: ch.body.nonce });
}
const fakeReq = (host, cookieHeader, extra = {}) => ({ method: 'GET', headers: Object.assign({ host, cookie: cookieHeader }, extra) });

test('signing in: a challenge, one signature, an HttpOnly year-long cookie; then the owner routes open with no wallet', async (t) => {
  const r = await rig(t);
  const c = r.browser();
  const ch = await c.get('/api/owner/session/challenge');
  assert.equal(ch.status, 200);
  assert.match(ch.body.nonce, /^[0-9a-f]{32}$/);
  assert.equal(ch.body.host, r.host);
  assert.equal(ch.headers['cache-control'], 'no-store');
  const chCookie = setCookies(ch).find((s) => s.startsWith('ds_owner_ch='));
  assert.ok(chCookie, 'a challenge cookie');
  assert.match(chCookie, /HttpOnly/);
  assert.match(chCookie, /SameSite=Strict/);
  assert.match(chCookie, new RegExp('Max-Age=' + CHALLENGE_MS / 1000));
  assert.ok(!/Secure/.test(chCookie), 'plain http on a dev PC: no Secure');

  const res = await c.post('/api/owner/session/login',
    proofFor(OWNER, CREATE_ACTION, { nonce: ch.body.nonce, host: c.host, label: 'Owen <PC>' }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.device, 'Owen PC', 'the label is cut to plain text');
  assert.ok(res.body.exp - Date.now() > SESSION_MS - 60000, 'a year');
  assert.equal(res.headers['cache-control'], 'no-store');
  const sc = setCookies(res).find((s) => s.startsWith('ds_owner='));
  assert.ok(sc, 'the session cookie');
  assert.match(sc, /; Path=\/; HttpOnly; SameSite=Strict; Max-Age=31536000$/);
  assert.ok(setCookies(res).some((s) => /^ds_owner_ch=;.*Max-Age=0/.test(s)), 'the challenge is cleared');
  assert.ok(!c.jar.has('ds_owner_ch'));

  const me = await c.get('/api/owner/session');
  assert.deepEqual(Object.keys(me.body).sort(), ['createdAt', 'device', 'exp', 'signedIn']);
  assert.equal(me.body.signedIn, true);
  assert.equal(me.body.device, 'Owen PC');
  assert.equal(me.headers['cache-control'], 'no-store');
  const list = await c.get('/api/owner/sessions');
  assert.equal(list.body.sessions.length, 1);
  const d = list.body.sessions[0];
  assert.deepEqual(Object.keys(d).sort(), ['createdAt', 'current', 'device', 'exp', 'id', 'lastSeen']);
  assert.equal(d.current, true);
  assert.match(d.id, /^[0-9a-f]{12}$/);
  const probe = await c.post('/api/owner/probe', {});
  assert.equal(probe.body.sess, OWNER.wallet);

  // The file: the hash of the sid, never the sid, and nothing that signs anybody in by itself.
  const sid = payloadOf(c.jar.get('ds_owner')).sid;
  const text = fs.readFileSync(path.join(r.dir, 'owner-sessions.json'), 'utf8');
  assert.ok(text.includes(sha256(sid)));
  assert.ok(!text.includes(sid));
  assert.ok(!text.includes(c.jar.get('ds_owner')));
  assert.ok(sha256(sid).endsWith(d.id));
  assert.match(fs.readFileSync(path.join(r.dir, 'owner-session.key'), 'utf8'), /^[0-9a-f]{64}\n$/, '32 random bytes, made on first use');

  // the audit names the device by the last 6 of its sid hash; the phone is told, with no secret in the text
  assert.equal(r.audits.length, 1);
  assert.equal(r.audits[0][0], 'session:create');
  assert.equal(r.audits[0][2], 'session:' + sha256(sid).slice(-6));
  assert.equal(r.pushes.length, 1);
  const [pushText, pushOpts] = r.pushes[0];
  assert.match(pushText, /signed in on Owen PC \(NA\)/);
  for (const secret of [sid, sha256(sid), ch.body.nonce, c.jar.get('ds_owner'), OWNER.wallet, '127.0.0.1']) {
    assert.ok(!pushText.includes(secret) && !JSON.stringify(pushOpts).includes(secret), 'no secret in the push');
  }
  // ownerAuth's audit keeps a session name whole and still shortens a wallet
  ownerAuth.audit('t', {}, 'session:' + sha256(sid).slice(-6), true);
  assert.equal(ownerAuth.auditLog[0].who, 'session:' + sha256(sid).slice(-6));
  ownerAuth.audit('t', {}, OWNER.wallet, true);
  assert.equal(ownerAuth.auditLog[0].who, OWNER.wallet.slice(0, 4) + '…' + OWNER.wallet.slice(-4));
  ownerAuth.audit('t', {}, 'token', true);
  assert.equal(ownerAuth.auditLog[0].who, 'token');
});

test('production cookies are __Host- and Secure; so is any duelseries.com host, decided without req.secure', async (t) => {
  const p = await rig(t, { production: true });
  const c = p.browser(undefined, 'https');   // the request itself is plain http: nginx sends no X-Forwarded-Proto
  const res = await signIn(c);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const sc = setCookies(res).find((s) => s.startsWith('__Host-ds_owner='));
  assert.match(sc, /; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=31536000$/);
  assert.ok(!/Domain=/i.test(sc));
  assert.equal((await c.get('/api/owner/session')).body.signedIn, true);
  // the plain name is never read in production, so a sibling site's ds_owner cookie means nothing
  const plain = p.browser(undefined, 'https');
  plain.jar.set('ds_owner', c.jar.get('__Host-ds_owner'));
  assert.equal((await plain.get('/api/owner/session')).body.signedIn, false);
  // an http Origin is not our origin in production
  assert.equal((await c.post('/api/owner/probe', {}, { headers: { Origin: 'http://' + c.host } })).body.sess, null);

  const d = await rig(t, { production: false });
  const live = d.browser('duelseries.com', 'https');
  const r2 = await signIn(live);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.ok(setCookies(r2).some((s) => s.startsWith('__Host-ds_owner=') && /; Secure;/.test(s)));
  assert.equal((await live.post('/api/owner/probe', {})).body.sess, OWNER.wallet);
});

test('a forged, unlisted, revoked, expired or no-longer-owner cookie signs nobody in', async (t) => {
  const r = await rig(t);
  const c = r.browser();
  assert.equal((await signIn(c)).status, 200);
  const good = c.jar.get('ds_owner');
  const why = (value, store = r.sessions) => store.check(fakeReq(r.host, 'ds_owner=' + value)).why;
  assert.equal(why(good), null);

  // forged: the HMAC changed, the payload changed under the old HMAC, another key, a challenge passed off as a session
  const [body, mac] = good.split('.');
  const flipped = mac.slice(0, -2) + (mac.slice(-2) === 'AA' ? 'BB' : 'AA');
  assert.equal(why(body + '.' + flipped), 'forged');
  const p = payloadOf(good);
  const other = keypair();
  assert.equal(why(b64u(JSON.stringify(Object.assign({}, p, { w: other.wallet }))) + '.' + mac), 'forged');
  assert.equal(why(b64u(JSON.stringify(Object.assign({}, p, { exp: p.exp + SESSION_MS }))) + '.' + mac), 'forged');
  const elsewhere = await rig(t, { key: 'some other key' });
  const e = elsewhere.browser();
  assert.equal((await signIn(e)).status, 200);
  assert.equal(why(e.jar.get('ds_owner')), 'forged', 'sealed with another key');
  const ch = r.sessions.challenge(fakeReq(r.host, ''));
  assert.equal(why(ch.cookie.split(';')[0].split('=')[1]), 'forged', 'a challenge is not a session');
  for (const junk of ['', '.', 'a.b.c', 'x'.repeat(5000), '%%%.%%%']) assert.notEqual(why(junk), null);

  // unlisted: a genuine HMAC (same key file) whose sid this list never issued
  const second = createOwnerSessions({ file: path.join(r.dir, 'another-list.json'), isOwner: (w) => r.owners.has(w),
    verifyProof: () => null, log: quiet() });
  assert.equal(why(good, second), 'unlisted');

  // the owner list is asked on every request: off the list, refused; back on it, accepted
  r.owners.delete(OWNER.wallet);
  assert.equal(why(good), 'not-owner');
  r.owners.add(OWNER.wallet);
  assert.equal(why(good), null);

  // expired: one year after sign-in, to the millisecond
  r.clock.off = SESSION_MS - 5000;
  assert.equal(why(good), null);
  r.clock.off = SESSION_MS + 1;
  assert.equal(why(good), 'expired');
  const late = await c.get('/api/owner/session');
  assert.equal(late.body.signedIn, false);
  assert.ok(setCookies(late).some((s) => /^ds_owner=;.*Max-Age=0/.test(s)), 'a dead cookie is cleared');
  r.clock.off = 0;

  // revoked
  const c2 = r.browser();
  assert.equal((await signIn(c2)).status, 200);
  const v2 = c2.jar.get('ds_owner');
  const id2 = sha256(payloadOf(v2).sid).slice(-12);
  const rv = await c2.post('/api/owner/session/revoke', { id: id2 });
  assert.equal(rv.status, 200, JSON.stringify(rv.body));
  assert.equal(why(v2), 'revoked');
  assert.equal((await c2.post('/api/owner/ticket', {})).status, 401);
  // a non-owner key never gets a session at all
  const stranger = await signIn(r.browser(), other);
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.error, 'Not an owner');
  assert.ok(!setCookies(stranger).some((s) => s.startsWith('ds_owner=') && !/Max-Age=0/.test(s)));
});

test('writes need X-DS-Owner, our exact Origin (or Sec-Fetch-Site same-origin / none) and JSON; reads only refuse other sites', async (t) => {
  const r = await rig(t);
  const c = r.browser();
  assert.equal((await signIn(c)).status, 200);
  const write = async (opts) => (await c.post('/api/owner/probe', {}, opts)).body.sess;
  assert.equal(await write({}), OWNER.wallet, 'the honest console');
  assert.equal(await write({ omit: ['X-DS-Owner'] }), null, 'no owner header');
  assert.equal(await write({ headers: { 'X-DS-Owner': 'true' } }), null);
  for (const o of ['https://evil.test', 'http://' + c.host + '.evil.test', 'https://eu.duelseries.com', 'null',
    'https://' + c.host]) {
    assert.equal(await write({ headers: { Origin: o } }), null, 'Origin ' + o);
  }
  assert.equal(await write({ omit: ['Origin'], headers: { 'Sec-Fetch-Site': 'same-origin' } }), OWNER.wallet);
  assert.equal(await write({ omit: ['Origin'], headers: { 'Sec-Fetch-Site': 'none' } }), OWNER.wallet);
  assert.equal(await write({ omit: ['Origin'], headers: { 'Sec-Fetch-Site': 'same-site' } }), null, 'a sibling subdomain');
  assert.equal(await write({ omit: ['Origin'], headers: { 'Sec-Fetch-Site': 'cross-site' } }), null);
  assert.equal(await write({ omit: ['Origin'] }), null, 'no Origin and no Sec-Fetch-Site');
  assert.equal(await write({ headers: { 'Sec-Fetch-Site': 'cross-site' } }), null, 'a good Origin cannot outvote cross-site');
  assert.equal(await write({ headers: { 'Content-Type': 'text/plain' } }), null, 'a form-shaped body');
  assert.equal(await write({ headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), null);
  assert.equal(await write({ headers: { 'Content-Type': 'application/json; charset=utf-8' } }), OWNER.wallet);
  // reads: SameSite already keeps the cookie off cross-site requests; a read that says it came from elsewhere is refused
  assert.equal((await c.get('/api/owner/probe')).body.sess, OWNER.wallet);
  assert.equal((await c.get('/api/owner/probe', { headers: { 'Sec-Fetch-Site': 'none' } })).body.sess, OWNER.wallet);
  assert.equal((await c.get('/api/owner/probe', { headers: { 'Sec-Fetch-Site': 'same-site' } })).body.sess, null);
  assert.equal((await c.get('/api/owner/probe', { headers: { Origin: 'https://evil.test' } })).body.sess, null);
  // the real routes: 403, and a refused cross-site request never signs the owner out
  for (const route of ['/api/owner/ticket', '/api/owner/session/revoke', '/api/owner/session/logout']) {
    const res = await c.post(route, { all: true }, { omit: ['X-DS-Owner'] });
    assert.equal(res.status, 403, route);
    assert.ok(!setCookies(res).some((s) => s.startsWith('ds_owner=')), route + ' leaves the cookie alone');
    const evil = await c.post(route, { all: true }, { headers: { Origin: 'https://evil.test' } });
    assert.equal(evil.status, 403, route);
  }
  assert.equal((await c.get('/api/owner/session')).body.signedIn, true, 'still signed in');
  assert.equal((await c.get('/api/owner/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).body.signedIn, false);
  assert.equal((await c.get('/api/owner/session')).body.signedIn, true, 'and that did not clear it either');
  // sign-in itself: the same gate
  const ch = await c.get('/api/owner/session/challenge');
  const proof = proofFor(OWNER, CREATE_ACTION, { nonce: ch.body.nonce, host: c.host, label: 'x' });
  assert.equal((await c.post('/api/owner/session/login', proof, { omit: ['X-DS-Owner'] })).status, 403);
  assert.equal(ownerAuth.walletForAction(proof), OWNER.wallet, 'refused before the signature was spent');
});

test('sign-in refuses the wrong action, the wrong host, a nonce not from its challenge, no challenge, an old one, a replay', async (t) => {
  const r = await rig(t);
  const c = r.browser();
  // the wrong action name, right args: 400, and the signature is not spent here
  let ch = await c.get('/api/owner/session/challenge');
  for (const action of ['owner:session:make', 'owner:alerts', 'state']) {
    const wrong = proofFor(OWNER, action, { nonce: ch.body.nonce, host: c.host, label: 'x' });
    const res = await c.post('/api/owner/session/login', wrong);
    assert.equal(res.status, 400, action);
    assert.equal(ownerAuth.walletForAction(wrong), OWNER.wallet, action + ' still unspent for what it was signed for');
    ch = await c.get('/api/owner/session/challenge');
  }
  // the wrong host (a proof signed on another site's page), or none
  for (const host of ['evil.test', 'duelseries.com', '', undefined]) {
    const res = await c.post('/api/owner/session/login', proofFor(OWNER, CREATE_ACTION, { nonce: ch.body.nonce, host, label: 'x' }));
    assert.equal(res.status, 403, 'host ' + host);
    ch = await c.get('/api/owner/session/challenge');
  }
  // a nonce that is not this challenge's
  const bad = await c.post('/api/owner/session/login',
    proofFor(OWNER, CREATE_ACTION, { nonce: crypto.randomBytes(16).toString('hex'), host: c.host, label: 'x' }));
  assert.equal(bad.status, 403);
  assert.match(bad.body.error, /does not match/);
  // no challenge cookie: a valid proof posted from another machine is useless
  ch = await c.get('/api/owner/session/challenge');
  const stolen = proofFor(OWNER, CREATE_ACTION, { nonce: ch.body.nonce, host: c.host, label: 'x' });
  const thief = r.browser();
  const t1 = await thief.post('/api/owner/session/login', stolen);
  assert.equal(t1.status, 403);
  assert.match(t1.body.error, /challenge/);
  // a challenge cookie from another browser does not fit this nonce either
  const theirs = await thief.get('/api/owner/session/challenge');
  assert.ok(theirs.body.nonce !== ch.body.nonce);
  assert.equal((await thief.post('/api/owner/session/login', stolen)).status, 403);
  // a challenge older than 5 minutes
  ch = await c.get('/api/owner/session/challenge');
  r.clock.off = CHALLENGE_MS + 1000;
  assert.equal((await c.post('/api/owner/session/login',
    proofFor(OWNER, CREATE_ACTION, { nonce: ch.body.nonce, host: c.host, label: 'x' }))).status, 403);
  r.clock.off = 0;
  // a bad signature spends the challenge, so one challenge is never tried twice
  ch = await c.get('/api/owner/session/challenge');
  const chValue = c.jar.get('ds_owner_ch');
  const tampered = proofFor(OWNER, CREATE_ACTION, { nonce: ch.body.nonce, host: c.host, label: 'x' });
  tampered.args = Object.assign({}, tampered.args, { label: 'y' });
  const tr = await c.post('/api/owner/session/login', tampered);
  assert.equal(tr.status, 403);
  assert.match(tr.body.error, /did not verify/);
  c.jar.set('ds_owner_ch', chValue);
  const retry = await c.post('/api/owner/session/login', proofFor(OWNER, CREATE_ACTION, { nonce: ch.body.nonce, host: c.host, label: 'x' }));
  assert.equal(retry.status, 403);
  assert.match(retry.body.error, /already used/);
  // the real thing, then the same proof again with the same challenge cookie: refused
  const ok = await signIn(c);
  assert.equal(ok.status, 200);
  const again = r.browser();
  const ch2 = await again.get('/api/owner/session/challenge');
  const once = proofFor(OWNER, CREATE_ACTION, { nonce: ch2.body.nonce, host: again.host, label: 'x' });
  const kept = again.jar.get('ds_owner_ch');
  assert.equal((await again.post('/api/owner/session/login', once)).status, 200);
  again.jar.set('ds_owner_ch', kept);
  const replay = await again.post('/api/owner/session/login', once);
  assert.equal(replay.status, 403, 'a replayed sign-in proof');
  assert.match(replay.body.error, /already used/);
  // two live sessions came of all that, no more
  assert.equal(r.sessions.list(null).length, 2);
  assert.equal(r.pushes.length, 2);
});

test('tickets: one use, 60 seconds, a live session only', async (t) => {
  const r = await rig(t);
  const c = r.browser();
  assert.equal((await r.browser().post('/api/owner/ticket', {})).status, 401, 'no session, no ticket');
  assert.equal((await signIn(c)).status, 200);
  const sidHash = sha256(payloadOf(c.jar.get('ds_owner')).sid);
  const t1 = (await c.post('/api/owner/ticket', {})).body.ticket;
  assert.match(t1, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(r.sessions.ticketWallet(t1), { wallet: OWNER.wallet, session: sidHash });
  assert.equal(r.sessions.ticketWallet(t1), null, 'single use');
  const t2 = (await c.post('/api/owner/ticket', {})).body.ticket;
  r.clock.off = TICKET_MS + 1;
  assert.equal(r.sessions.ticketWallet(t2), null, 'expired after 60 s');
  r.clock.off = 0;
  const t3 = (await c.post('/api/owner/ticket', {})).body.ticket;
  r.clock.off = TICKET_MS - 1000;
  assert.ok(r.sessions.ticketWallet(t3), 'good inside 60 s');
  r.clock.off = 0;
  // the owner wallet removed from the list: its tickets stop working too
  const t4 = (await c.post('/api/owner/ticket', {})).body.ticket;
  r.owners.delete(OWNER.wallet);
  assert.equal(r.sessions.ticketWallet(t4), null);
  r.owners.add(OWNER.wallet);
  // revoked: an unspent ticket dies with its session
  const t5 = (await c.post('/api/owner/ticket', {})).body.ticket;
  assert.equal((await c.post('/api/owner/session/revoke', { all: true })).status, 200);
  assert.equal(r.sessions.ticketWallet(t5), null);
  for (const junk of [undefined, null, 7, {}, '', 'x'.repeat(65)]) assert.equal(r.sessions.ticketWallet(junk), null);
});

test('revoke: one device, every other device, or all; the revoked hear about it and their alert sockets go', async (t) => {
  const r = await rig(t);
  const [a, b, c] = [r.browser(), r.browser(), r.browser()];
  for (const x of [a, b, c]) assert.equal((await signIn(x)).status, 200);
  const hash = (x) => sha256(payloadOf(x.jar.get('ds_owner')).sid);
  const ha = hash(a);
  const hb = hash(b);
  const hc = hash(c);
  assert.equal((await a.get('/api/owner/sessions')).body.sessions.length, 3);
  // bad asks
  assert.equal((await a.post('/api/owner/session/revoke', {})).status, 400);
  assert.equal((await a.post('/api/owner/session/revoke', { id: 'nothex' })).status, 400);
  assert.equal((await a.post('/api/owner/session/revoke', { id: '0123456789ab' })).status, 404);
  // others
  const o = await a.post('/api/owner/session/revoke', { others: true });
  assert.equal(o.status, 200);
  assert.equal(o.body.ok, true);
  assert.equal(o.body.count, 2);
  assert.deepEqual(r.revoked.sort(), [hb, hc].sort());
  assert.equal((await b.get('/api/owner/session')).body.signedIn, false);
  assert.equal((await c.post('/api/owner/probe', {})).body.sess, null);
  assert.equal((await a.get('/api/owner/session')).body.signedIn, true, 'this device stays in');
  assert.equal(r.audits.filter((x) => x[0] === 'session:revoke')[0][2], 'session:' + ha.slice(-6));
  // one by id
  const d = r.browser();
  assert.equal((await signIn(d)).status, 200);
  const hd = hash(d);
  const list = (await a.get('/api/owner/sessions')).body.sessions;
  assert.deepEqual(list.map((s) => s.current).sort(), [false, true]);
  assert.equal((await a.post('/api/owner/session/revoke', { id: hd.slice(-12) })).status, 200);
  assert.equal((await d.get('/api/owner/session')).body.signedIn, false);
  // all, from the device itself: it is signed out too, and its cookie cleared
  assert.equal((await signIn(d)).status, 200);
  const all = await a.post('/api/owner/session/revoke', { all: true });
  assert.equal(all.status, 200);
  assert.equal(all.body.count, 2);
  assert.ok(setCookies(all).some((s) => /^ds_owner=;.*Max-Age=0/.test(s)));
  assert.equal((await a.get('/api/owner/session')).body.signedIn, false);
  assert.equal((await d.get('/api/owner/session')).body.signedIn, false);
  assert.ok(r.revoked.includes(ha));
  assert.equal(r.sessions.list(null).length, 0);
  // the old signed proof can revoke too (a device that lost its own session), with the args inside the signature
  const e = r.browser();
  assert.equal((await signIn(e)).status, 200);
  const nobody = r.browser();
  const signedAll = await nobody.post('/api/owner/session/revoke', proofFor(OWNER, REVOKE_ACTION, { all: true }));
  assert.equal(signedAll.status, 200, JSON.stringify(signedAll.body));
  assert.equal((await e.get('/api/owner/session')).body.signedIn, false);
  const strangerSigned = await nobody.post('/api/owner/session/revoke', proofFor(keypair(), REVOKE_ACTION, { all: true }));
  assert.equal(strangerSigned.status, 401);
  assert.equal((await nobody.post('/api/owner/session/revoke', { all: true })).status, 401, 'no session, no proof');

  // the server wires revoke to its alert sockets: signing a device out disconnects its tabs
  const { createSocketIdentity } = require('../server/socketIdentity');
  const ownerSockets = new Map();
  const id = createSocketIdentity({ verifyIdentityProof: () => null, walletForAction: () => null,
    isOwner: (w) => r.owners.has(w), alertKey: OWNER.wallet, ownerSockets,
    ticketWallet: (tk) => r.sessions.ticketWallet(tk), sessionLive: (h) => r.sessions.isLive(h), log: quiet() });
  r.sessions.onRevoke((h) => id.dropSessions(h));
  const f = r.browser();
  const g = r.browser();
  assert.equal((await signIn(f)).status, 200);
  assert.equal((await signIn(g)).status, 200);
  const sock = () => ({ sent: [], disconnected: false, emit(ev) { this.sent.push(ev); }, disconnect() { this.disconnected = true; } });
  const [sf1, sf2, sg] = [sock(), sock(), sock()];
  assert.equal(id.ownerAlertsByTicket(sf1, (await f.post('/api/owner/ticket', {})).body.ticket), true);
  assert.equal(id.ownerAlertsByTicket(sf2, (await f.post('/api/owner/ticket', {})).body.ticket), true, 'a second tab');
  assert.equal(id.ownerAlertsByTicket(sg, (await g.post('/api/owner/ticket', {})).body.ticket), true);
  ownerSockets.get(OWNER.wallet).emit('admin:solvency_alert');
  assert.deepEqual([sf1.sent.length, sf2.sent.length, sg.sent.length], [1, 1, 1], 'every tab hears every alert');
  assert.equal((await g.post('/api/owner/session/revoke', { others: true })).status, 200);
  assert.equal(sf1.disconnected && sf2.disconnected, true, 'both of the revoked device\'s tabs are cut off');
  assert.equal(sg.disconnected, false);
  ownerSockets.get(OWNER.wallet).emit('admin:solvency_alert');
  assert.deepEqual([sf1.sent.length, sf2.sent.length, sg.sent.length], [1, 1, 2]);
});

test('logout signs this device out and clears its cookie', async (t) => {
  const r = await rig(t);
  const c = r.browser();
  assert.equal((await signIn(c)).status, 200);
  const v = c.jar.get('ds_owner');
  const out = await c.post('/api/owner/session/logout', {});
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true });
  assert.ok(setCookies(out).some((s) => /^ds_owner=;.*Max-Age=0/.test(s)));
  assert.equal(r.sessions.check(fakeReq(r.host, 'ds_owner=' + v)).why, 'revoked');
  assert.equal((await r.browser().post('/api/owner/session/logout', {})).status, 200, 'signed out already: still fine');
  assert.ok(r.audits.some((x) => x[0] === 'session:logout'));
});

test('the list survives a restart, fails closed when unreadable, drops non-owners; a broken key turns sign-in off', async (t) => {
  const r = await rig(t);
  const c = r.browser();
  assert.equal((await signIn(c)).status, 200);
  const v = c.jar.get('ds_owner');
  const file = path.join(r.dir, 'owner-sessions.json');
  const again = (opts = {}) => createOwnerSessions(Object.assign({ file, isOwner: (w) => r.owners.has(w),
    verifyProof: () => null, log: quiet() }, opts));
  // a restart: same files, same answer
  assert.equal(again().check(fakeReq(r.host, 'ds_owner=' + v)).why, null);
  // a list that is not a list: nobody is let in
  const saved = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{"v":1,"sessions":');
  const log = quiet();
  assert.equal(again({ log }).check(fakeReq(r.host, 'ds_owner=' + v)).why, 'unlisted');
  assert.ok(log.lines.error.some((m) => /CRITICAL/.test(m)));
  fs.writeFileSync(file, '[]');
  assert.equal(again().check(fakeReq(r.host, 'ds_owner=' + v)).why, 'unlisted');
  // a record whose wallet is no longer an owner is dropped at load
  fs.writeFileSync(file, saved);
  r.owners.clear();
  const log2 = quiet();
  const s2 = again({ log: log2 });
  assert.equal(s2.check(fakeReq(r.host, 'ds_owner=' + v)).why, 'unlisted');
  assert.ok(log2.lines.warn.some((m) => /dropped/.test(m)));
  r.owners.add(OWNER.wallet);
  // the key file: not a key means sign-in is off (no challenge, no cookie accepted), never a silent new key
  fs.writeFileSync(file, saved);
  const keyFile = path.join(r.dir, 'owner-session.key');
  const goodKey = fs.readFileSync(keyFile, 'utf8');
  fs.writeFileSync(keyFile, 'garbage');
  const log3 = quiet();
  const s3 = again({ log: log3 });
  assert.equal(s3.challenge(fakeReq(r.host, '')), null);
  assert.equal(s3.check(fakeReq(r.host, 'ds_owner=' + v)).why, 'nokey');
  assert.ok(log3.lines.error.some((m) => /CRITICAL/.test(m)));
  assert.equal(fs.readFileSync(keyFile, 'utf8'), 'garbage', 'left for the owner to look at');
  fs.writeFileSync(keyFile, goodKey);
  // deleting the key signs everybody out: a new key is made and the old cookies are forgeries to it
  fs.unlinkSync(keyFile);
  assert.equal(again().check(fakeReq(r.host, 'ds_owner=' + v)).why, 'forged');
  assert.match(fs.readFileSync(keyFile, 'utf8'), /^[0-9a-f]{64}\n$/);
  // OWNER_SESSION_KEY replaces the file
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ownersess-'));
  const s4 = createOwnerSessions({ file: path.join(dir2, 'l.json'), key: 'from env', isOwner: () => true, verifyProof: () => null });
  assert.ok(s4.challenge(fakeReq('h', '')));
  assert.equal(fs.existsSync(path.join(dir2, 'owner-session.key')), false);
  // a challenge route on a store with no key answers 503
  fs.writeFileSync(keyFile, 'garbage');
  const off = await rig(t, { dir: r.dir });
  assert.equal((await off.browser().get('/api/owner/session/challenge')).status, 503);
});

test('at most 10 devices: the 11th sign-in signs out the least recently seen', async (t) => {
  const r = await rig(t);
  const devices = [];
  for (let i = 0; i < MAX_DEVICES; i++) {
    const c = r.browser();
    r.clock.off = i * 1000;
    assert.equal((await signIn(c, OWNER, { label: 'Device ' + i })).status, 200);
    devices.push(c);
  }
  // device 0 is used again, so device 1 is now the least recently seen
  r.clock.off = 20000;
  assert.equal((await devices[0].post('/api/owner/probe', {})).body.sess, OWNER.wallet);
  r.clock.off = 21000;
  const eleventh = r.browser();
  assert.equal((await signIn(eleventh, OWNER, { label: 'Device 10' })).status, 200);
  const live = r.sessions.list(null);
  assert.equal(live.length, MAX_DEVICES);
  assert.ok(!live.some((s) => s.device === 'Device 1'));
  assert.equal((await devices[1].get('/api/owner/session')).body.signedIn, false);
  assert.equal((await devices[0].get('/api/owner/session')).body.signedIn, true);
  assert.equal(r.revoked.length, 1);
});

test('sign-in is rate limited: about 10 attempts per 10 minutes per address', async (t) => {
  const r = await rig(t, { realLimits: true });
  const c = r.browser();
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await c.post('/api/owner/session/login', { action: 'nope' })).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(400));
  assert.equal(codes[10], 429);
});

/* ownerDevice (2026-10-29): is this the owner's own browser, for keeping his own visits and joins off his phone. The
   cookie rules of check() with only the read gate: the visit beacon is a POST without X-DS-Owner, and a socket's
   handshake is a GET. It authorises nothing, so check() still refuses that POST. */
test('ownerDevice: his live cookie on a beacon POST or a socket handshake; a forged, revoked or cross-site one is not', async (t) => {
  const r = await rig(t);
  const c = r.browser();
  assert.equal((await signIn(c)).status, 200);
  const v = c.jar.get('ds_owner');
  const beacon = { method: 'POST', headers: { host: r.host, cookie: 'ds_owner=' + v, origin: 'http://' + r.host,
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } };
  assert.equal(r.sessions.ownerDevice(beacon), true);
  assert.equal(r.sessions.check(beacon).why, 'csrf', 'the same POST is no owner write');
  const handshake = fakeReq(r.host, 'ds_owner=' + v, { 'sec-fetch-site': 'same-origin' });
  assert.equal(r.sessions.ownerDevice(handshake), true);
  assert.equal(r.sessions.ownerDevice(fakeReq(r.host, 'other=1; ds_owner=' + v)), true, 'no fetch headers (a Node client)');

  const [body, mac] = v.split('.');
  const no = (cookie, extra) => assert.equal(r.sessions.ownerDevice(fakeReq(r.host, cookie, extra)), false, cookie);
  no('');
  no('ds_owner=' + body + '.' + (mac.slice(-2) === 'AA' ? mac.slice(0, -2) + 'BB' : mac.slice(0, -2) + 'AA'));
  no('ds_owner=' + body);
  no('ds_owner_owner=1; owner=1; isOwner=true');
  no('ds_owner=' + v, { 'sec-fetch-site': 'cross-site' });
  no('ds_owner=' + v, { origin: 'https://evil.example' });
  for (const bad of [null, undefined, {}, { headers: null }, 'ds_owner=' + v]) assert.equal(r.sessions.ownerDevice(bad), false);

  assert.equal((await c.post('/api/owner/session/logout', {})).status, 200);
  no('ds_owner=' + v);
});

test('uaSummary names the browser and the system, and nothing else', () => {
  assert.equal(uaSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'),
    'Chrome on Windows');
  assert.equal(uaSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'),
    'Safari on iPhone');
  assert.equal(uaSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'),
    'Edge on Windows');
  assert.equal(uaSummary(undefined), 'A browser');
  assert.equal(uaSummary({ toString: 1 }), 'A browser');
});

test('server/index.js: the session is checked first on every owner route, and CORS still sends no credentials', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /async function isOwnerReq\(req\) \{\n\s+return !!\(await ownerAuthOf\(req\)\);\n\}/);
  const of = src.slice(src.indexOf('async function ownerAuthOf(req)'), src.indexOf('async function isOwnerReq(req)'));
  assert.ok(of.indexOf('ownerSessions.fromRequest(req)') > 0);
  assert.ok(of.indexOf('ownerSessions.fromRequest(req)') < of.indexOf('ownerFromSignature(req.body)'), 'session before signature');
  assert.ok(of.indexOf('ownerFromSignature(req.body)') < of.indexOf('tokensFrom(req)'), 'signature before token');
  assert.match(of, /who: 'session:' \+ s\.tag/);
  const doRoute = src.slice(src.indexOf("app.post('/api/owner/do'"), src.indexOf("app.post('/api/owner/do'") + 400);
  assert.match(doRoute, /const who = \(\(await ownerAuthOf\(req\)\) \|\| \{\}\)\.who;/);
  const diag = src.slice(src.indexOf("app.post('/api/owner/diagnose'"), src.indexOf("app.post('/api/owner/diagnose'") + 600);
  assert.match(diag, /await ownerAuthOf\(req\)/);
  const mount = src.indexOf('mountOwnerSessionRoutes(app');
  assert.ok(mount > src.indexOf('app.use(express.json())'), 'after the JSON parser');
  assert.ok(mount < src.indexOf("app.post('/api/owner/state'"), 'before the owner routes, so no-store covers them');
  assert.ok(mount < src.indexOf("app.get('/api/admin/solvency'"));
  assert.match(src, /OWNER_SESSIONS_PATH \|\| path\.join\(__dirname, 'data', 'owner-sessions\.json'\)/);
  // the CORS block: no credentials and no owner header, so no other origin can make a cookie write
  const cors = src.slice(src.indexOf('const _allowedOriginSet'), src.indexOf("if (req.method === 'OPTIONS')"));
  assert.ok(!/Allow-Credentials/i.test(cors));
  assert.ok(!/X-DS-Owner/i.test(cors));
});

// The whole thing on the real server: sign in over HTTP, use the cookie on /api/owner/state, /do and a GET admin route,
// get an alerts ticket, register a socket with it, revoke, and watch the socket go and the cookie stop working.
test('on the real server the session signs in, runs the console, feeds the alerts socket, and revokes', { timeout: 120000 }, async (t) => {
  let ioClient;
  try { ioClient = require('socket.io-client'); } catch (_) { return t.skip('socket.io-client not installed'); }
  const { spawn } = require('child_process');
  const net = require('net');
  const ROOT = path.join(__dirname, '..');
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const owner = keypair();
  const port = await new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownersess-live-'));
  const env = { ...process.env, REGION: 'na', PORT: String(port), SESSION_SECRET: 'test', MONEY_MODE: 'usdc',
    DATABASE_URL: '', NTFY_DISABLED: '1', POSTHOG_DISABLED: '1', ESCROW_PRIVATE_KEY: '', ESCROW_PUBLIC_KEY: '',
    RPC_URL: 'https://rpc.invalid/never-called', SOLANA_NETWORK: 'devnet', NODE_ENV: 'test', SL_PAID: '0', AG_PAID: '0',
    AG_JOURNAL_PATH: path.join(dir, 'ag-money-journal.log'), OWNER_SESSIONS_PATH: path.join(dir, 'owner-sessions.json'),
    ALLOW_TEST_OWNER: '1', TEST_OWNER_WALLET: owner.wallet };
  delete env.OWNER_SESSION_KEY;
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '' };
  srv.stdout.on('data', (d) => { out.text += d.toString(); });
  srv.stderr.on('data', (d) => { out.text += d.toString(); });
  const socks = [];
  t.after(() => {
    for (const s of socks) { try { s.close(); } catch (_) {} }
    try { srv.kill('SIGKILL'); } catch (_) {}
  });
  const base = 'http://localhost:' + port;
  let up = false;
  for (let i = 0; i < 150 && !up && srv.exitCode === null; i++) {
    try { up = (await request(base, 'GET', '/api/live')).status === 200; } catch (_) { /* booting */ }
    if (!up) await sleep(400);
  }
  assert.ok(up, 'server came up\n' + out.text.slice(-1500));
  const c = client(base, 'localhost:' + port);

  assert.equal((await c.get('/api/owner/session')).body.signedIn, false);
  const before = await c.post('/api/owner/state', {});
  assert.equal(before.status, 403, 'no cookie, no proof: refused');
  assert.equal(before.headers['cache-control'], 'no-store', 'the owner routes answer no-store now');
  const login = await signIn(c, owner, { label: 'Live test' });
  assert.equal(login.status, 200, JSON.stringify(login.body) + '\n' + out.text.slice(-800));
  assert.equal(fs.existsSync(path.join(dir, 'owner-sessions.json')), true, 'the list went where OWNER_SESSIONS_PATH said');
  assert.equal(fs.existsSync(path.join(dir, 'owner-session.key')), true);
  const tag = sha256(payloadOf(c.jar.get('ds_owner')).sid).slice(-6);

  // the console, on the cookie alone: no signature anywhere
  const st = await c.post('/api/owner/state', {});
  assert.equal(st.status, 200, st.text.slice(0, 300));
  assert.ok(st.body && typeof st.body === 'object');
  const act = await c.post('/api/owner/do', { action: 'maintenance:check', args: {} });
  assert.ok(act.status === 200 || act.status === 409, act.status + ' ' + act.text.slice(0, 200));
  assert.equal(act.body.state.audit[0].action, 'maintenance:check');
  assert.equal(act.body.state.audit[0].who, 'session:' + tag, 'the audit names the device');
  const noHeader = await c.post('/api/owner/state', {}, { omit: ['X-DS-Owner'] });
  assert.equal(noHeader.status, 403, 'a cookie write without the owner header is not the owner');
  const evil = await c.post('/api/owner/do', { action: 'maintenance:check', args: {} }, { headers: { Origin: 'https://evil.test' } });
  assert.equal(evil.status, 403);
  // a GET admin route, which no browser could reach before (a GET has no signed body)
  const admin = await c.get('/api/admin/collusion');
  assert.ok(admin.status !== 403 && admin.status !== 401, 'the session opens the GET admin routes: ' + admin.status);
  assert.equal((await client(base, 'localhost:' + port).get('/api/admin/collusion')).status, 403);
  // the old signed proof still works alongside
  const signedState = await request(base, 'POST', '/api/owner/state',
    { headers: { 'Content-Type': 'application/json' }, body: proofFor(owner, 'state', {}) });
  assert.equal(signedState.status, 200);

  // alerts: a ticket per socket, and the same ticket twice registers nothing
  const refused = () => (out.text.match(/owner alerts refused/g) || []).length;
  const joinWith = (ticket) => new Promise((res) => {
    const s = ioClient(base, { forceNew: true, reconnection: false, timeout: 5000 });
    socks.push(s);
    s.on('connect', () => { s.emit('lobby:join', { ownerTicket: ticket }); res(s); });
  });
  const tk = (await c.post('/api/owner/ticket', {})).body.ticket;
  assert.ok(tk);
  const s1 = await joinWith(tk);
  await sleep(500);
  assert.equal(refused(), 0, 'the ticket was accepted');
  const s2 = await joinWith((await c.post('/api/owner/ticket', {})).body.ticket);
  await sleep(300);
  assert.equal(refused(), 0, 'a second console tab is accepted too');
  await joinWith(tk);
  for (let i = 0; i < 20 && refused() === 0; i++) await sleep(150);
  assert.equal(refused(), 1, 'a spent ticket is refused');

  // revoke everything: both alert sockets are disconnected by the server and the cookie stops working
  const gone = (s) => new Promise((res) => { if (!s.connected) return res('already'); s.on('disconnect', (why) => res(why)); });
  const g1 = gone(s1);
  const g2 = gone(s2);
  const rv = await c.post('/api/owner/session/revoke', { all: true });
  assert.equal(rv.status, 200, rv.text);
  assert.equal(await Promise.race([g1, sleep(5000).then(() => 'still connected')]), 'io server disconnect');
  assert.equal(await Promise.race([g2, sleep(5000).then(() => 'still connected')]), 'io server disconnect');
  c.jar.set('ds_owner', login.headers['set-cookie'].find((s) => s.startsWith('ds_owner=')).split(';')[0].slice('ds_owner='.length));
  assert.equal((await c.post('/api/owner/state', {})).status, 403, 'a revoked cookie is not the owner');
  assert.equal((await c.get('/api/owner/session')).body.signedIn, false);
});
