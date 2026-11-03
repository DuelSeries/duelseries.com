'use strict';
/* ─── "Sign-in checks are failing": the owner's [AUTH] alarm ─────────────────────────────────────────────────────────
   2026-11-02. Every Privy token was refused from 11-01 (a bad app secret) and nobody knew for two days: the only
   trace was a rate-limited warning line in the pm2 log. So the rejections are counted here and, past LIMIT in
   WINDOW_MS, Owen's phone is told the way the solvency checks tell him (notify.pushOwner), naming the causes so
   "expired" (a stale tab) reads differently from "no-keys" (this server cannot check anyone).

   Only causes on OUR side trip it (TRIGGERS): no key set, the key set gone stale, the wallet lookup failing or
   impossible, and the issuer only Privy's own tokens carry failing. Anyone can send a junk, forged,
   expired or other-app token, so those are shown in the message as context but never count toward LIMIT (Fable
   review 2026-11-02: 21 junk requests used to buzz the phone hourly and hold the alarm through a real outage).
   Ours and theirs are kept apart, MAX_KEPT each, so a flood of junk can never push our own failures out of the
   count. A signed-out caller (no token at all) is never counted. */

const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 20;
const HOLD_MS = 60 * 60 * 1000;
const MAX_KEPT = 500;
const TRIGGERS = new Set(['no-keys', 'keys-stale', 'lookup-failed', 'no-lookup', 'wrong-iss']);

function createAuthAlarm(opts) {
  const o = opts || {};
  const push = typeof o.push === 'function' ? o.push : () => {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const log = o.log || console;
  const limit = o.limit || LIMIT;
  const windowMs = o.windowMs || WINDOW_MS;
  const holdMs = o.holdMs || HOLD_MS;
  const where = o.region ? ' on ' + String(o.region).toUpperCase() : '';
  const triggers = o.triggers || TRIGGERS;
  let ours = [];             // { at, kind } of TRIGGERS, oldest first
  let theirs = [];           // the rest, for the message only
  let alertedAt = -Infinity;

  /* One rejection. kind is a word from privyKeys.kindOf (or 'lookup-failed' / 'no-lookup'). Never throws. */
  function note(kind) {
    try {
      const t = now();
      const k = String(kind || 'unknown').slice(0, 40);
      const mine = triggers.has(k);
      const list = mine ? ours : theirs;
      list.push({ at: t, kind: k });
      if (list.length > MAX_KEPT) list.splice(0, list.length - MAX_KEPT);
      for (const l of [ours, theirs]) while (l.length && t - l[0].at > windowMs) l.shift();
      if (!mine || ours.length <= limit || t - alertedAt < holdMs) return false;
      alertedAt = t;
      const by = {};
      for (const s of ours.concat(theirs)) by[s.kind] = (by[s.kind] || 0) + 1;
      const parts = Object.keys(by).sort((a, b) => by[b] - by[a]).map((k) => k + ' ' + by[k]).join(', ');
      const mins = Math.round(windowMs / 60000);
      const text = 'Sign-in checks failed ' + ours.length + ' times in ' + mins + ' min' + where + ' (' + parts + ').'
        + ' Signed-in players may not be recognised. Check the server log for [AUTH].';
      log.error('[AUTH] alarm: ' + text);
      push(text, { title: 'Sign-in checks failing', priority: 'high' });
      return true;
    } catch (_) { return false; }
  }

  return { note };
}

module.exports = { createAuthAlarm, TRIGGERS, WINDOW_MS, LIMIT, HOLD_MS };
