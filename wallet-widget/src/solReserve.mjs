/* SOL mode keeps a little SOL in the wallet (2026-10-21). A plain system account left holding less than
   its rent minimum (about 0.00089 SOL) is refused by the network, and a wallet down to a few thousand
   lamports cannot pay for its next transaction. So a stake or a send must leave at least 0.001 SOL
   behind AFTER the amount and the network fee, or it does not start. Lamports throughout, integers.

   Pure, so test/solReserve.test.js can check it; public/js/v2/wallet.js repeats the two constants for
   its Max button (the widget stays the authority: it re-checks every send against a fresh balance). */

export const KEEP_LAMPORTS = 1_000_000;        // 0.001 SOL stays in the wallet
export const SEND_FEE_LAMPORTS = 5000;         // the base fee of a plain transfer (one signature, no priority fee: solSend.mjs)
/* The receiving side (withdraw fee review 2026-11-05): a plain account the network has never seen must be given at
   least its rent minimum (890,880 lamports for an account with no data, Rent::default().minimum_balance(0)), or the
   whole transfer fails on chain with "insufficient funds for rent". The destination is not read (that costs a
   provider call per withdraw), so every SOL withdraw is at least 0.001 SOL, which clears it for any address. */
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880;
export const MIN_SEND_LAMPORTS = 1_000_000;    // 0.001 SOL, the smallest SOL withdraw

/* True when spending `spendLamports` plus `feeLamports` still leaves KEEP_LAMPORTS or more. */
export function leavesReserve(balanceLamports, spendLamports, feeLamports) {
  const have = Number(balanceLamports), spend = Number(spendLamports), fee = Number(feeLamports);
  if (![have, spend, fee].every(Number.isFinite) || spend < 0 || fee < 0) return false;
  return have - spend - fee >= KEEP_LAMPORTS;
}

/* The most a SOL send may carry: the balance less the reserve and the fee. Never negative. */
export function maxSendLamports(balanceLamports) {
  const have = Math.floor(Number(balanceLamports));
  if (!Number.isFinite(have)) return 0;
  return Math.max(0, have - KEEP_LAMPORTS - SEND_FEE_LAMPORTS);
}
