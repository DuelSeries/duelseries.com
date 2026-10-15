'use strict';
// Paid slither: the death split (PAID-SL-DESIGN.md section 4; Owen's answer 1, OWNER-ANSWERS.md:145: a dead paid
// snake's worth splits across the food it drops, whoever eats a pellet gets that pellet's share). Pure integer
// micro-USDC: no requires, no clock, no floats in the money.
//
//   foods = the non-null d.drops[i].food of the death record, in drop order (the sim's order: along the body from the
//           tail toward the head, then the head drops; slSim.js deathDrops)
//   k     = foods.length, M = the dead account's micro
//   k === 0  -> nothing placed, unplaced M (the controller books it to the house as slither_breach with an alert)
//   base = floor(M / k), rem = M - base x k, share[i] = base + (i < rem ? 1 : 0)       sum == M, checked
//
// So the remainder goes one micro each to the first pellets and no micro is ever lost or made. M >= 500000 (the
// smallest stake; a live account never loses money) and k <= 861 (L39.count: 2 per body point x 430 + 1), so every
// share is at least 580 micro. Should M ever be below k, only the first M foods take cash (one micro each), so no
// pellet holds 0: a cash-sized food with no cash is the checker's I6, never a pellet worth nothing.

function isMicro(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

// The shares of M over k pellets: an array of k integers, each base or base + 1, summing to M. Needs 1 <= k <= M.
function splitShares(M, k) {
  if (!isMicro(M)) throw new RangeError('slSplit: M must be a whole number of micro >= 0, got ' + String(M));
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError('slSplit: k must be an integer >= 1, got ' + String(k));
  if (k > M) throw new RangeError('slSplit: ' + k + ' pellets cannot each hold a micro of ' + M);
  const base = Math.floor(M / k);
  const rem = M - base * k;
  const shares = new Array(k);
  let sum = 0;
  for (let i = 0; i < k; i++) {
    shares[i] = base + (i < rem ? 1 : 0);
    sum += shares[i];
  }
  if (sum !== M) throw new Error('slSplit: shares sum to ' + sum + ', not ' + M);
  return shares;
}

// The non-null foods of a death record's drops, in drop order (a drop is null when its sector had no free cell,
// slFood.drop).
function foodsOf(drops) {
  if (!Array.isArray(drops)) throw new TypeError('slSplit: drops must be an array');
  const out = [];
  for (const d of drops) if (d && d.food) out.push(d.food);
  return out;
}

// The plan for one death: { foods, shares, unplaced }, foods[i] taking shares[i]. foods may be shorter than the
// drops (null drops, or M below k); unplaced is M when no food was placed, else 0.
function planSplit(M, drops) {
  if (!isMicro(M)) throw new RangeError('slSplit: M must be a whole number of micro >= 0, got ' + String(M));
  const all = foodsOf(drops);
  const n = Math.min(all.length, M);
  if (n === 0) return { foods: [], shares: [], unplaced: M };
  const foods = n === all.length ? all : all.slice(0, n);
  return { foods, shares: splitShares(M, n), unplaced: 0 };
}

module.exports = { splitShares, foodsOf, planSplit, isMicro };
