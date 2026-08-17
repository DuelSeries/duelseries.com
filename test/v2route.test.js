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
  // The section still exists and says what it is.
  assert.ok(html.includes('Not running yet'), 'it says the events are not running');
  assert.ok(/Planned/.test(html), 'and marks them planned');
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
  for (const sel of ['.chartbox', '.apscreen', 'input', '#game-frame'])
    assert.ok(src.includes(sel), `${sel} is exempt`);
  assert.ok(/railwrap/.test(src), 'the games rail gets the swipe instead of the tabs');
  // A mostly-vertical drag is a scroll, not a swipe.
  assert.ok(/Math\.abs\(dx\) < Math\.abs\(dy\) \* RATIO/.test(src), 'direction is checked');
  assert.ok(/touchstart/.test(src) && !/pointerdown/.test(src),
    'touch only, since a mouse drag is a text selection');
});
