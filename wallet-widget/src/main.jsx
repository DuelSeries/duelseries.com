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
async function stakeAndPlay(lobbyType, wallet, signTransaction, onStatus, onLaunch) {
  let entryToken = '';
  let worthSol = 0;

  if (lobbyType !== 'free') {
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
    entryToken = verify.entryToken;
    worthSol = verify.worthSol;
  }

  onStatus('Joining…');
  sessionStorage.setItem('playerName', localStorage.getItem('duelseries_playername') || short(wallet.address));
  sessionStorage.setItem('googleId', wallet.address);       // self-custody identity = wallet
  sessionStorage.setItem('walletAddress', wallet.address);
  sessionStorage.setItem('lobbyType', lobbyType);
  sessionStorage.setItem('entryToken', entryToken);
  sessionStorage.setItem('entrySol', String(worthSol));
  sessionStorage.setItem('region', 'na');
  sessionStorage.setItem('snakeColor', localStorage.getItem('duelseries_skin_color') || '#14F195');
  sessionStorage.setItem('hatId', localStorage.getItem('duelseries_hat_id') || 'none');
  sessionStorage.setItem('boostId', localStorage.getItem('duelseries_boost_id') || 'default');
  sessionStorage.removeItem('spectateOnly');
  // Launch in the lobby's iframe (keeps the lobby loaded; the in-game Lobby button returns
  // cleanly via the lobby's game:done handler). Fall back to a full-page nav if it's gone.
  const frame = document.getElementById('game-frame');
  if (frame) {
    if (window._pauseLobbyAnims) window._pauseLobbyAnims();
    onLaunch();
    frame.src = '/game.html';
    frame.style.display = 'block';
  } else {
    window.location.href = '/game.html';
  }
}

function WalletPanel() {
  const { ready, authenticated, user, logout } = usePrivy();
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
    const onPlay = (e) => { if (stakeRef.current) stakeRef.current((e && e.detail) || 'dime'); };
    window.addEventListener('duel:play', onPlay);
    return () => window.removeEventListener('duel:play', onPlay);
  }, []);

  const doStake = async (lobbyType) => {
    if (!wallet) { setErr('Wallet still loading — try again in a moment.'); return; }
    setBusy(true); setErr(''); setStatus('');
    try {
      await stakeAndPlay(lobbyType, wallet, signTransaction, setStatus, () => setPlaying(true));
    } catch (e) {
      const m = (e && e.message) || 'Stake failed';
      setErr(/insufficient funds|rent/i.test(m)
        ? "Not enough SOL — add a bit more (a 10¢ entry needs ~0.002 SOL on hand; the extra covers Solana's per-wallet rent minimum)."
        : m);
      setBusy(false); setStatus('');
    }
  };
  stakeRef.current = doStake; // keep the latest closure for the lobby's duel:play event
  const onStake = () => doStake(tier);

  if (playing) return null; // hidden while the game iframe covers the screen

  const lowFunds = tier !== 'free' && balance != null && balance < 0.0025;

  return (
    <div style={st.box}>
      <div style={st.title}>Self-custody wallet <span style={st.beta}>beta</span></div>
      {!ready ? (
        <div style={st.muted}>Loading…</div>
      ) : !authenticated ? (
        <button style={st.btn} onClick={login}>Connect Wallet</button>
      ) : (
        <>
          <div style={st.row}><span style={st.muted}>Wallet</span><span style={st.mono}>{address ? short(address) : 'creating…'}</span></div>
          <div style={st.row}><span style={st.muted}>Balance</span><span style={st.mono}>{balance == null ? '…' : balance.toFixed(4) + ' SOL'}</span></div>
          <button style={{ ...st.btn, marginTop: 8, opacity: busy ? 0.6 : 1 }} onClick={onStake} disabled={busy || !address}>
            {busy ? (status || 'Working…') : `${TIER_LABEL[tier] || 'Play'} (beta)`}
          </button>
          {lowFunds && !busy && (
            <div style={st.hint}>Fund this wallet with a little SOL (send to the address above) to play.</div>
          )}
          {err && <div style={st.err}>{err}</div>}
          <button style={st.link} onClick={logout} disabled={busy}>Log out</button>
        </>
      )}
    </div>
  );
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
};

function App() {
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        loginMethods: ['google', 'email'],
        embeddedWallets: { createOnLogin: 'all-users' },
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
