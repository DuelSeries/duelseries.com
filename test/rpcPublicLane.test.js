'use strict';
/* Night review 2026-10-29, third pass on findings 1, 2 and 22 (review problem 0): PUBLIC_RPC_URL.

   With the day's caps gone, what strangers can spend is a rate, all month: it holds the key's per-second limit but
   still spends its credits. PUBLIC_RPC_URL moves every read a visitor can cause onto a key of its own: the /api/rpc
   relay, /api/sol-balance's SOL and USDC, and the Wallet tab's history. Stake verifies and submits, payouts, the
   escrow's own balances and a send's blockhash stay on RPC_URL, whose credits strangers can then never touch. Unset,
   both are RPC_URL and nothing changes (rpcBudget.test.js checks that side).

   Both keys are .invalid hosts and every request is answered here; nothing leaves the process. */
const test = require('node:test');
const assert = require('node:assert');

// The provider, stubbed BEFORE web3.js loads (it keeps a reference to fetch from load time): each request is recorded
// by host and method and answered as an empty account would be.
const seen = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  seen.push(new URL(String(url)).host + ' ' + body.method);
  const ctx = { context: { slot: 1 } };
  const result = body.method === 'getBalance' ? Object.assign({ value: 2_000_000_000 }, ctx)
    : body.method === 'getLatestBlockhash' ? Object.assign({ value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 9 } }, ctx)
    : body.method === 'getAccountInfo' ? Object.assign({ value: null }, ctx)
    : 7;
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
};

const { Keypair } = require('@solana/web3.js');
process.env.ESCROW_PRIVATE_KEY = Buffer.from(Keypair.generate().secretKey).toString('base64');
process.env.RPC_URL = 'https://money-key.invalid/?api-key=m';
process.env.PUBLIC_RPC_URL = 'https://public-key.invalid/?api-key=p';
const log = console.log;
console.log = () => {};
const Wallet = require('../server/Wallet');
const Usdc = require('../server/Usdc');
console.log = log;
const W = Keypair.generate().publicKey.toString();

test('PUBLIC_RPC_URL: a visitor\'s reads go to the public key, the money paths and a send\'s blockhash to RPC_URL', async () => {
  assert.notStrictEqual(Wallet.publicConnection, Wallet.connection);
  assert.notStrictEqual(Usdc.publicConnection, Usdc.connection);
  // Fourth pass (night review 2026-10-29): with a key of their own there is no day's cap (server/rpcDay.js): strangers
  // can only spend that key, so nothing is counted, saved or refused for a day.
  assert.strictEqual(require('../server/rpcDay').day, null);
  seen.length = 0;
  assert.strictEqual(await Wallet.getAddressBalance(W, { lane: 'public' }), 2);
  assert.strictEqual(await Usdc.usdcBalanceOf(W, { lane: 'public' }), 0, 'no USDC account: 0, as always');
  await Wallet.forwardRpc({ jsonrpc: '2.0', id: 1, method: 'getSlot' });
  await Usdc.historyConnection.getSlot();
  assert.deepStrictEqual(seen, ['public-key.invalid getBalance', 'public-key.invalid getAccountInfo',
    'public-key.invalid getSlot', 'public-key.invalid getSlot'], 'the balance, the relay and history: the public key');
  seen.length = 0;
  assert.strictEqual(await Wallet.getAddressBalance(W), 2);
  assert.strictEqual(await Usdc.usdcBalanceOf(W), 0);
  await Wallet.getLatestBlockhash();
  await Usdc.connection.getSlot();
  assert.deepStrictEqual(seen, ['money-key.invalid getBalance', 'money-key.invalid getAccountInfo',
    'money-key.invalid getLatestBlockhash', 'money-key.invalid getSlot'], 'everything else, the blockhash too: the money key');
});

test('the widget sends no one but the server to either key: every balance it reads asks /api/sol-balance', () => {
  // The relay and the balance route are what reach the public key; the widget's own RPC is the relay (RPC_HTTP).
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'wallet-widget', 'src', 'main.jsx'), 'utf8');
  assert.match(src, /const RPC_HTTP = \(typeof window !== 'undefined' \? window\.location\.origin : ''\) \+ '\/api\/rpc';/);
  assert.doesNotMatch(src, /helius/i);
});
