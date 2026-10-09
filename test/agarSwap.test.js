'use strict';
/* The agar.io lobby swap and the deleted old game (agario-reference/PLAN.md Phases 5 and 6,
   notes/current-agar.md section 9). Replaces test/agarPaidClosed.test.js, which pinned the old
   game's AGAR_PAID gate: that gate went with the old game's doors, and these pins say what holds
   now.

   Against the real server/index.js, booted by scripts/dev-local.js in this test's own process
   (in-memory database from scripts/memLedgerDb.js, every outbound call refused except this
   test's own localhost socket). Only the chain is stubbed (Wallet.submitStake and
   Usdc.verifyUsdcStake), the same way test/durableStakeServer.test.js does it.

   It proves:
   - the old agar doors take no money: a real paid tier token sent to them (cell:join,
     cell:respawn, spectate:join:agar) gets no answer at all (the handlers are gone), its stake row
     stays 'pending' with nothing owed, and the same token still opens the snake room of that
     price; /api/submit-stake still refuses an agar room name before anything is broadcast;
   - the lobby card's count and rows come from the NEW rooms (server/ag): a Play on /ag is one
     human on the free rung's row (ag:na:s0 in /api/live lobbies, PAID-AGAR-DESIGN.md 5.7), a
     watcher on the menu is none, and the card is the sum of the agar rows;
   - /agar and /agar.html send the browser to /ag, the old page's files are gone (404), and /ag
     serves the new page with its lobby hook;
   - the old game's server code is gone from the tree, its DB columns stay (never dropped live);
   - public/js/ag/agLobby.js: inside the lobby frame the page gets a Lobby button (game:done) while
     its menu is open, and the name box starts with the lobby name; outside a frame, no button;
     while a paid account is open the button is gone and the tab asks before closing (the exit trap);
   - switched off (AG_ENABLED=0), /ag answers a page with a way back and the card reads 0. */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const realRequest = http.request;
const realGet = http.get;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let ipSeq = 0;
function call(port, method, url, body) {
  const ip = '10.9.' + (++ipSeq >> 8) + '.' + (ipSeq & 255);
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const data = body === undefined ? '' : JSON.stringify(body);
    let out = '';
    s.on('connect', () => s.write(`${method} ${url} HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${ip}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(data)}\r\nConnection: close\r\n\r\n${data}`));
    s.on('data', (d) => { out += d; });
    s.on('end', () => {
      const head = out.split('\r\n\r\n')[0];
      const status = Number(out.split(' ')[1]);
      const loc = /\r\nlocation: ([^\r\n]*)/i.exec(head);
      let text = out.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      if (/transfer-encoding: chunked/i.test(head)) {
        let rest = text; text = '';
        for (;;) {
          const i = rest.indexOf('\r\n'); const n = parseInt(rest.slice(0, i), 16);
          if (!n) break; text += rest.slice(i + 2, i + 2 + n); rest = rest.slice(i + 2 + n + 2);
        }
      }
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      resolve({ status, json, text, location: loc ? loc[1] : null });
    });
    s.on('error', reject);
    s.setTimeout(5000, () => s.destroy(new Error('timeout')));
  });
}

const PAYER = 'AgarSwapPayer111111111111111111111111111';
let port, ledgerDb;
let landed = 0.1;
let broadcasts = 0;
const tx = (s) => Buffer.from(s).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); }
  return fn();
};

test.before(async () => {
  port = await freePort();
  process.env.DEV_LOCAL_PORT = String(port);
  delete process.env.AG_ENABLED;           // the default: agar.io open on the real law table
  delete process.env.AG_DEV_LAWS;
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    ({ ledgerDb } = require(path.join(ROOT, 'scripts', 'dev-local.js')));
  } finally {
    console.log = log; console.warn = warn;
  }
  const blockedRequest = http.request;
  const local = (a) => a && typeof a === 'object' && ['localhost', '127.0.0.1'].includes(a.hostname || a.host) && Number(a.port) === port;
  http.request = function (...a) { return local(a[0]) ? realRequest.apply(http, a) : blockedRequest.apply(http, a); };
  http.get = function (...a) { return local(a[0]) ? realGet.apply(http, a) : blockedRequest.apply(http, a); };
  const Wallet = require(path.join(ROOT, 'server', 'Wallet.js'));
  const Usdc = require(path.join(ROOT, 'server', 'Usdc.js'));
  Wallet.submitStake = async () => 'sig-' + ++broadcasts;
  Usdc.verifyUsdcStake = async () => ({ payer: PAYER, usdc: landed });
  for (let i = 0; i < 60; i++) {
    try { const r = await call(port, 'GET', '/api/live'); if (r.status === 200) return; } catch (_) {}
    await sleep(250);
  }
  throw new Error('server did not come up');
});

function connect(nsp = '') {
  const { io } = require('socket.io-client');
  const s = io(`http://127.0.0.1:${port}${nsp}`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000 });
  const got = [];
  s.onAny((ev, p) => got.push([ev, p]));
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 8000);
    s.on('connect', () => { clearTimeout(bail); res({ s, got, has: (ev) => got.find((g) => g[0] === ev), count: (ev) => got.filter((g) => g[0] === ev).length }); });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}
// Messages on one socket are handled in order, so an answered ping means everything sent before it was handled.
function handled(s) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    s.once('pong_check', () => { clearTimeout(t); resolve(true); });
    s.emit('ping_check');
  });
}

// A real tier token (the old door a hand-made agar client used), with its durable stake row.
async function tierToken(lobbyType, amount) {
  landed = amount;
  const r = await call(port, 'POST', '/api/submit-stake', { lobbyType, signedTx: tx('t' + Math.random()), walletAddress: PAYER });
  assert.strictEqual(r.status, 200, r.text);
  const sig = 'sig-' + broadcasts;
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'pending');
  return { token: r.json.entryToken, sig };
}

// The agar.io free rung's row and the card, from one /api/live response.
async function agarLive() {
  const r = await call(port, 'GET', '/api/live');
  const row = (r.json.lobbies || []).find((e) => e.id === 'ag:na:s0');
  return { row, card: r.json.counts && r.json.counts.agar, rows: (r.json.extras || []).concat(r.json.lobbies || []) };
}

const owedFor = (sig) => ledgerDb.payouts.filter((p) => p.stake_sig === sig);

test('a paid token sent to the old agar doors gets no answer and is never touched; it still opens the snake room of that price', async () => {
  for (const [type, amount] of [['dime', 0.1], ['dollar', 1]]) {
    const { token, sig } = await tierToken(type, amount);
    const a = await connect();
    a.s.emit('cell:join', { name: 'paid', lobbyType: type, entryToken: token, region: 'na', googleId: PAYER });
    a.s.emit('spectate:join:agar', { lobbyType: type, region: 'na' });
    a.s.emit('cell:respawn', { entryToken: token });
    a.s.emit('cell:cashout', {});
    assert.ok(await handled(a.s), type + ': the server handled all four');
    const agarEvents = a.got.filter((g) => /^cell:/.test(g[0]));
    assert.deepStrictEqual(agarEvents, [], type + ': the old agar doors are gone, nothing answers them');
    assert.strictEqual(ledgerDb.stakes.get(sig).state, 'pending', type + ': the stake row was never claimed');
    assert.deepStrictEqual(owedFor(sig), [], type + ': nothing owed or paid');

    // Never spent: the same token opens the snake room of that price.
    a.s.emit('play', { name: 'snk', lobbyType: type, entryToken: token, region: 'na' });
    assert.ok(await until(() => a.has('game_joined'), 6000), type + ' snake: ' + JSON.stringify(a.got.map((g) => g[0])));
    assert.strictEqual(await until(() => ledgerDb.stakes.get(sig).state === 'consumed' && 'consumed'), 'consumed');
    a.s.close();
  }
});

test('/api/submit-stake refuses an agar room name before anything is broadcast or claimed', async () => {
  const sent = broadcasts;
  const rows = ledgerDb.stakes.size;
  for (const lobbyType of ['agar_dime', 'agar_na_dollar', 'agar', 'ag_na_s0']) {
    const r = await call(port, 'POST', '/api/submit-stake', { lobbyType, signedTx: tx('agar-' + lobbyType), walletAddress: PAYER });
    assert.strictEqual(r.status, 400, lobbyType + ': ' + r.text);
    assert.match(r.json.error, /Not a paid lobby/);
  }
  assert.strictEqual(broadcasts, sent, 'nothing was broadcast');
  assert.strictEqual(ledgerDb.stakes.size, rows, 'no stake row was written');
  // Neither door takes a game: a real token is bought for a price, never "for agar". The one game field is
  // devGame (PAID-AGAR-DESIGN.md 5.7), read only on the PAPER_DEV_TOKENS branch to scope an unbacked dev token.
  const src = read('server/index.js');
  const head = src.match(/app\.post\('\/api\/submit-stake'[^\n]*\n\s*const \{([^}]*)\} = req\.body/);
  assert.ok(head, 'submit-stake destructures its body');
  assert.deepStrictEqual(head[1].split(',').map((s) => s.trim()).sort(), ['devGame', 'lobbyType', 'signedTx', 'stake', 'walletAddress']);
  assert.match(src, /const onlyGame = devGame === 'agar' \? 'agar' : 'paper';/, 'devGame only scopes a dev token');
});

test('the agar.io card and its row count the new rooms: a Play is one human, a watcher is none', async () => {
  const start = await agarLive();
  assert.ok(start.row, '/api/live carries the free rung ag:na:s0 while agar.io is open');
  assert.strictEqual(start.row.game, 'agar');
  assert.strictEqual(start.row.stake, 0, 'as a stake-0 rung, the row the lobby pins like Paper\'s');
  assert.ok(!start.rows.some((r) => r.id === 'agar:free'), 'the old extras row is gone (its bots would count twice)');
  assert.strictEqual(start.card, start.row.players + start.row.bots, 'the card is its row (humans plus bots)');
  assert.ok(start.row.bots > 0, 'the free room is filled with bots');
  const base = start.row.players;

  const w = await connect('/ag');
  assert.ok(await until(() => w.count('ag:f') > 2), 'a watcher is sent the world');
  let now = await agarLive();
  assert.strictEqual(now.row.players, base, 'a watcher on the menu is not playing');

  w.s.emit('ag:join', { name: 'swapper' });
  assert.ok(await until(async () => (await agarLive()).row.players === base + 1), 'a Play is one human on the row');
  now = await agarLive();
  assert.strictEqual(now.card, now.row.players + now.row.bots, 'and the card still equals its row');
  const total = now.rows.filter((r) => r.game === 'agar').reduce((n, r) => n + (r.players || 0) + (r.bots || 0), 0);
  assert.strictEqual(now.card, total, 'and every agar row on the board');

  w.s.close();
  assert.ok(await until(async () => (await agarLive()).row.players === base), 'the seat goes with the socket');
});

test('/agar sends the browser to the new game, the old page is gone, and /ag serves the new page', async () => {
  for (const url of ['/agar', '/agar.html']) {
    const r = await call(port, 'GET', url);
    assert.strictEqual(r.status, 302, url);
    assert.strictEqual(r.location, '/ag', url + ' goes to /ag');
  }
  for (const url of ['/js/agar.js', '/css/agar.css']) {
    assert.strictEqual((await call(port, 'GET', url)).status, 404, url + ' is gone');
  }
  const page = await call(port, 'GET', '/ag');
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /<canvas id="canvas"/);
  assert.match(page.text, /<script src="\/js\/ag\/agLobby\.js"><\/script>/, 'with its lobby hook');
  assert.ok(page.text.indexOf('agMain.js') < page.text.indexOf('agLobby.js'), 'loaded after the game boots');
  assert.strictEqual((await call(port, 'GET', '/js/ag/agLobby.js')).status, 200);
});

test('the old agar.io game is gone from the tree; what other games share stays', () => {
  for (const f of ['server/AgarRoom.js', 'server/agarLeaderboard.js', 'public/agar.html', 'public/js/agar.js',
                   'public/css/agar.css', 'test/agarRoom.test.js', 'test/agarPaidClosed.test.js']) {
    assert.ok(!fs.existsSync(path.join(ROOT, f)), f + ' is deleted');
  }
  // Shared pieces the old game also used are still here for the games that use them.
  for (const f of ['server/SpatialGrid.js', 'server/CollusionMonitor.js', 'public/css/cashout.css',
                   'public/js/cashoutSound.js', 'public/img/games/agar.png', 'public/img/games/agar-wide.png']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' stays');
  }
  const src = read('server/index.js');
  // Code, not the comments that say what went (assert.ok, so a failure never prints the whole file).
  for (const gone of [/require\('\.\/AgarRoom'\)/, /\bagarRooms\b/, /const AGAR_PAID\b/, /getAgarRoomForType/,
                      /on\('cell:/, /on\('spectate:join:agar'/, /_agarRoom/, /totalAgarInGame/,
                      /agarPlayerCount:/, /recordAgarGameResult\(/]) {
    assert.ok(!gone.test(src), 'server/index.js still has ' + gone);
  }
  // The DB keeps the old columns (a column is never dropped in a live push); only the writer goes.
  const db = read('server/db.js');
  assert.ok(/ADD COLUMN IF NOT EXISTS agar_high_score/.test(db), 'the old columns stay');
  assert.ok(!/async function recordAgarGameResult/.test(db), 'the old writer is gone');
  assert.ok(!/recordAgarGameResult/.test(read('scripts/dev-local.js')), 'and its dev stub');
  // Nothing in the lobby or the widget still opens the old page.
  for (const f of ['public/v2.html', 'public/js/v2/play.js', 'public/js/v2/board.js', 'wallet-widget/src/main.jsx',
                   'public/wallet/widget.js']) {
    assert.ok(!/agar\.html|js\/agar\.js/.test(read(f)), f + ' still names the old page');
  }
});

test('the widget stakes agar.io by rung only: launch and Play again refuse a tier name before any quote', () => {
  /* agar.io's rooms are rungs (Free, $0.10, $1.00; PAID-AGAR-DESIGN.md 7), so the widget no longer
     refuses a paid agar buy-in; it refuses only a tier name (dime, dollar), which names no agar room
     and would buy a stake no agar door can seat. Both the lobby's launch and the in-game Play again
     (duel:restake through the bridge) run that check before stakeOnly, so nothing is quoted. */
  const src = read('wallet-widget/src/main.jsx');
  assert.ok(!/agar\.io is free to play/.test(src), 'the old "Free only" refusals are gone');
  const at = src.indexOf('async function stakeAndPlay(');
  const launch = src.slice(at, src.indexOf('await stakeOnly(', at));
  assert.ok(/refuseAgarTier\(game, sel\);/.test(launch), 'the launch checks before staking');
  const bridge = src.slice(src.indexOf('restakeRef.current = createRestakeBridge('));
  const stakeStep = bridge.slice(bridge.indexOf('stake: async (req, hooks) => {'), bridge.indexOf('await stakeOnly('));
  assert.ok(/refuseAgarTier\(req\.game, req\.sel\);/.test(stakeStep), 'and so does Play again');
  const fn = src.slice(src.indexOf('function refuseAgarTier('), at);
  assert.ok(/if \(game !== 'agar'\) return;/.test(fn) && /!byStake && spec\.lobbyType !== 'free'/.test(fn),
    'only an agar tier other than free is refused; a rung (Free included) and every other game pass');
  /* The deploy does not build (deploy.yml): the bundle that ships must carry the same code. */
  const bundle = read('public/wallet/widget.js');
  assert.ok(bundle.includes('That agar.io table does not exist'), 'the built bundle carries the tier refusal');
  assert.ok(!bundle.includes('agar.io is free to play'), 'and not the old Free-only refusal');
});

/* public/js/ag/agLobby.js in a small fake page. */
function fakePage({ framed, session = {}, local = {}, coarse = false, nick = '' }) {
  const els = {};
  const posted = [];
  function node(tag) {
    const n = {
      tagName: tag.toUpperCase(), id: '', type: '', value: '', hidden: false, textContent: '', innerHTML: '',
      children: [], attrs: {}, listeners: {},
      classList: {
        set: new Set(),
        toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); },
        contains(c) { return this.set.has(c); },
        add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); },
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { this.children.push(c); if (c.id) els[c.id] = c; return c; },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      click() { (this.listeners.click || []).forEach((fn) => fn({ preventDefault() {} })); },
    };
    return n;
  }
  const menu = node('div'); menu.id = 'ag-menu'; els['ag-menu'] = menu;
  const box = node('input'); box.id = 'ag-nick'; box.value = nick; els['ag-nick'] = box;
  const observers = [];
  const doc = {
    readyState: 'complete',
    head: node('head'), body: node('body'),
    getElementById: (id) => els[id] || null,
    createElement: (t) => node(t),
    addEventListener() {},
  };
  const store = (o) => ({ getItem: (k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null) });
  const win = {
    document: doc,
    sessionStorage: store(session), localStorage: store(local),
    matchMedia: () => ({ matches: coarse, addEventListener() {} }),
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} },
  };
  win.parent = framed ? { postMessage: (m, o) => posted.push([m, o]) } : win;
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('public/js/ag/agLobby.js'), win, { filename: 'agLobby.js' });
  const notify = () => observers.forEach((o) => o.fn());
  return { win, els, posted, box, menu, notify, btn: () => els['ag-lobby'] };
}

test('inside the lobby frame: a Lobby button while the menu is open, game:done on click, the lobby name in the box', () => {
  const p = fakePage({ framed: true, session: { playerName: 'OwenTheVeryLongName' } });
  assert.strictEqual(p.box.value, 'OwenTheVeryLong', 'the lobby name, cut to the box\'s 15 characters');
  const btn = p.btn();
  assert.ok(btn, 'the button is there');
  assert.ok(btn.classList.contains('on'), 'shown while the menu is open');
  p.menu.hidden = true; p.notify();
  assert.ok(!btn.classList.contains('on'), 'hidden while playing on a mouse screen');
  p.menu.hidden = false; p.notify();
  assert.ok(btn.classList.contains('on'), 'back with the Esc menu or the Match Results panel');
  btn.click();
  assert.deepStrictEqual(p.posted, [['game:done', '*']], 'the message every game page sends to go back');

  // A touch screen has no Esc: the button stays up during play.
  const t = fakePage({ framed: true, coarse: true });
  t.menu.hidden = true; t.notify();
  assert.ok(t.btn().classList.contains('on'));

  // A name already typed is kept; with no hand-off the lobby's own stored name is used.
  assert.strictEqual(fakePage({ framed: true, session: { playerName: 'Lobby' }, nick: 'typed' }).box.value, 'typed');
  assert.strictEqual(fakePage({ framed: true, local: { duelseries_playername: 'Stored' } }).box.value, 'Stored');
});

test('opened on its own (not in the lobby), the page has no Lobby button', () => {
  const p = fakePage({ framed: false, session: { playerName: 'Solo' } });
  assert.strictEqual(p.btn(), undefined, 'there is no lobby to go back to');
  assert.strictEqual(p.box.value, 'Solo', 'the name still fills in');
});

/* agar.io switched off (AG_ENABLED=0) on a real server of its own: the lobby card still opens /ag in
   its full-screen frame, so the answer has to be a page with a way back, not bare text; and the
   card reads 0 with no row, rather than a guess. */
test('agar.io switched off: /ag answers a page with a way back to the lobby, and the card reads 0', { timeout: 60000 }, async () => {
  const { spawn } = require('child_process');
  const p2 = await freePort();
  const env = Object.assign({}, process.env, { DEV_LOCAL_PORT: String(p2), AG_ENABLED: '0' });
  delete env.AG_DEV_LAWS;
  const srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-local.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try { up = (await call(p2, 'GET', '/api/live')).status === 200; } catch (_) {}
      if (!up) await sleep(250);
    }
    assert.ok(up, 'the second server came up:\n' + out.slice(-800));
    const r = await call(p2, 'GET', '/ag');
    assert.strictEqual(r.status, 503);
    assert.match(r.text, /agar\.io is not open right now/);
    assert.match(r.text, /Back to the lobby/);
    const script = r.text.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(script, 'it carries its button script');
    assert.doesNotThrow(() => new Function(script[1]), 'which parses');
    assert.match(script[1], /postMessage\("game:done","\*"\)/, 'and sends the lobby the message every game sends');
    assert.strictEqual((await call(p2, 'GET', '/agar')).location, '/ag', '/agar still points at it');
    const live = (await call(p2, 'GET', '/api/live')).json;
    assert.ok(!(live.extras || []).concat(live.lobbies || []).some((e) => e.game === 'agar'), 'no agar row while it is closed');
    assert.strictEqual(live.counts.agar, 0, 'and the card reads 0');
  } finally {
    srv.kill();
  }
});
