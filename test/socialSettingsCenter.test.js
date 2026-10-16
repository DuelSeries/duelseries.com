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

test('Global player winnings: the label, LIVE and the figure all sit on the panel\'s middle line', () => {
  const html = v2();
  assert.ok(/text-align:center/.test(rule(html, '#soc-win')), 'the panel centres its text');
  const top = rule(html, '.win-top');
  assert.ok(/justify-content:center/.test(top) && !/space-between/.test(top), 'label and LIVE are one centred line, not pushed to the two corners');
  assert.ok(/display:inline-block/.test(rule(html, '.win-vw')), 'the figure is its own centred box');
  const up = rule(html, '.win-up');
  assert.ok(/left:100%/.test(up) && !/right:18px/.test(up), 'the +$X hangs off the figure, not the panel corner');
  const js = read('public/js/v2/social.js');
  assert.ok(/<span class="win-vw"><span class="win-v num"><\/span><span class="win-up num"[^>]*><\/span><\/span>/.test(js),
    'and the +$X is drawn inside the figure\'s box');
});

test('Settings is one centred column: About directly under Account, the heading in the same column', () => {
  const html = v2();
  const both = rule(html, '#settings-screen>.head,.setgrid');
  assert.ok(/max-width:\d+px/.test(both) && /margin-left:auto/.test(both) && /margin-right:auto/.test(both),
    'heading and panels share one centred width');
  const grid = rule(html, '.setgrid');
  assert.ok(/grid-template-columns:minmax\(0,1fr\)/.test(grid) && !/auto-fit/.test(grid), 'one column at every width, never side by side');
  const s = html.slice(html.indexOf('<main id="settings-screen"'), html.indexOf('</main>', html.indexOf('<main id="settings-screen"')));
  assert.ok(s.indexOf('id="set-acct-h"') < s.indexOf('aria-label="About DuelSeries"'), 'Account first, About under it');
  for (const id of ['set-name', 'set-name-msg', 'set-acct', 'set-contact'])
    assert.ok(s.includes('id="' + id + '"'), id + ' is still there');
});
