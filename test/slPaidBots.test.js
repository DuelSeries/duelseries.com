'use strict';
// Owner-spawned bots in the paid snake rooms (Owen 2026-10-16: "the bots will never cash out, the money's always going
// to be on the board, I'm never going to be taking any money with my bots"). The rules, tested:
//   1 a bot never holds money: the room's eatGate refuses it every cash pellet, so it has nothing to cash out or be paid
//   2 a bot's death moves no money and raises no alert (its drops are plain food)
//   3 in a room bots played in, the floor nobody picked up goes back 100% to the players who dropped it (owed rows,
//     journaled with a key), never to the house: idle retire, emergency, shutdown and crash alike
//   4 the house cut comes only from a human cash-out
//   5 the ledger: stakes in == human cash-outs (gross: net + cut) + refunds + money still in play
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSlMoney } = require('../server/slPaid/slMoney');
const { HOUSE_CUT_DIV } = require('../server/paperPayout');
const { createBotStore } = require('../server/paidBotStore');
const { FIXTURE } = require('./slLawsFixture');

const LABEL = 'sl_na_s0_5';
const STAKE = 500000;
const OWED_KEY = /^agowed:[0-9a-f-]{36}$/;

let uuidN = 0;
const uuid = () => '00000000-0000-4000-8000-' + String(++uuidN).padStart(12, '0');
const jidOf = (n) => 'a0000000-0000-4000-8000-' + String(n).padStart(12, '0');
const entry = (n) => ({ jid: jidOf(n), micro: STAKE, wallet: 'W' + n, name: 'p' + n, paid: 0.5 });
let foodN = 1;
const drops = (n) => Array.from({ length: n }, () => ({ food: { id: foodN++, x: 0, y: 0, b: 70, nat: false } }));

function spy() {
  const calls = [];
  const records = [];
  const hook = (name) => (x) => { calls.push([name, x]); };
  const hooks = {
    onCashout: hook('onCashout'), onOwed: hook('onOwed'), onFloor: hook('onFloor'), onHouse: hook('onHouse'),
    onBreach: hook('onBreach'), onTransfer: hook('onTransfer'), onAccountOpen: () => {}, onAccountClosed: () => {},
    journal: {
      open: (a) => { records.push({ t: 'open', jid: a.jid }); return true; },
      close: (a, outcome, x) => { records.push(Object.assign({ t: 'close', jid: a.jid, wallet: a.wallet, outcome }, x)); return true; },
      floor: (rec) => { records.push(Object.assign({ t: 'floor' }, rec)); return true; },
    },
  };
  return { calls, records, hooks, of: (n) => calls.filter((c) => c[0] === n).map((c) => c[1]) };
}

const quiet = { log() {}, warn() {}, error() {} };

// A controller in a fake room: humans 1 and 2 seated, bot 9 present (markBots, as slRoom.spawnSnake does).
function botRoom() {
  const s = spy();
  const m = createSlMoney({ stake: 0.5, label: LABEL, hooks: s.hooks, uuid, log: quiet, checkEvery: 1 });
  m.attach({ sim: { snake: () => ({}), laws: FIXTURE }, humans: new Set([1, 2]), laws: FIXTURE });
  m.open(1, entry(1));
  m.open(2, entry(2));
  m.markBots();
  return { s, m };
}

test('a bot kills a human, a human eats some gold and cashes out, the rest goes back to the dropper', () => {
  const { s, m } = botRoom();
  // human 1 dies (killed by bot 9): its whole stake becomes 5 pellets
  const d1 = drops(5);
  m.applyFacts({ tick: 1, deaths: [{ id: 1, cause: 'snake', killer: 9, drops: d1 }] }, []);
  assert.equal(m.bank.floorMicro(), STAKE);
  // human 2 eats two of them; bot 9 dies with plain drops: no money moves, no alert
  m.applyFacts({ tick: 2, deaths: [{ id: 9, cause: 'snake', killer: 2, drops: drops(3) }] },
    [{ food: d1[0].food, eater: 2 }, { food: d1[1].food, eater: 2 }]);
  assert.deepEqual(s.of('onBreach'), [], 'a bot death is not a breach');
  const ate = STAKE / 5 * 2;
  assert.equal(m.worthOf(2), STAKE + ate);
  assert.equal(m.worthOf(9), null, 'a bot has no account');
  // human 2 cashes out: the only house cut
  const r = m.cashOut(2, 'sock');
  assert.equal(r.gross, STAKE + ate);
  assert.equal(r.cut, Math.floor((STAKE + ate) / HOUSE_CUT_DIV));
  assert.equal(m.cashOut(9, 'sock'), null, 'a bot cannot cash out');
  // the room idles out: the 3 pellets left go back to wallet W1, never the house
  const sw = m.sweepFloor('idle');
  assert.equal(sw.micro, STAKE - ate);
  assert.deepEqual(s.of('onFloor'), [], 'no floor sweep to the house');
  assert.deepEqual(s.of('onHouse'), [], 'no house incident');
  const rows = s.of('onOwed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wallet, 'W1');
  assert.equal(rows[0].micro, STAKE - ate);
  assert.match(rows[0].key, OWED_KEY);
  assert.ok(rows[0].reason.startsWith('refund') && rows[0].reason.includes(rows[0].key), 'db.recordOwedOnce takes it');
  // journaled as a keyed close, so a crash replays it once (agJournal OWED_WHYS has botfloor)
  const j = s.records.find((x) => x.t === 'close' && x.key === rows[0].key);
  assert.equal(j.why, 'botfloor');
  assert.equal(j.outcome, 'refunded');
  assert.equal(j.refundedMicro, STAKE - ate);
  // the ledger: stakes in == cash-outs gross + refunds + live; the house holds only the cut
  const l = m.bank.ledger;
  const cash = s.of('onCashout').reduce((n, o) => n + o.grossMicro, 0);
  const owed = rows.reduce((n, x) => n + x.micro, 0);
  const live = m.bank.sums.acc + m.bank.sums.floor;
  assert.equal(l.in, 2 * STAKE);
  assert.equal(l.in, cash + owed + live);
  assert.equal(l.outHouse, 0, 'nothing booked to the house');
  assert.equal(live, 0);
});

test('at a restart and a crash the floor comes back as owed rows, never a house floor record', () => {
  for (const why of ['shutdown', 'crash']) {
    const { s, m } = botRoom();
    m.applyFacts({ tick: 1, deaths: [{ id: 1, cause: 'snake', killer: 9, drops: drops(4) }] }, []);
    const rows = m.shutdownSettle(why);
    // human 2's 100% refund plus human 1's floor back to W1
    assert.deepEqual(rows.map((r) => [r.wallet, r.micro]).sort(), [['W1', STAKE], ['W2', STAKE]]);
    assert.equal(s.records.filter((x) => x.t === 'floor').length, 0, 'no floor record for the house');
    assert.equal(m.bank.ledger.outHouse, 0);
    assert.equal(m.bank.sums.floor + m.bank.sums.acc, 0);
    for (const r of rows) assert.ok(s.records.some((x) => x.t === 'close' && x.key === r.key), 'journaled ' + r.key);
  }
});

test('an emergency close: accounts and floor through the owed lane, nothing to the house', () => {
  const { s, m } = botRoom();
  m.applyFacts({ tick: 1, deaths: [{ id: 1, cause: 'snake', killer: 9, drops: drops(4) }] }, []);
  m.emergencySettle('test');
  assert.deepEqual(s.of('onFloor'), []);
  assert.equal(m.bank.ledger.outHouse, 0);
  assert.deepEqual(s.of('onOwed').map((r) => r.wallet).sort(), ['W1', 'W2']);
});

test('a room no bot ever entered keeps the old rule (its idle floor goes to the house)', () => {
  const s = spy();
  const m = createSlMoney({ stake: 0.5, label: LABEL, hooks: s.hooks, uuid, log: quiet, checkEvery: 1 });
  m.attach({ sim: { snake: () => ({}), laws: FIXTURE }, humans: new Set([1]), laws: FIXTURE });
  m.open(1, entry(1));
  m.applyFacts({ tick: 1, deaths: [{ id: 1, cause: 'border', drops: drops(2) }] }, []);
  m.sweepFloor('idle');
  assert.equal(s.of('onFloor').length, 1);
  assert.deepEqual(s.of('onOwed'), []);
});

test('the bot store saves atomically and loads whole numbers only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paidbots-'));
  const st = createBotStore({ file: path.join(dir, 'b.json'), log: quiet });
  assert.equal(st.load(), null);
  assert.equal(st.save({ '0.5': 12, 1: 3 }), true);
  assert.deepEqual(st.load(), { '0.5': 12, 1: 3 });
  fs.writeFileSync(path.join(dir, 'b.json'), '{"0.5":-1,"1":2.5,"x":"y","2":4}');
  assert.deepEqual(st.load(), { 2: 4 });
});

// ------------------------------------------------------------------ the directory, with the real room and bot driver

const { paidRig } = require('./slPaidFakes');
const { createBotDriver } = require('../server/sl/slBots');

function botRig(saved) {
  const mem = { obj: saved || null, saves: 0 };
  const store = { load: () => mem.obj, save: (o) => { mem.obj = o; mem.saves++; return true; } };
  let r = null;
  r = paidRig({ arenas: { botDriver: () => createBotDriver(r.laws, {}), botStore: store } });
  return { r, mem };
}

test('a rung target opens room #0 with that many bots, saved; the bots have no account and no gold', async () => {
  const { r, mem } = botRig();
  const out = r.paid.setBotTarget(0.5, 4);
  assert.equal(out.ok, true);
  assert.deepEqual(mem.obj, { 0.5: 4 });
  const room = r.paid.rooms()[0];
  assert.equal(room.lobbyType, 'sl_na_s0_5');
  assert.equal(room.botCount, 4);
  assert.equal(room.money.botRoom, true);
  assert.equal(room.awake, true, 'ticks with nobody seated');
  assert.equal(r.paid.botCount(0.5), 4);
  // a human joins and plays among them; every account is a human's
  r.join(r.mint());
  await r.settle();
  r.step(30);
  assert.equal(room.money.openCount(), 1);
  for (const id of room.money.bank.openIds()) assert.ok(room.humans.has(id), 'account ' + id + ' is a human');
  assert.deepEqual(room.money.lastViolations, []);
  // the gate: a cash pellet is refused to a bot, allowed to a human; plain food is for everyone
  const pellet = { id: 1 };
  room.money.bank.floor.set(pellet, { micro: 1 });
  const botId = Array.from(room.sim.snakes ? room.sim.snakes.keys() : []).find((id) => !room.humans.has(id)) || 999;
  const human = Array.from(room.humans)[0];
  assert.equal(room.eatGate(pellet, botId), false);
  assert.equal(room.eatGate(pellet, human), true);
  assert.equal(room.eatGate({ id: 2 }, botId), true);
  room.money.bank.floor.delete(pellet);
  // held: the sweep never retires room #0 while it has a target
  for (let i = 0; i < 5; i++) r.paid.sweep(r.wall.t += 10 * 60 * 1000);
  assert.ok(r.paid.rooms().includes(room));
  // down to 1, then 0: taken out now, the room may idle again
  r.paid.setBotTarget(0.5, 1);
  assert.equal(room.botCount, 1);
  r.paid.setBotTarget(0.5, 0);
  assert.equal(room.botCount, 0);
  assert.deepEqual(mem.obj, {});
  assert.equal(room.awake, false);
});

test('saved targets come back at boot (startBots), and bad numbers are refused', () => {
  const { r } = botRig({ 1: 2 });
  r.paid.startBots();
  assert.equal(r.paid.botCount(1), 2);
  assert.equal(r.paid.botTarget(1), 2);
  assert.equal(r.paid.setBotTarget(0.5, -1).ok, false);
  assert.equal(r.paid.setBotTarget(0.5, 1.5).ok, false);
  assert.equal(r.paid.setBotTarget(0.7, 1).ok, false);
});
