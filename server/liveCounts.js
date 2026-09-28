'use strict';
/* PEOPLE PLAYING EACH GAME, for the little count on each lobby card.

   One number per game: every room, tier, rung and match of that game on this
   server added up, HUMANS ONLY. The board rows count bots too (a free row is
   "how many things are moving in there"), but a card that says 23 people are
   playing slither.io when 22 of them are the house's bots is simply false.

   Built from the rooms the server already holds, on the /api/live request that
   the lobby already polls. No timer, no cache, no extra state: it is a walk
   over a handful of Maps, and it exposes only counts, which the board already
   exposes per row.

   Regions: one server process runs one region, so this is that region's total.
   There is only one deployed region today, so it is also the whole total.

   Each helper below knows where one kind of room keeps its humans, because
   they do not all keep them in the same place:
     GameRoom (snake tiers, ladder rungs, the nightly event) and AgarRoom:
       `players` is the sockets in the room; bots live elsewhere (snakes/bots).
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
     agarRooms:  every AgarRoom
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
  let paper = 0;
  try { paper = src.paper && typeof src.paper.humanTotal === 'function' ? src.paper.humanTotal() : 0; }
  catch (_) { paper = 0; }
  return {
    snake: sum(src.snakeRooms, socketsIn),
    agar: sum(src.agarRooms, socketsIn),
    omgshooter: shooter,
    tanks: duelLobby(src.tanks),
    knockout: duelLobby(src.knockout),
    battleship: duelLobby(src.battleship),
    paper,
  };
}

module.exports = { liveCounts };
