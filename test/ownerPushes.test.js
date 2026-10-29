'use strict';
// Night review 2026-10-29 (findings 24 and 32): the visit push is capped and carries only checked text, and the ntfy
// topic and an access token come from the environment (today's topic stays the default), with no pay-to address or
// player wallet in any owner push.
const test = require('node:test');
const assert = require('node:assert');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createVisitAlerts, cleanPage, cleanRef, cleanCountry, CAP, WINDOW_MS } = require('../server/visitAlerts');

const ROOT = path.join(__dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function rig() {
  const sent = [];
  let t = 1000;
  const v = createVisitAlerts({ push: (text, o) => sent.push({ text, o }), now: () => t });
  return { v, sent, at: (ms) => { t = ms; }, step: (ms) => { t += ms; } };
}

test('visit push: the old text for a real page load; bots skipped as before', () => {
  const r = rig();
  assert.strictEqual(r.v.visit({ ua: UA, page: '/play/slither', ref: 'https://www.google.com/search?q=x', country: 'CA' }), true);
  assert.deepStrictEqual(r.sent[0], { text: 'Someone opened your site (/play/slither) from CA via www.google.com',
    o: { title: 'Site visit', tags: 'eyes' } });
  assert.strictEqual(r.v.visit({ ua: 'Googlebot/2.1', page: '/' }), false);
  assert.strictEqual(r.v.visit({ ua: 'curl/8.0', page: '/' }), false);
  assert.strictEqual(r.sent.length, 1);
});

test('visit push: at most CAP per window for the whole process, the held ones counted on the next', () => {
  const r = rig();
  for (let i = 0; i < CAP; i++) assert.strictEqual(r.v.visit({ ua: UA, page: '/' }), true, 'push ' + i);
  for (let i = 0; i < 50; i++) assert.strictEqual(r.v.visit({ ua: UA, page: '/' }), false);
  assert.strictEqual(r.sent.length, CAP);
  r.step(WINDOW_MS);
  assert.strictEqual(r.v.visit({ ua: UA, page: '/' }), true);
  assert.strictEqual(r.sent[CAP].text, 'Someone opened your site (/) (+50 more)');
  assert.strictEqual(r.v.visit({ ua: UA, page: '/' }), true);
  assert.strictEqual(r.sent[CAP + 1].text, 'Someone opened your site (/)', 'the count starts over');
});

test('visit push: only checked text reaches the phone', () => {
  assert.strictEqual(cleanPage('/owner URGENT escrow'), '/');
  assert.strictEqual(cleanPage('/' + 'a'.repeat(60)), '/');
  assert.strictEqual(cleanPage({ toString: 1 }), '/');
  assert.strictEqual(cleanPage('/sl'), '/sl');
  assert.strictEqual(cleanRef('https://duelseries-support.example/fix?x=1'), 'duelseries-support.example');
  assert.strictEqual(cleanRef('javascript:alert(1)'), '');
  assert.strictEqual(cleanRef('not a url'), '');
  assert.strictEqual(cleanRef(''), '');
  assert.strictEqual(cleanCountry('CA'), 'CA');
  assert.strictEqual(cleanCountry('XX'), '');
  assert.strictEqual(cleanCountry('CA. Send 1 SOL to Bot bank'), '');
  assert.strictEqual(cleanCountry(undefined), '');
  const r = rig();
  r.v.visit({ ua: UA, page: '/x\nURGENT', ref: 'https://evil.example/' + 'y'.repeat(500), country: 'A'.repeat(5000) });
  assert.strictEqual(r.sent[0].text, 'Someone opened your site (/) via evil.example');
  assert.doesNotThrow(() => r.v.visit(null));
  assert.doesNotThrow(() => createVisitAlerts({ push: () => { throw new Error('boom'); } }).visit({ ua: UA }));
});

test('the visit route has a per-address limiter and goes through visitAlerts', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.match(src, /const visitLimiter = rateLimit\(\{ windowMs: 60 \* 1000, max: 5,/);
  assert.match(src, /app\.post\('\/api\/track\/visit', visitLimiter, express\.json\(/);
  assert.match(src, /visitAlerts\.visit\(\{/);
  assert.match(src, /app\.get\('\/api\/my-profile', myProfileLimiter, /, 'finding 28: the profile read is limited (its own count, so search typing never blocks it)');
});

// ---- notify.js ------------------------------------------------------------------------------------------------------

function capture(t, env, fn) {
  const calls = [];
  t.mock.method(https, 'request', (opts) => {
    const c = { opts, handlers: {} };
    calls.push(c);
    return { on(ev, h) { c.handlers[ev] = h; }, write() {}, end() {}, destroy() {} };
  });
  const keys = ['NTFY_DISABLED', 'NTFY_TOPIC_URL', 'NTFY_TOPIC', 'NTFY_TOKEN'];
  const was = {};
  for (const k of keys) { was[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  try {
    fn(require('../server/notify'));
  } finally {
    for (const k of keys) { if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]; }
  }
  return calls;
}

test('notify: today\'s topic by default; NTFY_TOPIC or NTFY_TOPIC_URL move it, read on every push', (t) => {
  const calls = capture(t, {}, (n) => n.pushOwner('a'));
  assert.deepStrictEqual([calls[0].opts.hostname, calls[0].opts.path], ['ntfy.sh', '/duelseries-players-8382']);
  assert.strictEqual(calls[0].opts.headers.Authorization, undefined, 'no token, no header');
  const moved = capture(t, { NTFY_TOPIC: 'ds-0123456789abcdef' }, (n) => n.pushOwner('a'));
  assert.strictEqual(moved[0].opts.path, '/ds-0123456789abcdef');
  const bad = capture(t, { NTFY_TOPIC: '../evil?x=1' }, (n) => n.pushOwner('a'));
  assert.strictEqual(bad[0].opts.path, '/duelseries-players-8382', 'a topic ntfy would refuse falls back');
  const url = capture(t, { NTFY_TOPIC_URL: 'https://push.example.com/mine?auth=abc', NTFY_TOPIC: 'ignored' }, (n) => n.pushOwner('a'));
  assert.deepStrictEqual([url[0].opts.hostname, url[0].opts.path], ['push.example.com', '/mine?auth=abc'], 'the query is kept');
});

test('notify: NTFY_TOKEN is sent as a Bearer token to the topic\'s own host only, and a bad one is never sent', (t) => {
  const calls = capture(t, { NTFY_TOKEN: 'tk_secret123' }, (n) => {
    n.pushOwner('a', { title: 'T' });
    n.pushOwner('b', { url: 'https://ntfy.sh/duelseries-free-8382' });
    n.pushOwner('c', { url: 'https://elsewhere.example/topic' });
  });
  assert.deepStrictEqual(calls.map((c) => c.opts.headers.Authorization || null),
    ['Bearer tk_secret123', 'Bearer tk_secret123', null]);
  const bad = capture(t, { NTFY_TOKEN: 'two words\n' }, (n) => n.pushOwner('a'));
  assert.strictEqual(bad.length, 1, 'the push still goes');
  assert.strictEqual(bad[0].opts.headers.Authorization, undefined);
  const off = capture(t, { NTFY_DISABLED: '1', NTFY_TOKEN: 'tk' }, (n) => n.pushOwner('a'));
  assert.strictEqual(off.length, 0);
});

test('notify: a refused push is read and logged, never thrown', (t) => {
  const warned = [];
  t.mock.method(console, 'warn', (m) => warned.push(m));
  const calls = capture(t, {}, (n) => n.pushOwner('a'));
  const res = { statusCode: 429, resume() { this.resumed = true; } };
  assert.doesNotThrow(() => calls[0].handlers.response(res));
  assert.ok(res.resumed);
  assert.match(warned.join('\n'), /429/);
  assert.doesNotThrow(() => calls[0].handlers.response(null));
});

test('no owner push carries a player wallet or a pay-to address (the topic is readable and writable by anyone)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const calls = src.split('notify.pushOwner(').slice(1).map((s) => s.slice(0, 400));
  for (const c of calls) {
    const text = c.split(/\{\s*title:/)[0];   // the message, up to its options
    assert.doesNotMatch(text, /\$\{p\.wallet\}|\bbbv\.address\b|\.wallet_address\b/, text.slice(0, 160));
  }
  assert.ok(calls.length >= 10, 'every push site was read');
});
