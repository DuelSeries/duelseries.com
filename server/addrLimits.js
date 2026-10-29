'use strict';
/* ─── Per-address limits on the main socket.io namespace (night review 2026-10-29) ─────────────────
   /ag, /sl and /chomp each cap the sockets one internet address may hold. The main namespace, where
   the lobby, the old snake rooms and all eight duels live, had no cap at all, and a free duel seat
   needs no login: a few hundred sockets from one machine, each queued for a free Head Soccer or Swim
   table, became a few hundred 60 Hz bot matches on the one event loop every paid game shares.

   Two limits, both far above anything a person or a household does:
   - sockets per address (createAddrGate), checked at the handshake;
   - free duel seats per address across every duel lobby (freeSeatsAt), checked when a free seat is
     asked for. Paid seats are never counted or refused here: each one is a real stake.

   THE ADDRESS is server/clientAddr.js's (the last X-Forwarded-For hop when the peer is nginx, else
   the peer), with two rules of its own:
   - a loopback or private address is never counted. A public client always arrives with its public
     address (nginx writes it, and a direct connection IS it), so the only sockets that show a private
     one are this box and its own network: local tools, tests, and nginx itself were it ever to stop
     sending the header, in which case every player would share one address and a cap would lock all
     of them out at once. Not counting is today's behaviour, the safe way to fail.
   - an IPv6 address counts by its /64, the block one home or one phone is given, so one VPS cannot
     take a fresh address per socket from its own prefix. */

const net = require('net');
const { socketClientIp, isTrustedPeer } = require('./clientAddr');

/* The /64 an IPv6 address is in, as text ('2001:db8:1:2::/64'). */
function v6Prefix64(ip) {
  let s = String(ip).toLowerCase();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  // An embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) is the last two groups.
  const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m) {
    const p = m.slice(1).map(Number);
    s = s.slice(0, m.index) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  let groups;
  const gap = s.indexOf('::');
  if (gap >= 0) {
    const head = s.slice(0, gap) ? s.slice(0, gap).split(':') : [];
    const tail = s.slice(gap + 2) ? s.slice(gap + 2).split(':') : [];
    groups = head.concat(new Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail);
  } else {
    groups = s.split(':');
  }
  return groups.slice(0, 4).map((g) => (parseInt(g || '0', 16) || 0).toString(16)).join(':') + '::/64';
}

/* The key a socket is counted under, or null for one that is never counted (see the header). */
function addrKey(socket) {
  const ip = socketClientIp(socket);
  if (!ip || isTrustedPeer(ip)) return null;
  return net.isIPv6(ip) ? v6Prefix64(ip) : ip;
}

const NONE = Object.freeze(new Set());

/* Open sockets per address, and which ones (freeSeatsAt reads them). slSockets' createConnGate, plus
   the set of sockets behind each address and the uncounted null key. */
function createAddrGate(limit, keyOf) {
  const max = Number(limit) > 0 ? Number(limit) : Infinity;
  const key = typeof keyOf === 'function' ? keyOf : addrKey;
  const open = new Map();       // key -> Set of sockets
  const held = new WeakMap();   // socket -> the key it was counted under
  return {
    full(socket) {
      const k = key(socket);
      return k !== null && (open.has(k) ? open.get(k).size : 0) >= max;
    },
    add(socket) {
      if (held.has(socket)) return true;
      const k = key(socket);
      if (k === null) return true;
      let set = open.get(k);
      if (set && set.size >= max) return false;
      if (!set) open.set(k, (set = new Set()));
      set.add(socket);
      held.set(socket, k);
      return true;
    },
    remove(socket) {
      if (!held.has(socket)) return;
      const k = held.get(socket);
      held.delete(socket);
      const set = open.get(k);
      if (!set) return;
      set.delete(socket);
      if (!set.size) open.delete(k);
    },
    keyOf(socket) { return held.has(socket) ? held.get(socket) : null; },
    socketsAt(k) { return (k !== null && open.get(k)) || NONE; },
    count(k) { return open.has(k) ? open.get(k).size : 0; },
    addresses() { return open.size; },
    limit: max,
  };
}

/* Whether this socket holds a FREE seat in a duel lobby: waiting at no stake, or at a free table that
   is not over. Every duel lobby keeps `queue` entries with { socket, stake } and answers roomOf(id). */
function holdsFreeSeat(lobby, socketId) {
  if (!lobby) return false;
  const q = Array.isArray(lobby.queue) ? lobby.queue.find((e) => e && e.socket && e.socket.id === socketId) : null;
  if (q) return !(q.stake > 0);
  const room = typeof lobby.roomOf === 'function' ? lobby.roomOf(socketId) : null;
  return !!room && !(room.stake > 0) && room.state !== 'over';
}

/* How many free duel seats the sockets at this socket's address hold across `lobbies`, leaving out this
   socket's own seat in `lobby` (queueing there again replaces it). null for a socket that is not counted. */
function freeSeatsAt(gate, socket, lobbies, lobby) {
  const k = gate.keyOf(socket);
  if (k === null) return null;
  let n = 0;
  for (const s of gate.socketsAt(k)) {
    for (const lb of lobbies) {
      if (s === socket && lb === lobby) continue;
      if (holdsFreeSeat(lb, s.id)) n++;
    }
  }
  return n;
}

module.exports = { addrKey, v6Prefix64, createAddrGate, holdsFreeSeat, freeSeatsAt };
