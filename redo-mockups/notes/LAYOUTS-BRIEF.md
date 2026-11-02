# DuelSeries site redo: Stage 2b, one look, four layouts (mockups only)

Read `site-redo/_work/LOOKS-BRIEF.md` first: the product, the data (`../assets/data.js`, `window.DSKit`), the hard rules and the probe all still apply. This brief only adds Owen's pick.

## What Owen said after seeing looks A, B and C (`site-redo/looks/<a|b|c>/`)
- Go with **A (House, evolved)**, but on **B's darker background** (B's true black lacquer instead of A's brown-black).
- He likes **3 games across on the phone** (as B and C do; A shows one big card per row, he does not want that).
- He likes **B's wallet**. Use B's wallet page as the model (its layout and the way it presents the balance, Add funds, Withdraw, address, history), redrawn in A's kit and colours. Err toward B's wallet as it is.
- Keep **the earnings chart from today's site**: `wt-site-redo/public/js/v2/chart.js` (`window.V2EarningsChart`, a running-total line with scrubbing, squeezed quiet gaps and zoom). Copy it (read-only source, do not edit the repo) and feed it the mockup's own cash-outs (`DSKit.data.myCashouts` or the payouts in `DSKit.data.txs`). Restyle its colours to the kit. It belongs in the wallet (Earnings).
- "All the layouts are sort of the same": he wants **genuinely different layouts** of this one look to choose from.
- He wants to **open and test them on his phone**. They will be published as a web page, so: only relative paths, no `file://` tricks, no `fetch()` of local files (data comes from `../../assets/data.js`), Google Fonts only, no other external scripts.

## The merged kit (one kit, shared by every layout)
`site-redo/looks/ab/kit.css` (+ `kit.js` for shared behaviour: sheets, toasts, segmented controls, stake sheet, Add funds and Withdraw sheets, the ported earnings chart in `chart.js`).
- A's system as the base: Archivo, bone `#f4f1ea` for actions, gold `#f0a830` for money only, green `#8ed081` for wins and live, red for errors, one button family, one sheet, one toast, A's radii and spacing.
- B's backgrounds: page `#000000`, panel `#0d0b08`, raised `#1a1611`, edge around `#36291a` (tune lines and text greys so contrast still passes on true black).
- Not B's arcade personality (no marquee bulbs, no LED digit font, no Tilt Warp) except inside the wallet if B's balance treatment is what makes its wallet good; if you use it there, keep it to the balance.

## The four layouts (each in `site-redo/looks/ab/<n>/`: home.html, wallet.html, events.html)
Each layout links `../kit.css`, `../kit.js`, `../chart.js`, `../../assets/data.js`, plus its own `layout.css` if needed. Same content, different structure. They must look different at first glance on PC AND on the phone.
1. **Sidebar** (A's structure, on black): left sidebar nav with Live games and the pinned Battle Royale, Live wins strip, Battle Royale banner, grid of all 16 games. Phone: header with balance, Live wins strip, Battle Royale card, 3-across grid, bottom bar.
2. **Top bar**: no sidebar. One header row with logo, tabs (Home, Wallet, Events, Leaderboards, Clips, Updates; Shop marked Soon), balance and Add funds. Live wins as a slim ticker under it. A full-width Battle Royale hero. Games in rows by kind (Big rooms, 1 v 1 duels, Solo if any, Coming soon), each row a rail with arrows on PC. Phone: the same rows as swipe rails showing 3 cards and a peek, bottom bar.
3. **Three columns**: a slim icon-only nav rail on the left, the games grid in the middle, a right "Live" column with the Battle Royale countdown card, a vertical Live wins feed and your balance with a small earnings sparkline and Add funds. Phone: a segmented control at the top of Home switches between Games (3-across grid) and Live (the right column's content).
4. **Spotlight**: one big featured game up top (the busiest: Slither.io, its art large, player count, and Play free / $0.50 / $1 right there), the Battle Royale as a countdown pill in the header that opens Events, then a dense grid of the other 15 with filter chips (All, Big rooms, 1 v 1, Coming soon). PC nav: a slim sidebar that can collapse. Phone: the featured card, then the 3-across grid, bottom bar.

Every layout: the stake sheet opens from a game card (Free / $0.50 / $1), Add funds and Withdraw sheets open from the wallet and the header, wallet `?signedout` shows one clear Sign in with a line on what the wallet is, events show the four states via `DSKit.states` with Soon as default. Nav links between home, wallet and events of the same layout work; other tabs can be inert but must look clickable (a toast "Not in this mockup" is fine).

## Phone
Owen tests on a Samsung S24 (384x832). 3 games across, 44px targets, nothing under the bottom bar, no sideways scroll, text never cut. The bottom bar: Home, Wallet, Events, Leaderboards, Settings.

## Checks
Probe every page at pc1440 and phone (job files in `site-redo/_work/looks-ab-<n>/`, shots `looks-ab-<n>-<page>-<pc|phone>`). Fix all console errors, sideways overflow and low-contrast hits. Grep for em dashes, "Deposit", "Cash out" in wallet copy, and blue or purple colours.
