// analytics.js — server-side PostHog capture for events that must be trusted
// server-side (money: rake, cosmetic sales, bot costs). Fire-and-forget over
// https; never throws, never blocks the game loop.
//
// The browser already loads PostHog (public/js/posthog-init.js) for pageviews,
// sessions, geography, and product events. Money happens on the SERVER and must
// never be client-reported, so we send those here with the same project key.
//
// Config (optional env): POSTHOG_KEY, POSTHOG_HOST, POSTHOG_DISABLED=1

const https = require('https');

const KEY  = process.env.POSTHOG_KEY  || 'phc_rGiSHXN4HzBvzZaZhuFCwbmHFihkemTVcxK7MCPdDqgw';
const HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

function capture(event, distinctId, properties = {}) {
  if (process.env.POSTHOG_DISABLED === '1') return;
  try {
    const u = new URL('/capture/', HOST);
    const body = JSON.stringify({
      api_key: KEY,
      event,
      distinct_id: String(distinctId || 'server'),
      properties: { ...properties, $lib: 'duelseries-server' },
      timestamp: new Date().toISOString(),
    });
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    });
    req.on('error',   () => {});
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch (_) { /* analytics must never break the game */ }
}

// One event name for all money so it's trivial to sum / break down in PostHog.
// amountUsdc is SIGNED: positive = revenue (rake, skins), negative = cost (bot entry).
function captureEarning({ source, amountUsdc, game = null, lobbyType = null, wallet = null }) {
  const amt = Number(amountUsdc);
  if (!Number.isFinite(amt) || amt === 0) return;
  capture('house_earning', wallet || 'house', {
    source,                 // 'game_rake' | 'cosmetic' | 'bot_cost'
    amount: amt,            // USDC, signed
    revenue: amt,           // alias so PostHog revenue tooling can also pick it up
    game,
    lobby_type: lobbyType,
  });
}

module.exports = { capture, captureEarning };
