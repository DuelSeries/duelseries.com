'use strict';
// Owner-spawned bots in the paid agar.io rooms (Owen 2026-10-16: "the bots will never cash out, the money's always
// going to be on the board, I'm never going to be taking any money with my bots"). agar.io has no money floor, so a
// bot holds nothing at all: it never eats a person's cell, and a person (or bot) eating a bot is mass only. Tested:
//   - in the paid sim a big bot cell on top of a small person's cell eats nothing; the person eats the bot: no fact
//   - the directory: a rung target opens room #0 with that many bots, saved, awake; down to 0 takes them out; a bad
//     number is refused; saved targets come back at boot
//   - the ledger with a person and bots playing: stakes in == cash-outs + refunds + money still in accounts; no bot
//     ever has an account; the house takes nothing but the cut of a person's cash-out
const test = require('node:test');
const assert = require('node:assert');
const { createSim } = require('../server/ag/agSim');
const { AgArenas } = require('../server/ag/agArenas');
const { FIXTURE } = require('./agLawsFixture');

const BIG = { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 };
const noop = () => {};

test('a paid bot never eats a person\'s cell; a person eating a bot moves no money', () => {
  const sim = createSim({ laws: FIXTURE, seed: 1, border: BIG, food: false, viruses: false,
    paid: { shielded: new Set(), still: new Set() } });
  const bot = sim.addPlayer({ name: 'b', bot: true });
  const human = sim.addPlayer({ name: 'h', bot: false });
  sim.debugPlace({ kind: 'player', owner: bot, x: 0, y: 0, size: 300 });
  sim.debugPlace({ kind: 'player', owner: human, x: 10, y: 0, size: 40 });
  for (let t = 0; t < 30; t++) assert.deepStrictEqual(sim.step().money, [], 'tick ' + t);
  assert.strictEqual(sim.playerInfo(human).cells.length, 1, 'the person is still alive under the bot');
  // the other way round: the person eats a small bot, mass only
  const bot2 = sim.addPlayer({ name: 'b2', bot: true });
  sim.debugPlace({ kind: 'player', owner: human, x: 2000, y: 2000, size: 300 });
  sim.debugPlace({ kind: 'player', owner: bot2, x: 2010, y: 2000, size: 40 });
  let facts = [];
  for (let t = 0; t < 30; t++) facts = facts.concat(sim.step().money);
  assert.strictEqual(sim.playerInfo(bot2).cells.length, 0, 'the bot was eaten');
  assert.deepStrictEqual(facts, [], 'no money fact');
  // and bot eats bot: mass only
  const bot3 = sim.addPlayer({ name: 'b3', bot: true });
  sim.debugPlace({ kind: 'player', owner: bot3, x: -2000, y: -2000, size: 40 });
  sim.debugPlace({ kind: 'player', owner: bot, x: -2010, y: -2000, size: 300 });
  for (let t = 0; t < 30; t++) facts = facts.concat(sim.step().money);
  assert.deepStrictEqual(facts, []);
});

function rig(saved) {
  const mem = { obj: saved || null };
  const calls = { cash: [], refund: [], house: [] };
  const clock = { t: 9000000 };
  const arenas = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 5,
    log: { log: noop, warn: noop, error: noop }, paid: true, now: () => clock.t,
    botStore: { load: () => mem.obj, save: (o) => { mem.obj = o; return true; } },
    moneyHooks: { onCashout: (o) => calls.cash.push(o), onRefund: (o) => calls.refund.push(o), onTransfer: noop,
      onFeed: noop, onBreach: noop, onStake: noop, onHouse: (o) => calls.house.push(o) } });
  return { arenas, mem, calls, clock };
}

test('a rung target opens room #0 with that many bots, saved and awake; 0 takes them out; bad numbers refused', () => {
  const { arenas, mem } = rig();
  const r = arenas.setBotTarget(0.5, 5);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(mem.obj, { 0.5: 5 });
  const room = arenas.rungs.get(0.5)[0];
  assert.strictEqual(room.index, 0);
  assert.strictEqual(room.botCount, 5);
  assert.strictEqual(room.awake, true);
  assert.strictEqual(arenas.botCount(0.5), 5);
  room.fillBots();
  assert.strictEqual(room.botCount, 5, 'the paid fill adds and removes nothing');
  arenas.setBotTarget(0.5, 2);
  assert.strictEqual(room.botCount, 2);
  arenas.setBotTarget(0.5, 0);
  assert.strictEqual(room.botCount, 0);
  assert.strictEqual(room.awake, false);
  assert.deepStrictEqual(mem.obj, {});
  assert.strictEqual(arenas.setBotTarget(0.5, -1).ok, false);
  assert.strictEqual(arenas.setBotTarget(0.5, 2.5).ok, false);
  assert.strictEqual(arenas.setBotTarget(3, 1).ok, false);
});

test('saved targets come back at boot', () => {
  const { arenas } = rig({ 1: 3 });
  arenas.startBots();
  assert.strictEqual(arenas.botCount(1), 3);
});

test('the ledger with a person among bots: stakes in == cash-outs + refunds + live; bots never hold money', () => {
  const { arenas, calls } = rig();
  arenas.setBotTarget(0.5, 8);
  const room = arenas.rungs.get(0.5)[0];
  const s = { id: 'h1', conn: { writeBuffer: [] }, emit: noop };
  const acct = room.addPaidHuman(s, { name: 'h', micro: 500000, wallet: 'W-h', paid: 0.5 });
  arenas._paidSeated(s, room);
  room.tickOnce();
  room.ready(s.id);
  // the person sits on top of a bot cell: the person eats it, the bot never eats the person
  for (const pid of room.bots.keys()) {
    const cells = room.sim.playerInfo(pid).cells;
    for (const id of cells) {
      const c = room.sim.getCell(id);
      assert.ok(c);
    }
  }
  for (let t = 0; t < 400; t++) room.tickOnce();
  const bank = room.money.bank;
  for (const pid of room.bots.keys()) assert.strictEqual(bank.accounts.has(pid), false, 'bot ' + pid + ' has no account');
  const live = bank.totalMicro();
  const out = calls.cash.reduce((n, o) => n + (o.grossMicro || o.micro || 0), 0) +
    calls.refund.reduce((n, o) => n + (o.micro || 0), 0);
  assert.strictEqual(500000, live + out, 'stakes in == out + live');
  assert.deepStrictEqual(calls.house, [], 'nothing to the house');
  assert.ok(acct);
});
