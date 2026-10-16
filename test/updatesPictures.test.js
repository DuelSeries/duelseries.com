'use strict';
/* Pictures in Updates posts and the Open lobbies list that shows every lobby (Owen 2026-10-16). Source checks; the
   layout was looked at headless at 1280x800 and 375x812. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const SRC = /^\/updates\/[a-z0-9][a-z0-9-]*\.(webp|png|jpe?g)$/;

test('updates.json: every picture is a small file in public/updates with words for it', () => {
  const { posts } = JSON.parse(read('public/updates.json'));
  let n = 0;
  for (const p of posts) {
    const all = (p.image ? [p.image] : []).concat(p.gallery || []);
    if (p.gallery) assert.ok(Array.isArray(p.gallery) && p.gallery.length <= 4, p.id + ': gallery is up to 4');
    for (const x of all) {
      n++;
      assert.match(x.src, SRC, p.id + ': ' + x.src);
      const f = path.join(ROOT, 'public', x.src);
      assert.ok(fs.existsSync(f), p.id + ': ' + x.src + ' exists');
      assert.ok(fs.statSync(f).size <= 200 * 1024, x.src + ' is under 200 KB');
      assert.ok(typeof x.alt === 'string' && x.alt.trim() && !/—/.test(x.alt), p.id + ': alt text, no em dashes');
    }
  }
  assert.ok(n >= 6, 'the current posts carry pictures');
});

test('updates.js: only our own picture files are drawn, and they open in a viewer', () => {
  const js = read('public/js/v2/updates.js');
  assert.ok(js.includes(String(SRC)), 'same src rule as this test');
  assert.match(js, /im\.loading = 'lazy'/);
  assert.match(js, /e\.key === 'Escape'\) close\(\)/);
  assert.match(read('public/v2.html'), /\.upveil\.on\{display:flex\}/);
});

test('Open lobbies: every lobby shows, no scroll box inside the page', () => {
  const html = read('public/v2.html');
  const rule = /\n\.lob\{([^}]*)\}/.exec(html);
  assert.ok(rule, '.lob rule');
  assert.ok(!/max-height|overflow/.test(rule[1]), '.lob grows: ' + rule[1]);
  assert.ok(!/\.lob::-webkit-scrollbar|#lob\{max-height/.test(html), 'no leftover scroller rules');
});
