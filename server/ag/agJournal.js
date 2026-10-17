'use strict';
// The paid agar.io money journal (review fix for Owen's Q6 of 2026-10-08: a crash or restart refunds 100% of every
// open balance). A database write needs time a dying process does not have, so every paid account's life is also
// written, synchronously, to a local append-only file (one JSON line per record):
//
//   open   when an account opens   { t, jid, wallet, micro (the deposit), room, boot, at } and, when the account
//                                   has one, stakeSig (a paid snake on the sl engine, server/slPaid; agar accounts
//                                   carry none, so agar's records are as before)
//   close  when it closes          { t, jid, outcome, why, room, at } and, for a refund whose why is an owed why
//                                   (OWED_WHYS) and that carries a key, the owed row itself: { key, wallet, name,
//                                   micro, reason }; for a paid snake's cash-out (its close says awaitPayout) the
//                                   order too: { cashoutId, grossMicro, netMicro, awaitPayout: 1 }
//   payout when that cash-out's    { t, jid, cashoutId, state ('sent', or 'failed': its failed_payouts row was
//          payout answered          written for the drainer), room, at }
//   floor  paid snake's floor gold { t, key ('slfloor:<uuid>'), room, why ('shutdown' or 'crash'), micro, bySource:
//          at a restart or crash    [{ srcWallet, srcName, micro }], boot, at }: Owen's answer of 2026-10-14 (the house
//                                   keeps it, booked as slither floor income), with no time to book it in the exit window;
//                                   paid Paper's floor coins the same way, keyed 'ppfloor:<uuid>' (booked as paper floor)
//   booked written into a REPLAY file by the replay, just before it books that file's floor record: { t, key, at }
//
// At the next boot the file is renamed out of the way at once (rotate), then, once the database is up (replay):
//   - every owed close (a shutdown or crash; for paid snake also an emergency or orphan refund, written by the room
//     before its own owed row, PAID-SL-DESIGN 7.4) is written as an owed refund row through writeOwedOnce, keyed by
//     its `key`, so a row the dying process did write is never owed twice (db.recordOwedOnce takes one row per key).
//     Agar's own emergency closes carry no key (agMoney emergencySettle refunds at once), so they are never replayed;
//   - every account opened with no close at all (the process was killed: SIGKILL, out of memory, the box stopped) is
//     flagged UNSETTLED to Owen with its wallet and deposit (and its stakeSig when the open had one) in the server log,
//     never paid automatically: its balance at the kill is not known, and it may have been eaten by a player who has
//     since cashed out. One exception (security review item d): a paid snake DOOR's open (door, stakeSig, claimKey)
//     that is still the jid's last open, with no close, is a stake the door took and never seated (the seat's own
//     open replaces it, and slMoney refuses a seat whose open it could not write). Its stake row is refunded through
//     refundStake (the server: stakeLedger.refund with the token's claimKey), a conditional update that pays at most
//     once whatever else refunded it ('settled' then); a refund the database did not take keeps the file. Paid Paper's
//     door (paperSockets) writes the same record before its own claim, and its seat (PaperArenas) replaces it the same way;
//   - every floor record is booked to the house once through bookFloor (the server: slPayout.sweepFloor per source
//     wallet, slither_floor plus the rake sweep), once the file's owed rows all went through (a database that refused
//     a player's refund books no house income from that file either). The replay first writes a booked record for its
//     key into the replay file itself, so a file kept for another reason never books the same floor twice; a marker it
//     cannot write books nothing and keeps the file;
//   - every paid snake cash-out whose close awaited a payout record and has none (the process died while its payout
//     was in flight: the transfer may or may not have gone out) is flagged CASHOUT-UNCONFIRMED-AT-BOOT to Owen with
//     its wallet, net, gross and cashoutId, never paid automatically.
// A replay file whose owed rows all went through and whose floors are booked is renamed to .done (kept for Owen); one
// that did not stays and is replayed at the next boot. The summary's keys for floors and unconfirmed cash-outs appear
// only when they count something, so agar's summary is as before. The journal never throws into a money path: a
// failed write is logged and the money moves on exactly as before.
//
// REVERT NOTE (PAID-SL-DESIGN.md 10, the Revert lever): a build that predates paid snake knows none of the emergency,
// orphan, floor or payout records. Rolling paid snake back while a .replay file holds any of them would drop those
// refunds and that floor income without a word, so either keep THIS file when reverting the feature commits (agar's
// records and replay output are the same with it; a build that books no floor keeps such a file and says so), or first
// boot this build once with the database up and check that every ag-money-journal.log.*.replay was renamed to .done.
//
// CHOSEN (PARITY-LOG): the file is server/data/ag-money-journal.log (server/data/ is gitignored, and the deploy's
// `git reset --hard` keeps untracked files), or AG_JOURNAL_PATH; it is rotated at every boot (each record is about
// 200 bytes, two per paid seat).

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'ag-money-journal.log');
// The refund whys a keyed close carries an owed row for. 'emergency' and 'orphan' are paid snake's owed lane (server/
// slPaid/slMoney.js _refundOwed); a close needs a key too, and agar's emergency close passes none.
// 'botfloor': a paid snake room bots played in gives its floor back to the droppers (slMoney _returnFloor).
const OWED_WHYS = Object.freeze(['shutdown', 'crash', 'emergency', 'orphan', 'botfloor']);
// slfloor: paid snake's floor gold; ppfloor: paid Paper's floor coins (its shutdown and crash settle, PaperRoom)
const FLOOR_KEY_RE = /^(slfloor|ppfloor):[0-9a-f-]{36}$/;
const PAYOUT_STATES = Object.freeze(['sent', 'failed']);
const isMicro = (v) => Number.isSafeInteger(v) && v > 0;

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
    const rec = { t: 'open', jid: acct.jid, wallet: acct.wallet, micro: acct.deposit, room: String(room || ''),
      boot: bootId, at: now() };
    if (typeof acct.stakeSig === 'string' && acct.stakeSig) rec.stakeSig = acct.stakeSig;
    // A paid snake door's own open (written before its stake claim, before any seat): door, and the token's claimKey,
    // so a replay that finds this record still the jid's last open, with no close, can refund that stake row once
    // (refundStake below). The seat's own open (slMoney) replaces it for the same jid and carries neither.
    if (acct.door === true && rec.stakeSig) {
      rec.door = true;
      if (typeof acct.claimKey === 'string' && acct.claimKey) rec.claimKey = acct.claimKey;
    }
    return append(rec);
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
    // a paid snake's cash-out: the order a hand reconcile needs, and the promise of a payout record (agar's cash-out
    // closes ask for none, so they are as before)
    if (outcome === 'cashedout' && x.awaitPayout === true && typeof x.cashoutId === 'string') {
      rec.cashoutId = x.cashoutId;
      rec.grossMicro = Number.isSafeInteger(x.grossMicro) ? x.grossMicro : 0;
      rec.netMicro = Number.isSafeInteger(x.netMicro) ? x.netMicro : 0;
      rec.awaitPayout = 1;
    }
    return append(rec);
  }

  // A paid snake cash-out's payout answered (state 'sent', or 'failed' once its failed_payouts row was written).
  function payout(jid, cashoutId, state, room) {
    if (typeof jid !== 'string' || !jid || typeof cashoutId !== 'string' || !PAYOUT_STATES.includes(state)) return false;
    return append({ t: 'payout', jid, cashoutId, state, room: String(room || ''), at: now() });
  }

  // Paid snake's floor gold at a planned restart or a crash: { key, room, why, micro, bySource }, the sources adding
  // up to micro. Written synchronously like every record; the next boot's replay books it to the house once.
  function floor(rec) {
    const r = rec || {};
    if (typeof r.key !== 'string' || !FLOOR_KEY_RE.test(r.key) || !isMicro(r.micro) || !Array.isArray(r.bySource)) {
      return false;
    }
    const bySource = r.bySource.map((s) => ({ srcWallet: s && s.srcWallet != null ? String(s.srcWallet) : null,
      srcName: String((s && s.srcName) || ''), micro: s ? s.micro : 0 }));
    return append({ t: 'floor', key: r.key, room: String(r.room || ''), why: String(r.why || ''), micro: r.micro,
      bySource, boot: bootId, at: now() });
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
    const accounts = new Map();   // jid -> { open, close, payout }
    const floors = new Map();     // key -> the floor record
    const booked = new Set();     // floor keys an earlier replay of this file already booked
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
      if (!r) continue;
      if (r.t === 'floor' && typeof r.key === 'string') {
        if (!floors.has(r.key)) floors.set(r.key, r);
        continue;
      }
      if (r.t === 'booked' && typeof r.key === 'string') {
        booked.add(r.key);
        continue;
      }
      if (typeof r.jid !== 'string') continue;
      const a = accounts.get(r.jid) || { open: null, close: null, payout: null };
      if (r.t === 'open') a.open = r;
      else if (r.t === 'close') a.close = r;
      else if (r.t === 'payout') a.payout = r;
      accounts.set(r.jid, a);
    }
    return { accounts, floors, booked, bad };
  }

  // One floor record of replay file f to the house: the booked marker into f FIRST (a file replayed again, kept for a
  // failed owed row, then skips this key), then bookFloor. false keeps the file for the next boot (nothing booked).
  function bookFloorOnce(f, rec, bookFloor) {
    const sum = Array.isArray(rec.bySource) ? rec.bySource.reduce((t, s) => t + (s && isMicro(s.micro) ? s.micro : 0), 0) : 0;
    if (!FLOOR_KEY_RE.test(rec.key) || !isMicro(rec.micro) || sum !== rec.micro) {
      log.error('[AG] JOURNAL CRITICAL floor record ' + rec.key + ' of ' + rec.micro + ' micro (' + rec.room + ') does not ' +
        'add up (sources ' + sum + '): not booked, the file is kept for Owen');
      return false;
    }
    if (typeof bookFloor !== 'function') {
      log.error('[AG] JOURNAL floor ' + rec.micro + ' micro ' + rec.room + ' ' + rec.key + ' not booked: this build books ' +
        'no paid snake floor; the file is kept');
      return false;
    }
    try {
      fsx.appendFileSync(f, JSON.stringify({ t: 'booked', key: rec.key, at: now() }) + '\n');
    } catch (e) {
      log.error('[AG] JOURNAL CRITICAL floor ' + rec.key + ' not booked, its marker could not be written (kept for the ' +
        'next boot): ' + (e && e.message));
      return false;
    }
    try {
      bookFloor(rec);
      log.warn('[AG] JOURNAL floor ' + rec.micro + ' micro ' + rec.room + ' ' + rec.key + ' booked to the house (' +
        rec.why + ')');
    } catch (e) {
      // marked booked already: never tried again, so never booked twice; Owen books it by hand from this line
      log.error('[AG] JOURNAL CRITICAL floor ' + rec.micro + ' micro ' + rec.room + ' ' + rec.key + ' marked booked but ' +
        'its booking threw, book it by hand: ' + (e && e.message));
    }
    return true;
  }

  // A paid snake door's open with no close and no seat open after it: refunded through its stake row, once (see the
  // header). -> true when the file can be marked done for this record ('owed' or 'settled'), false to keep the file.
  async function refundDoorOnce(o, refundStake, more) {
    const game = String(o.room || '').startsWith('paper_') ? 'paper' : 'slither';   // a Paper door's room is paper_*
    const reason = 'refund ' + game + ' restart before seat ' + (o.room || '') + ' journal ' + o.jid;
    let r;
    try {
      r = await refundStake(o.stakeSig, reason, o.claimKey);
    } catch (e) {
      r = 'error: ' + (e && e.message);
    }
    if (r === 'owed') {
      more.doorRefunds++;
      more.doorRefundMicro += Number.isSafeInteger(o.micro) ? o.micro : 0;
      log.warn('[AG] JOURNAL door refund owed ' + o.wallet + ' deposit ' + o.micro + ' micro room ' + o.room + ' journal ' +
        o.jid + ' stakeSig ' + o.stakeSig + ' (the server stopped after the door took the stake, before the seat)');
      return true;
    }
    if (r === 'settled') {
      more.doorSettled++;
      log.log('[AG] JOURNAL door ' + o.jid + ' stakeSig ' + o.stakeSig + ' already settled (refunded before), nothing owed');
      return true;
    }
    log.error('[AG] JOURNAL CRITICAL door refund of ' + o.wallet + ' deposit ' + o.micro + ' micro journal ' + o.jid +
      ' stakeSig ' + o.stakeSig + ' not recorded yet (' + r + '); kept for the next boot');
    return false;
  }

  // writeOwedOnce({ key, wallet, name, micro, reason }) -> promise of 'owed' | 'exists'; bookFloor(rec): a floor record
  // to the house, synchronous, called at most once per key; refundStake(sig, reason, claimKey) -> promise of 'owed' |
  // 'settled' | 'queued' (stakeLedger.refund; without it a door's open is only flagged, as before); alert(info): the
  // owner push (no wallets); returns a summary.
  async function replay({ writeOwedOnce, bookFloor, refundStake = null, alert = () => {} } = {}) {
    const out = { files: 0, owed: 0, existed: 0, failed: 0, unsettled: 0, unsettledMicro: 0 };
    const more = { floors: 0, floorMicro: 0, unconfirmed: 0, unconfirmedMicro: 0, doorRefunds: 0, doorRefundMicro: 0,
      doorSettled: 0 };
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
      const { accounts, floors, booked, bad } = parse(text);
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
        } else if (a.open && !c && a.open.door === true && typeof a.open.stakeSig === 'string' && a.open.stakeSig &&
            typeof a.open.claimKey === 'string' && a.open.claimKey && typeof refundStake === 'function') {
          if (!(await refundDoorOnce(a.open, refundStake, more))) failed++;
        } else if (a.open && !c) {
          out.unsettled++;
          out.unsettledMicro += Number.isSafeInteger(a.open.micro) ? a.open.micro : 0;
          // a paid snake's open names its stake row: Owen pays only if that row is consumed and no owed row names it
          const sig = typeof a.open.stakeSig === 'string' && a.open.stakeSig ? ' stakeSig ' + a.open.stakeSig : '';
          log.error('[AG] UNSETTLED-AT-BOOT ' + a.open.wallet + ' deposit ' + a.open.micro + ' micro room ' +
            a.open.room + ' journal ' + a.open.jid + sig +
            ' (the server was killed with this paid balance open; pay by hand)');
        } else if (c && c.outcome === 'cashedout' && c.awaitPayout === 1 && !a.payout) {
          const net = Number.isSafeInteger(c.netMicro) ? c.netMicro : 0;
          more.unconfirmed++;
          more.unconfirmedMicro += net;
          log.error('[AG] CASHOUT-UNCONFIRMED-AT-BOOT ' + (a.open ? a.open.wallet : '?') + ' net ' + net + ' micro gross ' +
            c.grossMicro + ' cashout ' + c.cashoutId + ' room ' + c.room + ' journal ' + c.jid +
            ' (the server stopped while this payout was in flight; look for the transfer on chain before paying by hand)');
        }
      }
      // the floor after the file's owed rows went through: a database that refused a player's refund this boot books
      // no house income from the same file either (the file is kept, and both go at the next boot)
      for (const rec of floors.values()) {
        if (booked.has(rec.key)) continue;
        if (failed) {
          failed++;
          log.warn('[AG] JOURNAL floor ' + rec.micro + ' micro ' + rec.room + ' ' + rec.key + ' waits for the owed rows of its file');
        } else if (bookFloorOnce(f, rec, bookFloor)) {
          more.floors++;
          more.floorMicro += rec.micro;
        } else {
          failed++;
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
    if (more.unconfirmed) {
      try {
        alert({ kind: 'cashout-unconfirmed-at-boot', accounts: more.unconfirmed, totalMicro: more.unconfirmedMicro });
      } catch (e) {
        log.error('[AG] JOURNAL alert', e && e.message);
      }
    }
    for (const k of Object.keys(more)) if (more[k]) out[k] = more[k];
    if (out.files) log.log('[AG] JOURNAL replay ' + JSON.stringify(out));
    return out;
  }

  return { open, close, payout, floor, rotate, replay, replayFiles, file };
}

module.exports = { createAgJournal, DEFAULT_FILE };
