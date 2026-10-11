'use strict';
// slNames (SERVER-DESIGN 12.3, 18.1; task T11): cleanNick equals what the FROZEN client itself sends in sl:join, its
// openNick (public/js/sl/slNet.js) then gdnm (public/js/sl/slApply.js), on 50,000 seeded fuzz names, plus the design's
// literal vectors. The frozen files are run unchanged in a vm: slNet.connect with a stand-in transport, so their own
// onOpen applies openNick and gdnm and hands the name to transport.join.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { cleanNick, asciize, gdnm, nameMax, BOT_NAMES } = require('../server/sl/slNames');
const { LAWS } = require('../server/sl/slLaws');
const { createRng } = require('../server/sl/slRng');
const slBots = require('../server/sl/slBots');

// The frozen client's name path: what its transport.join receives for a typed name.
function frozenJoinName() {
  const ctx = { console };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['shared/slCore.js', 'public/js/sl/slApply.js', 'public/js/sl/slNet.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  const D = ctx.DuelSlither;
  const S = {};
  D.slApply.initApplyState(S);
  S.adm = false;
  D.S = S;
  const realApply = D.slApply;
  D.slApply = Object.assign({}, realApply, { resetGame() {} });
  D.slLoop = { now: () => 0, onSocketOpen() {} };
  D.slMain = { nick: '' };
  let joined;
  ctx.DuelSlitherConfig = {
    transport: (h) => ({ open() { h.onOpen(); }, join(n) { joined = n; }, send() {}, close() {} }),
  };
  return (raw) => {
    joined = undefined;
    D.slMain.nick = raw;
    D.slNet.connect();
    return joined;
  };
}

test('the design vectors (SERVER-DESIGN 18.1)', () => {
  assert.strictEqual(cleanNick('GameWeek2016'), '', 'their open code, any case');
  assert.strictEqual(cleanNick('gameweek2016'), '');
  assert.strictEqual(cleanNick('abcdefghijklmnopqrstuvwxyz1234'), 'abcdefghijklmnopqrstuvwx', '30 chars cut to 24');
  assert.strictEqual(cleanNick('abc1234567'), '', '7 digits in a run');
  assert.strictEqual(cleanNick('1234a5678'), '1234a5678', 'a letter resets the run');
  assert.strictEqual(cleanNick('123 456 7'), '', 'spaces neither count nor reset');
  assert.strictEqual(cleanNick('café'), 'caf ', 'above 127 becomes a space');
  assert.strictEqual(cleanNick('a\u0001b'), 'a b', 'below 32 becomes a space');
  assert.strictEqual(cleanNick('a\u007fb'), 'a\u007fb', '127 itself is kept');
  assert.strictEqual(cleanNick('😀'), '  ', 'an emoji is two units, two spaces');
  assert.strictEqual(cleanNick('<b>x</b>'), '<b>x</b>', 'no markup filter: their client escapes on draw');
  assert.strictEqual(nameMax(LAWS), 24, 'L45 nameMax');
});

test('non-strings never call a toString; a number keeps its text', () => {
  const evil = { toString() { throw new Error('read'); } };
  for (const v of [undefined, null, {}, [], evil, true, Symbol('x')]) assert.strictEqual(cleanNick(v), '');
  assert.strictEqual(cleanNick(42), '42');
  assert.strictEqual(cleanNick(1234567), '');
});

test('cleanNick equals the frozen openNick then gdnm on 50,000 fuzz names', () => {
  const frozen = frozenJoinName();
  const rng = createRng(20261010);
  const pools = [
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
    '0123456789',
    ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
    '\u0000\u0001\u0009\u000a\u001f\u007f\u0080\u00a0\u00e9\u00ff',
    '\u0100\u2013\u4e2d\ud83d\ude00\ud800\u0041\udc00\ufffd',
  ];
  const specials = ['gameweek2016', 'GAMEWEEK2016', 'GameWeek2016 ', ' gameweek2016', 'gameweek2016x'];
  let same = 0;
  for (let i = 0; i < 50000; i++) {
    let s = '';
    if (rng.int(20) === 0) {
      s = specials[rng.int(specials.length)];
    } else {
      const len = rng.int(41);
      for (let k = 0; k < len; k++) {
        const pool = pools[rng.int(rng.int(4) === 0 ? pools.length : 2)];
        s += pool[rng.int(pool.length)];
      }
    }
    const want = frozen(s);
    const got = cleanNick(s);
    if (got !== want) assert.fail('name ' + JSON.stringify(s) + ': frozen ' + JSON.stringify(want) + ', ours ' + JSON.stringify(got));
    same++;
  }
  assert.strictEqual(same, 50000);
});

test('the helpers match their client: asciize and gdnm', () => {
  assert.strictEqual(asciize('ok'), 'ok');
  assert.strictEqual(asciize('\u0000xÿ'), ' x ');
  assert.strictEqual(gdnm('123456'), true);
  assert.strictEqual(gdnm('1234567'), false);
  assert.strictEqual(gdnm('12-34-567'), false);
  assert.strictEqual(gdnm('123456a7'), true);
});

test('BOT_NAMES is slBots list (one copy) and every name passes cleanNick unchanged', () => {
  assert.strictEqual(BOT_NAMES, slBots.BOT_NAMES);
  assert.ok(BOT_NAMES.length > 0);
  for (const n of BOT_NAMES) assert.strictEqual(cleanNick(n), n, n);
});
