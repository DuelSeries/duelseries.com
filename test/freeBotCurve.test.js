'use strict';
// The daily bot curve shared by the free agar.io and Paper.io rooms (server/botPopulation.js gameBotTarget): the same
// HOURLY shape and drift as the snake's, scaled per game; bots join one at a time and leave only as they die.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../server/botPopulation');
const { AgRoom } = require('../server/ag/agRoom');
const agBots = require('../server/ag/agBots');
const { FIXTURE } = require('./agLawsFixture');
const { PaperRoom } = require('../server/paper/PaperRoom');
const { MP } = require('../server/paper/ArenaGame');

const quiet = { error() {}, warn() {}, log() {} };
const DAY = Date.UTC(2026, 9, 21, 4); // midnight Eastern (EDT)

test('each game stays in its range, low before dawn, high in the evening, and never jumps', () => {
  for (const game of ['agar', 'paper', 'chomp']) {
    const { lo, hi } = P.GAME_CURVES[game];
    let prev = null, min = Infinity, max = -Infinity;
    for (let m = 0; m < 24 * 60 * 3; m++) {
      const n = P.gameBotTarget(game, DAY + m * 60000);
      assert.ok(Number.isInteger(n) && n >= lo && n <= hi, game + ' ' + n);
      if (prev !== null) assert.ok(Math.abs(n - prev) <= 1, game + ' moved ' + prev + ' to ' + n + ' in a minute');
      prev = n;
      min = Math.min(min, n);
      max = Math.max(max, n);
    }
    assert.ok(P.gameBotTarget(game, DAY + 5 * 3600000) < P.gameBotTarget(game, DAY + 21 * 3600000), game);
    assert.ok(max - min >= (hi - lo) * 0.6, game + ' uses its range');
  }
  assert.strictEqual(P.GAME_CURVES.agar.hi, require('../server/ag/agLaws').LAWS.L39.value);
  assert.strictEqual(P.GAME_CURVES.paper.hi, MP.FREE_BOTS_IDLE);
  // the snake's own number is unchanged by the refactor
  assert.strictEqual(P.botTarget(DAY), P.curveTarget(22, 101, DAY, 0));
});

test('agar free room: fills one bot per FILL_GAP_MS to the curve, sheds only as bots die', () => {
  let t = 0;
  let aim = 10;
  const r = new AgRoom({ laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: quiet,
    clock: () => t, botCurve: () => aim });
  const gap = agBots.BOT_TUNING.FILL_GAP_MS.value;
  r.fillBots();
  assert.strictEqual(r.botCount, 1);
  r.fillBots();
  assert.strictEqual(r.botCount, 1, 'no second bot inside the gap');
  for (let i = 0; i < 30; i++) { t += gap; r.fillBots(); }
  assert.strictEqual(r.botCount, 10, 'stops at the curve');
  aim = 4;
  t += gap;
  r.fillBots();
  assert.strictEqual(r.botCount, 10, 'a falling curve removes nobody alive');
  // a dead bot over the curve leaves instead of respawning
  const bot = r.bots.values().next().value;
  assert.strictEqual(r._autoBotCount() > r._botWant, true);
  r._removeBot(bot);
  assert.strictEqual(r.botCount, 9);
});

test('agar plan: the room size still yields at once, the curve never does', () => {
  const p = agBots.planBotFill({ humans: 2, bots: FIXTURE.L39.value - 1, botsAllowed: true, target: 20 }, FIXTURE);
  assert.strictEqual(p.want, 18);
  assert.strictEqual(p.yieldNow, 1);
  const q = agBots.planBotFill({ humans: 0, bots: 30, botsAllowed: true, target: 20 }, FIXTURE);
  assert.strictEqual(q.yieldNow, 0);
  assert.strictEqual(q.remove, 10);
  const old = agBots.planBotFill({ humans: 1, bots: 0, botsAllowed: true }, FIXTURE);
  assert.strictEqual(old.want, FIXTURE.L39.value - 1, 'no target: fills to the room size as before');
});

test('paper free arena: the automatic count is the curve, a Control number overrides it, Auto returns to it', () => {
  const hooks = {};
  for (const h of ['onCashout', 'onTransfer', 'onRefund', 'onSweep', 'onBreach']) hooks[h] = () => {};
  let aim = 7;
  const r = new PaperRoom({ stake: 0, hooks, autoTick: false, seed: 0.6, botCurve: () => aim });
  assert.strictEqual(r.game.freeSquares(), 7);
  aim = 99;
  assert.strictEqual(r.game.freeSquares(), MP.FREE_BOTS_IDLE, 'held to the stock type rows');
  r.game.setBotCap(3);
  assert.strictEqual(r.game.freeSquares(), 3);
  r.game.setBotCap(null);
  aim = 9;
  assert.strictEqual(r.game.freeSquares(), 9);
  const paid = new PaperRoom({ stake: 1, hooks, autoTick: false, seed: 0.6, botCurve: () => aim });
  assert.strictEqual(paid.game.botCurve, null, 'a paid arena never takes the curve');
});
