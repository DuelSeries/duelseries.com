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
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let LOBBIES = [];
  let EXTRAS = [];
  /* Playing each game (every human in all its rooms plus the bots in its rows
     here, so card and rows agree), for the count on each game card. Null when
     the poll failed, so the cards hide it. */
  let COUNTS = null;
  let timer = null;

  async function load() {
    try {
      const r = await fetch('/api/live');
      const j = await r.json();
      LOBBIES = Array.isArray(j.lobbies) ? j.lobbies : [];
      EXTRAS = Array.isArray(j.extras) ? j.extras : [];
      COUNTS = j.counts && typeof j.counts === 'object' ? j.counts : null;
    } catch (_) {
      LOBBIES = [];
      EXTRAS = [];
      COUNTS = null;
    }
    draw();
    if (window.V2_paintCounts) window.V2_paintCounts();
  }

  function rowHTML(l) {
    const g = (window.V2_GAME_NAMES || {})[l.game] || l.game;
    const n = (l.players || 0) + (l.bots || 0);
    /* A count, shown as a count. Every row used to end in the words "0 playing"
       sitting between two other grey chips, so the line read as four scraps of
       text with a number buried in it. It is one badge now — a dot that is lit
       when anyone is in there, and the figure in the same mono the money uses —
       and the word only exists for a screen reader, which is the one reader that
       needs it spelled out. */
    const live = n > 0 ? ' on' : '';
    /* The word is on the badge, not hidden behind it. This count is the only
       one on the screen now — the one that used to sit under the game's name is
       gone — so it has to say what it is counting rather than leave a bare
       figure floating next to a button. */
    return '<div class="lr">' +
      '<div class="lswatch">' + (window.V2_SWATCH ? window.V2_SWATCH(l.game) : '') + '</div>' +
      '<div class="lmid">' +
        '<span class="lname">' + esc(g) + '</span>' +
        '<span class="lsub">' + esc(String(l.region).toUpperCase()) +
          '<i></i>' + '<b class="lstake num">' + money(l.stake) + '</b></span>' +
      '</div>' +
      '<span class="sp" style="flex:1"></span>' +
      '<span class="lcount' + live + '">' +
        '<span class="ldot" aria-hidden="true"></span>' +
        '<span class="num">' + n + '</span> playing</span>' +
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
  const occupied = () => LOBBIES.filter(l => (l.players || 0) > 0 && isOpen(l));

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
    /* Paper and agar.io are not pinned here. Their rooms are on the server and
       /api/live reports a row per rung (paper:na:s0, ag:na:s0, ...), so their
       Free comes off the real board in rowsToShow. */
  ];

  /* Which buy-ins a game can actually seat right now: a rung counts only while
     the server lists a room for it AND that room is open. The buy-in control
     draws every other rung struck through. For agar.io that is how the paid
     rungs stay shut while AG_PAID is off: the server lists only its free rung
     (ag:na:s0) then, so $0.10 and $1.00 are drawn struck through, as Paper's
     were before PAPER_PAID. */
  function playableStakes(game) {
    const out = new Set();
    LOBBIES.forEach(l => { if (l.game === game && isOpen(l)) out.add(Number(l.stake)); });
    return out;
  }

  function rowsToShow() {
    const rows = occupied();
    const free = LOBBIES.find(l => Number(l.stake) === 0 && l.game === 'snake');
    if (free && !rows.some(r => r.id === free.id)) rows.unshift(free);
    /* Paper's and agar.io's free rungs are always listed, from the server's own
       row (paper:na:s0, ag:na:s0), in that order: the order the pinned rows had. */
    ['paper', 'agar'].forEach(g => LOBBIES.forEach(l => {
      if (l.game === g && Number(l.stake) === 0 && !rows.includes(l)) rows.push(l);
    }));
    PINNED.forEach(p => {
      if (rows.some(r => r.id === p.id)) return;
      /* A locked game (shared/lockedGames.js) has no room behind its row, so
         it is not listed. Its pinned entry stays above for when it unlocks. */
      if (window.DS_LOCKED && window.DS_LOCKED.isLocked(p.game)) return;
      /* The pinned row keeps its own id, stake and door — those are what make
         it work — and takes only its population from the server. */
      const live = EXTRAS.find(e => e.id === p.id);
      rows.push(live ? Object.assign({}, p, { players: live.players, bots: live.bots }) : p);
    });
    return rows;
  }

  function draw() {
    const box = el('lob');
    if (!box) return;
    const rows = rowsToShow();
    if (!rows.length) {
      box.innerHTML = '<div class="none">Nobody is playing right now. ' +
        'Pick a buy-in and start a game, and it shows up here for everyone else.</div>';
      box.classList.add('short');
      return;
    }
    box.innerHTML = rows.map(rowHTML).join('');
    box.classList.toggle('short', rows.length <= 3);
    if (window.repaintAll) window.repaintAll();
    // The game cards' people counts are refreshed by load(), not here: draw()
    // returns early when this list is not on the page, and the cards still are.
  }

  function join(id) {
    const l = PINNED.find(p => p.id === id) || LOBBIES.find(x => x.id === id);
    if (!l || !isOpen(l)) return;
    if (window.DS_LOCKED && window.DS_LOCKED.isLocked(l.game)) return;
    if (window.V2Play) return window.V2Play.enter(l);
    alert('Entering a ' + money(l.stake) + ' lobby.');
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
      if (home && getComputedStyle(home).display !== 'none' && !document.hidden) load();
    }, 10000);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  window.V2Board = { load: load, draw: draw, join: join, start: start, stop: stop,
                     playableStakes: playableStakes,
                     get lobbies() { return LOBBIES; },
                     get counts() { return COUNTS; },
                     get occupied() { return occupied(); } };
})();
