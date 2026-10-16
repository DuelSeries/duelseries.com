/* Lobby tab swipes on a slow phone (2026-10-16). At 4x CPU every tab swipe
   dropped frames in the one it claimed the drag in: the screen coming in was
   built from nothing there (style, layout and paint of a display:none screen,
   plus every first-time font and text set-up the first time), and the Shop
   threw its painted previews away and repainted them on every visit.

   Now each tab's screen is laid out once in idle time after load (warmed), the
   Play screen waits built off to the side while Wallet is up (parked), the
   Shop keeps its cards when nothing about them changed, and its previews sit
   out the claim frame. The timing was measured in Chrome with real touch
   events; these check the plumbing that keeps it that way. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const run = (box, f) => vm.runInContext(read(f), box, { filename: f });
const html = () => read('public/v2.html');
const fnBody = (src, sig) => { const i = src.indexOf(sig); assert.ok(i > 0, sig + ' is where this test expects it'); return src.slice(i, src.indexOf('\n}', i)); };

/* swipe.js in a sandbox: idle callbacks and timers queued by hand, the two
   page hooks recorded. */
function swipePage(route) {
  const box = { console, route, idle: [], timers: [], warmed: [], parks: 0, docOn: {}, winOn: {} };
  box.window = box;
  box.performance = { now: () => 0 };
  box.requestIdleCallback = (f) => box.idle.push(f);
  box.setTimeout = (f) => box.timers.push(f);
  box.clearTimeout = () => {};
  box.getComputedStyle = () => ({ display: 'block', position: 'fixed' });
  box.addEventListener = (t, f) => { box.winOn[t] = f; };
  box.warmScreen = (t) => box.warmed.push(t);
  box.parkScreen = () => { box.parks++; };
  box.document = { readyState: 'interactive', hidden: false, addEventListener: (t, f) => { box.docOn[t] = f; },
                   getElementById: () => null, querySelector: () => null };
  vm.createContext(box);
  run(box, 'public/js/v2/swipe.js');
  box.runIdle = () => { const q = box.idle.splice(0); q.forEach((f) => f({ timeRemaining: () => 10 })); return q.length; };
  return box;
}

test('after load each tab screen is warmed once, nearest first, one per idle moment, then Play is parked', () => {
  const box = swipePage('play');
  assert.ok(box.winOn.load, 'it waits for the page to load');
  box.winOn.load();
  const order = [];
  for (let i = 0; i < 8 && box.idle.length; i++) {
    assert.strictEqual(box.idle.length, 1, 'one piece per idle moment');
    box.runIdle();
    order.push(box.warmed.slice(-1)[0]);
  }
  assert.deepStrictEqual(box.warmed, ['wallet', 'events', 'social', 'shop', 'settings'], 'every other tab once, nearest first');
  assert.strictEqual(box.parks, 1, 'and then it asks for the park (the page decides whether there is one)');
});

test('nothing is warmed or parked while a finger is down', () => {
  const box = swipePage('play');
  box.winOn.load();
  box.docOn.touchstart({ touches: [{ clientX: 100, clientY: 300 }], target: {}, timeStamp: 1 });
  box.runIdle();
  assert.deepStrictEqual(box.warmed, [], 'a touch that might become a swipe is left alone');
  assert.strictEqual(box.timers.length, 1, 'and it tries again later');
  box.docOn.touchend({});
  box.timers.splice(0).forEach((f) => f());
  box.runIdle();
  assert.deepStrictEqual(box.warmed, ['wallet'], 'once the finger is up');
});

test('a landing asks for the park, once, in idle time', () => {
  const box = swipePage('wallet');
  assert.strictEqual(typeof box.V2Swipe.landed, 'function', 'go() has a hook to call');
  box.V2Swipe.landed(); box.V2Swipe.landed();
  assert.strictEqual(box.idle.length, 1, 'asked twice, queued once');
  box.runIdle();
  assert.strictEqual(box.parks, 1);
  assert.ok(/if\(window\.V2Swipe\)V2Swipe\.landed\(\)/.test(fnBody(html(), 'function go(id,dir){')), 'a tap landing asks too');
});

/* The park and its bookkeeping, run for real: the page's own functions with
   fake screens. paned: whether the screens are the phone's fixed panes. */
function parkPage(route, paned = true) {
  const h = html();
  const mk = (id, display) => { const cls = new Set(), attrs = {}; return { id, style: { display }, offsetHeight: 0,
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, getAttribute: (k) => attrs[k] }; };
  const els = { home: mk('home', 'block'), 'wallet-screen': mk('wallet-screen', 'none') };
  const box = { els, route, document: { getElementById: (id) => els[id] || null },
                getComputedStyle: (e) => ({ display: e.style.display || 'block', position: paned ? 'fixed' : 'static' }) };
  vm.createContext(box);
  const from = h.indexOf('const HOME=');
  const to = h.indexOf('\n}', h.indexOf('function unparkScreen')) + 2;
  assert.ok(from > 0 && to > from, 'the park functions are where this test expects them');
  vm.runInContext('let _parked=null;' + h.slice(from, to), box);
  return box;
}

test('on a phone Play is parked where it stands when left, never torn down, and comes back as it was', () => {
  const box = parkPage('wallet');
  const { home } = box.els, wallet = box.els['wallet-screen'];
  vm.runInContext("putAway(els.home); els['wallet-screen'].style.display='block'", box);
  assert.strictEqual(home.style.display, 'block', 'still displayed: that is what keeps it built');
  assert.ok(home.classList.contains('scr-park'), 'off to the side');
  assert.strictEqual(home.getAttribute('aria-hidden'), 'true', 'and out of the screen reader');
  assert.strictEqual(vm.runInContext('screenShown(els.home)', box), false, 'parked is not shown');
  assert.strictEqual(vm.runInContext("screenShown(els['wallet-screen'])", box), true, 'Wallet is');
  vm.runInContext('putAway(els.home)', box);
  assert.ok(home.classList.contains('scr-park') && home.style.display === 'block', 'putting it away again changes nothing');
  vm.runInContext("putAway(els['wallet-screen'])", box);
  assert.strictEqual(wallet.style.display, 'none', 'every other screen is hidden as before');
  vm.runInContext("unparkScreen(els['wallet-screen'])", box);
  assert.ok(home.classList.contains('scr-park'), 'showing another screen leaves Play parked');
  vm.runInContext('unparkScreen(els.home)', box);
  assert.ok(!home.classList.contains('scr-park') && home.getAttribute('aria-hidden') === undefined, 'coming back takes it as it is');
  assert.strictEqual(home.style.display, 'block', 'already built');
  assert.strictEqual(vm.runInContext('_parked', box), null);
});

test('a lobby opened on another tab builds Play once, parked; nothing parks off the phone layout', () => {
  const box = parkPage('wallet');
  box.els.home.style.display = 'none';
  vm.runInContext('parkScreen()', box);
  assert.ok(box.els.home.classList.contains('scr-park') && box.els.home.style.display === 'block', 'built once, parked');
  const onPlay = parkPage('play');
  onPlay.els.home.style.display = 'none';
  vm.runInContext('parkScreen()', onPlay);
  assert.strictEqual(onPlay.els.home.style.display, 'none', 'not while Play is the route: the router shows it');
  const desk = parkPage('wallet', false);
  vm.runInContext('putAway(els.home)', desk);
  assert.strictEqual(desk.els.home.style.display, 'none', 'off the phone layout Play is hidden like any screen');
  assert.ok(!desk.els.home.classList.contains('scr-park'));
  assert.ok(/\.scr-park \{ display:none !important \}\s*@media\(max-width:760px\)\{\s*\.scr-park \{ display:block !important; transform:translateX\(-200%\)/.test(html()),
    'and a phone turned past the pane layout hides a parked screen rather than dropping it into the page');
});

test('every way the screen changes goes through the park, and every "which screen is up" check skips a parked one', () => {
  const h = html(), sw = read('public/js/v2/swipe.js');
  const show = fnBody(h, 'function showScreen(id,dir){');
  assert.ok(/unparkScreen\(document\.getElementById\(id\)\)/.test(show), 'taps bring a parked Play back');
  assert.ok(!/style\.display='none'/.test(show) && (show.match(/putAway\(/g) || []).length === 3, 'and put screens away, never hide them directly');
  assert.ok(/if\(el===_parked\)unparkScreen\(el\)/.test(fnBody(h, 'function prepareScreen(tab){')), 'a swipe staging it');
  const commit = fnBody(h, 'function commitScreen(tab){');
  assert.ok(/unparkScreen\(document\.getElementById\(id\)\)/.test(commit) && /putAway\(el\)/.test(commit) && !/style\.display='none'/.test(commit),
    'a swipe landing parks Play where it stands');
  assert.ok(/window\.putAway\(d\.incoming\)/.test(sw), 'and so does a swipe that springs back');
  for (const sig of ['function showScreen(id,dir){', 'function jumpToTop(){', 'function open_(id){'])
    assert.ok(/\.find\(screenShown\)/.test(fnBody(h, sig)), sig + ' skips a parked screen');
  assert.ok(/window\.screenShown/.test(sw), 'so does the swipe');
  assert.ok(/window\.screenShown/.test(read('public/js/v2/board.js')), 'and the lobby list stops polling for a parked Play');
  // Nothing in it animates while it waits: the live dots' pulse is a repaint every frame.
  assert.ok(/\.scr-park \.ldot[^{]*\.scr-park \.tkrun[^{]*\{ animation-play-state:paused !important \}/.test(h), 'its animations pause');
  // _parked is read by the frame loop on its first frame, so it must be declared above it.
  assert.ok(h.indexOf('let _parked=null;') < h.indexOf('function lobbyLoop(t){'), '_parked is declared above the loop');
});

test('the lobby loop does not paint a parked screen\'s canvases', () => {
  const h = html();
  const from = h.indexOf('let _last=0;');
  const to = h.indexOf('\n};', h.indexOf('window._resumeLobbyAnims=')) + 3;
  const painted = [];
  const a = { offsetParent: {} }, b = { offsetParent: {} };
  const ctx = { requestAnimationFrame: () => 1, performance: { now: () => 0 }, RM: { addEventListener() {} }, Math,
    repaintAll() {}, paintScene: (cv) => painted.push(cv), paintLook() {}, reelStep() {},
    document: { body: { classList: { add() {}, remove() {} } }, querySelectorAll: (s) => (s === 'canvas[data-anim]' ? [a, b] : []) } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(h.slice(from, to), ctx);
  painted.length = 0;
  vm.runInContext('_parked={contains:(n)=>n===this.parkedCanvas}', Object.assign(ctx, { parkedCanvas: b }));
  vm.runInContext('lobbyLoop(16)', ctx);
  assert.deepStrictEqual(painted, [a], 'only the canvas that is really on screen');
});

test('the warm-up is phones only, one layout, never painted', () => {
  const h = html();
  const fn = fnBody(h, 'function warmScreen(tab){');
  assert.ok(/cs\.position!=='fixed'/.test(fn), 'only where every screen is its own fixed pane');
  const on = fn.indexOf("classList.add('scr-warm')"), lay = fn.indexOf('void el.offsetHeight'), off = fn.indexOf("classList.remove('scr-warm')");
  assert.ok(on > 0 && on < lay && lay < off, 'on for one forced layout, off again in the same task');
  assert.ok(/\.scr-warm \{ display:block !important; visibility:hidden !important/.test(h), 'and invisible while it is on');
  assert.ok(/V2ShopTab\.render\(\)/.test(fn), 'the Shop is filled first: its cards need no network');
});

/* The Shop in a sandbox whose host remembers its markup like a real element. */
function shopPage() {
  const box = { console, raf: [], paints: [], builds: 0, clock: 0, devicePixelRatio: 2, innerWidth: 375, innerHeight: 812 };
  box.window = box;
  box.performance = { now: () => box.clock };
  box.requestAnimationFrame = (fn) => box.raf.push(fn);
  const cvs = Array.from({ length: 8 }, (_, i) => ({
    dataset: { g: 'snake', k: 'k' + i }, clientWidth: 168, clientHeight: 134, width: 336, height: 268,
    getBoundingClientRect: () => ({ top: 200, bottom: 334, left: 20, right: 188 }),
  }));
  let markup = '';
  const host = { get firstChild() { return markup ? {} : null; }, set innerHTML(v) { markup = v; box.builds++; },
                 querySelector: () => null, querySelectorAll: () => cvs };
  box.document = { hidden: false, getElementById: (id) => (id === 'shop' ? host : id === 'shop-screen' ? { getClientRects: () => [1] } : null) };
  box.V2Shop = {
    games: [{ id: 'snake', name: 'Slither.io', skins: cvs.map((c, i) => ({ id: 'k' + i, name: 'K' + i })) },
            { id: 'agar', name: 'Agar.io', skins: [] }],
    game(id) { return this.games.find((g) => g.id === id); },
    price: () => 100, format: () => '$1', animated: () => true,
    paint: (c) => { box.paints.push(c); },
  };
  vm.createContext(box);
  run(box, 'public/js/v2/shop.js');
  box.frame = (ts) => { const q = box.raf.splice(0); q.forEach((f) => f(ts)); };
  box.host = host;
  return box;
}

test('the Shop keeps its painted cards when nothing about them changed', () => {
  const box = shopPage();
  box.V2ShopTab.render();
  assert.strictEqual(box.builds, 1);
  let ts = 1000;
  for (let f = 0; f < 10; f++) box.frame(ts += 16.7);
  box.V2ShopTab.render();                                    // the next swipe or tap into the Shop
  assert.strictEqual(box.builds, 1, 'the same markup is not rebuilt, so its previews keep their pixels');
  box.paints.length = 0;
  box.frame(ts += 16.7);
  assert.ok(box.paints.length <= 8, 'and nothing is waiting to be painted from blank');
});

test('the Shop\'s previews sit out the frame a tab swipe claims its drag in', () => {
  const box = shopPage();
  box.V2ShopTab.render();
  let ts = 1000;
  for (let f = 0; f < 10; f++) box.frame(ts += 16.7);
  box.paints.length = 0;
  box.V2Swipe = { claimedAt: ts + 20 };                     // the touch that claimed it, handled in this frame
  box.frame(ts += 16.7);
  assert.strictEqual(box.paints.length, 0, 'nothing painted in the claim frame');
  box.frame(ts += 16.7); box.frame(ts += 16.7);
  assert.ok(box.paints.length > 0, 'and they carry on from the next');
});

test('the moving previews get a few milliseconds a frame, at least one, and whoever waited goes first', () => {
  const box = shopPage();
  box.V2Shop.paint = (c) => { box.paints.push(c); box.clock += 2; };   // a slow phone: 2 ms a preview
  box.V2ShopTab.render();
  let ts = 1000;
  for (let f = 0; f < 12; f++) box.frame(ts += 16.7);                    // every card up, sized
  box.paints.length = 0;
  box.frame(ts += 40);                                                  // a tick: all eight are due
  assert.ok(box.paints.length >= 1 && box.paints.length <= 3, 'a few, not all eight in one frame: ' + box.paints.length);
  const first = box.paints.slice();
  box.frame(ts += 16.7); box.frame(ts += 16.7);
  assert.ok(box.paints.length >= 8, 'the rest follow over the next frames');
  assert.strictEqual(new Set(box.paints.slice(0, 8)).size, 8, 'and nobody is painted twice before everyone has had a turn');
  assert.deepStrictEqual(box.paints.slice(0, first.length), first);
});

test('a swipe opens the incoming screen\'s money count-up just after the claim, not inside it', () => {
  const prep = fnBody(html(), 'function prepareScreen(tab){');
  assert.ok(/setTimeout\(\(\)=>DSCount\.open\(el\),0\)/.test(prep), 'the count-up still opens on a swipe, one task later');
  assert.ok(!/[^>]DSCount\.open\(el\);/.test(prep), 'and not in the claim itself');
});
