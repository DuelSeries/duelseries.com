'use strict';
/* ─── Getting two players onto an Air Hockey table ────────────────────────────
   Knockout's queue, exactly (server/KnockoutLobby.js and server/duelQueue.js),
   the same way Head Soccer uses it: a free seat waits with a countdown, then
   gets a bot the screen calls a bot; a paid seat never gets a bot, keeps waiting
   with a Cancel that refunds at once, and is refunded if it is abandoned; two
   people only meet at the same rung; a restart turns every held paid seat into
   an owed refund row. None of that is copied here. This file only says what is
   different about Air Hockey: its room, its event names, a 60 Hz clock, when a
   bot match is still young enough to pull its human out of, and the bot. */

const { KnockoutLobby } = require('./KnockoutLobby');
const { RECONNECT_GRACE_MS } = require('./duelQueue');
const { AirHockeyRoom } = require('./AirHockeyRoom');
const ahBot = require('./ahBot');
const { AH } = require('../shared/ahSim');

const TICK_MS = 1000 / 60;
const RESCUE_PLAYED_MS = 10000;   // a bot match 0-0 and under ten seconds old can still be swapped for a person

class AirHockeyLobby extends KnockoutLobby {
  constructor(io) {
    super(io, { ev: 'ah', game: 'airhockey', tag: '[AH]', Room: AirHockeyRoom, graceMs: RECONNECT_GRACE_MS });   // a dropped seat is held 5 s
  }

  /* The table runs in real time, so the lobby ticks at the physics rate. The room catches up in fixed steps from
     the time that actually passed, so a late wake costs smoothness, never speed. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  earlyEnough(room) {
    if (room.state === 'countdown') return true;
    if (room.state !== 'playing' || !room.match) return false;
    const played = AH.MATCH_MS - room.msLeft;
    return played < RESCUE_PLAYED_MS && room.score[0] === 0 && room.score[1] === 0;
  }

  botAim(room, now) {
    if (!room.bot) return;
    try { ahBot.drive(room, now); } catch (e) { console.error('[AH] bot failed:', e.message); }
  }
}

AirHockeyLobby.PAID_WAIT_MS = KnockoutLobby.PAID_WAIT_MS;
AirHockeyLobby.FREE_WAIT_MS = KnockoutLobby.FREE_WAIT_MS;
AirHockeyLobby.WATCH_CAP = KnockoutLobby.WATCH_CAP;

module.exports = { AirHockeyLobby };
