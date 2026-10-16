'use strict';
/* Wearing a bought skin in each game (docs/skin-purchases.md): the game's SERVER wears it only when the lobby's skin
   pass is genuine and lists '<game>:<skin>'; any other page gets the free look. No money anywhere in here. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { sharedPass } = require('../server/skinPass');
const shopSkins = require('../shared/shopSkins');

const W = 'Wa11etWa11etWa11etWa11etWa11etWa11etWa11';
const pass = (items) => sharedPass().mint(W, items).pass;

test('shared skins: every priced skin has a look, every look a price, and slither bytes are what its client reads', () => {
  const prices = require('../shared/shopPrices');
  for (const g of Object.keys(prices.PRICES)) {
    assert.deepEqual(shopSkins.SKINS[g].map((k) => k.id).sort(), Object.keys(prices.PRICES[g]).sort(), g);
  }
  assert.deepEqual(shopSkins.snakeBytes([[2, 31], [2, 9]]), [0, 0, 0, 0, 0, 0, 0, 0, 2, 31, 2, 9]);
  // every slither run uses a colour slither lets a custom skin use (0 to 35, 37, 39, 41)
  for (const k of shopSkins.SKINS.snake) for (const [n, c] of k.runs) {
    assert.ok(n >= 1 && n <= 255 && ((c >= 0 && c <= 35) || [37, 39, 41].includes(c)), k.id);
  }
  assert.equal(shopSkins.byId('snake', 'constructor'), null);
  assert.equal(shopSkins.byId('__proto__', 'x'), null);
});

test('slither (/sl): a genuine pass wears the custom skin; no pass, a forged one or an unlisted skin wears cv', () => {
  const { rig } = require('./slSockFakes');
  const r = rig();
  const snakeOf = (auth) => {
    const s = r.sock({ auth });
    s.fire('sl:join', { nick: 'n' });
    const seat = r.room().seatOf(s.id);
    assert.ok(seat, 'seated');
    return r.room().sim.snake(seat.snakeId);
  };
  const good = pass(['snake:candycane']);
  assert.deepEqual(snakeOf({ cv: 3, shop: 'candycane', skinPass: good }).skin, [0, 0, 0, 0, 0, 0, 0, 0, 2, 31, 2, 9]);
  assert.equal(snakeOf({ cv: 3, shop: 'rainbow', skinPass: good }).skin, undefined, 'not in the pass');
  assert.equal(snakeOf({ cv: 3, shop: 'candycane' }).skin, undefined, 'no pass');
  assert.equal(snakeOf({ cv: 3, shop: 'candycane', skinPass: good.slice(0, -2) + 'xx' }).skin, undefined, 'forged');
  assert.equal(snakeOf({ cv: 3, shop: 'candycane', skinPass: pass(['agar:candycane']) }).skin, undefined, 'another game');
  assert.equal(snakeOf({ cv: 3, shop: { toString: 1 }, skinPass: good }).skin, undefined, 'odd shapes');
  const plain = snakeOf({ cv: 3 });
  assert.equal(plain.skin, undefined);
  assert.equal(plain.cv, 3, 'the free choice still worn');
});

test('agar.io (/ag): a genuine pass wears the colour and sends ag:skins for the cells a page knows; else nothing', () => {
  const W2 = require('../shared/agWire');
  const { AgRoom } = require('../server/ag/agRoom');
  const { FIXTURE } = require('./agLawsFixture');
  const quiet = { error() {}, warn() {}, log() {} };
  const r = new AgRoom({ laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: quiet });
  let n = 0;
  const sock = (auth) => ({
    id: 'sk' + ++n, handshake: { auth }, conn: { writeBuffer: [] }, side: [],
    emit(ev, p) { if (ev === 'ag:f') W2.decodeBundle(p); else this.side.push([ev, p]); },
  });
  const a = sock({ shop: 'galaxy', skinPass: pass(['agar:galaxy']) });
  const b = sock({ shop: 'galaxy', skinPass: pass(['agar:moon']) });     // not owned: the free look
  const c = sock({ skin: 'nope' });
  for (const s of [a, b, c]) { r.addSocket(s); assert.equal(r.join(s.id, 'p' + s.id), 'ok'); }
  for (let i = 0; i < 5; i++) r.tickOnce();
  const pidA = r.seats.get(a.id).pid, pidB = r.seats.get(b.id).pid;
  const cellA = r.sim.playerInfo(pidA).cells[0];
  assert.deepEqual(r.sim.getCell(cellA).rgb, [0x1d, 0x18, 0x46], 'galaxy\'s colour');
  assert.notDeepEqual(r.sim.getCell(r.sim.playerInfo(pidB).cells[0]).rgb, [0x1d, 0x18, 0x46]);
  assert.equal(r.paidSkins.size, 1);
  const skinsTo = (s) => s.side.filter((e) => e[0] === 'ag:skins').map((e) => e[1].cells);
  // a's own page knows its cell: one ag:skins naming it with galaxy (7th, 1-based)
  assert.deepEqual(skinsTo(a)[0], [cellA, 7]);
  const sent = skinsTo(a).length;
  r.tickOnce();
  assert.equal(skinsTo(a).length, sent, 'nothing again while the list is the same');
});

test('agar.io: a room with no bought skin never sends ag:skins (the free room\'s bytes are unchanged)', () => {
  const { AgRoom } = require('../server/ag/agRoom');
  const { FIXTURE } = require('./agLawsFixture');
  const r = new AgRoom({ laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: { error() {}, warn() {}, log() {} } });
  const side = [];
  const s = { id: 'x', conn: { writeBuffer: [] }, emit(ev) { if (ev !== 'ag:f') side.push(ev); } };
  r.addSocket(s); r.join('x', 'x');
  for (let i = 0; i < 5; i++) r.tickOnce();
  assert.deepEqual(side.filter((e) => e === 'ag:skins'), []);
});
