'use strict';
/* ─── Proving an owner action came from the owner ─────────────────────────────
   Every owner control — starting the nightly match, spawning bots, putting the
   game into maintenance — is authorised the same way: a signature from the owner
   wallet over a message naming the exact action and the moment.

   WHY NOT THE PRIVY TOKEN. It is what owner auth used before and it is what
   stopped working. The token has to be minted by Privy, verified against Privy's
   keys, and matched to an app id held in an env var on the box; three things
   that must all be right, one of which cannot be inspected from outside, and
   when any of them is wrong the failure is a flat 401 that says nothing. Owen
   sat locked out of his own name field because of it.

   A signature needs none of that. The owner wallet address is a constant in the
   code, ed25519 verification is local arithmetic, and there is no network call,
   no shared secret, no expiry and no rate limit. If the server is running, this
   works.

   It is also stronger. The message names the action, its arguments and the
   second it was signed, so a captured signature cannot be replayed, re-aimed at
   a different action, or used to spawn a hundred bots out of one request to
   spawn five.

   The token path is kept alongside it, because it still works when Privy is
   configured correctly and there is no reason to break something that works. */

const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
// bs58 v6 is ESM-first: a plain require gives { default }, and reaching straight
// for .decode gets undefined. Same unwrap Wallet.js and Usdc.js use.
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;

const WINDOW_MS = 2 * 60 * 1000;

/* The exact string the browser signs. Built here and in exactly one place in
   the client; any drift between the two and every signature fails.

   The arguments are IN the message. Signing only the action name would let a
   captured "spawn bots" signature be resent asking for a thousand. */
function actionMessage(action, args, wallet, ts) {
  return 'DuelSeries owner action\n'
       + 'action: ' + action + '\n'
       + 'args: ' + JSON.stringify(args || {}) + '\n'
       + 'wallet: ' + wallet + '\n'
       + 'at: ' + ts;
}

const used = new Map();
function spend(sig, now) {
  for (const [k, at] of used) if (now - at > WINDOW_MS) used.delete(k);
  if (used.has(sig)) return false;
  used.set(sig, now);
  return true;
}

/* Returns the wallet that signed this action, or null. Does NOT decide whether
   that wallet is an owner — the caller holds the owner list. */
function walletForAction(body, now) {
  now = now || Date.now();
  const wallet = String((body && body.wallet) || '').trim();
  const sig    = String((body && body.sig) || '').trim();
  const action = String((body && body.action) || '');
  const ts     = Number(body && body.ts);
  const args   = (body && body.args) || {};
  if (!wallet || !sig || !action || !ts || !isFinite(ts)) return null;
  if (Math.abs(now - ts) > WINDOW_MS) return null;
  try {
    const pub = bs58.decode(wallet);
    if (pub.length !== 32) return null;
    const msg = new TextEncoder().encode(actionMessage(action, args, wallet, ts));
    if (!ed25519.verify(bs58.decode(sig), msg, pub)) return null;
  } catch (_) { return null; }
  // Verified BEFORE it is spent, so a bad signature cannot burn a good one.
  if (!spend(sig, now)) return null;
  return wallet;
}

/* ── the audit log ──────────────────────────────────────────────────────────
   Every owner action that actually ran, in memory, newest first. Not a
   compliance artifact — a way to answer "why is the game in maintenance" and
   "who spawned forty bots" without reading a terminal. */
const auditLog = [];
function audit(action, args, who, ok, note) {
  auditLog.unshift({
    at: Date.now(), action,
    args: args && Object.keys(args).length ? args : undefined,
    who: who ? who.slice(0, 4) + '…' + who.slice(-4) : 'unknown',
    ok: !!ok, note: note || undefined,
  });
  if (auditLog.length > 200) auditLog.length = 200;
}

module.exports = { actionMessage, walletForAction, audit, auditLog, WINDOW_MS };
