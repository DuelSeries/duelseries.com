'use strict';
// agMath (build brief 9.2 "agMath.js", client-render spec 4.2 and 11): float trig, float log2 and
// the draw-order introsort must give the reference client's numbers bit for bit.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'js', 'ag', 'agMath.js');
const M = require(FILE);

const view = new DataView(new ArrayBuffer(4));
const fromBits = (u) => { view.setUint32(0, u >>> 0); return view.getFloat32(0); };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv(ids) {
  let h = 0x811c9dc5;
  for (const id of ids) {
    h ^= id & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (id >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const bySize = (a, b) => a.s < b.s;

test('loads under node and registers on DuelAgarLib with the card exports', () => {
  assert.strictEqual(globalThis.DuelAgarLib.agMath, M);
  for (const k of ['f32', 'sinf', 'cosf', 'atanf', 'atan2f', 'log2f', 'makeIntroSort']) {
    assert.strictEqual(typeof M[k], 'function', k);
  }
  assert.strictEqual(M.f32(0.1), Math.fround(0.1));
});

test('sinf, cosf, atan2f hit the brief values where fround of the double maths does not', () => {
  assert.strictEqual(M.sinf(8.000800132751465), 0.9892415404319763);
  assert.strictEqual(Math.fround(Math.sin(8.000800132751465)), 0.9892414808273315);
  assert.strictEqual(M.atan2f(454.6487121582031, -428.4443664550781), 2.3265299797058105);
  assert.strictEqual(Math.fround(Math.atan2(454.6487121582031, -428.4443664550781)), 2.3265297412872314);
  assert.strictEqual(M.atan2f(1, 1), 0.7853981852531433);
  assert.strictEqual(M.cosf(1), 0.5403022766113281);
});

test('trig special values follow musl', () => {
  assert.ok(Object.is(M.sinf(-0), -0));
  assert.strictEqual(M.cosf(0), 1);
  assert.ok(Number.isNaN(M.sinf(Infinity)) && Number.isNaN(M.cosf(NaN)));
  assert.strictEqual(M.atan2f(0, -1), Math.fround(Math.PI));
  assert.strictEqual(M.atan2f(-0, -1), -Math.fround(Math.PI));
  assert.ok(Object.is(M.atan2f(-0, 1), -0));
  assert.strictEqual(M.atan2f(1, 0), Math.fround(Math.PI / 2));
  assert.strictEqual(M.atan2f(Infinity, Infinity), Math.fround(Math.PI / 4));
  assert.strictEqual(M.atan2f(-Infinity, -Infinity), -Math.fround(Math.fround(3 * Math.fround(Math.PI)) / 4));
  assert.ok(Object.is(M.atan2f(-5, Infinity), -0));
  assert.strictEqual(M.atan2f(5, -Infinity), Math.fround(Math.PI));
  assert.ok(Number.isNaN(M.atan2f(NaN, 1)));
  // |x| >= 2^26 returns musl's atanhi[3] (+ 2^-120, lost in the f32 rounding), one ulp under fround(pi/2)
  assert.strictEqual(M.atanf(1e30), Math.fround(1.5707962513e+00));
  assert.strictEqual(M.atanf(-1e30), -Math.fround(1.5707962513e+00));
});

test('every result is an f32 and stays within one f32 ulp of the exact value', () => {
  const r = mulberry32(99);
  const ulp = (v) => Math.max(Math.abs(v), Math.pow(2, -126)) * Math.pow(2, -23);
  for (let i = 0; i < 200000; i++) {
    const x = Math.fround((r() - 0.5) * 2 * Math.pow(2, Math.floor(r() * 40) - 10));
    const y = Math.fround((r() - 0.5) * 2 * Math.pow(2, Math.floor(r() * 30) - 10));
    for (const [got, want] of [
      [M.sinf(x), Math.sin(x)], [M.cosf(x), Math.cos(x)],
      [M.atanf(x), Math.atan(x)], [M.atan2f(y, x), Math.atan2(y, x)],
    ]) {
      assert.strictEqual(Math.fround(got), got);
      assert.ok(Math.abs(got - want) <= ulp(want), `x=${x} y=${y} got ${got} want ${want}`);
    }
  }
});

test('the wobble angle range (0 to 4 pi) is covered by the medium reduction and stays exact f32', () => {
  const r = mulberry32(5);
  for (let i = 0; i < 100000; i++) {
    const a = Math.fround(r() * 12.6);
    const s = M.sinf(a); const c = M.cosf(a);
    assert.strictEqual(Math.fround(s), s);
    assert.ok(Math.abs(s * s + c * c - 1) < 4e-7);
  }
});

test('huge arguments go through the large reduction and still agree with the double maths', () => {
  const r = mulberry32(17);
  for (let i = 0; i < 50000; i++) {
    const bits = 0x4dc90fdb + Math.floor(r() * (0x7f7fffff - 0x4dc90fdb));
    const x = fromBits(r() < 0.5 ? bits : (bits | 0x80000000));
    assert.ok(Math.abs(M.sinf(x) - Math.sin(x)) <= Math.pow(2, -23), `sin ${x}`);
    assert.ok(Math.abs(M.cosf(x) - Math.cos(x)) <= Math.pow(2, -23), `cos ${x}`);
  }
  assert.strictEqual(M.sinf(1e10), -0.48750603199005127);
  assert.strictEqual(M.cosf(1e10), 0.8731196522712708);
});

test('log2f (musl table version): exact powers of two, specials, name-level boundaries', () => {
  for (let k = -149; k <= 127; k++) assert.strictEqual(M.log2f(Math.pow(2, k)), k, `2^${k}`);
  assert.ok(Object.is(M.log2f(1), 0));
  assert.strictEqual(M.log2f(0), -Infinity);
  assert.strictEqual(M.log2f(-0), -Infinity);
  assert.ok(Number.isNaN(M.log2f(-1)) && Number.isNaN(M.log2f(NaN)));
  assert.strictEqual(M.log2f(Infinity), Infinity);
  assert.strictEqual(M.log2f(3), 1.5849624872207642);
  assert.strictEqual(M.log2f(10), 3.321928024291992);
  assert.strictEqual(M.log2f(0.1), -3.321928024291992);
  assert.strictEqual(M.log2f(1e-40), -132.87713623046875);
  assert.strictEqual(M.log2f(123456.789), 16.913646697998047);
  // name level = clamp(ceil(log2f(onScreen / 15)) - 1, 0, 3): 30, 60, 120 px are the edges
  const level = (px) => Math.min(Math.max(Math.ceil(M.log2f(Math.fround(px / 15))) - 1, 0), 3);
  assert.deepStrictEqual([11, 30, 30.001, 60, 60.01, 120, 120.01, 900].map(level), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.strictEqual(M.log2f(Math.fround(30.000002 / 15)), 1.0000001192092896);
});

test('log2f stays within one f32 ulp of the exact value over every exponent', () => {
  const r = mulberry32(3);
  for (let i = 0; i < 200000; i++) {
    const x = fromBits(Math.floor(r() * 0x7f800000));
    const got = M.log2f(x); const want = Math.log2(x);
    assert.strictEqual(Math.fround(got), got);
    assert.ok(Math.abs(got - want) <= Math.max(Math.abs(want), 1) * Math.pow(2, -23), `x=${x}`);
  }
});

test('introsort gives the brief tie order on 40 nodes (a stable sort does not)', () => {
  const S = [10, 12, 10, 14, 100, 10, 12, 45];
  const nodes = [];
  for (let i = 1; i <= 40; i++) nodes.push({ id: i, s: S[i % 8] });
  const out = M.makeIntroSort(bySize)(nodes.slice()).map((n) => n.id).join(',');
  assert.strictEqual(out,
    '21,2,37,34,5,32,29,8,26,10,24,40,13,18,16,17,14,22,25,9,30,6,33,38,1,19,11,27,35,3,15,23,7,31,39,20,12,28,4,36');
  const stable = nodes.slice().sort((a, b) => a.s - b.s).map((n) => n.id);
  assert.strictEqual(stable.slice(0, 3).join(','), '2,5,8');
});

test('introsort sorts in place, returns the array, keeps every element, handles 0 to 5', () => {
  const sort = M.makeIntroSort(bySize);
  const r = mulberry32(11);
  for (let n = 0; n <= 70; n++) {
    for (let rep = 0; rep < 20; rep++) {
      const arr = [];
      for (let i = 0; i < n; i++) arr.push({ id: i, s: Math.floor(r() * (rep % 2 ? 4 : 1000)) });
      const before = arr.slice();
      assert.strictEqual(sort(arr), arr);
      for (let i = 1; i < n; i++) assert.ok(arr[i - 1].s <= arr[i].s);
      assert.deepStrictEqual(arr.slice().sort((a, b) => a.id - b.id), before);
    }
  }
});

test('introsort median-of-5 path (1200 tie-heavy nodes) gives the pinned order', () => {
  const r = mulberry32(7);
  const big = [];
  for (let i = 0; i < 1200; i++) big.push({ id: i, s: Math.floor(r() * 6) * 10 });
  const out = M.makeIntroSort(bySize)(big);
  assert.strictEqual(fnv(out.map((n) => n.id)), 'bc0a8f51');
  assert.strictEqual(out.slice(0, 8).map((n) => n.id).join(','), '0,1,1196,562,559,569,572,574');
});

test('introsort heap fallback (adversarial input) sorts and gives the pinned order', () => {
  // McIlroy's adversary builds an input that drives the quicksort phase to its depth limit.
  const n = 2000;
  const val = new Array(n).fill(-1);
  let solid = 0; let cand = 0;
  const lessAdv = (x, y) => {
    if (val[x] === -1 && val[y] === -1) { if (x === cand) val[x] = solid++; else val[y] = solid++; }
    if (val[x] === -1) cand = x; else if (val[y] === -1) cand = y;
    return (val[x] === -1 ? n : val[x]) < (val[y] === -1 ? n : val[y]);
  };
  M.makeIntroSort(lessAdv)([...Array(n).keys()]);
  for (let i = 0; i < n; i++) if (val[i] === -1) val[i] = solid++;
  const nodes = val.map((v, i) => ({ id: i, s: v % 7 }));
  const out = M.makeIntroSort(bySize)(nodes);
  for (let i = 1; i < n; i++) assert.ok(out[i - 1].s <= out[i].s);
  assert.strictEqual(fnv(out.map((x) => x.id)), '27465455');
  assert.strictEqual(out.slice(0, 8).map((x) => x.id).join(','), '0,1994,572,1987,4,579,6,1980');
});

test('shipped file carries no decompile line citations', () => {
  const src = require('fs').readFileSync(FILE, 'utf8');
  assert.ok(!/\b(dcmp|wat)\b|\bD \d{3,}|\bW \d{3,}|B\/dcmp|B\/wat/.test(src));
  assert.ok(!/Math\.random|Date\.now/.test(src));
});
