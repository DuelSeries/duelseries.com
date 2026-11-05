'use strict';
/* The legal pages, rewritten from the code on 2026-11-05 (Terms, Privacy, Responsible play). What a player reads has
   to stay true to what the site does, so the facts most likely to drift are held here next to the code they come
   from. Owen's open questions stay visible on the page as [Owen to confirm: ...] marks until he and a lawyer answer. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// What a player can read: the page less its comments and tags, spaces collapsed.
const shown = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const PAGES = ['public/terms.html', 'public/privacy.html', 'public/responsible-play.html'];

test('each legal page is dated, has no em dash, and shows its open questions as marks', () => {
  for (const f of PAGES) {
    const html = read(f);
    const t = shown(html);
    assert.match(t, /Draft, last updated [A-Z][a-z]+ \d{1,2}, 20\d\d/, f + ' says when it was last updated');
    assert.ok(!/—|&mdash;/.test(html), f + ' has an em dash');
    // every open question is a visible mark, and every mark is an open question for Owen
    const marks = html.match(/<mark class="todo">[\s\S]*?<\/mark>/g) || [];
    assert.ok(marks.length >= 1, f + ' lists its open questions');
    for (const m of marks) assert.match(m, /^<mark class="todo">\[Owen to confirm: [^\]]+\]<\/mark>$/, f + ': ' + m);
    assert.ok(!/<mark class="todo">\[(?!Owen to confirm)/.test(html), f + ' has an old-style blank');
  }
});

test('the terms match the money code: SOL shown in dollars, the ladder, 90/10, the duel split, no fee of ours', () => {
  const t = shown(read('public/terms.html'));
  assert.deepStrictEqual(require('../shared/stakeLadder').PAID_RUNGS, [0.5, 1]);
  assert.match(t, /fixed buy-ins of \$0\.50 or \$1\.00/);
  assert.match(t, /90% of your worth in that game to your wallet\. The other 10% is the house fee/);
  assert.strictEqual(require('../server/duelMoney').DUEL_HOUSE_CUT, 0.10);
  assert.match(t, /both buy-ins less a 10% house fee \(\$1\.80 from a \$1 duel\)/);
  assert.match(t, /Your money is held as SOL/);
  assert.match(t, /MoonPay/);
  assert.match(t, /Withdraw/);
  assert.ok(!/cash(?:ing)? out (?:to|your wallet)|Cash out (?:to|from) (?:your|a) wallet/i.test(t), 'wallet withdrawals are called Withdraw');
  assert.match(t, /You pay the Solana network fee from your wallet, and 0\.001 SOL always stays in your wallet/);
  // the reserve the widget keeps (wallet-widget/src/solReserve.mjs) is the 0.001 SOL the page names
  assert.match(read('wallet-widget/src/solReserve.mjs'), /0\.001/);
  assert.match(t, /goes back to your wallet in full, with no house fee/);
  assert.match(t, /within five minutes: it is refunded automatically/);
  assert.match(t, /Skins are final, so there are no refunds/);
});

test('the terms say plainly where computer players are and what they can do with money', () => {
  const t = shown(read('public/terms.html'));
  assert.match(t, /Free arenas .* have computer players in them\. They have ordinary player names, are not marked as bots, and the player counts in the lobby include them\./);
  assert.match(t, /Paid arenas .* can also have computer players in them/);
  assert.match(t, /Each one starts carrying the room's buy-in, paid from our own money/);
  assert.match(t, /They never cash out and are never paid/);
  assert.match(t, /the table shows "Bot opponent waiting" before you pay/);
  assert.match(t, /If it wins, we keep your buy-in\./);
  assert.match(t, /A computer player that wins is never paid a prize/);
});

test('the battle royale facts are the ones in shared/constants.js', () => {
  const C = require('../shared/constants');
  const t = shown(read('public/terms.html'));
  assert.strictEqual(C.BR_PRIZE_USDC, 20);
  assert.strictEqual(C.BR_EVERY_HOURS, 6);
  assert.strictEqual(C.BR_AUTOSTART_HOUR, 2);
  assert.match(t, /runs every six hours \(2 AM, 8 AM, 2 PM and 8 PM Eastern time\)/);
  assert.match(t, /wins \$20, paid to their wallet in SOL\./);
});

test('privacy names every outside service the code talks to, and responsible play promises no tool the site lacks', () => {
  const p = shown(read('public/privacy.html'));
  for (const s of ['Privy', 'MoonPay', 'Jupiter', 'Amazon Web Services', 'Helius', 'PostHog', 'ntfy', 'Google Fonts', 'YouTube, TikTok and X'])
    assert.ok(p.includes(s), 'privacy names ' + s);
  assert.match(p, /recordings of your session/);
  assert.match(p, /We do not save chat messages/);
  const r = shown(read('public/responsible-play.html'));
  assert.match(r, /does not have spending limits, time limits or a self-exclusion button yet/);
  assert.match(r, /You can lose money/);
  assert.match(r, /ConnexOntario/);
});
