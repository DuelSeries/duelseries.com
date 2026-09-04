'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');

/* ─── Every inline <script> in every page has to parse ────────────────────────
   `node --check` covers .js files, and most of this product's client code is
   not in one: v2.html alone carries thousands of lines of it, and owner.html is
   almost entirely inline.

   This exists because the owner console shipped broken. An edit put REAL
   newlines inside a string literal instead of \n escapes, the whole block
   failed to parse, and every line of the page's JavaScript stopped running —
   so it sat on its first line of static text with no gate, no panel and no
   error anybody could see. Nothing in the test suite or in node --check looked
   at it. Now something does. */

const pages = fs.readdirSync(PUB).filter(f => f.endsWith('.html'));

test('every page has at least one script to check', () => {
  assert.ok(pages.length > 0, 'there are pages in public/');
});

for (const page of pages) {
  test(page + ' — every inline script parses', () => {
    const html = fs.readFileSync(path.join(PUB, page), 'utf8');
    /* Only scripts with no src and no type (or an explicit JS type). A JSON or
       importmap block is not JavaScript and must not be parsed as it. */
    const blocks = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter(m => !/\ssrc\s*=/i.test(m[1]))
      .filter(m => {
        const type = (m[1].match(/type\s*=\s*["']([^"']+)["']/i) || [])[1];
        return !type || /javascript|module/i.test(type);
      })
      .map((m, i) => ({ i, code: m[2] }));

    for (const b of blocks) {
      try {
        new Function(b.code);
      } catch (e) {
        /* The line number inside the block is what actually helps, so work it
           out rather than just saying the file is broken. */
        const lines = b.code.split('\n');
        let where = '';
        for (let n = 1; n <= lines.length; n++) {
          try { new Function(lines.slice(0, n).join('\n')); }
          catch (err) {
            if (/Unexpected end of input/.test(err.message)) continue;
            where = ' near line ' + n + ' of the block: ' + JSON.stringify(lines[n - 1].slice(0, 80));
            break;
          }
        }
        assert.fail(page + ' inline script #' + b.i + ' does not parse — '
          + e.message + where);
      }
    }
  });
}
