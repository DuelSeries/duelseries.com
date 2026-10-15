'use strict';
/* The owner console's live alerts (owner.html).
   The server puts a socket in its owner-alert slot only after an owner signature over the action
   'owner:alerts' (server/socketIdentity.js, security review item e): a wallet named in a message
   proves nothing. This connects one socket, signs that action with the page's own silent signer
   (window.duelWalletSignAction through owner.html's signed()) on EVERY connect, since a reconnect
   is a new socket on the server and the proof is one-time, and sends it with lobby:join. The
   server then emits the four admin alerts below to it; each reaches the page as plain text.
   The phone pushes are separate and unaffected. Nothing here can act on anything. */
(function (root) {
  const ACTION = 'owner:alerts';
  const EVENTS = Object.freeze({
    'admin:solvency_alert': 'solvency',
    'admin:collusion_flag': 'collusion',
    'admin:paper_alert': 'paper',
    'admin:agar_alert': 'agar'
  });

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const num = (v, dp) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(dp) : '?');
  const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '?');
  const short = (w) => (typeof w === 'string' && w.length > 10 ? w.slice(0, 4) + '…' + w.slice(-4) : str(w));

  // kind: one of EVENTS' values; p: the server's payload. -> { kind, title, text, at }, never throws.
  function describe(kind, p) {
    const x = isObj(p) ? p : {};
    let title = 'Alert';
    let text = '';
    if (kind === 'solvency') {
      if (x.feeSolLow) {
        title = 'Escrow SOL low';
        text = num(x.escrowFeeSol, 4) + ' SOL left for payout fees. Top it up or payouts start failing.';
      } else {
        title = 'Escrow short';
        text = 'Escrow ' + num(x.escrowSol, 2) + ' is below the live stakes ' + num(x.liveStakesSol, 2) +
          ' (short ' + num(typeof x.surplusSol === 'number' ? -x.surplusSol : NaN, 2) + ').';
      }
    } else if (kind === 'collusion') {
      title = 'Collusion flag';
      text = short(x.src) + ' -> ' + short(x.dst) + ': net ' + num(x.netSol, 2) + ' over ' + str(x.count) +
        ' transfers, one-way ' + num(x.oneWayRatio, 2) + ', in ' + str(x.lobbyType) + '.';
    } else if (kind === 'paper' || kind === 'agar') {
      title = kind === 'paper' ? 'Paper money alert' : 'agar.io money alert';
      text = str(x.kind) + ' in ' + str(x.lobbyType) +
        (typeof x.repeats === 'number' && x.repeats > 0 ? ' (' + x.repeats + ' more held back)' : '') + '.';
    } else {
      text = 'Unknown alert.';
    }
    return { kind, title, text, at: Date.now() };
  }

  /* io: the socket.io client's io(); sign(action, args) -> a proof or null (owner.html's signed());
     onAlert({ kind, title, text, at }); onState('listening' | 'unsigned' | 'offline'). -> the socket. */
  function connectOwnerAlerts({ io, sign, onAlert, onState = () => {} }) {
    const socket = io();
    socket.on('connect', async () => {
      let proof = null;
      try {
        proof = await sign(ACTION, {});
      } catch (e) {
        proof = null;
      }
      if (!proof) return onState('unsigned');
      if (socket.connected === false) return;   // dropped while signing: the next connect signs again
      socket.emit('lobby:join', { ownerProof: proof });
      onState('listening');
    });
    socket.on('disconnect', () => onState('offline'));
    for (const ev of Object.keys(EVENTS)) {
      socket.on(ev, (p) => {
        try {
          onAlert(describe(EVENTS[ev], p));
        } catch (e) { /* the page's own render: never let it take the socket down */ }
      });
    }
    return socket;
  }

  const api = { connectOwnerAlerts, describe, EVENTS, ACTION };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OwnerAlerts = api;
})(typeof window !== 'undefined' ? window : this);
