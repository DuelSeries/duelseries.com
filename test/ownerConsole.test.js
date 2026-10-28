'use strict';
/* The owner console's server side (state v2, server/ownerConsole.js and server/ops.js):
   - the restart check counts paid Knockout and Battleship money, queued and seated (console audit finding C);
   - maintenance outlives a restart and fails closed;
   - bots:set holds an exact number in each kind of free room (agar.io and Paper for real, slither through its
     driver or the fallback hold) and refuses paid rooms before touching anything;
   - the rows, the battle royale block and the announcement text have the shape the console builds against;
   - server/index.js wires all of it: the paid duel doors refuse before a token is spent, the start alone button
     checks what forceStart returns, and the snapshot is v2. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OPS_PATH = path.join(ROOT, 'server', 'ops.js');
const ops = require(OPS_PATH);
const oc = require('../server/ownerConsole');
const { KnockoutLobby } = require('../server/KnockoutLobby');
const { BattleshipLobby } = require('../server/BattleshipLobby');
const { PaperRoom } = require('../server/paper/PaperRoom');
const { AgRoom } = require('../server/ag/agRoom');
const { REQUIRED_HOOKS } = require('../server/ag/agMoney');
const { FIXTURE } = require('./agLawsFixture');

const quiet = { error() {}, warn() {}, log() {} };
const io = { to: () => ({ emit: () => {} }) };
const sock = (id) => ({ id, join() {}, emit() {}, rooms: new Set() });
const SRC = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');

function paperRoom(stake) {
  const hooks = {};
  for (const h of ['onCashout', 'onTransfer', 'onRefund', 'onSweep', 'onBreach']) hooks[h] = () => {};
  return new PaperRoom({ stake, hooks, autoTick: false, seed: 0.6 });
}
function agRoom(stake) {
  const o = { laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: quiet };
  if (stake > 0) {
    const moneyHooks = {};
    for (const k of REQUIRED_HOOKS) moneyHooks[k] = () => {};
    Object.assign(o, { stake, moneyHooks });
  }
  return new AgRoom(o);
}

/* A slither-shaped room (server/sl/slRoom.js's console contract) around a bot driver. With `full`
   the driver has the exact-count hold the other change adds (setTarget, target, removeBots). */
function slRoom({ full, br } = {}) {
  let next = 1;
  const recs = new Map();
  let target = null;
  const driver = {
    count: () => recs.size,
    add: () => { const rec = { id: next++, manual: false }; recs.set(rec.id, rec); return rec; },
    clear: () => { const n = recs.size; recs.clear(); return n; },
    isBot: (id) => recs.has(id),
  };
  if (full) {
    driver.setTarget = (r, n) => { target = n; };
    driver.target = () => target;
    driver.removeBots = (r, n) => { let k = 0; for (const id of [...recs.keys()]) { if (k++ >= n) break; recs.delete(id); } };
  }
  const room = {
    lobbyType: br ? 'sl_na_br' : 'sl_na_s0',
    bots: driver,
    br: br || null,
    isBattleRoyale: !!br,
    _botsPausedUntil: 0,
    botsAllowed: () => true,
    get botCount() { return driver.count(); },
    get playerCount() { return 0; },
    addBot() { return driver.add(room); },
    clearBots() { return driver.clear(room); },
  };
  for (let i = 0; i < 30; i++) driver.add(room);
  return { room, driver, recs };
}

// ---- the restart check sees the duels ------------------------------------------------------------

test('duelStatus counts a paid seat waiting in the queue and a paid table until it settles; a free bot table is a bot', () => {
  const ko = new KnockoutLobby(io);
  const bs = new BattleshipLobby(io);
  ko.onSettled = () => {}; ko.onRefund = () => {};
  bs.onSettled = () => {}; bs.onRefund = () => {};
  assert.deepEqual(ops.duelStatus([ko, bs]).worth, 0);

  // one paid Knockout seat waiting for an opponent: its token is spent, the stake exists only here
  ko.enqueue(sock('A'), 'Ann', 'WA', 0.5, 0.5, Date.now(), 0.5);
  let d = ops.duelStatus([ko, bs]);
  assert.deepEqual([d.people, d.paidPeople, d.worth], [1, 1, 0.5]);
  assert.deepEqual(d.rungs['0.5'], { people: 1, paidPeople: 1, bots: 0, money: 0.5 });

  // a second person at the same rung: a seated paid table holds both stakes
  ko.enqueue(sock('B'), 'Ben', 'WB', 0.5, 0.5, Date.now(), 0.5);
  d = ops.duelStatus([ko, bs]);
  assert.equal(ko.rooms.size, 1);
  assert.deepEqual([d.people, d.paidPeople, d.worth], [2, 2, 1]);

  // a paid Battleship table at $1
  bs.enqueue(sock('C'), 'Cat', 'WC', 1, 1, 1);
  bs.enqueue(sock('D'), 'Dan', 'WD', 1, 1, 1);
  d = ops.duelStatus([ko, bs]);
  assert.deepEqual([d.paidPeople, d.worth], [4, 3]);
  assert.deepEqual(d.rungs['1'], { people: 2, paidPeople: 2, bots: 0, money: 2 });

  // the drain says unsafe, with the duel money in the reason and in moneyInPlay
  const drain = ops.drainStatus([], { count: 0, worth: 0 }, d);
  assert.equal(drain.safe, false);
  assert.match(drain.reason, /4 paid Knockout, Battleship or Swim seats hold stakes \(3 USDC, queued or at a table\)/);
  assert.deepEqual([drain.duels, drain.moneyInPlay, drain.paidPeople, drain.people], [3, 3, 4, 4]);

  // a table that settled (somebody walked out: the payout is the settle hook's) holds nothing in memory any more
  ko.leave('B');
  d = ops.duelStatus([ko, bs]);
  assert.deepEqual([d.worth, (d.rungs['0.5'] || { money: 0 }).money], [2, 0]);

  // a free table against a bot: one person, one bot table, no money
  const free = new KnockoutLobby(io);
  free.enqueue(sock('F'), 'Fay', null, 0, 0, 1000);
  free.tick(1000 + require('../server/KnockoutLobby').BOT_AFTER_MS + 1000);
  d = ops.duelStatus([free]);
  assert.deepEqual([d.people, d.paidPeople, d.worth, d.botTables, d.rungs['0'].bots], [1, 0, 0, 1, 1]);
  assert.equal(ops.drainStatus([], null, d).safe, true, 'a free duel is not money');
});

test('drainStatus keeps its old fields and adds the v2 names, all in dollars', () => {
  const room = { snakes: new Map([['a', { alive: true, worth: 0.5 }], ['b', { alive: true, isBot: true, worth: 9 }]]), floorWorth: 0.25 };
  const d = ops.drainStatus([room], { count: 1, worth: 1 }, { people: 2, paidPeople: 1, worth: 0.5 });
  for (const k of ['playing', 'paid', 'paidWorth', 'floorWorth', 'pendingEntries', 'pendingWorth', 'safe', 'reason']) {
    assert.ok(k in d, 'old field ' + k);
  }
  assert.deepEqual(
    [d.people, d.paidPeople, d.floor, d.pending, d.duels, d.moneyInPlay],
    [3, 2, 0.25, 1, 0.5, 2.25]);
  assert.equal(ops.drainStatus([]).safe, true);
});

// ---- maintenance outlives a restart --------------------------------------------------------------

function freshOps() {
  delete require.cache[require.resolve(OPS_PATH)];
  return require(OPS_PATH);
}

test('maintenance is saved on, read back after a restart, and removed on off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opsmaint-'));
  const file = path.join(dir, 'data', 'maintenance.json');
  let o = freshOps();
  assert.deepEqual(o.persist({ file, log: quiet }), { on: false, why: null });
  assert.equal(o.get().maintenance, false);
  assert.equal(o.saved(), false);
  o.set({ on: true, message: 'Deploying the new lobby', minutes: 5 });
  assert.deepEqual(o.lastSave(), { ok: true, why: null });
  assert.equal(o.saved(), true);
  assert.ok(!('until' in o.get()), 'the minutes field is gone: nothing ever reopened at that time');
  const since = o.get().since;

  o = freshOps();   // the restart
  assert.equal(o.get().maintenance, false, 'a new process starts open...');
  assert.deepEqual(o.persist({ file, log: quiet }), { on: true, why: 'owner', update: false });
  assert.deepEqual(o.get(), { maintenance: true, message: 'Deploying the new lobby', since, update: false }, '...until it reads the close');

  o.set({ on: false });
  assert.equal(fs.existsSync(file), false);
  o = freshOps();
  assert.deepEqual(o.persist({ file, log: quiet }), { on: false, why: null });
  assert.equal(o.get().maintenance, false);
});

test('maintenance fails closed: an unreadable or foreign file keeps the game shut, and a failed save says so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opsmaint-'));
  const file = path.join(dir, 'maintenance.json');
  fs.writeFileSync(file, 'not json');
  const lines = [];
  const log = { error: (m) => lines.push(m), warn() {}, log() {} };
  let o = freshOps();
  assert.deepEqual(o.persist({ file, log }), { on: true, why: 'unreadable', update: false });
  assert.equal(o.get().maintenance, true);
  assert.ok(lines.some((l) => /CRITICAL maintenance file is not a switch/.test(l)));

  const throwing = { existsSync() { throw new Error('EIO'); } };
  o = freshOps();
  assert.deepEqual(o.persist({ file, fsx: throwing, log }), { on: true, why: 'unreadable', update: false });
  assert.equal(o.saved(), true, 'a store that cannot be asked is assumed to hold the close');

  const readOnly = { existsSync: () => false, mkdirSync() {}, writeFileSync() { throw new Error('EROFS'); }, renameSync() {} };
  o = freshOps();
  o.persist({ file, fsx: readOnly, log });
  o.set({ on: true, message: 'x' });
  assert.deepEqual(o.lastSave(), { ok: false, why: 'EROFS' });
  assert.equal(o.get().maintenance, true, 'still on in memory');
  freshOps();   // leave a clean module for anything after
});

// ---- the audit -------------------------------------------------------------------------------------

test('the audit keeps who acted and a short copy of what was asked, newest first, 200 at most', () => {
  const o = freshOps();
  o.audit({ action: 'announce', args: { text: 'x'.repeat(500), nested: { a: 1 }, n: 3 }, who: 'session:ab12cd', ok: true, note: 'Sent.' });
  const e = o.auditLog[0];
  assert.equal(e.who, 'session:ab12cd');
  assert.equal(e.args.text.length, 80);
  assert.deepEqual([e.args.nested, e.args.n], ['[object]', 3]);
  for (let i = 0; i < 250; i++) o.audit({ action: 'bots:set', args: { room: 'ag_na_s0', count: i }, who: 'signature', ok: true });
  assert.equal(o.auditLog.length, o.AUDIT_MAX);
  assert.equal(o.auditLog[0].args.count, 249);
  const merged = oc.mergeAudit(o.auditLog, [{ at: Date.now() + 1000, action: 'clips:approve', who: 'C5cn…H3m9', ok: true }], 3);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].action, 'clips:approve', 'the two logs are merged by time');
});

// ---- bots:set --------------------------------------------------------------------------------------

test('bots:set holds a free agar.io room at an exact number, and auto hands it back to its own fill', () => {
  const r = agRoom(0);
  const auto = r.botCount;
  assert.ok(auto > 10);
  let x = oc.setBots(r, { count: 7 });
  assert.deepEqual([x.ok, x.live, x.held, x.asked], [true, 7, 7, 7]);
  for (let i = 0; i < 60; i++) r.tickOnce();
  assert.equal(r.botCount, 7, 'held through the fill');
  assert.equal(oc.roomBotTarget(r), 7);
  x = oc.setBots(r, { count: 0 });
  assert.equal(r.botCount, 0);
  x = oc.setBots(r, { auto: true });
  assert.deepEqual([x.ok, x.held, x.auto], [true, null, true]);
  for (let i = 0; i < 3; i++) r.tickOnce();
  assert.equal(r.botCount, auto, 'its own number again, with no held bots left on top');
  assert.equal(oc.roomBotTarget(r), null);
  r.stop();
});

test('bots:set holds a free Paper arena through its own bot cap, clamped to what an arena can hold', () => {
  const r = paperRoom(0);
  for (let i = 0; i < 20; i++) r.tickOnce();
  assert.equal(r.botCount, 15);
  let x = oc.setBots(r, { count: 4 });
  assert.deepEqual([x.ok, x.live, x.held], [true, 4, 4]);
  for (let i = 0; i < 200; i++) r.tickOnce();
  assert.equal(r.botCount, 4, 'the tick does not top it back up');
  assert.equal(r.game.config.botsCount, 4);
  x = oc.setBots(r, { count: 9 });
  assert.equal(r.botCount, 9);
  x = oc.setBots(r, { count: 40 });
  assert.deepEqual([x.live, x.held, x.asked], [15, 15, 40], 'an arena has 15 bot types and 16 squares');
  x = oc.setBots(r, { auto: true });
  assert.equal(r.game.botCap, null);
  for (let i = 0; i < 20; i++) r.tickOnce();
  assert.equal(r.botCount, 15);
  // a paid arena has no cap to hold
  const paid = paperRoom(0.5);
  assert.equal(paid.game.setBotCap(5), null);
  assert.equal(paid.game.config.botsCount, 0);
  r.stop(); paid.stop();
});

test('bots:set on slither: the driver holds the number when it can, else the fill is paused and the room refilled by hand', () => {
  const a = slRoom({ full: true });
  let x = oc.setBots(a.room, { count: 12 });
  assert.deepEqual([x.ok, x.live, x.held], [true, 12, 12], 'the surplus taken out now (removeBots)');
  assert.equal(a.driver.target(), 12);
  assert.equal(a.room._botsPausedUntil, 0, 'no pause: the driver holds it');
  x = oc.setBots(a.room, { count: 40 });
  assert.equal(a.room.botCount, 40);
  x = oc.setBots(a.room, { auto: true });
  assert.equal(a.driver.target(), null);

  const b = slRoom({ full: false });
  x = oc.setBots(b.room, { count: 5 });
  assert.deepEqual([x.ok, x.live, x.held], [true, 5, 5]);
  assert.equal(b.room._botsPausedUntil, Number.MAX_SAFE_INTEGER, 'a finite pause the fill reads as paused');
  assert.ok([...b.recs.values()].every((rec) => rec.manual === true), 'marked by hand, so the fill leaves them');
  x = oc.setBots(b.room, { auto: true });
  assert.deepEqual([b.room._botsPausedUntil, b.room.botCount, oc.roomBotTarget(b.room)], [0, 0, null],
    'the held bots go and the fill brings its own');
});

test('bots:set refuses paid rooms before touching anything, bad counts, and the event arena mid-match', () => {
  for (const r of [paperRoom(0.5), agRoom(0.5)]) {
    const before = [r.botCount, r._botsPausedUntil, r._botsHeld];
    const x = oc.setBots(r, { count: 3 });
    assert.deepEqual([x.ok, x.why], [false, 'Paid duels stay people only: a bot would win or lose a real stake']);
    assert.deepEqual([r.botCount, r._botsPausedUntil, r._botsHeld], before, 'nothing was touched');
    r.stop();
  }
  const paidSl = slRoom({ full: true });
  paidSl.room.botsAllowed = () => false;
  assert.equal(oc.setBots(paidSl.room, { count: 1 }).why, oc.PAID_BOTS_NOTE);
  const s = slRoom({ full: true });
  for (const count of [-1, 201, 2.5, '7x', null, undefined, {}]) {
    assert.equal(oc.setBots(s.room, { count }).ok, false, JSON.stringify(count));
  }
  assert.equal(oc.setBots(s.room, { count: '12' }).live, 12, 'a whole number as text is a number');
  assert.equal(oc.setBots(null, { room: 'nope', count: 1 }).why, 'No room called nope');
  const match = { state: 'running' };
  const br = slRoom({ full: true, br: match });
  assert.match(oc.setBots(br.room, { count: 3 }).why, /A match is under way/);
  match.state = 'waiting';
  assert.equal(oc.setBots(br.room, { count: 3 }).live, 3);
});

// ---- the rows, the battle royale, the announcement ------------------------------------------------

test('each game has a row per rung, paid rungs included with no room open, and a duel row per rung', () => {
  const free = agRoom(0);
  const rows = oc.rungRows([free], []);
  assert.deepEqual(rows.map((r) => r.rung), [0, 0.5, 1]);
  for (const k of ['rung', 'room', 'people', 'bots', 'money', 'botTarget', 'botsAllowed', 'botsNote']) {
    assert.ok(k in rows[0], k);
  }
  assert.deepEqual([rows[0].room, rows[0].botsAllowed, rows[0].botsNote, rows[0].bots], ['ag_na_s0', true, null, free.botCount]);
  assert.deepEqual([rows[1].room, rows[1].people, rows[1].money, rows[1].botsAllowed, rows[1].botsNote],
    [null, 0, 0, false, 'Paid duels stay people only: a bot would win or lose a real stake']);
  // a paid room's money is its bank (accounts and floor), and a stale fallback room counts only while occupied
  const paid = { lobbyType: 'sl_na_s0_5', money: { stake: 0.5, openCount: () => 2 }, liveStakeTotal: () => 1.25, botCount: 0 };
  const staleEmpty = { lobbyType: 'na_free', stake: 0, playerCount: 0, snakes: new Map() };
  const staleBusy = { lobbyType: 'na_s1', stake: 1, playerCount: 1, snakes: new Map([['x', { alive: true, worth: 1 }]]) };
  const rows2 = oc.rungRows([paid], [staleEmpty, staleBusy]);
  assert.deepEqual([rows2[1].room, rows2[1].people, rows2[1].money], ['sl_na_s0_5', 2, 1.25]);
  assert.deepEqual([rows2[2].room, rows2[2].people, rows2[2].money], [null, 1, 1], 'the stale tab with a stake is counted');
  assert.deepEqual([rows2[0].room, rows2[0].people], [null, 0]);
  free.stop();

  const duel = oc.duelRows({ rungs: { 0: { people: 1, bots: 1, money: 0 }, 1: { people: 2, bots: 0, money: 2 } } });
  assert.deepEqual(duel.map((r) => [r.rung, r.room, r.people, r.bots, r.money, r.botsAllowed]),
    [[0, null, 1, 1, 0, false], [0.5, null, 0, 0, 0, false], [1, null, 2, 0, 2, false]]);
  assert.deepEqual(oc.paidDoor({ enabled: 1, open: 0, stopping: 0 }, true, 'ko:paid'),
    { enabled: true, open: false, stopping: false, saved: true, action: 'ko:paid' });
  assert.equal(oc.paidDoor(null, false, 'x'), null);
});

test('the battle royale block counts people, not bodies, and offers Start alone whenever the arena has a snake', () => {
  const pub = { state: 'waiting', phase: 'waiting', alive: 22, players: 22, humans: 0, minPlayers: 1, canStart: false,
    countdownMs: 0, nextStartMs: 60000, prize: 20, prizeHeld: false, winner: null, engine: 'sl' };
  const br = { state: 'waiting', publicState: () => Object.assign({}, pub) };
  const room = { lobbyType: 'sl_na_br', bots: { count: () => 22, target: () => 30 } };
  let s = oc.brState(br, { engine: 'sl', room, now: 1000 });
  assert.deepEqual([s.humans, s.bots, s.alive, s.canForce, s.nextStartAt, s.room, s.botTarget, s.engine],
    [0, 22, 22, true, 61000, 'sl_na_br', 30, 'sl']);
  for (const k of ['state', 'phase', 'minPlayers', 'canStart', 'countdownMs', 'prize', 'prizeHeld', 'winner', 'players']) {
    assert.ok(k in s, k);
  }
  pub.alive = 0;
  assert.equal(oc.brState(br, { engine: 'sl', room, now: 1000 }).canForce, false, 'an empty arena has nobody to start with');
  pub.alive = 22;
  pub.state = 'running';
  br.state = 'running';
  assert.equal(oc.brState(br, { engine: 'sl', room, now: 1000 }).canForce, false, 'not while a match is on');
  delete pub.nextStartMs;
  assert.equal(oc.brState(br, { room: null }).nextStartAt, null);
  assert.equal(oc.brState(null, {}), null);
});

test('an announcement is one plain line of 200 characters at most', () => {
  assert.equal(oc.cleanAnnounce('  Back in\n5 minutes  '), 'Back in 5 minutes');
  assert.equal(oc.cleanAnnounce('<img src=x onerror=alert(1)>hi'), 'img src=x onerror=alert(1)hi');
  assert.equal(oc.cleanAnnounce('a‮b​c'), 'a b c');
  assert.equal(oc.cleanAnnounce('x'.repeat(500)).length, 200);
  assert.equal(oc.cleanAnnounce(42), '');
  assert.equal(oc.cleanAnnounce('   '), '');
});

// ---- server/index.js wiring --------------------------------------------------------------------

function handler(ev) {
  const at = SRC.indexOf("on('" + ev + "'");
  assert.ok(at > 0, ev);
  return SRC.slice(at, SRC.indexOf('\n  });', at));
}

test('index.js: the paid Knockout and Battleship doors are saved switches that refuse before the token is spent', () => {
  assert.match(SRC, /'ko-paid-switch\.json'/);
  assert.match(SRC, /'bs-paid-switch\.json'/);
  assert.match(SRC, /let koPaidOpen = !koPaidSwitch\.closedAtBoot\(\)\.closed;/);
  assert.match(SRC, /let bsPaidOpen = !bsPaidSwitch\.closedAtBoot\(\)\.closed;/);
  for (const [ev, flag] of [['ko:queue', 'koPaidOpen'], ['bs:queue', 'bsPaidOpen']]) {
    const h = handler(ev);
    const shut = h.indexOf('if (!' + flag + ') { socket.emit(');
    const consume = h.indexOf('consumePaidEntryAtStake(');
    const free = h.indexOf('if (!(wants > 0)) return seat(null);');
    assert.ok(shut > 0 && consume > 0 && shut < consume, ev + ': refused before the token is consumed');
    assert.ok(free > 0 && free < shut, ev + ': a free seat never meets the paid door');
    assert.match(h, new RegExp('if \\(entry && entry\\.stakeSig && !' + flag + '\\) return false;'),
      ev + ': shut while the claim was in flight is refunded through the row (seat returns false)');
  }
  const caseOf = (name) => SRC.slice(SRC.indexOf("case '" + name + "'"), SRC.indexOf('\n    }', SRC.indexOf("case '" + name + "'")));
  assert.match(caseOf('ko:paid:off'), /if \(ko\) koPaidOpen = false; else bsPaidOpen = false;\n\s+const kept = \(ko \? koPaidSwitch : bsPaidSwitch\)\.save\(false\);/);
  assert.match(caseOf('ko:paid:on'), /if \(ko\) koPaidOpen = true; else bsPaidOpen = true;\n\s+const kept = \(ko \? koPaidSwitch : bsPaidSwitch\)\.save\(true\);/);
});

test('index.js: the restart check, maintenance, Start alone, bots:set and announce are wired as the console expects', () => {
  assert.match(SRC, /const drainNow = \(\) => ops\.drainStatus\(ALL_ROOMS\(\), entryStore\.pending\(\), duelStatusNow\(\), brDrainWhy\(\)\);/);
  assert.match(SRC, /const duelStatusNow = \(\) => ops\.duelStatus\(\[knockoutLobby, battleshipLobby, swimLobby, headSoccerLobby, pool8Lobby, airHockeyLobby]\);/);
  const check = SRC.slice(SRC.indexOf("case 'maintenance:check'"), SRC.indexOf("case 'announce'"));
  assert.match(check, /const d = drainNow\(\);/);
  assert.match(check, /d\.moneyInPlay/);
  assert.match(SRC, /ops\.persist\(\{ file: process\.env\.MAINTENANCE_PATH \|\| path\.join\(path\.dirname\(agJournal\.file\), 'maintenance\.json'\) \}\);/);
  const start = SRC.slice(SRC.indexOf("case 'br:start'"), SRC.indexOf("case 'br:stop'"));
  // Battle royale owns the start rules (ownerStartBr, br-flow session): the console only asks it.
  assert.match(start, /const r = ownerStartBr\(br, !!args\.force\);/);
  assert.match(SRC, /case 'bots:set': \{\n\s+const room = typeof args\.room === 'string' \? ALL_ROOMS\(\)\.find\(r => r\.lobbyType === args\.room\) : null;\n\s+const r = ownerConsole\.setBots\(room, args\);/);
  const ann = SRC.slice(SRC.indexOf("case 'announce'"), SRC.indexOf('default:', SRC.indexOf("case 'announce'")));
  assert.match(ann, /ownerConsole\.cleanAnnounce\(args\.text\)/);
  assert.match(ann, /if \(text === _announcedText && Date\.now\(\) - _announcedAt < ANNOUNCE_SAME_MS\) return refuse\(/);
  assert.match(ann, /io\.emit\('announce', msg\);/);
  // No rate limit for the owner (Owen 2026-10-17), only a one-second same-text guard.
  assert.match(SRC, /const ANNOUNCE_SAME_MS = 1000;/);
  assert.doesNotMatch(SRC, /ANNOUNCE_GAP_MS/);
});

test('index.js: the snapshot is state v2, with the old fields kept, and every owner answer is no-store', () => {
  const snap = SRC.slice(SRC.indexOf('function opsSnapshot(req, signed)'), SRC.indexOf("app.post('/api/owner/state'"));
  for (const k of ['v: 2,', 'auth: consoleAuthOf(req, signed),', 'open: !m.maintenance,', 'drain: drainNow(),',
    'escrow: consoleEscrow(),', 'games: consoleGames(ko, bs, sw, hs, p8, ah),', 'smooth: consoleSmooth(),', 'rooms,',
    'audit: ownerConsole.mergeAudit(ops.auditLog, ownerAuth.auditLog, 50),']) {
    assert.ok(snap.includes(k), k);
  }
  assert.match(snap, /maintenance: Object\.assign\(\{\}, m, \{ on: !!m\.maintenance, saved: ops\.saved\(\) \}\),/);
  assert.match(snap, /battleRoyale: ownerConsole\.brState\(br, \{ engine: brOnSl\(\) \? 'sl' : 'old', room: brRoomNow\(\), now \}\),/);
  for (const id of ["id: 'slither'", "id: 'agar'", "id: 'paper'", "id: 'knockout'", "id: 'battleship'"]) {
    assert.ok(SRC.includes(id), id);
  }
  assert.ok(SRC.indexOf("app.use('/api/owner', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });")
    < SRC.indexOf("app.post('/api/owner/state'"), 'the no-store header is set before the owner routes');
  // the audit names who acted
  assert.match(SRC, /const done = \(note\) => \{ ops\.audit\(\{ action, args, who: actor, ok: true, note \}\);/);
});
