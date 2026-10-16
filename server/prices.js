// Fetches and caches the SOL/CAD exchange rate every 5 minutes
let _rate = 200; // fallback rate in case fetch fails
/* CAD per US dollar (USDC's CAD price), from the same call. Only reporting
   reads it: the public "paid out to players" total turns its pre-cutover CAD
   part into dollars with it. null until the first answer, and the total says
   nothing rather than guess at a rate. */
let _usdCad = null;
/* When both came from one answer, for the conversion's price check (server/swap.js): only a
   fetched rate is used there, never the fallback above, and only while it is recent. */
let _bothAt = 0;

async function fetchRate() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,usd-coin&vs_currencies=cad');
    const data = await res.json();
    if (data?.solana?.cad) {
      _rate = data.solana.cad;
      console.log(`[Prices] SOL/CAD rate updated: ${_rate}`);
    }
    const uc = Number(data?.['usd-coin']?.cad);
    if (uc > 0.5 && uc < 3) _usdCad = uc;           // a sane CAD-per-USD band, so one bad answer is ignored
    _bothAt = data?.solana?.cad > 0 && uc > 0.5 && uc < 3 ? Date.now() : _bothAt;
  } catch (e) {
    console.warn('[Prices] Rate fetch failed, using cached rate:', _rate);
  }
}

// Fetch immediately and then every 5 minutes. unref() so this timer alone never keeps the
// process alive (the server stays up via its http/game-loop handles) — lets tests + dev
// scripts that `require` this module exit cleanly.
fetchRate();
setInterval(fetchRate, 5 * 60 * 1000).unref?.();

function getSolCadRate() { return _rate; }
function cadToSol(cad) { return cad / _rate; }
function solToCad(sol) { return sol * _rate; }

function getUsdCadRate() { return _usdCad; }

// Dollars per SOL from a fetch in the last 15 minutes, else null.
function getSolUsdRate() {
  if (!_bothAt || Date.now() - _bothAt > 15 * 60 * 1000 || !(_usdCad > 0)) return null;
  return _rate / _usdCad;
}

/* Dollars per SOL around the moment `ms`, for the Wallet tab's SOL rows ("about $16.50"): today's
   from the 5-minute feed above, an earlier day's from CoinGecko's daily history (the price at
   00:00 UTC that day), kept for good since a past day's price never changes. null when neither
   is to be had; a failed day is not asked again for 10 minutes. */
const _dayPrice = new Map();   // 'dd-mm-yyyy' -> { usd } | { failedAt }
async function solUsdAt(ms) {
  const d = new Date(Number(ms));
  if (!isFinite(d.getTime())) return null;
  const now = new Date();
  const sameDay = d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth() && d.getUTCDate() === now.getUTCDate();
  if (sameDay) { const live = getSolUsdRate(); if (live) return live; }
  const key = String(d.getUTCDate()).padStart(2, '0') + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + d.getUTCFullYear();
  const hit = _dayPrice.get(key);
  if (hit && hit.usd) return hit.usd;
  if (hit && Date.now() - hit.failedAt < 10 * 60 * 1000) return null;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/coins/solana/history?date=' + key + '&localization=false',
      { signal: AbortSignal.timeout(5000) });
    const j = await res.json();
    const usd = Number(j?.market_data?.current_price?.usd);
    if (!(usd > 1 && usd < 100000)) throw new Error('no price');
    if (_dayPrice.size > 3000) _dayPrice.delete(_dayPrice.keys().next().value);
    _dayPrice.set(key, { usd });
    return usd;
  } catch (_) {
    _dayPrice.set(key, { failedAt: Date.now() });
    return null;
  }
}

module.exports = { getSolCadRate, cadToSol, solToCad, getUsdCadRate, getSolUsdRate, solUsdAt };
