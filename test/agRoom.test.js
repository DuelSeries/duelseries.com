'use strict';
// agar.io room (build brief 9.3 agRoom card), on the FIXTURE law table: the law gate, the drift-free clock at L1,
// the join order on the wire (protocol semantics 2, 3.8), leaving, THE ONE RULE and the bot fill, the owner
// console contract, the backlog guard, the leaderboard and spectate records, and the emergency close.
const test = require('node:test');
const assert = require('node:assert');
const W = require('../shared/agWire');
const L = require('../server/ag/agLaws');
const { AgRoom, ROOM_TUNING } = require('../server/ag/agRoom');
const { FIXTURE, makeFixture } = require('./agLawsFixture');

const TICK = FIXTURE.L1.value;
const CAP = FIXTURE.L39.value;
const quiet = { error() {}, warn() {}, log() {} };

function room(opts) {
  return new AgRoom(Object.assign({ laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: quiet }, opts));
}

let sn = 0;
function sock(id) {
  return {
    id: id || 'sk' + ++sn,
    conn: { writeBuffer: [] },
    got: [],
    emit(ev, buf) {
      assert.strictEqual(ev, 'ag:f');
      const recs = W.decodeBundle(buf);
      for (const r of recs) assert.notStrictEqual(r.t, 'error', 'bundle does not decode: ' + JSON.stringify(r));
      this.got.push(recs);
    },
    last() { return this.got[this.got.length - 1]; },
  };
}

function kinds(recs) {
  return recs.map((r) => r.t);
}

test('the room refuses a law table that is not shippable', () => {
  assert.throws(() => new AgRoom({ laws: FIXTURE, autoTick: false, log: quiet }), /not shippable.*FIXTURE/);
  // The real table passes the gate (every row approved 2026-10-02) and the sim builds every rule it names, so a
  // room opens on it; a rule name the sim does not build is still refused.
  assert.doesNotThrow(() => L.assertShippable(L.LAWS));
  const real = new AgRoom({ autoTick: false, log: quiet });
  assert.strictEqual(real.laws, L.LAWS);
  assert.strictEqual(real.tickOnce(), true);
  real.stop();
  assert.throws(() => new AgRoom({ laws: L.withValues(L.LAWS, { L29: { rule: 'halving', minPieceMass: 20 } }),
    autoTick: false, log: quiet }), /L29 rule "halving" is not implemented/);
  // A table missing a row the room reads is refused even in tests.
  assert.throws(() => room({ laws: L.withValues(FIXTURE, { U_BOARD: null }) }), /U_BOARD/);
  assert.throws(() => room({ laws: makeFixture({ U_SPECTATE: { afterDeath: 'x', follow: 'top', zoom: 'followedPlayer' } }) }),
    /U_SPECTATE/);
});

test('one step is one tick of L1 ms, run by a drift-free clock', () => {
  let t = 1000;
  const r = room({ clock: () => t });
  assert.strictEqual(r.tickMs, TICK);
  const s = sock();
  r.addSocket(s);
  r.last = t;
  r.acc = 0;
  // Jittered wakes: the steps run always equal the whole ticks of elapsed time.
  const gaps = [3, 17, 41, 9, 66, 1, 39, 40, 80, 12, 27, 33];
  let elapsed = 0;
  let ran = 0;
  for (const g of gaps) {
    t += g;
    elapsed += g;
    ran += r.wake();
    assert.strictEqual(ran, Math.floor(elapsed / TICK), 'after ' + elapsed + ' ms');
    assert.strictEqual(r.sim.tick(), ran);
    assert.ok(r._dueIn() > 0 && r._dueIn() <= TICK);
  }
  // A long stall runs at most MAX_STEPS_PER_WAKE steps and drops the rest, never one long step.
  const before = r.sim.tick();
  t += TICK * 50 + 7;
  assert.strictEqual(r.wake(), ROOM_TUNING.MAX_STEPS_PER_WAKE.value);
  assert.strictEqual(r.sim.tick() - before, ROOM_TUNING.MAX_STEPS_PER_WAKE.value);
  assert.ok(r.acc >= 0 && r.acc < TICK);
});

test('the clock runs while a socket is seated and sleeps when the last one goes', async () => {
  const r = room({ autoTick: true });
  assert.strictEqual(r.timer, null);
  const s = sock();
  r.addSocket(s);
  assert.ok(r.timer);
  await new Promise((res) => setTimeout(res, TICK * 3 + 30));
  assert.ok(s.got.length >= 1, 'ticks ran on the timer');
  r.removeSocket(s.id);
  assert.strictEqual(r.timer, null);
  r.stop();
});

test('join order on the wire: hello, border (FFA), a world update, then the own id before its cell', () => {
  const r = room();
  const s = sock();
  r.addSocket(s);
  r.tickOnce();
  // A fresh socket is sent a world update before it asks to play (protocol semantics 2.3).
  assert.deepStrictEqual(kinds(s.got[0]).slice(0, 3), ['hello', 'border', 'world']);
  assert.strictEqual(s.got[0][1].mode, 0);
  assert.strictEqual(s.got[0].filter((x) => x.t === 'own').length, 0);
  assert.strictEqual(r.join(s.id, 'Owen'), 'ok');
  r.tickOnce();
  const recs = s.last();
  const ownAt = recs.findIndex((x) => x.t === 'own');
  assert.ok(ownAt >= 0, 'own id announced');
  const id = recs[ownAt].id;
  const worldAt = recs.findIndex((x) => (x.t === 'world' || x.t === 'sync') && x.cells.some((c) => c.id === id));
  assert.ok(worldAt > ownAt, 'the own id comes before the world record that first carries the cell');
  const cell = recs[worldAt].cells.find((c) => c.id === id);
  assert.ok(cell.rgb, 'colour on the first record');
  assert.strictEqual(cell.name, 'Owen');
  // Never announced twice.
  r.tickOnce();
  assert.strictEqual(s.last().filter((x) => x.t === 'own').length, 0);

  // Connect and Play before the first tick: hello, border, an empty world, the own id, the world with the cell.
  const s2 = sock();
  r.addSocket(s2);
  r.join(s2.id, 'Two');
  r.tickOnce();
  assert.deepStrictEqual(kinds(s2.got[0]).slice(0, 5), ['hello', 'border', 'world', 'own', 'world']);
  assert.deepStrictEqual(s2.got[0][2], { t: 'world', eats: [], cells: [], removed: [] });
  assert.ok(s2.got[0][4].cells.some((c) => c.id === s2.got[0][3].id));
});

test('every bundle is one emit per socket per tick, and a repeated Play never renames a live player', () => {
  const r = room();
  const s = sock();
  r.addSocket(s);
  r.join(s.id, 'First');
  assert.strictEqual(r.join(s.id, 'Second'), 'alive');
  r.tickOnce();
  assert.strictEqual(r.join(s.id, 'Third'), 'alive');
  r.tickOnce();
  assert.strictEqual(s.got.length, 2);
  assert.strictEqual(r.sim.playerInfo(r.seatOf(s.id).pid).name, 'First');
});

test('a leaving player has its cells removed at once (LEAVE_RULE)', () => {
  const r = room();
  const a = sock();
  const b = sock();
  r.addSocket(a);
  r.addSocket(b);
  r.join(a.id, 'Leaver');
  r.tickOnce();
  const pid = r.seatOf(a.id).pid;
  const ids = r.sim.playerInfo(pid).cells.slice();
  assert.strictEqual(ids.length, 1);
  assert.strictEqual(r.liveHumans, 1);
  r.removeSocket(a.id);
  assert.strictEqual(r.liveHumans, 0);
  r.tickOnce();
  assert.strictEqual(r.sim.playerInfo(pid), null);
  for (const id of ids) assert.strictEqual(r.sim.getCell(id), null);
  // The other socket saw the cell removed (if it ever had it in view).
  const seen = b.got.some((recs) => recs.some((x) => x.t === 'world' && x.cells.some((c) => c.id === ids[0])));
  if (seen) assert.ok(b.last().some((x) => x.t === 'world' && x.removed.includes(ids[0])));
});

test('THE ONE RULE: a free room fills bots to the room size, a paid room never has one', () => {
  const r = room();
  assert.ok(r.isFree() && r.botsAllowed());
  assert.strictEqual(r.botCount, CAP);
  const s = sock();
  r.addSocket(s);
  assert.strictEqual(r.botCount, CAP, 'a watcher is not a player');
  r.join(s.id, 'Human');
  r.tickOnce();
  assert.strictEqual(r.botCount, CAP - 1, 'one bot makes room for the human');
  r.tickOnce();
  assert.strictEqual(r.sim.counts().players, CAP);
  r.removeSocket(s.id);
  r.tickOnce();
  assert.strictEqual(r.botCount, CAP);

  const paid = room({ stake: 0.1 });
  assert.strictEqual(paid.isFree(), false);
  assert.strictEqual(paid.botsAllowed(), false);
  assert.strictEqual(paid.botCount, 0);
  assert.strictEqual(paid.addBot(), null);
  paid.fillBots();
  paid.tickOnce();
  assert.strictEqual(paid.botCount, 0);
  assert.strictEqual(paid.sim.counts().bots, 0);
});

test('bots play: they move, eat and respawn on their own', () => {
  const r = room();
  const pos = new Map();
  r.sim.forEachPlayer((p) => { if (p.bot) pos.set(p.pid, null); });
  for (let i = 0; i < 400; i++) r.tickOnce();
  let moved = 0;
  let grew = 0;
  r.sim.forEachPlayer((p) => {
    if (!p.bot || !p.cells.length) return;
    const c = r.sim.getCell(p.cells[0]);
    if (c && p.score > L.massOf(FIXTURE.L14.value) + 1) grew++;
    if (p.target) moved++;
  });
  assert.ok(moved > CAP / 2, 'bots steer (' + moved + ')');
  assert.ok(grew > 0, 'bots eat');
  assert.strictEqual(r.botCount, CAP);
  assert.ok(r.sim.counts().alive >= CAP - 2, 'dead bots come back');
});

test('owner console: playerCount, botCount, addBot by hand, clearBots and the pause window', () => {
  let wall = 5000;
  const r = room({ now: () => wall });
  assert.match(r.lobbyType, /^ag_na_s0$/);
  assert.strictEqual(room({ index: 2 }).lobbyType, 'ag_na_s0#2');
  assert.strictEqual(r.playerCount, 0);
  const b = r.addBot();
  assert.ok(b && b.manual === true);
  r.tickOnce();
  assert.strictEqual(r.botCount, CAP + 1, 'a bot added by hand is on top of the fill');
  const n = r.clearBots();
  assert.strictEqual(n, CAP + 1);
  assert.strictEqual(r.botCount, 0);
  // The console's Clear holds the fill off until its window ends.
  r._botsPausedUntil = wall + 1000;
  r.tickOnce();
  assert.strictEqual(r.botCount, 0);
  wall += 1001;
  r.tickOnce();
  assert.strictEqual(r.botCount, CAP);
  // drainStatus sees the humans and no money.
  const s = sock();
  r.addSocket(s);
  r.join(s.id, 'P');
  r.tickOnce();
  const snakes = Array.from(r.snakes.values());
  assert.strictEqual(snakes.length, 1);
  assert.strictEqual(snakes[0].worth, 0);
  assert.strictEqual(snakes[0].isBot, false);
  assert.strictEqual(r.playerCount, 1);
});

test('backlog guard: a backed-up socket skips its tick, then gets one sync record', () => {
  const r = room();
  const s = sock();
  r.addSocket(s);
  r.join(s.id, 'Slow');
  r.tickOnce();
  r.tickOnce();
  const sent = s.got.length;
  const depth = FIXTURE.WIRE_BACKLOG.value;
  s.conn.writeBuffer = new Array(depth + 1);
  r.tickOnce();
  r.tickOnce();
  assert.strictEqual(s.got.length, sent, 'nothing sent while the buffer is deeper than WIRE_BACKLOG');
  s.conn.writeBuffer = new Array(depth);
  r.tickOnce();
  assert.strictEqual(s.got.length, sent + 1);
  const recs = s.last();
  assert.ok(recs.some((x) => x.t === 'sync'), 'one sync record after the drain');
  assert.ok(!recs.some((x) => x.t === 'world'));
  r.tickOnce();
  assert.ok(!s.last().some((x) => x.t === 'sync'));
  assert.strictEqual(r.stats.skipped, 2);
});

test('leaderboard on the U_BOARD cadence: top rows, own row flagged, own row appended when outside', () => {
  const r = room();
  const s = sock();
  r.addSocket(s);
  r.join(s.id, 'Me');
  const P = FIXTURE.U_BOARD.value.periodMs;
  const every = Math.ceil(P / TICK);
  const n = FIXTURE.U_BOARD.value.rows;
  const outside = FIXTURE.U_BOARD.value.ownRowWhenOutside;
  const pid = r.seatOf(s.id).pid;
  const boardTicks = [];
  let checkedAlive = 0;
  for (let i = 1; i <= every * 6; i++) {
    r.join(s.id, 'Me');           // respawn whenever a bot ate us ('alive' otherwise)
    r.tickOnce();
    const b = s.last().find((x) => x.t === 'board');
    if (!b) continue;
    boardTicks.push(r.sim.tick());
    // The ranking the room used this tick (nothing changed since).
    const ranking = r._ranking();
    const rows = b.rows;
    const top = Math.min(n, ranking.length);
    for (let k = 0; k < top; k++) {
      assert.strictEqual(rows[k].name || '', ranking[k].name);
      assert.strictEqual(!!rows[k].me, ranking[k].pid === pid);
    }
    const myRank = ranking.findIndex((p) => p.pid === pid);
    if (myRank < 0) {
      assert.strictEqual(rows.length, top, 'no own row while dead');
      continue;
    }
    checkedAlive++;
    if (myRank < n || !outside) {
      assert.strictEqual(rows.length, top);
    } else {
      assert.strictEqual(rows.length, n + 1);
      assert.deepStrictEqual(rows[n], { me: true, name: 'Me', rank: myRank + 1 });
    }
  }
  // One board per periodMs of room time: as many as whole periods fit, each gap the period rounded either way.
  const total = r.sim.tick();
  assert.strictEqual(boardTicks.length, Math.floor((total * TICK) / P));
  for (let i = 1; i < boardTicks.length; i++) {
    const gap = boardTicks[i] - boardTicks[i - 1];
    assert.ok(gap === Math.floor(P / TICK) || gap === Math.ceil(P / TICK), 'gap ' + gap);
  }
  assert.ok(checkedAlive > 0);
});

test('spectate: only without live cells; the cam record follows the top player at its view scale', () => {
  const r = room();
  const s = sock();
  r.addSocket(s);
  r.join(s.id, 'Alive');
  r.tickOnce();
  assert.strictEqual(r.spectate(s.id), false, 'a live player cannot spectate');
  const w = sock();
  r.addSocket(w);
  r.tickOnce();
  assert.ok(!w.last().some((x) => x.t === 'cam'), 'no camera after death or before play until asked (stayWhereDied)');
  assert.strictEqual(r.spectate(w.id), true);
  r.tickOnce();
  const cam = w.last().find((x) => x.t === 'cam');
  assert.ok(cam, 'a cam record every bundle while spectating');
  const top = r._ranking()[0];
  const info = r.sim.playerInfo(top.pid);
  let sx = 0, sy = 0, sum = 0;
  for (const id of info.cells) { const c = r.sim.getCell(id); sx += c.x; sy += c.y; sum += c.size; }
  assert.strictEqual(cam.x, Math.fround(sx / info.cells.length));
  assert.strictEqual(cam.y, Math.fround(sy / info.cells.length));
  const v = FIXTURE.L4.value;
  assert.strictEqual(cam.zoom, Math.fround(Math.max(Math.pow(Math.min(v.ref / sum, 1), v.exp), v.minScale)));
  // Play again ends spectating.
  r.join(w.id, 'Back');
  r.tickOnce();
  r.tickOnce();
  assert.ok(!w.last().some((x) => x.t === 'cam'));
});

test('three throwing ticks in a row close the room and hand its sockets over', () => {
  const r = room();
  const s = sock();
  r.addSocket(s);
  let handed = null;
  r.onClosed = (closed, sockets) => { handed = { closed, sockets }; };
  const step = r.sim.step;
  r.sim.step = () => { throw new Error('boom'); };
  assert.strictEqual(r.tickOnce(), false);
  assert.strictEqual(r.tickOnce(), false);
  assert.strictEqual(r.stopped, false);
  assert.strictEqual(r.tickOnce(), false);
  assert.strictEqual(r.stopped, true);
  assert.strictEqual(handed.closed, r);
  assert.deepStrictEqual(handed.sockets.map((x) => x.id), [s.id]);
  r.sim.step = step;
  assert.strictEqual(r.tickOnce(), false, 'a stopped room never ticks');
  assert.strictEqual(r.addSocket(sock()), null);
  assert.strictEqual(r.join(s.id, 'x'), 'stopped');
});

test('a socket moved in from elsewhere gets clearAll first, then the join order', () => {
  const r = room();
  const s = sock();
  r.addSocket(s, { clearFirst: true });
  r.tickOnce();
  assert.deepStrictEqual(kinds(s.got[0]).slice(0, 4), ['clearAll', 'hello', 'border', 'world']);
  r.tickOnce();
  assert.ok(!s.last().some((x) => x.t === 'clearAll'));
});

test('two rooms with the same seed and the same inputs send the same bytes', () => {
  const run = () => {
    const r = room({ seed: 99 });
    const bytes = [];
    const s = { id: 'same', conn: { writeBuffer: [] }, emit(ev, b) { bytes.push(Buffer.from(b).toString('base64')); } };
    r.addSocket(s);
    r.join('same', 'Twin');
    for (let i = 0; i < 300; i++) {
      r.target('same', (i * 37) % 2000 - 1000, (i * 53) % 2000 - 1000);
      if (i % 50 === 0) r.split('same');
      if (i % 70 === 0) r.eject('same');
      r.tickOnce();
    }
    return bytes;
  };
  const a = run();
  const b = run();
  assert.strictEqual(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) assert.fail('bundle ' + i + ' differs');
});

test('the room file holds no fixture import and no game number of its own', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../server/ag/agRoom.js'), 'utf8');
  assert.doesNotMatch(src, /agLawsFixture'\)|require\([^)]*agLawsFixture/);
  assert.doesNotMatch(src, /Math\.random/);
  assert.doesNotMatch(src, /\b[DW]\s+\d{3,}/);
  for (const c of ['14142', '780', '0.0122', '36.06', '42.43', '1500', '31.62']) assert.ok(!src.includes(c), c);
});

test('the map follows the head count (agMap): full with the bots, shrinking once they are cleared', () => {
  const agMap = require('../server/ag/agMap');
  let wall = 0;
  const r = room({ now: () => wall });
  const s = sock();
  r.addSocket(s);
  r.join(s.id, 'Alone');
  const full = agMap.targetSide(CAP, FIXTURE);
  // Grow to full size with the room filled.
  const growTicks = Math.ceil((full / agMap.growRate(FIXTURE)) * 1000 / TICK) + 5;
  let widest = 0;
  for (let i = 0; i < growTicks; i++) {
    r.join(s.id, 'Alone');
    r.tickOnce();
    const g = r.sim.border();
    widest = Math.max(widest, g.maxX - g.minX);
  }
  assert.strictEqual(widest, full, 'the map reached its full side');
  let b = r.sim.border();
  const atClear = b.maxX - b.minX;
  // The console clears the bots and holds the fill off: one player left, the map waits, then shrinks.
  r.clearBots();
  r._botsPausedUntil = wall + 1e9;
  const waitTicks = FIXTURE.MAP_SHRINK_DELAY_MS.value / TICK;
  for (let i = 0; i < waitTicks - 2; i++) { r.join(s.id, 'Alone'); r.tickOnce(); }
  b = r.sim.border();
  assert.strictEqual(b.maxX - b.minX, atClear, 'no shrink before the wait');
  for (let i = 0; i < 50; i++) { r.join(s.id, 'Alone'); r.tickOnce(); }
  b = r.sim.border();
  assert.ok(b.maxX - b.minX < atClear, 'shrinking');
  // The client was told: a border-only resend (no mode) carries the new size.
  const last = s.got.flat().filter((x) => x.t === 'border').pop();
  assert.strictEqual(last.mode, undefined);
  assert.strictEqual(last.maxX, b.maxX);
});

// Review 2026-10-02, finding 1/5: watcher seats are capped per room, so connections cannot grow the tick.
test('watcher seats are capped at WATCHERS_PER_SLOT times L39; a socket about to Play needs a player slot', () => {
  assert.strictEqual(ROOM_TUNING.WATCHERS_PER_SLOT.status, 'CHOSEN');
  const r = room();
  assert.strictEqual(r.watchCap, Math.floor(CAP * ROOM_TUNING.WATCHERS_PER_SLOT.value));
  assert.ok(r.watchCap >= 1);
  const watchers = [];
  for (let i = 0; i < r.watchCap; i++) {
    const s = sock();
    assert.ok(r.addSocket(s), 'watcher ' + i + ' seated');
    watchers.push(s);
  }
  assert.strictEqual(r.watcherCount, r.watchCap);
  assert.strictEqual(r.hasWatchSpace(), false);
  const late = sock();
  const playersBefore = r.sim.counts().players;
  assert.strictEqual(r.addSocket(late), null, 'past the cap a watcher gets no seat');
  assert.strictEqual(r.sim.counts().players, playersBefore, 'and no sim player');
  // A socket whose Play comes next is seated on a player slot, and joining frees a watcher seat.
  assert.ok(r.addSocket(late, { forPlay: true }));
  assert.strictEqual(r.join(late.id, 'Late'), 'ok');
  assert.strictEqual(r.join(watchers[0].id, 'W0'), 'ok');
  assert.strictEqual(r.watcherCount, r.watchCap - 1);
  assert.ok(r.addSocket(sock()), 'the freed watcher seat is taken');
  // 3,000 sockets at one room (the review's load): the seats, and the bundles per tick, stay bounded.
  for (let i = 0; i < 3000; i++) r.addSocket(sock());
  assert.ok(r.seats.size <= CAP + r.watchCap, 'seats ' + r.seats.size);
  const t0 = r.stats.bundles;
  r.tickOnce();
  assert.ok(r.stats.bundles - t0 <= CAP + r.watchCap);
  // A full room with no player slot refuses forPlay too.
  const small = room({ laws: makeFixture({ L39: 1 }) });
  const p = sock();
  small.addSocket(p);
  small.join(p.id, 'P');
  assert.strictEqual(small.addSocket(sock(), { forPlay: true }), null);
  assert.ok(small.addSocket(sock()), 'a watcher seat is still free');
  assert.strictEqual(small.addSocket(sock()), null);
});

// Review 2026-10-02, finding 2: connections that open and close on an idle room leave nothing behind.
test('connect and disconnect on an idle room never pile up sim players or queued commands', () => {
  const r = room();
  const base = r.sim.counts().players;
  const queued = r.sim.snapshot().queued.length;
  for (let i = 0; i < 20000; i++) {
    const s = sock();
    r.addSocket(s);
    if (i % 2) r.join(s.id, 'Flash');   // a Play queued in the same idle window
    r.removeSocket(s.id);
  }
  assert.strictEqual(r.seats.size, 0);
  assert.strictEqual(r.sim.counts().players, base, 'no player left behind');
  assert.strictEqual(r.sim.snapshot().queued.length, queued, 'no command left behind');
  assert.strictEqual(r.tickOnce(), true);
  // A player with cells still loses them at the next step (LEAVE_RULE), not before.
  const s = sock();
  r.addSocket(s);
  r.join(s.id, 'Stay');
  r.tickOnce();
  const pid = r.seatOf(s.id).pid;
  const cells = r.sim.playerInfo(pid).cells.slice();
  assert.ok(cells.length > 0);
  r.removeSocket(s.id);
  assert.ok(r.sim.playerInfo(pid), 'still there until the step');
  r.tickOnce();
  assert.strictEqual(r.sim.playerInfo(pid), null);
  for (const id of cells) assert.strictEqual(r.sim.getCell(id), null);
});

// Review 2026-10-02, finding 6: a bundle that never reached the page is not counted as delivered.
test('an emit or a build that throws starts the page over: clearAll, then the own id before its cell', () => {
  for (const where of ['emit', 'build']) {
    const r = room();
    const s = sock();
    r.addSocket(s);
    r.tickOnce();
    r.tickOnce();
    assert.strictEqual(r.join(s.id, 'Lost'), 'ok');
    const realEmit = s.emit;
    const seat = r.seatOf(s.id);
    if (where === 'emit') {
      s.emit = function () { s.emit = realEmit; throw new Error('socket gone for a moment'); };
    } else {
      const v = seat.viewer;
      const build = v.build;
      v.build = (frame, extra) => { build(frame, extra); throw new Error('encode failed after the bookkeeping'); };
    }
    const sent = s.got.length;
    r.tickOnce();   // the bundle with the own id and the new cell is lost
    assert.strictEqual(s.got.length, sent, where + ': nothing reached the page');
    assert.strictEqual(r.stats[where === 'emit' ? 'emitErrors' : 'buildErrors'], 1);
    assert.strictEqual(r.stats.viewRestarts, 1);
    r.tickOnce();
    const recs = s.last();
    assert.strictEqual(recs[0].t, 'clearAll', where + ': the page starts over');
    assert.deepStrictEqual(kinds(recs).slice(1, 3), ['hello', 'border']);
    const pidCells = new Set(r.sim.playerInfo(seat.pid).cells);
    assert.ok(pidCells.size > 0);
    for (const id of pidCells) {
      const ownAt = recs.findIndex((x) => x.t === 'own' && x.id === id);
      const worldAt = recs.findIndex((x) => (x.t === 'world' || x.t === 'sync') && x.cells.some((c) => c.id === id));
      assert.ok(ownAt >= 0 && worldAt > ownAt, where + ': own id ' + id + ' announced before its cell');
      assert.ok(recs[worldAt].cells.find((c) => c.id === id).rgb, where + ': with its colour');
    }
    r.tickOnce();
    assert.ok(!s.last().some((x) => x.t === 'clearAll' || x.t === 'own'), where + ': once only');
  }
});

test('the real table sends the leaderboard on every 25th tick exactly (U_BOARD measured: every 25 updates)', () => {
  assert.strictEqual(L.LAWS.U_BOARD.value.periodMs, 25 * L.LAWS.L1.value);
  const r = new AgRoom({ autoTick: false, seed: 3, log: quiet });
  assert.strictEqual(r.boardEvery, 25);
  // Counted in whole ticks: no floating point drift, however long the room runs.
  for (let t = 1; t <= 2000000; t++) {
    if (r._boardDue(t) !== (t % 25 === 0)) assert.fail('board due at tick ' + t + ' is ' + r._boardDue(t));
  }
  const s = sock();
  r.addSocket(s);
  r.join(s.id, 'Me');
  const boards = [];
  for (let i = 0; i < 100; i++) {
    r.tickOnce();
    const b = s.last().find((x) => x.t === 'board');
    if (b) {
      boards.push(r.sim.tick());
      // The whole room (up to 200 rows): every alive player of the L39 seats.
      assert.strictEqual(b.rows.length, r._ranking().length);
      assert.ok(b.rows.length > 40 && b.rows.length <= L.LAWS.L39.value, 'rows ' + b.rows.length);
    }
  }
  assert.deepStrictEqual(boards, [25, 50, 75, 100]);
  r.stop();
  // A period that is not a whole number of ticks keeps the time rule.
  const odd = room({ laws: makeFixture({ U_BOARD: { rows: 10, periodMs: 2.5 * TICK, ownRowWhenOutside: false } }) });
  assert.strictEqual(odd.boardEvery, null);
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map((t) => odd._boardDue(t)), [false, false, true, false, true, false]);
  odd.stop();
});
