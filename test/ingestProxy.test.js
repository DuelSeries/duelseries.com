'use strict';
/* The PostHog relay (night review 2026-10-29, finding 25): server/ingestProxy.js.
   The owner's year-long session cookie used to ride along to PostHog on every analytics call from the same browser,
   and any upstream path and Set-Cookie came back under our origin. The REAL module runs behind a real express app
   on a real socket, with a fake upstream in place of https.request (no network), recording what would have gone
   out to PostHog. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { PassThrough, Writable } = require('stream');
const express = require('express');

const { ingestProxy, upstreamFor, forwardHeaders, returnHeaders, POSTHOG_TOKEN, MAX_BODY, CAPTURE_HOST, ASSET_HOST }
  = require('../server/ingestProxy');
const { byteBudget } = require('../server/staticCache');
const { securityHeaders } = require('../server/securityHeaders');
const { TRUST_PROXY } = require('../server/clientAddr');

const ROOT = path.join(__dirname, '..');

/* A stand-in for https.request: records the options and the body, answers with the given status, headers, body. */
function fakeUpstream(answer = {}) {
  const calls = [];
  const request = (opts, onResponse) => {
    const call = { opts, body: [], ended: false, destroyed: false };
    calls.push(call);
    const req = new Writable({
      write(chunk, _enc, cb) { call.body.push(chunk); cb(); },
      final(cb) {
        call.ended = true;
        const res = new PassThrough();
        res.statusCode = answer.status || 200;
        res.headers = answer.headers || { 'content-type': 'application/json' };
        setImmediate(() => { onResponse(res); res.end(answer.body || '{"status":1}'); });
        cb();
      },
    });
    req.destroy = ((d) => function () { call.destroyed = true; return d.apply(this, arguments); })(req.destroy);
    return req;
  };
  return { request, calls };
}

function call(port, method, target, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: target, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function proxyApp(t, upstream, opts = {}) {
  const app = express();
  app.set('trust proxy', TRUST_PROXY);
  app.use(securityHeaders);
  app.all('/ingest/*', ingestProxy({ request: upstream.request, ...opts }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  return server.address().port;
}

const OWNER_COOKIE = '__Host-ds_owner=sealed.owner.session; other=1';

test('no credential leaves for PostHog: cookie, authorization, Privy tokens, X-DS-* and our key headers', async (t) => {
  const up = fakeUpstream();
  const port = await proxyApp(t, up);
  const r = await call(port, 'POST', '/ingest/e/?ip=1&_=123&ver=1.2', {
    'Content-Type': 'application/json',
    Cookie: OWNER_COOKIE,
    Authorization: 'Bearer privy.jwt',
    'Privy-Id-Token': 'id.jwt',
    'Privy-Access-Token': 'access.jwt',
    'X-DS-Owner': '1',
    'X-DS-Anything': 'x',
    'X-Api-Key': 'k',
    'X-Stats-Secret': 's',
    'Proxy-Authorization': 'Basic x',
    'User-Agent': 'Mozilla/5.0 test',
    'X-Forwarded-For': '203.0.113.7',
  }, '{"event":"$pageview","api_key":"' + POSTHOG_TOKEN + '"}');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(up.calls.length, 1);
  const { opts, body } = up.calls[0];
  assert.strictEqual(opts.hostname, CAPTURE_HOST);
  assert.strictEqual(opts.path, '/e/?ip=1&_=123&ver=1.2', 'the path and query string exactly as posthog-js sent them');
  assert.strictEqual(opts.method, 'POST');
  const sent = Object.keys(opts.headers).map((k) => k.toLowerCase());
  for (const h of ['cookie', 'authorization', 'privy-id-token', 'privy-access-token', 'x-ds-owner', 'x-ds-anything',
    'x-api-key', 'x-stats-secret', 'proxy-authorization']) {
    assert.ok(!sent.includes(h), h + ' never reaches PostHog');
  }
  assert.ok(!JSON.stringify(opts.headers).includes('sealed.owner.session'), 'the owner session nowhere in the request');
  // What PostHog does need still goes: its host, the body type, the browser and the player's address (geography).
  assert.strictEqual(opts.headers.host, CAPTURE_HOST);
  assert.strictEqual(opts.headers['content-type'], 'application/json');
  assert.strictEqual(opts.headers['user-agent'], 'Mozilla/5.0 test');
  assert.strictEqual(opts.headers['x-forwarded-for'], '203.0.113.7');
  assert.strictEqual(Buffer.concat(body).toString(), '{"event":"$pageview","api_key":"' + POSTHOG_TOKEN + '"}', 'the body untouched');
});

test('nothing comes back that could set a cookie or override our security headers', async (t) => {
  const up = fakeUpstream({ headers: {
    'content-type': 'application/javascript', 'set-cookie': ['ph=1; Path=/', 'x=2'], 'x-frame-options': 'ALLOWALL',
    'content-security-policy': "default-src *", 'x-content-type-options': 'sniff', 'cache-control': 'public, max-age=3600',
    connection: 'keep-alive' }, body: 'console.log(1)' });
  const port = await proxyApp(t, up);
  const r = await call(port, 'GET', '/ingest/static/array.js', { Cookie: OWNER_COOKIE });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(up.calls[0].opts.hostname, ASSET_HOST, 'static/ still goes to the asset host');
  assert.strictEqual(r.headers['set-cookie'], undefined);
  assert.strictEqual(r.headers['x-frame-options'], 'SAMEORIGIN', 'ours, not theirs');
  assert.strictEqual(r.headers['content-security-policy'], "frame-ancestors 'self'");
  assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(r.headers['content-type'], 'application/javascript');
  assert.strictEqual(r.headers['cache-control'], 'public, max-age=3600', 'the rest of their answer is passed on');
  assert.strictEqual(r.body, 'console.log(1)');
});

test('only the paths posthog-js calls are relayed; anything else is a 404 that never leaves the box', async (t) => {
  for (const p of ['/ingest/static/array.js', '/ingest/static/recorder.js', '/ingest/e/', '/ingest/e', '/ingest/i/v0/e/',
    '/ingest/s/', '/ingest/batch/', '/ingest/flags/', '/ingest/decide/', '/ingest/engage/', '/ingest/capture/',
    '/ingest/api/surveys/', '/ingest/api/early_access_features/', '/ingest/array/' + POSTHOG_TOKEN + '/config',
    '/ingest/array/' + POSTHOG_TOKEN + '/config.js']) {
    assert.ok(upstreamFor(p), p + ' is relayed');
  }
  assert.strictEqual(upstreamFor('/ingest/static/x.js').host, ASSET_HOST);
  assert.strictEqual(upstreamFor('/ingest/array/' + POSTHOG_TOKEN + '/config').host, CAPTURE_HOST, 'routing unchanged');
  assert.strictEqual(upstreamFor('/ingest/flags/').host, CAPTURE_HOST);
  for (const p of ['/ingest/', '/ingest', '/ingest/login', '/ingest/admin/', '/ingest/array/phc_someoneElse/config.js',
    '/ingest/static/../login', '/ingest/static/%2e%2e/login', '/ingest/e/..%2flogin', '/ingest//evil.example/x',
    '/ingest/static\\..\\login', '/ingest/eee', '/ingest/apix/']) {
    assert.strictEqual(upstreamFor(p), null, p + ' is refused');
  }

  const up = fakeUpstream();
  const port = await proxyApp(t, up);
  assert.strictEqual((await call(port, 'GET', '/ingest/login')).status, 404);
  assert.strictEqual((await call(port, 'GET', '/ingest/array/phc_someoneElse/config.js')).status, 404);
  assert.strictEqual((await call(port, 'PUT', '/ingest/e/')).status, 405);
  assert.strictEqual((await call(port, 'DELETE', '/ingest/e/')).status, 405);
  assert.strictEqual(up.calls.length, 0, 'none of them reached PostHog');
});

test('a body over the cap is refused, declared or chunked', async (t) => {
  assert.strictEqual(MAX_BODY, 10 * 1024 * 1024);
  const up = fakeUpstream();
  const port = await proxyApp(t, up, { maxBody: 1000 });
  const declared = await call(port, 'POST', '/ingest/s/', { 'Content-Length': '5000', 'Content-Type': 'text/plain' }, 'x'.repeat(5000));
  assert.strictEqual(declared.status, 413);
  assert.strictEqual(up.calls.length, 0, 'never sent');
  const chunked = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/ingest/s/', method: 'POST',
      headers: { 'Transfer-Encoding': 'chunked', 'Content-Type': 'text/plain' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
    for (let i = 0; i < 6; i++) r.write('y'.repeat(400));
    r.end();
  });
  assert.strictEqual(chunked, 413);
  assert.strictEqual(up.calls.length, 1);
  assert.strictEqual(up.calls[0].destroyed, true, 'the upstream request was cut off');
  // An honest small batch still goes through.
  assert.strictEqual((await call(port, 'POST', '/ingest/e/', { 'Content-Type': 'application/json' }, '{"a":1}')).status, 200);
});

test('the relay counts against the caller\'s byte budget both ways, and stops at it', async (t) => {
  const budget = byteBudget({ maxBytes: 300, windowMs: 600000, log: () => {} });
  t.after(() => budget.stop());
  const up = fakeUpstream({ body: 'z'.repeat(200) });
  const port = await proxyApp(t, up, { budget });
  const A = { 'X-Forwarded-For': '203.0.113.50', 'Content-Type': 'text/plain' };
  assert.strictEqual((await call(port, 'POST', '/ingest/e/', A, 'q'.repeat(50))).status, 200);   // 250 counted
  assert.strictEqual((await call(port, 'POST', '/ingest/e/', A, 'q'.repeat(50))).status, 200);   // 500: over
  const r = await call(port, 'GET', '/ingest/static/array.js', A);
  assert.strictEqual(r.status, 429);
  assert.strictEqual(up.calls.length, 2, 'refused before it reached PostHog');
  assert.strictEqual((await call(port, 'GET', '/ingest/static/array.js', { 'X-Forwarded-For': '198.51.100.3' })).status, 200,
    'another player is untouched');
});

test('the helpers on their own', () => {
  const h = forwardHeaders({ Cookie: 'a', 'content-type': 'x', 'PRIVY-ID-TOKEN': 't', host: 'duelseries.com' }, CAPTURE_HOST);
  assert.deepStrictEqual(h, { 'content-type': 'x', host: CAPTURE_HOST });
  assert.deepStrictEqual(returnHeaders({ 'Set-Cookie': ['a'], 'content-type': 'y', 'transfer-encoding': 'chunked' }),
    { 'content-type': 'y' });
});

test('server/index.js mounts the module, and the token is the one posthog-init.js uses', () => {
  const s = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.match(s, /app\.all\('\/ingest\/\*', ingestProxy\(\{ request: https\.request, budget: staticBudget \}\)\);/);
  assert.ok(!/\{ \.\.\.req\.headers, host \}/.test(s), 'no request headers copied wholesale anywhere');
  assert.ok(s.indexOf("app.all('/ingest/*'") < s.indexOf('app.use(express.json());'), 'still before the JSON parser');
  const init = fs.readFileSync(path.join(ROOT, 'public/js/posthog-init.js'), 'utf8');
  assert.ok(init.includes("posthog.init('" + POSTHOG_TOKEN + "'"), 'the same project token');
  assert.match(init, /api_host: window\.location\.origin \+ '\/ingest'/, 'still proxied through /ingest');
});
