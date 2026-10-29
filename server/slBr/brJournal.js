'use strict';
// What the battle royale must not forget across a restart (Owen 2026-10-16: a restart mid-match voids it and tells him,
// and a restart must never double-pay or lose the prize). One small file beside br-last-podium.json (server/data/ is
// gitignored and survives the deploy's reset), written whole to a temp file and renamed, so a crash mid-write never
// leaves half of it.
//
//   live     the match counting down or running ({ matchId, startedAt, seats, wallets, people }), cleared when it is
//            decided or stopped. Found at boot it means a restart cut the match off: index.js voids it and pushes Owen.
//   autoDay  the slot (YYYY-MM-DDTHH, Eastern) the 6 hour timer last went off (started a match or found one running), so a restart in the
//            slot's hour does not fire it a second time (a plain day from before the 6 hour schedule matches no slot).
//   prizes   the last PRIZES_KEPT prizes by match id: 'paying' is written BEFORE the money is sent, then 'paid' (with
//            the signature) or 'failed'. A 'paying' found at boot means the send may or may not have landed: index.js
//            pushes Owen to check before settling by hand, marks it 'unknown', and NEVER sends it again. Every match id
//            here is also never paid again by this process (payBattleRoyaleWinner's latch is seeded from it).
//            (night review 2026-10-29, second pass) 'checking' is written BEFORE the database lookup that decides
//            whether the prize is paid automatically, then 'paying' or 'held'. A 'checking' found at boot means the
//            decision was cut off and nothing was sent (the send starts only after 'paying'): index.js pushes Owen to
//            settle it by hand and marks it 'held'. net is the network the winner played from: the one-automatic-
//            prize-a-week rule (brPrizeRule recentPrize) reads wallet, net and at.
//
//   file  the journal file;  fsx  fs (tests)
// -> { live(), setLive(rec|null), autoDay(), setAutoDay(day), prize(id), setPrize(id, patch), prizes(), file }

const fs = require('fs');
const path = require('path');

// 100, not 30 (night review 2026-10-29): held decisions are written too now, and brPrizeRule's cooldown reads a week
// of automatic prizes (four slots a day, plus Owen's own starts)
const PRIZES_KEPT = 100;
const PRIZE_STATES = new Set(['checking', 'paying', 'paid', 'failed', 'unknown', 'held']);
const TEXT_MAX = 200;

const str = (v, max) => (typeof v === 'string' && v.length <= (max || TEXT_MAX) ? v : null);

function cleanLive(j) {
  if (!j || typeof j !== 'object' || !str(j.matchId, 64)) return null;
  const people = Array.isArray(j.people) ? j.people.filter((p) => str(p, 40) !== null).slice(0, 50) : [];
  return {
    matchId: j.matchId,
    startedAt: str(j.startedAt, 40),
    seats: Number.isInteger(j.seats) && j.seats >= 0 ? j.seats : 0,
    wallets: Number.isInteger(j.wallets) && j.wallets >= 0 ? j.wallets : 0,
    people,
  };
}

function cleanPrize(j) {
  if (!j || typeof j !== 'object' || !str(j.matchId, 64) || !PRIZE_STATES.has(j.state)) return null;
  return {
    matchId: j.matchId,
    state: j.state,
    wallet: str(j.wallet, 64),
    net: str(j.net, 64),
    name: str(j.name, 40),
    amount: Number.isFinite(j.amount) ? j.amount : 0,
    sig: str(j.sig, 128),
    error: str(j.error),
    at: str(j.at, 40),
  };
}

function clean(j) {
  const out = { live: null, autoDay: null, prizes: [] };
  if (!j || typeof j !== 'object') return out;
  out.live = j.live ? cleanLive(j.live) : null;
  out.autoDay = str(j.autoDay, 20);
  if (Array.isArray(j.prizes)) {
    for (const p of j.prizes) {
      const c = cleanPrize(p);
      if (c) out.prizes.push(c);
    }
  }
  out.prizes = out.prizes.slice(-PRIZES_KEPT);
  return out;
}

function createBrJournal({ file, fsx = fs, log = console, now = Date.now } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('createBrJournal: file is required');
  let data = { live: null, autoDay: null, prizes: [] };
  try {
    if (fsx.existsSync(file)) data = clean(JSON.parse(fsx.readFileSync(file, 'utf8')));
  } catch (e) {
    log.error('[BR] journal unreadable (' + file + '), starting empty: ' + (e && e.message));
  }

  function write() {
    const tmp = file + '.tmp';
    try {
      fsx.mkdirSync(path.dirname(file), { recursive: true });
      fsx.writeFileSync(tmp, JSON.stringify(data) + '\n');
      fsx.renameSync(tmp, file);
      return true;
    } catch (e) {
      log.error('[BR] journal NOT written (' + file + '): ' + (e && e.message));
      return false;
    }
  }

  return {
    file,
    live: () => (data.live ? Object.assign({}, data.live) : null),
    setLive(rec) {
      data.live = rec ? cleanLive(rec) : null;
      return write();
    },
    autoDay: () => data.autoDay,
    setAutoDay(day) {
      data.autoDay = str(day, 20);
      return write();
    },
    prize(matchId) {
      const p = data.prizes.find((x) => x.matchId === matchId);
      return p ? Object.assign({}, p) : null;
    },
    // merges patch into the match's entry (made if new); returns whether it reached the disk
    setPrize(matchId, patch) {
      const i = data.prizes.findIndex((x) => x.matchId === matchId);
      const merged = cleanPrize(Object.assign({}, i >= 0 ? data.prizes[i] : {}, patch, { matchId,
        at: new Date(now()).toISOString() }));
      if (!merged) return false;
      if (i >= 0) data.prizes[i] = merged;
      else data.prizes.push(merged);
      data.prizes = data.prizes.slice(-PRIZES_KEPT);
      return write();
    },
    prizes: () => data.prizes.map((p) => Object.assign({}, p)),
  };
}

module.exports = { createBrJournal, PRIZES_KEPT };
