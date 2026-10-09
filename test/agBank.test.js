'use strict';
// AgBank (PAID-AGAR-DESIGN.md 3.2, checklist step 3): share-at-eat transfers with the last-cell remainder, every
// refusal, the NaN-proof ceiling, and PaperBank left untouched underneath.
const test = require('node:test');
const assert = require('node:assert');
const { AgBank } = require('../server/ag/agBank');
const PaperBank = require('../server/paper/PaperBank');

function bank() {
  const breaches = [];
  const transfers = [];
  const b = new AgBank({ onBreach: (x) => breaches.push(x), onTransfer: (t) => transfers.push(t) });
  return { b, breaches, transfers };
}

test('AgBank is a PaperBank, and PaperBank itself has no share move', () => {
  const { b } = bank();
  assert.ok(b instanceof PaperBank);
  assert.strictEqual(typeof PaperBank.prototype.transferShare, 'undefined', 'PaperBank stays untouched');
});

test('a share moves floor(balance x eatenSq / victimSq), and the books close', () => {
  const { b, transfers, breaches } = bank();
  b.deposit(1, 100000, 'A', 'a');
  b.deposit(2, 100000, 'B', 'b');
  // victim 1 has cells of size 30 and 40: sq 900 + 1600 = 2500; the 30 is eaten
  const moved = b.transferShare(1, 2, 900, 2500, false, 'life-1');
  assert.strictEqual(moved, Math.floor((100000 * 900) / 2500));
  assert.strictEqual(moved, 36000);
  assert.strictEqual(b.balance(1), 64000);
  assert.strictEqual(b.balance(2), 136000);
  assert.ok(b.isOpen(1), 'not the last cell: the victim stays open');
  assert.deepStrictEqual(transfers, [{ srcWallet: 'A', dstWallet: 'B', micro: 36000, victimLife: 'life-1', kind: 'eat' }]);
  assert.strictEqual(b.assertConserved(), true);
  assert.deepStrictEqual(breaches, []);
});

test('floor rounding never strands a micro: the last cell moves the exact remainder and closes the account', () => {
  const { b } = bank();
  b.deposit(1, 100001, 'A', 'a');
  b.deposit(2, 5, 'B', 'b');
  const m1 = b.transferShare(1, 2, 1, 3, false);   // floor(100001 / 3) = 33333
  assert.strictEqual(m1, 33333);
  const m2 = b.transferShare(1, 2, 1, 2, false);   // floor(66668 / 2) = 33334
  assert.strictEqual(m2, 33334);
  const rest = b.balance(1);
  const m3 = b.transferShare(1, 2, 7, 7, true);
  assert.strictEqual(m3, rest, 'the last cell takes all that is left');
  assert.strictEqual(m1 + m2 + m3, 100001);
  assert.strictEqual(b.isOpen(1), false, 'the victim account is closed');
  assert.strictEqual(b.balance(2), 100006);
  assert.strictEqual(b.assertConserved(), true);
});

test('a last cell with sizes that would be refused still moves the whole balance (sizes are not read)', () => {
  const { b, breaches } = bank();
  b.deposit(1, 777, 'A');
  b.deposit(2, 1, 'B');
  assert.strictEqual(b.transferShare(1, 2, NaN, NaN, true), 777);
  assert.deepStrictEqual(breaches, []);
});

test('refusals: not open, self, NaN, Infinity, 0, negative and eatenSq > victimSq move nothing and breach once', () => {
  const cases = [
    (b) => b.transferShare(1, 9, 1, 2, false),        // to not open
    (b) => b.transferShare(9, 1, 1, 2, false),        // from not open
    (b) => b.transferShare(1, 1, 1, 2, false),        // self
    (b) => b.transferShare(1, 2, NaN, 2, false),
    (b) => b.transferShare(1, 2, 1, NaN, false),
    (b) => b.transferShare(1, 2, Infinity, Infinity, false),
    (b) => b.transferShare(1, 2, 0, 2, false),
    (b) => b.transferShare(1, 2, -1, 2, false),
    (b) => b.transferShare(1, 2, 3, 2, false),
    (b) => b.transferShare(1, 2, '1', 2, false),
  ];
  for (const run of cases) {
    const { b, breaches, transfers } = bank();
    b.deposit(1, 1000, 'A');
    b.deposit(2, 1000, 'B');
    assert.strictEqual(run(b), -1, run.toString());
    assert.strictEqual(b.balance(1), 1000);
    assert.strictEqual(b.balance(2), 1000);
    assert.strictEqual(breaches.length, 1, 'one breach: ' + run.toString());
    assert.deepStrictEqual(transfers, []);
    // a second refusal in the same room is not reported again
    assert.strictEqual(b.transferShare(1, 1, 1, 2, false), -1);
    assert.strictEqual(breaches.length, 1);
    assert.strictEqual(b.assertConserved(), true);
  }
});

test('a corrupt balance (not a safe integer) is refused, never moved', () => {
  const { b, breaches } = bank();
  b.deposit(1, 1000, 'A');
  b.deposit(2, 1000, 'B');
  b.accounts.get(1).micro = 1e300;   // only a bug elsewhere could do this
  assert.strictEqual(b.transferShare(1, 2, 1, 2, false), -1);
  assert.strictEqual(b.balance(2), 1000);
  assert.strictEqual(breaches.length, 1);
});

test('_capToArena(NaN) and other non-micro values return 0 with one breach (PaperBank would return the room)', () => {
  const plain = new PaperBank({ onBreach: () => {} });
  plain.deposit(1, 5000, 'A');
  assert.strictEqual(plain._capToArena(NaN, 'withdraw', 1), 5000, 'the hole the override closes');
  for (const bad of [NaN, Infinity, -1, 1.5, '3', null, undefined]) {
    const { b, breaches } = bank();
    b.deposit(1, 5000, 'A');
    assert.strictEqual(b._capToArena(bad, 'withdraw', 1), 0, String(bad));
    assert.strictEqual(breaches.length, 1);
  }
});

test('the ceiling still holds: nothing leaves beyond what the room took in', () => {
  const { b, breaches } = bank();
  b.deposit(1, 100, 'A');
  b.accounts.get(1).micro = 250;     // a bug inflated the account
  const w = b.withdraw(1);
  assert.strictEqual(w.micro, 100, 'capped at inMicro - outMicro');
  assert.strictEqual(breaches.length, 1);
  assert.strictEqual(b.ledger.outMicro, 100);
});

test('a NaN balance withdraws nothing (not the whole room)', () => {
  const { b, breaches } = bank();
  b.deposit(1, 100, 'A');
  b.deposit(2, 900, 'B');
  b.accounts.get(1).micro = NaN;
  const w = b.withdraw(1);
  assert.strictEqual(w.micro, 0);
  assert.strictEqual(b.ledger.outMicro, 0);
  assert.ok(breaches.length >= 1);
});
