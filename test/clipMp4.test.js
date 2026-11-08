'use strict';
/* The clip recorder's MP4 writer (public/js/clip/mp4mux.js). The real check was end to end: Chrome's own H.264 and
   AAC encoders -> this writer -> ffprobe and a full ffmpeg decode, clean (h264 Main 640x360 30 fps 150 frames, AAC LC
   48 kHz stereo). These pin the structure so a change cannot quietly break the file. */
const test = require('node:test');
const assert = require('node:assert');
const { mux, asc, tagAvcC } = require('../public/js/clip/mp4mux');

// Top-level and nested boxes as { type, start, size, body } by walking sizes.
function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let o = start; o < end;) {
    const size = dv.getUint32(o);
    const type = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
    assert.ok(size >= 8 && o + size <= end, type + ' fits its parent');
    out.push({ type, start: o, size, body: o + 8 });
    o += size;
  }
  return out;
}
const find = (buf, path, from = 0, to = buf.length) => {
  let list = boxes(buf, from, to);
  let b = null;
  for (const t of path) {
    b = list.find((x) => x.type === t);
    assert.ok(b, 'has ' + path.join('/'));
    const skip = { stsd: 8, avc1: 78, mp4a: 28 }[t] || 0;
    list = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1', 'mp4a'].includes(t)
      ? boxes(buf, b.body + skip, b.start + b.size) : [];
  }
  return b;
};
const u32 = (buf, o) => new DataView(buf.buffer, buf.byteOffset).getUint32(o);

function sample(n, key, fill) { const d = new Uint8Array(n).fill(fill); return { data: d, key }; }

test('a clip is ftyp, then the index, then the data, with every sample where its offset says', () => {
  const v = [];
  for (let i = 0; i < 60; i++) v.push(Object.assign(sample(100 + i, i % 30 === 0, i & 255), { ts: 5e6 + i * 33333 }));
  const a = [];
  for (let i = 0; i < 90; i++) a.push({ data: new Uint8Array(20).fill(200), ts: 5e6 + i * 21333 });
  a.unshift({ data: new Uint8Array(20), ts: 4.9e6 });       // before the first key frame: dropped
  const out = mux({ video: { width: 1280, height: 720, description: new Uint8Array([1, 77, 0, 31, 255]), chunks: v },
                    audio: { sampleRate: 48000, channels: 2, description: null, chunks: a } });
  assert.deepStrictEqual(boxes(out).map((b) => b.type), ['ftyp', 'moov', 'mdat'], 'the index comes first, so it plays while loading');

  const vStbl = find(out, ['moov', 'trak', 'mdia', 'minf', 'stbl']);
  const stco = find(out, ['stco'], vStbl.body, vStbl.start + vStbl.size);
  const stsz = find(out, ['stsz'], vStbl.body, vStbl.start + vStbl.size);
  assert.strictEqual(u32(out, stco.body + 4), 60);
  for (const i of [0, 1, 31, 59]) {
    const off = u32(out, stco.body + 8 + i * 4);
    assert.strictEqual(u32(out, stsz.body + 12 + i * 4), 100 + i);
    assert.strictEqual(out[off], i & 255, 'sample ' + i + ' is at its offset');
  }
  const stss = find(out, ['stss'], vStbl.body, vStbl.start + vStbl.size);
  assert.strictEqual(u32(out, stss.body + 4), 2, 'two key frames');
  assert.strictEqual(u32(out, stss.body + 12), 31, 'the second is sample 31');

  const traks = boxes(out, find(out, ['moov']).body, find(out, ['moov']).start + find(out, ['moov']).size).filter((b) => b.type === 'trak');
  assert.strictEqual(traks.length, 2, 'video and sound');
  const aStsz = find(out, ['stsz'], ...(() => { const s = find(out, ['mdia', 'minf', 'stbl'], traks[1].body, traks[1].start + traks[1].size); return [s.body, s.start + s.size]; })());
  assert.strictEqual(u32(out, aStsz.body + 8), 90, 'the audio frame from before the key frame is left out');

  const mvhd = find(out, ['moov', 'mvhd']);
  assert.strictEqual(u32(out, mvhd.body + 12), 1000);
  assert.ok(Math.abs(u32(out, mvhd.body + 16) - 2000) < 60, 'about two seconds long, counted from the key frame');
});

test('video only works, and a clip must start on a key frame', () => {
  const v = [Object.assign(sample(10, true, 1), { ts: 0 }), Object.assign(sample(10, false, 2), { ts: 33333 })];
  const out = mux({ video: { width: 640, height: 360, description: new Uint8Array([1, 66, 0, 30]), chunks: v }, audio: null });
  const moov = find(out, ['moov']);
  assert.strictEqual(boxes(out, moov.body, moov.start + moov.size).filter((b) => b.type === 'trak').length, 1);
  assert.throws(() => mux({ video: { width: 2, height: 2, description: new Uint8Array(4), chunks: [Object.assign(sample(1, false, 0), { ts: 0 })] } }), /key frame/);
  assert.throws(() => mux({ video: { width: 2, height: 2, chunks: [] } }), /no video/);
});

test('AAC-LC config written for an encoder that gave none: 48 kHz stereo is 0x11 0x90', () => {
  assert.deepStrictEqual(Array.from(asc(48000, 2)), [0x11, 0x90]);
  assert.deepStrictEqual(Array.from(asc(44100, 2)), [0x12, 0x10]);
});

/* Colour (Owen 2026-11-08: clips darker than the game). The avcC records are real ones: his PC's graphics card
   encoder (no VUI at all), a headless Chrome's hardware encoder (a VUI with timing and bitstream restriction, and
   emulation-prevention bytes) and Chrome's software encoder (a VUI already saying full range, sRGB). Each "tagged" record
   was checked with ffmpeg's trace_headers (video_full_range_flag 0, colour_primaries 1, transfer 1, matrix 1, every
   other VUI field as it was) and a clean decode of the re-muxed clip. */
const hex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const BT709 = { primaries: 1, transfer: 1, matrix: 1, full: false };
const AVCC = [
  ['his PC, no VUI', '01640032ffe1000c67640032ac16c9013005af5a01000468ee3cb0fdf8f800',
    '01640032ffe1001167640032ac16c9013005af5cd40404040801000468ee3cb0fdf8f800'],
  ['VUI with timing, restriction and 00 00 03', '01640032ffe1001b67640032ac2b7014004ffd6022000003000200000300791b43865c01000468ee3cb0fdf8f800',
    '01640032ffe1001f67640032ac2b7014004ffd602d40404050000003001000000303c8da1c32e001000468ee3cb0fdf8f800'],
  ['VUI saying full range sRGB', '01640c32ffe1001467640c32ac18d0050013ff537010d0107844235001000468ce3c80fdf8f800',
    '01640c32ffe1001467640c32ac18d0050013ff53501010107844235001000468ce3c80fdf8f800'],
];
for (const [what, inp, out] of AVCC) {
  test('the H.264 stream says BT.709 limited range: ' + what, () => {
    assert.strictEqual(Buffer.from(tagAvcC(hex(inp), BT709)).toString('hex'), out);
    assert.strictEqual(Buffer.from(tagAvcC(hex(out), BT709)).toString('hex'), out, 'tagging twice changes nothing');
  });
}

test('the MP4 says it too (colr nclx after avcC), an SPS inside a key frame is tagged, and odd records are left alone', () => {
  const sps = hex(AVCC[0][1]).subarray(8, 20);
  const idr = Uint8Array.from([0, 0, 0, 3, 0x65, 0x88, 0x80]);
  const key = Buffer.concat([Buffer.from([0, 0, 0, sps.length]), Buffer.from(sps), Buffer.from(idr)]);
  const v = [{ data: new Uint8Array(key), ts: 0, key: true }, Object.assign(sample(10, false, 2), { ts: 33333 })];
  const out = mux({ video: { width: 2560, height: 1262, description: hex(AVCC[0][1]), chunks: v, color: BT709 }, audio: null });
  const avc1 = find(out, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1']);
  const inner = boxes(out, avc1.body + 78, avc1.start + avc1.size);
  assert.deepStrictEqual(inner.map((b) => b.type), ['avcC', 'colr']);
  assert.strictEqual(Buffer.from(out.subarray(inner[1].body, inner[1].start + inner[1].size)).toString('hex'), Buffer.from('nclx').toString('hex') + '000100010001' + '00');
  assert.strictEqual(Buffer.from(out.subarray(inner[0].body, inner[0].start + inner[0].size)).toString('hex'), AVCC[0][2]);
  const tagged = hex(AVCC[0][2]).subarray(8, 25);
  assert.ok(Buffer.from(out).includes(Buffer.concat([Buffer.from([0, 0, 0, tagged.length]), Buffer.from(tagged), Buffer.from(idr)])), 'the key frame carries the tagged SPS');
  const odd = new Uint8Array([1, 77, 0, 31, 255]);
  assert.strictEqual(tagAvcC(odd, BT709), odd);
  const plain = mux({ video: { width: 640, height: 360, description: odd, chunks: v.slice(0, 1) }, audio: null });
  const a2 = find(plain, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1']);
  assert.deepStrictEqual(boxes(plain, a2.body + 78, a2.start + a2.size).map((b) => b.type), ['avcC'], 'no colour given: no colr');
});
