import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the React "wallet widget" (login + embedded Solana wallet UI) into a single
// self-mounting IIFE bundle that the existing vanilla HTML pages load via:
//   <script src="/wallet/widget.js"></script>
// The game itself stays vanilla — React only owns the wallet/auth UI.
// Output: public/wallet/widget.js   (see docs/self-custody-migration.md, Phase 0)
export default defineConfig({
  plugins: [react()],
  // The widget has no static assets of its own; disabling publicDir stops Vite from
  // copying the served public/ folder into the build output.
  publicDir: false,
  build: {
    outDir: 'public/wallet',
    emptyOutDir: true,
    lib: {
      entry: 'wallet-widget/src/main.jsx',
      name: 'DuelWallet',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
  },
});
