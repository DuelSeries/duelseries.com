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
   (PUBLIC_RPC_URL, Wallet.js), and that the plan is sized for the traffic.

   Fourth pass (night review 2026-10-29, review problem 0 again): a rate alone let a
   flood spend Helius Free's month in about two days while the public reads share the
   money key. So in that case only, a day's cap is back (createDayCap below), and this
   time it is kept on disk across restarts (persistDayCap, server/rpcDay.js). It can
   only make balances stale or unknown and history busy: no money path reads through
   these budgets any more. */

/* `start` ({ tokens, at }, night review 2026-10-29, fourth pass): a bucket rebuilt from what was saved, tokens as
   they stood at `at`; it refills from then at its rate, never back to full. */
function createBucket({ perSec, burst, now = Date.now, start = null } = {}) {
  const rate = Math.max(1e-6, Number(perSec) || 1);    // tokens a second (a day of 10k refills about 0.12)
  const cap = Math.max(1, Number(burst) || 1);         // the most saved up
  let tokens = cap;
  let at = now();
  if (start && Number.isFinite(Number(start.tokens)) && Number.isFinite(Number(start.at))) {
    tokens = Math.max(0, Math.min(cap, Number(start.tokens)));
    at = Math.min(at, Number(start.at));               // a time ahead of the clock counts from now: nothing refills for it
  }
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
     day                        (fourth pass) a createDayCap shared with other
                                budgets, or null: past it a take or a reserve is
                                refused 'day' at once (never waited for), and
                                every token let through is counted in it.

   A missing key is a caller with no address of its own (the server-wide rate
   only). UNMETERED is the owner's own session: the server-wide rate, never a
   share, never the day. Nothing in the budget itself counts a day: a restart
   refills one burst and no more; the day is the cap's, kept on disk. */
const UNMETERED = Symbol('unmetered');
function createBudget({ perSec, burst, perKey = null, maxKeys = 5000, now = Date.now, day = null } = {}) {
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
      if (day && day.refusal(n, key)) return 'day';
      if (!rate.take(n)) return 'rate';
      if (s) s.take(n);
      if (day) day.commit(n, key);
      spent += n;
      return null;
    },
    reserve(n = 1, maxWaitMs = Infinity, key) {
      const s = share(key);
      const own = s ? s.waitFor(n) : 0;
      const all = rate.waitFor(n);
      if (own > maxWaitMs) return { refused: 'key' };
      if (day && day.refusal(n, key)) return { refused: 'day' };
      if (all > maxWaitMs) return { refused: 'rate' };
      rate.reserve(n);
      if (s) s.reserve(n);
      if (day) day.commit(n, key);
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

/* ─── The public reads' day, kept across restarts ──────────────────────────────
   (night review 2026-10-29, fourth pass: findings 1, 2 and 22, review problem 0)

   With PUBLIC_RPC_URL unset (or the same key as RPC_URL), a flood held to the two
   rates all day still spent about 450k of the key's credits a day: Helius Free's
   1M a month in about two days, then every stake, verify and payout refused until
   it renews. So in that case, and only then (server/rpcDay.js decides), the
   public budget and the history budget both take from one day: `perDay` tokens,
   refilling over 24 h, so a month costs about 31 days of it at most however long
   a flood goes on.

   The second pass had a day too, and it failed twice; this one answers both:
   - it lived in memory and every deploy restarted it full. This one is saved to a
     file (persistDayCap: every 30 s, and on SIGINT/SIGTERM and exit) and rebuilt
     from it at boot, spent as it was, refilling only for the time that passed;
   - spending it stopped money. Nothing that moves money reads through it now
     (stakes, verifies, payouts, the drainer, sweeps, /api/blockhash and the
     widget's sends take from no budget, and the widget sends on a balance it
     could not read), so a spent day only leaves balances stale or unknown,
     history busy and the /api/rpc relay busy.

     perDay         the day's size (server/rpcDay.js: RPC_READS_PER_DAY).
     perKey         { perDay, reserve } (dayShare): each caller's share of the
                    day. Past it a caller may still take, but only while the day
                    has more than `reserve` left, which stays for callers inside
                    their share, so one address spending the day down never
                    leaves a player who just came with nothing.
     saved          what persistDayCap wrote last, or null for a fresh day.

     refusal(n, key)  'day' when n cannot be had now, else null; takes nothing
     commit(n, key)   counts n (after a refusal said null)
     left()           what is left of the day now
     snapshot()       what persistDayCap writes; version() changes with every commit

   UNMETERED (the owner's own session) is never refused and never counted: his own
   screens are his to spend. The shares of the addresses that spent the most (256
   at most) are saved too, by a hash of the address rather than the address. */
const DAY_MS = 86_400_000;
const DAY_KEYS_SAVED = 256;
function dayKeyHash(key) {
  return require('crypto').createHash('sha256').update('rpc-day\0' + String(key)).digest('base64').slice(0, 22);
}
// What was saved, checked: { at, spent, keys: Map(hash -> spent) }, or null for anything that is not a day we wrote.
function savedDay(s) {
  if (!s || typeof s !== 'object' || s.v !== 1) return null;
  const at = Number(s.at), spent = Number(s.spent);
  if (!Number.isFinite(at) || !Number.isFinite(spent) || spent < 0) return null;
  const keys = new Map();
  if (Array.isArray(s.keys)) {
    for (const r of s.keys.slice(0, DAY_KEYS_SAVED)) {
      if (Array.isArray(r) && typeof r[0] === 'string' && r[0].length <= 64 && Number(r[1]) > 0 && Number.isFinite(Number(r[1]))) keys.set(r[0], Number(r[1]));
    }
  }
  return { at, spent, keys };
}
function createDayCap({ perDay, perKey = null, maxKeys = 5000, now = Date.now, saved = null } = {}) {
  const size = Math.max(1, Number(perDay) || 1);
  const shareSize = perKey && Number(perKey.perDay) > 0 ? Number(perKey.perDay) : 0;
  const reserveLeft = perKey ? Math.max(0, Number(perKey.reserve) || 0) : 0;
  const was = savedDay(saved);
  // A day of `cap`, with `spent` of it gone at `at` (what was spent carries over if the size changed in .env).
  const dayBucket = (cap, spent, at) => createBucket({ perSec: cap * 1000 / DAY_MS, burst: cap, now,
    start: spent == null ? null : { tokens: cap - spent, at } });
  const day = dayBucket(size, was ? was.spent : null, was ? was.at : null);
  const waiting = new Map();                            // hash -> its share, saved and not seen since the boot
  if (was && shareSize) for (const [h, spent] of was.keys) waiting.set(h, dayBucket(shareSize, spent, was.at));
  const keys = new Map();                               // key -> { hash, b }, least recently used first
  let version = 0;
  function share(key) {
    if (!shareSize || key == null || key === UNMETERED) return null;
    let s = keys.get(key);
    if (s) { keys.delete(key); keys.set(key, s); return s; }
    const hash = dayKeyHash(key);
    s = { hash, b: waiting.get(hash) || dayBucket(shareSize, null, null) };
    waiting.delete(hash);
    keys.set(key, s);
    if (keys.size > maxKeys) keys.delete(keys.keys().next().value);   // the longest idle starts over
    return s;
  }
  return {
    perDay: size,
    refusal(n = 1, key) {
      if (key === UNMETERED) return null;
      const s = share(key);
      const past = !!(s && s.b.left() < n);             // past its share of the day: the reserve is not for it
      return day.left() < n + (past ? reserveLeft : 0) ? 'day' : null;
    },
    commit(n = 1, key) {
      if (key === UNMETERED) return;
      day.take(Math.min(n, day.left()));
      const s = share(key);
      if (s && s.b.left() >= n) s.b.take(n);
      version++;
    },
    left() { return day.left(); },
    version() { return version; },
    snapshot() {
      const rows = [];
      const add = (hash, b) => { const spent = shareSize - b.left(); if (spent >= 1) rows.push([hash, Math.round(spent * 100) / 100]); };
      for (const s of keys.values()) add(s.hash, s.b);
      for (const [h, b] of waiting) add(h, b);
      rows.sort((a, b) => b[1] - a[1]);
      return { v: 1, at: now(), perDay: size, spent: Math.round((size - day.left()) * 100) / 100, share: shareSize,
               keys: rows.slice(0, DAY_KEYS_SAVED) };
    },
  };
}

/* Each caller's share of the day, the second pass's rule: an eighth of it, and a quarter of it kept back for callers
   inside their share. */
function dayShare(perDay) {
  return { perDay: perDay > 0 ? perDay / 8 : 0, reserve: perDay > 0 ? perDay / 4 : 0 };
}

// What persistDayCap saved at `file`, or null (none yet, or not readable: a fresh day, said once in the log).
function readDayFile(file, { fs = require('fs'), log = (line) => console.warn(line) } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code !== 'ENOENT') log(`[RPC-DAY] could not read ${file} (${e.message}): a fresh day`);
    return null;
  }
  try { return JSON.parse(text); } catch (e) {
    log(`[RPC-DAY] ${file} is not a day we wrote (${e.message}): a fresh day`);
    return null;
  }
}

/* Keeps a day's cap on disk (night review 2026-10-29, fourth pass), so a restart, a deploy or a crash loop never
   hands a flood a fresh day: written every `everyMs` (30 s) while it changed, on exit, and on SIGINT/SIGTERM (pm2's
   restart sends SIGINT, then kills after 1.6 s), each write a temp file renamed over the last. A kill that runs no
   code (SIGKILL, out of memory) loses at most the last 30 s of counting (once the day is spent, the 3.5 calls or so that
   refilled in them).
   The signal listener goes first (prepended) and only saves, synchronously. Anyone else listening (the
   leaderboard's flush, paid agar.io's settle, server/ag/agShutdown.js) still decides when the process ends, exactly
   as before, and the listener is gone by the time they count listeners. With no one else listening it ends the
   process itself, as the signal would have. Returns save(), which reports whether it wrote. */
function persistDayCap(cap, { file, fs = require('fs'), every = setInterval, everyMs = 30_000, proc = process,
                              log = (line) => console.warn(line) } = {}) {
  const path = require('path');
  let saved = cap.version();
  let failing = false;
  function save() {
    const v = cap.version();
    if (v === saved) return false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(cap.snapshot()));
      fs.renameSync(file + '.tmp', file);
      saved = v;
      failing = false;
      return true;
    } catch (e) {
      if (!failing) log(`[RPC-DAY] could not save ${file}: ${e && e.message}`);
      failing = true;
      return false;
    }
  }
  const t = every(save, everyMs);
  if (t && typeof t.unref === 'function') t.unref();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    proc.prependOnceListener(sig, () => {
      save();
      if (proc.listenerCount(sig) === 0) proc.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
  proc.on('exit', save);
  return save;
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
    // fourth pass: the shared key's day (createDayCap) is spent; set PUBLIC_RPC_URL, or raise RPC_READS_PER_DAY with the plan
    day: refusalLog(label, Object.assign({}, opts, { why: "the day's cap on the shared key is spent" })),
  };
}

/* What a budget let through, one line an hour while it let anything through (night review 2026-10-29, third pass).
   With no day's cap, this is how the owner sees in the logs what strangers cost the plan's credits, beside the
   provider's own dashboard: an hour's count far past the players on the site is a flood to look at, and a steady
   climb is the plan to raise. It refuses nothing. The timer never keeps the process alive.
   `day` (fourth pass): the shared key's day, when there is one; the line then says what is left of it. */
function usageLog(label, budget, { log = (line) => console.log(line), everyMs = 3_600_000, every = setInterval, day = null } = {}) {
  let last = budget.spent();
  const tick = () => {
    const s = budget.spent();
    if (s > last) log(`[RPC-USAGE] ${label}: ${s - last} provider calls in the last ${Math.round(everyMs / 60_000)} min` +
      (day ? ` (the shared key's day: ${Math.floor(day.left())} of ${day.perDay} left)` : ''));
    last = s;
  };
  const t = every(tick, everyMs);
  if (t && typeof t.unref === 'function') t.unref();
  return tick;
}

module.exports = { createBucket, createBudget, callerShare, UNMETERED, envNumber, refusalLog, refusalLogs, usageLog,
                   createDayCap, dayShare, readDayFile, persistDayCap };
