'use strict';
// Paid snake: one paid snake per network per room (night review 2026-10-29, finding 5). The one-seat rule is per
// wallet, wallets are cheap, and seatFor sends every join to the fullest room, so one person could seat several funded
// wallets in one room and team them against the strangers in it; the collusion monitor never sees that (the money
// flows from the victims to the team). Through the real slSockets, door, directory, SlRoom and slMoney
// (test/slPaidFakes.js):
//   - two wallets from one address are seated in different rooms of the rung; players on their own addresses still
//     fill the fullest room first, as before
//   - nobody is refused for it while a room is left: the fifth snake from one address on a rung (ROOMS_PER_RUNG rooms,
//     each holding one of theirs) is refused 'full' BEFORE its token is spent, and another address still gets in
//   - an IPv6 /64 is one network; a seat that leaves frees its room for that network again
//   - seatFor and hasSpace with no address are exactly the old routing (owner tools, the watch path, tests)
const test = require('node:test');
const assert = require('node:assert/strict');
const { paidRig } = require('./slPaidFakes');
const { layerMsgs } = require('./slSockFakes');
const { ROOMS_PER_RUNG, SAME_ADDR_PER_ROOM } = require('../server/slPaid/slPaidConst');

function roomOf(r, s) {
  const room = r.paid.roomOf(s.id);
  return room ? room.lobbyType : null;
}

function lastRefusal(s) {
  const l = layerMsgs(s).filter((m) => m.t === 'refused');
  return l.length ? l[l.length - 1] : null;
}

test('two wallets from one address sit in different rooms; their own addresses still fill the fullest room first', () => {
  assert.equal(SAME_ADDR_PER_ROOM, 1);
  const r = paidRig();
  const a = r.join(r.mint({}), { ip: '198.51.100.7' });
  const b = r.join(r.mint({}), { ip: '198.51.100.7' });
  assert.equal(roomOf(r, a), 'sl_na_s0_5');
  assert.equal(roomOf(r, b), 'sl_na_s0_5#1', 'the same address is passed over for another room of the rung');
  // strangers on their own addresses go to the fullest room (#0 and #1 hold one each: the lower index), as before
  const c = r.join(r.mint({}), { ip: '203.0.113.1' });
  const d = r.join(r.mint({}), { ip: '203.0.113.2' });
  assert.equal(roomOf(r, c), 'sl_na_s0_5');
  assert.equal(roomOf(r, d), 'sl_na_s0_5');
  // a third from the teaming address: neither room #0 nor #1, a new room
  const e = r.join(r.mint({}), { ip: '198.51.100.7' });
  assert.equal(roomOf(r, e), 'sl_na_s0_5#2');
  // the other rung is its own: one of theirs there is fine
  const f = r.join(r.mint({ stake: 1, worth: 1, paid: 1 }), { ip: '198.51.100.7', auth: { stake: 1 } });
  assert.equal(roomOf(r, f), 'sl_na_s1');
  // every seat holds its own account, and nothing was refunded
  assert.equal(r.paid.humanTotal(), 6);
  assert.equal(r.ledger.refunds.length + r.payout.refunds.length, 0);
});

test('nobody is refused while a room is left; the fifth from one address is refused full before its token is spent', () => {
  const r = paidRig();
  const mine = [];
  for (let i = 0; i < ROOMS_PER_RUNG; i++) mine.push(r.join(r.mint({}), { ip: '198.51.100.7' }));
  assert.deepEqual(mine.map((s) => roomOf(r, s)), ['sl_na_s0_5', 'sl_na_s0_5#1', 'sl_na_s0_5#2', 'sl_na_s0_5#3']);
  assert.equal(r.paid.hasSpace(0.5, '198.51.100.7'), false);
  assert.equal(r.paid.hasSpace(0.5, '203.0.113.9'), true);
  assert.equal(r.paid.hasSpace(0.5), true, 'no address: the old answer');
  const before = r.consumed.length;
  const token = r.mint({});
  const fifth = r.join(token, { ip: '198.51.100.7' });
  assert.deepEqual(lastRefusal(fifth), { t: 'refused', why: 'full', refunded: 0 });
  assert.equal(fifth.disconnected, true);
  assert.equal(r.consumed.length, before, 'the token was never touched');
  assert.equal(r.store.consumeAtStake(token, 0.5, 'slither').ok, true, 'and is still spendable');
  // another address still gets the fullest room
  const other = r.join(r.mint({}), { ip: '203.0.113.9' });
  assert.equal(roomOf(r, other), 'sl_na_s0_5');
  assert.equal(r.ledger.refunds.length + r.payout.refunds.length, 0, 'nothing refunded anywhere');
});

test('an IPv6 /64 is one network; a seat that leaves frees its room for that network again', () => {
  const r = paidRig();
  const a = r.join(r.mint({}), { ip: '2001:db8:7:7::1' });
  const b = r.join(r.mint({}), { ip: '2001:db8:7:7:abcd::2' });
  const c = r.join(r.mint({}), { ip: '2001:db8:7:8::1' });
  assert.equal(roomOf(r, a), 'sl_na_s0_5');
  assert.equal(roomOf(r, b), 'sl_na_s0_5#1', 'the same /64');
  assert.equal(roomOf(r, c), 'sl_na_s0_5', 'the next /64 is another network');
  // a leaves (its snake glides, then dies): room #0 takes that network again
  a.fire('sl:leave');
  a.disconnect();
  let n = 0;
  while (r.paid.rooms().some((room) => room.orphans.size > 0) && n++ < 400) r.step();
  assert.equal(r.paid.seatFor(0.5, undefined, '2001:db8:7:7::9').lobbyType, 'sl_na_s0_5');
});

test('the door hands seatFor the address slSockets read (behind nginx: the X-Forwarded-For hop from a trusted peer)', () => {
  const r = paidRig();
  const a = r.join(r.mint({}), { ip: '127.0.0.1', headers: { 'x-forwarded-for': '198.51.100.7' } });
  const b = r.join(r.mint({}), { ip: '10.0.0.5', headers: { 'x-forwarded-for': '203.0.113.1, 198.51.100.7' } });
  const c = r.join(r.mint({}), { ip: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.4' } });
  assert.equal(roomOf(r, a), 'sl_na_s0_5');
  assert.equal(roomOf(r, b), 'sl_na_s0_5#1', 'the same client behind the proxy (the last hop)');
  assert.equal(roomOf(r, c), 'sl_na_s0_5', 'another client behind the same proxy');
});
