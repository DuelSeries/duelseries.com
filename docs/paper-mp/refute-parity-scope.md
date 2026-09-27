# Refuter verdicts: parity-scope

Recorded 2026-09-27 from the stored result of the critics workflow run `wf_819cd852-cba` (finished 2026-09-24, script
`paper-mp-critics-wf_819cd852-cba.js`), which is where the independent refuters wrote their verdicts; until this file the
verdicts existed only inside that run record, not on disk next to the critic file. The findings and their text are in
`docs/paper-mp/critic-parity-scope.md`. "Downgraded to X" is the severity the refuter left the finding at. "No refuter result"
means the run recorded no verdict for that finding (the workflow log says "4 refuter results missing"). "In design 14"
says whether design section 14 lists the finding as applied. The reasons below are the refuters' text verbatim; the
line numbers they cite (`design:NNN`) are those of the FIRST draft, before the revisions.

| ID | Refuter verdict | In design 14 |
|---|---|---|
| B1 | downgraded to major | yes |
| M1 | no refuter result | yes |
| M2 | downgraded to major | yes |
| M3 | downgraded to minor | yes |
| M4 | downgraded to major | yes |
| M5 | downgraded to minor | yes |
| M6 | downgraded to minor | yes |
| M7 | downgraded to minor | yes |
| m1 | confirmed (minor) | yes |
| m2 | downgraded to minor | yes |
| m3 | confirmed (minor) | yes |
| m4 | downgraded to minor | yes |
| m5 | downgraded to minor | yes |
| m6 | REFUTED (reason below) | no |
| m7 | REFUTED (reason below) | no |
| m8 | downgraded to minor | yes |
| m9 | no refuter result | yes |
| m10 | confirmed (minor) | no |
| m11 | no refuter result | yes |

## Refuted findings, the refuter's reason verbatim

### m6. Lobby row never reports full or warming, so a paid player stakes on-chain then is refused and refunded

The finding's premise is misread: public/js/v2/board.js:4 is a comment describing the /api/live shape, and no lobby code consumes a row's state (board.js rowHTML/occupied/rowsToShow/join and play.js:240-300 gate only on V2_IS_SOON, stake presence, wallet connection and playableStakes; v2.html:2220-2223 builds rungs from stake membership), while wallet-widget/src/main.jsx:182-186 stakes on-chain with no seat pre-check, so the proposed state change would alter nothing a player sees and the stake-then-refuse scenario plays out identically with the fix applied. The design's state:'open' follows the existing board contract (server/index.js:1351-1377 hard-codes state:'open', capacity:null for every snake rung; only the battle royale carries a real state/joinable, and its comment at :1455-1460 says the rule is enforced on join). The proposed fix is also unsound on the design's own terms: design 6.1 (line 425-427) has seatFor CREATE an overflow arena when no room has a spot, so calling it from boardRows() on each unauthenticated /api/live GET (board.js polls every 10 s) would mint arenas as a side effect of a read, and 'warming' covers a roughly half-second boot window (WARM_CHUNK, design 4.7 line 258-260) where free joins auto-retry with no token at stake. The refusal at 128 paid humans per rung is already handled by the one-time 100 percent refund (5.6 refuseAndRefund, 5.9 table) and is explicitly put to the owner as question 2 (design 785-789, STATUS.md:48); no board flag could remove that race anyway, since a 10 s poll cannot see a seat taken during an on-chain transaction.

### m7. Duplicate join is silent and there is no connecting or unreachable screen

The hang cannot happen for the designed client: docs/paper-multiplayer-design.md:588 and :436 say pp:join is sent once per token, and the only automatic re-send is the warming retry (:259), which follows a pp:refused, i.e. the socket was never seated, so socket._ppRoom is unset (step 9, :358 sets it only after addHuman) and step 4 (:353) cannot fire; a seated socket has already received the reliable pp:joined on the same connection, so it is not on the warming screen, and a socket.io v4 reconnect is a fresh server Socket without _ppRoom (5.7 kills the unit on disconnect anyway). Step 4 is therefore reachable only by a buggy or malicious duplicate, where a silent drop is exactly what the existing PLAY handler does (server/index.js:2051-2055, verified), and the test row at :748 already pins "duplicate ... consume spy at ZERO calls". The proposed pp:refused{already-seated} reply is worse, not better: the 8.5 client shows the refused screen on any pp:refused, so a stray duplicate would flip a live, staked player onto a "refused" screen. The connecting-screen half misreads its evidence: public/js/knockout.js:512-536 is socket.on('connect', queue), the re-queue-on-reconnect bug the design already avoids at 5.7, and no game page on the site handles connect_error at all (grep of public/ finds zero hits in game.js, shooter.js, knockout.js, battleship.js), so the design matches site convention and no brief rule asks for such a screen.
