// Paper multiplayer: the arena HUD (design 8.6). One pass AFTER the unchanged renderGameFrame,
// with the world transform rebuilt from game.origin and game.scale by the maths of
// paperRender.js renderGameFrame (it never calls getRenderContext, which advances the
// follow-killer glide). It draws what the solo HUD has no notion of: coins on the floor (and
// their minimap dots), the money over every head with its count-up, the cash-out ring around
// every holding square and the centre line of the own hold. Money floaters go through the
// stock label machinery (unit.addLabel), so they look like the stock "Kill" and "+x.xx%".
// The world part of the pass is clipped out of the stock screen HUD (score bar, leaderboard,
// minimap), which is already on the canvas, so it stays under that HUD as it would in solo.
// Loads standalone under require (nothing is drawn there).
(function (root, factory) {
  'use strict';
  var api = factory(root);
  var P = root.DuelPaperLib = root.DuelPaperLib || {};
  P.Hud = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  var TWO_PI = Math.PI * 2;
  var BASE_DIAGONAL = Math.sqrt(1366 * 1366 + 768 * 768); // getRenderContext's hudScale reference
  var COUNT_UP_MS = 300; // design 8.6
  var ADOPT_AFTER_MS = 500; // a frame value that disagrees this long is taken without a floater
  var FLOATER_MS = 1000; // the stock label lifetime
  var NAME_INK = '#363331'; // paperRender.js drawUnitName
  var MONEY_FILL = '#ffc933';
  var COIN_FILL = '#ffc933';
  var COIN_RIM = '#b98a12';
  var COIN_RADIUS = 7; // world units; the pickup radius (16) is the reach, this is the look
  var COIN_BOB = 1.2; // world units
  var COIN_BOB_MS = 1600;
  var RING_GAP = 1.9; // ring radius in track widths
  var RING_FILL = '#ffc933';
  var RING_TRACK = 'rgba(0, 0, 0, 0.28)';

  function nowMs() {
    return (typeof performance !== 'undefined' ? performance : Date).now();
  }

  function money(micro) {
    return '$' + (Math.max(0, micro) / 1e6).toFixed(2);
  }

  function easeOut(t) {
    return 1 - (1 - t) * (1 - t) * (1 - t);
  }

  // getRenderContext's calcMult, the same operation order.
  function calcMult(vsw, vsh, landscapeValue, portraitValue) {
    var aspectWide = 16 / 9;
    var aspectTall = 9 / 16;
    var aspect = Math.min(aspectWide, Math.max(aspectTall, vsw / vsh));
    var valueDelta = landscapeValue - portraitValue;
    var aspectDelta = aspectTall - aspectWide;
    var intercept = -(valueDelta * aspectWide + aspectDelta * landscapeValue);
    return -(intercept + valueDelta * aspect) / aspectDelta;
  }

  // The screen HUD that renderGameFrame has already drawn by the time this pass runs
  // (paperRender.js: the score bar, best line and kill counter at the top left, the leaderboard
  // plates at the top right, the minimap disc at the bottom right), in screen pixels (the
  // stock HUD's space, the canvas scaled by 1 / dpr) and in getRenderContext's own metrics.
  // The world pass is clipped to everything else, so coins, money labels, rings and redrawn
  // squares pass UNDER the HUD, as names and labels do in solo.
  // Returns { rects: [[x, y, w, h], ...], disc: { cx, cy, rx, ry } | null }; no two overlap.
  function stockHudHoles(ctx, game, vsw, vsh, hudScale) {
    var holes = { rects: [], disc: null };
    var player = game && game.player;
    if (!player) return holes; // the stock HUD is drawn only with a player
    var fontSize = ~~(calcMult(vsw, vsh, 20, 30) * hudScale);
    var backHeight = ~~(4 * hudScale);
    var padding = ~~(16 * hudScale);
    var halfBarHeight = ~~(fontSize * 0.75);
    var barHeight = halfBarHeight * 2;
    var barWidth = ~~(vsw / calcMult(vsw, vsh, 4, 2.25));
    var halfBarWidth = ~~(barWidth / 2);
    var uiFont = fontSize + 'px ' + (game.config && game.config.font);
    function textWidth(text) {
      if (!ctx || typeof ctx.measureText !== 'function') return barWidth;
      ctx.save();
      ctx.font = uiFont;
      var w = ctx.measureText(text).width;
      ctx.restore();
      return w > 0 ? w : 0;
    }
    function scoreOf(u) {
      return u && u.schemes && typeof u.schemes.scores === 'function' ? u.schemes.scores() : 0;
    }
    function isPlayer(u) {
      return typeof game.isPlayer === 'function' ? game.isPlayer(u) : u === player;
    }

    // Top left: drawPlayerScoreBar (its shadow is always the full bar), drawBestScoreText and
    // drawKillsCounter. The best line ends 4 px above the kill pill, so they never overlap.
    holes.rects.push([0, padding, barWidth, barHeight + backHeight]);
    var bestY = padding + barHeight + backHeight + padding / 2;
    var pillY = bestY + fontSize + 4;
    var language = game.language || {};
    var bestText = language.bestTxt + ' ' +
      (player.schemes && typeof player.schemes.print === 'function' ? player.schemes.print(game.best) : '');
    holes.rects.push([padding / 2, bestY, textWidth(bestText), fontSize + 2]);
    var kills = player.statistics ? player.statistics.kills : 0;
    holes.rects.push([0, pillY, barHeight * 1.5 + textWidth('x' + kills), barHeight]);

    // Top right: drawLeaderboardPlates' rows (top five, then the player in slot 6 when not
    // listed). A plate runs from its left edge off the right of the screen; its shadow reaches
    // 3 back heights down, into the next row's band, where the narrower next plate takes over.
    var rows = [];
    var topScore = scoreOf(game.units[0]);
    var previousRatio;
    function row(unit, slot) {
      var ratio = halfBarWidth * (scoreOf(unit) / topScore);
      if (previousRatio && ratio > previousRatio - halfBarWidth * 0.05) ratio = previousRatio - halfBarWidth * 0.05;
      previousRatio = ratio;
      var left = vsw - (halfBarWidth + ratio);
      var top = padding + slot * (barHeight * 1.3);
      if (isFinite(left)) rows.push({ left: Math.max(0, left), top: top, bottom: top + barHeight + backHeight * 3 });
    }
    var listed = false;
    for (var i = 0; i < 5; i++) {
      var unit = game.units[i];
      if (!unit) continue;
      if (isPlayer(unit)) listed = true;
      row(unit, i);
    }
    if (!listed && !player.death) row(player, 6);
    for (var r = 0; r < rows.length; r++) {
      var bottom = r + 1 < rows.length ? Math.min(rows[r].bottom, rows[r + 1].top) : rows[r].bottom;
      holes.rects.push([rows[r].left, rows[r].top, vsw - rows[r].left, bottom - rows[r].top]);
    }

    // Bottom right: renderMinimap's arena disc and its frame line (3 hud px wide).
    var space = game.space;
    var border = game.border;
    if (space && space.width > 0 && space.height > 0) {
      var size = vsw / calcMult(vsw, vsh, 8, 3);
      var mx = vsw - padding - size;
      var my = vsh - padding - size;
      var sx = size / space.width;
      var sy = size / space.height;
      var edge = hudScale * 1.5 + 1;
      if (border && border.center && border.radius > 0) {
        holes.disc = {
          cx: mx + border.center.x * sx,
          cy: my + border.center.y * sy,
          rx: border.radius * sx + edge,
          ry: border.radius * sy + edge
        };
      } else {
        holes.rects.push([mx - edge, my - edge, size + edge * 2, size + edge * 2]);
      }
    }
    return holes;
  }

  // Clips ctx (its transform: the stock HUD's screen space) to the screen minus the holes.
  function clipOutHoles(ctx, holes, vsw, vsh) {
    ctx.beginPath();
    ctx.rect(0, 0, vsw, vsh);
    for (var i = 0; i < holes.rects.length; i++) {
      var h = holes.rects[i];
      if (h[2] > 0 && h[3] > 0) ctx.rect(h[0], h[1], h[2], h[3]);
    }
    var d = holes.disc;
    if (d) {
      ctx.moveTo(d.cx + d.rx, d.cy);
      ctx.ellipse(d.cx, d.cy, d.rx, d.ry, 0, 0, TWO_PI);
    }
    ctx.clip('evenodd');
  }

  // The own hold as the page shows it (8.6): the local lock, set at keydown, shows a waiting ring
  // until a frame says the server holds; once the predictor has seen a frame clear the lock
  // (released by the server while the key is still down) the ring follows the frame exactly.
  // Key up clears it at once (the predictor's holdKey).
  function localHold(game) {
    var me = game && game.player;
    var pr = game && game.predictor;
    var off = { active: false, waiting: false, fraction: 0, remainingMs: 0 };
    if (!me || me.death || !pr || !pr.holdKey) return off;
    var MP = root.DuelPaperLib && root.DuelPaperLib.MP;
    var holdTicks = game.holdTicks > 0 ? game.holdTicks : (MP ? MP.HOLD_TICKS : 180);
    var stepMs = MP ? MP.STEP_MS : 1000 / 60;
    var fraction;
    if (pr.locked()) {
      if (!me.holding) return { active: true, waiting: true, fraction: 0, remainingMs: holdTicks * stepMs };
      fraction = me.hold;
    } else {
      if (!me.holding) return off;
      fraction = me.hold;
    }
    fraction = Math.max(0, Math.min(1, fraction || 0));
    return { active: true, waiting: false, fraction: fraction, remainingMs: (1 - fraction) * holdTicks * stepMs };
  }

  // opts: { now?, onLocalHold?(state, game), holdText?(state, game) -> string }
  function create(opts) {
    opts = opts || {};
    var now = opts.now || nowMs;
    var shown = new Map(); // unit id -> { from, to, t0, off, offSince }
    var lastLocal = null;

    function valueAt(st, t) {
      if (!(t - st.t0 < COUNT_UP_MS)) return st.to;
      return st.from + (st.to - st.from) * easeOut(Math.max(0, (t - st.t0) / COUNT_UP_MS));
    }

    function entryFor(u) {
      var st = shown.get(u.id);
      if (!st) {
        st = { from: u.micro || 0, to: u.micro || 0, t0: -Infinity, off: null, offSince: 0 };
        shown.set(u.id, st);
      }
      return st;
    }

    function setTarget(u, micro, floater) {
      var t = now();
      var st = shown.get(u.id);
      if (!st) {
        shown.set(u.id, { from: micro, to: micro, t0: -Infinity, off: null, offSince: 0 });
        return;
      }
      st.off = null;
      if (micro === st.to) return;
      var before = st.to;
      st.from = valueAt(st, t);
      st.to = micro;
      st.t0 = t;
      if (floater && micro > before && typeof u.addLabel === 'function' && !u.death) {
        u.addLabel({ text: '+' + money(micro - before), color: MONEY_FILL, unit: u, time: FLOATER_MS, fading: true });
      }
    }

    var hud = {
      // pp:joined (first join, resume or respawn): every value is taken fresh from the payload.
      reset: function () {
        shown = new Map();
        lastLocal = null;
      },

      // The mirror's onApplied hook: ['m'] is the authoritative balance change (a kill or a coin
      // picked up); ['j'] carries a joining square's balance. Frames only fill in a value when
      // it disagrees for ADOPT_AFTER_MS (a one-frame flap between a bundle and a frame of
      // different ticks must not count up twice).
      onApplied: function (entry, tick, game) {
        if (!entry || !game || !game.byId) return;
        var u;
        if (entry[0] === 'm' && typeof entry[2] === 'number') {
          u = game.byId.get(entry[1]);
          if (u) setTarget(u, entry[2], true);
        } else if (entry[0] === 'j' && entry[1] && typeof entry[1].micro === 'number') {
          u = game.byId.get(entry[1].id);
          if (u) setTarget(u, entry[1].micro, false);
        }
      },

      shownMicro: function (u) {
        var st = shown.get(u.id);
        return st ? valueAt(st, now()) : u.micro || 0;
      },

      localHold: localHold,

      lastLocalHold: function () {
        return lastLocal;
      },

      draw: function (game) {
        var t = now();
        var hold = localHold(game);
        lastLocal = hold;
        if (opts.onLocalHold) opts.onLocalHold(hold, game);
        var view = game.view;
        if (!view || !game.origin || typeof view.getContext !== 'function') return;
        var ctx = view.getContext('2d');
        if (!ctx) return;
        var dpr = root.devicePixelRatio || 1;
        var vw = view.width;
        var vh = view.height;
        if (!(vw > 0 && vh > 0)) return;
        var vsw = vw * dpr;
        var vsh = vh * dpr;
        var hudScale = Math.sqrt(vsw * vsw + vsh * vsh) / BASE_DIAGONAL;
        var scale = (game.scale * hudScale) / dpr;
        var origin = game.origin;
        var config = game.config;
        var font = config.font;
        var trackWidth = config.trackWidth;
        var left = origin.x - vw / 2 / scale;
        var right = origin.x + vw / 2 / scale;
        var top = origin.y - vh / 2 / scale;
        var bottom = origin.y + vh / 2 / scale;
        function inView(x, y, margin) {
          return x >= left - margin && x <= right + margin && y >= top - margin && y <= bottom + margin;
        }

        ctx.save();
        // Under the stock screen HUD (see stockHudHoles): the clip is set in its screen space,
        // then the world transform is built on top of it.
        ctx.resetTransform();
        ctx.scale(1 / dpr, 1 / dpr);
        clipOutHoles(ctx, stockHudHoles(ctx, game, vsw, vsh, hudScale), vsw, vsh);
        ctx.resetTransform();
        ctx.translate(-(origin.x * scale - vw / 2), -(origin.y * scale - vh / 2));
        ctx.scale(scale, scale);

        // Values follow the frames when no entry has spoken for a while (see onApplied).
        for (var i = 0; i < game.units.length; i++) {
          var u = game.units[i];
          var st = entryFor(u);
          var m = u.micro || 0;
          if (m === st.to) {
            st.off = null;
          } else if (st.off !== m) {
            st.off = m;
            st.offSince = t;
          } else if (t - st.offSince >= ADOPT_AFTER_MS) {
            setTarget(u, m, false);
          }
        }

        // Coins: above land and squares' shadows, then any square standing on one is drawn
        // again on top, so a coin sits below the squares as the design asks.
        var coins = game.pickups ? Array.from(game.pickups.values()) : [];
        var covered = [];
        for (var c = 0; c < coins.length; c++) {
          var coin = coins[c];
          if (!inView(coin.x, coin.y, COIN_RADIUS * 4)) continue;
          var bob = Math.sin(((t / COIN_BOB_MS) + (coin.pid % 7) / 7) * TWO_PI) * COIN_BOB;
          var cy = coin.y + bob;
          ctx.beginPath();
          ctx.ellipse(coin.x, coin.y + COIN_RADIUS * 0.9, COIN_RADIUS * 0.8, COIN_RADIUS * 0.3, 0, 0, TWO_PI);
          ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
          ctx.fill();
          ctx.beginPath();
          ctx.arc(coin.x, cy, COIN_RADIUS, 0, TWO_PI);
          ctx.fillStyle = COIN_FILL;
          ctx.fill();
          ctx.lineWidth = COIN_RADIUS * 0.22;
          ctx.strokeStyle = COIN_RIM;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(coin.x, cy, COIN_RADIUS * 0.62, 0, TWO_PI);
          ctx.lineWidth = COIN_RADIUS * 0.1;
          ctx.stroke();
          ctx.save();
          ctx.fillStyle = COIN_RIM;
          ctx.font = 'bold ' + COIN_RADIUS * 1.1 + 'px ' + font;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('$', coin.x, cy + COIN_RADIUS * 0.06);
          ctx.restore();
          drawText(ctx, money(coin.micro), coin.x, cy + COIN_RADIUS + 1, scale, hudScale, dpr, font, 0.75, 'top');
          for (var k = 0; k < game.units.length; k++) {
            var w = game.units[k];
            var dx = w.position.x - coin.x;
            var dy = w.position.y - coin.y;
            var reach = COIN_RADIUS + trackWidth * 2;
            if (dx * dx + dy * dy < reach * reach && covered.indexOf(w) < 0) covered.push(w);
          }
        }
        var P = root.DuelPaperLib;
        for (var q = 0; q < covered.length; q++) {
          var cu = covered[q];
          if (cu.skin && cu.skin.container && P && P.drawSkinLayers) {
            P.drawSkinLayers(config, ctx, cu, cu.skin.container, true);
          }
        }

        // Money over every head, one line above the stock name; hidden at 0.
        for (var n = 0; n < game.units.length; n++) {
          var mu = game.units[n];
          if (!inView(mu.position.x, mu.position.y, trackWidth * 20)) continue;
          var val = valueAt(entryFor(mu), t);
          if (!(val >= 5000)) continue; // under half a cent prints as $0.00: hidden like 0
          drawMoneyLabel(ctx, mu, money(val), scale, hudScale, dpr, font);
        }

        // Cash-out rings: every holding square from its frame; the own square from the local lock.
        for (var r = 0; r < game.units.length; r++) {
          var ru = game.units[r];
          if (ru === game.player) continue;
          if (!ru.holding) continue;
          if (!inView(ru.position.x, ru.position.y, trackWidth * 4)) continue;
          drawRing(ctx, ru.position, trackWidth * RING_GAP, ru.hold, false, scale, hudScale, dpr, t);
        }
        if (hold.active && game.player) {
          drawRing(ctx, game.player.position, trackWidth * RING_GAP, hold.fraction, hold.waiting, scale, hudScale, dpr, t);
        }
        ctx.restore();

        // Screen space, as the stock HUD: coin dots on the minimap and the hold's centre line.
        if (!game.player) return;
        ctx.save();
        ctx.resetTransform();
        ctx.scale(1 / dpr, 1 / dpr);
        var padding = ~~(16 * hudScale);
        if (coins.length && game.space) {
          var size = vsw / calcMult(vsw, vsh, 8, 3);
          var lineWidth = (game.space.width / size) * hudScale * 3;
          ctx.save();
          ctx.translate(vsw - padding - size, vsh - padding - size);
          ctx.scale(size / game.space.width, size / game.space.height);
          ctx.fillStyle = COIN_FILL;
          ctx.strokeStyle = COIN_RIM;
          ctx.lineWidth = lineWidth / 3;
          for (var d = 0; d < coins.length; d++) {
            ctx.beginPath();
            ctx.arc(coins[d].x, coins[d].y, lineWidth * 1.1, 0, TWO_PI);
            ctx.fill();
            ctx.stroke();
          }
          ctx.restore();
        }
        if (hold.active) {
          var fontSize = ~~(calcMult(vsw, vsh, 20, 30) * hudScale);
          var text = opts.holdText ? opts.holdText(hold, game) : defaultHoldText(hold);
          ctx.font = fontSize + 'px ' + font;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          var x = vsw / 2;
          var y = vsh * 0.7;
          ctx.lineWidth = Math.max(2, fontSize / 6);
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
          ctx.lineJoin = 'round';
          ctx.strokeText(text, x, y);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(text, x, y);
        }
        ctx.restore();
      }
    };
    return hud;
  }

  function defaultHoldText(hold) {
    if (hold.waiting) return 'Cashing out, release to cancel';
    return 'Cashing out ' + (hold.remainingMs / 1000).toFixed(1) + ' s, release to cancel';
  }

  // paperRender.js drawUnitName's recipe (font, ink stroke and shadow), gold, one line higher.
  function drawMoneyLabel(ctx, unit, text, viewScale, hudScale, dpr, fontFamily) {
    var fontPx = (24 * hudScale) / dpr;
    var shadowUnit = (4 * hudScale) / dpr;
    ctx.save();
    ctx.translate(unit.position.x, unit.position.y);
    ctx.scale(1.001 / viewScale, 1.001 / viewScale);
    ctx.font = fontPx + 'px ' + fontFamily;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    var offsetY = ~~(-12 * viewScale) - fontPx * 1.05;
    ctx.lineWidth = shadowUnit / 4;
    ctx.strokeStyle = NAME_INK;
    ctx.shadowColor = NAME_INK;
    ctx.shadowBlur = shadowUnit / 2;
    ctx.strokeText(text, 0, offsetY);
    ctx.fillStyle = NAME_INK;
    ctx.fillText(text, 2, offsetY + 2);
    ctx.fillStyle = MONEY_FILL;
    ctx.shadowColor = MONEY_FILL;
    ctx.shadowBlur = shadowUnit / 3;
    ctx.fillText(text, 0, offsetY);
    ctx.restore();
  }

  // Small screen-sized text at a world point (coin amounts).
  function drawText(ctx, text, x, y, viewScale, hudScale, dpr, fontFamily, size, baseline) {
    var fontPx = (24 * hudScale * size) / dpr;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1 / viewScale, 1 / viewScale);
    ctx.font = fontPx + 'px ' + fontFamily;
    ctx.textAlign = 'center';
    ctx.textBaseline = baseline;
    ctx.lineWidth = fontPx / 5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = NAME_INK;
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = COIN_FILL;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  // A track circle and the filled arc from 12 o'clock; waiting (the lock set, no frame has
  // confirmed the server's hold yet) is a turning dashed circle.
  function drawRing(ctx, pos, radius, fraction, waiting, viewScale, hudScale, dpr, t) {
    var lw = (5 * hudScale) / dpr / viewScale;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, TWO_PI);
    ctx.lineWidth = lw;
    ctx.strokeStyle = RING_TRACK;
    ctx.stroke();
    if (waiting) {
      var dash = radius * 0.35;
      ctx.setLineDash([dash, dash]);
      ctx.lineDashOffset = -((t / 400) % 2) * dash;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, TWO_PI);
      ctx.strokeStyle = 'rgba(255, 201, 51, 0.8)';
      ctx.stroke();
    } else if (fraction > 0) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, -Math.PI / 2, -Math.PI / 2 + TWO_PI * Math.min(1, fraction));
      ctx.strokeStyle = RING_FILL;
      ctx.stroke();
    }
    ctx.restore();
  }

  return {
    create: create,
    localHold: localHold,
    calcMult: calcMult,
    stockHudHoles: stockHudHoles,
    money: money,
    COUNT_UP_MS: COUNT_UP_MS
  };
});
