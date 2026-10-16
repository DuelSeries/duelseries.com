'use strict';
// The battle royale's last finished match, kept across restarts (Owen 2026-10-16: the Events tab shows the last
// match's top 3 all day while waiting, and every deploy emptied it back to question marks). A small file beside the
// money journal (server/data/ is gitignored and survives the deploy's reset), as the owner's saved switches are
// (slPaidBoot.createPaidSwitchStore). brMatch reads it once when it is built and writes it when a match is decided.
//
// What it holds is for showing only: the podium's names, the winner's name, and the prize, soloRun and prizeHeld the
// match's publicState reported. No wallet, no snake id and no match id is kept, so nothing that pays (index.js
// payBattleRoyaleWinner reads the match's own winner and matchId) can ever see a restored match.
//
//   file   the podium file;  fsx  fs (tests)
// -> { load() -> record or null, save(record) -> true when written, file }

const fs = require('fs');
const path = require('path');

const NAME_MAX = 40; // longer than any nick the game seats; a bigger one is not ours

function cleanName(n) {
  return typeof n === 'string' && n.length <= NAME_MAX ? n : null;
}

// A record as brMatch reports it, or null when the shape is not one this file writes.
function cleanRecord(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.podium) || j.podium.length > 3) return null;
  const podium = [];
  for (let i = 0; i < j.podium.length; i++) {
    const p = j.podium[i];
    const name = p && cleanName(p.name);
    if (name === null) return null;
    podium.push({ place: i + 1, name, score: Number.isFinite(p.score) ? p.score : 0 });
  }
  const winner = j.winner === null ? null : cleanName(j.winner);
  if (winner === null && j.winner !== null) return null;
  if (!Number.isFinite(j.prize) || j.prize < 0) return null;
  return { podium, winner, prize: j.prize, soloRun: j.soloRun === true, prizeHeld: j.prizeHeld === true,
    endedAt: typeof j.endedAt === 'string' ? j.endedAt : null };
}

function createLastPodiumStore({ file, fsx = fs, log = console } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('createLastPodiumStore: file is required');
  function load() {
    let text;
    try {
      if (!fsx.existsSync(file)) return null;
      text = fsx.readFileSync(file, 'utf8');
    } catch (e) {
      log.warn('[BR] last podium unreadable, the Events tab starts empty: ' + (e && e.message));
      return null;
    }
    let rec = null;
    try {
      rec = cleanRecord(JSON.parse(text));
    } catch (e) { /* not ours: below */ }
    if (!rec) log.warn('[BR] last podium file is not a podium, ignored (' + file + ')');
    return rec;
  }
  // written whole to a temp file and renamed over the old one, so a crash mid-write never leaves half a podium
  function save(record) {
    const rec = cleanRecord(record);
    if (!rec) return false;
    const tmp = file + '.tmp';
    try {
      fsx.mkdirSync(path.dirname(file), { recursive: true });
      fsx.writeFileSync(tmp, JSON.stringify(rec) + '\n');
      fsx.renameSync(tmp, file);
      return true;
    } catch (e) {
      log.warn('[BR] last podium not saved (it is lost at the next restart): ' + (e && e.message));
      return false;
    }
  }
  return { load, save, file };
}

module.exports = { createLastPodiumStore, cleanRecord };
