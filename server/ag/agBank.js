'use strict';
// All the money inside one paid agar.io room, in integer micro-USDC (PAID-AGAR-DESIGN.md 3.2). PaperBank
// (server/paper/PaperBank.js) is reused as it is, untouched, so Paper's live path carries no risk: deposit, withdraw,
// withdrawUpTo, assertConserved and the arena ceiling. AgBank adds the one agar move, transferShare (Owen Q4 / design
// Q20: money is spread over a player's cells by size, built as share-at-eat), and a ceiling that refuses anything
// that is not a whole number of micro.
//
// One account per paid player (the sim player id is the account id). Every account's money is its player's money
// whatever its cells do: split, merge, pop, decay, the 16-cell cap trim and eject never touch it (design 3.3). Only a
// player cell eating another player's cell moves money, and then by the eaten cell's share of that moment:
//     micro = floor(balance(victim) * eatenSq / victimSq)        (victimSq = sum of size^2 over the victim's cells)
// and the victim's last cell moves the whole remainder, so rounding never strands a micro (design Q21).

const PaperBank = require('../paper/PaperBank');

function isMicro(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

class AgBank extends PaperBank {
  constructor(opts) {
    super(opts);
    this.refusedOnce = false;   // a refused share is reported once per room, like PaperBank's breach latch
  }

  _refuse(info) {
    if (!this.refusedOnce) {
      this.refusedOnce = true;
      try {
        this.onBreach(Object.assign({ kind: 'share-refused' }, info));
      } catch (e) { /* the refusal itself is what protects the money */ }
    }
    return -1;
  }

  // -> micro moved (0 or more), or -1 when refused (nothing moves, onBreach once per room).
  // last: the eaten cell was the victim's only live cell: the whole balance moves and the victim's account closes.
  // victimLife: the victim account's life id, carried to onTransfer for the collusion buckets (design 8.2).
  transferShare(fromId, toId, eatenSq, victimSq, last, victimLife) {
    const from = this.accounts.get(fromId);
    const to = this.accounts.get(toId);
    if (!from || !to || fromId === toId) {
      return this._refuse({ op: 'transferShare', why: 'account', from: fromId, to: toId });
    }
    const isLast = last === true;
    if (!isLast) {
      const okSq = typeof eatenSq === 'number' && typeof victimSq === 'number' && Number.isFinite(eatenSq) &&
        Number.isFinite(victimSq) && eatenSq > 0 && eatenSq <= victimSq;
      if (!okSq) return this._refuse({ op: 'transferShare', why: 'sizes', from: fromId, to: toId, eatenSq, victimSq });
    }
    const micro = isLast ? from.micro : Math.floor((from.micro * eatenSq) / victimSq);
    if (!Number.isSafeInteger(micro) || micro < 0 || micro > from.micro) {
      return this._refuse({ op: 'transferShare', why: 'amount', from: fromId, to: toId, micro });
    }
    from.micro -= micro;
    to.micro += micro;
    if (isLast) this.accounts.delete(fromId);
    if (micro > 0) {
      this.onTransfer({ srcWallet: from.wallet, dstWallet: to.wallet, micro, victimLife, kind: 'eat' });
    }
    return micro;
  }

  // The ceiling, NaN-proof (design 3.2): PaperBank's version returns the whole room for any value that is not
  // `<= room`, and NaN <= room is false, so a single NaN would pay the room out. Anything that is not a whole
  // number of micro, 0 or more, leaves nothing and is reported once.
  _capToArena(micro, op, id) {
    if (!isMicro(micro)) {
      if (!this.breached) {
        this.breached = true;
        try {
          this.onBreach({ op, id, micro: String(micro), why: 'not-micro', inMicro: this.ledger.inMicro,
            outMicro: this.ledger.outMicro });
        } catch (e) { /* refusing is what matters */ }
      }
      return 0;
    }
    return super._capToArena(micro, op, id);
  }
}

module.exports = { AgBank };
