'use strict';
/* ─── The socket.io options, and the slither path /sl-io/ ───────────────────────
   One copy of what server/index.js builds its socket.io server with, so a second
   process serving slither (the server split: free slither and the battle royale on
   their own thread) answers with exactly the same limits, and so the path those
   sockets use can be served by this one engine meanwhile.

   /sl-io/ (SL_IO_PATH) is the engine.io path of the free slither room, its free
   watchers and the battle royale (public/js/slx/slxNet.js picks it; paid seats and
   paid-rung watchers stay on /socket.io/, where their money lives). nginx sends it
   to 127.0.0.1:SL_CHILD_PORT first and to the main port as its backup
   (deploy/nginx-sl-io.conf). While the split is off there is ONE engine.io server:
   installPathAlias rewrites /sl-io/ to /socket.io/ before engine.io looks, and
   aliasListener has this same server answer on SL_CHILD_PORT, so nginx's first
   choice is always served. Every socket then reaches today's /sl router. */

const net = require('net');

// Origins allowed to call this server cross-origin: the NA + EU domains (so the lobby on
// duelseries.com can stake against the EU game server it's about to play on) plus local dev.
const ALLOWED_ORIGINS = ['https://duelseries.com', 'https://www.duelseries.com', 'https://eu.duelseries.com', 'http://localhost:3000'];

// socket.io writes into the options object it is handed (cleanupEmptyChildNamespaces: its constructor in
// node_modules/socket.io/dist/index.js), so every server is built from a copy and this one stays as written.
const IO_OPTIONS = {
  cors: {
    origin: ALLOWED_ORIGINS,
    credentials: true,
  },
  pingInterval: 5000,   // heartbeat every 5s (default 25s), keeps mobile WiFi radio awake
  pingTimeout:  10000,  // declare dead after 10s of no response (default 20s)
  /* The largest message one client may send (default 1 MB). Every honest client
     message in every game is a small object, well under 2 KB (the biggest are the
     sl:diag stats, a join with its entry token, Battleship's ship placement), so
     64 KB is over 30x headroom. A 1 MB message was enough to hand a handler a
     megabyte string, which is what made the quadratic base58 decode a 20-minute
     stall. The served socket.io client reads this limit from the handshake and
     splits a polling batch to fit under it. */
  maxHttpBufferSize: 64 * 1024,
};

// The engine.io path of free slither and the battle royale (see the header).
const SL_IO_PATH = '/sl-io/';

// Keep idle connections from nginx open longer than its upstream keep-alive, so a reused one is never cut mid-request.
const KEEPALIVE = { keepAliveTimeout: 120000, headersTimeout: 121000 };

/* Requests whose path starts with `from` reach engine.io as if they had asked for
   `to`. Called AFTER new Server(...): engine.io (and socket.io's client serving)
   move the request listeners already there behind their own when they attach
   (node_modules/engine.io/build/server.js attach), so a listener prepended later
   runs before them and engine.io sees the rewritten url (it matches on
   req.url.slice(0, path.length)). Both a long-poll ('request') and a WebSocket
   ('upgrade') are covered. Only that prefix is touched, and no express route lives
   under it, so every other request reaches express exactly as before. */
function installPathAlias(httpServer, from, to) {
  for (const ev of ['request', 'upgrade']) {
    httpServer.prependListener(ev, (req) => {
      if (typeof req.url === 'string' && req.url.startsWith(from)) req.url = to + req.url.slice(from.length);
    });
  }
}

/* Every engine.io handshake answer says which process served it (x-ds-proc: main
   or sl), so `curl -sI .../sl-io/?EIO=4&transport=polling` through nginx proves
   where the slither path lands. */
function tagEngine(io, name) {
  io.engine.on('initial_headers', (headers) => { headers['x-ds-proc'] = name; });
}

/* This http server answering on a second port too, 127.0.0.1 only: every
   connection accepted there is handed to it as its own. A port still held (a
   predecessor going down) is tried again every 500 ms for 15 s, then it logs and
   gives up: the backup port still serves the path, so nothing is lost but the
   first choice. opts (tests only): { everyMs, forMs }. -> the net.Server */
function aliasListener(httpServer, port, log, opts) {
  const o = opts || {};
  const everyMs = o.everyMs > 0 ? o.everyMs : 500;
  const forMs = o.forMs > 0 ? o.forMs : 15000;
  const say = log || console;
  const started = Date.now();
  const srv = net.createServer((sock) => httpServer.emit('connection', sock));
  srv.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE' && Date.now() - started < forMs) {
      const t = setTimeout(() => {
        srv.close();
        srv.listen(port, '127.0.0.1');
      }, everyMs);
      if (typeof t.unref === 'function') t.unref();
      return;
    }
    say.error('[SL-IO] the slither path is not served on 127.0.0.1:' + port + ' (' + (e && e.message) +
      '); nginx falls back to the main port');
  });
  srv.on('listening', () => say.log('[SL-IO] /sl-io/ also served on 127.0.0.1:' + port));
  srv.listen(port, '127.0.0.1');
  return srv;
}

module.exports = { ALLOWED_ORIGINS, IO_OPTIONS, SL_IO_PATH, KEEPALIVE, installPathAlias, tagEngine, aliasListener };
