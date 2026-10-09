'use strict';
// The paid agar.io money journal (review fix for Owen's Q6 of 2026-10-08: a crash or restart refunds 100% of every
// open balance). A database write needs time a dying process does not have, so every paid account's life is also
// written, synchronously, to a local append-only file (one JSON line per record):
//
//   open   when an account opens   { t, jid, wallet, micro (the deposit), room, boot, at }
//   close  when it closes          { t, jid, outcome, why, room, at } and, for a 'shutdown' or 'crash' refund, the
//                                   owed row itself: { key, wallet, name, micro, reason }
//
// At the next boot the file is renamed out of the way at once (rotate), then, once the database is up (replay):
//   - every shutdown or crash close is written as an owed refund row through writeOwedOnce, keyed by its `key`, so a
//     row the dying process did write is never owed twice (db.recordOwedOnce takes one row per key);
//   - every account opened with no close at all (the process was killed: SIGKILL, out of memory, the box stopped) is
//     flagged UNSETTLED to Owen with its wallet and deposit in the server log, never paid automatically: its balance
//     at the kill is not known, and it may have been eaten by a player who has since cashed out.
// A replay file whose owed rows all went through is renamed to .done (kept for Owen); one that did not stays and is
// replayed at the next boot. The journal never throws into a money path: a failed write is logged and the money
// moves on exactly as before.
//
// CHOSEN (PARITY-LOG): the file is server/data/ag-money-journal.log (server/data/ is gitignored, and the deploy's
// `git reset --hard` keeps untracked files), or AG_JOURNAL_PATH; it is rotated at every boot (each record is about
// 200 bytes, two per paid seat).

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'ag-money-journal.log');
const OWED_WHYS = Object.freeze(['shutdown', 'crash']);

function createAgJournal({ file = DEFAULT_FILE, bootId = '', log = console, now = Date.now, fsx = fs } = {}) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let dirReady = false;
  let failedOnce = false;

  function append(rec) {
    try {
      if (!dirReady) {
        fsx.mkdirSync(dir, { recursive: true });
        dirReady = true;
      }
      fsx.appendFileSync(file, JSON.stringify(rec) + '\n');
      return true;
    } catch (e) {
      if (!failedOnce) log.error('[AG] JOURNAL CRITICAL write failed (' + file + '): ' + (e && e.message));
      failedOnce = true;
      return false;
    }
  }

  function open(acct, room) {
    if (!acct || !acct.jid) return false;
    return append({ t: 'open', jid: acct.jid, wallet: acct.wallet, micro: acct.deposit, room: String(room || ''),
      boot: bootId, at: now() });
  }

  function close(acct, outcome, extra, room) {
    if (!acct || !acct.jid) return false;
    const x = extra || {};
    const rec = { t: 'close', jid: acct.jid, outcome: String(outcome || ''), why: String(x.why || ''),
      room: String(room || ''), at: now() };
    if (outcome === 'refunded' && OWED_WHYS.includes(x.why) && typeof x.key === 'string') {
      rec.key = x.key;
      rec.wallet = acct.wallet;
      rec.name = acct.name || '';
      rec.micro = Number.isSafeInteger(x.refundedMicro) ? x.refundedMicro : 0;
      rec.reason = String(x.reason || ('refund agar ' + x.why + ' ' + x.key));
    }
    return append(rec);
  }

  function replayFiles() {
    try {
      return fsx.readdirSync(dir).filter((n) => n.startsWith(base + '.') && n.endsWith('.replay'))
        .sort().map((n) => path.join(dir, n));
    } catch (e) {
      return [];
    }
  }

  // At boot, before any account opens: the last process's file is moved aside, so this process writes a fresh one.
  function rotate() {
    try {
      if (fsx.existsSync(file) && fsx.statSync(file).size > 0) {
        const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
        fsx.renameSync(file, path.join(dir, base + '.' + stamp + '.' + (bootId || 'boot') + '.replay'));
      }
    } catch (e) {
      log.error('[AG] JOURNAL CRITICAL rotate failed (' + file + '): ' + (e && e.message));
    }
    return replayFiles();
  }

  function parse(text) {
    const accounts = new Map();   // jid -> { open, close }
    let bad = 0;
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch (e) {
        bad++;   // a line the kill cut in half
        continue;
      }
      if (!r || typeof r.jid !== 'string') continue;
      const a = accounts.get(r.jid) || { open: null, close: null };
      if (r.t === 'open') a.open = r;
      else if (r.t === 'close') a.close = r;
      accounts.set(r.jid, a);
    }
    return { accounts, bad };
  }

  // writeOwedOnce({ key, wallet, name, micro, reason }) -> promise of 'owed' | 'exists'; alert(info): the owner push
  // (no wallets); returns a summary.
  async function replay({ writeOwedOnce, alert = () => {} } = {}) {
    const out = { files: 0, owed: 0, existed: 0, failed: 0, unsettled: 0, unsettledMicro: 0 };
    for (const f of replayFiles()) {
      out.files++;
      let text = '';
      try {
        text = fsx.readFileSync(f, 'utf8');
      } catch (e) {
        log.error('[AG] JOURNAL could not read ' + f + ': ' + (e && e.message));
        out.failed++;
        continue;
      }
      const { accounts, bad } = parse(text);
      if (bad) log.warn('[AG] JOURNAL ' + path.basename(f) + ': ' + bad + ' unreadable line(s) skipped');
      let failed = 0;
      for (const a of accounts.values()) {
        const c = a.close;
        if (c && c.outcome === 'refunded' && OWED_WHYS.includes(c.why) && typeof c.key === 'string' &&
            Number.isSafeInteger(c.micro) && c.micro > 0 && typeof c.wallet === 'string' && c.wallet) {
          const row = { key: c.key, wallet: c.wallet, name: c.name || 'Player', micro: c.micro, reason: c.reason };
          try {
            const r = await writeOwedOnce(row);
            if (r === 'exists') out.existed++;
            else {
              out.owed++;
              log.warn('[AG] JOURNAL owed ' + row.wallet + ' ' + row.micro + ' micro ' + row.reason);
            }
          } catch (e) {
            failed++;
            log.error('[AG] JOURNAL CRITICAL owed row not written yet (kept for the next boot) ' + row.wallet + ' ' +
              row.micro + ' micro ' + row.reason + ': ' + (e && e.message));
          }
        } else if (a.open && !c) {
          out.unsettled++;
          out.unsettledMicro += Number.isSafeInteger(a.open.micro) ? a.open.micro : 0;
          log.error('[AG] UNSETTLED-AT-BOOT ' + a.open.wallet + ' deposit ' + a.open.micro + ' micro room ' +
            a.open.room + ' journal ' + a.open.jid + ' (the server was killed with this paid balance open; pay by hand)');
        }
      }
      out.failed += failed;
      if (!failed) {
        try {
          fsx.renameSync(f, f.replace(/\.replay$/, '.done'));
        } catch (e) {
          log.error('[AG] JOURNAL could not mark ' + f + ' done: ' + (e && e.message));
        }
      }
    }
    if (out.unsettled) {
      try {
        alert({ kind: 'unsettled-at-boot', accounts: out.unsettled, totalMicro: out.unsettledMicro });
      } catch (e) {
        log.error('[AG] JOURNAL alert', e && e.message);
      }
    }
    if (out.files) log.log('[AG] JOURNAL replay ' + JSON.stringify(out));
    return out;
  }

  return { open, close, rotate, replay, replayFiles, file };
}

module.exports = { createAgJournal, DEFAULT_FILE };
