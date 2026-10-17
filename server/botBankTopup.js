'use strict';
// A bot bank top-up (Owen 2026-10-17): the owner, in Control, pastes the signature of a plain USDC transfer INTO
// escrow from any sender (his revenue wallet, his Coinbase account, ...), and the transferred amount is credited.
// Checks, in order, nothing credited unless all pass:
//   1 the signature's shape, and not already in the bot bank
//   2 the chain: a confirmed transaction that raised escrow's USDC by at least 0.01 (verify; the amount credited is
//     exactly that rise) and the wallets whose USDC went down in it (senders), plus the fee payer
//   3 no sender and no fee payer is a player's game wallet (isPlayerWallet), the owner's own wallets excepted: a
//     player's stake to escrow can never become bot money
//   4 the signature is claimed once in the stakes' one-time table (markStakeSig): a player stake already submitted (its
//     verify claims the same table first) or a top-up already used is refused
// The caller (the owner action) is the owner check. -> { ok: true, micro } or { ok: false, why }

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

async function verifyTopup(sig, { verify, isPlayerWallet, markStakeSig, botBank, ownerWallets = [] }) {
  const s = typeof sig === 'string' ? sig.trim() : '';
  if (!SIG_RE.test(s)) return { ok: false, why: 'Paste the transaction signature of the transfer to escrow' };
  if (botBank.hasTopup(s)) return { ok: false, why: 'That transfer is already in the bot bank' };
  let v;
  try {
    v = await verify(s, 0.01);
  } catch (e) {
    return { ok: false, why: 'Not verified: ' + String(e && e.message).slice(0, 160) };
  }
  const micro = Math.round(Number(v && v.usdc) * 1e6);
  if (!Number.isSafeInteger(micro) || micro < 1) return { ok: false, why: 'Not verified: no USDC reached escrow' };
  const who = Array.from(new Set([v.payer].concat(Array.isArray(v.senders) ? v.senders : []).filter(Boolean)));
  for (const w of who) {
    if (ownerWallets.includes(w)) continue;
    let player = true;
    try {
      player = await isPlayerWallet(w);
    } catch (e) {
      return { ok: false, why: 'Could not check the sender (database): ' + String(e && e.message).slice(0, 120) };
    }
    if (player) return { ok: false, why: 'That transfer came from a player wallet, so it is not bot money' };
  }
  let claimed = false;
  try {
    claimed = await markStakeSig(s);
  } catch (e) {
    return { ok: false, why: 'Could not claim the transfer (database): ' + String(e && e.message).slice(0, 120) };
  }
  if (!claimed) return { ok: false, why: 'That transfer was already used' };
  const c = botBank.credit(micro, s);
  if (!c.ok) return { ok: false, why: 'Claimed but not saved: ' + c.why, critical: true, micro };
  return { ok: true, micro };
}

module.exports = { verifyTopup };
