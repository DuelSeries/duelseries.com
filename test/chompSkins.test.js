'use strict';
// Customize in Pac-Man (chomp, Owen 2026-10-26): a free colour listed in shared/chompSkins.js, or a bought skin the
// lobby's skin pass lists (server/skinPass.js), worn through the socket handshake (server/chomp/chompBoot.js skinOf)
// and sent to every page in the chomper's meta. The shown name is one constant (shared/chompName.js).
const test = require('node:test');
const assert = require('node:assert');
const { skinOf } = require('../server/chomp/chompBoot');
const { sharedPass } = require('../server/skinPass');
const { ChompRoom } = require('../server/chomp/chompRoom');
const chompSkins = require('../shared/chompSkins');
const shopSkins = require('../shared/shopSkins');
const shopPrices = require('../shared/shopPrices');
const catalog = require('../server/skinCatalog');

const quiet = { error() {}, warn() {}, log() {} };

test('a free colour is worn only when listed; anything else is the game\'s own look', () => {
  assert.strictEqual(skinOf({ skin: 'lime' }), 'f:lime');
  assert.strictEqual(skinOf({ skin: 'gold' }), '');
  assert.strictEqual(skinOf({ skin: '__proto__' }), '');
  assert.strictEqual(skinOf({ skin: 7 }), '');
  assert.strictEqual(skinOf(null), '');
  assert.strictEqual(skinOf({}), '');
});

test('a bought skin needs a genuine pass that lists it; a forged or missing pass falls back', () => {
  const { pass } = sharedPass().mint('W-test', ['chomp:candy', 'agar:moon']);
  assert.strictEqual(skinOf({ shop: 'candy', skinPass: pass }), 'p:candy');
  assert.strictEqual(skinOf({ shop: 'rainbow', skinPass: pass, skin: 'mint' }), 'f:mint', 'not in the pass');
  assert.strictEqual(skinOf({ shop: 'candy', skinPass: pass.slice(0, -2) + 'xx' }), '', 'forged');
  assert.strictEqual(skinOf({ shop: 'candy' }), '');
  const other = sharedPass().mint('W-test', ['agar:moon']).pass;
  assert.strictEqual(skinOf({ shop: 'moon', skinPass: other }), '', "another game's skin");
});

test('the skin rides the meta to every page; a junk value never does', () => {
  const room = new ChompRoom({ seed: 2, botFill: 0, grow: false, log: quiet });
  const a = room.addPlayer({ name: 'a', skin: 'p:candy' });
  const b = room.addPlayer({ name: 'b', skin: 'x:<script>' });
  const metas = room.metas();
  assert.strictEqual(metas.find((m) => m.id === a.id).s, 'p:candy');
  assert.strictEqual(metas.find((m) => m.id === b.id).s, '');
  assert.ok(room.events.some((e) => e.k === 'meta' && e.id === a.id && e.s === 'p:candy'));
});

test('every Pac-Man skin has a price, a look for every pixel, and is for sale', () => {
  assert.strictEqual(shopSkins.SKINS.chomp.length, 8);
  for (const k of shopSkins.SKINS.chomp) {
    assert.ok(shopPrices.price('chomp', k.id) > 0, k.id + ' priced');
    assert.ok(catalog.itemOf('chomp', k.id), k.id + ' sells');
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      assert.match(shopSkins.chompPx(k, dx, dy), /^#[0-9a-f]{6}$/, k.id);
    }
  }
  // no free colour is a ghost's (Blinky, Pinky, Inky, Clyde) or the game's own yellow
  const ghosts = ['#ff0000', '#ffb8ff', '#00ffff', '#ffb852', '#ffff00'];
  for (const s of chompSkins.SKINS) assert.ok(!ghosts.includes(s.col), s.id);
});

test('the shown name is one constant, ASCII, and the pushes and the door use it', () => {
  const NAME = require('../shared/chompName');
  assert.strictEqual(NAME, 'Pac-Man');
  assert.match(NAME, /^[\x20-\x7e]+$/);
  assert.ok(require('../server/chomp/chompBoot').DOOR_TEXT.full.includes(NAME));
});
