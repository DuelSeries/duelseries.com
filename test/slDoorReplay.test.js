'use strict';
// A restart or crash during a paid snake join (security review item d, 2026-10-15). The door writes its journal open,
// claims the stake row (pending -> consumed under the token's claimKey) and only then seats. A process that died
// between the claim and the seat left the row 'consumed' with no seat: the boot sweeps refund only 'pending' rows, the
// claimKey lived only in memory, and the replay only flagged the open UNSETTLED-AT-BOOT for Owen to pay by hand.
// Now the door's open carries door and the claimKey, and the boot replay refunds a door-only open (its last open
// record is still the door's, with no close) through the stake ledger's conditional refund, which pays at most once.
// A seated account (slMoney writes its own open for the jid, and refuses the seat when that write fails) is never
// touched. Real modules: the real slPaidDoor and agJournal on a temp file, the real stakeLedger over
// scripts/memLedgerDb.js (each SQL statement's rule in one step).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSlPaidDoor } = require('../server/slPaid/slPaidDoor');
const { createAgJournal } = require('../server/ag/agJournal');
const { createStakeLedger } = require('../server/stakeLedger');
const { createMemLedgerDb } = require('../scripts/memLedgerDb');

const quietLog = { log() {}, warn() {}, error() {} };
const lines = () => {
  const out = [];
  return { out, log: (m) => out.push(String(m)), warn: (m) => out.push(String(m)), error: (m) => out.push(String(m)) };
};

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sldoor-')), 'ag-money-journal.log');
}

function records(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// The real door up to its claim: the claim lands in the database and then the process "dies" (the promise the door
// waits on never answers, so the seat never happens and nothing closes the journal).
function doorUntilClaim({ file, db, sig, claimKey, wallet = 'W-DOOR' }) {
  const journal = createAgJournal({ file, bootId: 'b1', log: quietLog });
  const ledger = {
    claimSeat(entry) {
      // the claim commits (pending -> consumed under this claimKey), and its answer is lost with the process
      return db.claimStakeSeat(entry.stakeSig, entry.claimKey).then(() => new Promise(() => {}));
    },
    refund() { throw new Error('not reached'); }
  };
  const arenas = { stopping: false, paidOpen: true, labelOf: () => 'sl_na_s0_5', hasSpace: () => true, roomOf: () => null };
  const door = createSlPaidDoor({
    arenas,
    consumeAtStake: () => ({ ok: true, worth: 0.5, paid: 0.5, walletAddress: wallet, stakeSig: sig, claimKey }),
    ledger,
    slPayout: { refund() { throw new Error('not reached'); } },
    journal,
    log: quietLog
  });
  const socket = { id: 'sock-' + sig, handshake: { auth: { entryToken: 'tok-' + sig, stake: 0.5 } }, emit() {}, disconnect() {} };
  door.join(socket, { nick: 'p', cv: 1 });
  return journal;
}

async function seededDb(sig, wallet = 'W-DOOR') {
  const db = createMemLedgerDb();
  db.seedStake({ sig, state: 'pending', wallet_address: wallet, refund_amount: 0.5, label: 'stake 0.5', region: 'na',
    boot_id: 'b1' });
  return db;
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

test('the door\'s journal open carries door and the token\'s claimKey (the seat\'s own open carries neither)', async () => {
  const file = tmpFile();
  const db = await seededDb('SIG-1');
  doorUntilClaim({ file, db, sig: 'SIG-1', claimKey: 'CK-1' });
  await flush();
  const [open] = records(file);
  assert.deepEqual([open.t, open.stakeSig, open.door, open.claimKey, open.micro, open.room],
    ['open', 'SIG-1', true, 'CK-1', 500000, 'sl_na_s0_5']);
  assert.equal(db.stakes.get('SIG-1').state, 'consumed', 'the claim landed');
  // the journal writes door and claimKey only for a door's record: an account open (slMoney) has neither
  const j = createAgJournal({ file: tmpFile(), log: quietLog });
  j.open({ jid: 'x', wallet: 'W', deposit: 1, stakeSig: 'S', claimKey: 'CK' }, 'r');
  j.open({ jid: 'y', wallet: 'W', deposit: 1, door: true, claimKey: 'CK' }, 'r'); // no stakeSig: nothing to refund
  const recs = records(j.file);
  assert.ok(recs.every((r) => !('door' in r) && !('claimKey' in r)));
});

test('a restart after the claim and before the seat: the boot replay refunds the consumed stake once', async () => {
  const file = tmpFile();
  const db = await seededDb('SIG-2');
  doorUntilClaim({ file, db, sig: 'SIG-2', claimKey: 'CK-2' });
  await flush();
  const copy = fs.readFileSync(file, 'utf8');
  // the boot sweep never touches a consumed row
  const ledger = createStakeLedger({ db, region: 'na', bootId: 'b2', log: quietLog });
  const swept = await ledger.sweep({ boot: true });
  assert.deepEqual([swept.found, swept.owed], [0, 0], 'the sweep lists pending rows only');
  // the replay does, with the claimKey from the door's record
  const lg = lines();
  const alerts = [];
  const boot = createAgJournal({ file, bootId: 'b2', log: lg });
  boot.rotate();
  const s = await boot.replay({ writeOwedOnce: () => Promise.resolve('owed'), alert: (a) => alerts.push(a),
    refundStake: (sig, reason, claimKey) => ledger.refund(sig, reason, claimKey) });
  assert.deepEqual([s.unsettled, s.doorRefunds, s.doorRefundMicro, s.failed], [0, 1, 500000, 0]);
  assert.equal(db.stakes.get('SIG-2').state, 'refunded');
  assert.equal(db.payouts.length, 1, 'one owed row for the drainer');
  assert.deepEqual([db.payouts[0].wallet_address, db.payouts[0].amount_sol, db.payouts[0].stake_sig], ['W-DOOR', 0.5, 'SIG-2']);
  assert.ok(db.payouts[0].reason.startsWith('refund slither restart before seat'), db.payouts[0].reason);
  assert.deepEqual(alerts, [], 'settled automatically: nothing for Owen to pay by hand');
  assert.ok(lg.out.some((l) => l.startsWith('[AG] JOURNAL door refund owed W-DOOR deposit 500000')));
  // the same records replayed again (a file kept for another reason): the conditional refund answers settled
  fs.writeFileSync(file, copy);
  const again = createAgJournal({ file, bootId: 'b3', log: quietLog });
  again.rotate();
  const s2 = await again.replay({ writeOwedOnce: () => Promise.resolve('owed'),
    refundStake: (sig, reason, claimKey) => ledger.refund(sig, reason, claimKey) });
  assert.deepEqual([s2.doorSettled, s2.doorRefunds, s2.unsettled, s2.failed], [1, undefined, 0, 0]);
  assert.equal(db.payouts.length, 1, 'paid at most once');
});

test('a door that died before its claim landed: the replay and the boot sweep race, exactly one refunds', async () => {
  const file = tmpFile();
  const db = await seededDb('SIG-3');
  const journal = createAgJournal({ file, bootId: 'b1', log: quietLog });
  journal.open({ jid: '11111111-2222-4333-8444-555555555555', wallet: 'W-DOOR', deposit: 500000, stakeSig: 'SIG-3',
    door: true, claimKey: 'CK-3' }, 'sl_na_s0_5');
  const ledger = createStakeLedger({ db, region: 'na', bootId: 'b2', log: quietLog });
  const boot = createAgJournal({ file, bootId: 'b2', log: quietLog });
  boot.rotate();
  const [s, swept] = await Promise.all([
    boot.replay({ writeOwedOnce: () => Promise.resolve('owed'), refundStake: (a, b, c) => ledger.refund(a, b, c) }),
    ledger.sweep({ boot: true }),
  ]);
  assert.equal((s.doorRefunds || 0) + swept.owed, 1, 'one of them refunded it');
  assert.equal(db.payouts.length, 1);
  assert.equal(s.unsettled, 0);
});

test('a seated account (its own open after the door\'s) is only flagged, never refunded; so is a door record with no claimKey', async () => {
  const file = tmpFile();
  const db = await seededDb('SIG-4');
  await db.claimStakeSeat('SIG-4', 'CK-4');
  const journal = createAgJournal({ file, bootId: 'b1', log: quietLog });
  const jid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  journal.open({ jid, wallet: 'W-SEAT', deposit: 500000, stakeSig: 'SIG-4', door: true, claimKey: 'CK-4' }, 'sl_na_s0_5');
  journal.open({ jid, wallet: 'W-SEAT', deposit: 500000, stakeSig: 'SIG-4' }, 'sl_na_s0_5'); // slMoney.open, seated
  // an older door record (before this fix) has no claimKey: flagged as before
  journal.open({ jid: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee', wallet: 'W-OLD', deposit: 500000, stakeSig: 'SIG-OLD' },
    'sl_na_s0_5');
  const asked = [];
  const lg = lines();
  const boot = createAgJournal({ file, bootId: 'b2', log: lg });
  boot.rotate();
  const s = await boot.replay({ writeOwedOnce: () => Promise.resolve('owed'),
    refundStake: (...a) => { asked.push(a); return Promise.resolve('owed'); } });
  assert.deepEqual(asked, [], 'a seat is never refunded blind');
  assert.deepEqual([s.unsettled, s.unsettledMicro, s.doorRefunds], [2, 1000000, undefined]);
  assert.equal(db.stakes.get('SIG-4').state, 'consumed');
  assert.ok(lg.out.some((l) => l.startsWith('[AG] UNSETTLED-AT-BOOT W-SEAT deposit 500000')));
});

test('a refund the database cannot take yet keeps the file for the next boot, which refunds it then', async () => {
  const file = tmpFile();
  const db = await seededDb('SIG-5');
  doorUntilClaim({ file, db, sig: 'SIG-5', claimKey: 'CK-5' });
  await flush();
  const down = { refundStakeOwed: async () => { throw new Error('db down'); } };
  const offline = createStakeLedger({ db: Object.assign({}, db, down), region: 'na', bootId: 'b2', log: quietLog });
  const boot = createAgJournal({ file, bootId: 'b2', log: quietLog });
  boot.rotate();
  const s = await boot.replay({ writeOwedOnce: () => Promise.resolve('owed'), refundStake: (a, b, c) => offline.refund(a, b, c) });
  assert.deepEqual([s.failed, s.doorRefunds, s.unsettled], [1, undefined, 0]);
  assert.equal(boot.replayFiles().length, 1, 'kept');
  const online = createStakeLedger({ db, region: 'na', bootId: 'b3', log: quietLog });
  const next = createAgJournal({ file, bootId: 'b3', log: quietLog });
  next.rotate();
  const s2 = await next.replay({ writeOwedOnce: () => Promise.resolve('owed'), refundStake: (a, b, c) => online.refund(a, b, c) });
  assert.deepEqual([s2.failed, s2.doorRefunds], [0, 1]);
  assert.equal(db.payouts.length, 1);
  assert.equal(next.replayFiles().length, 0, 'done');
});
