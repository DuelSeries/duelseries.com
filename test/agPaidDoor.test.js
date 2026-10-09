'use strict';
// The paid agar.io directory and door (PAID-AGAR-DESIGN.md 5.3 to 5.5; checklist steps 7 and 8): paid rungs only
// with AG_PAID, row shapes, the off switch, seatless hand-off sockets, one seat per wallet, remembered outcomes, the
// door's order contract, every refund exactly once with a 'refund agar' reason, the rate limit, maintenance before the
// free join's answer, token-proof reattach, the two-token race, hostile payloads, resume, and ag:leave refused.
const test = require('node:test');
const assert = require('node:assert');
const { AgArenas, PAID_SEATLESS_MS, OUTCOME_TTL_MS } = require('../server/ag/agArenas');
const { createAgPaidDoor, wantsPaid, proofOf } = require('../server/ag/agPaidDoor');
const { attachAgSockets } = require('../server/ag/agSockets');
const { AG_MONEY } = require('../server/ag/agMoney');
const { FIXTURE } = require('./agLawsFixture');

const quiet = { error() {}, warn() {}, log() {} };
const tick = () => new Promise((res) => setImmediate(res));

function fakeTimers() {
  const list = [];
  return {
    list,
    setTimeout(fn, ms) { const t = { fn, ms, done: false }; list.push(t); return t; },
    clearTimeout(t) { if (t) t.done = true; },
    fire() { for (const t of list.slice()) if (!t.done) { t.done = true; t.fn(); } },
  };
}

function hooksRec() {
  const calls = { cashout: [], refund: [], transfer: [], feed: [], breach: [], stake: [], house: [] };
  return {
    calls,
    hooks: {
      onCashout: (o) => calls.cashout.push(o), onRefund: (o) => calls.refund.push(o),
      onTransfer: (t) => calls.transfer.push(t), onFeed: (f) => calls.feed.push(f),
      onBreach: (b) => calls.breach.push(b), onStake: (s) => calls.stake.push(s), onHouse: (h) => calls.house.push(h),
    },
  };
}

// A one-time token store like entryStore's consumeAtStake: tokens for a stake, a worth and a wallet.
function tokenStore() {
  const tokens = new Map();
  const consumed = [];
  let n = 0;
  return {
    consumed,
    mint(o) {
      const t = 'tok-' + ++n + '-' + Math.random().toString(16).slice(2, 10);
      tokens.set(t, Object.assign({ stake: 0.1, worth: 0.1, paid: 0.1, walletAddress: 'W1' }, o));
      return t;
    },
    consumeAtStake(token, stake) {
      consumed.push(token);
      const r = tokens.get(token);
      if (!r || Math.abs(r.stake - stake) > 1e-9) return { ok: false, worth: 0 };
      tokens.delete(token);
      const out = Object.assign({ ok: true }, r);
      out.restore = () => { if (!tokens.has(token)) tokens.set(token, r); };
      return out;
    },
    has: (t) => tokens.has(t),
  };
}

function setup(opts) {
  const o = opts || {};
  const clock = { t: 7000000 };
  const timers = fakeTimers();
  const rec = hooksRec();
  const arenas = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 3, log: quiet,
    paid: o.paid !== false, moneyHooks: rec.hooks, now: () => clock.t, timers });
  const store = tokenStore();
  const refunds = [];
  const ledgerRefunds = [];
  const claims = [];
  const ledger = {
    answer: 'ok',
    claimSeat(entry) { claims.push(entry); return Promise.resolve(this.answer); },
    refund(sig, reason, claimKey) { ledgerRefunds.push({ sig, reason, claimKey }); return Promise.resolve(); },
  };
  const ops = { m: false, get() { return { maintenance: this.m }; } };
  const door = createAgPaidDoor({ arenas, consumeAtStake: (t, s) => store.consumeAtStake(t, s), ledger,
    refund: (x) => refunds.push(x), ops, cleanName: (x) => (typeof x === 'string' ? x.slice(0, 15) : null),
    clientIp: () => '9.9.9.9', now: () => clock.t, log: quiet });
  return { clock, timers, arenas, store, refunds, ledgerRefunds, claims, ledger, ops, door, calls: rec.calls };
}

let sn = 0;
function sock(id) {
  return {
    id: id || 'd' + ++sn,
    conn: { writeBuffer: [] },
    events: [],
    disconnected: false,
    handshake: { auth: {}, headers: {}, address: '1.1.1.1' },
    handlers: {},
    emit(ev, p) { this.events.push([ev, p]); },
    on(ev, fn) { this.handlers[ev] = fn; },
    fire(ev, msg) { this.handlers[ev](msg); },
    disconnect() { this.disconnected = true; },
    of(ev) { return this.events.filter((e) => e[0] === ev).map((e) => e[1]); },
    last(ev) { const l = this.of(ev); return l[l.length - 1]; },
  };
}

function joinPaid(env, socket, msg) {
  env.clock.t += 1000;   // past the door's own rate limit
  env.door.join(socket, Object.assign({ stake: 0.1, name: 'n' }, msg));
}

function roomOf(env, socket) {
  return env.arenas.paidRoomOf(socket.id);
}

test('wantsPaid: a stake above 0, an entryToken or a resumeKey goes to the paid door; a free Play stays free', () => {
  assert.strictEqual(wantsPaid({ name: 'x' }), false);
  assert.strictEqual(wantsPaid({ stake: 0 }), false);
  assert.strictEqual(wantsPaid({ stake: '0' }), false);
  assert.strictEqual(wantsPaid({ stake: 0.1 }), true);
  assert.strictEqual(wantsPaid({ stake: 0.10499 }), true, 'not a rung: the door refuses it (bad-stake)');
  assert.strictEqual(wantsPaid({ entryToken: 't' }), true);
  assert.strictEqual(wantsPaid({ resumeKey: 'k' }), true);
  assert.strictEqual(wantsPaid([]), false);
  assert.strictEqual(wantsPaid(null), false);
});

test('paid rungs exist only with AG_PAID; rows keep the ag:<region>:s<stake> ids, count every open account, no bots', () => {
  const off = setup({ paid: false });
  assert.deepStrictEqual(off.arenas.boardRows().map((r) => r.stake), [0]);
  assert.strictEqual(off.arenas.seatFor(0.1), null);
  const env = setup();
  const rows = env.arenas.boardRows();
  assert.deepStrictEqual(rows.map((r) => r.id), ['ag:na:s0', 'ag:na:s0.1', 'ag:na:s1']);
  const paid = rows[1];
  assert.deepStrictEqual(paid, { id: 'ag:na:s0.1', game: 'agar', region: 'na', stake: 0.1, players: 0, parked: 0,
    bots: 0, capacity: FIXTURE.L39.value, state: 'open' });
  const s = sock();
  joinPaid(env, s, { entryToken: env.store.mint({}) });
  const room = roomOf(env, s);
  assert.ok(room, 'seated');
  room.tickOnce();
  assert.ok(room.ready(s.id));
  room.removeSocket(s.id);
  const r2 = env.arenas.boardRows()[1];
  assert.deepStrictEqual([r2.players, r2.parked], [1, 1], 'an away seat is a player and parked');
  env.arenas.paidOpen = false;
  assert.strictEqual(env.arenas.boardRows()[1].state, 'closed');
  assert.strictEqual(env.arenas.liveCount(), 0, 'parked players are not on the card count');
});

test('a hand-off socket connects seatless (never a watcher seat) and is dropped after 15 s without a join', () => {
  const env = setup();
  const s = sock();
  assert.ok(env.arenas.connectPaid(s));
  assert.strictEqual(env.arenas.roomOfSocket(s.id), null, 'no seat anywhere');
  assert.strictEqual(env.timers.list[0].ms, PAID_SEATLESS_MS);
  env.timers.fire();
  assert.deepStrictEqual(s.of('ag:refused'), [{ why: 'join-timeout' }]);
  assert.strictEqual(s.disconnected, true);
  // one that joins in time is kept
  const t = sock();
  env.arenas.connectPaid(t);
  joinPaid(env, t, { entryToken: env.store.mint({ walletAddress: 'W2' }) });
  env.timers.fire();
  assert.strictEqual(t.disconnected, false);
  assert.ok(roomOf(env, t));
});

test('watchers and free Play stay on the free rung; seatFor makes at most MAX_ROOMS rooms per rung', () => {
  const env = setup();
  const w = sock();
  const room = env.arenas.connect(w);
  assert.ok(room && !room.money, 'a watcher sits in a free room');
  const made = new Set();
  for (let i = 0; i < 20; i++) {
    const r = env.arenas.seatFor(1, Array.from(made).pop());
    if (r) made.add(r);
  }
  assert.ok(env.arenas.rungs.get(1).length <= 8);
  assert.ok(env.arenas.all().length >= 1 + env.arenas.rungs.get(1).length);
});

test('door order: bad stake and bad shapes are refused before any token is read', () => {
  const env = setup();
  const s = sock();
  for (const msg of [{ stake: 0.10499, entryToken: 'x' }, { stake: 'abc', entryToken: 'x' }, { stake: {}, entryToken: 'x' },
    { stake: 0.1, entryToken: 5 }, { stake: 0.1, entryToken: 'x'.repeat(65) }, { stake: 0.1, resumeKey: {} }]) {
    joinPaid(env, s, msg);
  }
  assert.deepStrictEqual(env.store.consumed, [], 'nothing consumed');
  assert.deepStrictEqual(s.of('ag:refused').map((r) => r.why), ['bad-stake', 'bad-stake', 'bad-stake', 'entry', 'entry', 'expired']);
  // hostile payloads never throw
  assert.doesNotThrow(() => env.door.join(s, null));
  assert.doesNotThrow(() => env.door.join(s, []));
  assert.doesNotThrow(() => env.door.join(s, { stake: { toString: 1 }, entryToken: 'x' }));
});

test('a dev token seats a player: worth and wallet come from the token only; ag:joined carries the resume key', () => {
  const env = setup();
  const s = sock();
  const token = env.store.mint({ walletAddress: 'WREAL', worth: 0.1 });
  joinPaid(env, s, { entryToken: token, worth: 1000, walletAddress: 'WEVIL', micro: 1e9 });
  const room = roomOf(env, s);
  const seat = room.seatOf(s.id);
  const acct = room.money.account(seat.pid);
  assert.strictEqual(acct.wallet, 'WREAL');
  assert.strictEqual(acct.deposit, 100000);
  assert.strictEqual(acct.ip, '9.9.9.9');
  const j = s.last('ag:joined');
  assert.deepStrictEqual([j.stake, j.micro, j.resumed, j.confirmed, j.holdTicks], [0.1, 100000, false, false, AG_MONEY.HOLD_TICKS.value]);
  assert.strictEqual(j.resumeKey, acct.resumeKey);
  assert.strictEqual(env.store.has(token), false, 'the token is spent');
  // a token is one-time: sending it again from a fresh socket takes back the UNCONFIRMED seat, deposits nothing
  const t = sock();
  joinPaid(env, t, { entryToken: token });
  assert.strictEqual(roomOf(env, t), room);
  assert.strictEqual(room.money.bank.ledger.inMicro, 100000, 'nothing deposited twice');
  assert.deepStrictEqual(s.of('ag:replaced'), [{}]);
});

test('step 3: a socket that already plays a paid seat is dropped silently, before resume and re-sent token', () => {
  const env = setup();
  const s = sock();
  joinPaid(env, s, { entryToken: env.store.mint({ walletAddress: 'WA' }) });
  const room = roomOf(env, s);
  const key = s.last('ag:joined').resumeKey;
  const before = s.events.length;
  const other = env.store.mint({ walletAddress: 'WB' });
  joinPaid(env, s, { entryToken: other });
  joinPaid(env, s, { resumeKey: key });
  assert.strictEqual(s.events.length, before, 'no answer at all');
  assert.ok(env.store.has(other), 'the second token was never touched');
  assert.strictEqual(room.money.openCount(), 1, 'one socket, one seat');
});

test('every server refusal after the token is spent refunds exactly once with a refund agar reason', async () => {
  // dev token (no stake row): through the payout's refund
  const cases = [
    ['not-open', (env) => { env.arenas.paidOpen = false; }],
    ['cooldown', (env) => { env.arenas._noteRelease('W1'); env.arenas._noteRelease('W1'); }],
    ['full', (env) => { env.arenas.seatFor = () => null; }],
    ['seat-failed', (env) => { const real = env.arenas.seatFor.bind(env.arenas); env.arenas.seatFor = (st, ex) => { const r = real(st, ex); r.addPaidHuman = () => { throw new Error('boom'); }; return r; }; }],
    ['no-room', (env) => { const real = env.arenas.seatFor.bind(env.arenas); env.arenas.seatFor = (st, ex) => { const r = real(st, ex); r.addPaidHuman = () => 'no-room'; return r; }; }],
  ];
  for (const [why, arrange] of cases) {
    const env = setup();
    arrange(env);
    const s = sock();
    joinPaid(env, s, { entryToken: env.store.mint({}) });
    assert.deepStrictEqual(env.refunds.map((r) => r.why), [why], why + ': one refund');
    assert.strictEqual(env.refunds[0].micro, 100000);
    assert.strictEqual(env.refunds[0].paid, 0.1);
    assert.strictEqual(env.refunds[0].wallet, 'W1');
    assert.deepStrictEqual(s.last('ag:refused').why, why);
    assert.strictEqual(s.last('ag:refused').refunded, true);
    assert.strictEqual(roomOf(env, s), null);
  }
  // a real token (stake row): the row's refund, reason 'refund agar <why>', claimed before the seat
  const env = setup();
  env.arenas.paidOpen = false;
  const s = sock();
  joinPaid(env, s, { entryToken: env.store.mint({ stakeSig: 'SIG1', claimKey: 'CK1' }) });
  await tick();
  assert.strictEqual(env.claims.length, 1, 'the stake row is claimed first');
  assert.deepStrictEqual(env.ledgerRefunds, [{ sig: 'SIG1', reason: 'refund agar not-open', claimKey: 'CK1' }]);
  assert.deepStrictEqual(env.refunds, []);
});

test('maintenance: a paid join is consumed and refunded, and it gets there before the free join\'s answer', () => {
  const env = setup();
  env.ops.m = true;
  const s = sock();
  const token = env.store.mint({});
  joinPaid(env, s, { entryToken: token });
  assert.deepStrictEqual(env.refunds.map((r) => r.why), ['maintenance']);
  // through agSockets: the door runs before the free join's rate limit and maintenance return
  const env2 = setup();
  env2.ops.m = true;
  const refunds = [];
  const store = tokenStore();
  const api = attachAgSockets(null, env2.arenas, {
    socketRL: () => true, sanitizeName: (x) => String(x || ''), ops: env2.ops, log: quiet,
    paidDoor: { consumeAtStake: (t, st) => store.consumeAtStake(t, st), ledger: null, refund: (x) => refunds.push(x) },
  });
  const p = sock();
  p.handshake.auth = { paid: 1 };
  api.attach(p);
  p.fire('ag:join', { stake: 0.1, entryToken: store.mint({}), name: 'p' });
  assert.deepStrictEqual(refunds.map((r) => r.why), ['maintenance'], 'refunded, never refused bare');
  assert.strictEqual(p.last('ag:refused').refunded, true);
});

test('the door limiter answers slow-down (with retry), never a silent drop, and touches no token', () => {
  const env = setup();
  const s = sock();
  const token = env.store.mint({});
  env.door.join(s, { stake: 0.1, entryToken: env.store.mint({ walletAddress: 'WX' }) });
  env.door.join(s, { stake: 0.1, entryToken: token });
  const r = s.last('ag:refused');
  assert.deepStrictEqual([r.why, r.retry], ['slow-down', true]);
  assert.ok(env.store.has(token), 'the limited join spent nothing');
});

test('one seat per wallet: a second token from the same wallet reattaches the old seat and refunds the new token', () => {
  const env = setup();
  const a = sock();
  joinPaid(env, a, { entryToken: env.store.mint({ walletAddress: 'WSAME' }) });
  const room = roomOf(env, a);
  const pid = room.seatOf(a.id).pid;
  room.tickOnce();
  room.ready(a.id);
  room.removeSocket(a.id);                       // dropped out, lost the resume key
  const b = sock();
  joinPaid(env, b, { entryToken: env.store.mint({ walletAddress: 'WSAME' }) });
  assert.strictEqual(roomOf(env, b), room);
  assert.strictEqual(room.seatOf(b.id).pid, pid, 'the same seat, back');
  assert.deepStrictEqual(env.refunds.map((r) => r.why), ['reattach']);
  assert.strictEqual(room.money.openCount(), 1);
  assert.strictEqual(room.money.bank.ledger.inMicro, 100000, 'the second stake never entered the room');
});

test('two tokens of one wallet raced through the durable path: one seat, one reattach refund', async () => {
  const env = setup();
  const a = sock();
  const b = sock();
  joinPaid(env, a, { entryToken: env.store.mint({ walletAddress: 'WR', stakeSig: 'S-a' }) });
  joinPaid(env, b, { entryToken: env.store.mint({ walletAddress: 'WR', stakeSig: 'S-b' }) });
  await tick();
  await tick();
  const seats = env.arenas.paidRooms().reduce((n, r) => n + r.money.openCount(), 0);
  assert.strictEqual(seats, 1, 'one seat');
  assert.deepStrictEqual(env.ledgerRefunds.map((r) => r.reason), ['refund agar reattach']);
});

test('the claim comes before the seat; a claim error puts the token back; a refunded row seats nothing; a lost link refunds', async () => {
  const env = setup();
  const s = sock();
  env.ledger.answer = 'error';
  const t1 = env.store.mint({ stakeSig: 'S1' });
  joinPaid(env, s, { entryToken: t1 });
  assert.strictEqual(roomOf(env, s), null, 'not seated before the claim answers');
  await tick();
  assert.strictEqual(s.last('ag:refused').why, 'unavailable');
  assert.ok(env.store.has(t1), 'the token is back');
  env.ledger.answer = 'refunded';
  joinPaid(env, s, { entryToken: t1 });
  await tick();
  assert.strictEqual(s.last('ag:refused').why, 'settled');
  assert.strictEqual(roomOf(env, s), null);
  env.ledger.answer = 'ok';
  const gone = sock();
  joinPaid(env, gone, { entryToken: env.store.mint({ stakeSig: 'S2', walletAddress: 'WG' }) });
  gone.disconnected = true;
  await tick();
  assert.deepStrictEqual(env.ledgerRefunds.map((r) => r.reason), ['refund agar join-lost']);
  // an async throw inside the claim chain is caught, never unhandled
  env.ledger.claimSeat = () => Promise.reject(new Error('db down'));
  joinPaid(env, sock(), { entryToken: env.store.mint({ stakeSig: 'S3', walletAddress: 'WT' }) });
  await tick();
});

test('resume by key: works while the door is closed; a gone seat answers its real outcome', () => {
  const env = setup();
  const s = sock();
  joinPaid(env, s, { entryToken: env.store.mint({ walletAddress: 'WK' }) });
  const room = roomOf(env, s);
  const key = s.last('ag:joined').resumeKey;
  room.tickOnce();
  room.ready(s.id);
  env.arenas.disconnect(s.id);
  env.arenas.paidOpen = false;
  const t = sock();
  joinPaid(env, t, { resumeKey: key });
  assert.strictEqual(roomOf(env, t), room);
  assert.strictEqual(t.last('ag:joined').resumed, true);
  // cash it out with a hold, then a page asking with the key is told the receipt
  room.hold(t.id, true);
  for (let i = 0; i < AG_MONEY.HOLD_TICKS.value; i++) room.tickOnce();
  assert.strictEqual(roomOf(env, t), null, 'seatless after the cash-out');
  const u = sock();
  joinPaid(env, u, { resumeKey: key });
  const c = u.last('ag:cashedout');
  assert.deepStrictEqual([c.grossMicro, c.cutMicro, c.netMicro, c.resumed], [100000, 10000, 90000, true]);
  joinPaid(env, u, { resumeKey: 'no-such-key' });
  assert.strictEqual(u.last('ag:refused').why, 'expired');
  // outcomes are kept OUTCOME_TTL_MS
  env.clock.t += OUTCOME_TTL_MS + 1;
  joinPaid(env, sock(), { resumeKey: key });
  assert.strictEqual(env.arenas.outcomeOf('k:' + key), null);
});

test('walletSeat is cleared on every exit: death, cash-out, release, auto settle, zombie settle, emergency and stop', () => {
  const env = setup();
  const enter = (w) => {
    const s = sock();
    joinPaid(env, s, { entryToken: env.store.mint({ walletAddress: w }) });
    const room = roomOf(env, s);
    return { s, room, pid: room.seatOf(s.id).pid };
  };
  const cell = (room, pid) => room.sim.getCell(room.sim.playerInfo(pid).cells[0]);
  // release (socket lost before ready)
  const r1 = enter('W-rel');
  env.arenas.disconnect(r1.s.id);
  assert.strictEqual(env.arenas.walletSeatOf('W-rel'), null, 'release');
  // death and cash-out
  const v = enter('W-dead');
  const k = enter('W-kill');
  v.room.tickOnce();
  v.room.ready(v.s.id);
  k.room.ready(k.s.id);
  const cv = cell(v.room, v.pid);
  const ck = cell(k.room, k.pid);
  ck.x = cv.x; ck.y = cv.y; ck.size = 400;
  v.room.sim.setInput(k.pid, { x: cv.x, y: cv.y });
  v.room.tickOnce();
  assert.strictEqual(env.arenas.walletSeatOf('W-dead'), null, 'death');
  assert.ok(v.s.last('ag:dead'));
  k.room.hold(k.s.id, true);
  for (let i = 0; i < AG_MONEY.HOLD_TICKS.value; i++) k.room.tickOnce();
  assert.strictEqual(env.arenas.walletSeatOf('W-kill'), null, 'cash-out');
  // auto settle
  const d = enter('W-away');
  d.room.tickOnce();
  d.room.ready(d.s.id);
  env.arenas.disconnect(d.s.id);
  env.clock.t += AG_MONEY.DISCONNECT_GRACE_MS.value;
  d.room.tickOnce();
  env.clock.t += AG_MONEY.DORMANT_SETTLE_MS.value;
  d.room.tickOnce();
  assert.strictEqual(env.arenas.walletSeatOf('W-away'), null, 'auto settle');
  // zombie settle
  const z = enter('W-zombie');
  z.room.tickOnce();
  z.room.ready(z.s.id);
  z.room.sim.clearCells(z.pid);
  z.room.tickOnce();
  env.clock.t += AG_MONEY.ZOMBIE_SETTLE_MS.value;
  z.room.tickOnce();
  assert.strictEqual(env.arenas.walletSeatOf('W-zombie'), null, 'zombie settle');
  // emergency
  const e = enter('W-emerg');
  const eroom = e.room;
  e.room.emergencyClose();
  assert.strictEqual(env.arenas.walletSeatOf('W-emerg'), null, 'emergency');
  assert.ok(!env.arenas.rungs.get(0.1).includes(eroom), 'replaced at its index');
  assert.strictEqual(e.s.last('ag:closed').why, 'emergency');
  // stop
  const st = enter('W-stop');
  assert.ok(env.arenas.walletSeatOf('W-stop'));
  env.arenas.stop();
  assert.strictEqual(env.arenas.walletSeatOf('W-stop'), null, 'stop');
});

test('sweep never closes a paid room with accounts or money; a settling room stays in all() until its bank is empty', () => {
  const env = setup();
  const s = sock();
  joinPaid(env, s, { entryToken: env.store.mint({ walletAddress: 'WS' }) });
  const room = roomOf(env, s);
  const extra = env.arenas.seatFor(0.1, room);   // an empty overflow room
  room.removeSocket(s.id);
  env.arenas.sweep(env.clock.t);
  env.arenas.sweep(env.clock.t + 10 * 60 * 1000);
  const list = env.arenas.rungs.get(0.1);
  assert.ok(list.includes(room), 'the room with an account stays');
  if (extra.index > 0) assert.ok(!list.includes(extra), 'the empty overflow room went');
  // a room whose emergency settle left money: settling, counted by all(), retried by the sweep
  const s2 = sock();
  joinPaid(env, s2, { entryToken: env.store.mint({ walletAddress: 'WS2' }) });
  const r2 = roomOf(env, s2);
  const pid2 = r2.seatOf(s2.id).pid;
  const orig = r2.money.bank.withdraw.bind(r2.money.bank);
  let stuck = true;
  r2.money.bank.withdraw = (id) => { if (stuck && id === pid2) throw new Error('stuck'); return orig(id); };
  r2.emergencyClose();
  assert.ok(env.arenas.settling.includes(r2));
  assert.ok(env.arenas.all().includes(r2), 'counted for solvency and the drain');
  stuck = false;
  env.arenas.sweep(env.clock.t);
  assert.ok(!env.arenas.settling.includes(r2), 'settled on the retry and dropped');
  assert.strictEqual(r2.money.bank.totalMicro(), 0);
});

test('agSockets: an auth.paid socket is never refused full; ag:leave is refused while a paid seat is open; ag:hold off is never rate limited', () => {
  const env = setup();
  let rlCalls = 0;
  let holdsAllowed = 1;   // the limiter lets exactly one {on:1} through, then refuses
  const api = attachAgSockets(null, env.arenas, {
    socketRL: (s, key) => {
      rlCalls++;
      if (key !== 'aghold') return true;
      return holdsAllowed-- > 0;
    }, sanitizeName: (x) => String(x || ''), ops: env.ops,
    log: quiet, perIp: 1000,
    paidDoor: { consumeAtStake: (t, st) => env.store.consumeAtStake(t, st), ledger: null, refund: (x) => env.refunds.push(x) },
  });
  // fill every free watcher seat, then a paid hand-off still connects
  const free = env.arenas.rooms[0];
  free.watchCap = 0;
  const w = sock();
  api.attach(w);
  assert.deepStrictEqual(w.of('ag:refused'), [{ why: 'full' }], 'a plain watcher is refused when full');
  const p = sock();
  p.handshake.auth = { paid: 1 };
  api.attach(p);
  assert.deepStrictEqual(p.of('ag:refused'), [], 'the paid hand-off is not');
  env.clock.t += 1000;
  p.fire('ag:join', { stake: 0.1, entryToken: env.store.mint({ walletAddress: 'WL' }), name: 'p' });
  assert.ok(p.last('ag:joined'), 'seated by the door');
  p.fire('ag:leave');
  assert.deepStrictEqual(p.last('ag:refused'), { why: 'cash-out-to-leave' });
  assert.ok(roomOf(env, p), 'still seated');
  // a free Play from a socket that holds a paid seat is dropped
  p.fire('ag:join', { name: 'p' });
  assert.ok(roomOf(env, p));
  // hold: {on:1} goes through the limiter (here refusing), {on:0} never does
  const room = roomOf(env, p);
  room.tickOnce();
  p.fire('ag:ready');
  const acct = room.money.account(room.seatOf(p.id).pid);
  assert.strictEqual(acct.state, 'live');
  p.fire('ag:hold', { on: 1 });
  assert.strictEqual(acct.lastHoldAt, env.clock.t, 'the press got through');
  const before = rlCalls;
  p.fire('ag:hold', { on: 0 });
  assert.strictEqual(rlCalls, before, 'a release is not rate limited');
  assert.strictEqual(acct.lastHoldAt, 0, 'and it lets go');
  p.fire('ag:hold', { on: 1 });
  assert.strictEqual(acct.lastHoldAt, 0, 'the limited {on:1} was dropped');
  // a flood of releases (review fix): with no accepted press before it, a release never reaches the room
  const realHold = env.arenas.hold.bind(env.arenas);
  let roomCalls = 0;
  env.arenas.hold = (id, on) => { roomCalls++; return realHold(id, on); };
  for (let i = 0; i < 50; i++) p.fire('ag:hold', { on: 0 });
  assert.strictEqual(roomCalls, 0, 'releases with no press before them are no-ops and are not passed on');
  assert.strictEqual(rlCalls, before + 1, 'and none of them touched the limiter');
  // a press that gets through is always followed by its release, however close behind
  holdsAllowed = 1;
  p.fire('ag:hold', { on: 1 });
  p.fire('ag:hold', { on: 0 });
  assert.strictEqual(roomCalls, 2, 'press and release both reached the room');
  assert.strictEqual(acct.lastHoldAt, 0, 'the release won');
  env.arenas.hold = realHold;
  p.fire('ag:hold', { on: 'yes' });
  p.fire('ag:hold', null);
});

test('without the money wired, a paid payload is refused and never seated free', () => {
  const env = setup({ paid: false });
  const api = attachAgSockets(null, env.arenas, { socketRL: () => true, sanitizeName: (x) => String(x || ''), log: quiet });
  const s = sock();
  api.attach(s);
  s.fire('ag:join', { stake: 0.1, entryToken: 'x', name: 's' });
  assert.deepStrictEqual(s.last('ag:refused'), { why: 'not-open' });
  const room = env.arenas.roomOfSocket(s.id);
  assert.strictEqual(room.seatOf(s.id).joined, false, 'not playing');
});

test('proofOf: sha256 of a token, null for anything that is not one', () => {
  assert.match(proofOf('abc'), /^[0-9a-f]{64}$/);
  assert.strictEqual(proofOf(''), null);
  assert.strictEqual(proofOf(5), null);
  assert.strictEqual(proofOf('x'.repeat(65)), null);
});
