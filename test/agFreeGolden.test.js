'use strict';
// The free agar.io room is pinned (review fix): a scripted run (4 humans with seeded targets, splits and ejects, the
// bots filling the room) hashes every event and every byte the room sends to every socket, plus the final sim
// snapshot. The hashes were taken on origin/main 98d3304, the last commit before paid agar.io, and the paid work must
// leave them exactly as they are: the free room is the agar.io copy (gate G), and nothing about money, the shield,
// spawn checks or the journal may reach it. Nobody holds Q here, as in the harness streams.
// Re-pinned 2026-10-16 for Owen's free-room changes, and only those: a free human now spawns at the paid safe point
// (findSpawnPoint), and the real L4 pad is 140. With the safe spawn switched off, the FIXTURE run still hashed
// 27049e9b53526dda4188617deb8f6d5b, so the phone speed share changes nothing for a mouse or a bot. Re-pinned again
// the same day for the board's score per row (Owen: the score beside each name); with the score taken off the rows,
// both runs hashed as the line above (cdb6915d9754e3390c04e2d3ce4e7ba6, 8878be989fd4960f9e7c56640ec9e638).
// Re-pinned 2026-10-27 for db46aab (2026-10-16, Owen: bots look like real players): free bots deal names from the
// shared pool (server/botNames.js) instead of the old 20 words, still ONE rng draw a name. db46aab with its parent's
// agBots.js still hashed c83904de.. and 2aa3ce50.., and db46aab hashes the same as origin/main 9e7662f, so the names
// are the only change to what the free room sends.
// Re-pinned 2026-10-28 for the newcomer rule (server/ag/agRoom.js NEWCOMER_MS): a free person is out of every
// bot's view for 3 s after spawning, after the live site showed a hunter bot splitting onto a guest 1.24 s after its
// clear spawn. With NEWCOMER_MS set to 0 both runs still hashed 97a6b328.. and 603dc806.., so the bots' view of a
// newcomer is the only change.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { AgRoom } = require('../server/ag/agRoom');
const { createRng } = require('../server/ag/agRng');
const { LAWS } = require('../server/ag/agLaws');
const { FIXTURE } = require('./agLawsFixture');

const quiet = { error() {}, warn() {}, log() {} };

function run(laws, shippableOnly, ticks) {
  const h = crypto.createHash('sha256');
  const clock = { t: 5000000 };
  const r = new AgRoom({ laws, shippableOnly, seed: 7, autoTick: false, log: quiet, now: () => clock.t,
    clock: () => clock.t });
  const hex = (k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v);
  const socks = [];
  for (let i = 0; i < 4; i++) {
    const id = 'g' + i;
    const s = {
      id, conn: { writeBuffer: [] },
      emit(ev, p) {
        h.update(id + '|' + ev + '|');
        if (p instanceof Uint8Array) h.update(Buffer.from(p));
        else if (p instanceof ArrayBuffer) h.update(Buffer.from(p));
        else h.update(JSON.stringify(p === undefined ? null : p, hex));
      },
    };
    r.addSocket(s, {});
    r.join(id, 'p' + i);
    socks.push(s);
  }
  const rnd = createRng(99);
  for (let t = 0; t < ticks; t++) {
    clock.t += 40;
    for (const s of socks) {
      const seat = r.seatOf(s.id);
      if (seat && !r.sim.playerInfo(seat.pid).alive && t % 50 === 0) r.join(s.id, 'p');
      if (t % 20 === 0) r.target(s.id, -3000 + 6000 * rnd(), -3000 + 6000 * rnd());
      const roll = rnd();
      if (roll < 0.01) r.split(s.id);
      else if (roll < 0.02) r.eject(s.id);
    }
    r.tickOnce();
  }
  h.update(JSON.stringify(r.sim.snapshot()));
  return { hash: h.digest('hex').slice(0, 32), bots: r.bots.size, tick: r.sim.tick() };
}

test('the free room sends exactly what it sent before paid agar.io (FIXTURE laws, 3000 ticks)', () => {
  assert.deepStrictEqual(run(FIXTURE, false, 3000), { hash: 'ac39bfbf95fea7690e80651ac01815cf', bots: 46, tick: 3000 });
});

test('the free room sends exactly what it sent before paid agar.io (the real laws, 1500 ticks)', () => {
  assert.deepStrictEqual(run(LAWS, true, 1500), { hash: 'eef5d72567aa138048447d5d7b8e53be', bots: 50, tick: 1500 });
});
