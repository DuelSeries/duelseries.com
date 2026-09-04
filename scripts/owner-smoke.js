/* ─── Owner console smoke test ────────────────────────────────────────────────
   node scripts/owner-smoke.js

   Boots the real server on a spare port with a THROWAWAY key registered as an
   owner through OWNER_WALLET, then drives every owner endpoint over real HTTP:
   reading the console, maintenance on and off, the restart-safety check, bots
   in and out, starting a match, the refusals, the audit log and the diagnostic.

   It exists because the unit tests prove the VERIFIER and prove nothing at all
   about the wiring. Run it after touching anything under the owner routes. */
const { spawn } = require('child_process');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const { actionMessage } = require(require('path').join(__dirname, '..', 'server', 'ownerAuth'));

const ROOT = require('path').join(__dirname, '..');
const PORT = 4477;

const ownerKey = ed25519.utils.randomPrivateKey();
const ownerAddr = bs58.encode(ed25519.getPublicKey(ownerKey));
const strangerKey = ed25519.utils.randomPrivateKey();
const strangerAddr = bs58.encode(ed25519.getPublicKey(strangerKey));

const proof = (key, addr, action, args) => {
  const ts = Date.now();
  const msg = new TextEncoder().encode(actionMessage(action, args, addr, ts));
  return { action, args, wallet: addr, ts, sig: bs58.encode(ed25519.sign(msg, key)) };
};

const post = async (path, body) => {
  const r = await fetch('http://127.0.0.1:' + PORT + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const srv = spawn(process.execPath, [ROOT + '/server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), OWNER_WALLET: ownerAddr, NTFY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
srv.stdout.on('data', d => { out += d; });
srv.stderr.on('data', d => { out += d; });

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const fails = [];
  const ok = (label, cond, extra) => {
    console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   ' + extra : ''));
    if (!cond) fails.push(label);
  };
  try {
    // Wait for it to listen.
    for (let i = 0; i < 40; i++) {
      try { await fetch('http://127.0.0.1:' + PORT + '/api/prices'); break; } catch (_) { await wait(500); }
    }

    let r = await post('/api/owner/state', proof(ownerKey, ownerAddr, 'state', {}));
    ok('an owner can read the console', r.status === 200 && !!r.body.rooms,
       'rooms=' + (r.body.rooms || []).length);
    const hasBr = (r.body.rooms || []).some(x => x.game === 'battle royale');
    ok('the battle royale room is registered', hasBr);

    r = await post('/api/owner/state', proof(strangerKey, strangerAddr, 'state', {}));
    ok('a stranger with a perfect signature is refused', r.status === 403);

    r = await post('/api/owner/state', { action: 'state', args: {}, wallet: ownerAddr, ts: Date.now(), sig: 'nonsense' });
    ok('a forged signature is refused', r.status === 403);

    // Maintenance, both ways, and its effect on the snapshot.
    r = await post('/api/owner/do', proof(ownerKey, ownerAddr, 'maintenance:on', { message: 'brb', minutes: 5 }));
    ok('the owner can close the doors', r.status === 200 && r.body.state.maintenance.maintenance === true,
       JSON.stringify(r.body.note || r.body.error));

    r = await post('/api/owner/do', proof(ownerKey, ownerAddr, 'maintenance:check', {}));
    ok('and ask whether a restart is safe', r.status === 200 || r.status === 409,
       JSON.stringify(r.body.note || r.body.error));

    r = await post('/api/owner/do', proof(ownerKey, ownerAddr, 'maintenance:off', {}));
    ok('and open them again', r.status === 200 && r.body.state.maintenance.maintenance === false);

    // Bots into a named room, then out again.
    r = await post('/api/owner/do', proof(ownerKey, ownerAddr, 'bots:add', { room: 'na_free', count: 4 }));
    ok('bots go into a named room', r.status === 200, JSON.stringify(r.body.note || r.body.error));
    const withBots = (r.body.state.rooms || []).find(x => x.id === 'na_free');
    ok('and show up in the room list', withBots && withBots.bots >= 4, 'bots=' + (withBots && withBots.bots));

    r = await post('/api/owner/do', proof(ownerKey, ownerAddr, 'bots:clear', { room: 'na_free' }));
    const cleared = (r.body.state.rooms || []).find(x => x.id === 'na_free');
    ok('and can be taken back out', r.status === 200 && cleared && cleared.bots === 0,
       'bots=' + (cleared && cleared.bots));

    // Battle royale, started alone.
    r = await post('/api/owner/do', proof(ownerKey, ownerAddr, 'br:start', {}));
    ok('starting an empty match is refused', r.status === 409, JSON.stringify(r.body.error));

    r = await post('/api/owner/do', proof(ownerKey, ownerAddr, 'br:start', { force: true }));
    ok('and forcing one with nobody in it is refused too', r.status === 409, JSON.stringify(r.body.error));

    r = await post('/api/owner/do', proof(ownerKey, ownerAddr, 'announce', { text: 'testing' }));
    ok('an announcement goes out', r.status === 200);

    r = await post('/api/owner/do', proof(ownerKey, ownerAddr, 'nonsense:action', {}));
    ok('an unknown action is refused', r.status === 409);

    // The audit log recorded all of it.
    r = await post('/api/owner/state', proof(ownerKey, ownerAddr, 'state', {}));
    ok('every action was logged', (r.body.audit || []).length >= 8, 'entries=' + (r.body.audit || []).length);
    ok('including the refusals', (r.body.audit || []).some(a => a.ok === false));

    // The diagnostic.
    r = await post('/api/owner/diagnose', proof(ownerKey, ownerAddr, 'diagnose', {}));
    ok('the diagnostic reports the signature path', r.status === 200 && r.body.signature.isOwner === true,
       'privyConfigured=' + r.body.privyConfigured + ' serverAppId=' + r.body.serverAppId);

    r = await post('/api/owner/diagnose', {});
    ok('and refuses to name the owner wallets to a stranger', r.status === 403,
       'status=' + r.status);
  } catch (e) {
    console.error('THREW:', e.message);
    fails.push('threw: ' + e.message);
  } finally {
    srv.kill();
    await wait(300);
    console.log('\n' + (fails.length ? fails.length + ' FAILED' : 'every owner check holds'));
    if (fails.length) console.log('\n--- server output ---\n' + out.slice(-1500));
    process.exit(fails.length ? 1 : 0);
  }
})();
