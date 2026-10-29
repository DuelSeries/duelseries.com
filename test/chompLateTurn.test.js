'use strict';
// Chomp's late turn in a paid room (night review 2026-10-29, findings 10 and 19): a turn the page names a tile for that
// we already left is taken back only LATE_TURN_TICKS_PAID ticks (a free room keeps LATE_TURN_TICKS), never through a
// ghost or a powered chomper on the way, and a seat whose turns keep coming near that limit is logged once.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../shared/chompRules');
const Ghosts = require('../server/chomp/chompGhosts');
const { ChompRoom } = require('../server/chomp/chompRoom');

const quiet = { error() {}, warn() {}, log() {} };
const noop = () => {};
const HOOKS = {
  onCashout: noop, onRefund: noop, onTransfer: noop, onFeed: noop, onBreach: noop, onStake: noop, onHouse: noop,
  onOwed: noop, onSeedBack: noop, onSeedSpent: noop, onSweep: noop, onFloor: noop, onAccountOpen: noop,
  onAccountConfirmed: noop, onAccountClosed: noop,
};

let sn = 0;
function sock(id) {
  return { id: id || 'lt' + ++sn, events: [], emit(ev, p) { this.events.push([ev, p]); } };
}

function paidRoom(opts) {
  const clock = { t: 5000000 };
  const r = new ChompRoom(Object.assign({ mx: 1, my: 1, seed: 11, stake: 0.5, moneyHooks: HOOKS, now: () => clock.t,
    log: quiet, grow: false }, opts));
  r.ghosts = [];
  return r;
}

function seat(r, name, micro) {
  const s = sock(name);
  const acct = r.addPaidHuman(s, { name, micro: micro || 500000, wallet: 'W-' + name, paid: (micro || 500000) / 1e6 });
  assert.ok(acct && typeof acct === 'object', 'seated: ' + acct);
  assert.strictEqual(r.ready(s.id), true);
  const p = r.players.get(acct.pid);
  p.safe = 0;
  return { s, p };
}

// Run p right along row 1 from col 3 until it has spent `past` more ticks after its first one in col 6 (the opening
// down is at col 5), with no dots to pause it.
function runPast(room, p, past) {
  room.dots.fill(0);
  p.x = 3.5; p.y = 1.5; p.dir = 3; p.want = 3; p.pend = null; p.hist = []; p.pause = 0;
  for (let i = 0; i < 60 && Math.floor(p.x) < 6; i++) room.stepPlayer(p);
  assert.strictEqual(Math.floor(p.x), 6);
  for (let i = 0; i < past; i++) room.stepPlayer(p);
  assert.ok(Math.floor(p.x) >= 6 && p.y === 1.5 && p.dir === 3, 'still running right on row 1');
}

let seq = 0;
function turnDownAtCol5(room, p) { room.input(p, 2, ++seq, 5, 1); }

function ghostAt(room, x, y) {
  const g = Ghosts.makeGhosts(room.A)[0];
  g.state = 'active'; g.x = x; g.y = y; g.fright = 0;
  return g;
}

test('finding 10/19: a paid room takes a late turn back at most LATE_TURN_TICKS_PAID ticks; a free room keeps 15', () => {
  assert.ok(R.LATE_TURN_TICKS_PAID < R.LATE_TURN_TICKS);
  const free = new ChompRoom({ mx: 1, my: 1, botFill: 0, seed: 5, log: quiet });
  const f = free.addPlayer({ name: 'f' });
  f.safe = 0;
  runPast(free, f, 9);
  turnDownAtCol5(free, f);
  assert.strictEqual(f.dir, 2, 'free: 10 ticks after the opening, still taken back');
  assert.ok(Math.abs(f.x - 5.5) < 0.6 && f.y > 1.5);

  const r = paidRoom();
  const { p } = seat(r, 'ann');
  runPast(r, p, 9);
  const x0 = p.x;
  turnDownAtCol5(r, p);
  assert.strictEqual(p.dir, 3, 'paid: 10 ticks after the opening is too late to take back');
  assert.strictEqual(p.want, 2, 'the turn waits for the next opening, as a turn sent too late does');
  assert.strictEqual(p.x, x0, 'nothing moved');

  runPast(r, p, 3);
  turnDownAtCol5(r, p);
  assert.strictEqual(p.dir, 2, 'paid: 4 ticks after it (jitter) is still taken back');
  assert.ok(Math.abs(p.x - 5.5) < 0.6 && p.y > 1.5, `turned down at col 5 (${p.x}, ${p.y})`);

  // the very limit: the last tick in col 5 is the oldest one a paid room looks at
  runPast(r, p, R.LATE_TURN_TICKS_PAID - 2);
  turnDownAtCol5(r, p);
  assert.strictEqual(p.dir, 2, 'the last tick inside the window');
  runPast(r, p, R.LATE_TURN_TICKS_PAID - 1);
  turnDownAtCol5(r, p);
  assert.strictEqual(p.dir, 3, 'one tick more is outside it');
});

test('finding 19: a paid late turn never carries the chomper through a ghost or a powered chomper', () => {
  const r = paidRoom();
  const { p } = seat(r, 'ann');
  const { p: q } = seat(r, 'bob');
  q.x = 20.5; q.y = 29.5; q.dir = -1; q.hist = [];

  // without anything in the way the turn is taken back into the side corridor, row 2
  runPast(r, p, 5);
  turnDownAtCol5(r, p);
  assert.strictEqual(p.dir, 2);
  assert.ok(Math.floor(p.y) === 2, `into row 2 (${p.y})`);

  // a ghost on that path: not taken back
  r.ghosts = [ghostAt(r, 5.5, 2.5)];
  runPast(r, p, 5);
  turnDownAtCol5(r, p);
  assert.strictEqual(p.dir, 3, 'a ghost on the path: no turn back in time');
  assert.strictEqual(p.want, 2);
  // the same ghost blue for p (p ate an energizer): it is p's to eat, the turn goes
  p.power = 100; p.powerAt = r.tick; r.ghosts[0].backAt = -1;
  runPast(r, p, 5);
  turnDownAtCol5(r, p);
  assert.strictEqual(p.dir, 2, 'a blue ghost is no threat');
  p.power = 0;
  r.ghosts = [];

  // a powered chomper on the path: not taken back; p powered too: taken back
  q.x = 5.5; q.y = 2.5; q.power = 100;
  runPast(r, p, 5);
  turnDownAtCol5(r, p);
  assert.strictEqual(p.dir, 3, 'a powered chomper on the path');
  p.power = 50;
  runPast(r, p, 5);
  turnDownAtCol5(r, p);
  assert.strictEqual(p.dir, 2, 'powered against powered: no catch, the turn goes');

  // a free room keeps today's rule (the move on is movement only)
  const free = new ChompRoom({ mx: 1, my: 1, botFill: 0, seed: 5, log: quiet });
  free.ghosts = [ghostAt(free, 5.5, 2.5)];
  const f = free.addPlayer({ name: 'f' });
  f.safe = 0;
  runPast(free, f, 5);
  turnDownAtCol5(free, f);
  assert.strictEqual(f.dir, 2, 'free: unchanged');
});

test('finding 10: a paid seat whose turns keep coming near the limit is logged once; an honest one never', () => {
  const warns = [];
  const log = { error() {}, log() {}, warn(m) { warns.push(String(m)); } };
  const r = paidRoom({ log });
  const { p: late } = seat(r, 'late');
  const { p: fair } = seat(r, 'fair');
  for (let n = 0; n < 30; n++) {
    runPast(r, fair, 1);                                  // two ticks past the tile: jitter
    turnDownAtCol5(r, fair);
    assert.strictEqual(fair.dir, 2);
  }
  assert.strictEqual(warns.filter((w) => w.includes('LATE-TURN')).length, 0, 'an honest seat is not logged');
  for (let n = 0; n < 30; n++) {
    runPast(r, late, R.LATE_TURN_TICKS_PAID - 2);         // the most a paid room takes back, every time
    turnDownAtCol5(r, late);
    assert.strictEqual(late.dir, 2);
  }
  const hits = warns.filter((w) => w.includes('LATE-TURN'));
  assert.strictEqual(hits.length, 1, 'logged once');
  assert.ok(hits[0].includes('ch_na_s0_5') && hits[0].includes('"late"'), hits[0]);
});
