'use strict';
/* public/sl.html (the new slither.io client) is never handed out while the game is closed (task T-1, server/slRoutes.js).

   - The switch: OFF by default; only 1, true, on, yes open it; junk fails closed and says so.
   - Every path express.static would resolve to the file is caught, not only the exact /sl.html.
   - The routes in front of the real express.static over public/, for unset, junk, 0 and 1.
   - The real server/index.js (booted by scripts/dev-local.js in this test's own process, every outbound call
     refused, SL_ENABLED unset): closed by default, and the routes are declared above express.static.

   Requests go over a raw socket so the request line is sent exactly as written (an HTTP client would normalize
   /./sl.html before sending it). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SL_FILE = path.join(PUBLIC, 'sl.html');
const SL_HTML = fs.readFileSync(SL_FILE, 'utf8');
const { slSwitch, isSlFile, slRoutes, CLOSED_PAGE } = require('../server/slRoutes');

// Every spelling of the file's address that reaches it through express.static (or that a case-insensitive disk
// would), each sent as the raw request target.
const FILE_PATHS = ['/sl.html', '/sl.html?x=1', '/./sl.html', '//sl.html', '/x/../sl.html', '/sl%2Ehtml',
  '/%73l.html', '/SL.html', '/SL.HTML', '/sl.html/', '/./sl.html?x=1'];

function request(port, target, method = 'GET') {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    s.on('connect', () => s.write(`${method} ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    s.on('data', (d) => { out += d; });
    s.on('end', () => {
      const head = out.split('\r\n\r\n')[0];
      const h = (name) => { const m = new RegExp('\\r\\n' + name + ': ([^\\r\\n]*)', 'i').exec(head); return m ? m[1] : null; };
      resolve({ status: Number(out.split(' ')[1]), location: h('location'), cache: h('cache-control'),
        type: h('content-type'), body: out.slice(head.length + 4) });
    });
    s.on('error', reject);
    s.setTimeout(5000, () => s.destroy(new Error('timeout')));
  });
}

function assertClosed(r, what) {
  assert.strictEqual(r.status, 503, what + ': 503');
  assert.strictEqual(r.cache, 'no-store', what + ': no-store');
  assert.match(String(r.type), /^text\/html/, what + ': html');
  assert.ok(r.body.includes('slither.io is not open yet.'), what + ': the closed page');
  assert.ok(!r.body.includes('<canvas') && r.body !== SL_HTML, what + ': not the client page');
}

test('the switch is OFF unless it says 1, true, on or yes; junk fails closed and says so', () => {
  const said = [];
  const log = { error: (m) => said.push(m) };
  for (const v of [undefined, null, '', '  ', '0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(slSwitch(v, log), false, JSON.stringify(v) + ' is off');
  }
  assert.strictEqual(said.length, 0, 'an off value is not an error');
  for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' On ', 'Yes']) assert.strictEqual(slSwitch(v, log), true, v + ' is on');
  for (const v of ['2', 'enabled', 'y', 'truee', 'open', '-1']) {
    const before = said.length;
    const out = slSwitch(v, log);
    assert.strictEqual(out, false, JSON.stringify(v) + ' fails closed');
    assert.strictEqual(said.length, before + 1, JSON.stringify(v) + ' is reported');
    assert.match(said[said.length - 1], /SL_ENABLED=.*fails closed/);
  }
});

test('every path express.static would resolve to the file is caught, and nothing else is', () => {
  for (const p of ['/sl.html', '/./sl.html', '//sl.html', '/x/../sl.html', '/../sl.html', '/sl%2Ehtml', '/%73l.html',
    '/SL.html', '/sl.html/', '/a/b/../../sl.html', '/.\\sl.html', '\\sl.html']) {
    assert.strictEqual(isSlFile(p), true, p);
  }
  for (const p of ['/sl', '/sl.htm', '/sl.html.bak', '/js/sl/sl.html', '/css/sl.css', '/ag.html', '/', '',
    '/sl%2', '/sl%ZZ.html', '/xsl.html', '/sl.html/x']) {
    assert.strictEqual(isSlFile(p), false, p);
  }
});

// A small app with the same order as server/index.js: no-store default, the sl routes, then express.static.
async function miniServer(raw) {
  const app = express();
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  slRoutes(app, { open: slSwitch(raw, { error: () => {} }), file: SL_FILE });
  app.use(express.static(PUBLIC));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

for (const [label, raw] of [['unset', undefined], ['junk ("maybe")', 'maybe'], ['0', '0']]) {
  test(`SL_ENABLED ${label}: /sl and every spelling of the file answer the closed page, 503, no-store`, async () => {
    const { server, port } = await miniServer(raw);
    try {
      for (const p of ['/sl', '/sl/', '/SL', '/sl?x=1', ...FILE_PATHS]) assertClosed(await request(port, p), p);
      const head = await request(port, '/sl.html', 'HEAD');
      assert.strictEqual(head.status, 503, 'HEAD /sl.html: 503');
      assert.strictEqual(head.body, '', 'HEAD has no body');
      // The rest of public/ is untouched.
      const css = await request(port, '/css/sl.css');
      assert.strictEqual(css.status, 200, 'other static files still served');
      assert.strictEqual((await request(port, '/no-such-file.html')).status, 404);
    } finally { server.close(); }
  });
}

test('SL_ENABLED=1: /sl serves public/sl.html; every spelling of the file sends the browser to /sl', async () => {
  const { server, port } = await miniServer('1');
  try {
    const r = await request(port, '/sl');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.cache, 'no-store');
    assert.match(String(r.type), /^text\/html/);
    assert.strictEqual(r.body, SL_HTML, 'the client page, byte for byte');
    for (const p of FILE_PATHS) {
      const x = await request(port, p);
      assert.strictEqual(x.status, 302, p + ': 302');
      assert.strictEqual(x.location, '/sl', p + ': to /sl');
    }
  } finally { server.close(); }
});

test('the closed page is self-contained, links back to the lobby, and closes the lobby frame', () => {
  assert.ok(!/<link|src=|url\(/i.test(CLOSED_PAGE), 'no external stylesheet, script or image');
  assert.match(CLOSED_PAGE, /<a id="back" href="\/" target="_top"[^>]*>Back to lobby<\/a>/);
  assert.ok(CLOSED_PAGE.includes('postMessage("game:done","*")'), 'inside the lobby frame it sends game:done');
  assert.ok(!CLOSED_PAGE.includes(String.fromCharCode(0x2014)), 'no em dash');
});

// ─── The real server ──────────────────────────────────────────────────────────────────────────────────────────────

test('server/index.js installs the sl routes above express.static over public/', () => {
  const s = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const routes = s.indexOf('slGate.slRoutes(app');
  const stat = s.indexOf("app.use(express.static(path.join(__dirname, '../public')))");
  assert.ok(routes > 0 && stat > 0, 'both are there');
  assert.ok(routes < stat, 'the routes come first');
  assert.ok(/open: slGate\.slSwitch\(process\.env\.SL_ENABLED\)/.test(s), 'opened only by SL_ENABLED');
  assert.strictEqual((s.match(/express\.static\(/g) || []).length, 2, 'no other static mount to slip past');
});

test('the real server, SL_ENABLED unset: closed by default', async () => {
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  delete process.env.SL_ENABLED;
  process.env.DEV_LOCAL_PORT = String(port);
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    require(path.join(ROOT, 'scripts', 'dev-local.js'));
  } finally {
    console.log = log; console.warn = warn;
  }
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await request(port, '/api/live')).status === 200; } catch (_) {}
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(up, 'server came up');
  for (const p of ['/sl', ...FILE_PATHS]) assertClosed(await request(port, p), 'real server ' + p);
  assert.strictEqual((await request(port, '/css/sl.css')).status, 200, 'the rest of public/ is still served');
});
