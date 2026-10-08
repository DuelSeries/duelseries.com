'use strict';
/* STATUS item 7a (night queue item 5): a paid stake is never lost to a restart or a crash between
   the stake and the join, and never paid twice.

   The durable row (server/stakeLedger.js over server/db.js) is exercised against
   scripts/memLedgerDb.js, which applies each SQL statement's rule in one step, as a single UPDATE
   does in Postgres; the dev machine has no Postgres, so the SQL text itself is pinned at the end.
   - boot refund: every stake an earlier boot verified and never seated or refunded is owed back
     once; this boot's live tokens, other regions' fresh rows, seated and legacy rows are not;
   - a door racing a boot sweep: exactly one wins, in every interleaving, and a stake is never
     both seated and refunded;
   - the unspent-token expiry racing a boot sweep: one owed row, never two;
   - a claim whose answer was lost: the same token wins again, or is refunded once, never lost;
   - the Paper door claims before it seats, and every refund it makes goes through the row. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createMemLedgerDb } = require('../scripts/memLedgerDb');
const { createStakeLedger } = require('../server/stakeLedger');
const { makeEntryStore } = require('../server/entryStore');
const { createExpiryRefund } = require('../server/entryExpiry');
const { isStake } = require('../server/stakeRules');

const quiet = { log() {}, warn() {}, error() {} };
const MIN = 60 * 1000;
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await flush(); };

function ledgerOn(db, bootId, region = 'na', extra = {}) {
  return createStakeLedger({ db, region, bootId, log: quiet, ...extra });
}

// A stake as /api/submit-stake records it: the row (through the ledger) and the token.
async function stakeOn(ledger, store, sig, { wallet = 'W-' + sig, rung = 0.1, paid = rung } = {}) {
  const rec = await ledger.record(sig, { wallet, amount: Math.min(rung, paid), label: 'stake ' + rung });
  assert.strictEqual(rec.claimed, true);
  assert.strictEqual(rec.durable, true);
  return store ? store.mint({ stake: rung, worth: rung, paid, walletAddress: wallet, stakeSig: sig }) : null;
}

const owedFor = (db, sig) => db.payouts.filter((p) => p.stake_sig === sig);

test('boot refund: every stake an earlier boot verified and never seated or refunded is owed back exactly once', async () => {
  let t = 1e12;
  const db = createMemLedgerDb({ now: () => t });
  const boot1 = ledgerOn(db, 'boot-1');
  await stakeOn(boot1, null, 'A', { wallet: 'WA', rung: 1, paid: 1 });          // orphan after the restart
  await stakeOn(boot1, null, 'E', { wallet: 'WE' });                             // seated before the restart
  assert.strictEqual(await db.claimStakeSeat('E', 'key-E'), true);
  const eu = ledgerOn(db, 'eu-boot', 'eu');
  await stakeOn(eu, null, 'C', { wallet: 'WC' });                                // EU is alive: its live token
  db.stakes.set('LEGACY', { sig: 'LEGACY', state: null, created_at: t });         // written before this change
  t += 1000;

  // The server restarts: a new boot id, and a stake minted by the new boot before its sweep ran.
  const boot2 = ledgerOn(db, 'boot-2');
  await stakeOn(boot2, null, 'B', { wallet: 'WB' });
  const r1 = await boot2.sweep({ boot: true });
  assert.deepStrictEqual(r1, { found: 1, owed: 1, ok: true });
  assert.deepStrictEqual(db.payouts.map((p) => [p.stake_sig, p.wallet_address, p.amount_sol]), [['A', 'WA', 1]]);
  assert.match(db.payouts[0].reason, /^refund unspent entry stake 1 \(the server restarted before the join\)$/);
  assert.deepStrictEqual(['A', 'B', 'C', 'E', 'LEGACY'].map((s) => db.stakes.get(s).state),
    ['refunded', 'pending', 'pending', 'consumed', null]);

  // Again at the same boot, and the periodic sweep: nothing more is owed.
  assert.strictEqual((await boot2.sweep({ boot: true })).owed, 0);
  assert.strictEqual((await boot2.sweep({ boot: false })).owed, 0);
  // A direct second refund of A finds it settled.
  assert.strictEqual(await boot2.refund('A', 'refund again'), 'settled');
  assert.strictEqual(owedFor(db, 'A').length, 1);

  // Thirty minutes on, the periodic sweep refunds the EU row whose server never came back; the
  // seated row and the legacy row are never touched.
  t += 31 * MIN;
  const r2 = await boot2.sweep({ boot: false });
  assert.strictEqual(r2.owed, 2);                                                  // C (eu) and B (stale now)
  assert.deepStrictEqual(db.payouts.map((p) => p.stake_sig).sort(), ['A', 'B', 'C']);
  assert.strictEqual(db.stakes.get('E').state, 'consumed');
  assert.strictEqual(db.stakes.get('LEGACY').state, null);
  assert.strictEqual(new Set(db.payouts.map((p) => p.stake_sig)).size, db.payouts.length, 'one owed row per stake');
});

test('a new boot leaves its own live tokens alone and refunds the dead boot\'s tokens only', async () => {
  const db = createMemLedgerDb();
  const store1 = makeEntryStore({ fees: {}, isStake });
  const boot1 = ledgerOn(db, 'boot-1');
  const tokOld = await stakeOn(boot1, store1, 'OLD');
  assert.ok(tokOld);
  // Restart: the old memory is gone. The new boot mints, then sweeps.
  const store2 = makeEntryStore({ fees: {}, isStake });
  const boot2 = ledgerOn(db, 'boot-2');
  const tokNew = await stakeOn(boot2, store2, 'NEW');
  await boot2.sweep({ boot: true });
  assert.deepStrictEqual(db.payouts.map((p) => p.stake_sig), ['OLD']);
  // The new token still joins: its row is pending and its door claim wins.
  const e = store2.consumeAtStake(tokNew, 0.1, 'paper');
  assert.strictEqual(await boot2.claimSeat(e), 'ok');
  assert.strictEqual(db.stakes.get('NEW').state, 'consumed');
});

test('a door racing a boot sweep: exactly one wins in every interleaving, never seated and refunded', async () => {
  const seen = { door: 0, sweep: 0 };
  for (let i = 0; i < 60; i++) {
    const lat = () => Math.floor(Math.random() * 4);          // 0 to 3 ms before each statement applies
    const db = createMemLedgerDb({ latency: lat });
    const store = makeEntryStore({ fees: {}, isStake });
    const live = ledgerOn(db, 'old-boot');                    // the old process, still serving
    const tok = await stakeOn(live, store, 'S' + i, { wallet: 'W' });
    const next = ledgerOn(db, 'new-boot');                    // the new process starting up
    const entry = store.consumeAtStake(tok, 0.1, 'snake');
    const [claim] = await Promise.all([live.claimSeat(entry), next.sweep({ boot: true })]);
    const owed = owedFor(db, 'S' + i).length;
    const state = db.stakes.get('S' + i).state;
    if (claim === 'ok') { seen.door++; assert.strictEqual(owed, 0); assert.strictEqual(state, 'consumed'); }
    else { seen.sweep++; assert.strictEqual(claim, 'settled'); assert.strictEqual(owed, 1); assert.strictEqual(state, 'refunded'); }
  }
  assert.ok(seen.door > 0 && seen.sweep > 0, 'both orders happened: ' + JSON.stringify(seen));
});

test('a token spent just before a crash is not refunded at the next boot (its money was seated)', async () => {
  const db = createMemLedgerDb();
  const store = makeEntryStore({ fees: {}, isStake });
  const boot1 = ledgerOn(db, 'boot-1');
  const tok = await stakeOn(boot1, store, 'P');
  const entry = store.consumeAtStake(tok, 0.1, 'paper');
  assert.strictEqual(await boot1.claimSeat(entry), 'ok');
  // crash: boot1's memory is gone
  const boot2 = ledgerOn(db, 'boot-2');
  assert.deepStrictEqual(await boot2.sweep({ boot: true }), { found: 0, owed: 0, ok: true });
  assert.strictEqual(db.payouts.length, 0);
});

test('the unspent-token expiry and a boot sweep never both pay: one owed row whichever commits first', async () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    let t = 1e12;
    const db = createMemLedgerDb({ now: () => t, latency: () => Math.floor(Math.random() * 4) });
    const live = ledgerOn(db, 'boot-1');
    const withdrawn = [];
    const money = { unit: 'USDC', withdraw: async (w, a) => { withdrawn.push([w, a]); return 'sig'; } };
    const refund = createExpiryRefund({ money, db, ledger: live, log: quiet });
    const expiring = [];
    const store = makeEntryStore({ ttlMs: 5 * MIN, fees: {}, isStake, onExpire: (v) => expiring.push(refund(v)), now: () => t });
    await stakeOn(live, store, 'X' + i, { wallet: 'WX', rung: 1, paid: 1 });
    t += 5 * MIN + 1;
    const other = ledgerOn(db, 'boot-2');
    store.sweep();
    await Promise.all([...expiring, other.sweep({ boot: true })]);
    assert.strictEqual(owedFor(db, 'X' + i).length, 1, 'one owed row');
    assert.deepStrictEqual(withdrawn, [], 'a durable token is never paid inline beside its row');
    assert.strictEqual(db.stakes.get('X' + i).state, 'refunded');
    seen.add(/restarted/.test(owedFor(db, 'X' + i)[0].reason) ? 'sweep' : 'expiry');
    // A late second expiry of the same stake (a retry) finds it settled.
    assert.strictEqual(await live.refund('X' + i, 'refund unspent entry again'), 'settled');
    assert.strictEqual(owedFor(db, 'X' + i).length, 1);
  }
  assert.deepStrictEqual([...seen].sort(), ['expiry', 'sweep'], 'both orders happened');
});

test('a claim whose answer was lost after the row committed: the same token wins again, or is refunded once', async () => {
  const db = createMemLedgerDb();
  let t = 1e12;
  const live = ledgerOn(db, 'boot-1');
  const ghostOnce = Object.assign({}, db, {
    claimStakeSeat: async (sig, key) => { await db.claimStakeSeat(sig, key); throw new Error('connection reset'); },
  });
  const flaky = ledgerOn(ghostOnce, 'boot-1');
  const onExpire = createExpiryRefund({ money: {}, db, ledger: live, log: quiet });
  const store = makeEntryStore({ ttlMs: 5 * MIN, fees: {}, isStake, onExpire, now: () => t });

  // 1. The door's claim committed but the answer was lost: the token goes back, and the next
  //    join with it wins (the same claimKey), so it is seated, not stranded as 'consumed'.
  const tok = await stakeOn(live, store, 'G1');
  const e1 = store.consumeAtStake(tok, 0.1, 'paper');
  assert.strictEqual(await flaky.claimSeat(e1), 'error');
  e1.restore();
  assert.strictEqual(db.stakes.get('G1').state, 'consumed');
  const e2 = store.consumeAtStake(tok, 0.1, 'paper');
  assert.strictEqual(e2.ok, true);
  assert.strictEqual(await live.claimSeat(e2), 'ok');
  // Nobody else can refund it: it is seated.
  assert.strictEqual(await live.refund('G1', 'refund attempt'), 'settled');
  assert.strictEqual((await ledgerOn(db, 'boot-9').sweep({ boot: true })).owed, 0);

  // 2. Same lost answer, but the player never comes back: the token expires and its own refund
  //    (with its claimKey) gets it, once.
  const tok3 = await stakeOn(live, store, 'G2', { wallet: 'WG' });
  const e3 = store.consumeAtStake(tok3, 0.1, 'paper');
  assert.strictEqual(await flaky.claimSeat(e3), 'error');
  e3.restore();
  t += 5 * MIN + 1;
  store.sweep();
  await settle();
  assert.deepStrictEqual(owedFor(db, 'G2').map((p) => [p.wallet_address, p.amount_sol]), [['WG', 0.1]]);
  // 3. A different key (anybody but this token) can never take a consumed row.
  assert.strictEqual(await db.claimStakeSeat('G1', 'someone-else'), false);
  assert.strictEqual(await db.refundStakeOwed('G1', 'refund x', 'someone-else'), null);
});

test('a database error at the refund queues it; the retry pays once', async () => {
  const db = createMemLedgerDb();
  let down = true;
  const shaky = Object.assign({}, db, {
    refundStakeOwed: async (...a) => { if (down) throw new Error('db down'); return db.refundStakeOwed(...a); },
  });
  const ledger = ledgerOn(shaky, 'boot-1');
  await ledger.record('Q', { wallet: 'WQ', amount: 0.1, label: 'stake 0.1' });
  assert.strictEqual(await ledger.refund('Q', 'refund paper full'), 'queued');
  assert.strictEqual(ledger.queued, 1);
  assert.strictEqual(await ledger.retryQueued(), 1, 'still queued while the database is down');
  down = false;
  assert.strictEqual(await ledger.retryQueued(), 0);
  assert.strictEqual(await ledger.retryQueued(), 0);
  assert.strictEqual(owedFor(db, 'Q').length, 1);
});

test('the owed row carries a refund reason (never earnings) and the unique index refuses a second row', async () => {
  const db = createMemLedgerDb();
  const ledger = ledgerOn(db, 'b');
  await ledger.record('U', { wallet: 'WU', amount: 0.1 });
  await ledger.refund('U', 'paper full');
  assert.match(db.payouts[0].reason, /^refund /);
  // Force the state back as a broken code path would: the index still refuses a second row.
  db.stakes.get('U').state = 'pending';
  await assert.rejects(db.refundStakeOwed('U', 'refund again', null), /unique/);
  assert.strictEqual(owedFor(db, 'U').length, 1);
  assert.strictEqual(db.stakes.get('U').state, 'pending', 'the failed statement changed nothing');
});

test('without durable rows (old database or a stub) a stake works exactly as before: memory only', async () => {
  const used = new Set();
  const oldDb = { markStakeSig: async (s) => { if (used.has(s)) return false; used.add(s); return true; } };
  const ledger = ledgerOn(oldDb, 'b');
  assert.deepStrictEqual(await ledger.record('O', { wallet: 'W', amount: 0.1 }), { claimed: true, durable: false });
  assert.deepStrictEqual(await ledger.record('O', { wallet: 'W', amount: 0.1 }), { claimed: false, durable: false });
  const store = makeEntryStore({ fees: {}, isStake });
  const tok = store.mint({ stake: 0.1, worth: 0.1, paid: 0.1, walletAddress: 'W' });
  const r = store.consumeAtStake(tok, 0.1, 'snake');
  assert.deepStrictEqual(r, { ok: true, worth: 0.1, paid: 0.1, googleId: undefined, walletAddress: 'W' });
});

// ---- the Paper door ---------------------------------------------------------------------------

const createPaperSockets = require('../server/paperSockets');
const { PaperArenas } = require('../server/paper/PaperArenas');

function paperWorld({ maintenance = false, dbWrap = null } = {}) {
  const db = createMemLedgerDb();
  const ledger = ledgerOn(dbWrap ? dbWrap(db) : db, 'boot-1');
  const io = { to: () => ({ emit() {}, volatile: { emit() {} } }) };
  const hooks = { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {} };
  const arenas = new PaperArenas({ io, hooks, paidEnabled: true, autoTick: false, warm: false });
  const store = makeEntryStore({ fees: {}, isStake });
  const inline = [];
  const consume = (token, stake) => store.consumeAtStake(token, stake, 'paper');
  const paper = createPaperSockets({
    arenas, ops: { get: () => ({ maintenance }) }, socketRL: () => true,
    sanitizeName: (n) => String(n || 'Player'), isStake,
    consumePaidEntryAtStake: consume, entryStore: { consumeAtStake: consume },
    payout: { refund: (x) => inline.push(x) }, ledger, paidEnabled: true,
  });
  let n = 0;
  const sock = () => {
    const s = { id: 'sk' + ++n, handlers: {}, got: [], rooms: new Set(),
      on(ev, fn) { this.handlers[ev] = fn; }, emit(ev, p) { this.got.push([ev, p]); },
      join(r) { this.rooms.add(r); }, leave(r) { this.rooms.delete(r); },
      fire(ev, p) { this.handlers[ev](p); },
      last(ev) { const g = this.got.filter((x) => x[0] === ev); return g.length ? g[g.length - 1][1] : null; } };
    paper.attach(s);
    return s;
  };
  return { db, ledger, arenas, store, inline, sock };
}

test('Paper: a real token\'s stake row is claimed before the seat exists, and nothing is refunded', async () => {
  const w = paperWorld();
  const tok = await stakeOn(w.ledger, w.store, 'PJ', { wallet: 'WP' });
  const s = w.sock();
  s.fire('pp:join', { name: 'pat', stake: 0.1, entryToken: tok });
  assert.strictEqual(s.last('pp:joined'), null, 'not seated before the claim answered');
  assert.strictEqual(w.db.stakes.get('PJ').state, 'pending');
  await settle();
  assert.ok(s.last('pp:joined'), 'seated after the claim');
  assert.strictEqual(w.db.stakes.get('PJ').state, 'consumed');
  assert.strictEqual(w.db.payouts.length, 0);
  assert.deepStrictEqual(w.inline, []);
  // The boot sweep of a later restart does not touch a seated stake.
  assert.strictEqual((await ledgerOn(w.db, 'boot-2').sweep({ boot: true })).owed, 0);
});

test('Paper: a stake a sweep refunded first is never seated, and is not paid a second time', async () => {
  const w = paperWorld();
  const tok = await stakeOn(w.ledger, w.store, 'PS');
  await w.ledger.refund('PS', 'refund unspent entry (sweep)');
  const s = w.sock();
  s.fire('pp:join', { name: 'sam', stake: 0.1, entryToken: tok });
  await settle();
  assert.strictEqual(s.last('pp:joined'), null);
  assert.deepStrictEqual([s.last('pp:refused').why, s.last('pp:refused').refunded], ['settled', true]);
  assert.strictEqual(owedFor(w.db, 'PS').length, 1);
  assert.deepStrictEqual(w.inline, []);
});

test('Paper: the database not answering seats nothing and gives the token back', async () => {
  let fail = true;
  const w = paperWorld({ dbWrap: (db) => Object.assign({}, db, {
    claimStakeSeat: async (...a) => { if (fail) throw new Error('db down'); return db.claimStakeSeat(...a); },
  }) });
  const tok = await stakeOn(w.ledger, w.store, 'PE');
  const s = w.sock();
  s.fire('pp:join', { name: 'eve', stake: 0.1, entryToken: tok });
  await settle();
  assert.strictEqual(s.last('pp:refused').why, 'unavailable');
  assert.strictEqual(w.db.stakes.get('PE').state, 'pending');
  assert.strictEqual(w.store.size, 1, 'the token is back, unspent');
  fail = false;
  const s2 = w.sock();
  s2.fire('pp:join', { name: 'eve', stake: 0.1, entryToken: tok });
  await settle();
  assert.ok(s2.last('pp:joined'));
  assert.strictEqual(w.db.payouts.length, 0);
});

test('Paper: every refund of a real token goes through its row once (full after the claim, socket gone, maintenance)', async () => {
  // Full by the time the claim answered.
  const w = paperWorld();
  const tok = await stakeOn(w.ledger, w.store, 'PF', { wallet: 'WF' });
  const seatFor = w.arenas.seatFor.bind(w.arenas);
  let calls = 0;
  w.arenas.seatFor = (...a) => (++calls === 1 ? seatFor(...a) : null);
  const s = w.sock();
  s.fire('pp:join', { name: 'fay', stake: 0.1, entryToken: tok });
  await settle();
  assert.deepStrictEqual([s.last('pp:refused').why, s.last('pp:refused').refunded], ['full', true]);
  assert.deepStrictEqual(owedFor(w.db, 'PF').map((p) => [p.wallet_address, p.amount_sol, p.reason]),
    [['WF', 0.1, 'refund paper full']]);
  assert.strictEqual(w.db.stakes.get('PF').state, 'refunded');
  assert.strictEqual(s.last('pp:joined'), null);

  // The socket went away while the claim was in flight.
  const w2 = paperWorld();
  const tok2 = await stakeOn(w2.ledger, w2.store, 'PG');
  const s2 = w2.sock();
  s2.fire('pp:join', { name: 'gil', stake: 0.1, entryToken: tok2 });
  s2.disconnected = true;
  await settle();
  assert.strictEqual(s2.last('pp:joined'), null);
  assert.deepStrictEqual(owedFor(w2.db, 'PG').map((p) => p.reason), ['refund paper join-lost']);

  // Maintenance at the door (the token is refunded, never left to expire).
  const w3 = paperWorld({ maintenance: true });
  const tok3 = await stakeOn(w3.ledger, w3.store, 'PM');
  const s3 = w3.sock();
  s3.fire('pp:join', { name: 'mo', stake: 0.1, entryToken: tok3 });
  await settle();
  assert.strictEqual(s3.last('pp:refused').why, 'maintenance');
  assert.deepStrictEqual(owedFor(w3.db, 'PM').map((p) => p.reason), ['refund paper maintenance']);
  assert.deepStrictEqual(w3.inline, [], 'not paid inline as well');
  // And a boot sweep afterwards finds nothing to pay.
  assert.strictEqual((await ledgerOn(w3.db, 'boot-2').sweep({ boot: true })).owed, 0);
});

test('Paper: the same token re-sent on a new link while its claim is in flight is answered by that claim, never "entry"', async () => {
  const slow = (db) => Object.assign({}, db, {
    claimStakeSeat: async (...a) => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); return db.claimStakeSeat(...a); },
  });
  // The first link is gone by the time the claim answers: refunded once, and the re-send hears it.
  const w = paperWorld({ dbWrap: slow });
  const tok = await stakeOn(w.ledger, w.store, 'PR', { wallet: 'WR' });
  const s1 = w.sock();
  s1.fire('pp:join', { name: 'ray', stake: 0.1, entryToken: tok });
  s1.disconnected = true;
  const s2 = w.sock();
  s2.fire('pp:join', { name: 'ray', stake: 0.1, entryToken: tok });
  await settle(20);
  assert.deepStrictEqual([s2.last('pp:refused').why, s2.last('pp:refused').refunded], ['join-lost', true]);
  assert.deepStrictEqual(owedFor(w.db, 'PR').map((p) => p.reason), ['refund paper join-lost']);

  // The first link is still up: it is seated, and the re-send takes that same seat back.
  const v = paperWorld({ dbWrap: slow });
  const tok2 = await stakeOn(v.ledger, v.store, 'PT');
  const a = v.sock();
  a.fire('pp:join', { name: 'tia', stake: 0.1, entryToken: tok2 });
  const b = v.sock();
  b.fire('pp:join', { name: 'tia', stake: 0.1, entryToken: tok2 });
  await settle(20);
  assert.ok(a.last('pp:joined'));
  assert.ok(b.last('pp:joined'), 'the re-send took the unconfirmed seat back');
  assert.strictEqual(b.last('pp:refused'), null);
  assert.strictEqual(v.db.payouts.length, 0);
  assert.strictEqual(v.db.stakes.get('PT').state, 'consumed');
});

// ---- wiring and SQL (no Postgres on the dev machine: the statements are pinned here) ------------

test('index.js: every paid door claims the stake row before seating, submit-stake writes it, boot sweeps it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  for (const game of ['snake', 'knockout', 'battleship']) {
    assert.match(src, new RegExp(`enterPaid\\(socket, '${game}'`), game + ' goes through enterPaid');
  }
  assert.strictEqual((src.match(/enterPaid\(socket, 'snake'/g) || []).length, 2, 'snake PLAY and RESPAWN');
  /* agar.io has no paid door at all now: the old game's cell:join and cell:respawn went with it,
     and the new game (server/ag) reads no token. No consume and no enterPaid names agar. */
  assert.strictEqual((src.match(/enterPaid\(socket, 'agar'/g) || []).length, 0, 'no agar door');
  assert.doesNotMatch(src, /consumePaidEntry\([^)]*'agar'\)/, 'no agar token is ever consumed');
  const ag = ['agArenas.js', 'agBoot.js', 'agRoom.js', 'agSockets.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'server', 'ag', f), 'utf8')).join('\n');
  assert.doesNotMatch(ag, /entryToken|consumePaidEntry|enterPaid|stakeLedger|money\.withdraw/,
    'the new agar.io server reads no token and pays nothing');
  // No door reads a consumed entry's worth any more without enterPaid in between.
  assert.doesNotMatch(src, /const entry = consumePaidEntry/);
  assert.match(src, /stakeLedger\.claimSeat\(entry\)\.then/);
  assert.strictEqual((src.match(/stakeLedger\.record\(sig,/g) || []).length, 2, 'both submit-stake paths');
  assert.doesNotMatch(src, /db\.markStakeSig\(/, 'the bare claim is only reached through the ledger');
  assert.match(src, /await db\.init\(\);[\s\S]{0,400}stakeLedger\.sweep\(\{ boot: true \}\)/);
  assert.match(src, /everyStaggered\(\(\) => stakeLedger\.sweep\(\{ boot: false \}\), 300000/);
  assert.match(src, /ledger: stakeLedger,\s*paidEnabled: PAPER_PAID/);
});

test('db.js: the SQL keeps each one-time rule', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
  const fn = (name) => src.slice(src.indexOf('async function ' + name), src.indexOf('\n}\n', src.indexOf('async function ' + name)));
  assert.match(fn('claimStakeSig'), /INSERT INTO used_stake_sigs \(sig, state, wallet_address, refund_amount, label, region, boot_id\)\s*VALUES \(\$1, 'pending'/);
  assert.match(fn('claimStakeSig'), /ON CONFLICT DO NOTHING RETURNING sig/);
  assert.match(fn('claimStakeSeat'), /WHERE sig = \$1 AND \(state = 'pending' OR \(state = 'consumed' AND claim_key = \$2\)\)/);
  const refund = fn('refundStakeOwed');
  assert.match(refund, /WITH s AS \(\s*UPDATE used_stake_sigs SET state = 'refunded'/);
  assert.match(refund, /AND \(state = 'pending' OR \(\$3::text IS NOT NULL AND state = 'consumed' AND claim_key = \$3::text\)\)/);
  assert.match(refund, /INSERT INTO failed_payouts \(wallet_address, amount_sol, name, reason, stake_sig\)\s*SELECT wallet_address, refund_amount, 'Player', LEFT\(\$2::text, 500\), sig FROM s/);
  const list = fn('listUnsettledStakes');
  assert.match(list, /WHERE state = 'pending'/);
  assert.match(list, /region = \$1::text AND boot_id IS DISTINCT FROM \$2::text/);
  assert.match(src, /CREATE UNIQUE INDEX IF NOT EXISTS failed_payouts_stake_sig_uniq ON failed_payouts \(stake_sig\) WHERE stake_sig IS NOT NULL/);
  assert.match(src, /await ensureLedgerSchema\(\);/);
});
