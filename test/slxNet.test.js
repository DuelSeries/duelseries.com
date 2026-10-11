'use strict';
// slxNet: the layer's tap around the FROZEN socket.io transport (SERVER-DESIGN 15.2; task T16).
//
// The frozen slNet.js runs in a vm with recording fakes for the rest of their client (as test/slNet.test.js does)
// and one scripted fake socket.io `io`. The same script runs twice: the frozen transport alone, and with
// public/js/slx/slxNet.js loaded after it. Every call their client makes (resetGame, onSocketOpen, applyFrame,
// applyClose) and every io call, socket listener and emit must be identical, except the handshake `auth` field and
// the layer's extra sl:x listener. Then the layer's own parts: inert under a harness transport, auth, sl:x, the
// observers, the ping clock, the emit allow list and sl:vis.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WIRE = fs.readFileSync(path.join(ROOT, 'shared/slWire.js'), 'utf8');
const NET = fs.readFileSync(path.join(ROOT, 'public/js/sl/slNet.js'), 'utf8');
const SLXNET = fs.readFileSync(path.join(ROOT, 'public/js/slx/slxNet.js'), 'utf8');

const PV = 15;
const ADD7 = { type: 'snake_add', id: 7, ang: 0, wang: 0, sp: 1, fam: 0, cv: 3, snx: 100, sny: 100, nick: 'n',
  raw: { pts: [{ x: 500, y: 500 }, { bx: 127, by: 127 }] } };
const ADD8 = Object.assign({}, ADD7, { id: 8 });

// A browser-like vm with slWire and the frozen slNet, recording fakes for the rest, and a scripted socket.io.
function page(opts) {
  const o = opts || {};
  const log = [];
  const ctx = { console, Uint8Array, ArrayBuffer, Math, Error, String, Number, Array, Object, JSON, Date };
  ctx.window = ctx;
  let clock = 1000;
  ctx.performance = { now: () => clock };
  const docListeners = {};
  ctx.document = {
    hidden: false,
    visibilityState: 'visible',
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
  };
  vm.createContext(ctx);
  vm.runInContext(WIRE, ctx, { filename: 'slWire.js' });
  vm.runInContext(NET, ctx, { filename: 'slNet.js' });
  const D = ctx.DuelSlither;
  const S = { want_play: true, connecting: false, my_nick: '', playing: false, slither: null };
  D.S = S;
  D.stats = { messages: 0, events: 0, wireBytes: 0, wireErrors: 0, applyThrows: 0 };
  D.slMain = { nick: 'Owen' };
  D.slLoop = { now: () => clock, onSocketOpen: () => log.push(['onSocketOpen', S.my_nick]) };
  D.slApply = {
    // their resetGame closes the old socket first (public/js/sl/slApply.js:1267-1269)
    resetGame: () => { log.push(['resetGame']); if (D.slNet.hasSocket()) D.slNet.closeSocket(); },
    applyFrame: (events, n) => {
      log.push(['applyFrame', events.map((e) => e.type).join(','), n]);
      for (const e of events) {
        if (e.type === 'snake_add' && !S.slither) { S.slither = { id: e.id }; S.playing = true; }
      }
    },
    applyClose: () => log.push(['applyClose', S.playing]),
    gdnm: () => true,
  };
  // The fake socket.io client: handlers per event, emits recorded; disconnect() fires 'disconnect' at once while
  // connected, as socket.io-client's Socket.disconnect does (onclose 'io client disconnect').
  const socks = [];
  const io = function (ns, opts2) {
    const s = { n: socks.length + 1, ns, opts: opts2, connected: false, on: {}, order: [], emitted: [], disconnects: 0 };
    s.on = function (ev, f) { (s.handlers[ev] = s.handlers[ev] || []).push(f); s.order.push(ev); };
    s.handlers = {};
    s.emit = function (ev, d) { s.emitted.push([ev, d instanceof ctx.Uint8Array ? Array.from(d) : JSON.parse(JSON.stringify(d === undefined ? null : d))]); };
    s.disconnect = function () {
      s.disconnects++;
      if (!s.connected) return;
      s.connected = false;
      fireSock(s, 'disconnect', 'io client disconnect');
    };
    socks.push(s);
    log.push(['io', ns]);
    return s;
  };
  io.Manager = function Manager() {};
  io.protocol = 5;
  ctx.io = io;
  ctx.DuelSlitherConfig = o.config || {};
  function fireSock(s, ev, data) {
    for (const f of (s.handlers[ev] || []).slice()) f(data);
  }
  function bundle(events) {
    return D.slWire.encodeBundle(events, PV);
  }
  if (o.layer) vm.runInContext(SLXNET, ctx, { filename: 'slxNet.js' });
  return { ctx, D, S, log, socks, io, fireSock, bundle, docListeners, setClock: (v) => { clock = v; }, doc: ctx.document };
}

// The scripted run: connect and frames, a server close, a connect_error, a client close while open, a close before
// open, and events of replaced sockets.
function script(p) {
  const { D, socks, fireSock, bundle } = p;
  const openSock = () => { const s = socks[socks.length - 1]; s.connected = true; fireSock(s, 'connect'); return s; };
  // 1. a life: open, inputs, frames (own add, a pong, a broken tail), then the server closes it
  D.slNet.connect();
  const a = openSock();
  D.slNet.send({ type: 'ping' });
  D.slNet.send({ type: 'angle', q: 100 });
  fireSock(a, 'sl:f', bundle([ADD7, ADD8]));
  fireSock(a, 'sl:f', bundle([{ type: 'pong' }, { type: 'kill_count', id: 7, count: 1 }]));
  fireSock(a, 'sl:f', new p.ctx.Uint8Array([1, 0xfe]));
  fireSock(a, 'sl:f', bundle([{ type: 'dead', code: 0 }]));
  a.connected = false;
  fireSock(a, 'disconnect', 'transport close');
  fireSock(a, 'disconnect', 'transport close');                 // reported once
  // 2. a connect that fails before it opens
  D.slNet.connect();
  const b = socks[socks.length - 1];
  fireSock(b, 'connect_error', new Error('xhr poll error'));
  // 3. open, then their own close (closeSocket: sl:leave, then disconnect); late events of it are ignored
  D.slNet.connect();
  const c = openSock();
  D.slNet.send({ type: 'boost', on: true });
  D.slNet.closeSocket();
  fireSock(c, 'sl:f', bundle([{ type: 'pong' }]));
  fireSock(c, 'disconnect', 'late');
  D.slNet.send({ type: 'ping' });                               // no socket: nothing sent
  // 4. a close before the open, then the open of that replaced socket is ignored
  D.slNet.connect();
  const d = socks[socks.length - 1];
  D.slNet.closeSocket();
  d.connected = true;
  fireSock(d, 'connect');
  // 5. a second connect replaces a live one; the old socket's frames and close are ignored
  D.slNet.connect();
  const e = openSock();
  D.slNet.connect();
  const f = openSock();
  fireSock(e, 'sl:f', bundle([{ type: 'pong' }]));
  fireSock(e, 'disconnect', 'old');
  fireSock(f, 'sl:f', bundle([{ type: 'pong' }]));
  D.slNet.send({ type: 'turn', dir: 'left', v: 3 });
}

function record(p, stripLayer) {
  return JSON.stringify({
    log: p.log,
    stats: p.D.stats,
    socks: p.socks.map((s) => {
      const opts = Object.assign({}, s.opts);
      if (stripLayer) delete opts.auth;
      return { ns: s.ns, opts, on: stripLayer ? s.order.filter((ev) => ev !== 'sl:x') : s.order, emitted: s.emitted,
        disconnects: s.disconnects };
    }),
  });
}

test('the frozen transport alone and the tapped one give identical handler calls and emits (except auth and sl:x)', () => {
  const frozen = page();
  script(frozen);
  const tapped = page({ layer: true });
  assert.strictEqual(tapped.D.slx.active, true);
  script(tapped);
  const a = record(frozen, false);
  const b = record(tapped, true);
  assert.strictEqual(b, a);
  assert.strictEqual(frozen.socks.length, 6);
  assert.strictEqual(frozen.log.filter((x) => x[0] === 'applyClose').length, 2, 'a server close and a failed connect');
  assert.strictEqual(frozen.D.stats.wireErrors, 1);
  // the only differences: each /sl socket got the layer's sl:x listener and an auth object
  for (const s of tapped.socks) {
    assert.deepStrictEqual(s.order.filter((ev) => ev === 'sl:x'), ['sl:x']);
    assert.strictEqual(JSON.stringify(s.opts.auth), '{}');
    assert.strictEqual(s.opts.forceNew, true);
    assert.strictEqual(s.opts.reconnection, false);
  }
  for (const s of frozen.socks) assert.strictEqual(s.opts.auth, undefined);
});

test('inert under a harness transport: nothing installed, wrapped or listened to', () => {
  const own = function () {};
  const p = page({ layer: true, config: { transport: own } });
  assert.strictEqual(p.D.slx.active, false);
  assert.deepStrictEqual(Object.keys(p.D.slx), ['active']);
  assert.strictEqual(p.ctx.DuelSlitherConfig.transport, own);
  assert.strictEqual(p.ctx.io, p.io, 'io not wrapped');
  assert.deepStrictEqual(Object.keys(p.docListeners), []);
});

test('loaded twice: the second copy changes nothing', () => {
  const p = page({ layer: true });
  const slx = p.D.slx;
  const t = p.ctx.DuelSlitherConfig.transport;
  const io = p.ctx.io;
  vm.runInContext(SLXNET, p.ctx, { filename: 'slxNet.js' });
  assert.strictEqual(p.D.slx, slx);
  assert.strictEqual(p.ctx.DuelSlitherConfig.transport, t);
  assert.strictEqual(p.ctx.io, io);
  assert.strictEqual(p.docListeners.visibilitychange.length, 1);
});

test('io wrapper: /sl only, every argument through, the layer auth added, io properties kept', () => {
  const p = page({ layer: true });
  assert.notStrictEqual(p.ctx.io, p.io);
  assert.strictEqual(p.ctx.io.Manager, p.io.Manager);
  assert.strictEqual(p.ctx.io.protocol, 5);
  const other = p.ctx.io('/', { path: '/x' });
  assert.deepStrictEqual([other.ns, JSON.stringify(other.opts)], ['/', '{"path":"/x"}']);
  assert.deepStrictEqual(other.order, [], 'no layer listener on another namespace');
  p.D.slx.auth = () => ({ cv: 12 });
  const s = p.ctx.io('/sl', { forceNew: true, reconnection: false, auth: { keep: 1 } });
  assert.strictEqual(JSON.stringify(s.opts), '{"forceNew":true,"reconnection":false,"auth":{"keep":1,"cv":12}}');
  p.D.slx.auth = () => { throw new Error('boom'); };
  const t = p.ctx.io('/sl', { forceNew: true });
  assert.strictEqual(JSON.stringify(t.opts.auth), '{}', 'a throwing auth hook adds nothing');
  assert.strictEqual(p.D.slx.errors, 1);
});

test('observers: open after their join, own add, own kills, own dead, pong with the ping round trip, close before theirs', () => {
  const p = page({ layer: true });
  const { D, socks, fireSock, bundle, log } = p;
  const seen = [];
  const slx = D.slx;
  slx.on('open', () => seen.push(['open', socks[0].emitted.map((e) => e[0]).join(',')]));
  slx.on('ownAdd', (ev) => seen.push(['ownAdd', ev.id]));
  slx.on('ownKills', (ev) => seen.push(['ownKills', ev.count]));
  slx.on('ownDead', (ev) => seen.push(['ownDead', ev.code]));
  slx.on('pong', (rtt) => seen.push(['pong', rtt]));
  slx.on('send', (list) => seen.push(['send', list.map((e) => e.type).join(',')]));
  slx.on('frame', (events, n) => seen.push(['frame', events.length, n > 0]));
  slx.on('close', (info) => seen.push(['close', JSON.stringify(info), log[log.length - 1][0]]));
  D.slNet.connect();
  const s = socks[0];
  s.connected = true;
  fireSock(s, 'connect');
  p.setClock(1100);
  D.slNet.send({ type: 'ping' });
  p.setClock(1180);
  fireSock(s, 'sl:f', bundle([ADD7, ADD8, { type: 'kill_count', id: 8, count: 4 }]));
  fireSock(s, 'sl:f', bundle([{ type: 'pong' }, { type: 'kill_count', id: 7, count: 2 }]));
  fireSock(s, 'sl:f', bundle([{ type: 'pong' }]));
  fireSock(s, 'sl:f', bundle([{ type: 'dead', code: 0 }]));
  s.connected = false;
  fireSock(s, 'disconnect', 'transport close');
  assert.deepStrictEqual(seen, [
    ['open', 'sl:join'],
    ['send', 'ping'],
    ['ownAdd', 7],
    ['frame', 3, true],
    ['pong', 80],
    ['ownKills', 2],
    ['frame', 2, true],
    ['pong', -1],
    ['frame', 1, true],
    ['ownDead', 0],
    ['frame', 1, true],
    ['close', '{"playing":true,"opened":true,"sawDead":true,"refused":null}', 'applyFrame'],
  ]);
  assert.strictEqual(slx.rtt, 80);
  assert.strictEqual(log[log.length - 1][0], 'applyClose', 'their close ran after the observers');
});

test('a throwing observer is counted and never reaches their client', () => {
  const p = page({ layer: true });
  const { D, socks, fireSock, bundle, log } = p;
  let after = 0;
  D.slx.on('frame', () => { throw new Error('layer bug'); });
  D.slx.on('frame', () => { after++; });
  D.slNet.connect();
  socks[0].connected = true;
  fireSock(socks[0], 'connect');
  fireSock(socks[0], 'sl:f', bundle([{ type: 'pong' }]));
  assert.strictEqual(after, 1);
  assert.strictEqual(D.slx.errors, 1);
  assert.strictEqual(D.stats.applyThrows, 0);
  assert.deepStrictEqual(log.filter((x) => x[0] === 'applyFrame'), [['applyFrame', 'pong', 2]]);
});

test('sl:x: each item to x and x:<t>, a refusal reaches the close info, junk and replaced sockets ignored', () => {
  const p = page({ layer: true });
  const { D, socks, fireSock } = p;
  const seen = [];
  D.slx.on('x', (m) => seen.push(['x', m.t]));
  D.slx.on('x:refused', (m) => seen.push(['refused', m.why]));
  D.slx.on('close', (info) => seen.push(['close', info.playing, info.opened, info.refused]));
  D.slNet.connect();
  const old = socks[0];
  D.slNet.connect();
  const s = socks[1];
  s.connected = true;
  fireSock(s, 'connect');
  fireSock(old, 'sl:x', [{ t: 'top', name: 'a', amount: 1 }]);
  fireSock(s, 'sl:x', { t: 'refused' });
  fireSock(s, 'sl:x', [null, 5, { t: 7 }, { t: 'refused', why: 'full' }]);
  s.connected = false;
  fireSock(s, 'disconnect', 'io server disconnect');
  assert.deepStrictEqual(seen, [['x', 'refused'], ['refused', 'full'], ['close', false, true, 'full']]);
  assert.deepStrictEqual(p.log.filter((x) => x[0] === 'applyClose'), [['applyClose', false]]);
});

test('layer emits: only sl:hold, sl:vis, sl:chat, sl:diag, only on the live current socket', () => {
  const p = page({ layer: true });
  const { D, socks, fireSock } = p;
  const slx = D.slx;
  assert.strictEqual(slx.send('sl:hold', { on: 1 }), false, 'no socket yet');
  D.slNet.connect();
  const s = socks[0];
  assert.strictEqual(slx.connected(), false);
  assert.strictEqual(slx.send('sl:hold', { on: 1 }), false, 'not connected yet');
  s.connected = true;
  fireSock(s, 'connect');
  assert.strictEqual(slx.connected(), true);
  for (const name of ['sl:hold', 'sl:vis', 'sl:chat', 'sl:diag']) assert.strictEqual(slx.send(name, { a: 1 }), true, name);
  for (const name of ['sl:join', 'sl:i', 'sl:leave', 'sl:f', 'duel:restake', 'duel:signaction', 'toString', '__proto__']) {
    assert.strictEqual(slx.send(name, { a: 1 }), false, name);
  }
  D.slNet.closeSocket();
  assert.strictEqual(slx.connected(), false);
  assert.strictEqual(slx.send('sl:hold', { on: 0 }), false, 'their close detached it');
  assert.deepStrictEqual(s.emitted.map((e) => e[0]), ['sl:join', 'sl:hold', 'sl:vis', 'sl:chat', 'sl:diag', 'sl:leave']);
});

test('sl:vis: on visibility changes only, once per change; a hidden tab says so right after its join', () => {
  const p = page({ layer: true });
  const { D, socks, fireSock, doc, docListeners } = p;
  const vis = () => docListeners.visibilitychange[0]();
  D.slNet.connect();
  const s = socks[0];
  s.connected = true;
  fireSock(s, 'connect');
  vis();
  doc.hidden = true;
  vis();
  vis();
  doc.hidden = false;
  vis();
  doc.hidden = true;
  D.slNet.connect();
  const t = socks[1];
  t.connected = true;
  fireSock(t, 'connect');
  assert.deepStrictEqual(s.emitted.map((e) => e[0] + (e[1] && e[1].hidden !== undefined ? e[1].hidden : '')),
    ['sl:join', 'sl:vis1', 'sl:vis0', 'sl:leave']);
  assert.deepStrictEqual(t.emitted.map((e) => e[0] + (e[1] && e[1].hidden !== undefined ? e[1].hidden : '')),
    ['sl:join', 'sl:vis1']);
});

test('onSocket: a layer socket event on each /sl socket made after the call, replaced sockets ignored', () => {
  const p = page({ layer: true });
  const { D, socks, fireSock } = p;
  const seen = [];
  D.slx.onSocket('announce', (m) => seen.push(m.text));
  D.slNet.connect();
  D.slNet.connect();
  fireSock(socks[0], 'announce', { text: 'old' });
  fireSock(socks[1], 'announce', { text: 'hi' });
  assert.deepStrictEqual(seen, ['hi']);
  assert.deepStrictEqual(socks[1].order.filter((ev) => ev === 'announce' || ev === 'sl:x'), ['sl:x', 'announce']);
});
