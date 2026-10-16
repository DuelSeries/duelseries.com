'use strict';
// slSafe (SERVER-DESIGN 13 item 8, 17; task T9): a throw or a rejection injected into each kind of sl job leaves the
// process and a fake paid room running. The process has no uncaughtException handler (server/index.js:88-93), so
// these wrappers are the only thing between one bad timer and every live game on the box.

const test = require('node:test');
const assert = require('node:assert');
const S = require('../server/sl/slSafe');
const { SlRoom } = require('../server/sl/slRoom');
const { makeFixture } = require('./slLawsFixture');
const { fakeView, bareSocket } = require('./slNetFakes');

const quiet = { error() {}, log() {}, warn() {} };

test('safeCall and safeAsync: a throw or a rejection is caught, counted by label and never rethrown', async () => {
  const st = S.createSafeStats();
  assert.strictEqual(S.safeCall(() => 7, 'ok', st, { log: quiet }), 7);
  assert.strictEqual(S.safeCall(() => { throw new Error('boom'); }, 'a', st, { log: quiet }), undefined);
  assert.strictEqual(await S.safeAsync(() => Promise.resolve(3), 'ok', st, { log: quiet }), 3);
  assert.strictEqual(await S.safeAsync(() => Promise.reject(new Error('no')), 'b', st, { log: quiet }), undefined);
  assert.strictEqual(await S.safeAsync(() => { throw new Error('sync'); }, 'b', st, { log: quiet }), undefined);
  S.safeCall(() => Promise.reject(new Error('late')), 'c', st, { log: quiet });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(st.byLabel, { a: 1, b: 2, c: 1 });
  assert.strictEqual(st.total, 4);
  assert.strictEqual(st.last.label, 'c');
  // a logger that throws is swallowed too
  S.safeCall(() => { throw new Error('x'); }, 'd', st, { log: { error() { throw new Error('log'); } } });
  assert.strictEqual(st.byLabel.d, 1);
});

test('an injected throw or rejection in each sl job leaves a fake paid room running', async () => {
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  // the fake paid room: a 5 ms tick the sl jobs must never stop
  let paidTicks = 0;
  const paid = setInterval(() => { paidTicks++; }, 5);
  const st = S.createSafeStats();
  const opts = { log: quiet };
  const jobs = [];
  // the sweep, the 1 Hz bot fill and governor, the top cash-out refresh and the owner push, each throwing or rejecting
  jobs.push(S.safeEvery(() => { throw new Error('sweep'); }, 10, 'sl.sweep', st, opts));
  jobs.push(S.safeEvery(() => Promise.reject(new Error('top')), 10, 'sl.top', st, opts));
  jobs.push(S.safeEvery(async () => { throw new Error('bots'); }, 10, 'sl.bots', st, opts));
  jobs.push(S.safeTimeout(() => { throw new Error('once'); }, 5, 'sl.once', st, opts));
  jobs.push(S.safeImmediate(() => { throw new Error('flush'); }, 'sl.flush', st, opts));
  S.safeAsync(() => Promise.reject(new Error('push')), 'sl.push', st, opts);
  // a real room on real timers whose view throws: three failing wakes close it, nothing escapes
  const room = new SlRoom(makeFixture(), { seed: 4, view: fakeView({ throwOnCollect: true }), shippableOnly: false,
    prey: false, log: quiet });
  let closed = false;
  room.onClosed = () => { closed = true; };
  room.seat(bareSocket(), { nick: 'a', cv: 1 });
  // and a room whose shared view step throws on every step
  const room2 = new SlRoom(makeFixture(), { seed: 5, view: fakeView({ throwOnStep: true }), shippableOnly: false,
    prey: false, log: quiet });
  room2.seat(bareSocket(), { nick: 'b', cv: 1 });
  const t0 = paidTicks;
  // At least 400 ms, then until every count below is in (5 s at most): the full suite can page the box, and a fixed
  // 400 ms window then undercounts (10 ticks once, 2026-10-16).
  const done = () => paidTicks - t0 > 20 && closed && ['sl.sweep', 'sl.top', 'sl.bots'].every((l) => st.byLabel[l] >= 5);
  const end = Date.now() + 5000;
  await new Promise((r) => setTimeout(r, 400));
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  const ran = paidTicks - t0;
  for (const j of jobs) j.stop();
  room.stop();
  room2.stop();
  clearInterval(paid);
  process.removeListener('uncaughtException', onUncaught);
  process.removeListener('unhandledRejection', onUncaught);
  assert.deepStrictEqual(uncaught, [], 'nothing escaped');
  assert.ok(ran > 20, 'the paid room kept ticking: ' + ran);
  for (const l of ['sl.sweep', 'sl.top', 'sl.bots']) assert.ok(st.byLabel[l] >= 5, l + ' ran and failed every time: ' + st.byLabel[l]);
  for (const l of ['sl.once', 'sl.flush', 'sl.push']) assert.strictEqual(st.byLabel[l], 1, l);
  assert.strictEqual(closed, true, 'the throwing room closed itself');
  assert.strictEqual(room.stats.failedWakes, 3);
  assert.ok(room2.closed, 'the room whose shared step throws closed too');
  assert.ok(room.safeStats.byLabel['sl.wake'] >= 3);
});

test('safeEvery keeps its period after a throw and stops on stop(); fake timers drive it', () => {
  let now = 0;
  const q = [];
  const timers = {
    setTimeout(fn, ms) { const h = { at: now + ms, fn }; q.push(h); return h; },
    clearTimeout(h) { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
    setImmediate(fn) { const h = { at: now, fn }; q.push(h); return h; },
    clearImmediate(h) { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
  };
  const st = S.createSafeStats();
  let calls = 0;
  const h = S.safeEvery(() => { calls++; throw new Error('x'); }, 100, 'job', st, { timers, log: quiet });
  for (let k = 0; k < 5; k++) {
    q.sort((a, b) => a.at - b.at);
    const t = q.shift();
    now = t.at;
    t.fn();
  }
  assert.strictEqual(calls, 5);
  assert.strictEqual(now, 500);
  assert.strictEqual(st.byLabel.job, 5);
  h.stop();
  assert.strictEqual(q.length, 0);
  assert.strictEqual(h.active, false);
});
