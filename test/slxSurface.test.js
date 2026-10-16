'use strict';
// The layer's surface grep (SERVER-DESIGN 15.1, 15.6 item 5, 16.2 launch path; task T16). Every file in
// public/js/slx/ may touch the frozen client only through the seams of 15.1, and public/css/slx.css styles only
// .slx-* classes. The rules are read off the code (comments stripped), so a later layer file is held to them too.
//
// Convention the grep relies on: each layer file is one IIFE over `root` that names the frozen namespace once, as
// `var D = root.DuelSlither;`, and reaches their state as `D.S` or a local `S`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'public/js/slx');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).sort();
const RAW = FILES.map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);
const CSS = fs.readFileSync(path.join(ROOT, 'public/css/slx.css'), 'utf8');
const EM_DASH = String.fromCharCode(0x2014);

// Comments out, strings and regex literals kept (enough for this code: no regex literal holds a quote or a slash pair).
function code(src) {
  let out = '';
  let q = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      out += c;
      if (c === '\\') { out += src[++i] || ''; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 1; continue; }
    if (c === '\'' || c === '"' || c === '`') q = c;
    out += c;
  }
  return out;
}
const CODE = RAW.map(([f, s]) => [f, code(s)]);

// SERVER-DESIGN 15.1: what the layer may read and write on S. Read-only beyond the 15.1 list, because the design
// needs them: slithers (15.3 rings: a ring is drawn only while that snake exists in their list) and lagging (12.2:
// sl:diag reports lag-mode entries).
const READ_S = ['slither', 'dead_mtm', 'playing', 'connected', 'view_xx', 'view_yy', 'gsc', 'csc', 'mww', 'mhh', 'ww', 'hh',
  'is_mobile', 'lastscore', 'vcm', 'slithers', 'lagging'];
// slxPaid.js alone also reads their food store, foods with foods_c (PAID-SL-DESIGN 9, the gold rule: a glint on every
// food whose sz is at least 13.6, their client's rad byte / 5, slApply.js newFood). Any other layer file that walked
// it would add a per-frame cost to the free page, so the carve-out is this one file (review ENG-3).
const PAID_READ_S = ['foods', 'foods_c'];
// slxBr.js alone reads their minimap geometry, the way their own dot is placed (slHud.js oefDot), to draw the battle
// royale's circle on it: read only, and only on an event page.
const BR_READ_S = ['myloc', 'mmrad', 'flux_grd', 'grd'];
// slxHud.js alone reads their HUD boxes (Owen 2026-10-16: their board and length box hidden, the shared board filled
// from their rows, the stats line under the minimap): the element references only, never a field of their state and
// never their slHud module, and it writes only inline styles their client never writes (slxHud.js header).
const HUD_READ_S = ['lbh', 'lbs', 'lbn', 'lbp', 'lbf', 'loch'];
// slxCard.js alone reads their best rank this connection (slApply.js:768), read only, for the shared card's Top rank
// (Owen 2026-10-16: time, rank and length on every game's card). No other seam carries it: their HUD never shows it.
const CARD_READ_S = ['best_rank'];
const WRITE_S = ['render_mode', 'xm', 'ym'];
// The 12 blank picture canvases (public/js/sl/slSprites.js:411-424), drawn into once each (Q3, T18).
const PICTURE_S = ['kwkbulb', 'jmou', 'pwdbulb', 'sest', 'playbulb', 'bonkbulb', 'leafbulb', 'swissbulb', 'moldovabulb',
  'vietnambulb', 'argentinabulb', 'movbulb'];
const SLITHER_FIELDS = ['ang', 'sct', 'fam', 'rsc', 'xx', 'yy', 'id', 'kill_count'];
// DuelSlither members, and the one member each frozen module may be used for. slMain.nick is read only: the name their
// Play kept (public/js/sl/slMain.js:99), for the results card's Play again.
const D_MEMBERS = { slx: null, S: null, play: null, stats: null, slNet: ['makeSocketIoTransport'], slWire: ['decodeInput'],
  slLoop: ['hooks'], slInput: ['setAcceleration'], slMain: ['nick'] };
const HOOKS = ['onMenuShow', 'onMenuFade', 'onMenuDone'];
const LAYER_EVENTS = ['sl:x', 'sl:hold', 'sl:vis', 'sl:chat', 'sl:diag'];
// slxNet.js alone is also the resumable transport (SERVER-DESIGN 9.6, through the DuelSlitherConfig.transport seam;
// task T16b): after a blip it carries the life on its own socket, so it names sl:back and their sl:f, sl:i and sl:leave
// there, and uses their wire for the held input and the resumed bundles.
const NET_EVENTS = ['sl:back', 'sl:f', 'sl:i', 'sl:leave'];
const NET_MEMBERS = { slWire: ['decodeBundle', 'encodeInput'] };

test('the layer folder holds T16 base files at least, each one IIFE over root', () => {
  for (const f of ['slxNet.js', 'slxMain.js', 'slxDirect.js']) assert.ok(FILES.includes(f), f);
  for (const [f, s] of CODE) {
    assert.ok(/^\s*\(function \(root\) \{\s*'use strict';/.test(s), f + ' starts as the layer IIFE');
    assert.ok(/\}\)\(typeof window !== 'undefined' \? window : globalThis\);\s*$/.test(s), f + ' ends as the layer IIFE');
  }
});

test('no Math.random, no em dash, no reference-side path, no data-sl in the layer', () => {
  for (const [f, s] of RAW) {
    assert.ok(!/Math\s*\.\s*random/.test(s), f + ': Math.random (the goldens seed the client\'s only random source)');
    assert.ok(!s.includes(EM_DASH), f + ': em dash');
    assert.ok(!/slither-reference/.test(s), f + ': reference path');
    assert.ok(!/data-sl/.test(code(s)), f + ': data-sl');
  }
  assert.ok(!CSS.includes(EM_DASH), 'slx.css: em dash');
});

test('DuelSlither is named once per file, as the D alias; other files check slx.active first', () => {
  for (const [f, s] of CODE) {
    const all = s.match(/\bDuelSlither\b(?!Config)/g) || [];
    assert.strictEqual(all.length, 1, f + ' names DuelSlither once');
    assert.ok(s.includes('var D = root.DuelSlither;'), f);
    if (f !== 'slxNet.js') assert.ok(/if \(!D \|\| !D\.slx \|\| !D\.slx\.active\) return;/.test(s), f + ' is inert unless active');
  }
});

test('frozen members: only the 15.1 seams', () => {
  for (const [f, s] of CODE) {
    for (const m of s.matchAll(/\bD\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
      assert.ok(Object.prototype.hasOwnProperty.call(D_MEMBERS, m[1]), f + ': D.' + m[1]);
      const only = D_MEMBERS[m[1]];
      const net = f === 'slxNet.js' && NET_MEMBERS[m[1]] ? NET_MEMBERS[m[1]] : [];
      if (only && m[2]) assert.ok(only.includes(m[2]) || net.includes(m[2]), f + ': D.' + m[1] + '.' + m[2]);
    }
    for (const m of s.matchAll(/\bS\.([A-Za-z_$][\w$]*)/g)) {
      assert.ok(READ_S.includes(m[1]) || WRITE_S.includes(m[1]) || PICTURE_S.includes(m[1]) ||
        (f === 'slxPaid.js' && PAID_READ_S.includes(m[1])) || (f === 'slxBr.js' && BR_READ_S.includes(m[1])) ||
        (f === 'slxHud.js' && HUD_READ_S.includes(m[1])) || (f === 'slxCard.js' && CARD_READ_S.includes(m[1])),
        f + ': S.' + m[1]);
    }
    for (const m of s.matchAll(/\bS\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) assert.ok(WRITE_S.includes(m[1]), f + ': writes S.' + m[1]);
    for (const m of s.matchAll(/\bslither\.([A-Za-z_$][\w$]*)/g)) assert.ok(SLITHER_FIELDS.includes(m[1]), f + ': slither.' + m[1]);
    for (const m of s.matchAll(/\bhooks\.([A-Za-z_$][\w$]*)/g)) assert.ok(HOOKS.includes(m[1]), f + ': hooks.' + m[1]);
    for (const m of s.matchAll(/'(on[A-Z]\w*)'/g)) assert.ok(HOOKS.includes(m[1]), f + ': hook name ' + m[1]);
    // a computed S key only where the picture canvases are painted by name (SERVER-DESIGN 15.5)
    if (f !== 'slxSkins.js') assert.ok(!/\bS\[/.test(s), f + ': S by a computed key');
  }
});

test('globals: only DuelSlitherConfig and io are written; innerHTML only ever set to fixed text (names go in as text)', () => {
  for (const [f, s] of CODE) {
    for (const m of s.matchAll(/\broot\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
      assert.ok(['DuelSlitherConfig', 'io'].includes(m[1]), f + ': writes root.' + m[1]);
    }
    for (const m of s.matchAll(/\.innerHTML\s*=(?!=)\s*([^;]*);/g)) {
      assert.ok(/^(?:'[^'\\]*'\s*\+\s*)*'[^'\\]*'$/.test(m[1].trim()), f + ': innerHTML from a value: ' + m[1].slice(0, 60));
    }
    assert.ok(!/\bouterHTML\b|insertAdjacentHTML|document\.write/.test(s), f + ': HTML from a string');
    assert.ok(!/\beval\s*\(|new Function\b/.test(s), f + ': eval');
  }
});

test('socket events: the layer names only sl:x and its own four emits, never their sl:join, sl:i, sl:f or sl:leave', () => {
  for (const [f, s] of CODE) {
    for (const m of s.matchAll(/'(sl:[\w:-]*)'/g)) {
      assert.ok(LAYER_EVENTS.includes(m[1]) || (f === 'slxNet.js' && NET_EVENTS.includes(m[1])), f + ': ' + m[1]);
    }
  }
});

// slxPaid.js is the one file that IS the paid hand-off (PAID-SL-DESIGN 9; the same carve-out as test/slLobbySwap.test.js):
// it reads the lobby's token, stake and nonce at boot and posts one message, duel:restake, for Play again. It is held
// to that instead: no other post, never a signature, a widget launch, a resume key, the escrow or Privy.
const PAID_FILE = 'slxPaid.js';

// The battle royale's page (server/slBr) signs two things through the lobby's bridge and nothing else: the player's
// own identity for the prize (play:identify) and the owner's Start match (br:start, checked at /api/owner/do).
const BR_FILE = 'slxBr.js';
test('the battle royale layer posts only duel:signaction, signs only play:identify and br:start, and holds no money', () => {
  const br = CODE.find(([f]) => f === BR_FILE);
  assert.ok(br, BR_FILE + ' is in the layer');
  const posts = [...br[1].matchAll(/postMessage\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  assert.deepStrictEqual(posts, ['{ type: \'duel:signaction\''], BR_FILE + ' posts duel:signaction only');
  const signs = [...br[1].matchAll(/\bsign\('([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual([...new Set(signs)], ['br:start', 'play:identify']);
  assert.ok(!/entryToken|entrySol|\bstake\b|resumeKey|duel:restake|duel:play|escrow|privy/i.test(br[1]), BR_FILE + ': money word');
});

test('no money: posts only game:done, never reads an entry token, a stake or the paid hand-off (slxPaid.js aside)', () => {
  for (const [f, s] of CODE) {
    if (f === PAID_FILE || f === BR_FILE) continue;
    for (const m of s.matchAll(/postMessage\(\s*([^,)]+)/g)) assert.strictEqual(m[1].trim(), '\'game:done\'', f + ': posts ' + m[1]);
    assert.ok(!/entryToken|entrySol|\bstake\b|resumeKey|duel:restake|duel:signaction|duel:play|wallet|escrow|privy/i.test(s), f + ': money word');
  }
  const paid = CODE.find(([f]) => f === PAID_FILE);
  assert.ok(paid, PAID_FILE + ' is in the layer');
  const posts = [...paid[1].matchAll(/postMessage\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  assert.deepStrictEqual(posts, ['{ type: \'duel:restake\''], PAID_FILE + ' posts duel:restake only');
  assert.ok(!/resumeKey|duel:signaction|duel:play\b|escrow|privy/i.test(paid[1]), PAID_FILE + ': money word');
});

test('slx.css: every selector is an .slx-* class (their page is quirks mode and theirs alone)', () => {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const sels = [...css.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((sel) => !sel.startsWith('@'));
  assert.ok(sels.length >= 6);
  for (const sel of sels) {
    for (const one of sel.split(',')) assert.ok(/^\.slx-[a-z][\w-]*(?::{1,2}[a-z-]+)*$/.test(one.trim()), 'selector ' + one.trim());
  }
  assert.ok(!/!important/.test(css));
});
