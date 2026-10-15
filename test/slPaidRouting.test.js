'use strict';
// Paid routing through the REAL slSockets (PAID-SL-DESIGN.md 3.1, 11.1 slPaidRouting and the door's C-1 cases; task
// T4; D2-M1: a resumed paid socket must reach its paid room, or it could never cash out).
//   - slBoot.openSl hands back the sockets handle; setPaid attaches the paid directory and door
//   - a paid page joins, plays, drops (parked), comes back on a new socket with sl:back (no token: { paid: 1, stake }),
//     holds Q 3 s, and is paid 90/10 to the TOKEN's wallet; the cashed message reaches the new socket
//   - sl:door:off (the free room's lever) refuses free joins and still seats a paid join (C-1)
//   - maintenance: a paid join is consumed and refunded 'maintenance' once; a free join under maintenance is refused
//     without the socket's auth.entryToken ever being read
//   - a paid socket's calls never reach the free room, and a free socket's never reach a paid room
//   - real socket.io: the handshake auth of a real client routes it to the paid door and seats it
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const W = require('../shared/slWire.js');
const { paidRig, moneySpy, fakeLedger, fakePayout } = require('./slPaidFakes');
const { fakeRL, fakeIoSocket, layerMsgs } = require('./slSockFakes');
const { fakeTimers } = require('./slNetFakes');
const { SlPaidArenas } = require('../server/slPaid/slPaidArenas');
const { createSlPaidDoor } = require('../server/slPaid/slPaidDoor');
const { makeEntryStore } = require('../server/entryStore');
const { isStake } = require('../server/stakeRules');

const FIXTURE_FILE = path.join(__dirname, 'slLawsFixture.js');
const QUIET = { log() {}, warn() {}, error() {} };
const PING = W.encodeInput([{ type: 'ping' }]);

function frames(s) {
  return s.emitted.filter((e) => e.name === 'sl:f').length;
}

function keyOf(s) {
  const m = layerMsgs(s).filter((x) => x.t === 'seat' || x.t === 'back');
  return m.length ? m[m.length - 1].k : null;
}

function refusal(s) {
  const m = layerMsgs(s).find((x) => x.t === 'refused');
  return m || null;
}

// An auth object that records every key anything asks it about (get, own descriptor, in).
function spyAuth(values) {
  const touched = new Set();
  const p = new Proxy(Object.assign({}, values), {
    get(t, k) { touched.add(String(k)); return t[k]; },
    getOwnPropertyDescriptor(t, k) { touched.add(String(k)); return Object.getOwnPropertyDescriptor(t, k); },
    has(t, k) { touched.add(String(k)); return k in t; },
  });
  return { auth: p, touched };
}

test('openSl hands back the sockets handle: join paid, drop, sl:back, hold 3 s, paid 90/10 to the token wallet', () => {
  const ft = fakeTimers(1000);
  const wall = { t: 1.7e12 };
  const opsState = { maintenance: false };
  const slBoot = require('../server/sl/slBoot');
  const off = slBoot.openSl({ env: {}, log: QUIET });
  assert.equal(off.sockets, null, 'off: no handle');
  const opened = slBoot.openSl({
    env: { SL_ENABLED: '1', SL_DEV_LAWS: FIXTURE_FILE }, log: QUIET, autoTick: false, monitor: null, bots: false,
    seed: 3, clock: ft.clock, timers: ft.timers, now: () => wall.t, every: () => ({ stop() {} }),
    helpers: { socketRL: fakeRL(wall), ops: { get: () => opsState } },
  });
  assert.ok(opened.arenas, 'open: ' + opened.why);
  assert.equal(typeof opened.sockets.setPaid, 'function');
  const laws = opened.arenas.laws;
  const P = laws.L7.value;
  const money = moneySpy();
  const paid = new SlPaidArenas(laws, { paid: true, moneyHooks: money.hooks, shippableOnly: false, clock: ft.clock,
    timers: ft.timers, now: () => wall.t, autoTick: false, prey: false, seed: 5, checkEvery: 1, log: QUIET });
  const store = makeEntryStore({ isStake, now: () => wall.t });
  const payout = fakePayout();
  const door = createSlPaidDoor({ arenas: paid, consumeAtStake: (t, s, g) => store.consumeAtStake(t, s, g),
    ledger: fakeLedger(), slPayout: payout, journal: money.journal, ops: { get: () => opsState }, now: () => wall.t,
    log: QUIET });
  assert.equal(opened.sockets.setPaid({ arenas: paid, door }), true);
  assert.equal(opened.sockets.paid(), true);
  assert.throws(() => opened.sockets.setPaid({ arenas: {}, door }), /setPaid needs arenas/);
  assert.throws(() => opened.sockets.setPaid({ arenas: paid, door: {} }), /setPaid needs door.join/);
  const sock = (auth) => {
    const s = fakeIoSocket({ auth });
    opened.sockets.attach(s);
    return s;
  };
  const step = (k) => {
    for (let i = 0; i < (k || 1); i++) {
      ft.advance(P);
      wall.t += P;
      for (const room of paid.rooms()) room.wake();
      opened.arenas.room().wake();
      ft.runImmediates();
    }
  };
  const token = store.mint({ stake: 0.5, worth: 0.5, paid: 0.5, walletAddress: 'WTOKEN', onlyGame: 'slither' });
  const a = sock({ paid: 1, stake: 0.5, entryToken: token, cv: 2 });
  a.fire('sl:join', { nick: 'payme' });
  const room = paid.roomOf(a.id);
  assert.ok(room, 'seated in the paid room');
  assert.equal(opened.arenas.room().seats.size, 0, 'never in the free room');
  assert.deepEqual(layerMsgs(a).filter((m) => m.t === 'room'), [{ t: 'room', stake: 0.5, cut: 10 }]);
  const snakeId = room.seatOf(a.id).snakeId;
  step(5);
  // the drop: no sl:leave, so the seat is parked and its snake glides
  a.disconnected = true;
  a.fire('disconnect', 'transport close');
  assert.equal(room.parked.size, 1);
  step(3);
  // back on a new socket: the paid page's resume sends { paid: 1, stake } and no token
  const b = sock({ paid: 1, stake: 0.5, cv: 2 });
  b.fire('sl:back', { k: keyOf(a), n: frames(a), p: 0 });
  assert.equal(refusal(b), null, 'resumed');
  assert.equal(paid.roomOf(b.id), room, 'routed to the paid room by the seat scan');
  assert.equal(room.seatOf(b.id).snakeId, snakeId, 'the same snake');
  assert.deepEqual(layerMsgs(b).filter((m) => m.t === 'room' || m.t === 'w').map((m) => m.t), ['room', 'w']);
  // hold Q on the new socket until the cash-out
  wall.t += 1000;
  b.fire('sl:hold', { on: 1 });
  let k = 0;
  while (room.sim.snake(snakeId) && k++ < 200) {
    wall.t += 1;
    b.fire('sl:i', PING);
    step();
  }
  assert.equal(room.sim.snake(snakeId), null, 'cashed out');
  const orders = money.of('onCashout');
  assert.equal(orders.length, 1);
  assert.deepEqual([orders[0].wallet, orders[0].grossMicro, orders[0].socketId, orders[0].stake],
    ['WTOKEN', 500000, b.id, 0.5]);
  const cashed = layerMsgs(b).filter((m) => m.t === 'cashed');
  assert.deepEqual(cashed.map((m) => [m.gross, m.cut, m.net, m.cid]), [[500000, 50000, 450000, orders[0].cashoutId]]);
  assert.equal(paid.walletSeat.size, 0);
  assert.deepEqual(payout.refunds, [], 'nothing refunded: it was played');
  opened.arenas.close();
});

test('sl:door:off refuses free joins and still seats a paid join (C-1)', () => {
  const r = paidRig();
  r.arenas.door(false);
  const free = r.sock();
  free.fire('sl:join', { nick: 'f' });
  assert.equal(refusal(free).why, 'closed');
  const s = r.join(r.mint({ walletAddress: 'WP' }));
  assert.equal(refusal(s), null);
  assert.ok(r.paid.roomOf(s.id), 'seated');
  assert.equal(r.store.consumeAtStake('x', 0.5, 'slither').ok, false);
  assert.deepEqual(r.payout.refunds, []);
});

test('maintenance: a paid join is consumed and refunded once; a free join is refused without auth.entryToken read', () => {
  const r = paidRig();
  r.ops.maintenance = true;
  const token = r.mint({ walletAddress: 'WM' });
  const s = r.join(token);
  assert.deepEqual(refusal(s), { t: 'refused', why: 'maintenance', refunded: 500000 });
  assert.deepEqual(r.payout.refunds.map((x) => [x.wallet, x.why, x.micro]), [['WM', 'maintenance', 500000]]);
  assert.equal(r.store.consumeAtStake(token, 0.5, 'slither').ok, false, 'consumed');
  assert.equal(s.disconnected, true);
  // a free socket under maintenance (the helper attached): refused, and only auth.paid and auth.cv were read
  const spy = spyAuth({ cv: 4, entryToken: r.mint({}), stake: 0.5, paid: 0 });
  const f = r.sock({ auth: spy.auth });
  f.fire('sl:join', { nick: 'free' });
  assert.equal(refusal(f).why, 'maintenance');
  assert.deepEqual(Array.from(spy.touched).sort(), ['cv', 'paid']);
  assert.equal(r.payout.refunds.length, 1, 'still one refund');
  // maintenance off: the same kind of free socket is seated free, still reading only paid and cv
  r.ops.maintenance = false;
  const spy2 = spyAuth({ cv: 4, entryToken: r.mint({}), stake: 0.5 });
  const g = r.sock({ auth: spy2.auth });
  g.fire('sl:join', { nick: 'free' });
  assert.ok(r.room().seatOf(g.id), 'a free seat');
  assert.deepEqual(Array.from(spy2.touched).sort(), ['cv', 'paid']);
});

test('a paid socket never reaches the free room, and a free socket never reaches a paid room', () => {
  const r = paidRig();
  const p = r.join(r.mint({}));
  const f = r.sock();
  f.fire('sl:join', { nick: 'free' });
  const proom = r.paid.roomOf(p.id);
  const froom = r.room();
  assert.ok(proom && froom.seatOf(f.id));
  assert.equal(froom.seatOf(p.id), null);
  assert.equal(r.paid.roomOf(f.id), null);
  // hold, vis, chat, diag, input and leave land in their own rooms only
  r.wall.t += 1000;
  p.fire('sl:hold', { on: 1 });
  f.fire('sl:hold', { on: 1 });
  r.step();
  froom.wake();
  assert.equal(proom.holds.holding(proom.seatOf(p.id).snakeId), true);
  assert.equal(froom.holds.holding(froom.seatOf(f.id).snakeId), true);
  const before = proom.stats.chats;
  f.fire('sl:chat', { text: 'hi' });
  assert.equal(proom.stats.chats, before);
  p.fire('sl:leave');
  assert.equal(froom.seatOf(f.id) !== null, true, 'the free seat stays');
  assert.equal(proom.seatOf(p.id), null, 'the paid seat left its own room');
  assert.equal(r.sockets.stats.paidJoins, 1);
});

test('real socket.io: a real client\'s handshake auth reaches the paid door and is seated', { timeout: 30000 }, async () => {
  const http = require('http');
  const { Server } = require('socket.io');
  const { io: ioc } = require('socket.io-client');
  const server = http.createServer();
  const io = new Server(server, { pingInterval: 5000, pingTimeout: 10000 });
  const opened = require('../server/sl/slBoot').openSl({
    env: { SL_ENABLED: '1', SL_DEV_LAWS: FIXTURE_FILE }, io, region: 'na', seed: 3, log: QUIET, bots: false,
    monitor: null, every: () => ({ stop() {} }),
    helpers: { socketRL: () => true, ops: { get: () => ({ maintenance: false }) } },
  });
  assert.ok(opened.arenas, 'open: ' + opened.why);
  const money = moneySpy();
  const paid = new SlPaidArenas(opened.arenas.laws, { paid: true, moneyHooks: money.hooks, shippableOnly: false,
    prey: false, seed: 9, log: QUIET });
  const store = makeEntryStore({ isStake });
  const door = createSlPaidDoor({ arenas: paid, consumeAtStake: (t, s, g) => store.consumeAtStake(t, s, g), ledger: null,
    slPayout: fakePayout(), journal: money.journal, log: QUIET });
  opened.sockets.setPaid({ arenas: paid, door });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const url = 'http://127.0.0.1:' + server.address().port + '/sl';
  const token = store.mint({ stake: 0.5, worth: 0.5, paid: 0.5, walletAddress: 'WIO', onlyGame: 'slither' });
  const c = ioc(url, { transports: ['websocket'], forceNew: true, reconnection: false,
    auth: { paid: 1, stake: 0.5, entryToken: token, cv: 1 } });
  try {
    const got = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('no room message')), 10000);
      c.on('connect', () => c.emit('sl:join', { nick: 'io' }));
      c.on('sl:x', (items) => {
        const m = (items || []).find((x) => x.t === 'room' || x.t === 'refused');
        if (m) {
          clearTimeout(t);
          res(m);
        }
      });
      c.on('connect_error', rej);
    });
    assert.deepEqual(got, { t: 'room', stake: 0.5, cut: 10 });
    assert.equal(paid.humanTotal(), 1);
    assert.equal(opened.arenas.room().seats.size, 0);
    const room = paid.rooms()[0];
    assert.equal(room.money.account(room.seats.values().next().value.snakeId).wallet, 'WIO');
  } finally {
    c.disconnect();
    paid.shutdownSettle('shutdown');
    opened.arenas.close();
    io.close();
    server.close();
  }
});
