'use strict';
// What each Chomp page is sent (night review 2026-10-29, finding 18): a paid arena wider or taller than
// PAID_SEND_TILES sends each page only the chompers and ghosts in the window round the chomper it plays or follows
// (every ghost slot kept, the far ones AWAY); a smaller paid arena and every free one keep the one shared snapshot;
// the page zooms in to at most PAID_VIEW_TILES there and never draws an AWAY ghost.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../shared/chompRules');
const Maze = require('../shared/chompMaze');
const Wire = require('../shared/chompWire');
const Ghosts = require('../server/chomp/chompGhosts');
const { ChompRoom } = require('../server/chomp/chompRoom');

const quiet = { error() {}, warn() {}, log() {} };
const noop = () => {};
const HOOKS = {
  onCashout: noop, onRefund: noop, onTransfer: noop, onFeed: noop, onBreach: noop, onStake: noop, onHouse: noop,
  onOwed: noop, onSeedBack: noop, onSeedSpent: noop, onSweep: noop, onFloor: noop, onAccountOpen: noop,
  onAccountConfirmed: noop, onAccountClosed: noop,
};

// A fake socket.io namespace: its rooms, its sockets, and what each socket was sent.
function fakeNsp() {
  const nsp = {
    adapter: { rooms: new Map() }, sockets: new Map(), shared: [],
    to: () => ({ emit() {}, volatile: { emit: (ev, buf) => nsp.shared.push([ev, buf]) } }),
  };
  return nsp;
}

let sn = 0;
function sock(nsp, id) {
  const s = {
    id: id || 'ac' + ++sn, events: [],
    emit(ev, p) { this.events.push([ev, p]); },
    get volatile() { return { emit: (ev, p) => s.events.push([ev, p]) }; },
    join(r) {
      if (!nsp) return;
      if (!nsp.adapter.rooms.has(r)) nsp.adapter.rooms.set(r, new Set());
      nsp.adapter.rooms.get(r).add(this.id);
    },
    leave(r) { if (nsp && nsp.adapter.rooms.has(r)) nsp.adapter.rooms.get(r).delete(this.id); },
  };
  if (nsp) nsp.sockets.set(s.id, s);
  return s;
}

function paidRoom(opts) {
  const clock = { t: 5000000 };
  const r = new ChompRoom(Object.assign({ mx: 1, my: 1, seed: 11, stake: 0.5, moneyHooks: HOOKS, now: () => clock.t,
    log: quiet, grow: false }, opts));
  r.ghosts = [];
  return r;
}

function seat(r, name, micro, nsp) {
  const s = sock(nsp || null, name);
  const acct = r.addPaidHuman(s, { name, micro: micro || 500000, wallet: 'W-' + name, paid: (micro || 500000) / 1e6 });
  assert.ok(acct && typeof acct === 'object', 'seated: ' + acct);
  assert.strictEqual(r.ready(s.id), true);
  const p = r.players.get(acct.pid);
  p.safe = 0;
  return { s, p };
}

function decodeLast(s) {
  const snaps = s.events.filter((e) => e[0] === 'c:s');
  assert.ok(snaps.length, s.id + ' got a snapshot');
  return Wire.decode(snaps[snaps.length - 1][1]);
}

// A paid arena 4 modules wide (116 x 32 tiles): wider than PAID_SEND_TILES, so it cuts.
function bigPaid() {
  const nsp = fakeNsp();
  const r = paidRoom({ nsp, mx: 4, my: 1 });
  assert.ok(r.A.W > R.PAID_SEND_TILES && r.culls());
  r.ghosts = Ghosts.makeGhosts(r.A);
  r.ghosts.forEach((g) => { g.state = 'active'; });
  return { nsp, r };
}

function onPathNear(r, x, y) {
  for (let d = 0; d < 40; d++) for (let dx = -d; dx <= d; dx++) for (let dy = -d; dy <= d; dy++) {
    const c = r.A.wc(Math.floor(x) + dx), rr = r.A.wr(Math.floor(y) + dy);
    if (r.A.walk(c, rr)) return [c + 0.5, rr + 0.5];
  }
  throw new Error('no path tile');
}

function put(r, p, x, y) {
  const [px, py] = onPathNear(r, x, y);
  p.x = px; p.y = py; p.dir = -1; p.want = -1; p.hist = [];
}

test('finding 18: a big paid arena sends each seat only the window round its own chomper, every ghost slot kept', () => {
  const { nsp, r } = bigPaid();
  const a = seat(r, 'ann', 900000, nsp), b = seat(r, 'bob', 400000, nsp);
  put(r, a.p, 10, 10); put(r, b.p, 10 + r.A.W / 2, 10);          // half the torus apart: 58 tiles
  r.flush();
  assert.strictEqual(nsp.shared.length, 0, 'no shared snapshot');
  const sa = decodeLast(a.s), sb = decodeLast(b.s);
  assert.deepStrictEqual(sa.players.map((q) => q.id), [a.p.id], 'ann does not get bob');
  assert.deepStrictEqual(sb.players.map((q) => q.id), [b.p.id], 'bob does not get ann');
  for (const [snap, me] of [[sa, a.p], [sb, b.p]]) {
    assert.strictEqual(snap.ghosts.length, r.ghosts.length, 'every ghost keeps its place');
    snap.ghosts.forEach((g, i) => {
      const real = r.ghosts[i];
      const near = Math.abs(r.A.dx(me.x, real.x)) <= R.PAID_SEND_TILES / 2 && Math.abs(r.A.dy(me.y, real.y)) <= R.PAID_SEND_TILES / 2;
      if (near) {
        assert.notStrictEqual(g.state, Wire.AWAY);
        assert.ok(Math.abs(g.x - real.x) < 0.02 && Math.abs(g.y - real.y) < 0.02, 'a near ghost where it is');
      } else {
        assert.strictEqual(g.state, Wire.AWAY, 'a far ghost is AWAY');
        assert.ok(Math.abs(r.A.dx(me.x, g.x)) > R.PAID_VIEW_TILES / 2, 'and set where no screen shows it');
      }
      assert.strictEqual(g.kind, real.ki);
    });
    assert.ok(snap.ghosts.some((g) => g.state === Wire.AWAY) && snap.ghosts.some((g) => g.state !== Wire.AWAY));
  }
  // bob walks within the window: ann gets him
  put(r, b.p, 10 + R.PAID_SEND_TILES / 2 - 8, 12);
  r.flush();
  assert.deepStrictEqual(decodeLast(a.s).players.map((q) => q.id).sort(), [a.p.id, b.p.id].sort());
});

test('finding 18: a watcher gets the leader\'s window, follows only a chomper in it, and an ended seat stays on its spot', () => {
  const { nsp, r } = bigPaid();
  const a = seat(r, 'ann', 900000, nsp), b = seat(r, 'bob', 400000, nsp), c = seat(r, 'cid', 300000, nsp);
  put(r, a.p, 10, 10); put(r, b.p, 10 + r.A.W / 2, 10); put(r, c.p, 10 + 30, 10);
  const w = sock(nsp, 'spectator');
  assert.strictEqual(r.addWatcher(w), true);
  r.flush();
  let ids = decodeLast(w).players.map((q) => q.id).sort();
  assert.deepStrictEqual(ids, [a.p.id, c.p.id].sort(), 'the richest (ann) and who is near her');
  assert.strictEqual(r.watch(w.id, b.p.id), false, 'bob is outside the window: no jump across the arena');
  assert.strictEqual(r.watch(w.id, c.p.id), true, 'cid is in it');
  r.flush();
  ids = decodeLast(w).players.map((q) => q.id).sort();
  assert.deepStrictEqual(ids, [a.p.id, b.p.id, c.p.id].sort(), 'round cid: ann and bob both within 50 tiles');
  assert.strictEqual(r.watch(w.id, b.p.id), true, 'now bob is in the window');
  r.flush();
  assert.ok(!decodeLast(w).players.some((q) => q.id === a.p.id), 'round bob: ann is 58 tiles off');
  assert.strictEqual(r.watch(a.s.id, c.p.id), false, 'a seat always sees round its own chomper');

  // bob is caught: his socket watches on, sent the window round where he was (his coins are there)
  const spot = { x: b.p.x, y: b.p.y };
  r.kill(b.p, null, r.ghosts[0]);
  r.step();
  assert.ok(r.watchers.has(b.s.id), 'bob watches');
  b.s.events = [];
  r.flush();
  const sb = decodeLast(b.s);
  assert.ok(sb.players.some((q) => q.id === b.p.id && (q.flags & Wire.F.DYING)), 'his own death is drawn');
  assert.ok(!sb.players.some((q) => q.id === a.p.id), 'not ann, 58 tiles away');
  assert.deepStrictEqual(r.watchAt.get(b.s.id), spot);
  r.removeSocket(w.id);
  assert.ok(!r.watchAt.has(w.id), 'a gone socket leaves nothing behind');
});

test('finding 18: c:watch reaches the paid room of a Spectate socket; a junk id, a seat or the free arena does nothing', () => {
  const { openChomp } = require('../server/chomp/chompBoot');
  const g = openChomp({ io: null, env: { CHOMP: '1' }, log: quiet, autoTick: false, arenasOpts: { mx: 1, my: 1, seed: 5 },
    money: { hooks: HOOKS, door: { consumeAtStake: () => ({ ok: false }), refund: () => {} } } });
  try {
    const stake = [...g.arenas.rungs.keys()][0];
    const room = g.arenas.seatFor(stake);
    room.ghosts = [];
    const a = seat(room, 'ann');
    const handlers = {};
    const w = sock(null, 'watch-sock');
    w.handshake = { auth: { watchStake: stake }, headers: {}, address: '1.2.3.4' };
    w.on = (ev, fn) => { handlers[ev] = fn; };
    g.attach(w);
    assert.ok(room.watchers.has(w.id), 'watching the rung');
    handlers['c:watch']({ id: 'x' });
    handlers['c:watch']({ id: 0 });
    assert.ok(!room.watchAt.has(w.id), 'junk ids do nothing');
    w._rl = {};
    handlers['c:watch']({ id: a.p.id });
    assert.deepStrictEqual(room.watchAt.get(w.id), { id: a.p.id, x: a.p.x, y: a.p.y });
    const free = sock(null, 'free-sock');
    const fh = {};
    free.handshake = { auth: {}, headers: {}, address: '1.2.3.5' };
    free.on = (ev, fn) => { fh[ev] = fn; };
    g.attach(free);
    fh['c:watch']({ id: a.p.id });
    assert.ok(!room.watchAt.has(free.id) && !g.room.watchAt.has(free.id), 'the free arena never cuts');
    assert.strictEqual(room.watch(a.s.id, a.p.id), false, 'a seat is not a watcher');
  } finally {
    g.close();
  }
});

test('finding 18: a paid arena that fits PAID_SEND_TILES, and every free arena, keep the one shared snapshot', () => {
  const nsp = fakeNsp();
  const small = paidRoom({ nsp, mx: 2, my: 2 });
  assert.ok(small.A.W <= R.PAID_SEND_TILES && small.A.H <= R.PAID_SEND_TILES && !small.culls());
  const a = seat(small, 'ann', 500000, nsp);
  small.flush();
  assert.strictEqual(nsp.shared.length, 1, 'one snapshot for the room');
  assert.ok(!a.s.events.some((e) => e[0] === 'c:s'), 'none per socket');
  const all = Wire.decode(nsp.shared[0][1]);
  assert.strictEqual(all.ghosts.length, small.ghosts.length);
  const free = new ChompRoom({ mx: 4, my: 1, botFill: 0, seed: 3, log: quiet, grow: false });
  assert.strictEqual(free.culls(), false, 'a free room never cuts');
  // and a big paid room's 3-module axis is never cut: 96 tiles fit 50 each way
  assert.ok(Maze.build(3, 3, { wrap: true }).H <= R.PAID_SEND_TILES);
});

// ---- the page

function loadPixel() {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/chomp/chompPixel.js'), 'utf8');
  const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => ({}) });
  const ctx = { self: {}, document: { createElement: fakeCanvas, fonts: null }, window: {}, Map, Math };
  ctx.self.ChompMaze = Maze;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.self.ChompPixel;
}

test('finding 18: the pixel look zooms in to at most PAID_VIEW_TILES when asked, and changes nothing a usual screen shows', () => {
  const Pixel = loadPixel();
  const view = (w, h, dpr, cap) => {
    const o = { canvas: {}, buf: {} };
    Pixel.prototype.resize.call(o, w, h, dpr, cap);
    return { k: o.k, cols: o.canvas.width / (o.k * 8), rows: o.canvas.height / (o.k * 8) };
  };
  for (const [w, h, dpr] of [[1920, 1080, 1], [2560, 1440, 1], [3440, 1440, 1], [1366, 768, 1], [412, 915, 2],
    [360, 800, 2], [915, 412, 2], [820, 1180, 2], [1280, 800, 2]]) {
    const was = view(w, h, dpr), now = view(w, h, dpr, R.PAID_VIEW_TILES);
    assert.strictEqual(now.k, was.k, `${w}x${h}@${dpr}: the same scale`);
    assert.ok(was.cols <= R.PAID_VIEW_TILES && was.rows <= R.PAID_VIEW_TILES);
  }
  for (const [w, h, dpr] of [[5120, 1440, 1], [1600, 400, 1], [440, 1600, 1]]) {
    const was = view(w, h, dpr), now = view(w, h, dpr, R.PAID_VIEW_TILES);
    assert.ok(was.cols > R.PAID_VIEW_TILES || was.rows > R.PAID_VIEW_TILES, 'an odd window shows more today');
    assert.ok(now.cols <= R.PAID_VIEW_TILES && now.rows <= R.PAID_VIEW_TILES, `${w}x${h}: capped`);
  }
  assert.strictEqual(view(1920, 1080, 1, 0).k, view(1920, 1080, 1).k, '0: no cap');
});

test('finding 18: the page never draws an AWAY ghost, caps its view only in a big paid arena, and says whom it watches', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/chomp/chompMain.js'), 'utf8');
  assert.match(src, /w\.b\.ghosts\.forEach\(function \(gb, i\) \{\s*if \(gb\.state === AWAY\) return;/);
  assert.match(src, /g\.state !== AWAY && !ghostHome\.has\(i\)/, 'an AWAY ghost is never blue');
  assert.match(src, /stakeNow > 0 && A && A\.wrap && \(A\.W > R\.PAID_SEND_TILES \|\| A\.H > R\.PAID_SEND_TILES\) \? R\.PAID_VIEW_TILES : 0/);
  assert.match(src, /draw\.resize\(w, h, dpr, capNow\)/);
  assert.match(src, /if \(stakeNow > 0 && socket && socket\.connected\) socket\.emit\('c:watch', \{ id: watchId \}\)/);
  assert.strictEqual(Wire.GSTATE[Wire.AWAY], 'away');
  const g = Wire.decode(Wire.encode(1, 0, [], [{ x: 1, y: 2, dir: 0, look: 0, kind: 3, state: Wire.AWAY }])).ghosts[0];
  assert.strictEqual(g.state, Wire.AWAY);
  assert.strictEqual(g.kind, 3);
});
