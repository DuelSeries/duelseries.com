'use strict';
// Chomp's arena grows and shrinks with the crowd (server/chomp/chompResize.js): a module column or row goes in or out
// where no person is near, nobody moves relative to the maze or to each other, ghosts come and go with their modules,
// dots carry over, and a paid room's coins lying in a removed column are moved to the nearest path tile, never lost.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../shared/chompRules');
const { ChompRoom } = require('../server/chomp/chompRoom');
const Resize = require('../server/chomp/chompResize');

const quiet = { error() {}, warn() {}, log() {} };

function onPath(room, x, y) { return room.A.walk(Math.floor(x), Math.floor(y)); }

// What a chomper sees: the walls and dots in the 9 x 9 tiles round it.
function around(room, p) {
  const out = [];
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const c = Math.floor(p.x) + dx, r = Math.floor(p.y) + dy;
    out.push(room.A.walk(c, r) ? 1 + room.dots[room.A.k(c, r)] : 0);
  }
  return out.join('');
}

test('growing by a column: nobody moves, the view round everybody is the same, a new module brings its ghosts', () => {
  const room = new ChompRoom({ seed: 21, botFill: 6, grow: false, log: quiet });
  for (let t = 0; t < 600; t++) room.step();
  const before = new Map([...room.players.values()].map((p) => [p.id, { x: p.x, y: p.y, view: around(room, p) }]));
  const pairs = (r) => {
    const ps = [...r.players.values()], out = [];
    for (const a of ps) for (const b of ps) if (a.id < b.id) out.push([a.id, b.id, +r.A.dx(a.x, b.x).toFixed(6), +r.A.dy(a.y, b.y).toFixed(6)]);
    return out;
  };
  const W0 = room.A.W, ghosts0 = room.ghosts.length, rel0 = pairs(room);
  const msg = Resize.apply(room, { axis: 'x', op: 1, seam: 1 });
  assert.ok(msg && msg.mx === 3 && msg.my === 2);
  assert.strictEqual(room.A.W, W0 + Resize.SPAN_X);
  assert.strictEqual(room.ghosts.length, ghosts0 + 8, 'two new modules, four ghosts each');
  assert.ok(room.ghosts.every((g, i) => g.index === i));
  assert.strictEqual(msg.dots.length, room.A.W * room.A.H);
  // pairs whose short way does not cross the new column keep their distance exactly
  const seamX = 1 * Resize.SPAN_X;
  const crosses = (pr) => {
    const a = before.get(pr[0]), b = before.get(pr[1]);
    const dx = room.A.dx(0, 0) + (((b.x - a.x) % W0) + W0) % W0;   // a to b going right, in the old arena
    const right = dx <= W0 / 2;
    const t = (((seamX - a.x) % W0) + W0) % W0;
    return right ? t < dx : t > dx;
  };
  const after = pairs(room);
  rel0.forEach((pr, i) => { if (!crosses(pr) && Math.abs(pr[2]) < W0 / 2 - 1) assert.deepStrictEqual(after[i], pr); });
  for (const p of room.players.values()) {
    const b = before.get(p.id);
    assert.ok(onPath(room, p.x, p.y), 'still on a path');
    // nothing changes round anybody more than 5 tiles from where the column went in
    if (Resize.bandDist(b.x, seamX, seamX, W0) > 5) assert.strictEqual(around(room, p), b.view, 'the same maze round you');
  }
  assert.ok(msg.gmap.every((j) => j >= 0), 'every old ghost kept');
  for (let t = 0; t < 600; t++) room.step();   // and the bigger arena plays on
});

test('shrinking: the removed column\'s coins go to the nearest kept path tile; the bank books do not move', () => {
  const calls = { breach: [] };
  const hooks = { onCashout() {}, onRefund() {}, onTransfer() {}, onFeed() {}, onBreach: (b) => calls.breach.push(b),
    onStake() {}, onHouse() {}, onOwed() {}, onSweep() {}, onFloor() {}, onSeedBack() {}, onSeedSpent() {},
    onAccountOpen() {}, onAccountConfirmed() {}, onAccountClosed() {} };
  const room = new ChompRoom({ mx: 3, my: 2, seed: 9, stake: 0.5, moneyHooks: hooks, botFill: 0, grow: false, log: quiet,
    now: () => 1e6 });
  room.ghosts = room.ghosts.filter(() => false);   // no catches but ours
  const s = { id: 's1', emit() {} };
  const acct = room.addPaidHuman(s, { name: 'ann', micro: 1000000, wallet: 'W-ann', paid: 1 });
  room.ready(s.id);
  const p = room.players.get(acct.pid);
  // ann dies in module column 2 (x 58..86): her 8 coins lie there
  p.x = 2 * Resize.SPAN_X + 1.5; p.y = 1.5; p.safe = 0;
  room.kill(p, null, {});
  room.step();
  const coins0 = room.money.coins().map((c) => c.micro);
  assert.strictEqual(coins0.reduce((t, v) => t + v, 0), 1000000);
  // another person far away, in module column 0
  const s2 = { id: 's2', emit() {} };
  const b = room.addPaidHuman(s2, { name: 'bob', micro: 500000, wallet: 'W-bob', paid: 0.5 });
  room.ready(s2.id);
  const pb = room.players.get(b.pid);
  pb.x = 14.5; pb.y = 23.5;
  room.players.delete(acct.pid);   // ann's chomper has gone (its death ended)
  const total0 = room.money.bank.totalMicro();
  const msg = Resize.apply(room, { axis: 'x', op: -1, seam: 2 });
  assert.ok(msg && msg.mx === 2);
  assert.strictEqual(room.money.bank.totalMicro(), total0, 'not a micro moved');
  assert.ok(room.money.bank.assertConserved());
  const coins = room.money.coins();
  assert.strictEqual(coins.length, coins0.length, 'every coin kept');
  for (const c of coins) {
    assert.ok(c.x >= 0 && c.x < room.A.W && c.y >= 0 && c.y < room.A.H, 'on the new map');
    assert.ok(room.A.walk(c.x, c.y), 'on a path tile');
    assert.strictEqual(c.k, c.y * room.A.W + c.x);
    assert.ok(room.money.hasCoinAt(c.k), 'indexed at its tile');
  }
  assert.strictEqual(msg.coins.length, coins.length);
  assert.strictEqual(calls.breach.length, 0);
  // bob can still walk onto one and take it
  const c0 = coins[0];
  pb.x = c0.x + 0.5; pb.y = c0.y + 0.5;
  room.step();
  assert.ok(room.money.balance(b.pid) > 500000);
});

test('the plan: grows with the crowd, never where a person is near, and shrinks back down to 2 x 2', () => {
  const room = new ChompRoom({ seed: 2, botFill: 0, grow: false, log: quiet });
  for (let i = 0; i < 14; i++) { const b = room._spawnBot(); b.x = 14.5; b.y = 23.5; }
  const human = room.addPlayer({ name: 'me' });
  human.x = 14.5; human.y = 23.5;
  const pl = Resize.plan(room);
  assert.ok(pl && pl.op === 1, 'fifteen chompers ask for more than four modules');
  // a person sitting on every seam: no seam is clear
  const seams = [];
  for (let s = 0; s < room.A.mx; s++) seams.push([s * Resize.SPAN_X + 0.5, 23.5]);
  for (let s = 0; s < room.A.my; s++) seams.push([14.5, s * Resize.SPAN_Y + 0.5]);
  for (const [x, y] of seams) { const q = room.addPlayer({ name: 'p' + x + y }); q.x = x; q.y = y; }
  assert.strictEqual(Resize.plan(room), null, 'nowhere out of sight: no change');
  // quiet again: shrinks, but never below 2 x 2
  const small = new ChompRoom({ mx: 3, my: 2, seed: 2, botFill: 0, grow: false, log: quiet });
  assert.strictEqual(Resize.plan(small).op, -1);
  const tiny = new ChompRoom({ seed: 2, botFill: 0, grow: false, log: quiet });
  assert.strictEqual(Resize.plan(tiny), null);
  assert.strictEqual(Resize.wantModules(100), R.MODULES_MAX > 34 ? 34 : R.MODULES_MAX);
});

test('a crowd with people on every column seam: the grid stays near square and inside the wire\'s 511 tiles', () => {
  const room = new ChompRoom({ seed: 5, botFill: 0, grow: false, log: quiet });
  for (let i = 0; i < 98; i++) room._spawnBot();
  const people = [room.addPlayer({ name: 'a' }), room.addPlayer({ name: 'b' })];
  for (let round = 0; round < 40; round++) {
    // park the people just past every column seam there is
    people.forEach((p, i) => { p.x = (i % room.A.mx) * Resize.SPAN_X + 2.5; p.y = 23.5; });
    const pl = Resize.plan(room);
    if (!pl) break;
    Resize.apply(room, pl);
    assert.ok(Math.abs(room.A.mx - room.A.my) <= 1, 'near square: ' + room.A.mx + 'x' + room.A.my);
    assert.ok(room.A.W <= 511 && room.A.H <= 511, 'inside the wire');
  }
  assert.ok(room.A.mx * room.A.my <= R.MODULES_MAX);
});
