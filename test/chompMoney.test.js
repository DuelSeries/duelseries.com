'use strict';
// Paid Chomp's money (server/chomp/chompMoney.js on agar.io's agMoney, in a real ChompRoom): a catch drops ALL the
// victim's coins on the maze, a chomper on a coin's tile takes it, hold Q 3 s cashes out 90/10 while moving, a caught
// holder drops instead, an unready seat is refunded, a dropped seat goes dormant and is cashed out, a restart, crash
// or emergency gives every balance and every coin back, an hour-old coin goes back to its dropper, and bounty bots
// keep the books of whose money they hold. After every step: the ledger closes (money in = money held + money out).
const test = require('node:test');
const assert = require('node:assert');
const R = require('../shared/chompRules');
const { ChompRoom } = require('../server/chomp/chompRoom');
const { CHOMP_MONEY, BANK_SRC } = require('../server/chomp/chompMoney');

const quiet = { error() {}, warn() {}, log() {} };
const HOLD = CHOMP_MONEY.HOLD_TICKS.value;
const STAKE = 0.5;
const SEED = 500000;

function recorder() {
  const calls = { cashout: [], refund: [], transfer: [], breach: [], stake: [], house: [], owed: [], seedBack: [],
    seedSpent: [], closed: [] };
  const hooks = {
    onCashout: (o) => calls.cashout.push(o),
    onRefund: (o) => calls.refund.push(o),
    onTransfer: (t) => calls.transfer.push(t),
    onFeed: () => {},
    onBreach: (b) => calls.breach.push(b),
    onStake: (s) => calls.stake.push(s),
    onHouse: (h) => calls.house.push(h),
    onOwed: (row, live) => calls.owed.push(Object.assign({ live }, row)),
    onSeedBack: (micro, why, label, live) => calls.seedBack.push({ micro, why, live }),
    onSeedSpent: (micro) => calls.seedSpent.push(micro),
    onAccountOpen: () => {},
    onAccountConfirmed: () => {},
    onAccountClosed: (a, outcome, extra) => calls.closed.push({ pid: a.pid, wallet: a.wallet, outcome, extra }),
  };
  return { calls, hooks };
}

function world(opts) {
  const clock = { t: 5000000 };
  const rec = recorder();
  const r = new ChompRoom(Object.assign({ mx: 1, my: 1, seed: 11, stake: STAKE, moneyHooks: rec.hooks,
    now: () => clock.t, log: quiet }, opts));
  r.ghosts = [];                       // no ghost wanders into a test; catches are made by hand
  const w = { r, clock, calls: rec.calls, outMicro: 0 };
  return w;
}

let sn = 0;
function sock(id) {
  return {
    id: id || 'cs' + ++sn,
    events: [],
    emit(ev, p) { this.events.push([ev, p]); },
    of(ev) { return this.events.filter((e) => e[0] === ev).map((e) => e[1]); },
  };
}

// The ledger closes: every micro that came in is held (accounts + coins) or went out (cash-outs, refunds, owed rows,
// seed back, house).
function conserved(w) {
  const bank = w.r.money.bank;
  assert.strictEqual(bank.totalMicro(), bank.ledger.inMicro - bank.ledger.outMicro, 'bank closes');
  assert.ok(!bank.breached, 'no ledger breach');
}

function step(w, n = 1) {
  for (let i = 0; i < n; i++) {
    w.r.step();
    w.clock.t += 1000 / R.TICK_HZ;
    conserved(w);
  }
}

function join(w, name, opts) {
  const o = Object.assign({ micro: SEED, ready: true }, opts);
  const s = sock(name);
  const acct = w.r.addPaidHuman(s, { name, micro: o.micro, wallet: 'W-' + name, paid: o.micro / 1e6 });
  assert.ok(acct && typeof acct === 'object', 'seated: ' + acct);
  const p = w.r.players.get(acct.pid);
  if (o.ready) {
    assert.strictEqual(w.r.ready(s.id), true, 'ready');
    p.safe = 0;
  }
  return { s, acct, p };
}

// Puts a chomper on tile (c, r), standing still.
function putAt(p, c, r) {
  p.x = c + 0.5; p.y = r + 0.5; p.dir = -1; p.want = -1; p.moving = false; p.hist = [];
}

function catchByGhost(w, p) {
  w.r.kill(p, null, { kind: 'blinky' });
  step(w);
}

function coinSum(w) {
  return w.r.money.coins().reduce((t, c) => t + c.micro, 0);
}

test('a paid seat opens shielded and still, and c:ready lets it play (the buy-in row once)', () => {
  const w = world();
  const { s, acct, p } = join(w, 'ann', { ready: false });
  assert.strictEqual(acct.state, 'unconfirmed');
  assert.ok(w.r.shielded.has(p.id) && w.r.still.has(p.id));
  const x0 = p.x;
  p.want = 3;
  step(w, 30);
  assert.strictEqual(p.x, x0, 'still before ready');
  assert.strictEqual(w.r.ready(s.id), true);
  assert.strictEqual(acct.state, 'live');
  assert.ok(!w.r.shielded.has(p.id) && !w.r.still.has(p.id));
  assert.strictEqual(w.calls.stake.length, 1);
  assert.strictEqual(w.calls.stake[0].worth, 0.5);
  assert.ok(p.safe > 0, 'the spawn blink starts at ready');
});

test('a ghost catch drops ALL the coins around the death tile, closes the account and tells the page', () => {
  const w = world();
  const { s, acct, p } = join(w, 'ann');
  putAt(p, 6, 1);
  catchByGhost(w, p);
  assert.strictEqual(w.r.money.account(p.id), null, 'closed');
  const coins = w.r.money.coins();
  assert.strictEqual(coins.length, 4, '$0.50 drops 4 coins');
  assert.strictEqual(coinSum(w), SEED, 'every micro is on the maze');
  assert.ok(coins.some((c) => c.k === 1 * w.r.A.W + 6), 'the death tile has a coin');
  for (const c of coins) {
    assert.ok(w.r.A.walk(c.x, c.y), 'coins sit on path tiles');
    assert.ok(Math.abs(c.x - 6) + Math.abs(c.y - 1) <= 6, 'near the death tile');
    assert.strictEqual(c.srcWallet, 'W-ann');
  }
  const dead = s.of('c:dead');
  assert.strictEqual(dead.length, 1);
  assert.strictEqual(dead[0].lostMicro, SEED);
  assert.strictEqual(dead[0].ghost, true);
  assert.strictEqual(w.calls.closed.find((c) => c.pid === acct.pid).outcome, 'eaten');
  assert.ok(w.r.players.has(p.id), 'the chomper stays for its death animation');
  step(w, Math.round(R.DEATH_S * R.TICK_HZ) + 1);
  assert.ok(!w.r.players.has(p.id), 'then it goes');
  assert.ok(w.r.watchers.has(s.id), 'the socket stays to watch');
});

test('a chomper on a coin tile takes it; collusion is recorded per dropper life', () => {
  const w = world();
  const a = join(w, 'ann');
  const b = join(w, 'bob');
  putAt(a.p, 6, 1);
  catchByGhost(w, a.p);
  const coins = w.r.money.coins();
  let got = 0;
  for (const c of coins) {
    putAt(b.p, c.x, c.y);
    step(w);
    got += c.micro;
    assert.strictEqual(w.r.money.balance(b.p.id), SEED + got);
  }
  assert.strictEqual(w.r.money.coins().length, 0);
  assert.strictEqual(w.r.money.balance(b.p.id), 2 * SEED);
  // the bucket flushes after its window
  w.clock.t += 61000;
  step(w);
  const t = w.calls.transfer.filter((x) => x.dstWallet === 'W-bob');
  assert.strictEqual(t.reduce((s, x) => s + x.micro, 0), SEED);
  assert.ok(t.every((x) => x.srcWallet === 'W-ann'));
});

test('a power pellet eat drops the victim\'s coins where the eater stands, and the eater takes that one first', () => {
  const w = world();
  const a = join(w, 'ann');
  const b = join(w, 'bob');
  putAt(a.p, 6, 1);
  putAt(b.p, 6, 1);
  a.p.power = 300;
  step(w);
  assert.strictEqual(w.r.money.account(b.p.id), null, 'bob caught');
  assert.strictEqual(b.s.of('c:dead')[0].by, 'ann');
  step(w);
  assert.ok(w.r.money.balance(a.p.id) > SEED, 'ann took the coin on her own tile');
  assert.strictEqual(w.r.money.balance(a.p.id) + coinSum(w), 2 * SEED);
});

test('hold Q 3 s cashes out the whole balance 90/10 while the chomper keeps moving', () => {
  const w = world();
  const { s, acct, p } = join(w, 'ann');
  putAt(p, 1, 1);
  p.want = 3;
  const x0 = p.x;
  for (let i = 0; i < HOLD - 1; i++) {
    if (i % 12 === 0) w.r.hold(s.id, true);
    step(w);
  }
  assert.ok(p.x > x0 + 1, 'moved while holding');
  assert.strictEqual(w.calls.cashout.length, 0, 'not yet');
  assert.strictEqual(s.of('c:holding')[0].need, HOLD);
  w.r.hold(s.id, true);
  step(w, 2);
  assert.strictEqual(w.calls.cashout.length, 1);
  assert.strictEqual(w.calls.cashout[0].grossMicro, SEED);
  assert.strictEqual(w.calls.cashout[0].wallet, 'W-ann');
  assert.strictEqual(w.r.money.account(acct.pid), null);
  assert.ok(!w.r.players.has(p.id), 'gone from the maze');
  assert.strictEqual(w.r.money.bank.totalMicro(), 0);
});

test('caught during the hold: the coins drop, nothing is cashed out', () => {
  const w = world();
  const { s, p } = join(w, 'ann');
  putAt(p, 6, 1);
  for (let i = 0; i < HOLD - 5; i++) {
    if (i % 12 === 0) w.r.hold(s.id, true);
    step(w);
  }
  w.r.hold(s.id, true);
  catchByGhost(w, p);
  step(w, 10);
  assert.strictEqual(w.calls.cashout.length, 0);
  assert.strictEqual(coinSum(w), SEED);
});

test('a seat that never readied is refunded in full when its socket goes', () => {
  const w = world();
  const { s, acct } = join(w, 'ann', { ready: false });
  w.r.removeSocket(s.id);
  assert.strictEqual(w.calls.refund.length, 1);
  assert.strictEqual(w.calls.refund[0].micro, SEED);
  assert.strictEqual(w.r.money.account(acct.pid), null);
  assert.strictEqual(w.r.players.size, 0);
});

test('a dropped seat plays on 5 s, goes still and catchable, then is cashed out to its wallet after 3 minutes', () => {
  const w = world();
  const { s, acct, p } = join(w, 'ann');
  putAt(p, 1, 1);
  w.r.removeSocket(s.id);
  assert.strictEqual(acct.state, 'grace');
  w.clock.t += 5001;
  step(w);
  assert.strictEqual(acct.state, 'dormant');
  assert.ok(w.r.still.has(p.id));
  w.clock.t += 180001;
  step(w);
  assert.strictEqual(w.calls.cashout.length, 1);
  assert.strictEqual(w.calls.closed.find((c) => c.pid === acct.pid).outcome, 'settled');
});

test('a restart gives every balance and every coin back as keyed owed rows; nothing stays in the room', () => {
  const w = world();
  const a = join(w, 'ann');
  const b = join(w, 'bob');
  putAt(a.p, 6, 1);
  catchByGhost(w, a.p);
  const rows = w.r.money.shutdownSettle('shutdown');
  const byWallet = {};
  for (const row of rows) {
    assert.match(row.key, /^agowed:[0-9a-f-]{36}$/);
    assert.match(row.reason, /^refund chomp /);
    byWallet[row.wallet] = (byWallet[row.wallet] || 0) + row.micro;
  }
  assert.strictEqual(byWallet['W-ann'], SEED, 'ann\'s coins back to ann');
  assert.strictEqual(byWallet['W-bob'], SEED, 'bob\'s balance back to bob');
  assert.strictEqual(w.r.money.bank.totalMicro(), 0);
  conserved(w);
  assert.strictEqual(w.calls.house.length, 0, 'the house takes nothing');
});

test('an emergency refunds every balance at once and gives every coin back', () => {
  const w = world();
  const a = join(w, 'ann');
  const b = join(w, 'bob');
  putAt(a.p, 6, 1);
  catchByGhost(w, a.p);
  w.r.emergencyClose();
  assert.strictEqual(w.calls.refund.reduce((t, x) => t + x.micro, 0), SEED, 'bob refunded');
  assert.strictEqual(w.calls.owed.filter((x) => x.live).reduce((t, x) => t + x.micro, 0), SEED, 'ann\'s coins owed back');
  assert.strictEqual(w.r.money.bank.totalMicro(), 0);
  assert.strictEqual(b.s.of('c:closed')[0].refundedMicro, SEED);
});

test('a coin nobody took within the hour goes back to whoever dropped it, never the house', () => {
  const w = world();
  const a = join(w, 'ann');
  putAt(a.p, 6, 1);
  catchByGhost(w, a.p);
  w.r.money.sweepFloor(w.clock.t + 3599000);
  assert.strictEqual(w.r.money.coins().length, 4, 'not yet');
  w.r.money.sweepFloor(w.clock.t + 3600001);
  assert.strictEqual(w.r.money.coins().length, 0);
  assert.strictEqual(w.calls.owed.reduce((t, x) => t + x.micro, 0), SEED);
  assert.ok(w.calls.owed.every((x) => x.wallet === 'W-ann' && x.live === true));
  assert.strictEqual(w.calls.house.length, 0);
  conserved(w);
});

test('bounty bots: a caught bot\'s coins carry its seed; a person who takes one spends the seed; a bot that takes a person\'s coin owes it back', () => {
  const w = world();
  const bot = w.r._spawnBot();
  w.r.money.seedBot(bot.id, SEED, bot.name);
  const a = join(w, 'ann');
  putAt(bot, 6, 1);
  bot.brain = null; bot.bot = false;            // hold it still for the test (no thinking)
  catchByGhost(w, bot);
  assert.ok(!w.r.money.bots.has(bot.id), 'its money left with the drop');
  const coins = w.r.money.coins();
  assert.strictEqual(coinSum(w), SEED);
  for (const c of coins) assert.strictEqual(w.r.money.coinFrom.get(c.pid).get(BANK_SRC), c.micro, 'each coin is seed');
  // ann takes one: that part of the seed is spent
  putAt(a.p, coins[0].x, coins[0].y);
  step(w);
  assert.strictEqual(w.calls.seedSpent.reduce((t, x) => t + x, 0), coins[0].micro);
  // the rest go back to the bank at a restart
  const rows = w.r.money.shutdownSettle('shutdown');
  assert.strictEqual(w.calls.seedBack.reduce((t, x) => t + x.micro, 0), SEED - coins[0].micro);
  assert.strictEqual(rows.filter((r) => r.wallet === 'W-ann').reduce((t, r) => t + r.micro, 0), SEED + coins[0].micro);
  conserved(w);
});

test('a bot that takes a person\'s coins holds them for that person: removed, they are owed back, the seed goes home', () => {
  const w = world();
  const a = join(w, 'ann');
  const bot = w.r._spawnBot();
  w.r.money.seedBot(bot.id, SEED, bot.name);
  bot.brain = null; bot.bot = false;
  putAt(a.p, 6, 1);
  catchByGhost(w, a.p);
  for (const c of w.r.money.coins()) {
    putAt(bot, c.x, c.y);
    step(w);
  }
  assert.strictEqual(w.r.money.balance(bot.id), 2 * SEED);
  assert.strictEqual(w.r.money.bots.get(bot.id).from.get('W-ann'), SEED);
  bot.bot = true;
  w.r._removeBot(bot);
  assert.strictEqual(w.calls.seedBack.reduce((t, x) => t + x.micro, 0), SEED);
  assert.strictEqual(w.calls.owed.filter((x) => x.wallet === 'W-ann').reduce((t, x) => t + x.micro, 0), SEED);
  assert.strictEqual(w.r.money.bank.totalMicro(), 0);
  conserved(w);
});

test('bots never cash out and are never back once caught', () => {
  const w = world({ paidBots: true });
  const bot = w.r._spawnBot();
  w.r.money.seedBot(bot.id, SEED, bot.name);
  assert.strictEqual(w.r.hold('nobody', true), false);
  putAt(bot, 6, 1);
  catchByGhost(w, bot);
  step(w, Math.round(R.DEATH_S * R.TICK_HZ) + 2);
  assert.ok(!w.r.players.has(bot.id), 'gone for good');
  assert.strictEqual(w.calls.cashout.length, 0);
});

test('fuzz: paid people and bounty bots play with real ghosts for a long while; the ledger always closes', () => {
  for (const seed of [3, 17, 29]) {
    const w = world({ seed, mx: 2, my: 2 });
    w.r.ghosts = require('../server/chomp/chompGhosts').makeGhosts(w.r.A);
    const people = [];
    for (let i = 0; i < 5; i++) people.push(join(w, 'p' + seed + '_' + i));
    for (let i = 0; i < 4; i++) {
      const b = w.r._spawnBot();
      w.r.money.seedBot(b.id, SEED, b.name);
    }
    let deposits = 5 * SEED + 4 * SEED;
    let rnd = seed;
    const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let t = 0; t < 6000; t++) {
      for (const pl of people) {
        if (!w.r.players.has(pl.p.id) || pl.p.dying) continue;
        if (rand() < 0.05) w.r.input(pl.p, Math.floor(rand() * 4), t & 0xffff, null, null);
        if (rand() < 0.01) w.r.hold(pl.s.id, true);
      }
      step(w);
    }
    const out = w.calls.cashout.reduce((s, x) => s + x.grossMicro, 0) + w.calls.refund.reduce((s, x) => s + x.micro, 0) +
      w.calls.owed.reduce((s, x) => s + x.micro, 0) + w.calls.seedBack.reduce((s, x) => s + x.micro, 0);
    assert.strictEqual(w.r.money.bank.totalMicro() + out, deposits, 'every micro accounted for (seed ' + seed + ')');
    const rows = w.r.money.shutdownSettle('crash');
    const after = rows.reduce((s, r) => s + r.micro, 0);
    assert.ok(after >= 0);
    assert.strictEqual(w.r.money.bank.totalMicro(), 0);
    assert.strictEqual(w.calls.breach.filter((b) => b.kind !== 'emergency').length, 0, 'no breach');
  }
});
