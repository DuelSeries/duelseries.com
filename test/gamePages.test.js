'use strict';
/* Each game's own page for search and shared links (server/gamePages.js, server/gamePageData.js), 2026-11-01.
   The words are honest and plain, the search words carry no money, every playable game has a page under the name
   the lobby shows, a page is real HTML with one h1, a canonical on the main site, Open Graph and Twitter cards and
   VideoGame JSON-LD, it loads no wallet or game code, and only live games get a page, a list card or a sitemap
   line. The real server's routes are gamePagesServer.test.js. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SHARE = require('../shared/shareGames');
const PLAN = require('../shared/trackPlan');
const DATA = require('../server/gamePageData');
const GP = require('../server/gamePages');
const { isLocked } = require('../shared/lockedGames');

// The same list test/shareInvite.test.js keeps out of anything shared: money, stakes, winnings, crypto.
const MONEY = /\$|\bstakes?\b|\bbuy-?ins?\b|\bcash\b|cash.?out|\bwin(?:nings|ners?)?\b|\bprize|\bmoney\b|\bSOL\b|USDC|crypto|\bwallet\b|\bbet\b|wager|earn/i;
const HYPE = /guarantee|get rich|risk.?free|easy money|sure (?:win|thing)|free money|jackpot|\bwin big|make money/i;
const SOON = new Set(['agar', 'battleship']);
const isSoon = (id) => SOON.has(id);

function allStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => allStrings(x, out));
  return out;
}

test('every shared game has a page, under the name the lobby shows, at a search-word address', () => {
  const v2 = read('public/v2.html');
  const seen = new Set();
  assert.deepStrictEqual(DATA.PAGES.map((p) => p.share).sort(), SHARE.GAMES.map((g) => g.slug).sort(), 'one page per shareGames entry');
  for (const p of DATA.PAGES) {
    assert.match(p.page, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, p.page);
    assert.ok(!seen.has(p.page), 'one address once: ' + p.page);
    seen.add(p.page);
    assert.strictEqual(DATA.byPage(p.page), p);
    assert.strictEqual(DATA.byShare(p.share), p);
    assert.strictEqual(p.game, SHARE.bySlug(p.share).game);
    assert.ok(['arena', 'duel'].includes(p.kind), p.page);
    // the lobby card's name: written there, or read from the one file it comes from
    const card = new RegExp("\\{id:'" + p.game + "',name:([^,]+),").exec(v2);
    assert.ok(card, 'a lobby card: ' + p.game);
    // ours (the page's name), or the other publisher's game it plays like (named in the lede alone)
    const ours = (n) => assert.ok(n === p.name || n === p.like, p.page + ': ' + n);
    if (p.game === 'chomp') ours(require('../shared/chompName'));
    else if (p.game === 'swim') {
      assert.match(card[1], /SwimSim\.NAME/);
      assert.match(read('shared/swimSim.js'), new RegExp("const NAME = '" + p.name + "';"));
    } else ours(/^'(.*)'$/.exec(card[1])[1]);
    assert.ok(p.how.length >= 3 && p.how.length <= 5, p.page + ' how to play');
    assert.ok(p.about.length >= 1 && p.genre.length >= 1, p.page);
  }
  assert.strictEqual(DATA.byPage('nope'), null);
});

test('the words: plain (no em dashes), honest (no hype), and nothing about money in a title or a search result', () => {
  const words = allStrings([DATA.PAGES, DATA.KIND, DATA.INDEX, DATA.DISCLAIMER]);
  for (const s of words) {
    assert.ok(!/[—–]/.test(s), 'no em or en dash: ' + s);
    assert.doesNotMatch(s, HYPE, 'honest: ' + s);
  }
  // a game's lede and card line too (they sit above Play free); the list's own lede says paid play exists, plainly
  for (const p of DATA.PAGES.concat([DATA.INDEX])) {
    for (const s of [p.title, p.description, p.h1, p.name, p.short, p === DATA.INDEX ? null : p.lede].filter(Boolean)) {
      assert.doesNotMatch(s, MONEY, 'free words only: ' + s);
    }
    assert.ok(p.description.length >= 70 && p.description.length <= 170, 'a search snippet: ' + p.description.length + ' ' + p.description);
    assert.ok((p.title + ' | DuelSeries').length <= 70, 'a title that fits: ' + p.title);
  }
  // Safe names: another publisher's game is named only in the lede, as "like X", never in a title, a search
  // result, the name (the h1, link preview and JSON-LD) or the card line; the footer says we are not them.
  const FAMOUS = /pac-?man|slither|agar|paper\.io|rooftop snipers|crossy road/i;
  for (const p of DATA.PAGES.concat([DATA.INDEX])) {
    for (const s of [p.title, p.description, p.h1, p.name, p.short].filter(Boolean)) assert.doesNotMatch(s, FAMOUS, s);
  }
  for (const page of ['chomp', 'snake', 'cells', 'paper', 'rooftop-duel', 'road-hop']) {
    const p = DATA.byPage(page);
    assert.match(p.like, FAMOUS, page);
    assert.ok(p.lede.includes('like ' + p.like), page + ' lede');
  }
  assert.match(DATA.DISCLAIMER, /not affiliated/);
});

test('the paid words match the terms and the code: 21 and over, $0.50 and $1.00, a 10% house fee, what can be lost', () => {
  const terms = read('public/terms.html');
  assert.match(terms, /at least 21 years old/);
  assert.match(terms, /fixed buy-ins of \$0\.50 or \$1\.00/);
  assert.match(terms, /90% of your worth/);
  assert.strictEqual(require('../server/duelMoney').DUEL_HOUSE_CUT, 0.10);
  assert.deepStrictEqual(require('../shared/stakeLadder').LADDER, [0, 0.5, 1]);
  for (const k of ['arena', 'duel']) {
    const kind = DATA.KIND[k];
    assert.match(kind.paid, /21 and over/);
    assert.match(kind.paid, /\$0\.50 or \$1\.00/);
    assert.match(kind.paid, /10% /);
    assert.match(kind.paid, /lose/, 'says what can be lost');
    assert.match(kind.paidTag, /21\+$/);
    assert.match(kind.free, /cost nothing and pay nothing/);
    assert.doesNotMatch(kind.paid + kind.paidTag, /18\+|\b18\b/);
  }
  assert.match(DATA.KIND.arena.paid, /90% of what you hold/);
  assert.match(DATA.KIND.duel.paid, /\$1\.80 from a \$1 duel/);
});

test('a game\'s page: one h1, its canonical, cards with absolute pictures, VideoGame JSON-LD, Play into its free room', () => {
  const live = GP.livePages(isSoon);
  for (const p of live) {
    const html = GP.renderPage(p, live);
    const url = 'https://duelseries.com/games/' + p.page;
    const g = SHARE.bySlug(p.share);
    assert.ok(html.startsWith('<!DOCTYPE html>\n<html lang="en">'), p.page);
    assert.strictEqual((html.match(/<h1>/g) || []).length, 1, p.page + ' one h1');
    assert.ok(html.includes('<h1>' + p.name + '</h1>'), p.page);
    assert.strictEqual((html.match(/<title>/g) || []).length, 1);
    assert.ok(html.includes('<title>' + p.title + ' | DuelSeries</title>'));
    assert.ok(html.includes('<link rel="canonical" href="' + url + '">'));
    assert.ok(html.includes('<meta property="og:url" content="' + url + '">'));
    assert.ok(html.includes('<meta property="og:image" content="https://duelseries.com' + g.image + '">'));
    assert.ok(html.includes('<meta name="twitter:image" content="https://duelseries.com' + g.image + '">'));
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
    assert.ok(html.includes('<meta name="description" content="' + p.description + '">'));
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'img', 'games', p.game + '-card.webp')), p.game + ' card art');
    assert.ok(html.includes('<img class="art" src="/img/games/' + p.game + '-card.webp?v=1"'));
    // Play free is the invite link marked as from this page; Play for money only adds pick=1 (the player chooses)
    assert.ok(html.includes('<a class="play" href="/play/' + p.share + '?from=page" data-play="free"'), p.page);
    assert.ok(html.includes('<a class="paid" href="/play/' + p.share + '?from=page&pick=1" data-play="paid"'), p.page);
    assert.ok(html.includes(DATA.KIND[p.kind].paid), 'the paid words');
    assert.ok(html.includes('href="/terms.html"') && html.includes('href="/responsible-play.html"'));
    assert.ok(html.includes(DATA.DISCLAIMER));
    // the other live games, and never itself or a game that is not live
    for (const o of live) assert.strictEqual(html.includes('href="/games/' + o.page + '"'), o !== p, p.page + ' -> ' + o.page);
    assert.ok(!/href="\/games\/(?:cells|battleship)"/.test(html));
    // the addresses are our own words too, never another publisher's name
    assert.doesNotMatch(html, /(?:href="|duelseries\.com)\/games\/(?:pac-?man|slither|agar|paper-io|rooftop-snipers|crossy)/);
    // structured data
    const ld = JSON.parse(/<script type="application\/ld\+json">([^<]+)<\/script>/.exec(html)[1]);
    const game = ld['@graph'].find((x) => x['@type'] === 'VideoGame');
    assert.strictEqual(game.name, p.name);
    for (const m of [/<title>([^<]*)</, /property="og:title" content="([^"]*)"/, /name="twitter:title" content="([^"]*)"/]) {
      assert.doesNotMatch(m.exec(html)[1], /pac-?man|slither|agar|paper\.io|rooftop snipers|crossy road/i, p.page);
    }
    assert.doesNotMatch(String(game.alternateName || ''), /pac-?man|slither|agar|paper\.io|rooftop snipers|crossy road/i);
    assert.strictEqual(game.url, url);
    assert.strictEqual(game.image, 'https://duelseries.com' + g.image);
    assert.strictEqual(game.offers.price, '0');
    assert.strictEqual(game.isAccessibleForFree, true);
    assert.ok(!('aggregateRating' in game), 'no rating we do not have');
    assert.ok(ld['@graph'].some((x) => x['@type'] === 'BreadcrumbList'));
    // light: no wallet, no Privy, no game code; the tracking pair in order; small
    assert.doesNotMatch(html, /\/wallet\/|privy|socket\.io|\/js\/v2\//i);
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(scripts, ['/shared/trackPlan.js', '/js/shared/dsTrack.js']);
    assert.ok(Buffer.byteLength(html) < 24 * 1024, p.page + ' ' + Buffer.byteLength(html) + ' bytes');
  }
  // Play is one planned event
  assert.ok(PLAN.EVENTS.landing_play_clicked);
  assert.deepStrictEqual(PLAN.EVENTS.landing_play_clicked.props, ['game', 'paid']);
});

test('ldJson never closes its script tag, whatever the words', () => {
  const s = GP.ldJson({ a: '</script><!-- & -->' });
  assert.ok(!s.includes('<') && !s.includes('>') && !s.includes('&'));
  assert.deepStrictEqual(JSON.parse(s), { a: '</script><!-- & -->' });
});

test('only live games: locked and Coming soon games have no page, no list card and no sitemap line', () => {
  const live = GP.livePages(isSoon);
  assert.ok(live.length >= 10);
  for (const p of DATA.PAGES) assert.strictEqual(live.includes(p), !isLocked(p.game) && !SOON.has(p.game), p.page);
  const xml = GP.sitemapXml(live);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => !u.endsWith('.jpg'));
  assert.deepStrictEqual(locs, ['https://duelseries.com/', 'https://duelseries.com/games']
    .concat(live.map((p) => 'https://duelseries.com/games/' + p.page)));
  const index = GP.renderIndex(live);
  assert.strictEqual((index.match(/<h1>/g) || []).length, 1);
  assert.ok(index.includes('<link rel="canonical" href="https://duelseries.com/games">'));
  for (const p of DATA.PAGES) assert.strictEqual(index.includes('href="/games/' + p.page + '"'), live.includes(p), p.page);
  // every game live (both switches Live): every page
  assert.strictEqual(GP.livePages(() => false).length, DATA.PAGES.length);
});

function fakeApp() {
  const routes = {};
  return { routes, get: (p, h) => { routes[p] = h; } };
}
function fakeRes() {
  const r = { status_: 200, headers: {}, body: null, redirected: null, nf: false };
  r.status = (c) => { r.status_ = c; return r; };
  r.redirect = (code, to) => { r.status_ = code; r.redirected = to; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.type = (t) => { r.headers['Content-Type'] = t; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}

test('the routes: a live page, a page that is not live goes to the lobby, an unknown one is the 404, any case', () => {
  const app = fakeApp();
  let soon = true;
  GP.gamePageRoutes(app, { isSoon: (id) => soon && SOON.has(id), notFound: (_q, res) => { res.nf = true; res.status(404); } });
  assert.deepStrictEqual(Object.keys(app.routes).sort(), ['/games', '/games/:page', '/sitemap.xml']);
  const page = (slug) => { const r = fakeRes(); app.routes['/games/:page']({ params: { page: slug } }, r); return r; };
  const ok = page('Snake');
  assert.strictEqual(ok.status_, 200);
  assert.strictEqual(ok.headers['Cache-Control'], 'no-cache');
  assert.ok(ok.body.includes('<h1>Snake</h1>'));
  assert.deepStrictEqual([page('cells').status_, page('cells').redirected], [302, '/']);
  const nf = page('nope');
  assert.ok(nf.nf && nf.status_ === 404);
  // the first addresses (named after other publishers' games) are a 301 to ours, whatever the case
  const moved = { 'pac-man': 'chomp', 'slither-io': 'snake', 'agar-io': 'cells', 'paper-io': 'paper',
    'rooftop-snipers': 'rooftop-duel', 'crossy-road': 'road-hop' };
  assert.deepStrictEqual(DATA.MOVED, moved);
  for (const [from, to] of Object.entries(moved)) {
    const r = page(from.toUpperCase());
    assert.deepStrictEqual([r.status_, r.redirected], [301, '/games/' + to], from);
    assert.ok(DATA.byPage(to), to + ' is a page');
    assert.strictEqual(DATA.byPage(from), null, from + ' is not a page any more');
  }
  for (const odd of ['constructor', '__proto__', 'hasownproperty', 'tostring']) {
    const r = page(odd);
    assert.ok(r.nf && r.status_ === 404, odd + ' is just unknown');
  }
  // the switch is asked on every request: agar.io switched Live has its page at once
  soon = false;
  assert.strictEqual(page('cells').status_, 200);
  const sm = fakeRes();
  app.routes['/sitemap.xml']({}, sm);
  assert.strictEqual(sm.headers['Content-Type'], 'application/xml');
  assert.ok(sm.body.includes('<loc>https://duelseries.com/games/cells</loc>'));
  for (const old of Object.keys(moved)) assert.ok(!sm.body.includes('/games/' + old + '<'), 'no old address: ' + old);
});

test('crawl basics: robots.txt names the sitemap and keeps the game pages and invites open; the lobby links /games', () => {
  const robots = read('public/robots.txt');
  assert.match(robots, /^Sitemap: https:\/\/duelseries\.com\/sitemap\.xml$/m);
  assert.doesNotMatch(robots, /^Disallow: \/(?:$|games|play)/m);
  const v2 = read('public/v2.html');
  assert.match(v2, /<html lang="en">/);
  // "Game guides", not "All games": the lobby has its own All games screen (review 2026-11-01)
  assert.ok(v2.includes('<a href="/games">Game guides</a>'), 'the footer links the list');
  const ld = /<script type="application\/ld\+json">([^<]+)<\/script>/.exec(v2);
  assert.deepStrictEqual(JSON.parse(ld[1]), { '@context': 'https://schema.org', '@type': 'WebSite', name: 'DuelSeries', url: 'https://duelseries.com/' });
  assert.ok(read('server/index.js').includes("require('./gamePages').gamePageRoutes(app, {"));
  // above express.static and the last 404, like /play
  const idx = read('server/index.js');
  assert.ok(idx.indexOf("require('./gamePages').gamePageRoutes(app") < idx.indexOf('app.use(express.static('));
});
