/* ─── Battle Royale join smoke test ───────────────────────────────────────────
   node scripts/br-join-smoke.js

   Walks the path a player actually takes into the nightly event, in order:

     1. the stake quote for lobbyType=br      (this is where it said "Unknown
                                               lobby" and the launch stopped)
     2. joining the room over a socket
     3. the room reporting itself as the battle royale, not the free room

   It exists because the mode was unit-tested to death and still could not be
   entered: every test drove the ROOM, and nothing drove the door. */

const { spawn } = require('child_process');
const path = require('path');
const io = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = 4499;
const wait = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), NTFY_DISABLED: '1', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
srv.stdout.on('data', d => { out += d; });
srv.stderr.on('data', d => { out += d; });

(async () => {
  const fails = [];
  const ok = (label, cond, extra) => {
    console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   ' + extra : ''));
    if (!cond) fails.push(label);
  };
  const base = 'http://127.0.0.1:' + PORT;
  let sock;
  try {
    for (let i = 0; i < 40; i++) {
      try { await fetch(base + '/api/prices'); break; } catch (_) { await wait(500); }
    }

    // 1. The quote. This is the step that failed.
    const r = await fetch(base + '/api/stake-quote?lobbyType=br');
    const q = await r.json().catch(() => ({}));
    ok('the stake quote knows what br is', r.status === 200, 'status=' + r.status
       + ' ' + JSON.stringify(q).slice(0, 80));
    ok('and says it costs nothing', q.feeSol === 0 || q.amountUsdc === 0 || q.lamports === 0
       || q.units === 0, JSON.stringify(q).slice(0, 80));

    // Staking into it must still be impossible.
    const s = await fetch(base + '/api/submit-stake', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lobbyType: 'br', signedTx: 'x' }),
    });
    ok('but you cannot stake into it', s.status === 400, 'status=' + s.status);

    // 2 + 3. Actually join, and land in the right room.
    sock = io(base, { transports: ['websocket'], reconnection: false });
    const joined = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 8000);
      sock.on('connect', () => {
        sock.emit('play', { name: 'SmokeTester', lobbyType: 'br', region: 'na' });
      });
      // The real event name, from shared/constants: game_joined.
      sock.on('game_joined', (d) => { clearTimeout(t); resolve(d); });
      sock.on('br:locked', () => { clearTimeout(t); resolve(null); });
      sock.on('maintenance', () => { clearTimeout(t); resolve(null); });
    });
    ok('a player can join the battle royale room', !!joined,
       joined ? 'radius=' + Math.round(joined.worldRadius) : 'no gameJoined event');

    /* The free room opens near 2000 and the battle royale at MAX_WORLD_RADIUS.
       Landing in the free room by fallback is the failure this catches, and it
       is silent otherwise — you get a game, just the wrong one. */
    ok('and it is the battle royale, not the free room',
       !!joined && joined.worldRadius > 4000,
       joined ? 'radius=' + Math.round(joined.worldRadius) : '');

    ok('the server logged it as the br lobby', /joins br lobby/.test(out),
       (out.match(/joins \w+ lobby/) || ['none'])[0]);
  } catch (e) {
    console.error('THREW:', e.message);
    fails.push('threw: ' + e.message);
  } finally {
    if (sock) sock.close();
    srv.kill();
    await wait(300);
    console.log('\n' + (fails.length ? fails.length + ' FAILED' : 'the door into the event works'));
    if (fails.length) console.log('\n--- server output ---\n' + out.slice(-1200));
    process.exit(fails.length ? 1 : 0);
  }
})();
