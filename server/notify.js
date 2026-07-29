// notify.js — lightweight owner push notifications via ntfy.sh.
//
// Fire-and-forget: POSTs a short message to an ntfy topic so the owner's phone
// buzzes on events like a new player joining. It NEVER throws and NEVER blocks
// the game loop — a failed or slow ping is silently dropped. Dependency-free
// (built-in https), so it works regardless of the Node fetch situation.
//
// Config (all optional env vars):
//   NTFY_TOPIC_URL  full ntfy topic URL (default below)
//   NTFY_DISABLED   set to '1' to turn all pushes off (e.g. local dev)
//
// Subscribe on your phone: open the ntfy app -> add topic "duelseries-players-8382"
// (this is separate from the deploy topic "duelseries-deploy-8382").

const https = require('https');

const NTFY_URL = process.env.NTFY_TOPIC_URL || 'https://ntfy.sh/duelseries-players-8382';

function pushOwner(message, { title, tags, priority } = {}) {
  if (process.env.NTFY_DISABLED === '1') return;
  try {
    const u = new URL(NTFY_URL);
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (title)    headers['Title']    = title;    // keep ASCII (ntfy header value)
    if (tags)     headers['Tags']     = tags;     // e.g. 'video_game' renders a game emoji
    if (priority) headers['Priority'] = String(priority);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: 'POST',
      headers,
      timeout: 5000,
    });
    req.on('error',   () => {});                 // never surface a failed ping
    req.on('timeout', () => req.destroy());
    req.write(typeof message === 'string' ? message : String(message));
    req.end();
  } catch (_) {
    /* swallow — notifications must never break the game */
  }
}

module.exports = { pushOwner };
