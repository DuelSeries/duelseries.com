'use strict';
/* The Privy app per host (wallet-widget/src/privyApp.mjs, 2026-11-02): local runs and tests used the live app and
   left 19 fake Phantom users in it. duelseries.com keeps the live app; everything else gets the dev app. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const load = () => import('../wallet-widget/src/privyApp.mjs');

test('duelseries.com and its subdomains sign in to the live app, every other host to the dev app', async () => {
  const { privyAppIdFor, PROD_PRIVY_APP_ID, DEV_PRIVY_APP_ID } = await load();
  assert.strictEqual(PROD_PRIVY_APP_ID, 'cmpnepg0100f20cl10wdig1fr', 'the live app id is unchanged');
  assert.match(DEV_PRIVY_APP_ID, /^c[a-z0-9]{24}$/, 'a real Privy app id, not a placeholder');
  assert.notStrictEqual(DEV_PRIVY_APP_ID, PROD_PRIVY_APP_ID);
  for (const h of ['duelseries.com', 'www.duelseries.com', 'eu.duelseries.com', 'DUELSERIES.COM', 'duelseries.com.']) {
    assert.strictEqual(privyAppIdFor(h), PROD_PRIVY_APP_ID, h);
  }
  for (const h of ['localhost', '127.0.0.1', '[::1]', 'duelseries.com.evil.io', 'notduelseries.com', 'duelseries.co', '', undefined]) {
    assert.strictEqual(privyAppIdFor(h), DEV_PRIVY_APP_ID, String(h));
  }
});

test('main.jsx takes its app id from the host, and the built widget carries both ids', () => {
  const src = fs.readFileSync(path.join(__dirname, '../wallet-widget/src/main.jsx'), 'utf8');
  assert.match(src, /const APP_ID = privyAppIdFor\(typeof window !== 'undefined' \? window\.location\.hostname : ''\);/);
  assert.ok(!/const APP_ID = '/.test(src), 'no fixed app id left');
  const built = fs.readFileSync(path.join(__dirname, '../public/wallet/widget.js'), 'utf8');
  assert.ok(built.includes('cmpnepg0100f20cl10wdig1fr'), 'the live id is in the bundle');
  assert.ok(!built.includes('__DEV_APP_ID__'), 'the bundle was rebuilt with the real dev id');
});
