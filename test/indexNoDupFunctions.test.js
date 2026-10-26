'use strict';
/* server/index.js must never declare the same top-level function twice.

   A function declaration is hoisted, so a second `function x()` silently
   replaces the first for the whole file, including every call written above
   it. That is exactly how a merge of two branches once turned the owner check
   (ownerAuthOf, async, null for strangers) into a helper that always returned
   an object: every request became the owner. Each branch was correct alone. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('server/index.js declares each top-level function once', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
  const seen = new Map();
  const dups = [];
  src.split('\n').forEach((line, i) => {
    const m = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (!m) return;
    if (seen.has(m[1])) dups.push(m[1] + ' at lines ' + seen.get(m[1]) + ' and ' + (i + 1));
    else seen.set(m[1], i + 1);
  });
  assert.deepStrictEqual(dups, []);
});

test('a sign-in, identify or skins signature is never owner auth on its own', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
  const fn = src.slice(src.indexOf('function ownerFromSignature(body) {'), src.indexOf('function ownerFromSignature(body) {') + 300);
  assert.match(src, /const NOT_OWNER_AUTH = \/\^\(owner:session:\|play:\|skins:\|clips:\)\/;/);
  assert.match(fn, /NOT_OWNER_AUTH\.test\(body\.action\)\) return null;/);
});
