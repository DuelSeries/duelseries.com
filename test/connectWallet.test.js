'use strict';
/* Connect wallet (2026-10-26): sign in with Phantom, Solflare, Coinbase Wallet or Backpack beside email and Google.
   wallet-widget/src/browserWallets.mjs (the sheet's rows, what a press does, SIWS sign-in, signing with the
   signed-in account) and deviceKey.mjs (the one approval that lets games know it is them), driven with a
   Phantom-like Wallet Standard stub holding a real ed25519 key, and checked against the REAL server verifier. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const { Keypair, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const ownerAuth = require('../server/ownerAuth');

const bw = () => import('../wallet-widget/src/browserWallets.mjs');
const dk = () => import('../wallet-widget/src/deviceKey.mjs');

/* A Phantom-like Wallet Standard wallet: connect shares its account, signMessage and signTransaction sign with a
   real key, and every call is recorded. `accounts` starts empty, as an extension's does before connect. */
function stubWallet({ name = 'Phantom', seed = ed25519.utils.randomPrivateKey(), refuse = false, icon = 'data:image/png;base64,AAA' } = {}) {
  const kp = Keypair.fromSeed(seed);
  const account = { address: kp.publicKey.toBase58(), publicKey: kp.publicKey.toBytes(), chains: ['solana:mainnet'], features: [] };
  const calls = [];
  const w = {
    name, icon, version: '1.0.0', chains: ['solana:mainnet', 'solana:devnet'], accounts: [],
    features: {
      'standard:connect': { version: '1.0.0', connect: async (input) => {
        calls.push(['connect', input || null]);
        if (input && input.silent && !w._trusted) return { accounts: [] };
        if (refuse) { const e = new Error('User rejected the request.'); e.code = 4001; throw e; }
        w.accounts = [account]; w._trusted = true; return { accounts: w.accounts };
      } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { calls.push(['disconnect']); w.accounts = []; } },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signMessage': { version: '1.0.0', signMessage: async ({ account: a, message }) => {
        calls.push(['signMessage', a.address, new TextDecoder().decode(message)]);
        return [{ signedMessage: message, signature: ed25519.sign(message, seed) }];
      } },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async ({ account: a, transaction, chain }) => {
        calls.push(['signTransaction', a.address, chain]);
        const tx = Transaction.from(transaction);
        tx.partialSign(kp);
        return [{ signedTransaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }) }];
      } },
    },
  };
  return { w, kp, seed, calls, address: account.address };
}
const registryOf = (...ws) => ({ get: () => ws });
class MemStore { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }

test('only Solana Wallet Standard wallets are listed, never Privy\'s own, once per name', async () => {
  const { detectedWallets } = await bw();
  const phantom = stubWallet().w;
  const privy = stubWallet({ name: 'Privy' }).w;
  const evmOnly = { name: 'MetaMask', chains: ['eip155:1'], features: { 'standard:connect': {} } };
  const twice = stubWallet().w;
  const got = detectedWallets(registryOf(phantom, privy, evmOnly, twice));
  assert.deepEqual(got.map((w) => w.name), ['Phantom']);
});

test('the wallet sheet: Phantom, Solflare and Backpack only, installed ones first and marked Detected with their own icon', async () => {
  const { sheetRows, detectedWallets } = await bw();
  const det = detectedWallets(registryOf(stubWallet({ name: 'Solflare', icon: 'data:sf' }).w, stubWallet({ name: 'Glow' }).w,
    stubWallet({ name: 'Coinbase Wallet' }).w));
  const pc = sheetRows(det, false);
  assert.deepEqual(pc.map((r) => r.label), ['Solflare', 'Phantom', 'Backpack'], 'no other wallet is ever listed (Owen: three)');
  assert.equal(pc[0].badge, 'Detected'); assert.equal(pc[0].tone, 'ok'); assert.equal(pc[0].icon, 'data:sf');
  assert.deepEqual(pc.slice(1).map((r) => r.badge), ['Install', 'Install']);
  const phone = sheetRows([], true);
  assert.deepEqual(phone.map((r) => r.label), ['Phantom', 'Solflare', 'Backpack']);
  assert.deepEqual(phone.map((r) => r.badge), ['Open app', 'Open app', 'Open app']);
  for (const r of phone) assert.match(r.icon, /^data:image\/svg\+xml/, 'drawn here: no request to anyone');
});

test('a press: an installed wallet signs in; on a phone the wallet app opens this page; on a PC its download page', async () => {
  const { pick, detectedWallets } = await bw();
  const s = stubWallet();
  const det = detectedWallets(registryOf(s.w));
  assert.equal(pick('w:phantom', det, false, {}).wallet, s.w);
  const here = { url: 'https://duelseries.com/v2?signin=wallet', origin: 'https://duelseries.com' };
  const open = pick('w:solflare', [], true, here);
  assert.equal(open.kind, 'open');
  assert.equal(open.url, 'https://solflare.com/ul/v1/browse/' + encodeURIComponent(here.url) + '?ref=' + encodeURIComponent(here.origin));
  assert.equal(pick('w:phantom', [], true, here).url, 'https://phantom.app/ul/browse/' + encodeURIComponent(here.url) + '?ref=' + encodeURIComponent(here.origin));
  assert.equal(pick('w:backpack', [], true, here).url, 'https://backpack.app/ul/v1/browse/' + encodeURIComponent(here.url) + '?ref=' + encodeURIComponent(here.origin));
  assert.deepEqual(pick('w:backpack', [], false, here), { kind: 'install', url: 'https://backpack.app/downloads', label: 'Backpack' });
  assert.equal(pick('w:coinbase', [], false, here).kind, 'none');
  assert.equal(pick('ledger', [], false, here).kind, 'none');
});

test('sign-in: connect, then Privy\'s SIWS message signed by the wallet, sent to Privy as base64 with the wallet\'s type', async () => {
  const { signInWith } = await bw();
  const s = stubWallet();
  let sent = null;
  const steps = [];
  const addr = await signInWith(s.w, {
    generateSiwsMessage: async ({ address }) => 'duelseries.com wants you to sign in with your Solana account:\n' + address + '\n\nNonce: abc',
    loginWithSiws: async (a) => { sent = a; return { id: 'did:privy:x' }; },
    onStep: (x) => steps.push(x),
  });
  assert.equal(addr, s.address);
  assert.deepEqual(steps, ['connect', 'sign', 'check']);
  assert.equal(sent.walletClientType, 'phantom');
  assert.equal(sent.connectorType, 'solana_adapter');
  const sig = Uint8Array.from(Buffer.from(sent.signature, 'base64'));
  assert.ok(ed25519.verify(sig, new TextEncoder().encode(sent.message), bs58.decode(s.address)), 'Privy gets a signature that verifies');
});

test('a refused connect is a refusal (the sheet just closes), not an error card', async () => {
  const { signInWith, isRefusal } = await bw();
  const s = stubWallet({ refuse: true });
  await assert.rejects(signInWith(s.w, { generateSiwsMessage: async () => 'm', loginWithSiws: async () => ({}) }), (e) => isRefusal(e));
  assert.equal(isRefusal(new Error('Network down')), false);
});

test('signing always uses the signed-in account: a switched extension is told to switch back, nothing is signed', async () => {
  const { signTransactionWith, accountFor } = await bw();
  const s = stubWallet();
  const other = stubWallet();
  // the extension now shows another account
  s.w.accounts = [{ address: other.address, publicKey: other.kp.publicKey.toBytes(), chains: ['solana:mainnet'], features: [] }];
  s.w.features['standard:connect'].connect = async () => ({ accounts: s.w.accounts });
  const tx = new Transaction({ feePayer: new PublicKey(s.address), recentBlockhash: '11111111111111111111111111111111' })
    .add(SystemProgram.transfer({ fromPubkey: new PublicKey(s.address), toPubkey: new PublicKey(other.address), lamports: 1 }));
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  await assert.rejects(signTransactionWith(s.w, s.address, bytes), /Switch Phantom to the wallet you signed in with/);
  assert.equal(s.calls.filter((c) => c[0] === 'signTransaction').length, 0);
  assert.equal(await accountFor(stubWallet().w, 'x', { silent: true }), null, 'a silent connect that is not trusted yet just waits');
});

test('a stake-shaped transfer is signed by the wallet, unchanged, with its priority fee, on mainnet', async () => {
  const { signTransactionWith } = await bw();
  const { ComputeBudgetProgram } = require('@solana/web3.js');
  const s = stubWallet();
  await s.w.features['standard:connect'].connect();
  const escrow = Keypair.generate().publicKey;
  const tx = new Transaction({ feePayer: new PublicKey(s.address), recentBlockhash: '11111111111111111111111111111111' });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 80000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }));
  tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(s.address), toPubkey: escrow, lamports: 3_000_000 }));
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const { signedTransaction } = await signTransactionWith(s.w, s.address, bytes);
  const back = Transaction.from(signedTransaction);
  assert.equal(back.feePayer.toBase58(), s.address, 'the payer the server pays back is this wallet');
  assert.ok(back.verifySignatures(), 'signed by the wallet');
  assert.equal(back.instructions.length, 3, 'the priority fee instructions are kept');
  assert.deepEqual(Buffer.from(back.serializeMessage()), Buffer.from(tx.serializeMessage()), 'the exact message that was built');
  assert.deepEqual(s.calls.find((c) => c[0] === 'signTransaction'), ['signTransaction', s.address, 'solana:mainnet']);
});

test('device key: one approval, then play:identify and skins:pass prove the wallet to the REAL server verifier', async () => {
  const { createDeviceKey, loadDeviceKey, signWithDeviceKey, forgetDeviceKey } = await dk();
  const { signMessageWith } = await bw();
  const s = stubWallet();
  await s.w.features['standard:connect'].connect();
  const store = new MemStore();
  const d = await createDeviceKey(store, s.address, (bytes) => signMessageWith(s.w, s.address, bytes).then((r) => r.signature));
  const shown = s.calls.find((c) => c[0] === 'signMessage')[2];
  assert.match(shown, /^duelseries\.com: let this browser show games it is me\nIt can never move money\./, 'what the wallet shows');
  assert.equal(loadDeviceKey(store, s.address).key, d.key);
  for (const action of ['play:identify', 'skins:pass']) {
    assert.equal(ownerAuth.walletForPlayerAction(signWithDeviceKey(loadDeviceKey(store, s.address), action, {})), s.address, action);
  }
  assert.equal(signWithDeviceKey(d, 'br:start', {}), null, 'anything else is the wallet\'s own signature');
  assert.equal(signWithDeviceKey(null, 'play:identify', {}), null, 'no key, no proof, no popup');
  assert.equal(loadDeviceKey(store, s.address, Date.now() + 30 * 86400000), null, 'past its time (a day early) it is asked for again');
  forgetDeviceKey(store, s.address);
  assert.equal(loadDeviceKey(store, s.address), null, 'gone on sign out');
});

test('the device message is the server\'s byte for byte', async () => {
  const { deviceMessage, actionMessage } = await dk();
  assert.equal(deviceMessage('W', 'K', 123), ownerAuth.deviceMessage('W', 'K', 123));
  assert.equal(actionMessage('play:identify', {}, 'W', 5), ownerAuth.actionMessage('play:identify', {}, 'W', 5));
});

test('the widget: the player\'s wallet is the signed-in one only, signed through the browser wallet, the sheet gated on Privy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'wallet-widget', 'src', 'main.jsx'), 'utf8');
  assert.match(src, /const address = authenticated \? solanaAddress\(user\) : null;/, 'a merely connected wallet is never the player');
  assert.match(src, /\(solWallets \|\| \[\]\)\.find\(\(w\) => w\.address === address\)/, 'the Privy wallet object is the signed-in address\'s');
  assert.doesNotMatch(src, /solWallets && solWallets\[0\]/);
  assert.match(src, /if \(!\(await walletLoginOn\(\)\)\) \{ p\.login\(\); return; \}/, 'dashboard off: Sign in is email and Google as before');
  assert.match(src, /solana_wallet_auth === true/);
  // every money signature goes through the one signer that knows both kinds of wallet
  for (const call of ['stakeAndPlay(game, sel, wallet, signTx,', 'swapRun(q && q.requestId, wallet, signTx)', 'signSkinPayment(quote, wallet, signTx)',
                      'sendSol(toAddress, amount, wallet, signTx)', 'signRef.current = signTx;']) {
    assert.ok(src.includes(call), call);
  }
  assert.match(src, /wallet\.external && DEVICE_ACTIONS\.includes\(action\)/, 'silent actions never pop the browser wallet');
  // two choices, then the three wallets; Privy's own screens list no wallets at all (EVM or Solana)
  assert.match(src, /primary: \{ id: 'privy', label: 'Continue with Google or email' \}/);
  assert.match(src, /secondary: \{ id: 'wallet', label: 'Connect wallet' \}/);
  assert.match(src, /loginMethods: \['google', 'email'\]/);
  assert.doesNotMatch(src, /externalWallets|toSolanaWalletConnectors|walletList/);
  // a game join with no key asks for one (an event prize pays only proven wallets); a skin pass never asks
  assert.match(src, /!d && action === 'play:identify' && wallet\.std/);
  // nothing a page asks on its own pops the browser wallet: a saved name syncs by the Privy token, the owner's clip
  // queue and alerts are never asked of a browser wallet
  assert.match(src, /window\.duelWalletSignName = async \(name\) => \{\s*if \(!wallet \|\| !address\) return null;[\s\S]{0,300}if \(wallet\.external\) return null;/);
  assert.match(src, /wallet\.external && \(action === 'clips:queue' \|\| action === 'owner:alerts'\)\) return null;/);
  // a wallet that never answers cannot hold the card up: sign-in and the device key give up after 2 minutes
  assert.match(src, /await inTime\(signInWith\(std,/);
  assert.match(src, /inTime\(createDeviceKey\(/);
});
