'use strict';
/* ─── Getting two players onto an 8 Ball Pool table ───────────────────────────
   Knockout's queue, exactly (server/KnockoutLobby.js and server/duelQueue.js):
   a free seat waits with a countdown, then gets a bot that the screen calls a
   bot; a paid seat never gets a bot, keeps waiting with a Cancel that refunds at
   once, and is refunded if it is abandoned; two people only meet at the same
   rung; a restart turns every held paid seat into an owed refund row. None of
   that is copied here. This file only says what is different about pool: its
   room, its event names, when a bot match is still young enough to pull its
   human out of (before the break is taken), and the bot that takes its shots.
   Turn based, so Knockout's 5 Hz lobby clock is plenty. */

const { KnockoutLobby } = require('./KnockoutLobby');
const { Pool8Room } = require('./Pool8Room');
const pool8Bot = require('./pool8Bot');

class Pool8Lobby extends KnockoutLobby {
  constructor(io) {
    super(io, { ev: 'p8', game: 'pool8', tag: '[P8]', Room: Pool8Room });
  }

  earlyEnough(room) {
    return room.state === 'countdown' || (room.state === 'aiming' && (room.turn || 0) === 0);
  }

  botAim(room, now) {
    if (!room.bot) return;
    try { pool8Bot.drive(room, now); } catch (e) { console.error('[P8] bot failed:', e.message); }
  }
}

Pool8Lobby.PAID_WAIT_MS = KnockoutLobby.PAID_WAIT_MS;
Pool8Lobby.FREE_WAIT_MS = KnockoutLobby.FREE_WAIT_MS;
Pool8Lobby.WATCH_CAP = KnockoutLobby.WATCH_CAP;

module.exports = { Pool8Lobby };
