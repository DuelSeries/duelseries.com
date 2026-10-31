'use strict';
/* autoMark.js: is this client one of OUR test tools? (Owen 2026-10-30: join alerts named xXRiftXx, which was our own
   video recorder, not a person.)

   Our tools (the video tool's recorder, headless test harnesses, a browser a Claude session tests in) carry a cookie,
   ds_auto, holding a short-lived token signed with a private key that exists only on Owen's PC (the env var
   DS_AUTOMATION_KEY, or the file ~/.duelseries/automation-key; scripts/lib/dsAuto.js makes tokens). The server holds
   only the PUBLIC key below, so the repo being public gives nobody a way to mint one. The cookie rides every
   same-origin socket handshake, so no game page or protocol changes.

   What a valid token does: the owner's live view (server/livePlayers.js) shows that client on a greyed "Our test
   clients" line instead of counting it as a real person. Nothing else reads it: it opens no door, skips no check and
   changes no game or money path. A forged or expired token is simply not a test client.

   Token: v1.<expiry, unix seconds>.<Ed25519 signature, base64url> over MESSAGE_PREFIX + expiry. At most MAX_LIFE_S
   ahead, so a token that leaks stops working on its own. DS_AUTO_PUBKEY (SPKI DER, base64) overrides the key. */

const crypto = require('crypto');

const PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEA5kNsMhvTGyhURE8Ckdm3XpbIMs6v7YkoriNKZjp9Du8=';
const COOKIE = 'ds_auto';
const HEADER = 'x-ds-auto';
const MESSAGE_PREFIX = 'duelseries-test-client|v1|';
const MAX_LIFE_S = 31 * 24 * 3600;
const MAX_LEN = 200;
const CACHE_MAX = 500;

let keyB64 = null;
let key = null;
function publicKey() {
  const want = typeof process.env.DS_AUTO_PUBKEY === 'string' && process.env.DS_AUTO_PUBKEY.trim()
    ? process.env.DS_AUTO_PUBKEY.trim() : PUBLIC_KEY_B64;
  if (key && keyB64 === want) return key;
  keyB64 = want;
  key = crypto.createPublicKey({ key: Buffer.from(want, 'base64'), format: 'der', type: 'spki' });
  cache.clear();
  return key;
}

const cache = new Map(); // token -> expiry (s) of a token whose signature checked out

// -> the token's expiry in unix seconds when it is a valid, unexpired token, else 0. Never throws.
function expiryOf(token, nowMs) {
  try {
    if (typeof token !== 'string' || !token || token.length > MAX_LEN) return 0;
    const now = Math.floor((typeof nowMs === 'number' ? nowMs : Date.now()) / 1000);
    const k = publicKey();
    let exp = cache.get(token);
    if (exp === undefined) {
      const m = /^v1\.(\d{9,11})\.([A-Za-z0-9_-]{80,90})$/.exec(token);
      if (!m) return 0;
      exp = Number(m[1]);
      if (!crypto.verify(null, Buffer.from(MESSAGE_PREFIX + m[1]), k, Buffer.from(m[2], 'base64url'))) return 0;
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(token, exp);
    }
    return exp > now && exp <= now + MAX_LIFE_S ? exp : 0;
  } catch (_) {
    return 0;
  }
}

const valid = (token, nowMs) => expiryOf(token, nowMs) > 0;

// The ds_auto value in a Cookie header, or ''.
function fromCookie(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return '';
}

// The token a socket's handshake carries (its cookie, else the x-ds-auto header), or ''. Never throws.
function fromSocket(socket) {
  try {
    const hs = socket && socket.handshake && socket.handshake.headers;
    const rq = socket && socket.request && socket.request.headers;
    const hd = hs || rq || {};
    return fromCookie(hd.cookie) || (typeof hd[HEADER] === 'string' ? hd[HEADER].trim() : '');
  } catch (_) {
    return '';
  }
}

// Signing, for tests and for scripts/lib/dsAuto.js: privateKey is a KeyObject or PKCS8 DER base64.
function sign(privateKey, expSec) {
  const k = typeof privateKey === 'string'
    ? crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' }) : privateKey;
  const e = String(Math.floor(expSec));
  return 'v1.' + e + '.' + crypto.sign(null, Buffer.from(MESSAGE_PREFIX + e), k).toString('base64url');
}

module.exports = { COOKIE, HEADER, MESSAGE_PREFIX, MAX_LIFE_S, PUBLIC_KEY_B64, expiryOf, valid, fromCookie, fromSocket,
  sign };
