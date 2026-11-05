'use strict';
/* Withdraw fees (withdraw fee review 2026-11-05). What a SOL Withdraw costs the network, and that every figure the lobby
   and the widget take off is that cost:

   - the network fee: the transaction the wallet signs (wallet-widget/src/solSend.mjs) has one signature and one System
     transfer, so the fee is the base 5000 lamports. No ComputeBudget instruction: no priority fee. That 5000 is
     SEND_FEE_LAMPORTS (solReserve.mjs), the figure Max, the lobby's check and the widget's check take off.
   - the rent minimum, both ends: the sender keeps 0.001 SOL after the amount and the fee (above the 890,880 lamports a
     plain account must hold, so a partial withdraw never leaves a balance the network refuses), and every send is at
     least 0.001 SOL (a new address must be given its 890,880, or the whole transfer fails on chain).
   - Max sends the most that passes all of that, to the 0.000001 SOL the box shows, and 0.000001 SOL more would not. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Keypair, PublicKey, SystemProgram, SystemInstruction, ComputeBudgetProgram, ComputeBudgetInstruction } = require('@solana/web3.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').split('\r\n').join('\n');
const WIDGET = read('wallet-widget/src/main.jsx');
const LOBBY = read('public/js/v2/wallet.js');
const TO = 'So11111111111111111111111111111111111111112';
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

/* What the network charges for a transaction: the base fee per signature plus the priority fee its ComputeBudget
   instructions set (units x micro-lamports per unit / 1e6, the limit defaulting to 200k a non-budget instruction). */
function networkFee(tx) {
  const msg = tx.compileMessage();
  let limit = 200_000 * tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)).length;
  let micro = 0n;
  for (const ix of tx.instructions) {
    if (!ix.programId.equals(ComputeBudgetProgram.programId)) continue;
    const kind = ComputeBudgetInstruction.decodeInstructionType(ix);
    if (kind === 'SetComputeUnitLimit') limit = ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units;
    if (kind === 'SetComputeUnitPrice') micro = BigInt(ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix).microLamports);
  }
  const priority = Number((BigInt(limit) * micro + 999_999n) / 1_000_000n);
  return msg.header.numRequiredSignatures * 5000 + priority;
}

test('the Withdraw transaction costs exactly SEND_FEE_LAMPORTS: one signature, one transfer, no priority fee', async () => {
  const { buildSolTransfer } = await import('../wallet-widget/src/solSend.mjs');
  const { SEND_FEE_LAMPORTS } = await import('../wallet-widget/src/solReserve.mjs');
  const from = Keypair.generate().publicKey.toBase58();
  const tx = buildSolTransfer(from, TO, 98_995_000, BLOCKHASH);
  assert.strictEqual(tx.instructions.length, 1, 'one instruction');
  assert.ok(tx.instructions[0].programId.equals(SystemProgram.programId), 'a System transfer');
  assert.ok(!tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId)), 'no ComputeBudget: no priority fee');
  const t = SystemInstruction.decodeTransfer(tx.instructions[0]);
  assert.strictEqual(t.fromPubkey.toBase58(), from);
  assert.strictEqual(t.toPubkey.toBase58(), TO);
  assert.strictEqual(BigInt(t.lamports), 98_995_000n, 'the lamports asked for, exactly');
  assert.strictEqual(tx.feePayer.toBase58(), from, 'the sender pays the fee');
  assert.strictEqual(tx.compileMessage().header.numRequiredSignatures, 1, 'one signer');
  assert.strictEqual(networkFee(tx), 5000);
  assert.strictEqual(networkFee(tx), SEND_FEE_LAMPORTS, 'the fee every check takes off is the fee this transaction costs');
  // The reader above does see a priority fee, so the test above can fail: the stake's own budget (main.jsx) costs more.
  const priced = buildSolTransfer(from, TO, 1_000_000, BLOCKHASH);
  priced.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }));
  assert.strictEqual(networkFee(priced), 5000 + 3000);
  // Never a float of SOL, never zero, never a bad address
  for (const bad of [0, -1, 0.5, 1e-9, NaN, Number.MAX_SAFE_INTEGER + 1, '1000']) {
    assert.throws(() => buildSolTransfer(from, TO, bad, BLOCKHASH), /Enter an amount/, String(bad));
  }
  assert.throws(() => buildSolTransfer(from, 'not-an-address', 1_000_000, BLOCKHASH), /valid Solana address/);
});

test('the widget signs that transaction, with the lamports it checked, after the smallest-send and balance checks', () => {
  const sendSol = WIDGET.slice(WIDGET.indexOf('async function sendSol('), WIDGET.indexOf('async function sendUsdc('));
  assert.match(sendSol, /async function sendSol\(toAddress, lamports, wallet, signTransaction\)/);
  assert.match(sendSol, /const tx = buildSolTransfer\(wallet\.address, toAddress, lamports, blockhash\);/);
  assert.ok(!/SystemProgram\.transfer|ComputeBudgetProgram|1e9/.test(sendSol), 'no transfer of its own, no budget, no float of SOL');
  assert.match(WIDGET, /import \{ buildSolTransfer \} from '\.\/solSend\.mjs';/);
  const send = WIDGET.slice(WIDGET.indexOf('window.duelWalletSend = async'), WIDGET.indexOf('window.duelWalletFund = async'));
  const iMin = send.indexOf('if (lamports < MIN_SEND_LAMPORTS) throw new Error(SOL_SEND_SMALL);');
  const iFee = send.indexOf('if (haveLamports < lamports + SEND_FEE_LAMPORTS) throw');
  const iKeep = send.indexOf('if (!leavesReserve(haveLamports, lamports, SEND_FEE_LAMPORTS)) throw new Error(SOL_SEND_LOW);');
  const iSend = send.indexOf('return sendSol(toAddress, lamports, wallet, signTx);');
  assert.ok(iMin > -1 && iFee > -1 && iKeep > -1 && iSend > -1);
  assert.ok(iMin < iFee && iFee < iKeep && iKeep < iSend, 'all three before anything is built or signed');
  assert.ok(!/if \(haveLamports != null\) \{[^}]*MIN_SEND_LAMPORTS/.test(send), 'the smallest send is checked with or without a balance read');
  assert.match(WIDGET, /const SOL_SEND_SMALL = 'The smallest withdrawal is 0\.001 SOL\. The network refuses less to a wallet that is new to it\.';/);
  // The built bundle is this source (npm run build).
  const bundle = read('public/wallet/widget.js');
  assert.ok(bundle.includes('The smallest withdrawal is 0.001 SOL. The network refuses less to a wallet that is new to it.'), 'widget.js rebuilt');
});

test('the rent minimum, both ends: 0.001 SOL kept clears the sender\'s, a 0.001 SOL smallest send clears a new address\'s', async () => {
  const R = await import('../wallet-widget/src/solReserve.mjs');
  // Rent::default(): (128 bytes of account overhead + 0 of data) x 3480 lamports a byte-year x 2 years exempt
  assert.strictEqual(R.RENT_EXEMPT_MIN_LAMPORTS, (128 + 0) * 3480 * 2);
  assert.ok(R.KEEP_LAMPORTS >= R.RENT_EXEMPT_MIN_LAMPORTS, 'what the sender keeps is never rent-paying');
  assert.ok(R.MIN_SEND_LAMPORTS >= R.RENT_EXEMPT_MIN_LAMPORTS, 'what a new address gets is never rent-paying');
  // the lobby repeats the numbers; they must agree with the widget's
  assert.match(LOBBY, new RegExp('const KEEP_LAMPORTS = ' + R.KEEP_LAMPORTS + ', SEND_FEE_LAMPORTS = ' + R.SEND_FEE_LAMPORTS + ';'));
  assert.match(LOBBY, new RegExp('const MIN_SEND_LAMPORTS = ' + R.MIN_SEND_LAMPORTS + ';'));
});

/* The lobby, run for real (as in solModeWallet.test.js), at a spread of balances: Max in SOL and in USD gives the same
   lamports; the widget's own check (leavesReserve) passes them; 0.000001 SOL more fails it. */
function lobby(wallet) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', value: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, insertAdjacentHTML() {} });
  const sent = [], notes = [];
  const win = {
    console, setTimeout, clearTimeout, Math, Number, String, Date, Promise, JSON, Object, Array, isFinite, parseFloat,
    document: { getElementById: (id) => (id === 'privy-modal-content' ? null : el(id)), querySelector: () => null, addEventListener() {},
                visibilityState: 'visible', body: { classList: { toggle() {} } } },
    getComputedStyle: () => ({ display: 'block' }),
    localStorage: { getItem: () => null, setItem() {} }, navigator: {}, location: { origin: 'https://duelseries.com' },
    addEventListener() {}, dispatchEvent() {},
    fetch: async (url) => ({ ok: true, json: async () => (String(url).indexOf('/api/money-config') === 0 ? { solUsd: wallet.solUsd } : { transactions: [] }) }),
    DSToast: { show() { return { update() {} }; } }, V2Play: { toast: (m) => notes.push(m) },
    duelWalletSend: async (a, t, asset) => { sent.push([a, t, asset]); }, duelWalletRefresh: async () => {},
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(LOBBY, win);
  win.duelWallet = Object.assign({ ready: true, authenticated: true, address: '7xKpAbCdEfGhJkLmNpQrStUvWxYz123456789abcdef' }, wallet);
  return { win, el, sent, notes, V: win.V2Wallet };
}
const flush = () => new Promise((r) => setImmediate(r));

test('Max, in SOL and in USD, is the most the widget and the chain accept, at any balance', async () => {
  const { leavesReserve, SEND_FEE_LAMPORTS, KEEP_LAMPORTS, MIN_SEND_LAMPORTS } = await import('../wallet-widget/src/solReserve.mjs');
  const balances = [2_005_000, 2_005_999, 3_000_000, 12_345_678, 100_000_000, 123_456_789, 999_999_999, 1_000_000_000, 7_654_321_987];
  for (const have of balances) {
    for (const rate of [150, 187.23, 9.99]) {
      const out = [];
      for (const unit of ['sol', 'usd']) {
        const p = lobby({ mode: 'sol', unit: 'USD', sol: have / 1e9, balance: have / 1e9 * rate, solUsd: rate, usdc: 0 });
        p.V.cashOut();
        await flush(); await flush();
        if (unit === 'sol') p.V.setUnit('sol');
        p.V.max();
        await flush();
        if (unit === 'usd' && p.el('co-amt').value === '') {
          // under a cent at a very low price: no $0.00 in the box, words instead
          assert.match(p.el('co-msg').textContent, /less than a cent at the SOL price now\. Switch to SOL/);
          assert.ok(Math.floor(out[0] * rate / 1e7) === 0, have + ' at ' + rate + ' is worth under a cent');
          out.push(out[0]);
          continue;
        }
        p.el('co-to').value = TO;
        p.V.submitCash();
        p.V.confirmCash();
        assert.strictEqual(p.sent.length, 1, have + ' ' + unit + ': ' + p.el('co-msg').textContent);
        out.push(Math.round(p.sent[0][0] * 1e9));
      }
      const [inSol, inUsd] = out;
      assert.strictEqual(inSol, inUsd, have + ' at ' + rate + ': Max in USD sends the same lamports as Max in SOL');
      assert.ok(inSol >= MIN_SEND_LAMPORTS, 'at least the smallest send');
      assert.ok(leavesReserve(have, inSol, SEND_FEE_LAMPORTS), have + ': the widget accepts it');
      assert.ok(have - inSol - SEND_FEE_LAMPORTS >= KEEP_LAMPORTS, 'and leaves the sender above its rent minimum');
      assert.ok(!leavesReserve(have, inSol + 1000, SEND_FEE_LAMPORTS), have + ': 0.000001 SOL more would not pass');
    }
  }
});

test('an amount the wallet cannot cover is refused in the form, before anything reaches the widget to sign', async () => {
  const W = { mode: 'sol', unit: 'USD', sol: 0.1, balance: 15, solUsd: 150, usdc: 0 };
  const cases = [
    ['sol', '0.1', /That is more than the 0\.1000 SOL you have\./],                     // the whole balance: no room for the fee
    ['sol', '0.099996', /That is more than the 0\.1000 SOL you have\./],                // a lamport past balance less fee (to the 0.000001)
    ['sol', '0.099', /Keep at least 0\.001 SOL in your wallet for network fees\./],     // leaves 995,000: under the 0.001 kept
    ['sol', '0.00099', /The smallest withdrawal is 0\.001 SOL\./],
    ['usd', '15', /That is more than the \$15\.00 you have\./],
    ['usd', '14.85', /You can withdraw up to \$14\.84\./],
    ['usd', '0.14', /The smallest withdrawal is \$0\.15 \(0\.001 SOL\)\./],
  ];
  for (const [unit, amt, why] of cases) {
    const p = lobby(W);
    p.V.cashOut();
    await flush(); await flush();
    if (unit === 'sol') p.V.setUnit('sol');
    p.el('co-to').value = TO;
    p.el('co-amt').value = amt;
    p.V.submitCash();
    await flush();
    assert.match(p.el('co-msg').textContent, why, unit + ' ' + amt);
    p.V.confirmCash();
    assert.deepStrictEqual(p.sent, [], unit + ' ' + amt + ': nothing handed over to sign');
  }
});
