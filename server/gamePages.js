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
   the game's screen on Free, points at its paid rungs and presses nothing. A paid rung is always picked on purpose
   (Owen, 2026-10-10): an embedded wallet signs a stake with no pop-up of its own, so the rung the player presses on
   that screen, then Play, is the whole confirmation. This page names no amount to the lobby and touches no money
   code.

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

const FONT = 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap';
/* The site kit (public/css/ds-tokens.css and ds-kit.css, site redo 2026-11-02, layout 1 "Sidebar" standalone pages),
   the few parts these pages use, inlined so the page stays one request: true black, warm panels, bone actions, gold
   for money only, Archivo with its wide display cut, the kit's game cards, buttons, chips and panels. */
const CSS = [
  ':root{--ds-ink:#000;--ds-s1:#0d0b08;--ds-s2:#1a1611;--ds-s3:#272018;--ds-line:#36291a;--ds-line2:#5a4630;',
  '--ds-bone:#f4f1ea;--ds-tx2:#b3a792;--ds-tx3:#988b78;--ds-gold:#f0a830;--ds-gold-t:rgba(240,168,48,.14);',
  '--ds-edge:inset 0 0 0 1px var(--ds-line);--ds-r1:6px;--ds-r2:10px;--ds-r3:18px;--ds-gc-r:16px;--ds-wide:118%;',
  "--ds-f:'Archivo','Segoe UI',system-ui,-apple-system,Roboto,'Helvetica Neue',Arial,sans-serif}",
  '*{box-sizing:border-box;margin:0;padding:0}',
  'html{-webkit-text-size-adjust:100%}',
  'body{background:var(--ds-ink);color:var(--ds-tx2);font-family:var(--ds-f);font-size:16px;line-height:1.65;',
  '-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
  'a{color:var(--ds-bone);text-decoration-color:var(--ds-tx3);text-underline-offset:3px}',
  'a:hover{text-decoration-color:var(--ds-bone)}',
  ':focus-visible{outline:2px solid var(--ds-bone);outline-offset:3px;border-radius:4px}',
  '.w{max-width:1180px;margin:0 auto;padding:0 32px}',
  /* the header: the lobby header's height, black glass, the wordmark and one action */
  '.top{position:sticky;top:0;z-index:50;height:64px;background:rgba(0,0,0,.88);-webkit-backdrop-filter:blur(12px);',
  'backdrop-filter:blur(12px);box-shadow:inset 0 -1px 0 var(--ds-line)}',
  '.top .w{height:100%;display:flex;align-items:center;justify-content:space-between;gap:12px}',
  '.brand{display:inline-flex;align-items:center;height:44px;font-size:20px;font-weight:800;font-stretch:var(--ds-wide);',
  'letter-spacing:-.02em;line-height:1;color:var(--ds-bone);text-decoration:none}',
  '.brand span{color:var(--ds-tx2);font-weight:600}',
  /* the kit's one button family */
  '.nav,.play,.paid,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 16px;',
  'border-radius:var(--ds-r2);font-family:var(--ds-f);font-size:15px;font-weight:650;line-height:1;text-decoration:none;',
  'white-space:nowrap;transition:background-color .14s,box-shadow .14s,transform .08s}',
  '.nav{background:var(--ds-s3);color:var(--ds-bone);box-shadow:var(--ds-edge)}',
  '.nav:hover,.paid:hover{background:#332a1f;box-shadow:inset 0 0 0 1px var(--ds-line2)}',
  '.nav:active,.play:active,.paid:active{transform:translateY(1px) scale(.985)}',
  '.play{min-height:68px;min-width:240px;padding:0 32px;background:var(--ds-bone);color:#000;font-size:20px;font-weight:700;',
  'font-stretch:108%}',
  '.play:hover{background:#fff;box-shadow:0 0 0 4px rgba(244,241,234,.14)}',
  '.play svg{width:20px;height:20px;flex:none}',
  '.paid{min-height:68px;min-width:240px;padding:0 28px;flex-direction:column;gap:5px;background:var(--ds-s3);',
  'color:var(--ds-bone);font-size:18px;font-stretch:108%;box-shadow:var(--ds-edge)}',
  '.paid small{font-size:13px;font-weight:600;font-stretch:100%;color:var(--ds-gold)}',
  'main{display:block;padding:32px 0 48px}',
  /* one game: its art large, a plain heading, Play right there */
  '.hero{display:grid;grid-template-columns:280px minmax(0,1fr);gap:48px;align-items:center;padding:12px 0 48px}',
  '.art{display:block;width:280px;height:420px;border-radius:var(--ds-r3);object-fit:cover;background:var(--ds-s1);',
  'box-shadow:0 30px 60px -28px #000,var(--ds-edge)}',
  'h1{font-size:68px;line-height:1;font-weight:800;font-stretch:var(--ds-wide);letter-spacing:-.025em;color:var(--ds-bone)}',
  '.lede{margin-top:16px;font-size:20px;line-height:1.5;color:var(--ds-bone);max-width:40ch}',
  '.facts{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}',
  '.facts li{display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:var(--ds-r1);background:var(--ds-s3);',
  'color:var(--ds-tx2);font-size:12px;font-weight:650;line-height:1;white-space:nowrap}',
  '.cta{display:flex;flex-wrap:wrap;gap:12px;align-items:stretch;margin-top:32px}',
  /* the words a crawler reads, and the two ways to play beside them */
  '.cols{display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:48px;align-items:start;padding-top:32px;',
  'box-shadow:inset 0 1px 0 var(--ds-line)}',
  'h2{margin:0 0 16px;font-size:22px;line-height:1.15;font-weight:800;font-stretch:var(--ds-wide);letter-spacing:-.01em;color:var(--ds-bone)}',
  '.read section+section{margin-top:48px}',
  'p{max-width:66ch}',
  'p+p{margin-top:12px}',
  '.how{list-style:none;max-width:720px}',
  '.how li{display:grid;grid-template-columns:170px minmax(0,1fr);gap:16px;padding:12px 0;line-height:1.6}',
  '.how li+li{box-shadow:0 -1px 0 var(--ds-line)}',
  '.how b{color:var(--ds-bone);font-weight:700}',
  '.modes{position:sticky;top:88px;display:flex;flex-direction:column;gap:12px}',
  '.modes h2{margin-bottom:4px}',
  '.mode{background:var(--ds-s1);border-radius:var(--ds-r3);padding:24px;box-shadow:var(--ds-edge)}',
  '.mode.money{box-shadow:inset 0 0 0 1px var(--ds-line2)}',
  '.mode h3{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px;',
  'font-size:18px;font-weight:750;line-height:1.25;color:var(--ds-bone)}',
  '.mode p{font-size:15px;line-height:1.6}',
  '.chip{display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:var(--ds-r1);font-size:12px;',
  'font-weight:650;line-height:1;white-space:nowrap;background:var(--ds-gold-t);color:var(--ds-gold)}',
  '.more{margin-top:48px;padding-top:32px;box-shadow:inset 0 1px 0 var(--ds-line)}',
  /* the kit's game cards, each a link to its page with the name and one line under it */
  '.grid{display:grid;grid-template-columns:repeat(var(--cols,5),minmax(0,1fr));gap:24px 16px}',
  '.grid a{display:flex;flex-direction:column;gap:4px;min-width:0;color:var(--ds-bone);font-size:15px;font-weight:700;',
  'line-height:1.25;text-decoration:none;border-radius:var(--ds-gc-r)}',
  '.grid img{display:block;width:100%;height:auto;aspect-ratio:2/3;object-fit:cover;border-radius:var(--ds-gc-r);',
  'background:var(--ds-s2);box-shadow:var(--ds-edge);margin-bottom:8px;transition:transform .18s cubic-bezier(.2,.8,.2,1),box-shadow .18s}',
  '.grid a:hover img{transform:translateY(-4px);box-shadow:0 16px 34px -14px rgba(0,0,0,.9),0 0 0 2px var(--ds-bone)}',
  '.grid a:active img{transform:translateY(-1px) scale(.99)}',
  '.grid span{display:block;font-size:13px;font-weight:400;line-height:1.45;color:var(--ds-tx2)}',
  /* /games: the heading, the lobby, three live cards fanned and still */
  '.ix{display:grid;grid-template-columns:minmax(0,1fr) 380px;align-items:center;gap:32px;padding:24px 0 48px}',
  '.ix h1{font-size:60px;max-width:13ch}',
  '.ix .lede{color:var(--ds-tx2);font-size:19px;max-width:54ch}',
  '.ix .play{min-width:260px}',
  '.fan{position:relative;height:330px}',
  '.fan img{position:absolute;top:20px;width:180px;height:270px;object-fit:cover;border-radius:var(--ds-gc-r);',
  'box-shadow:0 24px 50px -20px #000,var(--ds-edge);background:var(--ds-s2)}',
  '.fan img:nth-child(1){left:0;transform:rotate(-9deg)}',
  '.fan img:nth-child(2){left:100px;top:0;z-index:2;width:190px;height:285px}',
  '.fan img:nth-child(3){left:200px;transform:rotate(9deg)}',
  '.sec{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:24px}',
  '.sec h2{margin:0}',
  '.sec small{font-size:13px;font-weight:600;color:var(--ds-tx2)}',
  '.ixg{--cols:6}',
  /* the footer: the crawl links and the small print */
  'footer{padding:16px 0 48px;box-shadow:inset 0 1px 0 var(--ds-line);font-size:13px;line-height:1.55;color:var(--ds-tx2)}',
  'footer nav{display:flex;flex-wrap:wrap;gap:2px 4px;margin:0 0 12px -12px}',
  'footer a{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;border-radius:var(--ds-r2);color:var(--ds-tx2);',
  'font-size:13px;font-weight:650;text-decoration:none}',
  'footer a:hover{background:var(--ds-s2);color:var(--ds-bone)}',
  'footer p{max-width:80ch}',
  '@media(min-width:761px) and (max-width:1100px){.w{padding:0 24px}.grid{--cols:4}.ix{grid-template-columns:1fr}.fan{display:none}',
  '.hero{grid-template-columns:220px minmax(0,1fr);gap:32px}.art{width:220px;height:330px}h1{font-size:52px}',
  '.cols{grid-template-columns:1fr}.modes{position:static}}',
  '@media(max-width:760px){.w{padding:0 16px}.top{height:60px}.top .w{padding:0 12px 0 16px}.brand{font-size:19px}',
  'main{padding:24px 0 32px}',
  '.hero{grid-template-columns:116px minmax(0,1fr);gap:16px;align-items:end;padding:0 0 32px}',
  '.art{width:116px;height:174px;border-radius:var(--ds-r2)}.txt{display:contents}',
  'h1{font-size:36px;align-self:end;padding-bottom:4px}.hero .lede,.facts,.cta{grid-column:1/-1;margin-top:0}',
  '.lede{font-size:17px}.cta{flex-direction:column;gap:8px;margin-top:8px}',
  '.play,.paid{width:100%;min-width:0;min-height:60px}',
  '.cols{grid-template-columns:1fr;gap:32px;padding-top:24px}.read section+section{margin-top:32px}.read{font-size:15.5px}',
  '.how li{grid-template-columns:1fr;gap:2px}.modes{position:static}.mode{padding:16px}',
  '.more{margin-top:32px;padding-top:24px}',
  '.grid,.ixg{--cols:3;gap:16px 10px}.grid a{font-size:13px}.grid img{margin-bottom:4px}.grid span{font-size:12px}',
  '.grid a:hover img{transform:none}',
  '.ix{grid-template-columns:1fr;padding:8px 0 32px}.ix h1{font-size:38px}.ix .lede{font-size:17px}.ix .cta{margin-top:24px}',
  '.ix .play{width:100%}.fan{display:none}.sec{margin-bottom:16px}',
  'footer{padding-bottom:calc(32px + env(safe-area-inset-bottom))}footer nav{margin-left:-8px}footer a{min-height:44px;padding:0 8px}}',
  '@media(prefers-reduced-motion:reduce){.grid img{transition-duration:.01s}}',
].join('');
const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
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
    '<meta name="theme-color" content="#000000">',
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
  return '<header class="top"><div class="w"><a class="brand" href="/">Duel<span>Series</span></a>'
    + (here === 'index' ? '<a class="nav" href="/">Open the lobby</a>' : '<a class="nav" href="/games">All games</a>')
    + '</div></header>';
}
function foot() {
  return '<footer><nav aria-label="Site">'
    + '<a href="/">Lobby</a><a href="/games">All games</a>'
    + '<a href="/terms.html">Terms of service</a><a href="/privacy.html">Privacy policy</a>'
    + '<a href="/responsible-play.html">Responsible play</a>'
    + '</nav><p>&copy; 2026 DuelSeries. ' + esc(DATA.DISCLAIMER) + '</p></footer>';
}
/* The other live games, as cards: what keeps a visitor (and a crawler) moving to the next page. */
function cards(pages, cls) {
  return '<div class="grid' + (cls ? ' ' + cls : '') + '">' + pages.map((p) => '<a href="/games/' + p.page + '">'
    + '<img src="' + cardArt(p.game) + '" alt="' + esc(p.name) + ' card art" width="360" height="540" loading="lazy" decoding="async">'
    + '<b>' + esc(p.name) + '</b><span>' + esc(p.short) + '</span></a>').join('') + '</div>';
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
        // the invite's plain word, when it differs and is not the other publisher's name (gamePageData like)
        alternateName: share.name !== p.name && share.name !== p.like ? share.name : undefined,
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
    topBar('page'),
    '<div class="w">',
    '<main>',
    '<section class="hero">',
    '<img class="art" src="' + cardArt(p.game) + '" alt="' + esc(p.name) + ' card art" width="360" height="540" fetchpriority="high">',
    '<div class="txt">',
    '<h1>' + esc(p.name) + '</h1>',
    '<p class="lede">' + esc(p.lede) + '</p>',
    '<ul class="facts" aria-label="About this game">' + String(kind.facts).split(' · ').map((f) => '<li>' + esc(f) + '</li>').join('') + '</ul>',
    '<div class="cta">',
    '<a class="play" href="' + playHref(p, false) + '" data-play="free" data-game="' + esc(p.game) + '">' + PLAY_ICON + 'Play free</a>',
    '<a class="paid" href="' + playHref(p, true) + '" data-play="paid" data-game="' + esc(p.game) + '"><span>Play for money</span>'
      + '<small>' + esc(kind.paidTag) + '</small></a>',
    '</div>',
    '</div>',
    '</section>',
    '<div class="cols">',
    '<div class="read">',
    '<section><h2>About ' + esc(p.name) + '</h2>',
    p.about.map((t) => '<p>' + esc(t) + '</p>').join('\n'),
    '</section>',
    '<section><h2>How to play ' + esc(p.name) + '</h2>',
    '<ol class="how">' + p.how.map(([b, t]) => '<li><b>' + esc(b) + '</b><span>' + esc(t) + '</span></li>').join('') + '</ol>',
    '</section>',
    '</div>',
    '<section class="modes"><h2>Free or for money</h2>',
    '<div class="mode"><h3>Play free</h3><p>' + esc(kind.free) + '</p></div>',
    '<div class="mode money"><h3>Play for money <span class="chip">' + esc(kind.paidTag) + '</span></h3><p>' + esc(kind.paid) + ' '
      + 'See the <a href="/terms.html">terms</a> and <a href="/responsible-play.html">responsible play</a>.</p></div>',
    '</section>',
    '</div>',
    others.length ? '<section class="more"><h2>More games</h2>\n' + cards(others) + '</section>' : '',
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
    topBar('index'),
    '<div class="w">',
    '<main>',
    '<section class="ix">',
    '<div>',
    '<h1>' + esc(DATA.INDEX.h1) + '</h1>',
    '<p class="lede">' + esc(DATA.INDEX.lede) + '</p>',
    '<div class="cta"><a class="play" href="/">Open the lobby</a></div>',
    '</div>',
    /* three live cards fanned beside the heading, still (pictures only: the list below carries the words) */
    live.length >= 3 ? '<div class="fan" aria-hidden="true">' + [live[1], live[0], live[2]].map((p) => '<img src="' + cardArt(p.game)
      + '" alt="" width="360" height="540" decoding="async">').join('') + '</div>' : '',
    '</section>',
    '<section>',
    '<div class="sec"><h2>Pick a game</h2><small>' + live.length + (live.length === 1 ? ' game' : ' games') + '</small></div>',
    cards(live, 'ixg'),
    '</section>',
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
    if (!p && Object.hasOwn(DATA.MOVED, want)) return res.redirect(301, '/games/' + DATA.MOVED[want]);   // an old address
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
