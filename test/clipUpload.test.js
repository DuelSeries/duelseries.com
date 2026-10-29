'use strict';
/* Clips shared straight from a game (Owen 2026-10-16): the S3 signatures (server/s3lite.js) against AWS's own
   published examples, the MP4 check (server/mp4check.js) against real files from the recorder's own writer and
   every kind of fake, and the upload routes (server/clips.js) end to end against an in-memory bucket. */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const ownerAuth = require('../server/ownerAuth');
const clips = require('../server/clips');
const s3lite = require('../server/s3lite');
const { checkMp4, checkJpeg, Mp4Error } = require('../server/mp4check');
const { mux } = require('../public/js/clip/mp4mux');

const quiet = { warn() {}, log() {} };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clipup-')), 'clips.json');

/* ── signatures: AWS's examples (S3 docs, "Signature Calculations for the Authorization Header" and
      "Authenticating Requests: Using Query Parameters"), same key, bucket and moment ── */
const EX = { creds: { id: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
             region: 'us-east-1', service: 's3', now: Date.UTC(2013, 4, 24) };

test('signing: a GET with a Range header matches AWS\'s published signature', () => {
  const s = s3lite.sign({ ...EX, method: 'GET', path: '/test.txt', payloadHash: crypto.createHash('sha256').update('').digest('hex'),
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9',
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' } });
  assert.strictEqual(s.signedHeaders, 'host;range;x-amz-content-sha256;x-amz-date');
  assert.strictEqual(s.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('signing: a presigned GET matches AWS\'s published signature', () => {
  const s = s3lite.sign({ ...EX, method: 'GET', path: '/test.txt', payloadHash: 'UNSIGNED-PAYLOAD',
    headers: { host: 'examplebucket.s3.amazonaws.com' },
    query: { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
             'X-Amz-Date': '20130524T000000Z', 'X-Amz-Expires': '86400', 'X-Amz-SignedHeaders': 'host' } });
  assert.strictEqual(s.signature, 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

test('signing: an upload link pins the exact size and type, and lasts only as long as asked', () => {
  const s3 = s3lite.createS3({ bucket: 'b', region: 'ca-central-1', creds: EX.creds, now: () => EX.now });
  const u = new URL(s3.presignPut('inbox/abc.mp4', { contentType: 'video/mp4', contentLength: 12345, expires: 600 }));
  assert.strictEqual(u.host, 'b.s3.ca-central-1.amazonaws.com');
  assert.strictEqual(u.pathname, '/inbox/abc.mp4');
  assert.strictEqual(u.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host');
  assert.strictEqual(u.searchParams.get('X-Amz-Expires'), '600');
  assert.match(u.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
  const other = new URL(s3.presignPut('inbox/abc.mp4', { contentType: 'video/mp4', contentLength: 12346, expires: 600 }));
  assert.notStrictEqual(other.searchParams.get('X-Amz-Signature'), u.searchParams.get('X-Amz-Signature'), 'one byte more is another signature');
  assert.ok(!u.href.includes(EX.creds.secret), 'the secret never appears in a link');
});

/* ── MP4s: real ones from the recorder's own writer, then fakes ── */
function clipBytes({ secs = 10, fps = 30, audio = true, w = 1280, h = 720, frame = 900 } = {}) {
  const v = [];
  for (let i = 0; i < secs * fps; i++) v.push({ data: crypto.randomBytes(frame), ts: Math.round(i * 1e6 / fps), key: i % fps === 0 });
  const a = [];
  if (audio) for (let t = 0; t < secs * 1e6; t += 1024 / 48000 * 1e6) a.push({ data: crypto.randomBytes(200), ts: Math.round(t) });
  return Buffer.from(mux({ video: { width: w, height: h, description: Uint8Array.from([1, 100, 0, 31, 255]), chunks: v },
                           audio: audio ? { sampleRate: 48000, channels: 2, description: null, chunks: a } : null }));
}
const reader = (buf) => async (a, b) => buf.subarray(a, b + 1);
const LIM = { maxBytes: clips.UP_MAX_BYTES, maxSec: clips.UP_MAX_SEC };
const check = (buf, lim = LIM) => checkMp4(reader(buf), buf.length, lim);
async function refused(buf, re, lim) {
  await assert.rejects(check(buf, lim), (e) => e instanceof Mp4Error && (!re || re.test(e.message)), String(re));
}

test('mp4: a clip from the recorder\'s writer passes, with its length and size read back', async () => {
  const r = await check(clipBytes({ secs: 30 }));
  assert.deepStrictEqual({ w: r.w, h: r.h, audio: r.audio }, { w: 1280, h: 720, audio: true });
  assert.ok(Math.abs(r.ms - 30000) < 100, String(r.ms));
  assert.strictEqual((await check(clipBytes({ secs: 3, audio: false }))).audio, false, 'no sound is fine');
});

test('mp4: too long, too big, extra bytes, a web page, a fragment and a broken index are all refused', async () => {
  await refused(clipBytes({ secs: 33 }), /longer than/);
  const ok = clipBytes({ secs: 5 });
  await refused(ok, /larger/, { maxBytes: ok.length - 1, maxSec: 31.5 });
  await refused(Buffer.concat([ok, Buffer.from('<html><script>alert(1)</script></html>')]), /runs past|unreadable|not an MP4|holds/);
  await refused(Buffer.from('<!doctype html><html><body>' + 'x'.repeat(2000) + '</body></html>'), /not an MP4|runs past|start like/);
  await refused(Buffer.alloc(4000), /runs past|unreadable|start like/);
  await refused(ok.subarray(0, ok.length - 10), /runs past/, undefined);
  // An extra top-level box of a kind a clip never has.
  const moof = Buffer.alloc(16); moof.writeUInt32BE(16, 0); moof.write('moof', 4);
  await refused(Buffer.concat([ok, moof]), /a fragment/);
  // Two ftyp-led files glued together: a second moov.
  await refused(Buffer.concat([ok, ok]), /exactly one index|holds/);
  // An index that points past the data: rewrite the video track's first chunk offset.
  const bad = Buffer.from(ok);
  const at = bad.indexOf(Buffer.from('stco'));
  bad.writeUInt32BE(bad.length + 100, at + 12);
  await refused(bad, /outside the video data/);
  // Not starting with ftyp.
  const nf = Buffer.from(ok); nf.write('free', 4);
  await refused(nf, /start like an MP4/);
});

test('mp4: nothing big rides along: padding and unreferenced data are refused', async () => {
  const ok = clipBytes({ secs: 4 });
  const pad = Buffer.alloc(300 * 1024); pad.writeUInt32BE(pad.length, 0); pad.write('free', 4);
  await refused(Buffer.concat([ok, pad]), /too much besides the video/);
  const small = Buffer.alloc(1024); small.writeUInt32BE(small.length, 0); small.write('udta', 4);
  assert.ok(await check(Buffer.concat([ok, small])), 'a small tag box is fine');
  // A second data box the index never points at.
  const extra = Buffer.alloc(200 * 1024); extra.writeUInt32BE(extra.length, 0); extra.write('mdat', 4);
  await refused(Buffer.concat([ok, extra]), /not part of the video/);
});

test('mp4: a huge frame table cannot make the check slow', async () => {
  const buf = clipBytes({ secs: 2 });
  const at = buf.indexOf(Buffer.from('stsz'));
  buf.writeUInt32BE(0xffffffff, at + 12);           // sample count far past the table
  const t0 = Date.now();
  await refused(buf);
  assert.ok(Date.now() - t0 < 500);
});

test('jpeg: start and end markers, and a size cap', async () => {
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(500), Buffer.from([0xff, 0xd9])]);
  assert.strictEqual(await checkJpeg(reader(jpg), jpg.length, { maxBytes: 1000 }), true);
  await assert.rejects(checkJpeg(reader(jpg), jpg.length, { maxBytes: 100 }), Mp4Error);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(500), Buffer.from([0xff, 0xd9])]);
  await assert.rejects(checkJpeg(reader(png), png.length, { maxBytes: 1000 }), /not a JPEG/);
});

/* ── the routes, against an in-memory bucket ── */
function fakeBucket() {
  const objs = new Map();     // key -> { body, type, etag }
  const calls = [];
  const put = (key, body, type) => objs.set(key, { body: Buffer.from(body), type, etag: '"' + crypto.createHash('md5').update(body).digest('hex') + '"' });
  const s3 = {
    presignPut: (key, o) => 'https://bucket.test/' + key + '?len=' + o.contentLength + '&type=' + encodeURIComponent(o.contentType) + (o.once ? '&once=1' : ''),
    presignGet: (key) => 'https://bucket.test/' + key + '?signed=1',
    async head(key) { calls.push('head ' + key); const o = objs.get(key); return o ? { size: o.body.length, type: o.type, etag: o.etag } : null; },
    async range(key, a, b, etag) {
      const o = objs.get(key);
      if (!o) throw Object.assign(new Error('404'), { status: 404 });
      if (etag && etag !== o.etag) throw Object.assign(new Error('412'), { status: 412 });
      if (s3.onRead) s3.onRead(key);
      return o.body.subarray(a, b + 1);
    },
    async del(key) { calls.push('del ' + key); objs.delete(key); return true; },
    async copy(from, to, o) {
      calls.push('copy ' + from + ' ' + to);
      const src = objs.get(from);
      if (!src) throw Object.assign(new Error('404'), { status: 404 });
      if (o.ifMatch && o.ifMatch !== src.etag) throw Object.assign(new Error('412'), { status: 412 });
      put(to, src.body, o.contentType);
      objs.get(to).meta = o;
      return true;
    },
  };
  // What a browser does with an upload link: S3 refuses any other length or type.
  const upload = (url, body, type) => {
    const u = new URL(url);
    if (Number(u.searchParams.get('len')) !== body.length || u.searchParams.get('type') !== type) return false;
    if (u.searchParams.get('once') && objs.has(u.pathname.slice(1))) return false;     // If-None-Match: *
    put(u.pathname.slice(1), body, type);
    return true;
  };
  return { s3, objs, calls, upload, put };
}

const keyPair = () => { const priv = ed25519.utils.randomPrivateKey(); return { priv, wallet: bs58.encode(ed25519.getPublicKey(priv)) }; };
const sign = (k, action, args, ts = Date.now()) => ({
  action, args, wallet: k.wallet, ts,
  sig: bs58.encode(ed25519.sign(new TextEncoder().encode(ownerAuth.actionMessage(action, args, k.wallet, ts)), k.priv)),
});

async function server({ uploads = true, store = null, uploadLimiter = null } = {}) {
  const owner = keyPair();
  store = store || clips.createClipStore({ file: tmpFile(), log: quiet });
  const bucket = fakeBucket();
  const invalidated = [];
  const app = express();
  app.set('trust proxy', 'loopback');      // as behind nginx: post(..., ip) is the player's address
  app.use(express.json());
  clips.mountClipRoutes(app, {
    store, isOwner: (w) => w === owner.wallet, walletForAction: ownerAuth.walletForAction,
    nameOf: async () => 'nightcoil <b>', resolveX: async () => null, log: quiet, sweepMs: 0, uploadLimiter,
    uploads: uploads ? { s3: bucket.s3, cdn: 'https://cdn.test', invalidate: async (p) => { invalidated.push(...p); } } : null,
  });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = (p, body, ip) => fetch(base + p, { method: 'POST', body: JSON.stringify(body),
    headers: Object.assign({ 'content-type': 'application/json' }, ip ? { 'x-forwarded-for': ip } : {}) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  const get = (p, o) => fetch(base + p, o);
  return { owner, store, bucket, invalidated, srv, post, get };
}
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(3000), Buffer.from([0xff, 0xd9])]);

test('upload: P, Share, checked, waiting for the owner, approved, on the wall from CloudFront, share page', async () => {
  const { owner, bucket, invalidated, srv, post, get } = await server();
  try {
    const p = keyPair();
    const mp4 = clipBytes({ secs: 8 });
    const start = await post('/api/clips/upload', sign(p, 'clip:upload', { size: mp4.length, psize: JPG.length, game: 'slither' }));
    assert.strictEqual(start.status, 200, JSON.stringify(start.body));
    const { id, ticket } = start.body;
    assert.match(id, /^[a-f0-9]{16}$/);
    assert.ok(start.body.video.includes('inbox/' + id + '.mp4'));
    assert.ok(!bucket.upload(start.body.video, Buffer.concat([mp4, Buffer.alloc(1)]), 'video/mp4'), 'one byte more is refused by S3');
    assert.ok(!bucket.upload(start.body.video, mp4, 'text/html'), 'another type is refused by S3');
    assert.ok(bucket.upload(start.body.video, mp4, 'video/mp4'));
    assert.ok(bucket.upload(start.body.poster, JPG, 'image/jpeg'));

    // Nothing is on the wall or in the queue until the check ran.
    let q = await post('/api/clips/queue', sign(owner, 'clips:queue', {}));
    assert.strictEqual(q.body.waiting.length, 0, 'an upload not yet checked is not shown to the owner');

    assert.strictEqual((await post('/api/clips/uploaded', { id, ticket: 'a'.repeat(48) })).status, 404, 'a wrong ticket finds nothing');
    const done = await post('/api/clips/uploaded', { id, ticket });
    assert.deepStrictEqual(done.body, { ok: true, status: 'waiting' });
    assert.ok(bucket.objs.has('ok/' + id + '.mp4'), 'the checked copy is kept apart');
    assert.ok(!bucket.upload(start.body.video, clipBytes({ secs: 8 }), 'video/mp4'), 'the link cannot write again');

    q = await post('/api/clips/queue', sign(owner, 'clips:queue', {}));
    assert.strictEqual(q.body.waiting.length, 1);
    const w = q.body.waiting[0];
    assert.strictEqual(w.provider, 'upload');
    assert.strictEqual(w.wallet, p.wallet);
    assert.strictEqual(w.name, 'nightcoil <b>', 'kept as text; the page sets it as text');
    assert.match(w.media.video, /ok\/[a-f0-9]{16}\.mp4\?signed=1/, 'the owner watches a short-lived private link');
    assert.ok(Math.abs(w.media.ms - 8000) < 100);

    // Not public while waiting: not on the wall, no share page.
    assert.strictEqual((await (await get('/api/clips')).json()).clips.length, 0);
    assert.strictEqual((await get('/clip/' + id, { redirect: 'manual' })).status, 302);

    const d = await post('/api/clips/decide', sign(owner, 'clip:decide', { id, verdict: 'live' }));
    assert.strictEqual(d.status, 200, JSON.stringify(d.body));
    const live = bucket.objs.get('live/' + id + '.mp4');
    assert.strictEqual(live.type, 'video/mp4');
    assert.match(live.meta.disposition, /^attachment; filename="duelseries-clip-[a-f0-9]{16}\.mp4"$/, 'a plain link downloads it');
    assert.ok(bucket.objs.has('live/' + id + '.jpg'));
    assert.ok(!bucket.objs.has('ok/' + id + '.mp4') && !bucket.objs.has('inbox/' + id + '.mp4'), 'the upload and its checked copy are gone once it is live');

    const wall = await (await get('/api/clips')).json();
    assert.strictEqual(wall.clips.length, 1);
    assert.deepStrictEqual(wall.clips[0].media, { video: 'https://cdn.test/' + id + '.mp4', poster: 'https://cdn.test/' + id + '.jpg', w: 1280, h: 720, ms: wall.clips[0].media.ms });
    assert.ok(!('wallet' in wall.clips[0]));

    const page = await get('/clip/' + id);
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.ok(html.includes('https://cdn.test/' + id + '.mp4'));
    assert.ok(html.includes('nightcoil &lt;b&gt;') && !html.includes('nightcoil <b>'), 'the name is escaped');
    assert.ok(html.includes('og:video'));

    assert.strictEqual((await post('/api/clips/decide', sign(owner, 'clip:decide', { id, verdict: 'removed' }))).status, 200);
    assert.ok(!bucket.objs.has('live/' + id + '.mp4'), 'taken down: the file is deleted');
    assert.deepStrictEqual(invalidated, ['/' + id + '.mp4', '/' + id + '.jpg'], 'and CloudFront forgets it');
    assert.strictEqual((await get('/clip/' + id, { redirect: 'manual' })).status, 302);
  } finally { srv.close(); }
});

test('upload: a fake file is refused and deleted; a file swapped after the check never goes live', async () => {
  const { owner, bucket, srv, post } = await server();
  try {
    const p = keyPair();
    // A web page sent as an MP4 of the size it declared.
    const html = Buffer.from('<html>' + 'x'.repeat(70000) + '</html>');
    let s = await post('/api/clips/upload', sign(p, 'clip:upload', { size: html.length, psize: 0, game: 'agar' }));
    bucket.upload(s.body.video, html, 'video/mp4');
    let r = await post('/api/clips/uploaded', { id: s.body.id, ticket: s.body.ticket });
    assert.strictEqual(r.status, 422);
    assert.ok(!bucket.objs.has('inbox/' + s.body.id + '.mp4'), 'deleted');
    assert.strictEqual((await post('/api/clips/uploaded', { id: s.body.id, ticket: s.body.ticket })).status, 409, 'and it stays refused');

    // The file changes between the reads of one check (its link still works for a few minutes).
    const mp4 = clipBytes({ secs: 4 });
    s = await post('/api/clips/upload', sign(p, 'clip:upload', { size: mp4.length, psize: 0, game: 'agar' }));
    bucket.upload(s.body.video, mp4, 'video/mp4');
    let swapped = false;
    bucket.s3.onRead = (key) => { if (!swapped) { swapped = true; bucket.put(key, Buffer.from(mp4).fill(7, 2000, 2100), 'video/mp4'); } };   // as if S3 let it
    r = await post('/api/clips/uploaded', { id: s.body.id, ticket: s.body.ticket });
    bucket.s3.onRead = null;
    assert.strictEqual(r.status, 422, JSON.stringify(r.body));
    const q = await post('/api/clips/queue', sign(owner, 'clips:queue', {}));
    assert.strictEqual(q.body.waiting.length, 0);

    // Re-uploading after a good check changes nothing: what is approved is the checked copy.
    const good = clipBytes({ secs: 4 });
    s = await post('/api/clips/upload', sign(p, 'clip:upload', { size: good.length, psize: 0, game: 'paper' }));
    bucket.upload(s.body.video, good, 'video/mp4');
    assert.strictEqual((await post('/api/clips/uploaded', { id: s.body.id, ticket: s.body.ticket })).status, 200);
    assert.ok(!bucket.upload(s.body.video, Buffer.from(good).fill(9, 3000, 3100), 'video/mp4'), 'the link writes once');
    bucket.put('inbox/' + s.body.id + '.mp4', Buffer.from(good).fill(9, 3000, 3100), 'video/mp4');   // and even if it could
    assert.strictEqual((await post('/api/clips/decide', sign(owner, 'clip:decide', { id: s.body.id, verdict: 'live' }))).status, 200);
    assert.ok(bucket.objs.get('live/' + s.body.id + '.mp4').body.equals(good), 'the bytes that went live are the checked ones');
  } finally { srv.close(); }
});

test('upload: caps per player and for everyone, wrong sizes, other players\' uploads, sharing off', async () => {
  const { srv, post, store } = await server();
  try {
    const p = keyPair();
    const up = (k, args, ip) => post('/api/clips/upload', sign(k, 'clip:upload', args), ip);
    assert.strictEqual((await up(p, { size: clips.UP_MAX_BYTES + 1, psize: 0, game: 'slither' })).status, 400);
    assert.match((await up(p, { size: 10000, psize: 0, game: 'slither' })).body.error, /too small/);
    assert.strictEqual((await up(p, { size: '5000', psize: 0, game: 'slither' })).status, 400, 'a size as text is refused');
    assert.strictEqual((await up(p, { size: 70000, psize: clips.POSTER_MAX + 1, game: 'slither' })).status, 400);
    for (let i = 0; i < clips.UP_OPEN_MAX; i++) assert.strictEqual((await up(p, { size: 70000, psize: 0, game: 'slither' })).status, 200);
    const more = await up(p, { size: 70000, psize: 0, game: 'slither' });
    assert.strictEqual(more.status, 400);
    assert.match(more.body.error, /waiting to be reviewed/);

    // Someone else's ticket does not move another player's upload.
    const q = keyPair();
    const theirs = await up(q, { size: 70000, psize: 0, game: 'agar' }, '203.0.113.2');
    const mine = store.waiting().length;
    assert.strictEqual((await post('/api/clips/uploaded', { id: theirs.body.id, ticket: 'f'.repeat(48) })).status, 404);
    assert.strictEqual(store.waiting().length, mine);

    // A day's cap per wallet counts every link handed out, even ones that failed.
    const r = keyPair();
    for (let i = 0; i < clips.UP_DAY_MAX; i++) {
      const s = await up(r, { size: 70000, psize: 0, game: 'br' }, '203.0.113.3');
      assert.strictEqual(s.status, 200, String(i));
      store.uploadFailed(s.body.id);
    }
    assert.match((await up(r, { size: 70000, psize: 0, game: 'br' }, '203.0.113.3')).body.error, /tomorrow/);

    // Junk bodies are a 401, never a crash.
    for (const junk of [{}, { action: 'clip:upload' }, { action: 'clip:upload', wallet: { toString: 1 }, sig: [], ts: 'x' }]) {
      assert.strictEqual((await post('/api/clips/upload', junk)).status, 401);
    }
    assert.strictEqual((await post('/api/clips/uploaded', { id: { $ne: 1 }, ticket: [] })).status, 404);
  } finally { srv.close(); }

  const off = await server({ uploads: false });
  try {
    assert.strictEqual((await off.post('/api/clips/upload', sign(keyPair(), 'clip:upload', { size: 70000, psize: 0, game: 'slither' }))).status, 503);
  } finally { off.srv.close(); }
});

test('upload: the store refuses everyone together past the daily cap, and its records survive a restart', () => {
  let t = 5_000_000;
  const file = tmpFile();
  const s = clips.createClipStore({ file, log: quiet, now: () => t });
  /* Starts that never deliver a checked file (failed, or deleted while uploading) do not use up the day's budget
     for everyone (night review 2026-10-29): fresh wallets could otherwise switch uploads off for a day. */
  for (let i = 0; i < clips.UP_DAY_ALL + 5; i++) {
    const r = s.startUpload({ wallet: 'F' + i, name: 'n', size: 70000, psize: 0, game: 'slither' });
    assert.ok(r.ok, r.error);
    if (i % 2) s.uploadFailed(r.clip.id); else assert.ok(s.withdraw(r.clip.id, 'F' + i).ok);
  }
  /* Nor do ones that delivered and that the player then deleted themselves: their files are gone with them, and a
     delete frees the address's open place at once, so counting them let five addresses switch uploads off for a day. */
  for (let i = 0; i < clips.UP_DAY_ALL + 5; i++) {
    const r = s.startUpload({ wallet: 'D' + i, name: 'n', size: 70000, psize: 0, game: 'slither' });
    assert.ok(r.ok, r.error);
    assert.ok(s.uploadChecked(r.clip.id, { w: 1280, h: 720, ms: 9000 }, false));
    if (i % 3 === 2) { assert.ok(s.decide(r.clip.id, 'live').ok); }
    assert.ok(s.withdraw(r.clip.id, 'D' + i).ok, 'waiting or on the wall');
  }
  for (let i = 0; i < clips.UP_DAY_ALL; i++) {
    const r = s.startUpload({ wallet: 'W' + i, name: 'n', size: 70000, psize: 0, game: 'slither' });
    assert.ok(r.ok, r.error);
    assert.ok(s.uploadChecked(r.clip.id, { w: 1280, h: 720, ms: 9000 }, false));
    if (i % 2) s.decide(r.clip.id, 'rejected');      // a delivered one counts whatever the owner says
    else if (i % 4 === 0) assert.ok(s.decide(r.clip.id, 'live').ok && s.decide(r.clip.id, 'removed').ok, 'the owner taking it down is not a player delete');
  }
  assert.match(s.startUpload({ wallet: 'Wx', name: 'n', size: 70000, psize: 0, game: 'slither' }).error, /Too many/);
  t += 24 * 3600e3 + 1;
  const ok = s.startUpload({ wallet: 'Wx', name: 'n', size: 70000, psize: 4000, game: 'slither' });
  assert.ok(ok.ok);
  assert.ok(s.uploadChecked(ok.clip.id, { w: 1920, h: 1080, ms: 30000 }, true));
  const back = clips.createClipStore({ file, log: quiet, now: () => t });
  const c = back.find(ok.clip.id);
  assert.deepStrictEqual({ status: c.status, poster: c.poster, media: c.media, size: c.size },
    { status: 'waiting', poster: true, media: { w: 1920, h: 1080, ms: 30000 }, size: 70000 });
  assert.ok(back.byTicket(ok.clip.id, ok.ticket), 'the ticket still works after a restart');
  assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))).includes(ok.ticket), 'only its hash is on disk');
});

/* Fresh wallets cost nothing, so one address holds at most SRC_OPEN_MAX clips open, links and uploads together
   (night review 2026-10-29). A player alone on an address never meets it; the owner is never counted. */
test('upload: fresh wallets from one address are capped there; other addresses and the owner still share', async () => {
  const { owner, srv, post, store } = await server();
  try {
    const up = (k, ip) => post('/api/clips/upload', sign(k, 'clip:upload', { size: 70000, psize: 0, game: 'slither' }), ip);
    const spam = '198.51.100.7';
    const ids = [];
    for (let i = 0; i < clips.SRC_OPEN_MAX; i++) {
      const s = await up(keyPair(), spam);
      assert.strictEqual(s.status, 200, String(i));
      ids.push(s.body.id);
    }
    const more = await up(keyPair(), spam);
    assert.strictEqual(more.status, 400);
    assert.match(more.body.error, /from here/);
    const link = await post('/api/clips/submit', sign(keyPair(), 'clip:submit', { url: 'x.com/a/status/123456', caption: '', game: 'other' }), spam);
    assert.match(link.body.error, /from here/, 'a link from the same address counts the same');

    assert.strictEqual((await up(keyPair(), '198.51.100.8')).status, 200, 'another address is untouched');
    assert.strictEqual((await up(owner, spam)).status, 200, 'the owner\'s own upload is never counted against an address');

    // A start that never delivers stops counting once the sweep marks it failed, and never uses up the day's budget.
    store.uploadFailed(ids[0]);
    assert.strictEqual((await up(keyPair(), spam)).status, 200);
  } finally { srv.close(); }
});

/* A player's own delete frees their address's open place at once, so a delivered upload the player deleted used to
   be the way round SRC_OPEN_MAX: share one real recording on a fresh wallet, delete it, again, twenty a day per
   address, five addresses, and UP_DAY_ALL switched uploads off for everyone with the owner's queue empty (night
   review 2026-10-29). Now a player's delete does not count against everyone, and one address delivers at most
   SRC_DAY_MAX a day, deleted or not. */
test('upload: sharing and deleting on fresh wallets cannot use up the day for everyone; one address gets SRC_DAY_MAX', () => {
  let t = 7_000_000;
  const file = tmpFile();
  const s = clips.createClipStore({ file, log: quiet, now: () => t++ });
  const start = (wallet, src) => s.startUpload({ wallet, name: 'n', size: 70000, psize: 0, game: 'other', src });
  const per = [];
  for (let a = 0; a < 5; a++) {
    const src = s.source('198.51.100.' + (20 + a));
    let n = 0;
    for (let i = 0; i < 20; i++) {
      const w = 'A' + a + 'W' + i;
      const r = start(w, src);
      if (!r.ok) { assert.match(r.error, /from here today/); continue; }
      assert.ok(s.uploadChecked(r.clip.id, { w: 1280, h: 720, ms: 9000 }, false));
      assert.ok(s.withdraw(r.clip.id, w).ok);
      n++;
    }
    per.push(n);
  }
  assert.strictEqual(clips.SRC_DAY_MAX, 5);
  assert.deepStrictEqual(per, [5, 5, 5, 5, 5]);
  assert.strictEqual(s.waiting().length, 0);
  assert.ok(start('honest', s.source('203.0.113.50')).ok, 'an honest player elsewhere still shares');

  // Uploads still in flight count too, so a burst cannot slip past; one that fails stops counting.
  const b = s.source('198.51.100.40');
  for (let i = 0; i < 2; i++) {
    const r = start('B' + i, b);
    assert.ok(s.uploadChecked(r.clip.id, { w: 1280, h: 720, ms: 9000 }, false) && s.withdraw(r.clip.id, 'B' + i).ok);
  }
  const flying = [start('B2', b), start('B3', b), start('B4', b)];
  assert.ok(flying.every(r => r.ok));
  assert.match(start('B5', b).error, /from here today/);
  s.uploadFailed(flying[0].clip.id);
  assert.ok(start('B6', b).ok);

  // The owner (no address) and a player alone on an address sharing a normal day never meet it.
  for (let i = 0; i < clips.SRC_DAY_MAX + 3; i++) {
    const r = start('owner', '');
    assert.ok(r.ok, r.error);
    assert.ok(s.uploadChecked(r.clip.id, { w: 1280, h: 720, ms: 9000 }, false) && s.decide(r.clip.id, 'live').ok);
  }
  const solo = s.source('203.0.113.60');
  for (let i = 0; i < clips.SRC_DAY_MAX; i++) {
    const r = start('solo', solo);
    assert.ok(r.ok, r.error);
    assert.ok(s.uploadChecked(r.clip.id, { w: 1280, h: 720, ms: 9000 }, false) && s.decide(r.clip.id, 'live').ok);
  }

  // A delete is remembered across a restart: the address stays spent, and the deletes still do not count for everyone.
  const back = clips.createClipStore({ file, log: quiet, now: () => t++ });
  const gone = back.mine('A0W0', 5);
  assert.deepStrictEqual(gone, [], 'a deleted clip is out of the player\'s list');
  assert.match(back.startUpload({ wallet: 'A0late', name: 'n', size: 70000, psize: 0, game: 'other', src: back.source('198.51.100.20') }).error,
    /from here today/);
  assert.ok(back.startUpload({ wallet: 'honest2', name: 'n', size: 70000, psize: 0, game: 'other', src: back.source('203.0.113.51') }).ok);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')).clips;
  assert.ok(raw.filter(c => c.withdrawn === true).every(c => c.status === 'removed' && c.wallet !== 'owner'));
  assert.strictEqual(raw.filter(c => c.withdrawn === true).length, 5 * 5 + 2);
  t += 24 * 3600e3 + 1;
  assert.ok(back.startUpload({ wallet: 'A0next', name: 'n', size: 70000, psize: 0, game: 'other', src: back.source('198.51.100.20') }).ok,
    'the next day the address has its own again');
});

test('upload: the reviewer\'s replay through the real routes and the real limiter config', async () => {
  const { srv, post, bucket, store } = await server({ uploadLimiter: clips.clipLimiters().uploadLimiter });
  const mp4 = clipBytes({ secs: 3 });
  try {
    const per = [];
    for (let a = 0; a < 5; a++) {
      const ip = '198.51.100.' + (20 + a);
      let n = 0, refusal = null;
      for (let i = 0; i < 20 && !refusal; i++) {
        const k = keyPair();
        const s = await post('/api/clips/upload', sign(k, 'clip:upload', { size: mp4.length, psize: 0, game: 'other' }), ip);
        if (s.status !== 200) { refusal = s; break; }
        assert.ok(bucket.upload(s.body.video, mp4, 'video/mp4'));
        assert.strictEqual((await post('/api/clips/uploaded', { id: s.body.id, ticket: s.body.ticket }, ip)).body.status, 'waiting');
        assert.strictEqual((await post('/api/clips/delete', sign(k, 'clip:delete', { id: s.body.id }), ip)).status, 200);
        n++;
      }
      assert.strictEqual(refusal && refusal.status, 400);
      assert.match(refusal.body.error, /from here today/);
      per.push(n);
    }
    assert.deepStrictEqual(per, [clips.SRC_DAY_MAX, clips.SRC_DAY_MAX, clips.SRC_DAY_MAX, clips.SRC_DAY_MAX, clips.SRC_DAY_MAX]);
    assert.strictEqual(store.waiting().length, 0);
    const honest = await post('/api/clips/upload', sign(keyPair(), 'clip:upload', { size: mp4.length, psize: 0, game: 'slither' }), '203.0.113.50');
    assert.strictEqual(honest.status, 200, JSON.stringify(honest.body));
  } finally { srv.close(); }
});

test('own clips: a player sees theirs and deletes them, waiting or on the wall; nobody else can', async () => {
  const { owner, bucket, invalidated, srv, post, get } = await server();
  try {
    const p = keyPair(), other = keyPair();
    const send = async (caption) => {
      const mp4 = clipBytes({ secs: 3 });
      const s = await post('/api/clips/upload', sign(p, 'clip:upload', { size: mp4.length, psize: 0, game: 'slither', caption }));
      bucket.upload(s.body.video, mp4, 'video/mp4');
      assert.strictEqual((await post('/api/clips/uploaded', { id: s.body.id, ticket: s.body.ticket })).status, 200);
      return s.body.id;
    };
    const a = await send('first <one>');
    const b = await send('second');
    await post('/api/clips/decide', sign(owner, 'clip:decide', { id: b, verdict: 'live' }));

    let mine = await post('/api/clips/mine', sign(p, 'clips:mine', {}));
    assert.deepStrictEqual(mine.body.clips.map(c => [c.id, c.status, c.caption]), [[b, 'live', 'second'], [a, 'waiting', 'first <one>']]);
    assert.ok(!('wallet' in mine.body.clips[0]));
    assert.strictEqual(mine.body.clips[1].media.video, '', 'no S3 link for a player: S3 downloads are billed');
    assert.ok(mine.body.clips[0].media.video.startsWith('https://cdn.test/'), 'a live one plays from CloudFront');
    assert.deepStrictEqual((await post('/api/clips/mine', sign(other, 'clips:mine', {}))).body.clips, [], 'nobody else sees them');

    assert.strictEqual((await post('/api/clips/delete', sign(other, 'clip:delete', { id: a }))).status, 404, 'another player cannot delete it');
    assert.ok(bucket.objs.has('ok/' + a + '.mp4'));
    assert.strictEqual((await post('/api/clips/delete', sign(p, 'clip:delete', { id: a }))).status, 200);
    assert.ok(!bucket.objs.has('ok/' + a + '.mp4') && !bucket.objs.has('inbox/' + a + '.mp4'), 'a waiting clip\'s files are deleted');
    assert.strictEqual((await post('/api/clips/queue', sign(owner, 'clips:queue', {}))).body.waiting.length, 0, 'and it leaves the owner\'s queue');

    const del = await post('/api/clips/delete', sign(p, 'clip:delete', { id: b }));
    assert.deepStrictEqual(del.body.clips, []);
    assert.ok(!bucket.objs.has('live/' + b + '.mp4'), 'a clip on the wall is deleted too');
    assert.deepStrictEqual(invalidated, ['/' + b + '.mp4', '/' + b + '.jpg']);
    assert.strictEqual((await (await get('/api/clips')).json()).clips.length, 0);
    assert.strictEqual((await post('/api/clips/delete', sign(p, 'clip:delete', { id: b }))).status, 404, 'once');
    assert.strictEqual((await post('/api/clips/decide', sign(owner, 'clip:decide', { id: a, verdict: 'live' }))).status, 409, 'a deleted clip cannot be approved');
  } finally { srv.close(); }
});
