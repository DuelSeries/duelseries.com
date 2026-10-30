// DuelSeries layer on the frozen slither.io client: paid snake on the new engine, the page side (PAID-SL-DESIGN.md 9,
// 3.3 "Respawn" and "Resume", 6 "Status for the card"; task T6). Ours, not a parity area. Loaded by the /sl page right
// after slxNet.js (server/sl/slBoot.js SLX_FILES), so slxMain merges its handshake fields and asks it before the
// lobby's auto Play. Nothing here decides money: every figure on the page is the server's (sl:x), in micro-USDC.
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20). Active, a page with no paid launch
// and no reload mark is the free page: this file makes no node, listener, timer or frame there, and every socket goes
// out exactly as before.
//
// 1. The launch (design 2 and 9; D2-M2, D3-F5). The lobby's wallet widget writes entryToken, entrySol, stake and a
//    one-shot nonce slPaidLaunch to sessionStorage, then opens /sl in #game-frame. This page is PAID only when the
//    nonce is there AND the token is a string of 1 to FIELD_MAX chars (the door's cap, server/slPaid/slPaidConst.js)
//    AND the stake is a paid rung (0.5 or 1). With the nonce, the four keys leave sessionStorage at once, whatever
//    they hold; the token lives in this closure only, never in a URL, a log, the DOM or storage. Without the nonce
//    nothing is read as money (a stale token of an old-engine launch is the lobby's to clear, its free branch).
// 2. The handshake (design 3.1). slx.paidAuth() is { paid: 1, stake, entryToken } while the token is unspent and
//    { paid: 1, stake } after; slxMain merges it into slx.auth, so it rides in the handshake of every /sl socket
//    (slxNet withAuth). The token is dropped the moment the socket that carried it opens: their sl:join has then gone
//    to the paid door (server/slPaid/slPaidDoor.js), which spends it or refuses it. A socket that never opened (a
//    failed connect) leaves it for the next Play. So a resume after a blip (slxNet sl:back, only ever after an open)
//    says { paid: 1, stake } and goes to the paid room by its key, and a paid page is never seated free: a paid
//    socket with no token is refused 'entry' by the door.
// 3. Drawing. One .slx-cash canvas between their game canvas (z-index 5) and their HUD (7), with slxHold's camera
//    math (slxHold.js screenX, screenY): a turning gold coin (slxCoin.js, Owen's pick 2026-10-15) on every cash pellet,
//    a plain #FFD700 disc while no coin frame is ready, and $x.xx in #14F195 over every paid head. Their client draws
//    food under the snakes but this canvas is above theirs, so what is drawn here is cut away under every live body and
//    head. Two looks (CASH_LOOK, Owen 2026-10-15; slx.paid.look() switches them live): 'gold', their own pellet in gold
//    (its core and glow sprites swapped for their recipe, slDrawWorld buildFoodSprites, made here in gold) that slowly
//    breathes, with a small dark $ in its middle (Owen's pick B4), the breath and the $ drawn here;
//    'coin', the coin, with their own pellet under it made invisible (sprites swapped for blank canvases of the same
//    sizes). Either way where it is, how it moves, fades and is eaten (sucked into the mouth) all stay theirs. The gold rule (design 9): a food is cash iff its rad byte is at least C_PAID_CASH_BYTE 68, and their
//    client keeps rad byte / 5 as the food's sz (slApply.js newFood), so cash is sz >= 13.6; in a paid room every
//    death drop is cash and nothing else reaches it (test/slPaidBytes.test.js). Worths come in sl:x {t: 'w', id, v}
//    (server/sl/slRoom.js _worthAll, _worthOnView), the own one with its delta d: a "+$0.01" pop rises over the own
//    head on d > 0 (slxSound plays the old money chime on the same message). The HUD line says "Your snake $0.53,
//    hold Q to cash out" while the own snake is alive.
// 4. The results card (slxCard's cardLines, beforeAgain and beforeLobby hooks): lost (the worth dropped as gold),
//    cashed (gross, the house's 10%, what the player receives, then GET /api/sl/cashout/:cid every POLL_MS for
//    POLL_FOR_MS: pending, sent or delayed), closed (refunded in full), refused by its why with the refund line, a
//    connection lost with money in, and the notices below. Play again on a paid page buys a new entry: sl:x answers
//    are the server's, the buy-in is the lobby's wallet (duel:restake { game: 'snake', engine: 'sl', stake, nonce },
//    answered only from the parent window, this origin, with this nonce; wallet-widget/src/restakeBridge.mjs), and
//    the fresh token goes straight into the next Play's handshake. A refusal or a close leaves only Lobby: that
//    entry is gone (refunded or never spent), and a refused buy-in would only be refused again. A death or a cash-out
//    has slxCard's Lobby, Spectate and Play again (Owen 2026-10-16): Spectate watches this rung, read only (slxWatch
//    watchOpen with this stake, the lobby's own paid Spectate), and the exit trap refuses it exactly as it refuses
//    Lobby. Outside the lobby frame there is no wallet to ask, so Play again shows there, unpressable.
// 5. The exit trap (design 9). While money may be in the room (from the socket that carried the token opening, or
//    the server's {t: 'room'}, until {t: 'lost'}, 'cashed', 'closed' or 'refused', or DROP_MS after the socket
//    dropped with no 'resumed'), and while a Play again buy-in is with the wallet (up to RESTAKE_WAIT_MS), the card's
//    Lobby is refused with "Hold Q to cash out first" and closing the page asks first (beforeunload). DROP_MS is
//    agar's (agLobby.js DROP_MS): the server's glide C_DISCONNECT 3 s, then the snake is gold and nothing is left.
// 6. The reload mark (design 9, OWEN-QUESTION 1: a reload is a disconnect). On pagehide while money may be in, this
//    page writes slxPaidCut = 1 (2 when the token was never sent: that entry is refunded unspent). The next page
//    takes the mark out at boot; with no paid launch it shows "Your paid snake was left when the page closed" on the
//    card and never auto-plays free (slx.paidHold, read by slxMain). A paid launch the page cannot read (the nonce
//    with no usable token or stake) holds the same way. A page back from the back/forward cache drops its own mark.
//
// Adds to DuelSlither.slx: paidAuth(), paidHold(), and on paid or notice pages cardLines(kind), beforeAgain(go),
// beforeLobby(); paid = { on, stake(), rung(), look(), state() } (state never holds the token).
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var S = D.S;
  var doc = root.document;
  if (!S || typeof slx.on !== 'function') return;

  var FIELD_MAX = 64;                            // the door's cap on a token (slPaidConst FIELD_MAX)
  var RUNGS = [0.5, 1];                          // the paid rungs (shared/stakeLadder.js, stakeRules STAKE_TIERS)
  var LAUNCH_KEY = 'slPaidLaunch';
  var HANDOFF_KEYS = [LAUNCH_KEY, 'entryToken', 'entrySol', 'stake'];
  var CUT_KEY = 'slxPaidCut';
  var CASH_SZ = 68 / 5;                          // C_PAID_CASH_BYTE 68 at their rad byte / 5: 13.6
  var DROP_MS = 5000;                            // agLobby.js DROP_MS (5 above)
  var RESTAKE_WAIT_MS = 120000;                  // Paper's and agar's restake safety window (agPaid.js)
  var POLL_MS = 2000;                            // design 6: the card asks every 2 s
  var POLL_FOR_MS = 60000;                       // for 60 s
  var NOTE_MS = 3000;                            // CHOSEN: a refused Lobby's note on screen
  var POP_MS = 900;                              // CHOSEN: the +$ pop's rise and fade
  var POP_RISE = 36;                             // CHOSEN: px the pop rises
  var POP_MAX = 6;
  var CID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;   // slPaidBoot isCashoutId
  var GOLD = '#FFD700';
  var GOLD_EDGE = '#8C5A00';
  var GREEN = '#14F195';
  var CASH_Z = '6';                              // between their game canvas (5) and their HUD (7), as slxHold's rings
  var PI2 = 2 * Math.PI;
  // Head radius in world units: their body is 29 x sc wide (slxHold HEAD_HALF).
  var HEAD_HALF = 29 / 2;
  // CHOSEN: the coin's radius covers the pellet's drawn dot (their core sprite is about 0.8 sz wide at zoom 1, slApply
  // newFood sizeIndex over the 17 sprites), so its colour shows only as the glow round the coin; and the label sits this
  // many px above the head.
  var COIN_R = 0.95;
  // CHOSEN (Owen 2026-10-15): the cash look, 'gold' (their pellet in gold, breathing) or 'coin' (slxCoin.js).
  var CASH_LOOK = 'gold';
  var GOLD_RGB = [255, 196, 0];                  // CHOSEN: the gold of the pellet (the reviewed G3 of the looks page)
  var BREATH_MS = 1200;                          // CHOSEN: one breath
  var LABEL_GAP = 10;

  // Plain words for every door answer (server/slPaid/slPaidDoor.js WHYS) and the free room's connect refusal 'limit'
  // (server/sl/slSockets.js), the refund sentence added from the answer itself, as agar's page does (agPaid.js REFUSED).
  var REFUSED = {
    entry: ['Entry not accepted', 'This entry could not be used. It may have expired before the game opened.'],
    'bad-stake': ['No such table', 'That table does not exist.'],
    'slow-down': ['Too fast', 'That join came too fast.'],
    restarting: ['Restarting', 'DuelSeries is restarting. Try again in a minute.'],
    full: ['Rooms full', 'Every paid snake room at this stake is full.'],
    maintenance: ['Updating', 'DuelSeries is updating. Try again in a few minutes.'],
    'not-open': ['Not open', 'Paid snake rooms are not open right now.'],
    unavailable: ['Try again', 'Could not confirm your entry right now.'],
    settled: ['Already refunded', 'This entry was already refunded.'],
    'join-lost': ['Connection dropped', 'The connection dropped while you were joining.'],
    'one-seat': ['Already playing', 'This wallet already has a paid snake in a room.'],
    'seat-failed': ['Could not seat you', 'Something went wrong while seating you.'],
    limit: ['Too many connections', 'Too many games are open from your network right now.']
  };
  // Refusals that leave the token unspent (or put back): the expiry sweep pays it back (server/entryExpiry.js).
  var UNSPENT = { entry: true, 'bad-stake': true, 'slow-down': true, restarting: true, full: true, unavailable: true,
    limit: true };
  var CLOSED = {
    shutdown: ['Restarting', 'DuelSeries is restarting, so your paid snake was closed.'],
    crash: ['Room closed', 'Your room stopped, so your paid snake was closed.'],
    emergency: ['Room closed', 'Your room hit a problem and was closed.'],
    orphan: ['Room closed', 'Your paid snake was closed.']
  };
  var STATUS = {
    pending: 'Sending to your wallet...',
    sent: 'Sent to your wallet.',
    delayed: 'Delayed: it is paid to your wallet automatically, nothing to do.',
    slow: 'Still on its way to your wallet. It is paid automatically.'
  };
  var TEXT = {
    unused: 'An entry that was never used goes back to your wallet automatically within a few minutes.',
    lost: function (v) { return 'Your ' + dollars(v) + ' dropped as gold for the other snakes.'; },
    left: function (v) {
      return 'The connection dropped. Your snake glided on for 3 seconds, then ' +
        (v > 0 ? 'its ' + dollars(v) : 'its money') + ' dropped as gold unless the page came back in time.';
    },
    // The page cannot tell these apart (review CLIENT-3): a restart that caught the snake mid-resume refunds it in
    // full, and a seat whose first message never arrived holds the money like any seat.
    leftRestart: 'If DuelSeries was restarting at that moment, it goes back to your wallet in full instead.',
    joinLost: 'The connection dropped while you were joining.',
    joinLostMoney: 'If your entry never reached a room, it is refunded automatically. If it did, your snake was left ' +
      'like any lost connection: after 3 seconds its money dropped as gold.',
    refunded: function (v) { return 'Your ' + dollars(v) + ' entry was refunded to your wallet.'; },
    closedRefund: function (v) { return 'Your ' + dollars(v) + ' goes back to your wallet in full, no house cut.'; },
    cashedNoOrder: 'Your cash-out is being checked. It reaches your wallet once confirmed.',
    gross: function (v) { return 'Cash-out: ' + dollars(v); },
    house: function (pct, v) { return 'House ' + pct + '%: ' + dollars(v); },
    net: function (v) { return 'You receive: ' + dollars(v); },
    grossRow: 'Cashed out',
    houseRow: function (pct) { return 'House ' + pct + '%'; },
    netRow: 'You receive',
    toWallet: 'to your wallet',
    lostUnit: 'lost',
    lobbyOnly: 'Buy a new entry in the lobby to play again.',
    againLabel: function (stake) { return 'Play again ' + dollars(stake * 1e6); },
    againAsk: 'Confirm in your wallet...',
    againSlow: 'Waiting for your wallet...',
    againSlowLine: 'Your wallet has not answered yet. If you approved the stake, wait here: the round starts once it lands.',
    againFailed: 'Stake failed',
    hudHead: 'Your snake ',
    hudKeys: ', hold Q to cash out',
    hudTouch: ', hold CASH OUT to cash out',
    lockKeys: 'Hold Q to cash out first',
    lockTouch: 'Hold CASH OUT to cash out first',
    lockWallet: 'Finish the stake in your wallet first',
    lockDrop: 'Your snake is still in the room. Try again in a few seconds.',
    lockJoin: 'Your seat is being set up. Try again in a moment.',
    leftTitle: 'Paid snake left',
    leftPage: 'Your paid snake was left when the page closed.',
    leftLine: 'Like any lost connection, it glided for 3 seconds, then its money dropped as gold. If it never reached ' +
      'a room, your entry is refunded automatically.',
    notStartedTitle: 'Paid game not started',
    notSent: 'The page closed before your paid game started.',
    badLaunch: 'This paid game could not start.'
  };

  var has = Object.prototype.hasOwnProperty;
  var store = null;
  try {
    store = root.sessionStorage || null;
  } catch (e) {
    store = null;
  }
  function storageGet(key) {
    try {
      return store ? store.getItem(key) : null;
    } catch (e) {
      return null;
    }
  }
  function storageSet(key, value) {
    try {
      if (store) store.setItem(key, value);
    } catch (e) { /* a private window: the mark is lost, the page still works */ }
  }
  function storageDel(key) {
    try {
      if (store) store.removeItem(key);
    } catch (e) { /* nothing to remove */ }
  }

  function fieldOk(v) {
    return typeof v === 'string' && v.length > 0 && v.length <= FIELD_MAX;
  }
  // The rung written by the widget ('0.5' or '1'), as a number, else null.
  function rungOf(raw) {
    if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw.trim())) return null;
    var n = Number(raw);
    return RUNGS.indexOf(n) >= 0 ? n : null;
  }
  function micro(v) {
    return typeof v === 'number' && v >= 0 && Math.floor(v) === v && v <= 9007199254740991 ? v : null;
  }
  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }
  // Micro-USDC as dollars, never rounded up: cents from a cent on, else ten-thousandths (a pellet of a long snake's
  // split is a few hundred micro).
  function dollars(m) {
    var v = Math.floor(Number(m));
    if (!(v >= 0)) v = 0;
    if (v === 0 || v >= 10000) {
      var c = Math.floor(v / 10000);
      return '$' + Math.floor(c / 100) + '.' + pad(c % 100, 2);
    }
    var t = Math.floor(v / 100);
    return t > 0 ? '$0.' + pad(t, 4) : '<$0.0001';
  }

  // ---- 1. the launch, read once
  var nonceSeen = !!storageGet(LAUNCH_KEY);
  var launchToken = nonceSeen ? storageGet('entryToken') : null;
  var launchStake = nonceSeen ? rungOf(storageGet('stake')) : null;
  if (nonceSeen) for (var h = 0; h < HANDOFF_KEYS.length; h++) storageDel(HANDOFF_KEYS[h]);
  var paid = nonceSeen && fieldOk(launchToken) && launchStake !== null;
  var mark = storageGet(CUT_KEY);
  if (mark !== null) storageDel(CUT_KEY);
  // held: what the page holds for (paidHold): '1' a paid snake left by the last unload, '2' an entry it never sent,
  // 'bad' a launch it could not read; '' none.
  var held = '';
  if (!paid && nonceSeen) held = 'bad';
  else if (!paid && mark) held = mark === '2' ? '2' : '1';

  var st = {
    stake: paid ? launchStake : 0,
    token: paid ? launchToken : null,
    room: null,                                  // {stake, cut} of this life's paid room (sl:x {t: 'room'})
    moneyIn: false,
    joinOut: false,
    dropTimer: null,
    dropped: false,                              // DROP_MS ran out with money in: the snake was left
    restaking: false,
    restakeSlow: false,
    restakeError: '',
    restakeTimer: null,
    nonce: null,
    go: null,
    life: newLife(),
    worth: {},                                   // snake id -> micro, from {t: 'w'}
    ownId: null                                  // the own snake's id this life (slxNet 'ownAdd')
  };
  launchToken = null;
  var pops = [];                                 // the own +$ pops: {t0, text}

  function newLife() {
    return { lost: null, cashed: null, closed: null, refused: null, status: '', poll: null, pollUntil: 0 };
  }

  slx.paidAuth = function () {
    if (!paid) return null;
    var a = { paid: 1, stake: st.stake };
    if (st.token) a.entryToken = st.token;
    return a;
  };
  slx.paidHold = function () { return held !== ''; };

  if (!paid && !held) {
    slx.paid = { on: false, stake: function () { return 0; }, state: function () { return { on: false }; } };
    return;
  }

  // Product tracking's base for this page (slxTrack): a paid seat at its rung, or a page held by its reload mark (it
  // never plays free). The rung is the server's once {t: 'room'} came. Never the token.
  slx.trackBase = function () {
    return paid ? { paid: true, stake: st.stake, mode: 'paid' } : { paid: true, mode: 'paid' };
  };

  // ---- the card hooks (slxCard reads them at the moment it needs them)
  function againFor() {
    if (st.restaking) return st.restakeSlow ? { text: TEXT.againSlow, disabled: true } : { text: TEXT.againAsk, disabled: true };
    return TEXT.againLabel(st.stake);
  }
  function canRestake() {
    return paid && slx.framed === true && typeof root.parent === 'object' && root.parent !== null &&
      typeof root.parent.postMessage === 'function';
  }
  function withAgain(view) {
    if (!canRestake()) {
      view.lines.push(TEXT.lobbyOnly);
      view.again = { text: TEXT.againLabel(st.stake), disabled: true };   // no wallet to ask: shown, unpressable
      return view;
    }
    view.again = againFor();
    if (st.restakeSlow) view.lines.push(TEXT.againSlowLine);
    if (st.restakeError) view.lines.push({ text: st.restakeError, cls: 'slx-paid-error' });
    return view;
  }
  function noticeView() {
    if (held === '1') return { title: TEXT.leftTitle, lines: [TEXT.leftPage, TEXT.leftLine], again: false };
    return { title: TEXT.notStartedTitle, lines: [held === '2' ? TEXT.notSent : TEXT.badLaunch, TEXT.unused], again: false };
  }
  function cardLines(kind) {
    if (kind === 'paid') return held ? noticeView() : null;
    if (!paid) return null;
    var l = st.life;
    if (l.refused) {
      var r = has.call(REFUSED, l.refused.why) ? REFUSED[l.refused.why] : ['Not seated', 'The room did not let you in.'];
      var lines = [r[1]];
      if (l.refused.refunded > 0) lines.push(TEXT.refunded(l.refused.refunded));
      else if (has.call(UNSPENT, l.refused.why)) lines.push(TEXT.unused);
      return { title: r[0], lines: lines, again: false, spectate: false };
    }
    if (l.closed) {
      var c = has.call(CLOSED, l.closed.why) ? CLOSED[l.closed.why] : CLOSED.orphan;
      var cl = [c[1]];
      if (l.closed.refunded > 0) cl.push(TEXT.closedRefund(l.closed.refunded));
      return { title: c[0], lines: cl, again: false, spectate: false };
    }
    if (l.cashed) {
      var k = l.cashed;
      if (k.gross === null) return withAgain({ lines: [TEXT.cashedNoOrder] });
      var pct = st.room && st.room.cut > 0 ? st.room.cut : 10;
      // The shared card (slxCard, dsEnd): the server's net as the big figure, its gross, cut and net as the rows.
      return withAgain({ tone: 'win', hero: dollars(k.net), unit: TEXT.toWallet,
        ledger: [[TEXT.grossRow, dollars(k.gross)], [TEXT.houseRow(pct), '−' + dollars(k.cut)], [TEXT.netRow, dollars(k.net)]],
        status: { text: STATUS[l.status] || STATUS.pending, state: l.status === 'sent' ? 'ok' : 'pending' }, lines: [] });
    }
    if (l.lost) return withAgain({ tone: 'loss', hero: '−' + dollars(l.lost.v), unit: TEXT.lostUnit, lines: [TEXT.lost(l.lost.v)] });
    if (st.token) return null;                   // the token never went out: the card's own Try again sends it
    if (st.room) return withAgain({ lines: [TEXT.left(ownWorth()), TEXT.leftRestart] });
    return withAgain({ lines: [TEXT.joinLost, TEXT.joinLostMoney] });
  }
  slx.cardLines = cardLines;

  function ownWorth() {
    return st.ownId !== null && has.call(st.worth, st.ownId) ? st.worth[st.ownId] : 0;
  }

  function refreshCard() {
    var c = slx.card;
    if (c && typeof c.refresh === 'function') c.refresh();
  }

  // ---- notes (a refused Lobby) and the HUD line: .slx-paid-* (public/css/slx.css)
  var body = doc && doc.body && typeof doc.createElement === 'function' ? doc.body : null;
  var note = null;
  var noteGen = 0;
  function showNote(text) {
    if (!body) return;
    if (!note) {
      note = doc.createElement('div');
      note.className = 'slx-paid-note';
      note.setAttribute('role', 'status');
      body.appendChild(note);
    }
    note.textContent = text;
    note.style.display = 'block';
    var my = ++noteGen;
    if (typeof root.setTimeout === 'function') {
      root.setTimeout(function () { if (my === noteGen && note) note.style.display = 'none'; }, NOTE_MS);
    }
  }

  // ---- the reload notice: once every layer file loaded (slxCard and slxMain run after this file)
  if (!paid) {
    var notice = function () {
      var c = slx.card;
      if (slx.inLobby === true && c && typeof c.notice === 'function') c.notice('paid');
    };
    if (typeof root.setTimeout === 'function') root.setTimeout(notice, 0);
    slx.paid = { on: false, stake: function () { return 0; }, state: function () { return { on: false, held: held }; } };
    return;
  }

  // ---- 5. the exit trap
  function locked() {
    return st.moneyIn || st.joinOut || (st.restaking && !st.restakeSlow);
  }
  function clearDrop() {
    if (st.dropTimer === null) return;
    try {
      root.clearTimeout(st.dropTimer);
    } catch (e) { /* nothing to clear */ }
    st.dropTimer = null;
  }
  function moneyOut() {
    st.moneyIn = false;
    st.joinOut = false;
    clearDrop();
  }
  // The socket dropped (a resume started, or the life closed) with money maybe in: let go after DROP_MS unless the
  // server gave the life back first.
  function onDrop() {
    if (!(st.moneyIn || st.joinOut) || st.dropTimer !== null) return;
    if (typeof root.setTimeout !== 'function') {
      st.dropped = true;
      moneyOut();
      return;
    }
    st.dropTimer = root.setTimeout(function () {
      st.dropTimer = null;
      st.dropped = true;
      st.moneyIn = false;
      st.joinOut = false;
    }, DROP_MS);
  }
  function lockText() {
    if (st.restaking) return TEXT.lockWallet;
    if (st.dropTimer !== null) return TEXT.lockDrop;
    if (!st.moneyIn) return TEXT.lockJoin;
    return S.is_mobile ? TEXT.lockTouch : TEXT.lockKeys;
  }
  slx.beforeLobby = function () {
    if (!locked()) return false;
    showNote(lockText());
    return true;
  };
  if (typeof root.addEventListener === 'function') {
    // The browser shows its own "leave this site?" text; what a page asks it to say is ignored.
    root.addEventListener('beforeunload', function (e) {
      if (!locked()) return undefined;
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (e) e.returnValue = '';
      return '';
    });
    // 6. the reload mark
    root.addEventListener('pagehide', function () {
      if (st.moneyIn || st.joinOut) storageSet(CUT_KEY, '1');
      else if (st.token) storageSet(CUT_KEY, '2');
    });
    root.addEventListener('pageshow', function (e) {
      if (e && e.persisted === true) storageDel(CUT_KEY);
    });
    root.addEventListener('message', onMessage);
  }

  // ---- what the server says (slxNet relays each sl:x item as 'x:' + t)
  slx.on('open', function () {
    stopPoll();
    st.life = newLife();
    st.room = null;
    st.dropped = false;
    st.worth = {};
    st.ownId = null;
    pops.length = 0;
    clearDrop();
    st.moneyIn = false;
    st.joinOut = false;
    if (st.token) {
      st.token = null;                           // spent or refused by the door now; never sent again
      st.joinOut = true;
    }
  });
  slx.on('ownAdd', function (ev) {
    if (ev && typeof ev.id === 'number') st.ownId = ev.id;
  });
  slx.on('x:room', function (m) {
    var s = Number(m.stake);
    if (RUNGS.indexOf(s) < 0) return;
    st.stake = s;
    st.room = { stake: s, cut: typeof m.cut === 'number' && m.cut > 0 && m.cut < 100 ? m.cut : 10 };
    st.joinOut = false;
    st.moneyIn = true;
    clearDrop();
  });
  slx.on('x:w', function (m) {
    var id = m.id;
    var v = micro(m.v);
    if (typeof id !== 'number' || !(id >= 0) || Math.floor(id) !== id || v === null) return;
    st.worth[id] = v;
    if (typeof m.d === 'number' && m.d > 0 && m.d <= v) {
      pops.push({ t0: slx.now(), text: '+' + dollars(m.d) });
      if (pops.length > POP_MAX) pops.shift();
    }
  });
  slx.on('x:lost', function (m) {
    var v = micro(m.v);
    st.life.lost = { v: v === null ? 0 : v };
    moneyOut();
    refreshCard();
  });
  slx.on('x:cashed', function (m) {
    var g = micro(m.gross);
    var c = micro(m.cut);
    var n = micro(m.net);
    var full = g !== null && c !== null && n !== null && c + n === g;
    st.life.cashed = { gross: full ? g : null, cut: full ? c : null, net: full ? n : null };
    moneyOut();
    if (full && typeof m.cid === 'string' && CID_RE.test(m.cid)) startPoll(m.cid);
    refreshCard();
  });
  slx.on('x:closed', function (m) {
    var v = micro(m.refunded);
    st.life.closed = { why: typeof m.why === 'string' ? m.why : '', refunded: v === null ? 0 : v };
    moneyOut();
    refreshCard();
  });
  slx.on('x:refused', function (m) {
    var v = micro(m.refunded);
    st.life.refused = { why: typeof m.why === 'string' ? m.why : '', refunded: v === null ? 0 : v };
    moneyOut();
    refreshCard();
  });
  slx.on('resuming', onDrop);
  slx.on('resumed', clearDrop);
  slx.on('close', onDrop);

  // ---- the cash-out status (design 6): GET /api/sl/cashout/:cid, the cid checked before it goes in the path
  function stopPoll() {
    var l = st.life;
    if (l.poll !== null) {
      try {
        root.clearTimeout(l.poll);
      } catch (e) { /* nothing to clear */ }
      l.poll = null;
    }
  }
  function startPoll(cid) {
    var l = st.life;
    l.status = 'pending';
    if (typeof root.fetch !== 'function' || typeof root.setTimeout !== 'function') return;
    l.pollUntil = slx.now() + POLL_FOR_MS;
    var ask = function () {
      l.poll = null;
      if (st.life !== l) return;
      var p;
      try {
        p = root.fetch('/api/sl/cashout/' + cid, { cache: 'no-store', credentials: 'same-origin' });
      } catch (e) {
        p = null;
      }
      var next = function (state) {
        if (st.life !== l) return;
        if (state === 'sent' || state === 'delayed') {
          l.status = state;
          refreshCard();
          return;
        }
        if (slx.now() >= l.pollUntil) {
          l.status = 'slow';
          refreshCard();
          return;
        }
        l.poll = root.setTimeout(ask, POLL_MS);
      };
      if (!p || typeof p.then !== 'function') return next('');
      p.then(function (r) {
        return r && r.ok && typeof r.json === 'function' ? r.json() : null;
      }).then(function (j) {
        next(j && typeof j.state === 'string' ? j.state : '');
      }, function () {
        next('');
      });
    };
    l.poll = root.setTimeout(ask, POLL_MS);
  }

  // ---- Play again: a new entry through the lobby's wallet (restakeBridge)
  var nonceSeq = 0;
  // A fresh id for one restake request, echoed back by the lobby's wallet with its answer (agPaid.js newNonce).
  function newNonce() {
    var c = root.crypto;
    try {
      var a = new root.Uint32Array(4);
      c.getRandomValues(a);
      return Array.prototype.map.call(a, function (n) { return n.toString(36); }).join('');
    } catch (e) {
      nonceSeq++;
      return 'n' + nonceSeq + '-' + Math.floor(slx.now()).toString(36);
    }
  }
  function ownOrigin() {
    var o = root.location && root.location.origin;
    return typeof o === 'string' && o && o !== 'null' ? o : null;
  }
  function clearRestakeTimer() {
    if (st.restakeTimer === null) return;
    try {
      root.clearTimeout(st.restakeTimer);
    } catch (e) { /* nothing to clear */ }
    st.restakeTimer = null;
  }
  function restakeEnd() {
    st.restaking = false;
    st.restakeSlow = false;
    st.nonce = null;
    clearRestakeTimer();
  }
  slx.beforeAgain = function (go) {
    if (st.token) return false;                  // an unspent token: the card's own Play sends it
    if (st.restaking || !canRestake()) return true;
    var origin = ownOrigin();
    st.restaking = true;
    st.restakeSlow = false;
    st.restakeError = '';
    st.nonce = newNonce();
    st.go = typeof go === 'function' ? go : null;
    if (typeof root.setTimeout === 'function') {
      st.restakeTimer = root.setTimeout(function () {
        st.restakeTimer = null;
        if (!st.restaking) return;
        st.restakeSlow = true;                   // the way back opens; a late answer still starts the round
        refreshCard();
      }, RESTAKE_WAIT_MS);
    }
    try {
      root.parent.postMessage({ type: 'duel:restake', game: 'snake', engine: 'sl', stake: st.stake, nonce: st.nonce },
        origin || '*');
    } catch (e) {
      restakeEnd();
      st.restakeError = TEXT.againFailed;
    }
    refreshCard();
    return true;
  };
  // The lobby's answer: only the parent window, only this origin, only this request's nonce; the fresh token goes
  // into the next Play's handshake and nowhere else.
  function onMessage(e) {
    var d = e && e.data;
    if (!st.restaking || !d || typeof d !== 'object') return;
    if (e.source !== root.parent) return;
    var origin = ownOrigin();
    if (!origin || e.origin !== origin) return;
    if (typeof d.nonce !== 'string' || d.nonce !== st.nonce) return;
    if (d.type === 'duel:restake:done' && fieldOk(d.entryToken)) {
      restakeEnd();
      st.token = d.entryToken;
      var go = st.go;
      st.go = null;
      refreshCard();
      if (!(go && go() === true)) {
        var m = D.slMain;
        D.play(m && typeof m.nick === 'string' ? m.nick : '');
      }
    } else if (d.type === 'duel:restake:error') {
      restakeEnd();
      st.go = null;
      st.restakeError = String(d.message || TEXT.againFailed).slice(0, 160);
      refreshCard();
    }
  }

  // ---- 3. drawing
  var hud = null;
  var hudValue = null;
  var hudTail = null;
  var hudShown = false;
  var hudText = '';
  var hudW = 0;
  var hudTop = -1;
  var canvas = null;
  var ctx = null;
  if (body) {
    hud = doc.createElement('div');
    hud.className = 'slx-paid-hud';
    hud.setAttribute('aria-live', 'off');
    var hudHead = doc.createElement('span');
    hudHead.textContent = TEXT.hudHead;
    hudValue = doc.createElement('span');
    hudValue.className = 'slx-paid-hud-v';
    hudTail = doc.createElement('span');
    hudTail.textContent = S.is_mobile ? TEXT.hudTouch : TEXT.hudKeys;
    hud.appendChild(hudHead);
    hud.appendChild(hudValue);
    hud.appendChild(hudTail);
    hud.style.display = 'none';
    body.appendChild(hud);
    canvas = doc.createElement('canvas');
    canvas.className = 'slx-cash';
    var cs = canvas.style;
    cs.position = 'fixed';
    cs.left = '0px';
    cs.top = '0px';
    cs.pointerEvents = 'none';
    cs.zIndex = CASH_Z;
    body.appendChild(canvas);
    ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  }
  var drawn = false;
  var cw = -1;
  var ch = -1;
  var cdpr = -1;

  // Their camera (slxHold screenX, screenY): the backing store maps world to screen as mww2 + (x - view_xx) * gsc
  // (slDrawWorld.js food passes), the canvas sits at floor(ww / 2 - mww / 2) and is scaled by csc about its centre.
  function screenX(wx) {
    return Math.floor(S.ww / 2 - S.mww / 2) + S.mww / 2 + (wx - S.view_xx) * S.gsc * S.csc;
  }
  function screenY(wy) {
    return Math.floor(S.hh / 2 - S.mhh / 2) + S.mhh / 2 + (wy - S.view_yy) * S.gsc * S.csc;
  }

  function fit() {
    var w = root.innerWidth;
    var hh = root.innerHeight;
    var dpr = root.devicePixelRatio > 0 ? root.devicePixelRatio : 1;
    if (w === cw && hh === ch && dpr === cdpr) return;
    cw = w;
    ch = hh;
    cdpr = dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = hh + 'px';
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(hh * dpr));
    drawn = false;                               // a size write clears the bitmap
  }

  function alive() {
    return !!(S.slither && S.connected && S.dead_mtm == -1);
  }

  // Every cash pellet in the chosen look, faded and popping in with it, each on its own phase: 'gold' breathes over
  // their gold pellet; 'coin' is a gold coin as big as the pellet's drawn dot (a plain gold disc where no coin frame is
  // ready yet or the browser cannot draw one). An eaten one follows their flight into the mouth, shrinking with their
  // rad, and the snakes over them cut them away (underSnakes), the eater's head last of all.
  function drawGold(k) {
    var list = S.foods;
    var n = S.foods_c;
    if (!list || !(n > 0)) return 0;
    var gold = look === 'gold' ? goldSet() : null;
    var coin = !gold && slx.coin && typeof slx.coin.blit === 'function' ? slx.coin : null;
    var t = slx.now();
    if (coin) coin.beginFrame();
    var count = 0;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < n; i++) {
      var fo = list[i];
      if (!fo || !(fo.sz >= CASH_SZ)) continue;
      dress(fo, gold);
      var r = fo.sz * COIN_R * k * (fo.rad > 0 ? fo.rad : 0);
      if (!(r >= 0.5)) continue;
      var x = screenX(fo.rx);
      var y = screenY(fo.ry);
      var m = r * 1.3;                           // the edge band and the twinkle reach past r
      if (x < -m || y < -m || x > cw + m || y > ch + m) continue;
      var a = fo.fr >= 0 && fo.fr <= 1 ? fo.fr : 1;
      if (!(a > 0)) continue;
      var ph = phaseOf(fo);
      ctx.globalAlpha = a;
      if (gold) {
        breathe(fo, gold, x, y, a, t, ph);
        dollar(fo, gold, x, y, t, ph);
      }
      else if (!coin || !coin.blit(ctx, x, y, r, cdpr, t, ph, fo.rad >= 1)) disc(x, y, r);
      if (coin && !fo.eaten) coin.sparkle(ctx, x, y, r, t, ph);
      if (x - m < x0) x0 = x - m;
      if (y - m < y0) y0 = y - m;
      if (x + m > x1) x1 = x + m;
      if (y + m > y1) y1 = y + m;
      count++;
    }
    ctx.globalAlpha = 1;
    if (count) underSnakes(k, x0, y0, x1, y1);
    return count;
  }
  // Their client draws food before the snakes (slDrawWorld redraw rows 10 and 11, the bodies rows 16 and 17), so a
  // body hides the pellets under it; this canvas is above theirs, so every live snake that reaches the coins' box
  // (x0, y0, x1, y1) erases them along its body: head to tail as one round line as wide as the body (29 sc, slxHold
  // HEAD_HALF), faded as the body is (alive_amt, dead_amt).
  function underSnakes(k, x0, y0, x1, y1) {
    var list = S.slithers;
    if (!list || !list.length) return;
    var on = false;
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      var pts = o && !o.dead ? o.pts : null;
      if (!pts || !pts.length) continue;
      var vis = (o.alive_amt >= 0 ? o.alive_amt : 1) * (1 - (o.dead_amt > 0 ? o.dead_amt : 0));
      if (!(vis > 0)) continue;
      var hx = o.xx + (o.fx || 0), hy = o.yy + (o.fy || 0);
      var wx0 = hx, wy0 = hy, wx1 = hx, wy1 = hy;
      for (var j = 0; j < pts.length; j++) {
        var px = pts[j].xx + (pts[j].fx || 0), py = pts[j].yy + (pts[j].fy || 0);
        if (px < wx0) wx0 = px; else if (px > wx1) wx1 = px;
        if (py < wy0) wy0 = py; else if (py > wy1) wy1 = py;
      }
      var w = 2 * HEAD_HALF * (o.sc > 0 ? o.sc : 1) * k;
      if (screenX(wx1) + w < x0 || screenY(wy1) + w < y0 || screenX(wx0) - w > x1 || screenY(wy0) - w > y1) continue;
      if (!on) {
        on = true;
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = '#000';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
      }
      ctx.globalAlpha = vis > 1 ? 1 : vis;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(screenX(hx), screenY(hy));
      for (j = pts.length - 1; j >= 0; j--) ctx.lineTo(screenX(pts[j].xx + (pts[j].fx || 0)), screenY(pts[j].yy + (pts[j].fy || 0)));
      ctx.stroke();
    }
    if (on) ctx.restore();
  }
  // Their client draws every food in four passes from the sprites newFood copied onto it (slApply copyTier: the core
  // fi, the shadow ofi, the glows gfi and g2fi, each with its size fields; newFood is the only place they are set).
  // A cash food's sprites are swapped: in the 'gold' look its core and two glows for the gold set's at the food's own
  // size indices (cv2, gcv, g2cv: their recipe, so the very same sizes) and its shadow kept (theirs is black whatever
  // the colour); in the 'coin' look all four for transparent canvases of the very same sizes. Their passes still run on
  // it exactly as before; nothing else of the food changes. Its own shadow is kept aside, so a switch back restores it.
  var goldSprites = null;
  function goldSet() {
    if (goldSprites) return goldSprites;
    if (!doc || typeof doc.createElement !== 'function') return null;
    var o = { imgs: [], fws: [], gimgs: [], gfws: [] };
    var rgb = 'rgba(' + GOLD_RGB[0] + ', ' + GOLD_RGB[1] + ', ' + GOLD_RGB[2] + ', ';
    try {
      // their food sprites (slDrawWorld buildFoodSprites, game.js:3788-3840): 17 sizes, step from 2.8 by += 1, a core
      // (solid to .99, then a .2 rim) and a glow (the full colour to nothing over step x 4)
      for (var step = 2.8; step <= 18.8; step += 1) {
        var side = Math.ceil(2 * (step * .65));
        o.imgs.push(radial(side, 0, side / 2, [[0, rgb + '1)'], [.99, rgb + .2 + ')'], [1, rgb + '0)']]));
        o.fws.push(side);
        side = Math.ceil(step * 8 + 6);
        o.gimgs.push(radial(side, 1, step * 4, [[0, rgb + '1)'], [1, rgb + '0)']]));
        o.gfws.push(side);
      }
    } catch (e) {
      return null;
    }
    goldSprites = o;
    return o;
  }
  function radial(side, r0, r1, stops) {
    var cv = doc.createElement('canvas');
    cv.width = cv.height = side;
    var g = cv.getContext('2d');
    var gr = g.createRadialGradient(side / 2, side / 2, r0, side / 2, side / 2, r1);
    for (var i = 0; i < stops.length; i++) gr.addColorStop(stops[i][0], stops[i][1]);
    g.fillStyle = gr;
    g.fillRect(0, 0, side, side);
    return cv;
  }
  var shadows = typeof root.WeakMap === 'function' ? new root.WeakMap() : null;
  function dress(fo, gold) {
    if (!doc || typeof doc.createElement !== 'function') return;
    var c = gold ? gold.imgs[fo.cv2] : null;
    // a food the gold set does not fit (never seen: same recipe, same sizes) keeps its own look
    if (gold && !(c && gold.fws[fo.cv2] === fo.fw && gold.gimgs[fo.gcv] && gold.gimgs[fo.g2cv])) return;
    if (gold ? fo.fi === c : fo.fi === blanks[Math.ceil(fo.fw)]) return;
    if (shadows && !shadows.has(fo)) shadows.set(fo, fo.ofi);
    if (gold) {
      fo.fi = c;
      fo.gfi = gold.gimgs[fo.gcv];
      fo.g2fi = gold.gimgs[fo.g2cv];
      if (shadows) fo.ofi = shadows.get(fo);
      return;
    }
    fo.fi = blank(fo.fw);
    fo.ofi = blank(fo.ofw);
    fo.gfi = blank(fo.gfw);
    fo.g2fi = blank(fo.g2fw);
  }
  // The breath over their gold pellet (css px, at its drawn centre x, y, alpha a): the same core a little bigger and
  // brighter, and their two glows stronger, swelling and settling every BREATH_MS (at rest nothing is added). Placed as
  // their foodCores and foodGlows place them (slDrawWorld: sprite size x rad on their canvas, x csc on screen; the glows
  // pushed out from the screen centre, alphas from the distance).
  function breathOf(t, ph) {
    return 0.5 - 0.5 * Math.cos(((t / BREATH_MS + ph) % 1) * PI2);
  }
  // CHOSEN (Owen's pick B4, 2026-10-15): a small dark $ in the middle of every gold pellet, as big as their core and
  // breathing with it, so the money never reads as a yellow snake's food. It shrinks with their rad as the pellet pops in
  // or is eaten (gone under 4 px); a grown one is never under 9 px. One sprite per device pixel size, made once.
  var glyphs = {};
  var nGlyphs = 0;
  function dollar(fo, gold, x, y, t, ph) {
    var rad = fo.rad > 0 ? fo.rad : 0;
    var size = gold.fws[fo.cv2] * rad * S.csc / 2 * (1 + 0.2 * breathOf(t, ph)) * 1.45;
    if (rad >= 1 && size < 9) size = 9;
    if (!(size >= 4)) return;
    var g = glyph(Math.round(size * cdpr));
    if (!g) return;
    var w = g.width / cdpr;
    ctx.drawImage(g, x - w / 2, y - w / 2 + size * 0.04, w, w);
  }
  function glyph(px) {
    if (has.call(glyphs, px)) return glyphs[px];
    if (nGlyphs >= 96) {
      glyphs = {};
      nGlyphs = 0;
    }
    var g = null;
    try {
      var cv = doc.createElement('canvas');
      cv.width = cv.height = Math.ceil(px * 1.3) + 2;
      var c = cv.getContext('2d');
      c.font = 'bold ' + px + 'px Arial, "Helvetica Neue", Helvetica, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.lineWidth = Math.max(1, px * 0.12);
      c.strokeStyle = 'rgba(255, 240, 170, 0.8)';
      c.strokeText('$', cv.width / 2, cv.height / 2);
      c.fillStyle = 'rgba(110, 58, 0, 0.95)';
      c.fillText('$', cv.width / 2, cv.height / 2);
      g = cv;
    } catch (e) {
      g = null;
    }
    glyphs[px] = g;
    nGlyphs++;
    return g;
  }
  function breathe(fo, gold, x, y, a, t, ph) {
    var b = breathOf(t, ph);
    if (!(b > 0.02)) return;
    var rad = fo.rad > 0 ? fo.rad : 0, k = S.csc;
    var pulse = 0.5 + 0.5 * Math.cos((fo.gfr || 0) / 13);
    var c = gold.imgs[fo.cv2];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (c) {
      var w = gold.fws[fo.cv2] * rad * k * (1 + 0.2 * b);
      ctx.globalAlpha = a * b * (0.45 + 0.4 * pulse);
      ctx.drawImage(c, x - w / 2, y - w / 2, w, w);
    }
    var dx = fo.rx - S.view_xx, dy = fo.ry - S.view_yy, d2 = dx * dx + dy * dy;
    glow(gold, fo.gcv, x, y, dx, dy, 1 + 0.06 * rad, 0.005 + 0.09 * (1 - d2 / (86E3 + d2)), rad, k, a * b * 0.9);
    glow(gold, fo.g2cv, x, y, dx, dy, 1 + 0.32 * rad, 0.085 * (1 - d2 / (16500 + d2)), rad, k, a * b * 0.9);
    ctx.restore();
  }
  function glow(gold, j, x, y, dx, dy, push, al, rad, k, f) {
    var img = gold.gimgs[j];
    if (!img) return;
    if (rad !== 1) al *= Math.pow(rad, 0.25);
    var gw = gold.gfws[j] * rad * k;
    var gx = x + dx * (push - 1) * S.gsc * k - gw / 2, gy = y + dy * (push - 1) * S.gsc * k - gw / 2;
    ctx.globalAlpha = al * f;
    ctx.drawImage(img, gx, gy, gw, gw);
  }
  var look = CASH_LOOK;
  var blanks = {};
  function blank(side) {
    var s = side > 0 ? Math.ceil(side) : 1;
    var b = blanks[s];
    if (!b) {
      b = doc.createElement('canvas');
      b.width = s;
      b.height = s;
      blanks[s] = b;
    }
    return b;
  }
  function disc(x, y, r) {
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, PI2);
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.strokeStyle = GOLD_EDGE;
    ctx.stroke();
  }
  // A pellet's fixed spin phase, 0..1: from its id (their newFood f.id), else its spawn point, so the coins do not turn
  // in step.
  function phaseOf(fo) {
    var v = typeof fo.id === 'number' ? fo.id | 0 : ((+fo.xx || 0) * 31 + (+fo.yy || 0) * 17) | 0;
    v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
    v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
  }

  function label(text, x, y, size, colour) {
    ctx.font = 'bold ' + size + 'px Arial, "Helvetica Neue", Helvetica, sans-serif';
    ctx.lineWidth = Math.max(2, size / 5);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
  }

  // $x.xx over each paid head (a snake their list holds, alive, with a worth), and the own pops above its own.
  function drawLabels(k) {
    var list = S.slithers;
    if (!list || !list.length) return 0;
    var me = S.slither;
    var count = 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o || o.dead || !has.call(st.worth, o.id)) continue;
      var sc = o.sc > 0 ? o.sc : 1;
      var x = screenX(o.xx + (o.fx || 0));
      var y = screenY(o.yy + (o.fy || 0)) - HEAD_HALF * sc * k - LABEL_GAP;
      if (x < -80 || y < -40 || x > cw + 80 || y > ch + 60) continue;
      var size = Math.max(12, Math.min(22, Math.round(10 + 6 * sc * k)));
      ctx.globalAlpha = 1;
      label(dollars(st.worth[o.id]), x, y, size, GREEN);
      count++;
      if (o === me && pops.length) {
        var t = slx.now();
        for (var p = 0; p < pops.length; p++) {
          var u = (t - pops[p].t0) / POP_MS;
          if (!(u >= 0 && u < 1)) continue;
          ctx.globalAlpha = 1 - u;
          label(pops[p].text, x, y - size - 4 - POP_RISE * u, Math.max(12, size - 2), GREEN);
        }
        ctx.globalAlpha = 1;
      }
    }
    var now = slx.now();
    while (pops.length && now - pops[0].t0 >= POP_MS) pops.shift();
    return count;
  }

  function draw() {
    var k = S.gsc * S.csc;
    var foods = S.foods_c > 0;
    var any = foods || pops.length > 0 || (S.slithers && S.slithers.length > 0);
    if (!any && !drawn) return;
    fit();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawn = false;
    if (!any || !(k > 0)) return;
    ctx.setTransform(cdpr, 0, 0, cdpr, 0, 0);
    var n = drawGold(k) + drawLabels(k);
    drawn = n > 0;
  }

  function hudFrame() {
    var me = S.slither;
    var v = alive() && me && has.call(st.worth, me.id) ? st.worth[me.id] : null;
    var want = v !== null;
    if (want !== hudShown) {
      hudShown = want;
      hud.style.display = want ? 'block' : 'none';
    }
    if (!want) return;
    var text = dollars(v);
    var hs = slx.hud;
    if (text !== hudText) {
      hudText = text;
      hudValue.textContent = text;
      hudW = hs ? hud.offsetWidth || 0 : 0;
    }
    // the top centre slot slxHud keeps clear of their leaderboard (under it on a phone held upright, Owen 2026-10-16)
    var top = hs && typeof hs.topSlot === 'function' ? hs.topSlot(hudW) : -1;
    if (top >= 0 && top !== hudTop) {
      hudTop = top;
      hud.style.top = top + 'px';
    }
  }

  function frame() {
    root.requestAnimationFrame(frame);
    try {
      if (ctx) draw();
      if (hud) hudFrame();
    } catch (e) {
      slx.errors = (slx.errors || 0) + 1;
    }
  }
  if (body && typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(frame);

  slx.paid = {
    on: true,
    stake: function () { return st.stake; },
    // The rung, for the card's Spectate (slxCard: the lobby's paid Spectate watches it, read only). Never a buy-in.
    rung: function () { return st.stake; },
    // The cash look, 'gold' or 'coin' (CASH_LOOK); with an argument, switches to it from the next frame.
    look: function (v) {
      if (v === 'gold' || v === 'coin') look = v;
      return look;
    },
    // For tests and the console: the page's paid state, never the token itself.
    state: function () {
      var w = {};
      for (var id in st.worth) if (has.call(st.worth, id)) w[id] = st.worth[id];
      return { on: true, stake: st.stake, hasToken: !!st.token, room: !!st.room, moneyIn: st.moneyIn,
        joinOut: st.joinOut, locked: locked(), dropping: st.dropTimer !== null, dropped: st.dropped,
        restaking: st.restaking, restakeSlow: st.restakeSlow, status: st.life.status, worth: w, pops: pops.length };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
