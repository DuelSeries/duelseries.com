'use strict';
// Send the house wallets home (server/houseSweep.js): preview only reads; send moves exactly
// the lamports the owner was shown, never while the guard refuses, one at a time.
const test = require('node:test');
const assert = require('node:assert');
const { Keypair, Transaction, SystemProgram, SystemInstruction } = require('@solana/web3.js');
const { createHouseSweep, FEE_LAMPORTS } = require('../server/houseSweep');

const bot = Keypair.generate();
const escrow = Keypair.generate();
const dest = Keypair.generate().publicKey.toBase58();

function fakeConn(balances) {
  const sent = [];
  return {
    sent,
    balances,
    async getBalance(pk) { return balances[pk.toBase58()] || 0; },
    async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }; },
    async sendRawTransaction(raw) {
      const tx = Transaction.from(raw);
      sent.push(tx);
      return 'sig' + sent.length;
    },
    async confirmTransaction() { return { value: { err: null } }; },
  };
}
const quiet = { warn() {}, error() {} };
const make = (conn, extra = {}) => createHouseSweep({
  conn, log: quiet, defaultTo: dest,
  wallets: () => [{ key: 'bot', name: 'Bot bank', keypair: bot }, { key: 'escrow', name: 'Escrow', keypair: escrow }],
  ...extra,
});

test('preview reads each wallet, less the fee, and never sends or leaks a key', async () => {
  const conn = fakeConn({ [bot.publicKey.toBase58()]: 142636000, [escrow.publicKey.toBase58()]: 3000 });
  const r = await make(conn).preview();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.defaultTo, dest);
  assert.deepStrictEqual(r.wallets.map((w) => [w.key, w.lamports, w.send]), [['bot', 142636000, 142636000 - FEE_LAMPORTS], ['escrow', 3000, 0]]);
  assert.ok(r.wallets.every((w) => !('keypair' in w)));
  assert.ok(!JSON.stringify(r).includes('secretKey'));
  assert.strictEqual(conn.sent.length, 0);
});

test('the guard blocks the send (and shows why in the preview)', async () => {
  const conn = fakeConn({ [bot.publicKey.toBase58()]: 1e8 });
  const s = make(conn, { guard: async () => 'Close the site first.' });
  const p = await s.preview();
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.why, 'Close the site first.');
  const r = await s.send({ to: dest, expect: { bot: 1e8 - FEE_LAMPORTS, escrow: 0 } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(conn.sent.length, 0);
});

test('a balance that changed since the preview is refused', async () => {
  const conn = fakeConn({ [bot.publicKey.toBase58()]: 1e8, [escrow.publicKey.toBase58()]: 5e7 });
  const r = await make(conn).send({ to: dest, expect: { bot: 1e8 - FEE_LAMPORTS, escrow: 9e7 } });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /Escrow balance changed/);
  assert.strictEqual(conn.sent.length, 0);
  const none = await make(conn).send({ to: dest });
  assert.strictEqual(none.ok, false);
  assert.strictEqual(conn.sent.length, 0);
});

test('bad, off-curve and house destinations are refused', async () => {
  const conn = fakeConn({ [bot.publicKey.toBase58()]: 1e8 });
  const expect = { bot: 1e8 - FEE_LAMPORTS, escrow: 0 };
  const s = make(conn);
  assert.match((await s.send({ to: 'not-an-address', expect })).why, /not a Solana address/);
  assert.match((await s.send({ to: '', expect })).why, /not a Solana address/);
  // a program-derived address has no private key: coins sent there are stuck
  const { PublicKey } = require('@solana/web3.js');
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('x')], SystemProgram.programId);
  assert.match((await s.send({ to: pda.toBase58(), expect })).why, /not a normal wallet/);
  assert.match((await s.send({ to: escrow.publicKey.toBase58(), expect })).why, /one of the house wallets/);
  assert.strictEqual(conn.sent.length, 0);
});

test('send moves exactly the shown lamports from each wallet to the address', async () => {
  const conn = fakeConn({ [bot.publicKey.toBase58()]: 142636000, [escrow.publicKey.toBase58()]: 32814000 });
  const s = make(conn);
  const p = await s.preview();
  const expect = Object.fromEntries(p.wallets.map((w) => [w.key, w.send]));
  const r = await s.send({ to: dest, expect });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.to, dest);
  assert.deepStrictEqual(r.results.map((x) => [x.key, x.sent, x.sig]), [['bot', 142631000, 'sig1'], ['escrow', 32809000, 'sig2']]);
  assert.strictEqual(conn.sent.length, 2);
  conn.sent.forEach((tx, i) => {
    const from = i ? escrow : bot;
    assert.strictEqual(tx.feePayer.toBase58(), from.publicKey.toBase58());
    assert.ok(tx.verifySignatures());
    assert.strictEqual(tx.instructions.length, 1);
    const ix = SystemInstruction.decodeTransfer(tx.instructions[0]);
    assert.strictEqual(ix.fromPubkey.toBase58(), from.publicKey.toBase58());
    assert.strictEqual(ix.toPubkey.toBase58(), dest);
    assert.strictEqual(Number(ix.lamports), expect[i ? 'escrow' : 'bot']);
  });
});

test('one send at a time', async () => {
  const conn = fakeConn({ [bot.publicKey.toBase58()]: 1e8 });
  let release;
  const gate = new Promise((res) => { release = res; });
  const s = make(conn, { guard: async () => { await gate; return null; } });
  const expect = { bot: 1e8 - FEE_LAMPORTS, escrow: 0 };
  const first = s.send({ to: dest, expect });
  const second = await s.send({ to: dest, expect });
  assert.match(second.why, /already running/);
  release();
  assert.strictEqual((await first).ok, true);
  assert.strictEqual(conn.sent.length, 1);
});

test('a failed transfer is reported and does not stop the next wallet', async () => {
  const conn = fakeConn({ [bot.publicKey.toBase58()]: 1e8, [escrow.publicKey.toBase58()]: 2e7 });
  const realSend = conn.sendRawTransaction;
  let n = 0;
  conn.sendRawTransaction = async (raw) => { if (++n === 1) throw new Error('node down'); return realSend(raw); };
  const r = await make(conn).send({ to: dest, expect: { bot: 1e8 - FEE_LAMPORTS, escrow: 2e7 - FEE_LAMPORTS } });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.results.map((x) => [x.key, x.sent, !!x.error]), [['bot', 0, true], ['escrow', 2e7 - FEE_LAMPORTS, false]]);
});
