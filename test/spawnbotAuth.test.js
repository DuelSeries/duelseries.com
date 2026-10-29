'use strict';
/* admin:spawnbot was open to anyone and unthrottled (night review 2026-10-29, finding 30): every message ran
   the owner token check, so a junk string was one '[AUTH] access token rejected' log line (tens of thousands a
   second from one socket, until the disk filled), and a real token from a Privy account with no Solana wallet
   was one Privy REST lookup per message (until Privy throttled the app, and the token fallbacks with it).

   The real walletFromIdToken and isOwnerToken are lifted out of server/index.js and run against a fake Privy,
   so this checks the code that ships rather than a copy of it. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

function load({ verify, getUser, owners }) {
  const from = SRC.indexOf('const _walletForUser = new Map();');
  const fnAt = SRC.indexOf('async function isOwnerToken(');
  const end = SRC.slice(fnAt).search(/\r?\n\}\r?\n/);
  assert.ok(from > 0 && fnAt > from && end > 0, 'the auth block is where it was');
  const body = SRC.slice(from, fnAt + end + 3);
  const warns = [];
  const calls = { verify: 0, getUser: 0 };
  const privyServer = {
    verifyAuthToken: async (t) => { calls.verify++; return verify(t); },
    getUser: async (q) => { calls.getUser++; return getUser(q); },
  };
  const consoleFake = { warn: (...a) => warns.push(a.join(' ')), log() {}, error() {} };
  // eslint-disable-next-line no-new-func
  const make = new Function('privyServer', 'OWNER_WALLETS', 'console',
    body + '\nreturn { walletFromIdToken, isOwnerToken };');
  return { ...make(privyServer, new Set(owners || []), consoleFake), warns, calls };
}

test('a flood of junk tokens is one log line per 30 s, not one per message', async () => {
  const a = load({ verify: () => { throw new Error('Invalid Compact JWS'); }, getUser: () => null });
  for (let i = 0; i < 1000; i++) assert.strictEqual(await a.isOwnerToken('x' + i), false);
  assert.strictEqual(a.calls.verify, 1000);
  assert.strictEqual(a.warns.length, 1, 'one warning, then quiet');
  assert.match(a.warns[0], /\[AUTH\] access token rejected: Invalid Compact JWS/);
  // The HTTP routes' rejections share the same budget.
  const r = await a.walletFromIdToken('junk', null);
  assert.deepStrictEqual(r, { wallet: null, reason: 'bad-token' }, 'the answer itself is unchanged');
  assert.strictEqual(a.warns.length, 1);
});

test('a wallet-less account asks Privy once a minute through the owner check; the sign-in paths ask every time', async () => {
  let wallet = null;
  const a = load({
    verify: () => ({ userId: 'did:privy:nowallet' }),
    getUser: () => ({ linkedAccounts: wallet ? [{ type: 'wallet', chainType: 'solana', address: wallet, walletClientType: 'privy' }] : [] }),
    owners: ['OWNERWALLET'],
  });
  for (let i = 0; i < 200; i++) assert.strictEqual(await a.isOwnerToken('valid.token.here'), false);
  assert.strictEqual(a.calls.getUser, 1, 'one Privy lookup for 200 owner checks');
  // The HTTP paths (my-name, owner routes, diagnose) are exactly as before: no hold, so a wallet made a
  // moment ago is seen at once.
  assert.deepStrictEqual(await a.walletFromIdToken('valid.token.here', null), { wallet: null, reason: 'no-solana-wallet' });
  assert.strictEqual(a.calls.getUser, 2);
  wallet = 'NewWa11et1111111111111111111111111111111111';
  assert.deepStrictEqual(await a.walletFromIdToken('valid.token.here', null), { wallet, reason: 'ok' });
  // Once found it is the ordinary positive cache, for every caller.
  assert.strictEqual(await a.isOwnerToken('valid.token.here'), false, 'found, and not an owner');
  assert.strictEqual(a.calls.getUser, 3, 'answered from the wallet cache');
});

test('the owner still spawns bots with his token', async () => {
  const a = load({
    verify: () => ({ userId: 'did:privy:owner' }),
    getUser: () => ({ linkedAccounts: [{ type: 'wallet', chainType: 'solana', address: 'OWNERWALLET', walletClientType: 'privy' }] }),
    owners: ['OWNERWALLET'],
  });
  assert.strictEqual(await a.isOwnerToken('owner.token'), true);
  assert.strictEqual(await a.isOwnerToken('owner.token'), true);
  assert.strictEqual(a.calls.getUser, 1);
});

test('index.js: admin:spawnbot is rate limited before the token is looked at', () => {
  assert.match(SRC, /on\('admin:spawnbot', async \(\{ count, idToken \} = \{\}\) => \{\s*if \(!socketRL\(socket, 'spawnbot', 1000\)\) return;\s*if \(!\(await isOwnerToken\(idToken\)\)\) return;/);
});
