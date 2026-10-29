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

/* ── the review of the fix (night review 2026-10-29) ─────────────────────────────────────────────────────────────
   A resume key (a waiting seat) or a rejoin key (a seat at a table) moves a seat to ANY socket, and the queue
   handlers take a resume before the free seat count is reached, so one address could queue its free seats, hand them
   to a second address by their keys, and queue more. The lobbies now ask index.js (freeMoveOk) before a FREE seat
   changes socket; a paid seat is never asked. Also: the count is linear, a held free seat is told, and the moved
   seat itself is never counted against the socket taking it. */
const { RooftopLobby } = require('../server/RooftopLobby');
const { BattleshipLobby } = require('../server/BattleshipLobby');
const duelQueue = require('../server/duelQueue');

// A socket that keeps what it was sent.
function rsock(xff) { const s = sock(xff); s.sent = []; s.emit = (e, p) => s.sent.push({ e, p }); return s; }
const sentOf = (s, e) => s.sent.filter((m) => m.e === e);

test('a seat being moved is left out of the count of the socket taking it; the count is the same per seat as before', () => {
  const gate = createAddrGate(50);
  const ko = new KnockoutLobby(io), hs = new HeadSoccerLobby(io);
  const lobbies = [ko, hs];
  const A = '198.51.100.80', B = '198.51.100.81';
  const a1 = sock(A), a2 = sock(A), b1 = sock(B), b2 = sock(B);
  for (const s of [a1, a2, b1, b2]) gate.add(s);
  const T0 = Date.now();
  ko.enqueue(a1, 'a1', 'SAME', 0, 0, T0);
  hs.enqueue(a1, 'a1', 'SAME', 0, 0, T0);
  hs.enqueue(b1, 'b1', 'SAME', 0, 0, T0);
  // a2 taking a1's Knockout seat (a reconnect from the same address): that seat is not an extra one.
  assert.strictEqual(freeSeatsAt(gate, a2, lobbies, ko), 2, 'without movingId both seats of a1 count');
  assert.strictEqual(freeSeatsAt(gate, a2, lobbies, ko, a1.id), 1, 'the seat being moved is left out');
  assert.strictEqual(freeSeatsAt(gate, a2, lobbies, hs, a1.id), 1, 'only in the lobby it is moved in');
  // b2 taking a1's seat across addresses: what B holds is b1's seat.
  assert.strictEqual(freeSeatsAt(gate, b2, lobbies, ko, a1.id), 1);
  // The same answer holdsFreeSeat gives, socket by socket and lobby by lobby.
  let byHand = 0;
  for (const s of [a1, a2]) for (const lb of lobbies) if (holdsFreeSeat(lb, s.id)) byHand++;
  const a3 = sock(A); gate.add(a3);
  assert.strictEqual(freeSeatsAt(gate, a3, lobbies, null), byHand);
  ko.stop(); hs.stop();
});

test('a resume asks mayTakeFree only for a free seat changing socket; a refusal leaves the seat where it is', () => {
  for (const Lobby of [KnockoutLobby, HeadSoccerLobby, BattleshipLobby, SwimLobby]) {
    const lob = new Lobby(io);
    const T0 = Date.now();
    const s1 = sock('198.51.100.90');
    lob.enqueue(s1, 'free', 'F1', 0, 0, T0);
    const key = lob.resumeKeyOf(s1.id);
    assert.match(key, /^[0-9a-f]{32}$/);
    const asked = [];
    const no = (id) => { asked.push(id); return false; };
    const s2 = sock('198.51.100.91');
    assert.deepStrictEqual(lob.resume(s2, key, no), { refused: true }, Lobby.name + ': refused');
    assert.deepStrictEqual(asked, [s1.id], 'asked with the id of the socket holding it now');
    assert.strictEqual(lob.queue.find((e) => e.resumeKey === key).socket, s1, 'the seat stays with its socket');
    assert.ok(lob.resume(s1, key, no).resumed, 'the same socket showing its key again is not a move, never asked');
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(lob.resume(s2, key, () => true).resumed.socket, s2, 'allowed: moved as before');
    const s3 = sock('198.51.100.92');
    assert.strictEqual(lob.resume(s3, key).resumed.socket, s3, 'no guard: the old rule');
    // A paid seat always moves: never asked, never refused.
    const p1 = sock('198.51.100.93');
    lob.enqueue(p1, 'paid', 'P1', 0.5, 0.5, T0, 0.5);
    const pkey = lob.resumeKeyOf(p1.id);
    const p2 = sock('198.51.100.94');
    const back = lob.resume(p2, pkey, no);
    assert.ok(back && back.resumed && back.resumed.socket === p2, Lobby.name + ': a paid seat moves');
    assert.strictEqual(asked.length, 1, 'and nobody was asked');
    lob.stop();
  }
});

test('a rejoin asks mayTakeFree only for a seat at a free table; a refusal is a rejoinfail and the seat stays', () => {
  const STEP = 1000 / 60;
  // Rooftop (KnockoutLobby.rejoin): a free bot table.
  {
    const lob = new RooftopLobby(io);
    const a = rsock('198.51.100.100');
    lob.enqueue(a, 'Ann', null, 0, 0, 0);
    let t = duelQueue.FREE_WAIT_MS + 1;
    lob.tick(t);
    const room = lob.roomOf(a.id);
    assert.ok(room && room.bot);
    for (const end = t + 2000; t < end; t += STEP) lob.tick(t);
    const key = sentOf(a, 'rt:seat').pop().p.key;
    const b = rsock('198.51.100.101');
    const asked = [];
    const r = lob.rejoin(b, key, t, (id) => { asked.push(id); return false; });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(asked, [a.id]);
    assert.strictEqual(sentOf(b, 'rt:rejoinfail').length, 1, 'the page is told, and does what a failed reconnect does');
    assert.strictEqual(lob.roomOf(a.id), room, 'the seat stays where it was');
    assert.strictEqual(lob.roomOf(b.id), null);
    assert.ok(lob.rejoin(b, key, t, () => true).ok, 'allowed: the key still works');
    assert.strictEqual(lob.roomOf(b.id), room);
    lob.stop();
  }
  // Rooftop: a paid table always rejoins, never asked.
  {
    const lob = new RooftopLobby(io);
    const a = rsock('198.51.100.102'), b = rsock('198.51.100.103');
    lob.enqueue(a, 'Ann', 'WA', 1, 1, 0, 1);
    lob.enqueue(b, 'Bob', 'WB', 1, 1, 0, 1);
    let t = 0;
    for (const end = 3000; t < end; t += STEP) lob.tick(t);
    const key = sentOf(a, 'rt:seat').pop().p.key;
    let asked = 0;
    const a2 = rsock('198.51.100.104');
    assert.ok(lob.rejoin(a2, key, t, () => { asked++; return false; }).ok, 'a paid seat is never refused here');
    assert.strictEqual(asked, 0);
    lob.stop();
  }
  // Swim (SwimLobby.rejoin): a free race between two people.
  {
    const lob = new SwimLobby(io);
    const a = rsock('198.51.100.105'), b = rsock('198.51.100.106');
    lob.enqueue(a, 'Ann', 'WA', 0, 0, 0);
    lob.enqueue(b, 'Bob', 'WB', 0, 0, 0);
    const room = lob.roomOf(a.id);
    assert.ok(room);
    const key = sentOf(a, 'sw:seat').pop().p.key;
    const c = rsock('198.51.100.107');
    assert.strictEqual(lob.rejoin(c, key, 0, () => false).ok, false);
    assert.strictEqual(sentOf(c, 'sw:rejoinfail').length, 1);
    assert.strictEqual(lob.roomOf(a.id), room);
    assert.ok(lob.rejoin(c, key, 0, () => true).ok);
    assert.strictEqual(lob.roomOf(c.id), room);
    lob.stop();
  }
});

test('a free seat the ceiling holds past its bot time is told, once each countdown, with a fresh one', () => {
  for (const [Lobby, ev, wait] of [[KnockoutLobby, 'ko', BOT_AFTER_MS], [HeadSoccerLobby, 'hs', BOT_AFTER_MS], [SwimLobby, 'sw', FREE_WAIT_MS]]) {
    const lob = new Lobby(io);
    lob.freeRoomCap = 1;
    const T0 = Date.now();
    lob.enqueue(rsock('198.51.100.110'), 'p', 'WP', 0, 0, T0);
    lob.enqueue(rsock('198.51.100.111'), 'q', 'WQ', 0, 0, T0);
    assert.strictEqual(lob.freeRoomsRunning(), 1, ev + ': the one free table is taken');
    const lone = rsock('198.51.100.112');
    lob.enqueue(lone, 'l', 'WL', 0, 0, T0);
    lob.tick(T0 + wait - 1);
    assert.strictEqual(sentOf(lone, ev + ':queued').length, 0, 'nothing before its countdown runs out');
    lob.tick(T0 + wait + 1);
    assert.ok(!lob.roomOf(lone.id), 'held: no bot past the ceiling');
    const notes = sentOf(lone, ev + ':queued');
    assert.strictEqual(notes.length, 1, ev + ': told once');
    const n = notes[0].p;
    assert.strictEqual(n.busy, true);
    assert.strictEqual(n.stake, 0);
    assert.strictEqual(n.resumeKey, lob.resumeKeyOf(lone.id), 'its own key, to its own socket');
    assert.strictEqual(n.waitMs - n.waitingMs, FREE_WAIT_MS, 'the page counts down a fresh wait');
    lob.tick(T0 + wait + 500);
    lob.tick(T0 + wait + FREE_WAIT_MS - 1);
    assert.strictEqual(sentOf(lone, ev + ':queued').length, 1, 'not again while that countdown runs');
    lob.tick(T0 + wait + FREE_WAIT_MS + 2);
    assert.strictEqual(sentOf(lone, ev + ':queued').length, 2, 'again when it runs out');
    lob.stop();
  }
});

/* ── the second review of the fix (night review 2026-10-29) ──────────────────────────────────────────────────────
   Knockout and Battleship took a queue from a socket already seated at a live table: after the bot wait it got a new
   table and its seat (bySocket) moved there, so the old table kept running with the socket in it. freeSeatsAt reads
   roomOf (the newest table), so a stack of them counted as one seat, and leave() only reached the newest, so the rest
   outlived the socket. Both lobbies now take one seat per socket, and Battleship has the free table ceiling too. */
test('a socket seated at a live Knockout or Battleship table cannot queue again; it keeps one table, and leaving ends it', () => {
  for (const [Lobby, q] of [
    [KnockoutLobby, (lob, s, stake, T) => lob.enqueue(s, 'p', 'W' + s.id, stake, stake, T)],
    [BattleshipLobby, (lob, s, stake) => lob.enqueue(s, 'p', 'W' + s.id, stake, stake)],
  ]) {
    const name = Lobby.name;
    const gate = createAddrGate(50);
    const lob = new Lobby(io);
    const refunds = [];
    lob.onRefund = (r) => refunds.push(r);
    const IP = '198.51.100.150';
    const s = sock(IP); gate.add(s);
    let T = Date.now();
    assert.strictEqual(q(lob, s, 0, T), true);
    for (const e of lob.queue) e.since = T;
    lob.tick(T += FREE_WAIT_MS + 1);
    const first = lob.roomOf(s.id);
    assert.ok(first && first.bot && first.state !== 'over', name + ': at a bot table');
    // The repro: queue again and again, each time past the bot wait. Every one is refused and nothing is touched.
    for (let i = 0; i < 6; i++) {
      assert.strictEqual(q(lob, s, 0, T), false, name + ': a free re-queue while seated is not taken');
      assert.strictEqual(q(lob, s, 0.5, T), false, name + ': nor a paid one (the caller refunds its stake row)');
      assert.strictEqual(lob.queue.length, 0, name + ': nothing waits');
      lob.tick(T += FREE_WAIT_MS + 1);
    }
    assert.strictEqual(lob.rooms.size, 1, name + ': one table, not seven');
    assert.strictEqual(lob.roomOf(s.id), first, name + ': the same one');
    assert.strictEqual(refunds.length, 0, name + ': the lobby refunded nothing it never took');
    const asker = sock(IP); gate.add(asker);
    assert.strictEqual(freeSeatsAt(gate, asker, [lob], lob), 1, name + ': counted as the one seat it is');
    // The socket goes: its one table goes with it.
    lob.leave(s.id);
    assert.strictEqual(lob.rooms.size, 0, name + ': nothing left running after the socket is gone');
    // Two people at a table: the same refusal, and the table and its opponent are left alone.
    const a = sock('198.51.100.151'), b = sock('198.51.100.152');
    q(lob, a, 0, T); q(lob, b, 0, T);
    const both = lob.roomOf(a.id);
    assert.ok(both && both.players.has(b.id) && !both.bot, name + ': a and b are at a table');
    assert.strictEqual(q(lob, a, 0, T), false);
    lob.tick(T += FREE_WAIT_MS + 1);
    assert.strictEqual(lob.roomOf(a.id), both);
    assert.strictEqual(lob.roomOf(b.id), both);
    assert.strictEqual(lob.rooms.size, 1);
    // Play again from a table that is over queues as always (the pages also send <ev>:leave first).
    both.state = 'over';
    assert.strictEqual(q(lob, a, 0, T), true, name + ': a table that is over is no seat');
    assert.ok(lob.queue.some((e) => e.socket.id === a.id), name + ': queued');
    lob.stop();
  }
});

test('Battleship takes the free table ceiling: free pairs and bots wait, the held seat is told, paid tables are never held', () => {
  const lob = new BattleshipLobby(io);
  lob.freeRoomCap = 2;
  const T0 = Date.now();
  const seats = [];
  for (let i = 0; i < 6; i++) { const s = rsock('198.51.100.' + (160 + i)); seats.push(s); lob.enqueue(s, 'p' + i, 'B' + i, 0, 0); }
  assert.strictEqual(lob.freeRoomsRunning(), 2, 'three pairs, two tables');
  assert.deepStrictEqual(lob.queue.map((e) => e.socket.id), [seats[4].id, seats[5].id], 'the third pair is still queued');
  for (const e of lob.queue) e.since = T0;
  lob.tick(T0 + FREE_WAIT_MS + 1);
  assert.strictEqual(lob.freeRoomsRunning(), 2, 'no table, bot or pair, past the ceiling');
  assert.strictEqual(lob.queue.length, 2, 'they keep waiting rather than being dropped');
  const note = sentOf(seats[4], 'bs:queued').filter((m) => m.p.busy);
  assert.strictEqual(note.length, 1, 'a held seat is told once');
  assert.strictEqual(note[0].p.waitMs - note[0].p.waitingMs, FREE_WAIT_MS, 'with a fresh countdown');
  assert.strictEqual(note[0].p.resumeKey, lob.resumeKeyOf(seats[4].id));
  lob.tick(T0 + FREE_WAIT_MS + 500);
  assert.strictEqual(sentOf(seats[4], 'bs:queued').filter((m) => m.p.busy).length, 1, 'not again while that countdown runs');
  // Paid seats pair whatever the free tables are doing.
  const pa = rsock('198.51.100.170'), pb = rsock('198.51.100.171');
  lob.enqueue(pa, 'pa', 'PA', 0.5, 0.5);
  lob.enqueue(pb, 'pb', 'PB', 0.5, 0.5);
  assert.ok(lob.roomOf(pa.id) && lob.roomOf(pa.id) === lob.roomOf(pb.id), 'the paid pair is at a table');
  // A free table ends: the waiting pair meets on the next tick.
  lob.roomOf(seats[0].id).state = 'over';
  lob.tick(T0 + FREE_WAIT_MS + 600);
  assert.strictEqual(lob.queue.length, 0);
  const last = lob.roomOf(seats[4].id);
  assert.ok(last && last.players.has(seats[5].id) && !last.bot, 'the waiting pair is at a table together');
  // Without a ceiling (the default) nothing is held: three pairs and a bot table, as before.
  const open = new BattleshipLobby(io);
  for (let i = 0; i < 7; i++) open.enqueue(sock('198.51.100.' + (180 + i)), 'q' + i, 'Q' + i, 0, 0);
  for (const e of open.queue) e.since = T0;
  open.tick(T0 + FREE_WAIT_MS + 1);
  assert.strictEqual(open.freeRoomsRunning(), 4);
  lob.stop(); open.stop();
});
