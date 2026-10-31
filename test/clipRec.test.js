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
  assert.match(gate, /if \(perfFresh && !perf\.ok && !TOP\) return;/, 'a failed frame test stops a game\'s recorder, not the lobby\'s whole-screen one');
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
  /* The picture of what is over the game (2026-10-30) only reads: the page's own pictures, fonts and its font sheet
     from Google, each once, with nothing sent. */
  const ovAt = js.indexOf('/* ── what is over the game');
  const ovEnd = js.indexOf('/* ── encoders');
  assert.ok(ovAt > 0 && ovEnd > ovAt && (ovEnd < start || ovAt > end));
  const ov = js.slice(ovAt, ovEnd);
  assert.deepStrictEqual(ov.match(/fetch\([^)]*\)/g), ["fetch(u, { credentials: 'same-origin' })", 'fetch(s.href)']);
  assert.ok(!/method:|body:|XMLHttpRequest|sendBeacon|postMessage\(/.test(ov), 'reads only');
  const outside = js.slice(0, Math.min(start, ovAt)) + js.slice(Math.min(end, ovEnd), Math.max(start, ovAt))
    + js.slice(Math.max(end, ovEnd));
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
  assert.match(ag, /<script src="\/js\/clip\/clipRec\.js" data-game="agar" data-light="1"><\/script>/);   // dark hint on the light map
  assert.ok(ag.indexOf('/js/clip/clipRec.js') < ag.indexOf('/js/ag/agSound.js'), 'before agar makes a sound');
  const pa = read('public/paper-arena.html');
  assert.match(pa, /<script src="\/js\/clip\/clipRec\.js" data-game="paper" data-dot="bl" data-light="1"><\/script>/,
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

/* 2026-10-28: the encoder's cost grows with the picture's pixels, so a clip is at most 1280x720 (was 1920x1080).
   Measured at 1920x1080, 240 Hz on a busy 2D canvas: the game's thread paid 71 ms a second for recording, now 39;
   the GPU process 227, now 134. A game's recorder leaves the encoder choice to Chrome, which tries the graphics card first and falls back
   to software by itself (prefer-hardware has no fallback: a failing card encoder would stop the recorder). */
test('a picture of at most 1280x720, 30 a second; Chrome picks the encoder with its own fallback', () => {
  const js = rec();
  assert.match(js, /const MAX_W = 1280, MAX_H = 720;/);
  assert.match(js, /const FPS = 30;/);
  assert.match(js, /const k = Math\.min\(1, MAX_W \/ w, MAX_H \/ h\);/, 'the game picture is scaled down to fit');
  assert.match(js, /width: \{ max: MAX_W \}, height: \{ max: MAX_H \}/, 'and the whole-tab capture asks for no more');
  assert.match(js, /for \(const hw of TOP \? \['prefer-hardware', ''\] : \[''\]\)/);
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

/* Owen 2026-10-17, "it should show my mouse and everything that my screen sees": Settings > Clips > Record the whole
   screen. The lobby's own copy keeps the tab itself (getDisplayMedia, this tab only), asked at the switch or at P,
   and each game's recorder stands down while it runs and starts again if it stops or was never allowed. */
test('whole screen: off by default, PC only, asks at a click or P, this tab only, the game recorder as the fallback', () => {
  const js = rec();
  const html = read('public/v2.html');
  assert.match(html, /id="set-tab" role="switch" aria-checked="false"/, 'off until chosen');
  assert.match(html, /<section class="panel set-pc" aria-labelledby="set-clip-h">[\s\S]*id="set-tab"[\s\S]*<\/section>/, 'in the PC-only Clips group');
  assert.match(html, /if\(C&&C\.top\)\{if\(on\)C\.start\(true\);else C\.stop\(\)\}/, 'the switch itself asks for the tab');
  assert.ok(html.indexOf('<script src="/js/clip/mp4mux.js"></script>\n<script src="/js/clip/clipRec.js" data-game="other" data-top="1"></script>') > html.indexOf('id="agar-frame"'));
  assert.match(js, /const tabWanted = \(\) => ls\(LS_TAB\) === '1' && ls\(LS_ON\) !== '0' && !tabDeclined;/);
  assert.match(js, /preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude',/);
  assert.match(js, /if \(!vt \|\| \(surf && surf !== 'browser'\) \|\| running\)/, 'never a window or a whole screen');
  assert.match(js, /if \(TOP && !running\) \{ if \(tabWanted\(\)\) \{ e\.preventDefault\(\); tabStart\(\); \} return; \}/);
  assert.match(js, /if \(T && !T\.on && T\.wanted\(\)\) T\.start\(\);/, 'P in a game asks too (a press in a frame counts for the lobby)');
  assert.match(js, /if \(!TOP\) AudioNode\.prototype\.connect = function/, 'the lobby takes the tab\'s own sound, it never wraps audio');
  assert.match(js, /if \(T && T\.tab\) \{ if \(!tabbed\) \{ vChunks = \[\]; aChunks = \[\]; \} tabbed = true; return; \}/, 'a game\'s recorder stands down');
  assert.match(js, /if \(tabbed\) \{ tabbed = false; vChunks = \[\]; aChunks = \[\]; frameNo = 0;/, 'and starts afresh after');
  assert.match(js, /if \(!TOP\) \{ const T = topClip\(\); if \(T && T\.tab\) return T\.save\(gameNow\(\)\); \}/, 'P in a game saves the whole tab');
  assert.match(js, /tabDeclined = true; stop\('stopped sharing'\);/, 'Stop sharing hands back to the games and P stops asking');
  assert.match(js, /const g = TOP \? \(\/\^\(slither\|agar\|paper\|br\)\$\/\.test\(game\) \? game : 'other'\) : '';/, 'only a known game name goes to the server');
  const pump = js.slice(js.indexOf('async function pumpTab'), js.indexOf('function cursor()'));
  assert.match(pump, /if \(asleep \|\| sizing \|\| now < lateUntil \|\| now - lastCap < 1000 \/ FPS - 3\) \{ f\.close\(\); continue; \}/, 'the game first, 30 a second at most');
  assert.match(pump, /cursor\(\);\n\s*mark\(\);\n\s*encodeMirror\(\);/, 'the mouse and the mark are drawn into the video');
});

/* Owen 2026-10-30: a P clip shows everything a player sees in a game, without tab capture and its Chrome sharing bar.
   The page's HTML over the game is copied, with its styles and fonts, into an SVG image the browser lays out as on
   screen, and drawn between the game's canvases and any canvas boxed inside it; the lobby's own boxes over the frame
   (its toasts) go on top. Checked headless against the live site with this file swapped in, slither.io, agar.io and
   Paper.io: saved clips held the end card (coin, amount, buttons, focus ring), the chat, the leaderboard, the HUD
   and the minimap, and a lobby toast with a shortened address in it showed without the address; the ping and FPS
   readout and the recorder's own notes were left out. */
test('what is over the game is in the clip, drawn again only when it changes', () => {
  const js = rec();
  assert.match(js, /const OV_HIDE = '\.dsp-hud,\.dsclip-t,\.dsclip-dot,\[data-clip-hide\]';/, 'no ping and FPS readout, none of the recorder\'s own notes');
  assert.match(js, /return n\.ownerDocument\.createTextNode\(t\.search\(OV_ADDR\) >= 0 \? t\.replace\(OV_ADDR, ''\) : t\);/, 'no wallet address, whole or shortened');
  const addr = new Function(js.match(/const B58 = .*;/)[0] + js.match(/const OV_ADDR = .*;/)[0] + 'return OV_ADDR;')();
  assert.ok('sent to 7xKp…m3fA'.search(addr) > 0 && '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T'.search(addr) === 0, 'the lobby\'s short form and a whole one');
  assert.equal('Killed by Brody99 at 1,284 length'.search(addr), -1);
  assert.match(js, /attributeOldValue: true, characterDataOldValue: true/, 'a style set again to the same value is no change');
  assert.match(js, /if \(svg === o\.last && o\.ready\) \{ o\.same\+\+;/, 'the same picture is not drawn again');
  assert.match(js, /if \(st\.settle > 0 && st\.settle < 1000 && !o\.held\) \{/, 'the end card rising gets one picture once it has settled');
  assert.match(js, /const lift = ovs\.length && ovs\[0\]\.ready \? Math\.round\(ovs\[0\]\.lift \* \(H \/ innerHeight\)\) : 0;/,
    'the mark steps up above the game\'s own words in its corner (Paper\'s chat hint)');
  assert.match(js, /if \(!roots\) o\.lift = liftFor\(st\.words\);/, 'measured with the picture, not per frame');
  assert.match(js, /const OV_GAP = 100, OV_SHARE = 0\.02;/, 'at most 10 a second and 2% of the page\'s time');
  assert.match(js, /requestIdleCallback\(fn, \{ timeout: 250 \}\)/, 'in idle time');
  assert.match(js, /const url = 'data:image\/svg\+xml;charset=utf-8,' \+ encodeURIComponent\(svg\);/,
    'a data: URL: Chrome marks a blob: SVG holding HTML as another site\'s, which a VideoFrame refuses');
  assert.match(js, /if \(!o\.safe\) \{ o\.x\.getImageData\(0, 0, 1, 1\); o\.safe = true; \}/, 'never draws a picture it may not read back');
  const comp = js.slice(js.indexOf('function composite()'), js.indexOf('function mark()'));
  assert.match(comp, /if \(own && own\.ready\) mctx\.drawImage\(own\.c, 0, 0, W, H\);[\s\S]*if \(top && top\.ready\) mctx\.drawImage\(top\.c, 0, 0, W, H\);/);
  assert.equal((comp.match(/mctx\.globalAlpha = 1;/g) || []).length, 3, 'each picture at full strength, whatever the canvas before it');
  const tick = js.slice(js.indexOf('function tick(now)'), js.indexOf('function encodeMirror()'));
  assert.match(tick, /ovTick\(now\);\n\s*composite\(\);/, 'only while frames are kept: not asleep, not late, not standing down for the whole tab');
  const start = js.slice(js.indexOf('async function start()'));
  assert.match(start, /ovStart\(\);/);
  assert.ok(js.indexOf('if (TOP) return;\n  if (document.readyState') > js.indexOf('async function start()'), 'the lobby\'s whole-tab copy never starts it');
});

test('Settings says what each kind of clip holds', () => {
  const html = read('public/v2.html');
  assert.match(html, /<b id="set-clips-l">Save clips with P<\/b><span>[^<]*end card, chat and HUD[^<]*<\/span>/);
  assert.match(html, /<b id="set-tab-l">Record the whole screen<\/b><span>Adds the lobby, its tabs and your mouse\./);
});
