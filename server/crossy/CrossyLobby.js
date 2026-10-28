'use strict';
/* ─── Getting two players onto one Crossy Road map ────────────────────────────
   Knockout's queue, exactly (server/KnockoutLobby.js and server/duelQueue.js):
   a free seat waits with a countdown, then gets a bot that the screen calls a
   bot; a paid seat never gets a bot, keeps waiting with a Cancel that refunds
   at once, and is refunded if it is abandoned; two people only meet at the same
   rung; a restart turns every held paid seat into an owed refund row. None of
   that is copied here. This file only says what is different about Crossy
   Road: its room, its event names, a 60 Hz clock, and when a bot match is still
   young enough to pull its human out of. The bot drives its own seat inside the
   room (CrossyRoom.advance), so there is nothing to aim. */

const { KnockoutLobby } = require('../KnockoutLobby');
const { CrossyRoom } = require('./CrossyRoom');

const TICK_MS = 1000 / 60;
const RESCUE_TICKS = 5 * 60;      // a bot match under five seconds old can still be swapped for a person

class CrossyLobby extends KnockoutLobby {
  constructor(io) {
    super(io, { ev: 'cr', game: 'crossy', tag: '[CR]', Room: CrossyRoom });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  earlyEnough(room) {
    if (room.state === 'countdown') return true;
    if (room.state !== 'playing') return false;
    for (const p of room.players.values()) if (!p.cr.h.alive) return false;
    return room.clock < RESCUE_TICKS;
  }

  botAim() {}
}

CrossyLobby.PAID_WAIT_MS = KnockoutLobby.PAID_WAIT_MS;
CrossyLobby.FREE_WAIT_MS = KnockoutLobby.FREE_WAIT_MS;
CrossyLobby.WATCH_CAP = KnockoutLobby.WATCH_CAP;

module.exports = { CrossyLobby };
