// analytics.js — server-side PostHog capture for everything that must be trusted server-side: a paid game's
// start and result (the money it paid), buy-ins, refunds, withdraws, linked-wallet adds, and the house's own money
// (rake, skins, bot costs). Fire-and-forget over https, batched; never throws, never blocks the game loop.
//
// Every event name and property is checked against the one tracking plan (shared/trackPlan.js), the same list the
// browser helper (public/js/shared/dsTrack.js) reads, so both sides spell everything the same way. The person is the
// player's wallet (distinct_id), the same id the lobby identifies with, so a paid game lands on the person who came
// from an ad. Bots are never sent; the owner's wallet is marked is_owner so dashboards can leave him out.
//
// Config (optional env): POSTHOG_KEY, POSTHOG_HOST, POSTHOG_DISABLED=1

const https = require('https');
const PLAN = require('../shared/trackPlan');

const KEY  = process.env.POSTHOG_KEY  || 'phc_rGiSHXN4HzBvzZaZhuFCwbmHFihkemTVcxK7MCPdDqgw';
const HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

const FLUSH_MS = 1000;      // one POST a second at most
const FLUSH_AT = 50;        // or sooner when this many are waiting
const QUEUE_MAX = 2000;     // past this (PostHog unreachable for a long time) the oldest are dropped

let cfg = { isOwner: () => false, isBot: () => false, region: process.env.REGION || 'na', disabled: false };
let queue = [];
let timer = null;
let transport = null;       // tests: (body) => void instead of https
const warned = new Set();

/* index.js: who the owner is (OWNER_WALLETS) and which wallets are the house's bots. */
function configure(o) {
  if (!o || typeof o !== 'object') return;
  if (typeof o.isOwner === 'function') cfg.isOwner = o.isOwner;
  if (typeof o.isBot === 'function') cfg.isBot = o.isBot;
  if (typeof o.region === 'string') cfg.region = o.region;
  if (typeof o.disabled === 'boolean') cfg.disabled = o.disabled;
}

function post(batch) {
  const body = JSON.stringify({ api_key: KEY, batch });
  if (transport) { try { transport(body); } catch (_) { /* a test's */ } return; }
  try {
    const u = new URL('/batch/', HOST);
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
    req.on('response', (res) => res.resume());
    req.write(body);
    req.end();
  } catch (_) { /* analytics must never break the game */ }
}

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  while (queue.length) post(queue.splice(0, 100));
}

function enqueue(item) {
  if ((process.env.POSTHOG_DISABLED === '1' || cfg.disabled) && !transport) return;
  queue.push(item);
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
  if (queue.length >= FLUSH_AT) { flush(); return; }
  if (!timer) {
    timer = setTimeout(flush, FLUSH_MS);
    if (timer.unref) timer.unref();
  }
}

/* The raw capture, for PostHog's own event names and the plan's. Kept for the callers that predate the plan. */
function capture(event, distinctId, properties = {}, opts = {}) {
  try {
    // $geoip_disable: PostHog would place every server event (and the person) in the AWS region; the browser's events
    // carry the player's real location
    const props = { ...properties, $lib: 'duelseries-server', $geoip_disable: true };
    if (opts.set) props.$set = opts.set;
    if (opts.setOnce) props.$set_once = opts.setOnce;
    const id = String(distinctId || 'server');
    props.distinct_id = id;
    enqueue({ event, distinct_id: id, properties: props, timestamp: new Date().toISOString() });
  } catch (_) { /* analytics must never break the game */ }
}

/* One planned event for one wallet. Unknown names are refused (logged once each); unknown properties dropped.
   opts: { set, setOnce } person properties. Returns true when queued. */
function track(event, wallet, props = {}, opts = {}) {
  try {
    const c = PLAN.clean(event, props);
    if (!c.ok) {
      if (!warned.has(event)) { warned.add(event); console.warn('[ANALYTICS] not in the tracking plan, not sent: ' + event); }
      return false;
    }
    if (c.dropped.length && !warned.has(event + ':' + c.dropped.join(','))) {
      warned.add(event + ':' + c.dropped.join(','));
      console.warn('[ANALYTICS] ' + event + ': dropped ' + c.dropped.join(', '));
    }
    const id = wallet ? String(wallet) : '';
    if (id && cfg.isBot(id)) return false;
    let owner = false;
    try { owner = !!(id && cfg.isOwner(id)); } catch (_) { owner = false; }
    const p = { ...c.props, is_owner: owner, region: cfg.region };
    const set = { ...(opts.set || {}) };
    if (owner) { set.is_owner = true; set.$internal_or_test_user = true; }   // PostHog's own "Internal / Test users" cohort
    capture(event, id || 'house', p, { set: id && Object.keys(set).length ? set : undefined, setOnce: id ? opts.setOnce : undefined });
    return true;
  } catch (_) { return false; }
}

/* ── paid games: start and result ─────────────────────────────────────────────────────────────────────────────
   gameStarted when the player is IN a paid game (a seat in an arena, a matched duel); gameEnded once with the
   result and the money the server paid. Start times are kept here, so a result finds its duration and stake. */
const open = new Map();     // `${game}|${wallet}` -> [{ at, stake, mode, room, vsBot }] (oldest first)
const OPEN_MAX = 20000;
const OPEN_TTL_MS = 12 * 3600 * 1000;

function keyOf(game, wallet) { return game + '|' + wallet; }
function prune() {
  if (open.size <= OPEN_MAX) return;
  const cut = Date.now() - OPEN_TTL_MS;
  for (const [k, list] of open) {
    const keep = list.filter(e => e.at > cut);
    if (keep.length) open.set(k, keep); else open.delete(k);
  }
  while (open.size > OPEN_MAX) open.delete(open.keys().next().value);
}

/* o: { wallet, game, stake, mode, room, vsBot, players, engine, bot } */
function gameStarted(o) {
  try {
    if (!o || !o.wallet || o.bot) return false;
    const game = PLAN.game(o.game);
    if (!game) { console.warn('[ANALYTICS] game_started: unknown game ' + o.game); return false; }
    const stake = Number(o.stake);
    const k = keyOf(game, o.wallet);
    const list = open.get(k) || [];
    list.push({ at: Date.now(), stake: Number.isFinite(stake) ? stake : undefined, mode: o.mode, room: o.room, vsBot: o.vsBot });
    if (list.length > 8) list.shift();
    open.set(k, list);
    prune();
    const now = new Date().toISOString();
    return track('game_started', o.wallet, {
      game, paid: true, stake, mode: o.mode, room: o.room, vs_bot: o.vsBot, players: o.players, engine: o.engine,
    }, {
      set: { is_payer: true, last_paid_at: now },
      setOnce: { first_paid_at: now, first_paid_game: game, first_paid_stake: Number.isFinite(stake) ? stake : undefined },
    });
  } catch (_) { return false; }
}

/* o: { wallet, game, result, stake, amount (dollars paid to the player, 0 for a loss), score, place, players,
        reason, room, mode, durationS, vsBot, bot }. net = amount - stake when both are known. */
function gameEnded(o) {
  try {
    if (!o || !o.wallet || o.bot) return false;
    const game = PLAN.game(o.game);
    if (!game) { console.warn('[ANALYTICS] game_ended: unknown game ' + o.game); return false; }
    const k = keyOf(game, o.wallet);
    const list = open.get(k);
    let st = null;
    if (list && list.length) {
      // the matching room's start, else the oldest open one
      let i = o.room != null ? list.findIndex(e => e.room === o.room) : -1;
      if (i < 0) i = 0;
      st = list.splice(i, 1)[0];
      if (!list.length) open.delete(k);
    }
    let stake = Number(o.stake);
    if (!Number.isFinite(stake) && st) stake = st.stake;
    const amount = Number(o.amount);
    const dur = Number.isFinite(Number(o.durationS)) ? Number(o.durationS) : st ? (Date.now() - st.at) / 1000 : undefined;
    const props = {
      game, paid: true, stake, result: o.result, score: o.score, place: o.place, players: o.players, reason: o.reason,
      room: o.room != null ? o.room : st && st.room, mode: o.mode != null ? o.mode : st && st.mode,
      vs_bot: o.vsBot != null ? o.vsBot : st && st.vsBot,
      duration_s: dur != null ? Math.round(dur * 10) / 10 : undefined,
      amount: Number.isFinite(amount) ? amount : undefined,
      net: Number.isFinite(amount) && Number.isFinite(stake) ? Math.round((amount - stake) * 1e6) / 1e6 : undefined,
    };
    const set = {};
    if (o.result === 'won' || o.result === 'cashed_out') set.last_win_at = new Date().toISOString();
    return track('game_ended', o.wallet, props, { set });
  } catch (_) { return false; }
}

// One event name for all house money so it's trivial to sum / break down in PostHog.
// amountUsdc is SIGNED: positive = revenue (rake, skins), negative = cost (bot entry).
function captureEarning({ source, amountUsdc, game = null, lobbyType = null, wallet = null, region = null }) {
  const amt = Number(amountUsdc);
  if (!Number.isFinite(amt) || amt === 0) return;
  try {
    const c = PLAN.clean('house_earning', {
      source,                 // 'game_rake' | 'cosmetic' | 'bot_cost' | ...
      amount: amt,            // dollars, signed
      revenue: amt,           // alias so PostHog revenue tooling can also pick it up
      game,
      lobby_type: lobbyType,
      region: region || cfg.region,
    });
    let owner = false;
    try { owner = !!(wallet && cfg.isOwner(wallet)); } catch (_) { owner = false; }
    capture('house_earning', wallet || 'house', { ...c.props, is_owner: owner }, {});
  } catch (_) { /* analytics must never break the game */ }
}

module.exports = {
  configure, capture, track, gameStarted, gameEnded, captureEarning, flush,
  _setTransport(fn) { transport = typeof fn === 'function' ? fn : null; },
  _reset() { queue = []; open.clear(); warned.clear(); if (timer) { clearTimeout(timer); timer = null; } },
};
