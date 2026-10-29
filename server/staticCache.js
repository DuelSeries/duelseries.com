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
      the default, 1000 MB per 10 minutes, is hundreds of cold lobby loads from
      one address, and holds one looping client to under 2 MB/s instead of the
      whole box's bandwidth. STATIC_BUDGET_MB sets it, 0 turns it off. nginx
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

/* The file express.static would look for, as one spelling: decoded, separators and dot segments resolved, no
   trailing slash, lower-cased. null for a path that does not decode (serve-static refuses it with a 400). For
   matching a file the live site must not serve, however the URL spells it. */
function staticName(pathname) {
  let p;
  try { p = decodeURIComponent(String(pathname == null ? '' : pathname)); } catch (_) { return null; }
  return path.posix.normalize('/' + p.replace(/\\/g, '/')).replace(/\/+$/, '').toLowerCase();
}

function cacheControl(req, res, next) {
  res.setHeader('Cache-Control', revalidates(req.path) ? 'no-cache' : 'no-store');
  next();
}

// ── 2. Precompressed text assets ─────────────────────────────────────────────────────────────────────────────────

const TEXT_EXT = new Set(['.js', '.mjs', '.css', '.json', '.svg', '.html', '.htm', '.txt', '.webmanifest']);
const UP_PATH = /(?:^|[\\/])\.\.(?:[\\/]|$)/;          // send's own dot-dot test
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

const DEFAULT_BUDGET_MB = 1000;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

/* STATIC_BUDGET_MB: a whole number of megabytes; 0 turns the budget off; unset or junk keeps the default. */
function budgetMbFrom(env) {
  const v = env && env.STATIC_BUDGET_MB;
  if (v === undefined || v === null || String(v).trim() === '') return DEFAULT_BUDGET_MB;
  const n = Number(String(v).trim());
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_BUDGET_MB;
}

function byteBudget(opts = {}) {
  // opts.maxBytes (tests) or opts.maxMb (STATIC_BUDGET_MB through budgetMbFrom).
  const maxBytes = opts.maxBytes !== undefined ? opts.maxBytes
    : (opts.maxMb === undefined ? DEFAULT_BUDGET_MB : opts.maxMb) * 1024 * 1024;
  const windowMs = opts.windowMs || DEFAULT_WINDOW_MS;
  const maxKeys = opts.maxKeys || 200000;
  const now = opts.now || Date.now;
  const log = opts.log || ((m) => console.warn(m));
  const seen = new Map();                     // key -> { start, bytes, told }
  const on = maxBytes > 0;

  /* One address is one key; an IPv6 client is its /56, as express-rate-limit keys it, so a fresh address from the
     same block is not a fresh budget. nginx itself (loopback / private peer with no forwarded address) and local
     tests are never metered. */
  function keyOf(req) {
    const ip = bareIp(req.ip || (req.socket && req.socket.remoteAddress) || '');
    if (!ip || isTrustedPeer(ip)) return null;
    return ipKeyGenerator(ip);
  }
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
  function charge(req, n) {
    if (!on || !(n > 0)) return;
    const key = keyOf(req);
    if (!key) return;
    const b = slot(key);
    b.bytes += n;
    if (b.bytes >= maxBytes && !b.told) {
      b.told = true;
      log('[STATIC] byte budget used up by ' + key + ' (' + Math.round(b.bytes / 1048576) + ' MB in '
        + Math.round((now() - b.start) / 1000) + ' s); refusing its downloads until the window ends');
    }
  }
  function refuse(req, res) {
    const b = seen.get(keyOf(req));
    const wait = b ? Math.max(1, Math.ceil((b.start + windowMs - now()) / 1000)) : 60;
    res.setHeader('Retry-After', String(wait));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(429).type('text/plain').send('Too many downloads from your address. Try again in a few minutes.');
  }
  /* Pages and files only: /api has its own limiters and is never counted here. A full download (a GET answered
     200 or 206) counts its Content-Length; a 304, a HEAD or an error counts nothing. */
  function middleware(req, res, next) {
    if (!on || (req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api/')) return next();
    if (over(req)) return refuse(req, res);
    if (req.method === 'GET') {
      res.on('finish', () => {
        if (res.statusCode !== 200 && res.statusCode !== 206) return;
        charge(req, Number(res.getHeader('content-length')) || 0);
      });
    }
    next();
  }
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, b] of seen) if (t - b.start >= windowMs) seen.delete(k);
  }, Math.min(windowMs, 60 * 1000));
  if (sweep.unref) sweep.unref();

  return { middleware, over, charge, refuse, keyOf, enabled: on, maxBytes, windowMs,
    size: () => seen.size, stop: () => clearInterval(sweep) };
}

module.exports = { revalidates, cacheControl, staticName, pickEncoding, statTag, precompressed, byteBudget, budgetMbFrom,
  DEFAULT_BUDGET_MB, DEFAULT_WINDOW_MS, TEXT_EXT };
