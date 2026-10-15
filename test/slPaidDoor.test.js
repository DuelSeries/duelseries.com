'use strict';
// The paid sl door (PAID-SL-DESIGN.md 3.2, 11.1 slPaidDoor; task T4), agPaidDoor.test's order contract ported to sl:
// a paid socket (auth.paid 1, the token and the stake in its handshake) through the real slSockets into the real door,
// the real paid directory, SlRoom and slMoney, a REAL entry store (one-time tokens, onlyGame scopes, restore) and a
// spy on every consume.
//   - every refusal decidable without the token comes before the token is touched: entry, bad-stake, slow-down,
//     restarting, full; a socket already seated is silent
//   - a dev token (no stakeSig) seats with no claim; worth and wallet come from the token only
//   - a real token: the journal open, then the claim, then the seat; a refusal after the claim is ONE ledger.refund
//     with 'refund slither <why>' and the token's own claimKey (never the jid), never slPayout.refund; 'error' puts the
//     token back, refunds nothing
//   - one-seat, join-lost, restarting and not-open after the claim, full and seat-failed after the spend: one refund each
//   - a seat that threw with its account still open (the bank refused its own refund) is never refunded by the door:
//     the real hasAccount finds the jid in a live room or a settling one, and the room's owed lane pays it once
//   - an open the journal did not write refunds 'unavailable' once, with no claim and no seat, and alerts once
//   - the journal: open before the claim, closed 'refused' once the refund lane answered; a refund the database did not
//     take yet leaves it open for the boot check and is asked again every DOOR_RECHECK_MS until it lands, then closed;
//     a refund that answers settled after the door's own claim refunded nothing: CRITICAL, alerted, left open
//   - a logger that throws: every spent token is still refunded, and nothing the door tracks rejects
const test = require('node:test');
const assert = require('node:assert/strict');
const { paidRig, jidLike } = require('./slPaidFakes');
const { layerMsgs } = require('./slSockFakes');
const { createSlPaidDoor, paidRung, WHYS } = require('../server/slPaid/slPaidDoor');
const { DOOR_RECHECK_MS } = require('../server/slPaid/slPaidConst');

function refusals(s) {
  return layerMsgs(s).filter((m) => m.t === 'refused');
}

function lastRefusal(s) {
  const l = refusals(s);
  return l.length ? l[l.length - 1] : null;
}

function seated(r, s) {
  return r.paid.roomOf(s.id);
}

test('paidRung: only the paid rungs, never a client\'s number', () => {
  assert.equal(paidRung(0.5), 0.5);
  assert.equal(paidRung('1'), 1);
  for (const v of [0, '0', 0.1, 2, -1, NaN, '0.5x', '', null, undefined, {}, [0.5], { toString: 1 }]) {
    assert.equal(paidRung(v), null, String(v && typeof v === 'object' ? JSON.stringify(v) : v));
  }
});

test('the door needs its deps', () => {
  const r = paidRig();
  const base = { arenas: r.paid, consumeAtStake: () => null, slPayout: r.payout, journal: r.money.journal };
  assert.doesNotThrow(() => createSlPaidDoor(base));
  for (const k of ['arenas', 'consumeAtStake', 'slPayout', 'journal']) {
    assert.throws(() => createSlPaidDoor(Object.assign({}, base, { [k]: null })), /slPaidDoor/);
  }
  // a logger with no error line would throw between a spent token and its refund
  assert.throws(() => createSlPaidDoor(Object.assign({}, base, { log: { log() {} } })), /slPaidDoor: log/);
});

test('order: entry, bad-stake, slow-down, restarting and full are decided before the token is touched', () => {
  const r = paidRig({ rig: { patch: { C_PAID_HUMAN_CAP: 1 } } });
  const good = r.mint({});
  const shapes = [
    [{ entryToken: undefined }, 'entry'], [{ entryToken: 5 }, 'entry'], [{ entryToken: '' }, 'entry'],
    [{ entryToken: 'x'.repeat(65) }, 'entry'], [{ stake: 0 }, 'bad-stake'], [{ stake: 2 }, 'bad-stake'],
    [{ stake: '0.5x' }, 'bad-stake'], [{ stake: { toString: 1 } }, 'bad-stake'],
  ];
  for (const [auth, why] of shapes) {
    const s = r.join(good, { auth });
    assert.equal(lastRefusal(s).why, why, JSON.stringify(auth));
    assert.equal(lastRefusal(s).refunded, 0);
    assert.equal(s.disconnected, true, 'then disconnected');
  }
  // the door's own limiter: a second join on one socket inside DOOR_RATE_MS (slSockets lets one through per socket,
  // so the door is called directly)
  r.paid.stopping = true;
  const s = r.paidSock(good);
  r.door.join(s, { nick: 'a', cv: 1 });
  assert.equal(lastRefusal(s).why, 'restarting');
  r.door.join(s, { nick: 'a', cv: 1 });
  assert.equal(lastRefusal(s).why, 'slow-down');
  r.paid.stopping = false;
  // full: 4 rooms of 1 (C_PAID_HUMAN_CAP patched to 1) hold 4 snakes; the fifth is refused before its token is spent
  for (let i = 0; i < 4; i++) assert.ok(seated(r, r.join(r.mint({}))), 'seat ' + i);
  assert.equal(r.paid.rooms().length, 4);
  const before = r.consumed.length;
  const fifth = r.join(good);
  assert.deepEqual(lastRefusal(fifth), { t: 'refused', why: 'full', refunded: 0 });
  assert.equal(r.consumed.length, before, 'full: nothing consumed');
  assert.deepEqual(r.consumed.filter((c) => c.token === good), [], 'the good token was never offered');
  assert.equal(r.store.consumeAtStake(good, 0.5, 'slither').ok, true, 'and is still spendable');
});

test('a dev token seats with no claim: worth and wallet from the token only, the slither door, the profile row', () => {
  const r = paidRig();
  const token = r.mint({ walletAddress: 'WREAL', worth: 0.5 });
  const s = r.join(token, { auth: { worth: 1000, walletAddress: 'WEVIL', micro: 1e9, wallet: 'WEVIL' } });
  const room = seated(r, s);
  assert.ok(room, 'seated at once (no await)');
  const seat = room.seatOf(s.id);
  const acct = room.money.account(seat.snakeId);
  assert.equal(acct.wallet, 'WREAL');
  assert.equal(acct.deposit, 500000);
  assert.match(acct.jid, jidLike);
  assert.equal(seat.cv, 3, 'the handshake skin');
  assert.deepEqual(r.consumed.map((c) => [c.stake, c.game]), [[0.5, 'slither']]);
  assert.deepEqual(r.ledger.claims, [], 'no stake row, no claim');
  assert.deepEqual(r.entries, [{ wallet: 'WREAL', worth: 0.5, label: 'snake' }]);
  assert.equal(room.money.bank.ledger.in, 500000);
  assert.deepEqual(refusals(s), []);
  // the token is one-time: a second socket with it is refused entry and deposits nothing
  const t = r.join(token);
  assert.deepEqual(lastRefusal(t), { t: 'refused', why: 'entry', refunded: 0 });
  assert.equal(room.money.bank.ledger.in, 500000);
  // the same socket asking the door again is silent (step 2)
  const n = s.emitted.length;
  r.door.join(s, { nick: 'again', cv: 1 });
  assert.equal(s.emitted.length, n);
});

test('a real token: the journal open, then the claim, then the seat', async () => {
  const r = paidRig();
  const token = r.mint({ stakeSig: 'SIG-1', walletAddress: 'WS' });
  const s = r.join(token);
  assert.equal(seated(r, s), null, 'not seated before the claim answers');
  assert.equal(r.money.records.length, 1, 'the door\'s open is written at once');
  assert.deepEqual([r.money.records[0].t, r.money.records[0].wallet, r.money.records[0].micro, r.money.records[0].stakeSig,
    r.money.records[0].room], ['open', 'WS', 500000, 'SIG-1', 'sl_na_s0_5']);
  assert.deepEqual(r.ledger.claims, [], 'the claim comes after the journal open');
  await r.settle();
  assert.deepEqual(r.ledger.claims, ['SIG-1']);
  const room = seated(r, s);
  assert.ok(room, 'seated after the claim');
  const acct = room.money.account(room.seatOf(s.id).snakeId);
  assert.equal(acct.jid, r.money.records[0].jid, 'the account keeps the door\'s jid');
  assert.equal(acct.stakeSig, 'SIG-1');
  assert.ok(r.tracked.length >= 1, 'the claim is tracked for the shutdown');
});

test('a refusal after the claim: ONE ledger.refund with refund slither <why> and the claimKey, never slPayout.refund', async () => {
  const cases = [
    ['not-open', (r) => { r.paid.paidOpen = false; }],
    ['restarting', (r) => { r.paid.stopping = true; }],
    ['join-lost', (r, s) => { s.disconnect(); }],
    ['one-seat', (r) => { r.paid.walletSeat.set('WS', { room: null, snakeId: 99 }); }],
    ['full', (r) => { r.paid.seatFor = () => null; }],
    ['seat-failed', (r) => { const real = r.paid.seatFor.bind(r.paid); r.paid.seatFor = (st, ex) => { const room = real(st, ex); room.seatPaid = () => { throw new Error('boom'); }; return room; }; }],
  ];
  for (const [why, arrange] of cases) {
    const r = paidRig();
    const token = r.mint({ stakeSig: 'SIG-' + why, walletAddress: 'WS' });
    const s = r.join(token);
    arrange(r, s);
    await r.settle();
    assert.equal(r.ledger.refunds.length, 1, why + ': one refund');
    assert.equal(r.ledger.refunds[0].sig, 'SIG-' + why);
    assert.equal(r.ledger.refunds[0].reason, 'refund slither ' + why);
    // the token's own claimKey, exactly: any other key (the journal jid is a uuid too) matches no consumed row, and the
    // database answers settled with nothing refunded
    assert.equal(typeof r.consumed[0].claimKey, 'string');
    assert.equal(r.ledger.refunds[0].claimKey, r.consumed[0].claimKey, why + ': the token\'s own claimKey');
    assert.notEqual(r.ledger.refunds[0].claimKey, r.money.records[0].jid, why + ': never the journal jid');
    assert.deepEqual(r.payout.refunds, [], why + ': never the payout');
    if (why !== 'join-lost') assert.deepEqual(lastRefusal(s), { t: 'refused', why, refunded: 500000 });
    assert.equal(seated(r, s), null);
    const closes = r.money.records.filter((x) => x.t === 'close');
    assert.deepEqual(closes.map((x) => [x.outcome, x.why, x.reason]), [['refused', why, 'refund slither ' + why]],
      why + ': the jid closed refused once');
    assert.equal(closes[0].jid, r.money.records[0].jid);
    for (const room of r.paid.all()) assert.equal(room.money.openCount(), 0);
  }
});

test('a dev token refused after the spend: one slPayout.refund of what landed, its journal closed once', async () => {
  const r = paidRig();
  r.paid.seatFor = () => null;
  const s = r.join(r.mint({ walletAddress: 'WD', paid: 0.5 }));
  await r.settle();
  assert.deepEqual(r.payout.refunds, [{ wallet: 'WD', name: 'p', micro: 500000, paid: 0.5, why: 'full' }]);
  assert.deepEqual(r.ledger.refunds, []);
  assert.deepEqual(lastRefusal(s), { t: 'refused', why: 'full', refunded: 500000 });
  assert.deepEqual(r.money.records.map((x) => [x.t, x.outcome || null]), [['open', null], ['close', 'refused']]);
});

test('the claim answers error: the token is put back, nothing refunded; settled: nothing seated, nothing paid', async () => {
  const r = paidRig();
  r.ledger.answer = 'error';
  const token = r.mint({ stakeSig: 'SIG-E', walletAddress: 'WE' });
  const s = r.join(token);
  await r.settle();
  assert.deepEqual(lastRefusal(s), { t: 'refused', why: 'unavailable', refunded: 0 });
  assert.deepEqual(r.ledger.refunds, []);
  assert.deepEqual(r.payout.refunds, []);
  assert.deepEqual(r.money.records.filter((x) => x.t === 'close').map((x) => x.why), ['unavailable']);
  // the token is back and spends again (a new socket), now seated
  r.ledger.answer = 'ok';
  const t = r.join(token);
  await r.settle();
  assert.ok(seated(r, t), 'the restored token seats');
  // a rejected claim is an error too
  r.ledger.answer = () => Promise.reject(new Error('db down'));
  const tok2 = r.mint({ stakeSig: 'SIG-R', walletAddress: 'WR' });
  const u = r.join(tok2);
  await r.settle();
  assert.equal(lastRefusal(u).why, 'unavailable');
  r.ledger.answer = 'ok';
  const u2 = r.join(tok2);
  await r.settle();
  assert.ok(seated(r, u2), 'a rejected claim put the token back too');
  // settled: the row was refunded already (a sweep won)
  r.ledger.answer = 'settled';
  const v = r.join(r.mint({ stakeSig: 'SIG-S', walletAddress: 'WT' }));
  await r.settle();
  assert.deepEqual(lastRefusal(v), { t: 'refused', why: 'settled', refunded: 500000 });
  assert.equal(seated(r, v), null);
  assert.deepEqual(r.ledger.refunds, [], 'the door pays nothing for a settled row');
});

test('one seat per wallet: a second token of a seated wallet is refunded one-seat once; the first seat is untouched', async () => {
  const r = paidRig();
  const a = r.join(r.mint({ walletAddress: 'WSAME' }));
  const room = seated(r, a);
  const b = r.join(r.mint({ walletAddress: 'WSAME' }));
  await r.settle();
  assert.deepEqual(lastRefusal(b), { t: 'refused', why: 'one-seat', refunded: 500000 });
  assert.deepEqual(r.payout.refunds.map((x) => [x.wallet, x.why, x.micro]), [['WSAME', 'one-seat', 500000]]);
  assert.equal(room.money.openCount(), 1);
  assert.equal(room.money.bank.ledger.in, 500000, 'the second stake never entered a room');
  assert.equal(seated(r, a), room);
  // a durable pair raced through the claim: one seat, one one-seat refund through the stake row
  const r2 = paidRig();
  const x = r2.join(r2.mint({ walletAddress: 'WRACE', stakeSig: 'S-a' }));
  const y = r2.join(r2.mint({ walletAddress: 'WRACE', stakeSig: 'S-b' }));
  await r2.settle();
  assert.equal([x, y].filter((s) => seated(r2, s)).length, 1);
  assert.deepEqual(r2.ledger.refunds.map((q) => [q.sig, q.reason]), [['S-b', 'refund slither one-seat']]);
});

test('a socket gone during the claim is refunded join-lost once, never seated', async () => {
  const r = paidRig();
  const s = r.join(r.mint({ stakeSig: 'SIG-G', walletAddress: 'WG' }));
  s.disconnect();
  await r.settle();
  assert.deepEqual(r.ledger.refunds.map((q) => q.reason), ['refund slither join-lost']);
  assert.equal(seated(r, s), null);
  for (const room of r.paid.all()) assert.equal(room.money.openCount(), 0);
  assert.equal(r.paid.walletSeat.size, 0);
});

test('journal.open not written: refunded unavailable once, no claim, no seat; alerted once per 10 minutes', async () => {
  const r = paidRig();
  r.money.flags.journalOpenFails = 1;
  const s = r.join(r.mint({ stakeSig: 'SIG-J', walletAddress: 'WJ' }));
  await r.settle();
  assert.deepEqual(lastRefusal(s), { t: 'refused', why: 'unavailable', refunded: 500000 });
  assert.deepEqual(r.ledger.claims, [], 'no claim');
  assert.deepEqual(r.ledger.refunds.map((q) => q.reason), ['refund slither unavailable']);
  assert.deepEqual(r.money.records, [], 'no record: nothing to close');
  assert.equal(r.paid.rooms().length, 0, 'no room was even opened');
  assert.deepEqual(r.alerts.map((a) => a.kind), ['journal']);
  // a dev token, and a journal that throws: the same, through the payout; the second alert waits 10 minutes
  r.money.flags.journalOpenThrows = 1;
  const t = r.join(r.mint({ walletAddress: 'WK' }));
  await r.settle();
  assert.equal(lastRefusal(t).why, 'unavailable');
  assert.deepEqual(r.payout.refunds.map((q) => [q.wallet, q.why]), [['WK', 'unavailable']]);
  assert.equal(r.alerts.length, 1, 'once per 10 minutes');
  r.wall.t += 600000;
  r.money.flags.journalOpenFails = 1;
  r.join(r.mint({ walletAddress: 'WL' }));
  await r.settle();
  assert.equal(r.alerts.length, 2);
  assert.equal(r.door.stats.journalFails, 3);
});

test('maintenance and the switch: the token is consumed and refunded once, before any claim or record', async () => {
  for (const why of ['maintenance', 'not-open']) {
    const r = paidRig();
    if (why === 'maintenance') r.ops.maintenance = true;
    else r.paid.setPaidOpen(false);
    const dev = r.join(r.mint({ walletAddress: 'WM' }));
    const real = r.join(r.mint({ walletAddress: 'WN', stakeSig: 'SIG-M' }));
    await r.settle();
    assert.deepEqual(lastRefusal(dev), { t: 'refused', why, refunded: 500000 });
    assert.deepEqual(lastRefusal(real), { t: 'refused', why, refunded: 500000 });
    assert.deepEqual(r.payout.refunds.map((q) => [q.wallet, q.why]), [['WM', why]]);
    assert.deepEqual(r.ledger.refunds.map((q) => [q.sig, q.reason]), [['SIG-M', 'refund slither ' + why]]);
    assert.equal(r.ledger.refunds[0].claimKey, r.consumed[1].claimKey, 'the token\'s own claimKey');
    assert.deepEqual(r.ledger.claims, []);
    assert.deepEqual(r.money.records, []);
    assert.equal(r.consumed.length, 2);
  }
  // a spent or foreign token under maintenance: refused, nothing refunded
  const r = paidRig();
  r.ops.maintenance = true;
  const s = r.join('no-such-token');
  assert.deepEqual(lastRefusal(s), { t: 'refused', why: 'maintenance', refunded: 0 });
  assert.deepEqual(r.payout.refunds, []);
});

test('SL_PAID off (no rungs): a paid token is refunded not-open, never full and never seated', async () => {
  const r = paidRig({ paid: false });
  assert.equal(r.paid.paidOpen, false);
  assert.deepEqual(r.paid.setPaidOpen(true), { ok: false, why: 'not-built', open: false });
  const s = r.join(r.mint({ walletAddress: 'WO' }));
  await r.settle();
  assert.deepEqual(lastRefusal(s), { t: 'refused', why: 'not-open', refunded: 500000 });
  assert.deepEqual(r.payout.refunds.map((q) => q.why), ['not-open']);
  assert.equal(r.room().seats.size, 0, 'never seated in the free room');
  assert.deepEqual(r.paid.boardRows(), []);
});

test('a seat that throws: refunded seat-failed once, unless an account still holds its jid (the room pays that)', async () => {
  const r = paidRig();
  const real = r.paid.seatFor.bind(r.paid);
  let mode = 'throw';
  r.paid.seatFor = (st, ex) => {
    const room = real(st, ex);
    const orig = room.seatPaid.bind(room);
    room.seatPaid = (sock, info, entry) => {
      if (mode === 'throw') throw new Error('injected seat');
      return orig(sock, info, entry);
    };
    return room;
  };
  const s = r.join(r.mint({ walletAddress: 'WF' }));
  await r.settle();
  assert.deepEqual(r.payout.refunds.map((q) => q.why), ['seat-failed']);
  assert.deepEqual(lastRefusal(s), { t: 'refused', why: 'seat-failed', refunded: 500000 });
  // the account stayed open (its own refund refused by the bank): the door refunds nothing
  r.paid.hasAccount = () => true;
  const t = r.join(r.mint({ walletAddress: 'WH' }));
  await r.settle();
  assert.deepEqual(r.payout.refunds.map((q) => q.why), ['seat-failed'], 'still one refund');
  assert.deepEqual(lastRefusal(t), { t: 'refused', why: 'seat-failed', refunded: 0 });
  // a room that refuses (null) is followed by one other room, else full
  mode = 'null';
  r.paid.hasAccount = () => false;
  const tried = [];
  r.paid.seatFor = (st, ex) => {
    const room = real(st, ex);
    tried.push(room ? room.lobbyType : null);
    if (room) room.seatPaid = () => null;
    return room;
  };
  const u = r.join(r.mint({ walletAddress: 'WU' }));
  await r.settle();
  assert.deepEqual(tried, ['sl_na_s0_5', 'sl_na_s0_5#1']);
  assert.equal(lastRefusal(u).why, 'full');
  assert.deepEqual(r.payout.refunds.map((q) => q.why), ['seat-failed', 'full']);
});

test('an abort the bank refused: the real hasAccount finds the jid (live or settling), no door refund, the room pays once', async () => {
  for (const where of ['live', 'settling']) {
    const r = paidRig();
    const real = r.paid.seatFor.bind(r.paid);
    let room = null;
    let restore = null;
    r.paid.seatFor = (st, ex) => {
      room = real(st, ex);
      const bank = room.money.bank;
      const withdraw = bank.withdraw.bind(bank);
      restore = () => { bank.withdraw = withdraw; };
      const roomMsg = room._roomMsg.bind(room);
      room._roomMsg = () => {
        room._roomMsg = roomMsg;
        throw new Error('injected after open');
      };
      // the abort's withdraw is refused once ('live'), or every withdraw until the test lets go ('settling')
      bank.withdraw = (id, kind) => {
        if (where === 'live') restore();
        throw new Error('injected refusal of ' + kind);
      };
      if (where === 'settling') {
        const seatPaid = room.seatPaid.bind(room);
        // the room closes itself before the door looks: its settle cannot pay, so it moves to settling
        room.seatPaid = (...a) => {
          try {
            return seatPaid(...a);
          } catch (e) {
            room.emergencyClose();
            throw e;
          }
        };
      }
      return room;
    };
    const s = r.join(r.mint({ walletAddress: 'WH', stakeSig: 'SIG-H' }));
    await r.settle();
    const jid = r.money.records[0].jid;
    assert.deepEqual(lastRefusal(s), { t: 'refused', why: 'seat-failed', refunded: 0 }, where);
    assert.deepEqual(r.ledger.refunds, [], where + ': no stake row refund');
    assert.deepEqual(r.payout.refunds, [], where + ': no payout refund');
    assert.equal(r.paid.hasAccount(jid), true, where);
    assert.equal(room.money.account(jid).jid, jid, where + ': the account still open holds the door\'s jid');
    if (where === 'settling') {
      assert.deepEqual(r.paid.settling, [room], 'off its rung, on settling');
      assert.equal(r.paid.rooms().includes(room), false);
      restore();
      r.paid.sweep(r.wall.t);
    } else {
      r.step(5);
    }
    // the room's own lane pays it once: never both refunds, never neither
    const key = 'agowed:' + jid;
    const owed = r.money.of('onOwed');
    assert.deepEqual(owed.map((o) => [o.key, o.micro]), [[key, 500000]], where);
    const lane = where === 'live' ? 'orphan' : 'emergency';
    assert.ok(owed[0].reason.startsWith('refund slither ' + lane + ' sl_na_s0_5'), where + ': ' + owed[0].reason);
    assert.deepEqual(r.money.records.filter((x) => x.t === 'close').map((x) => [x.jid, x.outcome, x.why]),
      [[jid, 'refunded', lane]], where + ': one close, the room\'s');
    assert.equal(r.paid.hasAccount(jid), false, where);
    assert.equal(r.paid.walletSeat.size, 0, where);
    assert.deepEqual(r.ledger.refunds, [], where);
  }
});

test('a logger that throws never keeps a spent token from its refund, and the claim chain never rejects', async () => {
  const log = { log() {}, warn() {}, error() { throw new Error('logger down'); } };
  const r = paidRig({ door: { log } });
  // a dev token whose journal open was not written
  r.money.flags.journalOpenFails = 1;
  const s = r.join(r.mint({ walletAddress: 'WK' }));
  await r.settle();
  assert.deepEqual(lastRefusal(s), { t: 'refused', why: 'unavailable', refunded: 500000 });
  assert.deepEqual(r.payout.refunds.map((q) => [q.wallet, q.why]), [['WK', 'unavailable']]);
  // a real token whose seat throws after the claim: one stake row refund, its journal closed
  r.paid.seatFor = () => { throw new Error('injected seatFor'); };
  const t = r.join(r.mint({ walletAddress: 'WT', stakeSig: 'SIG-T' }));
  await r.settle();
  assert.deepEqual(r.ledger.refunds.map((q) => [q.sig, q.reason]), [['SIG-T', 'refund slither seat-failed']]);
  assert.deepEqual(lastRefusal(t), { t: 'refused', why: 'seat-failed', refunded: 500000 });
  assert.deepEqual(r.money.records.filter((x) => x.t === 'close').map((x) => [x.outcome, x.why]),
    [['refused', 'seat-failed']]);
  // a refund lane that throws and one that is not recorded yet log too
  r.ledger.refundAnswer = 'queued';
  r.join(r.mint({ walletAddress: 'WU', stakeSig: 'SIG-U' }));
  await r.settle();
  const out = await Promise.allSettled(r.tracked);
  assert.deepEqual(out.filter((x) => x.status === 'rejected').map((x) => x.reason && x.reason.message), [],
    'nothing the door tracks rejects (an unhandled rejection takes the server down)');
});

test('a refund answering settled after the door\'s own claim refunded nothing: CRITICAL, alerted, left open', async () => {
  const lines = [];
  const log = { log() {}, warn() {}, error: (...a) => lines.push(a.join(' ')) };
  const r = paidRig({ log });
  r.ledger.refundAnswer = 'settled';
  r.paid.seatFor = () => null;
  const s = r.join(r.mint({ walletAddress: 'WZ', stakeSig: 'SIG-Z' }));
  await r.settle();
  assert.deepEqual(r.ledger.claims, ['SIG-Z']);
  assert.deepEqual(lastRefusal(s), { t: 'refused', why: 'full', refunded: 500000 });
  assert.deepEqual(r.money.records.map((x) => x.t), ['open'], 'left open: the boot check flags it with its stakeSig');
  assert.ok(lines.some((l) => /DOOR CRITICAL refund of 500000 micro \(full\) answered settled after this door claimed/.test(l) &&
    /nothing was refunded/.test(l)));
  assert.deepEqual(r.alerts.map((a) => [a.kind, a.lobbyType, a.micro]), [['door-refund', 'sl_na_s0_5', 500000]]);
  r.ft.run(10 * DOOR_RECHECK_MS);
  await r.settle();
  assert.equal(r.ledger.refunds.length, 1, 'never asked again: nothing says it will land');
  // before any claim (the switch off) settled means a sweep refunded the row first: no journal, no alert
  r.paid.setPaidOpen(false);
  r.join(r.mint({ walletAddress: 'WY', stakeSig: 'SIG-Y' }));
  await r.settle();
  assert.equal(r.alerts.length, 1);
});

test('a refund the database did not take yet leaves the journal open, asked again until it lands, then closed once', async () => {
  const lines = [];
  const log = { log() {}, warn() {}, error: (...a) => lines.push(a.join(' ')) };
  const r = paidRig({ log });
  r.ledger.refundAnswer = 'queued';
  r.paid.seatFor = () => null;
  const s = r.join(r.mint({ walletAddress: 'WQ', stakeSig: 'SIG-Q' }));
  await r.settle();
  assert.equal(lastRefusal(s).why, 'full');
  assert.deepEqual(r.money.records.map((x) => x.t), ['open'], 'no close: a crash now is flagged at boot');
  assert.ok(lines.some((l) => /not recorded yet \(queued\)/.test(l) && /left open for the boot check/.test(l)));
  // still not taken at the next ask: still open
  r.ft.run(DOOR_RECHECK_MS - 1);
  await r.settle();
  assert.equal(r.ledger.refunds.length, 1, 'not before DOOR_RECHECK_MS');
  r.ft.run(1);
  await r.settle();
  assert.equal(r.ledger.refunds.length, 2, 'asked again');
  assert.deepEqual(r.money.records.map((x) => x.t), ['open']);
  // the ledger's own retry landed it: the next ask answers settled, and the jid closes refused, once
  r.ledger.refundAnswer = 'settled';
  r.ft.run(DOOR_RECHECK_MS);
  await r.settle();
  const key = r.consumed[0].claimKey;
  assert.deepEqual(r.ledger.refunds.map((q) => [q.sig, q.reason, q.claimKey]),
    [0, 1, 2].map(() => ['SIG-Q', 'refund slither full', key]), 'the same refund each time (one conditional update)');
  assert.deepEqual(r.money.records.map((x) => [x.t, x.outcome || null, x.why || null]),
    [['open', null, null], ['close', 'refused', 'full']]);
  assert.deepEqual(r.alerts, [], 'settled after a queued ask is the refund landing, not the CRITICAL case');
  r.ft.run(10 * DOOR_RECHECK_MS);
  await r.settle();
  assert.equal(r.ledger.refunds.length, 3, 'nothing more is asked');
  // an ask that writes the owed row itself closes it too
  r.ledger.refundAnswer = 'queued';
  r.join(r.mint({ walletAddress: 'WQ2', stakeSig: 'SIG-Q2' }));
  await r.settle();
  r.ledger.refundAnswer = 'owed';
  r.ft.run(DOOR_RECHECK_MS);
  await r.settle();
  assert.deepEqual(r.money.records.map((x) => x.t), ['open', 'close', 'open', 'close']);
  // answered owed at once: closed at once, never asked again
  r.join(r.mint({ walletAddress: 'WQ3', stakeSig: 'SIG-Q3' }));
  await r.settle();
  assert.deepEqual(r.money.records.map((x) => x.t), ['open', 'close', 'open', 'close', 'open', 'close']);
  const n = r.ledger.refunds.length;
  r.ft.run(10 * DOOR_RECHECK_MS);
  await r.settle();
  assert.equal(r.ledger.refunds.length, n);
});

test('every refund reason starts refund slither; every journal record of the door is an sl_ room', async () => {
  const r = paidRig();
  r.paid.setPaidOpen(false);
  for (let i = 0; i < 3; i++) r.join(r.mint({ walletAddress: 'WA' + i, stakeSig: 'SIG-A' + i }));
  r.paid.setPaidOpen(true);
  const s = r.join(r.mint({ walletAddress: 'WB', stakeSig: 'SIG-B' }));
  s.disconnect();
  await r.settle();
  assert.equal(r.ledger.refunds.length, 4);
  for (const q of r.ledger.refunds) assert.match(q.reason, /^refund slither /);
  for (const x of r.money.records) assert.match(x.room, /^sl_/);
  for (const why of Object.keys(r.door.stats.refused)) assert.ok(WHYS.includes(why), why + ' is a known why');
});
