'use strict';
// agar.io redo, integrator card: public/js/ag/agNet.js (build brief 6, 8 and 9.1) with a fake socket.
// Bundles decode through the shared wire into mirror records in order; a bad bundle keeps the
// records before it and drops the rest; every outbound event is 'ag:*' with integer targets and
// nothing goes out while the socket is down; the transport is never forced. Plus the clean-room
// scan of the integrator's shipped files (agNet.js, agMain.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const W = require('../shared/agWire.js');
const N = require('../public/js/ag/agNet.js');
const NET_FILE = path.join(__dirname, '../public/js/ag/agNet.js');
const MAIN_FILE = path.join(__dirname, '../public/js/ag/agMain.js');

function fakeSocket(connected) {
  const handlers = {};
  const emitted = [];
  return {
    connected: !!connected,
    closed: false,
    handlers,
    emitted,
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    emit(ev, payload) { emitted.push(arguments.length > 1 ? [ev, payload] : [ev]); },
    close() { this.closed = true; this.connected = false; },
    fire(ev, arg) { (handlers[ev] || []).forEach((fn) => fn(arg)); }
  };
}

const CELL = { id: 7, x: -500, y: 1200, size: 32, virus: false, food: true, ejected: false, agitated: false, flag40: false, party: false, rgb: [255, 7, 173] };
function joinBundle() {
  return W.encodeBundle([
    { t: 'hello' },
    { t: 'border', minX: -2000, minY: -2000, maxX: 2000, maxY: 2000, mode: 0 },
    { t: 'own', id: 9 },
    { t: 'world', eats: [], cells: [CELL, Object.assign({}, CELL, { id: 9, food: false, name: 'owen' })], removed: [] }
  ]);
}

test('a bundle on ag:f reaches the page as mirror records, in order', () => {
  const sock = fakeSocket(true);
  const got = [];
  const net = N.createNet({ socket: sock, onMessage: (r) => got.push(r) });
  sock.fire('ag:f', joinBundle());
  assert.deepStrictEqual(got.map((r) => r.t), ['hello', 'border', 'own', 'world']);
  assert.strictEqual(got[1].mode, 0);
  assert.strictEqual(got[2].id, 9);
  assert.deepStrictEqual(got[3].cells.map((c) => [c.id, c.x, c.y, c.size, c.food]), [[7, -500, 1200, 32, true], [9, -500, 1200, 32, false]]);
  assert.strictEqual(got[3].cells[1].name, 'owen');
  assert.deepStrictEqual(got[3].cells[0].rgb, [255, 7, 173]);
  assert.strictEqual(net.stats.bundles, 1);
  assert.strictEqual(net.stats.records, 4);
  assert.strictEqual(net.stats.errors, 0);
});

test('ArrayBuffer bundles (what socket.io gives a browser) decode the same', () => {
  const got = [];
  const net = N.createNet({ socket: null, onMessage: (r) => got.push(r) });
  const b = joinBundle();
  net.handleBundle(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  assert.strictEqual(got.length, 4);
  assert.strictEqual(net.stats.bytes, b.byteLength);
});

test('sync records pass straight through to the page', () => {
  const got = [];
  const net = N.createNet({ onMessage: (r) => got.push(r) });
  net.handleBundle(W.encodeBundle([{ t: 'sync', eats: [], cells: [CELL], removed: [] }]));
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].t, 'sync');
  assert.strictEqual(got[0].cells[0].id, 7);
});

test('a bad bundle keeps the records before the bad one, drops the rest, counts and logs it', () => {
  const good = W.encodeBundle([{ t: 'hello' }, { t: 'own', id: 3 }]);
  const tail = W.encodeBundle([{ t: 'world', eats: [], cells: [CELL], removed: [] }]);
  // version byte, the two good records, then a world record cut short
  const bad = new Uint8Array(good.length + 6);
  bad.set(good, 0);
  bad.set(tail.subarray(1, 7), good.length);
  const got = [], errs = [], logs = [];
  const net = N.createNet({ onMessage: (r) => got.push(r), onError: (r) => errs.push(r), log: (t) => logs.push(t) });
  net.handleBundle(bad);
  assert.deepStrictEqual(got.map((r) => r.t), ['hello', 'own']);
  assert.strictEqual(errs.length, 1);
  assert.strictEqual(errs[0].t, 'error');
  assert.strictEqual(net.stats.errors, 1);
  assert.ok(net.stats.lastError && net.stats.lastError.bundle === 1);
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /bad bundle/);
  // An unknown record kind and garbage both end the bundle the same way, never throwing.
  assert.doesNotThrow(() => net.handleBundle(new Uint8Array([1, 200, 1, 2, 3])));
  assert.doesNotThrow(() => net.handleBundle(new Uint8Array([])));
  assert.doesNotThrow(() => net.handleBundle(null));
  assert.strictEqual(got.length, 2);
});

test('outbound: ag:* events with the agreed payloads, integer targets', () => {
  const sock = fakeSocket(true);
  const net = N.createNet({ socket: sock });
  assert.strictEqual(net.sendJoin('owen'), true);
  net.sendSpectate();
  net.sendTarget(12.9, -7.9);
  net.sendSplit();
  net.sendEject();
  net.sendQ();
  net.sendLeave();
  assert.deepStrictEqual(sock.emitted, [
    ['ag:join', { name: 'owen' }], ['ag:spectate'], ['ag:target', { x: 12, y: -7 }], ['ag:split'], ['ag:eject'], ['ag:q'], ['ag:leave']
  ]);
  assert.ok(sock.emitted.every((e) => /^ag:/.test(e[0])), 'never cell:*');
  assert.strictEqual(net.stats.sent, 7);
});

test('non-finite targets are never sent', () => {
  const sock = fakeSocket(true);
  const net = N.createNet({ socket: sock });
  for (const [x, y] of [[NaN, 0], [0, Infinity], [-Infinity, 1], ['5', 5], [null, 0], [undefined, 1], [{}, 2]]) {
    assert.strictEqual(net.sendTarget(x, y), false);
  }
  assert.strictEqual(sock.emitted.length, 0);
});

test('send(kind, payload) maps agMain\'s kinds onto the events', () => {
  const sock = fakeSocket(true);
  const net = N.createNet({ socket: sock });
  net.send('play', { name: 'a' });
  net.send('spectate');
  net.send('target', { x: 1, y: 2 });
  net.send('split');
  net.send('eject');
  net.send('q');
  net.send('leave');
  net.send('view', { below: 102 });
  assert.strictEqual(net.send('nonsense'), false);
  assert.deepStrictEqual(sock.emitted.map((e) => e[0]), ['ag:join', 'ag:spectate', 'ag:target', 'ag:split', 'ag:eject', 'ag:q', 'ag:leave', 'ag:view']);
  assert.deepStrictEqual(sock.emitted[2][1], { x: 1, y: 2 });
  assert.deepStrictEqual(sock.emitted[7][1], { below: 102 });
});

test('ag:view sends a whole number, 0 or more, and nothing else', () => {
  const sock = fakeSocket(true);
  const net = N.createNet({ socket: sock });
  for (const b of [-1, NaN, Infinity, '5', null, undefined, {}]) assert.strictEqual(net.sendView(b), false);
  assert.strictEqual(sock.emitted.length, 0);
  assert.strictEqual(net.sendView(0), true);
  assert.strictEqual(net.sendView(101.9), true);
  assert.deepStrictEqual(sock.emitted, [['ag:view', { below: 0 }], ['ag:view', { below: 101 }]]);
  assert.strictEqual(N.EVENTS.view, 'ag:view');
});

test('nothing is sent while the socket is down', () => {
  const sock = fakeSocket(false);
  const net = N.createNet({ socket: sock });
  assert.strictEqual(net.sendJoin('owen'), false);
  assert.strictEqual(net.sendTarget(1, 2), false);
  assert.strictEqual(net.sendSplit(), false);
  assert.strictEqual(sock.emitted.length, 0);
  assert.strictEqual(net.connected(), false);
  sock.connected = true;
  assert.strictEqual(net.connected(), true);
  assert.strictEqual(net.sendSplit(), true);
  const noSocket = N.createNet({});
  assert.strictEqual(noSocket.sendSplit(), false);
  assert.doesNotThrow(() => noSocket.close());
});

test('connect and disconnect reach the page hooks; close closes the socket', () => {
  const sock = fakeSocket(false);
  const seen = [];
  const net = N.createNet({ socket: sock, onConnect: () => seen.push('connect'), onDisconnect: (r) => seen.push('disconnect ' + r) });
  sock.fire('connect');
  sock.fire('disconnect', 'transport close');
  assert.deepStrictEqual(seen, ['connect', 'disconnect transport close']);
  net.close();
  assert.strictEqual(sock.closed, true);
});

test('connect(io) leaves the transport to socket.io and wires the frame handler', () => {
  const calls = [];
  const sock = fakeSocket(true);
  const io = function () { calls.push(Array.prototype.slice.call(arguments)); return sock; };
  const got = [];
  N.connect(io, (r) => got.push(r));
  assert.deepStrictEqual(calls, [[{}]]);
  N.connect(io, (r) => got.push(r), { url: 'https://example.invalid' });
  assert.deepStrictEqual(calls[1], ['https://example.invalid', {}]);
  for (const c of calls) {
    const o = c[c.length - 1];
    assert.ok(!('transports' in o), 'no forced transport');
  }
  sock.fire('ag:f', W.encodeBundle([{ t: 'clearAll' }]));
  assert.deepStrictEqual(got.map((r) => r.t), ['clearAll', 'clearAll'], 'both nets listen on the same fake socket');
});

test('loads as a plain browser script onto DuelAgarLib.agNet and finds agWire there at call time', () => {
  const win = {};
  const ctx = vm.createContext({ window: win, TextEncoder, TextDecoder, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/agWire.js'), 'utf8'), ctx, { filename: 'agWire.js' });
  vm.runInContext(fs.readFileSync(NET_FILE, 'utf8'), ctx, { filename: 'agNet.js' });
  const BN = win.DuelAgarLib && win.DuelAgarLib.agNet;
  assert.ok(BN && typeof BN.createNet === 'function' && typeof BN.connect === 'function');
  const got = [];
  const net = BN.createNet({ onMessage: (r) => got.push(r.t) });
  const b = joinBundle();
  net.handleBundle(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  assert.deepStrictEqual(got, ['hello', 'border', 'own', 'world']);
});

test('integrator files: no reference citations or identifiers, no fixture values, no randomness, ag:* only', () => {
  for (const f of [NET_FILE, MAIN_FILE]) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /`[DW]`|\b[DW] \d{3,}|\bf_[a-z]{2}\b|\bMC \d|\bEND \d|agLawsFixture|FIXTURE|agario-reference/, path.basename(f));
    assert.doesNotMatch(src, /Math\.random|Date\.now/, path.basename(f));
    assert.doesNotMatch(src, /['"]cell:[a-z]/, path.basename(f));
  }
});

test('agMain helpers: the cap clock and the cap values', () => {
  const M = require('../public/js/ag/agMain.js');
  assert.strictEqual(M.CAP_START_MS, Math.fround(33.333332));
  assert.strictEqual(M.capFor(25), 40);
  assert.strictEqual(M.capFor(0), -1);
  // whole milliseconds between two clock reads 3 frames of 16.6667 ms apart: 50, drawn under both caps
  const a = M.clockNs(1016.6667), b = M.clockNs(1016.6667 + 16.6667 * 3), c = M.clockNs(1016.6667 + 16.6667 * 2);
  assert.strictEqual(Math.trunc((b - a) / 1e6), 50);
  assert.strictEqual(Math.trunc((c - a) / 1e6), 33);
  assert.ok(33 < M.CAP_START_MS && 50 >= 40);
});
