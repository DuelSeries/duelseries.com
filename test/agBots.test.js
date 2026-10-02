'use strict';
// Bots for free agar.io rooms (CHOSEN, Q17 and Q18; build brief 9.2 agBots card), run on the FIXTURE law table.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../server/ag/agBots');
const { LAWS } = require('../server/ag/agLaws');
const { createRng } = require('../server/ag/agRng');
const { FIXTURE, makeFixture } = require('./agLawsFixture');

const BORDER = { minX: -7071, minY: -7071, maxX: 7071, maxY: 7071 };
const ME = 'bot1';

function cell(id, owner, x, y, size, kind) {
  return { id, owner, x, y, size, kind: kind || 'player' };
}
function view(cells, tick, border) {
  return { playerId: ME, tick: tick || 0, border: border || BORDER, cells };
}
function brain(seed, laws) {
  return B.createBotBrain({ laws: laws || FIXTURE, seed: seed === undefined ? 7 : seed });
}

test('the brain refuses to start on unapproved laws and names them', () => {
  assert.throws(() => B.createBotBrain({ laws: LAWS, seed: 1 }), (e) => /L24/.test(e.message) && /L11/.test(e.message));
  assert.doesNotThrow(() => brain());
});

test('a bot of size 100 flees a size-200 player 300 units east (negative x offset)', () => {
  const out = brain().botThink(view([cell(1, ME, 0, 0, 100), cell(2, 'human', 300, 0, 200)]));
  assert.ok(out.tx < 0, 'tx ' + out.tx);
  assert.strictEqual(out.ty, 0);
  assert.strictEqual(out.split, false);
  assert.strictEqual(out.eject, false);
  // Same from every side: the target always points away from the threat.
  for (const [hx, hy] of [[-300, 0], [0, 300], [0, -300], [212, 212]]) {
    const o = brain().botThink(view([cell(1, ME, 0, 0, 100), cell(2, 'human', hx, hy, 200)]));
    assert.ok(o.tx * hx + o.ty * hy < 0, 'threat at ' + hx + ',' + hy);
  }
});

test('a bot of size 150 splits at a size-50 player inside its split reach', () => {
  const range = B.splitKillRange(150, 50, FIXTURE);
  // Piece 150 / sqrt 2 flies 780 * piece^0.0122 (fixture L11) and swallows within piece - 50 / 3 (fixture L24).
  const piece = 150 * Math.sqrt(0.5);
  assert.strictEqual(range, 780 * Math.pow(piece, 0.0122) + piece - 50 / 3);
  assert.ok(range * B.BOT_TUNING.SPLIT_REACH_FACTOR.value > 400);
  const out = brain().botThink(view([cell(1, ME, 0, 0, 150), cell(2, 'human', 400, 0, 50)]));
  assert.deepStrictEqual(out, { tx: 400, ty: 0, split: true, eject: false });
});

test('no split when the prey is out of reach, the piece cannot eat it, or the cooldown runs', () => {
  // Out of reach but seen: hunt without splitting.
  let out = brain().botThink(view([cell(1, ME, 0, 0, 150), cell(2, 'human', 1100, 0, 50)]));
  assert.deepStrictEqual(out, { tx: 1100, ty: 0, split: false, eject: false });
  // Piece 42.43 of a size-60 cell cannot eat a size-40 cell (needs 46): hunt, no split.
  out = brain().botThink(view([cell(1, ME, 0, 0, 60), cell(2, 'human', 200, 0, 40)]));
  assert.strictEqual(out.split, false);
  assert.strictEqual(out.tx, 200);
  // Size 59.99 never splits; size 60 does with L8_CMP '>=', not with '>'.
  out = brain().botThink(view([cell(1, ME, 0, 0, 59.99), cell(2, 'human', 200, 0, 30)]));
  assert.strictEqual(out.split, false);
  out = brain().botThink(view([cell(1, ME, 0, 0, 60), cell(2, 'human', 200, 0, 30)]));
  assert.strictEqual(out.split, true);
  out = brain(7, makeFixture({ L8_CMP: '>' })).botThink(view([cell(1, ME, 0, 0, 60), cell(2, 'human', 200, 0, 30)]));
  assert.strictEqual(out.split, false);
  // Cooldown: one split, then none for SPLIT_COOLDOWN_TICKS.
  const b = brain();
  const cells = [cell(1, ME, 0, 0, 150), cell(2, 'human', 400, 0, 50)];
  assert.strictEqual(b.botThink(view(cells, 10)).split, true);
  const cd = B.BOT_TUNING.SPLIT_COOLDOWN_TICKS.value;
  assert.strictEqual(b.botThink(view(cells, 10 + cd - 1)).split, false);
  assert.strictEqual(b.botThink(view(cells, 10 + cd)).split, true);
  // Too many own cells: no split.
  const many = [];
  for (let i = 0; i < B.BOT_TUNING.SPLIT_MAX_OWN_CELLS.value + 1; i++) many.push(cell(10 + i, ME, i * 5, 0, 150));
  out = brain().botThink(view(many.concat([cell(2, 'human', 400, 0, 50)])));
  assert.strictEqual(out.split, false);
});

test('no split when a third cell could eat a split piece', () => {
  // Size 135 cannot eat the size-150 bot (needs 172.5) nor be eaten by it (needs 117.4 or less), but can eat its
  // 106.07 pieces (needs 122).
  const out = brain().botThink(view([
    cell(1, ME, 0, 0, 150), cell(2, 'human', 400, 0, 50), cell(3, 'other', -450, 0, 135),
  ]));
  assert.strictEqual(out.split, false);
  assert.strictEqual(out.tx, 400);
  // Control: the same cell farther than SPLIT_SAFE_MARGIN from the bot lets the split go.
  const ok = brain().botThink(view([
    cell(1, ME, 0, 0, 150), cell(2, 'human', 400, 0, 50), cell(3, 'other', -600, 0, 135),
  ]));
  assert.strictEqual(ok.split, true);
});

test('eats food: goes for the best pellet it can eat', () => {
  const out = brain().botThink(view([
    cell(1, ME, 0, 0, 50), cell(5, null, 100, 50, 10, 'food'), cell(6, null, 600, 0, 10, 'food'),
  ]));
  assert.deepStrictEqual(out, { tx: 100, ty: 50, split: false, eject: false });
  // Mirror-message booleans work as the kind too.
  const o2 = brain().botThink(view([cell(1, ME, 0, 0, 50), { id: 5, x: -80, y: 0, size: 10, food: true }]));
  assert.strictEqual(o2.tx, -80);
});

test('never team: ignores blobs from players it is not hunting, treats bots like humans, never ejects', () => {
  // A juicy blob from another player right next to the bot is ignored; the far food wins.
  let out = brain().botThink(view([
    cell(1, ME, 0, 0, 50), cell(7, 'feeder', 40, 0, 36, 'ejected'), cell(6, null, 700, 0, 10, 'food'),
  ]));
  assert.strictEqual(out.tx, 700);
  // A blob with no known owner is ignored too.
  out = brain().botThink(view([cell(1, ME, 0, 0, 50), cell(7, null, 40, 0, 36, 'ejected'), cell(6, null, -700, 0, 10, 'food')]));
  assert.strictEqual(out.tx, -700);
  // Hunting player X: once X is out of view, X's blob may be eaten, another player's blob may not.
  const b = brain();
  out = b.botThink(view([cell(1, ME, 0, 0, 100), cell(2, 'X', 900, 0, 40)], 1));
  assert.strictEqual(out.tx, 900);
  out = b.botThink(view([
    cell(1, ME, 0, 0, 100), cell(8, 'Y', -60, 0, 36, 'ejected'), cell(9, 'X', 300, 300, 36, 'ejected'),
  ], 2));
  assert.deepStrictEqual([out.tx, out.ty], [300, 300]);
  // Another bot is prey or threat exactly like a human.
  const asHuman = brain().botThink(view([cell(1, ME, 0, 0, 150), cell(2, 'human', 400, 0, 50)]));
  const asBot = brain().botThink(view([cell(1, ME, 0, 0, 150), Object.assign(cell(2, 'bot9', 400, 0, 50), { bot: true })]));
  assert.deepStrictEqual(asBot, asHuman);
  const fleeBot = brain().botThink(view([cell(1, ME, 0, 0, 100), Object.assign(cell(2, 'bot9', 300, 0, 200), { bot: true })]));
  assert.ok(fleeBot.tx < 0);
});

test('fuzz: never ejects, never throws, integer targets inside the border', () => {
  const r = createRng(99);
  const kinds = ['player', 'food', 'virus', 'ejected'];
  for (let n = 0; n < 2000; n++) {
    const b = brain(n);
    const cells = [cell(1, ME, r.range(-7000, 7000), r.range(-7000, 7000), r.range(20, 600))];
    if (r.chance(0.3)) cells.push(cell(11, ME, cells[0].x + r.range(-200, 200), cells[0].y, r.range(20, 300)));
    const k = r.int(40);
    for (let i = 0; i < k; i++) {
      cells.push(cell(100 + i, r.chance(0.5) ? 'p' + r.int(5) : null, cells[0].x + r.range(-1500, 1500),
        cells[0].y + r.range(-1500, 1500), r.range(5, 700), kinds[r.int(4)]));
    }
    if (r.chance(0.1)) cells.push({ id: 999, owner: 'z', x: NaN, y: 1, size: 5, kind: 'player' }, null);
    const out = b.botThink(view(cells, n));
    assert.ok(out, 'case ' + n);
    assert.strictEqual(out.eject, false);
    assert.strictEqual(typeof out.split, 'boolean');
    assert.ok(Number.isInteger(out.tx) && Number.isInteger(out.ty), 'case ' + n);
    assert.ok(out.tx >= BORDER.minX && out.tx <= BORDER.maxX && out.ty >= BORDER.minY && out.ty <= BORDER.maxY);
  }
});

test('flees along a wall instead of into it, and cornered bots still get a target inside the box', () => {
  // Bot near the east wall, threat to the west: no x run into the wall.
  const out = brain().botThink(view([cell(1, ME, 6900, 100, 100), cell(2, 'h', 6600, 0, 200)]));
  assert.ok(out.tx <= 6900);
  assert.ok(out.ty > 100);
  // Corner, threat on the diagonal.
  const c = brain().botThink(view([cell(1, ME, 6950, 6950, 100), cell(2, 'h', 6700, 6700, 200)]));
  assert.ok(c.tx < 6950 && c.ty < 6950 && c.tx >= BORDER.minX && c.ty >= BORDER.minY);
});

test('steers around a virus that would pop it, not around one it can hide behind', () => {
  const food = cell(6, null, 600, 0, 10, 'food');
  const virus = cell(4, null, 230, 0, 100, 'virus');
  const big = brain().botThink(view([cell(1, ME, 0, 0, 200), virus, food]));
  assert.ok(big.tx !== 600 || big.ty !== 0, 'big bot must not aim straight through the virus');
  assert.ok(big.tx < 0, 'pushed back off the virus');
  const small = brain().botThink(view([cell(1, ME, 0, 0, 50), cell(4, null, 160, 0, 100, 'virus'), food]));
  assert.deepStrictEqual([small.tx, small.ty], [600, 0]);
});

test('a bot with no cells returns null; nothing it sees is ignored when far away', () => {
  assert.strictEqual(brain().botThink(view([cell(2, 'h', 0, 0, 100)])), null);
  assert.strictEqual(brain().botThink(null), null);
  // A threat far beyond sense range does not make it flee.
  const out = brain().botThink(view([cell(1, ME, 0, 0, 50), cell(2, 'h', 5000, 0, 400), cell(6, null, 100, 0, 10, 'food')]));
  assert.strictEqual(out.tx, 100);
});

test('deterministic and free of Math.random: same seed, same views, same answers', () => {
  const real = Math.random;
  Math.random = () => { throw new Error('Math.random used'); };
  try {
    const run = (seed) => {
      const b = B.createBotBrain({ laws: FIXTURE, seed });
      const r = createRng(5);
      const outs = [];
      let x = 0;
      let y = 0;
      for (let t = 0; t < 600; t++) {
        const cells = [cell(1, ME, x, y, 80)];
        if (t % 50 < 20) cells.push(cell(2, 'h', x + r.range(-500, 500), y + r.range(-500, 500), r.range(20, 200)));
        const o = b.botThink(view(cells, t));
        outs.push(o);
        x += Math.sign(o.tx - x) * 5;
        y += Math.sign(o.ty - y) * 5;
      }
      return JSON.stringify(outs);
    };
    assert.strictEqual(run(7), run(7));
    assert.notStrictEqual(run(7), run(8));
    // Wander uses the seeded rng: an empty world gives a new point every WANDER_TICKS.
    const b = brain(3);
    const a0 = b.botThink(view([cell(1, ME, 0, 0, 50)], 0));
    const a1 = b.botThink(view([cell(1, ME, 0, 0, 50)], B.BOT_TUNING.WANDER_TICKS.value - 1));
    const a2 = b.botThink(view([cell(1, ME, 0, 0, 50)], B.BOT_TUNING.WANDER_TICKS.value));
    assert.deepStrictEqual(a0, a1);
    assert.notDeepStrictEqual(a0, a2);
  } finally {
    Math.random = real;
  }
});

test('THE ONE RULE: bots only where botsAllowed(), filled to the room size', () => {
  assert.deepStrictEqual(B.planBotFill({ botsAllowed: false, humans: 1, bots: 12 }, FIXTURE), { add: 0, remove: 12, want: 0 });
  assert.deepStrictEqual(B.planBotFill({ humans: 1, bots: 3 }, FIXTURE), { add: 0, remove: 3, want: 0 });
  assert.deepStrictEqual(B.planBotFill({ botsAllowed: 'yes', humans: 1, bots: 3 }, FIXTURE), { add: 0, remove: 3, want: 0 });
  // Fixture L39 = 50 players per room, BOT_FILL 'toRoomSize'.
  assert.deepStrictEqual(B.planBotFill({ botsAllowed: true, humans: 1, bots: 0 }, FIXTURE), { add: 49, remove: 0, want: 49 });
  assert.deepStrictEqual(B.planBotFill({ botsAllowed: true, humans: 3, bots: 49 }, FIXTURE), { add: 0, remove: 2, want: 47 });
  assert.deepStrictEqual(B.planBotFill({ botsAllowed: true, humans: 60, bots: 5 }, FIXTURE), { add: 0, remove: 5, want: 0 });
  assert.deepStrictEqual(B.planBotFill({ botsAllowed: true, humans: NaN, bots: -4 }, FIXTURE), { add: 50, remove: 0, want: 50 });
  // The real table has no room size yet (L39 UNKNOWN), so no room can fill bots on it.
  assert.throws(() => B.planBotFill({ botsAllowed: true, humans: 1, bots: 0 }, LAWS), /L39/);
  const n = B.botName(createRng(1));
  assert.ok(B.BOT_NAMES.includes(n));
});

test('every tuning number is labelled CHOSEN and no other number is in the code', () => {
  for (const k of Object.keys(B.BOT_TUNING)) {
    const e = B.BOT_TUNING[k];
    assert.strictEqual(e.status, 'CHOSEN', k);
    assert.ok(typeof e.value === 'number' && Number.isFinite(e.value), k);
    assert.ok(typeof e.note === 'string' && e.note.length > 10, k);
  }
  const src = fs.readFileSync(path.join(__dirname, '../server/ag/agBots.js'), 'utf8');
  assert.ok(!/Math\.random|Date\.now|new Date/.test(src.replace(/\/\/.*$/gm, '')), 'no Math.random or Date');
  assert.ok(!/\b[DW] \d{3,}/.test(src), 'no D/W line citations');
  assert.ok(!/agLawsFixture/.test(src), 'never imports the fixture');
  const begin = src.indexOf('// BEGIN BOT_TUNING');
  const end = src.indexOf('// END BOT_TUNING');
  assert.ok(begin > 0 && end > begin);
  const code = (src.slice(0, begin) + src.slice(end))
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  const nums = (code.match(/(?<![\w.])\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) || []).filter((n) => !['0', '1', '2'].includes(n));
  assert.deepStrictEqual(nums, [], 'numbers outside BOT_TUNING: ' + nums.join(', '));
});

// That every BOT_TUNING key is listed in the parity log is checked outside the repo (the log is not committed),
// by the parity log's own tool.

// Closed loop with toy movement (not the sim): the bot moves 8 units a tick toward its target, a bigger cell chases
// it straight at 6, pellets are eaten with the fixture L23 and L24 rules. A decent bot eats and is never cornered.
test('closed loop: a chased bot keeps eating and never gets cornered in a small box', () => {
  const r = createRng(4);
  const border = { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 };
  let food = [];
  for (let i = 0; i < 300; i++) food.push(cell(100 + i, null, r.range(-2000, 2000), r.range(-2000, 2000), 10, 'food'));
  const me = cell(1, ME, 0, 0, 40);
  const hunter = cell(2, 'h', 900, 0, 120);
  const b = brain(1);
  let eaten = 0;
  for (let t = 0; t < 3000; t++) {
    const o = b.botThink({ playerId: ME, tick: t, border, cells: [me, hunter].concat(food) });
    const dx = o.tx - me.x;
    const dy = o.ty - me.y;
    const d = Math.hypot(dx, dy);
    if (d > 0) {
      me.x += (dx / d) * Math.min(d, 8);
      me.y += (dy / d) * Math.min(d, 8);
    }
    me.x = Math.max(border.minX + 20, Math.min(border.maxX - 20, me.x));
    me.y = Math.max(border.minY + 20, Math.min(border.maxY - 20, me.y));
    const hd = Math.hypot(me.x - hunter.x, me.y - hunter.y);
    hunter.x += ((me.x - hunter.x) / hd) * 6;
    hunter.y += ((me.y - hunter.y) / hd) * 6;
    food = food.filter((f) => {
      if (Math.hypot(f.x - me.x, f.y - me.y) < me.size - f.size / 3) {
        eaten++;
        me.size = Math.sqrt(me.size * me.size + f.size * f.size);
        return false;
      }
      return true;
    });
    const caught = hunter.size >= 1.15 * me.size && Math.hypot(me.x - hunter.x, me.y - hunter.y) < hunter.size - me.size / 3;
    assert.ok(!caught, 'caught at tick ' + t);
  }
  assert.ok(eaten >= 20, 'ate ' + eaten);
});
