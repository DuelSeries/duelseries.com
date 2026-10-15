'use strict';
// slMoneyFuzz (PAID-SL-DESIGN.md 11.1 slMoneyFuzz; task T3): the money of real paid sl rooms (server/sl/slRoom.js with
// opts.money = server/slPaid/slMoney.js, the real sim, view and send queue, the FIXTURE table) under a scripted crowd
// of 2 to 22 paid snakes, 4 seeds x 20000 steps (the last with prey on, as production builds paid rooms): steering
// (often at another paid snake), boosting, border dives, holds kept to the cash-out or let go early, connection drops
// that come back (sl:back) or glide out and die, leaves, and new seats as the door makes them (its journal open first,
// a refusal refunded once). Injected throws:
//   - in sim.step after Phase A (the food pass, step 7): the room closes at once (emergencyFails 1), every account
//     refunded 100% of its grown balance through the owed lane, the floor swept to the house; the harness then opens a
//     fresh room, the directory's part
//   - in a fact: the eat of a cash pellet throws right after it is logged (mid Phase A), so the finally credits it and
//     the room closes as above; and the death fact's own hooks throw (the journal close, the directory's
//     onAccountClosed), which the controller swallows with the fact complete. A fact the bank itself refuses (split,
//     credit) leaves the sim and the money apart, which the checker reports by design, so it is not part of a
//     0-violation run: slPaidRoom pins that case in a live room
//   - in a hook: onCashout throwing or rejecting, onTransfer, onFloor and onBreach throwing, onOwed rejecting
// Checked: the full checker every step (money.endStep, checkEvery 1) finds nothing in any room; I9 across the rooms
// after every wake; every emergency row is the account's balance at the close, and the closed room's bank is empty;
// at the end I11 over the journal and I12 over the whole run (staked = gross + refunds + house + live, gross = net +
// rake with rake = floor(gross / 10)); and the same seed gives the same money trace.

const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../shared/slWire.js');
const slSnake = require('../server/sl/slSnake');
const { SlRoom } = require('../server/sl/slRoom');
const { createSlMoney } = require('../server/slPaid/slMoney');
const { HOUSE_CUT_DIV } = require('../server/paperPayout');
const { checkRoom, checkLaws, checkWalletSeats, checkJournal, checkLedger, sumBanks } = require('../server/slPaid/slCheck');
const { createRng } = require('../server/sl/slRng');
const { makeFixture } = require('./slLawsFixture');
const { fakeTimers, bareSocket } = require('./slNetFakes');

const LAWS = makeFixture();
const P = LAWS.L7.value;
const GRD = LAWS.L1.value;
const CASH_BYTE = LAWS.C_PAID_CASH_BYTE.value;
const PI2 = 2 * Math.PI;
const STEPS = 20000;
const OWED_KEY = /^agowed:[0-9a-f-]{36}$/; // db.js recordOwedOnce
const K = checkLaws(LAWS);

const quiet = { log() {}, warn() {}, error() {} };
const angle = (q) => W.encodeInput([{ type: 'angle', q }]);
const boost = (on) => W.encodeInput([{ type: 'boost', on }]);

function byteOf(a) {
  const w = ((a % PI2) + PI2) % PI2;
  return Math.round(w / PI2 * 251) % 251;
}

function uuidOf(prefix, n) {
  return prefix + '-0000-4000-8000-' + String(n).padStart(12, '0');
}

// One run: rooms opened one after another (a closed room is replaced), the crowd, the injections, the checks.
function run(seed, total, opts) {
  const o = opts || {};
  // one rung per run, as the directory keeps them: every token of a $0.50 room is worth 500000, of a $1 room 1000000
  const stake = o.stake === 1 ? 1 : 0.5;
  const LABEL = stake === 1 ? 'sl_na_s1' : 'sl_na_s0_5';
  const MICRO = stake * 1e6;
  const r = createRng(seed);
  const ft = fakeTimers(1000);
  const trace = [];
  const violations = [];
  const sums = { staked: 0, deposits: 0, doorRefunds: 0, gross: 0, net: 0, rake: 0, owed: 0, shutdown: 0, swept: 0,
    house: 0, transfers: 0 };
  const seen = { cashouts: 0, deaths: 0, transfers: 0, resumes: 0, drops: 0, leaves: 0, stepThrows: 0, eatThrows: 0,
    hookThrows: 0, holdsLetGo: 0, refusedSeats: 0, emergencyRows: 0, breaches: [] };
  const walletSeat = new Map(); // the directory's: wallet -> { room, snakeId }
  const journal = [];
  const deposits = new Map(); // jid -> deposit micro
  let uuidN = 0;
  let jidN = 0;
  let walletN = 0;
  let hookN = 0;
  const rooms = []; // every room opened, closed ones included (their banks stay for I12)
  let room = null;
  let money = null;

  const jnl = {
    open(acct, label) {
      journal.push({ t: 'open', jid: acct.jid, room: label, micro: acct.deposit });
      return true;
    },
    close(acct, outcome, extra, label) {
      journal.push(Object.assign({ t: 'close', jid: acct.jid, outcome, room: label }, extra));
      trace.push(['close', acct.jid, outcome, (extra && (extra.lostMicro || extra.refundedMicro || extra.grossMicro)) || 0]);
      if (o.hookThrows && ++hookN % 7 === 0) {
        seen.hookThrows++;
        throw new Error('injected journal close');
      }
      return true;
    },
  };

  function openRoom() {
    const ref = { room: null };
    let n = 0;
    const hooks = {
      onCashout(order) {
        assert.equal(order.stake, stake);
        assert.ok(Number.isSafeInteger(order.grossMicro) && order.grossMicro >= MICRO, 'a cash-out is never below the stake');
        sums.gross += order.grossMicro;
        const cut = Math.floor(order.grossMicro / HOUSE_CUT_DIV);
        sums.rake += cut;
        sums.net += order.grossMicro - cut;
        trace.push(['cashout', order.wallet, order.grossMicro, order.stake]);
        if (o.hookThrows && ++n % 3 === 0) {
          seen.hookThrows++;
          throw new Error('injected onCashout');
        }
        if (o.hookThrows && n % 5 === 0) {
          seen.hookThrows++;
          return Promise.reject(new Error('injected onCashout rejection'));
        }
        return undefined;
      },
      onOwed(row) {
        assert.match(row.key, OWED_KEY);
        sums.owed += row.micro;
        trace.push(['owed', row.key, row.wallet, row.micro]);
        if (o.hookThrows && ++n % 2 === 0) {
          seen.hookThrows++;
          return Promise.reject(new Error('injected onOwed rejection'));
        }
        return undefined;
      },
      onFloor(sweep) {
        sums.swept += sweep.micro;
        trace.push(['floor', sweep.srcWallet, sweep.micro, sweep.pid]);
        if (o.hookThrows) {
          seen.hookThrows++;
          throw new Error('injected onFloor');
        }
      },
      onHouse(x) {
        sums.house += x.micro;
        trace.push(['house', x.wallet, x.micro, x.why]);
      },
      onBreach(b) {
        if (b.kind !== 'emergency') seen.breaches.push(b);
        if (o.hookThrows) throw new Error('injected onBreach');
      },
      onTransfer(t) {
        sums.transfers += t.micro;
        trace.push(['transfer', t.srcWallet, t.dstWallet, t.micro]);
        if (o.hookThrows && ++n % 2 === 0) {
          seen.hookThrows++;
          throw new Error('injected onTransfer');
        }
      },
      onAccountOpen(acct) {
        if (walletSeat.has(acct.wallet)) throw new Error('wallet already seated');
        walletSeat.set(acct.wallet, { room: ref.room, snakeId: acct.snakeId });
      },
      onAccountClosed(acct) {
        const ws = walletSeat.get(acct.wallet);
        if (ws && ws.snakeId === acct.snakeId && ws.room === ref.room) walletSeat.delete(acct.wallet);
        if (o.hookThrows && ++n % 5 === 0) {
          seen.hookThrows++;
          throw new Error('injected onAccountClosed');
        }
      },
      journal: jnl,
    };
    money = createSlMoney({ stake, label: LABEL, hooks, now: ft.clock, uuid: () => uuidOf('00000000', ++uuidN),
      log: quiet, checkEvery: 1, walletSeat, laws: LAWS });
    room = new SlRoom(LAWS, { money, lobbyType: LABEL, humanCap: 22, seed: 1 + r.int(2147483646), clock: ft.clock,
      timers: ft.timers, autoTick: false, shippableOnly: false, prey: o.prey === true, now: () => 1.7e12, log: quiet });
    ref.room = room;
    // the full checker's answer of every step, kept
    const endStep = money.endStep.bind(money);
    money.endStep = () => {
      const e = endStep();
      for (const v of e.violations) violations.push({ step: room.stats.steps, room: rooms.length, v });
      for (const x of e.orphans) violations.push({ step: room.stats.steps, room: rooms.length, v: { kind: 'orphan', x } });
      return e;
    };
    // every emergency row is the account's balance at the close (grown by the facts of the step that threw), and those
    // facts were applied first
    const settle = money.emergencySettle.bind(money);
    money.emergencySettle = (why) => {
      // the facts of the step that threw are all applied before the settle (I8 reads that step's eats and deaths)
      for (const v of checkRoom(room, { K, full: false })) violations.push({ step: room.stats.steps, room: rooms.length, v });
      const at = new Map();
      for (const a of money.accounts.values()) at.set(a.jid, money.bank.balance(a.snakeId));
      const res = settle(why);
      for (const row of res.rows) {
        const jid = row.key.slice('agowed:'.length);
        assert.equal(row.micro, at.get(jid), 'the emergency row of ' + jid + ' is its balance at the close');
        assert.ok(row.micro >= deposits.get(jid), 'grown, never below the deposit');
        seen.emergencyRows++;
      }
      assert.deepEqual(res.left, []);
      return res;
    };
    rooms.push(room);
    trace.push(['room', rooms.length]);
    return room;
  }

  // The crowd. slot: { sock, seat, wallet, dive, holding, parkedAt, deadAt }
  const slots = [];
  let target = 2 + r.int(21);
  let armed = null; // 'step' | 'eat': the next wake's injected throw

  function doorSeat() {
    const wallet = 'W' + (++walletN);
    const jid = uuidOf('a0000000', ++jidN);
    const micro = MICRO;
    sums.staked += micro;
    // the door's step 8: the journal open before the seat (the account writes it again, design 3.3)
    journal.push({ t: 'open', jid, room: LABEL, micro });
    const sock = bareSocket();
    const acct = room.seatPaid(sock, { nick: 'p' + walletN, cv: r.int(9) }, { jid, micro, wallet, name: 'p' + walletN,
      paid: micro / 1e6 });
    if (!acct) {
      sums.doorRefunds += micro;
      seen.refusedSeats++;
      journal.push({ t: 'close', jid, outcome: 'refused', room: LABEL, why: 'full', reason: 'refund slither full' });
      trace.push(['refund', wallet, micro]);
      return;
    }
    deposits.set(jid, micro);
    sums.deposits += micro;
    trace.push(['open', wallet, micro, acct.snakeId]);
    slots.push({ sock, seat: room.seatOf(sock), wallet, dive: r.next() < 0.3, holding: false, parkedAt: NaN, deadAt: NaN });
  }

  function steer(slot, s) {
    const u = r.next();
    if (slot.dive && u < 0.3) {
      // a border dive: straight out from the centre
      room.onInput(slot.seat, angle(byteOf(Math.atan2(slSnake.headY(s) - GRD, slSnake.headX(s) - GRD))));
    } else if (u < 0.06) {
      // at another paid snake's head
      const others = slots.filter((x) => x !== slot && x.seat && !x.seat.dead && room.sim.snake(x.seat.snakeId));
      if (others.length) {
        const t = room.sim.snake(others[r.int(others.length)].seat.snakeId);
        room.onInput(slot.seat, angle(byteOf(Math.atan2(slSnake.headY(t) - slSnake.headY(s), slSnake.headX(t) - slSnake.headX(s)))));
      }
    } else if (u < 0.14) {
      room.onInput(slot.seat, angle(r.int(251)));
    } else if (u < 0.17) {
      room.onInput(slot.seat, boost(r.next() < 0.5));
    } else if (u < 0.174) {
      slot.holding = room.onHold(slot.seat, true) === true;
    } else if (u < 0.1755) {
      // the connection drops: parked, the snake glides
      room.unseat(slot.sock, 'disconnect');
      slot.parkedAt = room.stats.steps;
      seen.drops++;
    } else if (u < 0.176) {
      room.unseat(slot.sock, 'leave');
      slot.seat = null;
      seen.leaves++;
    }
  }

  function crowd() {
    for (let i = slots.length - 1; i >= 0; i--) {
      const slot = slots[i];
      const seat = slot.seat;
      if (!seat || seat.closed && !seat.parked) {
        slots.splice(i, 1);
        continue;
      }
      if (seat.parked) {
        // back within the glide now and then (sl:back with the seat's key and the bundles it got), else it dies
        if (!seat.dead && room.stats.steps - slot.parkedAt > 10 && r.next() < 0.02) {
          const sock = bareSocket();
          const res = room.resume(sock, seat.key, seat.queue.sentSeq, 0);
          if (res && typeof res === 'object') {
            slot.sock = sock;
            slot.holding = false;
            seen.resumes++;
          }
        }
        continue;
      }
      if (seat.dead) {
        if (!Number.isFinite(slot.deadAt)) slot.deadAt = room.stats.steps;
        else if (room.stats.steps - slot.deadAt > 20) {
          room.unseat(slot.sock, 'leave');
          slots.splice(i, 1);
        }
        continue;
      }
      const s = room.sim.snake(seat.snakeId);
      if (!s) continue;
      if (slot.holding) {
        if (r.next() < 0.004) {
          room.onHold(seat, false);
          slot.holding = false;
          seen.holdsLetGo++;
        } else {
          room.onHold(seat, true); // heard: keeps the hold's safety net quiet, as the layer's own pings do
        }
        continue;
      }
      steer(slot, s);
    }
    if (room.stats.steps % 500 === 0) target = 2 + r.int(21);
    const live = slots.filter((x) => x.seat && !x.seat.dead).length;
    if (live < target && r.next() < 0.2) doorSeat();
  }

  // The injections in the sim: the food pass after Phase A, or the eat of a cash pellet right after it is logged.
  function arm(kind) {
    const food = room.sim.food;
    if (kind === 'step') {
      const pass = food.step;
      food.step = function () {
        food.step = pass;
        seen.stepThrows++;
        throw new Error('injected step');
      };
    } else {
      const eat = food.eat;
      food.eat = function (f, id) {
        const v = eat.call(this, f, id);
        if (f.b >= CASH_BYTE) {
          food.eat = eat;
          seen.eatThrows++;
          throw new Error('injected eat');
        }
        return v;
      };
    }
  }

  // The run ends with a planned restart: every open account refunded 100% (rows for the caller), the floor abandoned.
  function settleAll() {
    for (const rm of rooms) {
      if (rm.closed) continue;
      for (const row of rm.money.shutdownSettle('shutdown')) {
        sums.shutdown += row.micro;
        trace.push(['shutdown', row.key, row.micro]);
      }
      rm.halt();
    }
  }

  openRoom();
  let done = 0;
  while (done < total) {
    crowd();
    if (o.simThrows && !armed && done > 200 && r.next() < 1 / 2500) {
      armed = r.next() < 0.5 ? 'step' : 'eat';
      arm(armed);
    }
    // wakes of 1 step, now and then 2 or 3 (a late timer: catch-up steps)
    const k = 1 + (r.next() < 0.1 ? r.int(3) : 0);
    ft.advance(k * P);
    const before = room.stats.steps;
    let threw = null;
    try {
      room.wake();
    } catch (e) {
      threw = e;
    }
    done += Math.max(1, room.stats.steps - before);
    ft.runImmediates();
    if (threw) {
      assert.match(threw.message, /injected (step|eat)/);
      assert.equal(room.closed, true, 'a paid step that threw closes the room');
      assert.equal(room.stopped, true);
      const b = room.money.bank;
      assert.equal(b.sums.acc + b.sums.floor, 0, 'the closed room holds nothing');
      assert.equal(b.ledger.in, b.ledger.outCash + b.ledger.outRefund + b.ledger.outHouse, 'I1 of the closed room');
      assert.equal(room.money.openCount(), 0);
      trace.push(['emergency', rooms.length]);
      armed = null;
      slots.length = 0;
      openRoom();
      continue;
    }
    for (const v of checkWalletSeats(rooms.filter((x) => !x.closed), walletSeat)) violations.push({ step: done, v });
  }
  settleAll();
  return { trace, violations, sums, seen, rooms, journal, walletSeat };
}

// The alerts a run may raise: the emergency close, and with the hook injections the controller's own alerts of a
// payout order, an owed row or a floor sweep whose hook failed (each logged CRITICAL, the money already moved).
const HOOK_ALERTS = new Set(['cashout-order', 'owed', 'sweep']);

// I12 over the whole run from the hooks and the banks, plus each bank counter against its hook.
function books(out) {
  const s = out.sums;
  const t = sumBanks(out.rooms);
  assert.equal(t.in, s.deposits, 'the banks took in exactly the seated deposits');
  assert.equal(t.outCash, s.gross, 'every gross cash-out was ordered once');
  assert.equal(t.outRefund, s.owed + s.shutdown, 'every refund out of a bank is an owed or a shutdown row');
  assert.equal(t.house.swept, s.swept, 'every swept micro went to onFloor');
  assert.equal(t.house.breach, s.house, 'every breach micro went to onHouse');
  assert.equal(t.live, 0, 'the planned restart left nothing in any room');
  return checkLedger({ staked: s.staked, cashGross: s.gross, refunds: s.doorRefunds + s.owed + s.shutdown,
    house: t.outHouse, live: t.live, cashNet: s.net, rake: s.rake });
}

// seed -> its rung, and prey on for the last (the directory builds paid rooms with prey as the free room has it)
const SEEDS = [[71, 0.5], [72, 1], [73, 0.5], [74, 0.5, true]];
const first = new Map();

for (const [seed, stake, prey] of SEEDS) {
  test('seed ' + seed + ' ($' + stake + (prey ? ', prey on' : '') + '): ' + STEPS + ' steps of 2 to 22 paid snakes ' +
    'with injected throws; the full checker every step finds nothing and the books close', () => {
    const out = run(seed, STEPS, { simThrows: true, hookThrows: true, stake, prey });
    first.set(seed, out.trace);
    assert.deepEqual(out.violations.slice(0, 5), [], out.violations.length + ' checker violation(s)');
    assert.deepEqual(out.seen.breaches.filter((b) => !HOOK_ALERTS.has(b.kind)).slice(0, 5), [], 'no breach alert');
    assert.deepEqual(books(out), [], 'I12');
    assert.deepEqual(checkJournal(out.journal, []), [], 'I11: every jid opened and closed once');
    assert.equal(out.walletSeat.size, 0, 'every wallet seat cleared with its account');
    // what the run went through
    const of = (k) => out.trace.filter((x) => x[0] === k).length;
    const closes = (k) => out.trace.filter((x) => x[0] === 'close' && x[2] === k).length;
    const seen = out.seen;
    seen.cashouts = of('cashout');
    seen.deaths = closes('died');
    seen.transfers = of('transfer');
    seen.rooms = out.rooms.length;
    // prey: spawned and eaten by paid snakes (growth only, no money), across every room of the run
    const preys = out.rooms.map((x) => (x.sim.preys ? x.sim.preys.stats() : { spawned: 0, eaten: 0 }));
    seen.preySpawned = preys.reduce((t, x) => t + x.spawned, 0);
    seen.preyEaten = preys.reduce((t, x) => t + x.eaten, 0);
    const msg = JSON.stringify(Object.assign({}, seen, { breaches: seen.breaches.length }));
    if (process.env.SL_FUZZ_SEEN) console.log(seed, msg);
    assert.equal(seen.preySpawned > 0, prey === true, msg);
    assert.ok(seen.cashouts >= 20 && seen.deaths >= 100 && seen.transfers >= 50, msg);
    assert.ok(seen.drops >= 20 && seen.resumes >= 3 && seen.leaves >= 5 && seen.holdsLetGo >= 3, msg);
    assert.ok(seen.stepThrows + seen.eatThrows >= 2 && seen.emergencyRows >= 2 && seen.hookThrows >= 20, msg);
    assert.equal(out.rooms.length, 1 + seen.stepThrows + seen.eatThrows, 'one fresh room per throwing step');
  });
}

test('the same seed and script give the same money trace', () => {
  const [seed, stake] = SEEDS[0];
  const again = run(seed, STEPS, { simThrows: true, hookThrows: true, stake });
  const a = first.get(seed) || run(seed, STEPS, { simThrows: true, hookThrows: true, stake }).trace;
  assert.equal(again.trace.length, a.length);
  assert.deepEqual(again.trace, a);
});
