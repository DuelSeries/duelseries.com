// DuelSeries layer on the frozen slither.io client: the results card (Owen Q11; SERVER-DESIGN 15.3 "Results card";
// task T17). Ours, not a parity area. Drawn by the shared end screen every game uses (public/js/shared/dsEnd.js,
// Owen 2026-10-16: one cash-out, death and leaderboard for all the games), loaded before the slx tail by slBoot.
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20): no node, no listener, no style.
//
// When: their menu shows the first frame 1600 ms after dead_mtm (public/js/sl/slHud.js:210-216), relayed by slxMain as
// 'menuShow'. The card then follows their login layer: opacity 1 - login_fr on every 'menuFade' (their death fade
// in, slHud.js:217-233; their 500 ms start fade out, slHud.js:170-193), and it is taken away when the start fade ends
// (fr 1). So it appears with their menu and leaves when the next life starts.
//
// What it says:
//   a death              'Killed by NAME' (the kill feed's {t: 'kill'} naming this snake), else 'You died'
//   a cash-out           'Cashed out'; sl:x {t: 'cashed'} came before `dead`
//   a close mid-life     'Connection lost', or 'Too slow' when the server itself disconnected the socket with no
//                        refusal (its stall and cap kicks, server/sl/slSendQueue.js kick)
//   the big figure is the final length, N read from THEIR last-score line, which their gameOver writes on the death
//   and the close path alike (slHud.js:305-310, slApply.js:1252-1262, 1300-1320); under it Time (from the own snake's
//   add to its death, on the page clock) and Top rank (their best_rank this connection, slApply.js:768, kept during
//   the life: their resetGame clears it before their menu shows).
// Refusals never reach their menu (a refused socket closes before any life, so dead_mtm is never set,
// slApply.js:1252-1262): the card shows at once from the close, titled by the refusal's why
// (server/sl/slSockets.js REFUSALS).
//
// Buttons (Owen 2026-10-16: "a Lobby, Spectate and Play again button exactly the same on every single cash-out and
// death screen, including the paid ones"): a card that closes a life (a death, a cash-out) has exactly Lobby, Spectate
// and Play again, in that order, on dsEnd's one row; any other card (a refusal, a connection lost, a layer's notice or
// a watcher's own card) keeps Lobby and its own next step.
//   Play again calls their Play (DuelSlither.play) under the name the first Play used (the lobby name, or the
//   direct-visit box); their loop connects only once their fade ended (slLoop.js:612), so the button says "Starting"
//   until the card goes. Lobby posts game:done to the lobby frame (slx.toLobby); a direct visit opens the lobby page.
//   Spectate goes only where Lobby would (the layer's beforeLobby asked first: a paid page's exit trap refuses both
//   alike while money is in) and never while a Play is starting. A layer that watches in place takes it (beforeWatch:
//   the battle royale's match); else the page reopens watching exactly as the lobby's Spectate opens it (slxWatch
//   watchOpen: the free room, or a paid page's own rung, read only).
// A click or tap on the card never reaches their boost or steering (dsEnd stops it at the card).
//
// The layers' hook (slxPaid, slxBr, slxWatch set it; a free page sets none, and the card is exactly as above). Each is
// read at the moment it is needed, and a throw in one is counted (slx.errors) and ignored:
//   slx.cardLines(kind) -> null, or { title, lines, again, length, tone, hero, unit, ledger, status, podium, facts }:
//     title in place of the card's own; lines under the money (each a string or { text }; text only, never markup);
//     again: false leaves Play again off (unpressable instead on a card that closes a life), a string is its label,
//     { text, disabled } its label and state; spectate: false keeps the card's own buttons (a watcher's card, a
//     notice: no Spectate); length: false
//     leaves the length off (a watcher's card: the length was not theirs); tone/hero/unit the big figure (a paid
//     page's money, '1st' for a battle royale win), then the length moves into the facts; ledger [[label, value]] the
//     money rows; status { text, state } the payout line; podium [{ rank, name, me }]; facts in place of the card's.
//     Read when the card shows and on refresh() (the cash-out status coming in).
//   slx.beforeAgain(go) -> true when the layer takes Play again over (a paid page buys a new entry first, then calls
//     go(), which starts the play as the button does and answers whether it did).
//   slx.beforeLobby() -> true when the layer keeps the page here (its exit trap: money is still in the room). Asked
//     for Spectate too: it leaves this life's room just as Lobby does.
//   slx.beforeWatch(go) -> true when the layer watches on this page itself (slxBr: the match), then calls go(), which
//     starts the next life as Play again does. Else slx.watchOpen(rung) (slxWatch) reopens the page watching.
// slx.card.notice(kind) shows the card with no life behind it (the paid notices at boot), titled by cardLines(kind).
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var doc = root.document;
  var S = D.S;
  var E = root.DSEnd;
  if (!doc || !S || !E || typeof slx.on !== 'function') return;

  var TITLE = {
    dead: 'You died',
    cashed: 'Cashed out',
    lost: 'Connection lost',
    slow: 'Too slow',
    full: 'Room full',
    maintenance: 'Maintenance',
    closed: 'Closed',
    'not-open': 'Closed',
    limit: 'Too many players on this network',
    flood: 'Connection lost',
    match: 'Match under way',
    twice: 'Already in this match',
    nobody: 'Nothing to watch'
  };
  var KILLED_BY = 'Killed by ';
  var LENGTH = 'length';
  var BTN = { again: 'Play again', retry: 'Try again', starting: 'Starting', lobby: 'Lobby', spectate: 'Spectate' };
  // The kinds of a card that closes a life, with the three buttons (the others in TITLE are notices).
  var END_KINDS = { dead: true, cashed: true };
  // socket.io's reason when the server called socket.disconnect() (socket.io-client: 'io server disconnect').
  var SERVER_DROP = 'io server disconnect';
  var NO_RANK = 999999999;                       // their best_rank before any leaderboard (slApply.js:146)
  // Their page is laid out at 0.7 on a phone (sl.html:4 initial-scale 0.7, honoured where their is_mobile is): the
  // card is drawn back up to the size it has on every other game's page. A frame ignores the viewport line; the
  // lobby draws its frame at 0.7 on a phone itself, and slxMain's layoutZoom() measures which a frame is.
  var ZOOM = typeof slx.layoutZoom === 'function' ? slx.layoutZoom() : S.is_mobile && slx.framed !== true ? 1 / 0.7 : 1;
  var Z = 30;                                    // above their login layer (z-index 20)
  // Their last-score line stays in the page (the length is read from it) but is not shown: the card says it.
  if (S.lastscore && S.lastscore.style) S.lastscore.style.visibility = 'hidden';

  // ---- per socket: what the tap saw (slxNet fires 'open' for each socket that opened)
  var life = newLife();
  var lastReason = '';
  var connectWhy = '';                           // the why of a refused handshake (slSockets admit: {why: 'limit'})
  var shown = '';                                // '' or the kind on the card
  var lifeCard = false;                          // the card ends a life (Play again), else a refusal (Try again)
  var starting = false;
  var extra = null;                              // the hook's answer for the card on screen
  var score = null;                              // the length on the card, or null
  var opacity = 1;
  var view = null;                               // what was last drawn, for state()
  var card = null;                               // dsEnd's card handle

  function newLife() {
    return { cashed: false, dead: false, pending: '', noLength: false, born: 0, died: 0, killer: '', rank: 0, kills: 0 };
  }
  // Their best_rank as the life ends: their resetGame puts it back to NO_RANK when the socket closes
  // (slApply.js:1267-1280, from applyClose or slLoop.js:621-628), which can be before their menu shows.
  function keepRank() {
    if (S.best_rank > 0 && S.best_rank < NO_RANK) life.rank = S.best_rank;
  }
  // The page clock the other layer files time with (slxNet slx.now, performance.now): Time never jumps with the wall
  // clock.
  function now() { return typeof slx.now === 'function' ? slx.now() : Date.now(); }

  // The number in their last-score line: '<span ...>WORDS </span><b>N</b>' (slHud.js:305-310). null when absent.
  function lastscoreNumber() {
    var ls = S.lastscore;
    if (!ls) return null;
    var m = /<b>\s*([0-9]+)\s*<\/b>/i.exec(String(ls.innerHTML));
    return m ? Number(m[1]) : null;
  }

  // The name the last Play used: their Play keeps it (slMain.nick, public/js/sl/slMain.js:94-101), whether the lobby
  // hand-off (slxMain) or the direct-visit box (slxDirect) gave it.
  function nick() {
    var m = D.slMain;
    return m && typeof m.nick === 'string' ? m.nick : '';
  }

  function hookLines(kind) {
    if (typeof slx.cardLines !== 'function') return null;
    try {
      var x = slx.cardLines(kind);
      return x && typeof x === 'object' ? x : null;
    } catch (e) {
      slx.errors++;
      return null;
    }
  }

  // A card that closes a life (a death, a cash-out) that no layer keeps to its own buttons: Lobby, Spectate and
  // Play again.
  function endCard() {
    return lifeCard && END_KINDS[shown] === true && !(extra && extra.spectate === false);
  }

  // Play again in the card's own words, or as the hook's answer says (left off, a label, a state). On a card that closes
  // a life it is always there: left off, it shows unpressable.
  function againButton(end) {
    var a = extra ? extra.again : undefined;
    if (starting) return { id: 'again', text: BTN.starting, primary: true, disabled: true, onClick: playAgain };
    if (a === false) return end ? { id: 'again', text: BTN.again, primary: true, disabled: true, onClick: playAgain } : null;
    var o = a && typeof a === 'object' ? a : null;
    var label = typeof a === 'string' ? a : o && typeof o.text === 'string' ? o.text : '';
    return { id: 'again', text: label || (lifeCard ? BTN.again : BTN.retry), primary: true,
      disabled: !!(o && o.disabled === true), onClick: playAgain };
  }

  function lineText(item) {
    return typeof item === 'string' ? item : item && typeof item.text === 'string' ? item.text : '';
  }

  // The card's own facts for a life: Time and Top rank, and the length too when the big figure is something else, then
  // Kills (Owen 2026-10-16), the server's own kill_count for this snake (slView, slxNet 'ownKills').
  function lifeFacts(withLength) {
    var out = [];
    if (lifeCard && life.born > 0) out.push(['Time', E.clock((life.died || now()) - life.born)]);
    if (lifeCard && life.rank > 0 && life.rank < NO_RANK) out.push(['Top rank', E.ordinal(life.rank)]);
    if (withLength && score !== null) out.push(['Length', E.int(score)]);
    if (lifeCard && life.born > 0) out.push(['Kills', E.int(life.kills)]);
    return out;
  }

  // The card on screen, from the kind, the length and the hook's answer.
  function draw() {
    var x = extra || {};
    var verdict = typeof x.title === 'string' && x.title ? x.title
      : shown === 'dead' && life.killer ? KILLED_BY + life.killer
        : TITLE[shown] || TITLE.lost;
    var showLength = score !== null && x.length !== false;
    var hasHero = typeof x.hero === 'string' && x.hero !== '';
    var lines = [];
    var list = Array.isArray(x.lines) ? x.lines : [];
    for (var i = 0; i < list.length; i++) {
      var t = lineText(list[i]);
      if (t) lines.push(t);
    }
    // in the order dsEnd lays them out: Lobby on the left, Spectate, the next step on the right
    var end = endCard();
    var buttons = [{ id: 'lobby', text: BTN.lobby, onClick: toLobby }];
    if (end) buttons.push({ id: 'spectate', text: BTN.spectate, disabled: starting || buying(), onClick: spectate });
    // a hook may leave Play again off altogether (the battle royale's death while its match runs: Owen 2026-10-16,
    // "they can't play again until the next game"), so that card is Lobby and Spectate
    var a = x.noAgain === true && end ? null : againButton(end);
    if (a) buttons.push(a);
    view = {
      tone: x.tone === 'win' || x.tone === 'loss' ? x.tone : 'plain',
      verdict: verdict,
      hero: hasHero ? x.hero : showLength ? E.int(score) : '',
      unit: hasHero ? (typeof x.unit === 'string' ? x.unit : '') : showLength ? LENGTH : '',
      podium: Array.isArray(x.podium) ? x.podium : null,
      facts: Array.isArray(x.facts) ? x.facts : x.length === false ? [] : lifeFacts(hasHero && showLength),
      ledger: Array.isArray(x.ledger) ? x.ledger : null,
      status: x.status && typeof x.status.text === 'string' ? x.status : null,
      notes: lines,
      buttons: buttons,
      z: Z,
      zoom: ZOOM
    };
    if (freeDeath()) view.share = { onClick: shareScore };
    card = E.show(view);
    // Marked as ours on their page: the layer's own test for a control (an slx- class on the node or an ancestor:
    // slxWatch and slxBr onGame, slxTouch isControl) leaves a press on the card to the card, as it did the old one.
    if (card.el && !/(^|\s)slx-card(\s|$)/.test(card.el.className)) card.el.className += ' slx-card';
    card.opacity(opacity);
  }

  // kind: a TITLE key. n: the length, or null for a card with no length. ended: a life ended (else a refusal).
  function show(kind, n, op, ended) {
    shown = kind;
    lifeCard = !!ended;
    starting = false;
    extra = hookLines(kind);
    score = n === null || n === undefined ? null : Number(n);
    opacity = op;
    draw();
  }

  function hide() {
    shown = '';
    starting = false;
    view = null;
    card = null;
    E.hide();
  }

  // The hook's answer again, for the card on screen (slxPaid: the cash-out status, a buy-in's progress).
  function refresh() {
    if (!shown) return;
    extra = hookLines(shown);
    draw();
  }

  function start() {
    if (!shown || starting) return false;
    starting = true;
    draw();
    D.play(nick());
    return true;
  }

  function playAgain() {
    if (!shown || starting) return;
    if (typeof slx.beforeAgain === 'function') {
      var took = false;
      try {
        took = slx.beforeAgain(start) === true;
      } catch (e) {
        slx.errors++;
        return;
      }
      if (took) return;
    }
    start();
  }

  // The layer's exit trap (slxPaid: money still in the room, a buy-in not yet confirmed): true keeps the page here.
  function kept() {
    if (typeof slx.beforeLobby !== 'function') return false;
    try {
      return slx.beforeLobby() === true;
    } catch (e) {
      slx.errors++;
      return false;
    }
  }

  function toLobby() {
    if (kept()) return;
    if (typeof slx.toLobby === 'function' && slx.toLobby()) return;
    try {
      root.location.assign('/');
    } catch (e) { /* no location: nothing to do */ }
  }

  // Share your score (2026-10-26): on a free room's death only. Never a paid page, the battle royale (a prize event) or
  // a card a layer answered for (a watcher's, a notice): those words and pictures leave the site.
  function freeDeath() {
    return shown === 'dead' && lifeCard && !extra && score !== null && !slx.br && !(slx.paid && slx.paid.on === true) &&
      paidRung() === 0 && typeof E.share === 'function';
  }
  function shareScore() {
    if (!view || !freeDeath()) return;
    E.share({ game: 'snake', hero: view.hero, unit: view.unit, facts: view.facts, z: Z, zoom: ZOOM });
  }

  // The paid rung this page plays (slxPaid rung()), else 0 (the free room).
  function paidRung() {
    var p = slx.paid;
    if (!p || p.on !== true || typeof p.rung !== 'function') return 0;
    var n = Number(p.rung());
    return isFinite(n) && n > 0 ? n : 0;
  }

  // Spectate: only where Lobby may go, never while a Play is starting. A layer that can watches in place (slxBr), else
  // the page reopens watching as the lobby's Spectate opens it (slxWatch watchOpen: the same keys, the same page).
  // A paid Play again buy-in still with the wallet, slow or not: Spectate stays shut (a stake that lands late needs
  // this page in the frame; Lobby reopens once the wallet is slow because it clears the frame).
  function buying() {
    try { return !!(slx.paid && slx.paid.on && slx.paid.state().restaking === true); } catch (e) { return false; }
  }
  function spectate() {
    if (!shown || starting || !endCard()) return;
    if (kept()) return;
    if (buying()) return;
    if (typeof slx.beforeWatch === 'function') {
      var took = false;
      try {
        took = slx.beforeWatch(start) === true;
      } catch (e) {
        slx.errors++;
        return;
      }
      if (took) return;
    }
    if (typeof slx.watchOpen !== 'function') return;
    try {
      slx.watchOpen(paidRung());
    } catch (e) {
      slx.errors++;
    }
  }

  // ---- what the tap reports
  if (typeof slx.onSocket === 'function') {
    slx.onSocket('disconnect', function (reason) { lastReason = String(reason || ''); });
    slx.onSocket('connect_error', function (err) {
      lastReason = 'connect_error';
      var d = err && err.data;
      connectWhy = d && typeof d.why === 'string' ? d.why : '';
    });
  }
  slx.on('open', function () {
    life = newLife();
    lastReason = '';
    connectWhy = '';
  });
  slx.on('ownAdd', function () { if (!life.born) life.born = now(); });
  // their server sends the snake's kill total each time it rises (slView kill_count)
  slx.on('ownKills', function (ev) {
    var n = ev && typeof ev.count === 'number' && ev.count >= 0 ? Math.floor(ev.count) : 0;
    if (n > life.kills) life.kills = n;
  });
  slx.on('frame', function () { if (life.born && !life.died) keepRank(); });
  slx.on('ownDead', function () {
    life.dead = true;
    keepRank();
    if (!life.died) life.died = now();
  });
  slx.on('x:cashed', function () {
    life.cashed = true;
    keepRank();
    if (!life.died) life.died = now();
  });
  // The kill feed names this snake's killer (server/sl/slRoom.js C_KILLFEED: sent when a human is in it).
  slx.on('x:kill', function (m) {
    if (!m || typeof m.killer !== 'string' || !m.killer) return;
    var me = nick();
    if (me && m.victim === me && !life.died) life.killer = m.killer;
    else if (me && m.victim === me && life.died && now() - life.died < 1500) life.killer = m.killer;
  });

  slx.on('close', function (info) {
    var i = info || {};
    if (i.playing) {
      // Their applyClose runs next and their menu shows 1.6 s later; the kind waits for it.
      keepRank();
      if (i.sawDead) return;
      if (!S.slither) life.noLength = true;            // their gameOver cannot write a length with no own snake
      if (!life.died) life.died = now();
      life.pending = !i.refused && lastReason === SERVER_DROP ? 'slow' : 'lost';
      return;
    }
    // No life: their menu never shows (slApply.js:1252-1262), so the card shows now, at full opacity (their login
    // layer is fully shown when no life runs).
    var refused = typeof i.refused === 'string' ? i.refused : !i.opened ? connectWhy : '';
    show(refused && TITLE[refused] ? refused : 'lost', null, 1, false);
    connectWhy = '';
  });

  slx.on('menuShow', function () {
    keepRank();
    var kind = life.cashed ? 'cashed' : life.dead ? 'dead' : life.pending || 'lost';
    show(kind, life.noLength ? null : lastscoreNumber(), 0, true);
  });

  slx.on('menuFade', function (fr) {
    if (!shown || typeof fr !== 'number') return;
    if (fr >= 1) {
      hide();                                    // their start fade ended: a life is running
      return;
    }
    opacity = 1 - fr;
    if (card && E.shown()) card.opacity(opacity);
  });

  function factsText(f) {
    return (f || []).map(function (p) { return Array.isArray(p) ? p[0] + ' ' + p[1] : ''; });
  }

  slx.card = {
    get element() { return card && E.shown() ? card.el : null; },
    // For tests and the console: what the card shows now.
    state: function () {
      var v = shown && view ? view : null;
      var again = v ? v.buttons.filter(function (b) { return b.id === 'again'; })[0] : null;
      var watch = v ? v.buttons.filter(function (b) { return b.id === 'spectate'; })[0] : null;
      return {
        kind: shown,
        title: v ? v.verdict : '',
        length: v && score !== null && (!extra || extra.length !== false) ? String(score) : '',
        hero: v ? v.hero : '',
        unit: v ? v.unit : '',
        tone: v ? v.tone : '',
        facts: v ? factsText(v.facts) : [],
        ledger: v && v.ledger ? v.ledger.map(function (r) { return r[0] + ' ' + r[1]; }) : [],
        status: v && v.status ? v.status.text : '',
        podium: v && v.podium ? v.podium.map(function (p) { return p.rank + ' ' + p.name; }) : [],
        again: again ? again.text : '',
        againShown: !!again,
        againDisabled: !!(again && again.disabled),
        spectateShown: !!watch,
        spectateDisabled: !!(watch && watch.disabled),
        buttons: v ? v.buttons.map(function (b) { return b.text; }) : [],
        lines: v ? v.notes.slice() : [],
        opacity: String(opacity)
      };
    },
    playAgain: playAgain,
    toLobby: toLobby,
    spectate: spectate,
    hide: hide,
    refresh: refresh,
    notice: function (kind) { show(String(kind || ''), null, 1, false); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
