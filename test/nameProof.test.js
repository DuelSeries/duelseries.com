'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
// bs58 v6 is ESM-first: a plain require gives { default }, and reaching straight
// for .encode gets undefined. Same unwrap Wallet.js and Usdc.js already use.
const bs58  = (_bs58 && _bs58.default) ? _bs58.default : _bs58;

/* The REAL module the server calls, not a copy of its logic. A test that
   reimplements what it is testing only ever proves the reimplementation. */
const { nameMessage, verifyNameProof, WINDOW_MS } = require('../server/nameProof');

const addrOf = priv => bs58.encode(ed25519.getPublicKey(priv));
const sign = (priv, wallet, name, ts) =>
  bs58.encode(ed25519.sign(new TextEncoder().encode(nameMessage(wallet, name, ts)), priv));

test('a wallet can name itself', () => {
  const priv = ed25519.utils.randomPrivateKey();
  const me = addrOf(priv), ts = Date.now();
  assert.equal(
    verifyNameProof({ wallet: me, name: 'Owen', ts, sig: sign(priv, me, 'Owen', ts) }),
    me, 'the signature proves the wallet');
});

test('nobody else can name your account', () => {
  const mine = ed25519.utils.randomPrivateKey(), theirs = ed25519.utils.randomPrivateKey();
  const me = addrOf(mine), them = addrOf(theirs), ts = Date.now();

  // Their key, signing a message that names MY wallet.
  assert.equal(verifyNameProof(
    { wallet: me, name: 'Stolen', ts, sig: sign(theirs, me, 'Stolen', ts) }), null,
    'another key cannot sign for my wallet');

  // Their own perfectly valid signature, submitted against my address.
  assert.equal(verifyNameProof(
    { wallet: me, name: 'Stolen', ts, sig: sign(theirs, them, 'Stolen', ts) }), null,
    'a valid signature for a different wallet does not transfer');
});

test('a captured signature cannot be reused', () => {
  const priv = ed25519.utils.randomPrivateKey();
  const me = addrOf(priv), ts = Date.now();
  const sig = sign(priv, me, 'Owen', ts);

  assert.equal(verifyNameProof({ wallet: me, name: 'Owen', ts, sig }), me, 'the first use works');
  assert.equal(verifyNameProof({ wallet: me, name: 'Owen', ts, sig }), null,
    'the same signature a second time does not');

  /* The name is INSIDE the signed message, so a captured signature cannot be
     pointed at a different name. This is the swap that would actually matter:
     it is what stops someone replaying your request to rename you. */
  const ts2 = Date.now();
  const sig2 = sign(priv, me, 'Owen', ts2);
  assert.equal(verifyNameProof({ wallet: me, name: 'NotOwen', ts: ts2, sig: sig2 }), null,
    'and cannot be aimed at another name');
});

test('a signature goes stale, in both directions', () => {
  const priv = ed25519.utils.randomPrivateKey();
  const me = addrOf(priv);
  const old = Date.now() - WINDOW_MS - 1000;
  assert.equal(verifyNameProof({ wallet: me, name: 'Owen', ts: old, sig: sign(priv, me, 'Owen', old) }),
    null, 'an old signature is refused');
  const ahead = Date.now() + WINDOW_MS + 1000;
  assert.equal(verifyNameProof({ wallet: me, name: 'Owen', ts: ahead, sig: sign(priv, me, 'Owen', ahead) }),
    null, 'and so is one dated in the future');
});

test('a bad signature does not burn the good one behind it', () => {
  /* Verify BEFORE spending. Marking a signature used on the way in would let
     anyone disable a real request by sending its signature with the wrong name
     first, and the player would just see the change silently fail. */
  const priv = ed25519.utils.randomPrivateKey();
  const me = addrOf(priv), ts = Date.now();
  const sig = sign(priv, me, 'Owen', ts);
  assert.equal(verifyNameProof({ wallet: me, name: 'Wrong', ts, sig }), null, 'the tampered one fails');
  assert.equal(verifyNameProof({ wallet: me, name: 'Owen', ts, sig }), me,
    'and the real one still works afterwards');
});

test('rubbish is refused rather than thrown on', () => {
  const priv = ed25519.utils.randomPrivateKey();
  const me = addrOf(priv), ts = Date.now();
  const good = sign(priv, me, 'Owen', ts);
  for (const [label, body] of [
    ['nothing at all', null],
    ['an empty body', {}],
    ['no signature', { wallet: me, name: 'Owen', ts }],
    ['no timestamp', { wallet: me, name: 'Owen', sig: good }],
    ['a wallet that is not base58', { wallet: 'not a wallet!!', name: 'Owen', ts, sig: good }],
    ['a wallet of the wrong length', { wallet: bs58.encode(Buffer.alloc(16)), name: 'Owen', ts, sig: good }],
    ['a signature that is not base58', { wallet: me, name: 'Owen', ts, sig: '!!!' }],
    ['a non-numeric timestamp', { wallet: me, name: 'Owen', ts: 'soon', sig: good }],
  ]) {
    assert.equal(verifyNameProof(body), null, label + ' is refused');
  }
});
