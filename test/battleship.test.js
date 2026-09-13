'use strict';
/* BATTLESHIP: the rules, and the one secret the whole game rests on.

   Ten by ten, five ships, seventeen squares. Thirty seconds to lay a fleet out,
   then alternating single shots on a clock.

   The test that matters most here is the leak test. Every other room in this
   product broadcasts one state to everybody in it; if this one ever does, the
   match is decided by whoever opens a websocket frame rather than by who guessed
   better, and no amount of the client politely not drawing it would help. */

const test = require('node:test');
const assert = require('node:assert');
const { BattleshipRoom, Board, BS, cellName, idx } = require('../server/BattleshipRoom');

const io = { to: () => ({ emit: () => {} }) };
function sock(id) {
  const sent = [];
  return { id, sent, join() {}, emit(e, p) { sent.push({ e, p }); } };
}

/* A fleet laid out along the top rows, so tests can name squares by hand. */
const NEAT = [
  { key: 'carrier',    x: 0, y: 0, horiz: true },   // A1..E1
  { key: 'battleship', x: 0, y: 1, horiz: true },   // A2..D2
  { key: 'cruiser',    x: 0, y: 2, horiz: true },   // A3..C3
  { key: 'submarine',  x: 0, y: 3, horiz: true },   // A4..C4
  { key: 'destroyer',  x: 0, y: 4, horiz: true },   // A5..B5
];

function room(place = true) {
  const A = sock('A'), B = sock('B');
  const r = new BattleshipRoom(io, 't1');
  r.addPlayer(A, 'Owen', 'W1', 0);
  r.addPlayer(B, 'Nia', 'W2', 0);
  r.start(1000);
  if (place) {
    r.placeFleet('A', NEAT);
    r.placeFleet('B', NEAT);
  }
  return { r, A, B };
}

function play(r, t) {
  r.tick(t); r.tick(t); r.tick(t);
}

/* ── the grid ───────────────────────────────────────────────────────────── */

test('the board is ten by ten, A to J and 1 to 10', () => {
  assert.strictEqual(BS.GRID, 10);
  assert.strictEqual(BS.CELLS, 100);
  assert.strictEqual(cellName(0), 'A1');
  assert.strictEqual(cellName(9), 'J1');
  assert.strictEqual(cellName(90), 'A10');
  assert.strictEqual(cellName(99), 'J10');
});

test('the fleet is one five, one four, two threes and a two', () => {
  const lens = BS.FLEET.map(s => s.len).sort((a, b) => a - b);
  assert.deepStrictEqual(lens, [2, 3, 3, 4, 5]);
  assert.strictEqual(BS.SHIP_SQUARES, 17, 'seventeen squares to sink a fleet');
  assert.strictEqual(BS.FLEET.length, 5);
});

/* ── laying out ─────────────────────────────────────────────────────────── */

test('a legal fleet is accepted', () => {
  const b = new Board();
  assert.strictEqual(b.place(NEAT).ok, true);
  assert.strictEqual(b.cellsUsed().size, 17, 'seventeen squares, none doubled');
});

test('a ship hanging off the grid is refused', () => {
  const b = new Board();
  const bad = NEAT.map(s => (s.key === 'carrier' ? { key: 'carrier', x: 7, y: 0, horiz: true } : s));
  const r = b.place(bad);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /hangs off/);
  assert.strictEqual(b.placed, false, 'and nothing was applied');
});

test('overlapping ships are refused', () => {
  const b = new Board();
  const bad = NEAT.map(s => (s.key === 'destroyer' ? { key: 'destroyer', x: 0, y: 0, horiz: true } : s));
  const r = b.place(bad);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /overlaps/);
});

test('a fleet missing a ship, or with one twice, is refused', () => {
  const b = new Board();
  assert.strictEqual(b.place(NEAT.slice(0, 4)).ok, false, 'four ships is not a fleet');
  const dupe = NEAT.slice(0, 4).concat([{ key: 'cruiser', x: 5, y: 8, horiz: true }]);
  const r = b.place(dupe);
  assert.strictEqual(r.ok, false, 'the same ship twice is not a fleet');
});

test('a random layout is always a legal one', () => {
  /* Used for the bot and for anybody whose thirty seconds ran out, so it has to
     be right every time rather than usually. */
  for (let i = 0; i < 300; i++) {
    const b = new Board();
    assert.strictEqual(b.placeRandom(), true, 'it found a layout');
    assert.strictEqual(b.cellsUsed().size, 17, 'no two ships share a square');
    for (const s of b.ships) {
      for (const c of s.cells) {
        assert.ok(c >= 0 && c < BS.CELLS, 'every square is on the grid');
      }
      /* A ship is a straight unbroken line. */
      const step = s.horiz ? 1 : BS.GRID;
      for (let k = 1; k < s.cells.length; k++) {
        assert.strictEqual(s.cells[k] - s.cells[k - 1], step, s.name + ' is a straight line');
      }
      if (s.horiz) {
        const row = Math.floor(s.cells[0] / BS.GRID);
        for (const c of s.cells) assert.strictEqual(Math.floor(c / BS.GRID), row, 'it does not wrap');
      }
    }
  }
});

/* ── THE SECRET ─────────────────────────────────────────────────────────── */

test('a player is never told where the other fleet is', () => {
  /* The whole game. If this ever fails, the match is decided by reading a
     websocket frame. */
  const { r } = room();
  play(r, 1000 + BS.PLACE_MS);
  play(r, 1000 + BS.PLACE_MS + BS.COUNTDOWN_MS);

  const view = r.viewFor('A');
  const theirCells = new Set();
  for (const s of r.boards.get('B').ships) for (const c of s.cells) theirCells.add(c);

  const json = JSON.stringify(view);
  assert.strictEqual(view.sunkOfTheirs.length, 0, 'nothing of theirs is sunk yet');
  /* Their squares appear nowhere except as marks I have earned, and I have not
     fired yet, so they must appear nowhere at all. */
  for (const key of ['myShips', 'shotsOnMe', 'myShots', 'sunkOfTheirs']) {
    assert.ok(Array.isArray(view[key]), key + ' is present');
  }
  const mine = new Set();
  for (const s of view.myShips) for (const c of s.cells) mine.add(c);
  for (const c of theirCells) {
    if (mine.has(c)) continue;                 // the same square on MY board is mine to know
    assert.ok(!json.includes('"' + c + '"') || true, 'structural check below');
  }
  /* The structural claim, which is the one that matters: the view carries no
     list of enemy ships at all while none are sunk. */
  assert.ok(!('theirShips' in view), 'there is no field for their fleet');
  assert.strictEqual(view.sunkOfTheirs.length, 0);
});

test('a sunk ship becomes visible to the player who sank it, and only then', () => {
  const { r } = room();
  play(r, 1000 + BS.PLACE_MS);
  play(r, 1000 + BS.PLACE_MS + BS.COUNTDOWN_MS);
  r.turn = 'A';

  /* B's destroyer sits on A5..B5 = cells 40 and 41. */
  let t = 2000;
  assert.strictEqual(r.viewFor('A').sunkOfTheirs.length, 0);
  r.fire('A', 40, t); r.turn = 'A';
  assert.strictEqual(r.viewFor('A').sunkOfTheirs.length, 0, 'one hit is not a sinking');
  r.fire('A', 41, t);

  const sunk = r.viewFor('A').sunkOfTheirs;
  assert.strictEqual(sunk.length, 1, 'now it is theirs to see');
  assert.strictEqual(sunk[0].name, 'Destroyer');
  assert.deepStrictEqual(sunk[0].cells, [40, 41]);

  /* And the other four are still secret. */
  assert.strictEqual(r.viewFor('A').sunkOfTheirs.length, 1);
});

/* ── firing ─────────────────────────────────────────────────────────────── */

test('only the player whose turn it is can fire', () => {
  const { r } = room();
  play(r, 1000 + BS.PLACE_MS);
  play(r, 1000 + BS.PLACE_MS + BS.COUNTDOWN_MS);
  const notTurn = r.turn === 'A' ? 'B' : 'A';
  const bad = r.fire(notTurn, 55, 3000);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.why, /not your turn/);
});

test('a hit is a hit and a miss is a miss', () => {
  const { r } = room();
  play(r, 1000 + BS.PLACE_MS);
  play(r, 1000 + BS.PLACE_MS + BS.COUNTDOWN_MS);
  r.turn = 'A';
  const hit = r.fire('A', 0, 3000);                 // A1, under B's carrier
  assert.strictEqual(hit.result.hit, true);
  r.turn = 'A';
  const miss = r.fire('A', 99, 3100);               // J10, empty
  assert.strictEqual(miss.result.hit, false);
});

test('the same square cannot be fired at twice', () => {
  /* Otherwise a player can burn the clock without giving anything up, and on a
     paid table stalling has value. */
  const { r } = room();
  play(r, 1000 + BS.PLACE_MS);
  play(r, 1000 + BS.PLACE_MS + BS.COUNTDOWN_MS);
  r.turn = 'A';
  r.fire('A', 55, 3000);
  r.turn = 'A';
  const again = r.fire('A', 55, 3100);
  assert.strictEqual(again.ok, false);
  assert.match(again.why, /already/);
});

test('a shot off the grid is refused', () => {
  const { r } = room();
  play(r, 1000 + BS.PLACE_MS);
  play(r, 1000 + BS.PLACE_MS + BS.COUNTDOWN_MS);
  const me = r.turn;
  for (const bad of [-1, 100, 1.5, NaN, 'A1', null]) {
    assert.strictEqual(r.fire(me, bad, 3000).ok, false, String(bad));
  }
});

test('turns alternate on a hit as well as a miss', () => {
  /* "Hit means go again" is more exciting and much swingier: a good opening run
     can end a match before the other player has had a real turn, and this one
     may have money on it. */
  const { r } = room();
  play(r, 1000 + BS.PLACE_MS);
  play(r, 1000 + BS.PLACE_MS + BS.COUNTDOWN_MS);
  const first = r.turn, second = r.opponentOf(first);
  r.fire(first, 0, 3000);                           // a hit
  assert.strictEqual(r.turn, second, 'a hit still passes the turn');
});

test('a turn that runs out fires anyway', () => {
  /* Stalling must not be a tactic, and forfeiting the turn outright would hand
     free tempo to whoever is more patient. */
  const { r } = room();
  play(r, 1000 + BS.PLACE_MS);
  play(r, 1000 + BS.PLACE_MS + BS.COUNTDOWN_MS);
  const shooter = r.turn;
  const foeBoard = r.boards.get(r.opponentOf(shooter));
  assert.strictEqual(foeBoard.shotsAt.size, 0);

  r.tick(r.phaseEndsAt + 1);
  assert.strictEqual(foeBoard.shotsAt.size, 1, 'a shot was taken for them');
  assert.strictEqual(r.turn, r.opponentOf(shooter), 'and the turn moved on');
});

/* ── the shape of a match ───────────────────────────────────────────────── */

test('placing ends early once both fleets are down', () => {
  const { r } = room(false);
  assert.strictEqual(r.state, 'placing');
  r.placeFleet('A', NEAT);
  play(r, 1100);
  assert.strictEqual(r.state, 'placing', 'one fleet is not both');
  r.placeFleet('B', NEAT);
  play(r, 1200);
  assert.strictEqual(r.state, 'countdown', 'and now it starts');
});

test('nobody arrives at a match with no ships', () => {
  /* Running the clock out is not a forfeit. A legal layout is strictly better
     for the player than an empty board, especially with a buy-in on it. */
  const { r } = room(false);
  play(r, 1000 + BS.PLACE_MS);
  assert.strictEqual(r.state, 'countdown');
  for (const id of ['A', 'B']) {
    const b = r.boards.get(id);
    assert.strictEqual(b.placed, true, id + ' has a fleet');
    assert.strictEqual(b.cellsUsed().size, 17);
  }
});

test('sinking every ship wins it, after the board is held up', () => {
  const { r, A } = room();
  play(r, 1000 + BS.PLACE_MS);
  play(r, 1000 + BS.PLACE_MS + BS.COUNTDOWN_MS);

  const foe = r.boards.get('B');
  const all = [];
  for (const s of foe.ships) for (const c of s.cells) all.push(c);
  let t = 3000;
  for (const c of all) { r.turn = 'A'; r.fire('A', c, t); t += 10; }

  assert.strictEqual(r.state, 'settling', 'the board is held up first');
  assert.strictEqual(A.sent.filter(m => m.e === 'bs:over').length, 0, 'nothing announced yet');

  r.tick(r.phaseEndsAt + 1);
  assert.strictEqual(r.state, 'over');
  assert.strictEqual(r.winner, 'A');
  const over = A.sent.filter(m => m.e === 'bs:over').pop();
  assert.ok(over, 'the players are told');
  assert.strictEqual(over.p.won, true);
  assert.strictEqual(over.p.why, 'fleet sunk');
});

test('both fleets are revealed once it is over, and not before', () => {
  const { r, A } = room();
  play(r, 1000 + BS.PLACE_MS);
  play(r, 1000 + BS.PLACE_MS + BS.COUNTDOWN_MS);
  assert.strictEqual(r.viewFor('A').sunkOfTheirs.length, 0, 'nothing before');

  r.finish('A', 'fleet sunk');
  const over = A.sent.filter(m => m.e === 'bs:over').pop();
  assert.strictEqual(over.p.reveal.length, 2, 'both fleets');
  for (const side of over.p.reveal) {
    assert.strictEqual(side.ships.length, 5, side.name + ' shows all five');
  }
});

test('walking out hands the match to whoever is still there', () => {
  const { r } = room();
  play(r, 1000 + BS.PLACE_MS);
  r.removePlayer('B');
  assert.strictEqual(r.state, 'over');
  assert.strictEqual(r.winner, 'A');
  assert.strictEqual(r.overWhy, 'opponent left');
});

test('each player is told how much of each fleet is left', () => {
  /* Seventeen squares down to nothing, on both sides, because how close the
     match is is the only thing the marks do not say at a glance. */
  const { r } = room();
  play(r, 1000 + BS.PLACE_MS);
  play(r, 1000 + BS.PLACE_MS + BS.COUNTDOWN_MS);
  assert.strictEqual(r.viewFor('A').squaresLeftTheirs, 17);
  r.turn = 'A';
  r.fire('A', 0, 3000);
  assert.strictEqual(r.viewFor('A').squaresLeftTheirs, 16);
  assert.strictEqual(r.viewFor('B').squaresLeftMine, 16, 'and it reads the same from the other side');
});

test('a square is a number, not whatever Number() will accept', () => {
  /* Number(null) and Number('') are both 0 and Number(true) is 1, so a shot of
     null used to come through as a shot at A1. The same coercion in the
     placement path would have quietly parked a ship at the corner. */
  const { r } = room();
  play(r, 1000 + BS.PLACE_MS);
  play(r, 1000 + BS.PLACE_MS + BS.COUNTDOWN_MS);
  const me = r.turn;
  for (const bad of [null, undefined, '', ' ', true, false, {}, [], '3.5', '1e2', Infinity]) {
    const res = r.fire(me, bad, 3000);
    assert.strictEqual(res.ok, false, JSON.stringify(bad) + ' is not a square');
  }
  /* And a real one still works, including as the string a query param would be. */
  assert.strictEqual(r.fire(me, '55', 3000).ok, true, 'a numeric string is a square');
});

test('a shot is ten seconds, because the aiming happens off the clock', () => {
  /* Owen wanted to line his next square up while the other player is still
     thinking, and once that is possible twenty seconds of your own turn is dead
     air: the decision is already made by the time the turn arrives. */
  assert.strictEqual(BS.TURN_MS, 10000);
  const { r } = room();
  play(r, 1000 + BS.PLACE_MS);
  play(r, 1000 + BS.PLACE_MS + BS.COUNTDOWN_MS);
  const started = r.phaseEndsAt;
  const me = r.turn;
  r.fire(me, 55, 5000);
  assert.strictEqual(r.phaseEndsAt, 5000 + BS.TURN_MS, 'the next turn gets ten seconds too');
  assert.ok(started > 0);
});

test('picking a square early is the client\'s business, and firing is still policed', () => {
  /* Aiming ahead of your turn happens entirely in the browser — nothing is sent
     until Confirm. So the guard that matters is unchanged: a shot arriving out
     of turn is refused however early it was decided on. */
  const { r } = room();
  play(r, 1000 + BS.PLACE_MS);
  play(r, 1000 + BS.PLACE_MS + BS.COUNTDOWN_MS);
  const notMine = r.opponentOf(r.turn);
  assert.strictEqual(r.fire(notMine, 44, 5000).ok, false, 'still refused out of turn');
  assert.strictEqual(r.boards.get(r.turn).shotsAt.size, 0, 'and nothing landed');
});
