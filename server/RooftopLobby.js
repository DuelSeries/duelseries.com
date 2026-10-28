'use strict';
/* ─── Getting two players onto a Rooftop Snipers roof ─────────────────────────
   Knockout's queue, exactly (server/KnockoutLobby.js and server/duelQueue.js):
   a free seat waits a minute with a countdown, then gets a bot that the screen
   calls a bot; a paid seat never gets a bot, keeps waiting past its minute with
   a Cancel that refunds at once, and is refunded after PAID_GIVE_UP_MS if it is
   abandoned; two people only meet at the same rung; a restart turns every held
   paid seat into an owed refund row. None of that is copied here. This file
   only says what is different about Rooftop Snipers: its room, its event names,
   a 60 Hz clock instead of a 5 Hz one, when a bot match is still young enough
   to pull its human out of, and the bot that presses the buttons. */

const { KnockoutLobby } = require('./KnockoutLobby');
const { RooftopRoom } = require('./RooftopRoom');
const rtBot = require('./rtBot');

const TICK_MS = 1000 / 60;
const RESCUE_PLAYED_TICKS = 600;   // a bot match 0-0 and under ten seconds old can still be swapped for a person

class RooftopLobby extends KnockoutLobby {
  constructor(io) {
    super(io, { ev: 'rt', game: 'rooftop', tag: '[RT]', Room: RooftopRoom });
  }

  /* The roof runs in real time, so the lobby ticks at the physics rate. The room catches up in fixed steps from the
     time that actually passed, so a late wake costs smoothness, never speed. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  earlyEnough(room) {
    if (room.state === 'countdown') return true;
    if (room.state !== 'playing' || !room.match) return false;
    const m = room.match;
    return m.round === 1 && m.score[0] === 0 && m.score[1] === 0 && m.tick < RESCUE_PLAYED_TICKS;
  }

  botAim(room, now) {
    if (!room.bot) return;
    try { rtBot.drive(room, now); } catch (e) { console.error('[RT] bot failed:', e.message); }
  }
}

RooftopLobby.PAID_WAIT_MS = KnockoutLobby.PAID_WAIT_MS;
RooftopLobby.FREE_WAIT_MS = KnockoutLobby.FREE_WAIT_MS;
RooftopLobby.WATCH_CAP = KnockoutLobby.WATCH_CAP;

module.exports = { RooftopLobby };
