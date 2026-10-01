'use strict';
// agSound (build brief fact 2.13, Q41): our own tones at the reference cue points, off by default.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const S = require(path.join(__dirname, '..', 'public', 'js', 'ag', 'agSound.js'));

function fakeAudio() {
  const log = [];
  const param = (name) => ({
    setValueAtTime: (v, t) => log.push([name, 'set', v, t]),
    exponentialRampToValueAtTime: (v, t) => log.push([name, 'ramp', v, t])
  });
  const ac = {
    state: 'running',
    currentTime: 1,
    destination: { dest: true },
    createOscillator: () => ({ type: '', frequency: param('freq'), connect: () => {}, start: (t) => log.push(['start', t]), stop: (t) => log.push(['stop', t]) }),
    createGain: () => ({ gain: param('gain'), connect: () => {} })
  };
  return { ac, log };
}
function memStore() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m };
}

test('split cue: 1 to 15 own cells and some displayed size strictly above 60', () => {
  assert.strictEqual(S.splitCue([]), null);
  assert.strictEqual(S.splitCue([60]), null);
  assert.strictEqual(S.splitCue([60.01]), 'split');
  assert.strictEqual(S.splitCue([10, 61]), 'split');
  const fifteen = new Array(15).fill(10); fifteen[3] = 70;
  assert.strictEqual(S.splitCue(fifteen), 'split');
  const sixteen = new Array(16).fill(70);
  assert.strictEqual(S.splitCue(sixteen), null);
});

test('eject cue: some own size with size^2 > 3612.5 (size > 60.104), no count limit', () => {
  const edge = Math.fround(Math.sqrt(3612.5));
  assert.strictEqual(S.ejectCue([edge]), null);
  const up = new Float32Array([edge]); const u = new Uint32Array(up.buffer); u[0] += 1;
  assert.strictEqual(S.ejectCue([up[0]]), 'shoot');
  assert.strictEqual(S.ejectCue([]), null);
  assert.strictEqual(S.ejectCue(new Array(16).fill(61)), 'shoot');
  assert.strictEqual(S.ejectCue([60]), null);
});

test('eat cues match the reference moments of the full stream', () => {
  const e = (o) => S.eatCues(Object.assign({ eaterOwn: false, eatenOwn: false, ownCount: 1, food: false, virus: false, ejected: false }, o));
  // own cell eats food: silent
  assert.deepStrictEqual(e({ eaterOwn: true, food: true }), []);
  // own cell eats the player "tiny"
  assert.deepStrictEqual(e({ eaterOwn: true }), ['eatCell']);
  // a virus eats an ejected blob (flag 0x20): silent
  assert.deepStrictEqual(e({ ejected: true }), []);
  // merge: own eats own
  assert.deepStrictEqual(e({ eaterOwn: true, eatenOwn: true, ownCount: 2 }), ['eatCell', 'eatOwnCell']);
  // the giant eats our only cell
  assert.deepStrictEqual(e({ eatenOwn: true, ownCount: 1 }), ['gameOver']);
  // one of two own cells eaten by someone else
  assert.deepStrictEqual(e({ eatenOwn: true, ownCount: 2 }), ['eatCell']);
  // two other players
  assert.deepStrictEqual(e({ ownCount: 0 }), ['eatCell']);
  // any eat of a virus
  assert.deepStrictEqual(e({ virus: true }), ['splitBecauseVirus']);
  assert.deepStrictEqual(e({ virus: true, eaterOwn: true }), ['splitBecauseVirus']);
  // own-own eat of an ejected own blob still plays the merge sound
  assert.deepStrictEqual(e({ eaterOwn: true, eatenOwn: true, ejected: true }), ['eatOwnCell']);
});

test('off by default; playing needs enabled AND in game', () => {
  const { ac, log } = fakeAudio();
  const s = S.createSound({ createAudioContext: () => ac, storage: memStore() });
  assert.strictEqual(s.isEnabled(), false);
  s.setInGame(true);
  assert.strictEqual(s.playCue('split'), false);
  assert.strictEqual(log.length, 0);
  s.setEnabled(true);
  s.setInGame(false);
  assert.strictEqual(s.playCue('split'), false);
  s.setInGame(true);
  assert.strictEqual(s.playCue('split'), true);
  assert.strictEqual(s.playCue('nope'), false);
  assert.ok(log.some((x) => x[0] === 'start'));
  assert.ok(log.some((x) => x[0] === 'freq' && x[1] === 'set' && x[2] === S.TONES.split.f0));
  assert.deepStrictEqual(s.played(), ['split']);
});

test('every cue has a tone; the choice persists through storage, and broken storage is harmless', () => {
  for (const c of S.CUES) assert.ok(S.TONES[c], c);
  const store = memStore();
  const a = S.createSound({ createAudioContext: () => fakeAudio().ac, storage: store });
  a.setEnabled(true);
  assert.strictEqual(store.m.agSoundOn, '1');
  const b = S.createSound({ createAudioContext: () => fakeAudio().ac, storage: store });
  assert.strictEqual(b.isEnabled(), true);
  const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const c = S.createSound({ createAudioContext: () => null, storage: bad });
  assert.strictEqual(c.isEnabled(), false);
  assert.strictEqual(c.setEnabled(true), true);
  c.setInGame(true);
  assert.strictEqual(c.playCue('shoot'), false);   // no audio context available: silent, no throw
});

test('no Math.random, no Date, no reference line citations in agSound', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'js', 'ag', 'agSound.js'), 'utf8');
  assert.ok(!/Math\.random|Date\.now|new Date/.test(src));
  assert.ok(!/\bD \d{4,}|\bW \d{5,}|dcmp|\.wat\b|\.mp3/.test(src));
});
