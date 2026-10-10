'use strict';
// Seeded random streams for the slither free room sim (SERVER-DESIGN 3.1 and 5.3, task T3).
//
// createRng is agar's mulberry32 port, reused read only (server/ag/agRng.js:13, SERVER-DESIGN 3.1 "Reused read only").
// streams(seed) gives one generator per named job. Each stream has its own state, so a draw on one stream never moves
// another, and each stream's seed depends only on the room seed and the stream NAME (never on a list position), so a
// stream added later never shifts the existing ones (SERVER-DESIGN 5.3 "Determinism").
//
// The seed mix below (FNV-1a over the name, then the murmur3 32-bit finalizer) is a CHOSEN engineering construction.
// Its constants are the published algorithm constants, not game numbers. The sim never touches Math.random or Date.

const { createRng } = require('../ag/agRng');

// The seven streams SERVER-DESIGN 3.1 names. Order here is only the order of streamStates(); seeds never use it.
const STREAM_NAMES = Object.freeze(['spawn', 'food', 'drop', 'charge', 'prey', 'order', 'bot']);

// FNV-1a 32-bit hash of a string's UTF-16 code units.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// murmur3 fmix32: a bijection on uint32 that spreads every input bit over the output.
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function checkSeed(seed) {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new TypeError('slRng: seed must be a finite number');
  }
}

// The uint32 seed of one named stream. For a fixed name this is a bijection of (seed >>> 0), so two room seeds never
// share a stream seed; for a fixed room seed two names share one only if their FNV-1a hashes collide (the test checks
// the seven names do not).
function streamSeed(seed, name) {
  checkSeed(seed);
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('slRng: stream name must be a non-empty string');
  return fmix32(((seed >>> 0) ^ fmix32(fnv1a(name))) >>> 0);
}

// One generator per name in STREAM_NAMES. The returned object is frozen; each value is an agRng generator
// (callable, plus next, int, range, chance, state, setState).
function streams(seed) {
  checkSeed(seed);
  const out = {};
  for (const name of STREAM_NAMES) out[name] = createRng(streamSeed(seed, name));
  return Object.freeze(out);
}

// Snapshot of every stream's state, in STREAM_NAMES order (uint32 each).
function streamStates(st) {
  const out = new Array(STREAM_NAMES.length);
  for (let i = 0; i < STREAM_NAMES.length; i++) out[i] = st[STREAM_NAMES[i]].state();
  return out;
}

// Restores a snapshot from streamStates exactly.
function setStreamStates(st, states) {
  if (!Array.isArray(states) || states.length !== STREAM_NAMES.length) {
    throw new TypeError('slRng: states must be an array of ' + STREAM_NAMES.length + ' numbers');
  }
  for (let i = 0; i < STREAM_NAMES.length; i++) st[STREAM_NAMES[i]].setState(states[i]);
}

// Fisher-Yates shuffle in place, from the end; consumes exactly arr.length - 1 draws (none for 0 or 1 items).
function shuffleInPlace(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

module.exports = { createRng, STREAM_NAMES, streamSeed, streams, streamStates, setStreamStates, shuffleInPlace };
