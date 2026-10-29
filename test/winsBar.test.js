'use strict';
/* The home screen's wins bar (public/v2.html), Owen 2026-10-28: the last 50 wins, real cash-outs first and the
   same seeded samples filling the rest; it holds still, only a new real win slides in, and it scrolls by hand. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'v2.html'), 'utf8');
const between = (a, b) => { const i = html.indexOf(a); assert.ok(i >= 0, a); const j = html.indexOf(b, i); assert.ok(j > i, b); return html.slice(i, j); };

// The bar's own script, run against a small game registry: 2 ladder games, 1 paid duel, 1 free-only, 1 soon.
function bar() {
  const GAMES = [
    { id: 'snake', ladder: 1 }, { id: 'paper', ladder: 1 }, { id: 'pool8', duel: 1, paid: 1 },
    { id: 'tanks', duel: 1, freeOnly: 1 }, { id: 'stumble', soon: 1 },
  ];
  const ctx = { GAMES, G: (id) => GAMES.find((g) => g.id === id) };
  vm.createContext(ctx);
  vm.runInContext(between('let REAL_WINS=[];', 'let WINS=buildWins();') + 'let WINS=buildWins();'
    + between('function tkPill(i){', 'function tkPills(run){')
    + between('const tkKey=', '/* The k newest')
    + ';this.t={SAMPLES,buildWins,tkPill,tkNew,NAMES,set:(r)=>{REAL_WINS=r;WINS=buildWins();return WINS;}};', ctx);
  return ctx.t;
}

test('wins bar: 50 samples, the same on every load, only from games with a paid table', () => {
  const a = bar(), b = bar();
  assert.strictEqual(new Set(a.NAMES).size, a.NAMES.length, 'no repeated sample name');
  assert.strictEqual(a.SAMPLES.length, 50);
  assert.strictEqual(JSON.stringify(a.SAMPLES), JSON.stringify(b.SAMPLES), 'seeded: a reload shows the same row');
  assert.ok(!/Math\.random/.test(between('let REAL_WINS=[];', 'let WINS=buildWins();')), 'nothing random per load');
  for (const s of a.SAMPLES) {
    assert.strictEqual(s.sample, true);
    assert.ok(['snake', 'paper', 'pool8'].includes(s.g), s.g + ' has a paid table');
    if (s.g === 'pool8') assert.ok(s.amt === 0.9 || s.amt === 1.8, 'a duel pays $0.90 or $1.80');
    if (s.g === 'paper') assert.ok(Math.round(s.amt * 100) % 45 === 0 && s.amt >= 0.45 && s.amt <= 7.2, 'whole $0.45s');
    if (s.g === 'snake') assert.ok(s.amt >= 0.45 && s.amt <= 8.5);
  }
});

test('wins bar: real wins go in front, the last samples drop off, always 50', () => {
  const t = bar();
  const real = [{ who: 'MrPeanutK', g: 'snake', amt: 0.45 }, { who: 'neo', g: 'pool8', amt: 0.9 }];
  const w = t.set(real);
  assert.strictEqual(w.length, 50);
  assert.deepStrictEqual(w.slice(0, 2).map((x) => x.who), ['MrPeanutK', 'neo']);
  assert.strictEqual(JSON.stringify(w.slice(2)), JSON.stringify(t.SAMPLES.slice(0, 48)), 'the samples keep their order');
  assert.strictEqual(t.tkPill(0), '<span class="ltag"><span class="dot"></span>Live wins</span>', 'a real first card says Live');
  assert.strictEqual(t.tkPill(1), '');
  assert.strictEqual(t.tkPill(2), '<span class="ltag sample">Sample</span>', 'where the samples begin is marked');
  assert.strictEqual(t.tkPill(3), '');
  t.set([{ who: 'ghost', g: 'stumble', amt: 1 }]);
  assert.strictEqual(t.tkPill(0), '<span class="ltag sample">Sample wins</span>', 'a game not open yet never shows; all samples');
  const full = t.set(Array.from({ length: 60 }, (_, i) => ({ who: 'p' + i, g: 'paper', amt: 0.9 })));
  assert.strictEqual(full.length, 50);
  assert.ok(full.every((x) => !x.sample), '50 real wins: no samples left');
});

test('wins bar: how many wins are new at the front', () => {
  const t = bar();
  const was = t.set([]);
  const one = t.set([{ who: 'x', g: 'pool8', amt: 0.9 }]);
  assert.strictEqual(t.tkNew(was, one), 1, 'the first real win slides in over the samples');
  const two = t.set([{ who: 'y', g: 'snake', amt: 2.5 }, { who: 'x', g: 'pool8', amt: 0.9 }]);
  assert.strictEqual(t.tkNew(one, two), 1);
  const same = t.set([{ who: 'x', g: 'pool8', amt: 0.9 }, { who: 'x', g: 'pool8', amt: 0.9 }]);
  assert.strictEqual(t.tkNew(one, same), 1, 'the same win twice in a row');
  assert.strictEqual(t.tkNew(two, one), 0, 'nothing new at the front: redrawn still');
  assert.strictEqual(t.tkNew([], one), 0);
});

test('wins bar: still on load and reload; moves only for a new real win; scrolls by hand', () => {
  const draw = between('function drawTicker(){', '/* How many wins');
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame/.test(draw), 'drawing the row starts no motion');
  assert.ok(!/tkTimer/.test(html), 'no rotation timer');
  assert.ok(/if\(first\)drawTicker\(\); else tkSlide\(tkNew\(was,WINS\)\);/.test(html), 'the first answer after a load is drawn still');
  assert.ok(/setInterval\(loadRealWins,20000\);/.test(html));
  assert.ok(/\.tickerwrap\.top \.ticker\{overflow-x:auto;/.test(html), 'scrollable');
  assert.ok(/if\(box\.scrollLeft>4\)\{box\.scrollLeft\+=dx;return;\}/.test(html), 'a reader scrolled along keeps their place');
  const swipe = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'v2', 'swipe.js'), 'utf8');
  assert.ok(/const EXEMPT = '[^']*\.tickerwrap\.top \.ticker'/.test(swipe), 'a sideways swipe on it scrolls it, not the tabs');
});
