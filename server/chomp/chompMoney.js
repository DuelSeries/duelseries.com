'use strict';
// The money of ONE paid Chomp room. Owen's rules (2026-10-25/26): buy-in = worth; a ghost catching you, or a player
// eating you with a power pellet, drops ALL your coins on the maze around you for anyone to grab; hold Q 3 s to cash
// out 90/10 while you keep moving (caught during the hold drops your coins as usual); bots never cash out; a dropped
// player follows the agar.io rule (5 s grace, then still and catchable for 3 minutes, then cashed out 90/10).
//
// It IS agar.io's money controller (server/ag/agMoney.js), reused by extension: the same accounts and states
// (unconfirmed, live, grace, dormant, frozen), the same hold, cash-out, release, grace, resume, emergency and shutdown
// exits, the same hooks, journal records and bounty-bot books (seedBot, retireBot, the Bot bank's seed). What differs
// is how money moves between players:
//   agar   an eat moves a share of the victim's balance to the eater (transferShare)
//   chomp  a death closes the victim's account into COINS on the maze tiles around it (dropCoins), and whoever steps
//          on a coin's tile takes it (collect). Coins are PaperBank floor money (server/paper/PaperBank.js), so
//          totalMicro() === inMicro - outMicro holds through every drop and pickup by construction, and the
//          solvency sum and the drain status count them (liveStakeTotal, floorWorth).
// The sim stays money-free: the room reports facts in sim order ({ t: 'drop', victim, spots, by, byName, ghost } and
// { t: 'pick', pid, k }) and afterStep applies them once per tick, after the step.
//
// Coins nobody takes (Owen 2026-10-26, "To the house"), as Paper's coins and slither's floor gold: after
// FLOOR_SWEEP_MS a person's coin goes to the house (hooks.onSweep, chomp_floor income), and at a restart or crash every
// person's coin is one money-journal floor record (hooks.onFloor, key 'chfloor:' + uuid) booked to the house at the
// next boot. Two exceptions keep the paid-bots rule (the house never earns from bots, Owen 2026-10-16): in a room a
// bounty bot has played in (botRoom), a person's coin goes back to whoever dropped it as a keyed owed row ('agowed:' +
// uuid, journaled through hooks.onOwed, the drainer pays it), and a bot's own coin always splits back: its Bot bank seed
// to the bank (onSeedBack), the players' money it held to those players. An emergency close (our fault) gives every coin
// back to its dropper.

const { AgMoney } = require('../ag/agMoney');
const { AgBank } = require('../ag/agBank');

function chosen(value, note) {
  return Object.freeze({ value, status: 'CHOSEN', note });
}
function sourced(value, note) {
  return Object.freeze({ value, status: 'SOURCED', note });
}

const CHOMP_MONEY = Object.freeze({
  HOLD_TICKS: sourced(180, 'Owen 2026-10-25: hold Q 3 s to cash out; the sim ticks 60 a second (chompRules TICK_HZ)'),
  FLOOR_SWEEP_MS: chosen(3600000, "Paper's PICKUP_SWEEP_MS: a coin nobody took within the hour leaves the maze"),
  COIN_MICRO: chosen(125000, 'one coin per $0.125 dropped, so a $0.50 seat drops 4 coins and a $1 seat 8'),
  COINS_MIN: chosen(4, 'a drop makes at least this many coins (fewer only where fewer tiles are free)'),
  COINS_MAX: chosen(16, 'and at most this many, however rich the player was'),
});

const BANK_SRC = '#botbank';   // agMoney's name for a bounty bot's seed from the owner's bot bank

// AgBank (agar's integer micro bank over PaperBank) with Chomp's coins: dropCoins splits a closing account over tiles,
// and a per-tile index finds the coins a chomper steps on.
class ChompBank extends AgBank {
  constructor(opts) {
    super(opts);
    this.byTile = new Map();   // tile key -> Set of coin ids
  }

  _index(coin) {
    let set = this.byTile.get(coin.k);
    if (!set) this.byTile.set(coin.k, (set = new Set()));
    set.add(coin.pid);
  }

  _unindex(coin) {
    const set = this.byTile.get(coin.k);
    if (!set) return;
    set.delete(coin.pid);
    if (!set.size) this.byTile.delete(coin.k);
  }

  // Closes the account into coins on `spots` ([[c, r, k], ...], the death tile first), the balance split as evenly as
  // micro allows (the first coin takes the remainder). -> the coins ([] for a zero balance), or null with nothing
  // changed when the account is not open or there is no spot to drop on.
  dropCoins(fromId, spots, now, life, perCoin, min, max) {
    const from = this.accounts.get(fromId);
    if (!from || !Array.isArray(spots) || !spots.length) return null;
    const total = from.micro;
    this.accounts.delete(fromId);
    if (!(total > 0)) return [];
    const want = Math.min(max, Math.max(min, Math.ceil(total / perCoin)));
    const n = Math.max(1, Math.min(spots.length, want, total));
    const each = Math.floor(total / n);
    const coins = [];
    for (let i = 0; i < n; i++) {
      const [c, r, k] = spots[i];
      const coin = { pid: this._allocPid(), x: c, y: r, k, micro: i === 0 ? total - each * (n - 1) : each,
        srcWallet: from.wallet, srcName: from.name, droppedAt: now, life };
      this.floor.set(coin.pid, coin);
      this._index(coin);
      coins.push(coin);
    }
    return coins;
  }

  // PaperBank.collect, plus the coin's dropper life for the collusion bucket and the tile index.
  collect(pickupId, toId) {
    const p = this.floor.get(pickupId);
    if (!p) return 0;
    const to = this.accounts.get(toId);
    if (!to || !Number.isSafeInteger(p.micro) || p.micro < 0) return -1;
    this.floor.delete(pickupId);
    this._unindex(p);
    to.micro += p.micro;
    if (p.micro > 0) {
      this.onTransfer({ srcWallet: p.srcWallet, dstWallet: to.wallet, micro: p.micro, victimLife: p.life, kind: 'pickup' });
    }
    return p.micro;
  }

  sweepPickup(pickupId) {
    const p = this.floor.get(pickupId);
    if (p) this._unindex(p);
    return super.sweepPickup(pickupId);
  }

  coinsAt(k) {
    const set = this.byTile.get(k);
    return set ? Array.from(set) : [];
  }

  hasCoinAt(k) {
    return this.byTile.has(k);
  }
}

class ChompMoney extends AgMoney {
  // opts: AgMoney's (sim, stake, label, hooks, shielded, still, now, log, tell, onClosed, uuid). The sim here is the
  // room's money view (chompRoom moneyView): alive(pid), clearToStart(pid), confirmed(pid), takeMoneyEvents().
  constructor(opts) {
    super(Object.assign({}, opts, { holdTicks: CHOMP_MONEY.HOLD_TICKS.value, holdStill: false, game: 'chomp' }));
    this.bank = new ChompBank({
      onTransfer: (t) => this._bucket(t),
      onBreach: (info) => this._breach(Object.assign({ kind: info && info.kind ? info.kind : 'ledger' }, info)),
    });
    this.coinFrom = new Map();   // coin id -> Map src -> micro: whose money a bounty bot's coin is
    this.coinEvents = [];        // for the room to send: { a: coin } added, { r: id, by } gone (by: the taker, 0 swept)
    this.botRoom = false;        // a bounty bot has played here: no person's coin ever goes to the house
  }

  seedBot(pid, micro, name) {
    super.seedBot(pid, micro, name);
    this.botRoom = true;
  }

  // ---------------------------------------------------------------------------------------------------------
  // agMoney's reads, in Chomp's terms.

  // A chomper in play (not dying, not out): the "live cell" every hold, confirm and backstop asks about.
  hasLiveCell(pid) {
    return this.sim.alive(pid) === true;
  }

  // A hold counts only once the spawn blink is over (review fix): otherwise a fresh seat could hold through its own
  // 3 s of safety and leave without ever being catchable, which Owen's "caught during the hold drops your coins" rules out.
  canHold(pid) {
    return this.sim.alive(pid) === true && this.sim.safe(pid) !== true;
  }

  // The newcomer's tile is clear of every ghost and powered player that could catch it (the room moves it to a clear
  // tile if needed, or says there is none yet).
  _clearToStart(acct) {
    return this.sim.clearToStart(acct.pid) === true;
  }

  _finishConfirm(acct) {
    const ok = super._finishConfirm(acct);
    try {
      this.sim.confirmed(acct.pid);
    } catch (e) {
      this.log.error('[CHOMP] confirm hook', e && e.message);
    }
    return ok;
  }

  coins() {
    return this.bank.pickups();
  }

  hasCoinAt(k) {
    return this.bank.hasCoinAt(k);
  }

  takeCoinEvents() {
    if (!this.coinEvents.length) return null;
    const out = this.coinEvents;
    this.coinEvents = [];
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------
  // The facts.

  _applyFact(f) {
    if (!f || typeof f !== 'object') return;
    if (f.t === 'drop') this._drop(f);
    else if (f.t === 'pick') this._pick(f);
  }

  // A paid player (or a bounty bot) was caught: its whole balance becomes coins on `spots`, and a person's account
  // closes 'eaten' (the page hears c:dead with what it lost). A chomper with no money (a free bot) drops nothing.
  _drop(f) {
    const pid = f.victim;
    const acct = this.accounts.get(pid) || null;
    const bot = acct ? null : this.bots.get(pid) || null;
    if (!acct && !bot) return;
    const micro = this.bank.balance(pid);
    const life = acct ? acct.life : this.label + ':bot:' + pid;
    const coins = this.bank.dropCoins(pid, f.spots, this.now(), life, CHOMP_MONEY.COIN_MICRO.value,
      CHOMP_MONEY.COINS_MIN.value, CHOMP_MONEY.COINS_MAX.value);
    if (coins === null) {
      // nothing moved and the account stays open: the backstop freezes it (no live chomper) for a look by hand
      this.log.error('[CHOMP] DROP refused ' + this.label + ' pid ' + pid + ' (' + micro + ' micro)');
      this._breach({ kind: 'drop-refused', micro });
      return;
    }
    for (const c of coins) this.coinEvents.push({ a: c });
    if (bot) {
      // each coin says whose money it is: players' money first, the bot bank's seed last (agMoney _takeFromBot)
      for (const c of coins) {
        const parts = this._takeFromBot(bot, c.micro);
        let sum = 0;
        for (const v of parts.values()) sum += v;
        if (sum !== c.micro) this.log.error('[CHOMP] BOT CRITICAL coin ' + c.pid + ' ' + c.micro + ' micro, sources say ' + sum);
        this.coinFrom.set(c.pid, parts);
      }
      this.bots.delete(pid);
      return;
    }
    acct.lostMicro = micro;
    this._close(acct, 'eaten', { lostMicro: micro, by: typeof f.byName === 'string' ? f.byName : '', byPid: f.by || 0,
      ghost: f.ghost === true });
  }

  // A chomper on tile k takes every coin there: a live (or grace) paid account, or a bounty bot. An unconfirmed,
  // dormant or frozen account takes nothing (it is still), nor does a chomper with no money (a free bot).
  _pick(f) {
    const pid = f.pid;
    const acct = this.accounts.get(pid) || null;
    const bot = acct ? null : this.bots.get(pid) || null;
    if (acct ? !(acct.state === 'live' || acct.state === 'grace') : !bot) return;
    for (const cid of this.bank.coinsAt(f.k)) {
      const coin = this.bank.getPickup(cid);
      if (!coin) continue;
      const src = coin.srcWallet;
      const got = this.bank.collect(cid, pid);
      if (got < 0) continue;
      this.coinEvents.push({ r: cid, by: pid });
      const cf = this.coinFrom.get(cid) || null;
      this.coinFrom.delete(cid);
      if (!(got > 0)) continue;
      if (bot) {
        // a bot holds it now: whose money it is goes with it (a bot's coin: its sources, seed included)
        if (cf) for (const [k, v] of cf) bot.from.set(k, (bot.from.get(k) || 0) + v);
        else if (src) bot.from.set(src, (bot.from.get(src) || 0) + got);
        else this.log.error('[CHOMP] BOT CRITICAL picked up ' + got + ' micro with no source (' + this.label + ')');
      } else if (cf) {
        // won by a person: in play, nothing owed back; a seed part is spent (off the bot bank's books)
        const seed = cf.get(BANK_SRC) || 0;
        if (seed > 0 && typeof this.hooks.onSeedSpent === 'function') {
          try {
            this.hooks.onSeedSpent(seed);
          } catch (e) {
            this.log.error('[CHOMP] seed spent hook', e && e.message);
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Coins nobody takes.

  // Every coin at least maxAgeMs old leaves the maze (see the header). -> the owed rows written
  sweepFloor(now, maxAgeMs = CHOMP_MONEY.FLOOR_SWEEP_MS.value) {
    const rows = [];
    for (const coin of this.bank.pickups()) {
      if (now - coin.droppedAt < maxAgeMs) continue;
      try {
        rows.push(...this._coinOut(coin.pid, 'floor', true, null));
      } catch (e) {
        this.log.error('[CHOMP] floor sweep of coin ' + coin.pid + ' threw', e && e.message);
      }
    }
    return rows;
  }

  // One coin leaves the room (see the header). why: 'floor' (the hour), 'shutdown' or 'crash' (house coins gather in
  // `house`, a Map srcWallet -> { srcWallet, srcName, micro }, for one floor record), 'emergency' (always back).
  // -> the owed rows
  _coinOut(cid, why, live, house) {
    const coin = this.bank.getPickup(cid);
    if (!coin) return [];
    const toHouse = !this.botRoom && !this.coinFrom.has(cid) && why !== 'emergency' && coin.srcWallet;
    if (!toHouse) return this._coinBack(cid, why, live);
    const s = this.bank.sweepPickup(cid);
    if (!s) return [];
    this.coinEvents.push({ r: cid, by: 0 });
    if (house) {
      const e = house.get(s.srcWallet) || { srcWallet: s.srcWallet, srcName: s.srcName || '', micro: 0 };
      e.micro += s.micro;
      house.set(s.srcWallet, e);
      return [];
    }
    try {
      this.hooks.onSweep({ sweepId: this.uuid(), micro: s.micro, srcWallet: s.srcWallet, srcName: s.srcName || '',
        label: this.label, pid: cid });
    } catch (e) {
      this.log.error('[CHOMP] SWEEP CRITICAL coin ' + cid + ' ' + s.micro + ' micro not booked (' + this.label + '): ' +
        (e && e.message));
      this._breach({ kind: 'sweep', micro: s.micro });
    }
    return [];
  }

  // One coin back to whoever it belongs to: a seed part to the bot bank, every player's part owed back to that player
  // as a keyed row (onOwed journals it; live: written now). -> the rows
  _coinBack(cid, why, live) {
    const s = this.bank.sweepPickup(cid);
    if (!s) return [];
    this.coinEvents.push({ r: cid, by: 0 });
    const cf = this.coinFrom.get(cid) || null;
    this.coinFrom.delete(cid);
    const parts = cf || new Map([[s.srcWallet, s.micro]]);
    const rows = [];
    let sum = 0;
    for (const [src, micro] of parts) {
      if (!(micro > 0)) continue;
      sum += micro;
      if (src === BANK_SRC) {
        try {
          this.hooks.onSeedBack(micro, String(why || ''), this.label, live);
        } catch (e) {
          this.log.error('[CHOMP] SEEDBACK CRITICAL ' + micro + ' micro not returned to the bot bank (' + this.label + '): ' +
            (e && e.message));
          this._breach({ kind: 'seedback', micro });
        }
        continue;
      }
      if (typeof src !== 'string' || !src) {
        this._breach({ kind: 'coin-source', micro });
        this._toHouse({ wallet: null, name: '' }, micro, 'coin-no-source');
        continue;
      }
      const key = 'agowed:' + this.uuid();
      const reason = 'refund chomp floor ' + String(why || '') + ' ' + this.label + ' ' + key;
      const row = { key, wallet: src, name: src === s.srcWallet ? s.srcName || '' : '', micro, reason };
      try {
        this.hooks.onOwed(row, live);
      } catch (e) {
        this.log.error('[CHOMP] OWED CRITICAL coin ' + key + ' ' + micro + ' micro to ' + src + ': ' + (e && e.message));
        this._breach({ kind: 'owed', micro });
      }
      rows.push(row);
    }
    if (sum !== s.micro) {
      // a bot coin whose sources do not add up (a bug): the gap is nobody's known money, booked for a look by hand
      const gap = s.micro - sum;
      this.log.error('[CHOMP] COIN CRITICAL ' + cid + ' ' + s.micro + ' micro, sources ' + sum);
      this._breach({ kind: 'coin-sources', micro: gap });
      if (gap > 0) this._toHouse({ wallet: s.srcWallet, name: s.srcName }, gap, 'coin-gap');
    }
    return rows;
  }

  // agMoney's exits, then every coin on the maze: back to its owners (rows), or the house's in one floor record that
  // the next boot books (a record the journal cannot take is logged with its amount; the money stays in escrow,
  // unbooked, as Paper's).
  shutdownSettle(why = 'shutdown') {
    const kind = why === 'crash' ? 'crash' : 'shutdown';
    const rows = super.shutdownSettle(why);
    const house = new Map();
    for (const coin of this.bank.pickups()) {
      try {
        rows.push(...this._coinOut(coin.pid, kind, false, house));
      } catch (e) {
        this.log.error('[CHOMP] SHUTDOWN coin ' + coin.pid + ' not settled', e && e.message);
      }
    }
    if (house.size) {
      const bySource = Array.from(house.values());
      const micro = bySource.reduce((t, x) => t + x.micro, 0);
      const rec = { key: 'chfloor:' + this.uuid(), why: kind, micro, bySource };
      try {
        this.hooks.onFloor(rec);
        this.log.warn('[CHOMP] SHUTDOWN-FLOOR ' + micro + ' micro ' + this.label + ' ' + rec.key + ' (booked at the next boot)');
      } catch (e) {
        this.log.error('[CHOMP] SHUTDOWN-FLOOR CRITICAL ' + micro + ' micro ' + this.label + ' not journaled, it stays in ' +
          'escrow unbooked: ' + (e && e.message));
      }
    }
    return rows;
  }

  emergencySettle() {
    const r = super.emergencySettle();
    return Object.assign({ coins: this.emergencyCoins() }, r);
  }

  // Every coin back to its dropper (an emergency close, and the directory's retry of a settling room). -> coins settled
  emergencyCoins() {
    let coins = 0;
    for (const coin of this.bank.pickups()) {
      try {
        this._coinBack(coin.pid, 'emergency', true);
        coins++;
      } catch (e) {
        this.log.error('[CHOMP] EMERGENCY coin ' + coin.pid + ' not settled', e && e.message);
      }
    }
    return coins;
  }
}

module.exports = { ChompMoney, ChompBank, CHOMP_MONEY, BANK_SRC };
