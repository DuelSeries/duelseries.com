'use strict';
/* The SOL-mode reserve (wallet-widget/src/solReserve.mjs): a stake or a send must leave at least 0.001 SOL in the
   wallet AFTER the amount and the network fee, so a wallet is never left holding dust. Also pins where the widget
   uses it: a SOL stake is refused with plain words before anything is signed, USDC stakes are untouched. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const widget = fs.readFileSync(path.join(ROOT, 'wallet-widget/src/main.jsx'), 'utf8').split('\r\n').join('\n');

test('a send must leave 0.001 SOL after the amount and the fee', async () => {
  const { KEEP_LAMPORTS, SEND_FEE_LAMPORTS, leavesReserve, maxSendLamports } = await import('../wallet-widget/src/solReserve.mjs');
  assert.strictEqual(KEEP_LAMPORTS, 1_000_000);
  const have = 100_000_000;                                     // 0.1 SOL
  // Max leaves exactly the reserve, one lamport more does not.
  const max = maxSendLamports(have);
  assert.strictEqual(max, have - KEEP_LAMPORTS - SEND_FEE_LAMPORTS);
  assert.ok(leavesReserve(have, max, SEND_FEE_LAMPORTS), 'Max is allowed');
  assert.ok(!leavesReserve(have, max + 1, SEND_FEE_LAMPORTS), 'one lamport past Max is not');
  // Never between 0 and 0.001 SOL left: sending nearly all of it is refused, as is sending more than there is.
  assert.ok(!leavesReserve(have, have - SEND_FEE_LAMPORTS - 1, SEND_FEE_LAMPORTS), 'would leave 1 lamport');
  assert.ok(!leavesReserve(have, have - 500_000, SEND_FEE_LAMPORTS), 'would leave 0.0005 SOL');
  assert.ok(!leavesReserve(have, have + 1, SEND_FEE_LAMPORTS), 'more than the wallet has');
  // A small wallet: nothing may be sent, and Max is 0 rather than negative.
  assert.strictEqual(maxSendLamports(1_000_000), 0);
  assert.strictEqual(maxSendLamports(0), 0);
  assert.strictEqual(maxSendLamports(-5), 0);
  assert.strictEqual(maxSendLamports(NaN), 0);
  // Garbage in is a no, not a yes.
  for (const bad of [NaN, undefined, null, Infinity]) assert.ok(!leavesReserve(bad, 1, 5000), 'a balance of ' + bad);
  assert.ok(!leavesReserve(have, -1, 5000), 'a negative amount is not an amount');
  assert.ok(!leavesReserve(have, 'x', 5000));
});

test('a SOL stake is refused before it is built or signed; a USDC stake never asks', () => {
  const stake = widget.slice(widget.indexOf('async function stakeOnly('), widget.indexOf('async function signSkinPayment'));
  const guard = stake.indexOf("if (quote.mode === 'sol') {");
  assert.ok(guard > -1, 'the SOL branch');
  assert.ok(/leavesReserve\(Math\.round\(have \* 1e9\), owes, STAKE_FEE_LAMPORTS\)/.test(stake), 'the stake and its fee must leave the reserve');
  assert.ok(/throw new Error\(SOL_LOW_MSG\)/.test(stake));
  assert.ok(guard < stake.indexOf("onStatus('Building stake…')"), 'before anything is built');
  assert.ok(guard < stake.indexOf('signTransaction({ transaction: serialized, wallet })'), 'before anything is signed');
  assert.ok(stake.indexOf('if (!owes) return') < guard, 'a free or zero quote never reads the balance');
  // The message is plain words, says what to do, and cannot be mistaken for a chain error by doStake's "rent" test.
  const msg = /const SOL_LOW_MSG = '([^']+)'/.exec(widget)[1];
  assert.match(msg, /^Add a little SOL/);
  assert.ok(!/rent|insufficient funds/i.test(msg), msg);
  assert.ok(!/[—–]/.test(msg), 'no dashes in what a player reads');
  // The stake's fee allowance is the base fee plus the most its priority fee can add.
  assert.ok(/const STAKE_FEE_LAMPORTS = SEND_FEE_LAMPORTS \+ Math\.ceil\(STAKE_CU_LIMIT \* STAKE_CU_PRICE \/ 1e6\);/.test(widget));
  // The error card: titled, and says what it needs in the entry's words.
  assert.ok(/if \(\/\^Add a little SOL\/\.test\(m\)\)/.test(widget));
});

test('an unreadable money mode is never guessed: it moves nothing', () => {
  const cfg = widget.slice(widget.indexOf('let _moneyCfg = null;'), widget.indexOf('const finite = '));
  assert.ok(/if \(j && \(j\.mode === 'usdc' \|\| j\.mode === 'sol'\)\) _moneyCfg = j;/.test(cfg), 'only a real answer is kept');
  assert.ok(/mode: null/.test(cfg), 'and a failure says mode null, not a mode');
  assert.ok(!/mode: 'sol'/.test(cfg), 'the old guess of SOL is gone');
});
