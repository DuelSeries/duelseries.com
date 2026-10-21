'use strict';
/* The SOL price the money path uses in SOL mode (MONEY_MODE=sol, server/money.js). Games count in dollars; this
   is the one rate that turns those dollars into lamports at the doors (a stake quote, a payout, a skin, a bot
   seed). A MONEY PATH: a wrong or stale rate pays the wrong amount of real SOL.

   Three independent public sources, each read every 15 s (one request each, never batched):
     Jupiter Price API v3 (on-chain liquidity), Coinbase spot, CoinGecko simple price.
   A reading counts only while it is under 60 s old. The rate is the median of the largest group of fresh
   readings whose highest is within 1.5 percent of its lowest, and it is given only when that group has two or more. Anything else (one source
   left, two that disagree, everything stale) answers PRICE_WAIT: no new stake is quoted and no payout is built
   until a good rate is back (a payout waits as an owed row, server/payoutDrainer.js). There is no fallback
   number: the old CAD feed (server/prices.js) guessed 200 CAD when it had nothing, which is never acceptable here.

   Everything is injected (fetch, clock, sources) so test/solPrice.test.js runs it without the network. */

const PRICE_WAIT = 'payout-wait';           // the drainer's "nothing signed, try later" code (money.js)
const POLL_MS = 15_000;
const MAX_AGE_MS = 60_000;
const AGREE = 0.015;
const TIMEOUT_MS = 5_000;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const num = (v) => (typeof v === 'number' || typeof v === 'string') && Number.isFinite(Number(v)) && Number(v) > 0
  ? Number(v) : null;

const SOURCES = Object.freeze([
  { name: 'jupiter', url: 'https://api.jup.ag/price/v3?ids=' + SOL_MINT,
    read: (j) => num(j && j[SOL_MINT] && j[SOL_MINT].usdPrice) },
  { name: 'coinbase', url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot',
    read: (j) => (j && j.data && j.data.currency === 'USD' ? num(j.data.amount) : null) },
  { name: 'coingecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    read: (j) => num(j && j.solana && j.solana.usd) },
]);

function priceWait(why) {
  const e = new Error('The SOL price is not available right now (' + why + '). Try again in a moment.');
  e.code = PRICE_WAIT;
  return e;
}

function createSolPrice({ fetchImpl = globalThis.fetch, now = Date.now, sources = SOURCES, log = console,
                          pollMs = POLL_MS, maxAgeMs = MAX_AGE_MS, agree = AGREE } = {}) {
  const last = new Map();                   // source name -> { usd, at }
  let timer = null;

  async function readOne(src) {
    try {
      const headers = { accept: 'application/json' };
      // Jupiter's host takes the same key as the swap (JUP_API_KEY) when there is one; keyless works today
      if (src.name === 'jupiter' && process.env.JUP_API_KEY) headers['x-api-key'] = process.env.JUP_API_KEY;
      const r = await fetchImpl(src.url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers });
      if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
      const usd = src.read(await r.json());
      if (usd === null) throw new Error('no price in the reply');
      last.set(src.name, { usd, at: now() });
    } catch (e) {
      // keep the previous reading; it simply ages out after maxAgeMs
      if (log && log.warn) log.warn('[PRICE] ' + src.name + ': ' + (e && e.message));
    }
  }
  function poll() { return Promise.all(sources.map(readOne)); }

  /* -> { usd, sources: n, at } or throws PRICE_WAIT. Pure over the readings held. */
  function current() {
    const t = now();
    const fresh = [];
    for (const [, r] of last) if (t - r.at <= maxAgeMs && t - r.at >= -5000) fresh.push(r);
    if (fresh.length < 2) throw priceWait(fresh.length ? 'one source' : 'no source');
    /* The largest run of readings whose highest is within 1.5 percent of its lowest (so two sources 2 percent
       apart never agree, and one outlier among three is outvoted). Ties prefer the run nearer the middle. */
    const sorted = fresh.slice().sort((x, y) => x.usd - y.usd);
    let best = null;
    for (let i = 0; i < sorted.length; i++) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1].usd / sorted[i].usd - 1 <= agree) j++;
      if (j > i && (!best || j - i > best[1] - best[0])) best = [i, j];
    }
    if (!best) throw priceWait('sources disagree');
    const run = sorted.slice(best[0], best[1] + 1);
    const n = run.length;
    const usd = n % 2 ? run[(n - 1) / 2].usd : (run[n / 2 - 1].usd + run[n / 2].usd) / 2;
    return { usd, sources: n, at: Math.min(...run.map((r) => r.at)) };
  }
  function usdPerSol() { return current().usd; }
  // Never throws: for display only (the lobby's $ beside a SOL balance). null when there is no good rate.
  function peek() { try { return current().usd; } catch (_) { return null; } }

  function start() {
    if (timer) return;
    poll();
    timer = setInterval(poll, pollMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { start, stop, poll, current, usdPerSol, peek, _last: last };
}

/* Dollar <-> lamport conversion, integer-exact on the lamport side. Stakes round UP (the escrow receives at least
   the dollars it now owes), payouts round DOWN (the escrow never sends more than the dollars it owes). */
function lamportsUp(usd, rate) {
  const v = Number(usd), r = Number(rate);
  if (!(v >= 0) || !(r > 0)) throw new Error('bad conversion');
  // micro-dollars first, so 0.5 is exactly 500000 and float noise cannot add a lamport
  const micro = BigInt(Math.round(v * 1e6));
  const rateMicro = BigInt(Math.round(r * 1e6));          // micro-dollars per SOL
  return Number((micro * 1_000_000_000n + rateMicro - 1n) / rateMicro);
}
function lamportsDown(usd, rate) {
  const v = Number(usd), r = Number(rate);
  if (!(v >= 0) || !(r > 0)) throw new Error('bad conversion');
  const micro = BigInt(Math.round(v * 1e6));
  const rateMicro = BigInt(Math.round(r * 1e6));
  return Number((micro * 1_000_000_000n) / rateMicro);
}
// lamports -> micro-dollars, rounded down (what a SOL amount is worth, never overstated)
function microDown(lamports, rate) {
  const l = BigInt(Math.floor(Number(lamports)));
  const rateMicro = BigInt(Math.round(Number(rate) * 1e6));
  if (l < 0n || rateMicro <= 0n) throw new Error('bad conversion');
  return Number((l * rateMicro) / 1_000_000_000n);
}

module.exports = { createSolPrice, lamportsUp, lamportsDown, microDown, PRICE_WAIT, SOURCES, MAX_AGE_MS, AGREE };
