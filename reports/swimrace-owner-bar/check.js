'use strict';
/* Headless check of the Swim Race owner bar. Boots scripts/dev-local.js (throwaway owner key), opens a stand-in
   lobby at /__lobby (same origin, served by page.route) whose #game-frame loads /swimrace exactly like play.js
   show(), with window.duelWallet and the duel:signaction bridge copied from play.js. The signer is Node, with the
   dev server's throwaway owner key (or a random key for the non-owner case).
     node reports/swimrace-owner-bar/check.js <outdir> <tag> [scenario,...]   (Playwright's Chromium; about 40 s a scenario)
   scenarios: portrait-wallet, landscape-wallet, desktop-cookie, desktop-wallet, portrait-cookie, landscape-cookie,
              portrait-nonowner, portrait-signedout, portrait-late (the lobby's wallet signs in 3 s after the page opens) */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const { chromium } = require('playwright');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = _bs58.default || _bs58;

const OUT = process.argv[2];
const TAG = process.argv[3] || 'run';
const WANT = (process.argv[4] || 'portrait-wallet,landscape-wallet,desktop-cookie,portrait-nonowner').split(',');
const PORT = String(4400 + Math.floor(Math.random() * 90) + 10);
const BASE = 'http://127.0.0.1:' + PORT;
fs.mkdirSync(OUT, { recursive: true });

const actionMessage = (action, args, wallet, ts) => 'DuelSeries owner action\n' + 'action: ' + action + '\n'
  + 'args: ' + JSON.stringify(args || {}) + '\n' + 'wallet: ' + wallet + '\n' + 'at: ' + ts;
const signer = (secret) => {
  const wallet = bs58.encode(ed25519.getPublicKey(secret));
  return { wallet, sign: (action, args) => {
    const ts = Date.now();
    const sig = ed25519.sign(new TextEncoder().encode(actionMessage(action, args || {}, wallet, ts)), secret);
    return { action, args: args || {}, wallet, ts, sig: bs58.encode(sig) };
  } };
};

const LOBBY = (wallet, late) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<style>html,body{margin:0;height:100%;background:#000}</style></head><body>
<iframe id="game-frame" title="DuelSeries game" allow="autoplay; fullscreen"
  style="display:none;position:fixed;inset:0;width:100%;height:100%;border:0;z-index:300;background:#000"></iframe>
<script>
window.duelWallet = ${wallet && !late ? `{ ready: true, authenticated: true, address: ${JSON.stringify(wallet)} }` : '{ ready: true, authenticated: false, address: null }'};
${late ? `setTimeout(() => { window.duelWallet = { ready: true, authenticated: true, address: ${JSON.stringify(wallet)} }; }, 3000);` : ''}
window.duelWalletSignAction = (action, args) => window.__nodeSign(action, args || {});
/* play.js's bridge, as it is */
const SIGNABLE = new Set(['play:identify', 'br:start', 'se:open', 'se:start', 'se:stop']);
window.addEventListener('message', async e => {
  const d = e.data;
  if (!d || d.type !== 'duel:signaction') return;
  const frame = document.getElementById('game-frame');
  const origin = window.location && window.location.origin;
  if (!frame || !frame.contentWindow || e.source !== frame.contentWindow) return;
  if (!origin || e.origin !== origin) return;
  const reply = (msg) => { if (frame.contentWindow) frame.contentWindow.postMessage(msg, origin); };
  if (!SIGNABLE.has(d.action)) { reply({ type: 'duel:signaction:error', id: d.id, message: 'no' }); return; }
  try { const proof = await window.duelWalletSignAction(d.action, d.args || {}); reply({ type: 'duel:signaction:done', id: d.id, proof: proof || null }); }
  catch (err) { reply({ type: 'duel:signaction:error', id: d.id, message: 'Could not sign: ' + (err && err.message) }); }
});
try { sessionStorage.setItem('playerName', 'Owen'); sessionStorage.setItem('seJoin', '1'); } catch (_) {}
const f = document.getElementById('game-frame'); f.src = '/swimrace'; f.style.display = 'block';
</script></body></html>`;

const VIEW = {
  portrait: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' },
  landscape: { viewport: { width: 812, height: 375 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' },
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
};

const IDS = ['ownerBar', 'ownOpen', 'ownStart', 'ownStop', 'lobbyBar', 'board', 'gas', 'brake', 'dash', 'feed', 'count', 'botNote', 'keys', 'close', 'warn'];
async function rects(fr) {
  return fr.evaluate((ids) => {
    const o = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      const shown = cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 && !el.closest('[hidden]');
      o[id] = shown ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
    }
    return o;
  }, IDS);
}
function overlaps(R) {
  const a = R.ownerBar; if (!a) return [];
  const hit = [];
  for (const k of ['lobbyBar', 'board', 'gas', 'brake', 'dash', 'feed', 'keys', 'warn', 'close']) {
    const b = R[k]; if (!b) continue;
    const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ix > 0 && iy > 0) hit.push(k + ' (' + ix + 'x' + iy + ')');
  }
  return hit;
}

async function cookieLogin(page, s) {
  return page.evaluate(async () => {
    const r = await fetch('/api/owner/session/challenge', { credentials: 'same-origin', headers: { 'X-DS-Owner': '1' } });
    return r.json();
  }).then(async (ch) => {
    const proof = s.sign('owner:session:create', { nonce: ch.nonce, host: ch.host, label: 'headless check' });
    return page.evaluate(async (p) => {
      const r = await fetch('/api/owner/session/login', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'X-DS-Owner': '1' }, body: JSON.stringify(p) });
      return { status: r.status, body: await r.json() };
    }, proof);
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obar-'));
  const env = Object.assign({}, process.env, { DEV_LOCAL_PORT: PORT, SWIM_EVENT_PER_IP: '99',
    SWIM_EVENT_PATH: path.join(tmp, 'swim-event.json'), OWNER_SESSIONS_PATH: path.join(tmp, 'owner-sessions.json') });
  const server = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-local.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false, secret = null, buf = '';
  const onLine = (l) => {
    if (l.includes('Server running at')) up = true;
    const m = l.match(/throwaway owner secret \(bs58, local only\) (\S+)/); if (m) secret = bs58.decode(m[1]);
    if (/\[SE\]/.test(l)) console.log('  server: ' + l.trim());
  };
  const feed = (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } };
  server.stdout.on('data', feed); server.stderr.on('data', feed);
  const kill = () => { try { server.kill(); } catch (_) {} };
  process.on('exit', kill);
  for (let i = 0; i < 300 && !up; i++) await new Promise(r => setTimeout(r, 200));
  if (!up || !secret) { console.log('server did not start'); process.exit(1); }
  const owner = signer(secret), stranger = signer(ed25519.utils.randomPrivateKey());

  const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const report = {};
  for (const sc of WANT) {
    const [view, auth] = sc.split('-');
    /* The last scenario's race over and the lobby open again. */
    for (let i = 0; i < 120; i++) {
      const j = await fetch(BASE + '/api/live').then(r => r.json()).catch(() => null);
      if (j && j.swimEvent && j.swimEvent.joinOpen && j.swimEvent.state === 'waiting') break;
      await new Promise(r => setTimeout(r, 500));
    }
    const ctx = await browser.newContext(VIEW[view]);
    const page = await ctx.newPage();
    const s = auth === 'nonowner' ? stranger : owner;
    await page.exposeFunction('__nodeSign', (a, g) => s.sign(a, g));
    const wallet = auth === 'signedout' || auth === 'cookie' ? null : s.wallet;
    await page.route('**/__lobby', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: LOBBY(wallet, auth === 'late') }));
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    if (auth === 'cookie') {
      await page.goto(BASE + '/api/live');
      const r = await cookieLogin(page, owner);
      console.log('  cookie login', r.status, r.body && (r.body.device || r.body.error));
    }
    await page.goto(BASE + '/__lobby');
    let fr = null;
    for (let i = 0; i < 100 && !fr; i++) { fr = page.frames().find(f => /\/swimrace/.test(f.url())); if (!fr) await page.waitForTimeout(100); }
    await fr.waitForSelector('#lobbyBar:not([hidden])', { timeout: 20000 });
    const barShown = await fr.waitForSelector('#ownerBar:not([hidden])', { timeout: auth === 'late' ? 12000 : 6000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(1200);
    const r0 = await rects(fr);
    const row = { barShown, lobby: { rects: r0, overlaps: overlaps(r0) }, errs };
    await page.screenshot({ path: path.join(OUT, `${TAG}-${sc}-1-lobby.png`) });
    if (barShown && auth !== 'nonowner') {
      /* Start now, as a finger (touch contexts) or a mouse. */
      const btn = fr.locator('#ownStart');
      if (VIEW[view].hasTouch) await btn.tap(); else await btn.click();
      const note = await fr.waitForFunction(() => { const n = document.getElementById('botNote'); return n && !n.hidden && n.textContent; }, null, { timeout: 8000 })
        .then(h => h.jsonValue()).catch(() => null);
      row.startNote = note;
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `${TAG}-${sc}-2-started.png`) });
      /* The race itself: 15 s to the countdown, 10 s of countdown, then racing. */
      const racing = await fr.waitForFunction(() => window.__swimrace && window.__swimrace.state === 'racing', null, { timeout: 45000, polling: 500 })
        .then(() => true).catch(() => false);
      row.racing = racing;
      await page.waitForTimeout(1500);
      const r1 = await rects(fr);
      row.race = { rects: r1, overlaps: overlaps(r1) };
      await page.screenshot({ path: path.join(OUT, `${TAG}-${sc}-3-race.png`) });
      const stop = fr.locator('#ownStop');
      if (await stop.isVisible()) {
        if (VIEW[view].hasTouch) await stop.tap(); else await stop.click();
        row.stopNote = await fr.waitForFunction(() => { const n = document.getElementById('botNote'); return n && !n.hidden && /stopped|No Swim/.test(n.textContent) && n.textContent; }, null, { timeout: 8000 })
          .then(h => h.jsonValue()).catch(() => null);
      }
      await page.waitForTimeout(3000);
    }
    report[sc] = row;
    console.log(sc, JSON.stringify({ barShown: row.barShown, start: row.startNote, racing: row.racing, stop: row.stopNote,
      lobbyOverlaps: row.lobby.overlaps, raceOverlaps: row.race && row.race.overlaps, ownerBar: r0.ownerBar, raceBar: row.race && row.race.rects.ownerBar, errs: errs.slice(0, 3) }));
    await ctx.close();
  }
  fs.writeFileSync(path.join(OUT, TAG + '-report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  kill();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
