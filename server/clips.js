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
// A player can also share a clip they recorded in a game (public/js/clip/clipRec.js, P) straight to DuelSeries
// (Owen 2026-10-16, "using AWS is fine"). The browser uploads it to a private S3 bucket with a short-lived link from
// here, so the video never passes through this box; it is checked (server/mp4check.js) before the owner sees it, and
// only an approved one is copied to where CloudFront serves it. Those are provider 'upload'.
//
// The records live in a small file beside the money journal (server/data/ is gitignored and survives the deploy's
// reset), written whole to a temp file and renamed, like the battle royale podium (slBr/brLastPodium.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ipKeyGenerator, rateLimit } = require('express-rate-limit');
const { checkMp4, checkJpeg, Mp4Error } = require('./mp4check');

const GAMES = ['slither', 'agar', 'paper', 'br', 'other'];
const VERDICTS = ['live', 'rejected', 'removed'];
const CAPTION_MAX = 140;
const NAME_MAX = 40;
const WAIT_MAX = 300;        // waiting clips across every player: past this the queue is a flood, not a backlog
const DAY_MAX = 5;           // clips one wallet may send in 24 hours
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MAX = 2000;       // records kept on disk; the oldest refused ones go first
const LIST_MAX = 60;         // clips the wall shows

// Uploads (provider 'upload'). Every limit is checked here, never in the page.
const UP_MAX_BYTES = 25 * 1024 * 1024;    // a 30 s clip at the recorder's 1080p bitrate is ~24 MB; it trims to fit
const UP_MAX_SEC = 31.5;                  // the recorder keeps 30 s from a key frame, so up to 31 s
const POSTER_MAX = 400 * 1024;            // the JPEG on the card
const UP_DAY_MAX = 10;                    // uploads one wallet may start in 24 hours (each upload link counts)
const UP_OPEN_MAX = 3;                    // one wallet's uploads still uploading or waiting for review
const UP_MIN_BYTES = 64 * 1024;           // a second of the recorder's video is more than this
const UP_DAY_ALL = 100;                   // uploads all players together may get into the queue in 24 hours: caps the storage bill
const PUT_TTL_S = 300;                    // the longest an upload link works (see putTtl)
const CHECKS_MAX = 3;                     // uploads checked at once; more wait for the sweep
const WAIT_DAYS_MAX = 40;                 // a clip nobody decided on in this long is turned down (ok/ empties at 45 days)
/* Clips from one address still uploading or waiting for review, links and uploads together (night review 2026-10-29).
   Any keypair made on the spot passes the wallet signature, so the per-wallet caps above stop nobody who wants to
   fill WAIT_MAX or UP_DAY_ALL for everyone: this is the cap a fresh wallet cannot reset. It is one player's own most
   (one waiting link plus UP_OPEN_MAX uploads), so a player alone on an address never meets it. */
const SRC_OPEN_MAX = 1 + UP_OPEN_MAX;
/* Uploads from one address that reached the queue (or are still uploading) in 24 hours, deleted ones too (night
   review 2026-10-29). A player's own delete takes their clip out of UP_DAY_ALL, so without this one address could
   share, delete and share again on fresh wallets all day; this keeps any one address to a small share of the day's
   budget, so switching uploads off for everyone takes UP_DAY_ALL / SRC_DAY_MAX addresses, not five. */
const SRC_DAY_MAX = 5;
const SRC_RE = /^[a-f0-9]{16}$/;
/* Where a request came from, as the record keeps it: a short keyed hash of the address the rate limiters count (an
   IPv6 address by its /56, ipKeyGenerator), never the address itself. '' when there is none. Keyed with the store's
   secret (night review 2026-10-29): a bare hash of an IPv4 address is undone by trying all 2^32 of them. */
function sourceOf(ip, key) {
  const k = typeof ip === 'string' && ip ? ipKeyGenerator(ip) : '';
  return k && key ? crypto.createHmac('sha256', key).update(k).digest('hex').slice(0, 16) : '';
}
/* How long the link to upload this many bytes works: a minute, plus the time a slow 1.6 Mbit/s upload needs.
   S3 cannot make a link single-use, and each request against it is billed, so it lives no longer than that;
   it is also signed If-None-Match, so it can write its file once and never replace it. */
const putTtl = (size) => Math.min(PUT_TTL_S, 60 + Math.ceil(size / (200 * 1024)));
const UP_STATUSES = ['uploading', 'waiting', 'live', 'rejected', 'removed', 'failed'];

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
const posInt = (x, max) => (Number.isInteger(x) && x >= 0 && x <= max ? x : -1);
function cleanUpMedia(m) {
  if (!m || typeof m !== 'object') return null;
  const n = (x, max) => (Number.isFinite(x) && x > 0 && x <= max ? Math.round(x) : 0);
  const w = n(m.w, 4096), h = n(m.h, 4096), ms = n(m.ms, UP_MAX_SEC * 1000);
  return w && h ? { w, h, ms } : null;
}
function cleanUpload(j) {
  if (j.vid !== j.id || !UP_STATUSES.includes(j.status) || !GAMES.includes(j.game) || !Number.isFinite(j.at)) return null;
  const size = posInt(j.size, UP_MAX_BYTES), psize = posInt(j.psize, POSTER_MAX);
  if (size < 1 || psize < 0) return null;
  const media = cleanUpMedia(j.media);
  if ((j.status === 'waiting' || j.status === 'live') && !media) return null;
  return {
    id: j.id, wallet: j.wallet, name: cleanText(j.name, NAME_MAX) || 'Player',
    provider: 'upload', vid: j.id, handle: '', url: '', vertical: !!(media && media.h > media.w),
    caption: cleanText(j.caption, CAPTION_MAX), game: j.game, status: j.status,
    at: j.at, decidedAt: Number.isFinite(j.decidedAt) ? j.decidedAt : null, media,
    size, psize, poster: !!j.poster && psize > 0,
    ticket: typeof j.ticket === 'string' && /^[a-f0-9]{64}$/.test(j.ticket) ? j.ticket : '',
    src: typeof j.src === 'string' && SRC_RE.test(j.src) ? j.src : '',
    withdrawn: j.status === 'removed' && j.withdrawn === true,
  };
}

function cleanRecord(j) {
  if (!j || typeof j !== 'object') return null;
  if (typeof j.id !== 'string' || !/^[a-f0-9]{16}$/.test(j.id)) return null;
  if (typeof j.wallet !== 'string' || !j.wallet || j.wallet.length > 64) return null;
  if (j.provider === 'upload') return cleanUpload(j);
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
    src: typeof j.src === 'string' && SRC_RE.test(j.src) ? j.src : '',
    withdrawn: j.status === 'removed' && j.withdrawn === true,
  };
}

//   file  the clips file;  fsx  fs (tests);  now  clock (tests)
function createClipStore({ file, fsx = fs, log = console, now = Date.now } = {}) {
  let clips = [];   // newest first

  /* The secret sourceOf is keyed with (night review 2026-10-29), made the first time a player's address is needed
     and kept beside the clips file (server/data/ survives the deploy), so the per-address caps survive a restart.
     If it cannot be saved it lives in memory, and the caps start over at the next restart. */
  let srcKey = '';
  function sourceKey() {
    if (srcKey) return srcKey;
    const kf = file ? path.join(path.dirname(file), path.basename(file, '.json') + '-src.key') : '';
    if (kf) {
      try {
        const s = String(fsx.readFileSync(kf, 'utf8')).trim();
        if (/^[a-f0-9]{64}$/.test(s)) return (srcKey = s);
      } catch (e) {
        if (e && e.code !== 'ENOENT') log.warn('[clips] could not read ' + kf + ': ' + e.message);
      }
    }
    srcKey = crypto.randomBytes(32).toString('hex');
    if (kf) {
      try {
        fsx.mkdirSync(path.dirname(kf), { recursive: true });
        fsx.writeFileSync(kf, srcKey + '\n', { mode: 0o600 });
      } catch (e) { log.warn('[clips] could not save ' + kf + ': ' + e.message); }
    }
    return srcKey;
  }
  const source = (ip) => sourceOf(ip, sourceKey());

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
      if (clips[i].status === 'rejected' || clips[i].status === 'removed' || clips[i].status === 'failed') clips.splice(i, 1);
    }
    if (clips.length > KEEP_MAX) clips.length = KEEP_MAX;
  }

  // Refused when one address already has SRC_OPEN_MAX clips open; src '' (no address, the owner) is never counted.
  const srcFull = (src) => !!src && clips.filter(c => c.src === src
    && (c.status === 'waiting' || c.status === 'uploading')).length >= SRC_OPEN_MAX;

  //   src  sourceOf(the sender's address), '' for none
  function submit({ wallet, name, url, caption, game, src = '' }) {
    if (typeof src !== 'string' || !SRC_RE.test(src)) src = '';
    if (typeof wallet !== 'string' || !wallet) return { error: 'Log in to send a clip.' };
    const link = parseClipUrl(url);
    if (!link) return { error: 'Paste the link to your post on X, YouTube or TikTok, like x.com/you/status/123.' };
    const g = GAMES.includes(game) ? game : 'other';
    const t = now();
    const same = clips.find(c => c.provider === link.provider && c.vid === link.vid);
    if (same && same.status === 'live') return { error: 'That clip is already on the wall.' };
    if (same && same.status === 'waiting') return { error: 'That clip is already waiting to be reviewed.' };
    if (same) return { error: 'That clip was already reviewed and is not going on the wall.' };
    const mine = clips.filter(c => c.wallet === wallet && c.provider !== 'upload');
    if (mine.some(c => c.status === 'waiting')) {
      return { error: 'You already have a clip waiting. Send the next one once it has been reviewed.' };
    }
    if (mine.filter(c => t - c.at < DAY_MS).length >= DAY_MAX) {
      return { error: 'That is ' + DAY_MAX + ' clips today. Send the next one tomorrow.' };
    }
    if (srcFull(src)) return { error: 'There are already clips from here waiting to be reviewed. Send the next one once they are.' };
    if (clips.filter(c => c.status === 'waiting').length >= WAIT_MAX) {
      return { error: 'Too many clips are waiting right now. Try again later.' };
    }
    const clip = {
      id: crypto.randomBytes(8).toString('hex'), wallet,
      name: cleanText(name, NAME_MAX) || 'Player',
      provider: link.provider, vid: link.vid, handle: link.handle, url: link.url, vertical: link.vertical,
      caption: cleanText(caption, CAPTION_MAX), game: g, status: 'waiting',
      at: t, decidedAt: null, media: null, src,
    };
    clips.unshift(clip);
    prune();
    save();
    return { ok: true, clip };
  }

  /* An upload about to start: the record, and a one-time ticket the page shows back when the bytes are in.
     Only the ticket's hash is kept. size and psize are the exact byte counts S3 will accept. */
  function startUpload({ wallet, name, size, psize, game, caption, src = '' }) {
    if (typeof wallet !== 'string' || !wallet) return { error: 'Log in to share a clip.' };
    if (typeof src !== 'string' || !SRC_RE.test(src)) src = '';
    if (!Number.isInteger(size) || size > UP_MAX_BYTES) return { error: 'That clip is too big to share.' };
    if (size < UP_MIN_BYTES) return { error: 'That file is too small to be a clip.' };
    if (!Number.isInteger(psize) || psize < 0 || psize > POSTER_MAX) return { error: 'That clip is too big to share.' };
    const t = now();
    const ups = clips.filter(c => c.provider === 'upload');
    const mine = ups.filter(c => c.wallet === wallet);
    if (mine.filter(c => t - c.at < DAY_MS).length >= UP_DAY_MAX) {
      return { error: 'That is ' + UP_DAY_MAX + ' clips shared today. Share the next one tomorrow.' };
    }
    if (mine.filter(c => c.status === 'uploading' || c.status === 'waiting').length >= UP_OPEN_MAX) {
      return { error: 'You have ' + UP_OPEN_MAX + ' clips waiting to be reviewed. Share the next one once they are.' };
    }
    if (srcFull(src)) return { error: 'There are already clips from here waiting to be reviewed. Share the next one once they are.' };
    if (src && ups.filter(c => c.src === src && t - c.at < DAY_MS && (c.media || c.status === 'uploading')).length >= SRC_DAY_MAX) {
      return { error: 'That is a lot of clips shared from here today. Share the next one tomorrow.' };
    }
    /* The day's budget for everyone counts uploads that delivered a file that passed the check (media is set only
       then), so starts that never send a byte, or send junk, cannot use it up (night review 2026-10-29). Starts are
       capped per address instead: the route's uploadLimiter, SRC_OPEN_MAX and SRC_DAY_MAX. One the player deleted
       themselves is not counted either: its files are gone, so it costs no storage, and counting it let one address
       share and delete on fresh wallets until uploads were off for everyone. */
    if (ups.filter(c => t - c.at < DAY_MS && c.media && !c.withdrawn).length >= UP_DAY_ALL
        || clips.filter(c => c.status === 'waiting' || c.status === 'uploading').length >= WAIT_MAX) {
      return { error: 'Too many clips are waiting right now. Try again later.' };
    }
    const id = crypto.randomBytes(8).toString('hex');
    const ticket = crypto.randomBytes(24).toString('hex');
    const clip = {
      id, wallet, name: cleanText(name, NAME_MAX) || 'Player',
      provider: 'upload', vid: id, handle: '', url: '', vertical: false,
      caption: cleanText(caption, CAPTION_MAX), game: GAMES.includes(game) ? game : 'other', status: 'uploading',
      at: t, decidedAt: null, media: null, size, psize, poster: false,
      ticket: crypto.createHash('sha256').update(ticket).digest('hex'), src,
    };
    clips.unshift(clip);
    prune();
    save();
    return { ok: true, clip, ticket };
  }
  // The upload whose ticket this is, or null. Constant time: a guessed ticket learns nothing.
  function byTicket(id, ticket) {
    const c = typeof id === 'string' ? clips.find(x => x.id === id && x.provider === 'upload') : null;
    if (!c || !c.ticket || typeof ticket !== 'string' || !/^[a-f0-9]{48}$/.test(ticket)) return null;
    const a = Buffer.from(c.ticket, 'hex');
    const b = crypto.createHash('sha256').update(ticket).digest();
    return crypto.timingSafeEqual(a, b) ? c : null;
  }
  // The checked upload goes to the owner's queue; a bad one is marked and never shown.
  function uploadChecked(id, media, poster) {
    const c = clips.find(x => x.id === id && x.provider === 'upload');
    const m = cleanUpMedia(media);
    if (!c || c.status !== 'uploading' || !m) return false;
    c.media = m; c.vertical = m.h > m.w; c.poster = !!poster && c.psize > 0; c.status = 'waiting';
    save();
    return true;
  }
  function uploadFailed(id) {
    const c = clips.find(x => x.id === id && x.provider === 'upload');
    if (!c || c.status !== 'uploading') return false;
    c.status = 'failed'; c.decidedAt = now();
    save();
    return true;
  }
  // Uploads whose link ran out without the page saying it finished (a closed tab): checked by the sweep.
  const staleUploads = (olderThanMs) => clips.filter(c => c.provider === 'upload' && c.status === 'uploading'
    && now() - c.at > olderThanMs);

  function setMedia(id, media) {
    const c = clips.find(x => x.id === id);
    const m = cleanMedia(media);
    if (!c || !m || c.provider === 'upload') return false;
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

  /* A player's own clips, newest first: waiting, on the wall, or turned down (Owen 2026-10-16: a player can see and
     delete their own clip at any time). */
  const MINE = ['uploading', 'waiting', 'live', 'rejected'];
  const mine = (wallet, limit = 30) => (typeof wallet === 'string' && wallet
    ? clips.filter(c => c.wallet === wallet && MINE.includes(c.status)).slice(0, limit) : []);
  // A player deletes their own clip, whatever its state. Returns what it was, so its files can follow.
  function withdraw(id, wallet) {
    const c = clips.find(x => x.id === id);
    if (!c || !wallet || c.wallet !== wallet || !MINE.includes(c.status)) return { error: 'That clip was not found.' };
    const was = c.status;
    c.status = 'removed';
    c.withdrawn = true;       // the player's own delete, not the owner's: see UP_DAY_ALL in startUpload
    c.decidedAt = now();
    save();
    return { ok: true, clip: c, was };
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
  return { load, submit, setMedia, decide, live, waiting, top, find, file, source,
           startUpload, byTicket, uploadChecked, uploadFailed, staleUploads, mine, withdraw,
           waitingCount: () => clips.filter(c => c.status === 'waiting').length };
}

/* What the wall shows of a clip. No wallet: the wall is public. An approved upload plays from CloudFront (cdn,
   e.g. https://d123.cloudfront.net, whose root is the bucket's live/ folder); its address is built here from the id,
   never stored or taken from a player. */
function publicClip(c, cdn) {
  let media = c.media;
  if (c.provider === 'upload') {
    const base = c.status === 'live' && cdn ? cdn + '/' + c.id : '';
    media = c.media ? { video: base ? base + '.mp4' : '', poster: base && c.poster ? base + '.jpg' : '',
                        w: c.media.w, h: c.media.h, ms: c.media.ms } : null;
  }
  return { id: c.id, name: c.name, provider: c.provider, vid: c.vid, handle: c.handle, url: c.url,
           vertical: c.vertical, caption: c.caption, game: c.game, at: c.at, media };
}
// The owner's view adds who sent it.
function ownerClip(c, cdn) {
  return Object.assign(publicClip(c, cdn), { wallet: c.wallet, status: c.status });
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

/* The two per-address daily limiters index.js hands mountClipRoutes, built here so a test runs the real config
   (night review 2026-10-29). Wallets are free to make, addresses less so. Refused requests do not count. The owner
   skips both: on a live console session (ownerSession(req)), or with his own wallet's signature. The wallet is only
   claimed in the body at this point, but the route then checks the signature against it, so claiming the owner's
   wallet without his key just gets a 401 and no clip.

     isOwner(wallet)    true for an owner wallet
     ownerSession(req)  true on the owner console's session cookie */
function clipLimiters({ isOwner = () => false, ownerSession = () => false } = {}) {
  const skip = (req) => {
    try { if (ownerSession(req)) return true; } catch (_) { /* no session */ }
    const w = req.body && typeof req.body === 'object' ? req.body.wallet : '';
    return typeof w === 'string' && !!w && !!isOwner(w);
  };
  const day = { windowMs: DAY_MS, standardHeaders: true, legacyHeaders: false, skipFailedRequests: true, skip };
  return {
    // Upload links one address may ask for in a day, on top of the per-wallet and per-address caps in the store.
    uploadLimiter: rateLimit({ ...day, max: 20, message: { error: 'That is a lot of clips from here today. Share the next one tomorrow.' } }),
    // Links one address may send in a day: any keypair passes the signature, so DAY_MAX alone let one script fill the queue.
    submitLimiter: rateLimit({ ...day, max: 10, message: { error: 'That is a lot of clips from here today. Send the next one tomorrow.' } }),
  };
}

/* The four routes. GET is the wall (and the waiting count, so the owner's lobby can say a new one came in without
   signing anything); the three POSTs each carry a wallet signature over their own action name and arguments.

     store            createClipStore()
     isOwner(wallet)  true for an owner wallet
     walletForAction  ownerAuth.walletForAction
     nameOf(wallet)   -> the player's display name (or '')
     limiter          express rate limiter for the POSTs
     submitLimiter    express rate limiter for link submits, per address per day (night review 2026-10-29)
     readLimiter      express rate limiter for the wall's GET
     resolveX(id)     -> media or null (resolveXMedia)
     audit            ownerAuth.audit
     uploads          null (sharing from a game is off), or { s3: s3lite.createS3(...), cdn: the CloudFront address
                      whose root is the bucket's live/ folder, invalidate(paths) -> Promise }
     site             the site's address, for the share page's links

   Shared from a game (provider 'upload'), five more:
     POST /api/clips/upload    signed 'clip:upload' { size, psize, game } -> { id, ticket, video, poster }: two upload
                               links, each for exactly that many bytes of that type, for 10 minutes
     POST /api/clips/uploaded  { id, ticket } after the bytes are in: checked, then into the owner's queue
     GET  /clip/:id            the share page of an approved clip (plays, downloads, posts)

   The bucket's folders: inbox/<id>.mp4|.jpg is what the browser uploaded (its link still works for a few
   minutes, so it is never trusted again once read); ok/<id>.mp4|.jpg is the copy that passed the check,
   pinned to the exact bytes read (copy-if-match), which the owner watches and approves; live/<id>.mp4|.jpg is
   an approved clip, the only folder CloudFront can read. inbox/ empties itself after 7 days and ok/ after 45
   (bucket rules). The upload stays in inbox/ after the check: its link can write it only once (If-None-Match), so
   while it is there the link can do nothing more. */
function mountClipRoutes(app, { store, isOwner, walletForAction, walletForMine, nameOf, limiter, readLimiter, resolveX = resolveXMedia,
                                audit = () => {}, log = console, uploads = null, site = 'https://duelseries.com',
                                sweepMs = 5 * 60 * 1000, uploadLimiter = null, submitLimiter = null }) {
  const pass = (req, res, next) => next();
  const lim = limiter || pass;
  const upLim = uploadLimiter || pass;     // per address per day: wallets are free to make, addresses less so
  const subLim = submitLimiter || pass;    // the same for link submits (night review 2026-10-29)
  // The sender's address for the store's per-address cap; the owner's own clips are never counted against one.
  const srcFor = (req, wallet) => (isOwner(wallet) ? '' : store.source(req.ip));
  const signed = (req, action) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || b.action !== action) return null;
    // the player's own list may also be read with a browser wallet's device key (walletForMine); nothing else may
    if (action === 'clips:mine' && typeof walletForMine === 'function') return walletForMine(b);
    return walletForAction(b);
  };
  const fetchMedia = (clip) => {
    if (clip.provider !== 'x' || clip.media) return Promise.resolve(false);
    return Promise.resolve(resolveX(clip.vid)).then(m => (m ? store.setMedia(clip.id, m) : false))
      .catch(e => { log.warn('[clips] X media for ' + clip.vid + ': ' + (e && e.message)); return false; });
  };

  const cdn = uploads ? uploads.cdn : '';
  const pub = (c) => publicClip(c, cdn);
  const keys = (id) => ({
    mp4: 'inbox/' + id + '.mp4', jpg: 'inbox/' + id + '.jpg',
    okMp4: 'ok/' + id + '.mp4', okJpg: 'ok/' + id + '.jpg',
    liveMp4: 'live/' + id + '.mp4', liveJpg: 'live/' + id + '.jpg',
  });
  const quietly = (p) => Promise.resolve(p).catch(e => log.warn('[clips] ' + (e && e.message)));
  // The owner's view. A waiting upload is not public, so it comes with links to watch it that last half an hour.
  const own = (c) => {
    const o = ownerClip(c, cdn);
    if (uploads && c.provider === 'upload' && c.status === 'waiting' && o.media) {
      const k = keys(c.id);
      o.media = Object.assign({}, o.media, {
        video: uploads.s3.presignGet(k.okMp4, { expires: 1800, responseType: 'video/mp4' }),
        poster: c.poster ? uploads.s3.presignGet(k.okJpg, { expires: 1800, responseType: 'image/jpeg' }) : '',
      });
    }
    return o;
  };

  /* Reads an upload back out of S3 and decides. { ok } it waits for the owner; { refused } it is not a clip (marked
     failed, files deleted); { missing } nothing was uploaded; { busy } another check of it is running. Throws when
     S3 could not be read, and the sweep tries again. */
  const checking = new Set();
  async function checkUpload(c) {
    if (checking.has(c.id) || checking.size >= CHECKS_MAX) return { busy: true };
    checking.add(c.id);
    const k = keys(c.id);
    const s3 = uploads.s3;
    const refuse = (why) => {
      log.warn('[clips] upload ' + c.id + ' refused: ' + why);
      store.uploadFailed(c.id);
      quietly(Promise.all([s3.del(k.mp4), s3.del(k.jpg)]));
      return { refused: why };
    };
    try {
      const h = await s3.head(k.mp4);
      if (!h) return { missing: true };
      if (h.size !== c.size) return refuse('not the size that was sent');
      if (h.type !== 'video/mp4') return refuse('not marked as an MP4');
      let media;
      try {
        media = await checkMp4((a, b) => s3.range(k.mp4, a, b, h.etag), h.size, { maxBytes: UP_MAX_BYTES, maxSec: UP_MAX_SEC });
        // Exactly the bytes just read: if the uploader sent another file meanwhile, this copy fails (412).
        await s3.copy(k.mp4, k.okMp4, { contentType: 'video/mp4', ifMatch: h.etag });
      } catch (e) {
        if (e instanceof Mp4Error) return refuse(e.message);
        if (e && e.status === 412) return refuse('the file changed while it was being checked');
        throw e;
      }
      let poster = false;
      if (c.psize) {
        try {
          const p = await s3.head(k.jpg);
          if (p && p.size === c.psize && p.type === 'image/jpeg') {
            await checkJpeg((a, b) => s3.range(k.jpg, a, b, p.etag), p.size, { maxBytes: POSTER_MAX });
            await s3.copy(k.jpg, k.okJpg, { contentType: 'image/jpeg', ifMatch: p.etag });
            poster = true;
          }
        } catch (e) {
          if (!(e instanceof Mp4Error) && !(e && e.status === 412)) throw e;
        }
      }
      store.uploadChecked(c.id, media, poster);
      return { ok: true };
    } finally { checking.delete(c.id); }
  }

  /* Uploads nobody said were finished (a tab closed mid-way): checked once their link has run out, so a clip
     that did arrive still reaches the queue; one that never arrived, or still cannot be read after a day,
     stops counting against the player. */
  if (uploads && sweepMs > 0) {
    const sweep = setInterval(async () => {
      for (const c of store.waiting().filter(x => x.provider === 'upload' && Date.now() - x.at > WAIT_DAYS_MAX * DAY_MS).slice(0, 20)) {
        if (store.decide(c.id, 'rejected').ok) await afterDecide(c, 'rejected');
      }
      for (const c of store.staleUploads((PUT_TTL_S + 120) * 1000).slice(0, 5)) {
        try {
          const r = await checkUpload(c);
          if (r.missing) store.uploadFailed(c.id);
        } catch (e) {
          log.warn('[clips] sweep ' + c.id + ': ' + (e && e.message));
          if (Date.now() - c.at > DAY_MS) store.uploadFailed(c.id);
        }
      }
    }, sweepMs);
    if (sweep.unref) sweep.unref();
  }

  app.get('/api/clips', readLimiter || pass, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ clips: store.live().map(pub), top: store.top(10), waiting: store.waitingCount() });
  });

  app.post('/api/clips/upload', lim, upLim, async (req, res) => {
    const wallet = signed(req, 'clip:upload');
    if (!wallet) return res.status(401).json({ error: 'Log in again to share a clip.' });
    if (!uploads) return res.status(503).json({ error: 'Sharing clips is not switched on yet.' });
    const a = (req.body.args && typeof req.body.args === 'object') ? req.body.args : {};
    let name = '';
    try { name = (await nameOf(wallet)) || ''; } catch (_) { name = ''; }
    const r = store.startUpload({ wallet, name, size: a.size, psize: a.psize || 0, game: a.game, caption: a.caption,
                                  src: srcFor(req, wallet) });
    if (r.error) return res.status(400).json({ error: r.error });
    const k = keys(r.clip.id);
    const s3 = uploads.s3;
    res.json({
      ok: true, id: r.clip.id, ticket: r.ticket,
      video: s3.presignPut(k.mp4, { contentType: 'video/mp4', contentLength: r.clip.size, expires: putTtl(r.clip.size), once: true }),
      poster: r.clip.psize ? s3.presignPut(k.jpg, { contentType: 'image/jpeg', contentLength: r.clip.psize, expires: putTtl(r.clip.psize), once: true }) : null,
    });
  });

  app.post('/api/clips/uploaded', lim, async (req, res) => {
    if (!uploads) return res.status(503).json({ error: 'Sharing clips is not switched on yet.' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const c = store.byTicket(b.id, b.ticket);
    if (!c) return res.status(404).json({ error: 'That upload was not found. Share the clip again.' });
    if (c.status === 'waiting') return res.json({ ok: true, status: 'waiting' });
    if (c.status !== 'uploading') return res.status(409).json({ error: 'That clip was already reviewed.' });
    try {
      const r = await checkUpload(c);
      if (r.ok) return res.json({ ok: true, status: 'waiting' });
      if (r.busy) return res.json({ ok: true, status: 'checking' });
      if (r.missing) return res.status(409).json({ error: 'The clip did not finish uploading. Share it again.' });
      // The reason is the checker's own fixed wording (server/mp4check.js), never anything from the file.
      return res.status(422).json({ error: 'That file cannot be shared: ' + r.refused + '.' });
    } catch (e) {
      log.warn('[clips] check ' + c.id + ': ' + (e && e.message));
      return res.status(502).json({ error: 'Could not check the clip just now. It is checked again in a few minutes.' });
    }
  });

  app.get('/clip/:id', readLimiter || pass, (req, res) => {
    const id = String(req.params.id || '');
    const c = /^[a-f0-9]{16}$/.test(id) ? store.find(id) : null;
    if (!c || c.status !== 'live') return res.redirect(302, '/');
    if (c.provider !== 'upload') return res.redirect(302, c.url);    // a link clip's own post (parseClipUrl's shape)
    if (!cdn) return res.redirect(302, '/');
    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(sharePage(pub(c), site));
  });

  app.post('/api/clips/submit', lim, subLim, async (req, res) => {
    const wallet = signed(req, 'clip:submit');
    if (!wallet) return res.status(401).json({ error: 'Log in again to send a clip.' });
    const a = (req.body.args && typeof req.body.args === 'object') ? req.body.args : {};
    let name = '';
    try { name = (await nameOf(wallet)) || ''; } catch (_) { name = ''; }
    const r = store.submit({ wallet, name, url: a.url, caption: a.caption, game: a.game, src: srcFor(req, wallet) });
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ ok: true, clip: pub(r.clip) });
    fetchMedia(r.clip);       // after the answer: the player is not kept waiting on X
  });

  app.post('/api/clips/queue', lim, (req, res) => {
    const wallet = signed(req, 'clips:queue');
    if (!wallet) return res.status(401).json({ error: 'Could not check your wallet. Try again.' });
    if (!isOwner(wallet)) return res.json({ owner: false });
    res.json({ owner: true, waiting: store.waiting().map(own) });
  });

  /* An upload's files follow the owner's call: approved, the checked copy goes to live/ (the only folder CloudFront
     reads) with its type, caching and file name set here; rejected, it is deleted; taken down, the live copy is
     deleted and CloudFront told to forget it. The copy happens BEFORE the record changes, so a failed copy leaves
     the clip waiting instead of on the wall with nothing to play. */
  const deciding = new Set();
  async function filesFor(c, verdict) {
    if (!uploads || c.provider !== 'upload') return;
    const k = keys(c.id);
    const s3 = uploads.s3;
    if (verdict === 'live') {
      const cache = 'public, max-age=604800';
      await s3.copy(k.okMp4, k.liveMp4, { contentType: 'video/mp4', cacheControl: cache,
        disposition: 'attachment; filename="duelseries-clip-' + c.id + '.mp4"' });
      if (c.poster) await s3.copy(k.okJpg, k.liveJpg, { contentType: 'image/jpeg', cacheControl: cache });
    }
  }
  async function afterDecide(c, verdict) {
    if (!uploads || c.provider !== 'upload') return;
    const k = keys(c.id);
    const s3 = uploads.s3;
    if (verdict === 'live' || verdict === 'rejected') {
      await quietly(Promise.all([s3.del(k.okMp4), s3.del(k.okJpg), s3.del(k.mp4), s3.del(k.jpg)]));
    } else if (verdict === 'removed') {
      await quietly(Promise.all([s3.del(k.liveMp4), s3.del(k.liveJpg)]));
      await quietly(uploads.invalidate(['/' + c.id + '.mp4', '/' + c.id + '.jpg']));
    }
  }

  /* A player's own clips and deleting one (Owen 2026-10-16: "a player can delete their own clip at any time,
     pending or approved"). Only the wallet that sent a clip can delete it; its files go with it. */
  // A player's view of their own clip: CloudFront addresses once it is live, and no S3 links ever (an S3 download
  // is billed per GB and a link can be replayed; only the owner gets those, to review).
  const mineView = (c) => {
    const o = ownerClip(c, cdn);
    delete o.wallet;
    return o;
  };
  app.post('/api/clips/mine', lim, (req, res) => {
    const wallet = signed(req, 'clips:mine');
    if (!wallet) return res.status(401).json({ error: 'Log in again to see your clips.' });
    res.json({ clips: store.mine(wallet).map(mineView) });
  });
  app.post('/api/clips/delete', lim, async (req, res) => {
    const wallet = signed(req, 'clip:delete');
    if (!wallet) return res.status(401).json({ error: 'Log in again to delete a clip.' });
    const a = (req.body.args && typeof req.body.args === 'object') ? req.body.args : {};
    const id = typeof a.id === 'string' ? a.id : '';
    if (deciding.has(id)) return res.status(409).json({ error: 'That clip is being saved. Try again in a moment.' });
    const r = store.withdraw(id, wallet);
    if (r.error) return res.status(404).json({ error: r.error });
    log.log('[clips] ' + id + ' deleted by its player (was ' + r.was + ')');
    if (uploads && r.clip.provider === 'upload') {
      const k = keys(id);
      const s3 = uploads.s3;
      if (r.was === 'uploading') await quietly(Promise.all([s3.del(k.mp4), s3.del(k.jpg)]));
      else if (r.was === 'waiting') await quietly(Promise.all([s3.del(k.okMp4), s3.del(k.okJpg), s3.del(k.mp4), s3.del(k.jpg)]));
      else if (r.was === 'live') {
        await quietly(Promise.all([s3.del(k.liveMp4), s3.del(k.liveJpg)]));
        await quietly(uploads.invalidate(['/' + id + '.mp4', '/' + id + '.jpg']));
      }
    }
    res.json({ ok: true, clips: store.mine(wallet).map(mineView) });
  });

  app.post('/api/clips/decide', lim, async (req, res) => {
    const wallet = signed(req, 'clip:decide');
    if (!wallet || !isOwner(wallet)) return res.status(403).json({ error: 'Not an owner' });
    const a = (req.body.args && typeof req.body.args === 'object') ? req.body.args : {};
    const id = typeof a.id === 'string' ? a.id : '';
    const verdict = typeof a.verdict === 'string' ? a.verdict : '';
    const clip = store.find(id);
    if (clip && deciding.has(clip.id)) return res.status(409).json({ error: 'That clip is being saved. Give it a moment.' });
    if (clip) deciding.add(clip.id);
    try {
      // One more try at an X clip's video before it goes up, so the wall gets a player rather than a link.
      if (clip && verdict === 'live') await fetchMedia(clip);
      if (clip && verdict === 'live' && clip.status === 'waiting') {
        try { await filesFor(clip, verdict); } catch (e) {
          log.warn('[clips] publish ' + clip.id + ': ' + (e && e.message));
          audit('clip:decide', { id, verdict }, wallet, false, 'copy failed');
          return res.status(502).json({ error: 'Could not publish the video just now. Try again.' });
        }
      }
      const r = store.decide(id, verdict);
      audit('clip:decide', { id, verdict }, wallet, !r.error, r.error);
      if (r.error) return res.status(409).json({ error: r.error });
      await afterDecide(r.clip, verdict);
      res.json({ ok: true, clip: own(r.clip), waiting: store.waiting().map(own) });
    } finally { if (clip) deciding.delete(clip.id); }
  });
}

/* ── The share page of an approved upload: /clip/<id> ─────────────────────────
   What a shared link opens, on a phone or a PC: the clip, Download, Copy link, Post on X, and a way into the
   game. Built on the server so X and Discord can read its preview tags. Every value in it is the server's own
   (a hex id, the CloudFront address) or a player's name or caption, and those are escaped for HTML. */
const GAME_NAMES = { slither: 'slither.io', agar: 'agar.io', paper: 'Paper.io', br: 'battle royale', other: 'DuelSeries' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function sharePage(p, site) {
  const page = site + '/clip/' + p.id;
  const m = p.media || {};
  const what = (GAME_NAMES[p.game] || 'DuelSeries') + ' clip by ' + p.name;
  const title = p.caption || what;
  const tall = m.h > m.w;
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + ' | DuelSeries</title>'
    + '<meta name="description" content="' + esc(what + ' on DuelSeries') + '">'
    + '<link rel="canonical" href="' + esc(page) + '">'
    + '<meta property="og:site_name" content="DuelSeries">'
    + '<meta property="og:type" content="video.other">'
    + '<meta property="og:title" content="' + esc(title) + '">'
    + '<meta property="og:description" content="' + esc(what + ' on DuelSeries') + '">'
    + '<meta property="og:url" content="' + esc(page) + '">'
    + (m.poster ? '<meta property="og:image" content="' + esc(m.poster) + '">' : '')
    + '<meta property="og:video" content="' + esc(m.video) + '">'
    + '<meta property="og:video:secure_url" content="' + esc(m.video) + '">'
    + '<meta property="og:video:type" content="video/mp4">'
    + '<meta property="og:video:width" content="' + (m.w | 0) + '"><meta property="og:video:height" content="' + (m.h | 0) + '">'
    + '<meta name="twitter:card" content="summary_large_image">'
    + '<meta name="twitter:title" content="' + esc(title) + '">'
    + (m.poster ? '<meta name="twitter:image" content="' + esc(m.poster) + '">' : '')
    + '<link rel="icon" href="/favicon.ico">'
    + '<link rel="preconnect" href="https://fonts.googleapis.com">'
    + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400..700&display=swap">'
    + '<link rel="stylesheet" href="/css/clipPage.css">'
    + '</head><body>'
    + '<main class="cp' + (tall ? ' tall' : '') + '">'
    + '<a class="cpbrand" href="/">DuelSeries</a>'
    + '<div class="cpstage"><video controls playsinline preload="metadata" src="' + esc(m.video) + '"'
    + (m.poster ? ' poster="' + esc(m.poster) + '"' : '') + '></video></div>'
    + '<div class="cpmeta"><div class="cpwords">'
    + (p.caption ? '<h1>' + esc(p.caption) + '</h1>' : '<h1>' + esc(p.name) + '</h1>')
    + '<p>' + esc(p.caption ? what : (GAME_NAMES[p.game] || 'DuelSeries')) + '</p></div>'
    + '<div class="cpacts" id="cpacts" data-video="' + esc(m.video) + '" data-id="' + esc(p.id) + '" data-page="' + esc(page) + '"'
    + ' data-title="' + esc(title) + '">'
    + '<button type="button" data-act="download">Download</button>'
    + '<button type="button" data-act="copy">Copy link</button>'
    + '<button type="button" data-act="x">Post on X</button>'
    + '<a class="cpplay" href="/">Play DuelSeries</a></div></div>'
    + '</main><script src="/js/clipPage.js" defer></script></body></html>';
}

module.exports = { parseClipUrl, cleanText, createClipStore, publicClip, ownerClip, resolveXMedia,
                   syndicationToken, mountClipRoutes, sharePage, GAMES, CAPTION_MAX, DAY_MAX, WAIT_MAX,
                   UP_MAX_BYTES, UP_MIN_BYTES, UP_MAX_SEC, POSTER_MAX, UP_DAY_MAX, UP_OPEN_MAX, UP_DAY_ALL, PUT_TTL_S, putTtl,
                   SRC_OPEN_MAX, SRC_DAY_MAX, sourceOf, clipLimiters };
