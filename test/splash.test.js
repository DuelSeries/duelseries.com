'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/* The lobby's loading screen (Owen's pick 1, "Draw on", 2026-10-26).
   It is only worth having if it is the first thing painted and if it can never
   stay up, so those are what these pin. */

const PUB = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'v2.html'), 'utf8').replace(/\r\n/g, '\n');
// From the real <body> tag: the head's comments mention "<body>" too.
const body = html.slice(html.indexOf('</head>\n<body>') + 8);

test('the splash is the first thing in <body>, styled inline in <head>', () => {
  assert.match(body, /^<body>\n<!-- Loading screen[^]*?-->\n<div id="splash"/);
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /<style>\n\/\* ── Loading screen[^]*#splash\{position:fixed/);
  // No stylesheet or script of its own: it has to paint with nothing loaded.
  const markup = body.slice(0, body.indexOf('</div>', body.indexOf('id="splash"')));
  assert.doesNotMatch(markup, /<link|<img|src=|href="\//);
});

test('no stylesheet in <head> can hold back its first paint', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  assert.doesNotMatch(head, /rel="stylesheet"/, 'head only preloads');
  assert.ok(head.includes('<link rel="preload" as="style" href="/css/join.css">'), 'join.css is preloaded');
  const splash = body.indexOf('<div id="splash"'), header = body.indexOf('<header>');
  for (const css of ['fonts.googleapis.com/css2', '/css/join.css']) {
    const at = body.indexOf(css);
    assert.ok(at > splash && at < header, css + ' applies after the splash, before any lobby markup');
  }
});

test('it removes itself once the lobby script has built the page', () => {
  const ready = body.indexOf('<script>window.dsSplashDone&&dsSplashDone()</script>');
  const built = body.indexOf('drawNav();V2Wallet.render();drawRail();drawTicker();V2Board.start();\n</script>');
  const widget = body.indexOf('<script src="/wallet/widget.js">');
  assert.ok(built > 0 && ready > built, 'ready signal comes right after the lobby script');
  assert.ok(ready < widget, 'and before the 5 MB wallet widget, so it never waits on it');
});

test('it can never stay up', () => {
  const s = body.slice(body.indexOf('<div id="splash"'), body.indexOf('</script>', body.indexOf('<div id="splash"')));
  assert.match(s, /addEventListener\('error',hide\)/, 'a script error removes it');
  assert.match(s, /addEventListener\('DOMContentLoaded',hide\)/, 'DOMContentLoaded removes it');
  assert.match(s, /setTimeout\(hide,30000\)/, '30 s is the hard ceiling');
  assert.match(s, /self!==top/, 'never inside a frame');
  assert.match(s, /el\.remove\(\)/, 'it leaves the DOM, not just goes transparent');
  assert.match(html, /<noscript><style>#splash\{display:none\}<\/style><\/noscript>/, 'no JS, no splash');
});

test('the only hold is a 400 ms floor, nothing artificial', () => {
  const s = body.slice(body.indexOf('<div id="splash"'), body.indexOf('</script>', body.indexOf('<div id="splash"')));
  assert.match(s, /Math\.max\(0,400-performance\.now\(\)\)/);
});

test('reduced motion still plays it (Owen\'s PC reports reduced motion)', () => {
  const css = html.slice(html.indexOf('/* ── Loading screen'), html.indexOf('</style>', html.indexOf('/* ── Loading screen')));
  // The lobby flattens every animation with !important under reduced motion,
  // so each splash animation has to be !important to win.
  const anims = css.match(/animation:[^;}]+/g);
  assert.ok(anims.length >= 6);
  for (const a of anims) assert.match(a, /!important$/, a);
  // Gentle by construction: stroke drawing and opacity, never a move or a zoom.
  assert.doesNotMatch(css, /transform|scale\(|translate/);
  assert.doesNotMatch(css, /prefers-reduced-motion/);
});

test('game pages have no splash: it is the lobby\'s only', () => {
  for (const f of fs.readdirSync(PUB).filter(f => f.endsWith('.html') && f !== 'v2.html')) {
    assert.doesNotMatch(fs.readFileSync(path.join(PUB, f), 'utf8'), /id="splash"/, f);
  }
});
