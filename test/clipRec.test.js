'use strict';
/* The in-game clip recorder (public/js/clip/clipRec.js, Owen 2026-10-16): P saves the last 30 s as an MP4 in the
   player's Downloads, PC only; it uploads only when the player then clicks Share to DuelSeries. Source checks; the recorder itself was run in headless Chrome against
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
  assert.match(js, /const KEY_US = 1e6;/);
  assert.match(js, /const key = frameNo === 0 \|\| ts - lastKey >= KEY_US - 20000;/, 'by time: a stretch with no picture never stretches the key frames');
  assert.match(js, /vEnc\.encode\(f, \{ keyFrame: key \}\)/);
  assert.match(js, /while \(v\.length && !v\[0\]\.key\) v\.shift\(\);/, 'a saved clip always starts on a key frame');
});

test('P saves; never while typing in a field on screen; P never uploads, only a Share click does', () => {
  const js = rec();
  assert.match(js, /e\.code !== 'KeyP'/);
  assert.match(js, /typing && t\.getClientRects\(\)\.length/);
  assert.match(js, /a2\.download = name;/, 'it is a download to the player\'s own PC');
  assert.match(js, /'https:\/\/x\.com\/intent\/post\?text='/, 'Post opens X\'s own compose page');
  assert.match(js, /'noopener,noreferrer'/);
  /* Owen 2026-10-16: an accidental P must never put a clip online. Everything that sends lives in the sharing
     section, and the only ways into it are the Share to DuelSeries button and a console hook. */
  const start = js.indexOf('/* ── sharing to DuelSeries');
  const end = js.indexOf('DSClip.share = () => share(last);');
  assert.ok(start > 0 && end > start);
  const outside = js.slice(0, start) + js.slice(end);
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|postMessage\(/.test(outside), 'nothing outside the sharing section sends anything');
  const calls = outside.match(/\bshare\([a-z]+\)/g) || [];
  assert.deepStrictEqual(calls, ['share(last)', 'share(clip)'], 'share runs from the console hook and the button, nothing else');
  assert.match(js, /yes\.onclick = \(e\) => \{ e\.stopPropagation\(\); share\(clip\); \};/, 'the button is Share to DuelSeries');
  assert.match(js, /const no = el\('button', 'sec', 'Not now'\);/);
  assert.match(js, /It is reviewed before anyone else can see it\./, 'the prompt says plainly it is reviewed first');
  const p = js.slice(js.indexOf("addEventListener('keydown'"), js.indexOf('// Hooks onto each game'));
  assert.match(p, /save\(\);/);
  assert.ok(!/share/.test(p), 'the P key only saves');
  assert.match(js, /x\.setRequestHeader\('If-None-Match', '\*'\);/, 'an upload link writes its file once');
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

/* Owen 2026-10-16, "pretty laggy": the recorder must never cost the game a frame. Measured on his 240 Hz PC: free on
   an idle PC, but on a busy one 85 -> 75 fps with 60% more late frames. */
const paceOf = () => {
  const js = rec();
  const src = js.slice(js.indexOf('  let paceMed = []'), js.indexOf('  /* Asleep:'));
  // eslint-disable-next-line no-new-func
  return new Function(src + '\nreturn { pace, get lateUntil() { return lateUntil; }, get yields() { return yields; } };')();
};
const run = (p, t0, secs, dt) => { let t = t0; for (const end = t0 + secs * 1000; t < end; t += dt) p.pace(t); return t; };

test('no picture while the game stutters (frames over 20 ms), then back; a missed refresh at 240 Hz or a 60 Hz screen is not a stutter', () => {
  const p = paceOf();
  let t = run(p, 1000, 3, 1000 / 240);                  // a smooth 240 Hz game
  t = run(p, t, 3, 1000 / 120);                         // every frame one refresh late: 120 fps is still smooth
  assert.strictEqual(p.yields, 0);
  t = run(p, t, 1.2, 30);                               // 33 fps: the PC is short of time
  assert.ok(p.yields >= 1 && p.lateUntil > t, 'the picture stops');
  const y = p.yields;
  t = run(p, t, 20, 1000 / 240);                        // smooth again: the stop runs out by itself
  assert.strictEqual(p.yields, y);
  assert.ok(p.lateUntil < t);
  const q = paceOf();                                   // a window on a 60 Hz screen
  run(q, 1000, 5, 1000 / 60);
  assert.strictEqual(q.yields, 0);
  const r = paceOf();                                   // moved from 240 Hz to 60 Hz
  run(r, run(r, 1000, 3, 1000 / 240), 12, 1000 / 60);
  assert.strictEqual(r.yields, 0);
});

test('asleep (no picture, no sound, no encoding) while hidden or untouched for 45 s; waking starts the buffer again', () => {
  const js = rec();
  assert.match(js, /const IDLE_MS = 45000;/);
  assert.match(js, /if \(document\.hidden\) doze\(\);/);
  assert.match(js, /if \(!asleep && now - lastInput > IDLE_MS\) doze\(\);/);
  assert.match(js, /if \(asleep \|\| now < lateUntil \|\| !capturing/, 'the tick captures nothing asleep or late');
  assert.match(js, /if \(!aEnc \|\| !running \|\| asleep\) \{ ad\.close\(\); continue; \}/, 'no sound is encoded asleep');
  assert.match(js, /mixer\.suspend\(\)/);
  const rouse = js.slice(js.indexOf('function rouse()'), js.indexOf('document.addEventListener(\'visibilitychange\''));
  assert.match(rouse, /vChunks = \[\]; aChunks = \[\]; frameNo = 0;/);
  assert.match(js, /\['pointermove', 'pointerdown', 'keydown', 'wheel'\]\.forEach/);
});

test('no layout read per frame; sound is bounded without a picture', () => {
  const js = rec();
  const comp = js.slice(js.indexOf('function composite()'), js.indexOf('function mark()'));
  assert.ok(!/getBoundingClientRect/.test(comp), 'rects come from findLayers, once a second');
  assert.match(js, /r: x\.c\.getBoundingClientRect\(\)/);
  assert.match(js, /const old = chunk\.timestamp - KEEP_US - 2e6;/);
});

test('the lobby paints nothing under a game; the toasts and the wallet stay above it', () => {
  const html = read('public/v2.html');
  const rule = html.match(/body\.ingame>header,body\.ingame>nav,body\.ingame>main,body\.ingame>footer,\n?body\.ingame>\.howveil,body\.ingame>\.meveil,body\.ingame>\.apscreen,body\.ingame>\.bsheet\{visibility:hidden\}/);
  assert.ok(rule, 'header (its backdrop blur), nav, screens, footer and the sheets are hidden under the frame');
  assert.ok(!/body\.ingame[^{]*(#toasts|#wallet-root|#game-frame|#agar-frame)[^{]*\{visibility:hidden/.test(html));
  assert.match(html, /<iframe id="game-frame"[^>]*\n?[^>]*position:fixed;inset:0;width:100%;height:100%;border:0;z-index:300;background:#000/,
    'the frame is opaque and covers the page, so hiding what is under it changes nothing on screen');
  // ingame comes and goes with the frame: added as a frame is shown, removed when the game says it is done.
  assert.match(html, /window\._pauseLobbyAnims=\(\)=>\{\s*_paused=true;\s*document\.body\.classList\.add\('ingame'\)/);
  assert.match(html, /document\.body\.classList\.remove\('ingame'\)/);
});
