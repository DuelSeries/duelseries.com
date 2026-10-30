'use strict';
// Capacity-test player for Chomp (shown as Pac-Man), namespace /chomp, the FREE arena only (chomp:na:s0).
//
// Mirrors the real page (public/js/chomp/chompMain.js), the source of truth:
//   connect /chomp with no auth (the page sends auth only for a Customize look; none here) -> the server seats nothing
//   yet, it attaches the socket to the free arena and sends c:init (server/chomp/chompBoot.js attach, chompRoom attach)
//   -> on c:init the lobby-framed page auto-joins: c:join { name } (chompMain onInit / join)
//   -> c:you { id, metas } = seated (stats.joined)
//   -> c:s binary snapshots at SNAP_HZ (20/s), decoded with the page's own decoder (shared/chompWire.js) -> stats.snap
//   -> c:dir { d, s, c, r } only on a key press (edge triggered, never repeated; chompMain want()): d 0..3, s the input
//      number, c/r the tile it was pressed in. A person here presses roughly every 0.3 to 1.2 s, toward an opening.
//   -> caught: c:ev 'die' for our id (stats.dead), then c:over about 2.4 s later (the end card); Play again ~2 s on
//      is another c:join on the same socket.
// Refusals come as c:refused { why }: 'full' (100 chompers, bots included), 'maintenance', or 'limit' (more than 10
// sockets from one address; the server then disconnects, or the namespace middleware fails the connect with 'limit').
// Never paid: no entry token, stake, paid flag, wallet, chat or HTTP route.

const { openSocket, countBytes, pingLoop } = require('../lib');
const Wire = require('../../../shared/chompWire');
const Maze = require('../../../shared/chompMaze');
const Move = require('../../../shared/chompMove');
const R = require('../../../shared/chompRules');

const NSP = '/chomp';

function start(ctx) {
  const stats = ctx.stats;
  const rand = ctx.rand || Math.random;
  const name = (String(ctx.name || '').trim().slice(0, 15)) || 'Player';
  const between = (lo, hi) => lo + (hi - lo) * rand();

  let stopped = false;
  let sock = null;
  let stopPing = null;
  let A = null;                // the arena, built from c:init / c:arena like the page's
  let myId = 0;
  let alive = false;           // seated and not caught
  let joining = false;
  let inited = false;          // this socket has had its c:init (the page auto-joins on the first)
  let limitRefused = false;    // c:refused 'limit': the disconnect that follows is the refusal, not a drop
  let seq = 0;
  let lastWant = -1;
  let nextTurnAt = 0;
  let stuckSince = 0;
  let overTimer = null, joinTimer = null, reconnectTimer = null, dieFallback = null;
  const timers = new Set();

  function later(ms, fn) {
    const h = setTimeout(() => { timers.delete(h); if (!stopped) fn(); }, ms);
    timers.add(h);
    return h;
  }
  function cancel(h) { if (h) { clearTimeout(h); timers.delete(h); } return null; }

  // ---- connection
  function connect() {
    if (stopped) return;
    reconnectTimer = cancel(reconnectTimer);
    inited = false; limitRefused = false; joining = false; myId = 0; alive = false;
    const s = openSocket(ctx.base, NSP, ctx.ip);
    sock = s;
    countBytes(s, stats);

    s.on('connect', () => {
      if (s !== sock) return;
      stats.connectedNow();
      if (stopPing) stopPing();
      stopPing = pingLoop(s, stats);
    });
    s.on('connect_error', (err) => {
      if (s !== sock || stopped) return;
      const why = (err && err.data && err.data.why) || (err && err.message) || '?';
      if (why === 'limit') {
        stats.refused('limit');
        retireSocket();
        reconnectTimer = later(between(3000, 5000), connect);
      } else {
        stats.connectError(why);
        retireSocket();
        reconnectTimer = later(between(2000, 3000), connect);
      }
    });
    s.on('disconnect', (reason) => {
      if (s !== sock) return;
      if (stopPing) { stopPing(); stopPing = null; }
      if (stopped || reason === 'io client disconnect') return;
      clearSeatTimers();
      myId = 0; alive = false; joining = false;
      if (limitRefused) {
        stats.closed();
        retireSocket();
        reconnectTimer = later(between(3000, 5000), connect);
      } else {
        stats.dropped(reason);
        retireSocket();
        reconnectTimer = later(2000, connect);
      }
    });

    s.on('c:init', (m) => {
      if (s !== sock || !m) return;
      buildArena(m.mx, m.my, !!m.wrap);
      // a second c:init only after an emergency close replaced the free arena: our seat went with it
      if (myId) { unseat(); scheduleJoin(between(1500, 2500)); return; }
      if (!inited) { inited = true; join(); }
    });
    s.on('c:arena', (m) => {
      if (s !== sock || !m || !A || !A.wrap) return;
      buildArena(m.mx, m.my, true);
      lastWant = -1;
    });
    s.on('c:you', (m) => {
      if (s !== sock || !m) return;
      joining = false;
      joinTimer = cancel(joinTimer);
      myId = m.id | 0;
      alive = true;
      lastWant = -1;
      stuckSince = 0;
      nextTurnAt = Date.now() + between(300, 900);
      stats.joined();
    });
    s.on('c:s', (buf) => {
      if (s !== sock) return;
      let snap = null;
      try { snap = Wire.decode(buf); } catch (e) { snap = null; }
      if (!snap) { stats.error('decode'); return; }
      stats.snap();
      if (!myId || !alive) return;
      let mine = null;
      for (let i = 0; i < snap.players.length; i++) if (snap.players[i].id === myId) { mine = snap.players[i]; break; }
      if (!mine) return;
      if (mine.flags & Wire.F.DYING) { caught(); return; }
      steer(mine, snap);
    });
    s.on('c:ev', (list) => {
      if (s !== sock || !Array.isArray(list) || !myId) return;
      for (const e of list) if (e && e.k === 'die' && e.id === myId) caught();
    });
    s.on('c:over', (m) => {
      if (s !== sock) return;
      if (alive) caught();
      stats.note(m && m.ghost ? 'over:ghost' : m && m.by ? 'over:player' : 'over:other');
      dieFallback = cancel(dieFallback);
      myId = 0;
      // the end card, then Play again
      scheduleJoin(between(1700, 2600));
    });
    s.on('c:refused', (m) => {
      if (s !== sock) return;
      const why = (m && m.why) || '?';
      stats.refused(why);
      joining = false;
      joinTimer = cancel(joinTimer);
      if (why === 'limit') { limitRefused = true; return; }   // the server disconnects next
      scheduleJoin(between(3000, 5000));
    });
  }

  function retireSocket() {
    const s = sock;
    if (stopPing) { stopPing(); stopPing = null; }
    if (!s) return;
    try { s.removeAllListeners(); s.close(); } catch (e) { /* gone */ }
  }

  function buildArena(mx, my, wrap) {
    if (A && A.mx === mx && A.my === my && A.wrap === wrap) return;
    try { A = Maze.build(mx, my, { wrap }); } catch (e) { A = null; stats.error('maze'); }
  }

  // ---- seat
  function join() {
    if (stopped || !sock || !sock.connected || alive) return;
    joining = true;
    sock.emit('c:join', { name });
    // the server drops a c:join silently when rate limited or still seated: try again if nothing came back
    joinTimer = cancel(joinTimer);
    joinTimer = later(5000, () => { joinTimer = null; if (joining && !alive) { stats.note('join-timeout'); join(); } });
  }

  function scheduleJoin(ms) {
    overTimer = cancel(overTimer);
    overTimer = later(ms, () => { overTimer = null; join(); });
  }

  function caught() {
    if (!alive) return;
    alive = false;
    stats.dead();
    // c:over normally follows after the death animation (R.DEATH_S); if it never does, Play again anyway
    dieFallback = cancel(dieFallback);
    dieFallback = later(Math.round(R.DEATH_S * 1000) + 4000, () => {
      dieFallback = null;
      if (!alive && !overTimer) { myId = 0; stats.note('no-over'); join(); }
    });
  }

  function unseat() {
    myId = 0; alive = false;
    stats.unseated();
  }

  function clearSeatTimers() {
    overTimer = cancel(overTimer);
    joinTimer = cancel(joinTimer);
    dieFallback = cancel(dieFallback);
  }

  // ---- input: a key press now and then, the way a person steers through the maze
  function press(d, me) {
    if (!sock || !sock.connected || !A) return;
    if (lastWant === d && me.dir === d) return;               // chompMain want(): the same key again sends nothing
    seq = seq >= 65535 ? 1 : seq + 1;
    lastWant = d;
    const c = ((Math.floor(me.x) % A.W) + A.W) % A.W, r = ((Math.floor(me.y) % A.H) + A.H) % A.H;
    sock.emit('c:dir', { d, s: seq, c, r });
  }

  // What can catch us, as offsets from us within SEE tiles: an active ghost (unless our energizer is on), and another
  // chomper whose energizer is on (unless ours is too, or it blinks safe).
  const SEE = 8;
  function threats(me, snap) {
    const out = [];
    const powered = me.power > 0;
    if (!powered) {
      for (const g of snap.ghosts) {
        if (g.state !== 0) continue;
        const dx = A.dx(me.x, g.x), dy = A.dy(me.y, g.y);
        if (Math.abs(dx) <= SEE && Math.abs(dy) <= SEE) out.push([dx, dy]);
      }
    }
    for (const q of snap.players) {
      if (q.id === myId || !(q.flags & Wire.F.POWER) || (q.flags & (Wire.F.DYING | Wire.F.SAFE)) || powered) continue;
      const dx = A.dx(me.x, q.x), dy = A.dy(me.y, q.y);
      if (Math.abs(dx) <= SEE && Math.abs(dy) <= SEE) out.push([dx, dy]);
    }
    return out;
  }
  // A threat in front of us along d (within 6 tiles, at most 1.5 tiles to the side).
  function danger(d, th) {
    const v = R.DIRS[d];
    for (const t of th) {
      const along = t[0] * v[0] + t[1] * v[1], side = Math.abs(t[0] * v[1] - t[1] * v[0]);
      if (along > -0.6 && along < 6 && side < 1.5) return true;
    }
    return false;
  }

  let reactAt = 0;
  function steer(me, snap) {
    if (!A) return;
    const now = Date.now();
    const c = Math.floor(me.x), r = Math.floor(me.y);
    const moving = !!(me.flags & Wire.F.MOVING) && me.dir >= 0;
    const th = threats(me, snap);
    const safe = (d) => !danger(d, th);
    if (!moving) {
      // just placed, or run into a wall: a person picks an open way after a moment
      if (!stuckSince) stuckSince = now + between(250, 700);
      if (now < stuckSince) return;
      stuckSince = 0;
      const open = [];
      for (let d = 0; d < 4; d++) if (d !== me.dir && Move.canGo(A, c, r, d)) open.push(d);
      const ok = open.filter(safe);
      const pick = ok.length ? ok : open;
      if (pick.length) press(pick[Math.floor(rand() * pick.length)], me);
      nextTurnAt = now + between(300, 1200);
      return;
    }
    stuckSince = 0;
    const v = R.DIRS[me.dir], perps = [(me.dir + 1) & 3, (me.dir + 3) & 3], back = Move.opp(me.dir);
    // a ghost coming up ahead, or one close on any side: after a person's reaction time, take the way (open here or at
    // the next tile) that leaves the most room, turning round if that is it
    let near = Infinity;
    for (const t of th) near = Math.min(near, Math.hypot(t[0], t[1]));
    if (!safe(me.dir) || near < 3.5) {
      if (!reactAt) reactAt = now + between(180, 420);
      if (now < reactAt) return;
      reactAt = 0;
      let best = me.dir, bestScore = -Infinity;
      for (let d = 0; d < 4; d++) {
        let open = d === me.dir || d === back || Move.canGo(A, c, r, d);
        if (!open && A.walk(c + v[0], r + v[1])) open = Move.canGo(A, c + v[0], r + v[1], d);
        if (!open) continue;
        const w = R.DIRS[d];
        let score = Infinity;
        for (const t of th) score = Math.min(score, Math.hypot(t[0] - w[0] * 2, t[1] - w[1] * 2));
        if (!safe(d)) score -= 3;
        if (score > bestScore) { bestScore = score; best = d; }
      }
      if (best !== me.dir) press(best, me);
      nextTurnAt = now + between(300, 1200);
      return;
    }
    reactAt = 0;
    if (now < nextTurnAt) return;
    nextTurnAt = now + between(300, 1200);
    if (rand() < 0.08 && safe(back)) { press(back, me); return; }
    // the next opening to either side within a few tiles ahead (a turn pressed early is buffered, the arcade's way)
    for (let k = 0; k <= 4; k++) {
      const tc = c + v[0] * k, tr = r + v[1] * k;
      if (k > 0 && !A.walk(tc, tr)) break;
      const open = perps.filter((d) => Move.canGo(A, tc, tr, d) && safe(d));
      if (open.length) { press(open[Math.floor(rand() * open.length)], me); return; }
    }
    const ok = perps.filter(safe);
    if (ok.length) press(ok[Math.floor(rand() * ok.length)], me);
  }

  connect();

  return {
    stop() {
      if (stopped) return;
      const s = sock;
      const wasSeated = alive || !!myId;
      stopped = true;
      for (const h of timers) clearTimeout(h);
      timers.clear();
      if (stopPing) { stopPing(); stopPing = null; }
      if (s) {
        try {
          if (s.connected && wasSeated) s.emit('c:leave');     // free: give the seat up, then close
          s.removeAllListeners();
          s.disconnect();
        } catch (e) { /* gone */ }
      }
      sock = null;
      myId = 0; alive = false;
      stats.closed();
    },
  };
}

module.exports = { id: 'chomp', start };
