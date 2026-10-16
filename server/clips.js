'use strict';
// The Clips tab (Owen 2026-10-16, "the same as onlinemoneygames.com/clips"). A player posts a clip on X, YouTube or
// TikTok, pastes the link in the lobby, and once the owner approves it, it shows on the wall. The video itself stays
// on their site and plays from there, so the game server never stores or serves a byte of it: that is the whole
// reason it costs AWS nothing.
//
// Only a logged-in player can send one (the link is signed by their wallet, ownerAuth.walletForAction, the same proof
// the socket identity uses), one waiting clip each, a few a day. Only the owner wallet sees the waiting list and
// decides. Nothing here touches money.
//
// The records live in a small file beside the money journal (server/data/ is gitignored and survives the deploy's
// reset), written whole to a temp file and renamed, like the battle royale podium (slBr/brLastPodium.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GAMES = ['slither', 'agar', 'paper', 'br', 'other'];
const VERDICTS = ['live', 'rejected', 'removed'];
const CAPTION_MAX = 140;
const NAME_MAX = 40;
const WAIT_MAX = 300;        // waiting clips across every player: past this the queue is a flood, not a backlog
const DAY_MAX = 5;           // clips one wallet may send in 24 hours
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MAX = 2000;       // records kept on disk; the oldest refused ones go first
const LIST_MAX = 60;         // clips the wall shows

/* A pasted link, as one of the three sites we play from, or null. Only the shapes below: anything else (a short
   link we would have to follow, a profile, a playlist) is refused with words saying which link to use. The id is
   the only thing the page ever builds a player or a picture from. */
function parseClipUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 300) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch (_) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'x.com' || host === 'twitter.com') {
    if (parts.length >= 3 && /^[A-Za-z0-9_]{1,15}$/.test(parts[0]) && parts[1] === 'status' && /^\d{5,25}$/.test(parts[2])) {
      return { provider: 'x', vid: parts[2], handle: parts[0], vertical: false,
               url: 'https://x.com/' + parts[0] + '/status/' + parts[2] };
    }
    return null;
  }
  const YT = /^[A-Za-z0-9_-]{11}$/;
  if (host === 'youtu.be') {
    return parts[0] && YT.test(parts[0])
      ? { provider: 'youtube', vid: parts[0], handle: '', vertical: false, url: 'https://www.youtube.com/watch?v=' + parts[0] }
      : null;
  }
  if (host === 'youtube.com') {
    if (parts[0] === 'watch') {
      const v = u.searchParams.get('v') || '';
      return YT.test(v) ? { provider: 'youtube', vid: v, handle: '', vertical: false, url: 'https://www.youtube.com/watch?v=' + v } : null;
    }
    if ((parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') && parts[1] && YT.test(parts[1])) {
      const shorts = parts[0] === 'shorts';
      return { provider: 'youtube', vid: parts[1], handle: '', vertical: shorts,
               url: shorts ? 'https://www.youtube.com/shorts/' + parts[1] : 'https://www.youtube.com/watch?v=' + parts[1] };
    }
    return null;
  }
  if (host === 'tiktok.com') {
    const h = (parts[0] || '').replace(/^@/, '');
    if (parts[0] && parts[0][0] === '@' && /^[A-Za-z0-9._]{1,30}$/.test(h) && parts[1] === 'video' && /^\d{8,25}$/.test(parts[2] || '')) {
      return { provider: 'tiktok', vid: parts[2], handle: h, vertical: true,
               url: 'https://www.tiktok.com/@' + h + '/video/' + parts[2] };
    }
    return null;
  }
  return null;
}

/* Words a player typed, safe to keep: control and direction-override characters out (they can flip the text around
   them on the wall), runs of spaces as one, at most CAPTION_MAX. The page sets it as text, never as markup. */
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
          .replace(/\s+/g, ' ').trim().slice(0, max);
}

const HTTPS_TWIMG_VIDEO = /^https:\/\/video\.twimg\.com\/[^\s"'<>]+$/;
const HTTPS_TWIMG_PIC = /^https:\/\/pbs\.twimg\.com\/[^\s"'<>]+$/;

function cleanMedia(m) {
  if (!m || typeof m !== 'object') return null;
  const video = typeof m.video === 'string' && HTTPS_TWIMG_VIDEO.test(m.video) && m.video.length < 600 ? m.video : '';
  const poster = typeof m.poster === 'string' && HTTPS_TWIMG_PIC.test(m.poster) && m.poster.length < 600 ? m.poster : '';
  if (!video && !poster) return null;
  const n = (x) => (Number.isFinite(x) && x > 0 && x < 1e7 ? Math.round(x) : 0);
  return { video, poster, w: n(m.w), h: n(m.h), ms: n(m.ms) };
}

// A record read back from disk, or null when it is not one this file writes.
function cleanRecord(j) {
  if (!j || typeof j !== 'object') return null;
  if (typeof j.id !== 'string' || !/^[a-f0-9]{16}$/.test(j.id)) return null;
  if (typeof j.wallet !== 'string' || !j.wallet || j.wallet.length > 64) return null;
  const link = parseClipUrl(j.url);
  if (!link || link.provider !== j.provider || link.vid !== j.vid) return null;
  if (!GAMES.includes(j.game)) return null;
  if (!['waiting', 'live', 'rejected', 'removed'].includes(j.status)) return null;
  if (!Number.isFinite(j.at)) return null;
  const media = cleanMedia(j.media);
  return {
    id: j.id, wallet: j.wallet, name: cleanText(j.name, NAME_MAX) || 'Player',
    provider: link.provider, vid: link.vid, handle: link.handle, url: link.url,
    vertical: media && media.w && media.h ? media.h > media.w : link.vertical,
    caption: cleanText(j.caption, CAPTION_MAX), game: j.game, status: j.status,
    at: j.at, decidedAt: Number.isFinite(j.decidedAt) ? j.decidedAt : null, media,
  };
}

//   file  the clips file;  fsx  fs (tests);  now  clock (tests)
function createClipStore({ file, fsx = fs, log = console, now = Date.now } = {}) {
  let clips = [];   // newest first

  function load() {
    clips = [];
    let raw;
    try { raw = fsx.readFileSync(file, 'utf8'); } catch (e) {
      if (e && e.code !== 'ENOENT') log.warn('[clips] could not read ' + file + ': ' + e.message);
      return;
    }
    let j;
    try { j = JSON.parse(raw); } catch (_) { log.warn('[clips] ' + file + ' is not JSON, starting empty'); return; }
    const list = j && Array.isArray(j.clips) ? j.clips : [];
    for (const r of list) { const c = cleanRecord(r); if (c) clips.push(c); }
    clips.sort((a, b) => b.at - a.at);
  }

  function save() {
    try {
      fsx.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fsx.writeFileSync(tmp, JSON.stringify({ clips }) + '\n');
      fsx.renameSync(tmp, file);
      return true;
    } catch (e) {
      log.warn('[clips] could not save ' + file + ': ' + e.message);
      return false;
    }
  }

  function prune() {
    if (clips.length <= KEEP_MAX) return;
    // Refused ones go first, oldest first; only then the oldest of the rest.
    for (let i = clips.length - 1; i >= 0 && clips.length > KEEP_MAX; i--) {
      if (clips[i].status === 'rejected' || clips[i].status === 'removed') clips.splice(i, 1);
    }
    if (clips.length > KEEP_MAX) clips.length = KEEP_MAX;
  }

  function submit({ wallet, name, url, caption, game }) {
    if (typeof wallet !== 'string' || !wallet) return { error: 'Log in to send a clip.' };
    const link = parseClipUrl(url);
    if (!link) return { error: 'Paste the link to your post on X, YouTube or TikTok, like x.com/you/status/123.' };
    const g = GAMES.includes(game) ? game : 'other';
    const t = now();
    const same = clips.find(c => c.provider === link.provider && c.vid === link.vid);
    if (same && same.status === 'live') return { error: 'That clip is already on the wall.' };
    if (same && same.status === 'waiting') return { error: 'That clip is already waiting to be reviewed.' };
    if (same) return { error: 'That clip was already reviewed and is not going on the wall.' };
    const mine = clips.filter(c => c.wallet === wallet);
    if (mine.some(c => c.status === 'waiting')) {
      return { error: 'You already have a clip waiting. Send the next one once it has been reviewed.' };
    }
    if (mine.filter(c => t - c.at < DAY_MS).length >= DAY_MAX) {
      return { error: 'That is ' + DAY_MAX + ' clips today. Send the next one tomorrow.' };
    }
    if (clips.filter(c => c.status === 'waiting').length >= WAIT_MAX) {
      return { error: 'Too many clips are waiting right now. Try again later.' };
    }
    const clip = {
      id: crypto.randomBytes(8).toString('hex'), wallet,
      name: cleanText(name, NAME_MAX) || 'Player',
      provider: link.provider, vid: link.vid, handle: link.handle, url: link.url, vertical: link.vertical,
      caption: cleanText(caption, CAPTION_MAX), game: g, status: 'waiting',
      at: t, decidedAt: null, media: null,
    };
    clips.unshift(clip);
    prune();
    save();
    return { ok: true, clip };
  }

  function setMedia(id, media) {
    const c = clips.find(x => x.id === id);
    const m = cleanMedia(media);
    if (!c || !m) return false;
    c.media = m;
    if (m.w && m.h) c.vertical = m.h > m.w;
    save();
    return true;
  }

  /* The owner's call on one clip: 'live' puts a waiting clip on the wall, 'rejected' turns a waiting one down,
     'removed' takes a live one off the wall again. */
  function decide(id, verdict) {
    if (!VERDICTS.includes(verdict)) return { error: 'Unknown verdict' };
    const c = clips.find(x => x.id === id);
    if (!c) return { error: 'No such clip' };
    if (verdict === 'removed' ? c.status !== 'live' : c.status !== 'waiting') {
      return { error: 'That clip was already ' + (c.status === 'live' ? 'approved' : c.status) };
    }
    c.status = verdict;
    c.decidedAt = now();
    save();
    return { ok: true, clip: c };
  }

  // Approved clips, newest approval first: a clip goes to the top of the wall the moment it goes live.
  const live = (limit = LIST_MAX) => clips.filter(c => c.status === 'live')
    .sort((a, b) => (b.decidedAt || b.at) - (a.decidedAt || a.at)).slice(0, limit);
  const waiting = () => clips.filter(c => c.status === 'waiting').slice().sort((a, b) => a.at - b.at);  // oldest first: fair
  const find = (id) => clips.find(c => c.id === id) || null;

  // Players by clips on the wall; a tie goes to whoever got one approved most recently.
  function top(limit = 10) {
    const by = new Map();
    for (const c of clips) {
      if (c.status !== 'live') continue;
      const e = by.get(c.wallet) || { name: c.name, clips: 0, last: 0 };
      e.clips++;
      const when = c.decidedAt || c.at;
      if (when > e.last) { e.last = when; e.name = c.name; }
      by.set(c.wallet, e);
    }
    return [...by.values()].sort((a, b) => b.clips - a.clips || b.last - a.last)
      .slice(0, limit).map(e => ({ name: e.name, clips: e.clips }));
  }

  load();
  return { load, submit, setMedia, decide, live, waiting, top, find, file,
           waitingCount: () => clips.filter(c => c.status === 'waiting').length };
}

// What the wall shows of a clip. No wallet: the wall is public.
function publicClip(c) {
  return { id: c.id, name: c.name, provider: c.provider, vid: c.vid, handle: c.handle, url: c.url,
           vertical: c.vertical, caption: c.caption, game: c.game, at: c.at, media: c.media };
}
// The owner's view adds who sent it.
function ownerClip(c) {
  return Object.assign(publicClip(c), { wallet: c.wallet, status: c.status });
}

/* The video and poster of an X post, from the same public endpoint X's own embeds read (cdn.syndication.twimg.com,
   which takes a token derived from the id). Best effort: an X post with no video, a deleted post or a changed
   endpoint gives null, and the wall shows that clip as a card that opens the post on X instead. */
function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}
async function resolveXMedia(id, { fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  if (typeof fetchImpl !== 'function' || !/^\d{5,25}$/.test(String(id))) return null;
  const url = 'https://cdn.syndication.twimg.com/tweet-result?id=' + id + '&lang=en&token=' + syndicationToken(id);
  let j;
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r || !r.ok) return null;
    j = await r.json();
  } catch (_) { return null; }
  const list = j && Array.isArray(j.mediaDetails) ? j.mediaDetails : [];
  const md = list.find(m => m && (m.type === 'video' || m.type === 'animated_gif') && m.video_info);
  if (!md) return null;
  const vi = md.video_info;
  const mp4 = (Array.isArray(vi.variants) ? vi.variants : [])
    .filter(v => v && v.content_type === 'video/mp4' && typeof v.url === 'string' && HTTPS_TWIMG_VIDEO.test(v.url));
  const width = (v) => { const m = /\/(\d+)x(\d+)\//.exec(v.url); return m ? Number(m[1]) : 0; };
  // The sharpest one no wider than 1280: a 1080p file is twice the bytes for a card this size.
  mp4.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const pick = mp4.find(v => width(v) && width(v) <= 1280) || mp4[0];
  const ar = Array.isArray(vi.aspect_ratio) ? vi.aspect_ratio : [];
  return cleanMedia({
    video: pick ? pick.url.replace(/\?tag=\d+$/, '') : '',
    poster: md.media_url_https,
    w: Number(ar[0]) || 0, h: Number(ar[1]) || 0,
    ms: Number(vi.duration_millis) || 0,
  });
}

/* The four routes. GET is the wall (and the waiting count, so the owner's lobby can say a new one came in without
   signing anything); the three POSTs each carry a wallet signature over their own action name and arguments.

     store            createClipStore()
     isOwner(wallet)  true for an owner wallet
     walletForAction  ownerAuth.walletForAction
     nameOf(wallet)   -> the player's display name (or '')
     limiter          express rate limiter for the POSTs
     readLimiter      express rate limiter for the wall's GET
     resolveX(id)     -> media or null (resolveXMedia)
     audit            ownerAuth.audit */
function mountClipRoutes(app, { store, isOwner, walletForAction, nameOf, limiter, readLimiter, resolveX = resolveXMedia,
                                audit = () => {}, log = console }) {
  const pass = (req, res, next) => next();
  const lim = limiter || pass;
  const signed = (req, action) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || b.action !== action) return null;
    return walletForAction(b);
  };
  const fetchMedia = (clip) => {
    if (clip.provider !== 'x' || clip.media) return Promise.resolve(false);
    return Promise.resolve(resolveX(clip.vid)).then(m => (m ? store.setMedia(clip.id, m) : false))
      .catch(e => { log.warn('[clips] X media for ' + clip.vid + ': ' + (e && e.message)); return false; });
  };

  app.get('/api/clips', readLimiter || pass, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ clips: store.live().map(publicClip), top: store.top(10), waiting: store.waitingCount() });
  });

  app.post('/api/clips/submit', lim, async (req, res) => {
    const wallet = signed(req, 'clip:submit');
    if (!wallet) return res.status(401).json({ error: 'Log in again to send a clip.' });
    const a = (req.body.args && typeof req.body.args === 'object') ? req.body.args : {};
    let name = '';
    try { name = (await nameOf(wallet)) || ''; } catch (_) { name = ''; }
    const r = store.submit({ wallet, name, url: a.url, caption: a.caption, game: a.game });
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ ok: true, clip: publicClip(r.clip) });
    fetchMedia(r.clip);       // after the answer: the player is not kept waiting on X
  });

  app.post('/api/clips/queue', lim, (req, res) => {
    const wallet = signed(req, 'clips:queue');
    if (!wallet) return res.status(401).json({ error: 'Could not check your wallet. Try again.' });
    if (!isOwner(wallet)) return res.json({ owner: false });
    res.json({ owner: true, waiting: store.waiting().map(ownerClip) });
  });

  app.post('/api/clips/decide', lim, async (req, res) => {
    const wallet = signed(req, 'clip:decide');
    if (!wallet || !isOwner(wallet)) return res.status(403).json({ error: 'Not an owner' });
    const a = (req.body.args && typeof req.body.args === 'object') ? req.body.args : {};
    const id = typeof a.id === 'string' ? a.id : '';
    const verdict = typeof a.verdict === 'string' ? a.verdict : '';
    const clip = store.find(id);
    // One more try at an X clip's video before it goes up, so the wall gets a player rather than a link.
    if (clip && verdict === 'live') await fetchMedia(clip);
    const r = store.decide(id, verdict);
    audit('clip:decide', { id, verdict }, wallet, !r.error, r.error);
    if (r.error) return res.status(409).json({ error: r.error });
    res.json({ ok: true, clip: ownerClip(r.clip), waiting: store.waiting().map(ownerClip) });
  });
}

module.exports = { parseClipUrl, cleanText, createClipStore, publicClip, ownerClip, resolveXMedia,
                   syndicationToken, mountClipRoutes, GAMES, CAPTION_MAX, DAY_MAX, WAIT_MAX };
