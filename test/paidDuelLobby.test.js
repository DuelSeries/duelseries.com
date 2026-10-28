'use strict';
/* The lobby's $0.50 and $1 for the eight paid duels (Owen 2026-10-28: "with money reviews"). The lobby only says
   which rung; the wallet widget stakes it (stakeAndPlay), the server mints the entry, and launchStaked opens the
   game's page with it, the same stake an in-game Play again buys. These run the real board.js, play.js and the
   widget's launch code on one stub window (test/v2LobbyHarness.js), and the real startFromDetail cut from
   v2.html. The money on the server side is proved in test/rungFiftyMoney.test.js (the lobby path block). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { lobbyHarness } = require('./v2LobbyHarness.js');

const ROOT = path.join(__dirname, '..');
const plain = (x) => JSON.parse(JSON.stringify(x));   // across the vm realm
const PAGES = { knockout: '/knockout', battleship: '/battleship', swim: '/swim', headsoccer: '/headsoccer',
  pool8: '/pool8', airhockey: '/airhockey', rooftop: '/rooftop', crossy: '/crossy' };
const DUELS = Object.keys(PAGES);
const ALL_OPEN = Object.fromEntries(DUELS.map((g) => [g, true]));
const staked = (h) => h.fetched.filter((u) => /stake/.test(u));

test('every paid duel rung goes to the wallet widget, quoted on this origin even with EU picked', async () => {
  for (const game of DUELS) {
    for (const stake of [0.5, 1]) {
      const h = lobbyHarness([], { paidDoors: ALL_OPEN });
      await h.win.V2Board.load();
      h.win.localStorage.setItem('duelseries_region', 'eu');
      h.win.V2Play.launch(game, { stake });
      assert.deepStrictEqual(plain(h.plays), [{ game, sel: { stake } }], game + ' $' + stake + ': the rung, never a tier');
      await assert.rejects(h.pending(), /no server here/, 'the stub server refuses the quote');
      assert.deepStrictEqual(staked(h), ['/api/stake-quote?stake=' + stake], game + ' is quoted by the server its page joins');
      assert.strictEqual(h.el('game-frame').src, '', 'and no page opened without a stake');
    }
  }
});

test('a paid duel rung asks for no money while its door is shut, unknown or off the ladder', async () => {
  const cases = [
    ['no paidDoors in the answer', [], undefined, 0.5],
    ['the board failed', null, ALL_OPEN, 0.5],
    ['the owner shut the door', [], Object.assign({}, ALL_OPEN, { knockout: false }), 0.5],
    ['a door that is not a real true', [], Object.assign({}, ALL_OPEN, { knockout: 'true' }), 0.5],
    ['another game\'s door', [], { battleship: true }, 0.5],
    ['the retired $0.10', [], ALL_OPEN, 0.1],
    ['a rung the ladder does not have', [], ALL_OPEN, 2],
    ['a near miss', [], ALL_OPEN, 0.51],
  ];
  for (const [why, rows, doors, stake] of cases) {
    const h = lobbyHarness(rows, doors ? { paidDoors: doors } : undefined);
    await h.win.V2Board.load();
    h.win.V2Play.launch('knockout', { stake });
    assert.deepStrictEqual(plain(h.plays), [], why + ': the widget is never asked');
    assert.deepStrictEqual(staked(h), [], why + ': no quote');
    assert.strictEqual(h.el('game-frame').src, '', why + ': no page');
  }
  // Not a number is not a stake: no money asked (the free page, if anything).
  const nan = lobbyHarness([], { paidDoors: ALL_OPEN });
  await nan.win.V2Board.load();
  nan.win.V2Play.launch('knockout', { stake: 'abc' });
  assert.deepStrictEqual([plain(nan.plays), staked(nan), nan.win.sessionStorage.getItem('entryToken')], [[], [], null], 'not a number');
  // An own page with no money in it is never staked for, whatever the board says.
  for (const game of ['tanks', 'omgshooter']) {
    const h = lobbyHarness([], { paidDoors: Object.assign({ tanks: true, omgshooter: true }, ALL_OPEN) });
    await h.win.V2Board.load();
    h.win.V2Play.launch(game, { stake: 0.5 });
    assert.deepStrictEqual([plain(h.plays), staked(h), h.el('game-frame').src], [[], [], ''], game);
  }
});

test('signed out, a paid duel rung asks to sign in and stakes nothing', async () => {
  for (const game of DUELS) {
    const h = lobbyHarness([], { paidDoors: ALL_OPEN });
    await h.win.V2Board.load();
    h.win.duelWallet = { authenticated: false };
    let asked = 0;
    h.win.duelWalletLogin = () => { asked++; };
    h.win.V2Play.launch(game, { stake: 0.5 });
    assert.deepStrictEqual([plain(h.plays), staked(h), h.el('game-frame').src, asked], [[], [], '', 1], game);
  }
});

test('a paid round opens its own page with the entry, and a Free click after it carries no entry', async () => {
  for (const game of DUELS) {
    const h = lobbyHarness([], { paidDoors: ALL_OPEN });
    await h.win.V2Board.load();
    const ss = h.win.sessionStorage;
    h.win.localStorage.setItem('duelseries_playername', 'Tester');
    // What the widget does once the stake is verified: the server's rung and token, then the page.
    h.win.launchStaked(game, { stake: 0.5 }, { entryToken: 'TOK-' + game, worth: 0.5, stake: 0.5, region: null },
      { address: 'WALLET1' }, () => {});
    assert.deepStrictEqual([h.el('game-frame').src, h.el('game-frame').style.display], [PAGES[game], 'block'], game);
    assert.deepStrictEqual([ss.getItem('stake'), ss.getItem('entryToken'), ss.getItem('lobbyType')], ['0.5', 'TOK-' + game, null],
      game + ': the page reads the server\'s rung and its one-time entry');
    // The page closed before it queued (its token is still in the tab), and the lobby cleared the frame.
    h.el('game-frame').style.display = 'none';
    h.el('game-frame').src = '';
    h.win.V2Play.launch(game, { lobbyType: 'free' });
    assert.strictEqual(h.el('game-frame').src, PAGES[game], game + ' Free opens its own page');
    assert.deepStrictEqual([ss.getItem('stake'), ss.getItem('entryToken'), ss.getItem('entrySol')], [null, null, null],
      game + ' Free: no buy-in and no entry left for the page to spend');
    assert.deepStrictEqual(plain(h.plays), [], 'Free never goes to the widget');
  }
});

test('a Free duel after a paid one is remembered as Free, so no card comes back on a paid rung', async () => {
  for (const game of DUELS) {
    const h = lobbyHarness([], { paidDoors: ALL_OPEN });
    await h.win.V2Board.load();
    const kept = [];
    h.win.rememberStake = (v) => kept.push(v);
    h.win.V2Play.launch(game, { stake: 1 });
    await assert.rejects(h.pending(), /no server here/);
    h.win.V2Play.launch(game, { lobbyType: 'free' });
    assert.deepStrictEqual(kept, [1, 0], game + ': $1, then Free, leaves Free remembered');
  }
});

/* startFromDetail, cut from v2.html as the page runs it, against a stub launch. */
async function detail(cur, STEPS, si, off, between) {
  const html = fs.readFileSync(path.join(ROOT, 'public/v2.html'), 'utf8');
  const a = html.indexOf('function startFromDetail(){');
  const b = html.indexOf('/* Spectate: the table at the chosen rung');
  assert.ok(a > -1 && b > a, 'startFromDetail is where this test cuts it');
  const calls = [];
  let loads = 0;
  const detailEl = { id: 'detail', shown: true };
  const win = { cur, STEPS, si, STEPS_OFF: new Set(off),
    document: { getElementById: (x) => (x === 'detail' ? detailEl : null) },
    screenShown: (el) => !!(el && el.shown),
    V2Play: { launch: (g, sel) => calls.push([g, sel]), playChosen: () => calls.push(['chosen']) },
    V2Board: { load: async () => { loads++; } } };
  win.window = win;
  vm.createContext(win);
  vm.runInContext('var cur=this.cur,STEPS=this.STEPS,si=this.si,STEPS_OFF=this.STEPS_OFF,V2Play=this.V2Play,V2Board=this.V2Board;\n' +
    html.slice(a, b) + '\nthis.set=(k,v)=>{if(k==="si")si=v;else cur=v};startFromDetail();', win);
  const set = (k, v) => (k === 'back' ? (detailEl.shown = false) : win.set(k, v));
  if (between) between(set);             // the player moves (or goes Back) before the fresh board answers
  await new Promise((r) => setTimeout(r, 0));
  return { calls: plain(calls), loads };
}

test('Play on a paid duel\'s open rung stakes that rung after a fresh board; Free, a shut rung and the free-only games stay free', async () => {
  const ko = { id: 'knockout', duel: 1, built: 1, paid: 1 };
  assert.deepStrictEqual(await detail(ko, [0, 0.5, 1], 1, []), { calls: [['knockout', { stake: 0.5 }]], loads: 1 }, '$0.50, doors read first');
  assert.deepStrictEqual(await detail(ko, [0, 0.5, 1], 2, []), { calls: [['knockout', { stake: 1 }]], loads: 1 }, '$1');
  assert.deepStrictEqual((await detail(ko, [0, 0.5, 1], 0, [])).calls, [['knockout', { lobbyType: 'free' }]], 'Free');
  assert.deepStrictEqual(await detail(ko, [0, 0.5, 1], 1, [0.5, 1]), { calls: [], loads: 0 }, 'a struck rung starts nothing');
  assert.deepStrictEqual((await detail(ko, [0, 0.5, 1], 2, [], (set) => set('si', 1))).calls, [],
    'the rung changed before the board answered: the $1 is not staked');
  assert.deepStrictEqual((await detail(ko, [0, 0.5, 1], 2, [], (set) => set('cur', { id: 'battleship', duel: 1, built: 1, paid: 1 }))).calls, [],
    'another card opened before the board answered: nothing staked');
  assert.deepStrictEqual((await detail(ko, [0, 0.5, 1], 1, [], (set) => set('back'))).calls, [],
    'Back to home before the board answered: nothing staked');
  const tanks = { id: 'tanks', duel: 1, built: 1, freeOnly: 1 };
  assert.deepStrictEqual((await detail(tanks, [0, 0.5, 1], 1, [])).calls, [['tanks', { lobbyType: 'free' }]], 'a free-only duel is Free');
  assert.deepStrictEqual((await detail({ id: 'snake', ladder: 1 }, [0, 0.5, 1], 1, [])).calls, [['chosen']], 'the arenas keep their own path');
  assert.deepStrictEqual((await detail({ id: 'stumble', soon: 1 }, [0, 0.5, 1], 1, [])).calls, [], 'a game that is not open starts nothing');
});

test('the eight paid duels are the lobby\'s paid:1 duels, and each one has a page the widget opens', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/v2.html'), 'utf8');
  const paid = [...html.matchAll(/\{id:'(\w+)'[^\n]*duel:1[^\n]*paid:1/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(paid, DUELS.slice().sort());
  const play = fs.readFileSync(path.join(ROOT, 'public/js/v2/play.js'), 'utf8');
  const listed = play.match(/const PAID_DUELS = \{([^}]*)\}/)[1].match(/\w+(?=:)/g).sort();
  assert.deepStrictEqual(listed, DUELS.slice().sort(), 'play.js gates the same eight');
  const widget = fs.readFileSync(path.join(ROOT, 'wallet-widget/src/main.jsx'), 'utf8');
  for (const g of DUELS) assert.ok(new RegExp(g + ": '" + PAGES[g] + "'").test(widget), 'the widget opens ' + PAGES[g]);
  // The bundle the lobby actually loads carries the same page map (it is committed, not built on the server).
  const bundle = fs.readFileSync(path.join(ROOT, 'public/wallet/widget.js'), 'utf8');
  for (const g of DUELS) assert.ok(new RegExp(g + ':["`\']' + PAGES[g] + '["`\']').test(bundle), 'the shipped bundle opens ' + PAGES[g]);
});
