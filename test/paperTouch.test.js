'use strict';
// Paper arena touch steering (public/js/paper/mp/paperTouch.js): the snake game's anchored stick
// feeding the stock controller's mouse, and the heading arrow. The stock readInput turns
// controller.mouse (or, with no mouse, lastMouse) into game.direction as (point - view centre)
// normalised, so these tests read the steering the same way.
const test = require('node:test');
const assert = require('node:assert');
const Touch = require('../public/js/paper/mp/paperTouch.js');

function el(w, h) {
  return {
    clientWidth: w,
    clientHeight: h,
    listeners: {},
    style: {},
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  };
}

function setup({ heading = { x: 1, y: 0 } } = {}) {
  const view = el(400, 800);
  const pad = { mouse: null, lastMouse: null };
  const arrow = el(0, 0);
  const state = { heading };
  const touch = Touch.create({ view, controller: pad, heading: () => state.heading, arrow, ahead: () => 40 });
  function fire(type, changed, all) {
    let prevented = false;
    const evt = {
      changedTouches: changed,
      touches: all || [],
      preventDefault() { prevented = true; }
    };
    (view.listeners[type] || []).forEach((fn) => fn(evt));
    return prevented;
  }
  const t = (id, x, y, target) => ({ identifier: id, clientX: x, clientY: y, target: target || view });
  // What the stock readInput would steer at, as an angle in degrees.
  function steer() {
    const p = pad.mouse || pad.lastMouse;
    if (!p) return null;
    return Math.round((Math.atan2(p.y - 400, p.x - 200) * 180) / Math.PI);
  }
  return { view, pad, arrow, state, touch, fire, t, steer };
}

test('the stock controller is built blind to touches but keeps keyboard and mouse', () => {
  const view = el(10, 10);
  const blind = Touch.withoutTouch(view);
  const fn = () => {};
  ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'mousemove', 'mouseleave', 'contextmenu']
    .forEach((type) => blind.addEventListener(type, fn));
  assert.deepStrictEqual(Object.keys(view.listeners).sort(), ['contextmenu', 'mouseleave', 'mousemove']);
  blind.removeEventListener('mousemove', fn);
  assert.strictEqual(view.listeners.mousemove.length, 0);
});

test('a thumb landing asks for no turn: the square keeps its heading, wherever the thumb lands', () => {
  const s = setup({ heading: { x: 0, y: -1 } });
  assert.ok(s.fire('touchstart', [s.t(0, 350, 700)]), 'the touch is taken (no page scroll or mouse emulation)');
  assert.strictEqual(s.steer(), -90);
  s.fire('touchmove', [s.t(0, 356, 700)]); // 6 px: inside the dead zone
  assert.strictEqual(s.steer(), -90);
});

test('the heading is anchor to thumb, not screen centre to thumb', () => {
  const s = setup();
  s.fire('touchstart', [s.t(0, 350, 700)]);
  s.fire('touchmove', [s.t(0, 350, 730)]); // straight down from the anchor (and down-right of the view centre)
  assert.strictEqual(s.steer(), 90);
  s.fire('touchmove', [s.t(0, 320, 730)]); // down-left of the anchor
  assert.strictEqual(s.steer(), 135);
});

test('the anchor follows a long drag so the thumb never runs out of travel', () => {
  const s = setup();
  s.fire('touchstart', [s.t(0, 200, 400)]);
  s.fire('touchmove', [s.t(0, 400, 400)]); // 200 px right: anchor dragged to 60 px behind
  assert.deepStrictEqual(s.touch.anchor(), { x: 400 - Touch.FOLLOW_R, y: 400 });
  s.fire('touchmove', [s.t(0, 270, 400)]); // back 130 px: now 70 px left of the anchor
  assert.strictEqual(s.steer(), 180);
});

test('lifting the thumb carries on the way it was steering', () => {
  const s = setup();
  s.fire('touchstart', [s.t(0, 200, 400)]);
  s.fire('touchmove', [s.t(0, 200, 300)]);
  assert.strictEqual(s.steer(), -90);
  s.fire('touchend', [s.t(0, 200, 300)], []);
  assert.strictEqual(s.pad.mouse, null);
  assert.strictEqual(s.steer(), -90, 'lastMouse holds the heading');
  assert.strictEqual(s.touch.steering(), false);
});

test('a second finger on the canvas is not a second stick, and takes over when the first lifts', () => {
  const s = setup();
  const a = s.t(0, 100, 400);
  s.fire('touchstart', [a], [a]);
  s.fire('touchmove', [s.t(0, 100, 300)], [a]);
  const b = s.t(1, 300, 600);
  s.fire('touchstart', [b], [a, b]);
  s.fire('touchmove', [s.t(1, 380, 600)], [a, b]); // the second finger moving steers nothing
  assert.strictEqual(s.steer(), -90);
  s.state.heading = { x: 0, y: -1 }; // what readInput made of the first thumb
  s.fire('touchend', [s.t(0, 100, 300)], [s.t(1, 380, 600)]); // touches carry current positions
  assert.strictEqual(s.touch.steering(), true, 'the finger still down takes the stick');
  assert.strictEqual(s.steer(), -90, 'with a fresh anchor, so no jump');
  s.fire('touchmove', [s.t(1, 380, 640)], [b]);
  assert.strictEqual(s.steer(), 90);
});

test('a finger on the cash-out button never steers, before or after the steering thumb lifts', () => {
  const s = setup();
  const button = {};
  const hold = s.t(5, 50, 760, button);
  // The button's own touches never reach the canvas listeners; the canvas only sees them in
  // evt.touches while another finger is on it.
  const a = s.t(0, 200, 400);
  s.fire('touchstart', [a], [hold, a]);
  s.fire('touchmove', [s.t(0, 260, 400)], [hold, a]);
  assert.strictEqual(s.steer(), 0);
  s.fire('touchend', [s.t(0, 260, 400)], [hold]);
  assert.strictEqual(s.touch.steering(), false, 'the holding finger is not handed the wheel');
  assert.strictEqual(s.steer(), 0);
});

test('the arrow shows only while a thumb steers a live square, and writes its style only on change', () => {
  const s = setup({ heading: { x: 0, y: 1 } });
  s.touch.drawArrow(true);
  assert.notStrictEqual(s.arrow.style.opacity, '1', 'no thumb, no arrow');
  s.fire('touchstart', [s.t(0, 200, 400)]);
  s.touch.drawArrow(true);
  assert.strictEqual(s.arrow.style.opacity, '1');
  assert.strictEqual(s.arrow.style.transform,
    'translate(-50%, -50%) translate(200px, 400px) rotate(1.571rad) translateX(40px)');
  let writes = 0;
  const style = s.arrow.style;
  s.arrow.style = new Proxy(style, { set(o, k, v) { writes++; o[k] = v; return true; } });
  s.touch.drawArrow(true);
  s.touch.drawArrow(true);
  assert.strictEqual(writes, 0, 'a steady heading writes nothing');
  s.touch.drawArrow(false);
  assert.strictEqual(s.arrow.style.opacity, '0', 'dead or not live: hidden');
  s.touch.drawArrow(true);
  s.fire('touchend', [s.t(0, 200, 400)], []);
  s.touch.drawArrow(true);
  assert.strictEqual(s.arrow.style.opacity, '0', 'thumb lifted: hidden');
});

test('a steering touch whose end never arrived does not lock out the next thumb', () => {
  const s = setup();
  s.fire('touchstart', [s.t(0, 200, 400)], [s.t(0, 200, 400)]);
  const b = s.t(1, 200, 400);
  s.fire('touchstart', [b], [b]); // touch 0 is gone from the screen without a touchend
  s.fire('touchmove', [s.t(1, 200, 480)], [s.t(1, 200, 480)]);
  assert.strictEqual(s.steer(), 90);
});
