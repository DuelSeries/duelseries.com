'use strict';
// paperPayout (T3, design 5.5) with fake money, db, rake and io.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { create, HOUSE_CUT_DIV } = require('../server/paperPayout');
const MP = require('../public/js/paper/mp/paperWire.js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakes({ withdraw } = {}) {
  const calls = { withdraw: [], recordEarnings: [], recordFailedPayout: [], trackEarning: [], sweepRake: [], emits: [], log: [] };
  const money = {
    withdraw: withdraw || ((wallet, amount) => { calls.withdraw.push([wallet, amount]); return Promise.resolve('SIG' + calls.withdraw.length); }),
    fiatValue: (a) => a
  };
  const db = {
    recordEarnings: (...a) => { calls.recordEarnings.push(a); return Promise.resolve(); },
    recordFailedPayout: (...a) => { calls.recordFailedPayout.push(a); return Promise.resolve(); }
  };
  const io = { to: (id) => ({ emit: (ev, p) => calls.emits.push([id, ev, p]) }) };
  const deps = {
    money, db, io, REGION: 'na',
    trackEarning: (o) => calls.trackEarning.push(o),
    sweepRake: (a, l) => calls.sweepRake.push([a, l])
  };
  return { deps, calls };
}

function quiet(t, calls) {
  t.mock.method(console, 'log', (...a) => calls.log.push(['log', a.join(' ')]));
  t.mock.method(console, 'error', (...a) => calls.log.push(['error', a.join(' ')]));
}

let n = 0;
function order(extra) {
  n++;
  return Object.assign({ cashoutId: 'uuid-' + n, grossMicro: 100000, wallet: 'WALLET' + n, name: 'amy', label: 'paper_na_s0_5', socketId: 'S' + n }, extra);
}

test('the file never reads a socket property and has no forced path', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server/paperPayout.js'), 'utf8');
  assert.strictEqual(/socket\./.test(src), false);
  assert.strictEqual(/forced/.test(src), false);
  assert.strictEqual(HOUSE_CUT_DIV, MP.HOUSE_CUT_DIV);
});

test('90/10 in integers: 100000 -> 90000 + 10000, 300000 -> 270000 + 30000', async (t) => {
  const { deps, calls } = fakes();
  quiet(t, calls);
  const pay = create(deps);
  await pay.payCashout(order({ grossMicro: 100000 }));
  await pay.payCashout(order({ grossMicro: 300000 }));
  await pay.payCashout(order({ grossMicro: 99999 }));
  assert.deepStrictEqual(calls.withdraw.map(w => Math.round(w[1] * 1e6)), [90000, 270000, 90000]);
  assert.deepStrictEqual(calls.trackEarning.map(e => Math.round(e.amountUsdc * 1e6)), [10000, 30000, 9999]);
  assert.deepStrictEqual(calls.sweepRake.map(s => Math.round(s[0] * 1e6)), [10000, 30000, 9999]);
  assert.strictEqual(calls.trackEarning[0].source, 'game_rake');
  assert.strictEqual(calls.trackEarning[0].game, 'paper');
  assert.strictEqual(calls.trackEarning[0].lobbyType, 'paper_na_s0_5');
  assert.strictEqual(calls.sweepRake[0][1], 'paper paper_na_s0_5');
  const shown = calls.emits.filter(e => e[1] === 'pp:cashedout').map(e => e[2]);
  assert.deepStrictEqual(shown[0], { grossMicro: 100000, cutMicro: 10000, netMicro: 90000, cashoutId: shown[0].cashoutId });
  assert.strictEqual(calls.emits.filter(e => e[1] === 'pp:paid').length, 3);
});

test('recordEarnings only after withdraw resolves', async (t) => {
  const d = deferred();
  const { deps, calls } = fakes({ withdraw: (w, a) => { calls.withdraw.push([w, a]); return d.promise; } });
  quiet(t, calls);
  const pay = create(deps);
  const done = pay.payCashout(order());
  await new Promise(r => setImmediate(r));
  assert.strictEqual(calls.withdraw.length, 1);
  assert.strictEqual(calls.recordEarnings.length, 0, 'nothing recorded before the transfer lands');
  d.resolve('SIGX');
  await done;
  assert.strictEqual(calls.recordEarnings.length, 1);
  assert.deepStrictEqual(calls.recordEarnings[0].slice(0, 3), [calls.withdraw[0][0], 'amy', 0.09]);
});

test('a rejection records a failed payout with e.broadcast and makes zero further withdraw calls', async (t) => {
  const { deps, calls } = fakes({
    withdraw: (w, a) => {
      calls.withdraw.push([w, a]);
      const e = new Error('rpc down');
      e.broadcast = true;
      return Promise.reject(e);
    }
  });
  quiet(t, calls);
  const pay = create(deps);
  await pay.payCashout(order({ grossMicro: 1000000, label: 'dollar' }));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(calls.withdraw.length, 1);
  assert.strictEqual(calls.recordEarnings.length, 0);
  assert.strictEqual(calls.recordFailedPayout.length, 1);
  const [wallet, amount, name, reason, broadcast] = calls.recordFailedPayout[0];
  assert.strictEqual(amount, 0.9);
  assert.strictEqual(name, 'amy');
  assert.ok(reason.startsWith('paper dollar: rpc down'));
  assert.strictEqual(broadcast, true);
  assert.ok(wallet.startsWith('WALLET'));
  assert.strictEqual(calls.emits.filter(e => e[1] === 'pp:payerror').length, 1);
});

test('two orders from same-label rooms each pay; the same order dispatched twice pays once and logs', async (t) => {
  const { deps, calls } = fakes();
  quiet(t, calls);
  const pay = create(deps);
  const a = order({ label: 'paper_na_s0_5' });
  const b = order({ label: 'paper_na_s0_5' });
  await pay.payCashout(a);
  await pay.payCashout(b);
  assert.strictEqual(calls.withdraw.length, 2);
  await pay.payCashout(a);
  assert.strictEqual(calls.withdraw.length, 2, 'duplicate order paid once');
  assert.strictEqual(calls.trackEarning.length, 2);
  assert.ok(calls.log.some(l => l[0] === 'error' && l[1].includes('[PAPER] CASHOUT duplicate id')));
});

test('a throwing trackEarning or sweepRake still yields exactly one withdraw', async (t) => {
  const { deps, calls } = fakes();
  quiet(t, calls);
  deps.trackEarning = () => { throw new Error('posthog down'); };
  deps.sweepRake = () => { throw new Error('sweep down'); };
  deps.io = { to: () => { throw new Error('io gone'); } };
  const pay = create(deps);
  await pay.payCashout(order());
  assert.strictEqual(calls.withdraw.length, 1);
  assert.strictEqual(calls.recordEarnings.length, 1);
});

test('a free cash-out (gross 0) sends nothing and records nothing', async (t) => {
  const { deps, calls } = fakes();
  quiet(t, calls);
  const pay = create(deps);
  await pay.payCashout(order({ grossMicro: 0, wallet: null, label: 'free' }));
  assert.strictEqual(calls.withdraw.length, 0);
  assert.strictEqual(calls.trackEarning.length, 0);
  assert.strictEqual(calls.sweepRake.length, 0);
  await pay.payCashout(order({ grossMicro: 1.5 }));
  await pay.payCashout(order({ grossMicro: -100 }));
  assert.strictEqual(calls.withdraw.length, 0, 'non-integer or negative gross is refused');
});

test('refunds are bounded by what landed on-chain, capped at the rung', async (t) => {
  const { deps, calls } = fakes();
  quiet(t, calls);
  const pay = create(deps);
  await pay.refund({ wallet: 'W1', name: 'a', micro: 100000, paid: 0.099, why: 'full' });
  await pay.refund({ wallet: 'W2', name: 'b', micro: 1000000, paid: 1.5, why: 'full' });
  await pay.refund({ wallet: 'W3', name: 'c', micro: 1000000, paid: undefined, why: 'maintenance' });
  await pay.refund({ wallet: 'W4', name: 'd', micro: 100000, paid: NaN, why: 'seat-failed' });
  assert.deepStrictEqual(calls.withdraw.map(w => [w[0], Math.round(w[1] * 1e6)]), [['W1', 99000], ['W2', 1000000], ['W3', 1000000], ['W4', 100000]]);
  assert.strictEqual(calls.recordEarnings.length, 0, 'a refund is never earnings');
  assert.strictEqual(calls.trackEarning.length, 0, 'a refund takes no rake');
  assert.strictEqual(calls.sweepRake.length, 0);
});

test('refund logs before withdraw; a failed refund row reason begins with refund', async (t) => {
  const order = [];
  const { deps, calls } = fakes({
    withdraw: (w, a) => {
      order.push('withdraw');
      calls.withdraw.push([w, a]);
      return Promise.reject(new Error('blockhash expired'));
    }
  });
  t.mock.method(console, 'log', (...a) => { if (String(a[0]).includes('[PAPER] REFUND')) order.push('log'); });
  t.mock.method(console, 'error', () => {});
  const pay = create(deps);
  await pay.refund({ wallet: 'W9', name: 'zed', micro: 100000, paid: 0.1, why: 'full' });
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(order, ['log', 'withdraw']);
  assert.strictEqual(calls.recordFailedPayout.length, 1);
  const reason = calls.recordFailedPayout[0][3];
  assert.ok(reason.startsWith('refund paper full: blockhash expired'), reason);
  assert.strictEqual(calls.recordFailedPayout[0][1], 0.1);
  assert.strictEqual(calls.withdraw.length, 1);
  assert.strictEqual(calls.recordEarnings.length, 0);
});

test('sweepFloor records paper_floor on the rake path, never earnings; a duplicate id records nothing and logs', (t) => {
  const { deps, calls } = fakes();
  quiet(t, calls);
  const pay = create(deps);
  const s = { sweepId: 'sw-1', micro: 250000, srcWallet: 'WS', srcName: 'sam', label: 'paper_na_s0_5', pid: 7 };
  assert.strictEqual(pay.sweepFloor(s), true);
  assert.deepStrictEqual(calls.trackEarning, [{ source: 'paper_floor', game: 'paper', amountUsdc: 0.25, wallet: 'WS', name: 'sam', lobbyType: 'paper_na_s0_5', region: 'na' }]);
  assert.deepStrictEqual(calls.sweepRake, [[0.25, 'paper floor paper_na_s0_5']]);
  assert.strictEqual(calls.recordEarnings.length, 0);
  assert.strictEqual(calls.withdraw.length, 0, 'the sweep itself is the rake path, no player payout');
  assert.ok(calls.log.some(l => l[1] === '[PAPER] SWEEP paper_na_s0_5 7 250000 WS'));
  assert.strictEqual(pay.sweepFloor(s), false);
  assert.strictEqual(calls.trackEarning.length, 1);
  assert.strictEqual(calls.sweepRake.length, 1);
  assert.ok(calls.log.some(l => l[0] === 'error' && l[1].includes('[PAPER] SWEEP duplicate id')));
});
