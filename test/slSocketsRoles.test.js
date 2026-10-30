'use strict';
/* The /sl router's roles (server/sl/slSockets.js Roles; server split spec 6.3 and 14.1 #1). One process today ('all');
   with the split, the main server's router takes paid seats and paid-rung watchers only ('paid') and the slither
   process's never takes a paid handshake ('free'). The other side's socket is refused 'closed' at connect, before the
   per-address gate counts it and before any sl:join, so a misrouted page's entry token is never read.

   - role 'paid': a free player, a free watcher, a battle royale player and its watcher are refused 'closed' with no
     gate count left behind (50 in a row from one address, and that address still connects a paid page); paid 1 and a
     watchStake naming a rung are admitted and reach the paid door / the paid rung's watch; paid 1 with no paid
     helper attached, and a watchStake naming no rung, are refused the same way
   - role 'free': paid 1 and any watchStake (a battle royale one too) are refused 'closed' without a read of the
     handshake's token; a free player, a free watcher and the battle royale's player and watcher are admitted
   - role 'all' (the default): today's routing, a paid 1 handshake with no paid helper still connects; a role that is
     none of the three is refused at attach */
const test = require('node:test');
const assert = require('node:assert');
const { rig, layerMsgs } = require('./slSockFakes');
const { ROLES } = require('../server/sl/slSockets');

const IP = '203.0.113.9';

// The paid directory and door, as setPaid checks them; every call recorded. Rungs 0.5 and 1.
function paidFake() {
  const calls = [];
  const arenas = { rungs: new Map(), isOpen: () => true, _rungOf: (w) => (w === 0.5 || w === 1 ? w : null) };
  for (const k of ['leave', 'disconnect', 'input', 'hold', 'vis', 'chat', 'diag', 'roomForKey']) {
    arenas[k] = () => { calls.push(k); };
  }
  arenas.watch = (socket, o) => { calls.push('watch ' + o.stake); return true; };
  const door = { join: (socket, o) => { calls.push('door ' + o.nick); } };
  return { arenas, door, calls };
}

// The battle royale's directory, as setBr checks it; every call recorded.
function brFake() {
  const calls = [];
  const arenas = { room: () => null, isOpen: () => true };
  for (const k of ['join', 'watch', 'leave', 'disconnect', 'input', 'hold', 'vis', 'chat', 'diag']) {
    arenas[k] = () => { calls.push(k); return true; };
  }
  return { arenas, calls };
}

const refusal = (s) => layerMsgs(s).filter((m) => m.t === 'refused');
const closed = (s) => s.disconnected === true && JSON.stringify(refusal(s)) === '[{"t":"refused","why":"closed"}]';

// A handshake whose token fields count every read (a getter): the refused sockets must never read one.
function watchedAuth(fields, reads) {
  const auth = Object.assign({}, fields);
  for (const k of ['entryToken', 'stake', 'wallet', 'idProof']) {
    if (Object.prototype.hasOwnProperty.call(auth, k)) continue;
    Object.defineProperty(auth, k, { enumerable: true, get() { reads.push(k); return 'x'; } });
  }
  return auth;
}

test('the roles are all, paid and free; anything else is refused at attach', () => {
  assert.deepStrictEqual([...ROLES], ['all', 'paid', 'free']);
  assert.strictEqual(rig().sockets.role, 'all', 'none given: one process, as today');
  for (const role of ['all', 'paid', 'free']) assert.strictEqual(rig({ helpers: { role } }).sockets.role, role);
  for (const role of ['', 'Paid', 'child', null, 1]) {
    assert.throws(() => rig({ helpers: { role } }), /helpers\.role must be all, paid or free/, String(role));
  }
});

test('role paid: free, free watch, battle royale and its watch refused closed at connect, no gate count left', () => {
  const r = rig({ helpers: { role: 'paid' } });
  const paid = paidFake();
  const br = brFake();
  r.sockets.setPaid({ arenas: paid.arenas, door: paid.door });
  r.sockets.setBr({ arenas: br.arenas, identify: () => null });
  for (const auth of [{ cv: 2 }, { watch: 1 }, { watch: 1, after: 4 }, { br: 1 }, { br: 1, watch: 1, follow: 3 },
    { br: 1, watch: 1, watchStake: 0.5 }, undefined]) {
    const s = r.sock({ ip: IP, auth });
    assert.ok(closed(s), JSON.stringify(auth) + ': refused closed');
    s.fire('sl:join', { nick: 'late' }); // a join after the refusal finds no state
  }
  assert.strictEqual(r.sockets.sockets(), 0, 'no state kept');
  assert.strictEqual(r.sockets.gate.count(IP), 0, 'never counted');
  for (let i = 0; i < 50; i++) assert.ok(closed(r.sock({ ip: IP, auth: { cv: 1 } })));
  assert.strictEqual(r.sockets.gate.count(IP), 0, 'fifty refusals leave the address with no count');
  assert.strictEqual(r.sockets.stats.refused.closed, 57);
  assert.strictEqual(r.room().seats.size, 0, 'the free room never saw one');
  assert.deepStrictEqual(paid.calls, []);
  assert.deepStrictEqual(br.calls, [], 'nor the battle royale');
  // the same address still connects a paid page
  const p = r.sock({ ip: IP, auth: { paid: 1, cv: 2 } });
  assert.deepStrictEqual(refusal(p), []);
  assert.strictEqual(r.sockets.gate.count(IP), 1);
});

test('role paid: a paid page and a paid rung\'s watcher are admitted and reach the paid side only', () => {
  const r = rig({ helpers: { role: 'paid' } });
  const paid = paidFake();
  // before the paid helper is attached nothing is paid here: refused closed, never seated free
  const early = r.sock({ ip: IP, auth: { paid: 1 } });
  assert.ok(closed(early));
  r.sockets.setPaid({ arenas: paid.arenas, door: paid.door });
  const p = r.sock({ ip: IP, auth: { paid: 1, stake: 0.5, cv: 2 } });
  assert.deepStrictEqual(refusal(p), []);
  p.fire('sl:join', { nick: 'payer' });
  const w = r.sock({ ip: IP, auth: { watch: 1, watchStake: 1 } });
  assert.deepStrictEqual(refusal(w), []);
  w.fire('sl:join', {});
  assert.deepStrictEqual(paid.calls, ['door payer', 'watch 1']);
  assert.strictEqual(r.room().seats.size + r.room().watchers.size, 0, 'the free room took neither');
  // a watchStake that names no rung is no paid watcher: refused at connect like any other free socket
  for (const ws of [0.3, 0, -1, '0.5']) assert.ok(closed(r.sock({ ip: IP, auth: { watch: 1, watchStake: ws } })), String(ws));
  assert.strictEqual(r.sockets.gate.count(IP), 2, 'the two admitted ones only');
  p.disconnect();
  w.disconnect();
  assert.strictEqual(r.sockets.gate.count(IP), 0);
});

test('role free: paid 1 and any watchStake refused closed with the token unread; free, watch and the event admitted', () => {
  const r = rig({ helpers: { role: 'free' } });
  const br = brFake();
  r.sockets.setBr({ arenas: br.arenas, identify: () => null });
  const reads = [];
  for (const fields of [{ paid: 1 }, { paid: 1, br: 1 }, { watch: 1, watchStake: 0.5 }, { watchStake: 1 },
    { br: 1, watch: 1, watchStake: 0.5 }, { watch: 1, watchStake: 0 }]) {
    const s = r.sock({ ip: IP, auth: watchedAuth(fields, reads) });
    assert.ok(closed(s), JSON.stringify(fields));
    s.fire('sl:join', { nick: 'x', entryToken: 'tok' });
  }
  assert.deepStrictEqual(reads, [], 'no token, stake, wallet or proof read from a refused handshake');
  assert.strictEqual(r.sockets.gate.count(IP), 0);
  assert.deepStrictEqual(br.calls, []);

  const free = r.sock({ ip: IP, auth: { cv: 3 } });
  free.fire('sl:join', { nick: 'free' });
  assert.deepStrictEqual(refusal(free), []);
  assert.strictEqual(r.room().seats.size, 1, 'seated in the free room');
  const watch = r.sock({ ip: IP, auth: { watch: 1 } });
  watch.fire('sl:join', {});
  assert.deepStrictEqual(refusal(watch), []);
  assert.strictEqual(r.room().watchers.size, 1, 'watching the free room');
  const player = r.sock({ ip: IP, auth: { br: 1 } });
  player.fire('sl:join', { nick: 'event' });
  const watcher = r.sock({ ip: IP, auth: { br: 1, watch: 1 } });
  watcher.fire('sl:join', {});
  assert.deepStrictEqual(br.calls, ['join', 'watch']);
  // only paid 1 is paid: anything else in that field is a free handshake, as the server's paidOf reads it
  const odd = r.sock({ ip: IP, auth: { paid: '1' } });
  assert.deepStrictEqual(refusal(odd), []);
  assert.strictEqual(r.sockets.gate.count(IP), 5);
});

test('role all (the default): today\'s routing, a paid 1 handshake with no paid helper still connects', () => {
  const r = rig();
  const s = r.sock({ ip: IP, auth: { paid: 1 } });
  assert.deepStrictEqual(refusal(s), [], 'connected');
  s.fire('sl:join', { nick: 'p', entryToken: 't' });
  assert.deepStrictEqual(refusal(s), [{ t: 'refused', why: 'not-open' }], 'and refused at its join, as before');
  const w = r.sock({ ip: IP, auth: { watch: 1, watchStake: 0.5 } });
  assert.deepStrictEqual(refusal(w), [], 'a watchStake with no paid rung connects');
  w.fire('sl:join', {});
  assert.deepStrictEqual(refusal(w), [{ t: 'refused', why: 'not-open' }], 'and is refused like a money field');
  assert.strictEqual(r.sockets.stats.refused.closed, undefined, 'no role refusal');
});
