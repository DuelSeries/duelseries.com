'use strict';
// Total earnings is the NET a player has made (Owen 2026-11-05): paid out minus paid in, from the ledger
// (server/netEarnings.js), on every profile and on Top earners, with the owner kept off the board.
//
// The pure half runs everywhere. The SQL half runs against a real Postgres when NET_TEST_PG names an empty
// database it may write to (it builds the schema with db.init(), then drops and refills the ledger tables), e.g.
//   NET_TEST_PG=postgres://postgres@localhost:5433/ds_test node --test test/netEarnings.test.js
// and is skipped otherwise (there is no database on the build box).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const N = require('../server/netEarnings');

const OWNER = 'C5cnzckMwH459eEURA8NwuZcKVFMExpRcbRSAuULH3m9';
const REV = '24tf4BRDWvnAjFhpPxKczZSnWdUjKkVbXAc8x7Yj4Fff';
const BOTBANK = 'BotBank1111111111111111111111111111111111111';
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ─── pure ────────────────────────────────────────────────────────────────────

test('summarize: paid out minus paid in plus refunds, to the cent, never -0', () => {
  const s = (out, inn, back = 0) => N.summarize({ paid_out: String(out), paid_in: String(inn), refunded: String(back), cashouts: 1, rounds: 1 });
  assert.strictEqual(s(1.8, 1).net, 0.8, 'a win');
  assert.strictEqual(s(0.9, 1).net, -0.1, 'a flat $1 cash-out is the 10% cut');
  assert.strictEqual(s(0, 1).net, -1, 'a loss is the stake');
  assert.strictEqual(s(0, 1, 1).net, 0, 'a refunded round is nothing');
  assert.ok(Object.is(s(0.9, 0.9).net, 0), 'zero, not -0');
  assert.strictEqual(s('2.700000000', '1.000000000').net, 1.7, 'NUMERIC text');
  assert.strictEqual(s(0.000004, 0).net, 0, 'micro dust rounds to the cent');
  assert.strictEqual(s(0, 0.005).net, -0.01, 'half a cent rounds away from zero both ways');
  assert.deepStrictEqual(N.summarize(undefined), { net: 0, paidOut: 0, paidIn: 0, refunded: 0, cashouts: 0, rounds: 0 },
    'an account with nothing recorded is all zero');
  assert.strictEqual(N.summarize({ paid_out: 'x', paid_in: '0' }), null, 'a row that is not money is refused');
});

test('boardRows: players who are up only, ranked as read, ten at most, names never wallets', () => {
  const r = (wallet, out, inn, name, game) => ({ wallet, name, paid_out: String(out), cashouts: 2, paid_in: String(inn), rounds: 3, refunded: '0', game });
  const rows = [r(OWNER, 30, 5, 'Owen', 'knockout'), r('W2'.padEnd(44, 'x'), 3, 1, null, 'paper'), r('W3'.padEnd(44, 'x'), 1, 1, 'even')];
  for (let i = 0; i < 12; i++) rows.push(r('Z' + String(i).padEnd(43, 'z'), 1.5, 1, 'z' + i, 'snake'));
  const b = N.boardRows(rows);
  assert.strictEqual(b.length, 10);
  assert.deepStrictEqual(b[0], { rank: 1, name: 'Owen', game: 'Knockout', amount: 25, n: 2 });
  assert.deepStrictEqual(b[1], { rank: 2, name: 'W2xx…xxxx', game: 'Paper.io', amount: 2, n: 2 }, 'no name: the short wallet');
  assert.ok(!b.some((x) => x.name === 'even'), 'a player who is level is not a top earner');
  assert.strictEqual(N.boardRows(null), null);
  assert.strictEqual(N.boardRows([{ wallet: '' }]), null);
});

test('the SQL only reads, and Top earners leaves out what it is told to, the owner among them', () => {
  for (const sql of [N.SINCE_SQL, N.NET_ONE_SQL, N.NET_BOARD_SQL]) {
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(sql), 'read only');
  }
  assert.ok(N.NET_BOARD_SQL.includes('<> ALL ($1::text[])'));
  assert.ok(!N.NET_BOARD_SQL.includes(OWNER));
  assert.ok(/f\.paid = true/.test(N.REFUND_BACK) && /\(payout\|agowed\)/.test(N.REFUND_BACK),
    'only refunds that landed through the owed lane, for seated entries');
  const db = read('server/db.js');
  const prof = db.slice(db.indexOf('async function getProfile('), db.indexOf('// ─── Cosmetics'));
  assert.ok(/totalEarnings: net\.net/.test(prof), 'the public profile shows the net');
  const mine = db.slice(db.indexOf('async function getMyProfile('), db.indexOf('async function getProfile('));
  assert.ok(/totalEarnings: net\.net/.test(mine), 'and so does the player\'s own');
  const idx = read('server/index.js');
  assert.ok(/boardExclude: \(\) => \(botWallet && botWallet\.address \? \[botWallet\.address\] : \[\]\)/.test(idx), 'the Bot bank is off the board');
  assert.ok(/excludeWallets: \[\.\.\.OWNER_WALLETS, REVENUE_WALLET\],\s*previewExclude: \[REVENUE_WALLET\]/.test(idx),
    'the board leaves out what the strip does: the owner and the revenue wallet');
});

test('the pages show a net below zero as -$0.10, in red, and say what the figure is', () => {
  const pr = read('public/js/v2/profile.js');
  assert.ok(/const signed = n => \(Number\(n\) < 0 \? '-' : ''\) \+ money\(Math\.abs/.test(pr));
  assert.ok(/'Cash-outs minus buy-ins, after the 10% cut'/.test(pr) && /'No paid rounds yet'/.test(pr));
  assert.ok(!/cash-out'\) \+ ', after the 10% cut'/.test(pr), 'no longer a count of cash-outs');
  const so = read('public/js/v2/social.js');
  assert.ok(/el\('p-net'\)\.textContent = \(net < 0 \? '-' : ''\) \+ money\(Math\.abs\(net\)\)/.test(so));
  assert.ok(/el\('p-net'\)\.style\.color = net < 0 \? 'var\(--ds-red\)' : ''/.test(so));
  assert.ok(!/Global player earnings/.test(so), 'the cash-out total is not called earnings');
});

// ─── against Postgres ───────────────────────────────────────────────────────

const PG = process.env.NET_TEST_PG || '';
const H = 3600e3;
const T0 = Date.parse('2026-08-15T17:00:00Z');     // the first recorded buy-in
const at = (h) => new Date(T0 + h * H).toISOString();
const uuid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const W = (tag) => (tag + '1'.repeat(44)).slice(0, 44);

test('against Postgres: every kind of round, the owner off the board, nothing invented', { skip: !PG && 'NET_TEST_PG not set' }, async (t) => {
  process.env.DATABASE_URL = PG;
  for (const k of Object.keys(require.cache)) if (k.includes(path.join('server', 'db.js'))) delete require.cache[k];
  const db = require('../server/db');
  t.after(async () => { await db.pool.end(); await db.readPool.end(); });
  await db.pool.query(`DROP TABLE IF EXISTS accounts, earnings_history, stakes_history, failed_payouts, used_stake_sigs, house_revenue CASCADE`);
  const realLog = console.log; console.log = () => {};
  try { await db.init(); } finally { console.log = realLog; }
  const q = (sql, p) => db.pool.query(sql, p);
  const acct = (w, name, totalEarnings = 0) => q(`INSERT INTO accounts (google_id, name, total_earnings, created_at) VALUES ($1, $2, $3, $4)`, [w, name, totalEarnings, at(-24 * 60)]);
  const stake = (w, amt, game, h) => q(`INSERT INTO stakes_history (google_id, amount, game, created_at) VALUES ($1, $2, $3, $4)`, [w, amt, game, at(h)]);
  const paid = (w, amt, h) => q(`INSERT INTO earnings_history (google_id, amount, cad_amount, created_at) VALUES ($1, $2, $2, $3)`, [w, amt, at(h)]);
  const owed = (w, amt, reason, key, isPaid, h) => q(`INSERT INTO failed_payouts (wallet_address, amount_sol, name, reason, stake_sig, paid, created_at) VALUES ($1, $2, 'Player', $3, $4, $5, $6)`, [w, amt, reason, key, isPaid, at(h)]);

  const P = {
    win: W('Win'), flat: W('Flat'), loss: W('Loss'), refund: W('Refund'), refundOld: W('RefOld'), door: W('Door'),
    botWin: W('BotWin'), botLoss: W('BotLoss'), multi: W('Multi'), none: W('None'), owedNow: W('Owed'),
  };
  await stake(P.flat, 1, 'snake', 0);                       // the first buy-in on the site: counting starts here
  await acct(P.flat, 'flat'); await paid(P.flat, 0.9, 0.1); // joined $1, cashed out with what it came in with
  await acct(P.win, 'win'); await stake(P.win, 1, 'snake', 1); await paid(P.win, 1.8, 1.1);
  await acct(P.loss, 'loss'); await stake(P.loss, 1, 'paper', 2);
  // A paid duel refunded after the 2026-10-29 change: its inline payout failed and the owed lane paid it.
  await acct(P.refund, 'refund'); await stake(P.refund, 1, 'knockout', 3);
  await owed(P.refund, 1, 'refund knockout (left the queue): rpc down', 'payout:' + uuid(1), true, 3.1);
  // A paid duel refunded before 2026-10-29, when koSend booked the refund as a payout.
  await acct(P.refundOld, 'refundold'); await stake(P.refundOld, 0.5, 'battleship', 4); await paid(P.refundOld, 0.5, 4.1);
  // Refunded at the door, never seated: no stake row, and the stake ledger's refund row is not money back either.
  await owed(P.door, 1, 'refund paper join-lost', '5KtPn1LGuxhFiwjxErkxTb7XxtLVYUBe6Cn33ej7ATNo', true, 5);
  // Paid duels against a bot (the Bot bank stakes the other seat; it has no stake or payout rows of its own).
  await acct(P.botWin, 'botwin'); await stake(P.botWin, 1, 'knockout', 6); await paid(P.botWin, 1.8, 6.1);
  await acct(P.botLoss, 'botloss'); await stake(P.botLoss, 1, 'pool8', 7);
  // Several games, summed: +1.70, -0.50, +0.80, and an agar.io restart refund (keyed owed row) that is 0.
  await acct(P.multi, 'multi');
  await stake(P.multi, 1, 'snake', 8); await paid(P.multi, 2.7, 8.1);
  await stake(P.multi, 0.5, 'paper', 9);
  await stake(P.multi, 1, 'knockout', 10); await paid(P.multi, 1.8, 10.1);
  await stake(P.multi, 1, 'agar', 11); await owed(P.multi, 1, 'refund agar restart agowed:' + uuid(2), 'agowed:' + uuid(2), true, 11.1);
  await acct(P.none, 'none');
  // A refund still owed (not landed): the stake is out until it lands.
  await acct(P.owedNow, 'owednow'); await stake(P.owedNow, 1, 'knockout', 12);
  await owed(P.owedNow, 1, 'refund knockout (no winner)', 'payout:' + uuid(3), false, 12.1);
  // The owner: test cash-outs from before buy-ins were recorded (not counted), then real play.
  await acct(OWNER, 'Owen', 20.0);
  await paid(OWNER, 12, -500);
  for (let i = 0; i < 4; i++) await stake(OWNER, 1, 'knockout', 20 + i);
  await paid(OWNER, 1.8, 20.1); await paid(OWNER, 1.8, 21.1); await paid(OWNER, 0.9, 22.1);
  // The revenue wallet's rake sweeps are booked as payouts by the drainer; never a player.
  await acct(REV, 'rake-sweep'); await paid(REV, 9, 13);
  await acct(BOTBANK, 'Bot bank'); await paid(BOTBANK, 3, 14);

  const net = async (w) => (await db.getNetEarnings(w)).net;
  assert.strictEqual(await net(P.win), 0.8, 'win');
  assert.strictEqual(await net(P.flat), -0.1, 'flat cash-out: minus the 10% cut');
  assert.strictEqual(await net(P.loss), -1, 'loss: minus the stake');
  assert.strictEqual(await net(P.refund), 0, 'refund through the owed lane: 0');
  assert.strictEqual(await net(P.refundOld), 0, 'refund booked as a payout before 2026-10-29: 0');
  assert.strictEqual(await net(P.door), 0, 'refund of an entry never seated: 0, not +1');
  assert.strictEqual(await net(P.botWin), 0.8, 'paid duel won against a bot');
  assert.strictEqual(await net(P.botLoss), -1, 'paid duel lost to a bot');
  assert.strictEqual(await net(P.multi), 2, 'several games summed');
  assert.strictEqual(await net(P.none), 0, 'no paid rounds: 0');
  assert.strictEqual(await net(P.owedNow), -1, 'a refund not landed yet is not back yet');
  assert.strictEqual(await net(OWNER), 0.5, 'the owner: 4.50 back for 4.00 in, his pre-ledger cash-outs left out');

  const mine = await db.getMyProfile(P.flat);
  assert.strictEqual(mine.totalEarnings, -0.1);
  assert.deepStrictEqual({ ...mine.earnings, since: undefined },
    { paidOut: 0.9, paidIn: 1, refunded: 0, cashouts: 1, rounds: 1, since: undefined });
  assert.strictEqual(mine.earnings.since, new Date(T0).toISOString(), 'counted from the first recorded buy-in');
  assert.strictEqual((await db.getMyProfile(P.none)).totalEarnings, 0, 'an account with no paid rounds');
  assert.strictEqual(await db.getMyProfile(P.door), null, 'a wallet with nothing that counts has no profile, as before');
  const noAcct = W('NoAcct');
  await stake(noAcct, 1, 'snake', 15);
  assert.strictEqual((await db.getMyProfile(noAcct)).totalEarnings, -1, 'losses count before any account row exists');
  const pub = await db.getProfile('Owen');
  assert.strictEqual(pub.totalEarnings, 0.5, 'what others see is the same net');
  assert.strictEqual(pub.games.length, 4, 'the cash-out rows are still every cash-out');

  const { createEarnings } = require('../server/earnings');
  const e = createEarnings({ query: q, excludeWallets: [OWNER, REV], previewExclude: [REV], log: console,
    boardExclude: () => [BOTBANK] });
  const b = await e.board();
  assert.strictEqual(b.ok, true);
  assert.deepStrictEqual(b.top.map((r) => [r.rank, r.name, r.amount, r.game]), [
    [1, 'multi', 2, 'Agar.io'],          // one paid round in each of four games: the one played last
    [2, 'botwin', 0.8, 'Knockout'],
    [3, 'win', 0.8, 'Slither.io'],
  ], 'players who are up, by net; never the owner, the revenue wallet or the Bot bank');
});
