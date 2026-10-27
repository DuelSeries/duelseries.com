'use strict';
/* ─── The duel queue's rules, shared by Knockout and Battleship ───────────────
   Both lobbies used to carry their own copy of "who plays whom", and a copy is
   a place for the two to drift apart. What lives here is only the part that
   has to be the same in both: how long a seat waits, who may be paired, how
   many people are waiting at each rung, and what a restart owes the seats it
   is about to lose.

   THE WAIT (Owen 2026-10-21, cut to 20 s 2026-10-27, shared/duelWait.js). A free seat waited a full minute for a person and
   is told so, with a countdown, before it is given a bot. The old wait was a
   random 9 to 22 seconds, and measured with two real clients it put two people
   who queued 35 s apart into two separate bot matches: the first had a bot and
   was past its first turn (too late to be pulled out, see rescueFromBot) by the
   time the second arrived, and the second then got a bot of their own. A
   minute covers two people starting a game together, and the bot is no longer
   a secret: the screen says when it is coming and says "Playing a bot" when it
   does.

   A PAID SEAT NEVER GETS A BOT (memory: paid-room bots). Its minute is only
   the countdown it is shown; at 0:00 it keeps looking (Owen 2026-10-21: keep
   waiting, with a Cancel that refunds at once). PAID_GIVE_UP_MS is the floor
   under that: a tab left open on the wait card does not hold somebody's money
   in escrow for ever, it is handed back after a quarter of an hour. */

const crypto = require('crypto');
const { refundBound } = require('./stakeRules');

const DUEL_WAIT_MS = require('../shared/duelWait');   // one number for every duel, server and page
const FREE_WAIT_MS = DUEL_WAIT_MS;     // a free seat's wait before its bot
const PAID_WAIT_MS = DUEL_WAIT_MS;     // the countdown a paid seat is shown
const PAID_GIVE_UP_MS = 15 * 60000;    // and when an abandoned paid seat is refunded

/* One person, two seats (two tabs, or a page that queued twice): never paired
   with themselves. Only a seat that names a wallet can be told apart, and a
   paid seat's wallet is the one that paid (the entry token), never the page's. */
function samePerson(a, b) {
  return !!(a && b && a.wallet && b.wallet && a.wallet === b.wallet);
}

/* Every pair the queue can make right now, oldest first: same rung, two
   different people. Matched by rung because two seats that paid different
   amounts have no honest way to split a pot. */
function pairUp(queue) {
  const pairs = [];
  const used = new Set();
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    if (used.has(a)) continue;
    for (let j = i + 1; j < queue.length; j++) {
      const b = queue[j];
      if (used.has(b) || (a.stake || 0) !== (b.stake || 0) || samePerson(a, b)) continue;
      used.add(a); used.add(b);
      pairs.push([a, b]);
      break;
    }
  }
  return pairs;
}

/* How many PEOPLE are waiting at each rung: { '0': 1, '0.5': 2 }. Two tabs of
   one wallet are one person. Bots never queue, so there is nothing to leave out. */
function waitingByRung(queue) {
  const seen = new Map();
  for (const e of queue || []) {
    if (!e || !e.socket) continue;
    const k = String(e.stake || 0);
    if (!seen.has(k)) seen.set(k, new Set());
    seen.get(k).add(e.wallet ? 'w:' + e.wallet : 's:' + e.socket.id);
  }
  const out = {};
  for (const [k, who] of seen) out[k] = who.size;
  return out;
}

/* WHAT A RESTART OWES. A queued paid seat and a paid table still being played
   exist only in this process, so a planned restart (every push to main) used
   to lose them: the stake had settled on-chain, its ledger row was 'consumed',
   and nothing would ever pay it back. This turns each into an owed refund row
   (100% of what landed, bounded by the rung, no house cut: a restart is our
   fault) for the shutdown settle to write and the drainer to pay after boot.

   Each seat is marked first (entry.refunded, room.settled) and the lobby is
   stopped and emptied, so nothing in the exit window can match, pay or refund
   the same money a second time.

   The row is the owed lane every paid game shares (db.recordOwedOnce): an
   'agowed:<uuid>' key, one row per key, and a reason that starts with "refund"
   and names it (the database refuses anything else, and a refused row here
   would be a seat marked handled with nothing owed). Each row is also written
   to the money journal first, synchronously, when the lobby has one
   (lobby.journal, index.js): a crash has no time for the database, and a
   restart's write can fail, so the next boot replays the journal's owed closes
   through the same recordOwedOnce, which takes the key once whichever got there. */
const OWED_WHY = (tag) => (tag === 'crash' ? 'crash' : 'shutdown');   // agJournal's OWED_WHYS
function shutdownRows(lobby, game, why) {
  const rows = [];
  const tag = String(why || 'shutdown');
  const owe = (wallet, worth, paid, name, where, room) => {
    const amount = refundBound(Number(worth) || 0, paid);
    if (!wallet || !(amount > 0)) return;
    const uuid = crypto.randomUUID();
    const key = 'agowed:' + uuid;
    const row = { key, wallet, micro: Math.round(amount * 1e6), name: name || 'Player',
                  reason: `refund ${game} ${tag} ${where} ${key}` };
    if (lobby.journal && typeof lobby.journal.close === 'function') {
      try {
        lobby.journal.close({ jid: game + '-' + uuid, wallet, name: row.name }, 'refunded',
          { why: OWED_WHY(tag), key, refundedMicro: row.micro, reason: row.reason }, room || game);
      } catch (_) { /* the journal never throws into a money path; the row below still goes */ }
    }
    rows.push(row);
  };
  lobby.stopping = true;
  if (typeof lobby.stop === 'function') lobby.stop();
  for (const e of lobby.queue || []) {
    if (!(e.worth > 0) || e.refunded) continue;
    e.refunded = true;
    owe(e.wallet, e.worth, e.paid, e.name, 'while queued', game + ':queue');
  }
  lobby.queue = [];
  for (const room of lobby.rooms ? lobby.rooms.values() : []) {
    if (!(room.stake > 0) || room.settled) continue;
    room.settled = true;
    for (const [id, p] of room.players) {
      if (String(id).startsWith('bot_')) continue;
      owe(p.wallet, room.worth ? room.worth.get(id) : 0, p.paid, p.name, 'mid-match', room.id);
    }
  }
  return rows;
}

/* A RECONNECT WHILE WAITING TAKES THE SAME SEAT BACK.

   A phone that drops its connection for a second comes back on a new socket.
   It used to queue again from nothing: a free seat's minute started over, and
   a paid seat, whose one-time token was already spent, was refused as unpaid
   while its old seat sat in the queue as a ghost a stranger could be matched
   against, until the server noticed the old socket was gone.

   So every seat gets a resume key, a random secret sent only to that socket
   (ko:queued / bs:queued). A reconnect that shows it takes the seat over as it
   is: the same place in the queue, the same minute, the same stake. The key
   is the only proof and it is never sent anywhere else, so nobody can take a
   seat that is not theirs; and the prize or refund still goes to the seat's
   own wallet (the one that paid), whoever holds the socket. If the old
   socket's drop was noticed first and a paid seat was refunded, the key says
   so instead (recentRefunds), so the screen can tell the player where the
   money went rather than calling them unpaid. */
const RESUME_REMEMBER_MS = 5 * 60000;

function newResumeKey() {
  return crypto.randomBytes(16).toString('hex');
}

const isKey = (k) => typeof k === 'string' && /^[0-9a-f]{32}$/.test(k);

// { resumed: entry } | { refunded: true } | null (nothing to take back: queue as new).
function resumeSeat(lobby, socket, key) {
  if (!isKey(key) || lobby.stopping || !socket) return null;
  const e = lobby.queue.find(q => q.resumeKey === key);
  if (e) {
    if (e.socket.id !== socket.id && lobby.holds(socket.id)) return null;   // this socket already has a seat
    if (typeof lobby.unwatch === 'function') lobby.unwatch(socket.id);
    e.socket = socket;
    return { resumed: e };
  }
  const gone = lobby.recentRefunds && lobby.recentRefunds.get(key);
  if (gone && gone.paid) {
    lobby.recentRefunds.delete(key);
    return { refunded: true };
  }
  return null;
}

// Called by the lobby's refund(): remembered for a few minutes, so a late reconnect can be told.
function noteRefund(lobby, entry, now) {
  if (!entry || !isKey(entry.resumeKey)) return;
  const t = typeof now === 'number' ? now : Date.now();
  if (!lobby.recentRefunds) lobby.recentRefunds = new Map();
  for (const [k, v] of lobby.recentRefunds) if (t - v.at > RESUME_REMEMBER_MS) lobby.recentRefunds.delete(k);
  lobby.recentRefunds.set(entry.resumeKey, { paid: entry.worth > 0, at: t });
}

module.exports = { FREE_WAIT_MS, PAID_WAIT_MS, PAID_GIVE_UP_MS, samePerson, pairUp, waitingByRung, shutdownRows,
                   newResumeKey, resumeSeat, noteRefund };
