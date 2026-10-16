/* The end of a tab swipe on a phone (2026-10-16). finish() used to hang its
   cleanup on the settle timer (settleTimer._done = done). A timer id is a
   number in a browser and swipe.js is strict, so that line threw a TypeError
   at the end of every tab swipe. Fixed in 4494762 (settleDone beside the
   timer); reproduced gone in headless Chrome at 375x812 with touch emulation.

   This drives one real tab drag through swipe.js in a sandbox whose timers
   return numbers like a browser's: touchstart, moves past a third of the
   screen, touchend, then the settle ends both ways (transitionend, and the
   safety timer). Nothing may throw, and the swipe lands on the next tab. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/js/v2/swipe.js'), 'utf8');

function fakeEl(id) {
  const on = {};
  const cls = new Set();
  const attrs = {};
  return {
    id, on, style: {}, scrollTop: 0,
    classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)),
                 contains: (c) => cls.has(c) },
    getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = String(v); },
    addEventListener: (t, f) => { on[t] = f; }, removeEventListener: (t) => { delete on[t]; },
    closest: () => null,
  };
}

function phone() {
  const home = fakeEl('home'), wallet = fakeEl('wallet-screen');
  const box = { console, route: 'play', docOn: {}, timers: [], frames: [], committed: [], errors: [] };
  box.window = box;
  box.innerWidth = 375;
  box.performance = { now: () => 0 };
  let nextId = 0;
  box.setTimeout = (f) => { box.timers.push(f); return ++nextId; };   // a number, like a browser
  box.clearTimeout = () => {};
  box.requestAnimationFrame = (f) => { box.frames.push(f); return ++nextId; };
  box.requestIdleCallback = () => ++nextId;
  box.addEventListener = () => {};
  box.getComputedStyle = () => ({ display: 'block', position: 'fixed' });   // phone: screens are panes
  box.screenShown = (e) => e === home;
  box.prepareScreen = (tab) => (tab === 'wallet' ? wallet : null);
  box.commitScreen = (tab) => box.committed.push(tab);
  box.putAway = () => {};
  box.document = {
    readyState: 'interactive', hidden: false, body: fakeEl('body'),
    addEventListener: (t, f) => { box.docOn[t] = f; },
    getElementById: (id) => (id === 'home' ? home : id === 'wallet-screen' ? wallet : null),
    querySelector: () => null,
  };
  vm.createContext(box);
  vm.runInContext(SRC, box, { filename: 'swipe.js' });
  const touch = (type, x, ts) => box.docOn[type]({
    touches: x == null ? [] : [{ clientX: x, clientY: 500 }], target: home, timeStamp: ts, preventDefault() {},
  });
  return { box, home, wallet, touch };
}

/* Finger from x=320 to x=100 (220px left, past a third of 375) on the Play tab. */
function swipeLeft(p) {
  p.touch('touchstart', 320, 1);
  for (let i = 1; i <= 10; i++) p.touch('touchmove', 320 - 22 * i, 1 + 16 * i);
  p.touch('touchend', null, 170);
  p.box.frames.splice(0).forEach((f) => f(170));
}

test('a tab swipe ends without throwing when the settle transition ends', () => {
  const p = phone();
  assert.doesNotThrow(() => {
    swipeLeft(p);
    p.wallet.on.transitionend({ propertyName: 'transform' });
  });
  assert.deepStrictEqual(p.box.committed, ['wallet'], 'it lands on the next tab, once');
  assert.ok(!p.box.document.body.classList.contains('scr-dragging'), 'and the drag is cleaned up');
});

test('a tab swipe ends without throwing when only the safety timer fires', () => {
  const p = phone();
  assert.doesNotThrow(() => {
    swipeLeft(p);
    p.box.timers.splice(0).forEach((f) => f());
  });
  assert.deepStrictEqual(p.box.committed, ['wallet']);
});

test('a touch during the settle finishes it at once, without throwing', () => {
  const p = phone();
  assert.doesNotThrow(() => {
    swipeLeft(p);
    p.touch('touchstart', 200, 200);       // next finger lands before the settle has ended
    p.touch('touchend', null, 220);
  });
  assert.deepStrictEqual(p.box.committed, ['wallet'], 'the running settle was completed by the new touch');
});
