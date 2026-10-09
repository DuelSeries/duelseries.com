'use strict';
/* The /ag page's paid hand-off (public/js/ag/agPaid.js, wired in agMain; PAID-AGAR-DESIGN.md 4 steps 3 to 10, 6 and
   build checklist 11), driven through the REAL page session (test/agFakePage.js boots public/js/ag/agMain.js with a
   fake DOM, canvas, clock and socket):

   - the token read: the lobby wallet's sessionStorage keys, read the way Paper's page reads them; the token goes in
     exactly one ag:join and leaves sessionStorage with it; never in the page's send hook (no token in a log)
   - the socket connects with auth { paid: 1 }; no menu, no Spectate, the joining card instead
   - join/ready ordering: ag:ready only after a frame with the page's own cell from this room is drawn; no target,
     split, eject or hold before it; a fresh target right after it
   - the resume key: kept in sessionStorage from ag:joined, sent (never the token) after a reconnect or a reload;
     a link that drops before the answer re-sends the same token once (Paper's rule)
   - every refusal and end state: a plain message, the refund line from the answer, the resume key gone, the way back
     open; slow-down retries with the same token; no answer at all gives the way back after JOIN_ANSWER_MS
   - Play again through duel:restake with Back to lobby locked, the Esc hint, the phone Cash out button
   - the free page is untouched: no auth, no paid join, the menu as before */
const test = require('node:test');
const assert = require('node:assert');
const { LIB, W, bootPage, BORDER, cell } = require('./agFakePage');

const P = LIB.agPaid;

function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    has: (k) => m.has(k),
    map: m
  };
}

const HANDOFF = { stake: '0.1', entryToken: 'tok-0001', playerName: 'Owen', walletAddress: 'Wa11et' };

function fakeParent() {
  const posted = [];
  return { posted, postMessage(m, o) { posted.push([m, o]); } };
}

// o: storage init, framed, cfg extras, pad
function paidPage(o) {
  o = o || {};
  const store = memStore(o.store || HANDOFF);
  const parent = o.framed === false ? undefined : fakeParent();
  const p = bootPage({ net: true, pad: !!o.pad, parent, location: { origin: 'http://localhost' },
    cfg: Object.assign({ url: '/ag', handoff: true, tabStorage: store }, o.cfg || {}) });
  p.store = store;
  p.parent = parent;
  return p;
}
const emits = (p, ev) => p.sock.emitted.filter((e) => e[0] === ev);
const joins = (p) => emits(p, 'ag:join').map((e) => e[1]);
const card = (p) => ({
  shown: !!p.doc.getElementById('ag-paid-end') && !p.doc.getElementById('ag-paid-end').hidden,
  kind: p.doc.getElementById('ag-paid-end') ? p.doc.getElementById('ag-paid-end').getAttribute('data-kind') : null,
  title: (p.doc.getElementById('ag-pe-title') || {}).textContent,
  sub: (p.doc.getElementById('ag-pe-sub') || {}).textContent,
  extra: p.doc.getElementById('ag-pe-settle') && !p.doc.getElementById('ag-pe-settle').hidden
    ? p.doc.getElementById('co-settle-text').textContent : '',
  lobby: p.doc.getElementById('ag-pe-lobby') ? !p.doc.getElementById('ag-pe-lobby').hidden : false,
  lobbyDisabled: p.doc.getElementById('ag-pe-lobby') ? !!p.doc.getElementById('ag-pe-lobby').disabled : false,
  again: p.doc.getElementById('ag-pe-again') && !p.doc.getElementById('ag-pe-again').hidden
    ? p.doc.getElementById('ag-pe-again').textContent : '',
  error: p.doc.getElementById('ag-pe-error') && !p.doc.getElementById('ag-pe-error').hidden
    ? p.doc.getElementById('ag-pe-error').textContent : ''
});
// Every text and attribute under a fake element (the token must appear nowhere in it).
function domText(el) {
  let out = String(el.textContent || '') + ' ' + JSON.stringify(el.attributes || {}) + ' ' + String(el.value || '');
  for (const c of el.children || []) out += ' ' + domText(c);
  return out;
}
const menuOpen = (p) => !p.doc.getElementById('ag-menu').hidden;
const flow = (p) => p.session.state().handoff;

function connect(p) {
  p.sock.connected = true;
  p.sock.fire('connect');
}
function drop(p) {
  p.sock.connected = false;
  p.sock.fire('disconnect', 'transport close');
}
const JOINED = { stake: 0.1, micro: 100000, resumeKey: 'rk-0001', resumed: false, confirmed: false, holdTicks: 75, tickMs: 40.014 };
// The seat's first bundle: hello, border, the own id, then the own cell 9 and a stranger.
function roomBundle(p) {
  p.sock.fire('ag:f', W.encodeBundle([{ t: 'hello' }, BORDER, { t: 'world', eats: [], cells: [], removed: [] }, { t: 'own', id: 9 },
    { t: 'world', eats: [], cells: [cell({ id: 9 }), cell({ id: 10, x: 900, size: 50, name: 'bob' })], removed: [] }]));
}
async function seated(p, joined) {
  connect(p);
  p.sock.fire('ag:joined', Object.assign({}, JOINED, joined || {}));
}
async function live(p, joined) {
  await seated(p, joined);
  roomBundle(p);
  await p.frames(3);
}

// ---- the hand-off read -----------------------------------------------------------------------------------------
test('readHandoff: the wallet widget keys, read the way Paper reads them; paid only with a stake AND a token or a matching resume key', () => {
  const h = P.readHandoff(memStore({ stake: '0.1', entryToken: 'tok-1', playerName: '  Owen the great player ' }));
  assert.deepStrictEqual(h, { paid: true, stake: 0.1, entryToken: 'tok-1', resumeKey: null, name: 'Owen the great ' }, 'trimmed, then cut to 15 (agLobby lobbyName)');
  assert.strictEqual(P.readHandoff(memStore({ stake: '0', entryToken: '' })).paid, false, 'the Free rung (stake 0, empty token)');
  assert.strictEqual(P.readHandoff(memStore({ stake: '0.1' })).paid, false, 'a spent hand-off is the free page');
  assert.strictEqual(P.readHandoff(memStore({ stake: '1', entryToken: 'x'.repeat(65) })).paid, false, 'over the door cap');
  assert.strictEqual(P.readHandoff(memStore({ entryToken: 'tok-1' })).paid, false, 'a token with no stake');
  const r = P.readHandoff(memStore({ stake: '1', agResume: JSON.stringify({ k: 'rk-9', s: 1 }) }));
  assert.deepStrictEqual([r.paid, r.resumeKey, r.entryToken], [true, 'rk-9', null], 'a reload takes the seat back');
  assert.strictEqual(P.readHandoff(memStore({ stake: '0.1', agResume: JSON.stringify({ k: 'rk-9', s: 1 }) })).paid, false,
    'a key for another rung is not this hand-off');
  assert.strictEqual(P.readHandoff(memStore({ stake: '1', agResume: '{bad' })).paid, false);
  const both = P.readHandoff(memStore({ stake: '1', entryToken: 'tok-2', agResume: JSON.stringify({ k: 'rk-9', s: 1 }) }));
  assert.strictEqual(both.entryToken, 'tok-2', 'a fresh buy-in wins (the door reattaches a seat the wallet still holds)');
  const named = P.readHandoff(memStore({ stake: '1', entryToken: 't' }), memStore({ duelseries_playername: 'Lobby Name' }));
  assert.strictEqual(named.name, 'Lobby Name', 'the lobby name when the hand-off has none');
});

// ---- connect, join, ready --------------------------------------------------------------------------------------
test('paid page: auth { paid: 1 }, the joining card instead of the menu, one ag:join with the token, which leaves sessionStorage and never reaches the send hook', async () => {
  const p = paidPage();
  assert.deepStrictEqual(p.ioArgs, [['/ag', { auth: { paid: 1 } }]], 'the paid socket connects seatless (agSockets connectPaid)');
  assert.strictEqual(menuOpen(p), false, 'no menu, no Spectate in a paid hand-off');
  const c = card(p);
  assert.ok(c.shown && c.kind === 'wait', 'the joining card');
  assert.strictEqual(c.title, 'Joining the $0.10 room');
  assert.strictEqual(c.lobby, false, 'no way out while the token is unspent');
  assert.strictEqual(p.session.paidLocked(), true, 'the exit lock is on (agLobby reads it)');
  assert.deepStrictEqual(joins(p), [], 'nothing before the socket is up');
  assert.ok(p.store.has('entryToken'), 'the token stays in sessionStorage until its join goes out (Paper)');
  connect(p);
  assert.deepStrictEqual(joins(p), [{ name: 'Owen', stake: 0.1, entryToken: 'tok-0001' }]);
  assert.strictEqual(p.store.has('entryToken'), false, 'the token left sessionStorage with its one join');
  assert.deepStrictEqual(p.sent.filter((s) => s[0] === 'paidJoin').map((s) => s[1]), [{ stake: 0.1, entry: true, resume: false }],
    'the send hook hears the rung only');
  assert.ok(!JSON.stringify(p.sent).includes('tok-0001'), 'no token in the send hook');
  assert.ok(!domText(p.doc.body).includes('tok-0001'), 'no token in the DOM');
  assert.deepStrictEqual(emits(p, 'ag:ready'), []);
});

test('join/ready ordering: no ag:ready, target, split, eject or hold until a frame with the own cell from this room is drawn; then one ready and a fresh target', async () => {
  const p = paidPage({ pad: true });
  await seated(p);
  assert.strictEqual(flow(p).phase, 'seated');
  assert.strictEqual(p.session.state().menuState, 'PLAY', 'the play state, no free ag:join');
  assert.deepStrictEqual(JSON.parse(p.store.getItem(P.RESUME_KEY)), { k: 'rk-0001', s: 0.1 }, 'the resume key kept in sessionStorage');
  assert.strictEqual(card(p).shown, false, 'the joining card goes');
  assert.strictEqual(p.session.paidLocked(), false, 'agLobby\'s own exit trap holds the page from ag:joined');
  // frames before the room's bundle: nothing drawn with an own cell yet
  p.mod.camera.setMouse(900, 100);
  await p.frames(5);
  p.key('keydown', 32);
  p.key('keyup', 32);
  p.key('keydown', 87);
  p.key('keyup', 87);
  p.key('keydown', 81);
  p.key('keyup', 81);
  assert.deepStrictEqual(emits(p, 'ag:ready'), [], 'no ready before the room is drawn');
  // the bundle arrives: applied at once, but not drawn until the next frame
  roomBundle(p);
  assert.deepStrictEqual(emits(p, 'ag:ready'), [], 'a received bundle is not a drawn frame');
  assert.strictEqual(flow(p).spawned, true);
  const before = p.sock.emitted.length;
  await p.frame();
  assert.strictEqual(emits(p, 'ag:ready').length, 1, 'one ready after the first drawn frame with the own cell');
  const readyAt = p.sock.emitted.findIndex((e) => e[0] === 'ag:ready');
  assert.ok(readyAt >= before);
  for (const ev of ['ag:target', 'ag:split', 'ag:eject', 'ag:hold']) {
    assert.ok(!p.sock.emitted.slice(0, readyAt).some((e) => e[0] === ev), ev + ' never before ready');
  }
  assert.strictEqual(flow(p).phase, 'live');
  await p.frames(8);
  assert.ok(emits(p, 'ag:target').length >= 1, 'a fresh target right after ready (the last-sent pair was reset)');
  assert.strictEqual(emits(p, 'ag:ready').length, 1, 'ready once per seat');
  p.key('keydown', 32);
  p.key('keyup', 32);
  assert.strictEqual(emits(p, 'ag:split').length, 1, 'split works once live');
  // phone: the Cash out button holds once live
  p.doc.getElementById('ag-cash').dispatch('pointerdown', {});
  assert.deepStrictEqual(emits(p, 'ag:hold').map((e) => e[1]), [{ on: 1 }], 'the hold button sends the hold');
  p.doc.getElementById('ag-cash').dispatch('pointerup', {});
  assert.deepStrictEqual(emits(p, 'ag:hold').map((e) => e[1]), [{ on: 1 }, { on: 0 }]);
});

// ---- resume ----------------------------------------------------------------------------------------------------
test('resume after a reconnect: the reconnect card, no menu, ag:join with the resume key (never the token); a confirmed seat needs no second ready', async () => {
  const p = paidPage();
  await live(p);
  drop(p);
  assert.strictEqual(flow(p).phase, 'reconnecting');
  assert.strictEqual(menuOpen(p), false, 'the menu does not open over a dropped paid seat');
  assert.strictEqual(card(p).kind, 'wait');
  assert.strictEqual(card(p).title, 'Reconnecting');
  connect(p);
  assert.deepStrictEqual(joins(p).slice(1), [{ name: 'Owen', stake: 0.1, resumeKey: 'rk-0001' }]);
  p.sock.fire('ag:joined', Object.assign({}, JOINED, { resumed: true, confirmed: true }));
  roomBundle(p);
  await p.frames(3);
  assert.strictEqual(flow(p).phase, 'live');
  assert.strictEqual(emits(p, 'ag:ready').length, 1, 'the confirmed seat is not readied again');
  assert.strictEqual(card(p).shown, false);
  // the give-up line: a link that stays down offers the way back after GIVE_UP_MS, the page keeps trying
  drop(p);
  assert.strictEqual(card(p).lobby, false);
  await p.frame(P.GIVE_UP_MS + 10);
  assert.strictEqual(card(p).lobby, true, 'Back to lobby after the give-up time');
  assert.match(card(p).extra, /3 minutes/);
});

test('resume after a reload: the stored key joins (no token in storage), nothing locks, and the seat comes back', async () => {
  const p = paidPage({ store: { stake: '0.1', playerName: 'Owen', agResume: JSON.stringify({ k: 'rk-0001', s: 0.1 }) } });
  assert.strictEqual(p.session.paidLocked(), false, 'no token, nothing to lock');
  assert.strictEqual(card(p).title, 'Getting your seat back');
  connect(p);
  assert.deepStrictEqual(joins(p), [{ name: 'Owen', stake: 0.1, resumeKey: 'rk-0001' }]);
  p.sock.fire('ag:joined', Object.assign({}, JOINED, { resumed: true, confirmed: true }));
  assert.strictEqual(flow(p).phase, 'seated');
});

test('a link that drops before the answer re-sends the same token once on the next connection; after the answer only the resume key goes', async () => {
  const p = paidPage();
  connect(p);
  drop(p);
  assert.strictEqual(card(p).title, 'Reconnecting');
  assert.strictEqual(p.session.paidLocked(), true, 'still locked: the token may be money already');
  connect(p);
  assert.deepStrictEqual(joins(p), [{ name: 'Owen', stake: 0.1, entryToken: 'tok-0001' }, { name: 'Owen', stake: 0.1, entryToken: 'tok-0001' }]);
  p.sock.fire('ag:joined', JOINED);
  drop(p);
  connect(p);
  assert.deepStrictEqual(joins(p)[2], { name: 'Owen', stake: 0.1, resumeKey: 'rk-0001' }, 'the token is never sent again');
});

// ---- refusals and end states -----------------------------------------------------------------------------------
test('every door refusal: its plain message, the refund line from the answer, no resume key, the way back open', async () => {
  const cases = [
    ['not-open', true], ['restarting', false], ['seat-failed', true], ['no-room', true], ['full', true],
    ['maintenance', true], ['cooldown', true], ['entry', false], ['unavailable', false], ['settled', true], ['bad-stake', false]
  ];
  for (const [why, refunded] of cases) {
    const p = paidPage();
    connect(p);
    p.sock.fire('ag:refused', { why, refunded, text: 'server text' });
    const c = card(p);
    assert.strictEqual(c.kind, 'refused', why);
    assert.deepStrictEqual([c.title, c.sub], P.REFUSED[why], why + ': its own words');
    if (refunded) assert.strictEqual(c.extra, P.TEXT.refunded, why + ': refunded');
    else if (why === 'restarting' || why === 'entry' || why === 'unavailable') assert.strictEqual(c.extra, P.TEXT.unused, why + ': an unused entry comes back by itself');
    else assert.strictEqual(c.extra, '', why);
    assert.strictEqual(c.lobby, true, why + ': Back to lobby');
    assert.strictEqual(c.again, '', why + ': no Play again on a refusal');
    assert.strictEqual(p.session.paidLocked(), false, why + ': unlocked');
    assert.strictEqual(flow(p).phase, 'end');
  }
  // the token expired before the page opened: the door refuses 'entry' (entryExpiry already refunded it)
  const ex = paidPage();
  connect(ex);
  ex.sock.fire('ag:refused', { why: 'entry', refunded: false });
  assert.match(card(ex).sub, /expired/);
});

test('slow-down: the same token again after 500 ms, nothing shown; a released seat (closed) and a dead resume key end with their reasons', async () => {
  const p = paidPage();
  connect(p);
  p.sock.fire('ag:refused', { why: 'slow-down', retry: true, retryMs: 500 });
  assert.strictEqual(card(p).kind, 'wait');
  assert.strictEqual(joins(p).length, 1);
  await p.frame(499);
  assert.strictEqual(joins(p).length, 1);
  await p.frame(2);
  assert.deepStrictEqual(joins(p)[1], { name: 'Owen', stake: 0.1, entryToken: 'tok-0001' });

  const r = paidPage();
  await seated(r);
  assert.ok(r.store.has(P.RESUME_KEY));
  r.sock.fire('ag:refused', { why: 'join-timeout', refunded: true, closed: true });
  assert.deepStrictEqual([card(r).kind, card(r).title, card(r).extra], ['refused', 'Too slow to start', P.TEXT.refunded]);
  assert.strictEqual(r.store.has(P.RESUME_KEY), false, 'the released seat\'s key is gone');

  const k = paidPage({ store: { stake: '0.1', agResume: JSON.stringify({ k: 'rk-old', s: 0.1 }) } });
  connect(k);
  k.sock.fire('ag:refused', { why: 'expired', refunded: false });
  assert.deepStrictEqual([card(k).title, card(k).extra], ['Seat ended', P.TEXT.restart]);
  assert.strictEqual(k.store.has(P.RESUME_KEY), false);

  // a refusal nobody asked for (a seatless socket's own timeout on the end card) changes nothing
  const e = paidPage();
  await live(e);
  e.sock.fire('ag:dead', { lostMicro: 100000, by: 'bob' });
  e.sock.fire('ag:refused', { why: 'join-timeout' });
  assert.strictEqual(card(e).kind, 'dead');
});

test('second seat for the same wallet: back in the old seat, the notice says the new entry was refunded', async () => {
  const p = paidPage();
  connect(p);
  p.sock.fire('ag:joined', Object.assign({}, JOINED, { resumed: true, confirmed: true, resumeKey: 'rk-old' }));
  p.sock.fire('ag:refunded', { why: 'reattach', text: 'server text' });
  assert.strictEqual(flow(p).phase, 'seated');
  assert.strictEqual(p.doc.getElementById('ag-paid-hint').textContent, P.TEXT.reattach);
  assert.deepStrictEqual(JSON.parse(p.store.getItem(P.RESUME_KEY)).k, 'rk-old');
});

test('end states: death shows the server\'s whole-life loss, cash-out its receipt, crash or restart the refund, a takeover the way back; every one drops the key', async () => {
  const d = paidPage();
  await live(d);
  d.sock.fire('ag:dead', { lostMicro: 150000, by: 'bob' });
  assert.deepStrictEqual([card(d).kind, card(d).sub], ['dead', 'You lost $0.15 to bob']);
  assert.strictEqual(d.store.has(P.RESUME_KEY), false);
  assert.strictEqual(card(d).again, 'Play again $0.10');

  const c = paidPage();
  await live(c);
  c.sock.fire('ag:cashedout', { grossMicro: 200000, cutMicro: 20000, netMicro: 180000, cashoutId: 'x' });
  assert.strictEqual(card(c).kind, 'cashed');
  assert.strictEqual(card(c).sub, 'Cashed out $0.20, you receive $0.18 (10% house)');
  assert.strictEqual(c.store.has(P.RESUME_KEY), false);

  for (const why of ['crash', 'shutdown']) {
    const x = paidPage();
    await live(x);
    x.sock.fire('ag:closed', { why, refundedMicro: 100000 });
    assert.deepStrictEqual([card(x).kind, card(x).title], ['closed', 'Refunded'], why);
    assert.strictEqual(card(x).again, '', why + ': no Play again');
    assert.strictEqual(x.store.has(P.RESUME_KEY), false);
  }

  const t = paidPage();
  await live(t);
  t.sock.fire('ag:replaced', {});
  assert.deepStrictEqual([card(t).kind, card(t).title, card(t).sub], ['gone', 'Seat moved', P.TEXT.replaced]);
  assert.strictEqual(t.store.has(P.RESUME_KEY), false);
});

test('no answer to a join: the way back after JOIN_ANSWER_MS with the unused-entry line; a late seat is still taken', async () => {
  const p = paidPage();
  connect(p);
  await p.frame(P.JOIN_ANSWER_MS - 100);
  assert.strictEqual(card(p).kind, 'wait');
  await p.frame(200);
  assert.deepStrictEqual([card(p).kind, card(p).title, card(p).extra], ['gone', 'No answer', P.TEXT.unused]);
  assert.strictEqual(p.session.paidLocked(), false);
  p.sock.fire('ag:joined', JOINED);
  assert.strictEqual(flow(p).phase, 'seated', 'money that did land in a seat is played, not ignored');
  assert.strictEqual(card(p).shown, false);
});

// ---- Play again, Esc, the free page -----------------------------------------------------------------------------
test('Play again: duel:restake with a nonce, Back to lobby locked while the wallet is out, the fresh token joins; errors and strangers', async () => {
  const p = paidPage();
  await live(p);
  p.sock.fire('ag:dead', { lostMicro: 100000, by: 'bob' });
  p.doc.getElementById('ag-pe-again').dispatch('click', {});
  assert.strictEqual(p.parent.posted.length, 1);
  const ask = p.parent.posted[0][0];
  assert.deepStrictEqual([ask.type, ask.game, ask.stake, typeof ask.nonce], ['duel:restake', 'agar', 0.1, 'string']);
  assert.strictEqual(card(p).lobbyDisabled, true, 'Back to lobby is shut');
  assert.strictEqual(card(p).again, P.TEXT.againAsk);
  assert.strictEqual(p.session.paidLocked(), true);
  p.doc.getElementById('ag-pe-lobby').dispatch('click', {});
  assert.ok(!p.parent.posted.some((m) => m[0] === 'game:done'), 'a locked Back to lobby posts nothing');
  // strangers: another source, another nonce
  p.win.fire('message', { data: { type: 'duel:restake:done', entryToken: 'tok-evil', nonce: ask.nonce }, source: {}, origin: 'http://localhost' });
  p.win.fire('message', { data: { type: 'duel:restake:done', entryToken: 'tok-evil', nonce: 'nope' }, source: p.parent, origin: 'http://localhost' });
  p.win.fire('message', { data: { type: 'duel:restake:done', entryToken: 'tok-evil', nonce: ask.nonce }, source: p.parent, origin: 'http://evil.test' });
  assert.strictEqual(joins(p).length, 1, 'only the parent, this origin and this nonce are answered');
  p.win.fire('message', { data: { type: 'duel:restake:done', entryToken: 'tok-0002', nonce: ask.nonce }, source: p.parent, origin: 'http://localhost' });
  assert.deepStrictEqual(joins(p)[1], { name: 'Owen', stake: 0.1, entryToken: 'tok-0002' });
  assert.strictEqual(card(p).title, 'Joining the $0.10 room');
  p.sock.fire('ag:joined', Object.assign({}, JOINED, { resumeKey: 'rk-0002' }));
  assert.strictEqual(card(p).shown, false);
  assert.strictEqual(JSON.parse(p.store.getItem(P.RESUME_KEY)).k, 'rk-0002');

  const e = paidPage();
  await live(e);
  e.sock.fire('ag:cashedout', { grossMicro: 100000, cutMicro: 10000, netMicro: 90000 });
  e.doc.getElementById('ag-pe-again').dispatch('click', {});
  const n = e.parent.posted[0][0].nonce;
  e.win.fire('message', { data: { type: 'duel:restake:error', message: 'Stake cancelled', nonce: n }, source: e.parent, origin: 'http://localhost' });
  assert.deepStrictEqual([card(e).error, card(e).lobbyDisabled, card(e).again], ['Stake cancelled', false, 'Play again $0.10']);
  assert.strictEqual(e.session.paidLocked(), false);

  const s = paidPage({ framed: false });
  await live(s);
  s.sock.fire('ag:dead', { lostMicro: 100000 });
  assert.strictEqual(card(s).again, '', 'a page opened on its own has no wallet to ask');
});

test('Esc while money may be in the room shows how to leave instead of the menu', async () => {
  const p = paidPage();
  await live(p);
  p.key('keydown', 27);
  p.key('keyup', 27);
  assert.strictEqual(menuOpen(p), false);
  assert.strictEqual(p.doc.getElementById('ag-paid-hint').textContent, 'Hold Q to cash out');
  assert.strictEqual(p.doc.getElementById('ag-paid-hint').hidden, false);
  await p.frame(P.ESC_HINT_MS + 10);
  assert.strictEqual(p.doc.getElementById('ag-paid-hint').hidden, true);
});

test('the free page is untouched: no auth, no paid join, the menu, even with a paid hand-off in storage when the page is not the hand-off page', async () => {
  const free = bootPage({ net: true, cfg: { url: '/ag', handoff: true, tabStorage: memStore({ stake: '0', entryToken: '' }) } });
  assert.deepStrictEqual(free.ioArgs, [['/ag', {}]]);
  assert.strictEqual(free.session.state().handoff, null);
  assert.strictEqual(menuOpen(free), true);
  free.sock.connected = true;
  free.sock.fire('connect');
  assert.deepStrictEqual(free.sock.emitted, [], 'nothing sent until Play');
  assert.strictEqual(free.doc.getElementById('ag-paid-end'), null, 'no paid card in the free DOM');

  const harness = bootPage({ net: true, cfg: { url: '/ag', tabStorage: memStore(HANDOFF) } });
  assert.deepStrictEqual(harness.ioArgs, [['/ag', {}]], 'without handoff (the harness) the page never reads the hand-off');
  assert.strictEqual(menuOpen(harness), true);
});
