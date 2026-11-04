'use strict';
/* ─── The owner's PAID duel bots (Owen 2026-11-04) ─────────────────────────────
   Duels were people only. Owen now spawns a bot into a duel's $0.50 or $1 rung himself, from Control, so a paid lobby
   is never empty. This file is the only thing that makes one, and the only thing that moves a duel bot's money.

   THE BOT'S MONEY IS THE BOT BANK'S (server/botBank.js). A spawn takes the rung's stake from the bank (take: saved
   there first, and counted as in flight), so the bot's seat is backed by escrow money exactly like a person's stake.
   The bot then sits in the duel's queue (KnockoutLobby / SwimLobby enqueueBot) for BOT_WAIT_MS. Every seat ends
   in exactly one of these, once (seat.state 'done', the bank's settleSeat in one save):
     - nobody came, Control lowered it, the kill switch, a match that could not start, a restart or a crash:
       its stake goes BACK to the bank (back);
     - it played and LOST: the stake is the winner's, paid by settleTable exactly as against a person (90/10);
     - it played and WON: the pot less the same house cut comes home to the bank ("Bot keeps it", Owen 2026-11-04);
     - a draw: each seat its own stake back, the person's through koSend, the bot's to the bank.
   A hard kill (no settle at all) leaves the stake in the bank's in-flight count, which the bank gives back to itself
   at the next boot (botBank.js), the same as a slither bounty bot's seed.

   DISCLOSURE (the dispatcher's hard rules, 2026-11-04). A person meets a paid bot only when the lobby showed them
   "Bot opponent waiting" on the rung they pressed before they paid (the page says so with botOk; duelQueue.mayPair),
   and the bot was already waiting when they queued. The match screen names it a bot (room.bot.paidBot -> vsBot).
   Nobody else is ever paired with one.

   THE KILL SWITCH starts OFF at every boot (rule c) and is never saved: a deploy always comes up with no paid duel
   bots until Owen turns them on in Control. Off removes every waiting bot (stake back) and refuses new ones; a match
   already being played finishes as a normal paid match.

   Fair play is each game's own bot (server/hsBot.js and the rest, reviewed for it): it reads the same state a person's
   screen shows and plays by the same physics. Nothing here changes how a bot plays. */

const crypto = require('crypto');
const { pickName } = require('./botNames');

const BOT_WAIT_MS = 60000;          // a bot waits a minute for a person, then leaves (Owen 2026-11-04)
const MAX_WAITING_PER_RUNG = 3;     // bots waiting at one rung of one game at once
const RUNGS = [0.5, 1];
const NAME_MAX = 15;
const toMicro = (usd) => Math.round(Number(usd) * 1e6);

const GAME_NAMES = {
  knockout: 'Knockout', swim: 'Swim', headsoccer: 'Head Soccer', pool8: '8 Ball Pool', airhockey: 'Air Hockey',
  rooftop: 'Rooftop Snipers', crossy: 'Road Hop',
};

/* deps:
   bank      the Bot bank (whyNot, take, settleSeat)
   lobbies   { game: lobby } every paid duel that takes bots (each has enqueueBot, removeBot, botsWaitingByRung)
   doorOpen  (game) -> true while that duel's paid tables take seats (index.js duelPaidDoors)
   onChange  () -> called after a bot comes or goes (the lobby board and Control redraw)
   record    ({ game, rung, result, stakeMicro, backMicro, why }) -> the owner's Spent today (server/ownerSpend.js) */
function createDuelBots({ bank, lobbies, doorOpen = () => true, onChange = null, record = null, now = Date.now,
  log = console, rand = Math.random } = {}) {
  if (!bank || typeof bank.take !== 'function' || typeof bank.settleSeat !== 'function') throw new Error('duelBots: a bank is required');
  const games = Object.assign({}, lobbies || {});
  let enabled = false;                 // the kill switch: OFF at every boot, never saved
  const seats = new Map();             // botId -> { id, game, rung, micro, label, name, state, roomId, since }
  const recent = [];                   // the last few finished seats, for Control
  let seq = 0;

  const changed = () => { if (typeof onChange === 'function') { try { onChange(); } catch (_) { /* display only */ } } };
  const tell = (r) => { if (typeof record === 'function') { try { record(r); } catch (_) { /* display only */ } } };

  /* One bot seat is over: its money settled in the bank, exactly once. backMicro: what comes home (its stake back,
     0 for a loss, the prize for a win). -> true the first time for a seat this manager holds, false after. */
  function close(id, backMicro, result, why) {
    const s = seats.get(id);
    if (!s || s.state === 'done') return false;
    s.state = 'done';
    seats.delete(id);
    const ok = bank.settleSeat(s.micro, backMicro, why, s.label);
    if (!ok) log.error('[DUELBOT] CRITICAL ' + s.label + ' ' + result + ' not saved in the bank; its stake stays in flight (given back at the next boot)');
    recent.push({ game: s.game, rung: s.rung, result, back: backMicro / 1e6, why: String(why || ''), at: now() });
    if (recent.length > 20) recent.splice(0, recent.length - 20);
    tell({ game: s.game, rung: s.rung, result, stakeMicro: s.micro, backMicro, why: String(why || '') });
    console.log('[DUELBOT] ' + s.label + ' ' + s.name + ': ' + result + ' (' + (backMicro / 1e6).toFixed(2) + ' back to the bank)' + (why ? ' ' + why : ''));
    changed();
    return true;
  }

  // The lobby hooks (KnockoutLobby.refund / makeMatch, duelQueue.shutdownRows).
  const hooks = {
    back(id, why) { const s = seats.get(id); return s ? close(id, s.micro, 'back', why) : false; },
  };
  for (const [game, lobby] of Object.entries(games)) {
    if (!lobby) { delete games[game]; continue; }
    lobby.paidBots = hooks;
    lobby.onBotSeated = (entry, room) => {
      const s = seats.get(entry && entry.socket && entry.socket.id);
      if (!s) return;
      s.state = 'playing';
      s.roomId = room && room.id;
      changed();
    };
  }

  function refuse(why) { return { ok: false, why }; }

  function waitingAt(game, rung) {
    let n = 0;
    for (const s of seats.values()) if (s.game === game && s.rung === rung && s.state === 'waiting') n++;
    return n;
  }

  /* One bot into game's rung, its stake from the bank. -> { ok, id, name } or { ok: false, why } with nothing taken. */
  function spawn(game, rungIn) {
    if (!enabled) return refuse('Paid duel bots are off. Turn them on first.');
    const lobby = games[game];
    if (!lobby) return refuse('That game does not take paid bots');
    const rung = RUNGS.find((r) => Math.abs(r - Number(rungIn)) < 1e-9);
    if (!rung) return refuse('Paid bots go on the $0.50 or $1 table only');
    if (lobby.stopping) return refuse('The game is restarting');
    if (!doorOpen(game)) return refuse((GAME_NAMES[game] || game) + "'s paid tables are closed");
    if (waitingAt(game, rung) >= MAX_WAITING_PER_RUNG) return refuse('Already ' + MAX_WAITING_PER_RUNG + ' bots waiting there');
    const micro = toMicro(rung);
    const no = bank.whyNot(micro);
    if (no) {
      return refuse(no === 'cap' ? "Today's bot limit is used up" : no === 'funding' ? 'The Bot bank is moving money in. Try again in a few seconds'
        : 'The Bot bank does not have $' + rung.toFixed(2));
    }
    const label = 'duel:' + game + ':' + rung;
    if (!bank.take(micro, label)) return refuse('The Bot bank did not take it');
    const id = 'bot_pd' + (++seq) + '_' + crypto.randomBytes(3).toString('hex');
    const name = pickName(rand(), { maxLen: NAME_MAX });
    const t = now();
    const s = { id, game, rung, micro, label, name, state: 'waiting', roomId: null, since: t };
    seats.set(id, s);
    const entry = {
      socket: { id, join() {}, leave() {}, emit() {} }, name, wallet: null, since: t, botWait: BOT_WAIT_MS,
      stake: rung, worth: rung, paid: rung, skin: null, resumeKey: null,
      paidBot: { until: t + BOT_WAIT_MS, game },
    };
    let queued = false;
    try { queued = lobby.enqueueBot(entry, t) === true; } catch (e) { log.error('[DUELBOT] enqueue threw: ' + (e && e.message)); }
    if (!queued) {
      close(id, micro, 'back', 'not queued');
      return refuse('The queue did not take it');
    }
    console.log('[DUELBOT] ' + label + ' ' + name + ' waiting for a person');
    changed();
    return { ok: true, id, name };
  }

  /* Waiting bots at game's rung down to `count` (Control's minus). The newest go first. -> how many left. */
  function lowerTo(game, rungIn, count) {
    const lobby = games[game];
    const rung = RUNGS.find((r) => Math.abs(r - Number(rungIn)) < 1e-9);
    if (!lobby || !rung) return 0;
    const mine = [...seats.values()].filter((s) => s.game === game && s.rung === rung && s.state === 'waiting')
      .sort((a, b) => b.since - a.since);
    let removed = 0;
    for (const s of mine.slice(0, Math.max(0, mine.length - Math.max(0, count | 0)))) {
      if (lobby.removeBot(s.id, 'removed in Control')) removed++;
      else close(s.id, s.micro, 'back', 'removed in Control');   // not in the queue any more: back once all the same
    }
    return removed;
  }

  /* Control's number for one rung: set the waiting bots to `count` (spawning or removing). */
  function setCount(game, rung, count) {
    const want = Math.max(0, Math.min(MAX_WAITING_PER_RUNG, Number.isInteger(count) ? count : 0));
    const have = waitingAt(game, Number(rung));
    if (want < have) { lowerTo(game, rung, want); return { ok: true, waiting: waitingAt(game, Number(rung)) }; }
    let why = null;
    for (let i = have; i < want; i++) {
      const r = spawn(game, rung);
      if (!r.ok) { why = r.why; break; }
    }
    return { ok: why === null || waitingAt(game, Number(rung)) > have, why, waiting: waitingAt(game, Number(rung)) };
  }

  function setEnabled(on) {
    enabled = on === true;
    if (!enabled) {
      for (const s of [...seats.values()]) {
        if (s.state !== 'waiting') continue;
        const lobby = games[s.game];
        if (!(lobby && lobby.removeBot(s.id, 'paid duel bots turned off'))) close(s.id, s.micro, 'back', 'paid duel bots turned off');
      }
    }
    changed();
    return enabled;
  }

  /* A paid table's result when one seat is a bot this manager placed. -> false when no seat is (the caller pays its
     own way, unchanged); true once it has paid this table. ctx: { game, tag, koSend, trackEarning, sweepRake,
     houseCut, region }. The person is paid EXACTLY as against a person: a win is the pot less the cut through
     koSend; a draw is their own refund; a loss is nothing. The bot's side settles in the bank (close). */
  function settleTable(o, ctx) {
    const seatList = o && Array.isArray(o.seats) ? o.seats : [];
    const bot = seatList.find((x) => x && seats.has(x.id));
    if (!bot) return false;
    const s = seats.get(bot.id);
    const human = seatList.find((x) => x && x !== bot) || null;
    const winner = seatList.find((x) => x && x.id === o.winnerId) || null;
    const pot = Number(o.pot) || 0;
    const game = ctx.game, roomId = o.roomId;
    const cut = pot * ctx.houseCut;
    const prize = pot - cut;
    try {
      if (winner && winner === human && human.wallet) {
        ctx.trackEarning({ source: 'game_rake', game, amountUsdc: cut, wallet: human.wallet, name: human.name,
          lobbyType: game, region: ctx.region });
        ctx.sweepRake(cut, game);
        ctx.koSend(human.wallet, prize, human.name, game + ' ' + roomId);
        console.log(ctx.tag + ' ' + roomId + ' pot ' + pot.toFixed(2) + ' -> ' + human.name + ' ' + prize.toFixed(2)
          + ' (cut ' + cut.toFixed(2) + ', beat a paid bot)');
        close(bot.id, 0, 'lost', roomId);
      } else if (winner && winner === bot) {
        ctx.trackEarning({ source: 'game_rake', game, amountUsdc: cut, wallet: null, name: s.name,
          lobbyType: game, region: ctx.region });
        ctx.sweepRake(cut, game);
        console.log(ctx.tag + ' ' + roomId + ' pot ' + pot.toFixed(2) + ' -> paid bot ' + s.name + ' ' + prize.toFixed(2)
          + ' to the Bot bank (cut ' + cut.toFixed(2) + ')');
        close(bot.id, toMicro(prize), 'won', roomId);
      } else {
        if (human && human.worth > 0 && human.wallet) {
          ctx.koSend(human.wallet, human.refund, human.name, game + ' refund (' + (o.why || 'no winner') + ')');
        }
        console.log(ctx.tag + ' ' + roomId + ' vs a paid bot refunded (' + (o.why || 'no winner') + ')');
        close(bot.id, s.micro, 'draw', 'draw ' + roomId);
      }
    } catch (e) {
      log.error('[DUELBOT] CRITICAL settle of ' + roomId + ' threw: ' + (e && e.stack ? e.stack : e));
    }
    return true;
  }

  // For the lobby board (/api/live extras): bots waiting at each rung of a game, { '0.5': 1 }.
  function waitingByRung(game) {
    const out = {};
    for (const s of seats.values()) {
      if (s.game !== game || s.state !== 'waiting') continue;
      out[String(s.rung)] = (out[String(s.rung)] || 0) + 1;
    }
    return out;
  }

  // For Control: the switch, and every rung's bots.
  function view() {
    const rungs = {};
    for (const g of Object.keys(games)) {
      rungs[g] = {};
      for (const r of RUNGS) rungs[g][String(r)] = { waiting: 0, playing: 0 };
    }
    for (const s of seats.values()) {
      const row = rungs[s.game] && rungs[s.game][String(s.rung)];
      if (!row) continue;
      if (s.state === 'waiting') row.waiting++;
      else if (s.state === 'playing') row.playing++;
    }
    return { enabled, games: Object.keys(games), rungs, max: MAX_WAITING_PER_RUNG, waitS: BOT_WAIT_MS / 1000,
      recent: recent.slice(-8) };
  }

  return {
    spawn, setCount, lowerTo, setEnabled, settleTable, waitingByRung, view,
    enabled: () => enabled,
    isPaidBot: (id) => seats.has(id),
    held: () => [...seats.values()].map((s) => Object.assign({}, s)),
    BOT_WAIT_MS, MAX_WAITING_PER_RUNG, RUNGS,
  };
}

module.exports = { createDuelBots, BOT_WAIT_MS, MAX_WAITING_PER_RUNG, RUNGS, GAME_NAMES };
