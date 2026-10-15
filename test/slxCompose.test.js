'use strict';
// slxCompose: the /sl page is public/sl.html with the layer tail inserted at serve time (SERVER-DESIGN 15.0; task
// T16). public/sl.html stays byte-identical (the parity gate reads its script list); the tail is built from the layer
// files on disk (server/sl/slBoot.js slxTail, T11) and goes in once, right before the single </body>, after slMain.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const B = require('../server/sl/slBoot');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/sl.html'), 'utf8');
const scripts = (html) => [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const links = (html) => [...html.matchAll(/<link rel="stylesheet" type="text\/css" href="([^"]+)" \/>/g)].map((m) => m[1]);

// slxPaid.js goes right after slxNet.js (PAID-SL-DESIGN 9): slxMain merges its handshake fields and asks it before the
// lobby's auto Play, so it must have run first.
test('SLX_TAIL: the slx.css link first, then slxNet, slxPaid, slxBr, slxWatch, slxMain, slxDirect, each a file under public/', () => {
  const tail = B.SLX_TAIL;
  assert.ok(tail.startsWith('<link rel="stylesheet" type="text/css" href="/css/slx.css" />\n'));
  assert.deepStrictEqual(links(tail), ['/css/slx.css']);
  const list = scripts(tail);
  assert.deepStrictEqual(list.slice(0, 6), ['/js/slx/slxNet.js', '/js/slx/slxPaid.js', '/js/slx/slxBr.js',
    '/js/slx/slxWatch.js', '/js/slx/slxMain.js', '/js/slx/slxDirect.js']);
  for (const src of links(tail).concat(list)) assert.ok(fs.existsSync(path.join(ROOT, 'public', src)), src);
  for (const src of list) assert.ok(/^\/js\/slx\/slx[A-Z]\w*\.js$/.test(src), src);
  assert.strictEqual(tail, B.slxTail(B.PUBLIC_DIR));
});

test('composePage: the frozen page plus the tail once, before </body>, after slMain.js; nothing else changes', () => {
  assert.ok(!HTML.includes('/js/slx/'), 'public/sl.html itself never names the layer');
  assert.ok(!HTML.includes('slx.css'));
  const page = B.composePage(HTML);
  const tail = B.SLX_TAIL;
  assert.strictEqual(page.length, HTML.length + tail.length);
  assert.strictEqual(page.split(tail).length, 2, 'the tail once');
  const at = page.indexOf(tail);
  assert.ok(at > page.indexOf('<script src="/js/sl/slMain.js"></script>'));
  assert.strictEqual(page.slice(at + tail.length, at + tail.length + 7), '</body>');
  assert.strictEqual(page.slice(0, at) + page.slice(at + tail.length), HTML);
  assert.deepStrictEqual(scripts(page), scripts(HTML).concat(scripts(tail)), 'their scripts first, in their order');
  assert.deepStrictEqual(links(page), links(HTML).concat(['/css/slx.css']), 'slx.css after their sl.css');
  assert.throws(() => B.composePage(page), /already mentions \/js\/slx\//, 'never composed twice');
});

test('the layer is never in the pinned client folder and the gate file names none of it', () => {
  const sl = fs.readdirSync(path.join(ROOT, 'public/js/sl'));
  assert.ok(!sl.some((f) => /^slx/.test(f)));
  const gate = fs.readFileSync(path.join(ROOT, 'test/slParityGate.test.js'), 'utf8');
  assert.ok(!/slx/.test(gate));
});
