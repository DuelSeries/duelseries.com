// Per-life stats, the minimal name entry, and the agar.io adapter onto the shared end card and board for the agar.io
// redo. Our own code, written from the client-hud spec section 6 (per-life stats) and the build brief (facts 2.7,
// 2.21). The name entry on the card is ours (no settings block since 2026-10-15), in the DuelSeries look (client-hud 8:
// "our lobby styles may replace the menu shell").
// The end of a run (a death, a free or paid cash-out, a closed room, the paid hand-off's own states) and the in-game
// leaderboard are the shared DuelSeries ones (public/js/shared/dsEnd.js, global DSEnd; Owen 2026-10-16: "one cashout
// screen, one death screen and one leaderboard ... for all the games"). They replace the reference's "Match Results"
// panel and its canvas board, and the old paid end card. createEnd and createBoard below only map this game's numbers
// onto them: every amount is the server's own (micro-USDC through DSEnd.usd), every name goes in as text.
// Loads in the browser (DuelAgarLib.agScreens) and under node (the pure parts).
(function (root) {
  'use strict';
  var A = root.DuelAgarLib = root.DuelAgarLib || {};

  var fround = Math.fround;

  function ti(x) {
    return Math.abs(x) < 2147483648 ? (x | 0) : -2147483648;
  }

  // ---------------------------------------------------------------------------------------
  // Per-life stats (client-hud 6.1)
  // ---------------------------------------------------------------------------------------

  // Mass of one own cell for the score: floor(f32(f32(s*s) / 100)) on the PACKET size (fact 2.21), all in single
  // precision.
  function cellScoreMass(size) {
    var s = fround(size);
    var m = Math.floor(fround(fround(s * s) / 100));
    return ti(m);
  }

  // Where the own row sits on a board message (client-hud 5.1): position (1-based index of the
  // first own row) or 0, and the "onBoard" byte that drives leaderboard time (trap T5: it is 1
  // when the list is empty or has no own row).
  function boardPlace(rows) {
    var n = rows ? rows.length : 0;
    for (var i = 0; i < n; i++) {
      if (rows[i] && rows[i].me) return { position: i + 1, onBoard: i < 10 };
    }
    return { position: 0, onBoard: true };
  }

  function createLifeStats() {
    var st = {
      spawnTime: 0,
      foodEaten: 0,
      highestMass: 0,
      leaderTime: 0,
      cellsEaten: 0,
      virusesEaten: 0,
      topPosition: 0,
      onBoard: false,
      alive: false
    };

    // First own cell of a life (own list was empty): frame time.
    st.spawn = function (now) {
      st.spawnTime = now;
      st.alive = true;
    };

    // One processed eat (fact 2.7, protocol-semantics 3.2): counted only when an own cell eats
    // a node that is not own. e = { eaterOwn, eatenOwn, food, ejected (flag 0x20),
    // flag40 (0x40), virus }.
    st.eat = function (e) {
      if (!e || !e.eaterOwn || e.eatenOwn) return null;
      if (e.food) { st.foodEaten++; return 'food'; }
      if (e.ejected) {
        if (e.flag40) { st.foodEaten++; return 'food'; }
        if (e.virus) { st.virusesEaten++; return 'virus'; }
        return null;
      }
      if (e.virus) { st.virusesEaten++; return 'virus'; }
      st.cellsEaten++;
      return 'cell';
    };

    // Board message: best position this life and the onBoard byte.
    st.applyBoard = function (rows) {
      var p = boardPlace(rows);
      if (p.position) st.topPosition = st.topPosition ? Math.min(st.topPosition, p.position) : p.position;
      st.onBoard = p.onBoard;
      return p;
    };

    // End-of-frame bookkeeping (client-hud 6.1, HUD frame step 14): f = { spectating,
    // ownSizes: packet sizes of own cells, dt: ms since the previous drawn frame }.
    // Returns this frame's mass, or -1 when nothing was counted.
    st.frame = function (f) {
      if (f.spectating) return -1;
      var sizes = f.ownSizes || [];
      if (sizes.length === 0) return -1;
      if (st.onBoard) st.leaderTime = st.leaderTime + (f.dt || 0);
      var mass = 0;
      for (var i = 0; i < sizes.length; i++) mass = mass + cellScoreMass(sizes[i]);
      st.highestMass = mass < st.highestMass ? st.highestMass : mass;
      return mass;
    };

    // Zero everything this life counted. Runs at a death (after the snapshot) and in the
    // whole-client reset on every connect and disconnect (client-camera-input 2), so a life
    // never starts from the previous connection's numbers.
    st.reset = function () {
      st.spawnTime = 0;
      st.foodEaten = 0;
      st.highestMass = 0;
      st.leaderTime = 0;
      st.cellsEaten = 0;
      st.virusesEaten = 0;
      st.topPosition = 0;
      st.onBoard = false;
      st.alive = false;
    };

    // This life so far, for an end card that shows before the death (a paid ag:dead or ag:cashedout can arrive
    // first): the same fields as the death snapshot.
    st.now = function (now) {
      return { timeAlive: now - st.spawnTime, highestMass: st.highestMass, topPosition: st.topPosition };
    };

    // Death: a snapshot for the end card, then the death-time board refresh (rows = the last board) and the reset of
    // everything this life counted.
    st.death = function (now, rows) {
      var snap = {
        foodEaten: st.foodEaten,
        highestMass: st.highestMass,
        timeAlive: now - st.spawnTime,
        leaderTime: st.leaderTime,
        cellsEaten: st.cellsEaten,
        topPosition: st.topPosition,
        virusesEaten: st.virusesEaten
      };
      if (rows) st.applyBoard(rows);
      st.reset();
      return snap;
    };
    return st;
  }

  // Layout facts of the menu card (client-hud 6.3), used by the stylesheet below and the tests.
  var LAYOUT = {
    card: { width: 325, height: 302, radius: 10, padding: 10 },
    nickMax: 15,
    menuFit: { width: 1600, height: 800 }
  };

  // The drawing values every agar.io page uses, which are the reference's defaults: names on,
  // colours on, show mass off, dark off, quality "Retina". HARD-WIRED (Owen 2026-10-15: "just get
  // rid of all the settings, I don't need any of them"): there is no settings block any more, on
  // this card or in the lobby, and nothing stored can change them (agMain).
  var SETTINGS_DEFAULTS = { names: true, colors: true, showMass: false, dark: false, quality: 'Retina' };

  // Menu scale (client-hud 6.3): min(1, innerWidth/1600, h/800), h = the window height above the
  // bottom strip (real or ghost; agMain passes it).
  function menuScale(w, h) {
    return Math.min(1, w / LAYOUT.menuFit.width, h / LAYOUT.menuFit.height);
  }

  // Our stylesheet. Two kinds of rules:
  // - the menu card's facts (client-hud 6.3): the menu box placement, the font and the text colour, the card
  //   (#ag-card: white, radius 10, 325 x 302, margin 5px 0, padding 10) and the button base.
  // - CHOSEN, ours (client-hud 8: our lobby styles may replace the menu shell): the name entry,
  //   and its buttons (#ag-name and everything in it), in the DuelSeries
  //   colours: ink #100e0b, bone #f5f1e8, line #d6cdbd, label #6f6556 and the product's amber
  //   #f0a830 on Play only. No colour or size of the reference's own menu is used there.
  //   The name entry is centred in the card's fixed 280 px: title 40, name 40, Play 8 + 40,
  //   Spectate 8 + 32 = 168. The settings block and the Sound button that filled the rest are
  //   gone (Owen 2026-10-15).
  var SCREENS_CSS = [
    '#ag-menu{position:fixed;left:50%;top:45%;transform:translate(-50%,-50%);z-index:20;font-family:Arial,sans-serif;color:#343434;}',
    '#ag-menu[hidden]{display:none;}',
    // The reference menu box (client-hud 6.3): 985 x 600 at top 45%, the 325 px card at the top
    // of its middle column, 330 = (985 - 325) / 2. Mouse screens only: phones keep the bare card.
    '@media not all and (pointer: coarse){#ag-menu{width:985px;height:600px;box-sizing:border-box;padding:0 330px;}}',
    '#ag-card{position:relative;background-color:#fff;border-radius:10px;margin:5px 0;width:325px;height:302px;box-sizing:content-box;}',
    '#ag-card .ag-play-container{position:relative;padding:10px;}',
    '.ag-btn{display:inline-block;margin-bottom:0;font-size:15px;font-weight:bold;line-height:1.42857143;text-align:center;white-space:nowrap;vertical-align:middle;touch-action:manipulation;cursor:pointer;user-select:none;background-image:none;border:1px solid transparent;border-radius:4px;font-family:Arial,sans-serif;}',
    // ---- ours (CHOSEN) ----
    '#ag-name{position:relative;height:280px;box-sizing:border-box;padding-top:52px;text-align:center;color:#100e0b;font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;}',
    '#ag-name h2{margin:2px 0 8px;font-size:28px;line-height:30px;font-weight:800;letter-spacing:-0.02em;}',
    '#ag-nick{display:block;box-sizing:border-box;width:100%;height:40px;margin:0;padding:0 12px;border:1px solid #d6cdbd;border-radius:8px;background:#f5f1e8;color:#100e0b;font-family:inherit;font-size:16px;font-weight:600;}',
    '#ag-nick::placeholder{color:#6f6556;font-weight:400;}',
    '#ag-nick:focus{outline:2px solid #100e0b;outline-offset:2px;background:#fff;}',
    '#ag-name .ag-btn{font-family:inherit;line-height:1;border-radius:8px;}',
    '#ag-play{display:block;box-sizing:border-box;width:100%;height:40px;margin:8px 0 0;padding:0;border:0;background:#f0a830;color:#100e0b;font-size:17px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;}',
    '#ag-play:hover{background:#f4b955;}',
    '#ag-play:active{transform:translateY(1px);}',
    '#ag-name .ag-row{display:flex;gap:8px;margin-top:8px;}',
    '#ag-spectate{display:block;flex:1 1 0;box-sizing:border-box;width:auto;min-width:0;height:32px;margin:0;padding:0 8px;border:1px solid #d6cdbd;background:#fff;color:#100e0b;font-size:14px;font-weight:600;}',
    '#ag-spectate:hover{background:#f5f1e8;}',
    '#ag-name button:focus-visible{outline:2px solid #100e0b;outline-offset:2px;}'
  ].join('\n');

  // ---------------------------------------------------------------------------------------
  // DOM: the menu card with the name entry (a direct visit to /ag and the parity harness; the lobby frame's page has
  // no menu card: the lobby's agar.io screen holds the name, the buy-in and Spectate, Owen 2026-10-09 midday)
  // ---------------------------------------------------------------------------------------

  // opts: { doc, root (where to append; default body), onPlay(name), onSpectate(), injectCss (default true) }
  function createScreens(opts) {
    opts = opts || {};
    var doc = opts.doc || root.document;
    var host = opts.root || doc.body;
    if (opts.injectCss !== false && !doc.getElementById('ag-screens-css')) {
      var style = doc.createElement('style');
      style.id = 'ag-screens-css';
      style.textContent = SCREENS_CSS;
      (doc.head || host).appendChild(style);
    }

    function el(tag, attrs, text) {
      var e = doc.createElement(tag);
      if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      return e;
    }

    var menu = el('div', { id: 'ag-menu' });
    var card = el('div', { id: 'ag-card' });
    var pc = el('div', { 'class': 'ag-play-container' });
    card.appendChild(pc);
    menu.appendChild(card);

    // Name entry (HOME). No settings and no Sound button (Owen 2026-10-15): the drawing values are SETTINGS_DEFAULTS
    // and sound is always on.
    var namePanel = el('div', { id: 'ag-name' });
    namePanel.appendChild(el('h2', null, 'agar.io'));
    var nick = el('input', { id: 'ag-nick', type: 'text', maxlength: String(LAYOUT.nickMax), placeholder: 'Nick', autocomplete: 'off', spellcheck: 'false' });
    namePanel.appendChild(nick);
    var playBtn = el('button', { id: 'ag-play', type: 'button', 'class': 'ag-btn' }, 'Play');
    namePanel.appendChild(playBtn);
    var row = el('div', { 'class': 'ag-row' });
    var specBtn = el('button', { id: 'ag-spectate', type: 'button', 'class': 'ag-btn' }, 'Spectate');
    row.appendChild(specBtn);
    namePanel.appendChild(row);
    pc.appendChild(namePanel);
    host.appendChild(menu);

    var api = {
      menu: menu,
      nick: nick,
      isOpen: function () { return !menu.hidden; },
      state: 'HOME'
    };

    function focusNick() {
      try { nick.focus(); } catch (e) { /* focus can fail on hidden or detached nodes */ }
    }
    // HOME: name entry and Play.
    api.showHome = function () {
      api.state = 'HOME';
      menu.hidden = false;
      focusNick();
    };
    api.hide = function () {
      menu.hidden = true;
    };
    // Menu box scale (client-hud 6.3), set by agMain on start-up, resize and quality changes.
    api.setScale = function (k) {
      menu.style.transform = 'translate(-50%, -50%)' + (k !== 1 ? ' scale(' + k + ')' : '');
    };
    api.setNick = function (name) { nick.value = String(name || '').slice(0, LAYOUT.nickMax); };

    function play() {
      var name = String(nick.value || '').slice(0, LAYOUT.nickMax);
      api.state = 'PLAY';
      api.hide();
      if (opts.onPlay) opts.onPlay(name);
    }
    playBtn.addEventListener('click', play);
    nick.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); play(); }
    });
    specBtn.addEventListener('click', function () {
      api.state = 'SPECTATE';
      api.hide();
      if (opts.onSpectate) opts.onSpectate();
    });
    return api;
  }

  // ---------------------------------------------------------------------------------------
  // The end card (the shared DSEnd card): free deaths and cash-outs, and every paid state (PAID-AGAR-DESIGN 6, and
  // the paid hand-off's own states from agPaid). One card at a time; each state replaces the last.
  // ---------------------------------------------------------------------------------------

  var HOUSE_CUT_PCT = 10;   // server/paperPayout.js: the house keeps floor(gross / 10), Owen's 90/10
  var TX_URL = 'https://solscan.io/tx/';   // Paper's explorer link (public/js/paper/mp/paperArenaMain.js pp:paid)
  // Texts. The free and money lines are Owen's (2026-10-16 card numbers); the notices keep the game's own wording.
  var END_TEXT = {
    eaten: 'Eaten',
    eatenBy: function (name) { return 'Eaten by ' + name; },
    cashed: 'Cashed out',
    autoCashed: 'Cashed out automatically',
    mass: 'mass',               // the free hero's unit
    lost: 'lost',
    toWallet: 'to your wallet',
    time: 'Time',
    topRank: 'Top rank',
    score: 'Mass',
    // agar.io's kill stat (Owen 2026-10-16 asked for kills): other players' cells this life ate, from the server's eats
    cellsEaten: 'Cells eaten',
    gross: 'Cashed out',
    house: 'House ' + HOUSE_CUT_PCT + '%',
    net: 'You receive',
    sending: 'Sending to your wallet',
    recorded: 'Your payout is recorded and goes to your wallet.',
    sent: 'Sent to your wallet.',
    view: 'View transaction',
    delayed: 'Payout delayed. Your winnings are recorded and will be sent.',
    // ag:closed by its why (server/ag/agRoom.js _paidClosed, agMoney emergencySettle / shutdownSettle / houseSettle)
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
    menu: 'Menu'
  };
  var PAID_KINDS = { cashed: true, dead: true, closed: true, held: true, refused: true, gone: true, wait: true };

  // The facts row from this life's numbers (a stats snapshot or stats.now): Time, Top rank (left out when the player
  // was never on the board), and on a paid card the score. null (a resumed receipt after a reload: this page never
  // saw the life) gives no facts.
  function lifeFacts(D, life, withScore) {
    if (!D || !life || typeof life !== 'object') return [];
    var out = [[END_TEXT.time, D.clock(life.timeAlive)]];
    if (life.topPosition > 0) out.push([END_TEXT.topRank, D.ordinal(life.topPosition)]);
    if (withScore) out.push([END_TEXT.score, D.int(Math.floor(Number(life.highestMass) || 0))]);
    if (typeof life.cellsEaten === 'number' && life.cellsEaten >= 0) out.push([END_TEXT.cellsEaten, D.int(life.cellsEaten)]);
    return out;
  }

  // A page without the component (the parity harness loads no dsEnd.js): every state is a no-op.
  function noEnd() {
    var api = { kind: '', onAgain: null, life: null };
    ['showFree', 'showCashed', 'showDead', 'showClosed', 'payError', 'showMessage', 'showWait', 'setAgain',
      'setLobbyLocked', 'setBuying', 'setError', 'setLife', 'hide'].forEach(function (k) { api[k] = function () {}; });
    api.paid = function () { return false; };
    api.shown = function () { return false; };
    api.paidKind = function () { return ''; };
    api.button = function () { return null; };
    return api;
  }

  // opts: { DSEnd (the component; none = nothing is shown), root (default body), onLobby(), onSpectate() (the paid
  //         card's Spectate: agMain's paid watch path), z, win (the window whose height the card must fit) }
  // -> the card's states (below), plus onAgain (the paid flow's Play again, set by agMain), kind, shown(), hide().
  // A card that closes a life (a death or a cash-out, free or paid) has the same three buttons in every game (Owen
  // 2026-10-16): Lobby, Spectate, Play again. The free card gets them from the page (showFree); a paid death or
  // cash-out builds them here: Lobby, Spectate (shut exactly when Lobby is), and Play again once the paid flow offers
  // it (setAgain). The notices (refused, gone, closed, held, the wait) keep Lobby alone.
  function createEnd(opts) {
    opts = opts || {};
    var D = opts.DSEnd || null;
    if (!D) return noEnd();
    var handle = null;
    // what the card shows: the state's own fields, and the paid flow's Play again, lock and error line
    var cur = null;
    var extra = { again: null, lobbyLocked: false, error: '', lobby: true };
    var api = { kind: '', onAgain: null, life: null };

    function lobbyClick() {
      if (extra.lobbyLocked) return;
      if (typeof opts.onLobby === 'function') opts.onLobby();
    }
    function againClick() {
      if (!extra.again || extra.again.disabled) return;
      if (typeof api.onAgain === 'function') api.onAgain();
    }
    // Spectate leaves this page like Lobby does, so it is shut whenever Lobby is (a Play again buy-in with the wallet).
    function watchClick() {
      if (extra.lobbyLocked || !extra.lobby) return;
      if (typeof opts.onSpectate === 'function') opts.onSpectate();
    }
    var CLOSES_LIFE = { dead: true, cashed: true };
    function card() {
      var c = {}, k;
      for (k in cur) if (Object.prototype.hasOwnProperty.call(cur, k)) c[k] = cur[k];
      if (api.life && cur.lifeScore !== undefined) c.facts = lifeFacts(D, api.life, cur.lifeScore);
      delete c.lifeScore;
      if (extra.error) c.notes = (c.notes || []).concat([extra.error]);
      if (!c.buttons) {
        // Lobby on the left, Spectate in the middle, Play again on the right (dsEnd keeps that order too)
        var b = [];
        if (extra.lobby) b.push({ id: 'lobby', text: END_TEXT.lobby, primary: !extra.again, disabled: extra.lobbyLocked, onClick: lobbyClick });
        if (extra.lobby && CLOSES_LIFE[api.kind] && typeof opts.onSpectate === 'function') {
          b.push({ id: 'watch', text: END_TEXT.spectate, disabled: extra.lobbyLocked || extra.buying, onClick: watchClick });
        }
        if (extra.again) b.push({ id: 'again', text: extra.again.text || END_TEXT.again, primary: true, disabled: extra.again.disabled === true, onClick: againClick });
        c.buttons = b;
      }
      if (opts.z != null) c.z = opts.z;
      if (opts.root) c.root = opts.root;
      return c;
    }
    // A short window (a phone held sideways) is fitted by the component itself (dsEnd fit).
    function render() {
      if (!D || !cur) return;
      handle = D.show(card());
    }
    // A new state: its fields; every state starts with no Play again, no error line and Lobby open (noLobby: a wait
    // that may already hold the player's money has no Lobby).
    function show(kind, fields, life, noLobby) {
      api.kind = kind;
      api.life = life || null;
      extra.again = null;
      extra.error = '';
      extra.lobbyLocked = false;
      extra.buying = false;
      extra.lobby = noLobby !== true;
      cur = fields;
      render();
    }
    function setStatus(state, text, link) {
      if (!cur) return;
      cur.status = { text: text, state: state, link: link || null };
      render();
    }

    // ---- free ----
    // o: { life (the death snapshot), by (the eater's name, '' when unknown), cashed (a free cash-out), buttons }
    api.showFree = function (o) {
      o = o || {};
      var life = o.life || {};
      show('free', {
        tone: 'plain',
        verdict: o.cashed ? END_TEXT.cashed : (o.by ? END_TEXT.eatenBy(o.by) : END_TEXT.eaten),
        hero: D.int(Math.floor(Number(life.highestMass) || 0)),
        unit: END_TEXT.mass,
        lifeScore: false,
        buttons: o.buttons || []
      }, life);
    };

    // ---- paid (display only: every figure is the server's own) ----
    // ag:cashedout { grossMicro, cutMicro, netMicro, resumed?, auto? }. A resumed receipt (agPaidDoor answerOutcome:
    // the page asked again after the payout was ordered) gets no ag:paid later, so its line says the payout is
    // recorded instead of waiting on one.
    api.showCashed = function (p, life) {
      p = p || {};
      var gross = Number(p.grossMicro) || 0, cut = Number(p.cutMicro) || 0;
      var net = p.netMicro !== undefined ? Number(p.netMicro) || 0 : gross - cut;
      show('cashed', {
        tone: 'win',
        verdict: p.auto === true ? END_TEXT.autoCashed : END_TEXT.cashed,
        hero: D.usd(net),
        unit: END_TEXT.toWallet,
        lifeScore: true,
        ledger: [[END_TEXT.gross, D.usd(gross)], [END_TEXT.house, D.usd(-cut)], [END_TEXT.net, D.usd(net)]],
        status: { text: p.resumed === true ? END_TEXT.recorded : END_TEXT.sending, state: 'pending' }
      }, life);
    };
    // ag:dead { lostMicro, by }
    api.showDead = function (p, life) {
      p = p || {};
      var by = typeof p.by === 'string' && p.by ? p.by : '';
      show('dead', {
        tone: 'loss',
        verdict: by ? END_TEXT.eatenBy(by) : END_TEXT.eaten,
        hero: D.usd(-Math.max(0, Number(p.lostMicro) || 0)),
        unit: END_TEXT.lost,
        lifeScore: true
      }, life);
    };
    // ag:closed { refundedMicro, why }. 'emergency' (the room stopped), 'shutdown' and 'crash' (a restart: owed refund
    // rows the drainer pays once the server is back): Owen Q6, 100% back, no rake. 'frozen-settled' (the zombie
    // backstop, design 3.4 step 5): the balance went to the house as agar_breach for a refund by hand, so it is never
    // called a refund here. A zero amount (nothing left, or a seat whose account is still settling) shows no figure.
    api.showClosed = function (p) {
      p = p || {};
      var why = typeof p.why === 'string' ? p.why : '';
      var micro = Math.max(0, Number(p.refundedMicro) || 0);
      if (why === 'frozen-settled') {
        show('held', { tone: 'plain', verdict: END_TEXT.heldTitle, notes: [END_TEXT.held] });
        return;
      }
      if (micro <= 0) {
        show('closed', { tone: 'plain', verdict: END_TEXT.closedEmptyTitle, notes: [END_TEXT.closedEmpty] });
        return;
      }
      show('closed', { tone: 'plain', verdict: END_TEXT.closedTitle, hero: D.usd(micro),
        notes: [why === 'shutdown' || why === 'crash' ? END_TEXT.restart : END_TEXT.closed] });
    };
    // ag:paid { sig }: the payout landed; the link opens the explorer (network: a cluster other than mainnet).
    api.paid = function (sig, network) {
      if (typeof sig !== 'string' || !sig || !cur) return false;
      var q = network && network !== 'mainnet-beta' ? '?cluster=' + encodeURIComponent(network) : '';
      setStatus('ok', END_TEXT.sent, { href: TX_URL + encodeURIComponent(sig) + q, text: END_TEXT.view });
      return true;
    };
    // ag:payerror { message }: the payout is recorded as owed and the drainer sends it.
    api.payError = function (message) {
      setStatus('err', typeof message === 'string' && message ? message : END_TEXT.delayed);
    };
    // The paid hand-off's own states (agPaid): a refusal or an ended seat (kind 'refused' or 'gone': a title, a plain
    // line, an optional second line such as the refund, and Lobby), and the wait while joining or getting a seat back
    // (kind 'wait': the pending dot and its line; Lobby only when o.lobby says so, because a join in flight may already
    // hold the player's money).
    api.showMessage = function (kind, title, text, more) {
      var notes = [];
      if (text) notes.push(text);
      if (more) notes.push(more);
      show(kind === 'gone' ? 'gone' : 'refused', { tone: 'plain', verdict: title || '', notes: notes });
    };
    api.showWait = function (title, text, o) {
      show('wait', { tone: 'plain', verdict: title || '', status: { text: text || '', state: 'pending' } }, null,
        !(o && o.lobby === true));
    };
    // Play again: o = { text, disabled } shows it (Lobby turns into the quiet button on the left); null hides it.
    api.setAgain = function (o) {
      extra.again = o ? { text: o.text || END_TEXT.again, disabled: o.disabled === true } : null;
      render();
    };
    // Spectate shut for the whole Play again buy-in, slow or not (a stake that lands late needs this page in the frame).
    api.setBuying = function (on) {
      extra.buying = on === true;
      render();
    };
    // Lobby shut while a Play again buy-in is with the lobby's wallet (Paper's lockLobby).
    api.setLobbyLocked = function (locked) {
      extra.lobbyLocked = locked === true;
      render();
    };
    // A restake's error or wait line (agPaid: the lobby wallet's answer to Play again).
    api.setError = function (text) {
      extra.error = text || '';
      render();
    };
    // The life's final numbers (the world's death after a paid ag:dead or ag:cashedout already showed the card).
    api.setLife = function (life) {
      if (!cur || cur.lifeScore === undefined || !life) return;
      api.life = life;
      render();
    };
    api.hide = function () {
      cur = null;
      api.kind = '';
      api.life = null;
      if (D) D.hide();
    };
    api.shown = function () { return !!(cur && D && D.shown()); };
    api.paidKind = function () { return PAID_KINDS[api.kind] ? api.kind : ''; };
    // The card's button element by id ('again', 'watch', 'lobby', 'menu'), for the page's tests and probes.
    api.button = function (id) { return api.shown() && handle ? handle.button(id) : null; };
    return api;
  }

  // ---------------------------------------------------------------------------------------
  // The in-game leaderboard (the shared DSEnd board): the free room's rows from the world's board message (the
  // reference's board: names in rank order, no figures), the paid room's from ag:money (design 6: names and their
  // money, so names and amounts cannot drift). Built on the first rows; shown only while playing or watching with no
  // end card up (agMain sync).
  // ---------------------------------------------------------------------------------------

  var UNNAMED = 'An unnamed cell';   // the reference's placeholder for a nameless cell (client-hud 5.1)
  var BOARD_ROWS = 10;
  var BOARD_ROWS_SHORT = 5;          // a short screen (a phone held sideways) keeps the board clear of the phone pad

  // opts: { DSEnd, root, z, short() -> true on a short screen }
  function createBoard(opts) {
    opts = opts || {};
    var D = opts.DSEnd || null;
    var b = null, money = false;
    var data = { rows: [], me: null };
    var want = false;
    var api = { visible: false, money: false };

    function cap() {
      var s = false;
      try { s = typeof opts.short === 'function' && opts.short() === true; } catch (e) { s = false; }
      return s ? BOARD_ROWS_SHORT : BOARD_ROWS;
    }
    function ensure(m) {
      if (!D) return null;
      if (b && money === m) return b;
      if (b) b.destroy();
      money = m;
      api.money = m;
      var o = { money: m, title: 'Leaderboard', light: true };   // agar's map is light: ink text (dsEnd light)
      if (opts.z != null) o.z = opts.z;
      if (opts.root) o.root = opts.root;
      b = D.board(o);
      b.hide();
      api.visible = false;
      return b;
    }
    function draw() {
      if (!b) return;
      b.set(data.rows.slice(0, cap()), data.me);
      sync();
    }
    function sync() {
      if (!b) return;
      var on = want && data.rows.length > 0;
      if (on === api.visible) return;
      api.visible = on;
      if (on) b.show(); else b.hide();
    }
    // The world's board message (mirror { t: 'board', rows }): the own row ("me") shows the local nickname. Ignored
    // once ag:money drives the board.
    api.setFree = function (rows, nick) {
      if (money && b) return;
      var list = [], me = null;
      var n = rows ? rows.length : 0;
      for (var i = 0; i < n; i++) {
        var r = rows[i] || {};
        var mine = !!r.me;
        var name = mine ? String(nick || '') : (typeof r.name === 'string' ? r.name : '');
        if (!name) name = UNNAMED;
        var rank = (r.rank | 0) > 0 ? r.rank | 0 : i + 1;
        // the score beside each name (Owen 2026-10-16), the server's mass, right-aligned by the shared board
        var value = typeof r.score === 'number' && r.score >= 0 && r.score % 1 === 0 ? String(r.score) : '';
        if (list.length < BOARD_ROWS) list.push({ rank: rank, name: name, value: value, me: mine });
        if (mine && !me) me = { rank: rank, name: name, value: value };
      }
      if (!ensure(false)) return;
      data = { rows: list, me: me };
      draw();
    };
    // ag:money { me, rank, board: [[name, micro], ...] }: rows by money, the own balance and rank.
    api.setMoney = function (m, nick) {
      if (!m || typeof m !== 'object') return;
      if (!ensure(true)) return;
      var rows = Array.isArray(m.board) ? m.board : [];
      var rank = (m.rank | 0) > 0 ? m.rank | 0 : 0;
      var list = [];
      for (var i = 0; i < rows.length && list.length < BOARD_ROWS; i++) {
        var r = Array.isArray(rows[i]) ? rows[i] : [];
        list.push({ rank: i + 1, name: typeof r[0] === 'string' && r[0] ? r[0] : UNNAMED, value: D.usd(Math.max(0, Number(r[1]) || 0)), me: i + 1 === rank });
      }
      var meName = rank > 0 && rank <= rows.length && Array.isArray(rows[rank - 1]) && rows[rank - 1][0] ? rows[rank - 1][0] : (nick || UNNAMED);
      data = { rows: list, me: rank > 0 ? { rank: rank, name: meName, value: D.usd(Math.max(0, Number(m.me) || 0)) } : null };
      draw();
    };
    // The whole-client reset on every connect and disconnect: the rows (and the money) belong to the old connection.
    api.clear = function () {
      data = { rows: [], me: null };
      if (b) b.set([], null);
      if (b && money) { b.destroy(); b = null; money = false; api.money = false; api.visible = false; }
      sync();
    };
    // Shown only while the page plays or watches with no end card up (agMain, every frame; a change writes once).
    api.sync = function (on) {
      want = on === true;
      sync();
    };
    api.rows = function () { return data.rows.slice(); };
    api.me = function () { return data.me; };
    api.element = function () { return b ? b.el : null; };
    return api;
  }

  var agScreens = {
    END_TEXT: END_TEXT,
    UNNAMED: UNNAMED,
    HOUSE_CUT_PCT: HOUSE_CUT_PCT,
    TX_URL: TX_URL,
    createEnd: createEnd,
    createBoard: createBoard,
    lifeFacts: lifeFacts,
    cellScoreMass: cellScoreMass,
    boardPlace: boardPlace,
    createLifeStats: createLifeStats,
    LAYOUT: LAYOUT,
    SETTINGS_DEFAULTS: SETTINGS_DEFAULTS,
    menuScale: menuScale,
    SCREENS_CSS: SCREENS_CSS,
    createScreens: createScreens
  };
  A.agScreens = agScreens;
  if (typeof module !== 'undefined' && module.exports) module.exports = agScreens;
})(typeof window !== 'undefined' ? window : globalThis);
