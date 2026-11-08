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
       video: { width, height, description, chunks: [{ data, ts, key }], color: { primaries, transfer, matrix, full } | null },
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

  /* ── colour: what the numbers in the picture mean (Owen 2026-11-08: clips darker than the game) ──────────────
     A clip left untagged is read by every player as BT.709 "limited range" (black at 16, white at 235). Chrome's
     hardware encoder tagged nothing, so the recorder's tag is written twice: in the H.264 stream itself (the SPS's
     VUI, which decoders read) and in the MP4 (a colr box, which QuickTime-style readers read). color is
     { primaries, transfer, matrix, full } as ITU-T H.273 numbers (1, 1, 1, false: BT.709, limited range). */
  const unescape = (b) => {      // NAL payload -> RBSP (drop the emulation-prevention 3 in 00 00 03)
    const out = []; let z = 0;
    for (let i = 0; i < b.length; i++) {
      if (z >= 2 && b[i] === 3) { z = 0; continue; }
      out.push(b[i]); z = b[i] === 0 ? z + 1 : 0;
    }
    return out;
  };
  const escape = (b) => {      // RBSP -> NAL payload
    const out = []; let z = 0;
    for (const x of b) {
      if (z >= 2 && x <= 3) { out.push(3); z = 0; }
      out.push(x); z = x === 0 ? z + 1 : 0;
    }
    return out;
  };
  function bitReader(b) {
    let p = 0;
    const bit = () => { if (p >= b.length * 8) throw new Error('past the end'); const v = (b[p >> 3] >> (7 - (p & 7))) & 1; p++; return v; };
    const u = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v; };
    const ue = () => { let z = 0; while (!bit()) if (++z > 31) throw new Error('bad ue'); return (2 ** z - 1) + u(z); };
    const se = () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -k / 2; };
    return { u, ue, se, at: () => p };
  }
  function bitWriter() {
    const bits = [];
    return { bits, u: (n, v) => { for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(v / 2 ** i) & 1); },
      copy: (b, from, to) => { for (let p = from; p < to; p++) bits.push((b[p >> 3] >> (7 - (p & 7))) & 1); },
      bytes: () => { bits.push(1); while (bits.length & 7) bits.push(0);
        const out = []; for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = v * 2 + bits[i + j]; out.push(v); } return out; } };
  }
  const HIGH = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
  function hrd(r) {
    const n = r.ue() + 1; r.u(8);
    for (let i = 0; i < n; i++) { r.ue(); r.ue(); r.u(1); }
    r.u(20);
  }
  // One SPS NAL (header byte first) with its VUI's video_signal_type set to color; null when it cannot be read.
  function tagSps(nal, color) {
    try {
      if ((nal[0] & 31) !== 7) return null;
      const b = unescape(nal.subarray ? Array.from(nal.subarray(1)) : nal.slice(1));
      const r = bitReader(b);
      const profile = r.u(8); r.u(16); r.ue();
      if (HIGH.includes(profile)) {
        const cf = r.ue();
        if (cf === 3) r.u(1);
        r.ue(); r.ue(); r.u(1);
        if (r.u(1)) for (let i = 0; i < (cf !== 3 ? 8 : 12); i++) {
          if (!r.u(1)) continue;
          let last = 8, next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + r.se() + 256) % 256; last = next || last; }
        }
      }
      r.ue();
      const poc = r.ue();
      if (poc === 0) r.ue();
      else if (poc === 1) { r.u(1); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
      r.ue(); r.u(1); r.ue(); r.ue();
      if (!r.u(1)) r.u(1);
      r.u(1);
      if (r.u(1)) { r.ue(); r.ue(); r.ue(); r.ue(); }
      const vuiAt = r.at();
      const w = bitWriter();
      w.copy(b, 0, vuiAt);
      w.u(1, 1);                                           // vui_parameters_present_flag
      const sig = () => { w.u(1, 1); w.u(3, 5); w.u(1, color.full ? 1 : 0); w.u(1, 1); w.u(8, color.primaries); w.u(8, color.transfer); w.u(8, color.matrix); };
      if (r.u(1)) {                                        // a VUI already: keep all of it but the signal type
        const from = r.at();
        if (r.u(1) && r.u(8) === 255) r.u(32);             // aspect ratio
        if (r.u(1)) r.u(1);                                // overscan
        w.copy(b, from, r.at());
        if (r.u(1)) { r.u(4); if (r.u(1)) r.u(24); }       // the old signal type, replaced
        sig();
        const rest = r.at();
        if (r.u(1)) { r.ue(); r.ue(); }                    // chroma location
        if (r.u(1)) r.u(65);                               // timing
        const nalHrd = r.u(1); if (nalHrd) hrd(r);
        const vclHrd = r.u(1); if (vclHrd) hrd(r);
        if (nalHrd || vclHrd) r.u(1);
        r.u(1);                                            // pic_struct_present_flag
        if (r.u(1)) { r.u(1); r.ue(); r.ue(); r.ue(); r.ue(); r.ue(); r.ue(); }
        w.copy(b, rest, r.at());
      } else {
        w.u(2, 0);                                         // no aspect ratio, no overscan
        sig();
        w.u(6, 0);                                         // no chroma location, timing, HRDs, pic_struct, restriction
      }
      return Uint8Array.from([nal[0]].concat(escape(w.bytes())));
    } catch (_) { return null; }
  }
  // The avcC record with each SPS tagged; as it was when it cannot be read.
  function tagAvcC(d, color) {
    try {
      if (d.length < 7 || d[0] !== 1) return d;
      const out = Array.from(d.subarray(0, 5));
      let o = 5;
      const nSps = d[o++] & 31;
      out.push(0xe0 | nSps);
      for (let i = 0; i < nSps; i++) {
        const len = (d[o] << 8) | d[o + 1];
        const nal = d.subarray(o + 2, o + 2 + len);
        if (nal.length !== len) return d;
        const t = tagSps(nal, color) || nal;
        out.push(...u16(t.length), ...t);
        o += 2 + len;
      }
      for (let i = o; i < d.length; i++) out.push(d[i]);       // the PPSs and any High profile extension, as they were
      return Uint8Array.from(out);
    } catch (_) { return d; }
  }
  // A sample (4-byte lengths) with any SPS it carries tagged too, so a decoder reading it there sees the same.
  function tagSample(s, color) {
    let o = 0, has = false;
    while (o + 4 <= s.length) { const n = ((s[o] << 24) >>> 0) + (s[o + 1] << 16) + (s[o + 2] << 8) + s[o + 3]; if (n < 1 || o + 4 + n > s.length) return s; if ((s[o + 4] & 31) === 7) has = true; o += 4 + n; }
    if (!has || o !== s.length) return s;
    const parts = [];
    for (o = 0; o < s.length;) {
      const n = ((s[o] << 24) >>> 0) + (s[o + 1] << 16) + (s[o + 2] << 8) + s[o + 3];
      let nal = s.subarray(o + 4, o + 4 + n);
      if ((nal[0] & 31) === 7) nal = tagSps(nal, color) || nal;
      parts.push(Uint8Array.from(u32(nal.length)), nal);
      o += 4 + n;
    }
    return bytesOf(parts);
  }
  const colr = (c) => box('colr', ascii('nclx'), u16(c.primaries), u16(c.transfer), u16(c.matrix), [c.full ? 0x80 : 0]);

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
    const color = video.color || null;
    let vDesc = toBytes(video.description);
    if (!vDesc) throw new Error('no avcC');
    if (color) vDesc = tagAvcC(vDesc, color);
    const t0 = video.chunks[0].ts;
    const vChunks = video.chunks.map((c) => ({ data: color && c.key ? tagSample(toBytes(c.data), color) : toBytes(c.data), ts: c.ts - t0, key: !!c.key }));
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
        u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff), box('avcC', vDesc),
        color ? colr(color) : []);
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

  const api = { mux, asc, tagSps, tagAvcC };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DSMp4 = api;
})(typeof window !== 'undefined' ? window : this);
