'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;

/* The REAL module the server calls. Owner controls are the most dangerous
   surface in the product — they can stop the game, spawn players and start a
   match with money on it — so this drives the actual verifier, not a copy. */
const { actionMessage, walletForAction, WINDOW_MS } = require('../server/ownerAuth');

const addrOf = k => bs58.encode(ed25519.getPublicKey(k));
const sign = (k, action, args, wallet, ts) =>
  bs58.encode(ed25519.sign(new TextEncoder().encode(actionMessage(action, args, wallet, ts)), k));
const proof = (k, action, args) => {
  const wallet = addrOf(k), ts = Date.now();
  return { action, args, wallet, ts, sig: sign(k, action, args, wallet, ts) };
};

test('the owner wallet can authorise an action', () => {
  const k = ed25519.utils.randomPrivateKey();
  const p = proof(k, 'maintenance:on', { message: 'brb' });
  assert.equal(walletForAction(p), addrOf(k));
});

test('a signature is bound to its action, so it cannot be re-aimed', () => {
  /* This is the one that matters. If only the wallet were signed, a captured
     "check whether I can restart" could be replayed as "close the doors". */
  const k = ed25519.utils.randomPrivateKey();
  const p = proof(k, 'maintenance:check', {});
  assert.equal(walletForAction({ ...p, action: 'maintenance:on' }), null,
    'the action name is inside the signature');
});

test('and to its arguments, so five bots cannot become five hundred', () => {
  const k = ed25519.utils.randomPrivateKey();
  const p = proof(k, 'bots:add', { room: 'na_free', count: 5 });
  assert.equal(walletForAction({ ...p, args: { room: 'na_free', count: 500 } }), null,
    'the arguments are inside the signature');
  assert.equal(walletForAction({ ...p, args: { room: 'na_dollar', count: 5 } }), null,
    'including which room');
});

test('nobody else can authorise anything', () => {
  const mine = ed25519.utils.randomPrivateKey(), theirs = ed25519.utils.randomPrivateKey();
  const me = addrOf(mine), ts = Date.now();
  assert.equal(walletForAction(
    { action: 'br:stop', args: {}, wallet: me, ts, sig: sign(theirs, 'br:stop', {}, me, ts) }),
    null, 'another key cannot sign as me');
});

test('a signature works once and then never again', () => {
  const k = ed25519.utils.randomPrivateKey();
  const p = proof(k, 'announce', { text: 'hello' });
  assert.equal(walletForAction(p), addrOf(k), 'the first use works');
  assert.equal(walletForAction(p), null, 'a replay does not');
});

test('a signature goes stale in both directions', () => {
  const k = ed25519.utils.randomPrivateKey(), wallet = addrOf(k);
  for (const ts of [Date.now() - WINDOW_MS - 1000, Date.now() + WINDOW_MS + 1000]) {
    assert.equal(walletForAction(
      { action: 'br:start', args: {}, wallet, ts, sig: sign(k, 'br:start', {}, wallet, ts) }),
      null, 'a signature dated ' + (ts < Date.now() ? 'too long ago' : 'in the future') + ' is refused');
  }
});

test('a bad signature does not burn the good one behind it', () => {
  const k = ed25519.utils.randomPrivateKey();
  const p = proof(k, 'br:start', { force: true });
  assert.equal(walletForAction({ ...p, action: 'br:stop' }), null, 'the tampered one fails');
  assert.equal(walletForAction(p), addrOf(k), 'and the real one still works');
});

test('rubbish is refused rather than thrown on', () => {
  const k = ed25519.utils.randomPrivateKey();
  const p = proof(k, 'announce', {});
  for (const [label, body] of [
    ['nothing', null],
    ['an empty body', {}],
    ['no action', { ...p, action: '' }],
    ['no signature', { ...p, sig: '' }],
    ['a wallet that is not base58', { ...p, wallet: 'not a wallet!!' }],
    ['a wallet of the wrong length', { ...p, wallet: bs58.encode(Buffer.alloc(16)) }],
    ['a signature that is not base58', { ...p, sig: '!!!' }],
    ['a timestamp that is not a number', { ...p, ts: 'now' }],
  ]) {
    assert.equal(walletForAction(body), null, label + ' is refused');
  }
});
