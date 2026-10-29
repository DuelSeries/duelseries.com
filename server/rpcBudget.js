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

   `now` is injectable for tests. */

function createBucket({ perSec, burst, now = Date.now } = {}) {
  const rate = Math.max(0.01, Number(perSec) || 1);    // tokens a second
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

/* A positive number from the environment, or `fallback`. Read once at boot, so a
   bigger Helius plan is an .env line and a restart. */
function envNumber(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/* One log line when a budget first refuses, then at most one a minute with the
   count, so the owner can see in the logs that it is biting (a flood, or real
   players outgrowing the plan) without a line per refusal. */
function refusalLog(label, { log = console.warn, now = Date.now, everyMs = 60_000 } = {}) {
  let refused = 0;
  let lastAt = -Infinity;
  return function noteRefusal() {
    refused++;
    const t = now();
    if (t - lastAt < everyMs) return;
    log(`[RPC-BUDGET] ${label}: ${refused} refused${Number.isFinite(lastAt) ? ' since the last line' : ''} (server-wide budget full)`);
    refused = 0;
    lastAt = t;
  };
}

module.exports = { createBucket, envNumber, refusalLog };
