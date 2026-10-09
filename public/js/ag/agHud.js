// Canvas HUD for the agar.io redo (FFA, mode 0): leaderboard cache and blit, the "Score:" panel,
// the bottom message panels (spectate hint, low-FPS warning, reboot notice), the dim layer with
// the start-up background, and the target-arrow block that runs every frame even when invisible.
// Our own code, written from the client-hud spec (sections 1 to 5, 9 to 11) and the build brief
// (facts 2.3, 2.6, 2.19, 2.20, 2.21). Every number below is a spec fact; the call order inside
// each block is part of the parity contract (build brief 1.1), so do not reorder canvas calls.
// Loads in the browser (DuelAgarLib.agHud) and under node.
(function (root) {
  'use strict';
  var A = root.DuelAgarLib = root.DuelAgarLib || {};

  var fround = Math.fround;

  // ---------------------------------------------------------------------------------------
  // Number helpers (client-hud 1: every HUD size is a truncation toward zero of a double)
  // ---------------------------------------------------------------------------------------

  // Truncate a double to a signed 32-bit integer; out of range (or NaN) gives INT_MIN.
  function ti(x) {
    return Math.abs(x) < 2147483648 ? (x | 0) : -2147483648;
  }
  // Signed 32-bit integer division (truncates toward zero).
  function idiv(a, b) {
    return (a / b) | 0;
  }
  // HUD scale q = min(H/1080, W/1920) in canvas pixels (client-hud 1).
  function hudScale(W, H) {
    var a = H / 1080, b = W / 1920;
    return a < b ? a : b;
  }
  function rgb(c) {
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }

  var WHITE = [255, 255, 255];
  var BLACK = [0, 0, 0];

  // Text the HUD shows (client-hud 2.3, 5.1, 5.4, 5.5, 5.7). Mode 0 has exactly two message
  // entries: "score" in state 0 and the spectate hint in state 8.
  var TEXT = {
    title: 'Leaderboard',
    unnamed: 'An unnamed cell',
    score: 'Score: ',
    spectateHint: "Press 'Q' to change Spectate Mode",
    slow1: 'Your computer is running slow',
    slow2: 'please close other applications or tabs in your browser to improve game performance.',
    reboot: 'The servers are going to be rebooted in a while.'
  };
  var STATE_PLAY = 0;
  var STATE_SPECTATE = 8;

  function hudMessage(mode, state, key) {
    if (mode !== 0) return '';
    if (key === 'score' && state === STATE_PLAY) return TEXT.score;
    if (key === 'bottom' && state === STATE_SPECTATE) return TEXT.spectateHint;
    return '';
  }

  // ---------------------------------------------------------------------------------------
  // Text line: a text drawn once into its own small canvas and re-drawn only when dirty
  // (client-hud 4.1 to 4.3). Panel lines use outline ratio 0.2 (see build notes: the spec's
  // 0.1 is the default of a fresh line, which the panel template overwrites).
  // ---------------------------------------------------------------------------------------

  function TextLine(ctx) {
    this.ctx = ctx;
    this.text = '';
    this.fs = 20;          // font size in px
    this.sc = 1;           // scale
    this.o = 0.1;          // outline ratio
    this.fill = BLACK;
    this.stroke = BLACK;
    this.alpha = 1;
    this.strokeOn = 0;
    this.dirty = 1;
    this.cw = 0;           // last canvas size written
    this.ch = 0;
    this.pad = 0;
    this.lineH = 0;
    this.w100 = 0;         // text width measured at 100 px
    this.design = 0;       // design font size (multiplied by q every frame)
  }

  // Set the text; measuring happens only when it actually changed (client-hud 4.2).
  TextLine.prototype.setText = function (text) {
    if (text === this.text) return;
    this.dirty = 1;
    this.text = text;
    this.ctx.font = '100px Ubuntu';
    this.w100 = this.ctx.measureText(text).width;
  };

  // Re-draw the line's canvas when dirty and the font is ready (client-hud 4.1).
  TextLine.prototype.render = function (fontsLoaded) {
    if (!this.dirty) return this;
    if (!fontsLoaded()) return this;
    this.dirty = 0;
    var c = this.ctx;
    var fs = this.fs;
    c.font = (~~fs) + 'px Ubuntu';
    this.lineH = ti(fs * 0.4);
    var half = this.o * fs;
    this.pad = half + half;
    this.cw = ti((c.measureText(this.text).width + this.pad + this.pad) * this.sc);
    this.ch = ti(this.sc * (fs + this.lineH));
    c.canvas.width = this.cw;
    c.canvas.height = this.ch;
    c.textBaseline = 'middle';
    c.font = (~~(fs * this.sc)) + 'px Ubuntu';
    c.globalAlpha = this.alpha;
    c.lineWidth = this.sc * fs * this.o;
    c.strokeStyle = rgb(this.stroke);
    c.fillStyle = rgb(this.fill);
    var x = ti(this.pad * this.sc);
    var y = idiv(this.ch, 2);
    if (this.strokeOn) c.strokeText(this.text, x, y);
    c.fillText(this.text, x, y);
    return this;
  };

  // Copy every field except the context and the design size (a line assignment).
  function copyLineFields(dst, src) {
    dst.text = src.text;
    dst.fs = src.fs;
    dst.sc = src.sc;
    dst.o = src.o;
    dst.fill = src.fill;
    dst.stroke = src.stroke;
    dst.alpha = src.alpha;
    dst.strokeOn = src.strokeOn;
    dst.dirty = src.dirty;
    dst.cw = src.cw;
    dst.ch = src.ch;
    dst.pad = src.pad;
    dst.lineH = src.lineH;
    dst.w100 = src.w100;
  }

  // A copy of a line on a fresh canvas sized like the source canvas. The size write is a real
  // canvas call in the reference stream (two of them per panel line, see makePanelLine).
  function cloneLine(env, src) {
    var ctx = env.createContext();
    ctx.canvas.width = src.ctx.canvas.width;
    ctx.canvas.height = src.ctx.canvas.height;
    var line = new TextLine(ctx);
    copyLineFields(line, src);
    return line;
  }

  // Create a panel line (client-hud 4.3): a template line measures the text, gets
  // fs = trunc(q * size), outline 0.2, no stroke; it is then copied twice onto fresh canvases and
  // the second copy is the one kept by the panel.
  function makePanelLine(env, q, panel, text, size, fill, stroke) {
    var t = new TextLine(env.createContext());
    t.fs = 0;
    t.sc = 1;
    t.o = 0.2;
    t.alpha = 1;
    t.fill = fill;
    t.stroke = stroke;
    t.strokeOn = 1;
    t.dirty = 1;
    t.setText(text);
    var fs = ti(q * size);
    if (fs !== t.fs) { t.fs = fs; t.dirty = 1; }
    if (t.strokeOn) { t.strokeOn = 0; t.dirty = 1; }
    var tmp = cloneLine(env, t);
    var line = cloneLine(env, tmp);
    line.design = size;
    panel.lines.push(line);
    return line;
  }

  // ---------------------------------------------------------------------------------------
  // Panels (client-hud 4.4): a black rounded box at alpha 0.3 with its lines centred on it
  // ---------------------------------------------------------------------------------------

  function Panel(marginX, marginY, designW, designH, align) {
    this.mx = marginX;   // raw, not scaled (trap T3)
    this.my = marginY;
    this.dw = designW;
    this.dh = designH;
    this.align = align;
    this.lines = [];
  }

  function roundRectPath(ctx, x, y, w, h, radius) {
    var r = radius;
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
  }

  function panelOrigin(align, W, H, x, y, w, h) {
    switch (align) {
      case 0: case 7: return [x, y];
      case 1: return [ti(W * 0.5 + w * -0.5), y];
      case 2: return [(W - (x + w)) | 0, y];
      case 3: case 4: case 6: return [x, (H - (y + h)) | 0];
      case 5: return [ti(W * 0.5 + w * -0.5), (H - (y + h)) | 0];
      default: return [0, 0];
    }
  }

  // Draw a panel (box, then each line). No FFA panel pulses, expires or stacks vertically, so
  // the line scale v is 1.
  Panel.prototype.draw = function (ctx, hud, x, y, w, h, centred) {
    var W = hud.W, H = hud.H;
    var q = hudScale(W, H);
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = 'rgb(0,0,0)';
    var o = panelOrigin(this.align, W, H, x, y, w, h);
    var X = o[0], Y = o[1];
    ctx.beginPath();
    roundRectPath(ctx, X, Y, w, h, ti(q * 8));
    ctx.fill();
    ctx.closePath();
    ctx.globalAlpha = 1;
    var v = fround(1);
    var cy = h * 0.5 + Y;
    var cx = w * 0.5 + X;
    var N = this.lines.length;
    for (var j = 0; j < N; j++) {
      var L = this.lines[j];
      var dx;
      if (!centred) {
        dx = X;
      } else {
        var hp = L.fs * L.o;
        L.pad = hp + hp;
        dx = cx + fround(v * fround(ti(L.sc * (L.pad + L.pad + L.fs * L.w100 / 100)))) * -0.5;
      }
      var oldLineH = ti(L.sc * (L.fs + ti(L.fs * 0.4)));
      L.lineH = ti(L.fs * 0.4);
      var fs = ti(q * L.design);
      if (fs !== L.fs) { L.fs = fs; L.dirty = 1; }
      L.render(hud.fontsLoaded);
      var hp2 = L.fs * L.o;
      L.pad = hp2 + hp2;
      L.lineH = ti(L.fs * 0.4);
      var dy = fround(v * fround(oldLineH)) * -0.5 * N + cy + oldLineH * j;
      var dw = fround(v * fround(ti(L.sc * (L.pad + L.pad + L.w100 / 100 * L.fs))));
      var dh = fround(v * fround(ti(L.sc * (L.fs + L.lineH))));
      var cv = L.ctx.canvas;
      ctx.drawImage(cv, 0, 0, cv.width, cv.height, dx, dy, dw, dh);
    }
  };

  // ---------------------------------------------------------------------------------------
  // Leaderboard layout (client-hud 5.1, self-test table in section 10)
  // ---------------------------------------------------------------------------------------

  var LB_ROWS = 10;
  var LB_EXTRAS = 5;

  // Pure layout numbers for a board of `count` entries with `extras` extra own rows.
  // `wide` is the 300-unit board (mode 4 or a friends list), not used in FFA.
  function layoutLeaderboard(W, H, count, extras, wide) {
    var q = hudScale(W, H);
    var uw = q * (wide ? 300 : 250);
    var p = ti(q * W) * 0.12;
    p = p < 1.2 ? p : 1.2;
    p = p > 1 ? p : 1;
    var inner = ti(uw);
    var m70 = ti(q * 70);
    var ex = extras || 0;
    var rows = count > LB_ROWS ? LB_ROWS + ex : count;
    var innerH = ti(q * ((rows * 22) >>> 0)) + m70;
    var width = ti(p * inner);
    var height = ti(p * innerH);
    var margin = ti(q * 15);
    return {
      q: q,
      scale: p,
      innerW: inner,
      innerH: innerH,
      rows: rows,
      width: width,
      height: height,
      margin: margin,
      x: (W - (width + margin)) | 0,
      y: margin,
      titleFont: ti(q * 30),
      titleY: ti(q * 40),
      rowFont: ti(q * 18),
      rowX: ti(q * 15),
      rowY: function (r) { return ti(q * ((r * 22 + 70) | 0)); }
    };
  }

  // ---------------------------------------------------------------------------------------
  // The HUD object
  // ---------------------------------------------------------------------------------------

  // env: { createContext() -> a 2D context of a NEW canvas, fontsLoaded() -> bool,
  //        menuImage: an image for the start-up background (or null) }
  function createHud(env) {
    env = env || {};
    var createContext = env.createContext || function () {
      return root.document.createElement('canvas').getContext('2d');
    };
    var fontsReady = false;
    var fontsLoaded = env.fontsLoaded || function () { return true; };
    var hud = {
      W: 0,
      H: 0,
      env: { createContext: createContext },
      fontsLoaded: function () {
        if (!fontsReady) fontsReady = !!fontsLoaded();
        return fontsReady;
      },
      menuImage: env.menuImage || null,
      namesEnabled: true,
      mode: 0,
      // leaderboard
      lbCtx: createContext(),
      lbEntries: [],
      lbHasContent: false,
      localNick: '',
      // panels (created on first use)
      scorePanel: null,
      hintPanel: null,
      slowPanel: null,
      rebootPanel: null,
      // low-FPS warning (client-hud 5.4)
      frames: 0,
      slowCount: 0,
      slowShown: 0,
      slowVisible: false,
      alive: false,
      reboot: false,
      // dim layer (client-hud 5.6, fact 2.6)
      level: 1,
      deathFlag: false,
      startup: true,
      // target arrow (client-hud 5.7)
      arrowAngle: 0,
      arrowAlpha: 0,
      arrowHad: false,
      arrowLabel: null,
      arrowLabelScale: 1
    };

    // Frame start: the canvas size is read every frame; a change re-renders the board before
    // the frame clears (client-hud 5.1 "When it is re-rendered"). Call this where the frame
    // reads the canvas size, before clearRect.
    // CH: the whole canvas height when the layout height H is shorter (the shipped page's ghost
    // strip, Owen 2026-10-08); only the dim layer covers it. Omitted = H.
    hud.frameStart = function (W, H, CH) {
      hud.CH = CH === undefined ? H : CH;
      if (W === hud.W && H === hud.H) return false;
      hud.W = W;
      hud.H = H;
      renderBoard(hud);
      return true;
    };

    // Leaderboard message (mirror { t: 'board', rows }): rows replace the list, an own row
    // ("me") shows the local nickname, then the cache is re-rendered at once.
    hud.setBoard = function (rows, localNick) {
      if (typeof localNick === 'string') hud.localNick = localNick;
      var list = [];
      for (var k = 0; k < (rows ? rows.length : 0); k++) {
        var r = rows[k] || {};
        var me = !!r.me;
        var name = me ? hud.localNick : (typeof r.name === 'string' ? r.name : '');
        list.push({ name: name, me: me });
      }
      hud.lbEntries = list;
      renderBoard(hud);
    };
    hud.setLocalNick = function (nick) { hud.localNick = String(nick || ''); };
    hud.setNames = function (on) { hud.namesEnabled = !!on; };
    hud.setMode = function (mode) { hud.mode = mode | 0; };
    hud.setReboot = function (on) { hud.reboot = !!on; };
    hud.setMenuImage = function (img) { hud.menuImage = img || null; };

    // First play request clears the start-up background (client-hud 5.6).
    hud.onPlay = function () { hud.startup = false; };
    hud.onSpawn = function () { hud.alive = true; };
    // Death: the dim layer switches to the slow 1/60 step and the board is re-rendered (6.2).
    hud.onDeath = function () {
      hud.deathFlag = true;
      hud.alive = false;
      renderBoard(hud);
    };

    // Once per second (client-hud 5.4): `fps` frames drawn in the last second; defaults to the
    // frames this HUD drew since the previous call.
    hud.everySecond = function (fps) {
      var n = typeof fps === 'number' ? fps : hud.frames;
      hud.frames = 0;
      if (!hud.alive) return;
      if (n <= 19) {
        var before = hud.slowCount;
        hud.slowCount = before + 1;
        if (before >= 5 && hud.slowShown === 0) {
          hud.slowShown = 1;
          hud.slowVisible = true;
          return;
        }
      } else {
        hud.slowCount = 0;
      }
      if (!hud.slowVisible) return;
      var shown = hud.slowShown;
      hud.slowShown = shown + 1;
      if (shown < 10) return;
      hud.slowCount = 0;
      hud.slowShown = -1;
      hud.slowVisible = false;
    };

    // The whole-client reset on every connect and disconnect (client-camera-input 2): the alive
    // flag, the low-FPS counters, the board list and its content flag go back to their start
    // values and the message panels are dropped (each is built again on first use). The dim
    // layer and the start-up switch are left alone.
    hud.reset = function () {
      hud.alive = false;
      hud.slowCount = 0;
      hud.slowShown = 0;
      hud.slowVisible = false;
      hud.lbEntries = [];
      hud.lbHasContent = false;
      hud.scorePanel = null;
      hud.hintPanel = null;
      hud.slowPanel = null;
      hud.rebootPanel = null;
    };

    hud.render = function (ctx, s) { renderHud(ctx, s, hud); };
    hud.debug = function () {
      return {
        W: hud.W, H: hud.H, level: hud.level, deathFlag: hud.deathFlag, startup: hud.startup,
        arrowAngle: hud.arrowAngle, arrowAlpha: hud.arrowAlpha, labelScale: hud.arrowLabelScale,
        lbHasContent: hud.lbHasContent, slowVisible: hud.slowVisible, slowCount: hud.slowCount,
        slowShown: hud.slowShown
      };
    };
    return hud;
  }

  // Re-render the leaderboard cache (client-hud 5.1, FFA list branch).
  function renderBoard(hud) {
    if (!hud.fontsLoaded()) return;
    hud.lbHasContent = true;
    var list = hud.lbEntries;
    var count = list.length;
    if (count === 0) { hud.lbHasContent = false; return; }
    var extras = [];
    for (var idx = LB_ROWS; idx < count && extras.length < LB_EXTRAS; idx++) {
      if (list[idx].me) extras.push(idx);
    }
    var lay = layoutLeaderboard(hud.W, hud.H, count, extras.length, hud.mode === 4);
    var c = hud.lbCtx;
    c.canvas.width = lay.width;
    c.canvas.height = lay.height;
    c.scale(lay.scale, lay.scale);
    c.globalAlpha = 0.4;
    c.fillStyle = 'rgb(0,0,0)';
    c.fillRect(0, 0, lay.innerW, lay.innerH);
    c.globalAlpha = 1;
    c.fillStyle = 'rgb(255,255,255)';
    c.font = lay.titleFont + 'px Ubuntu';
    var tw = c.measureText(TEXT.title).width;
    c.fillText(TEXT.title, ti(idiv(lay.innerW, 2) + tw * -0.5), lay.titleY);
    var row = 0;
    for (var r = 0; r < count && r < LB_ROWS; r++) {
      drawBoardRow(hud, c, lay, list[r], row, r + 1);
      row++;
    }
    for (var e = 0; e < extras.length; e++) {
      drawBoardRow(hud, c, lay, list[extras[e]], row, extras[e] + 1);
      row++;
    }
  }

  // One plain row: "<position>. <name>" (fact 2.19: the number is the list position).
  function drawBoardRow(hud, c, lay, entry, row, position) {
    var name = entry.name && hud.namesEnabled ? entry.name : TEXT.unnamed;
    var text = position + '. ' + name;
    var y = lay.rowY(row);
    c.fillStyle = entry.me ? 'rgb(255,170,170)' : 'rgb(255,255,255)';
    c.font = lay.rowFont + 'px Ubuntu';
    c.fillText(text, lay.rowX, y);
  }

  // ---------------------------------------------------------------------------------------
  // The per-frame HUD (client-hud 3: order 1, 2, 4, 10, 11, 12, 13)
  // ---------------------------------------------------------------------------------------

  // s: {
  //   mode (0), state (0 play, 8 spectate), spectating (bool), connected (bool),
  //   ownCount (own cells in the list), fadeout (menu open, bool), highestMass (number),
  //   camX, camY (camera, used only with a target), target: null or { x, y, name }
  // }
  function renderHud(ctx, s, hudArg) {
    var hud = hudArg || s.hud;
    if (!hud.W || !hud.H) { hud.W = ctx.canvas.width; hud.H = ctx.canvas.height; }
    var W = hud.W, H = hud.H;
    var q = hudScale(W, H);
    var mode = s.mode | 0;
    var state = s.state | 0;
    hud.mode = mode;
    hud.frames++;

    // 1. Leaderboard blit.
    var always = mode === 1 || mode === 2;
    if (always || (hud.lbHasContent && hud.namesEnabled && mode !== 5 && state !== 7)) {
      var m15 = ti(q * 15);
      var lbc = hud.lbCtx.canvas;
      ctx.drawImage(lbc, (W - (lbc.width + m15)) | 0, m15);
    }

    // 2. Score panel (bottom-left): the best total mass of this life (fact 2.21).
    var N = ti(s.highestMass || 0);
    if (!s.spectating && N !== 0) {
      var msg = hudMessage(mode, state, 'score');
      if (msg) {
        var text = msg + String(N);
        if (!hud.scorePanel) {
          hud.scorePanel = new Panel(15, 15, 150, 34, 6);
          makePanelLine(hud.env, q, hud.scorePanel, text, 24, WHITE, BLACK);
        }
        var sp = hud.scorePanel;
        var L = sp.lines[0];
        L.setText(text);
        var fs = ti(q * L.design);
        if (L.fs !== fs) { L.fs = fs; L.dirty = 1; }
        var hp = L.fs * L.o;
        L.pad = hp + hp;
        var w = ti(L.sc * (L.pad + L.pad + L.fs * L.w100 / 100));
        sp.draw(ctx, hud, sp.mx, sp.my, w, ti(q * sp.dh), false);
      }
    }

    // 4. Bottom message (spectate hint), not while the low-FPS warning is up.
    if (!hud.slowVisible) {
      var hint = hudMessage(mode, state, 'bottom');
      if (hint) {
        var colour = WHITE;
        if (!hud.hintPanel) {
          hud.hintPanel = new Panel(0, 15, 700, 70, 5);
          makePanelLine(hud.env, q, hud.hintPanel, hint, 24, colour, BLACK);
        }
        var hpnl = hud.hintPanel;
        var HL = hpnl.lines[0];
        if (HL.fill[0] !== colour[0] || HL.fill[1] !== colour[1] || HL.fill[2] !== colour[2]) {
          HL.fill = colour;
          HL.dirty = 1;
        }
        HL.setText(hint);
        if (hpnl.lines.length > 1) hpnl.lines.length = 1;
        var hh = ti(q * hpnl.dh);
        hpnl.draw(ctx, hud, hpnl.mx, hpnl.my, ti(q * hpnl.dw), hh, true);
      }
    }

    // 10. Low-FPS warning (two lines).
    if (hud.slowVisible) {
      if (!hud.slowPanel) {
        hud.slowPanel = new Panel(0, 15, 1100, 90, 5);
        makePanelLine(hud.env, q, hud.slowPanel, TEXT.slow1, 24, WHITE, BLACK);
        makePanelLine(hud.env, q, hud.slowPanel, TEXT.slow2, 24, WHITE, BLACK);
      }
      var slp = hud.slowPanel;
      var sh = ti(q * slp.dh);
      slp.draw(ctx, hud, slp.mx, slp.my, ti(q * slp.dw), sh, true);
    }

    // 11. Server reboot notice (only if our server ever asks for it).
    if (hud.reboot) {
      if (!hud.rebootPanel) {
        hud.rebootPanel = new Panel(0, 15, 700, 70, 5);
        makePanelLine(hud.env, q, hud.rebootPanel, TEXT.reboot, 24, WHITE, BLACK);
      }
      var rbp = hud.rebootPanel;
      var rh = ti(q * rbp.dh);
      rbp.draw(ctx, hud, rbp.mx, rbp.my, ti(q * rbp.dw), rh, true);
    }

    // 12. Dim layer and start-up background.
    drawDim(ctx, hud, s, W, H);

    // 13. Target arrow block, modes 0 and 4 (invisible at alpha 0 without a target, fact 2.20).
    if (mode === 0 || mode === 4) drawArrow(ctx, hud, s, W, H);
  }

  // Dim layer (client-hud 5.6 with the critic's correction, fact 2.6). The FFA countdown timer
  // of other modes stays 0 and is not modelled.
  function drawDim(ctx, hud, s, W, H) {
    var fadeIn = !!s.fadeout || !s.connected ||
      ((s.ownCount | 0) === 0 && !s.spectating && (s.mode | 0) !== 2);
    if (fadeIn) {
      hud.level = hud.level + (hud.deathFlag ? 1 / 60 : 0.05);
      if (hud.level > 1) { hud.level = 1; hud.deathFlag = false; }
      if (hud.startup) drawStartupImage(ctx, hud, W, H);
    } else {
      hud.startup = false;
      hud.level = hud.level + -0.05;
      if (hud.level < 0) { hud.level = 0; hud.deathFlag = false; }
    }
    ctx.globalAlpha = hud.level * 0.5;
    ctx.fillStyle = 'rgb(0,0,0)';
    // The whole canvas, including rows below the layout height (hud.CH; the same value at parity).
    ctx.fillRect(0, 0, W, hud.CH > H ? hud.CH : H);
    ctx.globalAlpha = 1;
  }

  // The start-up background, cover-fitted and centred (client-hud 5.6, fact 2.3). Our shipped
  // page passes no image (menu art is out of scope); the harness page passes its own stand-in.
  // It fits the layout height H, like every other derived size, not the ghost strip below it.
  function imageReady(img) {
    return !!img && img.complete !== false && img.width > 0;
  }
  function drawStartupImage(ctx, hud, W, H) {
    var img = hud.menuImage;
    if (!imageReady(img)) return;
    ctx.globalAlpha = hud.level;
    var iw = img.width, ih = img.height;
    var dw, dh, sH;
    if (iw / ih < W / H) {
      dw = W;
      dh = (ih * W) / iw;
      sH = H;
    } else {
      dw = (iw * H) / ih;
      dh = H;
      sH = H;
    }
    ctx.drawImage(img, 0, 0, img.width, img.height, (W - dw) * 0.5, (sH - dh) * 0.5, dw, dh);
  }

  // Target arrow (client-hud 5.7). Without a target the angle stays put, the alpha eases to 0
  // and the calls still run.
  var ARROW_TIP = [
    [-0.4999999999999998, 0.8660254037844388],
    [-0.5000000000000004, -0.8660254037844384],
    [1, 0]
  ];
  function drawArrow(ctx, hud, s, W, H) {
    var q = hudScale(W, H);
    var A0 = hud.arrowAngle;
    var sinA = Math.sin(A0);
    var cosA = Math.cos(A0);
    var t = s.target;
    var has = !!t && t.x !== 2147483647 && t.y !== 2147483647;
    var sx, sy, goal;
    if (!has) {
      sx = cosA;
      sy = sinA;
      goal = 0;
    } else {
      var dyRaw = t.y - (s.camY || 0);
      var dxRaw = t.x - (s.camX || 0);
      var len = Math.sqrt(dxRaw * dxRaw + dyRaw * dyRaw);
      if (len === 0) len = 1;
      var ny = dyRaw / len;
      var nx = dxRaw / len;
      var ey = (ny - sinA) * 0.05 + sinA;
      var ex = (nx - cosA) * 0.05 + cosA;
      hud.arrowAngle = Math.atan2(ey, ex);
      goal = 0.4;
      if (hud.arrowHad) {
        sy = ey;
        sx = ex;
      } else {
        hud.arrowAngle = Math.atan2(ny, nx);
        sy = ny;
        sx = nx;
      }
    }
    hud.arrowHad = has;
    var a = hud.arrowAlpha;
    a = (goal - a) * 0.1 + a;
    hud.arrowAlpha = a;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgb(0,0,0)';
    var inset = ti(q * 50);
    var k = has ? a / 0.4 : 1;
    var hh = H * 0.5;
    var ty = hh + k * sy * (hh - inset);
    var hw = W * 0.5;
    var tx = hw + k * sx * (hw - inset);
    ctx.translate(tx, ty);
    ctx.rotate(hud.arrowAngle);

    var lab = hud.arrowLabel;
    if (!lab) {
      lab = new TextLine(hud.env.createContext());
      lab.fs = fround(ti(q * 24));
      lab.o = 0.2;
      lab.sc = 1;
      lab.alpha = 1;
      lab.fill = BLACK;
      lab.stroke = WHITE;
      lab.strokeOn = 1;
      lab.dirty = 1;
      lab.w100 = 0;
      hud.arrowLabel = lab;
    }
    var name = has && t.name ? String(t.name) : '';
    lab.setText(name || TEXT.unnamed);
    ctx.save();
    var ang = hud.arrowAngle;
    ctx.rotate(ang < 0 ? 1.570796 : 4.712389);
    var fsL = lab.fs;
    var half = fsL * lab.o;
    var pad = half + half;
    var full = pad + pad + lab.w100 / 100 * fsL;
    var natural = fround(ti(lab.sc * full)) / hud.arrowLabelScale;
    var fit = fround(ti(q * 200)) / natural;
    fit = fit > 1 ? 1 : fit;
    hud.arrowLabelScale = fit;
    if (lab.sc !== fit) { lab.sc = fit; lab.dirty = 1; }
    lab.pad = pad;
    lab.lineH = ti(fsL * 0.4);
    lab.render(hud.fontsLoaded);
    var off = ang < 0 ? ti(q * 48) : -ti(q * 48);
    var ly = fround(off) - fround(idiv(ti((fsL + lab.lineH) * lab.sc), 2));
    var lx = fround(0) - fround(idiv(ti(full * lab.sc), 2));
    ctx.drawImage(lab.ctx.canvas, lx, ly);
    ctx.restore();
    var b = ti(q * 50);
    ctx.scale(b, b);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgb(255,255,255)';
    ctx.lineWidth = 0.15;
    ctx.beginPath();
    ctx.moveTo(ARROW_TIP[0][0], ARROW_TIP[0][1]);
    ctx.lineTo(ARROW_TIP[1][0], ARROW_TIP[1][1]);
    ctx.lineTo(ARROW_TIP[2][0], ARROW_TIP[2][1]);
    ctx.lineTo(ARROW_TIP[0][0], ARROW_TIP[0][1]);
    ctx.globalAlpha = hud.arrowAlpha;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  var agHud = {
    hudScale: hudScale,
    trunc32: ti,
    TEXT: TEXT,
    hudMessage: hudMessage,
    TextLine: TextLine,
    makePanelLine: makePanelLine,
    Panel: Panel,
    layoutLeaderboard: layoutLeaderboard,
    createHud: createHud,
    renderHud: function (ctx, state) { return renderHud(ctx, state, state.hud); }
  };
  A.agHud = agHud;
  if (typeof module !== 'undefined' && module.exports) module.exports = agHud;
})(typeof window !== 'undefined' ? window : globalThis);
