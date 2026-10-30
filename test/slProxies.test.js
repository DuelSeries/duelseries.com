'use strict';
/* The server split's proxies (server/split/slProxies.js) and the snapshot they read (server/split/slChild.js
   snapshotOf; spec 5.4, 7 and 14.1 #3).

   - parity: a real in-process free SlArenas and SlBrArena (fixture laws, bots, people seated in both), their snapshot
     through the slither process's own builder and a JSON round trip (the IPC channel's serialization), wrapped in the
     proxies: ownerConsole.rungRows, ownerConsole.brState, ops.drainStatus, liveCounts, the console's room rows,
     boardRows, isLive and publicState give the same answers as the real objects
   - stale (no snapshot for 5 s, or none yet): boardRows and humanTotal throw, all() is [], isLive, canStart and
     acceptingPlayers are false, the match's state is 'unknown', publicState is the last copy saying unknown and never
     throws, the drain sees no room
   - the mirror governor: the slither process's engaged and mult while fresh, neutral when stale, admitBot's rule
   - the decision proxy: the fields payBattleRoyaleWinner reads; a prizeHeld that is not a boolean is null, and null
     holds the prize; holdPrize is sent to the slither process
   - the snapshot schema: the envelope accepts it, and it has no money field (stake only as the free row's 0, the
     prize only as the Events tab's display); a free row with any other stake is refused whole */
const test = require('node:test');
const assert = require('node:assert');
const { rig } = require('./slSockFakes');
const { bareSocket } = require('./slNetFakes');
const { createRng } = require('../server/sl/slRng');
const { SlBrArena } = require('../server/slBr/slBrArena');
const { snapshotOf } = require('../server/split/slChild');
const P = require('../server/split/slProxies');
const env = require('../server/split/ipcEnvelope');
const ownerConsole = require('../server/ownerConsole');
const ops = require('../server/ops');
const { liveCounts } = require('../server/liveCounts');

const QUIET = { log() {}, warn() {}, error() {} };
const NOW = 1.7e12;

// The free room with people and bots, the battle royale's room with people and a bot, sharing one governor.
function world() {
  const r = rig({ bots: true });
  r.wall.t = NOW;
  for (let i = 0; i < 3; i++) assert.ok(r.room().addBot(), 'a bot in the free room');
  const a = r.sock({ ip: '198.51.100.1' });
  const b = r.sock({ ip: '198.51.100.2' });
  a.fire('sl:join', { nick: 'ann' });
  b.fire('sl:join', { nick: 'ben' });
  const rng = createRng(9);
  const br = new SlBrArena(r.laws, { shippableOnly: false, autoTick: false, bots: true, seed: 21, clock: r.ft.clock,
    timers: r.ft.timers, now: () => r.wall.t, prey: false, log: QUIET, rand: () => rng.next(),
    governor: r.arenas.governor });
  const ann = br.room().seat(bareSocket(), { nick: 'Ann', cv: 1, wallet: 'WA', ip: '198.51.100.7' });
  const ben = br.room().seat(bareSocket(), { nick: 'Ben', cv: 1, wallet: 'WB', ip: '203.0.113.5' });
  assert.ok(ann && ben, 'two people in the arena');
  br.room().spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  return { r, br, ann, ben };
}

let seq = 0;
// The snapshot as the main server gets it: built by the slither process's builder, through JSON.
function snapOf(w) {
  const s = snapshotOf({ boot: 'BOOT', seq: ++seq, arenas: w.r.arenas, slBr: w.br, proc: { pid: 1 }, now: NOW });
  return JSON.parse(JSON.stringify(s));
}

function viewOf(snap, o) {
  const opt = o || {};
  const sent = [];
  const calls = [];
  const v = {
    sent,
    calls,
    cur: snap,
    isFresh: opt.fresh !== false,
    snap: () => v.cur,
    fresh: () => v.isFresh,
    send: (m) => { sent.push(m); return true; },
    call: (op, args) => { calls.push([op, args]); return Promise.resolve({ ok: true }); },
    decided: () => (v.cur && v.cur.br ? v.cur.br.decided : null),
    door: null,
    extra: null,
    setDoorWanted: (open) => { v.door = open; },
    setExtraLoad: (fn) => { v.extra = fn; },
  };
  return v;
}

function proxiesOf(view, laws) {
  const gov = P.mirrorGovernor(view);
  return { gov, free: P.freeProxy(view, { laws, shippableOnly: false, governor: gov }), br: P.brProxy(view) };
}

// The console's room rows as opsSnapshot builds them (server/index.js), without the label.
const consoleRows = (rooms) => rooms.map((r) => ({
  id: r.lobbyType,
  game: r.isBattleRoyale ? 'battle royale' : 'slither.io (new)',
  players: r.playerCount !== undefined ? r.playerCount : 0,
  bots: r.botCount !== undefined ? r.botCount : 0,
  takesBots: typeof r.botsAllowed === 'function' ? r.botsAllowed() && !r.money && r.paid !== true : false,
}));

test('parity: rows, the battle royale, the drain, the counts and the board read the same through the proxies', () => {
  const w = world();
  const snap = snapOf(w);
  assert.strictEqual(env.check('toMain', snap).ok, true, env.check('toMain', snap).why);
  const view = viewOf(snap);
  const p = proxiesOf(view, w.r.laws);
  const realRooms = [...w.r.arenas.all(), ...w.br.all()];
  const proxRooms = [...p.free.all(), ...p.br.all()];
  assert.strictEqual(proxRooms.length, 2);

  assert.deepStrictEqual(ownerConsole.rungRows(p.free.all(), []), ownerConsole.rungRows(w.r.arenas.all(), []));
  assert.deepStrictEqual(ownerConsole.rungRows(p.br.all(), []), ownerConsole.rungRows(w.br.all(), []));
  const real = ownerConsole.brState(w.br.match, { engine: 'sl', room: w.br.room(), now: NOW });
  const prox = ownerConsole.brState(p.br.match, { engine: 'sl', room: p.br.room(), now: NOW });
  assert.deepStrictEqual(prox, real);
  assert.strictEqual(prox.humans, 2);
  assert.strictEqual(prox.bots, 1);

  const rd = ops.drainStatus(realRooms, null, null, []);
  const pd = ops.drainStatus(proxRooms, null, null, []);
  assert.deepStrictEqual(pd, rd);
  assert.strictEqual(pd.playing, 4, 'two free and two BR people; bots never count');
  assert.strictEqual(pd.safe, true, 'free players never make a restart unsafe');

  const counts = (free, br) => liveCounts({ sl: { humanTotal: () => free.humanTotal() + br.humanTotal() } }).snake;
  assert.strictEqual(counts(p.free, p.br), counts(w.r.arenas, w.br));
  assert.deepStrictEqual(consoleRows(proxRooms), consoleRows(realRooms));
  assert.deepStrictEqual(proxRooms.map((r) => ownerConsole.roomBotTarget(r)), realRooms.map((r) => ownerConsole.roomBotTarget(r)));

  assert.deepStrictEqual(p.free.boardRows(), w.r.arenas.boardRows());
  assert.strictEqual(p.free.isLive(), w.r.arenas.isLive());
  assert.strictEqual(p.free.humanTotal(), w.r.arenas.humanTotal());
  assert.deepStrictEqual(p.br.match.publicState(), JSON.parse(JSON.stringify(w.br.match.publicState())));
  assert.strictEqual(p.br.match.state, w.br.match.state);
  assert.strictEqual(p.br.match.canStart(), w.br.match.canStart());
  assert.strictEqual(p.br.match.acceptingPlayers(), w.br.match.acceptingPlayers());
  assert.strictEqual(p.br.match.humanLiving(), w.br.match.humanLiving());
  assert.strictEqual(p.br.match.livingCount(), w.br.match.livingCount());
  assert.strictEqual(p.br.match.winner, null, 'no decision yet');
});

test('a room proxy holds no money and cannot be changed here: its bots go through the link', () => {
  const w = world();
  const p = proxiesOf(viewOf(snapOf(w)), w.r.laws);
  const room = p.free.all()[0];
  assert.strictEqual(room.money, null);
  assert.strictEqual(room.stake, 0);
  assert.strictEqual(room.floorWorth, 0);
  assert.strictEqual(room.liveStakeTotal, undefined);
  assert.strictEqual(ownerConsole.roomMoney(room), 0);
  for (const s of room.snakes.values()) assert.deepStrictEqual(s, { alive: true, isBot: false, worth: 0 });
  assert.throws(() => room.snakes.set('x', {}), /read only/);
  assert.throws(() => room.snakes.delete('h0'), /read only/);
  assert.throws(() => room.addBot(), /slLink\.call/);
  assert.throws(() => room.clearBots(), /slLink\.call/);
  assert.throws(() => { room._botsHeld = 3; }, TypeError, 'frozen');
  assert.throws(() => p.br.match.abandon('owner'), /slLink\.call/);
  assert.throws(() => p.br.match.forceStart(), /slLink\.call/);
});

test('stale: unknown, never 0 (throws, [], false, unknown) and publicState never throws', () => {
  const w = world();
  const snap = snapOf(w);
  const view = viewOf(snap, { fresh: false });
  const p = proxiesOf(view, w.r.laws);
  assert.throws(() => p.free.boardRows(), /not reporting/);
  assert.throws(() => p.free.humanTotal(), /not reporting/);
  assert.throws(() => p.br.humanTotal(), /not reporting/);
  assert.deepStrictEqual(p.free.all(), []);
  assert.deepStrictEqual(p.br.all(), []);
  assert.strictEqual(p.br.room(), null);
  assert.strictEqual(p.free.isLive(), false);
  assert.strictEqual(p.br.isOpen(), false);
  const m = p.br.match;
  assert.strictEqual(m.state, 'unknown');
  assert.strictEqual(m.canStart(), false);
  assert.strictEqual(m.acceptingPlayers(), false);
  assert.strictEqual(m.humanLiving(), 0);
  const st = m.publicState();
  assert.strictEqual(st.state, 'unknown');
  assert.strictEqual(st.humans, snap.br.match.public.humans, 'the last copy, saying unknown');
  // the lobby card reads 0 (liveCounts catches the throw), the drain sees no room
  assert.strictEqual(liveCounts({ sl: { humanTotal: () => p.free.humanTotal() + p.br.humanTotal() } }).snake, 0);
  assert.strictEqual(ops.drainStatus([...p.free.all(), ...p.br.all()], null, null, []).playing, 0);
  // the console's brState still answers, saying unknown
  assert.strictEqual(ownerConsole.brState(m, { engine: 'sl', room: p.br.room(), now: NOW }).state, 'unknown');
  // no snapshot ever: still no throw
  const none = proxiesOf(viewOf(null, { fresh: false }), w.r.laws);
  assert.strictEqual(none.br.match.publicState().state, 'unknown');
  assert.deepStrictEqual(none.free.all(), []);
  // a fresh snapshot whose board row failed: boardRows throws its reason (unknown 'sl'), isLive false
  const bad = JSON.parse(JSON.stringify(snap));
  bad.free.rowsErr = 'board row failed';
  bad.free.rows = null;
  bad.free.live = false;
  const pb = proxiesOf(viewOf(bad), w.r.laws);
  assert.throws(() => pb.free.boardRows(), /board row failed/);
  assert.strictEqual(pb.free.isLive(), false);
});

test('the mirror governor follows the slither process while fresh, neutral when stale; admitBot is the same rule', () => {
  const w = world();
  w.r.arenas.sampleLoad(NOW, { loopP99Ms: 10000, paidPlayers: 0 });
  assert.strictEqual(w.r.arenas.governor.engaged(), true);
  const view = viewOf(snapOf(w));
  const g = P.mirrorGovernor(view);
  assert.strictEqual(g.engaged(), true);
  assert.strictEqual(g.mult(), w.r.arenas.governor.mult());
  assert.ok(g.mult() < 1);
  assert.strictEqual(g.sample(NOW, {}), null, 'nothing is sampled here');
  assert.deepStrictEqual(g.admitBot({ snakes: 1, cap: 10 }), { ok: false, why: 'governor' });
  view.isFresh = false;
  assert.strictEqual(g.engaged(), false);
  assert.strictEqual(g.mult(), 1);
  assert.deepStrictEqual(g.admitBot({ snakes: 1, cap: 10 }), { ok: true, why: '' });
  assert.deepStrictEqual(g.admitBot({ snakes: 10, cap: 10 }), { ok: false, why: 'cap' });
  assert.deepStrictEqual(g.admitBot({ snakes: 10, cap: null }), { ok: true, why: '' });
  assert.throws(() => g.admitBot({ snakes: 1.5 }), TypeError);
  // the real governor answers the same on the same inputs
  const real = w.r.arenas.governor;
  for (let i = 0; i < 40 && real.engaged(); i++) w.r.arenas.sampleLoad(NOW + (i + 1) * 1000, { loopP99Ms: 0, paidPlayers: 0 });
  assert.strictEqual(real.engaged(), false);
  assert.deepStrictEqual(real.admitBot({ snakes: 10, cap: 10 }), { ok: false, why: 'cap' });
});

test('the free door and the paid slice go to the link; sweep and close do nothing here', async () => {
  const w = world();
  const view = viewOf(snapOf(w));
  const p = proxiesOf(view, w.r.laws);
  assert.strictEqual(p.free.door(false), false);
  assert.strictEqual(view.door, false, 'remembered for the next init');
  assert.deepStrictEqual(view.calls, [['door', { open: false }]]);
  assert.strictEqual(p.free.door('junk'), 'junk');
  assert.strictEqual(view.calls.length, 1, 'only a boolean moves the door');
  const fn = () => 3;
  assert.strictEqual(p.free.setExtraLoad(fn), true);
  assert.strictEqual(view.extra, fn);
  assert.deepStrictEqual(p.free.sweep(NOW), { replaced: false });
  assert.strictEqual(p.br.maxSliceMs(), 0);
  p.br.startRoom();
  assert.deepStrictEqual(view.calls[1], ['br:startRoom', {}]);
  p.br.match.startMatch('auto 14:00 ET', { countdownMs: 0 });
  assert.deepStrictEqual(view.calls[2], ['br:autoStart', { why: 'auto 14:00 ET' }]);
});

test('a decided match: the decision block, the match proxy and the decision proxy carry what the prize reads', () => {
  const w = world();
  const m = w.br.match;
  assert.strictEqual(m.startMatch('test', { countdownMs: 0 }), true);
  w.br.room().sim.forEachSnake((s) => { if (s.id !== w.ann.snakeId) w.br.room().sim.kill(s.id); });
  for (let i = 0; i < 5; i++) {
    w.r.ft.advance(w.r.laws.L7.value);
    w.br.room().wake();
  }
  assert.strictEqual(m.state, 'over');
  const snap = snapOf(w);
  assert.strictEqual(env.check('toMain', snap).ok, true);
  const d = snap.br.decided;
  assert.ok(d, 'decided while the winner is set');
  assert.strictEqual(d.matchId, m.matchId);
  assert.deepStrictEqual(d.winner, { id: m.winner.id, name: 'Ann', wallet: 'WA', bot: false });
  assert.deepStrictEqual(d.seats, m.startedSeats());
  assert.strictEqual(d.prizeHeld, m.prizeHeld);
  const view = viewOf(snap);
  const mp = P.brProxy(view).match;
  assert.strictEqual(mp.matchId, m.matchId);
  assert.deepStrictEqual(mp.winner, { id: m.winner.id, name: 'Ann', wallet: 'WA', bot: false });
  assert.strictEqual(mp.soloRun, m.soloRun);
  assert.strictEqual(mp.prizeHeld, m.prizeHeld);
  assert.strictEqual(mp.startedWith, m.startedWith);
  assert.strictEqual(mp.startedPeople, m.startedPeople);
  assert.deepStrictEqual(mp.startedSeats(), m.startedSeats());
  // kept after the slither process stops reporting (the backstop still finds it)
  view.isFresh = false;
  assert.strictEqual(mp.matchId, m.matchId);
  assert.strictEqual(mp.state, 'unknown');
  assert.strictEqual(mp.holdPrize(m.matchId), true);
  assert.deepStrictEqual(view.sent, [{ t: 'br.hold', matchId: m.matchId }]);
  assert.strictEqual(mp.holdPrize(null), false);
});

test('the decision proxy: prizeHeld passes only as a boolean, so anything else holds the prize', () => {
  const sent = [];
  const view = { send: (x) => sent.push(x) };
  const base = { matchId: 'br_x', winner: { id: 4, name: 'Ann', wallet: 'WA', bot: false }, soloRun: false,
    prizeHeld: false, startedPeople: 2, startedWith: 3, seats: [{ wallet: 'WA', net: '1.1.1.1' }, { wallet: 'WB', net: '2.2.2.2' }] };
  const ok = P.decisionProxy(base, view);
  assert.strictEqual(ok.prizeHeld, false);
  assert.strictEqual(ok.soloRun, false);
  assert.strictEqual(ok.startedPeople, 2);
  assert.strictEqual(ok.startedWith, 3);
  const seats = ok.startedSeats();
  seats[0].wallet = 'changed';
  assert.strictEqual(ok.startedSeats()[0].wallet, 'WA', 'a copy every time');
  // payBattleRoyaleWinner's own test: `room.prizeHeld || typeof room.prizeHeld !== 'boolean'` holds the prize
  const held = (r) => !!(r.prizeHeld || typeof r.prizeHeld !== 'boolean');
  assert.strictEqual(held(ok), false);
  for (const junk of [undefined, null, 'no', 0, 1, {}, []]) {
    const d = P.decisionProxy(Object.assign({}, base, { prizeHeld: junk }), view);
    assert.strictEqual(d.prizeHeld, null, String(junk));
    assert.strictEqual(held(d), true, 'held: ' + String(junk));
  }
  assert.strictEqual(held(P.decisionProxy(Object.assign({}, base, { prizeHeld: true }), view)), true);
  // a winner with no wallet stays without one (Owen is told, nothing is sent); a bot stays a bot
  assert.strictEqual(P.decisionProxy(Object.assign({}, base, { winner: { name: 'x', wallet: '', bot: false } }), view).winner.wallet, null);
  assert.strictEqual(P.decisionProxy(Object.assign({}, base, { winner: { name: 'b', wallet: null, bot: true } }), view).winner.bot, true);
  assert.strictEqual(P.decisionProxy({}, view).winner, null, 'nothing to pay');
  assert.strictEqual(P.decisionProxy({}, view).matchId, null);
  assert.strictEqual(ok.holdPrize('br_x'), true);
  assert.deepStrictEqual(sent, [{ t: 'br.hold', matchId: 'br_x' }]);
});

// Every key of an object, with its path.
function keysOf(x, at, out) {
  if (Array.isArray(x)) x.forEach((e, i) => keysOf(e, at + '[' + i + ']', out));
  else if (x && typeof x === 'object') for (const k of Object.keys(x)) { out.push([at + '.' + k, k, x[k]]); keysOf(x[k], at + '.' + k, out); }
  return out;
}
const MONEY_KEYS = ['worth', 'money', 'liveStakeTotal', 'floorWorth', 'paidWorth', 'moneyInPlay', 'balance', 'owed',
  'escrow', 'payout', 'amount', 'entryToken', 'token', 'sig', 'micro', 'usdc', 'sol', 'cut', 'gross', 'net$'];

test('the snapshot schema: accepted by the envelope, about 3 KB, and no money field anywhere', () => {
  const w = world();
  const snap = snapOf(w);
  assert.ok(env.sizeOf(snap) < 8 * 1024, 'small: ' + env.sizeOf(snap));
  assert.deepStrictEqual(Object.keys(snap).sort(), ['at', 'boot', 'br', 'door', 'free', 'gov', 'proc', 'rooms', 'seq',
    'smooth', 't', 'v']);
  for (const [where, k, v] of keysOf(snap, 'snap', [])) {
    assert.ok(!MONEY_KEYS.includes(k), 'no money field: ' + where);
    if (k === 'stake') assert.ok(/^snap\.free\.rows\[\d+\]\.stake$/.test(where) && v === 0, 'stake only as the free row\'s 0: ' + where);
    if (k === 'prize' || k === 'prizeHeld') assert.ok(/^snap\.br\.(match\.public|decided)\./.test(where), 'the prize only as display or the decision: ' + where);
  }
  // a free row that names a stake is refused whole
  const paid = JSON.parse(JSON.stringify(snap));
  paid.free.rows[0].stake = 0.5;
  assert.deepStrictEqual(env.check('toMain', paid), { ok: false, why: 'bad free' });
  const junkRoom = JSON.parse(JSON.stringify(snap));
  junkRoom.rooms[0].humans = -1;
  assert.strictEqual(env.check('toMain', junkRoom).ok, false);
});

test('the envelope: version, type, field types, size; nothing throws on junk', () => {
  assert.deepStrictEqual(env.check('toMain', { v: 2, t: 'hello' }), { ok: false, why: 'version 2' });
  assert.deepStrictEqual(env.check('toMain', { v: 1, t: 'nope' }), { ok: false, why: 'unknown type' });
  assert.deepStrictEqual(env.check('toMain', { v: 1, t: 'toString' }), { ok: false, why: 'unknown type' });
  assert.deepStrictEqual(env.check('toChild', { v: 1, t: 'hello', boot: 'x', pid: 1, node: 'v20' }), { ok: false, why: 'unknown type' });
  assert.deepStrictEqual(env.check('toMain', { v: 1, t: 'hello', boot: 'x', pid: 1, node: 'v20' }), { ok: true, why: '' });
  assert.deepStrictEqual(env.check('toMain', { v: 1, t: 'hello', boot: 7, pid: 1, node: 'v20' }), { ok: false, why: 'bad boot' });
  assert.deepStrictEqual(env.check('toChild', { v: 1, t: 'cmd', id: 1, op: 'rm -rf', args: {} }), { ok: false, why: 'bad op' });
  assert.deepStrictEqual(env.check('toChild', { v: 1, t: 'cmd', id: 1, op: 'bots:add', args: {} }), { ok: true, why: '' });
  assert.deepStrictEqual(env.check('toChild', { v: 1, t: 'load', paidPlayers: 1, extraSliceMs: -1, maintenance: false }),
    { ok: false, why: 'bad extraSliceMs' });
  assert.deepStrictEqual(env.check('toMain', { v: 1, t: 'join', name: 'a', where: 'free', h: { cookie: 'x', authorization: 'y' } }),
    { ok: false, why: 'bad h' }, 'only the owner check\'s headers cross');
  const big = { v: 1, t: 'push', text: 'x', title: 'y', pad: 'z'.repeat(env.MAX_BYTES) };
  assert.deepStrictEqual(env.check('toMain', big), { ok: false, why: 'over ' + env.MAX_BYTES + ' bytes' });
  const loop = { v: 1, t: 'br.live', rec: {} };
  loop.rec.self = loop.rec;
  assert.strictEqual(env.check('toMain', loop).ok, false, 'a message that cannot be JSON is refused');
  for (const junk of [null, undefined, 5, 'x', [], { v: 1 }, { get t() { throw new Error('boom'); } }]) {
    assert.doesNotThrow(() => env.check('toMain', junk));
    assert.strictEqual(env.check('toMain', junk).ok, false);
  }
  // a decision is never refused for its prizeHeld (the proxy holds it)
  const d = { matchId: 'br_x', winner: { name: 'A', wallet: null, bot: false }, soloRun: false, prizeHeld: 'junk',
    startedPeople: 1, startedWith: 2, seats: [] };
  assert.strictEqual(env.check('toMain', { v: 1, t: 'br.decided', d }).ok, true);
  assert.strictEqual(env.check('toMain', { v: 1, t: 'br.decided', d: Object.assign({}, d, { winner: { name: 'A', wallet: null } }) }).ok,
    false, 'a winner that does not say whether it is a bot is not guessed');
  // the drop log says so once a minute per type
  const lines = [];
  let t = 0;
  const drop = env.dropLog({ warn: (s) => lines.push(s) }, () => t);
  drop('snap', 'bad seq');
  drop('snap', 'bad seq');
  drop('join', 'bad h');
  t = 60000;
  drop('snap', 'bad seq');
  assert.strictEqual(lines.length, 3);
});
