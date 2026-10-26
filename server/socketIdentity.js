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
   check /api/owner/do makes) over the action OWNER_ALERTS_ACTION, or by ownerAlertsByTicket: a
   one-time ticket from POST /api/owner/ticket, which only a live owner session gets
   (server/ownerSession.js). A wallet proven any other way, the owner's included, is never put in
   the alert map, and a socket leaving removes only itself.

   More than one owner socket at once (two console tabs, a phone and a PC): the map used to hold
   ONE socket under the alert key, so a second tab silently took the first one's alerts while the
   first still said "listening". The map now holds one fan-out under the key whose emit reaches
   every registered socket, so the emit sites (map.get(key).emit(...)) are unchanged, and each
   socket leaving removes only itself. A socket a session registered is dropped and disconnected
   when that session is revoked (dropSessions) or found dead at the next alert (sessionLive). */

const OWNER_ALERTS_ACTION = 'owner:alerts';
// The identity proof the client can send with no wallet-widget change: the widget's existing silent signer
// (window.duelWalletSignAction) over this action. /api/owner/do knows no such action, so it can never run one.
const IDENTIFY_ACTION = 'play:identify';

/* verifyIdentityProof(body) -> wallet | null   (nameProof.verifyIdentityProof)
   walletForAction(body) -> wallet | null       (ownerAuth.walletForAction)
   walletForIdentify(body) -> wallet | null     (ownerAuth.walletForPlayerAction: walletForAction, or a browser wallet's
                                                device key; optional, walletForAction when absent. The owner's alerts
                                                never read it)
   isOwner(wallet) -> bool                      (the server's owner list)
   alertKey                                     the key the alert lookups use (OWNER_WALLET)
   ownerSockets                                 lobbySocketsByGoogleId
   ticketWallet(ticket) -> { wallet, session } | null   (ownerSession.ticketWallet: spends the ticket; optional)
   sessionLive(session) -> bool                 (ownerSession.isLive; optional) */
function createSocketIdentity({ verifyIdentityProof, walletForAction, walletForIdentify, isOwner, alertKey, ownerSockets,
  ticketWallet, sessionLive, log = console } = {}) {
  if (typeof verifyIdentityProof !== 'function') throw new Error('socketIdentity: verifyIdentityProof is required');
  if (typeof walletForAction !== 'function') throw new Error('socketIdentity: walletForAction is required');
  const identifyWallet = typeof walletForIdentify === 'function' ? walletForIdentify : walletForAction;
  if (typeof isOwner !== 'function') throw new Error('socketIdentity: isOwner is required');
  if (!ownerSockets || typeof ownerSockets.set !== 'function') throw new Error('socketIdentity: ownerSockets is required');

  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // Every registered owner alert socket, oldest first. Bounded: each one took an owner proof, but a page in a
  // reconnect loop should not grow it forever, so past the cap the oldest is let go.
  const MAX_ALERT_SOCKETS = 20;
  const alertSockets = new Set();
  const stillLive = (s) => !s._ownerSession || typeof sessionLive !== 'function' || sessionLive(s._ownerSession) === true;
  const fanout = Object.freeze({
    emit(ev, payload) {
      for (const s of [...alertSockets]) {
        if (!stillLive(s)) { drop(s); continue; }
        try { s.emit(ev, payload); } catch (e) { /* one broken socket never keeps the alert from the others */ }
      }
      return true;
    },
    get size() { return alertSockets.size; },
    has: (s) => alertSockets.has(s),
  });
  function register(socket) {
    alertSockets.add(socket);
    socket._ownerAlerts = true;
    while (alertSockets.size > MAX_ALERT_SOCKETS) drop(alertSockets.values().next().value);
    ownerSockets.set(alertKey, fanout);
  }
  function drop(socket) {
    forget(socket);
    try { if (socket && typeof socket.disconnect === 'function') socket.disconnect(true); } catch (e) { /* gone already */ }
  }

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
        w = proof.action === IDENTIFY_ACTION ? identifyWallet(proof) : verifyIdentityProof(proof);
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
    register(socket);
    return true;
  }

  // The same, from the owner session: a one-time ticket (POST /api/owner/ticket), checked once per socket like the
  // signature. The socket remembers which session registered it, so revoking that session can drop it.
  function ownerAlertsByTicket(socket, ticket) {
    if (!socket || typeof ticket !== 'string' || !ticket || ticket.length > 128) return false;
    if (socket._ownerChecked) return socket._ownerAlerts === true;
    socket._ownerChecked = true;
    let t = null;
    try {
      t = typeof ticketWallet === 'function' ? ticketWallet(ticket) : null;
    } catch (e) {
      t = null;
    }
    const w = isPlain(t) && typeof t.wallet === 'string' ? t.wallet : null;
    if (!w || !isOwner(w)) {
      log.warn('[ID] owner alerts refused: the ticket is not a live owner session\'s');
      return false;
    }
    socket._ownerSession = typeof t.session === 'string' ? t.session : null;
    register(socket);
    return true;
  }

  // A socket that leaves takes only its own alert registration with it.
  function forget(socket) {
    if (!socket || !alertSockets.delete(socket)) return;
    socket._ownerAlerts = false;
    if (alertSockets.size === 0 && ownerSockets.get(alertKey) === fanout) ownerSockets.delete(alertKey);
  }

  // Revoked sessions (ownerSession.onRevoke): their alert sockets are let go and disconnected. -> how many.
  function dropSessions(sessions) {
    const gone = new Set(Array.isArray(sessions) ? sessions : [sessions]);
    let n = 0;
    for (const s of [...alertSockets]) {
      if (s._ownerSession && gone.has(s._ownerSession)) { drop(s); n++; }
    }
    return n;
  }

  return { fromProof, fromEntry, proven, ownerAlerts, ownerAlertsByTicket, forget, dropSessions,
           alertSockets: () => [...alertSockets] };
}

module.exports = { createSocketIdentity, OWNER_ALERTS_ACTION, IDENTIFY_ACTION };
