'use strict';
/* server/privyKeys.js: Privy tokens checked with Privy's public key set, no app secret (2026-11-02, every sign-in
   was refused for two days when the secret went bad). Real ES256 keys and real signed tokens, a fake key-set
   fetch, so forgery, the wrong app, expiry, key rotation and the fetch budget are all checked against the code
   that ships. server/authAlarm.js, the owner's alarm when refusals pile up, is at the end. */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const jose = require('jose');
const { createPrivyKeys, parseJwks, REFETCH_COOLDOWN_MS, MAX_AGE_MS } = require('../server/privyKeys');
const { createAuthAlarm } = require('../server/authAlarm');

const APP = 'cmpnepg0100f20cl10wdig1fr';
const quiet = { warn() {}, error() {}, log() {} };

async function keyPair(kid) {
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256');
  const jwk = { ...(await jose.exportJWK(publicKey)), kid, use: 'sig', alg: 'ES256' };
  return { kid, privateKey, publicKey, jwk };
}

function sign(kp, { aud = APP, iss = 'privy.io', sub = 'did:privy:player', exp = '1h', typ = 'JWT', kid, claims = {} } = {}) {
  const header = { alg: 'ES256', kid: kid === undefined ? kp.kid : kid };
  if (typ) header.typ = typ;
  let j = new jose.SignJWT({ sid: 'sess', ...claims }).setProtectedHeader(header).setIssuedAt();
  if (iss) j = j.setIssuer(iss);
  if (aud) j = j.setAudience(aud);
  if (sub) j = j.setSubject(sub);
  if (exp) j = j.setExpirationTime(exp);
  return j.sign(kp.privateKey);
}

function harness(sets) {
  let t = 1_000_000;
  const calls = [];
  let i = 0;
  const keys = createPrivyKeys({
    appId: APP,
    now: () => t,
    log: quiet,
    fetchJson: async (url) => {
      calls.push(url);
      const s = sets[Math.min(i++, sets.length - 1)];
      if (s instanceof Error) throw s;
      return typeof s === 'function' ? s() : s;
    },
  });
  return { keys, calls, tick: (ms) => { t += ms; } };
}

const kindOfRejection = async (p) => { try { await p; return 'accepted'; } catch (e) { return require('../server/privyKeys').kindOf(e); } };

test('a good access token is accepted with no secret, the key set fetched once from the fixed URL', async () => {
  const a = await keyPair('k1');
  const h = harness([{ keys: [a.jwk] }]);
  assert.strictEqual(await h.keys.refresh(), true);
  const c = await h.keys.verifyAccess(await sign(a));
  assert.strictEqual(c.userId, 'did:privy:player');
  assert.strictEqual(c.sessionId, 'sess');
  await h.keys.verifyAccess(await sign(a, { sub: 'did:privy:other' }));
  assert.deepStrictEqual(h.calls, ['https://auth.privy.io/api/v1/apps/' + APP + '/jwks.json']);
});

test('forged, wrong-app, wrong-issuer, expired and alg-swapped tokens are all refused', async () => {
  const a = await keyPair('k1');
  const evil = await keyPair('k1');   // an attacker's key claiming Privy's kid
  const h = harness([{ keys: [a.jwk] }]);
  await h.keys.refresh();
  assert.strictEqual(await kindOfRejection(h.keys.verifyAccess(await sign(evil))), 'bad-signature');
  assert.strictEqual(await kindOfRejection(h.keys.verifyAccess(await sign(a, { aud: 'some-other-app' }))), 'wrong-aud');
  assert.strictEqual(await kindOfRejection(h.keys.verifyAccess(await sign(a, { iss: 'evil.io' }))), 'wrong-iss');
  assert.strictEqual(await kindOfRejection(h.keys.verifyAccess(await sign(a, { exp: Math.floor(Date.now() / 1000) - 60 }))), 'expired');
  assert.strictEqual(await kindOfRejection(h.keys.verifyAccess(await sign(a, { sub: null }))), 'malformed');
  assert.strictEqual(await kindOfRejection(h.keys.verifyAccess(await sign(a, { typ: null }))), 'wrong-typ',
    'an access token must say typ JWT, as @privy-io/server-auth requires');

  // HS256 signed with Privy's PUBLIC key as the HMAC secret: the classic alg confusion.
  const pem = crypto.createPublicKey({ key: a.jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
  const hs = await new jose.SignJWT({}).setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: 'k1' })
    .setIssuer('privy.io').setAudience(APP).setSubject('did:privy:owner').setExpirationTime('1h').sign(Buffer.from(pem));
  assert.strictEqual(await kindOfRejection(h.keys.verifyAccess(hs)), 'wrong-alg');
  // alg none
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const none = b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({ iss: 'privy.io', aud: APP, sub: 'did:privy:owner', exp: 9e9 }) + '.';
  assert.strictEqual(await kindOfRejection(h.keys.verifyAccess(none)), 'wrong-alg');
  for (const junk of ['', 'x', 'a.b.c', null, 42, {}, 'x'.repeat(20000)]) {
    assert.strictEqual(await kindOfRejection(h.keys.verifyAccess(junk)), 'malformed', String(junk).slice(0, 20));
  }
});

test('a token cannot steer the key fetch: jku/x5u are ignored and unknown kids cost one fetch per cooldown', async () => {
  const a = await keyPair('k1');
  const evil = await keyPair('evil');
  const h = harness([{ keys: [a.jwk] }]);
  await h.keys.refresh();
  const jkuToken = await new jose.SignJWT({}).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: 'evil', jku: 'https://evil.example/jwks.json' })
    .setIssuer('privy.io').setAudience(APP).setSubject('did:privy:owner').setExpirationTime('1h').sign(evil.privateKey);
  h.tick(REFETCH_COOLDOWN_MS + 1);
  for (let i = 0; i < 200; i++) {
    assert.notStrictEqual(await kindOfRejection(h.keys.verifyAccess(i ? await sign(evil, { kid: 'evil' + i }) : jkuToken)), 'accepted');
  }
  assert.strictEqual(h.calls.length, 2, 'the boot fetch, then one refetch for 200 unknown kids');
  assert.ok(h.calls.every((u) => u === h.keys.url));
  h.tick(REFETCH_COOLDOWN_MS + 1);
  await kindOfRejection(h.keys.verifyAccess(await sign(evil, { kid: 'evil-again' })));
  assert.strictEqual(h.calls.length, 3, 'one more once the cooldown is over');
});

test('Privy rotating its key: a token from the new kid is accepted after one refetch', async () => {
  const a = await keyPair('old');
  const b = await keyPair('new');
  const h = harness([{ keys: [a.jwk] }, { keys: [b.jwk, a.jwk] }]);
  await h.keys.refresh();
  h.tick(REFETCH_COOLDOWN_MS + 1);
  assert.strictEqual((await h.keys.verifyAccess(await sign(b))).userId, 'did:privy:player');
  assert.strictEqual(h.calls.length, 2);
  assert.strictEqual((await h.keys.verifyAccess(await sign(a))).userId, 'did:privy:player', 'the old key still held');
});

test('no keys at boot (Privy down): the first token fetches, and a failed or bad answer never drops held keys', async () => {
  const a = await keyPair('k1');
  const h = harness([new Error('timeout'), { keys: [a.jwk] }, new Error('503'), { keys: [{ kty: 'RSA', n: 'x', e: 'AQAB', kid: 'r' }] }, { nope: 1 }]);
  assert.strictEqual(await h.keys.refresh(), false);
  assert.strictEqual(h.keys.status().keys, 0);
  assert.strictEqual(await kindOfRejection(h.keys.verifyAccess(await sign(a))), 'no-keys', 'still on cooldown');
  h.tick(REFETCH_COOLDOWN_MS + 1);
  assert.strictEqual((await h.keys.verifyAccess(await sign(a))).userId, 'did:privy:player', 'fetched on demand');
  for (let i = 0; i < 3; i++) {
    h.tick(REFETCH_COOLDOWN_MS + 1);
    assert.strictEqual(await h.keys.refresh(), false);
    assert.deepStrictEqual(h.keys.status().kids, ['k1'], 'held keys survive');
    assert.strictEqual((await h.keys.verifyAccess(await sign(a))).userId, 'did:privy:player');
  }
  assert.ok(h.keys.status().lastError);
});

test('an old key set is refreshed in the background, so a withdrawn key stops working', async () => {
  const a = await keyPair('k1');
  const b = await keyPair('k2');
  const h = harness([{ keys: [a.jwk] }, { keys: [b.jwk] }]);
  await h.keys.refresh();
  h.tick(MAX_AGE_MS + 1);
  const tok = await sign(a);
  assert.strictEqual((await h.keys.verifyAccess(tok)).userId, 'did:privy:player', 'this one uses the held set');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(h.keys.status().kids, ['k2']);
  assert.notStrictEqual(await kindOfRejection(h.keys.verifyAccess(tok)), 'accepted', 'k1 is gone');
});

test('two fetches never run at once', async () => {
  const a = await keyPair('k1');
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness([async () => { await gate; return { keys: [a.jwk] }; }]);
  const tok = await sign(a);
  const all = Promise.all([h.keys.verifyAccess(tok), h.keys.verifyAccess(tok), h.keys.refresh()]);
  release();
  const [x, y] = await all;
  assert.strictEqual(x.userId, 'did:privy:player');
  assert.strictEqual(y.userId, 'did:privy:player');
  assert.strictEqual(h.calls.length, 1);
});

test('the identity token: its linked accounts come back verified, and an access token is not one', async () => {
  const a = await keyPair('k1');
  const evil = await keyPair('k1');
  const h = harness([{ keys: [a.jwk] }]);
  await h.keys.refresh();
  const linked = [{ type: 'wallet', chain_type: 'solana', address: 'OWNERWALLET', wallet_client_type: 'privy', connector_type: 'embedded' }];
  const idt = await h.keys.verifyIdentity(await sign(a, { typ: null, claims: { linked_accounts: JSON.stringify(linked) } }));
  assert.deepStrictEqual(idt, { userId: 'did:privy:player', linkedAccounts: linked });
  assert.strictEqual(await kindOfRejection(h.keys.verifyIdentity(await sign(a))), 'not-identity');
  assert.strictEqual(await kindOfRejection(h.keys.verifyIdentity(await sign(evil, { claims: { linked_accounts: JSON.stringify(linked) } }))), 'bad-signature',
    'a made-up identity token naming the owner wallet');
  assert.strictEqual(await kindOfRejection(h.keys.verifyIdentity(await sign(a, { aud: 'dev-app', claims: { linked_accounts: '[]' } }))), 'wrong-aud',
    'a token from another Privy app (the dev app) is not ours');
  assert.strictEqual(await kindOfRejection(h.keys.verifyIdentity(await sign(a, { exp: Math.floor(Date.now() / 1000) - 5, claims: { linked_accounts: '[]' } }))), 'expired');
  assert.strictEqual(await kindOfRejection(h.keys.verifyIdentity(await sign(a, { claims: { linked_accounts: '{not json' } }))), 'malformed');
});

test('parseJwks keeps only public P-256 signing keys', async () => {
  const a = await keyPair('k1');
  const { privateKey } = await jose.generateKeyPair('ES256');
  const priv = { ...(await jose.exportJWK(privateKey)), kid: 'withd' };
  const m = parseJwks({ keys: [a.jwk, priv, { ...a.jwk, kid: 'enc', use: 'enc' }, { ...a.jwk, kid: 'rs', alg: 'RS256' },
    { ...a.jwk, kid: '' }, { ...a.jwk, kid: 'k1' }, { kty: 'oct', k: 'c2VjcmV0', kid: 'hmac' }, { ...a.jwk, kid: 'off', x: 'AAAA' }] });
  assert.deepStrictEqual([...m.keys()], ['k1', 'withd']);
  assert.strictEqual(m.get('withd').type, 'public', 'a private part in the answer is never imported');
  assert.strictEqual(parseJwks({ keys: [] }), null);
  assert.strictEqual(parseJwks(null), null);
  assert.strictEqual(parseJwks({ keys: 'x' }), null);
});

test('Privy\'s real published key set parses', () => {
  // https://auth.privy.io/api/v1/apps/cmpnepg0100f20cl10wdig1fr/jwks.json on 2026-11-02 (public keys).
  const m = parseJwks({ keys: [
    { kty: 'EC', x: 'LzWGJ09f4y5CEYLRvWp0vPHj8fRQfzQNtdTzUTJSUCo', y: 'W9QV_DrKAFzxJ769Xa76_M_9ftXcqyamiNieTFVj-vo', crv: 'P-256', kid: 'NNDIOwPFzwWtTSslAGMrsPzkBca_M8W9uQAT6HOvQ2U', use: 'sig', alg: 'ES256' },
    { kty: 'EC', x: 'loeHjZzhph9Jw7OG1fW4Y8a6_wZT-0EIciT3585IlAk', y: '8mr-3t1bofeXdTGrLsCn9MMY955fbjPV3cU45fbTmLk', crv: 'P-256', kid: 'vAiL9bpa2RsL8ECHEqbZtlPtW0h7ZwR1nZ3PyR8OcJg', use: 'sig', alg: 'ES256' },
  ] });
  assert.strictEqual(m.size, 2);
  // The first is the same key Privy's app settings call verification_key (what the secret used to fetch).
  const pem = m.get('NNDIOwPFzwWtTSslAGMrsPzkBca_M8W9uQAT6HOvQ2U').export({ type: 'spki', format: 'pem' }).replace(/-----[^-]+-----|\s/g, '');
  assert.strictEqual(pem, 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAELzWGJ09f4y5CEYLRvWp0vPHj8fRQfzQNtdTzUTJSUCpb1BX8OsoAXPEnvr1drvr8z/1+1dyrJqaI2J5MVWP6+g==');
});

test('authAlarm: more than 20 refusals in 10 minutes tells the owner once an hour, with the causes', () => {
  let t = 0;
  const pushes = [];
  const al = createAuthAlarm({ push: (text, o) => pushes.push({ text, o }), now: () => t, log: quiet, region: 'na' });
  for (let i = 0; i < 20; i++) { al.note(i < 15 ? 'no-keys' : 'expired'); t += 1000; }
  assert.strictEqual(pushes.length, 0, '20 is not more than 20');
  al.note('no-keys');
  assert.strictEqual(pushes.length, 1);
  assert.match(pushes[0].text, /^Sign-in checks failed 21 times in 10 min on NA \(no-keys 16, expired 5\)/);
  assert.deepStrictEqual(pushes[0].o, { title: 'Sign-in checks failing', priority: 'high' });
  for (let i = 0; i < 5000; i++) al.note('bad-signature');   // a junk-token flood
  assert.strictEqual(pushes.length, 1, 'once an hour at most');
  t += 61 * 60 * 1000;
  al.note('x');
  assert.strictEqual(pushes.length, 1, 'the old ones aged out of the window');
  for (let i = 0; i < 21; i++) al.note('lookup-failed');
  assert.strictEqual(pushes.length, 2);
});

test('authAlarm: refusals spread out over time never alarm, and a throwing push is swallowed', () => {
  let t = 0;
  const al = createAuthAlarm({ push: () => { throw new Error('ntfy down'); }, now: () => t, log: quiet });
  for (let i = 0; i < 500; i++) { assert.strictEqual(al.note('expired'), false); t += 31 * 1000; }
  for (let i = 0; i < 30; i++) al.note('no-keys');
});
