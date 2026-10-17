'use strict';
// The bot bank top-up (server/botBankTopup.js): a plain USDC transfer into escrow from any sender the owner pastes in
// Control is credited once, by the amount escrow received; a player's wallet or an already-used signature never is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyTopup } = require('../server/botBankTopup');
const { createBotBank } = require('../server/botBank');

const quiet = { log() {}, warn() {}, error() {} };
const SIG = '5uRas62vnfyjQd2qRWr6SrxrdGuFLuNxjaNTZ8w9LrcesptEF1kMJnGnk4N2wzwJCTNVzaPMwjLFpNAsMdDQ7mJX';

function deps(chain, players, used) {
  const bank = createBotBank({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'topup-')), 'b.json'), log: quiet });
  const claimed = new Set(used || []);
  return {
    bank,
    d: {
      verify: async (sig) => {
        if (!chain[sig]) throw new Error('Stake transaction not found or not yet confirmed');
        return chain[sig];
      },
      isPlayerWallet: async (w) => (players || []).includes(w),
      markStakeSig: async (sig) => {
        if (claimed.has(sig)) return false;
        claimed.add(sig);
        return true;
      },
      botBank: bank,
      ownerWallets: ['REVENUE', 'OWNERGAME'],
    },
  };
}

test('a Coinbase-style transfer (an outside sender and fee payer) is credited once, by what escrow received', async () => {
  const { bank, d } = deps({ [SIG]: { payer: 'CoinbaseHot', usdc: 4.841215, senders: ['CoinbaseHot'] } }, ['PlayerW']);
  const r = await verifyTopup(SIG, d);
  assert.deepEqual(r, { ok: true, micro: 4841215 });
  assert.equal(bank.balanceMicro(), 4841215);
  const again = await verifyTopup(SIG, d);
  assert.equal(again.ok, false);
  assert.match(again.why, /already in the bot bank/);
  assert.equal(bank.balanceMicro(), 4841215);
});

test('a player stake signature is refused: already claimed by the stake, or sent from a player wallet', async () => {
  const stake = 'S'.repeat(88);
  // the player's stake verify claimed it first (the same one-time table)
  let t = deps({ [stake]: { payer: 'FeeSponsor', usdc: 0.5, senders: ['SomeWallet'] } }, [], [stake]);
  let r = await verifyTopup(stake, t.d);
  assert.equal(r.ok, false);
  assert.match(r.why, /already used/);
  assert.equal(t.bank.balanceMicro(), 0);
  // not claimed yet, but the money came from a player's game wallet (even with someone else paying the fee)
  t = deps({ [stake]: { payer: 'FeeSponsor', usdc: 0.5, senders: ['PlayerW'] } }, ['PlayerW']);
  r = await verifyTopup(stake, t.d);
  assert.equal(r.ok, false);
  assert.match(r.why, /player wallet/);
  assert.equal(t.bank.balanceMicro(), 0);
  // the owner's own game wallet is a player account too, and is allowed
  t = deps({ [stake]: { payer: 'OWNERGAME', usdc: 2, senders: ['OWNERGAME'] } }, ['OWNERGAME']);
  r = await verifyTopup(stake, t.d);
  assert.equal(r.ok, true);
});

test('bad shapes and unverified transfers credit nothing', async () => {
  const { bank, d } = deps({});
  assert.equal((await verifyTopup('nope', d)).ok, false);
  assert.match((await verifyTopup(SIG, d)).why, /Not verified/);
  assert.equal(bank.balanceMicro(), 0);
});
