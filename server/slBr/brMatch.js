'use strict';
// The battle royale's match on the sl engine: the old event's state machine (server/BattleRoyaleRoom.js, its rules
// kept line for line, the reasons are written there) driven by the sl room's step instead of GameRoom's tick.
//
//   waiting     the arena is the free room (crowd border, bots fill it, anyone can join)
//   countdown   COUNTDOWN_MS after start: nobody new (no bot fill either), the border held where it is
//   running     the circle (brZone) closes ring by ring; a death is final (no seat while it runs, the owner's too)
//   over        decided: the circle freezes, a human winner gets CASHOUT_DELAY_MS alive, then leaves (cashed out)
//   reopening   the circle travels back out to the arena; then waiting again
//
// Owen's rules (2026-10-16): ONE match at a time: nothing starts one unless the arena is waiting, so while a match
// counts down, runs, or is finishing, the owner's Start and the 8:05 timer are refused. A match may start with only
// bots in the arena (MIN_SNAKES snakes on the map, people or bots). It ends when ONE SNAKE IS LEFT, bots counted: a
// person must outlast every bot to win, and a bot that wins is paid nothing (onDecided is only told of a person).
// The prize rules are unchanged: nothing for a match that started with one person or none (soloRun), and a match whose
// people proved fewer than two different wallets is held for Owen (prizeHeld). A restart cuts a match off: the match
// in flight is written to opts.journal (setLive) at its start and cleared at its decision or stop, so the next boot
// can void it and tell Owen (index.js).
//
// It is also what server/index.js reads as "the battle royale room" when the event runs on this engine (the same
// fields and methods the old room has): state, matchId, winner { id, name, wallet }, soloRun, podium, canStart(),
// startMatch(why), forceStart(why), abandon(), acceptingPlayers(), livingCount(), humanLiving(), publicState(). The
// prize is NOT paid here: onDecided(match) tells the server, whose payBattleRoyaleWinner pays once per match id from
// the wallet the winner's socket proved (never one a client claims).
//
// The room (server/sl/slRoom.js, opts.br) calls: attach(room), noteSeat(snakeId, { wallet, nick }), afterDeaths(frame,
// deaths, simMs) once per step after its deaths, acceptingPlayers() at a seat, allowsHold() at a hold press,
// holdFill() for the bot fill, canPause() before its idle pause, and joinMsg() for a new seat or watcher.
//
// opts.lastStore (brLastPodium.js) keeps the last decided match's podium across restarts: read once here, written at
// each decision, and reported by publicState while waiting until a match in this process is decided. It is for
// showing only: it never sets winner or matchId, which are what the prize is paid from.

const C = require('../../shared/constants');
const { easternNow } = require('../botPopulation');
const { createZone, cruiseOf } = require('./brZone');
const { createHeldBorder } = require('./brBorder');

const SEC = 1000;

const BRM = {
  COUNTDOWN_MS: 10 * SEC, // BattleRoyaleRoom BR.COUNTDOWN_MS
  MIN_SNAKES: 2, // snakes on the map, bots counted, for a start (Owen: "even if it's just bots, start it anyway")
  CASHOUT_DELAY_MS: 5 * SEC, // BR.CASHOUT_DELAY_MS: the winner's moment
  STATE_EVERY_MS: SEC, // the HUD's numbers go to every seat this often (and at every change)
  // A backstop that should never fire: a match still undecided this long after it went live is decided by length
  // (the circle's last ring is RING_MIN_RADIUS, smaller than a snake can turn in, so it always ends well before).
  MAX_MATCH_MS: 15 * 60 * SEC,
};

// Milliseconds until the next scheduled start on the Eastern wall clock (BattleRoyaleRoom msUntilNextStart), to the
// second (the HUD's clock snapped back to :00 at every message). Zones are whole minutes from UTC, so the second is.
function msUntilNextStart(at) {
  const t = at === undefined ? Date.now() : at;
  const { hour, minute } = easternNow(t);
  const second = new Date(t).getSeconds();
  let secs = (C.BR_AUTOSTART_HOUR * 60 + C.BR_AUTOSTART_MIN) * 60 - ((hour * 60 + minute) * 60 + second);
  if (secs < 0) secs += 24 * 3600;
  return secs * SEC;
}

function createBrMatch(opts) {
  const o = opts || {};
  const laws = o.laws;
  if (!laws || !laws.L1 || !laws.L4) throw new TypeError('brMatch: needs the law table');
  const grd = laws.L1.value;
  const log = o.log || console;
  const label = typeof o.label === 'string' ? o.label : 'sl_br';
  const onDecided = typeof o.onDecided === 'function' ? o.onDecided : null;
  const isOwner = typeof o.isOwner === 'function' ? o.isOwner : () => false;
  const zone = createZone({ grd, cruise: cruiseOf(laws), rand: o.rand });
  const wallNow = typeof o.now === 'function' ? o.now : Date.now;
  const lastStore = o.lastStore && typeof o.lastStore.load === 'function' ? o.lastStore : null;
  const journal = o.journal && typeof o.journal.setLive === 'function' ? o.journal : null;
  // told when a running match is cut off by anything but the owner's own stop (a room replacement), to push Owen
  const onVoided = typeof o.onVoided === 'function' ? o.onVoided : null;

  let room = null;
  const who = new Map(); // snake id -> { wallet, nick } of every seated human since it joined
  let lastSent = -Infinity;
  let lastPhase = '';
  let lastRing = 0;
  // the last decided match as publicState reports it (podium, winner's name, prize, soloRun, prizeHeld), from
  // lastStore at boot until a match here is decided
  let last = null;
  if (lastStore) {
    try {
      last = lastStore.load() || null;
    } catch (e) {
      log.warn('[BR] last podium not loaded: ' + (e && e.message));
    }
  }

  const m = {
    engine: 'sl',
    isBattleRoyale: true,
    lobbyType: label,
    state: 'waiting',
    matchId: null,
    countdownUntil: 0, // sim ms
    startedAt: 0, // sim ms
    endedAt: 0,
    cashoutAt: 0,
    winner: null, // { id, name, wallet }
    soloRun: false,
    startedWith: 0,
    startedCount: 0, // snakes alive (bots too) when the match went live: the HUD's "8 of 12 left" (slxBr.js)
    startedPeople: 0,
    prizeHeld: false, // a real match whose players proved fewer than two wallets: no automatic prize (see startMatch)
    podium: null,
    zone,
    makeBorder: createHeldBorder, // slSim opts.makeBorder: the crowd border, held while a match runs
    _fallen: [],
    _prevAlive: null,
    _cashedOut: null,
  };

  const simNow = () => (room ? room.sim.nowMs() : 0);

  // How many different PEOPLE are in the match: distinct wallets their sockets proved. Two tabs (or a script socket)
  // of one person are one person, and a seat with no proven wallet cannot be paid, so it never turns a solo run into
  // a $20 match (review 2026-10-15: the old rule counted snakes).
  function provenPeople(list) {
    const wallets = new Set();
    for (const h of list) {
      const w = who.get(h.id);
      if (w && w.wallet) wallets.add(w.wallet);
    }
    return wallets.size;
  }

  // living human snakes (seated or gliding), as [{ id, name, score }]
  function humanSnakes() {
    const out = [];
    if (!room) return out;
    for (const id of room.humans) {
      const s = room.sim.snake(id);
      if (s) out.push({ id, name: s.nick, score: room._lenOf(s), isBot: false });
    }
    return out;
  }
  function livingSnakes() {
    const out = [];
    if (!room) return out;
    room.sim.forEachSnake((s) => {
      out.push({ id: s.id, name: s.nick, score: room._lenOf(s), isBot: !room.humans.has(s.id) });
    });
    return out;
  }

  function holdBorder(on) {
    const b = room && room.sim.border;
    if (b && typeof b.hold === 'function') b.hold(on);
  }

  function broadcast(simMs) {
    lastSent = simMs;
    if (room) room._messageAll(m.clientMsg(simMs));
  }

  Object.assign(m, {
    attach(r) {
      room = r;
      who.clear(); // a replacement room numbers its snakes from 1 again
      lastSent = -Infinity; // a replacement room's sim clock starts again at 0
      lastPhase = '';
      lastRing = zone.ring();
    },
    noteSeat(snakeId, info) {
      const i = info || {};
      const wallet = typeof i.wallet === 'string' && i.wallet ? i.wallet : null;
      who.set(snakeId, { wallet, nick: i.nick || '', owner: !!wallet && isOwner(wallet) === true });
    },
    livingCount: () => (room ? room.sim.count() : 0),
    humanLiving: () => humanSnakes().length,
    acceptingPlayers: () => m.state === 'waiting',
    // One snake per person (Owen: a death is out for the match): a wallet that already has a living snake here is
    // refused a second seat (slRoom.refusal 'twice'), so a second tab cannot carry on for someone who died.
    walletBusy(wallet) {
      if (!room || typeof wallet !== 'string' || !wallet) return false;
      for (const [id, w] of who) {
        if (w.wallet === wallet && room.humans.has(id) && room.sim.snake(id)) return true;
      }
      return false;
    },
    canStart: () => m.state === 'waiting' && m.livingCount() >= BRM.MIN_SNAKES,
    // Q (leaving with the snake) is refused while the match is being fought (the old cashout:start rule)
    allowsHold: () => m.state !== 'countdown' && m.state !== 'running',
    holdFill: () => m.state !== 'waiting',
    // the room's idle pause would stop the clock mid-match or mid-reopen with nobody able to get in
    canPause: () => m.state === 'waiting',
    // the PRIZE rule (unchanged): a match that started with one person (seat) or none pays nothing
    isSoloRun: () => m.startedWith <= 1,

    startMatch(reason) {
      if (!m.canStart()) return false;
      const now = simNow();
      m.state = 'countdown';
      m.countdownUntil = now + BRM.COUNTDOWN_MS;
      const humans = humanSnakes();
      m.startedWith = humans.length;
      m.startedCount = 0;
      m.startedPeople = provenPeople(humans);
      // Known from the start, so nothing on screen promises a prize that will not be paid. The PRIZE rule counts
      // different PEOPLE: distinct wallets their sockets proved. Two tabs (or a script socket) of one person are one
      // person, so a two-seat match of one wallet is held, not paid (review 2026-10-15), and Owen is told to settle
      // a real match whose players could not all prove a wallet (payBattleRoyaleWinner).
      m.soloRun = m.isSoloRun();
      m.prizeHeld = !m.soloRun && m.startedPeople < 2;
      m._fallen = [];
      m.podium = null;
      m.matchId = 'br_' + wallNow().toString(36);
      m.startedAt = 0;
      m.endedAt = 0;
      m.cashoutAt = 0;
      m.winner = null;
      m._prevAlive = null;
      zone.clear();
      holdBorder(true);
      // A room with nobody in it may be in its idle pause (the 8:05 timer can start a match of bots alone): the match
      // must run to its end with nobody watching, or the arena would sit in 'countdown' with its doors shut.
      if (room && typeof room.start === 'function') room.start();
      broadcast(now);
      if (journal) {
        journal.setLive({ matchId: m.matchId, startedAt: new Date(wallNow()).toISOString(), seats: m.startedWith,
          wallets: m.startedPeople, people: humans.map((h) => (who.get(h.id) || {}).nick || h.name || '') });
      }
      log.log('[BR] ' + label + ' match ' + m.matchId + ' counting down (' + (reason || 'manual') + ') with ' +
        m.livingCount() + ' snakes, ' + m.startedWith + ' people');
      return true;
    },

    // kept for the callers that still ask for it: the minimum is snakes on the map now, so it is a plain start
    forceStart(reason) {
      return m.startMatch(reason || 'forced');
    },

    // why: 'owner' for the owner's own stop (no push); anything else (a room replacement) tells onVoided
    abandon(why) {
      if (m.state === 'waiting') return false;
      const live = m.state === 'countdown' || m.state === 'running';
      const was = { matchId: m.matchId, seats: m.startedWith, wallets: m.startedPeople, why: why || 'abandoned' };
      const now = simNow();
      m.state = 'waiting';
      m.countdownUntil = 0;
      m.cashoutAt = 0;
      m.winner = null;
      m.matchId = null;
      m._prevAlive = null;
      zone.clear();
      holdBorder(false);
      broadcast(now);
      if (live && journal) journal.setLive(null);
      if (live && why !== 'owner') {
        log.warn('[BR] ' + label + ' match ' + was.matchId + ' cut off (' + was.why + '): no winner, no prize');
        if (onVoided) {
          try {
            onVoided(was);
          } catch (e) {
            log.error('[BR] the voided hook threw: ' + (e && e.message));
          }
        }
      }
      return true;
    },

    // once per step, after the step's deaths were handled and before they leave room.humans
    afterDeaths(frame, deaths, simMs) {
      // a person out in the countdown is out of the match too (they were in it when it started); bots are kept as well,
      // for the podium (the last three snakes, people or bots: a bot that outlasted you placed above you)
      if (m.state === 'running' || m.state === 'countdown') {
        for (let i = 0; i < deaths.length; i++) {
          const id = deaths[i].id;
          const w = room.humans.has(id) ? who.get(id) : null;
          const d = deaths[i];
          const score = room._lenOf({ pts: { length: d.sct }, fam: d.fam });
          m._fallen.push({ id, name: (w && w.nick) || room.names.get(id) || '', score });
        }
      }
      let changed = false;
      if (m.state === 'countdown' && simMs >= m.countdownUntil) {
        m.state = 'running';
        m.startedAt = simMs;
        m.startedCount = m.livingCount();
        zone.begin(simMs, room.sim.flux());
        lastRing = zone.ring();
        changed = true;
        log.log('[BR] ' + label + ' match ' + m.matchId + ' is live, arena ' + room.sim.flux());
      } else if (m.state === 'running') {
        if (zone.update(simMs)) changed = true;
        if (m._checkWinner(simMs)) changed = true;
      } else if (m.state === 'over') {
        if (m.cashoutAt && simMs >= m.cashoutAt) {
          m._winnerLeaves(frame, simMs);
          zone.reopen(simMs);
          m.state = 'reopening';
          changed = true;
          log.log('[BR] ' + label + ' match ' + m.matchId + ' closed, arena reopening');
        }
      } else if (m.state === 'reopening') {
        zone.update(simMs);
        if (zone.reopened(simMs)) {
          zone.clear();
          holdBorder(false);
          m.state = 'waiting';
          changed = true;
          log.log('[BR] ' + label + ' arena reopened, waiting for the next match');
        }
      }
      const ph = m.phase(simMs);
      if (ph !== lastPhase || zone.ring() !== lastRing) changed = true;
      lastPhase = ph;
      lastRing = zone.ring();
      if (changed || (m.state !== 'waiting' && simMs - lastSent >= BRM.STATE_EVERY_MS) ||
        (m.state === 'waiting' && simMs - lastSent >= 5 * BRM.STATE_EVERY_MS)) {
        broadcast(simMs);
      }
    },

    // Owen 2026-10-16: the match ends when ONE SNAKE is left, bots counted ("until the circle's closed and killed all
    // of them except for one"). That snake wins; a bot that wins is shown and paid nothing. When the last ones die in
    // the same step, the longest of the step before wins (the old room's tie rule, now over every snake). Returns true
    // when the match was decided this step.
    _checkWinner(simMs) {
      const onMap = livingSnakes();
      const late = simMs - m.startedAt >= BRM.MAX_MATCH_MS;
      if (onMap.length > 1 && !late) {
        m._prevAlive = onMap;
        return false;
      }
      const longest = (list) => list.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;
      let won = null;
      if (onMap.length === 1) won = onMap[0];
      else if (onMap.length > 1) {
        won = longest(onMap);
        log.warn('[BR] ' + label + ' match ' + m.matchId + ' hit the ' + BRM.MAX_MATCH_MS / 60000 + ' min backstop with ' +
          onMap.length + ' snakes left: decided by length');
      } else if (m._prevAlive && m._prevAlive.length) won = longest(m._prevAlive);
      m._prevAlive = onMap;
      m.state = 'over';
      m.endedAt = simMs;
      zone.freeze();
      m.cashoutAt = simMs + BRM.CASHOUT_DELAY_MS;
      if (journal) journal.setLive(null); // decided: from here a restart is the prize journal's business, not a void
      const bot = !!won && won.isBot === true;
      const w = won && !bot ? who.get(won.id) : null;
      m.winner = won ? { id: won.id, name: (w && w.nick) || won.name, wallet: (w && w.wallet) || null, bot } : null;
      const order = m._fallen.slice().reverse();
      const podium = [];
      if (won) podium.push({ place: 1, name: m.winner.name, score: won.score || 0 });
      for (const f of order) {
        if (podium.length >= 3) break;
        if (won && f.id === won.id) continue;
        podium.push({ place: podium.length + 1, name: f.name, score: f.score || 0 });
      }
      m.podium = podium;
      m.soloRun = m.isSoloRun();
      m._keepPodium();
      log.log('[BR] ' + label + ' match ' + m.matchId + (m.soloRun ? ' (solo test run, no prize)' : '') + ' won by ' +
        (m.winner ? m.winner.name : 'nobody') + ' after ' + Math.round((m.endedAt - m.startedAt) / 1000) + 's');
      if (onDecided && m.winner && !m.winner.bot) {
        try {
          onDecided(m);
        } catch (e) {
          log.error('[BR] the decided hook threw: ' + (e && e.message));
        }
      }
      return true;
    },

    // the decided match as the Events tab shows it, saved so a restart or a deploy does not empty its podium
    _keepPodium() {
      const s = m.publicState();
      last = { podium: s.podium, winner: s.winner ? s.winner.name : null, prize: s.prize, soloRun: s.soloRun,
        prizeHeld: s.prizeHeld, endedAt: new Date(wallNow()).toISOString() };
      if (!lastStore) return;
      try {
        lastStore.save(last);
      } catch (e) {
        log.warn('[BR] last podium not saved: ' + (e && e.message));
      }
    },

    // the winner's five seconds are up: their snake leaves the arena as a hold-Q cash-out does (no food, the card)
    _winnerLeaves(frame, simMs) {
      if (m._cashedOut === m.matchId) return;
      m._cashedOut = m.matchId;
      if (m.winner && !m.winner.bot && room.sim.snake(m.winner.id)) room._cashOut(m.winner.id, frame, simMs);
    },

    phase(simMs) {
      if (m.state === 'countdown') return 'countdown';
      if (m.state !== 'running') return m.state;
      const p = zone.phase(simMs === undefined ? simNow() : simMs);
      return p === 'open' ? 'warning' : p;
    },

    // the old room's publicState, field for field (the Events tab, /api/live, the owner console read it)
    publicState() {
      const now = simNow();
      // nothing decided in this process since boot (or the match since was abandoned): the last saved match's podium,
      // winner and prize, its winner with no snake id (a new snake of the same number is not them: slxBr's "You won")
      const past = m.state === 'waiting' && !m.podium ? last : null;
      return {
        engine: 'sl',
        state: m.state,
        countdownMs: m.state === 'countdown' ? Math.max(0, m.countdownUntil - now) : 0,
        matchId: m.matchId,
        alive: m.livingCount(),
        players: m.livingCount(),
        humans: m.humanLiving(),
        minPlayers: BRM.MIN_SNAKES,
        canStart: m.canStart(),
        elapsedMs: m.state === 'running' ? now - m.startedAt : 0,
        ring: zone.ring(),
        zoneMs: m.state === 'running' ? zone.zoneMs(now) : 0,
        // until the circle is fully closed: the latest this match can last (the Events tab's "Ends in")
        endsMs: m.state === 'running' ? zone.closesInMs(now) : 0,
        phase: m.phase(now),
        soloRun: past ? past.soloRun : !!m.soloRun,
        startedWith: m.startedWith || 0,
        startedCount: m.state === 'waiting' ? 0 : m.startedCount || 0,
        cashoutMs: m.state === 'over' ? Math.max(0, m.cashoutAt - now) : 0,
        cashoutTotalMs: BRM.CASHOUT_DELAY_MS,
        nextStartMs: msUntilNextStart(wallNow()),
        reopenPct: m.state === 'reopening' && zone.get() ? Math.max(0, Math.min(1, zone.get().r / zone.arena())) : 0,
        winner: past ? (past.winner ? { name: past.winner, id: null } : null)
          : m.winner ? { name: m.winner.name, id: m.winner.id, bot: !!m.winner.bot } : null,
        podium: past ? past.podium : m.podium || null,
        prize: past ? past.prize : m.soloRun || m.prizeHeld || (m.winner && m.winner.bot) ? 0 : C.BR_PRIZE_USDC,
        prizeHeld: past ? past.prizeHeld : !!m.prizeHeld,
      };
    },

    // sl:x {t: 'br'}: the public state plus the circle for the overlay (slxBr.js)
    clientMsg(simMs) {
      const s = m.publicState();
      s.t = 'br';
      s.z = zone.desc(simMs === undefined ? simNow() : simMs);
      return s;
    },
    // a new seat's first {t: 'br'}; the owner's (proven wallet) also says owner, which draws their Start button
    // (the button's action still needs the owner's signature at /api/owner/do)
    joinMsg(snakeId) {
      const msg = m.clientMsg();
      const w = snakeId === undefined ? null : who.get(snakeId);
      if (w && w.owner) msg.owner = true;
      return msg;
    },
  });
  return m;
}

module.exports = { BRM, createBrMatch, msUntilNextStart };
