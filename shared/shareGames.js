/* What a shared DuelSeries link says about each free game (the "get players first" push, 2026-10-26).

   One file for both ends, like lockedGames.js: the server reads it for a pasted link's preview (Open Graph and
   Twitter cards on /play/<slug>, server/sharePreview.js) and the browser loads it from /shared for the invite link
   and the score card (public/js/shared/dsShare.js, public/js/v2/invite.js), where it lands on window.DS_SHARE.

   FREE PLAY ONLY. Nothing here, or anything built from it, ever mentions money, stakes, buy-ins or winnings: these
   words leave the site in previews, invites and score images. The names are plain words for what each game is,
   not the lobby's card names, which are other publishers' trademarks.

   slug  the /play/<slug> path a friend opens; game  the lobby's GAMES id it plays. */
(function (root) {
  'use strict';
  var SITE = 'https://duelseries.com';
  var GAMES = Object.freeze([
    Object.freeze({ slug: 'snake', game: 'snake', name: 'Snake', accent: '#c080ff', image: '/og/snake-card.jpg',
      blurb: 'Grow by eating and cut other snakes off. Free in your browser, no download.' }),
    Object.freeze({ slug: 'paper', game: 'paper', name: 'Paper', accent: '#a887d6', image: '/og/paper-card.jpg',
      blurb: 'Claim ground by looping back home before anyone crosses your trail. Free in your browser, no download.' }),
    Object.freeze({ slug: 'cells', game: 'agar', name: 'Cells', accent: '#65c8e8', image: '/og/cells-card.jpg',
      blurb: 'Eat anything smaller than you, split to chase, stay clear of anything bigger. Free in your browser, no download.' }),
    Object.freeze({ slug: 'chomp', game: 'chomp', name: 'Chomp', accent: '#e8c860', image: '/og/chomp-card.jpg',
      blurb: 'Eat the dots, dodge the ghosts, and turn the tables with a power pellet. Free in your browser, no download.' }),
    Object.freeze({ slug: 'knockout', game: 'knockout', name: 'Knockout', accent: '#e0a05c', image: '/og/knockout-card.jpg',
      blurb: 'Two pieces each on a shrinking disc. Aim, commit, and see whose read was right. Free 1v1 in your browser.' }),
    Object.freeze({ slug: 'battleship', game: 'battleship', name: 'Battleship', accent: '#7b93c4', image: '/og/battleship-card.jpg',
      blurb: 'Hide your fleet, then find theirs first. Free 1v1 in your browser.' }),
    Object.freeze({ slug: 'airhockey', game: 'airhockey', name: 'Air Hockey', accent: '#2ff3ff', image: '/og/airhockey-card.jpg',
      blurb: 'One puck, two mallets, first to seven on a neon rink. Free 1v1 in your browser.' }),
    Object.freeze({ slug: 'rooftop', game: 'rooftop', name: 'Rooftop Duel', accent: '#e08a7a', image: '/og/rooftop-card.jpg',
      blurb: 'Two snipers on one wobbly roof. Knock the other one off first. Free 1v1 in your browser.' }),
    Object.freeze({ slug: 'crossy', game: 'crossy', name: 'Crossy Road', accent: '#82ce54', image: '/og/crossy-card.jpg',
      blurb: 'Hop the same roads, rivers and rails as your friend. The first one hit loses. Free 1v1 in your browser.' }),
    // Added by the site sweep (2026-10-28): these three were in the lobby with no invite link or end-screen Share.
    Object.freeze({ slug: 'headsoccer', game: 'headsoccer', name: 'Head Soccer', accent: '#7fd36b', image: '/og/headsoccer-card.jpg',
      blurb: 'One on one, oversized heads, and a ball that rarely goes where you meant it to. Free 1v1 in your browser.' }),
    Object.freeze({ slug: 'swim', game: 'swim', name: 'Swim', accent: '#8fd06a', image: '/og/swim-card.jpg',
      blurb: 'Weave through endless traffic. Touch a car, or fall 200 m behind, and you lose. Free 1v1 in your browser.' }),
    Object.freeze({ slug: 'pool', game: 'pool8', name: 'Pool', accent: '#3fae6f', image: '/og/pool8-card.jpg',
      blurb: 'Break, call your pocket, and sink the eight before they do. Free 1v1 in your browser.' }),
  ]);
  var HOME = Object.freeze({
    title: 'DuelSeries: free multiplayer browser games',
    blurb: 'Snake, Paper, Cells, Chomp, 1v1 duels and a battle royale. Free in your browser, no download.',
    image: '/og/home.jpg',
  });
  // The og images are 1200 x 630 (what Discord, iMessage and X show large).
  var IMAGE_W = 1200, IMAGE_H = 630;

  function bySlug(slug) {
    for (var i = 0; i < GAMES.length; i++) if (GAMES[i].slug === slug) return GAMES[i];
    return null;
  }
  function byGame(id) {
    for (var i = 0; i < GAMES.length; i++) if (GAMES[i].game === id) return GAMES[i];
    return null;
  }

  var api = Object.freeze({
    SITE: SITE, GAMES: GAMES, HOME: HOME, IMAGE_W: IMAGE_W, IMAGE_H: IMAGE_H,
    bySlug: bySlug, byGame: byGame,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_SHARE = api;
})(typeof window !== 'undefined' ? window : null);
