'use strict';
// The battle royale's room directory on the sl engine: the free room's directory (server/sl/slArenas.js: one room,
// its bot driver, the door, the replace-on-close) holding ONE room built with the event's match (brMatch, slRoom
// opts.br). It shares the free directory's bot governor (one core, one bot budget) and reports its slice to it
// (maxSliceMs, the free directory's extraLoad), so it runs no governor timer of its own.
//
// slSockets reaches it through setBr: a socket whose handshake says br 1 is seated here (join), or watches (watch) when
// it also says watch 1. It is never a board row: /api/live carries the event in its own br field (match.publicState).
//
//   match            the battle royale (state, winner, startMatch, abandon, publicState, ...: what server/index.js
//                    reads as the event's room when it runs on this engine)
//   join(socket, info)   info { nick, cv, wallet }: true or the refusal ('closed', 'match', 'full')
//   watch(socket, info)  info { follow }: true or 'closed' / 'nobody' (nothing alive to watch)
//   maxSliceMs()     the room's largest synchronous slice since the last call, read and reset

const { SlArenas } = require('../sl/slArenas');
const { SlRoom } = require('../sl/slRoom');
const { createBrMatch } = require('./brMatch');

// An empty replacement room is started at most this often (see _replace).
const RESTART_GAP_MS = 60 * 1000;

class SlBrArena extends SlArenas {
  // opts: SlArenas' (region, governor, seed, clock, now, timers, autoTick, view, prey, log, bots) plus onDecided(match)
  // (the server's prize hook), lastStore (brLastPodium.js: the last match's podium across restarts) and rand (tests).
  constructor(laws, opts) {
    const o = opts || {};
    const region = typeof o.region === 'string' && o.region ? o.region : 'na';
    const label = 'sl_' + region + '_br';
    const match = createBrMatch({ laws, log: o.log, label, onDecided: o.onDecided, rand: o.rand, now: o.now,
      isOwner: o.isOwner, lastStore: o.lastStore, journal: o.journal, onVoided: o.onVoided });
    super(laws, Object.assign({}, o, {
      makeRoom: (ro) => new SlRoom(laws, Object.assign({}, ro, { br: match, lobbyType: label })),
      botOpts: { holdFill: () => match.holdFill() },
    }));
    this.match = match;
    this.label = label;
    this.running = false;
    this.restartedAt = -Infinity;
  }

  // A room that closed itself is replaced; a match in it is over with no winner (nobody is paid for a crash).
  _replace(closed, sockets) {
    if (this.match && closed === this._room && this.match.state !== 'waiting') {
      try {
        this.match.abandon('the room was replaced');
      } catch (e) {
        this.log.error('[BR] abandon on replace: ' + (e && e.message));
      }
    }
    super._replace(closed, sockets);
    // Start the replacement when people were in the room, or at most once a minute otherwise: a fault that repeats on
    // every wake of an empty room must not become a create, fail, close loop (review 2026-10-15).
    const t = typeof this.opts.now === 'function' ? this.opts.now() : Date.now();
    const people = Array.isArray(sockets) && sockets.length > 0;
    if (this.running && this._room && this._room !== closed && (people || !(t - this.restartedAt < RESTART_GAP_MS))) {
      this.restartedAt = t;
      this._room.start();
    }
  }

  // Ticks the room now, before anybody sits in it (the server calls this at boot): the bots fill it to the day's
  // curve, then the idle pause keeps them, so a person who arrives at 8:04 pm walks into a full arena rather than
  // an empty one that a slot's start would lock (the old room ticked from boot the same way). A replacement room
  // is started too.
  startRoom() {
    this.running = true;
    if (this._room) this._room.start();
  }

  // A watcher costs a view and a send queue like a seat, so they are capped as seats are (C_HUMAN_CAP): watchers are
  // not players, so the players' cap never counts them, and without this the only bound was the per-address one.
  watch(socket, info) {
    if (!this.isOpen()) return 'closed';
    const room = this._room;
    if (room.watchers.size >= room.R.humanCap) return 'full';
    return room.seatWatch(socket, info) ? true : 'nobody';
  }

  boardRows() {
    return [];
  }

  maxSliceMs() {
    const r = this._room;
    if (!r || !r.stats) return 0;
    const s = Number.isFinite(r.stats.maxSliceMs) ? r.stats.maxSliceMs : 0;
    r.stats.maxSliceMs = 0;
    return s;
  }
}

module.exports = { SlBrArena };
