'use strict';
/* server/socketRL.js is the per-socket rate limiter of server/index.js for a process that does not load index.js (the
   slither process of the server split, spec 6.1 and 14.1 #8). index.js keeps its own copy, so the two must never
   drift: the function text is the same, byte for byte (line endings aside), and the module's behaves as index.js's. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'server', f), 'utf8').replace(/\r\n/g, '\n');

// The text of `function socketRL(` ... its closing brace at the start of a line.
function fnText(src) {
  const at = src.indexOf('\nfunction socketRL(');
  assert.ok(at >= 0, 'has a top-level function socketRL');
  const end = src.indexOf('\n}\n', at);
  assert.ok(end > at);
  return src.slice(at + 1, end + 2);
}

test('server/socketRL.js has index.js\'s function socketRL, byte for byte', () => {
  const mine = fnText(read('socketRL.js'));
  assert.strictEqual(mine, fnText(read('index.js')));
  assert.match(mine, /^function socketRL\(socket, key, minMs\) \{\n/);
});

test('the exported limiter drops a second event inside the window, per socket and per key', () => {
  const { socketRL } = require('../server/socketRL');
  const a = {};
  const b = {};
  assert.strictEqual(socketRL(a, 'join', 60000), true);
  assert.strictEqual(socketRL(a, 'join', 60000), false, 'too soon');
  assert.strictEqual(socketRL(a, 'chat', 60000), true, 'another key');
  assert.strictEqual(socketRL(b, 'join', 60000), true, 'another socket');
  assert.strictEqual(socketRL(a, 'tick', 0), true);
  assert.strictEqual(socketRL(a, 'tick', 0), true, 'a zero window never drops');
});
