'use strict';
// Paid Paper.io bounty bots (Owen 2026-10-17, as paid slither and agar.io): each bot spawns worth its arena's stake
// from the owner's bot bank, kills and is killed for money like a person, shows its $ like a person, never cashes out,
// and is never replaced. Tested:
//   - the bank and the daily limit decide how many spawn; Control 0 gives every seed back; saved counts come back
//   - a bot kills a person and holds that money; a person kills the bot and wins all of it (the seed spent)
//   - a bot dying with nobody to take it (its own trail, removal): seed back to the bank, the rest owed back keyed
//   - restart: the bot's seed back and its taken money as keyed rows journaled once, never a house floor record
//   - ledger: stakes in + seed in == cash-outs + owed + seed back + live; nothing to the house
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaperArenas } = require('../server/paper/PaperArenas');
const { REASON, P } = require('../server/paper/ArenaGame');
const { createAgJournal } = require('../server/ag/agJournal');
const { createBotBank } = require('../server/botBank');

const C = 1000;
const at = (r, a) => new P.Vec2(C + Math.cos(a) * r, C + Math.sin(a) * r);
const KEY_RE = /^agowed:[0-9a-f-]{36}$/;
const quiet = { log() {}, warn() {}, error() {} };
const STAKE = 1000000;

function world(saved, fundUsd = 50, capUsd = 50) {
  let t = 5000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const io = { to: () => ({ emit() {}, volatile: { emit() {} } }) };
  const calls = { cashout: [], refund: [], sweep: [], breach: [], owed: [] };
  const hooks = {
    onCashout: (o) => calls.cashout.push(o), onTransfer() {}, onRefund: (x) => calls.refund.push(x),
    onSweep: (x) => calls.sweep.push(x), onBreach: (x) => calls.breach.push(x),
    onOwed: (row) => { calls.owed.push(row); return Promise.resolve('owed'); },
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppbots-')), 'j.log');
  const journal = createAgJournal({ file, bootId: 'b1', log: quiet });
  const mem = { obj: saved || null };
  const botStore = { load: () => mem.obj, save: (o) => { mem.obj = o; return true; } };
  const bank = createBotBank({ file: path.join(path.dirname(file), 'bank.json'), log: quiet });
  if (fundUsd > 0) bank.credit(fundUsd * 1e6, 'SIG' + Math.random());
  bank.setCap(capUsd * 1e6);
  const arenas = new PaperArenas({ io, hooks, now: clock.now, paidEnabled: true, autoTick: false, warm: false, journal,
    botStore, botBank: bank });
  return { arenas, clock, calls, mem, file, bank };
}

const roomOf = (w, stake) => w.arenas.arenas[Object.keys(w.arenas.arenas)
  .find((k) => w.arenas.arenas[k].some((r) => r.stake === stake))][0];

let sn = 0;
function seat(room, spot, micro = STAKE) {
  const s = { id: 'ps' + ++sn, rooms: new Set(), join(r) { this.rooms.add(r); }, leave(r) { this.rooms.delete(r); }, emit() {} };
  const st = room.addHuman(s, { name: 'n-' + s.id, micro, wallet: 'W-' + s.id, spot, proof: 'proof-' + s.id });
  st.unit.locked = false;
  room._confirm(st);
  return st;
}

function ledger(w, room, rows) {
  const back = w.bank.view().log.filter((x) => x.kind === 'back').reduce((n, x) => n + Math.round(x.usd * 1e6), 0);
  const out = w.calls.cashout.reduce((n, o) => n + o.grossMicro, 0) + w.calls.owed.concat(rows || []).reduce((n, x) => n + x.micro, 0);
  const seeded = w.bank.view().log.filter((x) => x.kind === 'seed').reduce((n, x) => n + Math.round(x.usd * 1e6), 0);
  const stakes = room.bank.ledger.inMicro - seeded;
  assert.equal(stakes + seeded, out + back + room.bank.totalMicro(), 'stakes in + seed in == out + seed back + live');
  assert.deepEqual(w.calls.sweep, [], 'nothing to the house');
}

test('the bank and the daily limit decide how many spawn; each is worth the stake; Control 0 gives every seed back', () => {
  const w = world(null, 2.5, 50);
  const r = w.arenas.setBotTarget(1, 4);
  assert.equal(r.ok, true);
  assert.equal(r.live, 2);
  assert.match(r.why, /bot bank cannot cover/);
  const room = roomOf(w, 1);
  for (const id of room.botFrom.keys()) assert.equal(room.bank.balance(id), STAKE);
  assert.equal(room.awake, true);
  for (let i = 0; i < 60; i++) room.game.update();
  assert.equal(room.botCount, 2, 'the arena adds no bot of its own');
  w.arenas.setBotTarget(1, 0);
  assert.equal(room.botCount, 0);
  assert.equal(w.bank.balanceMicro(), 2500000, 'every seed back');
  const capped = world(null, 50, 1);
  assert.equal(capped.arenas.setBotTarget(1, 3).live, 1);
});

test('saved counts come back at boot', () => {
  const w = world({ 0.5: 1 });
  w.arenas.startBots();
  assert.equal(w.arenas.botCount(0.5), 1);
});

function scene() {
  const w = world();
  w.arenas.setBotTarget(1, 1);
  const room = w.arenas.seatFor(1).room;
  room.game.radiusTarget = () => 950;
  room.game.setRadiusNow(950);
  // room for the second on the wider wall (a spawn spot is random: a few tries)
  for (let i = 0; i < 20 && room.botCount < 2; i++) {
    w.arenas.setBotTarget(1, 2);
    room.game.update();
  }
  const a = seat(room, at(300, 0.3));
  const b = seat(room, at(300, 2.9));
  const bots = room.game.units.filter((u) => !u.isHuman);
  assert.equal(bots.length, 2);
  return { w, room, a, b, bot: bots[0], bot2: bots[1] };
}

test('a bot kills a person and holds it; a person kills the bot and wins it all; never replaced', () => {
  const { w, room, a, b, bot } = scene();
  room.game.kill(a.unit, bot, REASON.TRACK_CUT);
  assert.equal(room.bank.balance(bot.id), 2 * STAKE, 'its seed plus A\'s money');
  room.game.kill(bot, b.unit, REASON.TRACK_CUT);
  assert.equal(room.bank.balance(b.unit.id), 3 * STAKE);
  assert.equal(room.botFrom.has(bot.id), false);
  for (let i = 0; i < 60; i++) room.game.update();
  assert.equal(room.botCount, 1, 'the dead bot is not replaced');
  ledger(w, room);
});

test('a bot that dies to its own trail or is removed: seed back to the bank, the rest owed back keyed', () => {
  const { w, room, a, bot, bot2 } = scene();
  const bank0 = w.bank.balanceMicro();
  room.game.kill(a.unit, bot, REASON.TRACK_CUT);
  room.game.kill(bot, undefined, REASON.SELF_CROSS);
  assert.equal(w.bank.balanceMicro(), bank0 + STAKE, 'its seed back');
  assert.deepEqual(w.calls.owed.map((x) => [x.wallet, x.micro]), [[a.wallet, STAKE]]);
  assert.match(w.calls.owed[0].key, KEY_RE);
  room.game.kill(bot2, undefined, REASON.SYSTEM_REMOVED);
  assert.equal(w.bank.balanceMicro(), bank0 + 2 * STAKE);
  ledger(w, room);
});

test('a restart: the bot\'s seed back and its taken money as journaled keyed rows, never a house floor record', () => {
  const { w, room, a, bot } = scene();
  const bank0 = w.bank.balanceMicro();
  room.game.kill(a.unit, bot, REASON.TRACK_CUT);
  const rows = w.arenas.shutdownSettle('shutdown');
  assert.equal(w.bank.balanceMicro(), bank0 + 2 * STAKE, 'both seeds back');
  const mine = rows.find((r) => r.wallet === a.wallet);
  assert.equal(mine.micro, STAKE);
  const recs = fs.readFileSync(w.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(recs.some((x) => x.t === 'close' && x.key === mine.key && x.why === 'botfloor'));
  assert.equal(recs.filter((x) => x.t === 'floor').length, 0);
  assert.equal(room.bank.totalMicro(), 0);
  ledger(w, room, rows);
});
