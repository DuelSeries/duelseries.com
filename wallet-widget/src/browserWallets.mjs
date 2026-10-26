/* Connect wallet (Owen 2026-10-26): a player signs in with their own browser wallet, Phantom, Solflare or Backpack,
   beside email and Google. Three wallets and no more (Owen: a long list is too many options).

   Sign-in is Privy's: Sign In With Solana (useLoginWithSiws), so the wallet becomes the Privy user's one Solana
   wallet and the server resolves it exactly as it resolves the Privy wallet. The widget talks to the browser wallet
   itself through the Wallet Standard (the registry every Solana wallet extension joins), so it decides which
   account signs: always the one the player signed in with, never whatever the extension switched to since.

   The player's wallet is a plain object the rest of the widget passes around like Privy's own:
     { address, external: true, clientType, name }
   and signTransaction / signMessage below sign with it. Nothing here builds a transaction or knows an amount:
   stakes, sends and skins are built where they always were (main.jsx) and only signed here. */

export const SOLANA_CHAIN = 'solana:mainnet';

/* Icons for a wallet that is not installed (an installed one shows its own). Drawn here, plain marks on each
   wallet's colour, so the sheet makes no request to anyone's servers. */
const svg = (body) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' + body + '</svg>');
const ICONS = {
  phantom: svg('<rect width="64" height="64" rx="14" fill="#AB9FF2"/>'
    + '<path d="M14 41c0-11 8-21 19-21s17 8 17 16c0 3-2 5-5 5h-1c-1 0-2 1-2 2 0 2-2 4-4 4s-3-2-4-3c-1 1-2 3-4 3s-3-1-4-3c-1 2-3 3-5 3-4 0-7-3-7-6z" fill="#fff"/>'
    + '<ellipse cx="33" cy="32" rx="2.4" ry="4" fill="#3C315B"/><ellipse cx="42" cy="32" rx="2.4" ry="4" fill="#3C315B"/>'),
  solflare: svg('<rect width="64" height="64" rx="14" fill="#1E1E1E"/>'
    + '<circle cx="32" cy="32" r="23" fill="#FC7D0E"/><circle cx="32" cy="32" r="16" fill="#FFEF46"/>'
    + '<path d="M21 34c6-1 10-5 11-12 1 7 5 11 11 12-6 1-10 5-11 12-1-7-5-11-11-12z" fill="#1E1E1E"/>'),
  backpack: svg('<rect width="64" height="64" rx="14" fill="#E33E3F"/>'
    + '<path d="M26 18a6 6 0 0 1 12 0v2h-4v-2a2 2 0 0 0-4 0v2h-4z" fill="#fff"/>'
    + '<rect x="18" y="21" width="28" height="27" rx="8" fill="#fff"/><rect x="18" y="38" width="28" height="8" fill="#E33E3F" opacity=".25"/>'),
};

/* The wallets the sheet lists, the only ones it lists. `names` are the Wallet Standard names each extension
   registers under; `client` is Privy's walletClientType for it; `browse` opens this page inside the wallet app's
   own browser on a phone, where the wallet is injected and the sheet finds it. */
const enc = encodeURIComponent;
export const WALLETS = [
  { id: 'phantom', label: 'Phantom', names: ['phantom'], client: 'phantom', icon: ICONS.phantom,
    install: 'https://phantom.com/download',
    browse: (url, origin) => 'https://phantom.app/ul/browse/' + enc(url) + '?ref=' + enc(origin) },
  { id: 'solflare', label: 'Solflare', names: ['solflare'], client: 'solflare', icon: ICONS.solflare,
    install: 'https://solflare.com/download',
    browse: (url, origin) => 'https://solflare.com/ul/v1/browse/' + enc(url) + '?ref=' + enc(origin) },
  { id: 'backpack', label: 'Backpack', names: ['backpack'], client: 'backpack', icon: ICONS.backpack,
    install: 'https://backpack.app/downloads',
    browse: (url, origin) => 'https://backpack.app/ul/v1/browse/' + enc(url) + '?ref=' + enc(origin) },
];

const norm = (s) => String(s || '').trim().toLowerCase();

/* A Wallet Standard wallet that can sign in and pay on Solana mainnet. Privy's own embedded wallet registers in
   the same registry; it is the email and Google path, never a row here. */
export function isSolanaWallet(w) {
  if (!w || typeof w.name !== 'string' || !w.features) return false;
  if (/privy/i.test(w.name)) return false;
  const f = w.features;
  const chains = Array.isArray(w.chains) ? w.chains : [];
  return !!(f['standard:connect'] && f['solana:signTransaction'] && f['solana:signMessage'])
    && (chains.length === 0 || chains.some((c) => c === SOLANA_CHAIN || c === 'solana:mainnet-beta'));
}

/* Privy's walletClientType for a standard wallet: the catalogue's when it is one of ours, else its name the way
   Privy writes one ('Glow Wallet' -> 'glow_wallet'). */
export function clientTypeOf(w) {
  const n = norm(w && w.name);
  const known = WALLETS.find((k) => k.names.includes(n));
  if (known) return known.client;
  return n.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

/* The installed Solana wallets, one per name (an extension that registers twice counts once). */
export function detectedWallets(registry) {
  const seen = new Set();
  const out = [];
  let list = [];
  try { list = registry ? registry.get() : []; } catch (_) { list = []; }
  for (const w of list || []) {
    if (!isSolanaWallet(w)) continue;
    const n = norm(w.name);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(w);
  }
  return out;
}

export function isPhone(nav) {
  const n = nav || (typeof navigator !== 'undefined' ? navigator : {});
  const ua = String(n.userAgent || '');
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  // iPadOS reports a Mac; it has touch points
  return /Macintosh/.test(ua) && Number(n.maxTouchPoints) > 1;
}

/* The wallet sheet's rows: Phantom, Solflare, Backpack, the installed ones first and marked Detected (with the
   extension's own icon). Any other wallet the browser has is not listed. Each row's id is what pick() takes back. */
export function sheetRows(detected, phone) {
  const byName = new Map(detected.map((w) => [norm(w.name), w]));
  const installed = (k) => k.names.map((n) => byName.get(n)).find(Boolean) || null;
  const rows = WALLETS.map((k) => {
    const w = installed(k);
    return w ? { id: 'w:' + k.id, label: k.label, icon: w.icon || k.icon, badge: 'Detected', tone: 'ok' }
             : { id: 'w:' + k.id, label: k.label, icon: k.icon, badge: phone ? 'Open app' : 'Install' };
  });
  return rows.filter((r) => r.tone === 'ok').concat(rows.filter((r) => r.tone !== 'ok'));
}

/* What a row press means: sign in with an installed wallet, or open the wallet's app (phone) or its download page
   (PC). */
export function pick(id, detected, phone, here) {
  const byName = new Map(detected.map((w) => [norm(w.name), w]));
  const k = WALLETS.find((x) => 'w:' + x.id === id);
  if (!k) return { kind: 'none' };
  const w = k.names.map((n) => byName.get(n)).find(Boolean);
  if (w) return { kind: 'signin', wallet: w };
  if (phone) return { kind: 'open', url: k.browse(here.url, here.origin), label: k.label };
  return { kind: 'install', url: k.install, label: k.label };
}

/* The one account this wallet signs with: `address` when given (the account the player signed in with), else the
   first. Connects first when the extension has not shared it with this page yet: silently when asked to (a wallet
   that already trusts this site connects with no popup), with the wallet's own approval otherwise. */
export async function accountFor(std, address, { silent = false } = {}) {
  const has = () => (std.accounts || []).find((a) => !address || a.address === address) || null;
  let acct = has();
  if (acct) return acct;
  const connect = std.features['standard:connect'];
  let res;
  try {
    res = await connect.connect(silent ? { silent: true } : undefined);
  } catch (e) {
    if (silent) return null;
    throw e;
  }
  const got = (res && Array.isArray(res.accounts) ? res.accounts : []);
  acct = got.find((a) => !address || a.address === address) || has();
  if (!acct && !silent && address) {
    throw new Error('Switch ' + std.name + ' to the wallet you signed in with (' + address.slice(0, 4) + '…' + address.slice(-4) + '), then try again.');
  }
  return acct || null;
}

const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};

/* Sign in with a browser wallet: connect (the wallet's approval), Privy's SIWS message, the wallet signs it,
   Privy checks it and the player is signed in with that wallet. Resolves the address. */
export async function signInWith(std, { generateSiwsMessage, loginWithSiws, onStep }) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  step('connect');
  const acct = await accountFor(std, null);
  if (!acct) throw new Error(std.name + ' did not share a wallet. Unlock it and try again.');
  const message = await generateSiwsMessage({ address: acct.address });
  step('sign');
  const out = await std.features['solana:signMessage'].signMessage({ account: acct, message: new TextEncoder().encode(message) });
  const first = Array.isArray(out) ? out[0] : out;
  if (!first || !first.signature) throw new Error(std.name + ' did not sign.');
  step('check');
  await loginWithSiws({ message, signature: b64(first.signature), walletClientType: clientTypeOf(std), connectorType: 'solana_adapter' });
  return acct.address;
}

/* Find the extension holding a signed-in wallet: one already showing that account, else the one Privy says it was
   signed in with (clientType). null when it is not in this browser. */
export function walletFor(detected, address, clientType) {
  const holding = detected.find((w) => (w.accounts || []).some((a) => a.address === address));
  if (holding) return holding;
  return detected.find((w) => clientTypeOf(w) === clientType) || null;
}

/* Signs exactly the bytes given with the signed-in account (the same shape as Privy's useSignTransaction). */
export async function signTransactionWith(std, address, transaction) {
  const acct = await accountFor(std, address);
  const out = await std.features['solana:signTransaction'].signTransaction({ account: acct, transaction, chain: SOLANA_CHAIN });
  const first = Array.isArray(out) ? out[0] : out;
  if (!first || !first.signedTransaction) throw new Error(std.name + ' did not sign.');
  return { signedTransaction: first.signedTransaction };
}

export async function signMessageWith(std, address, message) {
  const acct = await accountFor(std, address);
  const out = await std.features['solana:signMessage'].signMessage({ account: acct, message });
  const first = Array.isArray(out) ? out[0] : out;
  if (!first || !first.signature) throw new Error(std.name + ' did not sign.');
  return { signature: first.signature };
}

/* A wallet's refusal (the player pressed Cancel or closed it), told apart from a failure so the sheet can just
   close. Wallets use code 4001 (the EIP-1193 code Phantom and others kept for Solana) or say "rejected". */
export function isRefusal(e) {
  if (!e) return false;
  if (Number(e.code) === 4001) return true;
  return /reject|denied|declin|cancel|closed/i.test(String(e.message || e));
}
