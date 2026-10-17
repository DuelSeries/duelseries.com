'use strict';
// Paid Paper at a restart or a crash (security review item a, 2026-10-15). Before this, Paper had no shutdown settle:
// every seated paid balance was lost on every deploy, crash or restart. Paper now gets what paid agar and paid snake
// have (Owen Q6): a settle that withdraws every paid account and owes 100% of its CURRENT balance through the owed
// lane (one row per 'agowed:<jid>' key), each account opened and closed in the shared money journal so the crash path
// (no time to write) is replayed once at the next boot, and the paid door's owner switch (security review item b).
// Real modules: PaperArenas and PaperRoom (the real sim), the real agJournal on a temp file, agShutdown's real settle
// and crash install, slPaidBoot.composePaidShutdown (the composite server/index.js hands both), and the real
// paperSockets door with token fakes. The database is an owed store with db.recordOwedOnce's rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PaperArenas } = require('../server/paper/PaperArenas');
const { REASON, P } = require('../server/paper/ArenaGame');
const { agShutdownSettle, installAgCrashLog } = require('../server/ag/agShutdown');
const { createAgJournal } = require('../server/ag/agJournal');
const { composePaidShutdown } = require('../server/slPaid/slPaidBoot');
const createPaperSockets = require('../server/paperSockets');
const { isStake } = require('../server/stakeRules');

const KEY_RE = /^agowed:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const C = 1000;
const at = (r, a) => new P.Vec2(C + Math.cos(a) * r, C + Math.sin(a) * r);

const quiet = () => {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')),
    error: (...a) => lines.push(a.join(' ')) };
};

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppshut-')), 'ag-money-journal.log');
}

function records(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// db.recordOwedOnce's rule: one row per key, 'exists' after
function owedStore() {
  const rows = new Map();
  return {
    rows,
    write(r) {
      if (rows.has(r.key)) return Promise.resolve('exists');
      rows.set(r.key, Object.assign({}, r));
      return Promise.resolve('owed');
    }
  };
}

function world({ file = null, paidEnabled = true } = {}) {
  let t = 5000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const emits = [];
  const io = { to: (target) => ({ emit: (ev, p) => emits.push([target, ev, p]), volatile: { emit() {} } }) };
  const calls = { cashout: [], refund: [], sweep: [], breach: [] };
  const hooks = {
    onCashout: (o) => calls.cashout.push(o),
    onTransfer() {},
    onRefund: (x) => calls.refund.push(x),
    onSweep: (x) => calls.sweep.push(x),
    onBreach: (x) => calls.breach.push(x)
  };
  const journal = file ? createAgJournal({ file, bootId: 'b1', log: quiet() }) : null;
  const arenas = new PaperArenas({ io, hooks, now: clock.now, paidEnabled, autoTick: false, warm: false, journal });
  return { arenas, clock, emits, calls, journal };
}

// The rung's first arena, with room for the spots below.
function paidArena(w, stake = 1) {
  const room = w.arenas.seatFor(stake).room;
  room.game.radiusTarget = () => 950;
  room.game.setRadiusNow(950);
  return room;
}

let sn = 0;
function sock() {
  return { id: 'ps' + ++sn, got: [], rooms: new Set(), join(r) { this.rooms.add(r); }, leave(r) { this.rooms.delete(r); },
    emit(ev, p) { this.got.push([ev, p]); } };
}

function seat(room, spot, { micro = 1000000, wallet, confirmed = true, paid, stakeSig } = {}) {
  const s = sock();
  const st = room.addHuman(s, { name: 'n-' + s.id, micro, wallet: wallet || 'W-' + s.id, spot, proof: 'proof-' + s.id,
    paid, stakeSig });
  st.unit.locked = false;
  if (confirmed) room._confirm(st);
  return { s, seat: st, u: st.unit, wallet: st.wallet };
}

// A paid arena with: A (killed B, holds 2 deposits), C (dropped its money as a floor coin), D (unconfirmed, its
// stake landed 1% short), E (confirmed, untouched).
function scene(w) {
  const room = paidArena(w, 1);
  const a = seat(room, at(300, 0.3), { stakeSig: 'SIG-A' });
  const b = seat(room, at(300, 1.6));
  const c = seat(room, at(300, 2.9));
  const d = seat(room, at(300, 4.2), { confirmed: false, paid: 0.99 });
  const e = seat(room, at(300, 5.5));
  room.game.kill(b.u, a.u, REASON.TRACK_CUT);
  grab(room, a.u.id);
  room.game.kill(c.u, undefined, REASON.SELF_CROSS);
  assert.equal(room.bank.balance(a.u.id), 2000000, 'A took B\'s money');
  assert.equal(room.bank.floorMicro(), 1000000, 'C\'s money lies on the floor');
  return { room, a, b, c, d, e };
}


// Owen 2026-10-17: a kill drops the victim's money as a coin where it died; the killer must pick it up. The newest
// coin (the one the last death dropped) collected by a unit, as walking over it would.
function grab(room, unitId) {
  const ps = room.bank.pickups();
  const p = ps[ps.length - 1];
  return room.bank.collect(p.pid, unitId);
}

test('a restart owes every paid Paper balance 100% of what it holds now, one keyed row each, written once', async () => {
  const file = tmpFile();
  const w = world({ file });
  const { room, a, c, d, e } = scene(w);
  const all = composePaidShutdown([w.arenas]);
  const store = owedStore();
  const lg = quiet();
  const rows = await agShutdownSettle({ arenas: all, writeRow: store.write, log: lg, waitMs: 500 });
  const byWallet = new Map(rows.map((r) => [r.wallet, r]));
  assert.equal(rows.length, 3, 'A, D and E; B and C have nothing left');
  assert.equal(byWallet.get(a.wallet).micro, 2000000, 'A is owed his CURRENT balance, winnings included, no rake');
  assert.equal(byWallet.get(e.wallet).micro, 1000000);
  assert.equal(byWallet.get(d.wallet).micro, 990000, 'an unconfirmed seat\'s buy-in is bounded by what landed');
  for (const r of rows) {
    assert.match(r.key, KEY_RE);
    assert.ok(r.reason.startsWith('refund paper shutdown ' + room.lobbyType) && r.reason.includes(r.key), r.reason);
  }
  assert.equal(new Set(rows.map((r) => r.key)).size, 3, 'one key per account');
  assert.equal(store.rows.size, 3, 'each row written through writeRow once');
  assert.equal(lg.lines.filter((l) => l.startsWith('[AG] SHUTDOWN-OWED')).length, 3);
  // nothing paid in the exit window, nothing left in the arena, the door shut for good
  assert.deepEqual([w.calls.cashout.length, w.calls.refund.length, w.calls.sweep.length], [0, 0, 0]);
  assert.equal(room.bank.totalMicro(), 0);
  assert.ok(room.bank.assertConserved());
  assert.equal(room.stopped, true);
  assert.deepEqual([w.arenas.stopping, w.arenas.paidOpen], [true, false]);
  assert.equal(w.arenas.seatFor(1), null, 'nothing paid is seated or created while going down');
  assert.equal(w.arenas.paidOpenCount(), 0);
  // a second settle (SIGTERM after SIGINT) owes nothing more
  assert.deepEqual(all.shutdownSettle('shutdown'), []);
  // the seated sockets are told, with their refund
  const told = w.emits.filter((x) => x[1] === 'pp:refused' && x[2].why === 'restarting');
  assert.equal(told.length, 3);
  assert.ok(told.every((x) => x[2].refunded === true && typeof x[2].text === 'string'));
  // the journal: every seat opened, every one closed once; the settle's closes carry the owed rows
  const recs = records(file);
  const opens = recs.filter((r) => r.t === 'open');
  assert.equal(opens.length, 5, 'every paid seat opened in the journal');
  assert.equal(opens.find((r) => r.wallet === a.wallet).stakeSig, 'SIG-A', 'the stake row is named for a hand reconcile');
  const closes = recs.filter((r) => r.t === 'close');
  assert.equal(closes.length, 5, 'and closed exactly once each');
  const outcome = (wl) => closes.find((x) => x.jid === opens.find((o) => o.wallet === wl).jid);
  assert.equal(outcome(a.wallet).outcome, 'refunded');
  assert.equal(outcome(a.wallet).micro, 2000000);
  assert.equal(outcome(a.wallet).key, byWallet.get(a.wallet).key);
  assert.equal(outcome(c.wallet).outcome, 'dropped');
  const floor = recs.filter((r) => r.t === 'floor');
  assert.equal(floor.length, 1, 'the floor coin is one floor record');
  assert.match(floor[0].key, /^ppfloor:[0-9a-f-]{36}$/);
  assert.deepEqual([floor[0].micro, floor[0].why, floor[0].room], [1000000, 'shutdown', room.lobbyType]);
  assert.deepEqual(floor[0].bySource.map((s) => [s.srcWallet, s.micro]), [[c.wallet, 1000000]]);
  // the next boot: every row already written answers exists, the floor is booked to the house once, nobody unsettled
  const boot = createAgJournal({ file, bootId: 'b2', log: quiet() });
  boot.rotate();
  const booked = [];
  const s = await boot.replay({ writeOwedOnce: store.write, bookFloor: (rec) => booked.push(rec.key) });
  assert.deepEqual([s.owed, s.existed, s.unsettled, s.floors, s.floorMicro], [0, 3, 0, 1, 1000000]);
  assert.deepEqual(booked, [floor[0].key]);
  assert.equal(store.rows.size, 3, 'never owed twice');
});

test('a crash journals every paid Paper balance with no write; the next boot owes each row exactly once', async () => {
  const file = tmpFile();
  const w = world({ file });
  const { a, d, e } = scene(w);
  const want = new Map([[a.wallet, 2000000], [d.wallet, 990000], [e.wallet, 1000000]]);
  const proc = new EventEmitter();
  const lg = quiet();
  installAgCrashLog({ arenas: composePaidShutdown([w.arenas]), log: lg, proc });
  proc.emit('uncaughtExceptionMonitor', new Error('boom'));
  assert.equal(lg.lines.filter((l) => l.startsWith('[AG] CRASH-OWED')).length, 3);
  const closes = records(file).filter((r) => r.t === 'close' && r.outcome === 'refunded');
  assert.equal(closes.length, 3);
  assert.ok(closes.every((c) => c.why === 'crash' && KEY_RE.test(c.key) && c.reason.startsWith('refund paper crash')));
  // the next boot writes each owed row once; a replay of the same records again answers exists
  const store = owedStore();
  const copy = fs.readFileSync(file, 'utf8');
  const boot = createAgJournal({ file, bootId: 'b2', log: quiet() });
  boot.rotate();
  const s1 = await boot.replay({ writeOwedOnce: store.write, bookFloor: () => {} });
  assert.deepEqual([s1.owed, s1.existed, s1.unsettled, s1.floors], [3, 0, 0, 1]);
  assert.deepEqual(new Map([...store.rows.values()].map((r) => [r.wallet, r.micro])), want,
    'each player owed what he held at the crash');
  fs.writeFileSync(file, copy);
  const again = createAgJournal({ file, bootId: 'b3', log: quiet() });
  again.rotate();
  const s2 = await again.replay({ writeOwedOnce: store.write, bookFloor: () => {} });
  assert.deepEqual([s2.owed, s2.existed], [0, 3]);
  assert.equal(store.rows.size, 3, 'exactly once');
});

test('a kill that runs no code flags each open Paper seat UNSETTLED-AT-BOOT; seats that left normally are closed', async () => {
  const file = tmpFile();
  const w = world({ file });
  const room = paidArena(w, 0.5);
  const a = seat(room, at(300, 0.3), { micro: 500000 });
  const b = seat(room, at(300, 2.3), { micro: 500000 });
  const c = seat(room, at(300, 4.3), { micro: 500000, confirmed: false, paid: 0.5 });
  room.completeCashout(a.u);                     // cashed out: closed 'cashedout', paid through onCashout
  room.releaseUnconfirmed(c.seat, 'join-lost');  // refunded before its first input: closed 'released'
  assert.equal(w.calls.cashout.length, 1);
  assert.equal(w.calls.refund.length, 1);
  const recs = records(file);
  const closeOf = (wl) => recs.find((x) => x.t === 'close' && x.jid === recs.find((o) => o.t === 'open' && o.wallet === wl).jid);
  assert.equal(closeOf(a.wallet).outcome, 'cashedout');
  assert.equal(closeOf(c.wallet).outcome, 'released');
  // killed: no settle at all
  const lines = [];
  const alerts = [];
  const boot = createAgJournal({ file, bootId: 'b2', log: { log() {}, warn() {}, error: (m) => lines.push(m) } });
  boot.rotate();
  const s = await boot.replay({ writeOwedOnce: owedStore().write, alert: (x) => alerts.push(x) });
  assert.deepEqual([s.owed, s.unsettled, s.unsettledMicro], [0, 1, 500000]);
  assert.ok(lines.some((l) => l.startsWith('[AG] UNSETTLED-AT-BOOT ' + b.wallet + ' deposit 500000 micro room ' + room.lobbyType)));
  assert.deepEqual(alerts, [{ kind: 'unsettled-at-boot', accounts: 1, totalMicro: 500000 }]);
});

test('a settle that cannot reach one arena still settles the others; free arenas owe nothing', () => {
  const w = world({ file: tmpFile() });
  const half = paidArena(w, 0.5);
  const one = paidArena(w, 1);
  seat(half, at(300, 0.5), { micro: 500000 });
  const ok = seat(one, at(300, 0.5));
  half.shutdownSettle = () => { throw new Error('broken arena'); };
  const rows = composePaidShutdown([w.arenas]).shutdownSettle('crash');
  assert.deepEqual(rows.map((r) => [r.wallet, r.micro]), [[ok.wallet, 1000000]]);
  const free = w.arenas.all().find((r) => r.stake === 0);
  assert.ok(free);
  assert.deepEqual(free.shutdownSettle('shutdown'), []);
});

// ------------------------------------------------------------------------------------------------ the paid door

function doorWorld({ ledger = null } = {}) {
  const w = world({});
  const tokens = new Map();
  const spy = { consume: [], refunds: [] };
  const take = (token, stake) => {
    stake = Number(stake);
    if (stake === 0) return { ok: true, worth: 0 };
    const tk = typeof token === 'string' && tokens.get(token);
    if (!tk || Math.abs(tk.stake - stake) > 1e-9) return { ok: false, worth: 0 };
    tokens.delete(token);
    return Object.assign({ ok: true }, tk);
  };
  const paper = createPaperSockets({
    arenas: w.arenas,
    ops: { get: () => ({ maintenance: false }) },
    socketRL: () => true,
    sanitizeName: (n) => String(n == null ? '' : n).slice(0, 20) || 'Player',
    isStake,
    consumePaidEntryAtStake(token, stake) {
      const r = take(token, stake);
      spy.consume.push([token, r.ok]);
      return r;
    },
    entryStore: { consumeAtStake: (token, stake) => { const r = take(token, stake); spy.consume.push([token, r.ok]); return r; } },
    payout: { refund: (x) => spy.refunds.push(x) },
    ledger,
    paidEnabled: true
  });
  let n = 0;
  const mint = (stake, extra) => {
    const token = 'tok' + ++n;
    tokens.set(token, Object.assign({ stake, worth: stake, paid: stake, walletAddress: 'WD' + n }, extra || {}));
    return token;
  };
  const socket = () => {
    const s = Object.assign(sock(), { handlers: {}, on(ev, fn) { this.handlers[ev] = fn; },
      fire(ev, p) { this.handlers[ev](p); },
      last(ev) { const g = this.got.filter((x) => x[0] === ev); return g.length ? g[g.length - 1][1] : null; } });
    paper.attach(s);
    return s;
  };
  return Object.assign(w, { paper, spy, mint, socket, tokens });
}

test('paper:paid:off (paidOpen false): a NEW paid join is refunded not-open; a seated player still resumes', () => {
  const w = doorWorld();
  const s1 = w.socket();
  s1.fire('pp:join', { name: 'seated', stake: 0.5, entryToken: w.mint(0.5) });
  const joined = s1.last('pp:joined');
  assert.ok(joined, 'seated while open');
  w.arenas.paidOpen = false;
  // the board says closed, so the lobby asks for no money
  const rows = w.arenas.boardRows().filter((r) => r.stake > 0);
  assert.ok(rows.length && rows.every((r) => r.state === 'closed'));
  assert.equal(w.arenas.boardRows().find((r) => r.stake === 0).state, 'open', 'free stays open');
  const s2 = w.socket();
  const tok = w.mint(0.5, { walletAddress: 'WLATE' });
  s2.fire('pp:join', { name: 'late', stake: 0.5, entryToken: tok });
  assert.deepEqual([s2.last('pp:refused').why, s2.last('pp:refused').refunded], ['not-open', true]);
  assert.equal(w.spy.refunds.length, 1);
  assert.deepEqual([w.spy.refunds[0].wallet, w.spy.refunds[0].micro, w.spy.refunds[0].why], ['WLATE', 500000, 'not-open']);
  assert.equal(w.tokens.has(tok), false, 'the token is spent once, by its refund');
  // the seated player's link drops and comes back by resumeKey: still his seat
  const seatNow = w.arenas.seatOfSocket(s1.id);
  seatNow.room._confirm(seatNow); // the page steered (its first pp:in)
  seatNow.room.beginGrace(seatNow);
  // (the page holds its resumeKey from pp:joined; here it is read off the seat)
  const s3 = w.socket();
  s3.fire('pp:join', { name: 'seated', stake: 0.5, resumeKey: seatNow.resumeKey });
  assert.ok(s3.last('pp:joined'), 'a seated player resumes under the close');
  assert.equal(s3.last('pp:refused'), null);
  // reopened: new joins seat again
  w.arenas.paidOpen = true;
  const s4 = w.socket();
  s4.fire('pp:join', { name: 'again', stake: 0.5, entryToken: w.mint(0.5) });
  assert.ok(s4.last('pp:joined'));
});

test('a restart in progress refuses a paid join before its token is spent (its stake row stays for the boot sweep)', () => {
  const w = doorWorld();
  w.arenas.shutdownSettle('shutdown');
  const s = w.socket();
  const tok = w.mint(0.5);
  s.fire('pp:join', { name: 'x', stake: 0.5, entryToken: tok });
  assert.deepEqual([s.last('pp:refused').why, s.last('pp:refused').refunded], ['restarting', false]);
  assert.equal(w.tokens.has(tok), true, 'untouched');
  assert.equal(w.spy.consume.length, 0);
});

test('a durable join whose claim lands after paper:paid:off or a restart is refunded through its stake row, never seated', async () => {
  for (const flip of ['off', 'restart']) {
    let release;
    const gate = new Promise((r) => { release = r; });
    const ledger = {
      claims: [],
      refunds: [],
      claimSeat(entry) { this.claims.push(entry.stakeSig); return gate.then(() => 'ok'); },
      refund(sig, reason, claimKey) { this.refunds.push([sig, reason, claimKey]); return Promise.resolve('owed'); }
    };
    const w = doorWorld({ ledger });
    const s = w.socket();
    s.fire('pp:join', { name: 'x', stake: 0.5, entryToken: w.mint(0.5, { stakeSig: 'SIG-' + flip, claimKey: 'CK-' + flip }) });
    assert.deepEqual(ledger.claims, ['SIG-' + flip]);
    if (flip === 'off') w.arenas.paidOpen = false;
    else w.arenas.shutdownSettle('shutdown');
    release();
    await gate;
    await new Promise((r) => setImmediate(r));
    const why = flip === 'off' ? 'not-open' : 'restarting';
    assert.deepEqual([s.last('pp:refused').why, s.last('pp:refused').refunded], [why, true], flip);
    assert.deepEqual(ledger.refunds, [['SIG-' + flip, 'refund paper ' + why, 'CK-' + flip]], flip);
    assert.equal(s.last('pp:joined'), null, flip + ': never seated');
  }
});

test('a durable seat names its stake row in the journal open', () => {
  const file = tmpFile();
  const w = world({ file });
  const room = paidArena(w, 0.5);
  seat(room, at(300, 1), { micro: 500000, stakeSig: 'SIG-OPEN' });
  const open = records(file).find((r) => r.t === 'open');
  assert.deepEqual([open.micro, open.room, open.stakeSig, 'door' in open], [500000, room.lobbyType, 'SIG-OPEN', false]);
});
