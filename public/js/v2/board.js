'use strict';
/* ─── The live board ──────────────────────────────────────────────────────────
   Shape from GET /api/live:
     { lobbies: [{ id, game, region, stake, players, bots, capacity, state }] }

   capacity is null for persistent rooms: the world grows with the crowd rather
   than filling up, so a row shows a count and not "7 of 30". The prototype's
   /30 was invented.

   Bots are counted separately from players and are not added to the number
   shown. A row saying "12 playing" when eleven are bots would be a lie told to
   someone about to stake real money. Rooms seeded with bots still appear, which
   is what keeps the board from ever being empty, but the count is honest. */

(function () {
  const el = id => document.getElementById(id);
  const money = n => Number(n) === 0 ? 'Free' : '$' + Number(n).toFixed(2);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let LOBBIES = [];
  let timer = null;

  async function load() {
    try {
      const r = await fetch('/api/live');
      const j = await r.json();
      LOBBIES = Array.isArray(j.lobbies) ? j.lobbies : [];
    } catch (_) {
      LOBBIES = [];
    }
    draw();
  }

  function rowHTML(l) {
    const g = (window.V2_GAME_NAMES || {})[l.game] || l.game;
    const n = l.players || 0;
    /* A count, shown as a count. Every row used to end in the words "0 playing"
       sitting between two other grey chips, so the line read as four scraps of
       text with a number buried in it. It is one badge now — a dot that is lit
       when anyone is in there, and the figure in the same mono the money uses —
       and the word only exists for a screen reader, which is the one reader that
       needs it spelled out. */
    const live = n > 0 ? ' on' : '';
    return '<div class="lr">' +
      '<div class="lswatch">' + (window.V2_SWATCH ? window.V2_SWATCH(l.game) : '') + '</div>' +
      '<div class="lmid">' +
        '<span class="lname">' + esc(g) + '</span>' +
        '<span class="lsub">' + esc(String(l.region).toUpperCase()) +
          '<i></i>' + '<b class="lstake num">' + money(l.stake) + '</b></span>' +
      '</div>' +
      '<span class="sp" style="flex:1"></span>' +
      '<span class="lcount' + live + '" title="Players in this lobby">' +
        '<span class="ldot" aria-hidden="true"></span>' +
        '<span class="num">' + n + '</span>' +
        '<span class="vh">' + (n === 1 ? 'player' : 'players') + '</span></span>' +
      '<button class="enter" onclick="V2Board.join(' +
        JSON.stringify(l.id).replace(/"/g, '&quot;') + ')">Enter</button>' +
      '</div>';
  }

  /* "Open lobbies" means rooms with people in them. A rung with nobody in it is
     not an open lobby, it is a buy-in you could choose, and those belong on the
     buy-in control rather than in a list of places to join. Listing all nine
     rungs every time made the board look busy while the game was empty, which
     is the opposite of what it is for. */
  const occupied = () => LOBBIES.filter(l => (l.players || 0) > 0);

  /* The one exception: the free slither.io room is always listed, even empty.
     It is the "just let me play" button — nothing to stake, nothing to think
     about — and burying it behind the buy-in stepper made starting a game a
     three-tap job from the screen whose entire purpose is starting a game.
     It still shows its real count, so an empty one says so. */
  /* agar.io runs on the fixed tiers, not on the buy-in ladder, so /api/live
     carries no rung for it and there is nothing to pin. Its free room is added
     here instead of on the server, deliberately: it is NOT put into LOBBIES,
     because refreshSteps reads that list to build the buy-in buttons and a row
     with no stake on it would put a blank rung on the control.

     stake null rather than 0 matters. enter() sends { stake } when there is
     one, and the server resolves a stake through the snake ladder — so a 0
     here would route an agar player into a snake room. With no stake it sends
     { lobbyType }, which is the door agar actually uses. */
  const AGAR_FREE = { id: 'agar:free', game: 'agar', region: 'na',
                      stake: null, lobbyType: 'free', players: 0, state: 'open' };

  /* Which buy-ins a game can actually seat right now.

     agar.io has no rungs on /api/live at all — its free room is added on this
     side — so asking the lobby list what agar offers returns nothing, and the
     buy-in control ended up with a single Free button and no hint that the
     other tiers exist. This reports what is REALLY playable, and the control
     draws the rest struck through. When agar's paid rooms do open, they will
     appear on the server and light up here with no change to this code. */
  function playableStakes(game) {
    const out = new Set();
    LOBBIES.forEach(l => { if (l.game === game) out.add(Number(l.stake)); });
    if (game === 'agar') out.add(0);          // the free room this file adds itself
    return out;
  }

  function rowsToShow() {
    const rows = occupied();
    const free = LOBBIES.find(l => Number(l.stake) === 0 && l.game === 'snake');
    if (free && !rows.some(r => r.id === free.id)) rows.unshift(free);
    rows.push(AGAR_FREE);
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
    // The cards used to be refreshed here too, to keep their player counts in
    // step with these rows. They carry the game name alone now, so there is
    // nothing on them left to go stale.
  }

  function join(id) {
    const l = id === AGAR_FREE.id ? AGAR_FREE : LOBBIES.find(x => x.id === id);
    if (!l) return;
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
                     get occupied() { return occupied(); } };
})();
