'use strict';
/* The EU -> NA stats push (server/index.js /api/stats/push): EU reports its player count and the
   stakes live in its games, and NA adds those stakes into the escrow solvency check.

   Security review 2026-10-15 (finding 8): the shared secret fell back to 'duelseries-dev-secret',
   a string anyone can read in this repo, whenever SESSION_SECRET was unset, so on such a box
   anyone could push, and a negative or non-numeric liveStakesSol made the solvency monitor always
   report solvent (or NaN). Now a deployed server (NODE_ENV=production, or REGION set, which every
   real server sets) has no fallback: without SESSION_SECRET the route refuses every push and EU
   sends none. The fallback is kept only for a bare local run, where nothing real is at stake.
   The numbers are read as finite and non-negative, nothing else. */

const DEV_SECRET = 'duelseries-dev-secret';

function isDeployed(env) {
  return env.NODE_ENV === 'production' || !!env.REGION;
}

// The shared secret, or null when there is none (the push is then refused and never sent).
function statsSecret(env = process.env) {
  if (typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET) return env.SESSION_SECRET;
  return isDeployed(env) ? null : DEV_SECRET;
}

// Constant-time compare of the pushed header against the secret; false when there is no secret.
function secretOk(secret, given) {
  if (!secret || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

function readStatsPush(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const count = Number(typeof b.playerCount === 'number' || typeof b.playerCount === 'string' ? b.playerCount : 0);
  const stakes = Number(typeof b.liveStakesSol === 'number' || typeof b.liveStakesSol === 'string' ? b.liveStakesSol : 0);
  return {
    playerCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    liveStakesSol: Number.isFinite(stakes) && stakes > 0 ? stakes : 0,
  };
}

module.exports = { statsSecret, secretOk, readStatsPush, isDeployed, DEV_SECRET };
