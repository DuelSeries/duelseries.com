'use strict';
// Guards the parallel-route migration: the redesigned lobby has to be reachable
// on the real server without disturbing the live one. These are structural
// checks, not behaviour — the page itself is exercised in the browser.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

test('the old lobby is gone, and nothing still reaches for it', () => {
  /* Deleted 2026-08-19 after the redesign had held on mainnet through real
     entry and cash-out. It was kept as an escape hatch for one release; past
     that it is 2,800 lines of a second lobby that nobody loads and that every
     change has to be read around. The way back is git. */
  const s = server();
  // The route specifically: "legacyHeaders" in the rate limiters is unrelated.
  assert.ok(!/app\.get\('\/legacy'/.test(s), 'the /legacy route is gone');
  assert.ok(!fs.existsSync(path.join(ROOT, 'public/index.html')), 'index.html is gone');
  assert.ok(!fs.existsSync(path.join(ROOT, 'public/js/lobby.js')), 'lobby.js is gone');
  // A dangling reference would 404 at runtime rather than fail a build.
  for (const p of ['public/v2.html', 'public/game.html', 'public/ag.html']) {
    const h = fs.readFileSync(path.join(ROOT, p), 'utf8');
    assert.ok(!/["'\/]js\/lobby\.js/.test(h), `${p} does not load lobby.js`);
  }
});

test('/v2 keeps working, so existing links do not break', () => {
  assert.ok(/app\.get\('\/v2', .*v2\.html/.test(server()), '/v2 still serves it');
});

test('social data comes from the server, not from a generated roster', () => {
  // The board is leaders.js since 2026-10-16 (the gold strip's own read, /api/earnings/board).
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/social.js'), 'utf8') +
              fs.readFileSync(path.join(ROOT, 'public/js/v2/leaders.js'), 'utf8');
  for (const ep of ['/api/earnings/board', '/api/players/search', '/api/profile/',
                    '/api/earnings/total']) {
    assert.ok(src.includes(ep), `social.js or leaders.js calls ${ep}`);
  }
  const html = v2();
  for (const gone of ['mkPlayer', 'function seeded(', 'const PLAYERS=', 'const PNAMES=']) {
    assert.ok(!html.includes(gone), `the generated roster is gone: ${gone}`);
  }
});

test('the profile shows only figures the server actually records', () => {
  // getProfile returns name, totalEarnings, gamesPlayed, playTimeSeconds, the
  // cash-outs, and (since 2026-10-15) winRate, counted on the server from
  // stakes_history and landed cash-outs (server/playerStats.js). No house cut:
  // showing that would mean inventing it, which is what the prototype did.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/social.js'), 'utf8');
  assert.ok(/winRateTile\(p\.winRate\)/.test(src), 'the win rate is the server\'s, never worked out here');
  assert.ok(/cash out with more than you paid to enter/.test(src), 'and says how it is counted');
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

test('equipping a skin actually changes the snake', () => {
  /* The snake is /sl now (BACKLOG 3.1): the skin number goes under
     duel.sl.skin, which /sl sends in its handshake. Before 3.1 the lobby only
     wrote the old engine's keys, so the /sl snake was always a random plain
     colour whatever you picked. The old keys are still written for a plain
     skin, because a Free click with no /sl room falls back to /game.html, and
     there the COLOUR is what reaches the game (the 2026-08-19 lesson: the id
     alone never leaves the lobby). */
  const html = v2();
  const store = html.slice(html.indexOf('function storeSkin()'), html.indexOf('function storeSkin()') + 600);
  assert.ok(html.includes("const SL_SKIN_KEY='duel.sl.skin'"), 'the lobby stores the /sl skin number');
  assert.ok(/setItem\(SL_SKIN_KEY,s\.id\)/.test(store), 'storeSkin writes it');
  assert.ok(/duelseries_skin_id/.test(store) && /duelseries_skin_color/.test(store),
    'and, for a plain skin, both old keys for the /game.html fallback');
  const save = html.slice(html.indexOf('function closeLook'), html.indexOf('function closeLook') + 400);
  assert.ok(/SAVED\[cur\.id\]\.put\(/.test(save), 'and Save goes through the game\'s store');
  assert.ok(/snake:\{worn:\(\)=>paidWorn\('snake'\)\|\|skin\(\),\s*put:s=>\{if\(!s\)return;wearPaid\('snake',s\);if\(s\.shop\)return;skinId=s\.id;storeSkin\(\)\}\}/.test(html),
    'which for slither.io is storeSkin (a paid skin is worn through DSSkins, the free one kept underneath)');

  // The /sl end of the contract: the page reads that key and sends it at every connect.
  const main = fs.readFileSync(path.join(ROOT, 'public/js/slx/slxMain.js'), 'utf8');
  assert.ok(main.includes("var SKIN_KEY = 'duel.sl.skin';"), '/sl reads the same key');
  assert.ok(/slx\.auth = function[\s\S]{0,120}cv: cv/.test(main), 'and puts it in the handshake as cv');

  // The far end of the contract: whoever consumes it must read that key.
  const widget = fs.readFileSync(path.join(ROOT, 'wallet-widget/src/main.jsx'), 'utf8');
  assert.ok(widget.includes('duelseries_skin_color'), 'the widget reads the colour');
  assert.ok(fs.readFileSync(path.join(ROOT, 'public/js/game.js'), 'utf8').includes('snakeColor'),
    'and the game reads what the widget set');
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

test('stats claim no figure the server cannot back', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/stats.js'), 'utf8');
  assert.ok(src.includes('/api/my-profile'), 'reads the real profile');
  /* This used to gate a Net profit tile on whether buy-ins were recorded.
     The tile row is gone entirely — the chart leads the screen now — so the
     invariant it protected holds in the stronger form: the screen shows
     payouts, which are recorded, and claims nothing derived from figures that
     are not. Profit is back on the table the day it can be computed for every
     game, not before. */
  for (const bad of ['Net profit', 'Win rate', 'House cut paid', 'Biggest cash-out'])
    assert.ok(!src.includes(bad), `stats.js does not claim ${bad}`);
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

test('a profile draws the Wallet tab\'s exact earnings graph, from the same rows', () => {
  // Owen, 2026-10-15: the profile charted monthly sums from p.history, so the
  // same player's line differed between their profile and their Wallet tab.
  // Both now call ONE function with every cash-out and the account's open date.
  const social = fs.readFileSync(path.join(ROOT, 'public/js/v2/social.js'), 'utf8');
  const stats = fs.readFileSync(path.join(ROOT, 'public/js/v2/stats.js'), 'utf8');
  assert.ok(/V2EarningsChart\(box, games, p\.joinedAt, money\)/.test(social), 'the profile uses the shared chart');
  assert.ok(/V2EarningsChart\(el\('s-chart'\), games, p\.joinedAt, money\)/.test(stats), 'and so does the wallet');
  assert.ok(!/p\.history/.test(social), 'no monthly buckets left in the lobby profile');
  const db = fs.readFileSync(path.join(ROOT, 'server/db.js'), 'utf8');
  const prof = db.slice(db.indexOf('async function getProfile('), db.indexOf('// ─── Cosmetics'));
  assert.ok(/games: games\.rows\.map/.test(prof) && /joinedAt: row\.created_at/.test(prof),
    'getProfile returns the cash-out rows and the open date');
  assert.ok(/history: \{/.test(prof), 'and keeps the series the old snake client reads');
  assert.ok(/class="panel chartbox" id="p-chart"/.test(v2()), 'in the same box as the wallet\'s');
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
  // The widget used to default a missing lobbyType to the ten cent tier, so dispatching
  // without naming a room charged for one nobody chose. It refuses one now too (below).
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
  const loopAt = html.indexOf('function lobbyLoop(t){');
  assert.ok(loopAt > 0, 'the frame loop is where this test expects it');
  assert.ok(html.indexOf('let _paused=false;') < loopAt, '_paused is declared above the loop');
  assert.ok(html.indexOf('let _rafOn=true;') < loopAt, 'and so is _rafOn, which it also reads');
});

/* The frame loop and the two hooks, run for real in a sandbox: the slice of the
   page from `let _last=0;` to the end of _resumeLobbyAnims, with a hand-cranked
   requestAnimationFrame. FIX-PLAN S6: while a game is up the loop must stop
   asking for frames (it used to re-arm 240 times a second and return), and a
   resume must restart exactly one loop however the calls interleave. */
function lobbyLoopSandbox() {
  const html = v2();
  const from = html.indexOf('let _last=0;');
  const resumeAt = html.indexOf('window._resumeLobbyAnims=');
  const to = html.indexOf('\n};', resumeAt) + 3;
  assert.ok(from > 0 && resumeAt > from && to > resumeAt, 'the loop slice is where this test expects it');
  const queue = [], dts = [];
  const ctx = {
    clock: 0, lookT: 0, queue, dts,
    requestAnimationFrame: (f) => { queue.push(f); return queue.length; },
    performance: { now: () => ctx.clock },
    RM: { addEventListener() {} },
    repaintAll() {},
    paintScene(cv, dt) { dts.push(dt); },
    paintLook() {},
    document: {
      body: { classList: { add() {}, remove() {}, contains() { return false; } } },
      querySelectorAll: (sel) => (sel === 'canvas[data-anim]' ? [{ offsetParent: {} }] : []),
    },
    Math,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(html.slice(from, to), ctx);
  // Run every frame that is queued now, stamped t.
  const frame = (t) => { const due = queue.splice(0); due.forEach((f) => f(t)); return due.length; };
  return { ctx, queue, dts, frame };
}

test('the lobby frame loop stops asking for frames while a game is up', () => {
  const { ctx, queue, frame } = lobbyLoopSandbox();
  assert.equal(queue.length, 1, 'the loop starts itself and queues one frame');
  frame(16.7); frame(33.4);
  assert.equal(queue.length, 1, 'and keeps exactly one queued while the lobby is showing');
  ctx.window._pauseLobbyAnims();
  assert.equal(frame(50), 1, 'the frame already queued still runs once');
  assert.equal(queue.length, 0, 'but it queues no other: zero callbacks while the game is up');
  ctx.window._pauseLobbyAnims();          // play.js can pause a second time
  assert.equal(queue.length, 0, 'a second pause changes nothing');
  ctx.clock = 5000;
  ctx.window._resumeLobbyAnims();
  assert.equal(queue.length, 1, 'closing the game restarts the loop');
  ctx.window._resumeLobbyAnims();
  assert.equal(queue.length, 1, 'a second resume does not start a second loop');
  frame(5016.7); frame(5033.4);
  assert.equal(queue.length, 1, 'and the lobby animates again, one loop');
});

test('a resume before the paused frame has run starts no second loop', () => {
  const { ctx, queue, frame } = lobbyLoopSandbox();
  ctx.window._pauseLobbyAnims();
  ctx.window._resumeLobbyAnims();         // the queued frame has not seen the pause yet
  assert.equal(queue.length, 1, 'still the one frame that was queued');
  frame(16.7);
  assert.equal(queue.length, 1, 'which carries on as the only loop');
});

test('the first frame after a resume never steps the scenes backwards', () => {
  const { ctx, dts, frame } = lobbyLoopSandbox();
  ctx.window._pauseLobbyAnims();
  frame(100);                              // the loop stops here
  ctx.clock = 2000;
  ctx.window._resumeLobbyAnims();
  dts.length = 0;
  frame(1999.5);                           // stamped a hair before the resume
  assert.deepEqual(dts, [1], 'counted as one ordinary frame, not a negative one');
  frame(2016.2);
  assert.ok(Math.abs(dts[1] - 1) < 0.01, 'and the next frame is one frame long');
});

test('agar.io frame keeps the game inside the phone safe area', () => {
  /* FIX-PLAN P2 (PH3): the safe-area insets are a black border on the frame,
     so the game's own 16 px button gaps are measured from the notch and the
     home bar rather than from the glass, and a tap in the strip lands on the
     frame. With zero insets (a desktop) the frame is the whole window. */
  const html = v2();
  const tag = html.slice(html.indexOf('<iframe id="agar-frame"'));
  const style = tag.slice(tag.indexOf('style="') + 7, tag.indexOf('"', tag.indexOf('style="') + 7));
  for (const want of ['position:fixed', 'inset:0', 'width:100%', 'height:100%', 'box-sizing:border-box',
    'border-style:solid', 'border-color:#000',
    'border-width:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)']) {
    assert.ok(style.includes(want), 'agar-frame style has ' + want);
  }
  assert.ok(!/border:0/.test(style), 'and no border:0 left to cancel it');
  assert.ok(/<meta name="viewport"[^>]*viewport-fit=cover/.test(html),
    'the page opts into the full screen, without which every inset reads 0');
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
  for (const claim of ['winner takes all', 'top three split', 'chip live'])
    assert.ok(!html.includes(claim), `no fabricated tournament claim: ${claim}`);
  // 'Ends in' only as the battle royale's real clock, the server's endsMs (Owen 2026-10-16)
  assert.strictEqual(html.split('Ends in').length - 1, 1, 'one Ends in');
  assert.ok(/ends>0 \? 'Ends in'/.test(html) && /BR\.endsMs/.test(html), 'and it is the match clock the server sends');
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

test('the legal links are off the phone entirely', () => {
  /* THE ASSERTION IS INVERTED, on purpose.

     This used to pin the footer as position:fixed above the nav bar on every
     screen. Fixed means it takes no space in the flow, so content scrolled
     UNDERNEATH it — and the last row of the open-lobbies list sat behind it
     permanently. A bar that hides the thing you came to the screen to read, to
     show three links nobody taps mid-session.

     Measured after removing it: scrolled to the bottom of All games, the last
     card sits 74px clear of the nav bar instead of behind a legal strip.

     Desktop keeps the footer, where there is a page to put it at the bottom of. */
  const html = v2();
  assert.ok(!/footer\{position:fixed/.test(html),
    'the footer is not pinned over the content on a phone');

  const mob = html.slice(html.indexOf('@media(max-width:760px)'));
  assert.ok(/footer\{display:none\}/.test(mob),
    'it is gone on mobile rather than merely moved');

  // Still there for desktop, which has the room.
  assert.ok(/Privacy policy/.test(html) && /Terms of service/.test(html),
    'the links still exist for the desktop layout');
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
  // people plus bots (Owen 2026-10-17: "bots count as people playing")
  assert.ok(/const playing = l => \(l\.players \|\| 0\) \+ \(l\.bots \|\| 0\)/.test(src) && /playing\(l\) > 0/.test(src), 'filters to occupied rooms');
  assert.ok(/Nobody playing yet/.test(src), 'and says so when there are none');
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

/* The lobby's own refreshSteps and defaultStep, cut out of v2.html and run against a stub board.
   BACKLOG 2.1 review: the wallet signs a stake without a prompt, so a remembered rung the ladder
   no longer has (the retired $0.10) must land on Free, never on the next paid rung ($0.50). */
function stepsHarness({ last, ladder = true, open = [0, 0.5, 1] } = {}) {
  const html = v2();
  const a = html.indexOf('let STEPS=[0];');
  const b = html.indexOf('const G=id=>GAMES.find(x=>x.id===id);');
  assert.ok(a > -1 && b > a, 'the ladder code is where this test cuts it');
  const m = new Map(last === undefined ? [] : [['duelseries_last_stake', String(last)]]);
  const win = {
    GAMES: [{ id: 'snake', ladder: 1 }, { id: 'knockout', duel: 1, built: 1, paid: 1 },
            { id: 'tanks', duel: 1, built: 1, freeOnly: 1 }],
    localStorage: { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
                    removeItem: k => m.delete(k) },
    V2Board: { playableStakes: () => new Set(open) },
  };
  if (ladder) win.DS_LADDER = require(path.join(ROOT, 'shared/stakeLadder.js'));
  win.window = win;
  vm.createContext(win);
  vm.runInContext(html.slice(a, b) + 'const G=id=>GAMES.find(x=>x.id===id);\n' +
    'this.t={pick(id){refreshSteps(id);si=defaultStep();return {stake:STEPS[si],off:[...STEPS_OFF]};}};', win);
  return { pick: id => JSON.parse(JSON.stringify(win.t.pick(id))), stored: () => m.get('duelseries_last_stake') };
}

test('a remembered rung the ladder no longer has lands on Free, never on $0.50', () => {
  const dime = stepsHarness({ last: 0.1 });
  assert.equal(dime.pick('snake').stake, 0, 'the retired $0.10 lands on Free');
  assert.equal(dime.stored(), undefined, 'and is forgotten');
  // A live rung is still remembered, Free included.
  assert.equal(stepsHarness({ last: 1 }).pick('snake').stake, 1);
  assert.equal(stepsHarness({ last: 0 }).pick('snake').stake, 0);
  // A first visit opens on Free (Owen, 2026-10-10): a paid rung is always picked on purpose.
  assert.equal(stepsHarness({}).pick('snake').stake, 0);
  // So does a remembered rung that is closed right now: never a paid rung the player did not pick.
  assert.equal(stepsHarness({ last: 1, open: [0, 0.5] }).pick('snake').stake, 0);
  // If the ladder file did not load, the lobby offers Free and forgets nothing.
  const noFile = stepsHarness({ last: 1, ladder: false });
  assert.equal(noFile.pick('snake').stake, 0);
  assert.equal(noFile.stored(), '1', 'a $1.00 player keeps their rung through a failed load');
});

test('Knockout and Battleship strike their paid rungs through until the lobby can start a paid duel', () => {
  /* startFromDetail opens every built duel at Free. Drawing $0.50 live over that Play button
     promised a paid table and seated a free bot one. */
  assert.match(v2(), /if\(cur\.built&&\(cur\.duel\|\|cur\.solo\)\)\{V2Play\.launch\(cur\.id,\{lobbyType:'free'\}\);return\}/,
    'if this changes, open the paid rungs in refreshSteps with it');
  const ko = stepsHarness({ last: 0.5 }).pick('knockout');
  assert.deepEqual(ko, { stake: 0, off: [0.5, 1] }, 'Free selected, $0.50 and $1.00 struck through');
  assert.deepEqual(stepsHarness({}).pick('tanks'), { stake: 0, off: [0.5, 1] }, 'the same as Bowmasters');
  // Owen 2026-10-15: no small print. The struck rungs say it; the note under Play is gone.
  assert.ok(!/Paid tables are not open yet/.test(v2()), 'no note under Play');
  assert.ok(!/not open yet\.'/.test(v2()) && !/title="Not open yet"/.test(v2()), 'and no line or tooltip under the rungs');
});

test('each game keeps the rung picked on it, and a swipe never carries a paid rung to another game', () => {
  /* The swipe on the game screen flips between games (swipe.js -> V2Detail.flip -> open_). A rung pressed
     on one game is remembered for THAT game only, while it is open; another game opens on its own default. */
  const html = v2();
  assert.match(html, /refreshSteps\(id\); si=stepFor\(id\);/, 'open_ asks for the game\'s own rung');
  assert.match(html, /if\(cur\)PICKED\[cur\.id\]=STEPS\[si\];/, 'pickStake records the pick per game');
  const a = html.indexOf('let STEPS=[0];');
  const b = html.indexOf('const G=id=>GAMES.find(x=>x.id===id);');
  const win = {
    GAMES: [{ id: 'snake', ladder: 1 }, { id: 'paper', ladder: 1 }, { id: 'knockout', duel: 1, built: 1, paid: 1 }],
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    V2Board: { playableStakes: () => new Set([0, 0.5, 1]) },
    DS_LADDER: require(path.join(ROOT, 'shared/stakeLadder.js')),
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(html.slice(a, b) + 'const G=id=>GAMES.find(x=>x.id===id);\n' +
    'this.t={open(id){refreshSteps(id);si=stepFor(id);return STEPS[si];},' +
    'pick(id,v){refreshSteps(id);PICKED[id]=v;}};', win);
  win.t.pick('snake', 0.5);
  assert.equal(win.t.open('paper'), 0, 'the next game opens on Free, not on the $0.50 picked elsewhere');
  assert.equal(win.t.open('knockout'), 0, 'a game with its paid rungs shut opens on Free');
  assert.equal(win.t.open('snake'), 0.5, 'and coming back finds the $0.50 picked on this game');
  win.t.pick('knockout', 1);                // a rung that is struck through here
  assert.equal(win.t.open('knockout'), 0, 'a pick on a shut rung never opens it');
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

test('agar.io client scripts revalidate; everything else stays no-store', () => {
  /* Owen's pick (2026-10-08): /js/ag is no-cache, so a repeat visit gets a 304
     on the ETag express.static already sends, and never runs a stale build.
     The rest of the site keeps no-store (see public/sw.js for why). */
  const src = server();
  assert.match(src, /const revalidate = \(p\) => p\.startsWith\('\/js\/ag\/'\);/, 'only /js/ag/ revalidates');
  assert.match(src, /res\.setHeader\('Cache-Control', revalidate\(req\.path\) \? 'no-cache' : 'no-store'\)/,
    'no-cache there, no-store for everything else');
  assert.ok(src.indexOf("revalidate(req.path) ? 'no-cache'") < src.indexOf("app.use(express.static(path.join(__dirname, '../public')))"),
    'set before express.static, which keeps a Cache-Control that is already there');
});

test('the service worker hands socket.io straight back to the browser', async () => {
  /* FIX-PLAN S7: every game's long-polling went through this worker for
     nothing. Run the real fetch listener against fake requests. */
  const src = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  const listeners = {};
  const fetched = [];
  const ctx = {
    self: { addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } },
    caches: { keys: async () => [], delete: async () => true },
    fetch: (req) => { fetched.push(req.url); return Promise.resolve('net'); },
    URL,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const run = (url) => {
    let answered = false;
    listeners.fetch({ request: { url }, respondWith() { answered = true; } });
    return answered;
  };
  assert.equal(run('https://duelseries.com/socket.io/?EIO=4&transport=polling&t=abc'), false, 'socket.io polling is left alone');
  assert.equal(run('https://duelseries.com/ag-io/?EIO=4&transport=polling'), false, 'and so is agar.io\'s own path');
  assert.equal(run('https://duelseries.com/socket.io/socket.io.js'), false, 'the client script too: same path, nothing to gain');
  assert.equal(run('https://duelseries.com/js/ag/agMain.js'), true, 'everything else still goes through the handler');
  assert.equal(run('https://duelseries.com/'), true, 'including the page, which Chrome needs for an installed app');
  assert.match(src, /const SW_VERSION = \d+;/, 'carries a version, so an edit reaches phones holding the old worker');
});

test('the game screen: buy-in then Play, no name field and no lobby list', () => {
  /* Collapsed naively, the two-column hero used to stack the whole left column
     first, which put an empty lobby list between the artwork and the Play
     button and pushed the only action on the screen below the fold. It was
     held together by a chain of CSS order values.

     The screen is one column in source order now, so the rule is checked where
     it actually lives: the markup. That holds at every width, and it cannot be
     broken by a stylesheet edit the way the order chain could. */
  const html = v2();
  const screen = html.slice(html.indexOf('<main id="detail"'),
                            html.indexOf('</main>', html.indexOf('<main id="detail"')));
  const at = s => { const i = screen.indexOf(s); assert.notEqual(i, -1, 'missing: ' + s); return i; };
  const buyIn = at('id="stakes"');
  /* The button routes through startFromDetail now: one control that either
     drops you into an arena or queues you for a duel, decided by the game. */
  const play  = at('startFromDetail()');
  /* Owen 2026-10-16: the buy-in sits right on the Play it decides, the name
     is set once in the header's profile card, and the open-lobbies list under
     Customize is gone. */
  assert.ok(buyIn < play, 'the buy-in right before the button it sets');
  assert.ok(!screen.includes('id="play-name"') && !screen.includes('class="namerow"'), 'no name field on the game screen');
  assert.ok(!screen.includes('id="dlob"') && !screen.includes('lobwrap'), 'no open-lobbies list on the game screen');
});

test('the name is changed in one place: the profile card behind your initial in the header', () => {
  /* Owen's pick B (2026-10-16). The #play-name / #name-act pair the game
     screens carried moved, ids and all, into the header card, so play.js saves
     it exactly as before and every game reads the same saved name. */
  const html = v2();
  const hdr = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.ok(/<button type="button" class="me" id="mebtn" onclick="V2Me\.toggle\(\)"/.test(hdr), 'the disc is a button in the header');
  const card = hdr.slice(hdr.indexOf('id="mepop"'));
  for (const id of ['id="play-name"', 'id="name-act"', 'id="mename"', 'id="meaddr"', 'id="me-out"'])
    assert.ok(card.includes(id), 'the card has ' + id);
  assert.ok(card.includes('onclick="signOut(this)"'), 'Sign out is the Settings one');
  assert.strictEqual((html.match(/id="play-name"/g) || []).length, 1, 'one name field on the page (Settings keeps its own #set-name)');
  assert.ok(html.includes('<script src="/js/v2/play.js"></script>\r\n<script src="/js/v2/me.js"></script>') ||
            html.includes('<script src="/js/v2/play.js"></script>\n<script src="/js/v2/me.js"></script>'), 'me.js loads after play.js');
  assert.ok(html.includes('body.signedout .me{display:none}'), 'no disc signed out: the header says Sign in');
  assert.match(html, /if\(!SCREEN_FOR\[id\]\)id='play';\s*if\(window\.V2Me\)V2Me\.close\(\);/, 'changing tab closes the card');
  const play = fs.readFileSync(path.join(ROOT, 'public/js/v2/play.js'), 'utf8');
  assert.match(play, /function requireName\(\) \{[\s\S]{0,700}if \(window\.V2Me\) window\.V2Me\.open\(\);/, 'Play without a name opens the card');
  assert.match(play, /if \(window\.V2Me\) window\.V2Me\.paint\(\);/, 'a saved name repaints the initial');
});

test('the brand mark is wired everywhere a browser asks for one', () => {
  // Tab, bookmark bar, iOS bookmark, installed app: four different requests,
  // and a missing one silently falls back to a blank page glyph.
  for (const page of ['public/v2.html', 'public/game.html', 'public/ag.html']) {
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
  assert.ok(/narrowSide <= 500/.test(src), 'gated on a physically narrow screen');
  // Nor on a phone held sideways (2026-10-15): the layout is compared with the screen as it is held.
  assert.ok(/window\.innerWidth > window\.innerHeight \? Math\.max\(screen\.width, screen\.height\)/.test(src),
    'a landscape phone is measured across its long side');
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
  for (const m of ['V2Wallet.render()', 'V2Social.load()'])
    assert.ok(fill.includes(m), `fillScreen loads the screen's data (${m})`);
  /* Stats is no longer a tab of its own — the chart and the payout list sit
     inside the wallet screen. The rule still holds, one level down: staging
     the wallet has to stage those too, or the earnings section drags in
     empty. */
  const wal = fs.readFileSync(path.join(ROOT, 'public/js/v2/wallet.js'), 'utf8');
  assert.ok(/V2Stats\.load\(\)/.test(wal),
    'the wallet loads the earnings section it now contains');
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
  // A Windows checkout (core.autocrlf) has CRLF; the scan is about the CSS, not the line endings.
  const css = fs.readFileSync(path.join(ROOT, 'public/css/game.css'), 'utf8').replace(/\r\n/g, '\n');
  const i = css.indexOf('Chat on a phone');
  assert.ok(i > 0, 'there is a phone-specific chat block');
  const block = css.slice(i, css.indexOf('\n}\n', css.indexOf('#chat-hint', i)) + 3);
  assert.ok(/#chat-input[^}]*display: none/.test(block) ||
            /#chat-input, #chat-input\.open, #chat-hint \{ display: none/.test(block),
    'the input is hidden');
  assert.ok(/pointer-events: none/.test(block),
    'and the feed never swallows a steering touch');
});

test('the spectate bar fits a phone, and both games get the same one', () => {
  /* Five controls around a 160px label is about 420px wide, centred with
     translateX(-50%). On a 375px screen that overhangs both sides, which is
     what you land on straight after tapping Keep watching.

     The bar used to be phone-specific and per-game: two different designs, and
     the fix applied to only one of them. It lives in the shared sheet now and
     applies at every width, so this checks the shape AND that neither game has
     quietly grown its own again. */
  const css = fs.readFileSync(path.join(ROOT, 'public/css/cashout.css'), 'utf8');
  const i = css.indexOf('#spectate-bar {');
  assert.ok(i > 0, 'the shared sheet owns the bar');
  const block = css.slice(i, i + 2600);
  assert.ok(/left: 12px/.test(block) && /right: 12px/.test(block), 'it is pinned to both edges');
  assert.ok(!/translateX(-50%)/.test(block), 'it is not centre-offset off the screen');
  // flex-wrap alone let all five squeeze onto one row; the break is explicit.
  assert.ok(/#spectate-bar::after/.test(block), 'the row break is forced');
  assert.ok(/min-height: 44px/.test(block), 'the exits are a real touch target');
  // (0,1,1) beat (0,1,0) and the primary rendered as a ghost.
  assert.ok(/#spectate-bar #spectate-play-again {/.test(block),
    'the primary out-specifies the bar-wide button rule');
  for (const f of ['public/css/game.css', 'public/css/ag.css']) {
    assert.ok(!fs.readFileSync(path.join(ROOT, f), 'utf8').includes('#spectate-bar'),
      f + ' does not carry a second copy of the bar');
  }
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

test('every tab owns its own screen node, so a swipe between neighbours has two sides', () => {
  /* Locker and Settings were once both the single #stub element. A swipe
     between them had the same node on each side, beginDrag bailed out, and the
     gesture did nothing. Locker has since been removed and Settings given a
     real screen, so this checks the general rule rather than that one pair:
     no two tabs may share a node, whichever tabs exist. */
  const html = v2();
  const m = html.match(/const SCREEN_FOR=\{([\s\S]*?)\};/);
  assert.ok(m, 'the tab-to-screen map is there');
  const ids = [...m[1].matchAll(/\w+:'([\w-]+)'/g)].map(x => x[1]);
  assert.ok(ids.length >= 5, 'every tab is mapped, got ' + ids.length);
  assert.equal(new Set(ids).size, ids.length,
    'two tabs sharing one node makes the swipe between them a no-op: ' + ids.join(','));
  // Each has to be in the hide-all list, or one can be left showing under another.
  const s = html.slice(html.indexOf('const SCREENS='), html.indexOf('function showScreen'));
  for (const id of ids) assert.ok(s.includes("'" + id + "'"), id + ' is a routable screen');
  const sw = fs.readFileSync(path.join(ROOT, 'public/js/v2/swipe.js'), 'utf8');
  /* Clips and Updates are PC only (Owen 2026-10-16): a phone never shows them,
     so the swipe, which is the phone's, leaves them out on purpose. */
  const PC_ONLY = ['clips-screen', 'updates-screen', 'join-screen'];
  for (const id of ids) {
    if (PC_ONLY.includes(id)) assert.ok(!sw.includes("'" + id + "'"), id + ' is not in the phone swipe');
    else assert.ok(sw.includes("'" + id + "'"), 'the swipe knows ' + id);
  }
  assert.ok(!/id="stub2?"/.test(html), 'and the shared placeholder is gone for good');
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
  // (and be open: a closed paid agar.io room keeps its seated players but takes nobody new, PAID-AGAR-DESIGN.md 7)
  assert.ok(/const occupied = \(\) => LOBBIES\.filter\(l => playing\(l\) > 0 && isOpen\(l\)\)/.test(src),
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
  // Pinned at the resting position in the desktop flow layout, so there is
  // nothing left to correct. On a phone this path is not taken at all.
  assert.ok(/restTop = paned \? 0 : r\.top \+ window\.scrollY/.test(bd),
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
  assert.ok(/if \(commit && !d\.paned && window\.jumpToTop\)/.test(fin),
    'and only when it commits, and only in the flow layout');
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

test('on a phone each screen scrolls itself, so a swipe has nothing to correct', () => {
  /* The pop at the end of a swipe was fixed four times and kept coming back,
     because every fix treated a symptom of one structural fact: all the
     screens shared the document's single scroll. That forces the screen being
     dragged in to be lifted out of the page so it can move on its own, and the
     moment it is put back it is measured against a document scrolled somewhere
     else — so something always has to be corrected, and the correction is
     visible.

     Below 760px the document does not scroll at all now. Each screen is a
     fixed pane with its own scrollbar, so sliding one sideways cannot move the
     other, there is no document scroll to reset, and nothing is put back. */
  const html = v2();
  const i = html.indexOf('One scroll per screen');
  assert.ok(i > 0, 'the pane layout is documented where it is defined');
  const block = html.slice(i, i + 2200);
  assert.ok(/html,body\{height:100%;overflow:hidden/.test(block),
    'the document itself cannot scroll on a phone');
  assert.ok(/main\.wrap\{/.test(block), 'the screens are the scrolling elements');
  assert.ok(/position:fixed/.test(block) && /overflow-y:auto/.test(block),
    'each is a fixed pane that scrolls itself');
  // It has to sit between the two fixed bars or content hides behind them.
  assert.ok(/top:calc\(56px \+ env\(safe-area-inset-top\)\)/.test(block), 'below the header');
  /* Exactly the nav bar's height, from the same variable. It was 104px (bar
     plus a legal row that is gone on phones), which left a 44px invisible edge
     above the bar that sliced the last card in half on Owen's Android phone. */
  assert.ok(/bottom:calc\(var\(--navh\) \+ env\(safe-area-inset-bottom\)\)/.test(block),
    'ends exactly at the top of the nav bar');
  assert.ok(/:root\{--navh:60px\}/.test(html), 'the nav height is 6 + 48 + 6');
  assert.ok(/\.ni\{width:auto;flex:1;height:48px/.test(html) &&
    /padding:6px 4px calc\(6px \+ env\(safe-area-inset-bottom\)\)/.test(html),
    'and the bar really is that tall');
  // One scroller on a phone: a nested list with overscroll-behavior:contain
  // traps an Android swipe and leaves the page short of its bottom.
  // Since 2026-10-16 the list is never a scroll box, on any screen (Owen: "they all load").
  assert.ok(/\n\.lob\{display:flex;flex-direction:column;padding-bottom:2px\}/.test(html),
    'the home lobby list is not a second scroll box on a phone');
  assert.ok(/overscroll-behavior:contain/.test(block), 'and does not rubber-band the page');

  /* The drag must take the no-op path when panes are in play: no pinning, no
     scroll reset, no compensation. Any of those coming back reintroduces the
     pop, because they only exist to paper over the shared scroll. */
  const sw = fs.readFileSync(path.join(ROOT, 'public/js/v2/swipe.js'), 'utf8');
  const bd = sw.slice(sw.indexOf('function beginDrag'), sw.indexOf('function move'));
  assert.ok(/const paned = getComputedStyle\(cur\)\.position === 'fixed'/.test(bd),
    'the drag detects the pane layout');
  assert.ok(/if \(paned\)/.test(bd), 'and skips the pinning when it applies');
  const fin = sw.slice(sw.indexOf('function finish'), sw.indexOf('function onEnd(e)'));
  assert.ok(/if \(commit && !d\.paned && window\.jumpToTop\)/.test(fin),
    'and never touches the document scroll in pane mode');

  // "Top" means the top of the screen you are on, not of the document.
  const jt = html.slice(html.indexOf('function jumpToTop'), html.indexOf('window.jumpToTop='));
  assert.ok(/cur\.scrollTop=0/.test(jt), 'jumpToTop scrolls the active pane');
});

test('a scrollbar can never shift the layout sideways', () => {
  /* A window scrollbar is about 15px of real page width. A screen tall enough
     to scroll is therefore 15px narrower than one that is not, so centred
     content lands ~7px off and every tab change nudged the whole layout
     sideways depending on whether that screen happened to overflow.

     Measured at 1440x820 before the fix: Home overflowed and its header
     centred at 713, while Wallet, Stats and Social centred at 720. After:
     all six tabs centre at 720 and the scrollbar measures 0px.

     Hiding it beats scrollbar-gutter:stable here, which also stops the shift
     but by permanently reserving the strip, leaving the line visible. */
  const html = v2();
  const i = html.indexOf('No window scrollbar');
  assert.ok(i > 0, 'the scrollbar rule is documented where it is defined');
  const block = html.slice(i, i + 1400);

  // Both engines, or it only works in one browser.
  assert.ok(/scrollbar-width:none/.test(block), 'hidden in Firefox');
  assert.ok(/::-webkit-scrollbar/.test(block), 'hidden in Chrome and Safari');
  assert.ok(/html,body\{scrollbar-width:none/.test(block), 'on the document itself');
  assert.ok(/main\.wrap\{scrollbar-width:none/.test(block),
    'and on the per-screen panes, which scroll on a phone');

  /* Hiding a scrollbar must never disable scrolling. overflow:hidden on the
     document outside the phone breakpoint would trap content taller than the
     window with no way to reach it. */
  const desktopHidesOverflow = /^html,body\{[^}]*overflow:hidden/m.test(
    html.slice(0, html.indexOf('@media(max-width:760px)')));
  assert.ok(!desktopHidesOverflow,
    'the document still scrolls on desktop, the bar is only invisible');
});

test('the nightly event states its prizes and reads the match, not a clock', () => {
  /* THE PAGE NO LONGER KEEPS THE TIMETABLE.

     It used to hold `var START=20, END=21` and its own Intl formatter, and
     called the event "Live now" between eight and nine whether or not a match
     existed — so it could never say "in progress", because it had no idea, and
     its Watch button appeared on the hour rather than on a match.

     The server owns the schedule (BR_AUTOSTART_HOUR/MIN) and is what starts the
     thing. A second copy out here is a copy that can drift, and the failure is
     silent: a countdown simply an hour out with nothing to say which hour was
     right. So the assertions have inverted — the page must NOT carry its own
     window any more, and must read the live state instead.

     A fixed UTC offset stays banned on both sides for the daylight-saving
     reason; the server sends Eastern as an hour and a minute. */
  const html = v2();
  assert.ok(!/var START\s*=\s*20\s*,\s*END\s*=\s*21/.test(html),
    'the page no longer keeps its own copy of the schedule');
  assert.ok(!/getTimezoneOffset\(\)\s*[-+]\s*\d|UTC[-+]\s*[45]\b/.test(html),
    'and does not add a hardcoded offset');
  assert.ok(/startHour/.test(html) && /etHour/.test(html),
    'it takes the schedule and the Eastern wall clock from the server');
  assert.ok(/\/api\/live/.test(html.slice(html.indexOf('V2Event') - 6000)),
    'which it gets from the live endpoint');

  /* The states it must be able to show. "in progress" is the one the wall
     clock could never express. */
  assert.ok(/in progress/i.test(html), 'it can say a match is in progress');
  assert.ok(!/alive · ring|' left'/.test(html), 'while live, the timer alone: no count of who is left, no ring (Owen 2026-10-17)');
  /* The shut door is said by the Join button itself, dimmed and relabelled
     (2026-10-15: a separate note under the hero repeated it word for word). */
  assert.ok(/join\.disabled = !BR\.joinable/.test(html) && /'Match in progress'/.test(html),
    'and that the doors are shut once a match is running');

  /* One prize now: first place takes $20, second and third take the placing.
     The page must not imply otherwise anywhere, which is a thing prose gets
     wrong long after the number is fixed. */
  assert.ok(/<span class="pmoney"[^>]*>\$20<\/span>/.test(html), 'first place is paid $20');
  assert.ok(!/$10|$5/.test(html.slice(html.indexOf('class="podium"'),
    html.indexOf('class="evfoot"'))), 'and nothing else on the podium is');
  assert.ok(!/top three share the pot/i.test(html),
    'and the page does not still say the pot is shared');
  // A seat with nobody in it, ready to hold a name.
  for (const id of ['ev-1st', 'ev-2nd', 'ev-3rd']) {
    assert.ok(html.includes('id="' + id + '"'), 'the podium has a seat for ' + id);
  }
  assert.ok(/V2Event={[^}]*podium/.test(html), 'and a way to seat a winner in it');
  // Tallest in the middle: the heights ARE the ranking.
  const h = (k) => {
    const at = html.indexOf('.p' + k + ' .pblock{height:');
    assert.ok(at > 0, 'plinth ' + k + ' has a height');
    return parseInt(html.slice(at).split('height:')[1], 10);
  };
  assert.ok(h(1) > h(2) && h(2) > h(3), 'first place stands highest');

  /* fillScreen runs BEFORE showScreen, so the arrival tick sees display:none.
     Without the force flag the clock shows dashes until the next interval. */
  assert.ok(html.includes("V2Event.tick(true)"),
    'opening the tab forces a tick rather than waiting for the interval');
});

test('the events podium leads, holds the last match all day, and never shows a prize nobody was paid', () => {
  /* Owen's pick C, "Podium stage" (2026-10-16): the podium first and biggest,
     the countdown under it, Join and Spectate pinned above the tab bar on a
     phone. While waiting the podium keeps the last match's top 3 (the server
     holds BR.podium until the next start) rather than three question marks. */
  const html = v2();
  const at = html.indexOf('id="events-screen"');
  const scr = html.slice(at, html.indexOf('</main>', at));
  assert.ok(scr.indexOf('class="podium"') < scr.indexOf('class="evclock"'), 'the podium comes before the clock');
  assert.ok(scr.indexOf('id="ev-h"') > 0 && scr.indexOf('id="ev-m"') > 0 && scr.indexOf('id="ev-s"') > 0,
    'hours, minutes and seconds, all three');
  assert.ok(/var seated=on\?null:pod;/.test(html), "the last match's names, except while a match is on");
  assert.ok(html.includes("(st==='waiting' && !seated) ? '$'+stdPrize"), 'only an empty podium before the start shows the standing prize');
  assert.ok(html.includes("(BR.prize>0 ? '$'+BR.prize : '—')"), "and a match's own podium shows what it paid");
  assert.ok(/\.evbar\{position:sticky;bottom:/.test(html), 'Join and Spectate pinned on a phone');
  // Player names reach the page as text, never as markup.
  const tick = html.slice(html.indexOf('function caption('), html.indexOf('/* engine(): which engine'));
  assert.ok(!/innerHTML/.test(tick), 'no innerHTML anywhere a winner name can reach');
});

test('an unbuilt game can be opened and looked at, and still cannot be played', () => {
  /* Every card used to be a dead div if the game was unbuilt: the padlock said
     you could not play it and the card agreed by doing nothing at all, so there
     was no way to find out what any of the eleven even were. They open now, and
     the screen behind them has to be the LOOKING screen, not the playing one
     with a dead button on it. */
  const html = v2();

  assert.ok(!/class="card soon">\$\{inner\}<\/div>/.test(html),
    'an unbuilt card is no longer an inert div');
  assert.ok(/class="card\$\{g\.soon\?' soon':''\}"[\s\S]{0,60}onclick="open_/.test(html),
    'every card opens its game, built or not');

  /* BACKLOG 2.2 (Owen 2026-10-15): one layout for every game, the unbuilt ones
     included. The column is the same; what cannot be pressed is shut. Play is
     locked with a padlock and disabled and the buy-ins are shut, so nothing
     on the screen can start the game. */
  assert.ok(!html.includes('soonwrap') && !html.includes('Not playable yet'), 'no separate locked panel');
  /* Owen, 2026-10-15: a shut game shows only what it is: the art, its name, the
     three prices and a padlocked Coming soon. Exactly these three go (the
     lobby row that went with them left every game, 2026-10-16). */
  assert.ok(html.includes('#detail.soon .lookrow,#detail.soon .spec{display:none}'),
    'Customize and Spectate are hidden for it (the name field is in the header card now)');
  assert.ok(!/#detail\.soon [^{]*(\.stakes|\.gorow|\.go|#dname)[^{]*\{display:none\}/.test(html), 'and nothing else');
  assert.match(html, /const locked=!!\(cur\.soon&&!cur\.built\);\s*det\.classList\.toggle\('soon',locked\);/);
  assert.match(html, /goBtn\.classList\.toggle\('lock',locked\);\s*goBtn\.disabled=locked;/, 'Play is shut');
  assert.match(html, /#detail\.soon \.stakes\{opacity:\.5;pointer-events:none\}/, 'and the buy-ins');
  assert.match(html, /function startFromDetail\(\)\{[^}]*if\(!cur\|\|\(cur\.soon&&!cur\.built\)\)return;/,
    'and Play refuses it even if it were pressed');
  // An unbuilt game offers only Free, struck through above it, like a built free-only one.
  assert.match(html, /\}else if\(g&&\(g\.freeOnly\|\|g\.solo\|\|g\.soon\)\)\{/);

  // The last gate: presentation is not a security boundary.
  assert.ok(html.includes('window.V2_IS_SOON'), 'the play path can ask what is built');
});

test('one layout for every game: rungs, Play, Customize, and no small print', () => {
  /* BACKLOG 2.2 and Owen 2026-10-15: "I don't want any of those little words.
     They just take up a lot of room." The column is the same things in the
     same order for every game, with no caption over or under any of them.
     Owen 2026-10-16: the name moved to the header card, and no open-lobbies list. */
  const html = v2();
  const col = html.slice(html.indexOf('<div class="gcol">'), html.indexOf('<!-- ══ WALLET ══ -->'));
  const at = s => { const i = col.indexOf(s); assert.ok(i > -1, 'the column has ' + s); return i; };
  const order = ['id="dname"', 'id="stakes"', 'class="gorow"', 'id="lookrow"']
    .map(at);
  assert.deepEqual(order, order.slice().sort((x, y) => x - y), 'in this order');
  for (const words of ['Your buy-in', 'Open lobbies', 'Game settings', 'Free plays a bot', 'Paid lobbies',
                       'Not open yet', 'Not playable yet', 'In development']) {
    assert.ok(!col.includes(words), 'no "' + words + '" in the column');
  }
  for (const gone of ['class="sl"', 'id="stakeoff"', 'id="dbnote"', 'id="duelbet"', 'class="queued"',
                      'class="lobhd"', 'class="soonwrap"', 'class="agopts"', 'class="lobwrap"', 'id="dlob"',
                      'class="namerow"', 'id="play-name"']) {
    assert.ok(!col.includes(gone), gone + ' is gone from the column');
  }
  // Nothing on the screen is shown or hidden per kind of game any more.
  assert.ok(!/#detail\.(duel|solo|freeonly|paidduel|queueing)\b/.test(html), 'no per-kind layout rules');
  // Play is white on Free and gold on a paid rung.
  // White on Free: a top-lit white, the gold button's make (2026-10-15).
  assert.match(html, /\.go\{[^}]*background:linear-gradient\(180deg,#ffffff/, 'white on Free');
  assert.match(html, /\.go\.paid\{background:linear-gradient/, 'gold on a paid rung');
  assert.match(html, /paid=Number\(STEPS\[si\]\)>0&&!shut;\s*if\(go\)go\.classList\.toggle\('paid',paid\);/, 'set by the chosen rung');
  // And it says the stake: "Play $0.50" (Owen, 2026-10-15).
  assert.match(html, /lbl\.textContent=shut\?'Coming soon':paid\?'Play '\+cash\(Number\(STEPS\[si\]\)\):'Play';/, 'Play $0.50 on a paid rung');
});

test('the game screen swipes to the next and previous game, and leaves taps and scrolling alone', () => {
  const html = v2();
  assert.match(html, /window\.V2Detail=\{[^\n]*flip:flipGame,keepBackdrop,restoreBackdrop\};/, 'the lobby exposes the flip');
  assert.match(html, /const n=GAMES\[\(i\+\(dir>0\?1:-1\)\+GAMES\.length\)%GAMES\.length\];/, 'in rail order, wrapping');
  const sw = fs.readFileSync(path.join(ROOT, 'public/js/v2/swipe.js'), 'utf8');
  assert.match(sw, /if \(visible\(el\('detail'\)\)\) \{\s*if \(!gBegin\(dir, src\)\)/, 'a sideways drag on the game screen flips');
  // Claimed only after CLAIM_PX of mostly-sideways travel, so a tap or a vertical drag is never taken.
  const claim = sw.indexOf("if (visible(el('detail')))");
  assert.ok(sw.lastIndexOf('if (Math.abs(dx) < CLAIM_PX) return;', claim) > -1 &&
            sw.lastIndexOf('if (Math.abs(dx) < Math.abs(dy) * CLAIM_RATIO) { tracking = false; return; }', claim) > -1,
    'after the tap and vertical checks');
  assert.match(sw, /if \(src && name && src === name && !name\.readOnly\) return false;/, 'the open name field keeps its drag');
  assert.match(sw, /anyVeil\(\)\) return false;/, 'and nothing flips under a sheet');

  /* A carousel, the tab drag page for page (Owen 2026-10-15). It used to move
     the column out with one tween and the next game's in with a second, whose
     start position and transition landed in the same style pass: the new game
     slid in from the side the finger was leaving, against the finger. */
  const gb = sw.slice(sw.indexOf('function gBegin'), sw.indexOf('function gRestore'));
  assert.ok(/det\.cloneNode\(true\)/.test(gb) && /det\.after\(still\)/.test(gb),
    'the screen you are on is kept as a still, after the real one so its ids resolve to the real one');
  assert.ok(gb.indexOf('getBoundingClientRect()') < gb.indexOf('V2Detail.flip(dir)'),
    'measured before the real screen turns into the next game');
  assert.ok(/delete cv\.dataset\[k\]/.test(gb) && /drawImage\(live\[i\]/.test(gb),
    'its canvases are pictures, unhooked from the painters');
  assert.ok(/still\.inert = true/.test(gb), 'and nothing on it can be pressed');
  assert.ok(/drag = \{ dir, game: true, cur: still, incoming: det/.test(gb),
    'it is the same drag object the tabs use, so move() and finish() drive both');
  assert.ok(!/gTween|G_OUT_MS|G_IN_MS/.test(sw), 'no second tween is left to run the wrong way');
  const fin = sw.slice(sw.indexOf('function finish'), sw.indexOf('function onEnd(e)'));
  assert.ok(/if \(!commit\) gRestore\(d\);\s*d\.cur\.remove\(\);/.test(fin),
    'springing back turns the real screen back first, then drops the still in the same frame');
  const gr = sw.slice(sw.indexOf('function gRestore'), sw.indexOf('function onMove'));
  assert.ok(/V2Detail\.flip\(-d\.dir\)/.test(gr) && /restoreBackdrop\(d\.back\)/.test(gr),
    'with the game you were on and the same backdrop world');
  assert.match(html, /function restoreBackdrop\(k\)\{[\s\S]*?SCENES\.set\(k\.cv,k\.world\);[\s\S]*?paintScene\(k\.cv,0\)/,
    'painted at once, so the new world never shows for a frame');

  /* The flip redraws the buy-in row and the lobby list, so a drag that began on
     one of those buttons is aimed at a node that has left the page: its moves
     stop reaching the document, preventDefault is never called, and Chrome
     took the rest of a rightward drag as Back (the page left for the previous
     URL, measured headless). The node passes its own moves on while it is out. */
  assert.ok(gb.indexOf('hold(from)') > -1 && gb.indexOf('hold(from)') < gb.indexOf('V2Detail.flip(dir)'),
    'the touched node is held before the flip can detach it');
  assert.ok(/move\(e\) \{ if \(!e\.currentTarget\.isConnected\) onMove\(e\); \}/.test(sw),
    'and forwards only while detached, so nothing is handled twice');
  assert.ok(/node\.addEventListener\('touchmove', fwd\.move, \{ passive: false \}\)/.test(sw),
    'cancelable, so the drag can still stop the page');
});

test('a swipe is timed by the finger, and its cleanup can always be found', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public/js/v2/swipe.js'), 'utf8');
  /* The first move of a drag stages the next screen, so the moves behind it
     arrive late and bunched. Timed by Date.now() a quick flick read as slow
     and sprang back (412px wide, 4x CPU: v 0.51 against a true 1.55 px/ms). */
  assert.ok(/const stamp = e => \(e && e\.timeStamp\) \|\| performance\.now\(\)/.test(sw), 'the event clock');
  assert.ok(/t0 = stamp\(e\)/.test(sw) && /const now = stamp\(e\)/.test(sw), 'used at the start and on every move');
  assert.ok(!/Date\.now\(\)/.test(sw.replace(/\/\*[\s\S]*?\*\//g, '')), 'and no wall clock is mixed in');
  /* A timer id is a number in a browser and this file is strict, so hanging
     the cleanup on it (settleTimer._done = done) threw at the end of every
     swipe, and a touch during a settle could never finish it. */
  assert.ok(!/settleTimer\._done/.test(sw.replace(/\/\*[\s\S]*?\*\//g, '')), 'nothing is hung on the timer id');
  assert.ok(/settleDone = done;/.test(sw) && /const f = settleDone; settleDone = null;/.test(sw),
    'the cleanup is kept beside it and run by the next touch');
});

test('How to play is off the games and on the event', () => {
  /* Everyone already knows how a snake game works, so the button was a control
     in the middle of the game screen earning nothing. An event's rules are the
     opposite: nobody can guess them, and there is no other place to read them. */
  const html = v2();
  assert.ok(!html.includes('class="howrow"'), 'no game carries a How to play button');
  assert.ok(!/onclick="openHow\(\)"/.test(html), 'and nothing opens it with no arguments');
  assert.ok(html.includes('openEventHow()'), 'the event opens its own');
  assert.ok(/function openHow\(title,steps\)/.test(html),
    'the sheet takes its content from whoever opens it');
});

test('the live dot beats only when somebody is really in there', () => {
  /* The dot is the whole signal: lit and moving means a room worth joining.
     An empty room must not pulse, or it means nothing at all. */
  const html = v2();
  /* One rule for the Open lobbies rows and the game cards' people count
     (BACKLOG 1.3 and 1.4), so the two beat alike. */
  assert.ok(/\.lcount\.on \.ldot,\.gpc\.on \.ldot\{[^}]*animation:lpulse/.test(html),
    'a lobby with players pulses, and so does a card with players');
  assert.ok(!/\.ldot\{[^}]*animation/.test(html.match(/\.ldot\{[^}]*\}/)[0]),
    'and an empty one does not');
  // A real blink, not the old fade to 72% that read as a steady light.
  const kf = html.match(/@keyframes lpulse\{[\s\S]*?\n\}/)[0];
  assert.ok(/opacity:\.3\d?\}/.test(kf), 'the dot dims well down at the middle of the beat');
  /* Pulse for everyone (Owen, 2026-10-10): the system's reduce-motion setting
     no longer stills these two dots. The blanket reduce rule would cut every
     animation to one 0.01ms beat, so the dots re-state theirs inside a reduce
     block, and nothing stops them there any more. There used to be a Motion
     switch in Settings too; that is gone as well. */
  assert.ok(!/\.lcount\.on \.ldot,\.gpc\.on \.ldot\{animation:none\}/.test(html),
    'the system setting no longer stops either dot');
  assert.ok(/@media\(prefers-reduced-motion:reduce\)\{\s*\.lcount\.on \.ldot,\.gpc\.on \.ldot\{animation-duration:1\.6s!important;animation-iteration-count:infinite!important\}/.test(html),
    'under reduce motion both dots keep the full beat, past the blanket rule');
  assert.ok(/\*,\*::before,\*::after\{animation-duration:\.01ms!important;animation-iteration-count:1!important/.test(html),
    'and the blanket rule still stills everything else');
  assert.ok(!/nomotion/.test(html), 'and nothing is left of the switch');
});

test('a duel shows the same screen as every other game, on the one shared ladder', () => {
  /* A duel is matched INTO rather than dropped into. The unbuilt ones used to
     carry their own screen (a $0.25 to $20 stepper, then a three-rung one, and
     a queue that could never match). BACKLOG 2.2 (Owen 2026-10-15): every game,
     duels and unbuilt ones included, has the same column: the name,
     Free / $0.50 / $1.00, Play and Customize. An unbuilt one has its Play
     shut. */
  const html = v2();

  for (const id of ['rooftop', 'headsoccer', 'swim']) {
    const m = html.match(new RegExp("\\{id:'" + id + "'[^\\n]*"));
    assert.ok(m, id + ' is in the game list');
    assert.ok(/duel:1/.test(m[0]), id + ' is a duel');
    assert.ok(/soon:1/.test(m[0]), id + ' is still unbuilt, and still says so');
  }

  /* Tanks is the first of them actually built. It is still a duel — matched
     into rather than dropped into — but it is not 'soon' any more, and it seats
     only the free rung while the mode is new. */
  const tanks = html.match(new RegExp("\\{id:'tanks'[^\\n]*"))[0];
  assert.ok(/duel:1/.test(tanks) && /built:1/.test(tanks), 'tanks is a built duel');
  assert.ok(!/soon:1/.test(tanks), 'and no longer says it is unbuilt');
  assert.ok(/freeOnly:1/.test(tanks), 'and seats only the free rung for now');

  const stumble = html.match(/\{id:'stumble'[^\n]*/)[0];
  assert.ok(/soon:1/.test(stumble) && !/duel:1/.test(stumble), 'stumble is unbuilt but not a duel');

  /* Paper used to be a solo run against bots in the browser. It is an arena on
     the server now (docs/paper-multiplayer-design.md section 10): its rooms are
     rungs of the ladder, Free, $0.50 and $1.00, so it is laddered like the snake
     game. It is dropped into rather than matched into, so it is never a duel,
     and never the paid:1 of a paid duel either. */
  const paper = html.match(/\{id:'paper'[^\n]*/)[0];
  assert.ok(/built:1/.test(paper) && /ladder:1/.test(paper), 'paper.io is a built game priced in rungs');
  assert.ok(!/solo:1/.test(paper), 'and no longer a solo run with its own free page');
  assert.ok(!/soon:1/.test(paper), 'and does not say it is unbuilt');
  assert.ok(!/duel:1/.test(paper), 'and is not a duel');
  assert.ok(!/paid:1/.test(paper), 'and not a paid duel either');

  // No duel-only furniture: the stepper, the pretend queue and the rules that hid the ladder are gone.
  assert.ok(!/#detail\.duel\b/.test(html), 'a duel hides nothing');
  for (const gone of ['id="duelbet"', 'id="dbamt"', 'function stepDuel', 'function joinQueue',
                      'Nobody to match you with yet', 'Find an opponent']) {
    assert.ok(!html.includes(gone), gone + ' is gone');
  }

  /* The stake is a LADDER of set rungs, not a box you type into. Set amounts
     are what let two people meet at the same number without either naming one
     the other has to accept, and there is no such thing as a typo on a ladder.
     BACKLOG 2.1 (Owen 2026-10-09): every game offers the one shared ladder,
     Free / $0.50 / $1.00 (shared/stakeLadder.js). */
  const shared = require(path.join(ROOT, 'shared/stakeLadder.js'));
  const la = html.indexOf('const LADDER=');
  const LADDER = new Function('window', html.slice(la, html.indexOf('\n', la)) + '\nreturn LADDER;')({ DS_LADDER: shared });
  assert.deepEqual(LADDER, [0, 0.5, 1], 'and it is the rungs Owen asked for, in order');
  assert.deepEqual(new Function('window', html.slice(la, html.indexOf('\n', la)) + '\nreturn LADDER;')({}), [0],
    'Free alone if the ladder file did not load: never a rung the server has not priced');
  assert.ok(!/<input[^>]*id="stakes"/.test(html), 'the amount is not a text field');
});

test('the two duels that take a buy-in are built and offer real rungs', () => {
  /* Knockout and Battleship are the only games on here that are matched INTO
     and take money. Both must be past soon:1 and flagged paid, or the lobby
     draws a ladder over a game that cannot seat anybody. */
  const html = v2();
  for (const id of ['knockout', 'battleship']) {
    const m = html.match(new RegExp("\{id:'" + id + "'[^\n]*"));
    assert.ok(m, id + ' is in the game list');
    assert.ok(/built:1/.test(m[0]), id + ' is built');
    assert.ok(/paid:1/.test(m[0]), id + ' offers a buy-in');
    assert.ok(/duel:1/.test(m[0]), id + ' is a duel');
    assert.ok(!/soon:1/.test(m[0]), id + ' no longer says it is coming');
  }
  /* And the lobby has to know where to open them. */
  const play = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'public', 'js', 'v2', 'play.js'), 'utf8');
  assert.ok(/knockout:\s*'\/knockout'/.test(play), 'knockout has a page');
  assert.ok(/battleship:\s*'\/battleship'/.test(play), 'battleship has a page');
});

test('an empty board never sends a laddered game to the fixed tier', () => {
  /* THE TWO-ROOMS-BOTH-CALLED-FREE BUG, third instance.

     There are two free snake rooms: the ladder's rung (na_s0), which is what
     the board advertises and where everybody plays, and a fixed tier from
     before the ladder (na_free), which nothing points at any more.

     playChosen's fallback read `!rows.length` as "this game has no ladder".
     It does not mean that. `rows` is also empty when /api/live has failed, and
     when it simply has not returned yet — V2Board.start() is the last call in
     the init line while the game cards are already clickable. The same empty
     list ALSO strikes out every rung and collapses the buy-in to Free, so
     `!stake` is true at the same instant. Snake therefore fell through to
     na_free on every cold start that beat the fetch, landing the player alone
     in a room with its own separate bot population while the board said the
     free table was busy.

     The detail screen's Enter button had already been fixed for exactly this,
     with a comment saying so. This was the line it missed. */
  const play = fs.readFileSync(path.join(ROOT, 'public/js/v2/play.js'), 'utf8');
  const html = v2();

  const i = play.indexOf('if (!rows.length && !stake)');
  assert.notEqual(i, -1, 'the no-rows fallback is still the thing being guarded');
  const fb = play.slice(i, play.indexOf('No room at that buy-in', i));

  assert.ok(/V2_HAS_LADDER/.test(fb),
    'the branch asks the catalogue whether this game is priced in rungs');
  assert.ok(/onLadder \? \{ stake: 0 \}/.test(fb),
    'a laddered game opens on the stake-0 rung, which the server creates at boot');
  assert.ok(/\{ lobbyType: 'free' \}/.test(fb),
    'and only a game with no ladder at all opens on the fixed tier');
  // The guard that keeps either branch off a paid room must survive.
  assert.ok(/!stake/.test(play.slice(i, i + 40)), 'the !stake guard is still there');

  // The predicate is worthless if the catalogue does not carry the flag.
  assert.ok(/id:'snake'[^}]*ladder:1/.test(html), 'snake is marked as a ladder game');
  assert.ok(/window\.V2_HAS_LADDER=/.test(html), 'and the predicate is published');
  /* agar.io's rooms are rungs now (Free, $0.50, $1.00; PAID-AGAR-DESIGN.md 7):
     /api/live lists ag:na:s0 and, while AG_PAID is on, its paid rungs, so a
     cold start opens its stake-0 rung like Paper's. */
  assert.ok(/id:'agar'[^}]*ladder:1/.test(html), 'agar is a ladder game');
});

test('the owner console names the room players are actually in', () => {
  /* Same two rooms, seen from the other end. The console printed a ladder
     room's raw id, so na_s0 — the room every free player is in — showed up as
     "slither.io · s0", sitting under a row called "slither.io · Free" that is
     the unreachable tier. Adding bots to the wrong one of those looks exactly
     like a broken button, and cost an afternoon of debugging a control that
     was working perfectly. */
  const s = server();
  const i = s.indexOf('function roomLabel(');
  assert.notEqual(i, -1, 'roomLabel still exists');
  const fn = s.slice(i, s.indexOf('\nfunction ', i + 10));

  // A rung is named by its price, parsed from the id rather than printed raw.
  assert.ok(/\^s\(\d\+\(\?:_\d\+\)\?\)\$/.test(fn) || /rung/.test(fn),
    'ladder rungs are recognised');
  assert.ok(/stake === 0 \? 'Free'/.test(fn), 'the stake-0 rung is called Free');
  assert.ok(/'\$' \+ stake\.toFixed\(2\)/.test(fn), 'and a paid rung names its price');

  // The tier rooms say they are the old ones, so they cannot be mistaken for
  // the live table again. The nightly event is NOT one of them.
  assert.ok(/old tier/.test(fn), 'the snake fixed tiers are marked as old');
  assert.ok(/const oldTier = !r\.isBattleRoyale;/.test(fn),
    'and the nightly event is not marked, because it is on the lobby');

  /* Run as written. The old agar.io rooms (agar_na_free and friends) are gone
     with that game; the agar.io rooms now are server/ag's `ag_na_s0#N`, all
     free, named as the game the lobby calls agar.io. */
  const roomLabel = new Function(fn + '; return roomLabel;')();
  assert.strictEqual(roomLabel({ lobbyType: 'ag_na_s0', index: 0 }), 'agar.io · Free');
  assert.strictEqual(roomLabel({ lobbyType: 'ag_na_s0#2', index: 2 }), 'agar.io · Free #2');
  assert.strictEqual(roomLabel({ lobbyType: 'na_s0' }), 'slither.io · Free');
  assert.strictEqual(roomLabel({ lobbyType: 'na_s1' }), 'slither.io · $1.00');
  assert.strictEqual(roomLabel({ lobbyType: 'na_free' }), 'slither.io · Free (old tier, off the board)');
  assert.strictEqual(roomLabel({ lobbyType: 'na_br', isBattleRoyale: true }), 'slither.io · Battle royale');
  assert.ok(!/agar_/.test(fn), 'nothing in it still parses the old agar room names');
});

test('an unrecognised lobbyType is logged rather than silently absorbed', () => {
  /* getRoomForType falls back to the free tier for ANY name it does not know.
     That is deliberate — a bad join should not fail outright — but it was
     silent, so a client sending a stale name ended up alone in a room nothing
     routes to and nothing anywhere said so. */
  const s = server();
  const i = s.indexOf('function getRoomForType(');
  const fn = s.slice(i, s.indexOf('\nfunction ', i + 10));
  assert.ok(/console\.warn/.test(fn), 'the fallback is logged');
  assert.ok(/unrecognised lobbyType/.test(fn), 'and says what it did not recognise');
  // The behaviour itself must not have changed in the same edit.
  assert.ok(/gameRooms\[rgn\]\.free/.test(fn), 'it still falls back rather than throwing');

  /* The logged value is chosen by whoever is connecting, so the line has to be
     written as if it were hostile: capped in length whatever type arrives,
     escaped so a newline cannot forge a second log entry, and rate-limited so
     a stranger does not get to decide how much disk one core writes. */
  // Only a string is quoted (String() on a client-built object can throw); anything else is named by its type.
  assert.ok(/typeof lobbyType === 'string' \? JSON\.stringify\(lobbyType\.slice\(0, 40\)\)/.test(fn), 'the value is capped in length');
  assert.ok(/JSON\.stringify\(/.test(fn), 'and escaped, so it cannot forge a log line');
  assert.ok(/_unknownLobbyAt/.test(fn) && /UNKNOWN_LOBBY_EVERY_MS/.test(fn),
    'the warning is rate-limited');
  assert.ok(/_unknownLobbySkipped/.test(fn),
    'and says how many it suppressed, so throttling never reads as quiet');
  // Throttle state must be two counters, not a per-value map a client can grow.
  assert.ok(/let _unknownLobbyAt = 0, _unknownLobbySkipped = 0;/.test(s),
    'the throttle keeps no client-keyed state');
});

test('Paper takes the widget path to its arena page, on every rung', () => {
  /* docs/paper-multiplayer-design.md section 10. The widget maps a game to its
     page, and a game it does not know falls through to /game.html, where the
     snake client would spend a paid Paper token. The bundle is what ships (the
     deploy does not build), so the map is checked in BOTH. */
  const src = fs.readFileSync(path.join(ROOT, 'wallet-widget/src/main.jsx'), 'utf8');
  assert.ok(/const PAGES = \{[^}]*paper: '\/paper-arena'/.test(src), 'the widget source maps paper');
  const bundle = fs.readFileSync(path.join(ROOT, 'public/wallet/widget.js'), 'utf8');
  assert.ok(bundle.includes('paper-arena'), 'the built bundle names the arena page');
  assert.ok(/\{agar:[`'"]\/ag[`'"][^}]*paper:[`'"]\/paper-arena[`'"]/.test(bundle),
    'and maps paper to it in the same page map, so the bundle is not stale');
  // The same map sends agar.io to the new game, never the deleted page.
  assert.ok(/const PAGES = \{ agar: '\/ag',/.test(src), 'the widget source maps agar to /ag');
  assert.ok(!/agar\.html/.test(src) && !/agar\.html/.test(bundle), 'nothing in the widget names the old page');

  /* The lobby's own shortcut is for games with no money in them. Paper has
     money on two rungs and a fresh hand-off on all three, so it is not there. */
  const play = fs.readFileSync(path.join(ROOT, 'public/js/v2/play.js'), 'utf8');
  const own = play.match(/const OWN_PAGE = \{[^}]*\}/);
  assert.ok(own, 'the own-page map is still there');
  assert.ok(!/paper/.test(own[0]), 'and Paper is not on it');

  /* The rows that light the rungs come from the server: /api/live appends the
     Paper directory's rows, which are game 'paper'. */
  const s = server();
  // (agar.io's rows ride along after Paper's: its free rung, and its paid ones while AG_PAID built them, PAID-AGAR-DESIGN.md 5.7;
  // paid snake on the sl engine's rows before Paper's, PAID-SL-DESIGN.md 2)
  assert.ok(/const lobbies = liveBoard\(\{ skipFree: slRows\.length > 0, slRungs \}\)\s*\.concat\(slRows, slPaidRows, paperArenas\.boardRows\(\), agRows\);/.test(s)
    && /const out = \{ lobbies,/.test(s) && /res\.json\(out\);/.test(s),
    '/api/live lists the Paper rows with the lobbies');
  const arenas = fs.readFileSync(path.join(ROOT, 'server/paper/PaperArenas.js'), 'utf8');
  const rows = arenas.slice(arenas.indexOf('boardRows()'), arenas.indexOf('get warming'));
  assert.ok(/game: 'paper'/.test(rows), 'and each of those rows is a paper row');

  // The solo game keeps its own page and route; the arena gets its own.
  assert.ok(/app\.get\('\/paper', .*public\/paper\.html/.test(s), 'the solo /paper route stays');
  assert.ok(/app\.get\('\/paper-arena', .*public\/paper-arena\.html/.test(s), 'and /paper-arena is served');
});

test('the Paper detail screen shows no rules line and no snake skin', () => {
  const html = v2();
  const paper = html.match(/\{id:'paper'[^\n]*/)[0];
  assert.ok(!/look:1/.test(paper), 'Paper has no snake to dress');
  // BACKLOG 3.1: the bar is still there, shut, saying so; it is not hidden.
  assert.ok(!html.includes('#detail.nolook .lookrow{display:none}'), 'so its Customize bar is shut, not hidden');
  assert.ok(html.includes("det.classList.toggle('nolook',!hasLook(cur))"), 'by a class the game sets');
  // Owen asked (2026-09-28) for the rules line under Paper's Play to go, and it
  // was the only game carrying one, so the whole per-game rules line went too.
  assert.ok(!html.includes('Kill a player, take their money'), 'the rules sentence is gone');
  assert.ok(!/\brules:'/.test(html), 'no game row carries a rules line');
  assert.ok(!html.includes('grules') && !html.includes('hasrules'),
    'and its element, CSS and per-game toggle are gone with it');

  // The browser-only row is gone, and the stake-0 row off the board is pinned instead.
  const board = fs.readFileSync(path.join(ROOT, 'public/js/v2/board.js'), 'utf8');
  assert.ok(!board.includes("'paper:free'"), 'no pinned paper:free row');
  assert.ok(/\['paper', 'agar', 'chomp'\]\.forEach\(g => LOBBIES\.forEach\(l => \{\s*if \(l\.game === g && Number\(l\.stake\) === 0/.test(board),
    'the Free Paper rung is pinned (then agar.io\'s and Chomp\'s)');
});

/* A lobby in a box: board.js, play.js and the widget's launch code on one stub window (test/v2LobbyHarness.js). */
const { lobbyHarness } = require('./v2LobbyHarness.js');
const plain = x => JSON.parse(JSON.stringify(x));   // across the vm realm

test('from the lobby, Free Paper opens /paper-arena with stake 0 and no token', async () => {
  const h = lobbyHarness([
    { id: 'na_s0', game: 'snake', region: 'na', stake: 0, players: 0, bots: 0, capacity: null, state: 'open' },
    { id: 'paper:na:s0', game: 'paper', region: 'na', stake: 0, players: 0, bots: 15, capacity: 16, state: 'open' },
  ]);
  await h.win.V2Board.load();
  const lob = h.el('lob').innerHTML;
  assert.ok(lob.includes('paper:na:s0'), 'the empty Free Paper rung is on the board');
  assert.ok(!lob.includes('paper:free'), 'and the old browser-only row is not');

  h.win.V2Board.join('paper:na:s0');                  // its Enter button
  assert.deepEqual(plain(h.plays), [{ game: 'paper', sel: { stake: 0 } }],
    'the lobby hands the widget the stake-0 rung, never a tier');
  await h.pending();
  const ss = h.win.sessionStorage;
  assert.equal(h.el('game-frame').src, '/paper-arena', 'the widget opens the arena page');
  assert.equal(h.el('game-frame').style.display, 'block', 'in the game frame');
  assert.equal(ss.getItem('stake'), '0', 'with stake 0 in sessionStorage');
  assert.equal(ss.getItem('entryToken'), '', 'and an empty token, freshly written');
  assert.equal(ss.getItem('lobbyType'), null, 'and no tier beside it');
  assert.equal(ss.getItem('walletAddress'), 'WALLET1');
  assert.equal(ss.getItem('region'), 'na');
  assert.equal(ss.getItem('playerName'), 'Tester');
  assert.ok(!h.fetched.some(u => /stake/.test(u)), 'Free asks for no quote and stakes nothing');
});

test('a cold start with no board still opens Free Paper on the stake-0 rung', async () => {
  /* /api/live failed: no rows at all. The ladder flag is what keeps this off
     the widget's lobbyType path, which would clear the stake the arena page
     reads. The flag is read from the real catalogue row. */
  const h = lobbyHarness(null);
  await h.win.V2Board.load();
  const row = v2().match(/\{id:'paper'[^\n]*/)[0];
  h.win.V2_HAS_LADDER = id => id === 'paper' && /ladder:1/.test(row);
  h.win.V2Detail = { game: 'paper', stake: 0 };
  h.win.V2Play.playChosen();
  assert.deepEqual(plain(h.plays), [{ game: 'paper', sel: { stake: 0 } }]);
  await h.pending();
  assert.equal(h.el('game-frame').src, '/paper-arena');
  assert.equal(h.win.sessionStorage.getItem('stake'), '0');
});

test('a paid Paper rung goes to the widget to be staked, never straight to a page', async () => {
  const h = lobbyHarness([]);
  h.win.V2Play.launch('paper', { stake: 0.5 });
  assert.deepEqual(plain(h.plays), [{ game: 'paper', sel: { stake: 0.5 } }]);
  await assert.rejects(h.pending(), /no server here/, 'the stub server refuses the quote');
  assert.ok(h.fetched.includes('/api/stake-quote?stake=0.5'), 'the widget asked for the $0.50 quote');
  assert.equal(h.el('game-frame').src, '', 'and nothing opened without a stake');
});

/* STATUS "BEFORE PAPER_PAID IS SWITCHED ON" item 1 (night queue item 5), through the widget's
   real launch code: with the EU region picked, a Paper buy-in was quoted and submitted on
   https://eu.duelseries.com while /paper-arena (io() with no URL) joined this origin, which
   refused the EU token: a stake with no seat. Knockout and Battleship had the same split. */
test('a paid Paper, Knockout or Battleship buy-in is staked on this origin even with EU picked', async () => {
  for (const game of ['paper', 'knockout', 'battleship']) {
    const h = lobbyHarness([]);
    h.win.localStorage.setItem('duelseries_region', 'eu');
    h.win.V2Play.launch(game, { stake: 0.5 });
    await assert.rejects(h.pending(), /no server here/);
    const quotes = h.fetched.filter(u => /stake-quote/.test(u));
    assert.deepEqual(quotes, ['/api/stake-quote?stake=0.5'], game + ' is quoted by the server its page joins');
  }
  /* The old snake game's page follows the region, so its stake still does. A paid snake rung is staked only
     while the board lists its room open (T7, PAID-SL-DESIGN.md 2), so the board here lists the old $0.50 room;
     the new engine's (an 'sl:' row) is staked on this origin (test/slPaidLobby.test.js). */
  const s = lobbyHarness([{ id: 'snake:na:s0.5', game: 'snake', region: 'na', stake: 0.5, players: 0, bots: 0,
    capacity: null, state: 'open' }]);
  await s.win.V2Board.load();
  s.win.localStorage.setItem('duelseries_region', 'eu');
  s.win.V2Play.launch('snake', { stake: 0.5 });
  await assert.rejects(s.pending(), /no server here/);
  assert.deepEqual(s.fetched.filter(u => /stake-quote/.test(u)), ['https://eu.duelseries.com/api/stake-quote?stake=0.5']);
});

/* The lobby swap (agario-reference/PLAN.md Phase 5) and the rungs (PAID-AGAR-DESIGN.md 7): the agar.io card opens the
   NEW game at /ag, in the same frame the old one used (agar-frame), through the widget's real launch code, on the rung
   the player picked. Free is the stake-0 rung off the real board (ag:na:s0), like Paper's. The old page (/agar.html)
   is deleted. */
const AG_FREE = { id: 'ag:na:s0', game: 'agar', region: 'na', stake: 0, players: 0, bots: 30, capacity: 54, state: 'open' };
const agPaidRow = (stake, state, players) => ({ id: 'ag:na:s' + stake, game: 'agar', region: 'na', stake,
  players: players || 0, parked: 0, bots: 0, capacity: 54, state: state || 'open' });

test('from the lobby, Free agar.io opens /ag in the agar frame on the stake-0 rung, with no token', async () => {
  const h = lobbyHarness([AG_FREE]);
  await h.win.V2Board.load();
  const lob = h.el('lob').innerHTML;
  assert.ok(lob.includes('ag:na:s0'), 'the empty Free agar.io rung is on the board');
  assert.ok(!lob.includes('agar:free'), 'and the old browser-only row is not');
  h.win.V2Board.join('ag:na:s0');                      // its Enter button
  assert.deepEqual(plain(h.plays), [{ game: 'agar', sel: { stake: 0 } }],
    'the lobby hands the widget the stake-0 rung, never a tier');
  await h.pending();
  const ss = h.win.sessionStorage;
  assert.equal(h.el('agar-frame').src, '/ag', 'the widget opens the new game');
  assert.equal(h.el('agar-frame').style.display, 'block', 'in the agar frame, as the old game was');
  assert.equal(h.el('game-frame').src, '', 'and not in the snake frame');
  assert.equal(ss.getItem('stake'), '0', 'with stake 0 in sessionStorage');
  assert.equal(ss.getItem('entryToken'), '', 'and an empty token, freshly written');
  assert.equal(ss.getItem('lobbyType'), null, 'and no tier beside it');
  assert.equal(ss.getItem('playerName'), 'Tester', 'the lobby name the page puts in its name box');
  assert.equal(ss.getItem('gameMode'), null, 'the old page\'s write-only flag is gone');
  assert.ok(!h.fetched.some(u => /stake/.test(u)), 'Free asks for no quote and stakes nothing');

  // From the detail screen with no board yet: agar.io is priced in rungs, so it opens on its stake-0 rung.
  const d = lobbyHarness(null);
  await d.win.V2Board.load();
  const row = v2().match(/\{id:'agar'[^\n]*/)[0];
  d.win.V2_HAS_LADDER = id => id === 'agar' && /ladder:1/.test(row);
  d.win.V2Detail = { game: 'agar', stake: 0 };
  d.win.V2Play.playChosen();
  assert.deepEqual(plain(d.plays), [{ game: 'agar', sel: { stake: 0 } }]);
  await d.pending();
  assert.equal(d.el('agar-frame').src, '/ag');
  assert.equal(d.win.sessionStorage.getItem('stake'), '0');
});

test('agar.io paid rungs are offered only while /api/live lists them open (AG_PAID off, or the owner\'s off switch)', async () => {
  const stakes = (h, g) => plain([...h.win.V2Board.playableStakes(g)]).sort((a, b) => a - b);
  // AG_PAID off: the server lists only the free rung, so $0.50 and $1.00 are drawn struck through.
  const off = lobbyHarness([AG_FREE]);
  await off.win.V2Board.load();
  assert.deepEqual(stakes(off, 'agar'), [0], 'AG_PAID off: Free only');
  // On: all three rungs.
  const on = lobbyHarness([AG_FREE, agPaidRow(0.5), agPaidRow(1, 'open', 3)]);
  await on.win.V2Board.load();
  assert.deepEqual(stakes(on, 'agar'), [0, 0.5, 1], 'AG_PAID on: every rung');
  assert.ok(on.el('lob').innerHTML.includes('ag:na:s1'), 'an occupied open paid room is listed to join');
  // agar:paid:off: the rows stay listed (their seated players finish), marked closed. Not offered, not listed as a
  // place to join, and a stale Enter on one asks the widget for nothing.
  const shut = lobbyHarness([AG_FREE, agPaidRow(0.5, 'closed', 2), agPaidRow(1, 'closed')]);
  await shut.win.V2Board.load();
  assert.deepEqual(stakes(shut, 'agar'), [0], 'switched off: Free only');
  assert.ok(!shut.el('lob').innerHTML.includes('ag:na:s0.5'), 'the closed room with players is not on the board');
  shut.win.V2Board.join('ag:na:s0.5');
  assert.deepEqual(plain(shut.plays), [], 'a stale Enter is refused before the widget');
  // Snake and Paper are untouched by the state rule: their rows say 'open' (or nothing) and all of them count.
  const both = lobbyHarness([
    { id: 'na_s0', game: 'snake', region: 'na', stake: 0, players: 0, bots: 39, capacity: null, state: 'open' },
    { id: 'na_s0.5', game: 'snake', region: 'na', stake: 0.5, players: 0, bots: 0, capacity: null },
    { id: 'na_s1', game: 'snake', region: 'na', stake: 1, players: 2, bots: 0, capacity: null, state: 'open' },
    { id: 'paper:na:s0', game: 'paper', region: 'na', stake: 0, players: 0, bots: 15, capacity: 16, state: 'open' },
    { id: 'paper:na:s0.5', game: 'paper', region: 'na', stake: 0.5, players: 0, bots: 0, capacity: 16, state: 'open' },
    { id: 'paper:na:s1', game: 'paper', region: 'na', stake: 1, players: 0, bots: 0, capacity: 16, state: 'open' },
  ]);
  await both.win.V2Board.load();
  assert.deepEqual(stakes(both, 'snake'), [0, 0.5, 1], 'snake: every listed rung');
  assert.deepEqual(stakes(both, 'paper'), [0, 0.5, 1], 'Paper: every listed rung');
  assert.deepEqual(stakes(both, 'agar'), [], 'no agar row, no agar rung (the game is closed)');
  const lob = both.el('lob').innerHTML;
  assert.ok(lob.includes('na_s0') && lob.includes('na_s1') && lob.includes('paper:na:s0'),
    'the free snake room, the occupied $1 snake room and Free Paper are on the board as before');
});

test('a paid agar.io rung goes to the widget to be staked on this origin, never straight to a page; a tier is refused', async () => {
  const h = lobbyHarness([AG_FREE, agPaidRow(0.5), agPaidRow(1)]);
  await h.win.V2Board.load();
  h.win.localStorage.setItem('duelseries_region', 'eu');   // agar.io's page joins this origin whatever the region
  h.win.V2Detail = { game: 'agar', stake: 0.5 };
  h.win.V2Play.playChosen();
  assert.deepEqual(plain(h.plays), [{ game: 'agar', sel: { stake: 0.5 } }], 'the lobby names the rung');
  await assert.rejects(h.pending(), /no server here/, 'the stub server refuses the quote');
  assert.deepEqual(h.fetched.filter(u => /stake-quote/.test(u)), ['/api/stake-quote?stake=0.5'],
    'the widget asked this origin for the $0.50 quote, where agar.io\'s paid door is');
  assert.equal(h.el('agar-frame').src, '', 'and nothing opened without a stake');

  // agar.io has no tier rooms: a tier name is refused by the lobby and by the widget, before any quote.
  const t = lobbyHarness([]);
  t.win.V2Play.launch('agar', { lobbyType: 'dime' });
  assert.deepEqual(plain(t.plays), [], 'the widget is never asked');
  assert.match(t.el('play-msg').textContent, /does not exist/, 'and the player is told why');
  for (const sel of [{ lobbyType: 'dime' }, { lobbyType: 'dollar' }]) {
    await assert.rejects(t.win.stakeAndPlay('agar', sel, { address: 'WALLET1' },
      () => { throw new Error('never signs'); }, () => {}, () => {}), /does not exist/);
  }
  assert.ok(!t.fetched.some(u => /stake/.test(u)), 'nothing was quoted');
  assert.equal(t.el('agar-frame').src, '', 'and nothing opened');
});

/* Review fix (lobby-rungs reviews): play.js asks the widget for a paid agar.io stake only while the board lists that
   rung's room as open. With AG_PAID off (no paid row), under the owner's off switch (rows 'closed'), with no board at
   all, or from a detail screen left open across the switch (playChosen goes through enter(), not join()), a console
   call or stale handler gets a message and no wallet prompt. */
test('a paid agar.io stake reaches the widget only while the board lists that rung open', async () => {
  const tries = [
    ['AG_PAID off', [AG_FREE]],
    ['the owner\'s off switch', [AG_FREE, agPaidRow(0.5, 'closed', 2), agPaidRow(1, 'closed')]],
    ['no board at all', null],
  ];
  for (const [why, rows] of tries) {
    const h = lobbyHarness(rows);
    await h.win.V2Board.load();
    for (const stake of [0.5, 1]) {
      h.win.V2Play.launch('agar', { stake });
      h.win.V2Detail = { game: 'agar', stake };
      h.win.V2Play.playChosen();
    }
    if (rows) for (const r of rows) if (r.stake > 0) h.win.V2Play.enter(r);
    assert.deepEqual(plain(h.plays), [], why + ': the widget is never asked');
    assert.match(h.el('play-msg').textContent, rows && rows.length > 1 ? /not open right now/ : /not open right now|No room/,
      why + ': the player is told');
    assert.ok(!h.fetched.some(u => /stake/.test(u)), why + ': nothing was quoted');
  }
  // Open: the same calls go through, and Free is never held back.
  const ok = lobbyHarness([AG_FREE, agPaidRow(0.5), agPaidRow(1)]);
  await ok.win.V2Board.load();
  ok.win.V2Play.launch('agar', { stake: 1 });
  assert.deepEqual(plain(ok.plays), [{ game: 'agar', sel: { stake: 1 } }], 'an open rung is staked as before');
  // Awaited, so the stub's refused quote cannot reject after the test has ended.
  await assert.rejects(ok.pending(), /no server here/);
  const free = lobbyHarness([AG_FREE]);
  await free.win.V2Board.load();
  free.win.V2Play.launch('agar', { stake: 0 });
  assert.deepEqual(plain(free.plays), [{ game: 'agar', sel: { stake: 0 } }], 'Free is not a paid stake');
  // Paper keeps its own rule: no board check (its door refunds, as before this step).
  const paper = lobbyHarness([]);
  await paper.win.V2Board.load();
  paper.win.V2Play.launch('paper', { stake: 0.5 });
  assert.deepEqual(plain(paper.plays), [{ game: 'paper', sel: { stake: 0.5 } }], 'Paper unchanged');
  await assert.rejects(paper.pending(), /no server here/);
});

test('watching agar.io from the lobby opens /ag in the agar frame too', () => {
  const h = lobbyHarness([]);
  h.win.V2Play.spectate('agar');
  assert.equal(h.el('agar-frame').src, '/ag');
  assert.equal(h.el('agar-frame').style.display, 'block');
  assert.equal(h.el('game-frame').src, '');
  const s = lobbyHarness([]);
  s.win.V2Play.spectate('snake', 'br');
  assert.equal(s.el('game-frame').src, '/game.html', 'the snake game still watches in its own frame');
  assert.equal(s.el('agar-frame').src, '');
});

test('the agar.io card paints the new game\'s look, not the old one\'s', () => {
  const html = v2();
  // The old game's floor and grid (read out of the deleted public/js/agar.js) are gone.
  assert.ok(!html.includes('#f0f4ff') && !html.includes('rgba(99,102,241'), 'no old agar floor or grid');
  assert.ok(!/agar\.js|agar\.html/.test(html), 'nothing on the lobby names the old files');
  // The new game's own values (public/js/ag/agRender.js): floor, 50-unit grid, black lines at 0.2.
  const render = fs.readFileSync(path.join(ROOT, 'public/js/ag/agRender.js'), 'utf8');
  assert.ok(render.includes("var BG_LIGHT = 'rgb(242,251,255)'") && render.includes('var GRID = 50;'),
    'the game still draws with the values the card copies');
  assert.ok(html.includes("function agBg(){return 'rgb(242,251,255)'}"), 'the card floor is the game floor');
  assert.ok(/const G=50\*agK\(\)/.test(html), 'the card grid is the game grid, to the card scale');
  // The colour rule (laws L33/L36): one channel 255, one 7, the third 8 to 254, any order.
  const src = html.slice(html.indexOf('function agRgb(){'), html.indexOf('function agCss('));
  const agRgb = new Function(src + '; return agRgb;')();
  for (let i = 0; i < 500; i++) {
    const v = agRgb().slice().sort((a, b) => a - b);
    assert.ok(v[0] === 7 && v[2] === 255 && v[1] >= 8 && v[1] <= 254, JSON.stringify(v));
  }
  // Nothing to customize on agar.io yet: the server picks the colour, so a skin would do nothing.
  assert.ok(!/\{id:'agar'[^}]*look:1/.test(html), 'agar.io has nothing to customize yet');
});

test('each playable game card carries a people count, and a padlocked one does not', () => {
  const html = v2();
  const fnSrc = (name) => {
    const i = html.indexOf('function ' + name + '(');
    assert.ok(i >= 0, name + ' exists');
    let depth = 0, j = html.indexOf('{', i);
    for (let k = j; k < html.length; k++) {
      if (html[k] === '{') depth++;
      else if (html[k] === '}' && --depth === 0) return html.slice(i, k + 1);
    }
    throw new Error('unterminated ' + name);
  };
  // The slot: bottom left of the art, a person drawn as SVG (not an emoji), hidden until counted.
  assert.ok(/\.gpc\{position:absolute;left:6px;bottom:6px/.test(html), 'bottom left of the card image');
  assert.ok(/\.gpc\{[^}]*background:rgba\(0,0,0,\.8\d\)[^}]*color:#fff/.test(html),
    'white person and number on a black pill (BACKLOG 1.2), so it stands out on light art');
  // The green dot beside the person exists only while somebody is playing.
  assert.ok(/\.gpc \.ldot\{display:none/.test(html) && /\.gpc\.on \.ldot\{display:block\}/.test(html),
    'no dot at 0, a dot once anyone is in');
  assert.ok(/const PERSON_SVG='<svg /.test(html), 'the person is inline SVG');
  const countHTML = new Function('PERSON_SVG', fnSrc('countHTML') + '; return countHTML;')('<svg></svg>');
  assert.ok(countHTML({ id: 'paper' }).includes('data-pc="paper"') && / hidden>/.test(countHTML({ id: 'paper' })));
  assert.strictEqual(countHTML({ id: 'swim', soon: 1 }), '', 'a game that is not live shows nothing');
  assert.ok(/<div class="art">\$\{art\(g\)\}\$\{countHTML\(g\)\}<\/div>/.test(html), 'inside the art box');
  // Refreshed on every poll and every time the rail or grid is rebuilt.
  assert.ok(/paintCounts\(\);\s*repaintAll\(\);/.test(html), 'the rail paints its counts');
  assert.ok(/GAMES\.map\(cardHTML\)\.join\(''\);\s*paintCounts\(\);/.test(html), 'the all-games grid too');
  const board = fs.readFileSync(path.join(ROOT, 'public/js/v2/board.js'), 'utf8');
  assert.ok(/COUNTS = j\.counts/.test(board) && /window\.V2_paintCounts\(\)/.test(board), 'every poll repaints them');
  assert.ok(/get counts\(\)/.test(board));

  // paintCounts, run: textContent only, and no number without the server's say-so.
  const paint = fnSrc('paintCounts');
  assert.ok(!/innerHTML/.test(paint), 'server data never goes through innerHTML');
  const mk = (id) => { const b = { textContent: '' }; const cls = new Set();
    return { dataset: { pc: id }, hidden: true, attrs: {}, cls,
      classList: { toggle(c, on) { if (on) cls.add(c); else cls.delete(c); } },
      querySelector: () => b, setAttribute(k, v) { this.attrs[k] = v; }, b }; };
  const els = [mk('snake'), mk('agar'), mk('paper'), mk('tanks')];
  const document = { querySelectorAll: () => els };
  const run = (counts) => new Function('window', 'V2Board', 'document', paint + '; paintCounts();')(
    { V2Board: { counts } }, { counts }, document);
  run({ snake: 12, agar: 0, paper: '<img src=x onerror=alert(1)>' });
  assert.deepStrictEqual(els.map(e => [e.hidden, e.b.textContent]),
    [[false, '12'], [false, '0'], [true, ''], [true, '']], 'numbers shown, anything else hidden');
  assert.strictEqual(els[0].attrs['aria-label'], '12 playing now');
  assert.ok(els[0].cls.has('on') && !els[1].cls.has('on'), 'the live dot is on at 12 and off at 0');
  run({ snake: 0, agar: 3 });
  assert.ok(!els[0].cls.has('on') && els[1].cls.has('on'), 'and the next poll switches it with the count');
  run(null);
  assert.ok(els.every(e => e.hidden), 'a failed poll hides every count');
});

test('the Shop tab is gone: skins are bought in Customize, and an old Shop route lands on Home', () => {
  /* The tab came in empty on 2026-09-28 and showed priced skins from
     2026-10-15. On 2026-10-16 Owen agreed to drop it: a skin is bought where it
     is worn, in Customize, so a second place listing the same skins was one
     tab too many. The skins and prices stay (shop.test.js), and so do the
     locked skins in the chooser. */
  const html = v2();
  const nav = html.slice(html.indexOf('const NAV=['), html.indexOf('];', html.indexOf('const NAV=[')));
  assert.ok(!/id:'shop'/.test(nav), 'no Shop in the nav');
  assert.deepEqual([...nav.matchAll(/\{id:'(\w+)'/g)].map(m => m[1]), ['play', 'wallet', 'events', 'social', 'clips', 'updates', 'join', 'settings']);
  assert.ok(!/shop-screen|id="shop"|V2ShopTab|tab==='shop'/.test(html), 'no Shop screen, mount or route');
  const sw = fs.readFileSync(path.join(ROOT, 'public/js/v2/swipe.js'), 'utf8');
  assert.ok(sw.includes("const TABS = ['play', 'wallet', 'events', 'social', 'settings'];"), 'the swipe order matches the nav');
  assert.ok(!sw.includes('shop-screen'), 'and the swipe knows no Shop screen');
  // A stale go('shop') (an old page, a cached handler) is sent Home, never to a nav with nothing lit.
  assert.match(html, /function go\(id,dir\)\{[\s\S]{0,400}if\(!SCREEN_FOR\[id\]\)id='play';[^;]{0,40};?\s*route=id;/);
  for (const src of ['/shared/shopPrices.js', '/js/battleshipArt.js', '/js/v2/shopArt.js'])
    assert.ok(html.includes(src), 'Customize still loads ' + src);
  for (const src of ['/js/v2/shop.js', '/css/shop.css']) {
    assert.ok(!html.includes(src), 'the lobby no longer loads ' + src);
    assert.ok(!fs.existsSync(path.join(ROOT, 'public', src)), src + ' is deleted');
  }
  const art = fs.readFileSync(path.join(ROOT, 'public/js/v2/shopArt.js'), 'utf8');
  for (const bad of ['fetch(', 'XMLHttpRequest', 'io(', '/api/', 'socket', 'privy', 'sendTransaction', 'V2Wallet'])
    assert.ok(!art.toLowerCase().includes(bad.toLowerCase()), 'the skin art has no ' + bad);
  for (const gone of ['COSMETIC_CATALOG', '/api/cosmetics/'])
    assert.ok(!html.includes(gone), 'removed shop code stays removed: ' + gone);
});

/* BACKLOG 1.1 (Owen, 2026-10-09): Awesome Tanks and Bowmasters are locked, the
   same padlock the unreleased games show, with their code kept. The list is
   shared/lockedGames.js, read by the lobby and the server alike, so unlocking
   is one line. The server half (no room, no rows, pages redirected) is checked
   on the real server in joinSmoke.test.js. */
test('a locked game is padlocked like an unreleased one, and nothing on the lobby plays it', async () => {
  const LOCK = require(path.join(ROOT, 'shared/lockedGames.js'));
  assert.deepStrictEqual([...LOCK.LOCKED_GAMES].sort(), ['omgshooter', 'tanks'], 'Awesome Tanks and Bowmasters');
  assert.ok(LOCK.isLocked('tanks') && !LOCK.isLocked('snake') && !LOCK.isLocked('knockout'));

  const html = v2();
  const tag = html.indexOf('<script src="/shared/lockedGames.js"></script>');
  assert.ok(tag > 0 && tag < html.indexOf('const GAMES=['), 'the lobby loads the list before its game registry');

  // The registry and the lock, run as the page runs them.
  const a = html.indexOf('const GAMES=[');
  const b = html.indexOf('});', html.indexOf('delete g[k];', a));
  assert.ok(a > 0 && b > a, 'the lock sits right after the registry');
  const GAMES = new Function('window', 'DS_LOCKED',
    html.slice(a, b + 3) + '\nreturn GAMES;')({ DS_LOCKED: LOCK }, LOCK);
  const G = id => GAMES.find(g => g.id === id);
  const isSoon = new Function('G', 'return ' + html.match(/window\.V2_IS_SOON=(id=>\{[^\n]*\});/)[1])(G);
  for (const id of ['omgshooter', 'tanks']) {
    const g = G(id);
    assert.ok(g.soon && g.locked, id + ' shows the padlock');
    for (const k of ['built', 'duel', 'solo', 'freeOnly', 'paid', 'ladder'])
      assert.ok(!g[k], id + ' has no ' + k + ' flag left to put a Play button or queue on its screen');
    assert.ok(isSoon(id), id + ' is refused by the play path');
  }
  // Nothing else moved.
  assert.ok(!G('snake').soon && !isSoon('snake') && !isSoon('agar') && !isSoon('paper'));
  assert.ok(G('knockout').built && G('knockout').duel && G('battleship').built, 'Knockout and Battleship stay');
  // The source entries are kept as they were, for the day they unlock.
  assert.ok(/\{id:'omgshooter'[^\n]*built:1,solo:1/.test(html) && /\{id:'tanks'[^\n]*duel:1,built:1,freeOnly:1/.test(html));

  // Open lobbies: no pinned row for either, and Enter on a stale one does nothing.
  const h = lobbyHarness([
    { id: 'na_s0', game: 'snake', region: 'na', stake: 0, players: 0, bots: 0, capacity: null, state: 'open' },
  ]);
  h.win.DS_LOCKED = LOCK;
  await h.win.V2Board.load();
  const lob = h.el('lob').innerHTML;
  assert.ok(!lob.includes('omgshooter:free') && !lob.includes('tanks:free'), 'neither is listed');
  assert.ok(lob.includes('knockout:free') && lob.includes('battleship:free'), 'the other pinned rows are');
  h.win.V2Board.join('tanks:free');
  h.win.V2Board.join('omgshooter:free');
  assert.strictEqual(h.el('game-frame').src, '', 'no game page was opened');
  assert.deepStrictEqual(plain(h.plays), [], 'and nothing reached the widget');
});

/* Owen, 2026-10-10: the locked games keep their "In development" screen but
   move off to the side, so the games that are open show first. Worked out at
   load from the soon flag, so unlocking a game puts it back by itself. */
test('every playable game is listed before any locked or unreleased one', () => {
  const LOCK = require(path.join(ROOT, 'shared/lockedGames.js'));
  const html = v2();
  const a = html.indexOf('const GAMES=[');
  const s = html.indexOf('GAMES.splice(0,GAMES.length,', a);
  assert.ok(s > html.indexOf('delete g[k];', a), 'the order is worked out after the lock has set soon');
  const b = html.indexOf(';', s);
  const run = lock => new Function('window', 'DS_LOCKED',
    html.slice(a, b + 1) + '\nreturn GAMES.map(g=>g.id);')({ DS_LOCKED: lock }, lock);

  assert.deepStrictEqual(run(LOCK), [
    'snake', 'paper', 'agar', 'chomp', 'knockout', 'battleship',
    'omgshooter', 'tanks', 'rooftop', 'headsoccer', 'swim', 'stumble',
  ], 'playable in their own order, then locked and unreleased in theirs');

  // Unlocked, both go straight back to their own place among the playable ones.
  const none = { LOCKED_GAMES: [], isLocked: () => false };
  assert.deepStrictEqual(run(none).slice(0, 8),
    ['snake', 'paper', 'agar', 'chomp', 'omgshooter', 'tanks', 'knockout', 'battleship']);

  // The rail and the full grid both draw from that order.
  assert.ok(/order=GAMES\.slice\(\)/.test(html) && html.indexOf('order=GAMES.slice()') > s, 'the rail copies it after the sort');
  assert.ok(/getElementById\('ggrid'\)\.innerHTML=GAMES\.map\(cardHTML\)/.test(html), 'the grid draws GAMES');
});

/* BACKLOG 2.1: the widget has no default room any more. It used to stake a duel:play that named no
   room into the ten cent tier, which quoted and minted a real $0.10 entry. Now such an event is
   refused before any quote or wallet prompt, and the retired dime is gone from its source and from
   the built bundle the lobby loads. */
test('the widget refuses a duel:play that names no room, before any quote', async () => {
  const h = lobbyHarness([{ id: 'snake:na:s0', game: 'snake', region: 'na', stake: 0, players: 0, bots: 0, capacity: null, state: 'open' }]);
  for (const detail of [{ game: 'snake' }, { game: 'paper', lobbyType: '' }, { game: 'snake', stake: null }]) {
    h.win.dispatchEvent(new h.win.CustomEvent('duel:play', { detail }));
    await assert.rejects(h.pending(), /That lobby is not available right now/, JSON.stringify(detail));
  }
  assert.deepStrictEqual(h.fetched.filter((u) => /stake-quote|submit-stake/.test(u)), [], 'nothing was quoted');
  const src = fs.readFileSync(path.join(ROOT, 'wallet-widget/src/main.jsx'), 'utf8');
  assert.ok(!/\|\| 'dime'/.test(src) && !/dime:/.test(src), 'no dime default and no dime label in the source');
  const built = fs.readFileSync(path.join(ROOT, 'public/wallet/widget.js'), 'utf8');
  assert.ok(!built.includes('lobbyType||`dime`') && !built.includes('lobbyType||"dime"') && !built.includes("lobbyType||'dime'"),
    'the built widget the lobby loads has no dime default either (npm run build)');
  assert.ok(built.includes('That lobby is not available right now. Refresh and try again.'), 'and it carries the refusal');
});

test('Social shows Global player winnings: real players only, the lobby strip\'s own number, live', () => {
  /* HARD RULE (Owen, 2026-10-15): the same rule and source as the lobby strip
     (server/earnings), so the two always agree, and never Owen's own test play.
     "Paid out to players" read /api/stats/winnings, which counted his play
     ($242.11) and showed it to the public as player winnings. */
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/social.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/fetch\('\/api\/stats\/winnings'/.test(code), 'the old all-payouts total is not read');
  assert.ok(/'\/api\/earnings\/total'/.test(code), 'the strip\'s total is');
  assert.ok(/earnings=preview/.test(code) && /\?preview=1/.test(code), 'and only ?earnings=preview asks for the owner-inclusive preview');
  assert.ok(!/Paid out to players/.test(code), 'the old label is gone');
  const html = v2();
  assert.ok(html.includes('<section id="soc-win" aria-label="Global player winnings" hidden></section>'),
    'the panel is at the top of Social, hidden until the server answers');
  assert.ok(html.indexOf('id="soc-win"') < html.indexOf('<h2>Top earners'), 'above the board');
  assert.ok(!html.includes('id="soc-tiles"'), 'the old tile is gone');
  // Live: asked while Social is on screen, from the server's memory; a rise counts up and shows the difference.
  assert.ok(/const WIN_POLL_MS = 1\d000;/.test(code), 'asked every 10 to 19 s');
  assert.ok(/if \(socialOnScreen\(\)\) pullWin\(\)/.test(code), 'only while Social is on screen');
  // The climb is the lobby's shared count-up (countUp.js); a drop is a correction, shown as is.
  assert.ok(/data-cu="soc-win" data-cu-rise/.test(code) && /glow\(v, from, to\)/.test(code) &&
            /classList\.add\('rise'\)/.test(code), 'a rise counts up with a +$X');
  assert.ok(/if \(to < from\) \{[^}]*textContent = usd\(to\)/.test(code), 'a correction down is shown plainly');
  assert.ok(/V2Earnings\.pull\(\)/.test(code), 'and the strip is asked to read the same number again');
  // $0.00 is the figure, not an empty state; only the off switch (or no answer) hides it.
  assert.ok(/else v\.textContent = usd\(0\)/.test(code), '$0 is drawn as $0.00');
  assert.ok(/d\.on !== true[^\n]*box\.hidden = true/.test(code.replace(/\n\s*/g, ' ')) || /box\.hidden = true; win = null; return;/.test(code),
    'hidden only when the server says off');
  // LIVE with a beating dot, for everyone (Owen's own PC has animation effects off).
  assert.ok(/\.win-live i\{[^}]*animation:lpulse/.test(html), 'the dot beats');
  assert.ok(/\.win-up\.rise\{animation:winUp/.test(html) && !/\.win-up\.go\{/.test(html), 'and the rise is not .go, the Play button');
});
