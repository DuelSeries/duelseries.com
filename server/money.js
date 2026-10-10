// Money backend abstraction. The game treats a player's "worth" as an opaque number; THIS module
// is the only place that knows whether that number is denominated in SOL or USDC. The active
// backend is chosen once at startup by the MONEY_MODE env var:
//   • MONEY_MODE=sol            -> native-SOL path (Wallet.js) — the pre-cutover behaviour.
//   • MONEY_MODE=usdc (DEFAULT) -> USDC SPL-token path (Usdc.js). Default flipped at the live
//     cutover (2026-06-24); set MONEY_MODE=sol to roll back instantly.
// The USDC code shipped dormant and was switched on at cutover by changing this default (no SSH
// access to set the env var on the servers), without ever deploying a broken-money intermediate.
const Wallet = require('./Wallet');
const Usdc   = require('./Usdc');
const prices = require('./prices');

const MODE = (process.env.MONEY_MODE || 'usdc').toLowerCase();

// Lobby entry fees. SOL mode prices them in CAD (then converts to SOL); USDC mode prices them in
// USD (which IS USDC, 1:1). Same lobby keys either way.
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

const solBackend = {
  mode: 'sol', unit: 'SOL', lobbyFees: FEES,
  feeFor: (t) => prices.cadToSol(FEES[t] || 0),                       // CAD fee -> SOL stake
  async stakeQuote(t) {
    const feeSol = prices.cadToSol(FEES[t] || 0);
    const { blockhash } = await Wallet.getLatestBlockhash();
    return { mode: 'sol', escrowAddress: Wallet.getEscrowPublicKey(), lamports: Math.round(feeSol * 1e9), feeSol, blockhash };
  },
  // Any-amount sibling of stakeQuote. Same shape; the amount comes from the
  // player rather than from the tier table. `amount` is in the fiat unit (CAD
  // here), matching FEES, and is converted to SOL the same way feeFor does.
  async stakeQuoteFor(amount) {
    const feeSol = prices.cadToSol(Number(amount) || 0);
    const { blockhash } = await Wallet.getLatestBlockhash();
    return { mode: 'sol', escrowAddress: Wallet.getEscrowPublicKey(), lamports: Math.round(feeSol * 1e9), feeSol, blockhash };
  },
  amountFor: (amount) => prices.cadToSol(Number(amount) || 0),
  async verifyStake(sig, expected) {                                  // expected = fee in SOL
    const minLamports = Math.round(expected * 1e9 * 0.95);            // tolerate 5% price slippage
    const { payer, lamports } = await Wallet.verifyStakeTransfer(sig, minLamports);
    return { payer, worth: lamports / 1e9 };
  },
  withdraw:      (addr, amt) => Wallet.withdraw(addr, amt),
  allowAccountRentFor: () => {},                                      // SOL has no token account
  attemptPayout: (row, fn)   => Wallet.attemptPayout(row, fn),
  escrowBalance: ()          => Wallet.getEscrowBalance(),
  balanceOf:     (addr)      => Wallet.getAddressBalance(addr),
  fiatValue:     (amt)       => amt * prices.getSolCadRate(),         // SOL -> CAD (for earnings)
  usdcMint:      null, decimals: 9,
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
    const { payer, usdc } = await Usdc.verifyUsdcStake(sig, expected);
    return { payer, worth: usdc };
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

const money = (MODE === 'usdc') ? usdcBackend : solBackend;
console.log(`[MONEY] mode: ${money.mode.toUpperCase()} (worth denominated in ${money.unit})`);
module.exports = money;
