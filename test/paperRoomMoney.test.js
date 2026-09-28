'use strict';
// PaperRoom money (T7, design 5.1-5.9): kills, coins, the hour sweep, the disconnect grace,
// join flushing, reseats, the emergency close, and 5000 random ticks of conservation.
const test = require('node:test');
const assert = require('node:assert');
const { PaperRoom } = require('../server/paper/PaperRoom');
const { REASON, P, MP } = require('../server/paper/ArenaGame');

const C = 1000;
const at = (r, a) => new P.Vec2(C + Math.cos(a) * r, C + Math.sin(a) * r);

function kit({ stake = 0.1, seed = 0.3 } = {}) {
  let t = 5000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const calls = { cashout: [], transfer: [], refund: [], sweep: [], breach: [] };
  const emits = [];
  const io = {
    to: (target) => ({
      emit: (ev, p) => emits.push([target, ev, p]),
      volatile: { emit: (ev, p) => emits.push([target, ev, p, 'volatile']) }
    })
  };
  const hooks = {
    onCashout: (o) => calls.cashout.push(o),
    onTransfer: (x) => calls.transfer.push(x),
    onRefund: (x) => calls.refund.push(x),
    onSweep: (x) => calls.sweep.push(x),
    onBreach: (x) => calls.breach.push(x)
  };
  const room = new PaperRoom({ stake, io, hooks, now: clock.now, autoTick: false, seed });
  if (stake > 0) {
    room.game.radiusTarget = () => 950;
    room.game.setRadiusNow(950);
  }
  return { room, clock, calls, emits, g: room.game, bank: room.bank };
}

let sockN = 0;
function sock() {
  return {
    id: 's' + ++sockN,
    rooms: new Set(),
    got: [],
    join(r) { this.rooms.add(r); },
    leave(r) { this.rooms.delete(r); },
    emit(ev, p) { this.got.push([ev, p]); }
  };
}

function tick(k, n = 1) {
  for (let i = 0; i < n; i++) {
    k.clock.advance(MP.STEP_MS);
    k.room.tickOnce();
  }
}

function join(k, spot, micro = 100000, name) {
  const s = sock();
  const seat = k.room.addHuman(s, { name: name || s.id, micro, wallet: 'W' + s.id, spot });
  seat.unit.locked = false;
  k.room._confirm(seat); // its player got pp:joined (the unconfirmed-seat rules have their own tests)
  return { s, seat, u: seat.unit };
}

function conserved(k) {
  return k.bank.totalMicro() === k.bank.ledger.inMicro - k.bank.ledger.outMicro;
}

test('join, kill, chain kill and a multi-victim capture move money exactly once per victim', () => {
  const k = kit();
  const a = join(k, at(300, 0.3));
  const b = join(k, at(300, 1.8));
  const c = join(k, at(300, 3.3));
  const d = join(k, at(300, 4.8));
  assert.strictEqual(k.bank.balance(a.u.id), 100000);
  const payload = a.s.got.find(e => e[0] === 'pp:joined')[1];
  assert.strictEqual(payload.units.find(x => x.id === a.u.id).micro, 100000);
  k.g.kill(b.u, a.u, REASON.TRACK_CUT);
  assert.strictEqual(k.bank.balance(a.u.id), 200000);
  assert.strictEqual(k.bank.balance(b.u.id), 0);
  k.g.kill(a.u, c.u, REASON.TRACK_CUT);
  assert.strictEqual(k.bank.balance(c.u.id), 300000, 'chain kill carries 300000');
  // One capture kills two: each victim its own transfer and collusion record.
  const e = join(k, at(500, 0.9));
  k.g.kill(d.u, e.u, REASON.ENCIRCLED);
  k.g.kill(c.u, e.u, REASON.EXIT_POINT_CAPTURED);
  k.g.kill(c.u, e.u, REASON.ENCIRCLED); // the same capture can call kill twice
  assert.strictEqual(k.bank.balance(e.u.id), 500000);
  const kills = k.calls.transfer.filter(t => t.kind === 'kill');
  assert.strictEqual(kills.length, 4);
  assert.ok(kills.every(t => t.label === k.room.lobbyType));
  assert.deepStrictEqual(kills.map(t => t.micro), [100000, 200000, 100000, 300000]);
  assert.ok(conserved(k));
  assert.strictEqual(k.room.liveHumans, 1);
});

test('a self cross drops ONE coin where it died; nearer wins; collected once; onTransfer once', () => {
  const k = kit();
  const v = join(k, at(200, 1.0));
  const near = join(k, at(420, 1.0));
  const far = join(k, at(420, 1.35));
  k.g.kill(v.u, undefined, REASON.SELF_CROSS);
  const coins = k.bank.pickups();
  assert.strictEqual(coins.length, 1);
  assert.strictEqual(coins[0].micro, 100000);
  assert.ok(Math.abs(coins[0].x - v.u.position.x) < 1e-9 && Math.abs(coins[0].y - v.u.position.y) < 1e-9);
  assert.ok(k.room.pending.some(e => e[0] === 'p+' && e[1] === coins[0].pid));
  // Put both on the coin, the near one closer.
  near.u.position = new P.Vec2(coins[0].x + 3, coins[0].y);
  far.u.position = new P.Vec2(coins[0].x + 9, coins[0].y);
  near.u.locked = far.u.locked = true;
  near.u.holdBit = far.u.holdBit = false;
  k.room._collectPickups();
  k.room._collectPickups();
  assert.strictEqual(k.bank.balance(near.u.id), 200000);
  assert.strictEqual(k.bank.balance(far.u.id), 100000);
  const pickups = k.calls.transfer.filter(t => t.kind === 'pickup');
  assert.deepStrictEqual(pickups, [{ srcWallet: 'W' + v.s.id, dstWallet: 'W' + near.s.id, micro: 100000, kind: 'pickup', label: k.room.lobbyType }]);
  assert.ok(conserved(k));
});

test('the hour sweep: 59 minutes collectable, 61 minutes swept exactly once (ticking and frozen)', () => {
  for (const frozen of [false, true]) {
    const k = kit();
    const v = join(k, at(200, 1.0));
    join(k, at(400, 3.0));
    k.g.kill(v.u, undefined, REASON.SELF_CROSS);
    const coin = k.bank.pickups()[0];
    const before = k.room.liveStakeTotal();
    k.clock.advance(59 * 60000);
    if (frozen) k.room.sweepPickups(k.clock.now()); else tick(k);
    assert.strictEqual(k.bank.pickups().length, 1, '59 minutes: still on the floor');
    k.clock.advance(2 * 60000);
    if (frozen) k.room.sweepPickups(k.clock.now()); else tick(k);
    if (frozen) k.room.sweepPickups(k.clock.now()); else tick(k);
    assert.strictEqual(k.bank.pickups().length, 0);
    assert.strictEqual(k.calls.sweep.length, 1);
    const s = k.calls.sweep[0];
    assert.strictEqual(s.micro, 100000);
    assert.strictEqual(s.srcWallet, 'W' + v.s.id);
    assert.strictEqual(s.label, k.room.lobbyType);
    assert.ok(/^[0-9a-f-]{36}$/.test(s.sweepId));
    assert.ok(k.room.pending.concat(k.emits.flatMap(e => e[1] === 'pp:ev' ? e[2].ev : [])).some(e => e[0] === 'p-' && e[1] === coin.pid && e[2] === 0 && e[3] === 100000));
    assert.ok(Math.abs(before - k.room.liveStakeTotal() - 0.1) < 1e-9, 'liability dropped by the coin');
    assert.ok(conserved(k));
  }
});

test('disconnect grace: hold cleared, still moving and killable; expiry drops a coin; a resume keeps everything', () => {
  const k = kit();
  const a = join(k, at(250, 0.5));
  const killer = join(k, at(250, 3.5));
  for (let i = 0; i < 5; i++) { k.room.setInput(a.s.id, MP.encodeInput(i, 30, true)); tick(k); }
  assert.ok(a.u.locked);
  k.room.beginGrace(a.seat);
  assert.strictEqual(a.u.locked, false);
  assert.strictEqual(a.u.holdTicks, 0);
  const p0 = a.u.position.clone();
  tick(k, 30);
  assert.ok(a.u.position.distance(p0) > 20, 'keeps moving on its last steering');
  assert.strictEqual(k.room.liveHumans, 2);
  assert.strictEqual(k.room.snakes.get('pp' + a.u.id).alive, true, 'listed while in grace');
  // Resume inside the window: same unit, same account, no deposit.
  const inBefore = k.bank.ledger.inMicro;
  const s2 = sock();
  assert.ok(k.room.resume(s2, a.seat));
  assert.strictEqual(k.bank.ledger.inMicro, inBefore);
  assert.strictEqual(k.bank.balance(a.u.id), 100000);
  const rj = s2.got.find(e => e[0] === 'pp:joined')[1];
  assert.strictEqual(rj.resumed, true);
  assert.strictEqual(rj.you, a.u.id);
  // Grace again, and this time a kill during it pays the killer.
  k.room.beginGrace(a.seat);
  k.g.kill(a.u, killer.u, REASON.TRACK_CUT);
  assert.strictEqual(k.bank.balance(killer.u.id), 200000);
  // A third player's grace expires: the coin drops where the square then stands.
  const c = join(k, at(250, 2.0));
  k.room.beginGrace(c.seat);
  tick(k, Math.ceil(MP.DISCONNECT_GRACE_MS / MP.STEP_MS) + 2);
  assert.ok(c.u.death);
  const coin = k.bank.pickups()[0];
  assert.strictEqual(coin.micro, 100000);
  assert.ok(Math.hypot(coin.x - c.u.position.x, coin.y - c.u.position.y) < 1e-6);
  assert.strictEqual(k.room.liveHumans, 1);
  assert.ok(conserved(k));
});

test('a coin is pushed inward by a shrink, never deleted', () => {
  const k = kit();
  const v = join(k, at(200, 1.0));
  join(k, at(300, 3.0));
  k.g.kill(v.u, undefined, REASON.SELF_CROSS);
  const pid = k.bank.pickups()[0].pid;
  k.bank.movePickup(pid, C + 930, C);
  k.g.setRadiusNow(800);
  const p = k.bank.getPickup(pid);
  assert.ok(p, 'still there');
  assert.ok(Math.abs(Math.hypot(p.x - C, p.y - C) - (800 - MP.PICKUP_WALL_INSET)) < 1e-9);
});

test('a join between ticks never receives an event older than its payload', () => {
  const k = kit({ stake: 0 });
  tick(k, 20);
  const a = join(k, null, 0);
  tick(k, 3); // an odd tick count
  const victim = k.g.units.find(u => !u.isHuman);
  k.g.kill(victim, undefined, REASON.SELF_CROSS);
  assert.ok(k.room.pending.some(e => e[0] === 'k'));
  const evBefore = k.emits.filter(e => e[1] === 'pp:ev').length;
  const b = join(k, null, 0);
  const evs = k.emits.filter(e => e[1] === 'pp:ev');
  assert.strictEqual(evs.length, evBefore + 1, 'flushed to the room at the join');
  assert.strictEqual(evs[evs.length - 1][2].tick, k.g.tick);
  assert.ok(evs[evs.length - 1][2].ev.some(e => e[0] === 'j' && e[1].id === b.u.id), 'members learn of the joiner');
  assert.ok(b.s.got.every(e => e[0] !== 'pp:ev'), 'the joiner got no pp:ev directly');
  assert.ok(b.s.rooms.has(k.room.ioRoom));
  assert.deepStrictEqual(k.room.pending, []);
  void a;
});

test('a reseat moves no money and fires no death', () => {
  const k = kit();
  const a = join(k, at(300, 0.3));
  join(k, at(300, 2.3));
  const deaths = [];
  const od = k.room.onDeath.bind(k.room);
  k.room.onDeath = (...x) => { deaths.push(x); return od(...x); };
  const total = k.bank.totalMicro();
  const transfers = k.calls.transfer.length;
  assert.ok(k.g.reseat(a.u));
  assert.strictEqual(deaths.length, 0);
  assert.strictEqual(k.calls.transfer.length, transfers);
  assert.strictEqual(k.bank.totalMicro(), total);
  assert.ok(k.room.pending.some(e => e[0] === 'mv' && e[1] === a.u.id));
});

test('open question 7: a pushed square that cuts a trail takes the money like any killer', () => {
  const k = kit();
  const a = join(k, at(300, 0.3));
  const b = join(k, at(300, 2.3));
  b.u._inPush = true;
  k.g.kill(a.u, b.u, REASON.TRACK_CUT);
  b.u._inPush = false;
  assert.ok(a.u.death);
  assert.strictEqual(k.bank.balance(b.u.id), 200000);
});

test('three thrown ticks close the arena once: 90/10 cash-outs with UUIDs, coins refunded once', (t) => {
  t.mock.method(console, 'error', () => {});
  const k = kit();
  const a = join(k, at(300, 0.3));
  const b = join(k, at(300, 2.3), 1000000);
  const v = join(k, at(300, 4.3));
  k.g.kill(v.u, undefined, REASON.SELF_CROSS);
  const upd = k.g.update.bind(k.g);
  k.g.update = () => { throw new Error('boom'); };
  tick(k, 3);
  assert.ok(k.room.stopped);
  assert.deepStrictEqual(k.calls.cashout.map(o => [o.wallet, o.grossMicro]).sort(), [['W' + a.s.id, 100000], ['W' + b.s.id, 1000000]].sort());
  assert.ok(k.calls.cashout.every(o => /^[0-9a-f-]{36}$/.test(o.cashoutId) && o.label === k.room.lobbyType && !('forced' in o)));
  assert.deepStrictEqual(k.calls.refund.map(r => [r.wallet, r.micro]), [['W' + v.s.id, 100000]]);
  assert.strictEqual(k.bank.totalMicro(), 0);
  assert.ok(conserved(k));
  assert.ok(k.calls.breach.some(x => x.kind === 'emergency'));
  tick(k);
  k.room.emergencyClose();
  assert.strictEqual(k.calls.cashout.length, 2, 'a fourth throw pays nothing');
  assert.strictEqual(k.calls.refund.length, 1);
  void upd;
});

test('a free room never pays out; IDLE is logged once when the last human leaves money behind', (t) => {
  const f = kit({ stake: 0 });
  tick(f, 10);
  const h = join(f, null, 0);
  for (let i = 0; i < MP.HOLD_TICKS + 3; i++) { f.room.setInput(h.s.id, MP.encodeInput(i & 255, 10, true)); tick(f); }
  assert.ok(h.u.death);
  assert.strictEqual(f.calls.cashout.length, 0);
  assert.ok(f.emits.some(e => e[0] === h.s.id && e[1] === 'pp:cashedout' && e[2].grossMicro === 0));

  const logs = [];
  t.mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
  const k = kit();
  const a = join(k, at(300, 0.3));
  const b = join(k, at(300, 2.3));
  k.g.kill(a.u, undefined, REASON.SELF_CROSS);
  k.room.removeHuman(b.u.id, REASON.LEAVE);
  const idle = logs.filter(l => l.startsWith('[PAPER] IDLE ' + k.room.lobbyType));
  assert.strictEqual(idle.length, 1);
  assert.ok(idle[0].includes('"micro":100000'));
});

test('5000 random ticks of joins, kills, coins, cash-outs, disconnects, graces, sweeps and shrinks stay conserved', () => {
  let s = 4242;
  const rand = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  const k = kit({ seed: 0.9 });
  let target = 950;
  k.g.radiusTarget = () => target;
  const live = [];
  const ops = { join: 0, kill: 0, cashout: 0, grace: 0, resume: 0, leave: 0, shrink: 0 };
  let seq = 0;
  for (let t = 0; t < 5000; t++) {
    const r = rand();
    const alive = live.filter(x => !x.u.death);
    if (r < 0.02 && alive.length < 12) {
      const spot = k.room.findSpawn();
      if (spot) { live.push(join(k, spot, rand() < 0.5 ? 100000 : 1000000)); ops.join++; }
    } else if (r < 0.03 && alive.length >= 2) {
      const v = alive[Math.floor(rand() * alive.length)];
      const killer = rand() < 0.6 ? alive.find(x => x !== v) : null;
      k.g.kill(v.u, killer ? killer.u : undefined, killer ? REASON.TRACK_CUT : REASON.SELF_CROSS);
      ops.kill++;
    } else if (r < 0.035 && alive.length) {
      const x = alive[Math.floor(rand() * alive.length)];
      if (x.seat.socketId) { k.room.beginGrace(x.seat); ops.grace++; }
      else { const s2 = sock(); k.room.resume(s2, x.seat); x.s = s2; ops.resume++; }
    } else if (r < 0.038 && alive.length) {
      const x = alive[Math.floor(rand() * alive.length)];
      k.room.removeHuman(x.u.id, REASON.LEAVE);
      ops.leave++;
    } else if (r < 0.04) {
      target = 700 + Math.floor(rand() * 250);
      ops.shrink++;
    } else if (r < 0.041) {
      k.clock.advance(61 * 60000);
    }
    for (const x of alive) {
      if (x.u.death || !x.seat.socketId) continue;
      const hold = (t >> 8) % 4 === 0; // 256-tick windows, longer than HOLD_TICKS
      k.room.setInput(x.s.id, MP.encodeInput(++seq & 255, (t * 3 + x.u.id * 40) % 254, hold));
    }
    tick(k);
    assert.ok(conserved(k), 'tick ' + t);
    assert.ok(Math.abs(k.room.liveStakeTotal() * 1e6 - (k.bank.accountsMicro() + k.bank.floorMicro())) < 1e-3);
  }
  ops.cashout = k.calls.cashout.length;
  assert.strictEqual(k.calls.breach.length, 0);
  assert.ok(ops.join > 50 && ops.kill > 20 && ops.grace > 5 && ops.cashout > 0, JSON.stringify(ops));
});

test('the last seat dying mid-tick still sends its own kill and coin before the room goes idle', () => {
  for (const oddTick of [false, true]) {
    const k = kit();
    const a = join(k, at(300, 0.3));
    tick(k, oddTick ? 1 : 2);
    const move = k.g.handleUnitMovements.bind(k.g);
    k.g.handleUnitMovements = function (dt) {
      this.handleUnitMovements = move;
      this.kill(a.u, undefined, REASON.SELF_CROSS);
      return move(dt);
    };
    tick(k);
    const sent = k.emits.filter(e => e[1] === 'pp:ev').flatMap(e => e[2].ev);
    assert.ok(sent.some(e => e[0] === 'k' && e[1] === a.u.id), 'the victim\'s own kill went out (tick ' + k.g.tick + ')');
    assert.ok(sent.some(e => e[0] === 'p+'), 'and its coin');
    assert.deepStrictEqual(k.room.pending, []);
  }
  // Outside a tick (pp:leave of the last seat): flushed at once.
  const k2 = kit();
  const b = join(k2, at(300, 0.3));
  k2.room.removeHuman(b.u.id, REASON.LEAVE);
  assert.ok(k2.emits.filter(e => e[1] === 'pp:ev').flatMap(e => e[2].ev).some(e => e[0] === 'k' && e[1] === b.u.id));
});
