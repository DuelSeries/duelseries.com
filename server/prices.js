// Fetches and caches the SOL/CAD exchange rate every 5 minutes
let _rate = 200; // fallback rate in case fetch fails
/* CAD per US dollar (USDC's CAD price), from the same call. Only reporting
   reads it: the public "paid out to players" total turns its pre-cutover CAD
   part into dollars with it. null until the first answer, and the total says
   nothing rather than guess at a rate. */
let _usdCad = null;

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

module.exports = { getSolCadRate, cadToSol, solToCad, getUsdCadRate };
