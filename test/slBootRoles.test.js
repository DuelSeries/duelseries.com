'use strict';
/* slBoot's link and role options (server/sl/slBoot.js openSl; server split spec 6.4 and 14.1 #2).

   - link.remote (the main server beside a slither process): the law table is checked and the page composed as
     always, but NO SlArenas is built, no timer starts and no event-loop histogram is made; /sl gets ONE router, role
     'paid', over { laws, shippableOnly, governor: the link's mirror }; the link is handed the paidLoad helper; the
     answer's arenas is the link's freeProxy, and its sockets are setPaid and paidSeated with a setBr that attaches
     nothing. openSlPaid works against those sockets: a paid page is seated paid, a free one refused 'closed'.
   - a refused law table still closes the game before the link is asked anything.
   - an inert link (remote false), role 'free' and a plain call keep today's path: the room, its timers and its
     histogram; role 'free' refuses a paid handshake, a plain call does not. */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const perfHooks = require('perf_hooks');
const B = require('../server/sl/slBoot');
const arenasMod = require('../server/sl/slArenas');
const { fakeIoSocket, layerMsgs } = require('./slSockFakes');
const { fakeTimers } = require('./slNetFakes');
const { moneySpy, fakeLedger, fakePayout } = require('./slPaidFakes');
const { makeEntryStore } = require('../server/entryStore');
const { isStake } = require('../server/stakeRules');
const { openSlPaid } = require('../server/slPaid/slPaidBoot');
const { STATUS } = require('../server/sl/slLaws');

const QUIET = { log() {}, warn() {}, error() {} };
const FIXTURE_FILE = path.join(__dirname, 'slLawsFixture.js');
const ENV = { SL_ENABLED: '1', SL_DEV_LAWS: FIXTURE_FILE };

function fakeIo() {
  const nsps = {};
  return {
    nsps,
    of(name) {
      if (!nsps[name]) nsps[name] = { uses: [], conns: [], use(f) { this.uses.push(f); }, on(ev, f) { if (ev === 'connection') this.conns.push(f); } };
      return nsps[name];
    },
  };
}

// A link to a slither process (server/split/slLink.js's shape, the parts openSl reads); remote false: inert, any call
// on it is a failure.
function fakeLink(remote) {
  const seen = { helpers: null, local: null, calls: 0 };
  const gov = { sample: () => null, admitBot: () => true, engaged: () => false, mult: () => 1, stats: () => ({}) };
  const touch = () => { seen.calls++; if (!remote) throw new Error('an inert link was used'); };
  return {
    seen, gov, remote,
    mirrorGovernor() { touch(); return gov; },
    useHelpers(h) { touch(); seen.helpers = h; },
    freeProxy(local) { touch(); seen.local = local; return { remote: true, local, laws: local.laws }; },
  };
}

// Counts, while fn runs: SlArenas built, event-loop histograms made, timers set (every sl timer is unref'd, so it
// never shows in process.getActiveResourcesInfo: the global setTimeout and setInterval calls are counted instead),
// and the active resources it left behind.
function measured(fn) {
  const Real = arenasMod.SlArenas;
  const realMonitor = perfHooks.monitorEventLoopDelay;
  const realTimeout = global.setTimeout;
  const realInterval = global.setInterval;
  const out = { arenas: 0, monitors: 0, timers: 0, resources: 0, value: null };
  arenasMod.SlArenas = class extends Real {
    constructor(...a) { super(...a); out.arenas++; }
  };
  perfHooks.monitorEventLoopDelay = (...a) => { out.monitors++; return realMonitor(...a); };
  global.setTimeout = function (...a) { out.timers++; return realTimeout.apply(this, a); };
  global.setInterval = function (...a) { out.timers++; return realInterval.apply(this, a); };
  const before = process.getActiveResourcesInfo().length;
  try {
    out.value = fn();
  } finally {
    arenasMod.SlArenas = Real;
    perfHooks.monitorEventLoopDelay = realMonitor;
    global.setTimeout = realTimeout;
    global.setInterval = realInterval;
  }
  out.resources = process.getActiveResourcesInfo().length - before;
  return out;
}

// openSl with the server's own defaults (real every, real histogram), quiet and on the fixture table.
function open(extra) {
  return B.openSl(Object.assign({ env: ENV, log: QUIET, autoTick: false, bots: false, io: fakeIo(), region: 'na',
    helpers: { socketRL: () => true, ops: { get: () => ({ maintenance: false }) }, paidLoad: () => ({ paidPlayers: 0, paid: [] }) },
  }, extra));
}

// A socket arriving on the fake /sl namespace through the router's own connection handler.
function arrive(io, auth, ip) {
  const s = fakeIoSocket({ auth, ip: ip || '203.0.113.20' });
  for (const f of io.nsps['/sl'].conns) f(s);
  return s;
}
const refusals = (s) => layerMsgs(s).filter((m) => m.t === 'refused');

test('link.remote: no room, no timer, no histogram; one paid-role router; the link\'s proxy and helpers', () => {
  const io = fakeIo();
  const link = fakeLink(true);
  const m = measured(() => open({ io, link, awake: true }));
  const o = m.value;
  assert.strictEqual(o.why, null, String(o.why));
  assert.strictEqual(m.arenas, 0, 'no SlArenas');
  assert.strictEqual(m.monitors, 0, 'no event-loop histogram');
  assert.strictEqual(m.timers, 0, 'no timer');
  assert.strictEqual(m.resources, 0, 'no active resource');
  assert.strictEqual(o.dev, true);
  assert.ok(typeof o.page === 'string' && o.page.includes('/js/slx/'), 'the page composed as always');
  // the proxy, over the local laws with the mirror governor
  assert.strictEqual(o.arenas.remote, true);
  assert.strictEqual(o.arenas.local, link.seen.local);
  assert.deepStrictEqual(Object.keys(link.seen.local), ['laws', 'shippableOnly', 'governor']);
  assert.strictEqual(link.seen.local.shippableOnly, false, 'the dev table is not shippable');
  assert.strictEqual(link.seen.local.governor, link.gov);
  assert.ok(link.seen.local.laws && link.seen.local.laws.C_SL_PER_IP, 'the law table');
  assert.deepStrictEqual(link.seen.helpers.paidLoad(), { paidPlayers: 0, paid: [] }, 'the paidLoad helper handed over');
  // one router on /sl, role paid
  assert.strictEqual(io.nsps['/sl'].uses.length, 1);
  assert.strictEqual(io.nsps['/sl'].conns.length, 1);
  assert.deepStrictEqual(Object.keys(o.sockets).sort(), ['paidSeated', 'setBr', 'setPaid']);
  assert.strictEqual(o.sockets.setBr({ arenas: {} }), false, 'the battle royale is never attached here');
  const free = arrive(io, { cv: 2 });
  assert.deepStrictEqual(refusals(free), [{ t: 'refused', why: 'closed' }], 'a free socket is the slither process\'s');
  assert.strictEqual(free.disconnected, true);
});

test('link.remote: openSlPaid builds the paid rungs on those sockets; a paid page is seated paid', () => {
  const io = fakeIo();
  const link = fakeLink(true);
  const o = open({ io, link });
  const ft = fakeTimers(1000);
  const wall = { t: 1.7e12 };
  const money = moneySpy();
  const store = makeEntryStore({ isStake, now: () => wall.t });
  const got = openSlPaid({
    env: { SL_PAID: '1' }, sockets: o.sockets, laws: link.seen.local.laws, region: 'na', shippableOnly: false, log: QUIET,
    hooks: money.hooks,
    door: { consumeAtStake: (t, s) => store.consumeAtStake(t, s, 'slither'), ledger: fakeLedger(), slPayout: fakePayout(),
      journal: money.journal, ops: { get: () => ({ maintenance: false }) } },
    arenas: { clock: ft.clock, timers: ft.timers, now: () => wall.t, autoTick: false, prey: false, seed: 3, checkEvery: 1 },
  });
  assert.strictEqual(got.paid, true, String(got.why));
  const token = store.mint({ stake: 0.5, worth: 0.5, paid: 0.5, walletAddress: 'W1', onlyGame: 'slither' });
  wall.t += 1000;
  const s = arrive(io, { paid: 1, stake: 0.5, entryToken: token, cv: 2 });
  assert.deepStrictEqual(refusals(s), []);
  s.fire('sl:join', { nick: 'payer' });
  assert.deepStrictEqual(refusals(s), []);
  assert.ok(got.arenas.roomOf(s.id), 'seated in a paid room');
  const watcher = arrive(io, { watch: 1, watchStake: 0.5 });
  assert.deepStrictEqual(refusals(watcher), [], 'a paid rung\'s watcher is admitted here');
  const free = arrive(io, { watch: 1 });
  assert.deepStrictEqual(refusals(free), [{ t: 'refused', why: 'closed' }], 'a free watcher is not');
});

test('link.remote with a refused law table: closed, and the link is never asked', () => {
  const { LAWS } = require('../server/sl/slLaws');
  const laws = {};
  for (const id of Object.keys(LAWS)) laws[id] = Object.assign({}, LAWS[id]);
  laws.C_CHAT = Object.assign({}, laws.C_CHAT, { status: STATUS.PROPOSED });
  const link = fakeLink(true);
  const o = open({ env: { SL_ENABLED: '1' }, laws, link });
  assert.strictEqual(o.arenas, null);
  assert.match(o.why, /C_CHAT \(PROPOSED\)/);
  assert.strictEqual(link.seen.calls, 0);
  const off = open({ env: {}, link });
  assert.strictEqual(off.why, 'off');
  assert.strictEqual(link.seen.calls, 0);
});

test('an inert link, role free and a plain call keep today\'s path: the room, its timers, its histogram', () => {
  for (const extra of [{ link: fakeLink(false) }, { role: 'free' }, {}]) {
    const io = fakeIo();
    const m = measured(() => open(Object.assign({ io }, extra)));
    const o = m.value;
    const label = JSON.stringify(Object.keys(extra)) + (extra.role ? ' ' + extra.role : '');
    try {
      assert.strictEqual(o.why, null, label + ' ' + o.why);
      assert.strictEqual(m.arenas, 1, label + ': the free room');
      assert.strictEqual(m.monitors, 1, label + ': its histogram');
      assert.ok(m.timers >= 1, label + ': its timers (' + m.timers + ')');
      assert.ok(o.arenas instanceof arenasMod.SlArenas, label);
      assert.strictEqual(typeof o.sockets.attach, 'function', label + ': the whole handle');
      assert.strictEqual(o.sockets.role, extra.role === 'free' ? 'free' : 'all', label);
      const p = arrive(io, { paid: 1 });
      assert.deepStrictEqual(refusals(p), extra.role === 'free' ? [{ t: 'refused', why: 'closed' }] : [],
        label + ': a paid handshake');
      const f = arrive(io, { cv: 1 });
      f.fire('sl:join', { nick: 'free' });
      assert.deepStrictEqual(refusals(f), [], label + ': a free player');
      assert.strictEqual(o.arenas.room().seats.size, 1, label + ': seated in the free room');
    } finally {
      if (o.arenas) o.arenas.close();
    }
  }
});
