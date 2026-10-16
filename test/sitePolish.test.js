'use strict';
/* The site polish run (Owen, 2026-10-15), held in place by source checks in the
   style of test/v2route.test.js. The wallet's transaction paging itself is
   tested in test/walletHistory.test.js and the route in test/rpcRelay.test.js. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const v2 = () => read('public/v2.html');

test('the legal pages are DuelSeries\'s own drafts, and nothing is copied from another company', () => {
  for (const f of ['public/terms.html', 'public/privacy.html', 'public/responsible-play.html']) {
    const s = read(f);
    assert.ok(!/damnbruh/i.test(s), f + ' names no other company');
    assert.ok(/class="draft"/.test(s) && /not been reviewed by a lawyer/.test(s), f + ' says it is a draft for a lawyer');
    assert.ok(s.includes('/css/legal.css'), f + ' uses the site\'s own look');
  }
  assert.ok(/at least 21 years old/.test(read('public/terms.html')), 'Owen\'s minimum age');
});

test('Settings and the footer link to the legal pages and a real contact, no dead "#" links', () => {
  const html = v2();
  const settings = html.slice(html.indexOf('<main id="settings-screen"'), html.indexOf('</main>', html.indexOf('<main id="settings-screen"')));
  const footer = html.slice(html.indexOf('<footer>'), html.indexOf('</footer>'));
  for (const block of [settings, footer]) {
    for (const href of ['/terms.html', '/privacy.html', '/responsible-play.html', 'mailto:playduelseries@gmail.com'])
      assert.ok(block.includes('href="' + href + '"'), 'links ' + href);
  }
  assert.ok(!/href="#" onclick="return false"/.test(footer), 'the footer\'s dead links are gone');
  for (const f of ['public/terms.html', 'public/privacy.html', 'public/responsible-play.html'])
    assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' exists');
});

test('Withdraw never raises the phone keyboard on its own', () => {
  const w = read('public/js/v2/wallet.js');
  const cash = w.slice(w.indexOf('function cashOut()'), w.indexOf('function drawCash()'));
  const max = w.slice(w.indexOf('function max()'), w.indexOf('function say('));
  assert.ok(!/\.focus\(/.test(cash), 'opening Withdraw focuses nothing');
  assert.ok(!/\.focus\(/.test(max), 'nor does Max');
  assert.ok(!/autofocus/.test(w), 'and no field is autofocus');
});

test('the player\'s own address is shown short, on one line, with a Copy button, everywhere', () => {
  const w = read('public/js/v2/wallet.js');
  assert.ok(/a\.slice\(0, 4\) \+ '…' \+ a\.slice\(-4\)/.test(w), 'first and last four');
  assert.ok(/addrRow\('w-addr', addr\)/.test(w), 'the Wallet tab');
  // Add funds opens the payment options straight away: no second sheet repeating the address.
  assert.ok(/onclick="V2Wallet\.fund\(\)">Add funds<\/button>/.test(w) && !/depveil/.test(v2()), 'no Add funds sheet');
  assert.ok(/V2Wallet\.addrRow\('set-addr'/.test(v2()), 'and Settings');
  assert.ok(!/<code>' \+ esc\(addr\) \+ '<\/code>/.test(w), 'the full address is never printed');
  const css = v2().match(/\.waddr code\{[^}]*\}/)[0];
  assert.ok(/white-space:nowrap/.test(css), 'one line');
});

test('the wallet history scrolls inside its card and asks for the next page near the end', () => {
  const w = read('public/js/v2/wallet.js');
  assert.ok(/'&before=' \+ encodeURIComponent\(before\)/.test(w), 'asks for the next page by cursor');
  assert.ok(!/id="w-more"/.test(w) && !/Show more/.test(w), 'no Show more button');
  assert.ok(/id="w-tx" onscroll="V2Wallet\.txScroll\(\)"/.test(w), 'the scroll asks');
  assert.ok(/'Game payout' : 'Game entry'/.test(w), 'escrow transfers are named as games');
  // Five rows tall: every row one height, the card five of them.
  const css = v2();
  const rowH = +css.match(/\.txl\.sc \.tx\{height:(\d+)px/)[1];
  assert.strictEqual(+css.match(/\.txl\.sc\{max-height:(\d+)px/)[1], 5 * rowH);
  assert.ok(new RegExp('const ROW_H = ' + rowH + ';').test(w), 'the script knows the row height');
});

test('a balance tick never redraws the wallet screen, and the hidden screen asks the chain for nothing', () => {
  const w = read('public/js/v2/wallet.js');
  const on = w.slice(w.indexOf("window.addEventListener('duelwallet:change'"));
  assert.ok(/if \(!onScreen\(\)\) \{ drawnFor = null; return renderHeader\(\); \}/.test(on), 'off screen: header only');
  assert.ok(/render\(true\)/.test(on), 'on screen: the light redraw');
});

test('the battle royale shows it is the slither.io game, and its state survives on the label', () => {
  const html = v2();
  const foot = html.slice(html.indexOf('<div class="evfoot">'), html.indexOf('</main>', html.indexOf('<div class="evfoot">')));
  assert.ok(foot.includes('src="/img/games/snake.png"') && foot.includes('slither.io'), 'the slither.io art and name on Join');
  assert.ok(/getElementById\('ev-join-t'\)\|\|join\)\.textContent/.test(html), 'tick writes the label, not the button');
  assert.ok(/<h3 class="evname">Battle Royale<\/h3>/.test(html), 'one name for the event');
});

test('the Customize bar shows a big snake, and the phone backdrop zooms out like a PC\'s', () => {
  const html = v2();
  assert.ok(/mini:\{lenFrac:1\.6,hFrac:0\.96,headX:0\.86\}/.test(html), 'the front of the snake, big');
  assert.ok(/cfg && cfg\.headX \? w \* cfg\.headX/.test(read('public/js/v2/look.js')), 'look.js can pin the head');
  assert.ok(/function camOf\(cv\)/.test(html) && /const S=camOf\(cv\), z=S\/CAM;/.test(html), 'the backdrop scale follows the width');
  assert.ok(/\(wd\.cam\|\|CAM\)/.test(html), 'and the painter draws at the world\'s own scale');
});

test('Free Play wears the paid button\'s make in white', () => {
  const css = v2().match(/\.go\{position:relative[^}]*\}/)[0];
  assert.ok(/linear-gradient\(180deg,#ffffff/.test(css), 'a top-lit white');
  assert.ok(/inset 0 1px 0/.test(css) && /0 8px 24px -8px/.test(css), 'the same edges and glow as gold');
  assert.ok(/@keyframes gosheenw/.test(v2()), 'and its own sheen');
});

test('a locked skin is framed, not covered: the price sits under it and the dim leaves it clear', () => {
  /* Owen, 2026-10-15: the padlock and price sat dead centre on the paid skin,
     so he could not see what he would be buying. */
  const html = v2();
  assert.ok(/<div class="ap-case"><div class="ap-seal">/.test(html), 'the seal lives on the case');
  const seal = html.match(/\.ap-seal\{[^}]*\}/)[0];
  assert.ok(/bottom:0;transform:translate\(-50%,50%\)/.test(seal), 'on its bottom edge, below the skin');
  const scrim = html.match(/\.ap-scrim\{[^}]*\}/)[0].replace(/\s+/g, '');
  assert.ok(/mask-image:radial-gradient\(.*transparent72%,#000100%\)/.test(scrim),
    'the dim has a clear window over the middle skin');
});

test('the paid-out total is one currency: the old CAD part is turned into dollars, never added to them', () => {
  /* Owen, 2026-10-15: keep the tile, fix the number. cad_amount held CAD before
     the USDC cutover and the USDC amount itself after it (equal to amount). */
  const db = read('server/db.js');
  const split = db.slice(db.indexOf('async function getGlobalWinningsSplit('), db.indexOf('async function searchPlayerNames('));
  assert.ok(/FILTER \(WHERE cad_amount <> amount\)/.test(split) && /FILTER \(WHERE cad_amount = amount\)/.test(split),
    'split by what cad_amount was written in');
  const srv = read('server/index.js');
  const at = srv.indexOf("app.get('/api/stats/winnings'");
  const route = srv.slice(at, at + 900);
  assert.ok(/s\.usd \+ \(s\.cad \+ PRE_TRACKING_WINNINGS_CAD\) \/ rate/.test(route), 'CAD converted at the live rate');
  assert.ok(/let totalUsd = null;/.test(route), 'no rate, no number');
  assert.strictEqual(typeof require('../server/prices').getUsdCadRate, 'function');
  /* The lobby no longer shows this total at all (2026-10-16): it counts every payout, Owen's own test
     play included, so Social shows Global player winnings (/api/earnings/total, real players only) instead. */
  const soc = read('public/js/v2/social.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/fetch\('\/api\/stats\/winnings'/.test(soc) && /\/api\/earnings\/total/.test(soc),
    'the lobby shows real players\' winnings, not every payout');
});

test('the wallet keeps one payouts list: Transactions, with the graph under it', () => {
  const s = read('public/js/v2/stats.js');
  assert.ok(!/Recent payouts/.test(s.replace(/\/\*[\s\S]*?\*\//g, '')), 'no Recent payouts list');
  assert.ok(/V2EarningsChart\(el\('s-chart'\)/.test(s), 'the graph stays');
});

test('the Events countdown runs on: the live feed sends the second and the page counts from it', () => {
  const srv = read('server/index.js');
  const at = srv.indexOf('function liveBattleRoyale()');
  assert.ok(/etSec: second/.test(srv.slice(at, at + 2500)), '/api/live br carries the second');
  const en = srv.slice(srv.indexOf('function easternNow()'), srv.indexOf('function easternNow()') + 900);
  assert.strictEqual((en.match(/second: d\.getSeconds\(\)/g) || []).length, 2, 'the second comes from the same Date, both paths');
  // Without it each 3 s poll re-anchored at :00 and the clock stood still.
  assert.ok(/BR\.etMin\*60\+\(BR\.etSec\|\|0\)\+Math\.floor\(\(Date\.now\(\)-BRAT\)\/1000\)/.test(v2()), 'the page counts from the second');
});
