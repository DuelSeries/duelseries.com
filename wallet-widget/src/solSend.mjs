/* The SOL Withdraw transaction (withdraw fee review 2026-11-05), apart from main.jsx so test/withdrawFees.test.js
   can build the very transaction the wallet signs and read the fee off it.

   One instruction, a System transfer of exactly `lamports`, paid for by the sender, and no ComputeBudget
   instruction: so the network charges the base fee of its one signature (5000 lamports) and no priority fee. That is
   SEND_FEE_LAMPORTS in solReserve.mjs, the figure the lobby's Max and both balance checks take off. Add an
   instruction that sets a priority fee, or a second signer, and the fee changes: the test fails until
   SEND_FEE_LAMPORTS says what the withdraw really costs. */
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

// lamports: a whole number of lamports, more than zero (never a float of SOL: the amount signed is exact).
export function buildSolTransfer(fromAddress, toAddress, lamports, blockhash) {
  if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new Error('Enter an amount to send.');
  let toPub;
  try { toPub = new PublicKey(toAddress); } catch (_) { throw new Error("That doesn't look like a valid Solana address."); }
  const from = new PublicKey(fromAddress);
  const tx = new Transaction();
  tx.feePayer = from;
  tx.recentBlockhash = blockhash;
  tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: toPub, lamports }));
  return tx;
}
