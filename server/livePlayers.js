'use strict';
/* livePlayers.js: the owner's live view of REAL players, and today's numbers per lobby (Owen 2026-10-30: "if someone
   joins a match, I need that number to instantly pop up so I can see it and I can join that match", and "how many
   players throughout the day were in each of those lobbies").

   WHERE THE PEOPLE COME FROM. Every join path already calls joinAlerts.joined (the phone push) once the seat or the
   queue place exists; index.js hands each of those calls here too, and the slither process (server split) sends its
   own free and battle royale seats as 'presence' messages, ungated. One entry per socket (or, for a paid seat that
   names no socket, per wallet and lobby), dropped when its socket disconnects. So a join is seen the moment it
   happens, without any game being asked anything new.

   WHAT "REAL" MEANS. Bots are never sockets, so they never get here. Of the sockets that do:
     load   a capacity-test player: its address is in 198.18.0.0/15 (clientAddr.isLoadTestAddr)
     auto   one of our own tools: a valid ds_auto token on its handshake (server/autoMark.js: the video recorder,
            test harnesses, a Claude session's test browser)
     owner  Owen himself: a paid seat whose verified payer is an owner wallet, or the owner's socket (his console
            cookie, or a wallet the socket proved)
     real   everybody else
   A check that throws counts as real: the view may show one person too many, never hide one.

   KEEPING IT HONEST. A socket can stay connected after its player is out of the room (a death screen, a menu), and a
   paid seat that named no socket never disconnects here. So once a second the counts are held to what the rooms
   themselves say (the /api/live board's humans per row): a lobby never shows more real people than it holds, except
   for the first few seconds of a join (the slither process reports its rows once a second, so a fresh join may not
   be in them yet). Paid entries without a socket are dropped once their row is empty.

   WHAT LEAVES. Only to the owner's own console sockets: names (as players chose them), game, rung, counts. Never a
   wallet or an address: those are only ever hashed here, into the per-day unique counts.

   Every entry point is one try/catch and returns nothing a caller waits on: a lost update can never cost a seat. */

const crypto = require('crypto');
const { socketClientIp, addressGroup, isLoadTestAddr } = require('./clientAddr');
const { cleanName, rungText, GAMES } = require('./joinAlerts');
const autoMark = require('./autoMark');

const TZ = 'America/Toronto';
const FRESH_MS = 4000;          // a join counts before the board shows it, for this long
const TOAST_LATCH_MS = 3 * 60 * 1000;   // the same person in the same lobby again: no second toast
const NAMES_SHOWN = 6;
const TESTS_SHOWN = 40;
const MAX_ENTRIES = 20000;
const MAX_UNIQ = 5000;
const SAVE_EVERY_MS = 15000;
const EMIT_DELAY_MS = 60;

// joinAlerts' game ids -> the board's (the lobby's) game ids
const BOARD_GAME = Object.freeze({ sl: 'snake', snake: 'snake', shooter: 'omgshooter' });
const GAME_NAME = Object.freeze(Object.assign({}, GAMES, { omgshooter: GAMES.shooter, snake: GAMES.sl }));
// The page's order when nobody is anywhere: the lobby's
const ORDER = ['snake', 'br', 'paper', 'agar', 'chomp', 'knockout', 'battleship', 'swim', 'headsoccer', 'pool8',
  'airhockey', 'rooftop', 'crossy', 'tanks', 'omgshooter'];
const DUELS = new Set(['knockout', 'battleship', 'swim', 'headsoccer', 'pool8', 'airhockey', 'rooftop', 'crossy', 'tanks']);
const CLASSES = ['real', 'auto', 'load', 'owner'];

const boardGame = (g) => (Object.prototype.hasOwnProperty.call(BOARD_GAME, g) ? BOARD_GAME[g] : String(g || ''));
function stakeOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}
const keyOf = (game, stake) => game + ':' + String(stakeOf(stake));
const kindOf = (game) => (game === 'br' ? 'event' : DUELS.has(game) ? 'duel' : 'arena');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

// 'YYYY-MM-DD' and the hour (0-23) in Toronto for a time in ms
let fmt = null;
function torontoOf(ms) {
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hourCycle: 'h23' });
  }
  const p = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { day: p.year + '-' + p.month + '-' + p.day, hour: Math.min(23, Math.max(0, Number(p.hour) || 0)) };
}

// ── one day's numbers ──────────────────────────────────────────────────────
function newPart() {
  return { peak: 0, peakAt: 0, uniq: new Set(), hours: Array.from({ length: 24 }, () => ({ peak: 0, uniq: new Set() })) };
}
function newDay(day) {
  return { day, all: newPart(), lobbies: new Map(), dirty: false };
}
function partOf(d, key) {
  let p = d.lobbies.get(key);
  if (!p) { p = newPart(); d.lobbies.set(key, p); }
  return p;
}
function addUniq(set, h) {
  if (set.has(h) || set.size >= MAX_UNIQ) return false;
  set.add(h);
  return true;
}
function partJson(p) {
  return { peak: p.peak, peakAt: p.peakAt, uniq: [...p.uniq], hours: p.hours.map((x) => [x.peak, [...x.uniq]]) };
}
function partMerge(p, j) {
  if (!j || typeof j !== 'object') return;
  if (Number(j.peak) > p.peak) { p.peak = Number(j.peak); p.peakAt = Number(j.peakAt) || 0; }
  for (const h of Array.isArray(j.uniq) ? j.uniq : []) if (typeof h === 'string') addUniq(p.uniq, h);
  const hrs = Array.isArray(j.hours) ? j.hours : [];
  for (let i = 0; i < 24 && i < hrs.length; i++) {
    const x = hrs[i];
    if (!Array.isArray(x)) continue;
    if (Number(x[0]) > p.hours[i].peak) p.hours[i].peak = Number(x[0]);
    for (const h of Array.isArray(x[1]) ? x[1] : []) if (typeof h === 'string') addUniq(p.hours[i].uniq, h);
  }
}
function dayJson(d) {
  const lobbies = {};
  for (const [k, p] of d.lobbies) lobbies[k] = partJson(p);
  return { v: 1, day: d.day, all: partJson(d.all), lobbies };
}
function dayMerge(d, j) {
  if (!j || typeof j !== 'object' || j.day !== d.day) return;
  partMerge(d.all, j.all);
  const l = j.lobbies && typeof j.lobbies === 'object' ? j.lobbies : {};
  for (const k of Object.keys(l)) if (/^[a-z0-9]{1,16}:[0-9.]{1,6}$/.test(k)) partMerge(partOf(d, k), l[k]);
}

function labelOf(key) {
  const i = key.lastIndexOf(':');
  const game = key.slice(0, i);
  const stake = stakeOf(key.slice(i + 1));
  return { game, stake, name: GAME_NAME[game] || game, rung: game === 'br' ? 'Event' : rungText(stake) };
}

/* deps:
     isOwnerWallet(w), isOwnerSocket(socket), provenWallet(socket)   (index.js; each optional)
     board() -> { rows: [{ game, stake, players, bots, waiting, capacity, state }], br: { humans, bots, joinable,
               state } | null, soon: [game ids] }   the rooms' own counts (index.js, from liveSnapshot)
     emit(event, payload)   to every owner console socket;   watching() -> is one connected
     store: { load(day) -> Promise<json|null>, save(day, json) -> Promise }   (Postgres in index.js; optional)
     now, log, timers ({ setInterval, clearInterval, setTimeout }), autoTick (false: tests call tick()) */
function createLivePlayers(deps) {
  const d = deps || {};
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const log = d.log || console;
  const T = d.timers || { setInterval, clearInterval, setTimeout, clearTimeout };
  const ask = (fn, ...a) => { try { return typeof fn === 'function' ? fn(...a) : undefined; } catch (_) { return undefined; } };
  const store = d.store && typeof d.store.load === 'function' && typeof d.store.save === 'function' ? d.store : null;

  const entries = new Map();     // id -> entry
  const hooked = new WeakSet();  // sockets whose disconnect we listen to
  const latch = new Map();       // lobby|person -> ms of its last toast
  let board = { rows: [], br: null, soon: [] };
  let state = null;              // the last state sent
  let sig = '';
  let emitT = null;
  let today = newDay(torontoOf(now()).day);
  let yesterday = null;
  let loaded = !store;           // nothing is saved over a day until the stored copy was read (or there is none)
  let loading = false;
  let loadAfter = 0;             // the next read after a failed one (the database may still be starting)
  let loadWarned = 0;
  let lastSave = 0;
  let joinSeq = 0;

  // ── who is this ──
  function classOf(info) {
    try {
      if (info.ip && isLoadTestAddr(info.ip)) return 'load';
      if (autoMark.valid(info.autoToken, now())) return 'auto';
      if (info.paid && typeof info.wallet === 'string' && info.wallet && ask(d.isOwnerWallet, info.wallet) === true) return 'owner';
      if (info.socket && ask(d.isOwnerSocket, info.socket) === true) return 'owner';
    } catch (_) { /* a check that fails is a person */ }
    return 'real';
  }
  function personOf(info, name) {
    let w = info.paid && typeof info.wallet === 'string' && info.wallet ? info.wallet : null;
    if (!w && info.socket) { const p = ask(d.provenWallet, info.socket); if (typeof p === 'string' && p) w = p; }
    if (w) return hash('w:' + w);
    let g = '';
    try { g = info.ip ? addressGroup(info.ip) : ''; } catch (_) { g = ''; }
    return hash('a:' + g + '|' + name.toLowerCase());
  }

  // ── entries ──
  function upsert(info) {
    const game = boardGame(info.game);
    if (!game) return;
    const stake = game === 'br' ? 0 : stakeOf(info.stake);
    const lobby = keyOf(game, stake);
    const name = cleanName(info.name);
    const t = now();
    const prev = entries.get(info.id);
    if (prev && prev.lobby === lobby) { prev.seen = t; prev.queued = !!info.queued; return; }
    if (!prev && entries.size >= MAX_ENTRIES) return;
    const cls = classOf(info);
    const person = personOf(info, name);
    const e = { id: info.id, src: info.src || 'main', lobby, game, stake, name, cls, person, at: t, seen: t,
      queued: !!info.queued, socketBound: !!info.socketBound, sock: info.src === 'main' ? info.socket || null : null };
    entries.set(info.id, e);
    if (cls === 'real') arrived(e);
    schedule();
  }
  function arrived(e) {
    rollDay();
    const hr = torontoOf(e.at).hour;
    const p = partOf(today, e.lobby);
    const a = addUniq(p.uniq, e.person);
    const b = addUniq(p.hours[hr].uniq, e.person);
    const c = addUniq(today.all.uniq, e.person);
    const e2 = addUniq(today.all.hours[hr].uniq, e.person);
    if (a || b || c || e2) today.dirty = true;
    const lk = e.lobby + '|' + e.person;
    const last = latch.get(lk);
    if (last && e.at - last < TOAST_LATCH_MS) return;
    latch.delete(lk);
    latch.set(lk, e.at);
    while (latch.size > 2000) latch.delete(latch.keys().next().value);
    const l = labelOf(e.lobby);
    ask(d.emit, 'owner:live:join', { id: ++joinSeq, at: e.at, name: e.name, lobby: e.lobby, game: l.game,
      gameName: l.name, stake: l.stake, rung: l.rung, queued: e.queued, kind: kindOf(l.game) });
  }
  function drop(id) {
    if (entries.delete(id)) schedule();
  }
  function hook(socket, id) {
    if (!socket || typeof socket.once !== 'function' || hooked.has(socket)) return;
    hooked.add(socket);
    socket.once('disconnect', () => { try { drop(id); } catch (_) { /* never */ } });
  }

  /* From joinAlerts' call sites (index.js tees every joinAlerts.joined call here).
     info: { game, stake, name, wallet (a paid seat's verified payer), queued, socket } */
  function joined(info) {
    try {
      if (!info || typeof info !== 'object') return;
      const paid = Number(info.stake) > 0;
      const s = info.socket && typeof info.socket === 'object' && typeof info.socket.id === 'string' ? info.socket : null;
      const wallet = typeof info.wallet === 'string' ? info.wallet : '';
      if (!s && !(paid && wallet)) return;   // nobody to follow: nothing would ever say they left
      const id = s ? 'm:' + s.id : 'w:' + boardGame(info.game) + ':' + stakeOf(info.stake) + ':' + wallet;
      let ip = '';
      if (s) { try { ip = socketClientIp(s) || ''; } catch (_) { ip = ''; } }
      upsert({ id, src: 'main', game: info.game, stake: info.stake, name: info.name, wallet, paid, queued: info.queued,
        socket: s, ip, autoToken: s ? autoMark.fromSocket(s) : '', socketBound: !!s });
      if (s) hook(s, id);
    } catch (e) {
      try { log.error('[LIVE-PLAYERS] join dropped: ' + (e && e.message)); } catch (_) { /* never */ }
    }
  }

  /* From the slither process (server split): m = { op: 'join' | 'leave', sid, where: 'free' | 'br', name, h, ip }.
     h is the handshake's headers as the process forwards them (the owner cookie and ds_auto only). */
  function presence(m) {
    try {
      if (!m || typeof m !== 'object' || typeof m.sid !== 'string' || !m.sid) return;
      const id = 'sl:' + m.sid;
      if (m.op === 'leave') return drop(id);
      if (m.op !== 'join') return;
      const h = m.h && typeof m.h === 'object' ? m.h : {};
      const socket = { request: { method: 'GET', headers: h }, handshake: { headers: h } };
      upsert({ id, src: 'sl', game: m.where === 'br' ? 'br' : 'sl', stake: 0, name: m.name, paid: false,
        socket, ip: typeof m.ip === 'string' ? m.ip : '', autoToken: autoMark.fromCookie(h.cookie), socketBound: true });
    } catch (e) {
      try { log.error('[LIVE-PLAYERS] presence dropped: ' + (e && e.message)); } catch (_) { /* never */ }
    }
  }

  // Everybody a source reported (the slither process stopped or started again: its sockets are gone).
  function dropSource(src) {
    try {
      let n = 0;
      for (const [id, e] of entries) if (e.src === src) { entries.delete(id); n++; }
      if (n) schedule();
    } catch (_) { /* never */ }
  }

  // ── the state the console draws ──
  function readBoard() {
    const b = ask(d.board);
    if (b && typeof b === 'object' && Array.isArray(b.rows)) board = b;
    return board;
  }

  function compute() {
    const t = now();
    const b = readBoard();
    const rooms = new Map();   // lobby key -> row
    const row = (key) => {
      let r = rooms.get(key);
      if (!r) {
        const l = labelOf(key);
        r = { key, game: l.game, name: l.name, stake: l.stake, rung: l.rung, kind: kindOf(l.game), humans: null,
          bots: 0, waiting: 0, capacity: null, state: 'open', joinable: true, soon: false,
          real: 0, auto: 0, load: 0, owner: 0, names: [], last: 0 };
        rooms.set(key, r);
      }
      return r;
    };
    for (const x of b.rows) {
      if (!x || typeof x !== 'object' || typeof x.game !== 'string') continue;
      const r = row(keyOf(x.game, x.stake));
      r.humans = (r.humans || 0) + Math.max(0, Number(x.players) || 0);
      r.bots += Math.max(0, Number(x.bots) || 0);
      r.waiting += Math.max(0, Number(x.waiting) || 0);
      if (Number.isFinite(Number(x.capacity)) && x.capacity !== null) r.capacity = Number(x.capacity);
      if (x.state === 'closed') r.state = 'closed';
    }
    if (b.br && typeof b.br === 'object') {
      const r = row('br:0');
      r.humans = Math.max(0, Number(b.br.humans) || 0);
      r.bots = Math.max(0, Number(b.br.bots) || 0);
      r.joinable = b.br.joinable !== false;
      r.state = String(b.br.state || 'open');
    }
    const soon = new Set(Array.isArray(b.soon) ? b.soon : []);

    // a socket that left without its disconnect reaching us; paid seats with no socket leave when their row empties
    // (or holds fewer people than they are), oldest first
    for (const [id, e] of entries) if (e.sock && e.sock.connected === false) entries.delete(id);
    let list = [...entries.values()].sort((a, c) => c.at - a.at);
    for (const [key, r] of rooms) {
      if (r.humans === null) continue;
      const bare = list.filter((e) => e.lobby === key && !e.socketBound && t - e.at >= FRESH_MS);
      const keep = Math.max(0, r.humans - list.filter((e) => e.lobby === key && e.socketBound).length);
      for (let i = keep; i < bare.length; i++) entries.delete(bare[i].id);
    }
    if (list.length !== entries.size) list = list.filter((e) => entries.has(e.id));

    // presence, newest first
    const counts = new Map();   // key -> { real, fresh, auto, load, owner }
    for (const e of list) {
      const r = row(e.lobby);
      let c = counts.get(e.lobby);
      if (!c) { c = { real: 0, fresh: 0, auto: 0, load: 0, owner: 0 }; counts.set(e.lobby, c); }
      c[e.cls]++;
      if (e.cls === 'real') {
        if (t - e.at < FRESH_MS) c.fresh++;
        if (r.names.length < NAMES_SHOWN) r.names.push(e.name);
        if (e.at > r.last) r.last = e.at;
      }
    }

    let real = 0, test = 0, you = 0, load = 0;
    for (const [key, c] of counts) {
      const r = rooms.get(key);
      const cap = r.humans === null ? Infinity : r.humans;
      // a join the room's own count may not have yet (the slither process reports once a second) counts on top of it
      r.real = Math.min(c.real, cap + c.fresh);
      if (r.names.length > r.real) r.names.length = r.real;
      let left = Math.max(0, cap - r.real);
      r.auto = Math.min(c.auto, left); left -= r.auto;
      r.load = Math.min(c.load, left); left -= r.load;
      r.owner = Math.min(c.owner, left);
      real += r.real; test += r.auto; load += r.load; you += r.owner;
    }
    for (const r of rooms.values()) {
      r.soon = soon.has(r.game);
      r.full = r.capacity !== null && r.humans !== null && r.capacity > 0 && r.humans >= r.capacity;
    }

    const rank = (g) => { const i = ORDER.indexOf(g); return i < 0 ? ORDER.length : i; };
    const lobbies = [...rooms.values()].sort((a, c) => (c.real > 0) - (a.real > 0) || c.real - a.real
      || c.last - a.last || rank(a.game) - rank(c.game) || a.stake - c.stake);
    const tests = [];
    const loads = new Map();
    for (const e of list) {
      if (e.cls === 'real') continue;
      if (e.cls === 'load') { loads.set(e.lobby, (loads.get(e.lobby) || 0) + 1); continue; }
      if (tests.length < TESTS_SHOWN) {
        const l = labelOf(e.lobby);
        tests.push({ kind: e.cls === 'owner' ? 'you' : 'tool', name: e.name, lobby: e.lobby, where: l.name + ' ' + l.rung });
      }
    }
    for (const [lobby, n] of loads) {
      const l = labelOf(lobby);
      tests.push({ kind: 'load', name: n + ' load test ' + (n === 1 ? 'player' : 'players'), lobby, where: l.name + ' ' + l.rung, count: n });
    }

    // today's peaks
    rollDay();
    const hr = torontoOf(t).hour;
    for (const r of rooms.values()) {
      if (!r.real) continue;
      const p = partOf(today, r.key);
      if (r.real > p.peak) { p.peak = r.real; p.peakAt = t; today.dirty = true; }
      if (r.real > p.hours[hr].peak) { p.hours[hr].peak = r.real; today.dirty = true; }
    }
    if (real > today.all.peak) { today.all.peak = real; today.all.peakAt = t; today.dirty = true; }
    if (real > today.all.hours[hr].peak) { today.all.hours[hr].peak = real; today.dirty = true; }

    return {
      day: today.day,
      totals: { real, test, load, you },
      today: { peak: today.all.peak, uniq: today.all.uniq.size },
      lobbies: lobbies.map((r) => ({ key: r.key, game: r.game, name: r.name, stake: r.stake, rung: r.rung, kind: r.kind,
        real: r.real, auto: r.auto, load: r.load, you: r.owner, bots: r.bots, humans: r.humans === null ? null : r.humans,
        waiting: r.waiting, capacity: r.capacity, full: !!r.full, state: r.state, joinable: r.joinable, soon: r.soon,
        names: r.names, last: r.last })),
      tests,
    };
  }

  function send(force) {
    const s = compute();
    const k = JSON.stringify(s);
    state = s;
    if (!force && k === sig) return;
    sig = k;
    ask(d.emit, 'owner:live', Object.assign({ at: now() }, s));
  }
  function schedule() {
    if (emitT) return;
    emitT = T.setTimeout(() => { emitT = null; try { send(false); } catch (e) { log.error('[LIVE-PLAYERS] ' + e.message); } }, EMIT_DELAY_MS);
    if (emitT && typeof emitT.unref === 'function') emitT.unref();
  }

  // ── the day ──
  function rollDay() {
    const day = torontoOf(now()).day;
    if (day === today.day) return;
    saveNow(today);
    yesterday = today;
    today = newDay(day);
    latch.clear();
  }
  function load() {
    if (loaded || loading || !store || now() < loadAfter) return;
    loading = true;
    const day = today.day;
    Promise.resolve().then(() => store.load(day)).then((j) => {
      if (j && today.day === day) { dayMerge(today, j); today.dirty = true; }
      loaded = true;
    }, (e) => {
      loadAfter = now() + 30000;
      if (now() - loadWarned > 10 * 60 * 1000) {
        loadWarned = now();
        log.warn('[LIVE-PLAYERS] could not read today\'s numbers yet (trying every 30 s): ' + (e && e.message));
      }
    }).finally(() => { loading = false; });
  }
  function saveNow(day) {
    if (!store || !loaded || !day.dirty) return;
    day.dirty = false;
    lastSave = now();
    Promise.resolve().then(() => store.save(day.day, dayJson(day))).catch((e) => {
      day.dirty = true;
      log.warn('[LIVE-PLAYERS] could not save today\'s numbers: ' + (e && e.message));
    });
  }

  // Once a second: the rooms' own counts, the day, the save. Skipped while nobody is present and nobody watches.
  function tick() {
    try {
      load();
      rollDay();
      if (entries.size || ask(d.watching) === true) send(false);
      if (now() - lastSave >= SAVE_EVERY_MS) saveNow(today);
    } catch (e) {
      try { log.error('[LIVE-PLAYERS] tick: ' + (e && e.message)); } catch (_) { /* never */ }
    }
  }
  let timer = null;
  if (d.autoTick !== false) {
    timer = T.setInterval(tick, 1000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // The whole state, for a console socket that just connected.
  function snapshot() {
    try {
      const s = compute();
      state = s;
      return Object.assign({ at: now() }, s);
    } catch (e) {
      return { at: now(), day: today.day, totals: { real: 0, test: 0, load: 0, you: 0 }, today: { peak: 0, uniq: 0 },
        lobbies: [], tests: [], error: 'not available' };
    }
  }

  function dayView(dd) {
    const part = (p) => ({ peak: p.peak, peakAt: p.peakAt, uniq: p.uniq.size, hours: p.hours.map((x) => [x.peak, x.uniq.size]) });
    const lobbies = [];
    for (const [k, p] of dd.lobbies) lobbies.push(Object.assign({ key: k }, labelOf(k), part(p)));
    lobbies.sort((a, b) => b.uniq - a.uniq || b.peak - a.peak || a.key.localeCompare(b.key));
    return { day: dd.day, all: part(dd.all), lobbies };
  }
  /* Today's numbers (or yesterday's: which 'yesterday'), for the Today tab. -> Promise of the view. */
  async function dayStats(which) {
    rollDay();
    if (which !== 'yesterday') return Object.assign({ tz: TZ, hour: torontoOf(now()).hour }, dayView(today));
    const [yy, mm, dd0] = today.day.split('-').map(Number);
    const day = new Date(Date.UTC(yy, mm - 1, dd0 - 1)).toISOString().slice(0, 10);
    let y = yesterday && yesterday.day === day ? yesterday : null;
    if (!y && store) {
      y = newDay(day);
      try { dayMerge(y, await store.load(day)); } catch (_) { /* an empty day */ }
    }
    return Object.assign({ tz: TZ, hour: 23 }, dayView(y || newDay(day)));
  }

  function stop() {
    if (timer) T.clearInterval(timer);
    timer = null;
    saveNow(today);
  }

  return { joined, presence, dropSource, tick, snapshot, dayStats, stop, classOf,
    _entries: entries, _today: () => today };
}

/* The Postgres store: one row per Toronto day, the day's numbers as JSON (hashes only, never a wallet or an address).
   The table is made on first use. pool: db.readPool (its own few connections and a statement timeout, so this never
   waits on, or holds up, anything that moves money). */
function pgStore(pool) {
  let made = null;
  const ensure = () => {
    if (!made) {
      made = pool.query(`CREATE TABLE IF NOT EXISTS owner_live_days (
        day        TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`).catch((e) => { made = null; throw e; });
    }
    return made;
  };
  return {
    async load(day) {
      await ensure();
      const r = await pool.query('SELECT data FROM owner_live_days WHERE day = $1', [day]);
      return r.rows && r.rows[0] ? r.rows[0].data : null;
    },
    async save(day, json) {
      await ensure();
      await pool.query(`INSERT INTO owner_live_days (day, data, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT (day) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [day, JSON.stringify(json)]);
    },
  };
}

module.exports = { createLivePlayers, pgStore, torontoOf, keyOf, boardGame, CLASSES, TZ };
