'use strict';
/* ─── Server-authorised paid entry ────────────────────────────────────────────
   Extracted verbatim from server/index.js so it can be tested directly. The
   behaviour is unchanged; this file exists because it is the piece the
   any-amount stake model has to modify, and modifying untested money code is
   not something to do twice.

   Why the token exists at all: the socket handshake session is empty, so the
   server cannot identify a player from socket auth. Instead /api/submit-stake
   verifies the on-chain stake landed, then mints an opaque one-time token
   carrying the SERVER-recorded worth. PLAY / RESPAWN / cell:join consume it and
   take worth from here, never from the client's claimed entrySol. A modified
   client can therefore neither forge a token nor inflate what it is worth,
   which is what closes the escrow-drain hole.

   Free lobbies carry no worth and need no token, so they short-circuit. */

const crypto = require('crypto');

function makeEntryStore({ ttlMs = 5 * 60 * 1000, fees = {}, isStake = null } = {}) {
  const tokens = new Map();   // opaque token -> { lobbyType, stake, worth, walletAddress, googleId, exp }
  const EPS = 1e-9;

  return {
    /* `stake` is the rung of the ladder this token buys, already resolved from
       what actually landed on-chain. `lobbyType` is the old tier model's
       equivalent. Both are recorded so the two flows can run side by side
       during the migration without a second store.

       A stake off the ladder is refused at mint rather than stored: a token is
       the only thing standing between a client and a room, so it must never
       exist for an amount no room has. */
    mint({ lobbyType, stake, worth, walletAddress, googleId }) {
      if (stake !== undefined && stake !== null) {
        if (isStake && !isStake(stake)) throw new Error('stake is not on the ladder');
      }
      const token = crypto.randomUUID();
      tokens.set(token, { lobbyType, stake, worth, walletAddress, googleId, exp: Date.now() + ttlMs });
      return token;
    },

    /* The any-amount counterpart of consume(). A token opens exactly the lobby
       whose stake equals what was paid for it, so a client that asks for a $50
       room having paid $0.10 gets nothing: the amount is not its to choose.
       Stake 0 is free play and carries no worth, as with the free tier. */
    consumeAtStake(entryToken, stake) {
      stake = Number(stake);
      if (!isFinite(stake) || stake < 0) return { ok: false, worth: 0 };
      if (stake === 0) return { ok: true, worth: 0 };
      const t = entryToken && tokens.get(entryToken);
      if (!t || typeof t.stake !== 'number' || Date.now() > t.exp) return { ok: false, worth: 0 };
      if (Math.abs(t.stake - stake) > EPS) return { ok: false, worth: 0 };
      tokens.delete(entryToken);                       // one-time use
      return { ok: true, worth: t.worth, googleId: t.googleId, walletAddress: t.walletAddress };
    },

    /* Returns { ok, worth, googleId, walletAddress }. An unknown lobby type is
       treated as free rather than rejected, which is what the live code does:
       the type only ever reaches here from a client, and a bad one must not be
       able to buy a paid seat. */
    consume(entryToken, shortType) {
      if (!(shortType in fees)) shortType = 'free';
      /* By FEE, not by the name 'free'. A lobby that costs nothing needs no
         token, and there is more than one of those now: the battle royale is
         free to enter. Matching on the name meant adding br to the fee table
         made it a KNOWN type and therefore no longer the free case, so it
         started demanding a paid token for a lobby with no fee and every join
         was refused with 'Entry fee not verified'. */
      if (!fees[shortType]) return { ok: true, worth: 0 };
      const t = entryToken && tokens.get(entryToken);
      if (!t || t.lobbyType !== shortType || Date.now() > t.exp) return { ok: false, worth: 0 };
      tokens.delete(entryToken);                       // one-time use
      return { ok: true, worth: t.worth, googleId: t.googleId, walletAddress: t.walletAddress };
    },

    /* Paid-but-never-used tokens would otherwise accumulate forever. */
    sweep() {
      const now = Date.now();
      for (const [k, v] of tokens) if (now > v.exp) tokens.delete(k);
    },

    get size() { return tokens.size; },
  };
}

module.exports = { makeEntryStore };
