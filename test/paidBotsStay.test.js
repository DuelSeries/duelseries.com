'use strict';
// Paid bounty bots stay (Owen 2026-10-18): bots in a paid room keep playing with nobody there, their seed held, and a
// restart gives the seed back to the bank and brings the same bots back at boot. Before this, a boot asked the bank
// for seeds before the Bot bank wallet's balance was read, got "bank empty", and saved the bot counts as 0, so every
// deploy lost Owen's bots for good.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBotBank } = require('../server/botBank');
const { paidRig } = require('./slPaidFakes');
const { createBotDriver } = require('../server/sl/slBots');

const quiet = { log() {}, warn() {}, error() {} };
const flush = () => new Promise((r) => setImmediate(r));
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stay-')), 'b.json');

function rig(bank, saved) {
  const mem = { obj: saved || null };
  const store = { load: () => mem.obj, save: (o) => { mem.obj = o; return true; } };
  let r = null;
  r = paidRig({ arenas: { botDriver: () => createBotDriver(r.laws, {}), botStore: store, botBank: bank } });
  return { r, mem };
}

test('room empty for 10 min: the bots and their seed remain', () => {
  const bank = createBotBank({ file: tmp(), log: quiet });
  bank.credit(10e6, 'SIGSTAY');
  bank.setCap(50e6);
  const { r, mem } = rig(bank);
  assert.equal(r.paid.setBotTarget(0.5, 4).live, 4);
  const room = r.paid.rooms()[0];
  for (let i = 0; i < 10; i++) {
    r.step(60);
    r.paid.sweep(r.wall.t += 60 * 1000);
  }
  assert.ok(r.paid.rooms().includes(room), 'room #0 is never retired');
  assert.equal(room.botCount, 4);
  assert.equal(room.awake, true);
  for (const id of room.money.botFrom.keys()) assert.equal(room.money.botBalance(id), 500000, 'seed still held');
  assert.equal(bank.balanceMicro(), 8e6, 'nothing came back to the bank');
  assert.deepEqual(mem.obj, { 0.5: 4 });
  assert.deepEqual(room.money.lastViolations, []);
});

test('restart: seed returns to the bank, and the bots come back at boot before the wallet is read', async () => {
  // before the restart: 3 bots, then shutdown gives every seed back and keeps the saved count
  const file = tmp();
  const a = createBotBank({ file, log: quiet });
  a.credit(1.5e6, 'SIGOLD');
  a.setCap(50e6);
  const A = rig(a);
  assert.equal(A.r.paid.setBotTarget(0.5, 3).live, 3);
  assert.equal(a.balanceMicro(), 0);
  A.r.paid.shutdownSettle('shutdown');
  assert.equal(a.balanceMicro(), 1.5e6, 'every seed back to the bank');
  assert.equal(a.view().spentToday, 0);
  assert.deepEqual(A.mem.obj, { 0.5: 3 });

  // the float went home to the wallet meanwhile; the new boot's wallet balance is not read yet
  let t = 1e12;
  const chain = { wallet: null, escrow: 0, n: 0, fate: new Map(), address: 'BotBankAddr' };
  chain.usdcMicro = () => chain.wallet;
  chain.solLamports = () => 5e6;
  chain.build = async (dir, micro) => {
    const sig = 'sig' + (++chain.n);
    chain.fate.set(sig, { dir, micro, s: 'pending' });
    return { sig, raw: 'raw-' + sig, lvbh: 100 };
  };
  chain.broadcast = async () => {};
  chain.status = async (sig) => chain.fate.get(sig).s;
  const b = createBotBank({ file: tmp(), log: quiet, chain, tickMs: 0, now: () => t });
  b.setCap(50e6);
  const B = rig(b, A.mem.obj);
  b.onReady(() => B.r.paid.resumeBots());
  B.r.paid.startBots();
  assert.equal(B.r.paid.botCount(0.5), 0, 'waiting for the wallet read');
  B.r.paid.sweep(B.r.wall.t += 60 * 1000);
  assert.deepEqual(B.mem.obj, { 0.5: 3 }, 'the saved count survives the wait (it went to 0 before)');

  // the read lands: the bank funds the seeds from its wallet, then the bots spawn
  chain.wallet = 1.5e6;
  t += 6000;
  await b.tick();
  await flush();
  assert.equal(chain.fate.size, 1, 'one fund from the wallet');
  const [sig, f] = Array.from(chain.fate)[0];
  assert.equal(f.dir, 'in');
  f.s = 'landed';
  chain.wallet -= f.micro;
  await b.tick();
  assert.equal(B.r.paid.botCount(0.5), 3, 'the same bots are back');
  assert.ok(sig);
  assert.deepEqual(B.mem.obj, { 0.5: 3 });
  for (const id of B.r.paid.rooms()[0].money.botFrom.keys()) assert.equal(B.r.paid.rooms()[0].money.botBalance(id), 500000);
});
