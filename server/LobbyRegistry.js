'use strict';
/* ─── Lobbies created on demand, keyed on the exact stake ─────────────────────
   Fixed tiers fail because the tiers are chosen up front, are always present,
   and are usually empty. A lobby here exists because a real player created it,
   so an empty one is a lobby that just started rather than a permanent ghost
   town, and it is withdrawn once it has been empty for a while.

   The key is (game, region, stake). Everyone in a room paid the same amount, so
   entry is symmetric and the existing eat-and-take money rule needs no transfer
   cap or side-pot rule. A $0.50 player and a $20 player are never in the same
   room because they are never in the same key.

   Two rules protect players from the sweeper:
     - a lobby with anyone in it is never withdrawn
     - the free lobby for a game and region is permanent, so the board always
       has something joinable even with nobody online
   A third is enforced by the caller: a lobby with an unspent entry token
   against it must be held, or a player who has already paid arrives to find no
   room. See hold()/release(). */

class LobbyRegistry {
  constructor({ makeRoom, emptyMs = 120000 }) {
    if (typeof makeRoom !== 'function') throw new Error('makeRoom is required');
    this.makeRoom = makeRoom;
    this.emptyMs = emptyMs;
    this.rooms = new Map();
  }

  /* Stakes are money, so the key is built from a fixed 2dp string rather than a
     float. 0.1 + 0.2 keys must not produce a different room from 0.3. */
  key(game, region, stake) {
    return game + ':' + region + ':' + Number(stake).toFixed(2);
  }

  get(game, region, stake) {
    const k = this.key(game, region, stake);
    let e = this.rooms.get(k);
    if (!e) {
      e = {
        game, region, stake: Number(stake),
        room: this.makeRoom(game, region, Number(stake)),
        /* Left unset rather than stamped with Date.now(): the sweeper owns the
           clock, and mixing the two means a room created at wall-clock time is
           measured against a sweep time that may not share an origin. A new
           room is marked empty by the first sweep that finds it empty, which
           also gives it a full grace period to be joined. */
        emptySince: null,
        holds: 0,
      };
      if (typeof e.room.start === 'function') e.room.start();
      this.rooms.set(k, e);
    }
    return e.room;
  }

  /* Between paying and arriving, a player owns a seat in a room that may still
     be empty. Holding it stops the sweeper taking the room out from under a
     stake that has already settled on-chain. */
  hold(game, region, stake) {
    this.get(game, region, stake);
    const e = this.rooms.get(this.key(game, region, stake));
    e.holds++;
    return () => { if (e.holds > 0) e.holds--; };
  }

  list() {
    const out = [];
    for (const e of this.rooms.values()) {
      out.push({
        id: this.key(e.game, e.region, e.stake),
        game: e.game, region: e.region, stake: e.stake,
        players: e.room.players ? e.room.players.size : 0,
        capacity: e.room.capacity || null,
      });
    }
    /* Busiest first: players converge on rooms that already have people, and
       that convergence is the whole anti-fragmentation mechanism. */
    return out.sort((a, b) => b.players - a.players);
  }

  sweep(now = Date.now()) {
    for (const [k, e] of this.rooms) {
      const occupied = e.room.players ? e.room.players.size > 0 : false;
      if (occupied || e.holds > 0) { e.emptySince = null; continue; }
      if (e.stake === 0) continue;                       // the free lobby is permanent
      if (e.emptySince == null) { e.emptySince = now; continue; }
      if (now - e.emptySince > this.emptyMs) {
        if (typeof e.room.stop === 'function') e.room.stop();
        this.rooms.delete(k);
      }
    }
  }

  get size() { return this.rooms.size; }
}

module.exports = { LobbyRegistry };
