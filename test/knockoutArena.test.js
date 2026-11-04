'use strict';
/* KNOCKOUT ARENAS: the bumpers prototype (option B, 2026-11-04), behind KO_ARENA=bumpers outside production.

   What a player would call unfair if it broke: a classic table growing posts, posts that are not the same for both
   seats, a post that throws a piece harder than a full shot, posts lingering after the ring reached them, and any of
   it touching who is paid what. */

const test = require('node:test');
const assert = require('node:assert');
const { KnockoutRoom, KO } = require('../server/KnockoutRoom');

function sock(id) { return { id, join() {}, emit() {}, rooms: new Set() }; }
function withEnv(env, fn) {
  const keep = { KO_ARENA: process.env.KO_ARENA, NODE_ENV: process.env.NODE_ENV };
  for (const k of Object.keys(env)) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(keep)) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; }
  }
}
function room(env, ev) {
  return withEnv(env, () => {
    const io = { to: () => ({ emit() {} }) };
    const r = new KnockoutRoom(io, 't1', ev);
    r.addPlayer(sock('A'), 'Owen', null, 5000);
    r.addPlayer(sock('B'), 'Nia', null, 5000);
    r.start(1000);
    return r;
  });
}
const runTo = (r, t) => { for (let i = 0; i < 4; i++) r.tick(t); };

test('a table is classic unless the dev flag asks, and never bumpers in production', () => {
  assert.strictEqual(room({ KO_ARENA: undefined, NODE_ENV: undefined }).bumpers, null);
  assert.strictEqual(room({ KO_ARENA: 'bumpers', NODE_ENV: 'production' }).bumpers, null, 'production ignores the flag');
  assert.strictEqual(room({ KO_ARENA: 'bumpers', NODE_ENV: undefined }, 'hs').bumpers, null, 'games built on this room never get them');
  const r = room({ KO_ARENA: 'bumpers', NODE_ENV: undefined });
  assert.strictEqual(r.bumpers.length, 2);
  assert.ok(!('bumpers' in room({}).publicState()), 'a classic state says nothing about bumpers');
});

test('the posts are mirrored through the centre, so both seats face the same arena', () => {
  const r = room({ KO_ARENA: 'bumpers' });
  const [a, b] = r.bumpers;
  assert.ok(a.x === -b.x && a.y === -b.y && a.r === b.r);
  // Seat 1's view is the board turned half round: each of its pieces is a seat 0 piece mirrored through the centre.
  const s0 = r.piecesOf('A').map(p => [p.x + 0, p.y + 0]).sort(), s1 = r.piecesOf('B').map(p => [-p.x + 0, -p.y + 0]).sort();
  assert.deepStrictEqual(s0, s1);
  for (const p of r.pieces) for (const bm of r.bumpers) assert.ok(Math.hypot(p.x - bm.x, p.y - bm.y) > bm.r + KO.PIECE_R * 2, 'nothing starts on a post');
});

test('a piece fired into a post comes back off it, never faster than a full shot', () => {
  const r = room({ KO_ARENA: 'bumpers' });
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  const p = r.piecesOf('A')[0];                     // bottom left, (-88, 176)
  const post = r.bumpers[0];                          // (-196, 0)
  r.submitAim('A', [{ pieceId: p.id, ax: post.x - p.x, ay: post.y - p.y }]);
  let fastest = 0;
  const step = r.bump.bind(r);
  r.bump = () => { step(); for (const q of r.pieces) fastest = Math.max(fastest, Math.hypot(q.vx, q.vy)); };
  r.resolve(5000);
  assert.ok(fastest <= KO.MAX_SPEED + 1e-6, 'capped at a full shot: ' + fastest);
  assert.ok(Math.hypot(p.x - post.x, p.y - post.y) >= post.r + KO.PIECE_R - 0.5, 'it ends outside the post');
  assert.ok(p.y > 0, 'and it came back down the board it was fired from (y ' + Math.round(p.y) + ')');
  // The same shot on a classic table sails on past where the post was.
  const c = room({});
  runTo(c, 1000 + KO.COUNTDOWN_MS);
  const q = c.piecesOf('A')[0];
  c.submitAim('A', [{ pieceId: q.id, ax: post.x - q.x, ay: post.y - q.y }]);
  c.resolve(5000);
  assert.ok(q.y < 0 || !q.alive, 'without the post it carries on up the board');
});

test('a post sinks the turn the ring reaches it, and the state says so', () => {
  const r = room({ KO_ARENA: 'bumpers' });
  runTo(r, 1000 + KO.COUNTDOWN_MS);
  let t = 1000 + KO.COUNTDOWN_MS;
  while (r.bumpers[0].alive && r.turn < 20) {
    r.resolve(t); t += 20000; runTo(r, t);
    if (r.state !== 'aiming') break;
  }
  assert.strictEqual(r.bumpers[0].alive, false);
  assert.strictEqual(r.bumpers[1].alive, false, 'both at once: they are the same distance out');
  assert.ok(Math.hypot(r.bumpers[0].x, r.bumpers[0].y) + r.bumpers[0].r > r.arenaR, 'only once the ring reached it');
  assert.ok(r.publicState().bumpers.every(b => b.alive === false));
  assert.ok(r.watchState(r.publicState()).bumpers.length === 2, 'watchers see the posts too');
});

test('the posts change nothing about the money: same pot, same seats, same settle', () => {
  const settle = (env) => {
    const r = room(env);
    const paid = [];
    r.onSettled = (m) => { paid.push(m); };
    runTo(r, 1000 + KO.COUNTDOWN_MS);
    r.removePlayer('B');
    r.finish('A', 'again');                           // a second route to the end pays nothing more
    return paid;
  };
  const b = settle({ KO_ARENA: 'bumpers' }), c = settle({});
  assert.strictEqual(b.length, 1, 'settled exactly once');
  assert.deepStrictEqual(b, c, 'the bumpers table settles exactly as a classic one');
  assert.strictEqual(b[0].pot, 10000);
  assert.strictEqual(b[0].winnerId, 'A');
});
