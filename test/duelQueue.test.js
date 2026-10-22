'use strict';
/* The duel queue (Owen 2026-10-21): Knockout and Battleship.

   THE BUG. Two people who queued for the same game a little apart each played a
   bot. Reproduced with two real clients against the real server (35 s apart): the
   first got a bot after a random 9 to 22 s and was past its first turn, too late
   to be pulled out, when the second arrived; the second then waited alone and got
   a bot of their own. Now a seat waits a full minute (counted down on screen), two
   people inside that minute always meet, and a bot is said to be a bot.

   The lobby layer is driven directly on a synthetic clock; the last tests boot the
   REAL server (scripts/dev-local.js) and use two socket.io clients. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const KO = require('../server/KnockoutLobby');
const BS = require('../server/BattleshipLobby');
const duelQueue = require('../server/duelQueue');

function sock(id) {
  const sent = [];
  return {
    id, sent, rooms: new Set(),
    join(r) { this.rooms.add(r); }, leave(r) { this.rooms.delete(r); },
    emit(e, p) { sent.push({ e, p }); },
    last(e) { for (let i = sent.length - 1; i >= 0; i--) if (sent[i].e === e) return sent[i].p; return null; },
  };
}
const io = { to: () => ({ emit() {} }) };

/* Both lobbies behind one shape. KO's enqueue takes `now` (its clock seam); BS stamps the real clock, so
   its timeline is anchored to Date.now(). */
function lobbies() {
  return [
    { name: 'knockout', lob: new KO.KnockoutLobby(io), T0: 1e9,
      enq(l, s, wallet, stake, worth, now) { return l.enqueue(s, 'P' + s.id, wallet, stake, worth, now); } },
    { name: 'battleship', lob: new BS.BattleshipLobby(io), T0: Date.now(),
      enq(l, s, wallet, stake, worth) { return l.enqueue(s, 'P' + s.id, wallet, stake, worth); } },
  ].map(k => {
    k.refunds = [];
    k.lob.onRefund = (r) => k.refunds.push(r);
    k.lob.onSettled = () => {};
    return k;
  });
}
const humans = (room) => [...room.players.keys()].filter(id => !String(id).startsWith('bot_'));

test('the reported bug: two people 35 s apart meet each other, not a bot each', () => {
  for (const k of lobbies()) {
    const A = sock('A'), B = sock('B');
    k.enq(k.lob, A, 'WA', 0, 0, k.T0);
    for (let t = k.T0; t <= k.T0 + 35000; t += 200) k.lob.tick(t);
    assert.equal(k.lob.roomOf('A'), null, k.name + ': nobody gets a bot inside the minute');
    k.enq(k.lob, B, 'WB', 0, 0, k.T0 + 35000);
    const room = k.lob.roomOf('A');
    assert.ok(room && room === k.lob.roomOf('B'), k.name + ': the two of them, together');
    assert.ok(!room.bot, k.name + ': and no bot');
  }
});

test('two at once are matched at once; one alone plays a bot at 0:00, and the screen is told', () => {
  for (const k of lobbies()) {
    k.enq(k.lob, sock('A'), 'WA', 0, 0, k.T0);
    k.enq(k.lob, sock('B'), 'WB', 0, 0, k.T0);
    assert.ok(k.lob.roomOf('A') && k.lob.roomOf('A') === k.lob.roomOf('B'), k.name);
    const C = sock('C');
    k.enq(k.lob, C, 'WC', 0, 0, k.T0);
    k.lob.tick(k.T0 + 59000);
    assert.equal(k.lob.roomOf('C'), null, k.name + ': still looking at 0:01');
    k.lob.tick(k.T0 + duelQueue.FREE_WAIT_MS + 300);
    const room = k.lob.roomOf('C');
    assert.ok(room && room.bot, k.name + ': a bot after the minute');
    const view = k.name === 'knockout' ? room.publicState() : room.viewFor('C');
    assert.equal(view.vsBot, true, k.name + ': said, not hidden');
  }
});

test('a paid seat never gets a bot: it keeps looking past the minute, and Cancel refunds it once', () => {
  for (const k of lobbies()) {
    const A = sock('A');
    k.enq(k.lob, A, 'WA', 1, 1, k.T0);
    k.lob.tick(k.T0 + duelQueue.PAID_WAIT_MS + 5000);
    assert.equal(k.lob.rooms.size, 0, k.name + ': no bot');
    assert.equal(k.lob.queue.length, 1, k.name + ': still waiting');
    assert.equal(k.refunds.length, 0);
    k.lob.leave('A');
    k.lob.leave('A');
    assert.equal(k.refunds.length, 1, k.name + ': refunded once');
    assert.equal(k.refunds[0].amount, 1);
    assert.equal(k.refunds[0].wallet, 'WA');
  }
});

test('two tabs of one wallet never play each other, and count as one waiting', () => {
  for (const k of lobbies()) {
    k.enq(k.lob, sock('A1'), 'WA', 0, 0, k.T0);
    k.enq(k.lob, sock('A2'), 'WA', 0, 0, k.T0);
    assert.equal(k.lob.rooms.size, 0, k.name + ': not paired with themselves');
    assert.deepEqual(k.lob.waitingByRung(), { 0: 1 }, k.name);
    k.enq(k.lob, sock('B'), 'WB', 0, 0, k.T0);
    assert.equal(k.lob.rooms.size, 1, k.name + ': a different person meets the first tab');
    assert.deepEqual(k.lob.waitingByRung(), { 0: 1 }, k.name + ': the second tab still waits');
  }
});

test('waiting counts are per rung and people only', () => {
  for (const k of lobbies()) {
    k.enq(k.lob, sock('A'), 'WA', 0.5, 0.5, k.T0);
    k.enq(k.lob, sock('B'), 'WB', 1, 1, k.T0);
    k.enq(k.lob, sock('C'), null, 0, 0, k.T0);
    assert.deepEqual(k.lob.waitingByRung(), { 0.5: 1, 1: 1, 0: 1 }, k.name + ': different rungs never meet');
    assert.equal(k.lob.rooms.size, 0);
  }
});

test('a reconnect takes its seat back by its key: same place, minute and stake; a wrong key takes nothing', () => {
  for (const k of lobbies()) {
    const A = sock('A');
    k.enq(k.lob, A, 'WA', 1, 1, k.T0);
    const key = k.lob.resumeKeyOf('A');
    assert.match(key, /^[0-9a-f]{32}$/);
    const since = k.lob.queue[0].since;
    assert.equal(k.lob.resume(sock('X'), 'f'.repeat(32)), null, k.name + ': a guess takes nothing');
    assert.equal(k.lob.resume(sock('X'), { toString: () => key }), null, k.name + ': strings only');
    const A2 = sock('A2');
    const back = k.lob.resume(A2, key);
    assert.ok(back && back.resumed, k.name);
    assert.equal(k.lob.queue.length, 1);
    assert.equal(k.lob.queue[0].socket, A2);
    assert.equal(k.lob.queue[0].since, since, k.name + ': the minute keeps running');
    k.lob.leave('A');                          // the old socket's drop, noticed late
    assert.equal(k.refunds.length, 0, k.name + ': the old socket no longer holds it');
    assert.equal(k.lob.queue.length, 1);
    k.lob.leave('A2');
    assert.equal(k.refunds.length, 1, k.name + ': the new one does');
    // After a refund the key says where the money went, once.
    assert.deepEqual(k.lob.resume(sock('A3'), key), { refunded: true }, k.name);
    assert.equal(k.lob.resume(sock('A4'), key), null);
  }
});

test('a restart owes every paid seat it holds, queued or mid-match, once, and nothing pays twice after', () => {
  for (const k of lobbies()) {
    k.enq(k.lob, sock('Q'), 'WQ', 0.5, 0.5, k.T0);           // waiting
    k.enq(k.lob, sock('A'), 'WA', 1, 1, k.T0);
    k.enq(k.lob, sock('B'), 'WB', 1, 1, k.T0);               // at a table
    k.enq(k.lob, sock('F'), 'WF', 0, 0, k.T0);               // free: owed nothing
    const room = k.lob.roomOf('A');
    assert.ok(room && room.stake === 1);
    const journaled = [];
    k.lob.journal = { close: (acct, outcome, x, where) => journaled.push({ acct, outcome, x, where }) };
    const rows = k.lob.shutdownSettle('shutdown');
    /* The rules db.recordOwedOnce enforces (it throws otherwise, and the exit window would swallow it). */
    for (const r of rows) {
      assert.match(r.key, /^agowed:[0-9a-f-]{36}$/, k.name + ': the shared owed lane\'s key');
      assert.ok(r.reason.startsWith('refund') && r.reason.includes(r.key), k.name + ': ' + r.reason);
    }
    /* And journaled first, as an owed close the boot replay writes once (agJournal OWED_WHYS). */
    assert.equal(journaled.length, rows.length, k.name);
    for (const j of journaled) {
      assert.equal(j.outcome, 'refunded');
      assert.equal(j.x.why, 'shutdown');
      assert.ok(rows.some(r => r.key === j.x.key && r.micro === j.x.refundedMicro && r.wallet === j.acct.wallet));
    }
    const by = Object.fromEntries(rows.map(r => [r.wallet, r]));
    assert.deepEqual(Object.keys(by).sort(), ['WA', 'WB', 'WQ'], k.name);
    assert.equal(by.WQ.micro, 500000);
    assert.equal(by.WA.micro, 1000000);
    assert.equal(new Set(rows.map(r => r.key)).size, rows.length, 'one key per seat');
    assert.ok(k.lob.stopping && room.settled, k.name + ': marked so the exit window cannot pay it');
    k.lob.leave('Q');
    k.lob.leave('A');
    assert.equal(k.refunds.length, 0, k.name + ': no second refund');
    assert.equal(k.enq(k.lob, sock('N'), 'WN', 1, 1, k.T0), false, k.name + ': nothing new is taken');
    assert.equal(k.lob.shutdownSettle('shutdown').length, 0, k.name + ': and a second settle owes nothing');
  }
});

test('a match that cannot start refunds its paid seats once, and the door is not told to refund again', () => {
  for (const k of lobbies()) {
    k.lob.makeMatch = () => { throw new Error('boom'); };
    const A = sock('A'), B = sock('B');
    const errs = console.error; console.error = () => {};
    try {
      assert.equal(k.enq(k.lob, A, 'WA', 1, 1, k.T0), true);
      assert.equal(k.enq(k.lob, B, 'WB', 1, 1, k.T0), true, k.name + ': taken (the lobby refunded it), so the door does not');
    } finally { console.error = errs; }
    assert.equal(k.refunds.length, 2, k.name + ': both seats, once each');
    assert.equal(k.lob.holds('A') || k.lob.holds('B'), false);
    const ev = k.name === 'knockout' ? 'ko:unqueued' : 'bs:unqueued';
    assert.equal(A.last(ev).refunded, true);
    k.lob.leave('A');
    assert.equal(k.refunds.length, 2, 'never twice');
  }
});

test('the real journal replays a crash\'s duel rows through the owed lane, once', async () => {
  const fs = require('fs');
  const os = require('os');
  const { createAgJournal } = require('../server/ag/agJournal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duelq-'));
  const quiet = { log() {}, warn() {}, error() {} };
  const j = createAgJournal({ file: path.join(dir, 'j.log'), log: quiet });
  const lob = new KO.KnockoutLobby(io);
  lob.journal = j;
  lob.enqueue(sock('Q'), 'Owen', 'WQ', 1, 1, 1e9, 0.99);
  const rows = lob.shutdownSettle('crash');
  assert.equal(rows.length, 1);
  j.rotate();
  const written = [];
  await j.replay({ writeOwedOnce: async (row) => { written.push(row); return 'owed'; }, bookFloor() {} });
  assert.equal(written.length, 1);
  assert.equal(written[0].key, rows[0].key);
  assert.equal(written[0].micro, 990000, 'what landed, never the rung');
  assert.equal(written[0].wallet, 'WQ');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('queueing again from a socket waiting on a paid seat gives that stake back first', () => {
  for (const k of lobbies()) {
    const A = sock('A');
    k.enq(k.lob, A, 'WA', 1, 1, k.T0);
    k.enq(k.lob, A, 'WA', 0, 0, k.T0);
    assert.equal(k.refunds.length, 1, k.name + ': the paid seat is refunded, not forgotten');
    assert.equal(k.lob.queue.length, 1);
    assert.equal(k.lob.queue[0].stake, 0);
  }
});

test('a room registered but never started is taken down and its stakes refunded', () => {
  for (const k of lobbies()) {
    const Room = k.name === 'knockout' ? require('../server/KnockoutRoom').KnockoutRoom : require('../server/BattleshipRoom').BattleshipRoom;
    const orig = Room.prototype.start;
    Room.prototype.start = function () { throw new Error('boom'); };
    const errs = console.error; console.error = () => {};
    try {
      k.enq(k.lob, sock('A'), 'WA', 1, 1, k.T0);
      k.enq(k.lob, sock('B'), 'WB', 1, 1, k.T0);
    } finally { Room.prototype.start = orig; console.error = errs; }
    assert.equal(k.lob.rooms.size, 0, k.name + ': nothing left half made');
    assert.equal(k.refunds.length, 2, k.name + ': both stakes back, once each');
  }
});

/* ── the real server, two real clients ───────────────────────────────────── */

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port, srv;
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function live() {
  const r = await fetch(`http://127.0.0.1:${port}/api/live`);
  return r.json();
}
function connect() {
  const { io: ioc } = require('socket.io-client');
  const s = ioc(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000 });
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 8000);
    s.on('connect', () => { clearTimeout(bail); res(s); });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}
const first = (s, ev, ms = 6000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('no ' + ev)), ms);
  s.once(ev, (p) => { clearTimeout(t); resolve(p); });
});

test('the real server: two clients meet, the board counts the one waiting, and a reconnect keeps its seat',
  { timeout: 120000 }, async (t) => {
    port = await freePort();
    srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-local.js')], {
      cwd: ROOT, env: { ...process.env, DEV_LOCAL_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { try { srv.kill(); } catch (_) {} });
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await sleep(500);
      try { up = (await fetch(`http://127.0.0.1:${port}/api/live`)).status === 200; } catch (_) {}
    }
    assert.ok(up, 'server booted');

    for (const [game, q, start, queued] of [['knockout', 'ko:queue', 'ko:start', 'ko:queued'],
                                            ['battleship', 'bs:queue', 'bs:state', 'bs:queued']]) {
      const A = await connect(), B = await connect();
      try {
        const gotQueued = first(A, queued);
        A.emit(q, { name: 'Alice', wallet: 'WalletAlice' });
        const qa = await gotQueued;
        assert.equal(qa.waitMs, 60000, game + ': the minute the screen counts down');
        assert.equal(qa.botAfterMs, 60000);
        assert.match(qa.resumeKey, /^[0-9a-f]{32}$/);
        const row = (await live()).extras.find(e => e.id === game + ':free');
        assert.equal(row.waiting, 1, game + ': Open lobbies counts the person waiting');

        // A reconnect (a new socket) taking the seat back while the old one still looks connected.
        const A2 = await connect();
        try {
          const back = first(A2, queued);
          A2.emit(q, { name: 'Alice', wallet: 'WalletAlice', resume: qa.resumeKey });
          const qb = await back;
          assert.equal(qb.resumeKey, qa.resumeKey, game + ': the same seat');
          A.close();                                   // the old socket goes; the seat stays
          await sleep(300);
          assert.equal((await live()).extras.find(e => e.id === game + ':free').waiting, 1);

          const ma = first(A2, start), mb = first(B, start);
          B.emit(q, { name: 'Bobby', wallet: 'WalletBobby' });
          const [sa, sb] = await Promise.all([ma, mb]);
          if (game === 'knockout') {
            assert.ok(sa.players.some(p => p.name === 'Bobby') && sb.players.some(p => p.name === 'Alice'), 'each other');
            assert.equal(sa.vsBot, false);
          } else {
            assert.equal(sa.them.name, 'Bobby');
            assert.equal(sb.them.name, 'Alice');
            assert.equal(sa.vsBot, false);
          }
          assert.equal((await live()).extras.find(e => e.id === game + ':free').waiting, 0, game + ': nobody waiting now');
        } finally { A2.close(); }
      } finally { A.close(); B.close(); }
    }
  });
