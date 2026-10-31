'use strict';
/* The web-surface fixes of the 2026-10-15 security review (fix-web):
   1. base58 decode is quadratic, so a wallet or signature string longer than a key or signature can be is refused
      before any decode (server/b58Caps.js, ownerAuth, nameProof).
   2. X-Forwarded-For is believed only from a loopback or private peer (server/clientAddr.js, and express's
      'trust proxy' in server/index.js).
   3. Security headers on every response (server/securityHeaders.js).
   4. The lobby's postMessage listeners answer only the game frame, on our own origin (public/js/v2/play.js).
   5. Names: the client escape helpers escape quotes; cleanNick strips <>"'&.
   The REAL modules are tested, not copies of their logic. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const express = require('express');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;

const { isWalletString, isSigString, MAX_WALLET_CHARS, MAX_SIG_CHARS } = require('../server/b58Caps');
const ownerAuth = require('../server/ownerAuth');
const nameProof = require('../server/nameProof');
const { clientAddress, socketClientIp, isTrustedPeer, bareIp, TRUST_PROXY } = require('../server/clientAddr');
const { securityHeaders } = require('../server/securityHeaders');
const { cleanNick } = require('../server/sl/slNames');
const { lobbyHarness } = require('./v2LobbyHarness');

const ROOT = path.join(__dirname, '..');
const MB = 'z'.repeat(1 << 20);                      // 1 MB of a VALID base58 character: the worst case
const addrOf = (priv) => bs58.encode(ed25519.getPublicKey(priv));

function timed(fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

// ── 1. base58 caps ───────────────────────────────────────────────────────────────────────────────────────────────

test('the caps are the base58 size of a 32-byte key and a 64-byte signature', () => {
  assert.strictEqual(MAX_WALLET_CHARS, 44);
  assert.strictEqual(MAX_SIG_CHARS, 88);
  // The largest possible values encode to exactly the cap.
  assert.strictEqual(bs58.encode(new Uint8Array(32).fill(255)).length, 44);
  assert.strictEqual(bs58.encode(new Uint8Array(64).fill(255)).length, 88);
  for (let i = 0; i < 50; i++) {
    const priv = ed25519.utils.randomPrivateKey();
    const w = addrOf(priv);
    const s = bs58.encode(ed25519.sign(new Uint8Array([i]), priv));
    assert.ok(isWalletString(w), w);
    assert.ok(isSigString(s), s);
  }
  for (const bad of ['', 'z'.repeat(45), '0OIl' + 'z'.repeat(30), null, undefined, 7, {}, ['abc'], MB])
    assert.strictEqual(isWalletString(bad), false, String(bad).slice(0, 20));
  assert.strictEqual(isSigString('z'.repeat(89)), false);
  assert.strictEqual(isSigString(MB), false);
});

test('a 1 MB wallet or signature is refused by both verifiers in well under 50 ms', () => {
  const wallet = addrOf(ed25519.utils.randomPrivateKey());
  const ts = Date.now();
  const cases = [
    ['ownerAuth wallet', () => ownerAuth.walletForAction({ wallet: MB, sig: 'x', action: 'a', ts })],
    ['ownerAuth sig', () => ownerAuth.walletForAction({ wallet, sig: MB, action: 'a', ts })],
    ['nameProof wallet', () => nameProof.verifyNameProof({ wallet: MB, sig: 'x', name: 'n', ts })],
    ['nameProof sig', () => nameProof.verifyNameProof({ wallet, sig: MB, name: 'n', ts })],
    // just past the cap: still refused before any decode
    ['ownerAuth 45 chars', () => ownerAuth.walletForAction({ wallet: 'z'.repeat(45), sig: 'x', action: 'a', ts })],
    ['nameProof 89 chars', () => nameProof.verifyNameProof({ wallet, sig: 'z'.repeat(89), name: 'n', ts })],
  ];
  for (const [label, fn] of cases) {
    const { out, ms } = timed(fn);
    assert.strictEqual(out, null, label);
    assert.ok(ms < 50, label + ' took ' + ms.toFixed(1) + ' ms');
  }
});

test('honest proofs still verify through both verifiers', () => {
  const priv = ed25519.utils.randomPrivateKey();
  const wallet = addrOf(priv);
  const ts = Date.now();
  const nameSig = bs58.encode(ed25519.sign(new TextEncoder().encode(nameProof.nameMessage(wallet, 'Owen', ts)), priv));
  assert.strictEqual(nameProof.verifyNameProof({ wallet, name: 'Owen', ts, sig: nameSig }), wallet);
  const args = { n: 5 };
  const actSig = bs58.encode(ed25519.sign(new TextEncoder().encode(ownerAuth.actionMessage('bots', args, wallet, ts)), priv));
  assert.strictEqual(ownerAuth.walletForAction({ wallet, sig: actSig, action: 'bots', args, ts }), wallet);
});

// ── 2. client addresses ──────────────────────────────────────────────────────────────────────────────────────────

test('X-Forwarded-For is ignored from a public peer and believed from loopback or private', () => {
  // a public peer is the client itself, whatever it claims
  assert.strictEqual(clientAddress('203.0.113.9', '1.2.3.4'), '203.0.113.9');
  assert.strictEqual(clientAddress('::ffff:203.0.113.9', '1.2.3.4'), '203.0.113.9');
  assert.strictEqual(clientAddress('2001:db8::5', '1.2.3.4'), '2001:db8::5');
  assert.strictEqual(clientAddress('172.32.0.1', '1.2.3.4'), '172.32.0.1', '172.32 is not private');
  // the proxy's peer: the last hop is the one nginx wrote
  assert.strictEqual(clientAddress('127.0.0.1', '6.6.6.6, 8.8.8.8'), '8.8.8.8');
  assert.strictEqual(clientAddress('::ffff:127.0.0.1', '8.8.8.8'), '8.8.8.8');
  assert.strictEqual(clientAddress('::1', '8.8.8.8'), '8.8.8.8');
  assert.strictEqual(clientAddress('172.31.20.4', '1.1.1.1, 9.9.9.9'), '9.9.9.9');
  assert.strictEqual(clientAddress('::ffff:172.31.20.4', ' 9.9.9.9 '), '9.9.9.9');
  assert.strictEqual(clientAddress('10.0.0.1', '::ffff:7.7.7.7'), '7.7.7.7');
  assert.strictEqual(clientAddress('192.168.1.2', '2001:db8::9'), '2001:db8::9');
  // no header, an empty hop, or a hop that is not an address: the peer
  assert.strictEqual(clientAddress('127.0.0.1', undefined), '127.0.0.1');
  assert.strictEqual(clientAddress('127.0.0.1', '1.2.3.4, '), '127.0.0.1');
  assert.strictEqual(clientAddress('127.0.0.1', 'not-an-ip'), '127.0.0.1');
  assert.strictEqual(clientAddress('127.0.0.1', ['1.2.3.4']), '127.0.0.1');

  assert.ok(isTrustedPeer('fd12:3456::1') && isTrustedPeer('fc00::1'));
  assert.ok(!isTrustedPeer('fc0::1') && !isTrustedPeer('fe80::1') && !isTrustedPeer(''));
  assert.strictEqual(bareIp('::FFFF:1.2.3.4'), '1.2.3.4');

  const sock = (address, xff) => ({ handshake: { address, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } } });
  assert.strictEqual(socketClientIp(sock('203.0.113.9', '1.2.3.4')), '203.0.113.9');
  assert.strictEqual(socketClientIp(sock('::ffff:127.0.0.1', '1.2.3.4')), '1.2.3.4');
  assert.strictEqual(socketClientIp({}), '');
});

test('the per-address socket caps use the shared rule (a public peer cannot spoof its way past them)', () => {
  const ag = require('../server/ag/agSockets');
  const sl = require('../server/sl/slSockets');
  const spoof = { handshake: { address: '203.0.113.9', headers: { 'x-forwarded-for': '5.5.5.5' } } };
  const proxied = { handshake: { address: '127.0.0.1', headers: { 'x-forwarded-for': '5.5.5.5' } } };
  for (const clientIp of [ag.clientIp, sl.clientIp]) {
    assert.strictEqual(clientIp(spoof), '203.0.113.9');
    assert.strictEqual(clientIp(proxied), '5.5.5.5');
  }
});

test("express's trust proxy setting agrees: a public peer's X-Forwarded-For is not believed", () => {
  const proxyaddr = require('proxy-addr');
  const app = express();
  app.set('trust proxy', TRUST_PROXY);
  const trust = app.get('trust proxy fn');
  const ipOf = (peer, xff) => proxyaddr({ connection: { remoteAddress: peer }, socket: { remoteAddress: peer },
    headers: xff ? { 'x-forwarded-for': xff } : {} }, trust);
  assert.strictEqual(ipOf('203.0.113.9', '1.2.3.4'), '203.0.113.9');
  assert.strictEqual(ipOf('127.0.0.1', '1.2.3.4'), '1.2.3.4');
  assert.strictEqual(ipOf('172.31.20.4', '6.6.6.6, 1.2.3.4'), '1.2.3.4');
  assert.strictEqual(ipOf('::ffff:172.31.20.4', '1.2.3.4'), '1.2.3.4');
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.match(src, /app\.set\('trust proxy', TRUST_PROXY\)/, 'server/index.js uses the shared setting');
  assert.doesNotMatch(src, /app\.set\('trust proxy', 1\)/);
});

// ── 3. security headers ──────────────────────────────────────────────────────────────────────────────────────────

function get(port, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers }, (r) => {
      r.resume();
      r.on('end', () => resolve(r.headers));
    }).on('error', reject);
  });
}

test('every response carries the frame, sniffing and referrer headers; HSTS only over https', async () => {
  const app = express();
  app.set('trust proxy', TRUST_PROXY);
  app.use(securityHeaders);
  app.get('/', (req, res) => res.json({ ip: req.ip }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const port = server.address().port;
    const plain = await get(port, {});
    assert.strictEqual(plain['content-security-policy'], "frame-ancestors 'self'");
    assert.strictEqual(plain['x-frame-options'], 'SAMEORIGIN');
    assert.strictEqual(plain['x-content-type-options'], 'nosniff');
    assert.strictEqual(plain['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.strictEqual(plain['strict-transport-security'], undefined, 'never on plain http');
    const tls = await get(port, { 'X-Forwarded-Proto': 'https' });   // nginx, on loopback, says the player came in on https
    assert.strictEqual(tls['strict-transport-security'], 'max-age=15552000');
    assert.doesNotMatch(plain['content-security-policy'], /script-src|default-src/, 'no script policy (Privy)');
  } finally {
    server.close();
  }
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.match(src, /app\.use\(securityHeaders\)/, 'server/index.js mounts it');
});

test('HSTS reaches duelseries.com behind an nginx that sends no X-Forwarded-Proto (req.secure is false there)', async () => {
  const app = express();
  app.set('trust proxy', TRUST_PROXY);
  app.use(securityHeaders);
  app.get('/', (req, res) => res.json({ secure: req.secure }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const port = server.address().port;
    for (const host of ['duelseries.com', 'DuelSeries.com:443', 'eu.duelseries.com', 'www.duelseries.com']) {
      assert.strictEqual((await get(port, { Host: host }))['strict-transport-security'], 'max-age=15552000', host);
    }
    for (const host of ['localhost:3000', '127.0.0.1', 'notduelseries.com', 'duelseries.com.evil.test', 'evil.test']) {
      assert.strictEqual((await get(port, { Host: host }))['strict-transport-security'], undefined, host);
    }
  } finally {
    server.close();
  }
});

// ── 4. the lobby's postMessage listeners ─────────────────────────────────────────────────────────────────────────

test('duel:signaction is answered only for the game frame on our own origin', async () => {
  const h = lobbyHarness([]);
  const ORIGIN = 'https://duelseries.com';
  h.win.location = { origin: ORIGIN };
  const frame = h.el('game-frame');
  const posted = [];
  frame.contentWindow = { postMessage: (m, o) => posted.push([m, o]) };
  const signed = [];
  h.win.duelWalletSignAction = async (action, args) => { signed.push([action, args]); return { sig: 'S' }; };
  const send = (source, origin, action) => h.win.dispatchEvent({ type: 'message', data: { type: 'duel:signaction', id: 1, action: action || 'br:start', args: {} }, source, origin });

  send({ postMessage() {} }, ORIGIN);          // a window that is not the game frame
  send(frame.contentWindow, 'https://evil.test');
  send(frame.contentWindow, 'null');
  send(undefined, ORIGIN);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(signed, [], 'nothing signs for a stranger');
  assert.deepStrictEqual(posted, []);

  send(frame.contentWindow, ORIGIN);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(signed, [['br:start', {}]]);
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0][0].type, 'duel:signaction:done');
  assert.strictEqual(posted[0][1], ORIGIN, 'the answer goes to our own origin only');
  // only what a game has reason to sign (play:identify, br:start): never an owner console action
  send(frame.contentWindow, ORIGIN, 'maintenance');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(signed, [['br:start', {}]], 'the wallet never signs a console action for a frame');
  assert.strictEqual(posted[1][0].type, 'duel:signaction:error');
});

// The owner session (server/ownerSession.js) is a year-long sign-in, made only by the console page: even our own game
// frame cannot have the lobby's silent signer make 'owner:session:*' signatures. Everything else it asks still signs.
test('duel:signaction never signs an owner session sign-in or sign-out for a game frame', async () => {
  const h = lobbyHarness([]);
  const ORIGIN = 'https://duelseries.com';
  h.win.location = { origin: ORIGIN };
  const frame = h.el('game-frame');
  const posted = [];
  frame.contentWindow = { postMessage: (m, o) => posted.push([m, o]) };
  const signed = [];
  h.win.duelWalletSignAction = async (action, args) => { signed.push([action, args]); return { sig: 'S' }; };
  const ask = (action) => h.win.dispatchEvent({ type: 'message', data: { type: 'duel:signaction', id: 7, action, args: {} },
    source: frame.contentWindow, origin: ORIGIN });
  ask('owner:session:create');
  ask('owner:session:revoke');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(signed, [], 'nothing signed');
  assert.strictEqual(posted.length, 2);
  for (const [m, o] of posted) {
    assert.strictEqual(m.type, 'duel:signaction:error');
    assert.strictEqual(o, ORIGIN);
  }
  ask('br:start');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(signed, [['br:start', {}]], 'the in-game Start match still signs');
});

test('game:done closes the frames only when a game frame on our origin sends it', async () => {
  const h = lobbyHarness([]);
  const ORIGIN = 'https://duelseries.com';
  h.win.location = { origin: ORIGIN };
  const frame = h.el('agar-frame');
  frame.style.display = 'block';
  frame.src = '/ag';
  h.win.dispatchEvent({ type: 'message', data: 'game:done', source: {}, origin: ORIGIN });
  h.win.dispatchEvent({ type: 'message', data: 'game:done', source: frame.contentWindow, origin: 'https://evil.test' });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(frame.src, '/ag', 'a stranger cannot close the game');
  assert.strictEqual(frame.style.display, 'block');
  h.win.dispatchEvent({ type: 'message', data: 'game:done', source: frame.contentWindow, origin: ORIGIN });
  assert.strictEqual(frame.style.display, 'none');
  // emptied a tick later, after the message's other listeners (test/lobbyFrameBack.test.js)
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(frame.src, '');
});

test('every window message listener in public/js checks where the message came from', () => {
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'public/js'));
  // agMain hands every message to agPaid's onMessage, which holds the checks.
  const checkedIn = { 'public/js/ag/agMain.js': 'public/js/ag/agPaid.js' };
  const unchecked = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (!/addEventListener\(\s*['"]message['"]/.test(fs.readFileSync(f, 'utf8'))) continue;
    const src = fs.readFileSync(path.join(ROOT, checkedIn[rel] || rel), 'utf8');
    if (!/e\.origin\s*!==/.test(src) || !/e\.source\s*!==/.test(src)) unchecked.push(rel);
  }
  assert.deepStrictEqual(unchecked, []);
});

// ── 5. names ─────────────────────────────────────────────────────────────────────────────────────────────────────

function lift(src, name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at >= 0, 'still has a function called ' + name);
  let depth = 0;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}

test("game.js escape helpers escape both quotes, so a name cannot leave its attribute", () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/game.js'), 'utf8');
  const box = {};
  vm.createContext(box);
  vm.runInContext(['escapeHtml', 'escHtmlLocal', 'escHtml'].map((n) => lift(src, n)).join('\n'), box);
  const evil = `a" onmouseover="x()' <b>&`;
  for (const n of ['escapeHtml', 'escHtmlLocal', 'escHtml']) {
    const out = box[n](evil);
    assert.strictEqual(out, 'a&quot; onmouseover=&quot;x()&#39; &lt;b&gt;&amp;', n);
  }
});

test('the other name escapers in public/js escape quotes too', () => {
  const want = [
    ['public/js/v2/board.js', /const esc = [\s\S]*?&quot;[\s\S]*?&#39;/],
    ['public/js/v2/social.js', /const esc = [\s\S]*?&quot;[\s\S]*?&#39;/],
    ['public/js/v2/wallet.js', /const esc = [\s\S]*?&quot;[\s\S]*?&#39;/],
    ['public/js/shooter.js', /function esc\(t\)[\s\S]*?&quot;[\s\S]*?&#39;/],
  ];
  for (const [f, re] of want) assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), re, f);
});

test('cleanNick strips < > " \' & (what reaches the database is never markup)', () => {
  assert.strictEqual(cleanNick('<b>x</b>'), 'bx/b');
  assert.strictEqual(cleanNick(`a"b'c&d`), 'abcd');
  assert.strictEqual(cleanNick('plain name'), 'plain name');
  assert.strictEqual(cleanNick('<<>>'), '');
});
