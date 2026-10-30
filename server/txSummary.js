/* What a player-signed transaction moves, read off its own bytes, for analytics only (server/analytics.js): the
   withdraws and linked-wallet adds that /api/broadcast relays. Plain SOL transfers (System Program Transfer) and
   token transfers (SPL Token or Token-2022 Transfer / TransferChecked) are summed; anything else is ignored.
   Read AFTER the transaction landed, so the numbers are what the chain took. Never throws (null on anything odd),
   and nothing here decides money: it only describes it. */
const { VersionedTransaction } = require('@solana/web3.js');

const SYSTEM = '11111111111111111111111111111111';
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);

function u64(buf, at) {
  if (!buf || buf.length < at + 8) return null;
  return Number(Buffer.from(buf).readBigUInt64LE(at));
}

/* bytes: the signed transaction (Buffer or Uint8Array). -> { payer, lamports, to, token: { amount, decimals } | null }
   lamports: SOL leaving the fee payer by plain transfers; to: the first SOL receiver; token.amount in raw units
   (decimals from TransferChecked, else null). */
function summarize(bytes) {
  try {
    const tx = VersionedTransaction.deserialize(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const m = tx.message;
    const keys = (m.staticAccountKeys || []).map((k) => k.toBase58());
    if (!keys.length) return null;
    const out = { payer: keys[0], lamports: 0, to: null, token: null };
    for (const ix of m.compiledInstructions || []) {
      const prog = keys[ix.programIdIndex];
      const data = Buffer.from(ix.data || []);
      const acc = ix.accountKeyIndexes || [];
      if (prog === SYSTEM && data.length >= 12 && data.readUInt32LE(0) === 2) {
        const n = u64(data, 4);
        if (n == null) continue;
        out.lamports += n;
        if (!out.to && acc.length > 1) out.to = keys[acc[1]] || null;
      } else if (TOKEN_PROGRAMS.has(prog) && (data[0] === 3 || data[0] === 12)) {
        const n = u64(data, 1);
        if (n == null) continue;
        const decimals = data[0] === 12 && data.length >= 10 ? data[9] : null;
        out.token = { amount: (out.token ? out.token.amount : 0) + n, decimals: decimals != null ? decimals : out.token && out.token.decimals };
      }
    }
    return out;
  } catch (_) { return null; }
}

module.exports = { summarize };
