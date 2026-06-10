import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// Builds the React "wallet widget" (login + embedded Solana wallet UI) into a single
// self-mounting IIFE bundle that the existing vanilla HTML pages load via:
//   <script src="/wallet/widget.js"></script>
// The game itself stays vanilla — React only owns the wallet/auth UI.
// Output: public/wallet/widget.js   (see docs/self-custody-migration.md, Phase 0)
export default defineConfig({
  // nodePolyfills provides Buffer/global/process that web3.js + the Solana stack expect
  // in a browser bundle.
  plugins: [react(), nodePolyfills()],
  // The widget has no static assets of its own; disabling publicDir stops Vite from
  // copying the served public/ folder into the build output.
  publicDir: false,
  // Browser bundle: replace Node globals the bundled SDKs reference (React's
  // process.env.NODE_ENV, and bare `global`). lib mode doesn't do this automatically.
  // A runtime shim in index.html backs this up for any stray references.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
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
