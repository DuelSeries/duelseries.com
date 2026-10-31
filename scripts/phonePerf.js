'use strict';
/* ─── Phone speed: what a game costs a phone's main thread ──────────────────
   node scripts/phonePerf.js <game> [--land] [--secs 15] [--warm 8] [--runs 1] [--draws] [--json out.json]
     [--base http://localhost:4409] [--throttle 4] [--shot] [--keeptrace]
   games: lobby sl ag paper chomp swim headsoccer knockout rooftop crossy pool8 airhockey battleship

   The phone speed pass (2026-10-31). Headless Chromium as a Samsung S24 (384 x 832 CSS px at dpr 2.8125,
   touch, a phone user agent; --land turns it sideways for Rooftop and Head Soccer), the CPU throttled 4x, the
   cache off. It opens the game's FREE room only (stake 0, no entry token), plays it with a scripted finger (duels
   wait for their bot first) and, after the warm-up, records a Chrome trace of the main thread for --secs:
   ms per second and per frame of busy, script, style, layout, paint and GC, long tasks over 50 ms, layouts and
   style passes per second, garbage collected per second, socket frames per second, and the bytes loaded.
   --draws is a separate pass that counts canvas and WebGL calls per frame (the counting itself costs time, so
   it never runs with the trace).

   There is no GPU here: canvas and WebGL run on SwiftShader, so frame rate and paint time are not a phone's.
   Read script and busy ms per frame, and compare a change against the same setup (an A/B of the file).
   Point it at scripts/dev-local.js (the default URL; SL_ENABLED=1 opens /sl). Never at a paid room. */
const fs = require('fs');
const path = require('path');

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_CORE, 'playwright', 'playwright-core',
    path.join(__dirname, '..', '..', 'video-studio', 'node_modules', 'playwright-core')].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (_) { /* next */ } }
  throw new Error('Playwright not found: npm i -D playwright-core, or set PLAYWRIGHT_CORE');
}
const { chromium } = loadPlaywright();

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes('--' + k);
const GAME = process.argv[2];
const BASE = arg('base', 'http://localhost:4409');
const SECS = +arg('secs', 15), WARM = +arg('warm', 8), DRAWS = flag('draws'), RUNS = +arg('runs', 1);
const THROTTLE = +arg('throttle', 4);
const QUERY = arg('q', '');

const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

// Touch helpers through CDP (real touch events, as a phone sends them)
async function tap(cdp, x, y) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function drag(cdp, x0, y0, x1, y1, steps = 4) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps }] });
  }
}
async function release(cdp) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }

const LAND = flag('land'); const W = LAND ? 832 : 384, H = LAND ? 384 : 832;
let ang = 0;
// A wandering finger held down (joystick / steer games)
async function wander(cdp) {
  ang += 0.9 + Math.random();
  const cx = W / 2, cy = H / 2, r = 90;
  await drag(cdp, cx, cy, cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, 3);
}

const GAMES = {
  lobby: { path: '/', start: async () => {} },
  sl: { path: '/sl', start: async (page) => { await page.click('.slx-direct-play', { timeout: 15000 }); },
    drive: async (page, cdp) => {
      const again = page.getByText('Play again', { exact: true });
      if (await again.isVisible().catch(() => false)) { await again.click({ timeout: 2000 }).catch(() => {}); return; }
      await wander(cdp);
    } },
  ag: { path: '/ag', start: async (page) => { await page.click('#ag-play', { timeout: 15000 }); },
    drive: async (page, cdp) => { await wander(cdp); } },
  paper: { path: '/paper-arena', start: async () => {},
    drive: async (page, cdp) => {
      const again = page.getByText('Play again', { exact: true });
      if (await again.isVisible().catch(() => false)) { await again.click({ timeout: 2000 }).catch(() => {}); return; }
      await wander(cdp);
    } },
  chomp: { path: '/chomp', start: async (page) => { await page.click('#play', { timeout: 15000 }); },
    drive: async (page, cdp) => { const d = [[0, -60], [60, 0], [0, 60], [-60, 0]][Math.floor(Math.random() * 4)];
      await drag(cdp, W / 2, H / 2, W / 2 + d[0], H / 2 + d[1], 3); await release(cdp); } },
  swim: { path: '/swim', start: async () => {}, bot: true,
    drive: async (page, cdp) => { await wander(cdp); } },
  headsoccer: { path: '/headsoccer', start: async () => {}, bot: true,
    drive: async (page, cdp) => { await tap(cdp, 60 + Math.random() * 260, H - 80); } },
  knockout: { path: '/knockout', start: async () => {}, bot: true,
    drive: async (page, cdp) => { await drag(cdp, W / 2, H / 2, W / 2 + (Math.random() - 0.5) * 200, H / 2 + 150, 4); await release(cdp); } },
  rooftop: { path: '/rooftop', start: async () => {}, bot: true,
    drive: async (page, cdp) => { await tap(cdp, W * Math.random(), H * 0.6); } },
  crossy: { path: '/crossy', start: async () => {}, bot: true,
    drive: async (page, cdp) => { await tap(cdp, W / 2, H / 2); } },
  pool8: { path: '/pool8', start: async () => {}, bot: true,
    drive: async (page, cdp) => { await drag(cdp, W / 2, H / 2, W / 2 + 80, H / 2 + 80, 4); await release(cdp); } },
  airhockey: { path: '/airhockey', start: async () => {}, bot: true,
    drive: async (page, cdp) => { await wander(cdp); } },
  battleship: { path: '/battleship', start: async () => {}, bot: true,
    drive: async (page, cdp) => { await tap(cdp, 40 + Math.random() * 300, 200 + Math.random() * 400); } },
};

/* Init script: rAF frame counter (distinct rAF timestamps, no extra loop), long tasks, optional draw counters. */
const INIT = (draws) => {
  const st = window.__perf = { frames: 0, lastTs: -1, long: [], draws: {} };
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return raf.call(window, function (ts) {
      if (ts !== st.lastTs) { st.lastTs = ts; st.frames++; }
      return cb(ts);
    });
  };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) st.long.push(Math.round(e.duration)); })
      .observe({ type: 'longtask', buffered: true });
  } catch (_) {}
  if (!draws) return;
  const bump = (k) => { st.draws[k] = (st.draws[k] || 0) + 1; };
  const wrap = (proto, names, prefix) => {
    if (!proto) return;
    for (const n of names) {
      const f = proto[n];
      if (typeof f !== 'function') continue;
      proto[n] = function () { bump(prefix + n); return f.apply(this, arguments); };
    }
  };
  wrap(window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype,
    ['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'strokeText', 'drawImage', 'clearRect', 'putImageData',
     'getImageData', 'measureText', 'createLinearGradient', 'createRadialGradient', 'createPattern', 'save', 'setLineDash'], '2d.');
  wrap(window.OffscreenCanvasRenderingContext2D && OffscreenCanvasRenderingContext2D.prototype,
    ['fill', 'stroke', 'fillRect', 'fillText', 'drawImage', 'getImageData'], 'off.');
  for (const G of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    wrap(G && G.prototype, ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'bufferData', 'bufferSubData',
      'texImage2D', 'texSubImage2D', 'useProgram', 'bindTexture', 'uniformMatrix4fv', 'readPixels'], 'gl.');
  }
  // shadowBlur draws (costly on canvas2d)
  const P = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
  if (P) {
    for (const n of ['fill', 'stroke', 'fillText', 'drawImage', 'fillRect', 'strokeText']) {
      const f = P[n];
      P[n] = function () { if (this.shadowBlur > 0 && this.shadowColor && this.shadowColor !== 'rgba(0, 0, 0, 0)') bump('2d.SHADOWED'); if (this.filter && this.filter !== 'none') bump('2d.FILTERED'); return f.apply(this, arguments); };
    }
  }
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, o) { bump('canvas.getContext.' + t); return gc.call(this, t, o); };
};

// The trace covers only the measured window. Script is the outermost JS entry of each nest, so nothing counts twice.
function parseTrace(buf) {
  const tr = JSON.parse(buf.toString());
  const ev = tr.traceEvents || tr;
  const mains = new Set();
  for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain') mains.add(e.pid + ':' + e.tid);
  const S = { busy: 0, script: 0, style: 0, layout: 0, paint: 0, gc: 0, gcCount: 0, gcMax: 0, minorFreed: 0, majorFreed: 0,
    layouts: 0, styles: 0, longTasks: [], raf: 0, timers: 0, maxTask: 0 };
  const byThread = new Map();
  for (const e of ev) {
    if (e.ph !== 'X' || !mains.has(e.pid + ':' + e.tid)) continue;
    const k = e.pid + ':' + e.tid;
    if (!byThread.has(k)) byThread.set(k, []);
    byThread.get(k).push(e);
  }
  const SCRIPTCORE = new Set(['v8.callFunction', 'FunctionCall', 'EvaluateScript', 'v8.compile', 'v8.evaluateModule', 'RunMicrotasks', 'v8.run', 'V8.Execute']);
  for (const [, list] of byThread) {
    list.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    let scriptEnd = -1;
    for (const e of list) {
      const d = (e.dur || 0) / 1000;
      if (e.name === 'RunTask') { S.busy += d; if (d > 50) S.longTasks.push(Math.round(d)); if (d > S.maxTask) S.maxTask = d; }
      if (SCRIPTCORE.has(e.name) && e.ts >= scriptEnd) { S.script += d; scriptEnd = e.ts + (e.dur || 0); }
      if (e.name === 'UpdateLayoutTree') { S.style += d; S.styles++; }
      if (e.name === 'Layout') { S.layout += d; S.layouts++; }
      if (e.name === 'Paint' || e.name === 'PrePaint' || e.name === 'Layerize' || e.name === 'Commit' || e.name === 'PaintImage' || e.name === 'UpdateLayer') S.paint += d;
      if (e.name === 'MinorGC' || e.name === 'MajorGC') {
        S.gc += d; S.gcCount++; if (d > S.gcMax) S.gcMax = d;
        const a = e.args || {};
        const fr = (a.usedHeapSizeBefore || 0) - (a.usedHeapSizeAfter || 0);   // garbage collected: the allocation rate, near enough
        if (e.name === 'MinorGC') S.minorFreed += fr; else S.majorFreed += fr;
      }
      if (e.name === 'FireAnimationFrame') S.raf++;
      if (e.name === 'TimerFire') S.timers++;
    }
  }
  return S;
}

async function runOnce(browser) {
  const g = GAMES[GAME];
  if (!g) throw new Error('unknown game ' + GAME);
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2.8125, isMobile: true, hasTouch: true, userAgent: UA });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('playerName', 'PerfBot'); sessionStorage.setItem('stake', '0'); sessionStorage.setItem('entryToken', '');
      sessionStorage.setItem('entrySol', '0'); sessionStorage.setItem('region', 'na');
      localStorage.setItem('duelseries_guestname', 'Guest4242');
    } catch (_) {}
  });
  await page.addInitScript(INIT, DRAWS);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  // bytes by type
  const types = new Map(), bytes = {};
  let ws = { recv: 0, sent: 0, recvBytes: 0, sentBytes: 0, counting: false, firstRecvAt: 0 };
  cdp.on('Network.responseReceived', (p) => types.set(p.requestId, p.type));
  cdp.on('Network.loadingFinished', (p) => { const t = types.get(p.requestId) || 'Other'; bytes[t] = (bytes[t] || 0) + p.encodedDataLength; });
  cdp.on('Network.webSocketFrameReceived', (p) => { if (!ws.firstRecvAt && ws.armed) ws.firstRecvAt = Date.now(); if (ws.counting) { ws.recv++; ws.recvBytes += (p.response.payloadData || '').length; } });
  cdp.on('Network.webSocketFrameSent', (p) => { if (ws.counting) { ws.sent++; ws.sentBytes += (p.response.payloadData || '').length; } });
  const t0 = Date.now();
  await page.goto(BASE + g.path + QUERY, { waitUntil: 'load', timeout: 60000 });
  const loadMs = Date.now() - t0;
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), fcp: fcp ? Math.round(fcp.startTime) : null }; });
  ws.armed = true;
  const tStart = Date.now();
  await g.start(page, cdp);
  const startMs = Date.now() - t0;
  // warm: bots arrive at 10 s for duels
  const warm = (g.bot ? 14 : 0) + WARM;
  const tw = Date.now();
  while (Date.now() - tw < warm * 1000) {
    if (g.drive && (!g.bot || Date.now() - tw > 14000)) await g.drive(page, cdp).catch(() => {});
    await page.waitForTimeout(900);
  }
  const playMs = ws.firstRecvAt ? ws.firstRecvAt - tStart : null;
  const loadBytes = Object.assign({}, bytes);
  // window
  const nodes0 = await page.evaluate(() => document.getElementsByTagName('*').length);
  const heap0 = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  const f0 = await page.evaluate(() => ({ frames: window.__perf.frames, draws: Object.assign({}, window.__perf.draws), long: window.__perf.long.length }));
  if (!DRAWS) {
    await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'disabled-by-default-v8.gc', 'toplevel', 'blink'] });
  }
  const w0 = Date.now();
  const hr0 = await page.evaluate(() => performance.timeOrigin + performance.now());
  ws.counting = true;
  while (Date.now() - w0 < SECS * 1000) {
    if (g.drive) await g.drive(page, cdp).catch(() => {});
    await page.waitForTimeout(900);
  }
  ws.counting = false;
  const winMs = Date.now() - w0;
  let trace = null;
  if (!DRAWS) trace = await browser.stopTracing();
  const f1 = await page.evaluate(() => ({ frames: window.__perf.frames, draws: Object.assign({}, window.__perf.draws), long: window.__perf.long.slice() }));
  const nodes1 = await page.evaluate(() => document.getElementsByTagName('*').length);
  const heap1 = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  const frames = f1.frames - f0.frames;
  const out = { game: GAME, winS: +(winMs / 1000).toFixed(1), frames, fps: +(frames / (winMs / 1000)).toFixed(1),
    loadMs, nav, startMs, playMs, nodes: [nodes0, nodes1], heapMB: [+(heap0 / 1e6).toFixed(1), +(heap1 / 1e6).toFixed(1)],
    wsPerS: { recv: +(ws.recv / (winMs / 1000)).toFixed(1), sent: +(ws.sent / (winMs / 1000)).toFixed(1),
      recvKBs: +(ws.recvBytes / 1024 / (winMs / 1000)).toFixed(1), sentKBs: +(ws.sentBytes / 1024 / (winMs / 1000)).toFixed(2) },
    loadKB: Object.fromEntries(Object.entries(loadBytes).map(([k, v]) => [k, Math.round(v / 1024)])),
    errors: errors.slice(0, 4) };
  if (trace) {
    const S = parseTrace(trace);
    const perS = (v) => +(v / (winMs / 1000)).toFixed(1);
    const perF = (v) => frames ? +(v / frames).toFixed(2) : null;
    out.msPerS = { busy: perS(S.busy), script: perS(S.script), style: perS(S.style), layout: perS(S.layout), paint: perS(S.paint), gc: perS(S.gc) };
    out.msPerFrame = { busy: perF(S.busy), script: perF(S.script), style: perF(S.style), layout: perF(S.layout), gc: perF(S.gc) };
    out.counts = { layoutsPerS: perS(S.layouts), stylesPerS: perS(S.styles), rafPerFrame: perF(S.raf),
      timersPerS: perS(S.timers), gcPerS: perS(S.gcCount), gcMaxMs: +S.gcMax.toFixed(1), allocMBs: +((S.minorFreed + S.majorFreed) / 1e6 / (winMs / 1000)).toFixed(2),
      longTasks: S.longTasks.length, longMax: S.longTasks.length ? Math.max(...S.longTasks) : 0, maxTaskMs: +S.maxTask.toFixed(1) };
    if (flag('keeptrace')) fs.writeFileSync('trace-' + GAME + '.json', trace);
  } else {
    const d = {};
    for (const k of Object.keys(f1.draws)) { const v = f1.draws[k] - (f0.draws[k] || 0); if (v) d[k] = frames ? +(v / frames).toFixed(1) : v; }
    out.drawsPerFrame = d;
  }
  if (flag('shot')) await page.screenshot({ path: 'phonePerf-' + GAME + (DRAWS ? '-d' : '') + '.png', timeout: 8000 }).catch(() => {});
  await ctx.close();
  return out;
}

(async () => {
  const browser = await chromium.launch({ args: (process.env.GPUFLAGS || '--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist --enable-gpu-rasterization --enable-accelerated-2d-canvas').split(' ') });
  const res = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await runOnce(browser);
    res.push(r);
    console.log(JSON.stringify(r));
  }
  await browser.close();
  const out = arg('json', null);
  if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
