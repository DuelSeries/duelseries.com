'use strict';
/* Money moves as SOL soon, and the games count in DOLLARS in both modes (2026-10-21). What a player reads must be true
   in either mode: no "C$" or rate conversion anywhere a game shows money, no page that says USDC while the money is
   SOL, and the lobby's mode comes from the server rather than a hard-coded 'usdc'. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').split('\r\n').join('\n');
// What a player can read: the file less its comments.
const shown = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the games show plain dollars in both money modes: no C$, no rate', () => {
  for (const f of ['public/js/game.js', 'public/js/Renderer.js', 'public/js/v2/social.js']) {
    const s = shown(read(f));
    assert.ok(!/C\$/.test(s), f + ' still shows C$');
    assert.ok(!/solCadRate/.test(s), f + ' still converts by a rate');
    assert.ok(!/moneyMode/.test(s), f + ' still branches on the money mode');
  }
  assert.ok(/function fmtMoney\(v\) \{ v = Number\(v\) \|\| 0; return '\$' \+ v\.toFixed\(2\); \}/.test(read('public/js/game.js')));
  assert.ok(/const label = '\$' \+ \(Math\.round\(snake\.worth \* 100\) \/ 100\)\.toFixed\(2\);/.test(read('public/js/Renderer.js')));
});

test('the lobby learns the money mode from the server, and says SOL or USDC to match', () => {
  const v = read('public/v2.html');
  assert.ok(!/window\.moneyMode\s*=\s*'usdc'/.test(v), 'not hard-coded');
  assert.ok(/window\.moneyMode=null;\s*fetch\('\/api\/money-config'\)/.test(v), 'read from /api/money-config');
  // The skin sheet compares dollars with dollars in both modes (SOL mode: the balance field is the SOL's dollar value).
  const buy = v.slice(v.indexOf('function buyRows()'), v.indexOf('function openBuy('));
  assert.ok(/BUY\.short=bal!=null&&bal\+1e-9<price;/.test(buy), 'balance (dollars) against price (dollars)');
  assert.ok(/sol\?'':' USDC'/.test(buy) && /sol\?'Your balance':'Your USDC'/.test(buy), 'no USDC wording in SOL mode');
  assert.ok(/sol\?'Paid in SOL':'Paid in USDC'/.test(buy));
  // The page head is read by crawlers before any script runs: neutral, so true in both modes.
  assert.ok(!/content="[^"]*USDC/.test(v.slice(0, v.indexOf('</head>'))), 'no USDC in the page description');
  assert.ok(/id="cv-title">Convert to USDC</.test(v), 'the Convert sheet\'s title is set by wallet.js per direction');
});

test('the terms say entry fees and payouts are paid in SOL, with prices shown in dollars', () => {
  const t = shown(read('public/terms.html'));
  assert.ok(/Prices and amounts are shown in US dollars\. Entry fees and payouts are paid in SOL/.test(t.replace(/\s+/g, ' ')));
  assert.ok(/wins \$20, paid to their wallet in SOL\./.test(t.replace(/\s+/g, ' ')));
  assert.ok(!/Balances are in USDC/.test(t) && !/\$20 in USDC/.test(t));
  assert.ok(/at least 21 years old/.test(t), 'the rest of the page is intact');
});
