// notify.js — lightweight owner push notifications via ntfy.sh.
//
// Fire-and-forget: POSTs a short message to an ntfy topic so the owner's phone
// buzzes on events like a new player joining. It NEVER throws and NEVER blocks
// the game loop — a failed or slow ping is silently dropped. Dependency-free
// (built-in https), so it works regardless of the Node fetch situation.
//
// Config (all optional env vars, read on every push):
//   NTFY_TOPIC_URL  full ntfy topic URL (wins over NTFY_TOPIC)
//   NTFY_TOPIC      just a topic name on ntfy.sh (default below)
//   NTFY_TOKEN      an ntfy access token, sent as "Authorization: Bearer" to the topic's own host only
//   NTFY_DISABLED   set to '1' to turn all pushes off (e.g. local dev)
//
// A caller can name another topic with { url } (joinAlerts.js: the paid and free join topics).
//
// Subscribe on your phone: open the ntfy app -> add topic "duelseries-players-8382"
// (this is separate from the deploy topic "duelseries-deploy-8382").
//
// Night review 2026-10-29: the default topic is named in this repo, and an ntfy.sh topic nobody
// reserved can be read and posted to by anyone who knows its name, so a forged "Bot bank needs
// SOL" push looks exactly like a real one. Since 2026-10-29 the live box sends to long random topics
// set in its .env (NTFY_TOPIC_URL, and NTFY_FREE_URL for joinAlerts.js), never in git; the default here
// is only a fallback for a box without them.
// Any query string on the URL is kept now (it was dropped). ntfy throttles by publishing IP, so a
// refusal is logged (at most once a minute) instead of vanishing: a 429 means alerts are being lost.

const https = require('https');

const DEFAULT_TOPIC = 'duelseries-players-8382';
const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;      // ntfy's own topic rule
const TOKEN_RE = /^[\x21-\x7e]{1,512}$/;        // a header-safe token, or none (a bad one would throw every push)

function topicUrl() {
  if (process.env.NTFY_TOPIC_URL) return process.env.NTFY_TOPIC_URL;
  const t = process.env.NTFY_TOPIC;
  return 'https://ntfy.sh/' + (t && TOPIC_RE.test(t) ? t : DEFAULT_TOPIC);
}

let lastRefusalLog = 0;
function onResponse(res) {
  try {
    if (res.statusCode >= 400 && Date.now() - lastRefusalLog > 60 * 1000) {
      lastRefusalLog = Date.now();
      console.warn('[NTFY] push refused: HTTP ' + res.statusCode + (res.statusCode === 429 ? ' (throttled: owner alerts are being lost)' : ''));
    }
    res.resume();
  } catch (_) { /* never */ }
}

function pushOwner(message, { title, tags, priority, url } = {}) {
  if (process.env.NTFY_DISABLED === '1') return;
  try {
    const main = topicUrl();
    const u = new URL(url || main);
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (title)    headers['Title']    = title;    // keep ASCII (ntfy header value)
    if (tags)     headers['Tags']     = tags;     // e.g. 'video_game' renders a game emoji
    if (priority) headers['Priority'] = String(priority);
    const token = process.env.NTFY_TOKEN;
    if (token && TOKEN_RE.test(token) && u.hostname === new URL(main).hostname) headers['Authorization'] = 'Bearer ' + token;
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers,
      timeout: 5000,
    });
    req.on('response', onResponse);
    req.on('error',   () => {});                 // never surface a failed ping
    req.on('timeout', () => req.destroy());
    req.write(typeof message === 'string' ? message : String(message));
    req.end();
  } catch (_) {
    /* swallow — notifications must never break the game */
  }
}

module.exports = { pushOwner, topicUrl, DEFAULT_TOPIC };
