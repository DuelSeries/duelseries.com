'use strict';
/* What can be bought, and for how much: the SERVER's reading of shared/shopPrices.js (docs/skin-purchases.md).

   An item is '<game>:<skin>' ('snake:candycane'), game and skin being the keys of shopPrices.PRICES. Its price is
   that file's dollars as USDC base units (6 decimals), worked out here and nowhere else: the lobby shows the same
   file, but no price a page sends is ever read. A game in shared/lockedGames.js sells nothing (it cannot be played,
   so a skin for it could not be worn). Plain lookups on own keys only, so 'constructor' or '__proto__' is never a
   game or a skin. */
const shopPrices = require('../shared/shopPrices');
const lockedGames = require('../shared/lockedGames');

const ID = /^[a-z][a-z0-9]{0,23}$/;
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

// { game, skin, item, units (BigInt), usdc } for a skin that is for sale, else null.
function itemOf(game, skin) {
  if (typeof game !== 'string' || typeof skin !== 'string' || !ID.test(game) || !ID.test(skin)) return null;
  if (!own(shopPrices.PRICES, game) || !own(shopPrices.PRICES[game], skin)) return null;
  if (lockedGames.isLocked(game)) return null;
  const usdc = shopPrices.price(game, skin);
  if (usdc == null || !(usdc > 0)) return null;
  const units = BigInt(Math.round(usdc * 1e6));
  if (units <= 0n) return null;
  return { game, skin, item: game + ':' + skin, units, usdc: Number(units) / 1e6 };
}

// '<game>:<skin>' -> itemOf, or null for anything else.
function parseItem(item) {
  if (typeof item !== 'string' || item.length > 49) return null;
  const i = item.indexOf(':');
  if (i < 1) return null;
  return itemOf(item.slice(0, i), item.slice(i + 1));
}

// Every skin a game has a price for (locked games included: a pass may still name them, nothing sells them).
function skinsOf(game) {
  return own(shopPrices.PRICES, game) ? Object.keys(shopPrices.PRICES[game]) : [];
}

module.exports = { itemOf, parseItem, skinsOf, ID };
