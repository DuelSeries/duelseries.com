import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useLogin, useIdentityToken } from '@privy-io/react-auth';
import { useWallets as useSolanaWallets, useSignTransaction, useSignMessage, useFundWallet } from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import bs58 from 'bs58';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';

// Active money mode (sol|usdc) reported by the server — decides whether the widget builds native
// SOL transfers or USDC SPL-token transfers, and how it labels balances. Cached after first fetch.
let _moneyCfg = null;
async function moneyConfig() {
  if (_moneyCfg) return _moneyCfg;
  try { _moneyCfg = await (await fetch('/api/money-config')).json(); }
  catch { _moneyCfg = { mode: 'sol', unit: 'SOL', usdcMint: null, decimals: 9 }; }
  return _moneyCfg;
}

// Phase 1 — self-custody stake-on-join. Connect (Phase 0) + a "Stake & Play" button that
// moves the entry fee from the player's embedded wallet into the escrow (one-tap Confirm),
// the server verifies it on-chain and issues the entry token the game already consumes.
// See docs/self-custody-migration.md.
const APP_ID = 'cmpnepg0100f20cl10wdig1fr';
// RPC goes through our own backend proxy so the browser doesn't hit a public RPC that
// 403s browser origins. (WSS is confirmation-only; the stake is verified server-side too.)
const RPC_HTTP = (typeof window !== 'undefined' ? window.location.origin : '') + '/api/rpc';
const RPC_WSS = 'wss://api.mainnet-beta.solana.com';

async function fetchSolBalance(address) {
  try {
    const r = await fetch('/api/sol-balance?address=' + encodeURIComponent(address));
    const j = await r.json();
    return typeof j.sol === 'number' ? j.sol : null;
  } catch { return null; }
}

const short = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');

function solanaAddress(user) {
  if (!user) return null;
  const accts = user.linkedAccounts || [];
  const isSol = (a) => a && a.type === 'wallet' && a.chainType === 'solana';
  const w = accts.find((a) => isSol(a) && a.walletClientType === 'privy') || accts.find(isSol);
  if (w?.address) return w.address;
  if (user.wallet?.chainType === 'solana') return user.wallet.address;
  return null;
}

// Stake the entry fee from the embedded wallet into the escrow, verify it server-side,
// then launch the game with the returned entry token. `onStatus` reports progress.
const TIER_LABEL = { free: 'Play Free', dime: 'Stake & Play 10¢', dollar: 'Stake & Play $1' };

// Stake the entry fee (paid lobbies) from the embedded wallet into the escrow, verify it
// server-side, then launch the game. Free lobbies skip the stake entirely.
// Stake the entry fee for a paid lobby and return the verified entry token (no launch). Used
// by both stakeAndPlay and the in-game "Play Again" re-stake. Free lobbies stake nothing.
// The lobby is served from the NA origin, but a paid stake must hit the SAME regional server
// the game will connect to (game.js's SERVER_URLS) — the one-time entry token is minted in
// that server's memory and consumed there on join. Mismatch = paid EU lobbies never load.
const SERVER_URLS = { na: '', eu: 'https://eu.duelseries.com' };
function regionBase() { return SERVER_URLS[localStorage.getItem('duelseries_region') || 'na'] || ''; }

/* `sel` selects the room to buy into, in one of two forms:
     'dime' | { lobbyType: 'dime' }   the original fixed tiers
     { stake: 2 }                     a rung of the stake ladder
   Both are supported while the two lobbies run side by side: index.html sends
   a tier, /v2 sends a rung. The request differs only in which parameter names
   the room; everything about building, signing and submitting the transfer is
   the same code either way, so there is one staking path and not two. */
function stakeSpec(sel) {
  if (typeof sel === 'string') return { lobbyType: sel };
  return sel || {};
}
async function stakeOnly(sel, wallet, signTransaction, onStatus) {
  const spec = stakeSpec(sel);
  const byStake = spec.stake !== undefined && spec.stake !== null;
  // Free costs nothing and needs no token, whichever way it was named.
  if (byStake ? Number(spec.stake) === 0 : spec.lobbyType === 'free') {
    return { entryToken: '', worth: 0 };
  }
  const base = regionBase();
  onStatus('Getting quote…');
  const query = byStake
    ? '/api/stake-quote?stake=' + encodeURIComponent(spec.stake)
    : '/api/stake-quote?lobbyType=' + encodeURIComponent(spec.lobbyType);
  const quote = await (await fetch(base + query)).json();
  if (quote.error) throw new Error(quote.error);

  /* The PRICE decides, not the name. The check above catches the lobby actually
     called 'free'; this catches every other lobby that costs nothing — the
     battle royale is the first, entered for free with the prize paid by the
     house. Without it that quote came back priced at zero with no escrow to pay
     (correctly, there is nothing to pay) and this threw 'No escrow configured
     for this lobby' at a player trying to enter a free event.

     Both money modes: SOL prices in lamports, USDC in units. A quote with
     nothing to transfer needs no transfer. */
  const owes = quote.mode === 'usdc'
    ? Number(quote.units || 0)
    : Number(quote.lamports || 0);
  if (!owes) return { entryToken: '', worth: 0 };

  onStatus('Building stake…');
  const from = new PublicKey(wallet.address);
  const tx = new Transaction();
  tx.feePayer = from;
  tx.recentBlockhash = quote.blockhash; // real blockhash — our backend submits the signed tx
  if (quote.mode === 'usdc') {
    // USDC stake: SPL transfer from the player's USDC token account into the escrow's.
    const mint = new PublicKey(quote.usdcMint);
    const fromAta = getAssociatedTokenAddressSync(mint, from);
    const escrowAta = new PublicKey(quote.escrowAta);
    // Make sure the escrow's USDC account exists before transferring into it. Idempotent: only the
    // very first staker ever pays the ~0.002 SOL rent (a no-op once it exists). Without this, the
    // first USDC stake fails — you can't transferChecked into a token account that isn't created.
    if (quote.escrowOwner) tx.add(createAssociatedTokenAccountIdempotentInstruction(from, escrowAta, new PublicKey(quote.escrowOwner), mint));
    tx.add(createTransferCheckedInstruction(fromAta, mint, escrowAta, from, BigInt(quote.units), quote.decimals));
  } else {
    if (!quote.escrowAddress) throw new Error('No escrow configured for this lobby');
    tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(quote.escrowAddress), lamports: quote.lamports }));
  }
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

  onStatus('Confirm in your wallet…');
  const { signedTransaction } = await signTransaction({ transaction: serialized, wallet }); // sign only — no browser WSS
  const signedTx = Buffer.from(signedTransaction).toString('base64');

  onStatus('Submitting stake…');
  const verify = await (await fetch(base + '/api/submit-stake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(byStake
      ? { stake: spec.stake, signedTx, walletAddress: wallet.address }
      : { lobbyType: spec.lobbyType, signedTx, walletAddress: wallet.address }),
  })).json();
  if (!verify.ok) throw new Error(verify.error || 'Stake failed');
  /* worth is the server's figure, never ours. On the ladder it is the rung the
     payment resolved to, which can be lower than what was asked for if the
     amount fell short, so the caller must use this and not spec.stake. */
  return { entryToken: verify.entryToken,
           worth: (verify.worth != null ? verify.worth : verify.worthSol),
           stake: verify.stake };
}

// Buy a cosmetic with USDC. Mirrors stakeOnly, but the payment goes to the owner wallet (house
// revenue) and the server grants ownership instead of an entry token. If the server says the buyer
// is the owner (quote.free), there's no payment — the house doesn't pay itself.
async function buyCosmetic(itemId, wallet, signTransaction, onStatus) {
  const base = regionBase();
  const from = new PublicKey(wallet.address);
  if (onStatus) onStatus('Getting price…');
  const quote = await (await fetch(base + '/api/cosmetics/quote?itemId=' + encodeURIComponent(itemId) + '&wallet=' + encodeURIComponent(wallet.address))).json();
  if (quote.error) throw new Error(quote.error);
  let signedTx = null;
  if (!quote.free) {
    if (onStatus) onStatus('Building payment…');
    const mint = new PublicKey(quote.usdcMint);
    const fromAta = getAssociatedTokenAddressSync(mint, from);
    const toAta = new PublicKey(quote.payToAta);
    const tx = new Transaction();
    tx.feePayer = from;
    tx.recentBlockhash = quote.blockhash;
    if (quote.payToOwner) tx.add(createAssociatedTokenAccountIdempotentInstruction(from, toAta, new PublicKey(quote.payToOwner), mint));
    tx.add(createTransferCheckedInstruction(fromAta, mint, toAta, from, BigInt(quote.units), quote.decimals));
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    if (onStatus) onStatus('Confirm in your wallet…');
    const { signedTransaction } = await signTransaction({ transaction: serialized, wallet });
    signedTx = Buffer.from(signedTransaction).toString('base64');
  }
  if (onStatus) onStatus('Unlocking…');
  const r = await (await fetch(base + '/api/cosmetics/buy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedTx, itemId, walletAddress: wallet.address }),
  })).json();
  if (!r.ok) throw new Error(r.error || 'Purchase failed');
  return r; // { ok, itemId, owned, free? }
}

async function stakeAndPlay(game, sel, wallet, signTransaction, onStatus, onLaunch) {
  const spec = stakeSpec(sel);
  const byStake = spec.stake !== undefined && spec.stake !== null;
  const { entryToken, worth, stake } = await stakeOnly(spec, wallet, signTransaction, onStatus);

  onStatus('Joining…');
  sessionStorage.setItem('playerName', localStorage.getItem('duelseries_playername') || short(wallet.address));
  sessionStorage.setItem('googleId', wallet.address);       // self-custody identity = wallet
  sessionStorage.setItem('walletAddress', wallet.address);
  /* The game echoes these back when it joins, and the server decides the room
     from whichever it receives. On the ladder the stake is the SERVER's rung,
     not what was asked for, so a payment that resolved down lands in the room
     it actually bought. lobbyType stays set for the tier path and is cleared
     on the ladder path so the two can never both be honoured. */
  if (byStake) {
    sessionStorage.setItem('stake', String(stake != null ? stake : worth));
    sessionStorage.removeItem('lobbyType');
  } else {
    sessionStorage.setItem('lobbyType', spec.lobbyType);
    sessionStorage.removeItem('stake');
  }
  sessionStorage.setItem('entryToken', entryToken);
  sessionStorage.setItem('entrySol', String(worth));
  sessionStorage.setItem('region', localStorage.getItem('duelseries_region') || 'na'); // honour the lobby's region pick (na/eu)
  sessionStorage.setItem('snakeColor', localStorage.getItem('duelseries_skin_color') || '#14F195');
  sessionStorage.setItem('hatId', localStorage.getItem('duelseries_hat_id') || 'none');
  sessionStorage.setItem('boostId', localStorage.getItem('duelseries_boost_id') || 'default');
  if (game === 'agar') sessionStorage.setItem('gameMode', 'cell'); else sessionStorage.removeItem('gameMode');
  sessionStorage.removeItem('spectateOnly');
  // Launch in the lobby's iframe (snake → game-frame/game.html, agar → agar-frame/agar.html);
  // the in-game Lobby button returns cleanly via the lobby's game:done handler.
  const isAgar = game === 'agar';
  const frame = document.getElementById(isAgar ? 'agar-frame' : 'game-frame');
  const html = isAgar ? '/agar.html' : '/game.html';
  if (frame) {
    if (window._pauseLobbyAnims) window._pauseLobbyAnims();
    onLaunch();
    // Focus the game iframe once it loads so keyboard (boost / cash-out) works immediately.
    // The Privy approval modal had focus, so without this the player has to click in first.
    frame.addEventListener('load', () => {
      const focusGame = () => { try { frame.contentWindow.focus(); } catch (_) {} };
      focusGame(); setTimeout(focusGame, 150); // again after the modal finishes returning focus
    }, { once: true });
    frame.src = html;
    frame.style.display = 'block';
  } else {
    window.location.href = html;
  }
}

// Self-custody Cash Out: send SOL from the embedded wallet to any external address. Privy
// signs; our backend relays + confirms (the browser can't reach a public RPC directly).
async function sendSol(toAddress, amountSol, wallet, signTransaction) {
  let toPub;
  try { toPub = new PublicKey(toAddress); } catch (_) { throw new Error("That doesn't look like a valid Solana address."); }
  const { blockhash } = await (await fetch('/api/blockhash')).json();
  if (!blockhash) throw new Error('Network busy — try again.');
  const from = new PublicKey(wallet.address);
  const tx = new Transaction();
  tx.feePayer = from;
  tx.recentBlockhash = blockhash;
  tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: toPub, lamports: Math.round(amountSol * 1e9) }));
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const { signedTransaction } = await signTransaction({ transaction: serialized, wallet });
  const signedTx = Buffer.from(signedTransaction).toString('base64');
  const r = await (await fetch('/api/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signedTx }) })).json();
  if (!r.ok) throw new Error(r.error || 'Send failed');
  return r.sig;
}

// USDC cash-out: send USDC from the embedded wallet to any external address. Creates the
// recipient's USDC token account if they don't have one (idempotent — no-op if it exists).
async function sendUsdc(toAddress, amountUsdc, mint, decimals, wallet, signTransaction) {
  let toPub;
  try { toPub = new PublicKey(toAddress); } catch (_) { throw new Error("That doesn't look like a valid Solana address."); }
  const mintPub = new PublicKey(mint);
  const from = new PublicKey(wallet.address);
  const fromAta = getAssociatedTokenAddressSync(mintPub, from);
  const toAta = getAssociatedTokenAddressSync(mintPub, toPub);
  const { blockhash } = await (await fetch('/api/blockhash')).json();
  if (!blockhash) throw new Error('Network busy — try again.');
  const tx = new Transaction();
  tx.feePayer = from;
  tx.recentBlockhash = blockhash;
  tx.add(createAssociatedTokenAccountIdempotentInstruction(from, toAta, toPub, mintPub));
  tx.add(createTransferCheckedInstruction(fromAta, mintPub, toAta, from, BigInt(Math.round(amountUsdc * Math.pow(10, decimals))), decimals));
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const { signedTransaction } = await signTransaction({ transaction: serialized, wallet });
  const signedTx = Buffer.from(signedTransaction).toString('base64');
  const r = await (await fetch('/api/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signedTx }) })).json();
  if (!r.ok) throw new Error(r.error || 'Send failed');
  return r.sig;
}

function WalletPanel() {
  const { ready, authenticated, user, logout, getAccessToken } = usePrivy();
  const { login } = useLogin();
  // Carries the linked accounts with it, so the server can resolve the wallet in one
  // call that Privy does not rate limit. Null unless identity tokens are switched on
  // for the app, which is why nothing depends on it alone.
  const { identityToken } = useIdentityToken();
  const { wallets: solWallets } = useSolanaWallets();
  const { signTransaction } = useSignTransaction();
  const { signMessage } = useSignMessage();
  const { fundWallet } = useFundWallet();
  const [balance, setBalance] = useState(null);
  const [unit, setUnit] = useState('SOL'); // balance unit label (SOL or USDC), from /api/money-config
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');
  const [playing, setPlaying] = useState(false);
  const [tier, setTier] = useState(() => { try { return localStorage.getItem('duelseries_lobbytype') || 'free'; } catch { return 'free'; } });
  const stakeRef = useRef(null);
  const busyRef = useRef(false); // synchronous guard: no double-staking on rapid Play clicks

  const wallet = solWallets && solWallets[0];
  const address = (wallet && wallet.address) || solanaAddress(user);

  useEffect(() => {
    if (!address) { setBalance(null); return; }
    let live = true;
    const tick = () => fetchSolBalance(address).then((b) => { if (live) setBalance(b); });
    tick();
    const id = setInterval(tick, 15000);
    return () => { live = false; clearInterval(id); };
  }, [address]);

  useEffect(() => { moneyConfig().then((c) => setUnit(c.unit || 'SOL')).catch(() => {}); }, []);

  useEffect(() => {
    window.duelWallet = { ready, authenticated, address, balance, unit };
    window.dispatchEvent(new CustomEvent('duelwallet:change', { detail: window.duelWallet }));
  }, [ready, authenticated, address, balance, unit]);

  // Hide the widget while the game iframe covers the screen; re-show on return to lobby.
  useEffect(() => {
    const onMsg = (e) => { if (e && e.data === 'game:done') { setPlaying(false); setBusy(false); setStatus(''); } };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Follow the lobby's selected tier (Free / 10¢ / $1).
  useEffect(() => {
    const onChange = (e) => setTier((e && e.detail) || 'free');
    window.addEventListener('duel:lobbychange', onChange);
    return () => window.removeEventListener('duel:lobbychange', onChange);
  }, []);

  // Phase 4a: the lobby's main Play button routes paid self-custody play here.
  useEffect(() => {
    const onPlay = (e) => {
      const d = (e && e.detail) || {};
      const game = (d && typeof d === 'object') ? (d.game || 'snake') : 'snake';
      /* A stake on the event wins, so the ladder lobby is served even though
         the old default is still here for index.html. The 'dime' fallback is
         deliberately NOT applied when a stake was given: defaulting a missing
         room to a paid one is how a player gets charged for a room they did
         not pick. */
      const sel = (d && typeof d === 'object' && d.stake !== undefined && d.stake !== null)
        ? { stake: d.stake }
        : { lobbyType: (d && typeof d === 'object') ? (d.lobbyType || 'dime') : d };
      if (stakeRef.current) stakeRef.current(game, sel);
    };
    window.addEventListener('duel:play', onPlay);
    return () => window.removeEventListener('duel:play', onPlay);
  }, []);

  // In-game "Play Again": the game iframe asks us to re-stake; we run the Privy approval and
  // post the fresh entry token back so it can respawn without a trip to the lobby.
  useEffect(() => {
    const onMsg = async (e) => {
      const d = e && e.data;
      if (!d || d.type !== 'duel:restake') return;
      const frame = document.getElementById(d.game === 'agar' ? 'agar-frame' : 'game-frame');
      const post = (msg) => { try { frame && frame.contentWindow && frame.contentWindow.postMessage(msg, '*'); } catch (_) {} };
      if (!wallet) { post({ type: 'duel:restake:error', message: 'Wallet not ready — return to lobby.' }); return; }
      try {
        /* Play Again re-buys the SAME room the game is already in. The game echoes
           back whichever of the two named it, so a ladder game restakes at its
           rung and a tier game at its tier. */
        const reSel = (d.stake !== undefined && d.stake !== null) ? { stake: d.stake } : { lobbyType: d.lobbyType };
        const { entryToken } = await stakeOnly(reSel, wallet, signTransaction, () => {});
        post({ type: 'duel:restake:done', entryToken });
        // Return focus to the game after the Privy modal so keyboard works without a click.
        const focusGame = () => { try { frame && frame.contentWindow && frame.contentWindow.focus(); } catch (_) {} };
        focusGame(); setTimeout(focusGame, 150);
      } catch (err) {
        post({ type: 'duel:restake:error', message: (err && err.message) || 'Stake failed' });
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [wallet, signTransaction]);

  // Expose wallet actions for the lobby's wallet card (Phase 4d: the card is the wallet UI).
  useEffect(() => {
    /* A token straight from Privy at the moment it is needed. The localStorage copy
       below is a cache for pages that cannot await anything (the game iframes); a
       lobby action should not fail just because that cache is empty or stale. */
    window.duelWalletToken = async () => {
      let access = null;
      try { access = await getAccessToken(); } catch (_) {}
      if (!access) { try { access = localStorage.getItem('duel_admin_token'); } catch (_) {} }
      let identity = identityToken;
      if (!identity) { try { identity = localStorage.getItem('duel_id_token'); } catch (_) {} }
      return { access, identity };
    };
    /* Proof that this wallet asked for this name, needing nothing from Privy's
       servers at the moment it is used. The string must match the server's
       nameMessage() byte for byte. */
    window.duelWalletSignName = async (name) => {
      if (!wallet || !address) return null;
      const ts = Date.now();
      const msg = 'DuelSeries: change display name\n'
                + 'wallet: ' + address + '\n'
                + 'name: ' + name + '\n'
                + 'at: ' + ts;
      const { signature } = await signMessage({
        message: new TextEncoder().encode(msg),
        wallet,
        options: { uiOptions: { showWalletUIs: false } },
      });
      return { wallet: address, ts, sig: bs58.encode(signature) };
    };
    /* Signs an OWNER action. Same mechanism as the name change and the same
       reason: it needs nothing from Privy at the moment it is used, so owner
       controls cannot be locked out by an app id, a rate limit or an outage.
       The string must match server/ownerAuth.js actionMessage() byte for byte. */
    window.duelWalletSignAction = async (action, args) => {
      if (!wallet || !address) return null;
      const ts = Date.now();
      const a = args || {};
      const msg = 'DuelSeries owner action\n'
                + 'action: ' + action + '\n'
                + 'args: ' + JSON.stringify(a) + '\n'
                + 'wallet: ' + address + '\n'
                + 'at: ' + ts;
      const { signature } = await signMessage({
        message: new TextEncoder().encode(msg),
        wallet,
        options: { uiOptions: { showWalletUIs: false } },
      });
      return { action, args: a, wallet: address, ts, sig: bs58.encode(signature) };
    };
    window.duelWalletLogin = () => login();
    window.duelWalletLogout = () => logout();
    window.duelWalletRefresh = async () => {
      if (!address) return null;
      const b = await fetchSolBalance(address);
      setBalance(b);
      return b;
    };
    window.duelWalletSend = async (amount, toAddress) => {
      if (!wallet) return Promise.reject(new Error('Wallet not ready — try again in a moment.'));
      const cfg = await moneyConfig();
      return cfg.mode === 'usdc'
        ? sendUsdc(toAddress, amount, cfg.usdcMint, cfg.decimals, wallet, signTransaction)
        : sendSol(toAddress, amount, wallet, signTransaction);
    };
    // Add Funds — opens Privy's branded funding flow. defaultFundingMethod 'manual' lands the user
    // straight on the "Receive USDC on Solana" deposit screen (QR + address). (Card/exchange methods
    // only appear if their providers are enabled in the Privy dashboard.)
    window.duelWalletFund = (amountUsd) => {
      if (!address) return Promise.reject(new Error('Connect your wallet first.'));
      return fundWallet({ address, options: { chain: 'solana:mainnet', asset: 'USDC', amount: String(amountUsd || 20), defaultFundingMethod: 'manual' } });
    };
    // Buy a cosmetic with USDC (owner gets it free). Resolves { ok, owned, free? }.
    window.duelWalletBuyCosmetic = (itemId, onStatus) => {
      if (!wallet) return Promise.reject(new Error('Connect your wallet first.'));
      return buyCosmetic(itemId, wallet, signTransaction, onStatus);
    };
  }, [wallet, signTransaction, signMessage, address, login, logout, fundWallet, identityToken, getAccessToken]);

  // Keep the Privy access token in localStorage so same-origin admin pages + game iframes can
  // authenticate owner-only actions (the server verifies it → OWNER_WALLET). Refreshed on a timer.
  useEffect(() => {
    if (!authenticated) {
      try { localStorage.removeItem('duel_admin_token'); localStorage.removeItem('duel_id_token'); } catch (_) {}
      return;
    }
    let live = true;
    const refresh = async () => {
      try { const t = await getAccessToken(); if (live && t) localStorage.setItem('duel_admin_token', t); } catch (_) {}
      try { if (live && identityToken) localStorage.setItem('duel_id_token', identityToken); } catch (_) {}
    };
    refresh();
    const id = setInterval(refresh, 5 * 60 * 1000);
    return () => { live = false; clearInterval(id); };
  }, [authenticated, identityToken]);

  const doStake = async (game, sel) => {
    if (busyRef.current) return; // already staking — drop the rapid re-clicks (no double charge)
    if (!wallet) { setErr('Wallet still loading — try again in a moment.'); return; }
    busyRef.current = true;
    setBusy(true); setErr(''); setStatus('');
    try {
      await stakeAndPlay(game, sel, wallet, signTransaction, setStatus, () => setPlaying(true));
    } catch (e) {
      const m = (e && e.message) || 'Stake failed';
      setErr(/insufficient funds|rent|TokenAccountNotFound|could not find account/i.test(m)
        ? `Not enough funds — your wallet needs ${unit} for the entry plus a little SOL for network fees.`
        : m);
      setBusy(false); setStatus('');
    } finally {
      busyRef.current = false;
    }
  };
  stakeRef.current = doStake; // keep the latest closure for the lobby's duel:play event

  // While a stake is in flight, show a full-screen blocking "Joining…" overlay — it gives
  // feedback AND covers the Play button so extra clicks can't fire more stakes. On error,
  // show a dismissible message. Otherwise headless (the lobby card is the wallet UI).
  if (playing) return null;
  if (busy) {
    return (
      <div style={st.overlay}>
        <div style={st.card}>
          <div style={st.spinner} />
          <div style={st.ovText}>{status || 'Joining…'}</div>
        </div>
      </div>
    );
  }
  if (err) {
    return (
      <div style={st.overlay}>
        <div style={st.card}>
          <div style={st.ovText}>{err}</div>
          <button style={st.btn} onClick={() => setErr('')}>OK</button>
        </div>
      </div>
    );
  }
  return null;
}

// Inject the spinner keyframes once (inline styles can't define @keyframes).
if (typeof document !== 'undefined' && !document.getElementById('duel-wallet-css')) {
  const s = document.createElement('style');
  s.id = 'duel-wallet-css';
  s.textContent = '@keyframes duelspin{to{transform:rotate(360deg)}}';
  document.head.appendChild(s);
}

const st = {
  box: { position: 'fixed', bottom: 14, right: 14, zIndex: 99999, width: 240, padding: '12px 14px', background: 'rgba(10,14,26,0.92)', border: '1px solid #1c2a44', borderRadius: 12, color: '#cfe3ff', font: '13px/1.4 system-ui, sans-serif', boxShadow: '0 8px 28px rgba(0,0,0,0.4)' },
  title: { fontWeight: 700, marginBottom: 8, fontSize: 12, letterSpacing: '0.3px', color: '#9fb6d6' },
  beta: { fontSize: 9, color: '#08210f', background: '#14F195', padding: '1px 5px', borderRadius: 6, marginLeft: 6, fontWeight: 800, verticalAlign: 'middle' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '6px 0' },
  muted: { color: '#7e93b4' },
  mono: { fontFamily: 'ui-monospace, monospace', color: '#eaf2ff' },
  btn: { width: '100%', padding: '8px 10px', background: '#14F195', color: '#08210f', border: 0, borderRadius: 8, fontWeight: 700, cursor: 'pointer' },
  link: { marginTop: 8, background: 'none', border: 0, color: '#7e93b4', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' },
  hint: { marginTop: 8, fontSize: 11, color: '#e0b65a' },
  err: { marginTop: 8, fontSize: 11, color: '#ff7a7a', wordBreak: 'break-word' },
  bal: { fontSize: 26, fontWeight: 800, color: '#eaf2ff', margin: '2px 0 6px', letterSpacing: '0.5px' },
  balUnit: { fontSize: 13, fontWeight: 700, color: '#7e93b4' },
  actions: { display: 'flex', gap: 8, marginTop: 10 },
  btnSm: { flex: 1, padding: '9px 6px', background: 'rgba(20,241,149,0.12)', color: '#14F195', border: '1px solid #14F195', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  addr: { fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#eaf2ff', background: '#0a0e1a', border: '1px solid #1c2a44', borderRadius: 8, padding: '8px', margin: '8px 0', wordBreak: 'break-all' },
  input: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', margin: '6px 0', background: '#0a0e1a', border: '1px solid #1c2a44', borderRadius: 8, color: '#eaf2ff', fontSize: 13 },
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(6,9,18,0.82)' },
  card: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '28px 34px', background: 'rgba(12,17,30,0.97)', border: '1px solid #1c2a44', borderRadius: 16, color: '#eaf2ff', font: '15px/1.45 system-ui, sans-serif', minWidth: 200, maxWidth: 340, textAlign: 'center', boxShadow: '0 12px 40px rgba(0,0,0,0.5)' },
  spinner: { width: 34, height: 34, borderRadius: '50%', border: '3px solid #1c2a44', borderTopColor: '#14F195', animation: 'duelspin 0.8s linear infinite' },
  ovText: { fontWeight: 600, color: '#cfe3ff', wordBreak: 'break-word' },
};

function App() {
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        loginMethods: ['google', 'email'],
        // showWalletUIs:false → sign the stake / cash-out silently (no Privy approve + "all set"
        // screens). The Join Game / Cash Out Send click is the confirmation; one tap into the game.
        embeddedWallets: { createOnLogin: 'all-users', showWalletUIs: false },
        appearance: { walletChainType: 'solana-only' },
        solana: {
          rpcs: {
            'solana:mainnet': {
              rpc: createSolanaRpc(RPC_HTTP),
              rpcSubscriptions: createSolanaRpcSubscriptions(RPC_WSS),
            },
          },
        },
      }}
    >
      <WalletPanel />
    </PrivyProvider>
  );
}

const mount = document.getElementById('wallet-root');
if (mount) createRoot(mount).render(<App />);
console.log('[wallet-widget] v2 (stake-on-join) loaded');
