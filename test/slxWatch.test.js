'use strict';
// slxWatch, ACTIVE: Spectate in the free room on its own fake page (test/slxHudFakes.js; never the gate's page, where
// the layer stays inert, test/slxNoTouch.test.js). Loaded as the composed page loads it: slxWatch, then the real
// slxMain (the handshake merge, guard, toLobby) and the real slxCard (the card hooks). The server side is
// test/slWatchFree.test.js; slxNet's endLife is test/slxNet.test.js.
//
// Checks: the lobby's mark is read once and removed, and the file is inert without it, on a paid page, a page slxPaid
// holds, the battle royale's page and under a harness transport; the handshake; Next (button and debug state) ends
// the life once and asks for the snake after it; the controls show only while a life is on screen and never let a tap
// through; every steering, boost, hold and chat input on the game is swallowed while live; the CASH OUT button hides;
// the card between lives (Watching, Watch next, no length) and the next life starting by itself; nobody to watch,
// asked again every few seconds while visible; Lobby stops it all.
const test = require('node:test');
const assert = require('node:assert');
const { makePage } = require('./slxHudFakes');

function store(init) {
  const m = Object.assign({}, init || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    keys: () => Object.keys(m).sort()
  };
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
  P.load('slxWatch.js');
  if (opt.main !== false) P.load('slxMain.js');
  if (opt.card !== false) P.load('slxCard.js');
  P.raf(1);
  return Object.assign(P, { ss, ends, posted, hold });
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

// Their close of a life (slxNet fires 'close', their applyClose follows), then their menu 1.6 s later.
function endLife(P, info) {
  P.slx.fire('close', Object.assign({ playing: true, opened: true, sawDead: false, refused: null }, info || {}));
  P.S.connected = false;
  P.S.playing = false;
  P.S.dead_mtm = P.clock.now;
  P.raf(1);
}

function one(P, cls) {
  const list = P.find(cls);
  assert.strictEqual(list.length, 1, cls);
  return list[0];
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
  one(P, 'slx-watch-bar');
  one(P, 'slx-watch-lobby');
  for (const [name, o] of [['no mark', { session: {} }], ['another game', { session: { dsWatch: 'agar' } }],
    ['a paid page', { paidOn: true }], ['a page slxPaid holds', { paidHold: true }], ['the event\'s page', { br: true }]]) {
    const Q = watchPage(Object.assign({ main: false, card: false }, o));
    assert.strictEqual(Q.ss.getItem('dsWatch'), null, name + ': the mark is gone either way');
    assert.strictEqual(Q.slx.watchAuth, undefined, name);
    assert.strictEqual(Q.slx.watch, undefined, name);
    assert.strictEqual(Q.slx.cardLines, undefined, name);
    assert.strictEqual(Q.slx.beforeAgain, undefined, name);
    assert.strictEqual(Q.find('slx-watch-bar').length, 0, name);
    assert.strictEqual(Q.win.listeners.length, 0, name + ': no listener');
    assert.strictEqual(Q.rafCount(), 0, name + ': no frame');
  }
  const H = watchPage({ inactive: true, main: false, card: false });
  assert.strictEqual(H.ss.getItem('dsWatch'), 'snake', 'under a harness transport nothing is read');
  assert.strictEqual(H.slx.watchAuth, undefined);
});

test('the handshake: watch 1 merged by slxMain with the cv; after only for the life Next opens', () => {
  const P = watchPage({ local: { 'duel.sl.skin': '12' } });
  assert.strictEqual(JSON.stringify(P.slx.auth()), '{"cv":12,"watch":1}');
  live(P, 7, 'Big Bot');
  assert.strictEqual(P.slx.watch.next(), true);
  assert.strictEqual(JSON.stringify(P.slx.auth()), '{"cv":12,"watch":1,"after":7}');
  P.slx.fire('open');
  assert.strictEqual(JSON.stringify(P.slx.auth()), '{"cv":12,"watch":1}', 'that socket carried it');
  assert.ok(!/stake|entry|paid|wallet|idProof|resume/i.test(JSON.stringify(P.slx.watchAuth())));
});

test('Next: one end of this life per press, the watched id kept for the next life; the button does the same', () => {
  const P = watchPage();
  const next = one(P, 'slx-watch-next');
  assert.strictEqual(P.slx.watch.next(), false, 'nothing watched yet');
  live(P, 7, 'Big Bot');
  assert.strictEqual(next.disabled, false);
  P.dispatch(next, 'click', {});
  assert.strictEqual(P.ends.length, 1, 'the button ends the life');
  assert.deepStrictEqual([P.slx.watch.state().after, P.slx.watch.state().switching], [7, true]);
  P.raf(1);
  assert.strictEqual(next.disabled, true);
  P.dispatch(next, 'click', {});
  assert.strictEqual(P.slx.watch.next(), false, 'once per life');
  assert.strictEqual(P.ends.length, 1);
  // not while their death runs (the life is ending anyway)
  const R = watchPage();
  live(R, 7, 'Big Bot');
  R.S.dead_mtm = R.clock.now;
  assert.strictEqual(R.slx.watch.next(), false);
  assert.strictEqual(R.ends.length, 0);
  // a socket that was already gone: nothing changes
  const Q = watchPage({ endLife: false });
  live(Q, 9, 'Mid');
  assert.strictEqual(Q.slx.watch.next(), false);
  assert.deepStrictEqual([Q.slx.watch.state().after, Q.slx.watch.state().switching], [0, false]);
});

test('the controls: Lobby and the Watching line only while a life is on screen; the name goes in as text', () => {
  const P = watchPage({ framed: true });
  const bar = one(P, 'slx-watch-bar');
  const lobby = one(P, 'slx-watch-lobby');
  assert.deepStrictEqual([bar.style.display, lobby.style.display], ['none', 'none'], 'before any life');
  live(P, 7, '<b>Big</b>');
  assert.deepStrictEqual([bar.style.display, lobby.style.display], ['flex', 'block']);
  assert.strictEqual(one(P, 'slx-watch-label').textContent, 'Watching <b>Big</b>');
  assert.strictEqual(P.slx.watch.state().shown, true);
  P.slx.fire('x:watch', { t: 'watch', id: 8, name: '' });
  P.raf(1);
  assert.strictEqual(one(P, 'slx-watch-label').textContent, 'Watching a snake');
  P.S.dead_mtm = P.clock.now; // their death hold
  P.raf(1);
  assert.deepStrictEqual([bar.style.display, lobby.style.display], ['none', 'none'], 'not while dying');
  P.S.dead_mtm = -1;
  P.raf(1);
  // a tap on a control never reaches their handlers; Lobby goes back to the lobby
  let theirs = 0;
  P.win.onmousedown = () => { theirs++; };
  P.win.ontouchstart = () => { theirs++; };
  P.dispatch(bar, 'mousedown', ev());
  P.dispatch(one(P, 'slx-watch-next'), 'touchstart', ev());
  assert.strictEqual(theirs, 0);
  P.dispatch(lobby, 'click', {});
  assert.deepStrictEqual(P.posted, [['game:done', 'https://duelseries.com']]);
  P.raf(1);
  assert.strictEqual(lobby.style.display, 'none', 'gone after Lobby');
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
  // the results card is a layer control: a click there is its own
  const again = one(P, 'slx-card-again');
  let clicks = 0;
  again.addEventListener('mousedown', () => { clicks++; });
  P.dispatch(again, 'mousedown', ev());
  assert.strictEqual(clicks, 1);
});

test('the CASH OUT button is hidden on a Spectate page', () => {
  const P = watchPage();
  assert.strictEqual(P.hold.style.visibility, 'hidden');
  live(P, 7, 'Big Bot');
  assert.strictEqual(P.hold.style.visibility, 'hidden');
});

test('between lives: the card says Watching with Watch next and no length; the next life starts by itself', () => {
  const P = watchPage();
  live(P, 7, 'Big Bot');
  P.S.lastscore.innerHTML = '<span style="opacity: .45;">Your final length was </span><b>4321</b>';
  // the watched snake died: their own dead, their death, their menu
  P.slx.fire('ownDead', { type: 'dead', code: 0 });
  endLife(P, { sawDead: true });
  P.slx.fire('menuShow');
  let c = card(P);
  assert.deepStrictEqual([c.kind, c.title, c.again, c.length], ['dead', 'Watching', 'Watch next', '']);
  assert.deepStrictEqual(c.lines, ['Big Bot is out. Watching the leader next.']);
  assert.strictEqual(JSON.stringify(P.slx.watchAuth()), '{"watch":1}', 'the leader next');
  P.raf(50, 16);
  assert.deepStrictEqual(P.plays, [], 'not before 900 ms');
  P.raf(10, 16);
  assert.deepStrictEqual(P.plays, ['Owen'], 'their Play, under the name the first Play used');
  assert.strictEqual(P.slx.card.state().again, 'Starting');
  // Next: the life ends from the page
  live(P, 9, 'Mid Bot');
  assert.strictEqual(P.slx.watch.next(), true);
  endLife(P);
  P.slx.fire('menuShow');
  c = card(P);
  assert.deepStrictEqual([c.title, c.again, c.length, c.lines], ['Watching', 'Watch next', '', ['Finding the next snake.']]);
  assert.strictEqual(P.slx.watchAuth().after, 9);
  // the card's own button is the same start, sooner; the timer then does nothing more
  P.slx.card.playAgain();
  assert.strictEqual(P.plays.length, 2);
  P.raf(80, 16);
  assert.strictEqual(P.plays.length, 2);
  // a dropped connection
  live(P, 11, 'Small');
  endLife(P);
  P.slx.fire('menuShow');
  assert.deepStrictEqual(card(P).lines, ['The connection dropped. Watching again.']);
  P.raf(60, 16);
  assert.strictEqual(P.plays.length, 3, 'watching again by itself');
  // that connect fails: no life, so the card's own words, and nothing starts by itself
  const plays = P.plays.length;
  P.slx.fire('close', { playing: false, opened: false, sawDead: false, refused: null });
  c = card(P);
  assert.deepStrictEqual([c.kind, c.title, c.again, c.lines], ['lost', 'Connection lost', 'Try again', []]);
  P.raf(400, 16);
  assert.strictEqual(P.plays.length, plays);
});

test('nobody to watch: the card says so and asks again every few seconds while the page is visible', () => {
  const P = watchPage();
  P.slx.fire('open');
  P.slx.fire('x:refused', { t: 'refused', why: 'nobody' });
  P.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'nobody' });
  let c = card(P);
  assert.deepStrictEqual([c.kind, c.title, c.again, c.length, c.lines],
    ['nobody', 'Nobody to watch right now', 'Try again', '', ['Trying again in a few seconds.']]);
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
  // full: its own words, no auto ask
  P.slx.fire('open');
  P.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'full' });
  c = card(P);
  assert.deepStrictEqual([c.title, c.again], ['Too many people watching', 'Try again']);
  P.raf(400, 16);
  assert.strictEqual(P.plays.length, 2);
});

test('Lobby stops the next life starting by itself', () => {
  const P = watchPage({ framed: true });
  live(P, 7, 'Big Bot');
  P.dispatch(one(P, 'slx-watch-lobby'), 'click', {});
  endLife(P, { sawDead: true });
  P.slx.fire('menuShow');
  P.raf(100, 16);
  assert.deepStrictEqual(P.plays, []);
  P.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'nobody' });
  P.raf(300, 16);
  assert.deepStrictEqual(P.plays, []);
});
