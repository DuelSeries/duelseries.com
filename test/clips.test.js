'use strict';
/* The Clips tab's server half (server/clips.js): which links are clips, the review rules, the file it keeps, and the
   four routes end to end with real wallet signatures. */
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
  const owner = opts.owner || keyPair();
  const store = createClipStore({ file: tmpFile(), log: quiet });
  const app = express();
  app.set('trust proxy', 'loopback');      // as behind nginx: post(..., ip) is the player's address
  app.use(express.json());
  const audits = [];
  mountClipRoutes(app, {
    store, isOwner: (w) => w === owner.wallet, walletForAction: ownerAuth.walletForAction,
    nameOf: async () => 'nightcoil', resolveX: opts.resolveX || (async () => null),
    audit: (...a) => audits.push(a), log: quiet, submitLimiter: opts.submitLimiter || null,
  });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const post = (p, body, ip, headers) => fetch(base + p, { method: 'POST', body: JSON.stringify(body),
    headers: Object.assign({ 'content-type': 'application/json' }, ip ? { 'x-forwarded-for': ip } : {}, headers || {}) })
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

/* ── fresh wallets from one address (night review 2026-10-29) ──────────────
   Any keypair made on the spot passes the signature, so the per-wallet caps stopped nobody who wanted to fill
   WAIT_MAX (300 waiting) and lock every player out. One address now holds at most SRC_OPEN_MAX open clips. */
test('one address: fresh wallets cannot fill the queue; other addresses and the owner are untouched', () => {
  let t = 1_000_000;
  const file = tmpFile();
  const s = createClipStore({ file, log: quiet, now: () => t++ });
  const a = s.source('198.51.100.7'), b = s.source('198.51.100.8');
  assert.match(a, /^[a-f0-9]{16}$/);
  assert.notStrictEqual(a, b);
  assert.strictEqual(s.source('::ffff:198.51.100.7'), a, 'an IPv4 address written as IPv6 is the same address');
  assert.strictEqual(s.source('2001:db8:1:2::1'), s.source('2001:db8:1:3::99'), 'IPv6 by its /56, as the limiters count');
  assert.strictEqual(s.source(''), '');
  assert.strictEqual(clips.SRC_OPEN_MAX, 1 + clips.UP_OPEN_MAX, 'one player\'s own most: one link and their uploads');

  // The finding's script: 300 links from 300 fresh wallets, one address.
  let ok = 0, last;
  for (let i = 0; i < clips.WAIT_MAX; i++) {
    last = s.submit({ wallet: 'spam' + i, name: 'x', url: 'https://x.com/a/status/' + (100000 + i), game: 'other', src: a });
    if (last.ok) ok++;
  }
  assert.strictEqual(ok, clips.SRC_OPEN_MAX);
  assert.match(last.error, /from here/);
  assert.match(s.startUpload({ wallet: 'spamU', name: 'x', size: 70000, psize: 0, game: 'other', src: a }).error, /from here/,
    'links and uploads share the one count');

  // An honest player elsewhere still sends a link and shares a clip.
  assert.ok(s.submit({ wallet: 'honest', name: 'h', url: 'x.com/h/status/555555', game: 'slither', src: b }).ok);
  assert.ok(s.startUpload({ wallet: 'honest', name: 'h', size: 70000, psize: 0, game: 'slither', src: b }).ok);
  // So does one with no address (the owner's own: the route passes none for an owner wallet).
  assert.ok(s.submit({ wallet: 'owner', name: 'o', url: 'x.com/o/status/666666', game: 'other', src: '' }).ok);
  assert.ok(s.submit({ wallet: 'junk', name: 'j', url: 'x.com/j/status/777777', game: 'other', src: 'not-a-hash' }).ok,
    'a malformed source is no source');

  // The cap follows the owner's decisions: one turned down frees a place for that address.
  const first = s.waiting().find(c => c.wallet === 'spam0');
  assert.ok(s.decide(first.id, 'rejected').ok);
  assert.ok(s.submit({ wallet: 'spamNext', name: 'x', url: 'x.com/a/status/999999', game: 'other', src: a }).ok);
  assert.match(s.submit({ wallet: 'spamMore', name: 'x', url: 'x.com/a/status/999998', game: 'other', src: a }).error, /from here/);

  // It survives a restart, and the address hash is never shown to anyone.
  const back = createClipStore({ file, log: quiet, now: () => t++ });
  assert.strictEqual(back.source('198.51.100.7'), a, 'the hash key is kept beside the clips file');
  assert.match(back.submit({ wallet: 'spamAfter', name: 'x', url: 'x.com/a/status/999997', game: 'other', src: a }).error, /from here/);
  const c = back.waiting()[0];
  assert.strictEqual(c.src, a);
  for (const view of [clips.publicClip(c, ''), clips.ownerClip(c, '')]) assert.ok(!('src' in view), JSON.stringify(view));
});

/* The address hash is keyed with a secret of the store's own (night review 2026-10-29): a bare sha256 of an IPv4
   address is undone by trying all 2^32 of them, so a leaked clips file would have given every sender's address. */
test('one address: the hash is keyed with a secret kept beside the clips file, never a bare hash of the address', () => {
  const file = tmpFile();
  const s = createClipStore({ file, log: quiet });
  const a = s.source('198.51.100.7');
  const keyFile = path.join(path.dirname(file), 'clips-src.key');
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.strictEqual(a, clips.sourceOf('198.51.100.7', key));
  for (const bare of [crypto.createHash('sha256').update('198.51.100.7').digest('hex'),
                      crypto.createHash('sha256').update('clip-src:198.51.100.7').digest('hex')]) {
    assert.notStrictEqual(a, bare.slice(0, 16), 'not something anyone can work out from the address alone');
  }
  assert.notStrictEqual(createClipStore({ file: tmpFile(), log: quiet }).source('198.51.100.7'), a, 'another box, another key');
  assert.strictEqual(clips.sourceOf('198.51.100.7'), '', 'no key, no hash');
  // A store that cannot save its key still works for this run.
  const ro = createClipStore({ file: tmpFile(), log: quiet, fsx: Object.assign({}, fs, {
    writeFileSync: () => { throw new Error('read-only'); } }) });
  assert.match(ro.source('198.51.100.7'), /^[a-f0-9]{16}$/);
  assert.strictEqual(ro.source('198.51.100.7'), ro.source('198.51.100.7'));
});

test('routes: fresh wallets from one address are capped there, the owner still sends and decides, the daily limiter counts', async () => {
  const { owner, srv, post, get } = await server();
  const sendVia = (post) => (k, id, ip) => post('/api/clips/submit', sign(k, 'clip:submit', { url: 'x.com/a/status/' + id, caption: '', game: 'other' }), ip);
  const send = sendVia(post);
  try {
    const spam = '198.51.100.7';
    for (let i = 0; i < clips.SRC_OPEN_MAX; i++) assert.strictEqual((await send(keyPair(), 200000 + i, spam)).status, 200, String(i));
    const more = await send(keyPair(), 300000, spam);
    assert.strictEqual(more.status, 400);
    assert.match(more.body.error, /from here/);
    assert.strictEqual((await get('/api/clips')).body.waiting, clips.SRC_OPEN_MAX);

    // A player on another address is not touched; neither is the owner on the spammer's own address.
    assert.strictEqual((await send(keyPair(), 400000, '198.51.100.8')).status, 200);
    assert.strictEqual((await send(owner, 500000, spam)).status, 200, 'the owner\'s own clip is never counted against an address');

    // The owner's queue and decisions work as before; a decision frees the address.
    const q = await post('/api/clips/queue', sign(owner, 'clips:queue', {}), spam);
    assert.strictEqual(q.body.waiting.length, clips.SRC_OPEN_MAX + 2);
    assert.ok(q.body.waiting.every(c => !('src' in c)), 'the address hash stays on the server');
    const id = q.body.waiting[0].id;
    assert.strictEqual((await post('/api/clips/decide', sign(owner, 'clip:decide', { id, verdict: 'rejected' }), spam)).status, 200);
    assert.strictEqual((await send(keyPair(), 600000, spam)).status, 200);
    assert.strictEqual((await send(keyPair(), 700000, spam)).status, 400, 'and it is full again');
  } finally { srv.close(); }

  /* The per-address daily limiter on the link route, with the exact config index.js passes (clipLimiters, night
     review 2026-10-29): 10 a day, refused links do not count, the owner skips it (his own wallet's signature or a
     console session), and claiming his wallet without his key opens nothing. */
  const boss = keyPair();
  const limits = clips.clipLimiters({ isOwner: (w) => w === boss.wallet, ownerSession: (req) => req.get('x-test-owner-session') === 'yes' });
  const lim = await server({ owner: boss, submitLimiter: limits.submitLimiter });
  try {
    const sendL = sendVia(lim.post);
    const ip = '198.51.100.9';
    for (let i = 0; i < 10; i++) {
      const r = await sendL(keyPair(), 800000 + i, ip);
      assert.strictEqual(r.status, 200, String(i));
      assert.ok(lim.store.decide(r.body.clip.id, 'rejected').ok, 'turned down, so the address cap stays out of the way');
      if (i === 0) assert.strictEqual((await sendL(keyPair(), 800000, ip)).status, 400, 'a duplicate is refused and not counted');
    }
    const spent = await sendL(keyPair(), 800100, ip);
    assert.strictEqual(spent.status, 429, 'the address has sent its day\'s links');
    assert.deepStrictEqual(spent.body, { error: 'That is a lot of clips from here today. Send the next one tomorrow.' });

    const forged = { ...sign(keyPair(), 'clip:submit', { url: 'x.com/a/status/800101', caption: '', game: 'other' }), wallet: boss.wallet };
    assert.strictEqual((await lim.post('/api/clips/submit', forged, ip)).status, 401, 'claiming the owner\'s wallet without his key');
    assert.strictEqual((await sendL(keyPair(), 800102, ip)).status, 429, 'and the address is still spent');

    assert.strictEqual((await sendL(boss, 800103, ip)).status, 200, 'the owner signing with his own wallet skips it');
    assert.strictEqual((await lim.post('/api/clips/submit', sign(keyPair(), 'clip:submit', { url: 'x.com/a/status/800104', caption: '', game: 'other' }),
      ip, { 'x-test-owner-session': 'yes' })).status, 200, 'so does anyone on the owner console\'s session');
    assert.strictEqual((await sendL(keyPair(), 800105, '198.51.100.10')).status, 200, 'another address has its own');
  } finally { lim.srv.close(); }
});
