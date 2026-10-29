'use strict';
// slSockets (SERVER-DESIGN 12.1, 12.2, 13 item 9, 18.1; task T11): join once, the money door, every refusal then a
// disconnect, the per-address cap, the input size cap and its window (a stall burst is merged, never a disconnect;
// sustained abuse is), the hold and visibility states, chat, diag, the handshake skin and the owner push throttle.
// Paid task T4: with setPaid, a paid handshake goes to the paid door and the paid directory.
const test = require('node:test');
const assert = require('node:assert');
const W = require('../shared/slWire.js');
const { rig, layerMsgs, frozenGateTrace, fakeIoSocket } = require('./slSockFakes');
const S = require('../server/sl/slSockets');
const { LAWS } = require('../server/sl/slLaws');
const { cleanNick } = require('../server/sl/slNames');

const enc = (recs) => W.encodeInput(recs);
const angle = (q) => ({ type: 'angle', q });
const boost = (on) => ({ type: 'boost', on });

function refusedWith(s, why) {
  const last = s.emitted[s.emitted.length - 1];
  assert.ok(last && last.name === 'sl:x', 'the last emit is the sl:x refusal');
  assert.deepStrictEqual(last.data, [{ t: 'refused', why }]);
  assert.strictEqual(s.disconnected, true, 'then the socket is disconnected');
}

test('the real table holds the values this file reads', () => {
  const L = S.sockLaws(Object.assign({}, LAWS));
  assert.strictEqual(L.perIp, 30, 'C_SL_PER_IP (Owen Q11)');
  assert.deepStrictEqual(L.rate, { join: 500, hold: 50, vis: 250, chat: 600, diag: 10000, leave: 500 });
  assert.deepStrictEqual(L.input, { minBytes: 1, maxBytes: 64, windowMs: 10000, recordsPerSec: 222, bytesPerSec: 16384 });
  assert.strictEqual(L.badSkinCount, 9);
  assert.deepStrictEqual(L.push, { perNameMs: 600000, windowMs: 600000, maxPerWindow: 6 });
  assert.strictEqual(L.skins.size, 66 - 12, 'cv 0 to 65 without the 12 picture skins (PICTURE_SKINS off)');
  assert.strictEqual(S.SL_CONN.PER_IP, 30);
  assert.strictEqual(S.SL_RATE.join, 500);
});

test('join: seats once per socket; a second sl:join is ignored; the name is cleaned by their rules', () => {
  const r = rig();
  const s = r.sock();
  s.fire('sl:join', { nick: 'Owené 1234567' });
  assert.strictEqual(r.room().seats.size, 1);
  assert.strictEqual(r.room().seatOf(s.id).nick, '', '7 digits in a run: empty, as their client would send');
  r.wall.t += 1000;
  s.fire('sl:join', { nick: 'again' });
  assert.strictEqual(r.room().seats.size, 1);
  const s2 = r.sock();
  s2.fire('sl:join', { nick: 'Owené' });
  assert.strictEqual(r.room().seatOf(s2.id).nick, 'Owen ');
  const s3 = r.sock();
  s3.fire('sl:join');
  assert.ok(r.room().seatOf(s3.id), 'no payload is an empty name');
  const s4 = r.sock();
  for (const bad of [null, 'x', 5, [], Buffer.from([1])]) s4.fire('sl:join', bad);
  assert.strictEqual(r.room().seatOf(s4.id), null, 'a wrong shape is ignored');
  assert.strictEqual(s4.disconnected, false);
});

test('money fields are refused not-open, never read, never seated', () => {
  for (const k of ['stake', 'entryToken', 'resumeKey']) {
    const r = rig();
    const s = r.sock();
    let read = false;
    const msg = { nick: 'x' };
    Object.defineProperty(msg, k, { enumerable: true, get() { read = true; return 0; } });
    s.fire('sl:join', msg);
    refusedWith(s, 'not-open');
    assert.strictEqual(read, false, k + ' was never read');
    assert.strictEqual(r.room().seats.size, 0);
  }
  const r = rig();
  const s = r.sock();
  s.fire('sl:join', { nick: 'x', stake: 0 });
  refusedWith(s, 'not-open');
});

test('every refusal sends sl:x then disconnects: maintenance, closed (door), full, limit', () => {
  let r = rig();
  r.ops.maintenance = true;
  let s = r.sock();
  s.fire('sl:join', { nick: 'm' });
  refusedWith(s, 'maintenance');

  r = rig();
  r.arenas.door(false);
  s = r.sock();
  s.fire('sl:join', { nick: 'd' });
  refusedWith(s, 'closed');
  r.arenas.door(true);
  s = r.sock();
  s.fire('sl:join', { nick: 'd' });
  assert.ok(r.room().seatOf(s.id), 'door on again: seated');

  r = rig({ patch: { C_HUMAN_CAP: 1 } });
  r.sock().fire('sl:join', { nick: 'a' });
  s = r.sock();
  s.fire('sl:join', { nick: 'b' });
  refusedWith(s, 'full');

  r = rig({ patch: { C_SL_PER_IP: 2 } });
  const a = r.sock({ ip: '9.9.9.9' });
  const b = r.sock({ ip: '9.9.9.9' });
  const c = r.sock({ ip: '9.9.9.9' });
  assert.strictEqual(a.disconnected || b.disconnected, false);
  refusedWith(c, 'limit');
  const d = r.sock({ ip: '9.9.9.8' });
  assert.strictEqual(d.disconnected, false, 'another address is not affected');
  a.disconnect();
  const e = r.sock({ ip: '9.9.9.9' });
  assert.strictEqual(e.disconnected, false, 'a closed socket gives its place back');
});

test('the namespace middleware refuses a handshake from an address at the cap with { why: limit }', () => {
  const r = rig({ patch: { C_SL_PER_IP: 1 } });
  r.sock({ headers: { 'x-forwarded-for': '1.1.1.1, 7.7.7.7' } });
  let err = null;
  r.sockets.admit(fakeIoSocket({ headers: { 'x-forwarded-for': '7.7.7.7' } }), (e) => { err = e || 'ok'; });
  assert.ok(err instanceof Error);
  assert.deepStrictEqual(err.data, { why: 'limit' });
  r.sockets.admit(fakeIoSocket({ headers: { 'x-forwarded-for': '7.7.7.6' } }), (e) => { err = e || 'ok'; });
  assert.strictEqual(err, 'ok');
  assert.strictEqual(S.clientIp(fakeIoSocket({ ip: '::ffff:5.5.5.5' })), '5.5.5.5');
});

test('input size: 1 to 64 bytes of Buffer or Uint8Array; anything else dropped, never disconnected', () => {
  const r = rig();
  const s = r.sock();
  s.fire('sl:join', { nick: 'i' });
  const room = r.room();
  const before = room.stats.inputs;
  s.fire('sl:i', new Uint8Array(0));
  s.fire('sl:i', new Uint8Array(65));
  s.fire('sl:i', 'abc');
  s.fire('sl:i', { 0: 1 });
  s.fire('sl:i', [1, 2]);
  s.fire('sl:i', enc([{ type: 'ping' }]).subarray(1)); // no version byte: a wire_error, 0 records
  assert.strictEqual(room.stats.inputs, before, 'nothing reached the room');
  assert.strictEqual(r.sockets.stats.inputDropped, 6);
  const recs = [];
  for (let i = 0; i < 31; i++) recs.push(angle(i));
  const big = enc(recs);
  assert.strictEqual(big.length, 63);
  s.fire('sl:i', Buffer.from(big));
  assert.strictEqual(room.stats.inputs, before + 31, 'a 63-byte Buffer of 31 records is taken');
  assert.strictEqual(s.disconnected, false);
});

// Two rooms on one seed: A gets the burst emit by emit, B the merged slot as one emit. Same sim digest after.
function burstVersusMerged(events) {
  const A = rig({ seed: 21 });
  const B = rig({ seed: 21 });
  const C = rig({ seed: 21 }); // no input at all: proves the inputs changed the world
  const sa = A.sock();
  const sb = B.sock();
  const sc = C.sock();
  sa.fire('sl:join', { nick: 'stall' });
  sb.fire('sl:join', { nick: 'stall' });
  sc.fire('sl:join', { nick: 'stall' });
  for (let i = 0; i < 5; i++) { A.room().tickOnce(); B.room().tickOnce(); C.room().tickOnce(); }
  const inputs0 = A.room().stats.inputs;
  for (const ev of events) sa.fire('sl:i', Buffer.from(enc([ev])));
  assert.strictEqual(A.room().stats.inputs - inputs0, events.length, 'every record reached the room');
  // the merged slot: the newest angle; boost changes in arrival order with repeats collapsed (slSim.setInput)
  const merged = [];
  let lastAngle = null;
  let lastBoost = null;
  for (const ev of events) {
    if (ev.type === 'angle') lastAngle = ev;
    if (ev.type === 'boost' && ev.on !== lastBoost) { merged.push(ev); lastBoost = ev.on; }
  }
  if (lastAngle) merged.push(lastAngle);
  sb.fire('sl:i', Buffer.from(enc(merged)));
  assert.strictEqual(A.room().sim.digest(), B.room().sim.digest(), 'the same slot before the step');
  for (let i = 0; i < 60; i++) { A.room().tickOnce(); B.room().tickOnce(); C.room().tickOnce(); }
  assert.strictEqual(A.room().sim.digest(), B.room().sim.digest(), 'the same sim digest after 60 steps');
  assert.notStrictEqual(A.room().sim.digest(), C.room().sim.digest(), 'and not the digest of no input');
  assert.strictEqual(sa.disconnected, false, 'no disconnect');
  assert.strictEqual(A.sockets.stats.floods, 0);
  assert.ok(A.room().sim.snake(A.room().seatOf(sa.id).snakeId), 'the snake is alive and playing');
  return { A, B, merged };
}

test('a replayed 3 s upstream stall at 74 records per second: no disconnect, the same digest as merged', () => {
  const events = [];
  for (let i = 0; i < 222; i++) {
    if (i % 18 === 17) events.push({ type: 'ping' });
    else if (i % 37 === 0) events.push(boost(i % 74 === 0));
    else events.push(angle((i * 7) % 251));
  }
  assert.strictEqual(events.length, 3 * 74);
  const { merged } = burstVersusMerged(events);
  assert.ok(merged.length >= 3, 'boost changes and the newest angle');
});

test('a 2 s stall from a real client gate trace (the frozen slInput gates): no disconnect, the same digest', () => {
  const trace = frozenGateTrace(2000, 1);
  const kinds = {};
  for (const x of trace) kinds[x.ev.type] = (kinds[x.ev.type] || 0) + 1;
  assert.ok(kinds.angle > 20 && kinds.boost >= 4 && kinds.ping === 1, JSON.stringify(kinds));
  burstVersusMerged(trace.map((x) => x.ev));
});

test('sustained abuse over the window disconnects (flood); 222 records a second for 30 s does not', () => {
  let r = rig();
  let s = r.sock();
  s.fire('sl:join', { nick: 'ok' });
  const one = Buffer.from(enc([angle(3)]));
  for (let ms = 0; ms < 30000; ms += 1000 / 222) {
    r.wall.t = 1.7e12 + ms;
    s.fire('sl:i', one);
  }
  assert.strictEqual(s.disconnected, false, 'at the limit: kept');

  r = rig();
  s = r.sock();
  s.fire('sl:join', { nick: 'flood' });
  let sentAt = -1;
  for (let ms = 0; ms < 20000 && !s.disconnected; ms += 1000 / 300) {
    r.wall.t = 1.7e12 + ms;
    s.fire('sl:i', one);
    sentAt = ms;
  }
  refusedWith(s, 'flood');
  assert.ok(sentAt > 7000 && sentAt < 7500, 'tripped when 300 a second passed 2220 in the window (' + Math.round(sentAt) + ' ms)');

  r = rig();
  s = r.sock();
  s.fire('sl:join', { nick: 'junk' });
  const junk = Buffer.alloc(64, 0x7f); // no version byte: 0 records, 64 bytes
  for (let i = 0; i < 2561 && !s.disconnected; i++) s.fire('sl:i', junk);
  refusedWith(s, 'flood');
  assert.strictEqual(r.sockets.stats.floods, 1);
});

test('hold: a press at most every C_RATE.hold; a release only after an accepted press, never dropped', () => {
  const r = rig();
  const s = r.sock();
  s.fire('sl:join', { nick: 'h' });
  const room = r.room();
  const calls = [];
  const orig = r.arenas.hold.bind(r.arenas);
  r.arenas.hold = (id, on) => { calls.push(on); return orig(id, on); };
  s.fire('sl:hold', { on: 0 });
  s.fire('sl:hold', { on: 1 });
  s.fire('sl:hold', { on: 1 });
  s.fire('sl:hold', { on: 0 });
  s.fire('sl:hold', { on: 0 });
  r.wall.t += 50;
  s.fire('sl:hold', { on: true });
  for (const bad of [{ on: 2 }, { on: '1' }, null, [], { x: 1 }]) s.fire('sl:hold', bad);
  assert.deepStrictEqual(calls, [true, false, true]);
  assert.ok(room.holds.size() >= 0);
});

test('vis: hidden at most every C_RATE.vis; a return to visible after an accepted hidden is never dropped', () => {
  const r = rig();
  const s = r.sock();
  s.fire('sl:join', { nick: 'v' });
  const calls = [];
  r.arenas.vis = (id, hidden) => { calls.push(hidden); return true; };
  s.fire('sl:vis', { hidden: 0 });
  s.fire('sl:vis', { hidden: 1 });
  s.fire('sl:vis', { hidden: 1 });
  s.fire('sl:vis', { hidden: 0 });
  r.wall.t += 249;
  s.fire('sl:vis', { hidden: 1 });
  r.wall.t += 1;
  s.fire('sl:vis', { hidden: 1 });
  assert.deepStrictEqual(calls, [true, false, true]);
});

// Fixer pass (2026-10-10): sl:vis is a state the layer sends once per change, so a quick hidden, visible, hidden
// flick inside C_RATE.vis (250) must still end hidden; a visible that comes before the window ends cancels it.
test('vis: hidden, visible, hidden within 100 ms and then nothing ends hidden; a later visible cancels a pending hidden', () => {
  const { fakeTimers } = require('./slNetFakes');
  const vt = fakeTimers(0);
  const r = rig({ helpers: { timers: vt.timers } });
  const s = r.sock();
  s.fire('sl:join', { nick: 'v' });
  const calls = [];
  r.arenas.vis = (id, hidden) => { calls.push(hidden); return true; };
  s.fire('sl:vis', { hidden: 1 });
  r.wall.t += 50;
  s.fire('sl:vis', { hidden: 0 });
  r.wall.t += 50;
  s.fire('sl:vis', { hidden: 1 });
  assert.deepStrictEqual(calls, [true, false], 'the second hidden waits');
  r.wall.t += 250;
  vt.run(250);
  assert.deepStrictEqual(calls, [true, false, true], 'the room ends on hidden');
  // a pending hidden that a visible overtakes never applies
  s.fire('sl:vis', { hidden: 0 });
  r.wall.t += 10;
  s.fire('sl:vis', { hidden: 1 });
  r.wall.t += 10;
  s.fire('sl:vis', { hidden: 0 });
  r.wall.t += 300;
  vt.run(300);
  assert.deepStrictEqual(calls, [true, false, true, false], 'visible stays');
  // a disconnect stops a pending hidden
  s.fire('sl:vis', { hidden: 1 });
  s.fire('sl:vis', { hidden: 0 });
  s.fire('sl:vis', { hidden: 1 });
  assert.strictEqual(vt.pending(), 1);
  s.disconnect();
  assert.strictEqual(vt.pending(), 0, 'the pending timer stopped');
  r.wall.t += 300;
  vt.run(300);
  assert.deepStrictEqual(calls, [true, false, true, false, true, false]);
});

test('chat: joined seats only, a string, at most every C_RATE.chat; diag: only the known fields, checked', () => {
  const r = rig();
  const a = r.sock();
  const b = r.sock();
  b.fire('sl:chat', { text: 'not joined' });
  a.fire('sl:join', { nick: 'a' });
  b.fire('sl:join', { nick: 'b' });
  const room = r.room();
  a.fire('sl:chat', { text: 5 });
  a.fire('sl:chat', { text: 'hi <b>' });
  a.fire('sl:chat', { text: 'too soon' });
  r.ft.runImmediates();
  const lines = layerMsgs(b).filter((m) => m.t === 'chat').map(({ t, name, text }) => ({ t, name, text }));
  assert.deepStrictEqual(lines, [{ t: 'chat', name: 'a', text: 'hi' }], 'the chat guard takes the tag out');
  assert.strictEqual(room.stats.chats, 1);

  assert.deepStrictEqual(S.cleanDiag({ applyThrows: 0, wireErrors: 2, fps: 59.5, pongP95: 120, lastClose: 'net-close',
    extra: 1, maxGapMs: -1, lag: NaN, lagEntries: Infinity, maxOwnChl: 1e300 }, 24),
  { applyThrows: 0, wireErrors: 2, fps: 59.5, pongP95: 120, lastClose: 'net-close' });
  assert.strictEqual(S.cleanDiag({ lastClose: '<script>' }, 24), null);
  assert.strictEqual(S.cleanDiag({ lastClose: 'x'.repeat(25) }, 24), null);
  a.fire('sl:diag', { wireErrors: 3, pongP95: 80 });
  a.fire('sl:diag', { wireErrors: 3 });
  assert.strictEqual(room.stats.diag.wireErrors, 3, 'one report per C_RATE.diag');
  assert.strictEqual(room.stats.diag.reports, 1);
});

test('leave: the seat goes (a live snake glides, C_DISCONNECT); disconnect too, once', () => {
  const r = rig();
  const s = r.sock();
  s.fire('sl:join', { nick: 'l' });
  const room = r.room();
  s.fire('sl:leave');
  assert.strictEqual(room.seats.size, 0);
  assert.strictEqual(room.orphans.size, 1, 'gliding');
  s.disconnect();
  assert.strictEqual(room.stats.leaves, 1, 'the disconnect after the leave changes nothing');
  assert.strictEqual(r.sockets.sockets(), 0);
});

test('handshake skin: a shipped cv is kept; a picture skin (switch off), junk or none is a plain colour 0 to 8', () => {
  const r = rig();
  const cvOf = (auth) => {
    const s = r.sock({ auth });
    s.fire('sl:join', { nick: 'c' });
    return r.room().seatOf(s.id).cv;
  };
  assert.strictEqual(cvOf({ cv: 7 }), 7);
  assert.strictEqual(cvOf({ cv: 65 }), 65);
  assert.ok(Object.is(cvOf({ cv: -0 }), 0), '-0 is skin 0, never -0 (the wire cannot carry -0; found by slFuzz)');
  for (const auth of [{ cv: 37 }, { cv: 62 }, { cv: 66 }, { cv: -1 }, { cv: 7.5 }, { cv: '7' }, undefined, null, 'x',
    { cv: NaN }]) {
    const cv = cvOf(auth);
    assert.ok(Number.isInteger(cv) && cv >= 0 && cv <= 8, JSON.stringify(auth) + ' -> ' + cv);
  }
});

test('owner push: at most one per name per 10 minutes and 6 per 10 minutes in total (C_PUSH)', async () => {
  const r = rig({ patch: { C_SL_PER_IP: 100 } });
  const join = (nick) => { const s = r.sock(); s.fire('sl:join', { nick }); };
  join('owen');
  join('owen');
  for (let i = 0; i < 10; i++) join('p' + i);
  await new Promise((res) => setImmediate(res));
  assert.deepStrictEqual(r.pushes, ['owen', 'p0', 'p1', 'p2', 'p3', 'p4']);
  r.wall.t += 600000;
  join('owen');
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(r.pushes[r.pushes.length - 1], 'owen', 'a new window');
  const g = S.createPushGate({ perNameMs: 600000, windowMs: 600000, maxPerWindow: 6 });
  assert.strictEqual(g.allow('a', 0), true);
  assert.strictEqual(g.allow('a', 599999), false);
  assert.strictEqual(g.allow('a', 600000), true);
});

// Paid task T4 (PAID-SL-DESIGN 3.1): the delegation exists only with a helper attached; slPaidRouting and
// slPaidHostile run it with the real paid directory and door.
test('paid delegation only with setPaid: auth.paid 1 sends the join to the door and every seat call to the paid directory', () => {
  const r = rig();
  const calls = [];
  const dir = {};
  for (const k of ['leave', 'disconnect', 'input', 'hold', 'vis', 'chat', 'diag']) {
    dir[k] = (id) => {
      calls.push([k, id]);
      return false;
    };
  }
  dir.roomForKey = (k) => {
    calls.push(['roomForKey', k]);
    return null;
  };
  const joins = [];
  const door = { join: (s, info) => joins.push([s.id, info]) };
  assert.throws(() => r.sockets.setPaid({ arenas: {}, door }), /setPaid needs arenas.leave/);
  assert.throws(() => r.sockets.setPaid({ arenas: dir, door: null }), /setPaid needs door.join/);
  assert.strictEqual(r.sockets.paid(), false);
  // a paid page that connected before the helper keeps the free route (its token is never read)
  const early = r.sock({ auth: { paid: 1, cv: 5, entryToken: 't', stake: 0.5 } });
  assert.strictEqual(r.sockets.setPaid({ arenas: dir, door }), true);
  early.fire('sl:join', { nick: 'e' });
  assert.ok(r.room().seatOf(early.id), 'a free seat');
  // a paid socket: the cleaned name and its skin go to the door, nothing to the free room
  const p = r.sock({ auth: { paid: 1, cv: 5 } });
  p.fire('sl:join', { nick: 'Owené 1' });
  // skin: a bought skin's bytes, null with no skin pass (docs/skin-purchases.md); ip: the socket's client address, for
  // the door's one paid snake per address per room (night review 2026-10-29)
  assert.deepStrictEqual(joins, [[p.id, { nick: cleanNick('Owené 1', r.laws), cv: 5, skin: null, ip: '10.0.0.1' }]]);
  assert.strictEqual(r.room().seatOf(p.id), null);
  r.wall.t += 1000;
  p.fire('sl:join', { nick: 'again' });
  assert.strictEqual(joins.length, 1, 'once per socket');
  p.fire('sl:i', enc([angle(3)]));
  p.fire('sl:hold', { on: 1 });
  p.fire('sl:hold', { on: 0 });
  p.fire('sl:vis', { hidden: 1 });
  p.fire('sl:chat', { text: 'x' });
  p.fire('sl:diag', { fps: 60 });
  p.fire('sl:leave');
  p.disconnect();
  assert.deepStrictEqual(calls.map((c) => c[0]), ['input', 'hold', 'hold', 'vis', 'chat', 'diag', 'leave', 'leave']);
  assert.ok(calls.every((c) => c[1] === p.id));
  // a paid sl:back looks its key up in the paid rooms only
  const q = r.sock({ auth: { paid: 1 } });
  const k = '00000000-0000-4000-8000-000000000000';
  const n0 = calls.length;
  q.fire('sl:back', { k, n: 0, p: 0 });
  assert.deepStrictEqual(calls.slice(n0), [['roomForKey', k], ['disconnect', q.id]], 'then its refused socket closes');
  assert.deepStrictEqual(q.emitted[q.emitted.length - 1].data, [{ t: 'refused', why: 'gone' }]);
  // maintenance and the free door off never stop a paid join (the door decides, critic C-1); money fields still do
  r.ops.maintenance = true;
  r.arenas.door(false);
  const m = r.sock({ auth: { paid: 1 } });
  m.fire('sl:join', { nick: 'm' });
  assert.strictEqual(joins.length, 2);
  const mf = r.sock({ auth: { paid: 1 } });
  mf.fire('sl:join', { nick: 'x', entryToken: 'e' });
  refusedWith(mf, 'not-open');
  assert.strictEqual(joins.length, 2);
  assert.strictEqual(r.sockets.stats.paidJoins, 2);
  // detached: a new paid page is a free socket again
  r.ops.maintenance = false;
  r.arenas.door(true);
  assert.strictEqual(r.sockets.setPaid(null), false);
  const after = r.sock({ auth: { paid: 1 } });
  after.fire('sl:join', { nick: 'a' });
  assert.ok(r.room().seatOf(after.id));
  assert.strictEqual(joins.length, 2);
});

test('a thrown join (the room could not seat) is a closed refusal, never a hanging socket', () => {
  const r = rig();
  r.arenas.join = () => { throw new Error('boom'); };
  const s = r.sock();
  s.fire('sl:join', { nick: 'x' });
  refusedWith(s, 'closed');
  assert.strictEqual(r.sockets.stats.guarded, 0, 'handled, not a guard catch');
});

// Fixer pass (2026-10-10): a gliding snake (C_DISCONNECT, 3000 ms) is a live human snake. Join-then-close cycles kept
// hundreds of them in the sim against a cap of 20 (the caps counted seats only) and freed their address at once.
function cycle(r, ip, nick) {
  const s = r.sock({ ip });
  s.fire('sl:join', { nick });
  const refused = layerMsgs(s).find((m) => m.t === 'refused');
  s.disconnect();
  return refused ? refused.why : 'joined';
}

test('caps: 400 join-and-close cycles never hold more than C_HUMAN_CAP live human snakes (gliders count)', () => {
  const r = rig({ seed: 5, patch: { C_ROOM_CAP: 20, C_HUMAN_CAP: 20 } });
  const room = r.room();
  const seen = { joined: 0, full: 0 };
  let peak = 0;
  for (let i = 0; i < 400; i++) {
    const why = cycle(r, '10.1.' + (i >> 8) + '.' + (i & 255), 'c' + i);
    if (why === 'joined') seen.joined++;
    else if (why === 'full') seen.full++;
    else assert.fail('refused ' + why);
    if (room.sim.count() > peak) peak = room.sim.count();
    assert.ok(room.seats.size + room.orphans.size <= 20);
    r.wall.t += 2;
    if (i % 8 === 7) room.tickOnce(); // the room keeps ticking: glides run out after 3000 ms
  }
  assert.ok(peak <= 20, 'peak live snakes ' + peak);
  assert.ok(seen.full > 0 && seen.joined > 20, JSON.stringify(seen));
});

test('per address: a gliding snake stays charged to its address until the glide ends (30 per address = 30 live snakes)', () => {
  const r = rig({ seed: 6 });
  const room = r.room();
  const ip = '10.9.9.9';
  const got = [];
  for (let i = 0; i < 40; i++) got.push(cycle(r, ip, 'g' + i));
  assert.deepStrictEqual(got.slice(0, 30), Array(30).fill('joined'));
  assert.deepStrictEqual(got.slice(30), Array(10).fill('limit'), 'the 31st connection while 30 snakes glide');
  assert.strictEqual(room.orphans.size, 30);
  assert.strictEqual(r.sockets.gate.count(ip), 30);
  // sl:leave then close: the glide keeps the charge after the socket closed, too
  for (let t = 0; t < 80; t++) room.tickOnce(); // 80 x 42.67 ms > 3000 ms glide: every glider dies
  assert.strictEqual(room.orphans.size, 0);
  assert.strictEqual(r.sockets.gate.count(ip), 0, 'every charge released at its glide end');
  const s = r.sock({ ip });
  s.fire('sl:join', { nick: 'leaver' });
  r.wall.t += 1000;
  s.fire('sl:leave');
  assert.strictEqual(room.orphans.size, 1);
  s.disconnect();
  assert.strictEqual(r.sockets.gate.count(ip), 1, 'the leave glide holds the charge after the close');
  for (let t = 0; t < 80; t++) room.tickOnce();
  assert.strictEqual(r.sockets.gate.count(ip), 0);
  // a socket that never joined frees its address at once
  const idle = r.sock({ ip });
  assert.strictEqual(r.sockets.gate.count(ip), 1);
  idle.disconnect();
  assert.strictEqual(r.sockets.gate.count(ip), 0);
});

test('a stopped room releases every glider charge (an emergency close never strands an address)', () => {
  const r = rig({ seed: 7 });
  const ip = '10.8.8.8';
  for (let i = 0; i < 5; i++) cycle(r, ip, 'e' + i);
  assert.strictEqual(r.sockets.gate.count(ip), 5);
  r.room().stop();
  assert.strictEqual(r.sockets.gate.count(ip), 0);
});

test('an sl:leave whose handler socket.io dropped (closed in the same batch) still makes the close a leave, not a park', () => {
  const r = rig({ seed: 6 });
  const room = r.room();
  // socket.io: onAny runs at once, the handler on the next tick, dropped once the socket closed (the batch case)
  const s = r.sock({ ip: '10.9.0.1' });
  s.fire('sl:join', { nick: 'a' });
  assert.strictEqual(room.seats.size, 1);
  const h = s.handlers.get('sl:leave');
  s.handlers.delete('sl:leave');
  s.fire('sl:leave');
  s.handlers.set('sl:leave', h);
  assert.strictEqual(room.seats.size, 1, 'the handler did not run');
  s.disconnect();
  assert.strictEqual(room.stats.parks, 0, 'not parked');
  assert.strictEqual(room.parked.size, 0);
  assert.strictEqual(room.seats.size, 0);
  // a close with no sl:leave is a drop: it parks (T16b)
  const b = r.sock({ ip: '10.9.0.2' });
  b.fire('sl:join', { nick: 'b' });
  b.disconnect();
  assert.strictEqual(room.stats.parks, 1, 'a drop parks');
});

test('real socket.io: their close (emit sl:leave, then disconnect) leaves; a bare disconnect parks', { timeout: 30000 }, async () => {
  const http = require('http');
  const path = require('path');
  const { Server } = require('socket.io');
  const { io: ioc } = require('socket.io-client');
  const server = http.createServer();
  const io = new Server(server, { pingInterval: 5000, pingTimeout: 10000 });
  const quiet = { log() {}, warn() {}, error() {} };
  const opened = require('../server/sl/slBoot').openSl({
    env: { SL_ENABLED: '1', SL_DEV_LAWS: path.join(__dirname, 'slLawsFixture.js') }, io, region: 'na', seed: 3, log: quiet,
    helpers: {
      socketRL: (so, k, ms) => {
        const now = Date.now();
        if (!so._rl) so._rl = {};
        if (so._rl[k] && now - so._rl[k] < ms) return false;
        so._rl[k] = now;
        return true;
      },
      ops: require('../server/ops'), notifyJoin() {}, paidLoad: () => ({ paidPlayers: 0, paid: [] }),
    },
  });
  assert.ok(opened.arenas, 'the room opened: ' + opened.why);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const url = 'http://127.0.0.1:' + server.address().port + '/sl';
  const room = opened.arenas.room();
  const life = (transport, ip, withLeave) => new Promise((res, rej) => {
    const c = ioc(url, { transports: [transport], forceNew: true, reconnection: false, extraHeaders: { 'x-forwarded-for': ip } });
    c.on('connect', () => c.emit('sl:join', { nick: 'p' }));
    c.once('sl:f', () => {
      // public/js/sl/slNet.js:181-182
      if (withLeave && c.connected) c.emit('sl:leave');
      c.disconnect();
      setTimeout(res, 300);
    });
    c.on('connect_error', rej);
  });
  try {
    for (const transport of ['polling', 'websocket']) {
      const p0 = room.stats.parks;
      const l0 = room.stats.leaves;
      await life(transport, '10.8.0.' + (transport === 'polling' ? 1 : 2), true);
      assert.strictEqual(room.stats.parks - p0, 0, transport + ': their close is a leave, not a park');
      assert.strictEqual(room.stats.leaves - l0, 1, transport);
      await life(transport, '10.8.1.' + (transport === 'polling' ? 1 : 2), false);
      assert.strictEqual(room.stats.parks - p0, 1, transport + ': a disconnect with no sl:leave parks (T16b)');
    }
  } finally {
    opened.arenas.close();
    io.close();
    server.close();
  }
});
