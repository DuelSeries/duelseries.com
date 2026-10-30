'use strict';
/* The server split end to end (spec 13 and 14.1 #6): scripts/dev-local.js (its in-memory database, every outbound call
   refused) booted as a process of its own, with ports the OS hands out for the main server and SL_CHILD_PORT.

   SL_SPLIT=1:
   - the slither process answers /sl-io/ on SL_CHILD_PORT (x-ds-proc: sl) and seats a free player there; the main
     server's /sl refuses a free socket 'closed' and seats a paid one: a dev $0.50 token, hold Q, paid 90/10 through
     the fake withdraw (the money never left the main server)
   - /api/live has the slither rows and no unknown; the owner's bots:set and br:start reach the slither process and
     answer in the console's words
   - SIGKILL the slither process with a battle royale live: unknown sl and br within 6 s, the restart check unsafe and
     saying why, the old free rung's row back, the match voided once; the refork clears unknown
   - SIGINT (on Windows: the kill) of the main server: the slither process is gone within 2 s
   SL_SPLIT=0: the same free and paid flows, on both ports, by the one process (x-ds-proc: main), and no [SPLIT] line. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const { actionMessage } = require('../server/ownerAuth');
const W = require('../shared/slWire.js');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function request(port, p, method, obj) {
  return new Promise((res, rej) => {
    const body = obj === undefined ? '' : JSON.stringify(obj);
    const headers = body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {};
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (x) => {
      let d = '';
      x.on('data', (c) => { d += c; });
      x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: d }));
    });
    r.on('error', rej);
    r.setTimeout(6000, () => r.destroy(new Error('timeout')));
    r.end(body);
  });
}

async function until(fn, ms, step) {
  const end = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (_) { v = null; }
    if (v || Date.now() >= end) return v;
    await sleep(step || 200);
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function boot(extra) {
  const port = await freePort();
  const childPort = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slsplit-'));
  const env = Object.assign({}, process.env, { DEV_LOCAL_PORT: String(port), SL_CHILD_PORT: String(childPort),
    SL_ENABLED: '1', SL_DEV_LAWS: path.join(__dirname, 'slLawsFixture.js'), SL_PAID: '1',
    AG_JOURNAL_PATH: path.join(dir, 'ag-money-journal.log'), RPC_DAY_PATH: path.join(dir, 'rpc-day.json') }, extra);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  delete env.NODE_ENV;
  // the paid smoke's preload, only for its SIGINT trigger (a file 'sigint' in dir emits SIGINT inside the server, so
  // the shutdown handlers run on Windows too, where a kill is no signal)
  env.SLP_SMOKE_TRIGGER = dir;
  const srv = spawn(process.execPath, ['-r', path.join(__dirname, 'slPaidSmoke.preload.js'),
    path.join(ROOT, 'scripts', 'dev-local.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '' };
  srv.stdout.on('data', (d) => { out.text += d; });
  srv.stderr.on('data', (d) => { out.text += d; });
  const up = await until(async () => (await request(port, '/api/live', 'GET')).status === 200, 60000, 300);
  if (!up) {
    try { srv.kill('SIGKILL'); } catch (_) {}
    throw new Error('dev-local did not come up\n' + out.text.slice(-2000));
  }
  const m = /\[dev-local\] throwaway owner secret \(bs58, local only\) (\S+)/.exec(out.text);
  assert.ok(m, 'dev-local printed its owner');
  const key = bs58.decode(m[1]);
  const wallet = bs58.encode(ed25519.getPublicKey(key));
  let seq = 0;
  const proof = (action, args) => {
    const ts = Date.now();
    const a = Object.assign({ n: ++seq }, args);
    const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(actionMessage(action, a, wallet, ts)), key));
    return { action, args: a, wallet, ts, sig };
  };
  const ownerDo = async (action, args) => {
    const r = await request(port, '/api/owner/do', 'POST', proof(action, args || {}));
    let j = {};
    try { j = JSON.parse(r.body); } catch (_) {}
    return { status: r.status, text: j.note || j.error || r.body, state: j.state };
  };
  const live = async () => JSON.parse((await request(port, '/api/live', 'GET')).body);
  const state = async () => JSON.parse((await request(port, '/api/owner/state', 'POST', proof('state', {}))).body);
  return { srv, port, childPort, out, dir, ownerDo, live, state };
}

let addrs = 0;
// One /sl socket. o: { port, path, auth }. Steers toward the centre and pings, as the paid smoke does.
function slSocket(o) {
  const { io } = require('socket.io-client');
  const xff = '198.51.100.' + (++addrs % 250);
  const s = io(`http://127.0.0.1:${o.port}/sl`, Object.assign({ transports: ['websocket'], forceNew: true,
    reconnection: false, timeout: 6000, extraHeaders: { 'x-forwarded-for': xff }, auth: o.auth }, o.path ? { path: o.path } : {}));
  const h = { s, items: [], events: [], gone: null, grd: null, own: null, q: null, pingOut: false, pingAt: 0 };
  s.on('disconnect', (why) => { h.gone = String(why); });
  s.on('sl:x', (list) => { for (const it of Array.isArray(list) ? list : []) h.items.push(it); });
  s.on('sl:f', (data) => {
    let evs = [];
    try { evs = W.decodeBundle(data instanceof Uint8Array ? data : new Uint8Array(data)); } catch (_) { return; }
    for (const ev of evs) {
      h.events.push(ev);
      if (ev.type === 'pong') h.pingOut = false;
      else if (ev.type === 'init') h.grd = ev.grd;
      else if (ev.type === 'snake_add' && !h.own && ev.nick === o.nick && h.grd !== null) {
        h.own = ev;
        const th = Math.atan2(h.grd - ev.sny, h.grd - ev.snx);
        h.q = Math.round(((((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)) * 251) % 251;
      }
    }
  });
  h.beat = setInterval(() => {
    if (!s.connected) return;
    const recs = h.q === null ? [] : [{ type: 'angle', q: h.q }];
    const now = Date.now();
    if (now - h.pingAt >= (h.pingOut ? 2000 : 250)) { recs.push({ type: 'ping' }); h.pingOut = true; h.pingAt = now; }
    if (recs.length) try { s.emit('sl:i', W.encodeInput(recs)); } catch (_) {}
  }, 200);
  h.close = () => { clearInterval(h.beat); try { s.close(); } catch (_) {} };
  h.ready = new Promise((resolve) => {
    s.on('connect', () => resolve(true));
    s.on('connect_error', (e) => resolve(e));
  });
  h.refused = () => (h.items.find((x) => x.t === 'refused') || {}).why;
  return h;
}

async function freeJoin(o, nick, socks) {
  const h = slSocket(Object.assign({ nick, auth: { cv: 3 } }, o));
  socks.push(h);
  assert.strictEqual(await h.ready, true, nick + ' connected');
  h.s.emit('sl:join', { nick });
  await until(() => h.own || h.refused(), 10000, 50);
  return h;
}

async function mint(port, wallet) {
  const r = await request(port, '/api/submit-stake', 'POST', { stake: 0.5, walletAddress: wallet, devGame: 'slither' });
  assert.strictEqual(r.status, 200, r.body);
  return JSON.parse(r.body).entryToken;
}

// A dev $0.50 seat on the main server's /sl (default path), held to a cash-out: the money path never leaves main.
async function paidRound(b, wallet, socks) {
  const nick = 'pay' + wallet.slice(-4);
  const h = slSocket({ port: b.port, nick, auth: { paid: 1, stake: 0.5, entryToken: await mint(b.port, wallet), cv: 1 } });
  socks.push(h);
  assert.strictEqual(await h.ready, true);
  h.s.emit('sl:join', { nick });
  const first = await until(() => h.items.find((x) => x.t === 'room' || x.t === 'refused'), 15000, 50);
  assert.deepStrictEqual(first, { t: 'room', stake: 0.5, cut: 10 }, 'the paid door: ' + JSON.stringify(h.items));
  await until(() => h.q !== null, 15000, 50);
  h.s.emit('sl:hold', { on: 1 });
  const cashed = await until(() => h.items.find((x) => x.t === 'cashed' || x.t === 'lost'), 30000, 100);
  assert.ok(cashed, 'the hold finished: ' + JSON.stringify(h.items.slice(-3)));
  assert.deepStrictEqual([cashed.t, cashed.gross, cashed.cut, cashed.net], ['cashed', 500000, 50000, 450000]);
  const paidLine = await until(() => new RegExp('\\[SLP\\] CASHOUT 450000 micro -> ' + wallet.slice(0, 8)).test(b.out.text), 15000);
  assert.ok(paidLine, 'paid through the dev money\n' + b.out.text.slice(-1500));
  h.close();
}

const procOf = async (port) => {
  const r = await request(port, '/sl-io/?EIO=4&transport=polling', 'GET');
  return [r.status, r.headers['x-ds-proc'] || null, /^0\{"sid"/.test(r.body)];
};
const slRows = (l) => l.lobbies.filter((x) => x.id === 'sl:na:s0').length;
const oldFree = (l) => l.lobbies.filter((x) => /^snake:na:s0$/.test(x.id)).length;

test('split: the slither process serves free and BR, main keeps paid and money; a kill is unknown, voids the match, reforks', { timeout: 240000 }, async (t) => {
  const b = await boot({ SL_SPLIT: '1' });
  const socks = [];
  t.after(() => { for (const h of socks) h.close(); try { b.srv.kill('SIGKILL'); } catch (_) {} });
  const pidOf = () => [...b.out.text.matchAll(/\[SPLIT\] the slither process started \(pid (\d+)\)/g)].map((m) => Number(m[1]));
  const ready = await until(async () => { const l = await b.live(); return !l.unknown && slRows(l) === 1 ? l : null; }, 30000);
  assert.ok(ready, 'the slither process reports: ' + JSON.stringify(await b.live()).slice(0, 300) + '\n' + b.out.text.slice(-1500));
  assert.strictEqual(oldFree(ready), 0, 'the new free row replaces the old one');
  assert.strictEqual(typeof ready.br.state, 'string');
  assert.strictEqual(pidOf().length, 1);
  const pid1 = pidOf()[0];
  assert.notStrictEqual(pid1, b.srv.pid);

  assert.deepStrictEqual(await procOf(b.childPort), [200, 'sl', true], 'the slither process answers its port');
  assert.deepStrictEqual(await procOf(b.port), [200, 'main', true], 'main still answers the path (nginx\'s backup)');

  // free on the slither process's port and path: seated
  const f = await freeJoin({ port: b.childPort, path: '/sl-io/' }, 'freesplit', socks);
  assert.ok(f.own, 'seated in the slither process: ' + JSON.stringify(f.items));
  // free on main's /sl: refused closed (main's /sl takes paid seats and paid watchers only)
  const fm = await freeJoin({ port: b.port }, 'freemain', socks);
  assert.strictEqual(fm.refused(), 'closed');
  // paid on main: seated, held, paid 90/10 by main
  await paidRound(b, 'SpLitDevWa11et1111111111111111111111111111', socks);

  // the console sees the slither process's rooms through the link
  const st = await b.state();
  const view = (id) => st.rooms.find((r) => r.id === id);
  assert.deepStrictEqual([view('sl_na_s0').label, view('sl_na_s0').takesBots], ['slither.io (new) · Free', true]);
  assert.deepStrictEqual([view('sl_na_br').label, view('sl_na_br').game], ['slither.io (new) · Battle royale', 'battle royale']);
  assert.strictEqual(st.battleRoyale.engine, 'sl');
  assert.strictEqual(st.battleRoyale.room, 'sl_na_br');
  const rung0 = st.games.find((g) => g.id === 'slither').rungs.find((r) => r.rung === 0);
  assert.deepStrictEqual([rung0.room, rung0.botsAllowed], ['sl_na_s0', true]);
  assert.strictEqual(st.drain.safe, true, 'free players never make a restart unsafe: ' + st.drain.reason);

  // the owner's commands reach the slither process and answer in the console's words
  const set = await b.ownerDo('bots:set', { room: 'sl_na_s0', count: 5 });
  assert.strictEqual(set.status, 200, set.text);
  assert.match(set.text, /^slither\.io \(new\) · Free: \d+ bots? now, held at 5 until you change it\./);
  const add = await b.ownerDo('bots:add', { room: 'sl_na_s0', count: 2 });
  assert.match(add.text, /^Added \d bot\(s\) to sl_na_s0$|^That room would not take any bots$/);
  const auto = await b.ownerDo('bots:set', { room: 'sl_na_s0', auto: true });
  assert.match(auto.text, /is back on its own bots/);
  const start = await b.ownerDo('br:start', { force: false });
  // in a slot hour (2, 8, 14, 20 ET) the slot timer may have started one already: either way a match is under way
  if (start.status === 200) assert.match(start.text, /^Started with \d+ player\(s\) and \d+ bot\(s\)$/);
  else assert.match(start.text, /^A match is already running\./);
  const running = await until(async () => ((await b.live()).br || {}).state === 'running', 20000, 300);
  assert.ok(running, 'the match went live after its countdown');
  const matchCheck = await b.ownerDo('maintenance:check');
  assert.strictEqual(matchCheck.status, 409);
  assert.match(matchCheck.text, /a battle royale match is live/);

  // kill the slither process: unknown within 6 s, unsafe, the old free rung back, the match void once
  process.kill(pid1, 'SIGKILL');
  const t0 = Date.now();
  const unk = await until(async () => { const l = await b.live(); return l.unknown && l.unknown.includes('sl') && l.unknown.includes('br') ? l : null; }, 6000, 100);
  assert.ok(unk, 'unknown sl and br within 6 s (' + (Date.now() - t0) + ' ms)');
  assert.strictEqual(unk.br, null, 'no br while it cannot be seen');
  assert.strictEqual(slRows(unk), 0);
  assert.strictEqual(oldFree(unk), 1, 'the old free rung has its row back');
  const unsafe = await b.ownerDo('maintenance:check');
  assert.strictEqual(unsafe.status, 409, 'the restart check is not safe while it cannot see the match');
  assert.match(unsafe.text, /the slither process is not reporting/);
  const voided = await until(() => /\[BR\] br_\w+ was cut off by the slither process stopping \(\d+ player\(s\)\): void, no prize/.test(b.out.text), 5000);
  assert.ok(voided, 'the live match was voided\n' + b.out.text.slice(-1500));
  assert.strictEqual((b.out.text.match(/was cut off by the slither process stopping/g) || []).length, 1, 'once');
  const stDown = await b.state();
  assert.ok(!stDown.rooms.some((r) => /^sl_na_(s0|br)$/.test(r.id)), 'no room it cannot see');
  assert.strictEqual(stDown.battleRoyale.state, 'unknown');
  assert.strictEqual(stDown.drain.safe, false);
  const cmdDown = await b.ownerDo('br:stop');
  assert.match(cmdDown.text, /^The slither process is restarting; try again$|^No match is running$/);

  // the refork: reporting again, unknown gone
  const back = await until(async () => { const l = await b.live(); return !l.unknown && slRows(l) === 1 ? l : null; }, 30000, 300);
  assert.ok(back, 'reforked and reporting\n' + b.out.text.slice(-1500));
  assert.strictEqual(pidOf().length, 2);
  const pid2 = pidOf()[1];
  assert.notStrictEqual(pid2, pid1);
  assert.strictEqual(back.br.state, 'waiting', 'a fresh arena');
  const f2 = await freeJoin({ port: b.childPort, path: '/sl-io/' }, 'freeagain', socks);
  assert.ok(f2.own, 'the new slither process seats');
  assert.strictEqual((b.out.text.match(/was cut off by the slither process stopping/g) || []).length, 1, 'still once');

  // SIGINT to the main server (pm2's restart, or Ctrl-C): it tells the slither process to stop, which says goodbye
  // and is gone within 2 s, and it is not forked again
  const t1 = Date.now();
  fs.writeFileSync(path.join(b.dir, 'sigint'), '');
  const gone = await until(() => !alive(pid2), 4000, 50);
  assert.ok(gone, 'the slither process stopped with the main server\n' + b.out.text.slice(-1500));
  assert.ok(Date.now() - t1 < 2500, 'within 2 s (the trigger polls every 100 ms): ' + (Date.now() - t1) + ' ms');
  assert.match(b.out.text, /\[SL-CHILD\] stopping \(shutdown\)/);
  await sleep(2500);
  assert.strictEqual(pidOf().length, 2, 'not forked again');
  // and the main server dying outright (the channel closes) takes a slither process with it: test/slChild.test.js
});

test('single (SL_SPLIT=0): the same flows on both ports by the one process', { timeout: 180000 }, async (t) => {
  const b = await boot({ SL_SPLIT: '0' });
  const socks = [];
  t.after(() => { for (const h of socks) h.close(); try { b.srv.kill('SIGKILL'); } catch (_) {} });
  const l = await until(async () => { const x = await b.live(); return !x.unknown && slRows(x) === 1 ? x : null; }, 30000);
  assert.ok(l, 'sl rows and no unknown');
  assert.strictEqual(typeof l.br.state, 'string');
  assert.deepStrictEqual(await procOf(b.port), [200, 'main', true]);
  assert.deepStrictEqual(await procOf(b.childPort), [200, 'main', true], 'the alias listener answers SL_CHILD_PORT');
  const a = await freeJoin({ port: b.childPort, path: '/sl-io/' }, 'freealias', socks);
  assert.ok(a.own, 'seated over the alias port');
  const m = await freeJoin({ port: b.port }, 'freemain', socks);
  assert.ok(m.own, 'seated on main\'s own /sl');
  await paidRound(b, 'SingLeDevWa11et111111111111111111111111111', socks);
  const set = await b.ownerDo('bots:set', { room: 'sl_na_s0', count: 5 });
  assert.match(set.text, /^slither\.io \(new\) · Free: \d+ bots? now, held at 5 until you change it\./);
  assert.ok(!/\[SPLIT\]/.test(b.out.text), 'no split line in single mode');
});
