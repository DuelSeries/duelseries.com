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
//   onCashout(order)          { cashoutId, socketId, wallet, name, grossMicro, stake, label, jid }: slPayout.payCashout,
//                             then the journal's payout record
//   onOwed(row)               { key 'agowed:<jid>', wallet, name, micro, reason }: db.recordOwedOnce, then the drainer
//   onFloor(sweep)            { sweepId, micro, srcWallet, srcName, label, pid }: slPayout.sweepFloor (slither_floor)
//   onHouse(incident)         { id, micro, wallet, name, label, why }: slPayout.houseIncident (slither_breach)
//   onBreach(info)            the owner alert (agAlert: one per room per kind per 10 min); never a wallet in it
//   onTransfer(bucket)        { srcWallet, dstWallet, micro, label, lobbyType }: collusion.record, one per pair per
//                             COLLUSION_BUCKET_MS
//   onAccountOpen(acct)       the directory seats the wallet (walletSeat); throws when the wallet is already seated,
//                             BEFORE the journal is written
//   onAccountClosed(acct, outcome, extra)   the directory forgets the seat
//   journal                   { open(acct, room), close(acct, outcome, extra, room), floor(rec) }: the shared agJournal
//                             (floor: the shutdown's abandoned gold, booked by the next boot's replay)

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

const OWED_PREFIX = 'agowed:';
// The source a bounty bot's seed pellets name: the owner's bot bank (never a wallet; slMoney _owedRows sends it back).
const BANK_SRC = '#botbank'; // db.recordOwedOnce takes this key form as it is (design 7.2)
// The jid the door mints (crypto.randomUUID): db.recordOwedOnce refuses any 'agowed:' key whose tail is not this, so
// a seat with another jid could never be refunded through the owed lane (db.js recordOwedOnce).
const JID_RE = /^[0-9a-f-]{36}$/;

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
    // a logger missing a line it needs would throw inside a money path (a cash-out logs its order line)
    const lg = log || console;
    if (typeof lg.log !== 'function' || typeof lg.error !== 'function') throw new Error('SlMoney: log needs log and error');
    this.stake = Number(stake);
    this.label = String(label || '');
    this.hooks = h;
    this.now = now;
    this.uuid = uuid;
    this.log = lg;
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
    // Owner-spawned bots have played here (markBots). They play for the gold like people (Owen 2026-10-17): a bot's
    // account opens at its first cash pellet (bank.openBot, no deposit, no wallet) and remembers whose money it holds
    // (botFrom). It never cashes out: its money drops back into play when it dies, and any other way it leaves (removed,
    // restart, crash, emergency, idle with nobody there) goes back to those players as keyed owed rows, never to the
    // house. From then on the floor nobody picked up goes back to the players who dropped it too (_returnFloor).
    this.botRoom = false;
    this.botFrom = new Map(); // bot snake id -> Map srcWallet -> { micro, name }: what it picked up, by whose money
    // Bounty bots (Owen 2026-10-17): a bot spawns carrying the room's stake, its seed, from the owner's bot bank
    // (server/botBank.js, already in escrow). Its balance is seed + picked up. Seed nobody won goes back to the bank
    // through hooks.onSeedBack(micro, why), never the house; pellets of seed name BANK_SRC as their source.
    this.botSeed = new Map(); // bot snake id -> seed micro
    this.tainted = false; // I1, I10 or I13 seen, or a seat refund refused: no new seat (design 8)
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
  // A bot entered the room (slRoom.spawnSnake). One way: the room keeps the rule for the rest of its life.
  markBots() {
    this.botRoom = true;
  }

  // A bounty bot's seed, from the bot bank (the directory took it first): its account opens holding it, booked in like a
  // stake (ledger in), with no wallet and no seat. Throws with nothing changed when it cannot open.
  seedBot(snakeId, micro, name) {
    if (this.stopped) throw new Error('SlMoney.seedBot: the room is settled');
    if (!isMicro(micro) || micro < 1) throw new Error('SlMoney.seedBot: seed must be a whole number above 0');
    this.botRoom = true;
    this.bank.deposit(snakeId, micro, { bot: true, wallet: null, name: String(name || '') });
    this.botFrom.set(snakeId, new Map());
    this.botSeed.set(snakeId, micro);
    this.changed.set(snakeId, micro); // its $ label, like a person's (display only)
  }

  // The {t:'w'} worth of any paid snake on screen, a person's or a bot's (display only; cashOut reads accounts).
  displayWorthOf(snakeId) {
    if (this.botFrom.has(snakeId)) return this.bank.balance(snakeId);
    return this.worthOf(snakeId);
  }

  // A bot leaves the room by the owner's hand (Control lower, slRoom.removeBot): seed to the bank, picked up money to
  // its sources. -> the rows
  retireBot(snakeId) {
    return this.botFrom.has(snakeId) ? this._returnBot(snakeId, 'removed', true) : [];
  }

  // A bot's money in micro (0 when it holds none).
  botBalance(snakeId) {
    return this.botFrom.has(snakeId) ? this.bank.balance(snakeId) : 0;
  }

  // Micro the room's bots hold (owner view, tests).
  botMicro() {
    let n = 0;
    for (const id of this.botFrom.keys()) n += this.bank.balance(id);
    return n;
  }

  _isBot(id) {
    const r = this.room;
    // alive, or died this very step (its name is kept until after the step's facts, slRoom), so a bot that eats its first
    // gold and dies in one step still gets the account its death then drops back into play
    return this.botRoom && !!r && !!r.humans && !r.humans.has(id) &&
      (!!(r.sim && r.sim.snake(id)) || !!(r.names && typeof r.names.has === 'function' && r.names.has(id)));
  }

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
  // A bounty bot's worth is shown like a person's (Owen 2026-10-17: players see what a bot is worth): display only, the
  // bank balance it already holds.
  takeChanged() {
    const out = [];
    for (const [id, d] of this.changed) {
      if (this.accounts.has(id) || this.botFrom.has(id)) out.push({ id, v: this.bank.balance(id), d });
    }
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
  // journal's open record (it replaces the door's step-8 record for the same jid). A throw, or an open the journal did
  // not write (false), rolls the deposit back and closes the record as aborted (the door refunds the token), then
  // throws.
  open(snakeId, entry) {
    if (this.stopped) throw new Error('SlMoney.open: the room is settled');
    if (this.tainted) throw new Error('SlMoney.open: the room is tainted');
    if (!Number.isSafeInteger(snakeId) || snakeId <= 0) throw new Error('SlMoney.open: bad snake id ' + snakeId);
    const e = entry || {};
    if (!isMicro(e.micro) || e.micro < 1) throw new Error('SlMoney.open: micro must be a whole number above 0');
    if (typeof e.wallet !== 'string' || !e.wallet) throw new Error('SlMoney.open: a paid seat needs a wallet');
    if (typeof e.jid !== 'string' || !JID_RE.test(e.jid)) {
      throw new Error('SlMoney.open: a paid seat needs a jid that is a lowercase uuid (its owed key agowed:<jid>)');
    }
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
      // Not written: the seat is refused like a throw (rolled back, the door refunds 'seat-failed'). The door's own
      // record would otherwise stand as this jid's last open, and the boot replay refunds a door-only open's stake row
      // as never seated (security review item d): a seated account must always have its own open record.
      if (this.hooks.journal.open(acct, this.label) === false) {
        this.log.error('[SLP] JOURNAL open of ' + acct.jid + ' not written (' + this.label + '); the seat is refused');
        throw new Error('SlMoney.open: the journal did not write the account\'s open record');
      }
    } catch (err) {
      this._rollback(acct, seated);
      throw err;
    }
    return acct;
  }

  // The seat failed after open (design 3.3, between B and C): the deposit leaves as a refund in the bank's books (the
  // door refunds the token, once, and writes the jid's one journal close), the directory forgets the seat. false when
  // there is no such account. A withdraw refused (the ceiling) leaves the account open and throws: the door then
  // refunds nothing, the room keeps ticking so I4 retries it through the owed lane once its snake is gone, and
  // _refundRefused below has already logged it CRITICAL, alerted and tainted the room.
  abort(snakeId) {
    const acct = this.accounts.get(snakeId);
    if (!acct) return false;
    try {
      this.bank.withdraw(snakeId, 'refund');
    } catch (e) {
      this._refundRefused('abort', acct, e);
      throw e;
    }
    this._close(acct, 'aborted', { why: 'aborted' }, true);
    return true;
  }

  _rollback(acct, seated) {
    try {
      this.bank.withdraw(acct.snakeId, 'refund');
    } catch (e) {
      // the account stays open, and the door sees it and refunds nothing (see abort)
      this._refundRefused('rollback', acct, e);
      return;
    }
    this._close(acct, 'aborted', { why: 'open-failed' }, seated);
  }

  // A seat that failed after its deposit and whose refund the bank refused: the account stays open with no seat, so
  // the door refunds nothing and only I4 (or the owner by hand, from this line) can pay it back. The room takes no
  // new seat: its bank just refused to give money back.
  _refundRefused(what, acct, e) {
    const micro = this.bank.balance(acct.snakeId);
    this.log.error('[SLP] SEAT CRITICAL ' + what + ' refund of snake ' + acct.snakeId + ' (' + acct.jid + ', ' + micro +
      ' micro) refused, left open (' + this.label + '): ' + (e && e.message));
    this._alert('seat-refund-refused', { snakeId: acct.snakeId, jid: acct.jid, micro, why: what });
    if (!this.tainted) {
      this.tainted = true;
      this.log.error('[SLP] TAINTED ' + this.label + ' by a refused seat refund: no new seat opens here');
    }
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
      if (this.botFrom.has(d.id)) {
        this._botDeath(d, out);
        return;
      }
      // a bot that held no money: its drops are plain food
      if (this.botRoom && this.room && this.room.humans && !this.room.humans.has(d.id)) return;
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

  // A bot's death: its whole balance drops as pellets like a person's (slSplit), each pellet naming the person whose
  // money it carries (botFrom, walked in order), so the floor's return still finds a wallet. No food at all: the money
  // goes straight back to those players (_returnBot), never the house.
  _botDeath(d, out) {
    const from = this.botFrom.get(d.id);
    const M = this.bank.balance(d.id);
    const plan = planSplit(M, Array.isArray(d.drops) ? d.drops : []);
    if (plan.foods.length === 0) {
      this._returnBot(d.id, 'nodrop', true);
      return;
    }
    const seed = this.botSeed.get(d.id) || 0;
    // the bank last: a pellet straddling two sources is named by the first, so any rounding lands on the owner's seed,
    // never on a player's money
    const list = Array.from(from.entries()).filter((x) => x[1].micro > 0)
      .concat(seed > 0 ? [[BANK_SRC, { micro: seed, name: 'bot bank' }]] : []);
    const srcs = [];
    let i = 0;
    let left = list.length ? list[0][1].micro : 0;
    for (const share of plan.shares) {
      const cur = list[i];
      srcs.push(cur ? { srcWallet: cur[0] || null, srcName: cur[1].name } : null);
      left -= share;
      while (left <= 0 && i < list.length - 1) {
        i++;
        left += list[i][1].micro;
      }
    }
    this.bank.split(d.id, plan.foods, plan.shares, srcs);
    this.botFrom.delete(d.id);
    this.botSeed.delete(d.id);
    if (seed > 0 && typeof this.hooks.onSeedSpent === 'function') {
      try {
        this.hooks.onSeedSpent(seed);
      } catch (e) {
        this.log.error('[SLP] seed spent hook (' + this.label + '): ' + (e && e.message));
      }
    }
    out.lost.set(d.id, M);
  }

  // A bot's money leaving the room any way but its death (removed, restart, crash, emergency, idle): withdrawn as a
  // refund and owed back to the players it came from, one keyed row each (_owedRows). -> the rows
  _returnBot(id, why, live) {
    const from = this.botFrom.get(id);
    // the withdraw first: a refused one (the ceiling) throws with the bot still on botFrom, so a later pass retries it
    const w = this.bank.withdraw(id, 'refund');
    const seed = this.botSeed.get(id) || 0;
    this.botFrom.delete(id);
    this.botSeed.delete(id);
    if (!w || !(w.micro > 0)) return [];
    const src = (seed > 0 ? [{ srcWallet: BANK_SRC, srcName: 'bot bank', micro: seed, live: true }] : []).concat(from
      ? Array.from(from.entries()).map(([k, v]) => ({ srcWallet: k || null, srcName: v.name, micro: v.micro })) : []);
    const sum = src.reduce((n, x) => n + x.micro, 0);
    if (sum !== w.micro) {
      // impossible (every credit adds the same micro to both); the last source takes the difference so none is lost
      this.log.error('[SLP] BOT CRITICAL ' + id + ' holds ' + w.micro + ' but its sources say ' + sum + ' (' + this.label + ')');
      if (src.length) src[src.length - 1].micro += w.micro - sum;
    }
    return this._owedRows(src.filter((x) => x.micro > 0), why, live);
  }

  // The room's bots give back what they hold, and the floor goes back too (no person is open here): the directory
  // calls this for a held room nobody has played in for FLOOR_SWEEP_MS, so a bot never sits on money for good.
  releaseBots(why = 'idle') {
    const rows = [];
    for (const id of Array.from(this.botFrom.keys())) {
      try {
        rows.push(...this._releaseOne(id, why));
      } catch (e) {
        this.log.error('[SLP] idle release of bot ' + id + ' failed (' + this.label + '), the next sweep retries: ' +
          (e && e.message));
      }
    }
    if (this.accounts.size === 0) rows.push(...this._returnFloor(why, true));
    return rows;
  }

  _releaseOne(id, why) {
    const rows = [];
    {
      const seed = this.botSeed.get(id) || 0;
      if (seed > 0) {
        // a bounty bot keeps playing with its seed; only what it picked up goes back
        const from = this.botFrom.get(id);
        const gone = this.bank.trimBot(id, seed);
        if (gone > 0) {
          this.botFrom.set(id, new Map());
          this.changed.set(id, (this.changed.get(id) || 0) - gone);
          rows.push(...this._owedRows(Array.from(from.entries()).filter((x) => x[1].micro > 0)
            .map(([k, v]) => ({ srcWallet: k || null, srcName: v.name, micro: v.micro })), why, true));
        }
      } else {
        rows.push(...this._returnBot(id, why, true));
      }
    }
    return rows;
  }

  // An eat: a pellet's micro moves to the eater's account, once. A pellet eaten by a snake with no account (no bots
  // in a paid room, so only a bug) goes to the house as a breach incident, once, with an alert.
  _eat(e, out) {
    if (!e || !e.food) return;
    const pel = this.bank.pellet(e.food);
    let m = this.bank.credit(e.food, e.eater);
    // a bot's first cash pellet opens its account (no deposit, no wallet), then the same credit
    if (m === -1 && pel && this._isBot(e.eater)) {
      this.bank.openBot(e.eater, { name: (this.room.names && this.room.names.get(e.eater)) || '' });
      this.botFrom.set(e.eater, new Map());
      try {
        m = this.bank.credit(e.food, e.eater);
      } finally {
        if (!(m > 0)) {
          this.bank.dropEmptyBot(e.eater);
          this.botFrom.delete(e.eater);
        }
      }
    }
    if (m > 0) {
      const from = this.botFrom.get(e.eater);
      if (from) {
        const k = pel.srcWallet || '';
        const f = from.get(k) || { micro: 0, name: pel.srcName || '' };
        f.micro += m;
        from.set(k, f);
      }
      this.changed.set(e.eater, (this.changed.get(e.eater) || 0) + m);
      out.credited += m;
      return;
    }
    if (m !== -1) return; // natural food, a boost crumb, a replayed eat
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
  // account unpaid (critic C-6). Any throw before the withdraw is logged CRITICAL and alerted here, the room only
  // keeps the snake playing. null when the snake has no account (a death this step won).
  // -> { cid, gross, cut, net, order }
  cashOut(snakeId, socketId) {
    const acct = this.accounts.get(snakeId);
    if (!acct) return null;
    let cashoutId;
    let w;
    try {
      cashoutId = this.uuid(); // before the withdraw: after it nothing may throw ahead of the dispatch
      w = this.bank.withdraw(snakeId, 'cash');
      if (!w) throw new Error('the bank holds no account ' + snakeId);
    } catch (e) {
      this._alert('cashout-refused', { snakeId });
      this.log.error('[SLP] CASHOUT CRITICAL refused for snake ' + snakeId + ' (' + this.label + '), it keeps playing: ' +
        (e && e.message));
      throw e;
    }
    const gross = w.micro;
    const cut = Math.floor(gross / HOUSE_CUT_DIV);
    const net = gross - cut;
    const order = { cashoutId, socketId: typeof socketId === 'string' ? socketId : null,
      wallet: w.acct.wallet, name: w.acct.name || '', grossMicro: gross, stake: this.stake, label: this.label,
      jid: acct.jid };
    try {
      // awaitPayout: the server writes a payout record when the payout answers (index.js onCashout); a close left
      // without one at the next boot is flagged CASHOUT-UNCONFIRMED-AT-BOOT (agJournal)
      this._close(acct, 'cashedout', { why: 'cashout', grossMicro: gross, cutMicro: cut, netMicro: net,
        cashoutId: order.cashoutId, awaitPayout: true });
    } finally {
      // the order line in its own try: a logger that throws must not keep the order from going out (the journal
      // close above carries the cashoutId, the gross and the net, and its open the wallet, for a hand reconcile)
      try {
        this.log.log('[SLP] CASHOUT-ORDER ' + order.cashoutId + ' ' + gross + ' ' + this.label + ' journal ' + acct.jid +
          ' wallet ' + order.wallet);
      } catch (_) { /* nothing left to log it with */ }
      safeAsync(() => this.hooks.onCashout(order), (e) => {
        this._alert('cashout-order', { micro: gross });
        this.log.error('[SLP] CASHOUT CRITICAL order ' + order.cashoutId + ' failed, owed ' + gross + ' micro gross (' +
          this.label + '): ' + (e && e.message));
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
  // the house through onFloor, one sweep per source wallet. It never throws: an account whose refund throws stays
  // open and comes back in left (its snake ids), and the directory keeps the room on its settling list while left is
  // not empty or the bank is not (counted by drain and solvency, retried by the sweep). The journal why is always
  // 'emergency', an owed why, so the close keeps its key for the replay (agJournal OWED_WHYS); the caller's label
  // rides in the alert only. -> { accounts, micro, rows, floor, left }
  emergencySettle(why = 'emergency') {
    this.stopped = true;
    const rows = [];
    let micro = 0;
    for (const acct of Array.from(this.accounts.values())) {
      try {
        const row = this._refundOwed(acct, 'emergency');
        rows.push(row);
        micro += row.micro;
      } catch (e) {
        this._leftOpen('EMERGENCY', acct, e);
      }
    }
    for (const id of Array.from(this.botFrom.keys())) {
      try {
        this._returnBot(id, 'emergency', true);
      } catch (e) {
        this.log.error('[SLP] EMERGENCY bot ' + id + ' not returned (' + this.label + '): ' + (e && e.message));
      }
    }
    let floor = null;
    try {
      floor = this._sweep('emergency');
    } catch (e) {
      this.log.error('[SLP] EMERGENCY floor sweep failed, left on the floor (' + this.label + '): ' + (e && e.message));
    }
    this._phase('collusion', () => this._flushBuckets(true));
    const left = Array.from(this.accounts.keys());
    this._alert('emergency', { accounts: rows.length, micro, left: left.length, why: String(why || 'emergency') });
    return { accounts: rows.length, micro, rows, floor, left };
  }

  // A settle that could not close an account: it stays open with its CURRENT balance, which this line names (the
  // journal's open record, all UNSETTLED-AT-BOOT can show, has only the deposit).
  _leftOpen(what, acct, e) {
    const micro = this.bank.balance(acct.snakeId);
    this.log.error('[SLP] ' + what + ' settle of snake ' + acct.snakeId + ' (' + acct.jid + ', ' + micro + ' micro) failed, ' +
      'left open (' + this.label + '): ' + (e && e.message));
  }

  // A planned restart ('shutdown') or a crash ('crash'), design 7.2: every account withdrawn, closed 'refunded' in
  // the journal with its owed row (100% of the current balance, no rake), and the rows handed back for the caller to
  // write (installAgShutdown; the crash path leaves them to the journal replay). The floor is booked to the house as
  // abandoned, logged, and journaled as one floor record with its micro per source wallet (Owen, 2026-10-14: the house
  // keeps it as slither floor income): no on-chain move and no database write in the exit window, the next boot's
  // replay books it once (slither_floor and the rake sweep, agJournal).
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
        this._leftOpen('SHUTDOWN', acct, e);
      }
    }
    if (this.botRoom) {
      for (const id of Array.from(this.botFrom.keys())) {
        try {
          rows.push(...this._returnBot(id, kind, false));
        } catch (e) {
          this.log.error('[SLP] SHUTDOWN bot ' + id + ' not returned (' + this.label + '): ' + (e && e.message));
        }
      }
      try {
        rows.push(...this._returnFloor(kind, false));
      } catch (e) {
        this.log.error('[SLP] SHUTDOWN floor not returned (' + this.label + '): ' + (e && e.message));
      }
      this._phase('collusion', () => this._flushBuckets(true));
      return rows;
    }
    let f = null;
    try {
      f = this.bank.takeFloor('abandoned');
      if (f.micro > 0) this.log.error('[SLP] SHUTDOWN-FLOOR ' + f.micro + ' ' + this.label);
    } catch (e) {
      this.log.error('[SLP] SHUTDOWN floor not booked (' + this.label + '): ' + (e && e.message));
    }
    if (f && f.micro > 0) this._journalFloor(f, kind);
    this._phase('collusion', () => this._flushBuckets(true));
    return rows;
  }

  // The abandoned floor's journal record (agJournal floor): one key, the room, the why and each source wallet's micro.
  // A record the journal cannot take is logged CRITICAL with the amount: the money is still in escrow, unbooked.
  _journalFloor(f, why) {
    let key = '?';
    try {
      key = 'slfloor:' + this.uuid();
      const j = this.hooks.journal;
      const rec = { key, room: this.label, why, micro: f.micro,
        bySource: f.bySource.map((s) => ({ srcWallet: s.srcWallet, srcName: s.srcName, micro: s.micro })) };
      if (typeof j.floor !== 'function' || j.floor(rec) === false) throw new Error('the journal took no floor record');
    } catch (e) {
      try {
        this.log.error('[SLP] JOURNAL CRITICAL floor ' + key + ' of ' + f.micro + ' micro not written (' + this.label +
          '), left in escrow unbooked: ' + (e && e.message));
      } catch (_) { /* dying anyway */ }
    }
  }

  // The idle retire (design 7.5): the floor to the house through onFloor, one sweep per source wallet with its exact
  // micro and a unique sweepId. Refused (null) while any account is open: that gold can still be eaten. Every
  // collusion bucket is flushed first, as the settles do: the room paused with no step after it, so a bucket too young
  // for the last endStep would be lost with the room. -> { micro, count, sweeps }
  sweepFloor(why = 'idle') {
    if (this.accounts.size > 0) return null;
    for (const id of Array.from(this.botFrom.keys())) this._returnBot(id, String(why || 'idle'), true);
    this._phase('collusion', () => this._flushBuckets(true));
    return this._sweep(String(why || 'idle'));
  }

  _sweep(why) {
    if (this.botRoom) {
      const rows = this._returnFloor(why, true);
      return { micro: rows.reduce((n, r) => n + r.micro, 0), count: rows.length, sweeps: [], returned: rows };
    }
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

  // A room bots played in (Owen 2026-10-16: "I'm never going to be taking any money with my bots"): the floor nobody
  // picked up goes back, 100%, to the players who dropped it, one owed row per source wallet, never to the house. Each
  // row is journaled first as a keyed close (why 'botfloor', agJournal OWED_WHYS), so a crash after it is replayed
  // once by key at the next boot; live (idle retire, emergency) the row goes through onOwed now, at a restart it is
  // handed back with the account rows for the caller to write. -> the rows
  _returnFloor(why, live) {
    const f = this.bank.takeFloor('returned');
    const rows = this._owedRows(f.bySource, why, live);
    if (f.micro > 0) this.log.log('[SLP] BOTFLOOR ' + f.micro + ' micro back to ' + rows.length + ' player(s) ' + this.label);
    return rows;
  }

  // sources [{ srcWallet, srcName, micro }] -> one owed row each, journaled first as a keyed close (why 'botfloor'),
  // sent through onOwed now when live, else handed back for the caller to write (a restart's rows).
  _owedRows(sources, why, live) {
    const rows = [];
    for (const s of sources) {
      if (s.srcWallet === BANK_SRC) {
        // seed nobody won: back to the owner's bot bank (saved there at once), never the house
        try {
          if (typeof this.hooks.onSeedBack !== 'function') throw new Error('no onSeedBack hook');
          this.hooks.onSeedBack(s.micro, String(why), this.label, s.live === true);
        } catch (e) {
          this.log.error('[SLP] SEEDBACK CRITICAL ' + s.micro + ' micro not returned to the bot bank (' + this.label + '): ' +
            (e && e.message));
          this._alert('seedback', { micro: s.micro });
        }
        continue;
      }
      if (typeof s.srcWallet !== 'string' || !s.srcWallet) {
        // impossible: every pellet comes from an account, and every account has a wallet (open)
        this.log.error('[SLP] BOTFLOOR CRITICAL ' + s.micro + ' micro with no source wallet (' + this.label + ')');
        this._alert('botfloor-no-wallet', { micro: s.micro });
        continue;
      }
      const key = OWED_PREFIX + this.uuid();
      const reason = 'refund slither botfloor ' + String(why) + ' ' + this.label + ' ' + key;
      const row = { key, wallet: s.srcWallet, name: s.srcName || '', micro: s.micro, reason };
      try {
        this.hooks.journal.close({ jid: this.uuid(), wallet: row.wallet, name: row.name }, 'refunded',
          { why: 'botfloor', key, refundedMicro: row.micro, reason }, this.label);
      } catch (e) {
        this.log.error('[SLP] JOURNAL CRITICAL botfloor ' + key + ' threw (' + this.label + '): ' + (e && e.message));
      }
      rows.push(row);
      if (live) {
        safeAsync(() => this.hooks.onOwed(row), (e) => {
          this.log.error('[SLP] OWED CRITICAL botfloor ' + key + ' failed (' + row.micro + ' micro, ' + this.label +
            '); the journal carries it to the next boot: ' + (e && e.message));
          this._alert('owed', { micro: row.micro });
        });
      }
    }
    return rows;
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
    // a bot whose snake left without dying (a plain removal): its money goes back to the players it came from
    this._phase('bots', () => {
      for (const id of Array.from(this.botFrom.keys())) {
        if (!sim.snake(id)) this._returnBot(id, 'removed', true);
      }
    });
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
