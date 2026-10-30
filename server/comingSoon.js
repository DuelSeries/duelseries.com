'use strict';
/* Coming soon (Owen 2026-10-30: agar.io "too slow", Battleship "not working well"): a built game taken off the
   lobby for a while and brought back with ONE switch in Control, the "Live / Coming soon" toggle on its row. No
   deploy either way.

   While a game is Coming soon:
   - the lobby shows its card greyed with the padlock and "Coming soon" (it reads /api/soon.js at page load and the
     `soon` list in /api/live, the same look as shared/lockedGames.js), so Play, the paid rungs, Spectate and an
     invite link (/play/<game>) are all shut;
   - its page URL answers a Coming soon page, unless somebody is still seated there (a reload must find its seat);
   - the server refuses every NEW join, free or paid, and every new watcher. A paid entry that gets that far anyway
     is refused before its token is spent (Battleship: the unspent entry refunds itself) or refunded by the game's
     own paid door (agar.io: 'not-open');
   - its bots stop: agar.io's free room is no longer held awake, so it stops ticking once nobody is in it, and the
     owner's paid agar.io bots are paused (each seed back to the Bot bank, what a bot took back to its players; their
     counts are kept, and Live brings them back).
   Nobody is kicked: a seated player plays on, resumes after a drop, cashes out and is paid as always. Leaderboards,
   history and stats are untouched.

   Unlike shared/lockedGames.js (a game that is not built at all: no room, unlocked by a deploy), the game keeps
   running for whoever is in it. The switch is saved in server/data/coming-soon.json (gitignored, kept across
   deploys), read once at boot. With no file, DEFAULT_SOON is Coming soon. A file that cannot be read fails
   CLOSED: every game here stays Coming soon. COMING_SOON_PATH moves the file. The file is per server: Control flips
   the box it talks to, and another region's box (EU, stopped today) boots with the default until flipped there.

   GAMES lists the lobby ids whose server gates are wired: server/index.js (soonPageFor, /api/soon.js, the
   <game>:soon owner actions, the Battleship queue and watch, paidDoors) and, for agar.io, agArenas.setSoon,
   agSockets and agPaidDoor. Another game needs its own gates before it is added here. */

const fs = require('fs');
const path = require('path');

const GAMES = Object.freeze({ agar: 'agar.io', battleship: 'Battleship' });
const DEFAULT_SOON = Object.freeze(['agar', 'battleship']);

// file: where the switch is saved. -> { isSoon, list, set, lockable, nameOf, saved, file }
function createComingSoon({ file, fsx = fs, log = console, now = Date.now } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('createComingSoon: file is required');
  const soon = new Map();
  for (const id of Object.keys(GAMES)) soon.set(id, DEFAULT_SOON.includes(id));

  let text = null;
  let exists = false;
  try {
    exists = fsx.existsSync(file);
    if (exists) text = fsx.readFileSync(file, 'utf8');
  } catch (e) {
    log.error('[SOON] CRITICAL coming-soon file unreadable, every lockable game stays Coming soon: ' + (e && e.message));
    for (const id of soon.keys()) soon.set(id, true);
    exists = false;
  }
  if (text !== null) {
    let j = null;
    try {
      j = JSON.parse(text);
    } catch (e) { /* not ours: closed, below */ }
    if (j && typeof j === 'object' && j.soon && typeof j.soon === 'object') {
      for (const id of soon.keys()) if (j.soon[id] === true || j.soon[id] === false) soon.set(id, j.soon[id]);
    } else {
      log.error('[SOON] CRITICAL coming-soon file is not a switch, every lockable game stays Coming soon (' + file + ')');
      for (const id of soon.keys()) soon.set(id, true);
    }
  }

  const lockable = (id) => Object.prototype.hasOwnProperty.call(GAMES, id);
  const isSoon = (id) => soon.get(id) === true;
  const list = () => Array.from(soon).filter(([, on]) => on).map(([id]) => id);

  // -> { ok, why, changed }: saved first, then kept in memory, so the switch never says one thing and the file another.
  function set(id, on) {
    if (!lockable(id)) return { ok: false, why: 'That game has no Coming soon switch', changed: false };
    const want = on === true;
    if (soon.get(id) === want && exists) return { ok: true, why: null, changed: false };
    const next = {};
    for (const [k, v] of soon) next[k] = k === id ? want : v;
    try {
      fsx.mkdirSync(path.dirname(file), { recursive: true });
      fsx.writeFileSync(file, JSON.stringify({ soon: next, at: new Date(now()).toISOString() }) + '\n');
      exists = true;
    } catch (e) {
      log.error('[SOON] CRITICAL coming-soon switch not saved (' + id + ' ' + (want ? 'on' : 'off') + '): ' + (e && e.message));
      return { ok: false, why: (e && e.message) || 'write failed', changed: false };
    }
    const changed = soon.get(id) !== want;
    soon.set(id, want);
    return { ok: true, why: null, changed };
  }

  return { isSoon, list, set, lockable, nameOf: (id) => GAMES[id] || id, saved: () => exists, file };
}

module.exports = { createComingSoon, GAMES, DEFAULT_SOON };
