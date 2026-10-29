'use strict';
/* One gzip request must never end the process (night review 2026-10-29, finding 39).

   body-parser 1.20.8 (GHSA-27r3-jxmh-p828): a request with Content-Encoding: gzip is piped into a
   gunzip stream. When the gzip member is followed by a 0x00 byte, the gunzip ends early, the body
   parses and the route answers, but req stays piped into the finished decoder with no 'error'
   listener left. The next socket read (any non-zero byte) makes zlib throw "incorrect header
   check" as an unhandled 'error' event, and this server has no uncaughtException handler, so ONE
   unauthenticated request to any existing route killed every live game on the box, paid ones
   included. No timing trick needed: one write of gzip('{}') + 0x00 + 100 KB of 0x01 arrives as
   several 64 KB reads, which is what nginx's buffered forwarding looks like.

   The fix is two layers, and each is proved on its own here:
   1. body-parser is held at >= 1.20.9 (package.json "overrides" + the lockfile). The payloads are
      thrown at a minimal app built on the repo's OWN express with a plain express.json(), exactly
      like the per-route parsers in server/index.js, in a child process (a crash there must fail
      this test, not end the runner).
   2. server/index.js's global parser refuses compressed bodies (inflate: false, 415), so zlib is
      never reached at all. The REAL server (scripts/dev-local.js) takes the same payloads on real
      routes and must stay up, and an honest JSON body must still parse. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// A 1.x version at or above 1.20.9 (2.x is a different line with its own fix).
function fixedVersion(v) {
  const [maj, min, pat] = String(v).split('.').map((n) => parseInt(n, 10));
  if (maj !== 1) return maj > 1;
  return min > 20 || (min === 20 && pat >= 9);
}

let ipSeq = 0;
/* Raw HTTP: `parts` are written to the socket one after another, `gapMs` apart, so the second part
   reaches the server in a later read. Content-Length covers every part. */
function send(port, method, url, parts, { gapMs = 0, encoding = 'gzip' } = {}) {
  const ip = '10.9.' + ((++ipSeq >> 8) & 255) + '.' + (ipSeq & 255);
  const len = parts.reduce((n, p) => n + p.length, 0);
  const head = Buffer.from(`${method} ${url} HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${ip}\r\n`
    + 'Content-Type: application/json\r\n' + (encoding ? `Content-Encoding: ${encoding}\r\n` : '')
    + `Content-Length: ${len}\r\nConnection: close\r\n\r\n`);
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let text = '';
    s.on('connect', async () => {
      s.write(Buffer.concat([head, parts[0]]));
      for (const p of parts.slice(1)) { await sleep(gapMs); if (!s.destroyed) s.write(p); }
    });
    s.on('data', (d) => { text += d; });
    s.on('end', () => {
      let json = null;
      try { json = JSON.parse(text.split('\r\n\r\n').slice(1).join('\r\n\r\n')); } catch (_) {}
      resolve({ status: Number(text.split(' ')[1]) || 0, json });
    });
    s.on('error', () => resolve({ status: -1, json: null }));
    s.setTimeout(5000, () => { s.destroy(); resolve({ status: -2, json: null }); });
  });
}

const GZ = zlib.gzipSync(Buffer.from('{}'));
// The crash shapes the verifiers reproduced against 1.20.8. Each targets an EXISTING route (an
// unknown path goes to finalhandler, which unpipes req before its 404).
const PAYLOADS = [
  ['one write: gzip + 00 + 100 KB of 01', [Buffer.concat([GZ, Buffer.from([0]), Buffer.alloc(100000, 1)])]],
  ['one write: gzip + 00 + 300 KB of 01', [Buffer.concat([GZ, Buffer.from([0]), Buffer.alloc(300000, 1)])]],
  ['gzip + 00, then garbage 150 ms later', [Buffer.concat([GZ, Buffer.from([0])]), Buffer.from('GARBAGEGARBAGE')], 150],
];

// ── 1. The dependency itself ──────────────────────────────────────────────────────────────────────────────────────

test('express resolves a body-parser at or above 1.20.9, and package.json + the lockfile hold it there', () => {
  const expressDir = path.dirname(require.resolve('express/package.json', { paths: [ROOT] }));
  const bpPkg = require.resolve('body-parser/package.json', { paths: [expressDir] });
  const installed = JSON.parse(fs.readFileSync(bpPkg, 'utf8')).version;
  assert.ok(fixedVersion(installed), 'installed body-parser is ' + installed);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const pinned = pkg.overrides && pkg.overrides['body-parser'];
  assert.ok(pinned, 'package.json has no "overrides" entry for body-parser');
  assert.ok(fixedVersion(String(pinned).replace(/^[^\d]*/, '')), 'override is ' + pinned);

  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const entries = Object.entries(lock.packages).filter(([k]) => /(^|\/)node_modules\/body-parser$/.test(k));
  assert.ok(entries.length > 0, 'no body-parser in package-lock.json');
  for (const [k, v] of entries) assert.ok(fixedVersion(v.version), k + ' is ' + v.version + ' in the lockfile');
});

// ── 2. The repo's own express with a plain express.json(): the bump alone must hold ──────────────────────────────

test('a plain express.json() on the installed body-parser survives every crash payload, and still inflates honest gzip', async () => {
  const expressPath = require.resolve('express', { paths: [ROOT] });
  const code = `
    const express = require(${JSON.stringify(expressPath)});
    const app = express();
    app.use(express.json());
    app.post('/ok', (req, res) => res.json({ ok: true, body: req.body }));
    app.get('/okget', (req, res) => res.json({ ok: true }));
    const s = app.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port));`;
  const child = spawn(process.execPath, ['-e', code], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', exitCode = null;
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('exit', (c) => { exitCode = c === null ? 'signal' : c; });
  const alive = () => exitCode === null;
  try {
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      const m = /PORT (\d+)/.exec(out);
      if (m) port = Number(m[1]); else await sleep(50);
    }
    assert.ok(port, 'app did not start: ' + out);

    for (const [method, url] of [['POST', '/ok'], ['GET', '/okget']]) {
      for (const [label, parts, gap] of PAYLOADS) {
        await send(port, method, url, parts, { gapMs: gap || 0 });
        await sleep(300);                                // let the trailing reads reach the decoder
        assert.ok(alive(), `${method} ${url} [${label}] ended the process (code ${exitCode}):\n`
          + out.split('\n').filter((l) => /Error|throw/.test(l)).slice(0, 5).join('\n'));
        const back = await send(port, 'GET', '/okget', [Buffer.alloc(0)], { encoding: '' });
        assert.strictEqual(back.status, 200, `${method} ${url} [${label}]: app stopped answering`);
      }
    }

    // Honest compressed JSON still parses: 1.20.9 is a non-breaking patch.
    const honest = await send(port, 'POST', '/ok', [zlib.gzipSync(Buffer.from('{"a":1}'))]);
    assert.strictEqual(honest.status, 200);
    assert.deepStrictEqual(honest.json, { ok: true, body: { a: 1 } });
  } finally {
    if (alive()) child.kill();
  }
});

// ── 3. The REAL server: compressed bodies are refused before zlib, honest JSON is untouched ─────────────────────

test('the real server refuses compressed bodies with 415, stays up through every crash payload, and still parses JSON', async () => {
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-local.js')], {
    cwd: ROOT, env: { ...process.env, DEV_LOCAL_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', exitCode = null;
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  srv.on('exit', (c) => { exitCode = c === null ? 'signal' : c; });
  const alive = () => exitCode === null;
  const died = () => 'server process exited (code ' + exitCode + '):\n'
    + out.split('\n').filter((l) => /Error|throw|at /.test(l)).slice(0, 8).join('\n');
  const plain = (method, url, body) => send(port, method, url,
    [Buffer.from(body === undefined ? '' : JSON.stringify(body))], { encoding: '' });
  try {
    let up = false;
    for (let i = 0; i < 240 && !up; i++) {             // up to 60 s: a busy machine boots it slowly
      if (!alive()) throw new Error(died());
      up = (await plain('GET', '/api/ping')).status === 200;
      if (!up) await sleep(250);
    }
    assert.ok(up, 'server did not come up');

    // Existing routes, GET and POST, with and without a route-level parser of their own.
    for (const [method, url] of [['GET', '/api/ping'], ['GET', '/api/live'], ['POST', '/api/track/visit']]) {
      for (const [label, parts, gap] of PAYLOADS) {
        const r = await send(port, method, url, parts, { gapMs: gap || 0 });
        await sleep(300);
        assert.ok(alive(), `${method} ${url} [${label}]: ` + died());
        assert.strictEqual(r.status, 415, `${method} ${url} [${label}] answered ${r.status}`);
      }
    }
    // deflate is refused the same way.
    const df = await send(port, 'POST', '/api/track/visit', [zlib.deflateSync(Buffer.from('{}'))], { encoding: 'deflate' });
    assert.strictEqual(df.status, 415);

    // Honest traffic: identity-encoded JSON parses exactly as before.
    const visit = await plain('POST', '/api/track/visit', { page: '/' });
    assert.strictEqual(visit.status, 200);
    assert.deepStrictEqual(visit.json, { ok: true });
    const idn = await send(port, 'POST', '/api/track/visit', [Buffer.from('{"page":"/"}')], { encoding: 'identity' });
    assert.strictEqual(idn.status, 200, 'an explicit Content-Encoding: identity must still parse');
    assert.strictEqual((await plain('GET', '/api/ping')).status, 200);
    assert.ok(alive(), died());
  } finally {
    if (alive()) srv.kill();
  }
});
