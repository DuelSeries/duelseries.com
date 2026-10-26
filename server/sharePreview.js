'use strict';
/* Link previews for invites (the "get players first" push, 2026-10-26).

   A friend's invite is https://duelseries.com/play/<slug> (shared/shareGames.js). Discord, iMessage, X and the rest
   fetch that URL without running any script and read the <head>, so the lobby page is sent with that game's own
   title, words and 1200 x 630 gameplay picture in place of the site's (the block between the share:meta marks in
   public/v2.html). The page is otherwise the lobby itself: public/js/v2/invite.js reads the path and opens that
   game's free room.

   Free play only: every word comes from shareGames.js, which never mentions money. A slug that is not there, or a
   game that is locked (shared/lockedGames.js), goes to the lobby (302, like /agar). */
const fs = require('fs');
const path = require('path');
const SHARE = require('../shared/shareGames');
const { isLocked } = require('../shared/lockedGames');

const MARK_OPEN = '<!-- share:meta -->';
const MARK_CLOSE = '<!-- /share:meta -->';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* The origin a preview names. A Host header is the client's to say, so only our own hosts (duelseries.com and its
   subdomains, eu.duelseries.com) and a local dev box are believed; anything else is the main site. */
function originOf(req) {
  const host = String((req && req.headers && req.headers.host) || '').toLowerCase();
  if (/^(?:[a-z0-9-]+\.)?duelseries\.com$/.test(host)) return 'https://' + host;
  if (/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(host)) return 'http://' + host;
  return SHARE.SITE;
}

/* The <head> lines for one page: { title, blurb, image, url }. */
function metaBlock(p) {
  return [
    MARK_OPEN,
    '<title>' + esc(p.title) + '</title>',
    '<meta name="description" content="' + esc(p.blurb) + '">',
    '<meta property="og:site_name" content="DuelSeries">',
    '<meta property="og:type" content="website">',
    '<meta property="og:title" content="' + esc(p.title) + '">',
    '<meta property="og:description" content="' + esc(p.blurb) + '">',
    '<meta property="og:url" content="' + esc(p.url) + '">',
    '<meta property="og:image" content="' + esc(p.image) + '">',
    '<meta property="og:image:width" content="' + SHARE.IMAGE_W + '">',
    '<meta property="og:image:height" content="' + SHARE.IMAGE_H + '">',
    '<meta property="og:image:alt" content="' + esc(p.alt) + '">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="' + esc(p.title) + '">',
    '<meta name="twitter:description" content="' + esc(p.blurb) + '">',
    '<meta name="twitter:image" content="' + esc(p.image) + '">',
    MARK_CLOSE,
  ].join('\n');
}

function gameMeta(g, origin) {
  return metaBlock({
    title: 'Play ' + g.name + ' with me on DuelSeries',
    blurb: g.blurb,
    image: origin + g.image,
    url: origin + '/play/' + g.slug,
    alt: g.name + ' on DuelSeries',
  });
}

/* Swaps the marked block for this one; the page unchanged when the marks are missing (never a broken page). */
function withMeta(html, block) {
  const a = html.indexOf(MARK_OPEN);
  const b = html.indexOf(MARK_CLOSE, a + 1);
  if (a < 0 || b < 0) return html;
  return html.slice(0, a) + block + html.slice(b + MARK_CLOSE.length);
}

/* app.get('/play/:slug', ...). The lobby file is read once and kept (a deploy restarts the server). */
function playRoute({ lobbyFile = path.join(__dirname, '../public/v2.html'), read = fs.readFileSync } = {}) {
  let html = null;
  return (req, res) => {
    const g = SHARE.bySlug(String((req.params && req.params.slug) || '').toLowerCase());
    if (!g || isLocked(g.game)) return res.redirect(302, '/');
    if (html === null) html = read(lobbyFile, 'utf8');
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(withMeta(html, gameMeta(g, originOf(req))));
  };
}

module.exports = { playRoute, metaBlock, gameMeta, withMeta, originOf, MARK_OPEN, MARK_CLOSE };
