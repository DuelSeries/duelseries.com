'use strict';
/* PLAYING EACH GAME, for the little count on each lobby card.

   One number per game, and it has to agree with the Open lobbies rows on the
   same screen. Those rows count players PLUS bots (board.js explains why: bots
   only exist in free rooms, where nothing is staked). A card that said 0 right
   above a row saying "20 playing" read as broken, so the card is built as:

     every HUMAN in every room of that game on this server (tiers, rungs, the
     nightly event, paid rooms not on the board), plus the BOTS in that game's
     board rows (withBoardBots, from the very rows /api/live sends).

   So the card is never smaller than a row of its own game, equals the rows'
   total when every human is in a listed room, and bots in rooms nobody can see
   from this screen (a legacy tier, the event lobby between matches) are not
   counted as players.

   Built from the rooms the server already holds, on the /api/live request that
   the lobby already polls. No timer, no cache, no extra state: it is a walk
   over a handful of Maps, and it exposes only counts, which the board already
   exposes per row.

   Regions: one server process runs one region, so this is that region's total.
   There is only one deployed region today, so it is also the whole total.

   Each helper below knows where one kind of room keeps its humans, because
   they do not all keep them in the same place:
     GameRoom (snake tiers, ladder rungs, the nightly event):
       `players` is the sockets in the room; bots live elsewhere (snakes).
     agar.io (server/ag AgArenas) and Paper (PaperArenas): the registry counts
       its own humans, humanTotal(). For agar.io that is everybody who pressed
       Play, in every room; bots and watchers on the menu are not players.
     ShooterRoom: humans() counts the tanks that are not bots.
     Tanks, Knockout, Battleship: a queue of people waiting, plus rooms whose
       `players` map CAN hold a bot stand-in whose id starts with bot_. */

const isBotId = id => String(id).startsWith('bot_');

function socketsIn(room) {
  return room && room.players && typeof room.players.size === 'number' ? room.players.size : 0;
}

function humansInPlayers(room) {
  let n = 0;
  if (room && room.players && typeof room.players.keys === 'function') {
    for (const id of room.players.keys()) if (!isBotId(id)) n++;
  }
  return n;
}

/* A queue-and-rooms lobby: whoever is waiting plus the humans already in a match. */
function duelLobby(lobby) {
  if (!lobby) return 0;
  let n = Array.isArray(lobby.queue) ? lobby.queue.filter(e => !(e && e.socket && isBotId(e.socket.id))).length : 0;
  if (lobby.rooms && typeof lobby.rooms.values === 'function') {
    for (const r of lobby.rooms.values()) n += humansInPlayers(r);
  }
  return n;
}

/* Everything is optional, so a game whose rooms are missing reports 0 rather
   than taking /api/live down with it.
     snakeRooms: every GameRoom of the snake game (fixed tiers, event, rungs)
     agar:       the agar.io AgArenas registry (server/ag), null while it is closed
     shooter:    the Awesome Tanks arena
     tanks, knockout, battleship: the duel lobbies
     paper:      the PaperArenas registry */
function liveCounts(src = {}) {
  const sum = (rooms, per) => (rooms || []).reduce((n, r) => n + (r ? per(r) : 0), 0);
  let shooter = 0;
  try {
    if (src.shooter) {
      shooter = typeof src.shooter.humans === 'function' ? src.shooter.humans()
        : (src.shooter.playerCount || 0);
    }
  } catch (_) { shooter = 0; }
  let agar = 0;
  try { agar = src.agar && typeof src.agar.humanTotal === 'function' ? src.agar.humanTotal() : 0; }
  catch (_) { agar = 0; }
  let paper = 0;
  try { paper = src.paper && typeof src.paper.humanTotal === 'function' ? src.paper.humanTotal() : 0; }
  catch (_) { paper = 0; }
  return {
    snake: sum(src.snakeRooms, socketsIn),
    agar,
    omgshooter: shooter,
    tanks: duelLobby(src.tanks),
    knockout: duelLobby(src.knockout),
    battleship: duelLobby(src.battleship),
    paper,
  };
}

/* Adds the bots of each game's board rows to its human count, so the card and
   the rows agree. rows: the /api/live lobbies and extras, { game, bots }. A
   game with no human count (not a key of counts) is left alone rather than
   invented. */
function withBoardBots(counts, rows) {
  if (!counts || typeof counts !== 'object') return counts;
  const out = Object.assign({}, counts);
  for (const r of rows || []) {
    if (!r || !Object.prototype.hasOwnProperty.call(out, r.game)) continue;
    const b = Number(r.bots);
    if (Number.isFinite(b) && b > 0) out[r.game] += Math.floor(b);
  }
  return out;
}

module.exports = { liveCounts, withBoardBots };
