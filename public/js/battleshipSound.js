'use strict';
/* ─── Battleship: the sound ──────────────────────────────────────────────────
   The house Glass sounds (dsSfx.js engine, dsSfxGame.js library), picked by
   name. No files and nothing downloaded: the engine synthesises them once at
   page load, so a shot sounds the moment the state message lands.

   FOUR SOUNDS FOR A SHOT, AND THEY HAVE TO BE TOLD APART WITH YOUR EYES ELSEWHERE.

     miss    g.splash. The SAME sound whoever fired it, because a miss is a miss.
     hit     yours landing: g.hit pitched up a little with a soft g.explode
             under it. The only one on this screen that goes UP.
     taken   theirs landing on you: g.hurt, low and falling, the inverse of the
             good one so the two are told apart without looking.
     sunk    g.sunk, a whole ship gone: the one event worth stopping for.

   Plus three quiet ones: your turn (g.turn), your ship set down (g.click) and
   the result (g.win, g.lose). Direction still carries the meaning: up is good,
   down is bad, flat is nothing. */

(function (root) {

  var S = root.DSSfx || null, muted = false, lastShotAt = -1e9;

  /* Mute is the engine's page volume, read on every play. */
  if (S) S.setLevel(function () { return muted ? 0 : 1; });

  function now() { return root.performance ? root.performance.now() : Date.now(); }
  function play(name, opt) { return S ? S.play(name, opt) : false; }

  /* A shot's sound was just played: let the turn chime and the result follow it
     rather than land on top of it. */
  function after(ms, fn) {
    var wait = lastShotAt + ms - now();
    if (wait > 0) root.setTimeout(fn, wait); else fn();
  }

  /* Browsers stay silent until the page has been touched; the engine wakes
     itself on the first input, and this is the same wake for callers that ask. */
  function wake() { if (S) S.wake(); }

  function miss() { lastShotAt = now(); play('g.splash'); }

  function hit() {
    lastShotAt = now();
    play('g.hit', { rate: 1.12 });
    play('g.explode', { vol: 0.3 });
  }

  function taken() { lastShotAt = now(); play('g.hurt'); }

  function sunk() { lastShotAt = now(); play('g.sunk'); }

  /* Your shot is next. */
  function turn() { after(450, function () { play('g.turn'); }); }

  /* A ship set down on your board. */
  function place() { play('g.click'); }

  /* The match result: true won, false lost, anything else (a draw) is quiet. */
  function over(won) {
    if (won !== true && won !== false) return;
    after(800, function () { play(won ? 'g.win' : 'g.lose'); });
  }

  function setMuted(v) { muted = !!v; }

  root.BattleshipSound = {
    miss: miss, hit: hit, taken: taken, sunk: sunk, setMuted: setMuted, wake: wake,
    turn: turn, place: place, over: over,
  };
})(window);
