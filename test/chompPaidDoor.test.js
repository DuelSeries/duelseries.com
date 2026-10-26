'use strict';
// Paid Chomp's door and directory (server/chomp/chompArenas.js behind agar.io's server/ag/agPaidDoor.js with Chomp's
// prefix): a token buys exactly its rung and only once, the worth and wallet come from the token alone, one open seat
// per wallet (a second buy-in reattaches and is refunded), a resume key takes the seat back, the owner's off switch
// refunds at the door, a restart hands every balance back as owed rows, the /api/live rows count open accounts, and
// the bounty bots come from the bot bank and go back to it.
const test = require('node:test');
const assert = require('node:assert');
const { ChompArenas } = require('../server/chomp/chompArenas');
const { createAgPaidDoor } = require('../server/ag/agPaidDoor');
const { openChomp, paidSwitch } = require('../server/chomp/chompBoot');

const quiet = { error() {}, warn() {}, log() {} };

function hooks() {
  const calls = { cashout: [], refund: [], owed: [], stake: [], house: [], transfer: [], breach: [], journal: [] };
  return {
    calls,
    h: {
      onCashout: (o) => calls.cashout.push(o),
      onRefund: (o) => calls.refund.push(o),
      onTransfer: (t) => calls.transfer.push(t),
      onBreach: (b) => calls.breach.push(b),
      onStake: (s) => calls.stake.push(s),
      onHouse: (x) => calls.house.push(x),
      onOwed: (row, live) => calls.owed.push(Object.assign({ live }, row)),
      onSweep: () => {},
      journal: { open: (a, room) => calls.journal.push(['open', a.jid, room]), close: (a, o) => calls.journal.push(['close', a.jid, o]) },
    },
  };
}

function tokens() {
  const map = new Map();
  let n = 0;
  return {
    mint(stake, wallet) { const t = 'tok-' + ++n; map.set(t, { stake, worth: stake, paid: stake, walletAddress: wallet }); return t; },
    consumeAtStake(t, stake) {
      const e = map.get(t);
      if (!e || Math.abs(e.stake - stake) > 1e-9) return { ok: false, worth: 0 };
      map.delete(t);
      return Object.assign({ ok: true }, e);
    },
  };
}

let sn = 0;
function sock(id) {
  return {
    id: id || 'k' + ++sn, disconnected: false, events: [], rooms: new Set(),
    emit(ev, p) { this.events.push([ev, p]); },
    of(ev) { return this.events.filter((e) => e[0] === ev).map((e) => e[1]); },
    join(r) { this.rooms.add(r); }, leave(r) { this.rooms.delete(r); },
    disconnect() { this.disconnected = true; },
  };
}

function setup(opts) {
  const o = opts || {};
  const hk = hooks();
  const tk = tokens();
  const clock = { t: 9000000 };
  const refunds = [];
  const arenas = new ChompArenas(Object.assign({ paid: true, moneyHooks: hk.h, mx: 1, my: 1, seed: 5, log: quiet,
    now: () => clock.t, timers: { setTimeout: () => 0, clearTimeout: () => {} } }, o.arenas));
  for (const r of [arenas.free]) r.ghosts = [];
  const door = createAgPaidDoor({ arenas, consumeAtStake: (t, s) => tk.consumeAtStake(t, s), refund: (x) => refunds.push(x),
    cleanName: (n) => (typeof n === 'string' ? n.slice(0, 15) : ''), log: quiet, ev: 'c', game: 'chomp', now: () => clock.t++ * 1000 });
  return { arenas, door, tk, calls: hk.calls, refunds, clock };
}

test('a token buys a seat at exactly its rung, its worth and wallet from the token only', () => {
  const w = setup();
  const s = sock();
  const t = w.tk.mint(0.5, 'W1');
  w.door.join(s, { name: 'ann', stake: 0.5, entryToken: t, micro: 99e9, wallet: 'EVIL' });
  const j = s.of('c:joined')[0];
  assert.ok(j, 'joined');
  assert.strictEqual(j.stake, 0.5);
  assert.strictEqual(j.micro, 500000);
  assert.strictEqual(j.confirmed, false);
  assert.ok(s.of('c:init').length === 1 && s.of('c:init')[0].stake === 0.5, 'the paid room\'s init');
  const room = w.arenas.paidRoomOf(s.id);
  assert.ok(room && room.stake === 0.5);
  assert.strictEqual(room.money.account(j.id).wallet, 'W1');
  // the same token again from another socket: its unconfirmed seat moves, nothing new is bought
  const s2 = sock();
  w.door.join(s2, { name: 'ann', stake: 0.5, entryToken: t });
  assert.strictEqual(s2.of('c:joined')[0].resumed, true);
  assert.strictEqual(room.money.openCount(), 1);
  // a token at the wrong rung is refused untouched
  const s3 = sock();
  const t2 = w.tk.mint(1, 'W2');
  w.door.join(s3, { name: 'bob', stake: 0.5, entryToken: t2 });
  assert.strictEqual(s3.of('c:refused')[0].why, 'entry');
});

test('one open seat per wallet: a second buy-in takes the seat back and is refunded', () => {
  const w = setup();
  const a = sock();
  w.door.join(a, { name: 'ann', stake: 1, entryToken: w.tk.mint(1, 'W1') });
  w.arenas.ready(a.id);
  const b = sock();
  w.clock.t += 10;
  w.door.join(b, { name: 'ann', stake: 0.5, entryToken: w.tk.mint(0.5, 'W1') });
  assert.strictEqual(w.refunds.length, 1);
  assert.strictEqual(w.refunds[0].why, 'reattach');
  assert.strictEqual(b.of('c:joined')[0].stake, 1, 'back in the $1 seat');
  assert.strictEqual(a.of('c:replaced').length, 1);
});

test('a resume key takes the seat back after a drop; the remembered outcome answers after it closed', () => {
  const w = setup();
  const a = sock();
  w.door.join(a, { name: 'ann', stake: 0.5, entryToken: w.tk.mint(0.5, 'W1') });
  const j = a.of('c:joined')[0];
  w.arenas.ready(a.id);
  w.arenas.disconnect(a.id);
  const room = w.arenas.rungs.get(0.5)[0];
  assert.strictEqual(room.money.account(j.id).state, 'grace');
  const b = sock();
  w.clock.t += 10;
  w.door.join(b, { name: 'ann', stake: 0.5, resumeKey: j.resumeKey });
  assert.strictEqual(b.of('c:joined')[0].resumed, true);
  assert.strictEqual(room.money.account(j.id).state, 'live');
  // cash out, then the key answers with the receipt
  room.money.completeCashout(j.id, 'cashedout');
  const c = sock();
  w.clock.t += 10;
  w.door.join(c, { name: 'ann', stake: 0.5, resumeKey: j.resumeKey });
  assert.strictEqual(c.of('c:cashedout')[0].resumed, true);
});

test('the owner\'s off switch refunds new paid joins at the door; seated players play on', () => {
  const w = setup();
  const a = sock();
  w.door.join(a, { name: 'ann', stake: 0.5, entryToken: w.tk.mint(0.5, 'W1') });
  w.arenas.paidOpen = false;
  const b = sock();
  w.door.join(b, { name: 'bob', stake: 0.5, entryToken: w.tk.mint(0.5, 'W2') });
  const r = b.of('c:refused')[0];
  assert.strictEqual(r.why, 'not-open');
  assert.strictEqual(r.refunded, true);
  assert.strictEqual(w.refunds[0].wallet, 'W2');
  assert.strictEqual(w.arenas.paidOpenCount(), 1);
  const row = w.arenas.boardRows().find((x) => x.stake === 0.5);
  assert.strictEqual(row.state, 'closed');
  assert.strictEqual(row.players, 1);
});

test('a restart hands every open balance back as owed rows and closes the door', () => {
  const w = setup();
  const a = sock();
  w.door.join(a, { name: 'ann', stake: 0.5, entryToken: w.tk.mint(0.5, 'W1') });
  w.arenas.ready(a.id);
  const b = sock();
  w.door.join(b, { name: 'bob', stake: 1, entryToken: w.tk.mint(1, 'W2') });
  const rows = w.arenas.shutdownSettle('shutdown');
  assert.deepStrictEqual(rows.map((r) => [r.wallet, r.micro]).sort(), [['W1', 500000], ['W2', 1000000]]);
  assert.ok(w.arenas.stopping && !w.arenas.paidOpen);
  const c = sock();
  w.door.join(c, { name: 'cy', stake: 0.5, entryToken: w.tk.mint(0.5, 'W3') });
  assert.strictEqual(c.of('c:refused')[0].why, 'restarting');
  assert.strictEqual(w.arenas.all().reduce((t, r) => t + r.liveStakeTotal(), 0), 0);
});

test('/api/live rows: one per rung, players = open accounts (away ones too), free row with the free room\'s people', () => {
  const w = setup();
  const a = sock();
  w.door.join(a, { name: 'ann', stake: 0.5, entryToken: w.tk.mint(0.5, 'W1') });
  w.arenas.ready(a.id);
  w.arenas.disconnect(a.id);
  const rows = w.arenas.boardRows();
  assert.deepStrictEqual(rows.map((r) => r.id), ['chomp:na:s0', 'chomp:na:s0.5', 'chomp:na:s1']);
  const r5 = rows[1];
  assert.strictEqual(r5.players, 1);
  assert.strictEqual(r5.parked, 1);
  assert.strictEqual(w.arenas.liveCount(), 0, 'away seats are parked, not playing');
});

test('bounty bots: seeded from the bot bank, removed bots give the seed back, never more than asked', () => {
  const bank = { taken: 0, back: 0, whyNot: () => null, take(m) { this.taken += m; return true; }, giveBack(m) { this.back += m; return true; }, spent() {} };
  const saved = [];
  const w = setup({ arenas: { botBank: bank, botStore: { load: () => null, save: (o) => { saved.push(o); return true; } } } });
  const r = w.arenas.setBotTarget(0.5, 3);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.live, 3);
  assert.strictEqual(bank.taken, 1500000);
  const room = w.arenas.rungs.get(0.5)[0];
  assert.strictEqual(room.money.bank.totalMicro(), 1500000);
  assert.ok(room.awake, 'a room with bots ticks with nobody in it');
  w.arenas.setBotTarget(0.5, 1);
  assert.strictEqual(bank.back, 1000000);
  assert.strictEqual(room.botCount, 1);
  assert.deepStrictEqual(saved[saved.length - 1], { 0.5: 1 });
  assert.strictEqual(w.arenas.setBotTarget(0.5, 41).ok, false);
});

test('the boot switches: CHOMP_PAID fails closed on a typo, and the paid rungs need the money wired', () => {
  assert.strictEqual(paidSwitch('', quiet), true);
  assert.strictEqual(paidSwitch('off', quiet), false);
  assert.strictEqual(paidSwitch('maybe', quiet), false);
  const g = openChomp({ io: null, env: { CHOMP: '1' }, log: quiet, autoTick: false });
  assert.strictEqual(g.paid, false, 'no money hooks: no paid rungs');
  g.close();
  const hk = hooks();
  const g2 = openChomp({ io: null, env: { CHOMP: '1', CHOMP_PAID: '1' }, log: quiet, autoTick: false,
    money: { hooks: hk.h, door: { consumeAtStake: () => ({ ok: false }), refund: () => {} } },
    paidSwitch: { closedAtBoot: () => ({ closed: true, why: 'saved' }) } });
  assert.strictEqual(g2.paid, true);
  assert.strictEqual(g2.arenas.paidOpen, false, 'a saved chomp:paid:off opens the door shut');
  g2.close();
});
