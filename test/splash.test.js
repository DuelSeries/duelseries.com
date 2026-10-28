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
  const built = body.indexOf('drawNav();V2Wallet.render();drawRail();drawTicker();loadRealWins();V2Board.start();\n</script>');
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

/* Written to hold for every saved option (splash-mockups/saved/), so swapping
   one in is a single command: the live one only draws and fades, the saved
   ones move and carry their own reduced-motion fallback. */
test('reduced motion still plays it, gently (Owen\'s PC reports reduced motion)', () => {
  const css = html.slice(html.indexOf('/* ── Loading screen'), html.indexOf('</style>', html.indexOf('/* ── Loading screen')))
    .replace(/\/\*[^]*?\*\//g, '');
  // The lobby flattens every animation with !important under reduced motion,
  // so each splash animation has to be !important to win.
  const anims = css.match(/animation:[^;}]+/g) || [];
  assert.ok(anims.length >= 2);
  for (const a of anims) assert.match(a, /!important$/, a);

  // Anything that moves (a transform in its keyframes) needs a reduced-motion
  // fallback that swaps it for keyframes that do not move, or hides it.
  const kf = Object.fromEntries([...css.matchAll(/@keyframes\s+([\w-]+)\{((?:[^{}]*\{[^}]*\})*)\}/g)].map(m => [m[1], m[2]]));
  const moving = Object.keys(kf).filter(k => /transform/.test(kf[k]));
  const uses = body => Object.keys(kf).filter(k => new RegExp('(^|[\\s,:])' + k + '(?=[\\s,!;]|$)').test(body));
  const at = css.indexOf('@media(prefers-reduced-motion:reduce){');
  let block = '';
  if (at >= 0) {
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) { block = css.slice(at, i + 1); break; }
    }
  }
  const rules = s => [...s.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].split(',').map(x => x.trim()), body: m[2] }));
  const reduced = rules(block.slice(block.indexOf('{') + 1));
  for (const r of reduced) for (const k of uses(r.body)) assert.ok(!moving.includes(k), 'reduced motion still uses ' + k);
  const normal = rules(css.replace(block, '').replace(/@keyframes\s+[\w-]+\{(?:[^{}]*\{[^}]*\})*\}/g, ''));
  for (const r of normal) {
    if (!uses(r.body).some(k => moving.includes(k))) continue;
    for (const sel of r.sel) {
      assert.ok(reduced.some(x => x.sel.includes(sel) && /animation:|display:none/.test(x.body)),
        sel + ' moves and has no reduced-motion fallback');
    }
  }
});

test('game pages have no splash: it is the lobby\'s only', () => {
  for (const f of fs.readdirSync(PUB).filter(f => f.endsWith('.html') && f !== 'v2.html')) {
    assert.doesNotMatch(fs.readFileSync(path.join(PUB, f), 'utf8'), /id="splash"/, f);
  }
});
