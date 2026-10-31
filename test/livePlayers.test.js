'use strict';
// The owner's live view of real players (server/livePlayers.js), our test tools' marker (server/autoMark.js), the
// slither process's presence message (server/split/ipcEnvelope.js) and Control's Join choice (public/js/ownerLive.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// a key pair of the test's own: tokens it signs are valid, the real key's are not needed
const pair = crypto.generateKeyPairSync('ed25519');
process.env.DS_AUTO_PUBKEY = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const autoMark = require('../server/autoMark');
const { createLivePlayers, torontoOf, keyOf } = require('../server/livePlayers');
const envelope = require('../server/split/ipcEnvelope');
const { joinOf } = require('../public/js/ownerLive');

const OWNER = 'OwnerWa11et1111111111111111111111111111111';
let sockN = 0;
function sock({ ip = '203.0.113.' + (++sockN % 250), cookie = '', owner = false } = {}) {
  const s = new EventEmitter();
  s.id = 'S' + (++sockN);
  s.connected = true;
  s.handshake = { address: ip, headers: cookie ? { cookie } : {} };
  s.request = { headers: s.handshake.headers };
  s._owner = owner;
  s.leave = () => { s.connected = false; s.emit('disconnect'); };
  return s;
}
function rig(o = {}) {
  let t = o.t || Date.UTC(2026, 9, 30, 20, 0, 0);
  const sent = [];
  const saved = [];
  let board = o.board || { rows: [], br: null, soon: [] };
  const lp = createLivePlayers({
    isOwnerWallet: (w) => w === OWNER,
    isOwnerSocket: (s) => s._owner === true,
    provenWallet: () => null,
    board: () => board,
    emit: (ev, p) => sent.push([ev, JSON.parse(JSON.stringify(p))]),
    watching: () => true,
    store: o.store || null,
    now: () => t,
    log: { error() {}, warn() {}, log() {} },
    timers: { setInterval() { return null; }, clearInterval() {}, setTimeout(fn) { fn(); return null; }, clearTimeout() {} },
    autoTick: false,
  });
  return {
    lp, sent, saved,
    setBoard(b) { board = b; },
    advance(ms) { t += ms; },
    now: () => t,
    toasts: () => sent.filter((x) => x[0] === 'owner:live:join').map((x) => x[1]),
    last: () => { const s = sent.filter((x) => x[0] === 'owner:live'); return s.length ? s[s.length - 1][1] : lp.snapshot(); },
  };
}
const lobby = (st, key) => st.lobbies.find((l) => l.key === key);
const slRow = (players) => ({ rows: [{ game: 'snake', stake: 0, players, bots: 60, capacity: null, state: 'open' }], br: null, soon: [] });

test('a real person in a free room: counted, toasted once, gone on disconnect', () => {
  const r = rig({ board: slRow(1) });
  const s = sock();
  r.lp.joined({ game: 'sl', stake: 0, name: 'Rex', socket: s });
  assert.equal(lobby(r.last(), 'snake:0').real, 1);
  assert.deepEqual(lobby(r.last(), 'snake:0').names, ['Rex']);
  assert.equal(r.toasts().length, 1);
  assert.equal(r.toasts()[0].gameName, 'slither.io');
  assert.equal(r.toasts()[0].rung, 'Free');
  // the same seat again (a respawn) and the same person on a new socket soon after: no second toast
  r.lp.joined({ game: 'sl', stake: 0, name: 'Rex', socket: s });
  s.leave();
  const s2 = sock({ ip: s.handshake.address });
  r.lp.joined({ game: 'sl', stake: 0, name: 'Rex', socket: s2 });
  assert.equal(r.toasts().length, 1);
  s2.leave();
  r.setBoard(slRow(0));
  r.lp.tick();
  assert.equal(lobby(r.last(), 'snake:0').real, 0);
  assert.equal(r.last().totals.real, 0);
});

test('bots never count: only sockets do, and the board bots are shown apart', () => {
  const r = rig({ board: slRow(0) });
  r.lp.tick();
  const l = lobby(r.last(), 'snake:0');
  assert.equal(l.real, 0);
  assert.equal(l.bots, 60);
});

test('our test tools, load test players and the owner are not real people', () => {
  const r = rig({ board: slRow(5) });
  const exp = Math.floor(r.now() / 1000) + 3600;
  const tok = autoMark.sign(pair.privateKey, exp);
  r.lp.joined({ game: 'sl', stake: 0, name: 'xXRiftXx', socket: sock({ cookie: 'a=1; ds_auto=' + tok }) });
  r.lp.joined({ game: 'sl', stake: 0, name: 'Load13052', socket: sock({ ip: '198.18.4.7' }) });
  r.lp.joined({ game: 'sl', stake: 0, name: 'Owen', socket: sock({ owner: true }) });
  r.lp.joined({ game: 'sl', stake: 0, name: 'Forger', socket: sock({ cookie: 'ds_auto=' + tok.slice(0, -4) + 'AAAA' }) });
  const l = lobby(r.last(), 'snake:0');
  assert.equal(l.real, 1, 'only the forged token is a person');
  assert.equal(l.auto, 1);
  assert.equal(l.load, 1);
  assert.equal(l.you, 1);
  assert.deepEqual(l.names, ['Forger']);
  assert.deepEqual(r.toasts().map((t) => t.name), ['Forger']);
  const kinds = r.last().tests.map((t) => t.kind).sort();
  assert.deepEqual(kinds, ['load', 'tool', 'you']);
  assert.ok(r.last().tests.some((t) => t.name === 'xXRiftXx'));
});

test('an expired or too-long-lived token is not a test client', () => {
  const now = Date.now();
  assert.equal(autoMark.valid(autoMark.sign(pair.privateKey, now / 1000 - 5), now), false);
  assert.equal(autoMark.valid(autoMark.sign(pair.privateKey, now / 1000 + autoMark.MAX_LIFE_S + 3600), now), false);
  assert.equal(autoMark.valid(autoMark.sign(pair.privateKey, now / 1000 + 60), now), true);
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.equal(autoMark.valid(autoMark.sign(other, now / 1000 + 60), now), false);
  assert.equal(autoMark.valid('v1.123.abc', now), false);
  assert.equal(autoMark.valid(undefined, now), false);
});

test('a paid seat: the owner wallet is Owen; a seat with no socket leaves when its row empties', () => {
  const board = { rows: [{ game: 'paper', stake: 0.5, players: 2, bots: 0, capacity: 16, state: 'open' }], br: null, soon: [] };
  const r = rig({ board });
  r.lp.joined({ game: 'paper', stake: 0.5, name: 'Payer', wallet: 'Wa11etA1111111111111111111111111111111111' });
  r.lp.joined({ game: 'paper', stake: 0.5, name: 'Owen', wallet: OWNER });
  let l = lobby(r.last(), 'paper:0.5');
  assert.equal(l.real, 1);
  assert.equal(l.you, 1);
  assert.equal(r.toasts()[0].rung, '$0.50');
  r.advance(10000);
  r.setBoard({ rows: [{ game: 'paper', stake: 0.5, players: 0, bots: 0, capacity: 16, state: 'open' }], br: null, soon: [] });
  r.lp.tick();
  l = lobby(r.last(), 'paper:0.5');
  assert.equal(l.real, 0);
  assert.equal(r.lp._entries.size, 0);
});

test('counts are held to the room\'s own count, except for a fresh join', () => {
  const r = rig({ board: slRow(0) });
  const s = sock();
  r.lp.joined({ game: 'sl', stake: 0, name: 'Fresh', socket: s });
  assert.equal(lobby(r.last(), 'snake:0').real, 1, 'shown before the board has it');
  r.advance(5000);
  r.lp.tick();
  assert.equal(lobby(r.last(), 'snake:0').real, 0, 'out of the room (a death screen): not in it');
  r.setBoard(slRow(1));
  r.lp.tick();
  assert.equal(lobby(r.last(), 'snake:0').real, 1);
});

test('a socket that disconnected without telling us is dropped on the next count', () => {
  const r = rig({ board: slRow(1) });
  const s = sock();
  r.lp.joined({ game: 'sl', stake: 0, name: 'Ghost', socket: s });
  s.connected = false;
  r.lp.tick();
  assert.equal(r.lp._entries.size, 0);
});

test('the slither process: presence join and leave, the battle royale, and its restart', () => {
  const r = rig({ board: { rows: [{ game: 'snake', stake: 0, players: 2, bots: 0 }], br: { humans: 1, bots: 70, joinable: true, state: 'waiting' }, soon: [] } });
  r.lp.presence({ op: 'join', sid: 'a1', where: 'free', name: 'Kid', h: {}, ip: '203.0.113.9' });
  r.lp.presence({ op: 'join', sid: 'a2', where: 'br', name: 'Royal', h: {}, ip: '203.0.113.10' });
  r.lp.presence({ op: 'join', sid: 'a3', where: 'free', name: 'Bench', h: {}, ip: '198.19.0.1' });
  let st = r.last();
  assert.equal(lobby(st, 'snake:0').real, 1);
  assert.equal(lobby(st, 'snake:0').load, 1);
  assert.equal(lobby(st, 'br:0').real, 1);
  assert.equal(lobby(st, 'br:0').rung, 'Event');
  assert.equal(lobby(st, 'br:0').bots, 70);
  r.lp.presence({ op: 'leave', sid: 'a1', where: 'free', name: '', h: {}, ip: '' });
  assert.equal(lobby(r.last(), 'snake:0').real, 0);
  r.lp.dropSource('sl');
  assert.equal(r.lp._entries.size, 0);
  // the message the slither process sends passes the envelope check
  for (const m of [
    envelope.make('presence', { op: 'join', sid: 'abc', where: 'free', name: 'Kid', h: { cookie: 'ds_auto=x' }, ip: '1.2.3.4' }),
    envelope.make('presence', { op: 'leave', sid: 'abc', where: 'br', name: '', h: {}, ip: '' }),
  ]) assert.equal(envelope.check('toMain', m).ok, true);
  assert.equal(envelope.check('toMain', envelope.make('presence', { op: 'join', sid: 'abc', where: 'free', name: 'Kid',
    h: { 'x-forwarded-for': '1.2.3.4' }, ip: '' })).ok, false, 'only the allowed headers cross');
});

test('rooms with real people sort first, then the rest in lobby order', () => {
  const r = rig({ board: { rows: [
    { game: 'snake', stake: 0, players: 0, bots: 60 },
    { game: 'paper', stake: 0, players: 0, bots: 30 },
    { game: 'knockout', stake: 0, players: 1, waiting: 1, bots: 0 },
  ], br: null, soon: ['agar'] } });
  r.lp.joined({ game: 'knockout', stake: 0, name: 'Duelist', queued: true, socket: sock() });
  const st = r.last();
  assert.equal(st.lobbies[0].key, 'knockout:0');
  assert.equal(st.lobbies[0].waiting, 1);
  assert.equal(st.lobbies[1].key, 'snake:0');
  assert.equal(r.toasts()[0].queued, true);
});

test('nothing sent names a wallet or an address', () => {
  const r = rig({ board: { rows: [{ game: 'agar', stake: 1, players: 1, bots: 0 }], br: null, soon: [] } });
  const w = 'SecretWa11et111111111111111111111111111111';
  r.lp.joined({ game: 'agar', stake: 1, name: 'Rich', wallet: w });
  r.lp.joined({ game: 'agar', stake: 0, name: 'Poor', socket: sock({ ip: '203.0.113.77' }) });
  const all = JSON.stringify(r.sent) + JSON.stringify(r.lp.snapshot());
  assert.equal(all.includes(w), false);
  assert.equal(all.includes('203.0.113.77'), false);
});

test('a name typed as a wallet is shown as A player', () => {
  const r = rig({ board: slRow(1) });
  r.lp.joined({ game: 'sl', stake: 0, name: 'SecretWa11et111111111111111111111111111111', socket: sock() });
  assert.equal(r.toasts()[0].name, 'A player');
});

test('today: unique people and the most at once per lobby, by Toronto hour, saved and read back', async () => {
  const db = new Map();
  const store = { load: async (day) => db.get(day) || null, save: async (day, j) => { db.set(day, JSON.parse(JSON.stringify(j))); } };
  const t0 = Date.UTC(2026, 9, 30, 23, 30, 0);   // 7:30 pm in Toronto (EDT)
  const r = rig({ board: slRow(2), store, t: t0 });
  r.lp.tick();
  await new Promise((res) => setImmediate(res));
  const a = sock(), b = sock();
  r.lp.joined({ game: 'sl', stake: 0, name: 'A', socket: a });
  r.lp.joined({ game: 'sl', stake: 0, name: 'B', socket: b });
  r.lp.tick();
  a.leave();
  r.lp.joined({ game: 'sl', stake: 0, name: 'A', socket: sock({ ip: a.handshake.address }) });   // the same person again
  let d = await r.lp.dayStats('today');
  assert.equal(d.day, '2026-10-30');
  assert.equal(d.all.uniq, 2);
  assert.equal(d.all.peak, 2);
  assert.equal(d.hour, 19);
  assert.deepEqual(d.all.hours[19], [2, 2]);
  const l = d.lobbies.find((x) => x.key === 'snake:0');
  assert.equal(l.uniq, 2);
  assert.equal(l.name, 'slither.io');
  r.advance(20000);
  r.lp.tick();
  await new Promise((res) => setImmediate(res));
  assert.ok(db.get('2026-10-30'), 'saved');
  assert.equal(JSON.stringify(db.get('2026-10-30')).includes(a.handshake.address), false, 'hashes only');
  // a restart reads it back and adds to it
  const r2 = rig({ board: slRow(1), store, t: t0 + 60000 });
  r2.lp.tick();
  await new Promise((res) => setImmediate(res));
  r2.lp.joined({ game: 'sl', stake: 0, name: 'C', socket: sock() });
  d = await r2.lp.dayStats('today');
  assert.equal(d.all.uniq, 3);
  assert.equal(d.all.peak, 2);
});

test('the day turns over at midnight in Toronto, not UTC', () => {
  assert.equal(torontoOf(Date.UTC(2026, 9, 31, 3, 59)).day, '2026-10-30');   // 11:59 pm EDT
  assert.equal(torontoOf(Date.UTC(2026, 9, 31, 4, 1)).day, '2026-10-31');
  assert.equal(torontoOf(Date.UTC(2026, 11, 1, 4, 59)).day, '2026-11-30');   // EST, an hour later
  assert.equal(keyOf('snake', 0.5), 'snake:0.5');
});

test('a join path never sees a throw', () => {
  const r = rig();
  assert.doesNotThrow(() => r.lp.joined(null));
  assert.doesNotThrow(() => r.lp.joined({ game: 'sl', socket: { id: 5 } }));
  assert.doesNotThrow(() => r.lp.presence({ op: 'join' }));
  const bad = createLivePlayers({ board: () => { throw new Error('x'); }, emit: () => { throw new Error('y'); },
    isOwnerSocket: () => { throw new Error('z'); }, autoTick: false, log: { error() {}, warn() {} } });
  assert.doesNotThrow(() => bad.joined({ game: 'sl', stake: 0, name: 'A', socket: sock() }));
  assert.doesNotThrow(() => bad.tick());
});

test('Join: play where there is room or a queue, watch a full room or a match, nothing on a closed-off game', () => {
  assert.deepEqual(joinOf({ kind: 'arena', stake: 0, state: 'open' }), { act: 'play', label: 'Join' });
  assert.deepEqual(joinOf({ kind: 'arena', stake: 0.5, state: 'open' }), { act: 'play', label: 'Join $0.50' });
  assert.equal(joinOf({ kind: 'arena', stake: 0, state: 'open', full: true }).act, 'watch');
  assert.equal(joinOf({ kind: 'duel', stake: 0, waiting: 1, humans: 1 }).act, 'play');
  assert.equal(joinOf({ kind: 'duel', stake: 0, waiting: 0, humans: 2 }).act, 'watch');
  assert.equal(joinOf({ kind: 'event', joinable: false }).act, 'watch');
  assert.equal(joinOf({ kind: 'event', joinable: true }).act, 'play');
  assert.equal(joinOf({ kind: 'arena', soon: true }), null);
});
