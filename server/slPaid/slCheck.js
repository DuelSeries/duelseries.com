'use strict';
// Paid slither: the money invariant checker (PAID-SL-DESIGN.md section 8 and MONEY INVARIANTS). Pure: it reads a room
// and returns what is wrong. It never changes money, never logs and never throws (an internal fault comes back as a
// `check` violation). The controller runs the cheap checks after every step and the full ones every
// CHECK_EVERY_STEPS steps in production (every step in tests, the soak and the proof), and acts on the result:
// alert (agAlert: one per room per kind per 10 min), taint the room on I1, I10 and I13, refund an I4 orphan 100%.
//
// checkRoom(room, { full, K, step, walletSeat }) -> [{ kind, detail }], empty when healthy
//   room        an SlRoom with its controller ({ money: { bank }, sim, humans, laws }), or { bank, sim, humans }
//   full        also run the walks over every account, pellet and food (I2 to I7, I9, I13)
//   K           checkLaws(laws); default checkLaws(room.laws)
//   step        the step tallies for I8; default bank.step (reset by bank.beginStep before each step's facts)
//   walletSeat  the directory's Map wallet -> { room, snakeId }; with it (full only) I9 is checked for this room
// Run it after a step's facts are applied and before the next sim step: I8 reads that step's eats and deaths from
// the sim itself (sim.food.tick.eats, sim.lastLog().deaths), so they are the facts the controller was handed.
//
//   cheap  I1   acc + floor + outCash + outRefund + outHouse == in, every counter a safe integer >= 0
//          I8   this step's facts were all applied: no food the sim ate is still a pellet, no snake that died still
//               has an account (a skipped fact shows the same step, not 23 steps later as I5 or I4); and the bank's
//               own tallies agree: credited + suspended == taken off the floor; placed == dead micro - unplaced
//          I10  live human snakes <= C_PAID_HUMAN_CAP (the owner's bots are on top; the paid border is pinned at C_R_MIN
//               by the room, so no snake count moves it, design 1)
//   full   I2   the running sums equal the sums recomputed from the maps; house kinds add up to outHouse
//          I3   every account micro >= its deposit and > 0 (a live paid snake never loses money)
//          I4   every open account's snake is alive in the sim (production: refunded 100% through the owed lane)
//          I5   every pellet's food is on the grid (sim.food.get(id) === food), not natural, rad byte >= C_PAID_CASH_BYTE
//          I6   every food with rad byte >= C_PAID_CASH_BYTE is a pellet (no gold without cash)
//          I7   every pellet holds >= 1 micro and lies inside flux - C_PAID_DROP_INSET (plus two food cells, below)
//          I9   walletSeat agrees with this room's accounts
//          I13  every live human snake has an account (the inverse of I4)
// Ledger-wide helpers for the soak and the proof: checkWalletSeats (I9 across rooms, one account per wallet),
// checkJournal (I11) and checkLedger (I12), plus sumBanks.
//
// Details carry snake ids, jids, food ids and amounts, never a wallet: they can reach the owner's phone.

const { assertLawsComplete } = require('../sl/slLaws');

const CHECK_LAW_IDS = Object.freeze(['L1', 'L2.size', 'C_PAID_HUMAN_CAP', 'C_PAID_DROP_INSET', 'C_PAID_CASH_BYTE']);
// A food sits at the corner of its cell (slGrid foodX floors the position into one of 256 cells per sector side),
// which is under one cell diagonal from the drop, and a drop whose cell is taken goes to the nearest free cell
// (C_DROP_CELL, slFood freeCell), first the ring of eight around it: one more cell diagonal at most. So a drop pulled
// onto the flux - inset circle can sit up to two cell diagonals past it (3.31 units; 3.19 measured around the whole
// circle with the four sides taken), and I7 allows exactly that. A drop pushed farther (its whole 3 x 3 block, or
// every cell of the block inside its sector, already taken) is reported: legit placement, but gold piled up at the
// border.
const CELLS_PER_SECTOR = 256;
const SLACK_CELLS = 2;
// Pellet and food walks (I5, I6, I7) list at most this many violations of a kind, then one { more } entry, so a
// broken room cannot make a list of thousands every check. Account-level kinds are bounded by the accounts.
const PER_KIND_MAX = 32;

function isMicro(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

const lawCache = new WeakMap();

// The numbers the checker reads, from a law table (cached per table).
function checkLaws(laws) {
  if (laws && typeof laws === 'object' && lawCache.has(laws)) return lawCache.get(laws);
  assertLawsComplete(laws, CHECK_LAW_IDS);
  const v = (id) => laws[id].value;
  const cashByte = v('C_PAID_CASH_BYTE');
  const inset = v('C_PAID_DROP_INSET');
  const humanCap = v('C_PAID_HUMAN_CAP');
  const grd = v('L1');
  const sector = v('L2.size');
  if (!Number.isInteger(cashByte) || cashByte < 1 || cashByte > 255) throw new Error('slCheck: C_PAID_CASH_BYTE must be a byte 1..255');
  if (typeof inset !== 'number' || !Number.isFinite(inset) || inset < 0) throw new Error('slCheck: C_PAID_DROP_INSET must be >= 0');
  if (!Number.isInteger(humanCap) || humanCap < 1) throw new Error('slCheck: C_PAID_HUMAN_CAP must be an integer >= 1');
  if (typeof grd !== 'number' || !(grd > 0) || typeof sector !== 'number' || !(sector > 0)) {
    throw new Error('slCheck: L1 and L2.size must be positive');
  }
  const slack = SLACK_CELLS * (sector / CELLS_PER_SECTOR) * Math.SQRT2;
  const K = Object.freeze({ cashByte, inset, humanCap, grd, slack });
  lawCache.set(laws, K);
  return K;
}

function bankOf(room) {
  if (!room) return null;
  if (room.money && room.money.bank) return room.money.bank;
  return room.bank || null;
}

function violation(kind, detail) {
  return { kind, detail };
}

// A list that keeps at most PER_KIND_MAX entries of each capped kind and counts the rest.
function sink(out) {
  const n = Object.create(null);
  return {
    push(kind, detail) {
      out.push(violation(kind, detail));
    },
    capped(kind, detail) {
      n[kind] = (n[kind] || 0) + 1;
      if (n[kind] <= PER_KIND_MAX) out.push(violation(kind, detail));
    },
    finish() {
      for (const kind of Object.keys(n)) if (n[kind] > PER_KIND_MAX) out.push(violation(kind, { more: n[kind] - PER_KIND_MAX }));
    },
  };
}

// I1: the conservation equation, every counter a whole number of micro.
function checkI1(bank, s) {
  const l = bank.ledger;
  const parts = { in: l.in, outCash: l.outCash, outRefund: l.outRefund, outHouse: l.outHouse, acc: bank.sums.acc,
    floor: bank.sums.floor };
  const notMicro = Object.keys(parts).filter((k) => !isMicro(parts[k]));
  const sum = parts.acc + parts.floor + parts.outCash + parts.outRefund + parts.outHouse;
  if (notMicro.length > 0 || sum !== parts.in) s.push('I1', Object.assign({ sum, notMicro }, parts));
}

// I8, the bank's own tallies: the step's facts moved exactly what they took.
function checkI8(st, s) {
  const keys = ['taken', 'credited', 'suspended', 'dead', 'splitIn', 'unplaced'];
  const notMicro = keys.filter((k) => !isMicro(st[k]));
  if (notMicro.length > 0) {
    s.push('I8', { why: 'not-micro', notMicro });
    return;
  }
  if (st.credited + st.suspended !== st.taken) {
    s.push('I8', { why: 'eats', taken: st.taken, credited: st.credited, suspended: st.suspended });
  }
  if (st.splitIn !== st.dead - st.unplaced) {
    s.push('I8', { why: 'deaths', dead: st.dead, splitIn: st.splitIn, unplaced: st.unplaced });
  }
}

// I8, the facts: the sim's own record of this step against the bank, so a fact the controller skipped (a throw in
// its loop, a missed list) shows now. An eaten food that is still a pellet keeps its eater's micro on a food that is
// gone; a dead snake that still has an account keeps its micro off the floor. A sim with no such record is reported.
function checkI8Facts(bank, sim, s) {
  const eats = sim.food && sim.food.tick ? sim.food.tick.eats : null;
  if (!Array.isArray(eats)) {
    s.push('check', { why: 'no eats' });
  } else {
    for (const e of eats) {
      const p = e && e.food ? bank.floor.get(e.food) : undefined;
      if (p) s.capped('I8', { why: 'eaten-pellet', id: e.food.id, eater: e.eater, micro: p.micro });
    }
  }
  const log = typeof sim.lastLog === 'function' ? sim.lastLog() : null;
  if (!log || !Array.isArray(log.deaths)) {
    s.push('check', { why: 'no step log' });
  } else {
    for (const d of log.deaths) {
      const a = d ? bank.accounts.get(d.id) : undefined;
      if (a) s.push('I8', { why: 'dead-account', snakeId: d.id, jid: a.jid || null, micro: a.micro });
    }
  }
}

// I9 for one room: each of its accounts is the wallet's seat, and each seat that names this room is an account here.
function checkI9(room, bank, walletSeat, s) {
  for (const a of bank.accounts.values()) {
    if (a.bot === true) continue; // the owner's bots hold no seat and no wallet
    const ws = walletSeat.get(a.wallet);
    if (!ws || ws.room !== room || ws.snakeId !== a.snakeId) s.push('I9', { why: 'not-seated', snakeId: a.snakeId, jid: a.jid || null });
  }
  for (const [w, ws] of walletSeat) {
    if (!ws || ws.room !== room) continue;
    const a = bank.accounts.get(ws.snakeId);
    if (!a || a.wallet !== w) s.push('I9', { why: 'stale-seat', snakeId: ws.snakeId });
  }
}

function checkFull(room, bank, sim, K, o, s) {
  // I2: running sums against the maps; house kinds against outHouse.
  const re = bank.recount();
  const h = bank.house;
  const houseSum = h.swept + h.abandoned + h.breach;
  if (re.acc !== bank.sums.acc || re.floor !== bank.sums.floor || houseSum !== bank.ledger.outHouse) {
    s.push('I2', { acc: bank.sums.acc, accRecount: re.acc, floor: bank.sums.floor, floorRecount: re.floor, houseSum,
      outHouse: bank.ledger.outHouse });
  }
  // I3, I4: every account.
  for (const a of bank.accounts.values()) {
    if (!isMicro(a.micro) || a.micro < 1 || !isMicro(a.deposit) || a.micro < a.deposit) {
      s.push('I3', { snakeId: a.snakeId, jid: a.jid || null, micro: a.micro, deposit: a.deposit });
    }
    if (!sim.snake(a.snakeId)) s.push('I4', { snakeId: a.snakeId, jid: a.jid || null, micro: a.micro });
  }
  // I13: every live human snake.
  if (!room.humans || typeof room.humans[Symbol.iterator] !== 'function') {
    s.push('check', { why: 'no humans set' });
  } else {
    for (const id of room.humans) if (sim.snake(id) && !bank.accounts.has(id)) s.push('I13', { snakeId: id });
  }
  // I5, I7: every pellet.
  const food = sim.food;
  const flux = typeof sim.flux === 'function' ? sim.flux() : null;
  const limit = typeof flux === 'number' && Number.isFinite(flux) ? flux - K.inset + K.slack : null;
  for (const [f, p] of bank.floor) {
    if (!food || food.get(f.id) !== f) s.capped('I5', { why: 'off-grid', id: f.id });
    else if (f.nat) s.capped('I5', { why: 'natural', id: f.id });
    else if (!(f.b >= K.cashByte)) s.capped('I5', { why: 'small', id: f.id, b: f.b });
    if (!isMicro(p.micro) || p.micro < 1) s.capped('I7', { why: 'micro', id: f.id, micro: p.micro });
    if (limit !== null) {
      const d = Math.hypot(f.x - K.grd, f.y - K.grd);
      if (!(d <= limit)) s.capped('I7', { why: 'outside', id: f.id, dist: d, limit });
    }
  }
  if (limit === null) s.push('check', { why: 'no flux' });
  // I6: every cash-sized food on the grid.
  if (food) food.forEachFood((f) => { if (f.b >= K.cashByte && !bank.floor.has(f)) s.capped('I6', { id: f.id, b: f.b }); });
  else s.push('check', { why: 'no food store' });
  // I9 (with the directory's map).
  if (o.walletSeat) checkI9(room, bank, o.walletSeat, s);
}

function checkRoom(room, opts) {
  const o = opts || {};
  const out = [];
  const s = sink(out);
  try {
    const bank = bankOf(room);
    if (!bank) return [violation('check', { why: 'no bank' })];
    const K = o.K || checkLaws(room.laws);
    checkI1(bank, s);
    const st = o.step || bank.step;
    if (st) checkI8(st, s);
    const sim = room.sim;
    if (!sim) {
      s.push('check', { why: 'no sim' });
    } else {
      checkI8Facts(bank, sim, s);
      let n = 0;
      if (room.humans && typeof room.humans[Symbol.iterator] === 'function') {
        for (const id of room.humans) if (sim.snake(id)) n++;
      } else {
        n = sim.count();
      }
      if (!(n <= K.humanCap)) s.push('I10', { count: n, cap: K.humanCap });
      if (o.full) checkFull(room, bank, sim, K, o, s);
    }
  } catch (e) {
    s.push('check', { why: 'threw', error: String(e && e.message) });
  }
  s.finish();
  return out;
}

// I9 across every paid room (the directory, the soak, the proof): one open account per wallet, and walletSeat names
// exactly the open accounts.
function checkWalletSeats(rooms, walletSeat) {
  const out = [];
  try {
    const owner = new Map(); // wallet -> { room, snakeId } of the first account seen
    for (const room of rooms) {
      const bank = bankOf(room);
      if (!bank) {
        out.push(violation('check', { why: 'no bank' }));
        continue;
      }
      for (const a of bank.accounts.values()) {
        if (a.bot === true) continue; // the owner's bots hold no seat and no wallet
        const first = owner.get(a.wallet);
        if (first) out.push(violation('I9', { why: 'two-accounts', snakeId: a.snakeId, jid: a.jid || null, other: first.snakeId }));
        else owner.set(a.wallet, { room, snakeId: a.snakeId });
        const ws = walletSeat.get(a.wallet);
        if (!ws || ws.room !== room || ws.snakeId !== a.snakeId) {
          out.push(violation('I9', { why: 'not-seated', snakeId: a.snakeId, jid: a.jid || null }));
        }
      }
    }
    for (const [w, ws] of walletSeat) {
      const a = owner.get(w);
      if (!ws || !a || a.room !== ws.room || a.snakeId !== ws.snakeId) {
        out.push(violation('I9', { why: 'stale-seat', snakeId: ws ? ws.snakeId : null }));
      }
    }
  } catch (e) {
    out.push(violation('check', { why: 'threw', error: String(e && e.message) }));
  }
  return out;
}

// I11 (soak, proof): every sl jid is opened, then closed exactly once, or still open. records: the parsed journal
// lines in file order; only records whose room starts 'sl_' count, because the journal is shared with agar
// (design 7.1). An open may repeat for one jid: the door writes it before the claim and the account writes it again
// when it opens (design 3.3). openJids: the jids of every open account across the sl rooms.
function checkJournal(records, openJids) {
  const out = [];
  try {
    const opened = new Set();
    const closes = new Map(); // jid -> close count
    for (const r of records) {
      if (!r || typeof r.room !== 'string' || !r.room.startsWith('sl_')) continue;
      if (r.t === 'open') {
        opened.add(r.jid);
      } else if (r.t === 'close') {
        if (!opened.has(r.jid)) out.push(violation('I11', { why: 'close-before-open', jid: r.jid }));
        closes.set(r.jid, (closes.get(r.jid) || 0) + 1);
      }
    }
    for (const [jid, n] of closes) if (n > 1) out.push(violation('I11', { why: 'closed-twice', jid, closes: n }));
    const live = new Set(openJids);
    for (const jid of live) {
      if (!opened.has(jid)) out.push(violation('I11', { why: 'open-without-record', jid }));
      else if (closes.has(jid)) out.push(violation('I11', { why: 'open-but-closed', jid }));
    }
    for (const jid of opened) if (!closes.has(jid) && !live.has(jid)) out.push(violation('I11', { why: 'never-closed', jid }));
    if (opened.size !== closes.size + live.size) {
      out.push(violation('I11', { why: 'count', opens: opened.size, closes: closes.size, live: live.size }));
    }
  } catch (e) {
    out.push(violation('check', { why: 'threw', error: String(e && e.message) }));
  }
  return out;
}

// I12 (soak, proof): the whole run's money, all in micro.
//   staked     the worth of every consumed slither token (seated deposits plus door-refunded tokens)
//   cashGross  the gross of every cash-out; cashNet what the players were sent; rake what the house kept
//   refunds    door refunds plus owed refund rows (100% of the current balance)
//   house      booked to the house: swept floor, abandoned floor (shutdown, crash) and breaches
//   live       still inside the rooms (accounts + floor; sumBanks gives it)
//   withdraws  every fake withdraw of the run; refundsPaid the refunds actually sent (default refunds); sweeps every
//              sweep to the revenue wallet (rake, swept floor, breach)
// Checks: staked == cashGross + refunds + house + live; with rake, cashGross == cashNet + rake; with withdraws and
// sweeps, withdraws == cashNet + refundsPaid + sweeps.
function checkLedger(t) {
  const out = [];
  try {
    const x = t || {};
    const need = ['staked', 'cashGross', 'refunds', 'house', 'live'];
    const opt = ['cashNet', 'rake', 'withdraws', 'refundsPaid', 'sweeps'];
    const notMicro = need.filter((k) => !isMicro(x[k])).concat(opt.filter((k) => x[k] !== undefined && !isMicro(x[k])));
    if (notMicro.length > 0) return [violation('I12', { why: 'not-micro', notMicro })];
    const outSum = x.cashGross + x.refunds + x.house + x.live;
    if (x.staked !== outSum) out.push(violation('I12', { why: 'staked', staked: x.staked, accounted: outSum }));
    if (x.rake !== undefined) {
      if (x.cashNet === undefined) out.push(violation('I12', { why: 'rake-without-net' }));
      else if (x.cashGross !== x.cashNet + x.rake) {
        out.push(violation('I12', { why: 'rake', cashGross: x.cashGross, cashNet: x.cashNet, rake: x.rake }));
      }
    }
    if (x.withdraws !== undefined) {
      const paid = x.refundsPaid === undefined ? x.refunds : x.refundsPaid;
      if (x.cashNet === undefined || x.sweeps === undefined) out.push(violation('I12', { why: 'withdraws-without-parts' }));
      else if (x.withdraws !== x.cashNet + paid + x.sweeps) {
        out.push(violation('I12', { why: 'withdraws', withdraws: x.withdraws, cashNet: x.cashNet, refundsPaid: paid,
          sweeps: x.sweeps }));
      }
    }
  } catch (e) {
    out.push(violation('check', { why: 'threw', error: String(e && e.message) }));
  }
  return out;
}

// Every bank's counters added up (the soak's and the proof's `live` and per-kind totals).
function sumBanks(rooms) {
  const t = { in: 0, outCash: 0, outRefund: 0, outHouse: 0, acc: 0, floor: 0, live: 0,
    house: { swept: 0, abandoned: 0, breach: 0 } };
  for (const room of rooms) {
    const b = bankOf(room);
    if (!b) continue;
    t.in += b.ledger.in;
    t.outCash += b.ledger.outCash;
    t.outRefund += b.ledger.outRefund;
    t.outHouse += b.ledger.outHouse;
    t.acc += b.sums.acc;
    t.floor += b.sums.floor;
    for (const k of Object.keys(t.house)) t.house[k] += b.house[k];
  }
  t.live = t.acc + t.floor;
  return t;
}

module.exports = { checkRoom, checkWalletSeats, checkJournal, checkLedger, sumBanks, checkLaws, CHECK_LAW_IDS,
  PER_KIND_MAX };
