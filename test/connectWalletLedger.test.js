'use strict';
/* Connect wallet money proof (2026-10-26): a player signed in with Phantom stakes, cashes out and is refunded with
   Phantom as the wallet, exactly as the Privy wallet is. Nothing server-side was changed for that: the server pays
   the stake's verified payer, and a browser wallet's stake is a transaction that wallet signed and paid the fee for.
   This drives it end to end with a Phantom-like Wallet Standard stub holding a real key, signing through the
   widget's own signer (wallet-widget/src/browserWallets.mjs signTransactionWith).

   The real server/index.js, booted by scripts/dev-local.js in this test's own process (in-memory database
   modelled by scripts/memLedgerDb.js, every outbound call refused except this test's localhost sockets). The chain
   is modelled, not faked away: submitStake checks the signatures on the bytes it is given and keeps them, and the
   stake verifier reads the payer off THOSE bytes (the fee payer, account key 0, as Wallet.verifyStakeTransfer does).
   money.withdraw records every payout instead of sending it. No real money moves. */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const path = require('path');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const { Keypair, PublicKey, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, createTransferCheckedInstruction } = require('@solana/spl-token');
const ownerAuth = require('../server/ownerAuth');
const C = require('../shared/constants');

const ROOT = path.join(__dirname, '..');
const realRequest = http.request;
const realGet = http.get;
const bw = () => import('../wallet-widget/src/browserWallets.mjs');
const dk = () => import('../wallet-widget/src/deviceKey.mjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
let ipSeq = 0;
function call(port, method, url, body) {
  const ip = '10.11.' + (++ipSeq >> 8) + '.' + (ipSeq & 255);
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const data = body === undefined ? '' : JSON.stringify(body);
    let out = '';
    s.on('connect', () => s.write(`${method} ${url} HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${ip}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(data)}\r\nConnection: close\r\n\r\n${data}`));
    s.on('data', (d) => { out += d; });
    s.on('end', () => {
      const status = Number(out.split(' ')[1]);
      let text = out.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      if (/transfer-encoding: chunked/i.test(out.split('\r\n\r\n')[0])) {
        let rest = text; text = '';
        for (;;) {
          const i = rest.indexOf('\r\n'); const n = parseInt(rest.slice(0, i), 16);
          if (!n) break; text += rest.slice(i + 2, i + 2 + n); rest = rest.slice(i + 2 + n + 2);
        }
      }
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      resolve({ status, json, text });
    });
    s.on('error', reject);
    s.setTimeout(5000, () => s.destroy(new Error('timeout')));
  });
}
const micro = (v) => Math.round(Number(v) * 1e6);
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  return fn();
};

/* Phantom, as the page sees it through the Wallet Standard: a real key, connect, signTransaction, signMessage. */
function phantom() {
  const seed = ed25519.utils.randomPrivateKey();
  const kp = Keypair.fromSeed(seed);
  const account = { address: kp.publicKey.toBase58(), publicKey: kp.publicKey.toBytes(), chains: ['solana:mainnet'], features: [] };
  const signed = [];
  const w = {
    name: 'Phantom', icon: 'data:image/png;base64,AAA', version: '1.0.0', chains: ['solana:mainnet'], accounts: [],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { w.accounts = [account]; return { accounts: w.accounts }; } },
      'solana:signMessage': { version: '1.0.0', signMessage: async ({ message }) => [{ signedMessage: message, signature: ed25519.sign(message, seed) }] },
      'solana:signTransaction': { version: '1.0.0', signTransaction: async ({ transaction }) => {
        const tx = Transaction.from(transaction); tx.partialSign(kp); signed.push(tx);
        return [{ signedTransaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }) }];
      } },
    },
  };
  return { w, address: account.address, signed };
}

let port, ledgerDb, REVENUE, ops;
let landed = 0.5;
const chain = new Map();   // signature -> the transaction submitted (what the network would hold)
const sent = [];           // [wallet, micro] for every payout the server made
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const ESCROW = Keypair.generate().publicKey;

test.before(async () => {
  port = await freePort();
  process.env.DEV_LOCAL_PORT = String(port);
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    ({ ledgerDb } = require(path.join(ROOT, 'scripts', 'dev-local.js')));
  } finally {
    console.log = log; console.warn = warn;
  }
  const blockedRequest = http.request;
  const local = (a) => a && typeof a === 'object' && ['localhost', '127.0.0.1'].includes(a.hostname || a.host) && Number(a.port) === port;
  http.request = function (...a) { return local(a[0]) ? realRequest.apply(http, a) : blockedRequest.apply(http, a); };
  http.get = function (...a) { return local(a[0]) ? realGet.apply(http, a) : blockedRequest.apply(http, a); };
  const Wallet = require(path.join(ROOT, 'server', 'Wallet.js'));
  const Usdc = require(path.join(ROOT, 'server', 'Usdc.js'));
  const money = require(path.join(ROOT, 'server', 'money.js'));
  ops = require(path.join(ROOT, 'server', 'ops.js'));
  // The network: only fully signed transactions are accepted; the id is the fee payer's signature.
  Wallet.submitStake = async (bytes) => {
    const tx = Transaction.from(bytes);
    if (!tx.verifySignatures()) throw new Error('signature verification failed');
    const sig = bs58.encode(tx.signature);
    chain.set(sig, tx);
    return sig;
  };
  // Who paid is read off what landed, as the real verifier does (account key 0, the fee payer).
  Usdc.verifyUsdcStake = async (sig) => {
    const tx = chain.get(sig);
    if (!tx) throw new Error('Stake transaction not found or not yet confirmed');
    return { payer: tx.feePayer.toBase58(), usdc: landed };
  };
  money.withdraw = async (w, amt) => { sent.push([w, micro(amt)]); return 'DEVSIG-' + sent.length; };
  REVENUE = require('fs').readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8').match(/const REVENUE_WALLET = '([^']+)'/)[1];
  for (let i = 0; i < 60; i++) {
    try { const r = await call(port, 'GET', '/api/live'); if (r.status === 200) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up');
});

function connect() {
  const { io } = require('socket.io-client');
  const parser = require('socket.io-parser');
  class Decoder extends parser.Decoder {
    constructor(o) { super(Object.assign({ maxAttachments: 100000 }, typeof o === 'object' ? o : {})); }
  }
  const s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000,
    parser: { ...parser, Decoder } });
  const got = [];
  s.onAny((ev, p) => got.push([ev, p]));
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 8000);
    s.on('connect', () => { clearTimeout(bail); res({ s, got, has: (ev) => got.find((g) => g[0] === ev) }); });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}

/* The stake the widget builds (main.jsx stakeOnly, USDC branch: the priority fee, then the transfer into the
   escrow's USDC account), signed by Phantom through the widget's signer, then sent the way the widget sends it.
   `named` is the walletAddress the request claims. */
async function phantomStake(p, amount, named) {
  const { signTransactionWith } = await bw();
  const from = new PublicKey(p.address);
  const tx = new Transaction({ feePayer: from, recentBlockhash: bs58.encode(Keypair.generate().publicKey.toBytes()) });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 80000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }));
  tx.add(createTransferCheckedInstruction(getAssociatedTokenAddressSync(USDC_MINT, from), USDC_MINT,
    getAssociatedTokenAddressSync(USDC_MINT, ESCROW), from, BigInt(micro(amount)), 6));
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const { signedTransaction } = await signTransactionWith(p.w, p.address, serialized);
  landed = amount;
  const r = await call(port, 'POST', '/api/submit-stake', { stake: amount, signedTx: Buffer.from(signedTransaction).toString('base64'),
                                                           walletAddress: named || p.address });
  assert.strictEqual(r.status, 200, r.text);
  return { token: r.json.entryToken, sig: bs58.encode(p.signed[p.signed.length - 1].signature) };
}
const sentTo = (w) => sent.filter((x) => x[0] === w).map((x) => x[1]);

test('a Phantom stake: one signature, the priority fee kept, and the durable row and token are Phantom\'s', async () => {
  const p = phantom();
  const { sig } = await phantomStake(p, 0.5, 'SomebodyElse111111111111111111111111111111');
  assert.strictEqual(p.signed.length, 1, 'one approval in Phantom');
  const tx = chain.get(sig);
  assert.strictEqual(tx.instructions.length, 3, 'priority fee limit + price, then the transfer');
  assert.strictEqual(tx.instructions[0].programId.toBase58(), ComputeBudgetProgram.programId.toBase58());
  const row = ledgerDb.stakes.get(sig);
  assert.strictEqual(row.state, 'pending');
  assert.strictEqual(row.wallet_address, p.address, 'the payer Phantom signed for, never the request');
  assert.strictEqual(row.refund_amount, 0.5);
});

test('slither.io at $0.50 from Phantom: a held cash-out pays 90 percent back to Phantom and 10 to the house', async () => {
  const p = phantom();
  const { token, sig } = await phantomStake(p, 0.5);
  const c = await connect();
  c.s.emit('play', { name: 'phan', stake: 0.5, entryToken: token, region: 'na', walletAddress: p.address, googleId: p.address });
  assert.ok(await until(() => c.has('game_joined'), 8000), JSON.stringify(c.got.map((g) => g[0])));
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'consumed');
  c.s.emit('cashout:start');
  const res = await until(() => c.has('cashout:result'), C.CASHOUT_HOLD_MS + 4000);
  assert.ok(res, 'cashed out after the hold');
  await until(() => sentTo(p.address).length && sentTo(REVENUE).length);
  assert.deepStrictEqual(sentTo(p.address), [450000], '90 percent back to the Phantom wallet');
  c.s.close();
});

test('a Paper door refusal refunds the Phantom stake to Phantom, once', async () => {
  const p = phantom();
  const { token, sig } = await phantomStake(p, 0.5);
  ops.set({ on: true, message: 'test' });
  try {
    const c = await connect();
    c.s.emit('pp:join', { name: 'phan2', stake: 0.5, entryToken: token });
    const refused = await until(() => c.has('pp:refused'));
    assert.deepStrictEqual([refused[1].why, refused[1].refunded], ['maintenance', true]);
    const owed = await until(() => ledgerDb.payouts.filter((x) => x.stake_sig === sig).length === 1 && ledgerDb.payouts.filter((x) => x.stake_sig === sig));
    assert.deepStrictEqual(owed.map((x) => [x.wallet_address, x.amount_sol]), [[p.address, 0.5]]);
    assert.strictEqual(ledgerDb.stakes.get(sig).state, 'refunded');
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(ledgerDb.payouts.filter((x) => x.stake_sig === sig).length, 1, 'once');
    c.s.close();
  } finally {
    ops.set({ on: false });
  }
});

test('a stake Phantom did not sign never reaches the ledger', async () => {
  const p = phantom();
  const from = new PublicKey(p.address);
  const tx = new Transaction({ feePayer: from, recentBlockhash: bs58.encode(Keypair.generate().publicKey.toBytes()) });
  tx.add(createTransferCheckedInstruction(getAssociatedTokenAddressSync(USDC_MINT, from), USDC_MINT,
    getAssociatedTokenAddressSync(USDC_MINT, ESCROW), from, 500000n, 6));
  const before = ledgerDb.stakes.size;
  const r = await call(port, 'POST', '/api/submit-stake', { stake: 0.5, walletAddress: p.address,
    signedTx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(ledgerDb.stakes.size, before);
});

test('the skin pass takes a Phantom device key; the owner console refuses the same key', async () => {
  const { signMessageWith } = await bw();
  const { createDeviceKey, signWithDeviceKey } = await dk();
  const p = phantom();
  await p.w.features['standard:connect'].connect();
  const store = { m: new Map(), getItem(k) { return this.m.get(k) || null; }, setItem(k, v) { this.m.set(k, v); }, removeItem(k) { this.m.delete(k); } };
  const d = await createDeviceKey(store, p.address, (b) => signMessageWith(p.w, p.address, b).then((r) => r.signature));
  const pass = await call(port, 'POST', '/api/skins/pass', { proof: signWithDeviceKey(d, 'skins:pass', {}) });
  assert.strictEqual(pass.status, 200, pass.text);
  assert.strictEqual(typeof pass.json.pass, 'string');
  // A device key signing an owner action (hand-built: the widget never would) proves nothing to /api/owner/do.
  const ts = Date.now();
  const forged = { action: 'maintenance:on', args: {}, wallet: p.address, ts,
    sig: bs58.encode(ed25519.sign(new TextEncoder().encode(ownerAuth.actionMessage('maintenance:on', {}, p.address, ts)), Uint8Array.from(Buffer.from(d.secret, 'hex')))),
    dk: { key: d.key, until: d.until, sig: d.sig } };
  const owner = await call(port, 'POST', '/api/owner/do', forged);
  assert.ok(owner.status === 401 || owner.status === 403, 'refused: ' + owner.status);
  assert.strictEqual(ops.get().maintenance, false);
});
