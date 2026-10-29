/* ─── DSIdentify: a duel page proves whose wallet is playing ─────────────────
   So a free duel won by a signed-in player counts on the Leaderboards (Owen 2026-10-28: free wins beside the money;
   server/freeWins.js credits only a wallet the socket PROVED). On every connect it asks the lobby for the same
   silent 'play:identify' signature the battle royale uses (the duel:signaction bridge, public/js/v2/play.js) and
   sends it as 'id:prove'; the server checks it once per socket (socketIdentity.fromProof). Signed out, or no
   answer in 10 s: nothing is sent and the game plays exactly as before. Never blocks the queue.

   DSIdentify.attach(socket, wanted)   wanted() false skips it (a spectator) */
(function (root) {
  'use strict';
  var seq = 0;
  function sign() {
    return new Promise(function (resolve) {
      var parent = root.parent, origin = root.location && root.location.origin;
      if (!parent || parent === root || !origin || origin === 'null') { resolve(null); return; }
      var id = 'id' + (++seq), done = false;
      function finish(v) { if (done) return; done = true; root.removeEventListener('message', onMsg); resolve(v); }
      function onMsg(e) {
        if (e.source !== parent || e.origin !== origin) return;
        var d = e.data;
        if (!d || d.id !== id) return;
        if (d.type === 'duel:signaction:done') finish(d.proof && typeof d.proof === 'object' ? d.proof : null);
        else if (d.type === 'duel:signaction:error') finish(null);
      }
      root.addEventListener('message', onMsg);
      try { parent.postMessage({ type: 'duel:signaction', id: id, action: 'play:identify', args: {} }, origin); }
      catch (e) { finish(null); return; }
      root.setTimeout(function () { finish(null); }, 10000);
    });
  }
  function attach(socket, wanted) {
    if (!socket || typeof socket.on !== 'function') return;
    socket.on('connect', function () {
      try { if (typeof wanted === 'function' && !wanted()) return; } catch (e) { return; }
      var sid = socket.id;
      sign().then(function (proof) {
        if (proof && socket.connected && socket.id === sid) socket.emit('id:prove', { idProof: proof });
      });
    });
  }
  root.DSIdentify = { attach: attach };
})(typeof window !== 'undefined' ? window : globalThis);
