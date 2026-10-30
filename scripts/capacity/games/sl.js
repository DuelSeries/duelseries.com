'use strict';
// The slither.io game (/sl, the free rung) and its battle royale (the same /sl namespace with auth.br 1) for the
// capacity test (scripts/capacity/run.js). One player the way the page plays (public/js/slx/slxNet.js, and the wanderer
// in scripts/slLoad.js this borrows from): auth {cv}, sl:join {nick}, one input record per sl:i emit, a new wanted angle
// byte every 100 to 250 ms only when it changes (toward the centre past 0.6 of the border), boost bursts, the game's own
// ping record once per pong at most every 250 ms. Every bundle is decoded by slLoad's createTracker (the client model:
// a wire error or an unknown id is counted as an error). After its own death it closes 1.6 s later and plays again on
// a new socket, as the page does. No chat, no hold-Q, no resume blips: just players.
//
// ctx.opts.br: join the battle royale instead of the free room. A BR player whose seat is refused because a match is
// under way ('match') waits and asks again every 15 s; a BR death during a match is out for the match, as for a person.

const W = require('../../../shared/slWire.js');
const { createTracker } = require('../../slLoad.js');
const { openSocket, countBytes, pingLoop, toU8 } = require('../lib');

const PI2 = 2 * Math.PI;
const ANGLE_BYTES = 251;
const PING_GAP_MS = 250;
const DEATH_CLOSE_MS = 1600;

function start(ctx) {
  const { base, ip, name, stats, rand } = ctx;
  const br = !!(ctx.opts && ctx.opts.br);
  let stopped = false;
  let sock = null;
  let tr = null;
  let joined = false;
  let deadAt = 0;
  let closing = false;
  let pingOut = false;
  let pingAt = 0;
  let nextPingAt = 0;
  let nextAngleAt = 0;
  let nextTurnAt = 0;
  let target = rand() * PI2;
  let lastQ = -1;
  let boosting = false;
  let boostUntil = 0;
  let stopPing = null;
  let reconnectTimer = null;
  let refusedMatch = false;
  let refusedAny = false;
  const cv = ctx.index % 9;

  function send(rec) {
    if (sock && sock.connected) sock.emit('sl:i', W.encodeInput([rec]));
  }

  function schedule(ms) {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, ms);
  }

  function endLife(delayMs) {
    if (closing) return;
    closing = true;
    const s = sock;
    if (stopPing) stopPing();
    if (s) {
      if (s.connected) s.emit('sl:leave');
      s.disconnect();
    }
    stats.closed();
    schedule(delayMs);
  }

  function connect() {
    if (stopped) return;
    joined = false;
    deadAt = 0;
    closing = false;
    pingOut = false;
    lastQ = -1;
    boosting = false;
    refusedMatch = false;
    refusedAny = false;
    tr = createTracker();
    const auth = br ? { cv, br: 1 } : { cv };
    const s = openSocket(base, '/sl', ip, { auth });
    sock = s;
    countBytes(s, stats);
    s.on('connect', () => {
      if (sock !== s) return;
      stats.connectedNow();
      s.emit('sl:join', { nick: name });
      if (stopPing) stopPing();
      stopPing = pingLoop(s, stats);
    });
    s.on('connect_error', (e) => {
      if (sock !== s) return;
      stats.connectError(e && e.message);
      closing = true;
      s.close();
      schedule(3000 + rand() * 2000);
    });
    s.on('sl:f', (data) => {
      if (sock !== s) return;
      const u8 = toU8(data);
      if (!u8) return;
      const before = tr.fail ? sumFail(tr.fail) : 0;
      const evs = tr.onBundle(u8);
      if (sumFail(tr.fail) > before) stats.error('decode');
      stats.snap();
      const t = Date.now();
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        if (ev.type === 'init' && !joined) {
          joined = true;
          stats.joined();
          nextPingAt = t;
          nextAngleAt = t;
        } else if (ev.type === 'pong' && pingOut) {
          pingOut = false;
          stats.gamePing(t - pingAt);
          nextPingAt = Math.max(t, pingAt + PING_GAP_MS);
        } else if (ev.type === 'dead' && !deadAt) {
          deadAt = t;
          stats.dead();
        }
      }
    });
    s.on('sl:x', (arr) => {
      if (sock !== s || !Array.isArray(arr)) return;
      for (const m of arr) {
        if (!m || typeof m !== 'object') continue;
        if (m.t === 'refused') {
          stats.refused(m.why);
          refusedAny = true;
          if (m.why === 'match') refusedMatch = true;
        }
      }
    });
    s.on('disconnect', (reason) => {
      if (sock !== s) return;
      if (stopPing) stopPing();
      if (closing) return;
      closing = true;
      if (refusedMatch || refusedAny) {
        // a person turned away ('full', 'match', ...) tries again a while later, not every 2 s
        stats.closed();
        schedule(refusedMatch ? 15000 : 10000 + rand() * 10000);
      } else if (deadAt || reason === 'io client disconnect') {
        stats.closed();
        schedule(1000 + rand() * 1000);
      } else {
        stats.dropped(reason);
        schedule(2000);
      }
    });
  }

  function sumFail(f) {
    let n = 0;
    for (const k in f) n += f[k];
    return n;
  }

  function step() {
    const s = sock;
    if (stopped || !s || !s.connected || !joined || closing) return;
    const t = Date.now();
    if (deadAt) {
      if (t - deadAt >= DEATH_CLOSE_MS) endLife(1000 + rand() * 1500);
      return;
    }
    if (!tr.own) return;
    if (!pingOut && t >= nextPingAt) {
      pingOut = true;
      pingAt = t;
      send({ type: 'ping' });
    }
    if (t >= nextAngleAt) {
      nextAngleAt = t + 100 + rand() * 150;
      const grd = tr.grd;
      const hx = tr.own.x - grd;
      const hy = tr.own.y - grd;
      const lim = 0.6 * (tr.flux || grd);
      if (hx * hx + hy * hy > lim * lim) target = Math.atan2(-hy, -hx);
      else if (t >= nextTurnAt) {
        nextTurnAt = t + 500 + rand() * 1500;
        target += (rand() - 0.5) * 1.6;
      }
      target = ((target % PI2) + PI2) % PI2;
      let q = Math.floor((ANGLE_BYTES * target) / PI2) % ANGLE_BYTES;
      if (rand() < 0.3) q = (q + (rand() < 0.5 ? 1 : ANGLE_BYTES - 1)) % ANGLE_BYTES;
      if (q !== lastQ) {
        lastQ = q;
        send({ type: 'angle', q });
      }
    }
    if (!boosting && rand() < 0.01) {
      boosting = true;
      boostUntil = t + 300 + rand() * 1500;
      send({ type: 'boost', on: true });
    } else if (boosting && t >= boostUntil) {
      boosting = false;
      send({ type: 'boost', on: false });
    }
  }

  const loop = setInterval(step, 50);
  connect();

  return {
    stop() {
      stopped = true;
      clearInterval(loop);
      clearTimeout(reconnectTimer);
      if (stopPing) stopPing();
      if (sock) {
        closing = true;
        if (sock.connected) sock.emit('sl:leave');
        sock.disconnect();
      }
      stats.closed();
    },
  };
}

module.exports = { id: 'sl', start };
