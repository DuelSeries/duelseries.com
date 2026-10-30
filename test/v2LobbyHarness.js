'use strict';
// The v2 lobby in a box, shared by test/v2route.test.js and test/slPaidLobby.test.js. Nothing here is a test; node
// --test loads it and finds none. Moved out of v2route.test.js unchanged but for two lines (task T7): the window has
// webcrypto for the widget's launch nonce, and the context also exposes launchStaked (the page a paid round opens).
//
// lobbyHarness(liveRows) -> { win, el, fetched, plays, pending }
//   liveRows   the /api/live lobbies (null: the poll fails)
//   opts.paidDoors  the /api/live paidDoors ({ knockout: true, ... }; left out: the answer has none)
//   plays      every { game, sel } the widget's duel:play listener handed to the stake path
//   pending()  that stake path's promise (the stub server refuses every quote: 'no server here')
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* A lobby in a box: board.js and play.js as the page loads them, plus the
   widget's own launch code cut from main.jsx (the duel:play listener and
   stakeAndPlay), all on one stub window. No browser, no React, no Privy. */
function lobbyHarness(liveRows, opts) {
  const o = opts || {};
  const els = {};
  const el = id => (els[id] = els[id] || {
    id, value: '', hidden: false, readOnly: true, textContent: '', innerHTML: '', src: '',
    style: { display: '' }, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, focus() {}, blur() {}, select() {}, setAttribute() {},
    contentWindow: { focus() {}, postMessage() {} },
  });
  const store = () => {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
             removeItem: k => m.delete(k) };
  };
  const on = {};
  const fetched = [];
  const plays = [];
  let pending = null;
  const win = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: store(), sessionStorage: store(),
    document: { getElementById: el, addEventListener() {},
                body: { classList: { add() {}, remove() {} } } },
    addEventListener(t, fn) { (on[t] = on[t] || []).push(fn); },
    dispatchEvent(e) { (on[e.type] || []).forEach(fn => fn(e)); return true; },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: () => 0,
    alert() {},
    fetch: async url => {
      fetched.push(String(url));
      if (url === '/api/live') {
        if (!liveRows) throw new Error('offline');
        return { json: async () => Object.assign({ lobbies: liveRows, extras: [] },
          o.paidDoors ? { paidDoors: o.paidDoors } : {}, o.soon ? { soon: o.soon } : {}) };
      }
      throw new Error('no server here for ' + url);
    },
    duelWallet: { authenticated: true, address: 'WALLET1' },
    rememberStake() {},
    DS_LADDER: require(path.join(ROOT, 'shared/stakeLadder.js')),   // the lobby loads it from /shared
    crypto: require('crypto').webcrypto,   // the widget's launch nonce (launchNonce)
  };
  win.window = win;
  const wallet = { address: 'WALLET1' };
  win.stakeRef = { current: (game, sel) => {
    plays.push({ game, sel });
    pending = win.stakeAndPlay(game, sel, wallet,
      () => { throw new Error('Free never signs'); }, () => {}, () => {});
    return pending;
  } };
  vm.createContext(win);
  const widget = fs.readFileSync(path.join(ROOT, 'wallet-widget/src/main.jsx'), 'utf8');
  // The widget's plain modules first, as its imports (they have none of their own).
  for (const m of ['stakeRoute.mjs', 'restakeBridge.mjs', 'solReserve.mjs']) {
    if (!widget.includes("from './" + m + "'")) continue;
    const f = 'wallet-widget/src/' + m;
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^export /gm, ''), win, { filename: f });
  }
  let a = widget.indexOf('function lobbyRegion()');
  if (a < 0) a = widget.indexOf('const SERVER_URLS = '); // the widget before stakeRoute.mjs
  const b = widget.indexOf('// Self-custody Cash Out');
  const c = widget.indexOf('const onPlay = (e) => {');
  const d = widget.indexOf("window.addEventListener('duel:play', onPlay);", c);
  assert.ok(a > -1 && b > a && c > -1 && d > c, 'the widget launch code is where this test cuts it');
  vm.runInContext(widget.slice(a, b) + '\nthis.stakeAndPlay = stakeAndPlay;\nthis.launchStaked = launchStaked;\n' +
                  widget.slice(c, d) + "\nwindow.addEventListener('duel:play', onPlay);\n", win);
  for (const f of ['public/js/v2/board.js', 'public/js/v2/play.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), win, { filename: f });
  el('play-name').value = 'Tester';
  return { win, el, fetched, plays, pending: () => pending };
}

module.exports = { lobbyHarness };
