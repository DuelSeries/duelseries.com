'use strict';
/* Product tracking on the arena games' pages (Owen 2026-10-29: "track absolutely everything", organized): slither.io
   and its battle royale on /sl (public/js/slx/slxTrack.js), the old engine's /game.html (public/js/game.js), agar.io
   (public/js/ag/agMain.js), Paper (public/js/paper/mp/paperArenaMain.js) and Pac-Man (public/js/chomp/chompMain.js).

   Every page loads the plan and the helper (shared/trackPlan.js, public/js/shared/dsTrack.js) before its game. Each
   game makes one session for its page, starts it when the player is in the arena, ends it once per life (a death, a
   cash-out, the battle royale's win) and says when it spectates; the old direct PostHog calls are gone. /sl and agar.io
   are run for real under stand-ins with the real helper: a free life sends its start and end with the facts its card
   shows, a paid one leaves both to the server, a watcher never starts. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PLAN = require('../shared/trackPlan');
const PLAN_SRC = fs.readFileSync(path.join(ROOT, 'shared', 'trackPlan.js'), 'utf8');
const HELPER = fs.readFileSync(path.join(ROOT, 'public', 'js', 'shared', 'dsTrack.js'), 'utf8');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ── the pages ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('every arena page loads the plan, then the helper, before its game and before the ping readout', () => {
  const PAGES = { 'public/ag.html': '/js/ag/agMain.js', 'public/chomp.html': '/js/chomp/chompMain.js',
    'public/paper-arena.html': '/js/paper/mp/paperArenaMain.js', 'public/game.html': 'js/game.js' };
  for (const [page, main] of Object.entries(PAGES)) {
    const html = read(page);
    const plan = html.indexOf('<script src="/shared/trackPlan.js"></script>');
    const helper = html.indexOf('<script src="/js/shared/dsTrack.js"></script>');
    assert.ok(plan > 0 && helper > plan, page + ': trackPlan.js then dsTrack.js');
    assert.ok(helper < html.indexOf('/js/shared/dsPerfHud.js'), page + ': before dsPerfHud.js');
    assert.ok(helper < html.indexOf('src="' + main + '"'), page + ': before ' + main);
  }
  // a page opened on its own keeps PostHog's own loader (it does nothing inside the lobby's frame)
  for (const page of ['public/game.html', 'public/paper-arena.html']) {
    const html = read(page);
    const init = html.indexOf('<script src="/js/posthog-init.js"></script>');
    assert.ok(init > 0 && init < html.indexOf('/js/shared/dsTrack.js'), page + ': posthog-init.js kept, first');
  }
});

test('/sl loads both before the frozen client, outside the product script list the parity harness runs', () => {
  const html = read('public/sl.html');
  const plan = html.indexOf('/shared/trackPlan.js'), helper = html.indexOf('/js/shared/dsTrack.js');
  assert.ok(plan > 0 && helper > plan && helper < html.indexOf('/socket.io/socket.io.js'));
  // test/slParityGate.test.js, test/slVmPage.js and test/slHud.test.js read <script src="X"></script> as the frozen
  // client's scripts: the two tags carry an attribute so that list (and the goldens) stay exactly the client's
  const listed = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(!listed.includes('/shared/trackPlan.js') && !listed.includes('/js/shared/dsTrack.js'));
  assert.strictEqual(listed[0], '/socket.io/socket.io.js');
  assert.ok(html.indexOf('<!') < 0 && html.toLowerCase().indexOf('slither') < 0, 'still no doctype and no slither text');
  // the layer file is in the composed page's tail, after the files it reads
  const { SLX_TAIL } = require('../server/sl/slBoot');
  const at = SLX_TAIL.indexOf('/js/slx/slxTrack.js');
  for (const f of ['slxPaid', 'slxBr', 'slxWatch', 'slxCard', 'slxHud']) assert.ok(at > SLX_TAIL.indexOf('/js/slx/' + f + '.js'), f);
});

test('the old direct calls are gone, and each game makes its session, starts, ends a death and a cash-out, and spectates', () => {
  const MINE = ['public/js/ag/agMain.js', 'public/js/ag/agPaid.js', 'public/js/game.js', 'public/js/paper/mp/paperArenaMain.js',
    'public/js/chomp/chompMain.js', 'public/js/chomp/chompPaid.js', ...fs.readdirSync(path.join(ROOT, 'public/js/slx')).map((f) => 'public/js/slx/' + f)];
  for (const f of MINE) {
    const s = read(f);
    assert.ok(!/\bphEvent\b|\bphIdentify\b|posthog\./.test(s), f + ': an old direct analytics call');
  }
  const GAMES = {
    'public/js/ag/agMain.js': /DSTrack\.game\('agar'/,
    'public/js/chomp/chompMain.js': /DSTrack\.game\('chomp'/,
    'public/js/paper/mp/paperArenaMain.js': /DSTrack\.game\('paper'/,
    'public/js/game.js': /DSTrack\.game\(isBattleRoyale \? 'br' : 'slither'/,
    'public/js/slx/slxTrack.js': /var game = br\(\) \? 'br' : 'slither';/
  };
  for (const [f, made] of Object.entries(GAMES)) {
    const s = read(f);
    assert.match(s, made, f + ': its session, by the plan\'s game id');
    assert.ok(PLAN.GAMES.includes(f.includes('chomp') ? 'chomp' : f.includes('paper') ? 'paper' : f.includes('/ag/') ? 'agar' : 'slither'));
    assert.match(s, /\.start\(/, f + ': starts');
    assert.match(s, /result: [^,]*'died'/, f + ': a death');
    assert.match(s, /result: [^,]*'cashed_out'/, f + ': a cash-out');
    assert.match(s, /\.spectate\(\)/, f + ': a Spectate');
  }
  assert.match(read('public/js/game.js'), /engine: 'old'/);
  assert.match(read('public/js/slx/slxTrack.js'), /base\.engine = 'sl';/);
  assert.match(read('public/js/game.js'), /result: 'won', place: 1/, 'the old engine\'s battle royale win');
  // never per frame: no tracking inside a draw or tick loop
  for (const f of Object.keys(GAMES)) {
    const s = read(f);
    for (const m of s.matchAll(/function (render|draw|frame|loop|tick|pump)\s*\([^)]*\)\s*\{/g)) {
      let depth = 0, i = m.index + m[0].length - 1, end = i;
      for (; end < s.length; end++) { if (s[end] === '{') depth++; else if (s[end] === '}' && --depth === 0) break; }
      assert.ok(!/tracked\(|DSTrack\./.test(s.slice(i, end)), f + ': tracking inside ' + m[1] + '()');
    }
  }
});

// ── the real helper under a stand-in window ──────────────────────────────────────────────────────────────────────────

function trackWindow(pathname) {
  const listeners = {};
  const sent = [];
  const win = {
    console: { warn(m) { sent.push({ name: '$warn', m }); }, log() {} },
    location: { origin: 'https://duelseries.com', pathname, search: '', hostname: 'duelseries.com' },
    document: { hidden: false, referrer: '', head: { appendChild() {} }, documentElement: { appendChild() {} },
      createElement() { return { setAttribute() {} }; }, addEventListener() {} },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    fire(t, e) { for (const f of listeners[t] || []) f(e || {}); },
    matchMedia: () => ({ matches: false }),
    posthog: { supers: {}, capture(name, props) { sent.push({ name, props: Object.assign({}, this.supers, props) }); },
      register(p) { Object.assign(this.supers, p); } },
    URLSearchParams, URL, JSON, Math, Date, Error, Object, Array, String, Number, isFinite, setTimeout, clearTimeout
  };
  win.window = win;
  win.top = win;
  vm.createContext(win);
  vm.runInContext(PLAN_SRC, win);
  vm.runInContext(HELPER, win);
  const events = () => sent.filter((e) => !e.name.startsWith('$'));
  return { win, sent, events, names: () => events().map((e) => e.name), find: (n) => events().filter((e) => e.name === n),
    warnings: () => sent.filter((e) => e.name === '$warn').map((e) => e.m) };
}

// ── /sl: the layer file on a stand-in layer ──────────────────────────────────────────────────────────────────────────

const SLX_TRACK = read('public/js/slx/slxTrack.js');

// The /sl page as slxTrack sees it: slxNet's event bus, their S (the last-score line), slxHud's own(), and what the
// other layer files set (o.trackBase: slxPaid or slxWatch; o.br: slxBr; o.watch: slxWatch).
function slPage(o) {
  o = o || {};
  const T = trackWindow('/sl');
  const handlers = {};
  const slx = {
    active: true,
    errors: 0,
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
    fire(name, arg) { for (const fn of handlers[name] || []) fn(arg); }
  };
  const box = { length: 0, rank: 0, count: 0 };
  slx.hud = { own: () => (box.rank > 0 ? Object.assign({}, box) : null) };
  if (o.trackBase) slx.trackBase = () => o.trackBase;
  if (o.br) slx.br = { mode: () => o.br.mode, state: () => o.br.state };
  if (o.watch) slx.watch = { state() { return {}; } };
  const S = { lastscore: { innerHTML: '&nbsp;' } };
  T.win.DuelSlither = { slx, S };
  if (o.noHelper) T.win.DSTrack = undefined;
  vm.runInContext(SLX_TRACK, T.win, { filename: 'slxTrack.js' });
  return Object.assign(T, { slx, S, box, handlers,
    died(len) { S.lastscore.innerHTML = '<span style="opacity: .45;">Your final length was </span><b>' + len + '</b>'; slx.fire('ownDead', { code: 0 }); } });
}

test('/sl free: opened, started on the own snake, died with the length, rank and count; a Play again is a new game', () => {
  const p = slPage();
  assert.deepStrictEqual(p.names(), ['game_opened']);
  const opened = p.find('game_opened')[0].props;
  assert.deepStrictEqual([opened.game, opened.paid, opened.mode, opened.engine, opened.page], ['slither', false, 'free', 'sl', 'game']);
  p.slx.fire('open');
  p.slx.fire('ownAdd', { id: 7 });
  p.box.length = 812; p.box.rank = 3; p.box.count = 41;
  p.win.DSTrack.sample({ fps: 60, ping: 40 });
  p.died(830);
  p.slx.fire('close', { playing: true, sawDead: true });
  const end = p.find('game_ended')[0].props;
  assert.deepStrictEqual([end.result, end.score, end.place, end.players, end.game, end.engine], ['died', 830, 3, 41, 'slither', 'sl']);
  assert.ok(end.duration_s >= 0);
  assert.strictEqual(p.find('game_perf').length, 1, 'the FPS and ping summary with the end');
  p.slx.fire('open');
  p.slx.fire('ownAdd', { id: 9 });
  p.slx.fire('close', { playing: true, sawDead: false });
  assert.deepStrictEqual(p.names(), ['game_opened', 'game_started', 'game_ended', 'game_perf', 'game_started', 'game_ended']);
  const lost = p.find('game_ended')[1].props;
  assert.deepStrictEqual([lost.result, lost.reason, lost.score], ['ended', 'disconnect', 812]);
  assert.deepStrictEqual(p.warnings(), [], 'nothing dropped by the plan');
});

test('/sl: a free cash-out ends the life once (their dead after it is the same life), with the server\'s length', () => {
  const p = slPage();
  p.slx.fire('open'); p.slx.fire('ownAdd', { id: 7 });
  p.box.rank = 2; p.box.count = 30;
  p.slx.fire('x:cashed', { t: 'cashed', len: 500 });
  p.died(500);
  const ends = p.find('game_ended');
  assert.strictEqual(ends.length, 1);
  assert.deepStrictEqual([ends[0].props.result, ends[0].props.amount, ends[0].props.score, ends[0].props.place], ['cashed_out', 0, 500, 2]);
});

test('/sl paid: the start and end are the server\'s; the page still says goodbye mid-life with a quit', () => {
  const p = slPage({ trackBase: { paid: true, stake: 1, mode: 'paid' } });
  const opened = p.find('game_opened')[0].props;
  assert.deepStrictEqual([opened.paid, opened.stake, opened.mode], [true, 1, 'paid']);
  p.slx.fire('open'); p.slx.fire('ownAdd', { id: 7 });
  p.slx.fire('x:cashed', { t: 'cashed', len: 900, gross: 2000000, cut: 200000, net: 1800000 });
  assert.deepStrictEqual(p.names(), ['game_opened'], 'no game_started or game_ended from a paid page');
  p.slx.fire('open'); p.slx.fire('ownAdd', { id: 8 });
  p.win.fire('pagehide');
  const q = p.find('game_quit')[0].props;
  assert.deepStrictEqual([q.stage, q.paid, q.stake, q.game], ['playing', true, 1, 'slither']);
});

test('/sl battle royale: a death in the running match places by those alive; the winner\'s cash-out is a win', () => {
  const st = { state: 'running', alive: 6, startedCount: 20, prize: 20 };
  const p = slPage({ br: { mode: 'play', state: st } });
  const opened = p.find('game_opened')[0].props;
  assert.deepStrictEqual([opened.game, opened.mode, opened.paid], ['br', 'br', false]);
  p.slx.fire('open'); p.slx.fire('ownAdd', { id: 7 });
  p.died(300);
  const out = p.find('game_ended')[0].props;
  assert.deepStrictEqual([out.result, out.place, out.players, out.score], ['died', 6, 20, 300]);
  // the next match: this snake wins
  p.slx.fire('open'); p.slx.fire('ownAdd', { id: 12 });
  st.state = 'over'; st.winner = { id: 12, name: 'me' };
  p.slx.fire('x:cashed', { t: 'cashed', len: 2400 });
  p.died(2400);
  const won = p.find('game_ended')[1].props;
  assert.deepStrictEqual([won.result, won.place, won.players, won.amount, won.score], ['won', 1, 20, 20, 2400]);
  assert.strictEqual(p.find('game_ended').length, 2);
});

test('/sl watching (a Spectate page, or the battle royale\'s watch mode): spectate_started once, never a start', () => {
  const p = slPage({ watch: true, trackBase: { paid: true, stake: 0.5, mode: 'paid' } });
  for (let i = 0; i < 3; i++) { p.slx.fire('open'); p.slx.fire('ownAdd', { id: 20 + i }); p.died(100); }
  assert.deepStrictEqual(p.names(), ['game_opened', 'spectate_started']);
  assert.deepStrictEqual([p.find('spectate_started')[0].props.stake, p.find('spectate_started')[0].props.paid], [0.5, true]);
  p.win.fire('pagehide');
  assert.strictEqual(p.find('game_quit').length, 0, 'leaving a watch is not a quit');

  const br = { mode: 'watch', state: { state: 'running', alive: 4 } };
  const q = slPage({ br });
  q.slx.fire('open'); q.slx.fire('ownAdd', { id: 3 });
  assert.deepStrictEqual(q.names(), ['game_opened', 'spectate_started']);
  br.mode = 'play';                                  // Join next: a life of their own
  q.slx.fire('open'); q.slx.fire('ownAdd', { id: 30 });
  assert.deepStrictEqual(q.names(), ['game_opened', 'spectate_started', 'game_started']);
});

test('/sl with no helper on the page: slxTrack registers nothing', () => {
  const p = slPage({ noHelper: true });
  assert.deepStrictEqual(Object.keys(p.handlers), []);
});

// ── agar.io: agMain on its fake page, with the real helper ───────────────────────────────────────────────────────────

const { bootPage, spawn } = require('./agFakePage');

// The fake page builds its own window inside bootPage; agMain reads win.DSTrack once, at boot. So the helper is lent
// to every object for exactly that call (non-enumerable, taken back at once): agMain keeps its session after.
function agPage(o) {
  const T = trackWindow('/ag');
  Object.defineProperty(Object.prototype, 'DSTrack', { value: T.win.DSTrack, configurable: true, writable: true });
  let p;
  try {
    p = bootPage(o);
  } finally {
    delete Object.prototype.DSTrack;
  }
  return Object.assign(p, { T });
}

test('agar.io free: started on the spawn, a death with the best mass and the board place, then a free cash-out', async () => {
  const p = agPage();
  const feed = p.session.feed;
  await spawn(p, feed);
  assert.deepStrictEqual(p.T.names(), ['game_opened', 'game_started']);
  assert.deepStrictEqual([p.T.find('game_opened')[0].props.game, p.T.find('game_opened')[0].props.mode], ['agar', 'free']);
  feed({ t: 'world', eats: [], cells: [], removed: [9] });
  const end = p.T.find('game_ended')[0].props;
  assert.deepStrictEqual([end.result, end.score, end.place, end.paid], ['died', 400, 2, false]);
  // Play again, then a free cash-out (Q in the free room leaves with nothing)
  p.session.play('me');
  feed({ t: 'own', id: 9 });
  feed({ t: 'world', eats: [], cells: [{ id: 9, x: 0, y: 0, size: 200, virus: false, food: false, ejected: false, agitated: false, flag40: false, party: false, rgb: [255, 7, 100] }], removed: [] });
  await p.frames(2);
  p.session.sideEvent('ag:cashedout', { free: true });
  feed({ t: 'world', eats: [], cells: [], removed: [9] });
  const ends = p.T.find('game_ended');
  assert.strictEqual(ends.length, 2);
  assert.deepStrictEqual([ends[1].props.result, ends[1].props.amount], ['cashed_out', 0]);
  assert.strictEqual(p.T.find('game_started').length, 2, 'a respawn is a new game');
  assert.deepStrictEqual(p.T.warnings(), []);
});

test('agar.io paid: the seat turns the session paid; its cash-out sends nothing (the server does), never twice', async () => {
  const p = agPage();
  p.session.sideEvent('ag:joined', { stake: 1, micro: 1000000, holdTicks: 75, tickMs: 40 });
  await spawn(p, p.session.feed);
  p.session.sideEvent('ag:cashedout', { grossMicro: 1400000, cutMicro: 140000, netMicro: 1260000, cashoutId: 'c1' });
  p.session.feed({ t: 'world', eats: [], cells: [], removed: [9] });
  assert.deepStrictEqual(p.T.names(), ['game_opened'], 'a paid start and end are the server\'s');
  assert.ok(!p.T.sent.some((e) => e.name === 'cashed_out' || e.name === '$warn'), 'no old event name');
});

test('agar.io Spectate: spectate_started once', async () => {
  const p = agPage();
  p.session.spectate();
  p.session.spectate();
  assert.deepStrictEqual(p.T.names(), ['game_opened', 'spectate_started']);
});
