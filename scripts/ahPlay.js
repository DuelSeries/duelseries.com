'use strict';
/* Air Hockey, played headless: a scripted hand on one or two pages against a running server, for feel and
   netcode checks (docs/airhockey-design.md). It reads the page's own window.__ah() to find the puck, steers the
   real mouse (or a real touch) at it, and reports how often the screen had to correct itself.
     node scripts/ahPlay.js --url http://localhost:3071 [--two] [--delay 50] [--secs 40] [--look house]
       [--shots dir] [--phone] [--frames dir]
   --delay adds that many ms each way through a local proxy (so --delay 50 is about 100 ms of extra ping).
   --two seats two pages against each other (no bot wait); otherwise one page waits for the free table's bot. */
const net = require('net');
const path = require('path');
const fs = require('fs');

function loadPlaywright() {
  const ROOT = path.join(__dirname, '..');
  const tries = [process.env.PLAYWRIGHT_CORE, 'playwright', 'playwright-core',
    path.join(ROOT, '..', 'video-studio', 'node_modules', 'playwright-core')].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (_) { /* next */ } }
  throw new Error('Playwright not found');
}
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes('--' + k);
const URL0 = arg('url', 'http://localhost:3071'), DELAY = +arg('delay', 0), SECS = +arg('secs', 40);
const LOOK = arg('look', ''), SHOTS = arg('shots', ''), FRAMES = arg('frames', ''), PHONE = flag('phone'), TWO = flag('two');

// A TCP proxy that holds every chunk DELAY ms in each direction, in order.
function proxy(target, delay) {
  const u = new URL(target);
  return new Promise((res) => {
    const srv = net.createServer((c) => {
      const s = net.connect(+u.port, u.hostname);
      const pipe = (a, b) => a.on('data', (d) => setTimeout(() => { if (!b.destroyed) b.write(d); }, delay));
      pipe(c, s); pipe(s, c);
      const end = () => { c.destroy(); s.destroy(); };
      c.on('error', end); s.on('error', end); c.on('close', end); s.on('close', end);
    });
    srv.listen(0, '127.0.0.1', () => res({ srv, url: 'http://127.0.0.1:' + srv.address().port }));
  });
}

async function player(browser, url, name, opts) {
  const ctx = await browser.newContext(PHONE
    ? { viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript((n) => { try { sessionStorage.setItem('playerName', n); } catch (_) {} }, name);
  await page.goto(url + '/airhockey' + (LOOK ? '?look=' + LOOK : ''));
  return { page, ctx, errors, name, opts, stats: { corr: [], corrMe: [], n: 0, frames: 0 } };
}

/* The hand: aim behind the puck on the line to the other goal and drive through it; wait near your goal when
   the puck is on their half. Deliberately a bit sloppy (aim noise) so rallies happen. */
async function steer(p) {
  const s = await p.page.evaluate(() => (window.__ah ? window.__ah() : null));
  if (!s || s.mySeat < 0 || !s.me) return s;
  const W = 600, H = 1000, mine = s.mySeat;
  const goalY = mine === 0 ? 0 : H, homeY = mine === 0 ? H - 120 : 120;
  const pk = s.puck;
  const onMine = mine === 0 ? pk.y > H / 2 : pk.y < H / 2;
  let tx = W / 2 + (pk.x - W / 2) * 0.4, ty = homeY;
  if (onMine && pk.live) {
    const ux = W / 2 + (Math.random() - 0.5) * 200 - pk.x, uy = goalY - pk.y, ul = Math.hypot(ux, uy);
    const bx = pk.x - ux / ul * 75, by = pk.y - uy / ul * 75;
    const d = Math.hypot(s.me.x - bx, s.me.y - by);
    if (d < 40) { tx = pk.x + ux / ul * 80; ty = pk.y + uy / ul * 80; } else { tx = bx; ty = by; }
  }
  const [px, py] = await p.page.evaluate(([x, y]) => window.__ahToScreen(x, y), [tx, ty]);
  if (PHONE) {
    // A finger: touch below the mallet once, then drag; the mallet keeps its place above the finger.
    if (!p.touching) {
      const cdp = p.cdp || (p.cdp = await p.ctx.newCDPSession(p.page));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: s.me.sx, y: s.me.sy + 90 }] });
      p.touching = true; p.fdy = 90;
    }
    await p.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: px, y: py + 90 }] });
  } else {
    await p.page.mouse.move(px, py, { steps: 2 });
  }
  p.stats.n++;
  p.stats.corr.push(s.corr[2]);
  p.stats.corrMe.push(s.corr[mine]);
  return s;
}

(async () => {
  const { chromium } = loadPlaywright();
  let url = URL0, px = null;
  if (DELAY > 0) { px = await proxy(URL0, DELAY); url = px.url; }
  const browser = await chromium.launch({ headless: true, channel: process.env.AH_CHANNEL || 'chrome', args: ['--disable-frame-rate-limit'] });
  const ps = [await player(browser, url, 'Hand A')];
  if (TWO) ps.push(await player(browser, url, 'Hand B'));
  const t0 = Date.now();
  let shotN = 0, last = null;
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  if (FRAMES) fs.mkdirSync(FRAMES, { recursive: true });
  while (Date.now() - t0 < SECS * 1000) {
    for (const p of ps) last = await steer(p) || last;
    const el = (Date.now() - t0) / 1000;
    if (SHOTS && last && last.phase === 'playing' && shotN < 3 && el > 8 + shotN * 6) {
      await ps[0].page.screenshot({ path: path.join(SHOTS, (LOOK || 'default') + (PHONE ? '-phone' : '') + '-' + shotN + '.png') });
      shotN++;
    }
    if (FRAMES && last && last.phase === 'playing' && ps[0].stats.frames < 40 && el > 10) {
      await ps[0].page.screenshot({ path: path.join(FRAMES, 'f' + String(ps[0].stats.frames++).padStart(3, '0') + '.png'), scale: 'css' });
    }
    if (last && last.over) break;
  }
  for (const p of ps) {
    const s = await p.page.evaluate(() => window.__ah());
    const c = p.stats.corr.filter((v) => v > 0), cm = p.stats.corrMe.filter((v) => v > 0);
    const pct = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * q)] : 0);
    console.log(p.name, 'phase', s.phase, 'score', s.score.join('-'), 'rtt', s.rtt, 'samples', p.stats.n,
      'puck corr >0:', c.length, 'p50', pct(c, 0.5), 'p90', pct(c, 0.9), '| my mallet corr >0:', cm.length, 'p90', pct(cm, 0.9),
      '| errors', p.errors.length ? p.errors.slice(0, 3) : 0);
  }
  await browser.close();
  if (px) px.srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
