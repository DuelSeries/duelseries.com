'use strict';
/* The Clips tab's server half (server/clips.js): which links are clips, the review rules, the file it keeps, and the
   four routes end to end with real wallet signatures. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const ownerAuth = require('../server/ownerAuth');
const clips = require('../server/clips');
const { parseClipUrl, createClipStore, mountClipRoutes, resolveXMedia } = clips;

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clips-')), 'clips.json');
const quiet = { warn() {}, log() {} };

test('links: X, YouTube and TikTok posts are clips, canonical and with their id', () => {
  const x = parseClipUrl('https://twitter.com/Night_Coil/status/1847123456789012345?s=20');
  assert.deepStrictEqual(x, { provider: 'x', vid: '1847123456789012345', handle: 'Night_Coil', vertical: false,
    url: 'https://x.com/Night_Coil/status/1847123456789012345' });
  assert.strictEqual(parseClipUrl('x.com/a/status/12345/video/1').vid, '12345', 'no scheme and a /video/1 tail still parse');
  assert.strictEqual(parseClipUrl('https://mobile.x.com/a/status/123456').provider, 'x');

  assert.strictEqual(parseClipUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3').vid, 'dQw4w9WgXcQ');
  assert.strictEqual(parseClipUrl('https://youtu.be/dQw4w9WgXcQ').url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const sh = parseClipUrl('https://youtube.com/shorts/dQw4w9WgXcQ?feature=share');
  assert.strictEqual(sh.vertical, true);
  assert.strictEqual(sh.url, 'https://www.youtube.com/shorts/dQw4w9WgXcQ');

  const tt = parseClipUrl('https://www.tiktok.com/@slither.pro/video/7312345678901234567?lang=en');
  assert.deepStrictEqual(tt, { provider: 'tiktok', vid: '7312345678901234567', handle: 'slither.pro', vertical: true,
    url: 'https://www.tiktok.com/@slither.pro/video/7312345678901234567' });
});

test('links: anything else is refused, including tricks in the host or the id', () => {
  for (const bad of [
    '', 'hello', 'javascript:alert(1)', 'https://evil.com/x.com/a/status/12345', 'https://x.com.evil.com/a/status/12345',
    'https://x.com/a/likes', 'https://x.com/a/status/abc', 'https://youtube.com/watch?v=short', 'https://youtube.com/@chan',
    'https://youtu.be/<script>12', 'https://vm.tiktok.com/ZM123/', 'https://tiktok.com/@a/photo/7312345678901234567',
    'ftp://x.com/a/status/12345', 'https://x.com/' + 'a'.repeat(400), 42, null,
  ]) assert.strictEqual(parseClipUrl(bad), null, String(bad));
});

test('submit: one waiting clip per player, no duplicates, a daily cap, captions cleaned', () => {
  let t = 1_000_000;
  const s = createClipStore({ file: tmpFile(), log: quiet, now: () => t });
  const r = s.submit({ wallet: 'W1', name: 'nightcoil', url: 'x.com/a/status/11111', caption: '  three\u202e snakes\n\nin ten  ', game: 'slither' });
  assert.ok(r.ok);
  assert.strictEqual(r.clip.caption, 'three snakes in ten', 'direction overrides and runs of space are gone');
  assert.strictEqual(r.clip.status, 'waiting');
  assert.match(s.submit({ wallet: 'W1', url: 'x.com/a/status/22222' }).error, /already have a clip waiting/);
  assert.match(s.submit({ wallet: 'W2', url: 'https://twitter.com/a/status/11111' }).error, /already waiting/, 'same post, other spelling');
  assert.strictEqual(s.submit({ wallet: 'W2', url: 'x.com/b/status/33333', game: 'chess' }).clip.game, 'other', 'unknown game is Other');
  assert.match(s.submit({ wallet: 'W3', url: 'nope' }).error, /Paste the link/);
  assert.match(s.submit({ wallet: '', url: 'x.com/a/status/44444' }).error, /Log in/);
  assert.strictEqual(s.submit({ wallet: 'W4', url: 'x.com/a/status/55555', caption: 'x'.repeat(500) }).clip.caption.length, 140);

  // Five a day, each reviewed before the next.
  for (let i = 0; i < 5; i++) {
    const c = s.submit({ wallet: 'W9', url: 'x.com/z/status/9000' + i });
    assert.ok(c.ok, 'clip ' + i);
    s.decide(c.clip.id, 'rejected');
  }
  assert.match(s.submit({ wallet: 'W9', url: 'x.com/z/status/90009' }).error, /tomorrow/);
  t += 24 * 60 * 60 * 1000 + 1;
  assert.ok(s.submit({ wallet: 'W9', url: 'x.com/z/status/90009' }).ok, 'a day later it opens again');
  assert.match(s.submit({ wallet: 'W8', url: 'x.com/z/status/90001' }).error, /not going on the wall/, 'a rejected post stays rejected');
});

test('decide: waiting goes live or is rejected, live can be removed, nothing else', () => {
  let t = 5;
  const s = createClipStore({ file: tmpFile(), log: quiet, now: () => t++ });
  const a = s.submit({ wallet: 'A', name: 'ann', url: 'youtu.be/aaaaaaaaaaa' }).clip;
  const b = s.submit({ wallet: 'B', name: 'bo', url: 'youtu.be/bbbbbbbbbbb' }).clip;
  const c = s.submit({ wallet: 'A2', name: 'ann', url: 'youtu.be/ccccccccccc' }).clip;
  assert.deepStrictEqual(s.waiting().map(x => x.id), [a.id, b.id, c.id], 'the queue is oldest first');
  assert.ok(s.decide(b.id, 'live').ok);
  assert.ok(s.decide(a.id, 'live').ok);
  assert.ok(s.decide(c.id, 'rejected').ok);
  assert.deepStrictEqual(s.live().map(x => x.id), [a.id, b.id], 'the wall is newest approval first');
  assert.match(s.decide(a.id, 'rejected').error, /already approved/);
  assert.match(s.decide(c.id, 'live').error, /already rejected/);
  assert.match(s.decide(c.id, 'removed').error, /already/, 'only a live clip can be removed');
  assert.match(s.decide(a.id, 'banana').error, /Unknown/);
  assert.match(s.decide('ffffffffffffffff', 'live').error, /No such/);
  assert.ok(s.decide(a.id, 'removed').ok);
  assert.deepStrictEqual(s.live().map(x => x.id), [b.id]);
  assert.strictEqual(s.waitingCount(), 0);
});

test('top clippers: count of clips on the wall per player, ties to the latest approval', () => {
  let t = 1;
  const s = createClipStore({ file: tmpFile(), log: quiet, now: () => t++ });
  const go = (w, n, id) => { const c = s.submit({ wallet: w, name: n, url: 'x.com/a/status/' + id }).clip; s.decide(c.id, 'live'); };
  go('A', 'ann', 10001); go('B', 'bo', 10002); go('A', 'ann', 10003); go('C', 'cy', 10004);
  const r = s.submit({ wallet: 'B', name: 'bo', url: 'x.com/a/status/10005' }).clip; s.decide(r.id, 'rejected');
  assert.deepStrictEqual(s.top(), [{ name: 'ann', clips: 2 }, { name: 'cy', clips: 1 }, { name: 'bo', clips: 1 }]);
});

test('the file: written whole, read back, junk ignored and never thrown', () => {
  const file = tmpFile();
  const s = createClipStore({ file, log: quiet });
  const c = s.submit({ wallet: 'A', name: 'ann', url: 'x.com/a/status/12345', caption: 'hi', game: 'agar' }).clip;
  s.setMedia(c.id, { video: 'https://video.twimg.com/amplify_video/1/vid/avc1/720x1280/a.mp4', poster: 'https://pbs.twimg.com/a.jpg', w: 9, h: 16, ms: 20000 });
  s.decide(c.id, 'live');
  assert.ok(!fs.existsSync(file + '.tmp'), 'the temp file was renamed over');
  const back = createClipStore({ file, log: quiet });
  const got = back.live()[0];
  assert.strictEqual(got.caption, 'hi');
  assert.strictEqual(got.vertical, true, 'a 9:16 X video is shown upright');
  assert.strictEqual(got.media.ms, 20000);

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.clips.push({ id: 'nothex', wallet: 'B' }, { ...raw.clips[0], id: 'abcdefabcdefabcd', url: 'https://evil.com/a', vid: '1' },
                 { ...raw.clips[0], id: '0123456789abcdef', media: { video: 'javascript:alert(1)', poster: 'https://evil.com/p.jpg' } });
  fs.writeFileSync(file, JSON.stringify(raw));
  const again = createClipStore({ file, log: quiet });
  assert.strictEqual(again.live().length, 2, 'the two bad records are dropped');
  assert.strictEqual(again.find('0123456789abcdef').media, null, 'media from anywhere but X\'s own hosts is dropped');
  fs.writeFileSync(file, '{oops');
  assert.strictEqual(createClipStore({ file, log: quiet }).live().length, 0);
  assert.strictEqual(createClipStore({ file: path.join(path.dirname(file), 'none.json'), log: quiet }).live().length, 0);
});

test('X media: the sharpest mp4 up to 1280 wide from X\'s own hosts, null on anything odd', async () => {
  const body = { mediaDetails: [{ type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg',
    video_info: { aspect_ratio: [16, 9], duration_millis: 24000, variants: [
      { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/a.m3u8' },
      { content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/480x270/a.mp4?tag=12' },
      { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/b.mp4?tag=12' },
      { content_type: 'video/mp4', bitrate: 10368000, url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/1920x1080/c.mp4?tag=12' },
      { content_type: 'video/mp4', bitrate: 99999999, url: 'https://evil.com/vid/640x360/d.mp4' },
    ] } }] };
  let asked = '';
  const ok = (j) => async (u) => { asked = u; return { ok: true, json: async () => j }; };
  const m = await resolveXMedia('1847123456789012345', { fetchImpl: ok(body) });
  assert.match(asked, /^https:\/\/cdn\.syndication\.twimg\.com\/tweet-result\?id=1847123456789012345&lang=en&token=[a-z0-9]+$/);
  assert.deepStrictEqual(m, { video: 'https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/b.mp4',
    poster: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg', w: 16, h: 9, ms: 24000 });
  assert.strictEqual(await resolveXMedia('123456', { fetchImpl: ok({ mediaDetails: [{ type: 'photo' }] }) }), null, 'no video');
  assert.strictEqual(await resolveXMedia('123456', { fetchImpl: async () => ({ ok: false }) }), null, '404');
  assert.strictEqual(await resolveXMedia('123456', { fetchImpl: async () => { throw new Error('down'); } }), null, 'offline');
  assert.strictEqual(await resolveXMedia('12; rm', { fetchImpl: ok(body) }), null, 'a bad id never reaches the network');
});

/* ── the routes, through a real express app and real signatures ─────────── */
const keyPair = () => { const priv = ed25519.utils.randomPrivateKey(); return { priv, wallet: bs58.encode(ed25519.getPublicKey(priv)) }; };
const sign = (k, action, args, ts = Date.now()) => ({
  action, args, wallet: k.wallet, ts,
  sig: bs58.encode(ed25519.sign(new TextEncoder().encode(ownerAuth.actionMessage(action, args, k.wallet, ts)), k.priv)),
});

async function server(opts = {}) {
  const owner = keyPair();
  const store = createClipStore({ file: tmpFile(), log: quiet });
  const app = express();
  app.use(express.json());
  const audits = [];
  mountClipRoutes(app, {
    store, isOwner: (w) => w === owner.wallet, walletForAction: ownerAuth.walletForAction,
    nameOf: async () => 'nightcoil', resolveX: opts.resolveX || (async () => null),
    audit: (...a) => audits.push(a), log: quiet,
  });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() }));
  const get = (p) => fetch(base + p).then(async r => ({ status: r.status, body: await r.json() }));
  return { owner, store, srv, post, get, audits };
}

test('routes: a player sends a clip, only the owner sees and decides it, then the wall shows it', async () => {
  let resolved = 0;
  const { owner, srv, post, get, audits } = await server({ resolveX: async () => { resolved++;
    return { video: 'https://video.twimg.com/a/vid/1280x720/a.mp4', poster: 'https://pbs.twimg.com/a.jpg', w: 16, h: 9, ms: 9000 }; } });
  try {
    const player = keyPair();
    const args = { url: 'https://x.com/nc/status/1847000000000000001', caption: 'three snakes', game: 'slither' };
    const sent = await post('/api/clips/submit', sign(player, 'clip:submit', args));
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    assert.strictEqual(sent.body.clip.name, 'nightcoil', 'the name is the server\'s, not the client\'s');
    assert.ok(!('wallet' in sent.body.clip));

    // A signature over different arguments, a replayed one, and another action's do not pass.
    assert.strictEqual((await post('/api/clips/submit', { ...sign(player, 'clip:submit', args), args: { ...args, url: 'x.com/a/status/99999' } })).status, 401);
    const once = sign(player, 'clip:submit', { url: 'x.com/a/status/77777', caption: '', game: 'agar' });
    await post('/api/clips/submit', once);
    assert.strictEqual((await post('/api/clips/submit', once)).status, 401, 'a signature is spent once');
    assert.strictEqual((await post('/api/clips/submit', sign(player, 'clips:queue', args))).status, 401);

    let wall = await get('/api/clips');
    assert.deepStrictEqual(wall.body.clips, []);
    assert.strictEqual(wall.body.waiting, 1);

    assert.deepStrictEqual((await post('/api/clips/queue', sign(player, 'clips:queue', {}))).body, { owner: false });
    const q = await post('/api/clips/queue', sign(owner, 'clips:queue', {}));
    assert.strictEqual(q.body.owner, true);
    assert.strictEqual(q.body.waiting.length, 1);
    assert.strictEqual(q.body.waiting[0].wallet, player.wallet, 'the owner sees who sent it');
    assert.ok(q.body.waiting[0].media, 'the X video was looked up after the answer went out');
    const id = q.body.waiting[0].id;

    assert.strictEqual((await post('/api/clips/decide', sign(player, 'clip:decide', { id, verdict: 'live' }))).status, 403, 'a player cannot approve');
    const d = await post('/api/clips/decide', sign(owner, 'clip:decide', { id, verdict: 'live' }));
    assert.strictEqual(d.status, 200, JSON.stringify(d.body));
    assert.strictEqual(d.body.waiting.length, 0);
    assert.strictEqual(audits.length, 1);

    wall = await get('/api/clips');
    assert.strictEqual(wall.body.clips.length, 1);
    assert.strictEqual(wall.body.clips[0].media.video, 'https://video.twimg.com/a/vid/1280x720/a.mp4');
    assert.deepStrictEqual(wall.body.top, [{ name: 'nightcoil', clips: 1 }]);
    assert.strictEqual(resolved, 1, 'looked up once, not again at approval');
    assert.strictEqual((await post('/api/clips/decide', sign(owner, 'clip:decide', { id, verdict: 'live' }))).status, 409);
    assert.strictEqual((await post('/api/clips/decide', sign(owner, 'clip:decide', { id, verdict: 'removed' }))).status, 200);
    assert.strictEqual((await get('/api/clips')).body.clips.length, 0);
  } finally { srv.close(); }
});

test('routes: a refused link says why, and a junk body is a 401, never a crash', async () => {
  const { srv, post } = await server();
  try {
    const p = keyPair();
    const r = await post('/api/clips/submit', sign(p, 'clip:submit', { url: 'https://vm.tiktok.com/ZM123/', caption: '', game: 'slither' }));
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /x\.com\/you\/status/);
    for (const junk of [{}, { action: 'clip:submit' }, { action: 'clip:submit', wallet: { toString: 1 }, sig: [], ts: 'x' }]) {
      assert.strictEqual((await post('/api/clips/submit', junk)).status, 401);
      assert.strictEqual((await post('/api/clips/decide', { ...junk, action: 'clip:decide' })).status, 403);
    }
  } finally { srv.close(); }
});
