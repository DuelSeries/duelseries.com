'use strict';
// All the money inside one Paper arena, in integer micro-USDC (design 5.1). Pure: no imports,
// no clock, no sockets. Only deposit, withdraw and sweepPickup change the arena total; every
// other operation moves money between accounts and floor coins, so
//     totalMicro() === inMicro - outMicro
// holds by construction, and withdraw is capped at inMicro - outMicro so an arena can never
// pay out more than it took in, whatever bug exists elsewhere. Closed accounts are deleted, so
// "0 for unknown or closed" holds by absence and a wrapped unit id can open a fresh account.

const PICKUP_ID_MAX = 65535; // pickup ids ride the wire as u16; 0 means "none"

function isMicro(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

class PaperBank {
  constructor({ onTransfer, onBreach } = {}) {
    this.onTransfer = typeof onTransfer === 'function' ? onTransfer : () => {};
    this.onBreach = typeof onBreach === 'function' ? onBreach : () => {};
    this.accounts = new Map(); // unitId -> { micro, wallet, name }
    this.floor = new Map(); // pid -> { pid, x, y, micro, srcWallet, srcName, droppedAt }, creation order
    this.ledger = { inMicro: 0, outMicro: 0 };
    this.nextPid = 1;
    this.breached = false;
  }

  deposit(unitId, micro, wallet, name) {
    if (!Number.isSafeInteger(unitId) || unitId <= 0) throw new Error('PaperBank.deposit: bad unit id ' + unitId);
    if (!isMicro(micro)) throw new Error('PaperBank.deposit: micro must be a non-negative integer, got ' + micro);
    if (this.accounts.has(unitId)) throw new Error('PaperBank.deposit: account ' + unitId + ' is already open');
    this.accounts.set(unitId, { micro, wallet: wallet || null, name: name || '' });
    this.ledger.inMicro += micro;
    return micro;
  }

  isOpen(unitId) {
    return this.accounts.has(unitId);
  }

  balance(unitId) {
    const a = this.accounts.get(unitId);
    return a ? a.micro : 0;
  }

  // Killer takes ALL (brief rule 2). -1 and nothing moves when `to` is not open (or is `from`).
  transferAll(fromId, toId) {
    const to = this.accounts.get(toId);
    if (!to || fromId === toId) return -1;
    const from = this.accounts.get(fromId);
    if (!from) return 0;
    this.accounts.delete(fromId);
    to.micro += from.micro;
    if (from.micro > 0) {
      this.onTransfer({ srcWallet: from.wallet, dstWallet: to.wallet, micro: from.micro, kind: 'kill' });
    }
    return from.micro;
  }

  // Closes the account; its money becomes a floor coin. Null when there was nothing to drop.
  drop(fromId, x, y, now) {
    const from = this.accounts.get(fromId);
    if (!from) return null;
    this.accounts.delete(fromId);
    if (from.micro <= 0) return null;
    const pickup = {
      pid: this._allocPid(),
      x,
      y,
      micro: from.micro,
      srcWallet: from.wallet,
      srcName: from.name,
      droppedAt: now
    };
    this.floor.set(pickup.pid, pickup);
    return pickup;
  }

  // 0 when the coin is gone; -1 and nothing moves when `to` is not open.
  collect(pickupId, toId) {
    const p = this.floor.get(pickupId);
    if (!p) return 0;
    const to = this.accounts.get(toId);
    if (!to) return -1;
    this.floor.delete(pickupId);
    to.micro += p.micro;
    this.onTransfer({ srcWallet: p.srcWallet, dstWallet: to.wallet, micro: p.micro, kind: 'pickup' });
    return p.micro;
  }

  // The one way money leaves to a player. Null when the account is not open.
  withdraw(unitId) {
    const a = this.accounts.get(unitId);
    if (!a) return null;
    this.accounts.delete(unitId);
    const micro = this._capToArena(a.micro, 'withdraw', unitId);
    this.ledger.outMicro += micro;
    return { micro, wallet: a.wallet, name: a.name };
  }

  // A coin nobody collected within the hour leaves the arena to the house (owner decision 1).
  sweepPickup(pickupId) {
    const p = this.floor.get(pickupId);
    if (!p) return null;
    this.floor.delete(pickupId);
    const micro = this._capToArena(p.micro, 'sweep', pickupId);
    this.ledger.outMicro += micro;
    return { micro, srcWallet: p.srcWallet, srcName: p.srcName };
  }

  movePickup(pickupId, x, y) {
    const p = this.floor.get(pickupId);
    if (!p) return false;
    p.x = x;
    p.y = y;
    return true;
  }

  getPickup(pickupId) {
    return this.floor.get(pickupId) || null;
  }

  pickups() {
    return Array.from(this.floor.values());
  }

  openIds() {
    return Array.from(this.accounts.keys());
  }

  accountsMicro() {
    let sum = 0;
    for (const a of this.accounts.values()) sum += a.micro;
    return sum;
  }

  floorMicro() {
    let sum = 0;
    for (const p of this.floor.values()) sum += p.micro;
    return sum;
  }

  totalMicro() {
    return this.accountsMicro() + this.floorMicro();
  }

  // Never throws: a breach is reported ONCE with the numbers and the arena keeps running.
  assertConserved() {
    const total = this.totalMicro();
    const expected = this.ledger.inMicro - this.ledger.outMicro;
    if (total === expected) return true;
    if (!this.breached) {
      this.breached = true;
      this.onBreach({ totalMicro: total, inMicro: this.ledger.inMicro, outMicro: this.ledger.outMicro });
    }
    return false;
  }

  // Ceiling: nothing leaves beyond what the arena holds by the ledger.
  _capToArena(micro, op, id) {
    const room = this.ledger.inMicro - this.ledger.outMicro;
    if (micro <= room) return micro;
    if (!this.breached) {
      this.breached = true;
      this.onBreach({ op, id, micro, ceiling: room, inMicro: this.ledger.inMicro, outMicro: this.ledger.outMicro });
    }
    return room > 0 ? room : 0;
  }

  _allocPid() {
    for (let tries = 0; tries < PICKUP_ID_MAX; tries++) {
      const pid = this.nextPid;
      this.nextPid = pid >= PICKUP_ID_MAX ? 1 : pid + 1;
      if (!this.floor.has(pid)) return pid;
    }
    throw new Error('PaperBank: no free pickup id');
  }
}

PaperBank.PICKUP_ID_MAX = PICKUP_ID_MAX;

module.exports = PaperBank;
