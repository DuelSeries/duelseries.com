'use strict';
// Paper.io's game-screen backdrop (public/js/v2/paperBg.js): its colours are the game's own, it runs a game in
// progress from the first frame, players claim ground and lose it, and nothing drifts off or goes NaN over a long run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BG = require(path.join(ROOT, 'public/js/v2/paperBg.js'));

/* A seeded rng, so a failure reproduces. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

test('colours are the game\'s playerColorPalette through its own deriveColorSet', () => {
  global.window = globalThis;
  require(path.join(ROOT, 'public/js/paper/paperGeom.js'));
  require(path.join(ROOT, 'public/js/paper/paperSkins.js'));
  const P = globalThis.DuelPaperLib;
  const pool = new P.ColorSkinPool(null);
  assert.deepStrictEqual(BG.COLORS, pool.assets.map(a => [a.content.colors.main, a.content.colors.back, a.content.colors.nick]));
  const cfg = P.defaultPaperConfig;
  assert.strictEqual(BG.consts.TRACK, cfg.trackWidth);
  assert.strictEqual(BG.consts.SPEED, cfg.unitSpeed);
  assert.strictEqual(BG.consts.BASE_R, cfg.baseRadius);
  assert.strictEqual(BG.consts.LIFT, cfg.baseHeight);
  assert.strictEqual(BG.consts.FLOOR, cfg.arenaColor);
});

test('a phone and a PC both start on a game in progress, and it stays alive for ten minutes', () => {
  for (const [w, h, S] of [[235, 462, 0.45], [723, 440, 0.75]]) {
    const wd = BG.make(w, h, S, rng(7));
    assert.ok(wd.paper && wd.units.length >= 4 && wd.units.length <= 12);
    /* Warmed up: not everybody is still on a fresh radius-30 start base. */
    assert.ok(wd.units.some(u => !u.dead && BG.maxR(u) > 45), 'some ground has been claimed before the first frame');
    let claims = 0, deaths = 0;
    const seenClaim = new Map(wd.units.map(u => [u, u.claimT]));
    const wasDead = new Map(wd.units.map(u => [u, !!u.dead]));
    for (let s = 0; s < 600 * 30; s++) {
      BG.step(wd, 1 / 30);
      for (const u of wd.units) {
        if (u.claimT !== seenClaim.get(u)) { claims++; seenClaim.set(u, u.claimT); }
        if (!!u.dead && !wasDead.get(u)) deaths++;
        wasDead.set(u, !!u.dead);
        if (u.dead) continue;
        assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y) && Number.isFinite(u.dir));
        assert.ok(Math.abs(u.x) < wd.halfW * 4 && Math.abs(u.y) < wd.halfH * 4, 'a player wandered off the arena');
        assert.ok(BG.maxR(u) <= wd.cap * 2, 'ground grew past what the view can show');
      }
    }
    assert.ok(claims > 40, 'players keep claiming ground (' + claims + ')');
    assert.ok(deaths > 0, 'players get cut off and come back');
  }
});

test('paint only draws: a frame is a fixed handful of fills and strokes, no allocation per pellet or per pixel', () => {
  const wd = BG.make(723, 440, 0.75, rng(3));
  const calls = {};
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      return (...a) => { calls[k] = (calls[k] || 0) + 1; };
    },
    set(t, k, v) { t[k] = v; return true; }
  });
  BG.paint(ctx, wd, 723, 440);
  const n = wd.units.length;
  assert.ok(calls.fill <= 2 * n, 'two ground fills per player');
  assert.ok((calls.fillRect || 0) <= 1 + 3 * n);
  assert.ok((calls.stroke || 0) <= n);
  assert.ok(!calls.getImageData && !calls.putImageData && !calls.drawImage);
});

test('the game screen gives Paper.io the live backdrop through the same frame loop as the other two', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/v2.html'), 'utf8');
  assert.ok(html.includes('<script src="/js/v2/paperBg.js"></script>'));
  assert.match(html, /cur\.id==='paper'&&window\.V2PaperBg\?'paper'/);
  assert.match(html, /if\(cv\.dataset\.game==='paper'&&window\.V2PaperBg\)return V2PaperBg\.make/);
  /* paintScene is what lobbyLoop calls for every canvas[data-anim] on screen, which already skips a hidden screen:
     the loop paints only what its IntersectionObserver reports showing (_lit), never a layout read per frame. */
  assert.match(html, /function paintScene\(cv,dt\)\{[\s\S]{0,400}V2PaperBg\.step\(pw,dt\/60\)/);
  assert.match(html, /\['canvas\[data-anim\]','anim'\]/);
  assert.match(html, /_cvs\.get\(cv\)==='anim'\?paintScene\(cv,dt\):paintLook\(cv\)/);
  // ...and a parked Play screen too (v2.html parkScreen): displayed, but not on screen.
  assert.match(html, /_lit\.forEach\(cv=>\{[\s\S]{0,120}if\(parkedHas\(cv\)\|\|\(!_litIO&&!cv\.offsetParent\)\)return/);
});
