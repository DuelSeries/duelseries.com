'use strict';
// The lobby's cashed-out strip (server/earnings): what counts, the cache, the off switch.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEarnings, summarize, displayName, EARNINGS_SQL } = require('../server/earnings');
const { TOP_SQL } = require('../server/sl/slTopCashout');

const OWNER = 'C5cnzckMwH459eEURA8NwuZcKVFMExpRcbRSAuULH3m9';
const REV = '24tf4BRDWvnAjFhpPxKczZSnWdUjKkVbXAc8x7Yj4Fff';
const A = 'AAAAbbbbccccddddeeeeffffgggghhhhiiiijjjjZZ11';
const B = 'BBBBbbbbccccddddeeeeffffgggghhhhiiiijjjjZZ22';
const CFG = { SHOW: true, MIN_TOTAL_USD: 0, REFRESH_MS: 60000, TIME_ZONE: 'America/Toronto' };
const quiet = { warn() {}, error() {}, log() {} };

const row = (wallet, game, age, n, rake, best, name) => ({ wallet, game, age, n, rake: String(rake),
  best_rake: String(best == null ? rake : best), name: name === undefined ? null : name });

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'earn-')), 'earnings-switch.json');
}

function fakeQuery(rows) {
  const calls = [];
  const q = (sql, params) => { calls.push({ sql, params }); return Promise.resolve({ rows: typeof rows === 'function' ? rows(params) : rows }); };
  q.calls = calls;
  return q;
}

test('the landed rule is the biggest-cash-out box\'s rule, clause for clause', () => {
  const where = (s) => s.slice(s.indexOf("WHERE h.source = 'game_rake'"), s.search(/\n\s*(ORDER|GROUP) BY/));
  assert.ok(where(TOP_SQL).length > 200);
  assert.strictEqual(where(EARNINGS_SQL), where(TOP_SQL));
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(EARNINGS_SQL), 'read only');
});

test('take-home is 9 x the rake, split into today, this week and all time', () => {
  const v = summarize([
    row(A, 'slither', 0, 2, 0.30, 0.15, 'neo'),     // $2.70 today
    row(A, 'paper', 3, 1, 0.05, null, 'neo'),       // $0.45 this week
    row(B, 'agar', 10, 1, 1.00, null, 'trin'),      // $9.00 older
  ]);
  assert.strictEqual(v.total, 12.15);
  assert.strictEqual(v.count, 4);
  assert.strictEqual(v.periods.today.total, 2.7);
  assert.strictEqual(v.periods.week.total, 3.15);
  assert.strictEqual(v.periods.all.total, 12.15);
  assert.deepStrictEqual(v.bestToday, { amount: 1.35, game: 'slither.io' });
  assert.deepStrictEqual(v.periods.all.top.map((r) => [r.name, r.amount, r.game, r.n]),
    [['trin', 9, 'agar.io', 1], ['neo', 3.15, 'slither.io', 3]]);
  assert.deepStrictEqual(v.periods.today.top.map((r) => r.name), ['neo']);
});

test('no cash-out today means no "biggest today"', () => {
  const v = summarize([row(A, 'slither', 2, 1, 0.15)]);
  assert.strictEqual(v.bestToday, null);
  assert.deepStrictEqual(v.periods.today, { total: 0, count: 0, top: [] });
});

test('top 10 only, biggest first', () => {
  const rows = [];
  for (let i = 0; i < 14; i++) rows.push(row('W' + String(i).padStart(3, '0') + 'x'.repeat(40), 'slither', 0, 1, 0.01 * (i + 1), null, 'p' + i));
  const v = summarize(rows);
  assert.strictEqual(v.periods.all.top.length, 10);
  assert.strictEqual(v.periods.all.top[0].name, 'p13');
  assert.strictEqual(v.periods.all.top[9].name, 'p4');
});

test('names: the display name, else a short wallet; never a full wallet', () => {
  assert.strictEqual(displayName('neo', A), 'neo');
  assert.strictEqual(displayName(null, A), 'AAAA…ZZ11');
  assert.strictEqual(displayName('Player', A), 'AAAA…ZZ11');
  assert.strictEqual(displayName('  ', A), 'AAAA…ZZ11');
  assert.strictEqual(displayName('x'.repeat(40), A).length, 24);
  const v = summarize([row(A, 'slither', 0, 1, 0.15), row(B, 'agar', 0, 1, 0.2, null, 'Player')]);
  const json = JSON.stringify(v);
  assert.ok(!json.includes(A) && !json.includes(B), 'no full wallet in the answer');
});

test('an untrustworthy row set is refused, not half-used', () => {
  assert.strictEqual(summarize(null), null);
  assert.strictEqual(summarize([row('', 'slither', 0, 1, 0.1)]), null);
  assert.strictEqual(summarize([row(A, 'slither', 0, 1, 'NaN')]), null);
  assert.strictEqual(summarize([row(A, 'slither', 0, 0, 0.1)]), null);
});

test('the owner and revenue wallets are excluded; the preview lets only the owner in', async () => {
  const q = fakeQuery([row(A, 'slither', 0, 1, 0.15, null, 'neo')]);
  const e = createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV], config: CFG, log: quiet });
  await e.answer(false);
  await e.answer(true);
  assert.strictEqual(q.calls.length, 2);
  assert.deepStrictEqual(q.calls[0].params[1].slice().sort(), [OWNER, REV].sort());
  assert.deepStrictEqual(q.calls[1].params[1], [REV]);
  assert.strictEqual(q.calls[0].params[4], 'America/Toronto');
  assert.throws(() => createEarnings({ query: q, excludeWallets: [REV], previewExclude: [REV], config: CFG }), /owner and revenue/);
  assert.throws(() => createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [], config: CFG }), /revenue/);
  assert.throws(() => createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [A], config: CFG }), /subset/);
});

test('one read per period however many lobbies ask, and concurrent asks share it', async () => {
  let t = 1000;
  const q = fakeQuery([row(A, 'slither', 0, 1, 0.15, null, 'neo')]);
  const e = createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV], config: CFG,
    now: () => t, log: quiet });
  const first = await Promise.all([e.answer(false), e.answer(false), e.answer(false)]);
  assert.strictEqual(q.calls.length, 1);
  for (const a of first) assert.strictEqual(a.total, 1.35);
  for (let i = 0; i < 50; i++) await e.answer(false);
  assert.strictEqual(q.calls.length, 1);
  t += 60000;
  await e.answer(false);
  await e.answer(false);
  assert.strictEqual(q.calls.length, 2);
});

test('nothing real cashed out means nothing shown, even with the owner\'s own cash-outs in the database', async () => {
  // The real query leaves the owner out, so the public read sees no rows; the preview sees his.
  const q = fakeQuery((params) => (params[1].includes(OWNER) ? [] : [row(OWNER, 'slither', 0, 33, 1.86, 0.15, 'owen')]));
  const e = createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV], config: CFG, log: quiet });
  assert.deepStrictEqual(await e.answer(false), { on: false });
  const p = await e.answer(true);
  assert.strictEqual(p.on, true);
  assert.strictEqual(p.preview, true);
  assert.strictEqual(p.total, 16.74);
});

test('MIN_TOTAL_USD holds the strip back until real cash-outs reach it', async () => {
  const q = fakeQuery([row(A, 'slither', 0, 1, 0.15)]);
  const e = createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV],
    config: { ...CFG, MIN_TOTAL_USD: 25 }, log: quiet });
  assert.deepStrictEqual(await e.answer(false), { on: false });
  assert.strictEqual((await e.answer(true)).on, true, 'the preview ignores the threshold');
});

test('SHOW false in config hides it everywhere and reads nothing', async () => {
  const q = fakeQuery([row(A, 'slither', 0, 1, 0.15)]);
  const e = createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV],
    config: { ...CFG, SHOW: false }, log: quiet });
  assert.deepStrictEqual(await e.answer(false), { on: false });
  assert.deepStrictEqual(await e.answer(true), { on: false });
  assert.strictEqual(q.calls.length, 0);
});

test('the console hide is saved across a restart and Show clears it', async () => {
  const file = tmpFile();
  const q = fakeQuery([row(A, 'slither', 0, 1, 0.15)]);
  const mk = () => createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV], switchFile: file,
    config: CFG, log: quiet });
  const e1 = mk();
  assert.strictEqual((await e1.answer(false)).on, true);
  assert.deepStrictEqual(e1.setHidden(true), { ok: true });
  assert.deepStrictEqual(await e1.answer(false), { on: false });
  assert.ok(fs.existsSync(file));
  const e2 = mk();   // a restart
  assert.strictEqual(e2.hidden(), true);
  assert.deepStrictEqual(await e2.answer(false), { on: false });
  e2.setHidden(false);
  assert.ok(!fs.existsSync(file));
  assert.strictEqual((await e2.answer(false)).on, true);
});

test('a failing database hides it at first and keeps the last good value after', async () => {
  let t = 0, fail = true;
  const q = (sql, params) => (fail ? Promise.reject(new Error('db down')) : Promise.resolve({ rows: [row(A, 'slither', 0, 1, 0.15)] }));
  const e = createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV], config: CFG,
    now: () => t, log: quiet });
  assert.deepStrictEqual(await e.answer(false), { on: false });
  fail = false; t += 60000;
  await e.answer(false);                       // kicks the refresh
  await new Promise((r) => setImmediate(r));
  assert.strictEqual((await e.answer(false)).total, 1.35);
  fail = true; t += 60000;
  await e.answer(false);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual((await e.answer(false)).total, 1.35, 'kept the last good value');
});

test('no database: never shown', async () => {
  const e = createEarnings({ query: null, excludeWallets: [OWNER, REV], previewExclude: [REV], config: CFG, log: quiet });
  assert.deepStrictEqual(await e.answer(false), { on: false });
  assert.deepStrictEqual(await e.answer(true), { on: false });
});
