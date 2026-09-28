'use strict';
/* Boots the real server and plays Paper on it for real (design 6.4, 11).
   Every other Paper test drives the modules with fakes. Only this one proves
   server/index.js wires them: the arenas exist at boot with every hook a
   function, the socket handlers are attached, frames flow, /api/live lists the
   Paper rows, the dev entry-token switch refuses to run beside an escrow key,
   and a dev token buys a paid seat through the normal one-time consume and
   cashes out at 90/10 through the fake withdraw. Boot pattern copied from
   test/joinSmoke.test.js. */
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const MP = require('../public/js/paper/mp/paperWire.js');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const { actionMessage } = require('../server/ownerAuth');

const ROOT = path.join(__dirname, '..');
let nextPort = 4900 + Math.floor(Math.random() * 300);

const get = (url) => new Promise((res, rej) => {
  const r = http.get(url, (x) => {
    let d = ''; x.on('data', c => d += c); x.on('end', () => res({ status: x.statusCode, body: d }));
  });
  r.on('error', rej);
  r.setTimeout(4000, () => { r.destroy(new Error('timeout')); });
});

const post = (url, obj) => new Promise((res, rej) => {
  const body = JSON.stringify(obj);
  const r = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body) } }, (x) => {
    let d = ''; x.on('data', c => d += c); x.on('end', () => res({ status: x.statusCode, body: d }));
  });
  r.on('error', rej);
  r.setTimeout(4000, () => { r.destroy(new Error('timeout')); });
  r.end(body);
});

async function waitForServer(port, srv, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (srv.exitCode !== null) return false;
    try { const r = await get(`http://localhost:${port}/api/live`); if (r.status === 200) return true; }
    catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// The same safe env as joinSmoke, with every Paper switch set explicitly so an
// inherited shell value can never decide what a test is testing.
function boot(extra) {
  const port = nextPort++;
  const env = { ...process.env, REGION: 'na', PORT: String(port),
                SESSION_SECRET: 'test', MONEY_MODE: 'usdc', DATABASE_URL: '',
                NTFY_DISABLED: '1', POSTHOG_DISABLED: '1',
                PAPER_PAID: '', PAPER_DEV_TOKENS: '', ESCROW_PRIVATE_KEY: '', NODE_ENV: 'test',
                ...extra };
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '' };
  srv.stdout.on('data', d => { out.stdout += d.toString(); });
  srv.stderr.on('data', d => { out.stderr += d.toString(); });
  return { srv, port, out };
}

/* pp:joined carries every base ring and trail as its own binary attachment, so
   an arena with many squares sends well over ten. The browser bundle the pages
   load (/socket.io/socket.io.js) has no cap on that, but the node client's
   socket.io-parser 4.2.6 refuses more than 10 and drops the connection with
   "parse error". The test client lifts the cap to behave like the browser. */
function browserLikeParser() {
  const parser = require('socket.io-parser');
  class Decoder extends parser.Decoder {
    constructor(opts) { super(Object.assign({ maxAttachments: 100000 }, typeof opts === 'object' ? opts : {})); }
  }
  return { ...parser, Decoder };
}

function connect(io, port) {
  const sock = io(`http://localhost:${port}`, {
    transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000,
    parser: browserLikeParser(),
  });
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 10000);
    sock.on('connect', () => { clearTimeout(bail); res(sock); });
    sock.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}

function once(sock, event, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no ' + event + ' within ' + ms + ' ms')), ms);
    sock.once(event, (m) => { clearTimeout(t); res(m); });
  });
}

// pp:join until the arena answers with a seat or a real refusal. The free arena
// warms up at boot and says so ('warming', retryMs); a client retries by itself.
function join(sock, msg, ms = 20000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { cleanup(); rej(new Error('pp:join got no answer')); }, ms);
    const onJoined = (m) => { cleanup(); res({ joined: m }); };
    const onRefused = (m) => {
      if (m && m.why === 'warming') {
        setTimeout(() => sock.emit('pp:join', msg), Math.max(1100, m.retryMs || 500));
        return;
      }
      cleanup();
      res({ refused: m });
    };
    const cleanup = () => { clearTimeout(t); sock.off('pp:joined', onJoined); sock.off('pp:refused', onRefused); };
    sock.on('pp:joined', onJoined);
    sock.on('pp:refused', onRefused);
    sock.emit('pp:join', msg);
  });
}

// A throwaway owner (ALLOW_TEST_OWNER), signing console actions the way the
// browser does. Same pattern as scripts/owner-smoke.js.
const ownerKey = ed25519.utils.randomPrivateKey();
const ownerAddr = bs58.encode(ed25519.getPublicKey(ownerKey));
const ownerProof = (action, args) => {
  const ts = Date.now();
  const msg = new TextEncoder().encode(actionMessage(action, args, ownerAddr, ts));
  return { action, args, wallet: ownerAddr, ts, sig: bs58.encode(ed25519.sign(msg, ownerKey)) };
};

// The first of `events` the socket sees, with its name.
function first(sock, events, ms) {
  return new Promise((res, rej) => {
    const offs = [];
    const done = () => { clearTimeout(t); for (const off of offs) off(); };
    const t = setTimeout(() => { done(); rej(new Error('none of ' + events.join(', ') + ' within ' + ms + ' ms')); }, ms);
    for (const ev of events) {
      const on = (m) => { done(); res({ event: ev, msg: m }); };
      sock.on(ev, on);
      offs.push(() => sock.off(ev, on));
    }
  });
}

function paperRows(board) {
  return board.lobbies.filter(l => l.game === 'paper');
}

function assertHealthy(srv, out) {
  assert.equal(srv.exitCode, null, 'server still running\n--- stderr ---\n' + out.stderr.slice(-1500));
  assert.ok(!/ReferenceError|TypeError|is not defined|\[PAPER\] handler/.test(out.stderr),
    'no runtime error\n--- stderr ---\n' + out.stderr.slice(-1500));
}

function requireClient(t) {
  try { return require('socket.io-client'); }
  catch (_) { t.skip('socket.io-client not installed'); return null; }
}

test('free Paper: a join is seated and frames flow; paid is closed without PAPER_PAID', { timeout: 90000 }, async (t) => {
  const io = requireClient(t);
  if (!io) return;
  const { srv, port, out } = boot({ ALLOW_TEST_OWNER: '1', TEST_OWNER_WALLET: ownerAddr });
  const socks = [];
  t.after(() => {
    for (const s of socks) { try { s.close(); } catch (_) {} }
    try { srv.kill('SIGKILL'); } catch (_) {}
  });
  assert.ok(await waitForServer(port, srv), 'server came up\n' + out.stderr.slice(-1500));

  // /api/live: the free rung only, and the snake board is still in front of it.
  const board = JSON.parse((await get(`http://localhost:${port}/api/live`)).body);
  const rows = paperRows(board);
  assert.equal(rows.length, 1, 'one Paper row without PAPER_PAID');
  assert.equal(rows[0].stake, 0);
  assert.equal(rows[0].id, 'paper:na:s0');
  assert.equal(rows[0].capacity, MP.MAX_HUMANS);
  assert.ok(board.lobbies.length > 1 && board.lobbies[0].game !== 'paper', 'liveBoard rows come first');

  const a = await connect(io, port);
  socks.push(a);
  const r = await join(a, { stake: 0, name: 'smoketest' });
  assert.ok(r.joined, 'free join seated, got ' + JSON.stringify(r.refused));
  assert.ok(Number.isInteger(r.joined.you) && r.joined.you > 0, 'own unit id');
  assert.equal(r.joined.stake, 0);
  assert.equal(typeof r.joined.resumeKey, 'string');
  const buf = await once(a, 'pp:s', 10000); // 30 a second while anyone is seated
  const f = MP.decodeFrame(new Uint8Array(buf));
  assert.ok(f, 'a pp:s frame decodes');

  // A paid rung with no token: closed before anything is read.
  const b = await connect(io, port);
  socks.push(b);
  const p = await join(b, { stake: 0.1, name: 'paid' });
  assert.ok(p.refused, 'paid join refused');
  assert.equal(p.refused.why, 'not-open');
  assert.ok(typeof p.refused.text === 'string' && p.refused.text.length > 0, 'with a reason to show');
  assert.equal(p.refused.refunded, false);

  // The owner-facing live count sees the free player.
  const after = paperRows(JSON.parse((await get(`http://localhost:${port}/api/live`)).body));
  assert.ok(after[0].players >= 1, 'the free Paper row counts the player');

  /* The console's Clear bots on the free arena reports a real count and does
     not promise a pause Paper does not honour (it tops its bots back up by
     itself). It used to say 'Removed undefined bot(s) ... staying empty'. */
  let room = null;
  for (let i = 0; i < 40 && !room; i++) {
    const st = await post(`http://localhost:${port}/api/owner/state`, ownerProof('state', {}));
    assert.equal(st.status, 200, 'the throwaway owner reads the console: ' + st.body.slice(0, 200));
    room = JSON.parse(st.body).rooms.find(r => r.game === 'Paper' && r.takesBots && r.bots > 0) || null;
    if (!room) await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(room, 'the free Paper arena has bots while someone plays');
  const clr = await post(`http://localhost:${port}/api/owner/do`, ownerProof('bots:clear', { room: room.id }));
  assert.equal(clr.status, 200, clr.body.slice(0, 300));
  const note = JSON.parse(clr.body).note;
  assert.ok(!/undefined|NaN/.test(note), 'a real count: ' + note);
  assert.ok(/^Removed [1-9]\d* bot/.test(note), 'it removed the bots it had: ' + note);
  assert.ok(!/staying empty/.test(note), 'no pause is promised: ' + note);
  assert.ok(/on its own/.test(note), 'and it says the arena refills: ' + note);
  assertHealthy(srv, out);
});

test('PAPER_DEV_TOKENS=1 beside an escrow key, a database or in production refuses to boot, naming the flag', { timeout: 60000 }, async () => {
  for (const extra of [{ PAPER_DEV_TOKENS: '1', ESCROW_PRIVATE_KEY: 'dummy-not-a-key' },
                       { PAPER_DEV_TOKENS: '1', NODE_ENV: 'production' },
                       { PAPER_DEV_TOKENS: '1', DATABASE_URL: 'postgres://dev:dev@db.invalid:5432/duelseries' }]) {
    const { srv, out } = boot(extra);
    const code = await new Promise((res) => {
      const t = setTimeout(() => { try { srv.kill('SIGKILL'); } catch (_) {} res('timeout'); }, 20000);
      srv.on('exit', (c) => { clearTimeout(t); res(c); });
    });
    assert.notEqual(code, 'timeout', 'the server exits instead of serving ' + JSON.stringify(extra));
    assert.notEqual(code, 0, 'with a failure code');
    assert.ok(out.stderr.includes('PAPER_DEV_TOKENS'), 'and says which switch\n' + out.stderr.slice(-800));
  }
});

test('dev tokens: a POST without signedTx buys a paid seat that cashes out 90/10', { timeout: 90000 }, async (t) => {
  const io = requireClient(t);
  if (!io) return;
  const { srv, port, out } = boot({ PAPER_PAID: '1', PAPER_DEV_TOKENS: '1' });
  const socks = [];
  t.after(() => {
    for (const s of socks) { try { s.close(); } catch (_) {} }
    try { srv.kill('SIGKILL'); } catch (_) {}
  });
  assert.ok(await waitForServer(port, srv), 'server came up\n' + out.stderr.slice(-1500));

  const rows = paperRows(JSON.parse((await get(`http://localhost:${port}/api/live`)).body));
  assert.deepEqual(rows.map(r => r.stake), [0, 0.1, 1], 'three Paper rows with PAPER_PAID=1');

  // No token: refused at the token step, nothing seated, nothing refunded.
  const a = await connect(io, port);
  socks.push(a);
  const none = await join(a, { stake: 0.1, name: 'notoken' });
  assert.ok(none.refused, 'refused');
  assert.equal(none.refused.why, 'entry');
  assert.ok(none.refused.text && none.refused.text.length > 0, 'with a reason');
  assert.equal(none.refused.refunded, false);

  // The dev mint still demands a wallet and a rung.
  assert.equal((await post(`http://localhost:${port}/api/submit-stake`, { stake: 0.1 })).status, 400,
    'no wallet, no token');
  assert.equal((await post(`http://localhost:${port}/api/submit-stake`,
    { stake: 0.37, walletAddress: 'DevWa11et1111111111111111111111111111111111' })).status, 400,
    'off the ladder, no token');

  const wallet = 'DevWa11et1111111111111111111111111111111111';
  const res = await post(`http://localhost:${port}/api/submit-stake`, { stake: 0.1, walletAddress: wallet });
  assert.equal(res.status, 200, res.body);
  const tok = JSON.parse(res.body);
  assert.equal(tok.ok, true);
  assert.equal(typeof tok.entryToken, 'string');
  assert.equal(tok.stake, 0.1);
  assert.equal(tok.worth, 0.1);
  assert.equal(tok.paid, 0.1);

  // The token seats a paid join, worth taken from the token, not from the message.
  // (pp:join is rate limited to one a second per socket; a faster one is dropped.)
  await new Promise(r => setTimeout(r, 1100));
  const seated = await join(a, { stake: 0.1, name: 'dev', entryToken: tok.entryToken, worth: 50, micro: 5e7, wallet: 'X' });
  assert.ok(seated.joined, 'paid join seated, got ' + JSON.stringify(seated.refused));
  assert.equal(seated.joined.stake, 0.1);
  const me = (seated.joined.units || []).find(u => u && u.id === seated.joined.you);
  assert.ok(me, 'the join payload lists my own square');
  assert.equal(me.micro, 100000, 'worth from the token, not the 50 the message claimed');
  // The player steers, as the page does right after pp:joined: that confirms the seat, so the
  // token no longer names it (an unconfirmed seat's token takes it back, see the join-lost test).
  a.emit('pp:in', MP.encodeInput(1, 0, false));
  await new Promise(r => setTimeout(r, 300));

  // One-time: the same token on another socket buys nothing.
  const b = await connect(io, port);
  socks.push(b);
  const replay = await join(b, { stake: 0.1, name: 'replay', entryToken: tok.entryToken });
  assert.ok(replay.refused, 'a spent token is refused');
  assert.equal(replay.refused.why, 'entry');

  /* A dev token is Paper's only. Every other game pays through the REAL money
     module, where an unbacked token would become a real owed-payout row. */
  const devOne = JSON.parse((await post(`http://localhost:${port}/api/submit-stake`,
    { stake: 1, walletAddress: wallet })).body);
  assert.equal(typeof devOne.entryToken, 'string');
  const kc = await connect(io, port);
  socks.push(kc);
  const ko = first(kc, ['ko:queued', 'ko:refused'], 8000);
  kc.emit('ko:queue', { name: 'dev', stake: 1, entryToken: devOne.entryToken });
  const koAns = await ko;
  assert.equal(koAns.event, 'ko:refused', 'knockout refuses a Paper dev token: ' + JSON.stringify(koAns.msg));
  assert.ok(!/\[KO\] (refunding|CRITICAL)/.test(out.stdout + out.stderr), 'nothing was refunded or owed');
  const atOne = await join(kc, { stake: 1, name: 'devone', entryToken: devOne.entryToken });
  assert.ok(atOne.joined, 'the refusal did not spend it; it still seats at Paper $1: ' + JSON.stringify(atOne.refused));
  assert.equal(atOne.joined.stake, 1);

  // Hold to cash out: not early, then exactly 90/10 through the fake withdraw.
  let seq = 0;
  let early = null;
  const cashed = new Promise((res) => a.once('pp:cashedout', (m) => { early = early || Date.now(); res(m); }));
  const paid = new Promise((res) => a.once('pp:paid', res));
  const started = Date.now();
  const hold = setInterval(() => { seq = (seq + 1) & 255; a.emit('pp:in', MP.encodeInput(seq, 0, true)); }, 50);
  t.after(() => clearInterval(hold));
  await new Promise(r => setTimeout(r, MP.HOLD_MS - 1000));
  assert.equal(early, null, 'no cash-out before the hold completes');
  const c = await Promise.race([cashed, new Promise((_, rej) => setTimeout(() => rej(new Error('no pp:cashedout')), 8000))]);
  clearInterval(hold);
  assert.ok(Date.now() - started >= MP.HOLD_MS - 100, 'the hold took its full time');
  assert.equal(c.grossMicro, 100000);
  assert.equal(c.cutMicro, 10000);
  assert.equal(c.netMicro, 90000);
  const pd = await Promise.race([paid, new Promise((_, rej) => setTimeout(() => rej(new Error('no pp:paid')), 5000))]);
  assert.ok(/^DEV/.test(String(pd.sig)), 'paid by the fake withdraw');
  assert.equal(pd.netMicro, 90000);
  assert.ok(out.stdout.includes('[PAPER] DEV withdraw 0.09'), 'the dev withdraw logged the net');
  assert.ok(out.stdout.includes('[PAPER] DEV rake 0.01'), 'the rake stayed off the real sweep');

  // The seat is gone and the paid row is empty again.
  const end = paperRows(JSON.parse((await get(`http://localhost:${port}/api/live`)).body));
  assert.equal(end.find(r => r.stake === 0.1).players, 0, 'no one left at $0.10');
  assertHealthy(srv, out);
});

/* STATUS "BEFORE PAPER_PAID IS SWITCHED ON" item 2 on the real server: the link closes after
   pp:join went out but before pp:joined came back. Before the fix the seat was orphaned (no
   resumeKey ever reached the player) and its money dropped on the floor when the grace ended;
   now the buy-in goes back once, through the (dev) withdraw, and the page's second ask with the
   same token is told so. */
test('a paid join whose link closes before pp:joined is refunded once and never left on the floor', { timeout: 60000 }, async (t) => {
  const io = requireClient(t);
  if (!io) return;
  const { srv, port, out } = boot({ PAPER_PAID: '1', PAPER_DEV_TOKENS: '1' });
  const socks = [];
  t.after(() => {
    for (const s of socks) { try { s.close(); } catch (_) {} }
    try { srv.kill('SIGKILL'); } catch (_) {}
  });
  assert.ok(await waitForServer(port, srv), 'server came up\n' + out.stderr.slice(-1500));
  const wallet = 'DevWa11et2222222222222222222222222222222222';
  const tok = JSON.parse((await post(`http://localhost:${port}/api/submit-stake`, { stake: 0.1, walletAddress: wallet })).body);
  assert.equal(typeof tok.entryToken, 'string');

  const a = await connect(io, port);
  socks.push(a);
  /* The link closes before the player ever steered. To the server that is exactly the lost
     pp:joined case (it cannot tell whether pp:joined arrived); waiting for it here only makes
     the order deterministic (a close sent right behind the join raced it under load). */
  const seated = await join(a, { name: 'lost', stake: 0.1, entryToken: tok.entryToken });
  assert.ok(seated.joined, 'the join reached the server and seated: ' + JSON.stringify(seated.refused));
  a.disconnect(); // no pp:in ever went out

  const waitFor = async (fn, ms, what) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 50)); }
    assert.fail(what + '\n--- stdout ---\n' + out.stdout.slice(-2000));
  };
  await waitFor(() => out.stdout.includes('[PAPER] REFUND ' + wallet + ' 100000 join-lost'), 8000, 'refunded at the close');
  await waitFor(() => out.stdout.includes('[PAPER] DEV withdraw 0.1 '), 8000, 'paid back through the (dev) withdraw');

  // The page asks again with the same token on its next link: told, nothing more paid or seated.
  const b = await connect(io, port);
  socks.push(b);
  const again = await join(b, { stake: 0.1, name: 'lost', entryToken: tok.entryToken });
  assert.ok(again.refused, 'no seat: ' + JSON.stringify(again.joined && again.joined.you));
  assert.equal(again.refused.why, 'join-lost');
  assert.equal(again.refused.refunded, true);

  // Past the old grace: still exactly one refund and one withdraw, no coin, nobody seated.
  await new Promise(r => setTimeout(r, MP.DISCONNECT_GRACE_MS + 500));
  const count = (needle) => out.stdout.split(needle).length - 1;
  assert.equal(count('[PAPER] REFUND ' + wallet + ' '), 1, 'refunded exactly once');
  assert.equal(count('[PAPER] DEV withdraw'), 1, 'one withdraw');
  assert.ok(!/\[PAPER\] IDLE paper_na_s0_1 .*"coins":\[\{/.test(out.stdout), 'no coin left on the floor');
  const rows = paperRows(JSON.parse((await get(`http://localhost:${port}/api/live`)).body));
  assert.equal(rows.find(r => r.stake === 0.1).players, 0, 'no orphaned seat');
  assertHealthy(srv, out);
});
