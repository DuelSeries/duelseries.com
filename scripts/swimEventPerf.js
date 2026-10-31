'use strict';
/* ─── Swim Race: one race measured end to end ────────────────────────────────
   Boots the real server locally (scripts/dev-local.js) with the race every --every seconds, fills the race with
   --n entrants, and measures it:
     - the server: what a race tick costs (SwimEvent.perf, logged every 5 s), heap and RSS;
     - the wire: what each racer's socket is sent (scripts/swimEventLoad.js, the N - pages test clients, each a
       real socket.io connection driving its car with the duel's bot driver and sending se:in like a page);
     - the page: headless Chrome racing in /swimrace (desktop 1280x800, and a phone 390x844 at dpr 3 with the CPU
       throttled 4x), its own car driven by the same bot through the page's test hook (__swimraceDriver), frame
       times sampled every second, with the frame-rate limit and vsync off so the number is what a frame costs.
     node scripts/swimEventPerf.js --n 50 [--secs 90] [--pages desktop,phone] [--port 4474]
   Needs Playwright (as scripts/swimScenePerf.js) and Google Chrome. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('n', 8)), SECS = Number(arg('secs', 90)), PORT = String(arg('port', 4474)), EVERY = Number(arg('every', 40));
const PAGES = String(arg('pages', 'desktop,phone')).split(',').filter(Boolean);
/* --watch: the pages only watch (no driver of their own), so their frames are the game's alone. */
const WATCH = process.argv.includes('--watch');
const URL = 'http://127.0.0.1:' + PORT;

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_CORE, 'playwright', 'playwright-core',
    path.join(ROOT, '..', 'video-studio', 'node_modules', 'playwright-core')].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (_) { /* next */ } }
  throw new Error('Playwright not found');
}
const FLAGS = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit', '--disable-gpu-vsync']
  .concat(process.platform === 'win32' ? ['--use-angle=d3d11'] : []);
const CONFIGS = {
  desktop: { ctx: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
  phone: { ctx: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, cpu: 4 },
};

const { driverScript, lightDriverScript } = require('./swimEventDriver');

const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swimev-'));
  const env = Object.assign({}, process.env, {
    DEV_LOCAL_PORT: PORT, SWIM_EVENT_EVERY_SEC: String(EVERY), SWIM_EVENT_PER_IP: '99', SWIM_EVENT_PERF_LOG: '1',
    SWIM_EVENT_PATH: path.join(tmp, 'swim-event.json'),
  });
  const server = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-local.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const perf = [];
  let up = false, startedAt = 0, overLine = '';
  const onLine = (line) => {
    if (line.includes('Server running at')) up = true;
    if (line.startsWith('[SE perf] ')) { try { perf.push(JSON.parse(line.slice(10))); } catch (_) {} if (process.env.SE_VERBOSE) console.log('  ' + line.trim()); }
    if (process.env.SE_VERBOSE && (line.startsWith('[SE parts]') || line.startsWith('[SE slow]'))) console.log('  ' + line.trim());
    if (line.includes('[SE] slot') || line.includes('[SE] race')) { console.log('  server: ' + line.trim()); if (line.includes('started')) startedAt = Date.now(); if (line.includes(' over ')) overLine = line.trim(); }
    if (/Error|TypeError|ReferenceError/.test(line) && line.includes('SE')) console.log('  server ERR: ' + line.trim());
  };
  let buf = '';
  const feed = (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } };
  server.stdout.on('data', feed); server.stderr.on('data', feed);
  const kill = () => { try { server.kill(); } catch (_) {} };
  process.on('exit', kill);
  for (let i = 0; i < 300 && !up; i++) await new Promise(r => setTimeout(r, 200));
  if (!up) { console.log('server did not start'); kill(); process.exit(1); }

  /* The test clients in processes of at most PER each, so no one process falls behind driving its cars (a late
     input is a car the server drives on blind, then a correction on that screen). */
  const nLoad = Math.max(0, N - (WATCH ? 0 : PAGES.length)), PER = 8;
  const loads = [], loadLines = [];
  for (let k = 0; k * PER < nLoad; k++) {
    const n = Math.min(PER, nLoad - k * PER);
    const load = spawn(process.execPath, [path.join(ROOT, 'scripts/swimEventLoad.js'), '--url', URL, '--n', String(n), '--first', String(k * PER),
      '--secs', String(SECS + EVERY + 30)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    load.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach(l => { loadLines.push({ k, l }); if (!l.startsWith('[load]') && k === 0) console.log('  load: ' + l); }));
    load.stderr.on('data', (d) => console.log('  load ERR: ' + String(d).trim()));
    loads.push(load);
  }
  process.on('exit', () => { for (const l of loads) try { l.kill(); } catch (_) {} });

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: FLAGS });
  const pages = [];
  for (const name of PAGES) {
    const cfg = CONFIGS[name];
    const ctx = await browser.newContext(cfg.ctx);
    if (!WATCH) await ctx.addInitScript(() => { try { sessionStorage.setItem('seJoin', '1'); sessionStorage.setItem('playerName', 'perf-' + (innerWidth < 600 ? 'phone' : 'desk')); } catch (_) {} });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('  page ' + name + ' error: ' + e.message));
    if (cfg.cpu) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: cfg.cpu }); }
    await page.goto(URL + '/swimrace', { waitUntil: 'load' });
    await page.addScriptTag({ content: arg('driver', 'bot') === 'light' ? lightDriverScript() : driverScript() });
    if (process.argv.includes('--noblur')) await page.addStyleTag({ content: '#pads button{backdrop-filter:none!important}' });
    pages.push({ name, page, samples: [], drove: 0 });
  }
  console.log(`measuring: ${N} entrants (${nLoad} socket test clients + ${PAGES.join(', ')} pages), race every ${EVERY} s`);

  const t0 = Date.now();
  while (Date.now() - t0 < (EVERY + SECS + 20) * 1000) {
    await new Promise(r => setTimeout(r, 1000));
    for (const p of pages) {
      const s = await p.page.evaluate(() => {
        const w = window.__swimrace || {}, ft = window.__ft || [];
        const take = ft.splice(0, ft.length), js = (window.__js || []).splice(0, (window.__js || []).length);
        const drv = (window.__drv || []).splice(0, (window.__drv || []).length);
        return { state: w.state, lanes: w.lanes, out: w.out, alive: w.car ? w.car.alive : null, z: w.car ? Math.round(w.car.z) : 0, ghosts: w.ghosts,
          cars: w.cars, corr: w.corrections, rtt: w.rtt, calls: w.scene ? w.scene.calls : 0, tri: w.scene ? w.scene.triangles : 0, dpr: w.scene ? w.scene.dpr : 0, ft: take, js, drv };
      }).catch(() => null);
      if (s && s.state === 'racing') { p.samples.push(s); if (!s.out && !WATCH) p.drove++; }
    }
    if (overLine || (startedAt && Date.now() - startedAt > (SECS + 10) * 1000)) break;
  }

  console.log('\n== ' + N + ' entrants ==');
  if (perf.length) {
    const last = perf[perf.length - 1];
    const avg = perf.map(p => p.avgMs).filter(v => v !== null), p99 = perf.map(p => p.p99Ms).filter(v => v !== null);
    console.log(`server: ${last.lanes} lanes, ${last.cars} cars; tick avg ${q(avg, 0.5)} ms (median of 5 s windows), p99 up to ${Math.max(...p99)} ms, ` +
      `worst ${Math.max(...perf.map(p => p.worstMs))} ms of 16.7; traffic ${Math.max(...perf.map(p => p.traffic))} records at most; ` +
      `heap ${Math.max(...perf.map(p => p.heapMB))} MB, rss ${Math.max(...perf.map(p => p.rssMB))} MB (whole server)`);
  } else console.log('server: no race perf lines (did the race start?)');
  /* Each test process's last line: cars going, kB/s and messages/s per client, corrections. */
  const lastOf = new Map();
  for (const { k, l } of loadLines) if (l.startsWith('[load]')) lastOf.set(k, l);
  if (lastOf.size) console.log('wire, each test process: ' + [...lastOf.values()].map(l => l.replace(/^\[load\] \d+ s: /, '')).join(' | '));
  for (const p of pages) {
    const ft = [].concat(...p.samples.map(s => s.ft)).filter(v => v > 0 && v < 1000);
    const driving = [].concat(...p.samples.filter(s => !s.out).map(s => s.ft)).filter(v => v > 0 && v < 1000);
    const last = p.samples[p.samples.length - 1] || {};
    const js = [].concat(...p.samples.map(s => s.js || [])).filter(v => v >= 0.05 && v < 1000);   // the page's frames, not the recorder's own empty callback
    const drv = [].concat(...p.samples.map(s => s.drv || [])).filter(v => v >= 0 && v < 1000);
    console.log(`page ${p.name}: ${p.samples.length} s racing (${p.drove} s driving), median ${r1(1000 / q(ft, 0.5))} fps, p95 frame ${r1(q(ft, 0.95))} ms, ` +
      `worst ${r1(q(ft, 1))} ms; page JS a frame p50 ${r1(q(js, 0.5))} ms p95 ${r1(q(js, 0.95))} ms (of which the test driver p50 ${r1(q(drv, 0.5))} p95 ${r1(q(drv, 0.95))}); driving median ${r1(1000 / q(driving, 0.5))} fps; ${last.lanes} lanes, ${last.cars} traffic known, ${last.ghosts} ghosts, ` +
      `${last.calls} draw calls, ${last.tri} triangles, dpr ${last.dpr}, corrections ${last.corr}, rtt ${last.rtt} ms`);
  }
  if (overLine) console.log(overLine);
  await browser.close();
  for (const l of loads) try { l.kill(); } catch (_) {}
  kill();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error(e); process.exit(1); });
