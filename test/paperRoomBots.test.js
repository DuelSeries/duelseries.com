'use strict';
// THE ONE RULE for Paper (T7): paid arenas never have bots; bots never hold money or fire hooks.
const test = require('node:test');
const assert = require('node:assert');
const { PaperRoom } = require('../server/paper/PaperRoom');
const { MP } = require('../server/paper/ArenaGame');

function room(stake, calls) {
  const hooks = {};
  for (const h of ['onCashout', 'onTransfer', 'onRefund', 'onSweep', 'onBreach']) hooks[h] = (x) => calls.push([h, x]);
  return new PaperRoom({ stake, hooks, autoTick: false, seed: 0.6 });
}

test('botsAllowed follows the stake number; a paid room refuses and clears bots', () => {
  const calls = [];
  for (const stake of [0.1, 1]) {
    const r = room(stake, calls);
    assert.strictEqual(r.isFree(), false);
    assert.strictEqual(r.botsAllowed(), false);
    assert.strictEqual(r.addBot(), null);
    r.topUpBots();
    for (let i = 0; i < 300; i++) r.tickOnce();
    assert.strictEqual(r.botCount, 0);
    assert.strictEqual(r.game.config.botsCount, 0);
  }
  const free = room(0, calls);
  assert.strictEqual(free.isFree(), true);
  assert.strictEqual(free.botsAllowed(), true);
  let bot = null;
  for (let i = 0; i < 50 && !bot; i++) bot = free.addBot();
  assert.ok(bot && !bot.isHuman);
  free.clearBots();
  assert.strictEqual(free.botCount, 0);
});

test('bots hold no account and never trigger a hook', () => {
  const calls = [];
  const r = room(0, calls);
  let deaths = 0;
  const od = r.onDeath.bind(r);
  r.onDeath = (v, ...rest) => { if (!v.isHuman) deaths++; return od(v, ...rest); };
  for (let i = 0; i < 3000; i++) r.tickOnce();
  assert.ok(r.botCount >= 10 && r.botCount <= MP.FREE_BOTS_IDLE);
  assert.strictEqual(r.bank.openIds().length, 0);
  assert.strictEqual(r.bank.ledger.inMicro, 0);
  assert.deepStrictEqual(calls, []);
  assert.ok(deaths > 0, 'bots did die in that time: ' + deaths);
});
