'use strict';
// The agar.io room directory for this region (build brief 9.1, 9.3): one free rung, a player cap per room (law
// L39), overflow rooms, the sweep of empty overflow rooms, and the lobby rows (boardRows, liveCount) in the shape
// paperArenas gives them. Free only: there is no money anywhere in this file.
//
// Watchers and players: a socket that connects is seated at once as a watcher in the room a Play would land in
// (its page must be sent world updates before it can ask to play), without opening an overflow room for someone
// who may only watch. Its Play lands in that room while it has a player slot; when the room filled up meanwhile,
// the socket moves to a room that has one (its first bundle there starts with clearAll, so its page drops the
// old world), and only a Play when every room is full opens an overflow room.
//
// Watcher seats are capped per room (agRoom ROOM_TUNING WATCHERS_PER_SLOT): a connection goes to the room its Play
// would land in while that room has a watcher seat, else to another room with one; with none anywhere it is
// refused ('ag:refused' { why: 'full' }) and closed. A watcher still never opens a room.
//
// The directory refuses to open on a law table assertShippable rejects, like the rooms it makes.

const { LAWS, assertShippable, assertLawsComplete } = require('./agLaws');
const { AgRoom } = require('./agRoom');

// CHOSEN directory numbers (ours; Paper's values; listed in the parity log with the other CHOSEN rows).
function chosen(value, note) {
  return Object.freeze({ value, status: 'CHOSEN', note });
}
const ARENA_TUNING = Object.freeze({
  MAX_ROOMS: chosen(8, "Paper's MAX_ARENAS_PER_STAKE: rooms on the free rung at most, overflow rooms included"),
  SWEEP_IDLE_MS: chosen(300000, "Paper's ARENA_SWEEP_MS: an overflow room with no socket this long is closed"),
  PORTRAIT_GAP_MS: chosen(1000, 'ag:portrait: least ms between two orientation changes of one socket\'s view box ' +
    '(PARITY-LOG 2026-10-09 P4). A page that flips back sooner gets its last report applied once the gap is up, so ' +
    'an honest page always ends on what it draws, and a flood of flips cannot show a page both boxes more than ' +
    'once a second'),
});
const MAX_ROOMS = ARENA_TUNING.MAX_ROOMS.value;
const SWEEP_IDLE_MS = ARENA_TUNING.SWEEP_IDLE_MS.value;
const PORTRAIT_GAP_MS = ARENA_TUNING.PORTRAIT_GAP_MS.value;

// A socket with no seat anywhere is told so and closed; it would otherwise stay connected with nothing sent.
function refuse(socket, why) {
  if (!socket) return;
  try {
    if (typeof socket.emit === 'function') socket.emit('ag:refused', { why });
  } catch (e) { /* closing it is what matters */ }
  try {
    if (typeof socket.disconnect === 'function') socket.disconnect(true);
  } catch (e) { /* already gone */ }
}

class AgArenas {
  // region: this server's region; game: the lobby key of the rows (the lobby name stays "agar.io", Q33)
  // laws, shippableOnly, clock, autoTick, log: handed to every room (see agRoom)
  // seed: tests only; room i gets seed + i
  constructor({ region = 'na', laws = LAWS, shippableOnly = true, now = Date.now, clock, autoTick = true, seed,
    makeRoom, game = 'agar', log = console } = {}) {
    if (shippableOnly) assertShippable(laws);
    assertLawsComplete(laws, ['L39']);
    this.region = region;
    this.laws = laws;
    this.shippableOnly = shippableOnly;
    this.now = now;
    this.clock = clock;
    this.autoTick = autoTick;
    this.seed = seed;
    this.game = game;
    this.log = log || console;
    this.cap = laws.L39.value;
    this.makeRoom = makeRoom || ((opts) => new AgRoom(opts));
    this.rooms = [];                 // index order
    this.bySocket = new Map();       // socketId -> room
    this.cleared = new Set();        // socket ids whose page still holds a world from an earlier seat
    this.viewBelow = new Map();      // socketId -> rows its page draws under the reference view (ag:view), > 0 only
    this.portraitState = new Map();  // socketId -> { on, want, at } for sockets that ever reported portrait (ag:portrait)
    this.emptySince = new Map();     // room -> ms
    this._create(0);
  }

  _create(index) {
    const opts = {
      laws: this.laws, shippableOnly: this.shippableOnly, region: this.region, index,
      now: this.now, autoTick: this.autoTick, log: this.log,
      viewBelowOf: (socketId) => this.viewBelow.get(socketId) || 0,
      portraitOf: (socketId) => this.portraitOf(socketId),
    };
    if (this.clock) opts.clock = this.clock;
    if (this.seed !== undefined && this.seed !== null) opts.seed = this.seed + index;
    const room = this.makeRoom(opts);
    room.onClosed = (closed, sockets) => this._replace(closed, sockets);
    this.rooms.push(room);
    this.rooms.sort((a, b) => a.index - b.index);
    return room;
  }

  // An emergency-closed room gives its index to a fresh one, and its sockets are seated there as watchers (past
  // its watcher seats: in another room with one, else refused and closed).
  _replace(closed, sockets) {
    const i = this.rooms.indexOf(closed);
    if (i === -1) return;
    this.rooms.splice(i, 1);
    this.emptySince.delete(closed);
    const room = this._create(closed.index);
    for (const socket of sockets || []) {
      if (!socket || this.bySocket.get(socket.id) !== closed) continue;
      this.bySocket.delete(socket.id);
      let to = room.addSocket(socket, { clearFirst: true }) ? room : null;
      if (!to) {
        const other = this.roomForWatcher();
        if (other && other.addSocket(socket, { clearFirst: true })) to = other;
      }
      if (to) this.bySocket.set(socket.id, to);
      else refuse(socket, 'full');
    }
  }

  _freeIndex() {
    const used = new Set(this.rooms.map((r) => r.index));
    let n = 0;
    while (used.has(n)) n++;
    return n;
  }

  all() {
    return this.rooms.slice();
  }

  roomOfSocket(socketId) {
    return this.bySocket.get(socketId) || null;
  }

  _withSpace() {
    return this.rooms
      .filter((r) => !r.stopped && r.liveHumans < this.cap)
      .sort((a, b) => b.liveHumans - a.liveHumans || a.index - b.index);
  }

  // A room with a player slot: the preferred one if it has a slot, else the fullest room with one, else a new
  // overflow room while there are fewer than MAX_ROOMS, else null.
  roomForPlayer(preferred) {
    if (preferred && this.rooms.includes(preferred) && preferred.hasSpace()) return preferred;
    const open = this._withSpace();
    if (open.length) return open[0];
    if (this.rooms.length < MAX_ROOMS) return this._create(this._freeIndex());
    return null;
  }

  // A room with a watcher seat for a fresh connection: where its Play would land (the fullest room with a player
  // slot) if it has one, else the next room with a player slot, else (every room full) the least full room. It
  // never opens a room by itself; null when no room has a watcher seat.
  roomForWatcher() {
    const open = this._withSpace().filter((r) => r.hasWatchSpace());
    if (open.length) return open[0];
    const live = this.rooms.filter((r) => r.hasWatchSpace())
      .sort((a, b) => a.liveHumans - b.liveHumans || a.index - b.index);
    return live.length ? live[0] : null;
  }

  // Seats a socket as a watcher (connection, or back after ag:leave). Returns its room, or null when no room has a
  // watcher seat (the socket layer then refuses and closes a fresh connection).
  connect(socket) {
    if (!socket || typeof socket.id !== 'string') return null;
    const had = this.bySocket.get(socket.id);
    if (had && !had.stopped && had.seatOf(socket.id)) return had;
    const room = this.roomForWatcher();
    if (!room) return null;
    if (!room.addSocket(socket, { clearFirst: this.cleared.has(socket.id) })) return null;
    this.cleared.delete(socket.id);
    this.bySocket.set(socket.id, room);
    return room;
  }

  // Play. Returns the room's answer ('ok', 'alive', 'full', ...).
  // A socket with no seat (back after ag:leave) is seated straight into a room with a player slot, so a full set
  // of watcher seats never stops a Play.
  join(socket, name) {
    let room = this.bySocket.get(socket.id);
    if (!room || room.stopped || !room.seatOf(socket.id)) {
      this.bySocket.delete(socket.id);
      room = this.roomForPlayer(null);
      if (!room || !room.addSocket(socket, { clearFirst: this.cleared.has(socket.id), forPlay: true })) return 'full';
      this.cleared.delete(socket.id);
      this.bySocket.set(socket.id, room);
    }
    const seat = room.seatOf(socket.id);
    if (!seat.joined && !room.hasSpace()) {
      const other = this.roomForPlayer(null);
      if (!other) return 'full';
      room.removeSocket(socket.id);
      if (!other.addSocket(socket, { clearFirst: true, forPlay: true })) {
        this.bySocket.delete(socket.id);
        return 'full';
      }
      this.bySocket.set(socket.id, other);
      room = other;
    }
    return room.join(socket.id, name);
  }

  // Spectate: a socket that left first watches again.
  spectate(socket) {
    let room = this.bySocket.get(socket.id);
    if (!room) room = this.connect(socket);
    return room ? room.spectate(socket.id) : false;
  }

  target(socketId, x, y) {
    const room = this.bySocket.get(socketId);
    return room ? room.target(socketId, x, y) : false;
  }

  split(socketId) {
    const room = this.bySocket.get(socketId);
    return room ? room.split(socketId) : false;
  }

  eject(socketId) {
    const room = this.bySocket.get(socketId);
    return room ? room.eject(socketId) : false;
  }

  q(socketId) {
    const room = this.bySocket.get(socketId);
    return room ? room.q(socketId) : false;
  }

  // ag:view: the rows the page draws under the reference view, in world units at zoom 1 (agSockets checks it is a
  // whole number, 0 or more; the view caps it, law VIEW_BELOW). Kept per socket, seated or not, until it
  // disconnects, so a move to another room or a Play after ag:leave keeps it; every room reads it through
  // viewBelowOf when it builds that socket's view.
  view(socketId, below) {
    if (typeof socketId !== 'string') return false;
    if (below > 0) this.viewBelow.set(socketId, below);
    else this.viewBelow.delete(socketId);
    return true;
  }

  // ag:portrait: the page plays the phone portrait layout (true) or the reference layout (false). One boolean,
  // never a size: the view turns L4's own box (agView viewBoxFor). Kept per socket like ag:view. Rate limited
  // here, not dropped: the box changes orientation at most once per PORTRAIT_GAP_MS, and a report that comes
  // sooner waits and is applied when the gap is up (portraitOf), so the last report always wins.
  portrait(socketId, on) {
    if (typeof socketId !== 'string' || typeof on !== 'boolean') return false;
    let st = this.portraitState.get(socketId);
    if (!st) {
      if (!on) return true;          // false is every socket's start: nothing to keep
      st = { on: false, want: false, at: -Infinity };
      this.portraitState.set(socketId, st);
    }
    st.want = on;
    this._settlePortrait(st);
    return true;
  }

  // What that socket's view box uses now (read by every room build).
  portraitOf(socketId) {
    const st = this.portraitState.get(socketId);
    if (!st) return false;
    if (st.want !== st.on) this._settlePortrait(st);
    return st.on;
  }

  _settlePortrait(st) {
    if (st.want === st.on) return;
    const now = this.now();
    if (now - st.at < PORTRAIT_GAP_MS) return;
    st.on = st.want;
    st.at = now;
  }

  // ag:leave: the player and its cells go at once (LEAVE_RULE), the socket gets nothing more until it plays or
  // spectates again, and its next seat starts with clearAll.
  leave(socketId) {
    const room = this.bySocket.get(socketId);
    if (!room) return false;
    room.removeSocket(socketId);
    this.bySocket.delete(socketId);
    this.cleared.add(socketId);
    return true;
  }

  // The socket closed: the player and its cells go at once (LEAVE_RULE, CHOSEN until Owen picks a rule).
  disconnect(socketId) {
    const room = this.bySocket.get(socketId);
    if (room) room.removeSocket(socketId);
    this.bySocket.delete(socketId);
    this.cleared.delete(socketId);
    this.viewBelow.delete(socketId);
    this.portraitState.delete(socketId);
  }

  // Every 60 s from the server: an OVERFLOW room with no socket (not even a watcher) for SWEEP_IDLE_MS closes.
  // Room 0 always stays.
  sweep(now) {
    for (const room of this.rooms.slice()) {
      if (room.index === 0 || room.seats.size > 0) {
        this.emptySince.delete(room);
        continue;
      }
      if (!this.emptySince.has(room)) this.emptySince.set(room, now);
      if (now - this.emptySince.get(room) >= SWEEP_IDLE_MS) {
        room.stop();
        this.rooms.splice(this.rooms.indexOf(room), 1);
        this.emptySince.delete(room);
      }
    }
  }

  // /api/live rows, the shape paperArenas.boardRows() gives: one free row for the whole rung.
  boardRows() {
    let players = 0;
    let bots = 0;
    for (const r of this.rooms) {
      if (r.stopped) continue;
      players += r.liveHumans;
      bots += r.botCount;
    }
    return [{
      id: 'ag:' + this.region + ':s0',
      game: this.game,
      region: this.region,
      stake: 0,
      players,
      bots,
      capacity: this.cap,
      state: 'open',
    }];
  }

  // Humans who joined, across every room (the lobby card's count). Bots and watchers are not players.
  liveCount() {
    let n = 0;
    for (const r of this.rooms) if (!r.stopped) n += r.liveHumans;
    return n;
  }

  // paperArenas' name for the same count, so liveCounts can read either.
  humanTotal() {
    return this.liveCount();
  }

  stop() {
    for (const r of this.rooms) r.stop();
  }
}

module.exports = { AgArenas, ARENA_TUNING, refuse };
