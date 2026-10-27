'use strict';
// joinAlerts.js: the owner's phone push when a player joins a lobby (Owen 2026-10-16: "paid loud, free muted").
//
// Two topics. Owen asked for nothing to set up on his phone, so:
//   PAID  notify.js's players topic (duelseries-players-8382, the one his ntfy app already has), priority high: a real
//         player's stake is in a paid room (or queued for a paid duel)
//   FREE  duelseries-free-8382, priority low: a human took a free seat or queued for a free duel. Muted by default (his
//         app is not subscribed to it); adding the topic in the ntfy app shows them, silently.
// The text is the display name, the game, the rung and the region. Never a wallet: an ntfy.sh topic is readable by
// anyone who guesses its name, so a wallet is only ever a key in this process's memory.
//
// Spam guards, in memory, no timers:
//   - one push per player per room per window (paid 5 min keyed by the paying wallet, free 10 min keyed by the name);
//     the same player again inside it is silent and not counted (a rebuy or a play again is not a new arrival)
//   - at most CAP pushes per topic per 10 min; a push held back by the cap is counted and named on the next one sent
//     (as a count: its player stays latched, so the same player retrying cannot inflate it)
//
// Callers are on join paths, some of them paid (a seat that already holds the money). So every entry point is one
// try/catch, returns nothing and awaits nothing: an alert can be lost, a seat can never be.
//
// Off switches (env, read on every call): NTFY_DISABLED=1 (every push, notify.js), NTFY_JOINS_OFF=1 (both join
// topics), NTFY_FREE_JOINS_OFF=1 (the free topic only). NTFY_PAID_URL / NTFY_FREE_URL override a topic.
//
// To see the free ones: ntfy app, +, topic duelseries-free-8382.

const PAID_URL = null; // null: notify.js's own topic (NTFY_TOPIC_URL or the players topic)
const FREE_URL = 'https://ntfy.sh/duelseries-free-8382';

const WINDOW_MS = 10 * 60 * 1000;
const RULES = Object.freeze({
  paid: Object.freeze({ perKeyMs: 5 * 60 * 1000, cap: 20, priority: 'high', tags: 'moneybag' }),
  free: Object.freeze({ perKeyMs: 10 * 60 * 1000, cap: 6, priority: 'low', tags: 'video_game' }),
});
const MAX_KEYS = 5000; // a flood of new names cannot grow the latch past this

// The lobby's names for each game (ASCII: a game name goes into the ntfy Title header).
// 'snake' is the old engine and 'sl' the new one: the same game to the player, two rooms to the latch.
const GAMES = Object.freeze({
  snake: 'slither.io',
  sl: 'slither.io',
  agar: 'agar.io',
  paper: 'Paper.io',
  knockout: 'Knockout',
  battleship: 'Battleship',
  headsoccer: 'Head Soccer',
  br: 'Battle Royale',
  tanks: 'Bowmasters',
  shooter: 'Awesome Tanks',
  chomp: require('../shared/chompName'),   // the shown name, one constant (Pac-Man for now)
  swim: require('../shared/swimSim').NAME,
});

const WALLET_LIKE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // a whole base58 address typed as a name

function cleanName(raw) {
  // control characters, line and paragraph separators and bidi overrides out (a name cannot reorder the push's text)
  const s = String(typeof raw === 'string' ? raw : '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (!s || WALLET_LIKE.test(s)) return 'A player';
  return s.length > 24 ? s.slice(0, 24) : s;
}

// A rung as the lobby says it: Free, $0.50, $1.00. Anything that is not a finite amount above 0 is Free.
function rungText(stake) {
  const n = Number(stake);
  return Number.isFinite(n) && n > 0 ? '$' + n.toFixed(2) : 'Free';
}

function createGate(rule, now) {
  const last = new Map(); // key -> ms of its push (insertion order is time order)
  const times = [];       // ms of each push sent in the window
  let held = 0;           // pushes the cap held back since the last one sent
  return {
    // -> null (silent) or { held } (send, naming the held count)
    take(key) {
      const t = now();
      for (const [k, at] of last) {
        if (t - at < rule.perKeyMs && last.size <= MAX_KEYS) break;
        last.delete(k);
      }
      while (times.length && t - times[0] >= WINDOW_MS) times.shift();
      if (last.has(key)) return null;
      last.set(key, t);
      if (times.length >= rule.cap) {
        held++;
        return null;
      }
      times.push(t);
      const h = held;
      held = 0;
      return { held: h };
    },
  };
}

// deps: { push(message, opts) (notify.pushOwner), region ('na'), env (process.env), now (Date.now), log }
function createJoinAlerts(deps) {
  const d = deps || {};
  const push = d.push;
  const env = d.env || process.env;
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const log = d.log || console;
  const region = String(d.region || 'na').toUpperCase();
  const gates = { paid: createGate(RULES.paid, now), free: createGate(RULES.free, now) };

  function on(name) {
    return String(env[name] == null ? '' : env[name]).trim() === '1';
  }

  // info: { game (a GAMES key), stake (0 or absent = free), name, wallet (paid key only, never sent), queued (a duel
  //         queue rather than a seat), region (the room's, when this server hosts another region's room) }
  function joined(info) {
    try {
      if (typeof push !== 'function' || !info || typeof info !== 'object') return;
      if (on('NTFY_JOINS_OFF')) return;
      const paid = Number(info.stake) > 0;
      if (!paid && on('NTFY_FREE_JOINS_OFF')) return;
      const kind = paid ? 'paid' : 'free';
      const game = Object.prototype.hasOwnProperty.call(GAMES, info.game) ? GAMES[info.game] : 'a game';
      const rung = rungText(info.stake);
      const name = cleanName(info.name);
      const who = paid && typeof info.wallet === 'string' && info.wallet ? 'w:' + info.wallet : 'n:' + name;
      const pass = gates[kind].take(info.game + '|' + rung + '|' + who);
      if (!pass) return;
      const verb = info.queued ? 'queued for' : 'joined';
      const more = pass.held ? ' (+' + pass.held + ' more held back)' : '';
      const rule = RULES[kind];
      const where = typeof info.region === 'string' && /^[a-z]{2}$/.test(info.region) ? info.region.toUpperCase() : region;
      const opts = { title: (paid ? 'Paid join: ' : 'Free join: ') + game + ' ' + rung, tags: rule.tags,
        priority: rule.priority };
      const url = (paid ? env.NTFY_PAID_URL : env.NTFY_FREE_URL) || (paid ? PAID_URL : FREE_URL);
      if (url) opts.url = url;
      push(name + ' ' + verb + ' ' + game + ' ' + rung + ' in ' + where + more, opts);
    } catch (e) {
      try { log.error('[JOIN-ALERT] dropped: ' + (e && e.message)); } catch (_) { /* never */ }
    }
  }

  return { joined };
}

module.exports = { createJoinAlerts, cleanName, rungText, RULES, GAMES, PAID_URL, FREE_URL, WINDOW_MS };
