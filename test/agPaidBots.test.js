'use strict';
// Paid agar.io bounty bots (Owen 2026-10-17, as paid slither): each bot spawns worth its room's stake from the owner's
// bot bank, eats and is eaten like a person, shows its $ like a person, never cashes out, and is never replaced. Tested:
//   - the sim: a bot eats a person (a money fact) and a person eats a bot (a money fact)
//   - the money: a bot that eats a person holds that person's money; a person who eats the bot wins all of it and the
//     seed counts as spent; removal, restart and emergency send the seed back to the bank and the rest back to its
//     owners as keyed rows, never the house; ledger: stakes in + seed in == cash-outs + owed + seed back + live
//   - the directory: the bank and the daily limit decide how many bots spawn, Control 0 gives every seed back, a
//     dead bot is not replaced, saved counts come back at boot
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSim } = require('../server/ag/agSim');
const { AgArenas } = require('../server/ag/agArenas');
const { AgMoney } = require('../server/ag/agMoney');
const { createBotBank } = require('../server/botBank');
const { FIXTURE } = require('./agLawsFixture');

const BIG = { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 };
const noop = () => {};
const quiet = { log: noop, warn: noop, error: noop };
const STAKE = 500000;

test('in a paid sim bots eat people and people eat bots, each a money fact', () => {
  const sim = createSim({ laws: FIXTURE, seed: 1, border: BIG, food: false, viruses: false,
    paid: { shielded: new Set(), still: new Set() } });
  const bot = sim.addPlayer({ name: 'b', bot: true });
  const human = sim.addPlayer({ name: 'h', bot: false });
  sim.debugPlace({ kind: 'player', owner: bot, x: 0, y: 0, size: 300 });
  sim.debugPlace({ kind: 'player', owner: human, x: 10, y: 0, size: 40 });
  let facts = [];
  for (let t = 0; t < 30; t++) facts = facts.concat(sim.step().money);
  assert.deepStrictEqual(facts.map((f) => [f.eater, f.victim, f.last]), [[bot, human, true]]);
  const bot2 = sim.addPlayer({ name: 'b2', bot: true });
  const h2 = sim.addPlayer({ name: 'h2', bot: false });
  sim.debugPlace({ kind: 'player', owner: h2, x: 2000, y: 2000, size: 300 });
  sim.debugPlace({ kind: 'player', owner: bot2, x: 2010, y: 2000, size: 40 });
  facts = [];
  for (let t = 0; t < 30; t++) facts = facts.concat(sim.step().money);
  assert.deepStrictEqual(facts.map((f) => [f.eater, f.victim, f.last]), [[h2, bot2, true]]);
});

// A paid controller with people 1 and 2 (open accounts) and bounty bot 9, on spy hooks.
function moneyRig() {
  const calls = { seedBack: [], spent: [], owed: [], refund: [], cash: [], house: [] };
  const sim = { playerInfo: () => ({ cells: [1] }), getCell: () => ({ size: 10 }), takeMoneyEvents: () => ({ money: [] }) };
  let n = 0;
  const hooks = {
    onCashout: (o) => calls.cash.push(o), onTransfer: noop, onFeed: noop, onRefund: (x) => calls.refund.push(x),
    onBreach: noop, onStake: noop, onHouse: (x) => calls.house.push(x), onAccountOpen: noop, onAccountClosed: noop,
    onSeedBack: (m, why, label, live) => calls.seedBack.push([m, live]), onSeedSpent: (m) => calls.spent.push(m),
    onOwed: (row, live) => calls.owed.push(Object.assign({ live }, row)),
  };
  const m = new AgMoney({ sim, stake: 0.5, label: 'ag_na_s0_5', hooks, shielded: new Set(), still: new Set(), log: quiet,
    uuid: () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0') });
  m.open({ pid: 1, wallet: 'W1', name: 'one', micro: STAKE, paid: 0.5 });
  m.open({ pid: 2, wallet: 'W2', name: 'two', micro: STAKE, paid: 0.5 });
  m.seedBot(9, STAKE, 'botty');
  return { m, calls };
}

function ledger(m, calls, rows) {
  const out = calls.cash.reduce((k, o) => k + (o.grossMicro || 0), 0) + calls.refund.reduce((k, o) => k + (o.micro || 0), 0) +
    calls.owed.concat(rows || []).reduce((k, o) => k + o.micro, 0) + calls.seedBack.reduce((k, x) => k + x[0], 0);
  assert.strictEqual(3 * STAKE, out + m.bank.totalMicro(), 'stakes in + seed in == out + live');
  assert.deepStrictEqual(calls.house, [], 'nothing to the house');
}

test('a bot eats a person and holds that money; a person eats the bot and wins all of it, the seed spent', () => {
  const { m, calls } = moneyRig();
  m.afterStep({ money: [{ eater: 9, victim: 1, eatenSq: 1, victimSq: 1, last: true }] });
  assert.strictEqual(m.balance(9), 2 * STAKE);
  assert.strictEqual(m.account(1), null, 'person 1 was eaten');
  assert.ok(!m.bots.get(9) || m.snakes.size === 1, 'a bot is never a seat');
  m.afterStep({ money: [{ eater: 2, victim: 9, eatenSq: 1, victimSq: 1, last: true }] });
  assert.strictEqual(m.balance(2), 3 * STAKE);
  assert.strictEqual(m.bots.has(9), false);
  assert.deepStrictEqual(calls.spent, [STAKE], 'the seed is in play now');
  ledger(m, calls);
});

test('removal, restart and emergency: the seed back to the bank, a person\'s money back to them, never the house', () => {
  let r = moneyRig();
  r.m.afterStep({ money: [{ eater: 9, victim: 1, eatenSq: 1, victimSq: 1, last: true }] });
  r.m.retireBot(9, 'removed');
  assert.deepStrictEqual(r.calls.seedBack, [[STAKE, true]]);
  assert.deepStrictEqual(r.calls.owed.map((x) => [x.wallet, x.micro, x.live]), [['W1', STAKE, true]]);
  assert.match(r.calls.owed[0].key, /^agowed:[0-9a-f-]{36}$/);
  ledger(r.m, r.calls);
  r = moneyRig();
  r.m.afterStep({ money: [{ eater: 9, victim: 1, eatenSq: 1, victimSq: 1, last: true }] });
  const rows = r.m.shutdownSettle('shutdown');
  assert.deepStrictEqual(r.calls.seedBack, [[STAKE, true]]);
  assert.ok(rows.some((x) => x.wallet === 'W1' && x.micro === STAKE), 'W1 owed back what the bot took');
  assert.strictEqual(r.m.bank.totalMicro(), 0);
  r = moneyRig();
  r.m.emergencySettle();
  assert.deepStrictEqual(r.calls.seedBack, [[STAKE, true]]);
  assert.deepStrictEqual(r.calls.house, []);
});

function rig(saved, fundUsd = 50, capUsd = 50) {
  const mem = { obj: saved || null };
  const bank = createBotBank({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agbank-')), 'b.json'), log: quiet });
  if (fundUsd > 0) bank.credit(fundUsd * 1e6, 'SIG' + Math.random());
  bank.setCap(capUsd * 1e6);
  const calls = { owed: [] };
  const arenas = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 5, log: quiet, paid: true,
    botStore: { load: () => mem.obj, save: (o) => { mem.obj = o; return true; } }, botBank: bank,
    moneyHooks: { onCashout: noop, onRefund: noop, onTransfer: noop, onFeed: noop, onBreach: noop, onStake: noop,
      onHouse: noop, onOwed: (row) => calls.owed.push(row) } });
  return { arenas, mem, bank, calls };
}

test('the bank and the daily limit decide how many bots spawn; Control 0 gives every seed back; no respawn', () => {
  const { arenas, bank, mem } = rig(null, 1.5, 50);
  const r = arenas.setBotTarget(0.5, 5);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.live, 3);
  assert.match(r.why, /bot bank cannot cover/);
  const room = arenas.rungs.get(0.5)[0];
  for (const pid of room.bots.keys()) assert.strictEqual(room.money.balance(pid), STAKE, 'each bot worth the stake');
  assert.strictEqual(room.awake, true);
  assert.deepStrictEqual(mem.obj, { 0.5: 3 });
  // a bot dies (its cells cleared): never replaced, the count follows
  const pid = room.bots.keys().next().value;
  room.money.bots.delete(pid); // as its last cell's eat would (the money moved with it)
  room.money.bank.withdraw(pid);
  room.sim.clearCells(pid);
  room.tickOnce();
  assert.strictEqual(room.bots.size, 2, 'not replaced');
  arenas.setBotTarget(0.5, 0);
  assert.strictEqual(room.bots.size, 0);
  assert.strictEqual(bank.balanceMicro(), 1000000, 'the two live seeds back');
  const capped = rig(null, 50, 1);
  assert.strictEqual(capped.arenas.setBotTarget(1, 3).live, 1);
});

test('saved counts come back at boot', () => {
  const { arenas } = rig({ 1: 2 });
  arenas.startBots();
  assert.strictEqual(arenas.botCount(1), 2);
});
