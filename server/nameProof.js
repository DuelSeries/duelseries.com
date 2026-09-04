'use strict';
/* ─── Proving a name change came from the wallet it claims ────────────────────
   The account IS a Solana wallet address in this product, so the strongest
   possible proof that a name change is yours is a signature from that wallet's
   own key. Nothing else has to be reachable or correctly configured for it to
   work: no app id, no shared secret, no third-party call, no token lifetime.

   That is the whole reason it exists. The Privy token path can fail for a
   mismatched app id, a rate limit, or an outage at Privy, and every one of those
   came back to the player as "your sign-in expired" — untrue, and nothing they
   could act on.

   It is not the weaker option for being simpler. The signed message names the
   wallet, the exact name and the moment, so a captured signature cannot be
   replayed for a different name, at a different time, or by anyone else.

   Its own module so the server and the tests share ONE copy. Mirroring this
   logic into a test would only ever prove the copy was right. */

const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
// bs58 v6 is ESM-first: a plain require gives { default }, and reaching straight
// for .encode gets undefined. Same unwrap Wallet.js and Usdc.js already use.
const bs58  = (_bs58 && _bs58.default) ? _bs58.default : _bs58;

const WINDOW_MS = 2 * 60 * 1000;

/* Exactly the string the browser signs. Any drift between the two ends and
   every signature fails, so it is built here and nowhere else; the widget holds
   the only other copy and this is the one it must match. */
function nameMessage(wallet, name, ts) {
  return 'DuelSeries: change display name\n'
       + 'wallet: ' + wallet + '\n'
       + 'name: ' + name + '\n'
       + 'at: ' + ts;
}

/* Signatures already spent. They fall out on their own once they are older than
   the window, so this cannot grow without bound. */
const used = new Map();
function spend(sig, now) {
  for (const [k, at] of used) if (now - at > WINDOW_MS) used.delete(k);
  if (used.has(sig)) return false;
  used.set(sig, now);
  return true;
}

/* Returns the wallet address this request proves it owns, or null.
   `now` is injectable so the time window can be tested without waiting. */
function verifyNameProof(body, now) {
  now = now || Date.now();
  const wallet = String((body && body.wallet) || '').trim();
  const sig    = String((body && body.sig) || '').trim();
  const ts     = Number(body && body.ts);
  const name   = String((body && body.name) || '');
  if (!wallet || !sig || !ts || !isFinite(ts)) return null;
  if (Math.abs(now - ts) > WINDOW_MS) return null;      // stale, or from the future
  try {
    const pub = bs58.decode(wallet);
    if (pub.length !== 32) return null;                 // not an ed25519 public key
    const msg = new TextEncoder().encode(nameMessage(wallet, name, ts));
    if (!ed25519.verify(bs58.decode(sig), msg, pub)) return null;
  } catch (_) { return null; }
  // Verified BEFORE it is spent, so a bad signature cannot burn a good one.
  if (!spend(sig, now)) return null;
  return wallet;
}

module.exports = { nameMessage, verifyNameProof, WINDOW_MS };
