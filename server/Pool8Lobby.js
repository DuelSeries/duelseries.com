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
const crypto = require('crypto');
const pool8Bot = require('./pool8Bot');
const { DUEL_HOUSE_CUT } = require('./duelMoney');

class Pool8Lobby extends KnockoutLobby {
  constructor(io) {
    super(io, { ev: 'p8', game: 'pool8', tag: '[P8]', Room: Pool8Room });
  }

  earlyEnough(room) {
    return room.state === 'countdown' || (room.state === 'aiming' && (room.turn || 0) === 0);
  }

  /* A RESTART IN THE RESULT HOLD PAYS THE RESULT. A paid match decided by its last shot sits in 'settling' while the
     balls roll out (up to about 28 s). Knockout's shutdown rows would refund both seats there, paying the winner their
     stake instead of the prize and handing the loser back a stake they lost (Fable and Opus reviews 2026-10-28). So a
     decided table is settled here first: ONE owed row to the winner for the pot less the house cut, journaled first
     like every owed row, and nothing for the loser; the table is marked settled, so the rows below skip it. */
  shutdownSettle(why) {
    const rows = [];
    const tag = String(why || 'shutdown');
    for (const room of this.rooms.values()) {
      if (!(room.stake > 0) || room.settled || room.state !== 'settling' || !room.pending) continue;
      const id = room.socketOfSide(room.pending.winner);
      const p = id ? room.players.get(id) : null;
      if (!p || !p.wallet) continue;                  // no winner to pay: the refund rows below cover it
      const pot = room.pot();
      const micro = Math.round((pot - pot * DUEL_HOUSE_CUT) * 1e6);
      if (!(micro > 0)) continue;
      room.settled = true;
      const uuid = crypto.randomUUID();
      const key = 'agowed:' + uuid;
      const row = { key, wallet: p.wallet, micro, name: p.name || 'Player',
                    reason: `prize pool8 ${tag} decided ${key}` };
      if (this.journal && typeof this.journal.close === 'function') {
        try {
          this.journal.close({ jid: 'pool8-' + uuid, wallet: p.wallet, name: row.name }, 'refunded',
            { why: tag === 'crash' ? 'crash' : 'shutdown', key, refundedMicro: micro, reason: row.reason }, room.id);
        } catch (_) { /* the journal never throws into a money path; the row still goes */ }
      }
      rows.push(row);
      console.warn(this.tag + ' ' + room.id + ' decided in the hold at ' + tag + ': owed ' + (micro / 1e6).toFixed(2) + ' to ' + row.name);
    }
    return rows.concat(super.shutdownSettle(why));
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
