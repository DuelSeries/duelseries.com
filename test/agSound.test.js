'use strict';
// agSound (build brief fact 2.13, Q41): the house Glass sounds (DSSfx) at the reference cue points, always on since 2026-10-15.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const S = require(path.join(__dirname, '..', 'public', 'js', 'ag', 'agSound.js'));

// A stand-in for the page's DSSfx engine: records every play(name, opts) and wake().
function fakeSfx() {
  const log = [];
  return { log, sfx: { play: (name, o) => { log.push([name, o]); return true; }, wake: () => log.push(['wake']) } };
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

test('always on (Owen 2026-10-15): playing needs only a game in progress', () => {
  const { sfx, log } = fakeSfx();
  const s = S.createSound({ sfx });
  assert.strictEqual(s.isEnabled(), true);
  assert.strictEqual(s.playCue('split'), false, 'not in a game: dropped, as the reference drops it');
  assert.strictEqual(log.filter((x) => x[0] !== 'wake').length, 0);
  s.setInGame(true);
  assert.ok(log.some((x) => x[0] === 'wake'), 'entering a game wakes the engine');
  assert.strictEqual(s.playCue('split'), true);
  assert.strictEqual(s.playCue('nope'), false);
  assert.ok(log.some((x) => x[0] === 'g.split'));
  assert.deepStrictEqual(s.played(), ['split']);
  s.setInGame(false);
  assert.strictEqual(s.playCue('split'), false);
});

test('every cue plays a Glass sound that the library defines; there is no toggle and nothing is stored', () => {
  const lib = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'js', 'dsSfxGame.js'), 'utf8');
  for (const c of S.CUES) {
    assert.ok(S.TONES[c], c);
    assert.match(S.TONES[c].sfx, /^g\./, c);
    assert.ok(lib.includes("'" + S.TONES[c].sfx + "'"), c + ' uses ' + S.TONES[c].sfx + ', which dsSfxGame.js defines');
  }
  const s = S.createSound({ sfx: fakeSfx().sfx });
  assert.strictEqual(s.setEnabled, undefined, 'no way to turn it off');
  assert.strictEqual(s.createToggleButton, undefined, 'no Sound button');
  assert.strictEqual(S.STORE_KEY, undefined, 'no stored on/off key');
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'js', 'ag', 'agSound.js'), 'utf8');
  assert.ok(!/localStorage|agSoundOn|getItem|setItem/.test(src), 'agSound never touches storage');
  const c = S.createSound({});
  c.setInGame(true);
  assert.strictEqual(c.playCue('shoot'), false);   // no engine on the page (node): silent, no throw
});

test('each cue plays its own sound; an eat varies in pitch a little, the rest do not', () => {
  const { sfx, log } = fakeSfx();
  const s = S.createSound({ sfx });
  s.setInGame(true);
  const names = { split: 'g.split', shoot: 'g.eject', eatOwnCell: 'g.merge', gameOver: 'g.death', join: 'g.join',
    holdStart: 'g.ringStart', holdCancel: 'g.ringCancel', cashout: 'g.cashout' };
  for (const [cue, snd] of Object.entries(names)) {
    log.length = 0;
    assert.strictEqual(s.playCue(cue), true, cue);
    assert.strictEqual(log[0][0], snd, cue);
    assert.strictEqual(log[0][1].rate, undefined, cue + ' has no pitch change');
  }
  const rates = new Set();
  for (let i = 0; i < 40; i++) {
    log.length = 0;
    s.playCue('eatCell');
    assert.strictEqual(log[0][0], 'g.eat');
    assert.ok(log[0][1].rate > 0.92 - 1e-9 && log[0][1].rate < 1.08 + 1e-9, 'within 8 percent');
    rates.add(log[0][1].rate);
  }
  assert.ok(rates.size > 10, 'the rate varies');
  log.length = 0;
  s.playCue('splitBecauseVirus');
  assert.strictEqual(log[0][0], 'g.explode');
});

test('playCues tells an eat apart: our kill, our cell hurt, a merge once, others quietly', () => {
  const { sfx, log } = fakeSfx();
  const s = S.createSound({ sfx });
  s.setInGame(true);
  const run = (e) => { log.length = 0; s.playCues(S.eatCues(e), e); return log.map((x) => x[0]); };
  const eat = (o) => Object.assign({ eaterOwn: false, eatenOwn: false, ownCount: 1, food: false, virus: false, ejected: false }, o);
  assert.deepStrictEqual(run(eat({ eaterOwn: true })), ['g.kill']);
  assert.deepStrictEqual(run(eat({ eatenOwn: true, ownCount: 2 })), ['g.hurt']);
  assert.deepStrictEqual(run(eat({ eatenOwn: true, ownCount: 1 })), ['g.death']);
  assert.deepStrictEqual(run(eat({ eaterOwn: true, eatenOwn: true, ownCount: 2 })), ['g.merge']);
  assert.deepStrictEqual(run(eat({ ownCount: 0 })), ['g.eat']);
  assert.deepStrictEqual(run(eat({ virus: true, eaterOwn: true })), ['g.explode']);
  assert.deepStrictEqual(run(eat({ eaterOwn: true, food: true })), []);
  log.length = 0;
  s.playCues(['eatCell']);                 // no eat given: the plain cue
  assert.strictEqual(log[0][0], 'g.eat');
});

test('no Math.random, no Date, no reference line citations in agSound', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'js', 'ag', 'agSound.js'), 'utf8');
  assert.ok(!/Math\.random|Date\.now|new Date/.test(src));
  assert.ok(!/\bD \d{4,}|\bW \d{5,}|dcmp|\.wat\b|\.mp3/.test(src));
});
