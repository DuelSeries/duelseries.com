/* The battle royale's join window, in the lobby (Owen 2026-10-25: a match every 6 hours, 30 s to join).

   For the 30 s before each slot the server says br.joinOpen (/api/live, server/slBr/brAutoStart.js). While it does,
   the Events tab beats gold on every width (the PC bar and the phone's), one toast says "Battle royale starting" and
   opens Events on a tap, a Glass call sounds as the window opens, and a soft tick counts the last 5 s. All of it is
   for everyone: Owen's PC reports reduced motion, and an alert that skips there looks broken to him (the CSS carries
   its own !important pair, like the loading rings). Sounds go through DSSound, so Settings > Sound and an open game
   frame silence them as they do every other lobby sound.

   It asks /api/live itself, rarely: once at load, then timed to wake just before the next window (nextInSec), and
   every 2 s inside it. Nothing while the page is hidden. The Events tab's own poll feeds it too (feed). */
(function () {
  var IN_MS = 2000;            // the poll inside the window
  var FAR_MS = 10 * 60 * 1000; // the longest sleep between polls outside it
  var br = null, at = 0, on = false, card = null, timer = 0, beat = 0, lastTick = -1;

  function secsLeft() {
    return br ? Math.max(0, (br.nextInSec || 0) - Math.floor((Date.now() - at) / 1000)) : 0;
  }
  function win() { return (br && br.joinWindowSec) || 30; }
  function eventsUp() {
    var s = document.getElementById('events-screen');
    return !!s && getComputedStyle(s).display !== 'none';
  }
  /* The nav is redrawn on every route change (drawNav reads on() too), so the class is put back every beat. */
  function mark() {
    var b = document.querySelector('#nav .ni[data-tab="events"]');
    if (b && b.classList.contains('brcall') !== on) b.classList.toggle('brcall', on);
  }
  function sound(name) { if (window.DSSound) try { DSSound.play(name); } catch (_) {} }

  function step() {
    mark();
    if (card && eventsUp()) { card.close(); card = null; }
    /* The last 5 s before the slot (not a due start waiting on the arena, whose next slot is 6 hours off). */
    var s = secsLeft();
    if (br && br.nextInSec <= win() && s >= 1 && s <= 5 && s !== lastTick) { lastTick = s; sound('brtick'); }
  }

  function begin() {
    on = true; lastTick = -1;
    mark();
    /* Already on Events: the screen says it all, the call alone. Elsewhere one toast, its sound the call
       (sounds.js SPECIAL); over an open game it waits in DSToast and is closed with the window, never shown late. */
    if (eventsUp() || !window.DSToast) sound('brcall');
    else card = DSToast.show({ kind: 'info', title: 'Battle royale starting', detail: 'Join now. Free to enter.',
      ms: (Math.min(secsLeft(), win()) + 2) * 1000, onTap: function () { if (typeof window.go === 'function') window.go('events'); } });
    clearInterval(beat);
    beat = setInterval(step, 250);
  }
  function end() {
    on = false;
    clearInterval(beat); beat = 0;
    if (card) { card.close(); card = null; }
    mark();
  }

  function plan() {
    clearTimeout(timer);
    var ms = FAR_MS;
    if (on) ms = IN_MS;
    else if (br && br.nextInSec > 0) ms = Math.max(IN_MS, Math.min(FAR_MS, (secsLeft() - win() - 2) * 1000));
    timer = setTimeout(pull, ms);
  }
  function pull() {
    if (document.hidden) { plan(); return; }
    fetch('/api/live', { cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (j) { feed(j && j.br); }, plan);
  }
  /* One answer from the server, from here or from the Events tab's poll. */
  function feed(b) {
    br = b && typeof b === 'object' ? b : null;
    at = Date.now();
    var open = !!(br && br.joinOpen);
    if (open && !on) begin();
    else if (!open && on) end();
    plan();
  }

  document.addEventListener('visibilitychange', function () { if (!document.hidden) pull(); });

  window.V2BrCall = { feed: feed, on: function () { return on; }, pull: pull };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pull);
  else pull();
})();
