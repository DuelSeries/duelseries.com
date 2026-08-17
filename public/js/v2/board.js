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
    const who = l.players === 1 ? '1 playing' : l.players + ' playing';
    return '<div class="lr">' +
      '<div class="lswatch">' + (window.V2_SWATCH ? window.V2_SWATCH(l.game) : '') + '</div>' +
      '<span class="lname">' + esc(g) + '</span>' +
      '<span class="lreg">' + esc(String(l.region).toUpperCase()) + '</span>' +
      '<span class="lstake num">' + money(l.stake) + '</span>' +
      '<span class="lplay num">' + who + '</span>' +
      '<span class="sp" style="flex:1"></span>' +
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

  function draw() {
    const box = el('lob');
    if (!box) return;
    const rows = occupied();
    if (!rows.length) {
      box.innerHTML = '<div class="none">Nobody is playing right now. ' +
        'Pick a buy-in and start a game, and it shows up here for everyone else.</div>';
      box.classList.add('short');
      if (window.V2_REFRESH_CARDS) window.V2_REFRESH_CARDS();
      return;
    }
    box.innerHTML = rows.map(rowHTML).join('');
    box.classList.toggle('short', rows.length <= 3);
    if (window.repaintAll) window.repaintAll();
    // The game cards count off this same data, so they refresh together and
    // cannot show a different number from the rows underneath them.
    if (window.V2_REFRESH_CARDS) window.V2_REFRESH_CARDS();
  }

  function join(id) {
    const l = LOBBIES.find(x => x.id === id);
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
                     get lobbies() { return LOBBIES; },
                     get occupied() { return occupied(); } };
})();
