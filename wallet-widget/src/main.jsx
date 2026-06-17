import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useLogin } from '@privy-io/react-auth';
import { useWallets as useSolanaWallets, useSignTransaction } from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

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
async function stakeOnly(lobbyType, wallet, signTransaction, onStatus) {
  if (lobbyType === 'free') return { entryToken: '', worthSol: 0 };
  onStatus('Getting quote…');
  const quote = await (await fetch('/api/stake-quote?lobbyType=' + encodeURIComponent(lobbyType))).json();
  if (quote.error) throw new Error(quote.error);
  if (!quote.escrowAddress) throw new Error('No escrow configured for this lobby');

  onStatus('Building stake…');
  const from = new PublicKey(wallet.address);
  const tx = new Transaction();
  tx.feePayer = from;
  tx.recentBlockhash = quote.blockhash; // real blockhash — our backend submits the signed tx
  tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(quote.escrowAddress), lamports: quote.lamports }));
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

  onStatus('Confirm in your wallet…');
  const { signedTransaction } = await signTransaction({ transaction: serialized, wallet }); // sign only — no browser WSS
  const signedTx = Buffer.from(signedTransaction).toString('base64');

  onStatus('Submitting stake…');
  const verify = await (await fetch('/api/submit-stake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyType, signedTx, walletAddress: wallet.address }),
  })).json();
  if (!verify.ok) throw new Error(verify.error || 'Stake failed');
  return { entryToken: verify.entryToken, worthSol: verify.worthSol };
}

async function stakeAndPlay(game, lobbyType, wallet, signTransaction, onStatus, onLaunch) {
  const { entryToken, worthSol } = await stakeOnly(lobbyType, wallet, signTransaction, onStatus);

  onStatus('Joining…');
  sessionStorage.setItem('playerName', localStorage.getItem('duelseries_playername') || short(wallet.address));
  sessionStorage.setItem('googleId', wallet.address);       // self-custody identity = wallet
  sessionStorage.setItem('walletAddress', wallet.address);
  sessionStorage.setItem('lobbyType', lobbyType);
  sessionStorage.setItem('entryToken', entryToken);
  sessionStorage.setItem('entrySol', String(worthSol));
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

function WalletPanel() {
  const { ready, authenticated, user, logout, getAccessToken } = usePrivy();
  const { login } = useLogin();
  const { wallets: solWallets } = useSolanaWallets();
  const { signTransaction } = useSignTransaction();
  const [balance, setBalance] = useState(null);
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

  useEffect(() => {
    window.duelWallet = { ready, authenticated, address, balance };
    window.dispatchEvent(new CustomEvent('duelwallet:change', { detail: window.duelWallet }));
  }, [ready, authenticated, address, balance]);

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
      const lt = (d && typeof d === 'object') ? (d.lobbyType || 'dime') : d;
      if (stakeRef.current) stakeRef.current(game, lt);
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
        const { entryToken } = await stakeOnly(d.lobbyType, wallet, signTransaction, () => {});
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
    window.duelWalletLogin = () => login();
    window.duelWalletLogout = () => logout();
    window.duelWalletRefresh = async () => {
      if (!address) return null;
      const b = await fetchSolBalance(address);
      setBalance(b);
      return b;
    };
    window.duelWalletSend = (amountSol, toAddress) => {
      if (!wallet) return Promise.reject(new Error('Wallet not ready — try again in a moment.'));
      return sendSol(toAddress, amountSol, wallet, signTransaction);
    };
  }, [wallet, signTransaction, address, login, logout]);

  // Keep the Privy access token in localStorage so same-origin admin pages + game iframes can
  // authenticate owner-only actions (the server verifies it → OWNER_WALLET). Refreshed on a timer.
  useEffect(() => {
    if (!authenticated) { try { localStorage.removeItem('duel_admin_token'); } catch (_) {} return; }
    let live = true;
    const refresh = async () => {
      try { const t = await getAccessToken(); if (live && t) localStorage.setItem('duel_admin_token', t); } catch (_) {}
    };
    refresh();
    const id = setInterval(refresh, 5 * 60 * 1000);
    return () => { live = false; clearInterval(id); };
  }, [authenticated]);

  const doStake = async (game, lobbyType) => {
    if (busyRef.current) return; // already staking — drop the rapid re-clicks (no double charge)
    if (!wallet) { setErr('Wallet still loading — try again in a moment.'); return; }
    busyRef.current = true;
    setBusy(true); setErr(''); setStatus('');
    try {
      await stakeAndPlay(game, lobbyType, wallet, signTransaction, setStatus, () => setPlaying(true));
    } catch (e) {
      const m = (e && e.message) || 'Stake failed';
      setErr(/insufficient funds|rent/i.test(m)
        ? "Not enough SOL — add a bit more (a 10¢ entry needs ~0.002 SOL on hand; the extra covers Solana's per-wallet rent minimum)."
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
