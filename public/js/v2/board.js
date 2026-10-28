'use strict';
/* ─── The live board ──────────────────────────────────────────────────────────
   Shape from GET /api/live:
     { lobbies: [{ id, game, region, stake, players, bots, capacity, state }] }

   capacity is null for persistent rooms: the world grows with the crowd rather
   than filling up, so a row shows a count and not "7 of 30". The prototype's
   /30 was invented.

   The count on a row is players PLUS bots: it is how many things are moving
   around in there, which is what somebody deciding whether to press Enter
   actually wants to know.

   That used to be players only, on the grounds that "12 playing" with eleven
   bots is a lie told to someone about to stake real money. The reasoning was
   right and no longer applies: bots cannot exist in a room that takes a stake
   at all now, enforced on the room itself, so every row that can contain a bot
   is a row where nothing is staked and there is nothing to mislead anybody
   about. A paid row's count is still people only, because that is all it can
   ever hold.

   The pinned free rows get their counts from /api/live's `extras`, which is
   where the rooms that are not on the stake ladder report themselves. */

(function () {
  const el = id => document.getElementById(id);
  const money = n => Number(n) === 0 ? 'Free' : '$' + Number(n).toFixed(2);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  let LOBBIES = [];
  let EXTRAS = [];
  /* Playing each game (every human in all its rooms plus the bots in its rows
     here, so card and rows agree), for the count on each game card. Null when
     the poll failed, so the cards hide it. */
  let COUNTS = null;
  let timer = null;

  /* A failed poll keeps the last good board instead of wiping it: a wiped
     board dropped slither.io, agar.io and Paper.io from the list and left only
     the pinned duels at 0 (2026-10-15 audit). With no good answer yet, the
     list says it could not load rather than drawing that partial picture. */
  let loadedOnce = false, failing = false;
  async function load() {
    try {
      const r = await fetch('/api/live');
      if (r.ok === false) throw new Error('HTTP ' + r.status);   // a real Response; test stubs carry no ok
      take(await r.json());
    } catch (_) {
      failing = true;
    }
    draw();
    if (window.V2_paintCounts) window.V2_paintCounts();
  }
  function take(j) {
    LOBBIES = Array.isArray(j.lobbies) ? j.lobbies : [];
    EXTRAS = Array.isArray(j.extras) ? j.extras : [];
    COUNTS = j.counts && typeof j.counts === 'object' ? j.counts : null;
    /* The Battle Royale state rides along on the same answer: the PC sidebar's clock reads it
       (V2Event.feed) rather than asking the server again. */
    if (j.br && window.V2Event && window.V2Event.feed) window.V2Event.feed(j.br);
    if (window.V2Maint && j.maintenance) window.V2Maint.set(j.maintenance);
    loadedOnce = true; failing = false;
  }
  /* The server's push (toasts.js's socket, 'live'): the same board, sent the moment its rows change, so a
     person joining a queue or a paid room shows up within a second (Owen 2026-10-27). Ignored while a game
     is up: the lobby does no work behind a game, and start() loads afresh when it closes. */
  function push(j) {
    if (!j || typeof j !== 'object' || (document.body && document.body.classList.contains('ingame'))) return;
    take(j);
    draw();
    if (window.V2_paintCounts) window.V2_paintCounts();
  }

  function rowHTML(l) {
    const g = (window.V2_GAME_NAMES || {})[l.game] || l.game;
    const n = playing(l);
    /* A count, shown as a count. Every row used to end in the words "0 playing"
       sitting between two other grey chips, so the line read as four scraps of
       text with a number buried in it. It is one badge now — a dot that is lit
       when anyone is in there, and the figure in the same mono the money uses —
       and the word only exists for a screen reader, which is the one reader that
       needs it spelled out. */
    /* A duel's people in the queue (Owen 2026-10-21: "show the number of players waiting"), lit, and the
       playing badge then counts only the ones already in a match. With both at 0 the row still says 0 playing. */
    const w = Math.max(0, Math.floor(Number(l.waiting) || 0));
    const inMatch = Math.max(0, n - w);
    const waitBadge = w > 0
      ? '<span class="lcount on lqueue"><span class="ldot" aria-hidden="true"></span>' +
        '<span class="num">' + w + '</span> waiting</span>'
      : '';
    /* The word is on the badge, not hidden behind it. This count is the only
       one on the screen now — the one that used to sit under the game's name is
       gone — so it has to say what it is counting rather than leave a bare
       figure floating next to a button. */
    const playBadge = w > 0 && inMatch === 0 ? ''
      : '<span class="lcount' + (inMatch > 0 ? ' on' : '') + '">' +
        '<span class="ldot" aria-hidden="true"></span>' +
        '<span class="num">' + inMatch + '</span> playing</span>';
    return '<div class="lr">' +
      '<div class="lswatch">' + (window.V2_SWATCH ? window.V2_SWATCH(l.game) : '') + '</div>' +
      '<div class="lmid">' +
        '<span class="lname">' + esc(g) + '</span>' +
        /* The buy-in, and the region only when it is not NA: with one region
           open, "NA" on every row said nothing (2026-10-15 audit). */
        '<span class="lsub">' + (String(l.region).toLowerCase() === 'na' ? ''
          : esc(String(l.region).toUpperCase()) + '<i></i>') +
          '<b class="lstake num">' + money(l.stake) + '</b></span>' +
      '</div>' +
      '<span class="sp" style="flex:1"></span>' +
      waitBadge + playBadge +
      '<button class="enter" onclick="V2Board.join(' +
        JSON.stringify(l.id).replace(/"/g, '&quot;') + ')">Enter</button>' +
      '</div>';
  }

  /* "Open lobbies" means rooms with people in them. A rung with nobody in it is
     not an open lobby, it is a buy-in you could choose, and those belong on the
     buy-in control rather than in a list of places to join. Listing all nine
     rungs every time made the board look busy while the game was empty, which
     is the opposite of what it is for. */
  /* Whether a row takes new players. A paid agar.io row stays listed under the
     owner's off switch (agar:paid:off) so its seated players still count, but
     says 'closed' (PAID-AGAR-DESIGN.md 7): those players finish and cash out,
     and anybody new would only pay a stake the door has to refund. Every snake
     and Paper row says 'open' (or says nothing), so this changes nothing for
     them. */
  const isOpen = l => l.state === undefined || l.state === null || l.state === 'open';
  /* Bots count as playing here (Owen 2026-10-17: "bots count as people playing"), so a paid room the owner seeded with
     bots is listed. `players` itself stays humans only on the server: the deploy check reads it. */
  const playing = l => (l.players || 0) + (l.bots || 0);
  /* Only a game the lobby has a playable card for (V2_GAME_NAMES, not a "soon" one): /api/live also carries the rows
     of a game still hidden from the lobby (Chomp's paid rows, so the pre-push check sees anyone seated there), and
     Enter on one would stake through a door the lobby cannot open. */
  const listable = l => {
    const names = window.V2_GAME_NAMES;
    if (names && !names[l.game]) return false;
    return !(window.V2_IS_SOON && window.V2_IS_SOON(l.game));
  };
  /* The lobby's first four games, in the order the cards are (public/v2.html GAMES). */
  const GAME_ORDER = ['chomp', 'snake', 'agar', 'paper'];
  const occupied = () => LOBBIES.filter(l => playing(l) > 0 && isOpen(l));

  /* The one exception: the free slither.io room is always listed, even empty.
     It is the "just let me play" button — nothing to stake, nothing to think
     about — and burying it behind the buy-in stepper made starting a game a
     three-tap job from the screen whose entire purpose is starting a game.
     It still shows its real count, so an empty one says so. */
  /* Every free room that has to be reachable in one press, whether or not the
     server has a rung for it. Awesome Tanks, Bowmasters and the two duels run
     on their own doors rather than on the stake ladder, so /api/live has
     nothing to list for them and there is nothing to pin from the real board.

     stake null rather than 0, and this is the part that matters: enter() sends
     { stake } when there is one, and the server resolves a stake through the
     SNAKE ladder, so a 0 here would route a tank player into a snake room.
     With no stake it sends { lobbyType }, which is the door these games use.

     None of these go into LOBBIES either. refreshSteps reads that list to
     build the buy-in buttons, and a row carrying no stake would put a blank
     rung on the control. */
  const PINNED = [
    { id: 'omgshooter:free', game: 'omgshooter', region: 'na',
      stake: null, lobbyType: 'free', players: 0, state: 'open' },
    { id: 'tanks:free',      game: 'tanks',      region: 'na',
      stake: null, lobbyType: 'free', players: 0, state: 'open' },
    /* The two duels. They are matched INTO rather than joined, so there is no
       room sitting there to list — but Enter on one of these puts you in the
       queue, which is the thing anybody reading this row wants to do. */
    { id: 'knockout:free',   game: 'knockout',   region: 'na',
      stake: null, lobbyType: 'free', players: 0, state: 'open' },
    { id: 'battleship:free', game: 'battleship', region: 'na',
      stake: null, lobbyType: 'free', players: 0, state: 'open' },
    { id: 'swim:free',       game: 'swim',       region: 'na',
      stake: null, lobbyType: 'free', players: 0, state: 'open' },
    /* Head Soccer, the same kind of duel. needsCard: listed only while the lobby has its PLAYABLE card (v2.html
       HS_PREVIEW leaves it a "coming soon" card for everyone but ?headsoccer=preview). */
    { id: 'headsoccer:free', game: 'headsoccer', region: 'na',
      stake: null, lobbyType: 'free', players: 0, state: 'open', needsCard: true },
    { id: 'pool8:free',      game: 'pool8',      region: 'na',
      stake: null, lobbyType: 'free', players: 0, state: 'open', needsCard: true },
    { id: 'airhockey:free', game: 'airhockey', region: 'na',
      stake: null, lobbyType: 'free', players: 0, state: 'open', needsCard: true },
    /* Rooftop Snipers, the same kind of duel (server/RooftopLobby.js); listed while its card is playable. */
    { id: 'rooftop:free', game: 'rooftop', region: 'na',
      stake: null, lobbyType: 'free', players: 0, state: 'open', needsCard: true },
    { id: 'crossy:free',     game: 'crossy',     region: 'na',
      stake: null, lobbyType: 'free', players: 0, state: 'open', needsCard: true },
    /* Paper and agar.io are not pinned here. Their rooms are on the server and
       /api/live reports a row per rung (paper:na:s0, ag:na:s0, ...), so their
       Free comes off the real board in rowsToShow. */
  ];

  /* Which buy-ins a game can actually seat right now: a rung counts only while
     the server lists a room for it AND that room is open. The buy-in control
     draws every other rung struck through. For agar.io that is how the paid
     rungs stay shut while AG_PAID is off: the server lists only its free rung
     (ag:na:s0) then, so $0.50 and $1.00 are drawn struck through, as Paper's
     were before PAPER_PAID. */
  function playableStakes(game) {
    const out = new Set();
    LOBBIES.forEach(l => { if (l.game === game && isOpen(l)) out.add(Number(l.stake)); });
    return out;
  }

  function rowsToShow() {
    const rows = occupied().filter(listable);
    const free = LOBBIES.find(l => Number(l.stake) === 0 && l.game === 'snake');
    if (free && !rows.some(r => r.id === free.id)) rows.unshift(free);
    /* Paper's, agar.io's and Pac-Man's free rungs are always listed too, from the server's own
       row (paper:na:s0, ag:na:s0, chomp:na:s0); GAME_ORDER below puts them in the lobby's order. */
    ['paper', 'agar', 'chomp'].forEach(g => LOBBIES.forEach(l => {
      if (l.game === g && Number(l.stake) === 0 && !rows.includes(l)) rows.push(l);
    }));
    PINNED.forEach(p => {
      if (rows.some(r => r.id === p.id)) return;
      /* A locked game (shared/lockedGames.js) has no room behind its row, so
         it is not listed. Its pinned entry stays above for when it unlocks. */
      if (window.DS_LOCKED && window.DS_LOCKED.isLocked(p.game)) return;
      if (p.needsCard && (!(window.V2_GAME_NAMES && window.V2_GAME_NAMES[p.game])
        || (typeof window.V2_IS_SOON === 'function' && window.V2_IS_SOON(p.game)))) return;
      /* The pinned row keeps its own id, stake and door — those are what make
         it work — and takes only its population from the server. */
      const live = EXTRAS.find(e => e.id === p.id);
      rows.push(live ? Object.assign({}, p, { players: live.players, bots: live.bots, waiting: live.waiting || 0 }) : p);
    });
    /* A paid duel rung with somebody waiting or playing (knockout:s0.5, ...): listed while it is, so a
       person can see the table and take it, and sorted first below like any paid room. */
    EXTRAS.forEach(e => {
      if ((e.game !== 'knockout' && e.game !== 'battleship' && e.game !== 'swim' && e.game !== 'headsoccer' && e.game !== 'pool8' && e.game !== 'airhockey' && e.game !== 'rooftop' && e.game !== 'crossy') || !(Number(e.stake) > 0)) return;
      if (!listable(e)) return;   // a duel whose card is still shut (Swim behind its gate, Head Soccer without its preview)
      if (!(playing(e) > 0) || !isOpen(e) || rows.some(r => r.id === e.id)) return;
      if (window.DS_LOCKED && window.DS_LOCKED.isLocked(e.game)) return;
      rows.push(e);
    });
    /* Paid rooms with anyone in them first, the biggest buy-in on top (Owen 2026-10-17); everything else keeps its order. */
    const paid = rows.filter(l => Number(l.stake) > 0 && playing(l) > 0)
      .sort((a, b) => Number(b.stake) - Number(a.stake) || playing(b) - playing(a));
    /* Then a free duel with somebody waiting for an opponent (Owen 2026-10-21): the row a person can act on. */
    const waitingFree = rows.filter(l => !paid.includes(l) && Number(l.waiting) > 0);
    /* The rest in the lobby's game order (Owen 2026-10-27: Pac-Man, Slither.io, Agar.io, Paper.io), any other
       game after them in the order it already had. */
    const rank = l => { const i = GAME_ORDER.indexOf(l.game); return i < 0 ? GAME_ORDER.length : i; };
    const rest = rows.filter(l => !paid.includes(l) && !waitingFree.includes(l))
      .map((l, i) => [l, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(p => p[0]);
    return paid.concat(waitingFree, rest);
  }

  function draw() {
    const box = el('lob');
    if (!box) return;
    if (failing && !loadedOnce) {
      box.innerHTML = '<div class="none">Could not load lobbies. Trying again…</div>';
      return;
    }
    const rows = rowsToShow();
    if (!rows.length) {
      box.innerHTML = '<div class="none">Nobody playing yet.</div>';
      return;
    }
    /* Only the list itself, and only when a row really changed: a live push lands about once a second. It used to
       call repaintAll for the row art, which restarts every moving scene on the page, the backdrop behind an open
       game panel included (Owen 2026-10-27: "the background shouldn't be updated"). Row art is a still image now. */
    const html = rows.map(rowHTML).join('');
    if (html === box._html && box.querySelector('.lr')) return;
    box.innerHTML = html;
    box._html = html;
    // The game cards' people counts are refreshed by load(), not here: draw()
    // returns early when this list is not on the page, and the cards still are.
  }

  function join(id) {
    /* A paid duel rung comes from the extras (it has a stake, so Enter stakes it through the wallet). */
    const l = PINNED.find(p => p.id === id) || LOBBIES.find(x => x.id === id)
      || EXTRAS.find(x => x.id === id && Number(x.stake) > 0 && (x.game === 'knockout' || x.game === 'battleship' || x.game === 'swim' || x.game === 'headsoccer' || x.game === 'pool8' || x.game === 'airhockey' || x.game === 'rooftop' || x.game === 'crossy') && listable(x));
    if (!l || !isOpen(l)) return;
    if (window.DS_LOCKED && window.DS_LOCKED.isLocked(l.game)) return;
    if (window.V2Play) return window.V2Play.enter(l);
    // play.js is always on the page; without it there is nothing to enter, and nothing pretends to.
  }

  /* Counts go stale the moment they are drawn, and a board that shows an empty
     room as busy sends people somewhere nobody is. Refreshed while the home
     screen is up, and stopped when it is not so a backgrounded tab is not
     polling the server forever. */
  function start() {
    load();
    stop();
    timer = setInterval(() => {
      const home = el('home');
      // Parked out of sight while Wallet is up is not showing (v2.html parkScreen).
      const up = home && (window.screenShown ? window.screenShown(home) : getComputedStyle(home).display !== 'none');
      if (up && !document.hidden) load();
    }, 10000);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  /* A tab coming back is a board that missed everything while hidden: fresh at once, not on the next tick. */
  if (typeof document.addEventListener === 'function')
    document.addEventListener('visibilitychange', () => { if (timer && !document.hidden) load(); });

  window.V2Board = { load: load, push: push, draw: draw, join: join, start: start, stop: stop,
                     playableStakes: playableStakes, rowsToShow: rowsToShow,
                     get lobbies() { return LOBBIES; },
                     get counts() { return COUNTS; },
                     /* People in a duel's queue, every rung, for the game cards: { knockout: 1 }. */
                     get waiting() {
                       const out = {};
                       EXTRAS.forEach(e => { if (Number(e.waiting) > 0) out[e.game] = (out[e.game] || 0) + Number(e.waiting); });
                       return out;
                     } };
})();
