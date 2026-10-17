'use strict';
// slxBr's watcher, ACTIVE, on its own fake page (test/slxHudFakes.js): the battle royale's Spectate wears the shared
// Spectate bar (public/js/shared/dsWatchBar.js, loaded after the layer as server/sl/slBoot.js loads it). The server
// side (people first, after and before) is test/slBr.test.js.
//
// Checks: the bar opens on a watch page and stays closed on a player's; the handshake carries after or before for the
// life a switch opens; Previous and Next end the life once and the next starts the moment their close has run, with
// no card; a watched snake's death stays DEATH_MS, then the next; a decided match keeps its card; nothing alive is the
// empty table, asked again as a watcher; out of a running match the card's Watch opens the bar, a Play closes it; a tap
// on the bar is never prevented; Lobby closes the bar.
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
    removeItem: (k) => { delete m[k]; }
  };
}

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

function brPage(mode) {
  const posted = [];
  const win = {
    sessionStorage: store({ slBr: mode || 'watch' }),
    localStorage: store(),
    setInterval: () => 0,
    parent: { postMessage: (m, origin) => posted.push([m, origin]) },
    location: { origin: 'https://duelseries.com', assigned: [], assign(u) { this.assigned.push(String(u)); } }
  };
  const P = makePage({ win, S: { dead_mtm: -1 } });
  classList(P.El);
  const ends = [];
  P.slx.endLife = () => { ends.push(P.clock.now); return true; };
  P.D.slMain = { nick: 'Owen' };
  P.doc.querySelector = () => null;
  P.win.DSEmptyArena = { show() {}, hide() {} };
  P.load('dsEnd.js');
  P.load('slxBr.js');
  P.load('slxMain.js');
  P.load('slxCard.js');
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'shared', 'dsWatchBar.js'), 'utf8'), P.win,
    { filename: 'dsWatchBar.js' });
  P.raf(1);
  return Object.assign(P, { ends, posted, bar: () => P.win.DSWatchBar.state() });
}

function live(P, id, name, state) {
  P.slx.fire('open');
  P.S.connected = true;
  P.S.playing = true;
  P.S.dead_mtm = -1;
  P.slx.fire('x:br', { t: 'br', state: state || 'running', phase: 'holding', alive: 5 });
  if (id) P.slx.fire('x:watch', { t: 'watch', id, name });
  P.raf(1);
}

function closeLife(P, info) {
  P.slx.fire('close', Object.assign({ playing: true, opened: true, sawDead: false, refused: null }, info || {}));
  P.S.connected = false;
  P.S.playing = false;
  P.S.dead_mtm = P.clock.now;
}

function arrows(P) {
  const r = P.find('dsw-round');
  assert.strictEqual(r.length, 2);
  return { prev: r[0], next: r[1] };
}

test('a watch page wears the bar from boot; a player\'s page never shows it; no Lobby of its own', () => {
  const P = brPage('watch');
  assert.deepStrictEqual([P.bar().on, P.bar().busy], [true, true]);
  assert.strictEqual(P.find('slx-br-lobby').length, 0);
  live(P, 7, 'Ann');
  assert.deepStrictEqual([P.bar().text, P.bar().busy], ['Ann', false]);
  const Q = brPage('play');
  live(Q, 0);
  assert.strictEqual(Q.bar().on, false);
});

test('Previous and Next: after or before in the handshake, one end per press, the next life at once with no card', () => {
  const P = brPage('watch');
  live(P, 7, 'Ann');
  P.dispatch(arrows(P).next, 'click', {});
  assert.strictEqual(P.ends.length, 1);
  assert.strictEqual(JSON.stringify(P.slx.brAuth()), JSON.stringify({ br: 1, watch: 1, after: 7 }));
  P.dispatch(arrows(P).next, 'click', {});
  assert.strictEqual(P.ends.length, 1, 'once per life');
  closeLife(P);
  P.raf(1, 1);
  assert.deepStrictEqual([P.S.dead_mtm, Array.from(P.plays)], [-1, ['Owen']], 'their death hold cut, their Play at once');
  assert.strictEqual(P.slx.card.state().kind, '');
  live(P, 9, 'Ben');
  assert.strictEqual(JSON.stringify(P.slx.brAuth()), JSON.stringify({ br: 1, watch: 1 }), 'that socket carried it');
  P.dispatch(arrows(P).prev, 'click', {});
  assert.strictEqual(JSON.stringify(P.slx.brAuth()), JSON.stringify({ br: 1, watch: 1, before: 9 }));
  // the keys
  live(P, 11, 'Cat');
  P.dispatch(P.doc.body, 'keydown', { key: 'ArrowRight', keyCode: 39, stopImmediatePropagation() {} });
  assert.strictEqual(JSON.stringify(P.slx.brAuth()), JSON.stringify({ br: 1, watch: 1, after: 11 }));
  // a tap on the bar is never prevented (slxTouch would otherwise take it as steering)
  live(P, 12, 'Dee');
  assert.strictEqual(P.dispatch(arrows(P).next, 'touchstart', { stopImmediatePropagation() {} }), true);
  assert.strictEqual(P.dispatch(P.doc.body, 'touchstart', { stopImmediatePropagation() {} }), false, 'the game is');
});

test('a watched snake that dies: its death on screen, then the next; a decided match keeps its card', () => {
  const P = brPage('watch');
  live(P, 7, 'Ann');
  P.slx.fire('ownDead', { type: 'dead', code: 0 });
  P.S.dead_mtm = P.clock.now;
  P.raf(70, 16);
  assert.strictEqual(P.ends.length, 0);
  P.raf(5, 16);
  assert.strictEqual(P.ends.length, 1);
  closeLife(P, { sawDead: true });
  P.raf(1, 1);
  assert.deepStrictEqual(P.plays, ['Owen']);
  // the match is decided: no switch, the card (the podium) as before
  live(P, 9, 'Ben', 'running');
  P.slx.fire('x:br', { t: 'br', state: 'over', winner: { id: 9, name: 'Ben' }, podium: [{ name: 'Ben' }] });
  P.slx.fire('ownDead', { type: 'dead', code: 0 });
  P.raf(100, 16);
  assert.strictEqual(P.ends.length, 1, 'no end from the page');
  assert.strictEqual(P.plays.length, 1);
});

test('nothing alive: the empty table, asked again as a watcher; the card\'s Watch opens the bar, a Play closes it', () => {
  const P = brPage('watch');
  P.slx.fire('open');
  P.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'nobody' });
  P.raf(1);
  assert.deepStrictEqual([P.bar().empty, P.bar().text], [true, 'Nobody is playing yet']);
  P.raf(190, 16);
  assert.deepStrictEqual(P.plays, ['Owen'], 'asked again after 3 s');
  assert.strictEqual(P.slx.br.mode(), 'watch', 'still a watcher');
  // a player out of a running match: the card's Watch makes the page a watcher and the bar opens
  const Q = brPage('play');
  live(Q, 0);
  Q.slx.fire('ownDead', { type: 'dead', code: 0 });
  closeLife(Q, { sawDead: true });
  Q.slx.fire('menuShow');
  // the card's Spectate watches this match here (slxCard spectate, slxBr beforeWatch)
  Q.slx.card.spectate();
  Q.raf(1);
  assert.deepStrictEqual([Q.slx.br.mode(), Q.bar().on], ['watch', true]);
  // between matches the card's Play makes it a player again: the bar closes
  live(Q, 7, 'Ann', 'waiting');
  Q.slx.fire('x:br', { t: 'br', state: 'waiting', alive: 3 });
  Q.slx.fire('close', { playing: false, opened: false, sawDead: false, refused: null });
  Q.slx.card.playAgain();
  Q.raf(1);
  assert.deepStrictEqual([Q.slx.br.mode(), Q.bar().on], ['play', false]);
});

test('Lobby: the bar closes and the page goes back to the lobby', () => {
  const P = brPage('watch');
  live(P, 7, 'Ann');
  P.dispatch(P.find('dsw-lobby')[0], 'click', {});
  assert.deepStrictEqual(P.posted, [['game:done', 'https://duelseries.com']]);
  P.raf(1);
  assert.strictEqual(P.bar().on, false);
  P.slx.fire('ownDead', { type: 'dead', code: 0 });
  P.raf(100, 16);
  assert.strictEqual(P.ends.length, 0);
});
