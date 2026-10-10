'use strict';
/* scripts/reconcile-stakes.js, the pure halves (BACKLOG 2.1 review): which escrow transactions are
   inflows inside the window, and which of those have no used_stake_sigs row. The chain and the
   database calls around them are not run here; the script reads and prints, and moves nothing. */
const test = require('node:test');
const assert = require('node:assert');
const { inflowsFrom, reconcile, parseArgs } = require('../scripts/reconcile-stakes');
const { stakeDeltaUnits, toUsdc } = require('../server/Usdc');

const ESCROW = 'Escrow1111111111111111111111111111111111111';
const MINT = 'Mint11111111111111111111111111111111111111';
const bal = (owner, amount) => ({ owner, mint: MINT, uiTokenAmount: { amount: String(amount) } });
const txOf = (payer, pre, post) => ({
  meta: { err: null, preTokenBalances: [bal(ESCROW, pre)], postTokenBalances: [bal(ESCROW, post)] },
  transaction: { message: { accountKeys: [{ pubkey: payer }] } },
});
const T0 = Date.parse('2026-10-10T15:00:00Z');
const at = (sec) => Math.floor((T0 + sec * 1000) / 1000);

test('only successful escrow inflows inside the window are listed, at the delta the verifier credits', () => {
  const sigs = [
    { signature: 'in-50', blockTime: at(30) },
    { signature: 'out-45', blockTime: at(40) },             // a cash-out: escrow went down
    { signature: 'failed', blockTime: at(50), err: { x: 1 } },
    { signature: 'before', blockTime: at(-600) },           // before --from
    { signature: 'in-1', blockTime: at(90) },
  ];
  const txs = [
    txOf('PlayerA', 10000000, 10500000),
    txOf('Escrow', 10500000, 10050000),
    txOf('PlayerB', 0, 500000),
    txOf('PlayerC', 0, 500000),
    txOf('PlayerD', 10050000, 11050000),
  ];
  const got = inflowsFrom(sigs, txs, { owner: ESCROW, mint: MINT, fromMs: T0, toMs: T0 + 120000,
    deltaUnits: stakeDeltaUnits, toUsdc });
  assert.deepStrictEqual(got.map(f => [f.signature, f.payer, f.usdc]), [['in-50', 'PlayerA', 0.5], ['in-1', 'PlayerD', 1]]);
  assert.strictEqual(got[0].units, 500000n);
});

test('an inflow with no used_stake_sigs row is flagged; a recorded one shows its state', () => {
  const inflows = [
    { signature: 'a', at: T0, payer: 'P1', units: 500000n, usdc: 0.5 },
    { signature: 'b', at: T0, payer: 'P2', units: 1000000n, usdc: 1 },
    { signature: 'c', at: T0, payer: 'P3', units: 500000n, usdc: 0.5 },
  ];
  const rows = [{ sig: 'a', state: 'consumed', label: 'stake 0.5' }, { sig: 'c', state: null, label: null }];
  const out = reconcile(inflows, rows);
  assert.deepStrictEqual(out.map(f => [f.signature, f.recorded, f.state]),
    [['a', true, 'consumed'], ['b', false, null], ['c', true, 'claimed (legacy row)']]);
});

test('the script reads its window from the command line and is read only', () => {
  assert.deepStrictEqual(parseArgs(['--from', '2026-10-10T15:00:00Z', '--to', '1', '--escrow', 'E', '--x', 'y']),
    { from: '2026-10-10T15:00:00Z', to: '1', escrow: 'E' });
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'reconcile-stakes.js'), 'utf8');
  assert.doesNotMatch(src, /withdraw|sendRawTransaction|sendTransaction|INSERT|UPDATE |DELETE /, 'it never sends or writes');
});
