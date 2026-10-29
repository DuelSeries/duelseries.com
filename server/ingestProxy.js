'use strict';
/* ─── The PostHog reverse proxy (/ingest/*) ─────────────────────────────────────
   Analytics go through our own domain so ad blockers can't block tracking. It
   is mounted in server/index.js BEFORE the JSON body parser, so the raw request
   streams straight through untouched. /ingest/static/* goes to the posthog-js
   asset host; everything else (capture, flags, session recording) to the
   capture host.

   Night review 2026-10-29: it used to copy EVERY request header to PostHog,
   Cookie included, and every answer header back. posthog-init.js calls /ingest
   from the same origin, so the owner's year-long session cookie
   (__Host-ds_owner, Path=/) rode along on every analytics call whenever Owen
   played in the browser he signs in to the console with, and a PostHog
   Set-Cookie would have landed on duelseries.com. Now:
   - no credential leaves: Cookie, Authorization, the Privy tokens and our own
     X-DS-* / key headers are dropped before the request goes out (PostHog's
     own nginx guide clears Cookie and Authorization the same way). posthog-js
     sends its token and distinct_id in the body, so analytics are unchanged;
   - nothing comes back that could set or override ours: Set-Cookie, and the
     security headers server/securityHeaders.js already put on the answer;
   - only the paths posthog-js calls are relayed (the first path segment, and
     remote config for OUR project token only); anything else is a 404, so the
     proxy is not a way to put any PostHog URL under our origin;
   - a request body has a cap, and the bytes both ways count against the
     caller's address in the static byte budget (server/staticCache.js), the
     same meter as the big static files, since this relay is egress too;
   - (night review 2026-10-29, re-review) static/ is only the SDK files
     posthog-js loads, never a source map, and one address has at most 8
     calls relayed at once, so a parallel burst can't pass the budget together. */
const https = require('https');
const { addressKey, whenGone } = require('./staticCache');

const CAPTURE_HOST = 'us.i.posthog.com';
const ASSET_HOST = 'us-assets.i.posthog.com';
/* The project token in public/js/posthog-init.js (a write-only public key). test/ingestProxy.test.js checks the
   two still match. */
const POSTHOG_TOKEN = 'phc_rGiSHXN4HzBvzZaZhuFCwbmHFihkemTVcxK7MCPdDqgw';

/* The SDK files posthog-js loads from static/ (night review 2026-10-29): the snippet's array.js and the extension
   bundles it lazy-loads by name (static/<kind>.js: session recording, surveys, the toolbar, web vitals, dead
   clicks, exception capture and the rest). Nothing else on the asset host: 'static/' plus anything let a caller
   pick a 3 MB source map (array.full.js.map) and the bundle that is not used (array.full.js, 680 KB). */
const STATIC_FILES = ['array', 'recorder', 'posthog-recorder', 'lazy-recorder', 'surveys', 'toolbar', 'tracing-headers',
  'web-vitals', 'dead-clicks-autocapture', 'exception-autocapture', 'product-tours', 'conversations', 'logs'];
/* What posthog-js calls under its api_host: the SDK files above (static/), remote config (array/<token>/), capture
   (e/, i/v0/e/, batch/, capture/, track/, engage/), session recording (s/), flags (flags/, decide/) and the
   surveys / early-access / web-experiment reads (api/surveys, api/early_access_features, api/web_experiments).
   Matched on the path after /ingest. Only those three under api/ (night review 2026-10-29): the rest of PostHog's
   /api is its app's API, and an answer from it would come back under our origin with PostHog's Content-Type. */
const PATH_OK = new RegExp('^/(?:static/(?:' + STATIC_FILES.join('|') + ')\\.js$|array/' + POSTHOG_TOKEN + '/'
  + '|(?:e|i|s|batch|capture|track|engage|decide|flags)(?:/|$)'
  + '|api/(?:surveys|early_access_features|web_experiments)(?:/|$))');
/* Never relayed: a dot-dot segment, an encoded dot or slash, a backslash or an empty segment. posthog-js sends
   none of them, and each is a way to make the upstream resolve a path other than the one checked above. Nor a
   source map anywhere (night review 2026-10-29): posthog-js never fetches one and they are the biggest files. */
const PATH_ODD = /\.\.|%2e|%2f|%5c|\\|\/\/|\.map$/i;

/* Request headers that are a credential somewhere on this site, or could be one. */
const DROP_REQ = new Set(['cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'x-stats-secret']);
const DROP_REQ_PREFIX = /^(?:privy-|x-ds-)/;
/* Answer headers we never pass on: hop-by-hop ones, cookies, and the ones server/securityHeaders.js sets, so
   ours stay in force on a proxied answer. */
const DROP_RES = new Set(['connection', 'transfer-encoding', 'keep-alive', 'set-cookie', 'set-cookie2',
  'content-security-policy', 'x-frame-options', 'x-content-type-options', 'strict-transport-security',
  'referrer-policy']);

/* A session-recording batch is gzip-compressed by posthog-js and well under a megabyte; 10 MB is far above any
   honest request and stops one call from pushing an unbounded upload through the box. */
const MAX_BODY = 10 * 1024 * 1024;
/* A call to PostHog with nothing sent or received for this long is given up (night review 2026-10-29). */
const UPSTREAM_IDLE_MS = 30 * 1000;
/* One address's calls being relayed at once (night review 2026-10-29). The byte budget is checked when a call
   arrives, so parallel calls used to pass it together: 30 at once all went out (90 MB against a 6 MB budget).
   Past this many a call is refused at once, never queued, so a PostHog that hangs costs that address a moment of
   analytics and never a page load, and a burst overshoots the budget by at most this many SDK files. 8, as the
   static files' gate: a page load's array.js, config, flags, first events and lazy-loaded bundles fit, with room
   for a game iframe loading next to the lobby. The answer is a 503 with Retry-After, not a 429: posthog-js's
   retry queue sends a refused event again on a 5xx and drops it on a 4xx. */
const MAX_OPEN = 8;

function upstreamFor(reqPath) {
  const p = reqPath.replace(/^\/ingest/, '') || '/';
  if (PATH_ODD.test(p) || !PATH_OK.test(p)) return null;
  return { host: p.startsWith('/static/') ? ASSET_HOST : CAPTURE_HOST, path: p };
}

function forwardHeaders(reqHeaders, host) {
  const out = {};
  for (const [k, v] of Object.entries(reqHeaders || {})) {
    const name = k.toLowerCase();
    if (DROP_REQ.has(name) || DROP_REQ_PREFIX.test(name)) continue;
    out[name] = v;
  }
  out.host = host;
  return out;
}

function returnHeaders(upHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(upHeaders || {})) {
    if (!DROP_RES.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/* opts.request: https.request (a test passes a fake). opts.budget: the static byte budget, or null.
   opts.idleMs: how long a silent call to PostHog may last, opts.maxOpen: one address's calls at once (tests). */
function ingestProxy(opts = {}) {
  const request = opts.request || https.request;
  const budget = opts.budget || null;
  const maxBody = opts.maxBody || MAX_BODY;
  const idleMs = opts.idleMs || UPSTREAM_IDLE_MS;
  const maxOpen = opts.maxOpen || MAX_OPEN;
  const open = new Map();                             // address key -> calls being relayed now, only while > 0
  const ingest = function ingest(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return res.sendStatus(405);
    const up = upstreamFor(req.path);
    if (!up) return res.sendStatus(404);
    if (budget && budget.over(req)) return budget.refuse(req, res);
    const declared = Number(req.headers['content-length']);
    if (declared > maxBody) return res.sendStatus(413);
    // One address's calls at once (MAX_OPEN above). nginx itself and local calls have no key and no cap, as in
    // the byte budget. A call's place is freed when it is over for good: answered, or its caller gone.
    const key = addressKey(req);
    if (key) {
      const n = open.get(key) || 0;
      if (n >= maxOpen) {
        res.setHeader('Retry-After', '2');
        res.setHeader('Cache-Control', 'no-store');
        return res.sendStatus(503);
      }
      let freed = false;
      let off = null;
      const free = () => {
        if (freed) return;
        freed = true;
        if (off) off();                               // a kept-alive connection keeps no listener per call
        const left = (open.get(key) || 1) - 1;
        if (left > 0) open.set(key, left); else open.delete(key);
      };
      open.set(key, n + 1);
      off = whenGone(req, res, free);
      if (!off) return free();                        // the caller already left: nothing to relay
    }
    // The query string rides along exactly as posthog-js sent it.
    const q = req.originalUrl.indexOf('?');
    const upstreamPath = up.path + (q >= 0 ? req.originalUrl.slice(q) : '');
    const upstream = request({ hostname: up.host, port: 443, path: upstreamPath, method: req.method,
      headers: forwardHeaders(req.headers, up.host) }, (ur) => {
      res.writeHead(ur.statusCode || 502, returnHeaders(ur.headers));
      if (budget) ur.on('data', (c) => budget.charge(req, c.length));
      ur.pipe(res);
    });
    let sent = 0, cut = false;
    upstream.on('error', () => {
      if (cut) return;                                // our own cut-off below, already answered
      if (!res.headersSent) res.status(502).end(); else res.destroy();
    });
    /* Night review 2026-10-29: a PostHog call that hangs no longer holds a socket open forever. 30 s with nothing
       either way ends it (a 502 to posthog-js, which retries), and when the caller (or nginx) goes away first, the
       call to PostHog goes with it. */
    if (typeof upstream.setTimeout === 'function') upstream.setTimeout(idleMs, () => upstream.destroy());
    res.on('close', () => {
      if (res.writableFinished) return;
      cut = true;                                     // nobody left to answer
      upstream.destroy();
    });
    req.on('data', (c) => {
      sent += c.length;
      if (budget) budget.charge(req, c.length);
      // A chunked upload declares no length; cut it off once it passes the cap.
      if (!cut && sent > maxBody) {
        cut = true;
        req.unpipe(upstream);
        upstream.destroy();
        if (!res.headersSent) res.status(413).end(); else res.destroy();
      }
    });
    req.pipe(upstream);
  };
  ingest.inFlight = () => open.size;                  // addresses with a call being relayed (tests)
  return ingest;
}

module.exports = { ingestProxy, upstreamFor, forwardHeaders, returnHeaders, POSTHOG_TOKEN, MAX_BODY,
  UPSTREAM_IDLE_MS, MAX_OPEN, STATIC_FILES, CAPTURE_HOST, ASSET_HOST };
