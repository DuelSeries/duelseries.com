'use strict';
/* ─── Lobby switches, one line each ───────────────────────────────────────────
   SAMPLE_BOARD: the Leaderboards tab shows the made-up players from
   socialPreview.js to EVERY visitor (Owen, 2026-10-26: to see the full board
   in the real game, then turn it off). false = the real board again.
   SAMPLE_WINS: Home's Live wins row is filled with made-up wins from the same
   players (socialPreview.js wins), new ones sliding in every few seconds
   (Owen, 2026-11-02: "full and moving"). false = real cash-outs only.
   Both off since 2026-11-05 (Owen: the site exactly as players see it, real
   data only). Set them back to true to bring the samples back.
   SAMPLE_TAG: every made-up win, player and earnings figure wears "Sample".
   It MUST stay true on main: made-up money is never shown as real. The only
   way round it is ?filler=live on a localhost dev server (Owen's preview),
   which socialPreview.js ignores on any other host.
   The Wallet, /api/* and all server data stay real either way. */
window.DSConfig = Object.assign(window.DSConfig || {}, {
  SAMPLE_BOARD: false,
  SAMPLE_WINS: false,
  SAMPLE_TAG: true,
});
