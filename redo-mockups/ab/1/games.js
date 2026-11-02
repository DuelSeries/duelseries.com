/* /games and /games/<page> in the mockup (games.html, game-page.html). The words are window.DSGamePages
   (game-pages-data.js, copied from server/gamePageData.js); the art and Coming soon come from DSKit.data.games.
   Like server/gamePages.js livePages(): a game that is Coming soon has no page and no card. ?empty: no game is live. */
(function () {
  'use strict';
  const P = window.DSGamePages, D = window.DSKit.data, esc = window.DSKit.esc, Q = new URLSearchParams(location.search);
  const isLive = p => { const g = D.games.find(x => x.id === p.game); return !!g && g.kind !== 'soon'; };
  const live = () => Q.has('empty') ? [] : P.PAGES.filter(isLive);
  const art = p => (D.games.find(x => x.id === p.game) || D.games[0]).img;
  const href = p => 'game-page.html?page=' + p.page + (Q.has('empty') ? '&empty' : '');
  /* one card per game: its art (a kit game card), its name and its one line. A link to its page, never the stake sheet. */
  const card = p => '<a class="gx-it" href="' + href(p) + '"><span class="gcard"><img src="' + art(p) + '" alt="' + esc(p.name) +
    ' card art" width="360" height="540" loading="lazy" decoding="async"></span><b>' + esc(p.name) + '</b><span>' + esc(p.short) + '</span></a>';
  const byPage = page => P.PAGES.find(p => p.page === page) || null;
  window.GP = { P, live, art, href, card, byPage, isLive };
})();
