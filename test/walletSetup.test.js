'use strict';
/* Signed in with no wallet (wallet-widget/src/walletSetup.mjs, 2026-10-18): Privy's on-login
   create stalled for good when its wallet frame loaded late, and Sign in did nothing after.
   The widget makes the wallet itself: it retries a create that fails fast, never runs two at
   once, stops at a deadline with a plain failure, and treats "already has a wallet" as done
   once Privy's user is refreshed. */
const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../wallet-widget/src/walletSetup.mjs');

// Real time, short numbers: a 300 ms deadline and 10 ms between tries.
const clock = () => ({ now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });

test('a create that fails while the frame is still loading is tried again and then succeeds', async () => {
  const { makeWalletSetup } = await load();
  const c = clock();
  let user = { wallet: null }, calls = 0;
  const s = makeWalletSetup({
    ...c, deadlineMs: 300, retryMs: 10,
    hasWallet: () => !!user.wallet,
    refreshUser: async () => {},
    createWallet: async () => {
      calls++;
      if (calls < 3) throw new Error('User must be authenticated before creating a Privy wallet');
      user = { wallet: 'abc' };
      return { wallet: { address: 'abc' } };
    },
  });
  const r = await s.ensure();
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(calls, 3);
});

test('a player who already has a wallet never gets a second one', async () => {
  const { makeWalletSetup } = await load();
  let calls = 0;
  const s = makeWalletSetup({ ...clock(), deadlineMs: 300, hasWallet: () => true, refreshUser: async () => {}, createWallet: async () => { calls++; } });
  assert.deepStrictEqual(await s.ensure(), { ok: true });
  assert.strictEqual(calls, 0);
});

test('every caller shares one setup and one create, never two at once', async () => {
  const { makeWalletSetup } = await load();
  let calls = 0, finish;
  const s = makeWalletSetup({
    now: () => 0, sleep: () => new Promise(() => {}), // the deadline never comes in this test
    hasWallet: () => false, refreshUser: async () => {},
    createWallet: () => { calls++; return new Promise((r) => { finish = r; }); },
  });
  const a = s.ensure(), b = s.ensure();
  assert.strictEqual(a, b);
  assert.strictEqual(s.busy(), true);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls, 1);
  finish({});
  assert.deepStrictEqual(await a, { ok: true });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(s.busy(), false);
});

test('a create that hangs ends in a failure at the deadline, and Try again waits on the same create', async () => {
  const { makeWalletSetup } = await load();
  let calls = 0, finish;
  const s = makeWalletSetup({
    ...clock(), deadlineMs: 60,
    hasWallet: () => false, refreshUser: async () => {},
    createWallet: () => { calls++; return new Promise((r) => { finish = r; }); },
  });
  const r = await s.ensure();
  assert.strictEqual(r.ok, false);
  assert.match(r.error.message, /timed out/);
  // Try again while the first create is still out: no second create, it waits on the first.
  const again = s.ensure();
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(calls, 1);
  finish({});
  assert.deepStrictEqual(await again, { ok: true });
});

test('a create that keeps failing stops at the deadline with the last error', async () => {
  const { makeWalletSetup } = await load();
  const c = clock();
  let calls = 0;
  const s = makeWalletSetup({ ...c, deadlineMs: 100, retryMs: 30, hasWallet: () => false, refreshUser: async () => {},
    createWallet: async () => { calls++; throw new Error('Network down'); } });
  const r = await s.ensure();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.message, 'Network down');
  assert.ok(calls >= 2 && calls <= 5, `tried ${calls} times`); // every 30 ms for 100 ms
  assert.strictEqual(s.busy(), false);
});

test('"already has a wallet" refreshes the user and counts as done', async () => {
  const { makeWalletSetup } = await load();
  let user = { wallet: null }, refreshed = 0;
  const s = makeWalletSetup({ ...clock(), deadlineMs: 300, hasWallet: () => !!user.wallet,
    refreshUser: async () => { refreshed++; user = { wallet: 'abc' }; },
    createWallet: async () => { throw new Error('User already has an embedded wallet.'); } });
  assert.deepStrictEqual(await s.ensure(), { ok: true });
  assert.strictEqual(refreshed, 1);
});

test('the widget turns off Privy\'s on-login create and Sign in never calls a bare login()', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../wallet-widget/src/main.jsx'), 'utf8');
  assert.match(src, /solana:\s*\{\s*createOnLogin:\s*'off'\s*\}/);
  assert.doesNotMatch(src, /createOnLogin:\s*'all-users'/);
  assert.match(src, /window\.duelWalletLogin = signIn;/);
  assert.match(src, /if \(p\.authenticated\) \{ if \(!solanaAddress\(p\.user\)\) setUpWallet\(\); return; \}/);
});
