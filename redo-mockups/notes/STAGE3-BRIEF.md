# DuelSeries site redo: Stage 3, rebuild the real site to match the mockups

Owen picked the look and the layout. Every tab is mocked; now the real code gets rebuilt to match, area by area. Nothing is pushed or shipped in this stage.

## The spec
- Mockups (the target, open them, read their CSS): `C:/Users/owend/Documents/Coding Projects/Claude Code Test/site-redo/looks/ab/1/<page>.html` (home, wallet, events, leaderboards (+ `?p=<name>`, `?card`), customize, settings, refer, support, clips, updates, join, game-ui, legal, 404, games, game-page, owner) on the merged kit `site-redo/looks/ab/kit.css`, `kit.js` (window.DSUI), `chart.js`, with `layout.css`/`layout.js` for the Sidebar chrome. Probe them with `file:///C:/Users/owend/Documents/Coding%20Projects/Claude%20Code%20Test/site-redo/looks/ab/1/<page>.html`.
- The look: A's system (Archivo; bone `#f4f1ea` actions; gold `#f0a830` money only; green `#8ed081` wins and live; one button family, one sheet, one toast) on B's true black (`#000000` page, `#0d0b08` panel, `#1a1611` raised). Layout 1 "Sidebar": left sidebar on PC, header with balance chip, phone bottom bar Home, Wallet, Events, Leaderboards, Settings, 3 games across on the phone, B's wallet with today's earnings chart.
- What is broken today: `site-redo/_work/audit-*.json` (findings per area) and `Claude Code Test/Site audit.html`. Fix what falls in your area.
- Skins selling is NOT decided yet. Do not build a Shop or change how skins are sold. Customize gets the new look; its existing buy entry stays as it works today.

## The repo
- Worktree `C:/Users/owend/Documents/Coding Projects/Claude Code Test/wt-site-redo`, branch `redo/site-v3` (on origin/main 6247547). Its `node_modules` is a junction: never delete it.
- Commit only your own files, right after each working step: `git add <your files> && git commit -m "redo <area>: <what>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <your files>`. If git says index.lock exists, wait a few seconds and retry. Never push, never stash, never reset, never switch branches, never touch files another agent owns (your prompt says what you own).
- Shared kit in code (made by the Foundation agent): `public/css/ds-tokens.css` (custom properties only) and `public/css/ds-kit.css` (components). Read their header comments and use them; never fork a private copy of the tokens. Ask in your report if something is missing instead of editing them (only Foundation edits them).

## Hard rules (from Owen, verbatim)
- "Don't change money logic: stakes, payouts, settlement, deposits, withdraw, `server/*Money*`."
- "Any diff that touches wallet or money UI needs a Fable review." So list every money-UI file you touch in your report (wallet tab, Add funds, Withdraw, Convert, the wallet widget, the stake sheet and paid join, skin buy UI). Keep their logic, events, ids and data flow exactly; change markup and CSS only, and only as much as the look needs.
- "Keep existing behaviour: "Withdraw" not "Cash out"; name edit only in the header card; Clips, Updates and Join us are PC-only; PostHog events only via `shared/trackPlan.js`." Keep every existing tracking call; add none outside trackPlan.
- "Owen has reduced motion on, so check animations with it off too." The probe defaults to reduce; check animated things once with `"motion":"no-preference"`.
- "No em dashes anywhere." In copy, comments you write, and commit messages.

## Keep (new on main, do not break)
- SEO: `/games` and `/games/<page>` landing pages (`server/gamePages.js`, `gamePageData.js`), sitemap.xml, the OG/JSON-LD head tags in `public/v2.html`.
- Lobby first load: the deferred wallet widget (`DSWalletBoot` / `DSLater`) and its sign-in stub, the splash, the inline critical CSS approach. `test/lobbyFirstLoad.test.js` must pass.
- The "Play for money" flow from a game page (lands on Free, gold outline on paid rungs plus a toast). The lobby footer link "Game guides".
- Every tab's real features, ids used by JS, query params (`?leaderboard=preview`, `?clips=preview`, `?earnings=preview`, `?headsoccer=preview`), and `go('<tab>')`.

## Testing (Owen's PC has 16 GB RAM)
- Run only the test files that read the files you changed: `grep -l "<file name>" test/*.js`, then `node --test --test-force-exit test/<one>.test.js` one at a time. Never the full suite, never anything named soak, fuzz, load or stress.
- When a test fails because it asserted old markup or copy you deliberately changed, update the assertion to the new markup and say so. Never weaken a money, security or wallet-logic test; if one fails, your change is wrong.

## Seeing it
- Local server: `DEV_LOCAL_PORT=<your port> node scripts/dev-local.js` (in-memory DB, network blocked, read its header). Start it in the background, note its PID, and kill exactly that PID right after each check (`taskkill /PID <pid> /F` or `kill <pid>`). Never kill node.exe by name: other sessions run servers on this PC.
- Probe: `node "C:/Users/owend/Documents/Coding Projects/Claude Code Test/site-redo/_tools/probe.mjs" <jobs.json>` (read its header: devices `pc1440` and `phone`, `signedIn` stub, `mock`, `motion`, steps). Jobs in `site-redo/_work/s3-<area>/`, shots `s3-<area>-<page>-<pc|phone>`. Compare against the mockup's shot side by side, fix, at most 3 rounds. Clear console errors, sideways overflow and low-contrast hits.
- Never sign in for real, never type into Privy or wallet forms, never press anything that moves money, never join a paid room, never post chat or clips, never open a visible browser or Owen's Chrome.

## Report (your structured output)
Files changed, commits (hash + subject), tests run with pass/fail, tests you changed and why, money-UI files touched, shot names, and anything not done or not matching the mockup.
