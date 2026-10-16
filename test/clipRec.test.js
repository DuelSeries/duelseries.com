'use strict';
/* The in-game clip recorder (public/js/clip/clipRec.js, Owen 2026-10-16): P saves the last 30 s as an MP4 in the
   player's Downloads, PC only, nothing uploaded. Source checks; the recorder itself was run in headless Chrome against
   the local server on /sl (playing), /ag and /paper-arena: P saved an MP4 each time (h264 1280x800 30 fps + AAC, a
   clean ffmpeg decode, gameplay in the frames, the mark bottom left), a 45 s run saved exactly the last 30.5 s, the
   fake mic was in the sound, and each game's cash-out hook attached (slither's offer fired from slx 'x:cashed'). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const rec = () => read('public/js/clip/clipRec.js');

test('off on phones, touch screens, without WebCodecs, on small CPUs, when switched off, and after a failed frame test', () => {
  const js = rec();
  const gate = js.slice(js.indexOf('const touchOnly'), js.indexOf('/* ── sound'));
  assert.match(gate, /matchMedia\('\(hover:none\) and \(pointer:coarse\)'\)/);
  assert.match(gate, /Android\|iPhone\|iPad\|iPod\|Mobile/);
  assert.match(gate, /typeof VideoEncoder === 'function'/);
  assert.match(gate, /hardwareConcurrency \|\| 8\) < 4/);
  assert.match(gate, /ls\(LS_ON\) === '0'/);
  assert.match(gate, /if \(perfFresh && !perf\.ok\) return;/);
  assert.match(js, /const LS_ON = 'dsClipsOn', LS_MIC = 'dsClipsMic', LS_PERF = 'dsClipPerf';/);
});

test('keeps the last 30 seconds from a key frame, a key frame every second', () => {
  const js = rec();
  assert.match(js, /const KEEP_US = 30e6;/);
  assert.match(js, /const KEY_EVERY = FPS;/);
  assert.match(js, /vEnc\.encode\(f, \{ keyFrame: frameNo % KEY_EVERY === 0 \}\)/);
  assert.match(js, /while \(v\.length && !v\[0\]\.key\) v\.shift\(\);/, 'a saved clip always starts on a key frame');
});

test('P saves; never while typing in a field on screen; nothing is uploaded', () => {
  const js = rec();
  assert.match(js, /e\.code !== 'KeyP'/);
  assert.match(js, /typing && t\.getClientRects\(\)\.length/);
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|postMessage\(/.test(js), 'the recorder sends nothing anywhere');
  assert.match(js, /a2\.download = name;/, 'it is a download to the player\'s own PC');
  assert.match(js, /'https:\/\/x\.com\/intent\/post\?text='/, 'Post opens X\'s own compose page');
  assert.match(js, /'noopener,noreferrer'/);
});

test('the mic only when the player turned it on in Settings', () => {
  const js = rec();
  assert.match(js, /if \(ls\(LS_MIC\) === '1' && navigator\.mediaDevices/);
  const html = read('public/v2.html');
  assert.match(html, /id="set-mic" role="switch" aria-checked="false"/, 'off until chosen');
  assert.match(html, /lsPut\('dsClipsMic','1'\)/);
  assert.match(html, /if\(on\)lsPut\('dsClipPerf',null\)/, 'turning clips back on re-runs the frame test');
  assert.match(html, /\.ni\.pconly,#clips-screen,#updates-screen,\.set-pc\{display:none!important\}/, 'the switches are PC only');
});

test('every PC game page loads it after mp4mux, with its game name', () => {
  const ag = read('public/ag.html');
  assert.ok(ag.indexOf('/js/clip/mp4mux.js') > 0 && ag.indexOf('/js/clip/mp4mux.js') < ag.indexOf('/js/clip/clipRec.js'));
  assert.match(ag, /<script src="\/js\/clip\/clipRec\.js" data-game="agar"><\/script>/);
  assert.ok(ag.indexOf('/js/clip/clipRec.js') < ag.indexOf('/js/ag/agSound.js'), 'before agar makes a sound');
  const pa = read('public/paper-arena.html');
  assert.match(pa, /<script src="\/js\/clip\/clipRec\.js" data-game="paper" data-dot="bl"><\/script>/,
    'the dot sits bottom left on Paper.io, clear of its score bar');
  const B = require('../server/sl/slBoot');
  assert.match(B.SLX_TAIL, /<script src="\/js\/clip\/mp4mux\.js"><\/script>\n<script src="\/js\/clip\/clipRec\.js" data-game="slither"><\/script>\n$/);
});

test('offers a clip after a cash-out in each game, hooked from outside the games', () => {
  const js = rec();
  assert.match(js, /sl\.on\('x:cashed', \(\) => offer\(\)\)/);
  assert.match(js, /ag\.onServer\('ag:cashedout', \(\) => offer\(\)\)/);
  assert.match(js, /pp\.net\.on\('pp:cashedout', \(\) => offer\(\)\)/);
  assert.match(js, /const OFFER_MS = 8000;/);
});
