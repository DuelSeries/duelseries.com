'use strict';
// The DuelSeries layer HUD on the frozen slither.io client (task T17; SERVER-DESIGN 15.3, 15.4, 18.4 slxLayer HUD
// cases): slxCard, slxChat, slxStats, slxHud (Owen's HUD layout, 2026-10-16), slxSound. The results card and the
// leaderboard are drawn by the shared end screens every game uses (public/js/shared/dsEnd.js, Owen 2026-10-16), which
// the composed page loads before the layer, so every page here loads it first. The biggest cash-out box (slxTop) is
// gone (Owen 2026-10-16).
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
const DSEND = path.join(ROOT, 'public', 'js', 'shared', 'dsEnd.js');
const HUD = ['slxCard.js', 'slxChat.js', 'slxStats.js', 'slxHud.js', 'slxSound.js'];

// A page with the shared end screens and the HUD file(s) loaded on the fake bus.
function page(files, opts) {
  const P = makePage(opts);
  P.load('dsEnd.js');
  for (const f of [].concat(files)) P.load(f);
  return P;
}
// The shared card on screen (dsEnd's node, or null) and its text, its big figure and its buttons by id.
const cardEl = (P) => P.find('dse')[0] || null;
const bigText = (P) => (P.find('dse-big')[0] || { textContent: '' }).textContent;
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
    P.load('dsEnd.js');
    for (const f of HUD) P.load(f);
    assert.strictEqual(P.doc.body.childNodes.length, before.body, mode + ': body nodes');
    assert.strictEqual(P.doc.head.childNodes.length, before.head, mode + ': head nodes (dsEnd styles only when drawn)');
    assert.strictEqual(P.win.listeners.length, 0, mode + ': window listeners');
    assert.strictEqual(P.doc.listeners.length, 0, mode + ': document listeners');
    assert.strictEqual(P.rafCount(), 0, mode + ': animation frames');
    assert.strictEqual(P.sent.length, 0, mode + ': emits');
    if (P.D.slx) for (const k of ['card', 'chat', 'stats', 'hud', 'sound']) assert.strictEqual(P.D.slx[k], undefined, mode + ': slx.' + k);
  }
  // an active bus but no shared end screens (dsEnd.js missing): the card and the board make nothing either
  const P = makePage();
  P.S.lbh = P.S.lbs = P.S.lbn = P.S.lbp = new P.El(P.doc, 'div');
  P.load('slxCard.js');
  P.load('slxHud.js');
  assert.deepStrictEqual([P.doc.body.childNodes.length, P.doc.head.childNodes.length, P.rafCount()], [0, 0, 0]);
  assert.deepStrictEqual([P.slx.card, P.slx.hud], [undefined, undefined]);
  assert.strictEqual(P.S.lastscore.style.visibility, undefined, 'their last-score line left as it is');
  assert.strictEqual(P.S.lbs.style.visibility, undefined, 'their board left as it is');
});

test('slxCard: death card (the shared card) at their menu show, N from their last-score line, follows their fades', () => {
  const P = page('slxCard.js');
  const card = P.slx.card;
  const E = P.win.DSEnd;
  assert.strictEqual(card.state().kind, '', 'nothing before a life ends');
  assert.strictEqual(card.element, null);
  assert.strictEqual(P.S.lastscore.style.visibility, 'hidden', 'their last-score line stays in the page, unseen');
  P.slx.fire('open');
  P.slx.fire('ownAdd', { id: 1 });
  P.S.best_rank = 4;
  P.clock.now += 30000;
  P.S.best_rank = 3;                                      // their best_rank only falls during a life
  P.clock.now += 35000;
  P.slx.fire('ownDead', { type: 'dead', code: 0 });
  P.S.best_rank = 999999999;                              // their resetGame at the socket's close (slApply.js:1280)
  P.S.lastscore.innerHTML = LASTSCORE(1234);
  assert.strictEqual(card.element, null, 'the card waits for their 1.6 s');
  assert.strictEqual(E.shown(), false);
  P.clock.now += 1600;
  P.slx.fire('menuShow');
  let st = card.state();
  assert.strictEqual(st.kind, 'dead');
  assert.strictEqual(st.title, 'You died');
  assert.strictEqual(st.length, '1234');
  assert.deepStrictEqual([st.tone, st.hero, st.unit], ['plain', '1,234', 'length'], 'the length is the big figure');
  assert.deepStrictEqual(plain(st.facts), ['Time 1:05', 'Top rank 3rd', 'Kills 0'], 'from the own add to the death; the best rank kept; the server\'s kills');
  assert.deepStrictEqual([plain(st.ledger), st.status, plain(st.podium), plain(st.lines)], [[], '', [], []]);
  assert.strictEqual(st.again, 'Play again');
  assert.strictEqual(st.opacity, '0', 'their login layer is still transparent at menu show');
  assert.strictEqual(E.shown(), true);
  assert.strictEqual(card.element, cardEl(P));
  assert.strictEqual(card.element.style.opacity, '0');
  assert.strictEqual(card.element.style.zIndex, '30', 'above their login layer (z-index 20)');
  assert.strictEqual(card.element.style.zoom, '', 'a computer page: no zoom');
  assert.match(card.element.className, /^dse t-plain k-free slx-card$/, 'a layer control to slxWatch, slxBr and slxTouch');
  assert.strictEqual(card.element.textContent, 'You diedFreeLength1,234Time1:05Top rank3rdKills0LobbySpectatePlay againShare');   // a free game says Free; its score is the first tray row (Owen 2026-10-16)
  assert.deepStrictEqual(plain(st.buttons), ['Lobby', 'Spectate', 'Play again'], 'every death: Lobby, Spectate, Play again');
  assert.strictEqual(bigText(P), 'Free');
  P.slx.fire('menuFade', 0.25);
  assert.strictEqual(card.state().opacity, '0.75', 'opacity 1 - login_fr, as their login layer');
  assert.strictEqual(card.element.style.opacity, '0.75');
  P.slx.fire('menuFade', 0);
  P.slx.fire('menuDone');
  assert.strictEqual(card.state().opacity, '1');
  assert.strictEqual(card.element.style.opacity, '1');
  // the next life's start fade takes it away
  P.slx.fire('menuFade', 0.5);
  assert.strictEqual(card.state().opacity, '0.5');
  assert.strictEqual(card.element.style.opacity, '0.5');
  P.slx.fire('menuFade', 1);
  assert.strictEqual(card.state().kind, '');
  assert.strictEqual(card.element, null);
  assert.strictEqual(E.shown(), false);
  assert.strictEqual(cardEl(P), null, 'off the page');
  // a phone on a page of its own: their page is laid out at 0.7 (sl.html:4), so the card is drawn back up by 1 / 0.7
  const M = page('slxCard.js', { S: { is_mobile: true }, framed: false });
  M.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'full' });
  assert.strictEqual(M.slx.card.element.style.zoom, String(1 / 0.7));
  // a phone in the lobby's game frame: a frame ignores the viewport line, the page is at 1, nothing is drawn up
  const F = page('slxCard.js', { S: { is_mobile: true } });
  F.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'full' });
  assert.ok(!F.slx.card.element.style.zoom, 'no zoom in the frame');
});

test('slxCard: Killed by NAME from the kill feed naming this snake; another victim or a late line does not count', () => {
  const kill = (P, killer, victim) => P.slx.fire('x:kill', { t: 'kill', killer, victim });
  const P = page('slxCard.js');
  P.D.slMain = { nick: 'Owen' };
  P.slx.fire('open');
  kill(P, 'Viper', 'Ann');
  P.slx.fire('ownDead', { type: 'dead', code: 0 });
  P.clock.now += 1000;
  kill(P, 'Kestrel', 'Owen');                            // the feed line can trail the own dead
  P.S.lastscore.innerHTML = LASTSCORE(77);
  P.slx.fire('menuShow');
  assert.strictEqual(P.slx.card.state().title, 'Killed by Kestrel');
  assert.strictEqual(cardEl(P).textContent.indexOf('Killed by KestrelFreeLength77'), 0, 'the verdict over Free, the length first in the tray');
  P.slx.fire('menuFade', 1);
  // a new socket forgets it; a line more than 1.5 s after the death is someone else's
  P.slx.fire('open');
  kill(P, '', 'Owen');
  P.slx.fire('ownDead', { type: 'dead', code: 0 });
  P.clock.now += 2000;
  kill(P, 'Late', 'Owen');
  P.slx.fire('menuShow');
  assert.strictEqual(P.slx.card.state().title, 'You died');
  // no name (their Play kept none): never a match
  const Q = page('slxCard.js');
  Q.D.slMain = { nick: '' };
  Q.slx.fire('open');
  kill(Q, 'Viper', '');
  Q.slx.fire('ownDead', { type: 'dead', code: 0 });
  Q.slx.fire('menuShow');
  assert.strictEqual(Q.slx.card.state().title, 'You died');
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
    P.S.best_rank = 2;
    P.slx.fire('close', { playing: true, opened: true, sawDead: false, refused: c.refused || null });
    P.S.lastscore.innerHTML = LASTSCORE(57);                // their applyClose -> gameOver writes it
    P.S.best_rank = 999999999;                              // and its resetGame puts their best rank back
    assert.strictEqual(P.slx.card.state().kind, '', c.name + ': waits for their menu');
    P.slx.fire('menuShow');
    const st = P.slx.card.state();
    assert.strictEqual(st.kind, c.kind, c.name);
    assert.strictEqual(st.title, c.title, c.name);
    assert.strictEqual(st.length, '57', c.name);
    assert.strictEqual(bigText(P), 'Free', c.name + ': a free game says Free');
    assert.deepStrictEqual(plain(st.facts), ['Top rank 2nd'], c.name + ': the rank as the socket closed');
    assert.strictEqual(st.again, 'Play again', c.name);
    assert.deepStrictEqual(plain(st.buttons), ['Lobby', 'Play again'], c.name + ': a connection lost keeps its own buttons');
  }
  // cash-out: sl:x cashed arrives before the own dead (server/sl/slRoom.js _cashOut)
  const C = page('slxCard.js');
  C.slx.fire('open');
  C.slx.fire('x:cashed', { t: 'cashed', len: 812 });
  C.slx.fire('ownDead', { type: 'dead', code: 0 });
  C.S.lastscore.innerHTML = LASTSCORE(812);
  C.slx.fire('menuShow');
  assert.strictEqual(C.slx.card.state().title, 'Cashed out');
  assert.strictEqual(C.slx.card.state().length, '812');
  assert.deepStrictEqual(plain(C.slx.card.state().buttons), ['Lobby', 'Spectate', 'Play again'], 'every cash-out too');
  assert.strictEqual(bigText(C), 'Free', 'a free cash-out: Free as the big figure, the length in the tray, no money');
  assert.strictEqual(C.find('dse-led').length, 0);
  // a close while playing with no own snake: their gameOver cannot write a length, so the card shows none
  const N = page('slxCard.js', { S: { slither: null } });
  N.slx.fire('open');
  N.S.lastscore.innerHTML = LASTSCORE(99);                  // an older life's text
  N.slx.fire('close', { playing: true, opened: true, sawDead: false, refused: null });
  N.slx.fire('menuShow');
  assert.strictEqual(N.slx.card.state().title, 'Connection lost');
  assert.strictEqual(N.slx.card.state().length, '', 'no stale number');
  assert.deepStrictEqual([N.slx.card.state().hero, N.slx.card.state().unit, N.find('dse-hero').length], ['', '', 0],
    'no big figure');
  // a new socket forgets the last one
  N.slx.fire('open');
  N.slx.fire('ownDead', { type: 'dead', code: 0 });
  N.S.slither = { id: 4 };
  N.S.lastscore.innerHTML = LASTSCORE(10);
  N.slx.fire('menuShow');
  assert.strictEqual(N.slx.card.state().title, 'You died');
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
    assert.deepStrictEqual([st.hero, plain(st.facts)], ['', []], why + ': no big figure and no facts with no life');
    assert.strictEqual(st.opacity, '1', why);
    assert.strictEqual(st.again, 'Try again', why);
    assert.strictEqual(cardEl(P).textContent, title + 'LobbyTry again', why + ': on screen');   // Lobby left, the next step right (Owen 2026-10-16)
    assert.strictEqual(cardEl(P).style.opacity, '1', why);
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
  let touches = 0;
  let menus = 0;
  P.win.onmousedown = () => boosts++;                     // their boost (public/js/sl/slInput.js:148, 205)
  P.win.ontouchstart = () => touches++;                   // their steering (slInput.js:203)
  P.win.oncontextmenu = () => menus++;
  P.win.addEventListener('mouseup', () => ups++);         // their boost end (slInput.js:207)
  P.slx.fire('open');
  P.slx.fire('ownDead', {});
  P.S.lastscore.innerHTML = LASTSCORE(5);
  P.slx.fire('menuShow');
  const again = P.button('again');
  const lobby = P.button('lobby');
  assert.deepStrictEqual([again.textContent, lobby.textContent], ['Play again', 'Lobby']);
  assert.ok(/\bpri\b/.test(again.className), 'Play again is the primary button');
  P.dispatch(again, 'mousedown', { button: 0 });
  P.dispatch(again, 'touchstart', {});
  P.dispatch(again, 'mouseup', { button: 0 });
  P.dispatch(again, 'click', {});
  assert.deepStrictEqual(P.plays, ['Owen']);
  assert.strictEqual(P.slx.card.state().again, 'Starting');
  assert.strictEqual(P.slx.card.state().againDisabled, true);
  const starting = P.button('again');                     // the card is drawn again with the button's new state
  assert.deepStrictEqual([starting.textContent, starting.disabled], ['Starting', true]);
  P.dispatch(starting, 'click', {});
  P.dispatch(again, 'click', {});
  P.slx.card.playAgain();
  assert.deepStrictEqual(P.plays, ['Owen'], 'a second press does nothing');
  P.dispatch(P.button('lobby'), 'mousedown', { button: 0 });
  P.dispatch(P.button('lobby'), 'click', {});
  assert.deepStrictEqual(P.lobbyPosts, ['game:done']);
  P.dispatch(P.slx.card.element, 'contextmenu', {});
  P.dispatch(P.slx.card.element.firstChild, 'touchstart', {});    // the scrim round the card
  assert.strictEqual(boosts, 0, 'no mousedown reached their window.onmousedown');
  assert.strictEqual(touches, 0, 'no touch reached their window.ontouchstart');
  assert.strictEqual(menus, 0, 'no contextmenu reached their window');
  // fixer pass (2026-10-10): the mouseup goes on to their window listener (it only ends a boost), so a boost let go
  // over a layer element ends as in their game
  assert.strictEqual(ups, 1, 'the one mouseup reached their window listener');
  // a direct visit (no lobby frame): Lobby opens the lobby page
  const Q = page('slxCard.js', { framed: false });
  Q.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'full' });
  Q.dispatch(Q.button('lobby'), 'click', {});
  assert.deepStrictEqual(Q.win.location.assigned, ['/']);
  assert.deepStrictEqual(Q.lobbyPosts, []);
  // Try again on a refusal card plays too, under the same name
  Q.D.slMain = { nick: 'Ann' };
  Q.dispatch(Q.button('again'), 'click', {});
  assert.deepStrictEqual(Q.plays, ['Ann']);
});

// Owen 2026-10-16: "a Lobby, Spectate and Play again button exactly the same on every single cash-out and death screen".
test('slxCard: Lobby, Spectate, Play again on a free death and cash-out; Spectate reopens /sl watching as the lobby does', () => {
  const ss = {};
  const store = { getItem: (k) => (k in ss ? ss[k] : null), setItem: (k, v) => { ss[k] = String(v); }, removeItem: (k) => { delete ss[k]; } };
  // a free page as slBoot composes it: slxWatch (not a Spectate page: no mark), then the card
  const free = () => {
    for (const k of Object.keys(ss)) delete ss[k];
    Object.assign(ss, { playerName: 'Owen', dsWatchStake: '1' });   // a stale rung mark: taken out at boot
    const P = page(['slxWatch.js', 'slxCard.js'], { win: { sessionStorage: store } });
    P.D.slMain = { nick: 'Owen' };
    return P;
  };
  for (const kind of ['dead', 'cashed']) {
    const P = free();
    assert.strictEqual(P.slx.watch, undefined, kind + ': a plain free page, not a watcher');
    assert.strictEqual(typeof P.slx.watchOpen, 'function');
    P.slx.fire('open');
    P.slx.fire('ownAdd', { id: 1 });
    if (kind === 'cashed') P.slx.fire('x:cashed', { t: 'cashed', len: 40 });
    P.slx.fire('ownDead', { type: 'dead', code: 0 });
    P.S.lastscore.innerHTML = LASTSCORE(40);
    P.slx.fire('menuShow');
    const st = P.slx.card.state();
    assert.strictEqual(st.kind, kind);
    assert.deepStrictEqual(plain(st.buttons), ['Lobby', 'Spectate', 'Play again'], kind);
    // on screen in that order, one row: Lobby left, Spectate, Play again (the primary) right
    const row = P.find('dse-btn').map((b) => [b.textContent, b.getAttribute('data-dse-btn'), /\bpri\b/.test(b.className), b.disabled]);
    assert.deepStrictEqual(row, [['Lobby', 'lobby', false, false], ['Spectate', 'spectate', false, false],
      ['Play again', 'again', true, false]], kind + ': on screen');
    assert.deepStrictEqual([st.spectateShown, st.spectateDisabled], [true, false]);
    P.dispatch(P.button('spectate'), 'click', {});
    // the lobby's Spectate on the Free rung (public/js/v2/play.js spectate): the mark, no rung, nothing else written
    assert.deepStrictEqual(Object.keys(ss).sort(), ['dsWatch', 'playerName'], kind + ': no money key, no stake, no token');
    assert.strictEqual(ss.dsWatch, 'snake');
    assert.deepStrictEqual(P.win.location.replaced, ['/sl'], kind + ': the same page, reopened as a watcher');
    assert.deepStrictEqual([P.plays, P.lobbyPosts, P.win.location.assigned], [[], [], []], kind + ': no Play, no Lobby');
  }
  // while Play again is starting, Spectate is shown but does nothing
  const S2 = free();
  S2.slx.fire('open');
  S2.slx.fire('ownDead', {});
  S2.slx.fire('menuShow');
  S2.dispatch(S2.button('again'), 'click', {});
  let st = S2.slx.card.state();
  assert.deepStrictEqual([plain(st.buttons), st.spectateDisabled, st.againDisabled], [['Lobby', 'Spectate', 'Starting'], true, true]);
  S2.slx.card.spectate();
  S2.dispatch(S2.button('spectate'), 'click', {});
  assert.deepStrictEqual([S2.win.location.replaced, ss.dsWatch], [[], undefined], 'nothing while a Play starts');
  // a layer that keeps the page here (the exit trap) refuses Spectate as it refuses Lobby
  const K = free();
  let asked = 0;
  K.slx.beforeLobby = () => { asked++; return true; };
  K.slx.fire('open');
  K.slx.fire('ownDead', {});
  K.slx.fire('menuShow');
  K.dispatch(K.button('spectate'), 'click', {});
  K.dispatch(K.button('lobby'), 'click', {});
  assert.deepStrictEqual([asked, K.win.location.replaced, K.lobbyPosts, ss.dsWatch], [2, [], [], undefined]);
  // a layer that watches in place takes it (slxBr): go() is the card's own start
  const B = free();
  let took = 0;
  B.slx.beforeWatch = (go) => { took++; go(); return true; };
  B.slx.fire('open');
  B.slx.fire('ownDead', {});
  B.slx.fire('menuShow');
  B.dispatch(B.button('spectate'), 'click', {});
  assert.deepStrictEqual([took, B.plays, B.win.location.replaced], [1, ['Owen'], []]);
  st = B.slx.card.state();
  assert.deepStrictEqual([plain(st.buttons), st.spectateDisabled], [['Lobby', 'Spectate', 'Starting'], true]);
  // a notice keeps its own: a refusal, a connection lost, a layer's spectate: false
  const N = free();
  N.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'full' });
  assert.deepStrictEqual(plain(N.slx.card.state().buttons), ['Lobby', 'Try again']);
  N.slx.card.spectate();
  assert.deepStrictEqual(N.win.location.replaced, []);
  const W = free();
  W.slx.cardLines = () => ({ title: 'Watching', again: 'Watch next', spectate: false });
  W.slx.fire('open');
  W.slx.fire('ownDead', {});
  W.slx.fire('menuShow');
  assert.deepStrictEqual(plain(W.slx.card.state().buttons), ['Lobby', 'Watch next']);
  // a layer that leaves Play again off on a death: it is still there, unpressable
  const O = free();
  O.slx.cardLines = () => ({ again: false });
  O.slx.fire('open');
  O.slx.fire('ownDead', {});
  O.slx.fire('menuShow');
  st = O.slx.card.state();
  assert.deepStrictEqual([plain(st.buttons), st.againDisabled], [['Lobby', 'Spectate', 'Play again'], true]);
  O.dispatch(O.button('again'), 'click', {});
  assert.deepStrictEqual(O.plays, []);
});

// Owen 2026-10-16 ("this was a bad idea"): the biggest cash-out box is gone from the page and from the server's pushes.
// server/sl/slTopCashout.js stays (the earnings strip and playerStats read its TOP_ROWS: test/slTopCashout.test.js).
test('no biggest cash-out box: slxTop is off disk and out of the tail, the server reads none, their vcm box is theirs', () => {
  const B = require('../server/sl/slBoot.js');
  assert.ok(!fs.existsSync(path.join(SLX_DIR, 'slxTop.js')), 'slxTop.js is deleted');
  assert.ok(!B.SLX_FILES.includes('slxTop.js'), 'not in SLX_FILES');
  assert.ok(!/slxTop/.test(B.SLX_TAIL), 'not in the composed page');
  const idx = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(/\btopCashout: null,/.test(idx), 'index.js hands slBoot no top cash-out read');
  assert.ok(!/makeTopCashoutRead|setTop\b/.test(idx), 'no database read for it and no battle royale setTop wrapper');
  // the whole HUD on a page: a stray {t: 'top'} writes nothing, and their vcm box keeps their own text
  const P = makePage({ win: { CashoutSound: { play() {} } }, S: { playing: true } });
  P.load('dsEnd.js');
  for (const f of HUD) P.load(f);
  P.S.vcm.textContent = 'their longest snake';
  P.slx.fire('x:top', { t: 'top', name: 'Mosdfagg', amount: 1234.5 });
  P.raf(2);
  assert.strictEqual(P.S.vcm.textContent, 'their longest snake');
  assert.strictEqual(P.slx.top, undefined);
  assert.ok(!/Biggest cash-out/.test(P.doc.body.textContent));
});

// slxChat maps the wire into the shared chat (public/js/shared/dsChat.js), which /sl loads before the layer as it
// does dsEnd.js (server/sl/slBoot.js SHARED_UI); a test loads it the same way.
const chatPage = (opts) => page(['dsChat.js', 'slxChat.js'], opts);

test('slxChat: T opens, typing never reaches their keys, Enter sends, Esc closes; shown while playing', () => {
  const P = chatPage();
  const chat = P.slx.chat;
  const theirs = [];
  P.doc.onkeydown = (e) => theirs.push('down ' + e.keyCode);   // their handlers (public/js/sl/slInput.js:207-208)
  P.doc.onkeyup = (e) => theirs.push('up ' + e.keyCode);
  P.raf(1);
  assert.strictEqual(chat.element.hidden, true, 'hidden before their game shows');
  P.dispatch(P.doc.body, 'keydown', { key: 't', keyCode: 84 });
  assert.strictEqual(chat.typing(), false, 'T does nothing while hidden');
  P.S.playing = true;
  P.raf(1);
  assert.strictEqual(chat.element.hidden, false);
  // a boost held before the box opens still ends when it is let go
  P.dispatch(P.doc.body, 'keydown', { key: ' ', code: 'Space', keyCode: 32 });
  theirs.length = 0;
  P.dispatch(P.doc.body, 'keydown', { key: 't', code: 'KeyT', keyCode: 84 });
  assert.strictEqual(chat.typing(), true);
  assert.strictEqual(P.doc.activeElement, chat.input, 'the input has the focus');
  P.dispatch(chat.input, 'keyup', { key: ' ', code: 'Space', keyCode: 32 });
  assert.deepStrictEqual(theirs, ['up 32'], 'the opening T stopped at the window; the held Space let go reached them');
  theirs.length = 0;
  for (const [key, code, keyCode] of [[' ', 'Space', 32], ['ArrowLeft', 'ArrowLeft', 37], ['ArrowUp', 'ArrowUp', 38],
    ['q', 'KeyQ', 81], ['p', 'KeyP', 80], ['t', 'KeyT', 84]]) {
    P.dispatch(chat.input, 'keydown', { key, code, keyCode });
    P.dispatch(chat.input, 'keyup', { key, code, keyCode });
  }
  assert.deepStrictEqual(theirs, [], 'nothing typed in the box reached their keys');
  chat.input.value = '  hello   <world>  ';
  P.dispatch(chat.input, 'keydown', { key: 'Enter', keyCode: 13 });
  assert.deepStrictEqual(plain(P.sent), [['sl:chat', { text: 'hello <world>' }]], 'the server cleans; the page only trims');
  assert.strictEqual(chat.typing(), false);
  assert.notStrictEqual(P.doc.activeElement, chat.input);
  // Esc closes with nothing sent; an empty line sends nothing
  P.dispatch(P.doc.body, 'keydown', { key: 'T', keyCode: 84 });
  chat.input.value = 'nope';
  P.dispatch(chat.input, 'keydown', { key: 'Escape', keyCode: 27 });
  assert.strictEqual(chat.typing(), false);
  P.dispatch(P.doc.body, 'keydown', { key: 't', keyCode: 84 });
  chat.input.value = '   ';
  P.dispatch(chat.input, 'keydown', { key: 'Enter', keyCode: 13 });
  assert.strictEqual(P.sent.length, 1);
  // a blur closes
  P.dispatch(P.doc.body, 'keydown', { key: 't', keyCode: 84 });
  chat.input.blur();
  P.raf(1);
  assert.strictEqual(chat.typing(), false);
  // T is ignored while another text box on screen has the focus (the direct-visit name box) ...
  const other = P.doc.createElement('input');
  P.doc.body.appendChild(other);
  other.focus();
  P.dispatch(other, 'keydown', { key: 't', keyCode: 84 });
  assert.strictEqual(chat.typing(), false);
  // ... but not their hidden nickname box, which keeps the focus all game
  other.offsetWidth = 0;
  P.dispatch(other, 'keydown', { key: 't', keyCode: 84 });
  assert.strictEqual(chat.typing(), true);
  // the game ending hides the box and closes the input
  P.S.playing = false;
  P.raf(1);
  assert.strictEqual(chat.element.hidden, true);
  assert.strictEqual(chat.typing(), false);
});

test('slxChat: a press on the box never reaches their boost, a release always does; phones get a button', () => {
  const P = chatPage({ S: { playing: true } });
  const chat = P.slx.chat;
  P.raf(1);
  let boosts = 0;
  let ups = 0;
  P.win.onmousedown = () => boosts++;
  P.win.addEventListener('mouseup', () => ups++);
  P.dispatch(P.doc.body, 'keydown', { key: 't', keyCode: 84 });
  const [feed, row] = chat.element.children;          // the hint takes no pointer (pointer-events none)
  for (const el of [feed, row, chat.input]) P.dispatch(el, 'mousedown', { button: 0 });
  assert.strictEqual(boosts, 0);
  for (const el of [feed, row, chat.input]) P.dispatch(el, 'mouseup', { button: 0 });
  assert.strictEqual(ups, 3, 'their release ends the boost');
  assert.ok(/(^|\s)slx-chat(\s|$)/.test(chat.element.className), 'slxTouch leaves its touches alone (.slx-)');
  assert.strictEqual(chat.input.maxLength, 120, 'the input cap is the server cap (law C_CHAT maxLen)');
  const M = chatPage({ S: { is_mobile: true, playing: true } });
  M.raf(1);
  assert.ok(/dsc-phone/.test(M.slx.chat.element.className));
  const btn = M.find('dsc-btn')[0];
  M.dispatch(btn, 'click', {});
  assert.strictEqual(M.slx.chat.typing(), true, 'the chat button opens the box');
});

test('slxChat: lines, own lines, kill lines, notes, snake colours, 60 kept, text only', () => {
  const P = chatPage({ S: { playing: true, os: { s7: { cs: '#ff0000' } }, rrs: [10], ggs: [20], bbs: [200] } });
  const chat = P.slx.chat;
  P.raf(1);
  P.dispatch(P.doc.body, 'keydown', { key: 't', keyCode: 84 });
  chat.input.value = 'gg <3';
  P.dispatch(chat.input, 'keydown', { key: 'Enter', keyCode: 13 });
  P.slx.fire('x:chat', { t: 'chat', name: 'Ann', text: 'hi', id: 7, cv: 3 });
  P.slx.fire('x:chat', { t: 'chat', name: 'Owen', text: 'gg 3', id: 8, cv: 0 });    // the server stripped < and >
  P.slx.fire('x:chat', { t: 'chat', name: 'Bob', text: 'gg 3', id: 9, cv: 0 });     // the same words from someone else
  P.slx.fire('x:chat', { t: 'chat', name: '', text: 'who' });
  P.slx.fire('x:chat', { t: 'chat', name: 'x', text: '' });                          // nothing to show
  P.slx.fire('x:kill', { t: 'kill', killer: 'Bob', victim: 'Ann', kid: 9, vid: 7 });
  P.slx.fire('x:kill', { t: 'kill', killer: '', victim: 'Ann' });
  P.slx.fire('x:kill', { t: 'kill', killer: 'Bob', victim: '' });
  P.slx.fire('x:chatnote', { t: 'chatnote', text: 'Links can not be posted in chat.' });
  P.slx.fire('x:chat', { t: 'chat', name: '<img src=x>', text: '<script>1</script>' });
  const skull = String.fromCharCode(0xD83D, 0xDC80) + ' ';
  assert.deepStrictEqual(plain(chat.lines()), [
    'Ann: hi', 'Owen: gg 3', 'Bob: gg 3', 'Player: who',
    skull + 'Bob killed Ann', skull + 'Ann died', skull + 'Bob killed a snake',
    'Links can not be posted in chat.',
    '<img src=x>: <script>1</script>'
  ]);
  const rows = P.find('dsc-line');
  assert.deepStrictEqual(rows.map((r) => /dsc-me/.test(r.className)), [false, true, false, false, false, false, false, false, false]);
  assert.deepStrictEqual(rows.map((r) => /dsc-kill/.test(r.className)), [false, false, false, false, true, true, true, false, false]);
  assert.ok(/dsc-sys/.test(rows[7].className), 'a note is its own kind of line');
  // names in the snake's colour (lifted to read on the dark pill): the live snake's, else its skin's table colour
  assert.match(rows[0].style['--dsc-c'], /^rgb\(\d+,\d+,\d+\)$/);
  assert.match(rows[1].style['--dsc-c'], /^rgb\(\d+,\d+,\d+\)$/);
  assert.strictEqual(rows[3].style['--dsc-c'], undefined, 'no id and no skin: the plain name colour');
  // text only: what a player typed never becomes markup
  assert.strictEqual(P.doc.body.childNodes.some((n) => n.tagName === 'SCRIPT' || n.tagName === 'IMG'), false);
  for (let i = 0; i < 70; i++) P.slx.fire('x:chat', { t: 'chat', name: 'n', text: 'm' + i });
  const lines = chat.lines();
  assert.strictEqual(lines.length, 60);
  assert.strictEqual(lines[59], 'n: m69');
});

test('slxStats: the shared readout (dsPerfHud) timed on slx.echo, shown while playing; the diag keeps its own fps', () => {
  const P = makePage();
  P.load('dsEnd.js');
  P.load('dsPerfHud.js');
  P.load('slxStats.js');
  const st = P.slx.stats;
  assert.ok(st.hud && st.hud === P.win.DSPerfHud, 'the one shared readout');
  assert.strictEqual(P.find('dsp-hud').length, 1);
  assert.strictEqual(P.find('slx-stats').length, 0, 'no line of its own');
  assert.strictEqual(st.ping(), '-- ms');
  P.raf(1, 20);
  assert.strictEqual(P.echoes.length, 1, 'the echo goes on the first frame');
  P.raf(1, 20);
  P.echoes[0]();
  assert.strictEqual(st.ping(), '20 ms');
  P.slx.fire('pong', 300);                       // their ping record's round trip feeds the diag, not the readout
  assert.strictEqual(st.ping(), '20 ms');
  P.raf(25, 20);
  assert.strictEqual(st.fps(), 50);
  assert.strictEqual(P.find('dsp-fps')[0].textContent, 'FPS 50');
  assert.strictEqual(st.hud.element.hidden, true, 'hidden while their game is not showing');
  P.S.playing = true;
  P.raf(1, 20);
  assert.strictEqual(st.hud.element.hidden, false);
  P.setConnected(false);
  P.raf(1, 20);
  assert.strictEqual(st.ping(), '-- ms', 'off the socket: no number');
});

// Their HUD boxes as sl.html gives them (sl.html:20-26), on the fake page, after the shared end screens.
function hudPage(win, S, more) {
  const P = makePage(Object.assign({ win, S }, more || {}));
  const box = (style) => { const e = new P.El(P.doc, 'div'); Object.assign(e.style, style); P.doc.body.appendChild(e); return e; };
  P.S.lbh = box({ right: '4px', top: '4px', width: '285px', height: '28px', transform: 'translateZ(0)' });
  P.S.lbs = box({ right: '4px', top: '32px', width: '50px', height: '800px', transform: 'translateZ(0)' });
  P.S.lbn = box({ right: '64px', top: '32px', width: '180px', height: '800px', transform: 'translateZ(0)' });
  P.S.lbp = box({ right: '260px', top: '32px', width: '30px', height: '800px', transform: 'translateZ(0)' });
  P.S.lbf = box({ left: '8px', bottom: '4px', width: '280px', height: '37px', display: 'inline', opacity: 0.5 });
  P.S.loch = box({ right: '16px', bottom: '16px', width: '124px', height: '124px' });
  P.D.slMain = { nick: 'Owen' };
  P.load('dsEnd.js');
  P.load('dsPerfHud.js');
  P.load('slxStats.js');
  P.load('slxHud.js');
  P.raf(1);
  return P;
}
const span = (P, text, style) => {
  const e = new P.El(P.doc, 'span');
  Object.assign(e.style, style || {});
  e.textContent = text;
  return e;
};
// Their leaderboard write as their handler makes it (slApply.js onLeaderboard -> slHud.setLeaderboard: three innerHTML
// writes, so every child is new): rows [[name, length]] in place order, the own place (1-based, 0 for none) bold.
function theirBoard(P, rows, mine) {
  const S = P.S;
  for (const k of ['lbs', 'lbn', 'lbp']) S[k].textContent = '';
  rows.forEach(([name, len], i) => {
    const own = i + 1 === mine;
    S.lbs.appendChild(span(P, String(len), { opacity: own ? '1' : '0.7' }));
    S.lbs.appendChild(new P.El(P.doc, 'br'));
    S.lbn.appendChild(span(P, name, own ? { opacity: '1', fontWeight: 'bold' } : { opacity: '0.7' }));
    S.lbn.appendChild(new P.El(P.doc, 'br'));
    S.lbp.appendChild(span(P, '#' + (i + 1)));
    S.lbp.appendChild(new P.El(P.doc, 'br'));
  });
}
// Their length box write (slHud.js updateLengthBox, 275-288), in their words for lang.
function theirLengthBox(P, len, rank, count, words) {
  const w = words || ['Your length', 'of', 'Your rank'];
  const f = P.S.lbf;
  f.textContent = '';
  const top = span(P, '', { fontSize: '14px' });
  top.appendChild(span(P, w[0] + ': '));
  top.appendChild(span(P, String(len), { fontWeight: 'bold' }));
  f.appendChild(top);
  f.appendChild(new P.El(P.doc, 'br'));
  for (const t of [w[2] + ': ', String(rank), ' ' + w[1] + ' ', String(count)]) f.appendChild(span(P, t));
}
// Ours on screen: each row as rank|name|length (the own row starred), the gap as '...'.
function ourRows(P) {
  const b = P.find('dsb')[0];
  const ol = b.children[1];
  return ol.children.map((li) => (/\bgap\b/.test(li.className) ? '...'
    : li.children.map((c) => c.textContent).join('|') + (/\bme\b/.test(li.className) ? ' *' : '')));
}
const TEN = [['Ann', 9120], ['Bob', 8001], ['Owen', 7340], ['<b>x</b>', 6000], ['Cy', 5012], ['Di', 4100], ['Ed', 3300],
  ['Fay', 2200], ['Gus', 1500], ['Hal', 999]];

test('slxHud: their length box and four boxes hidden on every screen; the shared readout is left where it is', () => {
  for (const [w, h, mobile] of [[1920, 1080, false], [535, 1159, true], [500, 400, false]]) {
    const P = hudPage({ innerWidth: w, innerHeight: h }, { is_mobile: mobile });
    const S = P.S;
    const at = w + 'x' + h;
    assert.strictEqual(S.lbf.style.visibility, 'hidden', at + ': Your length / Your rank is gone');
    assert.strictEqual(S.lbf.style.display, 'inline', at + ': their display is untouched');
    for (const k of ['lbh', 'lbs', 'lbn', 'lbp']) {
      assert.strictEqual(S[k].style.visibility, 'hidden', at + ': their ' + k);
      assert.strictEqual(S[k].style.transform, 'translateZ(0)', at + ': ' + k + ' otherwise as sl.html gave it');
    }
    assert.deepStrictEqual([S.lbs.style.height, S.lbn.style.width, S.lbn.style.textOverflow], ['800px', '180px', undefined]);
    // their client writes their boxes' display and opacity (slHud.js onInit and the fades), never their visibility
    S.lbs.style.opacity = 1;
    S.lbs.style.display = 'inline';
    P.raf(2);
    assert.strictEqual(S.lbs.style.visibility, 'hidden', at + ': still hidden after their writes');
  }
  const P = hudPage({ innerWidth: 1920, innerHeight: 1080 });
  const S = P.S;
  assert.strictEqual(P.slx.hud.phone(), false);
  // the readout every game shares keeps its own corner (dsPerfHud's CSS): slxHud no longer places it by their minimap
  const st = P.slx.stats.hud.element.style;
  S.loch.style.width = S.loch.style.height = '160px';
  P.raf(1);
  assert.deepStrictEqual([st.right, st.width, st.bottom], [undefined, undefined, undefined]);
});

test('slxHud: ours is the shared board with their rows: names as text, lengths, the own row marked', () => {
  const P = hudPage({ innerWidth: 1920, innerHeight: 1080 }, { playing: true });
  const ours = P.find('dsb');
  assert.strictEqual(ours.length, 1, 'one board, made at load');
  const b = ours[0];
  assert.strictEqual(b.style.display, 'none', 'nothing before their first leaderboard');
  assert.strictEqual(b.style.zIndex, '10');
  assert.strictEqual(b.children[0].textContent, 'Leaderboard');
  theirBoard(P, TEN, 3);
  P.raf(1);
  assert.strictEqual(b.style.display, '', 'shown once their board has rows');
  assert.deepStrictEqual(ourRows(P), ['1|Ann|9,120', '2|Bob|8,001', '3|Owen|7,340 *', '4|<b>x</b>|6,000', '5|Cy|5,012',
    '6|Di|4,100', '7|Ed|3,300', '8|Fay|2,200', '9|Gus|1,500', '10|Hal|999'], 'all ten on a computer, a name stays text');
  const r = plain(P.slx.hud.rows());
  assert.strictEqual(r.rows.length, 10);
  assert.deepStrictEqual(r.rows[2], { name: 'Owen', value: '7,340', me: true });
  assert.deepStrictEqual(r.me, { rank: 3, name: 'Owen', value: '7,340' });
  // their next write (a new leaderboard) is read again; the same nodes are not
  theirBoard(P, [['Bob', 9500], ['Owen', 9400]], 2);
  P.raf(1);
  assert.deepStrictEqual(ourRows(P), ['1|Bob|9,500', '2|Owen|9,400 *']);
  P.S.lbn.childNodes[0].childNodes[0].data = 'not their write';
  P.raf(1);
  assert.deepStrictEqual(ourRows(P), ['1|Bob|9,500', '2|Owen|9,400 *'], 'read when their handler writes, not every frame');
  // beside the board when a centred block fits, under it when not
  b.getBoundingClientRect = () => ({ left: 1710, right: 1906, top: 14, bottom: 274, width: 196, height: 260 });
  assert.deepStrictEqual(plain(P.slx.hud.board()), { left: 1710, bottom: 274, width: 196 });
  assert.strictEqual(P.slx.hud.topSlot(300), 8);
  assert.strictEqual(P.slx.hud.topSlot(1600), 274 + 8);
  // a hidden board (no box) leaves the top free
  b.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
  assert.strictEqual(P.slx.hud.topSlot(1600), 8);
});

test('slxHud: a paid room ranks by $ from {t:lb}: names left, worth right, own row pinned with its worth', () => {
  const P = makePage({ win: { innerWidth: 1920, innerHeight: 1080 }, S: { playing: true } });
  const box = (style) => { const e = new P.El(P.doc, 'div'); Object.assign(e.style, style); P.doc.body.appendChild(e); return e; };
  for (const k of ['lbh', 'lbs', 'lbn', 'lbp', 'lbf', 'loch']) P.S[k] = box({});
  P.D.slMain = { nick: 'Owen' };
  P.D.slApply = { gdnm: (s) => !/\d{7}/.test(s) };
  P.D.slx.paid = { on: true };
  P.load('dsEnd.js');
  P.load('slxHud.js');
  P.raf(1);
  P.slx.fire('x:lb', { t: 'lb', rows: [['Bot A', 1200000], ['Owen', 450000], ['1234567', 400000]], me: [2, 450000] });
  P.raf(1);
  assert.deepStrictEqual(ourRows(P), [], 'nothing before their board shows');
  theirBoard(P, [['Owen', 900], ['Bot A', 50]], 1);
  P.raf(1);
  assert.deepStrictEqual(ourRows(P), ['1|Bot A|$1.20', '2|Owen|$0.45 *', '3||$0.40'], 'money order, not their lengths');
  assert.ok(P.find('dsb')[0].className.split(' ').includes('money'), 'the gold money board');
  P.slx.fire('x:lb', { t: 'lb', rows: [['Bot A', 1200000]], me: [7, 50000] });
  P.raf(1);
  assert.deepStrictEqual(ourRows(P), ['1|Bot A|$1.20', '...', '7|Owen|$0.05 *']);
});

test('slxHud: a watcher of a paid rung (no paid page) turns to the $ board on the first {t:lb}, no own row', () => {
  const P = makePage({ win: { innerWidth: 1920, innerHeight: 1080 }, S: { playing: false } });
  const box = (style) => { const e = new P.El(P.doc, 'div'); Object.assign(e.style, style); P.doc.body.appendChild(e); return e; };
  for (const k of ['lbh', 'lbs', 'lbn', 'lbp', 'lbf', 'loch']) P.S[k] = box({});
  P.D.slMain = { nick: '' };
  P.load('dsEnd.js');
  P.load('slxHud.js');
  theirBoard(P, [['Bot A', 900], ['Ann', 50]], -1);
  P.raf(1);
  assert.deepStrictEqual(ourRows(P), ['1|Bot A|900', '2|Ann|50'], 'lengths before any {t:lb}');
  P.slx.fire('x:lb', { t: 'lb', rows: [['Ann', 1200000], ['Bot A', 450000]], me: null });
  P.raf(1);
  assert.deepStrictEqual(ourRows(P), ['1|Ann|$1.20', '2|Bot A|$0.45'], 'money order, not their lengths');
  assert.ok(P.find('dsb')[0].className.split(' ').includes('money'), 'the gold money board');
  theirBoard(P, [['Bot A', 950], ['Ann', 60]], -1);
  P.raf(1);
  assert.deepStrictEqual(ourRows(P), ['1|Ann|$1.20', '2|Bot A|$0.45'], 'their later writes keep the $ board');
});

test('slxHud: own row pinned when outside the top; top 5 on a phone, 10 on a computer; follows their fade', () => {
  // a computer: their board without the own row (rank 25): pinned from their length box while playing
  const P = hudPage({ innerWidth: 1280, innerHeight: 720 }, { playing: true });
  theirLengthBox(P, 321, 25, 60);
  theirBoard(P, TEN.filter((r) => r[0] !== 'Owen').concat([['Ivy', 900]]), 0);
  P.raf(1);
  assert.deepStrictEqual(ourRows(P).slice(-3), ['10|Ivy|900', '...', '25|Owen|321 *']);
  assert.strictEqual(ourRows(P).length, 12);
  // another language's words (slHud.js lengthWords): the same numbers
  theirLengthBox(P, 4321, 12, 40, ['Deine Länge', 'von', 'Dein rang']);
  P.raf(1);
  assert.deepStrictEqual(ourRows(P).slice(-1), ['12|Owen|4,321 *']);
  // not playing: no own row to pin
  P.S.playing = false;
  theirBoard(P, TEN.slice(0, 2), 0);
  P.raf(1);
  assert.deepStrictEqual(ourRows(P), ['1|Ann|9,120', '2|Bob|8,001']);
  // a phone (their is_mobile) on a page of its own: the top 5, drawn back up from their 0.7 page; the own row at 7
  // is pinned from theirs
  const M = hudPage({ innerWidth: 535, innerHeight: 1159 }, { is_mobile: true, playing: true }, { framed: false });
  assert.strictEqual(M.slx.hud.phone(), true);
  assert.strictEqual(M.find('dsb')[0].style.zoom, String(1 / 0.7));
  assert.strictEqual(M.slx.hud.zoom(), 1 / 0.7);
  // the same phone in the lobby's game frame (a frame ignores the viewport line): the page is at 1, dsEnd's phone size
  const F = hudPage({ innerWidth: 375, innerHeight: 812 }, { is_mobile: true, playing: true });
  assert.strictEqual(F.slx.hud.phone(), true);
  assert.ok(!F.find('dsb')[0].style.zoom, 'no zoom in the frame');
  assert.strictEqual(F.slx.hud.zoom(), 1);
  const seventh = TEN.slice();
  seventh.splice(2, 1);
  seventh.splice(6, 0, ['Owen', 3200]);
  theirBoard(M, seventh, 7);
  M.raf(1);
  assert.deepStrictEqual(ourRows(M), ['1|Ann|9,120', '2|Bob|8,001', '3|<b>x</b>|6,000', '4|Cy|5,012', '5|Di|4,100', '...',
    '7|Owen|3,200 *']);
  assert.deepStrictEqual(plain(M.slx.hud.rows().me), { rank: 7, name: 'Owen', value: '3,200' });
  // inside the top 5: marked in place, nothing pinned
  theirBoard(M, TEN, 3);
  M.raf(1);
  assert.deepStrictEqual(ourRows(M), ['1|Ann|9,120', '2|Bob|8,001', '3|Owen|7,340 *', '4|<b>x</b>|6,000', '5|Cy|5,012']);
  // the row count follows the window: a computer size gets all ten, a computer window this small the top 5
  M.S.is_mobile = false;
  M.win.innerWidth = 1280;
  M.win.innerHeight = 720;
  M.raf(1);
  assert.strictEqual(M.slx.hud.phone(), false);
  assert.strictEqual(ourRows(M).length, 10);
  M.win.innerWidth = 1000;
  M.win.innerHeight = 500;
  M.raf(1);
  assert.strictEqual(M.slx.hud.phone(), true, 'a short side of 520 px or less');
  assert.strictEqual(ourRows(M).length, 5);
  M.win.innerWidth = 1280;
  M.win.innerHeight = 720;
  M.raf(1);
  // their fades: ours shows and goes when theirs would
  const b = M.find('dsb')[0];
  const lbs = M.S.lbs.style;
  lbs.opacity = 0.4;
  M.raf(1);
  assert.deepStrictEqual([b.style.display, b.style.opacity], ['', '0.4'], 'their lb_fr on our board');
  lbs.opacity = 1;
  M.raf(1);
  assert.deepStrictEqual([b.style.display, b.style.opacity], ['', '1']);
  lbs.opacity = 0;
  M.raf(1);
  assert.strictEqual(b.style.display, 'none', 'their fade out at a death');
  lbs.opacity = 1;
  lbs.display = 'none';
  M.raf(1);
  assert.strictEqual(b.style.display, 'none', 'their boxes off');
  lbs.display = 'inline';
  M.raf(1);
  assert.strictEqual(b.style.display, '');
  theirBoard(M, [], 0);
  M.raf(1);
  assert.strictEqual(b.style.display, 'none', 'no rows, no board');
  assert.strictEqual(M.slx.errors, 0);
});

test('slxBr: every event line in one block at the top centre, in the slot slxHud keeps clear', () => {
  const store = { slBr: 'play' };
  const P = makePage({ win: { setInterval: () => 0, sessionStorage: { getItem: (k) => store[k] || null, removeItem: (k) => { delete store[k]; } } } });
  const slots = [];
  P.slx.hud = { phone: () => false, topSlot: (w) => { slots.push(w); return 110; } };
  P.doc.querySelector = () => null; // no phone CASH OUT button on this page
  P.load('slxBr.js');
  const [hud] = P.find('slx-br-hud');
  assert.ok(hud, 'the block');
  assert.strictEqual(P.find('slx-br-big').length, 0, 'nothing in the middle of the screen');
  const [head, sub, start] = hud.children;
  assert.deepStrictEqual([head.className, sub.className, start.className], ['slx-br-head', 'slx-br-sub', 'slx-br-start slx-br-ui']);
  const br = (m) => { P.slx.fire('x:br', Object.assign({ t: 'br', z: null }, m)); P.raf(1); };
  br({ state: 'waiting', phase: 'waiting', alive: 48, nextStartMs: 3723500 });
  assert.deepStrictEqual([head.textContent, sub.textContent], ['Battle Royale', '48 players · next match in 1h 2m 3s']);
  assert.strictEqual(hud.style.top, '110px', 'the slot');
  assert.ok(!/slx-br-now/.test(hud.className));
  // it comes in with the game (their menu fades out, the game in), never over their menu while the wallet signs
  assert.ok(!/slx-br-in/.test(hud.className), 'not over their menu before the first life');
  P.S.playing = true;
  P.raf(1);
  assert.ok(/slx-br-in/.test(hud.className), 'in with the game');
  // the bigger phone sizes only on a page laid out at 0.7 (zoom > 1); in the lobby's frame a phone keeps the plain ones
  P.slx.hud.phone = () => true;
  P.slx.hud.zoom = () => 1;
  P.raf(1);
  assert.ok(!/slx-br-phone/.test(hud.className), 'a phone in the lobby frame');
  P.slx.hud.zoom = () => 1 / 0.7;
  P.raf(1);
  assert.ok(/slx-br-phone/.test(hud.className), 'a phone page of its own');
  P.slx.hud.phone = () => false;
  P.raf(1);
  // the scheduled start's 30 s join window (Owen 2026-10-26): counted down with the doors open, big for its last 10 s,
  // and held at Starting through the second or two until the server's start arrives
  br({ state: 'waiting', phase: 'waiting', alive: 30, nextStartMs: 21400, joinWindowMs: 30000 });
  assert.deepStrictEqual([head.textContent, sub.textContent], ['Starting in 22', '30 players · hold Q to leave']);
  assert.ok(!/slx-br-now/.test(hud.className), 'not the big moment yet');
  br({ state: 'waiting', phase: 'waiting', alive: 30, nextStartMs: 8200, joinWindowMs: 30000 });
  assert.strictEqual(head.textContent, 'Starting in 9');
  assert.ok(/slx-br-now/.test(hud.className), 'its last 10 s are');
  P.raf(600, 16);
  assert.deepStrictEqual([head.textContent, sub.textContent], ['Starting', '30 players · last snake alive wins']);
  P.raf(200, 16);
  assert.deepStrictEqual([head.textContent, sub.textContent], ['Battle Royale', '30 players · next match in 0m 0s'],
    'a start that never came is not held forever');
  // the owner's countdown: the doors are open through it too
  br({ state: 'countdown', phase: 'countdown', alive: 12, countdownMs: 7000, prize: 20 });
  assert.deepStrictEqual([head.textContent, sub.textContent], ['Starting in 7', '12 players · hold Q to leave · $20 to the winner']);
  assert.ok(/slx-br-now/.test(hud.className), 'the count is the big moment');
  br({ state: 'running', phase: 'warning', alive: 12, startedCount: 12, elapsedMs: 100, zoneMs: 9000 });
  assert.strictEqual(head.textContent, 'GO');
  P.raf(80, 16);
  assert.deepStrictEqual([head.textContent, sub.textContent], ['Next circle', '12 of 12 left · circle closes in 8s']);
  assert.ok(!/slx-br-now/.test(hud.className));
  br({ state: 'running', phase: 'closing', alive: 8, startedCount: 12, elapsedMs: 60000 });
  assert.deepStrictEqual([head.textContent, sub.textContent], ['Circle closing', '8 of 12 left · get inside the circle']);
  br({ state: 'over', phase: 'over', alive: 1, startedCount: 12, winner: { id: 7, name: 'Viper' } });
  assert.deepStrictEqual([head.textContent, sub.textContent], ['Viper wins', 'Last snake alive of 12']);
  br({ state: 'reopening', phase: 'reopening', alive: 30, startedCount: 12, winner: { id: 7, name: 'Viper' } });
  assert.deepStrictEqual([head.textContent, sub.textContent], ['Match over', 'Viper won']);
  // no startedCount (the old engine, a page that came in late): the count alone
  br({ state: 'running', phase: 'holding', alive: 5, elapsedMs: 90000 });
  assert.strictEqual(sub.textContent, '5 left · last snake alive wins');
  assert.ok(slots.length > 0 && slots.every((w) => typeof w === 'number'), 'asks for the slot with its width');
});

// The battle royale's card answers (slxBr cardLines) drawn by slxCard on the shared card: a decided match.
test('slxBr cards on the shared card: a win (1st of N, the podium, the prize as money), a loss, unproven and solo', async () => {
  const ORIGIN = 'https://duelseries.com';
  async function brLife(o) {
    const store = { slBr: 'play' };
    const posted = [];
    const parent = { postMessage: (m, origin) => posted.push([m, origin]) };
    const P = makePage({ win: { setInterval: () => 0, parent,
      location: { origin: ORIGIN, assigned: [], assign(u) { this.assigned.push(String(u)); } },
      sessionStorage: { getItem: (k) => store[k] || null, removeItem: (k) => { delete store[k]; } } } });
    P.slx.hud = { phone: () => false, topSlot: () => 8 };
    P.doc.querySelector = () => null;
    P.D.slMain = { nick: 'Owen' };
    P.load('dsEnd.js');
    P.load('slxBr.js');
    P.load('slxCard.js');
    // the lobby's first Play: the wallet's identity proof, then their Play
    P.slx.brLaunch('Owen');
    const ask = posted[0][0];
    assert.deepStrictEqual([ask.type, ask.action], ['duel:signaction', 'play:identify']);
    if (o.proven) {
      for (const l of P.win.listeners.filter((x) => x.type === 'message')) {
        l.fn({ source: parent, origin: ORIGIN, data: { type: 'duel:signaction:done', id: ask.id, proof: { sig: 'x' } } });
      }
    } else {
      for (const l of P.win.listeners.filter((x) => x.type === 'message')) {
        l.fn({ source: parent, origin: ORIGIN, data: { type: 'duel:signaction:error', id: ask.id } });
      }
    }
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(P.plays, ['Owen']);
    P.slx.fire('open');
    P.slx.fire('ownAdd', { id: o.me });
    P.clock.now += 95000;
    P.slx.fire('x:br', Object.assign({ t: 'br', state: 'over', phase: 'over', alive: 1, startedCount: 12, prize: 20, z: null,
      winner: { id: 7, name: o.podium[0] }, podium: o.podium.map((name) => ({ name })) }, o.br || {}));
    P.slx.fire('ownDead', { type: 'dead', code: 0 });
    P.S.lastscore.innerHTML = LASTSCORE(500);
    P.slx.fire('menuShow');
    return P;
  }
  const W = await brLife({ proven: true, me: 7, podium: ['Owen', 'Viper', 'Kes'] });
  let st = W.slx.card.state();
  assert.deepStrictEqual([st.title, st.tone, st.hero, st.unit], ['You won!', 'win', '1st', 'of 12']);
  assert.deepStrictEqual(plain(st.podium), ['1 Owen', '2 Viper', '3 Kes']);
  assert.deepStrictEqual([plain(st.ledger), st.status], [['Prize $20'], 'Sending to your wallet']);
  assert.deepStrictEqual(plain(st.facts), ['Time 1:35', 'Length 500', 'Kills 0'], 'the length moves into the facts');
  // Lobby, Spectate and the next match (Owen 2026-10-16): no match open to join yet, so it says so, unpressable
  assert.deepStrictEqual([plain(st.buttons), st.againDisabled, st.spectateDisabled, plain(st.lines)],
    [['Lobby', 'Spectate', 'Next match opening'], true, false, []]);
  assert.deepStrictEqual(W.find('dse-pod')[0].children.map((li) => [li.className, li.textContent]),
    [['me', '1Owen'], ['', '2Viper'], ['', '3Kes']], 'the own row marked on the podium');
  assert.deepStrictEqual(W.find('dse-lr').map((r) => [r.className, r.textContent]), [['dse-lr', 'Prize$20']]);
  assert.strictEqual(W.find('dse-st')[0].textContent, 'Sending to your wallet');
  assert.ok(/\bt-win\b/.test(W.slx.card.element.className));
  // a win whose wallet never signed: the prize is settled by hand, no money rows
  const U = await brLife({ proven: false, me: 7, podium: ['Owen', 'Viper'] });
  st = U.slx.card.state();
  assert.deepStrictEqual([st.title, st.hero, plain(st.ledger), st.status, plain(st.lines)],
    ['You won!', '1st', [], '', ['The prize is settled by hand.']]);
  // a solo test run: no prize
  const O = await brLife({ proven: true, me: 7, podium: ['Owen'], br: { soloRun: true, startedCount: 1 } });
  st = O.slx.card.state();
  assert.deepStrictEqual([st.title, st.hero, st.unit, plain(st.ledger), plain(st.lines)],
    ['You won!', '1st', '', [], ['Solo test run: no prize.']]);
  // a loss: the length is the big figure, the own name marked where the podium has it, who took the prize
  const L = await brLife({ proven: true, me: 8, podium: ['Viper', 'Owen', 'Kes'] });
  st = L.slx.card.state();
  assert.deepStrictEqual([st.title, st.tone, st.hero, st.unit], ['Match over', 'plain', '500', 'length']);
  assert.deepStrictEqual(plain(st.podium), ['1 Viper', '2 Owen', '3 Kes']);
  assert.deepStrictEqual(L.find('dse-pod')[0].children.map((li) => li.className), ['', 'me', '']);
  assert.deepStrictEqual([plain(st.ledger), st.status, plain(st.lines)], [[], '', ['First place took $20.']]);
  assert.deepStrictEqual(plain(st.facts), ['Time 1:35', 'Kills 0']);
  // the arena reopened (Owen 2026-10-16): the result stays up, and the button is Join next
  L.slx.fire('x:br', { t: 'br', state: 'waiting', phase: 'waiting', alive: 30, prize: 20, z: null,
    winner: { id: 7, name: 'Viper' }, podium: [{ name: 'Viper' }, { name: 'Owen' }, { name: 'Kes' }] });
  st = L.slx.card.state();
  assert.deepStrictEqual([st.title, st.again, !!st.againDisabled], ['Match over', 'Join next', false]);
  assert.deepStrictEqual(plain(st.buttons), ['Lobby', 'Spectate', 'Join next'], 'Lobby left, Spectate, the next match right');
  assert.deepStrictEqual(plain(st.podium), ['1 Viper', '2 Owen', '3 Kes']);
  // the next match counts down: the result is gone
  L.slx.fire('x:br', { t: 'br', state: 'countdown', phase: 'countdown', alive: 30, prize: 20, z: null, countdownMs: 9000,
    winner: null, podium: null });
  st = L.slx.card.state();
  assert.notStrictEqual(st.title, 'Match over');
  // out while the match runs: Spectate and Lobby only, never Play again (a death is out for the match)
  const R = await brLife({ proven: true, me: 8, podium: ['x'],
    br: { state: 'running', phase: 'closing', alive: 5, winner: null, podium: null } });
  st = R.slx.card.state();
  assert.deepStrictEqual([st.title, plain(st.buttons)], ['You are out', ['Lobby', 'Spectate']]);
  const btns = R.find('dse-btn').map((b) => b.textContent);
  assert.ok(btns.length === 2 && btns.some((t) => /Lobby/.test(t)) && btns.some((t) => /Spectate/.test(t)), btns.join('|'));
  assert.ok(!btns.some((t) => /Play again/.test(t)), 'no Play again anywhere on the card');
});

test('slxBr: out of a running match, Lobby and Spectate only; Play again once the next is open', async () => {
  const ORIGIN = 'https://duelseries.com';
  async function brOut(br) {
    const store = { slBr: 'play' };
    const posted = [];
    const parent = { postMessage: (m, origin) => posted.push([m, origin]) };
    const P = makePage({ win: { setInterval: () => 0, parent,
      location: { origin: ORIGIN, assigned: [], replaced: [], assign(u) { this.assigned.push(String(u)); }, replace(u) { this.replaced.push(String(u)); } },
      sessionStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } } } });
    P.slx.hud = { phone: () => false, topSlot: () => 8 };
    P.doc.querySelector = () => null;
    P.D.slMain = { nick: 'Owen' };
    P.load('dsEnd.js');
    P.load('slxBr.js');
    P.load('slxWatch.js');                        // as composed: its watchOpen is there, the event's own watch wins
    P.load('slxCard.js');
    P.slx.brLaunch('Owen');
    const ask = posted[0][0];
    for (const l of P.win.listeners.filter((x) => x.type === 'message')) {
      l.fn({ source: parent, origin: ORIGIN, data: { type: 'duel:signaction:done', id: ask.id, proof: { sig: 'x' } } });
    }
    await new Promise((r) => setImmediate(r));
    P.slx.fire('open');
    P.slx.fire('ownAdd', { id: 8 });
    P.slx.fire('x:br', Object.assign({ t: 'br', state: 'running', phase: 'closing', alive: 5, startedCount: 12, prize: 20,
      z: null }, br || {}));
    P.slx.fire('ownDead', { type: 'dead', code: 0 });
    P.S.lastscore.innerHTML = LASTSCORE(300);
    P.slx.fire('menuShow');
    return Object.assign(P, { store, posted });
  }
  // a death mid-match: no match to join, so no Play again at all (Owen 2026-10-16: "they can't play again until the
  // next game"); Spectate watches this match here
  const R = await brOut();
  let st = R.slx.card.state();
  assert.deepStrictEqual([st.title, plain(st.buttons), st.spectateDisabled], ['You are out', ['Lobby', 'Spectate'], false]);
  assert.deepStrictEqual(plain(st.lines), ['5 still alive. Spectate to the end, or wait for the next match.']);
  assert.strictEqual(R.button('again'), null, 'no Play again while the match runs');
  R.dispatch(R.button('spectate'), 'click', {});
  assert.deepStrictEqual(R.plays, ['Owen', 'Owen'], 'the next life starts at once, on this page');
  assert.strictEqual(R.slx.br.mode(), 'watch');
  assert.deepStrictEqual(plain(R.slx.brAuth()), { br: 1, watch: 1 }, 'a watcher: no proof, no seat');
  assert.deepStrictEqual([R.win.location.replaced, R.store.dsWatch, R.posted.length], [[], undefined, 1],
    'not reopened, no free-room mark, no second signature asked');
  // the watcher's own card between watched lives keeps Spectate next
  R.slx.fire('open');
  R.slx.fire('x:watch', { t: 'watch', id: 3, name: 'Kes' });
  R.slx.fire('ownDead', { type: 'dead', code: 0 });
  R.slx.fire('menuShow');
  st = R.slx.card.state();
  assert.deepStrictEqual([st.title, plain(st.buttons)], ['Watching', ['Lobby', 'Spectate next']]);
  // between matches: Play again joins the next one with a fresh proof
  const B = await brOut({ state: 'waiting', phase: 'waiting', alive: 3, nextStartMs: 600000 });
  st = B.slx.card.state();
  assert.deepStrictEqual([plain(st.buttons), st.againDisabled], [['Lobby', 'Spectate', 'Play again'], false]);
  B.dispatch(B.button('again'), 'click', {});
  assert.strictEqual(B.posted.length, 2, 'Play again asks the wallet for a fresh proof first');
  assert.strictEqual(B.slx.br.mode(), 'play');
  // a refusal's card keeps its own button
  const M = await brOut();
  M.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'match' });
  assert.deepStrictEqual(plain(M.slx.card.state().buttons), ['Lobby', 'Spectate']);
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

// A fake sound engine with DSSfx's face (public/js/dsSfx.js): every play is recorded with the level in force.
function sfxFake() {
  const F = {
    plays: [],
    level: null,
    setLevel(fn) { F.level = fn; },
    play(name, o) {
      const lv = F.level ? F.level() : 1;
      F.plays.push({ name, o: o || {}, lv });
      return lv > 0;
    }
  };
  return F;
}
const heard = (F) => F.plays.map((p) => p.name);
const soundPage = (opts) => {
  const F = sfxFake();
  const P = page('slxSound.js', Object.assign({}, opts, { win: Object.assign({ DSSfx: F }, opts && opts.win) }));
  P.F = F;
  return P;
};

test('slxSound: join once per socket, death unless cashed, kill when the own count rises, cash-out; all through DSSfx', () => {
  const P = soundPage();
  const F = P.F;
  const played = () => P.slx.sound.played();
  assert.strictEqual(typeof F.level, 'function', 'the page volume is DSSfx\'s level');
  assert.strictEqual(F.level(), 0.5, 'master 1 x sfx 0.5, the old defaults (game.js:234)');
  P.slx.fire('open');
  P.slx.fire('ownAdd', { id: 1 });
  P.slx.fire('ownAdd', { id: 1 });
  assert.deepStrictEqual(plain(played()), { join: 1, death: 0, kill: 0, cashout: 0 });
  assert.deepStrictEqual(heard(F), ['g.join']);
  P.slx.fire('ownKills', { id: 1, count: 1 });
  P.slx.fire('ownKills', { id: 1, count: 1 });
  P.slx.fire('ownKills', { id: 1, count: 3 });
  assert.strictEqual(played().kill, 2);
  P.slx.fire('ownDead', { code: 0 });
  assert.strictEqual(played().death, 1);
  assert.deepStrictEqual(heard(F), ['g.join', 'g.kill', 'g.kill', 'g.death']);
  // a cash-out socket: the cash-out sound, and no death sound for its own dead
  P.slx.fire('open');
  P.slx.fire('ownKills', { id: 2, count: 1 });
  assert.strictEqual(played().kill, 3, 'the count starts over with each socket');
  P.slx.fire('x:cashed', { t: 'cashed', len: 40 });
  P.slx.fire('x:cashed', { t: 'cashed', len: 40 });
  P.slx.fire('ownDead', { code: 0 });
  assert.deepStrictEqual(plain(played()), { join: 1, death: 1, kill: 3, cashout: 1 });
  assert.deepStrictEqual(heard(F).slice(4), ['g.kill', 'g.cashout']);
  // gold eaten in a paid room: only a positive d
  P.slx.fire('x:w', { t: 'w', d: 0 });
  P.slx.fire('x:w', { t: 'w' });
  assert.strictEqual(P.slx.sound.money(), 0);
  P.slx.fire('x:w', { t: 'w', d: 120 });
  assert.strictEqual(P.slx.sound.money(), 1);
  assert.strictEqual(heard(F).pop(), 'g.pickup');
  // the volume globals are read on every play; muted is level 0
  P.win.gameMasterVol = 0.8;
  P.win.gameSfxVol = 0.5;
  assert.strictEqual(F.level(), 0.4);
  P.win.gameMuted = true;
  assert.strictEqual(F.level(), 0);
  P.slx.fire('open');
  P.slx.fire('ownAdd', { id: 3 });
  assert.strictEqual(F.plays.pop().lv, 0, 'asked for but silent');
  assert.strictEqual(played().join, 2, 'still counted');
});

test('slxSound: no context, listeners or scripts of its own; with no engine on the page every sound is a no-op', () => {
  const P = soundPage();
  assert.strictEqual(P.doc.head.children.filter((e) => e.tagName === 'SCRIPT').length, 0, 'no cash-out file to load');
  assert.strictEqual(P.win.listeners.length, 0, 'the engine unlocks itself on the first gesture');
  assert.strictEqual(P.doc.listeners.length, 0);
  const src = fs.readFileSync(path.join(SLX_DIR, 'slxSound.js'), 'utf8');
  assert.ok(!/AudioContext|createOscillator|createGain/.test(src), 'no Web Audio of its own');
  // no engine: nothing throws, the counts still count
  const R = page('slxSound.js');
  R.slx.fire('open');
  R.slx.fire('ownAdd', {});
  R.slx.fire('x:cashed', {});
  R.slx.fire('x:refused', { why: 'full' });
  R.slx.fire('x:chat', { name: 'Ann', text: 'hi' });
  assert.deepStrictEqual(plain(R.slx.sound.played()), { join: 1, death: 0, kill: 0, cashout: 1 });
  // an engine that appears later is bound at the first sound
  const L = page('slxSound.js');
  const F = sfxFake();
  L.win.DSSfx = F;
  L.slx.fire('open');
  L.slx.fire('ownAdd', { id: 1 });
  assert.strictEqual(typeof F.level, 'function');
  assert.deepStrictEqual(heard(F), ['g.join']);
});

test('slxSound: the own food_eat is a soft pat per frame (rate 0.9 to 1.25, 40 ms apart); others, a watcher, no snake: silent', () => {
  const P = soundPage();
  const F = P.F;
  const eat = (id) => ({ type: 'food_eat', cmd: '<', eater: id });
  P.slx.fire('open');
  P.slx.fire('frame', [eat(7)], 100);
  assert.deepStrictEqual(heard(F), [], 'no own snake yet');
  P.S.slither = { id: 7 };
  P.slx.fire('frame', [{ type: 'pong' }, eat(3), eat(9)], 100);
  assert.deepStrictEqual(heard(F), [], 'other snakes\' food');
  P.slx.fire('frame', [eat(3), eat(7), eat(7), eat(7)], 100);
  assert.deepStrictEqual(heard(F), ['g.eat'], 'one pat for a frame of many');
  assert.strictEqual(F.plays[0].o.gap, 40);
  for (let i = 0; i < 40; i++) P.slx.fire('frame', [eat(7)], 100);
  const rates = F.plays.map((p) => p.o.rate);
  assert.ok(rates.every((r) => r >= 0.9 && r <= 1.25), 'rates ' + rates.join(','));
  assert.ok(new Set(rates).size > 20, 'a different pitch each time');
  assert.deepStrictEqual(new Set(heard(F)), new Set(['g.eat']));
  const n = F.plays.length;
  P.slx.br = { mode: () => 'watch' };
  P.slx.fire('frame', [eat(7)], 100);
  P.slx.br = undefined;
  P.slx.watch = { state: () => ({ on: true }) };
  P.slx.fire('frame', [eat(7)], 100);
  assert.strictEqual(F.plays.length, n, 'a watcher follows another snake as its own');
});

test('slxSound: boost on and off from the outbound records, only on a change', () => {
  const P = soundPage();
  const F = P.F;
  const boost = (on) => ({ type: 'boost', on });
  P.slx.fire('open');
  P.slx.fire('send', [{ type: 'angle', q: 3 }, { type: 'ping' }]);
  P.slx.fire('send', [boost(false)]);
  assert.deepStrictEqual(heard(F), [], 'off while off');
  P.slx.fire('send', [{ type: 'angle', q: 4 }, boost(true)]);
  P.slx.fire('send', [boost(true)]);
  assert.deepStrictEqual(heard(F), ['g.boostOn']);
  P.slx.fire('send', [boost(false)]);
  P.slx.fire('send', [boost(false)]);
  assert.deepStrictEqual(heard(F), ['g.boostOn', 'g.boostOff']);
  // a death while boosting: the next boost is a change again
  P.slx.fire('send', [boost(true)]);
  P.slx.fire('ownDead', {});
  P.slx.fire('send', [boost(false)]);
  P.slx.fire('send', [boost(true)]);
  assert.deepStrictEqual(heard(F).slice(2), ['g.boostOn', 'g.death', 'g.boostOn']);
});

test('slxSound: the cash-out ring starts with the own hold; its end is a cancel unless a cash-out or death follows', () => {
  const P = soundPage();
  const F = P.F;
  P.S.slither = { id: 5 };
  P.slx.fire('open');
  P.slx.fire('x:hold', { t: 'hold', id: 9, on: 1, need: 3000 });
  P.slx.fire('x:hold', { t: 'hold', id: 9, on: 0 });
  P.raf(1, 100);
  assert.deepStrictEqual(heard(F), [], 'another snake\'s ring');
  P.slx.fire('x:hold', { t: 'hold', id: 5, on: 1, need: 3000 });
  P.slx.fire('x:hold', { t: 'hold', id: 5, on: 1, need: 3000 });
  assert.deepStrictEqual(heard(F), ['g.ringStart']);
  // released: the cancel, a moment later
  P.slx.fire('x:hold', { t: 'hold', id: 5, on: 0 });
  assert.deepStrictEqual(heard(F), ['g.ringStart'], 'it waits to see what follows');
  P.raf(1, 60);
  assert.deepStrictEqual(heard(F), ['g.ringStart', 'g.ringCancel']);
  P.slx.fire('x:hold', { t: 'hold', id: 5, on: 0 });
  P.raf(1, 100);
  assert.strictEqual(heard(F).length, 2, 'an end with no start');
  // a finished hold: the end comes first, then 'cashed' in the same array
  P.slx.fire('x:hold', { t: 'hold', id: 5, on: 1, need: 3000 });
  P.slx.fire('x:hold', { t: 'hold', id: 5, on: 0 });
  P.slx.fire('x:cashed', { t: 'cashed', len: 90 });
  P.raf(1, 100);
  assert.deepStrictEqual(heard(F).slice(2), ['g.ringStart', 'g.cashout']);
  // a death with the ring up
  P.slx.fire('open');
  P.slx.fire('x:hold', { t: 'hold', id: 5, on: 1, need: 3000 });
  P.slx.fire('x:hold', { t: 'hold', id: 5, on: 0 });
  P.slx.fire('ownDead', {});
  P.raf(1, 100);
  assert.deepStrictEqual(heard(F).slice(4), ['g.ringStart', 'g.death']);
  // a socket that closes with the ring up leaves nothing behind; a watcher hears no ring
  P.slx.fire('open');
  P.slx.fire('x:hold', { t: 'hold', id: 5, on: 1, need: 3000 });
  P.slx.fire('x:hold', { t: 'hold', id: 5, on: 0 });
  P.slx.fire('close', { playing: true });
  P.raf(1, 100);
  assert.strictEqual(heard(F).pop(), 'g.ringStart');
  P.slx.br = { mode: () => 'watch' };
  const n = F.plays.length;
  P.slx.fire('x:hold', { t: 'hold', id: 5, on: 1, need: 3000 });
  assert.strictEqual(F.plays.length, n);
});

test('slxSound: battle royale, the last 3 count seconds tick with their HUD number, GO, warning and closing once, a win only for the player', () => {
  const P = soundPage();
  const F = P.F;
  P.slx.br = { mode: () => 'play' };
  const br = (o) => P.slx.fire('x:br', Object.assign({ t: 'br', state: 'waiting', phase: 'waiting', countdownMs: 0, winner: null }, o));
  P.slx.fire('open');
  P.slx.fire('ownAdd', { id: 4 });
  br({});
  br({ state: 'countdown', phase: 'countdown', countdownMs: 10400 });
  assert.deepStrictEqual(heard(F), ['g.join'], 'the long count is silent');
  P.raf(1, 7400);
  assert.deepStrictEqual(heard(F).slice(1), ['g.tick'], 'the HUD shows 3');
  br({ state: 'countdown', phase: 'countdown', countdownMs: 2400 });
  assert.strictEqual(heard(F).length, 2, 'a message does not tick twice for the same number');
  P.raf(1, 400);
  P.raf(1, 1000);
  assert.deepStrictEqual(heard(F).slice(1), ['g.tick', 'g.tick', 'g.tick'], '3, 2, 1');
  P.raf(1, 5000);
  assert.strictEqual(heard(F).length, 4, 'nothing after the 1');
  br({ state: 'running', phase: 'holding' });
  assert.deepStrictEqual(heard(F).slice(4), ['g.go']);
  br({ state: 'running', phase: 'holding' });
  br({ state: 'running', phase: 'warning' });
  br({ state: 'running', phase: 'warning' });
  br({ state: 'running', phase: 'closing' });
  br({ state: 'running', phase: 'closing' });
  br({ state: 'running', phase: 'warning' });
  assert.deepStrictEqual(heard(F).slice(5), ['g.warn', 'g.danger', 'g.warn']);
  // the winner is this player: a win, once
  br({ state: 'over', phase: 'over', winner: { id: 4, name: 'Owen' } });
  br({ state: 'over', phase: 'over', winner: { id: 4, name: 'Owen' } });
  assert.deepStrictEqual(heard(F).slice(8), ['g.win']);
  // another winner, or a watcher: nothing extra
  br({ state: 'reopening', phase: 'over', winner: { id: 4, name: 'Owen' } });
  br({ state: 'waiting' });
  br({ state: 'over', winner: { id: 11, name: 'Ann' } });
  P.slx.br = { mode: () => 'watch' };
  br({ state: 'waiting' });
  br({ state: 'over', winner: { id: 4, name: 'Owen' } });
  assert.strictEqual(heard(F).length, 9);
  // joining a count already on: the number the HUD shows, then the rest; joining a running match: no GO
  P.slx.br = { mode: () => 'play' };
  P.slx.fire('open');
  br({ state: 'countdown', phase: 'countdown', countdownMs: 2400 });
  assert.strictEqual(heard(F).pop(), 'g.tick');
  P.raf(1, 400);
  P.raf(1, 1000);
  assert.strictEqual(heard(F).slice(9).length, 3);
  P.slx.fire('open');
  br({ state: 'running', phase: 'warning' });
  br({ state: 'running', phase: 'warning' });
  assert.strictEqual(heard(F).length, 12, 'the first message of a socket is the baseline');
  // the socket closing takes the pending ticks with it
  P.slx.fire('open');
  br({ state: 'countdown', phase: 'countdown', countdownMs: 5400 });
  P.slx.fire('close', { playing: true });
  P.raf(1, 6000);
  assert.strictEqual(heard(F).length, 12);
});

test('slxSound: chat from another name pings (400 ms apart); the own line, an empty one and a bad message do not; a refusal is an error tone', () => {
  const P = soundPage();
  const F = P.F;
  P.D.slMain = { nick: 'Owen' };
  P.slx.fire('open');
  P.slx.fire('x:chat', { t: 'chat', name: 'Ann', text: 'hello' });
  P.slx.fire('x:chat', { t: 'chat', name: 'Owen', text: 'mine' });
  P.slx.fire('x:chat', { t: 'chat', name: 'Ann', text: '' });
  P.slx.fire('x:chat', { t: 'chat', name: 'Ann' });
  P.slx.fire('x:chat', null);
  assert.deepStrictEqual(heard(F), ['g.chat']);
  assert.strictEqual(F.plays[0].o.gap, 400);
  P.slx.fire('x:refused', { t: 'refused', why: 'full' });
  assert.deepStrictEqual(heard(F), ['g.chat', 'g.err']);
});

// The shared end screens (dsEnd.js) are every game's file, not the layer's: their rules are their own .dse (card) and
// .dsb (board) classes, so the .slx- rule is held on the layer's styles and dsEnd's are held to that namespace instead.
// Its source is held to the same no-random, no-markup and no-em-dash rules; it has no inert check (a library: it makes
// nothing until a layer file calls it, see the inert test).
test('HUD files: .slx- selectors only, no Math.random, no markup writes, every number cited', () => {
  const P = makePage({ win: { CashoutSound: { play() {} } } });
  for (const k of ['lbh', 'lbs', 'lbn', 'lbp']) P.S[k] = new P.El(P.doc, 'div');   // so slxHud makes its board
  P.load('dsEnd.js');
  P.load('dsChat.js');
  P.load('dsPerfHud.js');
  for (const f of HUD) P.load(f);
  const styles = P.doc.head.children.filter((e) => e.tagName === 'STYLE');
  const shared = styles.filter((e) => e.getAttribute('data-dse') === '1');
  assert.strictEqual(shared.length, 1, 'dsEnd styled the page once (for the board)');
  const chatCss = styles.filter((e) => e.getAttribute('data-ds') === 'chat');
  assert.strictEqual(chatCss.length, 1, 'the shared chat styled the page once');
  const selectorsOf = (els) => {
    const css = els.map((e) => e.textContent).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
    // every selector of every rule, @media and @keyframes blocks opened
    const flat = css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '').replace(/@media[^{]*\{/g, '')
      .replace(/\}\s*\}/g, '}');
    const out = [];
    for (const m of flat.matchAll(/([^{}]+)\{[^{}]*\}/g)) for (const s of m[1].split(',')) out.push(s.trim());
    return out;
  };
  const perfCss = styles.filter((e) => e.getAttribute('data-ds') === 'perf');
  assert.strictEqual(perfCss.length, 1, 'the shared ping and FPS readout styled the page once');
  const dsp = selectorsOf(perfCss);
  assert.ok(dsp.length >= 5, 'parsed ' + dsp.length + ' of dsPerfHud');
  for (const s of dsp) assert.ok(/^\.dsp-/.test(s), 'dsPerfHud selector outside .dsp-: ' + s);
  // the layer's own rules (slxStats' line went to the shared readout, Owen 2026-10-27)
  const selectors = selectorsOf(styles.filter((e) => !shared.includes(e) && !chatCss.includes(e) && !perfCss.includes(e)));
  const dsc = selectorsOf(chatCss);
  assert.ok(dsc.length > 30, 'parsed ' + dsc.length + ' of dsChat');
  for (const s of dsc) assert.ok(/^\.dsc(?:[-.:\s>\[]|$)/.test(s), 'dsChat selector outside .dsc: ' + s);
  for (const s of selectors) assert.ok(/^\.slx-/.test(s), 'selector outside .slx-: ' + s);
  const dse = selectorsOf(shared);
  assert.ok(dse.length > 40, 'parsed ' + dse.length + ' of dsEnd');
  for (const s of dse) assert.ok(/^\.ds[eb](?:[-.:\s>]|$)/.test(s), 'dsEnd selector outside .dse / .dsb: ' + s);
  const files = HUD.map((f) => [f, path.join(SLX_DIR, f)]).concat([['dsEnd.js', DSEND],
    ['dsChat.js', path.join(ROOT, 'public', 'js', 'shared', 'dsChat.js')],
    ['dsPerfHud.js', path.join(ROOT, 'public', 'js', 'shared', 'dsPerfHud.js')]]);
  for (const [f, file] of files) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!/Math\.random/.test(src), f + ': Math.random');
    assert.ok(!/innerHTML\s*=[^=]/.test(src), f + ': writes innerHTML');
    assert.ok(!/insertAdjacentHTML|document\.write|outerHTML\s*=/.test(src), f + ': markup write');
    if (f !== 'dsEnd.js' && f !== 'dsChat.js' && f !== 'dsPerfHud.js') assert.ok(/if \(!D \|\| !D\.slx \|\| !D\.slx\.active\) return;/.test(src), f + ': the inert check');
    assert.ok(!src.includes(String.fromCharCode(0x2014)), f + ': em dash');
    // every named number of the layer says where it comes from: a comment on its line or the line above it
    if (f === 'dsEnd.js' || f === 'dsChat.js' || f === 'dsPerfHud.js') continue;
    const lines = src.split(/\r?\n/);
    lines.forEach((l, i) => {
      if (!/^\s*var [A-Z][A-Z0-9_]* = -?[0-9.]/.test(l)) return;
      assert.ok(/\/\/./.test(l) || /^\s*\/\//.test(lines[i - 1] || ''), f + ':' + (i + 1) + ' an uncited number: ' + l.trim());
    });
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
    // the composed page's order: the shared end screens, then the layer (server/sl/slBoot.js slxTail)
    scripts: V.SRC.concat([['dsEnd.js', fs.readFileSync(DSEND, 'utf8')]],
      LAYER.map((f) => [f, fs.readFileSync(path.join(SLX_DIR, f), 'utf8')])),
    // no harness transport: slxNet installs the production one over this fake socket.io
    win: { io: fakeIo, CashoutSound: { play() { return true; } }, DuelSlitherConfig: { assetBase: '/' } }
  });
  const login = P.labelled.find((e) => e.label === 'login');
  P.doc.getElementById = (id) => (id === 'login' ? login : null);
  // dsEnd looks for its font link once before it styles the page; the vm page knows only data-sl selectors
  const q = P.doc.querySelector;
  P.doc.querySelector = (sel) => (sel === 'link[data-dse-font]' ? null : q(sel));
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
  const seen = { menuShow: 0, cardAtShow: [], lastscoreAtShow: [], bestAtShow: [], states: [] };
  D.slx.on('menuShow', () => {
    seen.menuShow++;
    seen.cardAtShow.push(D.slx.card.state());
    seen.lastscoreAtShow.push(String(D.S.lastscore.innerHTML));
    seen.bestAtShow.push(D.S.best_rank);
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
  assert.strictEqual(st.title, 'You died');
  // Time from the own add to the death on the page clock; Top rank kept from the life: their client's own best rank
  // is already gone when their menu shows (a dead seat's board ranks it 0)
  assert.deepStrictEqual(plain(st.facts), ['Time 0:03', 'Top rank 38th', 'Kills 0']);
  assert.deepStrictEqual(r.seen.bestAtShow, [0]);
  const n = lastscoreN(r.seen.lastscoreAtShow[0]);
  assert.ok(n !== null, 'their gameOver wrote a length');
  assert.strictEqual(st.length, n, 'the card number is their last-score number');
  assert.strictEqual(st.length, '10');
  assert.deepStrictEqual(r.seen.states, ['|', 'dead|Play again', 'dead|Starting', '|'],
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
    assert.deepStrictEqual(plain(st.facts), ['Time 0:05', 'Top rank 37th', 'Kills 0'], reason);
    assert.deepStrictEqual(r.seen.bestAtShow, [999999999], reason + ': their resetGame ran at the close, before their menu');
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
  assert.strictEqual(c.seen.cardAtShow[0].title, 'Cashed out');
  assert.deepStrictEqual(plain(c.seen.cardAtShow[0].facts), ['Time 0:03', 'Top rank 38th', 'Kills 0']);
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
