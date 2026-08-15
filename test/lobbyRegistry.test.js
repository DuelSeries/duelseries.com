'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { LobbyRegistry } = require('../server/LobbyRegistry');

/* A stand-in for GameRoom: only the surface the registry touches. */
function stubRoom() {
  return { players: new Map(), capacity: 30, started: false,
           start() { this.started = true; }, stop() { this.started = false; } };
}
const reg = (emptyMs = 120000) => new LobbyRegistry({ makeRoom: stubRoom, emptyMs });

test('a lobby is created on first ask and reused after', () => {
  const r = reg();
  const a = r.get('snake', 'na', 0.25);
  const b = r.get('snake', 'na', 0.25);
  assert.equal(a, b, 'the same room comes back');
  assert.equal(r.size, 1);
  assert.equal(a.started, true, 'and it was started');
});

test('stakes never mix', () => {
  const r = reg();
  assert.notEqual(r.get('snake', 'na', 0.25), r.get('snake', 'na', 1.00));
  assert.equal(r.size, 2);
});

test('games and regions never mix', () => {
  const r = reg();
  r.get('snake', 'na', 1); r.get('snake', 'eu', 1); r.get('agar', 'na', 1);
  assert.equal(r.size, 3);
});

test('float noise cannot split one lobby into two', () => {
  // 0.1 + 0.2 === 0.30000000000000004. Keyed on the raw number that is a
  // second room, and the two halves of a lobby never see each other.
  const r = reg();
  const a = r.get('snake', 'na', 0.1 + 0.2);
  const b = r.get('snake', 'na', 0.3);
  assert.equal(a, b, 'both resolve to the same room');
  assert.equal(r.size, 1);
});

test('an empty paid lobby is withdrawn once its grace has passed', () => {
  const r = reg(1000);
  r.get('snake', 'na', 1.00);
  r.sweep(0);                       // first sweep only marks it empty
  assert.equal(r.size, 1, 'not withdrawn immediately');
  r.sweep(5000);
  assert.equal(r.size, 0, 'withdrawn after the grace period');
});

test('the free lobby is permanent', () => {
  const r = reg(1000);
  r.get('snake', 'na', 0);
  r.sweep(0); r.sweep(999999);
  assert.equal(r.size, 1, 'there is always something joinable');
});

test('a lobby with players in it is never withdrawn', () => {
  const r = reg(1000);
  const room = r.get('snake', 'na', 1.00);
  room.players.set('p1', {});
  r.sweep(0); r.sweep(999999);
  assert.equal(r.size, 1);
});

test('a held lobby is never withdrawn, and the hold can be released', () => {
  // Between paying and arriving, the player owns a seat in an empty room. If
  // the sweeper takes it, their stake has settled on-chain into nothing.
  const r = reg(1000);
  const release = r.hold('snake', 'na', 1.00);
  r.sweep(0); r.sweep(999999);
  assert.equal(r.size, 1, 'held through the grace period');
  release();
  r.sweep(0); r.sweep(999999);
  assert.equal(r.size, 0, 'and withdrawn once released');
});

test('a lobby that empties and refills is not withdrawn on the old clock', () => {
  const r = reg(1000);
  const room = r.get('snake', 'na', 1.00);
  r.sweep(0);                        // marked empty at t=0
  room.players.set('p1', {});
  r.sweep(5000);                     // occupied again, so the mark clears
  room.players.delete('p1');
  r.sweep(5001);                     // freshly empty, grace starts over
  assert.equal(r.size, 1, 'the old empty mark must not still count');
  r.sweep(7000);
  assert.equal(r.size, 0);
});

test('the board lists busiest first', () => {
  const r = reg();
  r.get('snake', 'na', 0.25);
  const busy = r.get('snake', 'na', 1.00);
  busy.players.set('a', {}); busy.players.set('b', {});
  const mid = r.get('snake', 'na', 5.00);
  mid.players.set('c', {});
  assert.deepEqual(r.list().map(l => l.players), [2, 1, 0]);
});

test('a listed lobby carries what the board needs to render a row', () => {
  const r = reg();
  const room = r.get('snake', 'eu', 0.5);
  room.players.set('a', {});
  assert.deepEqual(r.list()[0],
    { id: 'snake:eu:0.50', game: 'snake', region: 'eu', stake: 0.5, players: 1, capacity: 30 });
});

test('a registry without a room factory refuses to be built', () => {
  assert.throws(() => new LobbyRegistry({}), /makeRoom is required/);
});
