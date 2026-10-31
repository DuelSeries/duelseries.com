'use strict';
/* The phone's Back button in a game (bug sweep 2026-10-31).

   The lobby used to close a game with frame.src = '', a navigation, and the next game's src was a second one. Back
   walks a frame's navigations, so from the second game on Back turned the open game into a blank black frame over
   the lobby with no way out but a reload. public/js/v2/play.js now empties a frame by taking it out of the page and
   putting it straight back (a frame put back starts fresh and adds nothing to the history), after the message's
   other listeners have matched e.source against the frame's window. */
const test = require('node:test');
const assert = require('node:assert');
const { lobbyHarness } = require('./v2LobbyHarness');

const ORIGIN = 'https://duelseries.com';

function setup() {
  const h = lobbyHarness([]);
  h.win.location = { origin: ORIGIN, href: ORIGIN + '/', pathname: '/' };
  const log = [];
  const parent = {
    removeChild(f) { log.push('remove'); f.parentNode = null; f.contentWindow = null; },
    insertBefore(f, next) { log.push(['insert', next]); f.parentNode = parent; f.contentWindow = { name: 'fresh' }; },
  };
  const frames = {};
  for (const id of ['game-frame', 'agar-frame']) {
    const f = h.el(id);
    let src = id === 'game-frame' ? '/knockout' : '';
    Object.defineProperty(f, 'src', { get: () => src, set: (v) => { log.push([id, 'src=', v]); src = v; } });
    f.parentNode = parent;
    f.nextSibling = id === 'game-frame' ? 'agar-frame-node' : 'widget-node';
    f.removeAttribute = (a) => { log.push([id, 'removeAttribute', a, f.parentNode ? 'attached' : 'detached']); if (a === 'src') src = ''; };
    f.style.display = id === 'game-frame' ? 'block' : 'none';
    f.contentWindow = { name: id + '-page' };
    frames[id] = f;
  }
  return { h, log, frames };
}

const done = (h, source) => h.win.dispatchEvent({ type: 'message', data: 'game:done', origin: ORIGIN, source });

test('game:done hides the frame at once and empties it without a navigation, after the other listeners', async () => {
  const { h, log, frames } = setup();
  const f = frames['game-frame'];
  const page = f.contentWindow;
  let sawPage = null;
  // wallet.js and toasts.js listen after play.js and match e.source against the frame's window.
  h.win.addEventListener('message', (e) => { if (e.data === 'game:done') sawPage = h.el('game-frame').contentWindow === e.source; });
  done(h, page);
  assert.strictEqual(f.style.display, 'none', 'hidden at once');
  assert.strictEqual(sawPage, true, 'a later listener still finds the page that sent it in the frame');
  assert.deepStrictEqual(log, [], 'nothing navigated or moved yet');
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(!log.some((x) => Array.isArray(x) && x[1] === 'src='), 'src is never set: no navigation for Back to walk');
  const mine = log.filter((x) => x === 'remove' || (Array.isArray(x) && (x[0] === 'game-frame' || x[0] === 'insert')));
  assert.deepStrictEqual(mine.slice(0, 3), ['remove', ['game-frame', 'removeAttribute', 'src', 'detached'], ['insert', 'agar-frame-node']],
    'taken out, its src dropped while out of the page, put back where it was');
  assert.strictEqual(f.parentNode !== null && f.src, '', 'back in the page with no page in it');
  assert.notStrictEqual(f.contentWindow, page, 'the game page is gone');
});

test('a game:done from anything but our frame closes nothing; a frame shown again before the empty is left alone', async () => {
  const { h, log, frames } = setup();
  const f = frames['game-frame'];
  done(h, { name: 'stranger' });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(f.style.display, 'block');
  assert.deepStrictEqual(log, []);
  done(h, f.contentWindow);
  f.style.display = 'block';   // a paid round the restake bridge opened in the same moment
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(!log.some((x) => Array.isArray(x) && x[0] === 'game-frame'), 'the shown frame is not emptied under it');
});
