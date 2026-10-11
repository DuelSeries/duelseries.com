'use strict';
// The DuelSeries layer HUD on the frozen slither.io client (task T17; SERVER-DESIGN 15.3, 15.4, 18.4 slxLayer HUD
// cases): slxCard, slxTop, slxChat, slxStats, slxSound.
//
// Part A runs each file on its own fake page (test/slxHudFakes.js) behind a fake layer bus with slxNet's API.
// Part B boots the frozen client (test/slVmPage.js) with the real layer (slxNet, slxMain, slxDirect and these five)
// on a fake socket.io that replays the gate's golden streams, so the card's number is proven against THEIR last-score
// line on the death and the close path, through the production tap.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makePage, ROOT } = require('./slxHudFakes.js');

const SLX_DIR = path.join(ROOT, 'public', 'js', 'slx');
const HUD = ['slxCard.js', 'slxTop.js', 'slxChat.js', 'slxStats.js', 'slxSound.js'];

// A page with the HUD file(s) loaded on the fake bus.
function page(files, opts) {
  const P = makePage(opts);
  for (const f of [].concat(files)) P.load(f);
  return P;
}
// Objects made inside a vm context have that context's prototypes: compare them as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));
const LASTSCORE = (n) => '<span style="opacity: .45;">Your final length was </span><b>' + n + '</b>' + (n > 1000 ? '!' : '');

// ---------------------------------------------------------------------------------------------------------------
// Part A: inert, and each feature on the fake page

test('inert: with no active layer bus every HUD file makes no node, style, listener, frame or emit', () => {
  for (const mode of ['missing', 'inactive', 'noDuelSlither']) {
    const P = makePage();
    if (mode === 'missing') delete P.D.slx;
    if (mode === 'inactive') P.slx.active = false;
    if (mode === 'noDuelSlither') delete P.win.DuelSlither;
    const before = { body: P.doc.body.childNodes.length, head: P.doc.head.childNodes.length };
    for (const f of HUD) P.load(f);
    assert.strictEqual(P.doc.body.childNodes.length, before.body, mode + ': body nodes');
    assert.strictEqual(P.doc.head.childNodes.length, before.head, mode + ': head nodes');
    assert.strictEqual(P.win.listeners.length, 0, mode + ': window listeners');
    assert.strictEqual(P.doc.listeners.length, 0, mode + ': document listeners');
    assert.strictEqual(P.rafCount(), 0, mode + ': animation frames');
    assert.strictEqual(P.sent.length, 0, mode + ': emits');
    if (P.D.slx) for (const k of ['card', 'top', 'chat', 'stats', 'sound']) assert.strictEqual(P.D.slx[k], undefined, mode + ': slx.' + k);
  }
});

test('slxCard: death card at their menu show, N from their last-score line, follows their fades', () => {
  const P = page('slxCard.js');
  const card = P.slx.card;
  assert.strictEqual(card.state().kind, '', 'nothing before a life ends');
  P.slx.fire('open');
  P.slx.fire('ownDead', { type: 'dead', code: 0 });
  P.S.lastscore.innerHTML = LASTSCORE(1234);
  assert.strictEqual(card.element.style.display, 'none', 'the card waits for their 1.6 s');
  P.slx.fire('menuShow');
  let st = card.state();
  assert.strictEqual(st.kind, 'dead');
  assert.strictEqual(st.title, 'Match Results');
  assert.strictEqual(st.length, '1234');
  assert.strictEqual(st.again, 'Play again');
  assert.strictEqual(st.opacity, '0', 'their login layer is still transparent at menu show');
  assert.strictEqual(card.element.style.display, 'block');
  assert.strictEqual(card.element.textContent, 'Match ResultsYour final length was 1234Play againLobby');
  P.slx.fire('menuFade', 0.25);
  assert.strictEqual(card.state().opacity, '0.75', 'opacity 1 - login_fr, as their login layer');
  P.slx.fire('menuFade', 0);
  P.slx.fire('menuDone');
  assert.strictEqual(card.state().opacity, '1');
  // the next life's start fade takes it away
  P.slx.fire('menuFade', 0.5);
  assert.strictEqual(card.state().opacity, '0.5');
  P.slx.fire('menuFade', 1);
  assert.strictEqual(card.state().kind, '');
  assert.strictEqual(card.element.style.display, 'none');
});

test('slxCard: close path, Too slow, cash-out, and no length without an own snake', () => {
  const cases = [
    { name: 'transport close', reason: 'transport close', kind: 'lost', title: 'Connection lost' },
    { name: 'ping timeout', reason: 'ping timeout', kind: 'lost', title: 'Connection lost' },
    { name: 'server kick', reason: 'io server disconnect', kind: 'slow', title: 'Too slow' },
    { name: 'server refusal mid-life', reason: 'io server disconnect', refused: 'flood', kind: 'lost', title: 'Connection lost' }
  ];
  for (const c of cases) {
    const P = page('slxCard.js', { S: { slither: { id: 3 } } });
    P.slx.fire('open');
    P.socketEvent('disconnect', c.reason);
    P.slx.fire('close', { playing: true, opened: true, sawDead: false, refused: c.refused || null });
    P.S.lastscore.innerHTML = LASTSCORE(57);                // their applyClose -> gameOver writes it
    assert.strictEqual(P.slx.card.state().kind, '', c.name + ': waits for their menu');
    P.slx.fire('menuShow');
    const st = P.slx.card.state();
    assert.strictEqual(st.kind, c.kind, c.name);
    assert.strictEqual(st.title, c.title, c.name);
    assert.strictEqual(st.length, '57', c.name);
    assert.strictEqual(st.again, 'Play again', c.name);
  }
  // cash-out: sl:x cashed arrives before the own dead (server/sl/slRoom.js _cashOut)
  const C = page('slxCard.js');
  C.slx.fire('open');
  C.slx.fire('x:cashed', { t: 'cashed', len: 812 });
  C.slx.fire('ownDead', { type: 'dead', code: 0 });
  C.S.lastscore.innerHTML = LASTSCORE(812);
  C.slx.fire('menuShow');
  assert.strictEqual(C.slx.card.state().title, 'Cashed Out');
  assert.strictEqual(C.slx.card.state().length, '812');
  // a close while playing with no own snake: their gameOver cannot write a length, so the card shows none
  const N = page('slxCard.js', { S: { slither: null } });
  N.slx.fire('open');
  N.S.lastscore.innerHTML = LASTSCORE(99);                  // an older life's text
  N.slx.fire('close', { playing: true, opened: true, sawDead: false, refused: null });
  N.slx.fire('menuShow');
  assert.strictEqual(N.slx.card.state().title, 'Connection lost');
  assert.strictEqual(N.slx.card.state().length, '', 'no stale number');
  // a new socket forgets the last one
  N.slx.fire('open');
  N.slx.fire('ownDead', { type: 'dead', code: 0 });
  N.S.slither = { id: 4 };
  N.S.lastscore.innerHTML = LASTSCORE(10);
  N.slx.fire('menuShow');
  assert.strictEqual(N.slx.card.state().title, 'Match Results');
  assert.strictEqual(N.slx.card.state().length, '10');
});

test('slxCard: refusal states show at once, never through their menu, at full opacity', () => {
  const cases = [
    ['full', 'Room full'], ['maintenance', 'Maintenance'], ['closed', 'Closed'], ['not-open', 'Closed'],
    ['flood', 'Connection lost'], ['someday-new', 'Connection lost']
  ];
  for (const [why, title] of cases) {
    const P = page('slxCard.js');
    let shows = 0;
    P.slx.on('menuShow', () => shows++);
    P.slx.fire('open');
    P.slx.fire('x', { t: 'refused', why });
    P.slx.fire('x:refused', { t: 'refused', why });
    P.socketEvent('disconnect', 'io server disconnect');
    P.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: why });
    const st = P.slx.card.state();
    assert.strictEqual(st.title, title, why);
    assert.strictEqual(st.length, '', why + ': no length line');
    assert.strictEqual(st.opacity, '1', why);
    assert.strictEqual(st.again, 'Try again', why);
    assert.strictEqual(shows, 0, why + ': their menu never showed');
  }
  // the handshake gate's refusal arrives as connect_error data (server/sl/slSockets.js admit)
  const L = page('slxCard.js');
  L.socketEvent('connect_error', Object.assign(new Error('too many connections from this address'), { data: { why: 'limit' } }));
  L.slx.fire('close', { playing: false, opened: false, sawDead: false, refused: null });
  assert.strictEqual(L.slx.card.state().title, 'Too many players on this network');
  // a plain failed connect
  const F = page('slxCard.js');
  F.socketEvent('connect_error', new Error('xhr poll error'));
  F.slx.fire('close', { playing: false, opened: false, sawDead: false, refused: null });
  assert.strictEqual(F.slx.card.state().title, 'Connection lost');
  // a successful start fade takes a refusal card away too
  F.slx.fire('menuFade', 0.4);
  assert.strictEqual(F.slx.card.state().opacity, '0.6');
  F.slx.fire('menuFade', 1);
  assert.strictEqual(F.slx.card.state().kind, '');
});

test('slxCard: Play again under the last Play name, once; Lobby to the lobby frame or the lobby page; taps stay', () => {
  const P = page('slxCard.js');
  P.D.slMain = { nick: 'Owen' };
  let boosts = 0;
  let ups = 0;
  P.win.onmousedown = () => boosts++;                     // their boost (public/js/sl/slInput.js:148, 205)
  P.win.addEventListener('mouseup', () => ups++);         // their boost end (slInput.js:207)
  P.slx.fire('open');
  P.slx.fire('ownDead', {});
  P.S.lastscore.innerHTML = LASTSCORE(5);
  P.slx.fire('menuShow');
  const [again] = P.find('slx-card-again');
  const [lobby] = P.find('slx-card-lobby');
  P.dispatch(again, 'mousedown', { button: 0 });
  P.dispatch(again, 'mouseup', { button: 0 });
  P.dispatch(again, 'click', {});
  assert.deepStrictEqual(P.plays, ['Owen']);
  assert.strictEqual(P.slx.card.state().again, 'Starting');
  assert.strictEqual(again.disabled, true);
  P.dispatch(again, 'click', {});
  assert.deepStrictEqual(P.plays, ['Owen'], 'a second press does nothing');
  P.dispatch(lobby, 'mousedown', { button: 0 });
  P.dispatch(lobby, 'click', {});
  assert.deepStrictEqual(P.lobbyPosts, ['game:done']);
  P.dispatch(P.slx.card.element, 'contextmenu', {});
  assert.strictEqual(boosts, 0, 'no mousedown reached their window.onmousedown');
  assert.strictEqual(ups, 0, 'no mouseup reached their window listener');
  // a direct visit (no lobby frame): Lobby opens the lobby page
  const Q = page('slxCard.js', { framed: false });
  Q.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'full' });
  Q.dispatch(Q.find('slx-card-lobby')[0], 'click', {});
  assert.deepStrictEqual(Q.win.location.assigned, ['/']);
});

test('slxTop: the biggest cash-out goes into their vcm box as text, with the empty state', () => {
  const P = page('slxTop.js');
  const vcm = P.S.vcm;
  assert.strictEqual(vcm.textContent, '', 'empty until the server pushes');
  P.slx.fire('x:top', { t: 'top', name: 'Mosdfagg', amount: 1234.5 });
  assert.strictEqual(vcm.textContent, 'Biggest cash-out$1,234.50 by Mosdfagg');
  assert.deepStrictEqual(vcm.children.map((e) => e.tagName), ['I', 'BR', 'I']);
  P.slx.fire('x:top', { t: 'top', name: null, amount: null });
  assert.strictEqual(vcm.textContent, 'Biggest cash-outNo cash-outs yet');
  P.slx.fire('x:top', { t: 'top', name: '<b>x</b>', amount: 0.9 });
  assert.strictEqual(vcm.textContent, 'Biggest cash-out$0.90 by <b>x</b>', 'a name is text, never markup');
  P.slx.fire('x:top', { t: 'top', name: '', amount: 20 });
  assert.strictEqual(vcm.textContent, 'Biggest cash-out$20.00', 'no name: no "by"');
  const keep = vcm.textContent;
  for (const bad of [{ amount: NaN, name: 'a' }, { amount: -1, name: 'a' }, { amount: '5', name: 'a' },
    { amount: Infinity, name: 'a' }, { amount: 5, name: { toString: () => 'x' } }, { amount: 5, name: 'x'.repeat(25) },
    { amount: null, name: 'a' }, null, 7, 'top']) {
    P.slx.fire('x:top', bad);
    assert.strictEqual(vcm.textContent, keep, 'refused: ' + JSON.stringify(bad));
  }
  const money = P.slx.top.money;
  const vectors = [[0, '$0.00'], [0.1, '$0.10'], [0.05, '$0.05'], [9.99, '$9.99'], [999.99, '$999.99'], [1000, '$1,000.00'],
    [1234567.89, '$1,234,567.89'], [19.995, '$20.00']];
  for (const [a, s] of vectors) assert.strictEqual(money(a), s, String(a));
  // the opacities copy their longest box (public/js/sl/slApply.js:847-868)
  P.slx.fire('x:top', { t: 'top', name: 'Ann', amount: 3 });
  const spans = [];
  const walk = (n) => { for (const c of n.children || []) { if (c.tagName === 'SPAN') spans.push([c.textContent, c.style.opacity]); walk(c); } };
  walk(vcm);
  assert.deepStrictEqual(spans, [['Biggest cash-out', '.5'], ['$3.00', '.75'], [' by ', '.5'], ['Ann', '.65']]);
});

test('slxChat: T opens, typing never reaches their keys, Enter sends, Esc closes; shown while playing', () => {
  const P = page('slxChat.js');
  const chat = P.slx.chat;
  const theirs = [];
  P.doc.onkeydown = (e) => theirs.push('down ' + e.keyCode);   // their handlers (public/js/sl/slInput.js:207-208)
  P.doc.onkeyup = (e) => theirs.push('up ' + e.keyCode);
  P.raf(1);
  assert.strictEqual(chat.element.style.display, undefined, 'hidden before their game shows');
  P.dispatch(P.doc.body, 'keydown', { key: 't', keyCode: 84 });
  assert.strictEqual(chat.typing(), false, 'T does nothing while hidden');
  P.S.playing = true;
  P.raf(1);
  assert.strictEqual(chat.element.style.display, 'block');
  theirs.length = 0;
  P.dispatch(P.doc.body, 'keydown', { key: 't', keyCode: 84 });
  assert.strictEqual(chat.typing(), true);
  P.raf(1);
  assert.strictEqual(P.doc.activeElement, chat.input, 'the input has the focus');
  for (const [key, code] of [[' ', 32], ['ArrowLeft', 37], ['ArrowUp', 38], ['ArrowRight', 39], ['q', 81], ['t', 84]]) {
    P.dispatch(chat.input, 'keydown', { key, keyCode: code });
    P.dispatch(chat.input, 'keyup', { key, keyCode: code });
  }
  assert.deepStrictEqual(theirs, ['down 84'], 'only the opening T reached their handlers (it ignores 84); nothing typed in the box did');
  chat.input.value = '  hello <world>  ';
  P.dispatch(chat.input, 'keydown', { key: 'Enter', keyCode: 13 });
  assert.deepStrictEqual(plain(P.sent), [['sl:chat', { text: 'hello <world>' }]]);
  assert.strictEqual(chat.typing(), false);
  assert.notStrictEqual(P.doc.activeElement, chat.input);
  // Esc closes with nothing sent; an empty line sends nothing
  P.dispatch(P.doc.body, 'keydown', { key: 'T', keyCode: 84 });
  P.raf(1);
  chat.input.value = 'nope';
  P.dispatch(chat.input, 'keydown', { key: 'Escape', keyCode: 27 });
  assert.strictEqual(chat.typing(), false);
  P.dispatch(P.doc.body, 'keydown', { key: 't', keyCode: 84 });
  P.raf(1);
  chat.input.value = '   ';
  P.dispatch(chat.input, 'keydown', { key: 'Enter', keyCode: 13 });
  assert.strictEqual(P.sent.length, 1);
  // a blur closes
  P.dispatch(P.doc.body, 'keydown', { key: 't', keyCode: 84 });
  P.raf(1);
  chat.input.blur();
  assert.strictEqual(chat.typing(), false);
  // T is ignored while another text box has the focus (the direct-visit name box)
  const other = P.doc.createElement('input');
  P.doc.body.appendChild(other);
  other.focus();
  P.dispatch(other, 'keydown', { key: 't', keyCode: 84 });
  assert.strictEqual(chat.typing(), false);
  other.blur();
  // the game ending hides the box and closes the input
  P.dispatch(P.doc.body, 'keydown', { key: 't', keyCode: 84 });
  P.S.playing = false;
  P.raf(1);
  assert.strictEqual(chat.element.style.display, 'none');
  assert.strictEqual(chat.typing(), false);
  // a click on the box never reaches their boost
  let boosts = 0;
  P.win.onmousedown = () => boosts++;
  P.dispatch(chat.element.childNodes[0], 'mousedown', { button: 0 });
  P.dispatch(chat.input, 'mousedown', { button: 0 });
  assert.strictEqual(boosts, 0);
  // phones: no input
  const M = page('slxChat.js', { S: { is_mobile: true, playing: true } });
  M.raf(1);
  M.dispatch(M.doc.body, 'keydown', { key: 't', keyCode: 84 });
  assert.strictEqual(M.slx.chat.typing(), false);
});

test('slxChat: lines, own lines, kill lines (the old format), 50 kept, text only', () => {
  const P = page('slxChat.js', { S: { playing: true } });
  const chat = P.slx.chat;
  P.raf(1);
  P.dispatch(P.doc.body, 'keydown', { key: 't', keyCode: 84 });
  P.raf(1);
  chat.input.value = 'gg <3';
  P.dispatch(chat.input, 'keydown', { key: 'Enter', keyCode: 13 });
  P.slx.fire('x:chat', { t: 'chat', name: 'Ann', text: 'hi' });
  P.slx.fire('x:chat', { t: 'chat', name: 'Owen', text: 'gg 3' });     // the server stripped < and >
  P.slx.fire('x:chat', { t: 'chat', name: 'Bob', text: 'gg 3' });      // the same words from someone else
  P.slx.fire('x:chat', { t: 'chat', name: '', text: 'who' });
  P.slx.fire('x:chat', { t: 'chat', name: 'x', text: '' });            // nothing to show
  P.slx.fire('x:kill', { t: 'kill', killer: 'Bob', victim: 'Ann' });
  P.slx.fire('x:kill', { t: 'kill', killer: '', victim: 'Ann' });
  P.slx.fire('x:kill', { t: 'kill', killer: 'Bob', victim: '' });
  P.slx.fire('x:chat', { t: 'chat', name: '<img src=x>', text: '<script>1</script>' });
  assert.deepStrictEqual(plain(chat.lines()), [
    'Ann: hi', 'Owen: gg 3', 'Bob: gg 3', 'Player: who',
    '💀 Bob killed Ann', '💀 Ann died', '💀 Bob killed a snake',
    '<img src=x>: <script>1</script>'
  ]);
  const rows = P.find('slx-chat-msg');
  assert.deepStrictEqual(rows.map((r) => /slx-chat-me/.test(r.className)), [false, true, false, false, false, false, false, false]);
  assert.deepStrictEqual(rows.map((r) => /slx-chat-kill/.test(r.className)), [false, false, false, false, true, true, true, false]);
  const killer = P.find('slx-chat-killer').map((e) => e.textContent);
  const victim = P.find('slx-chat-victim').map((e) => e.textContent);
  assert.deepStrictEqual(killer, ['Bob', 'Bob']);
  assert.deepStrictEqual(victim, ['Ann', 'Ann', 'a snake']);
  for (let i = 0; i < 60; i++) P.slx.fire('x:chat', { t: 'chat', name: 'n', text: 'm' + i });
  const lines = chat.lines();
  assert.strictEqual(lines.length, 50);
  assert.strictEqual(lines[0], 'n: m10');
  assert.strictEqual(lines[49], 'n: m59');
  // the input's cap is law C_CHAT maxLen
  assert.strictEqual(chat.input.maxLength, 120);
});

test('slxStats: ping in the old format and colours, FPS over 500 ms, shown while playing', () => {
  const P = page('slxStats.js');
  const st = P.slx.stats;
  const dot = P.find('slx-ping-dot')[0];
  assert.strictEqual(st.ping(), '-- ms');
  for (const [rtt, text, cls] of [[42.4, '42 ms', 'slx-ping-green'], [49.6, '50 ms', 'slx-ping-orange'],
    [99.4, '99 ms', 'slx-ping-orange'], [100, '100 ms', 'slx-ping-red'], [-1, '100 ms', 'slx-ping-red']]) {
    P.slx.fire('pong', rtt);
    assert.strictEqual(st.ping(), text, String(rtt));
    assert.ok(dot.className.split(' ').includes(cls), String(rtt) + ' ' + dot.className);
  }
  P.raf(25, 20);
  assert.strictEqual(st.fps(), 50);
  assert.strictEqual(P.find('slx-fps')[0].textContent, 'FPS: 50');
  assert.strictEqual(st.element.style.display, undefined, 'hidden while their game is not showing');
  P.S.playing = true;
  P.raf(1, 20);
  assert.strictEqual(st.element.style.display, 'block');
});

// The server's sl:diag fields (server/sl/slSockets.js DIAG_NUMBERS) and its cleaner.
const DIAG_FIELDS = ['applyThrows', 'wireErrors', 'fps', 'lag', 'lagEntries', 'pongP95', 'maxGapMs', 'maxOwnChl', 'lastClose'];
const { cleanDiag } = require('../server/sl/slSockets.js');

test('slxStats: sl:diag at each open and every 11 s, deltas, lag, gaps, chl, p95; every field survives the server', () => {
  const P = page('slxStats.js', { S: { playing: true } });
  P.stats.applyThrows = 3;
  P.stats.wireErrors = 1;
  P.slx.fire('open');
  assert.strictEqual(P.sent.length, 1);
  let [name, d] = P.sent[0];
  assert.strictEqual(name, 'sl:diag');
  assert.deepStrictEqual(Object.keys(d).sort(), ['applyThrows', 'fps', 'lag', 'lagEntries', 'maxGapMs', 'maxOwnChl', 'wireErrors']);
  assert.strictEqual(d.applyThrows, 3);
  assert.strictEqual(d.wireErrors, 1);
  assert.strictEqual(d.lastClose, undefined, 'the first socket of the page has no previous one');
  // one window: pongs, bundle gaps, lag mode, chl
  for (let i = 10; i < 30; i++) P.slx.fire('pong', i);
  P.clock.now += 5;
  P.slx.fire('frame', [], 10);
  P.clock.now += 100;
  P.slx.fire('frame', [], 10);
  P.clock.now += 250;
  P.slx.fire('frame', [], 10);
  P.S.slither = { id: 1, chl: 1.234 };
  P.raf(1, 20);
  P.S.lagging = true;
  P.raf(10, 20);
  P.S.lagging = false;
  P.raf(1, 20);
  P.S.lagging = true;
  P.raf(1, 20);
  P.S.lagging = false;
  P.S.slither.chl = 0.5;
  P.stats.applyThrows = 5;
  const t0 = P.clock.now;
  const opened = P.sent.length;
  while (P.sent.length === opened) P.raf(1, 20);
  // the open report left at clock 1000 (P.clock starts there); the next is due 11 s later
  assert.ok(P.clock.now - 1000 >= 11000 && P.clock.now - 1000 < 11000 + 20, 'second report at 11 s: ' + (P.clock.now - 1000));
  assert.ok(P.clock.now > t0);
  d = P.sent[P.sent.length - 1][1];
  assert.strictEqual(d.applyThrows, 2, 'a delta since the last report');
  assert.strictEqual(d.wireErrors, 0);
  assert.strictEqual(d.pongP95, 28, 'nearest rank of 10..29');
  assert.strictEqual(d.maxGapMs, 250);
  assert.strictEqual(d.maxOwnChl, 1.23);
  assert.strictEqual(d.lagEntries, 2);
  assert.strictEqual(d.lag, 220, '11 lagging frames of 20 ms (the first counts its own frame)');
  assert.strictEqual(d.fps, 50);
  for (const k of Object.keys(d)) assert.ok(DIAG_FIELDS.includes(k), k);
  assert.deepStrictEqual(plain(cleanDiag(d, 24)), plain(d), 'the server keeps every field');
  // nothing while not connected
  P.setConnected(false);
  const n = P.sent.length;
  P.raf(700, 20);
  assert.strictEqual(P.sent.length, n);
});

test('slxStats: lastClose names how the previous socket ended', () => {
  function sequence(steps) {
    const P = page('slxStats.js');
    P.slx.fire('open');
    for (const s of steps) {
      if (s[0] === 'fire') P.slx.fire(s[1], s[2]);
      else P.socketEvent(s[1], s[2]);
    }
    P.slx.fire('open');
    const d = P.sent[P.sent.length - 1][1];
    assert.deepStrictEqual(plain(cleanDiag(d, 24)), plain(d));
    return d.lastClose;
  }
  assert.strictEqual(sequence([['fire', 'ownDead', {}], ['sock', 'disconnect', 'io client disconnect']]), 'dead');
  assert.strictEqual(sequence([['fire', 'x:cashed', {}], ['fire', 'ownDead', {}]]), 'cashed');
  assert.strictEqual(sequence([['sock', 'disconnect', 'transport close'],
    ['fire', 'close', { playing: true, opened: true, sawDead: false, refused: null }]]), 'transport-close');
  assert.strictEqual(sequence([['sock', 'disconnect', 'io server disconnect'],
    ['fire', 'close', { playing: true, opened: true, sawDead: false, refused: null }]]), 'server');
  assert.strictEqual(sequence([['sock', 'disconnect', 'ping timeout'],
    ['fire', 'close', { playing: true, opened: true, sawDead: false, refused: null }]]), 'ping-timeout');
  assert.strictEqual(sequence([['sock', 'disconnect', 'io server disconnect'],
    ['fire', 'close', { playing: false, opened: true, sawDead: false, refused: 'maintenance' }]]), 'refused-maintenance');
  assert.strictEqual(sequence([['sock', 'connect_error', Object.assign(new Error('x'), { data: { why: 'limit' } })],
    ['fire', 'close', { playing: false, opened: false, sawDead: false, refused: null }]]), 'refused-limit');
  assert.strictEqual(sequence([['sock', 'connect_error', new Error('xhr poll error')],
    ['fire', 'close', { playing: false, opened: false, sawDead: false, refused: null }]]), 'connect-error');
  assert.strictEqual(sequence([['sock', 'disconnect', 'io client disconnect']]), 'client');
  assert.strictEqual(sequence([]), 'none');
  assert.strictEqual(sequence([['sock', 'disconnect', 'some new reason'],
    ['fire', 'close', { playing: true, opened: true, sawDead: false, refused: null }]]), 'other');
});

// A fake Web Audio context that records what each synth asked for.
function audio() {
  const made = [];
  class Param {
    constructor() { this.value = 0; this.calls = []; }
    setValueAtTime(v, t) { this.calls.push(['set', v, t]); }
    linearRampToValueAtTime(v, t) { this.calls.push(['lin', v, t]); }
    exponentialRampToValueAtTime(v, t) { this.calls.push(['exp', v, t]); }
  }
  class AC {
    constructor() { this.state = 'running'; this.currentTime = 2; this.destination = { dest: true }; made.push(this); this.osc = []; }
    createOscillator() { const o = { type: '', frequency: new Param(), connect() {}, start() {}, stop() {} }; this.osc.push(o); return o; }
    createGain() { return { gain: new Param(), connect() {} }; }
    resume() { this.state = 'running'; return { catch() {} }; }
  }
  return { AC, made };
}

test('slxSound: join once per socket, death unless cashed, kill when the own count rises, the shared fanfare', () => {
  const a = audio();
  const fanfare = [];
  const P = page('slxSound.js', { win: { AudioContext: a.AC, CashoutSound: { play(ac, dest, vol) { fanfare.push(vol); return true; } } } });
  const played = () => P.slx.sound.played();
  P.slx.fire('open');
  P.slx.fire('ownAdd', { id: 1 });
  P.slx.fire('ownAdd', { id: 1 });
  assert.deepStrictEqual(plain(played()), { join: 1, death: 0, kill: 0, cashout: 0 });
  const ac = a.made[0];
  assert.deepStrictEqual(ac.osc.map((o) => o.frequency.value), [523.25, 1046.5, 659.25, 1318.5, 783.99, 1567.98],
    'the old C5 E5 G5 chime with its octave (public/js/game.js:320-358)');
  P.slx.fire('ownKills', { id: 1, count: 1 });
  P.slx.fire('ownKills', { id: 1, count: 1 });
  P.slx.fire('ownKills', { id: 1, count: 3 });
  assert.strictEqual(played().kill, 2);
  P.slx.fire('ownDead', { code: 0 });
  assert.strictEqual(played().death, 1);
  // a cash-out socket: the fanfare, and no death sound for its own dead
  P.slx.fire('open');
  P.slx.fire('ownKills', { id: 2, count: 1 });
  assert.strictEqual(played().kill, 3, 'the count starts over with each socket');
  P.slx.fire('x:cashed', { t: 'cashed', len: 40 });
  P.slx.fire('ownDead', { code: 0 });
  assert.deepStrictEqual(plain(played()), { join: 1, death: 1, kill: 3, cashout: 1 });
  assert.deepStrictEqual(fanfare, [0.5], 'master 1 x sfx 0.5, the old defaults (game.js:234)');
  // muted: asked for but silent
  const before = ac.osc.length;
  P.win.gameMuted = true;
  P.slx.fire('open');
  P.slx.fire('ownAdd', { id: 3 });
  assert.strictEqual(ac.osc.length, before);
  assert.strictEqual(a.made.length, 1, 'one shared context');
});

test('slxSound: the first gesture unlocks audio; the fanfare file loads only when missing', () => {
  const a = audio();
  const P = page('slxSound.js', { win: { AudioContext: a.AC } });
  const scripts = P.doc.head.children.filter((e) => e.tagName === 'SCRIPT');
  assert.deepStrictEqual(scripts.map((s) => s.src), ['/js/cashoutSound.js']);
  const unlock = P.win.listeners.filter((l) => l.once && l.passive).map((l) => l.type).sort();
  assert.deepStrictEqual(unlock, ['click', 'keydown', 'mousedown', 'mousemove', 'pointerdown', 'touchmove', 'touchstart']);
  assert.strictEqual(a.made.length, 0, 'no context before a gesture or a sound');
  P.dispatch(P.doc.body, 'mousemove', {});
  assert.strictEqual(a.made.length, 1);
  const Q = page('slxSound.js', { win: { AudioContext: a.AC, CashoutSound: { play() {} } } });
  assert.strictEqual(Q.doc.head.children.filter((e) => e.tagName === 'SCRIPT').length, 0);
  // no Web Audio at all: every sound is a no-op
  const R = page('slxSound.js', { win: { CashoutSound: { play() { throw new Error('never'); } } } });
  R.slx.fire('open');
  R.slx.fire('ownAdd', {});
  R.slx.fire('x:cashed', {});
  assert.deepStrictEqual(plain(R.slx.sound.played()), { join: 1, death: 0, kill: 0, cashout: 1 });
});

test('HUD files: .slx- selectors only, no Math.random, no markup writes, every number cited', () => {
  const P = makePage({ win: { CashoutSound: { play() {} } } });
  for (const f of HUD) P.load(f);
  const css = P.styleText().replace(/\/\*[\s\S]*?\*\//g, '');
  // every selector of every rule, @media blocks opened
  const flat = css.replace(/@media[^{]*\{/g, '').replace(/\}\s*\}/g, '}');
  const selectors = [];
  for (const m of flat.matchAll(/([^{}]+)\{[^{}]*\}/g)) for (const s of m[1].split(',')) selectors.push(s.trim());
  assert.ok(selectors.length > 30, 'parsed ' + selectors.length);
  for (const s of selectors) assert.ok(/^\.slx-/.test(s), 'selector outside .slx-: ' + s);
  for (const f of HUD) {
    const src = fs.readFileSync(path.join(SLX_DIR, f), 'utf8');
    assert.ok(!/Math\.random/.test(src), f + ': Math.random');
    assert.ok(!/innerHTML\s*=[^=]/.test(src), f + ': writes innerHTML');
    assert.ok(!/insertAdjacentHTML|document\.write|outerHTML\s*=/.test(src), f + ': markup write');
    assert.ok(/if \(!D \|\| !D\.slx \|\| !D\.slx\.active\) return;/.test(src), f + ': the inert check');
    assert.ok(!src.includes(String.fromCharCode(0x2014)), f + ': em dash');
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Part B: the frozen client with the real layer, on a fake socket.io replaying the gate's goldens

const V = require('./slVmPage.js');
const slWire = require('../shared/slWire.js');
const LAYER = ['slxNet.js', 'slxMain.js', 'slxDirect.js'].concat(HUD);
const haveBase = ['slxNet.js', 'slxMain.js', 'slxDirect.js'].every((f) => fs.existsSync(path.join(SLX_DIR, f)));

// o: { refuse: {sock, why}, closeReason, inject: [{sock, before (entry index), data}], again: kind, frames }
function runLife(name, o) {
  const opts = o || {};
  const all = V.loadStreams();
  const g = all.streams[name];
  const src = g.same ? all.streams[g.same] : g;
  const H = g.harness;
  const socks = [];
  let P = null;
  function fakeIo(uri, ioOpts) {
    const s = { n: socks.length + 1, uri, opts: ioOpts, created: P.frame, state: 0, t0: 0, l: {}, connected: false, emits: [], next: 0 };
    s.on = (n, fn) => { (s.l[n] = s.l[n] || []).push(fn); return s; };
    s.fire = (n, d) => { for (const fn of (s.l[n] || []).slice()) fn(d); };
    s.emit = (n, d) => { s.emits.push([n, d]); };
    s.disconnect = () => { if (s.state >= 2) return; s.state = 2; s.connected = false; s.fire('disconnect', 'io client disconnect'); };
    socks.push(s);
    return s;
  }
  P = V.makePage(H, src.entries, {
    scripts: V.SRC.concat(LAYER.map((f) => [f, fs.readFileSync(path.join(SLX_DIR, f), 'utf8')])),
    // no harness transport: slxNet installs the production one over this fake socket.io
    win: { io: fakeIo, CashoutSound: { play() { return true; } }, DuelSlitherConfig: { assetBase: '/' } }
  });
  const login = P.labelled.find((e) => e.label === 'login');
  P.doc.getElementById = (id) => (id === 'login' ? login : null);
  // slxDirect looks for the results card by its class; the vm page knows only data-sl selectors
  const q = P.doc.querySelector;
  P.doc.querySelector = (sel) => (sel === '.slx-card' ? P.win.DuelSlither.slx.card.element : q(sel));
  P.socketHook = function () {
    const s = socks[socks.length - 1];
    if (!s) return;
    if (s.state === 0 && s.created < P.frame) {
      s.state = 1; s.connected = true; s.t0 = P.vnow; s.fire('connect');
      if (opts.refuse && opts.refuse.sock === s.n) {
        s.fire('sl:x', [{ t: 'refused', why: opts.refuse.why }]);
        s.state = 3; s.connected = false; s.fire('disconnect', 'io server disconnect');
        return;
      }
    }
    if (s.state !== 1) return;
    const mine = src.entries.filter((e) => e[0] === s.n);
    while (s.next < mine.length && s.t0 + mine[s.next][1] <= P.vnow + 0.001) {
      const at = s.next++;
      const e = mine[at];
      for (const x of opts.inject || []) if (x.sock === s.n && x.before === at) s.fire('sl:x', x.data);
      if (e[2] < 0) { s.state = 3; s.connected = false; s.fire('disconnect', opts.closeReason || 'transport close'); break; }
      s.fire('sl:f', new P.U8(Buffer.from(e[3], 'hex')));
    }
  };
  P.boot();
  const D = P.win.DuelSlither;
  assert.strictEqual(D.slx.active, true, 'the layer is active on the production transport');
  const seen = { menuShow: 0, cardAtShow: [], lastscoreAtShow: [], states: [] };
  D.slx.on('menuShow', () => {
    seen.menuShow++;
    seen.cardAtShow.push(D.slx.card.state());
    seen.lastscoreAtShow.push(String(D.S.lastscore.innerHTML));
  });
  while (P.frame < H.warm) P.step();
  D.play('Owen');
  const end = P.frame + (opts.frames || H.frames + 200);
  let clicked = false;
  let last = '';
  while (P.frame < end) {
    P.step();
    const st = D.slx.card.state();
    const key = st.kind + '|' + st.again;
    if (key !== last) { seen.states.push(key); last = key; }
    if (opts.again && !clicked && st.kind === opts.again && st.again === 'Play again') {
      clicked = true;
      D.slx.card.playAgain();
    }
  }
  return { P, D, socks, seen, errors: P.errors.slice(), slxErrors: D.slx.errors, sound: D.slx.sound.played() };
}
function lastscoreN(html) {
  const m = /<b>(\d+)<\/b>/.exec(html);
  return m ? m[1] : null;
}
// The index (within its socket) of the first entry of socket n that carries the own `dead`.
function deadEntry(name, n) {
  const src = V.loadStreams().streams[name];
  const mine = src.entries.filter((e) => e[0] === n);
  return mine.findIndex((e) => e[2] >= 0 && slWire.decodeBundle(new Uint8Array(Buffer.from(e[3], 'hex'))).some((ev) => ev.type === 'dead'));
}

test('frozen client + real layer: death card N = their last-score number; Play again plays a second life', { skip: !haveBase && 'T16 layer base not on disk' }, () => {
  const r = runLife('beh-twolives', { again: 'dead' });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.slxErrors, 0);
  assert.strictEqual(r.seen.menuShow, 1);
  const st = r.seen.cardAtShow[0];
  assert.strictEqual(st.kind, 'dead');
  assert.strictEqual(st.title, 'Match Results');
  const n = lastscoreN(r.seen.lastscoreAtShow[0]);
  assert.ok(n !== null, 'their gameOver wrote a length');
  assert.strictEqual(st.length, n, 'the card number is their last-score number');
  assert.strictEqual(st.length, '10');
  assert.deepStrictEqual(r.seen.states, ['|Play again', 'dead|Play again', 'dead|Starting', '|Play again'],
    'shown at their menu, Starting after the press, gone when the second life started');
  assert.strictEqual(r.socks.length, 2, 'Play again connected a second socket');
  assert.deepStrictEqual(plain(r.socks.map((s) => s.emits.find((e) => e[0] === 'sl:join')[1])), [{ nick: 'Owen' }, { nick: 'Owen' }]);
  assert.deepStrictEqual(plain(r.sound), { join: 2, death: 1, kill: 0, cashout: 0 });
  // sl:diag: one at each open; the second socket's names the first's end
  const diags = r.socks.map((s) => s.emits.filter((e) => e[0] === 'sl:diag').map((e) => e[1]));
  assert.strictEqual(diags[0][0].lastClose, undefined);
  assert.strictEqual(diags[1][0].lastClose, 'dead');
  for (const list of diags) for (const d of list) assert.deepStrictEqual(plain(cleanDiag(d, 24)), plain(d));
  assert.ok(diags[1].some((d) => d.pongP95 > 0), 'a pong round trip was timed');
});

test('frozen client + real layer: close card N = their last-score number; a server drop reads Too slow', { skip: !haveBase && 'T16 layer base not on disk' }, () => {
  for (const [reason, kind, title] of [['transport close', 'lost', 'Connection lost'], ['io server disconnect', 'slow', 'Too slow']]) {
    const r = runLife('beh-close', { closeReason: reason });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.slxErrors, 0);
    assert.strictEqual(r.seen.menuShow, 1, reason);
    const st = r.seen.cardAtShow[0];
    assert.strictEqual(st.kind, kind, reason);
    assert.strictEqual(st.title, title, reason);
    const n = lastscoreN(r.seen.lastscoreAtShow[0]);
    assert.ok(n !== null);
    assert.strictEqual(st.length, n, reason + ': the card number is their last-score number');
    assert.strictEqual(st.length, '32');
    assert.deepStrictEqual(plain(r.sound), { join: 1, death: 0, kill: 0, cashout: 0 });
  }
});

test('frozen client + real layer: cash-out card, refusal card with no menu', { skip: !haveBase && 'T16 layer base not on disk' }, () => {
  const at = deadEntry('beh-twolives', 1);
  assert.ok(at > 0, 'the stream has an own dead');
  const c = runLife('beh-twolives', { inject: [{ sock: 1, before: at, data: [{ t: 'cashed', len: 10 }] }], frames: 500 });
  assert.deepStrictEqual(c.errors, []);
  assert.strictEqual(c.seen.cardAtShow[0].title, 'Cashed Out');
  assert.strictEqual(c.seen.cardAtShow[0].length, lastscoreN(c.seen.lastscoreAtShow[0]));
  assert.deepStrictEqual(plain(c.sound), { join: 1, death: 0, kill: 0, cashout: 1 });
  const f = runLife('beh-close', { refuse: { sock: 1, why: 'full' }, frames: 200 });
  assert.deepStrictEqual(f.errors, []);
  assert.strictEqual(f.seen.menuShow, 0, 'a refused socket never reaches their menu');
  const st = f.D.slx.card.state();
  assert.strictEqual(st.title, 'Room full');
  assert.strictEqual(st.length, '');
  assert.strictEqual(st.again, 'Try again');
  assert.strictEqual(st.opacity, '1');
  assert.strictEqual(f.D.slMain.isPlayLocked(), false, 'their Play is usable again');
  f.D.slx.card.playAgain();
  f.P.step();
  f.P.step();
  assert.strictEqual(f.socks.length, 2, 'Try again connects');
});
