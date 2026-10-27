'use strict';
/* ─── Running the place ───────────────────────────────────────────────────────
   Maintenance mode, and the state behind it.

   What a maintenance mode has to do, in the order it matters:

   1. STOP NEW PEOPLE ARRIVING. Everything else is secondary — if the door is
      still open you are chasing players out of a room they keep re-entering.
   2. TELL THEM WHY. A game that refuses to start and says nothing reads as
      broken, and a player who thinks a real-money game is broken does not come
      back. A reason and a rough time turn an outage into a wait.
   3. LET THE PEOPLE ALREADY IN FINISH. Kicking someone out of a paid game is
      taking their stake off the table mid-hand.
   4. SAY WHEN IT IS SAFE TO PULL THE PLUG, which means knowing how many people
      are still playing FOR MONEY, because they are the ones with something to
      lose. That number is the one the owner actually needs and the one no
      existing screen showed.

   Deliberately NOT here: automatically cashing everyone out on the way down.
   That is a new payout path, and a payout path built in a hurry to solve an
   operational problem is exactly the sort of thing that pays twice. The console
   refuses to call the game down while paid players are live and shows the
   number instead; waiting for a table to empty costs nothing. */

const fs = require('fs');
const path = require('path');

const state = {
  maintenance: false,
  message: '',
  since: null,
  /* Turned on for an update (the console's one-click Maintenance): the next
     boot reopens the game by itself once it is healthy (index.js). A plain
     close (the New games switch) stays closed until Open. */
  update: false,
};

/* Where a closed door is kept across a restart (persist below), and how the
   last write went. Null until the server calls persist: tests and tools that
   only flip the switch in memory never touch a file. */
let store = null;
let lastSave = { ok: true, why: null };

function get() {
  return {
    maintenance: state.maintenance,
    message: state.message,
    since: state.since,
    update: state.update,
  };
}

// Text only: anything else (a number, an object from a hand-built request) is the default line.
const cleanMessage = (m) => (typeof m === 'string' && m.trim() ? m : 'Back shortly.')
  .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);

/* `minutes` is gone: it only ever set a display time and nothing reopened the
   game when it passed, so it promised something the server never did. */
function set({ on, message, update } = {}) {
  state.maintenance = !!on;
  if (on) {
    state.message = cleanMessage(message);
    state.since = Date.now();
    state.update = update === true;
  } else {
    state.message = '';
    state.since = null;
    state.update = false;
  }
  lastSave = save();
  return get();
}

/* MAINTENANCE OUTLIVES A RESTART. It lived in memory only, so the deploy you
   closed the doors for reopened them the moment the new process started, with
   nothing on the console saying so. A close is now a small file beside the
   paid switches (server/data/, gitignored, kept by the deploy's reset), read
   once at boot; opening removes it. Same shape as the paid switches
   (slPaidBoot.createPaidSwitchStore), and it fails the same way: a file that
   cannot be read keeps the game CLOSED, because a closed door is the side of a
   mistake that costs nobody money. */
function persist({ file, fsx = fs, log = console, now = Date.now } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('ops.persist: file is required');
  store = { file, fsx, log };
  // An unreadable file is never an update close: it stays shut until the owner opens it.
  const close = (message, since, why, update) => {
    state.maintenance = true;
    state.message = cleanMessage(message);
    state.since = Number.isFinite(since) && since > 0 ? since : now();
    state.update = update === true;
    return { on: true, why, update: state.update };
  };
  let text = null;
  try {
    if (!fsx.existsSync(file)) return { on: false, why: null };
    text = fsx.readFileSync(file, 'utf8');
  } catch (e) {
    log.error('[OPS] CRITICAL maintenance file unreadable, the game starts CLOSED: ' + (e && e.message));
    return close('', null, 'unreadable');
  }
  try {
    const j = JSON.parse(text);
    if (j && j.on === true) {
      log.warn('[OPS] maintenance ON at boot: the owner\'s close outlived the restart (' + file + ')');
      return close(j.message, Number(j.since), 'owner', j.update === true);
    }
  } catch (e) { /* not ours: closed, below */ }
  log.error('[OPS] CRITICAL maintenance file is not a switch, the game starts CLOSED (' + file + ')');
  return close('', null, 'unreadable');
}

function save() {
  if (!store) return { ok: true, why: null };
  const { file, fsx, log } = store;
  try {
    if (!state.maintenance) {
      if (fsx.existsSync(file)) fsx.unlinkSync(file);
    } else {
      fsx.mkdirSync(path.dirname(file), { recursive: true });
      /* Written beside and renamed over, so a crash mid-write leaves the old
         file or the new one, never half of one (which would read as unreadable
         and keep the game closed for no reason). */
      const tmp = file + '.tmp';
      fsx.writeFileSync(tmp, JSON.stringify({ on: true, message: state.message, since: state.since, update: state.update }) + '\n');
      fsx.renameSync(tmp, file);
    }
    return { ok: true, why: null };
  } catch (e) {
    log.error('[OPS] CRITICAL maintenance not saved (' + (state.maintenance ? 'on' : 'off') + '): ' + (e && e.message));
    return { ok: false, why: (e && e.message) || 'write failed' };
  }
}

/* True while a close is on disk, so the console can say it will survive a
   restart. A store that cannot even be asked says true: assume it is there. */
function saved() {
  if (!store) return false;
  try {
    return store.fsx.existsSync(store.file);
  } catch (e) {
    return true;
  }
}

/* PAID DUEL MONEY. Knockout and Battleship hold their stakes in the lobby's
   queue and in each table's worth map, not in a room with `snakes`, so the
   drain below never saw them: it said safe to restart while a paid duel was
   seated or a paid seat was waiting for an opponent (console audit finding C),
   and a restart there strands the stake (both are outside the shutdown settle).

   Read from the lobby's own structures and nothing else: a queue entry is a
   seat already paid for (its token was spent at the door) until it is matched
   or refunded; a table holds its pot until it settles, at which point the
   payout is the lobby's settle hook's job and no longer memory only. A seat id
   starting 'bot_' is the stand-in opponent of a free table and never a person.

   lobbies: [{ queue, rooms }] (KnockoutLobby, BattleshipLobby), nulls skipped.
   -> { people, paidPeople, worth, botTables, rungs: { '<rung>': { people,
        paidPeople, bots, money } } } with money and worth in dollars. */
function duelStatus(lobbies) {
  const out = { people: 0, paidPeople: 0, worth: 0, botTables: 0, rungs: {} };
  const rungOf = (k) => {
    const key = String(Number(k) > 0 ? Number(k) : 0);
    if (!out.rungs[key]) out.rungs[key] = { people: 0, paidPeople: 0, bots: 0, money: 0 };
    return out.rungs[key];
  };
  for (const lobby of lobbies || []) {
    if (!lobby) continue;
    for (const e of Array.isArray(lobby.queue) ? lobby.queue : []) {
      if (!e) continue;
      const row = rungOf(e.stake);
      row.people++;
      out.people++;
      const w = !e.refunded && Number(e.worth) > 0 ? Number(e.worth) : 0;
      if (w > 0) { row.paidPeople++; out.paidPeople++; row.money += w; out.worth += w; }
    }
    const rooms = lobby.rooms && typeof lobby.rooms.values === 'function' ? [...lobby.rooms.values()] : [];
    for (const room of rooms) {
      if (!room || room.state === 'over') continue;
      const row = rungOf(room.stake);
      const ids = room.players && typeof room.players.keys === 'function' ? [...room.players.keys()] : [];
      const humans = ids.filter((id) => !String(id).startsWith('bot_'));
      row.people += humans.length;
      out.people += humans.length;
      if (room.bot && !(Number(room.stake) > 0)) { row.bots++; out.botTables++; }
      if (room.settled) continue;
      const pot = typeof room.pot === 'function' ? Number(room.pot()) : 0;
      if (!(pot > 0)) continue;
      row.money += pot;
      out.worth += pot;
      const worth = room.worth && typeof room.worth.get === 'function' ? room.worth : null;
      const paidHumans = worth ? humans.filter((id) => Number(worth.get(id)) > 0).length : humans.length;
      row.paidPeople += paidHumans;
      out.paidPeople += paidHumans;
    }
  }
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  out.worth = r6(out.worth);
  for (const k of Object.keys(out.rungs)) out.rungs[k].money = r6(out.rungs[k].money);
  return out;
}

/* Is it safe to take the game down right now, and if not, why not.
   `rooms` is every room object with a snakes map on it. `pending` is the paid
   entry tokens minted but not yet spent ({ count, worth }): each is a stake that
   landed in escrow and exists only in this process until its join, so a restart
   loses it. Paper floor coins and paid snake's floor gold (a room's floorWorth,
   in dollars) are the same: memory only, nobody's seat, gone on a restart. Both
   make it unsafe (review findings; PAID-SL-DESIGN.md 7.5). `duels` is
   duelStatus() above: a paid Knockout or Battleship seat, queued or at a
   table, is the same kind of money and makes it unsafe too.

   The console's v2 names (people, paidPeople, moneyInPlay, floor, pending,
   duels; money in dollars) sit beside the old ones, which the old page and
   scripts/owner-smoke.js still read. */
function drainStatus(rooms, pending, duels, extraWhy) {
  /* The old three-argument call passed the battle royale reasons third. */
  if (Array.isArray(duels)) { extraWhy = duels; duels = null; }
  let playing = 0, paid = 0, paidWorth = 0, floorWorth = 0;
  for (const room of rooms || []) {
    if (!room) continue;
    if (room.floorWorth > 0) floorWorth += room.floorWorth;
    if (!room.snakes) continue;
    for (const s of room.snakes.values()) {
      if (!s || !s.alive || s.isBot) continue;
      playing++;
      if (s.worth > 0) { paid++; paidWorth += s.worth; }
    }
  }
  const pendingCount = pending && pending.count > 0 ? pending.count : 0;
  const pendingWorth = pending && pending.worth > 0 ? pending.worth : 0;
  const duelPeople = duels && duels.people > 0 ? duels.people : 0;
  const duelPaid = duels && duels.paidPeople > 0 ? duels.paidPeople : 0;
  const duelWorth = duels && duels.worth > 0 ? duels.worth : 0;
  const why = [];
  /* Free players can be dropped without owing anybody anything; a paid one
     is holding a stake that only exists while their snake does. */
  if (paid) why.push(paid + ' player' + (paid === 1 ? ' is' : 's are') + ' still in a paid game');
  if (floorWorth > 0) why.push(Math.round(floorWorth * 1e6) / 1e6 + ' USDC on paid floors');
  if (pendingCount) why.push(pendingCount + ' paid entr' + (pendingCount === 1 ? 'y has' : 'ies have') + ' not joined yet');
  if (duelPaid || duelWorth > 0) {
    const n = duelPaid || 1;
    why.push(n + ' paid Knockout, Battleship or Swim seat' + (n === 1 ? ' holds a stake' : 's hold stakes')
      + ' (' + Math.round(duelWorth * 1e6) / 1e6 + ' USDC, queued or at a table)');
  }
  /* The caller's own reasons (a live battle royale: a restart voids it, Owen 2026-10-16). */
  if (Array.isArray(extraWhy)) for (const w of extraWhy) if (typeof w === 'string' && w) why.push(w);
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  return {
    playing,
    paid,
    paidWorth: r6(paidWorth),
    floorWorth: r6(floorWorth),
    pendingEntries: pendingCount,
    pendingWorth: r6(pendingWorth),
    people: playing + duelPeople,
    paidPeople: paid + duelPaid,
    floor: r6(floorWorth),
    pending: r6(pendingWorth),
    duels: r6(duelWorth),
    duelSeats: duelPaid,
    moneyInPlay: r6(paidWorth + floorWorth + pendingWorth + duelWorth),
    safe: why.length === 0,
    reason: why.length ? why.join('; ') : null,
  };
}

/* WHAT THE CONSOLE DID, newest first, in memory (a restart starts it again).
   Each line says who acted (the request's own account of how it was signed in:
   a session's device or 'signature') and a short copy of what was asked, so a
   bots:set or an announcement can be read back without the request itself.
   The copy is a summary, never the whole body: strings are cut short and
   anything nested is named rather than copied. */
const AUDIT_MAX = 200;
const auditLog = [];
function summarizeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const out = {};
  let n = 0;
  for (const k of Object.keys(args)) {
    if (n >= 8) break;
    const v = args[k];
    if (typeof v === 'string') out[k] = v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (v !== undefined) out[k] = '[' + (Array.isArray(v) ? 'list' : typeof v) + ']';
    else continue;
    n++;
  }
  return n ? out : undefined;
}
function audit({ action, args, who, ok, note, at } = {}) {
  const entry = {
    at: Number.isFinite(at) ? at : Date.now(),
    action: String(action || '').slice(0, 60),
    args: summarizeArgs(args),
    who: String(who || 'unknown').slice(0, 60),
    ok: !!ok,
    note: note ? String(note).slice(0, 300) : undefined,
  };
  auditLog.unshift(entry);
  if (auditLog.length > AUDIT_MAX) auditLog.length = AUDIT_MAX;
  return entry;
}

module.exports = {
  get, set, persist, saved, lastSave: () => lastSave,
  drainStatus, duelStatus,
  audit, auditLog, summarizeArgs, AUDIT_MAX,
};
