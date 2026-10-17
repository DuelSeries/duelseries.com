'use strict';
// Owner-spawned bots in the paid Paper.io arenas (Owen 2026-10-16: "the bots will never cash out, the money's always
// going to be on the board, I'm never going to be taking any money with my bots"). Tested:
//   - a rung target opens arena #1 with that many bots, saved, awake; down to 0 takes them out; bad numbers refused
//   - a bot that kills a person takes nothing: the money drops as a floor coin; a bot's own death moves nothing
//   - in an arena bots played in, the coins nobody collected go back to their droppers (the hour sweep through the
//     refund hook, a restart or crash as keyed owed rows journaled once), never the house sweep
//   - the ledger: stakes in == cash-outs + refunds + owed rows + money still in the arena; nothing to the house
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PaperArenas } = require('../server/paper/PaperArenas');
const { REASON, P, MP } = require('../server/paper/ArenaGame');
const { createAgJournal } = require('../server/ag/agJournal');

const C = 1000;
const at = (r, a) => new P.Vec2(C + Math.cos(a) * r, C + Math.sin(a) * r);
const KEY_RE = /^agowed:[0-9a-f-]{36}$/;

function world(saved) {
  let t = 5000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const io = { to: () => ({ emit() {}, volatile: { emit() {} } }) };
  const calls = { cashout: [], refund: [], sweep: [], breach: [] };
  const hooks = {
    onCashout: (o) => calls.cashout.push(o), onTransfer() {}, onRefund: (x) => calls.refund.push(x),
    onSweep: (x) => calls.sweep.push(x), onBreach: (x) => calls.breach.push(x),
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppbots-')), 'j.log');
  const journal = createAgJournal({ file, bootId: 'b1', log: { log() {}, warn() {}, error() {} } });
  const mem = { obj: saved || null };
  const botStore = { load: () => mem.obj, save: (o) => { mem.obj = o; return true; } };
  const arenas = new PaperArenas({ io, hooks, now: clock.now, paidEnabled: true, autoTick: false, warm: false, journal,
    botStore });
  return { arenas, clock, calls, mem, file };
}

let sn = 0;
function seat(room, spot, micro = 1000000) {
  const s = { id: 'ps' + ++sn, rooms: new Set(), join(r) { this.rooms.add(r); }, leave(r) { this.rooms.delete(r); }, emit() {} };
  const st = room.addHuman(s, { name: 'n-' + s.id, micro, wallet: 'W-' + s.id, spot, proof: 'proof-' + s.id });
  st.unit.locked = false;
  room._confirm(st);
  return st;
}

test('a rung target opens arena #1 with that many bots, saved and awake; 0 takes them out', () => {
  const w = world();
  assert.equal(w.arenas.setBotTarget(1, 4).ok, true);
  assert.deepEqual(w.mem.obj, { 1: 4 });
  const room = w.arenas.arenas[Object.keys(w.arenas.arenas).find((k) => w.arenas.arenas[k].some((r) => r.stake === 1))][0];
  assert.equal(room.index, 0);
  for (let i = 0; i < 120; i++) room.game.update(); // the arena tops up to its cap as its wall grows
  assert.equal(room.botCount, 4);
  assert.equal(room.awake, true);
  assert.equal(w.arenas.botCount(1), 4);
  w.arenas.setBotTarget(1, 0);
  assert.equal(room.botCount, 0);
  assert.equal(room.awake, false);
  assert.equal(w.arenas.setBotTarget(1, MP.FREE_BOTS_IDLE + 1).ok, false);
  assert.equal(w.arenas.setBotTarget(0, 2).ok, false, 'free arenas are not this switch');
});

test('saved targets come back at boot', () => {
  const w = world({ 0.5: 2 });
  w.arenas.startBots();
  assert.equal(w.arenas.botCount(0.5), 2);
});

function botScene() {
  const w = world();
  w.arenas.setBotTarget(1, 3);
  const room = w.arenas.seatFor(1).room;
  assert.equal(room.paidBots, true);
  room.game.radiusTarget = () => 950;
  room.game.setRadiusNow(950);
  const a = seat(room, at(300, 0.3));
  const b = seat(room, at(300, 2.9));
  const bot = room.game.units.find((u) => !u.isHuman);
  assert.ok(bot, 'a bot is in the arena');
  room.afterTick();
  assert.equal(room.botRoom, true);
  // the bot kills A: nothing to the bot, A's money is a floor coin
  room.game.kill(a.unit, bot, REASON.TRACK_CUT);
  assert.equal(room.bank.isOpen(bot.id), false, 'a bot never has an account');
  assert.equal(room.bank.floorMicro(), 1000000);
  // B kills the bot: no money moves
  room.game.kill(bot, b.unit, REASON.TRACK_CUT);
  assert.equal(room.bank.balance(b.unit.id), 1000000);
  return { w, room, a, b };
}

test('the hour sweep of a bot arena sends the coin back to its dropper, not the house', () => {
  const { w, room, a } = botScene();
  room.sweepPickups(w.clock.now() + MP.PICKUP_SWEEP_MS + 1);
  assert.deepEqual(w.calls.sweep, [], 'nothing to the house');
  assert.equal(w.calls.refund.length, 1);
  assert.equal(w.calls.refund[0].wallet, a.wallet);
  assert.equal(w.calls.refund[0].micro, 1000000);
  // ledger: in 2,000,000 == refunds + live (B's account)
  assert.equal(2000000, w.calls.refund[0].micro + room.bank.totalMicro());
});

test('a restart of a bot arena owes the floor back as keyed rows, journaled, never a house floor record', () => {
  const { w, room, a, b } = botScene();
  const rows = w.arenas.shutdownSettle('shutdown');
  const by = new Map(rows.map((r) => [r.wallet, r]));
  assert.equal(by.get(a.wallet).micro, 1000000, 'A\'s dropped coin back to A');
  assert.equal(by.get(b.wallet).micro, 1000000, 'B\'s balance refunded');
  for (const r of rows) assert.match(r.key, KEY_RE);
  const recs = fs.readFileSync(w.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(recs.filter((x) => x.t === 'floor').length, 0, 'no house floor record');
  const back = recs.find((x) => x.t === 'close' && x.key === by.get(a.wallet).key);
  assert.equal(back.why, 'botfloor');
  assert.deepEqual(w.calls.sweep, []);
  assert.equal(room.bank.totalMicro(), 0);
  assert.equal(2000000, rows.reduce((n, r) => n + r.micro, 0), 'stakes in == owed rows');
});
