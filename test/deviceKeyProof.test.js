'use strict';
// A browser wallet's device key (Connect wallet, 2026-10-26). Phantom and friends cannot sign silently, so a browser
// wallet signs ONE delegation naming a key this browser made, and the key signs play:identify and skins:pass in its
// place. Real ownerAuth verification with real ed25519 keys; the server's wiring is pinned on its source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const ownerAuth = require('../server/ownerAuth');
const { createSocketIdentity, OWNER_ALERTS_ACTION } = require('../server/socketIdentity');
const nameProof = require('../server/nameProof');

function keypair() {
  const secret = ed25519.utils.randomPrivateKey();
  return { secret, address: bs58.encode(ed25519.getPublicKey(secret)) };
}
const sign = (secret, text) => bs58.encode(ed25519.sign(new TextEncoder().encode(text), secret));
const DAY = 24 * 60 * 60 * 1000;
function delegation(wallet, device, until = Date.now() + 30 * DAY) {
  return { key: device.address, until, sig: sign(wallet.secret, ownerAuth.deviceMessage(wallet.address, device.address, until)) };
}
function deviceProof(wallet, device, action = 'play:identify', args = {}, dk = delegation(wallet, device), ts = Date.now()) {
  return { action, args, wallet: wallet.address, ts, sig: sign(device.secret, ownerAuth.actionMessage(action, args, wallet.address, ts)), dk };
}

test('a device key with its wallet\'s delegation proves the wallet for play:identify and skins:pass', () => {
  const w = keypair(), d = keypair();
  assert.equal(ownerAuth.walletForPlayerAction(deviceProof(w, d, 'play:identify')), w.address);
  assert.equal(ownerAuth.walletForPlayerAction(deviceProof(w, d, 'skins:pass')), w.address);
});

test('the wallet\'s own signature still works through the player verifier', () => {
  const w = keypair(), ts = Date.now();
  const p = { action: 'play:identify', args: {}, wallet: w.address, ts, sig: sign(w.secret, ownerAuth.actionMessage('play:identify', {}, w.address, ts)) };
  assert.equal(ownerAuth.walletForPlayerAction(p), w.address);
});

test('a device key reads the player\'s own clips (clips:mine) and signs nothing else: owner actions, clip uploads, br:start', () => {
  const w = keypair(), d = keypair();
  assert.equal(ownerAuth.walletForPlayerAction(deviceProof(w, d, 'clips:mine')), w.address);
  for (const a of ['maintenance:on', 'clip:upload', 'clip:submit', 'clip:delete', 'clip:decide', 'clips:queue', 'br:start',
                   'owner:session:create', OWNER_ALERTS_ACTION]) {
    assert.equal(ownerAuth.walletForPlayerAction(deviceProof(w, d, a)), null, a);
  }
});

test('the owner verifier ignores a delegation entirely', () => {
  const w = keypair(), d = keypair();
  assert.equal(ownerAuth.walletForAction(deviceProof(w, d, 'play:identify')), null);
  assert.equal(ownerAuth.walletForAction(deviceProof(w, d, 'maintenance:on')), null);
});

test('a delegation signed by another wallet, or naming another key, proves nothing', () => {
  const w = keypair(), d = keypair(), other = keypair();
  const until = Date.now() + DAY;
  const forged = { key: d.address, until, sig: sign(other.secret, ownerAuth.deviceMessage(w.address, d.address, until)) };
  assert.equal(ownerAuth.walletForPlayerAction(deviceProof(w, d, 'play:identify', {}, forged)), null, 'signed by another wallet');
  const otherKey = delegation(w, other);
  assert.equal(ownerAuth.walletForPlayerAction(deviceProof(w, d, 'play:identify', {}, otherKey)), null, 'the key is not the one delegated');
});

test('a delegation is bound to its end date, and a long or past one is refused', () => {
  const w = keypair(), d = keypair();
  const dk = delegation(w, d);
  assert.equal(ownerAuth.walletForPlayerAction(deviceProof(w, d, 'play:identify', {}, { ...dk, until: dk.until + DAY })), null, 'stretched');
  assert.equal(ownerAuth.walletForPlayerAction(deviceProof(w, d, 'play:identify', {}, delegation(w, d, Date.now() - 1000))), null, 'expired');
  assert.equal(ownerAuth.walletForPlayerAction(deviceProof(w, d, 'play:identify', {}, delegation(w, d, Date.now() + 40 * DAY))), null, 'over 31 days');
});

test('the action signature is one-time and inside the 2-minute window', () => {
  const w = keypair(), d = keypair();
  const p = deviceProof(w, d);
  assert.equal(ownerAuth.walletForPlayerAction(p), w.address);
  assert.equal(ownerAuth.walletForPlayerAction(p), null, 'replayed');
  const old = deviceProof(w, d, 'play:identify', {}, delegation(w, d), Date.now() - ownerAuth.WINDOW_MS - 5000);
  assert.equal(ownerAuth.walletForPlayerAction(old), null, 'stale');
});

test('a key cannot be the wallet itself, and odd shapes are refused without throwing', () => {
  const w = keypair();
  assert.equal(ownerAuth.walletForPlayerAction(deviceProof(w, w)), null);
  const d = keypair();
  const p = deviceProof(w, d);
  for (const dk of [[], 'x', 5, { key: { toString: 1 } }, { key: d.address, until: 'soon', sig: p.dk.sig }, { key: 'x'.repeat(5000), until: p.dk.until, sig: p.dk.sig }]) {
    assert.equal(ownerAuth.walletForPlayerAction({ ...p, dk }), null);
  }
});

test('socketIdentity proves a socket with a device key, but owner alerts still need the owner\'s own signature', () => {
  const owner = keypair(), d = keypair();
  const id = createSocketIdentity({
    verifyIdentityProof: (p) => nameProof.verifyIdentityProof(p),
    walletForAction: (p) => ownerAuth.walletForAction(p),
    walletForIdentify: (p) => ownerAuth.walletForPlayerAction(p),
    isOwner: (x) => x === owner.address,
    alertKey: owner.address,
    ownerSockets: new Map(),
    log: { warn() {} },
  });
  const s = {};
  assert.equal(id.fromProof(s, deviceProof(owner, d, 'play:identify')), owner.address);
  const s2 = {};
  assert.equal(id.ownerAlerts(s2, deviceProof(owner, d, OWNER_ALERTS_ACTION)), false, 'a device key never registers owner alerts');
});

test('the server wires the player verifier into identify, the skin pass and the clips:mine read only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(src, /walletForIdentify: \(p\) => ownerAuth\.walletForPlayerAction\(p\)/);
  assert.match(src, /'play:identify'\s*\n?\s*\? ownerAuth\.walletForPlayerAction\(p\)/);
  assert.match(src, /const wallet = ownerAuth\.walletForPlayerAction\(proof\);/);
  assert.match(src, /walletForMine: \(b\) => ownerAuth\.walletForPlayerAction\(b\)/);
  // exactly those four: no owner route, clip upload or session reads a delegation
  assert.equal((src.match(/walletForPlayerAction\(/g) || []).length, 4, 'four call sites');
  const clips = fs.readFileSync(path.join(__dirname, '..', 'server', 'clips.js'), 'utf8');
  assert.match(clips, /if \(action === 'clips:mine' && typeof walletForMine === 'function'\) return walletForMine\(b\);/);
  assert.equal((clips.match(/walletForMine\(/g) || []).length, 1, 'clips:mine only');
});

test('the server and the widget pick the same wallet for a Privy user: the Privy wallet first, then a browser wallet', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(src, /const own = sol\.find\(a => \/\^privy\/\.test/);
  const widget = fs.readFileSync(path.join(__dirname, '..', 'wallet-widget', 'src', 'main.jsx'), 'utf8');
  assert.match(widget, /accts\.find\(\(a\) => isSol\(a\) && isPrivyWallet\(a\)\) \|\| accts\.find\(isSol\)/);
});
