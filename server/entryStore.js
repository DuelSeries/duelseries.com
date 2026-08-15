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

function makeEntryStore({ ttlMs = 5 * 60 * 1000, fees = {} } = {}) {
  const tokens = new Map();   // opaque token -> { lobbyType, worth, walletAddress, googleId, exp }

  return {
    mint({ lobbyType, worth, walletAddress, googleId }) {
      const token = crypto.randomUUID();
      tokens.set(token, { lobbyType, worth, walletAddress, googleId, exp: Date.now() + ttlMs });
      return token;
    },

    /* Returns { ok, worth, googleId, walletAddress }. An unknown lobby type is
       treated as free rather than rejected, which is what the live code does:
       the type only ever reaches here from a client, and a bad one must not be
       able to buy a paid seat. */
    consume(entryToken, shortType) {
      if (!(shortType in fees)) shortType = 'free';
      if (shortType === 'free') return { ok: true, worth: 0 };
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
