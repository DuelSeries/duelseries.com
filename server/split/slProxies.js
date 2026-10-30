'use strict';
// What the main server reads in place of the free room and the battle royale while they run in the slither process
// (the server split, spec 6.1 and 7). Pure: every function takes a view of the link, { snap(), fresh(), send(msg),
// call(op, args), decided(), setDoorWanted(open), setExtraLoad(fn) }, and builds plain objects from the last snapshot
// (server/split/ipcEnvelope.js SNAP, about once a second).
//
// MISSING IS NEVER 0 (spec 7.2). A snapshot is fresh for 5 s of the main server's clock; once it is not:
//   boardRows() and humanTotal() THROW (/api/live then says unknown 'sl' and the old free rung keeps its row, today's
//   fault rule; the lobby card's count reads 0, which is cosmetic); all() is [] (no room in the console or the drain);
//   isLive(), canStart() and acceptingPlayers() are false; the match's state is 'unknown' (an owner Start, an engine
//   switch and the slot timer all refuse it); publicState() is the last copy saying 'unknown' and never throws.
// The drain's own "not reporting" reason, the empty br and the unknown 'br' are index.js's (X12 to X14).
//
// Money: none of this holds any. A room proxy has money null, stake 0, floorWorth 0 and no liveStakeTotal, and its
// snakes are the seated humans at worth 0, so ops.drainStatus counts free players and never a stake. The battle
// royale's decision (decisionProxy) is what the main server's payBattleRoyaleWinner reads: its winner, the proven
// seats and prizeHeld, which is passed on only as a boolean (anything else is null, and null holds the prize).

const STALE = 'the slither process is not reporting';

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

// A Map that can be read and never written: a remote room's snakes are a picture of the other process.
function readOnlyMap(entries) {
  const m = new Map(entries);
  const no = () => { throw new TypeError('a remote room\'s snakes are read only'); };
  Object.defineProperties(m, { set: { value: no }, delete: { value: no }, clear: { value: no } });
  return Object.freeze(m);
}

// One snapshot room row as the console and the drain read a room (ownerConsole rungRows, opsSnapshot, roomLabel,
// ops.drainStatus). addBot and clearBots exist so the console offers the room's bot controls (ownerConsole takesBots);
// /api/owner/do sends those commands to the slither process before either could be reached (slLink.ownsCommand).
function roomProxy(row) {
  const humans = [];
  for (let i = 0; i < row.humans; i++) humans.push(['h' + i, Object.freeze({ alive: true, isBot: false, worth: 0 })]);
  const refuse = () => { throw new Error('remote room: its bots are set through slLink.call'); };
  return Object.freeze({
    remote: true,
    lobbyType: row.lobbyType,
    isBattleRoyale: row.kind === 'br',
    index: row.index,
    stake: 0,
    playerCount: row.playerCount,
    botCount: row.botCount,
    botsAllowed: () => row.botsAllowed,
    bots: Object.freeze({ count: () => row.botCount, target: () => row.botTarget }),
    botCurve: () => row.botAim,
    _botsHeld: row.botsHeld,
    _botsPausedUntil: row.pausedUntil,
    snakes: readOnlyMap(humans),
    money: null,
    paid: false,
    floorWorth: 0,
    addBot: refuse,
    clearBots: refuse,
  });
}

// The room proxies of one snapshot, built once per snapshot.
const ROOMS = new WeakMap();
function roomsOf(snap) {
  if (!isObj(snap)) return [];
  let rooms = ROOMS.get(snap);
  if (!rooms) {
    rooms = (Array.isArray(snap.rooms) ? snap.rooms : []).map(roomProxy);
    ROOMS.set(snap, rooms);
  }
  return rooms;
}

const freshSnap = (view) => (view.fresh() ? view.snap() : null);

// The free room's governor for the main server's paid rooms (spec 7.4): the slither process's real one, read from the
// snapshot. Neutral while it is not reporting (mult 1, not engaged), which is what a governor with no sample does.
// admitBot is slBots createBotGovernor's rule on those values.
function mirrorGovernor(view) {
  const gov = () => {
    const s = freshSnap(view);
    return s && isObj(s.gov) ? s.gov : null;
  };
  const engaged = () => {
    const g = gov();
    return !!g && g.engaged === true;
  };
  const mult = () => {
    const g = gov();
    return g && Number.isFinite(g.mult) && g.mult > 0 && g.mult <= 1 ? g.mult : 1;
  };
  const whole = (v, what) => {
    if (!Number.isInteger(v) || v < 0) throw new TypeError('slProxies: ' + what + ' must be a whole number >= 0');
    return v;
  };
  return {
    mirror: true,
    sample: () => null,
    engaged,
    mult,
    admitBot(o) {
      if (engaged()) return { ok: false, why: 'governor' };
      const snakes = whole(o && o.snakes, 'snakes');
      const cap = !o || o.cap === null || o.cap === undefined ? Infinity : whole(o.cap, 'cap');
      if (snakes + 1 > cap) return { ok: false, why: 'cap' };
      return { ok: true, why: '' };
    },
    stats: () => ({ mirror: true, fresh: view.fresh(), engaged: engaged(), mult: mult(), why: '' }),
  };
}

// The free directory (index.js slArenas). local: { laws, shippableOnly, governor } as slBoot's remote branch made it.
function freeProxy(view, local) {
  const l = local || {};
  const rooms = () => {
    const s = freshSnap(view);
    return s ? roomsOf(s).filter((r) => !r.isBattleRoyale) : [];
  };
  return {
    remote: true,
    laws: l.laws,
    shippableOnly: l.shippableOnly,
    governor: l.governor,
    paidBusyNow: false,
    all: () => rooms(),
    room: () => rooms()[0] || null,
    isLive() {
      const s = freshSnap(view);
      return !!s && isObj(s.free) && s.free.live === true;
    },
    boardRows() {
      const s = freshSnap(view);
      if (!s || !isObj(s.free)) throw new Error(STALE);
      if (s.free.rowsErr) throw new Error(String(s.free.rowsErr));
      return (Array.isArray(s.free.rows) ? s.free.rows : []).map((r) => Object.assign({}, r));
    },
    humanTotal() {
      const s = freshSnap(view);
      if (!s || !isObj(s.free)) throw new Error(STALE);
      return s.free.humans;
    },
    // The owner's sl:door:off/on: remembered here (sent again in every init, so a restarted slither process keeps
    // it, and at ready when it changed while the process was starting) and sent now. Returns what was asked, as the
    // room's door does.
    door(open) {
      if (open !== true && open !== false) return open;
      view.setDoorWanted(open);
      Promise.resolve(view.call('door', { open })).catch(() => { /* a refusal is logged by the link */ });
      return open;
    },
    sweep: () => ({ replaced: false }),
    setExtraLoad(fn) {
      view.setExtraLoad(fn);
      return typeof fn === 'function';
    },
    close() {},
  };
}

// The decision a br.decided message (or a snapshot's decided block) carries, as payBattleRoyaleWinner reads a room:
// winner, matchId, soloRun, prizeHeld (a boolean or null; null holds the prize), startedPeople, startedWith,
// startedSeats(), holdPrize(id) (sent to the slither process, display only).
function decisionProxy(d, view) {
  const x = isObj(d) ? d : {};
  const w = isObj(x.winner) ? x.winner : null;
  const seats = (Array.isArray(x.seats) ? x.seats : []).filter(isObj).map((s) => ({
    wallet: typeof s.wallet === 'string' ? s.wallet : null,
    net: typeof s.net === 'string' ? s.net : '',
  }));
  return {
    remote: true,
    engine: 'sl',
    matchId: typeof x.matchId === 'string' && x.matchId ? x.matchId : null,
    winner: w ? { id: Number.isInteger(w.id) ? w.id : null, name: String(w.name), bot: w.bot === true,
      wallet: typeof w.wallet === 'string' && w.wallet ? w.wallet : null } : null,
    soloRun: !!x.soloRun,
    prizeHeld: typeof x.prizeHeld === 'boolean' ? x.prizeHeld : null,
    startedPeople: typeof x.startedPeople === 'number' ? x.startedPeople : undefined,
    startedWith: typeof x.startedWith === 'number' ? x.startedWith : 0,
    startedSeats: () => seats.map((s) => Object.assign({}, s)),
    holdPrize(id) {
      if (typeof id !== 'string' || !id) return false;
      view.send({ t: 'br.hold', matchId: id });
      return true;
    },
  };
}

// The battle royale's match (index.js activeBr() while the event is on the sl engine). The decision fields come from
// the LAST decided block (view.decided()), kept after the slither process died, so the 10 s backstop still pays a
// decision whose message was lost, once (_brPaid). The owner's Start and Stop never reach here (slLink.call).
function matchProxy(view) {
  const live = () => {
    const s = freshSnap(view);
    return s && isObj(s.br) && isObj(s.br.match) ? s.br.match : null;
  };
  const dec = () => {
    const d = view.decided();
    return d ? decisionProxy(d, view) : null;
  };
  let lastPublic = null;
  const remoteOnly = () => { throw new Error('remote battle royale: use slLink.call'); };
  return {
    remote: true,
    engine: 'sl',
    isBattleRoyale: true,
    get state() {
      const m = live();
      return m ? m.state : 'unknown';
    },
    get matchId() { const d = dec(); return d ? d.matchId : null; },
    get winner() { const d = dec(); return d ? d.winner : null; },
    get soloRun() { const d = dec(); return d ? d.soloRun : false; },
    get prizeHeld() { const d = dec(); return d ? d.prizeHeld : null; },
    get startedPeople() { const d = dec(); return d ? d.startedPeople : undefined; },
    get startedWith() { const d = dec(); return d ? d.startedWith : 0; },
    publicState() {
      try {
        const m = live();
        if (m && isObj(m.public)) {
          lastPublic = m.public;
          return clone(m.public);
        }
        const s = view.snap();
        const was = lastPublic || (s && isObj(s.br) && isObj(s.br.match) && isObj(s.br.match.public) ? s.br.match.public
          : null);
        return Object.assign(was ? clone(was) : { engine: 'sl', alive: 0, players: 0, humans: 0, winner: null,
          podium: null, prize: 0, prizeHeld: false }, { state: 'unknown', canStart: false });
      } catch (_) {
        return { engine: 'sl', state: 'unknown', alive: 0, players: 0, humans: 0, canStart: false };
      }
    },
    canStart() { const m = live(); return !!m && m.canStart === true; },
    acceptingPlayers() { const m = live(); return !!m && m.accepting === true; },
    humanLiving() { const m = live(); return m ? m.humanLiving : 0; },
    livingCount() { const m = live(); return m ? m.livingCount : 0; },
    startedSeats() { const d = dec(); return d ? d.startedSeats() : []; },
    holdPrize(id) {
      if (typeof id !== 'string' || !id) return false;
      view.send({ t: 'br.hold', matchId: id });
      return true;
    },
    // The slot timer's start only (index.js, every second): the slither process checks again that the arena is
    // waiting and can start before it starts anything.
    startMatch(why) {
      return view.call('br:autoStart', { why: String(why || 'slot').slice(0, 100) });
    },
    forceStart: remoteOnly,
    abandon: remoteOnly,
  };
}

// The battle royale's directory (index.js slBr).
function brProxy(view) {
  const match = matchProxy(view);
  const rooms = () => {
    const s = freshSnap(view);
    return s ? roomsOf(s).filter((r) => r.isBattleRoyale) : [];
  };
  return {
    remote: true,
    get match() { return match; },
    all: () => rooms(),
    room: () => rooms()[0] || null,
    isOpen() {
      const s = freshSnap(view);
      return !!s && isObj(s.br) && s.br.open === true;
    },
    humanTotal() {
      const s = freshSnap(view);
      if (!s) throw new Error(STALE);
      return isObj(s.br) ? s.br.humans : 0;
    },
    // Before the slither process exists this asks nothing: its init carries brOnNew, which starts the room there.
    // While it starts (refused "restarting") the link sends it at ready.
    startRoom() {
      Promise.resolve(view.call('br:startRoom', {})).catch(() => { /* logged by the link */ });
      return true;
    },
    maxSliceMs: () => 0,
  };
}

module.exports = { STALE, roomProxy, roomsOf, mirrorGovernor, freeProxy, decisionProxy, matchProxy, brProxy,
  readOnlyMap };
