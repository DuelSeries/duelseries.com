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
const { isWalletString, isSigString } = require('./b58Caps');

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
/* One field of a client's request body, as text: a string, or a finite number written out, and
   '' for anything else. String() or Number() on an object the client built can THROW
   ({"toString":1}), and the callers run in async routes and socket handlers, where a throw
   ended the whole process. Nothing honest sends anything but strings and a number here. */
function field(body, k) {
  const v = body && typeof body === 'object' ? body[k] : undefined;
  return typeof v === 'string' ? v : (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
}
function walletForAction(body, now) {
  now = now || Date.now();
  const wallet = field(body, 'wallet').trim();
  const sig    = field(body, 'sig').trim();
  const action = field(body, 'action');
  const ts     = Number(field(body, 'ts')) || NaN;
  const args   = (body && body.args) || {};
  if (!wallet || !sig || !action || !ts || !isFinite(ts)) return null;
  // Before ANY decode: base58 decode is quadratic, and a 100 KB string held the whole
  // server for ~20 s (server/b58Caps.js). A key is at most 44 chars, a signature 88.
  if (!isWalletString(wallet) || !isSigString(sig)) return null;
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

/* ── a browser wallet's device key (Connect wallet, 2026-10-26) ──────────────
   The Privy wallet signs play:identify and skins:pass silently, on every game
   join. Phantom, Solflare, Backpack and Coinbase Wallet cannot: each signature
   is a popup, and one on every join (raced against a 2 s clock in game.js)
   would leave a popup hanging and the round with no stats. So a browser
   wallet signs ONE message, deviceMessage below, naming a key this browser
   made and an end date at most 31 days off, and that key then signs the
   actions a page asks for on its own in its place: those two, and clips:mine
   (the Clips tab reading the player's own clips). Only those: what a device
   key signs is never an owner action, a clip upload or delete, a name or
   anything that moves money; walletForAction above never reads a delegation
   at all, so every owner route refuses one. */
const DEVICE_ACTIONS = new Set(['play:identify', 'skins:pass', 'clips:mine']);
const DEVICE_MAX_MS = 31 * 24 * 60 * 60 * 1000;
// The exact string the browser wallet shows and signs (wallet-widget/src/deviceKey.mjs), byte for byte.
function deviceMessage(wallet, key, until) {
  return 'duelseries.com: let this browser show games it is me\n'
       + 'It can never move money.\n'
       + 'wallet: ' + wallet + '\n'
       + 'device key: ' + key + '\n'
       + 'until: ' + until;
}

/* The wallet behind a PLAYER proof: walletForAction's direct signature, or a device key's signature carried by
   the wallet's own delegation (body.dk = { key, until, sig }). The delegation is checked first, then the
   action's signature by the key, then the signature is spent, as above. */
function walletForPlayerAction(body, now) {
  now = now || Date.now();
  const dk = body && typeof body === 'object' ? body.dk : undefined;
  if (dk === undefined || dk === null) return walletForAction(body, now);
  if (typeof dk !== 'object' || Array.isArray(dk)) return null;
  const action = field(body, 'action');
  if (!DEVICE_ACTIONS.has(action)) return null;
  const wallet = field(body, 'wallet').trim();
  const sig    = field(body, 'sig').trim();
  const ts     = Number(field(body, 'ts')) || NaN;
  const key    = field(dk, 'key').trim();
  const dsig   = field(dk, 'sig').trim();
  const until  = Number(field(dk, 'until')) || NaN;
  if (!wallet || !sig || !key || !dsig || !isFinite(ts) || !isFinite(until)) return null;
  if (!isWalletString(wallet) || !isWalletString(key) || !isSigString(sig) || !isSigString(dsig)) return null;
  if (key === wallet) return null;
  if (Math.abs(now - ts) > WINDOW_MS) return null;
  if (until <= now || until - now > DEVICE_MAX_MS) return null;
  const args = (body && body.args) || {};
  try {
    const wpub = bs58.decode(wallet), kpub = bs58.decode(key);
    if (wpub.length !== 32 || kpub.length !== 32) return null;
    const enc = (s) => new TextEncoder().encode(s);
    if (!ed25519.verify(bs58.decode(dsig), enc(deviceMessage(wallet, key, until)), wpub)) return null;
    if (!ed25519.verify(bs58.decode(sig), enc(actionMessage(action, args, wallet, ts)), kpub)) return null;
  } catch (_) { return null; }
  if (!spend(sig, now)) return null;
  return wallet;
}

/* ── the audit log ──────────────────────────────────────────────────────────
   Every owner action that actually ran, in memory, newest first. Not a
   compliance artifact — a way to answer "why is the game in maintenance" and
   "who spawned forty bots" without reading a terminal. */
const auditLog = [];
/* Who did it, short. A wallet is cut to its ends; an owner session is named 'session:' and the
   last 6 of its sid hash (server/ownerSession.js), so the log shows which device acted; a short
   word such as 'token' stays as it is. */
function shortWho(who) {
  if (typeof who !== 'string' || !who) return 'unknown';
  if (/^session:[0-9a-f]{6}$/.test(who) || who.length <= 10) return who;
  return who.slice(0, 4) + '…' + who.slice(-4);
}
function audit(action, args, who, ok, note) {
  auditLog.unshift({
    at: Date.now(), action,
    args: args && Object.keys(args).length ? args : undefined,
    who: shortWho(who),
    ok: !!ok, note: note || undefined,
  });
  if (auditLog.length > 200) auditLog.length = 200;
}

module.exports = { actionMessage, walletForAction, deviceMessage, walletForPlayerAction, DEVICE_ACTIONS, DEVICE_MAX_MS,
                   audit, auditLog, WINDOW_MS };
