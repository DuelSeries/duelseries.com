'use strict';
// The owner's "you made money" push (server/earnAlerts.js) and the two places that call it: a rake sweep that
// landed (server/rakeSweep.js) and a failed sweep the payout drainer pays later (server/payoutDrainer.js).
const test = require('node:test');
const assert = require('node:assert');
const { createEarnAlerts, describe: where, labelFromRakeReason } = require('../server/earnAlerts');
const { createRakeSweeper } = require('../server/rakeSweep');
const { createPayoutDrainer } = require('../server/payoutDrainer');

const REV = 'RevenueWallet1111111111111111111111111111111';
const quiet = { log() {}, warn() {}, error() {} };
const tick = () => new Promise((r) => setImmediate(r));

// Timers by hand, so a test decides when a cooldown ends.
function fakeTimers() {
  let id = 0;
  const live = new Map();
  return {
    setTimer: (fn, ms) => { const t = { id: ++id, ms }; live.set(t.id, { fn, ms }); return t; },
    clearTimer: (t) => { if (t) live.delete(t.id); },
    fire(ms) { for (const [k, v] of [...live]) if (v.ms === ms) { live.delete(k); v.fn(); } },
  };
}

function rig({ today = 1.25 } = {}) {
  const pushes = [];
  const timers = fakeTimers();
  const alerts = createEarnAlerts({
    push: (body, opts) => pushes.push({ body, ...opts }),
    todayTotal: () => Promise.resolve(today),
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: quiet,
  });
  return { alerts, pushes, timers };
}

test.beforeEach(() => { delete process.env.NTFY_EARN_OFF; });

test('a sweep that lands pushes exactly once, with the dollars, the room and today', async () => {
  const { alerts, pushes } = rig();
  const sweep = createRakeSweeper({
    money: { unit: 'USD', withdraw: async () => 'SIG123' }, db: { recordFailedPayout: async () => assert.fail('no owed row') },
    revenueWallet: REV, onSwept: alerts.earned, log: quiet,
  });
  sweep(0.05, 'agar ag_na_s0_5');
  await tick(); await tick();
  assert.strictEqual(pushes.length, 1);
  assert.strictEqual(pushes[0].title, 'You made $0.05');
  assert.strictEqual(pushes[0].body, 'agar.io $0.50 room · today $1.25');
  assert.strictEqual(pushes[0].priority, 'high');
});

test('a sweep that fails pushes nothing and is owed to the drainer, as before', async () => {
  const { alerts, pushes } = rig();
  const owed = [];
  const sweep = createRakeSweeper({
    money: { unit: 'USD', withdraw: async () => { throw new Error('rpc 429'); } },
    db: { recordFailedPayout: async (...a) => { owed.push(a); } },
    revenueWallet: REV, onSwept: alerts.earned, log: quiet,
  });
  sweep(0.1, 'slither na_s1');
  await tick(); await tick();
  assert.strictEqual(pushes.length, 0);
  assert.deepStrictEqual(owed.map((a) => a.slice(0, 4)), [[REV, 0.1, 'rake-sweep', 'rake slither na_s1: rpc 429']]);
});

test('a throwing push can never turn a landed sweep into an owed one', async () => {
  const owed = [];
  const sweep = createRakeSweeper({
    money: { unit: 'USD', withdraw: async () => 'SIG' }, db: { recordFailedPayout: async (...a) => { owed.push(a); } },
    revenueWallet: REV, onSwept: () => { throw new Error('boom'); }, log: quiet,
  });
  sweep(0.05, 'paper paper_na_s0_5');
  await tick(); await tick();
  assert.strictEqual(owed.length, 0);
});

test('a failed sweep the drainer pays later pushes once; a player payout it pays pushes nothing', async () => {
  const { alerts, pushes } = rig();
  const rows = [
    { id: 1, wallet_address: REV, amount_sol: '0.050000', name: 'rake-sweep', reason: 'rake knockout: rpc 429', attempts: 1 },
    { id: 2, wallet_address: 'PlayerWallet', amount_sol: '0.45', name: 'Bob', reason: 'agar ag_na_s0_5: rpc', attempts: 1 },
  ];
  const db = {
    claimDuePayout: async (_a, _b, lane) => (lane === 'normal' ? rows.shift() || null : null),
    markPayoutPaid: async () => {}, savePayoutSignature: async () => true, recordEarnings: async () => {},
  };
  const drainer = createPayoutDrainer({
    db, money: { unit: 'USD', attemptPayout: async () => ({ paid: true, sig: 'S' }), fiatValue: () => 0 }, log: quiet,
    onPaid: (row) => {
      if (row.wallet_address === REV && row.name === 'rake-sweep') alerts.earned(Number(row.amount_sol), labelFromRakeReason(row.reason));
    },
  });
  await drainer.drain();
  await tick(); await tick();
  assert.strictEqual(pushes.length, 1);
  assert.strictEqual(pushes[0].title, 'You made $0.05');
  assert.strictEqual(pushes[0].body, 'Knockout · today $1.25');
});

test('a drainer row the payout has not landed for yet pushes nothing', async () => {
  const { alerts, pushes } = rig();
  let row = { id: 1, wallet_address: REV, amount_sol: '0.05', name: 'rake-sweep', reason: 'rake knockout: x', attempts: 1 };
  const db = {
    claimDuePayout: async (_a, _b, lane) => { const r = lane === 'normal' ? row : null; row = null; return r; },
    markPayoutPaid: async () => assert.fail('not paid'), savePayoutSignature: async () => true,
  };
  const drainer = createPayoutDrainer({
    db, money: { attemptPayout: async () => ({ paid: false }) }, log: quiet,
    onPaid: (r) => alerts.earned(Number(r.amount_sol), labelFromRakeReason(r.reason)),
  });
  await drainer.drain();
  await tick();
  assert.strictEqual(pushes.length, 0);
});

test('cuts inside the 30 s cooldown are batched into one push when it ends', async () => {
  const { alerts, pushes, timers } = rig({ today: 2 });
  alerts.earned(0.05, 'agar ag_na_s0_5');          // pushes at once, opens the cooldown
  await tick();
  alerts.earned(0.1, 'slither na_s1');
  alerts.earned(0.05, 'agar ag_na_s0_5#1');
  alerts.earned(0.1, 'sl sl_na_s1');
  await tick();
  assert.strictEqual(pushes.length, 1);
  timers.fire(30000);
  await tick(); await tick();
  assert.strictEqual(pushes.length, 2);
  assert.strictEqual(pushes[1].title, 'You made $0.25');
  assert.strictEqual(pushes[1].body, '3 cuts: slither.io $1.00 room, agar.io $0.50 room · today $2.00');
  timers.fire(30000);                               // an empty cooldown ends: nothing, and the next cut pushes at once
  await tick();
  assert.strictEqual(pushes.length, 2);
  alerts.earned(0.05, 'paper paper_na_s0_5');
  await tick(); await tick();
  assert.strictEqual(pushes.length, 3);
  assert.strictEqual(pushes[2].body, 'Paper.io $0.50 room · today $2.00');
});

test('NTFY_EARN_OFF=1 sends nothing', async () => {
  const { alerts, pushes } = rig();
  process.env.NTFY_EARN_OFF = '1';
  alerts.earned(0.05, 'agar ag_na_s0_5');
  await tick();
  assert.strictEqual(pushes.length, 0);
});

test('no today total: the push still goes, without it', async () => {
  const pushes = [];
  const t = fakeTimers();
  const alerts = createEarnAlerts({ push: (body, o) => pushes.push({ body, ...o }), todayTotal: () => Promise.reject(new Error('db')),
    setTimer: t.setTimer, clearTimer: t.clearTimer, log: quiet });
  alerts.earned(0.05, 'knockout');
  await tick(); await tick();
  assert.strictEqual(pushes.length, 1);
  assert.strictEqual(pushes[0].body, 'Knockout');
});

test('the text never carries anything from the label but a known game and a rung', () => {
  assert.strictEqual(where('agar ag_na_s0_5'), 'agar.io $0.50 room');
  assert.strictEqual(where('slither na_dollar'), 'slither.io $1.00 room');
  assert.strictEqual(where('slither na_br'), 'Battle Royale');
  assert.strictEqual(where('paper floor paper_na_s1'), 'Paper.io floor money');
  assert.strictEqual(where('agar breach ag_na_s0_5'), 'agar.io held funds');
  assert.strictEqual(where('battleship'), 'Battleship');
  assert.strictEqual(where('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), 'a game');
  assert.strictEqual(where('agar 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), 'agar.io');
  assert.strictEqual(where(null), 'a game');
  assert.strictEqual(labelFromRakeReason('rake agar ag_na_s0_5: Wallet 7xKX failed: x'), 'agar ag_na_s0_5');
});
