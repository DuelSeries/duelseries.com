'use strict';
// The money controller of ONE paid agar.io room (PAID-AGAR-DESIGN.md 3.4, with Owen's binding answers of 2026-10-08
// in agario-reference/OWNER-ANSWERS.md). The sim stays money-free (design 3.1): it reports facts (who ate whose
// cell, how big), and this controller applies them to the room's AgBank in sim order, once per tick, after the step.
// This file never touches the chain, the database or a socket object: money leaves only through the hooks (the
// directory wires them to the agar payout), and the room is told about every closed account through onClosed.
//
// Accounts (one per paid player, keyed by the sim player id):
//   unconfirmed  shielded and still, waiting for ag:ready (the page drew its own cell); no ready in JOIN_CONFIRM_MS,
//                or its socket gone, refunds the deposit in full ('released')
//   live         playing; may hold Q (holding: still, split and eject refused, edible); HOLD_TICKS held ticks with a
//                live cell cash it out at 90/10 ('cashedout')
//   grace        socket gone: DISCONNECT_GRACE_MS with its cells still heading for the last mouse point
//   dormant      then still and edible for DORMANT_SETTLE_MS, then cashed out 90/10 to its own wallet ('settled',
//                Owen Q5)
//   frozen       breach backstop: an open account with no live cell (only a code bug gets here, design 3.4 step 5);
//                money stays counted as live money; after ZOMBIE_SETTLE_MS it goes to the house as agar_breach for a
//                manual refund ('frozen-settled')
// A last-cell eat closes the victim ('eaten'). A room crash (emergency close) or a server restart refunds 100% of every
// open balance, no rake (Owen Q6, 'refunded'). closeAccount is the ONLY code that deletes an account.

const crypto = require('crypto');
const { AgBank } = require('./agBank');

function chosen(value, note) {
  return Object.freeze({ value, status: 'CHOSEN', note });
}
function sourced(value, note) {
  return Object.freeze({ value, status: 'SOURCED', note });
}

// Every number with its source (design 3.5, Owen 2026-10-08) or CHOSEN (logged in agario-reference/PARITY-LOG.md).
const AG_MONEY = Object.freeze({
  HOLD_TICKS: sourced(75, 'Owen 2026-10-08 cash-out: the ring closes after 3 s of holding; 3 s is 75 ticks of L1 ' +
    '(agLaws TICK_MS 40.014: 3001 ms); design 3.5 HOLD_TICKS'),
  HOLD_INPUT_STALE_MS: sourced(500, 'design 3.5 HOLD_INPUT_STALE_MS: a hold counts only while its last ag:hold {on:1} ' +
    'is this fresh (the page repeats it every 200 ms)'),
  DISCONNECT_GRACE_MS: sourced(5000, "design 3.5 / Q25: Paper's DISCONNECT_GRACE_MS (public/js/paper/mp/paperWire.js:35)"),
  JOIN_CONFIRM_MS: sourced(5000, 'design 3.5 JOIN_CONFIRM_MS (Paper 3000; agar\'s first bundle is a whole world)'),
  DORMANT_SETTLE_MS: sourced(180000, 'Owen Q5 2026-10-08: frozen 3 minutes, edible, then cashed out 90/10 to the wallet'),
  ZOMBIE_SETTLE_MS: sourced(60000, 'design 3.5 ZOMBIE_SETTLE_MS'),
  SPAWN_CLEAR: sourced(500, 'design 3.5 SPAWN_CLEAR (world units beyond touching)'),
  SPAWN_TRIES: sourced(64, 'design 3.5 SPAWN_TRIES'),
  COLLUSION_FLUSH_MS: sourced(60000, 'design 3.5 / 8.2: a money-eat bucket is recorded at the victim life\'s end or ' +
    'this long after it opened'),
  FEED_WINDOW_MS: sourced(86400000, 'design 8.2: the eject-feed tally per (feeder, eater) pair covers 24 h'),
  FEED_PAIRS_MAX: chosen(5000, 'eject-feed pairs kept per room at most (oldest dropped first); memory bound only'),
});

const REQUIRED_HOOKS = Object.freeze(['onCashout', 'onTransfer', 'onFeed', 'onRefund', 'onBreach', 'onStake',
  'onHouse', 'onAccountOpen', 'onAccountClosed']);

const OPEN_STATES = Object.freeze(['unconfirmed', 'live', 'grace', 'dormant', 'frozen']);

function isMicro(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function toMicro(amount) {
  return Math.round(Number(amount) * 1e6);
}

class AgMoney {
  // sim: the room's sim (playerInfo, getCell, takeMoneyEvents); stake: the rung in dollars; label: the room's lobbyType
  // shielded, still: the Sets the sim was built with (paid option); now: wall clock ms
  // tell(socketId, event, payload): emit to that seat's socket (the room resolves it); onClosed(acct, outcome, extra):
  // the room drops the seat, tells the page and removes the sim player
  constructor({ sim, stake, label, hooks, shielded, still, now = Date.now, log = console, tell, onClosed,
    uuid = () => crypto.randomUUID() } = {}) {
    if (!sim) throw new Error('AgMoney: sim is required');
    if (!(Number(stake) > 0)) throw new Error('AgMoney: a paid room needs a stake above 0');
    if (!(shielded instanceof Set) || !(still instanceof Set)) throw new Error('AgMoney: shielded and still must be Sets');
    const h = hooks || {};
    for (const name of REQUIRED_HOOKS) {
      if (typeof h[name] !== 'function') throw new Error('AgMoney: hook ' + name + ' must be a function');
    }
    this.sim = sim;
    this.stake = Number(stake);
    this.label = String(label || '');
    this.hooks = h;
    this.shielded = shielded;
    this.still = still;
    this.now = now;
    this.log = log || console;
    this.tell = typeof tell === 'function' ? tell : () => {};
    this.onClosed = typeof onClosed === 'function' ? onClosed : () => {};
    this.uuid = uuid;
    this.accounts = new Map();     // pid -> account (open only)
    this.buckets = new Map();      // life + '|' + dstWallet -> { src, dst, micro, openedAt, life } (design 8.2)
    this.feeds = new Map();        // feederWallet + '|' + eaterWallet -> tally (design 8.2)
    this.lifeSeq = 0;
    this.closedCount = Object.create(null);   // outcome -> n (owner view, tests)
    this.bank = new AgBank({
      onTransfer: (t) => this._bucket(t),
      onBreach: (info) => this._breach(Object.assign({ kind: info && info.kind ? info.kind : 'ledger' }, info)),
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Reads.

  account(pid) {
    return this.accounts.get(pid) || null;
  }

  balance(pid) {
    return this.bank.balance(pid);
  }

  openCount() {
    return this.accounts.size;
  }

  // Seats whose player is away (grace + dormant): shown as `parked` on the lobby row (design 5.3).
  parkedCount() {
    let n = 0;
    for (const a of this.accounts.values()) if (a.state === 'grace' || a.state === 'dormant') n++;
    return n;
  }

  // Dollars for the solvency sum: every open account (frozen included) plus floor money (design 3.4).
  liveStakeTotal() {
    return this.bank.totalMicro() / 1e6;
  }

  get floorWorth() {
    return this.bank.floorMicro() / 1e6;
  }

  // What ops.drainStatus reads: every open account with its real worth, alive: true even while away or frozen, so
  // "Safe to restart" and rule 4b see parked money (design 3.4, 9).
  get snakes() {
    const m = new Map();
    for (const a of this.accounts.values()) {
      m.set('ag' + a.pid, { alive: true, isBot: false, worth: this.bank.balance(a.pid) / 1e6 });
    }
    return m;
  }

  hasLiveCell(pid) {
    const info = this.sim.playerInfo(pid);
    return !!(info && info.cells.length > 0);
  }

  // The eject-feed tally for the owner view (design 8.2): no wallets beyond what the owner already sees.
  feedFlags() {
    const out = [];
    for (const f of this.feeds.values()) {
      out.push({ feeder: f.feeder, eater: f.eater, count: f.count, micro: f.micro, sameIp: f.sameIp,
        firstAt: f.firstAt, lastAt: f.lastAt });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Opening and confirming.

  // A paid seat bought at the door (design 3.4 open). Throws on a bad entry, with nothing opened.
  open({ pid, socketId = null, wallet, name = '', micro, paid, proof = null, ip = '' } = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('AgMoney.open: bad pid ' + pid);
    if (typeof wallet !== 'string' || !wallet) throw new Error('AgMoney.open: a paid seat needs a wallet');
    if (!isMicro(micro) || micro <= 0) throw new Error('AgMoney.open: micro must be a whole number above 0');
    if (this.accounts.has(pid)) throw new Error('AgMoney.open: account ' + pid + ' is already open');
    this.bank.deposit(pid, micro, wallet, name);
    const acct = {
      pid, wallet, name: typeof name === 'string' ? name : '', deposit: micro,
      paid: Number.isFinite(paid) ? paid : undefined,
      proof: typeof proof === 'string' && proof ? proof : null,
      resumeKey: this.uuid(),
      jid: this.uuid(),           // the money journal's id for this account (agJournal), never a credential
      state: 'unconfirmed',
      readied: null,              // the socket whose ag:ready waits for a clear spot (confirm)
      confirmBy: this.now() + AG_MONEY.JOIN_CONFIRM_MS.value,
      holding: false, holdTicks: 0, lastHoldAt: 0,
      socketId: typeof socketId === 'string' ? socketId : null,
      graceUntil: 0, dormantSince: 0, frozenSince: 0,
      life: this.label + ':' + pid + ':' + ++this.lifeSeq,
      ip: typeof ip === 'string' ? ip : '',
      openedAt: this.now(),
    };
    this.accounts.set(pid, acct);
    this.shielded.add(pid);
    this.still.add(pid);
    try {
      this.hooks.onAccountOpen(acct);
    } catch (e) {
      // The directory could not record the seat: nothing stays open (the door refunds the token).
      this.accounts.delete(pid);
      this.shielded.delete(pid);
      this.still.delete(pid);
      this.bank.withdraw(pid);
      throw e;
    }
    return acct;
  }

  // The door's seat failed after open (the sim refused the spawn): the account goes with nothing paid out here (the
  // door refunds the token), and the directory forgets it.
  abort(pid) {
    const acct = this.accounts.get(pid);
    if (!acct) return false;
    this.bank.withdraw(pid);
    this._close(acct, 'aborted', {});
    return true;
  }

  // ag:ready from the seat's own socket, with its cell on the map (design 3.4 confirm): the shield and the freeze go,
  // and the buy-in row is written (onStake), once. Review fix (spawn camping): the spot is checked again first, since
  // a bigger cell may have parked on the shielded newcomer; an unsafe spot moves the cell to a fresh clear point
  // (findSpawnPoint's rule), and with no clear point anywhere the ready waits (retried after every step) until one
  // appears or JOIN_CONFIRM_MS passes ('no-room', refunded in full like every unconfirmed exit).
  confirm(pid, socketId) {
    const acct = this.accounts.get(pid);
    if (!acct || acct.state !== 'unconfirmed' || acct.socketId === null || acct.socketId !== socketId) return false;
    if (!this.hasLiveCell(pid)) return false;
    if (!this._clearToStart(acct)) {
      acct.readied = socketId;
      return false;
    }
    this._finishConfirm(acct);
    return true;
  }

  // The newcomer's one cell is clear of every cell that could eat it, after moving it to a clear point if needed.
  _clearToStart(acct) {
    const clear = AG_MONEY.SPAWN_CLEAR.value;
    if (this.sim.spawnClearOf(acct.pid, clear)) return true;
    const pt = this.sim.findSpawnPoint(this.sim.startSize(), clear, AG_MONEY.SPAWN_TRIES.value);
    if (!pt || !this.sim.relocate(acct.pid, pt)) return false;
    this.log.warn('[AG] SPAWN moved at ready ' + this.label + ' pid ' + acct.pid + ' (a cell that could eat it was near)');
    return this.sim.spawnClearOf(acct.pid, clear);
  }

  _finishConfirm(acct) {
    const pid = acct.pid;
    acct.readied = null;
    acct.state = 'live';
    acct.confirmBy = 0;
    this.shielded.delete(pid);
    this.still.delete(pid);
    try {
      this.hooks.onStake({ wallet: acct.wallet, worth: acct.deposit / 1e6, label: this.label });
    } catch (e) {
      this.log.error('[AG] stake row', e && e.message);
    }
    if (typeof this.hooks.onAccountConfirmed === 'function') {
      try {
        this.hooks.onAccountConfirmed(acct);
      } catch (e) {
        this.log.error('[AG] confirm hook', e && e.message);
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Hold-Q cash-out (Owen 2026-10-08).

  // ag:hold from the seat's own socket: on refreshes the hold, off releases it at once (counted at the next tick).
  setHold(pid, socketId, on) {
    const acct = this.accounts.get(pid);
    if (!acct || acct.socketId === null || acct.socketId !== socketId) return false;
    acct.lastHoldAt = on === true ? this.now() : 0;
    return true;
  }

  // Before the step (design 3.4 holdTick): a hold counts only for a confirmed live account with its socket attached,
  // a live cell, and a fresh hold message; holders are still (movement locks at once). Anything else resets it.
  holdTick() {
    const now = this.now();
    const stale = AG_MONEY.HOLD_INPUT_STALE_MS.value;
    for (const acct of this.accounts.values()) {
      const want = acct.state === 'live' && acct.socketId !== null && acct.lastHoldAt > 0 &&
        now - acct.lastHoldAt <= stale && this.hasLiveCell(acct.pid);
      if (want) {
        if (!acct.holding) {
          acct.holding = true;
          acct.holdTicks = 0;
          this.still.add(acct.pid);
          this.tell(acct.socketId, 'ag:holding', { on: 1, need: AG_MONEY.HOLD_TICKS.value });
        }
        acct.holdTicks++;
      } else if (acct.holding) {
        this._stopHold(acct, true);
      }
    }
  }

  _stopHold(acct, tellIt) {
    if (!acct.holding) return;
    acct.holding = false;
    acct.holdTicks = 0;
    if (acct.state === 'live') this.still.delete(acct.pid);
    if (tellIt && acct.socketId) this.tell(acct.socketId, 'ag:holding', { on: 0 });
  }

  // ---------------------------------------------------------------------------------------------------------
  // After the step, every tick (design 3.4 afterStep). Never throws: each phase and each fact in its own try.

  afterStep(ev) {
    const e = ev || {};
    // 1. money facts, in sim order
    if (Array.isArray(e.money)) {
      for (const f of e.money) this._applyFactSafe(f);
    }
    // 2. eject feeds: flagged only, never money (Q22)
    if (Array.isArray(e.feeds)) {
      for (const f of e.feeds) {
        try {
          this._tallyFeed(f);
        } catch (err) {
          this.log.error('[AG] feed tally', err && err.message);
        }
      }
    }
    // 3. finished holds; the eats above ran first, so death wins a same-tick tie (Q24)
    this._phase('holds', () => {
      for (const acct of Array.from(this.accounts.values())) {
        if (!acct.holding || acct.holdTicks < AG_MONEY.HOLD_TICKS.value) continue;
        if (acct.state !== 'live' || acct.socketId === null || !this.hasLiveCell(acct.pid)) {
          this._stopHold(acct, true);
          continue;
        }
        this.completeCashout(acct.pid, 'cashedout');
      }
    });
    // 4. timers
    this._phase('timers', () => {
      const now = this.now();
      for (const acct of Array.from(this.accounts.values())) {
        if (!this.accounts.has(acct.pid)) continue;
        const readied = acct.state === 'unconfirmed' && acct.readied !== null && acct.readied === acct.socketId;
        if (readied && now < acct.confirmBy && this.hasLiveCell(acct.pid) && this._clearToStart(acct)) {
          this._finishConfirm(acct);
        } else if (acct.state === 'unconfirmed' && now >= acct.confirmBy) {
          this.release(acct.pid, readied ? 'no-room' : 'join-timeout');
        } else if (acct.state === 'grace' && now >= acct.graceUntil) {
          acct.state = 'dormant';
          acct.dormantSince = now;
          this.still.add(acct.pid);
        } else if (acct.state === 'dormant' && now - acct.dormantSince >= AG_MONEY.DORMANT_SETTLE_MS.value) {
          this.completeCashout(acct.pid, 'settled');
        }
      }
    });
    // 5. zombie backstop: every open account must have a live cell
    this._phase('zombies', () => {
      const now = this.now();
      for (const acct of Array.from(this.accounts.values())) {
        if (acct.state === 'frozen') {
          if (now - acct.frozenSince >= AG_MONEY.ZOMBIE_SETTLE_MS.value) this.houseSettle(acct.pid, 'zombie');
          continue;
        }
        if (this.hasLiveCell(acct.pid)) continue;
        // A seat that never readied has never played: its spawn was lost, so it is refunded in full like every
        // other unconfirmed exit (design 3.4 release), never frozen.
        if (acct.state === 'unconfirmed') {
          this.release(acct.pid, 'join-failed');
          continue;
        }
        this._freeze(acct, now);
      }
    });
    // 6. collusion buckets older than the flush window
    this._phase('collusion', () => this._flushBuckets(null, this.now()));
    // 7. the ledger closes every tick (Paper does the same, PaperRoom.js:502)
    this._phase('conserved', () => this.bank.assertConserved());
  }

  _phase(name, fn) {
    try {
      fn();
    } catch (err) {
      this.log.error('[AG] money ' + name + ' threw', this.label, err && err.stack ? err.stack : err);
      this._breach({ kind: 'phase', phase: name, message: err && err.message });
    }
  }

  _applyFactSafe(f) {
    try {
      this._applyFact(f);
    } catch (err) {
      this.log.error('[AG] money fact threw', this.label, err && err.stack ? err.stack : err);
      this._breach({ kind: 'fact', message: err && err.message });
    }
  }

  // One eat of another player's cell: the victim's share moves to the eater; a last cell moves the rest and closes
  // the victim. A refused transfer leaves both balances as they were (the bank reports it once).
  _applyFact(f) {
    if (!f || typeof f !== 'object') return;
    const victim = this.accounts.get(f.victim);
    const eater = this.accounts.get(f.eater);
    const moved = this.bank.transferShare(f.victim, f.eater, f.eatenSq, f.victimSq, f.last === true,
      victim ? victim.life : null);
    if (moved < 0) return;
    if (f.last === true && victim) {
      this._close(victim, 'eaten', { lostMicro: moved, by: eater ? eater.name : '', byPid: f.eater });
    }
  }

  _freeze(acct, now) {
    const was = acct.state;
    if (acct.holding) this._stopHold(acct, true);
    acct.state = 'frozen';
    acct.frozenSince = now;
    this.shielded.delete(acct.pid);
    this.still.add(acct.pid);
    this.log.error('[AG] ZOMBIE ' + this.label + ' pid ' + acct.pid + ' had no live cell (' + was + '); frozen with ' +
      this.bank.balance(acct.pid) + ' micro');
    this._breach({ kind: 'zombie', micro: this.bank.balance(acct.pid), was });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Exits. Every one withdraws FIRST (nothing can be both paid and still open), then closes, then dispatches.

  // A finished hold ('cashedout') or the dormant auto cash-out ('settled', Owen Q5): 90/10 through onCashout.
  completeCashout(pid, outcome) {
    const acct = this.accounts.get(pid);
    if (!acct) return null;
    const why = outcome === 'settled' ? 'settled' : 'cashedout';
    const socketId = acct.socketId;
    const w = this.bank.withdraw(pid);
    const order = w ? {
      cashoutId: this.uuid(), socketId, wallet: w.wallet, name: w.name, grossMicro: w.micro, stake: this.stake,
      label: this.label,
    } : null;
    try {
      this._close(acct, why, { grossMicro: order ? order.grossMicro : 0, cashoutId: order ? order.cashoutId : null });
    } finally {
      if (order && order.grossMicro > 0) {
        try {
          this.hooks.onCashout(order);
        } catch (e) {
          this.log.error('[AG] CASHOUT CRITICAL hook threw, owed ' + order.grossMicro + ' micro gross to ' +
            order.wallet + ': ' + (e && e.message));
        }
      }
    }
    return order;
  }

  // An unconfirmed seat that never readied: its socket went ('join-lost') or JOIN_CONFIRM_MS passed
  // ('join-timeout'). The deposit goes back in full, bounded by what landed (the payout caps at paid). A shielded
  // account can neither eat nor be eaten, so its balance is its deposit; anything above it is a breach and goes to
  // the house for a manual look, never to the player.
  release(pid, why) {
    const acct = this.accounts.get(pid);
    if (!acct || acct.state !== 'unconfirmed') return false;
    const w = this.bank.withdraw(pid);
    const got = w ? w.micro : 0;
    const { back, extra } = this._unconfirmedSplit(acct, got);
    this.log.log('[AG] RELEASE ' + this.label + ' ' + why + ' refund=' + back + (extra > 0 ? ' extra=' + extra : ''));
    try {
      this._close(acct, 'released', { why, refunded: back > 0 });
    } finally {
      if (back > 0) {
        try {
          this.hooks.onRefund({ wallet: acct.wallet, name: acct.name, micro: back, paid: acct.paid, why });
        } catch (e) {
          this.log.error('[AG] RELEASE CRITICAL refund hook threw, owed ' + back + ' micro to ' + acct.wallet + ': ' +
            (e && e.message));
        }
      }
      this._extraToHouse(acct, extra, 'release-extra');
    }
    return true;
  }

  // What an UNCONFIRMED seat gets back, the same on every path (release, emergency, shutdown, crash): its balance,
  // never above its deposit (a shielded seat can neither eat nor be eaten, so `extra` above the deposit is a bug: it
  // goes to the house with an alert, never to the player) and never above what landed on-chain (paid: SOL mode
  // verified up to 5 percent under the rung; that part never reached the escrow, so it is nobody's money and is not
  // booked anywhere; in USDC mode paid is at least the rung, server/index.js entryStore.mint).
  _unconfirmedSplit(acct, got) {
    const upToDeposit = Math.min(got, acct.deposit);
    const extra = got - upToDeposit;
    const landed = Number.isFinite(acct.paid) ? toMicro(acct.paid) : upToDeposit;
    return { back: Math.max(0, Math.min(upToDeposit, landed)), extra };
  }

  _extraToHouse(acct, extra, kind) {
    if (!(extra > 0)) return;
    this._breach({ kind, micro: extra });
    this._toHouse(acct, extra, kind);
  }

  // A frozen account after ZOMBIE_SETTLE_MS (design 3.4 step 5): the balance goes to the house under agar_breach,
  // with the wallet in the database row only, for Owen to pay back by hand.
  houseSettle(pid, why) {
    const acct = this.accounts.get(pid);
    if (!acct) return false;
    const w = this.bank.withdraw(pid);
    const micro = w ? w.micro : 0;
    try {
      this._close(acct, 'frozen-settled', { micro, why });
    } finally {
      if (micro > 0) this._toHouse(acct, micro, why);
    }
    return true;
  }

  _toHouse(acct, micro, why) {
    try {
      this.hooks.onHouse({ id: this.uuid(), micro, wallet: acct.wallet, name: acct.name, label: this.label, why });
    } catch (e) {
      this.log.error('[AG] HOUSE CRITICAL hook threw, ' + micro + ' micro of ' + acct.wallet + ' (' + why + '): ' +
        (e && e.message));
    }
  }

  // The socket went (design 3.4 beginGrace): an unconfirmed seat is refunded at once; a confirmed one keeps playing
  // without a socket for DISCONNECT_GRACE_MS (its cells keep their last target), then goes dormant (still, edible).
  beginGrace(pid) {
    const acct = this.accounts.get(pid);
    if (!acct) return false;
    if (acct.state === 'unconfirmed') return this.release(pid, 'join-lost');
    if (acct.holding) this._stopHold(acct, false);
    acct.lastHoldAt = 0;
    acct.socketId = null;
    if (acct.state === 'live') {
      acct.state = 'grace';
      acct.graceUntil = this.now() + AG_MONEY.DISCONNECT_GRACE_MS.value;
    }
    return true;
  }

  // A socket takes the account back (resume key, the entry token of an unconfirmed seat, or a new token from the same
  // wallet). Grace and dormant come back live; an unconfirmed account still needs ag:ready; a frozen one cannot.
  // Returns the socket id it replaced (or null), or false when the account cannot be taken.
  resume(pid, socketId) {
    const acct = this.accounts.get(pid);
    if (!acct || acct.state === 'frozen' || typeof socketId !== 'string') return false;
    const prev = acct.socketId;
    if (acct.holding) this._stopHold(acct, false);
    acct.lastHoldAt = 0;
    if (prev !== socketId) acct.readied = null;   // the new page readies for itself
    acct.socketId = socketId;
    if (acct.state === 'grace' || acct.state === 'dormant') {
      acct.state = 'live';
      acct.graceUntil = 0;
      acct.dormantSince = 0;
      this.still.delete(pid);
    }
    return prev && prev !== socketId ? prev : null;
  }

  // The room closed after EMERGENCY_FAIL_TICKS throwing ticks (design 3.4 emergencySettle, Owen Q6): first the facts
  // no completed step returned, then every account refunded 100% of its balance, no rake (an unconfirmed one bounded
  // by what landed, as on every refund before a first input). An account whose refund throws stays open, and the
  // directory keeps the room on its settling list until its bank is empty.
  emergencySettle() {
    this._applyPending();
    let accounts = 0;
    let micro = 0;
    for (const acct of Array.from(this.accounts.values())) {
      try {
        const w = this.bank.withdraw(acct.pid);
        const got = w ? w.micro : 0;
        const unconfirmed = acct.state === 'unconfirmed';
        const { back, extra } = unconfirmed ? this._unconfirmedSplit(acct, got) : { back: got, extra: 0 };
        this._close(acct, 'refunded', { why: 'emergency', refundedMicro: back });
        accounts++;
        micro += back;
        if (back > 0) {
          try {
            this.hooks.onRefund({ wallet: acct.wallet, name: acct.name, micro: back,
              paid: unconfirmed ? acct.paid : undefined, why: 'emergency' });
          } catch (e) {
            this.log.error('[AG] EMERGENCY CRITICAL refund hook threw, owed ' + back + ' micro to ' + acct.wallet + ': ' +
              (e && e.message));
          }
        }
        this._extraToHouse(acct, extra, 'emergency-extra');
      } catch (e) {
        this.log.error('[AG] EMERGENCY settle of pid ' + acct.pid + ' failed, left open', e && e.message);
      }
    }
    this._flushBuckets(null, Infinity);
    this._breach({ kind: 'emergency', accounts, micro });
    return { accounts, micro };
  }

  // A planned restart ('shutdown', design 5.9 with Owen Q6) or a hard crash ('crash', Owen Q6): every open balance
  // becomes an owed REFUND row for the drainer to pay after the restart, 100%, no rake. Withdraw happens before the
  // row is handed back, so nothing is both paid and owed. An unconfirmed seat gets what _unconfirmedSplit gives. Each
  // row carries `key` ('agowed:' + the account's journal id): the database takes one row per key (db.recordOwedOnce),
  // and the money journal's close record carries the same key and amount, so a boot replay of a row the dying
  // process may or may not have written can never owe it twice. Returns the rows for the caller to write.
  shutdownSettle(why = 'shutdown') {
    const kind = why === 'crash' ? 'crash' : 'shutdown';
    this._applyPending();
    const rows = [];
    for (const acct of Array.from(this.accounts.values())) {
      try {
        const w = this.bank.withdraw(acct.pid);
        const got = w ? w.micro : 0;
        const state = acct.state;
        const { back, extra } = state === 'unconfirmed' ? this._unconfirmedSplit(acct, got) : { back: got, extra: 0 };
        const key = 'agowed:' + acct.jid;
        const reason = 'refund agar ' + kind + ' ' + this.label + ' ' + key;
        this._close(acct, 'refunded', { why: kind, refundedMicro: back, key, reason });
        if (back > 0) rows.push({ key, wallet: acct.wallet, name: acct.name, micro: back, reason, state });
        this._extraToHouse(acct, extra, kind + '-extra');
      } catch (e) {
        this.log.error('[AG] SHUTDOWN settle of pid ' + acct.pid + ' failed', e && e.message);
      }
    }
    this._flushBuckets(null, Infinity);
    return rows;
  }

  _applyPending() {
    let pending = null;
    try {
      pending = this.sim.takeMoneyEvents();
    } catch (e) {
      this.log.error('[AG] takeMoneyEvents threw', e && e.message);
    }
    if (pending && Array.isArray(pending.money)) for (const f of pending.money) this._applyFactSafe(f);
  }

  // The one exit (design 3.4): deletes the account, clears the shield and the freeze, flushes its collusion
  // buckets, tells the directory (onAccountClosed: the one-seat-per-wallet map, the remembered outcome) and the room
  // (onClosed: the seat, the page, the sim player). The bank account must already be closed.
  _close(acct, outcome, extra) {
    if (this.accounts.get(acct.pid) !== acct) return false;
    if (this.bank.isOpen(acct.pid)) {
      const left = this.bank.balance(acct.pid);
      if (left > 0) throw new Error('AgMoney: account ' + acct.pid + ' closed with ' + left + ' micro still in it');
      this.bank.withdraw(acct.pid);
    }
    this.accounts.delete(acct.pid);
    this.shielded.delete(acct.pid);
    this.still.delete(acct.pid);
    acct.closed = outcome;
    this.closedCount[outcome] = (this.closedCount[outcome] || 0) + 1;
    try {
      this._flushBuckets(acct.life, Infinity);
    } catch (e) {
      this.log.error('[AG] collusion flush', e && e.message);
    }
    try {
      this.hooks.onAccountClosed(acct, outcome, extra || {});
    } catch (e) {
      this.log.error('[AG] account closed hook', e && e.message);
    }
    try {
      this.onClosed(acct, outcome, extra || {});
    } catch (e) {
      this.log.error('[AG] room close hook', e && e.message);
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Collusion signals (design 8.2).

  // Every money eat lands in the bucket of (victim life, eater wallet); one record per bucket.
  _bucket(t) {
    if (!t || !(t.micro > 0)) return;
    const key = String(t.victimLife) + '|' + String(t.dstWallet);
    let b = this.buckets.get(key);
    if (!b) {
      b = { src: t.srcWallet, dst: t.dstWallet, micro: 0, openedAt: this.now(), life: t.victimLife };
      this.buckets.set(key, b);
    }
    b.micro += t.micro;
  }

  // life: flush that victim life's buckets; null: every bucket at least COLLUSION_FLUSH_MS old (now = Infinity: all).
  _flushBuckets(life, now) {
    if (!this.buckets.size) return;
    for (const [key, b] of Array.from(this.buckets)) {
      const due = life !== null ? b.life === life : now === Infinity || now - b.openedAt >= AG_MONEY.COLLUSION_FLUSH_MS.value;
      if (!due) continue;
      this.buckets.delete(key);
      if (!(b.micro > 0)) continue;
      try {
        this.hooks.onTransfer({ srcWallet: b.src, dstWallet: b.dst, micro: b.micro, label: this.label });
      } catch (e) {
        this.log.error('[AG] collusion record', e && e.message);
      }
    }
  }

  // An ejected blob of one paid player eaten by another: valued at feederBalance x blobSq / feederMassSq (the
  // feeder's size^2 sum now), tagged when both seats share an address, tallied per pair for 24 h; never money.
  _tallyFeed(f) {
    if (!f || typeof f !== 'object') return;
    const feeder = this.accounts.get(f.feeder);
    const eater = this.accounts.get(f.eater);
    if (!feeder || !eater || feeder === eater) return;
    const info = this.sim.playerInfo(f.feeder);
    let massSq = 0;
    if (info) {
      for (const id of info.cells) {
        const c = this.sim.getCell(id);
        if (c) massSq += c.size * c.size;
      }
    }
    const bal = this.bank.balance(f.feeder);
    let value = massSq > 0 && Number.isFinite(f.blobSq) && f.blobSq > 0 ? Math.floor((bal * f.blobSq) / massSq) : 0;
    if (!isMicro(value)) value = 0;
    if (value > bal) value = bal;
    const now = this.now();
    const key = feeder.wallet + '|' + eater.wallet;
    let t = this.feeds.get(key);
    if (t && now - t.firstAt >= AG_MONEY.FEED_WINDOW_MS.value) {
      this.feeds.delete(key);
      t = null;
    }
    if (!t) {
      t = { feeder: feeder.wallet, eater: eater.wallet, count: 0, micro: 0, sameIp: false, firstAt: now, lastAt: now };
      this.feeds.set(key, t);
      while (this.feeds.size > AG_MONEY.FEED_PAIRS_MAX.value) this.feeds.delete(this.feeds.keys().next().value);
    }
    t.count++;
    t.micro += value;
    t.lastAt = now;
    if (feeder.ip && feeder.ip === eater.ip) t.sameIp = true;
    try {
      this.hooks.onFeed({ feeder: feeder.wallet, eater: eater.wallet, micro: value, sameIp: t.sameIp, count: t.count,
        label: this.label });
    } catch (e) {
      this.log.error('[AG] feed hook', e && e.message);
    }
  }

  _breach(info) {
    try {
      this.hooks.onBreach(Object.assign({ lobbyType: this.label }, info));
    } catch (e) {
      this.log.error('[AG] breach hook', e && e.message);
    }
  }
}

module.exports = { AgMoney, AG_MONEY, REQUIRED_HOOKS, OPEN_STATES };
