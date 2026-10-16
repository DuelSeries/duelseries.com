'use strict';
/* ─── Is this upload really a short MP4? (server/clips.js, before the owner sees it) ──
   A player's browser uploads its clip straight to S3, so the bytes never pass through
   here and the browser's word for what it sent counts for nothing. Before a clip can
   wait for approval, this reads its structure back out of S3 a few bytes at a time and
   checks every part a player could fake:

     whole file   at most maxBytes, made ONLY of top-level MP4 boxes that add up to its
                  exact size: ftyp first, one moov, the data (mdat), padding. No trailing
                  bytes, nothing appended, no fragments (moof), nothing unknown.
     brand        an ordinary MP4 brand (isom, mp41, mp42, avc1...)
     tracks       exactly one H.264 video track, at most one AAC audio track
     length       the movie, each track and the sum of its frame times all at most maxSec
     picture      between 16 and 4096 pixels each way
     data         every frame the index points at lies inside the data box, and frames fill
                  at least 90% of it; padding and tags stay under 256 KB, so nothing big rides
                  along inside an approved clip

   Only the boxes are read (the index is a few KB): the server never downloads the video.
   It does not decode the H.264 itself; the file is only ever served as video/mp4 with
   nosniff, so a browser plays it as a video or not at all, never as a page. */

const BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'mmp4']);
const TOP_OK = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'udta', 'meta', 'uuid']);   // the last three: tags other recorders add
const MOOV_MAX = 512 * 1024;      // a 31 s clip at 240 fps with sound indexes in well under 100 KB
const PAD_MAX = 256 * 1024;       // padding and tags together (free, skip, wide, udta, meta, uuid)
const PADS = new Set(['free', 'skip', 'wide', 'udta', 'meta', 'uuid']);
const TOP_MAX = 16;

class Mp4Error extends Error {}
const fail = (why) => { throw new Mp4Error(why); };

const typeOf = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const printable = (t) => /^[\x20-\x7e]{4}$/.test(t);

// The children of a box body at buf[start..end): [{ type, start (body), end }]
function children(buf, start, end, depth) {
  if (depth > 12) fail('boxes nested too deep');
  const out = [];
  let o = start;
  while (o < end) {
    if (end - o < 8) fail('a box is cut short');
    let size = buf.readUInt32BE(o);
    const type = typeOf(buf, o + 4);
    let hdr = 8;
    if (!printable(type)) fail('a box has no readable name');
    if (size === 1) {
      if (end - o < 16) fail('a box is cut short');
      const big = buf.readBigUInt64BE(o + 8);
      if (big > BigInt(end - o)) fail('a box runs past its parent');
      size = Number(big); hdr = 16;
    } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) fail('a box runs past its parent');
    out.push({ type, start: o + hdr, end: o + size });
    o += size;
    if (out.length > 4096) fail('too many boxes');
  }
  return out;
}
const one = (list, type) => list.find((b) => b.type === type) || null;
function need(list, type, where) {
  const b = one(list, type);
  if (!b) fail('no ' + type + ' in ' + where);
  return b;
}

// version/flags then the fields of a full box
function fullBody(buf, b) {
  if (b.end - b.start < 4) fail(b.type + ' is empty');
  return { v: buf[b.start], o: b.start + 4 };
}
function timescaleDuration(buf, b) {
  const { v, o } = fullBody(buf, b);
  if (v === 1) {
    if (b.end - o < 28) fail(b.type + ' is cut short');
    return { scale: buf.readUInt32BE(o + 16), dur: Number(buf.readBigUInt64BE(o + 20)) };
  }
  if (b.end - o < 16) fail(b.type + ' is cut short');
  return { scale: buf.readUInt32BE(o + 8), dur: buf.readUInt32BE(o + 12) };
}

function u32list(buf, b, perEntry, max) {
  const { o } = fullBody(buf, b);
  if (b.end - o < 4) fail(b.type + ' is cut short');
  const n = buf.readUInt32BE(o);
  if (n > max) fail(b.type + ' lists too many entries');
  if (o + 4 + n * perEntry * 4 > b.end) fail(b.type + ' is cut short');
  return { n, o: o + 4 };
}

function track(buf, trak, limits) {
  const kids = children(buf, trak.start, trak.end, 2);
  const tkhd = need(kids, 'tkhd', 'a track');
  const mdia = children(buf, ...span(need(kids, 'mdia', 'a track')), 3);
  const hdlr = need(mdia, 'hdlr', 'a track');
  const { o: ho } = fullBody(buf, hdlr);
  if (hdlr.end - ho < 8) fail('hdlr is cut short');
  const handler = typeOf(buf, ho + 4);
  const time = timescaleDuration(buf, need(mdia, 'mdhd', 'a track'));
  if (!time.scale) fail('a track has no time scale');
  const minf = children(buf, ...span(need(mdia, 'minf', 'a track')), 4);
  const stbl = children(buf, ...span(need(minf, 'stbl', 'a track')), 5);

  const stsd = need(stbl, 'stsd', 'a track');
  const { o: so } = fullBody(buf, stsd);
  if (stsd.end - so < 4 || buf.readUInt32BE(so) !== 1) fail('a track must have one sample format');
  const entry = children(buf, so + 4, stsd.end, 6)[0];
  if (!entry) fail('a track has no sample format');
  const codec = entry.type;

  // Frame count and length from the timing table.
  const maxSamples = Math.ceil(limits.maxSec * 400);     // 48 kHz AAC is ~47 frames a second; video at most 240
  const stts = u32list(buf, need(stbl, 'stts', 'a track'), 2, maxSamples);
  let samples = 0, ticks = 0;
  for (let i = 0; i < stts.n; i++) {
    samples += buf.readUInt32BE(stts.o + i * 8);
    ticks += buf.readUInt32BE(stts.o + i * 8) * buf.readUInt32BE(stts.o + i * 8 + 4);
  }
  if (samples > maxSamples) fail('too many frames for a clip this short');

  // Sizes.
  const stszB = need(stbl, 'stsz', 'a track');
  const { o: zo } = fullBody(buf, stszB);
  if (stszB.end - zo < 8) fail('stsz is cut short');
  const fixed = buf.readUInt32BE(zo);
  const count = buf.readUInt32BE(zo + 4);
  if (count !== samples) fail('the frame tables disagree');
  if (!fixed && zo + 8 + count * 4 > stszB.end) fail('stsz is cut short');
  const sizeOf = (i) => (fixed || buf.readUInt32BE(zo + 8 + i * 4));

  // Where each chunk starts, and how many frames each chunk holds.
  const coB = one(stbl, 'stco') || one(stbl, 'co64');
  if (!coB) fail('a track has no chunk offsets');
  const co = u32list(buf, coB, coB.type === 'co64' ? 2 : 1, maxSamples);
  const offset = (i) => (coB.type === 'co64' ? Number(buf.readBigUInt64BE(co.o + i * 8)) : buf.readUInt32BE(co.o + i * 4));
  const stsc = u32list(buf, need(stbl, 'stsc', 'a track'), 3, maxSamples);
  const runs = [];
  for (let i = 0; i < stsc.n; i++) {
    runs.push({ first: buf.readUInt32BE(stsc.o + i * 12), per: buf.readUInt32BE(stsc.o + i * 12 + 4) });
  }
  if (!runs.length || runs[0].first !== 1) fail('the chunk table does not start at the first chunk');
  for (let i = 1; i < runs.length; i++) if (runs[i].first <= runs[i - 1].first) fail('the chunk table is out of order');
  const ranges = [];
  let s = 0, run = 0;
  for (let c = 0; c < co.n; c++) {
    while (run + 1 < runs.length && runs[run + 1].first <= c + 1) run++;     // one pass: the runs are in order
    const per = runs[run].per;
    if (per < 1 || per > maxSamples) fail('a chunk holds an impossible number of frames');
    let len = 0;
    for (let k = 0; k < per; k++, s++) {
      if (s >= samples) fail('the chunks hold more frames than the track has');
      len += sizeOf(s);
    }
    ranges.push([offset(c), offset(c) + len]);
  }
  if (s !== samples) fail('some frames are in no chunk');

  const out = { handler, codec, scale: time.scale, dur: time.dur, ticks, samples, ranges };
  if (handler === 'vide') {
    const { v, o } = fullBody(buf, tkhd);
    const at = o + (v === 1 ? 84 : 72);                  // width and height close the tkhd, 16.16 fixed point
    if (tkhd.end - at < 8) fail('tkhd is cut short');
    out.w = Math.round(buf.readUInt32BE(at) / 65536);
    out.h = Math.round(buf.readUInt32BE(at + 4) / 65536);
  }
  return out;
}
const span = (b) => [b.start, b.end];

/* read(start, endInclusive) -> Promise<Buffer>; size = the object's size in bytes.
   Returns { ms, w, h, audio } or throws Mp4Error saying what is wrong. */
async function checkMp4(read, size, { maxBytes, maxSec }) {
  if (!Number.isFinite(size) || size < 1024) fail('the file is too small to be a clip');
  if (size > maxBytes) fail('the file is larger than a clip can be');

  // The top-level boxes: read each header where the last one ended.
  const top = [];
  let o = 0;
  while (o < size) {
    if (top.length >= TOP_MAX) fail('too many top-level boxes');
    const h = await read(o, Math.min(size, o + 16) - 1);
    if (h.length < 8) fail('the file ends inside a box header');
    let len = h.readUInt32BE(0);
    const type = typeOf(h, 4);
    let hdr = 8;
    if (!printable(type)) fail('the file is not an MP4 (unreadable box at ' + o + ')');
    if (len === 1) {
      if (h.length < 16) fail('the file ends inside a box header');
      len = Number(h.readBigUInt64BE(8)); hdr = 16;
    } else if (len === 0) len = size - o;
    if (len < hdr || o + len > size) fail('the ' + type + ' box runs past the end of the file');
    if (!TOP_OK.has(type)) fail('the file holds a part (' + (type === 'moof' ? 'a fragment' : 'an unknown box') + ') a clip never has');
    top.push({ type, at: o, hdr, len });
    o += len;
  }
  if (!top.length || top[0].type !== 'ftyp') fail('the file does not start like an MP4');
  // Nothing big may ride along beside the video: padding and tags stay small.
  if (top.filter((b) => PADS.has(b.type)).reduce((n, b) => n + b.len, 0) > PAD_MAX) fail('the file carries too much besides the video');
  if (top.filter((b) => b.type === 'moov').length !== 1) fail('the file needs exactly one index (moov)');
  const mdats = top.filter((b) => b.type === 'mdat');
  if (!mdats.length) fail('the file has no video data');

  const f = top[0];
  if (f.len < 16 || f.len > 256) fail('the ftyp box is the wrong size');
  const fb = await read(f.at, f.at + f.len - 1);
  const brands = [typeOf(fb, f.hdr)];
  for (let i = f.hdr + 8; i + 4 <= f.len; i += 4) brands.push(typeOf(fb, i));
  if (!BRANDS.has(brands[0]) && !brands.some((b) => BRANDS.has(b))) fail('the file is not an ordinary MP4');

  const m = top.find((b) => b.type === 'moov');
  if (m.len > MOOV_MAX) fail('the index is too large for a short clip');
  const mb = await read(m.at, m.at + m.len - 1);
  if (mb.length !== m.len) fail('could not read the index');
  const moov = children(mb, m.hdr, m.len, 1);
  const movie = timescaleDuration(mb, need(moov, 'mvhd', 'the index'));
  if (!movie.scale) fail('the movie has no time scale');
  const traks = moov.filter((b) => b.type === 'trak');
  if (!traks.length || traks.length > 2) fail('a clip has one video track and at most one sound track');
  const tracks = traks.map((t) => track(mb, t, { maxSec }));

  const video = tracks.filter((t) => t.handler === 'vide');
  const audio = tracks.filter((t) => t.handler === 'soun');
  if (video.length !== 1) fail('a clip needs exactly one video track');
  if (audio.length > 1 || video.length + audio.length !== tracks.length) fail('a clip has only picture and sound');
  if (!/^avc[13]$/.test(video[0].codec)) fail('the video is not H.264');
  if (audio.length && audio[0].codec !== 'mp4a') fail('the sound is not AAC');
  const v = video[0];
  if (!(v.w >= 16 && v.h >= 16 && v.w <= 4096 && v.h <= 4096)) fail('the picture size is not a clip\'s');

  const secs = [movie.dur / movie.scale];
  for (const t of tracks) secs.push(t.dur / t.scale, t.ticks / t.scale);
  const longest = Math.max(...secs);
  if (!Number.isFinite(longest) || longest > maxSec) fail('the clip is longer than ' + maxSec + ' seconds');
  if (!(v.ticks > 0 && v.samples > 0)) fail('the clip has no frames');

  // Every frame lies inside a data box.
  const data = mdats.map((d) => [d.at + d.hdr, d.at + d.len]);
  for (const t of tracks) {
    for (const [a, b] of t.ranges) {
      if (b < a || !data.some(([s, e]) => a >= s && b <= e)) fail('the index points outside the video data');
    }
  }
  // ...and the data box is (almost) all frames: no large stretch the index never points at.
  const used = tracks.reduce((n, t) => n + t.ranges.reduce((m, [a, b]) => m + (b - a), 0), 0);
  const held = data.reduce((n, [s, e]) => n + (e - s), 0);
  if (used < held * 0.9 - 4096) fail('the file carries data that is not part of the video');
  return { ms: Math.round((v.ticks / v.scale) * 1000), w: v.w, h: v.h, audio: audio.length === 1 };
}

/* A poster picture: a baseline or progressive JPEG, start and end markers in place. */
async function checkJpeg(read, size, { maxBytes }) {
  if (!Number.isFinite(size) || size < 128 || size > maxBytes) fail('the picture is the wrong size');
  const head = await read(0, 3);
  const tail = await read(size - 2, size - 1);
  if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) fail('the picture is not a JPEG');
  if (tail[0] !== 0xff || tail[1] !== 0xd9) fail('the picture is cut short');
  return true;
}

module.exports = { checkMp4, checkJpeg, Mp4Error };
