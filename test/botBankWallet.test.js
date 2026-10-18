'use strict';
// The Bot bank's own wallet (server/botBank.js with a chain, 2026-10-17): a seed moves bot wallet -> escrow and the
// bot waits until it lands; unspent seed goes escrow -> bot wallet, and a failed send puts it back in the float, never
// lost. Escrow solvency: escrow holds players' money plus the bank's float (and a sweep not yet landed). The bank's
// chain only ever knows the two directions between its wallet and escrow, so no path sends bot money to the house.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBotBank } = require('../server/botBank');

const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bbw-')), 'bot-bank.json');
const flush = () => new Promise((r) => setImmediate(r));

// A fake chain: a wallet, an escrow, and transfers that land when the test says so.
function fakeChain(walletMicro) {
  const c = { wallet: walletMicro, escrow: 0, sent: [], fate: new Map(), dirs: [], n: 0, address: 'BotBankAddr' };
  c.usdcMicro = () => c.wallet;
  c.solLamports = () => 5e6;
  c.build = async (dir, micro) => {
    c.dirs.push(dir);
    const sig = 'sig' + (++c.n);
    c.fate.set(sig, { dir, micro, s: 'pending' });
    return { sig, raw: 'raw-' + sig, lvbh: 100 };
  };
  c.broadcast = async (raw) => { c.sent.push(raw); };
  c.status = async (sig) => c.fate.get(sig).s;
  c.land = (sig) => {
    const f = c.fate.get(sig);
    f.s = 'landed';
    if (f.dir === 'in') { c.wallet -= f.micro; c.escrow += f.micro; } else { c.escrow -= f.micro; c.wallet += f.micro; }
  };
  c.fail = (sig) => { c.fate.get(sig).s = 'failed'; };
  return c;
}

test('a seed waits for its fund to land, then is taken from escrow-held bot money', async () => {
  const chain = fakeChain(10e6);
  const bank = createBotBank({ file: tmp(), log: quiet, chain, tickMs: 0 });
  bank.setCap(200e6);
  assert.equal(bank.whyNot(1e6), 'funding');
  assert.equal(bank.take(1e6, 'r'), false);
  await flush();
  const saved = JSON.parse(fs.readFileSync(bank.file, 'utf8'));
  assert.equal(saved.fund.sig, 'sig1', 'the transfer is saved before it is sent');
  assert.equal(chain.sent[0], 'raw-sig1');
  let woke = 0;
  bank.onReady(() => woke++);
  chain.land('sig1');
  await bank.tick();
  assert.equal(woke, 1);
  assert.equal(chain.escrow, 5e6, 'one fund covers up to five seeds');
  assert.equal(bank.balanceMicro(), 5e6, 'escrow holds that much bot money (owed like a stake)');
  assert.equal(bank.whyNot(1e6), null);
  assert.equal(bank.take(1e6, 'r'), true);
  assert.equal(bank.balanceMicro(), 4e6);
});

test('a fund that never lands adds nothing and is not retried at once', async () => {
  const chain = fakeChain(3e6);
  const bank = createBotBank({ file: tmp(), log: quiet, chain, tickMs: 0 });
  assert.equal(bank.whyNot(1e6), 'funding');
  await flush();
  chain.fail('sig1');
  await bank.tick();
  assert.equal(bank.balanceMicro(), 0);
  assert.equal(bank.whyNot(1e6), 'funding', 'the bots keep waiting; the next try starts after the wait');
  assert.equal(chain.dirs.length, 1);
});

test('an empty wallet funds nothing', () => {
  const bank = createBotBank({ file: tmp(), log: quiet, chain: fakeChain(0), tickMs: 0 });
  assert.equal(bank.whyNot(1e6), 'bank');
});

test('unspent seed goes home to the wallet; a failed sweep is owed back to the float, then retried', async () => {
  let t = 1e12;
  const chain = fakeChain(0);
  const file = tmp();
  const bank = createBotBank({ file, log: quiet, chain, tickMs: 0, now: () => t });
  bank.giveBack(2e6, 'removed', 'r', false);
  assert.equal(bank.balanceMicro(), 2e6);
  t += 121000;
  await bank.tick();
  await flush();
  assert.equal(chain.dirs[0], 'out');
  assert.equal(bank.balanceMicro(), 2e6, 'a sweep not yet landed is still owed to the bank (solvency counts it)');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sweep.micro, 2e6);
  chain.fail('sig1');
  await bank.tick();
  assert.equal(bank.balanceMicro(), 2e6, 'failed: back in the float, never lost');
  t += 61000;
  await bank.tick();
  await flush();
  chain.land('sig2');
  await bank.tick();
  assert.equal(bank.balanceMicro(), 0);
  assert.equal(chain.wallet, 2e6, 'the bot wallet has it again');
});

test('a sweep saved before a crash is settled after the restart, never counted twice', async () => {
  let t = 1e12;
  const chain = fakeChain(0);
  const file = tmp();
  const a = createBotBank({ file, log: quiet, chain, tickMs: 0, now: () => t });
  a.giveBack(1e6, 'removed', 'r', false);
  t += 121000;
  await a.tick();
  await flush();
  const b = createBotBank({ file, log: quiet, chain, tickMs: 0, now: () => t });
  assert.equal(b.balanceMicro(), 1e6);
  chain.land('sig1');
  await b.tick();
  assert.equal(b.balanceMicro(), 0);
  assert.equal(chain.wallet, 1e6);
});

test('seed live bots held at a hard stop comes back to the float and goes home', async () => {
  const chain = fakeChain(1e6);
  const file = tmp();
  const a = createBotBank({ file, log: quiet, chain, tickMs: 0 });
  a.whyNot(1e6);
  await flush();
  chain.land('sig1');
  await a.tick();
  assert.equal(a.take(1e6, 'r'), true);
  const b = createBotBank({ file, log: quiet, chain, tickMs: 0 });
  assert.equal(b.balanceMicro(), 1e6);
});

test('ledger: escrow covers players plus bot money, and bot money only ever moves wallet <-> escrow', async () => {
  let t = 1e12;
  const chain = fakeChain(20e6);
  const bank = createBotBank({ file: tmp(), log: quiet, chain, tickMs: 0, now: () => t });
  bank.setCap(200e6);
  const players = 7e6;
  chain.escrow = players;
  let inPlay = 0; // seeds now held by live bots or on the board (counted in live stakes by the games)
  for (let i = 0; i < 12; i++) {
    const why = bank.whyNot(1e6);
    if (why === 'funding') {
      await flush();
      chain.land('sig' + chain.n);
      await bank.tick();
    }
    if (bank.take(1e6, 'r')) inPlay += 1e6;
    assert.ok(chain.escrow >= players + inPlay + bank.balanceMicro(), 'escrow is solvent');
  }
  bank.giveBack(3e6, 'removed', 'r', true);
  inPlay -= 3e6;
  t += 121000;
  await bank.tick();
  await flush();
  chain.land('sig' + chain.n);
  await bank.tick();
  assert.ok(chain.escrow >= players + inPlay + bank.balanceMicro());
  assert.deepEqual(Array.from(new Set(chain.dirs)).sort(), ['in', 'out']);
  assert.equal(chain.wallet + chain.escrow, 27e6, 'nothing left the two wallets');
});

test('a sweep past its block height is only given up after several not-found reads (a lagging node never double-pays)', async () => {
  let t = 1e12;
  const chain = fakeChain(0);
  const bank = createBotBank({ file: tmp(), log: quiet, chain, tickMs: 0, now: () => t });
  bank.giveBack(1e6, 'removed', 'r', false);
  t += 121000;
  await bank.tick();
  await flush();
  chain.fate.get('sig1').s = 'expired';
  await bank.tick();
  await bank.tick();
  assert.equal(bank.balanceMicro(), 1e6, 'still the pending sweep, not re-credited');
  chain.land('sig1');
  await bank.tick();
  assert.equal(bank.balanceMicro(), 0);
  assert.equal(chain.wallet, 1e6, 'landed once');
});

test('sweep, then display, then solvency: the bank total never counts a swept dollar twice', async () => {
  let t = 1e12;
  const chain = fakeChain(0);
  const bank = createBotBank({ file: tmp(), log: quiet, chain, tickMs: 0, now: () => t });
  bank.giveBack(10889738, 'migrate', 'r', false);
  chain.escrow = 10889738;
  assert.equal(bank.view().balance, 10.889738);
  t += 121000;
  await bank.tick();
  await flush();
  chain.land('sig1'); // on-chain, not settled yet
  assert.equal(bank.view().balance, 10.889738, 'wallet has it; the pending sweep is not added on top');
  assert.equal(bank.view().float, 0);
  await bank.tick();
  assert.equal(bank.view().balance, 10.889738);
  assert.equal(bank.balanceMicro(), 0, 'escrow owes the bank nothing once settled');
  assert.ok(chain.escrow >= bank.balanceMicro());
  assert.equal(bank.whyNot(500000), 'funding', 'a seed now funds from the wallet, never a phantom float');
});

test('the real wallet module reads a signature status itself (no missing helper)', async () => {
  const { createBotWallet } = require('../server/botWallet');
  const { Keypair, PublicKey } = require('@solana/web3.js');
  const kp = Keypair.generate();
  const statuses = { a: { value: { confirmationStatus: 'confirmed', err: null } }, b: { value: { err: { x: 1 } } }, c: { value: null } };
  const Usdc = { USDC_MINT: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), USDC_DECIMALS: 6, withRetry: (f) => f(),
    connection: { getSignatureStatus: async (s) => statuses[s], getBlockHeight: async () => 10 } };
  const w = createBotWallet({ dataDir: os.tmpdir(), Usdc, env: { BOT_BANK_PRIVATE_KEY: Buffer.from(kp.secretKey).toString('base64') }, log: quiet });
  assert.equal(w.address, kp.publicKey.toString());
  assert.equal(await w.status('a', 5), 'landed');
  assert.equal(await w.status('b', 5), 'failed');
  assert.equal(await w.status('c', 50), 'pending');
  assert.equal(await w.status('c', 5), 'expired');
});
