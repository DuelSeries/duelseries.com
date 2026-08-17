'use strict';
/* Boots the real server and joins it for real.
   Every other test in this repo reads source text. None of them could catch
   the bug that took production down: `shortType` was deleted but still
   referenced two lines later, which node only discovers when the line runs.
   node --check passes, every unit test passes, and the process dies on the
   first player who presses Play.
   So this one actually connects a socket, sends PLAY, and asserts the server
   is still alive afterwards. It is slow and it is worth it. */
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = 4500 + Math.floor(Math.random() * 400);

const get = (url) => new Promise((res, rej) => {
  const r = http.get(url, (x) => {
    let d = ''; x.on('data', c => d += c); x.on('end', () => res({ status: x.statusCode, body: d }));
  });
  r.on('error', rej);
  r.setTimeout(4000, () => { r.destroy(new Error('timeout')); });
});

async function waitForServer(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await get(`http://localhost:${port}/api/live`); if (r.status === 200) return true; }
    catch (_) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

test('a player can join without killing the server', { timeout: 90000 }, async (t) => {
  let io;
  try { io = require('socket.io-client'); }
  catch (_) { t.skip('socket.io-client not installed'); return; }

  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: { ...process.env, REGION: 'na', PORT: String(PORT),
           SESSION_SECRET: 'test', MONEY_MODE: 'usdc', DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  srv.stderr.on('data', d => { stderr += d.toString(); });

  assert.ok(await waitForServer(PORT), 'server came up');

  const C = require('../shared/constants');
  /* reconnection off, and the socket is torn down in `after` whether the test
     passes or fails. With reconnection on, a socket whose server has just died
     retries forever and holds the event loop open, so the test HANGS on
     exactly the failure it exists to catch instead of reporting it. */
  const sock = io(`http://localhost:${PORT}`, {
    transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000,
  });
  t.after(() => {
    try { sock.close(); } catch (_) {}
    try { srv.kill('SIGKILL'); } catch (_) {}
  });

  await new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 10000);
    sock.on('connect', () => { clearTimeout(bail); res(); });
    sock.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });

  // Free play on the ladder: a stake of 0 needs no token, which is exactly the
  // path a player takes when they press Play on a free room.
  sock.emit(C.EVENTS.PLAY, {
    name: 'smoketest', walletAddress: 'W', googleId: 'W', color: '#c080ff',
    stake: 0, entryToken: '', region: 'na',
  });

  // Give the handler time to run all the way through, including the owner
  // notification strings that were the actual crash site.
  await new Promise(r => setTimeout(r, 2500));

  // Checked before anything else, so a dead server reports as a dead server
  // rather than as a confusing timeout further down.
  assert.equal(srv.exitCode, null,
    'server process is still running after a join\n--- stderr ---\n' + stderr.slice(-1500));
  assert.ok(!/ReferenceError|TypeError|is not defined/.test(stderr),
    'no runtime error during join\n--- stderr ---\n' + stderr.slice(-1500));

  // And the join really happened, rather than silently doing nothing.
  const board = JSON.parse((await get(`http://localhost:${PORT}/api/live`)).body);
  const free = board.lobbies.find(l => l.stake === 0);
  assert.ok(free && free.players >= 1, 'the free ladder room has the player in it');
});
