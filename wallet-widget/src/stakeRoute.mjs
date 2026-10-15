// Which server a buy-in is staked on (STATUS "BEFORE PAPER_PAID IS SWITCHED ON" item 1).
//
// The one-time entry token is minted in the memory of the server that verified the stake and
// can only be spent there. So a stake must go to the server the game's page will connect to.
// The snake page connects to the region the lobby picked (its SERVER_URLS, from
// sessionStorage 'region'). Paper, Knockout and Battleship connect to the page's own origin
// (io() with no URL; public/js/paper/mp/paperArenaMain.js, public/js/knockout.js,
// public/js/battleship.js), and their lobby rows come from that origin's /api/live. Staking
// them on regionBase() sent an EU-region player's money to the EU server and the join to the
// origin server, which refused a token it had never seen: a stake with no seat.
// agar.io (public/ag.html) connects to its own origin's /ag namespace too, so its paid rungs
// ($0.50, $1.00; PAID-AGAR-DESIGN.md 7) are staked on this origin, where its paid door is.
// Paid snake on the new slither.io engine (engine 'sl', PAID-SL-DESIGN.md 2) opens /sl, which
// joins this origin's /sl namespace (io('/sl'), public/js/sl/slNet.js) whatever the region,
// and its rows come from this origin's /api/live: staked here too, where its paid door is.
//
// Plain ES module with no imports, so node tests load it as it ships (test/stakeRoute.test.js).

export const SERVER_URLS = { na: '', eu: 'https://eu.duelseries.com' };

// Games whose page talks to the server it was served from, whatever the lobby's region.
export const ORIGIN_GAMES = Object.freeze({ paper: true, knockout: true, battleship: true, agar: true });

function knownRegion(r) {
  return typeof r === 'string' && Object.prototype.hasOwnProperty.call(SERVER_URLS, r) ? r : 'na';
}

// engine: 'sl' is honoured for snake only; any other game or value is the game's own route.
// -> { base, region }: base prefixes the stake-quote and submit-stake URLs ('' = this origin);
// region is what the launch writes for a region-following page (null for an origin game).
export function stakeRoute(game, region, engine) {
  if (Object.prototype.hasOwnProperty.call(ORIGIN_GAMES, game)) return { base: '', region: null };
  if (game === 'snake' && engine === 'sl') return { base: '', region: null };
  const r = knownRegion(region);
  return { base: SERVER_URLS[r], region: r };
}
