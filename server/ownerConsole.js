'use strict';
/* ─── What the owner console shows, and the one bot control that holds ───────
   server/index.js owns the routes (/api/owner/state, /api/owner/do) and knows
   where every room lives; this file turns those rooms into the console's state
   (state v2: one row per game and rung, the battle royale, the audit) and runs
   bots:set, bots:add and bots:clear. Nothing here moves money or reads a client's number for money: it
   counts what the rooms already hold, so it can be tested with plain objects.

   The rule the rows follow: a row is a place a player can actually be sent.
   The old snake tiers and the old free rung are only a fallback while the new
   engine is live, so they are not rows of their own; a stale tab that is still
   in one is counted in its rung (people and money), never hidden, because a
   person with a stake in a room nobody lists is exactly what the console is for. */

const { LADDER } = require('../shared/stakeLadder');

const PAID_BOTS_NOTE = 'Paid duels stay people only: a bot would win or lose a real stake';
const BOT_SET_MAX = 200;
const PAPER_TRIES = 40;   // spawn misses in a row before a Paper arena counts as full (addUpTo)
const r6 = (v) => Math.round(v * 1e6) / 1e6;

/* A room's rung. The agar, Paper and old snake rooms carry it as `stake`; a
   paid sl room keeps it on its money controller. */
function roomStake(r) {
  if (!r) return 0;
  const s = Number(r.stake);
  if (Number.isFinite(s) && s > 0) return s;
  const m = r.money && Number(r.money.stake);
  return Number.isFinite(m) && m > 0 ? m : 0;
}

/* People in a room: every open account in a paid room (away and parked ones
   included, they still have a stake), else the room's own human count. */
function roomPeople(r) {
  if (!r) return 0;
  if (r.money && typeof r.money.openCount === 'function') return r.money.openCount() || 0;
  if (Number.isFinite(r.liveHumans)) return r.liveHumans;
  return Number.isFinite(r.playerCount) ? r.playerCount : 0;
}

/* Money in a room, in dollars: every live account plus what lies on its floor.
   A room with a bank says so itself (liveStakeTotal, the solvency sum's own
   number); the old snake rooms only have their snakes' worth. */
function roomMoney(r) {
  if (!r) return 0;
  if (typeof r.liveStakeTotal === 'function') {
    const v = Number(r.liveStakeTotal());
    return Number.isFinite(v) && v > 0 ? v : 0;
  }
  let n = 0;
  if (r.snakes && typeof r.snakes.values === 'function') {
    for (const s of r.snakes.values()) if (s && s.alive && !s.isBot && s.worth > 0) n += s.worth;
  }
  if (r.floorWorth > 0) n += r.floorWorth;
  return n;
}

const botDriver = (r) => (r && r.bots && typeof r.bots.count === 'function' ? r.bots : null);

/* The number bots:set is holding this room at, or null for its automatic
   fill. Asked of whatever is doing the holding: the slither driver, Paper's
   arena, or the hold this file put on the room itself. */
function roomBotTarget(r) {
  if (!r) return null;
  const d = botDriver(r);
  if (d && typeof d.target === 'function') {
    const t = d.target(r);
    if (Number.isInteger(t)) return t;
  }
  if (r.game && typeof r.game.setBotCap === 'function') {
    return Number.isInteger(r.game.botCap) ? r.game.botCap : null;
  }
  return Number.isInteger(r._botsHeld) ? r._botsHeld : null;
}

/* What a free room's automatic fill is aiming at by the clock (the daily
   curve, server/botPopulation.js), or null for a room without one. Shown
   beside the live count; a number set in Control overrides it until Auto. */
function roomBotAim(r) {
  const f = r && (typeof r.botCurve === 'function' ? r.botCurve
    : r.game && typeof r.game.botCurve === 'function' ? r.game.botCurve : null);
  if (!f) return null;
  const n = f();
  return Number.isInteger(n) ? n : null;
}

const takesBots = (r) => !!r && typeof r.botsAllowed === 'function' && r.botsAllowed() === true
  && typeof r.addBot === 'function' && roomStake(r) === 0;

/* One game's rows, one per rung of the ladder, always all three: a paid rung
   with no room open yet is a row with room null and nobody in it, so the
   console can show the door for it.
   rooms:  the rooms players are sent to (the first of a rung is the one the
           bot controls act on);
   extra:  fallback rooms nobody is sent to on purpose, counted only while
           somebody or some money is in one;
   stakeOf: a room's rung when the room cannot say (the old snake tiers name
           their price only in their lobby type), roomStake by default. */
function rungRows(rooms, extra, stakeOf) {
  const rungOf = typeof stakeOf === 'function' ? stakeOf : roomStake;
  const list = (rooms || []).filter(Boolean);
  const stale = (extra || []).filter((r) => r && !list.includes(r) && (roomPeople(r) > 0 || roomMoney(r) > 0));
  return LADDER.map((rung) => {
    const at = (r) => rungOf(r) === rung;
    const mine = list.filter(at).sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
    const more = stale.filter(at);
    const main = mine[0] || null;
    let people = 0, bots = 0, money = 0;
    for (const r of mine) { people += roomPeople(r); bots += Number(r.botCount) || 0; money += roomMoney(r); }
    for (const r of more) { people += roomPeople(r); money += roomMoney(r); }
    const allowed = rung === 0 && takesBots(main);
    return {
      rung,
      room: main ? String(main.lobbyType) : null,
      people,
      bots,
      money: r6(money),
      botTarget: main ? roomBotTarget(main) : null,
      botAim: main ? roomBotAim(main) : null,
      botsAllowed: allowed,
      botsNote: rung > 0 ? PAID_BOTS_NOTE : allowed ? null : main ? 'This room does not take bots' : 'No room is open',
    };
  });
}

/* A duel's rows, read only: who is queued or seated per rung, the free
   tables a bot is playing at, and the stakes queued or at a table (ops.duelStatus,
   the same numbers the restart check counts). There is no room to send bots
   to: a free table gets its bot by itself after a short wait alone. */
function duelRows(status) {
  const rungs = (status && status.rungs) || {};
  return LADDER.map((rung) => {
    const row = rungs[String(rung)] || { people: 0, bots: 0, money: 0 };
    return {
      rung,
      room: null,
      people: row.people || 0,
      bots: rung === 0 ? row.bots || 0 : 0,
      money: r6(row.money || 0),
      botTarget: null,
      botsAllowed: false,
      botsNote: rung > 0 ? PAID_BOTS_NOTE : 'A bot takes the other seat when nobody joins in time',
    };
  });
}

/* A paid door's readout. `action` is what the console sends with ':on' or
   ':off' after it. */
function paidDoor(d, saved, action) {
  if (!d) return null;
  return { enabled: !!d.enabled, open: !!d.open, stopping: !!d.stopping, saved: !!saved, action };
}

/* The battle royale, in people rather than bodies. `humans` is the people in
   the arena (the room fills with bots between matches, so `alive` alone read
   as "22 waiting" for a room nobody was in); bots are the rest of the bodies.
   canForce is the honest form of the Start alone button: the battle royale
   starts with bots alone now (Owen 2026-10-16, ownerStartBr in index.js), so it
   is offered whenever the arena is waiting with any snake in it.
   The room's own public state is kept underneath for anything still reading
   the old fields. */
function brState(br, { engine, room, now }) {
  if (!br) return null;
  const st = typeof br.publicState === 'function' ? br.publicState() || {} : {};
  const humans = Number.isFinite(st.humans) ? st.humans
    : typeof br.humanLiving === 'function' ? br.humanLiving() : 0;
  const alive = Number.isFinite(st.alive) ? st.alive : typeof br.livingCount === 'function' ? br.livingCount() : 0;
  const t = typeof now === 'number' ? now : Date.now();
  return Object.assign({}, st, {
    state: st.state || br.state || null,
    phase: st.phase || null,
    humans,
    alive,
    bots: Math.max(0, alive - humans),
    minPlayers: Number.isFinite(st.minPlayers) ? st.minPlayers : null,
    canStart: !!st.canStart,
    canForce: (st.state || br.state) === 'waiting' && alive >= 1,
    countdownMs: Number(st.countdownMs) || 0,
    nextStartAt: Number.isFinite(st.nextStartMs) ? t + st.nextStartMs : null,
    prize: Number.isFinite(st.prize) ? st.prize : 0,
    prizeHeld: !!st.prizeHeld,
    engine: engine || st.engine || null,
    room: room ? String(room.lobbyType) : null,
    botTarget: room ? roomBotTarget(room) : null,
    winner: st.winner || null,
  });
}

/* The console's audit, newest first: its own actions (ops.auditLog, with who
   and what was asked) and the other owner-signed lines that share
   ownerAuth's log (the Clips queue's decisions), merged by time. */
function mergeAudit(a, b, n) {
  return [...(a || []), ...(b || [])]
    .filter(Boolean)
    .sort((x, y) => (Number(y.at) || 0) - (Number(x.at) || 0))
    .slice(0, n || 50);
}

/* An announcement as it may be shown: plain text, one line, 200 characters at
   most. Control characters, bidi overrides and zero-width characters go (they
   can make one message read as another), and so do angle brackets, so it stays
   inert even on a page that would ever put it into HTML. Every page that shows
   it today writes it as text. */
function cleanAnnounce(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
    .trim();
}

/* The battle royale's match, if this room is the event's arena. */
const matchOf = (room) => (room && room.br && typeof room.br === 'object' ? room.br
  : room && room.isBattleRoyale ? room : null);

function clearAll(room) {
  if (typeof room.clearBots === 'function') return room.clearBots();
  /* The old snake rooms have no clearBots: their bots are snakes in the map,
     taken out exactly as the console's Clear always did. */
  if (room.snakes && typeof room.snakes.delete === 'function') {
    for (const [id, s] of [...room.snakes]) if (s && s.isBot) room.snakes.delete(id);
  }
  return undefined;
}

/* Adds until the room has n, or it refuses a few times running: a room at its
   own limit refuses every time, while Paper's spawn draws a random spot and
   misses now and then on a busy map (measured: 4 tries in a row fell short
   about one time in six), so it is given more tries. */
function addUpTo(room, n, mark, tries) {
  const most = Number.isInteger(tries) && tries > 0 ? tries : 4;
  let misses = 0;
  for (let i = 0; i < BOT_SET_MAX * 4 && misses < most && (Number(room.botCount) || 0) < n; i++) {
    const b = room.addBot();
    if (!b) { misses++; continue; }
    misses = 0;
    if (mark && typeof b === 'object') b._manual = b.manual = true;
  }
}

/* bots:set. An exact number of live bots in one free room, held until it is
   changed, or { auto: true } to hand the room back to its own fill.

   Each kind of room is held by the thing that already fills it:
   - slither (the new engine's free room and the event's arena): its bot
     driver holds the number (setTarget) when it can, and takes the surplus out
     now (removeBots); a driver without those falls back to the hold below;
   - Paper: the arena's own bot cap (ArenaGame.setBotCap), read where it sets
     its square count every tick, so a dead bot is replaced and no more;
   - everything else (agar.io's free room, the old snake rooms, slither on a
     driver without setTarget): the fill paused for good, the room emptied,
     then that many bots added by hand. agar.io's fill leaves hand-made bots
     alone and a paused fill adds none, so the number stays put.
   Paid rooms refuse, before anything is touched. The event's arena refuses
   while a match is on: its bots are the field, and the fill is frozen then.

   -> { ok: true, live, held, asked, auto } or { ok: false, why } */
function setBots(room, args) {
  const a = args && typeof args === 'object' ? args : {};
  if (!room) return { ok: false, why: 'No room called ' + String(a.room).slice(0, 60) };
  if (roomStake(room) > 0 || typeof room.botsAllowed !== 'function' || room.botsAllowed() !== true) {
    return { ok: false, why: PAID_BOTS_NOTE, paid: true };
  }
  if (typeof room.addBot !== 'function') return { ok: false, why: 'That room does not take bots' };
  const match = matchOf(room);
  if (match && match.state && match.state !== 'waiting') {
    return { ok: false, why: 'A match is under way; the arena\'s bots change between matches' };
  }
  const auto = a.auto === true;
  let n = null;
  if (!auto) {
    const raw = typeof a.count === 'number' ? a.count
      : typeof a.count === 'string' && /^\d{1,3}$/.test(a.count.trim()) ? Number(a.count.trim()) : NaN;
    if (!Number.isInteger(raw) || raw < 0 || raw > BOT_SET_MAX) {
      return { ok: false, why: 'Bots: a whole number from 0 to ' + BOT_SET_MAX };
    }
    n = raw;
  }

  const driver = botDriver(room);
  if (driver && typeof driver.setTarget === 'function') {
    room._botsPausedUntil = 0;          // a Clear's window would otherwise read as a target of 0
    room._botsHeld = null;
    driver.setTarget(room, auto ? null : n);
    if (!auto) {
      const have = Number(room.botCount) || 0;
      if (have > n && typeof driver.removeBots === 'function') driver.removeBots(room, have - n);
      else if (have < n) addUpTo(room, n, false);
    }
  } else if (room.game && typeof room.game.setBotCap === 'function') {
    room._botsHeld = null;
    const cap = room.game.setBotCap(auto ? null : n);
    if (auto) {
      addUpTo(room, BOT_SET_MAX, false, PAPER_TRIES);  // back to its own count now, not at the next tick
    } else {
      const goal = Number.isInteger(cap) ? cap : n;
      while ((Number(room.botCount) || 0) > goal && typeof room.game.removeLowestBot === 'function'
        && room.game.removeLowestBot()) { /* the lowest ranked first, as a joining human evicts */ }
      addUpTo(room, goal, false, PAPER_TRIES);
    }
  } else if (auto) {
    room._botsPausedUntil = 0;
    /* The held bots were made by hand, and a fill never takes those out, so a
       room handed back with them still in would be its own number plus the
       held ones. They go, and the fill brings its own. */
    if (Number.isInteger(room._botsHeld)) clearAll(room);
    room._botsHeld = null;
    if (typeof room.fillBots === 'function') room.fillBots();
  } else {
    /* Number.MAX_SAFE_INTEGER, not Infinity: the fills test the pause as a
       finite number, and Infinity would read as no pause at all. */
    room._botsPausedUntil = Number.MAX_SAFE_INTEGER;
    clearAll(room);
    addUpTo(room, n, true);
    room._botsHeld = n;
  }
  return { ok: true, live: Number(room.botCount) || 0, held: auto ? null : roomBotTarget(room), asked: n, auto };
}

/* bots:add and bots:clear on one room (the console's +N and Clear): the room
   logic only. server/index.js finds the room, tells the lobby and words the
   answer; the slither process of the server split runs the same function on its
   own rooms and sends the result back. { now, pauseMs }: the clock and the
   Clear window (index.js BOTS_PAUSE_MS).
   -> { ok: true, made } (add), { ok: true, removed, paper } (clear), or
      { ok: false, why } refused before any bot moved, or
      { ok: false, made: 0, why } when the room took none of them (the hold was
      let go and its pause lifted, so the caller still tells the lobby). */
function botsAddClear(room, action, args, { now, pauseMs }) {
  const a = args && typeof args === 'object' ? args : {};
  if (!room) return { ok: false, why: 'No room called ' + a.room };
  /* A paid room's bots go only through its rung's held count (bots:set paidbots:...). */
  if (room.money || room.paid === true) return { ok: false, why: 'Set paid bots on the room row in the sheet' };
  /* These two manage the room their own way, so a number bots:set was
     holding is let go first rather than left to fight them. */
  releaseHold(room);
  if (action === 'bots:clear') {
    let removed = 0;
    if (typeof room.clearBots === 'function') {
      /* Counted when the room does not say: PaperRoom.clearBots returns
         nothing, and the console reported 'Removed undefined'. */
      const before = room.botCount;
      const n = room.clearBots();
      removed = typeof n === 'number' ? n : Math.max(0, (before || 0) - (room.botCount || 0));
    } else if (room.snakes) {
      for (const [id, s] of [...room.snakes]) {
        if (s && s.isBot) { room.snakes.delete(id); removed++; }
      }
    }
    /* AND THEY STAY GONE. The automatic top-up runs once a second, so
       clearing a room used to last about one second: the ops log shows four
       clears in two minutes, each reporting success, because each one really
       did remove them and the next tick really did put them back. The button
       is for taking the bots off to see what the game costs without them, and
       it could not do that.

       A window rather than a switch: a room cannot be left permanently empty
       by a click somebody forgot about, and the console says how long it has.
       Adding bots by hand lifts it immediately. Paper has no such window: the
       free arena tops its own bots back up within seconds, and a paid one never
       has any, so the console says that instead of promising a pause. */
    const paper = String(room.lobbyType).startsWith('paper_');
    if (!paper) room._botsPausedUntil = now + pauseMs;
    return { ok: true, removed, paper };
  }
  /* By hand means by hand. The automatic floor is a floor, not a ceiling,
     and an owner asking for a hundred bots to test something with should get
     a hundred. The only thing that still refuses is a room that takes a
     stake, and that one is not negotiable. */
  const n = Math.min(Math.max(1, parseInt(a.count, 10) || 1), 500);
  if (!room.addBot) return { ok: false, why: 'That room does not take bots' };
  /* COUNTED, not assumed. addBot returns null when it refuses, and this
     reported 'Added 3' for three refusals: a console that lies about what it
     just did is worse than one that fails out loud. Asking for bots lifts a
     Clear. Otherwise +5 during a pause would look exactly as broken as Clear
     did, in the other direction. */
  room._botsPausedUntil = 0;
  let made = 0;
  for (let i = 0; i < n; i++) {
    const b = room.addBot();
    if (!b) continue;
    /* Marked by hand, so the room's own top-up leaves it alone. Asking for
       twenty and getting eight because the floor is eight would make this
       control useless for the thing it is for, which is testing. */
    if (typeof b === 'object') b._manual = b.manual = true;
    made++;
  }
  if (!made) return { ok: false, made, why: 'That room would not take any bots' };
  return { ok: true, made };
}

/* Any hold on a room let go, for the older bots:add and bots:clear, which
   manage the room their own way and would otherwise fight a held number. */
function releaseHold(room) {
  if (!room) return;
  const driver = botDriver(room);
  if (driver && typeof driver.setTarget === 'function' && typeof driver.target === 'function'
    && Number.isInteger(driver.target(room))) driver.setTarget(room, null);
  if (room.game && typeof room.game.setBotCap === 'function' && Number.isInteger(room.game.botCap)) {
    room.game.setBotCap(null);
  }
  room._botsHeld = null;
}

module.exports = {
  PAID_BOTS_NOTE, BOT_SET_MAX,
  roomStake, roomPeople, roomMoney, roomBotTarget,
  rungRows, duelRows, paidDoor, brState, mergeAudit, cleanAnnounce, setBots, releaseHold, botsAddClear,
};
