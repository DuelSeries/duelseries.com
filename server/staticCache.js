'use strict';
/* ─── Static files: how they are cached, compressed and metered ────────────────
   Night review 2026-10-29 (findings 27 and 34). Every file under public/ used to
   go out no-store, so each lobby visit downloaded about 6.5 MB again (the 5 MB
   wallet widget among it), straight from the one EC2 box with no CDN, and
   nothing stopped one address pulling the big files in a loop.

   1. revalidates(path): which answers may be kept by the browser. The rule
      Owen picked for agar.io's scripts on 2026-10-08 (no-cache) now covers
      every static asset: the browser may keep a copy but must ask before every
      use, express.static answers with the ETag it already sends, and a 304
      costs a few hundred bytes. The deploy's git reset rewrites a changed
      file, its ETag changes with its mtime, so the next load fetches the new
      build at once: a stale staking client still can never run. HTML pages,
      /api, sw.js and anything dynamic stay no-store, exactly as before
      (public/sw.js says why).

   2. precompressed(root): text assets (JS, CSS, JSON, SVG, HTML) go out
      Brotli- or gzip-compressed when the browser asks for it, compressed once
      per file version with Node's own zlib and kept in memory, so no request
      ever waits on a compression. The first request for a new version still
      gets the plain file (nginx gzips it, as it does today) while it is built
      in the background, one file at a time. Same bytes after decoding, same
      ETag as express.static would send, Vary: Accept-Encoding. Anything else
      (a Range request, a precondition, a file that does not compress) falls
      through to express.static untouched.

   3. byteBudget(): bytes of full downloads per address per window. An honest
      visit is a few MB and a repeat visit a few hundred KB of 304s and pages;
      the default, 300 MB per 10 minutes (night review 2026-10-29, was 1000),
      is still dozens of cold lobby loads from one address and holds one
      looping client to about 0.5 MB/s on average. Bytes count as they are
      written, so a download the client cuts off counts what it got, and at
      most 8 of one address's requests are answered at once (the rest wait
      their turn and are checked again when it comes), so a burst of parallel
      downloads can no longer all pass the check together. STATIC_BUDGET_MB
      sets it, 0 turns it off. It keys on the address nginx forwards: put a CDN
      (CloudFront) in front and every visitor arrives from a few edge
      addresses, so set STATIC_BUDGET_MB=0 (or have nginx take the viewer's
      address from CloudFront-Viewer-Address) BEFORE switching the DNS. nginx
      limit_conn / limit_rate and a CDN in front are the real cure (owner
      actions); this is the backstop that ships with the code. */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { ipKeyGenerator } = require('express-rate-limit');
const { bareIp, isTrustedPeer } = require('./clientAddr');

// ── 1. Cache-Control ─────────────────────────────────────────────────────────────────────────────────────────────

/* The folders express.static serves assets from (public/ and the /shared mount), and the few assets at the root of
   public/. Always a file name with an extension, so a route that shares a folder's prefix (/wallet/debug,
   /wallet/info) is never one; a page (.html) is never one either, even inside these folders. */
const ASSET_DIR = /^\/(?:js|css|img|fonts|vendor|wallet|updates|og|shared)\/(?:[^/]+\/)*[^/]+\.[a-z0-9]+$/i;
const ROOT_ASSET = /^\/[^/]+\.(?:jpe?g|png|webp|gif|svg|ico|json|webmanifest|txt)$/i;
const PAGE = /\.html?$/i;

function revalidates(p) {
  if (typeof p !== 'string' || PAGE.test(p)) return false;
  return ASSET_DIR.test(p) || ROOT_ASSET.test(p);
}

const UP_PATH = /(?:^|[\\/])\.\.(?:[\\/]|$)/;          // send's own dot-dot test

/* What express.static (send) does with a path before it opens a file, step for step: decode it (400 if it does not
   decode), refuse a NUL (400), resolve the dot segments with the path rules of the box it runs on, refuse anything
   that still climbs out of the root (403). As one spelling: '/'-separated, no trailing slash, case kept. null when
   send would open nothing. Night review 2026-10-29: the old one-spelling version always read a backslash as a
   separator, which Linux (the live box) does not, so /a/x\y/../../img/logo-source.png named another file than the
   one Linux serves for it. */
function resolveAs(pathname, flavor) {
  let p;
  try { p = decodeURIComponent(String(pathname == null ? '' : pathname)); } catch (_) { return null; }
  if (p.includes('\0')) return null;
  let rel = p ? flavor.normalize('.' + flavor.sep + p) : '';
  if (UP_PATH.test(rel)) return null;
  if (rel === '.' || rel === '.' + flavor.sep) rel = '';
  return ('/' + rel.split(flavor.sep).join('/')).replace(/\/+$/, '');
}

/* Every file express.static could open for this path: as Linux resolves it and as Windows (where a backslash is a
   separator too) does, lower-cased, the ones it would refuse left out. For matching a file the live site must not
   serve, however the URL spells it: it is that file if ANY of them is. */
function staticNames(pathname) {
  const out = [];
  for (const flavor of [path.posix, path.win32]) {
    const n = resolveAs(pathname, flavor);
    if (n !== null && !out.includes(n.toLowerCase())) out.push(n.toLowerCase());
  }
  return out;
}

/* An /api call that express.static cannot turn into a file: sent as /api/..., and every way send could resolve it
   (Linux and Windows rules, as above) stays under /api/, where public/ has no folder. Night review 2026-10-29: the
   byte budget used to skip anything whose RAW path started /api/, and send resolves dot segments, so
   /api/%2e%2e/wallet/widget.js (or /api/../wallet/widget.js) was the 5 MB widget with no meter and no gate. */
function apiOnly(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/api/')) return false;
  for (const flavor of [path.posix, path.win32]) {
    const n = resolveAs(pathname, flavor);
    if (n === null || !n.startsWith('/api/')) return false;
  }
  return true;
}

function cacheControl(req, res, next) {
  res.setHeader('Cache-Control', revalidates(req.path) ? 'no-cache' : 'no-store');
  next();
}

// ── 2. Precompressed text assets ─────────────────────────────────────────────────────────────────────────────────

const TEXT_EXT = new Set(['.js', '.mjs', '.css', '.json', '.svg', '.html', '.htm', '.txt', '.webmanifest']);
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/* br when the browser lists it, else gzip, else nothing. q=0 means "not this one". */
function pickEncoding(header) {
  if (typeof header !== 'string' || !header) return null;
  const ok = new Set();
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((s) => s.trim()).find((s) => s.startsWith('q='));
    if (q && !(Number(q.slice(2)) > 0)) continue;
    ok.add(name.trim());
  }
  return ok.has('br') ? 'br' : ok.has('gzip') ? 'gzip' : null;
}

/* The weak ETag express.static (send, etag) sends for a file: size and mtime in hex. */
function statTag(st) {
  return 'W/"' + st.size.toString(16) + '-' + st.mtime.getTime().toString(16) + '"';
}

/* Does the browser already hold this version? Then express.static answers the 304 itself. */
function alreadyHas(req, st) {
  const inm = req.headers['if-none-match'];
  if (inm) {
    const want = statTag(st).slice(2);
    return inm.split(',').some((t) => { const v = t.trim(); return v === '*' || (v.startsWith('W/') ? v.slice(2) : v) === want; });
  }
  const ims = Date.parse(req.headers['if-modified-since'] || '');
  return Number.isFinite(ims) && Math.floor(st.mtime.getTime() / 1000) * 1000 <= ims;
}

function precompressed(root, opts = {}) {
  const base = path.resolve(root);
  const minBytes = opts.minBytes || 1024;
  const maxBytes = opts.maxBytes || 8 * 1024 * 1024;
  const cacheBytes = opts.cacheBytes || 64 * 1024 * 1024;
  const brQuality = opts.brQuality || 5;      // 5: widget.js 4.8 MB -> 1.2 MB in ~0.2 s; 11 takes ~35 s
  const gzLevel = opts.gzLevel || 6;
  const mime = opts.mime || require('express').static.mime;
  const cache = new Map();                    // abs + '\n' + enc -> { size, mtimeMs, body (null: not worth it) }
  let held = 0;
  const pending = new Set();
  let queue = Promise.resolve();              // one compression at a time, so the thread pool stays free for files

  function put(key, entry) {
    const old = cache.get(key);
    if (old) { held -= old.body ? old.body.length : 0; cache.delete(key); }
    cache.set(key, entry);
    held += entry.body ? entry.body.length : 0;
    for (const [k, e] of cache) {             // oldest first
      if (held <= cacheBytes) break;
      if (k === key) continue;
      held -= e.body ? e.body.length : 0;
      cache.delete(k);
    }
  }

  function build(abs, st, enc, key) {
    if (pending.has(key)) return;
    pending.add(key);
    queue = queue.then(async () => {
      try {
        const raw = await fsp.readFile(abs);
        const after = await fsp.stat(abs);
        // Changed while being read: leave it for the next request to rebuild.
        if (raw.length !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) return;
        const body = enc === 'br'
          ? await brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brQuality,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
          : await gzip(raw, { level: gzLevel });
        put(key, { size: st.size, mtimeMs: st.mtimeMs, body: body.length < raw.length ? body : null });
      } catch (_) {
        // A file that cannot be read or compressed is simply served plain.
      } finally {
        pending.delete(key);
      }
    });
  }

  const handler = function precompressedStatic(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel;
    try { rel = decodeURIComponent(req.path); } catch (_) { return next(); }
    if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) return next();
    // A plain file as express.static would find it, or nothing: no NUL, no dot-dot, no dotfile.
    if (rel.includes('\0') || UP_PATH.test(rel) || rel.split(/[\\/]/).some((s) => s.startsWith('.'))) return next();
    const abs = path.join(base, rel);
    if (!abs.startsWith(base + path.sep)) return next();
    res.vary('Accept-Encoding');              // this URL's answer can differ by encoding from here on
    const enc = pickEncoding(req.headers['accept-encoding']);
    if (!enc || req.headers.range || req.headers['if-match'] || req.headers['if-unmodified-since']) return next();
    fs.stat(abs, (err, st) => {
      if (err || !st.isFile() || st.size < minBytes || st.size > maxBytes) return next();
      if (alreadyHas(req, st) && !/no-cache/i.test(req.headers['cache-control'] || '')) return next();
      const key = abs + '\n' + enc;
      const hit = cache.get(key);
      if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) { build(abs, st, enc, key); return next(); }
      if (!hit.body) return next();
      const type = mime.lookup(abs);
      const charset = mime.charsets.lookup(type);
      res.statusCode = 200;
      res.setHeader('Content-Type', type + (charset ? '; charset=' + charset : ''));
      if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'public, max-age=0');
      res.setHeader('Last-Modified', st.mtime.toUTCString());
      res.setHeader('ETag', statTag(st));
      res.setHeader('Content-Encoding', enc);
      res.setHeader('Content-Length', hit.body.length);
      if (req.method === 'HEAD') return res.end();
      res.end(hit.body);
    });
  };
  handler.cached = () => ({ files: cache.size, bytes: held, pending: pending.size });
  handler.idle = () => queue;
  return handler;
}

// ── 3. The per-address byte budget ───────────────────────────────────────────────────────────────────────────────

/* 300 MB per 10 minutes (night review 2026-10-29: 1000 still let one address pull ~144 GB a day). A cold lobby
   load counts about 3-6.5 MB, a repeat visit next to nothing (304s), so this is still 45+ cold loads per address. */
const DEFAULT_BUDGET_MB = 300;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
/* One address's requests being answered at once, and how many more may wait their turn. */
const DEFAULT_MAX_ACTIVE = 8;
const DEFAULT_MAX_WAITING = 256;

/* STATIC_BUDGET_MB: a whole number of megabytes; 0 turns the budget off; unset or junk keeps the default. */
function budgetMbFrom(env) {
  const v = env && env.STATIC_BUDGET_MB;
  if (v === undefined || v === null || String(v).trim() === '') return DEFAULT_BUDGET_MB;
  const n = Number(String(v).trim());
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_BUDGET_MB;
}

/* One address is one key; an IPv6 client is its /56, as express-rate-limit keys it, so a fresh address from the
   same block is not a fresh budget. nginx itself (loopback / private peer with no forwarded address) and local
   tests are null: never metered or capped. Shared with the /ingest relay's in-flight cap (server/ingestProxy.js). */
function addressKey(req) {
  const ip = bareIp(req.ip || (req.socket && req.socket.remoteAddress) || '');
  if (!ip || isTrustedPeer(ip)) return null;
  return ipKeyGenerator(ip);
}

/* Runs fn once this request is over for good: its answer closed (sent, or the client left) or its connection
   closed. Returns a function that takes fn back off, or null when the connection is already gone (fn is then
   never called). Night review 2026-10-29: NOT the request's own 'close'. Since Node 16 that fires as soon as its
   body has been read, and express.json() (above the budget in server/index.js) reads the body of a GET sent with
   Content-Type: application/json, so a turn ended while its file was still going out: 30 such GETs of the widget
   were all answered at once (144 MB against a 20 MB budget). The connection's 'close' is the one that tells a
   pipelined request whose connection dropped before its answer started: that answer never closes (measured on
   Node 24), and its request may have closed long before. One listener per connection, however many of its
   requests are waiting. */
const closers = new WeakMap();                  // socket -> Set of fn to run when it closes
function whenGone(req, res, fn) {
  const sock = req.socket || null;
  if (res.destroyed || (sock && sock.destroyed)) return null;
  res.on('close', fn);
  let set = null;
  if (sock) {
    set = closers.get(sock);
    if (!set) {
      const fresh = new Set();
      closers.set(sock, fresh);
      sock.once('close', () => { closers.delete(sock); for (const f of [...fresh]) f(); });
      set = fresh;
    }
    set.add(fn);
  }
  return () => { res.removeListener('close', fn); if (set) set.delete(fn); };
}

function byteBudget(opts = {}) {
  // opts.maxBytes (tests) or opts.maxMb (STATIC_BUDGET_MB through budgetMbFrom).
  const maxBytes = opts.maxBytes !== undefined ? opts.maxBytes
    : (opts.maxMb === undefined ? DEFAULT_BUDGET_MB : opts.maxMb) * 1024 * 1024;
  const windowMs = opts.windowMs || DEFAULT_WINDOW_MS;
  const maxKeys = opts.maxKeys || 200000;
  const maxActive = opts.maxActive || DEFAULT_MAX_ACTIVE;
  const maxWaiting = opts.maxWaiting === undefined ? DEFAULT_MAX_WAITING : opts.maxWaiting;
  const now = opts.now || Date.now;
  const log = opts.log || ((m) => console.warn(m));
  const seen = new Map();                     // key -> { start, bytes, told }
  const busy = new Map();                     // key -> { active, waiting: [entry], told }, only while it has requests
  const on = maxBytes > 0;

  const keyOf = addressKey;                   // see addressKey above
  function slot(key) {
    const t = now();
    let b = seen.get(key);
    if (!b || t - b.start >= windowMs) {
      if (b) seen.delete(key);
      b = { start: t, bytes: 0, told: false };
      seen.set(key, b);
      if (seen.size > maxKeys) seen.delete(seen.keys().next().value);
    }
    return b;
  }
  function over(req) {
    if (!on) return false;
    const key = keyOf(req);
    if (!key) return false;
    const b = seen.get(key);
    return !!b && now() - b.start < windowMs && b.bytes >= maxBytes;
  }
  function chargeKey(key, n) {
    const b = slot(key);
    b.bytes += n;
    if (b.bytes >= maxBytes && !b.told) {
      b.told = true;
      log('[STATIC] byte budget used up by ' + key + ' (' + Math.round(b.bytes / 1048576) + ' MB in '
        + Math.round((now() - b.start) / 1000) + ' s); refusing its downloads until the window ends');
    }
  }
  function charge(req, n) {
    if (!on || !(n > 0)) return;
    const key = keyOf(req);
    if (!key) return;
    chargeKey(key, n);
  }
  /* waitSec: how soon to come back; by default when this address's window ends. */
  function refuse(req, res, waitSec) {
    const b = seen.get(keyOf(req));
    const wait = waitSec > 0 ? waitSec : b ? Math.max(1, Math.ceil((b.start + windowMs - now()) / 1000)) : 60;
    res.setHeader('Retry-After', String(wait));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(429).type('text/plain').send('Too many downloads from your address. Try again in a few minutes.');
  }

  /* Night review 2026-10-29 (re-review of finding 27): the budget used to be checked when a request arrived and
     charged its Content-Length on 'finish'. Every request already in flight passed the check, so 30 parallel
     downloads of the wallet widget went out (151 MB against a 20 MB budget), and a download the client cut off
     never finished, so it was never charged. Now:
     - bytes count as they are written (res.write / res.end of a GET answered 200 or 206), so a cut-off download
       counts what was sent;
     - at most maxActive of one address's requests are answered at once. The rest wait their turn in arrival
       order and are checked against the budget again when it comes, so a burst can overshoot by at most
       maxActive files; past maxWaiting more waiting, a request is refused at once (429, come back in 5 s).
     An honest page load is not refused: behind nginx (which reads a file off us at full speed) a cold lobby
     load's dozens of requests drain in milliseconds, and a browser on HTTP/1.1 opens six connections, under
     the cap. A 304 or a page holds its turn for a millisecond. */
  function meter(res, key) {
    const write = res.write;
    const end = res.end;
    const count = (chunk, enc) => {
      if (!chunk || typeof chunk === 'function' || (res.statusCode !== 200 && res.statusCode !== 206)) return;
      const n = typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof enc === 'string' ? enc : 'utf8')
        : (chunk.byteLength || 0);
      if (n > 0) chargeKey(key, n);
    };
    res.write = function (chunk, enc) { count(chunk, enc); return write.apply(this, arguments); };
    res.end = function (chunk, enc) { count(chunk, enc); return end.apply(this, arguments); };
  }
  function admit(key, req, res, go) {
    let q = busy.get(key);
    if (!q) { q = { active: 0, waiting: [], told: false }; busy.set(key, q); }
    /* A turn ends when the request is over for good (whenGone above: its answer closed, or its connection did),
       never on the request's own 'close' (night review 2026-10-29). */
    const start = () => {
      if (over(req)) { forget(key, q); return refuse(req, res); }
      q.active++;
      let done = false;
      let off = null;
      const end = () => {
        if (done) return;
        done = true;
        if (off) off();
        q.active--;
        while (q.active < maxActive && q.waiting.length) q.waiting.shift().start();
        forget(key, q);
      };
      off = whenGone(req, res, end);
      if (!off) return end();                 // the client already left: nothing to answer
      go();
    };
    if (q.active < maxActive && !q.waiting.length) return start();
    if (q.waiting.length >= maxWaiting) {
      if (!q.told) {
        q.told = true;
        log('[STATIC] ' + key + ' has ' + (q.active + q.waiting.length) + ' requests open at once; refusing more');
      }
      forget(key, q);
      return refuse(req, res, 5);
    }
    const entry = {};
    const gone = () => {                      // the client left while it waited: never started, drop it
      const i = q.waiting.indexOf(entry);
      if (i >= 0) q.waiting.splice(i, 1);
      forget(key, q);
    };
    const offGone = whenGone(req, res, gone);
    if (!offGone) return forget(key, q);
    entry.start = () => { offGone(); start(); };
    q.waiting.push(entry);
  }
  function forget(key, q) {
    if (q.active === 0 && !q.waiting.length && busy.get(key) === q) busy.delete(key);
  }

  /* Pages and files only: /api has its own limiters and is never counted here, but only a path that stays under
     /api/ however express.static resolves it (apiOnly above, night review 2026-10-29). A full download (a GET
     answered 200 or 206) counts the bytes written; a 304, a HEAD or an error counts nothing. */
  function middleware(req, res, next) {
    if (!on || (req.method !== 'GET' && req.method !== 'HEAD') || apiOnly(req.path)) return next();
    const key = keyOf(req);
    if (!key) return next();
    if (over(req)) return refuse(req, res);
    if (req.method === 'GET') meter(res, key);
    admit(key, req, res, next);
  }
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, b] of seen) if (t - b.start >= windowMs) seen.delete(k);
  }, Math.min(windowMs, 60 * 1000));
  if (sweep.unref) sweep.unref();

  return { middleware, over, charge, refuse, keyOf, enabled: on, maxBytes, windowMs, maxActive, maxWaiting,
    size: () => seen.size, inFlight: () => busy.size, stop: () => clearInterval(sweep) };
}

module.exports = { revalidates, cacheControl, resolveAs, staticNames, apiOnly, addressKey, whenGone, pickEncoding,
  statTag, precompressed, byteBudget, budgetMbFrom, DEFAULT_BUDGET_MB, DEFAULT_WINDOW_MS, TEXT_EXT };
