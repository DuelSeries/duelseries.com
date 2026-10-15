'use strict';
/* ─── The size of a base58 string a client may hand us ────────────────────────
   bs58 (base-x) decode is QUADRATIC in its input. Measured on this repo's
   bs58 6: 10,000 characters took 130 ms, 95,000 took 19.5 s, and a 1 MB string
   (socket.io's default message cap) would hold the one thread every live room
   ticks on for many minutes. new PublicKey(text) decodes the same way.

   Every key and signature here has a fixed size, so its base58 text has a
   fixed ceiling: 32 bytes (a wallet / public key) is at most 44 characters and
   64 bytes (an ed25519 signature) at most 88. Anything longer cannot be one,
   and is refused here, BEFORE any decode. The length test runs first, so a
   long string never reaches the alphabet test either.

   Every client string that reaches bs58.decode or new PublicKey() goes through
   one of these first. */

const MAX_WALLET_CHARS = 44;   // base58 of 32 bytes
const MAX_SIG_CHARS    = 88;   // base58 of 64 bytes
const B58_ALPHABET = /^[1-9A-HJ-NP-Za-km-z]+$/;

function fitsB58(s, max) {
  return typeof s === 'string' && s.length > 0 && s.length <= max && B58_ALPHABET.test(s);
}
/* A string that could be a Solana address (a 32-byte key in base58). */
const isWalletString = (s) => fitsB58(s, MAX_WALLET_CHARS);
/* A string that could be an ed25519 signature (64 bytes in base58). */
const isSigString = (s) => fitsB58(s, MAX_SIG_CHARS);

module.exports = { MAX_WALLET_CHARS, MAX_SIG_CHARS, isWalletString, isSigString };
