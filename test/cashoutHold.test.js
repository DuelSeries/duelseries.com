'use strict';
/* Boots the real server and tries to cheat it.

   Cashing out is the one action in this game that turns a snake into money,
   and the hold is what makes it cost something: you crawl to a fifth speed
   while a ring over your head tells the room to come and take it. Until this
   was fixed, both halves lived entirely in the browser — the client counted
   the three seconds and the client sent its own speed multiplier — so a
   modified client banked instantly at full speed and took none of the risk
   every honest player takes. In a real-money game that is a repeatable edge,
   not a cosmetic bug.

   These tests are the attack, run for real: connect, skip the hold, and check
   that no money event comes back. */
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 4900 + Math.floor(Math.random() * 400);
const C = require('../shared/constants');

const get = (url) => new Promise((res, rej) => {
  const r = http.get(url, (x) => { let d = ''; x.on('data', c => d += c); x.on('end', () => res({ status: x.statusCode, body: d })); });
  r.on('error', rej);
  r.setTimeout(4000, () => r.destroy(new Error('timeout')));
});

async function waitForServer(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await get(`http://localhost:${port}/api/live`); if (r.status === 200) return true; }
    catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

test('cashing out requires the hold, and the server times it', { timeout: 90000 }, async (t) => {
  let io;
  try { io = require('socket.io-client'); }
  catch (_) { t.skip('socket.io-client not installed'); return; }

  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: { ...process.env, COMING_SOON_PATH: process.env.COMING_SOON_PATH || require('../scripts/soonLive').soonLiveFile(), REGION: 'na', PORT: String(PORT), SESSION_SECRET: 'test',
           MONEY_MODE: 'usdc', DATABASE_URL: '', NTFY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { srv.kill('SIGKILL'); } catch (_) {} });
  let stderr = '';
  srv.stderr.on('data', d => { stderr += d.toString(); });
  assert.ok(await waitForServer(PORT), 'server came up');

  /* One run of the attack on a fresh socket and a fresh snake. The free room has
     bots, and the test's snake steers nothing, so now and then a bot kills it
     before the honest hold (measured 2026-11-01: 1 run in 24 under a loaded
     box, the hold then paid nothing because there was no snake to pay). Every
     check below means something only while the snake is alive, so a run in
     which it died is thrown away and done again, rather than counted as a pass
     or a failure. */
  async function attempt() {
    const sock = io(`http://localhost:${PORT}`, {
      transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000,
    });
    let died = false;
    sock.on(C.EVENTS.PLAYER_DIED, () => { died = true; });
    try {
      await new Promise((res, rej) => {
        const bail = setTimeout(() => rej(new Error('socket never connected')), 10000);
        sock.on('connect', () => { clearTimeout(bail); res(); });
        sock.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
      });

      // Join the free room. Worth is zero there, but the guard being tested runs
      // before any of that and emits the same result event either way.
      const joined = new Promise((res, rej) => {
        const bail = setTimeout(() => rej(new Error('never joined')), 15000);
        sock.on(C.EVENTS.GAME_JOINED, () => { clearTimeout(bail); res(); });
      });
      sock.emit(C.EVENTS.PLAY, { name: 'holdtest', lobbyType: 'free', stake: 0, region: 'na' });
      await joined;

      const nextResult = (ms) => new Promise((res) => {
        const timer = setTimeout(() => { sock.off('cashout:result', hit); res(null); }, ms);
        function hit(payload) { clearTimeout(timer); sock.off('cashout:result', hit); res(payload); }
        sock.on('cashout:result', hit);
      });
      const out = {};

      /* THE CHEAT: bank without ever holding. This is a one-line client edit. */
      sock.emit('cashout');
      out.noHold = await nextResult(1500);

      /* Cut a hold short — the other half of the same cheat, holding just long
         enough to look legitimate and releasing before the risk window is up. */
      sock.emit('cashout:start');
      await new Promise(r => setTimeout(r, Math.round(C.CASHOUT_HOLD_MS / 3)));
      sock.emit('cashout');
      out.cutShort = await nextResult(400);

      /* Cancelling has to actually release it, or a cancelled hold would keep
         counting and pay out on its own later. */
      sock.emit('cashout:cancel');
      out.cancelled = await nextResult(C.CASHOUT_HOLD_MS);
      if (died) return { died };

      /* And the honest path: hold, and the SERVER completes it. Nothing is emitted
         by the client to finish it — deliberately, because the client's clock
         starts a round trip earlier than the server's, so a client that announced
         "three seconds are up" would always be announcing it slightly too early. */
      /* Generous slack on purpose. This file and joinSmoke each boot a real
         server, node:test runs files in parallel, and under that contention the
         run stretched from 10s to 14s and ate a 4s margin — a false failure that
         teaches you to ignore red. What is being asserted is that the payout does
         not arrive EARLY; waiting longer for it cannot weaken that. */
      const paid = nextResult(C.CASHOUT_HOLD_MS + 20000);
      const t0 = Date.now();
      sock.emit('cashout:start');
      out.result = await paid;
      out.took = Date.now() - t0;
      // A death before the payout lands is a bot's doing, not the hold's (a cash-out ends the snake with no death).
      if (died && !out.result) return { died };
      return out;
    } finally {
      try { sock.close(); } catch (_) {}
    }
  }

  let run = null;
  for (let i = 0; i < 4 && !run; i++) {
    const r = await attempt();
    if (!r.died) run = r;
  }
  assert.ok(run, 'a bot killed the test snake in 4 runs out of 4');

  assert.equal(run.noHold, null, 'cashing out with no hold pays nothing');
  assert.equal(run.cutShort, null, 'a hold cut short pays nothing');
  assert.equal(run.cancelled, null, 'a cancelled hold never pays out');
  assert.ok(run.result, 'holding pays out without the client asking');
  assert.ok(run.took >= C.CASHOUT_HOLD_MS - 50,
    `the full hold was served (${run.took}ms >= ${C.CASHOUT_HOLD_MS}ms)`);

  assert.equal(srv.exitCode, null, `server still alive. stderr:\n${stderr}`);
});

test('the slowdown is the server\'s, not a number the client sends', () => {
  const fs = require('fs');
  const snake = fs.readFileSync(path.join(ROOT, 'server/Snake.js'), 'utf8');
  const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  const game = fs.readFileSync(path.join(ROOT, 'public/js/game.js'), 'utf8');

  // setInput must not accept it, and the getter must derive it from the clock.
  assert.ok(/setInput\(targetAngle, boosting\)/.test(snake), 'setInput takes no speed from the caller');
  assert.ok(/get speedMult\(\)/.test(snake), 'the server derives the multiplier');
  assert.ok(/cashoutStartedAt/.test(snake), 'from its own cash-out clock');

  // The INPUT handler must not read it off the wire.
  const input = idx.slice(idx.indexOf('C.EVENTS.INPUT'), idx.indexOf('C.EVENTS.INPUT') + 300);
  assert.ok(!/speedMult/.test(input), 'the input handler ignores any speed the client sends');

  // And the client must not be sending it, so nobody is tempted to trust it.
  assert.ok(!/speedMult: cashoutSpeedMult/.test(game), 'the client no longer sends a speed');
});
