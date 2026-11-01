'use strict';
/* A page per game for search and shared links (the "get players" push, 2026-11-01).

   /games/<page>   one live game: real HTML a crawler reads without running a script. Its title, a meta description,
                   one h1, what the game is, how to play, Play free and Play for money, its card art, a big Play
                   button, Open Graph and Twitter cards (the game's 1200 x 630 picture, shared/shareGames.js) and
                   VideoGame structured data (JSON-LD).
   /games          every live game's page, as a list (and the crawl path from the lobby's footer).
   /sitemap.xml    the lobby, /games and every live game's page.

   One system with the invites: the words are server/gamePageData.js, the pictures and the Play target are the
   game's shareGames.js entry, and Play is that game's invite link, /play/<slug>, with ?from=page so the lobby opens
   its free room without calling it an invite (public/js/v2/invite.js). Play for money adds &pick=1: the lobby opens
   the game's screen on its cheapest open paid rung and presses nothing; Play, signing in and the wallet's confirm
   are the player's, as from the lobby's own card. This page names no amount to the lobby and touches no money code.

   Live only: a game that is locked (shared/lockedGames.js) or Coming soon (server/comingSoon.js, a runtime switch,
   asked on every request) has no page (302 to the lobby, like /play) and is left out of /games and the sitemap.

   Light: one inline stylesheet, the card art, the site font, and the tracking pair (shared/trackPlan.js, then
   public/js/shared/dsTrack.js, deferred) so a visitor who arrives from a search is counted from here (first touch,
   public/js/shared/dsTrack.js) and Play is one planned event (landing_play_clicked). No wallet, no Privy, no game
   code. Canonical, og:url and og:image always name the main site, https://duelseries.com, whichever server answers;
   the Play links are relative, so the EU server's page plays on the EU server. */
const path = require('path');
const SHARE = require('../shared/shareGames');
const { isLocked } = require('../shared/lockedGames');
const DATA = require('./gamePageData');
const { metaLines, esc } = require('./sharePreview');

const SITE = SHARE.SITE;
const ART_V = 1;   // public/v2.html ART_V: the card art's cache key
const cardArt = (game) => '/img/games/' + game + '-card.webp?v=' + ART_V;

/* JSON for a <script type="application/ld+json">: never a closing tag or a comment opener inside it. */
function ldJson(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

const FONT = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;650;700&display=swap';

/* The lobby's tokens (public/v2.html :root), set for one readable page. */
const CSS = [
  ':root{--bg:#100e0b;--s1:#17140f;--s2:#1f1b15;--s3:#282219;--tx:#f5f1e8;--tx2:#a89c8a;--tx3:#8d8171;--bone:#f4f1ea;',
  '--money:#f0a830;--r2:10px;--r3:18px;',
  "--f:'Archivo',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}",
  '*{box-sizing:border-box;margin:0;padding:0}',
  'html{-webkit-text-size-adjust:100%}',
  'body{background:var(--bg);color:var(--tx2);font-family:var(--f);font-size:16px;line-height:1.65;',
  '-webkit-font-smoothing:antialiased;padding:0 16px 72px}',
  'a{color:var(--tx);text-decoration-color:var(--tx3);text-underline-offset:3px}',
  ':focus-visible{outline:2px solid var(--bone);outline-offset:3px;border-radius:4px}',
  '.w{max-width:960px;margin:0 auto}',
  '.top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 0}',
  '.brand{font-size:19px;font-weight:700;letter-spacing:-.6px;color:var(--tx);text-decoration:none}',
  '.brand span{color:var(--tx2)}',
  '.nav{font-size:14px;font-weight:600;color:var(--tx2);text-decoration:none;padding:8px 0}',
  '.nav:hover{color:var(--tx)}',
  '.hero{display:grid;grid-template-columns:240px 1fr;gap:40px;align-items:center;margin-top:24px}',
  '.art{display:block;width:240px;height:360px;border-radius:var(--r3);object-fit:cover;background:var(--s1)}',
  'h1{font-size:48px;line-height:1.05;font-weight:700;letter-spacing:-1.6px;color:var(--tx)}',
  '.lede{margin-top:14px;font-size:19px;line-height:1.5;color:var(--tx);max-width:34em}',
  '.facts{margin-top:10px;font-size:14px;color:var(--tx3)}',
  '.cta{display:flex;flex-wrap:wrap;gap:12px;align-items:stretch;margin-top:28px}',
  '.play{display:inline-flex;align-items:center;justify-content:center;min-width:240px;padding:18px 36px;',
  'border-radius:var(--r2);background:var(--bone);color:var(--bg);font-size:21px;font-weight:700;text-decoration:none}',
  '.play:hover{background:#fff}',
  '.paid{display:inline-flex;flex-direction:column;justify-content:center;padding:10px 20px;border-radius:var(--r2);',
  'background:var(--s2);color:var(--tx);font-size:15px;font-weight:650;line-height:1.35;text-decoration:none}',
  '.paid:hover{background:var(--s3)}',
  '.paid small{font-size:13px;font-weight:500;color:var(--money)}',
  'h2{margin:56px 0 14px;font-size:24px;line-height:1.25;font-weight:650;letter-spacing:-.4px;color:var(--tx)}',
  'p{max-width:66ch}',
  'p+p{margin-top:12px}',
  '.how{list-style:none;counter-reset:s;display:grid;gap:10px;max-width:720px}',
  '.how li{counter-increment:s;position:relative;padding:14px 18px 14px 54px;background:var(--s1);border-radius:var(--r2)}',
  '.how li::before{content:counter(s);position:absolute;left:16px;top:15px;width:24px;height:24px;border-radius:50%;',
  'background:var(--s3);color:var(--tx);font-size:13px;font-weight:700;line-height:24px;text-align:center}',
  '.how b{color:var(--tx);font-weight:650}',
  '.modes{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}',
  '.mode{background:var(--s1);border-radius:var(--r3);padding:20px 22px}',
  '.mode.money{box-shadow:inset 3px 0 0 var(--money)}',
  '.mode h3{margin-bottom:6px;font-size:17px;font-weight:650;color:var(--tx)}',
  '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:16px}',
  '.grid a{display:block;color:var(--tx);font-weight:650;font-size:15px;text-decoration:none}',
  '.grid img{display:block;width:100%;height:auto;aspect-ratio:2/3;object-fit:cover;border-radius:var(--r2);',
  'background:var(--s1);margin-bottom:8px}',
  '.grid span{display:block;margin-top:2px;font-size:13px;font-weight:400;line-height:1.45;color:var(--tx3)}',
  'footer{margin-top:72px;padding-top:22px;border-top:1px solid var(--s2);font-size:13px;color:var(--tx3)}',
  'footer nav{display:flex;flex-wrap:wrap;gap:8px 22px;margin-bottom:12px}',
  'footer a{color:var(--tx2);text-decoration:none}',
  'footer a:hover{color:var(--tx)}',
  '@media(max-width:720px){.hero{grid-template-columns:1fr;gap:22px;margin-top:8px}.art{width:160px;height:240px}',
  'h1{font-size:38px}.lede{font-size:17px}.play{width:100%}.paid{width:100%}.modes{grid-template-columns:1fr}',
  '.grid{grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:12px}}',
].join('');

/* Play pressed: one planned event (shared/trackPlan.js), sent through the one helper. The link still works with
   tracking blocked or not yet loaded. */
const PLAY_JS = "document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[data-play]');"
  + "if(!a||!window.DSTrack)return;try{DSTrack.event('landing_play_clicked',{game:a.getAttribute('data-game'),"
  + "paid:a.getAttribute('data-play')==='paid'})}catch(_){}});";

function head({ title, description, canonical, image, alt, ld }) {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="theme-color" content="#100e0b">',
  ].concat(metaLines({ title, blurb: description, url: canonical, canonical, image, alt }), [
    '<link rel="icon" type="image/png" sizes="32x32" href="/img/favicon-32.png">',
    '<link rel="icon" type="image/png" sizes="16x16" href="/img/favicon-16.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/img/apple-touch-icon.png">',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link rel="stylesheet" href="' + FONT + '">',
    '<style>' + CSS + '</style>',
    '<script type="application/ld+json">' + ldJson(ld) + '</script>',
    '<script src="/shared/trackPlan.js" defer></script>',
    '<script src="/js/shared/dsTrack.js" defer></script>',
    '<script>' + PLAY_JS + '</script>',
    '</head>',
  ]).join('\n');
}

function topBar(here) {
  return '<header class="top"><a class="brand" href="/">Duel<span>Series</span></a>'
    + (here === 'index' ? '<a class="nav" href="/">Open the lobby</a>' : '<a class="nav" href="/games">All games</a>')
    + '</header>';
}

function foot() {
  return '<footer><nav>'
    + '<a href="/">Lobby</a><a href="/games">All games</a>'
    + '<a href="/terms.html">Terms of service</a><a href="/privacy.html">Privacy policy</a>'
    + '<a href="/responsible-play.html">Responsible play</a>'
    + '</nav><p>&copy; 2026 DuelSeries. ' + esc(DATA.DISCLAIMER) + '</p></footer>';
}

/* The other live games, as cards: what keeps a visitor (and a crawler) moving to the next page. */
function cards(pages) {
  return '<div class="grid">' + pages.map((p) => '<a href="/games/' + p.page + '">'
    + '<img src="' + cardArt(p.game) + '" alt="' + esc(p.name) + ' card art" width="360" height="540" loading="lazy" decoding="async">'
    + esc(p.name) + '<span>' + esc(p.short) + '</span></a>').join('') + '</div>';
}

const playHref = (p, paid) => '/play/' + p.share + '?from=page' + (paid ? '&pick=1' : '');

/* One game's page. live: every live page, for the More games row. */
function renderPage(p, live) {
  const url = SITE + '/games/' + p.page;
  const share = SHARE.bySlug(p.share);
  const image = SITE + share.image;
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'VideoGame',
        '@id': url + '#game',
        name: p.name,
        alternateName: share.name !== p.name ? share.name : undefined,
        description: p.description,
        url,
        image,
        genre: p.genre,
        gamePlatform: ['Web browser', 'PC', 'Mobile'],
        applicationCategory: 'GameApplication',
        operatingSystem: 'Any (runs in a web browser)',
        playMode: p.kind === 'duel' ? ['MultiPlayer', 'SinglePlayer'] : 'MultiPlayer',
        numberOfPlayers: p.kind === 'duel'
          ? { '@type': 'QuantitativeValue', value: 2 }
          : { '@type': 'QuantitativeValue', minValue: 1 },
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', availability: 'https://schema.org/InStock', url },
        inLanguage: 'en',
        publisher: { '@type': 'Organization', name: 'DuelSeries', url: SITE + '/' },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'DuelSeries', item: SITE + '/' },
          { '@type': 'ListItem', position: 2, name: 'Games', item: SITE + '/games' },
          { '@type': 'ListItem', position: 3, name: p.name, item: url },
        ],
      },
    ],
  };
  const others = live.filter((o) => o.page !== p.page);
  const kind = DATA.KIND[p.kind];
  return [
    head({ title: p.title + ' | DuelSeries', description: p.description, canonical: url, image, alt: p.name + ' on DuelSeries', ld }),
    '<body>',
    '<div class="w">',
    topBar('page'),
    '<main>',
    '<section class="hero">',
    '<img class="art" src="' + cardArt(p.game) + '" alt="' + esc(p.name) + ' card art" width="360" height="540" fetchpriority="high">',
    '<div>',
    '<h1>' + esc(p.name) + '</h1>',
    '<p class="lede">' + esc(p.lede) + '</p>',
    '<p class="facts">' + esc(kind.facts) + '</p>',
    '<div class="cta">',
    '<a class="play" href="' + playHref(p, false) + '" data-play="free" data-game="' + esc(p.game) + '">Play free</a>',
    '<a class="paid" href="' + playHref(p, true) + '" data-play="paid" data-game="' + esc(p.game) + '">Play for money'
      + '<small>' + esc(kind.paidTag) + '</small></a>',
    '</div>',
    '</div>',
    '</section>',
    '<h2>About ' + esc(p.name) + '</h2>',
    p.about.map((t) => '<p>' + esc(t) + '</p>').join('\n'),
    '<h2>How to play ' + esc(p.name) + '</h2>',
    '<ol class="how">' + p.how.map(([b, t]) => '<li><b>' + esc(b) + '.</b> ' + esc(t) + '</li>').join('') + '</ol>',
    '<h2>Free or for money</h2>',
    '<div class="modes">',
    '<div class="mode"><h3>Play free</h3><p>' + esc(kind.free) + '</p></div>',
    '<div class="mode money"><h3>Play for money</h3><p>' + esc(kind.paid) + ' '
      + 'See the <a href="/terms.html">terms</a> and <a href="/responsible-play.html">responsible play</a>.</p></div>',
    '</div>',
    others.length ? '<h2>More games</h2>\n' + cards(others) : '',
    '</main>',
    foot(),
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/* /games: every live game. */
function renderIndex(live) {
  const url = SITE + '/games';
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: DATA.INDEX.title,
    description: DATA.INDEX.description,
    url,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: live.map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: p.name, url: SITE + '/games/' + p.page })),
    },
  };
  return [
    head({ title: DATA.INDEX.title + ' | DuelSeries', description: DATA.INDEX.description, canonical: url,
      image: SITE + SHARE.HOME.image, alt: 'DuelSeries games', ld }),
    '<body>',
    '<div class="w">',
    topBar('index'),
    '<main>',
    '<h1>' + esc(DATA.INDEX.h1) + '</h1>',
    '<p class="lede">' + esc(DATA.INDEX.lede) + '</p>',
    '<div class="cta"><a class="play" href="/">Open the lobby</a></div>',
    '<h2>Pick a game</h2>',
    cards(live),
    '</main>',
    foot(),
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/* The sitemap: the lobby, /games and each live game's page, with its picture. */
function sitemapXml(live) {
  const u = (loc, img) => '<url><loc>' + esc(loc) + '</loc>'
    + (img ? '<image:image><image:loc>' + esc(img) + '</image:loc></image:image>' : '') + '</url>';
  return ['<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
    u(SITE + '/', SITE + SHARE.HOME.image),
    u(SITE + '/games', null),
  ].concat(live.map((p) => u(SITE + '/games/' + p.page, SITE + SHARE.bySlug(p.share).image)), ['</urlset>', '']).join('\n');
}

/* isSoon(game): server/comingSoon.js, asked on every request (a runtime switch). */
function livePages(isSoon) {
  return DATA.PAGES.filter((p) => !isLocked(p.game) && !(typeof isSoon === 'function' && isSoon(p.game)));
}

/* The three routes. Declared before express.static and the 404 (server/index.js). Pages are built per request:
   a few string joins, and the live list can change without a restart. */
function gamePageRoutes(app, { isSoon = null, notFound = null } = {}) {
  const send = (res, type, body) => {
    res.set('Cache-Control', 'no-cache');   // ETag revalidation: a repeat visit is a 304
    res.type(type).send(body);
  };
  app.get('/games', (_req, res) => send(res, 'html', renderIndex(livePages(isSoon))));
  app.get('/games/:page', (req, res) => {
    const want = String((req.params && req.params.page) || '').toLowerCase();
    const p = DATA.byPage(want);
    if (!p) {
      if (typeof notFound === 'function') return notFound(req, res);
      return res.status(404).type('text').send('Not found');
    }
    const live = livePages(isSoon);
    if (!live.includes(p)) return res.redirect(302, '/');
    send(res, 'html', renderPage(p, live));
  });
  app.get('/sitemap.xml', (_req, res) => send(res, 'application/xml', sitemapXml(livePages(isSoon))));
}

module.exports = { gamePageRoutes, renderPage, renderIndex, sitemapXml, livePages, playHref, ldJson, cardArt,
  NOT_FOUND_FILE: path.join(__dirname, '../public/404.html') };
