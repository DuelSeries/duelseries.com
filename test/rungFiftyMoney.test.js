'use strict';
/* BACKLOG 2.1 money proof for the games with no proof script of their own: slither.io (the paid snake
   on the old engine), Knockout and Battleship, at the new $0.50 rung. Paper and agar.io have their
   own end-to-end proofs with dev tokens (scratchpad e2e-paid.js, agario-reference agproof.js); dev
   tokens are scoped to those two games, so these three are driven with REAL entry tokens instead.

   The real server/index.js, booted by scripts/dev-local.js in this test's own process (in-memory
   database modelled by scripts/memLedgerDb.js, every outbound call refused except this test's own
   localhost sockets). Only the chain is stubbed: Wallet.submitStake (the broadcast),
   Usdc.verifyUsdcStake (what landed and who paid) and money.withdraw (every payout, recorded here in
   micro-dollars instead of sent). No real money moves.

   For each game: what went in (the stakes that landed) equals what came out (cash-outs, rake and
   refunds), the 90/10 split is exact at $0.50 (450000 + 50000 micro on a fresh seat; a $0.50
   Knockout or Battleship pot of 1.00 pays a 0.90 prize), a stale $0.10 entry is refused and never
   seated, and a $0.10 stake row left by the old process is refunded 0.10 once at boot. */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const realRequest = http.request;
const realGet = http.get;
const C = require('../shared/constants');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let ipSeq = 0;
function call(port, method, url, body) {
  // A fresh forwarded address per call, so the per-address stake limiter never decides a result.
  const ip = '10.9.' + (++ipSeq >> 8) + '.' + (ipSeq & 255);
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const data = body === undefined ? '' : JSON.stringify(body);
    let out = '';
    s.on('connect', () => s.write(`${method} ${url} HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${ip}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(data)}\r\nConnection: close\r\n\r\n${data}`));
    s.on('data', (d) => { out += d; });
    s.on('end', () => {
      const status = Number(out.split(' ')[1]);
      let text = out.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      if (/transfer-encoding: chunked/i.test(out.split('\r\n\r\n')[0])) {
        let rest = text; text = '';
        for (;;) {
          const i = rest.indexOf('\r\n'); const n = parseInt(rest.slice(0, i), 16);
          if (!n) break; text += rest.slice(i + 2, i + 2 + n); rest = rest.slice(i + 2 + n + 2);
        }
      }
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      resolve({ status, json, text });
    });
    s.on('error', reject);
    s.setTimeout(5000, () => s.destroy(new Error('timeout')));
  });
}

const micro = (v) => Math.round(Number(v) * 1e6);
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  return fn();
};

let port, ledgerDb, REVENUE;
let hsLobby = null;    // the real index.js's Head Soccer lobby, caught when it starts (the sudden-death proofs drive its room)
let rtLobby = null;    // the same for Rooftop Snipers (its fifth-fall and time-up proofs drive its room)
let ahLobby = null;    // the same for Air Hockey (its seventh-goal and sudden-death proofs drive its room)
let p8Lobby = null;    // and 8 Ball Pool's (the 8-ball proof sets up its table)
let landed = 0.5;
let payer = 'Payer0';
let sigN = 0;
const deposits = [];   // [wallet, micro] for every stake that landed (the stubbed chain's side)
const sent = [];       // [wallet, micro] for every payout the server made
const tx = (s) => Buffer.from(s).toString('base64');
const wallet = (tag) => ('Rung50' + tag + '1'.repeat(44)).slice(0, 44);
const STALE = wallet('Stale');

test.before(async () => {
  port = await freePort();
  process.env.DEV_LOCAL_PORT = String(port);
  process.env.DEV_LOCAL_SEED_STAKES = JSON.stringify([
    // A $0.10 stake the old process verified (before BACKLOG 2.1) and never seated: its token died
    // with that process. The new boot must owe it back, 0.10, once.
    { sig: 'stale-dime-sig', state: 'pending', wallet_address: STALE, refund_amount: 0.1, label: 'stake 0.1', region: 'na', boot_id: 'boot-before-2.1' },
  ]);
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  const { HeadSoccerLobby } = require(path.join(ROOT, 'server', 'HeadSoccerLobby.js'));
  const hsStart = HeadSoccerLobby.prototype.start;
  HeadSoccerLobby.prototype.start = function () { hsLobby = this; return hsStart.apply(this, arguments); };
  const { RooftopLobby } = require(path.join(ROOT, 'server', 'RooftopLobby.js'));
  const rtStart = RooftopLobby.prototype.start;
  RooftopLobby.prototype.start = function () { rtLobby = this; return rtStart.apply(this, arguments); };
  const { AirHockeyLobby } = require(path.join(ROOT, 'server', 'AirHockeyLobby.js'));
  const ahStart = AirHockeyLobby.prototype.start;
  AirHockeyLobby.prototype.start = function () { ahLobby = this; return ahStart.apply(this, arguments); };
  const { Pool8Lobby } = require(path.join(ROOT, 'server', 'Pool8Lobby.js'));
  const p8Start = Pool8Lobby.prototype.start;
  Pool8Lobby.prototype.start = function () { p8Lobby = this; return p8Start.apply(this, arguments); };
  try {
    ({ ledgerDb } = require(path.join(ROOT, 'scripts', 'dev-local.js')));
  } finally {
    console.log = log; console.warn = warn;
  }
  const blockedRequest = http.request;
  const local = (a) => a && typeof a === 'object' && ['localhost', '127.0.0.1'].includes(a.hostname || a.host) && Number(a.port) === port;
  http.request = function (...a) { return local(a[0]) ? realRequest.apply(http, a) : blockedRequest.apply(http, a); };
  http.get = function (...a) { return local(a[0]) ? realGet.apply(http, a) : blockedRequest.apply(http, a); };
  const Wallet = require(path.join(ROOT, 'server', 'Wallet.js'));
  const Usdc = require(path.join(ROOT, 'server', 'Usdc.js'));
  const money = require(path.join(ROOT, 'server', 'money.js'));
  Wallet.submitStake = async () => 'r50-sig-' + ++sigN;
  Usdc.verifyUsdcStake = async () => { deposits.push([payer, micro(landed)]); return { payer, usdc: landed }; };
  money.withdraw = async (w, amt) => { sent.push([w, micro(amt)]); return 'DEVSIG-' + sent.length; };
  REVENUE = require('fs').readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8').match(/const REVENUE_WALLET = '([^']+)'/)[1];
  for (let i = 0; i < 60; i++) {
    try { const r = await call(port, 'GET', '/api/live'); if (r.status === 200) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up');
});

function connect() {
  const { io } = require('socket.io-client');
  const parser = require('socket.io-parser');
  class Decoder extends parser.Decoder {
    constructor(o) { super(Object.assign({ maxAttachments: 100000 }, typeof o === 'object' ? o : {})); }
  }
  const s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000,
    parser: { ...parser, Decoder } });
  const got = [];
  s.onAny((ev, p) => got.push([ev, p]));
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 8000);
    s.on('connect', () => { clearTimeout(bail); res({ s, got, has: (ev) => got.find((g) => g[0] === ev) }); });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}

async function stake(amount, who) {
  landed = amount;
  payer = who;
  const r = await call(port, 'POST', '/api/submit-stake', { stake: amount, signedTx: tx('t' + Math.random()), walletAddress: who });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.stake, amount);
  return r.json.entryToken;
}
const sentTo = (w) => sent.filter((x) => x[0] === w).map((x) => x[1]);
const depositsBy = (ws) => deposits.filter((d) => ws.includes(d[0])).reduce((n, d) => n + d[1], 0);

test('boot: the old process\'s $0.10 stake row is owed back 0.10 once, to its payer, and never seated', async () => {
  const owed = await until(() => ledgerDb.payouts.find((p) => p.stake_sig === 'stale-dime-sig'));
  assert.ok(owed, 'the boot sweep ran');
  assert.deepStrictEqual([owed.wallet_address, micro(owed.amount_sol)], [STALE, 100000], 'exactly what it stored, not the new rung');
  assert.match(owed.reason, /^refund unspent entry stake 0\.1 \(the server restarted before the join\)$/);
  assert.strictEqual(ledgerDb.stakes.get('stale-dime-sig').state, 'refunded');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(ledgerDb.payouts.filter((p) => p.stake_sig === 'stale-dime-sig').length, 1, 'once');
  // A $0.10 cannot be bought again: refused before the broadcast.
  const before = sigN;
  const r = await call(port, 'POST', '/api/submit-stake', { stake: 0.1, signedTx: tx('stale'), walletAddress: STALE });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(sigN, before, 'nothing was broadcast');
});

test('slither.io at $0.50: 500000 in, a held cash-out pays 450000 to the player and 50000 rake; a $0.10 join is refused', async () => {
  const W = wallet('Snake');
  const tok = await stake(0.5, W);
  const sig = 'r50-sig-' + sigN;
  assert.strictEqual(ledgerDb.stakes.get(sig).refund_amount, 0.5, 'its row refunds at most 0.50');

  // The stale $0.10 page first: refused, not seated, the token untouched.
  const old = await connect();
  old.s.emit('play', { name: 'old', stake: 0.1, entryToken: tok, region: 'na', walletAddress: W, googleId: W });
  const err = await until(() => old.has('error'));
  assert.ok(err && /no longer offered/.test(err[1].message), JSON.stringify(old.got.map((g) => g[0])));
  assert.ok(!old.has('game_joined'));
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'pending');
  old.s.close();

  const c = await connect();
  c.s.emit('play', { name: 'snk', stake: 0.5, entryToken: tok, region: 'na', walletAddress: W, googleId: W });
  assert.ok(await until(() => c.has('game_joined'), 8000), JSON.stringify(c.got.map((g) => g[0])));
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'consumed');
  c.s.emit('cashout:start');
  const res = await until(() => c.has('cashout:result'), C.CASHOUT_HOLD_MS + 4000);
  assert.ok(res, 'cashed out after the hold: ' + JSON.stringify(c.got.map((g) => g[0]).filter((e) => /cash|died/.test(e))));
  assert.deepStrictEqual([micro(res[1].gross), micro(res[1].cut), micro(res[1].earnedSol)], [500000, 50000, 450000]);
  await until(() => sentTo(W).length && sentTo(REVENUE).length);
  assert.deepStrictEqual(sentTo(W), [450000], '90 percent to the player');
  assert.deepStrictEqual(sentTo(REVENUE), [50000], '10 percent to the house');
  assert.strictEqual(depositsBy([W]), 500000);
  assert.strictEqual(depositsBy([W]), sentTo(W)[0] + sentTo(REVENUE)[0], 'deposit = cash-out + rake');
  c.s.close();
});

async function duel(game, pre, extra) {
  const x = extra || {};
  const A = wallet(pre + 'A'), B = wallet(pre + 'B'), Q = wallet(pre + 'Q');
  const revBefore = sentTo(REVENUE).length;
  const tokA = await stake(0.5, A);
  const tokB = await stake(0.5, B);
  const a = await connect(), b = await connect();
  // A stale $0.10 seat is refused, and the $0.50 token it carried is not spent.
  a.s.emit(game + ':queue', Object.assign({ name: 'a', stake: 0.1, entryToken: tokA }, x));
  const no = await until(() => a.has(game + ':refused'));
  assert.ok(no && /no longer offered/.test(no[1].why), game + ' $0.10 refused as a retired buy-in');
  assert.ok(!a.has(game + ':queued'));
  await new Promise((r) => setTimeout(r, 1100));   // the queue's own rate limit
  a.s.emit(game + ':queue', Object.assign({ name: 'a', stake: 0.5, entryToken: tokA }, x));
  /* A is waiting before B arrives. Sent together, the two stake-row claims could settle in either order, and B
     seated first left A matched on the spot with no queued at all (the assert below then failed on a run that had
     nothing wrong with its money). */
  const qa = await until(() => a.has(game + ':queued'));
  assert.ok(qa, JSON.stringify(a.got.map((g) => g[0])));
  assert.deepStrictEqual([qa[1].stake, qa[1].worth], [0.5, 0.5]);
  // B names the rung with float noise inside the token's 1e-9 match. It is queued at the ladder's own
  // 0.5, so it is matched with A (keyed by the client's number, it sat in a bucket of its own).
  b.s.emit(game + ':queue', Object.assign({ name: 'b', stake: 0.5000000005, entryToken: tokB }, x));
  /* With A already waiting, B is matched on the spot and is never sent a queued of its own: being matched with A IS
     the proof it went in at the rung itself, not the number it sent. */
  const started = game === 'ko' ? 'ko:start' : game === 'hs' ? 'hs:start' : game === 'rt' ? 'rt:start' : game === 'ah' ? 'ah:start' : game === 'p8' ? 'p8:start' : game === 'cr' ? 'cr:start' : 'bs:state';
  assert.ok(await until(() => a.has(started) && b.has(started), 8000), 'matched: ' + JSON.stringify(b.got.map((g) => g[0])));
  const st = b.has(started)[1];
  if (st && st.stake !== undefined) assert.strictEqual(st.stake, 0.5, 'a table at the rung itself');
  // A walks out of the match: the table is B's. Pot 1.00, prize 0.90, rake 0.10.
  a.s.emit(game + ':leave');
  await until(() => sentTo(B).length && sentTo(REVENUE).length > revBefore);
  assert.deepStrictEqual(sentTo(B), [900000], 'the winner is paid 90 percent of the 1.00 pot');
  assert.deepStrictEqual(sentTo(REVENUE).slice(revBefore), [100000], 'the house keeps 10 percent');
  assert.deepStrictEqual(sentTo(A), [], 'the loser is paid nothing');

  // A paid seat that backs out of the queue gets its 0.50 back, once.
  const tokQ = await stake(0.5, Q);
  const q = await connect();
  q.s.emit(game + ':queue', Object.assign({ name: 'q', stake: 0.5, entryToken: tokQ }, x));
  assert.ok(await until(() => q.has(game + ':queued')));
  q.s.emit(game + ':unqueue');
  await until(() => sentTo(Q).length);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(sentTo(Q), [500000], 'refunded the whole stake, no rake');

  const inMicro = depositsBy([A, B, Q]);
  const outMicro = sentTo(A).concat(sentTo(B), sentTo(Q), sentTo(REVENUE).slice(revBefore)).reduce((n, m) => n + m, 0);
  assert.strictEqual(inMicro, 1500000);
  assert.strictEqual(outMicro, inMicro, 'deposits = prize + rake + refunds');
  for (const s of [a, b, q]) s.s.close();
}

test('Knockout at $0.50: two 500000 stakes, the winner takes 900000 and the house 100000; a queue refund is 500000', async () => {
  await duel('ko', 'Ko');
});

test('Battleship at $0.50: the same split through its own lobby', async () => {
  await duel('bs', 'Bs');
});

test('Head Soccer at $0.50: the same split through its own lobby (the Knockout queue and room underneath)', async () => {
  await duel('hs', 'Hs');
});

test('8 Ball Pool at $0.50: the same split through its own lobby (the Knockout queue and room underneath)', async () => {
  await duel('p8', 'Pq');
});

/* 8 Ball Pool decided at the table at $0.50: the shooter's 8 in the called pocket, played through on the real server
   from the shot message, pays that seat 90 percent of the pot once the balls stop; the 8 in the wrong pocket pays
   the other seat. Neither pays before the shot has rolled out. */
async function p8Eight(pre, rightPocket) {
  const A = wallet(pre + 'A'), B = wallet(pre + 'B');
  const revBefore = sentTo(REVENUE).length;
  const tokA = await stake(0.5, A);
  const tokB = await stake(0.5, B);
  const a = await connect(), b = await connect();
  await new Promise((r) => setTimeout(r, 1100));   // the queue's own rate limit
  a.s.emit('p8:queue', { name: 'a', stake: 0.5, entryToken: tokA });
  assert.ok(await until(() => a.has('p8:queued')));
  b.s.emit('p8:queue', { name: 'b', stake: 0.5, entryToken: tokB });
  assert.ok(await until(() => a.has('p8:start') && b.has('p8:start'), 8000), 'matched');
  assert.ok(p8Lobby, 'the lobby was caught at boot');
  const room = [...p8Lobby.rooms.values()].find((r) => r.players.has(a.s.id));
  assert.ok(room, 'their room');
  assert.ok(await until(() => room.state === 'aiming', 8000), 'the first turn opened');
  const Sim = require(path.join(ROOT, 'shared', 'pool8Sim.js'));
  const Rules = require(path.join(ROOT, 'shared', 'pool8Rules.js'));
  const { P8 } = Sim;
  // A's turn, A's group cleared, only the 8 and one of B's balls left.
  const sideA = room.players.get(a.s.id).side;
  room.balls = Sim.newRack().map((x) => Object.assign(x, { on: false }));
  Object.assign(room.balls[0], { on: true, x: 600, y: P8.W / 2 });
  Object.assign(room.balls[8], { on: true, x: 900, y: P8.W / 2 });
  Object.assign(room.balls[sideA === 0 ? 9 : 1], { on: true, x: 200, y: P8.W - 60 });
  room.rules = Rules.newState(sideA);
  room.rules.broken = true; room.rules.inHand = null;
  room.rules.groups = sideA === 0 ? ['solids', 'stripes'] : ['stripes', 'solids'];
  room.aimError = () => 0;   // an exact shot for the proof: the server's hair of aim error off
  // The ghost ball that sends the 8 into the bottom right corner.
  const e = room.balls[8], pk = Sim.POCKETS[5];
  const dx = pk.x - e.x, dy = pk.y - e.y, d = Math.hypot(dx, dy);
  const gx = e.x - dx / d * 2 * P8.R, gy = e.y - dy / d * 2 * P8.R;
  const c = room.balls[0];
  a.s.emit('p8:shot', { a: Math.atan2(gy - c.y, gx - c.x), p: 0.9, call: rightPocket ? 5 : 2 });
  assert.ok(await until(() => a.has('p8:shot') && b.has('p8:shot'), 4000), 'both screens get the tape');
  const shot = a.has('p8:shot')[1];
  assert.ok(shot.over, 'the shot decided it: ' + JSON.stringify({ foul: shot.foul, pots: shot.pots }));
  assert.deepStrictEqual(sentTo(A).concat(sentTo(B)), [], 'nothing paid while the balls roll');
  const winner = rightPocket ? A : B, loser = rightPocket ? B : A;
  await until(() => sentTo(winner).length && sentTo(REVENUE).length > revBefore, shot.tape.dur + 9000);
  assert.deepStrictEqual(sentTo(winner), [900000], 'the winner is paid 90 percent of the 1.00 pot');
  assert.deepStrictEqual(sentTo(REVENUE).slice(revBefore), [100000], 'the house keeps 10 percent');
  assert.deepStrictEqual(sentTo(loser), [], 'the other seat is paid nothing');
  assert.strictEqual(depositsBy([A, B]), 1000000);
  for (const x of [a, b]) x.s.close();
}

test('8 Ball Pool at $0.50: the 8 in the called pocket pays its shooter 900000 and the house 100000', async () => {
  await p8Eight('PoolWin', true);
});

test('8 Ball Pool at $0.50: the 8 in a pocket that was not called pays the other seat', async () => {
  await p8Eight('PoolLoss', false);
});

/* Head Soccer's sudden death at $0.50 (Owen 2026-10-27): level at 0:00 is one minute of golden goal. A goal in it
   pays the scorer like any win; still level after the minute is a draw, each seat refunded its whole stake. */
async function hsSuddenDeath(pre, ending) {
  const A = wallet(pre + 'A'), B = wallet(pre + 'B');
  const revBefore = sentTo(REVENUE).length;
  const tokA = await stake(0.5, A);
  const tokB = await stake(0.5, B);
  const a = await connect(), b = await connect();
  await new Promise((r) => setTimeout(r, 1100));   // the queue's own rate limit
  a.s.emit('hs:queue', { name: 'a', stake: 0.5, entryToken: tokA });
  assert.ok(await until(() => a.has('hs:queued')));
  b.s.emit('hs:queue', { name: 'b', stake: 0.5, entryToken: tokB });
  assert.ok(await until(() => a.has('hs:start') && b.has('hs:start'), 8000), 'matched');
  assert.ok(hsLobby, 'the lobby was caught at boot');
  const room = [...hsLobby.rooms.values()].find((r) => r.players.has(a.s.id));
  assert.ok(room, 'their room');
  const { HS } = require(path.join(ROOT, 'shared', 'hsSim.js'));
  assert.ok(await until(() => room.state === 'playing', 6000), 'kicked off');
  // Level with a moment left: the whistle at 0:00 calls golden goal, nothing settles.
  room.match.score = [1, 1];
  room.match.msLeft = 30;
  assert.ok(await until(() => room.state === 'golden', 3000), 'golden goal called: ' + room.state);
  assert.ok(await until(() => a.has('hs:golden') && b.has('hs:golden'), 2000), 'both screens told');
  assert.ok(await until(() => room.state === 'playing', HS.GOLDEN_FLASH_MS + HS.COUNTDOWN_MS + 2000), 'golden kick-off');
  assert.deepStrictEqual(sentTo(A).concat(sentTo(B)), [], 'nothing paid while level');
  const sideA = room.players.get(a.s.id).side;
  if (ending === 'goal') {
    // The ball into the goal that scores for A's side: past the left line scores for the right seat, and back.
    const b0 = room.match.ball, dir = sideA === 0 ? 1 : -1;
    b0.x = dir * (HS.GOAL_LINE_X + 30); b0.y = HS.SHELF_Y - HS.BALL_R - 5; b0.vx = dir * 40; b0.vy = 0;
    await until(() => sentTo(A).length && sentTo(REVENUE).length > revBefore, HS.GOAL_PAUSE_MS + 8000);
    assert.deepStrictEqual(sentTo(A), [900000], 'the golden goal pays its scorer 90 percent of the 1.00 pot');
    assert.deepStrictEqual(sentTo(REVENUE).slice(revBefore), [100000], 'the house keeps 10 percent');
    assert.deepStrictEqual(sentTo(B), [], 'the other seat is paid nothing');
  } else {
    // Nobody scores in the minute: run its clock to the end (the room's own steps keep counting it).
    room.match.ball.x = 0; room.match.ball.y = 300; room.match.ball.vx = 0; room.match.ball.vy = 0;
    room.match.goldenMs = HS.GOLDEN_MAX_MS - 50;
    await until(() => sentTo(A).length && sentTo(B).length, 8000);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(sentTo(A), [500000], 'a draw hands A its whole stake back');
    assert.deepStrictEqual(sentTo(B), [500000], 'and B its own');
    assert.deepStrictEqual(sentTo(REVENUE).slice(revBefore), [], 'no rake on a draw');
  }
  assert.strictEqual(depositsBy([A, B]), 1000000);
  for (const s of [a, b]) s.s.close();
}

test('Head Soccer at $0.50: a golden goal after 0:00 pays its scorer 900000 and the house 100000', async () => {
  await hsSuddenDeath('HsGold', 'goal');
});

test('Head Soccer at $0.50: still level after the golden minute is a draw, each seat refunded 500000', async () => {
  await hsSuddenDeath('HsDraw', 'draw');
});

test('Rooftop Snipers at $0.50: the same split through its own lobby (the Knockout queue and room underneath)', async () => {
  await duel('rt', 'Rt');
});

/* Rooftop Snipers at $0.50 through the real server: the fifth fall pays its side once the hold is over; a paid table's
   ten minutes running out level is a draw, each seat refunded its whole stake (shared/rtSim.js, server/RooftopRoom.js). */
async function rtEnding(pre, ending) {
  const A = wallet(pre + 'A'), B = wallet(pre + 'B');
  const revBefore = sentTo(REVENUE).length;
  const tokA = await stake(0.5, A);
  const tokB = await stake(0.5, B);
  const a = await connect(), b = await connect();
  await new Promise((r) => setTimeout(r, 1100));   // the queue's own rate limit
  a.s.emit('rt:queue', { name: 'a', stake: 0.5, entryToken: tokA });
  assert.ok(await until(() => a.has('rt:queued')));
  b.s.emit('rt:queue', { name: 'b', stake: 0.5, entryToken: tokB });
  assert.ok(await until(() => a.has('rt:start') && b.has('rt:start'), 8000), 'matched');
  assert.ok(rtLobby, 'the lobby was caught at boot');
  const room = [...rtLobby.rooms.values()].find((r) => r.players.has(a.s.id));
  assert.ok(room, 'their room');
  // Both ready up (a jump press each), and the first round starts.
  a.s.emit('rt:in', { s: 1, j: 1, d: 0, r: 0, n: 0 });
  b.s.emit('rt:in', { s: 1, j: 1, d: 0, r: 0, n: 0 });
  assert.ok(await until(() => room.state === 'playing', 6000), 'started: ' + room.state);
  const sideA = room.players.get(a.s.id).side;
  if (ending === 'fifth') {
    // A's side one point from five, and the other player carried over the death line: the fall decides it.
    const sc = [0, 0]; sc[sideA] = 4; room.match.score = sc;
    const other = room.match.p[1 - sideA].body;
    other.x = (sideA === 0 ? 1 : -1) * 700; other.y = 80; other.vy = 50;
    assert.ok(await until(() => room.state === 'settling', 2000), 'decided at the fall');
    assert.deepStrictEqual(sentTo(A).concat(sentTo(B)), [], 'nothing paid until the hold is over');
    await until(() => sentTo(A).length && sentTo(REVENUE).length > revBefore, 20000);
    assert.deepStrictEqual(sentTo(A), [900000], 'the fifth fall pays its side 90 percent of the 1.00 pot');
    assert.deepStrictEqual(sentTo(REVENUE).slice(revBefore), [100000], 'the house keeps 10 percent');
    assert.deepStrictEqual(sentTo(B), [], 'the other seat is paid nothing');
  } else {
    // Level when the ten minutes run out (the room's own clock, moved back): each seat gets its own stake back.
    room.match.score = [2, 2];
    room.playSince -= 10 * 60 * 1000;
    await until(() => sentTo(A).length && sentTo(B).length, 10000);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(sentTo(A), [500000], 'a draw hands A its whole stake back');
    assert.deepStrictEqual(sentTo(B), [500000], 'and B its own');
    assert.deepStrictEqual(sentTo(REVENUE).slice(revBefore), [], 'no rake on a draw');
  }
  assert.strictEqual(depositsBy([A, B]), 1000000);
  for (const s of [a, b]) s.s.close();
}

test('Rooftop Snipers at $0.50: the fifth fall pays its side 900000 and the house 100000', async () => {
  await rtEnding('RtFive', 'fifth');
});

test('Rooftop Snipers at $0.50: level when the ten minutes run out is a draw, each seat refunded 500000', async () => {
  await rtEnding('RtTime', 'time');
});

test('Air Hockey at $0.50: the same split through its own lobby (the Knockout queue and room underneath)', async () => {
  await duel('ah', 'Ah');
});

/* Air Hockey at $0.50 on the real server: the seventh goal pays its scorer like any win, and a match still level after
   the minute of sudden death is a draw, each seat refunded its whole stake (docs/airhockey-design.md). */
async function ahMoney(pre, ending) {
  const A = wallet(pre + 'A'), B = wallet(pre + 'B');
  const revBefore = sentTo(REVENUE).length;
  const tokA = await stake(0.5, A);
  const tokB = await stake(0.5, B);
  const a = await connect(), b = await connect();
  await new Promise((r) => setTimeout(r, 1100));   // the queue's own rate limit
  a.s.emit('ah:queue', { name: 'a', stake: 0.5, entryToken: tokA });
  assert.ok(await until(() => a.has('ah:queued')));
  b.s.emit('ah:queue', { name: 'b', stake: 0.5, entryToken: tokB });
  assert.ok(await until(() => a.has('ah:start') && b.has('ah:start'), 8000), 'matched');
  assert.ok(ahLobby, 'the lobby was caught at boot');
  const room = [...ahLobby.rooms.values()].find((r) => r.players.has(a.s.id));
  assert.ok(room, 'their room');
  assert.strictEqual(room.pot(), 1, 'a 1.00 pot from two server-recorded 0.50 stakes');
  const { AH } = require(path.join(ROOT, 'shared', 'ahSim.js'));
  assert.ok(await until(() => room.state === 'playing', 6000), 'served');
  const sideA = room.players.get(a.s.id).side;
  if (ending === 'goal') {
    // A on six; the puck heading into the goal A scores in, both mallets out of its way.
    room.score[sideA] = AH.TO_WIN - 1;
    room.inputs = [{ x: 60, y: AH.H - 60 }, { x: 540, y: 60 }];
    room.match.m[0].x = 60; room.match.m[0].y = AH.H - 60; room.match.m[1].x = 540; room.match.m[1].y = 60;
    const p = room.match.puck;
    p.live = true; p.x = AH.W / 2; p.y = sideA === 0 ? 40 : AH.H - 40; p.vx = 0; p.vy = sideA === 0 ? -1500 : 1500;
    await until(() => sentTo(A).length && sentTo(REVENUE).length > revBefore, 8000);
    assert.deepStrictEqual(sentTo(A), [900000], 'the seventh goal pays its scorer 90 percent of the 1.00 pot');
    assert.deepStrictEqual(sentTo(REVENUE).slice(revBefore), [100000], 'the house keeps 10 percent');
    assert.deepStrictEqual(sentTo(B), [], 'the other seat is paid nothing');
  } else {
    // Level in sudden death with a moment left and nothing moving: the buzzer makes it a draw.
    room.score[0] = 2; room.score[1] = 2;
    room.msLeft = 0; room.sudden = true; room.suddenMs = AH.SUDDEN_MS - 50;
    room.match.puck.live = false;
    await until(() => sentTo(A).length && sentTo(B).length, 8000);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepStrictEqual(sentTo(A), [500000], 'a draw hands A its whole stake back');
    assert.deepStrictEqual(sentTo(B), [500000], 'and B its own');
    assert.deepStrictEqual(sentTo(REVENUE).slice(revBefore), [], 'no rake on a draw');
  }
  assert.strictEqual(depositsBy([A, B]), 1000000);
  for (const s of [a, b]) s.s.close();
}

test('Air Hockey at $0.50: the seventh goal pays its scorer 900000 and the house 100000', async () => {
  await ahMoney('AhSeven', 'goal');
});

test('Air Hockey at $0.50: still level after the sudden-death minute is a draw, each seat refunded 500000', async () => {
  await ahMoney('AhDraw', 'draw');
});

test('Crossy Road at $0.50: the same split through its own lobby (the Knockout queue and room underneath)', async () => {
  await duel('cr', 'Cr', { v: require(path.join(ROOT, 'shared', 'crossySim.js')).VERSION });
});

/* Crossy Road at $0.50, decided by the game itself on the real server. Nobody hops, so the eagle takes both on the
   same tick (its 5 s): a draw, each seat refunded its whole stake. Or A hops forward twice (two seconds of eagle
   bought back) and B stands still: B is taken first and A is paid. */
async function crossyEnding(pre, ending) {
  const S = require(path.join(ROOT, 'shared', 'crossySim.js'));
  const A = wallet(pre + 'A'), B = wallet(pre + 'B');
  const revBefore = sentTo(REVENUE).length;
  const tokA = await stake(0.5, A);
  const tokB = await stake(0.5, B);
  const a = await connect(), b = await connect();
  await new Promise((r) => setTimeout(r, 1100));   // the queue's own rate limit
  a.s.emit('cr:queue', { name: 'a', stake: 0.5, entryToken: tokA, v: S.VERSION });
  assert.ok(await until(() => a.has('cr:queued')));
  b.s.emit('cr:queue', { name: 'b', stake: 0.5, entryToken: tokB, v: S.VERSION });
  assert.ok(await until(() => a.has('cr:start') && b.has('cr:start'), 8000), 'matched');
  const st = a.has('cr:start')[1];
  assert.strictEqual(st.stake, 0.5);
  const tickNow = () => Math.floor((Date.now() - st.goAt) / S.TICK_MS);
  assert.ok(await until(() => tickNow() > 2, 6000), 'go');
  // Both pages say how far their timelines have got, the way the page does; A hops forward twice early on.
  let hops = ending === 'win' ? [30, 45] : [];
  const beat = setInterval(() => {
    const t = tickNow();
    const due = hops.filter((k) => k <= t + 3);
    hops = hops.filter((k) => k > t + 3);
    a.s.emit('cr:in', { t: t + 3, h: due.map((k) => [Math.max(k, t + 1), S.IN.FWD]) });
    b.s.emit('cr:in', { t: t + 3 });
  }, 50);
  try {
    if (ending === 'draw') {
      await until(() => sentTo(A).length && sentTo(B).length, 12000);
      await new Promise((r) => setTimeout(r, 300));
      assert.deepStrictEqual(sentTo(A), [500000], 'both taken on the same tick: A has its whole stake back');
      assert.deepStrictEqual(sentTo(B), [500000], 'and B its own');
      assert.deepStrictEqual(sentTo(REVENUE).slice(revBefore), [], 'no rake on a draw');
      assert.ok(await until(() => a.has('cr:over')), 'the result reached the screen');
      assert.strictEqual(a.has('cr:over')[1].why, 'both out');
    } else {
      await until(() => sentTo(A).length && sentTo(REVENUE).length > revBefore, 12000);
      assert.deepStrictEqual(sentTo(A), [900000], 'the one the eagle took second is paid 90 percent of the 1.00 pot');
      assert.deepStrictEqual(sentTo(REVENUE).slice(revBefore), [100000], 'the house keeps 10 percent');
      assert.deepStrictEqual(sentTo(B), [], 'the one taken first is paid nothing');
      assert.ok(await until(() => a.has('cr:over')), 'the result reached the screen');
      assert.strictEqual(a.has('cr:over')[1].why, 'taken by the eagle');
    }
  } finally { clearInterval(beat); }
  assert.strictEqual(depositsBy([A, B]), 1000000);
  for (const s of [a, b]) s.s.close();
}

test('Crossy Road at $0.50: both taken by the eagle on the same tick is a draw, each seat refunded 500000', async () => {
  await crossyEnding('CrDraw', 'draw');
});

test('Crossy Road at $0.50: the one taken first loses; the other is paid 900000 and the house 100000', async () => {
  await crossyEnding('CrWin', 'win');
});

test('every payout this run is accounted for: nothing paid that did not land', () => {
  const inMicro = deposits.reduce((n, d) => n + d[1], 0);
  const outMicro = sent.reduce((n, s) => n + s[1], 0);
  assert.strictEqual(outMicro, inMicro, JSON.stringify({ deposits, sent }));
  // 100000 appears only as the house's 10 percent of a 1.00 duel pot, never as a player's stake back.
  assert.ok(sent.every((s) => s[1] !== 100000 || s[0] === REVENUE), 'no player was paid or refunded the retired $0.10');
});
