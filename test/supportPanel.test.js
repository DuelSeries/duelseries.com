'use strict';
/* Support (Owen 2026-10-27): every "write to us" link opens public/js/v2/support.js's panel (the address with
   Copy, Open in Gmail, the Discord) instead of mailto:, which on a PC with no mail app pops up Windows'
   "Select an app to open this link" and looked like a scam. Source checks plus the panel's own URL builder. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(html|js|json)$/.test(e.name)) out.push(rel);
  }
  return out;
}

test('no mailto: link is left anywhere the site serves', () => {
  for (const f of walk('public')) {
    if (f.startsWith('public/wallet/')) continue;   // the built wallet widget (Privy's own bundle)
    assert.ok(!/mailto:['"A-Za-z$]/.test(read(f)), f + ' builds a mailto: link');
  }
});

test('every page with a contact link loads the panel', () => {
  for (const f of ['public/v2.html', 'public/terms.html', 'public/privacy.html']) {
    const html = read(f);
    assert.ok(/<script src="\/js\/v2\/support\.js"( defer)?><\/script>/.test(html), f + ' loads support.js');
    const links = html.match(/<a [^>]*data-support[^>]*>/g) || [];
    assert.ok(links.length >= 1, f + ' has a support link');
    for (const a of links) {
      assert.ok(a.includes('href="https://mail.google.com/mail/?view=cm&amp;to=playduelseries@gmail.com"'), a);
      assert.ok(a.includes('target="_blank" rel="noopener noreferrer"'), a);
    }
  }
  const html = read('public/v2.html');
  const side = html.slice(html.indexOf('function drawNav(){'), html.indexOf('const V2Side='));
  assert.match(side, /<a class="sb-it sbx" href="https:\/\/mail\.google\.com[^"]*" target="_blank" rel="noopener noreferrer" data-support>\$\{SBI\(SB_P\.support\)\}<span>Support<\/span><\/a>/,
    'the PC sidebar Support row');
  assert.ok(html.includes('<a class="slink" id="set-contact" href="https://mail.google.com'), 'Settings Contact (phone too)');
});

test('the panel: the address, Copy, Open in Gmail and the Discord from join.js', () => {
  const js = read('public/js/v2/support.js');
  const discord = read('public/js/v2/join.js').match(/discord: '([^']+)'/)[1];
  assert.ok(js.includes("var DISCORD = '" + discord + "';"), 'the same Discord invite as Join us');
  assert.ok(js.includes('Open in Gmail') && js.includes('Ask on Discord') && js.includes('>Copy</span>'));
  assert.match(js, /DSToast\.show\(\{ kind: 'ok', title: 'Email copied'/, 'the copy toast goes through DSToast');
  assert.ok(!/—/.test(js), 'no em dashes');

  const listeners = [];
  const win = {};
  vm.runInNewContext(js, { window: win, document: { addEventListener: (t, f) => listeners.push(t) }, setTimeout, clearTimeout });
  assert.deepStrictEqual(listeners, ['click'], 'one delegated click listener');
  assert.strictEqual(win.DSSupport.gmail(), 'https://mail.google.com/mail/?view=cm&to=playduelseries@gmail.com');
  assert.strictEqual(win.DSSupport.gmail('Bug report', 'Which game:\n'),
    'https://mail.google.com/mail/?view=cm&to=playduelseries@gmail.com&su=Bug%20report&body=Which%20game%3A%0A');
});
