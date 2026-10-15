'use strict';
// Paid slither ($0.50 and $1 snake on the sl engine): the engineering numbers of server/slPaid (PAID-SL-DESIGN.md
// section 12). None of them is a game rule a player can see. The four numbers a paid room reads as law
// (C_PAID_HUMAN_CAP, C_PAID_DROP_INSET, C_PAID_CASH_BYTE, C_PAID_BORDER_DROPS) are rows of server/sl/slLaws.js, so
// they are checked against SERVER-LAWS section N like every other law. Each number below names its source.

module.exports = Object.freeze({
  // Paid rooms per rung at most, opened lazily, fullest with space first (design 1; agar's seatFor,
  // server/ag/agArenas.js:321). 4 rooms of C_PAID_HUMAN_CAP 22 is 88 seats per rung; past that the door answers
  // `full` before it spends the token.
  ROOMS_PER_RUNG: 4,

  // A paid room with no account, seat, orphan or parked seat for this long books its floor to the house through
  // sweepFloor (one per source wallet) and retires (design 7.5; Owen 2026-10-14, OWNER-ANSWERS.md:154: the house
  // keeps gold nobody picks up in a room empty 5 minutes). The same 5 minutes as the old ladder's empty-room sweep
  // (server/index.js:2324 emptyMs).
  FLOOR_SWEEP_MS: 300000,

  // One paid join per socket per this many ms, else `slow-down` (design 3.2 step 3; agar's DOOR_RATE_MS,
  // server/ag/agPaidDoor.js:64).
  DOOR_RATE_MS: 250,

  // The longest entry token string the door reads; a longer one is refused before anything else (design 3.2 step 1;
  // agar's FIELD_MAX, server/ag/agPaidDoor.js:63: a real token is a UUID).
  FIELD_MAX: 64,

  // The full checker (slCheck.checkRoom with full) runs every this many sim steps in production: 23 x the L7 step of
  // 42.67 ms is 981 ms, about once a second (design 8). The cheap checks run every step; tests, the soak and the
  // proof run the full one every step too.
  CHECK_EVERY_STEPS: 23,

  // A cash-out status entry for GET /api/sl/cashout/:cid lives this long (design 6: 10 minute TTL).
  STATUS_TTL_MS: 600000,
});
