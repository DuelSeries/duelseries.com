/* Three lobby changes (Owen 2026-11-05): the game sheet loses its "1 v 1" / "Big room" chip, Customize becomes
   "Shop" with a Coming soon tag, shut everywhere behind one switch (CUSTOMIZE_ON), and Paper.io's little preview is
   the player lapping a circle in an endless loop. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/v2.html'), 'utf8').replace(/\r\n/g, '\n');   // CRLF on a Windows checkout
const ART = fs.readFileSync(path.join(ROOT, 'public/js/v2/shopArt.js'), 'utf8');
const fnBody = (src, head) => {
  const i = src.indexOf(head);
  assert.ok(i > -1, 'found ' + head);
  return src.slice(i, src.indexOf('\n}', i) + 2);
};

test('the game sheet has no 1 v 1 or Big room chip, for any game', () => {
  assert.ok(!html.includes('dkind'), 'no chip in the markup, the CSS or the script');
  assert.ok(!/'1 v 1':'Big room'/.test(html), 'and nothing writes one');
  // The count chip stays; with nobody playing the row folds away, so the name is not under an empty band.
  assert.ok(html.includes('<div class="dtags"><span class="gpc dpc" id="dpc"'), 'the player count is still there');
  assert.ok(html.includes('.dtags:not(:has(>:not([hidden]))){display:none}'), 'an empty tag row takes no room');
  assert.match(html, /#dname\{[^}]*padding-right:52px\}/, 'and the name keeps clear of the X on a PC');
  assert.match(html, /\.dtags,#dname\{padding-right:0\}/, 'which sits over the picture on a phone');
  // The lobby's own filter (All, Big rooms, 1 v 1, Coming soon) is a different thing and stays.
  assert.ok(html.includes("['duels','1 v 1','1 v 1']"), 'the Games filter still sorts by kind');
});

/* Owen 2026-11-08: "why is the shop crossed out? ... Make it so I can change my skin there." The one switch is back on,
   and every place that offered Customize now says Shop and opens the chooser (free looks, then the paid skins to buy
   and wear). The off branch stays behind the switch. */
test('one switch turns the Shop on, and it is on', () => {
  const defs = html.match(/const CUSTOMIZE_ON=(true|false);/g) || [];
  assert.deepStrictEqual(defs, ['const CUSTOMIZE_ON=true;'], 'declared once, on');
  // Behind the switch: nothing would open the chooser or the game picker were it off.
  assert.match(fnBody(html, 'function openLook(){'), /^function openLook\(\)\{\n  if\(!CUSTOMIZE_ON\)return;/);
  assert.match(fnBody(html, 'function setLooks(){'), /^function setLooks\(\)\{\n  if\(!CUSTOMIZE_ON\)return;/);
});

test('the bar under Play says Shop and opens; off, it would say Shop, Coming soon, struck through and shut', () => {
  assert.ok(html.includes('<span class="lkt"><b>Shop</b></span>'), 'the bar is the Shop');
  assert.ok(html.includes('<span class="lksoon ds-chip ds-chip-soon" hidden>Coming soon</span>'), 'the tag, hidden until needed');
  const boot = html.slice(html.indexOf('if(!CUSTOMIZE_ON){\n  const row=document.getElementById(\'lookrow\');'), html.indexOf('function openLook(){'));
  assert.ok(boot.length > 0, 'the boot step is there');
  for (const bit of ["row.classList.add('shopsoon')", 'row.disabled=true', "b.textContent='Shop'", 'tag.hidden=false', "'Shop, coming soon'"])
    assert.ok(boot.includes(bit), 'boot: ' + bit);
  // Every game's open keeps it shut (drawSkins runs on every open).
  assert.ok(html.includes('row.disabled=!look||!CUSTOMIZE_ON;'), 'and no game opens it again');
  for (const rule of ['#detail .lookrow.shopsoon,#detail .lookrow.shopsoon:hover{cursor:not-allowed;background:rgba(23,20,15,.6)}',
                      '#detail .lookrow.shopsoon .lkt b{color:var(--tx3);text-decoration:line-through}',
                      '#detail .lookrow.shopsoon .lka{display:none}',
                      '#detail .lookrow.shopsoon canvas{opacity:.7}',
                      '.lookrow .lksoon[hidden]{display:none}'])
    assert.ok(html.includes(rule), 'css: ' + rule);
});

test('the sidebar and Settings say Shop and open it; the shut Coming soon rows stay behind the switch', () => {
  const nav = fnBody(html, 'function drawNav(){');
  assert.ok(nav.includes('(CUSTOMIZE_ON?`<button class="sb-it sbx" type="button" onclick="setLooks()">${SBI(SB_P.shop)}<span>Shop</span></button>`'),
    'the Shop row, with the switch on');
  assert.ok(nav.includes('`<button class="sb-it sbx sb-soon sb-off" type="button" disabled aria-label="Shop, coming soon">${SBI(SB_P.shop)}<span>Shop</span><span class="sb-pill">Coming soon</span></button>`'),
    'a shut Shop row with its tag, when off');
  assert.match(html, /\.sb-off,\.sb-off:hover\{cursor:not-allowed;color:var\(--tx3\);background:none\}/, 'no hover');
  assert.match(html, /\.sb-off>span:not\(\.sb-pill\)\{text-decoration:line-through\}/, 'struck through');

  const acct = fnBody(html, 'function drawAcct(){');
  assert.ok(acct.includes('const look=CUSTOMIZE_ON?`<button type="button" class="ds-row set-link" onclick="setLooks()"><span class="ds-row-ic">${SET_IC.shop}</span><span class="ds-row-main"><b>Shop</b></span>'), 'the Settings row, Shop, when on');
  const off = acct.slice(acct.indexOf(':`<div class="ds-row set-soon"'));
  assert.ok(off.startsWith(':`<div class="ds-row set-soon" aria-disabled="true">'), 'a plain row when off, nothing to press');
  assert.ok(!/onclick|<button/.test(off.slice(0, off.indexOf('</div>`;'))), 'with no handler in it');
  assert.ok(off.includes('<b>Shop</b>') && off.includes('<span class="ds-chip ds-chip-soon">Coming soon</span>'), 'Shop, Coming soon');
  assert.match(html, /\.set-soon \.ds-row-main b\{color:var\(--ds-tx3\);text-decoration:line-through\}/, 'struck through');
});

/* ── Paper.io's preview ───────────────────────────────────────────────────── */
function page() {
  const box = { console, Math, JSON };
  box.window = box; box.globalThis = box;
  vm.createContext(box);
  for (const f of ['shared/shopPrices.js', 'shared/shopSkins.js', 'public/js/shooterArt.js', 'public/js/battleshipArt.js', 'public/js/v2/shopArt.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), box, { filename: f });
  return box;
}
// A canvas that writes down every call and every style set.
function recCanvas(w, h) {
  const log = [];
  const ctx = new Proxy({}, {
    get(t, k) { return (...a) => { log.push([k, ...a]); return { addColorStop() {} }; }; },
    set(t, k, v) { log.push(['=' + String(k), v]); return true; },
  });
  return { cv: { width: w, height: h, getContext: () => ctx }, log };
}
// Two drawings are the same: the same calls in the same order, every number within float noise of the other.
function sameDrawing(a, b, what) {
  assert.strictEqual(a.length, b.length, what + ': as many calls');
  a.forEach((c, i) => {
    assert.strictEqual(c.length, b[i].length, what + ': call ' + i);
    c.forEach((v, j) => {
      if (typeof v === 'number') assert.ok(Math.abs(v - b[i][j]) < 1e-6, what + ': call ' + i + ' ' + c[0] + ' ' + v + ' vs ' + b[i][j]);
      else assert.strictEqual(v, b[i][j], what + ': call ' + i);
    });
  });
}
const LOOP = Number((ART.match(/var PP_LOOP = ([\d.]+);/) || [])[1]);

test('Paper.io: the head laps a circle at a steady speed', () => {
  const S = page().V2Shop;
  assert.ok(LOOP > 0, 'one lap a loop');
  const heads = [];
  for (let i = 0; i < 48; i++) {
    const { cv, log } = recCanvas(300, 112);
    S.paint(cv, 'paper', 'default', 5 + LOOP * i / 48, false, true);
    const tr = log.filter(c => c[0] === 'translate');
    assert.strictEqual(tr.length, 3, 'the head is three squares');
    heads.push(tr[0].slice(1));
  }
  const cx = heads.reduce((s, p) => s + p[0], 0) / heads.length, cy = heads.reduce((s, p) => s + p[1], 0) / heads.length;
  const rad = heads.map(p => Math.hypot(p[0] - cx, p[1] - cy));
  assert.ok(rad[0] > 10, 'it goes round, not nowhere');
  for (const d of rad) assert.ok(Math.abs(d - rad[0]) < 1e-3 * rad[0], 'every frame on one circle');
  const step = heads.map((p, i) => Math.hypot(p[0] - heads[(i + 1) % heads.length][0], p[1] - heads[(i + 1) % heads.length][1]));
  for (const d of step) assert.ok(Math.abs(d - step[0]) < 1e-3 * step[0], 'the same distance every frame, the last into the first too');
  // the whole piece stays inside its strip
  for (const p of heads) assert.ok(p[1] - 16 > 0 && p[1] + 16 < 112 && p[0] > 0 && p[0] < 300, 'inside the box');
});

test('Paper.io: the last frame of a loop is the first, for every skin', () => {
  const S = page().V2Shop;
  for (const k of S.game('paper').skins) {
    for (const t of [0, 0.4, 1.7, 2.9]) {
      const a = recCanvas(300, 112), b = recCanvas(300, 112);
      S.paint(a.cv, 'paper', k.id, t, false, true);
      S.paint(b.cv, 'paper', k.id, t + LOOP * 3, false, true);
      sameDrawing(b.log, a.log, k.id + ' at ' + t + 's and three loops on');
    }
  }
  // The free look walks through its colours, so only the motion repeats; the colour glides, never jumps.
  const at = t => { const r = recCanvas(300, 112); S.paint(r.cv, 'paper', 'default', t, false, true); return r.log; };
  const moves = l => l.filter(c => c[0] === 'translate' || c[0] === 'arc');
  sameDrawing(moves(at(1.1 + LOOP)), moves(at(1.1)), 'the free look moves the same every loop');
  const fills = l => l.filter(c => c[0] === '=fillStyle').map(c => c[1]);
  const end = fills(at(LOOP - 1e-6)), start = fills(at(LOOP));
  const hex = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
  const gap = Math.max(...end.map((c, i) => Math.max(...hex(c).map((v, j) => Math.abs(v - hex(start[i])[j])))));
  assert.ok(gap <= 2, 'one loop glides into the next colour (largest step ' + gap + ')');
});

test('Paper.io: the head turns to face the way it goes, and the trail follows it round', () => {
  const S = page().V2Shop;
  const { cv, log } = recCanvas(300, 112);
  S.paint(cv, 'paper', 'mint', 0.8, false, true);
  const p = (0.8 / LOOP) % 1, A = p * 6.2832;
  const rot = log.filter(c => c[0] === 'rotate').map(c => c[1]);
  assert.strictEqual(rot.length, 3, 'every square of the head is turned');
  for (const r of rot) assert.ok(Math.abs(r - (A + 1.5708)) < 1e-3, 'along the lap');
  const trail = log.filter(c => c[0] === 'arc' && c[4] !== 0);
  assert.strictEqual(trail.length, 1, 'one trail');
  assert.ok(Math.abs(trail[0][5] - A) < 1e-3, 'that ends at the head');
  assert.ok(trail[0][5] - trail[0][4] > 3.1, 'and runs more than half a lap behind it');
});
