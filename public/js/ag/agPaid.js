// The /ag page's paid hand-off (PAID-AGAR-DESIGN.md 4 steps 3 to 10 and 6, build checklist 11). Ours, never in the
// free room: public/ag.html loads it, agMain builds the flow only when its config says handoff and the lobby's wallet
// left a paid hand-off in sessionStorage, and the parity harness loads neither. Paper's page
// (public/js/paper/mp/paperArenaMain.js) is the template wherever the protocol is the same:
//
// 1. The hand-off. The lobby's wallet widget writes stake, entryToken and playerName to sessionStorage before it opens
//    this page (wallet-widget/src/main.jsx launchStaked); they are read once at boot (Paper's readSession). A stake
//    above 0 with a token is a paid seat to buy. The token leaves sessionStorage at boot, as Paper's start() takes it
//    (page memory keeps it), and goes in the first ag:join. Until the door answers (ag:joined or ag:refused) page
//    memory keeps it for the one case with no resume key yet: the link dropping before the answer, when the same token
//    goes out again on every new connection until an answer comes (the door dedupes it by its proof: it gives back the
//    seat that token bought, tells the refund it made, or seats it for the first time). Paper's rule,
//    paperArenaMain.js joinToken. A token that never went out (no connection yet) is put back on pagehide, so a
//    reload finds the hand-off as the lobby left it.
// 2. The socket connects with auth { paid: 1 } (agNet passes ioOptions), so the server keeps it seatless instead of
//    giving it a free watcher seat (server/ag/agSockets.js, agArenas.connectPaid), and the join goes to the paid door
//    (server/ag/agPaidDoor.js) with { name, stake, entryToken }.
// 3. ag:ready only after the page has DRAWN a frame with its own cell from this room: the door's new cell is shielded
//    and still until then (design 4 step 5), so a player whose page is not drawing yet (a hidden tab, a slow load)
//    can never be eaten. No target, split, eject or hold goes out before it; the first target after it is fresh
//    (agCamera's last-sent pair is reset), so the cell moves where the mouse is.
// 4. The resume key. ag:joined carries the seat's resumeKey; the page keeps it in page memory, as Paper does, and
//    writes it to sessionStorage only on pagehide (a reload or a frame that navigates), taking it out again at the
//    next boot (design 4 step 4, narrowed: a Duplicate tab or a session copy taken while the seat plays never holds
//    it, and the resume is bearer-only on the server). So a reload can take the seat back too (the dropped seat waits
//    5 s, then 3 minutes frozen and edible, Owen Q5). A reconnect or a reload sends ag:join { name, stake, resumeKey }
//    at the seat's own rung (no token, nothing spent); the door gives the seat back, or answers with what became of
//    it (the receipt of an automatic cash-out, the death, or the refusal). The key goes as soon as the seat ends. A
//    token join still unanswered at pagehide leaves only a mark, so the reloaded page says the join was cut off
//    (Paper's refused screen in the same case) instead of opening the free page.
// 5. Every door refusal and end state gets a plain message on the paid card and a clean way back to the lobby.
// 6. Esc never opens the menu on a hand-off page (design 6: no menu, no Spectate); while the seat plays it shows how
//    to leave ("Hold Q to cash out").
// 7. Play again after a death or a cash-out buys a new seat through the lobby's wallet (duel:restake, answered by
//    duel:restake:done with a fresh token, wallet-widget/src/restakeBridge.mjs); Back to lobby and the Lobby button
//    are shut while that buy-in is with the wallet (Paper's lockLobby), so a token minted after the lobby cleared this
//    frame can never land in a blank frame.
//
// 8. The exit lock (agLobby's 'paid:lock' hook) holds while any join is out (a token may already be money in a seat,
//    a resume key is one), and while a dropped seat is reconnecting, until GIVE_UP_MS, when the card also offers
//    Back to lobby; agLobby's own trap holds from ag:joined. So the Lobby chip and the card agree on when leaving opens.
//
// Tokens and resume keys never go into a URL, a log, analytics or the DOM: page memory and sessionStorage only, as
// Paper does with its own. Nothing here decides money: every figure on the card is the server's.
(function (root) {
  'use strict';
  var A = root.DuelAgarLib = root.DuelAgarLib || {};

  // sessionStorage, written on pagehide only: { k: the open seat's resume key, s: its rung }, or { p: 1, s } for a
  // token join that had no answer yet. Taken out again at boot.
  var RESUME_KEY = 'agResume';
  var NAME_MAX = 15;                // the name box's own cap (agScreens LAYOUT.nickMax), as agLobby prefills it
  var FIELD_MAX = 64;               // the door's cap on a token or a key (agPaidDoor FIELD_MAX)
  var SLOW_RETRY_MS = 500;          // the door's slow-down answer asks for 500 ms (agPaidDoor retryMs)
  // CHOSEN (PARITY-LOG 2026-10-09 page hand-off): how long a join may go unanswered before the card offers the way
  // back (the server gives a seatless paid socket PAID_SEATLESS_MS 15 s to join, agArenas).
  var JOIN_ANSWER_MS = 15000;
  // CHOSEN: how long the page waits on a dropped link before the reconnect card also offers Back to lobby (Paper
  // gives up after DISCONNECT_GRACE_MS + 20 s; here the seat itself waits 3 minutes, so the page keeps trying).
  var GIVE_UP_MS = 20000;
  var RESTAKE_WAIT_MS = 120000;     // Paper's restake safety window (paperArenaMain.js RESTAKE_WAIT_MS)
  var ESC_HINT_MS = 3000;           // CHOSEN: the Esc hint's time on screen
  var NOTICE_MS = 6000;             // CHOSEN: the "you already had a seat" notice's time on screen

  // Plain words for every door answer (server/ag/agPaidDoor.js TEXT, agRoom _paidClosed), without the refund
  // sentence: that line is added from the answer itself (refunded), as Paper's refused screen does.
  var REFUSED = {
    'not-open': ['Not open', 'Paid agar.io tables are not open right now.'],
    restarting: ['Restarting', 'DuelSeries is restarting. Try again in a minute.'],
    maintenance: ['Updating', 'DuelSeries is updating. Try again in a few minutes.'],
    'seat-failed': ['Could not seat you', 'Something went wrong while seating you.'],
    'no-room': ['No safe spot', 'There was no safe place to start you.'],
    full: ['Tables full', 'Every agar.io table at this stake is full.'],
    cooldown: ['Paused', 'Your last joins did not connect, so paid tables are paused for this wallet for a few minutes.'],
    entry: ['Entry not accepted', 'This entry could not be used. It may have expired before the game opened.'],
    'bad-stake': ['No such table', 'That table does not exist.'],
    unavailable: ['Try again', 'Could not confirm your entry right now.'],
    settled: ['Already refunded', 'This entry was already refunded.'],
    expired: ['Seat ended', 'That seat is no longer open.'],
    'join-lost': ['Connection dropped', 'The connection dropped while you were joining.'],
    // A seat that never readied in time (agMoney release), or a seatless socket whose join was not seated within
    // PAID_SEATLESS_MS (agArenas.connectPaid, for example a slow ledger claim): neither is the player's doing.
    'join-timeout': ['Not started in time', 'Your game did not start in time.'],
    'join-failed': ['Could not start you', 'Something went wrong while starting you.'],
    // The connection cap (agSockets AG_CONN, per address: a shared campus network can reach it). Refused at connect,
    // before the door ever sees the token.
    limit: ['Too many connections', 'Too many games are open from your network right now.']
  };
  var TEXT = {
    refunded: 'Your entry was refunded to your wallet.',
    // An entry that never reached a seat is paid back by the server's expiry sweep (server/entryExpiry.js).
    unused: 'An entry that was never used goes back to your wallet automatically within a few minutes.',
    // 'expired' covers a restart (refunded in full, Owen Q6), a seat that ended long ago, and a frozen seat with no
    // cell (agMoney houseSettle 'zombie': booked for a manual look, agar_breach), so the line claims no more than that.
    expired: 'If it still held money, that money goes back to your wallet (after a rare server fault, once it is ' +
      'checked by hand).',
    lostTitle: 'Connection dropped',
    lost: 'The page reloaded while you were joining.',
    lostLine: 'Your entry was not played, so it comes back to your wallet within a few minutes, no house cut.',
    joiningTitle: function (stake) { return 'Joining the ' + money(stake) + ' room'; },
    joining: 'Getting your seat ready',
    resumingTitle: 'Getting your seat back',
    resuming: 'Reconnecting to your room',
    reconnectTitle: 'Reconnecting',
    reconnect: 'Your cells stay where they are for 3 minutes and can still be eaten. If you are not back by then, ' +
      'what is left is cashed out to your wallet.',
    replacedTitle: 'Seat moved',
    replaced: 'This seat was taken over by a newer connection.',
    noAnswerTitle: 'No answer',
    noAnswer: 'The table did not answer.',
    // A new buy-in from the same wallet, at any rung, puts it back in a seat it still holds and refunds that entry
    // (agPaidDoor step 10, reattach).
    noAnswerSeat: 'Your seat, if you had one, waits 3 minutes. Join a paid agar.io table from the lobby to get back ' +
      'into it; that new entry is refunded.',
    reattach: 'You already had a seat, so you are back in it. This new entry was refunded.',
    escKeys: 'Hold Q to cash out',
    escTouch: 'Hold Cash out to leave',
    againAsk: 'Confirm in your wallet...',
    againSlow: 'Waiting for your wallet...',
    againSlowLine: 'Your wallet has not answered yet. If you approved the stake, wait here: the round starts once it lands.',
    againFailed: 'Stake failed'
  };
  // Refusals whose entry comes back with no refund on the answer itself: the expiry sweep pays back a token never
  // consumed, and a join cut off mid-claim is refunded 'join-lost' once the claim lands (agPaidDoor step 9).
  var AUTO_REFUND = { restarting: true, entry: true, unavailable: true, 'join-timeout': true, limit: true };

  function money(stake) {
    var n = Number(stake);
    return '$' + (isFinite(n) && n > 0 ? n : 0).toFixed(2);
  }

  function storageGet(store, key) {
    try { return store ? store.getItem(key) : null; } catch (e) { return null; }
  }
  function storageSet(store, key, value) {
    try { if (store) store.setItem(key, value); } catch (e) { /* a private window: the seat still plays, no reload resume */ }
  }
  function storageDel(store, key) {
    try { if (store) store.removeItem(key); } catch (e) { /* nothing to remove */ }
  }
  function fieldOk(v) { return typeof v === 'string' && v.length > 0 && v.length <= FIELD_MAX; }

  // What the last unload left (pagehide): { key, stake } for an open seat, { lost: true, stake } for a token join that
  // had no answer yet, or null.
  function readResume(store) {
    var raw = storageGet(store, RESUME_KEY);
    if (!raw) return null;
    var v = null;
    try { v = JSON.parse(raw); } catch (e) { v = null; }
    if (!v || typeof v !== 'object') return null;
    var s = Number(v.s);
    var stake = isFinite(s) && s > 0 ? s : 0;
    if (fieldOk(v.k)) return { key: v.k, stake: stake, lost: false };
    if (v.p === 1 && stake > 0) return { key: null, stake: stake, lost: true };
    return null;
  }

  // The lobby's hand-off, read once (Paper's readSession: the same sessionStorage keys the wallet writes). paid: a
  // stake above 0 with an entry token to spend; or, with no token, what this page left at its last unload: an open
  // seat's resume key (the reload resumes it at the seat's own rung, which a reattach can make differ from the stake
  // the lobby wrote), or the mark of a token join cut off by the reload. A stake with none of these (a hand-off already
  // spent, or the Free rung's stake 0) is the free page.
  function readHandoff(store, local) {
    var stakeN = Number(storageGet(store, 'stake'));
    var stake = isFinite(stakeN) && stakeN > 0 ? stakeN : 0;
    var token = storageGet(store, 'entryToken');
    token = fieldOk(token) ? token : null;
    var name = String(storageGet(store, 'playerName') || storageGet(local, 'duelseries_playername') || '').trim()
      .slice(0, NAME_MAX);
    var r = !token && stake > 0 ? readResume(store) : null;
    var resumeKey = r && r.key ? r.key : null;
    var lost = !!(r && r.lost);
    if (r && r.stake > 0) stake = r.stake;
    return { paid: stake > 0 && !!(token || resumeKey || lost), stake: stake, entryToken: token, resumeKey: resumeKey,
      lost: lost, name: name };
  }

  // A fresh id for one restake request, echoed back by the lobby's wallet with its answer (Paper's newNonce).
  function newNonce(win) {
    try {
      var a = new win.Uint32Array(4);
      win.crypto.getRandomValues(a);
      return Array.prototype.map.call(a, function (n) { return n.toString(36); }).join('');
    } catch (e) {
      return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }

  // The small chip for the Esc hint and the one-line notices (ag.css #ag-paid-hint).
  function createChip(doc, host) {
    var el = null;
    var gen = 0;
    return {
      show: function (text, ms, win) {
        if (!doc || !host) return;
        if (!el) {
          el = doc.createElement('div');
          el.setAttribute('id', 'ag-paid-hint');
          el.setAttribute('role', 'status');
          host.appendChild(el);
        }
        el.textContent = text;
        el.hidden = false;
        var my = ++gen;
        if (win && typeof win.setTimeout === 'function') {
          win.setTimeout(function () { if (gen === my && el) el.hidden = true; }, ms);
        }
      },
      text: function () { return el && !el.hidden ? el.textContent : ''; },
      hide: function () { gen++; if (el) el.hidden = true; }
    };
  }

  // o: {
  //   handoff (readHandoff), store (sessionStorage), win (setTimeout, crypto),
  //   send(kind, payload) -> true when it went out ('paidJoin', 'ready'), reconnect() (open a server-closed socket),
  //   card() -> the paid card (agScreens.createPaidEnd), enterPlay(joinedPayload) (the page's play state, no menu),
  //   freshTarget() (forget the last-sent target), lock(on) (the page's exit lock: agLobby), touch() -> boolean,
  //   chip (createChip), framed, parent (the lobby window), origin (this page's origin), phEvent(name, props) }
  function createFlow(o) {
    var h = o.handoff || {};
    var win = o.win || root;
    var st = {
      phase: 'connecting',    // connecting | joining | seated | live | reconnecting | end
      stake: h.stake || 0,
      name: h.name || '',
      token: h.entryToken || null,   // the hand-off's token, until the first join takes it
      resumeKey: h.entryToken ? null : (h.resumeKey || null),
      lost: !h.entryToken && !h.resumeKey && h.lost === true,   // the last unload cut a token join off
      joinToken: null,        // a token join still waiting for its answer (page memory only)
      joinKey: null,          // a resume join still waiting for its answer
      conns: 0,               // connections made
      seated: false,          // ag:joined came and the seat has not ended
      spawned: false,         // the world spawned the own cell since that ag:joined
      needReady: false,
      readySent: false,
      restaking: false,
      nonce: null,
      ended: ''               // the last end state, for the probes
    };
    var timers = {};
    function later(name, fn, ms) {
      var my = (timers[name] = (timers[name] || 0) + 1);
      win.setTimeout(function () { if (timers[name] === my) { timers[name]++; fn(); } }, ms);
    }
    function cancel(name) { timers[name] = (timers[name] || 0) + 1; }
    function card() { return o.card(); }
    function lock(on) { try { o.lock(!!on); } catch (e) { /* the lobby script is optional */ } }

    // The key lives in page memory; sessionStorage holds it only between a pagehide and the next boot (see 4 above).
    function clearResume() {
      st.resumeKey = null;
      storageDel(o.store, RESUME_KEY);
    }
    function pending() { return !!(st.joinToken || st.joinKey); }

    // ---- unload (agMain: pagehide and pageshow) ----
    // pagehide: what a reload needs, nothing more. A token that never went out goes back where the lobby put it; an
    // open seat's key (also while it reconnects or its resume join is out) is written with its rung; a token join with
    // no answer yet leaves only a mark (its token stays in page memory and dies with it).
    function onPageHide() {
      if (st.token) { storageSet(o.store, 'entryToken', st.token); return; }
      if (st.resumeKey && st.phase !== 'end') {
        storageSet(o.store, RESUME_KEY, JSON.stringify({ k: st.resumeKey, s: st.stake }));
        return;
      }
      if (st.joinToken) storageSet(o.store, RESUME_KEY, JSON.stringify({ p: 1, s: st.stake }));
    }
    // pageshow from the back/forward cache: this page is alive again with its memory, so the copies go.
    function onPageShow(e) {
      if (!e || e.persisted !== true) return;
      if (st.token) storageDel(o.store, 'entryToken');
      storageDel(o.store, RESUME_KEY);
    }

    // ---- joining ----
    function showJoining() {
      if (st.joinToken) card().showWait(TEXT.joiningTitle(st.stake), TEXT.joining);
      else card().showWait(TEXT.resumingTitle, TEXT.resuming);
    }
    // extra: { entryToken } or { resumeKey }. A join that cannot go out now (the link is down) stays pending and goes
    // out on the next connection.
    function sendJoin(extra) {
      st.joinToken = extra.entryToken || null;
      st.joinKey = st.joinToken ? null : (extra.resumeKey || null);
      st.phase = 'joining';
      // A token in flight may already be money and a resume key is a seat with money in it: no walking out until the
      // door answers (or JOIN_ANSWER_MS / GIVE_UP_MS give the way back).
      lock(true);
      showJoining();
      emitJoin();
    }
    function emitJoin() {
      var msg = { name: st.name, stake: st.stake };
      if (st.joinToken) msg.entryToken = st.joinToken;
      else if (st.joinKey) msg.resumeKey = st.joinKey;
      else return;
      if (o.send('paidJoin', msg)) later('answer', noAnswer, JOIN_ANSWER_MS);
    }
    function firstJoin() {
      if (st.token) {
        var t = st.token;
        st.token = null;
        sendJoin({ entryToken: t });
        return;
      }
      if (st.resumeKey) {
        sendJoin({ resumeKey: st.resumeKey });
        return;
      }
      end('gone', TEXT.noAnswerTitle, TEXT.noAnswer);
    }
    // The door answered (ag:joined, ag:refused, or a remembered outcome): the token is spent or refunded either way.
    function answered() {
      st.joinToken = null;
      st.joinKey = null;
      cancel('answer');
      cancel('retry');
    }
    function noAnswer() {
      if (!pending()) return;
      var hadKey = !!st.joinKey;
      answered();
      end('gone', TEXT.noAnswerTitle, TEXT.noAnswer, hadKey ? TEXT.noAnswerSeat : TEXT.unused);
    }

    // ---- end states ----
    // kind: 'gone' | 'refused' (a message on the card), or 'dead' | 'cashed' | 'closed' (agMain already shows the
    // server's figures on the card). Leaving is open again; Play again only after a death or a cash-out, only inside
    // the lobby's frame (a page opened on its own has no wallet to ask, Paper's prepareAgain).
    function end(kind, title, text, extra) {
      st.phase = 'end';
      st.seated = false;
      st.ended = kind;
      cancel('giveUp');
      cancel('answer');
      if (!st.restaking) lock(false);
      if (kind === 'gone' || kind === 'refused') card().showMessage(kind, title, text, extra);
      if ((kind === 'dead' || kind === 'cashed') && o.framed && st.stake > 0) {
        card().setAgain({ text: 'Play again ' + money(st.stake) });
      }
    }
    function refusedView(p) {
      var why = typeof p.why === 'string' ? p.why : '';
      var t = Object.prototype.hasOwnProperty.call(REFUSED, why) ? REFUSED[why] : null;
      var title = t ? t[0] : 'Not seated';
      var text = t ? t[1] : (typeof p.text === 'string' && p.text ? p.text : 'The table did not let you in.');
      var extra = '';
      if (p.refunded === true) extra = TEXT.refunded;
      else if (why === 'expired') extra = TEXT.expired;
      else if (AUTO_REFUND[why]) extra = TEXT.unused;
      return { title: title, text: text, extra: extra };
    }

    // ---- connection ----
    function onConnect() {
      st.conns++;
      cancel('giveUp');
      if (pending()) {
        // The link dropped between a join and its answer, so no resume key came: the same token (or key) goes out
        // again on this connection, as on every new one until an answer comes (see 1 in the header; the door dedupes
        // a token by its proof). Each answer clears it.
        showJoining();
        emitJoin();
        return;
      }
      if (st.phase === 'connecting') { firstJoin(); return; }
      if (st.phase === 'reconnecting' && st.resumeKey) sendJoin({ resumeKey: st.resumeKey });
    }
    function onDisconnect() {
      cancel('answer');
      cancel('retry');
      if (st.seated) {
        st.seated = false;
        st.phase = 'reconnecting';
        // The seat still holds money: the page stays shut until the card offers the way back (agLobby's own trap lets
        // go DROP_MS after a drop, so without this the Lobby chip would come back long before the card's button).
        lock(true);
        card().showWait(TEXT.reconnectTitle, TEXT.resuming);
        later('giveUp', function () {
          if (st.phase !== 'reconnecting') return;
          lock(false);
          card().showWait(TEXT.reconnectTitle, TEXT.reconnect, { lobby: true });
        }, GIVE_UP_MS);
        return;
      }
      if (pending()) {
        card().showWait(TEXT.reconnectTitle, st.joinToken ? TEXT.joining : TEXT.resuming);
        later('giveUp', function () {
          if (!pending()) return;
          lock(false);
          card().showWait(TEXT.reconnectTitle, st.joinToken ? TEXT.unused : TEXT.reconnect, { lobby: true });
        }, GIVE_UP_MS);
      }
    }

    // ---- server side events (agMain hands them all over, after its own handling) ----
    function onEvent(name, p) {
      p = p && typeof p === 'object' ? p : {};
      switch (name) {
        case 'ag:joined':
          if (!(Number(p.stake) > 0)) return;
          answered();
          cancel('giveUp');
          st.stake = Number(p.stake);
          st.seated = true;
          st.phase = 'seated';
          st.spawned = false;
          st.readySent = false;
          st.needReady = p.confirmed !== true;
          if (fieldOk(p.resumeKey)) st.resumeKey = p.resumeKey;   // page memory (see 4 above)
          lock(false);   // the seat is open: agLobby's own exit trap holds the page from here (ag:joined with a stake)
          o.enterPlay(p);
          if (p.resumed !== true && typeof o.phEvent === 'function') {
            try { o.phEvent('game_started', { game: 'agar', stake: st.stake }); } catch (e) { /* analytics never breaks the game */ }
          }
          return;
        case 'ag:refused':
          if (p.why === 'cash-out-to-leave') return;
          if (p.why === 'slow-down') {
            if (pending()) later('retry', emitJoin, Math.max(SLOW_RETRY_MS, Number(p.retryMs) || 0));
            return;
          }
          if (p.closed === true) {
            // The seat this page held was released and refunded before it was confirmed (agRoom _paidClosed).
            answered();
            clearResume();
            var v = refusedView(p);
            end('refused', v.title, v.text, v.extra);
            return;
          }
          if (!pending()) return;   // nothing of this page's waits for an answer (a seatless socket's own timeout)
          var wasKey = !!st.joinKey;
          answered();
          if (wasKey || p.why === 'expired') clearResume();
          var w = refusedView(p);
          end('refused', w.title, w.text, w.extra);
          return;
        case 'ag:refunded':
          if (p.why === 'reattach' && o.chip) o.chip.show(TEXT.reattach, NOTICE_MS, win);
          return;
        case 'ag:dead':
          answered();
          clearResume();
          end('dead');
          return;
        case 'ag:cashedout':
          if (p.free === true) return;
          answered();
          clearResume();
          end('cashed');
          return;
        case 'ag:closed':
          answered();
          clearResume();
          end('closed');
          return;
        case 'ag:replaced':
          clearResume();
          end('gone', TEXT.replacedTitle, TEXT.replaced);
          return;
        default:
          return;
      }
    }

    // ---- the first drawn frame (agMain, after the world pass) ----
    function onSpawn() {
      if (st.phase === 'seated') st.spawned = true;
    }
    // covered: the phone's "turn your phone sideways" card is over the game (agPortrait, up to PROMPT_MS 3 s, and it
    // eats taps), so the player cannot act yet: the cell stays shielded and still until it goes (the door's
    // JOIN_CONFIRM_MS 5 s still covers it, the card shows once per tab and never for longer).
    function onFrame(ownCount, covered) {
      if (st.phase !== 'seated' || !st.spawned || !(ownCount > 0) || covered === true) return;
      if (st.needReady && !st.readySent) {
        if (!o.send('ready')) return;   // the link is down: the resume brings a new ag:joined
        st.readySent = true;
      }
      st.phase = 'live';
      o.freshTarget();
    }

    // ---- Play again (Paper's onAgainClick and its message handler) ----
    function restake() {
      if (!o.framed || st.restaking || st.phase !== 'end' || !(st.stake > 0)) return false;
      st.restaking = true;
      st.nonce = newNonce(win);
      lock(true);
      var c = card();
      c.setAgain({ text: TEXT.againAsk, disabled: true });
      c.setLobbyLocked(true);
      c.setError('');
      later('restake', restakeSlow, RESTAKE_WAIT_MS);
      try {
        o.parent.postMessage({ type: 'duel:restake', game: 'agar', stake: st.stake, nonce: st.nonce }, '*');
      } catch (e) {
        restakeFailed('');
        return false;
      }
      return true;
    }
    // No answer yet: the way back opens again (a late answer is still taken, the round starts once it lands).
    function restakeSlow() {
      if (!st.restaking) return;
      lock(false);
      var c = card();
      c.setLobbyLocked(false);
      c.setAgain({ text: TEXT.againSlow, disabled: true });
      c.setError(TEXT.againSlowLine);
    }
    function restakeFailed(message) {
      st.restaking = false;
      cancel('restake');
      lock(false);
      var c = card();
      c.setLobbyLocked(false);
      c.setAgain({ text: 'Play again ' + money(st.stake) });
      if (message) c.setError(message);
    }
    // The lobby's answer to duel:restake: only the parent frame, only this origin, only the request this page made
    // (the nonce, always echoed by the lobby's bridge, wallet-widget/src/restakeBridge.mjs answer(); an answer without
    // it is not ours); the fresh token goes straight into ag:join and is never stored.
    function onMessage(e) {
      var d = e && e.data;
      if (!d || typeof d !== 'object' || !st.restaking) return;
      if (e.source !== o.parent) return;
      if (!o.origin || e.origin !== o.origin) return;
      if (typeof d.nonce !== 'string' || d.nonce !== st.nonce) return;
      if (d.type === 'duel:restake:done' && fieldOk(d.entryToken)) {
        st.restaking = false;
        cancel('restake');
        card().setLobbyLocked(false);
        sendJoin({ entryToken: d.entryToken });
        if (typeof o.reconnect === 'function') o.reconnect();   // a socket the server closed comes back for it
      } else if (d.type === 'duel:restake:error') {
        restakeFailed(String(d.message || TEXT.againFailed));
      }
    }

    // ---- Esc (agMain: a hand-off page never opens the menu, design 6; not even on an end card, whose way out is Back
    // to lobby or Play again, as on Paper's end screens) ----
    function holdsMenu() { return true; }
    function escape() {
      if (!o.chip) return;
      if (st.phase === 'live' || st.phase === 'seated') {
        o.chip.show(o.touch && o.touch() ? TEXT.escTouch : TEXT.escKeys, ESC_HINT_MS, win);
      }
    }

    // Boot: the token and any key leave sessionStorage (page memory keeps them; Paper's start() takes the token the
    // same way), then the joining card at once (no menu, no Spectate), the exit lock while the hand-off's token is
    // unspent or its seat is to be taken back, and the way back after GIVE_UP_MS if the server never answers the
    // connection (the unspent token is refunded by the expiry sweep; a connection that comes later still joins). A
    // reload that cut a token join off ends at once with that message and needs no socket (offline()).
    function start() {
      storageDel(o.store, 'entryToken');
      storageDel(o.store, RESUME_KEY);
      if (st.lost) {
        end('refused', TEXT.lostTitle, TEXT.lost, TEXT.lostLine);
        return;
      }
      lock(!!(st.token || st.resumeKey));
      if (st.token) card().showWait(TEXT.joiningTitle(st.stake), TEXT.joining);
      else card().showWait(TEXT.resumingTitle, TEXT.resuming);
      later('giveUp', function () {
        if (st.phase !== 'connecting') return;
        lock(false);
        card().showWait(TEXT.reconnectTitle, st.token ? TEXT.unused : TEXT.reconnect, { lobby: true });
      }, GIVE_UP_MS);
    }

    return {
      start: start,
      onConnect: onConnect,
      onDisconnect: onDisconnect,
      onEvent: onEvent,
      onSpawn: onSpawn,
      onFrame: onFrame,
      onMessage: onMessage,
      onPageHide: onPageHide,
      onPageShow: onPageShow,
      offline: function () { return st.phase === 'end'; },
      restake: restake,
      escape: escape,
      holdsMenu: holdsMenu,
      canSteer: function () { return st.phase === 'live'; },
      stake: function () { return st.stake; },
      name: function () { return st.name; },
      // For tests and probes: the flow's state, never the token or the key themselves.
      state: function () {
        return { phase: st.phase, stake: st.stake, seated: st.seated, spawned: st.spawned, readySent: st.readySent,
          needReady: st.needReady, pendingToken: !!st.joinToken, pendingKey: !!st.joinKey, hasResume: !!st.resumeKey,
          restaking: st.restaking, ended: st.ended, conns: st.conns };
      }
    };
  }

  A.agPaid = {
    RESUME_KEY: RESUME_KEY,
    REFUSED: REFUSED,
    TEXT: TEXT,
    AUTO_REFUND: AUTO_REFUND,
    JOIN_ANSWER_MS: JOIN_ANSWER_MS,
    GIVE_UP_MS: GIVE_UP_MS,
    RESTAKE_WAIT_MS: RESTAKE_WAIT_MS,
    ESC_HINT_MS: ESC_HINT_MS,
    readHandoff: readHandoff,
    readResume: readResume,
    createFlow: createFlow,
    createChip: createChip,
    money: money
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = A.agPaid;
})(typeof window !== 'undefined' ? window : globalThis);
