'use strict';
/* The owner console's live alerts (owner.html).
   The server puts a socket in its owner-alert slot only after an owner signature over the action
   'owner:alerts' (server/socketIdentity.js, security review item e): a wallet named in a message
   proves nothing. This connects one socket, signs that action with the page's own silent signer
   (window.duelWalletSignAction through owner.html's signed()) on EVERY connect, since a reconnect
   is a new socket on the server and the proof is one-time, and sends it with lobby:join. The
   server then emits the four admin alerts below to it; each reaches the page as plain text.
   With the owner session (server/ownerSession.js) no wallet is needed: the page asks the server
   for a one-time ticket on each connect and sends that instead (ticket mode, fetchTicket). Every
   open console tab is registered and gets every alert; signing a device out disconnects its tabs.
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

  /* The session mode's ticket (server/ownerSession.js): one POST on our own origin, the HttpOnly session cookie
     rides along, and the answer is a one-time 60 s ticket for lobby:join. null when signed out or on any failure.
     fetchFn defaults to the page's fetch. */
  async function fetchTicket(fetchFn) {
    const f = typeof fetchFn === 'function' ? fetchFn : (typeof fetch === 'function' ? fetch : null);
    if (!f) return null;
    try {
      const r = await f('/api/owner/ticket', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-DS-Owner': '1' }, body: '{}'
      });
      if (!r || !r.ok) return null;
      const j = await r.json();
      return j && typeof j.ticket === 'string' && j.ticket ? j.ticket : null;
    } catch (e) {
      return null;
    }
  }

  /* io: the socket.io client's io();
     ticket() -> a one-time ticket or null: the session mode, e.g. ticket: () => OwnerAlerts.fetchTicket();
     sign(action, args) -> a proof or null: the signature mode (owner.html's signed());
     either or both (the ticket is tried first, it needs no wallet; the signature is the fallback);
     onAlert({ kind, title, text, at }); onState('listening' | 'unsigned' | 'offline'). -> the socket.
     Every connect asks again, since a reconnect is a new socket on the server and both are one-time. */
  function connectOwnerAlerts({ io, sign, ticket, onAlert, onState = () => {} }) {
    const socket = io();
    socket.on('connect', async () => {
      let join = null;
      if (typeof ticket === 'function') {
        let t = null;
        try {
          t = await ticket();
        } catch (e) {
          t = null;
        }
        if (typeof t === 'string' && t) join = { ownerTicket: t };
      }
      if (!join && typeof sign === 'function') {
        let proof = null;
        try {
          proof = await sign(ACTION, {});
        } catch (e) {
          proof = null;
        }
        if (proof) join = { ownerProof: proof };
      }
      if (!join) return onState('unsigned');
      if (socket.connected === false) return;   // dropped while asking: the next connect asks again
      socket.emit('lobby:join', join);
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

  const api = { connectOwnerAlerts, fetchTicket, describe, EVENTS, ACTION };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OwnerAlerts = api;
})(typeof window !== 'undefined' ? window : this);
