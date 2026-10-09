'use strict';
/* server/db.js around the SQL of STATUS items 7a and 7b, with pool.query replaced by a recorder
   (the dev machine has no Postgres). What matters here is the JS: each migration group turns its
   feature on only when every statement went through, and a feature that is off (or a database
   that lacks the columns) falls back to exactly the old SQL, so a failed migration can never
   strand a stake at /api/submit-stake or stop the payout drainer. */
const test = require('node:test');
const assert = require('node:assert');
const db = require('../server/db');

function recorder(fail = () => null) {
  const seen = [];
  db.pool.query = async (sql, params) => {
    seen.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    const err = fail(String(sql));
    if (err) throw err;
    if (/RETURNING sig/.test(sql)) return { rows: [{ sig: params[0] }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return seen;
}
const quietly = async (fn) => {
  const { log, error } = console;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = error; }
};

test('init runs every ledger statement one by one and turns each feature on only when its group went through', async () => {
  let seen = recorder();
  await quietly(() => db.init());
  assert.deepStrictEqual(db.features, { durableStakes: true, payoutLanes: true });
  const ddl = seen.slice(1).map((q) => q.sql);
  assert.ok(ddl.length >= 15, 'separate statements, not one template');
  assert.ok(ddl.some((s) => /ALTER TABLE used_stake_sigs ADD COLUMN IF NOT EXISTS state TEXT/.test(s)));
  assert.ok(ddl.some((s) => /ALTER TABLE failed_payouts ADD COLUMN IF NOT EXISTS missing_account BOOLEAN DEFAULT false/.test(s)));

  seen = recorder((sql) => (/claim_key/.test(sql) && /ALTER/.test(sql) ? new Error('boom') : null));
  await quietly(() => db.init());
  assert.deepStrictEqual(db.features, { durableStakes: false, payoutLanes: true });
  assert.ok(!seen.some((q) => /settled_at TIMESTAMPTZ/.test(q.sql)), 'stopped at the first failure of its group');
});

test('claimStakeSig: durable row when on; the plain one-time claim when off; falls back on a missing column', async () => {
  db.features.durableStakes = true;
  let seen = recorder();
  assert.deepStrictEqual(await db.claimStakeSig('S1', { wallet: 'W', amount: 0.1, label: 'stake 0.1', region: 'na', bootId: 'b' }),
    { claimed: true, durable: true });
  assert.match(seen[0].sql, /INSERT INTO used_stake_sigs \(sig, state, wallet_address, refund_amount, label, region, boot_id\) VALUES \(\$1, 'pending'/);
  assert.deepStrictEqual(seen[0].params, ['S1', 'W', 0.1, 'stake 0.1', 'na', 'b']);

  // No usable record (no wallet, or nothing to refund): the old claim, not durable.
  seen = recorder();
  assert.deepStrictEqual(await db.claimStakeSig('S2', { wallet: '', amount: 0.1 }), { claimed: true, durable: false });
  assert.match(seen[0].sql, /^INSERT INTO used_stake_sigs \(sig\) VALUES \(\$1\) ON CONFLICT DO NOTHING RETURNING sig$/);

  // The columns are missing after all (42703): the old claim, and durable stays off afterwards.
  seen = recorder((sql) => (/state, wallet_address/.test(sql) ? Object.assign(new Error('column "state" does not exist'), { code: '42703' }) : null));
  assert.deepStrictEqual(await quietly(() => db.claimStakeSig('S3', { wallet: 'W', amount: 1 })), { claimed: true, durable: false });
  assert.strictEqual(db.features.durableStakes, false);
  assert.strictEqual(seen.length, 2);

  // Any other error is thrown, as before (the route answers 400; nothing was claimed).
  db.features.durableStakes = true;
  recorder(() => Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
  await assert.rejects(db.claimStakeSig('S4', { wallet: 'W', amount: 1 }), /connection refused/);
});

test('with the lanes off the drainer SQL is exactly the old query and the slow lane is empty', async () => {
  db.features.payoutLanes = false;
  let seen = recorder();
  assert.strictEqual(await db.claimDuePayout(30, 200, 'slow'), null);
  assert.strictEqual(seen.length, 0);
  await db.claimDuePayout(30, 200, 'normal');
  assert.doesNotMatch(seen[0].sql, /missing_account/);
  await db.recordFailedPayout('W', 1, 'P', 'x: ' + db.NO_USDC_ACCOUNT);
  assert.doesNotMatch(seen[1].sql, /missing_account/);
  await db.deferPayoutNoAccount(1);
  await db.returnPayoutToLane(1);
  assert.strictEqual(seen.length, 2, 'no lane writes without the columns');
  assert.deepStrictEqual(await db.listUnsettledStakes({}), [], 'no durable rows without the columns');

  db.features.payoutLanes = true;
  db.features.durableStakes = true;
  seen = recorder();
  await db.claimDuePayout(30, 200, 'normal');
  assert.match(seen[0].sql, /AND missing_account IS NOT TRUE/);
  await db.recordFailedPayout('W', 1, 'P', 'x: ' + db.NO_USDC_ACCOUNT);
  assert.match(seen[1].sql, /missing_account, account_waits, next_attempt_at\) VALUES \(.*true, 1, NOW\(\) \+ make_interval\(secs => 120\)\)/);
  await db.recordFailedPayout('W', 1, 'P', 'x: rpc 503');
  assert.doesNotMatch(seen[2].sql, /missing_account/);
});

test('recordOwedOnce: one owed row per key whoever writes it (paid agar restart and crash refunds), refund reasons only', async () => {
  const keys = new Set();
  const reasons = new Set();
  const seen = [];
  db.pool.query = async (sql, params) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    seen.push({ sql: s, params });
    if (/ON CONFLICT \(stake_sig\) WHERE stake_sig IS NOT NULL DO NOTHING RETURNING id/.test(s)) {
      if (keys.has(params[4])) return { rows: [], rowCount: 0 };
      keys.add(params[4]);
      return { rows: [{ id: keys.size }], rowCount: 1 };
    }
    if (/WHERE NOT EXISTS \(SELECT 1 FROM failed_payouts WHERE reason = \$4::text\) RETURNING id/.test(s)) {
      if (reasons.has(params[3])) return { rows: [], rowCount: 0 };
      reasons.add(params[3]);
      return { rows: [{ id: 1 }], rowCount: 1 };
    }
    throw new Error('unexpected SQL ' + s);
  };
  const was = db.features.durableStakes;
  try {
    const key = 'agowed:0b7e7c55-1f0e-4f1a-9a59-2f6d2f1c9a10';
    const reason = 'refund agar crash ag_na_s0_1 ' + key;
    db.features.durableStakes = true;
    assert.strictEqual(await db.recordOwedOnce(key, 'W', 0.1, 'n', reason), 'owed');
    assert.strictEqual(await db.recordOwedOnce(key, 'W', 0.1, 'n', reason), 'exists', 'the boot replay of a written row');
    assert.match(seen[0].sql, /^INSERT INTO failed_payouts \(wallet_address, amount_sol, name, reason, stake_sig\) VALUES \(\$1, \$2, \$3, \$4, \$5\)/);
    assert.deepStrictEqual(seen[0].params, ['W', 0.1, 'n', reason, key]);
    // without the unique index the key inside the reason does the same job
    db.features.durableStakes = false;
    const key2 = 'agowed:1b7e7c55-1f0e-4f1a-9a59-2f6d2f1c9a10';
    const reason2 = 'refund agar shutdown ag_na_s1 ' + key2;
    assert.strictEqual(await db.recordOwedOnce(key2, 'W', 1, 'n', reason2), 'owed');
    assert.strictEqual(await db.recordOwedOnce(key2, 'W', 1, 'n', reason2), 'exists');
    // a real stake signature, a reason the drainer would book as winnings, or a reason without its key: refused
    await assert.rejects(db.recordOwedOnce('5Kx9realStakeSignature', 'W', 1, 'n', 'refund x 5Kx9realStakeSignature'), /bad key/);
    await assert.rejects(db.recordOwedOnce(key, 'W', 1, 'n', 'agar crash ' + key), /must start with refund/);
    await assert.rejects(db.recordOwedOnce(key, 'W', 1, 'n', 'refund agar crash'), /name the key/);
  } finally {
    db.features.durableStakes = was;
  }
});
