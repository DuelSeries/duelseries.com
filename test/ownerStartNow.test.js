'use strict';
/* The owner's in-event Start now (Owen 2026-11-08) on the REAL server: the battle royale's page and the Swim Race's
   page send Control's own actions (br:start, se:start) to /api/owner/do (public/js/shared/dsOwnerStart.js), so the
   server alone decides who may start a match. Proven here on server/index.js as a child process (SL_ENABLED, a
   throwaway owner key, temp data):
   - anyone who is not the owner is refused (403) for both actions, whatever they send: nothing, a signature from
     their own wallet, a signature claiming the owner's wallet, a made-up Privy token, a made-up session cookie, or
     the owner header alone; and nothing starts;
   - the owner starts each: the Swim Race on the owner session cookie alone (no signature), the battle royale on a
     signature from the owner wallet; and the owner list is asked on the cookie request too (a second key signed in
     as a session is refused at sign-in).
   The client side (who sees the button, what a press sends) is test/dsOwnerStart.test.js, test/slxLayerHud.test.js
   and test/swimEventPage.test.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const { actionMessage } = require('../server/ownerAuth');
const { CREATE_ACTION } = require('../server/ownerSession');
const S = require('../shared/swimSim');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keypair() {
  const secret = ed25519.utils.randomPrivateKey();
  return { secret, wallet: bs58.encode(ed25519.getPublicKey(secret)) };
}
function proofFor(k, action, args, asWallet) {
  const ts = Date.now();
  const wallet = asWallet || k.wallet;
  const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(actionMessage(action, args, wallet, ts)), k.secret));
  return { action, args, wallet, ts, sig };
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = Object.assign({ Host: 'localhost:' + port }, headers);
    if (data !== null) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ hostname: '127.0.0.1', port, path: p, method, headers: h }, (x) => {
      let d = '';
      x.on('data', (c) => { d += c; });
      x.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch (_) { /* not JSON */ }
        resolve({ status: x.statusCode, headers: x.headers, body: j, text: d });
      });
    });
    r.on('error', reject);
    r.setTimeout(8000, () => r.destroy(new Error('timeout')));
    if (data !== null) r.write(data);
    r.end();
  });
}

test('in-event Start now: only the owner starts the battle royale and the Swim Race; everyone else is refused', { timeout: 180000 }, async (t) => {
  let io;
  try { io = require('socket.io-client'); } catch (_) { return t.skip('socket.io-client not installed'); }
  const owner = keypair();
  const other = keypair();
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-start-now-'));
  const env = { ...process.env, COMING_SOON_PATH: process.env.COMING_SOON_PATH || require('../scripts/soonLive').soonLiveFile(),
    REGION: 'na', PORT: String(port), SESSION_SECRET: 'test', MONEY_MODE: 'usdc', DATABASE_URL: '', NTFY_DISABLED: '1',
    POSTHOG_DISABLED: '1', ESCROW_PRIVATE_KEY: '', ESCROW_PUBLIC_KEY: '', RPC_URL: 'https://rpc.invalid/never-called',
    SOLANA_NETWORK: 'devnet', NODE_ENV: 'test', SL_ENABLED: '1', SL_PAID: '0', AG_PAID: '0',
    AG_JOURNAL_PATH: path.join(dir, 'ag-journal.jsonl'), BR_JOURNAL_PATH: path.join(dir, 'br-journal.json'),
    BR_PODIUM_PATH: path.join(dir, 'br-last-podium.json'), BR_ENGINE_SWITCH_PATH: path.join(dir, 'br-engine-old.json'),
    OWNER_SESSIONS_PATH: path.join(dir, 'owner-sessions.json'), ALLOW_TEST_OWNER: '1', TEST_OWNER_WALLET: owner.wallet };
  delete env.OWNER_SESSION_KEY;
  delete env.PRIVY_APP_ID;
  delete env.PRIVY_APP_SECRET;
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '' };
  srv.stdout.on('data', (d) => { out.text += d.toString(); });
  srv.stderr.on('data', (d) => { out.text += d.toString(); });
  const socks = [];
  t.after(() => {
    for (const s of socks) { try { s.close(); } catch (_) { /* gone */ } }
    try { srv.kill('SIGKILL'); } catch (_) { /* gone */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* in use */ }
  });

  const live = async () => (await request(port, 'GET', '/api/live')).body || {};
  let up = null;
  for (let i = 0; i < 150 && !up && srv.exitCode === null; i++) {
    // the event arena filled with bots, and the Swim Race's door open (the server's 1 s tick opens it)
    try { const l = await live(); if (l.br && l.br.engine === 'sl' && l.br.alive >= 2 && l.swimEvent && l.swimEvent.joinOpen) up = l; } catch (_) { /* booting */ }
    if (!up) await sleep(400);
  }
  assert.ok(up, 'server came up with the event arena filled\n' + out.text.slice(-1500));
  assert.equal(up.br.state, 'waiting');

  // a racer in the Swim Race's lobby, so a start has someone to start with
  const racer = io('http://127.0.0.1:' + port, { transports: ['websocket'], forceNew: true, reconnection: false });
  socks.push(racer);
  const joined = new Promise((res) => { racer.once('se:joined', () => res(true)); racer.once('se:refused', (r) => res(r)); });
  racer.on('connect', () => racer.emit('se:join', { name: 'Ann', car: 'supercar', v: S.VERSION }));
  assert.equal(await Promise.race([joined, sleep(8000).then(() => 'no answer')]), true, 'the racer joined the lobby');

  const owners = { 'X-DS-Owner': '1', Origin: 'http://localhost:' + port };
  const doIt = (body, headers) => request(port, 'POST', '/api/owner/do', { headers: Object.assign({}, owners, headers || {}), body });

  // ---- everyone else: refused, for both actions, whatever they send
  for (const action of ['br:start', 'se:start']) {
    const tries = {
      'nothing': await doIt({ action, args: {} }),
      'no owner header, nothing': await request(port, 'POST', '/api/owner/do', { body: { action, args: {} } }),
      'their own wallet signed it': await doIt(proofFor(other, action, {})),
      'their wallet signed it, claiming the owner\'s': await doIt(proofFor(other, action, {}, owner.wallet)),
      'the owner wallet, no signature': await doIt({ action, args: {}, wallet: owner.wallet, ts: Date.now(), sig: '' }),
      'a made-up Privy token': await doIt({ action, args: {} }, { Authorization: 'Bearer eyJhbGciOiJFUzI1NiJ9.e30.x', 'privy-id-token': 'x.y.z' }),
      'a made-up session cookie': await doIt({ action, args: {} }, { Cookie: 'ds_owner=AAAA.BBBB' }),
      'the owner\'s signature for another action': await doIt(Object.assign(proofFor(owner, 'maintenance:check', {}), { action })),
    };
    for (const [how, r] of Object.entries(tries)) {
      assert.equal(r.status, 403, action + ', ' + how + ': ' + r.status + ' ' + r.text.slice(0, 160));
      assert.ok(!r.body || !r.body.ok, action + ', ' + how + ': no ok');
      assert.ok(!r.body || r.body.state === undefined, action + ', ' + how + ': no console state leaks');
    }
  }
  const still = await live();
  assert.equal(still.br.state, 'waiting', 'nothing started the battle royale');
  assert.ok(still.swimEvent.state === undefined || still.swimEvent.state === 'waiting', 'nor the Swim Race: ' + JSON.stringify(still.swimEvent).slice(0, 200));

  // ---- the owner, on the session cookie alone (a device signed into Control): the Swim Race starts
  const ch = await request(port, 'GET', '/api/owner/session/challenge');
  assert.equal(ch.status, 200, ch.text);
  const jar = [].concat(ch.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const login = await request(port, 'POST', '/api/owner/session/login', { headers: Object.assign({ Cookie: jar }, owners),
    body: proofFor(owner, CREATE_ACTION, { nonce: ch.body.nonce, host: 'localhost:' + port, label: 'Start now test' }) });
  assert.equal(login.status, 200, login.text);
  const cookie = [].concat(login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).filter((c) => /^ds_owner=/.test(c)).join('; ');
  assert.ok(cookie, 'a session cookie');
  // the same cookie without the owner header is not the owner (a cross-site form cannot add it)
  const bare = await request(port, 'POST', '/api/owner/do', { headers: { Cookie: cookie }, body: { action: 'se:start', args: {} } });
  assert.equal(bare.status, 403, 'a cookie write without the owner header: ' + bare.text.slice(0, 120));
  const se = await doIt({ action: 'se:start', args: {} }, { Cookie: cookie });
  assert.equal(se.status, 200, se.text.slice(0, 300));
  assert.match(se.body.note, /Swim Race starting in 15 seconds/);
  assert.match(se.body.state.audit[0].who, /^session:/, 'the audit names the device');

  // ---- another key can never make a session of its own (the owner list is asked at sign-in and on every request)
  const ch2 = await request(port, 'GET', '/api/owner/session/challenge');
  const jar2 = [].concat(ch2.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const login2 = await request(port, 'POST', '/api/owner/session/login', { headers: Object.assign({ Cookie: jar2 }, owners),
    body: proofFor(other, CREATE_ACTION, { nonce: ch2.body.nonce, host: 'localhost:' + port, label: 'Not the owner' }) });
  assert.notEqual(login2.status, 200, 'not an owner: no session');

  // ---- the owner, on a signature from the owner wallet (the lobby's bridge): the battle royale starts with bots
  const br = await doIt(proofFor(owner, 'br:start', {}));
  assert.equal(br.status, 200, br.text.slice(0, 300));
  assert.match(br.body.note, /Started with \d+ player\(s\) and \d+ bot\(s\)/);
  const after = await live();
  assert.ok(after.br.state === 'countdown' || after.br.state === 'running', 'the match is on: ' + after.br.state);
  // and a second press says why not, with the reason (Control's own rule: one match at a time)
  const again = await doIt(proofFor(owner, 'br:start', {}));
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already running/);
  assert.ok(!/TypeError|ReferenceError|is not a function/.test(out.text), 'no wiring error\n' + out.text.slice(-800));
});
