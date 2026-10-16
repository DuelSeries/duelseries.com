'use strict';
// Free rooms full of bots that are already playing before anybody comes (Owen 2026-10-16: "when I spawn in there, the
// bots should already be there, they should already be playing like they normally do"), as slither.io's free room has
// been since f83c2d2 (slArenas keepAwake): agar.io's free room #0 (agArenas keepAwake, agRoom setAwake) and Paper.io's
// free arena #1 (PaperArenas keepAwake, PaperRoom setAwake). Paid rooms stay people-only (Owen's pick the same day):
// both refuse to wake. And Paper's Spectate on Free with nobody playing now watches the awake arena's bots.
const test = require('node:test');
const assert = require('node:assert');
const { AgArenas } = require('../server/ag/agArenas');
const { PaperArenas } = require('../server/paper/PaperArenas');

const quiet = { log() {}, warn() {}, error() {} };
const noopHooks = new Proxy({}, { get: () => () => {} });

test('agar.io: keepAwake wakes the free room #0 only; it keeps ticking with nobody seated; a paid room refuses', () => {
  const arenas = new AgArenas({ region: 'na', autoTick: false, log: quiet });
  const free = arenas.rooms[0];
  assert.strictEqual(free.awake, false, 'asleep until the server asks');
  assert.strictEqual(arenas.keepAwake(), true);
  assert.strictEqual(free.awake, true);
  assert.ok(free.bots.size > 0, 'its bots are there from construction');
  // the timer re-arms with no seat and no account (the free room's bots keep playing)
  let armed = 0;
  free._arm = () => { armed++; };
  free.timer = null;
  free._timerWake();
  assert.strictEqual(armed, 1, 'an awake room sleeps only until its next step');
  free.awake = false;
  free._timerWake();
  assert.strictEqual(armed, 1, 'a room that is not awake stops with nobody in it, as before');
  free.awake = true;
  // never a paid room
  const paid = new AgArenas({ region: 'na', autoTick: false, log: quiet });
  paid.rooms[0].paid = true;
  assert.strictEqual(paid.rooms[0].setAwake(true), false, 'a paid room is never woken');
  // stop puts it to sleep for good
  free.stop();
  assert.strictEqual(free.awake, false);
  assert.strictEqual(free.setAwake(true), false, 'a stopped room cannot be woken');
});

test('agar.io: a replacement of the awake room wakes at once when people were in it, else at most once a minute', () => {
  let t = 1000000;
  const arenas = new AgArenas({ region: 'na', autoTick: false, log: quiet, now: () => t });
  arenas.keepAwake();
  const first = arenas.rooms[0];
  arenas._replace(first, []);
  const second = arenas.rooms.find((r) => r.index === 0);
  assert.notStrictEqual(second, first);
  assert.strictEqual(second.awake, false, 'empty and within a minute of the last wake: left asleep');
  t += 61000;
  arenas._replace(second, []);
  const third = arenas.rooms.find((r) => r.index === 0);
  assert.strictEqual(third.awake, true, 'a minute later: woken');
  // a replacement left asleep wakes at the next sweep a minute on
  arenas._replace(third, []);
  const fourth = arenas.rooms.find((r) => r.index === 0);
  assert.strictEqual(fourth.awake, false);
  t += 61000;
  arenas.sweep(t);
  assert.strictEqual(fourth.awake, true, 'the sweep wakes it');
});

test('agar.io: the last visitor leaving an awake room does not stop its clock', () => {
  const arenas = new AgArenas({ region: 'na', autoTick: false, log: quiet });
  arenas.keepAwake();
  const free = arenas.rooms[0];
  let idled = 0;
  free._goIdle = () => { idled++; };
  const sock = { id: 'w1', emit() {}, join() {}, leave() {}, handshake: {}, conn: {} };
  assert.ok(free.addSocket(sock, { watch: true }));
  free.removeSocket('w1');
  assert.strictEqual(idled, 0, 'awake: no idle when the last seat goes');
  free.awake = false;
  assert.ok(free.addSocket(Object.assign({}, sock, { id: 'w2' }), { watch: true }));
  free.removeSocket('w2');
  assert.strictEqual(idled, 1, 'not awake: idles as before');
  free.stop();
});

test('Paper.io: the free arena #1 wakes after its warm-up, never a paid one, and Free Spectate with nobody playing watches its bots', () => {
  const arenas = new PaperArenas({ region: 'na', hooks: noopHooks, paidEnabled: true, autoTick: false, warm: false, awake: true });
  const free = arenas.arenas[Object.keys(arenas.arenas).find((k) => arenas.arenas[k][0] && arenas.arenas[k][0].stake === 0)][0];
  assert.strictEqual(free.awake, true);
  assert.strictEqual(free.liveHumans, 0);
  assert.strictEqual(arenas.watchFor(0), free, 'Free: the awake arena and its bots, nobody seated');
  assert.strictEqual(arenas.watchFor(0.5), null, 'a paid rung nobody is at: nothing to watch (the page shows the empty map)');
  // the last seat leaving an awake arena does not stop its clock
  let idled = 0;
  free._goIdle = () => { idled++; };
  free._forgetSeat({ unit: { id: -1 }, socketId: null });
  assert.strictEqual(idled, 0, 'awake: no idle with nobody left');
  // a paid arena and a warming one refuse
  const paid = arenas._create(0.5, 0);
  assert.strictEqual(paid.setAwake(true), false, 'a paid arena is never woken');
  const warming = arenas._create(0, 1);
  warming.warming = true;
  assert.strictEqual(warming.setAwake(true), false, 'not while the boot warm-up still runs');
  for (const r of arenas.all()) r.stop();
});

test('Paper.io: without awake (tests, old boots) the free arena keeps the old rule', () => {
  const arenas = new PaperArenas({ region: 'na', hooks: noopHooks, autoTick: false, warm: false });
  assert.strictEqual(arenas.watchFor(0), null, 'nobody seated and not awake: nothing to watch');
  for (const r of arenas.all()) r.stop();
});
