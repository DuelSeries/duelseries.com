'use strict';
/* The Join us tab in the lobby (Owen 2026-10-16, look 2 "Links"): PC only, above Settings, its links in one config
   spot that only takes https, every outside link in a new tab with rel="noopener noreferrer", and nothing that moves
   money. Source checks in the style of test/clipsUpdatesTabs.test.js, plus the page's own link builder run in a
   tiny fake DOM so the real code decides what a link becomes. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

test('nav: Join us sits just above Settings, PC only, and the router knows its screen', () => {
  const html = read('public/v2.html');
  const nav = html.slice(html.indexOf('const NAV=['), html.indexOf('];', html.indexOf('const NAV=[')));
  assert.match(nav, /\{id:'join',\s+t:'Join us',[^}]*pc:1/);
  assert.ok(nav.indexOf("{id:'join'") < nav.indexOf("{id:'settings'"), 'above Settings');
  assert.match(html, /const PC_ONLY=new Set\(\[[^\]]*'join'[^\]]*\]\);/, 'a phone is sent home');
  assert.match(html, /join:'join-screen'/);
  assert.match(html, /const SCREENS=\[[^\]]*'join-screen'/);
  assert.match(html, /else if\(tab==='join'&&window\.V2Join\)V2Join\.render\(\);/);
  assert.ok(html.includes('<main id="join-screen" class="wrap"></main>'));
  assert.ok(html.includes('<link rel="stylesheet" href="/css/join.css">'));
  assert.ok(html.indexOf('<script src="/js/v2/toasts.js">') < html.indexOf('<script src="/js/v2/join.js">'), 'toasts load first');
});

test('PC only: hidden until routed to, and never on a narrow or touch-only screen', () => {
  const css = read('public/css/join.css');
  assert.match(css, /^#join-screen\{display:none\}/m);
  assert.match(css, /@media\(max-width:760px\),\(hover:none\) and \(pointer:coarse\)\{#join-screen\{display:none!important\}\}/,
    'the same question v2.html asks for Clips and Updates');
  assert.match(read('public/js/v2/swipe.js'), /const TABS = \['play', 'wallet', 'events', 'social', 'settings'\];/,
    'the phone swipe order is untouched');
});

test('links: one config spot, all five there, empty until Owen sends them', () => {
  const js = read('public/js/v2/join.js');
  const m = js.match(/const LINKS = \{([\s\S]*?)\n  \};/);
  assert.ok(m, 'LINKS is there');
  for (const k of ['discord', 'whop', 'x', 'tiktok', 'youtube']) assert.match(m[1], new RegExp('\\b' + k + ': \'[^\']*\''), k);
  assert.ok(!/innerHTML/.test(js), 'everything is built as text and elements');
  assert.ok(!/—/.test(js), 'no em dashes');
  assert.ok(!/\$\s?\d/.test(js), 'no money figures: the clip team states no rate');
});

/* Run join.js's own link builder: a set https link becomes a new-tab link with noopener noreferrer, an unset or
   non-https one becomes a block that says Opening soon. */
function fakeDom() {
  const made = [];
  class Node {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.className = ''; this.textContent = ''; this.style = {}; this.classList = { add() {}, remove() {} }; made.push(this); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    appendChild(c) { this.children.push(c); return c; }
    append(...c) { this.children.push(...c); }
    replaceChildren(...c) { this.children = c; }
    addEventListener() {}
    remove() {}
    select() {}
  }
  const root = new Node('main');
  const document = {
    createElement: (t) => new Node(t), createElementNS: (_, t) => new Node(t),
    getElementById: (id) => (id === 'join-screen' ? root : null), body: new Node('body'),
  };
  return { root, made, document };
}
function runJoin(links) {
  let js = read('public/js/v2/join.js');
  js = js.replace(/const LINKS = \{[\s\S]*?\n  \};/, 'const LINKS = ' + JSON.stringify(links) + ';');
  const { root, made, document } = fakeDom();
  const win = {};
  vm.runInNewContext(js, { window: win, document, URL, fetch: () => new Promise(() => {}), navigator: {}, setTimeout, clearTimeout });
  win.V2Join.render();
  return { root, made };
}

test('a set https link opens in a new tab with noopener noreferrer; anything else stays Opening soon', () => {
  const { made } = runJoin({ discord: 'https://discord.gg/abc123', whop: 'http://whop.com/x', x: 'javascript:alert(1)', tiktok: '', youtube: 'https://www.youtube.com/@duelseries' });
  const links = made.filter(n => n.tagName === 'A' && n.href && !('data-support' in n.attrs));
  assert.deepStrictEqual(links.map(a => a.href).sort(), ['https://discord.gg/abc123', 'https://www.youtube.com/@duelseries']);
  for (const a of links) {
    assert.strictEqual(a.target, '_blank', a.href);
    assert.strictEqual(a.rel, 'noopener noreferrer', a.href);
  }
  const soon = made.filter(n => n.className.split(' ').includes('soon'));
  assert.strictEqual(soon.length, 3, 'whop (http), x (javascript:) and tiktok (empty) are not links');
  assert.ok(soon.every(n => n.tagName === 'DIV'), 'and not pressable');
  assert.ok(made.some(n => n.className === 'jn-soon' && n.textContent === 'Opening soon'), 'the row says so');
});

test('mail opens the Support panel for the DuelSeries inbox (never mailto:), the clip button goes to the Clips tab', () => {
  const { made } = runJoin({ discord: '', whop: '', x: '', tiktok: '', youtube: '' });
  const mails = made.filter(n => n.tagName === 'A' && 'data-support' in n.attrs);
  assert.strictEqual(mails.length, 3, 'Report a bug, Send an idea and the address line');
  for (const a of mails) {
    assert.match(a.href, /^https:\/\/mail\.google\.com\/mail\/\?view=cm&to=playduelseries@gmail\.com(&|$)/);
    assert.strictEqual(a.target, '_blank');
    assert.strictEqual(a.rel, 'noopener noreferrer');
  }
  const bug = mails.find(a => a.attrs['data-title'] === 'Report a bug');
  assert.ok(bug && bug.attrs['data-subject'] === 'Bug report' && /&su=Bug%20report&body=Which%20game/.test(bug.href), 'the bug form is prefilled');
  assert.ok(!made.some(n => String(n.href || '').startsWith('mailto:')), 'no mailto: left');
  assert.match(read('public/js/v2/join.js'), /'Share a clip', \(\) => window\.go && go\('clips'\)/);
});

test('the socials line names what is really there', () => {
  const line = (links) => runJoin(links).made.find(n => n.className === 'jn-soclbl').textContent;
  const none = { discord: '', whop: '', x: '', tiktok: '', youtube: '' };
  assert.strictEqual(line(none), 'Our X, TikTok and YouTube are opening soon.');
  assert.strictEqual(line({ ...none, x: 'https://x.com/duelseries' }), 'Follow DuelSeries on X. TikTok and YouTube are opening soon.');
  assert.strictEqual(line({ ...none, x: 'https://x.com/a', tiktok: 'https://www.tiktok.com/@a' }), 'Follow DuelSeries on X and TikTok. YouTube is opening soon.');
  assert.strictEqual(line({ ...none, x: 'https://x.com/a', tiktok: 'https://www.tiktok.com/@a', youtube: 'https://www.youtube.com/@a' }),
    'Follow DuelSeries on X, TikTok and YouTube.');
});
