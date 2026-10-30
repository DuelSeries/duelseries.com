'use strict';
/* The owner's Start, one rule for every door to it: the console and the Events
   tab (/api/owner/do 'br:start') and the in-game button (socket br:start), all
   owner-signed. ONE MATCH AT A TIME (Owen 2026-10-16): only a waiting arena
   starts one; while a match counts down or runs, or is finishing (one snake
   left, the winner's moment and the circle reopening), the answer is no, for
   the owner too. On the sl engine a match may start with bots alone (brMatch
   MIN_SNAKES). The arena's own state after the call is the answer, so a start
   that did nothing is never reported as one. -> { ok, note } or { ok: false, why }

   Its own file (moved from server/index.js, unchanged) so the slither process of
   the server split, which holds the battle royale's room then, starts a match by
   the same rule. It reads and starts the room only: no money, no prize. */
function ownerStartBr(room, force) {
  if (!room) return { ok: false, why: 'No battle royale room' };
  if (room.state === 'countdown' || room.state === 'running') {
    return { ok: false, why: 'A match is already running. You can start the next one once a single snake is left.' };
  }
  if (room.state === 'over' || room.state === 'reopening') {
    return { ok: false, why: 'The last match is finishing. Try again in a few seconds.' };
  }
  if (room.state !== 'waiting') return { ok: false, why: 'A match is already under way' };
  // people, not snakes: bots wait in the arena now, and forceStart refuses a room with no human (BattleRoyaleRoom)
  const humans = typeof room.humanLiving === 'function' ? room.humanLiving() : room.livingCount();
  if (force && humans < 1) return { ok: false, why: 'Nobody is in the room to start with' };
  if (force) room.forceStart('owner override');
  else if (room.canStart()) room.startMatch('owner');
  if (room.state === 'waiting') {
    return { ok: false, why: room.engine === 'sl'
      ? 'The arena is empty: a match needs ' + room.publicState().minPlayers + ' snakes, bots count.'
      : 'Needs ' + room.publicState().minPlayers + ' players' };
  }
  const people = typeof room.humanLiving === 'function' ? room.humanLiving() : room.livingCount();
  return { ok: true, note: 'Started with ' + people + ' player(s) and ' + Math.max(0, room.livingCount() - people) + ' bot(s)' };
}

module.exports = { ownerStartBr };
