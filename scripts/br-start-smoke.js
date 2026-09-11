/* ─── Battle Royale "Start match" smoke test ──────────────────────────────────
   node scripts/br-start-smoke.js

   Drives the BUTTON, not the room. Every other battle-royale test drives
   BattleRoyaleRoom directly, which is exactly why a Start match button that
   could never authorise itself went unnoticed: the room was fine, the door was
   not.

   It boots the real server with a known owner wallet and checks, in order:

     1. br:peek tells a stranger they are NOT the owner
     2. br:peek tells the owner wallet that they ARE
     3. a stranger's start attempt is refused OUT LOUD (it used to be silent)
     4. a signature over the wrong action cannot be re-aimed at br:start
     5. the owner's real signature actually starts the match                */

const { spawn } = require('child_process');
const path = require('path');
const io = require('socket.io-client');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const { actionMessage } = require('../server/ownerAuth');

const ROOT = path.join(__dirname, '..');
const PORT = 4501;
const wait = ms => new Promise(r => setTimeout(r, ms));

const KEY = ed25519.utils.randomPrivateKey();
/* A second, unprivileged key. The non-owner case has to sign with a key the
   server does not know, not merely send a malformed proof — otherwise it proves
   nothing about who is allowed in. */
const OTHER_KEY = ed25519.utils.randomPrivateKey();
const OTHER = bs58.encode(ed25519.getPublicKey(OTHER_KEY));
const OWNER = bs58.encode(ed25519.getPublicKey(KEY));
const signAs = (key, wallet, action, args) => {
  const ts = Date.now();
  const msg = new TextEncoder().encode(actionMessage(action, args || {}, wallet, ts));
  return { action, args: args || {}, wallet, ts, sig: bs58.encode(ed25519.sign(msg, key)) };
};
const proofFor = (action, args) => signAs(KEY, OWNER, action, args);

const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), NTFY_DISABLED: '1', NODE_ENV: 'test',
         TEST_OWNER_WALLET: OWNER, ALLOW_TEST_OWNER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
srv.stdout.on('data', d => { out += d; });
srv.stderr.on('data', d => { out += d; });

/* Wait for one event, or give up. Returns null on timeout rather than hanging,
   because "nothing came back" is itself a result this test needs to assert. */
function once(sock, ev, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { sock.off(ev, h); resolve(null); }, ms);
    const h = (d) => { clearTimeout(t); sock.off(ev, h); resolve(d); };
    sock.on(ev, h);
  });
}

(async () => {
  const fails = [];
  const ok = (label, cond, extra) => {
    console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   ' + extra : ''));
    if (!cond) fails.push(label);
  };
  const base = 'http://127.0.0.1:' + PORT;
  let owner, guest;
  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(base + '/api/live'); if (r.ok) break; } catch (_) {}
      await wait(250);
    }

    guest = io(base, { transports: ['websocket'] });
    owner = io(base, { transports: ['websocket'] });
    await Promise.all([once(guest, 'connect', 5000), once(owner, 'connect', 5000)]);

    // Both need to be IN the room: canStart() counts living humans.
    guest.emit('play', { name: 'Guest', lobbyType: 'br', region: 'na' });
    owner.emit('play', { name: 'Owner', walletAddress: OWNER, lobbyType: 'br', region: 'na' });
    await wait(1200);

    // 1 + 2 — who does the server say the owner is?
    guest.emit('br:peek', { wallet: 'SomeoneElsesWalletAddress11111111111111111' });
    const gs = await once(guest, 'br:state', 3000);
    ok('a stranger is not told they are the owner', !!gs && gs.isOwner === false,
       gs ? 'isOwner=' + gs.isOwner : 'no reply');

    owner.emit('br:peek', { wallet: OWNER });
    const os = await once(owner, 'br:state', 3000);
    ok('the owner wallet IS told it is the owner', !!os && os.isOwner === true,
       os ? 'isOwner=' + os.isOwner : 'no reply');

    // 3 — a refusal that SAYS something. The old handler returned silently.
    guest.emit('br:start', { proof: signAs(OTHER_KEY, OTHER, 'br:start', {}) });
    const err1 = await once(guest, 'br:error', 3000);
    ok('a start from a non-owner signature is refused out loud', !!err1,
       err1 ? JSON.stringify(err1.message) : 'SILENT — the original bug');

    // 4 — a signature for another action must not work here.
    const reaimed = proofFor('maintenance:on', {});
    reaimed.action = 'br:start';
    owner.emit('br:start', { proof: reaimed });
    const err2 = await once(owner, 'br:error', 3000);
    ok('a signature cannot be re-aimed at br:start', !!err2,
       err2 ? JSON.stringify(err2.message) : 'accepted — BAD');

    // 5 — the real thing. Past the 2s rate limit the refusal above consumed:
    //     back-to-back presses are rate limited, which is correct, so the test
    //     has to wait rather than assert against its own impatience.
    await wait(2300);
    owner.emit('br:start', { proof: proofFor('br:start', {}) });
    let started = null;
    for (let i = 0; i < 20 && !started; i++) {
      const s = await once(owner, 'br:state', 1000);
      if (s && (s.state === 'countdown' || s.state === 'running')) started = s;
    }
    ok('the owner signature actually starts the match', !!started,
       started ? 'state=' + started.state : 'never left waiting');
  } catch (e) {
    ok('the smoke test ran', false, e.message);
  } finally {
    if (owner) owner.close();
    if (guest) guest.close();
    srv.kill();
    await wait(300);
  }
  if (fails.length) {
    console.log('\n' + fails.length + ' FAILED: ' + fails.join(', '));
    console.log('\n--- server output ---\n' + out.slice(-3000));
    process.exit(1);
  }
  console.log('\nall good');
})();
