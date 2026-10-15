'use strict';
// Who a main-namespace socket is (security review item e) and who the Battle Royale prize pays (finder-4).
// PLAY and lobby:join used to take googleId (the wallet) as the client said it: anyone could write another wallet's
// stats and rename its all-time leaderboard entry, and anyone who knew the owner wallet (a constant in the repo)
// received the owner's live alerts. The BR prize paid the walletAddress the client named. Now a socket carries a
// wallet only with proof (a paid token's verified payer, or a wallet signature checked once per socket), the owner's
// alerts need an owner signature, and the room is told only the proven wallet. Real nameProof and ownerAuth
// verification with real ed25519 keys; the server's wiring is pinned on its source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const nameProof = require('../server/nameProof');
const ownerAuth = require('../server/ownerAuth');
const { createSocketIdentity, OWNER_ALERTS_ACTION, IDENTIFY_ACTION } = require('../server/socketIdentity');

function keypair() {
  const secret = ed25519.utils.randomPrivateKey();
  return { secret, wallet: bs58.encode(ed25519.getPublicKey(secret)) };
}
const sign = (secret, text) => bs58.encode(ed25519.sign(new TextEncoder().encode(text), secret));
function idProof(k, ts = Date.now()) {
  return { wallet: k.wallet, ts, sig: sign(k.secret, nameProof.identityMessage(k.wallet, ts)) };
}
function ownerProof(k, action = OWNER_ALERTS_ACTION, args = {}, ts = Date.now()) {
  return { action, args, wallet: k.wallet, ts, sig: sign(k.secret, ownerAuth.actionMessage(action, args, k.wallet, ts)) };
}

const OWNER = keypair();
function rig() {
  const ownerSockets = new Map();
  const id = createSocketIdentity({
    verifyIdentityProof: (p) => nameProof.verifyIdentityProof(p),
    walletForAction: (p) => ownerAuth.walletForAction(p),
    isOwner: (w) => w === OWNER.wallet,
    alertKey: OWNER.wallet,
    ownerSockets,
    log: { warn() {}, log() {}, error() {} }
  });
  return { id, ownerSockets };
}
let n = 0;
const sock = () => ({ id: 's' + ++n });

test('the identity proof: the wallet\'s own signature, inside the window, once; nothing else verifies', () => {
  const k = keypair();
  const p = idProof(k);
  assert.equal(nameProof.verifyIdentityProof(p), k.wallet);
  assert.equal(nameProof.verifyIdentityProof(p), null, 'one-time: a replayed proof is refused');
  const other = keypair();
  assert.equal(nameProof.verifyIdentityProof(Object.assign(idProof(other), { wallet: k.wallet })), null,
    'a signature by another key does not prove this wallet');
  assert.equal(nameProof.verifyIdentityProof(idProof(k, Date.now() - nameProof.WINDOW_MS - 5000)), null, 'stale');
  // a name-change signature can never stand in for it (different message)
  const ts = Date.now();
  const nameSig = sign(k.secret, nameProof.nameMessage(k.wallet, 'Owen', ts));
  assert.equal(nameProof.verifyIdentityProof({ wallet: k.wallet, ts, sig: nameSig }), null);
  for (const junk of [null, 1, 'x', [], {}, { wallet: { toString: 1 }, sig: 'a', ts: 1 }]) {
    assert.equal(nameProof.verifyIdentityProof(junk), null, JSON.stringify(junk));
  }
  // the name proof itself is unchanged
  const ts2 = Date.now();
  assert.equal(nameProof.verifyNameProof({ wallet: k.wallet, name: 'Owen', ts: ts2,
    sig: sign(k.secret, nameProof.nameMessage(k.wallet, 'Owen', ts2)) }), k.wallet);
});

test('a socket with no proof has no wallet: a claimed googleId binds nothing', () => {
  const { id } = rig();
  const s = sock();
  s.claimed = 'VictimWa11et';                     // what a hostile PLAY sends; nothing reads it
  assert.equal(id.fromProof(s, undefined), null);
  assert.equal(id.fromProof(s, 'VictimWa11et'), null, 'a string is not a proof');
  assert.equal(id.fromProof(s, { wallet: 'VictimWa11et', ts: Date.now(), sig: '1111' }), null, 'a bad signature');
  assert.equal(s._googleId, undefined);
  assert.equal(id.proven(s), null);
});

test('the proof the lobby widget already signs (duelWalletSignAction over play:identify) proves the player\'s own wallet', () => {
  const { id, ownerSockets } = rig();
  const k = keypair();
  const s = sock();
  const p = ownerProof(k, IDENTIFY_ACTION);     // exactly what window.duelWalletSignAction('play:identify', {}) returns
  assert.equal(id.fromProof(s, p), k.wallet, 'any player\'s wallet, not only an owner\'s');
  assert.equal(ownerSockets.size, 0, 'and it registers no owner alerts');
  // one-time: the same signature on another socket proves nothing
  assert.equal(id.fromProof(sock(), p), null);
  // another action's signature is not an identity proof, and is not spent here
  const t = sock();
  const other = ownerProof(k, 'maintenance:on');
  assert.equal(id.fromProof(t, Object.assign({}, other, { action: 'maintenance:on' })), null);
  assert.equal(ownerAuth.walletForAction(other), k.wallet, 'still unspent for what it was signed for');
  // a play:identify signature cannot be re-aimed at another wallet
  const u = sock();
  assert.equal(id.fromProof(u, Object.assign(ownerProof(keypair(), IDENTIFY_ACTION), { wallet: k.wallet })), null);
});

test('public/js/game.js sends that proof with PLAY, never holds PLAY up for it, and no longer sends a googleId', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'game.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /signer\('play:identify', \{\}\)/);
  assert.match(src, /new Promise\(\(resolve\) => setTimeout\(\(\) => resolve\(null\), IDPROOF_WAIT_MS\)\)/, 'a timeout, so play is never held up');
  assert.match(src, /\.catch\(\(\) => null\)/, 'a signer that fails sends PLAY without a proof');
  const connect = src.slice(src.indexOf("socket.on('connect'"), src.indexOf("socket.on('connect'") + 700);
  assert.match(connect, /reconnectKey, idProof: idProof \|\| undefined \}\)/);
  assert.ok(!/googleId/.test(connect), 'no claimed googleId on the wire');
});

test('a proof is checked once per socket and never replaces a proven wallet; a paid entry\'s payer always wins', () => {
  const { id } = rig();
  const a = keypair();
  const b = keypair();
  const s = sock();
  assert.equal(id.fromProof(s, idProof(a)), a.wallet);
  assert.equal(id.fromProof(s, idProof(b)), a.wallet, 'a later proof changes nothing');
  // a bad first proof spends the socket's one check
  const t = sock();
  assert.equal(id.fromProof(t, { wallet: a.wallet, ts: Date.now(), sig: '1111' }), null);
  assert.equal(id.fromProof(t, idProof(a)), null, 'checked once per socket');
  // the paid token's verified payer binds the socket, over any proof
  assert.equal(id.fromEntry(t, { ok: true, worth: 0.5, walletAddress: 'PayerWa11et' }), 'PayerWa11et');
  assert.equal(id.proven(t), 'PayerWa11et');
  assert.equal(id.fromEntry(s, { ok: true, worth: 0.5, walletAddress: 'PayerWa11et' }), 'PayerWa11et');
  assert.equal(id.proven(s), 'PayerWa11et');
  // a free entry carries no wallet and binds nothing
  const u = sock();
  assert.equal(id.fromEntry(u, { ok: true, worth: 0 }), null);
  assert.equal(id.proven(u), null);
});

test('the owner\'s alerts: only an owner signature over owner:alerts registers a socket; leaving removes only itself', () => {
  const { id, ownerSockets } = rig();
  const hijack = sock();
  // knowing the owner wallet is not enough, in any shape
  assert.equal(id.ownerAlerts(hijack, OWNER.wallet), false);
  assert.equal(id.ownerAlerts(hijack, { action: OWNER_ALERTS_ACTION, wallet: OWNER.wallet, ts: Date.now(), sig: '1111' }), false);
  // a proven wallet, even the owner's own, is never an alert registration
  id.fromEntry(hijack, { walletAddress: OWNER.wallet });
  assert.equal(ownerSockets.size, 0);
  // another key's signature over the right action is not the owner's
  assert.equal(id.ownerAlerts(sock(), ownerProof(keypair())), false);
  // one signature check per socket: after a failed one, even the owner's own proof is not checked on that socket
  assert.equal(id.ownerAlerts(hijack, ownerProof(OWNER)), false);
  assert.equal(ownerSockets.size, 0);
  // the owner's signature over another action is not spent here, and does not register
  const other = ownerProof(OWNER, 'maintenance:on');
  assert.equal(id.ownerAlerts(hijack, other), false);
  assert.equal(ownerAuth.walletForAction(other), OWNER.wallet, 'still good for the action it was signed for');
  assert.equal(ownerSockets.size, 0);
  // the real thing
  const owner = sock();
  assert.equal(id.ownerAlerts(owner, ownerProof(OWNER)), true);
  assert.equal(ownerSockets.get(OWNER.wallet), owner);
  // a socket that merely claimed or proved the owner wallet leaving does not unregister the owner's
  id.forget(hijack);
  assert.equal(ownerSockets.get(OWNER.wallet), owner);
  id.forget(owner);
  assert.equal(ownerSockets.size, 0);
});

test('server/index.js: every socket wallet, the alert map and the BR payee come from socketIdentity only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
  assert.ok(!/socket\._googleId\s*=[^=]/.test(code), 'nothing in index.js assigns socket._googleId');
  assert.ok(!/lobbySocketsByGoogleId\.(set|delete)\(/.test(code), 'the alert map is written by socketIdentity only');
  assert.match(code, /on\('lobby:join', \(\{ idProof, ownerProof \} = \{\}\) => \{/);
  assert.match(code, /socketIdentity\.ownerAlerts\(socket, ownerProof\)/);
  // PLAY no longer even reads the client's walletAddress or googleId
  const play = code.slice(code.indexOf('on(C.EVENTS.PLAY'), code.indexOf("on('cashout:start'"));
  assert.match(play, /on\(C\.EVENTS\.PLAY, \(\{ name, color, lobbyType, stake, entryToken, region, reconnectKey, idProof \} = \{\}\)/);
  assert.ok(!/\bgoogleId\b|\bwalletAddress\s*\|\|/.test(play.replace(/entry\.walletAddress/g, '')),
    'no client googleId or walletAddress in PLAY');
  assert.match(play, /room\.addPlayer\(socket, playerName, entry\.walletAddress \|\| socketIdentity\.proven\(socket\) \|\| null,/);
  assert.match(play, /socketIdentity\.fromEntry\(socket, entry\)/);
  assert.match(code, /socketIdentity\.forget\(socket\)/);
});

test('the Battle Royale winner is paid the wallet its seat was given, and a seat with none is not paid', () => {
  const src = fs.readFileSync(require.resolve('../server/BattleRoyaleRoom'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /wallet: \(this\.players\.get\(won\.id\) \|\| \{\}\)\.walletAddress \|\| null/,
    'the winner\'s wallet is the one addPlayer stored (index.js now passes only a proven one)');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(idx, /if \(!w\.wallet\) \{\n\s+console\.warn\(`\[BR\] \$\{matchId\} won by \$\{w\.name\} but they have no proven wallet/);
});
