'use strict';
/* Per-address limits on the main namespace, and the ceiling on free duel tables (night review
   2026-10-29, finding 13). The main namespace had no cap on sockets per address, and a free duel seat
   needs no login, so a few hundred sockets from one machine became a few hundred 60 Hz bot matches on
   the event loop every paid game shares. server/addrLimits.js caps both per address; KnockoutLobby and
   SwimLobby take a ceiling on free tables as a backstop against many addresses. Paid seats are never
   counted, refused or held by any of it. */
const test = require('node:test');
const assert = require('node:assert');
const { addrKey, v6Prefix64, createAddrGate, holdsFreeSeat, freeSeatsAt } = require('../server/addrLimits');
const { KnockoutLobby, BOT_AFTER_MS } = require('../server/KnockoutLobby');
const { HeadSoccerLobby } = require('../server/HeadSoccerLobby');
const { SwimLobby, FREE_WAIT_MS } = require('../server/swim/SwimLobby');

let n = 0;
// A socket as socket.io hands it over: the TCP peer, and the X-Forwarded-For nginx wrote.
function sock(xff, peer) {
  return {
    id: 's' + (++n), join() {}, leave() {}, emit() {}, rooms: new Set(),
    handshake: { address: peer || '127.0.0.1', headers: xff ? { 'x-forwarded-for': xff } : {} },
  };
}
const io = { to: () => ({ emit() {}, volatile: { emit() {} } }) };

test('the address a socket is counted under', () => {
  assert.strictEqual(addrKey(sock('198.51.100.7')), '198.51.100.7', 'nginx\'s last hop');
  assert.strictEqual(addrKey(sock('10.0.0.1, 198.51.100.7')), '198.51.100.7');
  assert.strictEqual(addrKey(sock('6.6.6.6', '198.51.100.9')), '198.51.100.9', 'a public peer is itself, whatever it claims');
  assert.strictEqual(addrKey(sock(null)), null, 'loopback with no header: this box (local tools, tests), never counted');
  assert.strictEqual(addrKey(sock(null, '172.31.4.5')), null, 'the box\'s own network, never counted');
  assert.strictEqual(addrKey(sock('192.168.1.4')), null, 'a private address is never a public client');
  // IPv6 by its /64: one home, one phone, one VPS prefix.
  assert.strictEqual(addrKey(sock('2001:db8:1:2:aaaa::1')), '2001:db8:1:2::/64');
  assert.strictEqual(addrKey(sock('2001:db8:1:2:bbbb:cccc:dddd:eeee')), '2001:db8:1:2::/64');
  assert.strictEqual(v6Prefix64('2001:db8::1'), '2001:db8:0:0::/64');
  assert.strictEqual(v6Prefix64('2001:DB8:0001:0002::'), '2001:db8:1:2::/64');
  assert.strictEqual(v6Prefix64('64:ff9b::192.0.2.33'), '64:ff9b:0:0::/64');
  assert.notStrictEqual(addrKey(sock('2001:db8:1:3::1')), addrKey(sock('2001:db8:1:2::1')));
});

test('the gate admits up to its limit per address, frees a place on remove, and never counts an uncounted socket', () => {
  const gate = createAddrGate(3);
  const a = [sock('198.51.100.1'), sock('198.51.100.1'), sock('198.51.100.1')];
  for (const s of a) { assert.strictEqual(gate.full(s), false); assert.strictEqual(gate.add(s), true); }
  const fourth = sock('198.51.100.1');
  assert.strictEqual(gate.full(fourth), true);
  assert.strictEqual(gate.add(fourth), false);
  assert.strictEqual(gate.add(sock('198.51.100.2')), true, 'another address is its own count');
  assert.strictEqual(gate.add(a[0]), true, 'adding a counted socket again is a no-op');
  assert.strictEqual(gate.count('198.51.100.1'), 3);
  gate.remove(a[0]);
  gate.remove(a[0]);
  assert.strictEqual(gate.count('198.51.100.1'), 2, 'removed once, however often it is called');
  assert.strictEqual(gate.add(fourth), true);
  for (let i = 0; i < 500; i++) assert.strictEqual(gate.add(sock(null)), true, 'local sockets are never refused');
  assert.strictEqual(gate.addresses(), 2);
  for (const s of [a[1], a[2], fourth]) gate.remove(s);
  assert.strictEqual(gate.addresses(), 1, 'an address with no sockets is forgotten');
});

test('free duel seats are counted per address across lobbies; paid seats never are', () => {
  const gate = createAddrGate(50);
  const ko = new KnockoutLobby(io);
  const hs = new HeadSoccerLobby(io);
  const lobbies = [ko, hs];
  const IP = '198.51.100.20';
  const s1 = sock(IP), s2 = sock(IP), s3 = sock(IP), other = sock('198.51.100.21');
  for (const s of [s1, s2, s3, other]) gate.add(s);
  const T0 = Date.now();
  ko.enqueue(s1, 'a', 'W1', 0, 0, T0);
  hs.enqueue(s1, 'a', 'W1', 0, 0, T0);              // one socket queued in two lobbies: two seats
  hs.enqueue(s2, 'b', 'W1', 0, 0, T0);              // same wallet string: never paired with s1
  ko.enqueue(other, 'c', 'W2', 0, 0, T0);           // another address: s1 and other pair in Knockout
  assert.ok(holdsFreeSeat(ko, s1.id) && holdsFreeSeat(ko, other.id), 'a seat at a free table counts');
  assert.strictEqual(freeSeatsAt(gate, s3, lobbies, ko), 3, 's1 at a Knockout table and in the Head Soccer queue, s2 queued');
  assert.strictEqual(freeSeatsAt(gate, s1, lobbies, hs), 2, 'its own Head Soccer seat is left out: queueing there again replaces it');
  assert.strictEqual(freeSeatsAt(gate, other, lobbies, ko), 0);
  assert.strictEqual(freeSeatsAt(gate, sock(null), lobbies, ko), null, 'an uncounted socket is not limited');
  // A paid seat is a real stake, never counted.
  const p = sock(IP); gate.add(p);
  ko.enqueue(p, 'p', 'W9', 0.5, 0.5, T0);
  assert.strictEqual(holdsFreeSeat(ko, p.id), false);
  assert.strictEqual(freeSeatsAt(gate, s3, lobbies, ko), 3);
  ko.stop(); hs.stop();
});

test('a lobby runs at most freeRoomCap free tables; the rest keep waiting, and paid tables are never held', () => {
  const lob = new KnockoutLobby(io, { freeRoomCap: 2 });
  const T0 = Date.now();
  const seats = [];
  for (let i = 0; i < 6; i++) { const s = sock('198.51.100.' + (30 + i)); seats.push(s); lob.enqueue(s, 'p' + i, 'W' + i, 0, 0, T0); }
  // Six free seats are three pairs, but the ceiling is two tables: the third pair waits, both seats queued.
  assert.strictEqual(lob.freeRoomsRunning(), 2);
  assert.deepStrictEqual(lob.queue.map((e) => e.socket.id), [seats[4].id, seats[5].id], 'the third pair is still queued');
  lob.tick(T0 + BOT_AFTER_MS + 1);
  assert.strictEqual(lob.freeRoomsRunning(), 2, 'no table, bot or pair, past the ceiling');
  assert.strictEqual(lob.queue.length, 2, 'they keep waiting rather than being dropped');
  // Paid seats pair whatever the free tables are doing.
  const pa = sock('198.51.100.50'), pb = sock('198.51.100.51');
  lob.enqueue(pa, 'pa', 'PA', 0.5, 0.5, T0);
  lob.enqueue(pb, 'pb', 'PB', 0.5, 0.5, T0);
  assert.ok(lob.roomOf(pa.id) && lob.roomOf(pa.id) === lob.roomOf(pb.id), 'the paid pair is at a table');
  // A free table ends: the waiting pair meets on the next tick (a person beats a bot, as always).
  lob.roomOf(seats[0].id).state = 'over';
  lob.tick(T0 + BOT_AFTER_MS + 2);
  assert.strictEqual(lob.queue.length, 0);
  const last = lob.roomOf(seats[4].id);
  assert.ok(last && last.players.has(seats[5].id) && !last.bot, 'the waiting pair is at a table together');
  // At the ceiling a lone free seat waits for its bot the same way.
  const lone = sock('198.51.100.40');
  lob.enqueue(lone, 'l', 'L', 0, 0, T0);
  lob.tick(T0 + BOT_AFTER_MS + 3);
  assert.ok(!lob.roomOf(lone.id), 'no bot past the ceiling');
  lob.roomOf(seats[2].id).state = 'over';
  lob.tick(T0 + BOT_AFTER_MS + 4);
  assert.ok(lob.roomOf(lone.id) && lob.roomOf(lone.id).bot, 'and gets one when a table ends');
  // Without a ceiling (the default) nothing is held.
  const open = new KnockoutLobby(io);
  for (let i = 0; i < 9; i++) open.enqueue(sock('198.51.100.' + (60 + i)), 'q' + i, 'Q' + i, 0, 0, T0);
  open.tick(T0 + BOT_AFTER_MS + 1);
  assert.strictEqual(open.freeRoomsRunning(), 5, 'four pairs and a bot table, as before');
  lob.stop(); open.stop();
});

test('Swim takes the same ceiling', () => {
  const lob = new SwimLobby(io);
  lob.freeRoomCap = 1;
  const T0 = Date.now();
  const a = sock('198.51.100.70'), b = sock('198.51.100.71'), c = sock('198.51.100.72');
  lob.enqueue(a, 'a', 'A', 0, 0, T0);
  lob.enqueue(b, 'b', 'B', 0, 0, T0);
  lob.enqueue(c, 'c', 'C', 0, 0, T0);
  assert.strictEqual(lob.freeRoomsRunning(), 1);
  lob.tick(T0 + FREE_WAIT_MS + 1);
  assert.strictEqual(lob.freeRoomsRunning(), 1, 'no bot race past the ceiling');
  assert.strictEqual(lob.queue.length, 1);
  lob.stop();
});
