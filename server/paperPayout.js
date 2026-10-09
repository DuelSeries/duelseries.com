'use strict';
// Paper money out of the escrow (design 5.5): cash-outs at 90/10, door refunds bounded by what
// landed on-chain, and the hour sweep of floor money to the house. Every dependency is injected,
// so the tests run it with fakes. Nothing here reads a connection object: the wallet travels in
// the order, so a player whose connection closes between completion and payment is still paid.
//
// Parameterized for paid agar.io (PAID-AGAR-DESIGN.md 5.6): game, prefix, floorSource and tag name
// every string that used to say Paper. Their defaults are Paper's own, so Paper's instance sends the
// same events, reasons and memos byte for byte. Agar's instance: game 'agar', prefix 'ag',
// floorSource 'agar_floor', tag '[AG]', io = io.of('/ag') (socket ids are per namespace). An order
// with no socketId (a dormant player's automatic cash-out) is paid without emitting anything.
// houseIncident (agar only): money that goes to the house for a manual look (agar_breach).

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

function create({ money, db, trackEarning, sweepRake, io, REGION, game = 'paper', prefix = 'pp', floorSource = 'paper_floor', tag = '[PAPER]', breachSource = null }) {
  const seenCashouts = seenSet();
  const seenSweeps = seenSet();

  function emitTo(socketId, event, payload) {
    if (!io || !socketId) return;
    try {
      io.to(socketId).emit(event, payload);
    } catch (e) {
      console.error(tag + ' emit ' + event, e.message);
    }
  }

  // order: { cashoutId, grossMicro, wallet, name, label, socketId }
  // Always 90/10 (brief rule 3). Exactly one withdraw per order; no inline retry, the NA
  // drainer recovers a failed row. Returns the payout promise (callers need not wait on it).
  function payCashout(order) {
    if (seenCashouts.has(order.cashoutId)) {
      console.error(tag + ' CASHOUT duplicate id', JSON.stringify(order));
      return Promise.resolve(null);
    }
    seenCashouts.add(order.cashoutId);
    const { wallet, name, label, socketId, cashoutId } = order;
    const grossMicro = order.grossMicro;
    if (!isMicro(grossMicro)) {
      console.error(tag + ' CASHOUT bad gross', JSON.stringify(order));
      return Promise.resolve(null);
    }
    const cut = Math.floor(grossMicro / HOUSE_CUT_DIV);
    const net = grossMicro - cut;

    // Bookkeeping can never prevent the one withdraw below.
    if (cut > 0) {
      try {
        trackEarning({ source: 'game_rake', game, amountUsdc: cut / 1e6, wallet, name, lobbyType: label, region: REGION });
      } catch (e) {
        console.error(tag + ' PAYOUT bookkeeping', e.message);
      }
      try {
        sweepRake(cut / 1e6, game + ' ' + label);
      } catch (e) {
        console.error(tag + ' PAYOUT rake sweep', e.message);
      }
    }
    emitTo(socketId, prefix + ':cashedout', { grossMicro, cutMicro: cut, netMicro: net, cashoutId }); // display only

    if (!(net > 0)) return Promise.resolve(null); // free arena: nothing to send
    if (!wallet) {
      console.error(tag + ' CASHOUT CRITICAL no wallet on a paid order', JSON.stringify(order));
      return Promise.resolve(null);
    }
    return money.withdraw(wallet, net / 1e6)
      .then((sig) => {
        console.log(`${tag} CASHOUT ${net} micro -> ${String(wallet).slice(0, 8)} (${label}) sig ${String(sig).slice(0, 12)}`);
        db.recordEarnings(wallet, name, net / 1e6, money.fiatValue(net / 1e6)).catch(() => {});
        emitTo(socketId, prefix + ':paid', { sig, netMicro: net });
        return sig;
      })
      .catch((e) => {
        console.error(`${tag} CASHOUT CRITICAL payout failed for ${wallet}, owed ${net} micro: ${e.message}`);
        db.recordFailedPayout(wallet, net / 1e6, name, game + ' ' + label + ': ' + e.message, e.broadcast).catch(() => {});
        emitTo(socketId, prefix + ':payerror', { message: 'Payout delayed. Your winnings are recorded and will be sent.' });
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
    console.log(`${tag} REFUND ${wallet} ${amount} ${why}`);
    if (!(amount > 0) || !wallet) return Promise.resolve(null);
    return money.withdraw(wallet, amount / 1e6)
      .then((sig) => {
        console.log(`${tag} REFUND sent ${amount} micro -> ${String(wallet).slice(0, 8)} sig ${String(sig).slice(0, 12)}`);
        return sig;
      })
      .catch((e) => {
        console.error(`${tag} REFUND failed for ${wallet}, owed ${amount} micro: ${e.message}`);
        db.recordFailedPayout(wallet, amount / 1e6, name, 'refund ' + game + ' ' + why + ': ' + e.message, e.broadcast).catch(() => {});
        return null;
      });
  }

  // Floor money nobody collected within the hour becomes house income on the rake's own path,
  // with its own source so the dashboard shows it apart from rake. Never anybody's earnings.
  function sweepFloor({ sweepId, micro, srcWallet, srcName, label, pid }) {
    if (seenSweeps.has(sweepId)) {
      console.error(tag + ' SWEEP duplicate id', JSON.stringify({ sweepId, micro, srcWallet, label, pid }));
      return false;
    }
    seenSweeps.add(sweepId);
    if (!(micro > 0) || !isMicro(micro)) return false;
    console.log(`${tag} SWEEP ${label} ${pid} ${micro} ${srcWallet}`);
    try {
      trackEarning({ source: floorSource, game, amountUsdc: micro / 1e6, wallet: srcWallet, name: srcName, lobbyType: label, region: REGION });
    } catch (e) {
      console.error(tag + ' SWEEP bookkeeping', e.message);
    }
    try {
      sweepRake(micro / 1e6, game + ' floor ' + label);
    } catch (e) {
      console.error(tag + ' SWEEP rake sweep', e.message);
    }
    return true;
  }

  /* Money that leaves a room to the house because something went wrong (agar: a frozen account after its
     backstop wait, design 3.4 step 5), on the rake's own path under its own source (breachSource) so the
     dashboard shows it apart from rake, with the wallet in the database row only, for Owen to pay back by hand.
     Never anybody's earnings. Once per id. */
  const seenIncidents = seenSet();
  function houseIncident({ id, micro, wallet, name, label, why }) {
    if (!breachSource) {
      console.error(tag + ' INCIDENT with no breachSource, nothing booked', JSON.stringify({ id, micro, label, why }));
      return false;
    }
    if (seenIncidents.has(id)) return false;
    seenIncidents.add(id);
    if (!(micro > 0) || !isMicro(micro)) return false;
    console.error(`${tag} INCIDENT ${breachSource} ${label} ${micro} micro (${why}) wallet ${wallet}`);
    try {
      trackEarning({ source: breachSource, game, amountUsdc: micro / 1e6, wallet, name, lobbyType: label, region: REGION });
    } catch (e) {
      console.error(tag + ' INCIDENT bookkeeping', e.message);
    }
    try {
      sweepRake(micro / 1e6, game + ' breach ' + label);
    } catch (e) {
      console.error(tag + ' INCIDENT rake sweep', e.message);
    }
    return true;
  }

  return { payCashout, refund, sweepFloor, houseIncident };
}

module.exports = { create, toMicro, HOUSE_CUT_DIV };
