'use strict';
/* Withdraw in dollars (Owen 2026-11-05). In SOL mode the Withdraw amount is typed in USD (the default) or in SOL, with a
   small toggle beside the box and the other unit live under it. Dollars become SOL at the server's own display rate
   (/api/money-config solUsd, the price every dollar figure on the site is shown at), used only while it is under a
   minute old: with no such price a dollar amount is refused, never guessed. Dollars to SOL rounds DOWN, and every check
   is on the lamports, so no rounding takes a send past the balance after the fee and the 0.001 SOL kept.

   wallet.js is run for real in a stub page (as solModeWallet.test.js does), with a clock and a price the test holds. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/js/v2/wallet.js'), 'utf8');
const ADDR = '7xKpAbCdEfGhJkLmNpQrStUvWxYz123456789abcdef';
const TO = 'So11111111111111111111111111111111111111112';
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const SWAP = { solReserve: 0.005, minConvertSol: 0.02, minWithdrawSolUsd: 1 };
// 0.1 SOL at $150 is $15.00; no old USDC, so the sheet is SOL only.
const SOL_MODE = { mode: 'sol', unit: 'USD', balance: 15, sol: 0.1, solUsd: 150, usdc: 0, swap: SWAP };
// 1 SOL, $150: room for the amounts that are not about the balance
const BIG = Object.assign({}, SOL_MODE, { sol: 1, balance: 150 });

/* opts.price: what /api/money-config answers for solUsd (a number, null, or 'fail' to reject the fetch); change it
   with p.price(v). opts.storage: false for a browser whose storage throws. p.clock(ms) moves the page's clock. */
function page(wallet, opts) {
  opts = opts || {};
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
  const calls = { send: [], toasts: [], notes: [], priceAsks: 0 };
  let price = 'price' in opts ? opts.price : 150;
  let offset = 0;
  const RealDate = Date;
  class FakeDate extends RealDate { static now() { return RealDate.now() + offset; } }
  const store = new Map(opts.stored ? Object.entries(opts.stored) : []);
  const localStorage = opts.storage === false
    ? { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } }
    : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const win = {
    console, setTimeout, clearTimeout, Math, Number, String, Date: FakeDate, Promise, JSON, Object, Array, isFinite, parseFloat,
    document: {
      getElementById: (id) => (id === 'privy-modal-content' ? null : el(id)),
      querySelector: () => null, addEventListener() {}, visibilityState: 'visible', body: { classList: { toggle() {} } },
    },
    getComputedStyle: () => ({ display: 'block' }),
    localStorage,
    navigator: {}, location: { origin: 'https://duelseries.com' },
    addEventListener(t, fn) { (on[t] = on[t] || []).push(fn); },
    dispatchEvent(e) { (on[e.type] || []).forEach((fn) => fn(e)); },
    fetch: async (url) => {
      if (String(url).indexOf('/api/money-config') === 0) {
        calls.priceAsks++;
        if (price === 'fail') throw new Error('offline');
        return { ok: true, json: async () => ({ mode: 'sol', solUsd: price }) };
      }
      return { ok: true, json: async () => ({ transactions: [], transfers: [], complete: true }) };
    },
    DSToast: { show(o) { calls.toasts.push(o); return { update() {} }; }, expectRise() { return () => {}; } },
    V2Play: { toast(m) { calls.notes.push(m); } },
    duelWalletSend: async (a, t, asset) => { calls.send.push([a, t, asset]); },
    duelWalletRefresh: async () => {},
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'public/js/v2/wallet.js' });
  const set = (w) => { win.duelWallet = Object.assign({ ready: true, authenticated: true, address: ADDR }, w); win.dispatchEvent({ type: 'duelwallet:change' }); };
  set(wallet);
  const V = win.V2Wallet;
  return {
    win, el, set, calls, V, store,
    price: (v) => { price = v; },
    clock: (ms) => { offset += ms; },
    form: () => el('wdr-body').innerHTML,
    msg: () => el('co-msg').textContent,
    alt: () => el('co-alt').textContent,
    // the confirm step's lamports, read back from what was handed to the widget
    lamportsSent: () => calls.send.map(([a]) => Math.round(a * 1e9)),
  };
}
async function open(wallet, opts) {
  const p = page(wallet || SOL_MODE, opts);
  p.V.cashOut();
  await tick();
  p.el('co-to').value = TO;
  return p;
}
const type = (p, v) => { p.el('co-amt').value = v; p.V.hint(); };

// ── the arithmetic ────────────────────────────────────────────────────────────────────────────────────────────────

test('dollars to lamports: down to the 0.000001 SOL, never more SOL than the dollars typed, integer-exact', () => {
  const { usdToLamports, lamportsToCents, solText } = page(SOL_MODE).V.wdMath;
  assert.strictEqual(usdToLamports(20, 150), 133_333_000, '$20 at $150 is 0.133333 SOL (0.1333333... rounded down)');
  assert.strictEqual(usdToLamports(15, 150), 100_000_000, 'exact when it divides');
  assert.strictEqual(usdToLamports(0.15, 150), 1_000_000);
  assert.strictEqual(usdToLamports(0.1, 3), 33_333_000, 'float noise in 0.1 never adds a lamport');
  assert.strictEqual(usdToLamports(1234.56, 187.23), 6_593_815_000);
  // no price, or nonsense, is 0 lamports, never a guess
  for (const r of [0, -1, NaN, null, undefined, Infinity]) assert.strictEqual(usdToLamports(20, r), 0, String(r));
  for (const v of [-1, NaN, Infinity]) assert.strictEqual(usdToLamports(v, 150), 0, String(v));
  // A sweep: every amount in cents at many prices is a whole 1000 lamports, never worth more than the dollars typed,
  // and less than 0.000001 SOL under them.
  for (const rate of [0.5, 1, 3.33, 99.99, 150, 150.17, 187.234567, 333.33, 2500]) {
    for (let c = 1; c <= 100000; c += 97) {
      const l = usdToLamports(c / 100, rate);
      assert.strictEqual(l % 1000, 0);
      const worthMicro = (BigInt(l) * BigInt(Math.round(rate * 1e6))) / 1_000_000_000n;   // micro-dollars, down
      assert.ok(worthMicro <= BigInt(c) * 10_000n, `$${c / 100} at ${rate}: worth ${worthMicro} micro-dollars`);
      const next = BigInt(l + 1000) * BigInt(Math.round(rate * 1e6));
      assert.ok(next > BigInt(c) * 10_000n * 1_000_000_000n, `$${c / 100} at ${rate}: one more 0.000001 SOL would be over`);
    }
  }
  // lamports to cents: down for a figure shown, up for a smallest amount
  assert.strictEqual(lamportsToCents(98_995_000, 150), 1484, '0.098995 SOL at $150 is $14.849..., shown $14.84');
  assert.strictEqual(lamportsToCents(98_995_000, 150, true), 1485);
  assert.strictEqual(lamportsToCents(1_000_000, 150, true), 15);
  assert.strictEqual(lamportsToCents(1_000_000, 187.23, true), 19, '0.001 SOL at $187.23 is 18.7 cents: the smallest is $0.19');
  assert.strictEqual(lamportsToCents(1_000_000, 0), 0);
  assert.strictEqual(solText(133_333_000), '0.133333');
  assert.strictEqual(solText(99_000_000), '0.099');
  assert.strictEqual(solText(2_000_000_000), '2');
  assert.strictEqual(solText(133_333_999), '0.133333', 'down to the six places the box takes');
});

// ── the toggle ────────────────────────────────────────────────────────────────────────────────────────────────────

test('the toggle: opens in USD, beside the amount\'s label, the other unit live under the box', async () => {
  const p = await open();
  const f = p.form();
  assert.match(f, /<div class="amthead"><label for="co-amt">Amount in dollars<\/label><div class="ds-seg unitseg" role="radiogroup" aria-label="Type the amount in">/);
  assert.match(f, /role="radio" aria-checked="true" onclick="V2Wallet\.setUnit\('usd'\)">USD<\/button>/);
  assert.match(f, /role="radio" aria-checked="false" onclick="V2Wallet\.setUnit\('sol'\)">SOL<\/button>/);
  assert.match(f, /<span class="ds-input-pre" aria-hidden="true">\$<\/span><input[^>]*aria-label="Amount in US dollars"/, 'a $ in the box');
  assert.ok(!/class="co-unit"/.test(f), 'and no SOL in it');
  assert.match(f, /<p class="note num ph-no-capture" id="co-alt" aria-live="polite"><\/p>/);
  assert.ok(!/Cash out/i.test(f), 'Withdraw, never Cash out');
  assert.strictEqual(p.calls.priceAsks, 1, 'the price was asked for as the sheet opened');
  type(p, '20');
  assert.strictEqual(p.alt(), '≈ 0.1333 SOL');
  type(p, '');
  assert.strictEqual(p.alt(), '');
  // SOL: the box in SOL, the dollars under it
  p.V.setUnit('sol');
  const g = p.form();
  assert.match(g, /<label for="co-amt">Amount in SOL<\/label>/);
  assert.match(g, /aria-checked="true" onclick="V2Wallet\.setUnit\('sol'\)">SOL</);
  assert.match(g, /<span class="co-unit" aria-hidden="true">SOL<\/span>/);
  type(p, '0.1');
  assert.strictEqual(p.alt(), '≈ $15.00');
  assert.strictEqual(p.el('co-to').value, TO, 'the address stays across a switch');
});

test('every open starts in USD: SOL chosen last time, or stored by an older build, is never remembered', async () => {
  const p = await open();
  p.V.setUnit('sol');
  assert.match(p.form(), /Amount in SOL/);
  assert.ok(!p.store.has('ds.wdUnit'), 'nothing written to storage');
  p.V.cancelCash();
  p.V.cashOut();
  assert.match(p.form(), /Amount in dollars/, 'opens in USD again');
  // storage that throws (a private window, blocked site data): USD, and switching still works
  const q = await open(SOL_MODE, { storage: false });
  assert.match(q.form(), /Amount in dollars/);
  q.V.setUnit('sol');
  assert.match(q.form(), /Amount in SOL/);
  for (const v of ['sol', 'SOL', 'usdc', '', '1']) {
    const r = await open(SOL_MODE, { stored: { 'ds.wdUnit': v } });
    assert.match(r.form(), /Amount in dollars/, JSON.stringify(v));
  }
});

test('switching keeps the amount: $20 becomes 0.133333 SOL, and straight back it is $20 again, as typed', async () => {
  const p = await open(BIG);
  type(p, '20');
  p.V.setUnit('sol');
  assert.strictEqual(p.el('co-amt').value, '0.133333');
  assert.strictEqual(p.alt(), '≈ $19.99', 'what 0.133333 SOL is worth, down to the cent');
  p.V.setUnit('usd');
  assert.strictEqual(p.el('co-amt').value, '20', 'not $19.99: the box gives back what was typed');
  p.V.submitCash();
  assert.match(p.form(), /Send <b>\$20\.00<\/b> as <b>0\.133333 SOL<\/b> to/);
  // SOL typed, switched to USD: the box shows its worth and sends exactly that SOL
  const q = await open();
  q.V.setUnit('sol');
  type(q, '0.05');
  q.V.setUnit('usd');
  assert.strictEqual(q.el('co-amt').value, '7.50');
  q.V.submitCash();
  q.V.confirmCash();
  assert.deepStrictEqual(q.lamportsSent(), [50_000_000]);
  // a toggle with the confirm step up does nothing
  const r = await open();
  type(r, '5');
  r.V.submitCash();
  r.V.setUnit('sol');
  assert.match(r.form(), /Send <b>\$5\.00<\/b>/);
});

// ── sending dollars ───────────────────────────────────────────────────────────────────────────────────────────────

test('typing 20 in USD sends $20 of SOL at the site\'s price: the confirm step says both, the widget gets the lamports', async () => {
  const p = await open(BIG);
  type(p, '20');
  p.V.submitCash();
  const f = p.form();
  assert.match(f, /Send <b>\$20\.00<\/b> as <b>0\.133333 SOL<\/b> to/);
  assert.match(f, /<code class="cofull ph-no-capture">So11111111111111111111111111111111111111112<\/code>/);
  assert.match(f, /At \$150\.00 a SOL, plus the 0\.000005 SOL network fee\. On-chain transfers cannot be reversed\./);
  assert.deepStrictEqual(p.calls.send, [], 'nothing sent before Send it');
  p.V.confirmCash();
  await tick();
  assert.deepStrictEqual(p.calls.send, [[0.133333, TO, 'sol']], 'SOL, as SOL (the widget\'s unit for a SOL sheet)');
  assert.deepStrictEqual(p.lamportsSent(), [133_333_000]);
  const t = p.calls.toasts.find((x) => x.title === 'Sending your withdraw');
  assert.ok(t && t.amount === '$20.00' && t.detail === 'as 0.133333 SOL to', 'the card says the dollars and the SOL');
  // a typed $ and a comma are read as dollars and a point; more than cents is refused
  const q = await open();
  type(q, '$12,5');
  q.V.submitCash();
  assert.match(q.form(), /Send <b>\$12\.50<\/b> as <b>0\.083333 SOL<\/b>/);
  const r = await open();
  type(r, '1.234');
  r.V.submitCash();
  assert.strictEqual(r.msg(), 'Use dollars and cents, two decimal places at most.');
});

test('Max in USD: the SOL less the fee and the 0.001 SOL kept, shown in dollars down to the cent, sent to the lamport', async () => {
  const p = await open();
  p.V.max();
  assert.strictEqual(p.el('co-amt').value, '14.84');
  assert.strictEqual(p.alt(), '≈ 0.0989 SOL');
  p.V.submitCash();
  assert.match(p.form(), /Send <b>\$14\.84<\/b> as <b>0\.098995 SOL<\/b> to/);
  p.V.confirmCash();
  // 0.1 SOL: 98,995,000 sent + 5,000 fee leaves exactly the 1,000,000 kept
  assert.deepStrictEqual(p.lamportsSent(), [98_995_000]);
  assert.strictEqual(100_000_000 - 98_995_000 - 5000, 1_000_000);
  // An odd balance: Max is the most to the 0.000001 SOL, and the most dollars typed by hand is that same figure.
  const odd = Object.assign({}, SOL_MODE, { sol: 0.123456789, balance: 18.52 });
  const q = await open(odd);
  q.V.max();
  assert.strictEqual(q.el('co-amt').value, '18.36');           // 122,451,000 lamports at $150 = $18.36765
  q.V.submitCash();
  q.V.confirmCash();
  assert.deepStrictEqual(q.lamportsSent(), [122_451_000]);
  assert.ok(123_456_789 - 122_451_000 - 5000 >= 1_000_000 && 123_456_789 - 122_452_000 - 5000 < 1_000_000,
    'and 0.000001 SOL more would not leave the 0.001 SOL');
  const r = await open(odd);
  type(r, '18.36');                                           // typed, not Max: still allowed
  r.V.submitCash();
  r.V.confirmCash();
  assert.ok(r.lamportsSent()[0] <= 122_451_000);
  const s = await open(odd);
  type(s, '18.37');                                           // a cent more than Max: refused before anything is signed
  s.V.submitCash();
  assert.strictEqual(s.msg(), 'You can withdraw up to $18.36. 0.001 SOL stays in your wallet for network fees. Max sends the most you can.');
  assert.deepStrictEqual(s.calls.send, []);
});

test('an amount the wallet cannot cover is refused in words before signing: over the balance, over Max, under 0.001 SOL', async () => {
  const p = await open();
  type(p, '50');
  p.V.submitCash();
  assert.strictEqual(p.msg(), 'That is more than the $15.00 you have. Max sends the most you can.');
  assert.strictEqual(p.el('co-msg').dataset.state, 'bad', 'in the error red');
  type(p, '14.85');                                           // 99,000,000 lamports: 5,000 past Max
  assert.strictEqual(p.msg(), '', 'typing clears it');
  p.V.submitCash();
  assert.strictEqual(p.msg(), 'You can withdraw up to $14.84. 0.001 SOL stays in your wallet for network fees. Max sends the most you can.');
  type(p, '0.10');                                            // 0.000666 SOL: a new address would be under its rent minimum
  p.V.submitCash();
  assert.strictEqual(p.msg(), 'The smallest withdrawal is $0.15 (0.001 SOL). The network refuses less to a wallet that is new to it.');
  type(p, '0.15');                                            // the smallest, as said, goes
  p.V.submitCash();
  assert.match(p.form(), /Send <b>\$0\.15<\/b> as <b>0\.001 SOL<\/b>/);
  assert.deepStrictEqual(p.calls.send, []);
  // In SOL the same, in SOL words
  const q = await open();
  q.V.setUnit('sol');
  type(q, '0.0009');
  q.V.submitCash();
  assert.strictEqual(q.msg(), 'The smallest withdrawal is 0.001 SOL. The network refuses less to a wallet that is new to it.');
  // the smallest send is checked even on a balance not read (the widget refuses it too, before signing)
  const r = await open(Object.assign({}, SOL_MODE, { stale: true }));
  r.V.setUnit('sol');
  type(r, '0.0005');
  r.V.submitCash();
  assert.match(r.msg(), /The smallest withdrawal is 0\.001 SOL/);
  assert.deepStrictEqual(r.calls.send, []);
});

test('a wallet whose most is under the smallest send opens on nothing to send, and says why', async () => {
  // 0.0019 SOL: 1,900,000 - 1,000,000 kept - 5,000 fee = 895,000, under the 0.001 SOL smallest send
  const p = page(Object.assign({}, SOL_MODE, { sol: 0.0019, balance: 0.28 }));
  p.V.cashOut();
  assert.ok(!p.el('wdrveil').classList.contains('on'));
  assert.deepStrictEqual(p.calls.notes, ['The SOL in your wallet is kept for network fees.']);
  // 0.002005 SOL: exactly 0.001 SOL can go
  const q = await open(Object.assign({}, SOL_MODE, { sol: 0.002005, balance: 0.3 }));
  assert.ok(q.el('wdrveil').classList.contains('on'));
  q.V.max();
  q.V.submitCash();
  q.V.confirmCash();
  assert.deepStrictEqual(q.lamportsSent(), [1_000_000]);
});

// ── a price that is missing or old ────────────────────────────────────────────────────────────────────────────────

test('no price: dollars are refused, never guessed; the SOL box still works', async () => {
  for (const price of [null, 0, -3, 'abc', 'fail']) {
    const p = await open(SOL_MODE, { price });
    assert.strictEqual(p.alt(), 'The SOL price is not available right now.', String(price));
    type(p, '20');
    p.V.submitCash();
    await tick();
    assert.strictEqual(p.msg(), 'The SOL price is not available right now, so dollars cannot be turned into SOL. Try again in a moment, or switch to SOL.');
    assert.strictEqual(p.el('co-msg').dataset.state, 'bad');
    assert.match(p.form(), /id="co-amt"/, 'still the form, no confirm step');
    p.V.max();
    await tick();
    assert.strictEqual(p.el('co-amt').value, '20', 'Max in dollars waits for a price too');
    p.V.setUnit('sol');
    assert.strictEqual(p.el('co-amt').value, '', 'no price to turn $20 into SOL with: the box empties');
    type(p, '0.05');
    assert.strictEqual(p.alt(), '', 'no dollars under a SOL amount without a price');
    p.V.submitCash();
    assert.match(p.form(), /Send <b>0\.05 SOL<\/b> to/, 'SOL needs no price');
    p.V.confirmCash();
    assert.deepStrictEqual(p.lamportsSent(), [50_000_000]);
  }
  // the widget's own figure is not used in its place: a price the sheet did not get is no price
  const q = await open(Object.assign({}, SOL_MODE, { solUsd: 150 }), { price: null });
  type(q, '20');
  q.V.submitCash();
  await tick();
  assert.match(q.msg(), /The SOL price is not available right now/);
});

test('an old price: past a minute, dollars wait for a new one, and are refused if none comes', async () => {
  const p = await open(BIG);
  type(p, '15');
  assert.strictEqual(p.alt(), '≈ 0.1000 SOL');
  p.clock(61_000);
  p.price(300);
  const asks = p.calls.priceAsks;
  p.V.submitCash();
  assert.strictEqual(p.msg(), 'Getting the SOL price…', 'a plain line while it asks');
  assert.strictEqual(p.el('co-msg').dataset.state, '');
  await tick();
  assert.strictEqual(p.calls.priceAsks, asks + 1, 'asked again');
  assert.match(p.form(), /Send <b>\$15\.00<\/b> as <b>0\.05 SOL<\/b> to/, 'at the new price, not the old one ($15 at $300)');
  // old, and the new ask brings none: refused
  const q = await open();
  type(q, '15');
  q.clock(61_000);
  q.price(null);
  q.V.submitCash();
  await tick();
  assert.match(q.msg(), /The SOL price is not available right now/);
  assert.deepStrictEqual(q.calls.send, []);
  // under a minute it is used as it is (no ask per tap)
  const r = await open(BIG);
  type(r, '15');
  r.clock(50_000);
  const before = r.calls.priceAsks;
  r.V.submitCash();
  assert.match(r.form(), /Send <b>\$15\.00<\/b> as <b>0\.1 SOL<\/b>/);
  assert.strictEqual(r.calls.priceAsks, before);
  // a clock set back never makes a price younger: it is asked again
  const s = await open(BIG);
  s.clock(-120_000);
  const had = s.calls.priceAsks;
  type(s, '15');
  assert.strictEqual(s.alt(), 'Getting the SOL price…');
  await tick();
  assert.strictEqual(s.calls.priceAsks, had + 1);
  assert.strictEqual(s.alt(), '≈ 0.1000 SOL');
});

test('the confirm step left open past a minute: Send it asks the price again and shows the new amount for a second tap', async () => {
  const p = await open(BIG);
  type(p, '30');
  p.V.submitCash();
  assert.match(p.form(), /Send <b>\$30\.00<\/b> as <b>0\.2 SOL<\/b>/);
  p.clock(61_000);
  p.price(100);
  p.V.confirmCash();
  assert.match(p.form(), /Getting the SOL price…/);
  await tick();
  assert.deepStrictEqual(p.calls.send, [], 'not sent at the old price');
  assert.match(p.form(), /Send <b>\$30\.00<\/b> as <b>0\.3 SOL<\/b> to/);
  assert.match(p.form(), /The SOL price moved while this was open\./);
  p.V.confirmCash();
  assert.deepStrictEqual(p.lamportsSent(), [300_000_000]);
  // the new amount past what the wallet can send: back to the form, in words, nothing sent
  const q = await open();
  type(q, '9.95');
  q.V.submitCash();
  q.clock(61_000);
  q.price(100);                                       // $9.95 is now 0.0995 SOL, more than the 0.098995 that can go
  q.V.confirmCash();
  await tick();
  assert.match(q.msg(), /You can withdraw up to \$9\.89\./);
  assert.match(q.form(), /id="co-amt"/);
  assert.strictEqual(q.el('co-amt').value, '9.95', 'with what was typed still in the box');
  assert.deepStrictEqual(q.calls.send, []);
  // no price at all now: back to the form, refused
  const r = await open();
  type(r, '5');
  r.V.submitCash();
  r.clock(61_000);
  r.price('fail');
  r.V.confirmCash();
  await tick();
  assert.match(r.msg(), /The SOL price is not available right now/);
  assert.deepStrictEqual(r.calls.send, []);
});

test('the confirm step\'s minute runs from when the price was asked, not from the tap (money review 2026-11-05)', async () => {
  const p = await open(BIG);                          // the price asked as the sheet opened
  p.clock(25_000);                                    // under half its life: typing asks no new one
  type(p, '20');
  p.V.submitCash();
  assert.match(p.form(), /Send <b>\$20\.00<\/b> as/);
  const asks = p.calls.priceAsks;
  p.clock(40_000);                                    // 40 s after the tap, 65 s after the price
  p.V.confirmCash();
  assert.deepStrictEqual(p.calls.send, [], 'never sent on a price over a minute old');
  await tick();
  assert.ok(p.calls.priceAsks > asks, 'the price is asked again');
  p.V.confirmCash();
  assert.deepStrictEqual(p.lamportsSent(), [133_333_000]);
});

test('Max\'s exact lamports go once the box is typed over, even if the same text comes back', async () => {
  const p = await open();
  p.V.max();
  await tick();
  assert.strictEqual(p.el('co-amt').value, '14.84');
  type(p, '14.8');
  type(p, '14.84');                                   // typed by hand: $14.84 at the price, not Max's 0.098995 SOL
  p.V.submitCash();
  p.V.confirmCash();
  assert.deepStrictEqual(p.lamportsSent(), [98_933_000]);
});

test('an amount is digits and one point: "1,000", "0x10" and "1e2" are refused in words, "2,5" is 2.5', async () => {
  const p = await open(BIG);
  for (const [v, why] of [['1,000', /without commas/], ['$1,000.00', /without commas/], ['0x10', /plain number/], ['1e2', /plain number/], ['-5', /plain number/]]) {
    type(p, v);
    p.V.submitCash();
    assert.match(p.msg(), why, v);
    assert.match(p.form(), /id="co-amt"/, 'still on the form: ' + v);
  }
  p.V.setUnit('sol');
  type(p, '0x10');
  p.V.submitCash();
  assert.match(p.msg(), /plain number/);
  type(p, '0,5');
  p.V.submitCash();
  p.V.confirmCash();
  assert.deepStrictEqual(p.lamportsSent(), [500_000_000]);
  assert.deepStrictEqual(p.calls.send.length, 1);
});

test('a late price answer for a sheet that was closed or switched does nothing', async () => {
  const p = await open(SOL_MODE, { price: null });
  p.price(150);
  p.clock(31_000);                                     // the failed ask is old enough to ask again
  type(p, '20');
  p.V.submitCash();                                    // waits for the price...
  p.V.cancelCash();                                    // ...and the sheet is closed before it comes
  await tick();
  assert.deepStrictEqual(p.calls.send, []);
  assert.ok(!p.el('wdr-body').innerHTML.includes('Send <b>'), 'no confirm step drawn behind a closed sheet');
});

test('USDC mode (MONEY_MODE=usdc) is left exactly as it was: dollars only, no toggle, no price asked', () => {
  const p = page({ mode: 'usdc', unit: 'USDC', balance: 15, sol: 0.1, swap: SWAP });
  p.V.cashOut();
  const f = p.form();
  assert.match(f, /<label for="co-amt">Amount in dollars<\/label>/);
  assert.ok(!/unitseg|co-alt|setUnit/.test(f));
  assert.strictEqual(p.calls.priceAsks, 0);
});
