'use strict';
/* Coinbase Onramp held back from Privy's Add funds sheet while Coinbase caps this app at about
   US$5 a buy (wallet-widget/src/holdCoinbase.mjs, 2026-10-16): only Privy's GET of this app's
   config loses its coinbase entries; everything else, and every surprise, passes through as it
   came; the server's coinbaseOnramp brings the row back. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = 'cmpnepg0100f20cl10wdig1fr';
const CONFIG = { name: 'duelseries', funding_config: {
  default_recommended_amount: '0.1', methods: ['moonpay'],
  options: [{ method: 'card', provider: 'moonpay' }, { method: 'exchange', provider: 'coinbase' }, { method: 'card', provider: 'moonpay' }] } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Content-Length': '999' } });

test('the sheet loses only Coinbase, only on Privy\'s config for this app, and gets it back when switched on', async () => {
  const { holdBackCoinbase, withoutCoinbase } = await import('../wallet-widget/src/holdCoinbase.mjs');
  const calls = [];
  const real = async (input, init) => { calls.push([String(input && input.url || input), init && init.method]); return json(CONFIG); };
  let show = false;
  const f = holdBackCoinbase(real, APP, async () => show);

  const r = await (await f('https://auth.privy.io/api/v1/apps/' + APP, { method: 'GET' })).json();
  assert.deepStrictEqual(r.funding_config.options, [{ method: 'card', provider: 'moonpay' }, { method: 'card', provider: 'moonpay' }]);
  assert.strictEqual(r.name, 'duelseries', 'the rest of the config is untouched');
  assert.deepStrictEqual(CONFIG.funding_config.options.length, 3, 'the original answer is not mutated');

  // A query string is still this app's config; a Request object too.
  const q = await (await f(new Request('https://auth.privy.io/api/v1/apps/' + APP + '?x=1'))).json();
  assert.strictEqual(q.funding_config.options.length, 2);

  // Anything else passes through exactly: another app, another path, a POST, another host.
  for (const [u, m] of [['https://auth.privy.io/api/v1/apps/other', 'GET'], ['https://auth.privy.io/api/v1/apps/' + APP + '/cross-app/details', 'GET'],
                        ['https://auth.privy.io/api/v1/apps/' + APP, 'POST'], ['https://example.com/api/v1/apps/' + APP, 'GET']]) {
    const o = await (await f(u, { method: m })).json();
    assert.strictEqual(o.funding_config.options.length, 3, u + ' ' + m);
  }

  // Switched on: the row comes back.
  show = true;
  assert.strictEqual((await (await f('https://auth.privy.io/api/v1/apps/' + APP)).json()).funding_config.options.length, 3);
  show = false;

  // Surprises pass through as they came: an error answer, a shape it does not know, a throw.
  const err = holdBackCoinbase(async () => json({ error: 'x' }, 500), APP, async () => false);
  assert.strictEqual((await err('https://auth.privy.io/api/v1/apps/' + APP)).status, 500);
  const odd = holdBackCoinbase(async () => json({ funding_config: { options: 'nope' } }), APP, async () => false);
  assert.deepStrictEqual(await (await odd('https://auth.privy.io/api/v1/apps/' + APP)).json(), { funding_config: { options: 'nope' } });
  const boom = holdBackCoinbase(async () => json(CONFIG), APP, async () => { throw new Error('config down'); });
  assert.strictEqual((await (await boom('https://auth.privy.io/api/v1/apps/' + APP)).json()).funding_config.options.length, 3);
  assert.strictEqual(withoutCoinbase({ funding_config: { options: [{ method: 'card', provider: 'moonpay' }] } }), null, 'nothing to take out');
  assert.strictEqual(calls.length, 7);
});

test('the widget wraps fetch before Privy is made, and the server switch defaults off', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'wallet-widget', 'src', 'main.jsx'), 'utf8');
  assert.ok(main.indexOf('globalThis.fetch = holdBackCoinbase(') < main.indexOf('createRoot(mount).render('), 'wrapped before render');
  assert.match(main, /moneyConfig\(\)\.then\(\(c\) => !!\(c && c\.coinbaseOnramp\)\)\.catch\(\(\) => false\)/);
  const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(idx, /coinbaseOnramp: process\.env\.COINBASE_ONRAMP === 'on'/);
});
