'use strict';
/* ─── Response headers every page and API answer carries ──────────────────────
   - frame-ancestors 'self' / X-Frame-Options SAMEORIGIN: only our own pages may
     frame ours. The lobby frames the games (same origin, so they still load),
     and nobody else can lay a see-through copy of the lobby over a decoy page
     and borrow a click.
   - nosniff: a file is only ever run as the type we served it as.
   - Referrer-Policy: other sites see our origin, never a full path or query.
   - HSTS on HTTPS requests (req.secure, which reads nginx's X-Forwarded-Proto
     under the 'trust proxy' setting in server/index.js) AND on every request for
     duelseries.com or a subdomain of it. The live nginx sends no
     X-Forwarded-Proto, so req.secure is always false there and HSTS never went
     out (security review leftover, 2026-10-15). Our hostname is only ever
     served over TLS, and a browser ignores the header on a plain-http answer
     (RFC 6797 8.1), so naming the host is safe. Plain-http local development
     (localhost, 127.0.0.1) never gets it.

   Deliberately NOT a script Content-Security-Policy: the Privy wallet loads
   scripts and frames from its own hosts, and a script policy would break
   sign-in and signing. This policy carries frame-ancestors only. */

// duelseries.com and any subdomain (eu., www.), with or without a port; never a lookalike such as
// notduelseries.com or duelseries.com.evil.test.
const OUR_HOST = /^(?:[a-z0-9-]+\.)*duelseries\.com\.?(?::\d+)?$/i;

function isOurHost(req) {
  const h = req.headers && req.headers.host;
  return typeof h === 'string' && OUR_HOST.test(h);
}

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.secure || isOurHost(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
}

module.exports = { securityHeaders, isOurHost };
