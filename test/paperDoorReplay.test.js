'use strict';
// A restart or crash during a paid Paper join (the Paper analog of security review item d, 2026-10-15). The door
// claims the stake row (pending -> consumed under the token's claimKey) and only then seats. A process that died
// between the claim and the seat left the row 'consumed' with no seat and no journal record at all: the boot sweeps
// refund only 'pending' rows and the claimKey lived only in memory, so the stake was stranded for a hand payout.
// Now the door writes a journal open (door, stakeSig, claimKey) BEFORE the claim, the seat's own open replaces it for
// the same jid (and a seat whose own open is not written is refused), and the boot replay refunds a door-only open
// through the stake ledger's conditional refund, which pays at most once. A seated account is never touched.
// Real modules: paperSockets, PaperArenas and agJournal on a temp file, stakeLedger over scripts/memLedgerDb.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createPaperSockets = require('../server/paperSockets');
const { PaperArenas } = require('../server/paper/PaperArenas');
const { createAgJournal } = require('../server/ag/agJournal');
const { createStakeLedger } = require('../server/stakeLedger');
const { createMemLedgerDb } = require('../scripts/memLedgerDb');
const { isStake } = require('../server/stakeRules');

const quietLog = { log() {}, warn() {}, error() {} };
const lines = () => {
  const out = [];
  return { out, log: (m) => out.push(String(m)), warn: (m) => out.push(String(m)), error: (m) => out.push(String(m)) };
};
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppdoor-')), 'ag-money-journal.log');
}
function records(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function seededDb(sig, wallet = 'W-PP') {
  const db = createMemLedgerDb();
  db.seedStake({ sig, state: 'pending', wallet_address: wallet, refund_amount: 0.5, label: 'stake 0.5', region: 'na',
    boot_id: 'b1' });
  return db;
}

// The real Paper door over a real journal and the real ledger. die: the claim commits and its answer is lost with the
// process (the seat never happens). wrap: wraps the journal (a write that fails). onClaimed(socket): runs as the claim
// answers, before the door looks again.
function door({ file, db, sig, claimKey, wallet = 'W-PP', die = false, wrap = (j) => j, onClaimed = null }) {
  const journal = wrap(createAgJournal({ file, bootId: 'b1', log: quietLog }));
  const io = { to: () => ({ emit() {}, volatile: { emit() {} } }) };
  const hooks = { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {} };
  const arenas = new PaperArenas({ io, hooks, paidEnabled: true, autoTick: false, warm: false, journal });
  const real = createStakeLedger({ db, region: 'na', bootId: 'b1', log: quietLog });
  const ctx = {};
  const ledger = Object.assign({}, real, { claimSeat: (e) => real.claimSeat(e).then((c) => {
    if (die) return new Promise(() => {});
    if (onClaimed) onClaimed(ctx.socket);
    return c;
  }) });
  const token = { live: true };
  const take = () => {
    if (!token.live) return { ok: false, worth: 0 };
    token.live = false;
    return { ok: true, worth: 0.5, paid: 0.5, walletAddress: wallet, stakeSig: sig, claimKey,
      restore: () => { token.live = true; } };
  };
  const paper = createPaperSockets({
    arenas,
    ops: { get: () => ({ maintenance: false }) },
    socketRL: () => true,
    sanitizeName: (n) => String(n || 'Player'),
    isStake,
    consumePaidEntryAtStake: take,
    entryStore: { consumeAtStake: take },
    payout: { refund() { throw new Error('a real token refunds through its stake row'); } },
    ledger,
    paidEnabled: true
  });
  const s = {
    id: 'sk-' + sig, got: [], handlers: {}, rooms: new Set(), disconnected: false,
    on(ev, fn) { this.handlers[ev] = fn; },
    emit(ev, p) { this.got.push([ev, p]); },
    join(r) { this.rooms.add(r); },
    leave(r) { this.rooms.delete(r); },
    last(ev) { const g = this.got.filter((x) => x[0] === ev); return g.length ? g[g.length - 1][1] : null; }
  };
  ctx.socket = s;
  paper.attach(s);
  s.handlers['pp:join']({ stake: 0.5, name: 'pp', entryToken: 'tok-' + sig });
  return { journal, arenas, socket: s, token };
}

async function boot(file, bootId, ledger, log = quietLog) {
  const j = createAgJournal({ file, bootId, log });
  j.rotate();
  const asked = [];
  const s = await j.replay({ writeOwedOnce: () => Promise.resolve('owed'),
    refundStake: (sig, reason, claimKey) => { asked.push([sig, reason, claimKey]); return ledger.refund(sig, reason, claimKey); } });
  return { s, asked, j };
}

test('the Paper door writes its journal open (door, stakeSig, claimKey) before the claim', async () => {
  const file = tmpFile();
  const db = seededDb('PP-1');
  door({ file, db, sig: 'PP-1', claimKey: 'CK-1', die: true });
  await flush();
  const recs = records(file);
  assert.equal(recs.length, 1, 'one record: the door\'s, and no seat');
  const [o] = recs;
  assert.deepEqual([o.t, o.stakeSig, o.door, o.claimKey, o.micro, o.wallet, o.room],
    ['open', 'PP-1', true, 'CK-1', 500000, 'W-PP', 'paper_na_s0_5']);
  assert.equal(db.stakes.get('PP-1').state, 'consumed', 'the claim landed');
});

test('a restart after the Paper claim and before the seat: the boot replay refunds the consumed stake once', async () => {
  const file = tmpFile();
  const db = seededDb('PP-2');
  door({ file, db, sig: 'PP-2', claimKey: 'CK-2', die: true });
  await flush();
  const copy = fs.readFileSync(file, 'utf8');
  const ledger = createStakeLedger({ db, region: 'na', bootId: 'b2', log: quietLog });
  const swept = await ledger.sweep({ boot: true });
  assert.deepEqual([swept.found, swept.owed], [0, 0], 'the sweep lists pending rows only');
  const lg = lines();
  const { s } = await boot(file, 'b2', ledger, lg);
  assert.deepEqual([s.unsettled, s.doorRefunds, s.doorRefundMicro, s.failed], [0, 1, 500000, 0]);
  assert.equal(db.stakes.get('PP-2').state, 'refunded');
  assert.equal(db.payouts.length, 1, 'one owed row for the drainer');
  assert.deepEqual([db.payouts[0].wallet_address, db.payouts[0].amount_sol], ['W-PP', 0.5]);
  assert.ok(db.payouts[0].reason.startsWith('refund paper restart before seat paper_na_s0_5'), db.payouts[0].reason);
  // the same records again: the conditional refund answers settled, nothing paid twice
  fs.writeFileSync(file, copy);
  const again = await boot(file, 'b3', ledger);
  assert.deepEqual([again.s.doorSettled, again.s.unsettled, again.s.failed], [1, 0, 0]);
  assert.equal(db.payouts.length, 1, 'paid at most once');
});

test('a seated Paper account (its own open replaces the door\'s) is never refunded by the replay', async () => {
  const file = tmpFile();
  const db = seededDb('PP-3');
  const { socket, arenas } = door({ file, db, sig: 'PP-3', claimKey: 'CK-3' });
  await flush();
  assert.ok(socket.last('pp:joined'), 'seated');
  const recs = records(file);
  assert.deepEqual(recs.map((r) => [r.t, r.door === true]), [['open', true], ['open', false]]);
  assert.equal(recs[0].jid, recs[1].jid, 'the seat\'s open is for the door\'s jid');
  assert.equal(arenas.all().find((r) => r.stake === 0.5).seats.size, 1);
  // killed with the seat open: flagged for Owen, never refunded blind
  const ledger = createStakeLedger({ db, region: 'na', bootId: 'b2', log: quietLog });
  const { s, asked } = await boot(file, 'b2', ledger);
  assert.deepEqual(asked, []);
  assert.deepEqual([s.unsettled, s.doorRefunds], [1, undefined]);
  assert.equal(db.stakes.get('PP-3').state, 'consumed');
  assert.equal(db.payouts.length, 0);
});

test('a seat whose own journal open is not written is refused and refunded once, and the replay pays nothing more', async () => {
  const file = tmpFile();
  const db = seededDb('PP-4');
  // the door's record writes; the seat's (no door flag) does not
  const wrap = (j) => Object.assign({}, j, { open: (acct, room) => (acct.door === true ? j.open(acct, room) : false) });
  const { socket, arenas } = door({ file, db, sig: 'PP-4', claimKey: 'CK-4', wrap });
  await flush();
  assert.equal(socket.last('pp:joined'), null, 'not seated');
  assert.deepEqual(socket.last('pp:refused') && [socket.last('pp:refused').why, socket.last('pp:refused').refunded],
    ['seat-failed', true]);
  assert.equal(arenas.all().find((r) => r.stake === 0.5).seats.size, 0);
  assert.equal(db.stakes.get('PP-4').state, 'refunded');
  assert.equal(db.payouts.length, 1);
  const recs = records(file);
  assert.deepEqual(recs.map((r) => [r.t, r.outcome || '']), [['open', ''], ['close', 'refused']],
    'the door closes its record once the refund landed');
  const ledger = createStakeLedger({ db, region: 'na', bootId: 'b2', log: quietLog });
  const { s, asked } = await boot(file, 'b2', ledger);
  assert.deepEqual(asked, []);
  assert.deepEqual([s.unsettled, s.failed], [0, 0]);
  assert.equal(db.payouts.length, 1, 'refunded once');
});

test('a door whose journal open is not written spends nothing: the token goes back, no claim, \'unavailable\'', async () => {
  const file = tmpFile();
  const db = seededDb('PP-5');
  const wrap = (j) => Object.assign({}, j, { open: () => false });
  const { socket, token } = door({ file, db, sig: 'PP-5', claimKey: 'CK-5', wrap });
  await flush();
  assert.equal(socket.last('pp:refused').why, 'unavailable');
  assert.equal(token.live, true, 'the token was put back');
  assert.equal(db.stakes.get('PP-5').state, 'pending', 'never claimed: the boot sweep owns it');
  assert.equal(db.payouts.length, 0);
});

test('a join lost after the claim is refunded at the door and closed, so the replay pays nothing more', async () => {
  const file = tmpFile();
  const db = seededDb('PP-6');
  const { socket } = door({ file, db, sig: 'PP-6', claimKey: 'CK-6', onClaimed: (s) => { s.disconnected = true; } });
  await flush();
  assert.equal(socket.last('pp:joined'), null);
  assert.equal(db.stakes.get('PP-6').state, 'refunded');
  assert.equal(db.payouts.length, 1);
  assert.ok(db.payouts[0].reason.startsWith('refund paper join-lost'), db.payouts[0].reason);
  assert.deepEqual(records(file).map((r) => [r.t, r.outcome || '', r.why || '']), [['open', '', ''], ['close', 'refused', 'join-lost']]);
  const ledger = createStakeLedger({ db, region: 'na', bootId: 'b2', log: quietLog });
  const { s, asked } = await boot(file, 'b2', ledger);
  assert.deepEqual(asked, []);
  assert.deepEqual([s.unsettled, s.failed], [0, 0]);
  assert.equal(db.payouts.length, 1, 'refunded once');
});
