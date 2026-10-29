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

   Nothing is ever sent without its row (night review 2026-10-29, re-review of finding 3). The first
   version paid "the old way" when the row could not be written, but an INSERT that committed and
   whose reply was then lost (a dropped connection, an RDS failover) left an owed row nobody knew
   about, which the drainer paid a second time once the database was back. Now every payout carries
   a key of its own ('payout:' + a UUID) and the INSERT is idempotent on it (db.recordPayoutIntent:
   ON CONFLICT DO NOTHING, then the row is looked up by the key), so a retry finds the row an earlier
   try wrote instead of writing a second. The INSERT is tried INTENT_TRIES times a moment apart, one
   try at a time; if the database is still down, the payout is HELD in memory, the owner is alerted,
   and the row is tried again every HOLD_RETRY_MS. It is paid once the row exists, never before. A
   restart while a payout is held loses it from memory (the money stays in escrow): every held payout
   is logged in full as [PAYOUT] HELD and named in the owner's alert, so it can be settled by hand.

   Every dependency is injected (money, db, alert, sleep), so the tests drive it with fakes. */

const crypto = require('crypto');

const SUPERSEDED = 'payout-superseded';
const INTENT_TRIES = 3;                   // the INSERT, then two more tries a moment apart, before a payout is held
const INTENT_BACKOFF_MS = [250, 1000];
const HOLD_RETRY_MS = 15000;              // a held payout tries its row again this often, until it is written
const ALERT_EVERY_MS = 5 * 60 * 1000;     // at most one "payouts held" push per five minutes

function short(w) { return String(w || '').slice(0, 8); }

function defaultSleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); if (t && typeof t.unref === 'function') t.unref(); });
}

function createInlinePayout({ money, db, kickDrain = () => {}, alert = () => {}, log = console, sleep = defaultSleep,
                              newKey = () => 'payout:' + crypto.randomUUID(), now = () => Date.now(),
                              holdRetryMs = HOLD_RETRY_MS }) {
  for (const f of ['recordPayoutIntent', 'closePayoutIntent', 'savePayoutSignature', 'releasePayoutIntent']) {
    if (typeof db[f] !== 'function') throw new Error(`inlinePayout: db.${f} is missing, and a payout is never sent without its owed row`);
  }

  const held = new Map();                 // key -> { wallet, amount, who, why, since }: payouts waiting for their row
  let lastAlertAt = -Infinity;
  let alerted = false;

  function book(wallet, name, amount) {
    Promise.resolve()
      .then(() => db.recordEarnings(wallet, name, amount, money.fiatValue(amount)))
      .catch(() => {});
  }

  function tellOwner(text, opts) {
    try { alert(text, opts); } catch (_) { /* a lost push, never a payout */ }
  }

  function alertHeld(error) {
    if (now() - lastAlertAt < ALERT_EVERY_MS) return;
    lastAlertAt = now();
    alerted = true;
    const list = Array.from(held.values());
    const unit = money.unit || '';
    const total = list.reduce((s, h) => s + (Number(h.amount) || 0), 0);
    const names = list.slice(0, 3).map((h) => `${h.amount} ${unit} to ${h.wallet} (${h.why})`).join('; ');
    tellOwner(`${list.length} payout(s), ${total} ${unit} in all, are held: their owed row could not be written ` +
      `(${error && error.message}). Each is paid once its row is written. If the server restarts first, pay them by hand ` +
      `(the [PAYOUT] HELD log lines): ${names}${list.length > 3 ? '; and more' : ''}`,
      { title: 'Payouts held: database down', priority: 'high' });
  }

  async function tryRow(p) {
    const id = await db.recordPayoutIntent(p.wallet, p.amount, p.who, p.why, p.key);
    if (id === null || id === undefined) throw new Error('no row id came back');
    return id;
  }

  // The owed row's id, written once whatever happens: a retry that finds the row an earlier try wrote gets its id.
  async function writeRow(p) {
    let lastErr = null;
    for (let i = 0; i < INTENT_TRIES; i++) {
      if (i) await sleep(INTENT_BACKOFF_MS[Math.min(i - 1, INTENT_BACKOFF_MS.length - 1)]);
      try { return await tryRow(p); } catch (e) { lastErr = e; }
    }
    held.set(p.key, { wallet: p.wallet, amount: p.amount, who: p.who, why: p.why, since: now() });
    log.error(`[PAYOUT] HELD ${p.amount} ${money.unit || ''} to ${p.wallet} (${p.why}, ${p.key}): the owed row could not be ` +
      `written (${lastErr && lastErr.message}); nothing is sent until it is, tried again every ${Math.round(holdRetryMs / 1000)} s`);
    alertHeld(lastErr);
    for (;;) {
      await sleep(holdRetryMs);
      let id;
      try { id = await tryRow(p); } catch (e) { lastErr = e; continue; }
      held.delete(p.key);
      log.warn(`[PAYOUT] held payout to ${short(p.wallet)} (${p.why}, ${p.key}) has its owed row ${id} now; paying it`);
      if (!held.size && alerted) {
        alerted = false;
        lastAlertAt = -Infinity;
        tellOwner('Every held payout has its owed row now and is being paid.', { title: 'Payouts no longer held' });
      }
      return id;
    }
  }

  /* { wallet, amount (money unit), name, reason (the owed row's reason; a refund's begins 'refund', so neither this
     nor the drainer ever books it as winnings), earn (book earnings when it lands) }.
     Resolves { paid: true, sig, earned } once the transfer landed; { paid: false, owed: true, error } when it did not
     (the owed row then exists and the drainer pays it); { paid: false, owed: true, handedOff: true, error } when the
     drainer saved its own transaction for the row first (this attempt sent nothing; the drainer is paying it).
     Stays pending while the payout is held for its row. Never rejects. */
  async function pay({ wallet, amount, name, reason, earn = true }) {
    const p = { key: newKey(), wallet, amount, who: name || 'Player', why: String(reason || 'payout') };
    const id = await writeRow(p);

    let sig;
    try {
      sig = await money.withdraw(wallet, amount, { beforeSend: (b) => db.savePayoutSignature(id, b, null) });
    } catch (e) {
      if (e && e.code === SUPERSEDED) {
        // The drainer took the row (its lease ran out) and saved its own transaction first: it pays it. Nothing was sent.
        log.warn(`[PAYOUT] row ${id} (${p.why}): the drainer saved its transaction first and pays it; this attempt sent nothing`);
        return { paid: false, owed: true, handedOff: true, error: e };
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
    if (mine && earn) book(wallet, p.who, amount);
    return { paid: true, sig, earned: !!(mine && earn) };
  }

  return { pay, held: () => Array.from(held.values()) };
}

module.exports = { createInlinePayout, SUPERSEDED, INTENT_TRIES, INTENT_BACKOFF_MS, HOLD_RETRY_MS };
