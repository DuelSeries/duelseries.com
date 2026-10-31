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

const { ingestProxy, upstreamFor, forwardHeaders, returnHeaders, POSTHOG_TOKEN, MAX_BODY, UPSTREAM_IDLE_MS, MAX_OPEN,
  STATIC_FILES, CAPTURE_HOST, ASSET_HOST } = require('../server/ingestProxy');
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
      autoDestroy: false,            // as a real ClientRequest: ending the body does not destroy it, so 'destroyed' means cut off
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
    '/ingest/api/surveys/', '/ingest/api/early_access_features/', '/ingest/api/surveys', '/ingest/api/web_experiments',
    '/ingest/api/web_experiments/', '/ingest/array/' + POSTHOG_TOKEN + '/config',
    '/ingest/array/' + POSTHOG_TOKEN + '/config.js', '/ingest/static/posthog-recorder.js', '/ingest/static/lazy-recorder.js',
    '/ingest/static/surveys.js', '/ingest/static/web-vitals.js', '/ingest/static/dead-clicks-autocapture.js',
    '/ingest/static/exception-autocapture.js', '/ingest/static/toolbar.js', '/ingest/static/tracing-headers.js']) {
    assert.ok(upstreamFor(p), p + ' is relayed');
  }
  for (const f of STATIC_FILES) assert.ok(upstreamFor('/ingest/static/' + f + '.js'), f);
  assert.strictEqual(upstreamFor('/ingest/static/array.js').host, ASSET_HOST);
  /* Night review 2026-10-29: static/ is the SDK files posthog-js loads, never a source map or the unused full
     bundle (measured raw on the asset host: array.full.js.map 3.0 MB, array.js.map 1.7 MB, array.full.js 680 KB). */
  for (const p of ['/ingest/static/array.full.js.map', '/ingest/static/array.js.map', '/ingest/static/posthog-recorder.js.map',
    '/ingest/static/array.full.js', '/ingest/static/array.no-external.js', '/ingest/static/x.js', '/ingest/static/',
    '/ingest/static/array.js/', '/ingest/static/sub/array.js', '/ingest/static/array.jsx', '/ingest/static/Array.js',
    '/ingest/static/array', '/ingest/array/' + POSTHOG_TOKEN + '/config.js.map', '/ingest/e/x.map']) {
    assert.strictEqual(upstreamFor(p), null, p + ' is refused');
  }
  /* Backend pass 2026-10-30: posthog-js 1.444 asks for static/<version>/<kind>.js first (five 404s on every page load
     before its fallback), and web vitals is web-vitals-with-attribution. The version segment is digits and dots. */
  for (const p of ['/ingest/static/1.444.0/surveys.js', '/ingest/static/1.444.0/posthog-recorder.js',
    '/ingest/static/1.444.0/web-vitals-with-attribution.js', '/ingest/static/web-vitals-with-attribution.js',
    '/ingest/static/1.444.0/exception-autocapture.js', '/ingest/static/1.444.0/dead-clicks-autocapture.js']) {
    assert.ok(upstreamFor(p), p + ' is relayed');
    assert.strictEqual(upstreamFor(p).host, ASSET_HOST, p + ' goes to the asset host');
    assert.strictEqual(upstreamFor(p).path, p.replace(/^\/ingest/, ''), p + ' keeps its path');
  }
  for (const p of ['/ingest/static/1.444.0/array.js.map', '/ingest/static/1.444.0/array.full.js', '/ingest/static/1.444/array.js',
    '/ingest/static/1.444.0.1/array.js', '/ingest/static/v1.444.0/array.js', '/ingest/static/1.444.0/1.444.0/array.js',
    '/ingest/static/1.444.0/', '/ingest/static/1.444.0/x.js', '/ingest/static/1.444.0/../array.js', '/ingest/static/1.444.0//array.js']) {
    assert.strictEqual(upstreamFor(p), null, p + ' is refused');
  }
  assert.strictEqual(upstreamFor('/ingest/array/' + POSTHOG_TOKEN + '/config').host, CAPTURE_HOST, 'routing unchanged');
  assert.strictEqual(upstreamFor('/ingest/flags/').host, CAPTURE_HOST);
  for (const p of ['/ingest/', '/ingest', '/ingest/login', '/ingest/admin/', '/ingest/array/phc_someoneElse/config.js',
    '/ingest/static/../login', '/ingest/static/%2e%2e/login', '/ingest/e/..%2flogin', '/ingest//evil.example/x',
    '/ingest/static\\..\\login', '/ingest/eee', '/ingest/apix/',
    // Night review 2026-10-29: only the three reads posthog-js makes under api/, not the rest of PostHog's app API.
    '/ingest/api/', '/ingest/api', '/ingest/api/projects/1/insights/', '/ingest/api/users/@me/', '/ingest/api/surveysx',
    '/ingest/api/organizations/', '/ingest/api/environments/1/session_recordings/']) {
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

/* Night review 2026-10-29: a PostHog that never answers. Like a real ClientRequest: setTimeout() arms an idle timer,
   and destroy() before an answer is an 'error' (socket hang up). */
function hangingUpstream() {
  const calls = [];
  const request = (opts) => {
    const call = { opts, destroyed: false, idleMs: null };
    calls.push(call);
    const req = new Writable({ autoDestroy: false, write(_c, _e, cb) { cb(); } });
    let timer = null;
    req.setTimeout = (ms, fn) => { call.idleMs = ms; timer = setTimeout(fn, ms); return req; };
    req.destroy = ((d) => function () {
      call.destroyed = true;
      clearTimeout(timer);
      const out = d.apply(this, arguments);
      process.nextTick(() => this.emit('error', new Error('socket hang up')));
      return out;
    })(req.destroy);
    return req;
  };
  return { request, calls };
}

async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('a PostHog call that hangs is given up after its idle time, and a caller who leaves takes it along', async (t) => {
  assert.strictEqual(UPSTREAM_IDLE_MS, 30 * 1000);
  const up = hangingUpstream();
  const port = await proxyApp(t, up, { idleMs: 150 });
  const t0 = Date.now();
  const r = await call(port, 'GET', '/ingest/flags/?v=2');
  assert.strictEqual(r.status, 502, 'posthog-js gets an answer it retries, not an open socket');
  assert.ok(Date.now() - t0 >= 140, 'after the idle time, not before');
  assert.strictEqual(up.calls[0].idleMs, 150);
  assert.strictEqual(up.calls[0].destroyed, true);

  const up2 = hangingUpstream();
  const port2 = await proxyApp(t, up2);                 // the real 30 s: the caller leaves long before
  const leaver = http.request({ host: '127.0.0.1', port: port2, path: '/ingest/e/', method: 'POST', agent: false,
    headers: { 'Content-Type': 'application/json' } });
  leaver.on('error', () => {});
  leaver.end('{"a":1}');
  await until(() => up2.calls.length === 1);
  assert.strictEqual(up2.calls[0].idleMs, UPSTREAM_IDLE_MS);
  assert.strictEqual(up2.calls[0].destroyed, false);
  leaver.destroy();
  await until(() => up2.calls[0].destroyed);

  // An answered call is left alone.
  const ok = fakeUpstream();
  const port3 = await proxyApp(t, ok);
  assert.strictEqual((await call(port3, 'POST', '/ingest/e/', { 'Content-Type': 'application/json' }, '{"a":1}')).status, 200);
  await new Promise((res) => setTimeout(res, 30));
  assert.strictEqual(ok.calls[0].destroyed, false);
});

/* Night review 2026-10-29, second re-review: the budget was checked only when a call arrived, so parallel calls all
   passed together (30 of 30 source maps answered against a 6 MB budget, 90 MB out). */

/* A PostHog that answers after a while with a body of the given size, so parallel calls overlap as on the real host. */
function slowUpstream(ms, size) {
  const calls = [];
  const request = (opts, onResponse) => {
    calls.push({ opts });
    return new Writable({
      autoDestroy: false,
      write(_c, _e, cb) { cb(); },
      final(cb) {
        setTimeout(() => {
          const res = new PassThrough();
          res.statusCode = 200;
          res.headers = { 'content-type': 'application/javascript' };
          onResponse(res);
          res.end(Buffer.alloc(size, 97));
        }, ms);
        cb();
      },
    });
  };
  return { request, calls };
}

async function cappedApp(t, upstream, opts = {}) {
  const handler = ingestProxy({ request: upstream.request, ...opts });
  const app = express();
  app.set('trust proxy', TRUST_PROXY);
  app.all('/ingest/*', handler);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  return { port: server.address().port, handler };
}

test('one address has at most 8 calls relayed at once: past that a 503 at once, never a queue, so a burst cannot pass the budget', async (t) => {
  assert.strictEqual(MAX_OPEN, 8);
  const size = 200 * 1024;
  const budget = byteBudget({ maxBytes: size * 2, windowMs: 600000, log: () => {} });
  t.after(() => budget.stop());
  const up = slowUpstream(150, size);
  const { port, handler } = await cappedApp(t, up, { budget });
  const A = { 'X-Forwarded-For': '203.0.113.60' };

  // The source maps the reviewer pulled are not relayed at all.
  const maps = await Promise.all(Array.from({ length: 30 }, () => call(port, 'GET', '/ingest/static/array.full.js.map', A)));
  assert.deepStrictEqual([...new Set(maps.map((r) => r.status))], [404]);
  assert.strictEqual(up.calls.length, 0, 'none of them reached PostHog');

  const all = await Promise.all(Array.from({ length: 30 }, () => call(port, 'GET', '/ingest/static/array.js', A)));
  const ok = all.filter((r) => r.status === 200);
  const busy = all.filter((r) => r.status === 503);
  assert.strictEqual(ok.length + busy.length, 30, 'every answer is a relayed file or a 503');
  assert.ok(ok.length >= 1 && ok.length <= MAX_OPEN, ok.length + ' relayed at once');
  assert.strictEqual(up.calls.length, ok.length, 'a refused call never reached PostHog, and none was queued for later');
  for (const r of ok) assert.strictEqual(r.body.length, size);
  for (const r of busy) {
    assert.strictEqual(r.headers['retry-after'], '2', 'posthog-js retries a 5xx');
    assert.strictEqual(r.headers['cache-control'], 'no-store');
  }
  await until(() => handler.inFlight() === 0);
  // At most MAX_OPEN files past the 2-file budget, then the address is refused for its window.
  assert.strictEqual((await call(port, 'GET', '/ingest/static/array.js', A)).status, 429);
  assert.strictEqual((await call(port, 'GET', '/ingest/static/array.js', { 'X-Forwarded-For': '198.51.100.60' })).status, 200,
    'another player is untouched');
  // nginx itself and local calls have no address key: no cap, as in the byte budget.
  const local = await Promise.all(Array.from({ length: 12 }, () => call(port, 'GET', '/ingest/static/array.js')));
  assert.deepStrictEqual([...new Set(local.map((r) => r.status))], [200]);
});

test('a caller who leaves gives its place back; an honest page load\'s calls all go through', async (t) => {
  const up = hangingUpstream();
  const { port, handler } = await cappedApp(t, up);
  const A = { 'X-Forwarded-For': '203.0.113.61', 'Content-Type': 'application/json' };
  const leavers = [];
  for (let i = 0; i < MAX_OPEN; i++) {
    const r = http.request({ host: '127.0.0.1', port, path: '/ingest/e/', method: 'POST', agent: false, headers: A });
    r.on('error', () => {});
    r.end('{"a":1}');
    leavers.push(r);
  }
  await until(() => up.calls.length === MAX_OPEN);
  const refused = await call(port, 'POST', '/ingest/e/', A, '{"a":1}');
  assert.strictEqual(refused.status, 503, 'the ninth waits for nobody: refused at once while PostHog hangs');
  assert.strictEqual(up.calls.length, MAX_OPEN);
  for (const r of leavers) r.destroy();
  await until(() => handler.inFlight() === 0);
  assert.ok(up.calls.every((c) => c.destroyed), 'each call to PostHog went with its caller');

  // A page load's calls, a few at a time as posthog-js makes them, all answer.
  const ok = fakeUpstream({ body: 'x'.repeat(1000) });
  const app2 = await cappedApp(t, ok);
  const B = { 'X-Forwarded-For': '203.0.113.62' };
  const load = ['/ingest/static/array.js', '/ingest/array/' + POSTHOG_TOKEN + '/config.js', '/ingest/flags/?v=2',
    '/ingest/static/posthog-recorder.js', '/ingest/static/surveys.js', '/ingest/api/surveys/', '/ingest/e/', '/ingest/s/'];
  const answers = await Promise.all(load.map((p) => call(app2.port, p.startsWith('/ingest/e') || p.startsWith('/ingest/s')
    ? 'POST' : 'GET', p, { ...B, 'Content-Type': 'application/json' }, p.startsWith('/ingest/e') || p.startsWith('/ingest/s')
    ? '{"a":1}' : undefined)));
  assert.deepStrictEqual([...new Set(answers.map((r) => r.status))], [200]);
  await until(() => app2.handler.inFlight() === 0);
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
  // express.json takes { inflate: false } since the body-parser fix (night review 2026-10-29).
  assert.ok(s.indexOf('app.use(express.json(') > 0 && s.indexOf("app.all('/ingest/*'") < s.indexOf('app.use(express.json('), 'still before the JSON parser');
  const init = fs.readFileSync(path.join(ROOT, 'public/js/posthog-init.js'), 'utf8');
  assert.ok(init.includes("posthog.init('" + POSTHOG_TOKEN + "'"), 'the same project token');
  assert.match(init, /api_host: window\.location\.origin \+ '\/ingest'/, 'still proxied through /ingest');
});
