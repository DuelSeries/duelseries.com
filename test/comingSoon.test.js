'use strict';
// Coming soon (server/comingSoon.js, Owen 2026-10-30): agar.io and Battleship off the lobby on one switch in Control.
//   - the switch: Coming soon with no file, saved across a restart, a bad file fails CLOSED, other games refused
//   - agar.io's directory: the free room stops being held awake, the owner's paid bots leave with their seed back to
//     the Bot bank and none spawn; Live again wakes the free room
//   - agar.io's sockets: a new page is refused 'soon' and never seated (nothing wakes the free room), a new free life
//     and a new watcher are refused, a seated free player who died keeps watching, a paid resume still connects
//   - the lobby: DS_SOON locks the card like shared/lockedGames.js and the play path refuses it, live list included
//   - /play/<game> goes to the lobby while Coming soon
// The paid door's refund ('not-open') and a seated player's resume are in agPaidDoor.test.js; the real server's
// routes, /api/live and the Battleship queue in comingSoonServer.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createComingSoon, GAMES, DEFAULT_SOON } = require('../server/comingSoon');
const { AgArenas } = require('../server/ag/agArenas');
const { attachAgSockets } = require('../server/ag/agSockets');
const { createBotBank } = require('../server/botBank');
const { playRoute } = require('../server/sharePreview');
const { FIXTURE } = require('./agLawsFixture');

const ROOT = path.join(__dirname, '..');
const noop = () => {};
const quiet = { log: noop, warn: noop, error: noop };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soon-')), 'coming-soon.json');

test('the switch: agar.io and Battleship are Coming soon with no file; a change is saved and read back at boot', () => {
  assert.deepStrictEqual(Object.keys(GAMES).sort(), ['agar', 'battleship']);
  assert.deepStrictEqual([...DEFAULT_SOON].sort(), ['agar', 'battleship']);
  const file = tmp();
  const s = createComingSoon({ file, log: quiet });
  assert.deepStrictEqual(s.list().sort(), ['agar', 'battleship']);
  assert.ok(s.isSoon('agar') && s.isSoon('battleship') && !s.isSoon('snake') && !s.isSoon('knockout'));
  assert.strictEqual(s.saved(), false);
  assert.deepStrictEqual(s.set('agar', false), { ok: true, why: null, changed: true });
  assert.ok(!s.isSoon('agar') && s.isSoon('battleship'));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).soon, { agar: false, battleship: true });
  // a restart reads it back
  const again = createComingSoon({ file, log: quiet });
  assert.deepStrictEqual(again.list(), ['battleship']);
  assert.strictEqual(again.set('battleship', true).changed, false, 'already on');
  assert.strictEqual(again.set('agar', true).changed, true);
  assert.deepStrictEqual(createComingSoon({ file, log: quiet }).list().sort(), ['agar', 'battleship']);
  // a game without its gates wired has no switch
  assert.deepStrictEqual(again.set('snake', true), { ok: false, why: 'That game has no Coming soon switch', changed: false });
  assert.ok(!again.isSoon('snake'));
  assert.strictEqual(again.nameOf('agar'), 'agar.io');
  assert.strictEqual(again.nameOf('battleship'), 'Battleship');
});

test('the switch fails CLOSED: a file that is not a switch, or cannot be read, keeps every game Coming soon', () => {
  const errors = [];
  const log = { log: noop, warn: noop, error: (m) => errors.push(m) };
  const file = tmp();
  fs.writeFileSync(file, '{"soon": {"agar": false, "battleship": false}');   // cut short
  assert.deepStrictEqual(createComingSoon({ file, log }).list().sort(), ['agar', 'battleship']);
  fs.writeFileSync(file, '[]');
  assert.deepStrictEqual(createComingSoon({ file, log }).list().sort(), ['agar', 'battleship']);
  const throwing = { existsSync: () => true, readFileSync: () => { throw new Error('EACCES'); } };
  assert.deepStrictEqual(createComingSoon({ file, fsx: throwing, log }).list().sort(), ['agar', 'battleship']);
  assert.strictEqual(errors.length, 3);
  // a save that fails changes nothing in memory
  const ro = { existsSync: () => false, readFileSync: noop, mkdirSync: noop, writeFileSync: () => { throw new Error('EROFS'); } };
  const s = createComingSoon({ file, fsx: ro, log });
  assert.strictEqual(s.set('agar', false).ok, false);
  assert.ok(s.isSoon('agar'), 'still Coming soon: the file and the switch never disagree');
});

function paidRig(fundUsd) {
  const mem = { obj: null };
  const bank = createBotBank({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soonbank-')), 'b.json'), log: quiet });
  bank.credit(fundUsd * 1e6, 'SIG' + Math.random());
  bank.setCap(50 * 1e6);
  const arenas = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 5, log: quiet, paid: true,
    botStore: { load: () => mem.obj, save: (o) => { mem.obj = o; return true; } }, botBank: bank,
    moneyHooks: { onCashout: noop, onRefund: noop, onTransfer: noop, onFeed: noop, onBreach: noop, onStake: noop,
      onHouse: noop, onOwed: noop } });
  return { arenas, bank, mem };
}

test('agar.io Coming soon: the free room sleeps, paid bots pause with every seed back to the bank, Live brings them back', () => {
  const { arenas, bank, mem } = paidRig(5);
  assert.strictEqual(arenas.keepAwake(), true);
  const free0 = arenas.rooms.find((r) => r.index === 0);
  assert.strictEqual(free0.awake, true);
  assert.strictEqual(arenas.setBotTarget(0.5, 2).live, 2);
  assert.strictEqual(arenas.setBotTarget(1, 1).live, 1);
  assert.strictEqual(bank.balanceMicro(), 3000000, '$2 of seed out');
  const r = arenas.setSoon(true);
  assert.deepStrictEqual(r, { botsLeft: 0, why: null });
  assert.strictEqual(arenas.soon, true);
  assert.strictEqual(free0.awake, false, 'the free room is no longer held awake');
  assert.strictEqual(arenas.awake, false, 'and the sweep does not wake it again');
  assert.strictEqual(arenas.botCount(0.5) + arenas.botCount(1), 0);
  assert.strictEqual(bank.balanceMicro(), 5000000, 'every seed back in the bank');
  assert.deepStrictEqual(mem.obj, { 0.5: 2, 1: 1 }, 'the counts are held, saved for a restart too');
  assert.match(arenas.setBotTarget(0.5, 1).why, /Coming soon/);
  assert.strictEqual(arenas.botCount(0.5), 0);
  arenas.startBots();
  assert.strictEqual(arenas.botCount(0.5), 0, 'a boot while Coming soon spawns none');
  assert.strictEqual(arenas.keepAwake(), false, 'and does not wake the free room');
  assert.ok(arenas.boardRows().filter((x) => x.stake > 0).every((x) => x.state === 'closed'), 'paid rows say closed');
  arenas.sweep(Date.now());
  assert.strictEqual(free0.awake, false);
  assert.deepStrictEqual(mem.obj, { 0.5: 2, 1: 1 }, 'the sweep keeps the held counts');
  // Owen's 0 while paused is kept: none come back at that rung
  assert.strictEqual(arenas.setBotTarget(1, 0).ok, true);
  assert.deepStrictEqual(mem.obj, { 0.5: 2 });
  // Live again: the free room wakes and the held paid bots come back, funded from the bank
  arenas.setSoon(false);
  assert.strictEqual(arenas.soon, false);
  assert.strictEqual(free0.awake, true);
  assert.strictEqual(arenas.botCount(0.5), 2);
  assert.strictEqual(arenas.botCount(1), 0);
  assert.strictEqual(bank.balanceMicro(), 4000000);
  assert.deepStrictEqual(mem.obj, { 0.5: 2 });
  assert.strictEqual(arenas.setBotTarget(0.5, 1).live, 1);
  assert.ok(arenas.boardRows().filter((x) => x.stake > 0).every((x) => x.state === 'open'));
});

test('agar.io Coming soon set at boot: no paid bot spawns, no seed moves, and the saved counts survive until Live', () => {
  const { arenas, bank, mem } = paidRig(5);
  mem.obj = { 0.5: 3 };
  arenas.botTargets.set(0.5, 3);   // the saved count, as the store loads it
  arenas.setSoon(true);            // what agBoot does before startBots
  arenas.startBots();
  assert.strictEqual(arenas.botCount(0.5), 0);
  assert.strictEqual(bank.balanceMicro(), 5000000);
  arenas.sweep(Date.now());
  assert.deepStrictEqual(mem.obj, { 0.5: 3 }, 'not wiped by the boot or the sweep');
  arenas.setSoon(false);
  assert.strictEqual(arenas.botCount(0.5), 3);
  assert.strictEqual(bank.balanceMicro(), 3500000);
});

function sockWorld() {
  const a = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 3, log: quiet });
  const h = attachAgSockets(null, a, {
    socketRL: () => true, sanitizeName: (n) => String(n || 'Player').slice(0, 15), log: quiet,
    ops: { get: () => ({ maintenance: false }) },
  });
  let n = 0;
  const sock = (auth) => {
    const s = {
      id: 'cs' + ++n, handshake: { address: '10.9.0.' + n, headers: {}, auth: auth || {} }, conn: { writeBuffer: [] },
      handlers: {}, other: [], disconnected: false,
      on(ev, fn) { this.handlers[ev] = fn; },
      emit(ev, p) { if (ev !== 'ag:f') this.other.push([ev, p]); },
      fire(ev, ...args) { this.handlers[ev](...args); },
      disconnect() { this.disconnected = true; },
      refused() { return this.other.filter((e) => e[0] === 'ag:refused').map((e) => e[1].why); },
    };
    h.attach(s);
    return s;
  };
  return { a, sock };
}

test('agar.io sockets while Coming soon: a new page is refused and never seated; seated players carry on', () => {
  const w = sockWorld();
  const seated = w.sock();
  seated.fire('ag:join', { name: 'before' });
  const room = w.a.roomOfSocket(seated.id);
  assert.ok(room && room.seatOf(seated.id).joined, 'playing before the switch');
  w.a.setSoon(true);
  // a new page: refused and closed, no watcher seat, so it wakes nothing
  const fresh = w.sock();
  assert.deepStrictEqual(fresh.refused(), ['soon']);
  assert.strictEqual(fresh.disconnected, true);
  assert.strictEqual(w.a.roomOfSocket(fresh.id), null);
  // the lobby's paid Spectate (auth watchStake): refused the same way
  const watcher = w.sock({ watchStake: 0.5 });
  assert.deepStrictEqual(watcher.refused(), ['soon']);
  // the paid hand-off (a resume after a drop) still connects: the door decides
  const paid = w.sock({ paid: 1 });
  assert.deepStrictEqual(paid.refused(), []);
  assert.strictEqual(paid.disconnected, false);
  // the seated player keeps playing; a new life after this one is refused
  assert.strictEqual(w.a.roomOfSocket(seated.id), room);
  assert.ok(room.seatOf(seated.id).joined);
  seated.fire('ag:spectate');
  assert.deepStrictEqual(seated.refused(), [], 'already in a room: watches on');
  seated.fire('ag:join', { name: 'again' });
  assert.deepStrictEqual(seated.refused(), ['soon']);
  w.a.setSoon(false);
  const after = w.sock();
  assert.deepStrictEqual(after.refused(), [], 'Live again: a new page is seated as before');
  assert.ok(w.a.roomOfSocket(after.id));
});

test('the lobby: DS_SOON locks the card like a locked game, drops its New tag, and the play path refuses it', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/v2.html'), 'utf8');
  const lockTag = html.indexOf('<script src="/shared/lockedGames.js"></script>');
  const soonTag = html.indexOf('<script src="/api/soon.js"></script>');
  assert.ok(lockTag > 0 && soonTag > lockTag && soonTag < html.indexOf('const GAMES=['), 'read before the registry');
  const LOCK = require(path.join(ROOT, 'shared/lockedGames.js'));
  const a = html.indexOf('const GAMES=[');
  const s = html.indexOf('GAMES.splice(0,GAMES.length,', a);
  const b = html.indexOf(';', s);
  const run = (soon) => new Function('window', 'DS_LOCKED', html.slice(a, b + 1) + '\nreturn GAMES;')(
    { DS_LOCKED: LOCK, DS_SOON: soon }, LOCK);
  const GAMES = run(Object.freeze(['agar', 'battleship']));
  const G = (id) => GAMES.find((g) => g.id === id);
  for (const id of ['agar', 'battleship']) {
    const g = G(id);
    assert.ok(g.soon && g.locked, id + ' shows the padlock');
    for (const k of ['built', 'duel', 'solo', 'freeOnly', 'paid', 'ladder', 'isNew']) assert.ok(!g[k], id + ' has no ' + k);
  }
  assert.ok(!G('snake').soon && !G('paper').soon && G('knockout').built && !G('knockout').soon, 'nothing else moved');
  const ids = GAMES.map((g) => g.id);
  assert.ok(ids.indexOf('agar') > ids.indexOf('crossy') && ids.indexOf('battleship') > ids.indexOf('crossy'),
    'behind the playable games, like the locked ones');
  // without DS_SOON (the script failed to load) the cards are as before; the server still refuses
  assert.ok(!run(undefined).find((g) => g.id === 'agar').soon && run(undefined).find((g) => g.id === 'battleship').built);
  // the play path: the card's flags, or the live list for a lobby opened before the switch
  const src = html.match(/window\.V2_IS_SOON=(id=>\{[^\n]*\});/)[1];
  const isSoon = new Function('G', 'V2Board', 'return ' + src)(G, { soonNow: (id) => id === 'paper' });
  assert.ok(isSoon('agar') && isSoon('battleship') && isSoon('paper') && !isSoon('snake'));
  const plain = new Function('G', 'return ' + src)(G);
  assert.ok(plain('agar') && !plain('paper'), 'no board yet: the card flags alone');
});

test('the lobby board keeps the live soon list from /api/live and its push', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/board.js'), 'utf8');
  assert.match(src, /if \(Array\.isArray\(j\.soon\)\) SOON = j\.soon\.filter/);
  assert.match(src, /soonNow: soonNow/);
});

test('/play/<game> goes to the lobby while that game is Coming soon, and opens as before once it is Live', () => {
  let soon = new Set(['agar', 'battleship']);
  const route = playRoute({ read: () => '<html><head><!-- share:meta --><!-- /share:meta --></head></html>',
    isSoon: (id) => soon.has(id) });
  const call = (slug) => {
    const res = { code: 200, to: null, body: null, set() { return this; }, type() { return this; },
      redirect(c, to) { this.code = c; this.to = to; }, send(b) { this.body = b; } };
    route({ params: { slug }, headers: { host: 'duelseries.com' } }, res);
    return res;
  };
  assert.deepStrictEqual([call('cells').code, call('cells').to], [302, '/']);
  assert.deepStrictEqual([call('battleship').code, call('battleship').to], [302, '/']);
  assert.strictEqual(call('knockout').code, 200);
  soon = new Set();
  assert.strictEqual(call('cells').code, 200);
  assert.strictEqual(call('battleship').code, 200);
});

test('Control shows the switch on the rows that carry it and sends <game>:soon:on / :off', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/owner.html'), 'utf8');
  assert.match(html, /function partSoon\(ups, gid\)/);
  assert.match(html, /yes: 'Live', no: 'Coming soon'/);
  assert.match(html, /p\.action \+ ':off'/);
  assert.match(html, /p\.action \+ ':on'/);
  const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  for (const a of ['agar:soon:on', 'agar:soon:off', 'battleship:soon:on', 'battleship:soon:off']) {
    assert.ok(idx.includes("case '" + a + "':"), a + ' is an owner action');
  }
});

test('Open lobbies: a Coming soon game has no row (free rung, pinned duel) and Enter on a stale one does nothing', async () => {
  const { lobbyHarness } = require('./v2LobbyHarness.js');
  const rows = [
    { id: 'snake:na:s0', game: 'snake', region: 'na', stake: 0, players: 0, bots: 3, capacity: null, state: 'open' },
    { id: 'ag:na:s0', game: 'agar', region: 'na', stake: 0, players: 0, bots: 9, capacity: 54, state: 'open' },
    { id: 'paper:na:s0', game: 'paper', region: 'na', stake: 0, players: 0, bots: 4, capacity: null, state: 'open' },
  ];
  const shut = lobbyHarness(rows, { soon: ['agar', 'battleship'] });
  shut.win.V2_GAME_NAMES = { knockout: 'Knockout', battleship: 'Battleship', agar: 'Agar.io', paper: 'Paper.io', snake: 'Slither.io' };
  await shut.win.V2Board.load();
  const lob = shut.el('lob').innerHTML;
  assert.ok(!lob.includes('ag:na:s0') && !lob.includes('battleship:free'), 'neither is listed');
  assert.ok(lob.includes('paper:na:s0') && lob.includes('knockout:free'), 'the others are');
  assert.strictEqual(shut.win.V2Board.soonNow('agar'), true);
  shut.win.V2Board.join('ag:na:s0');
  shut.win.V2Board.join('battleship:free');
  assert.strictEqual(shut.el('game-frame').src, '', 'no game page was opened');
  // Live: both rows are back
  const open = lobbyHarness(rows, { soon: [] });
  open.win.V2_GAME_NAMES = shut.win.V2_GAME_NAMES;
  await open.win.V2Board.load();
  const lob2 = open.el('lob').innerHTML;
  assert.ok(lob2.includes('ag:na:s0') && lob2.includes('battleship:free'));
});
