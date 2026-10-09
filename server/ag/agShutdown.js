'use strict';
// Shutdown and crash settle for paid agar.io (PAID-AGAR-DESIGN.md 5.9 with Owen's Q6 answer of 2026-10-08: a restart
// or a crash is our fault, so every open balance is REFUNDED 100%, no rake). Deploys run `pm2 restart`, which sends
// SIGINT and kills the process after its 1.6 s timeout, and nothing refunds a consumed stake at boot, so without this
// a restart would erase every seated agar balance.
//
// On the signal: the paid door closes for good (it now refuses before spending a token), every paid room stops
// ticking, every open account is withdrawn from its bank (before any write, so nothing can be both paid and owed) and
// handed back as an owed row with a unique key. Each row is first in the money journal (agJournal, written
// synchronously by the account's close) and logged as one [AG] SHUTDOWN-OWED line, then written through writeRow
// (the server passes db.recordOwedOnce, one row per key, with a reason that starts with 'refund', so the drainer pays
// it after the restart and never books it as winnings; the next boot's journal replay writes any row this write did
// not, and never one twice).
//
// When the process ends (review fix): the settle waits, at most SHUTDOWN_WRITE_MS, for its own rows AND for the agar
// money still in flight (payouts, refunds, door claims: track()). It then ends the process ONLY if nothing else
// listens to that signal, i.e. only where Node would have ended it at once without this handler. In production the
// leaderboard already listens (server/leaderboard.js setDb) and never exits, so the process keeps running until pm2's
// kill timeout, exactly as before this handler existed: Paper and snake cash-outs, the leaderboard flush and every
// other in-flight write keep the whole window they always had.

const SHUTDOWN_WRITE_MS = 1200;   // design 3.5 SHUTDOWN_WRITE_MS: inside pm2's default 1.6 s kill timeout

// Money promises still in flight (payouts, refunds, door claims). track(p) returns p.
function createInflight() {
  const pending = new Set();
  function track(p) {
    if (!p || typeof p.then !== 'function') return p;
    pending.add(p);
    const done = () => pending.delete(p);
    p.then(done, done);
    return p;
  }
  return { track, size: () => pending.size, all: () => Array.from(pending) };
}

function waitAll(promises, waitMs) {
  let timer = null;
  return Promise.race([
    Promise.allSettled(promises),
    new Promise((res) => {
      timer = setTimeout(res, waitMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }),
  ]).then(() => {
    if (timer) clearTimeout(timer);
  });
}

// arenas: AgArenas (shutdownSettle); writeRow(row) -> promise; exit(): ends the process, or null to leave it running
// (tests pass a spy); inflight: createInflight() of the server's agar money; why: 'shutdown' (a signal)
function agShutdownSettle({ arenas, writeRow, exit = null, log = console, waitMs = SHUTDOWN_WRITE_MS, inflight = null,
  why = 'shutdown' } = {}) {
  let rows = [];
  try {
    rows = arenas ? arenas.shutdownSettle(why) : [];
  } catch (e) {
    log.error('[AG] SHUTDOWN settle threw', e && e.stack ? e.stack : e);
  }
  const writes = rows.map((r) => {
    log.error('[AG] SHUTDOWN-OWED ' + r.wallet + ' ' + r.micro + ' micro ' + r.reason);
    return Promise.resolve().then(() => writeRow(r)).catch((e) => {
      log.error('[AG] SHUTDOWN-OWED write failed (the journal replays it at boot) ' + r.wallet + ' ' + r.micro + ': ' +
        (e && e.message));
    });
  });
  const end = () => {
    if (typeof exit === 'function') exit();
    return rows;
  };
  const flying = () => (inflight ? inflight.all() : []);
  if (!writes.length && !flying().length) return Promise.resolve(end());
  // Money in flight can start more (a door claim that lands now refunds 'not-open'), so the wait repeats until
  // nothing is in flight or the window is spent.
  const deadline = Date.now() + waitMs;
  const round = (list) => {
    const left = deadline - Date.now();
    if (!list.length || left <= 0) return Promise.resolve();
    return waitAll(list, left).then(() => round(flying()));
  };
  return round(writes.concat(flying())).then(end);
}

// Installs the handler once on SIGINT and SIGTERM (only while the paid rungs exist; the server decides).
function installAgShutdown({ arenas, writeRow, log = console, proc = process, exit, inflight = null } = {}) {
  let stopping = false;
  const onSignal = (sig) => {
    if (stopping) return;
    stopping = true;
    // Our own once-listener is already gone here: any listener left is someone who kept the process alive before.
    const others = typeof proc.listenerCount === 'function' ? proc.listenerCount(sig) : 0;
    log.log('[AG] ' + sig + ': settling paid agar.io balances' + (others ? ' (the process ends at pm2\'s kill timeout)' :
      ' before exit'));
    agShutdownSettle({ arenas, writeRow, log, inflight,
      exit: others > 0 ? null : (exit || (() => proc.exit(0))) });
  };
  proc.once('SIGINT', () => onSignal('SIGINT'));
  proc.once('SIGTERM', () => onSignal('SIGTERM'));
  return onSignal;
}

// A hard crash (an uncaught exception or an unhandled rejection, design 13's remaining risk) leaves no time for a
// database write: the process is already dying. Owen Q6 says a crash refunds 100% too, so before Node's own crash
// handler runs, synchronously, every open balance is withdrawn and closed with why 'crash': each close lands in the
// money journal (appendFileSync) with its owed row, which the next boot writes to the database once (agJournal
// replay), and each is logged as one [AG] CRASH-OWED line. uncaughtExceptionMonitor changes nothing about the crash
// itself, and it acts only when no uncaughtException handler would keep the process alive. A kill that runs no code
// (SIGKILL, out of memory, the box stopping) leaves its accounts open in the journal: the next boot flags them
// UNSETTLED-AT-BOOT for Owen.
function installAgCrashLog({ arenas, log = console, proc = process } = {}) {
  const onCrash = (err) => {
    try {
      if (typeof proc.listenerCount === 'function' && proc.listenerCount('uncaughtException') > 0) return;
      const rows = arenas ? arenas.shutdownSettle('crash') : [];
      for (const r of rows) log.error('[AG] CRASH-OWED ' + r.wallet + ' ' + r.micro + ' micro ' + r.reason);
      if (rows.length) log.error('[AG] CRASH: ' + rows.length + ' paid agar balance(s) owed, journaled for the boot ' +
        'replay (' + (err && err.message) + ')');
    } catch (e) {
      try { log.error('[AG] CRASH settle failed', e && e.message); } catch (_) { /* dying anyway */ }
    }
  };
  proc.on('uncaughtExceptionMonitor', onCrash);
  return onCrash;
}

module.exports = { agShutdownSettle, installAgShutdown, installAgCrashLog, createInflight, SHUTDOWN_WRITE_MS };
