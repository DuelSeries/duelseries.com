'use strict';
/* ─── "Someone opened your site": the owner's visit push (POST /api/track/visit) ─────────────────────────────────────
   Night review 2026-10-29. The route had no limit at all: anyone could loop it with a browser User-Agent and send
   Owen's phone a push a request, with their own text in it (page, referrer and a country header nothing checks).
   Every owner alert leaves this server for ntfy.sh from the one IP, and ntfy throttles by publishing IP, so a flood
   of visits also used up the allowance the money and sign-in alerts need, and those were dropped without a word.

   So, in memory and with no timers:
     - at most CAP visit pushes per WINDOW_MS for the whole process (the route's per-IP limiter stops one client from
       spending them all); a visit held back is counted and the next push sent says "(+N more)". With joinAlerts' own
       caps that keeps every alert this server sends well under ntfy's refill, so a money alert always has room.
     - the text is only what can be checked: the page is a plain path or "/", the referrer is its host name only, the
       country two capital letters or nothing.
   Obvious bots, crawlers and monitors are skipped as before. */

const WINDOW_MS = 10 * 60 * 1000;
const CAP = 6;
const BOT_UA = /bot|crawl|spider|slurp|bingpreview|monitor|uptime|headless|curl|wget|python-requests|facebookexternalhit/i;

function cleanPage(p) {
  const s = typeof p === 'string' ? p : '';
  return /^\/[A-Za-z0-9/_.~-]{0,39}$/.test(s) ? s : '/';
}

function cleanRef(r) {
  if (typeof r !== 'string' || !r || r.length > 2048) return '';
  try {
    const u = new URL(r);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return /^[a-z0-9.-]{1,60}$/.test(u.hostname) ? u.hostname : '';
  } catch (_) { return ''; }
}

function cleanCountry(c) {
  return typeof c === 'string' && /^[A-Z]{2}$/.test(c) && c !== 'XX' ? c : '';
}

function createVisitAlerts(opts) {
  const o = opts || {};
  const push = typeof o.push === 'function' ? o.push : () => {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const cap = o.cap || CAP;
  const windowMs = o.windowMs || WINDOW_MS;
  let sent = [];
  let held = 0;

  // -> true when a push went out. Never throws.
  function visit(v) {
    try {
      const x = v || {};
      if (BOT_UA.test(String(x.ua || ''))) return false;
      const t = now();
      sent = sent.filter((at) => t - at < windowMs && at <= t);
      if (sent.length >= cap) { held++; return false; }
      sent.push(t);
      const page = cleanPage(x.page);
      const ref = cleanRef(x.ref);
      const country = cleanCountry(x.country);
      const more = held ? ` (+${held} more)` : '';
      held = 0;
      push(`Someone opened your site (${page})` + (country ? ` from ${country}` : '') + (ref ? ` via ${ref}` : '') + more,
        { title: 'Site visit', tags: 'eyes' });
      return true;
    } catch (_) {
      return false;
    }
  }

  return { visit };
}

module.exports = { createVisitAlerts, cleanPage, cleanRef, cleanCountry, CAP, WINDOW_MS };
