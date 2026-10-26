'use strict';
/* A Google/email player's linked Phantom (2026-10-26): Add funds from it, Withdraw to it, never the game wallet.
   wallet-widget/src/linkedWallet.mjs driven with a Phantom-like Wallet Standard stub holding a real key, then the
   signed transfers through the REAL server's /api/broadcast (dev-local, every outbound call refused, the network's
   send stubbed to record the bytes): exactly the amount, from the linked wallet to the player's own game wallet, and
   neither move touches the stake ledger or the payout lanes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const { Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } = require('@solana/web3.js');

const ROOT = path.join(__dirname, '..');
const lw = () => import('../wallet-widget/src/linkedWallet.mjs');
const bw = () => import('../wallet-widget/src/browserWallets.mjs');

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
  return { w, kp, seed, address: account.address, signed };
}
const BH = () => Keypair.generate().publicKey.toBase58();

test('the linked wallet is the account\'s browser wallet: never Privy\'s own, never the game wallet, the last one linked', async () => {
  const { linkedOf } = await lw();
  const game = Keypair.generate().publicKey.toBase58(), a = Keypair.generate().publicKey.toBase58(), b = Keypair.generate().publicKey.toBase58();
  const user = { linkedAccounts: [
    { type: 'email', address: 'x@y.z' },
    { type: 'wallet', chainType: 'solana', address: game, walletClientType: 'privy', connectorType: 'embedded' },
    { type: 'wallet', chainType: 'solana', address: a, walletClientType: 'solflare', connectorType: 'solana_adapter' },
    { type: 'wallet', chainType: 'solana', address: b, walletClientType: 'phantom', connectorType: 'solana_adapter' },
    { type: 'wallet', chainType: 'ethereum', address: '0xabc', walletClientType: 'metamask' },
  ] };
  assert.deepEqual(linkedOf(user, game), { address: b, clientType: 'phantom', name: 'Phantom' });
  assert.equal(linkedOf({ linkedAccounts: user.linkedAccounts.slice(0, 2) }, game), null, 'none linked');
  assert.equal(linkedOf({ linkedAccounts: [{ type: 'wallet', chainType: 'solana', address: game, walletClientType: 'privy-v2' }] }, 'other'), null,
    'a Privy wallet is never the linked one, whatever version');
});

test('linking: connect, Privy\'s SIWS link message signed by the wallet, sent as base64 with its type; never the game wallet itself', async () => {
  const { linkWith } = await lw();
  const p = phantom();
  let sent = null;
  const addr = await linkWith(p.w, { generateSiwsMessage: async ({ address }) => 'link ' + address, linkWithSiws: async (a) => { sent = a; },
                                     gameAddress: 'Game1111111111111111111111111111111111111111' });
  assert.equal(addr, p.address);
  assert.equal(sent.walletClientType, 'phantom');
  assert.equal(sent.connectorType, 'solana_adapter');
  assert.ok(ed25519.verify(Uint8Array.from(Buffer.from(sent.signature, 'base64')), new TextEncoder().encode(sent.message), bs58.decode(p.address)));
  const q = phantom();
  await assert.rejects(linkWith(q.w, { generateSiwsMessage: async () => 'm', linkWithSiws: async () => {}, gameAddress: q.address }), /your DuelSeries wallet itself/);
  const r = phantom();
  await assert.rejects(linkWith(r.w, { generateSiwsMessage: async () => 'm', gameAddress: 'G',
    linkWithSiws: async () => { throw new Error('Wallet is already linked to another user'); } }), /already its own DuelSeries account/);
});

test('an add keeps 0.001 SOL in the linked wallet, is at least 0.001 SOL, and is refused on an unread balance', async () => {
  const { addProblem, maxAddLamports, ADD_FEE_LAMPORTS, MIN_ADD_LAMPORTS } = await lw();
  assert.equal(ADD_FEE_LAMPORTS, 7000, 'base fee plus a 2000-lamport priority fee');
  const have = 50_000_000;
  assert.equal(maxAddLamports(have), have - 1_000_000 - ADD_FEE_LAMPORTS);
  assert.equal(addProblem(have, maxAddLamports(have)), null);
  assert.match(addProblem(have, maxAddLamports(have) + 1), /keeps 0\.001 SOL/);
  assert.match(addProblem(have, MIN_ADD_LAMPORTS - 1), /at least 0\.001 SOL/);
  assert.match(addProblem(null, 2_000_000), /Could not read/);
  assert.match(addProblem(have, 1.5), /Enter an amount/);
  assert.equal(maxAddLamports(500_000), 0);
});

test('the add is exactly: a priority fee, then the amount from the linked wallet to the game wallet, which it pays the fee for', async () => {
  const { buildAdd, ADD_CU_LIMIT, ADD_CU_PRICE } = await lw();
  const p = phantom(), game = Keypair.generate().publicKey.toBase58();
  const bytes = buildAdd({ from: p.address, to: game, lamports: 33_333_333, blockhash: BH() });
  const tx = Transaction.from(bytes);
  assert.equal(tx.feePayer.toBase58(), p.address);
  assert.equal(tx.instructions.length, 3);
  assert.deepEqual(tx.instructions.slice(0, 2).map((i) => i.programId.toBase58()), [ComputeBudgetProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58()]);
  const t = tx.instructions[2];
  assert.equal(t.programId.toBase58(), SystemProgram.programId.toBase58());
  assert.deepEqual(t.keys.map((k) => k.pubkey.toBase58()), [p.address, game]);
  assert.equal(Buffer.from(t.data).readUInt32LE(0), 2, 'a plain transfer');
  assert.equal(Number(Buffer.from(t.data).readBigUInt64LE(4)), 33_333_333, 'the exact amount');
  assert.equal(ADD_CU_LIMIT * ADD_CU_PRICE / 1e6, 2000);
  assert.throws(() => buildAdd({ from: p.address, to: p.address, lamports: 2_000_000, blockhash: BH() }), /itself/);
  assert.throws(() => buildAdd({ from: p.address, to: game, lamports: 10, blockhash: BH() }), /at least 0\.001 SOL/);
  assert.throws(() => buildAdd({ from: p.address, to: game, lamports: 2_000_000, blockhash: '' }), /Network busy/);
});

/* ── through the real server ── */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const pt = s.address().port; s.close(() => resolve(pt)); });
  });
}
let ipSeq = 0;
function call(port, method, url, body) {
  const ip = '10.12.' + (++ipSeq >> 8) + '.' + (ipSeq & 255);
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
        for (;;) { const i = rest.indexOf('\r\n'); const n = parseInt(rest.slice(0, i), 16); if (!n) break; text += rest.slice(i + 2, i + 2 + n); rest = rest.slice(i + 2 + n + 2); }
      }
      let json = null; try { json = JSON.parse(text); } catch (_) {}
      resolve({ status, json, text });
    });
    s.on('error', reject);
    s.setTimeout(5000, () => s.destroy(new Error('timeout')));
  });
}
let port, ledgerDb;
const relayed = [];
test.before(async () => {
  port = await freePort();
  process.env.DEV_LOCAL_PORT = String(port);
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { ({ ledgerDb } = require(path.join(ROOT, 'scripts', 'dev-local.js'))); } finally { console.log = log; console.warn = warn; }
  const realRequest = http.request, realGet = http.get, blocked = http.request;
  const local = (a) => a && typeof a === 'object' && ['localhost', '127.0.0.1'].includes(a.hostname || a.host) && Number(a.port) === port;
  http.request = function (...a) { return local(a[0]) ? realRequest.apply(http, a) : blocked.apply(http, a); };
  http.get = function (...a) { return local(a[0]) ? realGet.apply(http, a) : blocked.apply(http, a); };
  const Wallet = require(path.join(ROOT, 'server', 'Wallet.js'));
  // the network: only fully signed bytes go out, and they are recorded exactly as relayed
  Wallet.submitStake = async (bytes) => { const tx = Transaction.from(bytes); if (!tx.verifySignatures()) throw new Error('signature verification failed');
    relayed.push(tx); return bs58.encode(tx.signature); };
  for (let i = 0; i < 60; i++) {
    try { const r = await call(port, 'GET', '/api/live'); if (r.status === 200) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up');
});

test('Add funds from Phantom: one approval, relayed exactly, from the linked wallet to the game wallet; no ledger row, no payout', async () => {
  const { buildAdd, addProblem } = await lw();
  const { signTransactionWith } = await bw();
  const p = phantom(), game = Keypair.generate().publicKey.toBase58();
  await p.w.features['standard:connect'].connect();
  const stakesBefore = ledgerDb.stakes.size, payoutsBefore = ledgerDb.payouts.length;
  const lamports = 25_000_000;
  assert.equal(addProblem(500_000_000, lamports), null);
  const { signedTransaction } = await signTransactionWith(p.w, p.address, buildAdd({ from: p.address, to: game, lamports, blockhash: BH() }));
  assert.equal(p.signed.length, 1, 'one approval in Phantom');
  const r = await call(port, 'POST', '/api/broadcast', { signedTx: Buffer.from(signedTransaction).toString('base64') });
  assert.equal(r.status, 200, r.text);
  const tx = relayed[relayed.length - 1];
  const t = tx.instructions[2];
  assert.deepEqual([tx.feePayer.toBase58(), t.keys[0].pubkey.toBase58(), t.keys[1].pubkey.toBase58(), Number(Buffer.from(t.data).readBigUInt64LE(4))],
    [p.address, p.address, game, lamports]);
  assert.equal(ledgerDb.stakes.size, stakesBefore, 'no stake row');
  assert.equal(ledgerDb.payouts.length, payoutsBefore, 'no payout');
});

test('Withdraw to Phantom: the ordinary withdraw, signed by the game wallet, to the linked address', async () => {
  const game = Keypair.generate(), p = phantom();
  const tx = new Transaction({ feePayer: game.publicKey, recentBlockhash: BH() })
    .add(SystemProgram.transfer({ fromPubkey: game.publicKey, toPubkey: new PublicKey(p.address), lamports: 10_000_000 }));
  tx.partialSign(game);
  const r = await call(port, 'POST', '/api/broadcast', { signedTx: tx.serialize().toString('base64') });
  assert.equal(r.status, 200, r.text);
  const out = relayed[relayed.length - 1].instructions[0];
  assert.deepEqual([out.keys[0].pubkey.toBase58(), out.keys[1].pubkey.toBase58()], [game.publicKey.toBase58(), p.address]);
  // an unsigned one is refused before it goes anywhere
  const un = new Transaction({ feePayer: game.publicKey, recentBlockhash: BH() })
    .add(SystemProgram.transfer({ fromPubkey: game.publicKey, toPubkey: new PublicKey(p.address), lamports: 1 }));
  const n = relayed.length;
  const bad = await call(port, 'POST', '/api/broadcast', { signedTx: un.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') });
  assert.equal(bad.status, 400);
  assert.equal(relayed.length, n);
});

test('the widget and the lobby: linked only for Google/email players, adds go to the game wallet, Privy\'s sheet unchanged for everyone else', () => {
  const main = fs.readFileSync(path.join(ROOT, 'wallet-widget', 'src', 'main.jsx'), 'utf8');
  assert.match(main, /const linked = !isExternal && address \? linkedOf\(user, address\) : null;/);
  assert.match(main, /const linkable = !isExternal && address/);
  assert.match(main, /buildAdd\(\{ from: linked\.address, to: address, lamports: n, blockhash \}\)/, 'to the game wallet, nowhere else');
  assert.match(main, /signTransactionWith\(linkedStd, linked\.address, bytes\)/, 'signed by the linked account only');
  assert.match(main, /const why = addProblem\(/, 'checked against a fresh balance first');
  const lobby = fs.readFileSync(path.join(ROOT, 'public', 'js', 'v2', 'wallet.js'), 'utf8');
  assert.match(lobby, /if \(!W\.external && \(W\.linked \|\| \(W\.linkable \|\| \[\]\)\.length\) && window\.DSDialog && window\.DSDialog\.choose\) return fundSheet\(\);\s*privyFund\(\);/,
    'no browser wallet around, or a browser-wallet sign-in: straight to Privy\'s sheet as before');
  assert.match(lobby, /if \(W\.external\) return '';/, 'no To Phantom for a player whose game wallet is the browser wallet');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'v2.html'), 'utf8');
  assert.match(html, /<div id="adveil" class="howveil"/);
  assert.match(html, /if\(isOn\('adveil'\)\)return V2Wallet\.cancelAdd\(\);/);
});
