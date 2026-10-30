// DuelSeries layer on the frozen slither.io client: product tracking for the /sl page (Owen 2026-10-29: "track
// absolutely everything", kept organized). Ours, not a parity area. Loaded by the /sl page after the named layer files
// (server/sl/slBoot.js slxTail: any other public/js/slx/*.js by name), so slxPaid, slxBr, slxWatch, slxCard and slxHud
// have all set up; it only listens.
//
// Inert unless slxNet installed the production transport, and with no helper on the page (public/js/shared/dsTrack.js
// after shared/trackPlan.js, which sl.html loads first): no listener, no node, no timer. Never per frame: one call per
// life's start and end and per watch, from the layer's own events (slxNet's tap: 'open', 'ownAdd', 'ownDead', 'close';
// the server's sl:x {t: 'cashed'} and {t: 'closed'}). It names no money: a paid page's and a paid rung's watch say
// what they are through slx.trackBase() (slxPaid, slxWatch), passed on as they give it.
//
// The page's player (DSTrack.game) is made once at load:
//   the battle royale (slxBr)       game 'br', mode 'br', free (the prize is the house's)
//   slx.trackBase() when a layer    a paid page or a paid page held by its reload mark (slxPaid), a paid rung's
//   sets it                         Spectate page (slxWatch)
//   otherwise                       game 'slither', mode 'free'
// engine 'sl' on every one (the old engine's /game.html says 'old').
//
// A life of their own starts on 'ownAdd' (the own snake in the arena; a Play again is a new game) and ends once:
//   sl:x {t: 'cashed'}              the battle royale's winner (won, place 1, the prize), else a hold-Q cash-out
//                                   (cashed_out: the length the server sent, the server's net in dollars on a paid page)
//   'ownDead'                       died: the length their gameOver wrote (slHud.js:305-310), the rank and how many
//                                   snakes their length box counts (slxHud own()); in the battle royale the place is
//                                   how many were alive as it went out, of how many started
//   sl:x {t: 'closed'}              the paid room closed the seat (refunded when money went back)
//   'close' mid-life with no dead   the connection went (ended, reason disconnect)
// A watcher's life (a Spectate page, or the battle royale's watch mode) is spectate_started once per watch, never a
// start: their client follows the watched snake as its own, so its 'ownAdd' and 'ownDead' are not this player's.
// A paid page's start and end are the server's: the helper sends nothing for them and keeps the timing, the FPS and
// ping summary and the quit signal. Leaving the page mid-life is the helper's (game_quit).
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var S = D.S;
  var T = root.DSTrack;
  if (!S || typeof slx.on !== 'function' || !T || typeof T.game !== 'function') return;

  function br() { return slx.br && typeof slx.br.mode === 'function' ? slx.br : null; }
  // The base a layer gives for this page (slxPaid, slxWatch), else null.
  function layerBase() {
    if (typeof slx.trackBase !== 'function') return null;
    try {
      var b = slx.trackBase();
      return b && typeof b === 'object' ? b : null;
    } catch (e) {
      return null;
    }
  }
  // This life is a watcher's: a Spectate page, or the battle royale in its watch mode.
  function watcher() {
    if (slx.watch) return true;
    var b = br();
    try {
      return !!b && b.mode() === 'watch';
    } catch (e) {
      return false;
    }
  }

  // ---- the page's player
  var game = br() ? 'br' : 'slither';
  var base = game === 'br' ? { paid: false, mode: 'br' } : layerBase() || { paid: false, mode: 'free' };
  base.engine = 'sl';
  var track = null;
  try {
    track = T.game(game, base);
  } catch (e) {
    track = null;
  }
  if (!track) return;
  function tracked(fn) {
    try {
      fn(track);
    } catch (e) {
      slx.errors = (slx.errors || 0) + 1;      // analytics never breaks the game
    }
  }

  // ---- what this life saw
  var ownId = 0;                                 // the own snake's id this life (the battle royale's winner check)

  // The number in their last-score line, which their gameOver writes as the snake dies (slHud.js:305-310), else null.
  function lastscore() {
    var m = S.lastscore ? /<b>\s*([0-9]+)\s*<\/b>/i.exec(String(S.lastscore.innerHTML)) : null;
    return m ? Number(m[1]) : null;
  }
  // The own length, rank and snake count their length box shows now (slxHud own()), else {}.
  function box() {
    var h = slx.hud;
    try {
      var o = h && typeof h.own === 'function' ? h.own() : null;
      return o && typeof o === 'object' ? o : {};
    } catch (e) {
      return {};
    }
  }
  function brState() {
    var b = br();
    try {
      var st = b ? b.state() : null;
      return st && typeof st === 'object' ? st : null;
    } catch (e) {
      return null;
    }
  }
  function positive(n) { return typeof n === 'number' && isFinite(n) && n > 0 ? n : undefined; }

  slx.on('open', function () {
    ownId = 0;
    if (watcher()) tracked(function (t) { if (t.stage !== 'spectating') t.spectate(); });
  });

  slx.on('ownAdd', function (ev) {
    if (watcher()) return;
    if (ev && typeof ev.id === 'number') ownId = ev.id;
    tracked(function (t) {
      var b = layerBase();                       // a paid room's own answer may have come since the page loaded
      if (b) t.set(b);
      t.start();
    });
  });

  // The life's end by a cash-out: before their `dead` (server/sl/slRoom.js _cashedOut), so it ends the life first.
  slx.on('x:cashed', function (m) {
    if (watcher()) return;
    var o = box();
    var len = m && typeof m.len === 'number' && m.len >= 0 ? Math.floor(m.len) : positive(o.length);
    var st = game === 'br' ? brState() : null;
    if (st && st.winner && ownId && st.winner.id === ownId) {
      var prize = st.soloRun ? undefined : positive(st.prize);
      tracked(function (t) { t.end({ result: 'won', place: 1, players: positive(st.startedCount), amount: prize, score: len }); });
      return;
    }
    // micro-USDC from the server on a paid page (as slxPaid shows it), none on a free one
    var net = m && typeof m.net === 'number' && m.net >= 0 ? m.net / 1e6 : 0;
    tracked(function (t) { t.end({ result: 'cashed_out', amount: net, score: len, place: positive(o.rank), players: positive(o.count) }); });
  });

  slx.on('ownDead', function (ev) {
    if (watcher()) return;
    var o = box();
    // code 2 is their close message, not a death their gameOver scored (slApply.js onDead)
    var n = ev && ev.code !== 2 ? lastscore() : null;
    var len = n !== null ? n : positive(o.length);
    if (game === 'br') {
      // out of a running match: as many were alive (this snake among them) as its place
      var st = brState();
      var running = !!st && st.state === 'running';
      tracked(function (t) {
        t.end({ result: 'died', score: len, place: running ? positive(st.alive) : undefined,
          players: running ? positive(st.startedCount) : undefined });
      });
      return;
    }
    tracked(function (t) { t.end({ result: 'died', score: len, place: positive(o.rank), players: positive(o.count) }); });
  });

  // A paid seat the room closed (slxPaid 'closed'): its money went back when refunded says so.
  slx.on('x:closed', function (m) {
    var back = !!m && typeof m.refunded === 'number' && m.refunded > 0;
    tracked(function (t) { t.end({ result: back ? 'refunded' : 'ended', reason: 'closed' }); });
  });

  // The socket went with a life on and no `dead` (slxNet resumes a blip first; this is the close that stayed).
  slx.on('close', function (info) {
    var i = info || {};
    if (!i.playing || i.sawDead) return;
    tracked(function (t) { t.end({ result: 'ended', reason: 'disconnect', score: positive(box().length) }); });
  });
})(typeof window !== 'undefined' ? window : globalThis);
