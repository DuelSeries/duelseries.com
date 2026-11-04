'use strict';
/* 8 Ball Pool's controls (Owen 2026-11-04): the power is the whole left side, a pull counted from where it went
   down, and nothing but that pull shoots. public/js/pool8/p8Controls.js holds the numbers; public/js/pool8.js the
   wiring, checked here by reading it. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../public/js/pool8/p8Controls.js');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the power strip is the whole left side under the top bar, the margin beside the frame included', () => {
  assert.ok(C.inPowerZone(55, 400), 'the slot itself');
  assert.ok(C.inPowerZone(-250, 400), 'the empty margin left of the frame on a sideways phone');
  assert.ok(C.inPowerZone(110, 700), 'the rail edge, low down');
  assert.ok(C.inPowerZone(40, 130), 'just under the top bar');
  assert.ok(!C.inPowerZone(40, 60), 'the top bar (the menu button) is not the strip');
  assert.ok(!C.inPowerZone(160, 400), 'the cushion and the cloth are not the strip');
  assert.ok(!C.inPowerZone(576, 455), 'the middle of the table is not the strip');
});

test('the pull counts from where it went down: a tap or a brush is no shot, a long pull is full power', () => {
  const full = C.fullFor(300, 768);
  assert.strictEqual(full, C.POWER.full, 'room to spare: the full pull');
  assert.strictEqual(C.powerOf(300, 300, full), 0, 'a tap');
  assert.ok(!C.shoots(C.powerOf(300, 300 + C.POWER.dead, full)), 'a brush inside the dead zone');
  assert.ok(!C.shoots(C.powerOf(300, 250, full)), 'up instead of down');
  assert.strictEqual(C.powerOf(300, 300 + full, full), 1, 'the full pull');
  assert.strictEqual(C.powerOf(300, 2000, full), 1, 'never past full');
  const half = C.powerOf(300, 300 + C.POWER.dead + (full - C.POWER.dead) / 2, full);
  assert.ok(Math.abs(half - 0.5) < 1e-9, 'half way is half power');
  // The same pull from anywhere in the strip is the same power: where the press lands sets nothing.
  assert.strictEqual(C.powerOf(150, 260, C.fullFor(150, 768)), C.powerOf(400, 510, C.fullFor(400, 768)));
});

test('a press low on the screen still reaches full power before the screen ends', () => {
  for (const y0 of [450, 520, 600]) {
    const full = C.fullFor(y0, 768);
    assert.ok(y0 + full <= 768 || full === C.POWER.minFull, 'full power fits on the screen from ' + y0);
    assert.strictEqual(C.powerOf(y0, y0 + full, full), 1);
  }
  assert.strictEqual(C.fullFor(740, 768), C.POWER.minFull, 'never a hair-trigger pull');
});

test('only the power pull shoots; aiming (right button, left drag, a finger on the table) never does', () => {
  const js = src('public/js/pool8.js');
  const shoots = js.match(/(?<!function )shoot\(\)/g) || [];
  assert.strictEqual(shoots.length, 1, 'one place calls shoot()');
  assert.ok(/d\.kind === 'power' && !cancel && myTurn\(\) && CT\.shoots\(aim\.p\)\) shoot\(\)/.test(js), 'and it is the end of a power pull');
  assert.ok(!/kind: 'pull'|kind: 'bar'/.test(js), 'the old mouse pull-back and the tap-to-set bar are gone');
  assert.ok(/e\.button === 2[\s\S]{0,200}kind: 'point'/.test(js), 'the right button aims');
  assert.ok(/addEventListener\('contextmenu', \(e\) => e\.preventDefault\(\)\)/.test(js), 'no browser menu on the table');
  assert.ok(/lostpointercapture/.test(js), 'a lost press is a cancel');
});

test('the shot message is the same as before: angle, power, spin, cue ball in hand and the called pocket', () => {
  const js = src('public/js/pool8.js');
  assert.ok(js.includes("const msg = { a: aim.a, p: aim.p, sx: aim.spin.x, sy: aim.spin.y };"));
  assert.ok(js.includes("if (rules.inHand) { msg.x = c.x; msg.y = c.y; }"));
  assert.ok(js.includes("socket.emit('p8:shot', msg);"));
});

test('the page loads the controls before the game', () => {
  const html = src('public/pool8.html');
  const a = html.indexOf('/js/pool8/p8Controls.js'), b = html.indexOf('/js/pool8.js');
  assert.ok(a > 0 && a < b);
});
