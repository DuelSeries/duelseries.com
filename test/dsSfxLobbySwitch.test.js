'use strict';
// The lobby's sound switch (localStorage dsSnd = '0') silences every page's DSSfx, games in their frames included, and a
// change arrives live through the storage event; the game's own level still applies on top (Owen 2026-10-28).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/dsSfx.js'), 'utf8');

function page(stored) {
  const store = new Map(stored == null ? [] : [['dsSnd', stored]]);
  const listeners = {};
  const gains = [];
  class AC {
    constructor() { this.state = 'running'; this.sampleRate = 8000; this.destination = {}; }
    createGain() { const g = { gain: { value: 1 }, connect() {}, disconnect() {} }; gains.push(g); return g; }
    createBufferSource() { return { connect() {}, disconnect() {}, start() {}, playbackRate: { value: 1 } }; }
    createBuffer(n, len) { return { getChannelData: () => new Float32Array(len) }; }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
  }
  const root = {
    document: { hidden: false },
    AudioContext: AC,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null) },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    setTimeout: () => 0, requestIdleCallback: undefined, performance: { now: () => 0 },
  };
  root.window = root;
  vm.runInNewContext(SRC, Object.assign(root, { Float32Array, Math, Object, Array, WeakMap, Promise }));
  const set = (v) => { store.set('dsSnd', v); (listeners.storage || []).forEach((fn) => fn({ key: 'dsSnd' })); };
  return { S: root.DSSfx, out: gains[0], set };
}

test('the lobby switch on (or never set): sound plays at the game\'s own level', () => {
  const p = page(null);
  p.S.setLevel(() => 0.5);
  assert.strictEqual(p.S.on(), true);
  assert.strictEqual(p.S.level(), 0.5);
  assert.strictEqual(p.out.gain.value, 1);
});

test('the lobby switch off: the game is silent, live graphs included, whatever its own level', () => {
  const p = page('0');
  p.S.setLevel(() => 1);
  assert.strictEqual(p.S.on(), false);
  assert.strictEqual(p.S.level(), 0);
  assert.strictEqual(p.out.gain.value, 0);
  assert.strictEqual(p.S.play('anything'), false);
});

test('flipped mid-game: the storage event mutes and unmutes at once; the game\'s own mute still wins', () => {
  const p = page('1');
  let own = 1;
  p.S.setLevel(() => own);
  p.set('0');
  assert.deepStrictEqual([p.S.on(), p.S.level(), p.out.gain.value], [false, 0, 0]);
  p.set('1');
  assert.deepStrictEqual([p.S.on(), p.S.level(), p.out.gain.value], [true, 1, 1]);
  own = 0;
  assert.strictEqual(p.S.level(), 0, 'either one off is silent');
});
