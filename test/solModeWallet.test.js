'use strict';
/* The client in SOL mode (Owen, 2026-10-21): the games still count in dollars, the money in the wallet is SOL.

   - The Wallet tab shows the SOL's dollar value large and the SOL small under it; "Convert to USDC" and the sheet
     that opens by itself for convertible SOL never appear. Old USDC gets one line, "You have $X USDC", with Convert to
     SOL and Withdraw USDC.
   - Withdraw sends SOL by default; Max is the SOL less 0.001 SOL and the fee, so a send can never leave the wallet
     holding dust (the widget re-checks it: solReserve.mjs). USDC mode is left alone (walletTab.test.js pins it).

   wallet.js is run for real in a stub page, the way v2LobbyHarness.js runs the lobby's launch code. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').split('\r\n').join('\n');
const SRC = read('public/js/v2/wallet.js');
const WIDGET = read('wallet-widget/src/main.jsx');

const ADDR = '7xKpAbCdEfGhJkLmNpQrStUvWxYz123456789abcdef';
const TO = 'So11111111111111111111111111111111111111112';
const tick = () => new Promise((r) => setImmediate(r));

function page(wallet) {
  const els = {};
  const el = (id) => (els[id] = els[id] || (() => {
    const cls = new Set();
    return {
      id, innerHTML: '', textContent: '', value: '', dataset: {}, style: { display: '' }, scrollTop: 0, hidden: false,
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) },
      setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; }, insertAdjacentHTML() {},
    };
  })());
  const on = {};
  const calls = { quote: [], usdcToSol: 0, run: [], send: [], toasts: [], notes: [] };
  const win = {
    console, setTimeout, clearTimeout, Math, Number, String, Date, Promise, JSON, Object, Array, isFinite, parseFloat,
    document: {
      getElementById: (id) => (id === 'privy-modal-content' ? null : el(id)),
      querySelector: () => null, addEventListener() {}, visibilityState: 'visible', body: { classList: { toggle() {} } },
    },
    getComputedStyle: () => ({ display: 'block' }),
    localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; })(),
    navigator: {}, location: { origin: 'https://duelseries.com' },
    addEventListener(t, fn) { (on[t] = on[t] || []).push(fn); },
    dispatchEvent(e) { (on[e.type] || []).forEach((fn) => fn(e)); },
    fetch: async () => ({ ok: true, json: async () => ({ transactions: [], transfers: [], complete: true }) }),
    DSToast: { show(o) { calls.toasts.push(o); return { update() {} }; }, expectRise() { return () => {}; } },
    V2Play: { toast(m) { calls.notes.push(m); } },
    duelWalletSend: async (a, t, asset) => { calls.send.push([a, t, asset]); },
    duelWalletRefresh: async () => {},
    duelWalletSwapQuote: async (dir, amount) => { calls.quote.push([dir, amount]); return { requestId: 'q', inAmount: amount, outAmount: 1, minOut: 1, expiresAt: Date.now() + 60000 }; },
    duelWalletSwapRun: async (q) => { calls.run.push(q); return { ok: true, inAmount: q.inAmount, outAmount: q.outAmount }; },
    duelWalletUsdcToSolQuote: async () => { calls.usdcToSol++; return { requestId: 'u', inAmount: 12340000, outAmount: 82000000, minOut: 81000000, expiresAt: Date.now() + 60000 }; },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'public/js/v2/wallet.js' });
  const set = (w) => { win.duelWallet = Object.assign({ ready: true, authenticated: true, address: ADDR }, w); win.dispatchEvent({ type: 'duelwallet:change' }); };
  set(wallet);
  return { win, el, set, calls, body: () => els['w-body'].innerHTML };
}

const SWAP = { solReserve: 0.005, minConvertSol: 0.02, minWithdrawSolUsd: 1 };
// 0.1 SOL at $150 is $15.00, with $12.34 of old USDC beside it.
const SOL_MODE = { mode: 'sol', unit: 'USD', balance: 15, sol: 0.1, solUsd: 150, usdc: 12.34, swap: SWAP };
const USDC_MODE = { mode: 'usdc', unit: 'USDC', balance: 15, sol: 0.1, swap: SWAP };

test('SOL mode: dollars large, the SOL small under it, no Convert to USDC, and the sheet never opens by itself', async () => {
  const p = page(SOL_MODE);
  const b = p.body();
  assert.ok(/id="w-bal" data-cu>\$15\.00</.test(b), 'the SOL\'s value in dollars, large');
  assert.ok(/id="w-sol"><span class="num">0\.1000 SOL<\/span><\/div>/.test(b), 'the SOL itself, small, with nothing beside it');
  assert.ok(!/Convert to USDC/.test(b), 'no Convert to USDC line in SOL mode');
  await tick();
  assert.ok(!p.el('cvveil').classList.contains('on'), 'the Convert sheet did not open by itself for convertible SOL');
  assert.deepStrictEqual(p.calls.quote, [], 'and no price was even asked for');
  // The convert call itself refuses in SOL mode too (a stale button, a console call).
  p.win.V2Wallet.convert();
  await tick();
  assert.ok(!p.el('cvveil').classList.contains('on'));
  assert.deepStrictEqual(p.calls.quote, []);
  // The same wallet in USDC mode is the control: it DOES open and ask, so the test above can fail.
  const u = page(USDC_MODE);
  await tick();
  assert.ok(u.el('cvveil').classList.contains('on'), 'USDC mode still offers the sheet by itself');
  assert.strictEqual(u.calls.quote[0][0], 'toUsdc');
  assert.ok(/Convert to USDC/.test(u.body()), 'and keeps its Convert to USDC line');
  assert.ok(!/id="w-usdc">[^<]/.test(u.body()), 'USDC mode has no USDC line');
});

test('SOL mode: no price yet shows an ellipsis, never $0.00 for money that is there', () => {
  const p = page(Object.assign({}, SOL_MODE, { balance: null, solUsd: null }));
  const b = p.body();
  assert.ok(/id="w-bal" data-cu>…</.test(b));
  assert.ok(/0\.1000 SOL<\/span><span>price unavailable<\/span>/.test(b));
});

test('SOL mode: old USDC is one line, "You have $X USDC", with Convert to SOL and Withdraw USDC', () => {
  const p = page(SOL_MODE);
  const line = /id="w-usdc">(.*?)<\/div>/.exec(p.body());
  assert.ok(line, 'the line is there');
  assert.ok(/You have <b class="num">\$12\.34<\/b> USDC/.test(line[1]));
  assert.ok(/onclick="V2Wallet\.convertUsdc\(\)">Convert to SOL<\/button>/.test(line[1]));
  assert.ok(/onclick="V2Wallet\.cashOut\('usdc'\)">Withdraw USDC<\/button>/.test(line[1]));
  assert.ok(!/Cash out/i.test(line[1]), 'Withdraw, never Cash out');
  const none = page(Object.assign({}, SOL_MODE, { usdc: 0 }));
  assert.ok(/id="w-usdc"><\/div>/.test(none.body()), 'no USDC, no line');
  const nul = page(Object.assign({}, SOL_MODE, { usdc: null }));
  assert.ok(/id="w-usdc"><\/div>/.test(nul.body()), 'unread USDC, no line');
});

test('SOL mode: Max is the SOL less 0.001 SOL and the fee; an amount past it is refused; Max itself sends as SOL', async () => {
  const p = page(SOL_MODE);
  p.win.V2Wallet.cashOut();
  const form = p.el('wdr-body').innerHTML;
  assert.ok(/aria-label="Amount in SOL"/.test(form), 'the amount is in SOL');
  assert.ok(/Send as/.test(form) && />USDC<\/button>/.test(form), 'USDC is offered because there is some');
  p.win.V2Wallet.max();
  assert.strictEqual(p.el('co-amt').value, '0.098995');
  // 0.1 SOL = 100000000 lamports; 98995000 sent + 5000 fee leaves exactly the 1000000 (0.001 SOL) that is kept.
  assert.strictEqual(100000000 - Math.round(0.098995 * 1e9) - 5000, 1000000);
  assert.strictEqual(p.el('co-msg').textContent, 'About $14.85', 'the small dollar figure is the amount times the server\'s rate');

  p.el('co-to').value = TO;
  p.el('co-amt').value = '0.099';   // 1000 lamports too many
  p.win.V2Wallet.submitCash();
  assert.match(p.el('co-msg').textContent, /Keep at least 0\.001 SOL/);
  assert.deepStrictEqual(p.calls.send, []);
  p.el('co-amt').value = '0.5';
  p.win.V2Wallet.submitCash();
  assert.match(p.el('co-msg').textContent, /more than the 0\.1000 SOL you have/);

  p.el('co-amt').value = '0.098995';
  p.win.V2Wallet.submitCash();
  assert.match(p.el('wdr-body').innerHTML, /Send <b>0\.098995 SOL<\/b> \(about \$14\.85\) to/);
  p.win.V2Wallet.confirmCash();
  assert.deepStrictEqual(p.calls.send, [[0.098995, TO, 'sol']]);
});

test('SOL mode: a wallet holding only the fee reserve has nothing to withdraw, and says why', () => {
  const p = page(Object.assign({}, SOL_MODE, { sol: 0.001, balance: 0.15, usdc: 0 }));
  p.win.V2Wallet.cashOut();
  assert.ok(!p.el('wdrveil').classList.contains('on'), 'no sheet');
  assert.deepStrictEqual(p.calls.notes, ['The SOL in your wallet is kept for network fees.']);
});

test('SOL mode: Withdraw USDC opens on USDC, Max is the whole USDC, and it sends as USDC', () => {
  const p = page(SOL_MODE);
  p.win.V2Wallet.cashOut('usdc');
  const form = p.el('wdr-body').innerHTML;
  assert.ok(/aria-label="Amount in USDC"/.test(form));
  assert.ok(/\$12\.34<span class="cvu"> USDC<\/span>/.test(form));
  p.win.V2Wallet.max();
  assert.strictEqual(p.el('co-amt').value, '12.34');
  p.el('co-to').value = TO;
  p.win.V2Wallet.submitCash();
  assert.match(p.el('wdr-body').innerHTML, /Send <b>\$12\.34 USDC<\/b> to/);
  p.win.V2Wallet.confirmCash();
  assert.deepStrictEqual(p.calls.send, [[12.34, TO, 'usdc']]);
  // Not offered when there is none.
  const q = page(Object.assign({}, SOL_MODE, { usdc: 0 }));
  q.win.V2Wallet.cashOut('usdc');
  assert.ok(/aria-label="Amount in SOL"/.test(q.el('wdr-body').innerHTML), 'falls back to SOL');
  assert.ok(!/>USDC<\/button>/.test(q.el('wdr-body').innerHTML));
});

test('SOL mode: Convert to SOL quotes the whole USDC balance, signs nothing until Convert is tapped, then runs once', async () => {
  const p = page(SOL_MODE);
  p.win.V2Wallet.convertUsdc();
  await tick();
  assert.strictEqual(p.calls.usdcToSol, 1, 'one price, for the whole balance (the widget reads it fresh)');
  assert.deepStrictEqual(p.calls.run, [], 'nothing signed from the tap on the line');
  assert.ok(p.el('cvveil').classList.contains('on'));
  assert.strictEqual(p.el('cv-title').textContent, 'Convert to SOL');
  const sheet = p.el('cv-body').innerHTML;
  assert.match(sheet, /Convert \$12\.34 USDC to about/);
  assert.match(sheet, /0\.0820<span class="cvu"> SOL\?<\/span>/);
  assert.match(sheet, /At least<\/span><b class="num">0\.0810 SOL/);
  p.win.V2Wallet.confirmConvert();
  await tick();
  assert.strictEqual(p.calls.run.length, 1);
  assert.strictEqual(p.calls.run[0].requestId, 'u');
  assert.ok(p.calls.toasts.some((t) => t.title === 'Converted' && t.amount === '+0.0820 SOL' && t.detail === 'from $12.34 USDC'));
  assert.ok(!p.el('cvveil').classList.contains('on'), 'the sheet closes');
});

test('the widget and the lobby agree on the reserve, and the widget checks before it signs', () => {
  const mod = read('wallet-widget/src/solReserve.mjs');
  const keep = /KEEP_LAMPORTS = ([\d_]+)/.exec(mod)[1].replace(/_/g, '');
  const fee = /SEND_FEE_LAMPORTS = ([\d_]+)/.exec(mod)[1].replace(/_/g, '');
  assert.ok(new RegExp('KEEP_LAMPORTS = ' + keep + ', SEND_FEE_LAMPORTS = ' + fee + ';').test(SRC), 'wallet.js repeats the same two numbers');
  // A SOL-mode send is checked against a fresh balance before sendSol / sendUsdc builds anything.
  const send = WIDGET.slice(WIDGET.indexOf('window.duelWalletSend = async'), WIDGET.indexOf('window.duelWalletFund = async'));
  assert.ok(send.indexOf('leavesReserve(haveLamports, lamports, SEND_FEE_LAMPORTS)') > -1);
  assert.ok(send.indexOf('leavesReserve(haveLamports, lamports') < send.indexOf('return sendSol('), 'checked before the SOL send is built');
  const iu = send.indexOf('leavesReserve(haveLamports, 0, SEND_FEE_LAMPORTS)');
  assert.ok(iu > -1 && send.indexOf('return sendUsdc(', iu) > iu, 'and before the USDC send');
  assert.ok(/if \(cfg\.mode === 'usdc'\) return sendUsdc\(/.test(send), 'USDC mode sends USDC exactly as before');
  assert.ok(/if \(cfg\.mode !== 'sol'\) throw/.test(send), 'an unreadable mode sends nothing');
});
