'use strict';
/* STATUS "BEFORE PAPER_PAID IS SWITCHED ON" item 5 (night queue item 5, the money-safety part):
   Knockout and Battleship refunds paid the RUNG. The stake verifier accepts a payment up to 1
   percent under the rung (the entry token carries what landed as `paid`), so a player who paid
   $0.99 for the $1 table and was refunded (queue timeout, backing out, a draw) got $1 back: a
   cent minted out of escrow per refund, a dollar at the $100 rung. Refunds are now bounded by
   what landed, as Paper's already were. And a paid seat's money goes to the wallet that paid
   (from the token), never to a wallet the client names. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { KnockoutLobby, PAID_WAIT_MS: KO_WAIT } = require('../server/KnockoutLobby');
const { BattleshipLobby, PAID_WAIT_MS: BS_WAIT } = require('../server/BattleshipLobby');
const { refundBound } = require('../server/stakeRules');

const io = { to: () => ({ emit: () => {} }) };
function sock(id) { const sent = []; return { id, sent, join() {}, emit(e, p) { sent.push({ e, p }); } }; }

function lobbies() {
  const out = [];
  for (const [Lobby, wait, enq] of [
    [KnockoutLobby, KO_WAIT, (lob, s, wallet, stake, worth, paid, now) => lob.enqueue(s, 'P' + s.id, wallet, stake, worth, now, paid)],
    [BattleshipLobby, BS_WAIT, (lob, s, wallet, stake, worth, paid) => lob.enqueue(s, 'P' + s.id, wallet, stake, worth, paid)],
  ]) {
    const lob = new Lobby(io);
    const settled = [], refunds = [];
    lob.onSettled = (m) => settled.push(m);
    lob.onRefund = (m) => refunds.push(m);
    out.push({ name: Lobby.name, lob, wait, settled, refunds, enq: (...a) => enq(lob, ...a) });
  }
  return out;
}

test('refundBound: the stake, never more than what landed; unknown paid keeps the stake', () => {
  assert.strictEqual(refundBound(1, 0.99), 0.99);
  assert.strictEqual(refundBound(1, 1), 1);
  assert.strictEqual(refundBound(1, 1.5), 1, 'an overpay stays in escrow, as on entry');
  assert.strictEqual(refundBound(0.1, undefined), 0.1);
  assert.strictEqual(refundBound(0.1, NaN), 0.1);
  assert.strictEqual(refundBound(0.1, -5), 0.1);
  assert.strictEqual(refundBound(0, 0.99), 0);
});

test('a queue refund (backing out, or nobody came) pays what landed, not the rung', () => {
  for (const exit of ['leave', 'timeout']) {
    for (const k of lobbies()) {
      const T0 = Date.now();
      k.enq(sock('A'), 'W1', 1, 1, 0.99, T0);
      if (exit === 'leave') k.lob.leave('A');
      else k.lob.tick(T0 + k.wait + 1000);
      assert.strictEqual(k.refunds.length, 1, k.name + ' ' + exit);
      assert.strictEqual(k.refunds[0].amount, 0.99, k.name + ' ' + exit + ': what landed, never the $1 rung');
    }
  }
});

test('a draw refunds each seat what it paid in, bounded by what landed', () => {
  for (const k of lobbies()) {
    k.enq(sock('A'), 'W1', 1, 1, 0.99);
    k.enq(sock('B'), 'W2', 1, 1, 1);
    const room = k.lob.roomOf('A');
    assert.ok(room, k.name + ' matched');
    room.finish(null, 'nobody won');
    assert.strictEqual(k.settled.length, 1);
    const by = Object.fromEntries(k.settled[0].seats.map(s => [s.wallet, s]));
    assert.strictEqual(by.W1.refund, 0.99, k.name + ': the short payer gets back what landed');
    assert.strictEqual(by.W2.refund, 1);
    assert.strictEqual(by.W1.worth, 1, 'the pot is still counted in rungs');
  }
});

test('index.js pays a draw the bounded refund, passes paid in, and pays a paid seat to the token wallet', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
  assert.ok(src.includes("koSend(s.wallet, s.refund, s.name, 'knockout refund ("));
  assert.ok(src.includes("koSend(s.wallet, s.refund, s.name, 'battleship refund ("));
  assert.ok(!/koSend\(s\.wallet, s\.worth,/.test(src), 'no refund pays the rung');
  // A free seat's label wallet is the client's, so it is taken only as a string (hostileInput.test.js).
  assert.ok(src.includes('worth > 0 ? payTo : (strOr(wallet, null) || socket._walletAddress || null), rung, worth, undefined, paid);'));
  assert.ok(src.includes('worth > 0 ? payTo : (strOr(wallet, null) || socket._walletAddress || null), rung, worth, paid);'));
});
