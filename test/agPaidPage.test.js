'use strict';
/* The /ag page's paid hand-off (public/js/ag/agPaid.js, wired in agMain; PAID-AGAR-DESIGN.md 4 steps 3 to 10, 6 and
   build checklist 11), driven through the REAL page session (test/agFakePage.js boots public/js/ag/agMain.js with a
   fake DOM, canvas, clock and socket):

   - the token read: the lobby wallet's sessionStorage keys, read the way Paper's page reads them; the token goes in
     exactly one ag:join and leaves sessionStorage with it; never in the page's send hook (no token in a log)
   - the socket connects with auth { paid: 1 }; no menu, no Spectate, the joining card instead
   - join/ready ordering: ag:ready only after a frame with the page's own cell from this room is drawn; no target,
     split, eject or hold before it; a fresh target right after it
   - the resume key: page memory from ag:joined, in sessionStorage only between a pagehide and the next boot, sent
     (never the token) after a reconnect or a reload at the seat's own rung; a link that drops before the answer
     re-sends the same token on each new connection until an answer comes (Paper's rule); a reload that cuts a token
     join off says so instead of opening the free page
   - every refusal and end state: a plain message, the refund line from the answer, the resume key gone, the way back
     open; slow-down retries with the same token; no answer at all gives the way back after JOIN_ANSWER_MS
   - Play again through duel:restake with Back to lobby locked, the Esc hint (and never the menu, not even on an end
     card), the phone Cash out button
   - the exit lock: every join out, and a dropped seat until the card offers the way back
   - the free page is untouched: no auth, no paid join, the menu as before, and the same draw calls and sends with
     the shipped config (handoff: true) as without it */
const test = require('node:test');
const assert = require('node:assert');
const { LIB, W, bootPage, BORDER, cell } = require('./agFakePage');
const { readCard, clickCard } = require('./agEndProbe');

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
  const p = bootPage({ net: true, pad: !!o.pad, parent, location: o.location || { origin: 'http://localhost' },
    cfg: Object.assign({ url: '/ag', handoff: true, tabStorage: store }, o.cfg || {}) });
  p.store = store;
  p.parent = parent;
  return p;
}
const emits = (p, ev) => p.sock.emitted.filter((e) => e[0] === ev);
const joins = (p) => emits(p, 'ag:join').map((e) => e[1]);
// The end card as the player sees it (the shared DSEnd card, test/agEndProbe.js): its kind (the page's paid state),
// the verdict line as the title, the message (sub) and its second line or the pending line (extra), the buttons, and
// a restake's error line (the only line under a death or a cash-out).
function card(p) {
  const c = readCard(p.doc);
  const btn = (id) => (c ? c.buttons.find((b) => b.id === id) : null);
  const kind = c ? p.session.state().paidEnd || null : null;
  const money = kind === 'dead' || kind === 'cashed';
  return {
    shown: !!c,
    kind,
    title: c ? c.verdict : undefined,
    hero: c ? c.hero : undefined,
    sub: c && !money ? c.notes[0] || '' : '',
    extra: c ? (c.status ? c.status.text : (!money && c.notes[1]) || '') : '',
    lobby: !!btn('lobby'),
    lobbyDisabled: !!(btn('lobby') && btn('lobby').disabled),
    again: btn('again') ? btn('again').text : '',
    error: c && money ? c.notes[0] || '' : ''
  };
}
// Every text and attribute under a fake element (the token must appear nowhere in it).
function domText(el) {
  let out = String(el.textContent || '') + ' ' + JSON.stringify(el.attributes || {}) + ' ' + String(el.value || '');
  for (const c of el.children || []) out += ' ' + domText(c);
  return out;
}
const menuOpen = (p) => !!p.doc.getElementById('ag-menu') && !p.doc.getElementById('ag-menu').hidden;
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
test('readHandoff: the wallet widget keys, read the way Paper reads them; paid only with a stake AND a token, a resume key or a cut-off join mark', () => {
  const h = P.readHandoff(memStore({ stake: '0.1', entryToken: 'tok-1', playerName: '  Owen the great player ' }));
  assert.deepStrictEqual(h, { paid: true, stake: 0.1, entryToken: 'tok-1', resumeKey: null, lost: false, name: 'Owen the great ' }, 'trimmed, then cut to 15 (agLobby lobbyName)');
  assert.strictEqual(P.readHandoff(memStore({ stake: '0', entryToken: '' })).paid, false, 'the Free rung (stake 0, empty token)');
  assert.strictEqual(P.readHandoff(memStore({ stake: '0.1' })).paid, false, 'a spent hand-off is the free page');
  assert.strictEqual(P.readHandoff(memStore({ stake: '1', entryToken: 'x'.repeat(65) })).paid, false, 'over the door cap');
  assert.strictEqual(P.readHandoff(memStore({ entryToken: 'tok-1' })).paid, false, 'a token with no stake');
  const r = P.readHandoff(memStore({ stake: '1', agResume: JSON.stringify({ k: 'rk-9', s: 1 }) }));
  assert.deepStrictEqual([r.paid, r.resumeKey, r.entryToken], [true, 'rk-9', null], 'a reload takes the seat back');
  const other = P.readHandoff(memStore({ stake: '0.1', agResume: JSON.stringify({ k: 'rk-9', s: 1 }) }));
  assert.deepStrictEqual([other.paid, other.resumeKey, other.stake], [true, 'rk-9', 1],
    'a key resumes at its own seat\'s rung (a reattach can seat the wallet at another rung than the lobby wrote)');
  assert.strictEqual(P.readHandoff(memStore({ stake: '0', agResume: JSON.stringify({ k: 'rk-9', s: 1 }) })).paid, false,
    'the Free rung is the free page whatever was left');
  const lost = P.readHandoff(memStore({ stake: '0.1', agResume: JSON.stringify({ p: 1, s: 0.1 }) }));
  assert.deepStrictEqual([lost.paid, lost.lost, lost.resumeKey], [true, true, null], 'a token join cut off by a reload');
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
  assert.strictEqual(p.store.has('entryToken'), false, 'the token left sessionStorage at boot (Paper start), page memory keeps it');
  p.win.fire('pagehide', {});
  assert.strictEqual(p.store.getItem('entryToken'), 'tok-0001', 'a token that never went out is put back for a reload');
  p.win.fire('pageshow', { persisted: true });
  assert.strictEqual(p.store.has('entryToken'), false, 'and taken out again when the page comes back from the cache');
  connect(p);
  assert.deepStrictEqual(joins(p), [{ name: 'Owen', stake: 0.1, entryToken: 'tok-0001' }]);
  assert.strictEqual(p.store.has('entryToken'), false);
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
  assert.strictEqual(p.store.has(P.RESUME_KEY), false, 'the resume key stays in page memory while the page lives');
  p.win.fire('pagehide', {});
  assert.deepStrictEqual(JSON.parse(p.store.getItem(P.RESUME_KEY)), { k: 'rk-0001', s: 0.1 }, 'written for a reload on pagehide');
  p.win.fire('pageshow', { persisted: true });
  assert.strictEqual(p.store.has(P.RESUME_KEY), false, 'gone again when the page itself comes back');
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

test('resume after a reload: the stored key joins (no token in storage), the page stays shut until the seat is back, and the key leaves storage at boot', async () => {
  const p = paidPage({ store: { stake: '0.1', playerName: 'Owen', agResume: JSON.stringify({ k: 'rk-0001', s: 0.1 }) } });
  assert.strictEqual(p.session.paidLocked(), true, 'a seat with money is being taken back: no way out yet');
  assert.strictEqual(p.store.has(P.RESUME_KEY), false, 'the key left sessionStorage at boot');
  assert.strictEqual(card(p).title, 'Getting your seat back');
  connect(p);
  assert.deepStrictEqual(joins(p), [{ name: 'Owen', stake: 0.1, resumeKey: 'rk-0001' }]);
  p.sock.fire('ag:joined', Object.assign({}, JOINED, { resumed: true, confirmed: true }));
  assert.strictEqual(flow(p).phase, 'seated');
  assert.strictEqual(p.session.paidLocked(), false, 'agLobby\'s own trap holds from ag:joined');
});

test('a reattach at another rung, then a reload: the seat is resumed at its own rung, not orphaned', async () => {
  const p = paidPage({ store: { stake: '1', entryToken: 'tok-1usd', playerName: 'Owen' } });
  connect(p);
  p.sock.fire('ag:joined', Object.assign({}, JOINED, { stake: 0.1, resumed: true, confirmed: true, resumeKey: 'rk-dime' }));
  p.sock.fire('ag:refunded', { why: 'reattach' });
  p.win.fire('pagehide', {});
  assert.strictEqual(p.store.getItem('stake'), '1', 'the lobby\'s stake is left as it wrote it');
  const q = paidPage({ store: Object.fromEntries(p.store.map) });
  assert.deepStrictEqual([flow(q).phase, flow(q).stake, flow(q).hasResume], ['connecting', 0.1, true]);
  connect(q);
  assert.deepStrictEqual(joins(q), [{ name: 'Owen', stake: 0.1, resumeKey: 'rk-dime' }]);
});

test('a reload that cuts a token join off: the reloaded page says so with the refund line and the way back, no socket, never the free page', async () => {
  const p = paidPage();
  connect(p);
  p.win.fire('pagehide', {});
  assert.deepStrictEqual(JSON.parse(p.store.getItem(P.RESUME_KEY)), { p: 1, s: 0.1 }, 'only a mark, never the token');
  assert.ok(!JSON.stringify([...p.store.map]).includes('tok-0001'), 'the token is not written back once it went out');
  const q = paidPage({ store: Object.fromEntries(p.store.map) });
  assert.deepStrictEqual(q.ioArgs, [], 'no socket for a hand-off that already ended');
  assert.strictEqual(menuOpen(q), false);
  assert.deepStrictEqual([card(q).kind, card(q).title, card(q).sub, card(q).extra, card(q).lobby],
    ['refused', P.TEXT.lostTitle, P.TEXT.lost, P.TEXT.lostLine, true]);
  assert.strictEqual(q.session.paidLocked(), false);
  assert.strictEqual(q.store.has(P.RESUME_KEY), false, 'the mark is read once');
});

test('a link that drops before the answer re-sends the same token on each new connection until an answer comes; after the answer only the resume key goes', async () => {
  const p = paidPage();
  connect(p);
  drop(p);
  assert.strictEqual(card(p).title, 'Reconnecting');
  assert.strictEqual(p.session.paidLocked(), true, 'still locked: the token may be money already');
  connect(p);
  drop(p);
  connect(p);
  const T = { name: 'Owen', stake: 0.1, entryToken: 'tok-0001' };
  assert.deepStrictEqual(joins(p), [T, T, T], 'the door dedupes it by its proof');
  p.sock.fire('ag:joined', JOINED);
  drop(p);
  connect(p);
  assert.deepStrictEqual(joins(p)[3], { name: 'Owen', stake: 0.1, resumeKey: 'rk-0001' }, 'the token is never sent again');
});

// ---- refusals and end states -----------------------------------------------------------------------------------
test('every door refusal: its plain message, the refund line from the answer, no resume key, the way back open', async () => {
  const cases = [
    ['not-open', true], ['restarting', false], ['seat-failed', true], ['no-room', true], ['full', true],
    ['maintenance', true], ['cooldown', true], ['entry', false], ['unavailable', false], ['settled', true], ['bad-stake', false],
    ['join-timeout', false], ['limit', false], ['join-lost', true], ['join-failed', true]
  ];
  for (const [why, refunded] of cases) {
    const p = paidPage();
    connect(p);
    p.sock.fire('ag:refused', { why, refunded, text: 'server text' });
    const c = card(p);
    assert.strictEqual(c.kind, 'refused', why);
    assert.deepStrictEqual([c.title, c.sub], P.REFUSED[why], why + ': its own words');
    if (refunded) assert.strictEqual(c.extra, P.TEXT.refunded, why + ': refunded');
    else if (['restarting', 'entry', 'unavailable', 'join-timeout', 'limit'].includes(why)) assert.strictEqual(c.extra, P.TEXT.unused, why + ': an unused entry comes back by itself');
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
  r.sock.fire('ag:refused', { why: 'join-timeout', refunded: true, closed: true });
  assert.deepStrictEqual([card(r).kind, card(r).title, card(r).extra], ['refused', 'Not started in time', P.TEXT.refunded]);
  r.win.fire('pagehide', {});
  assert.strictEqual(r.store.has(P.RESUME_KEY), false, 'the released seat\'s key is gone');

  const k = paidPage({ store: { stake: '0.1', agResume: JSON.stringify({ k: 'rk-old', s: 0.1 }) } });
  connect(k);
  k.sock.fire('ag:refused', { why: 'expired', refunded: false });
  assert.deepStrictEqual([card(k).title, card(k).extra], ['Seat ended', P.TEXT.expired]);
  assert.doesNotMatch(P.TEXT.expired, /whole balance is refunded/, 'no promise a frozen seat\'s house settle does not keep');
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
  p.win.fire('pagehide', {});
  assert.deepStrictEqual(JSON.parse(p.store.getItem(P.RESUME_KEY)).k, 'rk-old');
});

test('end states: death shows the server\'s whole-life loss, cash-out its receipt, crash or restart the refund, a takeover the way back; every one drops the key', async () => {
  const d = paidPage();
  await live(d);
  d.sock.fire('ag:dead', { lostMicro: 150000, by: 'bob' });
  assert.deepStrictEqual([card(d).kind, card(d).title, card(d).hero], ['dead', 'Eaten by bob', '−$0.15']);
  d.win.fire('pagehide', {});
  assert.strictEqual(d.store.has(P.RESUME_KEY), false, 'an ended seat leaves nothing for a reload');
  assert.strictEqual(card(d).again, 'Play again $0.10');

  const c = paidPage();
  await live(c);
  c.sock.fire('ag:cashedout', { grossMicro: 200000, cutMicro: 20000, netMicro: 180000, cashoutId: 'x' });
  assert.strictEqual(card(c).kind, 'cashed');
  assert.strictEqual(card(c).hero, '$0.18');
  assert.deepStrictEqual(readCard(c.doc).ledger, [['Cashed out', '$0.20'], ['House 10%', '−$0.02'], ['You receive', '$0.18', 'net']]);
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
  assert.doesNotMatch(P.TEXT.noAnswerSeat, /Reload/, 'no frame reload exists inside the lobby');
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
  clickCard(p.doc, 'again');
  assert.strictEqual(p.parent.posted.length, 1);
  const ask = p.parent.posted[0][0];
  assert.deepStrictEqual([ask.type, ask.game, ask.stake, typeof ask.nonce], ['duel:restake', 'agar', 0.1, 'string']);
  assert.strictEqual(card(p).lobbyDisabled, true, 'Back to lobby is shut');
  assert.strictEqual(card(p).again, P.TEXT.againAsk);
  assert.strictEqual(p.session.paidLocked(), true);
  clickCard(p.doc, 'lobby');
  assert.ok(!p.parent.posted.some((m) => m[0] === 'game:done'), 'a locked Back to lobby posts nothing');
  // strangers: another source, another nonce
  p.win.fire('message', { data: { type: 'duel:restake:done', entryToken: 'tok-evil', nonce: ask.nonce }, source: {}, origin: 'http://localhost' });
  p.win.fire('message', { data: { type: 'duel:restake:done', entryToken: 'tok-evil', nonce: 'nope' }, source: p.parent, origin: 'http://localhost' });
  p.win.fire('message', { data: { type: 'duel:restake:done', entryToken: 'tok-evil', nonce: ask.nonce }, source: p.parent, origin: 'http://evil.test' });
  p.win.fire('message', { data: { type: 'duel:restake:done', entryToken: 'tok-evil' }, source: p.parent, origin: 'http://localhost' });
  p.win.fire('message', { data: { type: 'duel:restake:done', entryToken: 'tok-evil', nonce: ask.nonce }, source: p.parent });
  assert.strictEqual(joins(p).length, 1, 'only the parent, this origin and this nonce are answered (no nonce is not ours)');
  p.win.fire('message', { data: { type: 'duel:restake:done', entryToken: 'tok-0002', nonce: ask.nonce }, source: p.parent, origin: 'http://localhost' });
  assert.deepStrictEqual(joins(p)[1], { name: 'Owen', stake: 0.1, entryToken: 'tok-0002' });
  assert.strictEqual(card(p).title, 'Joining the $0.10 room');
  p.sock.fire('ag:joined', Object.assign({}, JOINED, { resumeKey: 'rk-0002' }));
  assert.strictEqual(card(p).shown, false);
  p.win.fire('pagehide', {});
  assert.strictEqual(JSON.parse(p.store.getItem(P.RESUME_KEY)).k, 'rk-0002');

  const e = paidPage();
  await live(e);
  e.sock.fire('ag:cashedout', { grossMicro: 100000, cutMicro: 10000, netMicro: 90000 });
  clickCard(e.doc, 'again');
  const n = e.parent.posted[0][0].nonce;
  e.win.fire('message', { data: { type: 'duel:restake:error', message: 'Stake cancelled', nonce: n }, source: e.parent, origin: 'http://localhost' });
  assert.deepStrictEqual([card(e).error, card(e).lobbyDisabled, card(e).again], ['Stake cancelled', false, 'Play again $0.10']);
  assert.strictEqual(e.session.paidLocked(), false);

  const s = paidPage({ framed: false });
  await live(s);
  s.sock.fire('ag:dead', { lostMicro: 100000 });
  assert.strictEqual(card(s).again, '', 'a page opened on its own has no wallet to ask');
});

// ---- the three buttons on every paid death and cash-out (Owen 2026-10-16) ----------------------------------------
// Spectate is the lobby's own watch of this rung (public/js/v2/play.js spectate): the money keys out, spectateOnly and
// dsWatchStake (never 'stake', never a token), and /ag again in this frame, which boots as the rung's watcher.
function watchLocation() {
  return { origin: 'http://localhost', went: [], replace(u) { this.went.push(u); } };
}
const row = (p) => readCard(p.doc).buttons.map((b) => [b.id, b.text, b.primary, b.disabled]);

test('paid death and cash-out: Lobby, Spectate, Play again; Spectate writes the lobby watch keys for this rung and reopens /ag watching', async () => {
  const loc = watchLocation();
  const d = paidPage({ location: loc });
  await live(d);
  d.sock.fire('ag:dead', { lostMicro: 150000, by: 'bob' });
  assert.deepStrictEqual(row(d), [['lobby', 'Lobby', false, false], ['watch', 'Spectate', false, false],
    ['again', 'Play again $0.10', true, false]], 'a paid death: Lobby, Spectate, Play again at its price');
  assert.strictEqual(d.store.getItem('stake'), '0.1', 'the hand-off stake is still there before Spectate');
  clickCard(d.doc, 'watch');
  assert.deepStrictEqual(loc.went, ['/ag'], 'this frame opens /ag again (replace: no Back into the ended paid page)');
  assert.strictEqual(d.store.getItem('spectateOnly'), 'true');
  assert.strictEqual(d.store.getItem('dsWatchStake'), '0.1', 'the rung under its own key');
  for (const k of ['stake', 'entryToken', 'entrySol', 'dsWatch', P.RESUME_KEY]) assert.strictEqual(d.store.has(k), false, k + ' is out');
  assert.strictEqual(d.store.getItem('playerName'), 'Owen', 'the lobby name stays');
  assert.ok(!d.parent.posted.some((m) => m[0] === 'game:done'), 'Spectate is not Lobby');
  assert.ok(!d.parent.posted.some((m) => m[0] && m[0].type === 'duel:restake'), 'never a buy-in');
  assert.strictEqual(joins(d).length, 1, 'no join, nothing sent for it');

  // The reopened page in the lobby frame: never a hand-off, a read-only watcher of the rung (agLobby starts the watch).
  const w = bootPage({ net: true, parent: fakeParent(), location: { origin: 'http://localhost' }, sessionStorage: d.store,
    cfg: { url: '/ag', handoff: true, lobby: true, tabStorage: d.store } });
  assert.deepStrictEqual([w.session.state().handoff, w.session.state().paid], [null, false]);
  assert.deepStrictEqual(w.ioArgs, [['/ag', { auth: { watchStake: 0.1 } }]], 'the server watch path (agArenas.connectWatch)');
  w.session.destroy();
  // The same page opened on its own (no lobby frame, so no agLobby): it watches at once instead of showing its menu.
  const v = bootPage({ net: true, location: { origin: 'http://localhost' }, sessionStorage: d.store,
    cfg: { url: '/ag', handoff: true, tabStorage: d.store } });
  assert.deepStrictEqual([v.session.state().handoff, v.session.state().menuState, menuOpen(v)], [null, 'SPECTATE', false]);
  assert.deepStrictEqual(v.ioArgs, [['/ag', { auth: { watchStake: 0.1 } }]]);
  v.sock.connected = true;
  v.sock.fire('connect');
  v.sock.fire('ag:f', W.encodeBundle([{ t: 'hello' }, BORDER, { t: 'world', eats: [], cells: [], removed: [] }]));
  await v.frames(2);
  assert.ok(emits(v, 'ag:spectate').length >= 1, 'it asks to watch once the world is ready');
  v.session.destroy();

  // A paid cash-out: the same three, the payout pending (Lobby is open then, so Spectate is too).
  const loc2 = watchLocation();
  const c = paidPage({ location: loc2 });
  await live(c);
  c.sock.fire('ag:cashedout', { grossMicro: 200000, cutMicro: 20000, netMicro: 180000, cashoutId: 'x' });
  assert.deepStrictEqual(row(c), [['lobby', 'Lobby', false, false], ['watch', 'Spectate', false, false],
    ['again', 'Play again $0.10', true, false]]);
  assert.strictEqual(readCard(c.doc).status.state, 'pending');
  // Play again: the wallet is out, Lobby is shut, so Spectate is shut and does nothing
  clickCard(c.doc, 'again');
  assert.deepStrictEqual(row(c), [['lobby', 'Lobby', false, true], ['watch', 'Spectate', false, true],
    ['again', P.TEXT.againAsk, true, true]]);
  clickCard(c.doc, 'watch');
  assert.deepStrictEqual([loc2.went, c.store.getItem('spectateOnly'), c.store.getItem('stake')], [[], null, '0.1'], 'nothing written, nowhere to go');
  // the wallet's slow answer opens the way back (Lobby); Spectate stays shut until the wallet answers (a late stake
  // needs this page in the frame)
  await c.frame(P.RESTAKE_WAIT_MS + 10);
  assert.deepStrictEqual(row(c).map((b) => [b[0], b[3]]), [['lobby', false], ['watch', true], ['again', true]]);
  // an error answer: everything open again, Play again back at its price
  const n = c.parent.posted.find((m) => m[0] && m[0].type === 'duel:restake')[0].nonce;
  c.win.fire('message', { data: { type: 'duel:restake:error', message: 'Stake cancelled', nonce: n }, source: c.parent, origin: 'http://localhost' });
  assert.deepStrictEqual(row(c), [['lobby', 'Lobby', false, false], ['watch', 'Spectate', false, false],
    ['again', 'Play again $0.10', true, false]]);
  clickCard(c.doc, 'watch');
  assert.deepStrictEqual([loc2.went, c.store.getItem('dsWatchStake'), c.store.has('stake')], [['/ag'], '0.1', false]);

  // Notices keep Lobby alone: no Spectate on a refund, a takeover, or the reconnect wait.
  const x = paidPage({ location: watchLocation() });
  await live(x);
  x.sock.fire('ag:closed', { why: 'emergency', refundedMicro: 100000 });
  assert.deepStrictEqual(readCard(x.doc).buttons.map((b) => b.id), ['lobby']);
  const t = paidPage({ location: watchLocation() });
  await live(t);
  drop(t);
  assert.deepStrictEqual(readCard(t.doc).buttons, [], 'the reconnect wait: no way out while the seat holds money');
  t.sock.fire('ag:replaced', {});
  assert.deepStrictEqual(readCard(t.doc).buttons.map((b) => b.id), ['lobby']);

  // A hand-off page opened on its own has no wallet to ask: Lobby and Spectate (to the same watch).
  const loc3 = watchLocation();
  const s = paidPage({ framed: false, location: loc3 });
  await live(s);
  s.sock.fire('ag:dead', { lostMicro: 100000 });
  assert.deepStrictEqual(row(s), [['lobby', 'Lobby', true, false], ['watch', 'Spectate', false, false]]);
  clickCard(s.doc, 'watch');
  assert.deepStrictEqual([loc3.went, s.store.getItem('spectateOnly'), s.store.getItem('dsWatchStake')], [['/ag'], 'true', '0.1']);
});

test('paid Spectate only leaves a seat that ended: never with the hand-off token unspent or a join out', async () => {
  // no connection, so the token never went out: an end state fed in cannot send the page away (pagehide would put the
  // token back, and the watch page would carry it)
  const loc = watchLocation();
  const u = paidPage({ location: loc });
  u.session.sideEvent('ag:joined', JOINED);
  u.session.sideEvent('ag:dead', { lostMicro: 100000, by: 'bob' });
  assert.strictEqual(flow(u).unspent, true);
  clickCard(u.doc, 'watch');
  assert.deepStrictEqual([loc.went, u.store.getItem('spectateOnly'), u.store.getItem('stake')], [[], null, '0.1']);
  // the restake answered: the new join is out, the card is the joining wait, with no Spectate on it
  const j = paidPage({ location: watchLocation() });
  await live(j);
  j.sock.fire('ag:dead', { lostMicro: 100000 });
  clickCard(j.doc, 'again');
  const n = j.parent.posted[0][0].nonce;
  j.win.fire('message', { data: { type: 'duel:restake:done', entryToken: 'tok-0002', nonce: n }, source: j.parent, origin: 'http://localhost' });
  assert.deepStrictEqual([flow(j).phase, readCard(j.doc).buttons], ['joining', []]);
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
  assert.strictEqual(readCard(free.doc), null, 'no card in the free DOM');

  const harness = bootPage({ net: true, cfg: { url: '/ag', tabStorage: memStore(HANDOFF) } });
  assert.deepStrictEqual(harness.ioArgs, [['/ag', {}]], 'without handoff (the harness) the page never reads the hand-off');
  assert.strictEqual(menuOpen(harness), true);
});

// ---- review fixes (2026-10-09) ---------------------------------------------------------------------------------
test('Esc never opens the menu on a hand-off page: not on the joining card, not on any end card; the card stays, nothing free is sent', async () => {
  const j = paidPage();
  j.key('keydown', 27);
  j.key('keyup', 27);
  assert.strictEqual(menuOpen(j), false, 'the joining card');
  const ends = {
    dead: (p) => p.sock.fire('ag:dead', { lostMicro: 100000, by: 'bob' }),
    cashed: (p) => p.sock.fire('ag:cashedout', { grossMicro: 100000, cutMicro: 10000, netMicro: 90000 }),
    closed: (p) => p.sock.fire('ag:closed', { why: 'shutdown', refundedMicro: 100000 }),
    gone: (p) => p.sock.fire('ag:replaced', {}),
    refused: (p) => p.sock.fire('ag:refused', { why: 'join-timeout', refunded: true, closed: true })
  };
  for (const [kind, fire] of Object.entries(ends)) {
    const p = paidPage();
    await live(p);
    fire(p);
    assert.strictEqual(card(p).kind, kind, kind);
    for (let i = 0; i < 2; i++) { p.key('keydown', 27); p.key('keyup', 27); }
    await p.frames(2);
    assert.strictEqual(menuOpen(p), false, kind + ': no menu');
    assert.strictEqual(card(p).shown, true, kind + ': the card stays');
    assert.ok(!p.sock.emitted.some((e) => e[0] === 'ag:join' && !e[1].entryToken && !e[1].resumeKey), kind + ': no free join');
    drop(p);
    assert.strictEqual(menuOpen(p), false, kind + ': a drop on the end card opens no menu either');
  }
});

test('the exit lock follows the seat: shut while a dropped seat reconnects, open with Back to lobby at GIVE_UP_MS, shut again for the resume join', async () => {
  const p = paidPage();
  await live(p);
  assert.strictEqual(p.session.paidLocked(), false);
  drop(p);
  assert.strictEqual(p.session.paidLocked(), true, 'the seat still holds money');
  await p.frame(P.GIVE_UP_MS - 100);
  assert.strictEqual(p.session.paidLocked(), true, 'still shut just before the card offers the way back');
  await p.frame(200);
  assert.deepStrictEqual([p.session.paidLocked(), card(p).lobby], [false, true], 'the lock and the card open together');
  connect(p);
  assert.strictEqual(p.session.paidLocked(), true, 'the resume join is out');
  p.sock.fire('ag:joined', Object.assign({}, JOINED, { resumed: true, confirmed: true }));
  assert.strictEqual(p.session.paidLocked(), false);
  // a resume join with no answer opens the way back after JOIN_ANSWER_MS
  drop(p);
  connect(p);
  await p.frame(P.JOIN_ANSWER_MS + 10);
  assert.deepStrictEqual([p.session.paidLocked(), card(p).title, card(p).extra], [false, 'No answer', P.TEXT.noAnswerSeat]);
});

test('a hand-off page opened on its own: Back to lobby goes to the lobby page, never the free menu', async () => {
  const s = paidPage({ framed: false });
  await live(s);
  s.sock.fire('ag:dead', { lostMicro: 100000 });
  clickCard(s.doc, 'lobby');
  assert.strictEqual(s.win.location.href, '/');
  assert.strictEqual(menuOpen(s), false);
});

// The shipped page (handoff: true) with the Free rung's storage must draw and send exactly what the page without the
// hand-off does (free-room parity; gate G's harness loads neither ag.html nor agPaid).
async function freeRun(extra) {
  const realRandom = Math.random;
  let seed = 7;
  Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  try {
    const p = bootPage({ net: true, pad: true, parent: fakeParent(), location: { origin: 'http://localhost' },
      cfg: Object.assign({ url: '/ag', ghostBannerPx: 90, portrait: true, tabStorage: memStore({ stake: '0', entryToken: '' }) }, extra) });
    connect(p);
    p.sock.fire('ag:f', W.encodeBundle([{ t: 'hello' }, BORDER]));
    await p.frames(3);
    p.session.play('me');
    p.sock.fire('ag:f', W.encodeBundle([{ t: 'world', eats: [], cells: [], removed: [] }, { t: 'own', id: 9 },
      { t: 'world', eats: [], cells: [cell({ id: 9 }), cell({ id: 10, x: 400, size: 50, name: 'bob' })], removed: [] }]));
    await p.frames(5);
    p.mod.camera.setMouse(900, 100);
    await p.frames(3);
    p.key('keydown', 32); p.key('keyup', 32);
    p.key('keydown', 87); p.key('keyup', 87);
    p.key('keydown', 81); await p.frames(20); p.key('keyup', 81);
    p.key('keydown', 27); p.key('keyup', 27);
    await p.frames(2);
    p.key('keydown', 27); p.key('keyup', 27);
    p.sock.fire('ag:f', W.encodeBundle([{ t: 'world', eats: [], cells: [], removed: [9] }]));
    await p.frames(5);
    drop(p);
    await p.frames(3);
    connect(p);
    await p.frames(3);
    return {
      calls: JSON.stringify(p.doc.calls), emitted: JSON.stringify(p.sock.emitted), sent: JSON.stringify(p.sent),
      state: JSON.stringify(p.session.state()), io: JSON.stringify(p.ioArgs), menu: menuOpen(p),
      paidDom: !!p.session.state().paidEnd || !!p.doc.getElementById('ag-paid-hint'), n: p.doc.calls.length
    };
  } finally {
    Math.random = realRandom;
  }
}
test('free-room parity with the shipped config: handoff true and the Free rung storage draw and send exactly what the page without it does', async () => {
  const without = await freeRun({});
  const shipped = await freeRun({ handoff: true });
  const stale = await freeRun({ handoff: true, tabStorage: memStore({ stake: '0', entryToken: '', agResume: JSON.stringify({ k: 'rk-x', s: 1 }) }) });
  assert.ok(without.n > 1000, 'a real session was drawn: ' + without.n);
  for (const [tag, run] of [['shipped', shipped], ['stale key, Free rung', stale]]) {
    assert.strictEqual(run.calls, without.calls, tag + ': identical draw calls');
    assert.strictEqual(run.emitted, without.emitted, tag + ': identical socket sends');
    assert.strictEqual(run.sent, without.sent, tag + ': identical send hook');
    assert.strictEqual(run.state, without.state, tag + ': identical session state');
    assert.strictEqual(run.io, without.io, tag + ': io(/ag, {}) with no auth');
    assert.strictEqual(run.menu, without.menu, tag);
    assert.strictEqual(run.paidDom, false, tag + ': no paid card or hint in the free DOM');
  }
});
