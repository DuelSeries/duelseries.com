'use strict';
// Opening paid snake on the sl engine at boot (server/slPaid/slPaidBoot.js; PAID-SL-DESIGN.md 2, 6 and 10; task T5),
// without booting the server (test/slPaidJoinSmoke.test.js does that). The real free SlArenas and slSockets (slSockFakes
// rig), a real entry store, the real paid directory and door:
//   - SL_PAID: ON by default since the switch-on commit (T9), agar's parser (a typo fails closed and says so)
//   - no sockets (SL_ENABLED off or refused): nothing is built and nothing attached (critic C-4)
//   - on (unset too): the rungs and the door, attached; off: no rungs, and a paid page is refunded not-open once,
//     never seated free
//   - the rungs fail to build: the off directory; the door fails to build: a helper that refuses not-open with the token
//     untouched (its expiry refunds it), never the free room
//   - the cash-out status map: lowercase uuids only, pending then sent or delayed, a TTL and a cap
//   - the owed lane: a refused owed write is kept and written again on the sweep tick until it lands, once per key
const test = require('node:test');
const assert = require('node:assert/strict');
const { rig, layerMsgs } = require('./slSockFakes');
const { moneySpy, fakeLedger, fakePayout } = require('./slPaidFakes');
const { makeEntryStore } = require('../server/entryStore');
const { isStake } = require('../server/stakeRules');
const { slPaidSwitch, SL_PAID_DEFAULT, openSlPaid, createCashoutStatus, isCashoutId, STATUS_MAX, createOwedLane,
  createPaidSwitchStore } =
  require('../server/slPaid/slPaidBoot');
const { STATUS_TTL_MS } = require('../server/slPaid/slPaidConst');

function lines() {
  const out = [];
  return { out, log: (...a) => out.push(a.join(' ')), warn: (...a) => out.push(a.join(' ')),
    error: (...a) => out.push(a.join(' ')) };
}

// The free rig plus everything openSlPaid takes; env: SL_PAID; patch(o): change the options before the call.
function opened(env, patch) {
  const r = rig();
  const money = moneySpy();
  const store = makeEntryStore({ isStake, now: () => r.wall.t });
  const payout = fakePayout();
  const lg = lines();
  const o = {
    env, sockets: r.sockets, laws: r.laws, region: 'na', shippableOnly: false, log: lg, hooks: money.hooks,
    door: { consumeAtStake: (t, s) => store.consumeAtStake(t, s, 'slither'), ledger: fakeLedger(), slPayout: payout,
      journal: money.journal, ops: { get: () => r.ops } },
    arenas: { clock: r.ft.clock, timers: r.ft.timers, now: () => r.wall.t, autoTick: false, prey: false, seed: 3,
      checkEvery: 1 },
  };
  if (patch) patch(o);
  const got = openSlPaid(o);
  const join = (token) => {
    r.wall.t += 1000;
    const s = r.sock({ auth: { paid: 1, stake: 0.5, entryToken: token, cv: 2 } });
    s.fire('sl:join', { nick: 'p' });
    return s;
  };
  const mint = (w) => store.mint({ stake: 0.5, worth: 0.5, paid: 0.5, walletAddress: w, onlyGame: 'slither' });
  return Object.assign({ r, money, store, payout, lg, got, join, mint });
}

const refusalOf = (s) => layerMsgs(s).find((m) => m.t === 'refused') || null;

test('SL_PAID is on by default; agar\'s parser, a typo fails closed and says so', () => {
  assert.equal(SL_PAID_DEFAULT, true, 'on since the switch-on commit (BUILD-TASKS T9)');
  const lg = lines();
  for (const v of [undefined, null, '', '  ']) assert.equal(slPaidSwitch(v, lg), true, JSON.stringify(v));
  for (const v of ['1', 'true', 'on', 'yes', ' ON ', 'Yes']) assert.equal(slPaidSwitch(v, lg), true, v);
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) assert.equal(slPaidSwitch(v, lg), false, v);
  assert.deepEqual(lg.out, [], 'no complaint for a switch value');
  assert.equal(slPaidSwitch('maybe', lg), false);
  assert.equal(slPaidSwitch('2', lg), false);
  assert.equal(lg.out.length, 2);
  assert.match(lg.out[0], /^\[SLP\] SL_PAID="maybe" is not a switch value; paid snake on the new engine stays OFF/);
});

test('no /sl sockets: nothing is built or attached, and the boot says why', () => {
  const lg = lines();
  const got = openSlPaid({ env: { SL_PAID: '1' }, sockets: null, log: lg });
  assert.deepEqual(got, { arenas: null, door: null, paid: false, why: 'no-sl' });
  assert.ok(lg.out.some((l) => /not built: \/sl is not open \(SL_ENABLED off or refused\), SL_PAID ignored/.test(l)));
  const quiet = lines();
  openSlPaid({ env: {}, sockets: { setPaid: undefined }, log: quiet });
  assert.ok(quiet.out.some((l) => /not built/.test(l) && !/SL_PAID ignored/.test(l)), 'SL_PAID unset: not named');
});

test('SL_PAID on (1, or unset: the default): the rungs and the door are attached; a paid page is seated paid', () => {
  for (const v of ['1', undefined]) {
    const x = opened({ SL_PAID: v });
    assert.equal(x.got.paid, true, String(v));
    assert.equal(x.got.why, null);
    assert.ok(x.got.arenas.paidEnabled && x.got.arenas.paidOpen);
    assert.equal(x.r.sockets.paid(), true);
    assert.deepEqual(x.got.arenas.boardRows().map((row) => [row.id, row.state]), [['sl:na:s0.5', 'open'], ['sl:na:s1', 'open']]);
    const s = x.join(x.mint('WON'));
    assert.equal(refusalOf(s), null);
    assert.ok(x.got.arenas.roomOf(s.id), 'seated paid');
    assert.equal(x.r.room().seats.size, 0, 'never in the free room');
    assert.ok(x.lg.out.some((l) => l === '[SLP] paid snake on the new engine on (/sl paid rungs $0.50 and $1)'));
  }
});

test('SL_PAID off (0 or a typo): no rungs, a paid page is refunded not-open once and never seated free', () => {
  for (const v of ['0', 'nope']) {
    const x = opened({ SL_PAID: v });
    assert.equal(x.got.paid, false, String(v));
    assert.equal(x.got.arenas.paidEnabled, false);
    assert.deepEqual(x.got.arenas.boardRows(), []);
    assert.equal(x.r.sockets.paid(), true, 'the helper is attached all the same');
    const token = x.mint('WOFF');
    const s = x.join(token);
    assert.deepEqual(refusalOf(s), { t: 'refused', why: 'not-open', refunded: 500000 });
    assert.deepEqual(x.payout.refunds.map((p) => [p.wallet, p.micro, p.why]), [['WOFF', 500000, 'not-open']]);
    assert.equal(x.store.consumeAtStake(token, 0.5, 'slither').ok, false, 'spent, once');
    assert.equal(x.r.room().seats.size, 0, 'never seated free');
    assert.ok(x.lg.out.some((l) => l === '[SLP] paid snake on the new engine OFF (paid /sl joins are refunded not-open)'));
  }
});

test('rungs that do not build leave the off directory: logged CRITICAL, a paid page refunded not-open', () => {
  const x = opened({ SL_PAID: '1' }, (o) => { o.hooks = Object.assign({}, o.hooks, { onCashout: undefined }); });
  assert.equal(x.got.paid, false);
  assert.match(x.got.why, /moneyHooks\.onCashout is required/);
  assert.ok(x.lg.out.some((l) => /CRITICAL paid snake rungs did not build/.test(l)));
  const s = x.join(x.mint('WBRK'));
  assert.deepEqual(refusalOf(s), { t: 'refused', why: 'not-open', refunded: 500000 });
  assert.equal(x.payout.refunds.length, 1);
});

test('a door that does not build leaves a helper refusing not-open with the token untouched, never the free room', () => {
  const x = opened({ SL_PAID: '1' }, (o) => { o.door = Object.assign({}, o.door, { slPayout: null }); });
  assert.deepEqual([x.got.arenas, x.got.door, x.got.paid], [null, null, false]);
  assert.match(x.got.why, /slPayout\.refund must be a function/);
  assert.equal(x.r.sockets.paid(), true, 'a helper is attached');
  const token = x.mint('WNODOOR');
  const s = x.join(token);
  assert.deepEqual(refusalOf(s), { t: 'refused', why: 'not-open', refunded: 0 });
  assert.equal(s.disconnected, true);
  assert.equal(x.r.room().seats.size, 0, 'never seated free');
  assert.equal(x.store.consumeAtStake(token, 0.5, 'slither').ok, true, 'the token was never spent: its expiry refunds it');
  // the paid socket's other calls land nowhere
  const t2 = x.r.sock({ auth: { paid: 1, stake: 0.5, cv: 2 } });
  t2.fire('sl:back', { k: 'x'.repeat(16), n: 0, p: 0 });
  assert.equal(x.r.room().seats.size, 0);
});

test('the cash-out status: lowercase uuids only, pending then sent or delayed, a TTL and a cap', () => {
  const clock = { t: 1000 };
  const st = createCashoutStatus({ now: () => clock.t, max: 3 });
  const id = (n) => 'abcdef00-0000-4000-8000-00000000000' + n;
  assert.equal(isCashoutId(id(1)), true);
  for (const bad of [id(1).toUpperCase(), 'abc', '', null, 5, id(1) + '0', '../' + id(1)]) {
    assert.equal(isCashoutId(bad), false, String(bad));
    assert.equal(st.set(bad, 'pending'), false);
    assert.equal(st.get(bad), null);
  }
  assert.equal(st.set(id(1), 'paid'), false, 'only the three states');
  assert.equal(st.set(id(1), 'pending'), true);
  assert.equal(st.get(id(1)), 'pending');
  clock.t += 1000;
  st.set(id(1), 'sent');
  assert.equal(st.get(id(1)), 'sent');
  st.set(id(2), 'pending');
  st.set(id(3), 'delayed');
  st.set(id(4), 'pending');
  assert.equal(st.size(), 3, 'at most max');
  assert.equal(st.get(id(1)), null, 'the oldest went first');
  assert.equal(st.get(id(4)), 'pending');
  clock.t += STATUS_TTL_MS;
  assert.equal(st.get(id(4)), null, 'gone after the TTL');
  assert.equal(st.size(), 0);
  assert.equal(STATUS_MAX, 5000);
});

// The owed lane's live write (design 7.4, review T5-R3): db.recordOwedOnce's rule, one row per key; down: every write
// is refused (the database blipped); lost: the next write lands and still rejects (its answer never came back).
function owedDb() {
  const rows = new Map();
  const d = { rows, down: false, lost: false, calls: 0 };
  d.write = async (row) => {
    d.calls++;
    if (d.down) throw new Error('db down');
    const had = rows.has(row.key);
    if (!had) rows.set(row.key, row);
    if (d.lost) {
      d.lost = false;
      throw new Error('answer lost');
    }
    return had ? 'exists' : 'owed';
  };
  return d;
}
const owedKey = (n) => 'agowed:abcdef00-0000-4000-8000-00000000000' + n;
const owedRow = (n, micro) => ({ key: owedKey(n), wallet: 'W' + n, name: 'p' + n, micro,
  reason: 'refund slither emergency sl_na_s0_5 ' + owedKey(n) });

test('the owed lane: a written row kicks the drainer once and leaves nothing to retry', async () => {
  const db = owedDb();
  let kicks = 0;
  const tracked = [];
  const lane = createOwedLane({ write: db.write, kick: () => { kicks++; }, track: (p) => { tracked.push(p); return p; },
    log: lines() });
  assert.equal(await lane.onOwed(owedRow(1, 500000)), 'owed');
  assert.deepEqual([kicks, lane.pending(), tracked.length], [1, 0, 1], 'one kick, nothing kept, the write tracked');
  assert.equal(await lane.retry(), 0);
  assert.equal(db.calls, 1, 'a retry writes nothing');
  assert.throws(() => createOwedLane({}), /write must be a function/);
});

test('the owed lane: a refused write is kept and written again on each tick until it lands, once per key', async () => {
  const db = owedDb();
  const lg = lines();
  let kicks = 0;
  const tracked = [];
  const lane = createOwedLane({ write: db.write, kick: () => { kicks++; }, track: (p) => { tracked.push(p); return p; },
    log: lg });
  db.down = true;
  // still rejects, so slMoney's safeAsync logs OWED CRITICAL and alerts as before; the row is kept
  await assert.rejects(lane.onOwed(owedRow(1, 500000)), /db down/);
  await assert.rejects(lane.onOwed(owedRow(2, 1250000)), /db down/);
  assert.deepEqual([lane.pending(), kicks, db.rows.size], [2, 0, 0]);
  assert.equal(lg.out.filter((l) => /^\[SLP\] OWED row agowed:\S+ kept for a retry on the sweep tick/.test(l)).length, 2);
  // the database is still down at the next tick: both kept, each named
  assert.equal(await lane.retry(), 2);
  assert.equal(lg.out.filter((l) => /^\[SLP\] OWED row agowed:\S+ retry failed, kept \(\d+ micro\): db down$/.test(l)).length, 2);
  // it is back: each row written once, the drainer kicked for each
  db.down = false;
  assert.equal(await lane.retry(), 0);
  assert.deepEqual([...db.rows.keys()], [owedKey(1), owedKey(2)]);
  assert.deepEqual([db.rows.get(owedKey(2)).micro, db.rows.get(owedKey(2)).wallet], [1250000, 'W2']);
  assert.equal(kicks, 2);
  assert.ok(lg.out.includes('[SLP] OWED row ' + owedKey(1) + ' written on retry (owed, 500000 micro)'));
  assert.equal(await lane.retry(), 0, 'nothing left');
  assert.equal(db.calls, 6);
  assert.equal(tracked.length, 6, 'every attempt is tracked (a SIGINT waits for it)');
});

test('the owed lane: a write whose answer was lost replays as exists; a tick never overlaps a write in flight', async () => {
  const db = owedDb();
  const lg = lines();
  let kicks = 0;
  const lane = createOwedLane({ write: db.write, kick: () => { kicks++; }, log: lg });
  db.lost = true;
  await assert.rejects(lane.onOwed(owedRow(3, 500000)), /answer lost/);
  assert.deepEqual([lane.pending(), db.rows.size], [1, 1], 'kept although the row landed');
  assert.equal(await lane.retry(), 0);
  assert.deepEqual([db.rows.size, kicks], [1, 1], 'exists: still one row, and done');
  assert.ok(lg.out.includes('[SLP] OWED row ' + owedKey(3) + ' written on retry (exists, 500000 micro)'));
  // a slow database: two ticks while the retry is in flight start one write
  let release;
  const slow = { calls: 0 };
  const lane2 = createOwedLane({
    write: (row) => {
      slow.calls++;
      if (slow.calls === 1) return Promise.reject(new Error('db down'));
      return new Promise((r) => { release = () => r('owed'); });
    },
    log: lines(),
  });
  await assert.rejects(lane2.onOwed(owedRow(4, 500000)), /db down/);
  const a = lane2.retry();
  const b = lane2.retry();
  assert.equal(await b, 1, 'the second tick skips the row in flight and still counts it');
  assert.equal(slow.calls, 2, 'one retry write in flight');
  release();
  assert.equal(await a, 0);
  assert.equal(lane2.pending(), 0);
  // a drainer kick that throws never puts a written row back
  const db3 = owedDb();
  const lane3 = createOwedLane({ write: db3.write, kick: () => { throw new Error('kick'); }, log: lines() });
  assert.equal(await lane3.onOwed(owedRow(5, 500000)), 'owed');
  assert.equal(lane3.pending(), 0);
});

/* server/index.js wires the lane (T5-R3; read from the source and run here on a fake database, as entryExpiry does for
   devRefund): recordOwedOnce's argument order with the micro in dollars, the drainer kick, agInflight, slMoney's onOwed,
   and the slpaid-sweep tick retrying it. test/slPaidJoinSmoke.test.js runs it live (T5-R1). */
test('server/index.js: the owed lane writes dollars in recordOwedOnce\'s order, kicks the drainer, retries on the tick', () => {
  // A Windows checkout (core.autocrlf) has CRLF; the scan is about the code, not the line endings.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const m = /const slOwedLane = slPaidBoot\.createOwedLane\(\{\n\s*write: (\(row\) => [^\n]+),\n\s*kick: kickDrain,\n\s*track: agInflight\.track,\n\}\);/.exec(src);
  assert.ok(m, 'index.js builds the owed lane');
  const got = [];
  const write = new Function('db', 'return ' + m[1])({ recordOwedOnce: (...a) => { got.push(a); return Promise.resolve('owed'); } });
  write({ key: owedKey(1), wallet: 'WOWED', name: '', micro: 1250000, reason: 'refund slither orphan sl_na_s1 ' + owedKey(1) });
  assert.deepEqual(got, [[owedKey(1), 'WOWED', 1.25, 'Player', 'refund slither orphan sl_na_s1 ' + owedKey(1)]]);
  assert.match(src, /\n\s*onOwed: slOwedLane\.onOwed,\n\s*onFloor: slPayout\.sweepFloor,\n\s*onHouse: slPayout\.houseIncident,\n/);
  assert.match(src, /everyStaggered\(\(\) => \{\n[^}]*slOwedLane\.retry\(\)[^}]*\}, 60000, 9000, 'slpaid-sweep'\);/);
});

// Review OPS-1: the owner's sl:paid:off outlives a restart. A file beside the money journal holds the close; the boot
// opens the rungs CLOSED while it is there (unreadable or not a switch: closed too); sl:paid:on removes it.
test('the paid switch store: a saved close opens the rungs closed at the next boot; open removes it; a bad file fails closed', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slpswitch-'));
  const file = path.join(dir, 'data', 'sl-paid-switch.json');
  const lg = lines();
  const st = createPaidSwitchStore({ file, log: lg, now: () => Date.parse('2026-10-15T12:00:00.000Z') });
  assert.throws(() => createPaidSwitchStore({}), /file is required/);
  assert.deepEqual([st.saved(), st.closedAtBoot()], [false, { closed: false, why: null }], 'no file: the code default');
  assert.deepEqual(st.save(false), { ok: true, why: null });
  assert.equal(st.saved(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { open: false, at: '2026-10-15T12:00:00.000Z' });
  assert.deepEqual(st.closedAtBoot(), { closed: true, why: 'owner' });
  // a boot with it: the rungs built, the door shut, the rows gone (so /api/live opens the old rows), as after sl:paid:off
  const x = opened({ SL_PAID: '1' }, (o) => { o.paidSwitch = st; });
  assert.equal(x.got.paid, true);
  assert.deepEqual([x.got.arenas.paidEnabled, x.got.arenas.paidOpen], [true, false]);
  assert.deepEqual(x.got.arenas.boardRows(), []);
  assert.ok(x.lg.out.some((l) => /paid door CLOSED at boot \(owner\): the owner's sl:paid:off outlived the restart/.test(l)));
  const s = x.join(x.mint('WSAVED'));
  assert.deepEqual(refusalOf(s), { t: 'refused', why: 'not-open', refunded: 500000 });
  // open removes it; a second open is fine; the next boot is the code default
  assert.deepEqual(st.save(true), { ok: true, why: null });
  assert.deepEqual(st.save(true), { ok: true, why: null });
  assert.deepEqual([st.saved(), st.closedAtBoot()], [false, { closed: false, why: null }]);
  assert.equal(opened({ SL_PAID: '1' }, (o) => { o.paidSwitch = st; }).got.arenas.paidOpen, true);
  // a file that is not a switch, one that cannot be read, a store that throws: closed, and said
  fs.writeFileSync(file, 'garbage');
  assert.deepEqual(st.closedAtBoot(), { closed: true, why: 'unreadable' });
  fs.writeFileSync(file, JSON.stringify({ open: true }));
  assert.deepEqual(st.closedAtBoot(), { closed: true, why: 'unreadable' }, 'only a close is ever written');
  const broken = createPaidSwitchStore({ file, log: lg, fsx: Object.assign({}, fs, { readFileSync() { throw new Error('EIO'); } }) });
  assert.deepEqual(broken.closedAtBoot(), { closed: true, why: 'unreadable' });
  assert.ok(lg.out.some((l) => /paid switch file unreadable, paid snake on the new engine starts CLOSED: EIO/.test(l)));
  const y = opened({ SL_PAID: '1' }, (o) => { o.paidSwitch = { closedAtBoot() { throw new Error('boom'); } }; });
  assert.equal(y.got.arenas.paidOpen, false);
  // a save that cannot write says why (the owner text then says it lasts only until the restart)
  const ro = createPaidSwitchStore({ file, log: lg, fsx: Object.assign({}, fs, { writeFileSync() { throw new Error('EROFS'); } }) });
  assert.deepEqual(ro.save(false), { ok: false, why: 'EROFS' });
  // SL_PAID off: the store is never asked
  let asked = 0;
  opened({ SL_PAID: '0' }, (o) => { o.paidSwitch = { closedAtBoot() { asked++; return { closed: true, why: 'owner' }; } }; });
  assert.equal(asked, 0);
});
