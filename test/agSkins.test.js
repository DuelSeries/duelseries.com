'use strict';
// agar.io's free skins (Owen 2026-10-15): one list (shared/agSkins.js) for the lobby's chooser and the /ag server,
// a colour carried in the handshake, worn every life, and nothing else moved by it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const W = require('../shared/agWire');
const S = require('../shared/agSkins');
const { AgRoom } = require('../server/ag/agRoom');
const { createSim } = require('../server/ag/agSim');
const { FIXTURE } = require('./agLawsFixture');

const ROOT = path.join(__dirname, '..');
const quiet = { error() {}, warn() {}, log() {} };

function sock(id, auth) {
  return {
    id, handshake: { auth: auth || {} }, conn: { writeBuffer: [] }, got: [],
    emit(ev, buf) { if (ev === 'ag:f') this.got.push(W.decodeBundle(buf)); },
  };
}
function ownRgb(r, s) {
  const pid = r.seatOf(s.id).pid;
  let rgb = null;
  r.sim.forEachCell((c) => { if (c.owner === pid && c.kind === 'player') rgb = c.rgb; });
  return rgb;
}

test('the list: a good set, unique ids, real colours, a stable key', () => {
  assert.ok(S.SKINS.length >= 12, 'a good set of free skins');
  const ids = S.SKINS.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'ids are unique');
  for (const s of S.SKINS) {
    assert.ok(/^[a-z]+$/.test(s.id) && s.id.length <= 32, s.id + ' is a short plain id');
    assert.ok(s.rgb.length === 3 && s.rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255), s.id + ' rgb');
    assert.ok(s.name && s.name.length <= 12, s.id + ' has a short name');
  }
  assert.strictEqual(S.KEY, 'duel.ag.skin');
  assert.deepStrictEqual(S.rgbOf('cherry'), [232, 32, 58]);
  for (const bad of [undefined, null, '', 'nope', 'constructor', '__proto__', 'toString', 7, {}, ['cherry']]) {
    assert.strictEqual(S.rgbOf(bad), null, 'not a skin: ' + String(bad));
  }
  const a = S.rgbOf('lime'); a[0] = 0;
  assert.notStrictEqual(S.rgbOf('lime')[0], 0, 'a caller cannot change the list');
});

test('the room paints a player in the skin its handshake named, every life', () => {
  const r = new AgRoom({ laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: quiet });
  const s = sock('a', { skin: 'cobalt' });
  r.addSocket(s);
  assert.strictEqual(r.join(s.id, 'me'), 'ok');
  r.tickOnce();
  assert.deepStrictEqual(ownRgb(r, s), S.rgbOf('cobalt'));
  // The colour rides the cell record every client already decodes.
  const recs = s.got.flat().filter((x) => x.t === 'world' || x.t === 'sync');
  const pid = r.seatOf(s.id).pid;
  let id = null;
  r.sim.forEachCell((c) => { if (c.owner === pid) id = c.id; });
  const rec = recs.flatMap((x) => x.cells).find((c) => c.id === id && c.rgb);
  assert.deepStrictEqual(rec && rec.rgb, S.rgbOf('cobalt'), 'sent on the wire as the cell colour');
  r.stop && r.stop();
});

test('no skin, or one not on the list, is a dealt colour exactly as before', () => {
  const plain = new AgRoom({ laws: FIXTURE, shippableOnly: false, seed: 9, autoTick: false, log: quiet });
  const odd = new AgRoom({ laws: FIXTURE, shippableOnly: false, seed: 9, autoTick: false, log: quiet });
  const a = sock('a'), b = sock('a', { skin: 'not-a-skin', paid: 0 });
  plain.addSocket(a); odd.addSocket(b);
  plain.join(a.id, 'x'); odd.join(b.id, 'x');
  plain.tickOnce(); odd.tickOnce();
  assert.deepStrictEqual(ownRgb(odd, b), ownRgb(plain, a), 'an unknown id changes nothing');
  plain.stop && plain.stop(); odd.stop && odd.stop();
});

test('a skin never moves the sim\'s random stream', () => {
  const mk = (skin) => {
    const sim = createSim({ laws: FIXTURE, seed: 3 });
    const pid = sim.addPlayer({ name: 'p', bot: false, skin });
    sim.spawn(pid, 'p');
    for (let i = 0; i < 40; i++) sim.step();
    return { sim, pid };
  };
  const a = mk(null), b = mk(S.rgbOf('mint'));
  assert.strictEqual(JSON.stringify(a.sim.snapshot().rng), JSON.stringify(b.sim.snapshot().rng), 'same rng state');
  assert.deepStrictEqual(b.sim.playerInfo(b.pid).rgb, S.rgbOf('mint'));
  assert.notDeepStrictEqual(a.sim.playerInfo(a.pid).rgb, S.rgbOf('mint'));
  // A malformed colour is ignored, never trusted.
  const sim = createSim({ laws: FIXTURE, seed: 3 });
  const pid = sim.addPlayer({ name: 'p', bot: false, skin: [999, 'x', 1] });
  sim.spawn(pid, 'p'); sim.step();
  assert.ok(sim.playerInfo(pid).rgb.every((v) => v >= 0 && v <= 255));
});

test('the /ag page sends the stored skin in its handshake, and no money path reads it', () => {
  const main = fs.readFileSync(path.join(ROOT, 'public/js/ag/agMain.js'), 'utf8');
  assert.ok(main.includes("win.localStorage.getItem('duel.ag.skin')"), 'agMain reads the lobby key');
  // auth.shop: a bought skin with its pass (docs/skin-purchases.md) rides the same handshake
  assert.ok(main.includes('ioOptions: flow || auth.skin || auth.shop || auth.watchStake ? { auth: auth } : undefined'), 'and puts it in the handshake');
  assert.ok(main.includes('var auth = flow ? { paid: 1 } : {};'), 'a paid hand-off keeps auth.paid');
  for (const f of ['server/ag/agMoney.js', 'server/ag/agPaidDoor.js', 'server/ag/agBank.js', 'public/js/ag/agPaid.js',
    'public/js/v2/wallet.js', 'public/js/v2/play.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/agSkins|duel\.ag\.skin/.test(src), f + ' does not read the skin');
  }
});
