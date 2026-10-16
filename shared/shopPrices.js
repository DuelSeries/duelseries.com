/* Shop prices: the one file to edit (Owen, 2026-10-15).

   Every price is in US dollars, paid in USDC. To change one, change the
   number next to the skin, save, and push. 2 shows as $2, and a price
   with cents (1.50) shows as $1.50.

   Skins are for sale (2026-10-16, docs/skin-purchases.md). The lobby shows
   these prices and the server charges them: it reads this same file
   (server/skinCatalog.js), so the price on screen and the charge can never
   disagree. A price changed while someone has the unlock sheet open is
   re-quoted at the new price before anything is signed. A game listed in
   shared/lockedGames.js sells nothing until it opens.

   The rarity a skin shows (Common, Rare, Epic, Legendary) comes from its
   price, using TIERS below: a skin at or above a tier's `from` price gets that
   tier. Change the numbers there to move where the tiers start.

   What each skin looks like lives in shared/shopSkins.js. A skin listed
   there with no price here shows no price; test/shop.test.js fails on it. */
(function (root) {
  'use strict';
  var PRICES = {
    // slither.io
    snake: {
      candycane: 1,
      bumblebee: 1,
      glacier:   2,
      toxic:     2,
      ember:     3,
      sunset:    3,
      royal:     4,
      rainbow:   5,
    },
    // agar.io
    agar: {
      twoface:   1,
      bullseye:  1,
      melon:     2,
      moon:      2,
      peppermint: 3,
      eyeball:   3,
      galaxy:    4,
      sunburst:  5,
    },
    // Paper.io
    paper: {
      mint:      1,
      ice:       1,
      bubblegum: 2,
      grape:     2,
      lava:      3,
      camo:      3,
      midnight:  4,
      gold:      5,
    },
    // Knockout
    knockout: {
      copper:    1,
      jade:      1,
      ice:       2,
      ruby:      2,
      target:    3,
      obsidian:  3,
      marble:    4,
      gold:      5,
    },
    // Battleship
    battleship: {
      navy:      1,
      arctic:    1,
      desert:    2,
      rust:      2,
      crimson:   3,
      stealth:   3,
      jungle:    4,
      gold:      5,
    },
    // Awesome Tanks
    omgshooter: {
      desert:    1,
      arctic:    1,
      navy:      2,
      violet:    2,
      toxic:     3,
      shadow:    3,
      crimson:   4,
      gold:      5,
    },
    // Bowmasters
    tanks: {
      jade:      1,
      sky:       1,
      copper:    2,
      violet:    2,
      crimson:   3,
      twotone:   3,
      ghost:     4,
      gold:      5,
    },
  };

  var TIERS = [
    { name: 'Common',    from: 0 },
    { name: 'Rare',      from: 2 },
    { name: 'Epic',      from: 3 },
    { name: 'Legendary', from: 5 },
  ];

  function price(game, skin) {
    var g = PRICES[game];
    var p = g && g[skin];
    return typeof p === 'number' && isFinite(p) && p >= 0 ? p : null;
  }
  /* 0 to 3, the index into TIERS; null when there is no price. */
  function tier(p) {
    if (p == null) return null;
    var t = 0;
    for (var i = 0; i < TIERS.length; i++) if (p >= TIERS[i].from) t = i;
    return t;
  }

  /* Whole dollars show as $3, anything with cents as $1.50. */
  function format(p) {
    if (p == null) return '';
    return '$' + (Math.round(p * 100) % 100 === 0 ? String(Math.round(p)) : p.toFixed(2));
  }

  var api = { PRICES: PRICES, TIERS: TIERS, price: price, tier: tier, format: format };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_SHOP_PRICES = api;
})(typeof window !== 'undefined' ? window : null);
