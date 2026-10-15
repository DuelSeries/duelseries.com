'use strict';
// The money controller of ONE paid sl room (PAID-SL-DESIGN.md 3.3, 4, 5, 6, 7 and 8; Owen's answers in
// slither-reference/OWNER-ANSWERS.md, last two sections). The sim stays money-free: it logs facts (deaths with their
// drops, eats), and this controller applies them to the room's SlBank in the design's order, once per step. It never
// touches the chain, the database or a socket: money leaves only through the hooks (the server wires them to the
// slither payout, the owed lane and the owner alert), and the room hears of every closed account through onClosed.
// No server/sl file requires this one: the room gets it as opts.money (critic C-2, slNoMoney).
//
// Accounts: one per live paid snake, keyed by its snake id; the account is the snake's whole worth, in integer
// micro-USDC. The controller's own record { snakeId, jid, wallet, name, deposit, paid, stakeSig, openedAt } is
// frozen and mirrors the bank's open accounts at every return. ONE exit, _close, deletes a record; before it the
// money has already left the bank (split, withdraw), and after it the journal and the hooks hear of it:
//   died       a death of any cause (border included, C_PAID_BORDER_DROPS): the whole account becomes pellets
//   cashedout  a finished hold: 90/10, the order dispatched through onCashout before cashOut returns (critic C-6)
//   refunded   shutdown or crash (rows for the caller to write), emergency or orphan (owed rows through onOwed)
//   aborted    the seat failed after the account opened: the door refunds the token and writes the journal close
//
// The step (design 5), run by the room around sim.step():
//   applyFacts(log, eats)  in its finally: M1 the deaths of cause 'kill' (the glides that ran out die before Phase A,
//                          so their pellets can be eaten this step), M2 the eats in sim order, M3 the other deaths in
//                          log order (a snake that ate cash and died drops it). Each fact in its own try, each at most
//                          once (a replayed log moves nothing); a failed fact changes no balance and alerts.
//   cashOut(id)            M4, normal path only, after the facts: a death this step already closed the account
//   endStep()              M5: collusion buckets, the changed-worth set, every open account checked for a live snake
//                          (I4: an orphan is refunded 100% through the owed lane at once), the checker (slCheck: cheap
//                          every step, full every checkEvery steps), alerts, taint on I1, I10 and I13
//
// Hooks (all required, checked at construction; design 8, 7.4). There is no onRefund: only the door refunds a token.
//   onCashout(order)          { cashoutId, socketId, wallet, name, grossMicro, stake, label }: slPayout.payCashout
//   onOwed(row)               { key 'agowed:<jid>', wallet, name, micro, reason }: db.recordOwedOnce, then the drainer
//   onFloor(sweep)            { sweepId, micro, srcWallet, srcName, label, pid }: slPayout.sweepFloor (slither_floor)
//   onHouse(incident)         { id, micro, wallet, name, label, why }: slPayout.houseIncident (slither_breach)
//   onBreach(info)            the owner alert (agAlert: one per room per kind per 10 min); never a wallet in it
//   onTransfer(bucket)        { srcWallet, dstWallet, micro, label, lobbyType }: collusion.record, one per pair per
//                             COLLUSION_BUCKET_MS
//   onAccountOpen(acct)       the directory seats the wallet (walletSeat); throws when the wallet is already seated,
//                             BEFORE the journal is written
//   onAccountClosed(acct, outcome, extra)   the directory forgets the seat
//   journal                   { open(acct, room), close(acct, outcome, extra, room) }: the shared agJournal

const crypto = require('crypto');
const { SlBank, isMicro } = require('./slBank');
const { planSplit } = require('./slSplit');
const { checkRoom, checkLaws } = require('./slCheck');
const { CHECK_EVERY_STEPS } = require('./slPaidConst');
const { HOUSE_CUT_DIV } = require('../paperPayout');

const REQUIRED_HOOKS = Object.freeze(['onCashout', 'onOwed', 'onFloor', 'onHouse', 'onBreach', 'onTransfer',
  'onAccountOpen', 'onAccountClosed', 'journal']);

// One collusion record per (source wallet, eater wallet) pair per this long (design 5: "one collusion.record per pair
// per 60 s bucket"; agar's COLLUSION_FLUSH_MS, server/ag/agMoney.js).
const COLLUSION_BUCKET_MS = 60000;

// Violations that taint the room: no new seat opens in it (design 8). It is still settled normally.
const TAINT_KINDS = Object.freeze(['I1', 'I10', 'I13']);

const OWED_PREFIX = 'agowed:'; // db.recordOwedOnce takes this key form as it is (design 7.2)

// A hook that may answer with a promise: a throw or a rejection is logged, never rethrown into a money path.
function safeAsync(fn, onFail) {
  try {
    const p = fn();
    if (p && typeof p.then === 'function') p.then(null, onFail);
  } catch (e) {
    onFail(e);
  }
}

class SlMoney {
  // stake: the rung in dollars (0.5 or 1); label: the room's lobbyType; checkEvery: the full checker every this many
  // steps (1 in tests, the soak and the proof); walletSeat: the directory's Map wallet -> { room, snakeId } for I9.
  constructor({ stake, label, hooks, now = Date.now, uuid = () => crypto.randomUUID(), log = console,
    checkEvery = CHECK_EVERY_STEPS, walletSeat = null, laws = null } = {}) {
    if (!(Number(stake) > 0)) throw new Error('SlMoney: a paid room needs a stake above 0');
    const h = hooks || {};
    for (const name of REQUIRED_HOOKS) {
      if (name === 'journal') {
        const j = h.journal;
        if (!j || typeof j.open !== 'function' || typeof j.close !== 'function') {
          throw new Error('SlMoney: hook journal must have open and close');
        }
      } else if (typeof h[name] !== 'function') {
        throw new Error('SlMoney: hook ' + name + ' must be a function');
      }
    }
    if (!Number.isInteger(checkEvery) || checkEvery < 1) throw new Error('SlMoney: checkEvery must be an integer >= 1');
    this.stake = Number(stake);
    this.label = String(label || '');
    this.hooks = h;
    this.now = now;
    this.uuid = uuid;
    this.log = log || console;
    this.checkEvery = checkEvery;
    this.walletSeat = walletSeat instanceof Map ? walletSeat : null;
    this.laws = laws;
    this.room = null; // attach(room): { sim, humans, laws }
    this.onClosed = null; // attach(room, { onClosed }): the room's seat messages
    this.accounts = new Map(); // snake id -> record (open only, frozen)
    this.buckets = new Map(); // srcWallet|dstWallet -> { src, dst, micro, openedAt }
    this.changed = new Map(); // snake id -> own delta in micro since the room last took the set
    this.applied = new WeakSet(); // death records already applied (a replayed log moves nothing)
    this.lastTick = null;
    this.steps = 0;
    this.stopped = false; // settled (shutdown, crash, emergency): nothing opens again
    this.tainted = false; // I1, I10 or I13 seen: no new seat (design 8)
    this.closedCount = Object.create(null); // outcome -> n (owner view, tests)
    this.lastViolations = [];
    this.bank = new SlBank({
      onBreach: (info) => this._alert('bank', info),
      onTransfer: (t) => this._bucket(t),
    });
  }

  // The room this controller keeps (T3: money.attach(this) in the SlRoom constructor). opts.onClosed(acct, outcome,
  // extra): the room tells the seat (lost, cashed, closed); never for 'aborted', whose seat seatPaid undoes itself.
  attach(room, opts) {
    this.room = room || null;
    const o = opts || {};
    if (typeof o.onClosed === 'function') this.onClosed = o.onClosed;
    return this;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Reads.

  // By snake id, or by jid (the door's step 12 asks either way).
  account(idOrJid) {
    if (typeof idOrJid === 'string') {
      for (const a of this.accounts.values()) if (a.jid === idOrJid) return a;
      return null;
    }
    return this.accounts.get(idOrJid) || null;
  }

  openCount() {
    return this.accounts.size;
  }

  // A paid snake's worth in micro (the {t:'w'} message), or null when it has no account.
  worthOf(snakeId) {
    return this.accounts.has(snakeId) ? this.bank.balance(snakeId) : null;
  }

  // Dollars for the solvency sum: every account plus the floor (design 7.5; agar's units, agMoney.js:122-128).
  liveStakeTotal() {
    return this.bank.totalMicro() / 1e6;
  }

  // Dollars on the floor (drain: maintenance:check refuses with floor gold).
  get floorWorth() {
    return this.bank.floorMicro() / 1e6;
  }

  // What ops.drainStatus reads: every open account with its worth in dollars, alive while open.
  get snakes() {
    const m = new Map();
    for (const a of this.accounts.values()) {
      m.set('sl' + a.snakeId, { alive: true, isBot: false, worth: this.bank.balance(a.snakeId) / 1e6 });
    }
    return m;
  }

  // The worth changes since the last call, once per open snake: [{ id, v (micro now), d (own delta) }]. The room
  // sends {t:'w'} from it once per wake (design 9).
  takeChanged() {
    const out = [];
    for (const [id, d] of this.changed) if (this.accounts.has(id)) out.push({ id, v: this.bank.balance(id), d });
    this.changed.clear();
    return out;
  }

  totals() {
    return Object.assign(this.bank.totals(), { open: this.accounts.size, closed: Object.assign({}, this.closedCount),
      tainted: this.tainted, stopped: this.stopped });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Opening (design 3.3 step B: the account opens LAST, after the seat is built).

  // entry: { jid, micro, wallet, name, paid, stakeSig } from the door (micro from the consumed token only). Checks
  // first, then the deposit, then onAccountOpen (walletSeat, which throws when the wallet is seated) BEFORE the
  // journal's open record (the door wrote one for the same jid at its step 8, so a false here leaves that one). A
  // throw rolls the deposit back and closes the record as aborted (the door refunds the token), then rethrows.
  open(snakeId, entry) {
    if (this.stopped) throw new Error('SlMoney.open: the room is settled');
    if (this.tainted) throw new Error('SlMoney.open: the room is tainted');
    if (!Number.isSafeInteger(snakeId) || snakeId <= 0) throw new Error('SlMoney.open: bad snake id ' + snakeId);
    const e = entry || {};
    if (!isMicro(e.micro) || e.micro < 1) throw new Error('SlMoney.open: micro must be a whole number above 0');
    if (typeof e.wallet !== 'string' || !e.wallet) throw new Error('SlMoney.open: a paid seat needs a wallet');
    if (typeof e.jid !== 'string' || !e.jid) throw new Error('SlMoney.open: a paid seat needs a jid');
    if (this.accounts.has(snakeId) || this.bank.isOpen(snakeId)) {
      throw new Error('SlMoney.open: account ' + snakeId + ' is already open');
    }
    if (this.account(e.jid)) throw new Error('SlMoney.open: jid ' + e.jid + ' is already open');
    const name = typeof e.name === 'string' ? e.name : '';
    const acct = Object.freeze({
      snakeId,
      jid: e.jid,
      wallet: e.wallet,
      name,
      deposit: e.micro,
      paid: Number.isFinite(e.paid) ? e.paid : undefined,
      stakeSig: typeof e.stakeSig === 'string' && e.stakeSig ? e.stakeSig : null,
      openedAt: this.now(),
    });
    this.bank.deposit(snakeId, e.micro, { wallet: acct.wallet, name, jid: acct.jid });
    this.accounts.set(snakeId, acct);
    let seated = false;
    try {
      this.hooks.onAccountOpen(acct);
      seated = true;
      if (this.hooks.journal.open(acct, this.label) === false) {
        this.log.error('[SLP] JOURNAL open of ' + acct.jid + ' not rewritten (' + this.label + '); the door\'s record stands');
      }
    } catch (err) {
      this._rollback(acct, seated);
      throw err;
    }
    return acct;
  }

  // The seat failed after open (design 3.3, between B and C): the deposit leaves as a refund in the bank's books (the
  // door refunds the token, once, and writes the jid's one journal close), the directory forgets the seat. false when
  // there is no such account. A withdraw refused at the ceiling leaves the account open (the door then refunds
  // nothing; I4 refunds it through the owed lane once its snake is gone) and throws.
  abort(snakeId) {
    const acct = this.accounts.get(snakeId);
    if (!acct) return false;
    this.bank.withdraw(snakeId, 'refund');
    this._close(acct, 'aborted', { why: 'aborted' }, true);
    return true;
  }

  _rollback(acct, seated) {
    try {
      this.bank.withdraw(acct.snakeId, 'refund');
    } catch (e) {
      // the account stays open, and the door sees it and refunds nothing (see abort)
      this.log.error('[SLP] OPEN CRITICAL rollback of ' + acct.jid + ' refused, left open: ' + (e && e.message));
      return;
    }
    this._close(acct, 'aborted', { why: 'open-failed' }, seated);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The step's facts (design 5).

  // log: sim.lastLog() (deaths); eats: sim.food.tick.eats. Returns { lost: Map snake id -> micro its death put on
  // the floor, credited: micro, breaches: n }.
  applyFacts(log, eats) {
    const out = { lost: new Map(), credited: 0, breaches: 0 };
    if (!log || !Array.isArray(log.deaths)) {
      this.log.error('[SLP] FACTS no step log (' + this.label + ')');
      this._alert('facts', { why: 'no-log' });
      return out;
    }
    if (log.tick !== this.lastTick) {
      this.bank.beginStep();
      this.lastTick = log.tick;
    }
    // M1: the kills (C_DISCONNECT glides that ran out) died before Phase A, so their pellets can be eaten this step
    for (const d of log.deaths) if (d && d.cause === 'kill') this._fact('death', () => this._death(d, out));
    // M2: every eat in sim order
    if (Array.isArray(eats)) for (const e of eats) this._fact('eat', () => this._eat(e, out));
    // M3: the deaths of Phase C, in log order
    for (const d of log.deaths) if (d && d.cause !== 'kill') this._fact('death', () => this._death(d, out));
    return out;
  }

  _fact(what, fn) {
    try {
      fn();
    } catch (e) {
      this.log.error('[SLP] FACT ' + what + ' threw (' + this.label + '), balances untouched: ' + (e && e.message));
      this._alert('fact', { why: what });
    }
  }

  // A death: the whole account is split over the drops' foods (slSplit: remainder one micro each to the first),
  // all or nothing, then closed. No food at all: the micro goes to the house as a breach incident. A death with
  // drops and no account is a breach too (gold with no cash, design 8).
  _death(d, out) {
    if (this.applied.has(d)) return;
    this.applied.add(d);
    const acct = this.accounts.get(d.id);
    if (!acct) {
      if (Array.isArray(d.drops) && d.drops.some((q) => q && q.food)) {
        this.log.error('[SLP] DEATH of snake ' + d.id + ' dropped gold with no account (' + this.label + ')');
        this._alert('death-no-account', { snakeId: d.id });
      }
      return;
    }
    const M = this.bank.balance(d.id);
    const plan = planSplit(M, Array.isArray(d.drops) ? d.drops : []);
    const r = this.bank.split(d.id, plan.foods, plan.shares);
    out.lost.set(d.id, M);
    this._close(acct, 'died', { why: d.cause, lostMicro: M, killer: d.killer || 0, pellets: r.pellets,
      unplaced: r.unplaced });
    if (r.unplaced > 0) {
      this.log.error('[SLP] DEATH of snake ' + d.id + ' placed no pellet, ' + r.unplaced + ' micro to the house (' +
        this.label + ')');
      this._house(acct.wallet, acct.name, r.unplaced, 'unplaced');
      this._alert('unplaced', { micro: r.unplaced, snakeId: d.id });
    }
  }

  // An eat: a pellet's micro moves to the eater's account, once. A pellet eaten by a snake with no account (no bots
  // in a paid room, so only a bug) goes to the house as a breach incident, once, with an alert.
  _eat(e, out) {
    if (!e || !e.food) return;
    const m = this.bank.credit(e.food, e.eater);
    if (m > 0) {
      this.changed.set(e.eater, (this.changed.get(e.eater) || 0) + m);
      out.credited += m;
      return;
    }
    if (m !== -1) return; // natural food, a boost crumb, a replayed eat
    const pel = this.bank.pellet(e.food);
    const micro = this.bank.toSuspense(e.food);
    if (micro > 0) {
      out.breaches++;
      this.log.error('[SLP] EAT of a pellet by snake ' + e.eater + ' with no account, ' + micro + ' micro to the house (' +
        this.label + ')');
      this._house(pel.srcWallet, pel.srcName, micro, 'eat-no-account');
      this._alert('eat-no-account', { micro, snakeId: e.eater });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Exits.

  // A finished hold (design 6): the bank withdraw FIRST (a refused one throws with nothing changed, and the snake
  // keeps playing), then the 90/10 integers, the journal close, one [SLP] CASHOUT-ORDER line, and the order
  // dispatched through onCashout before this returns, so nothing the room does after it can strand a withdrawn
  // account unpaid (critic C-6). null when the snake has no account (a death this step won).
  // -> { cid, gross, cut, net, order }
  cashOut(snakeId, socketId) {
    const acct = this.accounts.get(snakeId);
    if (!acct) return null;
    const cashoutId = this.uuid(); // before the withdraw: nothing between it and the dispatch can throw
    let w;
    try {
      w = this.bank.withdraw(snakeId, 'cash');
    } catch (e) {
      this.log.error('[SLP] CASHOUT CRITICAL refused for snake ' + snakeId + ' (' + this.label + '), it keeps playing: ' +
        (e && e.message));
      this._alert('cashout-refused', { snakeId });
      throw e;
    }
    const gross = w.micro;
    const cut = Math.floor(gross / HOUSE_CUT_DIV);
    const net = gross - cut;
    const order = { cashoutId, socketId: typeof socketId === 'string' ? socketId : null,
      wallet: w.acct.wallet, name: w.acct.name || '', grossMicro: gross, stake: this.stake, label: this.label };
    try {
      this._close(acct, 'cashedout', { why: 'cashout', grossMicro: gross, cutMicro: cut, netMicro: net,
        cashoutId: order.cashoutId });
    } finally {
      this.log.log('[SLP] CASHOUT-ORDER ' + order.cashoutId + ' ' + gross + ' ' + this.label);
      safeAsync(() => this.hooks.onCashout(order), (e) => {
        this.log.error('[SLP] CASHOUT CRITICAL order ' + order.cashoutId + ' failed, owed ' + gross + ' micro gross (' +
          this.label + '): ' + (e && e.message));
        this._alert('cashout-order', { micro: gross });
      });
    }
    return { cid: order.cashoutId, gross, cut, net, order };
  }

  // The owed lane (design 7.4): emergency and orphan refunds of 100% of the CURRENT balance, no rake. The withdraw
  // first, then the journal close 'refunded' carrying the row's key, then onOwed: so a failed write or a death of
  // the process after the close is replayed at the next boot, once per key (agJournal, db.recordOwedOnce).
  _refundOwed(acct, why) {
    const w = this.bank.withdraw(acct.snakeId, 'refund');
    const micro = w ? w.micro : 0;
    const key = OWED_PREFIX + acct.jid;
    const reason = 'refund slither ' + why + ' ' + this.label + ' ' + key;
    const row = { key, wallet: acct.wallet, name: acct.name, micro, reason };
    try {
      this._close(acct, 'refunded', { why, key, refundedMicro: micro, reason });
    } finally {
      if (micro > 0) {
        safeAsync(() => this.hooks.onOwed(row), (e) => {
          this.log.error('[SLP] OWED CRITICAL row ' + key + ' failed (' + micro + ' micro, ' + this.label + '); the ' +
            'journal close carries it to the next boot: ' + (e && e.message));
          this._alert('owed', { micro });
        });
      }
    }
    return row;
  }

  // An emergency close (design 7.4: one failing paid wake): every account through the owed lane, then the floor to
  // the house through onFloor, one sweep per source wallet. An account whose refund throws stays open (the
  // directory keeps the room on its settling list). -> { accounts, micro, rows, floor }
  emergencySettle(why = 'emergency') {
    const w = String(why || 'emergency');
    this.stopped = true;
    const rows = [];
    let micro = 0;
    for (const acct of Array.from(this.accounts.values())) {
      try {
        const row = this._refundOwed(acct, w);
        rows.push(row);
        micro += row.micro;
      } catch (e) {
        this.log.error('[SLP] EMERGENCY settle of snake ' + acct.snakeId + ' failed, left open (' + this.label + '): ' +
          (e && e.message));
      }
    }
    let floor = null;
    try {
      floor = this._sweep(w);
    } catch (e) {
      this.log.error('[SLP] EMERGENCY floor sweep failed, left on the floor (' + this.label + '): ' + (e && e.message));
    }
    this._phase('collusion', () => this._flushBuckets(true));
    this._alert('emergency', { accounts: rows.length, micro });
    return { accounts: rows.length, micro, rows, floor };
  }

  // A planned restart ('shutdown') or a crash ('crash'), design 7.2: every account withdrawn, closed 'refunded' in
  // the journal with its owed row (100% of the current balance, no rake), and the rows handed back for the caller to
  // write (installAgShutdown; the crash path leaves them to the journal replay). The floor is booked to the house as
  // abandoned and logged: no on-chain move and no database write in the exit window (the money stays in escrow).
  shutdownSettle(why = 'shutdown') {
    const kind = why === 'crash' ? 'crash' : 'shutdown';
    this.stopped = true;
    const rows = [];
    for (const acct of Array.from(this.accounts.values())) {
      try {
        const w = this.bank.withdraw(acct.snakeId, 'refund');
        const micro = w ? w.micro : 0;
        const key = OWED_PREFIX + acct.jid;
        const reason = 'refund slither ' + kind + ' ' + this.label + ' ' + key;
        this._close(acct, 'refunded', { why: kind, key, refundedMicro: micro, reason });
        if (micro > 0) rows.push({ key, wallet: acct.wallet, name: acct.name, micro, reason });
      } catch (e) {
        this.log.error('[SLP] SHUTDOWN settle of snake ' + acct.snakeId + ' failed, left open (' + this.label + '): ' +
          (e && e.message));
      }
    }
    try {
      const f = this.bank.takeFloor('abandoned');
      if (f.micro > 0) this.log.error('[SLP] SHUTDOWN-FLOOR ' + f.micro + ' ' + this.label);
    } catch (e) {
      this.log.error('[SLP] SHUTDOWN floor not booked (' + this.label + '): ' + (e && e.message));
    }
    this._phase('collusion', () => this._flushBuckets(true));
    return rows;
  }

  // The idle retire (design 7.5): the floor to the house through onFloor, one sweep per source wallet with its exact
  // micro and a unique sweepId. Refused (null) while any account is open: that gold can still be eaten.
  // -> { micro, count, sweeps }
  sweepFloor(why = 'idle') {
    if (this.accounts.size > 0) return null;
    return this._sweep(String(why || 'idle'));
  }

  _sweep(why) {
    const f = this.bank.takeFloor('swept');
    const sweeps = [];
    for (const s of f.bySource) {
      const sweep = { sweepId: this.uuid(), micro: s.micro, srcWallet: s.srcWallet, srcName: s.srcName,
        label: this.label, pid: why };
      sweeps.push(sweep);
      safeAsync(() => this.hooks.onFloor(sweep), (e) => {
        this.log.error('[SLP] SWEEP CRITICAL ' + sweep.sweepId + ' of ' + s.micro + ' micro failed (' + this.label + '): ' +
          (e && e.message));
        this._alert('sweep', { micro: s.micro });
      });
    }
    return { micro: f.micro, count: f.count, sweeps };
  }

  // The ONE exit: the bank account must already be gone. The record goes, the journal closes the jid (not for
  // 'aborted': the door's refund writes that close), and the directory (tell) and the room (not for 'aborted') hear
  // of it.
  _close(acct, outcome, extra, tell = true) {
    if (this.accounts.get(acct.snakeId) !== acct) return false;
    if (this.bank.isOpen(acct.snakeId)) throw new Error('SlMoney: account ' + acct.snakeId + ' closed with its bank account open');
    this.accounts.delete(acct.snakeId);
    this.changed.delete(acct.snakeId);
    this.closedCount[outcome] = (this.closedCount[outcome] || 0) + 1;
    const x = extra || {};
    if (outcome !== 'aborted') {
      try {
        if (this.hooks.journal.close(acct, outcome, x, this.label) === false) {
          this.log.error('[SLP] JOURNAL CRITICAL close of ' + acct.jid + ' (' + outcome + ') not written (' + this.label + ')');
        }
      } catch (e) {
        this.log.error('[SLP] JOURNAL CRITICAL close of ' + acct.jid + ' threw (' + this.label + '): ' + (e && e.message));
      }
    }
    if (tell) {
      try {
        this.hooks.onAccountClosed(acct, outcome, x);
      } catch (e) {
        this.log.error('[SLP] account closed hook (' + this.label + '): ' + (e && e.message));
      }
    }
    if (outcome !== 'aborted' && typeof this.onClosed === 'function') {
      try {
        this.onClosed(acct, outcome, x);
      } catch (e) {
        this.log.error('[SLP] room close hook (' + this.label + '): ' + (e && e.message));
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The end of a step (M5).

  // -> { orphans: [owed rows], violations }
  endStep() {
    const out = { orphans: [], violations: [] };
    this.steps++;
    this._phase('collusion', () => this._flushBuckets(false));
    const sim = this.room && this.room.sim;
    if (!sim) return out;
    // I4, every step (at most 22 lookups): an account whose snake is gone is refunded 100% at once
    this._phase('orphans', () => {
      for (const acct of Array.from(this.accounts.values())) {
        if (sim.snake(acct.snakeId)) continue;
        this.log.error('[SLP] ORPHAN account of snake ' + acct.snakeId + ' has no live snake, refunded (' + this.label + ')');
        this._alert('I4', { snakeId: acct.snakeId });
        try {
          out.orphans.push(this._refundOwed(acct, 'orphan'));
        } catch (e) {
          this.log.error('[SLP] ORPHAN refund of snake ' + acct.snakeId + ' failed, left open: ' + (e && e.message));
        }
      }
    });
    this._phase('check', () => {
      const full = this.steps % this.checkEvery === 0;
      const room = this.room;
      const K = checkLaws(this.laws || room.laws || sim.laws);
      // The room itself when it holds this controller as room.money (I9 compares the directory's seats by room);
      // else a view of it, checked without I9.
      const own = room.money === this;
      const target = own ? room : { bank: this.bank, sim, humans: room.humans };
      out.violations = checkRoom(target, { full, K, walletSeat: full && own ? this.walletSeat : null });
      this.lastViolations = out.violations;
      this._onViolations(out.violations);
    });
    return out;
  }

  // One alert per kind per step that has it (agAlert dedupes per room and kind); I1, I10 and I13 taint the room.
  _onViolations(list) {
    if (!list.length) return;
    const kinds = new Map();
    for (const v of list) kinds.set(v.kind, (kinds.get(v.kind) || 0) + 1);
    for (const [kind, n] of kinds) {
      if (TAINT_KINDS.includes(kind) && !this.tainted) {
        this.tainted = true;
        this.log.error('[SLP] TAINTED ' + this.label + ' by ' + kind + ': no new seat opens here');
      }
      this._alert(kind, { accounts: n });
    }
  }

  _phase(name, fn) {
    try {
      fn();
    } catch (e) {
      this.log.error('[SLP] money ' + name + ' threw (' + this.label + '): ' + (e && e.message));
      this._alert('phase', { phase: name });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Collusion signals, house incidents, alerts.

  // Every credit lands in the bucket of its (source wallet, eater wallet) pair; one record per bucket.
  _bucket(t) {
    if (!t || !(t.micro > 0) || !t.srcWallet || !t.dstWallet) return;
    const key = t.srcWallet + '|' + t.dstWallet;
    let b = this.buckets.get(key);
    if (!b) {
      b = { src: t.srcWallet, dst: t.dstWallet, micro: 0, openedAt: this.now() };
      this.buckets.set(key, b);
    }
    b.micro += t.micro;
  }

  // all: every bucket (settles); else the buckets at least COLLUSION_BUCKET_MS old.
  _flushBuckets(all) {
    if (!this.buckets.size) return;
    const now = this.now();
    for (const [key, b] of Array.from(this.buckets)) {
      if (!all && now - b.openedAt < COLLUSION_BUCKET_MS) continue;
      this.buckets.delete(key);
      try {
        this.hooks.onTransfer({ srcWallet: b.src, dstWallet: b.dst, micro: b.micro, label: this.label, lobbyType: this.label });
      } catch (e) {
        this.log.error('[SLP] collusion record (' + this.label + '): ' + (e && e.message));
      }
    }
  }

  // Money that went to the house because something went wrong (slither_breach, with the wallet in the database row
  // only, for Owen to pay back by hand).
  _house(wallet, name, micro, why) {
    const incident = { id: this.uuid(), micro, wallet: wallet || null, name: name || '', label: this.label, why };
    safeAsync(() => this.hooks.onHouse(incident), (e) => {
      this.log.error('[SLP] HOUSE CRITICAL incident ' + incident.id + ' of ' + micro + ' micro (' + why + ') failed (' +
        this.label + '): ' + (e && e.message));
    });
  }

  // The owner alert: kind, room and amounts only, never a wallet.
  _alert(kind, info) {
    try {
      const x = Object.assign({}, info, { kind, lobbyType: this.label });
      delete x.wallet;
      delete x.srcWallet;
      delete x.dstWallet;
      this.hooks.onBreach(x);
    } catch (e) {
      this.log.error('[SLP] breach hook (' + this.label + '): ' + (e && e.message));
    }
  }
}

function createSlMoney(opts) {
  return new SlMoney(opts);
}

module.exports = { createSlMoney, SlMoney, REQUIRED_HOOKS, COLLUSION_BUCKET_MS, TAINT_KINDS };
