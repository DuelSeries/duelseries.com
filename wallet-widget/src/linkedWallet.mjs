/* A browser wallet linked to a Google or email account (Owen 2026-10-26): Phantom, Solflare or Backpack as a way to
   move money in and out, never as the game wallet. The Privy wallet stays the one that stakes and holds the balance;
   the linked wallet is remembered on the Privy account (Privy SIWS link) and appears in two places only: a row in
   Add funds (one approval in the linked wallet sends SOL to the game wallet) and "To Phantom" in Withdraw (the
   ordinary withdraw, its address filled in).

   Pure where it can be, so test/linkedWallet.test.js checks the transfer exactly: from the linked wallet, to the
   player's own game wallet, the amount asked for and nothing else. */
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { accountFor, clientTypeOf, WALLETS } from './browserWallets.mjs';
import { KEEP_LAMPORTS, SEND_FEE_LAMPORTS, leavesReserve } from './solReserve.mjs';

/* A priority fee, so the network does not drop it (the stake's lesson, 2026-10-17); a plain transfer needs a few
   hundred compute units, so the limit and the fee stay tiny: 20000 * 100000 / 1e6 = 2000 lamports. */
export const ADD_CU_LIMIT = 20_000;
export const ADD_CU_PRICE = 100_000;   // micro-lamports per compute unit
export const ADD_FEE_LAMPORTS = SEND_FEE_LAMPORTS + Math.ceil(ADD_CU_LIMIT * ADD_CU_PRICE / 1e6);
/* The least one add may carry: 0.001 SOL. Less is dust, and a game wallet that holds nothing yet cannot be opened
   by a transfer under the network's rent minimum (about 0.00089 SOL). */
export const MIN_ADD_LAMPORTS = 1_000_000;

const isPrivy = (a) => /^privy/.test(String((a && a.walletClientType) || '')) || /^embedded/.test(String((a && a.connectorType) || ''));
const labelOf = (client) => ((WALLETS.find((k) => k.client === client) || {}).label) || 'your wallet';

/* The browser wallet linked to this account: the last linked Solana wallet that is not Privy's own and not the game
   wallet itself. null when there is none. */
export function linkedOf(user, gameAddress) {
  const accts = (user && user.linkedAccounts) || [];
  const linked = accts.filter((a) => a && a.type === 'wallet' && a.chainType === 'solana' && typeof a.address === 'string'
    && a.address && a.address !== gameAddress && !isPrivy(a));
  const a = linked[linked.length - 1];
  return a ? { address: a.address, clientType: a.walletClientType || 'unknown', name: labelOf(a.walletClientType) } : null;
}

/* Link a browser wallet to the signed-in account: its connect, Privy's SIWS link message signed in it, Privy links
   it. Resolves the address. */
export async function linkWith(std, { generateSiwsMessage, linkWithSiws, gameAddress }) {
  const acct = await accountFor(std, null);
  if (!acct) throw new Error(std.name + ' did not share a wallet. Unlock it and try again.');
  if (acct.address === gameAddress) throw new Error('That is your DuelSeries wallet itself. Pick a different wallet in ' + std.name + '.');
  const message = await generateSiwsMessage({ address: acct.address });
  const out = await std.features['solana:signMessage'].signMessage({ account: acct, message: new TextEncoder().encode(message) });
  const first = Array.isArray(out) ? out[0] : out;
  if (!first || !first.signature) throw new Error(std.name + ' did not sign.');
  let s = '';
  for (let i = 0; i < first.signature.length; i++) s += String.fromCharCode(first.signature[i]);
  try {
    await linkWithSiws({ message, signature: btoa(s), walletClientType: clientTypeOf(std), connectorType: 'solana_adapter' });
  } catch (e) {
    // Privy refuses a wallet that is already its own account (someone signed in with it before)
    if (/already|another user|linked to|account transfer|exists/i.test(String((e && e.message) || ''))) {
      throw new Error('This ' + std.name + ' wallet is already its own DuelSeries account. Sign in with it instead, or link a different wallet.');
    }
    throw e;
  }
  return acct.address;
}

/* Why this add cannot go, in plain words, or null. haveLamports: the linked wallet's SOL now (null: not read).
   A balance that could not be read is no reason to stop (night review 2026-10-29, third pass: a busy moment on the
   server's reads used to block every add): the linked wallet shows what it can send when it asks for approval, and
   the chain refuses an add it cannot cover. A balance that was read is checked as before. */
export function addProblem(haveLamports, lamports) {
  if (!Number.isInteger(lamports) || lamports <= 0) return 'Enter an amount to add.';
  if (lamports < MIN_ADD_LAMPORTS) return 'Add at least 0.001 SOL.';
  if (haveLamports == null || !Number.isFinite(Number(haveLamports))) return null;
  if (!leavesReserve(Number(haveLamports), lamports, ADD_FEE_LAMPORTS)) {
    return 'That is more than that wallet can send. It keeps 0.001 SOL for network fees.';
  }
  return null;
}

/* The most one add may carry from a wallet holding haveLamports: all of it less the reserve and the fee. */
export function maxAddLamports(haveLamports) {
  const have = Math.floor(Number(haveLamports));
  if (!Number.isFinite(have)) return 0;
  return Math.max(0, have - KEEP_LAMPORTS - ADD_FEE_LAMPORTS);
}

/* The transfer, unsigned: the priority fee, then exactly `lamports` from the linked wallet to the game wallet. The
   linked wallet pays the fee. Nothing else is in it. */
export function buildAdd({ from, to, lamports, blockhash }) {
  let fromKey, toKey;
  try { fromKey = new PublicKey(from); toKey = new PublicKey(to); } catch (_) { throw new Error('Bad wallet address.'); }
  if (fromKey.equals(toKey)) throw new Error('That is your DuelSeries wallet itself.');
  if (!Number.isInteger(lamports) || lamports < MIN_ADD_LAMPORTS) throw new Error('Add at least 0.001 SOL.');
  if (typeof blockhash !== 'string' || !blockhash) throw new Error('Network busy. Try again.');
  const tx = new Transaction();
  tx.feePayer = fromKey;
  tx.recentBlockhash = blockhash;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: ADD_CU_LIMIT }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ADD_CU_PRICE }));
  tx.add(SystemProgram.transfer({ fromPubkey: fromKey, toPubkey: toKey, lamports }));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}
