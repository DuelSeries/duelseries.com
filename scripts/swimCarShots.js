'use strict';
/* ─── Swim: pictures of the ten cars ─────────────────────────────────────────
   Renders each car's own model (public/dev-swim-car.html, the race's loader and paint) headless and saves:
     public/img/swim-cars/<id>.webp     the Shop's picture: side on, nose right, clear background, 512 px wide
     --views <dir>                       also front, rear and three-quarter views of each, for checking a car against
                                         photos of the real one
   Usage: node scripts/swimCarShots.js [--only civic,m3] [--views <dir>] [--strip | --strip-only]
     --strip                            also the Shop's turntable strip, public/img/swim-cars/<id>-3d.webp
   Needs Playwright (playwright-core) and sharp; PLAYWRIGHT_CORE / SHARP point at an install when this repo has none.
   Runs Chrome with --mute-audio, one page at a time, and closes everything when done. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public'), SHARED = path.join(ROOT, 'shared');
const req = (name, env) => { for (const t of [process.env[env], name].filter(Boolean)) { try { return require(t); } catch (_) { /* next */ } } throw new Error(name + ' not found: set ' + env); };
const { chromium } = req('playwright-core', 'PLAYWRIGHT_CORE');
const sharp = req('sharp', 'SHARP');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const L = require(path.join(SHARED, 'swimLooks.js'));
const ONLY = arg('only', '') ? arg('only', '').split(',') : L.CARS.map((c) => c.id);
const VIEWS = arg('views', null);
const STRIP = process.argv.includes('--strip') || process.argv.includes('--strip-only'), STRIP_ONLY = process.argv.includes('--strip-only');
const FRAMES = 24, FW = 256, FH = 144;   // the Shop's turntable: 24 turns of 15 degrees, each 256 by 144
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.glb': 'model/gltf-binary' };

(async () => {
  const srv = http.createServer((q, res) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    const base = u.startsWith('/shared/') ? SHARED : PUB, rel = u.startsWith('/shared/') ? u.slice(8) : u.slice(1);
    const f = path.normalize(path.join(base, rel));
    if (!f.startsWith(base) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
  const shoot = async (id, view, w, h, bg) => {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    try {
      await page.goto(`http://127.0.0.1:${port}/dev-swim-car.html?car=${id}&view=${view}${bg ? '&bg=' + encodeURIComponent(bg) : ''}`);
      await page.waitForFunction('window.__car && window.__car.done', null, { timeout: 60000 });
      const st = await page.evaluate('window.__car');
      if (st.error) throw new Error(id + ': ' + st.error);
      return await page.screenshot({ omitBackground: !bg, type: 'png' });
    } finally { await page.close(); }
  };
  if (VIEWS) fs.mkdirSync(VIEWS, { recursive: true });
  try {
    for (const id of ONLY) {
      if (STRIP) {
        /* The Shop's 3D car (Owen 2026-11-08): the car turning a full circle on the spot, seen from a raised three-quarter,
           its tail lamps lit, one strip of FRAMES pictures (public/img/swim-cars/<id>-3d.webp). The Shop crossfades them. */
        const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
        try {
          await page.goto(`http://127.0.0.1:${port}/dev-swim-car.html?car=${id}&view=shop&brake=1`);
          await page.waitForFunction('window.__car && window.__car.done', null, { timeout: 60000 });
          const frames = [];
          for (let i = 0; i < FRAMES; i++) {
            await page.evaluate((y) => window.__car.turn(y), -i * 2 * Math.PI / FRAMES);
            const png = await page.screenshot({ omitBackground: true, type: 'png', clip: { x: 64, y: 18, width: 512, height: 288 } });
            frames.push({ input: await sharp(png).resize(FW, FH).png().toBuffer(), left: i * FW, top: 0 });
          }
          const out = path.join(PUB, 'img/swim-cars', id + '-3d.webp');
          await sharp({ create: { width: FW * FRAMES, height: FH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(frames)
            .webp({ quality: 80, alphaQuality: 85 }).toFile(out);
          console.log('shop 3d strip', path.relative(ROOT, out), fs.statSync(out).size + ' B');
        } finally { await page.close(); }
        if (STRIP_ONLY) continue;
      }
      const png = await shoot(id, 'side', 1400, 560, null);
      const out = path.join(PUB, 'img/swim-cars', id + '.webp');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await sharp(png).trim({ threshold: 1 }).resize(512, null, { withoutEnlargement: false }).webp({ quality: 82, alphaQuality: 90 }).toFile(out);
      console.log('shop picture', path.relative(ROOT, out), fs.statSync(out).size + ' B');
      if (VIEWS) for (const v of ['three', 'front', 'rear', 'side']) {
        const p = await shoot(id, v, 960, 600, '#9aa1ab');
        await sharp(p).jpeg({ quality: 82 }).toFile(path.join(VIEWS, `${id}-${v}.jpg`));
      }
    }
  } finally { await browser.close(); srv.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
