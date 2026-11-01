'use strict';
/* Link previews, invites and the score card (the "get players first" push, 2026-10-26):
   shared/shareGames.js, server/sharePreview.js, public/js/v2/invite.js, public/js/shared/dsShare.js and the
   dsEnd Share pill. Everything shared leaves the site, so the words are pinned to free play: no money, ever. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SHARE = require('../shared/shareGames');
const SP = require('../server/sharePreview');
const { isLocked } = require('../shared/lockedGames');

// Words that must never appear in anything shared: money, stakes, winnings, crypto.
const MONEY = /\$|\bstakes?\b|\bbuy-?ins?\b|\bcash\b|cash.?out|\bwin(?:nings|ners?)?\b|\bprize|\bmoney\b|\bSOL\b|USDC|crypto|\bwallet\b|\bbet\b|wager|earn/i;

function allWords() {
  const out = [SHARE.HOME.title, SHARE.HOME.blurb];
  for (const g of SHARE.GAMES) out.push(g.name, g.blurb);
  return out;
}

test('shareGames: every game names a lobby game, a slug, an accent, a 1200 x 630 jpg that exists, and free words only', () => {
  const v2 = read('public/v2.html');
  const seen = new Set();
  for (const g of SHARE.GAMES) {
    assert.match(g.slug, /^[a-z]+$/, g.slug);
    assert.ok(!seen.has(g.slug), 'one slug once: ' + g.slug);
    seen.add(g.slug);
    assert.ok(v2.includes("{id:'" + g.game + "'"), 'a lobby game: ' + g.game);
    assert.match(g.accent, /^#[0-9a-f]{6}$/i);
    assert.strictEqual(SHARE.bySlug(g.slug), g);
    assert.strictEqual(SHARE.byGame(g.game), g);
  }
  for (const img of SHARE.GAMES.map((g) => g.image).concat([SHARE.HOME.image])) {
    const buf = fs.readFileSync(path.join(ROOT, 'public', img));
    assert.strictEqual(buf.readUInt16BE(0), 0xffd8, img + ' is a jpeg');
    // the frame size from the first SOFn marker
    let i = 2, w = 0, h = 0;
    while (i < buf.length) {
      const m = buf.readUInt16BE(i);
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xffc0 && m <= 0xffc3) { h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break; }
      i += 2 + len;
    }
    assert.deepStrictEqual([w, h], [SHARE.IMAGE_W, SHARE.IMAGE_H], img + ' is 1200 x 630');
    assert.ok(buf.length < 200 * 1024, img + ' stays small for a crawler');
  }
  for (const s of allWords()) assert.doesNotMatch(s, MONEY, 'free words only: ' + s);
  assert.strictEqual(SHARE.bySlug('nope'), null);
});

test('the lobby head: the marked block is the free home preview, with a large card and absolute images', () => {
  const html = read('public/v2.html');
  const a = html.indexOf(SP.MARK_OPEN), b = html.indexOf(SP.MARK_CLOSE);
  assert.ok(a > 0 && b > a, 'both marks, in order');
  assert.strictEqual(html.indexOf(SP.MARK_OPEN, a + 1), -1, 'one block');
  const block = html.slice(a, b);
  assert.ok(block.includes('<title>' + SHARE.HOME.title + '</title>'), 'the site\'s name and what it is, for search');
  assert.ok(block.includes('<link rel="canonical" href="https://duelseries.com/">'), 'the lobby\'s one address');
  assert.ok(block.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.ok(block.includes('<meta property="og:image" content="https://duelseries.com/og/home.jpg">'));
  const content = [...block.matchAll(/content="([^"]*)"/g)].map((m) => m[1]);
  for (const c of content) assert.doesNotMatch(c, MONEY, 'free words only: ' + c);
  assert.ok(!/free or for/.test(html), 'the old money description is gone');
});

test('originOf: only our own hosts and a local box are believed', () => {
  const o = (host) => SP.originOf({ headers: { host } });
  assert.strictEqual(o('duelseries.com'), 'https://duelseries.com');
  assert.strictEqual(o('eu.duelseries.com'), 'https://eu.duelseries.com');
  assert.strictEqual(o('localhost:4409'), 'http://localhost:4409');
  assert.strictEqual(o('evil.com'), 'https://duelseries.com');
  assert.strictEqual(o('duelseries.com.evil.com'), 'https://duelseries.com');
  assert.strictEqual(o('a"><script>x</script>'), 'https://duelseries.com');
  assert.strictEqual(o(''), 'https://duelseries.com');
});

function fakeRes() {
  const r = { status: 200, headers: {}, body: null, redirected: null };
  r.redirect = (code, to) => { r.status = code; r.redirected = to; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.type = (t) => { r.headers['Content-Type'] = t; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}

test('/play/<slug>: the lobby with that game\'s preview; an unknown or locked game goes home', () => {
  const route = SP.playRoute();
  for (const g of SHARE.GAMES) {
    const res = fakeRes();
    route({ params: { slug: g.slug }, headers: { host: 'eu.duelseries.com' } }, res);
    if (isLocked(g.game)) { assert.strictEqual(res.redirected, '/'); continue; }
    assert.strictEqual(res.status, 200, g.slug);
    const html = res.body;
    assert.ok(html.includes('<title>Play ' + g.name + ' with me on DuelSeries</title>'), g.slug);
    assert.ok(html.includes('<meta property="og:url" content="https://eu.duelseries.com/play/' + g.slug + '">'));
    assert.ok(html.includes('<meta property="og:image" content="https://eu.duelseries.com' + g.image + '">'));
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
    assert.strictEqual((html.match(/<title>/g) || []).length, 1, 'one title');
    assert.strictEqual((html.match(/property="og:title"/g) || []).length, 1, 'one og:title');
    assert.ok(html.includes('<script src="/js/v2/invite.js"></script>'), 'the rest is the lobby');
    // its canonical is the game's own page on the main site (server/gamePages.js), whichever server answered
    assert.strictEqual((html.match(/rel="canonical"/g) || []).length, 1, 'one canonical');
    assert.ok(html.includes('<link rel="canonical" href="https://duelseries.com/games/' + require('../server/gamePageData').byShare(g.slug).page + '">'), g.slug);
  }
  for (const slug of ['nope', '', 'SNAKE', '..']) {
    const res = fakeRes();
    route({ params: { slug }, headers: {} }, res);
    if (slug === 'SNAKE') { assert.strictEqual(res.status, 200, 'a slug is read in lower case'); continue; }
    assert.deepStrictEqual([res.status, res.redirected], [302, '/'], slug);
  }
  // and a Coming soon game goes home too, asked on every visit (server/comingSoon.js, test/comingSoon.test.js)
  assert.ok(read('server/index.js').includes(
    "app.get('/play/:slug', require('./sharePreview').playRoute({ isSoon: (id) => comingSoon.isSoon(id) }));"));
});

test('withMeta: the marked block only, and a page without marks is sent unchanged', () => {
  const page = '<head>' + SP.MARK_OPEN + '<title>x</title>' + SP.MARK_CLOSE + '<link></head>';
  assert.strictEqual(SP.withMeta(page, 'NEW'), '<head>NEW<link></head>');
  assert.strictEqual(SP.withMeta('<head></head>', 'NEW'), '<head></head>');
  const g = SHARE.GAMES[0];
  assert.ok(SP.gameMeta(Object.assign({}, g, { name: '<b>"x"</b>' }), 'https://duelseries.com').includes('&lt;b&gt;&quot;x&quot;&lt;/b&gt;'), 'escaped');
});

test('the lobby: no Invite a friend button (Owen 2026-10-27), and invite.js after the play module', () => {
  const html = read('public/v2.html');
  assert.ok(!html.includes('id="invbtn"') && !/\.invite\{/.test(html), 'the panel is stake rows, Play, Spectate, Customize');
  const shareAt = html.indexOf('<script src="/shared/shareGames.js"></script>');
  const invAt = html.indexOf('<script src="/js/v2/invite.js"></script>');
  assert.ok(html.indexOf('<script src="/js/v2/play.js"></script>') < shareAt && shareAt < invAt);
  const inv = read('public/js/v2/invite.js');
  assert.ok(inv.includes("location.origin + '/play/' + g.slug"), 'the invite is on this server');
  assert.ok(inv.includes('STEPS.indexOf(0)'), 'an arrival picks the Free rung');
  assert.doesNotMatch(inv.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /stake\s*:\s*[^0]/, 'never a paid stake');
});

test('dsShare: the words and the sheet say nothing about money; the picture is 1200 x 630', () => {
  const src = read('public/js/shared/dsShare.js');
  const strings = [...src.replace(/^\s*\/\/.*$/gm, '').matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'/g)].map((m) => m[1])
    .filter((s) => /[a-z]{3}/i.test(s) && !/[{}:;]/.test(s));
  for (const s of strings) assert.doesNotMatch(s, MONEY, 'free words only: ' + s);
  assert.match(src, /var W = 1200, H = 630;/);
  // the words that go with a score
  const win = { document: {}, DS_SHARE: SHARE, location: { origin: 'https://duelseries.com' } };
  new Function('window', src.replace(/\}\)\(typeof window !== 'undefined' \? window : null\);\s*$/, '})(window);'))(win);
  assert.strictEqual(win.DSShare.text({ game: 'snake', hero: '1,284', unit: 'length' }),
    'I got 1,284 length in Snake on DuelSeries. Can you beat it?');
  assert.strictEqual(win.DSShare.link('agar'), 'https://duelseries.com/play/cells');
  assert.strictEqual(win.DSShare.link('nope'), null);
});

test('the Share pill: free cards only, in all three .io games, beside the one row of buttons', () => {
  const end = read('public/js/shared/dsEnd.js');
  assert.ok(end.includes("if (o.share && typeof o.share.onClick === 'function') panel.appendChild(shareNode(o.share));"));
  assert.ok(end.includes("addScript('/js/shared/dsShare.js')"), 'the sheet loads on the first press');
  const sl = read('public/js/slx/slxCard.js');
  assert.match(sl, /function freeDeath\(\) \{\s*return shown === 'dead' && lifeCard && !extra && score !== null && !slx\.br && !\(slx\.paid && slx\.paid\.on === true\) &&\s*paidRung\(\) === 0/);
  const paper = read('public/js/paper/mp/paperArenaMain.js');
  assert.ok(paper.includes("if (page.stake > 0 || typeof DSEnd.share !== 'function') return null;"), 'never a paid Paper table');
  const ag = read('public/js/ag/agScreens.js');
  assert.ok(ag.includes("if (api.kind === 'free' && typeof D.share === 'function') {"), 'the free agar.io card only');
  const chomp = read('public/js/chomp/chompMain.js');
  assert.ok(chomp.includes("share: paidMode || typeof window.DSEnd.share !== 'function' ? null : { onClick: function () {"), 'never a paid Chomp page');
});

/* ── Play for money from a game's page (review 2026-11-01) ── invite.js run in a vm, on a clock of its own. A paid
   rung is always picked on purpose (Owen, 2026-10-10): the link lands on Free, outlines the open paid rungs once the
   board says which, toasts which to pick, and presses nothing. */
function arrival(search, o) {
  o = o || {};
  const vm = require('vm');
  let now = 0;
  const timers = [];
  const listeners = {};
  const picks = [], opened = [], toasts = [], started = [];
  const cls = new Set();
  const stakes = { classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) }, scrollIntoView() {} };
  const win = {
    DS_SHARE: SHARE, console, Number, Set, URLSearchParams, Date: { now: () => now },
    location: { pathname: '/play/headsoccer', search, hash: '', origin: 'https://duelseries.com' },
    history: { state: null, replaceState(_s, _t, url) { win.location.search = ''; win.replaced = url; } },
    document: { readyState: 'complete', title: '', getElementById: (id) => (id === 'stakes' ? stakes : null),
      addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); } },
    addEventListener() {}, removeEventListener() {},
    setTimeout: (f, ms) => { timers.push({ at: now + (ms || 0), f }); return timers.length; },
    STEPS: [0, 0.5, 1], STEPS_OFF: new Set([0.5, 1]),
    open_: (g, where) => opened.push([g, where]),
    pickStake: (i) => picks.push(win.STEPS[i]),
    startFromDetail: () => started.push(1),
    V2Detail: { game: 'headsoccer', get stake() { return picks.length ? picks[picks.length - 1] : null; } },
    V2Board: { lobbies: [] },
    DSToast: { show: (t) => toasts.push(t) },
    DSWalletBoot: { session: false },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('public/js/v2/invite.js'), win);
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > until) break;
      timers.shift(); now = t.at; t.f();
    }
    now = until;
  };
  return { win, picks, opened, toasts, started, cls, advance, tap: () => (listeners.pointerdown || []).forEach((f) => f()) };
}

test('Play for money from a game page lands on Free, presses nothing, and points at the paid rungs once they open', () => {
  const a = arrival('?from=page&pick=1');
  a.advance(1);
  assert.deepStrictEqual(a.opened, [['headsoccer', 'landing']]);
  assert.strictEqual(a.win.replaced, '/', 'the marks come off the address');
  assert.deepStrictEqual(a.picks, [0], 'Free, never a paid rung');
  a.advance(500);
  assert.strictEqual(a.toasts.length, 0, 'waits for the board before naming amounts');
  // the board answers: v2.html restep un-strikes both paid rungs
  a.win.V2Board.lobbies = [{ game: 'headsoccer' }];
  a.win.STEPS_OFF = new Set();
  a.advance(200);
  assert.deepStrictEqual(a.picks, [0], 'still Free');
  assert.deepStrictEqual(a.toasts.map((t) => t.title), ['Pick $0.50 or $1 to play for money']);
  assert.ok(a.cls.has('hint'), 'the open paid rungs are outlined');
  a.advance(20000);
  assert.strictEqual(a.started.length, 0, 'Play is never pressed for them');
  assert.ok(!a.cls.has('hint'), 'the outline goes by itself');
});

test('Play for money: only the open paid rungs are named, none open says so, and a first tap clears the outline', () => {
  const a = arrival('?from=page&pick=1');
  a.win.V2Board.lobbies = [{ game: 'headsoccer' }];
  a.win.STEPS_OFF = new Set([0.5]);
  a.advance(300);
  assert.deepStrictEqual(a.toasts.map((t) => t.title), ['Pick $1 to play for money']);
  a.tap();
  assert.ok(!a.cls.has('hint'));
  const b = arrival('?from=page&pick=1');
  b.advance(5000);   // the board never answers: every paid rung stays struck
  assert.deepStrictEqual(b.toasts.map((t) => t.title), ['No paid tables open right now']);
  assert.ok(!b.cls.has('hint'));
  assert.deepStrictEqual(b.picks, [0]);
});

test('pick=1 without the page mark is an invite: Free, and Play is pressed for them as before', () => {
  const a = arrival('?pick=1');
  a.advance(10);
  assert.deepStrictEqual(a.opened, [['headsoccer', 'invite']]);
  assert.deepStrictEqual(a.picks, [0]);
  assert.strictEqual(a.started.length, 1, 'no session in this browser: straight to the free table');
  assert.strictEqual(a.toasts.length, 0);
});

/* restep (v2.html): the board's answer re-strikes the rungs of a game screen opened before it came. */
test('a game screen opened before /api/live answered un-strikes its paid rungs when the board does', () => {
  const vm = require('vm');
  const html = read('public/v2.html').replace(/\r\n/g, '\n');
  const from = html.indexOf('let STEPS=[0];');
  const to = html.indexOf('/* The buy-in you last played');
  const re = html.slice(html.indexOf('function restep(){'), html.indexOf('function pickStake(i){'));
  assert.ok(from > 0 && to > from && re.length > 20);
  let open = false;
  const ctx = { Set, Math, draws: 0, DS_LADDER: { LADDER: [0, 0.5, 1] }, V2Board: { duelPaidOpen: () => open } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(html.slice(from, to) + re + `
    let si=0, cur={id:'headsoccer'};
    const G=id=>({id,paid:1,duel:1});
    function drawStake(){draws++}
    this.go=()=>{refreshSteps(cur.id);};
    this.restep=restep; this.off=()=>JSON.stringify([...STEPS_OFF]); this.si=()=>si;`, ctx);
  ctx.go();
  assert.strictEqual(ctx.off(), "[0.5,1]", 'no answer yet: struck');
  ctx.restep();
  assert.strictEqual(ctx.draws, 0, 'nothing changed, nothing redrawn');
  open = true;
  ctx.restep();
  assert.strictEqual(ctx.off(), "[]", 'the answer opens them');
  assert.strictEqual(ctx.draws, 1, 'and the row is redrawn');
  assert.strictEqual(ctx.si(), 0, 'still on Free: an open rung is never picked for them');
});
