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
const FEES = { free: 0, dime: 0.10, dollar: 1.00 };

const solBackend = {
  mode: 'sol', unit: 'SOL', lobbyFees: FEES,
  feeFor: (t) => prices.cadToSol(FEES[t] || 0),                       // CAD fee -> SOL stake
  async stakeQuote(t) {
    const feeSol = prices.cadToSol(FEES[t] || 0);
    const { blockhash } = await Wallet.getLatestBlockhash();
    return { mode: 'sol', escrowAddress: Wallet.getEscrowPublicKey(), lamports: Math.round(feeSol * 1e9), feeSol, blockhash };
  },
  async verifyStake(sig, expected) {                                  // expected = fee in SOL
    const minLamports = Math.round(expected * 1e9 * 0.95);            // tolerate 5% price slippage
    const { payer, lamports } = await Wallet.verifyStakeTransfer(sig, minLamports);
    return { payer, worth: lamports / 1e9 };
  },
  withdraw:      (addr, amt) => Wallet.withdraw(addr, amt),
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
  async verifyStake(sig, expected) {                                  // expected = fee in USDC
    const { payer, usdc } = await Usdc.verifyUsdcStake(sig, expected * 0.99); // tiny rounding tolerance
    return { payer, worth: usdc };
  },
  withdraw:      (addr, amt) => Usdc.withdrawUsdc(addr, amt),
  attemptPayout: (row, fn)   => Usdc.attemptPayout(row, fn),
  escrowBalance: ()          => Usdc.escrowUsdcBalance(),
  balanceOf:     (addr)      => Usdc.usdcBalanceOf(addr),
  fiatValue:     (amt)       => amt,                                  // USDC = USD already
  usdcMint:      Usdc.USDC_MINT.toString(), decimals: Usdc.USDC_DECIMALS,
};

const money = (MODE === 'usdc') ? usdcBackend : solBackend;
console.log(`[MONEY] mode: ${money.mode.toUpperCase()} (worth denominated in ${money.unit})`);
module.exports = money;
