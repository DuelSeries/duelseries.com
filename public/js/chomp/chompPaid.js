// Chomp's paid page pieces (window.ChompPaid), used by chompMain.js only when the lobby's wallet left a paid hand-off
// in sessionStorage (the free page never builds any of this):
//   handoff()            agar.io's reader of the hand-off (public/js/ag/agPaid.js readHandoff): stake, entryToken,
//                        playerName, or a resume key left by this page's last unload ('chResume', Chomp's own). A
//                        token counts only with the one-shot launch mark the lobby's wallet writes for a paid Chomp
//                        launch (LAUNCH_KEY, as /sl's slPaidLaunch): a stake and token another game left in the tab
//                        never turn the free page into a paid one or spend that token here.
//   createCard(opts)     the end card's states on the shared DSEnd card, in Chomp's words: the paid hand-off's own
//                        (showWait, showMessage, setAgain, setLobbyLocked, setBuying, setError, as agScreens.createEnd)
//                        and the server's (showCashed, showDead, showClosed, paid, payError). Every figure is the
//                        server's own micro amount through DSEnd.usd.
//   createLock(win)      no walking out with money in the room (agLobby's exit trap): from c:joined with a stake until
//                        the seat ends, plus the flow's own lock while a token or a Play again buy-in is out; the
//                        page's Lobby refuses and closing the tab asks first; a dropped socket lets go after DROP_MS
//   createHold(o)        hold Q (or the phone's Cash out button): c:hold {on: 1} every 200 ms while held, {on: 0} on
//                        release; the ring's progress from the server's c:holding {on, need}
//   WORDS, REFUSED       Chomp's lines for agPaid.createFlow (o.text, o.refused)
// The money itself (the coins, the 90/10, the refunds) is all the server's; nothing here decides an amount.
(function (root) {
  'use strict';
  var doc = root.document;
  var AP = root.DuelAgarLib && root.DuelAgarLib.agPaid;

  var WORDS = {
    noAnswerSeat: 'Your seat, if you had one, waits 3 minutes. Join a paid Chomp room from the lobby to get back ' +
      'into it; that new entry is refunded.',
    reconnect: 'Your chomper keeps going for 5 seconds, then waits where it is for 3 minutes and can still be caught. ' +
      'If you are not back by then, what you hold is cashed out to your wallet.',
    escTouch: 'Hold Cash out to leave'
  };
  var REFUSED = {
    'not-open': ['Not open', 'Paid Chomp rooms are not open right now.'],
    full: ['Rooms full', 'Every Chomp room at this stake is full.'],
    'no-room': ['No safe spot', 'There was no safe place to start you, away from the ghosts.']
  };

  var END = {
    caught: 'Caught by a ghost',
    eatenBy: function (n) { return 'Eaten by ' + n; },
    eaten: 'Caught',
    cashed: 'Cashed out',
    autoCashed: 'Cashed out automatically',
    lost: 'dropped on the maze',
    toWallet: 'to your wallet',
    gross: 'Cashed out',
    house: 'House 10%',
    net: 'You receive',
    sending: 'Sending to your wallet',
    recorded: 'Your payout is recorded and goes to your wallet.',
    sent: 'Sent to your wallet.',
    view: 'View transaction',
    delayed: 'Payout delayed. Your winnings are recorded and will be sent.',
    closedTitle: 'Refunded',
    closedEmptyTitle: 'Room closed',
    heldTitle: 'On hold',
    closed: 'The room closed on our side, so your whole balance goes back to your wallet, no house cut.',
    restart: 'The server is restarting, so your whole balance goes back to your wallet, no house cut, once it is back.',
    closedEmpty: 'The room closed on our side. Any balance you had goes back to your wallet in full, no house cut.',
    held: 'Something went wrong on our side. Your balance is held for review, to be paid back to your wallet by hand.',
    again: 'Play again',
    spectate: 'Spectate',
    lobby: 'Lobby',
    time: 'Time',
    score: 'Score',
    deadNote: 'Your coins are on the maze for anyone to grab.'
  };
  var TX_URL = 'https://solscan.io/tx/';

  var LAUNCH_KEY = 'chompPaidLaunch';
  var RESUME_KEY = 'chResume';

  function handoff() {
    if (!AP) return { paid: false };
    var ss = null, ls = null;
    try { ss = root.sessionStorage; } catch (e) { ss = null; }
    try { ls = root.localStorage; } catch (e) { ls = null; }
    var mark = null;
    try { mark = ss ? ss.getItem(LAUNCH_KEY) : null; if (mark) ss.removeItem(LAUNCH_KEY); } catch (e) { mark = null; }
    var h = AP.readHandoff(ss, ls, RESUME_KEY);
    if (mark) return h;
    // no launch mark: only a seat this page held before a reload (its own resume key, or the mark of a token join
    // the reload cut off); a stake and token left by another game are not ours to spend
    var r = AP.readResume(ss, RESUME_KEY);
    if (!r) return { paid: false };
    return { paid: true, stake: r.stake, entryToken: null, resumeKey: r.key, lost: r.lost, name: h.name };
  }

  // opts: { onLobby(), onSpectate() } -> the card's states (agScreens.createEnd's contract) plus onAgain.
  function createCard(opts) {
    opts = opts || {};
    var D = root.DSEnd;
    var api = { kind: '', onAgain: null };
    if (!D) {
      ['showWait', 'showMessage', 'setAgain', 'setLobbyLocked', 'setBuying', 'setError', 'showCashed', 'showDead',
        'showClosed', 'payError', 'hide'].forEach(function (k) { api[k] = function () {}; });
      api.paid = function () { return false; };
      api.shown = function () { return false; };
      return api;
    }
    var cur = null;
    var extra = { again: null, lobbyLocked: false, error: '', lobby: true, buying: false };
    var CLOSES_LIFE = { dead: true, cashed: true };
    function lobbyClick() { if (!extra.lobbyLocked && typeof opts.onLobby === 'function') opts.onLobby(); }
    function againClick() { if (extra.again && !extra.again.disabled && typeof api.onAgain === 'function') api.onAgain(); }
    function watchClick() { if (!extra.lobbyLocked && extra.lobby && typeof opts.onSpectate === 'function') opts.onSpectate(); }
    function card() {
      var c = {}, k;
      for (k in cur) if (Object.prototype.hasOwnProperty.call(cur, k)) c[k] = cur[k];
      if (extra.error) c.notes = (c.notes || []).concat([extra.error]);
      var b = [];
      if (extra.lobby) b.push({ id: 'lobby', text: END.lobby, primary: !extra.again, disabled: extra.lobbyLocked, onClick: lobbyClick });
      if (extra.lobby && CLOSES_LIFE[api.kind] && typeof opts.onSpectate === 'function') {
        b.push({ id: 'watch', text: END.spectate, disabled: extra.lobbyLocked || extra.buying, onClick: watchClick });
      }
      if (extra.again) b.push({ id: 'again', text: extra.again.text || END.again, primary: true, disabled: extra.again.disabled === true, onClick: againClick });
      c.buttons = b;
      return c;
    }
    function render() { if (cur) D.show(card()); }
    function show(kind, fields, noLobby) {
      api.kind = kind;
      extra.again = null; extra.error = ''; extra.lobbyLocked = false; extra.buying = false;
      extra.lobby = noLobby !== true;
      cur = fields;
      render();
    }
    function setStatus(state, text, link) {
      if (!cur) return;
      cur.status = { text: text, state: state, link: link || null };
      render();
    }
    function facts(life) {
      if (!life) return undefined;
      var out = [];
      if (life.secs >= 0) out.push([END.time, D.clock(life.secs * 1000)]);
      if (life.score >= 0) out.push([END.score, D.int(life.score)]);
      return out;
    }
    // c:cashedout { grossMicro, cutMicro, netMicro, resumed?, auto? }
    api.showCashed = function (p, life) {
      p = p || {};
      var gross = Number(p.grossMicro) || 0, cut = Number(p.cutMicro) || 0;
      var net = p.netMicro !== undefined ? Number(p.netMicro) || 0 : gross - cut;
      show('cashed', {
        tone: 'win', verdict: p.auto === true ? END.autoCashed : END.cashed, hero: D.usd(net), unit: END.toWallet,
        facts: facts(life),
        ledger: [[END.gross, D.usd(gross)], [END.house, D.usd(-cut)], [END.net, D.usd(net)]],
        status: { text: p.resumed === true ? END.recorded : END.sending, state: 'pending' }
      });
    };
    // c:dead { lostMicro, by, ghost, score, secs }
    api.showDead = function (p) {
      p = p || {};
      var by = typeof p.by === 'string' && p.by ? p.by : '';
      show('dead', {
        tone: 'loss', verdict: p.ghost === true ? END.caught : by ? END.eatenBy(by) : END.eaten,
        hero: D.usd(-Math.max(0, Number(p.lostMicro) || 0)), unit: END.lost,
        facts: p.resumed === true ? undefined : facts({ secs: Number(p.secs) || 0, score: Number(p.score) || 0 }),
        notes: [END.deadNote]
      });
    };
    // c:closed { refundedMicro, why }
    api.showClosed = function (p) {
      p = p || {};
      var why = typeof p.why === 'string' ? p.why : '';
      var micro = Math.max(0, Number(p.refundedMicro) || 0);
      if (why === 'frozen-settled') { show('held', { tone: 'plain', verdict: END.heldTitle, notes: [END.held] }); return; }
      if (micro <= 0) { show('closed', { tone: 'plain', verdict: END.closedEmptyTitle, notes: [END.closedEmpty] }); return; }
      show('closed', { tone: 'plain', verdict: END.closedTitle, hero: D.usd(micro),
        notes: [why === 'shutdown' || why === 'crash' ? END.restart : END.closed] });
    };
    api.paid = function (sig, network) {
      if (typeof sig !== 'string' || !sig || !cur) return false;
      var q = network && network !== 'mainnet-beta' ? '?cluster=' + encodeURIComponent(network) : '';
      setStatus('ok', END.sent, { href: TX_URL + encodeURIComponent(sig) + q, text: END.view });
      return true;
    };
    api.payError = function (message) { setStatus('err', typeof message === 'string' && message ? message : END.delayed); };
    api.showMessage = function (kind, title, text, more) {
      var notes = [];
      if (text) notes.push(text);
      if (more) notes.push(more);
      show(kind === 'gone' ? 'gone' : 'refused', { tone: 'plain', verdict: title || '', notes: notes });
    };
    api.showWait = function (title, text, o) {
      show('wait', { tone: 'plain', verdict: title || '', status: { text: text || '', state: 'pending' } }, !(o && o.lobby === true));
    };
    api.setAgain = function (o) { extra.again = o ? { text: o.text || END.again, disabled: o.disabled === true } : null; render(); };
    api.setLobbyLocked = function (on) { extra.lobbyLocked = !!on; render(); };
    api.setBuying = function (on) { extra.buying = !!on; render(); };
    api.setError = function (text) { extra.error = typeof text === 'string' ? text : ''; render(); };
    api.hide = function () { cur = null; api.kind = ''; D.hide(); };
    api.shown = function () { return !!cur && D.shown(); };
    return api;
  }

  var DROP_MS = 5000;   // agLobby's: the server's own disconnect grace for a dropped paid seat

  function createLock(win) {
    win = win || root;
    var moneyIn = false, pageLock = false, dropTimer = null;
    function clearDrop() { if (dropTimer !== null) { win.clearTimeout(dropTimer); dropTimer = null; } }
    var api = {
      locked: function () { return moneyIn || pageLock; },
      setMoney: function (on) { clearDrop(); moneyIn = !!on; },
      setPage: function (on) { pageLock = !!on; },
      drop: function () {
        if (!moneyIn || dropTimer !== null) return;
        dropTimer = win.setTimeout(function () { dropTimer = null; moneyIn = false; }, DROP_MS);
      }
    };
    if (typeof win.addEventListener === 'function') {
      win.addEventListener('beforeunload', function (e) {
        if (!api.locked()) return undefined;
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (e) e.returnValue = '';
        return '';
      });
    }
    return api;
  }

  var HOLD_REPEAT_MS = 200;   // agar's page repeats {on: 1} this often (the server counts a hold 500 ms fresh)

  // o: { send(on) -> bool, can() -> bool (a live paid seat), win, tickMs }
  function createHold(o) {
    var win = o.win || root;
    var want = false, timer = null, ring = { on: false, t0: 0, need: 180 };
    function tick() {
      if (!want) return;
      if (o.can()) o.send(true);
      timer = win.setTimeout(tick, HOLD_REPEAT_MS);
    }
    return {
      press: function () {
        if (want || !o.can()) return;
        want = true;
        tick();
      },
      release: function () {
        if (!want) return;
        want = false;
        if (timer !== null) { win.clearTimeout(timer); timer = null; }
        o.send(false);
        ring.on = false;
      },
      wanted: function () { return want; },
      // c:holding { on, need }
      server: function (p) {
        if (p && p.on) { ring.on = true; ring.t0 = Date.now(); ring.need = Number(p.need) || 180; }
        else ring.on = false;
      },
      progress: function () {
        if (!ring.on || !want) return 0;
        return Math.min(1, (Date.now() - ring.t0) / (ring.need * (o.tickMs || 1000 / 60)));
      },
      since: function () { return ring.on ? Date.now() - ring.t0 : 0; },
      reset: function () { want = false; ring.on = false; if (timer !== null) { win.clearTimeout(timer); timer = null; } }
    };
  }

  root.ChompPaid = { handoff: handoff, LAUNCH_KEY: LAUNCH_KEY, RESUME_KEY: RESUME_KEY, createCard: createCard, createLock: createLock, createHold: createHold,
    WORDS: WORDS, REFUSED: REFUSED, END: END, DROP_MS: DROP_MS, available: !!AP && !!doc };
})(typeof window !== 'undefined' ? window : this);
