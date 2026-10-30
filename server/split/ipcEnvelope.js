'use strict';
// The server split's messages (spec section 5): ONE module checks both directions, so the slither process
// (server/split/slChild.js) and the main server's link to it (server/split/slLink.js) agree on every field.
//
// Every message is { v: 1, t: <type>, ...fields } over the fork's IPC channel (serialization 'json': ordered and
// reliable while both processes live). check(dir, msg) -> { ok, why }: dir 'toMain' (the child's messages) or
// 'toChild' (main's). An unknown v or t, a listed field of the wrong type, or a message whose JSON is over MAX_BYTES
// is refused; the receiver drops it and dropLog says so once a minute per type. Fields not listed are not looked at.
// Nothing here throws on a bad message.
//
// Money: no message carries an amount of money. The free room's board row may only say stake 0 (a snapshot whose row
// says anything else is refused whole). The battle royale's decision names the winner's proven wallet and the people
// in the match, which is what the main server's payBattleRoyaleWinner reads; the prize is decided and paid only
// there. A decision is never refused for its prizeHeld: anything but a boolean is passed on and holds the prize
// (slProxies decisionProxy).

const V = 1;
const MAX_BYTES = 256 * 1024;

// The owner commands the slither process runs (spec 5.3), cmd.op.
const OPS = Object.freeze(['bots:add', 'bots:clear', 'bots:set', 'br:start', 'br:stop', 'br:startRoom', 'br:autoStart',
  'door', 'snap.now', 'debug.modules']);
// The headers a free or BR join carries to the main server's push gate: only what ownerDevice reads.
const JOIN_HEADERS = Object.freeze(['host', 'origin', 'sec-fetch-site', 'cookie']);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (max) => (x) => typeof x === 'string' && x.length <= max;
const strOrNull = (max) => (x) => x === null || (typeof x === 'string' && x.length <= max);
const bool = (x) => typeof x === 'boolean';
const count = (max) => (x) => Number.isInteger(x) && x >= 0 && x <= max;
const countOrNull = (max) => (x) => x === null || (Number.isInteger(x) && x >= 0 && x <= max);
const num = (x) => typeof x === 'number' && Number.isFinite(x);
const oneOf = (list) => (x) => list.includes(x);
const opt = (f) => (x) => x === undefined || f(x);
const any = () => true;
const listOf = (f, max) => (x) => Array.isArray(x) && x.length <= max && x.every((e) => f(e));
const nullOr = (f) => (x) => x === null || f(x);

// The first listed field that fails, as 'bad <name>', or '' when every one passes.
function fieldsWhy(spec, x) {
  if (!isObj(x)) return 'not an object';
  for (const k of Object.keys(spec)) {
    let ok = false;
    try { ok = spec[k](x[k]) === true; } catch (_) { ok = false; }
    if (!ok) return 'bad ' + k;
  }
  return '';
}
const shape = (spec) => (x) => fieldsWhy(spec, x) === '';

const INT = 1e9;
const decided = shape({
  matchId: str(64),
  winner: shape({ name: str(200), wallet: strOrNull(64), bot: bool }),
  soloRun: bool,
  prizeHeld: any,         // anything but a boolean is held (decisionProxy); never a reason to lose the decision
  startedPeople: any,
  startedWith: any,
  seats: listOf(isObj, 4096),
});
const freeRow = shape({ id: str(64), game: str(16), region: str(8), stake: (x) => x === 0, players: count(INT),
  bots: count(INT), capacity: countOrNull(INT), state: str(16) });
const roomRow = shape({ lobbyType: str(64), kind: oneOf(['free', 'br']), index: count(INT), playerCount: count(INT),
  botCount: count(INT), humans: count(100000), botsAllowed: bool, botTarget: countOrNull(INT),
  botAim: countOrNull(INT), botsHeld: countOrNull(INT), pausedUntil: num });
const brBlock = shape({
  open: bool,
  room: strOrNull(64),
  humans: count(INT),
  match: shape({ matchId: strOrNull(64), state: str(16), public: isObj, canStart: bool, accepting: bool,
    humanLiving: count(INT), livingCount: count(INT) }),
  decided: nullOr(decided),
});
const SNAP = {
  boot: str(64),
  seq: (x) => Number.isInteger(x) && x > 0,
  at: num,
  proc: isObj,
  gov: shape({ engaged: bool, mult: num }),
  smooth: bool,
  door: bool,
  free: shape({ rows: nullOr(listOf(freeRow, 8)), rowsErr: strOrNull(500), live: bool, humans: count(INT) }),
  rooms: listOf(roomRow, 8),
  br: nullOr(brBlock),
};
const snap = shape(SNAP);
const headers = (x) => isObj(x) && Object.keys(x).every((k) => JOIN_HEADERS.includes(k) && str(8192)(x[k]));
const loadFields = { paidPlayers: count(INT), extraSliceMs: (x) => num(x) && x >= 0, maintenance: bool };

// child -> main (spec 5.2)
const CHILD_TO_MAIN = Object.freeze({
  hello: { boot: str(64), pid: count(INT * 10), node: str(32) },
  ready: { boot: str(64), port: count(65535), dev: bool },
  snap: SNAP,
  join: { name: str(64), where: oneOf(['free', 'br']), h: headers },
  push: { text: str(2000), title: str(200), priority: opt(str(16)) },
  'br.live': { rec: nullOr(isObj) },
  'br.decided': { d: decided },
  reply: { re: count(INT * 10), ok: bool, note: opt(str(2000)), why: opt(str(2000)), result: opt(nullOr(isObj)),
    snap: opt(snap) },
  bye: { why: str(200) },
});

// main -> child (spec 5.3)
const MAIN_TO_CHILD = Object.freeze({
  init: { region: str(8), owners: listOf(str(64), 16), ops: isObj, smooth: bool, door: bool, brOnNew: bool,
    podiumFile: str(4096), botsPauseMs: count(INT), load: shape(loadFields) },
  load: loadFields,
  emit: { ev: oneOf(['maintenance', 'announce']), data: isObj },
  smooth: { on: bool },
  'br.hold': { matchId: str(64) },
  cmd: { id: count(INT * 10), op: oneOf(OPS), args: isObj },
  shutdown: { why: str(200) },
});

// The size of a message as the channel sends it (JSON); one that cannot be written as JSON is too big.
function sizeOf(msg) {
  try {
    return Buffer.byteLength(JSON.stringify(msg), 'utf8');
  } catch (_) {
    return Infinity;
  }
}

function check(dir, msg) {
  const table = dir === 'toMain' ? CHILD_TO_MAIN : dir === 'toChild' ? MAIN_TO_CHILD : null;
  if (!table) return { ok: false, why: 'no such direction' };
  if (!isObj(msg)) return { ok: false, why: 'not an object' };
  if (msg.v !== V) return { ok: false, why: 'version ' + String(msg.v).slice(0, 16) };
  if (typeof msg.t !== 'string' || !hasOwn(table, msg.t)) return { ok: false, why: 'unknown type' };
  const why = fieldsWhy(table[msg.t], msg);
  if (why) return { ok: false, why };
  if (sizeOf(msg) > MAX_BYTES) return { ok: false, why: 'over ' + MAX_BYTES + ' bytes' };
  return { ok: true, why: '' };
}

// A message of type t: the envelope's version and type, then the fields.
function make(t, fields) {
  return Object.assign({ v: V, t }, fields);
}

// -> (t, why): logs a dropped message, at most once a minute per type, so a broken sender cannot flood the log.
function dropLog(log, now) {
  const say = log || console;
  const clock = typeof now === 'function' ? now : Date.now;
  const last = new Map();
  return (t, why) => {
    const key = typeof t === 'string' ? t.slice(0, 32) : '?';
    const at = clock();
    if (last.has(key) && at - last.get(key) < 60000) return;
    last.set(key, at);
    try { say.warn('[SPLIT] dropped a ' + key + ' message (' + why + ')'); } catch (_) { /* never */ }
  };
}

module.exports = { V, MAX_BYTES, OPS, JOIN_HEADERS, CHILD_TO_MAIN, MAIN_TO_CHILD, check, make, sizeOf, dropLog, isObj };
