'use strict';
/* ─── Response headers every page and API answer carries ──────────────────────
   - frame-ancestors 'self' / X-Frame-Options SAMEORIGIN: only our own pages may
     frame ours. The lobby frames the games (same origin, so they still load),
     and nobody else can lay a see-through copy of the lobby over a decoy page
     and borrow a click.
   - nosniff: a file is only ever run as the type we served it as.
   - Referrer-Policy: other sites see our origin, never a full path or query.
   - HSTS, on HTTPS requests only (req.secure, which reads nginx's
     X-Forwarded-Proto under the 'trust proxy' setting in server/index.js).
     Plain-http local development never gets it.

   Deliberately NOT a script Content-Security-Policy: the Privy wallet loads
   scripts and frames from its own hosts, and a script policy would break
   sign-in and signing. This policy carries frame-ancestors only. */

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
}

module.exports = { securityHeaders };
