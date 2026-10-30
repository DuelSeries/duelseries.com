'use strict';
/* Product tracking in the duel and match game pages (Owen 2026-10-29: "track absolutely everything"): Knockout,
   Battleship, Swim, Head Soccer, 8 Ball Pool, Air Hockey, Rooftop Snipers, Crossy Road, Tanks and OMG Shooter.

   Every page loads the plan (shared/trackPlan.js) then the helper (public/js/shared/dsTrack.js) before dsPerfHud.js
   and before its own game script, and the game script opens ONE session under the plan's id for that game and
   marks the wait, the match and its result where the server says so. Then the pages' own tracking block is run for
   real, cut out of each page and run under the real helper with a stand-in DOM: a free match is queued once (a
   reconnect's resumed seat is the same wait), started with the bot and the room, ended with the result and score,
   and a rematch's queue carries neither the last bot nor the last room; a paid match leaves its start and end to
   the server; a watcher is a spectate; no helper on the page is a quiet no-op. OMG Shooter's lives start on a
   spawn and end on a death or a cash-out, once each however many snapshots arrive. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const PLAN_SRC = read('shared', 'trackPlan.js');
const HELPER = read('public', 'js', 'shared', 'dsTrack.js');

// page, game script, the plan's id, how the script names it, whether it is a duel with a queue
const GAMES = [
  { page: 'knockout.html', js: ['public', 'js', 'knockout.js'], id: 'knockout', named: "'knockout'", duel: true, ev: 'ko' },
  { page: 'battleship.html', js: ['public', 'js', 'battleship.js'], id: 'battleship', named: "'battleship'", duel: true, ev: 'bs' },
  { page: 'swim.html', js: ['public', 'js', 'swim', 'swimMain.js'], id: 'swim', named: "'swim'", duel: true, ev: 'sw' },
  { page: 'headsoccer.html', js: ['public', 'js', 'headsoccer.js'], id: 'headsoccer', named: 'GAME', duel: true, ev: 'hs' },
  { page: 'pool8.html', js: ['public', 'js', 'pool8.js'], id: 'pool8', named: 'GAME', duel: true, ev: 'p8' },
  { page: 'airhockey.html', js: ['public', 'js', 'airhockey.js'], id: 'airhockey', named: 'GAME', duel: true, ev: 'ah' },
  { page: 'rooftop.html', js: ['public', 'js', 'rooftop.js'], id: 'rooftop', named: 'GAME', duel: true, ev: 'rt' },
  { page: 'crossy.html', js: ['public', 'js', 'crossy', 'crossyMain.js'], id: 'crossy', named: 'GAME', duel: true, ev: 'cr' },
  { page: 'tanks.html', js: ['public', 'js', 'tanks.js'], id: 'tanks', named: "'tanks'", duel: false },
  { page: 'shooter.html', js: ['public', 'js', 'shooter.js'], id: 'shooter', named: "'shooter'", duel: false },
];

// ── the pages and the scripts ────────────────────────────────────────────────────────────────────────────────────

test('every duel and match page loads the plan, then the helper, before dsPerfHud.js and its game script', () => {
  for (const g of GAMES) {
    const s = read('public', g.page);
    const plan = s.indexOf('<script src="/shared/trackPlan.js"></script>');
    const helper = s.indexOf('<script src="/js/shared/dsTrack.js"></script>');
    const hud = s.indexOf('/js/shared/dsPerfHud.js');
    const m = new RegExp('<script[^>]*src="/?js/' + g.js.slice(2).join('/').replace(/\./g, '\\.') + '"').exec(s);
    const own = m ? m.index : -1;
    assert.ok(plan > 0 && helper > plan, g.page + ': trackPlan.js then dsTrack.js');
    assert.ok(hud > helper, g.page + ': before dsPerfHud.js');
    assert.ok(own > helper, g.page + ': before the game script');
  }
});

test('every game script opens one session under the plan id and marks its start and end', () => {
  const PLAN = require('../shared/trackPlan');
  for (const g of GAMES) {
    const s = read(...g.js);
    assert.strictEqual(PLAN.game(g.id), g.id, g.id + ' is a planned game');
    assert.strictEqual((s.match(/DSTrack\.game\(/g) || []).length, 1, g.id + ': one session');
    assert.ok(s.includes('DSTrack.game(' + g.named + ','), g.id + ': named ' + g.named);
    if (g.named === 'GAME') assert.ok(s.includes("const GAME = '" + g.id + "'"), g.id + ': GAME is ' + g.id);
    if (g.duel) {
      assert.ok(s.includes("trackStep('queue')"), g.id + ': queue');
      assert.match(s, /trackStep\('unqueue', why\)/, g.id + ': the queue giving up');
      assert.ok(s.includes("trackStep('unqueue', 'refused')"), g.id + ': a refused seat');
      assert.match(s, /trackStep\('start', \{ vs_bot: !!\w+\.vsBot, room: \w+\.id \}\)/, g.id + ': start with the bot and room');
      assert.match(s, /trackStep\('end', \{ result: /, g.id + ': end with a result');
      assert.ok(s.includes("result: 'left', reason: 'disconnected'"), g.id + ': a dropped match is left');
      assert.ok(s.includes('t.spectate()'), g.id + ': a watcher is a spectate');
      // queued, after the page has taken the server's answer
      const q = s.indexOf("socket.on('" + g.ev + ":queued'");
      assert.ok(q > 0 && s.indexOf("trackStep('queue')", q) > q && s.indexOf("trackStep('queue')", q) < s.indexOf('});', q),
        g.id + ': queue is marked in ' + g.ev + ':queued');
    }
  }
  const tanks = read('public', 'js', 'tanks.js');
  for (const step of ["trackStep('queue')", "trackStep('start'", "trackStep('end'"]) assert.ok(tanks.includes(step), 'tanks ' + step);
  const shooter = read('public', 'js', 'shooter.js');
  assert.ok(shooter.includes('tracker.start()') && shooter.includes("s.you.cashed ? 'cashed_out' : 'died'"), 'shooter lives');
});

test('tracking never reaches a frame or snapshot loop', () => {
  for (const g of GAMES) {
    const s = read(...g.js);
    for (const loop of ['function frame(', 'function draw(', 'function render(', 'function loop(', 'function tick(', 'function pump(']) {
      const at = s.indexOf(loop);
      if (at < 0) continue;
      // the body: up to the closing brace at the function's own indent
      const line = s.lastIndexOf('\n', at) + 1;
      const indent = s.slice(line, at).replace(/\S.*$/, '');
      const end = s.indexOf('\n' + indent + '}\n', at);
      assert.ok(end > at, g.id + ': end of ' + loop);
      const body = s.slice(at, end);
      assert.ok(!/trackStep\(|tracker\.|TRACKER\./.test(body), g.id + ': no tracking in ' + loop);
    }
  }
});

// ── the pages' own tracking, run for real ────────────────────────────────────────────────────────────────────────

function makeWindow(o) {
  o = o || {};
  const store = new Map();
  const sent = [];
  const win = {
    console: { warn() {}, log() {} },
    location: { origin: 'https://duelseries.com', pathname: o.path || '/', search: '', hostname: 'duelseries.com' },
    document: {
      hidden: false, referrer: '',
      head: { appendChild() {} }, documentElement: { appendChild() {} },
      createElement() { return { setAttribute() {} }; },
      addEventListener() {},
    },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    URLSearchParams, URL, JSON, Math, Date, Error, Object, Array, String, Number, isFinite, setTimeout, clearTimeout,
    posthog: { capture(name, props) { sent.push({ name, props: Object.assign({}, props) }); }, register() {} },
    _sent: sent,
  };
  win.window = win;
  win.top = win;
  vm.createContext(win);
  if (!o.noHelper) {
    vm.runInContext(PLAN_SRC, win);
    vm.runInContext(HELPER, win);
  }
  return win;
}
const names = (w) => w._sent.map((e) => e.name);
const find = (w, n) => w._sent.filter((e) => e.name === n);

/* The tracking block exactly as the page has it: from its session to the end of trackResult. */
function duelBlock(g) {
  const s = read(...g.js);
  const a = s.indexOf('const TRACKER = (() => {');
  const fn = s.indexOf('function trackResult(', a);
  const b = s.indexOf('\n}\n', fn);
  assert.ok(a > 0 && fn > a && b > fn, g.id + ': tracking block found');
  return s.slice(a, b + 3);
}
function bootDuel(g, page) {
  const w = makeWindow({ path: '/' + g.id, noHelper: page.noHelper });
  vm.runInContext(`const GAME = ${JSON.stringify(g.id)}; const myStake = ${page.stake || 0};
    const WATCH = ${!!page.watch}; const WATCH_STAKE = ${page.watchStake || 0};`, w);
  vm.runInContext(duelBlock(g), w);
  return w;
}

for (const g of GAMES.filter((x) => x.duel)) {
  test(g.id + ': a free match is queued once, started and ended; a rematch is a new queue and start', () => {
    const w = bootDuel(g, { stake: 0 });
    const opened = find(w, 'game_opened')[0].props;
    assert.strictEqual(opened.game, g.id); assert.strictEqual(opened.paid, false); assert.strictEqual(opened.mode, 'free');
    vm.runInContext("trackStep('queue'); trackStep('queue');", w);
    assert.strictEqual(find(w, 'queue_joined').length, 1, 'a resumed seat is the same wait');
    vm.runInContext("trackStep('start', { vs_bot: true, room: 'm_1' });", w);
    vm.runInContext("trackStep('end', { result: trackResult(true, 'opponent left'), score: 3, reason: 'opponent left' });", w);
    const end = find(w, 'game_ended')[0].props;
    assert.strictEqual(end.result, 'won'); assert.strictEqual(end.score, 3); assert.strictEqual(end.vs_bot, true);
    assert.strictEqual(end.room, 'm_1'); assert.strictEqual(end.reason, 'opponent left'); assert.ok(end.duration_s >= 0);
    // after the card, a dropped connection is nothing
    vm.runInContext("trackStep('end', { result: 'left', reason: 'disconnected' });", w);
    assert.strictEqual(find(w, 'game_ended').length, 1);
    // Play again
    vm.runInContext("trackStep('queue'); trackStep('start', { vs_bot: false, room: 'm_2' });", w);
    const q2 = find(w, 'queue_joined')[1].props;
    assert.strictEqual(q2.room, undefined); assert.strictEqual(q2.vs_bot, undefined);
    assert.strictEqual(find(w, 'game_started')[1].props.room, 'm_2');
    // a seat that lost because its own connection stayed down left
    vm.runInContext("trackStep('end', { result: trackResult(false, 'opponent left') });", w);
    assert.strictEqual(find(w, 'game_ended')[1].props.result, 'left');
    assert.deepStrictEqual(names(w), ['game_opened', 'queue_joined', 'game_started', 'game_ended', 'queue_joined',
      'game_started', 'game_ended']);
  });

  test(g.id + ': the queue giving up, a paid match left to the server, a watcher, and no helper', () => {
    const w = bootDuel(g, { stake: 0 });
    vm.runInContext("trackStep('queue'); trackStep('unqueue', 'nobody joined that table'); trackStep('unqueue', 'refused');", w);
    const left = find(w, 'queue_left');
    assert.strictEqual(left.length, 1); assert.strictEqual(left[0].props.reason, 'nobody joined that table');
    assert.ok(left[0].props.wait_s >= 0);

    const paid = bootDuel(g, { stake: 1 });
    assert.strictEqual(find(paid, 'game_opened')[0].props.paid, true);
    assert.strictEqual(find(paid, 'game_opened')[0].props.stake, 1);
    vm.runInContext("trackStep('queue'); trackStep('start', { vs_bot: false, room: 'm_9' }); trackStep('end', { result: trackResult(false, 'x') });", paid);
    assert.deepStrictEqual(names(paid), ['game_opened', 'queue_joined'], 'the server sends a paid start and end');

    const watch = bootDuel(g, { watch: true, watchStake: 0.5, stake: 1 });
    const sp = find(watch, 'spectate_started')[0].props;
    assert.strictEqual(sp.game, g.id); assert.strictEqual(sp.stake, 0.5); assert.strictEqual(sp.paid, true);

    const bare = bootDuel(g, { noHelper: true });
    assert.doesNotThrow(() => vm.runInContext("trackStep('queue'); trackStep('start', {}); trackStep('end', {});", bare));
    assert.strictEqual(vm.runInContext('TRACKER', bare), null);
  });
}

test('tanks: a free table, queued, started against the bot, ended with the result', () => {
  const s = read('public', 'js', 'tanks.js');
  const a = s.indexOf('const tracker = (() => {');
  const b = s.indexOf('/* Everything known about the match.', a);
  assert.ok(a > 0 && b > a);
  const w = makeWindow({ path: '/tanks' });
  vm.runInContext(s.slice(a, b), w);
  vm.runInContext("trackStep('end', { result: 'left' }); trackStep('queue'); trackStep('queue'); trackStep('start', { vs_bot: true, room: 'tanks_1' }); trackStep('end', { result: 'lost', score: 0, reason: 'destroyed' });", w);
  assert.deepStrictEqual(names(w), ['game_opened', 'queue_joined', 'game_started', 'game_ended']);
  const end = find(w, 'game_ended')[0].props;
  assert.strictEqual(end.game, 'tanks'); assert.strictEqual(end.result, 'lost'); assert.strictEqual(end.vs_bot, true);
  assert.strictEqual(end.paid, false);
});

test('OMG Shooter: one game per life, started on a spawn and ended on a death or a cash-out, whatever the snapshot rate', () => {
  const s = read('public', 'js', 'shooter.js');
  const a = s.indexOf('var tracker = (function () {');
  const fn = s.indexOf('function trackLife(', a);
  const b = s.indexOf('\n  }\n', fn);
  assert.ok(a > 0 && fn > a && b > fn);
  const w = makeWindow({ path: '/shooter' });
  vm.runInContext(s.slice(a, b + 5), w);
  const snap = (you, board) => vm.runInContext('trackLife(' + JSON.stringify({ you, board: board || [] }) + ')', w);
  snap(null);
  for (let i = 0; i < 30; i++) snap({ dead: false, cashed: false, banked: 0 });
  for (let i = 0; i < 30; i++) snap({ dead: true, cashed: false, banked: 40 }, [{ n: 'A', b: 90 }, { n: 'me', b: 40, me: 1 }]);
  snap({ dead: false, cashed: false, banked: 40 });
  snap({ dead: false, cashed: true, banked: 75 });
  assert.deepStrictEqual(names(w), ['game_opened', 'game_started', 'game_ended', 'game_started', 'game_ended']);
  const [died, cashed] = find(w, 'game_ended').map((e) => e.props);
  assert.strictEqual(died.game, 'shooter'); assert.strictEqual(died.result, 'died'); assert.strictEqual(died.score, 40);
  assert.strictEqual(died.place, 2); assert.strictEqual(died.paid, false);
  assert.strictEqual(cashed.result, 'cashed_out'); assert.strictEqual(cashed.score, 75); assert.strictEqual(cashed.place, undefined);
});
