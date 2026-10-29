'use strict';
/* ─── Server-wide budgets for the chain reads a stranger can cause ────────────
   (night review 2026-10-29, findings 1, 2 and 22)

   Every chain call the server makes goes through one RPC key (RPC_URL, shared by
   both regions). Stake verifies, stake submits and payouts share its per-second
   limit (Helius Free: about 10 a second, 1M credits a month) with the reads any
   visitor can ask for: the Wallet tab's history, /api/sol-balance and the
   /api/rpc relay. Those were limited per IP only, and one IP's allowance was
   about the key's whole limit, so one script could leave stakes timing out and
   payouts in the slow lane, and burn the month's credits in about a day.

   A per-IP count cannot protect a server-wide limit from many addresses, so
   each kind of public read takes from a bucket of its own, server-wide:
   `perSec` tokens a second, up to `burst` saved (so a person opening a screen
   is as fast as before; only a steady flood is held to the rate). The money
   paths take from none, so whatever strangers send, the rest of the key stays
   theirs.

     take(n)               n tokens now, or false and none taken (a public
                           route then answers 503 and asks nothing of the chain)
     reserve(n, maxWaitMs) n tokens in turn: the ms to wait for them (0 when
                           they are there now), or -1 when that wait would be
                           over maxWaitMs (nothing is taken; the caller gives up)
     waitFor(n)            the ms until n are there, taking nothing

   `now` is injectable for tests.

   Third pass (night review 2026-10-29, review problems 0 and 1): the day's caps the
   second pass put behind each rate are gone. They lived in memory and started full
   on every boot, and a push to main restarts the server (120 pushes on Oct 28), so
   each deploy handed a flood a fresh day; and a cap any caller could spend was
   something one script, or three honest tabs polling, could empty, after which a
   player's Withdraw, skin buy and Add from a linked wallet could not read the
   balance they check first. Every budget here is now a rate that refills each
   second and a share of it per caller, nothing counts a day, and a restart only
   refills one burst. What keeps the money paths whole is that they take from none
   of these, that the public routes can be pointed at a key of their own
   (PUBLIC_RPC_URL, Wallet.js), and that the plan is sized for the traffic. */

function createBucket({ perSec, burst, now = Date.now } = {}) {
  const rate = Math.max(1e-6, Number(perSec) || 1);    // tokens a second
  const cap = Math.max(1, Number(burst) || 1);         // the most saved up
  let tokens = cap;
  let at = now();
  function refill() {
    const t = now();
    if (t > at) tokens = Math.min(cap, tokens + (t - at) * rate / 1000);
    at = t;
  }
  function waitFor(n = 1) {
    refill();
    return tokens >= n ? 0 : Math.ceil((n - tokens) * 1000 / rate);
  }
  return {
    perSec: rate,
    burst: cap,
    take(n = 1) {
      refill();
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },
    reserve(n = 1, maxWaitMs = Infinity) {
      const wait = waitFor(n);
      if (wait > maxWaitMs) return -1;
      tokens -= n;                                      // owed until the wait is over: the next caller waits longer
      return wait;
    },
    waitFor,
    left() { refill(); return tokens; },
  };
}

/* ─── A budget: the server-wide rate and each caller's share of it ─────────────
   (night review 2026-10-29: findings 1, 2 and 22; third pass, review problems 0 and 1)

     perSec, burst  the server-wide rate, as createBucket.
     perKey         one caller's share (the key: an IP, as the per-IP counts see
                    it), { perSec, burst }: its own rate, so one address takes a
                    share of the server-wide rate and never all of it.

     take(n, key)               null when the n were taken, otherwise why not
                                ('key' past its own share, 'rate' the server-wide
                                rate); a refusal takes nothing. A caller's share
                                refuses at once (a public route answers 429).
     reserve(n, maxWaitMs, key) { wait } (ms, 0 when they are there now) or
                                { refused: why } when the longer of the caller's
                                own wait and the server-wide one is over
                                maxWaitMs (nothing is taken). The history reads
                                use this: one address's long history is paced at
                                its share, never refused for being long.
     spent()                    tokens let through since boot (usageLog)

   A missing key is a caller with no address of its own (the server-wide rate
   only). UNMETERED is the owner's own session: the server-wide rate, never a
   share. Nothing here counts a day: a restart refills one burst and no more. */
const UNMETERED = Symbol('unmetered');
function createBudget({ perSec, burst, perKey = null, maxKeys = 5000, now = Date.now } = {}) {
  const rate = createBucket({ perSec, burst, now });
  const k = perKey || {};
  const keys = new Map();                               // key -> its share, least recently used first
  let spent = 0;
  function share(key) {
    if (!(k.perSec > 0) || key == null || key === UNMETERED) return null;
    let s = keys.get(key);
    if (s) { keys.delete(key); keys.set(key, s); return s; }
    s = createBucket({ perSec: k.perSec, burst: k.burst || k.perSec, now });
    keys.set(key, s);
    if (keys.size > maxKeys) keys.delete(keys.keys().next().value);   // the longest idle starts over
    return s;
  }
  return {
    perSec: rate.perSec,
    burst: rate.burst,
    take(n = 1, key) {
      const s = share(key);
      if (s && s.left() < n) return 'key';
      if (!rate.take(n)) return 'rate';
      if (s) s.take(n);
      spent += n;
      return null;
    },
    reserve(n = 1, maxWaitMs = Infinity, key) {
      const s = share(key);
      const own = s ? s.waitFor(n) : 0;
      const all = rate.waitFor(n);
      if (own > maxWaitMs) return { refused: 'key' };
      if (all > maxWaitMs) return { refused: 'rate' };
      rate.reserve(n);
      if (s) s.reserve(n);
      spent += n;
      return { wait: Math.max(own, all) };
    },
    left() { return rate.left(); },
    spent() { return spent; },
  };
}

/* Each caller's share of a public budget: a quarter of the rate and half the burst (4 at least, so a balance's two
   calls always fit), so one address, or three, never leave the rest of the rate empty. */
function callerShare({ perSec, burst } = {}) {
  return { perSec: perSec > 0 ? perSec / 4 : 0, burst: Math.max(4, (Number(burst) || 0) / 2) };
}

/* A positive number from the environment, or `fallback`. Read once at boot, so a
   bigger Helius plan is an .env line and a restart. */
function envNumber(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/* One log line when a budget first refuses, then at most one a minute with the
   count, so the owner can see in the logs that it is biting (a flood, or real
   players outgrowing the plan) without a line per refusal. */
function refusalLog(label, { log = (line) => console.warn(line), now = Date.now, everyMs = 60_000, why = 'server-wide budget full' } = {}) {
  let refused = 0;
  let lastAt = -Infinity;
  return function noteRefusal() {
    refused++;
    const t = now();
    if (t - lastAt < everyMs) return;
    log(`[RPC-BUDGET] ${label}: ${refused} refused${Number.isFinite(lastAt) ? ' since the last line' : ''} (${why})`);
    refused = 0;
    lastAt = t;
  };
}

/* One refusalLog per reason a budget gives (createBudget), so the line says which part bit: a flood, or one address
   past its share. */
function refusalLogs(label, opts = {}) {
  return {
    rate: refusalLog(label, Object.assign({}, opts, { why: 'server-wide budget full' })),
    key: refusalLog(label, Object.assign({}, opts, { why: 'one address past its share' })),
  };
}

/* What a budget let through, one line an hour while it let anything through (night review 2026-10-29, third pass).
   With no day's cap, this is how the owner sees in the logs what strangers cost the plan's credits, beside the
   provider's own dashboard: an hour's count far past the players on the site is a flood to look at, and a steady
   climb is the plan to raise. It refuses nothing. The timer never keeps the process alive. */
function usageLog(label, budget, { log = (line) => console.log(line), everyMs = 3_600_000, every = setInterval } = {}) {
  let last = budget.spent();
  const tick = () => {
    const s = budget.spent();
    if (s > last) log(`[RPC-USAGE] ${label}: ${s - last} provider calls in the last ${Math.round(everyMs / 60_000)} min`);
    last = s;
  };
  const t = every(tick, everyMs);
  if (t && typeof t.unref === 'function') t.unref();
  return tick;
}

module.exports = { createBucket, createBudget, callerShare, UNMETERED, envNumber, refusalLog, refusalLogs, usageLog };
