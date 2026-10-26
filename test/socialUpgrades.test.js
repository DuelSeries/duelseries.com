'use strict';
// The Social tab upgrades (Owen, 2026-10-15): the live top 3 and full board, player
// search, the profile's win rate, the squeezed and zoomable earnings graph, and the
// ?leaderboard=preview link that fills it all with sample players in one browser only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('../server/playerStats');
const { createEarnings, EARNINGS_SQL } = require('../server/earnings');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const OWNER = 'C5cnzckMwH459eEURA8NwuZcKVFMExpRcbRSAuULH3m9';
const REV = '24tf4BRDWvnAjFhpPxKczZSnWdUjKkVbXAc8x7Yj4Fff';
const A = 'AAAAbbbbccccddddeeeeffffgggghhhhiiiijjjjZZ11';
const CFG = { SHOW: true, MIN_TOTAL_USD: 0, REFRESH_MS: 60000, TIME_ZONE: 'America/Toronto' };
const quiet = { warn() {}, error() {}, log() {} };

// ─── search ──────────────────────────────────────────────────────────────────

test('search: a typed query is cleaned, capped and never an array or object', () => {
  assert.strictEqual(S.cleanQuery(['a', 'b']), '');
  assert.strictEqual(S.cleanQuery({ a: 1 }), '');
  assert.strictEqual(S.cleanQuery(undefined), '');
  assert.strictEqual(S.cleanQuery('  ne\u0000o\n '), 'neo');
  assert.strictEqual(S.cleanQuery('x'.repeat(500)).length, S.NAME_MAX);
});

test('search: LIKE wildcards are looked for literally, so "%" cannot list every player', () => {
  const [any, starts, n] = S.searchParams('50%_off\\', 99);
  assert.strictEqual(any, '%50\\%\\_off\\\\%');
  assert.strictEqual(starts, '50\\%\\_off\\\\%');
  assert.strictEqual(n, S.SEARCH_LIMIT, 'the server caps the result count whatever is asked');
  assert.deepStrictEqual(S.searchParams('NeO').slice(0, 2), ['%neo%', 'neo%'], 'case-insensitive');
});

test('search SQL: substring, starts-with first, unnamed accounts never listed, read only, capped', () => {
  assert.ok(/name ILIKE \$1 ESCAPE '\\'/.test(S.SEARCH_SQL), 'ILIKE with an ESCAPE character');
  assert.ok(/ORDER BY \(lower\(name\) LIKE \$2 ESCAPE '\\'\) DESC/.test(S.SEARCH_SQL), 'prefix matches first');
  assert.ok(/lower\(name\) <> 'player'/.test(S.SEARCH_SQL) && /name IS NOT NULL/.test(S.SEARCH_SQL));
  assert.ok(/LIMIT \$3\s*$/.test(S.SEARCH_SQL));
  assert.ok(/^SELECT name FROM accounts/.test(S.SEARCH_SQL), 'names only, never a wallet');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(S.SEARCH_SQL));
  const db = read('server/db.js');
  const fn = db.slice(db.indexOf('async function searchPlayerNames('), db.indexOf('/* The display name, stored'));
  assert.ok(/playerStats\.cleanQuery\(query\)/.test(fn) && /playerStats\.SEARCH_SQL/.test(fn), 'db uses the safe query');
  assert.ok(!/\$\{query\}/.test(fn), 'no raw query in a LIKE pattern');
});

// ─── a profile by its short wallet ───────────────────────────────────────────

test('short wallet: only the public short form opens a profile, base58 only', () => {
  assert.deepStrictEqual(S.parseShortWallet('C5cn…H3m9'), { head: 'C5cn', tail: 'H3m9' });
  assert.deepStrictEqual(S.parseShortWallet('C5cn...H3m9'), { head: 'C5cn', tail: 'H3m9' });
  for (const bad of ['C5c%…H3m9', 'C5cn…H3_9', 'C5cn…H3m', 'C0cn…H3m9', 'Il11…H3m9', OWNER, 'neo', '', null]) {
    assert.strictEqual(S.parseShortWallet(bad), null, String(bad));
  }
  assert.strictEqual(S.shortWallet(OWNER), 'C5cn…H3m9', 'the same short form the board prints');
  assert.ok(/^SELECT google_id FROM accounts/.test(S.SHORT_WALLET_SQL) && /LIMIT 2/.test(S.SHORT_WALLET_SQL),
    'two rows, so an ambiguous short form opens nothing');
  const db = read('server/db.js');
  const prof = db.slice(db.indexOf('async function getProfile('), db.indexOf('// ─── Cosmetics'));
  assert.ok(/ids\.rows\.length === 1/.test(prof), 'exactly one match');
  assert.ok(/name: shown \|\| row\.name/.test(prof), 'the name sent back is the short form again');
  assert.ok(!/google_id[,:]?\s*(gid|row\.google_id)\b[^)]*\}/.test(prof.slice(prof.indexOf('return {'))),
    'no wallet in the answer');
});

// ─── win rate ────────────────────────────────────────────────────────────────

test('win rate SQL: the strip\'s landed rule word for word, profit means take-home beats the entry', () => {
  assert.ok(S.LANDED_CLAUSE.length > 200);
  assert.ok(EARNINGS_SQL.includes(S.LANDED_CLAUSE), 'cut from the strip\'s own SQL');
  assert.ok(S.WIN_SQL.includes(S.LANDED_CLAUSE), 'and used as is');
  assert.ok(/9 \* h\.amount_usdc > st\.amount/.test(S.WIN_SQL), 'a cash-out for less than the entry is not a win');
  assert.ok(/h\.created_at < st\.next_at/.test(S.WIN_SQL), 'paired with the round it ended, not a later one');
  assert.ok(/created_at >= \$2::timestamptz/.test(S.WIN_SQL), 'from the USDC cutover');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(S.WIN_SQL), 'read only');
  const p = S.winParams(A);
  assert.strictEqual(p[0], A);
  assert.strictEqual(p.length, 4);
});

test('win rate: rounds merged by game as a player names it, won never above entered', () => {
  const w = S.summarizeWins([
    { game: 'snake', entered: 6, won: 2 },
    { game: 'slither', entered: 2, won: 1 },
    { game: 'paper', entered: 3, won: 9 },        // impossible, held to entered
    { game: 'knockout', entered: 0, won: 0 },     // no rounds, no line
    { game: null, entered: 1, won: 0 },
  ]);
  assert.strictEqual(w.entered, 12);
  assert.strictEqual(w.won, 6);
  assert.deepStrictEqual(w.games.map((g) => [g.game, g.entered, g.won]),
    [['Slither.io', 8, 3], ['Paper.io', 3, 3], ['Other', 1, 0]]);
  assert.ok(w.since);
  assert.deepStrictEqual(S.summarizeWins(null), { entered: 0, won: 0, since: w.since, games: [] });
});

test('the profile carries the win rate and a failed read costs only the tile', () => {
  const db = read('server/db.js');
  const prof = db.slice(db.indexOf('async function getProfile('), db.indexOf('// ─── Cosmetics'));
  assert.ok(/playerStats\.WIN_SQL, playerStats\.winParams\(gid\)/.test(prof));
  assert.ok(/catch \(e\) \{\s*console\.error\('\[PROFILE\] win rate'/.test(prof), 'caught');
  assert.ok(/winRate,/.test(prof));
});

// ─── the board ───────────────────────────────────────────────────────────────

function fakeQuery(rows) {
  const q = () => Promise.resolve({ rows });
  return q;
}
const row = (wallet, rake, name) => ({ wallet, game: 'slither', age: 3, n: 1, rake: String(rake), best_rake: String(rake), name });

test('board: the strip\'s own read, ranked, ten at most, owner never on it', async () => {
  const rows = [];
  for (let i = 0; i < 14; i++) rows.push(row('W' + String(i).padStart(43, 'x'), 0.1 + i / 100, 'p' + i));
  let asked = null;
  const q = (sql, params) => { asked = params; return Promise.resolve({ rows }); };
  const e = createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV], config: CFG, log: quiet });
  const b = await e.board();
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.top.length, 10);
  assert.deepStrictEqual(b.top.map((r) => r.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.strictEqual(b.top[0].name, 'p13');
  assert.ok(asked[1].includes(OWNER) && asked[1].includes(REV), 'the owner and revenue wallets are left out');
});

test('board: a failed read says so, and the strip switch does not empty the Social board', async () => {
  const bad = createEarnings({ query: () => Promise.reject(new Error('down')), excludeWallets: [OWNER, REV],
    previewExclude: [REV], config: CFG, log: quiet });
  assert.deepStrictEqual(await bad.board(), { ok: false, top: [] });
  const off = createEarnings({ query: fakeQuery([row(A, 0.2, 'neo')]), excludeWallets: [OWNER, REV],
    previewExclude: [REV], config: { ...CFG, SHOW: false }, log: quiet });
  assert.deepStrictEqual(await off.answer(false), { on: false }, 'the strip is off');
  assert.strictEqual((await off.board()).top[0].name, 'neo', 'the board is its own screen');
  const none = createEarnings({ query: null, excludeWallets: [], previewExclude: [], config: CFG, log: quiet });
  assert.deepStrictEqual(await none.board(), { ok: false, top: [] });
});

test('board route: /api/earnings/board, never cached', () => {
  const src = read('server/earnings/index.js');
  assert.ok(/app\.get\('\/api\/earnings\/board'/.test(src));
  assert.ok(/'\/api\/earnings\/board'[\s\S]{0,120}no-store/.test(src));
});

// ─── preview link ────────────────────────────────────────────────────────────

test('a preview link is never indexed', () => {
  const s = read('server/index.js');
  assert.ok(/PREVIEW_QUERY = \['leaderboard', 'earnings'\]/.test(s));
  assert.ok(/X-Robots-Tag', 'noindex, nofollow'/.test(s));
  assert.ok(/app\.get\('\/', noindexPreview,/.test(s) && /app\.get\('\/v2', noindexPreview,/.test(s));
});

// ─── the graph ───────────────────────────────────────────────────────────────

function chartWindow() {
  const win = { matchMedia: () => ({ matches: false }) };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('public/js/v2/chart.js'), win);
  return win;
}
const DAY = 864e5;

test('graph: a long quiet stretch is squeezed into a break, the busy days get the width', () => {
  const { V2ChartTimeMap: tm } = chartWindow();
  const t0 = Date.parse('2026-06-01T00:00:00Z');
  const busy = t0 + 94 * DAY;
  const ts = [t0, busy, busy + 3600e3, busy + 7200e3, busy + 7 * DAY, busy + 41 * DAY, busy + 42 * DAY];
  const m = tm(ts);
  // The usual gap here is a day, so anything from three days up is quiet.
  assert.deepStrictEqual(Array.from(m.breaks, (b) => Math.round(b.ms / DAY)), [94, 7, 34], 'lead-in, week, month');
  const weekly = [t0];
  for (let i = 1; i <= 10; i++) weekly.push(t0 + 30 * DAY + i * 7 * DAY);
  assert.deepStrictEqual(Array.from(tm(weekly).breaks, (b) => Math.round(b.ms / DAY)), [37],
    'a weekly player keeps an even line; only the month before their first cash-out goes');
  const today = busy + 70 * DAY;
  assert.strictEqual(tm(ts.concat([today]), true).breaks.length, 4, 'the run to today is judged too, four at most');
  const w = m.fwd(busy + 7200e3) - m.fwd(busy);
  assert.ok(w > 0.005, 'two hours of cash-outs are visible, not a hair: ' + w);
  for (const t of ts) assert.ok(Math.abs(m.inv(m.fwd(t)) - t) < 1000, 'the map runs both ways');
  assert.strictEqual(m.fwd(ts[0]), 0);
  assert.strictEqual(m.fwd(ts[ts.length - 1]), 1);
  for (let i = 1; i < ts.length; i++) assert.ok(m.fwd(ts[i]) >= m.fwd(ts[i - 1]), 'in order');
});

test('graph: nothing quiet, or nothing but quiet, is a plain straight map', () => {
  const { V2ChartTimeMap: tm } = chartWindow();
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  const even = tm([t0, t0 + DAY, t0 + 2 * DAY, t0 + 3 * DAY]);
  assert.strictEqual(even.breaks.length, 0);
  assert.ok(Math.abs(even.fwd(t0 + 1.5 * DAY) - 0.5) < 1e-9);
  assert.strictEqual(tm([t0, t0 + 90 * DAY]).breaks.length, 0, 'one gap and nothing else: nothing to squeeze');
  assert.strictEqual(tm([t0]).breaks.length, 0);
  // One cash-out, five days after joining, three days ago: the $0 lead-in goes, the run since stays.
  const one = tm([t0, t0 + 5 * DAY, t0 + 8 * DAY], true);
  assert.deepStrictEqual(Array.from(one.breaks, (b) => Math.round(b.ms / DAY)), [5]);
  assert.ok(one.fwd(t0 + 5 * DAY) < 0.1, 'the step is at the left, the total runs across');
});

test('graph: one gradient per chart, the line\'s own colour, and zoom on both graphs', () => {
  const src = read('public/js/v2/chart.js');
  assert.ok(/const gid = 'v2ag' \+ id/.test(src), 'the gradient id is the chart\'s own');
  assert.ok(!/id="v2ag"/.test(src), 'no shared id left');
  assert.ok(/stop-color:var\(--money\)/.test(src), 'the fill is the line\'s colour');
  assert.ok(/addEventListener\('wheel'/.test(src) && /touchmove/.test(src) && /data-z="reset"/.test(src),
    'wheel, pinch and Reset');
  assert.ok(/clip-path="url\(#' \+ cid/.test(src), 'a zoomed line stays inside the plot');
  assert.ok(/svg\.innerHTML = '<g pointer-events="none">'/.test(src),
    'the svg owns every touch: a redraw mid-pinch must not remove the node the fingers started on');
  const win = chartWindow();
  const svg = win.V2Chart([{ d: '2026-09-01T00:00:00Z', cum: 1.25 }, { d: '2026-10-01T00:00:00Z', cum: 3.5 }],
    (n) => '$' + n.toFixed(2), '2026-06-01T00:00:00Z', 700);
  assert.ok(/<svg class="v2chart"/.test(svg) && /url\(#v2ag\d+\)/.test(svg));
  assert.ok(/class="brk"/.test(svg), 'the quiet months before the first cash-out are a break');
});

// ─── the preview link, in the browser ────────────────────────────────────────

function previewWindow(search) {
  const classes = [];
  const win = { location: { search }, document: { getElementById: () => ({ classList: { add: (c) => classes.push(c) } }) } };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(read('public/js/v2/socialPreview.js'), win);
  return { P: win.V2SocialPreview, classes };
}

test('preview: without the link there are no sample players at all', () => {
  for (const s of ['', '?earnings=preview', '?leaderboard=previewx', '?xleaderboard=preview']) {
    const { P, classes } = previewWindow(s);
    assert.strictEqual(P.on, false, s);
    assert.strictEqual(P.board().top.length, 0);
    assert.strictEqual(P.search('ne').length, 0);
    assert.strictEqual(P.profile('neonviper'), null);
    assert.strictEqual(P.amountOf('neonviper'), null);
    assert.strictEqual(classes.length, 0);
  }
});

test('preview: fifty sample players, a few dollars to a few thousand, and profiles that add up', () => {
  const { P, classes } = previewWindow('?leaderboard=preview');
  assert.strictEqual(P.on, true);
  const all = Array.from(P.board(50).top);
  assert.strictEqual(all.length, 50);
  const amounts = all.map((r) => r.amount);
  assert.ok(amounts.every((a) => a >= 1 && a < 10000 && Math.abs(Math.round(a * 100) - a * 100) < 1e-6), 'dollars and cents');
  assert.ok(amounts[0] > 4000 && amounts[2] > 2000 && amounts[3] < amounts[2] / 1.5 && amounts[49] < 10, 'a clear top 3 and a long tail');
  assert.strictEqual(new Set(amounts).size, 50, 'no ties');
  const cents = amounts.reduce((s, a) => s + Math.round(a * 100), 0);
  assert.strictEqual(Math.round(P.total() * 100), cents, 'Global player winnings is the board added up');
  assert.deepStrictEqual(amounts, amounts.slice().sort((a, b) => b - a), 'biggest first');
  assert.strictEqual(P.board().top.length, 10, 'the full board is the top 10');
  for (const r of all) {
    const p = P.profile(r.name);
    assert.strictEqual(p.preview, true, 'every sample profile says it is one');
    const sum = p.games.reduce((s, g) => s + Math.round(g.amount * 100), 0);
    assert.strictEqual(sum, Math.round(r.amount * 100), r.name + ' cash-outs add up to the board');
    const w = p.winRate;
    assert.ok(w.won <= w.entered && w.entered <= p.gamesPlayed);
    assert.strictEqual(w.games.reduce((s, g) => s + g.entered, 0), w.entered, r.name + ' per-game rounds add up');
    assert.strictEqual(w.games.reduce((s, g) => s + g.won, 0), w.won, r.name + ' per-game wins add up');
    assert.ok(w.games.some((g) => g.game === r.game), r.name + ' board game is one they played');
  }
  assert.deepStrictEqual(Array.from(P.search('NE')), ['neonviper', 'fennec', 'Delphine', 'Ottoline', 'skyline_9'],
    'starts-with first, any case');
  assert.ok(classes.includes('ph-no-capture'), 'kept out of analytics and session replay');
});

test('preview: opening the link once keeps it on in that browser, ?leaderboard=off clears it', () => {
  const store = {};
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); },
               removeItem: (k) => { delete store[k]; } };
  const open = (search, storage) => {
    const win = { location: { search }, localStorage: storage,
                  document: { getElementById: () => ({ classList: { add() {} } }) } };
    win.window = win;
    vm.createContext(win);
    vm.runInContext(read('public/js/v2/socialPreview.js'), win);
    return win.V2SocialPreview;
  };
  assert.strictEqual(open('', ls).on, false, 'a fresh browser sees only the real board');
  assert.strictEqual(open('?leaderboard=preview', ls).on, true);
  assert.deepStrictEqual(store, { dsLbPreview: '1' }, 'only the on flag is stored, never the players');
  assert.strictEqual(open('', ls).on, true, 'stays on without the link');
  assert.strictEqual(open('?leaderboard=off', ls).on, false);
  assert.deepStrictEqual(store, {}, 'off clears it');
  assert.strictEqual(open('', ls).on, false);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); },
                   removeItem() { throw new Error('blocked'); } };
  assert.strictEqual(open('?leaderboard=preview', broken).on, true, 'blocked storage still shows the link');
  assert.strictEqual(open('', broken).on, false);
});

test('preview: the sample players never leave the browser', () => {
  const src = read('public/js/v2/socialPreview.js');
  for (const bad of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'sessionStorage', 'WebSocket', 'io(', 'posthog.']) {
    assert.ok(!src.includes(bad), 'socialPreview.js has no ' + bad);
  }
  assert.deepStrictEqual(src.match(/localStorage\.\w+\([^)]*\)/g),
    ["localStorage.removeItem(KEY)", "localStorage.setItem(KEY, '1')", "localStorage.getItem(KEY)"],
    'the one stored thing is the on flag');
  assert.ok(/if \(pv\) \{ drawWin\(\{ on: true, total: pv\.total\(\), preview: pv \}\); return; \}/.test(read('public/js/v2/social.js')),
    'Global player winnings in the preview is drawn without asking the server, tagged Sample');
  const lead = read('public/js/v2/leaders.js');
  assert.ok(/if \(p\) \{ data = p\.board\(10\); failed = false; draw\(\); drawSheet\(\); return; \}/.test(lead),
    'the preview board is drawn without asking the server');
  const soc = read('public/js/v2/social.js');
  assert.ok(/let p = \(pv && pv\.profile\(name\)\) \|\| PROFILES\.get\(name\);/.test(soc),
    'a sample profile is made here, never fetched');
  assert.ok(/'<span class="lb-tag p-tag">' \+ PV\(\)\.tag \+ '<\/span> sample player'/.test(soc) &&
    /'<span class="lb-tag">' \+ P\(\)\.tag \+ '<\/span>'/.test(lead), 'tagged Sample on screen');
  // Sample figures are never marked LIVE: the board heading, the full board and Global player winnings.
  assert.ok(/live\.hidden = !!P\(\);/.test(lead));
  assert.ok(/\(P\(\) \? '<span class="lb-tag">' \+ P\(\)\.tag \+ '<\/span>'\s*: '<span class="lb-live'/.test(lead));
  assert.ok(/\(d\.preview \? '' : '<span class="win-live">/.test(soc) && /<div class="win-note">' \+ d\.preview\.note/.test(soc));
});

test('sample board: config.js SAMPLE_BOARD shows it to every visitor, labelled Sample', () => {
  const open = (search, cfg) => {
    const win = { location: { search }, document: { getElementById: () => ({ classList: { add() {} } }) } };
    win.window = win;
    vm.createContext(win);
    if (cfg) vm.runInContext(cfg, win);
    vm.runInContext(read('public/js/v2/socialPreview.js'), win);
    return win.V2SocialPreview;
  };
  const cfg = read('public/js/v2/config.js');
  assert.ok(/^\s*SAMPLE_BOARD: (true|false),$/m.test(cfg), 'a one-line switch');
  const on = open('', cfg.replace(/SAMPLE_BOARD: (true|false)/, 'SAMPLE_BOARD: true'));
  assert.strictEqual(on.on, true, 'on for a fresh browser');
  assert.strictEqual(on.tag, 'Sample');
  assert.strictEqual(on.note, 'Sample players to preview the board.');
  assert.strictEqual(on.board(50).top.length, 50);
  assert.strictEqual(open('', cfg.replace(/SAMPLE_BOARD: (true|false)/, 'SAMPLE_BOARD: false')).on, false, 'false = the real board');
  const html = read('public/v2.html');
  assert.ok(html.indexOf('/js/v2/config.js') > 0 && html.indexOf('/js/v2/config.js') < html.indexOf('/js/v2/socialPreview.js'),
    'config.js loads before socialPreview.js');
  // The strip and the Wallet never read the sample players.
  for (const f of ['public/js/v2/earnings.js', 'public/js/v2/stats.js', 'public/js/v2/wallet.js']) {
    assert.ok(!/V2SocialPreview|SAMPLE_BOARD/.test(read(f)), f + ' stays real');
  }
});

test('search and profiles share a rate limit: a person typing never meets it, a script does', () => {
  const s = read('server/index.js');
  assert.ok(/const socialLimiter = rateLimit\(\{ windowMs: 10 \* 1000, max: 40,/.test(s));
  assert.ok(/app\.get\('\/api\/profile\/:name', socialLimiter,/.test(s));
  assert.ok(/app\.get\('\/api\/players\/search', socialLimiter,/.test(s));
});
