'use strict';
/* Social's winnings figure and the Settings column, centred (Owen, 2026-10-16).
   Source checks in the style of test/v2route.test.js; the layout itself was
   measured in headless Chrome at 375x812, 1280x720 @1.5 and 1920x1080. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const v2 = () => read('public/v2.html');
const rule = (css, sel) => {
  const m = css.match(new RegExp('(^|[}\\n])' + sel.replace(/[.*+?^${}()|[\]\\#>]/g, '\\$&') + '\\{([^}]*)\\}'));
  return m ? m[2] : '';
};

test('Player winnings (layout 1, site redo 2026-11-01): label and Live on one line, the figure under it, the +$X over the figure', () => {
  /* Was centred on the panel (Owen, 2026-10-16); the redo's layout 1 mockup (site-redo/looks/ab/1/leaderboards.html)
     sets it left, the period control at the right, like every other panel on the kit. */
  const html = v2();
  const hd = rule(html, '.lb-sum-hd');
  assert.ok(/display:flex/.test(hd) && /align-items:center/.test(hd), 'the label, Live and the update line are one line');
  assert.ok(/display:inline-block/.test(rule(html, '.win-vw')), 'the figure is its own box');
  const up = rule(html, '.win-up');
  assert.ok(/position:absolute/.test(up) && /bottom:100%/.test(up) && !/right:18px/.test(up), 'the +$X hangs off the figure, not the panel corner');
  const js = read('public/js/v2/social.js');
  assert.ok(/<span class="win-vw"><b class="win-v num"[^>]*><\/b><span class="win-up num"[^>]*><\/span><\/span>/.test(js),
    'and the +$X is drawn inside the figure\'s box');
});

test('Settings (layout 1, site redo 2026-11-01): the Wallet\'s two columns, account left, preferences and About right', () => {
  /* Was one centred 560px column (Owen, 2026-10-16); the redo's layout 1 mockup (site-redo/looks/ab/1/settings.html)
     gives Settings the Wallet's own columns, so the page width no longer jumps between the two tabs (stage 3 audit). */
  const html = v2();
  const grid = rule(html, '.setgrid');
  assert.ok(/grid-template-columns:minmax\(0,400px\) minmax\(0,1fr\)/.test(grid) && /max-width:1180px/.test(grid), 'the Wallet\'s 400px and the rest, 1180px at most');
  assert.ok(/\.wgrid2\{max-width:1180px\}/.test(html) && /grid-template-columns:minmax\(0,400px\) minmax\(0,1fr\)/.test(rule(html, '.wgrid2.in')), 'the same as the Wallet');
  const s = html.slice(html.indexOf('<main id="settings-screen"'), html.indexOf('</main>', html.indexOf('<main id="settings-screen"')));
  assert.ok(s.indexOf('id="set-acct-h"') < s.indexOf('aria-label="Preferences"') && s.indexOf('aria-label="Preferences"') < s.indexOf('aria-label="About DuelSeries"'), 'Account, then the preferences, then About');
  for (const id of ['set-acct', 'set-contact', 'set-snd', 'set-vol', 'set-hov', 'set-gfx', 'set-clips', 'set-mic', 'set-tab'])
    assert.ok(s.includes('id="' + id + '"'), id + ' is still there');
  // The name is changed only in the header card (Owen): Settings opens that card instead of keeping a field of its own.
  assert.ok(!s.includes('id="set-name"') && /V2Me\.open\(\)/.test(html.slice(html.indexOf('function setCard('), html.indexOf('function setCard(') + 300)), 'no second name field');
});
