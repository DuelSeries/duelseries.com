'use strict';
/* ─── Who is on the other end of a connection ─────────────────────────────────
   nginx on the same box terminates TLS and proxies to this process, so for a
   real player the TCP peer is nginx (loopback, or the box's private 172.31
   address) and the player's own address is the LAST entry nginx appended to
   X-Forwarded-For.

   But port 3000 has been reachable from the internet directly. A client that
   connects straight to it can put anything in X-Forwarded-For, and when that
   header was believed unconditionally every per-address cap (sockets per IP,
   the resume bad-key gate) was a fresh address per connection away from
   meaning nothing.

   So the header is believed ONLY when the peer is a proxy we could be behind:
   loopback or a private (RFC 1918 / fc00::/7) address. That is the same rule
   express applies to req.ip under app.set('trust proxy', 'loopback, uniquelocal')
   in server/index.js, so HTTP and sockets count one client as one address.
   A public peer is the client itself, whatever the header says. */

const net = require('net');

/* express's own setting for the same rule: app.set('trust proxy', TRUST_PROXY) in server/index.js. */
const TRUST_PROXY = 'loopback, uniquelocal';

/* An address as text, with the IPv4-mapped IPv6 prefix taken off
   ('::ffff:1.2.3.4' -> '1.2.3.4'), so one client is one key either way. */
function bareIp(ip) {
  if (typeof ip !== 'string') return '';
  const s = ip.trim();
  if (/^::ffff:/i.test(s) && net.isIPv4(s.slice(7))) return s.slice(7);
  return s;
}

/* Loopback or private: 127/8, 10/8, 172.16/12, 192.168/16, ::1, fc00::/7. */
function isTrustedPeer(ip) {
  const a = bareIp(ip);
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    return p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168);
  }
  if (net.isIPv6(a)) {
    const l = a.toLowerCase();
    return l === '::1' || l === '0:0:0:0:0:0:0:1' || /^f[cd][0-9a-f]{2}:/.test(l);
  }
  return false;
}

/* The client's address: the peer itself unless the peer is a trusted proxy,
   and then the last X-Forwarded-For hop (the one the proxy wrote) when it is
   an address at all. */
function clientAddress(peer, xff) {
  const p = bareIp(peer);
  if (!isTrustedPeer(p)) return p;
  if (typeof xff === 'string' && xff) {
    const hop = bareIp(xff.slice(xff.lastIndexOf(',') + 1));
    if (hop && net.isIP(hop)) return hop;
  }
  return p;
}

/* The same for a socket.io socket (handshake.address is the TCP peer). */
function socketClientIp(socket) {
  const hs = socket && socket.handshake;
  if (!hs) return '';
  return clientAddress(typeof hs.address === 'string' ? hs.address : '',
    hs.headers && hs.headers['x-forwarded-for']);
}

/* The network a client address stands for, for the per-person rules (night review 2026-10-29: the battle
   royale's prize count and seats per address, and paid snake's one seat per address per room). An IPv4
   address is itself. An IPv6 address is its /64: one home or one phone is given a whole /64 and can use any
   address in it, so counting addresses would let one machine be as many people as it likes. '' for no
   address (the caller decides what an unknown network means). */
function addressGroup(ip) {
  let a = bareIp(ip);
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);
  if (!net.isIPv6(a)) return net.isIPv4(a) ? a : '';
  a = a.toLowerCase();
  // a dotted IPv4 tail is the low 32 bits: it never reaches the /64, so it stands as two zero groups
  const colon = a.lastIndexOf(':');
  if (a.indexOf('.', colon) !== -1) a = a.slice(0, colon + 1) + '0:0';
  const halves = a.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length > 1 ? head.concat(new Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail)
    : head;
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64';
}

module.exports = { TRUST_PROXY, bareIp, isTrustedPeer, clientAddress, socketClientIp, addressGroup };
