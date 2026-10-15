'use strict';
// Paid snake on the sl engine and paid agar.io share ONE shutdown and crash handler and ONE money journal
// (PAID-SL-DESIGN.md 7.1 to 7.4, 11.1 slPaidShutdown; task T5). Real modules throughout: the agar directory (AgArenas on
// its FIXTURE), the paid sl directory and door behind the real slSockets (slPaidFakes paidRig), the real agJournal on a
// temp file, agShutdown's real settle, signal and crash installs, and server/slPaid/slPaidBoot.js composePaidShutdown,
// the composite server/index.js hands to both. The database is an owed store with db.recordOwedOnce's rule (one row per
// key, 'exists' after).
//   - one SIGINT writes the sl AND the agar rows (100%, keyed agowed:<jid>, journaled); agar's settle throwing still
//     writes the sl rows (D1-m2); one SIGINT waits for both games' money in flight
//   - a crash closes every account 'crash' into the journal and moves no money (D1-M4); the next boot owes each row
//     once, and a replay of rows already written answers exists
//   - a kill leaves UNSETTLED-AT-BOOT, with a paid snake's stakeSig
//   - an emergency close (and an orphan refund) whose owed write fails is written once by the next boot's replay; one
//     whose write landed replays as exists (critic C-5)
//   - agar's own emergency closes carry no key, so with 'emergency' and 'orphan' in OWED_WHYS they still replay to zero
//     owed rows, the same summary as before the edit
//   - floor gold at a crash is journaled as one floor record and the next boot books it once (its booked marker in the
//     file first), never twice when the file is kept for a failed owed row; a build that cannot book it keeps the file
//     (review MS-1)
//   - a paid snake cash-out with no payout record is flagged CASHOUT-UNCONFIRMED-AT-BOOT with its wallet, net and
//     cashoutId, never paid blind; agar's cash-out closes are as before (review MS-2)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { AgArenas } = require('../server/ag/agArenas');
const { agShutdownSettle, installAgShutdown, installAgCrashLog, createInflight } = require('../server/ag/agShutdown');
const { createAgJournal } = require('../server/ag/agJournal');
const { composePaidShutdown } = require('../server/slPaid/slPaidBoot');
const { FIXTURE } = require('./agLawsFixture');
const { paidRig, jidLike } = require('./slPaidFakes');

const quiet = () => {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')),
    error: (...a) => lines.push(a.join(' ')) };
};
const KEY_RE = /^agowed:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slpshut-')), 'ag-money-journal.log');
}

function records(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// db.recordOwedOnce's rule: one row per key; failKeys: keys whose write is refused (the database is down)
function owedStore() {
  const rows = new Map();
  const failKeys = new Set();
  return {
    rows,
    failKeys,
    write(r) {
      if (failKeys.has(r.key)) return Promise.reject(new Error('db down'));
      if (rows.has(r.key)) return Promise.resolve('exists');
      rows.set(r.key, Object.assign({}, r));
      return Promise.resolve('owed');
    },
  };
}

// Paid agar: n seated accounts of 500000 micro in its $0.50 room, journaled.
function agarWorld(journal, n) {
  const calls = [];
  const hook = (name) => (x) => { calls.push([name, x]); };
  const arenas = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 5, log: quiet(), paid: true,
    moneyHooks: { onCashout: hook('onCashout'), onRefund: hook('onRefund'), onTransfer: () => {}, onFeed: () => {},
      onBreach: () => {}, onStake: () => {}, onHouse: hook('onHouse'), journal } });
  const room = arenas.seatFor(0.5);
  for (let i = 0; i < n; i++) {
    const s = { id: 'ag' + i, conn: { writeBuffer: [] }, emit() {} };
    room.addPaidHuman(s, { name: 'ag' + i, micro: 500000, wallet: 'W-ag' + i, paid: 0.5 });
    arenas._paidSeated(s, room);
  }
  room.tickOnce();
  return { arenas, room, calls };
}

// Paid sl: the real directory and door on the journal; the server's hooks recorded, onOwed writing to the store (the
// db.recordOwedOnce of server/index.js's slMoneyHooks).
function slWorld(journal, store, opts) {
  const o = opts || {};
  const calls = [];
  const hook = (name) => (x) => { calls.push([name, x]); };
  const hooks = { onCashout: hook('onCashout'), onFloor: hook('onFloor'), onHouse: hook('onHouse'), onBreach: () => {},
    onTransfer: () => {}, journal,
    onOwed: (row) => { calls.push(['onOwed', row]); return store.write(row); } };
  const r = paidRig({ arenas: { moneyHooks: hooks }, door: { journal } });
  return Object.assign(r, { calls, of: (name) => calls.filter((c) => c[0] === name).map((c) => c[1]), wallets: o.wallets });
}

function seat(r, wallets, extra) {
  for (const w of wallets) r.join(r.mint(Object.assign({ walletAddress: w }, extra ? extra(w) : {})));
}

function fakeProc() {
  const p = new EventEmitter();
  p.exitCalls = 0;
  return p;
}

test('one handler for both games: the shutdown writes the sl AND the agar rows, 100%, keyed and journaled', async () => {
  const file = tmpFile();
  const journal = createAgJournal({ file, bootId: 'b1', log: quiet() });
  const store = owedStore();
  const ag = agarWorld(journal, 2);
  const sl = slWorld(journal, store);
  seat(sl, ['W-sl0', 'W-sl1']);
  sl.step(3);
  const label = sl.paid.rooms()[0].lobbyType;
  assert.equal(label, 'sl_na_s0_5');
  const all = composePaidShutdown([ag.arenas, null, sl.paid], quiet());
  let exited = 0;
  const rows = await agShutdownSettle({ arenas: all, writeRow: store.write, exit: () => { exited++; }, log: quiet() });
  assert.equal(exited, 1);
  assert.deepEqual(rows.map((x) => x.wallet).sort(), ['W-ag0', 'W-ag1', 'W-sl0', 'W-sl1']);
  for (const x of rows) {
    assert.equal(x.micro, 500000, 'the whole balance, no rake');
    assert.match(x.key, KEY_RE);
    assert.ok(x.reason.startsWith('refund') && x.reason.endsWith(x.key));
  }
  for (const x of rows.filter((y) => y.wallet.startsWith('W-sl'))) {
    assert.equal(x.reason, 'refund slither shutdown ' + label + ' ' + x.key);
  }
  assert.equal(store.rows.size, 4, 'every row written, once');
  const closes = records(file).filter((x) => x.t === 'close');
  assert.equal(closes.length, 4);
  for (const c of closes) {
    assert.deepEqual([c.outcome, c.why, c.micro], ['refunded', 'shutdown', 500000]);
    assert.ok(store.rows.has(c.key), 'the journal carries the same key');
  }
  assert.deepEqual(closes.filter((c) => c.room === label).length, 2, 'the sl closes are told apart by room');
  assert.equal(sl.paid.stopping, true);
  assert.equal(sl.paid.paidOpen, false);
  assert.equal(ag.arenas.paidOpen, false);
  assert.equal(sl.paid.walletSeat.size, 0);
  assert.deepEqual(sl.of('onOwed'), [], 'the shutdown rows are the caller\'s to write, not the owed hook\'s');
});

test('agar\'s settle throwing still writes the sl rows; an sl throw still writes agar\'s', async () => {
  const file = tmpFile();
  const journal = createAgJournal({ file, bootId: 'b1', log: quiet() });
  const store = owedStore();
  const ag = agarWorld(journal, 1);
  const sl = slWorld(journal, store);
  seat(sl, ['W-sl0', 'W-sl1']);
  sl.step(2);
  ag.arenas.shutdownSettle = () => { throw new Error('agar settle broke'); };
  const lg = quiet();
  const rows = await agShutdownSettle({ arenas: composePaidShutdown([ag.arenas, sl.paid], lg), writeRow: store.write,
    exit: () => {}, log: quiet() });
  assert.deepEqual(rows.map((x) => x.wallet).sort(), ['W-sl0', 'W-sl1']);
  assert.deepEqual(Array.from(store.rows.values()).map((x) => x.wallet).sort(), ['W-sl0', 'W-sl1']);
  assert.ok(lg.lines.some((l) => /SHUTDOWN a paid directory's settle threw/.test(l) && /agar settle broke/.test(l)));
  // the other way round
  const file2 = tmpFile();
  const j2 = createAgJournal({ file: file2, bootId: 'b1', log: quiet() });
  const ag2 = agarWorld(j2, 2);
  const sl2 = slWorld(j2, owedStore());
  seat(sl2, ['W-x']);
  sl2.paid.shutdownSettle = () => { throw new Error('sl settle broke'); };
  const rows2 = composePaidShutdown([ag2.arenas, sl2.paid], quiet()).shutdownSettle('shutdown');
  assert.deepEqual(rows2.map((x) => x.wallet).sort(), ['W-ag0', 'W-ag1']);
});

test('a crash closes every account crash into the journal and moves no money; the boot owes each once, then exists', async () => {
  const file = tmpFile();
  const journal = createAgJournal({ file, bootId: 'b1', log: quiet() });
  const store = owedStore();
  const ag = agarWorld(journal, 1);
  const sl = slWorld(journal, store);
  seat(sl, ['W-sl0', 'W-sl1']);
  sl.step(3);
  const proc = fakeProc();
  const lg = quiet();
  installAgCrashLog({ arenas: composePaidShutdown([ag.arenas, sl.paid], lg), log: lg, proc });
  proc.emit('uncaughtExceptionMonitor', new Error('boom'));
  const closes = records(file).filter((x) => x.t === 'close');
  assert.equal(closes.length, 3);
  for (const c of closes) {
    assert.deepEqual([c.outcome, c.why, c.micro], ['refunded', 'crash', 500000]);
    assert.match(c.key, KEY_RE);
  }
  assert.equal(lg.lines.filter((l) => l.startsWith('[AG] CRASH-OWED')).length, 3);
  // no money moved in the dying process: no payout, no refund, no owed write, no database row
  assert.deepEqual([sl.of('onOwed'), sl.of('onCashout'), sl.of('onFloor'), sl.of('onHouse')], [[], [], [], []]);
  assert.deepEqual(sl.payout.refunds, []);
  assert.deepEqual(sl.ledger.refunds, []);
  assert.deepEqual(ag.calls, []);
  assert.equal(store.rows.size, 0);
  for (const room of sl.paid.rooms()) assert.equal(room.money.bank.totalMicro(), 0, 'every account left the bank once');
  // the next boot: rotated, then replayed once
  const boot = createAgJournal({ file, bootId: 'b2', log: quiet() });
  const waiting = boot.rotate();
  assert.equal(waiting.length, 1);
  const kept = waiting[0] + '.copy';
  fs.copyFileSync(waiting[0], kept);
  const s = await boot.replay({ writeOwedOnce: store.write });
  assert.deepEqual(s, { files: 1, owed: 3, existed: 0, failed: 0, unsettled: 0, unsettledMicro: 0 });
  for (const c of closes) {
    const row = store.rows.get(c.key);
    assert.deepEqual([row.wallet, row.micro, row.reason], [c.wallet, 500000, c.reason]);
  }
  assert.equal((await boot.replay({ writeOwedOnce: store.write })).files, 0, 'a done file is never replayed again');
  // the same journal replayed a second time (a copy put back): every row exists, none is owed twice
  fs.renameSync(kept, waiting[0]);
  const again = await createAgJournal({ file, bootId: 'b3', log: quiet() }).replay({ writeOwedOnce: store.write });
  assert.deepEqual([again.owed, again.existed], [0, 3]);
  assert.equal(store.rows.size, 3);
});

test('a planned restart writes its rows now: the boot replay of the same journal answers exists for each', async () => {
  const file = tmpFile();
  const journal = createAgJournal({ file, bootId: 'b1', log: quiet() });
  const store = owedStore();
  const ag = agarWorld(journal, 1);
  const sl = slWorld(journal, store);
  seat(sl, ['W-sl0']);
  sl.step(2);
  await agShutdownSettle({ arenas: composePaidShutdown([ag.arenas, sl.paid]), writeRow: store.write, exit: () => {},
    log: quiet() });
  assert.equal(store.rows.size, 2);
  const boot = createAgJournal({ file, bootId: 'b2', log: quiet() });
  boot.rotate();
  assert.deepEqual(await boot.replay({ writeOwedOnce: store.write }),
    { files: 1, owed: 0, existed: 2, failed: 0, unsettled: 0, unsettledMicro: 0 });
  assert.equal(store.rows.size, 2);
});

test('a kill leaves UNSETTLED-AT-BOOT, naming a paid snake\'s stakeSig; agar\'s line is as before', async () => {
  const file = tmpFile();
  const journal = createAgJournal({ file, bootId: 'b1', log: quiet() });
  const store = owedStore();
  agarWorld(journal, 1);
  const sl = slWorld(journal, store);
  seat(sl, ['W-dur'], () => ({ stakeSig: 'SIG-DUR' }));
  await sl.settle();
  seat(sl, ['W-dev']);
  sl.step(2);
  assert.equal(sl.paid.humanTotal(), 2);
  const opens = records(file).filter((x) => x.t === 'open');
  assert.ok(opens.filter((x) => x.wallet === 'W-dur').every((x) => x.stakeSig === 'SIG-DUR'), 'the open carries the stakeSig');
  assert.ok(opens.filter((x) => x.wallet !== 'W-dur').every((x) => !('stakeSig' in x)), 'and nothing else does');
  // killed: no settle runs at all
  const lines = [];
  const alerts = [];
  const boot = createAgJournal({ file, bootId: 'b2', log: { log() {}, warn() {}, error: (m) => lines.push(m) } });
  boot.rotate();
  const s = await boot.replay({ writeOwedOnce: store.write, alert: (a) => alerts.push(a) });
  assert.deepEqual([s.owed, s.unsettled, s.unsettledMicro], [0, 3, 1500000]);
  const un = lines.filter((l) => l.startsWith('[AG] UNSETTLED-AT-BOOT'));
  assert.equal(un.length, 3);
  assert.ok(un.some((l) => /^\[AG\] UNSETTLED-AT-BOOT W-dur deposit 500000 micro room sl_na_s0_5 journal [0-9a-f-]{36} stakeSig SIG-DUR \(/.test(l)));
  assert.ok(un.some((l) => /^\[AG\] UNSETTLED-AT-BOOT W-dev deposit 500000 micro room sl_na_s0_5 journal [0-9a-f-]{36} \(the server/.test(l)));
  assert.ok(un.some((l) => /^\[AG\] UNSETTLED-AT-BOOT W-ag0 deposit 500000 micro room ag_na_s0_5 journal [0-9a-f-]{36} \(the server was killed with this paid balance open; pay by hand\)$/.test(l)),
    'agar\'s line is unchanged');
  assert.deepEqual(alerts, [{ kind: 'unsettled-at-boot', accounts: 3, totalMicro: 1500000 }], 'no wallet in the push');
  assert.equal(store.rows.size, 0, 'never paid blind');
});

test('one SIGINT waits for both games\' money in flight, then exits once', async () => {
  const file = tmpFile();
  const journal = createAgJournal({ file, bootId: 'b1', log: quiet() });
  const store = owedStore();
  const ag = agarWorld(journal, 1);
  const sl = slWorld(journal, store);
  seat(sl, ['W-sl0']);
  sl.step(2);
  const inflight = createInflight();
  const done = [];
  inflight.track(new Promise((res) => setTimeout(() => { done.push('agar'); res(); }, 60)));
  inflight.track(new Promise((res) => setTimeout(() => { done.push('sl'); res(); }, 150)));
  const proc = fakeProc();
  let exitedAt = 0;
  const start = Date.now();
  const exited = new Promise((res) => {
    installAgShutdown({ arenas: composePaidShutdown([ag.arenas, sl.paid]), writeRow: store.write, log: quiet(), proc,
      inflight, exit: () => { exitedAt = Date.now(); res(); } });
  });
  proc.emit('SIGINT');
  proc.emit('SIGTERM');
  await exited;
  assert.deepEqual(done, ['agar', 'sl'], 'both games\' money landed first');
  assert.ok(exitedAt - start >= 140 && exitedAt - start < 1200, 'exited after both, ' + (exitedAt - start) + ' ms');
  assert.equal(store.rows.size, 2, 'and both games\' rows were written');
});

test('an emergency close whose owed write fails replays once at the next boot; one whose write landed replays as exists', async () => {
  const file = tmpFile();
  const journal = createAgJournal({ file, bootId: 'b1', log: quiet() });
  const store = owedStore();
  const sl = slWorld(journal, store);
  seat(sl, ['W-e0', 'W-e1']);
  sl.step(3);
  const room = sl.paid.rooms()[0];
  const accts = Array.from(room.money.accounts.values());
  assert.equal(accts.length, 2);
  assert.ok(accts.every((a) => jidLike.test(a.jid)));
  store.failKeys.add('agowed:' + accts[0].jid); // the database refuses this one
  room.emergencyClose();
  await sl.settle();
  const owed = sl.of('onOwed');
  assert.deepEqual(owed.map((x) => [x.wallet, x.micro]).sort(), [['W-e0', 500000], ['W-e1', 500000]], 'one owed row each');
  assert.equal(store.rows.size, 1, 'one landed, one did not');
  const closes = records(file).filter((x) => x.t === 'close' && x.outcome === 'refunded');
  assert.equal(closes.length, 2);
  for (const c of closes) {
    assert.equal(c.why, 'emergency');
    assert.equal(c.key, 'agowed:' + c.jid, 'the close carries the row\'s key (OWED_WHYS has emergency)');
    assert.equal(c.reason, 'refund slither emergency sl_na_s0_5 ' + c.key);
    assert.equal(c.micro, 500000);
  }
  store.failKeys.clear(); // the database is back
  const boot = createAgJournal({ file, bootId: 'b2', log: quiet() });
  boot.rotate();
  assert.deepEqual(await boot.replay({ writeOwedOnce: store.write }),
    { files: 1, owed: 1, existed: 1, failed: 0, unsettled: 0, unsettledMicro: 0 });
  assert.deepEqual(Array.from(store.rows.values()).map((x) => [x.wallet, x.micro]).sort(),
    [['W-e0', 500000], ['W-e1', 500000]], 'each owed exactly once');
});

test('an orphan refund whose owed write fails replays once too', async () => {
  const file = tmpFile();
  const journal = createAgJournal({ file, bootId: 'b1', log: quiet() });
  const store = owedStore();
  const sl = slWorld(journal, store);
  seat(sl, ['W-o']);
  sl.step(2);
  const room = sl.paid.rooms()[0];
  const acct = Array.from(room.money.accounts.values())[0];
  store.failKeys.add('agowed:' + acct.jid);
  room.sim.remove(acct.snakeId); // the snake is gone behind the money's back: I4 refunds it 100% at the end of the step
  sl.step(1);
  await sl.settle();
  assert.equal(room.money.openCount(), 0);
  assert.equal(store.rows.size, 0, 'the write failed');
  const c = records(file).find((x) => x.t === 'close' && x.jid === acct.jid);
  assert.deepEqual([c.outcome, c.why, c.key, c.micro], ['refunded', 'orphan', 'agowed:' + acct.jid, 500000]);
  store.failKeys.clear();
  const boot = createAgJournal({ file, bootId: 'b2', log: quiet() });
  boot.rotate();
  const s = await boot.replay({ writeOwedOnce: store.write });
  assert.deepEqual([s.owed, s.existed, s.unsettled], [1, 0, 0]);
  assert.equal(store.rows.get('agowed:' + acct.jid).reason, 'refund slither orphan sl_na_s0_5 agowed:' + acct.jid);
});

test('agar\'s own emergency closes carry no key: they replay to zero owed rows, as before OWED_WHYS gained two whys', async () => {
  const file = tmpFile();
  const journal = createAgJournal({ file, bootId: 'b1', log: quiet() });
  const ag = agarWorld(journal, 2);
  ag.room.money.emergencySettle();
  const closes = records(file).filter((x) => x.t === 'close');
  assert.equal(closes.length, 2);
  for (const c of closes) {
    assert.deepEqual([c.outcome, c.why], ['refunded', 'emergency']);
    assert.deepEqual(Object.keys(c).sort(), ['at', 'jid', 'outcome', 'room', 't', 'why'], 'the record agar always wrote');
  }
  assert.equal(ag.calls.filter((c) => c[0] === 'onRefund').length, 2, 'agar refunds an emergency at once');
  const store = owedStore();
  const boot = createAgJournal({ file, bootId: 'b2', log: quiet() });
  boot.rotate();
  assert.deepEqual(await boot.replay({ writeOwedOnce: store.write }),
    { files: 1, owed: 0, existed: 0, failed: 0, unsettled: 0, unsettledMicro: 0 });
  assert.equal(store.rows.size, 0);
  // and a hand-made emergency close with no key (agMoney.js emergencySettle's shape) writes no owed fields either
  const j = createAgJournal({ file: tmpFile(), log: quiet() });
  j.open({ jid: 'x', wallet: 'WX', deposit: 500000 }, 'ag_na_s0_5');
  j.close({ jid: 'x', wallet: 'WX' }, 'refunded', { why: 'emergency', refundedMicro: 500000 }, 'ag_na_s0_5');
  const recs = records(j.file);
  assert.deepEqual(Object.keys(recs[0]).sort(), ['at', 'boot', 'jid', 'micro', 'room', 't', 'wallet'], 'no stakeSig on an agar open');
  assert.equal(recs[1].key, undefined);
});

// Review MS-1 (Owen's answer of 2026-10-14: floor gold left at a restart or crash is the house's, booked as slither
// floor income). The settle journals it as one floor record; the next boot books it through bookFloor once per key.
const FLOOR_KEY = 'slfloor:f0000000-0000-4000-8000-000000000001';
function floorRec(over) {
  return Object.assign({ key: FLOOR_KEY, room: 'sl_na_s0_5', why: 'crash', micro: 750000,
    bySource: [{ srcWallet: 'W-f1', srcName: 'f1', micro: 500000 }, { srcWallet: 'W-f2', srcName: 'f2', micro: 250000 }] },
  over);
}

test('a floor record is booked once, after the owed rows of its file landed, marked in the file first; a kept file never books it twice (MS-1)', async () => {
  const file = tmpFile();
  const journal = createAgJournal({ file, bootId: 'b1', log: quiet() });
  // the crash that wrote it, through the real settle: the sl seat's owed close and the floor of a death beside it
  const store = owedStore();
  const sl = slWorld(journal, store);
  seat(sl, ['W-sl0']);
  sl.step(2);
  const room = sl.paid.rooms()[0];
  // the floor, as a death leaves it (slBank split), then the crash settle
  room.money.bank.deposit(99, 750000, { wallet: 'W-dead', name: 'dead', jid: 'd0000000-0000-4000-8000-000000000001' });
  room.money.bank.split(99, [{ id: 1 }, { id: 2 }, { id: 3 }], [250000, 250000, 250000]);
  const proc = fakeProc();
  installAgCrashLog({ arenas: composePaidShutdown([sl.paid], quiet()), log: quiet(), proc });
  proc.emit('uncaughtExceptionMonitor', new Error('boom'));
  const floors = records(file).filter((x) => x.t === 'floor');
  assert.equal(floors.length, 1, 'the crash journaled the floor');
  assert.deepEqual([floors[0].room, floors[0].why, floors[0].micro, floors[0].bySource],
    ['sl_na_s0_5', 'crash', 750000, [{ srcWallet: 'W-dead', srcName: 'dead', micro: 750000 }]]);
  assert.equal(room.money.bank.house.abandoned, 750000);
  assert.deepEqual(sl.of('onFloor'), [], 'nothing booked in the dying process');

  // a second floor record in the same file whose sources do not add up (it can never be booked, so the file stays)
  assert.equal(journal.floor(floorRec({ key: 'slfloor:f0000000-0000-4000-8000-0000000000ff', micro: 750001 })), true);

  // boot 2: the owed write fails (the database is down): no house income from the file either, it waits, kept
  const owedKey = records(file).find((x) => x.t === 'close').key;
  store.failKeys.add(owedKey);
  const booked = [];
  const lg2 = quiet();
  const b2 = createAgJournal({ file, bootId: 'b2', log: lg2 });
  const waiting = b2.rotate();
  const s2 = await b2.replay({ writeOwedOnce: store.write, bookFloor: (r) => booked.push(r) });
  assert.deepEqual(s2, { files: 1, owed: 0, existed: 0, failed: 3, unsettled: 0, unsettledMicro: 0 });
  assert.deepEqual(booked, [], 'nothing booked while a player\'s refund is still owed');
  assert.equal(lg2.lines.filter((l) => /waits for the owed rows of its file/.test(l)).length, 2);
  assert.ok(fs.existsSync(waiting[0]), 'kept for the failed owed row');

  // boot 3: the owed row lands; the crash's floor is booked, its marker written first; the bad record keeps the file
  store.failKeys.clear();
  const s3 = await createAgJournal({ file, bootId: 'b3', log: quiet() }).replay({ writeOwedOnce: store.write,
    bookFloor: (r) => booked.push(r) });
  assert.deepEqual(s3, { files: 1, owed: 1, existed: 0, failed: 1, unsettled: 0, unsettledMicro: 0, floors: 1,
    floorMicro: 750000 });
  assert.deepEqual(booked.map((r) => [r.key, r.micro, r.bySource]), [[floors[0].key, 750000, floors[0].bySource]]);
  assert.deepEqual(records(waiting[0]).filter((x) => x.t === 'booked').map((x) => x.key), [floors[0].key],
    'the booked marker is in the file');
  assert.ok(fs.existsSync(waiting[0]), 'kept for the record that does not add up');

  // boot 4: the same kept file again: the owed row exists, the booked floor is NOT booked a second time
  const s4 = await createAgJournal({ file, bootId: 'b4', log: quiet() }).replay({ writeOwedOnce: store.write,
    bookFloor: (r) => booked.push(r) });
  assert.deepEqual(s4, { files: 1, owed: 0, existed: 1, failed: 1, unsettled: 0, unsettledMicro: 0 });
  assert.equal(booked.length, 1, 'booked once in all');
});

test('a floor record a build cannot book keeps its file: no bookFloor, a marker that will not write, sources that do not add up (MS-1)', async () => {
  const cases = [
    ['no bookFloor', floorRec(), null, /not booked: this build books no paid snake floor; the file is kept/],
    ['the marker refused', floorRec(), 'marker', /floor slfloor:\S+ not booked, its marker could not be written/],
    ['sources off by one', floorRec({ micro: 750001 }), null, /does not add up \(sources 750000\): not booked/],
  ];
  for (const [name, rec, fail, line] of cases) {
    const file = tmpFile();
    const j = createAgJournal({ file, bootId: 'b1', log: quiet() });
    assert.equal(j.floor(rec), true, name + ': written');
    const lg = quiet();
    const fsx = Object.assign({}, fs, {
      appendFileSync(p, d) { if (fail === 'marker' && /\.replay$/.test(p)) throw new Error('read-only'); return fs.appendFileSync(p, d); },
    });
    const b = createAgJournal({ file, bootId: 'b2', log: lg, fsx });
    const waiting = b.rotate();
    const booked = [];
    const s = await b.replay({ writeOwedOnce: () => Promise.resolve('owed'),
      bookFloor: name === 'no bookFloor' ? undefined : (r) => booked.push(r) });
    assert.deepEqual([s.failed, s.floors, booked.length], [1, undefined, 0], name);
    assert.ok(fs.existsSync(waiting[0]), name + ': the file is kept for a build that can book it');
    assert.ok(lg.lines.some((l) => line.test(l)), name + ': ' + lg.lines.join(' | '));
  }
  // a record that is not a floor record is refused at the write
  const j = createAgJournal({ file: tmpFile(), log: quiet() });
  for (const bad of [floorRec({ key: 'agowed:x' }), floorRec({ micro: 0 }), floorRec({ micro: 1.5 }), floorRec({ bySource: null })]) {
    assert.equal(j.floor(bad), false);
  }
  assert.deepEqual(records(j.file), []);
});

// Review MS-2: a paid snake cash-out's close carries its order and a promise of a payout record; one left without it
// (the process died while the payout was in flight) is flagged to Owen with the wallet, net and cashoutId at boot.
test('a cash-out with no payout record is flagged CASHOUT-UNCONFIRMED-AT-BOOT, never paid blind; agar\'s cash-out closes are as before (MS-2)', async () => {
  const file = tmpFile();
  const j = createAgJournal({ file, bootId: 'b1', log: quiet() });
  const CID1 = 'c1000000-0000-4000-8000-000000000001';
  const CID2 = 'c2000000-0000-4000-8000-000000000002';
  const a1 = { jid: 'a1000000-0000-4000-8000-000000000001', wallet: 'W-cash1', deposit: 500000 };
  const a2 = { jid: 'a2000000-0000-4000-8000-000000000002', wallet: 'W-cash2', deposit: 500000 };
  const ag = { jid: 'ag-1', wallet: 'W-ag', deposit: 500000 };
  for (const a of [a1, a2]) j.open(a, 'sl_na_s0_5');
  j.open(ag, 'ag_na_s0_5');
  j.close(a1, 'cashedout', { why: 'cashout', grossMicro: 818180, cutMicro: 81818, netMicro: 736362, cashoutId: CID1,
    awaitPayout: true }, 'sl_na_s0_5');
  j.close(a2, 'cashedout', { why: 'cashout', grossMicro: 500000, cutMicro: 50000, netMicro: 450000, cashoutId: CID2,
    awaitPayout: true }, 'sl_na_s0_5');
  assert.equal(j.payout(a2.jid, CID2, 'sent', 'sl_na_s0_5'), true);
  assert.equal(j.payout(a2.jid, CID2, 'maybe', 'sl_na_s0_5'), false, 'sent or failed only');
  // agar's own cash-out close (agMoney.js: grossMicro and cashoutId, no awaitPayout): the record it always wrote
  j.close(ag, 'cashedout', { grossMicro: 500000, cashoutId: 'ag-cid' }, 'ag_na_s0_5');
  const recs = records(file);
  const c1 = recs.find((x) => x.t === 'close' && x.jid === a1.jid);
  assert.deepEqual([c1.cashoutId, c1.grossMicro, c1.netMicro, c1.awaitPayout], [CID1, 818180, 736362, 1]);
  const cag = recs.find((x) => x.t === 'close' && x.jid === 'ag-1');
  assert.deepEqual(Object.keys(cag).sort(), ['at', 'jid', 'outcome', 'room', 't', 'why'], 'agar\'s close as before');
  const lg = quiet();
  const alerts = [];
  const store = owedStore();
  const b = createAgJournal({ file, bootId: 'b2', log: lg });
  b.rotate();
  const s = await b.replay({ writeOwedOnce: store.write, alert: (x) => alerts.push(x) });
  assert.deepEqual(s, { files: 1, owed: 0, existed: 0, failed: 0, unsettled: 0, unsettledMicro: 0, unconfirmed: 1,
    unconfirmedMicro: 736362 });
  assert.deepEqual(lg.lines.filter((l) => l.startsWith('[AG] CASHOUT-UNCONFIRMED-AT-BOOT')), ['[AG] CASHOUT-UNCONFIRMED-AT-BOOT ' +
    'W-cash1 net 736362 micro gross 818180 cashout ' + CID1 + ' room sl_na_s0_5 journal ' + a1.jid + ' (the server stopped ' +
    'while this payout was in flight; look for the transfer on chain before paying by hand)']);
  assert.deepEqual(alerts, [{ kind: 'cashout-unconfirmed-at-boot', accounts: 1, totalMicro: 736362 }]);
  assert.equal(store.rows.size, 0, 'flagged, never written as owed');
});
