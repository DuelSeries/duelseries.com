'use strict';
// The `rooms` part of GET /api/debug/tick (server/index.js): one row per room this process runs, keyed by the
// room's lobbyType (na_free, na_s0, na_br, ag_na_s0, paper_na_s0, tanks, ...). Kept out of index.js so the row
// shapes have tests.
//
// Snake rooms (GameRoom, the battle royale included) report the tick-lag and broadcast-gap counters GameRoom keeps;
// agar.io rooms report their full tick timing (server/tickTimer.js); Paper arenas and the tanks arena report what
// they already count (seats, ticks or broadcasts, whether their clock is running), so two reads give their rates.
const { TIMING } = require('./tickTimer');

function round(v) {
  return Number.isFinite(v) ? Math.round(v) : null;
}

function agoSec(at, now) {
  return at ? Math.round((now - at) / 1000) : null;
}

// ?recent=N raw recent ticks per agar room, ?recent=all the whole ring; anything else gives the default.
function parseRecent(q) {
  if (q === 'all') return 'all';
  const n = Math.floor(Number(q));
  return Number.isFinite(n) && n >= 0 ? n : TIMING.DEFAULT_RECENT;
}

function stallList(list, now) {
  return (list || []).map((r) => ({ ms: r.ms, at: r.at, agoSec: agoSec(r.at, now) }));
}

// A snake room that has ticked: the same fields the endpoint always had, each recent stall with its absolute time.
function snakeRow(room, now) {
  const lag = room && room._lag;
  if (!lag || !lag.ticks) return null;
  const bc = room._bc;
  return {
    game: 'snake',
    ticks: lag.ticks,
    lateTicks: lag.late,
    latePct: +(100 * lag.late / lag.ticks).toFixed(3),
    worstMs: round(lag.worst),
    worstAt: lag.worstAt || null,
    worstAgoSec: agoSec(lag.worstAt, now),
    recent: stallList(lag.recent, now),
    // Whether the SERVER failed to send, as opposed to the packet arriving late (see GameRoom.broadcastSnapshot).
    broadcast: bc ? {
      sends: bc.count,
      lateSends: bc.late,
      worstMs: round(bc.worst),
      worstAt: bc.worstAt || null,
      worstAgoSec: agoSec(bc.worstAt, now),
      recent: stallList(bc.recent, now),
    } : null,
  };
}

// An agar.io room (server/ag/agRoom.js): its counters and its tick timing. `ticks` is the room's own count of
// completed steps, which tickMsHist.n matches; lateHist and stepsPerWake count timer wakes.
function agRow(room, { recent } = {}) {
  if (!room || !room.timing) return null;
  const s = room.stats || {};
  return Object.assign({
    game: 'agar',
    index: room.index,
    seats: room.seats ? room.seats.size : 0,
    players: room.playerCount,
    bots: room.botCount,
    ticking: !!room.timer,
    ticks: s.ticks,
    bundles: s.bundles,
    bytes: s.bytes,
    skipped: s.skipped,
    resyncs: s.resyncs,
    buildErrors: s.buildErrors,
    emitErrors: s.emitErrors,
    viewRestarts: s.viewRestarts,
  }, room.timing.report({ recent }));
}

function paperRow(room) {
  if (!room) return null;
  return {
    game: 'paper',
    seats: room.seats ? room.seats.size : 0,
    players: room.playerCount,
    bots: room.botCount,
    ticking: !!room.timer,
    ticks: room.game && Number.isFinite(room.game.tick) ? room.game.tick : null,
  };
}

function shooterRow(room) {
  if (!room) return null;
  return {
    game: 'shooter',
    players: room.playerCount,
    bots: room.botCount,
    ticking: !!room.timer,
    broadcasts: Number.isFinite(room.seq) ? room.seq : null,
  };
}

// Builds the rooms object. A second room under a key already taken gets '~2', '~3', ... so no row hides another.
function roomRows({ snakeRooms = [], agRooms = [], paperRooms = [], shooterRooms = [], now = Date.now(),
  recent = TIMING.DEFAULT_RECENT } = {}) {
  const out = {};
  const put = (room, row, fallback) => {
    if (!row) return;
    const base = String((room && room.lobbyType) || fallback);
    let key = base;
    for (let n = 2; Object.prototype.hasOwnProperty.call(out, key); n++) key = base + '~' + n;
    out[key] = row;
  };
  for (const r of snakeRooms) put(r, snakeRow(r, now), 'snake');
  for (const r of agRooms) put(r, agRow(r, { recent }), 'ag');
  for (const r of paperRooms) put(r, paperRow(r), 'paper');
  for (const r of shooterRooms) put(r, shooterRow(r), 'shooter');
  return out;
}

module.exports = { roomRows, snakeRow, agRow, paperRow, shooterRow, parseRecent };
