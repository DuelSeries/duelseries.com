'use strict';
// Shutdown settle for paid agar.io (PAID-AGAR-DESIGN.md 5.9 with Owen's Q6 answer of 2026-10-08: a restart is our
// fault, so every open balance is REFUNDED 100%, no rake). Deploys run `pm2 restart`, which sends SIGINT and kills the
// process after its 1.6 s timeout, and nothing refunds a consumed stake at boot, so without this a restart would erase
// every seated agar balance.
//
// On the signal: the paid door closes, every paid room stops ticking, every open account is withdrawn from its bank
// (before any write, so nothing can be both paid and owed) and handed back as an owed row, which is written through
// writeRow (the server passes db.recordFailedPayout with a reason that starts with 'refund', so the drainer pays it
// after the restart and never books it as winnings). Each row is logged as one [AG] SHUTDOWN-OWED line first, so a
// write the database never took can be rebuilt by hand. The writes race SHUTDOWN_WRITE_MS, then exit() runs. With
// nothing open, exit() runs at once.

const SHUTDOWN_WRITE_MS = 1200;   // design 3.5 SHUTDOWN_WRITE_MS: inside pm2's default 1.6 s kill timeout

// arenas: AgArenas (shutdownSettle); writeRow(row) -> promise; exit(): ends the process (tests pass a spy)
function agShutdownSettle({ arenas, writeRow, exit, log = console, waitMs = SHUTDOWN_WRITE_MS } = {}) {
  let rows = [];
  try {
    rows = arenas ? arenas.shutdownSettle() : [];
  } catch (e) {
    log.error('[AG] SHUTDOWN settle threw', e && e.stack ? e.stack : e);
  }
  if (!rows.length) {
    exit();
    return Promise.resolve(rows);
  }
  const writes = rows.map((r) => {
    log.error('[AG] SHUTDOWN-OWED ' + r.wallet + ' ' + r.micro + ' micro ' + r.reason);
    return Promise.resolve().then(() => writeRow(r)).catch((e) => {
      log.error('[AG] SHUTDOWN-OWED write failed ' + r.wallet + ' ' + r.micro + ': ' + (e && e.message));
    });
  });
  let timer = null;
  return Promise.race([
    Promise.allSettled(writes),
    new Promise((res) => {
      timer = setTimeout(res, waitMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }),
  ]).then(() => {
    if (timer) clearTimeout(timer);
    exit();
    return rows;
  });
}

// Installs the handler once on SIGINT and SIGTERM (only while the paid rungs exist; the server decides).
function installAgShutdown({ arenas, writeRow, log = console, proc = process, exit } = {}) {
  let stopping = false;
  const onSignal = (sig) => {
    if (stopping) return;
    stopping = true;
    log.log('[AG] ' + sig + ': settling paid agar.io balances before exit');
    agShutdownSettle({ arenas, writeRow, log, exit: exit || (() => proc.exit(0)) });
  };
  proc.once('SIGINT', () => onSignal('SIGINT'));
  proc.once('SIGTERM', () => onSignal('SIGTERM'));
  return onSignal;
}

// A hard crash (an uncaught exception, design 13's remaining risk) gives no time for a database write: the process is
// already dying. Owen Q6 says a crash refunds 100% too, so the next best thing is done synchronously before Node's own
// crash handler runs: every open balance is withdrawn and logged as one [AG] CRASH-OWED line (wallet, micro, reason),
// which pm2 keeps in the box log, for Owen to pay back by hand. uncaughtExceptionMonitor changes nothing about the
// crash itself, and it acts only when no uncaughtException handler would keep the process alive.
function installAgCrashLog({ arenas, log = console, proc = process } = {}) {
  const onCrash = (err) => {
    try {
      if (typeof proc.listenerCount === 'function' && proc.listenerCount('uncaughtException') > 0) return;
      const rows = arenas ? arenas.shutdownSettle() : [];
      for (const r of rows) {
        log.error('[AG] CRASH-OWED ' + r.wallet + ' ' + r.micro + ' micro ' + r.reason.replace('shutdown', 'crash'));
      }
      if (rows.length) log.error('[AG] CRASH: ' + rows.length + ' paid agar balance(s) owed, see CRASH-OWED lines (' +
        (err && err.message) + ')');
    } catch (e) {
      try { log.error('[AG] CRASH settle failed', e && e.message); } catch (_) { /* dying anyway */ }
    }
  };
  proc.on('uncaughtExceptionMonitor', onCrash);
  return onCrash;
}

module.exports = { agShutdownSettle, installAgShutdown, installAgCrashLog, SHUTDOWN_WRITE_MS };
