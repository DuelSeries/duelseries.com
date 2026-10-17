'use strict';
// public/js/cashoutSound.js: the one cash-out fanfare every game shares. With the shared sound engine on the page
// (DSSfx 'g.cashout') it starts that buffer on the caller's context; with no engine it plays the old synth.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'cashoutSound.js'), 'utf8');

function load(extra) {
  const win = Object.assign({}, extra);
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'cashoutSound.js' });
  return win;
}

// A fake Web Audio context that records the oscillators the old synth makes.
function fakeCtx() {
  const made = { osc: 0 };
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  return {
    made,
    currentTime: 1,
    createOscillator() { made.osc++; return { type: '', frequency: param(), connect() {}, start() {}, stop() {} }; },
    createGain() { return { gain: param(), connect() {} }; }
  };
}

test('cashoutSound: with the engine and g.cashout defined it plays that sound on the caller\'s context', () => {
  const calls = [];
  const DSSfx = { has: (n) => n === 'g.cashout', playIn: (...a) => { calls.push(a); return true; } };
  const win = load({ DSSfx });
  const ctx = fakeCtx();
  const dest = { dest: true };
  assert.strictEqual(win.CashoutSound.play(ctx, dest, 0.5), true);
  assert.deepStrictEqual(calls, [[ctx, dest, 'g.cashout', 0.5]]);
  assert.strictEqual(ctx.made.osc, 0, 'no synth');
  assert.strictEqual(win.CashoutSound.play(ctx, dest), true);
  assert.strictEqual(calls[1][3], 1, 'a missing volume is 1');
});

test('cashoutSound: the engine refusing (muted, hidden, held) stays silent; it does not fall back to the old synth', () => {
  const win = load({ DSSfx: { has: () => true, playIn: () => false } });
  const ctx = fakeCtx();
  assert.strictEqual(win.CashoutSound.play(ctx, {}, 1), false);
  assert.strictEqual(ctx.made.osc, 0);
});

test('cashoutSound: no engine, or one without g.cashout, or one that throws: the old synth, 3 + 4 + 1 oscillators', () => {
  for (const DSSfx of [undefined, { has: () => false, playIn() { throw new Error('never'); } },
    { has: () => true, playIn() { throw new Error('boom'); } }]) {
    const win = load(DSSfx ? { DSSfx } : {});
    const ctx = fakeCtx();
    assert.strictEqual(win.CashoutSound.play(ctx, {}, 0.5), true);
    assert.strictEqual(ctx.made.osc, 8);
  }
  const win = load({});
  assert.strictEqual(win.CashoutSound.play(null, {}), false);
  assert.strictEqual(win.CashoutSound.play(fakeCtx(), null), false);
  assert.strictEqual(win.CashoutSound.play.DURATION, 1.1);
});
