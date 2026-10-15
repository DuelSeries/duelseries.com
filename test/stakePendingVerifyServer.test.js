'use strict';
/* Security review 2026-10-15, findings 3 and 5, against the real server/index.js, booted by
   scripts/dev-local.js in this test's own process (in-memory database from scripts/memLedgerDb.js,
   every outbound call refused but this test's own localhost socket). The REAL Wallet.submitStake
   runs on real signed bytes; only the chain under it is stubbed (Wallet.connection's send and
   status reads, Usdc.verifyUsdcStake, and the sweep's Wallet.stakeSigStatus and blockhashValid).
   - a stake's pending-verify row exists before its bytes are sent, and becomes its stake row;
   - a second submit of the same bytes, while the first is in flight or after, is refused without
     being sent, and the first gets the token (the front-run);
   - a stake whose verify fails after the broadcast leaves its pending-verify row with the payer
     the bytes name (it used to leave nothing);
   - at boot, the sweep settles the rows an earlier boot left: a landed stake is refunded once to
     the chain's payer through the owed lane, the rest closed or left as the chain says. */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const path = require('path');
const { Keypair, Transaction, SystemProgram } = require('@solana/web3.js');

const ROOT = path.join(__dirname, '..');
const realRequest = http.request;
const realGet = http.get;
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let ipSeq = 0;
function call(port, method, url, body) {
  const ip = '10.9.' + (++ipSeq >> 8) + '.' + (ipSeq & 255);
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
    s.setTimeout(10000, () => s.destroy(new Error('timeout')));
  });
}
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  return fn();
};

// A stake transaction really signed by its payer (the chain is stubbed, so what it moves is moot).
function signedStake(payer) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const raw = tx.serialize();
  return { b64: raw.toString('base64'), sig: bs58.encode(raw.subarray(1, 65)), blockhash: tx.recentBlockhash };
}

const LATE_PAYER = 'LatePayer1111111111111111111111111111111111';
let port, ledgerDb, Wallet;
const sends = [];
const landed = new Set();
let sendGate = null;                // when set, a send waits for it
const verifyOf = new Map();         // sig -> { payer, usdc } or an Error

test.before(async () => {
  port = await freePort();
  process.env.DEV_LOCAL_PORT = String(port);
  process.env.DEV_LOCAL_SEED_STAKES = JSON.stringify([
    // Left by an earlier boot of this NA server, whose requests died with it (a deploy mid-stake).
    { sig: 'late-landed', state: 'verifying', wallet_address: LATE_PAYER, refund_amount: 0.5, label: 'stake 0.5', region: 'na', boot_id: 'dead-boot', blockhash: 'bh-1' },
    { sig: 'late-tier', state: 'verifying', wallet_address: LATE_PAYER, refund_amount: 1, label: 'lobby dollar', region: 'na', boot_id: 'dead-boot', blockhash: 'bh-1' },
    { sig: 'never-landed', state: 'verifying', wallet_address: LATE_PAYER, refund_amount: 1, label: 'stake 1', region: 'na', boot_id: 'dead-boot', blockhash: 'bh-expired', created_at: Date.now() - 10 * 60 * 1000 },
    // Broadcast seconds before the restart: its blockhash may read invalid at 'finalized' and the chain may not show it yet, but it can still land.
    { sig: 'just-broadcast', state: 'verifying', wallet_address: LATE_PAYER, refund_amount: 1, label: 'stake 1', region: 'na', boot_id: 'dead-boot', blockhash: 'bh-expired' },
    { sig: 'still-young', state: 'verifying', wallet_address: LATE_PAYER, refund_amount: 1, label: 'stake 1', region: 'na', boot_id: 'dead-boot', blockhash: 'bh-valid' },
    { sig: 'failed-tx', state: 'verifying', wallet_address: LATE_PAYER, refund_amount: 1, label: 'stake 1', region: 'na', boot_id: 'dead-boot', blockhash: 'bh-1' },
    { sig: 'paid-short', state: 'verifying', wallet_address: LATE_PAYER, refund_amount: 1, label: 'stake 1', region: 'na', boot_id: 'dead-boot', blockhash: 'bh-1' },
    // EU's, fresh: its own server may still be verifying it.
    { sig: 'eu-fresh', state: 'verifying', wallet_address: LATE_PAYER, refund_amount: 1, label: 'stake 1', region: 'eu', boot_id: 'eu-boot', blockhash: 'bh-1' },
  ]);
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
  Wallet = require(path.join(ROOT, 'server', 'Wallet.js'));
  const Usdc = require(path.join(ROOT, 'server', 'Usdc.js'));
  // The chain, stubbed before the boot sweep runs (it waits on db.init, after this turn).
  Wallet.connection.sendRawTransaction = async (raw) => {
    const sig = bs58.encode(Buffer.from(raw).subarray(1, 65));
    sends.push(sig);
    if (sendGate) await sendGate;
    landed.add(sig);
    return sig;
  };
  Wallet.connection.getSignatureStatus = async (sig) => ({ value: landed.has(sig) ? { confirmationStatus: 'confirmed', err: null } : null });
  Wallet.stakeSigStatus = async (sig) => ({ 'late-landed': 'landed', 'late-tier': 'landed', 'failed-tx': 'failed', 'paid-short': 'landed' }[sig] || null);
  Wallet.blockhashValid = async (bh) => bh === 'bh-valid';
  Usdc.verifyUsdcStake = async (sig, min) => {
    if (sig === 'late-landed') return { payer: LATE_PAYER, usdc: 0.5 };
    if (sig === 'late-tier') return { payer: LATE_PAYER, usdc: 1 };
    if (sig === 'paid-short') throw new Error('Stake too small (500000 < 1000000 USDC units)');
    const v = verifyOf.get(sig);
    if (v instanceof Error) throw v;
    if (v) return v;
    throw new Error('Stake transaction not found or not yet confirmed');
  };
  for (let i = 0; i < 60; i++) {
    try { const r = await call(port, 'GET', '/api/live'); if (r.status === 200) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up');
});

test('boot: the rows an earlier boot left are settled as the chain says; a landed stake is refunded once, never minted', async () => {
  const state = (s) => ledgerDb.stakes.get(s).state;
  await until(() => state('late-landed') !== 'verifying' && state('never-landed') !== 'verifying');
  assert.strictEqual(state('late-landed'), 'refunded');
  assert.strictEqual(state('late-tier'), 'refunded');
  assert.strictEqual(state('never-landed'), 'expired', 'its blockhash expired and the chain never saw it');
  assert.strictEqual(state('still-young'), 'verifying', 'its blockhash is still valid: it may land yet');
  assert.strictEqual(state('just-broadcast'), 'verifying', 'under 3 minutes old: never closed as expired, however the blockhash reads');
  assert.strictEqual(state('failed-tx'), 'failed');
  assert.strictEqual(state('paid-short'), 'rejected', 'paid less than it was for: owed nothing, as at the request');
  assert.strictEqual(state('eu-fresh'), 'verifying', 'another region\'s fresh row is left to its server');
  const owed = ledgerDb.payouts.filter((p) => p.stake_sig && p.stake_sig.startsWith('late-'))
    .map((p) => [p.stake_sig, p.wallet_address, p.amount_sol]).sort();
  assert.deepStrictEqual(owed, [['late-landed', LATE_PAYER, 0.5], ['late-tier', LATE_PAYER, 1]]);
  for (const p of ledgerDb.payouts) assert.match(p.reason, /^refund /, 'a refund, never booked as winnings');
});

test('a stake\'s pending-verify row is written before its bytes are sent, and becomes its stake row', async () => {
  const payer = Keypair.generate();
  const s = signedStake(payer);
  verifyOf.set(s.sig, { payer: payer.publicKey.toBase58(), usdc: 0.5 });
  let release;
  sendGate = new Promise((r) => { release = r; });
  const p = call(port, 'POST', '/api/submit-stake', { stake: 0.5, signedTx: s.b64, walletAddress: payer.publicKey.toBase58() });
  await until(() => sends.includes(s.sig));
  const rowAtSend = Object.assign({}, ledgerDb.stakes.get(s.sig));
  release();
  sendGate = null;
  const r = await p;
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(r.json.entryToken);
  assert.strictEqual(rowAtSend.state, 'verifying', 'the row existed when the bytes went out');
  assert.strictEqual(rowAtSend.wallet_address, payer.publicKey.toBase58(), 'the fee payer the bytes name');
  assert.strictEqual(rowAtSend.blockhash, s.blockhash);
  assert.strictEqual(rowAtSend.refund_amount, 0.5);
  const row = ledgerDb.stakes.get(s.sig);
  assert.deepStrictEqual([row.state, row.wallet_address, row.refund_amount, row.label], ['pending', payer.publicKey.toBase58(), 0.5, 'stake 0.5']);
  // The same bytes again later: refused before they are sent.
  const before = sends.length;
  const again = await call(port, 'POST', '/api/submit-stake', { stake: 0.5, signedTx: s.b64, walletAddress: payer.publicKey.toBase58() });
  assert.strictEqual(again.status, 400);
  assert.strictEqual(again.json.error, 'Stake already used');
  assert.strictEqual(sends.length, before, 'not sent again');
});

test('two submits of the same bytes, the second after the first was sent: the second is refused unsent, the first gets the token', async () => {
  const payer = Keypair.generate();
  const s = signedStake(payer);
  verifyOf.set(s.sig, { payer: payer.publicKey.toBase58(), usdc: 1 });
  let release;
  sendGate = new Promise((r) => { release = r; });
  const first = call(port, 'POST', '/api/submit-stake', { stake: 1, signedTx: s.b64, walletAddress: payer.publicKey.toBase58() });
  await until(() => sends.includes(s.sig));                      // the victim's request has broadcast
  const thief = await call(port, 'POST', '/api/submit-stake', { stake: 1, signedTx: s.b64, walletAddress: 'Thief111111111111111111111111111111111111111' });
  assert.strictEqual(thief.status, 400);
  assert.strictEqual(thief.json.error, 'Stake already used');
  assert.strictEqual(sends.filter((x) => x === s.sig).length, 1, 'the second submit never reached the chain');
  release();
  sendGate = null;
  const r = await first;
  assert.strictEqual(r.status, 200, r.text);
  assert.ok(r.json.entryToken, 'the payer\'s own request gets the token');
  assert.strictEqual(ledgerDb.stakes.get(s.sig).wallet_address, payer.publicKey.toBase58());
});

test('a verify that fails after the broadcast leaves the pending-verify row, with the payer the bytes name', async () => {
  const payer = Keypair.generate();
  const s = signedStake(payer);
  verifyOf.set(s.sig, new Error('Stake transaction not found or not yet confirmed'));
  const r = await call(port, 'POST', '/api/submit-stake', { stake: 1, signedTx: s.b64, walletAddress: payer.publicKey.toBase58() });
  assert.strictEqual(r.status, 400);
  assert.ok(sends.includes(s.sig), 'it was broadcast');
  const row = ledgerDb.stakes.get(s.sig);
  assert.ok(row, 'the row survives the failed request (before this fix there was none)');
  assert.deepStrictEqual([row.state, row.wallet_address, row.refund_amount, row.label, row.region],
    ['verifying', payer.publicKey.toBase58(), 1, 'stake 1', 'na']);
  // The tier path writes it the same way.
  const t = signedStake(payer);
  verifyOf.set(t.sig, new Error('rpc 503'));
  const r2 = await call(port, 'POST', '/api/submit-stake', { lobbyType: 'dollar', signedTx: t.b64 });
  assert.strictEqual(r2.status, 400);
  assert.deepStrictEqual([ledgerDb.stakes.get(t.sig).state, ledgerDb.stakes.get(t.sig).label], ['verifying', 'lobby dollar']);
});

test('bytes that are not a transaction its payer signed are refused before any row or broadcast', async () => {
  const payer = Keypair.generate();
  const s = signedStake(payer);
  const raw = Buffer.from(s.b64, 'base64');
  const tampered = Buffer.from(raw);
  tampered.fill(7, 1, 65);                                        // someone else's "signature"
  const n = sends.length, rows = ledgerDb.stakes.size;
  for (const signedTx of [Buffer.from('junk').toString('base64'), tampered.toString('base64')]) {
    const r = await call(port, 'POST', '/api/submit-stake', { stake: 0.5, signedTx });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /Not a signed transaction|not signed by its payer/);
  }
  assert.strictEqual(sends.length, n, 'nothing sent');
  assert.strictEqual(ledgerDb.stakes.size, rows, 'no row written');
});
