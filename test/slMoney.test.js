'use strict';
// The paid sl money controller (PAID-SL-DESIGN.md 3.3, 4 to 8, 11.1 slMoney; task T2): the M1 to M3 fact order, null
// and all-null drops, the one exit, open's rollback and walletSeat before the journal, abort, cash-out (90/10, the
// order dispatched before it returns, one CASHOUT-ORDER line), the shutdown, emergency and orphan settles (100% of
// the grown balance; emergency and orphan through the owed lane with a keyed journal close and one onOwed each, no
// refund hook), an eat by a snake with no account, collusion buckets, the dollar getters, and a real paid sim run
// with the full checker every step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSlMoney, SlMoney, REQUIRED_HOOKS, COLLUSION_BUCKET_MS } = require('../server/slPaid/slMoney');
const { HOUSE_CUT_DIV } = require('../server/paperPayout');
const { createSim } = require('../server/sl/slSim');
const { createRng } = require('../server/sl/slRng');
const slSnake = require('../server/sl/slSnake');
const { FIXTURE } = require('./slLawsFixture');

const GRD = FIXTURE.L1.value;
const FLUX = 2923;
const LABEL = 'sl_na_s0_5';
const STAKE = 500000;

// Every hook recorded in call order; the directory's walletSeat as T4 keeps it (throws on a seated wallet, cleared
// only by its own seat's close); a journal that remembers what it was told.
function spy(opts) {
  const o = opts || {};
  const calls = [];
  const walletSeat = new Map();
  const journal = {
    records: [],
    open(acct, room) {
      calls.push(['journal.open', acct.jid]);
      if (o.journalOpen) return o.journalOpen(acct);
      this.records.push({ t: 'open', jid: acct.jid, wallet: acct.wallet, micro: acct.deposit, room });
      return true;
    },
    close(acct, outcome, extra, room) {
      calls.push(['journal.close', acct.jid, outcome]);
      this.records.push(Object.assign({ t: 'close', jid: acct.jid, outcome, room }, extra));
      return true;
    },
    floor(rec) {
      calls.push(['journal.floor', rec.key]);
      if (o.journalFloor) return o.journalFloor(rec);
      this.records.push(Object.assign({ t: 'floor' }, rec));
      return true;
    },
  };
  const hook = (name) => (...args) => {
    calls.push([name].concat(args));
    if (o[name]) return o[name](...args);
    return undefined;
  };
  const hooks = {
    onCashout: hook('onCashout'),
    onOwed: hook('onOwed'),
    onFloor: hook('onFloor'),
    onHouse: hook('onHouse'),
    onBreach: hook('onBreach'),
    onTransfer: hook('onTransfer'),
    onAccountOpen: (acct) => {
      calls.push(['onAccountOpen', acct.jid]);
      if (o.onAccountOpen) o.onAccountOpen(acct);
      if (walletSeat.has(acct.wallet)) throw new Error('wallet already seated');
      walletSeat.set(acct.wallet, { room: o.room || null, snakeId: acct.snakeId });
    },
    onAccountClosed: (acct, outcome, extra) => {
      calls.push(['onAccountClosed', acct.jid, outcome, extra]);
      const w = walletSeat.get(acct.wallet);
      if (w && w.snakeId === acct.snakeId) walletSeat.delete(acct.wallet);
    },
    journal,
  };
  const of = (name) => calls.filter((c) => c[0] === name);
  return { hooks, calls, of, walletSeat, journal };
}

function quietLog() {
  const lines = [];
  const put = (lvl) => (...a) => lines.push(lvl + ' ' + a.map(String).join(' '));
  return { lines, log: put('log'), warn: put('warn'), error: put('error') };
}

let uuidN = 0;
function uuid() {
  uuidN++;
  return '00000000-0000-4000-8000-' + String(uuidN).padStart(12, '0');
}

// A journal id as the door makes it (crypto.randomUUID), so every owed key below is one db.recordOwedOnce takes.
const OWED_KEY = /^agowed:[0-9a-f-]{36}$/; // db.js recordOwedOnce
function jidOf(n) {
  return 'a0000000-0000-4000-8000-' + String(n).padStart(12, '0');
}

// The owed row of seat n (entry(n)) as every refund lane builds it.
function owed(n, micro, why) {
  const key = 'agowed:' + jidOf(n);
  assert.match(key, OWED_KEY);
  return { key, wallet: 'W' + n, name: 'p' + n, micro, reason: 'refund slither ' + why + ' ' + LABEL + ' ' + key };
}

function money(s, extra) {
  const log = quietLog();
  let t = 1000;
  const m = createSlMoney(Object.assign({ stake: 0.5, label: LABEL, hooks: s.hooks, uuid, log, now: () => t,
    checkEvery: 1 }, extra));
  m.clock = { set: (v) => { t = v; }, add: (v) => { t += v; } };
  m.lines = log.lines;
  return m;
}

function entry(n, micro) {
  return { jid: jidOf(n), micro: micro === undefined ? STAKE : micro, wallet: 'W' + n, name: 'p' + n, paid: 0.5 };
}

function i1(m) {
  const l = m.bank.ledger;
  assert.equal(m.bank.sums.acc + m.bank.sums.floor + l.outCash + l.outRefund + l.outHouse, l.in, 'I1');
  const re = m.bank.recount();
  assert.deepEqual(re, { acc: m.bank.sums.acc, floor: m.bank.sums.floor }, 'I2');
  assert.deepEqual(Array.from(m.accounts.keys()).sort(), m.bank.openIds().sort(), 'the records mirror the bank');
}

let foodN = 1;
function food(b) {
  return { id: foodN++, x: GRD + 100, y: GRD, b: b === undefined ? 70 : b, nat: false };
}

function drops(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ food: food() });
  return out;
}

// ------------------------------------------------------------------ construction

test('the hooks are all required; there is no refund hook', () => {
  assert.deepEqual(REQUIRED_HOOKS, ['onCashout', 'onOwed', 'onFloor', 'onHouse', 'onBreach', 'onTransfer',
    'onAccountOpen', 'onAccountClosed', 'journal']);
  assert.ok(!REQUIRED_HOOKS.includes('onRefund'));
  const s = spy();
  for (const name of REQUIRED_HOOKS) {
    const h = Object.assign({}, s.hooks);
    delete h[name];
    assert.throws(() => createSlMoney({ stake: 0.5, label: LABEL, hooks: h }), new RegExp(name));
  }
  assert.throws(() => createSlMoney({ stake: 0.5, hooks: Object.assign({}, s.hooks, { journal: { open() {} } }) }), /journal/);
  assert.throws(() => createSlMoney({ stake: 0, hooks: s.hooks }), /stake/);
  assert.throws(() => createSlMoney({ stake: 0.5, hooks: s.hooks, checkEvery: 0 }), /checkEvery/);
  // a logger missing a line a money path writes is refused here, not found inside a cash-out
  assert.throws(() => createSlMoney({ stake: 0.5, hooks: s.hooks, log: { error() {}, warn() {} } }), /log needs log and error/);
  assert.throws(() => createSlMoney({ stake: 0.5, hooks: s.hooks, log: { log() {}, warn() {} } }), /log needs log and error/);
  assert.ok(createSlMoney({ stake: 1, hooks: s.hooks }) instanceof SlMoney);
  assert.equal(HOUSE_CUT_DIV, 10);
});

test('the one exit: only _close deletes an account record', () => {
  // A Windows checkout (core.autocrlf) has CRLF; the scan is about the code, not the line endings.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'slPaid', 'slMoney.js'), 'utf8')
    .replace(/\r\n/g, '\n').replace(/\/\/.*$/gm, '');
  const hits = src.split('\n').filter((l) => /accounts\.(delete|clear)\(/.test(l));
  assert.equal(hits.length, 1, hits.join('\n'));
  const at = src.indexOf(hits[0]);
  const fn = src.lastIndexOf('\n  _close(', at);
  assert.ok(fn > 0 && src.indexOf('\n  }\n', fn) > at, 'inside _close');
  assert.ok(!/\.bank\.(accounts|floor|ledger|sums)\.(set|delete|clear)\(/.test(src), 'no write past the bank');
  assert.ok(!/\.bank\.ledger\.\w+\s*[+-]?=/.test(src), 'no counter written past the bank');
});

// ------------------------------------------------------------------ open, rollback, abort

test('open: checks first; onAccountOpen (walletSeat) before the journal; the record mirrors the bank', () => {
  const s = spy();
  const m = money(s);
  const a = m.open(7, entry(1));
  assert.ok(Object.isFrozen(a));
  assert.deepEqual([a.snakeId, a.jid, a.wallet, a.name, a.deposit, a.paid, a.stakeSig], [7, jidOf(1), 'W1', 'p1', STAKE, 0.5, null]);
  assert.deepEqual(s.calls.map((c) => c[0]), ['onAccountOpen', 'journal.open']);
  assert.equal(m.account(7), a);
  assert.equal(m.account(jidOf(1)), a);
  assert.equal(m.worthOf(7), STAKE);
  assert.equal(m.worthOf(8), null);
  i1(m);
  const before = JSON.stringify(m.bank.totals());
  for (const [id, e, re] of [[0, entry(2), /snake id/], [1.5, entry(2), /snake id/], [8, entry(2, 0), /micro/],
    [8, entry(2, 1.5), /micro/], [8, entry(2, NaN), /micro/], [8, entry(2, 2 ** 53), /micro/],
    [8, Object.assign(entry(2), { wallet: '' }), /wallet/], [8, Object.assign(entry(2), { jid: undefined }), /jid/],
    // a jid whose owed key db.recordOwedOnce would refuse: every refund lane of the seat would fail
    [8, Object.assign(entry(2), { jid: 'jid-2' }), /jid/], [8, Object.assign(entry(2), { jid: jidOf(2).toUpperCase() }), /jid/],
    [8, Object.assign(entry(2), { jid: 'x' + jidOf(2) }), /jid/], [8, Object.assign(entry(2), { jid: jidOf(2) + '\n' }), /jid/],
    [7, entry(2), /already open/], [8, Object.assign(entry(2), { jid: jidOf(1) }), /already open/]]) {
    assert.throws(() => m.open(id, e), re);
  }
  assert.equal(JSON.stringify(m.bank.totals()), before, 'a refused open changes nothing');
  assert.equal(s.of('onAccountOpen').length, 1);
});

test('open rollback: a seated wallet throws before the journal is written; nothing stays open', () => {
  const s = spy();
  const m = money(s);
  m.open(7, entry(1));
  s.calls.length = 0;
  assert.throws(() => m.open(8, Object.assign(entry(2), { wallet: 'W1' })), /already seated/);
  assert.deepEqual(s.calls.map((c) => c[0]), ['onAccountOpen'], 'no journal write, no close hook for a seat never made');
  assert.equal(m.account(8), null);
  assert.equal(m.bank.isOpen(8), false);
  assert.equal(s.walletSeat.get('W1').snakeId, 7, 'the other seat of the wallet stands');
  assert.equal(m.bank.ledger.outRefund, STAKE, 'the rolled-back deposit is booked out (the door refunds the token)');
  i1(m);
  // a journal that throws after the seat: rolled back, the directory forgets the seat, no journal close
  const s2 = spy({ journalOpen: () => { throw new Error('disk'); } });
  const m2 = money(s2);
  assert.throws(() => m2.open(9, entry(3)), /disk/);
  assert.deepEqual(s2.calls.map((c) => c[0]), ['onAccountOpen', 'journal.open', 'onAccountClosed']);
  assert.equal(s2.of('onAccountClosed')[0][2], 'aborted');
  assert.equal(s2.walletSeat.size, 0);
  assert.equal(m2.openCount(), 0);
  assert.equal(s2.of('journal.close').length, 0);
  i1(m2);
  // a journal that only answers false: refused like a throw (security review item d: a door-only open is refunded at
  // boot as never seated, so a seated account must have its own open record), rolled back, the line logged
  const s3 = spy({ journalOpen: () => false });
  const m3 = money(s3);
  assert.throws(() => m3.open(9, entry(3)), /did not write/);
  assert.deepEqual(s3.calls.map((c) => c[0]), ['onAccountOpen', 'journal.open', 'onAccountClosed']);
  assert.equal(s3.of('onAccountClosed')[0][2], 'aborted');
  assert.equal(m3.openCount(), 0);
  assert.equal(m3.bank.isOpen(9), false);
  assert.ok(m3.lines.some((l) => new RegExp('JOURNAL open of ' + jidOf(3) + ' not written').test(l)));
  i1(m3);
});

test('abort: the deposit out, the seat forgotten, no journal close (the door writes it with its refund); refused when settled', () => {
  const s = spy();
  const m = money(s);
  m.open(7, entry(1));
  s.calls.length = 0;
  assert.equal(m.abort(7), true);
  assert.equal(m.abort(7), false);
  assert.equal(m.abort(99), false);
  assert.deepEqual(s.calls.map((c) => c[0]), ['onAccountClosed']);
  assert.equal(s.calls[0][2], 'aborted');
  assert.equal(s.walletSeat.size, 0);
  assert.equal(m.openCount(), 0);
  assert.equal(m.bank.ledger.outRefund, STAKE);
  assert.equal(m.closedCount.aborted, 1);
  i1(m);
  m.shutdownSettle('shutdown');
  assert.throws(() => m.open(8, entry(2)), /settled/);
});

test('a seat refund the bank refuses (abort, or open\'s rollback): left open, CRITICAL with its jid and micro, alerted, the room tainted', () => {
  // abort: an inflated account makes the ceiling refuse the refund withdraw
  const s = spy();
  const m = money(s);
  m.open(7, entry(1));
  m.bank.accounts.set(7, Object.assign({}, m.bank.accounts.get(7), { micro: STAKE * 3 }));
  assert.throws(() => m.abort(7), /ceiling/);
  assert.ok(m.account(7) && m.bank.isOpen(7), 'the account stays open (the door refunds nothing)');
  assert.ok(m.lines.some((l) => l.includes('SEAT CRITICAL abort refund of snake 7 (' + jidOf(1) + ', ' + STAKE * 3 +
    ' micro) refused, left open')));
  assert.deepEqual(s.of('onBreach').map((c) => c[1]).filter((b) => b.kind === 'seat-refund-refused'),
    [{ snakeId: 7, jid: jidOf(1), micro: STAKE * 3, why: 'abort', kind: 'seat-refund-refused', lobbyType: LABEL }]);
  assert.equal(m.tainted, true);
  assert.throws(() => m.open(8, entry(2)), /tainted/, 'no new seat in a room whose bank refused a refund');
  // open's rollback: the wallet is seated, and the ceiling refuses the rollback while account 7 is inflated
  const s2 = spy();
  const m2 = money(s2);
  m2.open(7, entry(1));
  m2.bank.accounts.set(7, Object.assign({}, m2.bank.accounts.get(7), { micro: STAKE * 3 }));
  assert.throws(() => m2.open(8, Object.assign(entry(2), { wallet: 'W1' })), /already seated/);
  assert.ok(m2.account(8) && m2.bank.isOpen(8), 'left open with its deposit');
  assert.ok(m2.lines.some((l) => l.includes('SEAT CRITICAL rollback refund of snake 8 (' + jidOf(2) + ', ' + STAKE +
    ' micro) refused, left open')));
  assert.ok(s2.of('onBreach').some((c) => c[1].kind === 'seat-refund-refused' && c[1].why === 'rollback' &&
    c[1].jid === jidOf(2) && c[1].micro === STAKE));
  assert.equal(m2.tainted, true);
});

// ------------------------------------------------------------------ the facts

// A fake step: the deaths and eats as the sim logs them.
function step(m, tick, deaths, eats) {
  return m.applyFacts({ tick, deaths }, eats);
}

test('M1 before M2: a glide-kill pellet is eaten the step it drops; M2 before M3: eaten cash is dropped again', () => {
  const s = spy();
  const m = money(s);
  m.open(1, entry(1));
  m.open(2, entry(2));
  m.open(3, entry(3));
  // snake 1's glide ran out (cause kill, before Phase A); snake 2 eats two of its pellets in Phase A, then dies in
  // Phase C (killed by 3), dropping everything it holds
  const d1 = drops(5);
  const d2 = drops(4);
  const log1 = { tick: 1, deaths: [
    { id: 2, cause: 'snake', killer: 3, drops: d2 },
    { id: 1, cause: 'kill', killer: 0, drops: d1 },
  ] };
  const eats1 = [{ food: d1[0].food, eater: 2 }, { food: d1[4].food, eater: 2 }];
  const r = m.applyFacts(log1, eats1);
  assert.deepEqual(Array.from(r.lost), [[1, STAKE], [2, STAKE + 100000 + 100000]]);
  assert.equal(r.credited, 200000);
  assert.equal(m.openCount(), 1);
  assert.equal(m.bank.pelletCount(), 3 + 4);
  assert.equal(m.bank.floorMicro(), 300000 + 700000);
  for (const q of d2) assert.equal(m.bank.pellet(q.food).micro, 175000);
  assert.deepEqual(s.of('journal.close').map((c) => [c[1], c[2]]), [[jidOf(1), 'died'], [jidOf(2), 'died']]);
  const closes = s.journal.records.filter((x) => x.t === 'close');
  assert.equal(closes[0].why, 'kill');
  assert.equal(closes[1].why, 'snake');
  assert.equal(closes[1].lostMicro, 700000);
  // replaying the same log (the finally after a throw, then again) moves nothing and alerts nothing
  const again = m.applyFacts(log1, eats1);
  assert.equal(again.lost.size + again.credited + again.breaches, 0);
  assert.equal(s.of('onBreach').length, 0);
  i1(m);
  // 3 eats what is left and keeps it
  step(m, 2, [], d1.slice(1, 4).concat(d2).map((q) => ({ food: q.food, eater: 3 })));
  assert.equal(m.worthOf(3), STAKE + 1000000);
  assert.equal(m.bank.pelletCount(), 0);
  assert.deepEqual(m.takeChanged(), [{ id: 3, v: STAKE + 1000000, d: 1000000 }]);
  assert.deepEqual(m.takeChanged(), []);
  i1(m);
});

test('a death beats a cash-out in the same step; the remainder goes one micro each to the first pellets', () => {
  const s = spy();
  const m = money(s);
  m.open(1, entry(1, 1000003));
  const d = drops(4);
  step(m, 1, [{ id: 1, cause: 'border', drops: d }], []);
  assert.equal(m.cashOut(1, 'sock'), null, 'the death closed the account first');
  assert.equal(s.of('onCashout').length, 0);
  assert.deepEqual(d.map((q) => m.bank.pellet(q.food).micro), [250001, 250001, 250001, 250000]);
  i1(m);
});

test('null drops are skipped; all-null drops send the whole account to the house as a breach, once', () => {
  const s = spy();
  const m = money(s);
  m.open(1, entry(1));
  m.open(2, entry(2));
  const d = [{ food: null }].concat(drops(2), [null, { food: null }], drops(1));
  step(m, 1, [{ id: 1, cause: 'snake', drops: d }], []);
  const placed = d.filter((q) => q && q.food);
  assert.deepEqual(placed.map((q) => m.bank.pellet(q.food).micro), [166667, 166667, 166666]);
  assert.equal(s.of('onHouse').length, 0);
  step(m, 2, [{ id: 2, cause: 'snake', drops: [{ food: null }, { food: null }] }], []);
  const house = s.of('onHouse');
  assert.equal(house.length, 1);
  assert.deepEqual([house[0][1].micro, house[0][1].wallet, house[0][1].why, house[0][1].label], [STAKE, 'W2', 'unplaced', LABEL]);
  assert.equal(m.bank.house.breach, STAKE);
  assert.equal(s.of('onBreach').filter((c) => c[1].kind === 'unplaced').length, 1);
  assert.equal(m.openCount(), 0);
  i1(m);
});

test('an eat by a snake with no account: the pellet goes to the house as slither_breach once, I1 holds', () => {
  const s = spy();
  const m = money(s);
  m.open(1, entry(1));
  const d = drops(2);
  step(m, 1, [{ id: 1, cause: 'snake', drops: d }], []);
  const eats = [{ food: d[0].food, eater: 42 }];
  const r = step(m, 2, [], eats);
  assert.equal(r.breaches, 1);
  step(m, 2, [], eats);
  step(m, 3, [], eats);
  const house = s.of('onHouse');
  assert.equal(house.length, 1);
  assert.deepEqual([house[0][1].micro, house[0][1].wallet, house[0][1].why], [250000, 'W1', 'eat-no-account']);
  const alerts = s.of('onBreach').filter((c) => c[1].kind === 'eat-no-account');
  assert.equal(alerts.length, 1);
  assert.ok(!JSON.stringify(alerts[0][1]).includes('W1'), 'no wallet in an alert');
  assert.equal(m.bank.isPellet(d[0].food), false);
  assert.equal(m.bank.house.breach, 250000);
  i1(m);
  // a death with gold and no account: alerted, nothing moves
  step(m, 4, [{ id: 77, cause: 'snake', drops: drops(3) }], []);
  assert.equal(s.of('onBreach').filter((c) => c[1].kind === 'death-no-account').length, 1);
  i1(m);
});

test('a fact that throws changes no balance, alerts once, and the others still apply', () => {
  const s = spy();
  const m = money(s);
  m.open(1, entry(1));
  m.open(2, entry(2));
  const d = drops(3);
  d[1].food = d[0].food; // the same food twice: split refuses the whole death
  const e = drops(2);
  const r = step(m, 1, [{ id: 1, cause: 'snake', drops: d }, { id: 2, cause: 'border', drops: e }], [null, {}]);
  assert.equal(m.worthOf(1), STAKE, 'the failed death left its account whole');
  assert.equal(r.lost.get(2), STAKE);
  assert.equal(s.of('onBreach').filter((c) => c[1].kind === 'fact').length, 1);
  i1(m);
});

// ------------------------------------------------------------------ cash-out

test('cash-out: withdraw first, 90/10 in integers, journal close, one CASHOUT-ORDER line, the order out before it returns', () => {
  for (const [micro, cut, net] of [[500000, 50000, 450000], [1000000, 100000, 900000], [500581, 50058, 450523]]) {
    let seenInside = null;
    const s = spy({
      onCashout: (order) => {
        seenInside = { open: m.account(7), bankOpen: m.bank.isOpen(7), closes: s.of('journal.close').length };
        assert.equal(order.grossMicro, micro);
      },
    });
    const m = money(s);
    m.attach({ sim: null }, { onClosed: () => { throw new Error('the room threw'); } });
    m.open(7, entry(1, micro));
    const o = m.cashOut(7, 'sock-1');
    assert.deepEqual([o.gross, o.cut, o.net], [micro, cut, net]);
    assert.equal(cut, Math.floor(micro / 10));
    assert.deepEqual(seenInside, { open: null, bankOpen: false, closes: 1 }, 'withdrawn and closed before the order');
    const orders = s.of('onCashout');
    assert.equal(orders.length, 1);
    assert.deepEqual(orders[0][1], { cashoutId: o.cid, socketId: 'sock-1', wallet: 'W1', name: 'p1', grossMicro: micro,
      stake: 0.5, label: LABEL, jid: jidOf(1) });
    assert.equal(o.order, orders[0][1]);
    // the order line names the journal id and the wallet too: a payout in flight at a kill can be matched by hand
    // to the player it is owed to (review MS-2)
    assert.equal(m.lines.filter((l) => l.startsWith('log [SLP] CASHOUT-ORDER ')).length, 1);
    assert.ok(m.lines.includes('log [SLP] CASHOUT-ORDER ' + o.cid + ' ' + micro + ' ' + LABEL + ' journal ' + jidOf(1) +
      ' wallet W1'));
    const close = s.journal.records.find((x) => x.t === 'close');
    assert.deepEqual([close.outcome, close.grossMicro, close.cutMicro, close.netMicro, close.cashoutId, close.key,
      close.awaitPayout], ['cashedout', micro, cut, net, o.cid, undefined, true]);
    assert.equal(m.bank.ledger.outCash, micro);
    // a throw the room makes after cashOut cannot bring a second order: the account is gone
    assert.equal(m.cashOut(7, 'sock-1'), null);
    assert.equal(s.of('onCashout').length, 1);
    assert.equal(s.walletSeat.size, 0);
    i1(m);
  }
});

test('cash-out: a hook that throws or rejects is logged, never rethrown; a refused withdraw throws and the snake keeps its account', async () => {
  const s = spy({ onCashout: () => { throw new Error('rpc down'); } });
  const m = money(s);
  m.open(7, entry(1));
  const o = m.cashOut(7);
  assert.equal(o.order.socketId, null);
  assert.ok(m.lines.some((l) => /CASHOUT CRITICAL order .* failed, owed 500000/.test(l)));
  const s2 = spy({ onCashout: () => Promise.reject(new Error('later')) });
  const m2 = money(s2);
  m2.open(7, entry(1));
  m2.cashOut(7);
  await new Promise((r) => setImmediate(r));
  assert.ok(m2.lines.some((l) => /CASHOUT CRITICAL order .* failed/.test(l)));
  // an inflated account: the ceiling refuses, nothing changes, the account stays for the snake that keeps playing
  const s3 = spy();
  const m3 = money(s3);
  m3.open(7, entry(1));
  m3.bank.accounts.set(7, Object.assign({}, m3.bank.accounts.get(7), { micro: STAKE * 3 }));
  assert.throws(() => m3.cashOut(7), /ceiling/);
  assert.ok(m3.account(7));
  assert.equal(s3.of('onCashout').length, 0);
  assert.ok(s3.of('onBreach').some((c) => c[1].kind === 'cashout-refused'));
});

test('cash-out: a logger that throws on the order line still sends the order once; a throw before the withdraw is CRITICAL and alerted', () => {
  // the order line is the last thing before the dispatch: a throwing logger must not strand the withdrawn account
  const s = spy();
  const m = money(s, { log: { log() { throw new Error('stdout gone'); }, warn() {}, error() {} } });
  m.open(7, entry(1));
  const o = m.cashOut(7, 'sock-1');
  assert.deepEqual(s.of('onCashout').map((c) => [c[1].cashoutId, c[1].grossMicro]), [[o.cid, STAKE]]);
  assert.deepEqual(s.journal.records.filter((x) => x.t === 'close').map((x) => [x.outcome, x.cashoutId]), [['cashedout', o.cid]]);
  assert.equal(m.account(7), null);
  i1(m);
  // the cashout id is drawn before the withdraw: its throw changes nothing and is alerted like a refused withdraw
  const s2 = spy();
  const m2 = money(s2, { uuid: () => { throw new Error('no entropy'); } });
  m2.open(7, entry(1));
  assert.throws(() => m2.cashOut(7), /no entropy/);
  assert.ok(m2.account(7) && m2.bank.isOpen(7));
  assert.equal(m2.worthOf(7), STAKE);
  assert.equal(s2.of('onCashout').length, 0);
  assert.ok(s2.of('onBreach').some((c) => c[1].kind === 'cashout-refused' && c[1].snakeId === 7));
  assert.ok(m2.lines.some((l) => /CASHOUT CRITICAL refused for snake 7 .*it keeps playing: no entropy/.test(l)));
  // a record with no bank account behind it (a mirror broken elsewhere) is refused the same way, nothing paid
  const s3 = spy();
  const m3 = money(s3);
  m3.open(7, entry(1));
  m3.bank.withdraw(7, 'refund');
  assert.throws(() => m3.cashOut(7), /no account 7/);
  assert.equal(s3.of('onCashout').length, 0);
  assert.ok(s3.of('onBreach').some((c) => c[1].kind === 'cashout-refused'));
});

// ------------------------------------------------------------------ settles

function grown(s) {
  // 1 and 2 seated; 3 died and 1 ate two of its four pellets: 1 holds 750000, the floor 250000
  const m = money(s);
  m.open(1, entry(1));
  m.open(2, entry(2));
  m.open(3, entry(3));
  const d = drops(4);
  step(m, 1, [{ id: 3, cause: 'snake', drops: d }], []);
  step(m, 2, [], [{ food: d[0].food, eater: 1 }, { food: d[1].food, eater: 1 }]);
  assert.equal(m.worthOf(1), 750000);
  return { m, d };
}

test('shutdown and crash: rows of 100% of the grown balance, keyed closes, the floor abandoned and logged, no money moved', () => {
  for (const why of ['shutdown', 'crash']) {
    const s = spy();
    const { m } = grown(s);
    s.calls.length = 0;
    const rows = m.shutdownSettle(why);
    assert.deepEqual(rows, [owed(1, 750000, why), owed(2, STAKE, why)]);
    const closes = s.journal.records.filter((x) => x.t === 'close' && x.outcome === 'refunded');
    assert.deepEqual(closes.map((c) => [c.jid, c.why, c.key, c.refundedMicro, c.reason]), rows.map((r) =>
      [r.key.slice(7), why, r.key, r.micro, r.reason]));
    for (const h of ['onOwed', 'onCashout', 'onFloor', 'onHouse']) assert.equal(s.of(h).length, 0, h);
    assert.equal(m.bank.house.abandoned, 250000);
    assert.ok(m.lines.includes('error [SLP] SHUTDOWN-FLOOR 250000 ' + LABEL));
    // Owen's answer of 2026-10-14: the house keeps it as slither floor income, so it is journaled for the next boot to
    // book (review MS-1): one record, the exact micro per source wallet
    const floors = s.journal.records.filter((x) => x.t === 'floor');
    assert.equal(floors.length, 1);
    assert.match(floors[0].key, /^slfloor:[0-9a-f-]{36}$/);
    assert.deepEqual([floors[0].room, floors[0].why, floors[0].micro, floors[0].bySource],
      [LABEL, why, 250000, [{ srcWallet: 'W3', srcName: 'p3', micro: 250000 }]]);
    assert.equal(m.stopped, true);
    assert.equal(m.openCount(), 0);
    assert.equal(s.walletSeat.size, 0);
    assert.deepEqual(m.shutdownSettle(why), []);
    i1(m);
  }
  // 'anything else' is a shutdown
  const s = spy();
  const m = money(s);
  m.open(1, entry(1));
  assert.match(m.shutdownSettle('SIGTERM')[0].reason, /^refund slither shutdown /);
  assert.equal(s.journal.records.filter((x) => x.t === 'floor').length, 0, 'no floor, no floor record');
  // a journal that cannot take the record: logged CRITICAL with the amount, the settle goes on
  for (const journalFloor of [() => false, () => { throw new Error('disk full'); }]) {
    const s2 = spy({ journalFloor });
    const { m: m2 } = grown(s2);
    assert.equal(m2.shutdownSettle('shutdown').length, 2, 'the rows still come back');
    assert.ok(m2.lines.some((l) => /^error \[SLP\] JOURNAL CRITICAL floor slfloor:\S+ of 250000 micro not written/.test(l)));
    i1(m2);
  }
});

test('emergency: every account through the owed lane (keyed close, then onOwed once, grown), the floor swept per source', () => {
  const s = spy();
  const { m } = grown(s);
  s.calls.length = 0;
  const r = m.emergencySettle('emergency');
  assert.equal(r.accounts, 2);
  assert.equal(r.micro, 1250000);
  const rows = s.of('onOwed').map((c) => c[1]);
  assert.deepEqual(rows, [owed(1, 750000, 'emergency'), owed(2, STAKE, 'emergency')]);
  assert.deepEqual(r.rows, rows);
  assert.deepEqual(r.left, [], 'nothing left open');
  // the close with its key comes before its row
  const order = s.calls.filter((c) => c[0] === 'journal.close' || c[0] === 'onOwed').map((c) => c[0]);
  assert.deepEqual(order, ['journal.close', 'onOwed', 'journal.close', 'onOwed']);
  const closes = s.journal.records.filter((x) => x.t === 'close' && x.outcome === 'refunded');
  assert.deepEqual(closes.map((c) => [c.outcome, c.why, c.key, c.refundedMicro]),
    [['refunded', 'emergency', 'agowed:' + jidOf(1), 750000], ['refunded', 'emergency', 'agowed:' + jidOf(2), STAKE]]);
  const floor = s.of('onFloor').map((c) => c[1]);
  assert.equal(floor.length, 1);
  assert.deepEqual([floor[0].micro, floor[0].srcWallet, floor[0].srcName, floor[0].label, floor[0].pid], [250000, 'W3', 'p3', LABEL, 'emergency']);
  assert.match(floor[0].sweepId, /^[0-9a-f-]{36}$/);
  assert.equal(s.of('onBreach').filter((c) => c[1].kind === 'emergency').length, 1);
  assert.equal(m.bank.ledger.outRefund, 1250000);
  assert.equal(m.bank.house.swept, 250000);
  assert.equal(m.stopped, true);
  i1(m);
});

test('emergency: any caller label still closes as an owed why, so the journal keeps the key for the replay', () => {
  const s = spy();
  const { m } = grown(s);
  const r = m.emergencySettle('retry');
  assert.deepEqual(r.rows, [owed(1, 750000, 'emergency'), owed(2, STAKE, 'emergency')]);
  const closes = s.journal.records.filter((x) => x.t === 'close' && x.outcome === 'refunded');
  assert.deepEqual(closes.map((c) => [c.why, c.key]), [['emergency', 'agowed:' + jidOf(1)], ['emergency', 'agowed:' + jidOf(2)]]);
  assert.equal(s.of('onFloor')[0][1].pid, 'emergency');
  const alert = s.of('onBreach').find((c) => c[1].kind === 'emergency')[1];
  assert.equal(alert.why, 'retry', 'the caller label rides in the alert only');
});

test('emergency and shutdown: an account the bank refuses is reported left open with its balance; a retry settles it', () => {
  const s = spy();
  const { m } = grown(s);
  // a double fault: account 1 inflated by one micro, so the ceiling refuses every out move in the room
  const good = m.bank.accounts.get(1);
  m.bank.accounts.set(1, Object.assign({}, good, { micro: good.micro + 1 }));
  s.calls.length = 0;
  let r = m.emergencySettle('emergency');
  assert.deepEqual([r.accounts, r.micro, r.rows, r.floor, r.left], [0, 0, [], null, [1, 2]]);
  assert.equal(m.stopped, true);
  assert.equal(m.openCount(), 2, 'still open, so the drain and the solvency sum still count them');
  assert.equal(m.liveStakeTotal() > 0, true);
  assert.equal(s.of('onOwed').length, 0);
  assert.equal(s.of('journal.close').length, 0);
  assert.ok(m.lines.some((l) => l.includes('EMERGENCY settle of snake 1 (' + jidOf(1) + ', 750001 micro) failed, left open')));
  assert.equal(s.of('onBreach').find((c) => c[1].kind === 'emergency')[1].left, 2);
  // the cause fixed, the sweep's retry settles both, once each
  m.bank.accounts.set(1, good);
  r = m.emergencySettle('emergency');
  assert.deepEqual(r.left, []);
  assert.deepEqual(r.rows, [owed(1, 750000, 'emergency'), owed(2, STAKE, 'emergency')]);
  assert.equal(r.floor.micro, 250000);
  assert.equal(s.of('onOwed').length, 2);
  i1(m);
  // shutdown: the rows stay an array; the left-open line names the jid and the balance the deposit record lacks
  const s2 = spy();
  const g2 = grown(s2).m;
  const a1 = g2.bank.accounts.get(1);
  g2.bank.accounts.set(1, Object.assign({}, a1, { micro: a1.micro + 1 }));
  assert.deepEqual(g2.shutdownSettle('shutdown'), []);
  assert.equal(g2.openCount(), 2);
  assert.ok(g2.lines.some((l) => l.includes('SHUTDOWN settle of snake 1 (' + jidOf(1) + ', 750001 micro) failed, left open')));
});

// A paid room as the checker and the orphan scan read it, around a fake sim.
function fakeRoom(m) {
  const snakes = new Map();
  const foods = new Map();
  const log = { tick: 0, deaths: [] };
  const sim = {
    laws: FIXTURE,
    snakes,
    foods,
    flux: () => FLUX,
    count: () => snakes.size,
    snake: (id) => snakes.get(id) || null,
    lastLog: () => log,
    food: { tick: { eats: [] }, get: (id) => foods.get(id) || null, forEachFood: (fn) => { for (const f of foods.values()) fn(f); } },
  };
  const room = { sim, humans: new Set(), laws: FIXTURE, money: m };
  m.attach(room);
  return room;
}

test('orphan (I4): an account whose snake is gone is refunded through the owed lane at the step end, once, grown', () => {
  const s = spy();
  const { m, d } = grown(s);
  const room = fakeRoom(m);
  for (const id of [1, 2]) {
    room.sim.snakes.set(id, { id });
    room.humans.add(id);
  }
  for (const q of d.slice(2)) room.sim.foods.set(q.food.id, q.food);
  room.sim.lastLog().tick = 1;
  room.sim.lastLog().deaths.push({ id: 3, cause: 'snake', drops: d });
  let r = m.endStep();
  assert.deepEqual(r.violations, [], JSON.stringify(r.violations));
  assert.deepEqual(r.orphans, []);
  // snake 1 vanishes from the sim with its account open (a fact that never applied)
  room.sim.snakes.delete(1);
  room.humans.delete(1);
  s.calls.length = 0;
  r = m.endStep();
  assert.deepEqual(r.orphans, [owed(1, 750000, 'orphan')]);
  assert.deepEqual(r.violations, [], 'refunded before the checker looked');
  assert.deepEqual(s.calls.filter((c) => c[0] === 'journal.close' || c[0] === 'onOwed').map((c) => c[0]), ['journal.close', 'onOwed']);
  assert.equal(s.of('onOwed')[0][1].micro, 750000);
  const close = s.journal.records.filter((x) => x.t === 'close').pop();
  assert.deepEqual([close.jid, close.outcome, close.why, close.key, close.refundedMicro], [jidOf(1), 'refunded', 'orphan', 'agowed:' + jidOf(1), 750000]);
  assert.equal(s.of('onBreach').filter((c) => c[1].kind === 'I4').length, 1);
  m.endStep();
  assert.equal(s.of('onOwed').length, 1, 'once');
  assert.equal(m.openCount(), 1);
  i1(m);
});

test('C-6: a throw after cashOut (sim.remove) and the emergency close that follows pay the cashed snake nothing more', () => {
  const s = spy();
  const m = money(s);
  const room = fakeRoom(m);
  m.attach(room, { onClosed: () => { throw new Error('the room threw'); } });
  for (const n of [7, 8]) {
    m.open(n, entry(n));
    room.sim.snakes.set(n, { id: n });
    room.humans.add(n);
  }
  const o = m.cashOut(7, 'sock-7');
  assert.equal(o.gross, STAKE);
  // sim.remove(7) threw before the snake left: the end of the step sees a live snake with no account, refunds nothing
  let e = m.endStep();
  assert.deepEqual(e.orphans, []);
  assert.deepEqual(e.violations.map((v) => v.kind), ['I13']);
  // then it is gone: still no orphan for it
  room.sim.snakes.delete(7);
  room.humans.delete(7);
  e = m.endStep();
  assert.deepEqual(e.orphans, []);
  // the failed wake closes the room: owed rows for the OTHER account only
  const r = m.emergencySettle('emergency');
  assert.deepEqual(r.rows, [owed(8, STAKE, 'emergency')]);
  assert.equal(s.of('onCashout').length, 1);
  assert.deepEqual(s.of('onOwed').map((c) => c[1].key), ['agowed:' + jidOf(8)]);
  assert.deepEqual(s.journal.records.filter((x) => x.t === 'close' && x.jid === jidOf(7)).map((x) => x.outcome), ['cashedout']);
  assert.deepEqual([m.bank.ledger.outCash, m.bank.ledger.outRefund], [STAKE, STAKE]);
  i1(m);
});

test('the checker at the step end: I13 and I10 taint the room (no new seat); alerts per kind; full every checkEvery steps', () => {
  const s = spy();
  const m = money(s, { checkEvery: 3 });
  const room = fakeRoom(m);
  m.open(1, entry(1));
  room.sim.snakes.set(1, { id: 1 });
  room.humans.add(1);
  room.sim.snakes.set(5, { id: 5 }); // a live human snake with no account
  room.humans.add(5);
  assert.deepEqual(m.endStep().violations, [], 'step 1: cheap only');
  assert.deepEqual(m.endStep().violations, [], 'step 2: cheap only');
  const v = m.endStep().violations;
  assert.deepEqual(v.map((x) => x.kind), ['I13']);
  assert.equal(m.tainted, true);
  assert.throws(() => m.open(2, entry(2)), /tainted/);
  assert.equal(s.of('onBreach').filter((c) => c[1].kind === 'I13').length, 1);
  // I10 counts people only (the owner's bots are on top, Owen 2026-10-17): 25 bot snakes are fine, 25 people are not
  for (let i = 0; i < 25; i++) room.sim.snakes.set(100 + i, { id: 100 + i });
  assert.ok(!m.endStep().violations.some((x) => x.kind === 'I10'));
  for (let i = 0; i < 25; i++) room.humans.add(100 + i);
  assert.ok(m.endStep().violations.some((x) => x.kind === 'I10'));
});

test('idle sweep: refused with an account open; one sweep per source wallet with its exact micro; a second books nothing', () => {
  const s = spy();
  const m = money(s);
  m.open(1, entry(1));
  m.open(2, entry(2, 1000000));
  step(m, 1, [{ id: 1, cause: 'snake', drops: drops(3) }], []);
  assert.equal(m.sweepFloor('idle'), null, 'snake 2 can still eat it');
  step(m, 2, [{ id: 2, cause: 'border', drops: drops(5) }], []);
  const r = m.sweepFloor('idle');
  assert.equal(r.micro, 1500000);
  assert.deepEqual(r.sweeps.map((x) => [x.srcWallet, x.micro, x.pid]), [['W1', STAKE, 'idle'], ['W2', 1000000, 'idle']]);
  assert.notEqual(r.sweeps[0].sweepId, r.sweeps[1].sweepId);
  assert.deepEqual(s.of('onFloor').map((c) => c[1]), r.sweeps);
  assert.deepEqual(m.sweepFloor('idle'), { micro: 0, count: 0, sweeps: [] });
  assert.equal(s.of('onFloor').length, 2);
  assert.equal(m.bank.house.swept, 1500000);
  i1(m);
});

// ------------------------------------------------------------------ collusion, getters

test('collusion: one record per (source, eater) pair per bucket, flushed at its age and at a settle', () => {
  const s = spy();
  const m = money(s);
  m.open(1, entry(1));
  m.open(2, entry(2));
  m.open(3, entry(3));
  const d = drops(4);
  step(m, 1, [{ id: 3, cause: 'snake', drops: d }], []);
  step(m, 2, [], [{ food: d[0].food, eater: 1 }]);
  m.clock.add(1000);
  step(m, 3, [], [{ food: d[1].food, eater: 1 }, { food: d[2].food, eater: 2 }]);
  m.endStep();
  assert.equal(s.of('onTransfer').length, 0, 'buckets younger than ' + COLLUSION_BUCKET_MS + ' ms wait');
  m.clock.add(COLLUSION_BUCKET_MS - 1000);
  m.endStep();
  const t = s.of('onTransfer').map((c) => c[1]);
  assert.deepEqual(t, [{ srcWallet: 'W3', dstWallet: 'W1', micro: 250000, label: LABEL, lobbyType: LABEL }]);
  m.clock.add(1000);
  m.endStep();
  assert.equal(s.of('onTransfer').length, 2);
  step(m, 4, [], [{ food: d[3].food, eater: 2 }]);
  m.emergencySettle();
  // W3 to W1 (two eats in one bucket), W3 to W2 at its age, then W3 to W2 again flushed by the settle
  assert.deepEqual(s.of('onTransfer').map((c) => [c[1].srcWallet, c[1].dstWallet, c[1].micro]),
    [['W3', 'W1', 250000], ['W3', 'W2', 125000], ['W3', 'W2', 125000]]);
});

test('collusion: the idle retire flushes a bucket too young for the step end (no step runs after the pause)', () => {
  const s = spy();
  const m = money(s);
  m.open(1, entry(1));
  m.open(2, entry(2));
  const d = drops(2);
  step(m, 1, [{ id: 2, cause: 'snake', drops: d }], []);
  step(m, 2, [], [{ food: d[0].food, eater: 1 }]);
  m.cashOut(1, 'sock-1');
  m.clock.add(COLLUSION_BUCKET_MS - 1);
  m.endStep();
  assert.equal(s.of('onTransfer').length, 0, 'the last step before the pause: one ms too young');
  assert.equal(m.sweepFloor('idle').micro, 250000);
  assert.deepEqual(s.of('onTransfer').map((c) => c[1]), [{ srcWallet: 'W2', dstWallet: 'W1', micro: 250000, label: LABEL,
    lobbyType: LABEL }]);
});

test('the console getters answer in dollars: snakes, floorWorth, liveStakeTotal', () => {
  const s = spy();
  const { m } = grown(s);
  assert.deepEqual(Array.from(m.snakes), [['sl1', { alive: true, isBot: false, worth: 0.75 }],
    ['sl2', { alive: true, isBot: false, worth: 0.5 }]]);
  assert.equal(m.floorWorth, 0.25);
  assert.equal(m.liveStakeTotal(), 1.5);
  assert.equal(m.openCount(), 2);
  assert.equal(m.totals().open, 2);
});

// ------------------------------------------------------------------ a real paid sim

test('a real paid sim: 3000 steps of up to 12 paid snakes, the full checker every step finds nothing, I1 every step', () => {
  const sim = createSim(FIXTURE, { seed: 31, world: true,
    paidDrops: { border: true, inset: FIXTURE.C_PAID_DROP_INSET.value } });
  const s = spy();
  const m = money(s, { walletSeat: s.walletSeat });
  const room = { sim, humans: new Set(), laws: FIXTURE, money: m };
  m.attach(room);
  const r = createRng(31);
  let life = 0;
  const seat = () => {
    const sn = sim.spawn({ cv: r.int(66), sct: r.next() < 0.3 ? 100 + r.int(200) : undefined });
    life++;
    m.open(sn.id, { jid: jidOf(1000 + life), micro: r.next() < 0.5 ? 500000 : 1000000, wallet: 'W' + life, name: 'n' + life });
    s.walletSeat.get('W' + life).room = room;
    room.humans.add(sn.id);
    return sn.id;
  };
  const slots = [];
  for (let k = 0; k < 12; k++) slots.push(seat());
  let deaths = 0;
  let credited = 0;
  let cashed = 0;
  for (let t = 0; t < 3000; t++) {
    for (let k = 0; k < slots.length; k++) {
      const id = slots[k];
      const sn = sim.snake(id);
      if (!sn) {
        if (r.next() < 0.05) slots[k] = seat();
        continue;
      }
      const u = r.next();
      if (k % 4 === 0 && u < 0.2) {
        const a = Math.atan2(slSnake.headY(sn) - GRD, slSnake.headX(sn) - GRD) + r.next() - 0.5;
        sim.setInput(id, { type: 'angle', q: Math.round((((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 251) % 251 }, 0);
      } else if (u < 0.1) sim.setInput(id, { type: 'angle', q: r.int(251) }, r.int(43));
      else if (u < 0.13) sim.setInput(id, { type: 'boost', on: r.next() < 0.5 }, r.int(43));
      else if (u < 0.1306) sim.kill(id);
    }
    sim.applyInputs();
    let threw = null;
    try {
      sim.step();
    } finally {
      const f = m.applyFacts(sim.lastLog(), sim.food.tick.eats);
      credited += f.credited;
      for (const d of sim.lastLog().deaths) {
        room.humans.delete(d.id);
        deaths++;
      }
      threw = f;
    }
    assert.ok(threw);
    // a cash-out now and then (M4): money first, then the snake leaves
    if (r.next() < 0.01) {
      const id = slots[r.int(slots.length)];
      if (sim.snake(id)) {
        const o = m.cashOut(id, null);
        assert.ok(o && o.gross > 0);
        sim.remove(id);
        room.humans.delete(id);
        cashed++;
      }
    }
    const e = m.endStep();
    assert.deepEqual(e.violations, [], 'step ' + t + ': ' + JSON.stringify(e.violations.slice(0, 3)));
    assert.deepEqual(e.orphans, []);
    i1(m);
  }
  assert.ok(deaths > 100 && credited > 1000000 && cashed > 5, JSON.stringify({ deaths, credited, cashed }));
  assert.equal(s.of('onBreach').length, 0, JSON.stringify(s.of('onBreach').slice(0, 3)));
  assert.equal(s.of('onHouse').length, 0);
  const gross = s.of('onCashout').reduce((a, c) => a + c[1].grossMicro, 0);
  assert.equal(gross, m.bank.ledger.outCash);
  assert.equal(m.bank.ledger.in, m.bank.sums.acc + m.bank.sums.floor + gross);
  // the journal: every jid opened once, closed at most once, open accounts unclosed
  const opens = new Set(s.journal.records.filter((x) => x.t === 'open').map((x) => x.jid));
  const closes = s.journal.records.filter((x) => x.t === 'close').map((x) => x.jid);
  assert.equal(new Set(closes).size, closes.length);
  assert.equal(opens.size, closes.length + m.openCount());
  const rows = m.shutdownSettle('shutdown');
  assert.equal(rows.reduce((a, x) => a + x.micro, 0) + m.bank.house.abandoned + gross, m.bank.ledger.in);
  i1(m);
});
