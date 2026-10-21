/* The payment for one skin (docs/skin-purchases.md), built from the server's quote (POST /api/skins/intent) and
   nothing else: exactly the two instructions server/skinShop.js paymentProblem accepts, a USDC transferChecked of
   the quoted units from the player's own USDC account to the shop's, and a memo naming the purchase. The server
   refuses any other shape before broadcasting, so a page that built something else would move no money.
   Unsigned bytes out; the wallet signs them (main.jsx duelWalletSignSkin). */
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createTransferCheckedInstruction } from '@solana/spl-token';

const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/* opts (SOL mode): payTo, the only address a SOL skin payment may go to (the revenue wallet from /api/money-config),
   and maxLamports, a ceiling on what one skin may cost. A quote naming anywhere else, or more, is refused before the
   wallet is asked, so a script on the page cannot use this to sign away the balance (Fable review 2026-10-21). */
export function buildSkinPayment(quote, walletAddress, opts) {
  const q = quote || {};
  if (!walletAddress) throw new Error('Connect your wallet first.');
  if (typeof q.ref !== 'string' || typeof q.memo !== 'string' || q.memo !== 'ds-skin:' + q.ref) throw new Error('Bad quote');
  if (q.memoProgram && q.memoProgram !== MEMO_PROGRAM) throw new Error('Bad quote');
  if (!/^[0-9]+$/.test(String(q.units || '')) || BigInt(q.units) <= 0n) throw new Error('Bad quote');
  const from = new PublicKey(walletAddress);
  if (q.asset === 'sol') {
    const o = opts || {};
    if (!o.payTo || q.payTo !== o.payTo) throw new Error('Bad quote');
    if (!(Number(o.maxLamports) > 0) || BigInt(q.units) > BigInt(Math.floor(Number(o.maxLamports)))) throw new Error('Bad quote');
    // SOL mode: one plain SOL transfer of exactly the quoted lamports to the shop's wallet, and the memo
    const tx = new Transaction();
    tx.feePayer = from;
    tx.recentBlockhash = q.blockhash;
    tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(q.payTo), lamports: BigInt(q.units) }));
    tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: new TextEncoder().encode(q.memo) }));
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  }
  if (q.decimals !== 6) throw new Error('Bad quote');
  const mint = new PublicKey(q.mint);
  const tx = new Transaction();
  tx.feePayer = from;
  tx.recentBlockhash = q.blockhash;
  tx.add(createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, from), mint, new PublicKey(q.payTo), from, BigInt(q.units), 6));
  tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: new TextEncoder().encode(q.memo) }));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}
