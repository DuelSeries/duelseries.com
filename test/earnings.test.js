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
  assert.deepStrictEqual(v.bestToday, { amount: 1.35, game: 'Slither.io' });
  assert.deepStrictEqual(v.periods.all.top.map((r) => [r.name, r.amount, r.game, r.n]),
    [['trin', 9, 'Agar.io', 1], ['neo', 3.15, 'Slither.io', 3]]);
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

/* ── Social's "Global player winnings" (/api/earnings/total) ─────────────── */

test('Global player winnings is the strip\'s total from the same read, and $0 is a real answer', async () => {
  // Every cash-out so far is the owner's: the public figure is $0, shown as $0, never his test play.
  const q = fakeQuery((params) => (params[1].includes(OWNER) ? [] : [row(OWNER, 'slither', 0, 33, 1.86, 0.15, 'owen')]));
  const e = createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV], config: CFG, log: quiet });
  assert.deepStrictEqual(await e.figure(false), { on: true, preview: false, total: 0, count: 0 });
  assert.deepStrictEqual(await e.answer(false), { on: false }, 'the strip still waits for a real cash-out');
  assert.strictEqual((await e.figure(true)).total, 16.74, 'only the preview lets the owner in');
  assert.strictEqual(q.calls.length, 2, 'one read each, shared with the strip');

  // Real cash-outs: the figure and the strip are the same number, from one read.
  const q2 = fakeQuery([row(A, 'slither', 0, 2, 0.30, 0.15, 'neo'), row(B, 'agar', 4, 1, 0.4, null, 'trin')]);
  const e2 = createEarnings({ query: q2, excludeWallets: [OWNER, REV], previewExclude: [REV], config: CFG, log: quiet });
  const [fig, strip] = await Promise.all([e2.figure(false), e2.answer(false)]);
  assert.strictEqual(fig.total, 6.3);
  assert.strictEqual(fig.total, strip.total);
  assert.strictEqual(fig.count, strip.count);
  assert.strictEqual(q2.calls.length, 1);
  assert.ok(!JSON.stringify(fig).includes(A), 'no wallet in the figure');
});

test('the figure obeys the strip\'s off switches, and no database means no figure', async () => {
  const q = fakeQuery([row(A, 'slither', 0, 1, 0.15)]);
  const off = createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV],
    config: { ...CFG, SHOW: false }, log: quiet });
  assert.deepStrictEqual(await off.figure(false), { on: false });
  const e = createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV], switchFile: tmpFile(),
    config: CFG, log: quiet });
  e.setHidden(true);
  assert.deepStrictEqual(await e.figure(false), { on: false });
  const none = createEarnings({ query: null, excludeWallets: [OWNER, REV], previewExclude: [REV], config: CFG, log: quiet });
  assert.deepStrictEqual(await none.figure(false), { on: false });
  // A first read that fails is not "$0": nothing is shown rather than a made-up zero.
  const bad = createEarnings({ query: () => Promise.reject(new Error('db down')), excludeWallets: [OWNER, REV],
    previewExclude: [REV], config: CFG, log: quiet });
  assert.deepStrictEqual(await bad.figure(false), { on: false });
});

test('a landed cash-out refreshes the figure within seconds, one read per burst', async () => {
  let t = 1000, rows = [];
  const timers = [];
  const q = fakeQuery(() => rows);
  const e = createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV],
    config: { ...CFG, POKE_MS: 5000 }, now: () => t, log: quiet,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; } });
  e.poke();
  assert.strictEqual(timers.length, 0, 'nothing is read for a figure nobody has asked for');
  assert.strictEqual((await e.figure(false)).total, 0);
  assert.strictEqual(q.calls.length, 1);

  // A real player cashes out 30 s later: one poke, read 1.5 s on, long before REFRESH_MS.
  t += 30000;
  rows = [row(A, 'slither', 0, 1, 0.4, null, 'neo')];
  e.poke(); e.poke(); e.poke();
  assert.strictEqual(timers.length, 1, 'a burst shares one timer');
  assert.strictEqual(timers[0].ms, 1500);
  t += 1500; timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(q.calls.length, 2);
  assert.strictEqual((await e.figure(false)).total, 3.6);
  assert.strictEqual((await e.answer(false)).total, 3.6, 'and the strip has it too');

  // Another one right after: held until POKE_MS has passed since that read.
  t += 1000;
  e.poke();
  assert.strictEqual(timers.length, 2);
  assert.strictEqual(timers[1].ms, 4000 + 1500);
});

test('the payout path tells the figure, after both writes and without being able to fail', () => {
  const db = fs.readFileSync(path.join(__dirname, '../server/db.js'), 'utf8');
  const fn = db.slice(db.indexOf('async function recordEarnings'), db.indexOf('function onEarningsRecorded'));
  assert.ok(fn.indexOf('for (const fn of earningsListeners)') > fn.lastIndexOf('INSERT INTO earnings_history'),
    'listeners run after the landed row is written');
  assert.ok(/try \{ fn\(id\); \} catch/.test(fn), 'and a throwing listener is swallowed');
  const idx = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
  assert.ok(/db\.onEarningsRecorded\(\(\) => earnings\.poke\(\)\)/.test(idx), 'the server wires the poke');
  const routes = [];
  createEarnings({ query: null, excludeWallets: [OWNER, REV], previewExclude: [REV], config: CFG, log: quiet })
    .route({ get: (p) => routes.push(p) });
  assert.deepStrictEqual(routes, ['/api/earnings/recent', '/api/earnings/board', '/api/earnings', '/api/earnings/total']);
});

// ── The lobby's Live wins row (/api/earnings/recent, site sweep 2026-10-28) ───────────────────────────────────
const { RECENT_SQL, recentWins } = require('../server/earnings');

test('recent wins: the strip\'s own landed rule, newest first, read only', () => {
  const where = (s) => s.slice(s.indexOf("WHERE h.source = 'game_rake'"), s.search(/\n\s*(ORDER|GROUP) BY/));
  assert.strictEqual(where(RECENT_SQL), where(EARNINGS_SQL));
  assert.match(RECENT_SQL, /ORDER BY h\.created_at DESC\s+LIMIT \d+$/);
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(RECENT_SQL), 'read only');
  assert.ok(!/\$5/.test(RECENT_SQL), 'no unused parameter');
});

test('recent wins: only a name, a lobby game id and the take-home leave; never a wallet', () => {
  const out = recentWins([
    { wallet: A, game: 'slither', rake: '0.05', name: 'neo' },
    { wallet: B, game: 'pool8', rake: '0.1', name: null },
    { wallet: A, game: 'ag', rake: '0.02', name: 'neo' },
  ]);
  assert.deepStrictEqual(out, [
    { name: 'neo', game: 'snake', amount: 0.45 },
    { name: 'BBBB…ZZ22', game: 'pool8', amount: 0.9 },
    { name: 'neo', game: 'agar', amount: 0.18 },
  ]);
  for (const w of out) assert.deepStrictEqual(Object.keys(w).sort(), ['amount', 'game', 'name']);
  assert.ok(!JSON.stringify(out).includes(A) && !JSON.stringify(out).includes(B), 'no full wallet');
  assert.strictEqual(recentWins([{ wallet: '', game: 'paper', rake: '0.1' }]), null, 'an untrustworthy set is refused');
  assert.strictEqual(recentWins([{ wallet: A, game: 'paper', rake: '-1' }]), null);
});

test('recent wins: the public exclusions (owner and revenue), never the preview\'s, and ok:false without a database', async () => {
  const q = fakeQuery([{ wallet: A, game: 'paper', rake: '0.1', name: 'neo' }]);
  const e = createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV], config: CFG, log: quiet });
  const r = await e.recentList();
  assert.deepStrictEqual(r, { ok: true, wins: [{ name: 'neo', game: 'paper', amount: 0.9 }] });
  assert.strictEqual(q.calls[0].sql, RECENT_SQL);
  assert.deepStrictEqual(q.calls[0].params[1].slice().sort(), [OWNER, REV].sort());
  assert.strictEqual(q.calls[0].params.length, 4);
  const none = createEarnings({ config: CFG, log: quiet });
  assert.deepStrictEqual(await none.recentList(), { ok: false, wins: [] });
});

test('recent wins: hidden with the strip (SHOW false), and reads nothing then', async () => {
  const q = fakeQuery([{ wallet: A, game: 'paper', rake: '0.1', name: 'neo' }]);
  const e = createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV], config: Object.assign({}, CFG, { SHOW: false }), log: quiet });
  assert.deepStrictEqual(await e.recentList(), { ok: false, wins: [] });
  assert.strictEqual(q.calls.length, 0);
});
