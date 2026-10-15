'use strict';
/* The lobby's "Players have cashed out $X" strip and its top-10 board.

   THE OFF SWITCH. Set SHOW to false, commit and push, and the strip and board
   are gone from every lobby after the deploy (/api/earnings answers {on:false}
   and the page draws nothing). For an instant hide with no deploy, the owner
   console has "earnings:off" (and "earnings:on"); that one is saved across
   restarts. Either one hides it. */
module.exports = Object.freeze({
  SHOW: true,

  /* The total must reach this many dollars of REAL cash-outs before anything
     shows. Owen 2026-10-15: show it from the first real cash-out. */
  MIN_TOTAL_USD: 0,

  /* One database read at most this often, however many lobbies are open. */
  REFRESH_MS: 60000,

  /* "Today" and "This week" are Owen's wall clock. */
  TIME_ZONE: 'America/Toronto',
});
