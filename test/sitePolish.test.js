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
  assert.ok(/addrRow\('w-addr', addr\)/.test(w) && /addrRow\('dep-addr'/.test(w), 'the Wallet tab and the Deposit sheet');
  assert.ok(/V2Wallet\.addrRow\('set-addr'/.test(v2()), 'and Settings');
  assert.ok(!/<code>' \+ esc\(addr\) \+ '<\/code>/.test(w), 'the full address is never printed');
  const css = v2().match(/\.waddr code\{[^}]*\}/)[0];
  assert.ok(/white-space:nowrap/.test(css), 'one line');
});

test('the wallet history pages with Show more and names game money as games', () => {
  const w = read('public/js/v2/wallet.js');
  assert.ok(/'&before=' \+ encodeURIComponent\(before\)/.test(w), 'asks for the next page by cursor');
  assert.ok(/id="w-more"/.test(w) && /more: more/.test(w), 'a Show more button');
  assert.ok(/'Game payout' : 'Game entry'/.test(w), 'escrow transfers are named as games');
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
