'use strict';
/* Lobby money that fills up (Owen, 2026-10-16, pick C "Roll"): public/js/v2/countUp.js.
   The helper's own text rules run here in a vm; the wiring is checked in the source,
   in the style of test/v2route.test.js. The animation itself was measured in the
   browser at 1280x800 and 375x812: $0 to the figure in about 1.4 s, width held. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

function helper() {
  const win = { document: { documentElement: {}, body: null } };
  win.window = win;
  vm.runInNewContext(read('public/js/v2/countUp.js'), win);
  return win.DSCount;
}

test('countUp: every figure the lobby prints rolls in its own format and lands on its own string', () => {
  const D = helper();
  const shown = ['$1,234.56', '$48210.55', '$0.50', '+$12.50', '−$1.00', 'Play $0.50',
                 '$20 to 1st', '$20', 'C$5.00', '$999.99'];
  for (const t of shown) {
    const p = D.parse(t);
    assert.ok(p, t + ' is money');
    assert.strictEqual(D.format(p, p.v), t, t + ' is rebuilt exactly');
  }
  // On the way up, the separators and cents are the final figure's own.
  assert.strictEqual(D.format(D.parse('$1,234.56'), 7.5), '$7.50');
  assert.strictEqual(D.format(D.parse('$1,234.56'), 1001), '$1,001.00');
  assert.strictEqual(D.format(D.parse('$48210.55'), 12345.6), '$12345.60', 'toFixed style keeps no comma');
  assert.strictEqual(D.format(D.parse('$20 to 1st'), 7), '$7 to 1st');
});

test('countUp: text that is not a dollar figure is never touched', () => {
  const D = helper();
  for (const t of ['Free', '—', '', 'Play', 'Coming soon', '+0.0123 SOL', '12 playing'])
    assert.strictEqual(D.parse(t), null, JSON.stringify(t));
});

test('countUp: about 1.2 s, a little longer for big amounts, capped', () => {
  const D = helper();
  assert.ok(D.ms(0, 0.5) >= 1000 && D.ms(0, 0.5) < 1100, 'cents');
  assert.ok(D.ms(0, 1284) > D.ms(0, 5), 'bigger takes longer');
  assert.ok(D.ms(0, 1e9) <= 1380 + 1e-9, 'capped at x1.15');
});

test('countUp: loaded before the lobby modules, and screens count from $0 when they open', () => {
  const html = read('public/v2.html');
  const at = s => html.indexOf('<script src="/js/v2/' + s + '"></script>');
  assert.ok(at('countUp.js') > 0 && at('countUp.js') < at('toasts.js') && at('countUp.js') < at('wallet.js'));
  assert.ok(/if\(next&&next!==prev&&window\.DSCount\)DSCount\.open\(next\);/.test(html), 'a tap onto a screen');
  // A swipe opens it one task after the frame that claims the drag (swipe.js), not inside it.
  const prepAt = html.indexOf('function prepareScreen(tab){');
  const prep = html.slice(prepAt, html.indexOf('\n}', prepAt));
  assert.ok(/el\.style\.display='block';[\s\S]*if\(window\.DSCount\)setTimeout\(\(\)=>DSCount\.open\(el\),0\);/.test(prep), 'a swipe onto a screen');
  assert.ok(/document\.body\.classList\.remove\('ingame'\);[\s\S]{0,300}DSCount\.open\(document\.body\)/.test(html),
    'back from a game');
});

test('countUp: ONLY the podium, the leaderboards and the wallet balances count up (Owen, 2026-10-16)', () => {
  const html = read('public/v2.html');
  const js = f => read('public/js/v2/' + f);
  const marks = s => (s.match(/data-cu(?!-)/g) || []).length;
  // The podium.
  assert.ok(/class="pmoney" data-cu="ev-prize"/.test(html), 'Events podium prize');
  // The leaderboards.
  assert.ok(/data-cu="soc-win" data-cu-rise/.test(js('social.js')), 'Global player winnings, drops shown as they are');
  assert.ok(/data-cu="lb-'/.test(js('leaders.js')), 'the top 10');
  assert.ok(/id="p-net" data-cu/.test(html), "a profile's total");
  // The wallet balances.
  assert.ok(/id="hdr-balance" data-cu/.test(html), 'main screen balance');
  assert.ok(/id="w-bal" data-cu/.test(js('wallet.js')), 'Wallet tab balance');
  // And nothing else: the strip, rungs, Play label, history rows, search and lobbies stay static.
  assert.strictEqual(marks(html), 3, 'v2.html marks the header balance, the podium prize and the profile total only');
  assert.strictEqual(marks(js('wallet.js')), 1, 'Wallet: the balance only, not the history rows');
  assert.strictEqual(marks(js('social.js')), 1, 'Social: Global player winnings only, not search results');
  assert.strictEqual(marks(js('leaders.js')), 1);
  for (const f of ['earnings.js', 'board.js', 'toasts.js'])   // shop.js went with the Shop tab (2026-10-16)
    assert.strictEqual(marks(js(f)), 0, f + ' stays static');
  assert.ok(!/DSCount/.test(js('earnings.js')), 'the strip and top cash-outs are static');
  assert.ok(!/function countUp|counted/.test(js('earnings.js')), 'and the strip has no counter of its own');
  assert.ok(!/requestAnimationFrame/.test(js('social.js')), 'nor does the winnings figure');
});

/* "$-1" for one frame (2026-10-16). A roll starts at performance.now() in the
   flush, but the frame that draws it is handed the frame's START time, which
   can be a few ms earlier. That negative progress went through the expo ease
   (1 - 2^(-10k) is below 0 for k < 0), so a roll up from $0 drew a figure
   below zero. Real roll, fake page: no frame may ever be negative or NaN. */
function page() {
  let mo = null, clock = 1000;
  const frames = [], micro = [];
  const el = {
    nodeType: 1, isConnected: true, id: '', style: {}, _attrs: { 'data-cu': 'w' },
    firstChild: null, textContent: '',
    getAttribute: k => (k in el._attrs ? el._attrs[k] : null), hasAttribute: k => k in el._attrs,
    closest: s => (s === '[data-cu]' ? el : null), matches: s => s === '[data-cu]',
    querySelectorAll: () => [], getClientRects: () => [1], getBoundingClientRect: () => ({ width: 40 }),
  };
  const node = { nodeType: 3, nextSibling: null, data: '' };
  el.firstChild = node;
  Object.defineProperty(el, 'textContent', { get: () => node.data, set: v => { node.data = v; } });
  const win = {
    document: { documentElement: {}, body: { classList: { contains: () => false } }, hidden: false },
    MutationObserver: function (cb) { mo = cb; this.observe = () => {}; this.takeRecords = () => []; },
    performance: { now: () => clock },
    queueMicrotask: f => micro.push(f),
    requestAnimationFrame: f => { frames.push(f); return frames.length; },
    getComputedStyle: () => ({ display: 'inline-block', boxSizing: 'border-box' }),
  };
  win.window = win;
  vm.runInNewContext(read('public/js/v2/countUp.js'), win);
  return {
    // The renderer writes the final figure; the observer sees it.
    render(txt) { node.data = txt; mo([{ target: el, addedNodes: [] }]); while (micro.length) micro.shift()(); },
    // A frame whose start time is `back` ms before the clock (rAF is given the frame's start).
    frame(back) { clock += 16; const q = frames.splice(0); q.forEach(f => f(clock - back)); return node.data; },
    shown: () => node.data,
  };
}

test('countUp: no frame is ever negative or NaN, even when the frame time is before the roll began', () => {
  for (const fin of ['$1', '$12.50', '$0.50', '$1,234.56', '$20 to 1st']) {
    for (const back of [0, 5, 15, 20, 40]) {
      const p = page();
      p.render(fin);
      const seen = [p.shown()];
      for (let i = 0; i < 120; i++) seen.push(p.frame(i === 0 ? back : 0));
      for (const s of seen) assert.ok(!/-|NaN|Infinity/.test(s), fin + ' (frame ' + back + ' ms early) drew ' + JSON.stringify(s));
      assert.strictEqual(seen[seen.length - 1], fin, 'and it lands on the renderer\'s own string');
    }
  }
});
