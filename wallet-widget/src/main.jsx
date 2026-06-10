import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useLogin } from '@privy-io/react-auth';

// Phase 0 · step 2 — Privy login + embedded Solana wallet, shown alongside the existing
// app (nothing removed yet). We read the wallet ADDRESS straight off the Privy `user`
// object (no @privy-io/react-auth/solana import, so no @solana/kit transaction deps —
// those come in Phase 1 when we actually sign stakes). Balance comes from our own
// backend (/api/sol-balance). See docs/self-custody-migration.md.
const APP_ID = 'cmpnepg0100f20cl10wdig1fr';

async function fetchSolBalance(address) {
  try {
    const r = await fetch('/api/sol-balance?address=' + encodeURIComponent(address));
    const j = await r.json();
    return typeof j.sol === 'number' ? j.sol : null;
  } catch { return null; }
}

const short = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');

// The embedded Solana wallet address from the Privy user object.
function solanaAddress(user) {
  if (!user) return null;
  const accts = user.linkedAccounts || [];
  const isSol = (a) => a && a.type === 'wallet' && a.chainType === 'solana';
  const w = accts.find((a) => isSol(a) && a.walletClientType === 'privy') || accts.find(isSol);
  if (w?.address) return w.address;
  if (user.wallet?.chainType === 'solana') return user.wallet.address;
  return null;
}

function WalletPanel() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { login } = useLogin();
  const [balance, setBalance] = useState(null);
  const address = solanaAddress(user);

  // Poll the balance from our backend while we have an address.
  useEffect(() => {
    if (!address) { setBalance(null); return; }
    let live = true;
    const tick = () => fetchSolBalance(address).then((b) => { if (live) setBalance(b); });
    tick();
    const id = setInterval(tick, 15000);
    return () => { live = false; clearInterval(id); };
  }, [address]);

  // Bridge: expose the wallet to the vanilla lobby/game code (Phase 1 will use this).
  useEffect(() => {
    window.duelWallet = { ready, authenticated, address, balance };
    window.dispatchEvent(new CustomEvent('duelwallet:change', { detail: window.duelWallet }));
  }, [ready, authenticated, address, balance]);

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
          <button style={st.link} onClick={logout}>Log out</button>
        </>
      )}
    </div>
  );
}

const st = {
  box: { position: 'fixed', bottom: 14, right: 14, zIndex: 99999, width: 230, padding: '12px 14px', background: 'rgba(10,14,26,0.92)', border: '1px solid #1c2a44', borderRadius: 12, color: '#cfe3ff', font: '13px/1.4 system-ui, sans-serif', boxShadow: '0 8px 28px rgba(0,0,0,0.4)' },
  title: { fontWeight: 700, marginBottom: 8, fontSize: 12, letterSpacing: '0.3px', color: '#9fb6d6' },
  beta: { fontSize: 9, color: '#08210f', background: '#14F195', padding: '1px 5px', borderRadius: 6, marginLeft: 6, fontWeight: 800, verticalAlign: 'middle' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '6px 0' },
  muted: { color: '#7e93b4' },
  mono: { fontFamily: 'ui-monospace, monospace', color: '#eaf2ff' },
  btn: { width: '100%', padding: '8px 10px', background: '#14F195', color: '#08210f', border: 0, borderRadius: 8, fontWeight: 700, cursor: 'pointer' },
  link: { marginTop: 8, background: 'none', border: 0, color: '#7e93b4', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' },
};

function App() {
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        loginMethods: ['google', 'email'],
        embeddedWallets: { createOnLogin: 'all-users' },
        appearance: { walletChainType: 'solana-only' },
      }}
    >
      <WalletPanel />
    </PrivyProvider>
  );
}

const mount = document.getElementById('wallet-root');
if (mount) createRoot(mount).render(<App />);
console.log('[wallet-widget] v1 (Privy) loaded');
