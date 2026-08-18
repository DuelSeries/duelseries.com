'use strict';
// Guards the parallel-route migration: the redesigned lobby has to be reachable
// on the real server without disturbing the live one. These are structural
// checks, not behaviour — the page itself is exercised in the browser.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const v2 = () => fs.readFileSync(path.join(ROOT, 'public/v2.html'), 'utf8');
const server = () => fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');

test('the redesigned lobby is served at /v2', () => {
  const s = server();
  assert.ok(/app\.get\(\s*'\/v2'/.test(s), "server/index.js registers a '/v2' route");
  assert.ok(s.includes('v2.html'), 'the route points at v2.html');
});

test('the v2 shell is intact', () => {
  const html = v2();
  assert.ok(html.includes('<title>DuelSeries</title>'), 'has the title');
  // The card art is the real game renderer, so these must keep loading.
  for (const src of ['/shared/constants.js', '/js/HexGrid.js', '/js/SnakeGL.js',
                     '/js/FoodGL.js', '/js/Renderer.js', '/js/Camera.js']) {
    assert.ok(html.includes(src), `still loads ${src}`);
  }
});

test('the redesigned lobby is what players get at the root', () => {
  const s = server();
  assert.ok(/app\.get\('\/', .*v2\.html/.test(s), "'/' serves the redesigned lobby");
  // Declared before express.static, which would otherwise serve
  // public/index.html for '/' and quietly win.
  assert.ok(s.indexOf("app.get('/', ") < s.indexOf('express.static(path.join(__dirname, \'../public\'))'),
    'the root route is declared before the static handler');
});

test('the old lobby is still reachable as a way back', () => {
  // Kept for one release. If something only shows up under real traffic, the
  // fix is a URL rather than a revert and a redeploy.
  const s = server();
  assert.ok(/app\.get\('\/legacy', .*index\.html/.test(s), '/legacy serves the old lobby');
  assert.ok(fs.existsSync(path.join(ROOT, 'public/index.html')), 'index.html still exists');
  assert.ok(fs.existsSync(path.join(ROOT, 'public/js/lobby.js')), 'lobby.js still exists');
});

test('/v2 keeps working, so existing links do not break', () => {
  assert.ok(/app\.get\('\/v2', .*v2\.html/.test(server()), '/v2 still serves it');
});

test('social data comes from the server, not from a generated roster', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/social.js'), 'utf8');
  for (const ep of ['/api/earningsboard', '/api/players/search', '/api/profile/',
                    '/api/stats/winnings', '/api/money-config']) {
    assert.ok(src.includes(ep), `social.js calls ${ep}`);
  }
  const html = v2();
  for (const gone of ['mkPlayer', 'function seeded(', 'const PLAYERS=', 'const PNAMES=']) {
    assert.ok(!html.includes(gone), `the generated roster is gone: ${gone}`);
  }
});

test('the profile shows only figures the server actually records', () => {
  // getProfile returns name, totalEarnings, gamesPlayed, playTimeSeconds and
  // earnings series — no per-game win/loss, buy-in or house cut. Showing those
  // would mean inventing them, which is what the prototype did.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/social.js'), 'utf8');
  assert.ok(!/Win rate/.test(src), 'no win rate, the server does not record it per player');
  assert.ok(!/House cut paid/.test(src), 'no per-player house cut');
  assert.ok(src.includes('gamesPlayed') && src.includes('playTimeSeconds'),
    'shows the fields that do exist');
});

test('search is debounced and cancels the previous request', () => {
  // Without both, fast typing lands an earlier response after a later one and
  // the list shows results for a query the user has already moved past.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/social.js'), 'utf8');
  assert.ok(src.includes('setTimeout'), 'debounced');
  assert.ok(src.includes('AbortController'), 'aborts the in-flight request');
});

test('the skin store is shared with the live lobby', () => {
  // Both lobbies run side by side during the migration, so they have to agree
  // on the equipped skin rather than each keeping their own.
  const key = 'duelseries_skin_id';
  assert.ok(v2().includes(key), 'v2 uses the live skin key');
  assert.ok(fs.readFileSync(path.join(ROOT, 'public/js/lobby.js'), 'utf8').includes(key),
    'the live lobby uses the same key');
});

test('the wallet screen delegates to the Privy widget, not its own money code', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/wallet.js'), 'utf8');
  for (const g of ['duelWalletLogin', 'duelWalletFund', 'duelWalletSend', 'duelwallet:change'])
    assert.ok(src.includes(g), `wallet.js uses ${g}`);
  // A second implementation of staking or signing here would be a second money
  // path to keep correct. There must not be one.
  for (const bad of ['submit-stake', 'stake-quote', 'signTransaction', 'Keypair'])
    assert.ok(!src.includes(bad), `wallet.js does not do its own ${bad}`);
});

test('the v2 lobby mounts the same wallet widget as the live lobby', () => {
  const html = v2();
  assert.ok(html.includes('/wallet/widget.js'), 'widget is mounted');
  assert.ok(html.includes('id="wallet-root"'), 'widget has its mount point');
  assert.ok(html.indexOf('window.global=window.global') < html.indexOf('/wallet/widget.js'),
    'the node-global shims run before the bundle, as they must');
});

test('a signed-out wallet never shows a fabricated balance', () => {
  // "$0.00" and "not connected" mean very different things about someone's
  // money. The mock hardcoded $12.40 into the markup; nothing may do that.
  const html = v2();
  assert.ok(!/\$12\.40/.test(html), 'no hardcoded balance in the markup');
  assert.ok(!html.includes('C5cnQ7v2'), 'no hardcoded deposit address');
});

test('stats show profit only when buy-ins are actually recorded', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/stats.js'), 'utf8');
  assert.ok(src.includes('/api/my-profile'), 'reads the real profile');
  // Profit is real now that stakes_history exists, but only for games played
  // since. Showing earnings-minus-nothing would read as pure profit.
  assert.ok(src.includes('stakesTracked'), 'checks whether buy-ins exist');
  assert.ok(/if \(tracked\)/.test(src), 'and gates the profit tile on it');
  assert.ok(src.includes('not recorded yet'), 'says so when they are not');
  // Win rate and per-game house cut still are not derivable per player.
  for (const bad of ['Win rate', 'House cut paid'])
    assert.ok(!src.includes(bad), `stats.js still does not claim ${bad}`);
});

test('buy-ins are recorded at the single point every paid entry passes', () => {
  // Four handlers consume entry tokens. Recording at each would let one drift
  // or be forgotten; recording inside consumePaidEntry cannot.
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.ok(/function consumePaidEntry\(entryToken, shortType, game\)/.test(src),
    'consumePaidEntry takes the game');
  assert.ok(/db\.recordStake\(/.test(src), 'and records the stake');
  assert.equal((src.match(/db\.recordStake\(/g) || []).length, 1,
    'recorded in exactly one place');
  // A failed stats write must never cost someone their seat.
  const i = src.indexOf('db.recordStake(');
  assert.ok(src.slice(i, i + 200).includes('.catch('), 'and never throws into the join path');
  assert.ok(!/await db\.recordStake/.test(src), 'and is never awaited');
});

test('the profile series are read from where the server actually puts them', () => {
  // getProfile nests week/month/sixMonth/allTime under `history`. Reading them
  // flat silently yields no chart at all, which is exactly what happened.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/social.js'), 'utf8');
  assert.ok(/p\.history/.test(src), 'social.js reads p.history');
  const db = fs.readFileSync(path.join(ROOT, 'server/db.js'), 'utf8');
  assert.ok(/history: \{/.test(db), 'and the server really does nest them');
});

test('no invented game history survives in the shell', () => {
  const html = v2();
  for (const gone of ['const SESSIONS=', 'const ROWS=', 'const CUM=', 'function drawStats',
                      'function drawChart', "const RAKE=0.10"])
    assert.ok(!html.includes(gone), `gone: ${gone}`);
});

test('the board reads /api/live and invents no counts of its own', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/board.js'), 'utf8');
  assert.ok(src.includes('/api/live'), 'reads the live board');
  const html = v2();
  assert.ok(!html.includes('const LOBBIES=['), 'the hand-written lobby rows are gone');
  assert.ok(!/cap:30/.test(html), 'and the invented capacity with them');
});

test('the server reports capacity as null, not an invented seat count', () => {
  // Persistent rooms have no seat limit: the world grows with the crowd. A
  // number here would put a fake "7 of 30" in front of someone about to stake.
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.ok(/capacity: null/.test(src), 'capacity is null');
  assert.ok(src.includes("app.get('/api/live'"), '/api/live exists');
});

test('bots are reported separately and not folded into the player count', () => {
  // "12 playing" when eleven are bots is a lie told to someone about to stake.
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.ok(/players: hit \? hit\.players/.test(src), 'players is the real count');
  assert.ok(/bots: hit \?/.test(src), 'bots are their own field');
  const board = fs.readFileSync(path.join(ROOT, 'public/js/v2/board.js'), 'utf8');
  assert.ok(!/players\s*\+\s*.*bots|bots\s*\+\s*.*players/.test(board),
    'the client never adds them together');
});

test('play delegates to the widget and never stakes on its own', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/play.js'), 'utf8');
  assert.ok(src.includes("'duel:play'"), 'fires the same event the live lobby fires');
  for (const bad of ['submit-stake', 'stake-quote', 'signTransaction'])
    assert.ok(!src.includes(bad), `play.js does not do its own ${bad}`);
});

test('a launch that does not name a room is refused, not defaulted', () => {
  // The widget defaults a missing lobbyType to 'dime'. Dispatching without
  // naming a room would silently charge ten cents for one nobody chose.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/play.js'), 'utf8');
  assert.ok(/if \(!hasStake && !hasTier\)/.test(src), 'an unnamed room is checked for');
  const guard = src.indexOf('if (!hasStake && !hasTier)');
  const fire = src.indexOf("new CustomEvent('duel:play'");
  assert.ok(guard > -1 && fire > guard, 'and checked before anything is dispatched');
  // Exactly one selector goes out, so the server never has to guess.
  assert.ok(/\{ game: game, stake: Number\(sel\.stake\) \}/.test(src), 'sends a rung');
  assert.ok(/\{ game: game, lobbyType: sel\.lobbyType \}/.test(src), 'or a tier, not both');
});

test('a respawn re-buys the room the player is already in', () => {
  // Taken from socket._stake, not from anything the client sends at respawn
  // time, so nobody dies in the $0.25 room and respawns into the $20 one.
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.ok(/consumePaidEntryAtStake\(entryToken, socket\._stake/.test(src),
    'respawn uses the socket\'s own rung');
});

test('the ladder door demands a token bought for that exact rung', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.ok(/consumePaidEntryAtStake\(entryToken, Number\(stake\)/.test(src),
    'join checks the token against the rung');
  const store = fs.readFileSync(path.join(ROOT, 'server/entryStore.js'), 'utf8');
  assert.ok(/Math\.abs\(t\.stake - stake\) > EPS/.test(store),
    'and the store compares the amounts rather than trusting the request');
});

test('the lobby pauses its animations while the game is up', () => {
  // The game shares the main thread. Animating behind it is what produced the
  // 30fps drop that took a day to trace to the lobby's preview snake.
  const html = v2();
  assert.ok(html.includes('window._pauseLobbyAnims'), 'publishes the pause hook');
  assert.ok(html.includes('window._resumeLobbyAnims'), 'and the resume hook');
  assert.ok(html.includes('body.ingame .tkrun'), 'the ticker stops too');
  // _paused must be declared before the frame loop that reads it, or the whole
  // script dies in the temporal dead zone on the first frame.
  assert.ok(html.indexOf('let _paused=false;') < html.indexOf('(function loop(t){'),
    '_paused is declared above the loop');
});

test('the game iframe keeps the id the wallet widget looks up', () => {
  const html = v2();
  assert.ok(html.includes('id="game-frame"'), 'the frame exists under the expected id');
  const widget = fs.readFileSync(path.join(ROOT, 'public/wallet/widget.js'), 'utf8');
  assert.ok(widget.includes('game-frame'), 'and the widget really does look it up');
});

test('the wallet widget can stake by ladder rung as well as by tier', () => {
  // The bundle is generated, so this checks the built artefact rather than the
  // source: a stale bundle is the failure mode that matters.
  const b = fs.readFileSync(path.join(ROOT, 'public/wallet/widget.js'), 'utf8');
  assert.ok(b.includes('/api/stake-quote?stake='), 'quotes by rung');
  assert.ok(b.includes('/api/stake-quote?lobbyType='), 'and still by tier');
  assert.ok(/stake:.{0,20}signedTx/.test(b), 'submits a rung');
  assert.ok(/lobbyType:.{0,20}signedTx/.test(b), 'and still submits a tier');
});

test('the widget source and the shipped bundle have not drifted apart', () => {
  // A source edit that was never rebuilt ships nothing. Both must mention the
  // ladder or the bundle is stale.
  const src = fs.readFileSync(path.join(ROOT, 'wallet-widget/src/main.jsx'), 'utf8');
  const bundle = fs.readFileSync(path.join(ROOT, 'public/wallet/widget.js'), 'utf8');
  assert.ok(src.includes('/api/stake-quote?stake='), 'source has the ladder path');
  assert.ok(bundle.includes('/api/stake-quote?stake='), 'and so does the bundle');
});

test('the lobby makes no claim about money it cannot honour', () => {
  // The prototype's tournament block advertised a live $20 prize with a running
  // countdown and a podium of winners. There is no tournament system. In front
  // of players staking real money that is a promise, not a placeholder.
  const html = v2();
  for (const claim of ['winner takes all', 'top three split', 'Ends in', 'chip live'])
    assert.ok(!html.includes(claim), `no fabricated tournament claim: ${claim}`);
  // The handlers must be gone as code, not merely unmentioned: a comment naming
  // them is fine, a live onclick or definition is not.
  for (const fn of ['enterTournament', 'remindMe']) {
    assert.ok(!html.includes(`onclick="${fn}`), `nothing calls ${fn}`);
    assert.ok(!html.includes(`function ${fn}(`), `${fn} is not defined`);
  }
  /* The section itself is gone as of 2026-08-18: a panel describing a system
     that does not exist is dead space on the screen people use to start a
     game. What must not come back is a claim, so the guards above stay. */
  assert.ok(!/<h2>Tournaments<\/h2>/.test(html), 'no tournament section');
  assert.ok(!/class="trn"/.test(html), 'and none of its cards');
});

test('the phone layout exists and the header cannot overflow again', () => {
  const html = v2();
  assert.ok(/@media\(max-width:760px\)/.test(html), 'there is a phone breakpoint');
  assert.ok(/\.nav\{position:fixed;left:0;right:0;bottom:0/.test(html), 'nav moves to the bottom');
  // A filtered ancestor becomes the containing block for its fixed children,
  // which pinned the nav to the bottom of the HEADER instead of the screen.
  assert.ok(/backdrop-filter:none/.test(html), 'the header drops its filter on phones');
  assert.ok(/viewport-fit=cover/.test(html), 'the page paints under the notch');
  assert.ok(/env\(safe-area-inset-bottom\)/.test(html), 'and keeps content off the home indicator');
});

test('the legal links are pinned on every screen', () => {
  const html = v2();
  assert.ok(/footer\{position:fixed/.test(html), 'the footer is fixed on phones');
  // Transparent would let whatever is scrolling behind read through the text.
  const i = html.indexOf('footer{position:fixed');
  assert.ok(html.slice(i, i + 260).includes('background:var(--bg)'), 'and opaque');
});

test('fullscreen is attempted honestly, not faked', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/mobile.js'), 'utf8');
  // Browsers only honour it from a gesture, so it is hooked to the first tap.
  assert.ok(/pointerdown/.test(src) && /once: true/.test(src), 'requested on first gesture');
  assert.ok(/requestFullscreen/.test(src), 'uses the real API where it exists');
  // iOS has no Fullscreen API for non-video, so the honest route is installing.
  const html = v2();
  assert.ok(html.includes('apple-mobile-web-app-capable'), 'iOS standalone is declared');
  assert.ok(html.includes('manifest.webmanifest'), 'and a manifest is linked');
  assert.ok(fs.existsSync(path.join(ROOT, 'public/manifest.webmanifest')), 'which exists');
});

test('the board lists only lobbies that have players', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/board.js'), 'utf8');
  assert.ok(/\(l\.players \|\| 0\) > 0/.test(src), 'filters to occupied rooms');
  assert.ok(/Nobody is playing right now/.test(src), 'and says so when there are none');
});

test('the last buy-in played is remembered, including free', () => {
  const html = v2();
  assert.ok(html.includes('duelseries_last_stake'), 'the choice is stored');
  // Free is 0, so a truthiness check would silently forget it.
  assert.ok(/including 0: free is a real choice/.test(html), 'and 0 is not treated as unset');
  const play = fs.readFileSync(path.join(ROOT, 'public/js/v2/play.js'), 'utf8');
  assert.ok(/rememberStake\(Number\(sel\.stake\)\)/.test(play),
    'recorded at launch, not at selection');
});

test('the earnings chart is scrubbable and has labelled axes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/chart.js'), 'utf8');
  assert.ok(/pointerdown/.test(src) && /pointermove/.test(src), 'follows a finger');
  assert.ok(/setPointerCapture/.test(src), 'and keeps following it off the element');
  assert.ok(/touchAction/.test(src), 'without the page stealing the drag as a scroll');
  assert.ok(/fmtDate/.test(src), 'dates along the x axis');
});

test('the manifest meets what Chrome needs to install a real app', () => {
  // Below Chrome's bar, Add to Home Screen silently makes a bookmark shortcut
  // that opens in a browser tab. That looks like the fullscreen setting being
  // ignored, but the install never happened. The 87x88 icon it shipped with
  // was exactly that failure.
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8'));
  assert.ok(m.name && m.short_name && m.start_url, 'the basics are present');
  assert.ok(['fullscreen', 'standalone'].includes(m.display), 'an installable display mode');
  const png = s => m.icons.some(i => i.type === 'image/png' && parseInt(i.sizes) >= s);
  assert.ok(png(192), 'a 192px icon, which is the hard minimum');
  assert.ok(png(512), 'and a 512px one');
  assert.ok(m.icons.some(i => (i.purpose || '').includes('maskable')), 'a maskable icon');
  for (const i of m.icons)
    assert.ok(fs.existsSync(path.join(ROOT, 'public' + i.src)), `${i.src} exists`);
});

test('the service worker exists and caches nothing', () => {
  // A caching worker on a real-money lobby shows yesterday's balance with no
  // obvious way for a player to clear it. It is here for installability only.
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  assert.ok(/addEventListener\('fetch'/.test(sw), 'has a fetch handler, which is what Chrome checks');
  assert.ok(!/cache\.put|caches\.open/.test(sw), 'and never writes to a cache');
  assert.ok(/caches\.delete/.test(sw), 'and clears any cache a previous version left');
});

test('the game screen puts the action above the lobby list on a phone', () => {
  // Collapsed naively, the two-column hero stacked the whole left column first,
  // which put an empty lobby list between the artwork and the Play button and
  // pushed the only action on the screen below the fold.
  const html = v2();
  assert.ok(/\.hero>div,\.hero>div:last-child\{display:contents\}/.test(html),
    'both column wrappers dissolve so their contents can be ordered');
  // :last-child is named explicitly because the desktop bottom-align rule sets
  // display:flex on it and is the more specific selector.
  assert.ok(/\.hart\{order:1/.test(html), 'art first');
  assert.ok(/\.stake\{order:5/.test(html), 'then the buy-in');
  assert.ok(/#dlob\{order:8\}/.test(html), 'and the lobby list last');
});

test('the brand mark is wired everywhere a browser asks for one', () => {
  // Tab, bookmark bar, iOS bookmark, installed app: four different requests,
  // and a missing one silently falls back to a blank page glyph.
  for (const page of ['public/v2.html', 'public/game.html', 'public/index.html',
                      'public/agar.html']) {
    const h = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.ok(h.includes('/img/favicon-32.png'), `${page} sets the tab icon`);
    assert.ok(h.includes('/img/apple-touch-icon.png'), `${page} sets the iOS icon`);
  }
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8'));
  assert.ok(m.icons.some(i => i.src === '/img/icon-512.png'), 'the app uses it too');
  for (const f of ['favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png',
                   'icon-192.png', 'icon-512.png'])
    assert.ok(fs.existsSync(path.join(ROOT, 'public/img', f)), `${f} exists`);
});

test('a forced desktop viewport is detected and explained', () => {
  // Chrome's "Desktop site" lays the page out at ~980px and scales it down, so
  // every phone media query stops matching and the symptom looks exactly like
  // a broken responsive layout. Nothing can override it, so it is named.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/mobile.js'), 'utf8');
  assert.ok(/desktopSiteForced/.test(src), 'the case is detected');
  assert.ok(/Desktop site/.test(src), 'and the fix is named in the message');
  // Must not fire on a real tablet or a small laptop.
  assert.ok(/physical <= 500/.test(src), 'gated on a physically narrow screen');
});

test('swipe navigation exempts anything that owns its own horizontal drag', () => {
  // The earnings chart is scrubbed by dragging sideways and the appearance
  // screen has its own arrows. A page-wide swipe handler that ignored those
  // would make the chart unusable and change tabs mid-read.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/swipe.js'), 'utf8');
  const ex = src.slice(src.indexOf('const EXEMPT'), src.indexOf('const TABS'));
  for (const sel of ['.chartbox', '.apscreen', '#game-frame'])
    assert.ok(ex.includes(sel), `${sel} is exempt`);
  /* These are NOT exempt and must not be re-added. Form fields were, and the
     player search box on Social ate every swipe starting over it — a wide
     target sitting exactly where a thumb lands. The winners ticker was too,
     which carved a dead stripe across the middle of the most swiped screen;
     it is a CSS marquee with no controls by design, so it has no gesture of
     its own to protect. */
  for (const f of ['input', 'textarea', 'select', '.ticker'])
    assert.ok(!ex.includes(f), `${f} is not exempt`);
  assert.ok(/railwrap/.test(src), 'the games rail gets the swipe instead of the tabs');
  // A mostly-vertical drag is a scroll, not a swipe.
  assert.ok(/Math\.abs\(dx\) < Math\.abs\(dy\) \* CLAIM_RATIO/.test(src), 'direction is checked');
  assert.ok(/touchstart/.test(src) && !/pointerdown/.test(src),
    'touch only, since a mouse drag is a text selection');
});

test('cashing out gets its own screen, not the death card in green', () => {
  // It used to reuse #death-screen: same red overlay, same shake animation,
  // heading swapped to green. Winning and dying looked like the same event.
  const js = fs.readFileSync(path.join(ROOT, 'public/js/game.js'), 'utf8');
  const handler = js.slice(js.indexOf("socket.on('cashout:result'"),
                           js.indexOf("socket.on('cashout:paid'"));
  assert.ok(handler.includes("getElementById('cashout-screen')"), 'its own screen is shown');
  assert.ok(!/death-screen'\)\.classList\.add\('active'\)/.test(handler),
    'the death card is not raised on a win');
  assert.ok(!/SUCCESSFULLY CASHED OUT/.test(js), 'the old headline swap is gone');

  // Both up at once means the death card's Play Again sits behind the receipt,
  // and in a paid room that button re-stakes real money.
  assert.ok(/death-screen'\)\.classList\.remove\('active'\)/.test(handler),
    'showing the receipt clears the death card');
  const diedAt = js.indexOf('EVENTS.PLAYER_DIED');
  const died = js.slice(diedAt, js.indexOf('\n});', diedAt));
  assert.ok(/cashout-screen'\)\.classList\.remove\('active'\)/.test(died),
    'and dying clears the receipt');
});

test('the cash-out receipt states the payout in the unit actually paid', () => {
  // The payout event's field is still named `sol` from before the USDC
  // cutover but carries whichever unit is live, so a hardcoded "SOL" label
  // told a player their dollars were SOL.
  const js = fs.readFileSync(path.join(ROOT, 'public/js/game.js'), 'utf8');
  const paid = js.slice(js.indexOf("socket.on('cashout:paid'"),
                        js.indexOf("socket.on('cashout:error'"));
  assert.ok(/fmtMoney/.test(paid), 'formatted for the active money mode');
  assert.ok(!/SOL/.test(paid), 'never labelled SOL outright');

  // The rake is shown as a line item rather than quietly netted off.
  const html = fs.readFileSync(path.join(ROOT, 'public/game.html'), 'utf8');
  for (const id of ['co-gross', 'co-cut', 'co-net', 'co-settle', 'co-tx'])
    assert.ok(html.includes(id), `${id} is on the receipt`);
  assert.ok(/House cut/.test(html), 'the cut is named');

  // The server sends the gross so the receipt is not doing its own arithmetic
  // off the 90% share.
  const srv = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.ok(/cashout:result',\s*\{[^}]*gross: worth[^}]*cut: ownerShare/.test(srv),
    'gross and cut are sent for display');
});

test('touch steering is anchored where the thumb lands, not at the screen centre', () => {
  /* slither.io's WEB client steers absolutely from the middle of the screen
     (xm = clientX - ww/2). That was built first and it is wrong for this game:
     it forces you to keep a thumb near the centre, which is what the owner hit
     immediately. Their native app does not behave that way, and the app is
     what people actually play on a phone.

     So the heading is the vector from an anchor set at touch-down to the thumb
     now. Thumb at the bottom of the screen, slide up a little, snake goes up.
     The anchor follows once the thumb is further than TOUCH_FOLLOW_R away, so
     a long drag never runs out of travel and you can always turn back. */
  const js = fs.readFileSync(path.join(ROOT, 'public/js/game.js'), 'utf8');
  assert.ok(js.includes('anchorX = p.x; anchorY = p.y'), 'a touch sets the anchor under the thumb');
  assert.ok(js.includes('TOUCH_FOLLOW_R'), 'and the anchor follows a long drag');
  assert.ok(js.includes('anchorX = p.x - (dx / d) * TOUCH_FOLLOW_R'),
    'dragged to sit exactly that far behind the thumb');
  // Scoped to the aim function: innerWidth/2 legitimately appears elsewhere
  // for the view radius, which has nothing to do with steering.
  const aimAt = js.indexOf('function updateTouchAim');
  const aim = js.slice(aimAt, js.indexOf('\n}', aimAt));
  assert.ok(!/inner(Width|Height)/.test(aim),
    'the heading is not measured from the screen centre any more');
  assert.ok(aim.includes('anchorX') && aim.includes('anchorY'), 'it is measured from the anchor');
  /* Boost is a second finger, not a double-tap. A double-tap only fires when
     the previous tap was in nearly the same spot, so boosting mid-turn meant
     lifting the thumb you were steering with and coasting straight. */
  const start = js.slice(js.indexOf("canvas.addEventListener('touchstart'"),
                         js.indexOf("canvas.addEventListener('touchmove'"));
  assert.ok(/e\.touches\.length > 1.*boostActive = true/s.test(start),
    'a second finger boosts');
  assert.ok(start.includes('return'), 'and does not also become a steering touch');
  assert.ok(!js.includes('TOUCH_DBLTAP'), 'the double-tap is gone');
  // Steering must track the first finger, not whichever one just changed.
  const tp = js.slice(js.indexOf('function touchPoint'), js.indexOf('function updateTouchAim'));
  assert.ok(tp.includes('e.touches[0]'), 'steering follows the first finger down');

  // The joystick and boost button are gone from markup, styles and script.
  const html = fs.readFileSync(path.join(ROOT, 'public/game.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/css/game.css'), 'utf8');
  for (const src of [html, css, js]) {
    assert.ok(!/joystick-zone|joystick-base|joystick-knob/.test(src), 'no joystick left');
    assert.ok(!/boost-btn/.test(src), 'no boost button left');
  }
  assert.ok(html.includes('cashout-btn-mobile'), 'cash out is the only on-screen control');
});

test('the heading arrow is centred in screen space, not in its rotated frame', () => {
  /* CSS applies transform functions right to left, so a trailing
     translate(-50%,-50%) is applied inside the element's own rotated frame:
     the centring offset spins with the heading and the arrow slides off to one
     side, worst at the diagonals. It has to come first. */
  const js = fs.readFileSync(path.join(ROOT, 'public/js/game.js'), 'utf8');
  const i = js.indexOf('function updateDirArrow');
  const fn = js.slice(i, js.indexOf('\n}', i));
  assert.ok(fn.includes('translate(-50%, -50%)'), 'the arrow is centred on its point');
  assert.ok(fn.indexOf('translate(-50%') < fn.indexOf('rotate('),
    'and centring comes before the rotation, so it is applied unrotated');
  assert.ok(fn.indexOf('rotate(') < fn.indexOf('translateX('),
    'the forward offset is applied in the rotated frame, which is the point');
});

test('the death card is the receipt in red, and says what was lost', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/css/game.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public/game.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public/js/game.js'), 'utf8');

  // The card's rules sit later in the file than this screen's, so overriding
  // colours per element here loses to them silently. It must recolour by
  // redefining the accent token the shared card already reads.
  assert.ok(/#death-screen \{[^}]*--co-money:\s*#e0705f/.test(css),
    'recolours the shared card by its accent token');
  assert.ok(!/^\s*\.dd-(amount|eyebrow|go)\s*\{/m.test(css),
    'and not with same-specificity overrides that would lose');
  assert.ok(!/death-shake/.test(css), 'the shake is gone');
  assert.ok(html.includes('co-card dd-card'), 'same card as the cash-out receipt');

  // Worth has to be read before _lReset clears the snapshot it comes from.
  const diedAt = js.indexOf('EVENTS.PLAYER_DIED');
  const died = js.slice(diedAt, js.indexOf('\n});', diedAt));
  assert.ok(died.indexOf('_latestMySnap') < died.indexOf('_lReset()'),
    'the lost amount is read before the state holding it is cleared');

  // Play again re-stakes, so the price is on the button.
  assert.ok(/Play again \$\{fmtMoney\(stake\)\}/.test(js.replace(/`/g, '')) ||
            /Play again \${fmtMoney\(stake\)}/.test(js),
    'the button names the cost in a paid room');
});

test('the trophy glyph is gone and the all-time board is still reachable', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/game.html'), 'utf8');
  assert.ok(!html.includes('\u{1F3C6}'), 'no trophy emoji anywhere');
  // Removing the button would have removed the only way into that board.
  assert.ok(/id="btn-alltime-lb"/.test(html), 'the all-time board still has an entry point');
  assert.ok(/lb-head/.test(html), 'it lives on the leaderboard now, not floating beside it');
});

test('the icons are cut from the real artwork, not redrawn', () => {
  // make-icons.js used to redraw the emblem with canvas primitives because the
  // real file was not on disk. It is now, and an approximation of someone's
  // logo is not their logo.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/make-icons.js'), 'utf8');
  assert.ok(src.includes('logo-source.png'), 'it reads the source artwork');
  assert.ok(/function decodePng/.test(src), 'and decodes it rather than drawing');
  assert.ok(fs.existsSync(path.join(ROOT, 'public/img/logo-source.png')),
    'the source artwork is committed, so the icons can always be rebuilt');

  // Downscaling without premultiplying averages the colour of transparent
  // pixels into the edge and rings the logo with a dark halo.
  assert.ok(/premultiply|al = src\[i \+ 3\]/.test(src), 'alpha is handled in the resize');

  // Every size a browser or launcher asks for must exist.
  for (const f of ['favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png',
                   'icon-192.png', 'icon-512.png']) {
    const p = path.join(ROOT, 'public/img', f);
    assert.ok(fs.existsSync(p), `${f} exists`);
    const b = fs.readFileSync(p);
    assert.equal(b.readUInt32BE(0), 0x89504e47, `${f} is a PNG`);
  }
  // Chrome will not install an app without a >=192 icon.
  const big = fs.readFileSync(path.join(ROOT, 'public/img/icon-512.png'));
  assert.equal(big.readUInt32BE(16), 512, 'icon-512 really is 512 wide');
});

test('swiping between tabs animates, and never leaves a screen pinned', () => {
  /* An instant swap is hard to tell from a tap that did nothing, so the
     screens cross-slide in the direction of travel. The outgoing one is lifted
     to fixed position for the length of the animation, which means the cleanup
     has to be airtight: a screen left fixed sits on top of everything. */
  const html = v2();
  assert.ok(/@keyframes scrIn/.test(html) && /@keyframes scrOut/.test(html),
    'both halves of the cross-slide exist');
  assert.ok(/function showScreen\(id,dir\)/.test(html), 'showScreen takes a direction');
  assert.ok(/function go\(id,dir\)/.test(html), 'and go passes it through');

  // The settle-up must run BEFORE the DOM is read. Mid-flight two screens are
  // visible, and picking one of those as the outgoing screen grabs the one
  // already leaving, which then gets re-pinned and sticks.
  const i = html.indexOf('function showScreen(id,dir)');
  const fn = html.slice(i, html.indexOf('\n}', html.indexOf('_scrBusy=done', i)));
  assert.ok(fn.indexOf('if(_scrBusy)_scrBusy()') < fn.indexOf('const prev='),
    'any running transition is finished before the DOM is inspected');

  // Reduced motion is honoured, and a swipe still changes screen.
  assert.ok(/prefers-reduced-motion/.test(html), 'reduced motion is respected');
});

test('a tab swipe follows the finger and can be pulled back', () => {
  /* The gesture drags the next screen in under the finger rather than firing
     an animation after release, so a half-swipe shows you what is there and
     can be abandoned. Without that, a partial swipe is indistinguishable from
     a tap that did nothing. */
  const sw = fs.readFileSync(path.join(ROOT, 'public/js/v2/swipe.js'), 'utf8');
  const html = v2();

  assert.ok(/window\.prepareScreen/.test(sw) && /window\.commitScreen/.test(sw),
    'it stages the incoming screen before routing to it');
  assert.ok(/function prepareScreen/.test(html) && /function commitScreen/.test(html),
    'and the lobby provides both');
  // Staging must load the screen's data, or you drag in an empty panel.
  const fill = html.slice(html.indexOf('function fillScreen'),
                          html.indexOf('function prepareScreen'));
  for (const m of ['V2Wallet.render()', 'V2Stats.load()', 'V2Social.load()'])
    assert.ok(fill.includes(m), `fillScreen loads the screen's data (${m})`);
  const prep = html.slice(html.indexOf('function prepareScreen'),
                          html.indexOf('function commitScreen'));
  assert.ok(prep.includes('fillScreen(tab)'), 'and staging calls it');

  /* The outgoing screen must be MEASURED before the incoming one is shown.
     prepareScreen puts the incoming screen into flow for an instant, and the
     screens are siblings: showing one that sits earlier in the document pushes
     the outgoing one down by its whole height. Measuring after that pinned the
     incoming screen ~1350px down an 812px screen, so backward swipes dragged
     in nothing. Forward swipes were fine, which is exactly how it hid. */
  const bd = sw.slice(sw.indexOf('function beginDrag'), sw.indexOf('function move'));
  // Against the CALL, not the `!window.prepareScreen` guard above it.
  assert.ok(bd.indexOf('cur.getBoundingClientRect()') < bd.indexOf('prepareScreen(tab)'),
    'the outgoing screen is measured before the incoming one is shown');

  // Release decides by distance OR speed: a short fast flick has to count.
  assert.ok(/COMMIT_FRAC/.test(sw), 'distance decides');
  assert.ok(/FLICK_VPX/.test(sw), 'and so does a flick');
  // Two moves can land in the same millisecond during a fast flick; dividing
  // by that zero left the velocity at 0 and ignored the fastest flicks.
  assert.ok(/Math\.max\(1, now - drag\.lastT\)/.test(sw),
    'the velocity clock cannot divide by zero');

  // The drag must claim the gesture before it can suppress page scrolling.
  assert.ok(/touchmove'.*\{ passive: false \}/s.test(sw), 'touchmove is cancelable');
  assert.ok(sw.indexOf('e.preventDefault()') > sw.indexOf('if (!drag)'),
    'and only prevents default once the drag is claimed');

  // Every exit has to put the staged screen away; a screen left fixed covers
  // the whole app.
  assert.ok(/touchcancel/.test(sw), 'a cancelled touch settles the drag');
  const fin = sw.slice(sw.indexOf('function finish'), sw.indexOf('function onEnd(e)'));
  assert.ok(/classList\.remove\('scr-drag'/.test(fin), 'the staged screen is unpinned');
  assert.ok(/setAttribute\('style', d\.saved\)/.test(fin), 'and its inline styles restored');
});

test('chat on a phone is readable but not typeable, and small', () => {
  /* There is no T key on a phone to open the input, and a keyboard sliding up
     mid-game covers the snake. The feed stays; the panel and the input go. */
  const css = fs.readFileSync(path.join(ROOT, 'public/css/game.css'), 'utf8');
  const i = css.indexOf('Chat on a phone');
  assert.ok(i > 0, 'there is a phone-specific chat block');
  const block = css.slice(i, css.indexOf('\n}\n', css.indexOf('#chat-hint', i)) + 3);
  assert.ok(/#chat-input[^}]*display: none/.test(block) ||
            /#chat-input, #chat-input\.open, #chat-hint \{ display: none/.test(block),
    'the input is hidden');
  assert.ok(/pointer-events: none/.test(block),
    'and the feed never swallows a steering touch');
});

test('the spectate bar fits a phone instead of hanging off both edges', () => {
  /* Five controls around a 160px label is about 420px wide, centred with
     translateX(-50%). On a 375px screen that overhangs both sides, which is
     what you land on straight after tapping Keep watching. */
  const css = fs.readFileSync(path.join(ROOT, 'public/css/game.css'), 'utf8');
  const i = css.indexOf('Spectate bar on a phone');
  assert.ok(i > 0, 'there is a phone-specific spectate block');
  const block = css.slice(i, i + 2200);
  assert.ok(/transform: none/.test(block), 'it is no longer centre-offset');
  assert.ok(/left: 12px/.test(block) && /right: 12px/.test(block), 'it is pinned to both edges');
  // flex-wrap alone let all five squeeze onto one row; the break is explicit.
  assert.ok(/#spectate-bar::after/.test(block), 'the row break is forced');
  assert.ok(/min-height: 44px/.test(block), 'the exits are a real touch target');
});

test('the death card uses the product palette for its buttons', () => {
  // Red is for the amount lost. A red button reads as a warning about the
  // button, and made this screen look like a different app from the receipt.
  const css = fs.readFileSync(path.join(ROOT, 'public/css/game.css'), 'utf8');
  assert.ok(/#death-screen \{[^}]*--co-act:\s*#f0a830/.test(css),
    'the action colour is the product amber');
  assert.ok(/#death-screen \.co-go \{ background: var\(--co-act\)/.test(css),
    'and the primary button uses it');
  assert.ok(/#death-screen \{[^}]*--co-money:\s*#e0705f/.test(css),
    'while the amount lost stays red');
});

test('Locker and Settings are separate screens, so you can swipe between them', () => {
  /* They were both the single #stub element. A swipe between them therefore
     had the same node on each side, beginDrag bailed out, and the gesture did
     nothing — the only pair of neighbouring tabs where that happened. */
  const html = v2();
  assert.ok(/id="stub2"/.test(html), 'there is a second placeholder screen');
  assert.ok(/id="stub2-t"/.test(html) && /id="stub2-d"/.test(html), 'with its own fields');
  assert.ok(/locker:'stub',settings:'stub2'/.test(html), 'and the two tabs map to different ones');
  // Both have to be in the hide-all list or one can be left showing under another.
  const s = html.slice(html.indexOf('const SCREENS='), html.indexOf('function showScreen'));
  assert.ok(s.includes("'stub'") && s.includes("'stub2'"), 'both are routable screens');
  const sw = fs.readFileSync(path.join(ROOT, 'public/js/v2/swipe.js'), 'utf8');
  assert.ok(/'stub', 'stub2'/.test(sw), 'and the swipe knows about both');
});

test('the free lobby is always on the board, with an honest count', () => {
  /* Open lobbies otherwise lists only rooms with people in them, which is
     right — an empty rung is a buy-in, not a lobby. The free room is the
     exception: it is the "just let me play" row, and burying it behind the
     buy-in stepper made starting a game a three-tap job from the screen whose
     whole purpose is starting a game. */
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/board.js'), 'utf8');
  assert.ok(/function rowsToShow/.test(src), 'the board pins a row');
  assert.ok(/Number\(l\.stake\) === 0 && l\.game === 'snake'/.test(src),
    'and it is the free slither.io room');
  assert.ok(/!rows\.some\(r => r\.id === free\.id\)/.test(src),
    'never listed twice when it does have players');
  // The count itself must stay real: an empty room says 0.
  assert.ok(!/players: *1|fake|placeholder/i.test(src), 'no invented player count');
  assert.ok(/const occupied = \(\) => LOBBIES\.filter\(l => \(l\.players \|\| 0\) > 0\)/.test(src),
    'every other row still has to have someone in it');
});

test('a swipe never scrolls the page, and the incoming screen does not drop and snap', () => {
  /* Two faults, one line. The drag used to scroll the page to the top before
     measuring, but scroll-behavior:smooth is set on <html>, so scrollTo
     ANIMATES: the rect read immediately after was still the old scrolled one,
     the incoming screen got pinned that far down, and the page then slid up
     underneath it. That is the drop-and-snap. The same line also threw away
     your reading position every time a half-swipe snapped back. */
  const sw = fs.readFileSync(path.join(ROOT, 'public/js/v2/swipe.js'), 'utf8');
  const html = v2();

  const bd = sw.slice(sw.indexOf('function beginDrag'), sw.indexOf('function move'));
  // The call, not the word: the comment above it explains the bug it caused.
  assert.ok(!/scrollTo\(/.test(bd), 'starting a drag does not scroll the page');
  // Pinned at the resting position, so there is nothing left to correct.
  assert.ok(/const restTop = r\.top \+ window\.scrollY/.test(bd),
    'the incoming screen is pinned where it will come to rest');
  assert.ok(/top: restTop/.test(bd), 'and that is what it is positioned at');

  /* The scroll reset happens at the START of the settle, not at the end.
     The incoming screen is fixed while it moves, so the scroll does not touch
     it; the instant it becomes a normal part of the page it is placed against
     the document instead, and resetting the scroll at that same moment makes
     the page travel to catch up — the vertical pop. Doing it up front means
     the page is already at the top before the swap, so nothing moves. */
  const fin = sw.slice(sw.indexOf('function finish'), sw.indexOf('function onEnd(e)'));
  assert.ok(fin.indexOf('jumpToTop()') < fin.indexOf("classList.add('scr-settle')"),
    'the scroll is reset before the settle begins, not after it ends');
  assert.ok(/if \(commit && window\.jumpToTop\)/.test(fin), 'and only when it commits');
  const commit = html.slice(html.indexOf('function commitScreen'),
                            html.indexOf('/* scroll-behavior:smooth'));
  assert.ok(!/jumpToTop\(\)/.test(commit),
    'the swap itself does not scroll, or it would jump again');

  /* The outgoing screen is held where the eye last saw it while it slides out,
     and that has to be instant. Style is recalculated once per task, so a
     transform set in the same task as the transition animates between them —
     the outgoing screen would slide the whole scroll distance vertically. */
  assert.ok(/style\.transition = 'none'/.test(fin), 'compensation suppresses the transition');
  assert.ok(/void d\.cur\.offsetHeight/.test(fin), 'and flushes it as the base value');

  // scroll-behavior:smooth is on <html>; behavior:'instant' is not honoured
  // everywhere, but an inline style always beats the stylesheet.
  assert.ok(/scrollBehavior='auto'/.test(html.replace(/\s/g, '')),
    'the reset forces instant scrolling');

  // overflow:hidden mid-gesture fights the page's own scroll position.
  assert.ok(/body\.scr-dragging \{ overflow-x:hidden \}/.test(html),
    'only horizontal overflow is clipped during a drag');
});

test('the settle is timed by distance left, so it never crawls into place', () => {
  /* A fixed 240ms settle meant a screen with 30px to go took as long as one
     with 350px, and the old curve put 82% of the travel in the first 45% of
     the time. The result was a screen that arrived almost immediately and
     then crept the last 60px for over 100ms — read as "it takes half a second
     to line up". Measured after: fully settled and swapped in ~90-105ms with a
     20-33ms tail, against 239ms and a 133ms crawl before. */
  const sw = fs.readFileSync(path.join(ROOT, 'public/js/v2/swipe.js'), 'utf8');
  const fin = sw.slice(sw.indexOf('function finish'), sw.indexOf('function onEnd(e)'));

  assert.ok(/const remaining = Math\.abs\(to - d\.dx\)/.test(fin),
    'the distance still to cover is measured');
  assert.ok(/remaining \/ speed/.test(fin), 'and the duration comes from it');
  assert.ok(/Math\.abs\(d\.v\)/.test(fin), 'a flick keeps its own speed');
  assert.ok(/transitionDuration = dur/.test(fin), 'the duration is applied per release');
  assert.ok(!/SETTLE_MS/.test(sw), 'no fixed settle duration remains');

  /* The swap must happen when the movement stops, not on a timer that runs
     past it — and under reduced motion, where the stylesheet forces the
     transition to nothing, a timer alone would wait out an animation that
     never ran. */
  assert.ok(/addEventListener\('transitionend'/.test(fin), 'it waits for the transition');
  assert.ok(/propertyName === 'transform'/.test(fin), 'and only for the one that moves it');
  assert.ok(/safety net only/.test(fin), 'the timer is only a fallback');
  // Both paths must be idempotent or the cleanup runs twice.
  assert.ok(/if \(finished\) return/.test(fin), 'and they cannot both fire the cleanup');
});
