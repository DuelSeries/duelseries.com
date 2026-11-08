'use strict';
/* ─── The owner's PAID duel bots (Owen 2026-11-04, reworked 2026-11-08) ────────
   Duels were people only. Owen spawns a bot into a duel's $0.50 or $1 rung himself, from Control (the + on that
   game's $0.50 or $1 cell), so a paid lobby is never empty. This file is the only thing that makes one, and the only
   thing that moves a duel bot's money.

   THE BOT'S MONEY IS THE BOT BANK'S (server/botBank.js). A bot's stake is taken from the bank (take: saved there
   first, and counted as in flight), so its seat is backed by escrow money exactly like a person's stake. The bank
   keeps its money in its own wallet and only a small float in escrow, which goes home after two idle minutes, so most
   of the time the float is $0 and a stake has to be moved into escrow first (whyNot 'funding', a few seconds). Until
   2026-11-08 a + pressed then was refused ("moving money in, try again") and nothing tried again: on the live site the
   + never placed a bot. Now the bot is STARTING (no money taken yet) and starts by itself the moment the bank can
   pay its stake (tick, and the bank's onReady); a stake that has not arrived after START_GIVE_UP_MS drops it, with
   nothing taken.

   Once started the bot sits in the duel's queue (KnockoutLobby / SwimLobby enqueueBot) for up to waitMs, TWO HOURS
   (Owen 2026-11-08: it waits for a person to press Play). Every seat with money ends in exactly one of these, once
   (seat.state 'done', the bank's settleSeat in one save):
     - nobody came in time, Control lowered it, the switch went Off, a match that could not start, a restart or a
       crash: its stake goes BACK to the bank (back);
     - it played and LOST: the stake is the winner's, paid by settleTable exactly as against a person (90/10);
     - it played and WON: the pot less the same house cut comes home to the bank ("Bot keeps it", Owen 2026-11-04);
     - a draw: each seat its own stake back, the person's through koSend, the bot's to the bank.
   A hard kill (no settle at all) leaves the stake in the bank's in-flight count, which the bank gives back to itself
   at the next boot (botBank.js), the same as a slither bounty bot's seed.

   SAVED ACROSS RESTARTS (Owen 2026-11-08; until then the switch was Off at every boot and a deploy, several a day,
   sent every bot home for good). `file` keeps the switch and every bot still starting or waiting: its game, rung,
   name and the end of its wait. A restart gives each waiting bot's stake back to the bank first (duelQueue.
   shutdownRows, or the bank's in-flight count after a hard kill), and the next boot brings each one back as a NEW
   seat with what was left of its wait, taking a fresh stake from the bank. So every stake is still taken once and
   ends once, and a deploy no longer clears the queue Owen set. A bot with under RESTORE_MIN_LEFT_MS left is not
   brought back. Once a shutdown has begun (a seat closed with why 'restart' or 'crash') the file is no longer
   written, so it keeps the bots for the boot after.

   DISCLOSURE (the dispatcher's hard rules, 2026-11-04). A person meets a paid bot only when the lobby showed them
   "Bot opponent waiting" on the rung they pressed before they paid (the page says so with botOk; duelQueue.mayPair),
   and the bot was already waiting when they queued. The match screen names it a bot (room.bot.paidBot -> vsBot).
   Nobody else is ever paired with one. A starting bot is not in the queue and is not shown to anybody.

   THE SWITCH (Control's "Paid duel bots"): Off removes every waiting bot (stake back) and every starting one
   (nothing taken), and refuses new ones; a match already being played finishes as a normal paid match.

   Fair play is each game's own bot (server/hsBot.js and the rest, reviewed for it): it reads the same state a person's
   screen shows and plays by the same physics. Nothing here changes how a bot plays. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pickName } = require('./botNames');

const BOT_WAIT_MS = 2 * 60 * 60 * 1000;   // a bot waits up to two hours for a person, then leaves (Owen 2026-11-08)
const START_GIVE_UP_MS = 3 * 60000;       // a + whose stake the Bot bank has not moved into escrow by then: dropped
const RESTORE_START_MS = 10 * 60000;      // after a restart: how long a bot may wait for the bank's first wallet read
const RESTORE_MIN_LEFT_MS = 60000;        // after a restart, a bot with less of its wait left than this stays gone
const TICK_MS = 2000;                     // starting bots try again this often (and whenever a bank transfer lands)
const MAX_WAITING_PER_RUNG = 3;           // bots starting or waiting at one rung of one game at once
const RUNGS = [0.5, 1];
const NAME_MAX = 15;
const toMicro = (usd) => Math.round(Number(usd) * 1e6);

const GAME_NAMES = {
  knockout: 'Knockout', swim: 'Swim', headsoccer: 'Head Soccer', pool8: '8 Ball Pool', airhockey: 'Air Hockey',
  rooftop: 'Rooftop Snipers', crossy: 'Crossy Road',
};
const SHUTDOWN_WHYS = new Set(['restart', 'crash']);

/* deps:
   bank      the Bot bank (whyNot, take, settleSeat)
   lobbies   { game: lobby } every paid duel that takes bots (each has enqueueBot, removeBot, botsWaitingByRung)
   doorOpen  (game) -> true while that duel's paid tables take seats (index.js: its paid door, and not maintenance)
   onChange  () -> called after a bot comes or goes (the lobby board and Control redraw)
   record    ({ game, rung, result, stakeMicro, backMicro, why }) -> the owner's Spent today (server/ownerSpend.js)
   waitMs    how long a bot waits for a person (BOT_WAIT_MS; shorter only for tests and local checks)
   file      where the switch and the waiting bots are saved (null: nothing saved, the switch starts Off)
   tickMs    how often starting bots try again on their own (0: only when tick() is called) */
function createDuelBots({ bank, lobbies, doorOpen = () => true, onChange = null, record = null, now = Date.now,
  log = console, rand = Math.random, waitMs = BOT_WAIT_MS, file = null, fsx = fs, tickMs = 0 } = {}) {
  if (!bank || typeof bank.take !== 'function' || typeof bank.settleSeat !== 'function') throw new Error('duelBots: a bank is required');
  const WAIT = Number.isFinite(waitMs) && waitMs >= 1000 && waitMs <= BOT_WAIT_MS ? Math.round(waitMs) : BOT_WAIT_MS;
  const games = Object.assign({}, lobbies || {});
  let enabled = false;                 // the switch
  const seats = new Map();             // botId -> { id, game, rung, micro, label, name, state, roomId, since, until, startBy }
  const recent = [];                   // the last few finished seats, for Control
  let seq = 0;
  let frozen = false;                  // a shutdown began: the file keeps what it says for the next boot
  let lastSaveOk = true;               // the switch's last save (Control says when it would not survive a restart)

  const changed = () => { if (typeof onChange === 'function') { try { onChange(); } catch (_) { /* display only */ } } };
  const tell = (r) => { if (typeof record === 'function') { try { record(r); } catch (_) { /* display only */ } } };
  const rungOf = (v) => RUNGS.find((r) => Math.abs(r - Number(v)) < 1e-9);
  const gameName = (g) => GAME_NAMES[g] || g;
  const open = (s) => s.state === 'starting' || s.state === 'waiting';   // what Control's number counts

  /* ── the saved file: the switch and every bot still starting or waiting ── */
  function save() {
    if (!file || frozen) return true;
    const bots = [...seats.values()].filter(open)
      .map((s) => ({ game: s.game, rung: s.rung, name: s.name, until: s.until }));
    try {
      fsx.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fsx.writeFileSync(tmp, JSON.stringify({ v: 1, enabled, bots }) + '\n');
      fsx.renameSync(tmp, file);
      return true;
    } catch (e) {
      log.error('[DUELBOT] not saved (' + file + '): ' + (e && e.message));
      return false;
    }
  }
  function load() {
    if (!file) return null;
    try {
      const raw = JSON.parse(fsx.readFileSync(file, 'utf8'));
      return raw && typeof raw === 'object' ? raw : null;
    } catch (e) {
      if (!(e && e.code === 'ENOENT')) log.error('[DUELBOT] saved bots unreadable, starting with none: ' + (e && e.message));
      return null;
    }
  }

  function remember(s, result, backMicro, why) {
    recent.push({ game: s.game, rung: s.rung, result, back: backMicro / 1e6, why: String(why || ''), at: now() });
    if (recent.length > 20) recent.splice(0, recent.length - 20);
  }

  /* A STARTING bot goes before any money was taken: nothing to settle, the bank never touched. */
  function drop(s, why) {
    if (!seats.has(s.id) || s.state !== 'starting') return false;
    s.state = 'done';
    seats.delete(s.id);
    remember(s, 'not started', 0, why);
    console.log('[DUELBOT] ' + s.label + ' ' + s.name + ': not started, nothing taken (' + why + ')');
    save();
    changed();
    return true;
  }

  /* One bot seat WITH MONEY is over: its money settled in the bank, exactly once. backMicro: what comes home (its
     stake back, 0 for a loss, the prize for a win). -> true the first time for a seat this manager holds, false after. */
  function close(id, backMicro, result, why) {
    const s = seats.get(id);
    if (!s || s.state === 'done') return false;
    if (s.state === 'starting') return drop(s, String(why || 'removed'));   // never had a stake: nothing to give back
    if (SHUTDOWN_WHYS.has(String(why))) frozen = true;                       // keep the file for the next boot
    s.state = 'done';
    seats.delete(id);
    const ok = bank.settleSeat(s.micro, backMicro, why, s.label);
    if (!ok) log.error('[DUELBOT] CRITICAL ' + s.label + ' ' + result + ' not saved in the bank; its stake stays in flight (given back at the next boot)');
    remember(s, result, backMicro, why);
    tell({ game: s.game, rung: s.rung, result, stakeMicro: s.micro, backMicro, why: String(why || '') });
    console.log('[DUELBOT] ' + s.label + ' ' + s.name + ': ' + result + ' (' + (backMicro / 1e6).toFixed(2) + ' back to the bank)' + (why ? ' ' + why : ''));
    save();
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
      save();
      changed();
    };
  }

  function refuse(why) { return { ok: false, why }; }
  function bankWhy(no, rung) {
    return no === 'cap' ? "Today's bot limit is used up"
      : no === 'funding' ? 'The Bot bank did not get its money into escrow in time'
        : 'The Bot bank does not have $' + rung.toFixed(2);
  }

  function countAt(game, rung) {
    let n = 0;
    for (const s of seats.values()) if (s.game === game && s.rung === rung && open(s)) n++;
    return n;
  }

  function makeSeat(game, rung, { name = null, until = null, startBy } = {}) {
    const id = 'bot_pd' + (++seq) + '_' + crypto.randomBytes(3).toString('hex');
    const s = { id, game, rung, micro: toMicro(rung), label: 'duel:' + game + ':' + rung,
      name: name || pickName(rand(), { maxLen: NAME_MAX }), state: 'starting', roomId: null, since: null,
      until, startBy };
    seats.set(id, s);
    return s;
  }

  /* A starting bot takes its stake and joins the queue, or waits for the bank, or is dropped (nothing taken).
     -> 'started', 'later' or 'dropped'. */
  function start(s) {
    if (!seats.has(s.id) || s.state !== 'starting') return 'dropped';
    const t = now();
    const lobby = games[s.game];
    if (!enabled) { drop(s, 'paid duel bots are off'); return 'dropped'; }
    if (s.until !== null && t >= s.until - RESTORE_MIN_LEFT_MS) { drop(s, 'its wait was over before it could start'); return 'dropped'; }
    const late = t >= s.startBy;
    /* A lobby stopping is a shutdown under way (duelQueue.shutdownRows): the file keeps this bot for the next boot,
       so it is neither dropped nor written out (Fable review 2026-11-08). */
    if (lobby && lobby.stopping) { frozen = true; return 'later'; }
    if (!lobby) { if (late) drop(s, 'the game is not running'); return late ? 'dropped' : 'later'; }
    if (!doorOpen(s.game)) { if (late) drop(s, gameName(s.game) + "'s paid tables are closed"); return late ? 'dropped' : 'later'; }
    const no = bank.whyNot(s.micro);
    if (no === 'funding' && !late) return 'later';
    if (no) { drop(s, bankWhy(no, s.rung)); return 'dropped'; }
    if (!bank.take(s.micro, s.label)) { drop(s, 'the Bot bank did not take it'); return 'dropped'; }
    s.state = 'waiting';
    s.since = t;
    if (s.until === null) s.until = t + WAIT;
    const entry = {
      socket: { id: s.id, join() {}, leave() {}, emit() {} }, name: s.name, wallet: null, since: t, botWait: s.until - t,
      stake: s.rung, worth: s.rung, paid: s.rung, skin: null, resumeKey: null,
      paidBot: { until: s.until, game: s.game },
    };
    let queued = false;
    try { queued = lobby.enqueueBot(entry, t) === true; } catch (e) { log.error('[DUELBOT] enqueue threw: ' + (e && e.message)); }
    if (!queued) {
      close(s.id, s.micro, 'back', 'not queued');
      return 'dropped';
    }
    console.log('[DUELBOT] ' + s.label + ' ' + s.name + ' waiting for a person until ' + new Date(s.until).toISOString());
    save();
    changed();
    return 'started';
  }

  /* Every starting bot tries again (the timer, the bank's onReady, and each Control press). */
  function tick() {
    for (const s of [...seats.values()]) if (s.state === 'starting') start(s);
  }

  /* One bot into game's rung. -> { ok, id, name, starting } or { ok: false, why } with nothing taken. starting: the
     bank is moving its stake into escrow, and the bot starts by itself when it lands. */
  function spawn(game, rungIn) {
    if (!enabled) return refuse('Paid duel bots are off. Turn them on first.');
    const lobby = games[game];
    if (!lobby) return refuse('That game does not take paid bots');
    const rung = rungOf(rungIn);
    if (!rung) return refuse('Paid bots go on the $0.50 or $1 table only');
    if (lobby.stopping) return refuse('The game is restarting');
    if (!doorOpen(game)) return refuse(gameName(game) + "'s paid tables are closed");
    if (countAt(game, rung) >= MAX_WAITING_PER_RUNG) return refuse('Already ' + MAX_WAITING_PER_RUNG + ' bots waiting there');
    const no = bank.whyNot(toMicro(rung));       // 'funding' starts the bank's transfer into escrow
    if (no && no !== 'funding') return refuse(bankWhy(no, rung));
    const s = makeSeat(game, rung, { startBy: now() + START_GIVE_UP_MS });
    const r = start(s);
    if (r === 'dropped' && !seats.has(s.id)) {
      const last = recent[recent.length - 1];
      return refuse(last && last.why ? last.why.charAt(0).toUpperCase() + last.why.slice(1) : 'The bot could not start');
    }
    if (r === 'later') {
      console.log('[DUELBOT] ' + s.label + ' ' + s.name + ' starting: the Bot bank is moving its stake into escrow');
      save();
      changed();
    }
    return { ok: true, id: s.id, name: s.name, starting: s.state === 'starting' };
  }

  /* Bots at game's rung down to `count` (Control's minus). Starting ones go first (no money taken), then the newest
     waiting. -> how many went. */
  function lowerTo(game, rungIn, count) {
    const lobby = games[game];
    const rung = rungOf(rungIn);
    if (!lobby || !rung) return 0;
    const mine = [...seats.values()].filter((s) => s.game === game && s.rung === rung && open(s))
      .sort((a, b) => (a.state === 'starting' ? 0 : 1) - (b.state === 'starting' ? 0 : 1) || (b.since || 0) - (a.since || 0));
    let removed = 0;
    for (const s of mine.slice(0, Math.max(0, mine.length - Math.max(0, count | 0)))) {
      if (s.state === 'starting') { if (drop(s, 'removed in Control')) removed++; continue; }
      if (lobby.removeBot(s.id, 'removed in Control')) removed++;
      else if (close(s.id, s.micro, 'back', 'removed in Control')) removed++;   // not in the queue any more: back once all the same
    }
    return removed;
  }

  /* Control's number for one rung: set the bots starting or waiting there to `count` (spawning or removing). */
  function setCount(game, rungIn, count) {
    const rung = rungOf(rungIn);
    const want = Math.max(0, Math.min(MAX_WAITING_PER_RUNG, Number.isInteger(count) ? count : 0));
    const have = rung ? countAt(game, rung) : 0;
    if (want < have) { lowerTo(game, rung, want); return { ok: true, waiting: countAt(game, rung) }; }
    let why = null;
    for (let i = have; i < want; i++) {
      const r = spawn(game, rungIn);
      if (!r.ok) { why = r.why; break; }
    }
    const after = rung ? countAt(game, rung) : 0;
    return { ok: why === null || after > have, why, waiting: after, starting: rung ? startingAt(game, rung) : 0 };
  }
  function startingAt(game, rung) {
    let n = 0;
    for (const s of seats.values()) if (s.game === game && s.rung === rung && s.state === 'starting') n++;
    return n;
  }

  function setEnabled(on) {
    enabled = on === true;
    /* Off is always written, even in a shutdown's last seconds: the next boot must not bring back bots Owen switched
       off (Fable review 2026-11-08). Every seat is already settled or gone by then, so the file says Off, no bots. */
    if (!enabled) frozen = false;
    if (!enabled) {
      for (const s of [...seats.values()]) {
        if (s.state === 'starting') { drop(s, 'paid duel bots turned off'); continue; }
        if (s.state !== 'waiting') continue;
        const lobby = games[s.game];
        if (!(lobby && lobby.removeBot(s.id, 'paid duel bots turned off'))) close(s.id, s.micro, 'back', 'paid duel bots turned off');
      }
    }
    lastSaveOk = save();
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

  // For the lobby board (/api/live extras): bots waiting at each rung of a game, { '0.5': 1 }. Starting ones are not
  // in the queue yet, so nobody is shown them.
  function waitingByRung(game) {
    const out = {};
    for (const s of seats.values()) {
      if (s.game !== game || s.state !== 'waiting') continue;
      out[String(s.rung)] = (out[String(s.rung)] || 0) + 1;
    }
    return out;
  }

  /* The stakes the bots hold now (waiting or at a table), in micro: escrow money the Bot bank's float no longer
     counts, owed back to the bank or to whoever beats the bot (index.js adds it to the solvency sum). */
  function heldMicro() {
    let m = 0;
    for (const s of seats.values()) if (s.state === 'waiting' || s.state === 'playing') m += s.micro;
    return m;
  }

  // For Control: the switch, and every rung's bots, each with its stake and the end of its wait.
  function view() {
    const t = now();
    const rungs = {};
    for (const g of Object.keys(games)) {
      rungs[g] = {};
      for (const r of RUNGS) rungs[g][String(r)] = { waiting: 0, playing: 0, starting: 0, bots: [] };
    }
    const order = { waiting: 0, starting: 1, playing: 2 };
    for (const s of [...seats.values()].sort((a, b) => (order[a.state] - order[b.state]) || ((a.until || 0) - (b.until || 0)))) {
      const row = rungs[s.game] && rungs[s.game][String(s.rung)];
      if (!row || !(s.state in order)) continue;
      row[s.state]++;
      row.bots.push({ state: s.state, stake: s.rung, name: s.name, until: s.until,
        leftS: s.until ? Math.max(0, Math.round((s.until - t) / 1000)) : null });
    }
    return { enabled, games: Object.keys(games), rungs, max: MAX_WAITING_PER_RUNG, waitS: WAIT / 1000, now: t,
      saved: !!file, recent: recent.slice(-8) };
  }

  /* ── boot: the saved switch, and each saved bot back as a new starting seat with what is left of its wait ── */
  const saved = load();
  if (saved) {
    enabled = saved.enabled === true;
    let back = 0;
    if (enabled && Array.isArray(saved.bots)) {
      const t = now();
      for (const b of saved.bots.slice(0, 100)) {
        if (!b || typeof b !== 'object' || !games[b.game]) continue;
        const rung = rungOf(b.rung);
        if (!rung || countAt(b.game, rung) >= MAX_WAITING_PER_RUNG) continue;
        let until = Number.isSafeInteger(b.until) && b.until > 0 ? b.until : null;
        if (until !== null && until - t < RESTORE_MIN_LEFT_MS) continue;
        if (until !== null && until > t + WAIT) until = t + WAIT;
        const name = typeof b.name === 'string' && b.name.length > 0 && b.name.length <= NAME_MAX ? b.name : null;
        makeSeat(b.game, rung, { name, until, startBy: until !== null ? until - RESTORE_MIN_LEFT_MS : t + RESTORE_START_MS });
        back++;
      }
    }
    if (back) console.log('[DUELBOT] ' + back + ' paid duel bot(s) from before the restart are starting again');
  }

  let timer = null;
  if (tickMs > 0) {
    timer = setInterval(() => { try { tick(); } catch (e) { log.error('[DUELBOT] tick: ' + (e && e.message)); } }, tickMs);
    if (timer.unref) timer.unref();
  }

  return {
    spawn, setCount, lowerTo, setEnabled, settleTable, waitingByRung, view, tick, heldMicro,
    enabled: () => enabled,
    switchSaved: () => !!file && lastSaveOk,
    isPaidBot: (id) => seats.has(id),
    held: () => [...seats.values()].map((s) => Object.assign({}, s)),
    stop() { if (timer) clearInterval(timer); timer = null; },
    BOT_WAIT_MS: WAIT, MAX_WAITING_PER_RUNG, RUNGS,
  };
}

module.exports = { createDuelBots, BOT_WAIT_MS, START_GIVE_UP_MS, RESTORE_MIN_LEFT_MS, TICK_MS, MAX_WAITING_PER_RUNG,
  RUNGS, GAME_NAMES };
