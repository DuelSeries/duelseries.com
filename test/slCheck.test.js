'use strict';
// The paid sl money checker (PAID-SL-DESIGN.md 8, 11.1 slCheck; task T1): each invariant trips on a hand-made bad
// state and on nothing else; the cheap pass sees only I1, I8 and I10, I8 a skipped fact in the sim's own record of the
// step; I7 holds for drops the real food store moved; the checker never throws and never puts a wallet in a detail;
// and the ledger-wide helpers (I9 across rooms, I11 journal, I12 ledger) catch their own faults.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../server/sl/slLaws');
const { createGrid } = require('../server/sl/slGrid');
const { streams } = require('../server/sl/slRng');
const { createFood } = require('../server/sl/slFood');
const { SlBank } = require('../server/slPaid/slBank');
const { planSplit } = require('../server/slPaid/slSplit');
const C = require('../server/slPaid/slCheck');

const GRD = L.LAWS.L1.value;
const SS = L.LAWS['L2.size'].value;
const FLUX = 2923; // the border radius at C_R_MIN 22 snakes, where a paid room's border stays (design 1)

// The sim as the checker reads it, with this step's eats (food.tick) and deaths (lastLog) as the real sim keeps them.
function fakeSim() {
  const snakes = new Map();
  const foods = new Map();
  const log = { deaths: [] };
  return {
    snakes,
    foods,
    log,
    flux: () => FLUX,
    count: () => snakes.size,
    snake: (id) => snakes.get(id) || null,
    lastLog: () => log,
    food: {
      tick: { eats: [] },
      get: (id) => foods.get(id) || null,
      forEachFood: (fn) => {
        for (const f of foods.values()) fn(f);
      },
    },
  };
}

// A corrupted account or pellet, written straight into the bank's maps past the freeze.
function setAcct(bank, id, patch) {
  bank.accounts.set(id, Object.assign({}, bank.accounts.get(id), patch));
}

function setPellet(bank, f, patch) {
  bank.floor.set(f, Object.assign({}, bank.floor.get(f), patch));
}

let nextFood = 1;
function addFood(sim, o) {
  const p = o || {};
  const f = { id: nextFood++, x: p.x === undefined ? GRD + 100 : p.x, y: p.y === undefined ? GRD : p.y,
    b: p.b === undefined ? 70 : p.b, nat: p.nat === true };
  sim.foods.set(f.id, f);
  return f;
}

// A healthy paid room: snakes 1 and 2 live with accounts, snake 3 died onto five pellets and snake 1 ate one of them;
// natural food and a boost crumb lie around too.
function world() {
  const bank = new SlBank();
  const sim = fakeSim();
  const humans = new Set();
  const room = { laws: L.LAWS, money: { bank }, sim, humans };
  for (const id of [1, 2, 3]) {
    sim.snakes.set(id, { id });
    humans.add(id);
    bank.deposit(id, 500000, { wallet: 'W' + id, name: 'n' + id, jid: 'j' + id });
  }
  addFood(sim, { b: 30, nat: true });
  addFood(sim, { b: 54 });
  bank.beginStep();
  const drops = [];
  for (let i = 0; i < 5; i++) drops.push({ food: addFood(sim, { x: GRD + 200 + 3 * i, b: 68 }) });
  drops.push({ food: null });
  sim.snakes.delete(3);
  humans.delete(3);
  sim.log.deaths.push({ id: 3, cause: 'snake', killer: 1, drops });
  const plan = planSplit(bank.balance(3), drops);
  bank.split(3, plan.foods, plan.shares);
  const eaten = plan.foods[0];
  sim.foods.delete(eaten.id);
  sim.food.tick.eats.push({ food: eaten, eater: 1 });
  bank.credit(eaten, 1);
  const walletSeat = new Map([['W1', { room, snakeId: 1 }], ['W2', { room, snakeId: 2 }]]);
  return { room, bank, sim, humans, walletSeat, pellets: plan.foods.slice(1) };
}

const kinds = (v) => v.map((x) => x.kind);
const full = (w) => C.checkRoom(w.room, { full: true, walletSeat: w.walletSeat });

test('checkLaws reads the four paid numbers from the real table (cached per table); a missing or bad row is refused', () => {
  const K = C.checkLaws(L.LAWS);
  assert.strictEqual(K.cashByte, 68);
  assert.strictEqual(K.inset, 60);
  assert.strictEqual(K.humanCap, 22);
  assert.strictEqual(K.grd, 32550);
  assert.ok(Math.abs(K.slack - 2 * (300 / 256) * Math.SQRT2) < 1e-12, 'two food cell diagonals');
  assert.strictEqual(C.checkLaws(L.LAWS), K);
  assert.deepStrictEqual(C.CHECK_LAW_IDS, ['L1', 'L2.size', 'C_PAID_HUMAN_CAP', 'C_PAID_DROP_INSET', 'C_PAID_CASH_BYTE']);
  assert.throws(() => C.checkLaws(L.withValues(L.LAWS, { C_PAID_CASH_BYTE: null })), /C_PAID_CASH_BYTE/);
  assert.throws(() => C.checkLaws(L.withValues(L.LAWS, { C_PAID_CASH_BYTE: 300 })), /byte/);
  assert.throws(() => C.checkLaws(L.withValues(L.LAWS, { C_PAID_HUMAN_CAP: 0 })), /C_PAID_HUMAN_CAP/);
  assert.throws(() => C.checkLaws(L.withValues(L.LAWS, { C_PAID_DROP_INSET: -1 })), /C_PAID_DROP_INSET/);
});

test('a healthy room: nothing, cheap or full; a cash-out and a floor sweep keep it clean', () => {
  const w = world();
  assert.deepStrictEqual(C.checkRoom(w.room), []);
  assert.deepStrictEqual(full(w), []);
  assert.deepStrictEqual(C.checkRoom({ bank: w.bank, sim: w.sim, humans: w.humans }, { full: true, K: C.checkLaws(L.LAWS) }), []);
  // snake 1 cashes out: the account is withdrawn, then the snake leaves the sim, the seat goes
  w.bank.withdraw(1, 'cash');
  w.sim.snakes.delete(1);
  w.humans.delete(1);
  w.walletSeat.delete('W1');
  assert.deepStrictEqual(full(w), []);
  // the room retires: its floor goes to the house and its foods with it
  w.bank.takeFloor('swept');
  for (const f of w.pellets) w.sim.foods.delete(f.id);
  assert.deepStrictEqual(full(w), []);
});

test('I1: the books do not close, or a counter is not a whole number of micro (cheap)', () => {
  const w = world();
  w.bank.ledger.in += 1;
  assert.deepStrictEqual(kinds(C.checkRoom(w.room)), ['I1']);
  assert.deepStrictEqual(kinds(full(w)), ['I1']);
  const d = C.checkRoom(w.room)[0].detail;
  assert.strictEqual(d.in, d.sum + 1);
  const v = world();
  v.bank.ledger.outCash = NaN;
  const r = C.checkRoom(v.room);
  assert.deepStrictEqual(kinds(r), ['I1']);
  assert.deepStrictEqual(r[0].detail.notMicro, ['outCash']);
  const x = world();
  x.bank.ledger.in += 0.5;
  x.bank.sums.acc += 0.5;
  assert.deepStrictEqual(C.checkRoom(x.room)[0].detail.notMicro, ['in', 'acc']);
});

test('I2: the running sums disagree with the maps, or the house kinds with outHouse (full only)', () => {
  const w = world();
  w.bank.sums.acc += 5;
  w.bank.ledger.in += 5; // I1 still closes on the running sums
  assert.deepStrictEqual(C.checkRoom(w.room), []);
  assert.deepStrictEqual(kinds(full(w)), ['I2']);
  const v = world();
  v.bank.house.swept += 3;
  assert.deepStrictEqual(kinds(full(v)), ['I2']);
  assert.strictEqual(full(v)[0].detail.houseSum, 3);
});

test('I3: an account below its deposit, or at 0', () => {
  const w = world();
  setAcct(w.bank, 2, { micro: w.bank.balance(2) - 1 }); // moved to the house so I1 and I2 still close
  w.bank.sums.acc -= 1;
  w.bank.ledger.outHouse += 1;
  w.bank.house.breach += 1;
  assert.deepStrictEqual(kinds(full(w)), ['I3']);
  assert.deepStrictEqual(full(w)[0].detail, { snakeId: 2, jid: 'j2', micro: 499999, deposit: 500000 });
  const v = world();
  setAcct(v.bank, 2, { deposit: NaN });
  assert.deepStrictEqual(kinds(full(v)), ['I3']);
});

test('I4: an open account whose snake is gone from the sim (full only)', () => {
  const w = world();
  w.sim.snakes.delete(2);
  assert.deepStrictEqual(C.checkRoom(w.room), [], 'not a cheap check');
  assert.deepStrictEqual(full(w), [{ kind: 'I4', detail: { snakeId: 2, jid: 'j2', micro: 500000 } }]);
});

test('I13: a live human snake with no account', () => {
  const w = world();
  w.sim.snakes.set(50, { id: 50 });
  w.humans.add(50);
  assert.deepStrictEqual(full(w), [{ kind: 'I13', detail: { snakeId: 50 } }]);
  // a human id whose snake is not alive any more is not I13 (the room drops it with the death)
  const v = world();
  v.humans.add(51);
  assert.deepStrictEqual(full(v), []);
  const x = world();
  x.room.humans = null;
  assert.deepStrictEqual(full(x), [{ kind: 'check', detail: { why: 'no humans set' } }]);
});

test('I5: a pellet whose food is off the grid, natural, or below the cash byte', () => {
  const w = world();
  w.sim.foods.delete(w.pellets[0].id);
  assert.deepStrictEqual(full(w), [{ kind: 'I5', detail: { why: 'off-grid', id: w.pellets[0].id } }]);
  const v = world();
  v.sim.foods.set(v.pellets[1].id, Object.assign({}, v.pellets[1])); // another object in that cell
  assert.deepStrictEqual(kinds(full(v)), ['I5', 'I6'], 'the stranger object in the cell is gold without cash');
  const n = world();
  n.pellets[0].nat = true;
  assert.deepStrictEqual(full(n), [{ kind: 'I5', detail: { why: 'natural', id: n.pellets[0].id } }]);
  const s = world();
  s.pellets[0].b = 67;
  assert.deepStrictEqual(full(s), [{ kind: 'I5', detail: { why: 'small', id: s.pellets[0].id, b: 67 } }]);
});

test('I6: a cash-sized food that is not a pellet; 67 and below are never cash', () => {
  const w = world();
  addFood(w.sim, { b: 67 });
  assert.deepStrictEqual(full(w), []);
  const g = addFood(w.sim, { b: 68 });
  assert.deepStrictEqual(full(w), [{ kind: 'I6', detail: { id: g.id, b: 68 } }]);
  assert.deepStrictEqual(C.checkRoom(w.room), [], 'not a cheap check');
});

test('I7: a pellet worth nothing, or outside flux - inset plus one food cell', () => {
  const w = world();
  const K = C.checkLaws(L.LAWS);
  const m = w.bank.pellet(w.pellets[0]).micro;
  setPellet(w.bank, w.pellets[0], { micro: 0 }); // its micro moved to the house so I1 and I2 close
  w.bank.sums.floor -= m;
  w.bank.ledger.outHouse += m;
  w.bank.house.breach += m;
  assert.deepStrictEqual(full(w), [{ kind: 'I7', detail: { why: 'micro', id: w.pellets[0].id, micro: 0 } }]);
  const v = world();
  const f = v.pellets[0];
  const limit = FLUX - K.inset + K.slack;
  for (const [dx, ok] of [[FLUX - K.inset, true], [limit - 0.001, true], [limit + 0.001, false], [FLUX, false]]) {
    f.x = GRD + dx;
    const r = full(v);
    if (ok) assert.deepStrictEqual(r, [], 'at ' + dx);
    else assert.deepStrictEqual(r.map((x) => [x.kind, x.detail.why]), [['I7', 'outside']], 'at ' + dx);
  }
  f.x = NaN;
  assert.deepStrictEqual(kinds(full(v)), ['I7'], 'a position that is not a number is outside');
  // the inset is measured from the map centre in any direction
  f.x = GRD - (FLUX - K.inset) * Math.SQRT1_2;
  f.y = GRD - (FLUX - K.inset) * Math.SQRT1_2;
  assert.deepStrictEqual(full(v), []);
});

test('I7 on the real food store: a drop pulled onto the circle whose cell is taken goes one ring out and stays inside', () => {
  const K = C.checkLaws(L.LAWS);
  const at = FLUX - K.inset;
  const corner = (SS / 256) * Math.SQRT2; // the corner offset alone, one food cell diagonal
  const store = () => createFood(L.LAWS, { grid: createGrid({ sectorSize: SS, grd: GRD }), rng: streams(1).food });
  const food = store();
  const past = (f) => Math.hypot(f.x - GRD, f.y - GRD) - at;
  // two drops pulled onto one point at the top of the circle: the second goes to the cell above (C_DROP_CELL, first
  // in scan order), which is outward there
  const a = food.drop(GRD, GRD - at, 70, 0);
  const b = food.drop(GRD, GRD - at, 70, 0);
  assert.deepStrictEqual([b.sx, b.sy, b.rx, b.ry], [a.sx, a.sy, a.rx, a.ry - 1]);
  assert.ok(past(b) > corner, 'past one cell diagonal: ' + past(b));
  const bank = new SlBank();
  bank.deposit(1, 1000, { wallet: 'W1', jid: 'j1' });
  bank.split(1, [a, b], [500, 500]);
  const sim = { flux: () => FLUX, count: () => 0, snake: () => null, food, lastLog: () => ({ deaths: [] }) };
  const room = { laws: L.LAWS, money: { bank }, sim, humans: new Set() };
  assert.deepStrictEqual(C.checkRoom(room, { full: true }), []);
  // all the way round the circle on an empty store: one collision, then the four sides taken too (the search lands on
  // a corner of the first ring); both stay inside the limit, and one collision alone already passes the corner offset
  const s = store();
  let one = 0;
  let ring = 0;
  for (let i = 0; i < 3600; i++) {
    const th = (i / 3600) * 2 * Math.PI;
    const x = GRD + at * Math.cos(th);
    const y = GRD + at * Math.sin(th);
    const p = s.drop(x, y, 70, 0);
    const q = s.drop(x, y, 70, 0);
    const sides = [[0, -1], [-1, 0], [1, 0], [0, 1]].map(([dx, dy]) => s.drop(p.x + (dx + 0.5) * SS / 256,
      p.y + (dy + 0.5) * SS / 256, 70, 0));
    const r = s.drop(x, y, 70, 0);
    one = Math.max(one, past(p), past(q));
    ring = Math.max(ring, past(r));
    for (const f of [p, q, r].concat(sides)) s.eat(f, 1);
    s.beginTick();
  }
  assert.ok(one > corner && one <= K.slack, 'one collision: ' + one);
  assert.ok(ring > one && ring <= K.slack, 'the first ring\'s corner: ' + ring);
});

test('I8, the facts: a fact the controller skipped shows the same step, read from the sim itself (cheap)', () => {
  // the sim ate a pellet this step and no credit came: the eater's micro still sits on a food that is gone
  const w = world();
  const f = w.pellets[0];
  const m = w.bank.pellet(f).micro;
  w.sim.foods.delete(f.id);
  w.sim.food.tick.eats.push({ food: f, eater: 2 });
  assert.deepStrictEqual(C.checkRoom(w.room), [{ kind: 'I8', detail: { why: 'eaten-pellet', id: f.id, eater: 2, micro: m } }]);
  assert.deepStrictEqual(kinds(full(w)), ['I8', 'I5'], 'the full walk sees the same pellet off the grid');
  w.bank.credit(f, 2);
  assert.deepStrictEqual(C.checkRoom(w.room), [], 'credited: clean');
  // snake 2 died this step and no split came: its account is still open
  const v = world();
  v.sim.snakes.delete(2);
  v.humans.delete(2);
  v.sim.log.deaths.push({ id: 2, cause: 'border', killer: 0, drops: [] });
  assert.deepStrictEqual(C.checkRoom(v.room), [{ kind: 'I8', detail: { why: 'dead-account', snakeId: 2, jid: 'j2',
    micro: 500000 } }]);
  v.bank.split(2, [], []);
  assert.deepStrictEqual(C.checkRoom(v.room), []);
  // natural food eaten, an eaten food that was never cash, a death with no account: no fact for the bank
  const u = world();
  u.sim.food.tick.eats.push({ food: addFood(u.sim, { b: 30, nat: true }), eater: 1 }, { food: addFood(u.sim), eater: 2 });
  u.sim.log.deaths.push({ id: 77, cause: 'snake', killer: 1, drops: [] });
  assert.deepStrictEqual(C.checkRoom(u.room), []);
  // a sim that keeps no eats or no step log is reported, never passed
  const x = world();
  x.sim.lastLog = undefined;
  assert.deepStrictEqual(C.checkRoom(x.room), [{ kind: 'check', detail: { why: 'no step log' } }]);
  const y = world();
  y.sim.food.tick = null;
  assert.deepStrictEqual(C.checkRoom(y.room), [{ kind: 'check', detail: { why: 'no eats' } }]);
});

test('I8, the bank\'s own tallies: this step moved what it took (cheap), from bank.step or a step handed in', () => {
  const w = world();
  w.bank.step.credited += 1;
  assert.deepStrictEqual(C.checkRoom(w.room).map((x) => [x.kind, x.detail.why]), [['I8', 'eats']]);
  const v = world();
  v.bank.step.splitIn -= 1;
  assert.deepStrictEqual(C.checkRoom(v.room).map((x) => [x.kind, x.detail.why]), [['I8', 'deaths']]);
  const u = world();
  u.bank.step.taken = NaN;
  assert.deepStrictEqual(C.checkRoom(u.room).map((x) => [x.kind, x.detail.why]), [['I8', 'not-micro']]);
  const s = world();
  const step = { taken: 10, credited: 4, suspended: 6, dead: 100, splitIn: 0, unplaced: 100 };
  assert.deepStrictEqual(C.checkRoom(s.room, { step }), []);
  step.suspended = 5;
  assert.deepStrictEqual(kinds(C.checkRoom(s.room, { step })), ['I8']);
});

test('I9: an account that is not its wallet\'s seat, and a seat with no account here (full, with the map)', () => {
  const w = world();
  w.walletSeat.delete('W2');
  assert.deepStrictEqual(full(w), [{ kind: 'I9', detail: { why: 'not-seated', snakeId: 2, jid: 'j2' } }]);
  assert.deepStrictEqual(C.checkRoom(w.room, { full: true }), [], 'no map, no I9');
  const v = world();
  v.walletSeat.set('W9', { room: v.room, snakeId: 9 });
  assert.deepStrictEqual(full(v), [{ kind: 'I9', detail: { why: 'stale-seat', snakeId: 9 } }]);
  const u = world();
  u.walletSeat.set('W1', { room: {}, snakeId: 1 }); // the map says another room
  assert.deepStrictEqual(full(u), [{ kind: 'I9', detail: { why: 'not-seated', snakeId: 1, jid: 'j1' } }]);
});

test('I10: more live snakes than C_PAID_HUMAN_CAP (cheap)', () => {
  const w = world();
  for (let id = 100; w.sim.count() < 22; id++) w.sim.snakes.set(id, { id });
  assert.deepStrictEqual(C.checkRoom(w.room), []);
  w.sim.snakes.set(200, { id: 200 });
  assert.deepStrictEqual(C.checkRoom(w.room), [{ kind: 'I10', detail: { count: 23, cap: 22 } }]);
});

test('the checker never throws: no bank, no sim, a throwing sim, a table without the paid rows', () => {
  assert.deepStrictEqual(C.checkRoom(null), [{ kind: 'check', detail: { why: 'no bank' } }]);
  assert.deepStrictEqual(C.checkRoom({ laws: L.LAWS }), [{ kind: 'check', detail: { why: 'no bank' } }]);
  const w = world();
  w.room.sim = null;
  assert.deepStrictEqual(C.checkRoom(w.room, { full: true }), [{ kind: 'check', detail: { why: 'no sim' } }]);
  const v = world();
  v.sim.snake = () => { throw new Error('boom'); };
  assert.deepStrictEqual(full(v), [{ kind: 'check', detail: { why: 'threw', error: 'boom' } }]);
  const u = world();
  u.room.laws = L.withValues(L.LAWS, { C_PAID_CASH_BYTE: null });
  const r = C.checkRoom(u.room, { full: true });
  assert.deepStrictEqual(kinds(r), ['check']);
  assert.match(r[0].detail.error, /C_PAID_CASH_BYTE/);
  const nf = world();
  nf.sim.flux = () => null;
  assert.deepStrictEqual(full(nf), [{ kind: 'check', detail: { why: 'no flux' } }]);
});

test('a flood of one pellet-level kind is capped at PER_KIND_MAX entries plus one count', () => {
  const w = world();
  for (let i = 0; i < 100; i++) addFood(w.sim, { b: 70 });
  const r = full(w);
  assert.strictEqual(C.PER_KIND_MAX, 32);
  assert.strictEqual(r.length, 33);
  assert.ok(r.slice(0, 32).every((x) => x.kind === 'I6' && Number.isInteger(x.detail.id)));
  assert.deepStrictEqual(r[32], { kind: 'I6', detail: { more: 68 } });
});

test('no detail carries a wallet, even with every invariant broken at once', () => {
  const w = world();
  w.bank.ledger.in += 1;
  w.bank.house.swept += 1;
  w.sim.snakes.delete(2);
  w.sim.snakes.set(50, { id: 50 });
  w.humans.add(50);
  w.pellets[0].b = 60;
  addFood(w.sim, { b: 90 });
  w.pellets[1].x = GRD + FLUX;
  w.bank.step.credited += 1;
  w.sim.food.tick.eats.push({ food: w.pellets[2], eater: 1 });
  w.sim.log.deaths.push({ id: 1, cause: 'snake', killer: 2, drops: [] });
  w.walletSeat.delete('W1');
  w.walletSeat.set('W7', { room: w.room, snakeId: 7 });
  for (let id = 300; id < 330; id++) w.sim.snakes.set(id, { id });
  const r = full(w);
  assert.deepStrictEqual([...new Set(kinds(r))].sort(), ['I1', 'I10', 'I13', 'I2', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9']);
  assert.doesNotMatch(JSON.stringify(r), /W\d/);
  const ws = C.checkWalletSeats([w.room], w.walletSeat);
  assert.doesNotMatch(JSON.stringify(ws), /W\d/);
});

test('checkWalletSeats: one account per wallet across rooms, and the map names exactly the open accounts', () => {
  const a = world();
  const b = world();
  // room b: its own wallets
  for (const id of b.bank.openIds()) setAcct(b.bank, id, { wallet: 'X' + id });
  const ws = new Map([['W1', { room: a.room, snakeId: 1 }], ['W2', { room: a.room, snakeId: 2 }],
    ['X1', { room: b.room, snakeId: 1 }], ['X2', { room: b.room, snakeId: 2 }]]);
  assert.deepStrictEqual(C.checkWalletSeats([a.room, b.room], ws), []);
  // two tabs: the same wallet seated in both rooms
  setAcct(b.bank, 2, { wallet: 'W2' });
  const r = C.checkWalletSeats([a.room, b.room], ws);
  assert.deepStrictEqual(r.map((x) => x.detail.why), ['two-accounts', 'not-seated', 'stale-seat']);
  assert.deepStrictEqual(C.checkWalletSeats([a.room, null], new Map()).map((x) => x.kind), ['I9', 'I9', 'check']);
});

test('checkJournal (I11): every sl jid opened then closed once, or still open; agar records are not counted', () => {
  const room = 'sl_na_s0_5';
  const recs = [
    { t: 'open', jid: 'a', room }, // the door, before the claim
    { t: 'open', jid: 'a', room }, // the account, when it opens (design 3.3)
    { t: 'open', jid: 'b', room: 'sl_na_s1' },
    { t: 'close', jid: 'b', room: 'sl_na_s1', outcome: 'cashedout' },
    { t: 'open', jid: 'r', room },
    { t: 'close', jid: 'r', room, outcome: 'refused' },
    { t: 'open', jid: 'g', room: 'ag_na_s0_5' }, // agar's, never closed here: not ours
    { t: 'close', jid: 'h', room: 'ag_na_s1' },
    null,
  ];
  assert.deepStrictEqual(C.checkJournal(recs, ['a']), []);
  const why = (r) => r.map((x) => x.detail.why);
  assert.deepStrictEqual(why(C.checkJournal(recs.concat([{ t: 'close', jid: 'b', room: 'sl_na_s1' }]), ['a'])), ['closed-twice']);
  assert.deepStrictEqual(why(C.checkJournal([{ t: 'close', jid: 'z', room }].concat(recs), ['a'])), ['close-before-open', 'count']);
  assert.deepStrictEqual(why(C.checkJournal(recs, [])), ['never-closed', 'count']);
  assert.deepStrictEqual(why(C.checkJournal(recs, ['a', 'q'])), ['open-without-record', 'count']);
  assert.deepStrictEqual(why(C.checkJournal(recs, ['a', 'b'])), ['open-but-closed', 'count']);
  assert.deepStrictEqual(C.checkJournal(null, []).map((x) => x.kind), ['check']);
});

test('checkLedger (I12): staked == gross + refunds + house + live; gross == net + rake; withdraws == net + paid + sweeps', () => {
  // three $1 stakes and two $0.50: one cashed out $1 gross, one refunded $0.50, $0.50 to the house (0.40 swept,
  // 0.10 abandoned at a shutdown), $2 still live
  const t = { staked: 4000000, cashGross: 1000000, cashNet: 900000, rake: 100000, refunds: 500000, house: 500000,
    live: 2000000, sweeps: 100000 + 400000, withdraws: 900000 + 500000 + 500000 };
  assert.deepStrictEqual(C.checkLedger(t), []);
  const why = (x) => C.checkLedger(Object.assign({}, t, x)).map((v) => v.detail.why);
  assert.deepStrictEqual(why({ staked: 4000001 }), ['staked']);
  assert.deepStrictEqual(why({ live: 1999999 }), ['staked']);
  assert.deepStrictEqual(why({ rake: 99999 }), ['rake']);
  assert.deepStrictEqual(why({ withdraws: 1899999 }), ['withdraws']);
  // an owed row not paid yet: the refunds actually sent are what the withdraws hold
  assert.deepStrictEqual(why({ refundsPaid: 0, withdraws: 1400000 }), []);
  assert.deepStrictEqual(why({ house: NaN }), ['not-micro']);
  assert.deepStrictEqual(why({ sweeps: 1.5 }), ['not-micro']);
  assert.deepStrictEqual(why({ cashNet: undefined }), ['rake-without-net', 'withdraws-without-parts']);
  assert.deepStrictEqual(C.checkLedger({ staked: 0, cashGross: 0, refunds: 0, house: 0, live: 0 }), []);
  assert.deepStrictEqual(C.checkLedger(null).map((v) => v.detail.why), ['not-micro']);
});

test('sumBanks adds every room\'s counters; live is accounts plus floor', () => {
  const a = world();
  const b = world();
  b.bank.withdraw(2, 'refund');
  const s = C.sumBanks([a.room, b.room, { bank: null }]);
  assert.strictEqual(s.in, 3000000);
  assert.strictEqual(s.outRefund, 500000);
  assert.strictEqual(s.live, s.acc + s.floor);
  assert.strictEqual(s.acc + s.floor + s.outCash + s.outRefund + s.outHouse, s.in);
  assert.deepStrictEqual(s.house, { swept: 0, abandoned: 0, breach: 0 });
});

test('slCheck is pure: it requires only the law helpers, and holds no clock and no randomness', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'slPaid', 'slCheck.js'), 'utf8');
  const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(reqs, ['../sl/slLaws']);
  const code = src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(code, /Math\.random|Date\.now|new Date|performance\.now|console\./);
});
