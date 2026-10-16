'use strict';
// The player's name sticks (Owen, 2026-10-15: "my name resets after relaunching"). Reproduced in headless Chrome
// before this fix, signed in and out, phone and PC:
//   1. a name typed in the game screen's field and not confirmed with the tick (tapped away, app closed) was never
//      written anywhere, so the next launch showed the old one;
//   2. signed in, a typed name the account had not taken (Play pushes it without waiting; a taken name, a login not
//      ready yet, no network) was overwritten on the next launch by the account's older name (pullName);
//   3. Knockout, Battleship, Bowmasters, Awesome Tanks, the old snake page and Paper read the name from this tab's
//      launch hand-off only, so a page opened any other way said "Player";
//   4. every payout rewrote the account's name with the in-game name, 'Player' when the game had none, which the
//      next launch then pulled into the lobby.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PLAY = fs.readFileSync(path.join(ROOT, 'public/js/v2/play.js'), 'utf8');

function store(seed) {
  const m = new Map(Object.entries(seed || {}));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k), dump: () => Object.fromEntries(m) };
}

/* play.js on a stub page. server: { name, taken: [names], fail: reason } stands in for /api/my-profile and
   /api/my-name. local: the device's localStorage (shared across "launches"). */
function page({ local, server, signedIn = true }) {
  const els = {};
  const el = id => (els[id] = els[id] || {
    id, value: '', hidden: false, readOnly: true, textContent: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} }, offsetParent: {},
    addEventListener() {}, focus() {}, blur() {}, select() {}, setAttribute() {}, appendChild() {},
  });
  el('name-act').dataset.state = 'idle';
  const docOn = {};
  const winOn = {};
  const toasts = [];
  const posts = [];
  const win = {
    console, setTimeout, clearTimeout,
    localStorage: local, sessionStorage: store(),
    document: {
      getElementById: el,
      addEventListener(t, fn) { (docOn[t] = docOn[t] || []).push(fn); },
      body: { classList: { add() {}, remove() {} } },
      activeElement: null,
    },
    addEventListener(t, fn) { (winOn[t] = winOn[t] || []).push(fn); },
    dispatchEvent() { return true; },
    MutationObserver: class { observe() {} },
    DSToast: { line: (t) => toasts.push(t), show: (o) => toasts.push(o.title) },
    duelWallet: signedIn ? { authenticated: true, address: 'W1' } : { authenticated: false, address: null },
    duelWalletSignName: async () => ({ wallet: 'W1', ts: 1, sig: 'x' }),
    fetch: async (url, o) => {
      url = String(url);
      if (url.startsWith('/api/my-profile')) return { ok: true, json: async () => ({ name: server.name }) };
      if (url === '/api/my-name') {
        const n = JSON.parse(o.body).name;
        posts.push(n);
        if (server.fail) return { ok: false, status: 401, json: async () => ({ reason: server.fail }) };
        if ((server.taken || []).includes(n)) return { ok: false, status: 409, json: async () => ({}) };
        server.name = n;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      throw new Error('no server for ' + url);
    },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(PLAY, win, { filename: 'play.js' });
  (docOn.DOMContentLoaded || []).forEach(fn => fn());
  const fire = (t, target, extra) => (docOn[t] || []).forEach(fn => fn(Object.assign({ target, preventDefault() {} }, extra)));
  return {
    win, el, toasts, posts, server,
    type(v) { const i = el('play-name'); i.value = v; fire('input', i); },
    blur() { fire('blur', el('play-name')); },
    key(k) { fire('keydown', el('play-name'), { key: k }); },
    launch: async () => { for (const fn of winOn['duelwallet:change'] || []) await fn(); await new Promise(r => setTimeout(r, 0)); },
  };
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('a name typed and never confirmed is still there on the next launch (signed out)', async () => {
  const local = store();
  const a = page({ local, server: { name: null }, signedIn: false });
  a.win.V2Play.nameEdit();
  a.type('Owen77');
  // the app is closed here: no tick, no blur
  const b = page({ local, server: { name: null }, signedIn: false });
  assert.strictEqual(b.el('play-name').value, 'Owen77');
});

test('signed in: a typed name the account has not taken is pushed on the next launch, not overwritten', async () => {
  const local = store({ duelseries_playername: 'Owenkkk' });
  const server = { name: 'Owenkkk' };
  const a = page({ local, server: Object.assign(server, { fail: 'bad-token' }) });
  a.win.V2Play.nameEdit();
  a.type('NewName');
  a.blur();                                   // commits, but the login is not ready: the push fails
  await tick(); await tick();
  assert.strictEqual(server.name, 'Owenkkk');
  delete server.fail;
  const b = page({ local, server });          // relaunch
  await b.launch();
  assert.strictEqual(b.el('play-name').value, 'NewName', 'the typed name, not the account\'s older one');
  assert.strictEqual(server.name, 'NewName', 'and the account took it');
  const c = page({ local, server });          // and again: nothing left to push
  await c.launch();
  assert.strictEqual(c.el('play-name').value, 'NewName');
  assert.deepStrictEqual(c.posts, []);
});

test('signed in: a typed name that is taken falls back to the account\'s name and says why', async () => {
  const local = store({ duelseries_playername: 'Owenkkk' });
  const server = { name: 'Owenkkk', taken: ['Owen'] };
  const a = page({ local, server });
  a.win.V2Play.nameEdit();
  a.type('Owen');
  const b = page({ local, server });
  await b.launch();
  assert.strictEqual(b.el('play-name').value, 'Owenkkk');
  assert.ok(b.toasts.some(t => /taken/i.test(t)), 'told the name is taken: ' + JSON.stringify(b.toasts));
  const c = page({ local, server });
  await c.launch();
  assert.deepStrictEqual(c.posts, [], 'the refused name is not pushed again');
});

test('the account\'s name still wins over a name this device never typed (another device renamed it)', async () => {
  const local = store({ duelseries_playername: 'OldName' });
  const p = page({ local, server: { name: 'FromPhone' } });
  await p.launch();
  assert.strictEqual(p.el('play-name').value, 'FromPhone');
  assert.deepStrictEqual(p.posts, []);
});

test('blur commits the open field; Escape puts the name back; a launch never overwrites the field mid-edit', async () => {
  const local = store({ duelseries_playername: 'Owenkkk' });
  const server = { name: 'Owenkkk' };
  const p = page({ local, server });
  p.win.V2Play.nameEdit();
  p.type('Typed1');
  await p.launch();                            // a wallet change mid-edit
  assert.strictEqual(p.el('play-name').value, 'Typed1', 'not overwritten while editing');
  assert.deepStrictEqual(p.posts, [], 'nor pushed half typed');
  p.blur();
  await tick(); await tick();
  assert.deepStrictEqual(p.posts, ['Typed1']);
  assert.strictEqual(server.name, 'Typed1');
  p.el('name-act').dataset.state = 'idle';
  p.win.V2Play.nameEdit();
  p.type('Oops');
  p.key('Escape');
  assert.strictEqual(p.el('play-name').value, 'Typed1');
  assert.strictEqual(local.getItem('duelseries_playername'), 'Typed1');
  const q = page({ local, server });
  await q.launch();
  assert.deepStrictEqual(q.posts, [], 'an escaped edit leaves nothing to push');
});

test('every game page falls back to the lobby\'s saved name before "Player"', () => {
  const pages = {
    'public/js/knockout.js': /sessionStorage\.getItem\('playerName'\) \|\| localStorage\.getItem\('duelseries_playername'\) \|\| 'Player'/,
    'public/js/battleship.js': /sessionStorage\.getItem\('playerName'\) \|\| localStorage\.getItem\('duelseries_playername'\) \|\| 'Player'/,
    'public/js/tanks.js': /sessionStorage\.getItem\('playerName'\) \|\| localStorage\.getItem\('duelseries_playername'\) \|\| 'Player'/,
    'public/js/shooter.js': /sessionStorage\.getItem\('playerName'\) \|\| localStorage\.getItem\('duelseries_playername'\)/,
    'public/js/game.js': /sessionStorage\.getItem\('playerName'\)\s+\|\| localStorage\.getItem\('duelseries_playername'\) \|\| 'Player'/,
    'public/js/paper/mp/paperArenaMain.js': /storageGet\('sessionStorage', 'playerName'\) \|\| storageGet\('localStorage', 'duelseries_playername'\)/,
  };
  for (const [f, re] of Object.entries(pages)) assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), re, f);
});

test('a payout never renames an account that has a name (only a nameless or "Player" one)', async () => {
  const db = require(path.join(ROOT, 'server/db.js'));
  const sent = [];
  const real = db.pool.query;
  db.pool.query = async (sql, params) => { sent.push({ sql, params }); return { rows: [], rowCount: 1 }; };
  try {
    await db.recordEarnings('W1', 'Player', 1.5, 0);
  } finally {
    db.pool.query = real;
  }
  const up = sent[0].sql.replace(/\s+/g, ' ');
  assert.match(up, /ON CONFLICT \(google_id\) DO UPDATE SET total_earnings = COALESCE\(accounts\.total_earnings, 0\) \+ \$3,/);
  assert.match(up, /name = CASE WHEN accounts\.name IS NULL OR accounts\.name = '' OR accounts\.name = 'Player' THEN \$2 ELSE accounts\.name END/);
  assert.doesNotMatch(up, /, name = \$2/);
});
