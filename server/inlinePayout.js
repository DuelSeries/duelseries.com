'use strict';
/* Inline payouts that write their owed row FIRST (night review 2026-10-29, finding 3).

   Every duel prize and refund (koSend: Knockout, Battleship, Swim, Head Soccer, Pool, Air Hockey,
   Rooftop, Crossy) and the old snake cash-out (doCashout) used to call money.withdraw straight
   away and write a failed_payouts row only from its .catch. The room was already settled, so a
   restart (every push to main: pm2 sends SIGINT and kills 1.6 s later) or a crash while the payout
   was still building, or after a send the network then dropped, left no row, no journal and no
   alert: the winner's money stayed in escrow and nobody knew.

   Now, the drainer's own rule, inline:
     1. the owed row is written before anything is signed (db.recordPayoutIntent), with the
        drainer's 30 s claim lease, so the drainer keeps off it while this attempt runs;
     2. the signed bytes are saved on that row BEFORE they are sent (money.withdraw's beforeSend,
        the drainer's compare-and-set db.savePayoutSignature: when another attempt saved its own
        transaction for the row first, this one sends nothing);
     3. once the transfer landed the row is closed (db.closePayoutIntent: removed while unpaid, so a
        payout that went through leaves exactly what it always left), and the earnings are booked
        only by whoever closed it;
     4. if it did not land, the row stays owed with the error on its reason and its lease ends
        (db.releasePayoutIntent), and the drainer finishes it.
   A process that dies anywhere leaves a row the drainer settles exactly once: it re-sends the
   saved bytes (one signature, it can land only once) or builds a fresh one only after those
   provably expired unlanded. The player sees the same payout at the same speed: one INSERT before
   the transfer and one DELETE after it.

   If the owed row cannot be written (the database is down), the payout goes out the old way,
   so a database outage never holds a player's money back.

   Every dependency is injected (money, db), so the tests drive it with fakes. */

const SUPERSEDED = 'payout-superseded';

function short(w) { return String(w || '').slice(0, 8); }

function createInlinePayout({ money, db, kickDrain = () => {}, log = console }) {
  const durable = () => typeof db.recordPayoutIntent === 'function' && typeof db.closePayoutIntent === 'function'
    && typeof db.savePayoutSignature === 'function';

  function book(wallet, name, amount) {
    Promise.resolve()
      .then(() => db.recordEarnings(wallet, name, amount, money.fiatValue(amount)))
      .catch(() => {});
  }

  // Today's path, unchanged: send, then book; a failure is recorded owed with whatever was signed.
  async function payUnrecorded({ wallet, amount, who, reason, earn }) {
    try {
      const sig = await money.withdraw(wallet, amount);
      if (earn) book(wallet, who, amount);
      return { paid: true, sig, earned: !!earn };
    } catch (e) {
      Promise.resolve()
        .then(() => db.recordFailedPayout(wallet, amount, who, reason + ': ' + (e && e.message), e && e.broadcast))
        .catch(() => {});
      return { paid: false, owed: true, error: e };
    }
  }

  /* { wallet, amount (money unit), name, reason (the owed row's reason; a refund's begins 'refund', so neither this
     nor the drainer ever books it as winnings), earn (book earnings when it lands) }.
     Resolves { paid: true, sig, earned } once the transfer landed, or { paid: false, owed: true, error } when it did
     not (the owed row then exists and the drainer pays it). Never rejects. */
  async function pay({ wallet, amount, name, reason, earn = true }) {
    const who = name || 'Player';
    const why = String(reason || 'payout');
    let id = null;
    if (durable()) {
      try {
        id = await db.recordPayoutIntent(wallet, amount, who, why);
      } catch (e) {
        log.error(`[PAYOUT] could not write the owed row before paying ${short(wallet)} (${why}); paying without it: ${e && e.message}`);
        id = null;
      }
    }
    if (id === null || id === undefined) return payUnrecorded({ wallet, amount, who, reason: why, earn });

    let sig;
    try {
      sig = await money.withdraw(wallet, amount, { beforeSend: (b) => db.savePayoutSignature(id, b, null) });
    } catch (e) {
      if (e && e.code === SUPERSEDED) {
        // The drainer took the row (its lease ran out) and saved its own transaction first: it pays it. Nothing was sent.
        log.warn(`[PAYOUT] row ${id} (${why}): the drainer saved its transaction first; this attempt sent nothing`);
        return { paid: false, owed: true, error: e };
      }
      try { await db.releasePayoutIntent(id, e && e.message); } catch (e2) {
        log.error(`[PAYOUT] row ${id} stays owed under its lease (the drainer takes it in 30 s): ${e2 && e2.message}`);
      }
      try { kickDrain(); } catch (_) {}
      return { paid: false, owed: true, error: e };
    }

    let mine = false;
    try {
      mine = await db.closePayoutIntent(id);
    } catch (e) {
      // The row keeps its saved signature: the drainer finds it landed, marks it paid and books it. Nothing is re-sent.
      log.error(`[PAYOUT] CRITICAL row ${id} landed (sig ${String(sig).slice(0, 12)}) but could not be closed; the drainer settles it: ${e && e.message}`);
    }
    if (mine && earn) book(wallet, who, amount);
    return { paid: true, sig, earned: !!(mine && earn) };
  }

  return { pay };
}

module.exports = { createInlinePayout, SUPERSEDED };
