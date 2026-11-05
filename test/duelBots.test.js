'use strict';
/* The owner's PAID duel bots (server/duelBots.js, Owen 2026-11-04): ledger tests.

   Every test runs the real queue (server/KnockoutLobby.js, server/swim/SwimLobby.js), the real room, the real Bot
   bank (server/botBank.js on a temp file, no chain) and the real settle (duelBots.settleTable) on a synthetic clock,
   with the payout side (koSend, sweepRake, trackEarning) recorded instead of sent. The invariants:

     L1  A bot's stake leaves the bank once (take) and its seat ends exactly once: back, lost or won.
     L2  Money is conserved per table: what went in (the person's stake + the bot's stake) equals what went out
         (the person's payout or refund + the house cut + what came back to the bank), to the micro.
     L3  The person is paid EXACTLY as against a person: a win is the pot less 10%, a draw their own stake, a loss 0.
     L4  A bot meets only a person who was shown it before paying (botOk) and queued after it; never another bot.
     L5  Nobody came: the stake goes back after a minute. Removal, the kill switch, a restart and a crash give it back
         too, once, with no owed row for the bot; a person mid-match gets the usual agowed: refund row.
     L6  A hard kill leaves the stake in flight in the bank file, and the next load gives it back, once.
     L7  The kill switch starts off, refuses spawns while off, and Off sends waiting bots home.
     L8  Only a paid bot is named a bot on the wire (vsBot); a free table's stand-in is not. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KnockoutLobby } = require('../server/KnockoutLobby');
const { SwimLobby } = require('../server/swim/SwimLobby');
const { createBotBank } = require('../server/botBank');
const { createDuelBots, BOT_WAIT_MS } = require('../server/duelBots');
const { createOwnerSpend } = require('../server/ownerSpend');
const { DUEL_HOUSE_CUT, duelMoney } = require('../server/duelMoney');

const io = { to: () => ({ emit() {} }) };
const quiet = { log() {}, warn() {}, error() {} };
function sock(id) {
  const sent = [];
  return { id, sent, rooms: new Set(), join(r) { this.rooms.add(r); }, leave(r) { this.rooms.delete(r); },
    emit(e, p) { sent.push({ e, p }); } };
}
const M = (usd) => Math.round(usd * 1e6);

/* One world: a bank holding $20, a Knockout lobby and a Swim lobby, the manager, a clock, and the payout side. */
function world(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duelbots-'));
  let clock = 1e12;
  const now = () => clock;
  const file = path.join(dir, 'bot-bank.json');
  fs.writeFileSync(file, JSON.stringify({ balance: M(20), capMicro: M(200), day: '', spent: 0, inflight: 0, topups: [], log: [] }));
  const spend = createOwnerSpend({ file: path.join(dir, 'owner-spend.json'), now, log: quiet });
  const bank = createBotBank({ file, now, log: quiet, onMove: (ev) => spend.bank(ev) });
  const ko = new KnockoutLobby(io);
  const sw = new SwimLobby(io);
  const out = { sends: [], rake: [], track: [], refunds: [] };
  const ctxFor = (game) => ({
    game, tag: '[T]', houseCut: DUEL_HOUSE_CUT, region: 'na',
    koSend: (wallet, amount, name, note) => out.sends.push({ wallet, micro: M(amount), note }),
    sweepRake: (cut) => out.rake.push(M(cut)),
    trackEarning: (o) => out.track.push(o),
  });
  const bots = createDuelBots({ bank, lobbies: { knockout: ko, swim: sw }, now, log: quiet, doorOpen: () => opts.door !== false });
  // the lobby's onSettled is index.js's: a bot table goes to duelBots first, a person-only table to the old path
  const humanTables = [];
  for (const [game, lob] of [['knockout', ko], ['swim', sw]]) {
    lob.onSettled = (o) => { if (bots.settleTable(o, ctxFor(game))) return; humanTables.push(o); };
    lob.onRefund = (r) => out.refunds.push(r);
  }
  const bal = () => bank.balanceMicro();
  return { dir, file, bank, ko, sw, bots, out, humanTables, spend, bal,
    tick(ms) { const end = clock + ms; while (clock < end) { clock = Math.min(end, clock + 200); ko.tick(clock); } },
    get now() { return clock; }, set now(v) { clock = v; } };
}

function inflight(file) { return JSON.parse(fs.readFileSync(file, 'utf8')).inflight; }

/* A person queues for the paid rung through the lobby, with or without the lobby's "Bot opponent waiting" yes. */
function personQueues(w, lob, id, stake, botOk) {
  const s = sock(id);
  if (lob instanceof SwimLobby) lob.enqueue(s, 'P' + id, 'W' + id, stake, stake, w.now, stake, null, null, { botOk });
  else lob.enqueue(s, 'P' + id, 'W' + id, stake, stake, w.now, stake, null, { botOk });
  return s;
}

test('L7: the kill switch starts off and refuses a spawn while off; nothing is taken', () => {
  const w = world();
  assert.equal(w.bots.enabled(), false);
  const r = w.bots.spawn('knockout', 0.5);
  assert.equal(r.ok, false);
  assert.match(r.why, /off/i);
  assert.equal(w.bal(), M(20));
});

test('L5 + L1: nobody came, so after a minute the stake goes back to the bank, once', () => {
  const w = world();
  w.bots.setEnabled(true);
  const r = w.bots.spawn('knockout', 1);
  assert.equal(r.ok, true);
  assert.equal(w.bal(), M(19), 'the stake left the bank');
  assert.equal(inflight(w.file), M(1), 'and is in flight, saved');
  assert.deepEqual(w.ko.botsWaitingByRung(), { 1: 1 });
  assert.deepEqual(w.ko.waitingByRung(), {}, 'a bot is not a waiting person');
  w.tick(BOT_WAIT_MS - 400);
  assert.equal(w.bal(), M(19), 'still waiting just inside its minute');
  w.tick(800);
  assert.equal(w.bal(), M(20), 'back in full');
  assert.equal(inflight(w.file), 0);
  assert.deepEqual(w.ko.botsWaitingByRung(), {});
  // a second return of the same seat is refused (the queue entry is gone, the manager forgot it)
  w.ko.refund({ socket: { id: r.id, emit() {} }, paidBot: { until: 0 }, worth: 1, stake: 1 }, 'again');
  assert.equal(w.bal(), M(20), 'never twice');
  assert.equal(w.out.refunds.length, 0, 'no person refund for a bot');
});

test('L4: a person who was not shown the bot, or queued before it, never meets it; two bots never meet', () => {
  const w = world();
  w.bots.setEnabled(true);
  personQueues(w, w.ko, 'early', 0.5, true);                         // queued BEFORE the bot existed
  w.tick(1000);
  assert.equal(w.bots.spawn('knockout', 0.5).ok, true);
  assert.equal(w.bots.spawn('knockout', 0.5).ok, true);              // a second bot at the same rung
  w.tick(1000);
  assert.equal(w.ko.roomOf('early'), null, 'a bot that came after them never meets them');
  assert.equal(w.ko.rooms.size, 0, 'the two bots did not pair with each other');
  personQueues(w, w.ko, 'blind', 0.5, false);                        // never saw "Bot opponent waiting"
  // ...those two people meet each other, never a bot
  const room = w.ko.roomOf('early');
  assert.ok(room && room === w.ko.roomOf('blind'), 'the two people were paired together');
  assert.ok(!room.bot, 'no bot at their table');
  const late = personQueues(w, w.ko, 'late', 0.5, false);            // a third person, not shown it
  w.tick(2000);
  assert.equal(w.ko.roomOf('late'), null, 'not shown, so not paired with a waiting bot');
  assert.ok(late);
  w.tick(BOT_WAIT_MS);
  assert.equal(w.bal(), M(20), 'both bots went home');
});

test('L4 + L8: a person shown the bot meets it at once; the screen names it a bot; it sits in the second seat', () => {
  const w = world();
  w.bots.setEnabled(true);
  w.bots.spawn('knockout', 0.5);
  w.tick(400);
  const p = personQueues(w, w.ko, 'p', 0.5, true);
  const room = w.ko.roomOf('p');
  assert.ok(room, 'matched on the spot');
  assert.equal(room.bot.paidBot, true);
  assert.equal(room.players.get('p').side, 0, 'the person sits first');
  assert.equal(room.pot(), 1, 'two stakes in the pot');
  assert.equal(room.publicState(w.now).vsBot, true, 'vsBot is sent for a paid bot');
  assert.deepEqual(w.ko.botsWaitingByRung(), {});
  assert.ok(p);
});

test('L8: a free table\'s stand-in is not named a bot any more', () => {
  const w = world();
  const s = sock('f');
  w.ko.enqueue(s, 'Pf', null, 0, 0, w.now);
  // just past the free wait: ticking a whole minute let the bot match itself finish and be swept (flaky)
  w.tick(KnockoutLobby.FREE_WAIT_MS + 400);
  const room = w.ko.roomOf('f');
  assert.ok(room && room.bot, 'the free table got its stand-in');
  assert.equal(room.publicState(w.now).vsBot, false);
});

/* One bot table settled three ways: L2 and L3 on the real room and the real settle. */
for (const [label, who] of [['the person wins', 'person'], ['the bot wins', 'bot'], ['a draw', 'none']]) {
  test('L2 + L3: ' + label + ': the person is paid as against a person and the ledger balances to the micro', () => {
    const w = world();
    w.bots.setEnabled(true);
    const stake = 1;
    const { id: botId } = w.bots.spawn('knockout', stake);
    w.tick(200);
    personQueues(w, w.ko, 'p', stake, true);
    const room = w.ko.roomOf('p');
    const winner = who === 'person' ? 'p' : who === 'bot' ? botId : null;
    room.finish(winner, who === 'none' ? 'draw' : 'test');
    const pot = M(2 * stake), cut = M(2 * stake * DUEL_HOUSE_CUT);
    const sentToPerson = w.out.sends.reduce((a, x) => a + x.micro, 0);
    const rake = w.out.rake.reduce((a, x) => a + x, 0);
    const bankBack = w.bal() - M(20 - stake);          // what came home to the bank from this table
    if (who === 'person') {
      assert.deepEqual(w.out.sends.map(x => [x.wallet, x.micro]), [['Wp', pot - cut]], 'the pot less 10%, to the person');
      assert.equal(rake, cut);
      assert.equal(bankBack, 0, 'the bot lost its stake');
    } else if (who === 'bot') {
      assert.equal(sentToPerson, 0, 'nothing to the person');
      assert.equal(rake, cut, 'the same house cut');
      assert.equal(bankBack, pot - cut, 'the pot less the cut came home');
    } else {
      assert.deepEqual(w.out.sends.map(x => [x.wallet, x.micro]), [['Wp', M(stake)]], 'their own stake back');
      assert.equal(rake, 0, 'no cut on a draw');
      assert.equal(bankBack, M(stake), 'the bot stake back');
    }
    assert.equal(sentToPerson + rake + bankBack, pot, 'L2: in == out');
    assert.equal(inflight(w.file), 0, 'nothing left in flight');
    // the result card agrees with the money (server/duelMoney.js): a bot's win is not a refund
    const card = duelMoney({ winnerId: winner, pot: 2 * stake, seats: room.moneySeats() });
    assert.equal(card.refunded, who === 'none');
    // exactly once: a second settle of the same room pays nothing more
    room.payResult(winner, 'again');
    assert.equal(w.out.sends.reduce((a, x) => a + x.micro, 0), sentToPerson);
    assert.equal(w.bal() - M(20 - stake), bankBack);
    assert.equal(w.humanTables.length, 0, 'never through the person-only path');
  });
}

test('L3: a person who walks out of a bot table loses it, exactly as they would to a person', () => {
  const w = world();
  w.bots.setEnabled(true);
  w.bots.spawn('knockout', 0.5);
  w.tick(200);
  personQueues(w, w.ko, 'p', 0.5, true);
  w.ko.leave('p');
  w.tick(200);
  assert.equal(w.out.sends.length, 0, 'no payout to the leaver');
  assert.equal(w.bal(), M(20 - 0.5) + M(1) - M(0.1), 'the bank won the pot less the cut');
});

test('L5: a restart refunds the person through an agowed row and gives the bot stake back, once', () => {
  const w = world();
  w.bots.setEnabled(true);
  w.bots.spawn('knockout', 1);           // this one waits
  w.bots.spawn('knockout', 0.5);         // this one plays
  w.tick(200);
  personQueues(w, w.ko, 'p', 0.5, true);
  assert.ok(w.ko.roomOf('p'));
  const rows = w.ko.shutdownSettle('shutdown');
  assert.equal(rows.length, 1, 'one owed row, the person\'s');
  assert.equal(rows[0].wallet, 'Wp');
  assert.equal(rows[0].micro, M(0.5));
  assert.match(rows[0].key, /^agowed:[0-9a-f-]{36}$/);
  assert.match(rows[0].reason, /^refund knockout shutdown mid-match agowed:/);
  assert.equal(w.bal(), M(20), 'both bot stakes home');
  assert.equal(inflight(w.file), 0);
  assert.equal(w.ko.shutdownSettle('shutdown').length, 0, 'a second call owes nothing');
  assert.equal(w.bal(), M(20), 'and gives nothing back twice');
});

test('L6: a hard kill leaves the stake in flight in the file, and the next load gives it back once', () => {
  const w = world();
  w.bots.setEnabled(true);
  w.bots.spawn('knockout', 1);
  assert.equal(inflight(w.file), M(1));
  // the process dies here: nothing settles. A new bank reads the file.
  const again = createBotBank({ file: w.file, now: () => w.now, log: quiet });
  assert.equal(again.balanceMicro(), M(20), 'the stake is back');
  assert.equal(inflight(w.file), 0);
  const third = createBotBank({ file: w.file, now: () => w.now, log: quiet });
  assert.equal(third.balanceMicro(), M(20), 'and only once');
});

test('L7: Off sends every waiting bot home; a bot already at a table finishes its match', () => {
  const w = world();
  w.bots.setEnabled(true);
  w.bots.spawn('knockout', 1);
  const { id } = w.bots.spawn('knockout', 0.5);
  w.tick(200);
  personQueues(w, w.ko, 'p', 0.5, true);
  w.bots.setEnabled(false);
  assert.equal(w.bal(), M(20 - 0.5), 'the waiting $1 bot went home, the playing one did not');
  assert.equal(w.bots.spawn('knockout', 1).ok, false);
  w.ko.roomOf('p').finish(id, 'test');
  assert.equal(w.bal(), M(20 - 0.5) + M(1) - M(0.1));
});

test('Control lowers a rung: the newest waiting bot leaves first and its stake goes back', () => {
  const w = world();
  w.bots.setEnabled(true);
  assert.equal(w.bots.setCount('knockout', 0.5, 2).waiting, 2);
  assert.equal(w.bal(), M(19));
  assert.equal(w.bots.setCount('knockout', 0.5, 0).waiting, 0);
  assert.equal(w.bal(), M(20));
  assert.equal(w.bots.setCount('knockout', 1, 9).waiting, 3, 'at most three waiting at one rung');
});

test('a closed paid door, an off-ladder rung or an empty bank refuse a spawn and take nothing', () => {
  const shut = world({ door: false });
  shut.bots.setEnabled(true);
  assert.equal(shut.bots.spawn('knockout', 0.5).ok, false);
  assert.equal(shut.bal(), M(20));
  const w = world();
  w.bots.setEnabled(true);
  assert.equal(w.bots.spawn('knockout', 0.1).ok, false);
  assert.equal(w.bots.spawn('battleship', 0.5).ok, false, 'Battleship takes no paid bots');
  for (let i = 0; i < 3; i++) w.bots.spawn('knockout', 1);
  for (let i = 0; i < 3; i++) w.bots.spawn('swim', 1);
  assert.equal(w.bal(), M(14));
});

test('Swim: the same rules on its own lobby (pairing, a bot win, a restart)', () => {
  const w = world();
  w.bots.setEnabled(true);
  const { id } = w.bots.spawn('swim', 1);
  const blind = sock('blind');
  w.sw.enqueue(blind, 'Pb', 'Wb', 1, 1, w.now, 1, null, null, {});
  assert.equal(w.sw.roomOf('blind'), null, 'not shown, not paired');
  w.sw.leave('blind');
  personQueues(w, w.sw, 'p', 1, true);
  const room = w.sw.roomOf('p');
  assert.ok(room && room.bot && room.bot.paidBot, 'shown, paired');
  assert.equal(room.publicState ? room.publicState(w.now).vsBot !== false : true, true);
  room.finish(id, 'test');
  assert.equal(w.bal(), M(19) + M(2) - M(0.2), 'the bot won the pot less the cut');
  // a restart with another bot waiting gives it back
  w.bots.spawn('swim', 0.5);
  assert.equal(w.sw.shutdownSettle('crash').length, 0);
  assert.equal(w.bal(), M(19) + M(1.8));
});

test('Spent today: the Bot bank moves are written per game for the Toronto day', () => {
  const w = world();
  w.bots.setEnabled(true);
  const { id } = w.bots.spawn('knockout', 1);
  w.tick(200);
  personQueues(w, w.ko, 'p', 1, true);
  w.ko.roomOf('p').finish(id, 'test');
  w.bots.spawn('knockout', 0.5);
  w.tick(BOT_WAIT_MS + 400);
  const v = w.spend.view('today');
  const ko = v.games.find(g => g.game === 'knockout');
  assert.equal(ko.staked, 1.5);
  assert.equal(ko.back, 1.8 + 0.5);
  assert.equal(Math.round(ko.net * 1e6), M(1.5 - 2.3));
  assert.equal(ko.wins, 1);
});

/* ─── The ledger cases the dispatcher listed (2026-11-04, finished on Owen's PC) ──────────────────────────────────── */

test('ledger: the kill switch OFF means no bot, even for a page that says botOk; the person waits for people', () => {
  const w = world();
  assert.equal(w.bots.enabled(), false, 'off at boot');
  personQueues(w, w.ko, 'p', 0.5, true);           // a patched page claims it was shown a bot
  w.tick(5000);
  assert.equal(w.ko.roomOf('p'), null, 'no table: there is no bot and nobody else');
  assert.equal(w.bots.held().length, 0, 'no seat was ever made');
  assert.equal(w.bal(), M(20), 'the bank never moved');
  assert.equal(inflight(w.file), 0);
  assert.deepEqual(w.ko.botsWaitingByRung(), {});
});

test('ledger: the bot loses: the person gets the pot less 10%, the bank gets nothing back, sums hold', () => {
  const w = world();
  w.bots.setEnabled(true);
  const { id } = w.bots.spawn('knockout', 0.5);
  w.tick(200);
  personQueues(w, w.ko, 'p', 0.5, true);
  const room = w.ko.roomOf('p');
  assert.ok(room && room.players.has(id));
  room.finish('p', 'test');
  assert.deepEqual(w.out.sends.map(x => [x.wallet, x.micro]), [['Wp', M(0.9)]]);
  assert.equal(w.out.rake.reduce((a, x) => a + x, 0), M(0.1));
  assert.equal(w.bal(), M(19.5));
  assert.equal(M(20) + M(0.5), w.bal() + M(0.9) + M(0.1), 'in == out');
  assert.equal(inflight(w.file), 0);
});

test('ledger: the bot wins: it keeps the stake and the pot less 10% comes home', () => {
  const w = world();
  w.bots.setEnabled(true);
  const { id } = w.bots.spawn('knockout', 1);
  w.tick(200);
  personQueues(w, w.ko, 'p', 1, true);
  w.ko.roomOf('p').finish(id, 'test');
  assert.equal(w.out.sends.length, 0, 'nothing to the person');
  assert.equal(w.bal(), M(19) + M(1.8));
  assert.equal(M(20) + M(1), w.bal() + M(0.2), 'in == out');
  assert.equal(inflight(w.file), 0);
  const recent = w.bots.view().recent;
  assert.equal(recent[recent.length - 1].result, 'won');
});

test('ledger: nobody joins: after 60 s the stake goes back to the Bot bank, and only once', () => {
  const w = world();
  w.bots.setEnabled(true);
  w.bots.spawn('knockout', 0.5);
  w.bots.spawn('knockout', 1);
  assert.equal(w.bal(), M(18.5));
  w.tick(BOT_WAIT_MS + 400);
  assert.equal(w.bal(), M(20));
  assert.equal(inflight(w.file), 0);
  w.tick(BOT_WAIT_MS * 2);
  assert.equal(w.bal(), M(20), 'no second return');
  assert.deepEqual(w.bots.view().recent.map(r => r.result), ['back', 'back']);
});

test('ledger: two people shown one bot at once: one table, one bot seat, the other waits for people', () => {
  const w = world();
  w.bots.setEnabled(true);
  const { id } = w.bots.spawn('knockout', 0.5);
  w.tick(200);
  personQueues(w, w.ko, 'a', 0.5, true);
  personQueues(w, w.ko, 'b', 0.5, true);
  const ra = w.ko.roomOf('a'), rb = w.ko.roomOf('b');
  assert.ok(ra && ra.players.has(id), 'the first one met the bot');
  assert.equal(rb, null, 'the second waits (it may not take a seat the bot already has)');
  ra.finish(id, 'test');
  assert.equal(w.bal(), M(19.5) + M(0.9), 'the bank paid in once and got the prize once');
  w.ko.leave('b');
  assert.deepEqual(w.out.refunds.map(r => [r.wallet, M(r.amount)]), [['Wb', M(0.5)]], 'b got their own stake back, once');
});

test('ledger: double-join and disconnects never double-pay or lose a stake', () => {
  const w = world();
  w.bots.setEnabled(true);
  const { id } = w.bots.spawn('knockout', 0.5);
  w.tick(200);
  // p queues at $1 (no bot there), then presses again at $0.50 where the bot waits: the $1 seat is refunded once
  const s = sock('p');
  w.ko.enqueue(s, 'Pp', 'Wp', 1, 1, w.now, 1, null, { botOk: true });
  assert.equal(w.ko.roomOf('p'), null);
  w.ko.enqueue(s, 'Pp', 'Wp', 0.5, 0.5, w.now, 0.5, null, { botOk: true });
  const room = w.ko.roomOf('p');
  assert.ok(room && room.players.has(id), 'met the bot on the second press');
  assert.deepEqual(w.out.refunds.map(r => [r.wallet, M(r.amount)]), [['Wp', M(1)]], 'the $1 seat back, once');
  // a third press from a socket at a live table is refused (the handler refunds it through the stake row)
  assert.equal(w.ko.enqueue(s, 'Pp', 'Wp', 0.5, 0.5, w.now, 0.5, null, { botOk: true }), false);
  assert.equal(w.out.refunds.length, 1, 'the lobby touched nothing');
  // the person drops twice: one walk-out, the bot wins once
  w.ko.leave('p');
  w.ko.leave('p');
  w.tick(400);
  assert.equal(w.out.sends.length, 0);
  assert.equal(w.bal(), M(19.5) + M(0.9));
  // and the room cannot be settled again by a late finish
  room.finish('p', 'late');
  room.payResult('p', 'late');
  assert.equal(w.out.sends.length, 0, 'never paid after the walk-out');
  assert.equal(w.bal(), M(19.5) + M(0.9));
  assert.equal(inflight(w.file), 0);
  // a removeBot or a back for a seat that already settled does nothing
  assert.equal(w.ko.removeBot(id, 'late'), false);
  w.bots.setEnabled(false);
  assert.equal(w.bal(), M(19.5) + M(0.9));
});

/* A long scripted mixed run on one seeded sequence (not a fuzz test: one fixed seed, a few hundred steps, well
   under a second). After EVERY step: what came in (the bank's $20 and every person's stake) equals what is held
   (the bank's balance, the bots' stakes in flight, every person's stake still waiting or at an unsettled table)
   plus what went out (payouts, refunds, the house cut). And the bank's in-flight count is exactly the bots' stakes
   still waiting or at an unsettled table. */
test('ledger: balances always sum, step by step, over a mixed run of spawns, joins, leaves, results and the switch', () => {
  const w = world();
  let seed = 20261104;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  // person-only tables: paid by the same 90/10 split the lobby's own onSettled uses
  w.ko.onSettled = (o) => {
    if (w.bots.settleTable(o, {
      game: 'knockout', tag: '[T]', houseCut: DUEL_HOUSE_CUT, region: 'na',
      koSend: (wallet, amount) => w.out.sends.push({ wallet, micro: M(amount) }),
      sweepRake: (cut) => w.out.rake.push(M(cut)), trackEarning() {},
    })) return;
    const winner = o.seats.find(x => x.id === o.winnerId);
    if (winner && winner.wallet) {
      w.out.rake.push(M(o.pot * DUEL_HOUSE_CUT));
      w.out.sends.push({ wallet: winner.wallet, micro: M(o.pot) - M(o.pot * DUEL_HOUSE_CUT) });
    } else for (const x of o.seats) if (x.wallet && x.worth > 0) w.out.sends.push({ wallet: x.wallet, micro: M(x.refund) });
  };
  let stakesIn = 0, callerRefunds = 0, botTables = 0;
  const people = ['a', 'b', 'c', 'd', 'e'];
  const sockets = Object.fromEntries(people.map(id => [id, sock(id)]));
  const isBot = (id) => String(id).startsWith('bot_');
  function check(step) {
    let heldPeople = 0, heldBots = 0;
    for (const e of w.ko.queue) {
      if (e.refunded) continue;
      if (e.paidBot) heldBots += M(e.worth); else heldPeople += M(e.worth);
    }
    for (const r of w.ko.rooms.values()) {
      if (!(r.stake > 0) || r.settled) continue;
      for (const [sid, v] of r.worth) { if (isBot(sid)) heldBots += M(v); else heldPeople += M(v); }
    }
    const out = w.out.sends.reduce((a, x) => a + x.micro, 0) + w.out.rake.reduce((a, x) => a + x, 0)
      + w.out.refunds.reduce((a, r) => a + M(r.amount), 0) + callerRefunds;
    assert.equal(inflight(w.file), heldBots, 'step ' + step + ': in flight == bots held');
    assert.equal(M(20) + stakesIn, w.bal() + heldBots + heldPeople + out, 'step ' + step + ': in == held + out');
  }
  w.bots.setEnabled(true);
  for (let step = 0; step < 400; step++) {
    const r = rnd();
    if (r < 0.18) w.bots.spawn('knockout', pick([0.5, 1]));
    else if (r < 0.45) {
      const id = pick(people), stake = pick([0.5, 1]);
      stakesIn += M(stake);
      const took = w.ko.enqueue(sockets[id], 'P' + id, 'W' + id, stake, stake, w.now, stake, null, { botOk: rnd() < 0.7 });
      if (!took) callerRefunds += M(stake);      // index.js refunds a refused seat through its stake row
      const room = w.ko.roomOf(id);
      if (took && room && room.bot && room.bot.paidBot) botTables++;
    } else if (r < 0.55) w.ko.leave(pick(people));
    else if (r < 0.70) {
      const rooms = [...w.ko.rooms.values()].filter(x => x.state !== 'over');
      if (rooms.length) {
        const room = pick(rooms);
        const ids = [...room.players.keys()];
        const who = rnd() < 0.15 ? null : pick(ids);
        room.finish(who, who ? 'test' : 'draw');
      }
    } else if (r < 0.73) w.bots.setEnabled(!w.bots.enabled());
    else if (r < 0.76) w.bots.setCount('knockout', pick([0.5, 1]), Math.floor(rnd() * 4));
    else w.tick(Math.floor(rnd() * 20000));
    check(step);
  }
  // wind down: every table ends, every queue empties, then a restart owes only people
  for (const room of [...w.ko.rooms.values()]) if (room.state !== 'over') room.finish(null, 'draw');
  w.tick(BOT_WAIT_MS + 1000);
  const rows = w.ko.shutdownSettle('shutdown');
  callerRefunds += rows.reduce((a, x) => a + x.micro, 0);
  check('end');
  assert.equal(inflight(w.file), 0, 'no bot stake left in flight');
  assert.ok(botTables > 0, 'the run did put people at bot tables');
});

/* Fable review 2026-11-05, finding 1: a throw after the table started (matchStarted here) left the person seated and
   used to give the bot's stake back to the bank (the bot is never in bySocket), so the table then paid as a
   person-only one. The catch now finds the bot's table by its players, so the table plays on and settles once. */
for (const lobbyName of ['ko', 'sw']) {
  test('ledger: ' + lobbyName + ': a match that throws after it started keeps the bot seated and settles once', () => {
    const w = world();
    const lob = w[lobbyName];
    const game = lobbyName === 'ko' ? 'knockout' : 'swim';
    w.bots.setEnabled(true);
    const { id } = w.bots.spawn(game, 0.5);
    const real = lob.matchStarted;
    let threw = false;
    lob.matchStarted = function () { threw = true; throw new Error('test: after start'); };
    personQueues(w, lob, 'p', 0.5, true);
    lob.matchStarted = real;
    assert.ok(threw, 'the throw happened');
    const room = lob.roomOf('p');
    assert.ok(room && room.players.has(id), 'the table plays on with the bot at it');
    assert.equal(w.bal(), M(19.5), 'the bot stake was NOT handed back while it is at the table');
    assert.equal(inflight(w.file), M(0.5));
    room.finish(id, 'test');
    assert.equal(w.humanTables.length, 0, 'settled by duelBots, not as a person-only table');
    assert.equal(w.bal(), M(19.5) + M(0.9), 'the bot won the pot less the cut, once');
    assert.equal(inflight(w.file), 0);
  });
  test('ledger: ' + lobbyName + ': a match that throws before it started refunds both, once', () => {
    const w = world();
    const lob = w[lobbyName];
    const game = lobbyName === 'ko' ? 'knockout' : 'swim';
    w.bots.setEnabled(true);
    w.bots.spawn(game, 0.5);
    const RealRoom = lob.Room;
    if (lobbyName === 'ko') lob.Room = class extends RealRoom { start() { throw new Error('test: start'); } };
    else { const real = lob.makeMatch; lob.makeMatch = function () { throw new Error('test: make'); }; lob._real = real; }
    personQueues(w, lob, 'p', 0.5, true);
    if (lobbyName === 'ko') lob.Room = RealRoom; else lob.makeMatch = lob._real;
    assert.equal(lob.roomOf('p'), null);
    assert.deepEqual(w.out.refunds.map(r => [r.wallet, M(r.amount)]), [['Wp', M(0.5)]], 'the person refunded once');
    assert.equal(w.bal(), M(20), 'the bot stake home once');
    assert.equal(inflight(w.file), 0);
  });
}

// Fable review 2026-11-05, finding 2: a waiting bot no longer takes the person another person could have met.
test('pairing: people meet people first; the bot takes only a person left over', () => {
  const w = world();
  w.bots.setEnabled(true);
  const { id } = w.bots.spawn('knockout', 0.5);
  w.tick(200);
  // A queues while the bot waits but was not shown it (no botOk), so A waits for people
  personQueues(w, w.ko, 'a', 0.5, false);
  assert.equal(w.ko.roomOf('a'), null);
  // B was shown the bot: B and A are both people, so they meet each other, and the bot keeps waiting
  personQueues(w, w.ko, 'b', 0.5, true);
  const room = w.ko.roomOf('a');
  assert.ok(room && room === w.ko.roomOf('b'), 'the two people met');
  assert.ok(!room.players.has(id), 'not the bot');
  assert.deepEqual(w.ko.botsWaitingByRung(), { 0.5: 1 }, 'the bot still waits');
  // a third person who was shown it then meets the bot
  personQueues(w, w.ko, 'c', 0.5, true);
  assert.ok(w.ko.roomOf('c') && w.ko.roomOf('c').players.has(id));
});

// Finding 3: a failed save of a settled seat keeps the move for the next save; the next boot never pays it twice.
test('bank: a seat settled while the disk refuses a save is written by the next save, not given back at boot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duelbots-'));
  const file = path.join(dir, 'bot-bank.json');
  fs.writeFileSync(file, JSON.stringify({ balance: M(20), capMicro: M(200), day: '', spent: 0, inflight: 0, topups: [], log: [] }));
  let refuse = false;
  const fsx = Object.assign({}, fs, { writeFileSync: (...a) => { if (refuse) throw new Error('disk full'); return fs.writeFileSync(...a); } });
  const bank = createBotBank({ file, fsx, log: quiet });
  assert.equal(bank.take(M(1), 'duel:knockout:1'), true);
  refuse = true;
  assert.equal(bank.settleSeat(M(1), 0, 'ko_1', 'duel:knockout:1'), true, 'applied, though not saved');   // the bot lost
  assert.equal(bank.balanceMicro(), M(19));
  refuse = false;
  assert.equal(bank.take(M(0.5), 'duel:knockout:0.5'), true);    // any later save writes the lost seat too
  assert.equal(bank.settleSeat(M(0.5), M(0.5), 'nobody joined', 'duel:knockout:0.5'), true);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.inflight, 0, 'no stale stake in flight');
  assert.equal(onDisk.balance, M(19));
  const again = createBotBank({ file, log: quiet });
  assert.equal(again.balanceMicro(), M(19), 'the next boot does not pay the lost stake back to the bank');
});

// Finding 5: the daily cap rolls on the Toronto day, the day Spent today shows.
test('bank: the daily cap day is the Toronto day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duelbots-'));
  const file = path.join(dir, 'bot-bank.json');
  // 9 pm Toronto on Nov 4 is already Nov 5 in UTC
  let clock = Date.parse('2026-11-05T02:00:00Z');
  fs.writeFileSync(file, JSON.stringify({ balance: M(20), capMicro: M(2), day: '2026-11-04', spent: M(1.5), inflight: 0, topups: [], log: [] }));
  const bank = createBotBank({ file, now: () => clock, log: quiet });
  assert.equal(bank.take(M(1), 'duel:knockout:1'), false, 'still Nov 4 in Toronto: $1.50 of the $2 cap is used');
  assert.equal(bank.take(M(0.5), 'duel:knockout:0.5'), true);
  clock = Date.parse('2026-11-05T05:30:00Z');   // 12:30 am Toronto, Nov 5
  assert.equal(bank.take(M(1), 'duel:knockout:1'), true, 'a new Toronto day, a new cap');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).day, '2026-11-05');
  // a file from before this change, stamped with today's UTC date, keeps today's spent (no free reset)
  fs.writeFileSync(file, JSON.stringify({ balance: M(20), capMicro: M(2), day: '2026-11-05', spent: M(2), inflight: 0, topups: [], log: [] }));
  clock = Date.parse('2026-11-05T03:00:00Z');   // 10 pm Toronto Nov 4, UTC Nov 5
  const old = createBotBank({ file, now: () => clock, log: quiet });
  assert.equal(old.take(M(0.5), 'duel:knockout:0.5'), false, 'the cap used today stays used');
});
