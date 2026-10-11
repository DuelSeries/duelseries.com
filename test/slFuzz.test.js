'use strict';
// slFuzz (SERVER-DESIGN 18.4; task T11): every sl:* handler fed hostile payloads (no payload, null, arrays, Buffers
// where objects are expected and the reverse, throwing getters, __proto__ keys, 1 MB strings, NaN, Infinity, -0, 1e300,
// out-of-range skins, truncated and oversized input bundles, floods, junk handshake auth) never throws (no guard
// catch), never puts a non-finite number into the sim, and never makes the server send a wire_error.
const test = require('node:test');
const assert = require('node:assert');
const W = require('../shared/slWire.js');
const { rig } = require('./slSockFakes');
const { createRng } = require('../server/sl/slRng');

const EVENTS = ['sl:join', 'sl:i', 'sl:hold', 'sl:vis', 'sl:chat', 'sl:diag', 'sl:leave'];
const BIG = 'x'.repeat(1 << 20);

function throwing(key) {
  const o = {};
  Object.defineProperty(o, key, { enumerable: true, get() { throw new Error('getter ' + key); } });
  return o;
}

function hostileValues(rng) {
  const nums = [NaN, Infinity, -Infinity, -0, 0, 1, 2, -1, 1e300, -1e300, 2147483648, 0.5, 251, 255, 256];
  const n = nums[rng.int(nums.length)];
  const list = [
    undefined, null, n, 'str', BIG, [], [1, 2], {}, true, false,
    Buffer.from([1, 2, 3]), new Uint8Array(70), new ArrayBuffer(4),
    { nick: n }, { nick: BIG }, { nick: ['a'] }, { nick: { toString() { throw new Error('ts'); } } },
    { on: n }, { hidden: n }, { text: n }, { text: BIG }, { text: ['x'] },
    { applyThrows: n, wireErrors: n, fps: n, pongP95: n, lastClose: n }, { lastClose: BIG },
    JSON.parse('{"__proto__": {"nick": "proto", "on": 1, "hidden": 1, "text": "p"}}'),
    JSON.parse('{"constructor": {"prototype": {"x": 1}}, "nick": "c"}'),
    throwing('nick'), throwing('on'), throwing('hidden'), throwing('text'), throwing('wireErrors'), throwing('stake'),
    Object.create(null), Object.assign(Object.create(null), { nick: 'np', on: 1 }),
  ];
  return list[rng.int(list.length)];
}

function inputBundle(rng) {
  const recs = [];
  const k = rng.int(40);
  for (let i = 0; i < k; i++) {
    const t = rng.int(5);
    if (t === 0) recs.push({ type: 'angle', q: rng.int(251) });
    else if (t === 1) recs.push({ type: 'turn', dir: rng.int(2) ? 'left' : 'right', v: rng.int(128) });
    else if (t === 2) recs.push({ type: 'boost', on: rng.int(2) === 1 });
    else recs.push({ type: 'ping' });
  }
  const b = W.encodeInput(recs);
  const cut = rng.int(4);
  if (cut === 0) return b.subarray(0, rng.int(b.length + 1)); // truncated
  if (cut === 1) {
    const junk = new Uint8Array(rng.int(80));
    for (let i = 0; i < junk.length; i++) junk[i] = rng.int(256);
    return junk;
  }
  return Buffer.from(b);
}

function checkSim(room) {
  room.sim.forEachSnake((s) => {
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (typeof v === 'number') assert.ok(Number.isFinite(v), 'snake ' + s.id + ' field ' + k + ' = ' + v);
    }
    for (const p of s.pts) {
      for (const k of Object.keys(p)) {
        if (typeof p[k] === 'number') assert.ok(Number.isFinite(p[k]), 'snake ' + s.id + ' point ' + k);
      }
    }
  });
}

for (const seed of [1, 2, 3]) {
  test('fuzz seed ' + seed + ': 6000 hostile messages over 40 sockets, the room stepping between them', () => {
    const rng = createRng(9000 + seed);
    const r = rig({ seed, bots: true, patch: { C_SL_PER_IP: 1000 } });
    const auths = [undefined, null, 'x', 5, [], { cv: 999 }, { cv: -0 }, { cv: NaN }, { cv: 1e300 }, { cv: '3' },
      throwing('cv'), { cv: 12 }, { cv: 37 }];
    const socks = [];
    for (let i = 0; i < 40; i++) {
      socks.push(r.sock({ ip: '10.1.' + (i % 5) + '.1', auth: auths[rng.int(auths.length)] }));
    }
    let wireErrors = 0;
    let bundles = 0;
    for (let n = 0; n < 6000; n++) {
      const s = socks[rng.int(socks.length)];
      const ev = EVENTS[rng.int(EVENTS.length)];
      let arg;
      if (ev === 'sl:i') arg = rng.int(4) ? inputBundle(rng) : hostileValues(rng);
      else if (ev === 'sl:join' && rng.int(3) === 0) arg = { nick: 'p' + rng.int(1000) };
      else arg = hostileValues(rng);
      s.fire(ev, arg, () => { throw new Error('an ack was called'); });
      r.wall.t += rng.int(30);
      if (n % 25 === 0) {
        r.room().tickOnce();
        r.ft.runImmediates();
      }
      if (n % 500 === 0) checkSim(r.room());
      // a disconnected socket is replaced, as a client reconnects with a new socket per life
      if (s.disconnected) socks[socks.indexOf(s)] = r.sock({ ip: '10.2.' + rng.int(5) + '.1' });
    }
    // flood: one socket far past the input window
    const f = r.sock({ ip: '10.9.9.9' });
    f.fire('sl:join', { nick: 'flood' });
    const one = Buffer.from(W.encodeInput([{ type: 'angle', q: 1 }]));
    for (let i = 0; i < 3000 && !f.disconnected; i++) f.fire('sl:i', one);
    assert.strictEqual(f.disconnected, true, 'a flood is disconnected');
    // fixer pass (2026-10-10): empty binaries and non-binary emits carry no record but still count one each
    for (const junk of [Buffer.alloc(0), 'x', 7]) {
      const e = r.sock({ ip: '10.9.9.8' });
      e.fire('sl:join', { nick: 'empty' });
      let n = 0;
      for (; n < 500000 && !e.disconnected; n++) e.fire('sl:i', junk);
      assert.strictEqual(e.disconnected, true, 'an empty or non-binary sl:i flood is disconnected: ' + JSON.stringify(junk));
      assert.ok(n <= 2221, 'refused at the C_RATE_INPUT record bound (2220 per 10 s), after ' + n);
    }
    for (let i = 0; i < 40; i++) r.room().tickOnce();
    r.ft.runImmediates();
    checkSim(r.room());
    for (const s of socks.concat([f])) {
      for (const e of s.emitted) {
        if (e.name !== 'sl:f') continue;
        bundles++;
        for (const x of W.decodeBundle(e.data)) if (x.type === 'wire_error') wireErrors++;
      }
    }
    assert.strictEqual(r.sockets.stats.guarded, 0, 'no handler threw');
    assert.strictEqual(r.room().safeStats.total, 0, 'no room job threw');
    assert.strictEqual(wireErrors, 0, 'no wire_error sent');
    assert.ok(bundles > 100, 'bundles were sent (' + bundles + ')');
    assert.ok(r.room().stats.joins > 10, 'seats were made (' + r.room().stats.joins + ')');
    r.arenas.close();
  });
}
