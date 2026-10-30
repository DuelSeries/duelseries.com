'use strict';
// Coming soon on the real server (scripts/dev-local.js with no switch file: production's default, agar.io and
// Battleship locked). The pages answer the Coming soon page, invites go home, /api/live and /api/soon.js carry the
// list, the Battleship queue and a new agar.io page are refused, and the other games are untouched. The switch, the
// agar.io directory, its sockets and paid door are unit tested in comingSoon.test.js and agPaidDoor.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
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
    let d = ''; r.on('data', (c) => { d += c; });
    r.on('end', () => resolve({ status: r.statusCode, body: d, location: r.headers.location, cc: r.headers['cache-control'] }));
  });
  q.on('error', () => resolve(null));
  q.setTimeout(4000, () => { q.destroy(); resolve(null); });
});

test.before(async () => {
  port = await freePort();
  // a path with no file: the switch boots with its defaults
  const soonFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soonsrv-')), 'coming-soon.json');
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

test('the pages, invites and lists of a Coming soon game; other games as before', async () => {
  for (const p of ['/ag', '/battleship']) {
    const r = await get(p);
    assert.strictEqual(r.status, 503, p);
    assert.ok(r.body.includes('Coming soon') && r.body.includes('Back to the lobby') && r.body.includes('game:done'), p);
  }
  for (const p of ['/knockout', '/paper', '/swim']) assert.strictEqual((await get(p)).status, 200, p);
  for (const p of ['/play/cells', '/play/battleship']) assert.deepStrictEqual([(await get(p)).status, (await get(p)).location], [302, '/'], p);
  assert.strictEqual((await get('/play/knockout')).status, 200);
  const js = await get('/api/soon.js');
  assert.strictEqual(js.cc, 'no-store');
  assert.strictEqual(js.body.trim(), 'window.DS_SOON=Object.freeze(["agar","battleship"]);');
  const live = JSON.parse((await get('/api/live')).body);
  assert.deepStrictEqual(live.soon, ['agar', 'battleship']);
  assert.strictEqual(live.paidDoors.battleship, false, 'no paid Battleship rung is offered');
  assert.strictEqual(live.paidDoors.knockout, true);
  assert.ok(live.lobbies.filter((l) => l.game === 'agar' && l.stake > 0).every((l) => l.state === 'closed'));
  assert.ok((await get('/')).body.includes('<script src="/api/soon.js"></script>'));
  assert.match(out, /\[SOON\] agar\.io is Coming soon/);
});

test('the Battleship queue and a new agar.io page are refused; Knockout still queues', async () => {
  const { io } = require('socket.io-client');
  const opts = { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000 };
  const bs = await new Promise((done) => {
    const s = io('http://127.0.0.1:' + port, opts);
    s.on('connect', () => s.emit('bs:queue', { name: 'probe', stake: 0 }));
    s.on('bs:refused', (p) => { s.close(); done(['refused', p.why]); });
    s.on('bs:queued', () => { s.close(); done(['queued']); });
    setTimeout(() => { s.close(); done(['timeout']); }, 6000);
  });
  assert.deepStrictEqual(bs, ['refused', 'Battleship is coming soon. It is taking a short break and will be back.']);
  const ag = await new Promise((done) => {
    const s = io('http://127.0.0.1:' + port + '/ag', opts);
    const got = [];
    s.on('ag:refused', (p) => got.push(p.why));
    s.on('disconnect', () => done(got));
    setTimeout(() => { s.close(); done(got.concat('timeout')); }, 6000);
  });
  assert.deepStrictEqual(ag, ['soon'], 'refused and closed');
  const ko = await new Promise((done) => {
    const s = io('http://127.0.0.1:' + port, opts);
    s.on('connect', () => s.emit('ko:queue', { name: 'probe', stake: 0 }));
    s.on('ko:queued', () => { s.emit('ko:unqueue'); s.close(); done('queued'); });
    s.on('ko:refused', (p) => { s.close(); done('refused ' + p.why); });
    setTimeout(() => { s.close(); done('timeout'); }, 6000);
  });
  assert.strictEqual(ko, 'queued');
  assert.ok(!/TypeError|ReferenceError|is not defined/.test(out), out.slice(-1500));
});
