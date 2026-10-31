'use strict';
/* dsAuto.js: marks OUR test clients so the owner's live view (Control, Live tab) shows them on its greyed "Our test
   clients" line instead of counting them as real people (server/autoMark.js has the rules).

   The signing key exists only on Owen's PC: the env var DS_AUTOMATION_KEY, else the file ~/.duelseries/automation-key
   (PKCS8 DER, base64). Never commit it: this repo is public. Without the key every function here returns null and the
   client simply counts as a person, as before.

   In a script:
     const dsAuto = require('./lib/dsAuto');
     io(url, { extraHeaders: dsAuto.headers() })              socket.io-client in Node
     context.addCookies(dsAuto.cookies('https://duelseries.com'))   Playwright
   A browser you drive by hand (the in-app browser): open the URL `node scripts/lib/dsAuto.js` prints, once. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'ds_auto';
const PREFIX = 'duelseries-test-client|v1|';
const KEY_FILE = path.join(os.homedir(), '.duelseries', 'automation-key');

function privateKey() {
  let b64 = typeof process.env.DS_AUTOMATION_KEY === 'string' ? process.env.DS_AUTOMATION_KEY.trim() : '';
  if (!b64) { try { b64 = fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch (_) { b64 = ''; } }
  if (!b64) return null;
  try { return crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' }); }
  catch (_) { return null; }
}

// A token good for `hours` (default 48, at most 30 days), or null without the key.
function token(hours) {
  const k = privateKey();
  if (!k) return null;
  const h = Math.min(30 * 24, Math.max(1, Number(hours) || 48));
  const exp = String(Math.floor(Date.now() / 1000 + h * 3600));
  return 'v1.' + exp + '.' + crypto.sign(null, Buffer.from(PREFIX + exp), k).toString('base64url');
}

// { cookie: 'ds_auto=...' } for socket.io-client's extraHeaders, or {} without the key.
function headers(hours) {
  const t = token(hours);
  return t ? { cookie: COOKIE + '=' + t } : {};
}

// Playwright's context.addCookies list for a site, or [] without the key.
function cookies(url, hours) {
  const t = token(hours);
  return t ? [{ name: COOKIE, value: t, url: url || 'https://duelseries.com', httpOnly: true, secure: true, sameSite: 'Lax' }] : [];
}

// The page that marks a browser by hand, or null without the key.
function markUrl(base, hours) {
  const t = token(hours || 30 * 24);
  return t ? (base || 'https://duelseries.com') + '/api/auto/mark?t=' + encodeURIComponent(t) : null;
}

module.exports = { COOKIE, KEY_FILE, privateKey, token, headers, cookies, markUrl };

if (require.main === module) {
  const u = markUrl(process.argv[2]);
  if (!u) {
    console.error('No key: set DS_AUTOMATION_KEY or put it in ' + KEY_FILE);
    process.exit(1);
  }
  console.log(u);
}
