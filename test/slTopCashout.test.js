'use strict';
// slTopCashout (SERVER-DESIGN 15.4 and 18.1, task T13): the biggest all-time TAKE-HOME cash-out across every game,
// landed payouts only, owner, revenue and named test wallets left out, a genuine empty state, last value kept on a
// rejected refresh, no box without a database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  createTopCashout,
  makeTopCashoutRead,
  memTopQuery,
  takeHomeCents,
  topCashoutParams,
  TOP_SQL,
  TOP_ROWS,
  TOP_LAW_IDS,
  TOP_PERIOD_MS,
  EMPTY,
} = require('../server/sl/slTopCashout');

// server/index.js OWNER_WALLET and REVENUE_WALLET, copied as literals.
const OWNER = 'C5cnzckMwH459eEURA8NwuZcKVFMExpRcbRSAuULH3m9';
const REV = '24tf4BRDWvnAjFhpPxKczZSnWdUjKkVbXAc8x7Yj4Fff';
const TESTW = 'TestWa11etNamedByOwen1111111111111111111111';
const SINCE = '2026-06-24T21:07:21Z';

const rake = (id, wallet, name, amount, at, extra) => Object.assign({
  id, source: 'game_rake', game: 'slither', amount_usdc: amount, player_wallet: wallet, player_name: name,
  created_at: at,
}, extra || {});
const paid = (wallet, amount, at) => ({ google_id: wallet, amount, created_at: at });
const failed = (wallet, at) => ({ wallet_address: wallet, created_at: at });

// Every row above Gina's 0.123456 is kept out for exactly one reason; Gina's agar cash-out is the true answer.
function tables() {
  return {
    house_revenue: [
      rake(1, OWNER, 'admin', '5.000000', '2026-10-01T00:00:00Z'),
      rake(2, REV, 'rake-sweep', '4.000000', '2026-10-01T00:00:00Z'),
      rake(3, TESTW, 'tester', '3.000000', '2026-10-01T00:00:00Z'),
      rake(4, 'WalletAnna', 'Anna', '2.500000', '2026-10-01T00:00:00Z', { source: 'cosmetic' }),
      rake(5, 'WalletBen', 'Ben', '2.000000', '2026-06-01T00:00:00Z'),
      rake(6, 'WalletCal', 'Cal', '1.500000', '2026-10-02T00:00:00Z'),
      rake(7, 'WalletDee', 'Dee', '1.200000', '2026-10-02T00:00:00Z'),
      rake(8, 'WalletEve', 'Eve', '1.100000', '2026-10-02T00:00:00Z'),
      rake(9, 'WalletFay', 'Fay', '1.000000', '2026-10-02T00:00:00Z'),
      rake(10, 'WalletIan', 'Ian', '1.050000', '2026-10-02T00:00:00Z'),
      rake(11, 'WalletGina', 'Gina', '0.123456', '2026-10-03T00:00:00Z', { game: 'agar' }),
      rake(12, 'WalletHal', 'Hal', '0.100000', '2026-10-04T00:00:00Z', { game: 'knockout' }),
      rake(13, null, 'Nobody', '9.000000', '2026-10-04T00:00:00Z'),
      rake(14, 'WalletBot', null, '-0.500000', '2026-10-04T00:00:00Z', { source: 'bot_cost' }),
    ],
    earnings_history: [
      paid(OWNER, '45.000000000', '2026-10-01T00:00:30Z'),
      paid(REV, '36.000000000', '2026-10-01T00:00:30Z'),
      paid(TESTW, '27.000000000', '2026-10-01T00:00:30Z'),
      paid('WalletAnna', '22.500000000', '2026-10-01T00:00:30Z'),
      paid('WalletBen', '18.000000000', '2026-06-01T00:00:30Z'),          // landed, but before C_TOP_SINCE
      paid('WalletCal', '13.500000000', '2026-10-02T00:02:00Z'),          // landed row, but a failure too
      // Dee: no earnings row at all (payout never confirmed)
      paid('WalletEve', '9.900000000', '2026-10-02T00:11:00Z'),           // 11 minutes later: outside the window
      paid('WalletFay', '20.000000000', '2026-10-02T00:03:00Z'),          // an event prize, not 9 x 1.00
      paid('WalletIan', '9.450000000', '2026-10-01T23:59:00Z'),           // written BEFORE the rake row
      paid('WalletGina', '1.111104000', '2026-10-03T00:00:30Z'),          // 9 x 0.123456 exactly
      paid('WalletHal', '0.900000000', '2026-10-04T00:00:05Z'),
      paid(null, '81.000000000', '2026-10-04T00:00:05Z'),
    ],
    failed_payouts: [
      failed('WalletCal', '2026-10-02T00:01:00Z'),
    ],
  };
}

const GINA = { t: 'top', name: 'Gina', amount: 1.11 };
const sameMsg = (got, want) => {
  assert.strictEqual(got.t, want.t);
  assert.strictEqual(got.name, want.name);
  assert.strictEqual(got.amount, want.amount);
};
const memRead = (t) => makeTopCashoutRead(memTopQuery(t));
const quiet = () => {};

test('C_TOP rows: since the USDC cutover, no named test wallet yet, 10 minute landed window, 10 micro amount match', () => {
  assert.strictEqual(TOP_LAW_IDS.join(','), 'C_TOP_SINCE,C_TOP_EXCLUDE,C_TOP_LANDED');
  assert.strictEqual(TOP_ROWS.C_TOP_SINCE.value, '2026-06-24T21:07:21Z');
  assert.strictEqual(TOP_ROWS.C_TOP_EXCLUDE.value.length, 0);
  assert.strictEqual(TOP_ROWS.C_TOP_LANDED.value.windowS, 600);
  assert.strictEqual(TOP_ROWS.C_TOP_LANDED.value.tolMicro, 10);
  assert.strictEqual(TOP_PERIOD_MS, 60000);
  for (const id of TOP_LAW_IDS) assert.ok(TOP_ROWS[id].source.length > 10, id + ' has a source');
  assert.ok(Object.isFrozen(TOP_ROWS) && Object.isFrozen(TOP_ROWS.C_TOP_EXCLUDE.value));
});

test('take-home = 9 x rake in whole cents, half up', () => {
  assert.strictEqual(takeHomeCents('0.010000'), 9);
  assert.strictEqual(takeHomeCents('0.100000'), 90);
  assert.strictEqual(takeHomeCents(0.1), 90);
  assert.strictEqual(takeHomeCents('1.000000'), 900);
  assert.strictEqual(takeHomeCents('0.123456'), 111);
  assert.strictEqual(takeHomeCents('0.005000'), 5);     // 4.5 cents rounds up
  assert.strictEqual(takeHomeCents('0.000555'), 0);     // 0.4995 cents
  assert.strictEqual(takeHomeCents('0.000556'), 1);     // 0.5004 cents
  assert.strictEqual(takeHomeCents('0.055556'), 50);    // 50.0004 cents
  assert.strictEqual(takeHomeCents('2.222222'), 2000);  // 19.999998 dollars
  assert.ok(Number.isNaN(takeHomeCents('abc')));
});

test('the query picks the largest LANDED game_rake row since C_TOP_SINCE, exclusions applied, amount x 9', async () => {
  const read = memRead(tables());
  const row = await read(SINCE, [OWNER, REV, TESTW]);
  assert.strictEqual(row.name, 'Gina');
  assert.strictEqual(row.rake, '0.123456');
  assert.strictEqual(row.wallet, 'WalletGina');
  assert.strictEqual(row.game, 'agar');
  const top = createTopCashout({ topCashout: read, excludeWallets: [OWNER, REV, TESTW], log: quiet });
  sameMsg(await top.refresh(), GINA);
  sameMsg(top.get(), GINA);
});

test('each exclusion is what keeps its row out: drop it and that row wins', async () => {
  const read = memRead(tables());
  assert.strictEqual((await read(SINCE, [REV, TESTW])).name, 'admin');
  assert.strictEqual((await read(SINCE, [OWNER, TESTW])).name, 'rake-sweep');
  assert.strictEqual((await read(SINCE, [OWNER, REV])).name, 'tester');
  assert.strictEqual((await read('2026-01-01T00:00:00Z', [OWNER, REV, TESTW])).name, 'Ben');
});

test('landed rule: a failure, a missing payout, a late payout, a wrong amount or an earlier payout never count', async () => {
  const base = tables();
  const only = (name) => ({
    house_revenue: base.house_revenue.filter((h) => h.player_name === name),
    earnings_history: base.earnings_history,
    failed_payouts: base.failed_payouts,
  });
  for (const name of ['Cal', 'Dee', 'Eve', 'Fay', 'Ian', 'Anna', 'Nobody', null]) {
    assert.strictEqual(await memRead(only(name))(SINCE, [OWNER]), null, String(name));
  }
  // The same rows with the reason removed do count (the window edge is inclusive, as SQL <=).
  const cal = only('Cal');
  cal.failed_payouts = [];
  assert.strictEqual((await memRead(cal)(SINCE, [OWNER])).name, 'Cal');
  const eve = only('Eve');
  eve.earnings_history = [paid('WalletEve', '9.900000000', '2026-10-02T00:10:00Z')];
  assert.strictEqual((await memRead(eve)(SINCE, [OWNER])).name, 'Eve');
  // Paper's floor cut: net = gross - floor(gross / 10), 9 micro over 9 x rake still matches; 11 micro does not.
  const paper = {
    house_revenue: [rake(1, 'WalletPia', 'Pia', '0.100000', '2026-10-05T00:00:00Z', { game: 'paper' })],
    earnings_history: [paid('WalletPia', '0.900009000', '2026-10-05T00:00:20Z')],
    failed_payouts: [],
  };
  assert.strictEqual((await memRead(paper)(SINCE, [OWNER])).name, 'Pia');
  paper.earnings_history = [paid('WalletPia', '0.900011000', '2026-10-05T00:00:20Z')];
  assert.strictEqual(await memRead(paper)(SINCE, [OWNER]), null);
});

test('equal rakes: the earlier payout wins', async () => {
  const t = {
    house_revenue: [
      rake(2, 'WalletLate', 'Late', '0.500000', '2026-10-06T00:00:00Z'),
      rake(1, 'WalletEarly', 'Early', '0.500000', '2026-10-05T00:00:00Z'),
    ],
    earnings_history: [
      paid('WalletLate', '4.500000000', '2026-10-06T00:00:10Z'),
      paid('WalletEarly', '4.500000000', '2026-10-05T00:00:10Z'),
    ],
    failed_payouts: [],
  };
  assert.strictEqual((await memRead(t)(SINCE, [OWNER])).name, 'Early');
});

test('nothing qualifying gives the empty state, never a number', async () => {
  const t = tables();
  t.house_revenue = t.house_revenue.filter((h) => [OWNER, REV, TESTW].includes(h.player_wallet));
  const top = createTopCashout({ topCashout: memRead(t), excludeWallets: [OWNER, REV, TESTW], log: quiet });
  const got = await top.refresh();
  assert.strictEqual(got, EMPTY);
  assert.strictEqual(got.t, 'top');
  assert.strictEqual(got.name, null);
  assert.strictEqual(got.amount, null);
  const none = createTopCashout({ topCashout: memRead({}), excludeWallets: [OWNER], log: quiet });
  assert.strictEqual(await none.refresh(), EMPTY);
});

test('the read gets C_TOP_SINCE and the owner, revenue and named wallets, once each', async () => {
  const calls = [];
  const top = createTopCashout({
    topCashout: (since, exclude) => { calls.push([since, exclude]); return Promise.resolve(null); },
    excludeWallets: new Set([OWNER, REV, OWNER, '', 7]),
    log: quiet,
  });
  await top.refresh();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], '2026-06-24T21:07:21Z');
  assert.strictEqual(calls[0][1].join(','), OWNER + ',' + REV);
  const p = topCashoutParams(SINCE, [OWNER]);
  assert.strictEqual(p.length, 4);
  assert.strictEqual(p[0], SINCE);
  assert.strictEqual(p[1].join(','), OWNER);
  assert.strictEqual(p[2], 600);
  assert.strictEqual(p[3], 0.00001);
});

test('a rejected or broken refresh keeps the last value; before any good read the box stays hidden', async () => {
  const logs = [];
  let mode = 'reject';
  const reader = () => {
    if (mode === 'reject') return Promise.reject(new Error('db down'));
    if (mode === 'throw') throw new Error('sync throw');
    if (mode === 'junk') return Promise.resolve({ name: 'X', rake: 'abc' });
    if (mode === 'undef') return Promise.resolve(undefined);
    if (mode === 'owner') return Promise.resolve({ name: 'admin', rake: '9.000000', wallet: OWNER });
    if (mode === 'zero') return Promise.resolve({ name: 'Z', rake: '0' });
    return Promise.resolve({ name: 'Gina', rake: '0.123456', wallet: 'WalletGina' });
  };
  const top = createTopCashout({ topCashout: reader, excludeWallets: [OWNER, REV], log: (m) => logs.push(m) });
  assert.strictEqual(await top.refresh(), null);       // first read failed: hidden, NOT "No cash-outs yet"
  assert.strictEqual(top.get(), null);
  mode = 'good';
  sameMsg(await top.refresh(), GINA);
  for (const m of ['reject', 'throw', 'junk', 'undef', 'owner', 'zero']) {
    mode = m;
    sameMsg(await top.refresh(), GINA);
    sameMsg(top.get(), GINA);
  }
  const s = top.stats();
  assert.strictEqual(s.reads, 1);
  assert.strictEqual(s.fails, 7);
  assert.strictEqual(logs.length, 7);
  assert.ok(logs.every((m) => m.startsWith('[sl] top cash-out')));
});

test('no database hides the box', async () => {
  for (const db of [null, undefined, {}]) {
    const top = createTopCashout({ topCashout: db, excludeWallets: [OWNER], log: quiet });
    assert.strictEqual(top.get(), null);
    assert.strictEqual(top.start(() => assert.fail('no push without a database')), false);
    assert.strictEqual(await top.refresh(), null);
    assert.strictEqual(top.get(), null);
    assert.strictEqual(top.stats().hidden, true);
    top.stop();
  }
  const t = createTopCashout({ topCashout: null, log: quiet });
  assert.strictEqual(t.get(), null);
});

test('refuses to run without the owner and revenue exclusions, or with a bad period', () => {
  const r = () => Promise.resolve(null);
  assert.throws(() => createTopCashout({ topCashout: r, log: quiet }), /excludeWallets/);
  assert.throws(() => createTopCashout({ topCashout: r, excludeWallets: [], log: quiet }), /excludeWallets/);
  assert.throws(() => createTopCashout({ topCashout: r, excludeWallets: ['', null], log: quiet }), /excludeWallets/);
  assert.throws(() => createTopCashout({ topCashout: r, excludeWallets: [OWNER], periodMs: 0, log: quiet }), /periodMs/);
  assert.throws(() => createTopCashout({ topCashout: r, excludeWallets: [OWNER], periodMs: NaN, log: quiet }), /periodMs/);
});

test('push on the first value and on change only; a throwing push never breaks the box', async () => {
  let row = { name: 'Hal', rake: '0.100000' };
  const pushes = [];
  let ticks = null;
  let stopped = 0;
  const every = (fn, ms, label) => { ticks = { fn, ms, label }; return () => { stopped++; }; };
  const top = createTopCashout({ topCashout: () => Promise.resolve(row), excludeWallets: [OWNER], every, log: quiet });
  assert.strictEqual(top.start((m) => { pushes.push(m); if (m.name === 'Boom') throw new Error('socket gone'); }), true);
  assert.strictEqual(top.start(), true);                // a second start keeps one timer and the same push
  assert.strictEqual(ticks.ms, 60000);
  assert.strictEqual(ticks.label, 'slTopCashout');
  await top.refresh();
  assert.strictEqual(pushes.length, 1);
  sameMsg(pushes[0], { t: 'top', name: 'Hal', amount: 0.9 });
  ticks.fn();
  await top.refresh();
  assert.strictEqual(pushes.length, 1);                 // same value: no push
  row = { name: 'Boom', rake: '1.000000' };
  ticks.fn();
  await top.refresh();
  assert.strictEqual(pushes.length, 2);
  sameMsg(top.get(), { t: 'top', name: 'Boom', amount: 9 });
  row = null;
  await top.refresh();
  assert.strictEqual(pushes.length, 3);
  assert.strictEqual(pushes[2], EMPTY);
  top.stop();
  assert.strictEqual(stopped, 1);
  row = { name: 'After', rake: '2.000000' };
  await top.refresh();
  assert.strictEqual(pushes.length, 3);                 // no push after stop
  assert.strictEqual(top.get().name, 'After');
});

test('a blank name shows as Player; one read at a time', async () => {
  let release;
  let calls = 0;
  const top = createTopCashout({
    topCashout: () => { calls++; return new Promise((r) => { release = r; }); },
    excludeWallets: [OWNER],
    log: quiet,
  });
  const a = top.refresh();
  const b = top.refresh();
  assert.strictEqual(a, b);
  assert.strictEqual(calls, 1);
  release({ name: '   ', rake: '0.010000' });
  sameMsg(await a, { t: 'top', name: 'Player', amount: 0.09 });
  top.refresh();
  assert.strictEqual(calls, 2);
  release({ name: null, rake: '0.010000' });
});

test('the real interval refreshes on its period and stops', async () => {
  let calls = 0;
  const top = createTopCashout({
    topCashout: () => { calls++; return Promise.resolve(null); },
    excludeWallets: [OWNER],
    periodMs: 10,
    log: quiet,
  });
  top.start();
  const t0 = Date.now();
  while (calls < 3 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 5));
  top.stop();
  assert.ok(calls >= 3, 'refreshed ' + calls + ' times');
  const n = calls;
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(calls, n);
});

test('makeTopCashoutRead maps the SQL row and passes TOP_SQL with the four params', async () => {
  const seen = [];
  const read = makeTopCashoutRead((sql, params) => {
    seen.push([sql, params]);
    return Promise.resolve({ rows: [{ id: 3, player_name: 'Kim', player_wallet: 'WalletKim', amount_usdc: '0.250000',
      game: 'battleship', created_at: '2026-10-07T00:00:00Z' }] });
  });
  const row = await read(SINCE, [OWNER, REV]);
  assert.strictEqual(seen[0][0], TOP_SQL);
  assert.strictEqual(seen[0][1].join('|'), SINCE + '|' + OWNER + ',' + REV + '|600|0.00001');
  assert.strictEqual(row.name, 'Kim');
  assert.strictEqual(row.rake, '0.250000');
  assert.strictEqual(row.wallet, 'WalletKim');
  assert.strictEqual(row.game, 'battleship');
  assert.strictEqual(await makeTopCashoutRead(() => Promise.resolve({ rows: [] }))(SINCE, [OWNER]), null);
  assert.throws(() => makeTopCashoutRead(null), /query function/);
  await assert.rejects(memTopQuery({})('SELECT 1', []), /TOP_SQL only/);
});

test('TOP_SQL holds every clause of the rule (the in-memory model mirrors these one for one)', () => {
  const sql = TOP_SQL.replace(/\s+/g, ' ');
  for (const clause of [
    "FROM house_revenue h",
    "h.source = 'game_rake'",
    "h.amount_usdc > 0",
    "h.created_at >= $1::timestamptz",
    "h.player_wallet IS NOT NULL",
    "h.player_wallet <> ALL ($2::text[])",
    "EXISTS (SELECT 1 FROM earnings_history e WHERE e.google_id = h.player_wallet",
    "AND e.created_at >= h.created_at AND e.created_at <= h.created_at + make_interval(secs => $3)",
    "AND abs(e.amount - 9 * h.amount_usdc) <= $4::numeric)",
    "NOT EXISTS (SELECT 1 FROM failed_payouts f WHERE f.wallet_address = h.player_wallet",
    "AND f.created_at >= h.created_at AND f.created_at <= h.created_at + make_interval(secs => $3))",
    "ORDER BY h.amount_usdc DESC, h.created_at ASC, h.id ASC LIMIT 1",
  ]) assert.ok(sql.includes(clause), clause);
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(TOP_SQL), 'read only');
});

test('no database or money module: slTopCashout requires nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'sl', 'slTopCashout.js'), 'utf8');
  assert.strictEqual(/require\s*\(/.test(src), false);
  assert.strictEqual(/Math\.random/.test(src), false);
});
