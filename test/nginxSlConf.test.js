'use strict';
/* The slither path /sl-io/ outside the server (server split spec 10 and 14.1 #9):
   - deploy/nginx-sl-io.conf, the reference copy of the box's nginx pieces, keeps the lines the path depends on: the
     upstream with the main port as its backup, and in `location /sl-io/` the forwarded address (the per-address caps),
     Host (the owner's own join), Upgrade and Connection (WebSocket), and the per-address limits, which sit inside
     `location /` on the box and so must be repeated
   - public/sw.js hands /sl-io/ straight back to the browser, as it does /socket.io/, and its version moved so phones
     holding the old worker take the new one */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CONF = fs.readFileSync(path.join(ROOT, 'deploy', 'nginx-sl-io.conf'), 'utf8').replace(/\r\n/g, '\n');
// The config lines only, comments taken out.
const lines = CONF.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);

test('the upstream: the slither port first, the main port as its backup', () => {
  const at = lines.indexOf('upstream ds_sl {');
  assert.ok(at >= 0, 'upstream ds_sl');
  assert.deepStrictEqual(lines.slice(at + 1, at + 4), [
    'server 127.0.0.1:3001 max_fails=1 fail_timeout=5s;',
    'server 127.0.0.1:3000 backup;',
    '}',
  ]);
});

test('location /sl-io/: proxied to the upstream with every line the path depends on', () => {
  const at = lines.indexOf('location /sl-io/ {');
  assert.ok(at >= 0, 'location /sl-io/');
  const end = lines.indexOf('}', at);
  const loc = lines.slice(at + 1, end);
  for (const l of [
    'proxy_pass http://ds_sl;',
    'proxy_next_upstream error timeout;',
    'proxy_next_upstream_tries 2;',
    'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    'proxy_set_header Host $host;',
    'proxy_set_header Upgrade $http_upgrade;',
    'proxy_set_header Connection $connection_upgrade;',
    'proxy_http_version 1.1;',
    'limit_req zone=ds_req burst=400 nodelay;',
    'limit_conn ds_conn 60;',
  ]) assert.ok(loc.includes(l), l);
  assert.strictEqual(loc.filter((l) => l.startsWith('proxy_pass')).length, 1);
});

test('the service worker hands /sl-io/ back to the browser, and its version moved', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  const listeners = {};
  const ctx = {
    self: { addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } },
    caches: { keys: async () => [], delete: async () => true },
    fetch: () => Promise.resolve('net'),
    URL,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const answered = (url) => {
    let a = false;
    listeners.fetch({ request: { url }, respondWith() { a = true; } });
    return a;
  };
  assert.strictEqual(answered('https://duelseries.com/sl-io/?EIO=4&transport=polling&t=x'), false);
  assert.strictEqual(answered('https://duelseries.com/socket.io/?EIO=4&transport=polling'), false);
  assert.strictEqual(answered('https://duelseries.com/sl'), true, 'the page itself still goes through');
  assert.match(src, /const SW_VERSION = 3;/);
});
