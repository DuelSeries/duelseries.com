// Money backend abstraction. The game treats a player's "worth" as an opaque number; THIS module
// is the only place that knows whether that number is denominated in SOL or USDC. The active
// backend is chosen once at startup by the MONEY_MODE env var:
//   • MONEY_MODE=sol            -> native SOL (Wallet.js), games still counting in dollars (solBackend below,
//     Owen's move back to SOL, 2026-10-17). Every amount crossing this module is dollars in BOTH modes.
//   • MONEY_MODE=usdc           -> USDC SPL-token path (Usdc.js), the default 2026-06-24 to 2026-10-21. Default flipped at the live
//     cutover (2026-06-24). Flipping between the two is the rollback switch: nothing in play changes unit.
// The USDC code shipped dormant and was switched on at cutover by changing this default (no SSH
// access to set the env var on the servers), without ever deploying a broken-money intermediate.
const Wallet = require('./Wallet');
const Usdc   = require('./Usdc');

/* Default flipped to SOL on switch night, 2026-10-21 (Owen: "everything swapped back to SOL"; runbook
   docs/sol-switch-runbook.md). MONEY_MODE=usdc in .env, or this default back to 'usdc', is the rollback. */
const MODE = (process.env.MONEY_MODE || 'sol').toLowerCase();

// Lobby entry fees, in dollars in both modes (SOL mode converts them to lamports at the quote).
/* br is the nightly Battle Royale and it costs nothing to enter — the prize
   comes from the house. It has to be IN this table even so, because the table is
   what validates a lobby type: without it the stake quote answered 'Unknown
   lobby' and the game never launched. At zero it takes the free path here and is
   refused outright by /api/submit-stake, which is exactly right: there is no
   such thing as staking into a battle royale. */
/* dime (0.10) was retired with the ten cent rung (BACKLOG 2.1, Owen 2026-10-09): ten cents could
   not cover what a paid room costs to run. Gone from this table, a quote for it answers 'Unknown
   lobby' and a submit 'Not a paid lobby', both before any wallet prompt or broadcast. The
   buy-ins every game offers are the ladder (shared/stakeLadder.js); dollar is the old $1 tier
   room, kept as it was. */
const FEES = { free: 0, br: 0, dollar: 1.00 };

/* SOL mode (Owen 2026-10-17: "everything swapped back to SOL"). Games still count in DOLLARS, exactly as in
   USDC mode: every amount this backend is handed or answers is dollars, so entry tokens, banks, payout rows,
   rake rows, earnings and every screen are unchanged. SOL exists only here, at the doors:
     in : a stake quote converts its dollars to lamports at a fresh two-source rate (server/solPrice.js) and
          remembers that rate under the quote's blockhash; the verify prices what landed at the same rate.
     out: a payout converts its dollars to lamports at the rate of the moment it is built (rounded down).
   No good rate means no new quote and no new payout transaction (PRICE_WAIT: the payout waits as an owed row).
   The old SOL backend priced in CAD with a 200 CAD guess when it had no rate; it is gone. */
const solPrice = require('./solPrice');
const { lamportsUp, lamportsDown, microDown, PRICE_WAIT } = solPrice;
const price = solPrice.createSolPrice();
/* blockhash -> the rate its first quote used. Kept for 10 minutes (a blockhash is valid for about 90 s). A
   second quote on the same blockhash reuses that rate, so every quote built from one blockhash asks for lamports
   at one rate and the verify can never price an honest stake above what its quote asked. */
const QUOTE_RATE_MS = 10 * 60 * 1000;
const quoteRates = new Map();
function rateForQuote(blockhash) {
  const t = Date.now();
  for (const [bh, q] of quoteRates) { if (t - q.at > QUOTE_RATE_MS) quoteRates.delete(bh); else break; }
  const had = quoteRates.get(blockhash);
  if (had) return had.usd;
  const usd = price.usdPerSol();                        // throws PRICE_WAIT
  quoteRates.set(blockhash, { usd, at: t });
  return usd;
}
async function solQuote(usd) {
  price.usdPerSol();                                    // no good price: PRICE_WAIT (503) before any chain read
  const { blockhash } = await Wallet.getLatestBlockhash();
  const rate = rateForQuote(blockhash);
  const lamports = lamportsUp(usd, rate);
  return { mode: 'sol', escrowAddress: Wallet.getEscrowPublicKey(), lamports, feeSol: lamports / 1e9,
           amountUsd: usd, rate, blockhash };
}
const solBackend = {
  mode: 'sol', unit: 'USD', payUnit: 'SOL', lobbyFees: FEES,
  feeFor: (t) => FEES[t] || 0,                                        // dollars, as in USDC mode
  stakeQuote: (t) => solQuote(FEES[t] || 0),
  stakeQuoteFor: (amount) => solQuote(Number(amount) || 0),
  amountFor: (amount) => Number(amount) || 0,
  /* expected is dollars. What landed is priced at its quote's rate (the blockhash it was built on); a stake whose
     quote this process no longer remembers (a restart in between) is priced at the rate now. Covered -> worth is
     exactly `expected` (the overpay of under a lamport stays in escrow, as an overpay does in USDC mode). Short ->
     throws 'Stake too small' carrying what landed in dollars (e.landedUsd, e.payer), so a late stake's refund pays
     back what landed instead of nothing (server/index.js owedForLateStake). */
  // blockTime (when it landed) rides the answer and the 'too small' error alike (night review 2026-10-29, finding 0)
  async verifyStake(sig, expected) {
    const { payer, lamports, blockhash, blockTime } = await Wallet.verifyStakeTransfer(sig, 0);
    const q = quoteRates.get(blockhash);
    const rate = q ? q.usd : price.usdPerSol();
    const need = lamportsUp(expected, rate);
    if (lamports < need) {
      const e = new Error(`Stake too small (${lamports} < ${need} lamports)`);
      e.landedUsd = lamports > 0 ? microDown(lamports, rate) / 1e6 : 0;
      e.payer = payer;
      e.blockTime = blockTime;
      throw e;
    }
    return { payer, worth: Number(expected), lamports, rate, blockTime };
  },
  // Dollars out, converted when the transaction is built (Wallet.buildSignedPayout refuses dust to an empty wallet).
  // async: with no price the conversion REJECTS (never throws synchronously), so every caller's .catch records the
  // owed row (Fable review 2026-10-21, finding 1)
  // opts.beforeSend: saves the signed bytes on the caller's owed row first (Wallet.withdraw, server/inlinePayout.js)
  async withdraw(addr, usd, opts) {
    return Wallet.withdraw(addr, null, { lamports: lamportsDown(usd, price.usdPerSol()), beforeSend: opts && opts.beforeSend });
  },
  allowAccountRentFor: () => {},                                      // SOL has no token account
  attemptPayout: (row, fn) => Wallet.attemptPayout(row, fn, (r) => lamportsDown(r.amount_sol, price.usdPerSol())),
  // In dollars at the rate now, so solvency compares like with like. Throws PRICE_WAIT without a rate.
  async escrowBalance() { const sol = await Wallet.getEscrowBalance(); return sol * price.usdPerSol(); },
  async escrowSol() { return Wallet.getEscrowBalance(); },
  async balanceOf(addr) { const sol = await Wallet.getAddressBalance(addr); return sol * price.usdPerSol(); },
  fiatValue:     (amt)       => amt,                                  // dollars already
  waitCode: PRICE_WAIT,
  price,
  usdcMint:      Usdc.USDC_MINT.toString(), decimals: 6,              // the convert-old-USDC line still needs the mint
};
const usdcBackend = {
  mode: 'usdc', unit: 'USDC', lobbyFees: FEES,
  feeFor: (t) => FEES[t] || 0,                                        // USD fee = USDC stake
  async stakeQuote(t) {
    const fee = FEES[t] || 0;
    const { blockhash } = await Usdc.getLatestBlockhash();
    return { mode: 'usdc', ...Usdc.stakeTargets(), amountUsdc: fee, units: Usdc.toUnits(fee).toString(), blockhash };
  },
  // Any-amount sibling of stakeQuote. In USDC mode the unit already is dollars,
  // so the amount passes straight through.
  async stakeQuoteFor(amount) {
    const fee = Number(amount) || 0;
    const { blockhash } = await Usdc.getLatestBlockhash();
    return { mode: 'usdc', ...Usdc.stakeTargets(), amountUsdc: fee, units: Usdc.toUnits(fee).toString(), blockhash };
  },
  amountFor: (amount) => Number(amount) || 0,
  /* No tolerance (review finding, night queue item 5). The quote is exact integer units and
     the widget signs exactly quote.units, so an honest stake lands exactly `expected`. The old
     99 percent floor let a hand-built transfer of 99000 units buy a 100000-unit seat (0.995 a
     $1 seat): 1 percent off every entry, paid by escrow at every cash-out. SOL mode keeps its
     price-slippage tolerance, since its amount is a conversion. */
  async verifyStake(sig, expected) {                                  // expected = fee in USDC
    const { payer, usdc, blockTime } = await Usdc.verifyUsdcStake(sig, expected);
    return { payer, worth: usdc, blockTime };
  },
  // opts.payRent: escrow may create a missing recipient USDC account (Usdc.js explains when).
  withdraw:      (addr, amt, opts) => Usdc.withdrawUsdc(addr, amt, opts),
  allowAccountRentFor: (addr) => Usdc.allowAccountRentFor(addr),
  attemptPayout: (row, fn)   => Usdc.attemptPayout(row, fn),
  escrowBalance: ()          => Usdc.escrowUsdcBalance(),
  balanceOf:     (addr)      => Usdc.usdcBalanceOf(addr),
  fiatValue:     (amt)       => amt,                                  // USDC = USD already
  usdcMint:      Usdc.USDC_MINT.toString(), decimals: Usdc.USDC_DECIMALS,
};

const money = (MODE === 'sol') ? solBackend : usdcBackend;
// SOL_PRICE_POLL=off: tests seed readings by hand and never touch the network
if (money.mode === 'sol' && process.env.SOL_PRICE_POLL !== 'off') price.start();
console.log(`[MONEY] mode: ${money.mode.toUpperCase()} (games count in dollars, paid in ${money.payUnit || money.unit})`);
module.exports = money;
