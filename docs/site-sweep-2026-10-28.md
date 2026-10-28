# Site sweep, 2026-10-28 (overnight)

Owen asked for "a full run over the entire website... every single thing absolutely dialed in". Four read-only
finders walked duelseries.com in headless Edge (PC 1920x1080 and 1366x768, phone at Samsung S24 size 384x832):
the lobby on PC, the lobby on phone, the established games, and the four games that opened tonight. Each finding
was reproduced twice or backed by a log line; the raw lists are in `Claude Code Test/site-sweep/findings/`.
Performance and lag were left to the ping-fps session.

## Fixed (live)

Commit aed60f5, lobby:
- 1366 wide: the games rail arrow hung 9px off screen and the page scrolled sideways (breakpoints sized for the old 212px sidebar).
- Events on a 768-tall laptop: the pinned Join bar covered the countdown. Shorter plinths under 820px tall.
- Sidebar kept the old tab lit after opening a game from Live games, Back or the logo.
- Reduced motion (Owen's PC): the Play sheen, Events Join sheen, live dot and hot Join pulse were switched off. Now shown for everyone.
- Invite links and end-screen Share for Head Soccer, Swim and 8 Ball Pool (/play/headsoccer, /play/swim, /play/pool) with share cards.
- /terms, /privacy, /responsible-play without .html were 404: now 301 to the pages.
- Profile subtitle "Sample sample player"; Settings Quality said "slither" and "slower PCs" on phones.
- Phone tap targets (switches, segment buttons, game screen Back, Support close) are 44px now.
- Live wins name pool: removed a real person's handle (ZachXBT) and a crude name.

Commit 41d1f9b, the new games:
- 8 Ball Pool: every finished match threw "series is not defined" and the table froze with no result card, Lobby or Play again. Escape opens "Leave the match?".
- Result cards in Rooftop, Crossy, Air Hockey and Pool named the bot like a real player: now "ben13 (bot) wins".
- Air Hockey phone strip cut "(bot)" off names.
- Crossy Road pause button covered the coin counter on 1080p and stayed on the result card; its leave question uses the shared words.
- Rooftop "Playing a bot" pill covered the ready-up line and was hidden under the turn-your-phone card.

Commit (this one), the established games:
- Escape could never close "Leave the match?" in Head Soccer, Air Hockey, Rooftop and Pool (the closing Escape reopened it).
- Paper.io "Play again" renamed you to "Player" (respawn did not send the name).
- Slither.io spectate: the "you" row showed the watcher's name on the watched snake's rank and length.

Commit 7ff3cd5:
- Agar.io on a phone: the chat button never appeared in a quiet room (chat checked "can you talk" only before the player came alive). Chat now re-checks every second while shown, in every game; Agar's phone chat moved from under the Lobby button to top 62.
- The "P clip" hint was white on the light Agar.io and Paper.io maps: dark there now. The share card's time-left bar keeps running under reduced motion.

## Not fixed, and why

Needs Owen:
- **Live wins row shows made-up wins.** `REAL_WINS` is empty and the row invents 14 wins with random amounts on every load (since the v2 lobby, 2026-08-15); real cash-outs are $0 so far. On a real-money site this reads as advertised winnings that never happened. Recommendation: fill it from real landed cash-outs and hide it until there are some, or label it as examples. Left as is because Owen picked this row yesterday.
- **Paid duels cannot start from the lobby.** In all 8 duel games the $0.50 and $1 rungs are struck through and Play opens the free table (deliberate since d21ace5: the lobby cannot pass a stake to a duel yet). Paid tables are reachable only inside each game. Opening them from the lobby is money-path work that needs a Fable review and a real-money test, not an overnight change.
- **Leaderboards shows the labelled Sample board to everyone** (config.js `SAMPLE_BOARD: true`, Owen's feedback round). Turn off when done.
- **Legal pages still have bracketed placeholders and say Draft** (needs a lawyer).
- **Invite names**: shareGames.js uses plain names on purpose (trademarks) but Crossy Road uses its real name. One rule either way.

Left for the game sessions (real work, not a quick fix):
- A connection blip mid-match drops the match silently and re-queues (Rooftop, Crossy, Air Hockey, Pool share it); on a paid table the stake goes the same quiet way. Wants Swim's reconnect grace (2800a36). Money-adjacent.
- Agar.io free: a guest can be eaten 0 to 1 s after spawning (finder: 2 of 5 PC launches; re-check: 2 of 3 phone launches, "Eaten by Noah" at 0:00). Free humans already spawn 500 units clear of anything that can eat them. A real-laws offline room with its bots (30 s and 5 min warm-up, 45 idle spawns at clearance 500 and 1500) never killed a guest within 1 s, so the live cause is something a fresh room does not have (room age and bot sizes after hours, or bot splits). Not changed without a cause; needs the agar session to log the eater's size, distance and split on a live death.
- Rooftop: "Point Blue" is drawn over "Blue Wins!" at the end (check against the reference before changing); Spectate on an empty table is a blank sky; names are not drawn in the match.
- Battleship placement is a few px too tall at 1366x768 ("5 TO PLACE" cut).
- Phone leaderboards cut names of 11+ characters.
- Free-room leave button says "Cash out" in Slither.io and Agar.io but "Leave" in Paper.io.
- iOS-only "Add to home screen" hint can cover the Events Join bar until dismissed.

Performance (ping-fps session): socket polling 502s on phone (Pac-Man, Swim; existing open thread), the lobby taking 11 to 19 s to load in 2 of about 40 visits.

## Checked, fine
Every lobby tab at both PC sizes and on phone, all 16 game screens, Wallet signed out and Privy's sign-in (look only), Events How it works, Leaderboards preview (board, search, profile, zoom), Clips dialogs and share page, Updates (42 images), Join us, Settings (toggles persist), toasts, legal and 404 pages, invites, and every game's menu, free play, HUD, chat panel and end screen: no console errors or crashes apart from the Pool one above, and no sideways scroll in any game on phone.
