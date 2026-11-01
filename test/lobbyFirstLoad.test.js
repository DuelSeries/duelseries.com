'use strict';
/* The lobby's first load (2026-11-01): what a phone has to fetch and run before v2.html is up.

   1. The wallet widget (public/wallet/widget.js, 5 MB, 1.2 MB compressed) is no tag. DSWalletBoot at the top of
      <body> looks for a sign of a session and, with one, preloads it; the loader at the end of <body> runs it right
      after the loading screen starts to fade (a session) or once the page has loaded and is idle (none), and at once
      when Sign in is pressed or the Wallet tab opens first. Its duelWalletLogin stand-in keeps the widget's own
      "Signing in" card up and hands over to the widget's sign in with the same `where`.
   2. slither's renderer and Awesome Tanks' art (needR makes R only for a canvas really on screen) and the lobby's
      clip recorder come after the page has loaded (DSLater), in order, clipRec with its data attributes.
   3. invite.js and ownerJoin.js do not wait for a widget that is not coming when there is no session at all.

   The blocks run here in a vm with stand-ins for the page: localStorage, the cookie, the address, script tags
   (their onload and onerror pressed by hand), timers on a clock this file moves, and DSDialog and DSTrack. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const HTML = read('public/v2.html');
const PLAN = require(path.join(ROOT, 'shared', 'trackPlan.js'));

/* The inline <script> holding `marker`. */
function block(marker) {
  const at = HTML.indexOf(marker);
  assert.ok(at > 0, 'v2.html has ' + marker);
  const open = HTML.lastIndexOf('<script>', at);
  const close = HTML.indexOf('</script>', at);
  return HTML.slice(open + '<script>'.length, close);
}
const BOOT = block("var B=window.DSWalletBoot={src:'/wallet/widget.js',session:false};");
const LOADER = block('B.load=function(){');
const LATER = block('window.DSLater={now:now};');

/* A page to run them in, on a clock of its own. */
function page(opts) {
  opts = opts || {};
  let now = 0;
  const timers = [];
  const setTimeout = (f, ms) => { timers.push({ at: now + (ms || 0), f }); return timers.length; };
  const listeners = {};
  const appended = [];
  const store = new Map(Object.entries(opts.storage || {}));
  const classes = (list) => {
    const set = new Set(list);
    return { contains: (c) => set.has(c), add: (c) => { set.add(c); }, _set: set };
  };
  const splash = opts.splash ? { classList: classes(opts.splashOut ? ['out'] : []), isConnected: true } : null;
  const observers = [];
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.on = false; observers.push(this); }
    observe() { this.on = true; }
    disconnect() { this.on = false; }
  }
  const el = (tag) => ({ tagName: tag, dataset: {}, removed: false, remove() { this.removed = true; } });
  const dialog = [];
  const sent = [];
  const win = {
    console: { warn() {}, log() {} },
    Promise, Date: { now: () => 1e12 + now }, Error, String, Object, JSON, Array,
    setTimeout,
    requestAnimationFrame: (f) => setTimeout(f, 16),
    requestIdleCallback: (f, o) => setTimeout(f, Math.min(500, (o && o.timeout) || 500)),
    MutationObserver,
    location: { search: opts.search || '' },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null) },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    document: {
      cookie: opts.cookie || '',
      readyState: opts.readyState || 'interactive',
      head: { appendChild: (n) => { n.parent = 'head'; appended.push(n); } },
      body: { appendChild: (n) => { n.parent = 'body'; appended.push(n); } },
      createElement: el,
      getElementById: (id) => (id === 'splash' ? splash : null),
    },
  };
  if (opts.dialog !== false) {
    win.DSDialog = {
      busy: (c) => dialog.push(['busy', c.title, c.line]),
      close: () => dialog.push(['close']),
      alert: (c) => { dialog.push(['alert', c.title, c.line]); return Promise.resolve(); },
    };
  }
  win.DSTrack = { event: (name, props) => { sent.push({ name, props }); return true; } };
  win.window = win;
  vm.createContext(win);
  const run = (code) => vm.runInContext(code, win);
  const settle = () => new Promise((r) => setImmediate(r));
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      await settle();
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.f();
    }
    now = end;
    await settle();
  }
  const fire = (t) => (listeners[t] || []).forEach((f) => f({}));
  const scripts = (src) => appended.filter((n) => n.tagName === 'script' && (!src || n.src === src));
  const fadeSplash = () => { splash.classList.add('out'); observers.filter((o) => o.on).forEach((o) => o.cb([], o)); };
  return { win, run, advance, fire, scripts, appended, dialog, sent, fadeSplash, settle };
}
const WIDGET = '/wallet/widget.js';

// ── 1. no tag, and the session signs ──────────────────────────────────────────────────────────────────────────────

test('the widget, the renderer, shooterArt and the clip recorder are no script tags: nothing waits on them', () => {
  for (const f of ['/wallet/widget.js', '/js/HexGrid.js', '/js/Camera.js', '/js/SnakeGL.js', '/js/FoodGL.js',
    '/js/shooterArt.js', '/js/Renderer.js', '/js/clip/mp4mux.js', '/js/clip/clipRec.js']) {
    assert.ok(!new RegExp('<script[^>]*src="' + f.replace(/[.]/g, '\\.') + '"').test(HTML), f + ' has no tag');
  }
  const body = HTML.slice(HTML.indexOf('</head>\n<body>'));
  assert.ok(body.indexOf(BOOT) > body.indexOf('window.dsSplashDone=hide;'), 'the session check comes after the splash script');
  assert.ok(body.indexOf(BOOT) < body.indexOf('<script src="/js/posthog-init.js"'), 'and before every script tag');
  assert.ok(HTML.indexOf('<script src="/js/shared/dsDialog.js" defer></script>') > 0, 'the gold card, deferred');
});

test('a sign of a session: Privy\'s tokens, the widget\'s copy, Privy\'s cookie, or a sign-in coming back', () => {
  const cases = [
    [{}, false],
    [{ storage: { 'privy:refresh_token': '"r"' } }, true],
    [{ storage: { 'privy:token': '"t"' } }, true],
    [{ storage: { 'privy:id_token': '"i"' } }, true],
    [{ storage: { duel_admin_token: 'a' } }, true],
    [{ storage: { duel_id_token: 'i' } }, true],
    [{ storage: { 'privy:caid': '"c"', duelseries_region: 'na' } }, false],   // Privy's analytics id and the lobby's own keys are not a session
    [{ cookie: 'a=1; privy-session=t' }, true],
    [{ cookie: 'privy-token=x' }, true],
    [{ cookie: 'notprivy-session=t' }, false],
    [{ search: '?privy_oauth_code=x&privy_oauth_state=y' }, true],
    [{ search: '?signin=wallet' }, true],
    [{ search: '?a=1&signin=wallet' }, true],
    [{ search: '?signin=walletx' }, false],
  ];
  for (const [opts, want] of cases) {
    const p = page(opts);
    p.run(BOOT);
    assert.strictEqual(p.win.DSWalletBoot.session, want, JSON.stringify(opts));
    const pre = p.appended.filter((n) => n.tagName === 'link');
    if (want) {
      assert.strictEqual(pre.length, 1, 'one preload');
      assert.deepStrictEqual([pre[0].rel, pre[0].as, pre[0].href, pre[0].parent], ['preload', 'script', WIDGET, 'head']);
    } else assert.strictEqual(pre.length, 0, 'no preload without a session: ' + JSON.stringify(opts));
  }
  // Storage that throws (a locked-down browser) is no session, and no error.
  const p = page({});
  p.win.localStorage = { getItem() { throw new Error('denied'); } };
  p.run(BOOT);
  assert.strictEqual(p.win.DSWalletBoot.session, false);
});

// ── 2. when it loads ──────────────────────────────────────────────────────────────────────────────────────────────

test('no session: nothing until the page has loaded and is idle, then the widget once', async () => {
  const p = page({ splash: true });
  p.run(BOOT); p.run(LOADER);
  assert.strictEqual(typeof p.win.duelWalletLogin, 'function', 'Sign in works from the first moment');
  await p.advance(10000);
  assert.strictEqual(p.scripts().length, 0, 'not fetched while the page is still loading');
  p.fire('load');
  await p.advance(600);
  assert.strictEqual(p.scripts(WIDGET).length, 1, 'fetched once idle after load');
  assert.strictEqual(p.scripts(WIDGET)[0].parent, 'body');
  p.win.DSWalletBoot.load(); p.win.DSWalletBoot.load();
  await p.advance(20000);
  assert.strictEqual(p.scripts(WIDGET).length, 1, 'and only once');
});

test('no session and a load event that never comes: the widget still arrives, after 15 s', async () => {
  const p = page({});
  p.run(BOOT); p.run(LOADER);
  await p.advance(14000);
  assert.strictEqual(p.scripts(WIDGET).length, 0);
  await p.advance(2000);
  assert.strictEqual(p.scripts(WIDGET).length, 1);
});

test('a session: run right after the loading screen starts to fade, never before', async () => {
  const p = page({ storage: { 'privy:refresh_token': '"r"' }, splash: true });
  p.run(BOOT); p.run(LOADER);
  await p.advance(1000);
  assert.strictEqual(p.scripts(WIDGET).length, 0, 'held while the splash is up');
  p.fadeSplash();
  await p.advance(40);
  assert.strictEqual(p.scripts(WIDGET).length, 1, 'two frames after the fade starts');
  await p.advance(5000);
  assert.strictEqual(p.scripts(WIDGET).length, 1, 'once');
});

test('a session with no splash (a frame), or one already fading: at once; a splash that never fades: 4 s', async () => {
  for (const opts of [{ splash: false }, { splash: true, splashOut: true }]) {
    const p = page(Object.assign({ storage: { duel_admin_token: 'a' } }, opts));
    p.run(BOOT); p.run(LOADER);
    await p.advance(300);
    assert.strictEqual(p.scripts(WIDGET).length, 1, JSON.stringify(opts));
  }
  const p = page({ storage: { duel_admin_token: 'a' }, splash: true });
  p.run(BOOT); p.run(LOADER);
  await p.advance(3900);
  assert.strictEqual(p.scripts(WIDGET).length, 0);
  await p.advance(400);
  assert.strictEqual(p.scripts(WIDGET).length, 1);
});

// ── 3. Sign in before the widget is here ─────────────────────────────────────────────────────────────────────────

test('Sign in first: the widget\'s own "Signing in" card, the widget fetched now, then its sign in with the same where', async () => {
  const p = page({});
  p.run(BOOT); p.run(LOADER);
  const stub = p.win.duelWalletLogin;
  stub('header'); stub('header');
  assert.deepStrictEqual(p.dialog, [['busy', 'Signing in', 'Getting ready']], 'one card, the widget\'s words');
  assert.strictEqual(p.scripts(WIDGET).length, 1, 'fetched at once');
  p.scripts(WIDGET)[0].onload();
  await p.advance(200);
  assert.strictEqual(p.dialog.length, 1, 'still up while the widget mounts');
  // The widget mounts: its effects publish duelWallet and its own duelWalletLogin.
  const calls = [];
  p.win.duelWallet = { ready: true, authenticated: false };
  p.win.duelWalletLogin = (w) => { calls.push(w); };
  await p.advance(60);
  assert.deepStrictEqual(calls, ['header'], 'handed over once, with where');
  assert.deepStrictEqual(p.dialog[1], ['close'], 'Privy is up, so the card goes before its window opens');
  assert.strictEqual(p.sent.length, 0, 'the widget sends signin_opened itself');
});

test('Privy still starting when the widget mounts: the card goes, and the widget\'s sign in puts it back itself', async () => {
  const p = page({});
  p.run(BOOT); p.run(LOADER);
  p.win.duelWalletLogin('play');
  p.scripts(WIDGET)[0].onload();
  const calls = [];
  p.win.duelWallet = { ready: false };
  p.win.duelWalletLogin = (w) => { calls.push(w); p.win.DSDialog.busy({ title: 'Signing in', line: 'Getting ready' }); };
  await p.advance(60);
  assert.deepStrictEqual(calls, ['play']);
  assert.deepStrictEqual(p.dialog, [['busy', 'Signing in', 'Getting ready'], ['close'], ['busy', 'Signing in', 'Getting ready']],
    'closed, then the widget\'s own card in the same task');
});

test('Privy ready a moment before the widget publishes duelWallet: the card still goes (it used to stay up for good)', async () => {
  const p = page({});
  p.run(BOOT); p.run(LOADER);
  p.win.duelWalletLogin('header');
  p.scripts(WIDGET)[0].onload();
  const calls = [];
  // duelWalletLogin is in, duelWallet not yet: the widget's sign in opens Privy (or returns) and never closes it
  p.win.duelWalletLogin = (w) => { calls.push(w); };
  await p.advance(60);
  assert.deepStrictEqual(calls, ['header']);
  assert.deepStrictEqual(p.dialog, [['busy', 'Signing in', 'Getting ready'], ['close']]);
});

test('a slow download does not use up the 20 s: the limit starts once the script is in', async () => {
  const p = page({});
  p.run(BOOT); p.run(LOADER);
  p.win.duelWalletLogin('header');
  await p.advance(25000);   // still downloading
  p.scripts(WIDGET)[0].onload();
  await p.advance(100);
  assert.deepStrictEqual(p.dialog, [['busy', 'Signing in', 'Getting ready']], 'no "didn\'t load" for a widget about to mount');
  const calls = [];
  p.win.duelWallet = { ready: true };
  p.win.duelWalletLogin = (w) => { calls.push(w); };
  await p.advance(60);
  assert.deepStrictEqual(calls, ['header']);
  assert.deepStrictEqual(p.dialog[1], ['close']);
  assert.strictEqual(p.sent.length, 0);
});

test('the widget cannot be fetched: the widget\'s own message, a planned signin_failed, and the next press tries again', async () => {
  const p = page({});
  p.run(BOOT); p.run(LOADER);
  p.win.duelWalletLogin('settings');
  const first = p.scripts(WIDGET)[0];
  first.onerror();
  await p.advance(10);
  assert.ok(first.removed, 'the dead tag goes');
  assert.deepStrictEqual(p.dialog[1], ['alert', "Sign in didn't load", 'Check your connection, or turn off blockers for this site, then try again.']);
  assert.deepStrictEqual(p.sent.map((e) => e.name), ['signin_opened', 'signin_failed']);
  for (const e of p.sent) {
    const c = PLAN.clean(e.name, e.props);
    assert.ok(c.ok, e.name + ' is in the plan');
    assert.deepStrictEqual(c.dropped, [], e.name + ' sends only planned properties');
  }
  // Made in the page's own realm, so compared as JSON.
  assert.strictEqual(JSON.stringify(p.sent[0].props), JSON.stringify({ where: 'settings' }));
  assert.strictEqual(JSON.stringify(p.sent[1].props), JSON.stringify({ step: 'loading', error: 'widget_not_loaded' }));
  p.win.duelWalletLogin('settings');
  assert.strictEqual(p.scripts(WIDGET).length, 2, 'a second press fetches it again');
});

test('a widget that loads but never mounts: the card does not stay up past 20 s', async () => {
  const p = page({});
  p.run(BOOT); p.run(LOADER);
  p.win.duelWalletLogin('header');
  p.scripts(WIDGET)[0].onload();
  await p.advance(19000);
  assert.strictEqual(p.dialog.length, 1);
  await p.advance(2000);
  assert.strictEqual(p.dialog[1][0], 'alert');
});

test('no DSDialog yet (its deferred tag still on the way): Sign in still fetches and hands over', async () => {
  const p = page({ dialog: false });
  p.run(BOOT); p.run(LOADER);
  p.win.duelWalletLogin('header');
  p.scripts(WIDGET)[0].onload();
  const calls = [];
  p.win.duelWallet = { ready: true };
  p.win.duelWalletLogin = (w) => { calls.push(w); };
  await p.advance(60);
  assert.deepStrictEqual(calls, ['header']);
});

test('the Wallet tab asks for the widget when it is not in yet', () => {
  const fill = HTML.slice(HTML.indexOf('function fillScreen(tab){'), HTML.indexOf("else if(tab==='social')V2Social.load();"));
  assert.match(fill, /if\(tab==='wallet'\)\{if\(!window\.duelWallet&&window\.DSWalletBoot&&DSWalletBoot\.load\)DSWalletBoot\.load\(\)\.catch\(\(\)=>\{\}\);V2Wallet\.render\(\);\}/);
});

// ── 4. the scripts nothing reads while the page builds ───────────────────────────────────────────────────────────

test('DSLater: after load and idle, in order, async=false, clipRec with data-game="other" data-top="1"; once', async () => {
  const p = page({});
  p.run(LATER);
  await p.advance(5000);
  assert.strictEqual(p.scripts().length, 0, 'nothing while the page loads');
  p.fire('load');
  await p.advance(600);
  const s = p.scripts();
  assert.deepStrictEqual(s.map((n) => n.src), ['/js/HexGrid.js', '/js/Camera.js', '/js/SnakeGL.js', '/js/FoodGL.js',
    '/js/shooterArt.js', '/js/Renderer.js', '/js/clip/mp4mux.js', '/js/clip/clipRec.js']);
  assert.ok(s.every((n) => n.async === false), 'run in the order given');
  assert.deepStrictEqual(Object.assign({}, s[7].dataset), { game: 'other', top: '1' });
  p.win.DSLater.now();
  await p.advance(20000);
  assert.strictEqual(p.scripts().length, 8, 'once');
});

test('Record the whole screen pressed before the recorder is in: DSLater.clip fetches just it, now() never adds it twice', async () => {
  const p = page({});
  p.run(LATER);
  p.win.DSLater.clip();
  assert.deepStrictEqual(p.scripts().map((n) => n.src), ['/js/clip/mp4mux.js', '/js/clip/clipRec.js']);
  assert.deepStrictEqual(Object.assign({}, p.scripts()[1].dataset), { game: 'other', top: '1' });
  p.fire('load');
  await p.advance(600);
  const s = p.scripts().map((n) => n.src);
  assert.strictEqual(s.length, 8, 'the rest, and the recorder only once');
  assert.strictEqual(new Set(s).size, 8);
  // and the switch asks for it, then starts it once it is in (still inside the click's few seconds)
  const tab = HTML.slice(HTML.indexOf('function setClipTab(b){'), HTML.indexOf('async function setMic(b){'));
  assert.match(tab, /else if\(on&&window\.DSLater&&DSLater\.clip\)\{/);
  assert.match(tab, /if\(R&&R\.top\)\{if\(lsGet\('dsClipsTab'\)==='1'\)R\.start\(true\)/);
});

/* needR and cvOnScreen, lifted out of the lobby script with the two bindings they use. */
function rPage(o) {
  const src = HTML.slice(HTML.indexOf('let R=null, R_tried=false;'), HTML.indexOf('/* Which money the server runs on'));
  const ctx = { window: {}, console: { warn() {} }, document: { createElement: () => ({}) }, bg: 0, made: 0 };
  ctx.window.DSLater = { asked: 0, now() { this.asked++; } };
  ctx.DSLater = ctx.window.DSLater;
  vm.createContext(ctx);
  vm.runInContext(src + '\nfunction bgReady(){bg++}\nthis.needR=needR;this.getR=()=>R;', ctx);
  if (o && o.renderer) {
    ctx.HexGrid = function () {};
    ctx.Renderer = function () { ctx.made++; if (o.renderer === 'throws') throw new Error('no gl'); };
  }
  return ctx;
}
const shown = { clientWidth: 300, getClientRects: () => [1] };
const hidden = { clientWidth: 0, getClientRects: () => [] };

test('needR: a canvas with no box on screen never builds R, nor fetches its files', () => {
  const c = rPage({ renderer: true });
  assert.strictEqual(c.needR(hidden), false);
  assert.strictEqual(c.needR({ clientWidth: 300, getClientRects: () => [] }), false, 'display:none inside a sized box');
  assert.strictEqual(c.made, 0);
  assert.strictEqual(c.DSLater.asked, 0);
});

test('needR: a scene on screen before the renderer is in asks DSLater for it now, and asks again next paint', () => {
  const c = rPage();
  assert.strictEqual(c.needR(shown), false);
  assert.strictEqual(c.DSLater.asked, 1);
  c.HexGrid = function () {};
  c.Renderer = function () { c.made++; };
  assert.strictEqual(c.needR(shown), true, 'built once the files are in');
  assert.strictEqual(c.made, 1);
  assert.strictEqual(c.bg, 1, 'and the hex tile repaint is hooked when it is made');
  assert.strictEqual(c.needR(hidden), true, 'built: every canvas paints as before');
  assert.strictEqual(c.made, 1, 'one renderer');
  assert.strictEqual(c.getR()._dpr, 1);
});

test('needR: a renderer that throws is not tried again (the scene keeps its fallback)', () => {
  const c = rPage({ renderer: 'throws' });
  assert.strictEqual(c.needR(shown), false);
  assert.strictEqual(c.needR(shown), false);
  assert.strictEqual(c.made, 1);
  assert.strictEqual(c.getR(), null);
});

test('paintScene and paintSwatch ask needR where they asked for R', () => {
  const scene = HTML.slice(HTML.indexOf('function paintScene(cv,dt){'), HTML.indexOf('const SCENES=new Map();'));
  assert.match(scene, /\n  if\(!needR\(cv\)\)return;\n  fit\(cv\);/);
  const sw = HTML.slice(HTML.indexOf('function paintSwatch(cv){'), HTML.indexOf('function paintSwatch(cv){') + 60);
  assert.match(sw, /^function paintSwatch\(cv\)\{\n  if\(!needR\(cv\)\)return;/);
  assert.ok(!/\n\(function bgReady\(\)\{/.test(HTML), 'bgReady runs when R is made, not once at load against no R');
});

// ── 5. arriving with no session ──────────────────────────────────────────────────────────────────────────────────

test('an invite or a Control join with no session anywhere does not wait for a widget that is not coming', () => {
  const inv = read('public/js/v2/invite.js');
  assert.match(inv, /const ready = \(\) => !!\(window\.duelWallet && window\.duelWallet\.ready\)\n\s+\|\| !!\(window\.DSWalletBoot && window\.DSWalletBoot\.session === false\);/);
  const oj = read('public/js/v2/ownerJoin.js');
  assert.match(oj, /const walletReady = \(\) => !!\(window\.duelWallet && \(window\.duelWallet\.ready \|\| window\.duelWallet\.authenticated\)\)\n\s+\|\| !!\(window\.DSWalletBoot && window\.DSWalletBoot\.session === false\);/);
});
