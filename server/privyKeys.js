'use strict';
/* ─── Privy sign-in tokens, checked with Privy's PUBLIC keys only ────────────────────────────────────────────────────
   2026-11-02. From 11-01 every Privy token the live server saw was rejected ("Unable to complete request"), Owen's
   own phone sign-in included. The tokens were fine. @privy-io/server-auth fetches the key it checks them with from
   Privy's REST API using the app SECRET, the secret on the box had gone bad, so Privy answered 403 and every check
   failed before a token was even looked at.

   The key does not need the secret. Privy publishes it, unauthenticated, at
   https://auth.privy.io/api/v1/apps/<app id>/jwks.json, so this module loads that set at boot, keeps it, and checks
   both tokens itself with jose (the same library and the same rules @privy-io/server-auth uses: ES256 only, issuer
   privy.io, audience our app id, expiry). A bad or rotated secret can no longer stop anyone signing in.

     - The key set is fetched from that one fixed URL, built from the server's own PRIVY_APP_ID. Nothing in a token
       (kid, jku, x5u, alg) can point it anywhere else; a token's kid only picks among keys Privy already gave us.
     - A fetch that fails, or answers anything but a valid set of P-256 signing keys, never replaces the keys held.
     - An unknown kid, or a signature none of the held keys accepts, asks Privy again (Privy rotated), at most once
       per REFETCH_COOLDOWN_MS however many tokens arrive, with one fetch in flight at a time. A flood of forged
       tokens is a flood of failed signature checks and one fetch every 30 s, never a fetch per token.
     - The held set is refreshed in the background once it is MAX_AGE_MS old, so a key Privy withdraws stops
       being accepted within hours.

   verifyAccess(token)   -> { userId, sessionId, expiration }    the access token (Authorization: Bearer)
   verifyIdentity(token) -> { userId, linkedAccounts }            the identity token (privy-id-token), whose
                                                                  linked accounts carry the player's wallets, so
                                                                  no REST lookup is needed to name the player.
   Both throw on anything that is not a good, current token for this app; e.kind says why in a word (kindOf). */

const crypto = require('crypto');
const jose = require('jose');

const ISSUER = 'privy.io';
const ALG = 'ES256';
const REFETCH_COOLDOWN_MS = 30 * 1000;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY = 64 * 1024;
const MAX_KEYS = 20;

function jwksUrl(appId) {
  return 'https://auth.privy.io/api/v1/apps/' + encodeURIComponent(appId) + '/jwks.json';
}

/* A Privy key set -> Map(kid -> KeyObject), or null when the answer is not one. Only EC P-256 signing keys
   that say (or do not deny) ES256; anything else in the set is skipped, and a set with none left is no set. */
function parseJwks(body) {
  const keys = body && Array.isArray(body.keys) ? body.keys : null;
  if (!keys) return null;
  const out = new Map();
  for (const k of keys.slice(0, MAX_KEYS)) {
    if (!k || typeof k !== 'object' || k.kty !== 'EC' || k.crv !== 'P-256') continue;
    if (typeof k.x !== 'string' || typeof k.y !== 'string') continue;
    if (k.alg !== undefined && k.alg !== ALG) continue;
    if (k.use !== undefined && k.use !== 'sig') continue;
    const kid = typeof k.kid === 'string' && k.kid.length > 0 && k.kid.length <= 200 ? k.kid : null;
    if (!kid || out.has(kid)) continue;
    try {
      // Public members only: a d (private part) in the answer is dropped, never imported.
      out.set(kid, crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: k.x, y: k.y }, format: 'jwk' }));
    } catch (_) { /* not a point on the curve */ }
  }
  return out.size ? out : null;
}

async function defaultFetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error('jwks http ' + res.status);
  const text = await res.text();
  if (text.length > MAX_BODY) throw new Error('jwks answer too large');
  return JSON.parse(text);
}

function fail(kind, message) {
  const e = new Error(message || kind);
  e.kind = kind;
  return e;
}

/* One word for why a token was refused: the [AUTH] alarm counts these, the log line names them. */
function kindOf(e) {
  if (e && e.kind) return e.kind;
  const code = e && e.code;
  if (code === 'ERR_JWT_EXPIRED') return 'expired';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') return 'wrong-' + ((e && e.claim) || 'claim');
  if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') return 'bad-signature';
  if (code === 'ERR_JOSE_ALG_NOT_ALLOWED') return 'wrong-alg';
  return 'malformed';
}

function createPrivyKeys(opts) {
  const o = opts || {};
  const appId = String(o.appId || '');
  if (!appId) throw new Error('createPrivyKeys: appId is required');
  const fetchJson = typeof o.fetchJson === 'function' ? o.fetchJson : defaultFetchJson;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const log = o.log || console;
  const url = jwksUrl(appId);

  let keys = new Map();
  let loadedAt = 0;
  let triedAt = -Infinity;
  let lastError = null;
  let inflight = null;

  /* Ask Privy for the key set. Resolves true when a NEW valid set was taken in this call, false when it was
     on cooldown, failed, or came back unusable (the held keys stay). Never rejects. */
  function refresh() {
    if (inflight) return inflight;
    if (now() - triedAt < REFETCH_COOLDOWN_MS) return Promise.resolve(false);
    triedAt = now();
    inflight = (async () => {
      try {
        const next = parseJwks(await fetchJson(url));
        if (!next) throw new Error('jwks answer had no usable ES256 keys');
        keys = next;
        loadedAt = now();
        lastError = null;
        return true;
      } catch (e) {
        lastError = (e && e.message) || String(e);
        log.warn('[AUTH] Privy key set fetch failed (keeping ' + keys.size + ' held key(s)):', lastError);
        return false;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function candidates(kid) {
    if (kid !== undefined) return keys.has(kid) ? [keys.get(kid)] : [];
    return [...keys.values()];   // a token naming no key: try each one held (a handful at most)
  }

  /* jose's own checks, on a key we chose. typ is checked on access tokens only, as @privy-io/server-auth does. */
  async function check(token, typ) {
    if (typeof token !== 'string' || !token || token.length > 16384) throw fail('malformed');
    let header;
    try { header = jose.decodeProtectedHeader(token); } catch (_) { throw fail('malformed'); }
    if (!header || header.alg !== ALG) throw fail('wrong-alg');
    const kid = typeof header.kid === 'string' ? header.kid : undefined;
    if (loadedAt && now() - loadedAt > MAX_AGE_MS) refresh();   // background; this token uses the held set
    const opts = { algorithms: [ALG], issuer: ISSUER, audience: appId };
    if (typ) opts.typ = typ;
    const attempt = async () => {
      const list = candidates(kid);
      if (!list.length) throw fail(keys.size ? 'unknown-key' : 'no-keys');
      let last = null;
      for (const key of list) {
        try { return (await jose.jwtVerify(token, key, opts)).payload; }
        catch (e) {
          last = e;
          // Only a signature failure is worth another key; an expired or wrong-audience token is that on every key.
          if (kindOf(e) !== 'bad-signature') throw e;
        }
      }
      throw last;
    };
    try {
      return await attempt();
    } catch (e) {
      const k = kindOf(e);
      if ((k === 'unknown-key' || k === 'no-keys' || k === 'bad-signature') && await refresh()) return attempt();
      /* A kid we do not hold while Privy's key set will not load: Privy may have rotated and we cannot follow.
         Ours to fix, so the [AUTH] alarm counts it (an unknown kid alone is anyone's to send). */
      if (k === 'unknown-key' && lastError) throw fail('keys-stale', 'unknown key and the key set will not load: ' + lastError);
      throw e;
    }
  }

  async function verifyAccess(token) {
    const p = await check(token, 'JWT');
    if (typeof p.sub !== 'string' || !p.sub) throw fail('malformed', 'token has no subject');
    return { userId: p.sub, sessionId: p.sid || null, expiration: p.exp };
  }

  async function verifyIdentity(token) {
    const p = await check(token, null);
    if (typeof p.sub !== 'string' || !p.sub) throw fail('malformed', 'token has no subject');
    // Privy sends linked_accounts as a JSON string; an access token has none, so it is not an identity token.
    let linked = p.linked_accounts;
    if (typeof linked === 'string') {
      try { linked = JSON.parse(linked); } catch (_) { throw fail('malformed', 'identity token linked_accounts unreadable'); }
    }
    if (!Array.isArray(linked)) throw fail('not-identity', 'no linked accounts: not an identity token');
    return { userId: p.sub, linkedAccounts: linked };
  }

  function status() {
    return { keys: keys.size, kids: [...keys.keys()], loadedAt: loadedAt || null, lastError };
  }

  return { refresh, verifyAccess, verifyIdentity, status, url };
}

module.exports = { createPrivyKeys, parseJwks, kindOf, jwksUrl, REFETCH_COOLDOWN_MS, MAX_AGE_MS };
