'use strict';
/* Product tracking (Owen 2026-10-29: "track absolutely everything", organized): the one plan (shared/trackPlan.js),
   the browser helper every page sends through (public/js/shared/dsTrack.js), the server's batched capture
   (server/analytics.js) and the relayed-transfer reader (server/txSummary.js).

   The plan is checked for shape, and the WHOLE codebase is swept for event names: every DSTrack.event / phEvent /
   analytics.track call site must name a planned event, nothing but the two helpers may call posthog.capture, and
   every game page loads the plan and the helper. The helper runs under a stand-in DOM: a free game sends its start
   and end, a paid one leaves both to the server, leaving mid-game is a quit, a frame sends through the lobby,
   first touch is read once (UTMs, ad click ids, /play/<game>), and money landing after Add funds is a funding. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PLAN = require('../shared/trackPlan');
const HELPER = fs.readFileSync(path.join(ROOT, 'public', 'js', 'shared', 'dsTrack.js'), 'utf8');
const PLAN_SRC = fs.readFileSync(path.join(ROOT, 'shared', 'trackPlan.js'), 'utf8');

// ── the plan ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('every planned event has who, about and only known properties', () => {
  for (const [name, ev] of Object.entries(PLAN.EVENTS)) {
    assert.match(name, /^[a-z][a-z0-9_]*$/, name + ' is snake_case');
    assert.ok(['client', 'server', 'both'].includes(ev.who), name + ' who');
    assert.ok(typeof ev.about === 'string' && ev.about.length > 10, name + ' about');
    for (const p of ev.props) assert.ok(PLAN.PROPS[p], name + ': ' + p + ' has a type');
  }
  // the four areas Owen picked are all there
  for (const n of ['game_started', 'game_ended', 'game_quit', 'game_perf', 'game_disconnected', 'add_funds_opened', 'funded',
    'withdraw_opened', 'withdraw_sent', 'signed_in', 'signin_abandoned', 'lobby_tab_viewed', 'game_card_clicked']) {
    assert.ok(PLAN.EVENTS[n], n);
  }
});

test('clean() keeps planned properties, types them and drops the rest', () => {
  const c = PLAN.clean('game_ended', { game: 'snake', paid: 'true', stake: '0.5', result: 'cashed_out', duration_s: 61.23,
    score: '1200', bogus: 1, wallet: 'abc' });
  assert.strictEqual(c.ok, true);
  assert.deepStrictEqual(c.props, { game: 'slither', paid: true, stake: 0.5, result: 'cashed_out', duration_s: 61.23, score: 1200 });
  assert.deepStrictEqual(c.dropped.sort(), ['bogus', 'wallet']);
  assert.strictEqual(PLAN.clean('game_ended', { result: 'exploded' }).props.result, undefined);
  assert.strictEqual(PLAN.clean('made_up_event', {}).ok, false);
  assert.strictEqual(PLAN.clean('$pageview', { anything: 1 }).ok, true, 'PostHog own events pass');
  for (const [alias, want] of [['/sl', 'slither'], ['ag', 'agar'], ['paper-arena', 'paper'], ['pacman', 'chomp'], ['KNOCKOUT', 'knockout']]) {
    assert.strictEqual(PLAN.game(alias), want, alias);
  }
  assert.strictEqual(PLAN.game('not-a-game'), null);
});

// ── the codebase follows it ──────────────────────────────────────────────────────────────────────────────────────

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'wallet', 'vendor', 'lib'].includes(e.name)) walk(p, out); }
    else if (/\.(js|jsx|mjs|html)$/.test(e.name) && !/\.min\.js$/.test(e.name)) out.push(p);
  }
  return out;
}
const FILES = [...walk(path.join(ROOT, 'public'), []), ...walk(path.join(ROOT, 'server'), []), ...walk(path.join(ROOT, 'wallet-widget', 'src'), [])];

test('every event name sent anywhere is in the plan', () => {
  const bad = [];
  const re = /(?:DSTrack\.event|phEvent|analytics\.track|\.track)\(\s*['"]([a-zA-Z0-9_$]+)['"]/g;
  for (const f of FILES) {
    const s = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(s))) {
      const name = m[1];
      if (name.startsWith('$')) continue;
      if (/\.track\(/.test(m[0]) && !/analytics\.track|DSTrack/.test(m[0]) && !PLAN.EVENTS[name]) continue;   // other .track() helpers (agInflight.track(...))
      if (!PLAN.EVENTS[name]) bad.push(path.relative(ROOT, f) + ': ' + name);
    }
  }
  assert.deepStrictEqual(bad, [], 'events not in shared/trackPlan.js');
});

test('only the two helpers talk to PostHog directly', () => {
  const allowed = new Set(['public/js/posthog-init.js', 'public/js/shared/dsTrack.js']);
  const bad = [];
  for (const f of FILES) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (allowed.has(rel) || rel.startsWith('server/')) continue;
    const s = fs.readFileSync(f, 'utf8');
    if (/posthog\.(capture|identify|register|reset)\(/.test(s)) bad.push(rel);
  }
  assert.deepStrictEqual(bad, []);
});

test('every game page loads the plan and the helper, and the lobby loads PostHog first', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
  const missing = [];
  for (const f of pages) {
    const s = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
    if (!/dsPerfHud\.js/.test(s) && f !== 'v2.html' && f !== 'sl.html') continue;
    const a = s.indexOf('/shared/trackPlan.js'), b = s.indexOf('/js/shared/dsTrack.js');
    if (a < 0 || b < 0 || b < a) missing.push(f);
  }
  assert.deepStrictEqual(missing, [], 'pages without trackPlan.js then dsTrack.js');
  const v2 = fs.readFileSync(path.join(ROOT, 'public', 'v2.html'), 'utf8');
  const init = v2.indexOf('/js/posthog-init.js');
  assert.ok(init > 0 && init < v2.indexOf('/js/shared/dsTrack.js'), 'v2.html loads posthog-init.js before dsTrack.js');
  assert.match(v2, /posthog-init\.js"[^>]*data-no-visit-ping/, 'the lobby sends no visit ping (unchanged)');
});

// ── the browser helper, under a stand-in DOM ─────────────────────────────────────────────────────────────────────

function makeWindow(o) {
  o = o || {};
  const listeners = {};
  const store = new Map(Object.entries(o.storage || {}));
  const sent = [];
  const docListeners = {};
  const win = {
    console: { warn() {}, log() {} },
    location: { origin: 'https://duelseries.com', pathname: o.path || '/', search: o.search || '', hostname: 'duelseries.com' },
    document: {
      hidden: false, referrer: o.referrer || '',
      head: { appendChild: o.append || (() => {}) }, documentElement: { appendChild() {} },
      createElement() { return { setAttribute() {} }; },
      addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
    },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    fire(t, e) { for (const f of listeners[t] || []) f(e || {}); },
    matchMedia: () => ({ matches: !!o.phone }),
    fetch: o.fetch || (() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
    URLSearchParams, URL, JSON, Math, Date, Error, Object, Array, String, Number, isFinite,
    setTimeout, clearTimeout,
    CustomEvent: function (t, init) { this.type = t; this.detail = init && init.detail; },
    _sent: sent, _store: store,
  };
  win.window = win;
  win.top = o.top || win;
  if (!o.noPosthog) {
    win.posthog = {
      supers: {},
      capture(name, props) { sent.push({ name, props: Object.assign({}, this.supers, props) }); },
      register(p) { Object.assign(this.supers, p); },
      identify(id, set, setOnce) { sent.push({ name: '$identify', id, set, setOnce }); },
      reset() { this.supers = {}; sent.push({ name: '$reset' }); },
      setPersonProperties(p) { sent.push({ name: '$set', p }); },
      captureException(err, props) { sent.push({ name: '$exception', message: err.message, props }); },
    };
  }
  vm.createContext(win);
  vm.runInContext(PLAN_SRC, win);
  vm.runInContext(HELPER, win);
  return win;
}
const names = (w) => w._sent.map((e) => e.name);
const find = (w, n) => w._sent.filter((e) => e.name === n);

test('a free game: opened, started, ended with its result, and an FPS and ping summary', () => {
  const w = makeWindow({ path: '/knockout' });
  const g = w.DSTrack.game('knockout', { paid: false, stake: 0, mode: 'free' });
  g.queue(); g.start({ vs_bot: true });
  for (let i = 0; i < 10; i++) w.DSTrack.sample({ fps: 50 + i, ping: 40 + i });
  g.end({ result: 'won', score: 3 });
  assert.deepStrictEqual(names(w).filter((n) => n !== '$identify'), ['game_opened', 'queue_joined', 'game_started', 'game_ended', 'game_perf']);
  const end = find(w, 'game_ended')[0].props;
  assert.strictEqual(end.game, 'knockout'); assert.strictEqual(end.result, 'won'); assert.strictEqual(end.paid, false);
  assert.strictEqual(end.vs_bot, true); assert.ok(end.duration_s >= 0); assert.strictEqual(end.page, 'game');
  const perf = find(w, 'game_perf')[0].props;
  assert.strictEqual(perf.fps_min, 50); assert.strictEqual(perf.ping_max, 49); assert.strictEqual(perf.samples, 20);
  assert.strictEqual(perf.fps_p10, 50); assert.strictEqual(perf.ping_p90, 48);
});

test('a paid game: the start and end are the server\'s, the page still sends its summary and a quit', () => {
  const w = makeWindow({ path: '/sl' });
  const g = w.DSTrack.game('sl', { stake: 1 });
  g.start(); w.DSTrack.sample({ fps: 60 });
  w.fire('pagehide');
  const n = names(w);
  assert.ok(!n.includes('game_started') && !n.includes('game_ended'), n.join());
  assert.ok(n.includes('game_quit') && n.includes('game_perf'));
  const q = find(w, 'game_quit')[0].props;
  assert.strictEqual(q.stage, 'playing'); assert.strictEqual(q.paid, true); assert.strictEqual(q.game, 'slither');
});

test('leaving a free game mid-game is a quit and a game_ended left; leaving after the end card is nothing', () => {
  const w = makeWindow({ path: '/paper-arena' });
  const g = w.DSTrack.game('paper', { stake: 0 });
  g.start();
  w.fire('pagehide');
  const end = find(w, 'game_ended')[0].props;
  assert.strictEqual(end.result, 'left'); assert.strictEqual(find(w, 'game_quit').length, 1);
  const w2 = makeWindow({ path: '/paper-arena' });
  const g2 = w2.DSTrack.game('paper', { stake: 0 });
  g2.start(); g2.end({ result: 'died' }); w2.fire('pagehide');
  assert.strictEqual(find(w2, 'game_quit').length, 0);
});

test('a game frame sends through the lobby (one PostHog), and its errors become exceptions', () => {
  const lobby = makeWindow({ path: '/' });
  const frame = makeWindow({ path: '/knockout', top: lobby, noPosthog: true });
  const g = frame.DSTrack.game('knockout', { stake: 0 });
  g.start();
  assert.ok(names(lobby).includes('game_started'), 'sent by the lobby');
  assert.strictEqual(find(lobby, 'game_started')[0].props.page, 'game');
  frame.fire('error', { error: new Error('boom'), message: 'boom' });
  frame.fire('error', { error: new Error('boom'), message: 'boom' });
  assert.strictEqual(find(lobby, '$exception').length, 1, 'each message once');
  // the whole tab closing: the lobby's pagehide says goodbye for the frame first
  lobby.fire('pagehide');
  assert.strictEqual(find(lobby, 'game_quit').length, 1);
  frame.fire('pagehide');
  assert.strictEqual(find(lobby, 'game_quit').length, 1, 'still once');
});

test('unknown events and server-only events are refused in the browser', () => {
  const w = makeWindow();
  assert.strictEqual(w.DSTrack.event('cashed_out', { amount: 5 }), false);
  assert.strictEqual(w.DSTrack.event('withdraw_sent', { amount: 5 }), false);
  assert.strictEqual(w.phEvent('staked', {}), undefined);
  assert.strictEqual(w._sent.filter((e) => !e.name.startsWith('$')).length, 0);
});

test('first touch is read once from UTMs, ad click ids and invite links, and rides on every event', () => {
  const w = makeWindow({ path: '/play/knockout', search: '?utm_source=tiktok&utm_campaign=launch&ttclid=abc', referrer: 'https://www.tiktok.com/' });
  w.DSTrack.event('lobby_tab_viewed', { tab: 'play' });
  const p = find(w, 'lobby_tab_viewed')[0].props;
  assert.strictEqual(p.ft_source, 'tiktok'); assert.strictEqual(p.ft_campaign, 'launch'); assert.strictEqual(p.ft_click, 'ttclid');
  assert.strictEqual(p.ft_invite, 'knockout'); assert.strictEqual(p.ft_medium, 'paid'); assert.strictEqual(p.ft_referrer, 'tiktok.com');
  assert.strictEqual(p.is_owner, false); assert.strictEqual(p.page, 'lobby');
  // a later visit from elsewhere keeps the first
  const again = makeWindow({ search: '?utm_source=google', storage: { ds_ft: w._store.get('ds_ft') } });
  again.DSTrack.event('lobby_tab_viewed', { tab: 'play' });
  assert.strictEqual(find(again, 'lobby_tab_viewed')[0].props.ft_source, 'tiktok');
  const direct = makeWindow({ path: '/' });
  direct.DSTrack.event('lobby_tab_viewed', { tab: 'play' });
  assert.strictEqual(find(direct, 'lobby_tab_viewed')[0].props.ft_source, 'direct');
  const invite = makeWindow({ path: '/play/pool8' });
  invite.DSTrack.event('lobby_tab_viewed', { tab: 'play' });
  const ip = find(invite, 'lobby_tab_viewed')[0].props;
  assert.strictEqual(ip.ft_source, 'invite'); assert.strictEqual(ip.ft_invite, 'pool8');
});

test('signing in identifies by wallet with first touch set once; the owner is marked; signing out resets', async () => {
  const calls = [];
  const w = makeWindow({ search: '?utm_source=reddit', fetch: (url, opt) => {
    calls.push(url);
    const body = url === '/api/br/owner' ? { isOwner: JSON.parse(opt.body).wallet === 'OWNER' } : { signedIn: false };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  } });
  w.duelWallet = { ready: true, authenticated: true, address: 'OWNER', sol: 1 };
  w.fire('duelwallet:change');
  const id = find(w, '$identify')[0];
  assert.strictEqual(id.id, 'OWNER'); assert.strictEqual(id.setOnce.ft_source, 'reddit');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.includes('/api/owner/session') && calls.includes('/api/br/owner'));
  w.DSTrack.event('lobby_tab_viewed', { tab: 'wallet' });
  assert.strictEqual(find(w, 'lobby_tab_viewed')[0].props.is_owner, true);
  assert.strictEqual(w._store.get('ds_owner'), '1', 'remembered on this device');
  w.duelWallet = { ready: true, authenticated: false, address: '' };
  w.fire('duelwallet:change');
  assert.ok(names(w).includes('signed_out') && names(w).includes('$reset'));
  w.DSTrack.event('lobby_tab_viewed', { tab: 'play' });
  assert.strictEqual(find(w, 'lobby_tab_viewed')[1].props.is_owner, true, 'the device stays the owner\'s after a reset');
});

test('money landing within 30 minutes of Add funds is a funding; a payout after a paid game is not', () => {
  const w = makeWindow();
  const wallet = (sol) => { w.duelWallet = { ready: true, authenticated: true, address: 'P1', sol, solUsd: 200 }; w.fire('duelwallet:change'); };
  wallet(0.1);
  wallet(0.2);
  assert.strictEqual(find(w, 'funded').length, 0, 'no Add funds opened yet');
  w.DSTrack.event('add_funds_opened', { where: 'wallet', method: 'card' });
  wallet(0.35);
  const f = find(w, 'funded');
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].props.method, 'card'); assert.strictEqual(f[0].props.amount_sol, 0.15); assert.strictEqual(f[0].props.amount, 30);
  assert.strictEqual(f[0].props.verified, false);
  const g = w.DSTrack.game('knockout', { stake: 1 }); g.start(); g.end({ result: 'won' });
  wallet(0.5);
  assert.strictEqual(find(w, 'funded').length, 1, 'a rise right after a paid game is its payout');
});

// ── the server ───────────────────────────────────────────────────────────────────────────────────────────────────

function serverAnalytics() {
  const a = require('../server/analytics');
  a._reset();
  const out = [];
  a._setTransport((body) => out.push(...JSON.parse(body).batch));
  a.configure({ isOwner: (w) => w === 'OWNER', isBot: (w) => w === 'BOTBANK', region: 'na' });
  return { a, out };
}

test('server: a paid game\'s start and end carry the wallet, the stake, the duration and the net', () => {
  const { a, out } = serverAnalytics();
  a.gameStarted({ wallet: 'W1', game: 'snake', stake: 1 });
  a.gameEnded({ wallet: 'W1', game: 'slither', result: 'cashed_out', amount: 2.7 });
  a.flush();
  assert.deepStrictEqual(out.map((e) => e.event), ['game_started', 'game_ended']);
  const [s, e] = out;
  assert.strictEqual(s.distinct_id, 'W1'); assert.strictEqual(s.properties.paid, true); assert.strictEqual(s.properties.game, 'slither');
  assert.strictEqual(s.properties.$set_once.first_paid_game, 'slither'); assert.strictEqual(s.properties.$set.is_payer, true);
  assert.strictEqual(s.properties.is_owner, false); assert.strictEqual(s.properties.region, 'na');
  assert.strictEqual(e.properties.stake, 1); assert.strictEqual(e.properties.net, 1.7); assert.ok(e.properties.duration_s >= 0);
  assert.strictEqual(e.properties.$lib, 'duelseries-server');
});

test('server: bots are never sent, the owner is marked, unknown names are refused, earnings keep their region', () => {
  const { a, out } = serverAnalytics();
  assert.strictEqual(a.gameStarted({ wallet: 'BOTBANK', game: 'agar', stake: 1 }), false);
  assert.strictEqual(a.gameStarted({ wallet: 'X', game: 'agar', stake: 1, bot: true }), false);
  a.track('stake_paid', 'OWNER', { stake: 0.5 });
  assert.strictEqual(a.track('cashed_out', 'W', {}), false);
  a.captureEarning({ source: 'game_rake', amountUsdc: 0.1, game: 'knockout', lobbyType: 'knockout', wallet: 'W', region: 'eu' });
  a.flush();
  assert.deepStrictEqual(out.map((e) => e.event), ['stake_paid', 'house_earning']);
  assert.strictEqual(out[0].properties.is_owner, true); assert.strictEqual(out[0].properties.$set.is_owner, true);
  assert.strictEqual(out[1].properties.region, 'eu'); assert.strictEqual(out[1].properties.amount, 0.1);
});

test('server: events are batched, at most one POST a second, sooner at 50', async () => {
  const { a } = serverAnalytics();
  const posts = [];
  a._setTransport((body) => posts.push(JSON.parse(body).batch.length));
  for (let i = 0; i < 120; i++) a.track('stake_paid', 'W' + i, { stake: 1 });
  assert.deepStrictEqual(posts, [50, 50], 'two full batches went at once');
  await new Promise((r) => setTimeout(r, 1100));
  assert.deepStrictEqual(posts, [50, 50, 20]);
});

test('txSummary reads a SOL transfer and a USDC transferChecked off signed bytes', () => {
  const { Keypair, SystemProgram, Transaction, TransactionInstruction, PublicKey } = require('@solana/web3.js');
  const { summarize } = require('../server/txSummary');
  const from = Keypair.generate(), to = Keypair.generate();
  const tx = new Transaction({ feePayer: from.publicKey, recentBlockhash: '11111111111111111111111111111111' })
    .add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to.publicKey, lamports: 250000000 }));
  tx.sign(from);
  const s = summarize(tx.serialize());
  assert.strictEqual(s.payer, from.publicKey.toBase58()); assert.strictEqual(s.lamports, 250000000);
  assert.strictEqual(s.to, to.publicKey.toBase58()); assert.strictEqual(s.token, null);
  const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(5000000n, 1); data[9] = 6;
  const tok = new Transaction({ feePayer: from.publicKey, recentBlockhash: '11111111111111111111111111111111' })
    .add(new TransactionInstruction({ programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data,
      keys: [Keypair.generate(), Keypair.generate(), Keypair.generate()].map((k) => ({ pubkey: k.publicKey, isSigner: false, isWritable: true }))
        .concat([{ pubkey: from.publicKey, isSigner: true, isWritable: false }]) }));
  tok.sign(from);
  const t = summarize(tok.serialize());
  assert.deepStrictEqual(t.token, { amount: 5000000, decimals: 6 }); assert.strictEqual(t.lamports, 0);
  assert.strictEqual(summarize(Buffer.from('not a transaction')), null);
});

test('server/index.js records every paid duel and every arena buy-in', () => {
  const s = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  for (const [lobby, game] of [['knockoutLobby', 'knockout'], ['battleshipLobby', 'battleship'], ['swimLobby', 'swim'],
    ['headSoccerLobby', 'headsoccer'], ['pool8Lobby', 'pool8'], ['airHockeyLobby', 'airhockey'], ['rooftopLobby', 'rooftop'],
    ['crossy.lobby', 'crossy']]) {
    assert.ok(s.includes(`trackDuelLobby(${lobby}, '${game}');`), game);
  }
  assert.match(s, /if \(ARENA_ENTRY\.has\(game\)\) analytics\.gameStarted\(/);
  assert.match(s, /analytics\.configure\(\{ isOwner: \(w\) => OWNER_WALLETS\.has\(w\)/);
});

test('duelTrack: a paid match starts each paid seat, settles won/lost, a walk-out is left, a draw refunds, once per room', () => {
  const { a, out } = serverAnalytics();
  const { createDuelTrack } = require('../server/duelTrack');
  const t = createDuelTrack({ analytics: a, houseCut: 0.1 });
  const calls = [];
  const lobby = { onSettled: (o) => { calls.push(['settle', o.roomId]); return 'paid'; }, onRefund: (o) => { calls.push(['refund', o.wallet]); } };
  t.wrap(lobby, 'knockout');
  lobby.onMatchStart({ roomId: 'ko_1', seats: [{ id: 's1', wallet: 'A', worth: 1 }, { id: 's2', wallet: 'B', worth: 1 }], vsBot: false });
  // B walked out: the room deleted B before settling, so only A is in the seats
  assert.strictEqual(lobby.onSettled({ roomId: 'ko_1', winnerId: 's1', why: 'opponent left', pot: 2, seats: [{ id: 's1', wallet: 'A', worth: 1, refund: 1 }] }), 'paid');
  lobby.onSettled({ roomId: 'ko_1', winnerId: 's1', why: 'opponent left', pot: 2, seats: [{ id: 's1', wallet: 'A', worth: 1, refund: 1 }] });
  lobby.onMatchStart({ roomId: 'ko_2', seats: [{ id: 'x', wallet: 'C', worth: 0.5 }, { id: 'y', wallet: 'D', worth: 0.5 }] });
  lobby.onSettled({ roomId: 'ko_2', winnerId: null, why: 'both out', pot: 1, seats: [{ id: 'x', wallet: 'C', worth: 0.5, refund: 0.5 }, { id: 'y', wallet: 'D', worth: 0.5, refund: 0.5 }] });
  lobby.onMatchStart({ roomId: 'ko_3', seats: [{ id: 'f', wallet: 'E', worth: 0 }, { id: 'bot', wallet: null, worth: 0 }] });
  lobby.onSettled({ roomId: 'ko_3', winnerId: 'f', why: '', pot: 0, seats: [] });
  lobby.onRefund({ wallet: 'F', name: 'n', amount: 1, why: 'nobody joined' });
  a.flush();
  assert.deepStrictEqual(calls, [['settle', 'ko_1'], ['settle', 'ko_1'], ['settle', 'ko_2'], ['settle', 'ko_3'], ['refund', 'F']], 'the money hooks ran every time');
  const ev = out.map((e) => [e.event, e.distinct_id, e.properties.result, e.properties.amount]);
  assert.deepStrictEqual(ev, [
    ['game_started', 'A', undefined, undefined], ['game_started', 'B', undefined, undefined],
    ['game_ended', 'A', 'won', 1.8], ['game_ended', 'B', 'left', 0],
    ['game_started', 'C', undefined, undefined], ['game_started', 'D', undefined, undefined],
    ['game_ended', 'C', 'draw', 0.5], ['game_ended', 'D', 'draw', 0.5],
    ['stake_refunded', 'F', undefined, 1],
  ]);
  assert.strictEqual(out[2].properties.net, 0.8);
  assert.strictEqual(out[3].properties.players, 2);
  const broken = createDuelTrack({ analytics: { gameStarted() { throw new Error('x'); }, gameEnded() { throw new Error('x'); }, track() { throw new Error('x'); } }, houseCut: 0.1 });
  const l2 = { onSettled: () => 'ok', onRefund: () => 'r' };
  broken.wrap(l2, 'pool8');
  assert.doesNotThrow(() => l2.onMatchStart({ roomId: 'p', seats: [{ wallet: 'A', worth: 1 }] }));
  assert.strictEqual(l2.onSettled({ roomId: 'p', winnerId: null, pot: 1, seats: [{ wallet: 'A', worth: 1, refund: 1 }] }), 'ok');
  assert.strictEqual(l2.onRefund({ wallet: 'A', amount: 1 }), 'r');
});

test('funding watch: a paid queue refund, a second rise, and another tab are never extra fundings; Privy says the method', () => {
  const store = {};
  const w = makeWindow({ storage: store });
  const wallet = (win, sol) => { win.duelWallet = { ready: true, authenticated: true, address: 'P1', sol, solUsd: 100 }; win.fire('duelwallet:change'); };
  wallet(w, 1);
  w.DSTrack.event('add_funds_opened', { where: 'wallet', method: 'any' });
  w.DSTrack.fundMethod('crypto');                      // the widget: Receive funds in Privy's sheet
  // a paid Knockout queue: the stake leaves, nobody joins, the refund comes back
  const g = w.DSTrack.game('knockout', { stake: 0.5 });
  g.queue(); wallet(w, 0.995); g.unqueue('nobody joined that table'); wallet(w, 1);
  assert.strictEqual(find(w, 'funded').length, 0, 'a refund is not money added');
  // the real funding, seen by two tabs sharing this browser's storage
  w._store.set('ds_paid_at', '0');
  const other = makeWindow({ storage: Object.fromEntries(w._store) });
  wallet(other, 1);
  wallet(w, 1.5);
  other._store.set('ds_fund', w._store.get('ds_fund'));   // the same localStorage
  wallet(other, 1.5);
  assert.strictEqual(find(w, 'funded').length, 1);
  assert.strictEqual(find(w, 'funded')[0].props.method, 'crypto');
  assert.strictEqual(find(other, 'funded').length, 0, 'the other tab sees it was counted');
  wallet(w, 2);
  assert.strictEqual(find(w, 'funded').length, 1, 'one funding per Add funds opening');
});

test('a lobby loading signed out while PostHog still holds the last wallet starts a new visitor', () => {
  const w = makeWindow();
  w.posthog.get_property = (k) => (k === '$user_state' ? 'identified' : undefined);
  w.posthog.__loaded = true;
  w.duelWallet = { ready: true, authenticated: false, address: '' };
  w.fire('duelwallet:change');
  assert.ok(names(w).includes('$reset'));
  assert.ok(!names(w).includes('signed_out'), 'nobody signed out here');
});

test('a game page opened on its own keeps its first events until PostHog has loaded', () => {
  let script = null;
  const w = makeWindow({ path: '/knockout', noPosthog: true, append: (s) => { script = s; } });
  w.DSTrack.game('knockout', { stake: 0 });
  assert.ok(script && /posthog-init\.js$/.test(script.src) && typeof script.onload === 'function');
  const sent = [];
  w.posthog = { capture: (n, p) => sent.push([n, p]), register() {} };
  script.onload();
  assert.deepStrictEqual(sent.map((e) => e[0]), ['game_opened']);
});

test('server: never geolocated to the AWS box, and a dev-money box sends nothing', () => {
  const { a, out } = serverAnalytics();
  a.track('stake_paid', 'W', { stake: 1 });
  a.flush();
  assert.strictEqual(out[0].properties.$geoip_disable, true);
  a._setTransport(null);
  a.configure({ disabled: true });
  const before = out.length;
  a.track('stake_paid', 'W', { stake: 1 });
  a.flush();
  assert.strictEqual(out.length, before);
  a.configure({ disabled: false });
});
