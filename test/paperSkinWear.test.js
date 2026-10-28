'use strict';
/* Wearing a bought Paper skin (docs/skin-purchases.md): the SERVER decides. A join wears 'paper:<id>' only when the
   lobby's skin pass is genuine, unexpired and lists 'paper:<id>'; anything else is the usual random colour. Bots never
   wear one, several players can wear the same one, and the page draws it from the shop's look. No money in here
   beyond the one paid join that proves the paid rungs wear it too. */
const test = require('node:test');
const assert = require('node:assert');
const createPaperSockets = require('../server/paperSockets');
const { PaperArenas } = require('../server/paper/PaperArenas');
const { PaperRoom } = require('../server/paper/PaperRoom');
const arenaTrim = require('../server/paper/arenaTrim');
const { makeArena, REASON, P, MP } = require('../server/paper/ArenaGame');
const { isStake } = require('../server/stakeRules');
const { sharedPass } = require('../server/skinPass');
const shopSkins = require('../shared/shopSkins');
require('../public/js/paper/mp/paperPredict.js');
const Net = require('../public/js/paper/mp/paperNet.js');
const Mirror = require('../public/js/paper/mp/paperMirror.js');

const W = 'Wa11etWa11etWa11etWa11etWa11etWa11etWa11';
const passFor = (items) => sharedPass().mint(W, items).pass;
const HEX = /^#[0-9a-f]{6}$/;
// What the stock pool derives for a palette colour (the shop's camo green is one): the bought skin must match it.
const paletteColors = (hex) => new P.ColorSkinPool(undefined).assets.find((a) => a.name === hex).content.colors;

function world() {
  let t = 1000000;
  const io = { to: () => ({ emit() {}, volatile: { emit() {} } }) };
  const hooks = { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {} };
  const arenas = new PaperArenas({ io, hooks, now: () => t, paidEnabled: true, autoTick: false, warm: false });
  const tokens = new Map();
  let tn = 0;
  const take = (token, stake) => {
    const tk = typeof token === 'string' && tokens.get(token);
    if (Number(stake) === 0) return { ok: true, worth: 0 };
    if (!tk || Math.abs(tk.stake - Number(stake)) > 1e-9) return { ok: false, worth: 0 };
    tokens.delete(token);
    return { ok: true, worth: tk.worth, paid: tk.paid, walletAddress: tk.wallet };
  };
  const paper = createPaperSockets({
    arenas,
    ops: { get: () => ({ maintenance: false }) },
    socketRL: () => true,
    sanitizeName: (n) => String(n == null ? '' : n).trim().slice(0, 20) || 'Player',
    isStake,
    consumePaidEntryAtStake: (token, stake) => take(token, stake),
    entryStore: { consumeAtStake: (token, stake) => take(token, stake) },
    payout: { refund() {} },
    paidEnabled: true
  });
  const mint = (stake) => {
    const token = 'tok' + ++tn;
    tokens.set(token, { stake, worth: stake, paid: stake, wallet: 'WALLET' + tn });
    return token;
  };
  return { arenas, paper, mint };
}

let sn = 0;
function sock(w) {
  const s = {
    id: 'ps' + ++sn,
    handlers: {},
    got: [],
    rooms: new Set(),
    on(ev, fn) { this.handlers[ev] = fn; },
    emit(ev, p) { this.got.push([ev, p]); },
    join(r) { this.rooms.add(r); },
    leave(r) { this.rooms.delete(r); },
    fire(ev, p) { this.handlers[ev](p); }
  };
  w.paper.attach(s);
  return s;
}

// The unit this socket plays, after a join.
const unitOf = (s) => {
  assert.ok(s._ppRoom, 'seated');
  const seat = s._ppRoom.seatOfSocket(s.id);
  assert.ok(seat, 'has a seat');
  return seat.unit;
};

test('a join with a genuine pass wears the bought skin, colours from the shop colour, others see its name', () => {
  const w = world();
  const s = sock(w);
  s.fire('pp:join', { name: 'ann', stake: 0, shop: 'camo', skinPass: passFor(['paper:camo']) });
  const u = unitOf(s);
  assert.strictEqual(u.skin.name, 'paper:camo');
  // the colours come from the shop's colour exactly as a plain colour skin's come from its hex
  const plain = paletteColors('#4a7c59');
  assert.deepStrictEqual(u.skin.colors, plain);
  assert.strictEqual(u.skin.colors.main, '#4a7c59');
  // the wire carries the name: the join payload other pages get
  const wired = s._ppRoom.wire.joinPayload().units.find((x) => x.id === u.id);
  assert.strictEqual(wired.skin, 'paper:camo');
  // never in the palette's pool of free colours
  assert.ok(!s._ppRoom.game.skinManager.has('paper:camo'));
});

test('a paid rung wears it too (the pass is read before the seat, whatever the money path)', () => {
  const w = world();
  const s = sock(w);
  s.fire('pp:join', { name: 'pay', stake: 0.5, entryToken: w.mint(0.5), shop: 'gold', skinPass: passFor(['paper:gold']) });
  assert.strictEqual(unitOf(s).skin.name, 'paper:gold');
  assert.strictEqual(s._ppRoom.stake, 0.5);
});

test('no pass, a forged pass, an unlisted skin, another game\'s or an expired pass wear the normal random colour', () => {
  const w = world();
  const good = passFor(['paper:camo']);
  const cases = [
    ['no pass', { shop: 'camo' }],
    ['no shop', { skinPass: good }],
    ['forged', { shop: 'camo', skinPass: good.slice(0, -2) + 'xx' }],
    ['edited body', { shop: 'camo', skinPass: passFor(['paper:mint']).replace(/^[^.]+/, good.split('.')[0]) }],
    ['not in the pass', { shop: 'mint', skinPass: good }],
    ['another game\'s skin', { shop: 'camo', skinPass: passFor(['agar:camo', 'snake:candycane']) }],
    ['not a skin the shop sells', { shop: 'rainbow', skinPass: passFor(['paper:rainbow']) }],
    ['empty pass', { shop: 'camo', skinPass: '' }],
    ['too long', { shop: 'camo', skinPass: good + 'a'.repeat(5000) }],
    ['shop a number', { shop: 5, skinPass: good }],
    ['pass a number', { shop: 'camo', skinPass: 7 }],
    ['shop an object', { shop: { toString: 1 }, skinPass: good }],
    ['pass an object', { shop: 'camo', skinPass: { x: 1 } }],
    ['shop an array', { shop: ['camo'], skinPass: [good] }],
    ['proto', { shop: '__proto__', skinPass: good }]
  ];
  for (const [why, fields] of cases) {
    const s = sock(w);
    s.fire('pp:join', Object.assign({ name: 'x', stake: 0 }, fields));
    const u = unitOf(s);
    assert.ok(HEX.test(u.skin.name), why + ': a palette colour, got ' + u.skin.name);
    assert.ok(!u.skin.name.startsWith('paper:'), why);
  }
  // expired: the same genuine pass, a day and a bit later
  const s = sock(w);
  const real = Date.now;
  Date.now = () => real() + 25 * 60 * 60 * 1000;
  try {
    s.fire('pp:join', { name: 'late', stake: 0, shop: 'camo', skinPass: good });
  } finally {
    Date.now = real;
  }
  assert.ok(HEX.test(unitOf(s).skin.name), 'expired pass: a palette colour');
});

test('a respawn without the fields wears what the join proved; its own fields count; a bad one clears it', () => {
  const w = world();
  const s = sock(w);
  s.fire('pp:join', { name: 'r', stake: 0, shop: 'camo', skinPass: passFor(['paper:camo']) });
  const die = () => { const room = s._ppRoom; room.game.kill(unitOf(s), undefined, REASON.SELF_CROSS); };
  die();
  s.fire('pp:respawn', {});
  assert.strictEqual(unitOf(s).skin.name, 'paper:camo', 'remembered');
  die();
  s.fire('pp:respawn', { shop: 5, skinPass: { x: 1 } });                      // odd shapes are as if absent
  assert.strictEqual(unitOf(s).skin.name, 'paper:camo', 'odd shapes change nothing');
  die();
  s.fire('pp:respawn', { shop: 'mint', skinPass: passFor(['paper:mint']) });  // its own fields, a different skin
  assert.strictEqual(unitOf(s).skin.name, 'paper:mint');
  die();
  s.fire('pp:respawn', { shop: 'mint', skinPass: 'forged.pass' });            // a bad pass: the free look, and forgotten
  assert.ok(HEX.test(unitOf(s).skin.name));
  die();
  s.fire('pp:respawn', {});
  assert.ok(HEX.test(unitOf(s).skin.name), 'nothing left to remember');
});

test('a join always starts over from its own fields (the previous seat\'s skin is not inherited)', () => {
  const w = world();
  const s = sock(w);
  s.fire('pp:join', { name: 'j', stake: 0, shop: 'camo', skinPass: passFor(['paper:camo']) });
  assert.strictEqual(unitOf(s).skin.name, 'paper:camo');
  s.fire('pp:leave');
  s.fire('pp:join', { name: 'j', stake: 0 });
  assert.ok(HEX.test(unitOf(s).skin.name));
});

test('bots never wear a bought skin, however many are dealt', () => {
  const g = makeArena({ stake: 0, seed: 0.37 });
  const a = g.spawnHuman({ name: 'a', skin: 'camo' });
  assert.strictEqual(a.skin.name, 'paper:camo');
  const sm = g.skinManager;
  for (let i = 0; i < 700; i++) g.update(MP.STEP_MS);
  const bots = g.units.filter((u) => !u.isHuman);
  assert.ok(bots.length >= 5, 'bots were dealt: ' + bots.length);
  for (const b of bots) assert.ok(!b.skin.name.startsWith('paper:'), 'bot skin ' + b.skin.name);
  // and the pool itself: drawn dry, a bought skin is never among what comes out
  while (sm.available('colored') > 0) assert.ok(HEX.test(sm.getBotSkin().name));
  assert.ok(!sm.has('paper:camo'));
  // every colour taken: the human fallback picks from the others, never the bought skin
  const b2 = g.spawnHuman({ name: 'b' });
  assert.ok(!b2.skin.name.startsWith('paper:'), 'got ' + b2.skin.name);
  for (const n of ['paper:mint', 'paper:nope', '', null, 5, {}, ['camo']]) {
    const h = g.spawnHuman({ name: 'c', skin: n });
    assert.ok(!h.skin.name.startsWith('paper:'), 'a name that is not an id: ' + String(n));
  }
});

test('an arena with no bought skin deals exactly the colours it always did', () => {
  // the stock spawn search draws Math.random, so it is seeded the same for each run
  const dealt = (skin) => {
    const orig = Math.random;
    let r = 12345;
    Math.random = () => { r = (r * 16807) % 2147483647; return (r - 1) / 2147483646; };
    try {
      const g = makeArena({ stake: 0, seed: 0.37 });
      const h = g.spawnHuman({ name: 'h', skin });
      for (let i = 0; i < 300; i++) g.update(MP.STEP_MS);
      return [h.skin.name].concat(g.units.filter((u) => !u.isHuman).map((u) => u.skin.name));
    } finally {
      Math.random = orig;
    }
  };
  assert.deepStrictEqual(dealt(undefined), dealt(null));
  assert.deepStrictEqual(dealt(undefined), dealt('definitelynotaskin'));
});

test('two players wear the same bought skin in one arena, and kills and the stop release without throwing', () => {
  const g = makeArena({ stake: 0, seed: 0.5 });
  const a = g.spawnHuman({ name: 'a', skin: 'camo' });
  const b = g.spawnHuman({ name: 'b', skin: 'camo' });
  const c = g.spawnHuman({ name: 'c', skin: 'mint' });
  assert.strictEqual(a.skin.name, 'paper:camo');
  assert.strictEqual(b.skin.name, 'paper:camo');
  assert.strictEqual(c.skin.name, 'paper:mint');
  assert.notStrictEqual(a.skin, b.skin, 'each wearer has its own skin object');
  assert.strictEqual(a.skin.colors.main, b.skin.colors.main);
  const sm = g.skinManager;
  assert.strictEqual(sm.usedBy['paper:camo'].length, 2);
  g.kill(a, undefined, REASON.SELF_CROSS);
  assert.strictEqual(sm.usedBy['paper:camo'].length, 1, 'b still wears it');
  assert.ok(!sm.has('paper:camo'), 'not back in the free pool while b wears it');
  g.kill(b, undefined, REASON.SELF_CROSS);
  assert.ok(!sm.usedBy['paper:camo'], 'nobody wears it now');
  assert.ok(!sm.has('paper:camo'), 'and it is still not in the free pool');
  assert.ok(!Object.keys(sm.unusedAssets).some((n) => n.startsWith('paper:')));
  sm.release(b.skin);                                    // a second release of the same skin is harmless
  const d = g.spawnHuman({ name: 'd', skin: 'camo' });   // and it can be worn again afterwards
  assert.strictEqual(d.skin.name, 'paper:camo');
  g.stop();                                              // releases everything once more
});

test('two sockets wearing the same skin in the same room both join and leave cleanly', () => {
  const w = world();
  const pass = passFor(['paper:camo']);
  const a = sock(w);
  const b = sock(w);
  a.fire('pp:join', { name: 'a', stake: 0, shop: 'camo', skinPass: pass });
  b.fire('pp:join', { name: 'b', stake: 0, shop: 'camo', skinPass: pass });
  const ua = unitOf(a);
  const ub = unitOf(b);
  assert.strictEqual(ua.skin.name, 'paper:camo');
  assert.strictEqual(ub.skin.name, 'paper:camo');
  a._ppRoom.game.kill(ua, undefined, REASON.SELF_CROSS);
  assert.strictEqual(ub.skin.name, 'paper:camo');
  if (a._ppRoom === b._ppRoom) b._ppRoom.game.kill(ub, undefined, REASON.SELF_CROSS);
});

/* ── the page ────────────────────────────────────────────────────────────────────────────────────────────────── */

function socketDouble() {
  return { sent: [], handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, emit(ev, p) { this.sent.push([ev, p]); },
    volatile: { emit() {} } };
}

test('the page asks with shop and skinPass in its join and respawn, and nothing extra when it has none', () => {
  const s = socketDouble();
  const net = new Net.ArenaNet({ socket: s, onError: (w, e) => { throw e; } });
  net.join({ name: 'Ann', stake: 0, entryToken: 'T', shop: 'camo', skinPass: 'P.ASS' });
  assert.deepStrictEqual(s.sent[0], ['pp:join', { name: 'Ann', stake: 0, entryToken: 'T', shop: 'camo', skinPass: 'P.ASS' }]);
  net.respawn('T2');
  assert.deepStrictEqual(s.sent[1], ['pp:respawn', { name: 'Ann', entryToken: 'T2', shop: 'camo', skinPass: 'P.ASS' }]);
  net.respawn('T3', { shop: 'mint', skinPass: 'NEW.PASS' });   // the page read the lobby's keys again
  assert.deepStrictEqual(s.sent[2], ['pp:respawn', { name: 'Ann', entryToken: 'T3', shop: 'mint', skinPass: 'NEW.PASS' }]);
  net.respawn('T4', null);                                      // the lobby has no choice any more
  assert.deepStrictEqual(s.sent[3], ['pp:respawn', { name: 'Ann', entryToken: 'T4' }]);
  // a half pair is no pair
  const s2 = socketDouble();
  const n2 = new Net.ArenaNet({ socket: s2, onError: (w, e) => { throw e; } });
  n2.join({ name: 'B', stake: 0, shop: 'camo' });
  assert.deepStrictEqual(s2.sent[0], ['pp:join', { name: 'B', stake: 0 }]);
  n2.respawn();
  assert.deepStrictEqual(s2.sent[1], ['pp:respawn', { name: 'B' }]);   // the name rides along (site sweep 2026-10-28)
});

test('the page builds a bought skin from the shop\'s look: colours, side colour and a world-sized pattern', async () => {
  const saved = { document: globalThis.document, DOMMatrix: globalThis.DOMMatrix };
  const tiles = [];
  globalThis.document = {
    createElement() {
      const calls = [];
      const ctx = new Proxy({ calls }, {
        get: (t, key) => (key in t ? t[key] : key === 'createPattern'
          ? (cv) => ({ source: cv, setTransform(m) { this.m = m; } })
          : (...a) => { calls.push([key, ...a]); }),
        set: (t, key, v) => { calls.push(['set ' + String(key), v]); return true; }
      });
      const cv = { width: 0, height: 0, getContext: () => ctx, calls };
      tiles.push(cv);
      return cv;
    }
  };
  globalThis.DOMMatrix = function DOMMatrix(a) { this.a = a; };
  try {
    const config = Object.assign({}, P.defaultPaperConfig);
    const sm = new P.SkinManager(new P.ColorSkinPool(config), new P.ClassicSkinPool(undefined, null, '', []), 1);
    assert.strictEqual(sm.registerPaidByName('paper:camo', shopSkins, config), true);
    const a = sm.get('paper:camo');
    const b = sm.get('paper:camo');
    assert.strictEqual(a.name, 'paper:camo');
    assert.strictEqual(a.colors.main, '#4a7c59');
    assert.strictEqual(a.colors.back, paletteColors('#4a7c59').back);
    assert.ok(a.pattern && a.pattern.pattern, 'the territory fill is a pattern');
    assert.strictEqual(a.pattern, b.pattern, 'one pattern for every wearer');
    // 15 world units across at twice the closest zoom, drawn back to world units by the transform
    const want = Math.round(15 * config.maxScale * 2);
    const tile = tiles.find((t) => t.width === want);
    assert.ok(tile, 'a tile canvas 15 world units across at twice the closest zoom');
    assert.deepStrictEqual(a.pattern.pattern.m.a, [1 / (config.maxScale * 2), 0, 0, 1 / (config.maxScale * 2), 0, 0]);
    // base colour first, then the design 3 x 3 times (its neighbours wrap the seams); camo draws 5 blobs each
    assert.strictEqual(tile.calls.filter((c) => c[0] === 'fillRect').length, 1);
    assert.strictEqual(tile.calls.filter((c) => c[0] === 'ellipse').length, 9 * 5);
    assert.ok(a.container.displays.length === 1, 'the head is the same square the colours give');
    // a stars skin is inked white, like the lobby's preview
    assert.strictEqual(sm.registerPaidByName('paper:midnight', shopSkins, config), true);
    const stars = tiles.filter((t) => t.width === want).pop();
    const inks = stars.calls.filter((c) => c[0] === 'set fillStyle').map((c) => c[1]);
    assert.ok(inks.includes('#ffffff'), 'white stars: ' + inks.join());
    // names that are not a bought skin are refused and register nothing
    for (const n of ['paper:nope', 'paper:', '#4a7c59', 'camo', null, 5, 'paper:__proto__']) {
      assert.strictEqual(sm.registerPaidByName(n, shopSkins, config), false, String(n));
    }
    assert.ok(!sm.assets['paper:nope'] && !sm.assets['paper:']);
    assert.strictEqual(sm.registerPaidByName('paper:camo', null, config), true, 'already known, shop or not');
    // the head layers bake their bitmaps a moment later, through the same document: let them finish first
    await new Promise((r) => setImmediate(r));
  } finally {
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    if (saved.DOMMatrix === undefined) delete globalThis.DOMMatrix; else globalThis.DOMMatrix = saved.DOMMatrix;
  }
});

test('with no canvas the skin is its plain colour (nothing to throw in node)', () => {
  const sm = new P.SkinManager(new P.ColorSkinPool(undefined), new P.ClassicSkinPool(undefined, null, '', []), 1);
  assert.strictEqual(sm.registerPaidByName('paper:gold', shopSkins, P.defaultPaperConfig), true);
  const s = sm.get('paper:gold');
  assert.strictEqual(s.colors.main, '#f2b632');
  assert.strictEqual(s.pattern, null);
});

test('the mirror wears the bought skin a server names, for every square, and a page without the shop file stays safe', () => {
  const clock = { t: 1000000 };
  const io = { to: () => ({ emit() {}, volatile: { emit() {} } }) };
  const hooks = { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {} };
  const room = new PaperRoom({ stake: 0, io, hooks, now: () => clock.t, autoTick: false, seed: 0.42, trim: arenaTrim });
  for (let i = 0; i < 30; i++) { clock.t += MP.STEP_MS; room.tickOnce(); }
  const got = [];
  const server = { id: 'c1', rooms: new Set(), join(r) { this.rooms.add(r); }, leave() {}, emit(ev, p) { got.push([ev, p]); } };
  const mk = (id) => ({ id, rooms: new Set(), join(r) { this.rooms.add(r); }, leave() {}, emit() {} });
  const a = room.addHuman(server, { name: 'a', micro: 0, wallet: null, spot: room.findSpawn(), skin: 'camo' });
  const b = room.addHuman(mk('c2'), { name: 'b', micro: 0, wallet: null, spot: room.findSpawn(), skin: 'camo' });
  assert.ok(got.find((e) => e[0] === 'pp:joined'), 'a was told it joined');
  const joined = MP.unpackBin(MP.packBin(room.joinedPayload(a, false)));  // the whole arena, both wearers in it

  const had = globalThis.DS_SHOP_SKINS;
  globalThis.DS_SHOP_SKINS = shopSkins;
  try {
    const m = Mirror.create({ seed: 0.5 });
    m.onError = (e) => { throw e; };
    m.applyJoined(joined);
    const ua = m.byId.get(a.unit.id);
    const ub = m.byId.get(b.unit.id);
    assert.strictEqual(ua.skin.name, 'paper:camo');
    assert.strictEqual(ub.skin.name, 'paper:camo', 'a second wearer, a second skin object');
    assert.notStrictEqual(ua.skin, ub.skin);
    assert.strictEqual(ua.skin.colors.main, '#4a7c59');
    // the bots on the page are never dealt it
    for (const u of m.units) if (u !== ua && u !== ub) assert.ok(!u.skin.name.startsWith('paper:'));
    m.stop();                                  // releases every skin, the shared one included, without throwing
    // an old page with no shop file: the stock random skin, never a throw or an undrawn square
    delete globalThis.DS_SHOP_SKINS;
    const m2 = Mirror.create({ seed: 0.5 });
    m2.onError = (e) => { throw e; };
    m2.applyJoined(joined);
    const u2 = m2.byId.get(a.unit.id);
    assert.ok(u2.skin && u2.skin.colors && u2.skin.container, 'drawable');
    assert.ok(!u2.skin.name.startsWith('paper:'));
  } finally {
    if (had === undefined) delete globalThis.DS_SHOP_SKINS; else globalThis.DS_SHOP_SKINS = had;
  }
});

test('a durable paid join (its stake claim in flight) still wears the skin that was proved before the claim', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createAgJournal } = require('../server/ag/agJournal');
  const { createStakeLedger } = require('../server/stakeLedger');
  const { createMemLedgerDb } = require('../scripts/memLedgerDb');
  const quiet = { log() {}, warn() {}, error() {} };
  const db = createMemLedgerDb();
  db.seedStake({ sig: 'SK-1', state: 'pending', wallet_address: 'W-SK', refund_amount: 0.5, label: 'stake 0.5', region: 'na', boot_id: 'b1' });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppskin-')), 'ag-money-journal.log');
  const journal = createAgJournal({ file, bootId: 'b1', log: quiet });
  const io = { to: () => ({ emit() {}, volatile: { emit() {} } }) };
  const hooks = { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {} };
  const arenas = new PaperArenas({ io, hooks, paidEnabled: true, autoTick: false, warm: false, journal });
  const ledger = createStakeLedger({ db, region: 'na', bootId: 'b1', log: quiet });
  const take = () => ({ ok: true, worth: 0.5, paid: 0.5, walletAddress: 'W-SK', stakeSig: 'SK-1', claimKey: 'CK-1', restore() {} });
  const paper = createPaperSockets({
    arenas, ops: { get: () => ({ maintenance: false }) }, socketRL: () => true, sanitizeName: (n) => String(n || 'Player'),
    isStake, consumePaidEntryAtStake: take, entryStore: { consumeAtStake: take }, payout: { refund() {} }, ledger, paidEnabled: true
  });
  const s = { id: 'dur1', got: [], handlers: {}, rooms: new Set(), disconnected: false,
    on(ev, fn) { this.handlers[ev] = fn; }, emit(ev, p) { this.got.push([ev, p]); },
    join(r) { this.rooms.add(r); }, leave(r) { this.rooms.delete(r); } };
  paper.attach(s);
  s.handlers['pp:join']({ stake: 0.5, name: 'dur', entryToken: 'tok-dur', shop: 'ice', skinPass: passFor(['paper:ice']) });
  assert.ok(!s.got.find((e) => e[0] === 'pp:joined'), 'the claim is still in flight');
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  assert.ok(s.got.find((e) => e[0] === 'pp:joined'), 'seated after the claim');
  assert.strictEqual(unitOf(s).skin.name, 'paper:ice');
});
