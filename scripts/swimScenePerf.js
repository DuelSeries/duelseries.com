'use strict';
/* ─── Swim: what the 3D road costs a frame ───────────────────────────────────
   Serves public/ (and shared/ at /shared) from a tiny static server on a free
   port, opens public/dev-swim-scene.html in headless Chrome with the GPU on,
   and reads window.__swimPerf: a fake car weaving through dense traffic at 120
   to 250 km/h with a near miss every 2.5 s.

   TRUE FRAME COST. A normal rAF runs at the display rate and only proves "fast
   enough". This launches with the frame-rate limit and vsync off, and the page
   reads one pixel back after every frame (sync=1) so each interval includes
   the GPU finishing the frame, not just the JS handing it over.

   Configs: desktop 1280x800 (and at 150% Windows scaling, so the 1.5 cap); a phone 390x844 at dpr 3 (the scene caps its
   pixel ratio at 1.5); the same phone with the CPU throttled 4x through CDP,
   roughly a mid phone's main thread. Adaptive resolution is off so the numbers
   are the scene at its cap.

   Usage: node scripts/swimScenePerf.js [--secs 8] [--t 600] [--shots <dir>]
   (--shots writes two small PNGs instead: desktop mid near miss, phone mid crash)
   Needs Playwright (playwright or playwright-core) and Google Chrome; set
   PLAYWRIGHT_CORE to a playwright-core folder if it is not installed here. */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const SHARED = path.join(ROOT, 'shared');

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_CORE, 'playwright', 'playwright-core',
    path.join(ROOT, '..', 'video-studio', 'node_modules', 'playwright-core')].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (_) { /* next */ } }
  throw new Error('Playwright not found: npm i -D playwright-core, or set PLAYWRIGHT_CORE');
}

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SECS = +arg('secs', 8), T = +arg('t', 600), SHOTS = arg('shots', null);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
function serve() {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const base = u.startsWith('/shared/') ? SHARED : PUB;
    const rel = u.startsWith('/shared/') ? u.slice('/shared/'.length) : u.slice(1);
    const f = path.normalize(path.join(base, rel || 'index.html'));
    if (!f.startsWith(base) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const FLAGS = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-frame-rate-limit', '--disable-gpu-vsync']
  .concat(process.platform === 'win32' ? ['--use-angle=d3d11'] : []);
const CONFIGS = [
  { name: 'desktop 1280x800', ctx: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
  { name: 'laptop 150% scale', ctx: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 } },
  { name: 'phone 390x844 dpr3', ctx: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
  { name: 'phone + 4x CPU', ctx: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, cpu: 4 },
];

async function run(chromium, port, cfg, qs, shot) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: FLAGS });
  try {
    const ctx = await browser.newContext(cfg.ctx);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    if (cfg.cpu) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: cfg.cpu }); }
    await page.goto(`http://127.0.0.1:${port}/dev-swim-scene.html?${qs}`);
    let res = null;
    if (shot) {
      await page.waitForFunction(`window.__dev && window.__dev.raceT > ${shot.at}`, null, { timeout: 60000 });
      const url = await page.evaluate(([w, l]) => window.__snap(w, l), [shot.width, shot.levels || 0]);
      fs.mkdirSync(path.dirname(shot.file), { recursive: true });
      fs.writeFileSync(shot.file, Buffer.from(url.split(',')[1], 'base64'));
      res = { file: shot.file, bytes: fs.statSync(shot.file).size };
    } else {
      await page.waitForFunction('window.__swimPerf && window.__swimPerf.done', null, { timeout: (SECS + 60) * 1000 });
      res = await page.evaluate('window.__swimPerf');
    }
    if (errs.length) res.errors = errs.slice(0, 5);
    return res;
  } finally { await browser.close(); }
}

(async () => {
  const { chromium } = loadPlaywright();
  const srv = await serve();
  const port = srv.address().port;
  try {
    if (SHOTS) {
      // small dithered PNGs (16 shades a channel) so each stays well under 150 KB
      const a = await run(chromium, port, CONFIGS[0], `t=${T}&fixed=1&hud=0&adaptive=0&seed=3&demo=1`, { at: T + 5.1, width: 480, levels: 16, file: path.join(SHOTS, 'swim-scene-desktop.png') });
      console.log('shot', JSON.stringify(a));
      const b = await run(chromium, port, CONFIGS[2], `t=${T}&fixed=1&hud=0&adaptive=0&seed=5&crashAt=4`, { at: T + 4.35, width: 260, levels: 16, file: path.join(SHOTS, 'swim-scene-phone-crash.png') });
      console.log('shot', JSON.stringify(b));
      return;
    }
    const qs = `secs=${SECS}&sync=1&t=${T}&demo=1&hud=0&adaptive=0`;
    console.log(`Swim scene perf: ${SECS}s per config, race time ${T}s (dense traffic), uncapped + readPixels sync`);
    for (const cfg of CONFIGS) {
      const r = await run(chromium, port, cfg, qs);
      if (/swiftshader|llvmpipe|software/i.test(r.gpu || '')) console.log('  WARNING: software GL, numbers are not the GPU');
      console.log(`${cfg.name.padEnd(20)} fps ${String(r.fps).padStart(6)}  frame p50 ${r.frameMs.p50} ms  p95 ${r.frameMs.p95} ms  max ${r.frameMs.max} ms  js p50 ${r.jsMs.p50} ms  calls ${r.calls}  tris ${r.triangles}  dpr ${r.dpr}  canvas ${r.canvas}  traffic ${r.traffic}${r.errors ? '  ERRORS ' + r.errors.join(' | ') : ''}`);
      console.log(`${''.padEnd(20)} gpu ${r.gpu}`);
    }
  } finally { srv.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
