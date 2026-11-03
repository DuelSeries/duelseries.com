'use strict';
/* ─── "Sign-in checks are failing": the owner's [AUTH] alarm ─────────────────────────────────────────────────────────
   2026-11-02. Every Privy token was refused from 11-01 (a bad app secret) and nobody knew for two days: the only
   trace was a rate-limited warning line in the pm2 log. So the rejections are counted here and, past LIMIT in
   WINDOW_MS, Owen's phone is told the way the solvency checks tell him (notify.pushOwner), naming the causes so
   "expired" (a stale tab) reads differently from "no-keys" (this server cannot check anyone).

   Anyone can send a junk token, so a flood of them can buzz the phone at most once per HOLD_MS, and memory is
   bounded: only the last MAX_KEPT rejections are held. A signed-out caller (no token at all) is never counted. */

const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 20;
const HOLD_MS = 60 * 60 * 1000;
const MAX_KEPT = 500;

function createAuthAlarm(opts) {
  const o = opts || {};
  const push = typeof o.push === 'function' ? o.push : () => {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const log = o.log || console;
  const limit = o.limit || LIMIT;
  const windowMs = o.windowMs || WINDOW_MS;
  const holdMs = o.holdMs || HOLD_MS;
  const where = o.region ? ' on ' + String(o.region).toUpperCase() : '';
  let seen = [];             // { at, kind }, oldest first
  let alertedAt = -Infinity;

  /* One rejection. kind is a word from privyKeys.kindOf (or 'lookup-failed' / 'no-lookup'). Never throws. */
  function note(kind) {
    try {
      const t = now();
      seen.push({ at: t, kind: String(kind || 'unknown').slice(0, 40) });
      if (seen.length > MAX_KEPT) seen = seen.slice(-MAX_KEPT);
      while (seen.length && t - seen[0].at > windowMs) seen.shift();
      if (seen.length <= limit || t - alertedAt < holdMs) return false;
      alertedAt = t;
      const by = {};
      for (const s of seen) by[s.kind] = (by[s.kind] || 0) + 1;
      const parts = Object.keys(by).sort((a, b) => by[b] - by[a]).map((k) => k + ' ' + by[k]).join(', ');
      const mins = Math.round(windowMs / 60000);
      const text = 'Sign-in checks failed ' + seen.length + ' times in ' + mins + ' min' + where + ' (' + parts + ').'
        + ' Signed-in players may not be recognised. Check the server log for [AUTH].';
      log.error('[AUTH] alarm: ' + text);
      push(text, { title: 'Sign-in checks failing', priority: 'high' });
      return true;
    } catch (_) { return false; }
  }

  return { note };
}

module.exports = { createAuthAlarm, WINDOW_MS, LIMIT, HOLD_MS };
