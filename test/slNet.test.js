// slNet: the game connection (build brief 7.7, 10.4 rows 14 to 17, 11 card "slNet").
// Runs slNet.js with a fake transport and fake collaborators on the DuelSlither namespace.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/js/sl/slNet.js'), 'utf8');
const WIRE = fs.readFileSync(path.join(ROOT, 'shared/slWire.js'), 'utf8');

// A fresh browser-like context with slWire and slNet loaded, plus recording fakes for the rest.
function setup(opts) {
  opts = opts || {};
  const log = [];
  const transports = [];
  const ctx = { console, Uint8Array, ArrayBuffer, Math, Error, String, Number, Array, Object, JSON };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(WIRE, ctx, { filename: 'slWire.js' });
  vm.runInContext(SRC, ctx, { filename: 'slNet.js' });
  const D = ctx.DuelSlither;
  const S = { want_play: true, connecting: false, my_nick: '' };
  D.S = S;
  D.stats = { messages: 0, events: 0, wireBytes: 0, wireErrors: 0, applyThrows: 0 };
  D.slMain = { nick: opts.nick == null ? 'Owen' : opts.nick };
  let clock = 1000;
  D.slLoop = {
    now: () => clock,
    onSocketOpen: () => log.push(['onSocketOpen', S.my_nick])
  };
  D.slApply = {
    resetGame: () => log.push(['resetGame', S.want_play, S.connecting]),
    applyFrame: (events, n) => {
      log.push(['applyFrame', events.length, n]);
      if (events[0] && events[0].boom) throw new TypeError('boom');
    },
    applyClose: () => log.push(['applyClose']),
    gdnm: (s) => !/x1234567/.test(s)
  };
  ctx.DuelSlitherConfig = {
    transport: function (handlers) {
      const t = { handlers, sent: [], joined: [], opened: 0, closed: 0 };
      t.open = () => { t.opened++; log.push(['open', S.want_play, S.connecting, S.start_connect_mtm]); };
      t.send = (b) => t.sent.push(Array.from(b));
      t.close = () => { t.closed++; log.push(['close']); };
      t.join = (nick) => t.joined.push(nick);
      transports.push(t);
      return t;
    }
  };
  return { ctx, D, S, log, transports, setClock: (v) => { clock = v; } };
}

test('exports are exactly the brief 11 card list', () => {
  const { D } = setup();
  assert.deepStrictEqual(Object.keys(D.slNet).sort(), ['closeSocket', 'connect', 'hasSocket', 'makeSocketIoTransport', 'send']);
});

test('connect: resetGame first, then want_play off, connecting on, connect time, then the transport opens (game.js:7180-7216)', () => {
  const { D, S, log, transports } = setup();
  D.slNet.connect();
  assert.deepStrictEqual(log, [['resetGame', true, false], ['open', false, true, 1000]]);
  assert.strictEqual(transports.length, 1);
  assert.strictEqual(S.start_connect_mtm, 1000);
  assert.strictEqual(D.slNet.hasSocket(), true);
});

test('open: my_nick from the Play name (asciize, cut to 24, gameweek2016 blanked), then slLoop.onSocketOpen', () => {
  const cases = [['Owen', 'Owen'], ['GameWeek2016', ''], ['abcdefghijklmnopqrstuvwxyz1234', 'abcdefghijklmnopqrstuvwx'], ['aéb', 'a b'], ['a\u0001b', 'a b'], ['', '']];
  for (const [nick, want] of cases) {
    const { D, S, log, transports } = setup({ nick });
    D.slNet.connect();
    transports[0].handlers.onOpen();
    assert.strictEqual(S.my_nick, want, nick);
    assert.deepStrictEqual(log[log.length - 1], ['onSocketOpen', want]);
    assert.deepStrictEqual(transports[0].joined, [want]);
  }
});

test('open: the join name is blanked when gdnm fails (game.js:8962), my_nick keeps it', () => {
  const { D, S, transports } = setup({ nick: 'x1234567' });
  D.slNet.connect();
  transports[0].handlers.onOpen();
  assert.strictEqual(S.my_nick, 'x1234567');
  assert.deepStrictEqual(transports[0].joined, ['']);
});

test('frames: counted, applied in order; a throw is counted and the next message still applies', () => {
  const { D, log, transports } = setup();
  D.slNet.connect();
  const h = transports[0].handlers;
  h.onFrame([{ type: 'pong' }], 3);
  h.onFrame([{ type: 'x', boom: true }, { type: 'pong' }], 5);
  h.onFrame([{ type: 'pong' }, { type: 'wire_error', reason: 'short', offset: 2 }], 7);
  assert.deepStrictEqual(log.filter((x) => x[0] === 'applyFrame'), [['applyFrame', 1, 3], ['applyFrame', 2, 5], ['applyFrame', 2, 7]]);
  assert.strictEqual(D.stats.messages, 3);
  assert.strictEqual(D.stats.events, 5);
  assert.strictEqual(D.stats.wireBytes, 15);
  assert.strictEqual(D.stats.applyThrows, 1);
  assert.strictEqual(D.stats.wireErrors, 1);
});

test('closeSocket detaches first: later events of that transport are ignored (game.js:7118-7121, 8938)', () => {
  const { D, log, transports } = setup();
  D.slNet.connect();
  const h = transports[0].handlers;
  D.slNet.closeSocket();
  assert.strictEqual(transports[0].closed, 1);
  assert.strictEqual(D.slNet.hasSocket(), false);
  h.onClose();
  h.onFrame([{ type: 'pong' }], 1);
  h.onOpen();
  assert.deepStrictEqual(log.filter((x) => x[0] !== 'resetGame' && x[0] !== 'open'), [['close']]);
  D.slNet.closeSocket();
  assert.strictEqual(transports[0].closed, 1);
});

test('a server close of the current transport applies the close and keeps the transport (their ws stays until resetGame)', () => {
  const { D, log, transports } = setup();
  D.slNet.connect();
  transports[0].handlers.onClose();
  assert.deepStrictEqual(log[log.length - 1], ['applyClose']);
  assert.strictEqual(D.slNet.hasSocket(), true);
});

test('a second connect replaces the transport; the old one is ignored', () => {
  const { D, log, transports } = setup();
  D.slNet.connect();
  D.slNet.connect();
  assert.strictEqual(transports.length, 2);
  transports[0].handlers.onFrame([{ type: 'pong' }], 1);
  transports[0].handlers.onClose();
  assert.strictEqual(log.filter((x) => x[0] === 'applyFrame' || x[0] === 'applyClose').length, 0);
  transports[1].handlers.onFrame([{ type: 'pong' }], 1);
  assert.strictEqual(log.filter((x) => x[0] === 'applyFrame').length, 1);
});

test('send: one input bundle per event (encodeInput, brief 7.6); nothing without a transport', () => {
  const { D, transports } = setup();
  D.slNet.send({ type: 'ping' });
  D.slNet.connect();
  D.slNet.send({ type: 'turn', dir: 'right', v: 5 });
  D.slNet.send({ type: 'ping' });
  D.slNet.send({ type: 'boost', on: true });
  D.slNet.send({ type: 'angle', q: 188 });
  assert.deepStrictEqual(transports[0].sent, [[1, 2, 133], [1, 4], [1, 3, 1], [1, 1, 188]]);
});

test('socket.io transport: namespace /sl, sl:join, sl:i, sl:f decoded, sl:leave then disconnect', () => {
  const { ctx, D, log } = setup();
  const emitted = [];
  const on = {};
  let disconnected = 0;
  let sockObj = null;
  ctx.io = (ns, o) => {
    emitted.push(['io', ns, o.forceNew]);
    sockObj = { connected: false, on: (ev, f) => { on[ev] = f; }, emit: (ev, d) => emitted.push([ev, d]),
      disconnect: () => { disconnected++; sockObj.connected = false; } };
    return sockObj;
  };
  ctx.DuelSlitherConfig = {};
  D.slNet.connect();
  sockObj.connected = true;                                          // what socket.io sets before 'connect'
  on.connect();
  D.slNet.send({ type: 'ping' });
  const bundle = D.slWire.encodeBundle([{ type: 'pong' }], 15);
  on['sl:f'](bundle);
  D.slNet.closeSocket();
  on.disconnect();
  assert.deepStrictEqual(emitted.map((e) => e[0]), ['io', 'sl:join', 'sl:i', 'sl:leave']);
  assert.strictEqual(emitted[0][1], '/sl');
  assert.strictEqual(JSON.stringify(emitted[1][1]), '{"nick":"Owen"}');   // made in the vm realm
  assert.deepStrictEqual(Array.from(emitted[2][1]), [1, 4]);
  assert.strictEqual(disconnected, 1);
  assert.deepStrictEqual(log.filter((x) => x[0] === 'applyFrame'), [['applyFrame', 1, bundle.length]]);
  assert.strictEqual(log.filter((x) => x[0] === 'applyClose').length, 0);
});

test('clean room: no Math.random, no em dash, no reference-side path', () => {
  assert.ok(!/Math\.random/.test(SRC));
  assert.ok(!/—/.test(SRC));
  assert.ok(!/slither-reference/.test(SRC));
});
