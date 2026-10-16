'use strict';
/* The Wallet tab, Owen's three changes (2026-10-15):

   1. "Deposit" is "Add funds" everywhere on it. "Withdraw" stays Withdraw: he chose that over
      "Cash out", which already means leaving a game with your winnings.
   2. Transactions shows five rows and scrolls inside its card (sitePolish.test.js checks the
      scroll and the row height).
   3. "Recent payouts" is gone; in its place "Add funds and Withdrawals", the player's own money in
      and out, each with the other wallet's address short and a copy button, read off the chain
      by /api/my-transfers (walletHistory.test.js and rpcRelay.test.js check the server). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// What a player can read: the file less its comments.
const shown = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('"Add funds", never "Deposit", on the Wallet tab', () => {
  const w = shown(read('public/js/v2/wallet.js'));
  const v = shown(read('public/v2.html'));
  // It opens the payment options straight away (site polish 3 dropped our own sheet).
  assert.ok(/fund\(\)">Add funds<\/button>/.test(w), 'the button');
  assert.ok(/d:'Add funds, withdrawals and your transaction history\.'/.test(v), 'the tab\'s own line');
  for (const [name, src] of [['wallet.js', w], ['v2.html', v]])
    assert.ok(!/\bDeposit/.test(src), name + ' still says Deposit somewhere a player sees it');
  assert.ok(/: \(inb \? 'Add funds' : 'Withdraw'\);/.test(w), 'a transaction row uses the buttons\' words');
  // An Add funds and Withdrawals row names USDC and SOL the same way (moveParts, 2026-10-15).
  assert.ok((w.match(/name: inb \? 'Add funds' : 'Withdraw'/g) || []).length >= 2, 'and so does an Add funds and Withdrawals row');
  assert.ok(/<span class="txn">' \+ esc\(p\.name\) \+ '<\/span>'/.test(w), 'the row shows that name');
});

test('Withdraw stays Withdraw (Owen\'s pick); "Cash out" is the game\'s word', () => {
  const w = shown(read('public/js/v2/wallet.js'));
  assert.ok(/cashOut\(\)">Withdraw<\/button>/.test(w), 'the button');
  assert.ok(/submitCash\(\)">Withdraw<\/button>/.test(w), 'the sheet\'s button');
  assert.ok(/aria-label="Withdraw"/.test(shown(read('public/v2.html'))), 'the sheet');
  assert.ok(!/Cash out/i.test(w), 'the wallet never says Cash out');
});

test('Recent payouts is gone; Add funds and Withdrawals is in its place, under the earnings chart', () => {
  const s = read('public/js/v2/stats.js');
  assert.ok(!/Recent payouts/.test(shown(s)), 'no Recent payouts');
  assert.ok(/'<div class="panel chartbox" id="s-chart"><\/div>'/.test(s), 'the chart is untouched');
  assert.ok(/window\.V2EarningsChart\(el\('s-chart'\), games, p\.joinedAt, money\)/.test(s), 'and drawn the same way');
  const v = read('public/v2.html');
  const earn = v.indexOf('<div id="w-earn" hidden>'), moves = v.indexOf('<div id="w-moves"></div>');
  const end = v.indexOf('</main>', earn);
  assert.ok(earn > 0 && moves > earn && moves < end, 'after Earnings, on the Wallet tab');
  const w = read('public/js/v2/wallet.js');
  assert.ok(/<h2>Add funds and Withdrawals<\/h2>/.test(w), 'its heading');
  assert.ok(/fetch\('\/api\/my-transfers\?wallet=' \+ encodeURIComponent\(a\)\)/.test(w), 'read from the server');
});

test('each add funds row: the other wallet short, a copy button for all of it, nothing unescaped', () => {
  const w = read('public/js/v2/wallet.js');
  const row = w.slice(w.indexOf('function moveRow(t)'), w.indexOf('async function loadMoves('));
  // Only an address is ever printed or copied; anything else from the server shows no address row.
  assert.ok(/typeof t\.peer === 'string' && SOL_ADDR\.test\(t\.peer\) \? t\.peer : ''/.test(row));
  assert.ok(/esc\(ownShort\(peer\)\)/.test(row), 'first and last four');
  assert.ok(/data-a="' \+ esc\(peer\) \+ '"/.test(row), 'the copy button holds the whole address');
  assert.ok(/esc\(t\.signature\)/.test(row), 'the explorer link is escaped');
  assert.ok(/(inb \? 'from ' : 'to ')/.test(row), 'says which way the money went');
  assert.ok(/whenAt\(t\.at\)/.test(row), 'a date and a time');
  assert.ok(/hour: 'numeric', minute: '2-digit'/.test(w), 'the time is in it');
  const copy = w.slice(w.indexOf('function copyPeer(btn)'), w.indexOf('function copyPeer(btn)') + 1200);
  assert.ok(/navigator\.clipboard\.writeText\(a\)/.test(copy), 'copies the whole address');
});

test('a long history keeps asking while the server says it stopped short, and stops', () => {
  const w = read('public/js/v2/wallet.js');
  const load = w.slice(w.indexOf('async function loadMoves('), w.indexOf('function mvScroll()'));
  assert.ok(/const going = !page\.complete && again < 40;/.test(load), 'asks again, at most forty times');
  assert.ok(/setTimeout\(\(\) => \{ if \(gen === mvGen\) loadMoves\(again \+ 1, gen\); \}, 600\)/.test(load), 'paced, and only while it is the current load');
  assert.ok(/if \(!box \|\| gen !== mvGen \|\| w\(\)\.address !== a\) return;/.test(load), 'a newer load or another wallet is not overdrawn');
  // Signed out, the list of the wallet that left is cleared and its next ask cancelled.
  assert.ok(/function clearMoves\(\) \{\s*mvGen\+\+; clearTimeout\(mvTimer\);/.test(w));
});

test('both lists scroll up and down only: no row sticks out sideways, the list clips and passes sideways drags on', () => {
  const v = read('public/v2.html');
  const rule = (sel) => { const m = v.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}')); return m ? m[1] : ''; };
  const row = rule('.txl.sc .tx');
  assert.ok(row && !/margin:[^;]*-/.test(row), 'a row has no negative margin: ' + row);
  const list = rule('.txl.sc');
  assert.ok(/overflow-x:hidden/.test(list), 'the list clips sideways');
  assert.ok(/overscroll-behavior-x:none/.test(list), 'and never rubber-bands sideways');
  assert.ok(/touch-action:pan-y/.test(list), 'a sideways drag is not the list\'s');
  assert.ok(/text-overflow:ellipsis/.test(rule('.txl.sc .txn,.txl.sc .txd')), 'long text ends in an ellipsis');
});

test('a refresh mid-page never appends the old list\'s page to the new one', () => {
  const w = read('public/js/v2/wallet.js');
  const load = w.slice(w.indexOf('async function loadTx()'), w.indexOf('async function more()'));
  const more = w.slice(w.indexOf('async function more()'), w.indexOf('function fill()'));
  assert.ok(/const gen = \+\+txGen;[\s\S]*if \(gen !== txGen\) return;/.test(load));
  assert.ok(/const gen = txGen;[\s\S]*if \(gen !== txGen\) return;/.test(more));
});

/* SOL arriving opens the Convert sheet by itself (Owen, 2026-10-15: one tap, not zero, not a
   hunt for the button). It only opens the sheet: the one call that signs, duelWalletSwapRun, is
   reached from the sheet's Convert and Withdraw's Send it, never from the offer. It waits out a
   running game, another sheet, Privy's window and a hidden page, and keeps a no per wallet. */
test('the Convert sheet offers itself for SOL, and never signs on its own', () => {
  const w = shown(read('public/js/v2/wallet.js'));
  const offer = w.slice(w.indexOf('function offerConvert()'), w.indexOf('function offerConvert()') + 900);
  assert.ok(/if \(inGame\(\) \|\| busyScreen\(\)\) return;\s*convert\(\);/.test(offer), 'waits for the lobby, then only opens the sheet');
  assert.ok(/if \(no && c < no \+ step\) return;/.test(offer), 'a no holds until more SOL arrives');
  assert.ok(/'game-frame', 'agar-frame'/.test(w) && /privy-modal-content/.test(w) && /visibilityState === 'hidden'/.test(w));
  const runs = [...w.matchAll(/window\.duelWalletSwapRun\(/g)].map((m) => {
    const before = w.slice(0, m.index);
    return before.slice(before.lastIndexOf('function ') + 9).split('(')[0];
  });
  assert.deepStrictEqual(runs.sort(), ['confirmConvert', 'confirmSol'], 'signed only from a tap: ' + runs);
  assert.ok(/e\.origin !== window\.location\.origin/.test(w) && /e\.source !== f\.contentWindow/.test(w), 'the game\'s end is heard from our own frames only');
});
