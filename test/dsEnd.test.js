'use strict';
// The shared end screens (public/js/shared/dsEnd.js), run for real in a small fake page: what the card and the
// board put on screen, that names stay text, the board's row counts and pinned own row, and the number formats.
// Display only: nothing here may read an amount back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/shared/dsEnd.js'), 'utf8');

function node(tag) {
  const n = {
    tagName: String(tag).toUpperCase(), children: [], className: '', attrs: {}, listeners: {}, style: {}, parentNode: null,
    _text: '', disabled: false,
    get firstChild() { return this.children[0] || null; },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); this.children = []; },
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    click() { (this.listeners.click || []).forEach((fn) => fn({ stopPropagation() {} })); },
    focus() {}
  };
  return n;
}
function all(n, pred, out = []) { if (pred(n)) out.push(n); n.children.forEach((c) => all(c, pred, out)); return out; }
const byClass = (n, c) => all(n, (x) => (' ' + x.className + ' ').includes(' ' + c + ' '));

function page({ width = 1366 } = {}) {
  const head = node('head'), body = node('body');
  const doc = {
    head, body, activeElement: null,
    createElement: (t) => node(t),
    createTextNode: (t) => { const x = node('#text'); x._text = String(t); return x; },
    querySelector: () => null
  };
  const win = { document: doc, innerWidth: width, matchMedia: (q) => ({ matches: width <= Number(/max-width:(\d+)/.exec(q)[1]) }) };
  vm.runInNewContext(SRC, { window: win, JSON, Math, Number, String, Array, Object });
  return { D: win.DSEnd, doc, body, head };
}

test('a paid cash-out card shows the server numbers it was given, the net row last', () => {
  const { D, body } = page();
  const clicks = [];
  D.show({
    tone: 'win', verdict: 'Cashed out', hero: D.usd(2160000), unit: 'to your wallet',
    facts: [['Time', D.clock(365000)], ['Top rank', D.ordinal(3)], ['Length', D.int(2210)]],
    ledger: [['Cashed out', D.usd(2400000)], ['House 10%', D.usd(-240000)], ['You receive', D.usd(2160000)]],
    status: { text: 'Sent to your wallet.', state: 'ok', link: { href: 'https://solscan.io/tx/x', text: 'View transaction' } },
    buttons: [{ id: 'again', text: 'Play again $1.00', primary: true, onClick: () => clicks.push('again') }, { id: 'lobby', text: 'Lobby', onClick: () => clicks.push('lobby') }]
  });
  assert.strictEqual(D.shown(), true);
  const card = byClass(body, 'dse')[0];
  assert.match(card.className, /t-win/);
  assert.strictEqual(byClass(card, 'dse-big')[0].textContent, '$2.16');
  const rows = byClass(card, 'dse-lr');
  assert.deepStrictEqual(rows.map((r) => r.textContent), ['Cashed out$2.40', 'House 10%−$0.24', 'You receive$2.16']);
  assert.match(rows[2].className, /net/);
  assert.doesNotMatch(rows[0].className, /net/);
  assert.deepStrictEqual(byClass(card, 'dse-facts')[0].children.map((d) => d.textContent), ['Time6:05', 'Top rank3rd', 'Length2,210']);
  const btns = byClass(card, 'dse-btn');
  assert.strictEqual(btns.length, 2);
  assert.match(btns[0].className, /pri/);
  assert.match(btns[1].className, /solo/);
  btns[0].click(); btns[1].click();
  assert.deepStrictEqual(clicks, ['again', 'lobby']);
  const a = all(card, (x) => x.tagName === 'A')[0];
  assert.strictEqual(a.href, 'https://solscan.io/tx/x');
  assert.strictEqual(a.rel, 'noopener noreferrer');
});

test('names and server strings go in as text, never markup; a non-https link is dropped', () => {
  const { D, body } = page();
  D.show({ verdict: 'Killed by <img src=x onerror=alert(1)>', hero: '1', podium: [{ rank: 1, name: '<b>me</b>', me: true }],
    status: { text: 'x', link: { href: 'javascript:alert(1)' } } });
  const card = byClass(body, 'dse')[0];
  assert.strictEqual(byClass(card, 'dse-v')[0].textContent, 'Killed by <img src=x onerror=alert(1)>');
  assert.strictEqual(all(card, (x) => x.tagName === 'IMG').length, 0);
  assert.strictEqual(all(card, (x) => x.tagName === 'A').length, 0);
  assert.strictEqual(byClass(card, 'me')[0].textContent, '1<b>me</b>');
});

test('update keeps the card and swaps what changed; a disabled button ignores clicks; hide removes it', () => {
  const { D, body } = page();
  let n = 0;
  const h = D.show({ verdict: 'Cashed out', hero: '$1.00', status: { text: 'Sending to your wallet', state: 'pending' },
    buttons: [{ id: 'again', text: 'Next match in 4:12', primary: true, disabled: true, onClick: () => n++ }] });
  h.button('again').click();
  assert.strictEqual(n, 0);
  h.update({ status: { text: 'Sent to your wallet.', state: 'ok' } });
  const card = byClass(body, 'dse')[0];
  assert.strictEqual(byClass(card, 'dse-v')[0].textContent, 'Cashed out');
  assert.match(byClass(card, 'dse-st')[0].className, /ok/);
  assert.strictEqual(byClass(body, 'dse').length, 1);
  D.hide();
  assert.strictEqual(D.shown(), false);
  assert.strictEqual(byClass(body, 'dse').length, 0);
});

test('the board shows 10 rows on a PC and 5 on a phone, your row marked, or pinned under the list', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ name: 'p' + i, value: String(100 - i), me: i === 2 }));
  for (const [width, n] of [[1366, 10], [390, 5]]) {
    const { D, body } = page({ width });
    const b = D.board({ money: true });
    b.set(rows, { rank: 3, name: 'p2', value: '98' });
    const lis = byClass(body, 'dsb')[0].children[1].children;
    assert.strictEqual(lis.length, n);
    assert.strictEqual(lis.filter((l) => l.className === 'me').length, 1);
    assert.strictEqual(lis[2].className, 'me');
    b.set(rows.map((r) => Object.assign({}, r, { me: false })), { rank: 14, name: 'Owen', value: '7' });
    const pinned = byClass(body, 'dsb')[0].children[1].children;
    assert.strictEqual(pinned.length, n + 2);
    assert.strictEqual(pinned[n].className, 'gap');
    assert.strictEqual(pinned[n + 1].className, 'me');
    assert.strictEqual(pinned[n + 1].textContent, '14Owen7');
    b.destroy();
    assert.strictEqual(byClass(body, 'dsb').length, 0);
  }
});

test('number formats: micro-USDC, clock, thousands, ordinals', () => {
  const { D } = page();
  assert.strictEqual(D.usd(2160000), '$2.16');
  assert.strictEqual(D.usd(-1000000), '−$1.00');
  assert.strictEqual(D.usd(0), '$0.00');
  assert.strictEqual(D.usd('junk'), '$0.00');
  assert.strictEqual(D.clock(222000), '3:42');
  assert.strictEqual(D.clock(3725000), '1:02:05');
  assert.strictEqual(D.int(1284), '1,284');
  assert.strictEqual(D.int(1234567), '1,234,567');
  assert.deepStrictEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(D.ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
});

test('the style and font are added once, however many times it shows', () => {
  const { D, head } = page();
  D.show({ hero: '1' }); D.show({ hero: '2' }); D.board({});
  assert.strictEqual(head.children.filter((c) => c.tagName === 'STYLE').length, 1);
  assert.strictEqual(head.children.filter((c) => c.tagName === 'LINK').length, 1);
});
