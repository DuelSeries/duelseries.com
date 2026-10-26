'use strict';
// The lobby's battle royale join call (public/js/v2/brCall.js, Owen 2026-10-25): for the 30 s before a slot the
// Events tab beats gold, one toast says "Battle royale starting" and opens Events on a tap, a Glass call sounds as it
// opens and a soft tick counts the last 5 s. Driven here on a fake clock against a fake /api/live, with no browser.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/v2/brCall.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '../public/v2.html'), 'utf8');
const flush = () => new Promise((r) => setImmediate(r));

function lobby(opts) {
  const o = opts || {};
  let now = 1.7e12;
  const SLOT = now + (o.slotIn || 100) * 1000; // the next slot, 100 s from the start of the run
  let timers = [], seq = 0;
  const classes = new Set();
  const btn = { classList: {
    contains: (c) => classes.has(c),
    toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
  } };
  const events = { up: !!o.onEvents };
  const toasts = [], sounds = [], went = [];
  let fetches = 0;
  const live = () => {
    const secs = Math.ceil((SLOT - now) / 1000);
    const running = now >= SLOT && now < SLOT + 120000;
    return { state: running ? 'countdown' : 'waiting', nextInSec: secs > 0 ? secs : secs + 6 * 3600,
      joinOpen: !running && secs > 0 && secs <= 30, joinWindowSec: 30 };
  };
  const ctx = {
    Date: { now: () => now },
    Math,
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ id, at: now + Math.max(0, ms || 0), fn }); return id; },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
    setInterval: (fn, ms) => { const id = ++seq; timers.push({ id, at: now + ms, fn, every: ms }); return id; },
    clearInterval: (id) => { timers = timers.filter((t) => t.id !== id); },
    getComputedStyle: (el) => ({ display: el === 'events' && events.up ? 'block' : 'none' }),
    fetch: () => { fetches++; return Promise.resolve({ json: () => Promise.resolve({ br: live() }) }); },
    document: {
      hidden: false, readyState: 'complete',
      addEventListener() {},
      querySelector: (q) => (q === '#nav .ni[data-tab="events"]' ? btn : null),
      getElementById: (id) => (id === 'events-screen' ? 'events' : null),
    },
    DSToast: { show: (t) => { const c = Object.assign({ closed: false }, t); toasts.push(c);
      return { close() { c.closed = true; }, update() {} }; } },
    DSSound: { play: (n) => sounds.push({ n, at: now }) },
    go: (id) => went.push(id),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  async function advance(secs) {
    const end = now + secs * 1000;
    while (now < end) {
      await flush();
      now += 250;
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        if (due.every) due.at += due.every; else timers = timers.filter((t) => t !== due);
        due.fn();
        await flush();
      }
    }
  }
  return { ctx, advance, toasts, sounds, went, classes, events, fetches: () => fetches, SLOT, now: () => now };
}

test('the 30 s before a slot: the Events tab beats, one toast that opens Events, the call, then 5 ticks', async () => {
  const L = lobby();
  await L.advance(60); // 40 s before the slot: nothing yet
  assert.strictEqual(L.toasts.length, 0);
  assert.strictEqual(L.classes.has('brcall'), false);
  await L.advance(12); // 28 s before: the window is open (found within the 2 s poll)
  assert.strictEqual(L.classes.has('brcall'), true, 'the Events tab beats');
  assert.strictEqual(L.ctx.V2BrCall.on(), true, 'and drawNav keeps it on a redraw');
  assert.strictEqual(L.toasts.length, 1);
  assert.strictEqual(L.toasts[0].title, 'Battle royale starting');
  assert.ok(/Join now/.test(L.toasts[0].detail));
  L.toasts[0].onTap();
  assert.deepStrictEqual(L.went, ['events'], 'one tap opens Events');
  await L.advance(29); // through the slot
  const ticks = L.sounds.filter((s) => s.n === 'brtick');
  assert.strictEqual(ticks.length, 5, 'a tick for each of the last 5 seconds');
  assert.ok(ticks.every((s) => s.at < L.SLOT && s.at >= L.SLOT - 5000));
  await L.advance(4);
  assert.strictEqual(L.classes.has('brcall'), false, 'the match started: the beat stops');
  assert.strictEqual(L.toasts[0].closed, true, 'and the toast goes with it');
  assert.strictEqual(L.toasts.length, 1, 'one toast per window, not one per poll');
  assert.ok(L.fetches() < 25, 'it sleeps until the window, then polls every 2 s (' + L.fetches() + ' polls)');
});

test('already on Events: no toast, the call sound alone', async () => {
  const L = lobby({ onEvents: true });
  await L.advance(75);
  assert.strictEqual(L.toasts.length, 0);
  assert.deepStrictEqual(L.sounds.map((s) => s.n), ['brcall']);
  assert.strictEqual(L.classes.has('brcall'), true);
});

test('far from a slot it asks the server rarely (at most every 10 minutes)', async () => {
  const L = lobby({ slotIn: 5 * 3600 });
  await L.advance(3600);
  assert.ok(L.fetches() <= 8, L.fetches() + ' polls in an hour');
});

test('the beat animates for everyone, reduced motion included (Owen\'s PC reports it)', () => {
  assert.ok(/\.ni\.brcall::before,\.ni\.brcall svg\{animation-duration:1s!important;animation-iteration-count:infinite!important\}/.test(HTML));
  assert.ok(/<script src="\/js\/v2\/brCall\.js"><\/script>/.test(HTML));
  assert.ok(/n\.call&&n\.call\(\)\?' brcall'/.test(HTML), 'drawNav keeps the class across a redraw');
  const sounds = fs.readFileSync(path.join(__dirname, '../public/js/v2/sounds.js'), 'utf8');
  assert.ok(/\/\^Battle royale starting\/, 'brcall'/.test(sounds), 'the toast plays the call');
  assert.ok(/brtick:/.test(sounds));
});
