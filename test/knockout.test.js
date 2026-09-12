'use strict';
/* KNOCKOUT: the physics, the turn clock, and what the two players are told.

   Owen's spec, in his words: a circular arena, two small circles each, a three
   second countdown, then fifteen seconds where each player drags an arrow out of
   each of their circles — direction is where it goes, longer is harder — and
   when the timer runs out every piece launches at once and you see what happens.
   The ring shrinks each turn, and neither player can see the other aiming.

   The parts worth testing are the ones a player would call cheating if they
   broke: that a long drag cannot buy a harder shot than the cap, that nobody's
   aim leaks before the reveal, and that the disc actually decides who is on it. */

const test = require('node:test');
const assert = require('node:assert');
const { KnockoutRoom, KO } = require('../server/KnockoutRoom');

function sock(id) { return { id, join() {}, emit() {}, rooms: new Set() }; }

function room() {
  const sent = [];
  const io = { to: () => ({ emit: (ev, payload) => sent.push({ ev, payload }) }) };
  const r = new KnockoutRoom(io, 't1');
  r.addPlayer(sock('A'), 'Owen', null);
  r.addPlayer(sock('B'), 'Nia', null);
  r.start(1000);
  return { r, sent };
}

/* Run the clock forward to the given moment, the way the lobby does. */
function runTo(r, t) { for (let i = 0; i < 4; i++) r.tick(t); }

test('a match opens on a three second countdown, then the first turn', () => {
  const { r } = room();
  assert.strictEqual(r.state, 'countdown');
  assert.strictEqual(r.pieces.length, 4, 'two pieces each');
  assert.strictEqual(r.piecesOf('A').length, 2);
  assert.strictEqual(r.piecesOf('B').length, 2);

  runTo(r, 1000 + KO.COUNTDOWN_MS - 1);
  assert.strictEqual(r.state, 'countdown', 'still counting at 2.999s');
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  assert.strictEqual(r.state, 'aiming', 'and aiming at 3s');
  assert.strictEqual(r.turn, 1);
});

test('every piece starts on the disc, and the two sides start apart', () => {
  const { r } = room();
  for (const p of r.pieces) {
    assert.ok(Math.hypot(p.x, p.y) + KO.PIECE_R < r.arenaR,
      'piece ' + p.id + ' starts well inside the ring');
  }
  const a = r.piecesOf('A'), b = r.piecesOf('B');
  for (const pa of a) for (const pb of b) {
    assert.ok(Math.hypot(pa.x - pb.x, pa.y - pb.y) > KO.PIECE_R * 4,
      'nobody starts within reach of an opponent');
  }
});

test('a longer drag cannot buy a harder shot than the cap', () => {
  /* The clamp is the whole defence here. A modified client sending a pull of
     ten thousand has to come out with exactly the shot of somebody who dragged
     to the edge of their screen, or the game is decided by who patched their
     client rather than by who aimed better. */
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  const p = r.piecesOf('A')[0];

  r.submitAim('A', [{ pieceId: p.id, ax: 1000000, ay: 0 }]);
  const cheated = r.aims.get('A')[0];
  assert.ok(Math.abs(Math.hypot(cheated.ax, cheated.ay) - KO.MAX_PULL) < 0.001,
    'the pull is clamped to MAX_PULL, not believed');

  r.submitAim('A', [{ pieceId: p.id, ax: KO.MAX_PULL, ay: 0 }]);
  const honest = r.aims.get('A')[0];
  assert.ok(Math.abs(cheated.ax - honest.ax) < 0.001,
    'and a full honest drag is exactly as hard');
});

test('you cannot aim a piece that is not yours', () => {
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  const theirs = r.piecesOf('B')[0];
  r.submitAim('A', [{ pieceId: theirs.id, ax: 200, ay: 0 }]);
  assert.strictEqual((r.aims.get('A') || []).length, 0, 'their piece is refused');
});

test('re-dragging the same piece replaces the aim rather than adding one', () => {
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  const p = r.piecesOf('A')[0];
  r.submitAim('A', [{ pieceId: p.id, ax: 100, ay: 0 }]);
  r.submitAim('A', [{ pieceId: p.id, ax: 0, ay: 100 }]);
  const aims = r.aims.get('A');
  assert.strictEqual(aims.length, 1, 'one aim for one piece');
  assert.ok(aims[0].ay > 0 && Math.abs(aims[0].ax) < 0.001, 'the later drag is the one that counts');
});

test('nobody can see the other side aiming', () => {
  /* This is the mode. Both players commit blind and find out together, so a
     state message carrying the other side's arrows would hand the match to
     anyone willing to read a websocket frame. */
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  r.submitAim('A', [{ pieceId: r.piecesOf('A')[0].id, ax: 250, ay: 30 }]);
  r.lockIn('A');

  const json = JSON.stringify(r.publicState());
  assert.ok(!/\bax\b/.test(json) && !/\bay\b/.test(json),
    'no aim vector appears anywhere in what the clients are told');
  assert.ok(json.includes('"ready"'), 'but WHO has locked in is fair to show');
  assert.ok(r.publicState().ready.includes('A'));
});

test('the turn resolves early once both players have locked in', () => {
  /* Fifteen seconds is a deadline, not a wait. Against a bot it would
     otherwise be twelve seconds of watching a timer, every turn. */
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  const t = 1000 + KO.COUNTDOWN_MS;
  r.submitAim('A', [{ pieceId: r.piecesOf('A')[0].id, ax: 200, ay: 0 }]);
  r.lockIn('A');
  r.tick(t + 100);
  assert.strictEqual(r.state, 'aiming', 'one player ready is not enough');
  r.lockIn('B');
  r.tick(t + 200);
  assert.strictEqual(r.state, 'resolving', 'both ready and it goes');
});

test('a turn always ends, even if nobody aims at all', () => {
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  runTo(r, 1000 + KO.COUNTDOWN_MS + KO.AIM_MS);
  assert.strictEqual(r.state, 'resolving', 'the buzzer resolves it regardless');
  assert.ok(r.lastResolve.frames.length >= 1, 'and there is still a tape to play');
});

test('a piece shoved off the edge is off, and the survivor stays on', () => {
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  const victim = r.piecesOf('B')[0];
  /* Put it on the rim and fire it straight outward at full power. */
  victim.x = r.arenaR - KO.PIECE_R; victim.y = 0;
  const before = r.piecesOf('A').length;

  r.submitAim('B', [{ pieceId: victim.id, ax: KO.MAX_PULL, ay: 0 }]);
  r.tick(1000 + KO.COUNTDOWN_MS + KO.AIM_MS);

  assert.strictEqual(r.state, 'resolving');
  assert.ok(r.lastResolve.out.some(o => o.id === victim.id), 'it is reported as off');
  assert.strictEqual(victim.alive, false);
  assert.strictEqual(r.piecesOf('A').length, before, 'nobody else was disturbed');
});

test('a piece is only off once its CENTRE passes the edge', () => {
  /* Teetering with half of itself over the drop is still on the disc. That is
     the readable rule, and it is what makes the last inch worth fighting for. */
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  const p = r.piecesOf('A')[0];
  p.x = r.arenaR - 2; p.y = 0; p.vx = 0; p.vy = 0;
  for (const q of r.pieces) if (q !== p) { q.x = -300; q.y = q.id * 60; }
  r.tick(1000 + KO.COUNTDOWN_MS + KO.AIM_MS);
  assert.strictEqual(p.alive, true, 'mostly overhanging, still standing');
});

test('a hit sends the struck piece away and does not pass through it', () => {
  /* The one physical claim the whole game rests on: you can knock something
     with something else. */
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  const hammer = r.piecesOf('A')[0], target = r.piecesOf('B')[0];
  for (const q of r.pieces) { q.vx = 0; q.vy = 0; }
  hammer.x = -100; hammer.y = 0;
  target.x = 0; target.y = 0;
  for (const q of r.pieces) if (q !== hammer && q !== target) { q.x = 0; q.y = -350; }

  r.submitAim('A', [{ pieceId: hammer.id, ax: KO.MAX_PULL, ay: 0 }]);
  r.tick(1000 + KO.COUNTDOWN_MS + KO.AIM_MS);

  assert.ok(target.x > 20, 'the struck piece was driven along the hit, got x=' + Math.round(target.x));
  assert.ok(hammer.x < target.x, 'and the hammer did not pass through it');
  assert.ok(Math.hypot(hammer.x - target.x, hammer.y - target.y) >= KO.PIECE_R * 2 - 1,
    'they never end up inside one another');
});

test('everything comes to a stop, and the tape is not endless', () => {
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  for (const p of r.pieces) r.submitAim(p.owner, [{ pieceId: p.id, ax: KO.MAX_PULL, ay: KO.MAX_PULL }]);
  r.tick(1000 + KO.COUNTDOWN_MS + KO.AIM_MS);

  const tape = r.lastResolve;
  assert.ok(tape.frames.length < KO.MAX_RESOLVE_S / KO.STEP,
    'it settled on its own rather than running into the ceiling');
  for (const p of r.pieces) {
    assert.ok(Math.hypot(p.vx, p.vy) === 0, 'piece ' + p.id + ' is at rest');
  }
  assert.strictEqual(tape.frames[0].length, r.pieces.length * 2, 'a frame is every piece');
});

test('the ring closes each turn and takes anything it closes past', () => {
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  const r1 = r.arenaR;

  /* Park a piece in the band the ring is about to close through. */
  const doomed = r.piecesOf('B')[0];
  doomed.x = r1 - 4; doomed.y = 0;

  let t = 1000 + KO.COUNTDOWN_MS + KO.AIM_MS;
  r.tick(t);                                  // resolve
  t = r.phaseEndsAt;
  runTo(r, t);                                // playback over, next turn opens

  assert.ok(r.arenaR < r1, 'the ring closed, ' + r1 + ' -> ' + r.arenaR);
  assert.strictEqual(r.arenaR, r1 - KO.ARENA_SHRINK);
  assert.strictEqual(doomed.alive, false, 'and it took the piece it closed past');
});

test('the ring never closes below its floor', () => {
  const { r } = room();
  r.arenaR = KO.ARENA_R_MIN;
  r.turn = 40;
  r.beginTurn(5000);
  assert.strictEqual(r.arenaR, KO.ARENA_R_MIN, 'there is always somewhere to play');
});

test('losing your last piece loses the match', () => {
  const { r, sent } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  for (const p of r.piecesOf('B')) p.alive = false;
  assert.ok(r.checkOver(), 'the match is decided');
  assert.strictEqual(r.state, 'over');
  assert.strictEqual(r.winner, 'A');
  const over = sent.filter(m => m.ev === 'ko:over').pop();
  assert.ok(over, 'the clients are told');
  assert.strictEqual(over.payload.winner, 'Owen');
  assert.strictEqual(over.payload.why, 'last one standing');
});

test('both sides clearing on the same reveal is a draw, not a coin toss', () => {
  /* Two pieces trading a hit at the edge and leaving together is a real
     outcome. Awarding it to whoever the loop reached first would be inventing
     a result, and this one pays out. */
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  for (const p of r.pieces) p.alive = false;
  assert.ok(r.checkOver());
  assert.strictEqual(r.winner, null, 'nobody won it');
  assert.strictEqual(r.overWhy, 'everyone went off');
});

test('walking out hands the match to whoever is still there', () => {
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  r.removePlayer('B');
  assert.strictEqual(r.state, 'over');
  assert.strictEqual(r.winner, 'A');
  assert.strictEqual(r.overWhy, 'opponent left');
});

test('the result is not announced until the tape has finished playing', () => {
  /* Putting the result card up the instant the maths is done covers the
     collision that caused it, and the collision is the part worth watching. */
  const { r, sent } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  const doomed = r.piecesOf('B');
  doomed[1].alive = false;
  doomed[0].x = r.arenaR - KO.PIECE_R; doomed[0].y = 0;
  r.submitAim('B', [{ pieceId: doomed[0].id, ax: KO.MAX_PULL, ay: 0 }]);

  const t = 1000 + KO.COUNTDOWN_MS + KO.AIM_MS;
  r.tick(t);
  assert.strictEqual(r.state, 'resolving');
  assert.strictEqual(sent.filter(m => m.ev === 'ko:over').length, 0,
    'nothing announced while the tape is still running');

  runTo(r, r.phaseEndsAt);
  assert.strictEqual(r.state, 'over');
  assert.strictEqual(sent.filter(m => m.ev === 'ko:over').length, 1, 'announced once it has played');
});

test('the tape and the state agree about where the pieces ended', () => {
  /* The client draws the last frame of the tape and then takes the next state
     message as truth. If those two disagree the board jumps, which reads as the
     game cheating at the exact moment somebody has just lost a piece. */
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  for (const p of r.pieces) r.submitAim(p.owner, [{ pieceId: p.id, ax: 120, ay: 80 }]);
  r.tick(1000 + KO.COUNTDOWN_MS + KO.AIM_MS);

  const tape = r.lastResolve;
  const last = tape.frames[tape.frames.length - 1];
  tape.order.forEach((id, i) => {
    const p = r.pieces.find(q => q.id === id);
    assert.ok(Math.abs(p.x - last[i * 2]) <= 1 && Math.abs(p.y - last[i * 2 + 1]) <= 1,
      'piece ' + id + ' ends where the tape says it does');
  });
});

test('the middle of the disc is safer than the rim', () => {
  /* THIS IS THE GAME. The first tuning I wrote made a clean full-power hit
     knock a piece off from every position on the board, centre included, which
     leaves a player no reason to think about where their pieces sit and leaves
     the closing ring nothing to take away. Measured, not reasoned about: a hit
     near the rim must kill and the same hit near the middle must not. */
  const hit = (fromRim) => {
    const { r } = room();
    runTo(r, 1000 + KO.COUNTDOWN_MS);
    const hammer = r.piecesOf('A')[0], target = r.piecesOf('B')[0];
    for (const q of r.pieces) {
      q.vx = 0; q.vy = 0;
      if (q !== hammer && q !== target) { q.x = 0; q.y = -2000; }
    }
    target.x = r.arenaR - fromRim; target.y = 0;
    hammer.x = target.x - 120; hammer.y = 0;
    r.submitAim('A', [{ pieceId: hammer.id, ax: KO.MAX_PULL, ay: 0 }]);
    r.tick(1000 + KO.COUNTDOWN_MS + KO.AIM_MS);
    return target.alive;
  };

  assert.strictEqual(hit(80), false, 'a piece caught near the rim goes off');
  assert.strictEqual(hit(300), true, 'the same hit near the middle does not');
});

test('a shot loses its bite over distance', () => {
  /* Drag applies the whole way, so a hit from across the disc arrives at a
     fraction of its muzzle speed. That is what makes closing the gap worth
     spending a turn on, rather than every piece sniping from safety. */
  const push = (gap) => {
    const { r } = room();
    runTo(r, 1000 + KO.COUNTDOWN_MS);
    const hammer = r.piecesOf('A')[0], target = r.piecesOf('B')[0];
    for (const q of r.pieces) {
      q.vx = 0; q.vy = 0;
      if (q !== hammer && q !== target) { q.x = 0; q.y = -2000; }
    }
    r.arenaR = 99999;                       // measure the shove, not the edge
    target.x = 0; target.y = 0;
    hammer.x = -gap; hammer.y = 0;
    r.submitAim('A', [{ pieceId: hammer.id, ax: KO.MAX_PULL, ay: 0 }]);
    r.tick(1000 + KO.COUNTDOWN_MS + KO.AIM_MS);
    return target.x;
  };

  const near = push(120), far = push(400);
  assert.ok(near > far * 2,
    'a close hit shoves far harder than a long one (' + Math.round(near)
    + ' vs ' + Math.round(far) + ')');
});

test('a turn is quick to watch and cheap to send', () => {
  /* The whole resolution goes down the wire as one tape. It has to stay small
     enough that sending it is not an event, and short enough that a player is
     not sitting through it. */
  const { r } = room();
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  for (const p of r.pieces) r.submitAim(p.owner, [{ pieceId: p.id, ax: KO.MAX_PULL, ay: 40 }]);
  r.tick(1000 + KO.COUNTDOWN_MS + KO.AIM_MS);

  const seconds = r.lastResolve.frames.length * KO.STEP;
  assert.ok(seconds < 4, 'plays back in under four seconds, took ' + seconds.toFixed(1));
  const kb = JSON.stringify(r.lastResolve).length / 1024;
  assert.ok(kb < 16, 'the tape is under 16KB, was ' + kb.toFixed(1));
});
