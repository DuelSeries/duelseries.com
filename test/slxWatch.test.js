'use strict';
// slxWatch, ACTIVE: Spectate in the free room on its own fake page (test/slxHudFakes.js; never the gate's page, where
// the layer stays inert, test/slxNoTouch.test.js). Loaded as the composed page loads it: slxWatch, then the real
// slxMain (the handshake merge, guard, toLobby) and the real slxCard (the card hooks), after the shared end screens
// it draws with (public/js/shared/dsEnd.js, which the composed page loads first), and the real shared Spectate bar
// after the layer (public/js/shared/dsWatchBar.js, as server/sl/slBoot.js slxTail loads it). The server side is
// test/slWatchFree.test.js; slxNet's endLife is test/slxNet.test.js.
//
// Checks: the lobby's mark is read once and removed, and the file is inert without it, on a paid page, a page slxPaid
// holds, the battle royale's page and under a harness transport; the handshake (after for Next, before for Previous);
// the bar opens at boot, shows the watched name, its arrows only while a life is on screen; Previous and Next (the
// arrows, the keys, the debug calls) end the life once and the next life starts the moment their close has run, with
// no card; a watched snake's death stays DEATH_MS, then the leader the same way; a tap on the bar is never swallowed
// or prevented; every steering, boost, hold and chat input on the game is swallowed while live; the CASH OUT button
// hides; a dropped connection keeps the card; nobody to watch is the bar's empty table, asked again every few seconds
// while visible; Lobby closes the bar and stops it all.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makePage, ROOT } = require('./slxHudFakes');

function store(init) {
  const m = Object.assign({}, init || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    keys: () => Object.keys(m).sort()
  };
}

// The fake page's elements have no classList; the shared bar toggles its classes through one.
function classList(El) {
  if (Object.getOwnPropertyDescriptor(El.prototype, 'classList')) return;
  Object.defineProperty(El.prototype, 'classList', {
    get() {
      const el = this;
      const list = () => String(el.className || '').split(/\s+/).filter(Boolean);
      return {
        contains: (c) => list().includes(c),
        add: (c) => { if (!list().includes(c)) el.className = list().concat(c).join(' '); },
        remove: (c) => { el.className = list().filter((x) => x !== c).join(' '); },
        toggle(c, force) {
          const on = force === undefined ? !list().includes(c) : !!force;
          if (on) this.add(c);
          else this.remove(c);
          return on;
        }
      };
    }
  });
}

// opts: session (sessionStorage, default the lobby's mark), local, paidOn, paidHold, br, inactive, endLife (its answer),
// framed (a lobby parent), main (load slxMain, default on), card (load slxCard, default on).
function watchPage(o) {
  const opt = o || {};
  const ss = store(opt.session === undefined ? { dsWatch: 'snake', playerName: 'Owen' } : opt.session);
  const posted = [];
  const win = { sessionStorage: ss, localStorage: store(opt.local) };
  if (opt.framed) {
    win.parent = { postMessage: (m, origin) => posted.push([m, origin]) };
    win.location = { origin: 'https://duelseries.com', assigned: [], assign(u) { this.assigned.push(String(u)); } };
  }
  const P = makePage({ win, S: { dead_mtm: -1 } });
  classList(P.El);
  const ends = [];
  P.slx.endLife = () => { ends.push(P.clock.now); return opt.endLife !== false; };
  P.slx.paid = { on: !!opt.paidOn };
  if (opt.paidHold) P.slx.paidHold = () => true;
  if (opt.br) {
    P.slx.br = { mode: () => 'watch' };
    P.slx.brAuth = () => ({ br: 1, watch: 1 });
  }
  if (opt.inactive) P.slx.active = false;
  P.D.slMain = { nick: 'Owen' }; // the name their first Play kept (the card's Play again reads it)
  const hold = new P.El(P.doc, 'button');
  hold.className = 'slx-hold';
  P.doc.body.appendChild(hold);
  P.doc.querySelector = (sel) => (sel === '.slx-hold' ? hold : null);
  // the empty table the bar shows (public/js/shared/dsEmptyArena.js), recorded
  const emptyMap = [];
  P.win.DSEmptyArena = { show: (x) => emptyMap.push(['show', x.game, x.stake, x.bare]), hide: () => emptyMap.push(['hide']) };
  P.load('dsEnd.js');
  P.load('slxWatch.js');
  if (opt.main !== false) P.load('slxMain.js');
  if (opt.card !== false) P.load('slxCard.js');
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'shared', 'dsWatchBar.js'), 'utf8');
  vm.runInContext(src, P.win, { filename: 'dsWatchBar.js' });
  P.raf(1);
  // slxMain's own Play at boot (a Spectate page watches at once, in the lobby's frame or not): kept apart, so every
  // test below counts only the Plays that came after it
  const bootPlays = P.plays.splice(0);
  return Object.assign(P, { ss, ends, posted, hold, emptyMap, bootPlays, bar: () => P.win.DSWatchBar.state() });
}

test('a paid rung: dsWatchStake goes out as watchStake (and nothing else of money); taken out with the mark', () => {
  const P = watchPage({ session: { dsWatch: 'snake', dsWatchStake: '1', playerName: 'Owen' } });
  assert.deepStrictEqual(P.ss.keys(), ['playerName'], 'both marks taken out at boot');
  assert.strictEqual(JSON.stringify(P.slx.watchAuth()), '{"watch":1,"watchStake":1}');
  for (const bad of ['0', '-1', 'x', '']) {
    const Q = watchPage({ session: { dsWatch: 'snake', dsWatchStake: bad } });
    assert.strictEqual(JSON.stringify(Q.slx.watchAuth()), '{"watch":1}', 'no stake for ' + JSON.stringify(bad));
  }
});

// A life on screen, watching snake id under name.
function live(P, id, name) {
  P.slx.fire('open');
  P.S.connected = true;
  P.S.playing = true;
  P.S.dead_mtm = -1;
  P.slx.fire('x:watch', { t: 'watch', id, name });
  P.raf(1);
}

// Their close of a life (slxNet fires 'close', their applyClose follows and starts their death hold).
function closeLife(P, info) {
  P.slx.fire('close', Object.assign({ playing: true, opened: true, sawDead: false, refused: null }, info || {}));
  P.S.connected = false;
  P.S.playing = false;
  P.S.dead_mtm = P.clock.now;
}

function one(P, cls) {
  const list = P.find(cls);
  assert.strictEqual(list.length, 1, cls);
  return list[0];
}

// The bar's previous and next buttons, in its order.
function arrows(P) {
  const r = P.find('dsw-round');
  assert.strictEqual(r.length, 2);
  return { prev: r[0], next: r[1] };
}

// The card's state with its lines as an array of this realm (the page runs in a vm context).
function card(P) {
  const s = P.slx.card.state();
  return Object.assign({}, s, { lines: Array.from(s.lines) });
}

// An event the fake page dispatches, with stopImmediatePropagation (the page's own events lack it).
function ev(extra) {
  return Object.assign({ stopImmediatePropagation() { this.stopped = true; } }, extra || {});
}

test('the mark: read once and taken out; Spectate only for dsWatch = snake on a free page', () => {
  const P = watchPage();
  assert.strictEqual(P.ss.getItem('dsWatch'), null, 'taken out at boot');
  assert.deepStrictEqual(P.ss.keys(), ['playerName']);
  assert.strictEqual(typeof P.slx.watchAuth, 'function');
  assert.strictEqual(P.slx.watch.state().on, true);
  assert.strictEqual(P.bar().on, true, 'the shared bar is open from boot');
  assert.strictEqual(P.bar().busy, true, 'its arrows off until a life is on screen');
  one(P, 'dsw-lobby');
  one(P, 'dsw-switch');
  assert.strictEqual(P.find('slx-watch-bar').length + P.find('slx-watch-lobby').length, 0, 'no controls of its own');
  for (const [name, o] of [['no mark', { session: {} }], ['another game', { session: { dsWatch: 'agar' } }],
    ['a paid page', { paidOn: true }], ['a page slxPaid holds', { paidHold: true }], ['the event\'s page', { br: true }]]) {
    const Q = watchPage(Object.assign({ main: false, card: false }, o));
    assert.strictEqual(Q.ss.getItem('dsWatch'), null, name + ': the mark is gone either way');
    assert.strictEqual(Q.slx.watchAuth, undefined, name);
    assert.strictEqual(Q.slx.watch, undefined, name);
    assert.strictEqual(Q.slx.cardLines, undefined, name);
    assert.strictEqual(Q.slx.beforeAgain, undefined, name);
    assert.strictEqual(Q.bar().on, false, name + ': no bar');
    assert.strictEqual(Q.find('dsw-switch').length, 0, name);
    assert.strictEqual(Q.win.listeners.length, 0, name + ': no listener');
    assert.strictEqual(Q.rafCount(), 0, name + ': no frame');
  }
  const H = watchPage({ inactive: true, main: false, card: false });
  assert.strictEqual(H.ss.getItem('dsWatch'), 'snake', 'under a harness transport nothing is read');
  assert.strictEqual(H.slx.watchAuth, undefined);
});

test('a Spectate page watches at once, outside the lobby\'s frame too (the card\'s Spectate on a direct visit)', () => {
  // bug sweep 2026-10-31: on a direct /sl visit the card's Spectate reopened the page with the bar on "Finding a
  // player" and the direct-visit name box, whose Play could only watch; nothing started until it was pressed
  const P = watchPage({ session: { dsWatch: 'snake' } });
  assert.strictEqual(P.slx.inLobby, false, 'not in the lobby frame');
  assert.deepStrictEqual(P.bootPlays, [''], 'their Play once at boot: no name to ask for');
  // their login layer, where the direct-visit panel goes (public/sl.html #login)
  const login = (Q) => { const e = new Q.El(Q.doc, 'div'); e.setAttribute('id', 'login'); Q.doc.body.appendChild(e); };
  const D = watchPage({ session: { dsWatch: 'snake' }, main: true, card: false });
  login(D);
  D.load('slxDirect.js');
  assert.strictEqual(D.slx.direct, undefined, 'no name box or Play on a Spectate page');
  assert.strictEqual(D.find('slx-direct').length, 0);
  // a plain direct visit keeps its name box and plays nothing by itself
  const F = watchPage({ session: {} });
  assert.deepStrictEqual(F.bootPlays, []);
  login(F);
  F.load('slxDirect.js');
  assert.ok(F.slx.direct && F.slx.direct.play, 'the name box and Play');
  assert.deepStrictEqual(F.plays, []);
});

test('the handshake: watch 1 merged by slxMain with the cv; after for the life Next opens, before for Previous', () => {
  const P = watchPage({ local: { 'duel.sl.skin': '12' } });
  assert.strictEqual(JSON.stringify(P.slx.auth()), '{"cv":12,"watch":1}');
  live(P, 7, 'Big Bot');
  assert.strictEqual(P.slx.watch.next(), true);
  assert.strictEqual(JSON.stringify(P.slx.auth()), '{"cv":12,"watch":1,"after":7}');
  live(P, 9, 'Mid');
  assert.strictEqual(JSON.stringify(P.slx.auth()), '{"cv":12,"watch":1}', 'that socket carried it');
  assert.strictEqual(P.slx.watch.prev(), true);
  assert.strictEqual(JSON.stringify(P.slx.auth()), '{"cv":12,"watch":1,"before":9}');
  P.slx.fire('open');
  assert.strictEqual(JSON.stringify(P.slx.auth()), '{"cv":12,"watch":1}');
  assert.ok(!/stake|entry|paid|wallet|idProof|resume/i.test(JSON.stringify(P.slx.watchAuth())));
});

test('the bar: the watched name as text, arrows only while a life is on screen, busy while switching', () => {
  const P = watchPage({ framed: true });
  live(P, 7, '<b>Big</b>');
  assert.deepStrictEqual([P.bar().text, P.bar().busy, P.bar().empty], ['<b>Big</b>', false, false]);
  assert.strictEqual(one(P, 'dsw-name').textContent, '<b>Big</b>');
  assert.strictEqual(arrows(P).next.disabled, false);
  assert.strictEqual(P.slx.watch.state().shown, true);
  P.slx.fire('x:watch', { t: 'watch', id: 8, name: '' });
  P.raf(1);
  assert.strictEqual(P.bar().text, 'Unnamed');
  P.S.dead_mtm = P.clock.now; // their death hold
  P.raf(1);
  assert.strictEqual(P.bar().busy, true, 'no switch while dying');
  assert.strictEqual(arrows(P).prev.disabled, true);
  P.S.dead_mtm = -1;
  P.raf(1);
  assert.strictEqual(P.bar().busy, false);
  assert.strictEqual(P.bar().on, true);
});

test('Next and Previous: one end of this life per press, through the arrows and the keys', () => {
  const P = watchPage();
  assert.strictEqual(P.slx.watch.next(), false, 'nothing watched yet');
  live(P, 7, 'Big Bot');
  P.dispatch(arrows(P).next, 'click', {});
  assert.strictEqual(P.ends.length, 1, 'the arrow ends the life');
  assert.deepStrictEqual([P.slx.watch.state().after, P.slx.watch.state().switching], [7, true]);
  P.raf(1);
  assert.strictEqual(P.bar().busy, true);
  P.dispatch(arrows(P).next, 'click', {});
  assert.strictEqual(P.slx.watch.next(), false, 'once per life');
  assert.strictEqual(P.slx.watch.prev(), false);
  assert.strictEqual(P.ends.length, 1);
  // Previous: the arrow, then the keys (Left, Right, Space reach the bar; the game never sees them)
  live(P, 9, 'Mid');
  P.dispatch(arrows(P).prev, 'click', {});
  assert.deepStrictEqual([P.ends.length, P.slx.watch.state().before, P.slx.watch.state().after], [2, 9, 0]);
  const seen = [];
  P.doc.onkeydown = (e) => seen.push(e.key);
  for (const [key, keyCode, side] of [['ArrowLeft', 37, 'before'], ['ArrowRight', 39, 'after'], [' ', 32, 'after']]) {
    live(P, 11, 'Small');
    P.dispatch(P.doc.body, 'keydown', ev({ key, keyCode }));
    assert.strictEqual(P.slx.watch.state()[side], 11, key);
  }
  assert.strictEqual(P.ends.length, 5);
  assert.deepStrictEqual(seen, [], 'none of them reached their keys');
  // not while their death runs (the life is ending anyway)
  const R = watchPage();
  live(R, 7, 'Big Bot');
  R.S.dead_mtm = R.clock.now;
  assert.strictEqual(R.slx.watch.next(), false);
  assert.strictEqual(R.ends.length, 0);
  // a socket that was already gone: nothing changes
  const Q = watchPage({ endLife: false });
  live(Q, 9, 'Mid');
  assert.strictEqual(Q.slx.watch.prev(), false);
  assert.deepStrictEqual([Q.slx.watch.state().before, Q.slx.watch.state().switching], [0, false]);
});

test('instant switch: the next life starts the moment their close has run, with no death hold, menu or card', () => {
  const P = watchPage();
  live(P, 7, 'Big Bot');
  assert.strictEqual(P.slx.watch.next(), true);
  closeLife(P);
  assert.notStrictEqual(P.S.dead_mtm, -1, 'their close started their death hold');
  P.raf(1, 1);
  assert.strictEqual(P.S.dead_mtm, -1, 'cut at once');
  assert.deepStrictEqual(P.plays, ['Owen'], 'their Play, under the name the first Play used');
  assert.strictEqual(P.slx.card.state().kind, '', 'no card');
  assert.strictEqual(P.slx.watch.state().quicks, 1);
  assert.strictEqual(P.slx.watchAuth().after, 7, 'the new socket asks for the snake after it');
  live(P, 9, 'Mid Bot');
  assert.strictEqual(P.bar().text, 'Mid Bot');
  // their menu already up (a slow page): the card's way instead
  assert.strictEqual(P.slx.watch.next(), true);
  P.slx.fire('menuShow');
  closeLife(P);
  P.raf(1, 1);
  assert.strictEqual(P.plays.length, 1);
});

test('a watched snake that dies: its death stays on screen, then the leader with no card', () => {
  const P = watchPage();
  live(P, 7, 'Big Bot');
  P.slx.fire('ownDead', { type: 'dead', code: 0 });
  P.S.dead_mtm = P.clock.now;
  P.raf(70, 16);
  assert.strictEqual(P.ends.length, 0, 'not before 1.2 s');
  P.raf(5, 16);
  assert.strictEqual(P.ends.length, 1, 'then this life ends from the page');
  closeLife(P, { sawDead: true });
  P.raf(1, 1);
  assert.deepStrictEqual(P.plays, ['Owen']);
  assert.strictEqual(P.slx.card.state().kind, '');
  assert.strictEqual(JSON.stringify(P.slx.watchAuth()), '{"watch":1}', 'the leader next');
  // the server let the socket go first: the next life starts then, and the death timer does nothing more
  live(P, 9, 'Mid');
  P.slx.fire('ownDead', { type: 'dead', code: 0 });
  closeLife(P, { sawDead: true });
  P.raf(100, 16);
  assert.deepStrictEqual([P.plays.length, P.ends.length], [2, 1]);
});

test('a tap or click on the bar is the bar\'s: never swallowed as steering, never prevented; Lobby goes', () => {
  const P = watchPage({ framed: true });
  live(P, 7, 'Big');
  let theirs = 0;
  P.win.onmousedown = () => { theirs++; };
  P.win.ontouchstart = () => { theirs++; };
  // what comes after the layer's swallow on window (slxTouch's capture listeners) never hears it either: the press is
  // stopped there (the fake page runs every listener of one node, so the stop itself is what is checked)
  let stops = 0;
  const stopped = () => ev({ stopImmediatePropagation() { this.stopped = true; stops++; } });
  const sw = one(P, 'dsw-switch');
  P.dispatch(sw, 'mousedown', stopped());
  assert.strictEqual(P.dispatch(arrows(P).next, 'touchstart', stopped()), true, 'not prevented: the tap becomes a click');
  assert.strictEqual(P.dispatch(arrows(P).prev, 'touchmove', stopped()), true);
  // (the fake page's dispatch now counts its own stop: what matters is that nothing after the layer heard the press)
  assert.strictEqual(theirs, 0, 'no game handler heard a press on the bar');
  void stops;
  // a touch on the game is taken and prevented
  assert.strictEqual(P.dispatch(P.doc.body, 'touchstart', ev()), false);
  P.dispatch(one(P, 'dsw-lobby'), 'click', {});
  assert.deepStrictEqual(P.posted, [['game:done', 'https://duelseries.com']]);
  P.raf(1);
  assert.strictEqual(P.bar().on, false, 'the bar closes for the lobby');
});

test('inputs: mouse, touch, wheel and the boost, turn, Q and T keys on the game are swallowed while live', () => {
  const P = watchPage();
  const seen = [];
  for (const k of ['onmousemove', 'onmousedown', 'ontouchstart', 'ontouchmove', 'onwheel']) P.win[k] = () => seen.push(k);
  P.doc.onkeydown = (e) => seen.push('key ' + e.keyCode);
  const body = P.doc.body;
  const fireAll = () => {
    seen.length = 0;
    for (const t of ['mousemove', 'mousedown', 'touchstart', 'touchmove', 'wheel']) P.dispatch(body, t, ev());
    for (const code of [32, 37, 38, 39, 40, 81, 84, 65]) P.dispatch(body, 'keydown', ev({ keyCode: code }));
    return seen.slice();
  };
  assert.strictEqual(fireAll().length, 13, 'the menu (no socket): all theirs');
  live(P, 7, 'Big Bot');
  assert.deepStrictEqual(fireAll(), ['key 65'], 'live: only a key that steers nothing');
  assert.strictEqual(P.dispatch(body, 'touchstart', ev()), false, 'a touch on the game is prevented');
  // the results card (the shared one, marked slx-card by slxCard) is a layer control: a press there is its own, even
  // with a socket up (a Try again connecting while the card still shows)
  P.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'full' });
  P.S.connected = true;
  const lobby = P.button('lobby');
  assert.ok(lobby && /\bslx-card\b/.test(one(P, 'dse').className), 'the card is up, as ours');
  let presses = 0;
  lobby.addEventListener('mousedown', () => { presses++; });
  lobby.addEventListener('touchstart', () => { presses++; });
  P.dispatch(lobby, 'mousedown', ev());
  assert.strictEqual(P.dispatch(lobby, 'touchstart', ev()), true, 'a tap on the card is not prevented (its click still comes)');
  assert.strictEqual(presses, 2);
  assert.deepStrictEqual(seen.filter((k) => k !== 'key 65'), [], 'and none of it reached the game');
});

test('the CASH OUT button is hidden on a Spectate page', () => {
  const P = watchPage();
  assert.strictEqual(P.hold.style.visibility, 'hidden');
  live(P, 7, 'Big Bot');
  assert.strictEqual(P.hold.style.visibility, 'hidden');
});

test('a dropped connection keeps the card: Watching, Watch next, no length; the next life starts by itself', () => {
  const P = watchPage();
  live(P, 11, 'Small');
  P.S.lastscore.innerHTML = '<span style="opacity: .45;">Your final length was </span><b>4321</b>';
  closeLife(P);
  P.raf(1, 1);
  assert.deepStrictEqual(P.plays, [], 'no quick start for a drop');
  P.slx.fire('menuShow');
  const c = card(P);
  assert.deepStrictEqual([c.kind, c.title, c.again, c.length, c.lines],
    ['lost', 'Watching', 'Watch next', '', ['The connection dropped. Watching again.']]);
  P.raf(50, 16);
  assert.deepStrictEqual(P.plays, [], 'not before 900 ms');
  P.raf(10, 16);
  assert.deepStrictEqual(P.plays, ['Owen']);
  assert.strictEqual(P.slx.card.state().again, 'Starting');
  assert.strictEqual(P.bar().on, true, 'the bar stays, its arrows off');
  assert.strictEqual(P.bar().busy, true);
  // that connect fails: no life, so the card's own words, and nothing starts by itself
  const plays = P.plays.length;
  P.slx.fire('close', { playing: false, opened: false, sawDead: false, refused: null });
  const d = card(P);
  assert.deepStrictEqual([d.kind, d.title, d.again, d.lines], ['lost', 'Connection lost', 'Try again', []]);
  P.raf(400, 16);
  assert.strictEqual(P.plays.length, plays);
});

test('nobody to watch: the bar\'s empty table, asked again every few seconds while the page is visible', () => {
  const P = watchPage({ session: { dsWatch: 'snake', dsWatchStake: '0.5' } });
  P.slx.fire('open');
  P.slx.fire('x:refused', { t: 'refused', why: 'nobody' });
  P.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'nobody' });
  P.raf(1);
  assert.deepStrictEqual([P.bar().on, P.bar().empty, P.bar().text], [true, true, 'Nobody is playing yet']);
  assert.deepStrictEqual(P.emptyMap[P.emptyMap.length - 1], ['show', 'snake', 0.5, true], 'the whole map, bare');
  assert.strictEqual(P.slx.watch.state().retrying, true);
  P.raf(180, 16);
  assert.deepStrictEqual(P.plays, [], 'not before 3 s');
  P.raf(10, 16);
  assert.deepStrictEqual(P.plays, ['Owen']);
  // nobody again, the tab hidden: no ask until it shows
  P.slx.fire('open');
  P.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'nobody' });
  P.doc.hidden = true;
  P.raf(400, 16);
  assert.strictEqual(P.plays.length, 1, 'no socket for a hidden tab');
  P.doc.hidden = false;
  P.raf(200, 16);
  assert.strictEqual(P.plays.length, 2);
  // somebody came: the name, the map hidden
  live(P, 4, 'Payer');
  assert.deepStrictEqual([P.bar().empty, P.bar().text, P.bar().busy], [false, 'Payer', false]);
  assert.deepStrictEqual(P.emptyMap[P.emptyMap.length - 1], ['hide']);
  // full: the card's words, no auto ask, never the empty table
  P.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'full' });
  const c = card(P);
  assert.deepStrictEqual([c.title, c.again], ['Too many people watching', 'Try again']);
  P.raf(400, 16);
  assert.strictEqual(P.plays.length, 2);
  assert.strictEqual(P.bar().empty, false);
});

test('Lobby stops the next life starting by itself', () => {
  const P = watchPage({ framed: true });
  live(P, 7, 'Big Bot');
  P.dispatch(one(P, 'dsw-lobby'), 'click', {});
  P.slx.fire('ownDead', { type: 'dead', code: 0 });
  closeLife(P, { sawDead: true });
  P.slx.fire('menuShow');
  P.raf(100, 16);
  assert.deepStrictEqual(P.plays, []);
  assert.strictEqual(P.ends.length, 0);
  P.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'nobody' });
  P.raf(300, 16);
  assert.deepStrictEqual(P.plays, []);
  assert.strictEqual(P.bar().on, false);
});

// The results card's Spectate (slxCard, Owen 2026-10-16) on a page that is not watching: the lobby's own Spectate,
// done from the page (public/js/v2/play.js spectate): the mark, the rung or none, /sl again; nothing else written.
test('watchOpen: on any page, reopens /sl watching with the lobby keys; never a stake or a token', () => {
  const P = watchPage({ session: { playerName: 'Owen', region: 'na' } });
  assert.strictEqual(P.slx.watch, undefined, 'no mark: a plain page');
  assert.strictEqual(P.slx.watchOpen(0), true);
  assert.deepStrictEqual(P.ss.keys(), ['dsWatch', 'playerName', 'region']);
  assert.strictEqual(P.ss.getItem('dsWatch'), 'snake');
  assert.deepStrictEqual([P.win.location.replaced, P.win.location.assigned], [['/sl'], []], 'in place of this page');
  for (const [stake, kept] of [[0.5, '0.5'], [1, '1'], [-1, null], [NaN, null], ['x', null]]) {
    const Q = watchPage({ session: { playerName: 'Owen' } });
    Q.ss.setItem('dsWatchStake', '9');                 // a stale rung mark
    Q.slx.watchOpen(stake);
    assert.strictEqual(Q.ss.getItem('dsWatchStake'), kept, String(stake));
    assert.deepStrictEqual(Q.ss.keys(), ['dsWatch', 'playerName'].concat(kept ? ['dsWatchStake'] : []).sort(), String(stake) + ': never stake');
  }
  // no storage: nothing is opened (the page could only play)
  const N = watchPage({ session: {} });
  N.win.sessionStorage = { getItem() { return null; }, setItem() { throw new Error('quota'); }, removeItem() {} };
  assert.strictEqual(N.slx.watchOpen(0), false);
  assert.deepStrictEqual(N.win.location.replaced, []);
  // a location with assign only
  const A = watchPage({ session: {} });
  A.win.location = { assigned: [], assign(u) { this.assigned.push(String(u)); } };
  assert.strictEqual(A.slx.watchOpen(0), true);
  assert.deepStrictEqual(A.win.location.assigned, ['/sl']);
});
