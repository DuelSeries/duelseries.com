'use strict';
/* ─── Paper Arena: the sound ─────────────────────────────────────────────────
   The house Glass sounds (dsSfx.js engine, dsSfxGame.js library), picked by
   name. No files. Nothing in the game's own scripts is edited: once the page
   has booted, this finds the arena (DuelPaperLib.arena, set by paperArenaMain)
   and listens from outside: its net hooks, the mirror's onApplied (every
   reliable entry the server sends: captures, kills, money, rings) and the
   renderer (once a frame, for the hold-to-leave ring).

     joined a table        g.join
     you closed a loop     g.capture, higher and louder for a bigger bite
     your land was cut     g.hurt (quiet)
     your trail cut / you died (own trail, wall, cut, encircled)   g.death
     you killed a square   g.kill
     a coin in your bank   g.pickup (paid tables; a kill's payout is the kill's sound)
     hold Q to leave       g.ringStart, g.ringTick every half second, g.ringCancel on letting go
     cashed out            g.cashout (paid) or a click (free leave)

   Watching a table: only the followed square's captures, kills and death, at half volume. */

(function (root) {
  const S = root.DSSfx;
  if (!S) return;
  const doc = root.document;
  const play = (name, opt) => S.play(name, opt);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const now = () => (root.performance ? root.performance.now() : Date.now());

  let A = null, game = null;
  let myPct = null, myMicro = null;
  let lastKillAt = -1e9, lastDeathAt = -1e9, lastEndAt = -1e9;
  let holdOn = false, holdMax = 0, holdStep = -1;

  /* Whose moments these are: your own square, or the followed one when watching (half volume). */
  const subject = () => {
    if (game.you) return { id: game.you, v: 1 };
    const u = A.page && A.page.watch ? game.player : null;
    return u ? { id: u.id, v: 0.5 } : null;
  };

  /* ── every reliable entry the server sends ──────────────────────────────── */
  function applied(e) {
    const who = subject();
    if (!who || !Array.isArray(e)) return;
    switch (e[0]) {
      case 'cap':                                    // ['cap', id, gain]: gain is the fraction of the map just taken
        if (e[1] === who.id && typeof e[2] === 'number') {
          play('g.capture', { vol: who.v * clamp(0.5 + e[2] * 6, 0.5, 1), rate: clamp(0.85 + e[2] * 5, 0.85, 1.4), gap: 80 });
        }
        break;
      case 'k':                                      // ['k', victim, killer, reason]
        if (e[1] === who.id) {
          if (e[3] >= 1 && e[3] <= 5) { lastDeathAt = now(); play('g.death', { vol: who.v, gap: 500 }); }
          else if (e[3] >= 7) lastEndAt = now();     // cashed out, left, disconnected: not a death
        } else if (e[2] === who.id) {
          lastKillAt = now();
          play('g.kill', { vol: who.v, gap: 150 });
        }
        break;
      case 'm':                                      // ['m', id, balance]
        if (game.you && e[1] === game.you) money(e[2]);
        break;
      case 'b':                                      // ['b', id, ver, pct, ring]: a ring changed
        if (game.you && e[1] === game.you) land();
        break;
    }
  }

  /* A balance that went up with no kill beside it is a coin picked up. A kill's own
     payout arrives just before its kill entry, so wait a moment to see which it is. */
  function money(micro) {
    const prev = myMicro;
    myMicro = micro;
    if (prev == null || !(micro > prev)) return;
    const t = now();
    root.setTimeout(() => { if (lastKillAt < t - 5) play('g.pickup', { gap: 60 }); }, 90);
  }

  /* Your land shrank (somebody else closed a loop over it). */
  function land() {
    const u = game.byId && game.byId.get(game.you);
    if (!u) return;
    const cur = u.percent || 0, prev = myPct;
    myPct = cur;
    if (prev != null && prev - cur > 0.01) play('g.hurt', { vol: 0.55, gap: 400 });
  }

  /* ── once a frame: the hold-to-leave ring ───────────────────────────────── */
  function frame() {
    if (!game.you || !A.hud || typeof A.hud.localHold !== 'function') return;
    const h = A.hud.localHold(game);
    if (h.active && !holdOn) {
      holdOn = true; holdMax = 0; holdStep = -1;
      play('g.ringStart', { gap: 0 });
    } else if (!h.active && holdOn) {
      holdOn = false;
      if (holdMax < 0.9) {                           // let go early. Not when it ran out, died or was cut off.
        const t = now();
        root.setTimeout(() => { if (lastDeathAt < t - 50 && lastEndAt < t - 50) play('g.ringCancel', { gap: 0 }); }, 150);
      }
    }
    if (holdOn && !h.waiting) {
      holdMax = Math.max(holdMax, h.fraction);
      const step = Math.floor(h.fraction * 6);       // a tick every half second of the three
      if (step >= 1 && step > holdStep) { holdStep = step; play('g.ringTick', { vol: 0.8, rate: 1 + step * 0.06, gap: 0 }); }
    }
  }

  /* ── hooking in, after the page has booted ──────────────────────────────── */
  function attach() {
    const P = root.DuelPaperLib;
    A = P && P.arena;
    if (!A || !A.game || !A.net) return false;
    game = A.game;

    const prevApplied = game.onApplied;
    game.onApplied = function () {
      if (prevApplied) prevApplied.apply(this, arguments);
      try { applied(arguments[0]); } catch (_) {}
    };
    const baseRender = game.renderer;
    if (typeof baseRender === 'function') {
      game.renderer = function (g) {
        baseRender.call(this, g);
        try { frame(); } catch (_) {}
      };
    }

    A.net.on('joined', (p) => {
      if (p && p.resumed) return;
      const u = game.player;
      myPct = u ? u.percent || 0 : null;
      myMicro = u && typeof u.micro === 'number' ? u.micro : null;
      holdOn = false;
      play('g.join');
    });
    A.net.on('pp:dead', () => {
      if (now() - lastDeathAt > 1500) { lastDeathAt = now(); play('g.death', { gap: 500 }); }
    });
    A.net.on('pp:cashedout', () => {
      lastEndAt = now();
      play(game.paid ? 'g.cashout' : 'g.click', { gap: 0 });
    });
    A.net.on('pp:refused', (p) => {
      if (p && p.why === 'warming') return;          // the table is still warming up: the page just asks again
      play('g.err', { vol: 0.7 });
    });
    return true;
  }

  /* The arena API appears when the page's scripts have all run; try then, and a few more times if not. */
  let tries = 0;
  function start() {
    if (attach() || ++tries > 20) return;
    root.setTimeout(start, 500);
  }
  if (doc && doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(window);
