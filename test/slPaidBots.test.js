'use strict';
// Owner-spawned bots in the paid snake rooms (Owen 2026-10-16: "the bots will never cash out, the money's always going
// to be on the board, I'm never going to be taking any money with my bots"). The rules, tested:
//   1 a bot plays for the gold (Owen 2026-10-17) but never cashes out and is never paid: its account has no wallet,
//     no seat and no deposit, and remembers whose money it holds
//   2 a bot's death drops its money back into play as pellets naming those people; a bot with no money moves nothing
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
const { createBotBank } = require('../server/botBank');
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
    onSeedBack: hook('onSeedBack'),
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
  const gone = new Set();
  m.attach({ sim: { snake: (id) => (gone.has(id) ? null : {}), laws: FIXTURE }, humans: new Set([1, 2]), laws: FIXTURE,
    names: new Map([[9, 'botty']]), gone });
  m.open(1, entry(1));
  m.open(2, entry(2));
  m.markBots();
  return { s, m, gone: m.room.gone };
}

// The ledger: stakes in == cash-outs gross (net + cut) + owed rows + money still in the room; nothing to the house.
function ledgerHolds(m, s, extraRows) {
  const l = m.bank.ledger;
  const cash = s.of('onCashout').reduce((n, o) => n + o.grossMicro, 0);
  const owed = s.of('onOwed').concat(extraRows || []).reduce((n, x) => n + x.micro, 0);
  const live = m.bank.sums.acc + m.bank.sums.floor;
  assert.equal(l.in, cash + owed + live, 'stakes in == cash-outs + owed + live');
  assert.equal(l.outHouse, 0, 'nothing booked to the house');
  assert.deepEqual(s.of('onFloor'), [], 'no house floor sweep');
  assert.deepEqual(s.of('onHouse'), [], 'no house incident');
}

test('a bot eats a person\'s gold, dies, and its money drops back into play naming that person', () => {
  const { s, m } = botRoom();
  const d1 = drops(5);
  m.applyFacts({ tick: 1, deaths: [{ id: 1, cause: 'snake', killer: 9, drops: d1 }] }, []);
  // bot 9 eats three of W1's pellets: its account opens at the first, with no deposit and no wallet
  m.applyFacts({ tick: 2, deaths: [] }, d1.slice(0, 3).map((q) => ({ food: q.food, eater: 9 })));
  assert.equal(m.botBalance(9), STAKE / 5 * 3);
  assert.equal(m.bank.ledger.in, 2 * STAKE, 'a bot account brings no money in');
  assert.equal(m.bank.account(9).wallet, null);
  assert.equal(m.cashOut(9, 'sock'), null, 'a bot cannot cash out');
  assert.equal(m.worthOf(9), null, 'no seat message for a bot');
  // the bot dies: its money is pellets again, each naming W1
  const d9 = drops(4);
  m.applyFacts({ tick: 3, deaths: [{ id: 9, cause: 'snake', killer: 2, drops: d9 }] }, []);
  assert.equal(m.botBalance(9), 0);
  assert.equal(m.bank.account(9), null);
  for (const q of d9) assert.equal(m.bank.pellet(q.food).srcWallet, 'W1');
  assert.equal(m.bank.floorMicro(), STAKE);
  // human 2 eats two of the bot's pellets: no collusion signal from W1 (it went through a bot)
  m.applyFacts({ tick: 4, deaths: [] }, [{ food: d9[0].food, eater: 2 }, { food: d9[1].food, eater: 2 }]);
  m.endStep();
  assert.deepEqual(s.of('onTransfer').filter((t) => t.srcWallet === 'W1'), []);
  // human 2 cashes out (the only house cut); the room idles: the rest goes back to W1
  m.cashOut(2, 'sock');
  m.sweepFloor('idle');
  assert.ok(s.of('onOwed').every((r) => r.wallet === 'W1' && OWED_KEY.test(r.key)));
  ledgerHolds(m, s);
  assert.equal(m.bank.sums.acc + m.bank.sums.floor, 0);
});

test('a bot holding money: removal, restart, crash, emergency and the idle release all owe it back to its sources', () => {
  const setup = () => {
    const r = botRoom();
    const d1 = drops(2);
    const d2 = drops(2);
    r.m.applyFacts({ tick: 1, deaths: [{ id: 1, cause: 'snake', killer: 9, drops: d1 }, { id: 2, cause: 'snake', killer: 9, drops: d2 }] }, []);
    r.m.applyFacts({ tick: 2, deaths: [] }, [{ food: d1[0].food, eater: 9 }, { food: d2[0].food, eater: 9 }]);
    assert.equal(r.m.botBalance(9), STAKE);
    return r;
  };
  const sources = (rows) => rows.filter((x) => x.wallet !== undefined).map((x) => [x.wallet, x.micro]).sort();
  // removed without dying (a plain removal): the next step end owes it back
  let r = setup();
  r.gone.add(9);
  r.m.endStep();
  assert.deepEqual(sources(r.s.of('onOwed')), [['W1', STAKE / 2], ['W2', STAKE / 2]]);
  assert.ok(r.s.records.filter((x) => x.why === 'botfloor').length >= 2, 'journaled with keys');
  ledgerHolds(r.m, r.s);
  // restart and crash: handed back with the rows (bot money, then the floor), never a floor record
  for (const why of ['shutdown', 'crash']) {
    r = setup();
    const rows = r.m.shutdownSettle(why);
    assert.equal(rows.reduce((n, x) => n + x.micro, 0), 2 * STAKE);
    assert.equal(r.s.records.filter((x) => x.t === 'floor').length, 0);
    ledgerHolds(r.m, r.s, rows);
    assert.equal(r.m.bank.sums.acc + r.m.bank.sums.floor, 0);
  }
  // emergency
  r = setup();
  r.m.emergencySettle('test');
  ledgerHolds(r.m, r.s);
  assert.equal(r.m.bank.sums.acc + r.m.bank.sums.floor, 0);
  // idle with nobody there: the directory's release
  r = setup();
  r.m.releaseBots('idle');
  assert.equal(r.m.botBalance(9), 0);
  ledgerHolds(r.m, r.s);
  assert.equal(r.m.bank.sums.acc + r.m.bank.sums.floor, 0);
});

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

function botRig(saved, fundUsd = 50, capUsd = 50) {
  const mem = { obj: saved || null, saves: 0 };
  const store = { load: () => mem.obj, save: (o) => { mem.obj = o; mem.saves++; return true; } };
  const bank = createBotBank({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'botbank-')), 'b.json'), log: quiet });
  if (fundUsd > 0) bank.credit(fundUsd * 1e6, 'SIG' + Math.random());
  bank.setCap(capUsd * 1e6);
  let r = null;
  r = paidRig({ arenas: { botDriver: () => createBotDriver(r.laws, {}), botStore: store, botBank: bank } });
  return { r, mem, bank };
}

test('a rung target opens room #0 with that many bots, saved; a watcher sees them with nobody else there', async () => {
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
  // Spectate (the lobby's watch of the rung) finds the bots' room with nobody else in it
  assert.equal(r.paid.watch(r.sock({}), { stake: 0.5 }), true, 'a watcher is seated with only bots playing');
  // a human joins and plays among them; every account is a human's
  r.join(r.mint());
  await r.settle();
  r.step(30);
  assert.equal(room.money.openCount(), 1);
  for (const id of room.money.bank.openIds()) {
    assert.ok(room.humans.has(id) || room.money.botBalance(id) >= 500000, 'account ' + id + ' is a person or a funded bot');
  }
  assert.deepEqual(room.money.lastViolations, []);
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

test('people and bots together: 22 people plus the bots, the paid border never moves, no violation', async () => {
  const { r } = botRig();
  r.paid.setBotTarget(0.5, 20);
  const room = r.paid.rooms()[0];
  const flux0 = room.sim.flux();
  const cap = room.R.humanCap;
  for (let i = 0; i < cap; i++) {
    r.join(r.mint());
    await r.settle();
    r.step(2);
  }
  r.step(200);
  assert.ok(room.sim.count() > cap, 'more snakes than the people cap: ' + room.sim.count());
  assert.equal(room.sim.flux(), flux0, 'the border is pinned');
  assert.equal(room.money.tainted, false);
  assert.deepEqual(room.money.lastViolations, []);
});

test('a bot that eats its first gold and dies in the same step drops it back into play, nothing to the house', () => {
  const { s, m, gone } = botRoom();
  const d1 = drops(2);
  m.applyFacts({ tick: 1, deaths: [{ id: 1, cause: 'snake', killer: 9, drops: d1 }] }, []);
  gone.add(9); // out of the sim by the time the step's facts are applied
  const d9 = drops(3);
  m.applyFacts({ tick: 2, deaths: [{ id: 9, cause: 'snake', killer: 2, drops: d9 }] }, [{ food: d1[0].food, eater: 9 }]);
  assert.deepEqual(s.of('onHouse'), []);
  assert.equal(m.bank.ledger.outHouse, 0);
  assert.equal(m.bank.floorMicro(), STAKE, 'all of W1\'s money is on the floor again');
  for (const q of d9) assert.equal(m.bank.pellet(q.food).srcWallet, 'W1');
});


// ------------------------------------------------------------------ bounty bots: funded from the owner's bot bank

// A controller with one funded bot (snake 9, seed = the stake) besides humans 1 and 2.
function seeded() {
  const r = botRoom();
  r.m.seedBot(9, STAKE, 'botty');
  return r;
}

test('a funded bot holds its seed; a person who kills it wins the seed and cashes it out (the only house cut)', () => {
  const { s, m } = seeded();
  assert.equal(m.botBalance(9), STAKE);
  assert.equal(m.bank.ledger.in, 3 * STAKE, 'stakes in + seed in');
  assert.equal(m.cashOut(9, 'sock'), null, 'a bot never cashes out');
  const d9 = drops(4);
  m.applyFacts({ tick: 1, deaths: [{ id: 9, cause: 'snake', killer: 1, drops: d9 }] }, []);
  for (const q of d9) assert.equal(m.bank.pellet(q.food).srcWallet, '#botbank', 'seed pellets name the bot bank');
  m.applyFacts({ tick: 2, deaths: [] }, d9.map((q) => ({ food: q.food, eater: 1 })));
  assert.equal(m.worthOf(1), 2 * STAKE);
  const c = m.cashOut(1, 'sock');
  assert.equal(c.gross, 2 * STAKE);
  assert.equal(c.cut, Math.floor(2 * STAKE / HOUSE_CUT_DIV));
  // ledger: stakes + seed in == cash-outs + owed + seed back + live
  const l = m.bank.ledger;
  const back = s.of('onSeedBack').reduce((n, x) => n + x, 0);
  assert.equal(l.in, c.gross + back + m.bank.sums.acc + m.bank.sums.floor);
  assert.equal(l.outHouse, 0);
});

test('unspent seed goes back to the bot bank: removal, restart, crash, emergency, a seed pellet nobody picked up', () => {
  // removed by the owner while holding its seed plus some of W1's gold: seed to the bank, the gold back to W1
  let r = seeded();
  const d1 = drops(2);
  r.m.applyFacts({ tick: 1, deaths: [{ id: 1, cause: 'snake', killer: 9, drops: d1 }] }, []);
  r.m.applyFacts({ tick: 2, deaths: [] }, [{ food: d1[0].food, eater: 9 }]);
  r.m.retireBot(9);
  assert.deepEqual(r.s.of('onSeedBack'), [STAKE]);
  assert.deepEqual(r.s.of('onOwed').map((x) => [x.wallet, x.micro]), [['W1', STAKE / 2]]);
  for (const why of ['shutdown', 'crash']) {
    r = seeded();
    const rows = r.m.shutdownSettle(why);
    assert.deepEqual(r.s.of('onSeedBack'), [STAKE], why);
    assert.equal(rows.reduce((n, x) => n + x.micro, 0), 2 * STAKE, 'the two people refunded');
    assert.equal(r.m.bank.ledger.outHouse, 0);
  }
  r = seeded();
  r.m.emergencySettle('test');
  assert.deepEqual(r.s.of('onSeedBack'), [STAKE]);
  // killed with nobody to eat it: the seed pellets go back to the bank at the idle retire
  r = seeded();
  r.m.applyFacts({ tick: 1, deaths: [{ id: 9, cause: 'border', drops: drops(3) }] }, []);
  r.m.cashOut(1, 's1');
  r.m.cashOut(2, 's2');
  r.m.sweepFloor('idle');
  assert.deepEqual(r.s.of('onSeedBack'), [STAKE]);
  assert.deepEqual(r.s.of('onFloor'), []);
  assert.equal(r.m.bank.sums.acc + r.m.bank.sums.floor, 0);
});

test('idle release: a funded bot keeps playing with its seed, only what it picked up goes back', () => {
  const r = seeded();
  const d1 = drops(2);
  r.m.applyFacts({ tick: 1, deaths: [{ id: 1, cause: 'snake', killer: 9, drops: d1 }] }, []);
  r.m.applyFacts({ tick: 2, deaths: [] }, [{ food: d1[0].food, eater: 9 }]);
  assert.equal(r.m.botBalance(9), STAKE + STAKE / 2);
  r.m.releaseBots('idle');
  assert.equal(r.m.botBalance(9), STAKE, 'its seed stays');
  assert.deepEqual(r.s.of('onSeedBack'), []);
  assert.ok(r.s.of('onOwed').some((x) => x.wallet === 'W1' && x.micro === STAKE / 2));
});

test('the bot bank: a bot needs its seed covered and the daily limit; no respawn; seed back on Control 0', async () => {
  const { r, bank } = botRig(null, 1.5, 5);
  const out = r.paid.setBotTarget(0.5, 5);
  assert.equal(out.ok, true);
  assert.equal(out.live, 3, 'the bank covered three $0.50 bots');
  assert.match(out.why, /bot bank cannot cover/);
  assert.equal(bank.balanceMicro(), 0);
  const room = r.paid.rooms()[0];
  for (const id of room.money.botFrom.keys()) assert.equal(room.money.botBalance(id), 500000);
  // Control to 0: every seed back
  r.paid.setBotTarget(0.5, 0);
  assert.equal(bank.balanceMicro(), 1500000);
  assert.equal(bank.view().spentToday, 0);
  // the daily cap
  const b2 = botRig(null, 50, 1);
  assert.equal(b2.r.paid.setBotTarget(1, 3).live, 1);
  assert.match(b2.r.paid.setBotTarget(1, 3).why, /daily bot limit/);
});

test('the bot bank file: a top-up credits once, seeds are taken and given back, the daily limit holds', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'botbank-')), 'b.json');
  let t = Date.UTC(2026, 9, 17, 12);
  const b = createBotBank({ file, log: quiet, now: () => t });
  assert.equal(b.credit(2000000, 'SIGA').ok, true);
  assert.equal(b.credit(2000000, 'SIGA').ok, false, 'one credit per transfer');
  b.setCap(1000000);
  assert.equal(b.take(1000000, 'r'), true);
  assert.equal(b.whyNot(500000), 'cap');
  b.giveBack(1000000, 'removed', 'r', true);
  assert.equal(b.whyNot(1000000), null, 'returned seed frees the day again');
  t += 86400000;
  const again = createBotBank({ file, log: quiet, now: () => t });
  assert.equal(again.balanceMicro(), 2000000, 'saved');
  assert.equal(again.hasTopup('SIGA'), true);
});

test('the bot bank after a hard stop: seed held by live bots comes back once; seed already in play does not', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'botbank-')), 'b.json');
  const b = createBotBank({ file, log: quiet });
  b.credit(3000000, 'SIGB');
  b.take(1000000, 'r'); // a live bot
  b.take(1000000, 'r'); // a bot that then died: its seed is in play
  b.spent(1000000);
  assert.equal(b.balanceMicro(), 1000000);
  const after = createBotBank({ file, log: quiet }); // the process died without settling
  assert.equal(after.balanceMicro(), 2000000, 'the live bot seed is back');
  assert.equal(createBotBank({ file, log: quiet }).balanceMicro(), 2000000, 'once');
});
