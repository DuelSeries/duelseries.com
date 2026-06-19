// Fetches and caches the SOL/CAD exchange rate every 5 minutes
let _rate = 200; // fallback rate in case fetch fails

async function fetchRate() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=cad');
    const data = await res.json();
    if (data?.solana?.cad) {
      _rate = data.solana.cad;
      console.log(`[Prices] SOL/CAD rate updated: ${_rate}`);
    }
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

module.exports = { getSolCadRate, cadToSol, solToCad };
