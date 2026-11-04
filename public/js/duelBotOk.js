/* "Bot opponent waiting", carried from the lobby to a paid duel's page (Owen 2026-11-04, server/duelBots.js).

   An owner's paid bot can win a player's stake, so it meets ONLY a person who was shown it before paying: the lobby
   writes this note when Play (or Enter) is pressed on a paid rung that says "Bot opponent waiting", and the duel page
   sends botOk with its paid queue only when the note names this game and this stake and is fresh. take() reads it
   once and forgets it, so a later buy-in never carries an old yes. Nothing here is money: the server still decides the
   seat from the entry token, and a page that lies only gets itself a bot it was shown. */
(function (root) {
  const KEY = 'duelBotOk';
  const FRESH_MS = 3 * 60000;   // the stake and the page load take seconds; a note older than this is stale
  function take(game, stake) {
    try {
      const raw = root.sessionStorage.getItem(KEY);
      root.sessionStorage.removeItem(KEY);
      const j = raw ? JSON.parse(raw) : null;
      return !!(j && j.game === game && Math.abs(Number(j.stake) - Number(stake)) < 1e-9 &&
        Number.isFinite(j.at) && Date.now() - j.at >= 0 && Date.now() - j.at < FRESH_MS);
    } catch (_) { return false; }
  }
  function give(game, stake) {
    try { root.sessionStorage.setItem(KEY, JSON.stringify({ game: String(game), stake: Number(stake), at: Date.now() })); } catch (_) { /* private window */ }
  }
  function clear() { try { root.sessionStorage.removeItem(KEY); } catch (_) { /* fine */ } }
  root.DSDuelBotOk = { take, give, clear };
})(window);
