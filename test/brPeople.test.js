'use strict';
// The battle royale's $20 house prize and who counts as a different PERSON (night review 2026-10-29, findings 4 and
// 17): a proven wallet costs nothing (any keypair made offline signs the play:identify proof), so the two-wallet rule
// was met by one person with two tabs or a script's thirty sockets, and the house paid $20 to a throwaway key.
//   - clientAddr.addressGroup: an IPv4 address is itself, an IPv6 address its /64
//   - brPrizeRule.countPeople: min(distinct wallets, distinct networks); stakedPeople: the same over the wallets that
//     really played paid (stakes_history), the winner among them, a lookup that fails holds the prize
//   - db.walletsWithStakes: one SELECT DISTINCT over stakes_history, no query for no wallets
//   - brMatch on a real SlRoom: one network's wallets are one person (prize held), a fifth living snake from one
//     network is refused 'limit' (a different network, an unknown address and a freed seat are welcome), startedSeats
//     is the doors-shut snapshot, holdPrize turns a decided match's prize to held for that match only
//   - slSockets setBr: the socket's address reaches the seat, and the fifth br socket from one address is refused
//   - payBattleRoyaleWinner, lifted from server/index.js and run on stubs: a free-wallet match is held and pushed to
//     Owen, never sent; two people who played paid, on two networks, are paid once; a failed lookup holds it
//   - second pass: one automatic prize a week per wallet and per winner's network (brPrizeRule.recentPrize, on a real
//     brJournal); 'checking' is journaled before the lookup's await and the boot sweep holds it, never sends it; a
//     proxy's own (loopback/private) address is no network

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { addressGroup, clientAddress } = require('../server/clientAddr');
const { countPeople, stakedPeople, recentPrize, netOf, COOLDOWN_DAYS } = require('../server/slBr/brPrizeRule');
const { createBrJournal } = require('../server/slBr/brJournal');
const { SlRoom } = require('../server/sl/slRoom');
const { createRng } = require('../server/sl/slRng');
const { makeFixture } = require('./slLawsFixture');
const { fakeTimers, bareSocket, fakeView } = require('./slNetFakes');
const { BRM, createBrMatch } = require('../server/slBr/brMatch');

const LAWS = makeFixture();
const P = LAWS.L7.value;
const quiet = { log() {}, warn() {}, error() {} };

function makeBr(o) {
  const opts = o || {};
  const ft = fakeTimers(1000);
  const decided = [];
  const rng = createRng(5);
  const match = createBrMatch({ laws: LAWS, log: quiet, rand: () => rng.next(), now: () => 1.7e12,
    onDecided: (m) => decided.push(m.matchId), lastStore: opts.lastStore, seatsPerAddr: opts.seatsPerAddr });
  const room = new SlRoom(LAWS, { seed: 7, view: fakeView(), br: match, clock: ft.clock, timers: ft.timers,
    autoTick: false, shippableOnly: false, prey: false, now: () => 1.7e12, log: quiet });
  return { ft, room, match, decided };
}

function seat(room, nick, wallet, ip) {
  return room.seat(bareSocket(), { nick, cv: 1, wallet, ip });
}

function steps(ft, room, n) {
  for (let i = 0; i < n; i++) {
    ft.advance(P);
    room.wake();
  }
}

// Goes live at once, then every snake but `keep` dies: the match is decided for keep's seat.
function decideFor(b, keep) {
  assert.strictEqual(b.match.startMatch('test', { countdownMs: 0 }), true);
  assert.strictEqual(b.match.state, 'running');
  b.room.sim.forEachSnake((s) => {
    if (s.id !== keep.snakeId) b.room.sim.kill(s.id);
  });
  steps(b.ft, b.room, 5);
  assert.strictEqual(b.match.state, 'over');
  assert.strictEqual(b.match.winner.id, keep.snakeId);
}

// ---------------------------------------------------------------------------------------------------------------
// the pure parts

test('addressGroup: IPv4 is itself (mapped or not), IPv6 is its /64, anything else is no address', () => {
  assert.strictEqual(addressGroup('203.0.113.9'), '203.0.113.9');
  assert.strictEqual(addressGroup('::ffff:203.0.113.9'), '203.0.113.9');
  const a = addressGroup('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
  assert.strictEqual(a, '2001:db8:1:2::/64');
  for (const same of ['2001:DB8:0001:0002::1', '2001:db8:1:2::', '2001:db8:1:2:ffff::1.2.3.4', '2001:db8:1:2::9%eth0']) {
    assert.strictEqual(addressGroup(same), a, same);
  }
  assert.notStrictEqual(addressGroup('2001:db8:1:3::1'), a, 'the next /64 is another network');
  assert.strictEqual(addressGroup('2001:db8::1'), '2001:db8:0:0::/64');
  for (const bad of ['', 'junk', '1.2.3', null, undefined, 5, {}]) assert.strictEqual(addressGroup(bad), '', String(bad));
});

test('addressGroup: a proxy\'s own address (loopback, private) is no network, so a missing X-Forwarded-For is not one', () => {
  for (const proxy of ['127.0.0.1', '::ffff:127.0.0.1', '10.0.0.5', '172.31.4.9', '192.168.1.2', '::1', 'fd00::1']) {
    assert.strictEqual(addressGroup(proxy), '', proxy);
  }
  // nginx without the header (or with a hop that is not an address): clientAddress leaves the proxy, which is unknown
  assert.strictEqual(addressGroup(clientAddress('127.0.0.1', undefined)), '');
  assert.strictEqual(addressGroup(clientAddress('172.31.4.9', '[2001:db8::1]:443')), '');
  // the hop it wrote is the player's network, as before
  assert.strictEqual(addressGroup(clientAddress('127.0.0.1', '198.51.100.7')), '198.51.100.7');
  assert.strictEqual(addressGroup('172.32.0.1'), '172.32.0.1', 'just outside 172.16/12 is a real address');
});

test('countPeople: one network\'s wallets are one person; an unknown network is one shared bucket', () => {
  assert.strictEqual(countPeople([]), 0);
  assert.strictEqual(countPeople([{ wallet: 'A', net: '1.1.1.1' }, { wallet: 'B', net: '2.2.2.2' }]), 2);
  assert.strictEqual(countPeople([{ wallet: 'A', net: '1.1.1.1' }, { wallet: 'B', net: '1.1.1.1' }]), 1,
    'two free wallets from one address');
  assert.strictEqual(countPeople([{ wallet: 'A', net: '1.1.1.1' }, { wallet: 'A', net: '2.2.2.2' }]), 1,
    'one wallet from two networks');
  assert.strictEqual(countPeople([{ wallet: 'A', net: '' }, { wallet: 'B', net: '' }, { wallet: 'C' }]), 1);
  assert.strictEqual(countPeople([{ wallet: '', net: '1.1.1.1' }, { net: '2.2.2.2' }, null, { wallet: 'A', net: '3.3.3.3' }]), 1);
  // thirty offline keypairs from one address are still one person
  const sybil = [];
  for (let i = 0; i < 30; i++) sybil.push({ wallet: 'K' + i, net: '198.51.100.7' });
  assert.strictEqual(countPeople(sybil), 1);
});

test('stakedPeople: paid only for a winner who played paid plus another person who did, on another network', async () => {
  const seats = [{ wallet: 'WIN', net: '1.1.1.1' }, { wallet: 'BOB', net: '2.2.2.2' }, { wallet: 'K1', net: '1.1.1.1' }];
  const asked = [];
  const lookup = (set) => async (ws) => { asked.push(ws); return new Set(ws.filter((w) => set.includes(w))); };
  assert.deepStrictEqual(await stakedPeople({ seats, winner: 'WIN', lookup: lookup(['WIN', 'BOB']) }),
    { ok: true, people: 2, winnerStaked: true });
  assert.deepStrictEqual(asked[0], ['WIN', 'BOB', 'K1'], 'each started wallet once');
  // the other paid wallet is on the winner's network: one person
  assert.deepStrictEqual(await stakedPeople({ seats, winner: 'WIN', lookup: lookup(['WIN', 'K1']) }),
    { ok: false, people: 1, winnerStaked: true });
  // the winner never played paid (a fresh keypair): held, however many others did
  assert.deepStrictEqual(await stakedPeople({ seats, winner: 'K1', lookup: lookup(['WIN', 'BOB']) }),
    { ok: false, people: 2, winnerStaked: false });
  // nobody played paid (offline keypairs only)
  assert.deepStrictEqual(await stakedPeople({ seats, winner: 'WIN', lookup: lookup([]) }),
    { ok: false, people: 0, winnerStaked: false });
  // a winner who is not among the started seats is never paid on someone else's history
  assert.strictEqual((await stakedPeople({ seats, winner: 'ZED', lookup: async () => new Set(['ZED', 'WIN', 'BOB']) })).ok,
    false);
  // a lookup that fails or answers nonsense: held, never paid on a guess
  assert.deepStrictEqual(await stakedPeople({ seats, winner: 'WIN', lookup: async () => { throw new Error('db down'); } }),
    { ok: false, people: null, winnerStaked: false });
  assert.strictEqual((await stakedPeople({ seats, winner: 'WIN', lookup: () => { throw new Error('sync'); } })).ok, false);
  assert.strictEqual((await stakedPeople({ seats, winner: 'WIN', lookup: async () => ['WIN', 'BOB'] })).ok, false);
  assert.strictEqual((await stakedPeople({ seats: [], winner: 'WIN', lookup: lookup(['WIN']) })).ok, false);
  assert.strictEqual((await stakedPeople({ seats, winner: 'WIN' })).ok, false, 'no lookup');
  assert.strictEqual((await stakedPeople()).ok, false);
});

test('recentPrize: an automatic prize to this wallet, or to a winner on this network, inside the days; netOf', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-10-29T12:00:00Z');
  const ago = (d) => new Date(now - d * DAY).toISOString();
  const prizes = [
    { matchId: 'm1', state: 'paid', wallet: 'WIN', net: '1.1.1.1', at: ago(3) },
    { matchId: 'm2', state: 'held', wallet: 'HELD', net: '5.5.5.5', at: ago(1) },
    { matchId: 'm3', state: 'paid', wallet: 'OLD', net: '6.6.6.6', at: ago(8) },
    { matchId: 'm4', state: 'unknown', wallet: 'UNK', net: '7.7.7.7', at: ago(1) },
    { matchId: 'm5', state: 'checking', wallet: 'CHK', net: '', at: ago(0) },
    { matchId: 'm6', state: 'failed', wallet: 'NOAT', net: '8.8.8.8', at: null },
  ];
  const q = (wallet, net, extra) => recentPrize(Object.assign({ prizes, wallet, net, now, days: 7 }, extra || {}));
  assert.strictEqual(COOLDOWN_DAYS, 7);
  assert.strictEqual(q('WIN', '9.9.9.9').matchId, 'm1', 'the same wallet from another network');
  assert.strictEqual(q('NEW', '1.1.1.1').matchId, 'm1', 'a fresh wallet on the last winner\'s network');
  assert.strictEqual(q('NEW', '9.9.9.9'), null);
  assert.strictEqual(q('HELD', '5.5.5.5'), null, 'a held prize was never paid automatically');
  assert.strictEqual(q('OLD', '6.6.6.6'), null, 'eight days ago is outside the week');
  assert.strictEqual(q('OLD', '6.6.6.6', { days: 9 }).matchId, 'm3');
  assert.strictEqual(q('UNK', '').matchId, 'm4', 'unknown may have landed');
  assert.strictEqual(q('CHK', '').matchId, 'm5', 'a decision in flight counts');
  assert.strictEqual(q('ZZZ', ''), null, 'an unknown network matches nothing');
  assert.strictEqual(q('NOAT', '').matchId, 'm6', 'a time that cannot be read counts as recent');
  assert.strictEqual(q('WIN', '1.1.1.1', { matchId: 'm1' }), null, 'never its own match');
  assert.strictEqual(q('WIN', '1.1.1.1', { days: 0 }), null, '0 turns it off');
  assert.strictEqual(recentPrize(), null);
  assert.strictEqual(recentPrize({ prizes: null, wallet: 'WIN', now, days: 7 }), null);
  const seats = [{ wallet: 'WIN', net: '1.1.1.1' }, { wallet: 'BOB' }];
  assert.deepStrictEqual([netOf(seats, 'WIN'), netOf(seats, 'BOB'), netOf(seats, 'ZED'), netOf(null, 'WIN'), netOf(seats)],
    ['1.1.1.1', '', '', '', '']);
});

test('db.walletsWithStakes: one SELECT DISTINCT over stakes_history for the distinct wallets, none for no wallets', async () => {
  const db = require('../server/db');
  const seen = [];
  const was = db.pool.query;
  db.pool.query = async (sql, params) => {
    seen.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    return { rows: [{ google_id: 'A' }, { google_id: 'C' }], rowCount: 2 };
  };
  try {
    const got = await db.walletsWithStakes(['A', 'B', 'A', '', null, 7, 'x'.repeat(65), 'C']);
    assert.ok(got instanceof Set);
    assert.deepStrictEqual([...got].sort(), ['A', 'C']);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].sql, 'SELECT DISTINCT google_id FROM stakes_history WHERE google_id = ANY($1::text[])');
    assert.deepStrictEqual(seen[0].params, [['A', 'B', 'C']]);
    const none = await db.walletsWithStakes([]);
    assert.strictEqual(none.size, 0);
    assert.strictEqual((await db.walletsWithStakes(undefined)).size, 0);
    assert.strictEqual(seen.length, 1, 'no query for no wallets');
    db.pool.query = async () => { throw new Error('db down'); };
    await assert.rejects(() => db.walletsWithStakes(['A']), /db down/, 'a failure reaches the caller, which holds the prize');
  } finally {
    db.pool.query = was;
  }
});

// ---------------------------------------------------------------------------------------------------------------
// brMatch on a real room

test('the prize counts people by network: two free wallets from one address (or one IPv6 /64) are held', () => {
  // two wallets, one address: one person, held (the script's second socket, or a second tab with a new key)
  const a = makeBr();
  seat(a.room, 'Ann', 'WA', '198.51.100.7');
  seat(a.room, 'Alt', 'WK', '198.51.100.7');
  a.room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  a.match.startMatch('test', { countdownMs: 0 });
  assert.strictEqual(a.match.startedWith, 2);
  assert.strictEqual(a.match.startedPeople, 1);
  assert.strictEqual(a.match.soloRun, false);
  assert.strictEqual(a.match.prizeHeld, true);
  assert.strictEqual(a.match.publicState().prize, 0, 'nothing promised');
  assert.deepStrictEqual(a.match.startedSeats(), [{ wallet: 'WA', net: '198.51.100.7' },
    { wallet: 'WK', net: '198.51.100.7' }]);
  // two addresses of one IPv6 /64: one person too
  const v6 = makeBr();
  seat(v6.room, 'Ann', 'WA', '2001:db8:5:6::1');
  seat(v6.room, 'Alt', 'WK', '2001:db8:5:6::2');
  v6.room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  v6.match.startMatch('test', { countdownMs: 0 });
  assert.strictEqual(v6.match.prizeHeld, true);
  // two wallets on two networks: two people, the prize is up (the server still checks they played paid)
  const b = makeBr();
  seat(b.room, 'Ann', 'WA', '198.51.100.7');
  seat(b.room, 'Ben', 'WB', '2001:db8:5:7::1');
  b.room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  b.match.startMatch('test', { countdownMs: 0 });
  assert.strictEqual(b.match.startedPeople, 2);
  assert.strictEqual(b.match.prizeHeld, false);
  assert.strictEqual(b.match.publicState().prize, 20);
  // a seat with no known address shares one bucket: two of them are one person
  const c = makeBr();
  seat(c.room, 'Ann', 'WA', undefined);
  seat(c.room, 'Ben', 'WB', '');
  c.room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  c.match.startMatch('test', { countdownMs: 0 });
  assert.strictEqual(c.match.prizeHeld, true);
  // the snapshot is a copy, and abandoning the match clears it
  const snap = b.match.startedSeats();
  snap[0].wallet = 'EVIL';
  assert.strictEqual(b.match.startedSeats()[0].wallet, 'WA');
  b.match.abandon('owner');
  assert.deepStrictEqual(b.match.startedSeats(), []);
});

test('one network holds at most SEATS_PER_ADDR living snakes; another network, no address, or a freed seat is welcome', () => {
  assert.strictEqual(BRM.SEATS_PER_ADDR, 4);
  const { ft, room, match } = makeBr();
  const mine = [];
  for (let i = 0; i < BRM.SEATS_PER_ADDR; i++) {
    const s = seat(room, 'K' + i, 'K' + i, '198.51.100.7');
    assert.ok(s, 'seat ' + i);
    mine.push(s);
  }
  // the fifth fresh keypair from the same address: refused, out loud
  assert.strictEqual(room.refusal({ wallet: 'K9', ip: '198.51.100.7' }), 'limit');
  assert.strictEqual(seat(room, 'K9', 'K9', '198.51.100.7'), null);
  assert.strictEqual(seat(room, 'K9', 'K9', '::ffff:198.51.100.7'), null, 'the same address written as IPv6');
  // and an unproven fifth socket from it too (the cap is per network, not per wallet)
  assert.strictEqual(seat(room, 'anon', null, '198.51.100.7'), null);
  // another network, and a seat whose address is unknown, sit down
  assert.ok(seat(room, 'Ben', 'WB', '203.0.113.5'));
  assert.ok(seat(room, 'Cat', 'WC', ''));
  assert.strictEqual(room.refusal({ wallet: 'WD' }), null, 'no info address: never refused for it');
  // one of the four dies: their network may seat one again (the cap counts living snakes)
  room.sim.kill(mine[0].snakeId);
  steps(ft, room, 3);
  assert.strictEqual(room.refusal({ wallet: 'K9', ip: '198.51.100.7' }), null);
  assert.ok(seat(room, 'K9', 'K9', '198.51.100.7'));
  assert.strictEqual(room.refusal({ wallet: 'K10', ip: '198.51.100.7' }), 'limit');
  assert.strictEqual(match.state, 'waiting', 'nothing else changed');
  // IPv6: one /64 is one network
  const v6 = makeBr();
  for (let i = 0; i < BRM.SEATS_PER_ADDR; i++) assert.ok(seat(v6.room, 'V' + i, 'V' + i, '2001:db8:9:9::' + (i + 1)));
  assert.strictEqual(v6.room.refusal({ wallet: 'V9', ip: '2001:db8:9:9::99' }), 'limit');
  assert.strictEqual(v6.room.refusal({ wallet: 'V9', ip: '2001:db8:9:a::1' }), null);
  // opts.seatsPerAddr: 1 is strict, 0 turns it off
  const one = makeBr({ seatsPerAddr: 1 });
  assert.ok(seat(one.room, 'A', 'WA', '198.51.100.7'));
  assert.strictEqual(one.room.refusal({ wallet: 'WB', ip: '198.51.100.7' }), 'limit');
  const off = makeBr({ seatsPerAddr: 0 });
  for (let i = 0; i < 8; i++) assert.ok(seat(off.room, 'O' + i, 'O' + i, '198.51.100.7'));
});

test('holdPrize: a decided match reports its prize held (0) for that match only, saved and told at the next step', () => {
  const saved = [];
  const b = makeBr({ lastStore: { load: () => null, save: (x) => saved.push(x) } });
  const ann = seat(b.room, 'Ann', 'WA', '198.51.100.7');
  seat(b.room, 'Ben', 'WB', '203.0.113.5');
  b.room.spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  decideFor(b, ann);
  assert.strictEqual(b.decided.length, 1);
  const id = b.match.matchId;
  assert.strictEqual(b.match.publicState().prize, 20);
  assert.strictEqual(saved[saved.length - 1].prize, 20);
  assert.strictEqual(b.match.holdPrize('br_other'), false, 'another match is never touched');
  assert.strictEqual(b.match.publicState().prize, 20);
  assert.strictEqual(b.match.holdPrize(null), false);
  const sent = ann.socket.emitted.length;
  assert.strictEqual(b.match.holdPrize(id), true);
  assert.strictEqual(b.match.prizeHeld, true);
  const st = b.match.publicState();
  assert.deepStrictEqual([st.prize, st.prizeHeld], [0, true]);
  assert.deepStrictEqual([saved[saved.length - 1].prize, saved[saved.length - 1].prizeHeld], [0, true],
    'the saved podium says held too');
  assert.strictEqual(b.match.holdPrize(id), true, 'again: still held, nothing more');
  steps(b.ft, b.room, 1);
  const br = ann.socket.emitted.slice(sent).filter((e) => e.name === 'sl:x').flatMap((e) => e.data)
    .filter((m) => m.t === 'br');
  assert.ok(br.length && br[br.length - 1].prize === 0 && br[br.length - 1].prizeHeld === true, 'the seat is told');
});

// ---------------------------------------------------------------------------------------------------------------
// slSockets: the address reaches the seat

const { rig, layerMsgs } = require('./slSockFakes');
const { SlBrArena } = require('../server/slBr/slBrArena');

test('setBr: the socket address reaches the seat; a fifth br socket from one address is refused limit', () => {
  const r = rig();
  const rng = createRng(4);
  const br = new SlBrArena(r.laws, { shippableOnly: false, autoTick: false, bots: false, seed: 21, clock: r.ft.clock,
    timers: r.ft.timers, now: () => r.wall.t, prey: false, log: quiet, rand: () => rng.next() });
  r.sockets.setBr({ arenas: br, identify: (p) => (p && p.ok ? p.wallet : null) });
  const join = (wallet, ip) => {
    const s = r.sock({ ip, auth: { br: 1, idProof: { ok: true, wallet } } });
    s.fire('sl:join', { nick: wallet });
    return s;
  };
  for (let i = 0; i < BRM.SEATS_PER_ADDR; i++) assert.ok(br.room().seatOf(join('K' + i, '198.51.100.7').id), 'seat ' + i);
  const fifth = join('K9', '198.51.100.7');
  const last = layerMsgs(fifth).filter((m) => m.t === 'refused');
  assert.deepStrictEqual(last, [{ t: 'refused', why: 'limit' }]);
  assert.strictEqual(fifth.disconnected, true);
  assert.ok(br.room().seatOf(join('WB', '203.0.113.5').id), 'another network sits down');
  br.room().spawnSnake({ nick: 'b1', cv: 2, isBot: true });
  br.match.startMatch('test', { countdownMs: 0 });
  assert.deepStrictEqual(br.match.startedSeats().map((s) => s.net),
    ['198.51.100.7', '198.51.100.7', '198.51.100.7', '198.51.100.7', '203.0.113.5']);
  assert.strictEqual(br.match.startedPeople, 2, 'five wallets, two networks: two people');
});

// ---------------------------------------------------------------------------------------------------------------
// payBattleRoyaleWinner, the real code from server/index.js on stubs

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

// One top-level function of server/index.js by name, brace-matched (its strings and comments here hold balanced braces).
function lift(name) {
  const re = new RegExp('^(async )?function ' + name + '\\(', 'm');
  const m = re.exec(INDEX);
  assert.ok(m, 'server/index.js still has ' + name);
  const at = m.index;
  const open = INDEX.indexOf('{', INDEX.indexOf(')', at));
  let depth = 0;
  for (let j = open; j < INDEX.length; j++) {
    if (INDEX[j] === '{') depth++;
    else if (INDEX[j] === '}' && --depth === 0) return INDEX.slice(at, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}

const PAY_NOW = Date.parse('2026-10-29T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

// opts: dbDown; prizes [[matchId, rec, daysAgo]] already in the journal; lookup (a lookup of its own); cooldown (days)
function payRig(stakedWallets, o) {
  const opts = o || {};
  const pushes = [];
  const sends = [];
  const journal = [];
  const tracked = [];
  const held = [];
  const clock = { t: PAY_NOW };
  // the real journal on a file of its own; every write is also listed here as [matchId, state]
  const real = createBrJournal({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brp-')), 'br-journal.json'),
    log: quiet, now: () => clock.t });
  for (const [id, rec, daysAgo] of opts.prizes || []) {
    clock.t = PAY_NOW - daysAgo * DAY_MS;
    real.setPrize(id, rec);
  }
  clock.t = PAY_NOW;
  class FakeDate extends Date {
    static now() { return clock.t; }
  }
  const ctx = {
    console: quiet,
    Date: FakeDate,
    _brPaid: new Set(),
    BR_PRIZE_USDC: 20,
    BR_PRIZE_COOLDOWN_DAYS: opts.cooldown === undefined ? 7 : opts.cooldown,
    brPrizeRule: require('../server/slBr/brPrizeRule'),
    notify: { pushOwner: (msg, meta) => pushes.push({ msg, title: meta && meta.title }) },
    brJournal: {
      setPrize: (id, rec) => { journal.push([id, rec.state]); return real.setPrize(id, rec); },
      prizes: () => real.prizes(),
      prize: (id) => real.prize(id),
    },
    agInflight: { track: (p) => { tracked.push(p); return p; } },
    money: { withdraw: async (wallet, amount, op) => { sends.push({ wallet, amount, payRent: op && op.payRent }); return 'SIG' + sends.length; } },
    db: {
      walletsWithStakes: opts.lookup || (async (ws) => {
        if (opts.dbDown) throw new Error('db down');
        return new Set(ws.filter((w) => stakedWallets.includes(w)));
      }),
      recordEarnings: async () => {},
    },
  };
  vm.createContext(ctx);
  vm.runInContext([lift('payBattleRoyaleWinner'), lift('startBattleRoyalePrize'), lift('sendBattleRoyalePrize'),
    lift('sweepBrPrizesAtBoot'), 'this.pay = payBattleRoyaleWinner; this.sweep = sweepBrPrizesAtBoot;'].join('\n'), ctx);
  const room = (seats, winner, extra) => Object.assign({
    matchId: 'br_' + winner, winner: { id: 1, name: winner, wallet: winner, bot: false }, soloRun: false,
    prizeHeld: false, startedWith: seats.length, startedPeople: countPeople(seats),
    startedSeats: () => seats.map((s) => Object.assign({}, s)),
    holdPrize: (id) => { held.push(id); return true; },
  }, extra || {});
  const settle = async () => { for (let i = 0; i < 4; i++) await Promise.all(tracked.slice()); };
  return { ctx, pushes, sends, journal, held, room, settle, real, pay: (r) => ctx.pay(r), sweep: () => ctx.sweep() };
}

test('payBattleRoyaleWinner: a match of free wallets is held for Owen and never sent; two paid players are paid once', async () => {
  // the farm: the winner and the helper are keys made offline on two networks (a phone hotspot), never staked
  const farm = payRig([]);
  const seatsF = [{ wallet: 'KEYA', net: '1.1.1.1' }, { wallet: 'KEYB', net: '2.2.2.2' }];
  const rf = farm.room(seatsF, 'KEYA');
  await farm.pay(rf);
  await farm.settle();
  assert.deepStrictEqual(farm.sends, [], 'nothing left the escrow');
  assert.deepStrictEqual(farm.journal, [['br_KEYA', 'checking'], ['br_KEYA', 'held']], 'no paying entry: nothing was sent');
  assert.deepStrictEqual(farm.held, ['br_KEYA'], 'the match now reports its prize held');
  assert.strictEqual(farm.pushes.length, 1);
  assert.strictEqual(farm.pushes[0].title, 'Battle Royale prize held');
  assert.match(farm.pushes[0].msg, /KEYA won br_KEYA: 2 players, 2 proven wallet\(s\), 0 different people who have played paid before \(the winner has not\)/);
  // the backstop timer asks again: still nothing
  await farm.pay(rf);
  await farm.settle();
  assert.deepStrictEqual([farm.sends.length, farm.pushes.length], [0, 1]);
  // the winner played paid but the only other who did is on the winner's network: one person, held
  const one = payRig(['WIN', 'ALT']);
  await one.pay(one.room([{ wallet: 'WIN', net: '1.1.1.1' }, { wallet: 'ALT', net: '1.1.1.1' }, { wallet: 'K', net: '2.2.2.2' }], 'WIN'));
  await one.settle();
  assert.deepStrictEqual([one.sends.length, one.held.length, one.pushes[0].title], [0, 1, 'Battle Royale prize held']);
  // the database is down: held, never paid on a guess
  const down = payRig(['WIN', 'BOB'], { dbDown: true });
  await down.pay(down.room([{ wallet: 'WIN', net: '1.1.1.1' }, { wallet: 'BOB', net: '2.2.2.2' }], 'WIN'));
  await down.settle();
  assert.deepStrictEqual([down.sends.length, down.held.length], [0, 1]);
  assert.match(down.pushes[0].msg, /unknown \(the lookup failed\)/);
  assert.doesNotMatch(down.pushes[0].msg, /the winner has not/, 'unknown is not a no');
  // two people who have played paid, on two networks: paid once, to the winner's proven wallet, journaled first
  const real = payRig(['WIN', 'BOB']);
  const rr = real.room([{ wallet: 'WIN', net: '1.1.1.1' }, { wallet: 'BOB', net: '2.2.2.2' }], 'WIN');
  const first = real.pay(rr);
  const again = real.pay(rr); // the backstop in the same turn
  await Promise.all([first, again]);
  await real.settle();
  assert.deepStrictEqual(real.sends, [{ wallet: 'WIN', amount: 20, payRent: true }]);
  assert.deepStrictEqual(real.journal, [['br_WIN', 'checking'], ['br_WIN', 'paying'], ['br_WIN', 'paid']]);
  assert.deepStrictEqual([real.real.prize('br_WIN').wallet, real.real.prize('br_WIN').net], ['WIN', '1.1.1.1'],
    'the paid entry keeps the winner\'s wallet and network for the cooldown');
  assert.deepStrictEqual(real.held, []);
  assert.deepStrictEqual(real.pushes.map((p) => p.title), ['Battle Royale winner']);
  await real.pay(rr);
  await real.settle();
  assert.strictEqual(real.sends.length, 1, 'never twice');
});

test('payBattleRoyaleWinner: the earlier rules still come first (bot, solo run, held at the start, no wallet)', async () => {
  const r = payRig(['WIN', 'BOB']);
  const seats = [{ wallet: 'WIN', net: '1.1.1.1' }, { wallet: 'BOB', net: '2.2.2.2' }];
  await r.pay(r.room(seats, 'WIN', { matchId: 'm1', winner: { id: 1, name: 'b', wallet: null, bot: true } }));
  await r.pay(r.room(seats, 'WIN', { matchId: 'm2', soloRun: true }));
  await r.pay(r.room(seats, 'WIN', { matchId: 'm3', prizeHeld: true }));
  await r.pay(r.room(seats, 'WIN', { matchId: 'm4', winner: { id: 1, name: 'n', wallet: null, bot: false } }));
  await r.settle();
  assert.deepStrictEqual(r.sends, []);
  assert.deepStrictEqual(r.pushes.map((p) => p.title), ['Battle Royale prize held', 'Battle Royale prize unpaid']);
  // a room with no seat list (the old engine never gets here: its prizeHeld is not a boolean) is held
  const old = payRig(['WIN', 'BOB']);
  const bare = old.room(seats, 'WIN');
  delete bare.startedSeats;
  delete bare.holdPrize;
  await old.pay(bare);
  await old.settle();
  assert.deepStrictEqual([old.sends.length, old.pushes[0].title], [0, 'Battle Royale prize held']);
});

// ---------------------------------------------------------------------------------------------------------------
// second pass (night review 2026-10-29): one automatic prize a week, and the decision journaled before the lookup

test('payBattleRoyaleWinner: one automatic prize a week per wallet and per network; the rest is held, never sent', async () => {
  const seats = [{ wallet: 'WIN', net: '1.1.1.1' }, { wallet: 'BOB', net: '2.2.2.2' }];
  // the farm's second win: the same staked wallet, three days after an automatic prize, from another network
  const again = payRig(['WIN', 'BOB'], { prizes: [['br_old', { state: 'paid', wallet: 'WIN', net: '3.3.3.3', amount: 20 }, 3]] });
  let asked = 0;
  again.ctx.db.walletsWithStakes = async (ws) => { asked++; return new Set(ws); };
  await again.pay(again.room(seats, 'WIN'));
  await again.settle();
  assert.deepStrictEqual(again.sends, [], 'nothing left the escrow');
  assert.strictEqual(asked, 0, 'held before any lookup');
  assert.deepStrictEqual(again.journal, [['br_WIN', 'held']]);
  assert.deepStrictEqual(again.held, ['br_WIN'], 'the match reports its prize held');
  assert.deepStrictEqual(again.pushes.map((p) => p.title), ['Battle Royale prize held']);
  assert.match(again.pushes[0].msg, /WIN won br_WIN, but this wallet already had an automatic prize \(br_old, /);
  // a fresh staked wallet from the network that won three days ago: held too
  const net = payRig(['NEW', 'BOB'], { prizes: [['br_old', { state: 'paid', wallet: 'WIN', net: '1.1.1.1', amount: 20 }, 3]] });
  await net.pay(net.room([{ wallet: 'NEW', net: '1.1.1.1' }, { wallet: 'BOB', net: '2.2.2.2' }], 'NEW'));
  await net.settle();
  assert.deepStrictEqual([net.sends.length, net.held.length], [0, 1]);
  assert.match(net.pushes[0].msg, /a winner on the same network/);
  // a send that may have landed (unknown) counts; a held prize does not; eight days ago is outside the week
  const unk = payRig(['WIN', 'BOB'], { prizes: [['br_u', { state: 'unknown', wallet: 'WIN', amount: 20 }, 1]] });
  await unk.pay(unk.room(seats, 'WIN'));
  await unk.settle();
  assert.strictEqual(unk.sends.length, 0);
  const ok = payRig(['WIN', 'BOB'], { prizes: [
    ['br_h', { state: 'held', wallet: 'WIN', net: '1.1.1.1', amount: 20 }, 1],
    ['br_8', { state: 'paid', wallet: 'WIN', net: '1.1.1.1', amount: 20 }, 8],
    ['br_x', { state: 'paid', wallet: 'OTHER', net: '9.9.9.9', amount: 20 }, 1],
  ] });
  await ok.pay(ok.room(seats, 'WIN'));
  await ok.settle();
  assert.deepStrictEqual(ok.sends, [{ wallet: 'WIN', amount: 20, payRent: true }], 'paid: nothing inside the week');
  // the next match the same day: the wallet just paid is held
  const r2 = ok.room(seats, 'WIN', { matchId: 'br_next' });
  await ok.pay(r2);
  await ok.settle();
  assert.strictEqual(ok.sends.length, 1, 'one a week');
  assert.deepStrictEqual(ok.journal.slice(-1), [['br_next', 'held']]);
  // BR_PRIZE_COOLDOWN_DAYS=0 turns the rule off (the stakes rule still applies)
  const off = payRig(['WIN', 'BOB'], { cooldown: 0, prizes: [['br_old', { state: 'paid', wallet: 'WIN', amount: 20 }, 1]] });
  await off.pay(off.room(seats, 'WIN'));
  await off.settle();
  assert.strictEqual(off.sends.length, 1);
});

test('payBattleRoyaleWinner: checking is journaled before the lookup; a restart in it is held at boot, never sent', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const r = payRig(['WIN', 'BOB'], { lookup: async (ws) => { await gate; return new Set(ws); } });
  const seats = [{ wallet: 'WIN', net: '1.1.1.1' }, { wallet: 'BOB', net: '2.2.2.2' }];
  r.pay(r.room(seats, 'WIN'));
  // the decided match, mid-lookup: the journal already holds it (a hard kill here leaves a trace)
  assert.deepStrictEqual(r.journal, [['br_WIN', 'checking']]);
  const p = r.real.prize('br_WIN');
  assert.deepStrictEqual([p.state, p.wallet, p.name, p.amount, p.net], ['checking', 'WIN', 'WIN', 20, '1.1.1.1']);
  // the next process boots on that journal: Owen is told, it is held, and nothing is sent
  const boot = payRig([], { prizes: [
    ['br_c', { state: 'checking', wallet: 'WIN', name: 'Ann', amount: 20, net: '1.1.1.1' }, 0],
    ['br_p', { state: 'paying', wallet: 'BOB', name: 'Bob', amount: 20 }, 0],
    ['br_d', { state: 'paid', wallet: 'CAT', name: 'Cat', amount: 20, sig: 'S' }, 0],
  ] });
  boot.sweep();
  assert.deepStrictEqual(boot.journal, [['br_c', 'held'], ['br_p', 'unknown']]);
  assert.deepStrictEqual(boot.pushes.map((x) => x.title), ['Battle Royale prize held', 'Battle Royale prize: check it']);
  assert.match(boot.pushes[0].msg, /Ann won br_c; the server restarted while it was deciding .* Nothing was sent to WIN\./);
  assert.deepStrictEqual(boot.sends, []);
  assert.strictEqual(boot.real.prize('br_c').wallet, 'WIN', 'the held entry keeps who won');
  boot.sweep();
  assert.strictEqual(boot.pushes.length, 2, 'once');
  // the first process's lookup finishes: paid once, over its checking entry
  release();
  await r.settle();
  assert.deepStrictEqual(r.journal, [['br_WIN', 'checking'], ['br_WIN', 'paying'], ['br_WIN', 'paid']]);
  assert.strictEqual(r.sends.length, 1);
});
