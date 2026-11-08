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
  assert.match(js, /worker\.postMessage\(\{ frame: f, key, gen: vGen \}, \[f\]\);/);
  assert.match(js, /enc\.encode\(m\.frame, \{ keyFrame: m\.key \}\);/, 'the key frame mark reaches the encoder in its worker');
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
  const outside = (js.slice(0, Math.min(start, ovAt)) + js.slice(Math.min(end, ovEnd), Math.max(start, ovAt))
    + js.slice(Math.max(end, ovEnd)))
    // the picture's own encoder worker and the sound's tap are this page's, nothing leaves the PC through them
    .replace(/\b(worker|self|this\.port)\.postMessage\(/g, '');
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

/* Owen 2026-10-30: clips came out "laggy, low quality" with the sound ending halfway. The picture used to stop for 2 to
   16 s whenever the game's frames ran late, so a busy PC kept 2 s of picture in a 30 s clip; now frames are kept 30 a
   second on average whatever the game's pace, with the encoding in a worker. Checked against the line itself. */
test('30 frames a second whatever the game\'s pace; nothing stops the picture when the game runs late', () => {
  const js = rec();
  const line = js.match(/nextCap = Math\.max\(nextCap \+ 1000 \/ FPS, now \+ 500 \/ FPS\);/);
  assert.ok(line, 'each frame is due a 30th of a second after the last one was due');
  // eslint-disable-next-line no-new-func
  const kept = (hz, secs) => new Function('FPS', 'hz', 'secs',
    'let nextCap = 0, n = 0; for (let now = 0; now < secs * 1000; now += 1000 / hz) { if (now < nextCap) continue; '
    + line[0] + ' n++; } return n / secs;')(30, hz, secs);
  for (const hz of [55, 60, 75, 144, 240]) assert.ok(Math.abs(kept(hz, 20) - 30) < 0.6, hz + ' Hz game keeps ' + kept(hz, 20));
  assert.ok(Math.abs(kept(25, 20) - 25) < 0.6, 'a game under 30 fps keeps every frame it has');
  assert.ok(!/lateUntil|paceMed|yields/.test(js), 'no stop when the game runs late');
  assert.match(js, /if \(sent - got > INFLIGHT\) \{ slow\+\+;/, 'an encoder that falls behind still stops the recorder in the end');
  assert.match(js, /new Worker\(URL\.createObjectURL\(new Blob\(\['\(' \+ encoderWorker \+ '\)\(\)'\]/, 'the encoder runs in a worker');
  assert.match(js, /f = new VideoFrame\(mirror, \{ timestamp: ts \}\);/);
});

/* The sound is read on the audio thread (an AudioWorklet) and stamped from the audio clock, so a busy page that reads
   it late loses nothing; it was read on the page's thread, which dropped blocks, and the muxer writes AAC frames back
   to back, so every lost block shortened the sound track and moved it off the picture. */
test('every block of sound, in order, stamped from the audio clock', () => {
  const js = rec();
  assert.match(js, /registerProcessor\("dsclip-tap"/);
  assert.match(js, /this\.port\.postMessage\(\{at:this\.at,l:this\.l,r:this\.r\},\[this\.l\.buffer,this\.r\.buffer\]\)/);
  assert.match(js, /await mixer\.audioWorklet\.addModule\(/);
  assert.match(js, /const o = mixer\.getOutputTimestamp\(\);/);
  assert.match(js, /ms = o\.performanceTime \+ \(m\.at \/ aRate - o\.contextTime\) \* 1000/, 'from the frame count, not from when the page read it');
  assert.ok(!/MediaStreamTrackProcessor\(\{ track: mixDest/.test(js), 'no longer read on the page\'s thread');
  // the tap never makes a sound of its own
  assert.match(js, /mute\.gain\.value = 0;/);
});

test('asleep (no picture, no sound, no encoding) while hidden or untouched for 45 s; waking starts the buffer again', () => {
  const js = rec();
  assert.match(js, /const IDLE_MS = 45000;/);
  assert.match(js, /if \(document\.hidden\) doze\(\);/);
  assert.match(js, /if \(!asleep && now - lastInput > IDLE_MS\) doze\(\);/);
  assert.match(js, /if \(asleep \|\| !capturing \|\| now < nextCap\) return;/, 'the tick captures nothing asleep');
  assert.match(js, /if \(!aEnc \|\| !running \|\| asleep \|\| tabbed\) return;/, 'no sound is encoded asleep');
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

/* 2026-10-30 (Owen: "low quality"): the window's own size up to 1920x1080 at 8 Mbps; 1280x720 at a size-based
   rate came out near 1.5 Mbps. 2026-11-08 (Owen, cropping clips to phone-shaped shorts: "worse quality than the game"):
   his 2560x1440 screen came out 1920x1038, so the cap is 1440p, at 0.16 bits a pixel a frame (17 Mbps at his
   2560x1384 window). The encoding runs in a worker, so the size no longer costs the game's thread. A game's recorder
   leaves the encoder choice to Chrome, which tries the graphics card first and falls back to software by itself
   (prefer-hardware has no fallback: a failing card encoder would stop the recorder). */
test('a picture up to 2560x1440 at 0.16 bits a pixel, 30 a second; Chrome picks the encoder with its own fallback', () => {
  const js = rec();
  assert.match(js, /const MAX_W = 2560, MAX_H = 1440;/);
  assert.match(js, /const STEPS = \[\[2560, 1440\], \[1920, 1080\], \[1280, 720\]\];/);
  assert.match(js, /const BPP = 0\.16, MIN_RATE = 6e6;/);
  assert.match(js, /cfg = await pickCodec\(W, H, rateFor\(W, H\)\);/);
  assert.match(js, /const FPS = 30;/);
  // eslint-disable-next-line no-new-func
  const rateFor = new Function('FPS', 'BPP', 'MIN_RATE', 'return ' + js.match(/const rateFor = (\(w, h\) => [^;]+);/)[1])(30, 0.16, 6e6);
  assert.ok(Math.abs(rateFor(2560, 1384) - 17e6) < 0.1e6, 'Owen\'s window: ' + rateFor(2560, 1384));
  assert.ok(rateFor(1920, 1080) > 8e6, 'more than the old 8 Mbps at 1080p too');
  assert.strictEqual(rateFor(1280, 720), 6e6, 'never under 6 Mbps');
  assert.match(js, /const k = Math\.min\(1, maxW \/ w, maxH \/ h\);/, 'the picture is scaled down to fit');
  assert.match(js, /width: \{ max: MAX_W \}, height: \{ max: MAX_H \}/, 'and the whole-tab capture asks for no more');
  assert.match(js, /for \(const hw of TOP \? \['prefer-hardware', ''\] : \[''\]\)/);
  // a graphics card's encoder held up to 42 frames (1.2 s) at 1440p in 'quality', 8 in 'realtime', same bitrate
  assert.match(js, /const LATENCY = 'realtime';/);
});

/* H.264 level 4.0 holds pictures up to 1920x1088; Chrome turns avc1.640028 down at 2560x1440 (headless check
   2026-11-08), so a bigger picture asks for level 5.0. No encoder at a size: a size down, then none. */
test('level 5.0 for a picture over 1080p; an encoder behind steps 1440p, 1080p, 720p, then stops', () => {
  const js = rec();
  assert.match(js, /const big = Math\.ceil\(w \/ 16\) \* Math\.ceil\(h \/ 16\) > 8192;/);
  assert.match(js, /big \? \['avc1\.640032', 'avc1\.4D4032', 'avc1\.42E032'\] : \['avc1\.640028', 'avc1\.4D4028', 'avc1\.42E028', 'avc1\.42E01F'\]/);
  const mbs = (w, h) => Math.ceil(w / 16) * Math.ceil(h / 16);
  assert.ok(mbs(1920, 1080) <= 8192 && mbs(2560, 1384) > 8192 && mbs(2560, 1440) <= 22080, 'level 4.0 to 1080p, 5.0 above');
  assert.match(js, /if \(cfg \|\| !stepDown\(\)\) break;/, 'no encoder at a size: the next size down');
  // eslint-disable-next-line no-new-func
  const ladder = new Function('STEPS', 'MAX_W', 'MAX_H', 'let maxW = MAX_W, maxH = MAX_H; '
    + js.slice(js.indexOf('function stepDown()'), js.indexOf('function behind()'))
    + 'const out = []; while (stepDown()) out.push(maxW + "x" + maxH); return out;')([[2560, 1440], [1920, 1080], [1280, 720]], 2560, 1440);
  assert.deepStrictEqual(ladder, ['1920x1080', '1280x720']);
  const behind = js.slice(js.indexOf('function behind()'), js.indexOf('/* Asleep:'));
  assert.match(behind, /if \(stepDown\(\)\) \{ sent = got;/);
  assert.match(behind, /stop\('the encoder cannot keep up', true\);/);
});

/* The worker says how many frames its encoder has taken off its queue (encoded, or skipped by its own rate control,
   which sends nothing back): counting outputs instead, each skipped frame would count as still out for good, and
   twelve of them would read as an encoder behind. */
test('frames still out are counted from what the encoder took, not from what it gave back', () => {
  const js = rec();
  assert.match(js, /const taken = \(\) => given - \(enc && gen === g \? enc\.encodeQueueSize : 0\);/);
  assert.match(js, /enc\.ondequeue = \(\) => \{ if \(gen === g\) self\.postMessage\(\{ gen: g, taken: taken\(\) \}\); \};/);
  assert.match(js, /if \(m\.taken > got\) got = m\.taken;/);
  assert.ok(!/got\+\+/.test(js), 'no count of outputs');
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
  assert.match(html, /<div class="set-grp set-pc" role="group" aria-labelledby="set-clip-h">[\s\S]*id="set-tab"[\s\S]*<\/section>/, 'in the PC-only Clips group');
  assert.match(html, /if\(C&&C\.top\)\{if\(on\)C\.start\(true\);else C\.stop\(\)\}/, 'the switch itself asks for the tab');
  /* The lobby's copy comes after the page has loaded (DSLater, lobby first load 2026-11-01), mp4mux first, with the
     attributes its tag had: data-game="other" data-top="1" (document.currentScript.dataset is read the same way). */
  const later = html.indexOf("['/js/clip/mp4mux.js'],['/js/clip/clipRec.js',{game:'other',top:'1'}]");
  assert.ok(later > html.indexOf('id="agar-frame"'), 'the lobby loads mp4mux then clipRec (data-game other, data-top 1)');
  assert.ok(!/<script src="\/js\/clip\/(mp4mux|clipRec)\.js"/.test(html), 'and no tag of either holds up the lobby');
  assert.match(js, /const tabWanted = \(\) => ls\(LS_TAB\) === '1' && ls\(LS_ON\) !== '0' && !tabDeclined;/);
  assert.match(js, /preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude',/);
  assert.match(js, /if \(!vt \|\| \(surf && surf !== 'browser'\) \|\| running\)/, 'never a window or a whole screen');
  assert.match(js, /if \(TOP && !running\) \{ if \(tabWanted\(\)\) \{ e\.preventDefault\(\); tabStart\(\); \} return; \}/);
  assert.match(js, /if \(T && !T\.on && T\.wanted\(\)\) T\.start\(\);/, 'P in a game asks too (a press in a frame counts for the lobby)');
  assert.match(js, /if \(!TOP\) AudioNode\.prototype\.connect = function/, 'the lobby takes the tab\'s own sound, it never wraps audio');
  assert.match(js, /if \(T && T\.tab\) \{ if \(!tabbed\) \{ vChunks = \[\]; aChunks = \[\]; dot\(false\); \} tabbed = true; if \(T\.dot\) T\.dot\(DOT, LIGHT\); return; \}/,
    'a game\'s recorder stands down, its dot shown by the lobby');
  assert.match(js, /if \(tabbed\) \{ tabbed = false; vChunks = \[\]; aChunks = \[\]; frameNo = 0; dot\(true\); \}/, 'and starts afresh after');
  assert.match(js, /if \(!TOP\) \{ const T = topClip\(\); if \(T && T\.tab\) return T\.save\(gameNow\(\)\); \}/, 'P in a game saves the whole tab');
  assert.match(js, /tabDeclined = true; stop\('stopped sharing'\);/, 'Stop sharing hands back to the games and P stops asking');
  assert.match(js, /const g = TOP \? \(\/\^\(slither\|agar\|paper\|br\)\$\/\.test\(game\) \? game : 'other'\) : '';/, 'only a known game name goes to the server');
  const pump = js.slice(js.indexOf('async function pumpTab'), js.indexOf('function cursor()'));
  /* Paced and stamped by when the tab captured each frame, not when the busy page read it (Owen 2026-11-08: a frame
     read late made the next one look early, and it was dropped; his 1440p clip held 27.4 a second). */
  assert.match(pump, /const at = capturedAt\(f, now\);\n\s*if \(asleep \|\| sizing \|\| at < nextCap - 400 \/ FPS\) \{ f\.close\(\); continue; \}/, 'a frame when it is due');
  assert.match(pump, /nextCap = Math\.max\(nextCap \+ 1000 \/ FPS, at \+ 500 \/ FPS\);/);
  assert.match(js, /new MediaStreamTrackProcessor\(\{ track: vt, maxBufferSize: 4 \}\)/, 'a few frames may wait while the page is busy');
  // the capture clock against the page's: its least gap is the offset; one that does not run forward is not trusted
  // eslint-disable-next-line no-new-func
  const capAt = new Function(js.slice(js.indexOf('let capOff = null'), js.indexOf('// The mouse: tab capture')) + 'return capturedAt;')();
  const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-6, why + ': ' + a);
  near(capAt({ timestamp: 5e6 }, 1020), 1020, 'the first frame sets the offset');
  near(capAt({ timestamp: 5033333 }, 1090), 1053.333, 'read 37 ms late, it keeps its place 33 ms on');
  near(capAt({ timestamp: 5066667 }, 1091), 1086.667, 'and the one read straight after it too');
  near(capAt({ timestamp: 5066667 }, 1130), 1130, 'a capture clock standing still: the page clock');
  /* Owen's whole-tab clip of 2026-11-06 held 667 frames in 30.3 s (22 a second): the tab sends about 30 a second,
     never exactly 33 ms apart, and "at least 30 ms since the last one" dropped each one that came early. */
  // eslint-disable-next-line no-new-func
  const kept = (rule, jitter) => new Function('FPS', 'jitter', 'let nextCap = 0, lastCap = 0, n = 0, seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;'
    + 'for (let i = 0; i < 900; i++) { const now = i * 1000 / 30 + (rnd() * 2 - 1) * jitter; if (' + rule + ') continue; '
    + 'nextCap = Math.max(nextCap + 1000 / FPS, now + 500 / FPS); lastCap = now; n++; } return n / 30;')(30, jitter);
  assert.ok(kept('now - lastCap < 1000 / FPS - 3', 6) < 26, 'the old rule: ' + kept('now - lastCap < 1000 / FPS - 3', 6));
  for (const j of [0, 3, 6, 10]) assert.ok(kept('now < nextCap - 400 / FPS', j) > 29.5, 'jitter ' + j + ' ms: ' + kept('now < nextCap - 400 / FPS', j));
  // the recorder's own cards and dot are left out of the tab's video (Owen 2026-11-08): held to the body, they are not in it
  assert.match(js, /await vt\.restrictTo\(await RestrictionTarget\.fromElement\(b\)\);/);
  assert.match(js, /body\.dsclip-cap\{isolation:isolate!important;transform-style:flat!important\}/, 'the body forms a stacking context, as Chrome needs');
  assert.match(js, /await holdToBody\(vt\);\n\s*tabStarting = false;/, 'held before the first frame is read');
  assert.match(js, /card\.setAttribute\('aria-live', 'polite'\);[\s\S]{0,200}document\.documentElement\.appendChild\(card\);/, 'the cards hang off <html>, outside the body');
  assert.match(js, /dotEl\.appendChild\(document\.createTextNode\('P clip'\)\);\n\s*document\.documentElement\.appendChild\(dotEl\);/, 'and the dot');
  assert.match(js, /letGo\(\);/, 'let go when the recording stops');
  assert.match(pump, /cursor\(\);\n\s*mark\(\);\n\s*encodeMirror\(at\);/, 'the mouse and the mark are drawn into the video');
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
  assert.match(js, /const OV_GAP = 250, OV_SHARE = 0\.02;/, 'at most 4 a second and 2% of the page\'s time');
  assert.match(js, /if \(tag === 'IMG' && nativeImg\.has\(n\)\) return null;/, 'slither\'s minimap dot is drawn from the page, not copied');
  assert.match(js, /if \(r\.type === 'attributes' && \(t\.tagName === 'CANVAS' \|\| nativeImg\.has\(t\)\)\) continue;/, 'and its moves make no new picture');
  assert.match(js, /if \(!img\.complete \|\| !img\.naturalWidth \|\| !ownSrc\(img\.currentSrc \|\| img\.src\) \|\| !visible\(img\)\) continue;/,
    'only this site\'s or data: pictures, which never mark the video as another site\'s');
  assert.match(js, /requestIdleCallback\(fn, \{ timeout: 250 \}\)/, 'in idle time');
  assert.match(js, /const url = 'data:image\/svg\+xml;charset=utf-8,' \+ encodeURIComponent\(pre\) \+ o\.fontEnc \+ encodeURIComponent\(post\);/,
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

/* Owen 2026-11-08: clips darker than the game. Chrome encodes a frame it converts on the CPU at full range (black 0)
   and one on the graphics card at limited range (black 16), says which in decoderConfig.colorSpace, and the graphics
   card's encoders tag neither; players read untagged video as limited range, so his clips' darks were crushed. */
test('colour: squeezed into video range when the encoder says full range, and tagged BT.709 limited range', () => {
  const js = rec();
  assert.match(js, /cs: cs \? \{ fullRange: cs\.fullRange, matrix: cs\.matrix, primaries: cs\.primaries \} : null/, 'the worker hands back what the encoder said');
  assert.match(js, /if \(m\.cs\) colourFrom\(m\.cs\);/);
  assert.match(js, /function encodeMirror\(at\) \{\n\s*videoLevels\(\);/, 'every frame goes through the squeeze, whichever recorder made it');
  assert.match(js, /const SAT = 'saturate\(' \+ 224 \/ 219 \+ '\)', LIFT = 'rgba\(113,113,113,' \+ 36 \/ 255 \+ '\)';/);
  assert.match(js, /video: \{ width: W, height: H, description: vDesc, chunks: v, color: colourTag\(\) \},/, 'the clip says what it is');
  // eslint-disable-next-line no-new-func
  const m = new Function('let W = 0, mctx = null, mirror = null;' + js.slice(js.indexOf('  let levels = false, vCs = null;'), js.indexOf('  const rateFor = ')) + 'return { colourFrom, colourTag, get levels() { return levels; }, get W() { return W; }, setW(w) { W = w; } };');
  const c = m();
  c.setW(2560);
  c.colourFrom({ fullRange: false, matrix: 'bt709', primaries: 'bt709' });
  assert.strictEqual(c.levels, false, 'limited range already: left alone');
  assert.strictEqual(c.W, 2560, 'and the encoder keeps going');
  c.colourFrom({ fullRange: true, matrix: 'bt709', primaries: 'bt709' });
  assert.strictEqual(c.levels, true, 'full range: squeezed from now on');
  assert.strictEqual(c.W, 0, 'the encoder starts again, so no clip mixes the two');
  c.setW(2560);
  c.colourFrom({ matrix: 'bt709' });
  assert.strictEqual(c.levels, true, 'an encoder that says nothing about range keeps what was decided');
  assert.deepStrictEqual(c.colourTag(), { primaries: 1, transfer: 1, matrix: 1, full: false });
  c.colourFrom({ fullRange: true, matrix: 'smpte170m', primaries: 'bt709' });
  assert.strictEqual(c.colourTag().matrix, 6, 'another matrix named is the one tagged');
  // the poster on the Clips wall is the squeezed picture undone: 16 is black again, 235 white
  assert.match(js, /if \(levels\) \{      \/\/ the hidden canvas holds the squeezed picture/);
});

/* Owen 2026-11-08: his 10:43 slither clip had no game sound. The server adds this recorder at the end of slither's page,
   after the house sound engine (dsSfx.js) has joined its output to the speakers, so the wrapped connect() never saw it.
   Headless, the game's own sounds playing in /sl: the live recorder's clip RMS 0.003 (silent), this one 0.024. */
test('sound: the house sound engine is tapped even when it loaded first; the tab is shared without mic processing', () => {
  const js = rec();
  assert.match(js, /function tapSfx\(\) \{\n\s*const S = window\.DSSfx;\n\s*if \(TOP \|\| !S/, 'never in the lobby: the tab\'s sound has it');
  assert.match(js, /if \(c && o\) origConnect\.call\(o, tapFor\(c\)\);/);
  assert.match(js, /\};\n[\s\S]{0,900}\n  tapSfx\(\);\n/, 'at once when the recorder loads');
  assert.match(js, /if \(!\(await startVideo\(\)\)\) return;\n\s*tapSfx\(\);/, 'and when it starts, for an engine that loaded after it');
  assert.match(read('server/sl/slBoot.js'), /<script src="\/js\/clip\/clipRec\.js" data-game="slither"><\/script>/, 'slither\'s page still adds it at the end');
  assert.match(js, /audio: \{ suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 \},/);
});
