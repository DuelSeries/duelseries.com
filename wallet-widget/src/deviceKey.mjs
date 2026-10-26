/* A browser wallet's device key (server/ownerAuth.js walletForPlayerAction). The Privy wallet signs play:identify
   and skins:pass silently on every game join; Phantom and the other browser wallets would show a popup each time.
   So the browser wallet signs ONE message naming a key made here, good for 30 days, and that key signs those two
   actions after it (and clips:mine, the Clips tab reading the player's own clips), with no popup. The server takes a
   device key for those actions only: never an owner action, a clip upload, a name, or anything that moves money.

   Kept in this browser's localStorage under the wallet, removed on sign out. */
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';

export const DEVICE_ACTIONS = ['play:identify', 'skins:pass', 'clips:mine'];
export const DEVICE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const KEY = (wallet) => 'duel.devkey.' + wallet;

// The exact string server/ownerAuth.js deviceMessage() checks, byte for byte. It is what Phantom shows.
export function deviceMessage(wallet, key, until) {
  return 'duelseries.com: let this browser show games it is me\n'
       + 'It can never move money.\n'
       + 'wallet: ' + wallet + '\n'
       + 'device key: ' + key + '\n'
       + 'until: ' + until;
}

// The string server/ownerAuth.js actionMessage() checks (the same one main.jsx signs for owner actions).
export function actionMessage(action, args, wallet, ts) {
  return 'DuelSeries owner action\n'
       + 'action: ' + action + '\n'
       + 'args: ' + JSON.stringify(args || {}) + '\n'
       + 'wallet: ' + wallet + '\n'
       + 'at: ' + ts;
}

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(String(s).match(/../g) || [], (h) => parseInt(h, 16));

/* The stored key for this wallet when it still has a day left, else null. */
export function loadDeviceKey(storage, wallet, now = Date.now()) {
  if (!storage || !wallet) return null;
  let d = null;
  try { d = JSON.parse(storage.getItem(KEY(wallet)) || 'null'); } catch (_) { d = null; }
  if (!d || d.wallet !== wallet || typeof d.secret !== 'string' || d.secret.length !== 64) return null;
  if (!(Number(d.until) - now > DAY)) return null;
  return d;
}

/* A new key, delegated by the wallet's signature (signMessage: bytes -> Promise<Uint8Array>), stored. */
export async function createDeviceKey(storage, wallet, signMessage, now = Date.now()) {
  const secret = ed25519.utils.randomPrivateKey();
  const key = bs58.encode(ed25519.getPublicKey(secret));
  const until = now + DEVICE_DAYS * DAY;
  const signature = await signMessage(new TextEncoder().encode(deviceMessage(wallet, key, until)));
  const d = { wallet, secret: hex(secret), key, until, sig: bs58.encode(signature) };
  try { storage.setItem(KEY(wallet), JSON.stringify(d)); } catch (_) {}
  return d;
}

export function forgetDeviceKey(storage, wallet) {
  try { if (storage && wallet) storage.removeItem(KEY(wallet)); } catch (_) {}
}

/* A player proof for one of the two device actions, in the shape the server reads ({ action, args, wallet, ts, sig,
   dk }). null for any other action: those are signed by the wallet itself. */
export function signWithDeviceKey(d, action, args, now = Date.now()) {
  if (!d || !DEVICE_ACTIONS.includes(action)) return null;
  const a = args || {};
  const ts = now;
  const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(actionMessage(action, a, d.wallet, ts)), unhex(d.secret)));
  return { action, args: a, wallet: d.wallet, ts, sig, dk: { key: d.key, until: d.until, sig: d.sig } };
}
