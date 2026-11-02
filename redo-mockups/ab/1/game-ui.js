/* Layout 1 "Sidebar": the shared in-game UI, every state behind one mockup switcher (?s=<state>, ?empty for a quiet room).
   Mirrors today's public/js/shared dsEnd, dsWatchBar, dsChat, dsDialog, dsSeatHold, dsEmptyArena, dsPerfHud, dsShare and
   v2/toasts, redrawn in the kit, with the audit's fixes: one Leave control top left in every game (Pac-Man, Knockout and
   Swim had none), "Leave" not "Cash out" in a free run, a free result that reads as a result, bots always labelled,
   the empty table naming the stake, 44 px phone targets, chat in the kit's type and colours, no T hint for watchers,
   one rank wording, the share card using the lobby's game names, and the readout hidden while the end card shows.
   Mockup only: nothing here talks to a server. */
(function () {
  'use strict';
  const K = window.DSKit, D = K.data, I = K.icon, F = K.fmt, esc = K.esc, U = window.DSUI;
  const $ = id => document.getElementById(id);
  const Q = U.Q, EMPTY = Q.has('empty');
  const LOBBY = U.href('home.html');
  const usd = v => F.usd(v);
  const HOLD_MS = 2000;

  const svg = (p, s) => '<svg viewBox="0 0 24 24" width="' + (s || 20) + '" height="' + (s || 20) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  const IC = {
    leave: svg('<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M15 8l4 4-4 4M19 12H9"/>'),
    chat: svg('<path d="M4 5h16v11H9l-5 4z"/>'),
    send: svg('<path d="M4 12l16-8-6 16-3-7z"/>', 18),
    eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 18),
    eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>', 18),
    bot: svg('<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9.5 13h.01M14.5 13h.01M10 16h4"/>'),
    kill: svg('<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>', 15)
  };

  /* ---------- the states ---------- */
  const GROUPS = [
    ['End screen', [['win', 'Paid win'], ['winfree', 'Free win'], ['lose', 'Knocked out, paid'], ['losefree', 'Knocked out, free'], ['draw', 'Draw'], ['cashed', 'Cashed out'], ['left', 'Left a free run']]],
    ['In a match', [['leave', 'Leave, free run'], ['cashout', 'Cash out, paid run'], ['confirm', 'Leave a paid match?'], ['seat', 'Seat hold'], ['ping', 'Ping and FPS']]],
    ['Waiting', [['queue', 'Queue, free'], ['queuepaid', 'Queue, paid'], ['bot', 'Playing a bot']]],
    ['Watching', [['watch', 'Spectate'], ['emptymap', 'Empty arena']]],
    ['Over the game', [['chat', 'Chat'], ['toasts', 'Toasts']]]
  ];
  const S = {
    win: { kind: 'end', game: 'knockout' }, winfree: { kind: 'end', game: 'airhockey' }, lose: { kind: 'end', game: 'knockout' },
    losefree: { kind: 'end', game: 'knockout' }, draw: { kind: 'end', game: 'airhockey' }, cashed: { kind: 'end', game: 'snake' }, left: { kind: 'end', game: 'chomp' },
    leave: { kind: 'play', game: 'chomp', out: 'hold', stake: 0 },
    cashout: { kind: 'play', game: 'snake', out: 'hold', stake: 1 },
    confirm: { kind: 'play', game: 'knockout', out: 'tap', stake: 0.5, opp: 'Kestrel' },
    seat: { kind: 'play', game: 'pool8', out: 'tap', stake: 0, opp: 'Calloway' },
    ping: { kind: 'play', game: 'swim', out: 'tap', stake: 0, opp: 'mossy_t' },
    queue: { kind: 'queue', game: 'airhockey', stake: 0 },
    queuepaid: { kind: 'queue', game: 'knockout', stake: 0.5 },
    bot: { kind: 'play', game: 'airhockey', out: 'tap', stake: 0, opp: 'ahmed (bot)' },
    watch: { kind: 'watch', game: 'headsoccer' },
    emptymap: { kind: 'map', game: 'snake', stake: 1 },
    chat: { kind: 'play', game: 'paper', out: 'hold', stake: 0 },
    toasts: { kind: 'play', game: 'headsoccer', out: 'tap', stake: 0, opp: 'Kestrel' }
  };
  const LABEL = {}; GROUPS.forEach(g => g[1].forEach(([id, l]) => { LABEL[id] = l; }));

  /* every amount is the server's own figure in the real game; here they are the mockup's. A $0.50 duel: a $1.00 pot,
     the house keeps 10%, the winner gets $0.90. A paid result shows the money; a free one shows the result. */
  const SLUG = { airhockey: 'airhockey', knockout: 'knockout', chomp: 'chomp', snake: 'snake', paper: 'paper', headsoccer: 'headsoccer' };
  const END = {
    win: { coin: 'gold', verdict: 'You won', hero: '$0.90', heroCls: 'money', unit: 'to your wallet',
      facts: [['Score', '3-1'], ['Time', '2:41'], ['Table', '$0.50']],
      ledger: [['Pot', '$1.00'], ['House 10%', '-$0.10'], ['You receive', '$0.90']], status: true, stake: 0.5 },
    winfree: { coin: 'iron', verdict: 'Free match against ahmed (bot)', hero: 'You win',
      facts: [['Score', '7-4'], ['Time', '3:12'], ['Table', 'Free']], stake: 0,
      share: { big: 'You win', line: '7-4 against ahmed (bot)', words: 'I won 7-4 in Air Hockey on DuelSeries. Can you beat it?' } },
    lose: { coin: 'iron', verdict: 'Kestrel won 3-1', hero: 'Knocked out', heroCls: 'loss',
      facts: [['Score', '1-3'], ['Time', '2:41'], ['Table', '$0.50']], ledger: [['Your entry', '-$0.50']], stake: 0.5 },
    losefree: { coin: 'iron', verdict: 'Kestrel won 3-1', hero: 'Knocked out', heroCls: 'loss',
      facts: [['Score', '1-3'], ['Time', '2:41'], ['Table', 'Free']], stake: 0,
      share: { big: '1-3', line: 'against Kestrel', words: 'Play Knockout with me on DuelSeries.' } },
    draw: { coin: 'iron', verdict: 'Free match against Ravenfield', hero: 'Draw',
      facts: [['Score', '3-3'], ['Time', '4:00'], ['Table', 'Free']], notes: ['Still level after the minute of sudden death.'], stake: 0,
      share: { big: 'Draw', line: '3-3 against Ravenfield', words: 'Play Air Hockey with me on DuelSeries.' } },
    cashed: { coin: 'gold', verdict: 'Cashed out', hero: '$2.16', heroCls: 'money', unit: 'to your wallet',
      facts: [['Length', '1,284'], ['Rank', '3rd of 5'], ['Time', '6:12']],
      ledger: [['Cashed out', '$2.40'], ['House 10%', '-$0.24'], ['You receive', '$2.16']], status: true, stake: 1 },
    left: { coin: 'iron', verdict: 'You left the run', hero: '1,840', unit: 'points',
      facts: [['Rank', '2nd of 6'], ['Time', '3:05'], ['Table', 'Free']], stake: 0,
      share: { big: '1,840', line: 'points, 2nd of 6', words: 'I got 1,840 points in Pac-Man on DuelSeries. Can you beat it?' } }
  };

  /* chat lines: warm name colours only (no blue or purple), a kill line marked with an icon, never an emoji */
  const LINES = [
    { name: 'Kestrel', c: '#f2b880', text: 'gg, that loop was close' },
    { kill: true, killer: 'Ravenfield', kc: '#e9a3a3', victim: 'okapi' },
    { name: 'mossy_t', c: '#b9d98a', text: 'anyone up for Head Soccer after this' },
    { me: true, name: D.me.name, text: 'me, one more round first' }
  ];
  const WATCH_LINES = [
    { name: 'Kestrel', c: '#f2b880', text: 'that header was lucky' },
    { name: 'okapi', c: '#e9a3a3', text: 'rematch after this?' }
  ];
  const MATCHES = [['Calloway', 'ahmed (bot)'], ['mossy_t', 'pip (bot)']];

  /* ---------- timers that belong to one state ---------- */
  let T = [];
  const later = (fn, ms) => { T.push(setTimeout(fn, ms)); };
  const every = (fn, ms) => { T.push(setInterval(fn, ms)); };
  const clearT = () => { T.forEach(t => { clearTimeout(t); clearInterval(t); }); T = []; };

  const gf = $('gf'), gimg = $('gf-img'), tl = $('tl'), tc = $('tc'), veil = $('veil'), sw = $('sw'), plate = $('sw-plate'), pf = $('pf');
  let cur = null, acted = false;

  /* ---------- the readout ---------- */
  function ping(ms) {
    const dot = $('pf-dot'), t = $('pf-ms');
    dot.className = 'pf-dot' + (ms == null ? '' : ms < 50 ? ' is-ok' : ms < 100 ? ' is-mid' : ' is-bad');
    t.textContent = ms == null ? '-- ms' : ms + ' ms';
  }
  function readout(mode) {
    pf.hidden = false;
    let fps = 60;
    every(() => { const n = Math.random() < .75 ? 60 : 59; if (n !== fps) { fps = n; $('pf-fps').textContent = fps; } }, 500);
    if (mode === 'demo') {
      const seq = [38, 41, 79, 86, 131, 144, null, 42];
      let i = 0; ping(seq[0]); every(() => { i = (i + 1) % seq.length; ping(seq[i]); }, 2000);
    } else if (mode !== 'manual') {
      ping(41); every(() => ping(38 + Math.round(Math.random() * 8)), 2000);
    }
  }

  /* ---------- the frame ---------- */
  function frame(game, look) {
    gimg.src = D.game(game).img;
    gf.className = 'gf is-' + look;
  }

  /* ---------- the way out, top left ---------- */
  function outControl(c) {
    const paid = c.stake > 0;
    if (c.out === 'tap') {
      return '<button type="button" class="btn btn-secondary gu-glass gu-out" id="leave" aria-keyshortcuts="Escape">' + IC.leave + 'Leave<kbd>Esc</kbd></button>';
    }
    const word = paid ? 'Cash out' : 'Leave';
    return '<button type="button" class="btn btn-secondary gu-glass gu-out gu-hold' + (paid ? ' is-cash' : '') + '" id="leave" aria-keyshortcuts="Q" aria-describedby="holdtip">' +
      IC.leave + '<span class="gu-lg">' + word + '</span><span class="gu-sm">Hold to ' + word.toLowerCase() + '</span><kbd>Hold Q</kbd></button>';
  }
  function topLeft(c) {
    const chatBtn = '<button type="button" class="btn btn-secondary gu-glass btn-icon ch-btn" id="chatbtn" aria-label="Open chat">' + IC.chat + '<i id="chatdot" hidden></i></button>';
    tl.innerHTML = '<div class="gu-row">' + outControl(c) + chatBtn + '</div><p class="gu-tip" id="holdtip" hidden></p>';
    const b = $('leave');
    if (c.out === 'tap') b.addEventListener('click', () => askLeave(c));
    else {
      b.addEventListener('pointerdown', e => { if (e.button === 0 || e.pointerType !== 'mouse') { b.setPointerCapture && b.setPointerCapture(e.pointerId); holdStart(); } });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => b.addEventListener(ev, () => holdStop()));
      b.addEventListener('contextmenu', e => e.preventDefault());
      b.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); holdStart(); } });
      b.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') holdStop(); });
    }
    $('chatbtn').addEventListener('click', () => (chatOpen ? closeChat() : openChat()));
  }
  function lobbyControl() {
    tl.innerHTML = '<a class="btn btn-secondary gu-glass gu-out" href="' + LOBBY + '">' + '<span class="back">' + I('chev', 18) + '</span>Lobby<kbd>Esc</kbd></a>';
  }

  /* hold to leave a run (Paper's LEAVE, Slither's hold Q): a free run says Leave, a paid one Cash out */
  let hold = null;
  function holdStart() {
    const c = S[cur]; if (hold || !c || c.out !== 'hold') return;
    const b = $('leave'), tip = $('holdtip'), t0 = performance.now(), paid = c.stake > 0;
    hold = { t0, raf: 0 };
    const f = t => {
      if (!hold) return;
      const k = Math.min(1, (t - t0) / HOLD_MS);
      b.style.setProperty('--p', k);
      tip.hidden = false;
      tip.textContent = (paid ? 'Cashing out ' : 'Leaving ') + Math.max(0, (HOLD_MS - (t - t0)) / 1000).toFixed(1) + ' s, release to cancel';
      if (k >= 1) { hold = null; render(paid ? 'cashed' : 'left'); return; }
      hold.raf = requestAnimationFrame(f);
    };
    hold.raf = requestAnimationFrame(f);
  }
  function holdStop() {
    if (!hold) return;
    const quick = performance.now() - hold.t0 < 320, paid = S[cur].stake > 0;
    cancelAnimationFrame(hold.raf); hold = null;
    const b = $('leave'), tip = $('holdtip'); if (b) b.style.setProperty('--p', 0);
    if (!tip) return;
    tip.hidden = false;
    tip.textContent = quick ? (U.PHONE.matches ? 'Keep holding to ' : 'Hold the button or Q to ') + (paid ? 'cash out' : 'leave') : 'Still playing';
    clearTimeout(tip._t); tip._t = setTimeout(() => { tip.hidden = true; }, 1600);
  }

  /* the one question a match asks before you go: the kit sheet, Keep playing first (the safe answer) */
  function askLeave(c) {
    const paid = c.stake > 0, opp = c.opp || 'your opponent';
    U.sheet({
      title: paid ? 'Leave this ' + usd(c.stake) + ' match?' : 'Leave the match?',
      html: '<p class="t-body">The match keeps going without a pause. Leaving now hands it to ' + esc(opp) +
        (paid ? ', and your ' + usd(c.stake) + ' entry goes with it.' : '. Nothing is staked on a free table.') + '</p>',
      foot: '<button type="button" class="btn btn-primary btn-lg btn-block" data-close data-autofocus>Keep playing</button>' +
        '<button type="button" class="btn btn-danger btn-lg btn-block" id="go-leave">' + (paid ? 'Leave and lose ' + usd(c.stake) : 'Leave') + '</button>',
      onOpen(el) { el.querySelector('#go-leave').addEventListener('click', e => U.busy(e.currentTarget, 700, () => { location.href = LOBBY; })); }
    });
  }

  /* ---------- top centre pills ---------- */
  function pill(ic, title, sub, bar) {
    return '<div class="gu-pill"><span class="gu-pill-ic">' + ic + '</span><div><b>' + esc(title) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</div>' +
      (bar ? '<div class="gu-bar"><i></i></div>' : '') + '</div>';
  }
  function seatLoop(c) {
    const spin = '<i class="gu-spin"></i>';
    const mine = () => { tc.innerHTML = pill(spin, 'Reconnecting...', 'Your seat is held for 5 seconds.', true); ping(null); later(back, 5200); };
    const back = () => { tc.innerHTML = ''; ping(42); later(theirs, 2600); };
    const theirs = () => { tc.innerHTML = pill(spin, c.opp + ' is reconnecting...', 'Their seat is held for 5 seconds.', true); later(back2, 5200); };
    const back2 = () => { tc.innerHTML = ''; later(mine, 2600); };
    mine();
  }

  /* ---------- chat ---------- */
  const chat = $('chat'), feed = $('feed'), cin = $('chatin'), ccount = $('chatcount'), cmute = $('chatmute');
  let chatOpen = false, chatHidden = false, canSend = true;
  chat.querySelector('.ch-send').innerHTML = IC.send;
  cmute.innerHTML = IC.eye;
  function lineHTML(m) {
    if (m.sys) return '<div class="ch-line is-sys">' + esc(m.text) + '</div>';
    if (m.kill) return '<div class="ch-line is-kill">' + IC.kill + '<b style="--c:' + m.kc + '">' + esc(m.killer) + '</b> killed <b style="--c:var(--bone)">' + esc(m.victim) + '</b></div>';
    return '<div class="ch-line' + (m.me ? ' is-me' : '') + '"><b' + (m.c ? ' style="--c:' + m.c + '"' : '') + '>' + esc(m.name) + '</b>' + esc(m.text) + '</div>';
  }
  function addLine(m, life) {
    feed.insertAdjacentHTML('beforeend', lineHTML(m));
    const el = feed.lastElementChild;
    while (feed.children.length > 60) feed.firstElementChild.remove();
    if (life) later(() => el.classList.add('is-old'), life);
    feed.scrollTop = feed.scrollHeight;
    if (!chatOpen && !m.me && canSend) { const d = $('chatdot'); if (d) d.hidden = false; }
  }
  function mountChat(mode) {
    chat.hidden = false; feed.innerHTML = ''; chatHidden = false; cmute.setAttribute('aria-pressed', 'false'); cmute.innerHTML = IC.eye;
    canSend = mode !== 'watch';
    chat.classList.toggle('no-send', !canSend);
    cin.placeholder = U.PHONE.matches ? 'Message' : 'Say something, Enter to send';
    const lines = mode === 'watch' ? WATCH_LINES : LINES;
    if (EMPTY && mode === 'open') addLine({ sys: true, text: 'No messages in this room yet.' });
    else if (mode !== 'hint') lines.forEach(m => addLine(m, mode === 'open' ? 0 : 9000));
    if (mode === 'open') openChat();
  }
  function openChat() {
    if (!canSend || chat.hidden) return;
    chatOpen = true; chat.classList.add('is-open');
    const d = $('chatdot'); if (d) d.hidden = true;
    const b = $('chatbtn'); if (b) b.setAttribute('aria-expanded', 'true');
    if (!U.PHONE.matches) cin.focus({ preventScroll: true });
    feed.scrollTop = feed.scrollHeight;
  }
  function closeChat(silent) {
    chatOpen = false; chat.classList.remove('is-open'); cin.value = ''; count();
    const b = $('chatbtn'); if (b) b.setAttribute('aria-expanded', 'false');
    if (!silent && document.activeElement === cin) cin.blur();
  }
  function count() { const left = 120 - cin.value.length; ccount.textContent = left <= 20 ? String(left) : ''; ccount.classList.toggle('is-low', left <= 5); }
  cin.addEventListener('input', count);
  cin.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); closeChat(); } });
  $('chatform').addEventListener('submit', e => {
    e.preventDefault();
    const text = cin.value.trim(); if (!text) return;
    feed.querySelectorAll('.is-sys').forEach(l => { if (/No messages/.test(l.textContent)) l.remove(); });
    addLine({ me: true, name: D.me.name, text }, 0); cin.value = ''; count();
  });
  cmute.addEventListener('click', () => {
    chatHidden = !chatHidden;
    cmute.setAttribute('aria-pressed', String(chatHidden)); cmute.setAttribute('aria-label', chatHidden ? 'Show chat' : 'Hide chat'); cmute.title = chatHidden ? 'Show chat' : 'Hide chat';
    cmute.innerHTML = chatHidden ? IC.eyeOff : IC.eye;
    feed.querySelectorAll('.ch-line:not(.is-me):not(.is-sys)').forEach(l => { l.hidden = chatHidden; });
    addLine({ sys: true, text: chatHidden ? 'Chat hidden. Only your own messages show.' : 'Chat is showing again.' }, 6000);
  });
  $('chathint').addEventListener('click', openChat);

  /* ---------- the end card ---------- */
  function endCard(s) {
    const e = END[s], c = S[s], g = D.game(c.game), paid = e.stake > 0;
    const facts = '<div class="stat-row ec-facts' + (e.facts.length === 2 ? ' n2' : '') + '">' + e.facts.map(([k, v]) => '<div class="stat"><span>' + k + '</span><b>' + v + '</b></div>').join('') + '</div>';
    const ledger = e.ledger ? '<div class="sum ec-sum">' + e.ledger.map(([k, v], i) => {
      const net = e.ledger.length > 1 && i === e.ledger.length - 1;
      return '<div' + (net ? ' class="net"' : '') + '><span>' + k + '</span><b class="num' + (v.charAt(0) === '-' && !net ? (e.ledger.length === 1 ? ' loss' : '') : '') + '">' + v + '</b></div>';
    }).join('') + '</div>' : '';
    const status = e.status ? '<div class="ec-st" id="ec-st" role="status"><i></i><span>Sending to your wallet</span></div>' : '';
    const notes = (e.notes || []).map(n => '<p class="ec-note">' + esc(n) + '</p>').join('');
    const again = paid ? 'Play again<small>' + usd(e.stake) + '</small>' : 'Play again';
    veil.className = 'gu-veil';
    veil.innerHTML = '<section class="ec' + (e.coin === 'gold' ? ' is-gold' : '') + '" aria-labelledby="ec-h" aria-describedby="ec-v">' +
      '<div class="coin ' + e.coin + '" aria-hidden="true"><span>' + (e.coin === 'gold' ? '<b>$</b>' : '') + '</span></div>' +
      '<p class="ec-v" id="ec-v">' + esc(e.verdict) + '</p>' +
      '<h2 class="ec-hero' + (e.heroCls ? ' ' + e.heroCls : '') + '" id="ec-h">' + esc(e.hero) + '</h2>' +
      (e.unit ? '<p class="ec-unit">' + esc(e.unit) + '</p>' : '') + facts + ledger + status + notes +
      '<div class="ec-btns"><a class="btn btn-secondary btn-lg" href="' + LOBBY + '">Lobby</a>' +
      '<button type="button" class="btn btn-secondary btn-lg" id="ec-watch">Spectate</button>' +
      '<button type="button" class="btn btn-primary btn-lg ec-again" id="ec-again">' + again + '</button></div>' +
      (e.share ? '<button type="button" class="btn btn-quiet btn-block ec-share" id="ec-share">' + I('share', 18) + 'Share your score</button>' : '') +
      '</section>';
    $('ec-watch').addEventListener('click', () => render('watch'));
    const a = $('ec-again');
    a.addEventListener('click', () => {
      if (!paid) { U.busy(a, 500, () => render('queue')); return; }
      /* a paid Play again buys a new entry: the lobby's wallet asks, then the queue opens */
      a.disabled = true; a.textContent = 'Confirm in your wallet...';
      later(() => { U.toast('Entry paid', 'ok', usd(e.stake) + ' for a new ' + g.name + ' match.'); render(c.game === 'snake' ? 'cashout' : 'queuepaid'); }, 1500);
    });
    if (e.share) $('ec-share').addEventListener('click', () => share(e, g));
    if (e.status) later(() => {
      const st = $('ec-st'); if (!st) return;
      st.classList.add('is-ok');
      st.innerHTML = '<i></i><span>Sent to your wallet</span><button type="button" class="btn btn-quiet btn-sm" id="ec-tx">View transaction' + I('ext', 15) + '</button>';
      $('ec-tx').addEventListener('click', () => U.toast('The transaction opens on Solscan', 'info', 'Mockup: the real card links straight to it.'));
    }, 2600);
    if (acted) a.focus({ preventScroll: true });
  }

  /* the share sheet (free results only: nothing on it ever says money) */
  function share(e, g) {
    const link = 'duelseries.com/play/' + (SLUG[g.id] || g.id), phone = U.PHONE.matches;
    U.sheet({
      title: 'Share your score',
      html: '<div class="shp" role="img" aria-label="' + esc(e.share.big + ', ' + e.share.line + ', ' + g.name) + '"><img src="' + g.img + '" alt="">' +
        '<div class="shp-in"><span class="logo">Duel<span>Series</span></span><div><b>' + esc(e.share.big) + '</b><span>' + esc(e.share.line) + ' in ' + esc(g.name) + '</span></div>' +
        '<small>Play free at <em>' + link + '</em></small></div></div>' +
        '<p class="hint">' + esc(e.share.words) + ' ' + link + '</p>',
      foot: phone
        ? '<button type="button" class="btn btn-primary btn-lg btn-block" data-flash="Opening your share sheet">' + I('share', 18) + 'Share</button>' +
          '<button type="button" class="btn btn-secondary btn-lg btn-block" data-flash="Link copied">Copy invite link</button>'
        : '<button type="button" class="btn btn-primary btn-lg btn-block" data-flash="Image copied">Copy image</button>' +
          '<div class="sh-2"><button type="button" class="btn btn-secondary btn-lg" data-flash="Image saved">Save image</button>' +
          '<button type="button" class="btn btn-secondary btn-lg" data-flash="Link copied">Copy invite link</button></div>',
      onOpen(el) {
        el.querySelectorAll('[data-flash]').forEach(b => b.addEventListener('click', () => {
          const was = b.innerHTML; b.textContent = b.dataset.flash; clearTimeout(b._t); b._t = setTimeout(() => { b.innerHTML = was; }, 2000);
        }));
      }
    });
  }

  /* ---------- the queue card ---------- */
  function queueCard(c) {
    const g = D.game(c.game), paid = c.stake > 0, R = 66, C = 2 * Math.PI * R, WAIT = 60;
    veil.className = 'gu-veil is-mid';
    veil.innerHTML = '<section class="panel qc" aria-labelledby="qc-t">' +
      '<div class="qc-hd"><img src="' + g.img + '" alt=""><div><b>' + esc(g.name) + '</b><span>' + (paid ? usd(c.stake) + ' table' : 'Free table') + '</span></div>' +
      (paid ? '<span class="chip chip-money">' + usd(c.stake) + ' entry paid</span>' : '') + '</div>' +
      '<div class="qc-ring' + (paid ? ' is-open' : '') + '" aria-hidden="true"><svg viewBox="0 0 148 148"><circle class="trk" cx="74" cy="74" r="' + R + '"/>' +
      '<circle class="arc" id="qc-arc" cx="74" cy="74" r="' + R + '" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + (paid ? (C * .72).toFixed(1) : '0') + '"/></svg>' +
      '<b class="num" id="qc-clock">0:00</b><small id="qc-cap">' + (paid ? 'waiting' : 'until a bot') + '</small></div>' +
      '<h2 class="t-title" id="qc-t">Looking for a player</h2>' +
      '<p class="hint" id="qc-sub">' + (paid ? 'Real players only, never a bot. Cancel any time for a full refund.' : 'If nobody joins by 0:00, you play a bot, and it is labelled as one.') + '</p>' +
      (paid ? '<button type="button" class="btn btn-secondary btn-lg" id="qc-x">Cancel and refund</button>' : '<a class="btn btn-secondary btn-lg" href="' + LOBBY + '">Back to the lobby</a>') +
      '</section>';
    const clock = $('qc-clock'), arc = $('qc-arc');
    const mmss = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    if (paid) {
      let up = 13; clock.textContent = mmss(up);
      every(() => { up++; clock.textContent = mmss(up); }, 1000);
      $('qc-x').addEventListener('click', e => U.busy(e.currentTarget, 800, () => {
        U.toast('Cancelled', 'ok', 'Your ' + usd(c.stake) + ' entry went back to your wallet.');
        later(() => { location.href = LOBBY; }, 2200);
      }));
    } else {
      let left = 47;
      const draw = () => { clock.textContent = mmss(left); arc.style.strokeDashoffset = (C * (1 - left / WAIT)).toFixed(1); };
      draw();
      every(() => {
        left = Math.max(0, left - 1); draw();
        if (left === 0) {
          clearT();
          $('qc-t').textContent = 'Nobody joined. Playing a bot...';
          $('qc-sub').textContent = 'Free table. Starting against a bot now.';
          $('qc-cap').textContent = 'starting';
          later(() => render('bot'), 1600);
        }
      }, 1000);
    }
    readout();
  }

  /* ---------- watching ---------- */
  let wi = 0, wbusy = false;
  function plateNames() {
    const [a, b] = MATCHES[wi];
    plate.classList.remove('is-wait');
    plate.innerHTML = '<b>' + esc(a) + '</b> <span>vs ' + esc(b) + '</span>';
  }
  function stepWatch(d) {
    if (wbusy || sw.classList.contains('is-empty')) return;
    wbusy = true; $('sw-prev').disabled = $('sw-next').disabled = true;
    plate.classList.add('is-wait'); plate.innerHTML = '<b>Finding a player</b>';
    later(() => { wi = (wi + d + MATCHES.length) % MATCHES.length; plateNames(); wbusy = false; $('sw-prev').disabled = $('sw-next').disabled = false; }, 420);
  }
  $('sw-prev').innerHTML = I('chev', 22);
  $('sw-next').innerHTML = I('chev', 22);
  $('sw-prev').addEventListener('click', () => stepWatch(-1));
  $('sw-next').addEventListener('click', () => stepWatch(1));
  function watch(c) {
    lobbyControl();
    sw.hidden = false; wbusy = false; $('sw-prev').disabled = $('sw-next').disabled = false;
    if (c.kind === 'map') {
      sw.classList.add('is-empty');
      plate.innerHTML = '<b>Nobody is playing at ' + usd(c.stake).replace('.00', '') + ' right now</b><span>Watching the whole map. You follow the first player who joins.</span>';
    } else if (EMPTY) {
      frame(c.game, 'quiet');
      sw.classList.add('is-empty');
      plate.innerHTML = '<b>Nobody is playing ' + esc(D.game(c.game).name) + ' right now</b><span>The first match that starts shows here.</span>';
    } else {
      sw.classList.remove('is-empty');
      wi = 0; plateNames();
      mountChat('watch');
    }
    readout();
  }

  /* ---------- toasts: the kit's toast, top centre over a game. The mockup shows all three kinds at once
     (a real game shows one at a time) and keeps them up so they can be read ---------- */
  function demoToasts() {
    const box = document.createElement('div'); box.className = 'toasts gu-demo'; box.setAttribute('role', 'status');
    box.innerHTML = [['ok', 'check', 'Sent to your wallet', '+$0.90 from your Knockout win.'],
      ['err', 'x', 'Stake failed', 'Your wallet did not approve it. Nothing left your balance.'],
      ['info', 'bell', 'Battle Royale in 10 minutes', 'Free entry, $20 to 1st. Join from Events.']]
      .map(([k, ic, t, m]) => '<div class="toast toast-' + k + '"><div class="toast-ic">' + I(ic, 18) + '</div><div><b>' + esc(t) + '</b><span>' + esc(m) + '</span></div></div>').join('');
    document.body.append(box);
  }

  /* ---------- in a match ---------- */
  function play(c, s) {
    topLeft(c);
    if (s === 'chat') mountChat('open'); else mountChat('hint');
    if (s === 'bot') tc.innerHTML = pill(IC.bot, 'Playing a bot', 'Nobody joined in a minute, so ahmed (bot) took the seat.');
    if (s === 'seat') { readout('manual'); seatLoop(c); }
    else if (s === 'ping') readout('demo');
    else readout();
    if (s === 'toasts') demoToasts();
    if (s === 'confirm') requestAnimationFrame(() => askLeave(c));
  }

  /* ---------- render one state ---------- */
  function render(s) {
    if (!S[s]) s = 'win';
    clearT(); U.closeSheet(); holdStopSilent(); closeChat(true);
    document.querySelectorAll('.gu-demo').forEach(n => n.remove());
    cur = s; const c = S[s];
    document.body.dataset.ui = s;
    tl.innerHTML = ''; tc.innerHTML = ''; veil.innerHTML = ''; veil.className = 'gu-veil';
    sw.hidden = true; sw.classList.remove('is-empty'); chat.hidden = true; pf.hidden = true;
    frame(c.game, c.kind === 'end' || c.kind === 'queue' ? 'end' : c.kind === 'map' ? 'map' : 'play');
    if (c.kind === 'end') endCard(s);          /* the readout steps aside while the card is up (it sat on the card's edge on phones) */
    else if (c.kind === 'queue') queueCard(c);
    else if (c.kind === 'play') play(c, s);
    else watch(c);
    mk.querySelectorAll('[data-s]').forEach(b => b.setAttribute('aria-current', String(b.dataset.s === s)));
    try { const p = new URLSearchParams(location.search); p.set('s', s); history.replaceState(null, '', '?' + p.toString().replace(/=(?=&|$)/g, '')); } catch (_) {}
  }
  function holdStopSilent() { if (hold) { cancelAnimationFrame(hold.raf); hold = null; } }

  /* ---------- keys: Esc asks to leave (or goes back while watching), Q held leaves a run, T opens chat,
     Left / Right / Space switch who you watch. Typing in chat never reaches the game. ---------- */
  document.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if (document.querySelector('.scrim.open') || (mk.classList.contains('is-open') && e.key !== 'Escape')) return;
    const c = S[cur]; if (!c) return;
    const k = e.key;
    if ((k === 't' || k === 'T') && c.kind === 'play' && !e.repeat) { e.preventDefault(); openChat(); return; }
    if (k === 'Escape') {
      if (mk.classList.contains('is-open')) { mk.classList.remove('is-open'); return; }
      if (chatOpen) { closeChat(); return; }
      if (c.kind === 'play' && c.out === 'tap') askLeave(c);
      else if (c.kind === 'watch' || c.kind === 'map') location.href = LOBBY;
      return;
    }
    if ((k === 'q' || k === 'Q') && c.kind === 'play' && c.out === 'hold' && !e.repeat) { holdStart(); return; }
    if (c.kind === 'watch' && (k === 'ArrowLeft' || k === 'ArrowRight' || k === ' ')) {
      if (e.target.closest && e.target.closest('button, a') && k === ' ') return;
      e.preventDefault(); stepWatch(k === 'ArrowLeft' ? -1 : 1);
    }
  });
  document.addEventListener('keyup', e => { if (e.key === 'q' || e.key === 'Q') holdStop(); });

  /* ---------- mockup switcher ---------- */
  const mk = $('mk');
  mk.innerHTML = '<button type="button" class="mk-tog" id="mk-tog" aria-expanded="false" aria-controls="mk-list">States' + I('chev', 14) + '</button>' +
    '<div class="mk-list" id="mk-list"><p class="mk-t">Mockup state</p>' +
    GROUPS.map(([h, items]) => '<p class="mk-h">' + h + '</p>' + items.map(([id, l]) => '<button type="button" data-s="' + id + '">' + l + '</button>').join('')).join('') +
    '<p class="mk-h">Data</p><button type="button" id="mk-empty" aria-pressed="' + EMPTY + '">Quiet room ' + (EMPTY ? 'on' : 'off') + '</button></div>';
  const tog = $('mk-tog');
  tog.addEventListener('click', () => { const o = mk.classList.toggle('is-open'); tog.setAttribute('aria-expanded', String(o)); });
  mk.addEventListener('click', e => {
    const b = e.target.closest('button[data-s]'); if (b) { acted = true; mk.classList.remove('is-open'); tog.setAttribute('aria-expanded', 'false'); render(b.dataset.s); return; }
    if (e.target.closest('#mk-empty')) {
      const p = new URLSearchParams(location.search); if (EMPTY) p.delete('empty'); else p.set('empty', '');
      location.search = p.toString().replace(/=(?=&|$)/g, '');
    }
  });
  document.addEventListener('click', e => { if (mk.classList.contains('is-open') && !mk.contains(e.target)) { mk.classList.remove('is-open'); tog.setAttribute('aria-expanded', 'false'); } });

  render(Q.get('s') || 'win');
})();
