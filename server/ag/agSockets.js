'use strict';
// The agar.io socket handlers (build brief 6, 9.3): ag:join, ag:spectate, ag:target, ag:split, ag:eject, ag:q,
// ag:leave, ag:view, ag:portrait, ag:hold (Owen's hold-Q cash-out, every room) and ag:ready (paid seats) in, one
// binary bundle per tick out on ag:f (sent by the room); paid joins go to the paid door (agPaidDoor, design 5.4).
// The event prefix is ag:* only, so the
// old agar pages (cell:*) can never talk to these rooms.
//
// Every handler reads its payload only after checking its shape: a wrong shape is ignored, a number must be a
// finite integer in the int32 range the client sends, a name must be a string. Every handler is wrapped so
// nothing a client sends can throw out of socket.io (the server has no uncaughtException handler). Names are
// cleaned by the server's sanitizeName rules and cut to the law table's L37 cap in characters of any kind, never
// by that helper's 20 UTF-16 unit cut (cleanName below; the wire allows 4 bytes a character, so it cuts nothing). Every event but ag:view and ag:portrait is rate limited per socket through the server's socketRL (onView says why;
// ag:portrait is rate limited by the directory instead, onPortrait).
//
// attachAgSockets(io, arenas, helpers): io is the socket.io namespace the game runs on (the server passes
// io.of('/ag')); every socket that connects there is seated as a watcher at once (the page must be sent world
// updates before it asks to play). Pass io = null to attach sockets by hand (tests).
//
// Connections per address (AG_CONN PER_IP): the namespace's own middleware refuses a handshake from an address
// that already holds that many sockets on /ag (io.use on the main namespace does not cover /ag), and the
// connection handler counts again, since handshakes in flight together all pass the middleware before any of
// them is counted. A handshake refused by the middleware fails with { why: 'limit' }; a connection past the cap,
// or one no room has a watcher seat for, gets 'ag:refused' and is closed. The address is read the way express
// reads req.ip under the server's 'trust proxy' 1: the last X-Forwarded-For entry when the header is there, else
// the socket's own address (helpers.clientIp replaces it). An IPv6 client can hold many addresses; each counts
// on its own, and the watcher seats per room still bound what they cost.

const { assertLawsComplete } = require('./agLaws');
const { refuse } = require('./agArenas');
const { createAgPaidDoor, wantsPaid } = require('./agPaidDoor');

// CHOSEN per-socket rate limits (ours): the least milliseconds between two events of one kind. Their server's
// limits are not known (CCI-U5); these only stop floods. Split and eject stay fast enough for repeated presses
// (the eject cooldown itself is law L22, applied by the sim).
function chosen(value, note) {
  return Object.freeze({ value, status: 'CHOSEN', note });
}
const AG_RATE = Object.freeze({
  join: chosen(500, 'ag:join (Play, also respawn)'),
  spectate: chosen(500, 'ag:spectate'),
  target: chosen(10, 'ag:target (their client sends at most one per drawn frame, gated above 15 ms)'),
  split: chosen(20, 'ag:split (every key press is sent; repeated presses must get through)'),
  eject: chosen(20, 'ag:eject'),
  q: chosen(100, 'ag:q (ignored in FFA)'),
  leave: chosen(500, 'ag:leave'),
  // PAID-AGAR-DESIGN.md 5.5: ag:hold rate 50 ms; the page repeats {on:1} every 200 ms. Only {on:1} is limited: a
  // release ({on:0}) is a state that only ends a hold, so it is never dropped (a dropped release could let a hold the
  // player let go of run on until it went stale).
  hold: chosen(50, 'ag:hold {on:1} (Owen 2026-10-08 hold-Q cash-out; design 5.5)'),
  ready: chosen(250, 'ag:ready (paid seats: once per seat, repeats are harmless)'),
});

// CHOSEN connection cap (ours; no source: their server's limits are unknown, CCI-U5, and Paper has none). Enough
// for a household's devices and tabs, and below a room's watcher seats (L39, suggested 50), so one address can
// never hold every watcher seat of a room. A shared campus or office address is refused past it: Owen's call.
const AG_CONN = Object.freeze({
  PER_IP: chosen(10, 'sockets one address may hold on /ag at once, watchers and players together'),
});

// The client address under 'trust proxy' 1 (see the header).
function clientIp(socket) {
  const hs = socket && socket.handshake;
  if (!hs) return '';
  const xff = hs.headers && hs.headers['x-forwarded-for'];
  let ip = '';
  if (typeof xff === 'string' && xff) {
    const at = xff.lastIndexOf(',');
    ip = xff.slice(at + 1).trim();
  }
  if (!ip) ip = typeof hs.address === 'string' ? hs.address : '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// Open sockets per address.
function createConnGate(limit, ipOf) {
  const open = new Map();
  const held = new WeakMap();   // socket -> the address it was counted under
  return {
    full(socket) {
      return (open.get(ipOf(socket)) || 0) >= limit;
    },
    // Counts the socket; false (not counted) when its address is at the cap.
    add(socket) {
      if (held.has(socket)) return true;
      const ip = ipOf(socket);
      const n = open.get(ip) || 0;
      if (n >= limit) return false;
      open.set(ip, n + 1);
      held.set(socket, ip);
      return true;
    },
    remove(socket) {
      if (!held.has(socket)) return;
      const ip = held.get(socket);
      held.delete(socket);
      const n = (open.get(ip) || 0) - 1;
      if (n > 0) open.set(ip, n);
      else open.delete(ip);
    },
    count(ip) {
      return open.get(ip) || 0;
    },
    addresses() {
      return open.size;
    },
  };
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isInt32(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX;
}

// A name cleaned the way the server's sanitizeName cleans it, cut to `cap` characters (code points). Missing or
// blank stays empty: their client shows an unnamed cell for an empty name, so nothing is made up for it. Not a
// string: null (ignored).
//
// L37 (MEASURED; Owen chose the recordings, OWNER-ANSWERS 2026-10-02 later): a name keeps `cap` characters of any
// kind (their server passed a 15-character name of 26 UTF-16 units). The shared sanitizeName also cuts every name at
// 20 UTF-16 units, which leaves 10 emoji, and it stays as it is for the other games, so agar wraps it: the name gets
// the helper's rules without its cut (no < or >, outer spaces trimmed, no lone half of a character) and is cut to
// `cap` characters, then the helper must leave every HELPER_PIECE-character piece of it unchanged (a piece is at most
// 18 UTF-16 units, inside its cut; a guard character each side keeps its trim off inner spaces). If the helper changes
// any piece (a rule it gains later), its own result is used, cut to `cap` characters.
const HELPER_PIECE = 9;
function cleanName(raw, cap, sanitizeName) {
  if (raw === undefined) return '';
  if (typeof raw !== 'string') return null;
  if (!raw.trim()) return '';
  const chars = [];
  for (const ch of raw.replace(LONE_SURROGATE, '').replace(/[<>]/g, '').trim()) {
    if (chars.length >= cap) break;
    chars.push(ch);
  }
  let agrees = chars.length > 0;
  for (let i = 0; agrees && i < chars.length; i += HELPER_PIECE) {
    const piece = '.' + chars.slice(i, i + HELPER_PIECE).join('') + '.';
    agrees = sanitizeName(piece) === piece;
  }
  if (agrees) return chars.join('');
  const s = sanitizeName(raw);
  if (typeof s !== 'string') return '';
  // sanitizeName cuts UTF-16 units, which can leave half of a character behind: drop any lone half.
  return Array.from(s.replace(LONE_SURROGATE, '')).slice(0, cap).join('');
}

function attachAgSockets(io, arenas, helpers) {
  const h = helpers || {};
  const socketRL = h.socketRL;
  const sanitizeName = h.sanitizeName;
  if (typeof socketRL !== 'function') throw new TypeError('agSockets: helpers.socketRL must be a function');
  if (typeof sanitizeName !== 'function') throw new TypeError('agSockets: helpers.sanitizeName must be a function');
  const ops = h.ops || null;
  const log = h.log || console;
  assertLawsComplete(arenas.laws, ['L37']);
  const nameCap = arenas.laws.L37.value;
  if (!Number.isInteger(nameCap) || nameCap < 0) throw new TypeError('agSockets: law L37 must be a whole number');
  const ipOf = typeof h.clientIp === 'function' ? h.clientIp : clientIp;
  const perIp = h.perIp === undefined ? AG_CONN.PER_IP.value : h.perIp;
  if (!Number.isInteger(perIp) || perIp < 1) throw new TypeError('agSockets: perIp must be a whole number above 0');
  const gate = createConnGate(perIp, ipOf);

  function limited(socket, kind) {
    return socketRL(socket, 'ag' + kind, AG_RATE[kind].value);
  }

  // The paid door (agPaidDoor, design 5.4): built here when the server hands its money dependencies in (h.paidDoor).
  const door = h.paidDoor ? createAgPaidDoor(Object.assign({ arenas, cleanName: (raw) => cleanName(raw, nameCap,
    sanitizeName), clientIp: ipOf, ops, log }, h.paidDoor)) : null;

  // The rate limit comes before the name is cleaned, so a dropped join never trims or scans a name.
  // A paid payload (a stake above 0, an entryToken or a resumeKey) goes to the paid door FIRST, before the free
  // join's rate limit and maintenance answer (the door has its own limiter and refunds under maintenance). Without a
  // door (no money wired) a paid payload is refused, never seated free.
  function onJoin(socket, msg) {
    if (msg !== undefined && !isPlainObject(msg)) return;
    if (msg !== undefined && wantsPaid(msg)) {
      if (door) return door.join(socket, msg);
      socket.emit('ag:refused', { why: 'not-open' });
      return;
    }
    if (!limited(socket, 'join')) return;
    const name = cleanName(msg === undefined ? undefined : msg.name, nameCap, sanitizeName);
    if (name === null) return;
    if (ops && typeof ops.get === 'function') {
      const o = ops.get();
      if (o && o.maintenance) {
        socket.emit('ag:refused', { why: 'maintenance' });
        return;
      }
    }
    const r = arenas.join(socket, name);
    if (r === 'full') socket.emit('ag:refused', { why: 'full' });
  }

  function onSpectate(socket) {
    if (!limited(socket, 'spectate')) return;
    arenas.spectate(socket);
  }

  function onTarget(socket, msg) {
    if (!isPlainObject(msg)) return;
    const x = msg.x;
    const y = msg.y;
    if (!isInt32(x) || !isInt32(y)) return;
    if (!limited(socket, 'target')) return;
    arenas.target(socket.id, x, y);
  }

  function onSplit(socket) {
    if (!limited(socket, 'split')) return;
    arenas.split(socket.id);
  }

  function onEject(socket) {
    if (!limited(socket, 'eject')) return;
    arenas.eject(socket.id);
  }

  function onQ(socket) {
    if (!limited(socket, 'q')) return;
    arenas.q(socket.id);
  }

  // A paid seat leaves alive only by cash-out (design 4 step 7).
  function onLeave(socket) {
    if (!limited(socket, 'leave')) return;
    if (arenas.paidRoomOf && arenas.paidRoomOf(socket.id)) {
      socket.emit('ag:refused', { why: 'cash-out-to-leave' });
      return;
    }
    arenas.leave(socket.id);
  }

  // ag:hold { on: 1 | 0 } (Owen 2026-10-08 hold-Q cash-out, every room): 1 starts or refreshes the hold, 0 lets go.
  function onHold(socket, msg) {
    if (!isPlainObject(msg)) return;
    const on = msg.on === 1 || msg.on === true;
    const off = msg.on === 0 || msg.on === false;
    if (!on && !off) return;
    if (on && !limited(socket, 'hold')) return;
    arenas.hold(socket.id, on);
  }

  // ag:ready (paid seats): the page drew a frame with its own cell (design 4 step 5).
  function onReady(socket) {
    if (!limited(socket, 'ready')) return;
    if (typeof arenas.ready === 'function') arenas.ready(socket.id);
  }

  // ag:view { below }: the world units (at zoom 1) the page draws under the reference view, a whole number, 0 or
  // more (Owen 2026-10-08: our page is sized as if their 90 px strip were there and shows the map under it). The view
  // caps it (law VIEW_BELOW). Not rate limited: it is the page's current state, not an action, so dropping a report
  // would leave an old value standing (a resize burst can reach the server in one polling packet), and handling one
  // is a single Map write, less than socket.io's own parse of the packet.
  function onView(socket, msg) {
    if (!isPlainObject(msg)) return;
    const below = msg.below;
    if (!isInt32(below) || below < 0) return;
    arenas.view(socket.id, below);
  }

  // ag:portrait true|false: the page plays the phone portrait layout (ours, Owen 2026-10-08), so its view box is
  // L4's turned on its side, the same area. One boolean and nothing else: no size ever comes from the client (their
  // client never sends its screen). Anything but true or false is ignored. Like ag:view it is a state, so it is not
  // dropped by socketRL; the directory rate limits the box instead (one orientation change per PORTRAIT_GAP_MS, the
  // last report applied when the gap is up), so flipping fast cannot show a page both boxes.
  function onPortrait(socket, msg) {
    if (msg !== true && msg !== false) return;
    arenas.portrait(socket.id, msg);
  }

  function guard(name, fn) {
    return function () {
      try {
        fn.apply(null, arguments);
      } catch (e) {
        log.error('[AG] handler ' + name, e && e.stack ? e.stack : e);
      }
    };
  }

  // Handlers take only the first argument, and never call an acknowledgement a client may have asked for.
  function attach(socket) {
    socket.on('ag:join', guard('ag:join', (msg) => onJoin(socket, msg)));
    socket.on('ag:spectate', guard('ag:spectate', () => onSpectate(socket)));
    socket.on('ag:target', guard('ag:target', (msg) => onTarget(socket, msg)));
    socket.on('ag:split', guard('ag:split', () => onSplit(socket)));
    socket.on('ag:eject', guard('ag:eject', () => onEject(socket)));
    socket.on('ag:q', guard('ag:q', () => onQ(socket)));
    socket.on('ag:leave', guard('ag:leave', () => onLeave(socket)));
    socket.on('ag:view', guard('ag:view', (msg) => onView(socket, msg)));
    socket.on('ag:portrait', guard('ag:portrait', (msg) => onPortrait(socket, msg)));
    socket.on('ag:hold', guard('ag:hold', (msg) => onHold(socket, msg)));
    socket.on('ag:ready', guard('ag:ready', () => onReady(socket)));
    socket.on('disconnect', guard('disconnect', () => {
      gate.remove(socket);
      drop(socket.id);
    }));
    guard('connect', () => {
      if (!gate.add(socket)) return refuse(socket, 'limit');
      // A stake hand-off (auth { paid: 1 }) connects seatless: no watcher seat, so a full set of them can never
      // close it; it has PAID_SEATLESS_MS to send its ag:join (design 5.5).
      const hs = socket.handshake;
      if (hs && hs.auth && hs.auth.paid === 1 && typeof arenas.connectPaid === 'function') {
        arenas.connectPaid(socket);
        return;
      }
      if (!arenas.connect(socket)) refuse(socket, 'full');
    })();
  }

  function drop(socketId) {
    arenas.disconnect(socketId);
  }

  // The handshake gate on the namespace: an address at the cap never gets a connection.
  function admit(socket, next) {
    let over = false;
    try {
      over = gate.full(socket);
    } catch (e) {
      log.error('[AG] connection gate', e && e.stack ? e.stack : e);
    }
    if (!over) return next();
    const err = new Error('too many connections from this address');
    err.data = { why: 'limit' };
    return next(err);
  }

  if (io && typeof io.use === 'function') io.use(admit);
  if (io && typeof io.on === 'function') io.on('connection', (socket) => attach(socket));

  return { attach, drop, admit, gate, door, cleanName: (raw) => cleanName(raw, nameCap, sanitizeName) };
}

module.exports = { attachAgSockets, AG_RATE, AG_CONN, isPlainObject, isInt32, cleanName, clientIp };
