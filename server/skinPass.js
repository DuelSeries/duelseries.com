'use strict';
/* The skin pass: how a game server knows a player owns the paid skin they ask to wear (docs/skin-purchases.md).

   The lobby gets one from POST /api/skins/pass with a one-time signature by the wallet, and the server writes in it
   the items that wallet owns at that moment (cosmetics_owned), with an expiry, under an HMAC only this server can
   make. A game page sends the pass and the skin it wants in its join; the game's server calls wornSkin(), which is
   synchronous and reads no database, and wears the skin only when the pass is genuine, unexpired and lists it.
   Anything else (no pass, a forged or edited one, an expired one, a skin it does not list) is the game's free look:
   the lock lives on the server, never only in the page.

   Token: base64url(JSON {v, w, i, x}) + '.' + base64url(HMAC-SHA256). The key is derived from SESSION_SECRET (set
   on every real server; production refuses to boot without it), so passes survive a restart. Without it (a dev PC,
   the tests) a random key per process: a restart only means the lobby fetches a new pass. */
const crypto = require('crypto');
const catalog = require('./skinCatalog');

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN = 4096;
const MAX_ITEMS = 200;

function keyFrom(secret) {
  if (typeof secret === 'string' && secret) return crypto.createHmac('sha256', secret).update('duelseries skin pass v1').digest();
  return crypto.randomBytes(32);
}

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function createSkinPass({ secret = process.env.SESSION_SECRET, now = () => Date.now(), ttlMs = TTL_MS } = {}) {
  const key = keyFrom(secret);
  const mac = (body) => crypto.createHmac('sha256', key).update(body).digest();

  // A pass for `wallet` listing `items` (each '<game>:<skin>'). Returns { pass, exp }.
  function mint(wallet, items) {
    if (typeof wallet !== 'string' || !wallet) throw new Error('skinPass: wallet required');
    const list = (Array.isArray(items) ? items : []).filter((s) => typeof s === 'string' && s.length <= 49).slice(0, MAX_ITEMS);
    const exp = now() + ttlMs;
    const body = b64u(JSON.stringify({ v: 1, w: wallet, i: list, x: exp }));
    return { pass: body + '.' + b64u(mac(body)), exp };
  }

  // { wallet, items, exp } for a genuine unexpired pass, else null. Never throws.
  function read(token) {
    try {
      if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) return null;
      const dot = token.indexOf('.');
      if (dot < 1 || dot !== token.lastIndexOf('.')) return null;
      const body = token.slice(0, dot);
      const got = unb64u(token.slice(dot + 1));
      const want = mac(body);
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
      const p = JSON.parse(unb64u(body).toString('utf8'));
      if (!p || p.v !== 1 || typeof p.w !== 'string' || !Array.isArray(p.i) || !Number.isFinite(p.x)) return null;
      if (p.x <= now()) return null;
      return { wallet: p.w, items: p.i.filter((s) => typeof s === 'string'), exp: p.x };
    } catch (_) {
      return null;
    }
  }

  /* The paid skin a join may wear in `game`: `skin` when `token` is a genuine pass listing '<game>:<skin>' and the
     game prices that skin, else null (the free look). For game servers: synchronous, no database, never throws. */
  function wornSkin(game, skin, token) {
    if (typeof skin !== 'string' || !catalog.ID.test(skin) || typeof game !== 'string') return null;
    if (!catalog.skinsOf(game).includes(skin)) return null;
    const p = read(token);
    return p && p.items.includes(game + ':' + skin) ? skin : null;
  }

  // The same, from a join's plain-object fields { shop, skinPass } (a socket.io handshake's auth, or a join message).
  function wornFrom(game, fields) {
    if (!fields || typeof fields !== 'object') return null;
    return wornSkin(game, fields.shop, fields.skinPass);
  }

  return { mint, read, wornSkin, wornFrom, TTL_MS: ttlMs };
}

// One per process: every game server and the /api/skins/pass route share it.
let shared = null;
function sharedPass() { return shared || (shared = createSkinPass()); }

module.exports = { createSkinPass, sharedPass, TTL_MS };
