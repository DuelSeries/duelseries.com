'use strict';
/* The ping and FPS readout every game shares (public/js/shared/dsPerfHud.js) and the echo that answers it
   (server/perfEcho.js).

   The server half runs on a real socket.io server: every namespace answers 'ds:ping', made before or after install,
   and a flood past the window's cap goes unanswered. The page half runs under a stand-in DOM with a hand-turned
   clock and animation frame: the median of three, the late answer shown as the wait, the grey "-- ms" off the
   socket, FPS over two halves written twice a second, text written only when it changes, and the 0.7 page scale. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { Server } = require('socket.io');
const perfEcho = require('../server/perfEcho');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'shared', 'dsPerfHud.js'), 'utf8');

// ---- server

test('perfEcho answers ds:ping on every namespace, made before or after install', async () => {
  const srv = http.createServer();
  const io = new Server(srv);
  io.of('/ag');                                   // made before install
  perfEcho.install(io);
  io.of('/sl');                                   // made after install
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const { io: client } = require('socket.io-client');
  const socks = [];
  try {
    for (const nsp of ['/', '/ag', '/sl']) {
      const s = client(`http://127.0.0.1:${port}${nsp}`, { transports: ['websocket'], forceNew: true, reconnection: false });
      socks.push(s);
      await new Promise((resolve, reject) => { s.on('connect', resolve); s.on('connect_error', reject); });
      const rtt = await new Promise((resolve, reject) => {
        const at = Date.now();
        const bail = setTimeout(() => reject(new Error(nsp + ': no answer')), 3000);
        s.emit('ds:ping', () => { clearTimeout(bail); resolve(Date.now() - at); });
      });
      assert.ok(rtt >= 0 && rtt < 3000, nsp);
    }
  } finally {
    for (const s of socks) s.close();
    io.close();
    srv.close();
  }
});

test('perfEcho drops pings past the window cap and opens again in the next window', () => {
  let t = 1000;
  const handlers = {};
  const sock = { on: (ev, fn) => { handlers[ev] = fn; } };
  perfEcho.attach(sock, () => t);
  let answered = 0;
  for (let i = 0; i < perfEcho.MAX_PER_WINDOW + 5; i++) handlers['ds:ping'](() => answered++);
  assert.strictEqual(answered, perfEcho.MAX_PER_WINDOW);
  handlers['ds:ping']({ not: 'a function' });     // no acknowledgement asked: nothing to answer, nothing thrown
  t += perfEcho.WINDOW_MS;
  handlers['ds:ping'](() => answered++);
  assert.strictEqual(answered, perfEcho.MAX_PER_WINDOW + 1);
});

// ---- page

function makeNode(tag) {
  const n = {
    tagName: tag, children: [], style: {}, hidden: false, className: '', attrs: {}, writes: 0, _text: '',
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }
  };
  Object.defineProperty(n, 'textContent', {
    get() { return this._text; },
    set(v) { this._text = String(v); this.writes++; }
  });
  return n;
}

function boot(viewport, visualViewport) {
  const head = makeNode('head');
  const body = makeNode('body');
  let meta = null;
  if (viewport) { meta = makeNode('meta'); meta.attrs.content = viewport; }
  let clock = 0;
  let frames = [];
  const doc = {
    head, body, documentElement: makeNode('html'),
    createElement: makeNode,
    querySelector: (q) => (q.indexOf('viewport') >= 0 ? meta : null),
    addEventListener() {}
  };
  const win = {
    document: doc,
    performance: { now: () => clock },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    visualViewport
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'dsPerfHud.js' });
  return {
    win, body,
    hud: win.DSPerfHud,
    // one animation frame at clock + ms
    step(ms) {
      clock += ms;
      const run = frames;
      frames = [];
      for (const f of run) f();
    },
    run(ms, every) { for (let t = 0; t < ms; t += every) this.step(every); },
    get clock() { return clock; }
  };
}

function parts(env) {
  const box = env.hud.element;
  const ping = box.children[0];
  return { box, dot: ping.children[0], ms: ping.children[1], fps: box.children[1] };
}

function fakeSocket() {
  const s = {
    connected: true, sent: [], on: (ev, fn) => { (s.handlers[ev] = s.handlers[ev] || []).push(fn); }, handlers: {},
    emit(ev, ack) { s.sent.push({ ev, ack }); },
    fire(ev) { for (const fn of s.handlers[ev] || []) fn(); }
  };
  return s;
}

test('the readout: bottom right, never takes a touch, starts at "-- ms" and "FPS --"', () => {
  const env = boot();
  env.hud.mount();
  const p = parts(env);
  assert.ok(env.body.children.includes(p.box));
  assert.strictEqual(p.ms.textContent, '-- ms');
  assert.strictEqual(p.fps.textContent, 'FPS --');
  assert.strictEqual(p.dot.className, 'dsp-dot');
  const css = SRC.slice(SRC.indexOf('var CSS'), SRC.indexOf('].join'));
  assert.match(css, /position:fixed;right:calc\(8px/);
  assert.match(css, /bottom:calc\(4px/);
  assert.match(css, /pointer-events:none/);
});

test('ping: the median of the last three echoes, coloured by slither\'s 50/100 ms steps', () => {
  const env = boot();
  const s = fakeSocket();
  env.hud.mount({ socket: s });
  const p = parts(env);
  const answer = (afterMs) => { const last = s.sent[s.sent.length - 1]; env.step(afterMs); last.ack(); };
  env.step(16);
  assert.strictEqual(s.sent.length, 1, 'one goes on the first frame');
  assert.strictEqual(s.sent[0].ev, 'ds:ping');
  answer(40);
  assert.strictEqual(p.ms.textContent, '40 ms');
  assert.strictEqual(p.dot.className, 'dsp-dot dsp-green');
  env.step(16);
  assert.strictEqual(s.sent.length, 1, 'one in flight at a time, the next after 500 ms while starting');
  const untilSent = (n) => { const from = env.clock; while (s.sent.length < n && env.clock - from < 5000) env.step(16); return env.clock - from; };
  untilSent(2);
  answer(300);                                   // one slow answer: median of 40 and 300 is the lower
  assert.strictEqual(p.ms.textContent, '40 ms');
  untilSent(3);
  answer(80);                                    // 40, 300, 80 -> 80
  assert.strictEqual(p.ms.textContent, '80 ms');
  assert.strictEqual(p.dot.className, 'dsp-dot dsp-orange');
  const gap = untilSent(4);
  assert.ok(gap > 1800 && gap < 2100, 'then every 2 s: ' + gap);
  answer(150);                                   // 300, 80, 150 -> 150
  assert.strictEqual(p.ms.textContent, '150 ms');
  assert.strictEqual(p.dot.className, 'dsp-dot dsp-red');
  assert.strictEqual(env.hud.ping(), 150);
});

test('ping: an answer over 2 s late shows as the wait, in red, a few times a second', () => {
  const env = boot();
  const s = fakeSocket();
  env.hud.mount({ socket: s });
  const p = parts(env);
  env.step(16);
  const first = s.sent[0];
  env.step(30); first.ack();
  env.run(600, 16);
  assert.strictEqual(s.sent.length, 2);
  const writes = p.ms.writes;
  env.run(2600, 16);
  assert.match(p.ms.textContent, /^2(000|250|500|750) ms$/);
  assert.strictEqual(p.dot.className, 'dsp-dot dsp-red');
  assert.ok(p.ms.writes - writes <= 4, 'quarter seconds, not every frame: ' + (p.ms.writes - writes));
  assert.strictEqual(s.sent.length, 2, 'no second ping while one is waiting');
});

test('ping: grey "-- ms" off the socket, fresh numbers after a reconnect, and late answers from before are dropped', () => {
  const env = boot();
  const s = fakeSocket();
  env.hud.mount({ socket: s });
  const p = parts(env);
  env.step(16);
  const old = s.sent[0];
  s.connected = false;
  s.fire('disconnect');
  env.step(16);
  assert.strictEqual(p.ms.textContent, '-- ms');
  assert.strictEqual(p.dot.className, 'dsp-dot');
  old.ack();                                     // the answer to a ping from before the drop
  assert.strictEqual(p.ms.textContent, '-- ms');
  s.connected = true;
  s.fire('connect');
  env.step(16);
  assert.strictEqual(s.sent.length, 2, 'a ping at once on the new connection');
  env.step(25); s.sent[1].ack();
  assert.strictEqual(p.ms.textContent, '25 ms');
});

test('ping: an echo function stands in for a socket (slither.io\'s layer), and use() swaps the source', () => {
  const env = boot();
  const calls = [];
  env.hud.mount({ echo: (done) => { calls.push(done); return true; } });
  const p = parts(env);
  env.step(16);
  assert.strictEqual(calls.length, 1);
  env.step(12); calls[0]();
  assert.strictEqual(p.ms.textContent, '12 ms');
  const s = fakeSocket();
  env.hud.use(s);
  assert.strictEqual(p.ms.textContent, '-- ms', 'a new source starts over');
  env.step(16);
  assert.strictEqual(s.sent.length, 1);
});

test('FPS: frames in the last second over two halves, written twice a second and only when it changes', () => {
  const env = boot();
  env.hud.mount();
  const p = parts(env);
  env.run(520, 1000 / 60);
  assert.match(p.fps.textContent, /^FPS (59|60|61)$/);
  env.run(1000, 1000 / 60);
  assert.match(p.fps.textContent, /^FPS (59|60|61)$/);
  const w = p.fps.writes;
  env.run(1000, 1000 / 30);
  assert.ok(p.fps.writes - w <= 2, 'at most two writes a second');
  env.run(1000, 1000 / 30);
  assert.match(p.fps.textContent, /^FPS (29|30|31)$/);
  env.step(5000);                                // a hidden tab: no average across the pause
  env.run(1100, 1000 / 60);
  assert.match(p.fps.textContent, /^FPS (59|60|61)$/);
});

test('show(false) hides it; a page really laid out at 0.7 (slither on a phone) draws it back up, a computer does not', () => {
  const VP = 'minimal-ui, user-scalable=no, initial-scale=0.7, maximum-scale=0.7, width=device-width';
  const env = boot(VP, { scale: 0.7 });
  env.hud.mount({ visible: false });
  const p = parts(env);
  assert.strictEqual(p.box.hidden, true);
  env.hud.show(true);
  assert.strictEqual(p.box.hidden, false);
  assert.strictEqual(p.box.style.transform, 'scale(1.4286)');
  env.hud.mount({ zoom: 1 });                    // the page knows better (slx.layoutZoom: a frame the lobby drew 1:1)
  assert.strictEqual(p.box.style.transform, '');
  const pc = boot(VP, { scale: 1 });             // a computer ignores the viewport line
  pc.hud.mount();
  assert.strictEqual(parts(pc).box.style.transform, '');
  const told = boot(VP, { scale: 1 });
  told.hud.mount({ zoom: 1 / 0.7 });             // slither's frame the lobby drew at 0.7 on a phone
  assert.strictEqual(parts(told).box.style.transform, 'scale(1.4286)');
  const plain = boot('width=device-width, initial-scale=1', { scale: 1 });
  plain.hud.mount();
  assert.strictEqual(parts(plain).box.style.transform, '');
});

// ---- every game

// Each game's page and the script that makes its socket (Owen 2026-10-27: the exact same counter in every game).
// slither.io and its battle royale (/sl) load it through server/sl/slBoot.js and mount it in slxStats.js.
const GAME_PAGES = {
  'chomp.html': 'js/chomp/chompMain.js',
  'ag.html': 'js/ag/agMain.js',
  'paper-arena.html': 'js/paper/mp/paperArenaMain.js',
  'headsoccer.html': 'js/headsoccer.js',
  'swim.html': 'js/swim/swimMain.js',
  'shooter.html': 'js/shooter.js',
  'tanks.html': 'js/tanks.js',
  'knockout.html': 'js/knockout.js',
  'battleship.html': 'js/battleship.js',
  'game.html': 'js/game.js'
};

test('every game page loads the shared readout before its game script, mounts it, and draws no counter of its own', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
  for (const [page, script] of Object.entries(GAME_PAGES)) {
    const html = read(page);
    const at = html.indexOf('<script src="/js/shared/dsPerfHud.js"></script>');
    assert.ok(at > 0, page + ': loads dsPerfHud.js');
    const own = Math.max(html.indexOf('src="/' + script + '"'), html.indexOf('src="' + script + '"'));
    assert.ok(own > at, page + ': before ' + script);
    assert.ok(!/id="(ping-display|ping-dot|ping-value|fps-counter|perf-counter|netwrap)"/.test(html), page + ': a counter of its own');
    assert.match(read(script), /DSPerfHud\.mount\(\{ socket/, script + ': mounts it on its socket');
  }
  const { SLX_TAIL } = require('../server/sl/slBoot');
  assert.ok(SLX_TAIL.indexOf('/js/shared/dsPerfHud.js') >= 0 && SLX_TAIL.indexOf('/js/shared/dsPerfHud.js') < SLX_TAIL.indexOf('/js/slx/slxStats.js'),
    '/sl loads it before the layer');
  assert.match(read('js/slx/slxStats.js'), /DSPerfHud\.mount\(\{ echo: slx\.echo/, 'slxStats mounts it on slx.echo');
});
