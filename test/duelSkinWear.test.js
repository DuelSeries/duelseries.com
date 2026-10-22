'use strict';
/* Wearing a bought skin in Knockout and Battleship (docs/skin-purchases.md).

   The SERVER decides the look: index.js checks the lobby's skin pass at the join and hands the answer (the skin id, or
   null) to the lobby, the room and the wire, so both players and every watcher are shown the same thing and a page
   cannot dress itself in a skin it does not own. No skin means the free look, which is the same wire and the same
   drawing as before plus a null.

   Two layers. The lobby and room layer is driven directly, deciding the skin the way index.js does
   (sharedPass().wornFrom). The last test boots the REAL server (scripts/dev-local.js, whose SESSION_SECRET is
   'dev-local') and sends the join messages a page sends, so the index.js handlers are covered too, junk shapes and all. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const { sharedPass, createSkinPass } = require('../server/skinPass');
const { KnockoutLobby, BOT_AFTER_MS: KO_BOT } = require('../server/KnockoutLobby');
const { BattleshipLobby, BOT_AFTER_MS: BS_BOT } = require('../server/BattleshipLobby');
const shopSkins = require('../shared/shopSkins');

const W = 'Wa11etWa11etWa11etWa11etWa11etWa11etWa11';
const good = sharedPass().mint(W, ['knockout:ruby', 'battleship:navy']).pass;
const tampered = good.slice(0, -3) + (good.endsWith('AAA') ? 'BBB' : 'AAA');
const otherGame = sharedPass().mint(W, ['snake:ruby', 'agar:navy']).pass;

// What index.js does at the join: the pass decides, nothing else does.
const wear = (game, shop, skinPass) => sharedPass().wornFrom(game, { shop, skinPass });

function sock(id) {
  const sent = [], rooms = new Set();
  return {
    id, sent, rooms,
    join(r) { rooms.add(r); }, leave(r) { rooms.delete(r); },
    emit(ev, p) { sent.push({ ev, p }); },
    last(ev) { for (let i = sent.length - 1; i >= 0; i--) if (sent[i].ev === ev) return sent[i].p; return null; },
  };
}
function rig() {
  const roomSent = [];
  const io = { to: (room) => ({ emit: (ev, p) => roomSent.push({ room, ev, p }) }) };
  return { io, roomSent };
}

test('the pass check the join relies on: genuine and listed wears, everything else is the free look', () => {
  assert.equal(wear('knockout', 'ruby', good), 'ruby');
  assert.equal(wear('battleship', 'navy', good), 'navy');
  assert.equal(wear('knockout', 'ruby', tampered), null, 'forged');
  assert.equal(wear('knockout', 'ruby', null), null, 'no pass');
  assert.equal(wear('knockout', 'jade', good), null, 'not in the pass');
  assert.equal(wear('knockout', 'navy', good), null, 'another game\'s skin');
  assert.equal(wear('knockout', 'ruby', otherGame), null, 'a pass for other games');
  assert.equal(wear('knockout', 'ruby', createSkinPass({ secret: 'someone else' }).mint(W, ['knockout:ruby']).pass), null, 'another key');
  assert.equal(wear('knockout', { toString: 1 }, good), null, 'odd shapes');
  assert.equal(wear('knockout', 'ruby', { toString: 1 }), null, 'odd shapes');
  // every shop skin exists in the shared art the pages draw from
  for (const g of ['knockout', 'battleship']) for (const k of shopSkins.SKINS[g]) assert.ok(shopSkins.byId(g, k.id));
  const hull = shopSkins.hullFor(shopSkins.byId('battleship', 'navy'));
  for (const key of ['steel', 'steelHi', 'steelLo', 'deck', 'deckHi', 'trim', 'glass']) assert.match(hull[key], /^#[0-9a-f]{6}$/i, key);
});

/* ── Knockout ──────────────────────────────────────────────────────────── */

test('Knockout: both seats\' skins ride publicState and the watcher copy, and nothing else about the state moves', () => {
  const { io, roomSent } = rig();
  const lob = new KnockoutLobby(io);
  const A = sock('ko-A'), B = sock('ko-B');
  lob.enqueue(A, 'Owen', null, 0, 0, undefined, undefined, wear('knockout', 'ruby', good));
  lob.enqueue(B, 'Nia', null, 0, 0, undefined, undefined, wear('knockout', 'ruby', tampered));
  const room = lob.roomOf(A.id);
  assert.ok(room && room === lob.roomOf(B.id), 'matched');

  const ps = room.publicState();
  const a = ps.players.find(p => p.id === A.id), b = ps.players.find(p => p.id === B.id);
  assert.equal(a.skin, 'ruby', 'the genuine pass wears it');
  assert.equal(b.skin, null, 'the forged one gets the free look');
  const start = roomSent.find(m => m.ev === 'ko:start');
  assert.deepEqual(start.p.players.map(p => p.skin), ['ruby', null], 'the start both players get carries both');

  // A watcher is told by seat, and the same two answers.
  const ws = room.watchState(ps);
  assert.deepEqual(ws.players.map(p => [p.side, p.skin]), [[0, 'ruby'], [1, null]]);
  assert.deepEqual(room.watchSnapshot().players.map(p => p.skin), ['ruby', null]);
  assert.ok(!JSON.stringify(ws).includes(A.id), 'still no socket id for a watcher');
  assert.equal(room.forWatchers('ko:resolve', { state: ps, reveal: [], order: [], frames: [], out: [] }).state.players[0].skin, 'ruby');

  // Both wearing one: each seat keeps its own answer.
  const lob2 = new KnockoutLobby(rig().io);
  const C = sock('ko-C'), D = sock('ko-D');
  lob2.enqueue(C, 'C', null, 0, 0, undefined, undefined, wear('knockout', 'ruby', good));
  lob2.enqueue(D, 'D', null, 0, 0, undefined, undefined, wear('knockout', 'ruby', good));
  assert.deepEqual(lob2.roomOf(C.id).publicState().players.map(p => p.skin), ['ruby', 'ruby']);
});

test('Knockout: no skin argument is a null skin (a caller that never heard of skins), and a bot has none', () => {
  const lob = new KnockoutLobby(rig().io);
  const A = sock('ko-A2');
  const T0 = Date.now();
  lob.enqueue(A, 'Owen', null, 0, 0, T0, undefined, wear('knockout', 'ruby', good));
  lob.tick(T0 + KO_BOT + 1);
  const room = lob.roomOf(A.id);
  assert.ok(room && room.bot, 'a bot match');
  const ps = room.publicState();
  assert.equal(ps.players.find(p => p.id === A.id).skin, 'ruby');
  assert.equal(ps.players.find(p => p.id !== A.id).skin, null, 'the bot wears nothing');

  const lob2 = new KnockoutLobby(rig().io);
  const B = sock('ko-B2'), C = sock('ko-C2');
  lob2.enqueue(B, 'B', null, 0, 0);
  lob2.enqueue(C, 'C', null, 0, 0);
  assert.deepEqual(lob2.roomOf(B.id).publicState().players.map(p => p.skin), [null, null]);
});

test('Knockout: rescueFromBot keeps the rescued player\'s skin and the newcomer\'s', () => {
  const lob = new KnockoutLobby(rig().io);
  const A = sock('ko-A3'), B = sock('ko-B3');
  const T0 = Date.now();
  lob.enqueue(A, 'Owen', null, 0, 0, T0, undefined, wear('knockout', 'ruby', good));
  lob.tick(T0 + KO_BOT + 1);
  assert.ok(lob.roomOf(A.id).bot, 'in a bot match first');
  lob.enqueue(B, 'Nia', null, 0, 0, T0 + KO_BOT + 2, undefined, wear('knockout', 'ruby', good));
  const room = lob.roomOf(A.id);
  assert.ok(room && !room.bot && room === lob.roomOf(B.id), 'the bot match was dissolved for two people');
  const ps = room.publicState();
  assert.equal(ps.players.find(p => p.id === A.id).skin, 'ruby', 'the rescued seat kept its skin');
  assert.equal(ps.players.find(p => p.id === B.id).skin, 'ruby', 'and the newcomer wears theirs');

  // And a rescued player with no skin stays plain.
  const lob2 = new KnockoutLobby(rig().io);
  const C = sock('ko-C3'), D = sock('ko-D3');
  lob2.enqueue(C, 'C', null, 0, 0, T0);
  lob2.tick(T0 + KO_BOT + 1);
  lob2.enqueue(D, 'D', null, 0, 0, T0 + KO_BOT + 2, undefined, wear('knockout', 'ruby', good));
  assert.deepEqual(lob2.roomOf(C.id).publicState().players.map(p => p.skin), [null, 'ruby']);
});

/* ── Battleship ────────────────────────────────────────────────────────── */

const NEAT = [
  { key: 'carrier',    x: 0, y: 0, horiz: true },
  { key: 'battleship', x: 0, y: 1, horiz: true },
  { key: 'cruiser',    x: 0, y: 2, horiz: true },
  { key: 'submarine',  x: 0, y: 3, horiz: true },
  { key: 'destroyer',  x: 0, y: 4, horiz: true },
];

test('Battleship: you/them carry each side\'s skin, the spectator view carries it per seat, and the reveals name it', () => {
  const { io, roomSent } = rig();
  const lob = new BattleshipLobby(io);
  const A = sock('bs-A'), B = sock('bs-B');
  lob.enqueue(A, 'Owen', null, 0, 0, undefined, wear('battleship', 'navy', good));
  lob.enqueue(B, 'Nia', null, 0, 0, undefined, wear('battleship', 'navy', tampered));
  const room = lob.roomOf(A.id);
  assert.ok(room && room === lob.roomOf(B.id), 'matched');

  const va = room.viewFor(A.id), vb = room.viewFor(B.id);
  assert.deepEqual([va.you.skin, va.them.skin], ['navy', null], 'A sees its own skin and the free look across the water');
  assert.deepEqual([vb.you.skin, vb.them.skin], [null, 'navy'], 'B sees the same match the other way round');

  const sv = room.spectatorView();
  assert.deepEqual(sv.players.map(p => [p.side, p.skin]), [[0, 'navy'], [1, null]]);
  assert.ok(!JSON.stringify(sv).includes(A.id), 'still no socket id for a watcher');

  // The game-over reveals name the fleet's skin, for the players and for a watcher.
  room.watchers = 1;
  room.placeFleet(A.id, NEAT); room.placeFleet(B.id, NEAT);
  room.finish(A.id, 'fleet sunk');
  const overA = A.last('bs:over');
  assert.deepEqual(overA.reveal.map(r => [r.id, r.skin]), [[A.id, 'navy'], [B.id, null]]);
  const overW = roomSent.filter(m => m.ev === 'bs:over' && m.room === room.watchRoomName).pop().p;
  assert.deepEqual(overW.reveal.map(r => [r.side, r.skin]), [[0, 'navy'], [1, null]]);
});

test('Battleship: a bot has none, a player with no skin is null, and rescueFromBot keeps both seats\' skins', () => {
  const lob = new BattleshipLobby(rig().io);
  const A = sock('bs-A2');
  lob.enqueue(A, 'Owen', null, 0, 0, undefined, wear('battleship', 'navy', good));
  lob.queue[0].since -= BS_BOT + 1;          // waited long enough for a bot, without letting the room's clock run ahead
  lob.tick();
  const bots = lob.roomOf(A.id);
  assert.ok(bots && bots.bot, 'a bot match');
  const v = bots.viewFor(A.id);
  assert.equal(v.you.skin, 'navy');
  assert.equal(v.them.skin, null, 'the bot wears nothing');
  assert.equal(bots.spectatorView().players[1].skin, null);

  const B = sock('bs-B2');
  lob.enqueue(B, 'Nia', null, 0, 0, undefined, wear('battleship', 'navy', good));
  const room = lob.roomOf(A.id);
  assert.ok(room && !room.bot && room === lob.roomOf(B.id), 'the bot match was dissolved for two people');
  assert.deepEqual([room.viewFor(A.id).you.skin, room.viewFor(A.id).them.skin], ['navy', 'navy']);
  assert.deepEqual(room.spectatorView().players.map(p => p.skin), ['navy', 'navy']);

  const lob2 = new BattleshipLobby(rig().io);
  const C = sock('bs-C2'), D = sock('bs-D2');
  lob2.enqueue(C, 'C', null, 0, 0);
  lob2.enqueue(D, 'D', null, 0, 0);
  const r2 = lob2.roomOf(C.id);
  assert.deepEqual([r2.viewFor(C.id).you.skin, r2.viewFor(C.id).them.skin], [null, null]);
});

/* ── the real server: index.js reads the join, checks the pass, and the wire shows it ───────────────────────── */

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port, srv, out = '', exitCode = null;
const alive = () => exitCode === null && srv && srv.exitCode === null;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function up() {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let text = '';
    s.on('connect', () => s.write('GET /api/live HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    s.on('data', (d) => { text += d; });
    s.on('end', () => resolve(Number(text.split(' ')[1]) === 200));
    s.on('error', () => resolve(false));
  });
}
function connect() {
  const { io } = require('socket.io-client');
  const s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000 });
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 8000);
    s.on('connect', () => { clearTimeout(bail); res(s); });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}
const first = (s, ev, ms = 6000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('no ' + ev)), ms);
  s.once(ev, (p) => { clearTimeout(t); resolve(p); });
});

/* Two humans on the free table, A joining first with `a` and then B with `b` (the extra fields of the join), each
   answered with the message that carries the match. Returns { a, b } as the two screens saw it. */
async function pair(game, a, b) {
  const [queueEv, startEv] = game === 'knockout' ? ['ko:queue', 'ko:start'] : ['bs:queue', 'bs:state'];
  const A = await connect(), B = await connect();
  try {
    const gotA = first(A, startEv), gotB = first(B, startEv);
    A.emit(queueEv, Object.assign({ name: 'Aa' }, a));
    await sleep(40);                         // A is queued before B arrives, so the pair is A then B
    B.emit(queueEv, Object.assign({ name: 'Bb' }, b));
    const [ma, mb] = await Promise.all([gotA, gotB]);
    return game === 'knockout'
      ? { a: ma.players.find(p => p.id === A.id).skin, b: mb.players.find(p => p.id === B.id).skin,
          aSeesB: ma.players.find(p => p.id === B.id).skin, bSeesA: mb.players.find(p => p.id === A.id).skin }
      : { a: ma.you.skin, b: mb.you.skin, aSeesB: ma.them.skin, bSeesA: mb.them.skin };
  } finally { A.close(); B.close(); }
}

test('the real server: a genuine pass wears the skin for both screens; forged, missing, unlisted and junk get the free look', { timeout: 120000 }, async (t) => {
  port = await freePort();
  srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-local.js')], {
    cwd: ROOT, env: { ...process.env, DEV_LOCAL_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  srv.on('exit', (code) => { exitCode = code === null ? 'signal' : code; });
  t.after(() => { if (srv && alive()) srv.kill(); });
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    assert.ok(alive(), 'server exited:\n' + out.split('\n').slice(-8).join('\n'));
    ready = await up();
    if (!ready) await sleep(250);
  }
  assert.ok(ready, 'server did not come up');

  // dev-local.js runs with SESSION_SECRET 'dev-local': a pass minted with it is genuine to that server.
  const real = createSkinPass({ secret: 'dev-local' }).mint(W, ['knockout:ruby', 'battleship:navy']).pass;
  const forged = real.slice(0, -3) + (real.endsWith('AAA') ? 'BBB' : 'AAA');
  const wrongGame = createSkinPass({ secret: 'dev-local' }).mint(W, ['snake:ruby', 'agar:navy']).pass;

  for (const [game, skin, other] of [['knockout', 'ruby', 'jade'], ['battleship', 'navy', 'rust']]) {
    const own = { shop: skin, skinPass: real };
    let r = await pair(game, own, own);
    assert.deepEqual(r, { a: skin, b: skin, aSeesB: skin, bSeesA: skin }, game + ': a genuine pass on both seats');

    r = await pair(game, own, { shop: skin, skinPass: forged });
    assert.deepEqual(r, { a: skin, b: null, aSeesB: null, bSeesA: skin }, game + ': a forged pass is the free look, on both screens');

    r = await pair(game, {}, { shop: skin });
    assert.deepEqual(r, { a: null, b: null, aSeesB: null, bSeesA: null }, game + ': no pass, or no pass at all');

    r = await pair(game, { shop: other, skinPass: real }, { shop: skin, skinPass: wrongGame });
    assert.deepEqual(r, { a: null, b: null, aSeesB: null, bSeesA: null }, game + ': a skin the pass does not list, and a pass for other games');

    // Hand-made shapes in the two fields: never a throw, never a skin.
    for (const junk of [{ toString: 1 }, ['ruby'], 7, true, null, '__proto__', 'constructor', 'x'.repeat(9000)]) {
      r = await pair(game, { shop: junk, skinPass: real }, { shop: skin, skinPass: junk });
      assert.deepEqual(r, { a: null, b: null, aSeesB: null, bSeesA: null }, game + ': junk ' + JSON.stringify(junk).slice(0, 30));
    }
  }
  assert.ok(alive(), 'the server is still up');
});
