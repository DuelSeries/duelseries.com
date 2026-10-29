'use strict';
/* The database pools and the public reads (night review 2026-10-29, findings 36, 37 and 38).
   36: a dead idle connection made the pg pool emit 'error' with no listener, which ended the process; the public
       reads (profile, search, /api/my-profile) shared the 10 connections the money paths wait for, with no time limit.
   37: /api/earningsboard and /api/stats/winnings ran uncached whole-table aggregates for anyone, and nothing called them.
   38: the profile's win rate read every later rake row once per paid entry; two indexes make it read the player's own.
   The dev machine has no Postgres, so the pools get a stand-in Client (the real pg-pool around it) or a recorder. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Pool, Client } = require('pg');
const db = require('../server/db');
const playerStats = require('../server/playerStats');
const { EARNINGS_SQL } = require('../server/earnings');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const quietly = async (fn) => {
  const { log, error } = console;
  const said = [];
  console.log = () => {}; console.error = (...a) => said.push(a.join(' '));
  try { return { value: await fn(), said }; } finally { console.log = log; console.error = error; }
};
const tick = () => new Promise((r) => setImmediate(r));

/* Just enough of pg's Client for pg-pool: connects, answers, ends. Every one made is kept, so a test can make the
   connection under one of them die the way a Postgres restart does (the client emits 'error'). */
function fakeClientClass(made) {
  return class FakeClient extends EventEmitter {
    constructor() { super(); this._queryable = true; this._ending = false; made.push(this); }
    connect(cb) { setImmediate(() => cb()); }
    query(text, values, cb) {
      if (typeof values === 'function') cb = values;
      setImmediate(() => cb(null, { rows: [{ one: 1 }], rowCount: 1 }));
    }
    end(cb) { this._ending = true; if (cb) setImmediate(cb); return Promise.resolve(); }
    isConnected() { return !this._ending; }
    ref() {}
    unref() {}
  };
}

// ─── finding 36: the pools ───────────────────────────────────────────────────

test('a pool with no error listener ends the process when an idle connection dies (the old crash)', async () => {
  const made = [];
  const bare = new Pool({ max: 1 });
  bare.Client = fakeClientClass(made);
  await bare.query('SELECT 1');
  await tick();
  assert.strictEqual(made.length, 1);
  assert.throws(() => made[0].emit('error', new Error('terminating connection due to administrator command')),
    /administrator command/, 'EventEmitter throws an unheard error, and the server has no uncaughtException handler');
});

test('both of db.js\'s pools hear an idle connection die, drop it, and serve the next query on a fresh one', async (t) => {
  for (const [label, p] of [['main', db.pool], ['read', db.readPool]]) {
    const made = [];
    const RealClient = p.Client;
    p.Client = fakeClientClass(made);
    t.after(() => { p.Client = RealClient; });
    assert.ok(p.listenerCount('error') >= 1, `${label} pool has an error listener`);
    await p.query('SELECT 1');
    await tick();
    assert.strictEqual(p.idleCount, 1, `${label}: the client went back idle`);
    const { said } = await quietly(async () => {
      assert.doesNotThrow(() => made[0].emit('error', new Error('Connection terminated unexpectedly')));
      await tick();
    });
    assert.ok(said.some((s) => /idle client error/.test(s) && /Connection terminated unexpectedly/.test(s)), `${label}: logged`);
    assert.strictEqual(p.totalCount, 0, `${label}: the dead client is gone from the pool`);
    const r = await p.query('SELECT 1');
    assert.deepStrictEqual(r.rows, [{ one: 1 }], `${label}: the next query works`);
    assert.strictEqual(made.length, 2, `${label}: on a new connection`);
    await tick();
    const { said: said2 } = await quietly(async () => { made[1].emit('error', new Error('bye')); await tick(); });
    assert.ok(said2.length >= 1);
  }
});

test('public reads have their own few connections with a server-side time limit; the money pool has none', () => {
  assert.deepStrictEqual(db.READ_POOL, { max: 4, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
  for (const k of Object.keys(db.READ_POOL)) assert.strictEqual(db.readPool.options[k], db.READ_POOL[k], k);
  assert.ok(db.readPool.options.max < db.pool.options.max, 'fewer than the main pool, which keeps pg\'s 10');
  // Postgres cancels a read that runs too long itself: the limit goes to the server in the startup message.
  assert.strictEqual(new Client(db.readPool.options).getStartupConf().statement_timeout, '5000');
  // The money paths keep exactly their old behaviour: never cut off, never given up on.
  for (const k of ['statement_timeout', 'query_timeout', 'connectionTimeoutMillis']) {
    assert.strictEqual(db.pool.options[k], undefined, `main pool has no ${k}`);
  }
  assert.strictEqual(new Client(db.pool.options).getStartupConf().statement_timeout, undefined);
});

test('the profile, the search and /api/my-profile read through the read pool; a name change writes through the main one', async (t) => {
  const reads = [];
  const writes = [];
  const GID = 'AAAAbbbbccccddddeeeeffffgggghhhhiiiijjjjZZ11';
  db.readPool.query = async (sql, params) => {
    reads.push(String(sql));
    if (/FROM accounts/.test(sql) && /LOWER\(name\) = LOWER\(\$1\)/.test(sql)) {
      return { rows: [{ google_id: GID, name: 'Neo', total_earnings: '2', games_played: 3, play_time_seconds: 4, created_at: new Date(0) }] };
    }
    if (/FROM accounts WHERE google_id = \$1/.test(sql)) return { rows: [{ name: 'Neo', total_earnings: '2', games_played: 3, play_time_seconds: 4, name_history: [], created_at: new Date(0) }] };
    if (/SELECT name FROM accounts/.test(sql)) return { rows: [{ name: 'Neo' }] };
    return { rows: [] };
  };
  const realMain = db.pool.query;
  db.pool.query = async (sql) => { writes.push(String(sql)); return { rows: [], rowCount: 1 }; };
  t.after(() => { delete db.readPool.query; db.pool.query = realMain; });

  const prof = await db.getProfile('Neo');
  assert.strictEqual(prof.name, 'Neo');
  assert.deepStrictEqual(prof.winRate && prof.winRate.entered, 0);
  assert.ok(reads.includes(playerStats.WIN_SQL), 'the win rate is a public read');
  assert.strictEqual(reads.length, 7, 'the account, five earnings series and the win rate');
  assert.strictEqual((await db.getMyProfile(GID)).name, 'Neo');
  assert.strictEqual(reads.length, 10);
  assert.deepStrictEqual(await db.searchPlayerNames('ne'), ['Neo']);
  assert.strictEqual(reads.length, 11);
  assert.deepStrictEqual(writes, [], 'none of them touched the main pool');

  await db.setAccountName(GID, 'Trinity');
  assert.strictEqual(writes.length, 2, 'the clash check and the upsert');
  assert.strictEqual(reads.length, 11, 'and the write never went near the read pool');
});

test('a win-rate read that Postgres cancels costs the tile, never the profile', async (t) => {
  db.readPool.query = async (sql) => {
    if (sql === playerStats.WIN_SQL) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    if (/LOWER\(name\) = LOWER\(\$1\)/.test(sql)) return { rows: [{ google_id: 'G', name: 'Neo', created_at: new Date(0) }] };
    return { rows: [] };
  };
  t.after(() => { delete db.readPool.query; });
  const { value: prof, said } = await quietly(() => db.getProfile('Neo'));
  assert.strictEqual(prof.name, 'Neo');
  assert.strictEqual(prof.winRate, null);
  assert.ok(said.some((s) => /\[PROFILE\] win rate/.test(s) && /statement timeout/.test(s)));
});

test('skinGrant: a connection that dies mid-transaction rejects the grant instead of ending the process', async (t) => {
  const realConnect = db.pool.connect;
  t.after(() => { db.pool.connect = realConnect; });
  const run = async (dieAt) => {
    const client = new EventEmitter();
    const sent = [];
    client.query = async (sql) => {
      sent.push(String(sql).trim().split(/\s+/)[0]);
      if (sent.length === dieAt) {
        client.emit('error', new Error('Connection terminated unexpectedly'));   // what pg does before rejecting
        throw new Error('Connection terminated unexpectedly');
      }
      if (/^\s*UPDATE skin_purchases/.test(sql)) return { rows: [{ wallet: 'W', item: 'sl:neon', game: 'slither' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    client.release = (err) => { client.released = { err }; };
    db.pool.connect = async () => client;
    let result, failure;
    const { said } = await quietly(async () => {
      try { result = await db.skinGrant('ref1', 'sig1', { usdc: 1 }); } catch (e) { failure = e; }
    });
    return { client, sent, result, failure, said };
  };

  const ok = await run(0);
  assert.deepStrictEqual(ok.result, { granted: true });
  assert.deepStrictEqual(ok.sent, ['BEGIN', 'UPDATE', 'INSERT', 'INSERT', 'COMMIT']);
  assert.strictEqual(ok.client.released.err, undefined, 'a healthy client goes back to the pool');
  assert.strictEqual(ok.client.listenerCount('error'), 0, 'and carries no listener of ours');

  const dead = await run(3);
  assert.match(dead.failure.message, /Connection terminated unexpectedly/, 'the caller sees the failure, as before');
  assert.strictEqual(dead.result, undefined);
  assert.ok(dead.sent.includes('ROLLBACK'), 'rolled back');
  assert.ok(dead.client.released.err instanceof Error, 'the dead client is handed back broken, so the pool closes it');
  assert.strictEqual(dead.client.listenerCount('error'), 0);
  assert.ok(dead.said.some((s) => /skinGrant connection error/.test(s)));
});

// ─── finding 38: the win rate's indexes ──────────────────────────────────────

function recorder(answer = () => ({ rows: [] })) {
  const seen = [];
  const real = db.pool.query;
  db.pool.query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    seen.push({ sql: s, params });
    const a = answer(s, params);
    if (a instanceof Error) throw a;
    return a;
  };
  return { seen, restore: () => { db.pool.query = real; } };
}

test('stats indexes: built CONCURRENTLY, one statement a query, on the literals the win rate and the strip filter by', async () => {
  const { seen, restore } = recorder();
  try {
    assert.strictEqual(await db.ensureStatsIndexes(), true);
  } finally { restore(); }
  const ddl = seen.map((q) => q.sql).filter((s) => /INDEX/.test(s));
  assert.deepStrictEqual(ddl, [
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hr_rake_wallet ON house_revenue (player_wallet, created_at) WHERE source = 'game_rake'",
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fp_wallet ON failed_payouts (wallet_address, created_at)',
  ]);
  assert.ok(seen.every((q) => !q.sql.includes(';')), 'CONCURRENTLY cannot run in a multi-statement (transaction) query');
  assert.ok(seen.every((q) => !/\bBEGIN\b/.test(q.sql)));
  // The partial index is only used when the query says the same thing word for word.
  assert.ok(playerStats.WIN_SQL.includes("h.source = 'game_rake'") && EARNINGS_SQL.includes("h.source = 'game_rake'"));
  assert.ok(/h\.player_wallet = \$1/.test(playerStats.WIN_SQL) && /f\.wallet_address = h\.player_wallet/.test(EARNINGS_SQL));
});

test('stats indexes: an INVALID leftover of a build that died is dropped and built again; a valid one is left alone', async () => {
  const { seen, restore } = recorder((s, params) => {
    if (/FROM pg_index/.test(s)) return { rows: [{ valid: params[0] !== 'idx_hr_rake_wallet' }] };
    return { rows: [] };
  });
  try { await db.ensureStatsIndexes(); } finally { restore(); }
  const ddl = seen.map((q) => q.sql).filter((s) => !/FROM pg_index/.test(s));
  assert.deepStrictEqual(ddl, [
    'DROP INDEX CONCURRENTLY IF EXISTS idx_hr_rake_wallet',
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hr_rake_wallet ON house_revenue (player_wallet, created_at) WHERE source = 'game_rake'",
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fp_wallet ON failed_payouts (wallet_address, created_at)',
  ]);
  assert.ok(seen.filter((q) => /FROM pg_index/.test(q.sql)).every((q) => /to_regclass\(\$1\)/.test(q.sql)), 'the name is a parameter');
});

test('stats indexes: a failure is logged, the next index is still tried, and nothing is thrown', async () => {
  const { seen, restore } = recorder((s) => (/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hr_rake_wallet/.test(s)
    ? new Error('deadlock detected') : { rows: [] }));
  let out;
  try { out = await quietly(() => db.ensureStatsIndexes()); } finally { restore(); }
  assert.strictEqual(out.value, false);
  assert.ok(out.said.some((s) => /stats index idx_hr_rake_wallet not built/.test(s) && /deadlock detected/.test(s)));
  assert.ok(seen.some((q) => /idx_fp_wallet ON failed_payouts/.test(q.sql)), 'idx_fp_wallet still built');
});

test('stats indexes are not part of db.init(): the boot refunds never wait behind a concurrent build', async () => {
  const { seen, restore } = recorder((s) => (/RETURNING sig/.test(s) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 }));
  try { await quietly(() => db.init()); } finally { restore(); }
  assert.ok(seen.length > 10, 'init ran');
  assert.ok(!seen.some((q) => /CONCURRENTLY/.test(q.sql)), 'no concurrent build inside init');
  const src = read('server/index.js');
  const boot = src.slice(src.indexOf('await db.init();'), src.indexOf("console.warn('[DB] Could not connect"));
  const sweepAt = boot.indexOf('stakeLedger.sweep({ boot: true })');
  const replayAt = boot.indexOf('replayAgJournal();');
  const idxAt = boot.indexOf('db.ensureStatsIndexes().catch(');
  assert.ok(sweepAt > 0 && replayAt > sweepAt && idxAt > replayAt, 'started after the boot refund and the agar replay');
  assert.ok(!/await db\.ensureStatsIndexes/.test(boot), 'and not waited for');
  assert.ok(/typeof db\.ensureStatsIndexes === 'function'/.test(boot), 'a stand-in db (scripts/dev-local.js) without it still boots');
});

// ─── finding 37: the dead public routes ──────────────────────────────────────

test('the dead whole-table routes are gone and every remaining public profile read has a limiter', () => {
  const src = read('server/index.js');
  assert.ok(!src.includes("app.get('/api/earningsboard'"), '/api/earningsboard is not served');
  assert.ok(!src.includes("app.get('/api/stats/winnings'"), '/api/stats/winnings is not served');
  assert.ok(!/PRE_TRACKING_WINNINGS_CAD\s*[-+*/)]/.test(src), 'nothing left reading its constant');
  assert.ok(src.includes("app.get('/api/my-profile', myProfileLimiter, async"), '/api/my-profile is limited');
  assert.ok(/const myProfileLimiter = rateLimit\(\{ windowMs: 10 \* 1000, max: 40,/.test(src), '40 in 10 s per address');
  assert.ok(src.includes("app.get('/api/profile/:name', socialLimiter,") && src.includes("app.get('/api/players/search', socialLimiter,"));
  // Nothing the site serves asks for the removed routes.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return /\.(js|html|mjs)$/.test(d.name) ? [p] : [];
  });
  for (const f of walk(path.join(ROOT, 'public'))) {
    const s = fs.readFileSync(f, 'utf8');   // a fetch names the path in quotes; the comments that mention it do not
    assert.ok(!/['"`]\/api\/earningsboard/.test(s) && !/['"`]\/api\/stats\/winnings/.test(s), path.relative(ROOT, f));
  }
});
