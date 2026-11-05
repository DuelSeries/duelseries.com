'use strict';
/* ─── Lobby switches, one line each ───────────────────────────────────────────
   SAMPLE_BOARD: the Leaderboards tab shows the made-up players from
   socialPreview.js to EVERY visitor (Owen, 2026-10-26: to see the full board
   in the real game, then turn it off). false = the real board again.
   SAMPLE_WINS: Home's Live wins row is filled with made-up wins from the same
   players (socialPreview.js wins), new ones sliding in every few seconds
   (Owen, 2026-11-02: "full and moving"). false = real cash-outs only.
   SAMPLE_TAG, when true, puts a grey "Sample" chip on every made-up win,
   player and earnings figure. Off since 2026-11-05 (Owen: keep the filled boards but
   drop the Sample label, so the rows read like normal rows). Set it back to
   true to bring the chip back everywhere at once.
   The Wallet, /api/* and all server data stay real either way. */
window.DSConfig = Object.assign(window.DSConfig || {}, {
  SAMPLE_BOARD: true,
  SAMPLE_WINS: true,
  SAMPLE_TAG: false,
});
