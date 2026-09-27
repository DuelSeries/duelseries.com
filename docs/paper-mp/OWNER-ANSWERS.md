# Paper multiplayer: the owner's answers to the four design questions

Answered by Owen on 2026-09-23 (fresh chat). These are BINDING, like the rules in ../paper-multiplayer-brief.md.
They must be folded into docs/paper-multiplayer-design.md (section 13 becomes "decided", the affected sections change)
before implementation starts.

1. Money left on the floor of an arena nobody visits: HOUSE REVENUE AFTER 1 HOUR.
   A pickup that nobody collects within 60 minutes (server clock, measured from the moment it dropped) is swept to the
   house (same path as the 10 percent rake: it stops being counted as money owed to players, it is recorded as house
   income). Until then it waits on the map and counts as liability. Consequences: PaperBank needs a sweep operation for
   a pickup (a withdraw whose destination is the house, not a wallet); the solvency count includes only unswept pickups;
   a constant PICKUP_SWEEP_MS = 3600000 in section 2; a test that a 59 minute pickup is still collectable and a 61 minute
   one is gone and recorded as house income exactly once; the sweep must survive an arena going idle (the room must keep
   ticking, or sweep on the next tick after idle, whichever the design already supports).

2. A paid join refused at the door (maintenance, or all seats taken): AUTO-REFUND 100 PERCENT, once per buy-in, decided
   and executed by the server only. This is the design's default; keep it exactly as designed.

3. Disconnect: 5 SECOND GRACE, the square keeps moving. When a human's socket closes, the server keeps simulating the
   square with its last steering for DISCONNECT_GRACE_MS = 5000. If the same wallet reconnects within the window it
   takes the square back (same seat, same money, same land; the hold, if any, was cancelled at the disconnect). If the
   square dies during the window the normal death rules apply (killer takes all, or a no-killer death drops the money).
   When the window expires with no reconnect, the square is removed and its money DROPS as a pickup where it stood
   (owner rule 5). Consequences: a reconnect path in the sockets join order (a reconnect is NOT a new buy-in and must
   not consume a token), a per-seat grace timer on the server clock, a test for reconnect-in-time, reconnect-too-late,
   die-during-grace, and two sockets on one wallet during the grace (the newer socket wins, the older is told).

4. Cash-out hold: ALLOWED ANYWHERE, exactly as designed (3 seconds, movement locked, release cancels).
