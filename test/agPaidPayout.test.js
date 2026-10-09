'use strict';
// paperPayout parameterized for paid agar.io (PAID-AGAR-DESIGN.md 5.6, checklist step 2): Paper's instance sends the
// same events, reasons and memos byte for byte; the agar instance says ag:* / agar / refund agar / agar_floor /
// agar_breach; an order with no socket pays without emitting; a cashoutId pays once; the cut is floor(gross/10); a
// failed payout becomes an owed row.
const test = require('node:test');
const assert = require('node:assert');
const { create } = require('../server/paperPayout');

function fakes({ fail } = {}) {
  const calls = { withdraw: [], recordEarnings: [], recordFailedPayout: [], trackEarning: [], sweepRake: [], emits: [] };
  const money = {
    withdraw: (wallet, amount) => {
      calls.withdraw.push([wallet, amount]);
      if (fail) {
        const e = new Error('rpc down');
        e.broadcast = null;
        return Promise.reject(e);
      }
      return Promise.resolve('SIG' + calls.withdraw.length);
    },
    fiatValue: (a) => a,
  };
  const db = {
    recordEarnings: (...a) => { calls.recordEarnings.push(a); return Promise.resolve(); },
    recordFailedPayout: (...a) => { calls.recordFailedPayout.push(a); return Promise.resolve(); },
  };
  const io = { to: (id) => ({ emit: (ev, p) => calls.emits.push([id, ev, p]) }) };
  return { calls, deps: { money, db, io, REGION: 'na', trackEarning: (o) => calls.trackEarning.push(o), sweepRake: (a, l) => calls.sweepRake.push([a, l]) } };
}

function silence(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
}

async function runBoth(make, t) {
  silence(t);
  const out = {};
  for (const game of ['paper', 'agar']) {
    const f = fakes(make);
    const opts = game === 'agar'
      ? Object.assign({}, f.deps, { game: 'agar', prefix: 'ag', floorSource: 'agar_floor', breachSource: 'agar_breach', tag: '[AG]' })
      : f.deps;
    out[game] = { pay: create(opts), calls: f.calls };
  }
  return out;
}

test('a cash-out: Paper unchanged, agar names its own events, game and rake memo; 90/10 in integers', async (t) => {
  const both = await runBoth({}, t);
  const order = { cashoutId: 'c1', grossMicro: 123457, wallet: 'W', name: 'amy', label: 'L', socketId: 'S' };
  await both.paper.pay.payCashout(order);
  await both.agar.pay.payCashout(Object.assign({}, order));
  const p = both.paper.calls;
  const a = both.agar.calls;
  assert.deepStrictEqual(p.emits.map((e) => e[1]), ['pp:cashedout', 'pp:paid']);
  assert.deepStrictEqual(a.emits.map((e) => e[1]), ['ag:cashedout', 'ag:paid']);
  assert.deepStrictEqual(a.emits[0][2], { grossMicro: 123457, cutMicro: 12345, netMicro: 111112, cashoutId: 'c1' });
  assert.deepStrictEqual(p.trackEarning[0].game, 'paper');
  assert.deepStrictEqual(a.trackEarning[0], { source: 'game_rake', game: 'agar', amountUsdc: 12345 / 1e6, wallet: 'W', name: 'amy', lobbyType: 'L', region: 'na' });
  assert.deepStrictEqual(p.sweepRake, [[12345 / 1e6, 'paper L']]);
  assert.deepStrictEqual(a.sweepRake, [[12345 / 1e6, 'agar L']]);
  assert.deepStrictEqual(a.withdraw, [['W', 111112 / 1e6]]);
});

test('an agar order with no socket (a dormant auto cash-out) pays the wallet and emits nothing', async (t) => {
  const both = await runBoth({}, t);
  await both.agar.pay.payCashout({ cashoutId: 'c2', grossMicro: 100000, wallet: 'W', name: 'n', label: 'L', socketId: null });
  assert.deepStrictEqual(both.agar.calls.emits, []);
  assert.deepStrictEqual(both.agar.calls.withdraw, [['W', 0.09]]);
});

test('a cashoutId pays once', async (t) => {
  const both = await runBoth({}, t);
  const o = { cashoutId: 'dup', grossMicro: 100000, wallet: 'W', name: 'n', label: 'L', socketId: 'S' };
  await both.agar.pay.payCashout(o);
  await both.agar.pay.payCashout(Object.assign({}, o));
  assert.strictEqual(both.agar.calls.withdraw.length, 1);
});

test('a failed payout becomes an owed row: Paper says paper, agar says agar; refunds say refund <game>', async (t) => {
  const both = await runBoth({ fail: true }, t);
  await both.paper.pay.payCashout({ cashoutId: 'f1', grossMicro: 100000, wallet: 'W', name: 'n', label: 'L', socketId: 'S' });
  await both.agar.pay.payCashout({ cashoutId: 'f1', grossMicro: 100000, wallet: 'W', name: 'n', label: 'L', socketId: 'S' });
  assert.strictEqual(both.paper.calls.recordFailedPayout[0][3], 'paper L: rpc down');
  assert.strictEqual(both.agar.calls.recordFailedPayout[0][3], 'agar L: rpc down');
  assert.deepStrictEqual(both.agar.calls.emits.map((e) => e[1]), ['ag:cashedout', 'ag:payerror']);
  await both.paper.pay.refund({ wallet: 'W', name: 'n', micro: 100000, paid: 0.1, why: 'full' });
  await both.agar.pay.refund({ wallet: 'W', name: 'n', micro: 100000, paid: 0.1, why: 'full' });
  assert.strictEqual(both.paper.calls.recordFailedPayout[1][3], 'refund paper full: rpc down');
  assert.strictEqual(both.agar.calls.recordFailedPayout[1][3], 'refund agar full: rpc down');
  assert.ok(both.agar.calls.recordFailedPayout[1][3].startsWith('refund'), 'the drainer never books it as winnings');
});

test('a refund takes no rake; a crash refund of a balance above the deposit pays the whole balance (Owen Q6)', async (t) => {
  const both = await runBoth({}, t);
  await both.agar.pay.refund({ wallet: 'W', name: 'n', micro: 250000, paid: undefined, why: 'emergency' });
  assert.deepStrictEqual(both.agar.calls.withdraw, [['W', 0.25]]);
  assert.deepStrictEqual(both.agar.calls.sweepRake, []);
  assert.deepStrictEqual(both.agar.calls.trackEarning, []);
  // an unconfirmed seat's refund is bounded by what landed
  await both.agar.pay.refund({ wallet: 'W', name: 'n', micro: 100000, paid: 0.099, why: 'join-lost' });
  assert.deepStrictEqual(both.agar.calls.withdraw[1], ['W', 0.099]);
});

test('floor and breach sources: agar_floor and agar_breach on the rake path, once per id; Paper has no breach source', async (t) => {
  const both = await runBoth({}, t);
  both.agar.pay.sweepFloor({ sweepId: 's1', micro: 5000, srcWallet: 'W', srcName: 'n', label: 'L', pid: 1 });
  assert.strictEqual(both.agar.calls.trackEarning[0].source, 'agar_floor');
  assert.deepStrictEqual(both.agar.calls.sweepRake[0], [0.005, 'agar floor L']);
  assert.strictEqual(both.agar.pay.houseIncident({ id: 'h1', micro: 7000, wallet: 'W', name: 'n', label: 'L', why: 'zombie' }), true);
  assert.strictEqual(both.agar.pay.houseIncident({ id: 'h1', micro: 7000, wallet: 'W', name: 'n', label: 'L', why: 'zombie' }), false);
  assert.deepStrictEqual(both.agar.calls.trackEarning[1], { source: 'agar_breach', game: 'agar', amountUsdc: 0.007, wallet: 'W', name: 'n', lobbyType: 'L', region: 'na' });
  assert.deepStrictEqual(both.agar.calls.sweepRake[1], [0.007, 'agar breach L']);
  assert.strictEqual(both.paper.pay.houseIncident({ id: 'x', micro: 1, wallet: 'W', label: 'L' }), false);
  both.paper.pay.sweepFloor({ sweepId: 's1', micro: 5000, srcWallet: 'W', srcName: 'n', label: 'L', pid: 1 });
  assert.strictEqual(both.paper.calls.trackEarning[0].source, 'paper_floor');
  assert.deepStrictEqual(both.paper.calls.sweepRake[0], [0.005, 'paper floor L']);
});
