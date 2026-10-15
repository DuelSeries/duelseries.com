'use strict';
// Test helpers for the paid sl directory, door and routing (task T4). TEST ONLY: never imported by shipped code.
//
//   paidRig(opts)   the free rig (slSockFakes: the FIXTURE table, the free SlArenas behind the real slSockets, a fake
//                   clock and wall) plus the paid directory (SlPaidArenas: the real SlRoom and slMoney on spy hooks,
//                   checkEvery 1, no auto tick), a REAL entry store (makeEntryStore: one-time tokens, onlyGame scopes,
//                   restore), a fake stake ledger, a fake slither payout, a recording journal, and the paid door,
//                   attached with sockets.setPaid. Returns the rig plus { paid, door, store, ledger, payout, money
//                   (the hook spy), journal, mint(o), paidSock(token, o), join(token, o), step(k), settle() }.
//   jidLike         a lowercase uuid (slMoney refuses any other jid)

const { rig, QUIET } = require('./slSockFakes');
const { SlPaidArenas } = require('../server/slPaid/slPaidArenas');
const { createSlPaidDoor } = require('../server/slPaid/slPaidDoor');
const { makeEntryStore } = require('../server/entryStore');
const { isStake } = require('../server/stakeRules');

const jidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The server's money hooks, recorded; the shared journal, recorded (fail: its next open answers false).
function moneySpy() {
  const calls = [];
  const records = [];
  const flags = { journalOpenFails: 0, journalOpenThrows: 0 };
  const hook = (name) => (x) => {
    calls.push([name, x]);
    return undefined;
  };
  const journal = {
    open(acct, room) {
      if (flags.journalOpenThrows > 0) {
        flags.journalOpenThrows--;
        throw new Error('injected journal open');
      }
      if (flags.journalOpenFails > 0) {
        flags.journalOpenFails--;
        return false;
      }
      records.push({ t: 'open', jid: acct.jid, wallet: acct.wallet, micro: acct.deposit, stakeSig: acct.stakeSig, room });
      return true;
    },
    close(acct, outcome, extra, room) {
      records.push(Object.assign({ t: 'close', jid: acct.jid, outcome, room }, extra));
      return true;
    },
  };
  const hooks = {
    onCashout: hook('onCashout'), onOwed: hook('onOwed'), onFloor: hook('onFloor'), onHouse: hook('onHouse'),
    onBreach: hook('onBreach'), onTransfer: hook('onTransfer'), journal,
  };
  return { calls, records, flags, hooks, journal, of: (name) => calls.filter((c) => c[0] === name).map((c) => c[1]) };
}

// stakeLedger's door half: claimSeat answers `answer` (or a promise of it), refund resolves `refundAnswer`.
function fakeLedger() {
  return {
    answer: 'ok',
    refundAnswer: 'owed',
    claims: [],
    refunds: [],
    claimSeat(entry) {
      this.claims.push(entry.stakeSig);
      return typeof this.answer === 'function' ? this.answer(entry) : Promise.resolve(this.answer);
    },
    refund(sig, reason, claimKey) {
      this.refunds.push({ sig, reason, claimKey });
      return Promise.resolve(this.refundAnswer);
    },
  };
}

function fakePayout() {
  return {
    refunds: [],
    refund(x) {
      this.refunds.push(x);
      return Promise.resolve('sig-' + this.refunds.length);
    },
  };
}

function paidRig(opts) {
  const o = opts || {};
  const r = rig(o.rig);
  const P = r.laws.L7.value;
  const money = moneySpy();
  const log = o.log || QUIET;
  const paid = new SlPaidArenas(r.laws, Object.assign({ region: 'na', paid: o.paid !== false, moneyHooks: money.hooks,
    shippableOnly: false, clock: r.ft.clock, timers: r.ft.timers, now: () => r.wall.t, autoTick: false, prey: false,
    seed: 7, checkEvery: 1, log }, o.arenas || {}));
  const store = makeEntryStore({ isStake, now: () => r.wall.t });
  const consumed = [];
  const ledger = fakeLedger();
  const payout = fakePayout();
  const entries = [];
  const alerts = [];
  const tracked = [];
  const door = createSlPaidDoor(Object.assign({
    arenas: paid,
    consumeAtStake: (t, s, g) => {
      consumed.push({ token: t, stake: s, game: g });
      return store.consumeAtStake(t, s, g);
    },
    ledger: o.noLedger ? null : ledger,
    slPayout: payout,
    journal: money.journal,
    ops: { get: () => r.ops },
    recordEntry: (entry, label) => entries.push({ wallet: entry.walletAddress, worth: entry.worth, label }),
    alert: (info) => alerts.push(info),
    now: () => r.wall.t,
    log,
    track: (p) => tracked.push(p),
  }, o.door || {}));
  r.sockets.setPaid({ arenas: paid, door });
  let wallets = 0;
  function mint(m) {
    const x = Object.assign({ stake: 0.5, worth: 0.5, paid: 0.5, walletAddress: 'W' + (++wallets), onlyGame: 'slither' },
      m || {});
    return store.mint(x);
  }
  function paidSock(token, so) {
    const s = so || {};
    const auth = Object.assign({ paid: 1, stake: 0.5, entryToken: token, cv: 3 }, s.auth || {});
    return r.sock(Object.assign({}, s, { auth }));
  }
  function join(token, so) {
    r.wall.t += 1000;
    const s = paidSock(token, so);
    s.fire('sl:join', { nick: (so && so.nick) || 'p' });
    return s;
  }
  function step(k) {
    for (let i = 0; i < (k || 1); i++) {
      r.ft.advance(P);
      r.wall.t += P;
      for (const room of paid.rooms()) room.wake();
      r.ft.runImmediates();
    }
  }
  async function settle() {
    for (let i = 0; i < 6; i++) await new Promise((res) => setImmediate(res));
  }
  return Object.assign(r, { P, paid, door, store, consumed, ledger, payout, money, entries, alerts, tracked, mint,
    paidSock, join, step, settle });
}

module.exports = { paidRig, moneySpy, fakeLedger, fakePayout, jidLike };
