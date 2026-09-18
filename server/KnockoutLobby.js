'use strict';
/* ─── Getting two players onto a disc ─────────────────────────────────────────
   A queue, the rooms it makes, and an opponent for when nobody else is here.

   THE BOT IS NOT A PLACEHOLDER, and it is named as one on screen. This game has
   no players yet; a queue that can only ever spin is a mode nobody gets to try,
   which is how a new game dies before anyone sees it. So after a few seconds
   alone you are matched with one, and it plays the game properly rather than
   feeding you wins.

   How it plays is the interesting part, and it is constrained by the mode
   itself: it commits blind, at the same moment you do, and it cannot see your
   arrows any more than you can see its. So it cannot aim at where you will be.
   It aims at where you ARE, picks the target that is most worth hitting, and
   misses often enough to be worth beating. Which is what a person does. */

const { KnockoutRoom, KO } = require('./KnockoutRoom');

/* HOW LONG A REAL PERSON GETS TO TURN UP.

   Six seconds, which is what this was, sounds like plenty and is not. Owen and
   a friend pressed Play "at the same time" and both ended up against bots:
   between opening the page, the socket connecting and the widget settling,
   two people clicking together land in the queue several seconds apart, and
   whoever got there first was already in a bot match before the second arrived.

   Fifteen is long enough for two people coordinating over a phone call and
   still short enough that somebody alone is not left staring. It matters less
   than it looks, because a second person arriving inside the first minute now
   pulls the first out of their bot match anyway — see rescueFromBot. */
const BOT_AFTER_MS = 15000;        // how long you wait before one turns up on a FREE table

/* PAID TABLES NEVER GET A BOT.

   The bot has no wallet and stakes nothing. Put a dollar in against it and
   either you win a dollar out of escrow that nobody paid in, or you lose a
   dollar to a machine. There is no version of that which is a game, and the
   second one is the house booking a wager, which is a different and licensed
   business. So a paid seat waits for a person.

   And it does not wait for ever. Nobody is going to sit in front of a spinner
   indefinitely, and a stake that has already settled on-chain cannot just be
   forgotten, so after this long the seat is given up and the money goes back. */
const PAID_WAIT_MS = 60000;

/* HOW FAR THIS PIECE CAN GO BEFORE THE EDGE, along the line it is about to be
   fired down. Ray against circle, solved for the positive root.

   This exists because the first bot did not have it, and measured, 87% of every
   piece lost in a bot-vs-bot match was a piece that had fired ITSELF off the
   disc — against zero knocked off by an opponent. It was not playing the game,
   it was falling over, and a player would have won every match without aiming. */
function rimDistance(px, py, ux, uy, R) {
  const b = px * ux + py * uy;
  const c = px * px + py * py - R * R;
  const disc = b * b - c;
  if (disc <= 0) return 0;
  return Math.max(0, -b + Math.sqrt(disc));
}

/* The pull that carries a piece exactly `dist` and no further. Travel under
   exponential drag settles at v/DRAG, so this inverts that. */
function pullForTravel(dist) {
  const speed = Math.max(0, dist) * KO.DRAG_PER_S;
  return KO.MAX_PULL * Math.min(1, speed / KO.MAX_SPEED);
}
const BOT_NAMES = ['Sergeant Bot', 'Bishop', 'Cinder', 'Tally', 'Nine'];

class KnockoutLobby {
  constructor(io) {
    this.io = io;
    this.queue = [];              // [{ socket, name, wallet, since }]
    this.rooms = new Map();       // roomId -> KnockoutRoom
    this.bySocket = new Map();    // socketId -> roomId
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 200);
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /* ── the queue ──────────────────────────────────────────────────────────── */

  /* `worth` is what the SERVER recorded this player staking, already taken out
     of a one-time entry token by the caller. Zero means a free seat. */
  /* `now` is only for tests, and it is the same seam tick() already has.

     Without it a test has to say `tick(Date.now() + PAID_WAIT_MS - 1)`, which
     reads the clock a SECOND time: the gap between enqueue stamping `since` and
     that line running is added to the wait, so on a loaded machine a seat one
     millisecond short of giving up had already given up. That is a test failing
     for a reason that has nothing to do with the thing it is testing, and it
     was doing it in the middle of the pre-deploy run. */
  enqueue(socket, name, wallet, stake, worth, now) {
    this.dequeue(socket.id);
    this.queue.push({
      socket, name, wallet, since: typeof now === 'number' ? now : Date.now(),
      stake: Number(stake) > 0 ? Number(stake) : 0,
      worth: Number(worth) > 0 ? Number(worth) : 0,
    });
    this.pump(typeof now === 'number' ? now : undefined);
    /* Still waiting after that? Somebody may be in a bot match that has only
       just started, and two people beats two bots. */
    const mine = this.queue.find(e => e.socket.id === socket.id);
    if (mine) {
      const freed = this.rescueFromBot(mine);
      if (freed) {
        this.dequeue(socket.id);
        this.makeMatch([freed, mine], false, now);
      }
    }
    return this.queue.some(e => e.socket.id === socket.id);
  }

  dequeue(socketId) {
    const before = this.queue.length;
    this.queue = this.queue.filter(e => e.socket.id !== socketId);
    return this.queue.length !== before;
  }

  queuedFor(socketId) {
    const e = this.queue.find(q => q.socket.id === socketId);
    return e ? Date.now() - e.since : null;
  }

  /* Two waiting AT THE SAME BUY-IN? Put them on a disc.

     Matched by rung rather than by who is next, because a table where the two
     seats paid different amounts has no honest way to split the pot. A real
     opponent always beats a bot, so this runs before the timer that hands one
     out. */
  pump(now) {
    const byStake = new Map();
    for (const e of this.queue) {
      const k = String(e.stake || 0);
      if (!byStake.has(k)) byStake.set(k, []);
      byStake.get(k).push(e);
    }
    for (const group of byStake.values()) {
      while (group.length >= 2) {
        const a = group.shift(), b = group.shift();
        this.dequeue(a.socket.id); this.dequeue(b.socket.id);
        this.makeMatch([a, b], false, now);
      }
    }
  }

  tick(now) {
    const t = typeof now === 'number' ? now : Date.now();
    /* PAIR PEOPLE FIRST, EVERY TICK. The loop below hands out one bot per
       waiting seat, so two people who were both in the queue when the timer
       came round got a bot each instead of getting each other. pump() only ran
       on enqueue, which is exactly the moment the second of them was not there
       yet. */
    this.pump(t);
    for (const e of [...this.queue]) {
      /* A paid seat waits for a person, and then gives up and gets its money
         back. A free one gets a bot, because there is nothing to lose. */
      if (e.stake > 0) {
        if (t - e.since < PAID_WAIT_MS) continue;
        this.dequeue(e.socket.id);
        this.refund(e, 'nobody joined that table');
        continue;
      }
      if (t - e.since < BOT_AFTER_MS) continue;
      this.dequeue(e.socket.id);
      this.makeMatch([e], true, t);
    }
    for (const room of [...this.rooms.values()]) {
      /* Aim BEFORE the clock is advanced, so the bot's arrows are in before the
         tick that resolves them. The other order has it miss a turn every time
         a match is decided on the buzzer. */
      this.botAim(room, t);
      room.tick(t);
      if (room.state === 'over') this.sweep(room);
    }
  }

  /* SOMEBODY WAITING BEATS A BOT, EVEN A LITTLE LATE.

     With two people on the whole game, the common case is a friend arriving
     twenty seconds after you did — by which time you are in a bot match and
     they get one of their own, and the two of you sit in separate rooms playing
     machines. So a human joining the queue looks for another human in a bot
     match that has barely begun, dissolves it, and takes them along.

     Only while it has barely begun. Pulling somebody out of a match they are
     three turns into is worse than the problem: they lose a position they have
     been working on, to be handed an opponent they did not ask for. */
  rescueFromBot(entry) {
    if (!entry || entry.stake > 0) return null;        // paid tables never had a bot
    for (const room of this.rooms.values()) {
      if (!room.bot) continue;
      if (room.stake > 0) continue;
      const early = room.state === 'countdown'
      || (room.state === 'aiming' && (room.turn || 0) <= 1);
      if (!early) continue;
      const human = [...room.players.keys()].find(id => !String(id).startsWith('bot_'));
      if (!human || human === entry.socket.id) continue;
      const seat = room.players.get(human);
      if (!seat || !seat.socket) continue;

      /* Take the room away without finishing it: finish() would broadcast a
         result for a match that is not over and did not happen. */
      this.rooms.delete(room.id);
      for (const [sid, rid] of [...this.bySocket]) {
        if (rid === room.id) this.bySocket.delete(sid);
      }
      console.log('[KO] pairing ' + seat.name + ' with ' + entry.name
        + ' instead of a bot');
      return { socket: seat.socket, name: seat.name, wallet: seat.wallet,
               since: Date.now(), stake: 0, worth: 0 };
    }
    return null;
  }

  makeMatch(entries, withBot, now) {
    const room = new KnockoutRoom(this.io);
    room.stake = entries.length ? (entries[0].stake || 0) : 0;
    room.onSettled = this.onSettled || null;
    for (const e of entries) {
      room.addPlayer(e.socket, e.name, e.wallet, e.worth);
      this.bySocket.set(e.socket.id, room.id);
      e.socket._koRoom = room.id;
    }
    /* Belt and braces over the rule above: a paid room can never be given a
       bot, whatever the caller asked for. This is the one line standing between
       a real stake and an opponent that cannot cover it. */
    if (withBot && room.stake > 0) withBot = false;
    if (withBot) {
      /* A stand-in socket. It joins nothing and receives nothing: the room only
         ever calls .id and .join on it, and a bot has no client to send to. */
      const botSocket = { id: 'bot_' + room.id, join() {}, emit() {} };
      const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
      room.addPlayer(botSocket, name, null);
      room.bot = { id: botSocket.id, aimedTurn: 0 };
    }
    this.rooms.set(room.id, room);
    /* THE ROOM'S CLOCK MUST BE THE LOBBY'S CLOCK.

       This read Date.now() while the lobby around it was running on whatever
       time tick() was handed, so a test driving a synthetic timeline got a room
       stamped with the real one and the two drifted by however long the gap
       between the two reads was.

       It survived only because BOT_AFTER_MS happens to be 15 seconds, which is
       how big a stall it took to break: measured, the countdown assertion flips
       at 15009 ms. That margin is an accident of a constant that used to be
       6000 and could be lowered again, and at a few hundred milliseconds it
       would sit inside stalls that really do happen. */
    room.start(typeof now === 'number' ? now : Date.now());
    return room;
  }

  /* Handing a stake back, once. Whoever set onRefund owns actually moving it;
     this only says who is owed what and why, which keeps every path that moves
     money in one file. */
  refund(entry, why) {
    if (!entry || entry.refunded) return;
    entry.refunded = true;
    try { entry.socket.emit('ko:unqueued', { refunded: entry.worth > 0, why: why || '' }); }
    catch (_) {}
    if (entry.worth > 0 && typeof this.onRefund === 'function') {
      try {
        this.onRefund({ wallet: entry.wallet, name: entry.name, amount: entry.worth, why: why || '' });
      } catch (e) { console.error('[KO] refund hook failed:', e.message); }
    }
  }

  roomOf(socketId) {
    const id = this.bySocket.get(socketId);
    return id ? this.rooms.get(id) : null;
  }

  leave(socketId) {
    const room = this.roomOf(socketId);
    /* Backing out of a PAID queue is a refund, not just a dequeue. The stake
       has already settled on-chain by the time they are standing in it. */
    const waiting = this.queue.find(e => e.socket.id === socketId);
    if (waiting) this.refund(waiting, 'left the queue');
    this.dequeue(socketId);
    if (!room) return;
    room.removePlayer(socketId);
    this.bySocket.delete(socketId);
    this.sweep(room);
  }

  /* A finished or emptied room is dropped, along with the seat reservations
     pointing at it. Without this the map grows for the life of the process and
     a player who finishes a match can never be matched into a new one. */
  sweep(room) {
    const humans = [...room.players.keys()].filter(id => !String(id).startsWith('bot_'));
    if (humans.length && room.state !== 'over') return;
    for (const [sid, rid] of [...this.bySocket]) {
      if (rid === room.id) this.bySocket.delete(sid);
    }
    this.rooms.delete(room.id);
  }

  /* ── the opponent ───────────────────────────────────────────────────────── */

  /* One commitment per turn, made once and then left alone.

     It cannot read your arrows, so it plays the board in front of it: for each
     of its pieces it finds the opponent piece that is cheapest to remove, aims
     THROUGH it at the nearest edge, and throws in enough error to be beatable.
     If one of its own pieces is in real danger it spends that piece's turn
     getting back toward the middle instead, which is the same decision a person
     makes and the reason it does not simply trade itself away. */
  botAim(room, now) {
    if (!room.bot || room.state !== 'aiming') return;
    if (room.bot.aimedTurn === room.turn) return;

    /* It thinks first. Locking in the instant the turn opens is the one thing
       that would give it away every single turn: a person takes a few seconds,
       and "opponent is ready" arriving before you have finished reading the
       board reads as a machine. Long enough to be believable, short enough that
       it is never the thing keeping you waiting. */
    const t = typeof now === 'number' ? now : Date.now();
    if (!room.bot.thinkUntil || room.bot.thinkTurn !== room.turn) {
      room.bot.thinkTurn = room.turn;
      room.bot.thinkUntil = t + 2200 + Math.random() * 3400;
      return;
    }
    if (t < room.bot.thinkUntil) return;
    room.bot.aimedTurn = room.turn;

    const me = room.bot.id;
    const foe = room.opponentOf(me);
    const mine = room.piecesOf(me), theirs = room.piecesOf(foe);
    if (!mine.length) return;

    const aims = [];
    for (const p of mine) {
      const fromRim = room.arenaR - Math.hypot(p.x, p.y);

      /* Close to going off already? Get off the rim. Anything else this turn is
         a trade it is losing. */
      if (fromRim < KO.PIECE_R * 2.2 && Math.hypot(p.x, p.y) > 1) {
        const d = Math.hypot(p.x, p.y);
        const pull = KO.MAX_PULL * (0.34 + Math.random() * 0.16);
        aims.push({ pieceId: p.id, ax: (-p.x / d) * pull, ay: (-p.y / d) * pull });
        continue;
      }

      if (!theirs.length) continue;

      /* The best target is the one nearest the edge and nearest to us: it takes
         the least push to remove and the least travel to reach. */
      let best = null, bestCost = Infinity;
      for (const cand of theirs) {
        const reach = Math.hypot(cand.x - p.x, cand.y - p.y);
        const theirRim = room.arenaR - Math.hypot(cand.x, cand.y);
        const cost = reach * 0.55 + theirRim * 1.5;
        if (cost < bestCost) { bestCost = cost; best = cand; }
      }
      if (!best) continue;

      /* Aim through them toward the outside, so a hit carries them off rather
         than merely into them. */
      const tr = Math.hypot(best.x, best.y) || 1;
      const outx = best.x / tr, outy = best.y / tr;
      const aimX = best.x + outx * KO.PIECE_R * 1.4;
      const aimY = best.y + outy * KO.PIECE_R * 1.4;

      let dx = aimX - p.x, dy = aimY - p.y;
      const dist = Math.hypot(dx, dy) || 1;

      /* Never exact. A bot that cannot miss is not an opponent, it is a wall.
         The error is angular and scales with distance, which is how a human
         misses too: long shots go wide, short ones rarely do. */
      const spread = 0.055 + Math.min(0.12, dist / 4200);
      const a = Math.atan2(dy, dx) + (Math.random() * 2 - 1) * spread;

      /* Enough power to arrive with something left, and a little more the
         further it has to go. Jittered so it is not a formula. */
      const want = Math.min(1, 0.5 + dist / (KO.MAX_SPEED * 0.62));
      let pull = KO.MAX_PULL * Math.max(0.3, Math.min(1, want * (0.88 + Math.random() * 0.24)));

      /* AND NOT ONE UNIT HARDER THAN THE DISC WILL TAKE.

         This is the whole difference between an opponent and a piece that
         throws itself into the pit. The cap is worked out from where the rim
         actually is along this exact line, so a shot across the middle can be
         full power and a shot at something parked on the edge cannot. It is
         conservative on purpose: it assumes the shot meets nothing, and a
         collision only ever takes speed away. */
      const ux = Math.cos(a), uy = Math.sin(a);
      const room2rim = rimDistance(p.x, p.y, ux, uy, room.arenaR);
      const safe = Math.max(0, room2rim - KO.PIECE_R * 1.8);
      pull = Math.min(pull, pullForTravel(safe));

      /* If there is no shot down this line that keeps the piece on the disc,
         do not take a weak one: back off toward the middle and live. A person
         in that spot does the same thing. */
      if (pull < KO.MAX_PULL * 0.16) {
        const d = Math.hypot(p.x, p.y) || 1;
        const back = KO.MAX_PULL * (0.3 + Math.random() * 0.18);
        aims.push({ pieceId: p.id, ax: (-p.x / d) * back, ay: (-p.y / d) * back });
        continue;
      }
      aims.push({ pieceId: p.id, ax: ux * pull, ay: uy * pull });
    }

    if (aims.length) room.submitAim(me, aims);
    room.lockIn(me);
  }
}

/* Hung off the class as well as exported, so a caller that already has the
   class does not need a second import just to say how long a paid seat waits. */
KnockoutLobby.PAID_WAIT_MS = PAID_WAIT_MS;

module.exports = { KnockoutLobby, BOT_AFTER_MS, PAID_WAIT_MS };
