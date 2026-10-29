'use strict';
/* ─── Lobby switches, one line each ───────────────────────────────────────────
   SAMPLE_BOARD: the Leaderboards tab shows the sample players from
   socialPreview.js to EVERY visitor, tagged "Sample" on the board, the Global
   player winnings card and each profile, with the line "Sample players to
   preview the board." (Owen, 2026-10-26: to see the full board in the real
   game and get feedback, then turn it off.) The lobby earnings strip, the
   Wallet, /api/* and all server data stay real either way.
   false = the real board for everyone again (?leaderboard=preview still shows
   the sample board in one browser). Off for everyone since 2026-10-28 (Owen):
   the real board, Live, with free duel wins beside the money. */
window.DSConfig = Object.assign(window.DSConfig || {}, {
  SAMPLE_BOARD: false,
});
