'use strict';
/* THE END OF A BATTLE ROYALE, AS THE PLAYER SEES IT.

   Owen asked for a specific sequence: the last snake standing, the wall stops,
   then five seconds later a bar at the bottom of the screen fills under the
   words "cashing you out", then a congratulations screen with a podium of the
   top three, a Play again and a Return to lobby.

   That is a state machine spread across three server states and two socket
   messages that can arrive in either order, which is exactly the kind of thing
   that looks right once by hand and then breaks quietly. So these drive the
   REAL functions, lifted out of public/js/game.js rather than copied, against a
   stub DOM — the same technique minimap.test.js uses on Renderer.

   The server half is driven through the real BattleRoyaleRoom, so what the
   client is fed here is what the client is actually fed. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const C = require('../shared/constants');
const { BattleRoyaleRoom, BR } = require('../server/BattleRoyaleRoom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'game.js'), 'utf8');

/* Pull one function out of the client by name, brace-matched. Lifting rather
   than copying is the whole point: a copy stops describing the shipped code the
   first time somebody edits it. */
function lift(name) {
  const at = SRC.indexOf('function ' + name + '(');
  assert.ok(at >= 0, 'client still has a function called ' + name);
  let i = SRC.indexOf('{', at), depth = 0;
  for (let j = i; j < SRC.length; j++) {
    const ch = SRC[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return SRC.slice(at, j + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}

/* ── a DOM that only remembers ──────────────────────────────────────────── */
function fakeDom() {
  const els = new Map();
  const make = () => ({
    textContent: '', innerHTML: '', hidden: true, disabled: false,
    style: { width: '' },
    classList: { add() {}, remove() {}, toggle() {} },
  });
  for (const id of ['brcash', 'bc-fill', 'bc-label', 'podium', 'pod-eyebrow',
                    'pod-winner', 'pod-prize', 'pod-stand', 'pod-reopen',
                    'pod-reopen-fill', 'pod-again', 'pod-next']) {
    els.set(id, make());
  }
  return {
    els,
    document: { getElementById: (id) => els.get(id) || null },
  };
}

function client({ winnerId = 'me', myId = 'me' } = {}) {
  const dom = fakeDom();
  const sandbox = {
    document: dom.document,
    isBattleRoyale: true,
    myId,
    _brSawReopen: false,
    _podiumUp: false,
    _podiumDone: false,
    _brWinnerId: winnerId,
    _brPrize: null,
    _cashEnd: 0, _cashTotal: 0, _cashTimer: 0,
    setInterval: () => 1,
    clearInterval: () => {},
    Date,
    Math,
    Number,
    String,
  };
  vm.createContext(sandbox);
  vm.runInContext([lift('escapeHtml'), lift('paintPrize'), lift('paintCashout'),
                   lift('cashoutApply'), lift('podiumApply')].join('\n\n'), sandbox);
  return { dom, sandbox, apply: (s) => {
    /* brApply's own order, so the test cannot pass on an order the game never
       uses: the cash-out bar is decided before the podium that follows it. */
    vm.runInContext('cashoutApply(' + JSON.stringify(s) + ')', sandbox);
    vm.runInContext('podiumApply(' + JSON.stringify(s) + ')', sandbox);
    /* brNextApply sets this latch, and it runs after both of the above. */
    if (s.state === 'reopening') sandbox._brSawReopen = true;
    if (s.state === 'running' || s.state === 'countdown') sandbox._brSawReopen = false;
  } };
}

const OVER = { state: 'over', cashoutMs: 5000, cashoutTotalMs: 5000, reopenPct: 0,
               winner: { name: 'Owen', id: 'me' }, soloRun: false,
               podium: [{ place: 1, name: 'Owen', score: 900 },
                        { place: 2, name: 'Nia', score: 640 },
                        { place: 3, name: 'Rob', score: 300 }] };
const REOPENING = Object.assign({}, OVER, { state: 'reopening', cashoutMs: 0, reopenPct: 0.4 });
const WAITING   = Object.assign({}, OVER, { state: 'waiting', cashoutMs: 0, reopenPct: 1 });

test('the five seconds belong to the bar, and the podium waits its turn', () => {
  const c = client();
  c.apply(OVER);
  assert.strictEqual(c.dom.els.get('brcash').hidden, false, 'the bar is up');
  assert.strictEqual(c.dom.els.get('bc-label').textContent, 'Cashing you out',
    'and it says what is happening, to the person it is happening to');
  assert.strictEqual(c.dom.els.get('podium').hidden, true,
    'the podium does NOT cover the frozen arena during the cash-out');
});

test('the bar fills from empty to full across the cash-out, not in one jump', () => {
  /* br:state only lands every couple of seconds. A bar painted only when one
     arrives moves in two or three steps, which reads as broken — so the fill is
     run locally off cashoutTotalMs. Here the clock is moved by hand. */
  const c = client();
  const width = () => parseFloat(c.dom.els.get('bc-fill').style.width);
  const realNow = Date.now;
  let t = 1600000000000;
  try {
    c.sandbox.Date = { now: () => t };
    /* Deliberately NOT five seconds. The client has a 5000 fallback for a
       server that predates cashoutTotalMs, and a test run at five seconds
       cannot tell the fallback from actually reading the field. */
    c.apply(Object.assign({}, OVER, { cashoutMs: 8000, cashoutTotalMs: 8000 }));
    assert.ok(width() <= 1, 'starts empty, got ' + width() + '%');
    t += 4000; vm.runInContext('paintCashout()', c.sandbox);
    assert.ok(Math.abs(width() - 50) < 2, 'half way at 4s of 8, got ' + width() + '%');
    t += 4000; vm.runInContext('paintCashout()', c.sandbox);
    assert.strictEqual(width(), 100, 'full at 8s');
  } finally { Date.now = realNow; }
});

test('a solo run is never told it is being cashed out', () => {
  /* The server pays NOTHING for outlasting nobody, and Owen is the only person
     on the game, so the solo run is the case he sees most. Promising him a
     payout that is never coming is the worst thing this screen could do. */
  const c = client();
  c.apply(Object.assign({}, OVER, { soloRun: true }));
  assert.strictEqual(c.dom.els.get('bc-label').textContent, 'Match over');
});

test('everybody else is told whose money it is', () => {
  const c = client({ myId: 'someone-else' });
  c.apply(OVER);
  assert.strictEqual(c.dom.els.get('bc-label').textContent, 'Cashing out Owen');
});

test('the congratulations screen comes up when the bar is done, with the podium', () => {
  const c = client();
  c.apply(OVER);
  c.apply(REOPENING);

  assert.strictEqual(c.dom.els.get('brcash').hidden, true, 'the bar is gone');
  assert.strictEqual(c.dom.els.get('podium').hidden, false, 'the card is up');
  assert.strictEqual(c.dom.els.get('pod-winner').textContent, 'Congratulations, you won!');
  assert.strictEqual(c.dom.els.get('pod-eyebrow').textContent, 'Victory');

  const stand = c.dom.els.get('pod-stand').innerHTML;
  for (const who of ['Owen', 'Nia', 'Rob']) {
    assert.ok(stand.includes(who), who + ' is on the podium');
  }
  /* Place drives the column, so first stands in the middle whatever order the
     server sent them in. */
  assert.ok(stand.includes('class="p1"') && stand.includes('class="p2"')
         && stand.includes('class="p3"'), 'each finisher is placed by rank');
});

test('somebody who did not win is not congratulated', () => {
  const c = client({ myId: 'someone-else' });
  c.apply(OVER);
  c.apply(REOPENING);
  assert.strictEqual(c.dom.els.get('pod-winner').textContent, 'Owen wins');
  assert.strictEqual(c.dom.els.get('pod-eyebrow').textContent, 'Match over');
});

test('Play again is dead until the arena is actually open again', () => {
  /* The server refuses a join into a half-open circle, so an enabled button
     during the reopening is a button that bounces. */
  const c = client();
  c.apply(OVER);
  c.apply(REOPENING);
  assert.strictEqual(c.dom.els.get('pod-again').disabled, true,
    'disabled while the circle is still travelling');
  assert.strictEqual(c.dom.els.get('pod-reopen').hidden, false, 'and it says why');
  assert.strictEqual(c.dom.els.get('pod-reopen-fill').style.width, '40.0%',
    'the line is the arena\'s real progress');

  c.apply(WAITING);
  assert.strictEqual(c.dom.els.get('podium').hidden, false, 'the card is still up');
  assert.strictEqual(c.dom.els.get('pod-again').disabled, false, 'and now it works');
  assert.strictEqual(c.dom.els.get('pod-reopen').hidden, true, 'progress line gone');
});

test('closing the podium closes it for good, not until the next poll', () => {
  /* br:peek lands every two seconds and the podium now spans three states, so
     without the latch the card comes straight back after you dismiss it. */
  const c = client();
  c.apply(OVER); c.apply(REOPENING); c.apply(WAITING);
  assert.strictEqual(c.dom.els.get('podium').hidden, false);

  c.sandbox._podiumDone = true;                 // what the two buttons set
  c.sandbox._brSawReopen = false;
  c.apply(WAITING);
  assert.strictEqual(c.dom.els.get('podium').hidden, true, 'it stays closed');
  c.apply(WAITING);
  assert.strictEqual(c.dom.els.get('podium').hidden, true, 'and stays closed');
});

test('a new match clears the latch, so the next podium is not suppressed', () => {
  const c = client();
  c.apply(OVER); c.apply(REOPENING);
  c.sandbox._podiumDone = true;
  c.apply({ state: 'running', cashoutMs: 0, reopenPct: 0, winner: null, podium: null });
  assert.strictEqual(c.sandbox._podiumDone, false, 'the latch is released');
  assert.strictEqual(c.sandbox._brPrize, null, 'and last match\'s prize is forgotten');
});

test('the prize is shown on the podium, whichever half arrives first', () => {
  /* The server pays the winner and flips the room to reopening on the same
     tick. Which socket message the browser handles first is not ours to
     decide, so both orders have to work. */
  for (const receiptFirst of [true, false]) {
    const c = client();
    c.apply(OVER);
    const receipt = () => {
      c.sandbox._brPrize = { text: 'You won $18.00', state: 'sending to your wallet' };
      vm.runInContext('paintPrize()', c.sandbox);
    };
    if (receiptFirst) { receipt(); c.apply(REOPENING); }
    else { c.apply(REOPENING); receipt(); }

    const el = c.dom.els.get('pod-prize');
    assert.strictEqual(el.hidden, false,
      'prize shown when the receipt came ' + (receiptFirst ? 'first' : 'second'));
    assert.ok(el.innerHTML.includes('You won $18.00'), 'with the amount on it');
    assert.ok(el.innerHTML.includes('sending to your wallet'), 'and the settle state');
  }
});

/* ── the server half ────────────────────────────────────────────────────── */

test('the server sends everything this screen is built from', () => {
  /* The client cannot invent a payout duration or work out whether the winner
     is you. Both come off publicState, and a match is run here rather than a
     state hand-written, so the assertion is about the real thing. */
  const io = { to: () => ({ emit: () => {} }), emit: () => {} };
  const room = new BattleRoyaleRoom(io, 'na_br');
  room.broadcastSnapshot = () => {};
  room.topUpBots = () => {};
  room.start();
  if (room.tickInterval) clearInterval(room.tickInterval);

  /* Two players, so it is a real match rather than a solo run. */
  const made = [];
  for (const name of ['Owen', 'Nia', 'Rob']) {
    const bot = room.addBot();
    assert.ok(bot, 'spawned an opponent');
    bot.isBot = false; bot.name = name;         // humans, for the winner check
    room.players.set(bot.id, { socket: { emit() {} }, name });
    made.push(bot);
  }
  room.state = 'running';
  room.startedWith = made.length;
  room.startedAt = Date.now();

  /* Knock them out in order, so third and second place are known. */
  room.killSnake(made[2]);
  room.killSnake(made[1]);
  room.checkForWinner();

  const st = room.publicState();
  assert.strictEqual(st.state, 'over', 'the match is decided');
  assert.strictEqual(st.cashoutTotalMs, BR.CASHOUT_DELAY_MS,
    'the client is told how long the payout bar runs for');
  assert.ok(st.cashoutMs > 0 && st.cashoutMs <= st.cashoutTotalMs,
    'and how much of it is left');
  assert.ok(st.winner && st.winner.id === made[0].id,
    'the winner carries an id, so a client can tell "you won" from "somebody won"');
  assert.strictEqual(st.winner.name, 'Owen');
  assert.ok(!('wallet' in st.winner), 'and never the wallet');

  assert.strictEqual(st.podium.length, 3, 'three places');
  assert.deepStrictEqual(st.podium.map(p => p.name), ['Owen', 'Nia', 'Rob'],
    'in the order they went out, from the back');
  assert.deepStrictEqual(st.podium.map(p => p.place), [1, 2, 3]);
});

test('the wall really does stop when the match is decided', () => {
  /* Owen asked for this first: "the border stops shrinking". It is the frame
     the whole podium is drawn over, so if it moves the rest is pointless. */
  const io = { to: () => ({ emit: () => {} }), emit: () => {} };
  const room = new BattleRoyaleRoom(io, 'na_br');
  room.broadcastSnapshot = () => {};
  room.topUpBots = () => {};
  room.start();
  if (room.tickInterval) clearInterval(room.tickInterval);

  room.state = 'over';
  room.endedAt = Date.now();
  room.cashoutAt = room.endedAt + BR.CASHOUT_DELAY_MS;
  room._frozen = { r: 820, x: 1200, y: -400 };
  room.worldRadius = 820; room.worldCx = 1200; room.worldCy = -400;

  for (let i = 0; i < C.TICK_RATE * 3; i++) room.updateZone();

  assert.strictEqual(room.worldRadius, 820, 'the circle has not moved a unit');
  assert.strictEqual(room.worldCx, 1200);
  assert.strictEqual(room.worldCy, -400);
  assert.strictEqual(room.state, 'over', 'and it is still holding');
});
