'use strict';
// earnAlerts.js: the owner's phone push when DuelSeries makes him money (Owen 2026-10-26: "I want a notification on
// my phone that tells me that I got money").
//
// One push per house cut that has LANDED in the revenue wallet: rakeSweep.js calls earned() after the withdraw
// succeeds, and the payout drainer calls it when it later pays a sweep that had failed. A cut that is still owed
// pushes nothing.
//
//   Title  You made $0.05
//   Body   agar.io $0.50 room · today $1.25
//
// On notify.js's players topic (duelseries-players-8382, the one Owen's ntfy app has), priority high.
// That topic is readable by anyone who guesses its name, so the text is built ONLY from a fixed list of game names,
// a dollar rung parsed as a number and dollar amounts. Never a wallet, a signature, a player name or an error.
//
// Batching: the first cut pushes at once and opens a WINDOW_MS cooldown; cuts landing inside it are summed into one
// push when it ends (which opens the next cooldown). So a burst of cash-outs is one or two pushes, never a flood.
//
// "today" is the ledger's positive house revenue since midnight Toronto time (db.getHouseEarnedToday, so it survives
// restarts). If that read fails or is slow the push goes without it.
//
// Every entry point is one try/catch that returns nothing and awaits nothing: a push can be lost, a payout never.
// Off switches (env, read on every call): NTFY_DISABLED=1 (every push, notify.js), NTFY_EARN_OFF=1 (these pushes).

const WINDOW_MS = 30 * 1000;
const TODAY_TIMEOUT_MS = 3000;

// The first word of a sweep label (server/index.js, server/paperPayout.js) -> the lobby's name for the game.
const GAMES = Object.freeze({
  slither: 'slither.io',
  sl: 'slither.io',
  snake: 'slither.io',
  agar: 'agar.io',
  ag: 'agar.io',
  paper: 'Paper.io',
  knockout: 'Knockout',
  battleship: 'Battleship',
  chomp: require('../shared/chompName'),   // the shown name, one constant (Pac-Man for now)
  swim: require('../shared/swimSim').NAME,
  headsoccer: 'Head Soccer',
  pool8: '8 Ball Pool',
  airhockey: 'Air Hockey',
  rooftop: 'Rooftop Snipers',
  crossy: 'Crossy Road',
});

function dollars(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '$0.00';
  return v < 0.005 ? 'under $0.01' : '$' + v.toFixed(2);
}

// The room's rung in dollars from its label, or 0 when the label carries none.
// Ladder rooms end in _s0_5 / _s1 (agRoom, PaperRoom, slPaidArenas, GameRoom); the old snake rooms are na_dollar, na_br.
function rungOf(label) {
  const m = /_s(\d{1,3})(?:_(\d{1,2}))?(?:#|$|\s)/.exec(label);
  if (m) return Number(m[1] + (m[2] ? '.' + m[2] : ''));
  return /(^|[\s_])dollar($|[\s#])/.test(label) ? 1 : 0;
}

// A sweep label -> the push's description of where the cut came from. Unknown labels say only "a game".
function describe(rawLabel) {
  const label = typeof rawLabel === 'string' ? rawLabel.trim().slice(0, 120) : '';
  const words = label.split(/\s+/);
  const game = Object.prototype.hasOwnProperty.call(GAMES, words[0]) ? GAMES[words[0]] : null;
  if (!game) return 'a game';
  if (/(^|[\s_])br($|[\s#])/.test(label)) return 'Battle Royale';
  if (words[1] === 'floor') return game + ' floor money';
  if (words[1] === 'breach') return game + ' held funds';
  const rung = rungOf(label);
  return rung > 0 ? game + ' ' + dollars(rung) + ' room' : game;
}

function createEarnAlerts({ push, todayTotal = null, windowMs = WINDOW_MS, now = () => Date.now(),
                            setTimer = setTimeout, clearTimer = clearTimeout, log = console } = {}) {
  let pending = [];     // [{ amount, where }] landed inside the current cooldown
  let timer = null;     // the cooldown; null = the next cut pushes at once

  function off() { return process.env.NTFY_EARN_OFF === '1'; }

  function withToday(cb) {
    if (!todayTotal) return cb(null);
    let done = false;
    const finish = (v) => { if (done) return; done = true; cb(v); };
    const t = setTimer(() => finish(null), TODAY_TIMEOUT_MS);
    if (t && t.unref) t.unref();
    try {
      Promise.resolve(todayTotal())
        .then((v) => { clearTimer(t); finish(Number.isFinite(Number(v)) ? Number(v) : null); },
              () => { clearTimer(t); finish(null); });
    } catch (_) { clearTimer(t); finish(null); }
  }

  function send(cuts) {
    const total = cuts.reduce((s, c) => s + c.amount, 0);
    if (!(total > 0)) return;
    const places = [...new Set(cuts.map((c) => c.where))];
    let what = cuts.length === 1 ? places[0]
      : cuts.length + ' cuts: ' + (places.length > 3 ? places.slice(0, 3).join(', ') + ', more' : places.join(', '));
    withToday((today) => {
      try {
        // the ledger can lag a moment behind a sweep: today is never shown below what this push itself says
        const body = today != null ? what + ' · today ' + dollars(Math.max(today, total)) : what;
        push(body, { title: 'You made ' + dollars(total), tags: 'dollar', priority: 'high' });
      } catch (e) {
        log.error('[EARN] push failed: ' + (e && e.message));
      }
    });
  }

  function startCooldown() {
    timer = setTimer(() => {
      timer = null;
      try {
        const cuts = pending;
        pending = [];
        if (cuts.length && !off()) { send(cuts); startCooldown(); }
      } catch (e) {
        log.error('[EARN] flush failed: ' + (e && e.message));
      }
    }, windowMs);
    if (timer && timer.unref) timer.unref();
  }

  // amount: dollars that landed in the revenue wallet; label: the sweep's label (never sent as is).
  function earned(amount, label) {
    try {
      const a = Number(amount);
      if (!(a > 0) || !Number.isFinite(a) || off()) return;
      const cut = { amount: a, where: describe(label) };
      if (timer) { pending.push(cut); return; }
      send([cut]);
      startCooldown();
    } catch (e) {
      log.error('[EARN] ' + (e && e.message));
    }
  }

  return { earned };
}

// A drainer row that paid a rake sweep -> its sweep label ('rake agar ag_na_s0_5: <error>' -> 'agar ag_na_s0_5').
function labelFromRakeReason(reason) {
  const m = /^rake (.*?):/.exec(String(reason || ''));
  return m ? m[1] : '';
}

module.exports = { createEarnAlerts, describe, labelFromRakeReason, WINDOW_MS };
