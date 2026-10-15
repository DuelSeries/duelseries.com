'use strict';
/* Who a main-namespace socket is (security review item e).

   The wallet address is the player id (it is still called googleId for legacy reasons): it keys
   the accounts row that db.recordGameResult writes, the all-time leaderboard entry (whose NAME a
   score also rewrites), the old engine's collusion records, the Battle Royale prize, and the
   owner's live alerts (lobbySocketsByGoogleId.get(OWNER_WALLET)). PLAY and lobby:join used to set
   it from the googleId the client sent, with nothing proving the client held that wallet: anyone
   could write another wallet's stats and leaderboard name, and anyone who knew the owner wallet
   (a constant in this public repo) received the owner's alerts and pushed the owner's own socket
   out of the map.

   A socket now carries a wallet only with proof, and nothing else ever sets it:
     fromEntry   the paid entry token's walletAddress: the on-chain payer /api/submit-stake verified
     fromProof   a signature by the wallet, one-time, 2 minutes, checked ONCE per socket (the first proof
                 offered decides, a later one changes nothing): either ownerAuth's message over the action
                 IDENTIFY_ACTION, which the lobby's wallet widget already signs silently
                 (window.duelWalletSignAction; public/js/game.js sends it with PLAY), or
                 nameProof.identityMessage
   With neither, socket._googleId stays null: stats are skipped and the leaderboard keys the score
   by the player's name, as it always did for a player with no wallet.

   The owner's alerts are registered only by ownerAlerts: an owner signature (ownerAuth, the same
   check /api/owner/do makes) over the action OWNER_ALERTS_ACTION. A wallet proven any other way,
   the owner's included, is never put in the alert map, and a socket leaving removes only itself. */

const OWNER_ALERTS_ACTION = 'owner:alerts';
// The identity proof the client can send with no wallet-widget change: the widget's existing silent signer
// (window.duelWalletSignAction) over this action. /api/owner/do knows no such action, so it can never run one.
const IDENTIFY_ACTION = 'play:identify';

/* verifyIdentityProof(body) -> wallet | null   (nameProof.verifyIdentityProof)
   walletForAction(body) -> wallet | null       (ownerAuth.walletForAction)
   isOwner(wallet) -> bool                      (the server's owner list)
   alertKey                                     the key the alert lookups use (OWNER_WALLET)
   ownerSockets                                 lobbySocketsByGoogleId */
function createSocketIdentity({ verifyIdentityProof, walletForAction, isOwner, alertKey, ownerSockets, log = console } = {}) {
  if (typeof verifyIdentityProof !== 'function') throw new Error('socketIdentity: verifyIdentityProof is required');
  if (typeof walletForAction !== 'function') throw new Error('socketIdentity: walletForAction is required');
  if (typeof isOwner !== 'function') throw new Error('socketIdentity: isOwner is required');
  if (!ownerSockets || typeof ownerSockets.set !== 'function') throw new Error('socketIdentity: ownerSockets is required');

  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // The socket's proven wallet, or null. A proof is checked once per socket (it is one-time anyway), and never
  // replaces a wallet the socket already proved (a paid entry's payer included).
  function fromProof(socket, proof) {
    if (!socket) return null;
    if (!socket._idChecked && !proven(socket) && isPlain(proof)) {
      socket._idChecked = true;
      let w = null;
      try {
        // Either shape: what the lobby's wallet widget already signs silently today,
        // window.duelWalletSignAction('play:identify', {}) (ownerAuth's message, signed by the PLAYER's own wallet;
        // walletForAction returns whoever signed it, owner or not), or nameProof.identityMessage.
        w = proof.action === IDENTIFY_ACTION ? walletForAction(proof) : verifyIdentityProof(proof);
      } catch (e) {
        w = null;
      }
      if (typeof w === 'string' && w) socket._googleId = w;
      else log.warn('[ID] a wallet proof did not verify; the socket plays with no wallet (no stats)');
    }
    return proven(socket);
  }

  // A consumed paid entry: its wallet is the verified on-chain payer, the strongest binding there is.
  function fromEntry(socket, entry) {
    const w = entry && typeof entry.walletAddress === 'string' && entry.walletAddress ? entry.walletAddress : null;
    if (socket && w) socket._googleId = w;
    return w;
  }

  function proven(socket) {
    return socket && typeof socket._googleId === 'string' && socket._googleId ? socket._googleId : null;
  }

  // The owner's live alerts: only after an owner signature over OWNER_ALERTS_ACTION (the action is
  // read before the signature is, so a signature meant for another action is never spent here).
  function ownerAlerts(socket, ownerProof) {
    if (!socket || !isPlain(ownerProof) || ownerProof.action !== OWNER_ALERTS_ACTION) return false;
    // one signature check per socket, like the identity proof (lobby:join is not rate limited)
    if (socket._ownerChecked) return socket._ownerAlerts === true;
    socket._ownerChecked = true;
    let w = null;
    try {
      w = walletForAction(ownerProof);
    } catch (e) {
      w = null;
    }
    if (!w || !isOwner(w)) {
      log.warn('[ID] owner alerts refused: the signature is not an owner\'s');
      return false;
    }
    ownerSockets.set(alertKey, socket);
    socket._ownerAlerts = true;
    return true;
  }

  // A socket that leaves takes only its own alert registration with it.
  function forget(socket) {
    if (socket && ownerSockets.get(alertKey) === socket) ownerSockets.delete(alertKey);
  }

  return { fromProof, fromEntry, proven, ownerAlerts, forget };
}

module.exports = { createSocketIdentity, OWNER_ALERTS_ACTION, IDENTIFY_ACTION };
