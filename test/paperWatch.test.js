'use strict';
// Spectate (pp:watch, the lobby's Free rung only): a watcher is read-only. It never takes a seat, is never
// counted, never touches money, a token, a resumeKey or the directory, gets the same pp:s / pp:ev as the
// players, never keeps an arena ticking, and is let go whenever its arena stops or empties.
const test = require('node:test');
const assert = require('node:assert');
const createPaperSockets = require('../server/paperSockets');
const { PaperArenas } = require('../server/paper/PaperArenas');
const { WATCHERS_MAX } = require('../server/paper/PaperRoom');
const { REASON, MP } = require('../server/paper/ArenaGame');
const { isStake } = require('../server/stakeRules');

// server/index.js socketRL, as it is.
function socketRL(socket, key, minMs) {
  const now = Date.now();
  if (!socket._rl) socket._rl = {};
  if (socket._rl[key] && now - socket._rl[key] < minMs) return false;
  socket._rl[key] = now;
  return true;
}

// An io that delivers: io.to(room or socket id).emit reaches every socket in that room (or that socket).
function world({ rateLimit = false, autoTick = false } = {}) {
  let t = 1000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const sockets = new Map();
  const io = {
    sockets: { sockets },
    to(target) {
      const send = (ev, p) => {
        const s = sockets.get(target);
        if (s) return s.got.push([ev, p]);
        for (const x of sockets.values()) if (x.rooms.has(target)) x.got.push([ev, p]);
      };
      return { emit: send, volatile: { emit: send } };
    }
  };
  const hooks = { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {} };
  const arenas = new PaperArenas({ io, hooks, now: clock.now, paidEnabled: true, autoTick, warm: false });
  const tokens = new Map();
  const spy = { consume: [], storeConsume: [], refunds: [] };
  const take = (token, stake) => {
    stake = Number(stake);
    if (stake === 0) return { ok: true, worth: 0 };
    const tk = typeof token === 'string' && tokens.get(token);
    if (!tk || Math.abs(tk.stake - stake) > 1e-9) return { ok: false, worth: 0 };
    tokens.delete(token);
    return { ok: true, worth: tk.worth, paid: tk.paid, walletAddress: tk.walletAddress };
  };
  const paper = createPaperSockets({
    arenas,
    ops: { get: () => ({ maintenance: false }) },
    socketRL: rateLimit ? socketRL : () => true,
    sanitizeName: (n) => String(n == null ? '' : n).replace(/[<>]/g, '').trim().slice(0, 20) || 'Player',
    isStake,
    consumePaidEntryAtStake(token, stake) {
      const r = take(token, stake);
      spy.consume.push([token, stake, r.ok]);
      return r;
    },
    entryStore: { consumeAtStake(token, stake) { const r = take(token, stake); spy.storeConsume.push([token, stake, r.ok]); return r; } },
    payout: { refund: (x) => spy.refunds.push(x) },
    paidEnabled: true
  });
  let tn = 0;
  const mint = (stake) => {
    const token = 'tok' + ++tn;
    tokens.set(token, { stake, worth: stake, paid: stake, walletAddress: 'W' + tn });
    return token;
  };
  let sn = 0;
  function sock() {
    const s = {
      id: 'wk' + ++sn,
      handlers: {},
      got: [],
      rooms: new Set(),
      on(ev, fn) { this.handlers[ev] = fn; },
      emit(ev, p) { this.got.push([ev, p]); },
      join(r) { this.rooms.add(r); },
      leave(r) { this.rooms.delete(r); },
      fire(ev, p) { this.handlers[ev](p); },
      all(ev) { return this.got.filter((x) => x[0] === ev).map((x) => MP.unpackBin(x[1])); },
      last(ev) { const g = this.all(ev); return g.length ? g[g.length - 1] : null; },
      disconnect() { sockets.delete(this.id); this.rooms.clear(); paper.drop(this.id); }
    };
    sockets.set(s.id, s);
    paper.attach(s);
    return s;
  }
  const free = () => arenas.all().find((r) => r.stake === 0 && r.index === 0);
  function player(name = 'p') {
    const s = sock();
    s.fire('pp:join', { name, stake: 0 });
    assert.ok(s.last('pp:joined'), 'seated ' + name);
    return s;
  }
  function tick(room, n = 1) {
    for (let i = 0; i < n; i++) {
      clock.advance(MP.STEP_MS);
      room.tickOnce();
    }
  }
  return { arenas, paper, spy, mint, clock, sock, free, player, tick, io };
}

// Every count the lobby, ops and the money paths read.
function counts(w) {
  const room = w.free();
  return {
    liveHumans: room.liveHumans,
    playerCount: room.playerCount,
    seats: room.seats.size,
    bySocket: room.bySocket.size,
    humanTotal: w.arenas.humanTotal(),
    boardFree: w.arenas.boardRows().find((r) => r.stake === 0).players,
    dirSockets: w.arenas.bySocket.size,
    dirKeys: w.arenas.byKey.size,
    accounts: room.bank.openIds().length,
    humans: room.game.units.filter((u) => u.isHuman).length
  };
}

test('pp:watch seats nothing, counts nowhere, and sends the state with no you and no resumeKey', () => {
  const w = world();
  w.player('pat');
  const before = counts(w);
  const v = w.sock();
  v.fire('pp:watch', { stake: 0 });
  const st = v.last('pp:watching');
  assert.ok(st && !st.none, 'the state came');
  assert.strictEqual(st.you, undefined);
  assert.strictEqual(st.resumeKey, undefined);
  assert.strictEqual(st.stake, 0);
  assert.strictEqual(st.arenaId, w.free().lobbyType);
  assert.ok(Array.isArray(st.units) && st.units.length >= 1);
  assert.strictEqual(st.units.length, st.rings.length);
  assert.ok(st.units.some((u) => u.id === st.follow), 'follow names a square in the state');
  assert.deepStrictEqual(counts(w), before, 'nothing a player, the lobby or ops reads moved');
  assert.strictEqual(v.last('pp:joined'), null);
  assert.ok(v.rooms.has(w.free().ioRoom), 'in the io room');
  assert.strictEqual(v._ppRoom, undefined, 'never _ppRoom');
  assert.strictEqual(v._ppWatch, w.free());
  assert.strictEqual(w.free().watchers.size, 1);
  assert.strictEqual(w.spy.consume.length + w.spy.storeConsume.length, 1, 'only the player join touched the door');
  assert.strictEqual(w.free().snakes.size, 0, 'ops sees no paid humans');
});

test('follow is the leader by land (players and bots alike), or the square ranked after `after`', () => {
  const w = world();
  w.player('a');
  w.player('b');
  const room = w.free();
  w.tick(room, 4);
  const live = room.game.units.filter((u) => !u.death).sort((x, y) => y.base.square - x.base.square || x.id - y.id);
  assert.ok(live.length >= 3, 'humans and bots: ' + live.length);
  // Make a bot the clear leader.
  const bot = live.find((u) => !u.isHuman);
  bot.base.square = live[0].base.square * 3;
  const ranked = room.game.units.filter((u) => !u.death).sort((x, y) => y.base.square - x.base.square || x.id - y.id);
  assert.strictEqual(room.followFor(0), bot.id);
  assert.strictEqual(room.followFor(ranked[0].id), ranked[1].id);
  assert.strictEqual(room.followFor(ranked[ranked.length - 1].id), ranked[0].id, 'wraps round');
  assert.strictEqual(room.followFor(987654), ranked[0].id, 'an unknown id is the leader');
  const v = w.sock();
  v.fire('pp:watch', { stake: 0, after: ranked[0].id });
  assert.strictEqual(v.last('pp:watching').follow, ranked[1].id);
});

test('only the free rung, never from a seated socket, never with nobody playing, and full at the cap', () => {
  const w = world();
  const arenasBefore = w.arenas.all().length;
  const v0 = w.sock();
  v0.fire('pp:watch', { stake: 0 });
  assert.deepStrictEqual(v0.last('pp:watching'), { none: true, why: 'nobody', text: 'Nobody is playing right now.' });
  assert.strictEqual(v0._ppWatch, undefined);
  assert.strictEqual(w.free().watchers.size, 0, 'an empty arena takes no watcher (it would never tick)');
  assert.strictEqual(w.arenas.all().length, arenasBefore, 'watchFor never opens an arena');

  const p = w.player('pat');
  for (const stake of [0.5, 1, 0.1, -1, '0', null, undefined, NaN, Infinity, {}, [0]]) {
    const s = w.sock();
    s.fire('pp:watch', { stake });
    assert.strictEqual(s.last('pp:watching').why, 'bad-stake', String(stake));
    assert.strictEqual(s._ppWatch, undefined);
  }
  for (const r of w.arenas.all()) if (r.stake > 0) assert.strictEqual(r.watchers.size, 0);

  // A seated socket (live unit) cannot watch.
  p.fire('pp:watch', { stake: 0 });
  assert.strictEqual(p.last('pp:watching').why, 'seated');
  assert.strictEqual(w.free().watchers.size, 0);
  assert.ok(w.free().hasLiveUnit(p.id), 'still playing');

  const many = [];
  for (let i = 0; i < WATCHERS_MAX; i++) {
    const s = w.sock();
    s.fire('pp:watch', { stake: 0 });
    assert.ok(!s.last('pp:watching').none);
    many.push(s);
  }
  const extra = w.sock();
  extra.fire('pp:watch', { stake: 0 });
  assert.strictEqual(extra.last('pp:watching').why, 'full');
  assert.strictEqual(w.free().watchers.size, WATCHERS_MAX);
  // A watcher asking again is not a new one: it gets the state again, still within the cap.
  many[0].fire('pp:watch', { stake: 0 });
  assert.ok(!many[0].last('pp:watching').none);
  assert.strictEqual(w.free().watchers.size, WATCHERS_MAX);
  assert.strictEqual(w.free().liveHumans, 1);
});

test('watchers get the same pp:s and pp:ev as the players, and pp:need is served to them', () => {
  const w = world();
  const p = w.player('pat');
  const v = w.sock();
  v.fire('pp:watch', { stake: 0 });
  const room = w.free();
  p.got.length = 0;
  v.got.length = 0;
  w.tick(room, 20);
  const pf = p.got.filter((x) => x[0] === 'pp:s').length;
  const vf = v.got.filter((x) => x[0] === 'pp:s').length;
  assert.ok(vf >= 9, 'frames: ' + vf);
  assert.strictEqual(vf, pf, 'every frame the player got');
  assert.strictEqual(v.all('pp:ev').length, p.all('pp:ev').length, 'every bundle the player got');
  v.fire('pp:need', { id: 0 });
  const geo = v.last('pp:geo');
  assert.ok(geo && Array.isArray(geo.ev) && geo.ev.length > 0);
  assert.strictEqual(v.all('pp:dead').length + v.all('pp:joined').length + v.all('pp:cashedout').length, 0);
});

test('a watching socket cannot join, respawn or steer on that socket; after pp:leave it can play', () => {
  const w = world();
  w.player('pat');
  const v = w.sock();
  v.fire('pp:watch', { stake: 0 });
  const before = counts(w);
  const consumed = w.spy.consume.length + w.spy.storeConsume.length;
  v.fire('pp:join', { name: 'v', stake: 0 });
  v.fire('pp:join', { name: 'v', stake: 0.5, entryToken: w.mint(0.5) });
  v.fire('pp:respawn', { entryToken: w.mint(0.5) });
  v.fire('pp:in', 12345);
  v.fire('pp:in', [1, 2, 3]);
  assert.deepStrictEqual(counts(w), before);
  assert.strictEqual(w.spy.consume.length + w.spy.storeConsume.length, consumed, 'no token was read');
  assert.strictEqual(v.last('pp:joined'), null);
  assert.strictEqual(v.last('pp:refused'), null);
  assert.strictEqual(w.free().watchers.size, 1);
  v.fire('pp:leave');
  assert.strictEqual(w.free().watchers.size, 0);
  assert.strictEqual(v._ppWatch, null);
  assert.ok(!v.rooms.has(w.free().ioRoom));
  v.fire('pp:join', { name: 'v', stake: 0 });
  assert.ok(v.last('pp:joined'), 'a socket that stopped watching plays as usual');
  assert.strictEqual(w.free().liveHumans, 2);
});

test('a dead player can watch: it leaves its own io room for the watched one', () => {
  const w = world();
  w.player('pat');
  const d = w.player('dee');
  const room = w.free();
  const seat = room.seatOfSocket(d.id);
  room.game.kill(seat.unit, undefined, REASON.SELF_CROSS);
  assert.ok(d.last('pp:dead'));
  d.fire('pp:watch', { stake: 0 });
  assert.ok(!d.last('pp:watching').none);
  assert.strictEqual(d._ppRoom, null);
  assert.strictEqual(d._ppWatch, room);
  assert.strictEqual(room.liveHumans, 1);
});

test('a watcher leaves on disconnect and on pp:leave, and never stays in a dead io room', () => {
  const w = world();
  w.player('pat');
  const room = w.free();
  const a = w.sock();
  const b = w.sock();
  a.fire('pp:watch', { stake: 0 });
  b.fire('pp:watch', { stake: 0 });
  assert.strictEqual(room.watchers.size, 2);
  a.disconnect();
  assert.strictEqual(room.watchers.size, 1);
  assert.ok(!room.watchers.has(a.id));
  b.fire('pp:leave');
  assert.strictEqual(room.watchers.size, 0);
  assert.strictEqual(room.liveHumans, 1, 'the player is untouched');
});

test('the last seat leaving lets every watcher go (told nobody), and watchers never arm the clock', () => {
  const w = world({ autoTick: true });
  const p = w.player('pat');
  const room = w.free();
  assert.ok(room.timer, 'a seat ticks the arena');
  const v = w.sock();
  v.fire('pp:watch', { stake: 0 });
  p.fire('pp:leave');
  assert.strictEqual(room.liveHumans, 0);
  assert.strictEqual(room.timer, null, 'no seat, no clock, whatever is watching');
  assert.strictEqual(room.watchers.size, 0);
  assert.deepStrictEqual(v.last('pp:watching'), { none: true, why: 'nobody' });
  assert.strictEqual(v._ppWatch, null);
  assert.ok(!v.rooms.has(room.ioRoom));
  // Directly: a watcher added to a seated arena never starts or keeps a timer of its own.
  const p2 = w.player('pia');
  const v2 = w.sock();
  v2.fire('pp:watch', { stake: 0 });
  room.removeHuman(room.seatOfSocket(p2.id).unit.id, REASON.FORCED_EXIT);
  assert.strictEqual(room.timer, null);
  room.stop();
});

test('emergencyClose and the sweep tell and drop their watchers; the new arena at that index has none', () => {
  const w = world();
  w.player('pat');
  const room = w.free();
  const v = w.sock();
  v.fire('pp:watch', { stake: 0 });
  room.emergencyClose();
  assert.ok(room.stopped);
  assert.strictEqual(room.watchers.size, 0);
  assert.deepStrictEqual(v.last('pp:watching'), { none: true, why: 'closed' });
  assert.strictEqual(v._ppWatch, null);
  assert.ok(!v.rooms.has(room.ioRoom), 'not in the dead io room');
  const fresh = w.free();
  assert.ok(fresh && fresh !== room && !fresh.stopped);
  assert.strictEqual(fresh.watchers.size, 0);
  // pp:watch skips a stopped arena (and the fresh one has nobody yet).
  v.fire('pp:leave');
  const v2 = w.sock();
  v2.fire('pp:watch', { stake: 0 });
  assert.strictEqual(v2.last('pp:watching').why, 'nobody');

  // The sweep: an empty overflow arena with a watcher left in it (added directly) goes, and tells it.
  const over = w.arenas._create(0, 1);
  const v3 = w.sock();
  assert.strictEqual(over.addWatcher(v3, 0), true);
  v3._ppWatch = over;
  w.arenas.sweep(w.clock.now());
  w.clock.advance(MP.ARENA_SWEEP_MS + 1000);
  w.arenas.sweep(w.clock.now());
  assert.ok(over.stopped && !w.arenas.all().includes(over));
  assert.deepStrictEqual(v3.last('pp:watching'), { none: true, why: 'closed' });
  assert.strictEqual(over.watchers.size, 0);
  assert.strictEqual(v3._ppWatch, null);
});

test('watchFor is pure: the free arena with the most players, never a paid one, never a new one', () => {
  const w = world();
  assert.strictEqual(w.arenas.watchFor(0), null);
  const n = w.arenas.all().length;
  for (let i = 0; i < MP.MAX_HUMANS + 2; i++) w.player('p' + i); // the free table overflows into #1
  const list = w.arenas.all().filter((r) => r.stake === 0);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(w.arenas.watchFor(0), list.find((r) => r.index === 0));
  assert.strictEqual(w.arenas.watchFor(0.5), null);
  assert.strictEqual(w.arenas.watchFor('x'), null);
  assert.strictEqual(w.arenas.all().length, n + 1, 'only the players opened an arena');
});

test('hostile pp:watch payloads are ignored or refused, never throw, and never read a token', () => {
  const w = world();
  w.player('pat');
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const shapes = [undefined, null, 0, 5, 'x', true, [], [0], () => 1,
      { stake: { valueOf: () => 0 } }, { stake: { toString: 1 } }, { stake: 0, after: {} }, { stake: 0, after: -1 },
      { stake: 0, after: 1e300 }, { stake: 0, after: '3' }, { stake: 0, after: NaN }, { stake: 0, after: [1] },
      { stake: 0, entryToken: w.mint(0.5), resumeKey: 'rk', name: '<b>x</b>' }, { __proto__: { stake: 0 } },
      JSON.parse('{"__proto__": {"stake": 0}, "stake": 0}')];
    for (const msg of shapes) {
      const s = w.sock();
      assert.doesNotThrow(() => s.fire('pp:watch', msg));
      const ans = s.last('pp:watching');
      if (ans && !ans.none) assert.ok(w.free().watchers.has(s.id));
    }
  } finally {
    console.error = orig;
  }
  assert.deepStrictEqual(errors, [], 'no handler threw');
  assert.strictEqual(w.spy.consume.length + w.spy.storeConsume.length, 1, 'only the player join touched the door');
  assert.strictEqual(w.free().liveHumans, 1);
});

test('pp:watch is rate limited per socket (ppwatch, 1000 ms)', () => {
  const w = world({ rateLimit: true });
  w.player('pat');
  const v = w.sock();
  v.fire('pp:watch', { stake: 0 });
  v.fire('pp:watch', { stake: 0 });
  v.fire('pp:watch', { stake: 0.5 });
  assert.strictEqual(v.all('pp:watching').length, 1, 'one answer inside the window');
  assert.ok(v._rl && v._rl.ppwatch > 0);
  v._rl.ppwatch -= 1000; // the window passed
  v.fire('pp:watch', { stake: 0 });
  assert.strictEqual(v.all('pp:watching').length, 2);
  assert.strictEqual(w.free().watchers.size, 1, 'asked twice, watching once');
});
