'use strict';
/* The Clips and Updates tabs in the lobby (Owen 2026-10-16): PC only, above Settings, the phone's tab bar and swipe
   order untouched, and an Updates file the tab can always read. Source checks in the style of test/v2route.test.js;
   the layout itself was measured in the browser at 375x812, 853x480 (1280x720 at 1.5x), 1280x800 and 1920x1080. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

test('nav: Clips and Updates sit just above Settings, both marked PC only', () => {
  const html = read('public/v2.html');
  const nav = html.slice(html.indexOf('const NAV=['), html.indexOf('];', html.indexOf('const NAV=[')));
  const ids = [...nav.matchAll(/\{id:'([a-z]+)'/g)].map(m => m[1]);
  assert.deepStrictEqual(ids, ['play', 'wallet', 'events', 'social', 'clips', 'updates', 'settings']);   // no Shop since 2026-10-16
  assert.match(nav, /\{id:'clips',[^}]*pc:1/);
  assert.match(nav, /\{id:'updates',[^}]*pc:1/);
  assert.match(html, /\$\{n\.pc\?' pconly':''\}/, 'drawNav marks them');
  assert.match(html, /data-tab="\$\{n\.id\}"/, 'and names each button, for the dots');
});

test('PC only: hidden on a narrow or touch-only screen, and the router sends a stray visit home', () => {
  const html = read('public/v2.html');
  assert.match(html, /@media\(max-width:760px\),\(hover:none\) and \(pointer:coarse\)\{\n  \.ni\.pconly,#clips-screen,#updates-screen\{display:none!important\}/);
  assert.match(html, /const PHONEISH=matchMedia\('\(max-width:760px\),\(hover:none\) and \(pointer:coarse\)'\)/,
    'the router asks the same question the stylesheet does');
  assert.match(html, /function go\(id,dir\)\{\n  if\(PC_ONLY\.has\(id\)&&PHONEISH\.matches\)id='play';/);
  assert.match(read('public/js/v2/updates.js'), /matchMedia\('\(max-width:760px\),\(hover:none\) and \(pointer:coarse\)'\)/,
    'and a phone never fetches the posts');
});

test('the phone keeps its tab bar and swipe order', () => {
  const swipe = read('public/js/v2/swipe.js');
  assert.match(swipe, /const TABS = \['play', 'wallet', 'events', 'social', 'settings'\];/);
});

test('the router knows both screens, and each fills itself on arrival', () => {
  const html = read('public/v2.html');
  assert.match(html, /'player-screen',\s*'clips-screen','updates-screen'\];/);
  assert.match(html, /clips:'clips-screen',updates:'updates-screen'\}/);
  assert.match(html, /else if\(tab==='clips'&&window\.V2Clips\)V2Clips\.render\(\);/);
  assert.match(html, /else if\(tab==='updates'&&window\.V2Updates\)V2Updates\.render\(\);/);
  assert.match(html, /#clips-screen,#updates-screen\{display:none\}/, 'not showing until routed to');
  for (const id of ['clips-screen', 'updates-screen', 'cl-grid', 'cl-top', 'cl-queue', 'up-list', 'clveil', 'clbox',
                    'clsubveil', 'cl-form', 'cl-url', 'cl-cap', 'cl-games', 'cl-err', 'cl-send']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.ok(html.indexOf('<script src="/js/v2/toasts.js">') < html.indexOf('<script src="/js/v2/clips.js">'), 'toasts load first');
});

test('clips.js: player words are text, players are built from checked ids only', () => {
  const js = read('public/js/v2/clips.js');
  assert.ok(!/innerHTML/.test(js), 'nothing a player typed is ever markup');
  assert.match(js, /'https:\/\/www\.youtube-nocookie\.com\/embed\/' \+ encodeURIComponent\(c\.vid\)/);
  assert.match(js, /'https:\/\/www\.tiktok\.com\/player\/v1\/' \+ encodeURIComponent\(c\.vid\)/);
  assert.match(js, /rel = 'noopener noreferrer'/);
  for (const a of ["'clip:submit'", "'clips:queue'", "'clip:decide'"]) assert.ok(js.includes(a), a);
});

test('updates.json: valid, every post complete, newest first, ids never reused', () => {
  const j = JSON.parse(read('public/updates.json'));
  assert.ok(Array.isArray(j.posts) && j.posts.length >= 5);
  const ids = new Set();
  let prev = '9999-99-99';
  for (const p of j.posts) {
    assert.match(p.id, /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/, p.id);
    assert.ok(!ids.has(p.id), 'duplicate id ' + p.id);
    ids.add(p.id);
    assert.ok(p.id.startsWith(p.date), p.id + ' starts with its date');
    assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!Number.isNaN(Date.parse(p.date)), p.date);
    assert.ok(['new', 'fix', 'event', 'heads-up'].includes(p.tag), p.id + ' tag');
    assert.ok(p.title && p.title.length <= 80, p.id + ' title');
    assert.ok(p.body && p.body.length <= 600, p.id + ' body');
    assert.ok(!/—/.test(p.title + p.body), p.id + ': no em dashes');
    assert.ok(p.date <= prev, p.id + ' is in newest-first order');
    prev = p.date;
  }
});

test('Social is shown as Leaderboards, but keeps its id so the router, swipe order and old links still work', () => {
  const html = read('public/v2.html');
  assert.match(html, /\{id:'social', t:'Leaderboards',/);
  assert.ok(!/t:'Social'/.test(html), 'no tab is labelled Social any more');
  assert.match(html, /social:'social-screen'/, 'the route id is unchanged');
  assert.match(read('public/js/v2/swipe.js'), /'events', 'social', 'settings'/);
  assert.ok(!/"[^"]*\bSocial\b[^"]*"/.test(JSON.stringify(JSON.parse(read('public/updates.json')).posts.map(p => p.body))),
    'no update tells players to open Social');
});
