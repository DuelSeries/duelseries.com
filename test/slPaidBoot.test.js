'use strict';
// Opening paid snake on the sl engine at boot (server/slPaid/slPaidBoot.js; PAID-SL-DESIGN.md 2, 6 and 10; task T5),
// without booting the server (test/slPaidJoinSmoke.test.js does that). The real free SlArenas and slSockets (slSockFakes
// rig), a real entry store, the real paid directory and door:
//   - SL_PAID: OFF by default, agar's parser (a typo fails closed and says so)
//   - no sockets (SL_ENABLED off or refused): nothing is built and nothing attached (critic C-4)
//   - on: the rungs and the door, attached; off: no rungs, and a paid page is refunded not-open once, never seated free
//   - the rungs fail to build: the off directory; the door fails to build: a helper that refuses not-open with the token
//     untouched (its expiry refunds it), never the free room
//   - the cash-out status map: lowercase uuids only, pending then sent or delayed, a TTL and a cap
const test = require('node:test');
const assert = require('node:assert/strict');
const { rig, layerMsgs } = require('./slSockFakes');
const { moneySpy, fakeLedger, fakePayout } = require('./slPaidFakes');
const { makeEntryStore } = require('../server/entryStore');
const { isStake } = require('../server/stakeRules');
const { slPaidSwitch, SL_PAID_DEFAULT, openSlPaid, createCashoutStatus, isCashoutId, STATUS_MAX } =
  require('../server/slPaid/slPaidBoot');
const { STATUS_TTL_MS } = require('../server/slPaid/slPaidConst');

function lines() {
  const out = [];
  return { out, log: (...a) => out.push(a.join(' ')), warn: (...a) => out.push(a.join(' ')),
    error: (...a) => out.push(a.join(' ')) };
}

// The free rig plus everything openSlPaid takes; env: SL_PAID; patch(o): change the options before the call.
function opened(env, patch) {
  const r = rig();
  const money = moneySpy();
  const store = makeEntryStore({ isStake, now: () => r.wall.t });
  const payout = fakePayout();
  const lg = lines();
  const o = {
    env, sockets: r.sockets, laws: r.laws, region: 'na', shippableOnly: false, log: lg, hooks: money.hooks,
    door: { consumeAtStake: (t, s) => store.consumeAtStake(t, s, 'slither'), ledger: fakeLedger(), slPayout: payout,
      journal: money.journal, ops: { get: () => r.ops } },
    arenas: { clock: r.ft.clock, timers: r.ft.timers, now: () => r.wall.t, autoTick: false, prey: false, seed: 3,
      checkEvery: 1 },
  };
  if (patch) patch(o);
  const got = openSlPaid(o);
  const join = (token) => {
    r.wall.t += 1000;
    const s = r.sock({ auth: { paid: 1, stake: 0.5, entryToken: token, cv: 2 } });
    s.fire('sl:join', { nick: 'p' });
    return s;
  };
  const mint = (w) => store.mint({ stake: 0.5, worth: 0.5, paid: 0.5, walletAddress: w, onlyGame: 'slither' });
  return Object.assign({ r, money, store, payout, lg, got, join, mint });
}

const refusalOf = (s) => layerMsgs(s).find((m) => m.t === 'refused') || null;

test('SL_PAID is off by default; agar\'s parser, a typo fails closed and says so', () => {
  assert.equal(SL_PAID_DEFAULT, false, 'off in every build commit until the switch-on commit');
  const lg = lines();
  for (const v of [undefined, null, '', '  ']) assert.equal(slPaidSwitch(v, lg), false, JSON.stringify(v));
  for (const v of ['1', 'true', 'on', 'yes', ' ON ', 'Yes']) assert.equal(slPaidSwitch(v, lg), true, v);
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) assert.equal(slPaidSwitch(v, lg), false, v);
  assert.deepEqual(lg.out, [], 'no complaint for a switch value');
  assert.equal(slPaidSwitch('maybe', lg), false);
  assert.equal(slPaidSwitch('2', lg), false);
  assert.equal(lg.out.length, 2);
  assert.match(lg.out[0], /^\[SLP\] SL_PAID="maybe" is not a switch value; paid snake on the new engine stays OFF/);
});

test('no /sl sockets: nothing is built or attached, and the boot says why', () => {
  const lg = lines();
  const got = openSlPaid({ env: { SL_PAID: '1' }, sockets: null, log: lg });
  assert.deepEqual(got, { arenas: null, door: null, paid: false, why: 'no-sl' });
  assert.ok(lg.out.some((l) => /not built: \/sl is not open \(SL_ENABLED off or refused\), SL_PAID ignored/.test(l)));
  const quiet = lines();
  openSlPaid({ env: {}, sockets: { setPaid: undefined }, log: quiet });
  assert.ok(quiet.out.some((l) => /not built/.test(l) && !/SL_PAID ignored/.test(l)), 'SL_PAID unset: not named');
});

test('SL_PAID on: the rungs and the door are built and attached; a paid page is seated in the paid room', () => {
  const x = opened({ SL_PAID: '1' });
  assert.equal(x.got.paid, true);
  assert.equal(x.got.why, null);
  assert.ok(x.got.arenas.paidEnabled && x.got.arenas.paidOpen);
  assert.equal(x.r.sockets.paid(), true);
  assert.deepEqual(x.got.arenas.boardRows().map((row) => [row.id, row.state]), [['sl:na:s0.5', 'open'], ['sl:na:s1', 'open']]);
  const s = x.join(x.mint('WON'));
  assert.equal(refusalOf(s), null);
  assert.ok(x.got.arenas.roomOf(s.id), 'seated paid');
  assert.equal(x.r.room().seats.size, 0, 'never in the free room');
  assert.ok(x.lg.out.some((l) => l === '[SLP] paid snake on the new engine on (/sl paid rungs $0.50 and $1)'));
});

test('SL_PAID off (unset, 0 or a typo): no rungs, a paid page is refunded not-open once and never seated free', () => {
  for (const v of [undefined, '0', 'nope']) {
    const x = opened({ SL_PAID: v });
    assert.equal(x.got.paid, false, String(v));
    assert.equal(x.got.arenas.paidEnabled, false);
    assert.deepEqual(x.got.arenas.boardRows(), []);
    assert.equal(x.r.sockets.paid(), true, 'the helper is attached all the same');
    const token = x.mint('WOFF');
    const s = x.join(token);
    assert.deepEqual(refusalOf(s), { t: 'refused', why: 'not-open', refunded: 500000 });
    assert.deepEqual(x.payout.refunds.map((p) => [p.wallet, p.micro, p.why]), [['WOFF', 500000, 'not-open']]);
    assert.equal(x.store.consumeAtStake(token, 0.5, 'slither').ok, false, 'spent, once');
    assert.equal(x.r.room().seats.size, 0, 'never seated free');
    assert.ok(x.lg.out.some((l) => l === '[SLP] paid snake on the new engine OFF (paid /sl joins are refunded not-open)'));
  }
});

test('rungs that do not build leave the off directory: logged CRITICAL, a paid page refunded not-open', () => {
  const x = opened({ SL_PAID: '1' }, (o) => { o.hooks = Object.assign({}, o.hooks, { onCashout: undefined }); });
  assert.equal(x.got.paid, false);
  assert.match(x.got.why, /moneyHooks\.onCashout is required/);
  assert.ok(x.lg.out.some((l) => /CRITICAL paid snake rungs did not build/.test(l)));
  const s = x.join(x.mint('WBRK'));
  assert.deepEqual(refusalOf(s), { t: 'refused', why: 'not-open', refunded: 500000 });
  assert.equal(x.payout.refunds.length, 1);
});

test('a door that does not build leaves a helper refusing not-open with the token untouched, never the free room', () => {
  const x = opened({ SL_PAID: '1' }, (o) => { o.door = Object.assign({}, o.door, { slPayout: null }); });
  assert.deepEqual([x.got.arenas, x.got.door, x.got.paid], [null, null, false]);
  assert.match(x.got.why, /slPayout\.refund must be a function/);
  assert.equal(x.r.sockets.paid(), true, 'a helper is attached');
  const token = x.mint('WNODOOR');
  const s = x.join(token);
  assert.deepEqual(refusalOf(s), { t: 'refused', why: 'not-open', refunded: 0 });
  assert.equal(s.disconnected, true);
  assert.equal(x.r.room().seats.size, 0, 'never seated free');
  assert.equal(x.store.consumeAtStake(token, 0.5, 'slither').ok, true, 'the token was never spent: its expiry refunds it');
  // the paid socket's other calls land nowhere
  const t2 = x.r.sock({ auth: { paid: 1, stake: 0.5, cv: 2 } });
  t2.fire('sl:back', { k: 'x'.repeat(16), n: 0, p: 0 });
  assert.equal(x.r.room().seats.size, 0);
});

test('the cash-out status: lowercase uuids only, pending then sent or delayed, a TTL and a cap', () => {
  const clock = { t: 1000 };
  const st = createCashoutStatus({ now: () => clock.t, max: 3 });
  const id = (n) => 'abcdef00-0000-4000-8000-00000000000' + n;
  assert.equal(isCashoutId(id(1)), true);
  for (const bad of [id(1).toUpperCase(), 'abc', '', null, 5, id(1) + '0', '../' + id(1)]) {
    assert.equal(isCashoutId(bad), false, String(bad));
    assert.equal(st.set(bad, 'pending'), false);
    assert.equal(st.get(bad), null);
  }
  assert.equal(st.set(id(1), 'paid'), false, 'only the three states');
  assert.equal(st.set(id(1), 'pending'), true);
  assert.equal(st.get(id(1)), 'pending');
  clock.t += 1000;
  st.set(id(1), 'sent');
  assert.equal(st.get(id(1)), 'sent');
  st.set(id(2), 'pending');
  st.set(id(3), 'delayed');
  st.set(id(4), 'pending');
  assert.equal(st.size(), 3, 'at most max');
  assert.equal(st.get(id(1)), null, 'the oldest went first');
  assert.equal(st.get(id(4)), 'pending');
  clock.t += STATUS_TTL_MS;
  assert.equal(st.get(id(4)), null, 'gone after the TTL');
  assert.equal(st.size(), 0);
  assert.equal(STATUS_MAX, 5000);
});
