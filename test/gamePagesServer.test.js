'use strict';
// The games' own pages on the real server (scripts/dev-local.js, production's default switches: agar.io and
// Battleship Coming soon). Every URL in /sitemap.xml answers 200 as HTML with one h1, a canonical naming that URL,
// a 1200 x 630 og:image that this server hands out as a jpeg, and a Twitter large card; robots.txt names the
// sitemap; a Coming soon game's page goes to the lobby and is not in the sitemap; Play is the game's invite link.
// The words and the markup are unit tested in gamePages.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SITE = 'https://duelseries.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let port, srv, out = '';
const get = (p) => new Promise((resolve) => {
  const q = http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => {
      const buf = Buffer.concat(chunks);
      resolve({ status: r.statusCode, body: buf.toString('utf8'), buf, type: r.headers['content-type'] || '', location: r.headers.location });
    });
  });
  q.on('error', () => resolve(null));
  q.setTimeout(4000, () => { q.destroy(); resolve(null); });
});

test.before(async () => {
  port = await freePort();
  const soonFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gamepages-')), 'coming-soon.json');
  srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-local.js')], {
    cwd: ROOT, env: { ...process.env, DEV_LOCAL_PORT: String(port), COMING_SOON_PATH: soonFile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 160; i++) {
    if (srv.exitCode !== null) throw new Error('server exited:\n' + out.slice(-2000));
    const r = await get('/api/live');
    if (r && r.status === 200) return;
    await sleep(250);
  }
  throw new Error('server did not come up');
});
test.after(() => { if (srv && srv.exitCode === null) srv.kill(); });

const attr = (html, re) => { const m = re.exec(html); return m ? m[1] : null; };

test('every sitemap URL answers 200 with its canonical, one h1 and a 1200 x 630 og:image that resolves', async () => {
  const sm = await get('/sitemap.xml');
  assert.strictEqual(sm.status, 200);
  assert.match(sm.type, /xml/);
  const urls = [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => !/\.(jpe?g|png|webp)$/.test(u));
  assert.ok(urls.includes(SITE + '/') && urls.includes(SITE + '/games'), 'the lobby and the list');
  const games = urls.filter((u) => u.startsWith(SITE + '/games/'));
  assert.ok(games.length >= 10, 'every live game: ' + games.length);
  assert.ok(!urls.some((u) => /agar|cells|battleship/.test(u)), 'no Coming soon game');
  for (const u of urls) {
    const p = u.slice(SITE.length);
    const r = await get(p);
    assert.strictEqual(r.status, 200, u);
    assert.match(r.type, /text\/html/, u);
    const html = r.body;
    assert.match(html, /<html lang="en">/, u);
    assert.strictEqual(attr(html, /<link rel="canonical" href="([^"]+)">/), u, u + ' canonical');
    if (p !== '/') assert.strictEqual((html.match(/<h1[\s>]/g) || []).length, 1, u + ' h1');
    assert.match(html, /<meta name="description" content="[^"]{50,}">/, u);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/, u);
    const img = attr(html, /<meta property="og:image" content="([^"]+)">/);
    assert.ok(img && img.startsWith(SITE + '/og/'), u + ' og:image ' + img);
    assert.strictEqual(attr(html, /<meta property="og:image:width" content="(\d+)">/), '1200', u);
    assert.strictEqual(attr(html, /<meta property="og:image:height" content="(\d+)">/), '630', u);
    assert.strictEqual(attr(html, /<meta name="twitter:image" content="([^"]+)">/), img, u);
    const pic = await get(img.slice(SITE.length));
    assert.strictEqual(pic.status, 200, img);
    assert.match(pic.type, /image\/jpeg/, img);
    assert.strictEqual(pic.buf.readUInt16BE(0), 0xffd8, img + ' is a jpeg');
    if (p.startsWith('/games/')) {
      // its card art and Play target exist on this server too
      const art = attr(html, /<img class="art" src="([^"]+)"/);
      assert.strictEqual((await get(art)).status, 200, art);
      const play = attr(html, /<a class="play" href="([^"]+)"/);
      assert.match(play, /^\/play\/[a-z]+\?from=page$/);
      assert.strictEqual((await get(play)).status, 200, play);
      assert.ok(html.includes('"@type":"VideoGame"'), u + ' JSON-LD');
    }
  }
});

test('robots.txt names the sitemap; a Coming soon or unknown page does not answer as a game', async () => {
  const robots = await get('/robots.txt');
  assert.strictEqual(robots.status, 200);
  assert.match(robots.body, /^Sitemap: https:\/\/duelseries\.com\/sitemap\.xml$/m);
  assert.doesNotMatch(robots.body, /^Disallow: \/(?:games|play)\b/m, 'game pages and invites stay crawlable');
  for (const p of ['/games/agar-io', '/games/battleship']) {
    const r = await get(p);
    assert.deepStrictEqual([r.status, r.location], [302, '/'], p);
  }
  const nope = await get('/games/not-a-game');
  assert.strictEqual(nope.status, 404);
  assert.match(nope.body, /Page not found/);
  const list = await get('/games');
  assert.ok(!/href="\/games\/(?:agar-io|battleship)"/.test(list.body), 'the list leaves Coming soon out');
});
