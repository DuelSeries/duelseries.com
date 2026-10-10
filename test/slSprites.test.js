// slSprites: the snake sprites, colour tables and setSkin of the slither.io redo, checked against
// the values THEIR code produces (spec/draw-snake.md section 9.2, vectors T1-T11, T13-T15, made by
// running their sprite builders and setSkin in a node vm with a recording fake canvas whose
// getImageData returns zeros). Every expected value is a literal copied from that spec and its
// fixtures; nothing is read from the reference folder at test time.
//
// T12 (`at2lt`) belongs to slDrawSnake and is tested there.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SP = require('../public/js/sl/slSprites.js');

function sha16(u8) {
  return crypto.createHash('sha256').update(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)).digest('hex').slice(0, 16);
}
function shaJ(v) { return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16); }
function px(d, w, x, y) { const p = (y * w + x) * 4; return Array.from(d.slice(p, p + 4)); }

// ---- fake canvas with the oracle's recording format: method calls [name, ...args], property
// writes ['=' + name, value], canvases in arguments as '<canvas WxH>', gradients as '<gradient>'.
// getImageData returns zeros; putImageData keeps a copy of the bytes; a 3-argument drawImage of a
// canvas with bytes copies them (so a body frame canvas holds its frame's bytes).
function makeDoc() {
  let serial = 0;
  const made = [];
  function label(v) { return v && v.__id ? '<canvas ' + v.width + 'x' + v.height + '>' : v; }
  function createElement(tag) {
    assert.strictEqual(tag, 'canvas', 'slSprites creates canvases only');
    let w = 300, h = 150;
    const cv = {
      __id: ++serial, __calls: [], __pixels: null, __sizes: [],
      get width() { return w; }, set width(v) { cv.__sizes.push(['width', v]); w = v; },
      get height() { return h; }, set height(v) { cv.__sizes.push(['height', v]); h = v; },
    };
    const store = {};
    const ctx = new Proxy(store, {
      get(t, p) {
        if (p === 'canvas') return cv;
        if (p === 'getImageData') return (x, y, ww, hh) => ({ width: ww, height: hh, data: new Uint8ClampedArray(ww * hh * 4) });
        if (p === 'putImageData') return (map) => { cv.__pixels = new Uint8ClampedArray(map.data); cv.__calls.push(['putImageData']); };
        if (p === 'createRadialGradient' || p === 'createLinearGradient') return (...args) => {
          cv.__calls.push([p].concat(args));
          return { __grad: true, addColorStop(o, c) { cv.__calls.push(['addColorStop', o, c]); } };
        };
        if (p in t) return t[p];
        return (...args) => {
          if (p === 'drawImage' && args.length === 3 && args[0] && args[0].__pixels && !cv.__pixels) cv.__pixels = new Uint8ClampedArray(args[0].__pixels);
          cv.__calls.push([p].concat(args.map(label)));
        };
      },
      set(t, p, v) {
        t[p] = v;
        cv.__calls.push(['=' + p, v && v.__id ? label(v) : (v && v.__grad ? '<gradient>' : v)]);
        return true;
      },
    });
    cv.getContext = (kind) => { assert.strictEqual(kind, '2d'); return ctx; };
    made.push(cv);
    return cv;
  }
  return { createElement, made };
}

function build(nsr) {
  const doc = makeDoc();
  const S = { slithers: [] };
  const food = [];
  SP.buildSprites(S, {
    document: doc, nsr,
    buildFoodSprites(o, i, rr, gg, bb) { food.push({ o, i, rr, gg, bb, at: S.per_color_imgs.length }); },
  });
  return { doc, S, food };
}
const B = build(false);
const BN = build(true);

// ---------------------------------------------------------------- expected values (fixtures)

const KFMC = ['6716ba1f3d1bd3a0', '50779ab6ff58ce23', '94c170b78dc757d0', '627f3d3cb97468e9', '882d972608c47d3c', '7262b993f2de99c3',
  'cdd06261cb5a4fdb', '0939b013c2c22971', '64d8726afdee15b0', '391d084456ac8d0c', '50779ab6ff58ce23', '391d084456ac8d0c', '0567c957c79219b8',
  'f72ed5bfbcf08acb', '9f184249711dfc88', 'e295c0c4d78fc0e9', 'd1db03c2dd6c5e59', '0293fb0901b9a0c8', '715e11ca0bb27186', 'b52dc5594c182fad',
  'b52dc5594c182fad', '837d1e8ac58aabf7', 'd9ee16930e3031fa', '8ac896e4487dff49', '60d290c76dbdb5bf', 'd107c9e283c9d51d', '627f3d3cb97468e9',
  'cf0b35996410cfe2', '0939b013c2c22971', '391d084456ac8d0c', 'e295c0c4d78fc0e9', '0939b013c2c22971', '882d972608c47d3c', '7262b993f2de99c3',
  '6716ba1f3d1bd3a0', '627f3d3cb97468e9', '0939b013c2c22971', '72fe52bd5a074c7f', '8f17c7991c13bf31', 'b326df2dd4e2d410', '5f13f2b5de905cce',
  'e295c0c4d78fc0e9'];
const KMCS = ['2b252f52ee47e8c8', 'f1e08afd0cdab452', '151a0b45695dc9dd', 'fae36cf4920e7be2', '59760f3afca3b4c2', '0ac75643b93a20bb',
  '89f1c1730340c875', '8f4c9f38451a9d55', 'ca1646669ccd585a', 'aa67683f677df009', 'f1e08afd0cdab452', '23c970d8b5ff95e8', '98866a10e9c90c5b',
  '7cfa05ba207fd456', 'da3faee1315dfc80', '0791eb0064d4bdd3', 'c2dd0569d0beeb8b', '62ef56a5235ac1c5', '51f3cd662d3a1ba4', '6a49db9dd774a6ca',
  '6a49db9dd774a6ca', '80c2519d59d9a993', '77ced07101a942e2', 'c1630f86915c57c8', 'fd208465629981b7', '5fbb6f6937abb3d4', 'abd957051e09ce3e',
  'e671d83271276ad3', '16335ca4f862abd5', 'ebed9280ec91f203', 'd380d3e58c711d29', 'a77950f38e9560e9', '763886b22ecd7dea', 'ceaf7a330d96a162',
  'e4e1b0e9a7937a4f', '91a572d07c3a6bee', '9ee4323653e0ac2e', '5286abeb3da529fd', '526d68b483366248', '31502b5cc50d9a20', 'ca8a4b28e8b434e2',
  'ca8fd5bf90e91be4'];
const KMCS_NSR = ['1dab04a914f714ed', 'c78f3b876d9e08da', 'a8bb74d720abe577', 'aeff1ab07b2be36b', '59611be27bddd40f', '7b39bb053070bec9',
  'ffb58f74241bf787', '37d5e64a933f4e3a', 'b480c1c158c3a95b', '07127da9b94a5368', 'c78f3b876d9e08da', 'eb15dcb55042cae3', 'ef643d909d7d2859',
  '050ca68d7e5aabdf', '50ed086f9a8962b5', 'c92ae82268635292', '171db8ac5aeeecc2', 'cb95de358900f49e', '555fdc5661d3f901', '1daa12f29894fbda',
  '1daa12f29894fbda', 'e5a1f369f03e5f1d', 'ff0b595be1c4af1a', '7e2b1c4833a3cda6', 'd2f880b96df27895', 'd2d83f23177770b3', '6f0a0f5d8b23326c',
  '2755ee7c920651ac', 'c90e686f57690b70', '254ed63ee82a8d8b', 'd380d3e58c711d29', 'a77950f38e9560e9', '763886b22ecd7dea', 'ceaf7a330d96a162',
  'e4e1b0e9a7937a4f', '91a572d07c3a6bee', '00468d2f9f7b8cc0', '3eb0a692eae91018', '57281ecd086a6b85', 'c124587928ce1366', 'ca8a4b28e8b434e2',
  'ca8fd5bf90e91be4'];
const CS = ['#c080ff', '#9099ff', '#80d0d0', '#80ff80', '#eeee70', '#ffa060', '#ff9090', '#ff4040', '#e030e0', '#ffffff', '#9099ff',
  '#505050', '#ffc050', '#288860', '#6475ff', '#7886ff', '#4854ff', '#a050ff', '#ffe040', '#3844ff', '#3844ff', '#4e23c0', '#ff5609',
  '#65c8e8', '#808490', '#3cc048', '#00ff53', '#d94545', '#ff4040', '#909090', '#2020f0', '#f02020', '#f0f020', '#f09020', '#f020f0',
  '#20f020', '#283cad', '#6880ff', '#000070', '#6828aa', '#000000', '#8080ff'];
const SIZES = {
  kdmc: [32, 32], komc: [52, 52], ksmc: [62, 62], jsebi: [64, 64], jsepi: [48, 48], ecmc: [48, 48], rabulb: [64, 64], cdbulb: [84, 84],
  cdbulb2: [84, 84], acbulb: [64, 64], kwkbulb: [172, 113], jmou: [79, 130], pwdbulb: [190, 188], sest: [105, 88], playbulb: [142, 149],
  bonkbulb: [173, 178], leafbulb: [143, 161], swissbulb: [140, 140], moldovabulb: [162, 137], vietnambulb: [137, 142],
  argentinabulb: [152, 152], movbulb: [142, 163],
};
const CALLS = {
  kdmc: [['=fillStyle', '#FF9966'], ['arc', 16, 16, 16, 0, 6.283185307179586], ['fill']],
  ecmc: [['=fillStyle', '#000000'], ['moveTo', 36, 6], ['lineTo', 30, 6], ['quadraticCurveTo', 0, 24, 30, 42], ['lineTo', 36, 42],
    ['quadraticCurveTo', 14, 24, 36, 6], ['fill']],
  rabulb: [['createRadialGradient', 32, 32, 1, 32, 32, 31], ['addColorStop', 0, 'rgba(255, 255, 255, 1)'],
    ['addColorStop', 0.83, 'rgba(150,150,150, 1)'], ['addColorStop', 0.84, 'rgba(80,80,80, 1)'], ['addColorStop', 0.99, 'rgba(80,80,80, 1)'],
    ['addColorStop', 1, 'rgba(80,80,80, 0)'], ['=fillStyle', '<gradient>'], ['fillRect', 0, 0, 64, 64]],
  cdbulb2: [['=fillStyle', '#ff5609'], ['fillRect', 13, 10, 29, 64], ['fillRect', 13, 10, 58, 22], ['fillRect', 13, 54, 58, 22]],
  cdbulb: [['=shadowColor', '#000000'], ['=shadowBlur', 20], ['drawImage', '<canvas 84x84>', 0, 0], ['drawImage', '<canvas 84x84>', 0, 0]],
  acbulb: [['createRadialGradient', 32, 32, 1, 32, 32, 31], ['addColorStop', 0, 'rgba(255, 128, 128, 1)'],
    ['addColorStop', 0.5, 'rgba(222, 3, 3, 1)'], ['addColorStop', 0.96, 'rgba(157, 18, 18, 1)'], ['addColorStop', 1, 'rgba(0,0,0, 0)'],
    ['=fillStyle', '<gradient>'], ['fillRect', 0, 0, 64, 64]],
  kwkbulb: [], jmou: [], sest: [],
};

// ---------------------------------------------------------------- T1-T9: pixel fills

test('T1 komc outline ring', () => {
  const d = SP.komcPixels(new Uint8ClampedArray(52 * 52 * 4));
  assert.deepStrictEqual(px(d, 52, 26, 10), [0, 0, 0, 204]);
  assert.deepStrictEqual(px(d, 52, 26, 26), [0, 0, 0, 0]);
  assert.deepStrictEqual(px(d, 52, 10, 26), [0, 0, 0, 204]);
  assert.deepStrictEqual(px(d, 52, 26, 12), [0, 0, 0, 102]);
  assert.deepStrictEqual(px(d, 52, 26, 6), [0, 0, 0, 0]);
  assert.deepStrictEqual(px(d, 52, 0, 0), [0, 0, 0, 0]);
  assert.strictEqual(sha16(d), '5f011963b303d28a');
});

test('T2 ksmc shadow', () => {
  const d = SP.ksmcPixels(new Uint8ClampedArray(62 * 62 * 4));
  const a = (x, y) => px(d, 62, x, y)[3];
  assert.strictEqual(a(31, 19), 63);
  assert.strictEqual(a(31, 31), 0);
  assert.strictEqual(a(31, 49), 63);
  assert.strictEqual(a(31, 34), 0);
  assert.strictEqual(a(16, 34), 63);
  assert.strictEqual(a(31, 9), 0);
  assert.strictEqual(sha16(d), '3a90329bb971b0fa');
});

test('T3 kfmc boost glow, all 42 colours', () => {
  const f = (i) => SP.kfmcPixels(new Uint8ClampedArray(62 * 62 * 4), i);
  assert.deepStrictEqual(px(f(0), 62, 31, 31), [120, 80, 159, 255]);
  assert.deepStrictEqual(px(f(0), 62, 31, 10), [120, 80, 159, 67]);
  assert.deepStrictEqual(px(f(0), 62, 0, 0), [120, 80, 159, 0]);
  assert.deepStrictEqual(px(f(7), 62, 31, 31), [239, 60, 60, 255]);
  assert.strictEqual(px(f(7), 62, 50, 40)[3], 67);
  assert.deepStrictEqual(px(f(26), 62, 31, 31), [90, 179, 90, 255]);
  assert.deepStrictEqual(px(f(38), 62, 31, 31), [0, 0, 255, 255]);
  assert.deepStrictEqual(px(f(40), 62, 31, 31), [90, 90, 90, 255]);
  assert.deepStrictEqual(px(f(9), 62, 31, 31), [120, 120, 120, 255]);
  const hashes = [];
  for (let i = 0; i < 42; i++) hashes.push(sha16(f(i)));
  hashes.forEach((h, i) => assert.strictEqual(h, KFMC[i], 'kfmc colour ' + i));
  assert.strictEqual(shaJ(hashes), 'ecad0e7ba9b57f80');
});

function kmcsRgb(i, j, x, y, nsr) {
  return px(SP.kmcsPixels(new Uint8ClampedArray(48 * 48 * 4), i, j, nsr), 48, x, y).slice(0, 3);
}

test('T4 kmcs body frame pixels (alpha untouched)', () => {
  const V = [[0, 0, 24, 24, 234, 156, 255], [0, 0, 24, 4, 114, 76, 151], [0, 0, 10, 30, 180, 120, 240], [0, 6, 24, 24, 149, 99, 198],
    [7, 0, 24, 24, 255, 78, 78], [7, 3, 24, 24, 255, 64, 64], [7, 6, 24, 24, 198, 49, 49], [7, 3, 30, 12, 182, 45, 45],
    [24, 0, 24, 24, 156, 161, 175], [24, 0, 40, 24, 131, 134, 143], [26, 2, 12, 20, 12, 229, 80], [27, 5, 35, 30, 158, 50, 50],
    [28, 0, 24, 24, 255, 64, 64], [28, 4, 24, 24, 177, 103, 180], [29, 0, 24, 24, 46, 46, 46], [29, 6, 40, 24, 41, 41, 41],
    [30, 0, 24, 24, 8, 8, 144], [30, 6, 24, 30, 73, 73, 255], [31, 3, 20, 20, 207, 41, 41], [32, 3, 20, 20, 161, 161, 43],
    [33, 3, 20, 20, 161, 90, 28], [34, 3, 20, 20, 161, 43, 161], [35, 3, 20, 20, 43, 161, 43], [36, 0, 24, 24, 211, 37, 86],
    [36, 17, 24, 20, 43, 55, 159], [36, 59, 30, 28, 179, 37, 90], [41, 1, 24, 24, 54, 58, 218], [40, 0, 24, 24, 0, 0, 0],
    [38, 0, 24, 24, 0, 0, 136]];
  for (const [i, j, x, y, r, g, b] of V) assert.deepStrictEqual(kmcsRgb(i, j, x, y, false), [r, g, b], `colour ${i} frame ${j} (${x},${y})`);
  const d = SP.kmcsPixels(new Uint8ClampedArray(48 * 48 * 4), 7, 0, false);
  for (let p = 3; p < d.length; p += 4) assert.strictEqual(d[p], 0, 'alpha is never written');
});

function kmcsHashes(nsr) {
  const out = [];
  for (let i = 0; i < 42; i++) {
    const h = crypto.createHash('sha256');
    const d = new Uint8ClampedArray(48 * 48 * 4);
    for (let j = 0; j < SP.kmcsFrameCount(i); j++) { SP.kmcsPixels(d, i, j, nsr); h.update(Buffer.from(d.buffer)); }
    out.push(h.digest('hex').slice(0, 16));
  }
  return out;
}

test('T5 kmcs all colours, all frames', () => {
  const a = kmcsHashes(false);
  a.forEach((h, i) => assert.strictEqual(h, KMCS[i], 'kmcs colour ' + i));
  assert.strictEqual(shaJ(a), '0e6c4648ce8ae478');
  const n = kmcsHashes(true);
  n.forEach((h, i) => assert.strictEqual(h, KMCS_NSR[i], 'kmcs nsr colour ' + i));
  assert.strictEqual(shaJ(n), 'fce7d093513eea64');
});

test('T6 kmcs with nsr', () => {
  assert.deepStrictEqual(kmcsRgb(0, 0, 24, 24, true), [234, 156, 255]);
  assert.deepStrictEqual(kmcsRgb(0, 0, 24, 4, true), [150, 100, 199]);
  assert.deepStrictEqual(kmcsRgb(7, 3, 30, 12, true), [198, 49, 49]);
});

test('T7 frame counts and loop flag', () => {
  for (const R of [B, BN]) {
    const pci = R.S.per_color_imgs;
    assert.strictEqual(pci.length, 42);
    pci.forEach((o, i) => {
      assert.strictEqual(o.kmcs.length, i === 36 ? 60 : 7, 'kmcs length ' + i);
      assert.strictEqual(o.kl, o.kmcs.length);
      assert.strictEqual(o.klp, i !== 36, 'klp ' + i);
      assert.deepStrictEqual(o.kmos, []);
    });
  }
});

test('T8 jsebi one-eye white (K7 next-pixel alpha)', () => {
  const d = SP.jsebiPixels(new Uint8ClampedArray(64 * 64 * 4));
  assert.deepStrictEqual(px(d, 64, 32, 32), [91, 255, 146, 255]);
  assert.deepStrictEqual(px(d, 64, 32, 0), [18, 64, 29, 0]);
  assert.deepStrictEqual(px(d, 64, 0, 32), [18, 64, 29, 85]);
  assert.deepStrictEqual(px(d, 64, 10, 32), [64, 227, 103, 255]);
  assert.deepStrictEqual(px(d, 64, 31, 5), [51, 181, 82, 255]);
  assert.deepStrictEqual(px(d, 64, 63, 32), [18, 64, 29, 0]);
  assert.deepStrictEqual(px(d, 64, 40, 40), [80, 255, 129, 255]);
  assert.deepStrictEqual(px(d, 64, 62, 32), [30, 107, 49, 85]);
  assert.strictEqual(sha16(d), '859ee380c8cec43e');
});

test('T9 jsepi one-eye pupil (alpha untouched)', () => {
  const d = SP.jsepiPixels(new Uint8ClampedArray(48 * 48 * 4));
  assert.deepStrictEqual(px(d, 48, 24, 24), [0, 0, 0, 0]);
  assert.deepStrictEqual(px(d, 48, 24, 2), [67, 140, 201, 0]);
  assert.deepStrictEqual(px(d, 48, 24, 12), [0, 0, 0, 0]);
  assert.deepStrictEqual(px(d, 48, 24, 18), [0, 0, 0, 0]);
  assert.deepStrictEqual(px(d, 48, 5, 24), [56, 123, 179, 0]);
  assert.deepStrictEqual(px(d, 48, 24, 6), [52, 117, 172, 0]);
  assert.strictEqual(sha16(d), '33f60bb5e30b7cba');
});

// ---------------------------------------------------------------- T10-T11: the canvas build

test('T10 sprite call lists and sizes', () => {
  for (const name of Object.keys(CALLS)) assert.deepStrictEqual(B.S[name].__calls, CALLS[name], name);
  for (const name of Object.keys(SIZES)) {
    assert.deepStrictEqual([B.S[name].width, B.S[name].height], SIZES[name], name + ' size');
    assert.strictEqual(SP[name], BN.S[name], name + ' export follows the latest build');
  }
  for (const name of ['komc', 'ksmc', 'jsebi', 'jsepi']) assert.strictEqual(B.S[name].__calls[B.S[name].__calls.length - 1][0], 'putImageData');
  assert.deepStrictEqual(B.S.jsebi.__calls.slice(0, 4), [['=fillStyle', '#ffffff'], ['beginPath'], ['arc', 32, 32, 32, 0, 6.283185307179586], ['fill']]);
  assert.deepStrictEqual(B.S.jsepi.__calls.slice(0, 4), [['=fillStyle', '#ffffff'], ['beginPath'], ['arc', 24, 24, 24, 0, 6.283185307179586], ['fill']]);
  assert.deepStrictEqual(B.S.komc.__calls, [['putImageData']]);
  // the bytes on the built canvases are the pure fills
  assert.strictEqual(sha16(B.S.komc.__pixels), '5f011963b303d28a');
  assert.strictEqual(sha16(B.S.ksmc.__pixels), '3a90329bb971b0fa');
  assert.strictEqual(sha16(B.S.jsebi.__pixels), '859ee380c8cec43e');
  assert.strictEqual(sha16(B.S.jsepi.__pixels), '33f60bb5e30b7cba');
});

test('T11 star overlays on colours 10, 19, 20', () => {
  const frame = (R, i, f) => R.S.per_color_imgs[i].kmcs[f].__calls;
  assert.strictEqual(frame(B, 10, 3).length, 46);
  assert.strictEqual(frame(B, 19, 3).length, 91);
  assert.strictEqual(frame(B, 20, 3).length, 73);
  assert.strictEqual(frame(BN, 10, 3).length, 121);
  assert.strictEqual(frame(BN, 19, 3).length, 271);
  assert.strictEqual(frame(BN, 20, 3).length, 271);
  assert.strictEqual(shaJ(frame(B, 10, 3)), '67cb76df17f90a7e');
  assert.strictEqual(shaJ(frame(B, 19, 3)), '6c929a33683dc4dd');
  assert.strictEqual(shaJ(frame(B, 20, 3)), '34b917a74f99499a');
  assert.strictEqual(shaJ(frame(BN, 10, 3)), 'dd7e026408a6c23b');
  assert.strictEqual(shaJ(frame(BN, 19, 3)), '18f1b7129300d89b');
  assert.strictEqual(shaJ(frame(BN, 20, 3)), '224e8c9233195182');
  assert.strictEqual(shaJ(frame(B, 10, 0)), '67cb76df17f90a7e');
  assert.strictEqual(shaJ(frame(B, 19, 0).slice(0, 18)), 'e4c3077121390822');
  assert.strictEqual(shaJ(frame(B, 20, 0).slice(0, 18)), '220f4f26e378ab42');
  assert.deepStrictEqual(frame(B, 20, 0).slice(0, 8), [['drawImage', '<canvas 48x48>', 0, 0], ['save'], ['=globalAlpha', 0.7],
    ['=fillStyle', '#FFFFFF'], ['beginPath'], ['moveTo', 40.82583139031147, 12.538187580296773], ['lineTo', 41.96017727512383, 14.12520776148645],
    ['lineTo', 40.10029923440517, 13.536796922406685]]);
  assert.deepStrictEqual(frame(B, 0, 0), [['drawImage', '<canvas 48x48>', 0, 0]]);
  assert.strictEqual(frame(B, 10, 0).filter((c) => c[0] === 'fill').length, 3);
  assert.strictEqual(frame(BN, 10, 0).filter((c) => c[0] === 'fill').length, 8);
});

test('build: body frame bytes and glow bytes on the canvases equal the pure fills', () => {
  for (const [R, ref] of [[B, KMCS], [BN, KMCS_NSR]]) {
    R.S.per_color_imgs.forEach((o, i) => {
      const h = crypto.createHash('sha256');
      o.kmcs.forEach((k) => h.update(Buffer.from(k.__pixels.buffer)));
      assert.strictEqual(h.digest('hex').slice(0, 16), ref[i], 'built kmcs colour ' + i);
      assert.strictEqual(sha16(o.kfmc.__pixels), KFMC[i], 'built kfmc colour ' + i);
    });
  }
});

test('build: canvas creation order, sizes and size-write order (their load order)', () => {
  const made = B.doc.made;
  const sq = (n) => [n, n, 'h'];
  const rect = (w, h) => [w, h, 'w'];
  const want = [sq(48), sq(32), sq(52), sq(62), sq(64), sq(48), sq(64), rect(84, 84), rect(84, 84), sq(64),
    rect(172, 113), rect(79, 130), rect(190, 188), rect(105, 88), rect(142, 149), rect(173, 178), rect(143, 161), rect(140, 140),
    rect(162, 137), rect(137, 142), rect(152, 152), rect(142, 163)];
  for (let i = 0; i < 42; i++) {
    want.push(sq(62), sq(48));
    for (let j = 0; j < (i === 36 ? 60 : 7); j++) want.push(sq(48));
  }
  assert.strictEqual(made.length, want.length);
  assert.strictEqual(made.length, 453);
  made.forEach((c, n) => {
    const [w, h, first] = want[n];
    assert.deepStrictEqual([c.width, c.height], [w, h], 'canvas ' + n);
    // `c.width = c.height = n` writes height first; separate statements write width first
    assert.strictEqual(c.__sizes[0][0], first === 'h' ? 'height' : 'width', 'size write order of canvas ' + n);
    assert.strictEqual(c.__sizes.length, 2);
  });
  // order of the named sprites
  const names = ['ecmc', 'kdmc', 'komc', 'ksmc', 'jsebi', 'jsepi', 'rabulb', 'cdbulb', 'cdbulb2', 'acbulb', 'kwkbulb', 'jmou', 'pwdbulb',
    'sest', 'playbulb', 'bonkbulb', 'leafbulb', 'swissbulb', 'moldovabulb', 'vietnambulb', 'argentinabulb', 'movbulb'];
  names.forEach((name, n) => assert.strictEqual(made[n], B.S[name], name));
  // the scratch disc of each colour: no beginPath on a fresh context, one getImageData, then a put per frame
  const kmc0 = made[23];
  assert.deepStrictEqual(kmc0.__calls.slice(0, 3), [['=fillStyle', '#FFFFFF'], ['arc', 24, 24, 24, 0, 6.283185307179586], ['fill']]);
  assert.strictEqual(kmc0.__calls.length, 3 + 7);
  // picture canvases: never drawn
  for (const name of names.slice(10)) assert.deepStrictEqual(B.S[name].__calls, []);
});

test('build: per-colour objects, food hook and S binding', () => {
  const pci = B.S.per_color_imgs;
  assert.strictEqual(SP.per_color_imgs, BN.S.per_color_imgs, 'export follows the latest build');
  assert.deepStrictEqual(pci.map((o) => o.cs), CS);
  assert.deepStrictEqual(Object.keys(pci[0]), ['imgs', 'fws', 'fhs', 'fw2s', 'fh2s', 'gimgs', 'gfws', 'gfhs', 'gfw2s', 'gfh2s', 'oimgs',
    'ofws', 'ofhs', 'ofw2s', 'ofh2s', 'cs', 'kfmc', 'kmcs', 'kmos', 'kl', 'klp']);
  assert.strictEqual(B.food.length, 10);
  B.food.forEach((f, i) => {
    assert.strictEqual(f.i, i);
    assert.strictEqual(f.o, pci[i]);
    assert.strictEqual(f.at, i + 1, 'called right after the push');
    assert.deepStrictEqual([f.rr, f.gg, f.bb], [SP.rrs[i], SP.ggs[i], SP.bbs[i]]);
  });
  for (const k of ['rrs', 'ggs', 'bbs', 'ccs', 'ccvs', 'csks', 'ralcsc', 'falcsc', 'alcsc', 'max_skin_cv']) assert.strictEqual(B.S[k], SP[k], k);
  assert.strictEqual(B.S.kfmc, undefined, 'kfmc lives on the colour objects only');
});

test('buildSprites accepts (opts with S), and (S) with DuelSlither.S and the page document', () => {
  const D = globalThis.DuelSlither;
  const doc = makeDoc();
  const S1 = {};
  SP.buildSprites({ S: S1, document: doc, nsr: false, buildFoodSprites() {} });
  assert.strictEqual(S1.per_color_imgs.length, 42);
  const hadS = D.S, hadDoc = globalThis.document, hadDW = D.slDrawWorld;
  const S2 = { slithers: [], nsr: true };
  const calls = [];
  try {
    D.S = S2;
    globalThis.document = makeDoc();
    D.slDrawWorld = { buildFoodSprites(o, i) { calls.push(i); } };
    SP.buildSprites(S2);
    assert.strictEqual(S2.per_color_imgs[10].kmcs[0].__calls.length, 121, 'nsr taken from S');
    assert.deepStrictEqual(calls, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'slDrawWorld.buildFoodSprites looked up at call time');
  } finally {
    D.S = hadS;
    if (hadDoc === undefined) delete globalThis.document; else globalThis.document = hadDoc;
    D.slDrawWorld = hadDW;
  }
});

// ---------------------------------------------------------------- tables, setSkin

test('tables (game.js:3325-3354)', () => {
  assert.strictEqual(SP.rrs.length, 42);
  assert.strictEqual(SP.ggs.length, 42);
  assert.strictEqual(SP.bbs.length, 42);
  assert.deepStrictEqual(SP.ccs, CS);
  SP.ccvs.forEach((v, i) => assert.strictEqual(v, SP.rrs[i] << 16 | SP.ggs[i] << 8 | SP.bbs[i]));
  assert.strictEqual(SP.ccvs[0], 0xc080ff);
  assert.strictEqual(SP.csks.length, 39);
  assert.deepStrictEqual(SP.csks.slice(34), [34, 35, 37, 39, 41]);
  assert.ok(SP.ralcsc instanceof Uint8Array && SP.ralcsc.length === 256);
  assert.strictEqual(SP.alcsc, SP.ralcsc);
  assert.strictEqual(SP.ralcsc.reduce((a, b) => a + b, 0), 39);
  assert.strictEqual(SP.falcsc.reduce((a, b) => a + b, 0), 40);
  assert.strictEqual(SP.ralcsc[40], 0);
  assert.strictEqual(SP.falcsc[40], 1);
  assert.strictEqual(SP.ralcsc[36], 0);
  assert.strictEqual(SP.max_skin_cv, 64);
});

function scal(o) {
  const r = {};
  for (const k in o) { const v = o[k], t = typeof v; if (t === 'number' || t === 'boolean' || v === null || (t === 'string' && v.length <= 80)) r[k] = v; }
  return r;
}

test('T13 setSkin sweep over cv 0..255', () => {
  const sweep = [];
  for (let cv = 0; cv <= 255; cv++) {
    const o = { xx: 100, yy: 200 };
    SP.setSkin(o, cv, null);
    sweep.push({ s: scal(o), rbcs: o.rbcs, keys: Object.keys(o).join(','), at: o.atx ? Array.from(o.atx).length : 0 });
  }
  assert.strictEqual(sweep[0].keys, 'xx,yy,rcv,er,pr,pma,ec,ecv,eca,ppa,ppc,ppcv,antenna,one_eye,drez,ed,esp,easp,eac,jyt,jse,slg,eo,swell,cusk,rbcs,cv,fdhc,fdtc,fdl');
  assert.deepStrictEqual(sweep[24], {
    s: { xx: 100, yy: 200, rcv: 24, er: 6, pr: 3.5, pma: 2.3, ec: '#FFFFFF', ecv: 16777215, eca: 0.75, ppa: 1, ppc: '#000000', ppcv: 0,
      antenna: true, one_eye: false, drez: false, ed: 6, esp: 6, easp: 0.1, eac: false, jyt: false, jse: false, slg: false, eo: 0, swell: 0,
      cusk: false, atba: 0, atc1: '#00688c', atc2: '#64c8e7', atwg: true, atia: 0.35, abrot: false, blbx: -10, blby: -10, blbw: 20, blbh: 20,
      bsc: 1, blba: 0.75, cv: 23, fdhc: null, fdtc: null, fdl: 0 },
    rbcs: [23, 23, 23, 23, 23, 23, 23, 23, 23, 18, 18, 18, 18, 18, 18, 18, 18, 18],
    keys: 'xx,yy,rcv,er,pr,pma,ec,ecv,eca,ppa,ppc,ppcv,antenna,one_eye,drez,ed,esp,easp,eac,jyt,jse,slg,eo,swell,cusk,atba,atc1,atc2,atwg,atia,abrot,atx,aty,atvx,atvy,atax,atay,bulb,blbx,blby,blbw,blbh,bsc,blba,rbcs,cv,fdhc,fdtc,fdl',
    at: 8,
  });
  assert.strictEqual(sweep[45].s.blbx, -32.11);
  assert.ok(!sweep[25].keys.includes('atwg'), 'skin 25 has no atwg');
  assert.strictEqual(sweep[27].keys.split(',').slice(25).join(','), 'ebi,ebiw,ebih,ebisz,epi,epiw,epih,episz,rbcs,cv,fdhc,fdtc,fdl');
  assert.deepStrictEqual([sweep[60].s.drez, sweep[60].s.cv, sweep[60].s.fdhc, sweep[60].s.fdtc, sweep[60].s.fdl], [true, 36, 37, 38, 30]);
  assert.deepStrictEqual([sweep[49].at, sweep[59].at, sweep[25].at], [11, 11, 9]);
  assert.deepStrictEqual([sweep[66].s.cv, sweep[200].s.cv, sweep[255].s.cv, sweep[66].rbcs], [66 % 9, 200 % 9, 255 % 9, null]);
  assert.strictEqual(shaJ(sweep), '4d17c43d875c363e');
});

test('setSkin: antenna and eye objects come from the latest build', () => {
  const o = { xx: 1.1, yy: 2 };
  SP.setSkin(o, 24, null);
  assert.strictEqual(o.bulb, SP.acbulb);
  assert.ok(o.atx instanceof Float32Array && o.atx[0] === Math.fround(1.1) && o.aty[7] === 2);
  assert.ok(o.atax instanceof Float32Array && o.atay.length === 8);
  const e = { xx: 0, yy: 0 };
  SP.setSkin(e, 27, null);
  assert.strictEqual(e.ebi, SP.jsebi);
  assert.strictEqual(e.epi, SP.jsepi);
  const k = { xx: 0, yy: 0 };
  SP.setSkin(k, 25, null);
  assert.strictEqual(k.bulb, SP.cdbulb);
  assert.deepStrictEqual([k.ec, k.ecv, k.eca], ['#FF5609', 16733705, 1]);
});

test('setSkin: every call gets its own rbcs array', () => {
  const a = { xx: 0, yy: 0 }, b = { xx: 0, yy: 0 };
  SP.setSkin(a, 21, null);
  SP.setSkin(b, 21, null);
  assert.notStrictEqual(a.rbcs, b.rbcs);
  assert.deepStrictEqual(a.rbcs, [3, 3, 3, 3, 3, 3, 3, 18, 18, 18, 18, 18, 18, 20, 19, 20, 19, 20, 19, 20, 18, 18, 18, 18, 18, 18]);
});

test('T14 custom skin bytes', () => {
  const o = { xx: 0, yy: 0 };
  SP.setSkin(o, 3, [0, 0, 0, 0, 0, 0, 0, 0, 3, 7, 2, 11]);
  assert.deepStrictEqual([o.cusk, o.rbcs, o.cv, o.rcv], [true, [7, 7, 7, 11, 11], 7, 3]);
  assert.deepStrictEqual([o.fdhc, o.fdtc, o.fdl], [null, null, 0]);
  assert.strictEqual(Object.keys(o).slice(-6).join(','), 'cusk,rbcs,cv,fdhc,fdtc,fdl');
  const p = { xx: 0, yy: 0 };
  SP.setSkin(p, 3, [0, 0, 0, 0, 0, 0, 0, 0, 2, 36, 1, 40, 2, 5]);
  assert.deepStrictEqual([p.cusk, p.rbcs, p.cv], [true, [5, 5], 5]);
  const q = { xx: 0, yy: 0 };
  SP.setSkin(q, 3, [0, 0, 0, 0, 0, 0, 0, 0, 3]);
  assert.deepStrictEqual([q.cusk, q.rbcs, q.cv], [false, null, 3]);
  // a list of only disallowed colours falls back to the plain skin
  const r = { xx: 0, yy: 0 };
  SP.setSkin(r, 24, [0, 0, 0, 0, 0, 0, 0, 0, 4, 36, 9]);
  assert.deepStrictEqual([r.cusk, r.cv, r.antenna, r.rbcs.length], [false, 23, true, 18]);
  // an odd trailing count byte is dropped
  const s = { xx: 0, yy: 0 };
  SP.setSkin(s, 3, new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 2, 9, 3]));
  assert.deepStrictEqual([s.cusk, s.rbcs, s.cv], [true, [9, 9], 9]);
});

test('T15 colour jitter inputs: tables give the newSlither colours with rand() .5', () => {
  const hex = (c) => ('00' + Math.min(255, Math.max(0, Math.round(c))).toString(16)).slice(-2);
  const rows = [[0, 202, 138, 255, '#ca8aff'], [7, 255, 74, 74, '#ff4a4a'], [9, 255, 74, 74, '#ff4a4a'], [60, 50, 70, 183, '#3246b7']];
  for (const [skin, r, g, b, cs] of rows) {
    const o = { xx: 0, yy: 0 };
    SP.setSkin(o, skin, null);
    const cv = o.cv;
    const rr = Math.min(255, SP.rrs[cv] + Math.floor(0.5 * 20));
    const gg = Math.min(255, SP.ggs[cv] + Math.floor(0.5 * 20));
    const bb = Math.min(255, SP.bbs[cv] + Math.floor(0.5 * 20));
    assert.deepStrictEqual([rr, gg, bb], [r, g, b], 'skin ' + skin);
    assert.strictEqual('#' + hex(rr) + hex(gg) + hex(bb), cs);
  }
});

test('source rules: no Math.random, no devicePixelRatio, no smoothing switch, no DOM at load', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'sl', 'slSprites.js'), 'utf8');
  assert.ok(!/Math\.random/.test(src));
  assert.ok(!/devicePixelRatio/.test(src));
  assert.ok(!/imageSmoothingEnabled/.test(src));
  assert.ok(!/slither-reference/.test(src));
  assert.ok(!/\*\*/.test(src.replace(/\/\/.*$/gm, '')));
  assert.ok(!/Math\.hypot/.test(src));
  assert.ok(!src.includes(String.fromCharCode(0x2014)), 'no em dashes');
  // requiring the module created no canvas: B and BN made every canvas through their fake documents
  assert.strictEqual(typeof globalThis.document, 'undefined');
});
