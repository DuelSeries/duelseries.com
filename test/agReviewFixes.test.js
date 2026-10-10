'use strict';
// The server-money review fixes (paid agar.io, commit after 2a1ee99): the money journal (a crash's refunds reach the
// database at the next boot exactly once; a killed process's open balances are flagged), the shutdown never ends the
// process early (it waits for money in flight, and leaves the exit to pm2 when someone else listens), the door
// refuses before it spends a token once the server is going down and refunds once on any throw after it spent one,
// the spawn is checked again at ready (no spawn camping), every unconfirmed exit splits the same way, a wallet stuck
// in a settling room can still play, and the owner alert pages again after its window.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { AgArenas } = require('../server/ag/agArenas');
const { createAgPaidDoor } = require('../server/ag/agPaidDoor');
const { createAgJournal } = require('../server/ag/agJournal');
const { agShutdownSettle, installAgShutdown, installAgCrashLog, createInflight } = require('../server/ag/agShutdown');
const { createAgOwnerAlert } = require('../server/ag/agAlert');
const { AG_MONEY } = require('../server/ag/agMoney');
const { FIXTURE } = require('./agLawsFixture');

const quiet = { error() {}, warn() {}, log() {} };
const tick = () => new Promise((res) => setImmediate(res));
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agjournal-'));
  return path.join(dir, 'ag-money-journal.log');
}

function hooksRec(extra) {
  const calls = { cashout: [], refund: [], transfer: [], feed: [], breach: [], stake: [], house: [] };
  return {
    calls,
    hooks: Object.assign({
      onCashout: (o) => calls.cashout.push(o), onRefund: (o) => calls.refund.push(o),
      onTransfer: (t) => calls.transfer.push(t), onFeed: (f) => calls.feed.push(f),
      onBreach: (b) => calls.breach.push(b), onStake: (s) => calls.stake.push(s), onHouse: (h) => calls.house.push(h),
    }, extra || {}),
  };
}

let sn = 0;
function sock(id) {
  return {
    id: id || 'rf' + ++sn, conn: { writeBuffer: [] }, events: [], disconnected: false,
    handshake: { auth: {}, headers: {}, address: '1.1.1.1' },
    emit(ev, p) { this.events.push([ev, p]); },
    of(ev) { return this.events.filter((e) => e[0] === ev).map((e) => e[1]); },
    last(ev) { const l = this.of(ev); return l[l.length - 1]; },
  };
}

function world(opts) {
  const o = opts || {};
  const clock = { t: 9000000 };
  const rec = hooksRec(o.journal ? { journal: o.journal } : null);
  const arenas = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: o.seed || 5, log: quiet,
    paid: true, now: () => clock.t, moneyHooks: rec.hooks });
  const room = arenas.seatFor(0.5);
  const seat = (name, micro, paid) => {
    const s = sock(name + '-' + ++sn);
    const acct = room.addPaidHuman(s, { name, micro: micro || 500000, wallet: 'W-' + name,
      paid: paid === undefined ? (micro || 500000) / 1e6 : paid });
    arenas._paidSeated(s, room);
    return { s, acct, pid: acct.pid };
  };
  return { clock, arenas, room, seat, calls: rec.calls };
}

// A keyed owed-row store like db.recordOwedOnce: one row per key.
function owedStore() {
  const rows = new Map();
  return {
    rows,
    write: (r) => {
      if (rows.has(r.key)) return Promise.resolve('exists');
      rows.set(r.key, Object.assign({}, r));
      return Promise.resolve('owed');
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The journal.

test('journal: shutdown and crash closes replay as owed rows once, a kill leaves UNSETTLED flags, the file is done', async () => {
  const file = tmpFile();
  let t = 1000;
  const j = createAgJournal({ file, bootId: 'b1', log: quiet, now: () => t++ });
  const acct = (jid, wallet, deposit) => ({ jid, wallet, deposit, name: 'n' + jid });
  const key = (x) => 'agowed:' + x;
  j.open(acct('a', 'WA', 500000), 'r1');
  j.close(acct('a', 'WA', 500000), 'cashedout', { grossMicro: 150000 }, 'r1');
  j.open(acct('b', 'WB', 500000), 'r1');
  j.close(acct('b', 'WB', 500000), 'refunded', { why: 'shutdown', refundedMicro: 120000, key: key('b'),
    reason: 'refund agar shutdown r1 ' + key('b') }, 'r1');
  j.open(acct('c', 'WC', 1000000), 'r2');                       // killed: never closed
  j.open(acct('d', 'WD', 500000), 'r1');
  j.close(acct('d', 'WD', 500000), 'refunded', { why: 'crash', refundedMicro: 80000, key: key('d'),
    reason: 'refund agar crash r1 ' + key('d') }, 'r1');
  j.open(acct('e', 'WE', 500000), 'r1');
  j.close(acct('e', 'WE', 500000), 'refunded', { why: 'emergency', refundedMicro: 500000 }, 'r1');   // paid at once
  fs.appendFileSync(file, '{"t":"open","jid":"half');           // a line the kill cut in half

  const next = createAgJournal({ file, bootId: 'b2', log: quiet });
  const waiting = next.rotate();
  assert.strictEqual(waiting.length, 1, 'the old file is moved aside before anything opens');
  assert.ok(!fs.existsSync(file), 'this boot starts a fresh file');
  const store = owedStore();
  store.rows.set(key('b'), { key: key('b') });                   // the dying process wrote this one
  const alerts = [];
  const s = await next.replay({ writeOwedOnce: store.write, alert: (a) => alerts.push(a) });
  assert.deepStrictEqual(s, { files: 1, owed: 1, existed: 1, failed: 0, unsettled: 1, unsettledMicro: 1000000 });
  const d = store.rows.get(key('d'));
  assert.deepStrictEqual([d.wallet, d.micro, d.reason], ['WD', 80000, 'refund agar crash r1 ' + key('d')]);
  assert.ok(!store.rows.has('agowed:e'), 'an emergency refund was paid at once, never replayed');
  assert.deepStrictEqual(alerts, [{ kind: 'unsettled-at-boot', accounts: 1, totalMicro: 1000000 }], 'no wallet in the push');
  assert.deepStrictEqual(next.replayFiles(), [], 'marked done');
  assert.ok(fs.readdirSync(path.dirname(file)).some((n) => n.endsWith('.done')), 'kept for Owen');
  const again = await next.replay({ writeOwedOnce: store.write });
  assert.strictEqual(again.files, 0, 'a done file is never replayed again');
});

test('journal: a database that is down keeps the file for the next boot, which writes the row once', async () => {
  const file = tmpFile();
  const j = createAgJournal({ file, bootId: 'b1', log: quiet });
  const a = { jid: 'x', wallet: 'WX', deposit: 500000, name: 'x' };
  j.open(a, 'r');
  j.close(a, 'refunded', { why: 'crash', refundedMicro: 500000, key: 'agowed:x', reason: 'refund agar crash r agowed:x' }, 'r');
  const b2 = createAgJournal({ file, bootId: 'b2', log: quiet });
  b2.rotate();
  const down = await b2.replay({ writeOwedOnce: () => Promise.reject(new Error('db down')) });
  assert.strictEqual(down.failed, 1);
  assert.strictEqual(b2.replayFiles().length, 1, 'kept');
  const store = owedStore();
  const b3 = createAgJournal({ file, bootId: 'b3', log: quiet });
  b3.rotate();
  const up = await b3.replay({ writeOwedOnce: store.write });
  assert.deepStrictEqual([up.owed, up.failed, store.rows.size], [1, 0, 1]);
  assert.strictEqual(b3.replayFiles().length, 0);
});

test('journal: a write that fails never throws into the money path', () => {
  const lines = [];
  const j = createAgJournal({ file: path.join(os.tmpdir(), 'nope', 'x.log'), log: { error: (m) => lines.push(m) },
    fsx: { mkdirSync() {}, appendFileSync() { throw new Error('disk full'); } } });
  assert.strictEqual(j.open({ jid: 'q', wallet: 'W', deposit: 1 }, 'r'), false);
  assert.strictEqual(j.close({ jid: 'q', wallet: 'W', deposit: 1 }, 'eaten', {}, 'r'), false);
  assert.strictEqual(lines.length, 1, 'logged once');
});

// ---------------------------------------------------------------------------------------------------------------
// Crash, restart and kill, end to end through a real paid room.

function seatedWorld(journal) {
  const w = world({ journal });
  const a = w.seat('a');
  const b = w.seat('b');
  w.room.tickOnce();
  w.room.ready(a.s.id);
  w.room.ready(b.s.id);
  w.room.tickOnce();
  const c = w.seat('c');   // unconfirmed
  w.room.tickOnce();
  return Object.assign(w, { a, b, c });
}

test('a hard crash journals every open balance; the next boot owes each once at 100%, even replayed twice', async () => {
  const file = tmpFile();
  const j = createAgJournal({ file, bootId: 'b1', log: quiet });
  const w = seatedWorld(j);
  const proc = new EventEmitter();
  installAgCrashLog({ arenas: w.arenas, log: quiet, proc });
  proc.emit('uncaughtExceptionMonitor', new Error('boom'));
  assert.strictEqual(w.room.money.openCount(), 0);
  assert.strictEqual(w.a.s.last('ag:closed').why, 'crash', 'the page is not told the server restarted');

  const store = owedStore();
  const boot = createAgJournal({ file, bootId: 'b2', log: quiet });
  boot.rotate();
  const s = await boot.replay({ writeOwedOnce: store.write });
  assert.deepStrictEqual([s.owed, s.unsettled], [3, 0]);
  const rows = Array.from(store.rows.values());
  assert.deepStrictEqual(rows.map((r) => r.micro), [500000, 500000, 500000], '100%, no rake (Owen Q6)');
  assert.ok(rows.every((r) => r.reason.startsWith('refund agar crash ') && r.reason.endsWith(r.key)));
  assert.deepStrictEqual(rows.map((r) => r.wallet).sort(), ['W-a', 'W-b', 'W-c']);
  assert.strictEqual(w.room.money.bank.ledger.outMicro, 1500000, 'what left the bank is exactly what is owed');
});

test('a planned restart writes its rows now, and the boot replay of the same journal owes nothing twice', async () => {
  const file = tmpFile();
  const j = createAgJournal({ file, bootId: 'b1', log: quiet });
  const w = seatedWorld(j);
  const store = owedStore();
  const rows = await agShutdownSettle({ arenas: w.arenas, writeRow: store.write, log: quiet, exit: null });
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(store.rows.size, 3);
  const boot = createAgJournal({ file, bootId: 'b2', log: quiet });
  boot.rotate();
  const s = await boot.replay({ writeOwedOnce: store.write });
  assert.deepStrictEqual([s.owed, s.existed, store.rows.size], [0, 3, 3]);
});

test('a kill that runs no code leaves the accounts open in the journal: the next boot flags each UNSETTLED', async () => {
  const file = tmpFile();
  const j = createAgJournal({ file, bootId: 'b1', log: quiet });
  seatedWorld(j);   // then SIGKILL: nothing settles
  const lines = [];
  const boot = createAgJournal({ file, bootId: 'b2', log: { error: (m) => lines.push(m), warn() {}, log() {} } });
  boot.rotate();
  const alerts = [];
  const s = await boot.replay({ writeOwedOnce: () => Promise.resolve('owed'), alert: (a) => alerts.push(a) });
  assert.deepStrictEqual([s.unsettled, s.unsettledMicro, s.owed], [3, 1500000, 0], 'flagged, never paid blind');
  assert.strictEqual(lines.filter((l) => l.startsWith('[AG] UNSETTLED-AT-BOOT W-')).length, 3, 'wallets in the log only');
  assert.deepStrictEqual(alerts, [{ kind: 'unsettled-at-boot', accounts: 3, totalMicro: 1500000 }]);
});

// ---------------------------------------------------------------------------------------------------------------
// When the process ends.

test('the signal never ends the process while another listener keeps it alive (production: the leaderboard)', async () => {
  const w = seatedWorld(null);
  const proc = new EventEmitter();
  proc.on('SIGINT', () => {});   // the leaderboard's flush, which never exits
  let exits = 0;
  const store = owedStore();
  installAgShutdown({ arenas: w.arenas, writeRow: store.write, log: quiet, proc, exit: () => { exits++; } });
  proc.emit('SIGINT');
  await sleep(30);
  assert.strictEqual(store.rows.size, 3, 'the rows are written');
  assert.strictEqual(exits, 0, 'pm2 ends the process at its kill timeout, as before this handler existed');
});

test('with nothing open and nothing in flight the exit is at once; money in flight is waited for, chained too', async () => {
  // nothing at all: at once (Node's own default when nobody listens)
  const empty = world();
  let exits = 0;
  await agShutdownSettle({ arenas: empty.arenas, writeRow: () => {}, exit: () => { exits++; }, log: quiet });
  assert.strictEqual(exits, 1);
  // a payout in flight that starts a refund when it lands: both are waited for
  const inflight = createInflight();
  const order = [];
  inflight.track(sleep(40).then(() => {
    order.push('payout');
    inflight.track(sleep(40).then(() => order.push('refund')));
  }));
  const start = Date.now();
  await agShutdownSettle({ arenas: empty.arenas, writeRow: () => {}, inflight, log: quiet, waitMs: 1000,
    exit: () => order.push('exit') });
  assert.deepStrictEqual(order, ['payout', 'refund', 'exit']);
  assert.ok(Date.now() - start >= 70, 'it waited');
  // a payout that hangs cannot hold the exit past the window
  const stuck = createInflight();
  stuck.track(new Promise(() => {}));
  const t0 = Date.now();
  let at = 0;
  await agShutdownSettle({ arenas: empty.arenas, writeRow: () => {}, inflight: stuck, log: quiet, waitMs: 120,
    exit: () => { at = Date.now(); } });
  assert.ok(at - t0 >= 100 && at - t0 < 1000, 'bounded: ' + (at - t0) + ' ms');
});

// ---------------------------------------------------------------------------------------------------------------
// The door.

function tokenStore() {
  const tokens = new Map();
  let n = 0;
  return {
    mint(o) {
      const t = 'tok-' + ++n + '-' + Math.random().toString(16).slice(2, 10);
      tokens.set(t, Object.assign({ stake: 0.5, worth: 0.5, paid: 0.5, walletAddress: 'W1' }, o));
      return t;
    },
    consumeAtStake(token, stake) {
      const r = tokens.get(token);
      if (!r || Math.abs(r.stake - stake) > 1e-9) return { ok: false, worth: 0 };
      tokens.delete(token);
      return Object.assign({ ok: true, restore: () => tokens.set(token, r) }, r);
    },
    has: (t) => tokens.has(t),
  };
}

function doorWorld(ledgerAnswer) {
  const w = world();
  const store = tokenStore();
  const refunds = [];
  const ledgerRefunds = [];
  const tracked = [];
  let release = null;
  const ledger = {
    claimSeat: () => (ledgerAnswer === 'later' ? new Promise((res) => { release = () => res('ok'); }) : Promise.resolve('ok')),
    refund: (sig, reason, claimKey) => { ledgerRefunds.push({ sig, reason, claimKey }); return Promise.resolve('owed'); },
  };
  const door = createAgPaidDoor({ arenas: w.arenas, consumeAtStake: (t, s) => store.consumeAtStake(t, s), ledger,
    refund: (x) => { refunds.push(x); return Promise.resolve(); }, cleanName: (x) => String(x || ''), log: quiet,
    now: () => w.clock.t, track: (p) => { tracked.push(p); return p; } });
  const join = (s, msg) => {
    w.clock.t += 1000;
    door.join(s, Object.assign({ stake: 0.5, name: 'n' }, msg));
  };
  return Object.assign(w, { store, refunds, ledgerRefunds, tracked, door, join, release: () => release() });
}

test('going down: the door refuses before it spends a token, so the boot sweep refunds the pending stake', () => {
  const d = doorWorld();
  d.arenas.shutdownSettle();
  const s = sock();
  const token = d.store.mint({ walletAddress: 'WS' });
  d.join(s, { entryToken: token });
  assert.strictEqual(s.last('ag:refused').why, 'restarting');
  assert.ok(d.store.has(token), 'the token was never consumed');
  assert.deepStrictEqual([d.refunds.length, d.ledgerRefunds.length], [0, 0]);
});

test('a durable claim that lands while going down is refunded through its stake row, and the shutdown can wait on it', async () => {
  const d = doorWorld('later');
  const s = sock();
  d.join(s, { entryToken: d.store.mint({ walletAddress: 'WD', stakeSig: 'SIG1', claimKey: 'CK1' }) });
  assert.strictEqual(d.tracked.length, 1, 'the claim is tracked');
  await tick();   // the claim starts in a microtask
  d.arenas.shutdownSettle();
  d.release();
  await tick();
  await tick();
  assert.deepStrictEqual(d.ledgerRefunds, [{ sig: 'SIG1', reason: 'refund agar not-open', claimKey: 'CK1' }]);
  assert.strictEqual(d.tracked.length, 2, 'its refund is tracked too');
});

test('a throw after the token is spent refunds exactly once (room build, wallet lookup, resume); after the seat, never', async () => {
  const cases = [
    ['seatFor', (d) => { d.arenas.seatFor = () => { throw new Error('room build'); }; }],
    ['walletSeatOf', (d) => { d.arenas.walletSeatOf = () => { throw new Error('lookup'); }; }],
    ['releaseCooldown', (d) => { d.arenas.releaseCooldown = () => { throw new Error('cooldown'); }; }],
  ];
  for (const [name, breakIt] of cases) {
    const d = doorWorld();
    breakIt(d);
    const s = sock();
    d.join(s, { entryToken: d.store.mint({ walletAddress: 'W-' + name }) });
    assert.strictEqual(d.refunds.length, 1, name + ': refunded');
    assert.strictEqual(d.refunds[0].why, 'seat-failed', name);
    assert.deepStrictEqual(s.last('ag:refused'), { why: 'seat-failed', text: d.door.TEXT['seat-failed'], refunded: true });
  }
  // durable path: the claim's .catch used to swallow it
  const dd = doorWorld();
  dd.arenas.seatFor = () => { throw new Error('room build'); };
  dd.join(sock(), { entryToken: dd.store.mint({ walletAddress: 'WDUR', stakeSig: 'S2', claimKey: 'K2' }) });
  await tick();
  await tick();
  assert.deepStrictEqual(dd.ledgerRefunds, [{ sig: 'S2', reason: 'refund agar seat-failed', claimKey: 'K2' }]);
  // reattach: the resume throws before this token's refund
  const dr = doorWorld();
  const first = sock();
  dr.join(first, { entryToken: dr.store.mint({ walletAddress: 'WR' }) });
  const room = dr.arenas.paidRoomOf(first.id);
  room.resumePaid = () => { throw new Error('resume'); };
  dr.join(sock(), { entryToken: dr.store.mint({ walletAddress: 'WR' }) });
  assert.deepStrictEqual(dr.refunds.map((r) => r.why), ['seat-failed'], 'once');
  // after the seat holds the money a throw refunds nothing (the money is in the bank)
  const da = doorWorld();
  da.arenas._paidSeated = () => { throw new Error('directory'); };
  const late = sock();
  da.join(late, { entryToken: da.store.mint({ walletAddress: 'WLATE' }) });
  assert.strictEqual(da.refunds.length, 0, 'never refunded on top of a seat');
  assert.strictEqual(da.room.money.openCount(), 1);
});

// ---------------------------------------------------------------------------------------------------------------
// Spawn camping.

function cellOf(room, pid) {
  return room.sim.getCell(room.sim.playerInfo(pid).cells[0]);
}

test('a cell parked on a shielded newcomer does not get it: ready moves it to a clear spot first', () => {
  const w = world();
  const giant = w.seat('giant');
  w.room.tickOnce();
  w.room.ready(giant.s.id);
  const n = w.seat('new');
  w.room.tickOnce();
  const nc = cellOf(w.room, n.pid);
  // the giant parks a big cell on the newcomer while the shield is up
  w.room.sim.debugPlace({ kind: 'player', owner: giant.pid, x: nc.x, y: nc.y, size: 400 });
  w.room.target(giant.s.id, nc.x, nc.y);
  for (let i = 0; i < 20; i++) w.room.tickOnce();
  assert.strictEqual(n.acct.state, 'unconfirmed', 'still shielded');
  assert.strictEqual(w.room.sim.spawnClearOf(n.pid, AG_MONEY.SPAWN_CLEAR.value), false, 'the spot is camped');
  const before = { x: nc.x, y: nc.y };
  assert.strictEqual(w.room.ready(n.s.id), true);
  const moved = cellOf(w.room, n.pid);
  assert.ok(Math.hypot(moved.x - before.x, moved.y - before.y) > 400, 'moved away');
  assert.strictEqual(w.room.sim.spawnClearOf(n.pid, AG_MONEY.SPAWN_CLEAR.value), true);
  assert.strictEqual(n.acct.state, 'live');
  for (let i = 0; i < 10; i++) w.room.tickOnce();
  assert.ok(w.room.money.account(n.pid), 'not eaten');
  assert.strictEqual(w.room.money.balance(n.pid), 500000);
});

test('with no clear spot anywhere the ready waits; a spot that appears lets it start; none by the deadline refunds no-room', () => {
  const w = world();
  const n = w.seat('new');
  w.room.tickOnce();
  const real = w.room.sim.spawnClearOf;
  w.room.sim.spawnClearOf = () => false;   // every spot camped
  const realFind = w.room.sim.findSpawnPoint;
  w.room.sim.findSpawnPoint = () => null;
  assert.strictEqual(w.room.ready(n.s.id), false);
  w.room.tickOnce();
  assert.strictEqual(n.acct.state, 'unconfirmed');
  assert.ok(w.room.money.shielded.has(n.pid), 'still shielded while it waits');
  w.room.sim.spawnClearOf = real;
  w.room.sim.findSpawnPoint = realFind;
  w.room.tickOnce();
  assert.strictEqual(n.acct.state, 'live', 'started once a spot was clear, without a second ready');

  const w2 = world();
  const m = w2.seat('m');
  w2.room.tickOnce();
  w2.room.sim.spawnClearOf = () => false;
  w2.room.sim.findSpawnPoint = () => null;
  w2.room.ready(m.s.id);
  w2.clock.t += AG_MONEY.JOIN_CONFIRM_MS.value;
  w2.room.tickOnce();
  assert.strictEqual(w2.room.money.account(m.pid), null);
  assert.deepStrictEqual(w2.calls.refund.map((r) => [r.why, r.micro]), [['no-room', 500000]]);
});

// ---------------------------------------------------------------------------------------------------------------
// Unconfirmed exits split the same way everywhere.

test('an unconfirmed balance above its deposit goes to the house with an alert on every path; never-landed money is not booked', () => {
  for (const pathName of ['release', 'emergency', 'shutdown']) {
    const w = world();
    const a = w.seat('a');
    w.room.tickOnce();
    w.room.ready(a.s.id);
    const n = w.seat('n', 500000, 0.475);   // SOL mode: 475000 landed
    w.room.tickOnce();
    // a bug moves 25000 into the shielded seat
    w.room.money.bank.transferShare(a.pid, n.pid, 1, 20, false, a.acct.life);
    assert.strictEqual(w.room.money.balance(n.pid), 525000);
    let rows = [];
    if (pathName === 'release') w.room.money.release(n.pid, 'join-lost');
    else if (pathName === 'emergency') w.room.money.emergencySettle();
    else rows = w.room.money.shutdownSettle();
    const back = pathName === 'shutdown' ? rows.find((r) => r.wallet === 'W-n').micro
      : w.calls.refund.find((r) => r.wallet === 'W-n').micro;
    assert.strictEqual(back, 475000, pathName + ': what landed, never more');
    const house = w.calls.house.filter((h) => h.wallet === 'W-n');
    assert.deepStrictEqual(house.map((h) => h.micro), [25000], pathName + ': the excess to the house');
    assert.ok(w.calls.breach.some((b) => /-extra$/.test(b.kind) && b.micro === 25000), pathName + ': alerted');
  }
});

// ---------------------------------------------------------------------------------------------------------------
// A wallet stuck in a settling room.

test('a wallet whose account is stuck open in a settling room is seated again, not refused', () => {
  const d = doorWorld();
  const first = sock();
  d.join(first, { entryToken: d.store.mint({ walletAddress: 'WSTUCK' }) });
  const oldRoom = d.arenas.paidRoomOf(first.id);
  const acct = oldRoom.money.account(oldRoom.seatOf(first.id).pid);
  const realWithdraw = oldRoom.money.bank.withdraw.bind(oldRoom.money.bank);
  oldRoom.money.bank.withdraw = (pid) => { if (pid === acct.pid) throw new Error('stuck'); return realWithdraw(pid); };
  oldRoom.emergencyClose();
  assert.ok(oldRoom.money.account(acct.pid), 'left open');
  assert.ok(d.arenas.settling.includes(oldRoom));
  // the same wallet buys in again
  const again = sock();
  d.join(again, { entryToken: d.store.mint({ walletAddress: 'WSTUCK' }) });
  assert.ok(again.last('ag:joined'), 'seated: ' + JSON.stringify(again.last('ag:refused')));
  assert.notStrictEqual(d.arenas.paidRoomOf(again.id), oldRoom);
  // and a walletSeat entry still naming the stopped room does not block a seat either (the door and the directory agree)
  d.arenas.walletSeat.set('WSTUCK2', { room: oldRoom, pid: acct.pid });
  const third = sock();
  d.join(third, { entryToken: d.store.mint({ walletAddress: 'WSTUCK2' }) });
  assert.ok(third.last('ag:joined'));
  // the stuck account settles later and does not free the new seat
  oldRoom.money.bank.withdraw = realWithdraw;
  d.arenas.sweep(d.clock.t);
  assert.strictEqual(oldRoom.money.account(acct.pid), null);
  assert.strictEqual(d.arenas.walletSeatOf('WSTUCK').room, d.arenas.paidRoomOf(again.id));
});

// ---------------------------------------------------------------------------------------------------------------
// The owner alert.

test('owner alert: one page per room and kind per window, the next one counts the ones held back; never a wallet', () => {
  let t = 0;
  const pushes = [];
  const alert = createAgOwnerAlert({ push: (text, safe) => pushes.push(safe), log: quiet, now: () => t, windowMs: 1000 });
  assert.strictEqual(alert({ kind: 'zombie', lobbyType: 'r1', micro: 5, wallet: 'SECRET' }), true);
  alert({ kind: 'zombie', lobbyType: 'r1' });
  alert({ kind: 'zombie', lobbyType: 'r1' });
  alert({ kind: 'zombie', lobbyType: 'r2' });
  t = 1500;
  alert({ kind: 'zombie', lobbyType: 'r1' });
  assert.deepStrictEqual(pushes, [
    { kind: 'zombie', lobbyType: 'r1', micro: 5 },
    { kind: 'zombie', lobbyType: 'r2' },
    { kind: 'zombie', lobbyType: 'r1', repeats: 2 },
  ]);
  assert.ok(!JSON.stringify(pushes).includes('SECRET'));
});
