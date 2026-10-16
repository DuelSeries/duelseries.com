'use strict';
/* ─── A small MP4 writer for clips (H.264 video + AAC audio) ───────────────────
   The clip recorder (clipRec.js) keeps the last 30 seconds of encoded frames
   from the browser's own encoders (WebCodecs) and, when the player saves, needs
   them as an ordinary .mp4: the one format X, TikTok and YouTube all take.

   This writes exactly that and nothing more: one H.264 track and at most one
   AAC track, every sample its own chunk, the index (moov) before the data so it
   plays while still downloading. No B-frames are expected (the browser's
   realtime H.264 encoders do not make them), so there is no ctts box.

     DSMp4.mux({
       video: { width, height, description, chunks: [{ data, ts, key }] },
       audio: { sampleRate, channels, description, chunks: [{ data, ts }] } | null,
     }) -> Uint8Array

   ts in microseconds; the first video chunk must be a key frame and is time 0.
   description is the avcC record (VideoEncoder's decoderConfig.description)
   and the AudioSpecificConfig (AudioEncoder's), as bytes. Pure: no DOM, so the
   tests run it in Node. */
(function (root) {
  const VIDEO_SCALE = 90000;
  const MOVIE_SCALE = 1000;

  const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
  const u8 = (n) => [n & 255];
  const u16 = (n) => [(n >>> 8) & 255, n & 255];
  const u24 = (n) => [(n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const zeros = (n) => new Array(n).fill(0);

  function bytesOf(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function box(type, ...parts) {
    const body = bytesOf(parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p))));
    return bytesOf([Uint8Array.from(u32(body.length + 8).concat(ascii(type))), body]);
  }
  const full = (type, version, flags, ...parts) => box(type, [version].concat(u24(flags)), ...parts);

  const MATRIX = [].concat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));

  // Run-length time-to-sample table from per-sample durations.
  function stts(durs) {
    const runs = [];
    for (const d of durs) {
      const last = runs[runs.length - 1];
      if (last && last[1] === d) last[0]++; else runs.push([1, d]);
    }
    return full('stts', 0, 0, u32(runs.length), [].concat(...runs.map(([n, d]) => u32(n).concat(u32(d)))));
  }
  const stsc = () => full('stsc', 0, 0, u32(1), u32(1).concat(u32(1), u32(1)));   // one sample per chunk
  const stsz = (sizes) => full('stsz', 0, 0, u32(0), u32(sizes.length), [].concat(...sizes.map(u32)));
  const stco = (offs) => full('stco', 0, 0, u32(offs.length), [].concat(...offs.map(u32)));
  const dinf = () => box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
  const hdlr = (type, name) => full('hdlr', 0, 0, u32(0), ascii(type), zeros(12), ascii(name), [0]);
  const mdhd = (scale, dur) => full('mdhd', 0, 0, u32(0), u32(0), u32(scale), u32(dur), u16(0x55c4), u16(0));
  function tkhd(id, dur, audio, w, h) {
    return full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(dur), zeros(8), u16(0), u16(0),
      u16(audio ? 0x0100 : 0), u16(0), MATRIX, u32((w || 0) * 65536), u32((h || 0) * 65536));
  }

  // An MPEG-4 descriptor: tag, then the length as four 7-bit groups (the form every reader accepts).
  const desc = (tag, body) => [tag, 0x80 | ((body.length >>> 21) & 127), 0x80 | ((body.length >>> 14) & 127),
    0x80 | ((body.length >>> 7) & 127), body.length & 127].concat(body);

  // AAC-LC AudioSpecificConfig, for an encoder that did not hand one over.
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  function asc(sampleRate, channels) {
    const i = RATES.indexOf(sampleRate);
    const v = (2 << 11) | ((i < 0 ? 4 : i) << 7) | ((channels & 15) << 3);
    return Uint8Array.from(u16(v));
  }

  function toBytes(d) {
    if (!d) return null;
    if (d instanceof Uint8Array) return d;
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    return null;
  }

  // Per-sample durations in a track's timescale, from presentation timestamps (microseconds).
  function durations(chunks, scale, fallback) {
    const t = chunks.map((c) => Math.round((c.ts * scale) / 1e6));
    const out = [];
    for (let i = 0; i < t.length; i++) {
      const d = i + 1 < t.length ? t[i + 1] - t[i] : (out.length ? out[out.length - 1] : fallback);
      out.push(Math.max(1, d));
    }
    return out;
  }

  function mux({ video, audio }) {
    if (!video || !video.chunks || !video.chunks.length) throw new Error('no video');
    if (!video.chunks[0].key) throw new Error('the first video frame must be a key frame');
    const vDesc = toBytes(video.description);
    if (!vDesc) throw new Error('no avcC');
    const t0 = video.chunks[0].ts;
    const vChunks = video.chunks.map((c) => ({ data: toBytes(c.data), ts: c.ts - t0, key: !!c.key }));
    const aChunks = audio && audio.chunks && audio.chunks.length
      ? audio.chunks.filter((c) => c.ts >= t0).map((c) => ({ data: toBytes(c.data), ts: c.ts - t0 }))
      : [];
    const hasAudio = aChunks.length > 0;

    const vDur = durations(vChunks, VIDEO_SCALE, Math.round(VIDEO_SCALE / 30));
    const vTotal = vDur.reduce((a, b) => a + b, 0);
    const sr = hasAudio ? audio.sampleRate : 0;
    const aDur = hasAudio ? aChunks.map(() => 1024) : [];        // an AAC-LC frame is 1024 samples
    const aTotal = aDur.reduce((a, b) => a + b, 0);
    const movieDur = Math.max(Math.round((vTotal * MOVIE_SCALE) / VIDEO_SCALE),
                              hasAudio ? Math.round((aTotal * MOVIE_SCALE) / sr) : 0);

    // Samples in time order across both tracks, so a player reading front to back finds both together.
    const order = vChunks.map((c, i) => ({ tr: 0, i, ts: c.ts })).concat(aChunks.map((c, i) => ({ tr: 1, i, ts: c.ts })))
      .sort((a, b) => a.ts - b.ts || a.tr - b.tr);

    function build(vOffs, aOffs) {
      const stssBox = full('stss', 0, 0, u32(vChunks.filter((c) => c.key).length),
        [].concat(...vChunks.map((c, i) => (c.key ? u32(i + 1) : []))));
      const avc1 = box('avc1', zeros(6), u16(1), zeros(16), u16(video.width), u16(video.height),
        u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff), box('avcC', vDesc));
      const vTrak = box('trak',
        tkhd(1, Math.round((vTotal * MOVIE_SCALE) / VIDEO_SCALE), false, video.width, video.height),
        box('mdia', mdhd(VIDEO_SCALE, vTotal), hdlr('vide', 'VideoHandler'),
          box('minf', full('vmhd', 0, 1, zeros(8)), dinf(),
            box('stbl', full('stsd', 0, 0, u32(1), avc1), stts(vDur), stssBox, stsc(),
              stsz(vChunks.map((c) => c.data.length)), stco(vOffs)))));
      let aTrak = new Uint8Array(0);
      if (hasAudio) {
        const cfg = toBytes(audio.description) || asc(sr, audio.channels);
        const esd = desc(3, u16(2).concat([0],
          desc(4, [0x40, 0x15].concat(u24(0), u32(0), u32(0), desc(5, Array.from(cfg)))),
          desc(6, [2])));
        const mp4a = box('mp4a', zeros(6), u16(1), zeros(8), u16(audio.channels), u16(16), u16(0), u16(0),
          u32(sr * 65536 >>> 0), full('esds', 0, 0, esd));
        aTrak = box('trak',
          tkhd(2, Math.round((aTotal * MOVIE_SCALE) / sr), true),
          box('mdia', mdhd(sr, aTotal), hdlr('soun', 'SoundHandler'),
            box('minf', full('smhd', 0, 0, zeros(4)), dinf(),
              box('stbl', full('stsd', 0, 0, u32(1), mp4a), stts(aDur), stsc(),
                stsz(aChunks.map((c) => c.data.length)), stco(aOffs)))));
      }
      const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_SCALE), u32(movieDur), u32(0x00010000), u16(0x0100),
        zeros(10), MATRIX, zeros(24), u32(hasAudio ? 3 : 2));
      return box('moov', mvhd, vTrak, aTrak);
    }

    const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
    const vZero = vChunks.map(() => 0);
    const aZero = aChunks.map(() => 0);
    const moovSize = build(vZero, aZero).length;     // offsets are fixed-width, so the size does not depend on them
    let at = ftyp.length + moovSize + 8;
    const vOffs = vZero.slice(); const aOffs = aZero.slice();
    let dataLen = 0;
    for (const s of order) {
      const c = s.tr === 0 ? vChunks[s.i] : aChunks[s.i];
      (s.tr === 0 ? vOffs : aOffs)[s.i] = at;
      at += c.data.length; dataLen += c.data.length;
    }
    if (at > 0xffffffff) throw new Error('clip too large');
    const moov = build(vOffs, aOffs);
    const parts = [ftyp, moov, Uint8Array.from(u32(dataLen + 8).concat(ascii('mdat')))];
    for (const s of order) parts.push((s.tr === 0 ? vChunks : aChunks)[s.i].data);
    return bytesOf(parts);
  }

  const api = { mux, asc };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DSMp4 = api;
})(typeof window !== 'undefined' ? window : this);
