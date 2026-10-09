'use strict';
// STATUS "BEFORE PAPER_PAID IS SWITCHED ON" item 3 (night queue item 5): the wallet widget's
// in-game restake posted duel:restake:done into whatever frame it found, even after the lobby
// had cleared it (game:done blanks the frame), so a paid token could land in a blank page: a
// stake with no seat. The bridge now answers only the document that asked, stops before any
// money moves when that document is gone, and opens the paid round when it went afterwards.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const load = () => import(pathToFileURL(path.join(ROOT, 'wallet-widget/src/restakeBridge.mjs')).href);
const ORIGIN = 'https://duelseries.com';

function win(name) {
  return { name, posted: [], postMessage(msg, origin) { this.posted.push([msg, origin]); } };
}

function frame() {
  const f = {
    style: { display: 'block' },
    isConnected: true,
    contentWindow: win('page-1'),
    listeners: [],
    addEventListener(t, fn) { if (t === 'load') this.listeners.push(fn); },
    // The lobby's game:done: hidden, src cleared, a new (blank) document loads.
    clear() { this.style.display = 'none'; this.navigate(); },
    // A new document in the same frame (the WindowProxy stays the same object, as in a browser).
    navigate() { this.listeners.forEach((fn) => fn()); }
  };
  return f;
}

// A stake that waits for the test to let the wallet sign, then to let the submit land.
function stakeDouble() {
  const s = { calls: 0, submitted: 0, cancelled: 0 };
  s.fn = (req, hooks) => {
    s.calls++;
    s.req = req;
    return new Promise((resolve, reject) => {
      s.sign = () => {
        if (!hooks.stillWanted()) { s.cancelled++; return reject(Object.assign(new Error('c'), { cancelled: true })); }
        s.submit = (token) => {
          if (!hooks.stillWanted()) { s.cancelled++; return reject(Object.assign(new Error('c'), { cancelled: true })); }
          s.submitted++;
          s.land = () => resolve({ entryToken: token, worth: 0.1, stake: 0.1 });
          s.fail = (m) => reject(new Error(m));
        };
      };
    });
  };
  return s;
}

async function kit() {
  const { createRestakeBridge, cancelledError } = await load();
  const f = frame();
  const st = stakeDouble();
  const relaunched = [];
  const logs = [];
  let relaunchOk = true;
  const bridge = createRestakeBridge({
    origin: ORIGIN,
    frames: (game) => (game === 'agar' ? null : f),
    stake: st.fn,
    relaunch: (req, staked) => { relaunched.push([req.game, req.sel, staked.entryToken]); return relaunchOk; },
    log: (m) => logs.push(m)
  });
  const ask = (extra) => bridge.onMessage(Object.assign({
    origin: ORIGIN,
    source: f.contentWindow,
    data: { type: 'duel:restake', game: 'paper', stake: 0.1, nonce: 'n-1' }
  }, extra || {}));
  const flush = () => new Promise((r) => setImmediate(r));
  return { bridge, cancelledError, f, st, relaunched, logs, ask, flush, setRelaunch: (v) => { relaunchOk = v; } };
}

test('the token goes back only to the document that asked, on this origin, with its nonce', async () => {
  const k = await kit();
  const done = k.ask();
  assert.strictEqual(k.st.calls, 1);
  assert.deepStrictEqual(k.st.req.sel, { stake: 0.1 });
  k.st.sign();
  k.st.submit('TOKEN');
  k.st.land();
  await done;
  assert.deepStrictEqual(k.f.contentWindow.posted, [[{ type: 'duel:restake:done', entryToken: 'TOKEN', nonce: 'n-1' }, ORIGIN]]);
  assert.strictEqual(k.relaunched.length, 0);
});

test('only the game frame on this origin can ask: anything else stakes nothing', async () => {
  const k = await kit();
  await k.ask({ source: win('some-other-window') });
  await k.ask({ origin: 'https://evil.example' });
  await k.ask({ origin: undefined });
  await k.bridge.onMessage({ origin: ORIGIN, source: k.f.contentWindow, data: 'duel:restake' });
  await k.bridge.onMessage({ origin: ORIGIN, source: k.f.contentWindow, data: { type: 'duel:restake', game: 'agar' } });
  assert.strictEqual(k.st.calls, 0);
  assert.deepStrictEqual(k.f.contentWindow.posted, []);
});

test('the lobby clears the frame while the wallet is open: nothing is submitted and nothing is posted', async () => {
  const k = await kit();
  const done = k.ask();
  k.bridge.onGameDone(); // the player went back to the lobby (the page's lock had timed out)
  k.f.clear();
  k.st.sign(); // then approved in the wallet
  await done;
  assert.strictEqual(k.st.submitted, 0, 'the signed transfer was never sent: no money moved');
  assert.strictEqual(k.st.cancelled, 1);
  assert.deepStrictEqual(k.f.contentWindow.posted, [], 'no token posted into the blank frame');
  assert.strictEqual(k.relaunched.length, 0);
  assert.ok(k.logs.some((m) => /cancelled before any money moved/.test(m)));
});

test('the frame is cleared after the money moved: the paid round opens instead of being dropped', async () => {
  const k = await kit();
  const done = k.ask();
  k.st.sign();
  k.st.submit('PAID');
  k.bridge.onGameDone();
  k.f.clear();
  k.st.land();
  await done;
  assert.deepStrictEqual(k.f.contentWindow.posted, [], 'nothing posted into the blank frame');
  assert.deepStrictEqual(k.relaunched, [['paper', { stake: 0.1 }, 'PAID']], 'the round it paid for opens');
});

test('another page loaded into the frame meanwhile gets nothing; a busy frame is reported, not overwritten', async () => {
  const k = await kit();
  k.setRelaunch(false);
  const done = k.ask();
  k.st.sign();
  k.st.submit('PAID');
  k.f.navigate(); // a different document now, still on screen
  k.st.land();
  await done;
  assert.deepStrictEqual(k.f.contentWindow.posted, [], 'not posted to a document that never asked');
  assert.strictEqual(k.relaunched.length, 1);
  assert.ok(k.logs.some((m) => /no page to go to/.test(m)));
});

test('a stake failure is told to the page that asked, while it is there; one request at a time', async () => {
  const k = await kit();
  const first = k.ask();
  const second = k.ask({ data: { type: 'duel:restake', game: 'paper', stake: 0.1, nonce: 'n-2' } });
  await second;
  assert.deepStrictEqual(k.f.contentWindow.posted, [[{ type: 'duel:restake:error', message: 'A stake is already in progress.', nonce: 'n-2' }, ORIGIN]]);
  assert.strictEqual(k.st.calls, 1);
  k.st.sign();
  k.st.submit('X');
  k.st.fail('Insufficient funds');
  await first;
  assert.deepStrictEqual(k.f.contentWindow.posted[1], [{ type: 'duel:restake:error', message: 'Insufficient funds', nonce: 'n-1' }, ORIGIN]);
  // Free again for the next one; a page with no nonce (the snake game) is answered without one.
  const third = k.ask({ data: { type: 'duel:restake', game: 'snake', lobbyType: 'dime' } });
  assert.deepStrictEqual(k.st.req.sel, { lobbyType: 'dime' });
  k.st.sign();
  k.st.submit('T3');
  k.st.land();
  await third;
  assert.deepStrictEqual(k.f.contentWindow.posted[2], [{ type: 'duel:restake:done', entryToken: 'T3' }, ORIGIN]);
});

// main.jsx is JSX (not loadable in node): it must use the bridge, and stakeOnly must ask
// stillWanted before the wallet prompt and again before the submit. The bundle is its build.
test('the widget wires the bridge: game:done abandons, stakeOnly checks before signing and before sending', () => {
  const src = fs.readFileSync(path.join(ROOT, 'wallet-widget/src/main.jsx'), 'utf8');
  assert.ok(src.includes("from './restakeBridge.mjs'"));
  assert.ok(src.includes('restakeRef.current.onGameDone()'));
  assert.ok(!/frame\.contentWindow\.postMessage\(msg, '\*'\)/.test(src), 'the old post-to-any-frame is gone');
  const so = src.slice(src.indexOf('async function stakeOnly('), src.indexOf('async function buyCosmetic('));
  const iWanted1 = so.indexOf('if (!wanted()) throw cancelledError();');
  const iSign = so.indexOf('await signTransaction(');
  const iWanted2 = so.indexOf('if (!wanted()) throw cancelledError();', iSign);
  const iSubmit = so.indexOf("'/api/submit-stake'");
  assert.ok(iWanted1 > 0 && iWanted1 < iSign && iSign < iWanted2 && iWanted2 < iSubmit, 'checked before the prompt and before the submit');
  const relaunch = src.slice(src.indexOf('relaunch: (req, staked) =>'), src.indexOf("log: (m) => console.warn('[restake] '"));
  assert.ok(relaunch.includes("busyRef.current || !w || !f || f.style.display === 'block'"), 'never over a busy frame');
  assert.ok(relaunch.includes('launchStaked(req.game, req.sel, staked, w,'));
  const bundle = fs.readFileSync(path.join(ROOT, 'public/wallet/widget.js'), 'utf8');
  assert.ok(bundle.includes('Stake cancelled: the game that asked for it was closed.'), 'the built widget has the bridge');
});

test('the arena page sends a nonce with its request and takes only its own answer', () => {
  const main = fs.readFileSync(path.join(ROOT, 'public/js/paper/mp/paperArenaMain.js'), 'utf8');
  assert.ok(main.includes("{ type: 'duel:restake', game: 'paper', stake: page.stake, nonce: page.restakeNonce }"));
  assert.ok(main.includes('if (d.nonce !== undefined && d.nonce !== page.restakeNonce) return;'));
});

test('a wallet prompt that never settles does not block the next game once the lobby cleared the frame', async () => {
  const k = await kit();
  k.ask(); // never answered
  assert.strictEqual(k.st.calls, 1);
  k.bridge.onGameDone();
  k.f.clear();
  k.f.style.display = 'block'; // the next game in the same frame asks
  const next = k.ask({ data: { type: 'duel:restake', game: 'paper', stake: 1, nonce: 'n-9' } });
  assert.strictEqual(k.st.calls, 2, 'the new request is served');
  assert.deepStrictEqual(k.st.req.sel, { stake: 1 });
  k.st.sign();
  k.st.submit('NEXT');
  k.st.land();
  await next;
  assert.deepStrictEqual(k.f.contentWindow.posted, [[{ type: 'duel:restake:done', entryToken: 'NEXT', nonce: 'n-9' }, ORIGIN]]);
});

/* Paid agar.io (PAID-AGAR-DESIGN.md 4 step 8 and 7): its end card's "Play again $0.10" posts
   duel:restake { game: 'agar', stake, nonce } from the agar frame. The bridge serves it like Paper's,
   answers only the agar frame's document, and a request naming agar from any other frame stakes nothing. */
test('an agar.io Play again is staked and answered only in the agar frame', async () => {
  const { createRestakeBridge } = await load();
  const game = frame();
  const agar = frame();
  agar.contentWindow = win('agar-page');
  const st = stakeDouble();
  const bridge = createRestakeBridge({
    origin: ORIGIN,
    frames: (g) => (g === 'agar' ? agar : game),   // the widget's frameFor: agar-frame for agar, game-frame else
    stake: st.fn,
    relaunch: () => false,
    log: () => {}
  });
  // Named agar, sent from the snake/Paper frame: not the agar frame's document, nothing staked.
  await bridge.onMessage({ origin: ORIGIN, source: game.contentWindow, data: { type: 'duel:restake', game: 'agar', stake: 0.1, nonce: 'x' } });
  assert.strictEqual(st.calls, 0, 'only the agar frame can ask for an agar round');
  // From the agar frame: staked by its rung, answered there with its nonce.
  const done = bridge.onMessage({ origin: ORIGIN, source: agar.contentWindow, data: { type: 'duel:restake', game: 'agar', stake: 0.1, nonce: 'a-1' } });
  assert.strictEqual(st.calls, 1);
  assert.deepStrictEqual([st.req.game, st.req.sel], ['agar', { stake: 0.1 }]);
  st.sign();
  st.submit('AGTOKEN');
  st.land();
  await done;
  assert.deepStrictEqual(agar.contentWindow.posted, [[{ type: 'duel:restake:done', entryToken: 'AGTOKEN', nonce: 'a-1' }, ORIGIN]]);
  assert.deepStrictEqual(game.contentWindow.posted, [], 'and nothing went to the other frame');
});
