'use strict';
// The owner's join pushes (server/joinAlerts.js, Owen 2026-10-16: paid loud, free muted):
//   - a paid join goes to the topic Owen's phone already has (notify.js's own) at high priority, a free one to the
//     free topic at low priority
//   - the text is name, game, rung and region; never a wallet, and a whole address typed as a name is not shown either
//   - one push per player per room per window, at most a cap per topic per 10 min, the held-back count named next time
//   - the off switches, and nothing a caller hands in (or a push that throws) can throw out to a join path
//   - the hooks: notify.pushOwner takes a topic url; the paid slither door, agar.io's free join and Paper's free join
//     call theirs only once the seat exists, and a hook that throws costs no seat and no refund
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { createJoinAlerts, cleanName, rungText, RULES, PAID_URL, FREE_URL, WINDOW_MS } = require('../server/joinAlerts');

const WALLET = 'DurablePayer111111111111111111111111111111';

function rig(env) {
  const sent = [];
  const clock = { t: 1e9 };
  const alerts = createJoinAlerts({ push: (m, o) => sent.push({ m, o }), region: 'na', env: env || {},
    now: () => clock.t, log: { error() {} } });
  return { sent, clock, alerts, joined: alerts.joined };
}

test('a paid join: the paid topic, loud, the name and the room, never the wallet', () => {
  const r = rig();
  r.joined({ game: 'snake', stake: 0.5, name: 'Owen', wallet: WALLET });
  assert.equal(r.sent.length, 1);
  const { m, o } = r.sent[0];
  assert.equal(m, 'Owen joined slither.io $0.50 in NA');
  assert.equal(PAID_URL, null, "notify.js's own topic, the one Owen's phone has");
  assert.deepEqual(o, { title: 'Paid join: slither.io $0.50', tags: 'moneybag', priority: 'high' });
  assert.ok(!m.includes(WALLET) && !o.title.includes(WALLET));
  assert.match(o.title, /^[\x20-\x7e]+$/, 'the Title header is plain ASCII');
});

test('a free join: the free topic, quiet; a duel queue says queued; the room\'s own region when given', () => {
  const r = rig();
  r.joined({ game: 'knockout', stake: 0, name: 'Kai', queued: true });
  r.joined({ game: 'agar', name: 'Ann', region: 'eu' });
  assert.deepEqual(r.sent.map((x) => x.m), ['Kai queued for Knockout Free in NA', 'Ann joined agar.io Free in EU']);
  for (const { o } of r.sent) {
    assert.equal(o.url, FREE_URL);
    assert.equal(o.priority, 'low');
    assert.match(o.title, /^Free join: /);
  }
  // a region that is not two letters is never echoed
  r.joined({ game: 'paper', name: 'Bo', region: '<b>' });
  assert.equal(r.sent[2].m, 'Bo joined Paper.io Free in NA');
});

test('names: control characters stripped, cut to 24, a whole wallet address or nothing shows as A player', () => {
  assert.equal(cleanName('  Owen\u0000\u001b[31m  '), 'Owen[31m');
  assert.equal(cleanName('l'.repeat(40)), 'l'.repeat(24));   // l is not base58, so not an address
  assert.equal(cleanName('Ann\u202e\u2028\u2066x'), 'Annx', 'no bidi override or line separator');
  assert.equal(cleanName('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), 'A player');
  for (const v of ['', '   ', null, undefined, 5, {}, ['a']]) assert.equal(cleanName(v), 'A player');
  assert.equal(rungText(1), '$1.00');
  for (const v of [0, -1, NaN, '0', null, undefined, 'x', {}]) assert.equal(rungText(v), 'Free');
});

test('one push per player per room: the same player again is silent until the window ends', () => {
  const r = rig();
  r.joined({ game: 'agar', stake: 0.5, name: 'P', wallet: 'W1' });
  r.joined({ game: 'agar', stake: 0.5, name: 'P renamed', wallet: 'W1' });   // a rebuy under another name
  assert.equal(r.sent.length, 1);
  r.joined({ game: 'agar', stake: 1, name: 'P', wallet: 'W1' });            // another room
  r.joined({ game: 'paper', stake: 0.5, name: 'P', wallet: 'W1' });         // another game
  r.joined({ game: 'agar', stake: 0.5, name: 'P', wallet: 'W2' });          // another player
  assert.equal(r.sent.length, 4);
  r.clock.t += RULES.paid.perKeyMs;
  r.joined({ game: 'agar', stake: 0.5, name: 'P', wallet: 'W1' });
  assert.equal(r.sent.length, 5, 'again once the window is over');
  // free: keyed by name, a longer window
  r.joined({ game: 'sl', name: 'F' });
  r.joined({ game: 'sl', name: 'F' });
  assert.equal(r.sent.length, 6);
  r.clock.t += RULES.free.perKeyMs - 1;
  r.joined({ game: 'sl', name: 'F' });
  assert.equal(r.sent.length, 6);
  r.clock.t += 1;
  r.joined({ game: 'sl', name: 'F' });
  assert.equal(r.sent.length, 7);
});

test('a burst: at most the cap per topic per 10 minutes, the rest counted and named on the next push', () => {
  const r = rig();
  const cap = RULES.free.cap;
  for (let i = 0; i < cap + 3; i++) r.joined({ game: 'agar', name: 'n' + i });
  assert.equal(r.sent.length, cap);
  // the paid topic has its own cap: a free burst never holds back a paid join
  r.joined({ game: 'agar', stake: 1, name: 'Payer', wallet: 'WP' });
  assert.equal(r.sent.length, cap + 1);
  assert.equal(r.sent[cap].o.priority, 'high');
  r.clock.t += WINDOW_MS;
  r.joined({ game: 'agar', name: 'late' });
  assert.equal(r.sent.length, cap + 2);
  assert.equal(r.sent[cap + 1].m, 'late joined agar.io Free in NA (+3 more held back)');
  r.joined({ game: 'agar', name: 'later' });
  assert.equal(r.sent[cap + 2].m, 'later joined agar.io Free in NA', 'the count is named once');
  const p = rig();
  for (let i = 0; i < RULES.paid.cap + 2; i++) p.joined({ game: 'snake', stake: 0.5, name: 'p' + i, wallet: 'W' + i });
  assert.equal(p.sent.length, RULES.paid.cap);
});

test('a flood of new names cannot grow the latch without bound', () => {
  const r = rig();
  for (let i = 0; i < 6000; i++) r.joined({ game: 'agar', name: 'flood' + i });
  assert.equal(r.sent.length, RULES.free.cap);   // and it did not throw or hang
});

test('off switches: NTFY_JOINS_OFF stops both, NTFY_FREE_JOINS_OFF the free one only; the topics can be moved', () => {
  const off = rig({ NTFY_JOINS_OFF: '1' });
  off.joined({ game: 'snake', stake: 0.5, name: 'a', wallet: 'W' });
  off.joined({ game: 'snake', name: 'b' });
  assert.equal(off.sent.length, 0);
  const env = { NTFY_FREE_JOINS_OFF: '1' };
  const free = rig(env);
  free.joined({ game: 'snake', name: 'b' });
  free.joined({ game: 'snake', stake: 0.5, name: 'a', wallet: 'W' });
  assert.deepEqual(free.sent.map((x) => x.o.priority), ['high']);
  env.NTFY_FREE_JOINS_OFF = '';                    // read on every call, no restart
  free.joined({ game: 'snake', name: 'c' });
  assert.equal(free.sent.length, 2);
  const moved = rig({ NTFY_PAID_URL: 'https://ntfy.sh/p-test', NTFY_FREE_URL: 'https://ntfy.sh/f-test' });
  moved.joined({ game: 'snake', stake: 1, name: 'a', wallet: 'W' });
  moved.joined({ game: 'snake', name: 'b' });
  assert.deepEqual(moved.sent.map((x) => x.o.url), ['https://ntfy.sh/p-test', 'https://ntfy.sh/f-test']);
});

test('nothing a caller hands in, and no push that throws, ever throws out to a join path', () => {
  const throwing = createJoinAlerts({ push: () => { throw new Error('boom'); }, env: {}, log: { error() {} } });
  assert.doesNotThrow(() => throwing.joined({ game: 'snake', stake: 0.5, name: 'a', wallet: 'W' }));
  const r = rig();
  const hostile = { get game() { throw new Error('getter'); } };
  for (const v of [undefined, null, 5, 'x', [], {}, hostile, { stake: { valueOf() { throw new Error('v'); } } },
    { name: { toString() { throw new Error('s'); } } }]) {
    assert.doesNotThrow(() => r.joined(v));
  }
  r.joined({ game: 'constructor', name: 'a' });
  assert.equal(r.sent[r.sent.length - 1].o.title, 'Free join: a game Free', 'an unknown game is never a prototype key');
  const noLog = createJoinAlerts({ push: () => { throw new Error('boom'); }, env: {}, log: { error() { throw new Error('log'); } } });
  assert.doesNotThrow(() => noLog.joined({ game: 'snake', name: 'a' }));
  assert.doesNotThrow(() => createJoinAlerts().joined({ game: 'snake', name: 'a' }), 'no push wired: silent');
});

test('notify.pushOwner: a { url } posts to that topic\'s path; without one, the players topic as before', (t) => {
  const notify = require('../server/notify');
  const calls = [];
  t.mock.method(https, 'request', (opts) => {
    calls.push(opts);
    return { on() {}, write() {}, end() {}, destroy() {} };
  });
  const was = process.env.NTFY_DISABLED;
  delete process.env.NTFY_DISABLED;
  try {
    notify.pushOwner('a', { url: FREE_URL, title: 'T', priority: 'high' });
    notify.pushOwner('b', { title: 'U' });
  } finally {
    if (was === undefined) delete process.env.NTFY_DISABLED; else process.env.NTFY_DISABLED = was;
  }
  process.env.NTFY_DISABLED = '1';
  try {
    notify.pushOwner('c', { url: FREE_URL });
  } finally {
    if (was === undefined) delete process.env.NTFY_DISABLED; else process.env.NTFY_DISABLED = was;
  }
  assert.deepEqual(calls.map((c) => [c.hostname, c.path, c.headers.Priority || null]),
    [['ntfy.sh', '/duelseries-free-8382', 'high'], ['ntfy.sh', '/duelseries-players-8382', null]]);
});

// ---- the hooks ------------------------------------------------------------------------------------------------------

test('paid slither door: onSeated once the seat holds the money, never for a refusal; a throw costs no seat', () => {
  const { paidRig } = require('./slPaidFakes');
  const seen = [];
  const r = paidRig({ door: { onSeated: (x) => seen.push(x) } });
  const s = r.join(r.mint({ walletAddress: 'WSEAT' }), { nick: 'seat' });
  assert.ok(r.paid.roomOf(s.id), 'seated');
  assert.deepEqual(seen, [{ name: 'seat', stake: 0.5, wallet: 'WSEAT' }]);
  const again = r.join(r.mint({ walletAddress: 'WSEAT' }), { nick: 'again' });   // one paid seat per wallet
  assert.ok(!r.paid.roomOf(again.id));
  assert.equal(seen.length, 1, 'a refused join is never announced');

  const bad = paidRig({ door: { onSeated: () => { throw new Error('push broke'); } } });
  const b = bad.join(bad.mint({ walletAddress: 'WTHROW' }), { nick: 'thrower' });
  assert.ok(bad.paid.roomOf(b.id), 'still seated');
  assert.deepEqual(bad.payout.refunds, [], 'nothing refunded');
  assert.deepEqual(bad.ledger.refunds, []);
  assert.deepEqual(bad.entries.map((e) => e.wallet), ['WTHROW'], 'the buy-in row still written');
});

test('agar.io free join: notifyJoin with the cleaned name once seated, never on a refusal; a throw is harmless', () => {
  const W = require('../shared/agWire');
  const { AgArenas } = require('../server/ag/agArenas');
  const { attachAgSockets } = require('../server/ag/agSockets');
  const { FIXTURE } = require('./agLawsFixture');
  const quiet = { error() {}, warn() {}, log() {} };
  const names = [];
  const maint = { on: false };
  let throwIt = false;
  const a = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 3, log: quiet });
  const h = attachAgSockets(null, a, {
    socketRL: () => true, log: quiet, ops: { get: () => ({ maintenance: maint.on }) },
    sanitizeName: (n) => (typeof n === 'string' ? n.replace(/[<>]/g, '').trim().slice(0, 20) : '') || 'Player',
    notifyJoin: (n) => { if (throwIt) throw new Error('boom'); names.push(n); },
  });
  let sn = 0;
  const sock = () => {
    const s = { id: 'ja' + ++sn, handshake: { address: '10.9.0.' + sn, headers: {} }, conn: { writeBuffer: [] },
      handlers: {}, other: [], on(ev, fn) { this.handlers[ev] = fn; },
      emit(ev, p) { if (ev !== 'ag:f') this.other.push([ev, p]); else W.decodeBundle(p); },
      fire(ev, ...x) { this.handlers[ev](...x); } };
    h.attach(s);
    return s;
  };
  const s = sock();
  s.fire('ag:join', { name: ' <i>Ann</i> ' });
  assert.ok(a.roomOfSocket(s.id).seatOf(s.id).joined);
  assert.deepEqual(names, ['iAnn/i']);
  maint.on = true;
  sock().fire('ag:join', { name: 'Refused' });
  maint.on = false;
  assert.equal(names.length, 1, 'maintenance refused it: no push');
  throwIt = true;
  const t2 = sock();
  assert.doesNotThrow(() => t2.fire('ag:join', { name: 'Bob' }));
  assert.ok(a.roomOfSocket(t2.id).seatOf(t2.id).joined, 'seated anyway');
});

test('Paper free join: onFreeJoin once the seat exists, never on a respawn or a paid seat; a throw is harmless', (t) => {
  t.mock.method(console, 'error', () => {});
  const createPaperSockets = require('../server/paperSockets');
  const { PaperArenas } = require('../server/paper/PaperArenas');
  const { REASON } = require('../server/paper/ArenaGame');
  const { isStake } = require('../server/stakeRules');
  const io = { to: () => ({ emit() {}, volatile: { emit() {} } }) };
  const hooks = { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {} };
  const arenas = new PaperArenas({ io, hooks, paidEnabled: true, autoTick: false, warm: false });
  const names = [];
  let throwIt = false;
  let tn = 0;
  const tokens = new Map();
  const take = (token, stake) => {
    if (Number(stake) === 0) return { ok: true, worth: 0 };
    const tk = tokens.get(token);
    if (!tk) return { ok: false, worth: 0 };
    tokens.delete(token);
    return { ok: true, worth: tk, paid: tk, walletAddress: 'WP' + token };
  };
  const paper = createPaperSockets({
    arenas, ops: { get: () => ({ maintenance: false }) }, socketRL: () => true, isStake,
    sanitizeName: (n) => String(n == null ? '' : n).replace(/[<>]/g, '').trim().slice(0, 20) || 'Player',
    consumePaidEntryAtStake: take, entryStore: { consumeAtStake: take }, payout: { refund() {} }, paidEnabled: true,
    onFreeJoin: ({ name }) => { if (throwIt) throw new Error('boom'); names.push(name); },
  });
  let sn = 0;
  const sock = () => {
    const s = { id: 'jp' + ++sn, handlers: {}, got: [], rooms: new Set(), on(ev, fn) { this.handlers[ev] = fn; },
      emit(ev, p) { this.got.push([ev, p]); }, join(x) { this.rooms.add(x); }, leave(x) { this.rooms.delete(x); },
      fire(ev, p) { this.handlers[ev](p); } };
    paper.attach(s);
    return s;
  };
  const s = sock();
  s.fire('pp:join', { name: 'Free1', stake: 0 });
  assert.ok(s._ppRoom && s._ppRoom.hasLiveUnit(s.id));
  assert.deepEqual(names, ['Free1']);
  s._ppRoom.game.kill(s._ppRoom.seatOfSocket(s.id).unit, undefined, REASON.SELF_CROSS);
  s.fire('pp:respawn', {});
  assert.ok(s._ppRoom.hasLiveUnit(s.id), 'respawned');
  assert.equal(names.length, 1, 'a respawn is not a join');
  const p = sock();
  tokens.set('tk' + ++tn, 0.5);
  p.fire('pp:join', { name: 'Paid1', stake: 0.5, entryToken: 'tk' + tn });
  assert.ok(p._ppRoom && p._ppRoom.hasLiveUnit(p.id), 'paid seated');
  assert.equal(names.length, 1, 'a paid seat rides onStake, not onFreeJoin');
  throwIt = true;
  const q = sock();
  assert.doesNotThrow(() => q.fire('pp:join', { name: 'Free2', stake: 0 }));
  assert.ok(q._ppRoom && q._ppRoom.hasLiveUnit(q.id), 'seated anyway');
});
