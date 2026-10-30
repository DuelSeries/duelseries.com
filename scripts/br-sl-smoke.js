/* ─── Battle royale on the sl engine: the server's doors, end to end ─────────
   node scripts/br-sl-smoke.js

   The room rules are unit-tested (test/slBr.test.js, test/brTimer.test.js);
   this boots the REAL server twice (SL_ENABLED, a throwaway owner key, temp
   data files) and checks the wiring Owen's rules depend on (2026-10-16):

     1. /api/br/owner says yes for the owner wallet and no for another
     2. the owner's signed Start begins a match with bots alone in the arena
     3. a second Start while it runs is refused out loud (one at a time), on
        both doors (/api/owner/do and the socket br:start)
     4. maintenance:check says a live battle royale is not safe to restart
     5. the Start's countdown keeps the doors open (Owen 2026-10-26) and
        nothing is in the journal until it goes live; then the doors shut, the
        match in flight is in the journal, and a hard kill and a reboot void it
        (logged, pushed) and clear it
     6. the owner's own Stop voids nothing behind his back (no restart push)
     7. the slither path /sl-io/ (server/ioOptions.js): its handshake is the
        main server's (x-ds-proc), and a free and a battle royale socket on it
        are seated, as the page connects them
     BR_SMOKE_FULL=1 also plays a whole bots-only match out (about 4 minutes). */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const io = require('socket.io-client');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const { actionMessage } = require('../server/ownerAuth');

const ROOT = path.join(__dirname, '..');
const PORT = 4511;
const BASE = 'http://127.0.0.1:' + PORT;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'br-sl-smoke-'));
const JOURNAL = path.join(DATA, 'br-journal.json');

const KEY = ed25519.utils.randomPrivateKey();
const OWNER = bs58.encode(ed25519.getPublicKey(KEY));
const OTHER = bs58.encode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
const proofFor = (action, args) => {
  const ts = Date.now();
  const msg = new TextEncoder().encode(actionMessage(action, args || {}, OWNER, ts));
  return { action, args: args || {}, wallet: OWNER, ts, sig: bs58.encode(ed25519.sign(msg, KEY)) };
};

let fails = 0;
const check = (ok, what) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + what);
  if (!ok) fails++;
};

function boot() {
  const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NTFY_DISABLED: '1', NODE_ENV: 'test', SL_ENABLED: '1',
      TEST_OWNER_WALLET: OWNER, ALLOW_TEST_OWNER: '1', DATABASE_URL: '',
      AG_JOURNAL_PATH: path.join(DATA, 'ag-journal.jsonl'), BR_JOURNAL_PATH: JOURNAL,
      BR_PODIUM_PATH: path.join(DATA, 'br-last-podium.json'), BR_ENGINE_SWITCH_PATH: path.join(DATA, 'br-engine-old.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.out = '';
  srv.stdout.on('data', (d) => { srv.out += d; });
  srv.stderr.on('data', (d) => { srv.out += d; });
  return srv;
}
async function json(url, body) {
  const r = await fetch(BASE + url, body ? { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) } : undefined);
  let j = null;
  try { j = await r.json(); } catch (_) { /* not json */ }
  return { status: r.status, j };
}
async function live() {
  try { return (await json('/api/live')).j.br; } catch (_) { return null; }
}
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (_) { /* not up yet */ }
    await wait(250);
  }
  check(false, 'timed out waiting for ' + what);
  return null;
}
const readJournal = () => { try { return JSON.parse(fs.readFileSync(JOURNAL, 'utf8')); } catch (_) { return null; } };
/* One /sl socket on the path the page gives a free or battle royale socket (public/js/slx/slxNet.js): it joins, and
   the answer is 'ok' at its first bundle, else the refusal or the error. */
function slJoin(auth, nick) {
  const sock = io(BASE + '/sl', { path: '/sl-io/', transports: ['websocket'], forceNew: true, reconnection: false, auth });
  return new Promise((resolve) => {
    const done = (r) => { clearTimeout(t); sock.close(); resolve(r); };
    const t = setTimeout(() => done('no answer'), 8000);
    sock.on('connect', () => sock.emit('sl:join', { nick }));
    sock.on('connect_error', (e) => done('connect error: ' + (e && e.message)));
    sock.on('sl:x', (m) => {
      const r = Array.isArray(m) ? m.find((x) => x && x.t === 'refused') : null;
      if (r) done('refused ' + r.why);
    });
    sock.on('sl:f', () => done('ok'));
  });
}

(async () => {
  let srv = boot();
  try {
    const br = await until(async () => { const b = await live(); return b && b.engine === 'sl' && b.alive >= 2 && b; },
      60000, 'the event arena to fill with bots');
    if (!br) throw new Error('no arena\n' + srv.out.slice(-2000));
    check(br.state === 'waiting' && br.humans === 0, 'boot: waiting, bots only (' + br.alive + ' snakes)');
    check(typeof br.autoPending === 'boolean' && br.prizeHeld === false, '/api/live carries autoPending and prizeHeld');

    check((await json('/api/br/owner', { wallet: OWNER })).j.isOwner === true, 'the owner wallet gets the Start button');
    check((await json('/api/br/owner', { wallet: OTHER })).j.isOwner === false, 'another wallet does not');

    const s1 = await json('/api/owner/do', proofFor('br:start', {}));
    check(s1.status === 200 && /Started with 0 player\(s\) and \d+ bot\(s\)/.test(s1.j.note), 'owner Start with bots alone: ' + (s1.j && (s1.j.note || s1.j.error)));
    const s2 = await json('/api/owner/do', proofFor('br:start', {}));
    check(s2.status === 409 && /already running/.test(s2.j.error), 'a second Start is refused: ' + (s2.j && s2.j.error));
    const b1 = await live();
    check(b1 && b1.state === 'countdown' && b1.joinable === true, 'the countdown keeps the doors open: ' + (b1 && b1.state));
    check(!(readJournal() || {}).live, 'nothing in the journal until it goes live');

    const sock = io(BASE, { transports: ['websocket'], forceNew: true });
    await until(() => sock.connected, 5000, 'the socket');
    const err = new Promise((res) => sock.once('br:error', res));
    sock.emit('br:start', { proof: proofFor('br:start', {}) });
    const e = await Promise.race([err, wait(3000).then(() => null)]);
    check(!!e && /already running/.test(e.message), 'the socket door refuses too: ' + (e && e.message));
    const err2 = new Promise((res) => sock.once('br:error', res));
    await wait(2100); // its rate limit
    sock.emit('br:start', { proof: proofFor('maintenance', {}) });
    const e2 = await Promise.race([err2, wait(3000).then(() => null)]);
    check(!!e2 && /owner wallet/.test(e2.message), 'an owner signature for another action is not a start');
    sock.close();

    const mc = await json('/api/owner/do', proofFor('maintenance:check', {}));
    check(mc.status === 409 && /battle royale match is live/.test(mc.j.error), 'maintenance:check: ' + (mc.j && mc.j.error));

    const b2 = await until(async () => { const b = await live(); return b && b.state === 'running' && b; }, 20000,
      'the match to go live');
    check(b2 && b2.joinable === false, 'doors shut at 0: ' + (b2 && b2.state));
    const j1 = readJournal();
    check(!!(j1 && j1.live && j1.live.matchId), 'the match in flight is in the journal');

    srv.kill('SIGKILL');
    await wait(800);
    srv = boot();
    await until(async () => { const b = await live(); return b && b.alive >= 2; }, 60000, 'the reboot');
    check(/cut off by a restart/.test(srv.out), 'the reboot voids the cut-off match (logged and pushed)');
    const j2 = readJournal();
    check(j2 && j2.live === null, 'and clears it from the journal');
    const b3 = await live();
    check(b3 && b3.state === 'waiting' && b3.joinable === true, 'a fresh arena after the reboot');

    const s3 = await json('/api/owner/do', proofFor('br:start', {}));
    check(s3.status === 200, 'Start again after the reboot');
    if (process.env.BR_SMOKE_FULL === '1') {
      /* The whole match with nobody watching: the idle pause must not hold it in
         countdown, and the circle must end it on its own (one snake left). */
      const t0 = Date.now();
      const over = await until(async () => { const b = await live(); return b && (b.state === 'over' || b.state === 'reopening') && b; },
        20 * 60 * 1000, 'the bots-only match to end');
      check(!!over && over.winner && over.alive <= 1, 'a bots-only match ends with one snake left after ' + Math.round((Date.now() - t0) / 1000) + ' s: ' + (over && over.winner && over.winner.name));
      check(!!over && over.prize === 0, 'and pays nothing');
      const back = await until(async () => { const b = await live(); return b && b.state === 'waiting' && b; }, 30000, 'the arena to reopen');
      check(!!back && back.joinable, 'the arena reopens for the next match');
      // the event's own log lines only ([BR] ...): the server logs other payout machinery at boot
      const paid = srv.out.split(/\r?\n/).filter((l) => l.includes('[BR]') && /PAYOUT|paid \d|prize held|no proven wallet/.test(l));
      check(paid.length === 0 && /won by a bot/.test(srv.out),
        'no payout or prize push for a bot win' + (paid.length ? ': ' + paid.join(' / ') : ''));
      const s4 = await json('/api/owner/do', proofFor('br:start', {}));
      check(s4.status === 200, 'the next match can start');
    }
    const stop = await json('/api/owner/do', proofFor('br:stop', {}));
    check(stop.status === 200 && (await live()).state === 'waiting', 'the owner Stop ends it');
    check(!/cut off \(/.test(srv.out), 'his own Stop is not reported back to him as a cut-off');
    check(readJournal().live === null, 'the journal is clear after his Stop');

    const hs = await fetch(BASE + '/sl-io/?EIO=4&transport=polling');
    check(hs.status === 200 && hs.headers.get('x-ds-proc') === 'main',
      'the /sl-io/ handshake is served by the main server: ' + hs.status + ' ' + hs.headers.get('x-ds-proc'));
    const free = await slJoin({ cv: 1 }, 'smoke free');
    check(free === 'ok', 'a free /sl socket on /sl-io/ is seated: ' + free);
    const brj = await slJoin({ br: 1 }, 'smoke br');
    check(brj === 'ok', 'a battle royale /sl socket on /sl-io/ is seated: ' + brj);
  } catch (e) {
    check(false, 'threw: ' + (e && e.message));
  } finally {
    srv.kill('SIGKILL');
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) { /* temp */ }
  }
  console.log(fails ? fails + ' FAILED' : 'all passed');
  process.exit(fails ? 1 : 0);
})();
