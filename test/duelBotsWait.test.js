'use strict';
/* The owner's PAID duel bots, the two-hour wait (server/duelBots.js, Owen 2026-11-08): ledger tests.

   Live, the + never placed a bot: the Bot bank keeps its money in its own wallet and only a float in escrow (gone home
   after two idle minutes), so a stake almost always needs a transfer into escrow first, and the spawn was refused
   ("moving money in, try again") with nothing trying again. These run the real queue (KnockoutLobby, HeadSoccerLobby,
   SwimLobby), the real Bot bank on a temp file with a fake chain (transfers land when the test says so), the real
   settle and the saved file, on a synthetic clock. The invariants, on top of test/duelBots.test.js's L1 to L8:

     W1  A + while the float is empty makes a STARTING bot: nothing is taken until the bank's transfer lands, then
         the stake is taken once and the bot waits; a transfer that never lands drops it with nothing taken.
     W2  A bot waits two hours: still there a moment before, gone after, its stake back to the bank once.
     W3  Control's minus gives the stake back once; a starting bot goes with nothing to give back.
     W4  A restart gives every waiting stake back once, keeps the bots in the file, and the next boot brings each
         back with what was left of its wait, taking a fresh stake (once); a hard kill does the same through the
         bank's in-flight count. Every stake taken ends exactly once.
     W5  The switch is saved; Off empties the file.
     W6  Solvency: the bank's escrow money (float) plus the stakes the bots hold is what the bank had in escrow,
         at every step; the daily limit counts waiting bots. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KnockoutLobby } = require('../server/KnockoutLobby');
const { HeadSoccerLobby } = require('../server/HeadSoccerLobby');
const { SwimLobby } = require('../server/swim/SwimLobby');
const { createBotBank } = require('../server/botBank');
const { createDuelBots, BOT_WAIT_MS, START_GIVE_UP_MS, RESTORE_MIN_LEFT_MS } = require('../server/duelBots');
const { DUEL_HOUSE_CUT } = require('../server/duelMoney');

const io = { to: () => ({ emit() {} }) };
const quiet = { log() {}, warn() {}, error() {} };
const M = (usd) => Math.round(usd * 1e6);
const HOUR = 3600e3;
const flush = () => new Promise((r) => setImmediate(r));
function sock(id) {
  return { id, sent: [], rooms: new Set(), join(r) { this.rooms.add(r); }, leave(r) { this.rooms.delete(r); },
    emit(e, p) { this.sent.push({ e, p }); } };
}

// A fake chain: the Bot bank's wallet and escrow, transfers that land when the test says so (test/botBankWallet.test.js).
function fakeChain(walletMicro) {
  const c = { wallet: walletMicro, escrow: 0, fate: new Map(), n: 0, address: 'BotBankAddr' };
  c.usdcMicro = () => c.wallet;
  c.solLamports = () => 5e6;
  c.build = async (dir, micro) => {
    const sig = 'sig' + (++c.n);
    c.fate.set(sig, { dir, micro, s: 'pending' });
    return { sig, raw: 'raw-' + sig, lvbh: 100 };
  };
  c.broadcast = async () => {};
  c.status = async (sig) => c.fate.get(sig).s;
  c.pending = () => [...c.fate.entries()].filter(([, f]) => f.s === 'pending').map(([sig, f]) => Object.assign({ sig }, f));
  c.land = (sig) => {
    const f = c.fate.get(sig);
    f.s = 'landed';
    if (f.dir === 'in') { c.wallet -= f.micro; c.escrow += f.micro; } else { c.escrow -= f.micro; c.wallet += f.micro; }
  };
  return c;
}

/* One server: the bank (float `float`, optional chain), three duel lobbies, the manager with its saved file, the
   payout side recorded. boot() makes the same server again from the same files (a restart). */
function server(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'duelwait-'));
  const bankFile = path.join(dir, 'bot-bank.json');
  const botsFile = path.join(dir, 'duel-bots.json');
  if (!opts.dir) {
    fs.writeFileSync(bankFile, JSON.stringify({ balance: M(opts.float == null ? 20 : opts.float),
      capMicro: M(opts.cap || 200), day: '', spent: 0, inflight: 0, topups: [], log: [] }));
  }
  const clock = opts.clock || { t: 1.8e12 };
  const now = () => clock.t;
  const chain = opts.chain || null;
  const bank = createBotBank({ file: bankFile, now, log: quiet, chain, tickMs: 0 });
  const ko = new KnockoutLobby(io);
  const hs = new HeadSoccerLobby(io);
  const sw = new SwimLobby(io);
  const out = { sends: [], rake: [], refunds: [] };
  const door = { open: true };
  const bots = createDuelBots({ bank, lobbies: { knockout: ko, headsoccer: hs, swim: sw }, now, log: quiet,
    doorOpen: () => door.open, file: botsFile, tickMs: 0, waitMs: opts.waitMs });
  bank.onReady(() => bots.tick());
  for (const [game, lob] of [['knockout', ko], ['headsoccer', hs], ['swim', sw]]) {
    lob.onSettled = (o) => {
      bots.settleTable(o, { game, tag: '[T]', houseCut: DUEL_HOUSE_CUT, region: 'na',
        koSend: (wallet, amount) => out.sends.push({ wallet, micro: M(amount) }),
        sweepRake: (cut) => out.rake.push(M(cut)), trackEarning() {} });
    };
    lob.onRefund = (r) => out.refunds.push(r);
  }
  const lobbies = [ko, hs, sw];
  return {
    dir, bankFile, botsFile, bank, ko, hs, sw, bots, out, door, clock, chain,
    float: () => bank.balanceMicro(),
    file: () => JSON.parse(fs.readFileSync(bankFile, 'utf8')),
    saved: () => JSON.parse(fs.readFileSync(botsFile, 'utf8')),
    // the lobbies' clock, in 30 s steps (a bot's wait is only checked against its end time)
    run(ms) {
      const end = clock.t + ms;
      while (clock.t < end) { clock.t = Math.min(end, clock.t + 30000); for (const l of lobbies) l.tick(clock.t); }
    },
    boot(extra = {}) { return server(Object.assign({ dir, clock, chain, waitMs: opts.waitMs }, extra)); },
    shutdown() { return lobbies.flatMap((l) => l.shutdownSettle('shutdown')); },
  };
}
function personQueues(lob, id, stake, botOk, now) {
  const s = sock(id);
  if (lob instanceof SwimLobby) lob.enqueue(s, 'P' + id, 'W' + id, stake, stake, now, stake, null, null, { botOk });
  else lob.enqueue(s, 'P' + id, 'W' + id, stake, stake, now, stake, null, { botOk });
  return s;
}
const held = (s) => s.bots.heldMicro();

test('W1: a + while the Bot bank float is $0 starts the bot once its money lands; a person shown it is matched with it', async () => {
  const chain = fakeChain(M(13.18));
  const s = server({ float: 0, chain });
  s.bots.setEnabled(true);
  const r = s.bots.setCount('headsoccer', 0.5, 1);
  assert.equal(r.ok, true, 'not refused any more');
  assert.equal(r.waiting, 1, 'Control counts it');
  assert.equal(r.starting, 1, 'starting: the stake is on its way');
  assert.equal(s.float(), 0);
  assert.equal(s.file().inflight, 0, 'nothing taken yet');
  assert.deepEqual(s.hs.botsWaitingByRung(), {}, 'not in the queue, so nobody is shown it');
  await flush();
  const fund = chain.pending();
  assert.equal(fund.length, 1, 'one transfer into escrow');
  assert.equal(fund[0].dir, 'in');
  chain.land(fund[0].sig);
  await s.bank.tick();                      // the bank sees it land: onReady starts the bot
  assert.equal(s.bots.view().rungs.headsoccer['0.5'].waiting, 1, 'waiting now');
  assert.equal(s.file().inflight, M(0.5), 'its stake taken once, saved');
  assert.equal(s.float() + held(s), fund[0].micro, 'escrow holds the fund: float plus the bot stake');
  assert.deepEqual(s.hs.botsWaitingByRung(), { 0.5: 1 }, 'the lobby shows it now');
  const v = s.bots.view().rungs.headsoccer['0.5'].bots[0];
  assert.equal(v.stake, 0.5);
  assert.equal(v.leftS, BOT_WAIT_MS / 1000, 'two hours on its clock');
  // a person who saw "Bot opponent waiting" presses Play: matched with it at once
  s.run(5 * 60e3);
  personQueues(s.hs, 'p', 0.5, true, s.clock.t);
  const room = s.hs.roomOf('p');
  assert.ok(room, 'at a table');
  assert.ok(room.bot && room.bot.paidBot, 'against the paid bot');
  assert.equal(s.bots.view().rungs.headsoccer['0.5'].playing, 1);
  assert.equal(s.file().inflight, M(0.5), 'still one stake, now on the table');
});

test('W1: a transfer that never lands drops the starting bot after a few minutes, nothing taken', async () => {
  const chain = fakeChain(M(13.18));
  const s = server({ float: 0, chain });
  s.bots.setEnabled(true);
  assert.equal(s.bots.spawn('knockout', 1).starting, true);
  await flush();
  s.clock.t += START_GIVE_UP_MS - 1000;
  s.bots.tick();
  assert.equal(s.bots.view().rungs.knockout['1'].starting, 1, 'still starting inside its few minutes');
  s.clock.t += 2000;
  s.bots.tick();
  assert.equal(s.bots.view().rungs.knockout['1'].starting, 0, 'dropped');
  assert.equal(s.file().inflight, 0);
  assert.equal(s.file().spent, 0, 'nothing counted against the daily limit');
  assert.equal(s.bots.view().recent.slice(-1)[0].result, 'not started');
});

test('W2: nobody plays it: it waits the full two hours, then its stake goes back to the Bot bank, once', () => {
  const s = server();
  s.bots.setEnabled(true);
  assert.equal(s.bots.spawn('headsoccer', 0.5).ok, true);
  assert.equal(s.float(), M(19.5));
  assert.equal(s.file().spent, M(0.5), 'counted against the daily limit while it waits');
  s.run(BOT_WAIT_MS - 60e3);
  assert.equal(s.float(), M(19.5), 'still waiting a minute before the end');
  assert.deepEqual(s.hs.botsWaitingByRung(), { 0.5: 1 });
  s.run(90e3);
  assert.equal(s.float(), M(20), 'back in full');
  assert.equal(s.file().inflight, 0);
  assert.equal(s.file().spent, 0, 'the daily limit gets it back');
  assert.deepEqual(s.hs.botsWaitingByRung(), {});
  assert.equal(held(s), 0);
  assert.equal(s.out.refunds.length, 0, 'no person refund for a bot');
  assert.deepEqual(s.saved().bots, [], 'gone from the saved file');
  s.run(HOUR);
  assert.equal(s.float(), M(20), 'never twice');
  const last = s.bots.view().recent.slice(-1)[0];
  assert.equal(last.result, 'back');
  assert.equal(last.why, 'nobody joined');
});

test('W2: a shortened wait (local checks) ends the same way', () => {
  const s = server({ waitMs: 120000 });
  s.bots.setEnabled(true);
  s.bots.spawn('swim', 1);
  s.run(90e3);
  assert.equal(s.float(), M(19));
  s.run(60e3);
  assert.equal(s.float(), M(20));
});

test('W3: Control minus gives the stake back once; a starting bot goes with nothing taken', async () => {
  const s = server();
  s.bots.setEnabled(true);
  s.bots.setCount('knockout', 0.5, 2);
  assert.equal(s.float(), M(19));
  s.run(30 * 60e3);
  assert.equal(s.bots.setCount('knockout', 0.5, 1).waiting, 1);
  assert.equal(s.float(), M(19.5), 'one stake home');
  assert.equal(s.bots.setCount('knockout', 0.5, 0).waiting, 0);
  assert.equal(s.float(), M(20), 'both home');
  assert.equal(s.file().inflight, 0);
  s.bots.setCount('knockout', 0.5, 0);
  assert.equal(s.float(), M(20), 'never twice');
  // a starting one (its money still on the way) goes with nothing to give back
  const chain = fakeChain(M(5));
  const t = server({ float: 0, chain });
  t.bots.setEnabled(true);
  t.bots.setCount('knockout', 1, 1);
  assert.equal(t.bots.view().rungs.knockout['1'].starting, 1);
  t.bots.setCount('knockout', 1, 0);
  assert.equal(t.bots.view().rungs.knockout['1'].starting, 0);
  await flush();
  const fund = chain.pending()[0];
  chain.land(fund.sig);
  await t.bank.tick();
  assert.equal(t.file().inflight, 0, 'the landed money is float, no bot took it');
  assert.equal(t.float(), fund.micro);
});

test('W4: a restart gives the stakes back, and the next boot brings the bots back with the rest of their wait', () => {
  const s = server();
  s.bots.setEnabled(true);
  s.bots.spawn('headsoccer', 0.5);
  s.bots.spawn('knockout', 1);
  s.run(30 * 60e3);
  const untils = s.bots.held().map((x) => x.until).sort();
  const rows = s.shutdown();
  assert.equal(rows.length, 0, 'no owed row for a bot');
  assert.equal(s.float(), M(20), 'both stakes home at the shutdown');
  assert.equal(s.file().inflight, 0);
  assert.equal(s.saved().bots.length, 2, 'the file still has them');
  assert.equal(s.saved().enabled, true);
  // the deploy: two minutes down, then the same server again
  s.clock.t += 2 * 60e3;
  const b = s.boot();
  assert.equal(b.bots.enabled(), true, 'the switch came back on');
  assert.equal(b.bots.view().rungs.headsoccer['0.5'].starting, 1, 'starting again');
  b.bots.tick();
  assert.equal(b.float(), M(18.5), 'a fresh stake each, taken once');
  assert.equal(b.file().inflight, M(1.5));
  assert.deepEqual(b.bots.held().map((x) => x.until).sort(), untils, 'the same end of wait as before');
  const left = b.bots.view().rungs.knockout['1'].bots[0].leftS;
  assert.equal(left, (BOT_WAIT_MS - 32 * 60e3) / 1000, 'two hours less the 32 minutes gone');
  // the rest of the wait runs out: both home once
  b.run(BOT_WAIT_MS - 32 * 60e3 + 60e3);
  assert.equal(b.float(), M(20));
  assert.equal(b.file().inflight, 0);
  assert.deepEqual(b.saved().bots, []);
  // a third boot brings nothing back
  const c = b.boot();
  c.bots.tick();
  assert.equal(c.float(), M(20));
  assert.equal(c.bots.heldMicro(), 0);
});

test('W4: a hard kill: the bank gives the in-flight stake back at boot, the bot comes back and takes it once', () => {
  const s = server();
  s.bots.setEnabled(true);
  s.bots.spawn('swim', 1);
  assert.equal(s.file().inflight, M(1));
  s.clock.t += 60e3;
  const b = s.boot();                       // no shutdown: the process just died
  assert.equal(b.file().inflight, 0, 'the bank gave the stake back to itself');
  assert.equal(b.float(), M(20));
  b.bots.tick();
  assert.equal(b.float(), M(19), 'the bot took a fresh stake');
  assert.equal(b.file().inflight, M(1));
  const again = b.boot();                   // and a second hard kill straight after
  again.bots.tick();
  assert.equal(again.float() + again.bots.heldMicro(), M(20), 'never more than one stake out per bot');
});

test('W4: a bot whose wait ran out while the server was down is not brought back', () => {
  const s = server();
  s.bots.setEnabled(true);
  s.bots.spawn('knockout', 0.5);
  s.run(BOT_WAIT_MS - 2 * 60e3);
  s.shutdown();
  s.clock.t += RESTORE_MIN_LEFT_MS + 60e3;
  const b = s.boot();
  b.bots.tick();
  assert.equal(b.bots.heldMicro(), 0);
  assert.equal(b.float(), M(20));
});

test('W4: a bot brought back while the paid door is closed waits for it, then starts', () => {
  const s = server();
  s.bots.setEnabled(true);
  s.bots.spawn('knockout', 1);
  s.shutdown();
  const b = s.boot();
  b.door.open = false;
  b.bots.tick();
  assert.equal(b.bots.view().rungs.knockout['1'].starting, 1, 'starting, nothing taken');
  assert.equal(b.float(), M(20));
  b.door.open = true;
  b.bots.tick();
  assert.equal(b.bots.view().rungs.knockout['1'].waiting, 1);
  assert.equal(b.float(), M(19));
});

test('W5: the switch is saved; Off sends the bots home and empties the file', () => {
  const s = server();
  assert.equal(s.bots.enabled(), false, 'a server with no file starts Off');
  s.bots.setEnabled(true);
  s.bots.setCount('swim', 0.5, 2);
  assert.equal(s.boot().bots.enabled(), true);
  s.bots.setEnabled(false);
  assert.equal(s.float(), M(20));
  assert.deepEqual(s.saved(), { v: 1, enabled: false, bots: [] });
  const b = s.boot();
  b.bots.tick();
  assert.equal(b.bots.enabled(), false);
  assert.equal(b.bots.heldMicro(), 0);
});

test('W5: with the save turned off (index.js KEEP_DUEL_BOTS_ACROSS_RESTARTS = false, no file) every boot is Off with no bot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duelwait-nofile-'));
  const bankFile = path.join(dir, 'bot-bank.json');
  fs.writeFileSync(bankFile, JSON.stringify({ balance: M(20), capMicro: M(200), day: '', spent: 0, inflight: 0, topups: [], log: [] }));
  const make = () => {
    const bank = createBotBank({ file: bankFile, log: quiet, tickMs: 0 });
    const ko = new KnockoutLobby(io);
    return { bank, ko, bots: createDuelBots({ bank, lobbies: { knockout: ko }, log: quiet, file: null }) };
  };
  const a = make();
  a.bots.setEnabled(true);
  a.bots.spawn('knockout', 1);
  assert.equal(a.bots.switchSaved(), false, 'Control is told it is not saved');
  assert.equal(a.bots.view().saved, false);
  a.ko.shutdownSettle('shutdown');
  assert.equal(a.bank.balanceMicro(), M(20), 'the stake went home at the shutdown');
  const b = make();
  b.bots.tick();
  assert.equal(b.bots.enabled(), false, 'Off at boot');
  assert.equal(b.bots.heldMicro(), 0, 'no bot came back');
  assert.equal(b.bank.balanceMicro(), M(20));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('duel-bots')), [], 'nothing written');
  // a hard kill with two bots waiting (no shutdown at all): the bank gives both stakes back at boot, Off, no bot
  b.bots.setEnabled(true);
  b.bots.spawn('knockout', 1);
  b.bots.spawn('knockout', 0.5);
  assert.equal(b.bank.balanceMicro(), M(18.5));
  const c = make();
  c.bots.tick();
  assert.equal(c.bank.balanceMicro(), M(20), 'both stakes back in the Bot bank');
  assert.equal(JSON.parse(fs.readFileSync(bankFile, 'utf8')).inflight, 0);
  assert.equal(c.bots.enabled(), false, 'Off at boot');
  assert.equal(c.bots.heldMicro(), 0, 'no bot came back');
  const d = make();
  assert.equal(d.bank.balanceMicro(), M(20), 'and only once');
});

test('W4: in a shutdown\'s last seconds, Off is still saved and a starting bot is kept for the next boot', async () => {
  // Off pressed after the shutdown closed the seats: the next boot brings nothing back
  const s = server();
  s.bots.setEnabled(true);
  s.bots.spawn('knockout', 1);
  s.shutdown();
  s.bots.setEnabled(false);
  assert.deepEqual(s.saved(), { v: 1, enabled: false, bots: [] });
  const b = s.boot();
  b.bots.tick();
  assert.equal(b.bots.enabled(), false);
  assert.equal(b.float(), M(20));
  // a bot still starting (its money on the way) when the shutdown begins stays in the file, nothing taken
  const chain = fakeChain(M(5));
  const t = server({ float: 0, chain });
  t.bots.setEnabled(true);
  t.bots.spawn('headsoccer', 0.5);
  t.shutdown();
  t.clock.t += START_GIVE_UP_MS + 1000;
  t.bots.tick();
  assert.equal(t.saved().bots.length, 1, 'kept for the next boot');
  assert.equal(t.file().inflight, 0, 'nothing taken');
});

test('W6: escrow money is conserved at every step, the daily limit counts waiting bots, and the person is paid as against a person', () => {
  const s = server({ cap: 1.5 });
  s.bots.setEnabled(true);
  const total = () => s.float() + held(s);
  assert.equal(s.bots.setCount('knockout', 1, 1).waiting, 1);
  assert.equal(total(), M(20));
  const r = s.bots.setCount('headsoccer', 1, 1);
  assert.equal(r.ok, false, '$1 more would pass the $1.50 daily limit');
  assert.match(r.why, /limit/);
  assert.equal(total(), M(20), 'nothing taken by the refusal');
  assert.equal(s.bots.setCount('headsoccer', 0.5, 1).waiting, 1);
  assert.equal(total(), M(20));
  // a person beats the Knockout bot: paid the pot less 10%, exactly as against a person
  personQueues(s.ko, 'p', 1, true, s.clock.t);
  const room = s.ko.roomOf('p');
  assert.ok(room && room.bot && room.bot.paidBot);
  const botId = room.bot.id;
  assert.equal(total(), M(20), 'the bot stake is held at the table');
  room.finish('p', 'test');
  assert.deepEqual(s.out.sends, [{ wallet: 'Wp', micro: M(1.8) }], 'pot $2 less 10%');
  assert.deepEqual(s.out.rake, [M(0.2)]);
  assert.equal(total(), M(19), 'the bank lost exactly the bot stake');
  assert.equal(s.bots.isPaidBot(botId), false, 'the seat is over');
  // the other bot runs out its wait: home
  s.run(BOT_WAIT_MS + 60e3);
  assert.equal(s.float(), M(19));
  assert.equal(held(s), 0);
});

test('W7: startOn (index.js, Owen 2026-11-08 "on by default every time") boots On with or without a saved Off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duelwait-starton-'));
  const bankFile = path.join(dir, 'bot-bank.json');
  fs.writeFileSync(bankFile, JSON.stringify({ balance: M(20), capMicro: M(200), day: '', spent: 0, inflight: 0, topups: [], log: [] }));
  const file = path.join(dir, 'duel-bots.json');
  const make = (f) => {
    const bank = createBotBank({ file: bankFile, log: quiet, tickMs: 0 });
    const ko = new KnockoutLobby(io);
    return { bank, ko, bots: createDuelBots({ bank, lobbies: { knockout: ko }, log: quiet, file: f, startOn: true }) };
  };
  const a = make(null);
  assert.equal(a.bots.enabled(), true, 'On at boot with no file');
  const b = make(file);
  assert.equal(b.bots.enabled(), true, 'On at boot with a file');
  b.bots.setEnabled(false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).enabled, false, 'Off is saved');
  const c = make(file);
  assert.equal(c.bots.enabled(), true, 'On again at the next boot even though Off was saved');
  assert.equal(c.bots.heldMicro(), 0, 'no stake taken just by booting');
  assert.equal(c.bank.balanceMicro(), M(20));
});
