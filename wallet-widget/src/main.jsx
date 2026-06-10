import React from 'react';
import { createRoot } from 'react-dom/client';

// Phase 0 · step 1 — scaffold only.
// Proves the React island builds and can mount into the existing vanilla pages.
// Privy login + embedded Solana wallet provisioning + balance arrive in step 2.
function WalletWidget() {
  return <span style={{ display: 'none' }} data-duel-wallet="scaffold" />;
}

const mount = document.getElementById('wallet-root');
if (mount) createRoot(mount).render(<WalletWidget />);
console.log('[wallet-widget] scaffold v0 loaded');
