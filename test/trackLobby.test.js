'use strict';
/* Product tracking in the lobby and the wallet widget (Owen 2026-10-29: "track absolutely everything"). Every event
   here goes through the one plan (shared/trackPlan.js) by way of the lobby's helper (public/js/shared/dsTrack.js):

   - v2.html loads PostHog, the plan and the helper before any lobby script (and before invite.js rewrites /play/<game>),
     after the splash so its first paint waits on none of them.
   - lobby_tab_viewed once per real change of tab, game_card_clicked with where it came from, play_clicked for every
     Play (it replaced the old game_started the lobby used to send for a press), customize_opened, shop_viewed (the
     unlock sheet) and skin_buy_started.
   - Add funds and Withdraw opening, a withdraw that failed (its words, never a figure or an address), and the
     broadcast naming itself 'withdraw' or 'add' to the server.
   - The sign-in funnel in the widget: signin_opened, signed_in (one, a wallet sign-in included), signin_abandoned,
     signin_failed, wallet_setup_failed, wallet_linked.
   - Session replay privacy: the balance, the address and money amounts carry .ph-no-capture.

   play.js, wallet.js and skinBuy.js run for real on stub pages; every event they send is checked against the plan
   with nothing dropped. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').split('\r\n').join('\n');
const PLAN = require('../shared/trackPlan');
const HTML = read('public/v2.html');
const WIDGET = read('wallet-widget/src/main.jsx');
const tick = () => new Promise((r) => setImmediate(r));

/* A stand-in DSTrack that keeps every call, and the check that each one is a planned event with nothing dropped. */
function tracker() {
  const sent = [];
  return { sent, DSTrack: { event: (name, props) => { sent.push({ name, props }); return true; } } };
}
function planned(sent) {
  for (const e of sent) {
    const c = PLAN.clean(e.name, e.props);
    assert.ok(c.ok, e.name + ' is in the plan');
    assert.deepStrictEqual(c.dropped, [], e.name + ' sends only planned properties');
  }
}
const named = (sent, n) => sent.filter((e) => e.name === n).map((e) => PLAN.clean(e.name, e.props).props);

// ── the page ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('v2.html loads PostHog, the plan and the helper in order, after the splash and before every lobby script', () => {
  const body = HTML.slice(HTML.indexOf('</head>\n<body>'));
  const at = (s) => HTML.indexOf(s);
  const init = at('<script src="/js/posthog-init.js" data-no-visit-ping></script>');
  const plan = at('<script src="/shared/trackPlan.js"></script>');
  const helper = at('<script src="/js/shared/dsTrack.js"></script>');
  assert.ok(init > 0 && init < plan && plan < helper, 'posthog-init.js, then trackPlan.js, then dsTrack.js');
  assert.ok(init > at('window.dsSplashDone=hide;'), 'after the splash script: its first paint waits on none of them');
  assert.ok(helper < at('<link href="https://fonts.googleapis.com/css2'), 'and before the stylesheets, so they never wait on them');
  const scripts = [...body.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(scripts.slice(0, 3), ['/js/posthog-init.js', '/shared/trackPlan.js', '/js/shared/dsTrack.js'],
    'the first three scripts on the page');
  assert.ok(scripts.indexOf('/js/v2/invite.js') > 3, 'so before every lobby script, and before invite.js turns /play/<game> back into /');
  assert.ok(!/<script/.test(HTML.slice(0, HTML.indexOf('</head>'))), '<head> still loads no script at all');
  assert.strictEqual(HTML.split('/js/posthog-init.js').length - 1, 1, 'PostHog once');
});

// ── the lobby's own events ───────────────────────────────────────────────────────────────────────────────────────

function fnBody(src, sig) {
  const a = src.indexOf(sig);
  assert.ok(a >= 0, sig);
  let d = 0;
  for (let i = src.indexOf('{', a); i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}' && --d === 0) return src.slice(a, i + 1);
  }
  throw new Error('unbalanced ' + sig);
}

test('lobby_tab_viewed: once per real change of tab, the first one on load included', () => {
  const t = tracker();
  const box = { DSTrack: t.DSTrack };
  box.window = box;
  vm.createContext(box);
  vm.runInContext("let _tabSeen='';\n" + fnBody(HTML, 'function tabViewed(tab){') + '\nthis.tabViewed=tabViewed;', box);
  for (const tab of ['play', 'play', 'wallet', 'wallet', 'events', 'play', '', null]) box.tabViewed(tab);
  assert.deepStrictEqual(t.sent.map((e) => e.props.tab), ['play', 'wallet', 'events', 'play']);
  planned(t.sent);
  // where it is called from: the tap router, the swipe's commit, every way back to Home, and the first tab on load
  assert.match(fnBody(HTML, 'function go(id,dir){'), /route=id; drawNav\(\); tabViewed\(id\);/);
  assert.match(fnBody(HTML, 'function commitScreen(tab){'), /route=tab; drawNav\(\); tabViewed\(tab\);/);
  assert.match(HTML, /function navHome\(\)\{if\(route!=='play'\)\{route='play';drawNav\(\);\}tabViewed\('play'\)\}/);
  const first = HTML.indexOf('tabViewed(route);');
  assert.ok(first > 0 && first < HTML.indexOf('<script>window.dsSplashDone&&dsSplashDone()</script>'), 'the first tab, once the lobby is built');
  assert.ok(!/tabViewed/.test(fnBody(HTML, 'function drawNav(){')), 'never from a re-render');
});

test('game_card_clicked names the game and where it was opened from', () => {
  const open = fnBody(HTML, 'function open_(id){');
  assert.match(open, /DSTrack\.event\('game_card_clicked',\{game:\(window\.DSTrackPlan&&DSTrackPlan\.game\(id\)\)\|\|undefined,where\}\)/);
  assert.match(open, /typeof arguments\[1\]==='string'\?arguments\[1\]:\(from&&from\.id==='allgames'\)\?'all_games':'home'/);
  assert.match(fnBody(HTML, 'function flipGame(dir){'), /open_\(n\.id,'swipe'\)/);
  assert.match(HTML, /if\(g\)open_\(g\.dataset\.game,'sidebar'\);/);
  assert.match(read('public/js/v2/invite.js'), /window\.open_\(g\.game, 'invite'\)/);
  // the lobby's ids fold into the plan's (snake is slither, omgshooter is shooter)
  assert.strictEqual(PLAN.game('snake'), 'slither');
  assert.strictEqual(PLAN.game('omgshooter'), 'shooter');
  for (const where of ['home', 'all_games', 'sidebar', 'swipe', 'invite']) planned([{ name: 'game_card_clicked', props: { game: 'snake', where } }]);
});

test('Customize, the unlock sheet and the sign-in buttons say what they are', () => {
  assert.match(fnBody(HTML, 'function openLook(){'), /if\(!hasLook\(cur\)\)return;\n  if\(window\.DSTrack\)DSTrack\.event\('customize_opened',\{game:cur\.id\}\);/);
  assert.match(fnBody(HTML, 'function openBuy(s){'), /DSTrack\.event\('shop_viewed',\{tab:'unlock',game:s\.game\}\)/);
  assert.match(fnBody(HTML, 'async function confirmBuy(){'), /window\.duelWalletLogin\('skin_buy'\)/);
  assert.match(HTML, /window\.duelWalletLogin\('settings'\)/);
  assert.match(read('public/js/v2/clips.js'), /window\.duelWalletLogin\('clips'\)/);
  planned([{ name: 'customize_opened', props: { game: 'snake' } }, { name: 'shop_viewed', props: { tab: 'unlock', game: 'agar' } }]);
});

test('invite.js and support.js send through DSTrack, nothing calls the old phEvent', () => {
  const inv = read('public/js/v2/invite.js'), sup = read('public/js/v2/support.js');
  assert.match(inv, /window\.DSTrack\.event\('invite_copied', \{ game: id \}\)/);
  assert.match(inv, /window\.DSTrack\.event\('invite_opened', \{ game: g\.game \}\)/);
  assert.match(inv, /window\.DSTrack\.event\('invite_copied', \{\}\)/, 'Refer a friend names no game');
  assert.match(sup, /window\.DSTrack\.event\('support', \{ action: action \}\)/);
  for (const f of fs.readdirSync(path.join(ROOT, 'public/js/v2')).filter((n) => n.endsWith('.js'))) {
    assert.ok(!/phEvent\(/.test(read('public/js/v2/' + f)), f + ' sends nothing through phEvent');
  }
  assert.ok(!/phEvent\(/.test(HTML) && !/phEvent\(/.test(WIDGET), 'nor the lobby page or the widget');
});

// ── Play ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function lobby(o) {
  const t = tracker();
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: { display: '' }, value: '', textContent: '', hidden: true, focus() {},
    classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, contentWindow: { focus() {} } });
  el('play-name').value = 'Tester1';
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const plays = [];
  const win = {
    console, setTimeout: () => 0, clearTimeout() {}, localStorage: store(), sessionStorage: store(),
    document: { getElementById: el, addEventListener() {}, readyState: 'complete', activeElement: null,
      body: { classList: { add() {}, remove() {} } }, createElement: () => ({ style: {}, classList: { add() {} } }) },
    addEventListener() {}, MutationObserver: class { observe() {} },
    CustomEvent: class { constructor(type, i) { this.type = type; this.detail = i && i.detail; } },
    dispatchEvent: (e) => { plays.push(e.detail); return true; },
    duelWalletLogin() {}, rememberStake() {}, V2_HAS_LADDER: () => true,
    V2Board: { lobbies: o.lobbies || [], load() {} },
    DSTrack: t.DSTrack,
  };
  if (o.wallet) win.duelWallet = { ready: true, authenticated: true, address: 'WALLET1' };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('public/js/v2/play.js'), win, { filename: 'play.js' });
  return { win, sent: t.sent, plays, el };
}

test('play_clicked: one per Play, free or paid, guest or not, with the mode and the engine; never game_started', () => {
  const SL_FREE = { id: 'sl:na:s0', game: 'snake', stake: 0, state: 'open' };
  const SL_PAID = { id: 'sl:na:s0.5', game: 'snake', stake: 0.5, state: 'open' };
  const free = lobby({ wallet: true, lobbies: [SL_FREE, SL_PAID] });
  free.win.V2Play.enter(SL_FREE);
  assert.deepStrictEqual(named(free.sent, 'play_clicked'), [{ game: 'slither', paid: false, stake: 0, mode: 'free', guest: false, engine: 'sl' }]);

  const paid = lobby({ wallet: true, lobbies: [SL_FREE, SL_PAID] });
  paid.win.V2Play.enter(SL_PAID);
  assert.strictEqual(paid.plays.length, 1, 'the widget is still asked to stake');
  assert.deepStrictEqual(named(paid.sent, 'play_clicked'), [{ game: 'slither', paid: true, stake: 0.5, mode: 'paid', guest: false, engine: 'sl' }]);

  const duel = lobby({ wallet: true });
  duel.win.V2Play.enter({ game: 'knockout', lobbyType: 'free' });
  assert.deepStrictEqual(named(duel.sent, 'play_clicked'), [{ game: 'knockout', paid: false, mode: 'free', guest: false }]);

  const guest = lobby({});
  guest.win.V2Play.enter({ game: 'paper', stake: 0 });
  assert.deepStrictEqual(named(guest.sent, 'play_clicked'), [{ game: 'paper', paid: false, stake: 0, mode: 'free', guest: true }]);

  const all = [...free.sent, ...paid.sent, ...duel.sent, ...guest.sent];
  assert.ok(!all.some((e) => e.name === 'game_started'), 'the start itself is the game page\'s (or the server\'s)');
  planned(all);
  assert.ok(!all.some((e) => /Tester1|WALLET1/.test(JSON.stringify(e.props))), 'never the name typed or the wallet');
});

// ── the Wallet tab ───────────────────────────────────────────────────────────────────────────────────────────────

const ADDR = '7xKpAbCdEfGhJkLmNpQrStUvWxYz123456789abcdef';
const TO = 'So11111111111111111111111111111111111111112';
function walletPage(w, extra) {
  const t = tracker();
  const els = {};
  const el = (id) => (els[id] = els[id] || (() => {
    const cls = new Set();
    return { id, innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, hidden: false,
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) },
      setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; }, insertAdjacentHTML() {} };
  })());
  const on = {};
  const win = Object.assign({
    console, setTimeout, clearTimeout, Math, Number, String, Date, Promise, JSON, Object, Array, isFinite, parseFloat,
    document: { getElementById: el, querySelector: () => null, addEventListener() {}, visibilityState: 'visible', body: { classList: { toggle() {} } } },
    getComputedStyle: () => ({ display: 'block' }),
    localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; })(),
    navigator: {}, location: { origin: 'https://duelseries.com' },
    addEventListener(type, fn) { (on[type] = on[type] || []).push(fn); },
    dispatchEvent(e) { (on[e.type] || []).forEach((fn) => fn(e)); },
    fetch: async () => ({ ok: true, json: async () => ({ transactions: [], transfers: [], complete: true }) }),
    DSToast: { show() { return { update() {} }; }, expectRise() { return () => {}; } },
    V2Play: { toast() {} },
    duelWalletFund: async () => {},
    duelWalletSend: async () => { throw new Error('Transfer: insufficient lamports 1000, need 2500 from ' + ADDR); },
    duelWalletRefresh: async () => {},
    duelWalletLinkedBalance: async () => ({ sol: 1, lamports: 1e9, max: 9e8 }),
    DSTrack: t.DSTrack,
  }, extra || {});
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('public/js/v2/wallet.js'), win, { filename: 'public/js/v2/wallet.js' });
  win.duelWallet = Object.assign({ ready: true, authenticated: true, address: ADDR }, w);
  win.dispatchEvent({ type: 'duelwallet:change' });
  return { win, el, sent: t.sent, body: () => els['w-body'].innerHTML };
}
const SOL = { mode: 'sol', unit: 'USD', balance: 15, sol: 0.1, solUsd: 150, usdc: 12.34, swap: { solReserve: 0.005, minConvertSol: 0.02, minWithdrawSolUsd: 1 } };

test('Add funds and Withdraw opening, and a failed withdraw as words only (no figure, no address)', async () => {
  const p = walletPage(SOL);
  p.win.V2Wallet.fund();
  p.win.V2Wallet.cashOut();
  p.win.V2Wallet.cancelCash();
  p.win.V2Wallet.cashOut('usdc');
  p.win.V2Wallet.cancelCash();
  assert.deepStrictEqual(named(p.sent, 'add_funds_opened'), [{ where: 'wallet', method: 'any' }], 'Privy\'s sheet with every option');
  assert.deepStrictEqual(named(p.sent, 'withdraw_opened'), [{ where: 'wallet' }, { where: 'usdc_line' }]);

  p.win.V2Wallet.cashOut();
  p.el('co-to').value = TO; p.el('co-amt').value = '0.05';
  p.win.V2Wallet.submitCash();
  p.win.V2Wallet.confirmCash();
  await tick(); await tick();
  assert.deepStrictEqual(named(p.sent, 'withdraw_failed'), [{ error: 'Transfer: insufficient lamports #, need # from …', asset: 'sol' }]);

  // the linked wallet's own Add funds sheet
  const L = walletPage(Object.assign({}, SOL, { linked: { address: TO, name: 'Phantom', here: true } }), { sheetFocus: { open() {}, close() {} } });
  L.win.V2Wallet.addFromWallet();
  assert.deepStrictEqual(named(L.sent, 'add_funds_opened'), [{ where: 'wallet', method: 'linked' }]);
  planned([...p.sent, ...L.sent]);
  assert.ok(![...p.sent, ...L.sent].some((e) => JSON.stringify(e.props).includes(ADDR) || JSON.stringify(e.props).includes(TO)), 'never an address');
});

test('a Sign in from the header and from the Wallet tab say where they were pressed', () => {
  const asked = [];
  const p = walletPage({ ready: true, authenticated: false, address: null }, { duelWalletLogin: (w) => asked.push(w) });
  p.win.V2Wallet.headerTap();
  p.win.V2Wallet.login();
  assert.deepStrictEqual(asked, ['header', 'wallet']);
});

test('session replays never show the balance, an address or a money amount (.ph-no-capture)', () => {
  const p = walletPage(SOL);
  const b = p.body();
  assert.match(b, /class="bnum num ph-no-capture" id="w-bal" data-cu>/, 'the balance');
  assert.match(b, /class="wsol ph-no-capture" id="w-sol">/, 'the SOL under it');
  assert.match(b, /<span class="ph-no-capture">You have <b class="num">\$12\.34<\/b> USDC<\/span>/, 'old USDC');
  assert.match(b, /<code class="ph-no-capture" title="7xKp/, 'the address (the title holds all of it: a blocked element records no attribute)');
  const w = read('public/js/v2/wallet.js');
  for (const s of ['<a class="tx ph-no-capture" href="https://solscan.io/tx/', '<div class="tx mv ph-no-capture">', '<code class="cofull ph-no-capture">',
    '<p class="note ph-no-capture" id="co-msg"></p>', '<p class="note ph-no-capture" id="ad-have"></p>', '<ul class="cvfacts ph-no-capture">',
    '<div class="mfig ph-no-capture"><div class="v num" id="ad-fig">']) assert.ok(w.includes(s), s);
  for (const id of ['hdr-balance', 'meaddr', 'bs-bal', 'bs-after', 'bs-msg']) {
    assert.match(HTML, new RegExp('class="[^"]*\\bph-no-capture\\b[^"]*" id="' + id + '"'), id);
  }
  assert.match(HTML, /<div id="s-body" class="ph-no-capture"><\/div>/, 'the earnings chart');
  assert.match(HTML, /m\.className='bs-msg ph-no-capture'/, 'the buy sheet\'s message keeps it when its state changes');
  assert.match(read('public/js/v2/toasts.js'), /part\('t-amt ph-no-capture', o\.amount\); part\('ph-no-capture', o\.detail\); part\('t-addr ph-no-capture', o\.code\);/);
  assert.match(read('public/js/posthog-init.js'), /maskTextSelector: '\.ph-no-capture, #privy-dialog, \[id\^="privy-"\]'/, 'and Privy\'s sign-in window');
});

// ── skins ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('skin_buy_started when Buy is pressed, before any money step; a fault in it never stops the purchase', async () => {
  const { createSkinBuy } = require('../public/js/v2/skinBuy.js');
  const seen = [];
  const order = [];
  const ui = createSkinBuy({
    fetch: async (u) => { order.push(u); return { status: 400, json: async () => ({ error: 'stop here' }) }; },
    storage: { getItem: () => null, setItem() {}, removeItem() {} }, wallet: () => ({ address: 'W' }),
    signSkin: async () => 'x', signAction: async () => null,
    onBuy: (g, s, price) => { order.push('onBuy'); seen.push([g, s, price]); },
  });
  await assert.rejects(ui.buy('snake', 'candy', null, 1.5), /stop here/);
  assert.deepStrictEqual(seen, [['snake', 'candy', 1.5]]);
  assert.strictEqual(order[0], 'onBuy', 'before the intent is asked for');
  const bad = createSkinBuy({
    fetch: async () => ({ status: 400, json: async () => ({ error: 'still asked' }) }),
    storage: { getItem: () => null, setItem() {}, removeItem() {} }, wallet: () => ({ address: 'W' }),
    onBuy: () => { throw new Error('analytics down'); },
  });
  await assert.rejects(bad.buy('agar', 'x', null, 1), /still asked/);
  assert.match(read('public/js/v2/skinBuy.js'), /root\.DSTrack\.event\('skin_buy_started', \{ game: game, item: skin, price: price \}\)/);
  planned([{ name: 'skin_buy_started', props: { game: 'snake', item: 'candy', price: 1.5 } }]);
});

// ── the widget: signing in, linking, and the broadcast naming itself ─────────────────────────────────────────────

function signinHelpers() {
  const t = tracker();
  const a = WIDGET.indexOf('const SIGNIN_METHOD = ');
  const b = WIDGET.indexOf('function WalletPanel() {');
  assert.ok(a > 0 && b > a, 'the helpers sit above the panel');
  const box = { window: { DSTrack: t.DSTrack }, WALLETS: [{ client: 'phantom', label: 'Phantom' }, { client: 'solflare', label: 'Solflare' }], String };
  vm.createContext(box);
  vm.runInContext(WIDGET.slice(a, b) + '\nthis.h = { signinOpened, signedInEvent, signinErrorEvent };', box);
  return { h: box.h, sent: t.sent };
}

test('the sign-in funnel: opened (with where), one signed_in per sign-in, abandoned or failed', () => {
  const { h, sent } = signinHelpers();
  h.signinOpened('header');
  h.signinOpened({ type: 'click' });                                 // an event object is not a where
  h.signedInEvent('google', true, { type: 'google_oauth', email: 'x@y.z' });
  h.signedInEvent('email', false, { type: 'email', address: 'x@y.z' });
  h.signedInEvent('siws', true, { type: 'wallet', walletClientType: 'phantom', address: ADDR });
  h.signinErrorEvent('exited_auth_flow');
  h.signinErrorEvent('oauth_user_denied');
  h.signinErrorEvent('client_request_timeout');
  assert.deepStrictEqual(named(sent, 'signin_opened'), [{ where: 'header' }, {}]);
  assert.deepStrictEqual(named(sent, 'signed_in'), [
    { method: 'google', new_user: true }, { method: 'email', new_user: false }, { method: 'wallet', new_user: true, wallet_app: 'Phantom' }]);
  assert.deepStrictEqual(named(sent, 'signin_abandoned'), [{ step: 'privy' }, { step: 'oauth' }]);
  assert.deepStrictEqual(named(sent, 'signin_failed'), [{ step: 'privy', error: 'client_request_timeout' }]);
  planned(sent);
  assert.ok(!sent.some((e) => /x@y\.z|7xKp/.test(JSON.stringify(e.props))), 'never an email or an address');
});

test('the widget wires the funnel in, keeps one signed_in, and names its broadcasts', () => {
  assert.match(WIDGET, /onComplete: \(\{ isNewUser, loginMethod, loginAccount, wasAlreadyAuthenticated \}\) => \{\n\s*if \(!wasAlreadyAuthenticated\) signedInEvent\(loginMethod, isNewUser, loginAccount\);/);
  assert.match(WIDGET, /onError: \(code\) => signinErrorEvent\(code\),/);
  assert.match(WIDGET, /const signIn = async \(where\) => \{/);
  assert.match(WIDGET, /if \(!p\.authenticated\) signinOpened\(where\);\n\s*if \(p\.authenticated\) \{ if \(!solanaAddress\(p\.user\)\) setUpWallet\(\); return; \}\s*p\.login\(\);/);
  assert.match(WIDGET, /signinOpened\(where\);\n\s*try \{ if \(window\.DSTrack\) window\.DSTrack\.event\('signin_failed', \{ step: 'loading', error: 'privy_not_ready' \}\); \} catch \(_\) \{\}/);
  assert.match(WIDGET, /window\.DSTrack\.event\('signin_abandoned', \{ step: 'wallet_setup' \}\)/);
  assert.match(WIDGET, /window\.DSTrack\.event\('wallet_setup_failed', \{ error: errWords\(/);
  assert.match(WIDGET, /window\.DSTrack\.event\('wallet_linked', \{ wallet_app: k\.label \}\)/);
  assert.ok(!/wallet_signin/.test(WIDGET), 'a wallet sign-in is one signed_in, not a second event');
  assert.match(WIDGET, /if \(want && !authenticated\) signIn\('wallet_app'\);/);
  assert.strictEqual(WIDGET.split("JSON.stringify({ signedTx, kind: 'withdraw' })").length - 1, 2, 'sendSol and sendUsdc');
  assert.match(WIDGET, /JSON\.stringify\(\{ signedTx: Buffer\.from\(signedTransaction\)\.toString\('base64'\), kind: 'add' \}\)/, 'the linked-wallet add');
  assert.strictEqual(WIDGET.split('/api/broadcast').length - 1, 3, 'and no other broadcast');
  // the server reads exactly those two words (server/index.js trackBroadcast)
  assert.match(read('server/index.js'), /if \(kind !== 'withdraw' && kind !== 'add'\) return;/);
  const built = fs.readFileSync(path.join(ROOT, 'public/wallet/widget.js'), 'utf8');
  for (const s of ['signin_opened', 'signin_abandoned', 'wallet_setup_failed', 'kind:`withdraw`', 'kind:`add`']) assert.ok(built.includes(s), 'the built widget has ' + s);
  assert.ok(!built.includes('wallet_signin'), 'and is rebuilt from this source');
});
