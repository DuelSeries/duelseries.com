'use strict';
/* ─── Battleship ──────────────────────────────────────────────────────────────
   Two fleets, two ten-by-ten grids, and one thing neither player is allowed to
   know: where the other one's ships are.

   THAT SECRET IS THE ENTIRE GAME, and it is the reason this file looks the way
   it does. Every other room in this product broadcasts one state to everybody
   in it. This one cannot: a single payload containing both fleets would hand
   the match to anyone willing to open a websocket frame, and no amount of the
   client politely not drawing it would help. So state is built PER PLAYER, from
   `viewFor`, and a fleet only ever appears in the view of the person who owns
   it — plus, once it is sunk, in the view of the person who sank it, because by
   then they have earned every square of it.

   The server owns both boards outright. A shot is resolved here; the client is
   told hit or miss and nothing else. It cannot probe, cannot ask what is at a
   square, and cannot learn anything from a message it was not meant to get.

   The shape of a match is deliberately short. Thirty seconds to place, then
   alternating single shots on a clock. Seventeen squares to sink a fleet, so a
   decided match is a few minutes, which is what this product wants from a duel.

   ONE SHOT PER TURN, hit or miss. The "hit means go again" variant is more
   exciting and much swingier: a good opening run can end a match before the
   other player has had a real turn, and this one may have money on it. */

const GRID = 10;

/* The classic fleet, which is also exactly what Owen asked for: one of five,
   one of four, two of three, one of two. Seventeen squares in total. */
const FLEET = [
  { key: 'carrier',    name: 'Carrier',    len: 5 },
  { key: 'battleship', name: 'Battleship', len: 4 },
  { key: 'cruiser',    name: 'Cruiser',    len: 3 },
  { key: 'submarine',  name: 'Submarine',  len: 3 },
  { key: 'destroyer',  name: 'Destroyer',  len: 2 },
];

const BS = {
  GRID,
  FLEET,
  CELLS: GRID * GRID,
  SHIP_SQUARES: FLEET.reduce((n, s) => n + s.len, 0),   // 17

  PLACE_MS: 30000,      // Owen's thirty seconds to lay a fleet out
  /* Ten seconds a shot. Twenty was too long once you can line the next one up
     while the other player is still thinking: the decision is already made by
     the time the turn arrives, so the rest of the clock is dead air. */
  TURN_MS: 10000,
  COUNTDOWN_MS: 3000,   // the beat between placing and the first shot
  WIN_HOLD_MS: 3000,    // the board sits there before the result card
};

let nextId = 1;

const idx = (x, y) => y * GRID + x;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < GRID && y < GRID;

/* A whole number from a client, or NaN. Number() is far too willing: it turns
   null, '' and false into 0 and true into 1, so a shot of `null` came through
   as a shot at A1 rather than being refused. Anything that is not plainly a
   number or a string of digits is not a square. */
function whole(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^-?\d{1,4}$/.test(v.trim())) return Number(v.trim());
  return NaN;
}

/* A1 .. J10, which is what the player sees and what the log reads back. */
function cellName(i) {
  return String.fromCharCode(65 + (i % GRID)) + (Math.floor(i / GRID) + 1);
}

/* ── one side's board ───────────────────────────────────────────────────── */
class Board {
  constructor() {
    this.ships = [];            // { key, name, len, cells:[i], hits:Set, sunk }
    this.shotsAt = new Map();   // cell -> 'hit' | 'miss'  (shots fired AT this board)
    this.placed = false;
  }

  cellsUsed() {
    const used = new Set();
    for (const s of this.ships) for (const c of s.cells) used.add(c);
    return used;
  }

  /* A layout is legal or it is refused whole. Partially applying one would
     leave a board half from the player and half from before, which is a state
     nobody asked for and the client cannot draw. */
  place(layout) {
    if (!Array.isArray(layout) || layout.length !== FLEET.length) {
      return { ok: false, why: 'a fleet is ' + FLEET.length + ' ships' };
    }
    const want = new Map(FLEET.map(s => [s.key, s]));
    const used = new Set();
    const ships = [];

    for (const item of layout) {
      const spec = item && want.get(item.key);
      if (!spec) return { ok: false, why: 'unknown ship' };
      want.delete(item.key);                       // each ship exactly once

      const x = whole(item.x), y = whole(item.y);
      const horiz = !!item.horiz;
      if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, why: 'off the grid' };

      const cells = [];
      for (let k = 0; k < spec.len; k++) {
        const cx = horiz ? x + k : x;
        const cy = horiz ? y : y + k;
        if (!inBounds(cx, cy)) return { ok: false, why: spec.name + ' hangs off the grid' };
        const c = idx(cx, cy);
        if (used.has(c)) return { ok: false, why: spec.name + ' overlaps another ship' };
        used.add(c);
        cells.push(c);
      }
      ships.push({ key: spec.key, name: spec.name, len: spec.len, cells, hits: new Set(), sunk: false, horiz, x, y });
    }
    if (want.size) return { ok: false, why: 'missing ' + [...want.values()].map(s => s.name).join(', ') };

    this.ships = ships;
    this.placed = true;
    return { ok: true };
  }

  /* A legal fleet, laid out at random. Used for the bot, and for a player whose
     thirty seconds ran out — arriving at a match with no ships is not a state
     worth supporting, and an auto-layout is strictly better for them than
     forfeiting a buy-in to a clock. */
  placeRandom(rnd) {
    const rand = rnd || Math.random;
    for (let attempt = 0; attempt < 400; attempt++) {
      const used = new Set();
      const ships = [];
      let ok = true;
      for (const spec of FLEET) {
        let placed = false;
        for (let tries = 0; tries < 200 && !placed; tries++) {
          const horiz = rand() < 0.5;
          const x = Math.floor(rand() * (horiz ? GRID - spec.len + 1 : GRID));
          const y = Math.floor(rand() * (horiz ? GRID : GRID - spec.len + 1));
          const cells = [];
          let clash = false;
          for (let k = 0; k < spec.len; k++) {
            const c = idx(horiz ? x + k : x, horiz ? y : y + k);
            if (used.has(c)) { clash = true; break; }
            cells.push(c);
          }
          if (clash) continue;
          for (const c of cells) used.add(c);
          ships.push({ key: spec.key, name: spec.name, len: spec.len, cells, hits: new Set(), sunk: false, horiz, x, y });
          placed = true;
        }
        if (!placed) { ok = false; break; }
      }
      if (ok) { this.ships = ships; this.placed = true; return true; }
    }
    return false;
  }

  shipAt(cell) {
    for (const s of this.ships) if (s.cells.includes(cell)) return s;
    return null;
  }

  /* Resolve a shot. Returns what the FIRER is entitled to know and nothing
     more: whether it hit, and if that sank something, which ship and where —
     because a sunk ship is public by the rules of the game. */
  receive(cell) {
    if (this.shotsAt.has(cell)) return { ok: false, why: 'already fired there' };
    const ship = this.shipAt(cell);
    if (!ship) {
      this.shotsAt.set(cell, 'miss');
      return { ok: true, hit: false, cell, sunk: null };
    }
    this.shotsAt.set(cell, 'hit');
    ship.hits.add(cell);
    if (!ship.sunk && ship.hits.size >= ship.len) ship.sunk = true;
    return {
      ok: true, hit: true, cell,
      sunk: ship.sunk ? { key: ship.key, name: ship.name, cells: ship.cells.slice(), horiz: ship.horiz, x: ship.x, y: ship.y } : null,
    };
  }

  allSunk() { return this.ships.length > 0 && this.ships.every(s => s.sunk); }
  squaresLeft() { return BS.SHIP_SQUARES - [...this.shotsAt.values()].filter(v => v === 'hit').length; }
}

/* ── the room ───────────────────────────────────────────────────────────── */
class BattleshipRoom {
  constructor(io, roomId) {
    this.io = io;
    this.id = roomId || ('bs_' + (nextId++));
    this.socketRoomName = 'bs_' + this.id;

    this.state = 'waiting';   // waiting | placing | countdown | playing | settling | over
    this.players = new Map(); // socketId -> { socket, name, wallet, side }
    this.boards = new Map();  // socketId -> Board
    this.turn = null;         // socketId whose shot it is
    this.phaseEndsAt = 0;
    this.winner = null;
    this.overWhy = '';
    this.lastShot = null;     // { by, cell, hit, sunk }
    this.shotLog = [];

    /* Money. Same shape as Knockout, and for the same reasons: the room knows
       who won, index.js knows what that is worth. */
    this.stake = 0;
    this.worth = new Map();
    this.settled = false;
  }

  addPlayer(socket, name, wallet, worth) {
    if (this.players.size >= 2) return false;
    const side = this.players.size;
    this.players.set(socket.id, { socket, name: name || 'Player', wallet: wallet || null, side });
    this.boards.set(socket.id, new Board());
    this.worth.set(socket.id, Number(worth) > 0 ? Number(worth) : 0);
    if (socket.join) socket.join(this.socketRoomName);
    return true;
  }

  removePlayer(socketId) {
    if (!this.players.has(socketId)) return;
    this.players.delete(socketId);
    if (this.state !== 'over' && this.state !== 'waiting') {
      const rest = [...this.players.keys()];
      this.finish(rest.length === 1 ? rest[0] : null, 'opponent left');
    }
  }

  opponentOf(socketId) {
    for (const id of this.players.keys()) if (id !== socketId) return id;
    return null;
  }

  pot() { let n = 0; for (const v of this.worth.values()) n += v; return n; }

  start(now) {
    if (this.players.size < 2) return false;
    this.state = 'placing';
    this.phaseEndsAt = nowOr(now) + BS.PLACE_MS;
    this.sendState();
    return true;
  }

  /* ── laying out a fleet ─────────────────────────────────────────────────── */

  placeFleet(socketId, layout) {
    if (this.state !== 'placing') return { ok: false, why: 'not placing' };
    const board = this.boards.get(socketId);
    if (!board) return { ok: false, why: 'not in this match' };
    const r = board.place(layout);
    if (r.ok) this.sendState();
    return r;
  }

  bothPlaced() {
    if (this.players.size !== 2) return false;
    for (const id of this.players.keys()) {
      const b = this.boards.get(id);
      if (!b || !b.placed) return false;
    }
    return true;
  }

  /* ── the clock ──────────────────────────────────────────────────────────── */

  tick(now) {
    const t = nowOr(now);
    if (this.state === 'placing') {
      if (this.bothPlaced() || t >= this.phaseEndsAt) this.beginCountdown(t);
      return;
    }
    if (this.state === 'countdown') {
      if (t >= this.phaseEndsAt) this.beginPlay(t);
      return;
    }
    if (this.state === 'playing') {
      /* A turn that runs out fires anyway, at random, rather than stalling the
         match on somebody who has walked away from their phone. Forfeiting the
         turn outright would be worse: it hands a free tempo to whoever is more
         patient, and on a paid table that is money. */
      if (t >= this.phaseEndsAt) this.autoFire(t);
      return;
    }
    if (this.state === 'settling') {
      if (t >= this.phaseEndsAt) this.declare();
      return;
    }
  }

  beginCountdown(now) {
    /* Anybody who did not finish gets a legal fleet rather than no fleet. */
    for (const id of this.players.keys()) {
      const b = this.boards.get(id);
      if (b && !b.placed) { b.placeRandom(); b.autoPlaced = true; }
    }
    this.state = 'countdown';
    this.phaseEndsAt = nowOr(now) + BS.COUNTDOWN_MS;
    /* Who shoots first is a coin, decided here and never by a client. */
    const ids = [...this.players.keys()];
    this.turn = ids[Math.floor(Math.random() * ids.length)] || ids[0] || null;
    this.sendState();
  }

  beginPlay(now) {
    this.state = 'playing';
    this.phaseEndsAt = nowOr(now) + BS.TURN_MS;
    this.sendState();
  }

  /* ── firing ─────────────────────────────────────────────────────────────── */

  fire(socketId, cell, now) {
    if (this.state !== 'playing') return { ok: false, why: 'not your turn yet' };
    if (this.turn !== socketId) return { ok: false, why: 'not your turn' };
    const foe = this.opponentOf(socketId);
    const board = foe && this.boards.get(foe);
    if (!board) return { ok: false, why: 'no opponent' };

    const c = whole(cell);
    if (!Number.isInteger(c) || c < 0 || c >= BS.CELLS) return { ok: false, why: 'off the grid' };

    const r = board.receive(c);
    if (!r.ok) return r;

    this.lastShot = { by: socketId, cell: c, hit: r.hit, sunk: r.sunk };
    this.shotLog.push({ by: socketId, cell: c, hit: r.hit, sunk: r.sunk ? r.sunk.name : null });

    if (board.allSunk()) {
      /* The board is held up for a moment before the card, same as Knockout. */
      this.state = 'settling';
      this.phaseEndsAt = nowOr(now) + BS.WIN_HOLD_MS;
      this.pendingWinner = socketId;
      this.sendState();
      return { ok: true, result: r };
    }

    /* Strict alternation: one shot each, hit or miss. */
    this.turn = foe;
    this.phaseEndsAt = nowOr(now) + BS.TURN_MS;
    this.sendState();
    return { ok: true, result: r };
  }

  /* The clock ran out. Fire somewhere legal, chosen at random from what is
     left, so the match moves and the player loses only their aim. */
  autoFire(now) {
    const shooter = this.turn;
    const foe = this.opponentOf(shooter);
    const board = foe && this.boards.get(foe);
    if (!board) return;
    const open = [];
    for (let c = 0; c < BS.CELLS; c++) if (!board.shotsAt.has(c)) open.push(c);
    if (!open.length) return;
    this.fire(shooter, open[Math.floor(Math.random() * open.length)], now);
  }

  declare() {
    this.finish(this.pendingWinner || null, 'fleet sunk');
  }

  /* ── the end ────────────────────────────────────────────────────────────── */

  finish(winnerId, why) {
    if (this.state === 'over') return;
    this.state = 'over';
    this.winner = winnerId || null;
    this.overWhy = why || '';

    if (!this.settled) {
      this.settled = true;
      const pot = this.pot();
      if (pot > 0 && typeof this.onSettled === 'function') {
        try {
          this.onSettled({
            roomId: this.id, winnerId: winnerId || null, why: why || '', pot,
            seats: [...this.players.entries()].map(([id, p]) => ({
              id, name: p.name, wallet: p.wallet, worth: this.worth.get(id) || 0,
            })),
          });
        } catch (e) { console.error('[BS] settle hook failed:', e.message); }
      }
    }

    for (const [id, p] of this.players) {
      try {
        p.socket.emit('bs:over', {
          won: winnerId ? winnerId === id : null,
          winner: winnerId ? (this.players.get(winnerId) || {}).name || null : null,
          why: this.overWhy,
          shots: this.shotLog.filter(s => s.by === id).length,
          stake: this.stake, pot: this.pot(),
          /* Both fleets, now that it is over. Holding the loser's layout back
             after the match would be hiding the only thing anybody wants to
             look at afterwards. */
          reveal: [...this.players.keys()].map(pid => ({
            id: pid,
            name: (this.players.get(pid) || {}).name || null,
            ships: (this.boards.get(pid) || { ships: [] }).ships.map(s => ({
              key: s.key, name: s.name, cells: s.cells, horiz: s.horiz, x: s.x, y: s.y, sunk: s.sunk,
            })),
          })),
        });
      } catch (_) {}
    }
  }

  /* ── what each player is allowed to see ─────────────────────────────────
     Built per player, never broadcast. `me` gets their own fleet in full and
     the shots that have landed on it; the enemy board comes back as marks only,
     plus any ship they have actually sunk. There is no path here that puts an
     unsunk enemy ship into anybody's payload. */
  viewFor(socketId) {
    const me = this.players.get(socketId);
    const foeId = this.opponentOf(socketId);
    const foe = foeId ? this.players.get(foeId) : null;
    const myBoard = this.boards.get(socketId);
    const foeBoard = foeId ? this.boards.get(foeId) : null;

    return {
      id: this.id,
      state: this.state,
      phaseMs: Math.max(0, this.phaseEndsAt - Date.now()),
      placeMs: BS.PLACE_MS,
      turnMs: BS.TURN_MS,
      grid: GRID,
      fleet: FLEET.map(s => ({ key: s.key, name: s.name, len: s.len })),
      you: me ? { name: me.name, side: me.side } : null,
      them: foe ? { name: foe.name, side: foe.side } : null,
      yourTurn: this.state === 'playing' && this.turn === socketId,
      placed: !!(myBoard && myBoard.placed),
      theyPlaced: !!(foeBoard && foeBoard.placed),

      /* Mine, in full: I am allowed to know where my own ships are. */
      myShips: myBoard ? myBoard.ships.map(s => ({
        key: s.key, name: s.name, len: s.len, cells: s.cells,
        horiz: s.horiz, x: s.x, y: s.y, sunk: s.sunk,
        hits: [...s.hits],
      })) : [],
      /* Where they have shot at me. */
      shotsOnMe: myBoard ? [...myBoard.shotsAt.entries()].map(([c, v]) => ({ cell: c, hit: v === 'hit' })) : [],

      /* Theirs, as marks only. */
      myShots: foeBoard ? [...foeBoard.shotsAt.entries()].map(([c, v]) => ({ cell: c, hit: v === 'hit' })) : [],
      /* And the ships I have finished off, which are mine to see. */
      sunkOfTheirs: foeBoard ? foeBoard.ships.filter(s => s.sunk).map(s => ({
        key: s.key, name: s.name, cells: s.cells, horiz: s.horiz, x: s.x, y: s.y,
      })) : [],

      squaresLeftMine: myBoard ? myBoard.squaresLeft() : BS.SHIP_SQUARES,
      squaresLeftTheirs: foeBoard ? foeBoard.squaresLeft() : BS.SHIP_SQUARES,
      lastShot: this.lastShot,
      stake: this.stake,
      pot: this.pot(),
    };
  }

  sendState() {
    for (const [id, p] of this.players) {
      try { p.socket.emit('bs:state', this.viewFor(id)); } catch (_) {}
    }
  }
}

/* A timestamp of zero is a real timestamp; `now || Date.now()` is not. */
function nowOr(t) { return typeof t === 'number' && Number.isFinite(t) ? t : Date.now(); }

module.exports = { BattleshipRoom, Board, BS, cellName, idx };
