'use strict';
// slxNet: the layer's tap around the FROZEN socket.io transport (SERVER-DESIGN 15.2; task T16).
//
// The frozen slNet.js runs in a vm with recording fakes for the rest of their client (as test/slNet.test.js does)
// and one scripted fake socket.io `io`. The same script runs twice: the frozen transport alone, and with
// public/js/slx/slxNet.js loaded after it. Every call their client makes (resetGame, onSocketOpen, applyFrame,
// applyClose) and every io call, socket listener and emit must be identical, except the handshake `auth` field and
// the layer's extra sl:x and disconnect listeners. Then the layer's own parts: inert under a harness transport, auth,
// sl:x, the observers, the ping clock, the emit allow list, sl:vis, and the resume after a blip (task T16b).
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
  // page timers on the same clock (the resume's attempt and gap timers); run by setClock
  const timers = [];
  let tid = 0;
  ctx.setTimeout = (fn, ms) => { const t = { id: ++tid, at: clock + (+ms || 0), fn }; timers.push(t); return t.id; };
  ctx.clearTimeout = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  function setClock(v) {
    for (;;) {
      let best = null;
      for (const t of timers) if (t.at <= v && (!best || t.at < best.at || (t.at === best.at && t.id < best.id))) best = t;
      if (!best) break;
      timers.splice(timers.indexOf(best), 1);
      if (best.at > clock) clock = best.at;
      best.fn();
    }
    clock = v;
  }
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
  return { ctx, D, S, log, socks, io, fireSock, bundle, docListeners, setClock, now: () => clock, timers, doc: ctx.document };
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
      // the layer's own listeners come first on every /sl socket (slxNet sockSubs): sl:x and disconnect
      const on = stripLayer && s.order[0] === 'sl:x' && s.order[1] === 'disconnect' ? s.order.slice(2) : s.order;
      return { ns: s.ns, opts, on, emitted: s.emitted,
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
  // the only differences: each /sl socket got the layer's sl:x and disconnect listeners (first) and an auth object
  for (const s of tapped.socks) {
    assert.deepStrictEqual(s.order.filter((ev) => ev === 'sl:x'), ['sl:x']);
    assert.deepStrictEqual(s.order.slice(0, 2), ['sl:x', 'disconnect']);
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

// slxWatch's Next: the page ends its own life; their transport sees its socket's disconnect, so their close runs once
// (applyClose) exactly as for a drop, and nothing is resumed (this page's own disconnect, even with a key held).
test('endLife: sl:leave then the socket closes; their close runs once, the close info says no refusal, no resume', () => {
  const p = page({ layer: true });
  const { D, S, socks, fireSock, log, bundle } = p;
  const slx = D.slx;
  const closes = [];
  slx.on('close', (i) => closes.push(i));
  assert.strictEqual(slx.endLife(), false, 'no socket yet');
  D.slNet.connect();
  const s = socks[0];
  assert.strictEqual(slx.endLife(), false, 'not connected yet');
  s.connected = true;
  fireSock(s, 'connect');
  fireSock(s, 'sl:x', [{ t: 'seat', k: '0f8fad5b-d9cb-469f-a165-70867728950e', ms: 5000 }]);
  fireSock(s, 'sl:f', bundle([ADD7]));
  assert.strictEqual(S.playing, true);
  const n = socks.length;
  assert.strictEqual(slx.endLife(), true);
  assert.deepStrictEqual(s.emitted.map((e) => e[0]), ['sl:join', 'sl:leave']);
  assert.strictEqual(s.connected, false);
  assert.deepStrictEqual(log.filter((e) => e[0] === 'applyClose'), [['applyClose', true]], 'their close, once, mid-life');
  assert.strictEqual(closes.length, 1);
  assert.strictEqual(closes[0].refused, null);
  assert.strictEqual(closes[0].sawDead, false);
  assert.strictEqual(slx.resuming(), false);
  assert.strictEqual(socks.length, n, 'no resume socket was made');
  assert.strictEqual(slx.endLife(), false, 'nothing left to end');
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

// ---- resume after a blip (task T16b)
const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100';
const KEY2 = '1f0e0d0c-0b0a-4908-9706-050403020101';
const KEY3 = '2f0e0d0c-0b0a-4908-a706-050403020102';

// A life with its key: open, the join bundle's sl:x seat, the own add.
function keyedLife(p, ms) {
  const { D, socks, fireSock, bundle } = p;
  D.slNet.connect();
  const a = socks[socks.length - 1];
  a.connected = true;
  fireSock(a, 'connect');
  fireSock(a, 'sl:x', [{ t: 'seat', k: KEY, ms: ms === undefined ? 8000 : ms }]);
  fireSock(a, 'sl:f', bundle([ADD7]));
  return a;
}
const closes = (p) => p.log.filter((x) => x[0] === 'applyClose').length;
const names = (s) => s.emitted.map((e) => e[0]);

test('resume: a transport drop holds their close; a new socket sends sl:back {k, n, p} first; back goes on with the same life', () => {
  const p = page({ layer: true });
  const { D, socks, fireSock, bundle, log } = p;
  const seen = [];
  for (const ev of ['open', 'resuming', 'resumed', 'close', 'x']) D.slx.on(ev, (m) => seen.push(ev + (ev === 'x' ? ':' + m.t : '')));
  const a = keyedLife(p);
  D.slNet.send({ type: 'ping' });
  fireSock(a, 'sl:f', bundle([{ type: 'pong' }]));
  D.slNet.send({ type: 'ping' });                               // in flight when the link goes
  a.connected = false;
  fireSock(a, 'disconnect', 'transport close');
  assert.strictEqual(closes(p), 0, 'their close waits');
  assert.strictEqual(D.slx.resuming(), true);
  assert.strictEqual(D.slx.connected(), false);
  assert.strictEqual(D.slx.send('sl:chat', { text: 'x' }), false, 'no layer emit while away');
  assert.strictEqual(socks.length, 2, 'one attempt at once');
  const b = socks[1];
  assert.strictEqual(b.ns, '/sl');
  assert.strictEqual(JSON.stringify(b.opts), '{"forceNew":true,"reconnection":false,"auth":{}}', 'their options, the layer auth');
  // their client keeps sending while away: nothing leaves, the newest angle and boost are kept
  D.slNet.send({ type: 'angle', q: 9 });
  D.slNet.send({ type: 'boost', on: true });
  D.slNet.send({ type: 'turn', dir: 'left', v: 3 });
  D.slNet.send({ type: 'angle', q: 12 });
  assert.deepStrictEqual(names(a), ['sl:join', 'sl:i', 'sl:i'], 'nothing on the dead socket');
  b.connected = true;
  fireSock(b, 'connect');
  assert.deepStrictEqual(b.emitted, [['sl:back', { k: KEY, n: 2, p: 2 }]], 'sl:back first: 2 bundles got, 2 pings sent');
  p.doc.hidden = true;
  fireSock(b, 'sl:x', [{ t: 'back', k: KEY2, ms: 8000 }, { t: 'top', name: 'z', amount: 1 }]);
  assert.strictEqual(D.slx.resuming(), false);
  assert.strictEqual(D.slx.connected(), true);
  assert.deepStrictEqual(names(b), ['sl:back', 'sl:i', 'sl:vis']);
  assert.deepStrictEqual(b.emitted[1][1], Array.from(D.slWire.encodeInput([{ type: 'angle', q: 12 }, { type: 'boost', on: true }])),
    'the newest angle and boost, once');
  assert.deepStrictEqual(b.emitted[2][1], { hidden: 1 }, 'the new socket is told the tab is hidden');
  fireSock(b, 'sl:f', bundle([{ type: 'pong' }, { type: 'kill_count', id: 7, count: 3 }]));
  assert.deepStrictEqual(log[log.length - 1].slice(0, 2), ['applyFrame', 'pong,kill_count']);
  D.slNet.send({ type: 'angle', q: 20 });
  assert.deepStrictEqual(names(b).slice(-1), ['sl:i']);
  assert.strictEqual(closes(p), 0);
  assert.deepStrictEqual(seen, ['open', 'resuming', 'resumed', 'x:top'], 'no second open; the keys never reach observers');
  // a second blip on the resumed socket: the newest key, every bundle of the life counted
  b.connected = false;
  fireSock(b, 'disconnect', 'ping timeout');
  const c = socks[2];
  c.connected = true;
  fireSock(c, 'connect');
  assert.deepStrictEqual(c.emitted[0], ['sl:back', { k: KEY2, n: 3, p: 2 }]);
  fireSock(c, 'sl:x', [{ t: 'back', k: KEY3, ms: 8000 }]);
  // their own close later: sl:leave on the resumed socket, then it closes
  D.slNet.closeSocket();
  assert.deepStrictEqual(names(c).slice(-1), ['sl:leave']);
  assert.strictEqual(c.connected, false);
  assert.strictEqual(closes(p), 0, 'their own close is not a close event');
});

test('resume attempts: a failed one is retried 500 ms later, an unanswered one dropped at 3 s; the window ends in their close, once', () => {
  const p = page({ layer: true });
  const { D, socks, fireSock } = p;
  let info = null;
  D.slx.on('close', (i) => { info = i; });
  const a = keyedLife(p, 8000);
  const t0 = p.now();
  a.connected = false;
  fireSock(a, 'disconnect', 'transport error');
  fireSock(socks[1], 'connect_error', new Error('xhr poll error'));      // the network is still down
  p.setClock(t0 + 499);
  assert.strictEqual(socks.length, 2);
  p.setClock(t0 + 500);
  assert.strictEqual(socks.length, 3, 'the next attempt 500 ms later');
  const s3 = socks[2];
  s3.connected = true;
  fireSock(s3, 'connect');                                                // connects, never answers
  p.setClock(t0 + 3499);
  assert.strictEqual(s3.disconnects, 0);
  p.setClock(t0 + 3500);
  assert.strictEqual(s3.disconnects, 1, 'dropped 3 s after it started');
  assert.strictEqual(socks.length, 3);
  p.setClock(t0 + 4000);
  assert.strictEqual(socks.length, 4);
  p.setClock(t0 + 7999);
  assert.strictEqual(closes(p), 0);
  p.setClock(t0 + 8000);
  assert.strictEqual(closes(p), 1, 'the window (ms) is over: their close');
  assert.strictEqual(JSON.stringify(info), '{"playing":true,"opened":true,"sawDead":false,"refused":null}');
  p.setClock(t0 + 20000);
  assert.strictEqual(closes(p), 1);
  assert.strictEqual(socks.length, 5, 'no attempt after the close');
});

test('resume refused: the server says gone (or flood); their close runs at once with the refusal in the info', () => {
  for (const why of ['gone', 'flood']) {
    const p = page({ layer: true });
    const { D, socks, fireSock } = p;
    let info = null;
    D.slx.on('close', (i) => { info = i; });
    const a = keyedLife(p);
    a.connected = false;
    fireSock(a, 'disconnect', 'transport close');
    const b = socks[1];
    b.connected = true;
    fireSock(b, 'connect');
    fireSock(b, 'sl:x', [{ t: 'refused', why }]);
    b.connected = false;
    fireSock(b, 'disconnect', 'io server disconnect');
    assert.strictEqual(closes(p), 1);
    assert.strictEqual(info.refused, why);
    assert.strictEqual(info.playing, true);
    p.setClock(p.now() + 10000);
    assert.strictEqual(socks.length, 2, 'no more attempts');
  }
});

test('no resume: the server ended it, the own death was seen, a refusal came, no key, a bad key or window; their close at once', () => {
  const cases = {
    'server disconnect': (p, a) => {
      a.connected = false;
      p.fireSock(a, 'disconnect', 'io server disconnect');
    },
    'own death seen': (p, a) => {
      p.fireSock(a, 'sl:f', p.bundle([{ type: 'dead', code: 0 }]));
      a.connected = false;
      p.fireSock(a, 'disconnect', 'transport close');
    },
    'refused taken': (p, a) => {
      p.fireSock(a, 'sl:x', [{ t: 'refused', why: 'taken' }]);
      a.connected = false;
      p.fireSock(a, 'disconnect', 'transport close');
    },
  };
  for (const name of Object.keys(cases)) {
    const p = page({ layer: true });
    const a = keyedLife(p);
    cases[name](p, a);
    assert.strictEqual(closes(p), 1, name);
    assert.strictEqual(p.socks.length, 1, name + ': no attempt');
  }
  const seats = [null, { t: 'seat', k: KEY.toUpperCase(), ms: 8000 }, { t: 'seat', k: KEY, ms: 0 }, { t: 'seat', k: KEY, ms: 'x' },
    { t: 'seat', k: { toString: () => KEY }, ms: 8000 }];
  for (let i = 0; i < seats.length; i++) {
    const p = page({ layer: true });
    const { D, socks, fireSock, bundle } = p;
    D.slNet.connect();
    const a = socks[0];
    a.connected = true;
    fireSock(a, 'connect');
    if (seats[i]) fireSock(a, 'sl:x', [seats[i]]);
    fireSock(a, 'sl:f', bundle([ADD7]));
    a.connected = false;
    fireSock(a, 'disconnect', 'transport close');
    assert.strictEqual(closes(p), 1, 'seat message ' + i);
    assert.strictEqual(socks.length, 1);
  }
});

test('their own close during a resume stops it: the attempt socket is let go, nothing else is tried, no close event', () => {
  const p = page({ layer: true });
  const { D, socks, fireSock } = p;
  const a = keyedLife(p);
  a.connected = false;
  fireSock(a, 'disconnect', 'transport close');
  const b = socks[1];
  D.slNet.closeSocket();
  assert.strictEqual(b.disconnects, 1);
  b.connected = true;
  fireSock(b, 'connect');
  assert.deepStrictEqual(b.emitted, [], 'a late connect of the let-go attempt sends nothing');
  p.setClock(p.now() + 20000);
  assert.strictEqual(socks.length, 2);
  assert.strictEqual(closes(p), 0);
  // a new life after it starts clean (no key from the old one)
  D.slNet.connect();
  const c = socks[2];
  c.connected = true;
  fireSock(c, 'connect');
  c.connected = false;
  fireSock(c, 'disconnect', 'transport close');
  assert.strictEqual(closes(p), 1, 'no key in this life: no resume');
});
