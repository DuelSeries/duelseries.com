'use strict';
/* ─── Server-authorised paid entry ────────────────────────────────────────────
   Extracted verbatim from server/index.js so it can be tested directly. The
   behaviour is unchanged; this file exists because it is the piece the
   any-amount stake model has to modify, and modifying untested money code is
   not something to do twice.

   Why the token exists at all: the socket handshake session is empty, so the
   server cannot identify a player from socket auth. Instead /api/submit-stake
   verifies the on-chain stake landed, then mints an opaque one-time token
   carrying the SERVER-recorded worth. PLAY / RESPAWN (and paid Paper) consume it and
   take worth from here, never from the client's claimed entrySol. A modified
   client can therefore neither forge a token nor inflate what it is worth,
   which is what closes the escrow-drain hole.

   Free lobbies carry no worth and need no token, so they short-circuit. */

const crypto = require('crypto');

/* `onExpire(record)` is called once for every token that expires unspent: the
   stake behind it landed in escrow and nobody joined with it (the tab closed
   during the load, the frame was busy, the table was shut), so it is owed
   back. The token leaves the store BEFORE the call and neither consume path
   ever removes an expired token, so each one is handed over exactly once.
   A throwing hook cannot stop the sweep. */
function makeEntryStore({ ttlMs = 5 * 60 * 1000, fees = {}, isStake = null, onExpire = null, now = () => Date.now() } = {}) {
  const tokens = new Map();   // opaque token -> { lobbyType, stake, worth, paid, walletAddress, googleId, onlyGame, exp, stakeSig?, claimKey? }
  const EPS = 1e-9;

  /* One-time use: the token leaves the store here. A durable token's result also carries its
     stake row (stakeSig, claimKey) for the door's claim, and restore(), which puts the token
     back unchanged (same expiry) when that claim could not reach the database: nothing was
     spent, so it can be used again or expire into a refund like any other. */
  function spend(entryToken, t) {
    tokens.delete(entryToken);
    const r = { ok: true, worth: t.worth, paid: t.paid, googleId: t.googleId, walletAddress: t.walletAddress };
    if (t.stakeSig) {
      r.stakeSig = t.stakeSig;
      r.claimKey = t.claimKey;
      r.restore = () => { if (!tokens.has(entryToken)) tokens.set(entryToken, t); };
    }
    return r;
  }

  return {
    /* `stake` is the rung of the ladder this token buys, already resolved from
       what actually landed on-chain. `lobbyType` is the old tier model's
       equivalent. Both are recorded so the two flows can run side by side
       during the migration without a second store.

       A stake off the ladder is refused at mint rather than stored: a token is
       the only thing standing between a client and a room, so it must never
       exist for an amount no room has.

       `paid` is what actually landed on-chain, which can sit a little under the
       rung in SOL mode (the USDC verifier is exact since night item 5, it used
       to accept 99 percent). It is carried only so a
       refund can be bounded by it: refunding the rung would mint the gap on
       every refused join. The tier path and older tokens have none.

       `onlyGame` scopes a token to one game's door. Paper's dev entry tokens
       carry it: they have no chain behind them and only Paper pays them out
       through a fake withdraw, while every other game pays, refunds and sweeps
       through the real money module, where an unbacked token would become a
       real owed-payout row. Real tokens have none and open every game. */
    /* `stakeSig` is set only when the stake's durable row was written (db.claimStakeSig,
       STATUS item 7a): a door must then claim that row before it seats anybody, and a refund
       goes through the same row, so a restart can neither lose the stake nor pay it twice.
       `claimKey` is this token's own name for its claim, known only to this server's memory. */
    mint({ lobbyType, stake, worth, paid, walletAddress, googleId, onlyGame, stakeSig }) {
      if (stake !== undefined && stake !== null) {
        if (isStake && !isStake(stake)) throw new Error('stake is not on the ladder');
      }
      const token = crypto.randomUUID();
      const rec = { lobbyType, stake, worth, paid, walletAddress, googleId, onlyGame, exp: now() + ttlMs };
      if (stakeSig) { rec.stakeSig = String(stakeSig); rec.claimKey = crypto.randomUUID(); }
      tokens.set(token, rec);
      return token;
    },

    /* The any-amount counterpart of consume(). A token opens exactly the lobby
       whose stake equals what was paid for it, so a client that asks for a $50
       room having paid $0.10 gets nothing: the amount is not its to choose.
       Stake 0 is free play and carries no worth, as with the free tier.
       `game` names the door; a scoped token refused at another game's door is
       left unspent, the same as one offered at the wrong rung. */
    consumeAtStake(entryToken, stake, game) {
      stake = Number(stake);
      if (!isFinite(stake) || stake < 0) return { ok: false, worth: 0 };
      if (stake === 0) return { ok: true, worth: 0 };
      const t = entryToken && tokens.get(entryToken);
      if (!t || typeof t.stake !== 'number' || now() > t.exp) return { ok: false, worth: 0 };
      if (Math.abs(t.stake - stake) > EPS) return { ok: false, worth: 0 };
      if (t.onlyGame && t.onlyGame !== game) return { ok: false, worth: 0 };
      return spend(entryToken, t);
    },

    /* Returns { ok, worth, paid, googleId, walletAddress }. An unknown lobby type is
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
      if (!t || t.lobbyType !== shortType || now() > t.exp) return { ok: false, worth: 0 };
      if (t.onlyGame) return { ok: false, worth: 0 };  // a scoped token opens its own game's ladder door only
      return spend(entryToken, t);
    },

    /* Paid-but-never-used tokens would otherwise accumulate forever. Each one
       is a stake that landed and bought nothing, so it goes to onExpire to be
       paid back (review finding: this used to delete it and the money stayed
       in escrow with no refund and no record). Deleted first, then handed over. */
    sweep() {
      const t = now();
      const expired = [];
      for (const [k, v] of tokens) if (t > v.exp) { tokens.delete(k); expired.push(v); }
      if (typeof onExpire !== 'function') return expired.length;
      for (const v of expired) {
        try {
          onExpire(Object.assign({}, v));
        } catch (e) {
          console.error('[ENTRY] CRITICAL expiry hook threw, owed ' + v.worth + ' to ' + v.walletAddress + ': ' + (e && e.message));
        }
      }
      return expired.length;
    },

    /* The tokens minted and not yet spent or swept: stakes in escrow that are
       owed to somebody (a join or a refund). `worth` is what a refund of each
       would pay, never more than landed. backedOnly leaves out the scoped dev
       tokens, which have no chain behind them and are not escrow's to owe. */
    pending({ backedOnly = false } = {}) {
      let count = 0, worth = 0;
      for (const v of tokens.values()) {
        if (backedOnly && v.onlyGame) continue;
        count++;
        const w = Number(v.worth) > 0 ? Number(v.worth) : 0;
        const p = Number(v.paid);
        worth += Number.isFinite(p) && p > 0 ? Math.min(w, p) : w;
      }
      return { count, worth };
    },

    get size() { return tokens.size; },
  };
}

module.exports = { makeEntryStore };
