'use strict';
// All the money inside ONE paid sl room, in integer micro-USDC (PAID-SL-DESIGN.md section 8, MONEY INVARIANTS 2, 3
// and 5). Pure: no requires, no clock, no sockets, no sim. Not built on PaperBank: its ceiling returns the whole room
// for a NaN, and its floor ids are u16 with one coin per dropped account, which does not fit up to 861 pellets a death.
//
// Money sits in exactly two places:
//   accounts  Map snake id -> { snakeId, micro, deposit, ...what the controller opened it with (wallet, name, jid) }
//             one per live paid snake; the account is the snake's whole worth
//   floor     Map food OBJECT -> { micro, srcWallet, srcName, srcJid }, one per cash pellet on the grid
// The floor is keyed by the food object the sim made, never its cell id: a cell freed by an eat can be taken again by a
// later drop in the same step (slFood.js freeCell), and object identity never collides. Every account and pellet is
// frozen, so no object the bank hands out can change the money: a credit puts a new account in the eater's place
// (read balances through account() or balance(), never a kept object), and the controller keeps its own per-snake
// state in its own map.
//
// Counters: ledger { in, outCash, outRefund, outHouse } only ever grow; house { swept, abandoned, breach } splits
// outHouse by why; sums { acc, floor } are the running totals the checker recomputes (I2). EVERY operation keeps
//     acc + floor + outCash + outRefund + outHouse == in                                         (the checker's I1)
// by itself: it checks every amount it reads or will write with isMicro BEFORE it changes anything, throws on a bad
// argument with nothing changed, then changes everything or nothing. The out counters move in one place only,
// bookOut, always in the same operation that took the same micro out of an account or the floor; there is no public
// way to book money out that did not leave, or to take money out without booking it.
//
//   deposit(id, micro, info)   in, acc += micro                        a consumed token's worth (the door, step 11)
//   split(id, foods, shares)   acc -= M; floor += M over the pellets   a death (shares from slSplit.planSplit); with no
//                                                                      food at all the M goes to the house as a breach
//   credit(food, eaterId)      floor -= m; eater += m                  an eat; 0 not a pellet, -1 eater has no account
//   withdraw(id, kind)         acc -= m; outCash or outRefund += m     a cash-out ('cash', gross) or a 100% refund
//   takeFloor(kind)            floor -> outHouse                       'swept' (idle retire, emergency) or 'abandoned'
//                                                                      (shutdown and crash: logged, stays in escrow)
//   toSuspense(food)           floor -> outHouse breach                a pellet eaten by a snake with no account
//
// The ceiling (MONEY INVARIANT 3), checked by every out move before it changes anything: money leaves only while it
// fits in in - out, the room's total by the ledger, AND the room's accounts and pellets, walked, hold no more than
// that. A move whose own micro fits is still refused while anything else is inflated: the room cannot tell which
// account is wrong, and paying any of them while the room holds more than the ledger says could hand one player
// another's money. So it is refused like a bad argument (nothing changed, the money stays in the room and in escrow)
// and onBreach is told every time; agAlert's rate limit dedupes the push. While I1 and I2 hold it never binds.

function isMicro(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function isSnakeId(id) {
  return Number.isSafeInteger(id) && id > 0;
}

function refuse(op, why) {
  throw new Error('slBank.' + op + ': ' + why);
}

function newStep() {
  // Per-step tallies for the checker's I8 (beginStep resets them): micro taken off the floor by eats, credited to
  // eaters, sent to the house by eats with no account; dead accounts' micro, placed as pellets, unplaced.
  return { taken: 0, credited: 0, suspended: 0, dead: 0, splitIn: 0, unplaced: 0 };
}

const HOUSE_KINDS = Object.freeze(['swept', 'abandoned', 'breach']);

// What the room's accounts and pellets hold, walked (not the running sums); NaN when any of them is not a whole number
// of micro, so a corrupted one never passes the ceiling.
function heldMicro(bank) {
  let held = 0;
  for (const a of bank.accounts.values()) held = isMicro(a.micro) ? held + a.micro : NaN;
  for (const p of bank.floor.values()) held = isMicro(p.micro) ? held + p.micro : NaN;
  return held;
}

// The ceiling (header), before an out move changes anything: `micro` is what it will take out of an account or the
// floor, which still hold it. Refuses, and tells onBreach, when the room holds more than the ledger says.
function checkCeiling(bank, op, id, micro) {
  const room = bank.roomMicro();
  const held = heldMicro(bank);
  if (isMicro(room) && isMicro(held) && held <= room && micro <= room) return;
  bank._breach({ why: 'ceiling', op, id, micro, held, ceiling: room });
  refuse(op, 'the ceiling: ' + micro + ' out while the accounts and floor hold ' + String(held) + ' and the ledger ' +
    String(room));
}

// The one place an out counter moves, after checkCeiling passed for the same micro in the same operation, which has
// already taken it out of an account or the floor.
function bookOut(bank, kind, micro) {
  const l = bank.ledger;
  if (kind === 'cash') l.outCash += micro;
  else if (kind === 'refund') l.outRefund += micro;
  else {
    bank.house[kind] += micro;
    l.outHouse += micro;
  }
}

class SlBank {
  // onBreach(info): an out move was refused at the ceiling (every time). onTransfer({ srcWallet, dstWallet, micro,
  // srcJid, eater, kind }): after each credit, for the collusion buckets. Both are guarded: a throwing hook never
  // undoes a move or a refusal.
  constructor({ onBreach, onTransfer } = {}) {
    this.onBreach = typeof onBreach === 'function' ? onBreach : () => {};
    this.onTransfer = typeof onTransfer === 'function' ? onTransfer : () => {};
    this.accounts = new Map(); // snake id -> account (open only, frozen)
    this.floor = new Map(); // food object -> pellet (frozen), in placement order
    this.ledger = { in: 0, outCash: 0, outRefund: 0, outHouse: 0 };
    this.house = { swept: 0, abandoned: 0, breach: 0 }; // outHouse by why
    this.sums = { acc: 0, floor: 0 };
    this.step = newStep();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Reads.

  account(snakeId) {
    return this.accounts.get(snakeId) || null;
  }

  isOpen(snakeId) {
    return this.accounts.has(snakeId);
  }

  balance(snakeId) {
    const a = this.accounts.get(snakeId);
    return a ? a.micro : 0;
  }

  pellet(food) {
    return this.floor.get(food) || null;
  }

  isPellet(food) {
    return this.floor.has(food);
  }

  openIds() {
    return Array.from(this.accounts.keys());
  }

  openCount() {
    return this.accounts.size;
  }

  pelletCount() {
    return this.floor.size;
  }

  accountsMicro() {
    return this.sums.acc;
  }

  floorMicro() {
    return this.sums.floor;
  }

  // What is still inside the room: every account plus every pellet.
  totalMicro() {
    return this.sums.acc + this.sums.floor;
  }

  outMicro() {
    const l = this.ledger;
    return l.outCash + l.outRefund + l.outHouse;
  }

  // The room's total by the ledger (in - out): the ceiling of every out move.
  roomMicro() {
    return this.ledger.in - this.outMicro();
  }

  // The sums recomputed from the maps (the checker's I2; walks every account and pellet).
  recount() {
    let acc = 0;
    let floor = 0;
    for (const a of this.accounts.values()) acc += a.micro;
    for (const p of this.floor.values()) floor += p.micro;
    return { acc, floor };
  }

  // A plain copy of every counter (soak, proof, logs).
  totals() {
    return Object.assign({}, this.ledger, { acc: this.sums.acc, floor: this.sums.floor, house: Object.assign({}, this.house),
      accounts: this.accounts.size, pellets: this.floor.size });
  }

  // Resets the per-step tallies; the controller calls it before it applies a step's facts.
  beginStep() {
    this.step = newStep();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Moves. Each checks first and throws with nothing changed; then changes everything it says or nothing.

  // A paid snake's account opens with the worth of its consumed token. info: what the controller keeps on the account
  // (wallet, name, jid, ...); snakeId, micro and deposit are the bank's own and always win. Returns the account
  // (frozen).
  deposit(snakeId, micro, info) {
    if (!isSnakeId(snakeId)) refuse('deposit', 'bad snake id ' + String(snakeId));
    if (!isMicro(micro) || micro < 1) refuse('deposit', 'micro must be a whole number >= 1, got ' + String(micro));
    if (info !== undefined && info !== null && (typeof info !== 'object' || Array.isArray(info))) {
      refuse('deposit', 'info must be an object');
    }
    if (this.accounts.has(snakeId)) refuse('deposit', 'account ' + snakeId + ' is already open');
    const nextIn = this.ledger.in + micro;
    const nextAcc = this.sums.acc + micro;
    if (!isMicro(nextIn) || !isMicro(nextAcc)) refuse('deposit', 'the room total would leave the safe integers');
    const acct = Object.freeze(Object.assign({}, info || null, { snakeId, micro, deposit: micro }));
    this.accounts.set(snakeId, acct);
    this.ledger.in = nextIn;
    this.sums.acc = nextAcc;
    return acct;
  }

  // A death: the account closes and its whole micro M becomes pellets, foods[i] holding shares[i] (slSplit.planSplit
  // makes both: every share >= 1, sum == M, checked here again). No food at all: M goes to the house as a breach
  // (unplaced; the controller raises the slither_breach incident). null when the snake has no account (nothing moves).
  // -> { micro: M, placed, unplaced, pellets, acct }
  split(snakeId, foods, shares) {
    const acct = this.accounts.get(snakeId);
    if (!acct) return null;
    if (!Array.isArray(foods) || !Array.isArray(shares) || foods.length !== shares.length) {
      refuse('split', 'foods and shares must be arrays of one length');
    }
    const M = acct.micro;
    if (!isMicro(M)) refuse('split', 'account ' + snakeId + ' holds ' + String(M));
    const seen = new Set();
    let sum = 0;
    for (let i = 0; i < foods.length; i++) {
      const f = foods[i];
      if (!f || typeof f !== 'object') refuse('split', 'food ' + i + ' is not a food object');
      if (seen.has(f) || this.floor.has(f)) refuse('split', 'food ' + i + ' already holds cash');
      seen.add(f);
      if (!isMicro(shares[i]) || shares[i] < 1) refuse('split', 'share ' + i + ' must be a whole number >= 1, got ' + String(shares[i]));
      sum += shares[i];
    }
    if (foods.length > 0 && sum !== M) refuse('split', 'shares sum to ' + sum + ', the account holds ' + M);
    const unplaced = foods.length === 0 ? M : 0;
    if (unplaced > 0) checkCeiling(this, 'split', snakeId, unplaced);
    this.accounts.delete(snakeId);
    this.sums.acc -= M;
    const src = { srcWallet: acct.wallet || null, srcName: acct.name || '', srcJid: acct.jid || null };
    for (let i = 0; i < foods.length; i++) {
      this.floor.set(foods[i], Object.freeze({ micro: shares[i], srcWallet: src.srcWallet, srcName: src.srcName,
        srcJid: src.srcJid }));
    }
    this.sums.floor += sum;
    if (unplaced > 0) bookOut(this, 'breach', unplaced);
    this.step.dead += M;
    this.step.splitIn += sum;
    this.step.unplaced += unplaced;
    return { micro: M, placed: sum, unplaced, pellets: foods.length, acct };
  }

  // An eat: the pellet's micro moves to the eater's account, once (the pellet is deleted; a new frozen account takes
  // the eater's place). 0 when the food is not a pellet (natural food, a boost crumb, a replayed eat); -1 when it is
  // but the eater has no account, and nothing moves (the controller sends that pellet to toSuspense).
  credit(food, eaterId) {
    const pel = this.floor.get(food);
    if (!pel) return 0;
    const to = this.accounts.get(eaterId);
    if (!to) return -1;
    const m = pel.micro;
    if (!isMicro(m) || m < 1) refuse('credit', 'the pellet holds ' + String(m));
    if (!isMicro(to.micro)) refuse('credit', 'account ' + eaterId + ' holds ' + String(to.micro));
    const before = to.micro;
    const next = before + m;
    if (!isMicro(next)) refuse('credit', 'account ' + eaterId + ' would leave the safe integers');
    this.floor.delete(food);
    this.sums.floor -= m;
    this.accounts.set(eaterId, Object.freeze(Object.assign({}, to, { micro: next })));
    this.sums.acc += m;
    this.step.taken += m;
    this.step.credited += next - before;
    try {
      this.onTransfer({ srcWallet: pel.srcWallet, dstWallet: to.wallet || null, micro: m, srcJid: pel.srcJid,
        eater: eaterId, kind: 'eat' });
    } catch (e) { /* the collusion record is advice; the move stands */ }
    return m;
  }

  // The one way an account's money leaves the room to a player: kind 'cash' (a cash-out, the whole account is the
  // gross; the payout splits 90/10) or 'refund' (shutdown, crash, emergency, orphan: 100% of the current balance, no
  // rake). The account closes. null when it is not open. Refused at the ceiling (header). -> { micro, acct }
  withdraw(snakeId, kind) {
    if (kind !== 'cash' && kind !== 'refund') refuse('withdraw', 'kind must be cash or refund, got ' + String(kind));
    const acct = this.accounts.get(snakeId);
    if (!acct) return null;
    const m = acct.micro;
    if (!isMicro(m)) refuse('withdraw', 'account ' + snakeId + ' holds ' + String(m));
    checkCeiling(this, 'withdraw', snakeId, m);
    this.accounts.delete(snakeId);
    this.sums.acc -= m;
    bookOut(this, kind, m);
    return { micro: m, acct };
  }

  // Every pellet leaves to the house: kind 'swept' (idle retire, emergency close: the controller sends each source's
  // micro through sweepFloor) or 'abandoned' (shutdown and crash: booked and logged, the money stays in escrow).
  // Refused at the ceiling (header), so bySource always adds up to the micro booked.
  // -> { micro, count, bySource: [{ srcWallet, srcName, micro, count }] in first-drop order }
  takeFloor(kind) {
    // 'returned': a room bots played in gives its floor back to the players who dropped it (slMoney _returnFloor),
    // booked as a refund, never the house
    if (kind !== 'swept' && kind !== 'abandoned' && kind !== 'returned') {
      refuse('takeFloor', 'kind must be swept, abandoned or returned, got ' + String(kind));
    }
    let total = 0;
    const by = new Map();
    for (const p of this.floor.values()) {
      if (!isMicro(p.micro) || p.micro < 1) refuse('takeFloor', 'a pellet holds ' + String(p.micro));
      total += p.micro;
      const k = p.srcWallet === null || p.srcWallet === undefined ? '' : String(p.srcWallet);
      let s = by.get(k);
      if (!s) {
        s = { srcWallet: p.srcWallet === undefined ? null : p.srcWallet, srcName: p.srcName || '', micro: 0, count: 0 };
        by.set(k, s);
      }
      s.micro += p.micro;
      s.count++;
    }
    if (!isMicro(total)) refuse('takeFloor', 'the floor total leaves the safe integers');
    const count = this.floor.size;
    if (count > 0) checkCeiling(this, 'takeFloor', kind, total);
    this.floor.clear();
    this.sums.floor -= total;
    if (count > 0) bookOut(this, kind === 'returned' ? 'refund' : kind, total);
    return { micro: total, count, bySource: Array.from(by.values()) };
  }

  // A pellet eaten by a snake with no account (impossible with no bots in a paid room): it goes to the house as a
  // breach, never lost, never credited. 0 when the food is not a pellet. Refused at the ceiling (header). -> the micro
  toSuspense(food) {
    const pel = this.floor.get(food);
    if (!pel) return 0;
    const m = pel.micro;
    if (!isMicro(m) || m < 1) refuse('toSuspense', 'the pellet holds ' + String(m));
    checkCeiling(this, 'toSuspense', food.id, m);
    this.floor.delete(food);
    this.sums.floor -= m;
    this.step.taken += m;
    this.step.suspended += m;
    bookOut(this, 'breach', m);
    return m;
  }

  // ---------------------------------------------------------------------------------------------------------------

  _breach(info) {
    try {
      this.onBreach(Object.assign({ kind: 'bank', inMicro: this.ledger.in, outMicro: this.outMicro() }, info));
    } catch (e) { /* refusing is what protects the money */ }
  }
}

module.exports = { SlBank, isMicro, HOUSE_KINDS };
