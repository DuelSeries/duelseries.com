'use strict';
// agScreens (build brief 9.1 "agScreens.js", client-hud section 6, fact 2.7): per-life stats, the menu card, and the
// adapter onto the shared end card and leaderboard (public/js/shared/dsEnd.js; Owen 2026-10-16: one card and one
// board for every game, replacing agar.io's "Match Results" panel, its canvas board and the old paid card). The
// adapter tests run the REAL component in a fake DOM and read back what it shows (test/agEndProbe.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const S = require(path.join(__dirname, '..', 'public', 'js', 'ag', 'agScreens.js'));
const { makeDoc } = require('./agFakePage.js');
const { installDSEnd, readCard, clickCard, readBoard } = require('./agEndProbe.js');

// A fake window with the real component; w: its width (the component's phone rule is max-width 760).
function page(w) {
  const doc = makeDoc();
  const win = { document: doc, innerWidth: w || 1366, innerHeight: 800 };
  const D = installDSEnd(win);
  return { doc, win, D };
}
const card = (p) => { const c = readCard(p.doc); if (c) delete c.el; return c; };

test('score mass per cell: floor(f32(f32(s*s)/100)) on the packet size', () => {
  assert.strictEqual(S.cellScoreMass(31), 9);
  assert.strictEqual(S.cellScoreMass(32), 10);
  assert.strictEqual(S.cellScoreMass(60), 36);
  assert.strictEqual(S.cellScoreMass(141), 198);
  assert.strictEqual(S.cellScoreMass(45), 20);
  assert.strictEqual(S.cellScoreMass(51), 26);
  assert.strictEqual(S.cellScoreMass(42), 17);
  assert.strictEqual(S.cellScoreMass(64), 40);
});

test('frame bookkeeping: highest mass, leaderboard time only while onBoard', () => {
  const st = S.createLifeStats();
  st.spawn(1000);
  assert.strictEqual(st.frame({ spectating: false, ownSizes: [], dt: 16 }), -1);
  assert.strictEqual(st.frame({ spectating: true, ownSizes: [50], dt: 16 }), -1);
  assert.strictEqual(st.frame({ spectating: false, ownSizes: [51, 42], dt: 16 }), 43);
  assert.strictEqual(st.leaderTime, 0);
  st.applyBoard([{ name: 'a' }]);
  assert.strictEqual(st.onBoard, true);
  assert.strictEqual(st.frame({ spectating: false, ownSizes: [60], dt: 16.5 }), 36);
  assert.strictEqual(st.leaderTime, 16.5);
  assert.strictEqual(st.highestMass, 43);
  assert.deepStrictEqual(st.now(1500), { timeAlive: 500, highestMass: 43, topPosition: 0 }, 'this life so far');
});

test('board place: position is the list index of the own row; onBoard is 1 off the list (trap T5)', () => {
  assert.deepStrictEqual(S.boardPlace([]), { position: 0, onBoard: true });
  assert.deepStrictEqual(S.boardPlace([{ name: 'a' }, { me: true }]), { position: 2, onBoard: true });
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ name: 'p' + i });
  rows[11] = { me: true };
  assert.deepStrictEqual(S.boardPlace(rows), { position: 12, onBoard: false });
  const st = S.createLifeStats();
  st.applyBoard([{ name: 'a' }, { name: 'b' }, { me: true }]);
  st.applyBoard([{ me: true }]);
  st.applyBoard([{ name: 'a' }, { me: true }]);
  assert.strictEqual(st.topPosition, 1);
});

test('eat stats follow fact 2.7 (food, 0x20 with 0x40, virus, cells)', () => {
  const st = S.createLifeStats();
  const base = { eaterOwn: true, eatenOwn: false, food: false, ejected: false, flag40: false, virus: false };
  const e = (o) => st.eat(Object.assign({}, base, o));
  assert.strictEqual(e({ food: true }), 'food');
  assert.strictEqual(e({ ejected: true, flag40: true }), 'food');
  assert.strictEqual(e({ ejected: true, flag40: false }), null);
  assert.strictEqual(e({ ejected: true, flag40: false, virus: true }), 'virus');
  assert.strictEqual(e({ virus: true }), 'virus');
  assert.strictEqual(e({}), 'cell');
  assert.strictEqual(e({ eatenOwn: true }), null);
  assert.strictEqual(e({ eaterOwn: false }), null);
  assert.deepStrictEqual([st.foodEaten, st.virusesEaten, st.cellsEaten], [2, 2, 1]);
});

test('death: snapshot then a full reset', () => {
  const st = S.createLifeStats();
  st.spawn(500);
  st.applyBoard([{ me: true }]);
  st.frame({ spectating: false, ownSizes: [45], dt: 10 });
  st.eat({ eaterOwn: true, food: true });
  const snap = st.death(12366.69, [{ me: true }]);
  assert.strictEqual(snap.timeAlive, 12366.69 - 500);
  assert.deepStrictEqual([snap.foodEaten, snap.highestMass, snap.leaderTime, snap.topPosition], [1, 20, 10, 1]);
  assert.deepStrictEqual([st.foodEaten, st.highestMass, st.leaderTime, st.topPosition, st.onBoard, st.alive],
    [0, 0, 0, 0, false, false]);
});

test('stats fed the full stream\'s own sizes reach the highest mass 43', () => {
  const RUNS = [[20, 55], [22, 41], [23, 2], [24, 41], [26, 36], [40, 41], [39, 2], [38, 17], [36, 29], [43, 2],
    [34, 298], [26, 2], [34, 146]];
  const st = S.createLifeStats();
  // sizes that give the run masses: 45->20, 47->22, 48->23, 49->24, 51->26, 64->40, 63->39, 62->38, 60->36, 51+42->43, 59->34
  const sizesFor = { 20: [45], 22: [47], 23: [48], 24: [49], 26: [51], 40: [64], 39: [63], 38: [62], 36: [60], 43: [51, 42], 34: [59] };
  for (const [v, n] of RUNS) for (let i = 0; i < n; i++) assert.strictEqual(st.frame({ ownSizes: sizesFor[v], dt: 16.6667 }), v);
  assert.strictEqual(st.highestMass, 43);
});

test('no Math.random, no Date, no reference line citations in agScreens', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'js', 'ag', 'agScreens.js'), 'utf8');
  assert.ok(!/Math\.random|Date\.now|new Date/.test(src));
  assert.ok(!/\bD \d{4,}|\bW \d{5,}|dcmp|\.wat\b/.test(src));
});

// Review fix: the whole-client reset on every connect and disconnect zeroes this life's numbers, so the next life
// never starts from the old highest mass, leaderboard time or top position.
test('reset zeroes every per-life number without a death', () => {
  const st = S.createLifeStats();
  st.spawn(500);
  st.applyBoard([{ me: true }]);
  for (let i = 0; i < 10; i++) st.frame({ spectating: false, ownSizes: [200], dt: 16 });
  st.eat({ eaterOwn: true, food: true });
  st.eat({ eaterOwn: true, virus: true });
  st.eat({ eaterOwn: true });
  assert.strictEqual(st.highestMass, 400);
  st.reset();
  assert.deepStrictEqual([st.spawnTime, st.foodEaten, st.highestMass, st.leaderTime, st.cellsEaten, st.virusesEaten,
    st.topPosition, st.onBoard, st.alive], [0, 0, 0, 0, 0, 0, 0, false, false]);
});

// ---- the menu card ------------------------------------------------------------------------------------------------

test('menu card: layout facts, menu scale, and none of the old Match Results panel', () => {
  assert.strictEqual(S.LAYOUT.nickMax, 15);
  assert.deepStrictEqual([S.LAYOUT.card.width, S.LAYOUT.card.height], [325, 302]);
  assert.strictEqual(S.menuScale(1920, 1080), 1);
  assert.strictEqual(S.menuScale(800, 800), 0.5);
  // Owen 2026-10-16: the parity copy of the panel is replaced by the shared card, all of it.
  for (const gone of [/#ag-stats/, /#statsGraph/, /#statsContinue/, /statsAgain/, /\.ag-btn-primary/]) assert.doesNotMatch(S.SCREENS_CSS, gone);
  for (const k of ['STATS_TITLE', 'CASHED_OUT_TITLE', 'STAT_BOXES', 'statsValues', 'graphPoints', 'drawMassGraph', 'createPaidEnd', 'loadPaidStyles', 'LOBBY_CSS']) {
    assert.strictEqual(S[k], undefined, k + ' is gone');
  }
  const doc = makeDoc();
  const s = S.createScreens({ doc, root: doc.body });
  const ids = (el, out = []) => { if (el.id) out.push(el.id); el.children.forEach((c) => ids(c, out)); return out; };
  assert.deepStrictEqual(ids(doc.body), ['ag-menu', 'ag-card', 'ag-name', 'ag-nick', 'ag-play', 'ag-spectate']);
  s.showHome();
  assert.strictEqual(s.menu.hidden, false);
  s.hide();
  assert.strictEqual(s.menu.hidden, true);
});

// Review fix (legal line, build brief 4): the name entry is ours. None of the reference menu's own values may come
// back in our stylesheet; the menu card's own facts (client-hud 6.3) stay.
test('the name entry carries none of the reference menu look; the card facts stay', () => {
  const css = S.SCREENS_CSS;
  for (const banned of [/#54c800/i, /#a2a2a2/i, /width:243px/, /width:180px/, /line-height:1\.5;/, /#777\b/]) {
    assert.doesNotMatch(css, banned);
  }
  const rule = (sel) => (css.split('\n').find((l) => l.startsWith(sel + '{')) || '');
  assert.match(rule('#ag-play'), /background:#f0a830/);
  assert.match(rule('#ag-nick'), /font-size:16px/);   // 16 px: phones do not zoom into the field
  assert.match(rule('#ag-card'), /background-color:#fff;border-radius:10px;margin:5px 0;width:325px;height:302px;/);
});

test('the drawing values are the reference defaults, hard-wired: no settings block, no Sound button', () => {
  assert.deepStrictEqual(S.SETTINGS_DEFAULTS, { names: true, colors: true, showMass: false, dark: false, quality: 'Retina' });
  // Owen 2026-10-15: "just get rid of all the settings". Nothing on the card offers to change them.
  assert.strictEqual(S.SETTING_BOXES, undefined);
  assert.strictEqual(S.QUALITY_OPTIONS, undefined);
  assert.doesNotMatch(S.SCREENS_CSS, /#ag-settings|#ag-sound/);
});

test('menu box: the reference 985 x 600 box on mouse screens, scaled from the window above the strip', () => {
  const lines = S.SCREENS_CSS.split('\n');
  const rule = lines.find((r) => r.indexOf('@media not all and (pointer: coarse)') === 0);
  assert.strictEqual(rule, '@media not all and (pointer: coarse){#ag-menu{width:985px;height:600px;box-sizing:border-box;padding:0 330px;}}');
  assert.strictEqual(lines.indexOf(rule), lines.indexOf('#ag-menu[hidden]{display:none;}') + 1);
  // menuScale on the window above the strip: 1266 x (626 - 90) gives 0.67, 801 x (601 - 90) 0.500625, 1920 x 990 1.
  assert.strictEqual(S.menuScale(1266, 626 - 90), 0.67);
  assert.strictEqual(S.menuScale(801, 601 - 90), 0.500625);
  assert.strictEqual(S.menuScale(1920, 1080 - 90), 1);
  assert.strictEqual(S.menuScale(1707, 932 - 90), 1);
});

// ---- the end card (createEnd) ---------------------------------------------------------------------------------------

const LIFE = { timeAlive: 222000, highestMass: 1284.9, topPosition: 4 };

test('end card, free: "Eaten by NAME" (or "Eaten"), the best mass as the hero, Time and Top rank, the page\'s buttons', () => {
  const p = page();
  const calls = [];
  const end = S.createEnd({ DSEnd: p.D, z: 1000 });
  const buttons = [{ id: 'again', text: 'Play again', primary: true, onClick: () => calls.push('again') },
    { id: 'watch', text: 'Spectate', onClick: () => calls.push('watch') }, { id: 'lobby', text: 'Lobby', onClick: () => calls.push('lobby') }];
  end.showFree({ life: LIFE, by: 'Kestrel', buttons });
  assert.deepStrictEqual(card(p), { tone: 'plain', verdict: 'Eaten by Kestrel', hero: 'Free', unit: '',   // a free game says Free; its score is the first tray row (Owen 2026-10-16)
    facts: [['Mass', '1,284'], ['Time', '3:42'], ['Top rank', '4th']], ledger: [], status: null, notes: [],
    buttons: [{ id: 'lobby', text: 'Lobby', primary: false, disabled: false }, { id: 'watch', text: 'Spectate', primary: false, disabled: false },
      { id: 'again', text: 'Play again', primary: true, disabled: false }], share: true, z: '1000' });   // Lobby left, the next step right (Owen 2026-10-16)
  assert.strictEqual(end.kind, 'free');
  assert.strictEqual(end.paidKind(), '', 'not a paid state');
  for (const id of ['again', 'watch', 'lobby']) clickCard(p.doc, id);
  assert.deepStrictEqual(calls, ['again', 'watch', 'lobby']);
  // No known eater, never on the board (the old ':(' box): "Eaten", and the rank is left out.
  end.showFree({ life: { timeAlive: 59999, highestMass: 10, topPosition: 0 }, by: '', buttons });
  const c = card(p);
  assert.deepStrictEqual([c.verdict, c.hero, c.facts], ['Eaten', 'Free', [['Mass', '10'], ['Time', '0:59']]]);   // a free game says Free; its score is the first tray row (Owen 2026-10-16)
  // A free cash-out: the same card, "Cashed out".
  end.showFree({ life: LIFE, cashed: true, by: 'Kestrel', buttons });
  assert.deepStrictEqual([card(p).verdict, card(p).hero], ['Cashed out', 'Free']);   // a free game says Free (Owen 2026-10-16)
  end.hide();
  assert.strictEqual(readCard(p.doc), null);
  assert.strictEqual(end.shown(), false);
});

test('end card, names are text: a name with markup is shown as typed, never parsed', () => {
  const p = page();
  const end = S.createEnd({ DSEnd: p.D });
  end.showFree({ life: LIFE, by: '<img src=x onerror=alert(1)>', buttons: [] });
  assert.strictEqual(card(p).verdict, 'Eaten by <img src=x onerror=alert(1)>');
  end.showDead({ lostMicro: 100000, by: '<b>bob</b>' }, LIFE);
  assert.strictEqual(card(p).verdict, 'Eaten by <b>bob</b>');
});

test('end card, paid cash-out: the server\'s net as the hero, the ledger, the payout line from pending to sent or delayed', () => {
  const p = page();
  const end = S.createEnd({ DSEnd: p.D });
  end.showCashed({ grossMicro: 2400000, cutMicro: 240000, netMicro: 2160000 }, { timeAlive: 365000, highestMass: 2210, topPosition: 3 });
  let c = card(p);
  assert.deepStrictEqual([c.tone, c.verdict, c.hero, c.unit], ['win', 'Cashed out', '$2.16', '']);   // money won stands alone (Owen: no "to your wallet")
  assert.deepStrictEqual(c.ledger, [['Cashed out', '$2.40'], ['House 10%', '−$0.24'], ['You receive', '$2.16', 'net']]);
  assert.deepStrictEqual(c.facts, [['Time', '6:05'], ['Top rank', '3rd'], ['Mass', '2,210']]);
  assert.deepStrictEqual(c.status, { text: 'Sending to your wallet', state: 'pending' });
  assert.deepStrictEqual(c.buttons, [{ id: 'lobby', text: 'Lobby', primary: true, disabled: false }], 'Lobby alone is the main button');
  assert.strictEqual(end.paidKind(), 'cashed');
  // ag:paid: the explorer link, mainnet and another cluster
  assert.strictEqual(end.paid('5Abc'), true);
  assert.deepStrictEqual(card(p).status, { text: 'Sent to your wallet.', state: 'ok',
    link: { href: 'https://solscan.io/tx/5Abc', text: 'View transaction', target: '_blank', rel: 'noopener noreferrer' } });
  end.paid('5Abc', 'devnet');
  assert.strictEqual(card(p).status.link.href, 'https://solscan.io/tx/5Abc?cluster=devnet');
  assert.strictEqual(end.paid(''), false, 'no signature, no change');
  // ag:payerror: the server's line, or the game's own
  end.payError('');
  assert.deepStrictEqual(card(p).status, { text: 'Payout delayed. Your winnings are recorded and will be sent.', state: 'err' });
  end.payError('Held for a moment.');
  assert.strictEqual(card(p).status.text, 'Held for a moment.');
  // the numbers on screen are the payload's own: no netMicro gives gross - cut, nothing from a stake
  end.showCashed({ grossMicro: 1400000, cutMicro: 140000 }, null);
  c = card(p);
  assert.deepStrictEqual([c.hero, c.ledger[2][1], c.facts], ['$1.26', '$1.26', []], 'no life seen: no facts');
  // a resumed, automatic receipt: no payout message will come, so the line says it is recorded
  end.showCashed({ grossMicro: 300000, cutMicro: 30000, netMicro: 270000, resumed: true, auto: true });
  c = card(p);
  assert.deepStrictEqual([c.verdict, c.hero, c.status.text], ['Cashed out automatically', '$0.27', 'Your payout is recorded and goes to your wallet.']);
});

test('end card, paid death: the loss in red, "Eaten by NAME", Time, Top rank and Mass; the life\'s final numbers update it', () => {
  const p = page();
  const end = S.createEnd({ DSEnd: p.D });
  end.showDead({ lostMicro: 1000000, by: 'Kestrel' }, { timeAlive: 130000, highestMass: 860, topPosition: 6 });
  let c = card(p);
  assert.deepStrictEqual([c.tone, c.verdict, c.hero, c.unit], ['loss', 'Eaten by Kestrel', '−$1.00', '']);   // money lost stands alone (Owen 2026-10-16)
  assert.deepStrictEqual(c.facts, [['Time', '2:10'], ['Top rank', '6th'], ['Mass', '860']]);
  assert.deepStrictEqual([c.ledger, c.status], [[], null]);
  assert.strictEqual(c.share, false, 'a paid card never offers Share (free play only, 2026-10-26)');
  end.setLife({ timeAlive: 131000, highestMass: 900, topPosition: 5 });
  assert.deepStrictEqual(card(p).facts, [['Time', '2:11'], ['Top rank', '5th'], ['Mass', '900']]);
  end.showDead({ lostMicro: 100000, by: '' });
  c = card(p);
  assert.deepStrictEqual([c.verdict, c.hero, c.facts], ['Eaten', '−$0.10', []]);
  // a closed card never takes a life
  end.showClosed({ refundedMicro: 0, why: 'emergency' });
  end.setLife(LIFE);
  assert.deepStrictEqual(card(p).facts, []);
});

test('end card, ag:closed is worded by its why; the frozen backstop and a zero amount are never called a refund', () => {
  const p = page();
  const T = S.END_TEXT;
  const end = S.createEnd({ DSEnd: p.D });
  const say = (msg) => { end.showClosed(msg); const c = card(p); return [end.kind, c.verdict, c.hero, c.notes]; };
  assert.deepStrictEqual(say({ refundedMicro: 1000000, why: 'shutdown' }), ['closed', 'Refunded', '$1.00', [T.restart]]);
  assert.deepStrictEqual(say({ refundedMicro: 500000, why: 'crash' }), ['closed', 'Refunded', '$0.50', [T.restart]]);
  assert.deepStrictEqual(say({ refundedMicro: 250000, why: 'emergency' }), ['closed', 'Refunded', '$0.25', [T.closed]]);
  // agMoney.houseSettle: the balance went to the house (agar_breach) for a refund by hand, agRoom sends 0
  const held = say({ refundedMicro: 0, why: 'frozen-settled' });
  assert.deepStrictEqual(held, ['held', 'On hold', '', [T.held]]);
  assert.ok(!/refund/i.test(held[1] + held[3].join(' ')));
  // the emergency loop for a seat with no settled account, or nothing left: no $0.00 "refund"
  const empty = say({ refundedMicro: 0, why: 'emergency' });
  assert.deepStrictEqual(empty, ['closed', 'Room closed', '', [T.closedEmpty]]);
  assert.ok(!empty[3][0].includes('$0.00'));
  assert.deepStrictEqual(card(p).buttons.map((b) => b.id), ['lobby']);
});

test('end card, the paid hand-off\'s states: a message with its lines, the wait with or without Lobby, Play again and the lock', () => {
  const p = page();
  const calls = [];
  const end = S.createEnd({ DSEnd: p.D, onLobby: () => calls.push('lobby') });
  end.onAgain = () => calls.push('again');
  end.showMessage('refused', 'Tables full', 'Every agar.io table at this stake is full.', 'Your entry was refunded to your wallet.');
  let c = card(p);
  assert.deepStrictEqual([end.kind, c.verdict, c.notes, c.buttons.map((b) => b.id)],
    ['refused', 'Tables full', ['Every agar.io table at this stake is full.', 'Your entry was refunded to your wallet.'], ['lobby']]);
  end.showMessage('gone', 'Seat moved', 'This seat was taken over by a newer connection.');
  assert.deepStrictEqual([end.kind, card(p).notes], ['gone', ['This seat was taken over by a newer connection.']]);
  // the wait: no Lobby while a join may hold money, Lobby once the flow gives the way back
  end.showWait('Joining the $0.50 room', 'Getting your seat ready');
  c = card(p);
  assert.deepStrictEqual([end.kind, c.verdict, c.status, c.buttons], ['wait', 'Joining the $0.50 room',
    { text: 'Getting your seat ready', state: 'pending' }, []]);
  end.showWait('Reconnecting', 'Your cells stay where they are.', { lobby: true });
  assert.deepStrictEqual(card(p).buttons.map((b) => b.id), ['lobby']);
  // Play again (after a death in the lobby frame): the main button, Lobby the quiet one beside it
  end.showDead({ lostMicro: 500000, by: 'Kestrel' }, LIFE);
  end.setAgain({ text: 'Play again $0.50' });
  assert.deepStrictEqual(card(p).buttons, [{ id: 'lobby', text: 'Lobby', primary: false, disabled: false },
    { id: 'again', text: 'Play again $0.50', primary: true, disabled: false }]);   // Lobby left, the next step right (Owen 2026-10-16)
  clickCard(p.doc, 'again');
  // the wallet is out: Play again disabled, Lobby locked, an error line when it fails
  end.setAgain({ text: 'Confirm in your wallet...', disabled: true });
  end.setLobbyLocked(true);
  end.setError('');
  c = card(p);
  assert.deepStrictEqual(c.buttons.map((b) => [b.id, b.text, b.disabled]), [['lobby', 'Lobby', true], ['again', 'Confirm in your wallet...', true]]);   // Lobby left, the next step right (Owen 2026-10-16)
  clickCard(p.doc, 'again');
  clickCard(p.doc, 'lobby');
  assert.deepStrictEqual(calls, ['again'], 'disabled buttons do nothing');
  end.setLobbyLocked(false);
  end.setAgain({ text: 'Play again $0.50' });
  end.setError('Stake failed');
  c = card(p);
  assert.deepStrictEqual([c.notes, c.facts.length, c.hero], [['Stake failed'], 3, '−$0.50'], 'the death stays under the error line');
  clickCard(p.doc, 'lobby');
  assert.deepStrictEqual(calls, ['again', 'lobby']);
  // every new state starts without Play again, the lock or the error
  end.showClosed({ refundedMicro: 100000, why: 'emergency' });
  assert.deepStrictEqual(card(p).buttons, [{ id: 'lobby', text: 'Lobby', primary: true, disabled: false }]);
  assert.deepStrictEqual(card(p).notes, [S.END_TEXT.closed]);
  end.setAgain(null);
  assert.deepStrictEqual(card(p).buttons.map((b) => b.id), ['lobby']);
});

test('end card, every death and cash-out: Lobby, Spectate, Play again in that order; Spectate shut with Lobby; notices keep Lobby alone', () => {
  const p = page();
  const calls = [];
  const end = S.createEnd({ DSEnd: p.D, onLobby: () => calls.push('lobby'), onSpectate: () => calls.push('watch') });
  end.onAgain = () => calls.push('again');
  const row = () => card(p).buttons.map((b) => [b.id, b.text, b.primary, b.disabled]);
  // a paid death: Lobby and Spectate at once, Play again once the paid flow offers it (on the right)
  end.showDead({ lostMicro: 500000, by: 'Kestrel' }, LIFE);
  assert.deepStrictEqual(row(), [['lobby', 'Lobby', true, false], ['watch', 'Spectate', false, false]]);
  end.setAgain({ text: 'Play again $0.50' });
  assert.deepStrictEqual(row(), [['lobby', 'Lobby', false, false], ['watch', 'Spectate', false, false], ['again', 'Play again $0.50', true, false]]);
  clickCard(p.doc, 'watch');
  assert.deepStrictEqual(calls, ['watch'], 'Spectate calls the page watch path');
  // the wallet is out: Lobby shut, so Spectate is shut too and does nothing
  end.setAgain({ text: 'Confirm in your wallet...', disabled: true });
  end.setLobbyLocked(true);
  assert.deepStrictEqual(row(), [['lobby', 'Lobby', false, true], ['watch', 'Spectate', false, true], ['again', 'Confirm in your wallet...', true, true]]);
  clickCard(p.doc, 'watch');
  clickCard(p.doc, 'lobby');
  assert.deepStrictEqual(calls, ['watch']);
  end.setLobbyLocked(false);
  assert.deepStrictEqual(row().map((b) => b[3]), [false, false, true], 'open again with Lobby');
  // a paid cash-out: the same three, the payout line pending (Lobby is open then, so Spectate is too)
  end.showCashed({ grossMicro: 2400000, cutMicro: 240000, netMicro: 2160000 }, LIFE);
  end.setAgain({ text: 'Play again $0.50' });
  assert.deepStrictEqual(row().map((b) => [b[0], b[1], b[3]]), [['lobby', 'Lobby', false], ['watch', 'Spectate', false], ['again', 'Play again $0.50', false]]);
  assert.strictEqual(card(p).status.state, 'pending');
  // notices and the wait keep their own buttons
  end.showClosed({ refundedMicro: 100000, why: 'emergency' });
  assert.deepStrictEqual(card(p).buttons.map((b) => b.id), ['lobby']);
  end.showClosed({ refundedMicro: 0, why: 'frozen-settled' });
  assert.deepStrictEqual(card(p).buttons.map((b) => b.id), ['lobby']);
  end.showMessage('refused', 'Tables full', 'Every agar.io table at this stake is full.');
  assert.deepStrictEqual(card(p).buttons.map((b) => b.id), ['lobby']);
  end.showMessage('gone', 'Seat moved', 'This seat was taken over by a newer connection.');
  assert.deepStrictEqual(card(p).buttons.map((b) => b.id), ['lobby']);
  end.showWait('Reconnecting', 'Reconnecting to your room');
  assert.deepStrictEqual(card(p).buttons, []);
  end.showWait('Reconnecting', 'Your cells stay where they are.', { lobby: true });
  assert.deepStrictEqual(card(p).buttons.map((b) => b.id), ['lobby']);
  // the free card: the page's three, Lobby left and Play again right whatever order they come in
  end.showFree({ life: LIFE, by: 'Kestrel', buttons: [{ id: 'again', text: 'Play again', primary: true }, { id: 'lobby', text: 'Lobby' },
    { id: 'watch', text: 'Spectate' }] });
  assert.deepStrictEqual(card(p).buttons.map((b) => b.text), ['Lobby', 'Spectate', 'Play again']);
});

test('end card without the component (the parity harness): every state is a quiet no-op', () => {
  const end = S.createEnd({});
  end.showFree({ life: LIFE });
  end.showCashed({ grossMicro: 1 });
  end.showDead({ lostMicro: 1 });
  end.showClosed({});
  end.showMessage('refused', 'x');
  end.showWait('x');
  end.setAgain({ text: 'x' });
  assert.deepStrictEqual([end.shown(), end.paidKind(), end.paid('sig'), end.button('again')], [false, '', false, null]);
  const b = S.createBoard({});
  b.setFree([{ name: 'a' }], 'me');
  b.setMoney({ me: 1, rank: 1, board: [['a', 1]] });
  b.sync(true);
  assert.deepStrictEqual([b.visible, b.element()], [false, null]);
});

// ---- the leaderboard (createBoard) ----------------------------------------------------------------------------------

function freeRows(n, meAt) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ name: 'p' + (i + 1) });
  if (meAt >= 0) rows[meAt] = { me: true };
  return rows;
}
const rowsOf = (p) => readBoard(p.doc).rows;

test('board, free: the room list in rank order, no figures, the own row under the local name, pinned when outside', () => {
  const p = page(1366);
  const b = S.createBoard({ DSEnd: p.D, z: 35 });
  assert.strictEqual(readBoard(p.doc), null, 'nothing until the first rows');
  b.setFree(freeRows(14, 2), 'Owen');
  let r = readBoard(p.doc);
  assert.deepStrictEqual([r.shown, r.money, r.title, r.z], [false, false, 'Leaderboard', '35'], 'hidden until the page says it plays');
  b.sync(true);
  r = readBoard(p.doc);
  assert.strictEqual(r.shown, true);
  assert.strictEqual(r.rows.length, 10, 'PC: 10 rows');
  assert.deepStrictEqual(r.rows.slice(0, 4), [['1', 'p1', '', false], ['2', 'p2', '', false], ['3', 'Owen', '', true], ['4', 'p4', '', false]]);
  // 14th of 14: pinned under the top 10
  b.setFree(freeRows(14, 13), 'Owen');
  r = rowsOf(p);
  assert.deepStrictEqual(r.slice(-3), [['10', 'p10', '', false], 'gap', ['14', 'Owen', '', true]]);
  // a nameless cell gets the reference's placeholder; a server rank on a row is used as is
  b.setFree([{ name: '' }, { me: true, rank: 37 }], '');
  assert.deepStrictEqual(rowsOf(p), [['1', 'An unnamed cell', '', false], ['37', 'An unnamed cell', '', true]]);
  // names are text
  b.setFree([{ name: '<b>x</b>' }], 'me');
  assert.deepStrictEqual(rowsOf(p), [['1', '<b>x</b>', '', false]]);
  // the score beside each name (Owen 2026-10-16): the server's whole mass; anything else shows nothing
  b.setFree([{ name: 'big', score: 12345 }, { me: true, score: 0 }, { name: 'odd', score: 1.5 }, { name: 'neg', score: -3 }], 'Owen');
  assert.deepStrictEqual(rowsOf(p), [['1', 'big', '12345', false], ['2', 'Owen', '0', true], ['3', 'odd', '', false],
    ['4', 'neg', '', false]]);
  b.sync(false);
  assert.strictEqual(readBoard(p.doc).shown, false);
  // empty rows hide it even while playing
  b.sync(true);
  b.setFree([], 'me');
  assert.strictEqual(readBoard(p.doc).shown, false);
});

test('board on a phone: 5 rows (the component\'s phone rule), and a short screen keeps to 5 rows too', () => {
  const phone = page(390);
  const b = S.createBoard({ DSEnd: phone.D });
  b.setFree(freeRows(14, 7), 'Owen');
  b.sync(true);
  assert.deepStrictEqual(rowsOf(phone).map((x) => (x === 'gap' ? x : x[0])), ['1', '2', '3', '4', '5', 'gap', '8']);
  // a phone held sideways is wider than the phone rule but short: the page caps the rows so the pad stays clear
  const side = page(844);
  let short = true;
  const s = S.createBoard({ DSEnd: side.D, short: () => short });
  s.setFree(freeRows(14, 7), 'Owen');
  assert.deepStrictEqual(rowsOf(side).map((x) => (x === 'gap' ? x : x[0])), ['1', '2', '3', '4', '5', 'gap', '8']);
  short = false;
  s.setFree(freeRows(14, 7), 'Owen');
  assert.strictEqual(rowsOf(side).length, 10);
});

test('end card on a short window (a phone held sideways): the component shows it smaller so all of it fits', () => {
  const doc = makeDoc();
  const win = { document: doc, innerWidth: 844, innerHeight: 390 };
  // the drawn card: 460 px tall at its own size (a cash-out receipt)
  const make = doc.createElement;
  doc.createElement = (t) => {
    const e = make(t);
    e.getBoundingClientRect = function () { return { height: String(this.className).split(' ').indexOf('dse-card') >= 0 ? 460 : 0 }; };
    return e;
  };
  const D = installDSEnd(win);
  const end = S.createEnd({ DSEnd: D, win });
  const box = () => { const kids = readCard(doc).el.children; return kids[kids.length - 1]; };
  end.showCashed({ grossMicro: 2400000, cutMicro: 240000, netMicro: 2160000 }, LIFE);
  assert.ok(Math.abs(Number(box().style.zoom) - (390 - 24) / 460) < 1e-9, 'dsEnd fit: (390 - 24) / 460');
  end.paid('5Abc');
  assert.ok(Math.abs(Number(box().style.zoom) - (390 - 24) / 460) < 1e-9, 'kept on an update');
  win.innerHeight = 844;
  end.showDead({ lostMicro: 1 }, LIFE);
  assert.strictEqual(box().style.zoom, '', 'a tall window: the card at its own size');
});

test('board, paid: rows by money from ag:money with $ amounts, the own row by its rank, pinned past the top; a reset goes back', () => {
  const p = page(1366);
  const b = S.createBoard({ DSEnd: p.D });
  b.setFree(freeRows(3, 1), 'Owen');
  b.sync(true);
  const board = [];
  for (let i = 0; i < 14; i++) board.push(['p' + (i + 1), 2000000 - i * 100000]);
  board[2][0] = 'Owen';
  b.setMoney({ me: 1800000, rank: 3, board }, 'Owen');
  let r = readBoard(p.doc);
  assert.deepStrictEqual([r.shown, r.money], [true, true], 'the money board replaced the plain one');
  assert.strictEqual(p.doc.body.children.filter((c) => /\bdsb\b/.test(c.className)).length, 1, 'one board on the page');
  assert.deepStrictEqual(r.rows.slice(0, 3), [['1', 'p1', '$2.00', false], ['2', 'p2', '$1.90', false], ['3', 'Owen', '$1.80', true]]);
  // the world's plain rows are ignored once money drives the board
  b.setFree(freeRows(2, 0), 'Owen');
  assert.strictEqual(readBoard(p.doc).money, true);
  assert.strictEqual(rowsOf(p)[0][2], '$2.00');
  // 13th: pinned with the own balance
  b.setMoney({ me: 800000, rank: 13, board }, 'Owen');
  assert.deepStrictEqual(rowsOf(p).slice(-2), ['gap', ['13', 'p13', '$0.80', true]]);
  // the whole-client reset: the money board goes, the plain one comes back with the next rows
  b.clear();
  assert.strictEqual(readBoard(p.doc), null);
  b.setFree(freeRows(2, 1), 'Owen');
  b.sync(true);
  assert.deepStrictEqual([readBoard(p.doc).money, readBoard(p.doc).shown], [false, true]);
});
