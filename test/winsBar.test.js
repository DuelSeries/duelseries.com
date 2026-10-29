'use strict';
/* The home screen's wins bar (public/v2.html): samples hold still, and only a new real cash-out
   slides in (Owen 2026-10-28). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'v2.html'), 'utf8');
const between = (a, b) => { const i = html.indexOf(a); assert.ok(i >= 0, a); return html.slice(i, html.indexOf(b, i)); };

test('wins bar: the samples hold still; nothing moves it on a timer', () => {
  const draw = between('function drawTicker(){', '/* How many wins');
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame/.test(draw), 'drawing the row starts no motion');
  assert.ok(!/tkTimer/.test(html), 'the old every-2.6-second rotation is gone');
  assert.ok(/if\(wasReal&&WINS_REAL\)tkSlide\(tkNew\(was,WINS\)\); else drawTicker\(\);/.test(html),
    'only a new real win slides; the first real win and the samples are drawn still');
  assert.ok(/setInterval\(loadRealWins,20000\);/.test(html), 'real wins are asked for every 20 s');
  assert.ok(/const MIN_TICKER=NAMES\.length;/.test(html), 'every sample name once, no doubled row');
});

test('wins bar: how many real wins are new at the front', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(between('const tkKey=', '// The k newest'), ctx);
  const w = (who, amt) => ({ who, g: 'pool8', amt });
  const was = [w('a', 0.9), w('b', 1.8), w('c', 0.9), w('d', 0.9)];
  assert.strictEqual(ctx.tkNew(was, [w('x', 0.9), ...was]), 1);
  assert.strictEqual(ctx.tkNew(was, [w('x', 0.9), w('y', 1.8), ...was.slice(0, 3)]), 2, 'the oldest drop off the end');
  assert.strictEqual(ctx.tkNew(was, was.slice(1)), 0, 'nothing new at the front: redrawn still');
  assert.strictEqual(ctx.tkNew([], [w('x', 0.9)]), 0);
  assert.strictEqual(ctx.tkNew([w('a', 0.9), w('a', 0.9)], [w('a', 0.9), w('a', 0.9), w('a', 0.9)]), 1, 'the same win twice in a row');
});
