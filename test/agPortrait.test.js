'use strict';
// Phone portrait (Owen 2026-10-08, FIX-PLAN P4): the layout math and the "turn your phone sideways" card.
// The portrait layout is the reference screen turned on its side: the camera's draw scale and the HUD scale use their
// formulas with the two sides swapped, so a W x H portrait canvas gets exactly what an H x W landscape canvas gets,
// turned. Owen's numbers: about 1080 world units across and 1920 down at wheel 1 (the turned reference screen; a
// phone taller than 9:16 shows all 1920 down and a little less across, as a landscape window wider than 16:9 shows
// all 1920 across). The card shows once per tab session for PROMPT_MS.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const AG = path.join(__dirname, '..', 'public', 'js', 'ag');
const C = require(path.join(AG, 'agCamera.js'));
const H = require(path.join(AG, 'agHud.js'));
const R = require(path.join(AG, 'agRender.js'));
const P = require(path.join(AG, 'agPortrait.js'));
const { LAWS } = require('../server/ag/agLaws');

const PHONE = { w: 390, h: 844, dpr: 3 };            // the size the plan and the live check use
const PW = PHONE.w * PHONE.dpr, PH = PHONE.h * PHONE.dpr;   // 1170 x 2532 canvas px

test('isPortrait: a touch screen taller than wide; a mouse screen of any shape never', () => {
  assert.strictEqual(P.isPortrait(390, 844, true), true);
  assert.strictEqual(P.isPortrait(844, 390, true), false);
  assert.strictEqual(P.isPortrait(500, 500, true), false, 'square counts as sideways');
  assert.strictEqual(P.isPortrait(390, 844, false), false, 'the parity harness phone config (mouse) keeps the reference');
});

test('draw scale: portrait is the landscape formula with the sides swapped, exactly', () => {
  const sizes = [[1170, 2532], [1080, 1920], [750, 1334], [1536, 2048], [1284, 2778], [600, 601], [1, 3]];
  for (const [w, h] of sizes) {
    assert.strictEqual(C.screenFactor(w, h, true), C.screenFactor(h, w, false), w + 'x' + h);
    assert.strictEqual(C.screenFactor(w, h, false), C.screenFactor(w, h), 'false is the reference formula');
    for (const z of [1, 0.6, 0.27]) {
      const p = C.visibleWorld(w, h, z, true), l = C.visibleWorld(h, w, z, false);
      assert.deepStrictEqual([p.w, p.h], [l.h, l.w], 'the landscape view, turned');
    }
  }
  // 390 x 844 at DPR 3, wheel 1, a fresh cell (zoom 1): draw scale 2532 / 1920 = 1.31875 (the plan's figure),
  // 887.2 x 1920 world units, inside the turned 1080 x 1920 reference screen. Before: 2.094 (the ghost-strip
  // landscape formula), 558.6 x 1080 above the strip rows (1209 with them).
  assert.strictEqual(C.screenFactor(PW, PH, true), 1.31875);
  const v = C.visibleWorld(PW, PH, 1, true);
  assert.ok(Math.abs(v.h - 1920) < 1e-9, String(v.h));
  assert.ok(Math.abs(v.w - 887.2037914691943) < 1e-9, String(v.w));
  const before = C.visibleWorld(PW, Math.trunc((PHONE.h - 90) * PHONE.dpr), 1, false);
  assert.ok(Math.abs(before.h - 1080) < 1e-9 && Math.abs(before.w - 558.62) < 0.01, JSON.stringify(before));
  // A 9:16 phone sees exactly the turned reference screen, and the same phone sideways sees it unturned.
  assert.deepStrictEqual(C.visibleWorld(1080, 1920, 1, true), { w: 1080, h: 1920 });
  assert.deepStrictEqual(C.visibleWorld(1920, 1080, 1, false), { w: 1920, h: 1080 });
});

test('camera: setPortrait switches the draw scale on the next stepZoom; reset keeps it', () => {
  const cam = C.createCamera();
  cam.setCanvasSize(PW, PH);
  cam.stepZoom([{ x: 0, y: 0, size: 32 }]);
  assert.strictEqual(cam.scale, C.screenFactor(PW, PH));
  cam.setPortrait(true);
  cam.stepZoom([{ x: 0, y: 0, size: 32 }]);
  assert.strictEqual(cam.scale, 1.31875, 'zoom 1 at size 32');
  assert.strictEqual(cam.targetScale(), 1.31875);
  cam.reset();
  assert.strictEqual(cam.portrait, true, 'a reconnect does not turn the screen');
  cam.setPortrait(false);
  assert.strictEqual(cam.portrait, false);
});

test('HUD scale: the turned formula, and the board rows at 390 x 844 are bigger than the same phone sideways', () => {
  for (const [w, h] of [[1170, 2532], [1080, 1920], [1536, 2048], [700, 3000]]) {
    assert.strictEqual(H.hudScale(w, h, true), H.hudScale(h, w, false), w + 'x' + h);
    assert.strictEqual(H.hudScale(w, h, false), H.hudScale(w, h));
  }
  const q = H.hudScale(PW, PH, true);
  assert.strictEqual(q, 1170 / 1080);
  const lay = H.layoutLeaderboard(PW, PH, 10, 0, false, true);
  assert.deepStrictEqual([lay.rowFont, lay.titleFont, lay.scale], [19, 32, 1.2]);
  assert.strictEqual(+(lay.rowFont / PHONE.dpr).toFixed(2), 6.33, 'row text 6.33 CSS px');
  // The same phone sideways (844 x 390, the ghost layout 2532 x 900): q 0.833, rows 15 px = 5 CSS px. Before this
  // change, upright (1170 x 2262 layout): q 0.609, rows 10 px = 3.33 CSS px.
  const side = H.layoutLeaderboard(2532, 900, 10, 0, false, false);
  assert.strictEqual(side.rowFont, 15);
  const upBefore = H.layoutLeaderboard(1170, 2262, 10, 0, false, false);
  assert.strictEqual(upBefore.rowFont, 10);
  assert.ok(lay.rowFont > side.rowFont && side.rowFont > upBefore.rowFont);
  // The whole board stays on the canvas: 10 rows tall and the full width, at the top right.
  assert.ok(lay.x >= 0 && lay.y + lay.height < PH / 2, JSON.stringify([lay.x, lay.y, lay.width, lay.height]));
});

test('HUD: setPortrait re-renders the board at the turned scale at once', () => {
  const calls = [];
  const ctx = () => new Proxy({ canvas: {} }, {
    get(t, k) { if (k in t) return t[k]; if (k === 'measureText') return (s) => ({ width: 10 * s.length }); return (...a) => calls.push([k, a]); },
    set(t, k, v) { if (k === 'font') calls.push(['font', v]); t[k] = v; return true; }
  });
  const hud = H.createHud({ createContext: ctx });
  hud.frameStart(PW, PH);
  hud.setBoard([{ name: 'a' }, { name: 'b' }], '');
  const fonts = () => calls.filter((c) => c[0] === 'font').map((c) => c[1]);
  assert.ok(fonts().includes('10px Ubuntu') && fonts().includes('18px Ubuntu'), 'reference scale first: ' + fonts().join(','));
  calls.length = 0;
  hud.setPortrait(true);
  assert.ok(fonts().includes('19px Ubuntu') && fonts().includes('32px Ubuntu'), fonts().join(','));
  calls.length = 0;
  hud.setPortrait(true);
  assert.strictEqual(calls.length, 0, 'no change, no re-render');
});

test('ring width: the turned cap in portrait, the reference cap otherwise', () => {
  assert.strictEqual(R.ringWidth(true, 0.01, PW, PH, false), Math.trunc(Math.min(PH / 1080, PW / 1920) * 20));
  assert.strictEqual(R.ringWidth(true, 0.01, PW, PH, true), Math.trunc(Math.min(PH / 1920, PW / 1080) * 20));
  assert.strictEqual(R.ringWidth(false, 0.01, PW, PH, true), 5);
});

test('stick reach in portrait: full speed sideways at every size up to 1856 (the live page falls short from 1526)', () => {
  // The stick puts the target at the canvas edge (agCamera.stickPoint); the server slows a cell inside
  // zoneSizes * size of its target (law L6). Sideways is the short way in portrait: half the canvas width over the
  // draw scale, with the camera on one cell of that size at wheel 1.
  const zone = LAWS.L6.value.zoneSizes;
  let worst = Infinity;
  for (let size = 32; size <= 1856; size += 8) {
    const s = C.sizeZoom(size) * C.screenFactor(PW, PH, true);
    worst = Math.min(worst, (PW / 2) / s / (zone * size));
  }
  assert.ok(worst >= 1, 'short half over the slow zone ' + worst);
  assert.ok(worst > 1.41, 'the worst is size 1856: ' + worst);
  // Before (the ghost-strip landscape formula upright, the live page): under 1 from size 1526 up, 0.889 at 1856.
  const layout0 = Math.trunc((PHONE.h - 90) * PHONE.dpr);
  const before = (size) => (PW / 2) / (C.sizeZoom(size) * C.screenFactor(PW, layout0, false)) / (zone * size);
  assert.ok(before(1525) >= 1 && before(1526) < 1 && before(1856) < 0.89, [before(1525), before(1526), before(1856)].join(' '));
  // And the stick point itself lands on the side edge.
  const cam = C.createCamera();
  cam.setPortrait(true);
  cam.setCanvasSize(PW, PH);
  cam.stepZoom([{ x: 0, y: 0, size: 1500 }]);
  const p = cam.stickPoint([{ x: 0, y: 0, size: 1500 }], 1, 0);
  assert.deepStrictEqual([p.x, p.y], [PW, Math.trunc(PH / 2)]);
});

// ---- the card --------------------------------------------------------------------------------------------------
function fakeDoc() {
  const doc = { els: [] };
  const make = (tag) => {
    const el = {
      tagName: tag.toUpperCase(), id: '', style: {}, attrs: {}, children: [], parentNode: null, listeners: {},
      innerHTML: '', textContent: '',
      setAttribute(k, v) { this.attrs[k] = String(v); },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
      addEventListener(t, fn, o) { (this.listeners[t] = this.listeners[t] || []).push([fn, o]); }
    };
    doc.els.push(el);
    return el;
  };
  doc.createElement = make;
  doc.head = make('head');
  doc.body = make('body');
  doc.getElementById = (id) => doc.els.find((e) => e.id === id && (e.parentNode || e === doc.head || e === doc.body)) || null;
  return doc;
}
function fakeWin() {
  let clock = 0, timers = [], n = 0;
  return {
    setTimeout(fn, ms) { const id = ++n; timers.push({ id, at: clock + ms, fn }); return id; },
    clearTimeout(id) { timers = timers.filter((t) => t.id !== id); },
    advance(ms) { clock += ms; const due = timers.filter((t) => t.at <= clock); timers = timers.filter((t) => t.at > clock); due.forEach((t) => t.fn()); },
    pending: () => timers.length
  };
}
function store() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

test('card: shows the first time the layout is portrait, goes after PROMPT_MS (3 s), never again in the session', () => {
  assert.strictEqual(P.PROMPT_MS, 3000);
  const doc = fakeDoc(), win = fakeWin(), st = store();
  const pr = P.createRotatePrompt({ doc, win, storage: st });
  pr.update(false);
  assert.strictEqual(pr.el(), null, 'nothing built while sideways');
  pr.update(true);
  const el = pr.el();
  assert.ok(el && el.parentNode === doc.body);
  assert.strictEqual(el.id, 'ag-rotate');
  assert.strictEqual(el.style.display, 'flex');
  assert.ok(pr.shown());
  assert.match(el.innerHTML, /Turn your phone sideways/);
  assert.strictEqual(el.attrs.role, 'status');
  assert.ok(doc.getElementById('ag-rotate-css'), 'its style sheet');
  assert.strictEqual(st.m.get(P.SEEN_KEY), '1');
  win.advance(2999);
  assert.ok(pr.shown(), 'still up at 2999 ms');
  pr.update(true);                       // a resize while it is up changes nothing
  win.advance(1);
  assert.strictEqual(pr.shown(), false, 'gone at 3000 ms');
  assert.strictEqual(el.style.display, 'none');
  pr.update(false);
  pr.update(true);
  assert.strictEqual(pr.shown(), false, 'upright again: straight to the layout');
  // Taps on the card are eaten (no menu press through it).
  assert.ok(el.listeners.touchstart && el.listeners.pointerdown);
  let prevented = 0, stopped = 0;
  el.listeners.touchstart[0][0]({ cancelable: true, preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  assert.deepStrictEqual([prevented, stopped], [1, 1]);
  assert.deepStrictEqual(el.listeners.touchstart[0][1], { passive: false });
});

test('card: turning sideways hides it at once; the same tab session never shows it again; storage may fail', () => {
  const doc = fakeDoc(), win = fakeWin(), st = store();
  const pr = P.createRotatePrompt({ doc, win, storage: st });
  pr.update(true);
  win.advance(800);
  pr.update(false);
  assert.strictEqual(pr.shown(), false);
  assert.strictEqual(win.pending(), 0, 'its timer is cleared');
  pr.update(true);
  assert.strictEqual(pr.shown(), false);
  // The lobby opens the game again in the same tab: a new page, the same session storage.
  const again = P.createRotatePrompt({ doc: fakeDoc(), win: fakeWin(), storage: st });
  again.update(true);
  assert.strictEqual(again.shown(), false);
  // No storage, or storage that throws (a private window): once per page instead.
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  for (const s of [null, bad]) {
    const w2 = fakeWin();
    const p2 = P.createRotatePrompt({ doc: fakeDoc(), win: w2, storage: s });
    assert.doesNotThrow(() => p2.update(true));
    assert.ok(p2.shown());
    w2.advance(3000);
    assert.strictEqual(p2.shown(), false);
  }
  // dispose takes it off the page.
  const d = fakeDoc(), p3 = P.createRotatePrompt({ doc: d, win: fakeWin(), storage: null });
  p3.update(true);
  const el = p3.el();
  p3.dispose();
  assert.strictEqual(el.parentNode, null);
  assert.strictEqual(p3.shown(), false);
});

test('card style: the reference menu\'s plain look, no motion for reduced-motion users, above the menu', () => {
  const css = P.PROMPT_CSS;
  assert.match(css, /background:#fff;border-radius:10px/);
  assert.match(css, /color:#343434/);
  assert.match(css, /font-family:Ubuntu,Arial,sans-serif;font-weight:700/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\{[^}]*animation:none/);
  const z = +/#ag-rotate\{[^}]*z-index:(\d+)/.exec(css)[1];
  assert.ok(z > 20, 'above the menu (#ag-menu z-index 20)');
});

// AFTER.md open item 3: a lobby pinched to 5x before the game opened must be pinchable back to 1 over the card too.
// Chrome drops a whole pinch whose first touchstart was prevented (agInput, P3), so while pinchOk() holds the card
// prevents no touchstart; a one-finger tap there is still eaten at its touchend (no click through the card).
function touchEv(n, own) {
  const e = { cancelable: true, touches: new Array(n).fill({}), prevented: 0, stopped: 0 };
  if (own !== undefined) e.targetTouches = new Array(own).fill({});
  e.preventDefault = () => { e.prevented++; };
  e.stopPropagation = () => { e.stopped++; };
  return e;
}
function cardWith(pinchOk) {
  const doc = fakeDoc(), pr = P.createRotatePrompt({ doc, win: fakeWin(), storage: null, pinchOk });
  pr.update(true);
  const el = pr.el(), fire = (t, n, own) => { const e = touchEv(n, own); el.listeners[t].forEach((l) => l[0](e)); return e; };
  return { el, fire };
}

test('card pinch: while the lobby is zoomed a pinch on the card is the browser\'s, a tap is still eaten', () => {
  let zoomed = true;
  const { el, fire } = cardWith(() => zoomed);
  for (const t of ['touchstart', 'touchend', 'touchcancel']) assert.deepStrictEqual(el.listeners[t][0][1], { passive: false }, t);
  // Pinch: first finger alone, then two, then lift one by one. Nothing is prevented; nothing propagates past the card.
  let e = fire('touchstart', 1);
  assert.deepStrictEqual([e.prevented, e.stopped], [0, 1], 'the first finger of a pinch arrives alone');
  e = fire('touchstart', 2);
  assert.deepStrictEqual([e.prevented, e.stopped], [0, 1]);
  assert.strictEqual(fire('touchend', 1).prevented, 0, 'a pinch end is left alone');
  assert.strictEqual(fire('touchend', 0).prevented, 0);
  // Both fingers at once.
  assert.strictEqual(fire('touchstart', 2).prevented, 0);
  assert.strictEqual(fire('touchend', 0).prevented, 0);
  // A one-finger tap: its touchstart is left alone (it might become a pinch), its touchend is prevented (no click).
  assert.strictEqual(fire('touchstart', 1).prevented, 0);
  assert.strictEqual(fire('touchend', 0).prevented, 1, 'the tap is eaten');
  // A cancelled touch resets too.
  fire('touchstart', 1);
  assert.strictEqual(fire('touchcancel', 0).prevented, 1);
  // Lobby back at 1: every touchstart on the card is eaten again, as before, and touchend is left alone.
  zoomed = false;
  e = fire('touchstart', 1);
  assert.deepStrictEqual([e.prevented, e.stopped], [1, 1]);
  assert.strictEqual(fire('touchstart', 2).prevented, 1, 'a second finger is eaten too');
  assert.strictEqual(fire('touchend', 0).prevented, 0);
});

test('card pinch: the first finger decides for the whole touch; no pinchOk means always eaten', () => {
  let zoomed = false;
  const a = cardWith(() => zoomed);
  a.fire('touchstart', 1);                       // starts eaten (lobby at 1)
  zoomed = true;                                 // the lobby reports zoomed mid-touch
  assert.strictEqual(a.fire('touchstart', 2).prevented, 1, 'still eaten: decided by the first finger');
  a.fire('touchend', 0);
  assert.strictEqual(a.fire('touchstart', 1).prevented, 0, 'the next touch decides again');
  a.fire('touchend', 0);
  // A finger already down elsewhere (the canvas) and the second lands on the card: decided at that touchstart.
  assert.strictEqual(a.fire('touchstart', 2).prevented, 0);
  a.fire('touchend', 0);
  for (const opt of [undefined, null, 'yes']) {
    const b = cardWith(opt);
    assert.strictEqual(b.fire('touchstart', 1).prevented, 1, String(opt));
    assert.strictEqual(b.fire('touchstart', 2).prevented, 1, String(opt));
  }
});

test('card pinch: the card has no touch-action of its own, so it follows the page (none, or pinch-zoom when zoomed)', () => {
  const rule = /#ag-rotate\{([^}]*)\}/.exec(P.PROMPT_CSS)[1];
  assert.doesNotMatch(rule, /touch-action/);
  assert.doesNotMatch(P.PROMPT_CSS, /#ag-rotate[^{]*\{[^}]*touch-action/, 'nor on anything inside it');
  const css = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'css', 'ag.css'), 'utf8');
  assert.match(css, /html, body \{[^}]*touch-action: none;/, 'the page default the card inherits at 1');
});

test('card pinch: the card counts its own fingers (targetTouches); a finger elsewhere still makes a pinch', () => {
  let zoomed = true;
  const { fire } = cardWith(() => zoomed);
  // One finger already on the canvas, the second lands on the card: a pinch, left alone.
  assert.strictEqual(fire('touchstart', 2, 1).prevented, 0);
  assert.strictEqual(fire('touchend', 1, 0).prevented, 0, 'the card finger lifts first: a pinch end, not a tap');
  // The canvas finger is still down and the lobby is now at 1: the card's next finger decides afresh and is eaten.
  zoomed = false;
  assert.strictEqual(fire('touchstart', 2, 1).prevented, 1, 'no stale pinch state from the last touch');
  fire('touchend', 1, 0);
  // Back to zoomed: a lone tap on the card while a finger rests elsewhere is still a pinch (two on the screen).
  zoomed = true;
  assert.strictEqual(fire('touchstart', 2, 1).prevented, 0);
  assert.strictEqual(fire('touchend', 1, 0).prevented, 0);
});
