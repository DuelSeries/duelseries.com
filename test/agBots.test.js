'use strict';
// Bots for free agar.io rooms (CHOSEN, Q17 and Q18 plus Owen's 2026-10-07 "far too aggressive" feedback; build brief
// 9.2 agBots card), run on the FIXTURE law table. Exact checks pin the brain's luck with a fixed rng (u = 0.5: no aim
// error and only chances above one half pass; u = 0: every chance passes and the aim misses by the full jitter);
// the share tests use real seeds.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../server/ag/agBots');
const { LAWS, withValues } = require('../server/ag/agLaws');
const { createRng } = require('../server/ag/agRng');
const { FIXTURE, makeFixture } = require('./agLawsFixture');

const BORDER = { minX: -7071, minY: -7071, maxX: 7071, maxY: 7071 };
const ME = 'bot1';
const T = {};
for (const k of Object.keys(B.BOT_TUNING)) T[k] = B.BOT_TUNING[k].value;

function cell(id, owner, x, y, size, kind) {
  return { id, owner, x, y, size, kind: kind || 'player' };
}
function view(cells, tick, border) {
  return { playerId: ME, tick: tick || 0, border: border || BORDER, cells };
}
function brain(seed, laws) {
  return B.createBotBrain({ laws: laws || FIXTURE, seed: seed === undefined ? 7 : seed });
}
// An rng that always returns u (same helpers as agRng).
function fixedRng(u) {
  const r = () => u;
  r.next = r;
  r.int = (n) => Math.floor(u * n);
  r.range = (lo, hi) => lo + u * (hi - lo);
  r.chance = (p) => u < p;
  return r;
}
function pinned(personality, u, laws) {
  return B.createBotBrain({ laws: laws || FIXTURE, rng: fixedRng(u === undefined ? 0.5 : u), personality });
}

test('the brain refuses to start on missing laws and names them; the approved real table starts it', () => {
  assert.throws(() => B.createBotBrain({ laws: withValues(FIXTURE, { L24: null, L11: null }), seed: 1 }),
    (e) => /L24/.test(e.message) && /L11/.test(e.message));
  assert.doesNotThrow(() => brain());
  assert.doesNotThrow(() => B.createBotBrain({ laws: LAWS, seed: 1 }));
  assert.throws(() => B.createBotBrain({ laws: FIXTURE, seed: 1, personality: 'boss' }), /personality/);
});

test('personalities: about 15 percent hunters, 60 casual, 25 shy, drawn from the seed and kept for life', () => {
  assert.deepStrictEqual(Array.from(B.PERSONALITIES), ['hunter', 'casual', 'shy']);
  const shares = B.PERSONALITIES.map((p) => B.personalityProfile(p).SHARE);
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  const n = 20000;
  const seen = { hunter: 0, casual: 0, shy: 0 };
  for (let s = 0; s < n; s++) {
    const b = brain(s);
    assert.strictEqual(b.personality, B.drawPersonality(createRng(s)), 'the first draw of seed ' + s);
    assert.strictEqual(b.memory().personality, b.personality);
    seen[b.personality]++;
  }
  B.PERSONALITIES.forEach((p, i) => assert.ok(Math.abs(seen[p] / n - shares[i]) < 0.015, p + ' ' + seen[p] / n));
  // Forced personality (tests, owner console) and an unknown name.
  assert.strictEqual(B.createBotBrain({ laws: FIXTURE, seed: 1, personality: 'shy' }).personality, 'shy');
  assert.strictEqual(B.personalityProfile('boss'), null);
  // The design in numbers: hunters chase most and keep watch, casual bots are easy, shy bots run early and never chase.
  const H = B.personalityProfile('hunter');
  const C = B.personalityProfile('casual');
  const S = B.personalityProfile('shy');
  assert.ok(H.CHASE_CHANCE > C.CHASE_CHANCE && C.CHASE_CHANCE > 0 && S.CHASE_CHANCE === 0);
  assert.ok(H.PREY_RATIO > FIXTURE.L23.value && C.PREY_RATIO > H.PREY_RATIO);
  assert.ok(S.FLEE_MARGIN > H.FLEE_MARGIN && H.FLEE_MARGIN > C.FLEE_MARGIN);
  assert.ok(S.SPLIT_FEAR > C.SPLIT_FEAR && H.SPLIT_FEAR > C.SPLIT_FEAR);
  assert.ok(C.IDLE_SPLIT_CHANCE > S.IDLE_SPLIT_CHANCE && S.IDLE_SPLIT_CHANCE > H.IDLE_SPLIT_CHANCE && H.IDLE_SPLIT_CHANCE > 0);
  assert.ok(S.SPLIT_CHANCE === 0 && S.KEEPS_TO_EDGE === 1 && H.KEEPS_TO_EDGE === 0 && C.KEEPS_TO_EDGE === 0);
  for (const P of [H, C, S]) {
    assert.ok(P.THINK_MIN >= 3 && P.THINK_MAX >= P.THINK_MIN, P.name + ' reacts slower than every tick');
    assert.ok(P.AIM_JITTER > 0, P.name + ' aims imperfectly');
    assert.ok(P.SENSE_SHARE > 0 && P.SENSE_SHARE <= 1, P.name + ' senses no more than the room sends');
  }
});

test('every personality flees a size-200 player 300 units east (negative x offset)', () => {
  for (const p of B.PERSONALITIES) {
    const out = pinned(p).botThink(view([cell(1, ME, 0, 0, 100), cell(2, 'human', 300, 0, 200)]));
    assert.ok(out.tx < 0, p + ' tx ' + out.tx);
    assert.strictEqual(out.ty, 0);
    assert.strictEqual(out.split, false);
    assert.strictEqual(out.eject, false);
    // Same from every side: the target always points away from the threat.
    for (const [hx, hy] of [[-300, 0], [0, 300], [0, -300], [212, 212]]) {
      const o = pinned(p).botThink(view([cell(1, ME, 0, 0, 100), cell(2, 'human', hx, hy, 200)]));
      assert.ok(o.tx * hx + o.ty * hy < 0, p + ' threat at ' + hx + ',' + hy);
    }
  }
});

test('easy prey: a casual bot ignores a bigger player who could split onto it; hunters and shy bots run', () => {
  // Human size 150 at 500: its split piece (106) could swallow the size-60 bot from up to 912 away.
  assert.ok(B.splitKillRange(150, 60, FIXTURE) > 900);
  const cells = [cell(1, ME, 0, 0, 60), cell(2, 'human', 500, 0, 150), cell(6, null, 200, 100, 10, 'food')];
  assert.deepStrictEqual(pinned('casual').botThink(view(cells)), { tx: 200, ty: 100, split: false, eject: false });
  assert.ok(pinned('hunter').botThink(view(cells)).tx < 0);
  assert.ok(pinned('shy').botThink(view(cells)).tx < 0);
  // A casual bot still runs once the threat is right on it.
  const close = [cell(1, ME, 0, 0, 60), cell(2, 'human', 220, 0, 150), cell(6, null, 200, 100, 10, 'food')];
  assert.ok(pinned('casual').botThink(view(close)).tx < 0);
});

test('slow reactions: a bot decides every THINK_MIN to THINK_MAX ticks and holds its target in between', () => {
  for (const p of B.PERSONALITIES) {
    const P = B.personalityProfile(p);
    const b = brain(11);
    const forced = B.createBotBrain({ laws: FIXTURE, seed: 11, personality: p });
    let last = null;
    const gaps = new Set();
    for (let t = 0; t < 400; t++) {
      const wants = forced.wantsThink(t);
      const out = forced.botThink(view([cell(1, ME, 0, 0, 50), cell(6, null, 100 + t, 0, 10, 'food')], t));
      if (wants) {
        if (last !== null) gaps.add(t - last);
        last = t;
      } else {
        assert.strictEqual(out.split, false);
      }
    }
    for (const g of gaps) assert.ok(g >= P.THINK_MIN && g <= P.THINK_MAX, p + ' gap ' + g);
    assert.ok(gaps.size > 1, p + ' gaps vary');
    assert.ok(b.wantsThink(0), 'a fresh brain thinks at once');
  }
  // A threat that shows up between two decisions is only seen at the next one.
  const b = pinned('hunter');
  const calm = b.botThink(view([cell(1, ME, 0, 0, 100), cell(6, null, 300, 0, 10, 'food')], 0));
  assert.deepStrictEqual([calm.tx, calm.ty], [300, 0]);
  const next = B.personalityProfile('hunter').THINK_MIN + Math.floor(0.5 * (B.personalityProfile('hunter').THINK_MAX -
    B.personalityProfile('hunter').THINK_MIN + 1));
  const danger = [cell(1, ME, 0, 0, 100), cell(2, 'human', 300, 0, 200), cell(6, null, 300, 0, 10, 'food')];
  for (let t = 1; t < next; t++) {
    assert.strictEqual(b.wantsThink(t), false);
    assert.deepStrictEqual(b.botThink(view(danger, t)), { tx: 300, ty: 0, split: false, eject: false }, 'held at ' + t);
  }
  assert.strictEqual(b.wantsThink(next), true);
  assert.ok(b.botThink(view(danger, next)).tx < 0, 'runs at the next decision');
  // A bot that died and came back thinks at once; time running backwards (a new test clock) thinks at once too.
  b.botThink(view([cell(2, 'human', 0, 0, 100)], next + 1));
  assert.strictEqual(b.wantsThink(next + 2), true);
  assert.strictEqual(pinned('casual').wantsThink(-5), true);
});

test('a hunter splits at a size-50 player inside its split reach, aiming with its jitter', () => {
  const range = B.splitKillRange(150, 50, FIXTURE);
  // Piece 150 / sqrt 2 flies 780 * piece^0.0122 (fixture L11) and swallows within piece - 50 / 3 (fixture L24).
  const piece = 150 * Math.sqrt(0.5);
  assert.strictEqual(range, 780 * Math.pow(piece, 0.0122) + piece - 50 / 3);
  const H = B.personalityProfile('hunter');
  assert.ok(range * H.SPLIT_REACH > 400);
  const cells = [cell(1, ME, 0, 0, 150), cell(2, 'human', 400, 0, 50)];
  // Every chance passes (u = 0): the target misses by the full jitter on both axes (400 x 0.08 = 32).
  const j = 400 * H.AIM_JITTER;
  assert.deepStrictEqual(pinned('hunter', 0).botThink(view(cells)), { tx: 400 - j, ty: -j, split: true, eject: false });
  // u = 0.5: the chase starts (0.5 < 0.7) but the split chance (0.5) does not pass; no aim error.
  assert.deepStrictEqual(pinned('hunter', 0.5).botThink(view(cells)), { tx: 400, ty: 0, split: false, eject: false });
  // Over many seeds: about CHASE_CHANCE x SPLIT_CHANCE of fresh hunters split at once, all aim within the jitter.
  const n = 2000;
  let splits = 0;
  for (let s = 0; s < n; s++) {
    const b = B.createBotBrain({ laws: FIXTURE, seed: s, personality: 'hunter' });
    const o = b.botThink(view(cells));
    if (o.split) splits++;
    if (b.memory().mode === 'hunt') assert.ok(Math.abs(o.tx - 400) <= j + 1 && Math.abs(o.ty) <= j + 1);
  }
  const want = H.CHASE_CHANCE * H.SPLIT_CHANCE;
  assert.ok(Math.abs(splits / n - want) < 0.05, 'hunter split share ' + splits / n);
});

test('on the real table the split reach counts the measured L11 first step (the piece begins ahead of its parent)', () => {
  const { velocity, decayDiv, firstStep } = LAWS.L11.value;
  const piece = 150 * Math.sqrt(0.5);
  const eatDist = piece - 50 / LAWS.L24.value.div;
  // whole reach = firstStep + the rest of the boost after the first step: 98.42 + 733.5 x (1 - 1 / 9.737)
  const reach = firstStep + velocity * (1 - 1 / decayDiv);
  assert.ok(Math.abs(reach - 756.6) < 0.1, String(reach));
  assert.ok(Math.abs(B.splitKillRange(150, 50, LAWS) - (reach + eatDist)) < 1e-9);
  // without a firstStep (older tables, the fixture) the reach is the boost alone
  const plain = withValues(LAWS, { L11: { velocity, sizeExp: 0, decayDiv } });
  assert.ok(Math.abs(B.splitKillRange(150, 50, plain) - (velocity + eatDist)) < 1e-9);
});

test('casual bots rarely chase and only much smaller cells; hunters skip cells that are only just smaller', () => {
  const C = B.personalityProfile('casual');
  const n = 2000;
  let chases = 0;
  for (let s = 0; s < n; s++) {
    const b = B.createBotBrain({ laws: FIXTURE, seed: s, personality: 'casual' });
    b.botThink(view([cell(1, ME, 0, 0, 150), cell(2, 'human', 300, 0, 50)]));
    if (b.memory().mode === 'hunt') chases++;
  }
  assert.ok(Math.abs(chases / n - C.CHASE_CHANCE) < 0.03, 'casual chase share ' + chases / n);
  // Out of its chase range (edge gap 400 > 250): never, even with every chance passing.
  const far = pinned('casual', 0);
  far.botThink(view([cell(1, ME, 0, 0, 150), cell(2, 'human', 600, 0, 50)]));
  assert.notStrictEqual(far.memory().mode, 'hunt');
  // A shy bot never chases.
  const shy = pinned('shy', 0);
  shy.botThink(view([cell(1, ME, 0, 0, 150), cell(2, 'human', 300, 0, 50)]));
  assert.notStrictEqual(shy.memory().mode, 'hunt');
  // Hunter: 150 can eat 120 (needs 140.4) but 150 / 120 = 1.25 is under its PREY_RATIO; 100 is fine.
  const h1 = pinned('hunter', 0.5);
  h1.botThink(view([cell(1, ME, 0, 0, 150), cell(2, 'human', 400, 0, 120)]));
  assert.notStrictEqual(h1.memory().mode, 'hunt');
  const h2 = pinned('hunter', 0.5);
  h2.botThink(view([cell(1, ME, 0, 0, 150), cell(2, 'human', 400, 0, 100)]));
  assert.strictEqual(h2.memory().mode, 'hunt');
});

test('a chase gives up after GIVE_UP_TICKS and the bot rests HUNT_REST_TICKS before the next one', () => {
  const H = B.personalityProfile('hunter');
  const b = pinned('hunter', 0.5);
  const cells = [cell(1, ME, 0, 0, 150), cell(2, 'human', 700, 0, 100)];
  const modes = [];
  for (let t = 0; t < 400; t++) {
    if (!b.wantsThink(t)) continue;
    b.botThink(view(cells, t));
    modes.push([t, b.memory().mode]);
  }
  const ended = modes.find(([t, m]) => m !== 'hunt');
  assert.strictEqual(modes[0][1], 'hunt');
  assert.ok(ended[0] >= H.GIVE_UP_TICKS && ended[0] <= H.GIVE_UP_TICKS + H.THINK_MAX, 'gave up at ' + ended[0]);
  const again = modes.find(([t, m]) => t > ended[0] && m === 'hunt');
  assert.ok(again, 'hunts again later');
  assert.ok(again[0] >= ended[0] + H.HUNT_REST_TICKS && again[0] <= ended[0] + H.HUNT_REST_TICKS + H.THINK_MAX,
    'rested until ' + again[0]);
});

test('no split at prey when it is out of reach, the piece cannot eat it, or the cooldown runs', () => {
  // In chase range but outside the hunter's share of the split reach (640 < 700): chase without splitting.
  const H = B.personalityProfile('hunter');
  assert.ok(B.splitKillRange(150, 50, FIXTURE) * H.SPLIT_REACH < 700);
  let out = pinned('hunter', 0).botThink(view([cell(1, ME, 0, 0, 150), cell(2, 'human', 700, 0, 50)]));
  assert.deepStrictEqual(out, { tx: 700 - 700 * H.AIM_JITTER, ty: -700 * H.AIM_JITTER, split: false, eject: false });
  // Piece 42.43 of a size-60 cell cannot eat a size-40 cell (needs 46): hunt, no split.
  out = pinned('hunter', 0.5).botThink(view([cell(1, ME, 0, 0, 60), cell(2, 'human', 200, 0, 40)]));
  assert.strictEqual(out.split, false);
  assert.strictEqual(out.tx, 200);
  // Size 59.99 never splits; size 60 does with L8_CMP '>=', not with '>'.
  out = pinned('hunter', 0).botThink(view([cell(1, ME, 0, 0, 59.99), cell(2, 'human', 200, 0, 30)]));
  assert.strictEqual(out.split, false);
  out = pinned('hunter', 0).botThink(view([cell(1, ME, 0, 0, 60), cell(2, 'human', 200, 0, 30)]));
  assert.strictEqual(out.split, true);
  out = pinned('hunter', 0, makeFixture({ L8_CMP: '>' })).botThink(view([cell(1, ME, 0, 0, 60), cell(2, 'human', 200, 0, 30)]));
  assert.strictEqual(out.split, false);
  // Cooldown: one split, then none for SPLIT_COOLDOWN_TICKS (it keeps deciding every few ticks meanwhile).
  const b = pinned('hunter', 0);
  const cells = [cell(1, ME, 0, 0, 150), cell(2, 'human', 400, 0, 50)];
  assert.strictEqual(b.botThink(view(cells, 10)).split, true);
  const cd = T.SPLIT_COOLDOWN_TICKS;
  for (let t = 11; t < 10 + cd; t++) assert.strictEqual(b.botThink(view(cells, t)).split, false, 'tick ' + t);
  let again = null;
  for (let t = 10 + cd; t < 10 + cd + H.THINK_MAX + 1 && again === null; t++) if (b.botThink(view(cells, t)).split) again = t;
  assert.ok(again !== null && again >= 10 + cd, 'splits again once the cooldown is over');
  // Too many own cells: no split.
  const many = [];
  for (let i = 0; i < T.SPLIT_MAX_OWN_CELLS + 1; i++) many.push(cell(10 + i, ME, i * 5, 0, 150));
  out = pinned('hunter', 0).botThink(view(many.concat([cell(2, 'human', 400, 0, 50)])));
  assert.strictEqual(out.split, false);
});

test('a hunter does not split when a third cell could eat a split piece; a casual bot does not look', () => {
  // Size 135 cannot eat the size-150 bot (needs 175.5) nor be eaten by it (needs 115.4 or less), but can eat its
  // 106.07 pieces (needs 124.1).
  const risky = [cell(1, ME, 0, 0, 150), cell(2, 'human', 400, 0, 50), cell(3, 'other', -450, 0, 135)];
  const out = pinned('hunter', 0).botThink(view(risky));
  assert.strictEqual(out.split, false);
  assert.strictEqual(out.tx, 400 - 400 * B.personalityProfile('hunter').AIM_JITTER);
  // Control: the same cell farther than SPLIT_SAFE_MARGIN from the bot lets the split go.
  const ok = pinned('hunter', 0).botThink(view([
    cell(1, ME, 0, 0, 150), cell(2, 'human', 400, 0, 50), cell(3, 'other', -600, 0, 135),
  ]));
  assert.strictEqual(ok.split, true);
  // Careless: a casual bot splits at the same prey with the risky cell right there.
  assert.strictEqual(pinned('casual', 0).botThink(view(risky)).split, true);
});

test('careless splits: calm bots big enough split now and then toward food, more often when casual', () => {
  const rate = (p) => {
    let splits = 0;
    let thinks = 0;
    for (let s = 0; s < 300; s++) {
      const b = B.createBotBrain({ laws: FIXTURE, seed: s, personality: p });
      for (let t = 0; t < 200; t++) {
        if (!b.wantsThink(t)) continue;
        thinks++;
        // Size 80 (can split), alone with food: any split is a careless one. A split cools down like any other.
        if (b.botThink(view([cell(1, ME, 0, 0, 80), cell(6, null, 300, 0, 10, 'food')], t)).split) splits++;
      }
    }
    return splits / thinks;
  };
  const c = rate('casual');
  const h = rate('hunter');
  const s = rate('shy');
  assert.ok(c > s && s > h && h > 0, 'casual ' + c + ' shy ' + s + ' hunter ' + h);
  assert.ok(Math.abs(c - B.personalityProfile('casual').IDLE_SPLIT_CHANCE) < 0.004, 'casual ' + c);
  // Never too small to split, never with more than IDLE_SPLIT_MAX_CELLS cells, never while fleeing.
  const small = pinned('casual', 0).botThink(view([cell(1, ME, 0, 0, 59), cell(6, null, 300, 0, 10, 'food')]));
  assert.strictEqual(small.split, false);
  const pieces = [];
  for (let i = 0; i <= T.IDLE_SPLIT_MAX_CELLS; i++) pieces.push(cell(10 + i, ME, i * 200, 0, 80));
  assert.strictEqual(pinned('casual', 0).botThink(view(pieces.concat([cell(6, null, 300, 300, 10, 'food')]))).split, false);
  assert.strictEqual(pinned('casual', 0).botThink(view([cell(1, ME, 0, 0, 80), cell(2, 'h', 150, 0, 200)])).split, false);
  // With every chance passing it splits toward its food (aimed with its jitter).
  const go = pinned('casual', 0).botThink(view([cell(1, ME, 0, 0, 80), cell(6, null, 300, 0, 10, 'food')]));
  assert.strictEqual(go.split, true);
  assert.ok(go.tx > 0);
});

test('eats food: goes for the best pellet it can eat', () => {
  const out = pinned('casual').botThink(view([
    cell(1, ME, 0, 0, 50), cell(5, null, 100, 50, 10, 'food'), cell(6, null, 600, 0, 10, 'food'),
  ]));
  assert.deepStrictEqual(out, { tx: 100, ty: 50, split: false, eject: false });
  // Mirror-message booleans work as the kind too.
  const o2 = pinned('casual').botThink(view([cell(1, ME, 0, 0, 50), { id: 5, x: -80, y: 0, size: 10, food: true }]));
  assert.strictEqual(o2.tx, -80);
  // Aim error: with u = 0 it aims short and off to the side by AIM_JITTER of the distance.
  const C = B.personalityProfile('casual');
  const o3 = pinned('casual', 0).botThink(view([cell(1, ME, 0, 0, 50), cell(5, null, 400, 0, 10, 'food')]));
  assert.deepStrictEqual([o3.tx, o3.ty], [400 - 400 * C.AIM_JITTER, -400 * C.AIM_JITTER]);
});

test('shy bots keep to the edge: they head out from the middle and farm the outer band', () => {
  const S = B.personalityProfile('shy');
  assert.strictEqual(S.KEEPS_TO_EDGE, 1);
  const half = BORDER.maxX;
  // In the middle with food 300 away (not in the band, not a snack at its edge): head for the band instead.
  const mid = [cell(1, ME, 0, 0, 50), cell(6, null, 300, 0, 10, 'food')];
  const out = pinned('shy').botThink(view(mid));
  const band = Math.max(Math.abs(out.tx), Math.abs(out.ty)) / half;
  assert.ok(band >= T.EDGE_BAND_MIN && band <= T.EDGE_BAND_MAX, 'band ' + band);
  // A casual bot just takes that food.
  assert.deepStrictEqual([pinned('casual').botThink(view(mid)).tx], [300]);
  // A pellet right at its edge is still a snack.
  assert.strictEqual(pinned('shy').botThink(view([cell(1, ME, 0, 0, 50), cell(6, null, 120, 0, 10, 'food')])).tx, 120);
  // In the band: it eats band food and leaves the inner food alone.
  const edge = [cell(1, ME, 6000, 0, 50), cell(6, null, 6300, 100, 10, 'food'), cell(7, null, 5000, 0, 16, 'food')];
  assert.deepStrictEqual([pinned('shy').botThink(view(edge)).tx, pinned('shy').botThink(view(edge)).ty], [6300, 100]);
});

test('bots keep apart: a bot steps aside from a cell neither can eat instead of sliding over it', () => {
  const food = cell(6, null, 600, 0, 10, 'food');
  const alone = pinned('casual').botThink(view([cell(1, ME, 0, 0, 100), food]));
  assert.deepStrictEqual([alone.tx, alone.ty], [600, 0]);
  // An equal cell overlapping it in front (wandering to the map centre, u = 0.5): it steps aside, still going forward.
  const ahead = pinned('casual').botThink(view([cell(1, ME, -3000, 0, 100), cell(2, 'b2', -2850, 0, 100)]));
  assert.strictEqual(pinned('casual').botThink(view([cell(1, ME, -3000, 0, 100)])).ty, 0);
  assert.ok(ahead.tx > -3000 && ahead.ty !== 0, ahead.tx + ',' + ahead.ty);
  // The one in front is pushed on ahead, not turned round.
  const behind = pinned('casual').botThink(view([cell(1, ME, 0, 0, 100), cell(2, 'b2', -150, 0, 100), food]));
  assert.deepStrictEqual([behind.tx, behind.ty], [600, 0]);
  // Off to one side: it bears away from that side.
  const side = pinned('casual').botThink(view([cell(1, ME, 0, 0, 100), cell(2, 'b2', -100, 150, 100), food]));
  assert.ok(side.tx > 0 && side.ty < 0, side.tx + ',' + side.ty);
  // Far enough apart (gap at least SPACE_MARGIN): no steering.
  const far = pinned('casual').botThink(view([cell(1, ME, 0, 0, 100), cell(2, 'b2', 0, 200 + T.SPACE_MARGIN, 100), food]));
  assert.deepStrictEqual([far.tx, far.ty], [600, 0]);
});

// Overlap bug (2026-10-07 stacking check on the first build): two near-equal bots side by side made the same choice
// every think (same pellet, same prey, same flee heading) and, once touching, stayed merged for up to a minute.
function as(playerId, cells, tick) {
  return { playerId, tick: tick || 0, border: BORDER, cells };
}

test('overlap bug: two bots side by side never pick the same pellet; the nearer one keeps it', () => {
  // Pellet A is nearer the other bot, pellet B nearer this one: each takes its own (no aim error at u = 0.5).
  const cells = [cell(1, ME, 0, 0, 50), cell(2, 'b2', 150, 0, 50), cell(5, null, 300, 0, 10, 'food'),
    cell(6, null, 0, -300, 10, 'food')];
  const mine = pinned('casual');
  const theirs = pinned('casual');
  const o1 = mine.botThink(as(ME, cells));
  assert.deepStrictEqual([o1.tx, o1.ty, mine.memory().goalId], [0, -300, 6]);
  assert.deepStrictEqual([theirs.botThink(as('b2', cells)).tx, theirs.memory().goalId], [300, 5]);
  // Alone, pellet A is this bot's pick (it scores the same as B and comes first).
  assert.strictEqual(pinned('casual').botThink(as(ME, [cells[0], cells[2], cells[3]])).tx, 300);
  // Only a near-equal cell is a rival: a cell it could eat, or a bigger one outside its flee distance, nearer the
  // pellet does not take it away (those are prey and threats, handled as before).
  const tiny = [cell(1, ME, 0, 0, 50), cell(2, 'b2', 250, 0, 30), cell(5, null, 300, 0, 10, 'food')];
  assert.strictEqual(pinned('casual').botThink(as(ME, tiny)).tx, 300);
  const big = [cell(1, ME, 0, 0, 50), cell(2, 'b2', 400, 0, 70), cell(5, null, 300, 0, 10, 'food')];
  const ob = pinned('casual');
  assert.strictEqual(ob.botThink(as(ME, big)).tx, 300);
  assert.strictEqual(ob.memory().mode, 'eat');
  // A human counts exactly like a bot (never team, never favour bots).
  const human = [cell(1, ME, 0, 0, 50), cell(2, 'human', 260, 0, 50), cell(5, null, 300, 0, 10, 'food')];
  const out = pinned('casual').botThink(as(ME, human));
  assert.notStrictEqual(out.tx, 300);
});

test('overlap bug: two bots exactly on top of each other split up (an exact tie goes by player id)', () => {
  // Same spot, same size, one pellet straight above: the lower id keeps the pellet, the other leaves it; each is
  // pushed the opposite way, so they come apart on the next tick.
  const cells = [cell(1, 'a1', 1000, 1000, 80), cell(2, 'b2', 1000, 1000, 80), cell(5, null, 1000, 1600, 10, 'food')];
  const a = pinned('casual');
  const b = pinned('casual');
  const oa = a.botThink(as('a1', cells));
  const ob = b.botThink(as('b2', cells));
  assert.strictEqual(a.memory().goalId, 5);
  assert.strictEqual(b.memory().goalId, null);
  assert.ok(oa.tx > 1000 && oa.ty > 1000, 'a heads up for the pellet and steps right ' + oa.tx + ',' + oa.ty);
  assert.ok(ob.tx < 1000, 'b steps left ' + ob.tx + ',' + ob.ty);
  // Both wandering (no food): still opposite pushes, never the same target.
  const bare = cells.slice(0, 2);
  const wa = pinned('casual').botThink(as('a1', bare));
  const wb = pinned('casual').botThink(as('b2', bare));
  assert.notDeepStrictEqual([wa.tx, wa.ty], [wb.tx, wb.ty]);
});

test('overlap bug: two hunters side by side never chase the same prey; the nearer one does', () => {
  // Two equal hunters (neither can eat the other) and a small player in reach; u = 0.5 passes the hunter's chase
  // chance. The nearer hunter chases; the other leaves it and eats the pellet behind it instead.
  const cells = [cell(1, ME, 0, 0, 150), cell(2, 'b2', 100, 0, 150), cell(3, 'human', 450, 0, 50),
    cell(5, null, -300, 0, 10, 'food')];
  const mine = pinned('hunter');
  const theirs = pinned('hunter');
  mine.botThink(as(ME, cells));
  theirs.botThink(as('b2', cells));
  assert.deepStrictEqual([theirs.memory().mode, theirs.memory().goalId], ['hunt', 3]);
  assert.deepStrictEqual([mine.memory().mode, mine.memory().goalId], ['eat', 5]);
  // Alone, this hunter would have chased it.
  const alone = pinned('hunter');
  alone.botThink(as(ME, [cells[0], cells[2], cells[3]]));
  assert.strictEqual(alone.memory().mode, 'hunt');
});

test('overlap bug: two bots fleeing one threat side by side keep their space instead of running as one', () => {
  // A size-200 threat due east of two overlapping size-50 bots in a row: both run due west, so the same heading would
  // keep them stacked. The one behind steps aside; the one in front is pushed on ahead.
  const cells = [cell(1, ME, 0, 0, 50), cell(2, 'b2', -20, 0, 50), cell(3, 'big', 250, 0, 200)];
  const mine = pinned('casual').botThink(as(ME, cells));
  const theirs = pinned('casual').botThink(as('b2', cells));
  assert.ok(mine.tx < 0 && theirs.tx < -20, 'both flee west ' + mine.tx + ' ' + theirs.tx);
  assert.ok(mine.ty < 0, 'the one behind steps aside ' + mine.ty);
  assert.strictEqual(theirs.ty, 0);
  assert.notDeepStrictEqual([mine.tx, mine.ty], [theirs.tx, theirs.ty]);
});

// Closed loop on the real sim (FIXTURE table, no viruses, food on): two equal bots dropped on the same spot. Measured
// 2026-10-07: they come apart in 4 to 6 ticks and never stack again (before the fix: 15 to 25 ticks).
test('overlap bug: closed loop on the sim, two equal bots dropped on one spot come apart and stay apart', () => {
  const { createSim } = require('../server/ag/agSim');
  for (const [pa, pb] of [['casual', 'casual'], ['hunter', 'hunter'], ['shy', 'casual'], ['shy', 'shy']]) {
    const sim = createSim({ laws: FIXTURE, seed: 3, border: { minX: -3000, minY: -3000, maxX: 3000, maxY: 3000 },
      viruses: false });
    for (let i = 0; i < 200; i++) sim.step();
    const bots = [pa, pb].map((personality, i) => {
      const pid = sim.addPlayer({ name: 'b' + i, bot: true });
      sim.debugPlace({ kind: 'player', owner: pid, x: 500, y: 500, size: 90 });
      return { pid, brain: B.createBotBrain({ laws: FIXTURE, seed: 11 + i, personality }) };
    });
    let stacked = 0;
    let firstApart = null;
    const TICKS = 1500;
    for (let t = 0; t < TICKS; t++) {
      for (const b of bots) {
        const info = sim.playerInfo(b.pid);
        if (!info.cells.length || !b.brain.wantsThink(sim.tick())) continue;
        const cells = [];
        sim.forEachCellInRect(-3000, -3000, 3000, 3000, (c) => {
          cells.push({ id: c.id, owner: c.owner, x: c.x, y: c.y, size: c.size, kind: c.kind });
        });
        const o = b.brain.think({ playerId: b.pid, tick: sim.tick(), border: sim.border(), cells });
        if (o) sim.setInput(b.pid, { x: o.tx, y: o.ty, split: false, eject: false });
      }
      sim.step();
      const [ca, cb] = bots.map((b) => sim.playerInfo(b.pid).cells.map((id) => sim.getCell(id)));
      if (!ca.length || !cb.length) break;
      let deep = false;
      for (const p of ca) for (const q of cb) if (Math.hypot(p.x - q.x, p.y - q.y) < Math.max(p.size, q.size)) deep = true;
      if (deep) stacked++;
      else if (firstApart === null) firstApart = t;
    }
    assert.ok(firstApart !== null && firstApart < 10, pa + '+' + pb + ' apart after ' + firstApart + ' ticks');
    assert.ok(stacked < 30, pa + '+' + pb + ' stacked ' + stacked + ' of ' + TICKS + ' ticks');
  }
});

test('never team: ignores blobs from players it is not hunting, treats bots like humans, never ejects', () => {
  // A juicy blob from another player right next to the bot is ignored; the far food wins.
  let out = pinned('hunter').botThink(view([
    cell(1, ME, 0, 0, 50), cell(7, 'feeder', 40, 0, 36, 'ejected'), cell(6, null, 700, 0, 10, 'food'),
  ]));
  assert.strictEqual(out.tx, 700);
  // A blob with no known owner is ignored too.
  out = pinned('hunter').botThink(view([cell(1, ME, 0, 0, 50), cell(7, null, 40, 0, 36, 'ejected'), cell(6, null, -700, 0, 10, 'food')]));
  assert.strictEqual(out.tx, -700);
  // Hunting player X: once X is out of view, X's blob may be eaten, another player's blob may not.
  const b = pinned('hunter');
  out = b.botThink(view([cell(1, ME, 0, 0, 100), cell(2, 'X', 600, 0, 40)], 1));
  assert.strictEqual(out.tx, 600);
  assert.strictEqual(b.memory().mode, 'hunt');
  out = b.botThink(view([
    cell(1, ME, 0, 0, 100), cell(8, 'Y', -60, 0, 36, 'ejected'), cell(9, 'X', 300, 300, 36, 'ejected'),
  ], 10));
  assert.deepStrictEqual([out.tx, out.ty], [300, 300]);
  // Another bot is prey or threat exactly like a human.
  const asHuman = brain().botThink(view([cell(1, ME, 0, 0, 150), cell(2, 'human', 400, 0, 50)]));
  const asBot = brain().botThink(view([cell(1, ME, 0, 0, 150), Object.assign(cell(2, 'bot9', 400, 0, 50), { bot: true })]));
  assert.deepStrictEqual(asBot, asHuman);
  const fleeBot = pinned('casual').botThink(view([cell(1, ME, 0, 0, 100), Object.assign(cell(2, 'bot9', 250, 0, 200), { bot: true })]));
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
    for (let t = 0; t < 3; t++) {
      const out = b.botThink(view(cells, n + t * 7));
      assert.ok(out, 'case ' + n);
      assert.strictEqual(out.eject, false);
      assert.strictEqual(typeof out.split, 'boolean');
      assert.ok(Number.isInteger(out.tx) && Number.isInteger(out.ty), 'case ' + n);
      assert.ok(out.tx >= BORDER.minX && out.tx <= BORDER.maxX && out.ty >= BORDER.minY && out.ty <= BORDER.maxY);
    }
  }
});

test('flees along a wall instead of into it, and cornered bots still get a target inside the box', () => {
  for (const p of B.PERSONALITIES) {
    // Bot near the east wall, threat to the west: no x run into the wall.
    const out = pinned(p).botThink(view([cell(1, ME, 6900, 100, 100), cell(2, 'h', 6600, 0, 200)]));
    assert.ok(out.tx <= 6900, p);
    assert.ok(out.ty > 100, p);
    // Corner, threat on the diagonal.
    const c = pinned(p).botThink(view([cell(1, ME, 6950, 6950, 100), cell(2, 'h', 6700, 6700, 200)]));
    assert.ok(c.tx < 6950 && c.ty < 6950 && c.tx >= BORDER.minX && c.ty >= BORDER.minY, p);
  }
});

test('steers around a virus that would pop it, not around one it can hide behind', () => {
  const food = cell(6, null, 600, 0, 10, 'food');
  const virus = cell(4, null, 230, 0, 100, 'virus');
  const big = pinned('casual').botThink(view([cell(1, ME, 0, 0, 200), virus, food]));
  assert.ok(big.tx !== 600 || big.ty !== 0, 'big bot must not aim straight through the virus');
  assert.ok(big.tx < 0, 'pushed back off the virus');
  const small = pinned('casual').botThink(view([cell(1, ME, 0, 0, 50), cell(4, null, 160, 0, 100, 'virus'), food]));
  assert.deepStrictEqual([small.tx, small.ty], [600, 0]);
});

test('a bot with no cells returns null; nothing it sees is ignored when far away', () => {
  assert.strictEqual(brain().botThink(view([cell(2, 'h', 0, 0, 100)])), null);
  assert.strictEqual(brain().botThink(null), null);
  // A threat far beyond sense range does not make it flee.
  for (const p of B.PERSONALITIES) {
    const out = pinned(p).botThink(view([cell(1, ME, 0, 0, 50), cell(2, 'h', 5000, 0, 400), cell(6, null, 100, 0, 10, 'food')]));
    assert.strictEqual(out.tx, 100, p);
  }
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
    // Wander uses the seeded rng: an empty world gives a new point every WANDER_TICKS, for every personality.
    for (const p of B.PERSONALITIES) {
      const b = B.createBotBrain({ laws: FIXTURE, seed: 3, personality: p });
      const a0 = b.botThink(view([cell(1, ME, 0, 0, 50)], 0));
      const a1 = b.botThink(view([cell(1, ME, 0, 0, 50)], T.WANDER_TICKS - 1));
      let t2 = T.WANDER_TICKS;
      while (!b.wantsThink(t2)) t2++;   // the first decision at or after WANDER_TICKS
      const a2 = b.botThink(view([cell(1, ME, 0, 0, 50)], t2));
      assert.deepStrictEqual(a0, a1, p);
      assert.notDeepStrictEqual(a0, a2, p);
    }
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
  // The real table: Owen approved 54 players per room (L39, 2026-10-02). Without a room size nothing fills.
  assert.deepStrictEqual(B.planBotFill({ botsAllowed: true, humans: 1, bots: 0 }, LAWS),
    { add: 53, remove: 0, want: 53 });
  assert.throws(() => B.planBotFill({ botsAllowed: true, humans: 1, bots: 0 }, withValues(LAWS, { L39: null })), /L39/);
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

// Closed loop with toy movement (not the sim): the bot moves 8 units a tick toward its target, a bigger cell may
// chase it straight at 6, pellets are eaten with the fixture L23 and L24 rules.
function toyRun(personality, seed, chased) {
  const r = createRng(4);
  const border = { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 };
  let food = [];
  for (let i = 0; i < 300; i++) food.push(cell(100 + i, null, r.range(-2000, 2000), r.range(-2000, 2000), 10, 'food'));
  const me = cell(1, ME, 0, 0, 40);
  const hunter = cell(2, 'h', 900, 0, 120);
  const b = B.createBotBrain({ laws: FIXTURE, seed, personality });
  let eaten = 0;
  let caughtAt = null;
  let inBand = 0;
  for (let t = 0; t < 3000; t++) {
    const o = b.botThink({ playerId: ME, tick: t, border, cells: [me].concat(chased ? [hunter] : [], food) });
    const dx = o.tx - me.x;
    const dy = o.ty - me.y;
    const d = Math.hypot(dx, dy);
    if (d > 0) {
      me.x += (dx / d) * Math.min(d, 8);
      me.y += (dy / d) * Math.min(d, 8);
    }
    me.x = Math.max(border.minX + 20, Math.min(border.maxX - 20, me.x));
    me.y = Math.max(border.minY + 20, Math.min(border.maxY - 20, me.y));
    if (Math.max(Math.abs(me.x), Math.abs(me.y)) / border.maxX >= T.EDGE_BAND_MIN) inBand++;
    if (chased) {
      const hd = Math.hypot(me.x - hunter.x, me.y - hunter.y);
      hunter.x += ((me.x - hunter.x) / hd) * 6;
      hunter.y += ((me.y - hunter.y) / hd) * 6;
    }
    food = food.filter((f) => {
      if (Math.hypot(f.x - me.x, f.y - me.y) < me.size - f.size / 3) {
        eaten++;
        me.size = Math.sqrt(me.size * me.size + f.size * f.size);
        return false;
      }
      return true;
    });
    const caught = hunter.size >= 1.17 * me.size && Math.hypot(me.x - hunter.x, me.y - hunter.y) < hunter.size - me.size / 3;
    if (chased && caught && caughtAt === null) caughtAt = t;
  }
  return { eaten, caughtAt, band: inBand / 3000 };
}

test('closed loop: chased hunters and shy bots keep eating and never get cornered; casual bots still eat', () => {
  for (const seed of [1, 2, 3]) {
    for (const p of ['hunter', 'shy']) {
      const r = toyRun(p, seed, true);
      assert.strictEqual(r.caughtAt, null, p + ' seed ' + seed + ' caught at ' + r.caughtAt);
      assert.ok(r.eaten >= 20, p + ' ate ' + r.eaten);
    }
    assert.ok(toyRun('casual', seed, true).eaten >= 20);
  }
});

test('closed loop: left alone, shy bots spend most of their time near the edge, the others do not', () => {
  for (const seed of [1, 2, 3]) {
    const shy = toyRun('shy', seed, false);
    assert.ok(shy.band >= 0.65, 'shy seed ' + seed + ' band ' + shy.band);
    assert.ok(shy.eaten >= 50, 'shy ate ' + shy.eaten);
    for (const p of ['hunter', 'casual']) {
      const r = toyRun(p, seed, false);
      assert.ok(r.band < 0.5, p + ' seed ' + seed + ' band ' + r.band);
    }
  }
});
