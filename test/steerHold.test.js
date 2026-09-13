'use strict';
/* WHAT THE SNAKE DOES WHEN THE THUMB COMES OFF THE GLASS.

   Two places decide a heading: the one that moves the snake on this screen
   right now (local prediction) and the one that reaches the server, which is
   what actually moves it. They have to agree, and for a while they did not —
   the local one held the heading on release and the wire one fell through to
   the mouse, so the client drove straight while the server turned toward a
   stale touch point. The correction between them dragged the whole snake
   sideways. Owen: "I take my finger off the screen and the whole snake is just
   drifting."

   Lifted out of the real client rather than copied, the same way minimap and
   brVictory do it, so a copy cannot quietly stop describing the shipped code. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'game.js'), 'utf8');

/* The two heading decisions, as written. */
function wireBranch() {
  const at = SRC.indexOf('  const angle = lockedAngle !== null');
  assert.ok(at >= 0, 'the wire still picks an angle here');
  return SRC.slice(at, SRC.indexOf(';', SRC.indexOf('Math.atan2(', at)));
}
function localBranch() {
  const at = SRC.indexOf('    let targetAngle;');
  assert.ok(at >= 0, 'the local prediction still picks an angle here');
  return SRC.slice(at, SRC.indexOf('_lAdvance(', at));
}

test('the local prediction holds the heading when the thumb lifts', () => {
  assert.match(localBranch(), /touchHoldAngle !== null/,
    'local prediction has a hold branch');
});

test('and so does the angle that reaches the server', () => {
  /* THE BUG. Only one of the two had it, so they disagreed on every frame
     after a release and the server won — sideways. */
  assert.match(wireBranch(), /touchHoldAngle !== null/,
    'the wire has a hold branch too');
});

test('the hold is taken from the heading, not from where the finger was', () => {
  /* Steering at the pixel the thumb left would turn the snake toward it, which
     is a different bug wearing the same clothes. */
  const at = SRC.indexOf('function endTouch(');
  assert.ok(at >= 0);
  const fn = SRC.slice(at, SRC.indexOf('\n}', at));
  assert.match(fn, /touchHoldAngle\s*=\s*_lAngle/,
    'release records the angle the snake actually has');
  assert.ok(!/touchHoldAngle\s*=\s*touchAngle/.test(fn),
    'and never the angle to the last touch point');
});

test('a thumb back on the glass takes the wheel back', () => {
  /* Otherwise the hold sticks and the snake ignores steering entirely. */
  assert.match(SRC, /touchHoldAngle = null;\s*\/\/ the thumb is back/,
    'starting a touch clears the hold');
  assert.match(SRC, /mousemove.*touchHoldAngle = null/,
    'and so does a real mouse, for a laptop with a touchscreen');
});
