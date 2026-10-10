'use strict';
// Shutdown settle (PAID-AGAR-DESIGN.md 5.9 with Owen Q6 2026-10-08: a restart REFUNDS 100%; checklist step 10): with
// seated confirmed, unconfirmed, dormant and frozen accounts, a fake SIGTERM writes one refund row per account (no
// rake row), logs every row, exits within 1.3 s even when the database hangs, and leaves no account both withdrawn
// and open; with nothing open it exits at once.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { AgArenas } = require('../server/ag/agArenas');
const { agShutdownSettle, installAgShutdown, installAgCrashLog, SHUTDOWN_WRITE_MS } = require('../server/ag/agShutdown');
const { AG_MONEY } = require('../server/ag/agMoney');
const { FIXTURE } = require('./agLawsFixture');

const quietLog = () => {
  const lines = [];
  return { lines, log: () => {}, warn: () => {}, error: (...a) => lines.push(a.join(' ')) };
};
const noop = () => {};

function sock(id) {
  return { id, conn: { writeBuffer: [] }, events: [], emit(ev, p) { this.events.push([ev, p]); } };
}

function arenasWithAccounts() {
  const clock = { t: 9000000 };
  const arenas = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 5, log: quietLog(),
    paid: true, now: () => clock.t,
    moneyHooks: { onCashout: noop, onRefund: noop, onTransfer: noop, onFeed: noop, onBreach: noop, onStake: noop, onHouse: noop } });
  const room = arenas.seatFor(0.5);
  const seat = (name, micro) => {
    const s = sock(name);
    const acct = room.addPaidHuman(s, { name, micro, wallet: 'W-' + name, paid: micro / 1e6 });
    arenas._paidSeated(s, room);
    return { s, acct };
  };
  const live = seat('live', 500000);
  const away = seat('away', 500000);
  const frozen = seat('frozen', 500000);
  room.tickOnce();
  room.ready(live.s.id);
  room.ready(away.s.id);
  room.ready(frozen.s.id);
  // live wins money from no one here; away goes dormant; frozen loses its cells (a bug)
  arenas.disconnect(away.s.id);
  clock.t += AG_MONEY.DISCONNECT_GRACE_MS.value;
  room.sim.clearCells(frozen.acct.pid);
  room.tickOnce();
  const unconf = seat('unconf', 500000);   // opened after the clock moved, so its 5 s ready window is still open
  room.tickOnce();
  assert.strictEqual(away.acct.state, 'dormant');
  assert.strictEqual(frozen.acct.state, 'frozen');
  assert.strictEqual(unconf.acct.state, 'unconfirmed');
  return { arenas, room, live, unconf, away, frozen };
}

test('one refund row per open account (live, unconfirmed, dormant, frozen), 100%, no rake, every row logged', async () => {
  const w = arenasWithAccounts();
  const rows = [];
  const lg = quietLog();
  let exited = 0;
  const got = await agShutdownSettle({ arenas: w.arenas, writeRow: (r) => { rows.push(r); return Promise.resolve(); },
    exit: () => { exited++; }, log: lg });
  assert.strictEqual(exited, 1);
  assert.strictEqual(got.length, 4);
  assert.deepStrictEqual(rows.map((r) => r.wallet).sort(), ['W-away', 'W-frozen', 'W-live', 'W-unconf']);
  for (const r of rows) {
    assert.strictEqual(r.micro, 500000, 'the whole balance');
    assert.match(r.key, /^agowed:[0-9a-f-]{36}$/, 'a unique key per row (db.recordOwedOnce)');
    assert.strictEqual(r.reason, 'refund agar shutdown ' + w.room.lobbyType + ' ' + r.key);
    assert.ok(r.reason.startsWith('refund'), 'never booked as winnings');
  }
  assert.ok(!rows.some((r) => /rake/.test(r.reason)), 'no rake row on a restart (Owen Q6)');
  assert.strictEqual(lg.lines.filter((l) => l.startsWith('[AG] SHUTDOWN-OWED')).length, 4);
  assert.strictEqual(w.room.money.openCount(), 0, 'no account is both withdrawn and open');
  assert.strictEqual(w.room.money.bank.totalMicro(), 0);
  assert.strictEqual(new Set(rows.map((r) => r.key)).size, 4, 'keys never repeat');
  assert.strictEqual(w.room.money.bank.ledger.outMicro, 2000000);
  assert.strictEqual(w.arenas.paidOpen, false, 'the door is closed');
  assert.strictEqual(w.room.stopped, true);
});

test('a hanging database cannot hold the exit past SHUTDOWN_WRITE_MS', async () => {
  const w = arenasWithAccounts();
  let exitedAt = 0;
  const start = Date.now();
  await agShutdownSettle({ arenas: w.arenas, writeRow: () => new Promise(() => {}), exit: () => { exitedAt = Date.now(); },
    log: quietLog(), waitMs: 200 });
  assert.ok(exitedAt - start < 1300 && exitedAt - start >= 150, 'exited after the wait, ' + (exitedAt - start) + ' ms');
  assert.ok(SHUTDOWN_WRITE_MS <= 1300, 'the real wait fits inside pm2\'s 1.6 s kill timeout');
  // a write that throws is logged and the exit still comes
  const w2 = arenasWithAccounts();
  const lg = quietLog();
  let exited = false;
  await agShutdownSettle({ arenas: w2.arenas, writeRow: () => { throw new Error('db gone'); }, exit: () => { exited = true; }, log: lg, waitMs: 200 });
  assert.ok(exited);
  assert.ok(lg.lines.some((l) => /SHUTDOWN-OWED write failed/.test(l)));
});

test('with nothing open the exit is immediate; with no arenas too', async () => {
  const arenas = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 5, log: quietLog(), paid: true,
    moneyHooks: { onCashout: noop, onRefund: noop, onTransfer: noop, onFeed: noop, onBreach: noop, onStake: noop, onHouse: noop } });
  let exited = 0;
  let wrote = 0;
  await agShutdownSettle({ arenas, writeRow: () => { wrote++; }, exit: () => { exited++; }, log: quietLog() });
  await agShutdownSettle({ arenas: null, writeRow: () => { wrote++; }, exit: () => { exited++; }, log: quietLog() });
  assert.deepStrictEqual([exited, wrote], [2, 0]);
});

test('installAgShutdown: SIGINT or SIGTERM settles once and exits', async () => {
  const w = arenasWithAccounts();
  const proc = new EventEmitter();
  const rows = [];
  let exits = 0;
  installAgShutdown({ arenas: w.arenas, writeRow: (r) => { rows.push(r); return Promise.resolve(); }, log: quietLog(), proc,
    exit: () => { exits++; } });
  proc.emit('SIGTERM');
  proc.emit('SIGINT');
  await new Promise((res) => setTimeout(res, 20));
  assert.strictEqual(rows.length, 4);
  assert.strictEqual(exits, 1, 'once');
});

test('a hard crash logs every open balance as a CRASH-OWED line before Node exits, unless a handler keeps it alive', () => {
  const w = arenasWithAccounts();
  const proc = new EventEmitter();
  const lg = quietLog();
  installAgCrashLog({ arenas: w.arenas, log: lg, proc });
  proc.emit('uncaughtExceptionMonitor', new Error('boom'));
  const owed = lg.lines.filter((l) => l.startsWith('[AG] CRASH-OWED'));
  assert.strictEqual(owed.length, 4);
  assert.ok(owed.every((l) => / 500000 micro refund agar crash /.test(l)), owed.join(String.fromCharCode(10)));
  assert.strictEqual(w.room.money.openCount(), 0);
  // with an uncaughtException handler (the process would live on) nothing is touched
  const w2 = arenasWithAccounts();
  const proc2 = new EventEmitter();
  proc2.on('uncaughtException', () => {});
  const lg2 = quietLog();
  installAgCrashLog({ arenas: w2.arenas, log: lg2, proc: proc2 });
  proc2.emit('uncaughtExceptionMonitor', new Error('caught'));
  assert.strictEqual(w2.room.money.openCount(), 4);
  assert.deepStrictEqual(lg2.lines, []);
});
