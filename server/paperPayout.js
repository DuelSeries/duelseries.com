'use strict';
// Paper money out of the escrow (design 5.5): cash-outs at 90/10, door refunds bounded by what
// landed on-chain, and the hour sweep of floor money to the house. Every dependency is injected,
// so the tests run it with fakes. Nothing here reads a connection object: the wallet travels in
// the order, so a player whose connection closes between completion and payment is still paid.

const HOUSE_CUT_DIV = 10; // same number as P.MP.HOUSE_CUT_DIV: the existing 90/10
const SEEN_MAX = 5000;

function toMicro(amount) {
  return Math.round(amount * 1e6);
}

function isMicro(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

// A bounded set of ids: remembers the newest SEEN_MAX.
function seenSet() {
  const set = new Set();
  return {
    has: (id) => set.has(id),
    add(id) {
      set.add(id);
      if (set.size > SEEN_MAX) set.delete(set.values().next().value);
    }
  };
}

function create({ money, db, trackEarning, sweepRake, io, REGION }) {
  const seenCashouts = seenSet();
  const seenSweeps = seenSet();

  function emitTo(socketId, event, payload) {
    if (!io || !socketId) return;
    try {
      io.to(socketId).emit(event, payload);
    } catch (e) {
      console.error('[PAPER] emit ' + event, e.message);
    }
  }

  // order: { cashoutId, grossMicro, wallet, name, label, socketId }
  // Always 90/10 (brief rule 3). Exactly one withdraw per order; no inline retry, the NA
  // drainer recovers a failed row. Returns the payout promise (callers need not wait on it).
  function payCashout(order) {
    if (seenCashouts.has(order.cashoutId)) {
      console.error('[PAPER] CASHOUT duplicate id', JSON.stringify(order));
      return Promise.resolve(null);
    }
    seenCashouts.add(order.cashoutId);
    const { wallet, name, label, socketId, cashoutId } = order;
    const grossMicro = order.grossMicro;
    if (!isMicro(grossMicro)) {
      console.error('[PAPER] CASHOUT bad gross', JSON.stringify(order));
      return Promise.resolve(null);
    }
    const cut = Math.floor(grossMicro / HOUSE_CUT_DIV);
    const net = grossMicro - cut;

    // Bookkeeping can never prevent the one withdraw below.
    if (cut > 0) {
      try {
        trackEarning({ source: 'game_rake', game: 'paper', amountUsdc: cut / 1e6, wallet, name, lobbyType: label, region: REGION });
      } catch (e) {
        console.error('[PAPER] PAYOUT bookkeeping', e.message);
      }
      try {
        sweepRake(cut / 1e6, 'paper ' + label);
      } catch (e) {
        console.error('[PAPER] PAYOUT rake sweep', e.message);
      }
    }
    emitTo(socketId, 'pp:cashedout', { grossMicro, cutMicro: cut, netMicro: net, cashoutId }); // display only

    if (!(net > 0)) return Promise.resolve(null); // free arena: nothing to send
    if (!wallet) {
      console.error('[PAPER] CASHOUT CRITICAL no wallet on a paid order', JSON.stringify(order));
      return Promise.resolve(null);
    }
    return money.withdraw(wallet, net / 1e6)
      .then((sig) => {
        console.log(`[PAPER] CASHOUT ${net} micro -> ${String(wallet).slice(0, 8)} (${label}) sig ${String(sig).slice(0, 12)}`);
        db.recordEarnings(wallet, name, net / 1e6, money.fiatValue(net / 1e6)).catch(() => {});
        emitTo(socketId, 'pp:paid', { sig, netMicro: net });
        return sig;
      })
      .catch((e) => {
        console.error(`[PAPER] CASHOUT CRITICAL payout failed for ${wallet}, owed ${net} micro: ${e.message}`);
        db.recordFailedPayout(wallet, net / 1e6, name, 'paper ' + label + ': ' + e.message, e.broadcast).catch(() => {});
        emitTo(socketId, 'pp:payerror', { message: 'Payout delayed. Your winnings are recorded and will be sent.' });
        return null;
      });
  }

  // A paid join refused at the door, or a seat that failed after the token was spent (owner
  // decision 2). No rake. Returns what landed on-chain, capped at the rung: the verifier accepts
  // 99 percent of the rung, so refunding the rung itself would mint the difference.
  function refund({ wallet, name, micro, paid, why }) {
    const rung = isMicro(micro) ? micro : 0;
    const landed = toMicro(Number.isFinite(paid) ? paid : rung / 1e6);
    const amount = Math.max(0, Math.min(rung, landed));
    console.log(`[PAPER] REFUND ${wallet} ${amount} ${why}`);
    if (!(amount > 0) || !wallet) return Promise.resolve(null);
    return money.withdraw(wallet, amount / 1e6)
      .then((sig) => {
        console.log(`[PAPER] REFUND sent ${amount} micro -> ${String(wallet).slice(0, 8)} sig ${String(sig).slice(0, 12)}`);
        return sig;
      })
      .catch((e) => {
        console.error(`[PAPER] REFUND failed for ${wallet}, owed ${amount} micro: ${e.message}`);
        db.recordFailedPayout(wallet, amount / 1e6, name, 'refund paper ' + why + ': ' + e.message, e.broadcast).catch(() => {});
        return null;
      });
  }

  // Floor money nobody collected within the hour becomes house income on the rake's own path,
  // with its own source so the dashboard shows it apart from rake. Never anybody's earnings.
  function sweepFloor({ sweepId, micro, srcWallet, srcName, label, pid }) {
    if (seenSweeps.has(sweepId)) {
      console.error('[PAPER] SWEEP duplicate id', JSON.stringify({ sweepId, micro, srcWallet, label, pid }));
      return false;
    }
    seenSweeps.add(sweepId);
    if (!(micro > 0) || !isMicro(micro)) return false;
    console.log(`[PAPER] SWEEP ${label} ${pid} ${micro} ${srcWallet}`);
    try {
      trackEarning({ source: 'paper_floor', game: 'paper', amountUsdc: micro / 1e6, wallet: srcWallet, name: srcName, lobbyType: label, region: REGION });
    } catch (e) {
      console.error('[PAPER] SWEEP bookkeeping', e.message);
    }
    try {
      sweepRake(micro / 1e6, 'paper floor ' + label);
    } catch (e) {
      console.error('[PAPER] SWEEP rake sweep', e.message);
    }
    return true;
  }

  return { payCashout, refund, sweepFloor };
}

module.exports = { create, toMicro, HOUSE_CUT_DIV };
