'use strict';
/* The per-socket event rate limiter of server/index.js, for a process that serves
   sockets without loading index.js (the slither process of the server split).
   index.js keeps its own copy (dozens of call sites and test pins read it there);
   test/socketRLCopy.test.js keeps the two byte for byte the same. */

// Returns false (and drops the event) if the socket fires it too quickly.
function socketRL(socket, key, minMs) {
  const now = Date.now();
  if (!socket._rl) socket._rl = {};
  if (socket._rl[key] && now - socket._rl[key] < minMs) return false;
  socket._rl[key] = now;
  return true;
}

module.exports = { socketRL };
