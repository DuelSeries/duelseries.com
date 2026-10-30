'use strict';
// One worker process of the capacity test (forked by scripts/capacity/run.js). It runs the players the parent hands it
// and every report period sends back one window per game: how many are connected and seated, each seated player's
// update rate, gaps, ping samples and the running totals. Its own event-loop delay is sent too, so a load box that
// cannot keep up shows up as such instead of as a slow server.

const { monitorEventLoopDelay } = require('perf_hooks');
const { ClientStats, mulberry32, ipOf } = require('./lib');

const GAMES = {};
function gameMod(id) {
  if (!GAMES[id]) GAMES[id] = require('./games/' + id + '.js');
  return GAMES[id];
}

const base = process.env.LT_BASE;
const players = []; // { game, stats, ctl, index }
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let lastCpu = process.cpuUsage();
let lastAt = Date.now();

function add(msg) {
  const stats = new ClientStats(msg.game);
  const p = { game: msg.game, stats, ctl: null, index: msg.index };
  players.push(p);
  try {
    p.ctl = gameMod(msg.game).start({
      base, ip: ipOf(msg.index), name: (msg.namePrefix || 'Load') + msg.index, index: msg.index, stats,
      rand: mulberry32(msg.index * 2654435761 + 7), opts: msg.opts || {},
      log: (m) => process.send({ type: 'log', text: '[' + msg.game + ' ' + msg.index + '] ' + m }),
    });
  } catch (e) {
    stats.error('start:' + (e && e.message));
  }
}

function window() {
  const now = Date.now();
  const dt = (now - lastAt) / 1000;
  const windowStart = lastAt;
  lastAt = now;
  const cpu = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  const byGame = {};
  for (const p of players) {
    const g = byGame[p.game] || (byGame[p.game] = {
      n: 0, connected: 0, seated: 0, rates: [], bytes: 0, gaps100: 0, gaps250: 0, gaps1000: 0, maxGap: 0, rtts: [], grtts: [],
      pingTimeouts: 0, joins: 0, deaths: 0, drops: 0, connects: 0, connectErrors: 0, refusals: {}, errors: {}, notes: {},
    });
    const w = p.stats.takeWindow(windowStart);
    g.n++;
    if (w.connected) g.connected++;
    if (w.seated) g.seated++;
    if (w.whole) g.rates.push(w.snaps / dt);
    g.bytes += w.bytes;
    g.gaps100 += w.gaps100;
    g.gaps250 += w.gaps250;
    g.gaps1000 += w.gaps1000;
    if (w.maxGap > g.maxGap) g.maxGap = w.maxGap;
    for (const r of w.rtts) g.rtts.push(r);
    for (const r of w.grtts) g.grtts.push(r);
    g.pingTimeouts += w.pingTimeouts;
    const s = p.stats;
    g.joins += s.joins;
    g.deaths += s.deaths;
    g.drops += s.drops;
    g.connects += s.connects;
    g.connectErrors += s.connectErrors;
    for (const k in s.refusals) g.refusals[k] = (g.refusals[k] || 0) + s.refusals[k];
    for (const k in s.errors) g.errors[k] = (g.errors[k] || 0) + s.errors[k];
    for (const k in s.notes) g.notes[k] = (g.notes[k] || 0) + s.notes[k];
  }
  const out = {
    type: 'window', at: now, dt, byGame,
    worker: { cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / (dt * 1000)) * 100), loopP99: Math.round(loop.percentile(99) / 1e6),
      loopMax: Math.round(loop.max / 1e6), rssMB: Math.round(process.memoryUsage().rss / 1048576) },
  };
  loop.reset();
  process.send(out);
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.cmd === 'add') add(msg);
  else if (msg.cmd === 'window') window();
  else if (msg.cmd === 'remove') {
    // stop the newest players of a game first
    let left = msg.count;
    for (let i = players.length - 1; i >= 0 && left > 0; i--) {
      if (players[i].game !== msg.game) continue;
      try { players[i].ctl && players[i].ctl.stop(); } catch (_) { /* gone */ }
      players.splice(i, 1);
      left--;
    }
  } else if (msg.cmd === 'stop') {
    for (const p of players) {
      try { p.ctl && p.ctl.stop(); } catch (_) { /* gone */ }
    }
    setTimeout(() => process.exit(0), 1500);
  }
});

process.on('uncaughtException', (e) => {
  process.send({ type: 'log', text: 'uncaught ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e) });
});
