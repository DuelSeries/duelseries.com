'use strict';
/* ─── Send the house wallets home ─────────────────────────────────────────────
   Owen 2026-11-24, closing DuelSeries: Control's "Send house wallets to my
   Coinbase". The Bot bank and the Escrow are wallets only the server holds the
   keys to; this moves each one's SOL, less its own network fee, to one address
   the owner types, one transfer per wallet.

   - Nothing moves without the owner. preview() only reads. send() needs the
     owner's request carrying the exact lamports the preview showed him, and a
     balance that changed in between is refused, so the confirm he clicked is
     the transfer that happens.
   - Never while players have money here: the guard (index.js) refuses while the
     site is open, a stake is in play or a payout is unpaid.
   - One send at a time; a second click while one runs is refused, and a repeat
     after it finished finds the wallets empty and its amounts stale.
   - SOL only. USDC in either wallet is shown and left where it is. */

const { PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');

const FEE_LAMPORTS = 5000; // one signature, no priority fee

function createHouseSweep({ conn, withRetry = (f) => f(), wallets, usdcOf = null, guard = async () => null,
  defaultTo = '', log = console } = {}) {
  if (!conn || typeof wallets !== 'function') throw new Error('houseSweep: conn and wallets are required');
  let running = false;

  async function read() {
    const rows = [];
    for (const w of wallets()) {
      const lamports = await withRetry(() => conn.getBalance(w.keypair.publicKey, 'confirmed'));
      let usdc = null;
      if (usdcOf) { try { usdc = await usdcOf(w.keypair.publicKey.toBase58()); } catch (_) { usdc = null; } }
      const send = lamports > FEE_LAMPORTS ? lamports - FEE_LAMPORTS : 0;
      rows.push({ key: w.key, name: w.name, address: w.keypair.publicKey.toBase58(), lamports, send,
        fee: send ? FEE_LAMPORTS : 0, usdc, keypair: w.keypair });
    }
    return rows;
  }
  const shown = (rows) => rows.map(({ keypair, ...r }) => r);

  function destination(to) {
    let pk;
    try { pk = new PublicKey(String(to || '').trim()); } catch (_) { return { why: 'That is not a Solana address.' }; }
    if (!PublicKey.isOnCurve(pk.toBytes())) return { why: 'That is not a normal wallet address.' };
    return { pk };
  }

  async function preview() {
    const why = await guard();
    const rows = await read();
    return { ok: !why, why: why || null, fee: FEE_LAMPORTS, defaultTo, wallets: shown(rows) };
  }

  async function send({ to, expect } = {}) {
    if (running) return { ok: false, why: 'A send is already running.' };
    const d = destination(to);
    if (d.why) return { ok: false, why: d.why };
    running = true;
    try {
      const why = await guard();
      if (why) return { ok: false, why };
      const rows = await read();
      const dest = d.pk.toBase58();
      if (rows.some((r) => r.address === dest)) return { ok: false, why: 'That is one of the house wallets.' };
      const want = expect && typeof expect === 'object' ? expect : {};
      for (const r of rows) {
        if (Number(want[r.key]) !== r.send) {
          return { ok: false, why: 'The ' + r.name + ' balance changed since you looked. Look again.', wallets: shown(rows) };
        }
      }
      if (!rows.some((r) => r.send > 0)) return { ok: false, why: 'Both wallets are empty.' };
      const results = [];
      for (const r of rows) {
        if (!r.send) { results.push({ key: r.key, name: r.name, sent: 0, sig: null, skipped: true }); continue; }
        let sig = null;
        try {
          const { blockhash, lastValidBlockHeight } = await withRetry(() => conn.getLatestBlockhash('confirmed'));
          const tx = new Transaction({ feePayer: r.keypair.publicKey, blockhash, lastValidBlockHeight })
            .add(SystemProgram.transfer({ fromPubkey: r.keypair.publicKey, toPubkey: d.pk, lamports: r.send }));
          tx.sign(r.keypair);
          sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
          const c = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
          if (c && c.value && c.value.err) throw new Error('refused on chain: ' + JSON.stringify(c.value.err));
          log.warn('[SWEEP] ' + r.name + ' sent ' + r.send + ' lamports to ' + dest + ' sig ' + sig);
          results.push({ key: r.key, name: r.name, sent: r.send, sig });
        } catch (e) {
          const msg = (e && e.message) || 'send failed';
          log.error('[SWEEP] ' + r.name + (sig ? ' sent but not confirmed (' + sig + '): ' : ' NOT sent: ') + msg);
          results.push({ key: r.key, name: r.name, sent: sig ? r.send : 0, sig, unconfirmed: !!sig, error: msg });
        }
      }
      return { ok: results.every((x) => !x.error), to: dest, results };
    } finally {
      running = false;
    }
  }

  return { preview, send };
}

module.exports = { createHouseSweep, FEE_LAMPORTS };
