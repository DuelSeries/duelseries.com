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

   `now` is injectable for tests.

   A rate alone holds the key's per-second limit, not its monthly credits, so each
   public budget is a createBudget below: the rate, a day's cap behind it, and
   each caller's share of both (night review 2026-10-29, second pass). */

function createBucket({ perSec, burst, now = Date.now } = {}) {
  const rate = Math.max(1e-6, Number(perSec) || 1);    // tokens a second (a day's cap refills at a few hundredths)
  const cap = Math.max(1, Number(burst) || 1);         // the most saved up
  let tokens = cap;
  let at = now();
  function refill() {
    const t = now();
    if (t > at) tokens = Math.min(cap, tokens + (t - at) * rate / 1000);
    at = t;
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
      refill();
      const wait = tokens >= n ? 0 : Math.ceil((n - tokens) * 1000 / rate);
      if (wait > maxWaitMs) return -1;
      tokens -= n;                                      // owed until the wait is over: the next caller waits longer
      return wait;
    },
    left() { refill(); return tokens; },
  };
}

/* ─── A budget: the rate, a day's cap behind it, and each caller's share ───────
   (night review 2026-10-29, second pass: findings 1, 2 and 22 again)

   The per-second bucket held the key's per-second limit but not its credits: a
   rate that is never empty is still that rate all day. History at 3 a second and
   the public routes at 4 let ONE address keep about 7 billed calls a second
   going, about 600k a day, and Helius Free is 1M a month: the month gone in two
   days, then every stake, verify and payout refused until it renews. And one
   address could hold the whole public rate empty by itself (40 asks per 10 s,
   a balance is two calls, against 4 a second), so nobody else's balance came
   back, and in SOL mode Withdraw and a skin buy need that balance first.

     perSec, burst  the server-wide rate, as createBucket.
     perDay         the most it may spend in a day: a second bucket holding a
                    day's worth and refilling over 24 h, so whatever the rate
                    allows, a month costs about 31 days of it at most.
     perKey         one caller's share (the key: an IP, as the per-IP counts
                    see it). { perSec, burst }: its own rate; past it the caller
                    is refused, so one address takes a share of the rate and
                    never all of it. { perDay, reserve }: its share of the day;
                    past it the caller may still take, but only while the day
                    has more than `reserve` left. That last part stays for
                    callers inside their share, so an address that spends the
                    day down never leaves a player who just came with nothing.

     take(n, key)               null when the n were taken, otherwise why not
                                ('key' its own rate, 'rate', 'day'); a refusal
                                takes nothing
     reserve(n, maxWaitMs, key) { wait } (ms, 0 when they are there now) or
                                { refused: why }; a key's own rate is never
                                waited for

   A missing key is a caller with no address of its own (counted in the day, no
   share). UNMETERED is the owner's own session: the rate only, never the day or
   a share, since the credits he spends on his own screens are his to spend. */
const UNMETERED = Symbol('unmetered');
function createBudget({ perSec, burst, perDay = 0, perKey = null, maxKeys = 5000, now = Date.now } = {}) {
  const rate = createBucket({ perSec, burst, now });
  const day = perDay > 0 ? createBucket({ perSec: perDay / 86400, burst: perDay, now }) : null;
  const k = perKey || {};
  const reserveLeft = Math.max(0, Number(k.reserve) || 0);
  const keys = new Map();                               // key -> its share, least recently used first
  function share(key) {
    if (!perKey || key == null || key === UNMETERED) return null;
    let s = keys.get(key);
    if (s) { keys.delete(key); keys.set(key, s); return s; }
    s = { rate: k.perSec > 0 ? createBucket({ perSec: k.perSec, burst: k.burst || k.perSec, now }) : null,
          day: day && k.perDay > 0 ? createBucket({ perSec: k.perDay / 86400, burst: k.perDay, now }) : null };
    keys.set(key, s);
    if (keys.size > maxKeys) keys.delete(keys.keys().next().value);   // the longest idle starts over
    return s;
  }
  // Why n cannot be had now (null when they can), before anything is taken.
  function refusal(n, key, s) {
    if (key === UNMETERED) return null;
    if (s && s.rate && s.rate.left() < n) return 'key';
    if (day) {
      const past = !!(s && s.day && s.day.left() < n);   // past its day's share: the reserve is not for it
      if (day.left() < n + (past ? reserveLeft : 0)) return 'day';
    }
    return null;
  }
  function commit(n, key, s) {
    if (key === UNMETERED) return;
    if (day) day.take(n);
    if (s && s.rate) s.rate.take(n);
    if (s && s.day && s.day.left() >= n) s.day.take(n);
  }
  return {
    perSec: rate.perSec,
    burst: rate.burst,
    perDay: day ? perDay : 0,
    take(n = 1, key) {
      const s = share(key);
      const why = refusal(n, key, s);
      if (why) return why;
      if (!rate.take(n)) return 'rate';
      commit(n, key, s);
      return null;
    },
    reserve(n = 1, maxWaitMs = Infinity, key) {
      const s = share(key);
      const why = refusal(n, key, s);
      if (why) return { refused: why };
      const wait = rate.reserve(n, maxWaitMs);
      if (wait < 0) return { refused: 'rate' };
      commit(n, key, s);
      return { wait };
    },
    left() { return rate.left(); },
    dayLeft() { return day ? day.left() : Infinity; },
  };
}

/* Each caller's share of a budget, the same rule for every public one: a quarter of the rate and half the burst (4 at
   least, so a balance's two calls always fit), an eighth of the day, and a quarter of the day kept back for callers
   inside their share. Without a perSec (history) a caller has no rate of its own, only its share of the day. */
function callerShare({ perSec, burst, perDay } = {}) {
  return { perSec: perSec > 0 ? perSec / 4 : 0, burst: Math.max(4, (Number(burst) || 0) / 2),
           perDay: perDay > 0 ? perDay / 8 : 0, reserve: perDay > 0 ? perDay / 4 : 0 };
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

/* One refusalLog per reason a budget gives (createBudget), so the line says which part bit: a flood, one address
   past its share, or the day's cap spent (raise the *_PER_DAY line in .env with a bigger plan). */
function refusalLogs(label, opts = {}) {
  return {
    rate: refusalLog(label, Object.assign({}, opts, { why: 'server-wide budget full' })),
    key: refusalLog(label, Object.assign({}, opts, { why: 'one address past its share' })),
    day: refusalLog(label, Object.assign({}, opts, { why: "the day's cap is spent" })),
  };
}

module.exports = { createBucket, createBudget, callerShare, UNMETERED, envNumber, refusalLog, refusalLogs };
