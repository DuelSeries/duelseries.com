'use strict';
/* Static files (night review 2026-10-29, findings 27 and 34): server/staticCache.js.
   1. Cache-Control: every static asset is no-cache (ETag revalidation, never stale), pages and /api stay no-store.
   2. Text assets go out Brotli/gzip-compressed from a copy built once per file version, identical after decoding,
      with the same ETag express.static sends; anything it does not take is express.static's, untouched.
   3. The per-address byte budget: full downloads count, 304s and /api do not, nginx/local is never metered.
   4. The live site does not serve the 2 MB build-only logo artwork, however the URL spells it.
   The REAL modules run behind a real express app on a real socket. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const express = require('express');

const { revalidates, cacheControl, staticName, pickEncoding, statTag, precompressed, byteBudget, budgetMbFrom,
  DEFAULT_BUDGET_MB } = require('../server/staticCache');
const { TRUST_PROXY } = require('../server/clientAddr');

const ROOT = path.join(__dirname, '..');
const src = () => fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');

function get(port, target, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: target, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}

function listen(app) {
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

function decode(r) {
  const enc = r.headers['content-encoding'];
  if (enc === 'br') return zlib.brotliDecompressSync(r.body);
  if (enc === 'gzip') return zlib.gunzipSync(r.body);
  return r.body;
}

// ── 1. Cache-Control ─────────────────────────────────────────────────────────────────────────────────────────────

test('every static asset folder revalidates; pages, /api, routes and sw.js stay no-store', () => {
  for (const p of ['/js/ag/agClient.js', '/js/v2/play.js', '/wallet/widget.js', '/css/v2.css', '/img/games/a.webp',
    '/fonts/u.woff2', '/vendor/three/three.module.min.js', '/updates/a.webp', '/og/snake.png', '/shared/constants.js',
    '/updates.json', '/hexbg.jpg', '/favicon.svg', '/manifest.json', '/manifest.webmanifest', '/robots.txt',
    '/snake_sprite.png']) {
    assert.strictEqual(revalidates(p), true, p);
  }
  for (const p of ['/', '/v2', '/v2.html', '/game.html', '/privacy.html', '/sl', '/owner', '/ag', '/play/snake',
    '/api/live', '/api/owner/state', '/api/x.json', '/sw.js', '/js/page.html', '/wallet/debug', '/wallet/info',
    '/wallet/', '/js/', '/clip/abc', '', null, undefined]) {
    assert.strictEqual(revalidates(p), false, String(p));
  }
});

test('the header itself: no-cache for an asset, no-store for anything else', () => {
  const set = {};
  const res = { setHeader: (k, v) => { set[k] = v; } };
  cacheControl({ path: '/wallet/widget.js' }, res, () => {});
  assert.strictEqual(set['Cache-Control'], 'no-cache');
  cacheControl({ path: '/api/live' }, res, () => {});
  assert.strictEqual(set['Cache-Control'], 'no-store');
  cacheControl({ path: '/' }, res, () => {});
  assert.strictEqual(set['Cache-Control'], 'no-store');
});

test('server/index.js installs the rule, the budget and the compressed copies in the right places', () => {
  const s = src();
  const at = (needle) => { const i = s.indexOf(needle); assert.ok(i > 0, needle); return i; };
  const rule = at('app.use(cacheControl);');
  const meter = at('app.use(staticBudget.middleware);');
  const lobby = at("app.get('/', noindexPreview");
  const pre = at("app.use(precompressed(path.join(__dirname, '../public')));");
  const stat = at("app.use(express.static(path.join(__dirname, '../public')));");
  const sl = at('slGate.slRoutes(app');
  assert.ok(rule < meter && meter < lobby, 'header and meter before every page route');
  assert.ok(sl < pre && pre < stat, 'compressed copies after the sl gate and right before express.static');
  assert.ok(at("app.use('/shared', precompressed(") < at('// ─── Game rooms'), '/shared too');
  assert.ok(!/const revalidate = /.test(s), 'the old one-folder rule is gone');
  assert.ok(at('const staticBudget = byteBudget({ maxMb: budgetMbFrom(process.env) });') < at("app.all('/ingest/*'"),
    'one meter, made before the /ingest relay that shares it');
});

// ── 2. Compressed copies ─────────────────────────────────────────────────────────────────────────────────────────

test('Accept-Encoding: br when listed, else gzip, nothing for q=0 or neither', () => {
  assert.strictEqual(pickEncoding('gzip, deflate, br, zstd'), 'br');
  assert.strictEqual(pickEncoding('gzip, deflate'), 'gzip');
  assert.strictEqual(pickEncoding('br;q=0, gzip;q=0.5'), 'gzip');
  assert.strictEqual(pickEncoding('br;q=0, gzip;q=0'), null);
  assert.strictEqual(pickEncoding('identity'), null);
  assert.strictEqual(pickEncoding(''), null);
  assert.strictEqual(pickEncoding(undefined), null);
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-static-'));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.mkdirSync(path.join(dir, 'img'));
  const big = Buffer.from(Array.from({ length: 4000 }, (_, i) => 'function f' + i + '(a) { return a + ' + i + '; }\n').join(''));
  fs.writeFileSync(path.join(dir, 'js', 'big.js'), big);
  fs.writeFileSync(path.join(dir, 'js', 'tiny.js'), 'var x = 1;\n');
  fs.writeFileSync(path.join(dir, 'js', '.secret.js'), big);
  fs.writeFileSync(path.join(dir, 'page.html'), '<!doctype html><p>' + 'hello '.repeat(2000) + '</p>');
  fs.writeFileSync(path.join(dir, 'img', 'a.png'), Buffer.alloc(5000, 7));
  return { dir, big };
}

async function staticApp(dir) {
  const app = express();
  app.use(cacheControl);
  const pre = precompressed(dir);
  app.use(pre);
  app.use(express.static(dir));
  app.use((err, _req, res, _next) => res.status(err.status || 500).end());   // quiet: no stack on stderr
  const server = await listen(app);
  return { server, port: server.address().port, pre };
}

test('a text asset: plain while its copy is built, then Brotli, identical bytes, same ETag and headers', async (t) => {
  const { dir, big } = fixture();
  const { server, port, pre } = await staticApp(dir);
  t.after(() => server.close());
  const BR = { 'Accept-Encoding': 'gzip, deflate, br' };

  const first = await get(port, '/js/big.js', BR);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.headers['content-encoding'], undefined, 'the first request never waits on a compression');
  assert.ok(first.body.equals(big));
  assert.strictEqual(first.headers['cache-control'], 'no-cache');
  assert.match(first.headers.vary, /Accept-Encoding/);
  await pre.idle();

  const br = await get(port, '/js/big.js', BR);
  assert.strictEqual(br.status, 200);
  assert.strictEqual(br.headers['content-encoding'], 'br');
  assert.ok(br.body.length < big.length / 4, 'much smaller: ' + br.body.length);
  assert.strictEqual(Number(br.headers['content-length']), br.body.length);
  assert.ok(decode(br).equals(big), 'the same file after decoding');
  for (const h of ['etag', 'last-modified', 'content-type', 'cache-control']) {
    assert.strictEqual(br.headers[h], first.headers[h], h + ' is what express.static sends');
  }
  assert.strictEqual(br.headers.etag, statTag(fs.statSync(path.join(dir, 'js', 'big.js'))));
  assert.match(br.headers.vary, /Accept-Encoding/);
  assert.strictEqual(pre.cached().files, 1);

  // gzip-only browsers get their own copy the same way.
  const g1 = await get(port, '/js/big.js', { 'Accept-Encoding': 'gzip' });
  assert.strictEqual(g1.headers['content-encoding'], undefined);
  await pre.idle();
  const g2 = await get(port, '/js/big.js', { 'Accept-Encoding': 'gzip' });
  assert.strictEqual(g2.headers['content-encoding'], 'gzip');
  assert.ok(decode(g2).equals(big));

  // HEAD: the compressed answer's headers, no body.
  const head = await get(port, '/js/big.js', BR, 'HEAD');
  assert.strictEqual(head.headers['content-encoding'], 'br');
  assert.strictEqual(Number(head.headers['content-length']), br.body.length);
  assert.strictEqual(head.body.length, 0);
});

test('revalidation is a 304 on the same ETag; Range, no Accept-Encoding and preconditions stay express.static\'s', async (t) => {
  const { dir, big } = fixture();
  const { server, port, pre } = await staticApp(dir);
  t.after(() => server.close());
  const BR = { 'Accept-Encoding': 'br' };
  await get(port, '/js/big.js', BR);
  await pre.idle();
  const full = await get(port, '/js/big.js', BR);
  assert.strictEqual(full.headers['content-encoding'], 'br');

  const again = await get(port, '/js/big.js', { ...BR, 'If-None-Match': full.headers.etag });
  assert.strictEqual(again.status, 304, 'a repeat visit costs no download');
  assert.strictEqual(again.body.length, 0);
  assert.strictEqual(again.headers['cache-control'], 'no-cache');
  // A hard reload (Cache-Control: no-cache) gets the whole file, compressed.
  const hard = await get(port, '/js/big.js', { ...BR, 'If-None-Match': full.headers.etag, 'Cache-Control': 'no-cache' });
  assert.strictEqual(hard.status, 200);
  assert.ok(decode(hard).equals(big));
  // A stale ETag gets the new body.
  const stale = await get(port, '/js/big.js', { ...BR, 'If-None-Match': 'W/"1-1"' });
  assert.strictEqual(stale.status, 200);
  assert.ok(decode(stale).equals(big));

  const range = await get(port, '/js/big.js', { ...BR, Range: 'bytes=0-9' });
  assert.strictEqual(range.status, 206);
  assert.strictEqual(range.headers['content-encoding'], undefined);
  assert.strictEqual(range.body.toString(), big.subarray(0, 10).toString());

  const plain = await get(port, '/js/big.js');
  assert.strictEqual(plain.headers['content-encoding'], undefined);
  assert.ok(plain.body.equals(big));

  const ifMatch = await get(port, '/js/big.js', { ...BR, 'If-Match': '"nope"' });
  assert.strictEqual(ifMatch.status, 412, 'express.static still answers a failed precondition');
});

test('a changed file (a deploy) gets a new ETag at once and a fresh copy, never the old bytes', async (t) => {
  const { dir, big } = fixture();
  const { server, port, pre } = await staticApp(dir);
  t.after(() => server.close());
  const BR = { 'Accept-Encoding': 'br' };
  await get(port, '/js/big.js', BR);
  await pre.idle();
  const before = await get(port, '/js/big.js', BR);
  assert.strictEqual(before.headers['content-encoding'], 'br');

  const file = path.join(dir, 'js', 'big.js');
  const next = Buffer.concat([big, Buffer.from('// the new build\n')]);
  fs.writeFileSync(file, next);
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(file, later, later);

  const after = await get(port, '/js/big.js', { ...BR, 'If-None-Match': before.headers.etag });
  assert.strictEqual(after.status, 200, 'the old ETag no longer matches');
  assert.notStrictEqual(after.headers.etag, before.headers.etag);
  assert.ok(decode(after).equals(next), 'the new file, never the old copy');
  await pre.idle();
  const fresh = await get(port, '/js/big.js', BR);
  assert.strictEqual(fresh.headers['content-encoding'], 'br');
  assert.ok(decode(fresh).equals(next));
  assert.strictEqual(fresh.headers.etag, after.headers.etag);
});

test('what it never takes: tiny files, images, dotfiles, dot-dot, odd encodings; pages keep no-store', async (t) => {
  const { dir } = fixture();
  const { server, port, pre } = await staticApp(dir);
  t.after(() => server.close());
  const BR = { 'Accept-Encoding': 'br' };
  for (let i = 0; i < 2; i++) {
    await get(port, '/js/tiny.js', BR);
    await get(port, '/img/a.png', BR);
    await pre.idle();
  }
  const tiny = await get(port, '/js/tiny.js', BR);
  assert.strictEqual(tiny.headers['content-encoding'], undefined);
  assert.strictEqual(tiny.body.toString(), 'var x = 1;\n');
  const png = await get(port, '/img/a.png', BR);
  assert.strictEqual(png.headers['content-encoding'], undefined);
  assert.strictEqual(png.headers['cache-control'], 'no-cache');

  for (const p of ['/js/.secret.js', '/js/%2esecret.js', '/img/../js/.secret.js', '/js/big.js%00']) {
    const r = await get(port, p, BR);
    assert.notStrictEqual(r.headers['content-encoding'], 'br', p);
    assert.ok(r.status >= 400, p + ' -> ' + r.status);
  }
  // A dot-dot spelling is left to express.static, which resolves it as it always has.
  await pre.idle();
  const dotdot = await get(port, '/js/..%2fjs/big.js', BR);
  assert.strictEqual(dotdot.headers['content-encoding'], undefined);

  await get(port, '/page.html', BR);
  await pre.idle();
  const page = await get(port, '/page.html', BR);
  assert.strictEqual(page.headers['cache-control'], 'no-store', 'a page is never kept');
  assert.strictEqual(page.headers['content-encoding'], 'br');
  assert.ok(decode(page).toString().startsWith('<!doctype html>'));
  assert.strictEqual(pre.cached().files, 1, 'only the page was worth a copy');
});

test('the memory the copies hold is capped, oldest out first', async () => {
  const { dir } = fixture();
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(path.join(dir, 'js', 'n' + i + '.js'), require('crypto').randomBytes(3000).toString('base64'));
  }
  const pre = precompressed(dir, { cacheBytes: 5000 });
  const app = express();
  app.use(pre);
  app.use(express.static(dir));
  const server = await listen(app);
  try {
    const port = server.address().port;
    for (let i = 0; i < 4; i++) { await get(port, '/js/n' + i + '.js', { 'Accept-Encoding': 'br' }); await pre.idle(); }
    const c = pre.cached();
    assert.ok(c.bytes <= 5000, 'held ' + c.bytes);
    assert.ok(c.files >= 1 && c.files < 4, 'some were let go: ' + c.files);
  } finally { server.close(); }
});

// ── 3. The byte budget ───────────────────────────────────────────────────────────────────────────────────────────

test('STATIC_BUDGET_MB: unset or junk keeps the default, 0 turns it off', () => {
  assert.strictEqual(DEFAULT_BUDGET_MB, 1000);
  for (const v of [undefined, '', '  ', 'lots', '-5', '1.5', null]) assert.strictEqual(budgetMbFrom({ STATIC_BUDGET_MB: v }), 1000, String(v));
  assert.strictEqual(budgetMbFrom({}), 1000);
  assert.strictEqual(budgetMbFrom({ STATIC_BUDGET_MB: '0' }), 0);
  assert.strictEqual(budgetMbFrom({ STATIC_BUDGET_MB: ' 250 ' }), 250);
  assert.strictEqual(byteBudget({ maxMb: 0 }).enabled, false);
  const b = byteBudget({});
  assert.strictEqual(b.maxBytes, 1000 * 1024 * 1024);
  b.stop();
});

test('the meter: per address, an IPv6 /56 is one address, nginx and local are never metered, the window resets', () => {
  let t = 1000;
  const said = [];
  const b = byteBudget({ maxBytes: 100, windowMs: 60000, now: () => t, log: (m) => said.push(m) });
  const req = (ip) => ({ ip });
  b.charge(req('203.0.113.5'), 60);
  assert.strictEqual(b.over(req('203.0.113.5')), false);
  b.charge(req('203.0.113.5'), 60);
  assert.strictEqual(b.over(req('203.0.113.5')), true);
  assert.strictEqual(said.length, 1, 'the owner log says so once');
  assert.match(said[0], /byte budget used up by 203\.0\.113\.5/);
  b.charge(req('203.0.113.5'), 60);
  assert.strictEqual(said.length, 1);
  assert.strictEqual(b.over(req('::ffff:203.0.113.5')), true, 'the mapped spelling is the same address');
  assert.strictEqual(b.over(req('198.51.100.7')), false, 'another address is untouched');

  b.charge(req('2001:db8:1:2::1'), 150);
  assert.strictEqual(b.over(req('2001:db8:1:ff::9')), true, 'a fresh address in the same /56 is not a fresh budget');
  assert.strictEqual(b.over(req('2001:db8:2::1')), false);

  for (const ip of ['127.0.0.1', '::1', '10.0.0.4', '172.31.5.6', '192.168.1.2', '::ffff:127.0.0.1']) {
    b.charge(req(ip), 1e9);
    assert.strictEqual(b.over(req(ip)), false, ip + ' (nginx itself, or local) is never metered');
  }

  t += 60000;
  assert.strictEqual(b.over(req('203.0.113.5')), false, 'a new window, a new budget');
  b.stop();
});

test('through a real app: full downloads count, 304s and /api do not, past the budget it is a 429 with Retry-After', async (t) => {
  const { dir, big } = fixture();
  const budget = byteBudget({ maxBytes: big.length * 2 - 10, windowMs: 600000, log: () => {} });
  t.after(() => budget.stop());
  const app = express();
  app.set('trust proxy', TRUST_PROXY);       // as server/index.js: the address nginx forwards
  app.use(cacheControl);
  app.use(budget.middleware);
  app.get('/api/thing', (_req, res) => res.send(big));
  app.use(express.static(dir));
  const server = await listen(app);
  t.after(() => server.close());
  const port = server.address().port;
  const A = { 'X-Forwarded-For': '203.0.113.9' };
  const B = { 'X-Forwarded-For': '198.51.100.20' };

  const one = await get(port, '/js/big.js', A);
  assert.strictEqual(one.status, 200);
  for (let i = 0; i < 5; i++) {
    const r = await get(port, '/js/big.js', { ...A, 'If-None-Match': one.headers.etag });
    assert.strictEqual(r.status, 304, 'a revalidation costs nothing');
  }
  for (let i = 0; i < 5; i++) assert.strictEqual((await get(port, '/api/thing', A)).status, 200, '/api is never counted');
  assert.strictEqual((await get(port, '/js/big.js', A)).status, 200, 'the second full download');
  const refused = await get(port, '/js/big.js', A);
  assert.strictEqual(refused.status, 429);
  assert.ok(Number(refused.headers['retry-after']) > 0);
  assert.strictEqual(refused.headers['cache-control'], 'no-store');
  assert.match(refused.body.toString(), /Too many downloads/);
  assert.strictEqual((await get(port, '/page.html', A)).status, 429, 'pages too');
  assert.strictEqual((await get(port, '/api/thing', A)).status, 200, '/api still answers');
  assert.strictEqual((await get(port, '/js/big.js', B)).status, 200, 'another player is untouched');
  assert.strictEqual((await get(port, '/js/big.js')).status, 200, 'a local request is never metered');
});

// ── 4. The build-only artwork ────────────────────────────────────────────────────────────────────────────────────

test('the live site refuses the 2 MB logo artwork by every spelling; it stays on disk for make-icons', () => {
  const s = src();
  assert.match(s, /const DEV_ONLY_PAGES = \[[^\]]*'\/img\/logo-source\.png'\]/, 'listed with the dev-only pages');
  assert.match(s, /devOnly\.has\(staticName\(req\.path\)\)/, 'matched by what express.static would resolve');
  for (const p of ['/img/logo-source.png', '/img/logo-source%2Epng', '//img/./logo-source.png', '/img/x/../logo-source.png',
    '/IMG/Logo-Source.PNG', '/img\\logo-source.png', '/img/logo-source.png/']) {
    assert.strictEqual(staticName(p), '/img/logo-source.png', p);
  }
  assert.strictEqual(staticName('/img/%E0%A4%A'), null, 'a path that does not decode is not the file');
  assert.notStrictEqual(staticName('/img/logo-source.png.bak'), '/img/logo-source.png');
  assert.ok(fs.existsSync(path.join(ROOT, 'public/img/logo-source.png')), 'still on disk');
});
