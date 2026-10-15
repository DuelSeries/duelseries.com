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
const { isWalletString, isSigString } = require('./b58Caps');

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
/* One field of a client's request body, as text: a string, or a finite number written out, and
   '' for anything else. String() or Number() on an object the client built can THROW
   ({"toString":1}), and the callers run in async routes and socket handlers, where a throw
   ended the whole process. Nothing honest sends anything but strings and a number here. */
function field(body, k) {
  const v = body && typeof body === 'object' ? body[k] : undefined;
  return typeof v === 'string' ? v : (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
}
function verifyNameProof(body, now) {
  const name = field(body, 'name');
  return verifySigned(body, (wallet, ts) => nameMessage(wallet, name, ts), now);
}

/* The one check both proofs share: the wallet's own ed25519 signature over the message msgOf(wallet, ts),
   inside the window, spent once. Returns the wallet, or null. */
function verifySigned(body, msgOf, now) {
  now = now || Date.now();
  const wallet = field(body, 'wallet').trim();
  const sig    = field(body, 'sig').trim();
  const ts     = Number(field(body, 'ts')) || NaN;
  if (!wallet || !sig || !ts || !isFinite(ts)) return null;
  // Before ANY decode: base58 decode is quadratic, and a 100 KB string held the whole
  // server for ~20 s (server/b58Caps.js). A key is at most 44 chars, a signature 88.
  if (!isWalletString(wallet) || !isSigString(sig)) return null;
  if (Math.abs(now - ts) > WINDOW_MS) return null;      // stale, or from the future
  try {
    const pub = bs58.decode(wallet);
    if (pub.length !== 32) return null;                 // not an ed25519 public key
    const msg = new TextEncoder().encode(msgOf(wallet, ts));
    if (!ed25519.verify(bs58.decode(sig), msg, pub)) return null;
  } catch (_) { return null; }
  // Verified BEFORE it is spent, so a bad signature cannot burn a good one.
  if (!spend(sig, now)) return null;
  return wallet;
}

/* ─── Proving a game connection belongs to the wallet it names (security review item e) ──
   The main namespace's PLAY and lobby:join used to take `googleId` (the wallet) as the client
   said it, so anyone could write another wallet's stats, rename its all-time leaderboard entry,
   or register as the owner wallet for the owner's live alerts. A socket now carries a wallet
   only with proof: the paid entry token's verified payer, or this signature, checked once per
   socket (one-time, 2-minute window, like the name proof). The message names the wallet and the
   moment and says what it is for, so a name-change signature can never stand in for it. */
function identityMessage(wallet, ts) {
  return 'DuelSeries: play as this wallet\n'
       + 'wallet: ' + wallet + '\n'
       + 'at: ' + ts;
}
function verifyIdentityProof(body, now) {
  return verifySigned(body, identityMessage, now);
}

module.exports = { nameMessage, verifyNameProof, identityMessage, verifyIdentityProof, WINDOW_MS };
