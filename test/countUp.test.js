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
  assert.ok(/el\.style\.display='block';\n[^\n]*\n  if\(window\.DSCount\)DSCount\.open\(el\);/.test(html), 'a swipe onto a screen');
  assert.ok(/document\.body\.classList\.remove\('ingame'\);[\s\S]{0,300}DSCount\.open\(document\.body\)/.test(html),
    'back from a game');
});

test('countUp: every lobby dollar figure is marked, and nothing keeps its own counter', () => {
  const html = read('public/v2.html');
  for (const re of [/id="hdr-balance" data-cu/, /id="ev-std" data-cu/, /class="pmoney" data-cu="ev-prize"/,
                    /id="p-net" data-cu/, /id="golabel" data-cu/, /lpaid" data-cu="dlob-/, /data-cu="stk-\$\{s\}"/])
    assert.ok(re.test(html), String(re));
  const js = f => read('public/js/v2/' + f);
  assert.ok(/id="w-bal" data-cu/.test(js('wallet.js')), 'Wallet balance');
  assert.ok(/data-cu="tx-'/.test(js('wallet.js')) && /data-cu="mv-'/.test(js('wallet.js')), 'Wallet history');
  assert.ok(/data-cu="soc-win" data-cu-rise/.test(js('social.js')), 'Global player winnings, drops shown as they are');
  assert.ok(/data-cu="q-'/.test(js('social.js')), 'search results');
  assert.ok(/data-cu="lb-'/.test(js('leaders.js')) && /DSCount\.open\(sheet\)/.test(js('leaders.js')), 'top earners and its sheet');
  assert.ok(/data-cu="earn-total"/.test(js('earnings.js')) && /data-cu="earn-best"/.test(js('earnings.js')) &&
            /DSCount\.open\(sheet\)/.test(js('earnings.js')), 'earnings strip, board and sheet');
  assert.ok(/data-cu="lob-'/.test(js('board.js')), 'open lobbies');
  assert.ok(!/function countUp|counted/.test(js('earnings.js')), 'the strip has no counter of its own');
  assert.ok(!/requestAnimationFrame/.test(js('social.js')), 'nor does the winnings figure');
});
