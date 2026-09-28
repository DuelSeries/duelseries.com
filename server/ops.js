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

const state = {
  maintenance: false,
  message: '',
  until: null,          // epoch ms, or null for "no estimate"
  since: null,
};

function get() {
  return {
    maintenance: state.maintenance,
    message: state.message,
    until: state.until,
    since: state.since,
  };
}

function set({ on, message, minutes }) {
  state.maintenance = !!on;
  if (on) {
    state.message = String(message || 'Back shortly.').slice(0, 200);
    state.until = minutes ? Date.now() + Number(minutes) * 60000 : null;
    state.since = Date.now();
  } else {
    state.message = '';
    state.until = null;
    state.since = null;
  }
  return get();
}

/* Is it safe to take the game down right now, and if not, why not.
   `rooms` is every room object with a snakes map on it. `pending` is the paid
   entry tokens minted but not yet spent ({ count, worth }): each is a stake that
   landed in escrow and exists only in this process until its join, so a restart
   loses it. Paper floor coins (a room's floorWorth) are the same: memory only,
   nobody's seat, gone on a restart. Both make it unsafe (review findings). */
function drainStatus(rooms, pending) {
  let playing = 0, paid = 0, paidWorth = 0, floorWorth = 0;
  for (const room of rooms) {
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
  const why = [];
  /* Free players can be dropped without owing anybody anything; a paid one
     is holding a stake that only exists while their snake does. */
  if (paid) why.push(paid + ' player' + (paid === 1 ? ' is' : 's are') + ' still in a paid game');
  if (floorWorth > 0) why.push(Math.round(floorWorth * 1e6) / 1e6 + ' USDC on Paper floors');
  if (pendingCount) why.push(pendingCount + ' paid entr' + (pendingCount === 1 ? 'y has' : 'ies have') + ' not joined yet');
  return {
    playing,
    paid,
    paidWorth: Math.round(paidWorth * 1e6) / 1e6,
    floorWorth: Math.round(floorWorth * 1e6) / 1e6,
    pendingEntries: pendingCount,
    pendingWorth: Math.round(pendingWorth * 1e6) / 1e6,
    safe: why.length === 0,
    reason: why.length ? why.join('; ') : null,
  };
}

module.exports = { get, set, drainStatus };
