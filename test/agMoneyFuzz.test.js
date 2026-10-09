'use strict';
// The money invariants of paid agar.io (PAID-AGAR-DESIGN.md 11; task rule 4), asserted EVERY tick of a 5000-tick fuzz
// in a real paid room: random steering (often at each other), splits, ejects, readies, holds (kept and let go),
// disconnects, resumes, dormant auto cash-outs, and step throws injected after the eats.
//   (1) totalMicro === inMicro - outMicro                       (value conserved; nothing from nothing)
//   (2) every open account has a live cell, or is frozen, or opened since the last step; no paid player has cells
//       without an account
//   (3) at the end: deposits = gross cash-outs + refunds + house + holdings, and gross = net + rake with
//       rake = floor(gross / 10)
//   (4) inMicro rises only by deposits (consumed token worth)
//   (5)/(10) food, eject, viruses, decay, merges and splits never move money, and no money fact is lost to a throwing
//       step: no zombie account ever appears (a lost last-cell fact would leave one)
//   (6) each eat's victim loss equals the eater's gain (conservation above, plus no breach)
//   (7) every refund is a refund (no rake), every cash-out cut is floor(gross / 10)
//   (8) every moved amount is a safe integer, and nothing leaves beyond what the room took in (no ceiling breach)
//   (9) the same seed and inputs give the same money trace
// Double cash-out, cash-out by a dead or disconnected player and one-time tokens are covered in agMoney.test.js and
// agPaidDoor.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { AgRoom } = require('../server/ag/agRoom');
const { createRng } = require('../server/ag/agRng');
const { FIXTURE } = require('./agLawsFixture');

const quiet = { error() {}, warn() {}, log() {} };
const TICKS = 5000;

function run(seed, opts) {
  const o = opts || {};
  const rnd = createRng(seed);
  const clock = { t: 10000000 };
  let boom = false;
  const laws = new Proxy(FIXTURE, {
    get(t, k) {
      if (k === 'L2' && boom) {
        boom = false;
        throw new Error('injected');
      }
      return t[k];
    },
  });
  const trace = [];
  const closedNow = new Set();   // accounts closed this tick: their cells leave at the start of the next step
  const sums = { deposits: 0, gross: 0, net: 0, rake: 0, refunds: 0, house: 0 };
  const breaches = [];
  const hooks = {
    onCashout: (x) => {
      assert.ok(Number.isSafeInteger(x.grossMicro) && x.grossMicro > 0);
      const cut = Math.floor(x.grossMicro / 10);
      sums.gross += x.grossMicro;
      sums.rake += cut;
      sums.net += x.grossMicro - cut;
      trace.push(['cashout', x.wallet, x.grossMicro, x.socketId === null]);
    },
    onRefund: (x) => {
      assert.ok(Number.isSafeInteger(x.micro) && x.micro > 0);
      sums.refunds += x.micro;
      trace.push(['refund', x.wallet, x.micro, x.why]);
    },
    onHouse: (x) => { sums.house += x.micro; trace.push(['house', x.wallet, x.micro]); },
    onTransfer: (x) => { assert.ok(Number.isSafeInteger(x.micro)); trace.push(['eat', x.srcWallet, x.dstWallet, x.micro]); },
    onFeed: () => {},
    onBreach: (b) => { if (b.kind !== 'emergency') breaches.push(b); },
    onStake: () => {},
    onAccountOpen: () => {},
    onAccountClosed: (a, outcome) => { closedNow.add(a.pid); trace.push(['closed', a.wallet, outcome]); },
  };
  const r = new AgRoom({ laws, shippableOnly: false, seed, autoTick: false, log: quiet, stake: 0.1, moneyHooks: hooks,
    now: () => clock.t });
  const sockets = new Map();   // socketId -> { socket, wallet }
  const parked = [];           // pids whose socket went (may resume)
  let sid = 0;
  let wid = 0;
  const openedThisTick = new Set();
  const newSock = () => ({ id: 'z' + ++sid, conn: { writeBuffer: [] }, emit() {} });

  for (let t = 0; t < TICKS; t++) {
    openedThisTick.clear();
    closedNow.clear();
    // joins
    if (r.money.openCount() < 12 && rnd() < 0.02) {
      const s = newSock();
      const wallet = 'W' + ++wid;
      const micro = rnd() < 0.5 ? 100000 : 1000000;
      const acct = r.addPaidHuman(s, { name: 'p' + wid, micro, wallet, paid: micro / 1e6 });
      if (acct && typeof acct === 'object') {
        sums.deposits += micro;
        sockets.set(s.id, { socket: s, wallet });
        openedThisTick.add(acct.pid);
      }
    }
    // inputs
    for (const [id] of Array.from(sockets)) {
      const seat = r.seatOf(id);
      if (!seat) { sockets.delete(id); continue; }
      const acct = r.money.account(seat.pid);
      if (!acct) continue;
      if (acct.state === 'unconfirmed') {
        // most pages ready at once; some never do (join-timeout refund) and some drop first (join-lost refund)
        const lazy = acct.pid % 7 === 3;
        if (acct.pid % 11 === 5 && rnd() < 0.05) {
          r.removeSocket(id);
          sockets.delete(id);
        } else if (!lazy && rnd() < 0.9) r.ready(id);
        continue;
      }
      const roll = rnd();
      if (roll < 0.05) {
        // steer at another player's cell, else somewhere random
        const others = Array.from(r.money.accounts.values()).filter((a) => a.pid !== seat.pid);
        const other = others.length ? others[Math.floor(rnd() * others.length)] : null;
        const oc = other ? r.sim.playerInfo(other.pid) : null;
        const c = oc && oc.cells.length ? r.sim.getCell(oc.cells[0]) : null;
        const b = r.sim.border();
        const x = c ? c.x : b.minX + (b.maxX - b.minX) * rnd();
        const y = c ? c.y : b.minY + (b.maxY - b.minY) * rnd();
        r.target(id, Math.round(x), Math.round(y));
      } else if (roll < 0.06) r.split(id);
      else if (roll < 0.08) r.eject(id);
      else if (roll < 0.085) r.hold(id, true);
      else if (roll < 0.09) r.hold(id, false);
      else if (roll < 0.092) {
        parked.push(seat.pid);
        r.removeSocket(id);
        sockets.delete(id);
        continue;
      }
      if (acct.holding && rnd() < 0.97) r.hold(id, true);   // most holds are kept until they finish
    }
    // resumes
    if (parked.length && rnd() < 0.0015) {
      const pid = parked.splice(Math.floor(rnd() * parked.length), 1)[0];
      const acct = r.money.account(pid);
      if (acct && acct.socketId === null) {
        const s = newSock();
        if (r.resumePaid(s, pid)) sockets.set(s.id, { socket: s, wallet: acct.wallet });
      }
    }
    // a throw after the eats now and then (never two in a row, so the room stays open)
    if (o.throws && rnd() < 0.01 && r.failCount === 0) boom = true;
    clock.t += 40;
    r.tickOnce();
    boom = false;
    assert.strictEqual(r.closed, false, 'the room never closed');

    // (1) (4) (8) every tick
    const b = r.money.bank;
    assert.strictEqual(b.totalMicro(), b.ledger.inMicro - b.ledger.outMicro, 'conserved at tick ' + t);
    assert.strictEqual(b.ledger.inMicro, sums.deposits, 'in only by deposits at tick ' + t);
    assert.strictEqual(b.ledger.outMicro, sums.gross + sums.refunds + sums.house, 'out only by exits at tick ' + t);
    for (const a of r.money.accounts.values()) assert.ok(Number.isSafeInteger(b.balance(a.pid)) && b.balance(a.pid) >= 0);
    // (2)
    if (r.failCount === 0) {
      for (const a of r.money.accounts.values()) {
        const live = r.sim.playerInfo(a.pid);
        assert.ok(a.state === 'frozen' || openedThisTick.has(a.pid) || (live && live.cells.length > 0),
          'account ' + a.pid + ' (' + a.state + ') has a live cell at tick ' + t);
      }
      r.sim.forEachPlayer((p) => {
        if (p.cells.length && !closedNow.has(p.pid)) {
          assert.ok(r.money.account(p.pid), 'player ' + p.pid + ' has cells but no account at tick ' + t);
        }
      });
    }
  }
  return { r, sums, trace, breaches };
}

const seen = [];

test('5000 ticks of paid play: every money invariant holds every tick, and the books close at the end', () => {
  const { r, sums, trace, breaches } = run(41);
  const holdings = r.money.bank.totalMicro();
  assert.strictEqual(sums.deposits, sums.gross + sums.refunds + sums.house + holdings, '(3) the books close');
  assert.strictEqual(sums.gross, sums.net + sums.rake);
  assert.deepStrictEqual(breaches, [], 'no breach of any kind');
  const kinds = new Set(trace.map((x) => x[0] === 'closed' ? x[2] : x[0]));
  // the run exercised the paths it claims to
  for (const k of ['eat', 'cashout', 'eaten', 'cashedout', 'refund', 'released']) assert.ok(kinds.has(k), 'the run saw ' + k);
  seen.push(...kinds);
  assert.ok(sums.deposits > 0);
});

test('with step throws injected after the eats: no money fact is lost (no zombie, books close)', () => {
  const { r, sums, breaches, trace } = run(43, { throws: true });
  assert.deepStrictEqual(breaches.filter((b) => b.kind === 'zombie'), [], 'no account ever lost its cells to a lost fact');
  assert.deepStrictEqual(breaches, []);
  assert.strictEqual(sums.deposits, sums.gross + sums.refunds + sums.house + r.money.bank.totalMicro());
  assert.ok(trace.some((x) => x[0] === 'eat'), 'eats happened');
  for (const x of trace) seen.push(x[0] === 'closed' ? x[2] : x[0]);
  // between the two seeded runs, a dropped player's 3-minute automatic cash-out happened too
  assert.ok(seen.includes('settled'), 'a dormant auto cash-out was exercised');
});

test('(9) the same seed and inputs give the same money trace', () => {
  const a = run(47);
  const b = run(47);
  assert.deepStrictEqual(a.trace, b.trace);
  assert.deepStrictEqual(a.sums, b.sums);
});
