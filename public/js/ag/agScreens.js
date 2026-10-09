// Death screen, per-life stats, mass graph and the minimal name entry for the agar.io redo.
// Our own code, written from the client-hud spec section 6 (stats, death, respawn, spectate)
// and the build brief (facts 2.7, 2.19, 2.21; scope section 3). The graph is canvas, drawn into
// #statsGraph (350 x 170) at the moment of death; its call order is part of the parity contract
// (build brief 1.1), so do not reorder canvas calls. The card and the "Match Results" panel
// follow client-hud 6.3; the name entry and the settings block on the card are ours, in the
// DuelSeries look (client-hud 8: "our lobby styles may replace the menu shell").
// Loads in the browser (DuelAgarLib.agScreens) and under node (the pure parts).
(function (root) {
  'use strict';
  var A = root.DuelAgarLib = root.DuelAgarLib || {};

  var fround = Math.fround;

  // The Match Results title (client-hud 6.3), and ours for a free-room cash-out (CHOSEN, PARITY-LOG 2026-10-09).
  var STATS_TITLE = 'Match Results';
  var CASHED_OUT_TITLE = 'Cashed Out';

  function ti(x) {
    return Math.abs(x) < 2147483648 ? (x | 0) : -2147483648;
  }

  // ---------------------------------------------------------------------------------------
  // Per-life stats (client-hud 6.1)
  // ---------------------------------------------------------------------------------------

  // Mass of one own cell for the score and the graph: floor(f32(f32(s*s) / 100)) on the
  // PACKET size (fact 2.21), all in single precision.
  function cellScoreMass(size) {
    var s = fround(size);
    var m = Math.floor(fround(fround(s * s) / 100));
    return ti(m);
  }

  // Where the own row sits on a board message (client-hud 5.1): position (1-based index of the
  // first own row) or 0, and the "onBoard" byte that drives leaderboard time (trap T5: it is 1
  // when the list is empty or has no own row).
  function boardPlace(rows) {
    var n = rows ? rows.length : 0;
    for (var i = 0; i < n; i++) {
      if (rows[i] && rows[i].me) return { position: i + 1, onBoard: i < 10 };
    }
    return { position: 0, onBoard: true };
  }

  function createLifeStats() {
    var st = {
      spawnTime: 0,
      foodEaten: 0,
      highestMass: 0,
      leaderTime: 0,
      cellsEaten: 0,
      virusesEaten: 0,
      topPosition: 0,
      onBoard: false,
      history: [],
      rgb: [0, 0, 0],
      alive: false
    };

    // First own cell of a life (own list was empty): frame time and the cell colour.
    st.spawn = function (now, rgb) {
      st.spawnTime = now;
      st.alive = true;
      if (rgb) st.rgb = [rgb[0] | 0, rgb[1] | 0, rgb[2] | 0];
    };

    // One processed eat (fact 2.7, protocol-semantics 3.2): counted only when an own cell eats
    // a node that is not own. e = { eaterOwn, eatenOwn, food, ejected (flag 0x20),
    // flag40 (0x40), virus }.
    st.eat = function (e) {
      if (!e || !e.eaterOwn || e.eatenOwn) return null;
      if (e.food) { st.foodEaten++; return 'food'; }
      if (e.ejected) {
        if (e.flag40) { st.foodEaten++; return 'food'; }
        if (e.virus) { st.virusesEaten++; return 'virus'; }
        return null;
      }
      if (e.virus) { st.virusesEaten++; return 'virus'; }
      st.cellsEaten++;
      return 'cell';
    };

    // Board message: best position this life and the onBoard byte.
    st.applyBoard = function (rows) {
      var p = boardPlace(rows);
      if (p.position) st.topPosition = st.topPosition ? Math.min(st.topPosition, p.position) : p.position;
      st.onBoard = p.onBoard;
      return p;
    };

    // End-of-frame bookkeeping (client-hud 6.1, HUD frame step 14): f = { spectating,
    // ownSizes: packet sizes of own cells, dt: ms since the previous drawn frame }.
    // Returns the mass pushed, or -1 when nothing was recorded.
    st.frame = function (f) {
      if (f.spectating) return -1;
      var sizes = f.ownSizes || [];
      if (sizes.length === 0) return -1;
      if (st.onBoard) st.leaderTime = st.leaderTime + (f.dt || 0);
      var mass = 0;
      for (var i = 0; i < sizes.length; i++) mass = mass + cellScoreMass(sizes[i]);
      st.history.push(fround(mass));
      st.highestMass = mass < st.highestMass ? st.highestMass : mass;
      return mass;
    };

    // Zero everything this life counted. Runs at a death (after the snapshot) and in the
    // whole-client reset on every connect and disconnect (client-camera-input 2), so a life
    // never starts from the previous connection's numbers.
    st.reset = function () {
      st.spawnTime = 0;
      st.foodEaten = 0;
      st.highestMass = 0;
      st.leaderTime = 0;
      st.cellsEaten = 0;
      st.virusesEaten = 0;
      st.topPosition = 0;
      st.onBoard = false;
      st.history = [];
      st.alive = false;
    };

    // Death: a snapshot for the panel and the graph, then the death-time board refresh
    // (rows = the last board) and the reset of everything this life counted.
    st.death = function (now, rows) {
      var snap = {
        foodEaten: st.foodEaten,
        highestMass: st.highestMass,
        timeAlive: now - st.spawnTime,
        leaderTime: st.leaderTime,
        cellsEaten: st.cellsEaten,
        topPosition: st.topPosition,
        virusesEaten: st.virusesEaten,
        history: st.history.slice(),
        rgb: st.rgb.slice()
      };
      if (rows) st.applyBoard(rows);
      st.reset();
      return snap;
    };
    return st;
  }

  // ---------------------------------------------------------------------------------------
  // Mass graph (client-hud 6.2): drawn only with at least 2 samples
  // ---------------------------------------------------------------------------------------

  // Pure maths: the moveTo point and every lineTo point for a canvas of gw x gh.
  function graphPoints(history, gw, gh) {
    var n = history.length;
    if (n < 2) return null;
    var top = 200;
    for (var i = 0; i < n; i++) {
      var v = fround(history[i]);
      top = top > v ? top : v;
    }
    var span = gh + -10;
    var start = [0, gh - fround(history[0]) / top * span + 10];
    var pts = [];
    var last = n - 1;
    var g = 1;
    while (g < n) {
      var sum = 0, cnt = 0;
      for (var a = -20; a <= 20; a++) {
        var b = a + g;
        if (b >= 0 && b < n) { cnt++; sum = sum + fround(history[b]); }
      }
      var y = gh - sum / cnt / top * span + 10;
      var x = ((Math.imul(g, gw) / last) | 0);
      pts.push([x, y]);
      var step = (n / gw) | 0;
      g = (step <= 1 ? 1 : step) + g;
    }
    return { top: top, start: start, points: pts };
  }

  // Draw the graph into ctx (the #statsGraph context). The canvas is cleared even when there is
  // too little history to draw.
  function drawMassGraph(ctx, history, rgb) {
    var gw = ctx.canvas.width, gh = ctx.canvas.height;
    ctx.clearRect(0, 0, gw, gh);
    var g = graphPoints(history, gw, gh);
    if (!g) return false;
    var colour = 'rgb(' + (rgb[0] | 0) + ',' + (rgb[1] | 0) + ',' + (rgb[2] | 0) + ')';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(g.start[0], g.start[1]);
    for (var i = 0; i < g.points.length; i++) ctx.lineTo(g.points[i][0], g.points[i][1]);
    ctx.stroke();
    ctx.globalAlpha = 0.5;
    ctx.lineTo(gw, gh);
    ctx.lineTo(0, gh);
    ctx.fill();
    ctx.globalAlpha = 1;
    return true;
  }

  // ---------------------------------------------------------------------------------------
  // Death panel values (client-hud 6.3)
  // ---------------------------------------------------------------------------------------

  function formatSeconds(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var sec = '' + (s % 60);
    var min = '' + Math.floor(s / 60);
    if (sec.length < 2) sec = '0' + sec;
    return min + ':' + sec;
  }

  // The six stat boxes, in DOM order: [key, value text, label, side, top].
  var STAT_BOXES = [
    ['food', 'food eaten', 'left', 10],
    ['mass', 'highest mass', 'right', 10],
    ['alive', 'time alive', 'left', 45],
    ['board', 'leaderboard time', 'right', 45],
    ['cells', 'cells eaten', 'left', 80],
    ['top', 'top position', 'right', 80]
  ];

  function statsValues(snap) {
    return {
      food: String(snap.foodEaten),
      mass: String(Math.floor(snap.highestMass)),
      alive: formatSeconds(snap.timeAlive),
      board: formatSeconds(snap.leaderTime),
      cells: String(snap.cellsEaten),
      top: snap.topPosition === 0 ? ':(' : String(snap.topPosition)
    };
  }

  // Layout facts of the panel (client-hud 6.3), used by the stylesheet below and the tests.
  var LAYOUT = {
    card: { width: 325, height: 302, radius: 10, padding: 10 },
    stats: { width: 306, height: 300 },
    graph: { width: 350, height: 170, bottom: 100, opacity: 0.4 },
    box: { width: 120, height: 100, side: 20 },
    value: { top: 25, lineHeight: 100, fontSize: 12, color: '#444' },
    label: { top: 50, lineHeight: 15, fontSize: 15, color: '#000' },
    rule: { bottom: 100 },
    cont: { width: 306, height: 34, bottom: 15 },
    nickMax: 15,
    menuFit: { width: 1600, height: 800 }
  };

  // The drawing settings (build brief scope 3) and their defaults, which are the reference's:
  // names on, colours on, show mass off, dark off, quality "Retina". The labels are ours.
  var SETTINGS_DEFAULTS = { names: true, colors: true, showMass: false, dark: false, quality: 'Retina' };
  var SETTING_BOXES = [
    ['names', 'Names'],
    ['colors', 'Colours'],
    ['showMass', 'Show mass'],
    ['dark', 'Dark theme']
  ];
  var QUALITY_OPTIONS = [
    ['Retina', 'Retina'],
    ['High', 'High'],
    ['Medium', 'Medium'],
    ['Low', 'Low'],
    ['VeryLow', 'Very low']
  ];

  // Menu scale (client-hud 6.3): min(1, innerWidth/1600, h/800), h = the window height above the
  // bottom strip (real or ghost; agMain passes it).
  function menuScale(w, h) {
    return Math.min(1, w / LAYOUT.menuFit.width, h / LAYOUT.menuFit.height);
  }

  // Our stylesheet. Two kinds of rules:
  // - the Match Results card's facts (client-hud 6.3): the menu box placement, the font and the
  //   text colour the panel inherits from it, the card (#ag-card: white, radius 10, 325 x 302,
  //   margin 5px 0, padding 10), the button base the Continue button uses, and every rule from
  //   #ag-stats down. The death-panel DOM diff checks these; do not restyle them.
  // - CHOSEN, ours (client-hud 8: our lobby styles may replace the menu shell): the name entry,
  //   its buttons and the settings block (#ag-name and everything in it), in the DuelSeries
  //   colours: ink #100e0b, bone #f5f1e8, line #d6cdbd, label #6f6556 and the product's amber
  //   #f0a830 on Play only. No colour or size of the reference's own menu is used there.
  //   The name entry fits the card's fixed 280 px: title 40, name 40, Play 8 + 40,
  //   Spectate / Sound 8 + 32, settings 10 + 3 rows of 28 + 2 gaps of 6 = 274.
  var SCREENS_CSS = [
    '#ag-menu{position:fixed;left:50%;top:45%;transform:translate(-50%,-50%);z-index:20;font-family:Arial,sans-serif;color:#343434;}',
    '#ag-menu[hidden]{display:none;}',
    // The reference menu box (client-hud 6.3): 985 x 600 at top 45%, the 325 px card at the top
    // of its middle column, 330 = (985 - 325) / 2. Mouse screens only: phones keep the bare card.
    '@media not all and (pointer: coarse){#ag-menu{width:985px;height:600px;box-sizing:border-box;padding:0 330px;}}',
    '#ag-card{position:relative;background-color:#fff;border-radius:10px;margin:5px 0;width:325px;height:302px;box-sizing:content-box;}',
    '#ag-card .ag-play-container{position:relative;padding:10px;}',
    '.ag-btn{display:inline-block;margin-bottom:0;font-size:15px;font-weight:bold;line-height:1.42857143;text-align:center;white-space:nowrap;vertical-align:middle;touch-action:manipulation;cursor:pointer;user-select:none;background-image:none;border:1px solid transparent;border-radius:4px;font-family:Arial,sans-serif;}',
    '.ag-btn-primary{color:#fff;background-color:#428bca;border-color:#357ebd;height:35px;}',
    // ---- ours (CHOSEN) ----
    '#ag-name{position:relative;height:280px;text-align:center;color:#100e0b;font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;}',
    '#ag-name h2{margin:2px 0 8px;font-size:28px;line-height:30px;font-weight:800;letter-spacing:-0.02em;}',
    '#ag-nick{display:block;box-sizing:border-box;width:100%;height:40px;margin:0;padding:0 12px;border:1px solid #d6cdbd;border-radius:8px;background:#f5f1e8;color:#100e0b;font-family:inherit;font-size:16px;font-weight:600;}',
    '#ag-nick::placeholder{color:#6f6556;font-weight:400;}',
    '#ag-nick:focus{outline:2px solid #100e0b;outline-offset:2px;background:#fff;}',
    '#ag-name .ag-btn{font-family:inherit;line-height:1;border-radius:8px;}',
    '#ag-play{display:block;box-sizing:border-box;width:100%;height:40px;margin:8px 0 0;padding:0;border:0;background:#f0a830;color:#100e0b;font-size:17px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;}',
    '#ag-play:hover{background:#f4b955;}',
    '#ag-play:active{transform:translateY(1px);}',
    '#ag-name .ag-row{display:flex;gap:8px;margin-top:8px;}',
    '#ag-spectate,#ag-sound{display:block;flex:1 1 0;box-sizing:border-box;width:auto;min-width:0;height:32px;margin:0;padding:0 8px;border:1px solid #d6cdbd;background:#fff;color:#100e0b;font-size:14px;font-weight:600;}',
    '#ag-spectate:hover,#ag-sound:hover{background:#f5f1e8;}',
    '#ag-name button:focus-visible,#ag-name select:focus-visible,#ag-name input[type=checkbox]:focus-visible{outline:2px solid #100e0b;outline-offset:2px;}',
    '#ag-settings{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px;text-align:left;}',
    '#ag-settings .ag-opt{display:flex;align-items:center;gap:7px;box-sizing:border-box;height:28px;margin:0;padding:0 10px;border-radius:8px;background:#f5f1e8;color:#100e0b;font-size:13px;font-weight:600;cursor:pointer;user-select:none;-webkit-user-select:none;}',
    '#ag-settings .ag-opt input{margin:0;width:15px;height:15px;accent-color:#100e0b;cursor:pointer;}',
    '#ag-settings .ag-opt:has(input:checked){background:#100e0b;color:#f5f1e8;}',
    '#ag-settings .ag-opt:has(input:checked) input{accent-color:#f0a830;}',
    '#ag-settings .ag-quality{grid-column:1 / -1;justify-content:space-between;cursor:default;}',
    '#ag-settings .ag-quality span{color:#6f6556;}',
    '#ag-settings select{height:22px;padding:0 4px;border:1px solid #d6cdbd;border-radius:6px;background:#fff;color:#100e0b;font-family:inherit;font-size:13px;font-weight:600;}',
    // ---- the Match Results panel (client-hud 6.3) ----
    '#ag-stats{display:inline-block;position:relative;width:306px;height:300px;overflow:hidden;}',
    '#ag-stats[hidden]{display:none;}',
    '#ag-stats > h2{margin-top:10px;}',
    '#statsGraph{position:absolute;bottom:100px;left:0;right:0;opacity:0.4;}',
    '#ag-stats .ag-stat{position:absolute;width:120px;height:100px;}',
    '#ag-stats .ag-stat-left{left:20px;}',
    '#ag-stats .ag-stat-right{right:20px;}',
    '#ag-stats .ag-stat-value{position:absolute;top:25px;left:0;right:0;line-height:100px;font-size:12px;cursor:default;color:#444;text-align:center;font-weight:bold;}',
    '#ag-stats .ag-stat-label{position:absolute;left:0;right:0;line-height:15px;font-size:15px;color:#000;text-align:center;top:50px;}',
    '#ag-stats > hr{position:absolute;bottom:100px;width:100%;margin:0;height:0;box-sizing:content-box;}',
    '#statsContinue{position:absolute;width:306px;bottom:15px;height:34px;left:0;right:0;}'
  ].join('\n');

  // ---------------------------------------------------------------------------------------
  // DOM: the menu card with the name entry and the "Match Results" panel
  // ---------------------------------------------------------------------------------------

  // opts: { doc, root (where to append; default body), onPlay(name), onSpectate(), onContinue(),
  //         injectCss (default true), soundButton (an element to place on the name panel),
  //         settings (values to show, see SETTINGS_DEFAULTS), onSettings({ key: value }) }
  function createScreens(opts) {
    opts = opts || {};
    var doc = opts.doc || root.document;
    var host = opts.root || doc.body;
    if (opts.injectCss !== false && !doc.getElementById('ag-screens-css')) {
      var style = doc.createElement('style');
      style.id = 'ag-screens-css';
      style.textContent = SCREENS_CSS;
      (doc.head || host).appendChild(style);
    }

    function el(tag, attrs, text) {
      var e = doc.createElement(tag);
      if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      return e;
    }

    var menu = el('div', { id: 'ag-menu' });
    var card = el('div', { id: 'ag-card' });
    var pc = el('div', { 'class': 'ag-play-container' });
    card.appendChild(pc);
    menu.appendChild(card);

    // Name entry (HOME).
    var namePanel = el('div', { id: 'ag-name' });
    namePanel.appendChild(el('h2', null, 'agar.io'));
    var nick = el('input', { id: 'ag-nick', type: 'text', maxlength: String(LAYOUT.nickMax), placeholder: 'Nick', autocomplete: 'off', spellcheck: 'false' });
    namePanel.appendChild(nick);
    var playBtn = el('button', { id: 'ag-play', type: 'button', 'class': 'ag-btn' }, 'Play');
    namePanel.appendChild(playBtn);
    var row = el('div', { 'class': 'ag-row' });
    var specBtn = el('button', { id: 'ag-spectate', type: 'button', 'class': 'ag-btn' }, 'Spectate');
    row.appendChild(specBtn);
    if (opts.soundButton) row.appendChild(opts.soundButton);
    namePanel.appendChild(row);

    // Settings that change the drawing (build brief scope 3). The page owns the values; this
    // block shows them and reports each change through opts.onSettings({ key: value }).
    var settingsBox = el('div', { id: 'ag-settings', role: 'group', 'aria-label': 'Settings' });
    var boxes = {};
    for (var si = 0; si < SETTING_BOXES.length; si++) {
      var sb = SETTING_BOXES[si];
      var lbl = el('label', { 'class': 'ag-opt' });
      var cb = el('input', { type: 'checkbox', 'data-setting': sb[0] });
      lbl.appendChild(cb);
      lbl.appendChild(el('span', null, sb[1]));
      settingsBox.appendChild(lbl);
      boxes[sb[0]] = cb;
      cb.addEventListener('change', settingChanged(sb[0], cb));
    }
    var qLabel = el('label', { 'class': 'ag-opt ag-quality' });
    qLabel.appendChild(el('span', null, 'Quality'));
    var qSelect = el('select', { 'data-setting': 'quality' });
    for (var qi = 0; qi < QUALITY_OPTIONS.length; qi++) {
      qSelect.appendChild(el('option', { value: QUALITY_OPTIONS[qi][0] }, QUALITY_OPTIONS[qi][1]));
    }
    qLabel.appendChild(qSelect);
    settingsBox.appendChild(qLabel);
    qSelect.addEventListener('change', function () {
      if (opts.onSettings) opts.onSettings({ quality: qSelect.value });
    });
    namePanel.appendChild(settingsBox);
    pc.appendChild(namePanel);

    function settingChanged(key, box) {
      return function () {
        var change = {};
        change[key] = !!box.checked;
        if (opts.onSettings) opts.onSettings(change);
      };
    }
    // Show the page's values: { names, colors, showMass, dark: booleans, quality: a name }.
    function showSettings(values) {
      values = values || {};
      for (var key in boxes) {
        if (Object.prototype.hasOwnProperty.call(boxes, key) && typeof values[key] === 'boolean') boxes[key].checked = values[key];
      }
      if (typeof values.quality === 'string') qSelect.value = values.quality;
    }
    showSettings(SETTINGS_DEFAULTS);
    if (opts.settings) showSettings(opts.settings);

    // Match Results (GAMEOVER). #statsGraph keeps its width/height as attributes so creating it
    // writes no canvas size through script.
    var stats = el('div', { id: 'ag-stats', hidden: '' });
    var h2 = el('h2');
    var centre = el('center', null, STATS_TITLE);
    h2.appendChild(centre);
    stats.appendChild(h2);
    var graph = doc.getElementById('statsGraph');
    if (!graph) graph = el('canvas', { id: 'statsGraph', width: String(LAYOUT.graph.width), height: String(LAYOUT.graph.height) });
    stats.appendChild(graph);
    var valueEls = {};
    for (var i = 0; i < STAT_BOXES.length; i++) {
      var b = STAT_BOXES[i];
      var box = el('div', { 'class': 'ag-stat ag-stat-' + b[2], 'data-stat': b[0] });
      box.style.top = b[3] + 'px';
      var val = el('span', { 'class': 'ag-stat-value' }, '');
      var lab = el('span', { 'class': 'ag-stat-label' }, b[1]);
      box.appendChild(val);
      box.appendChild(lab);
      stats.appendChild(box);
      valueEls[b[0]] = val;
    }
    stats.appendChild(el('hr'));
    var contBtn = el('button', { id: 'statsContinue', type: 'button', 'class': 'ag-btn ag-btn-primary' }, 'Continue');
    stats.appendChild(contBtn);
    pc.appendChild(stats);
    host.appendChild(menu);

    var api = {
      menu: menu,
      nick: nick,
      graph: graph,
      graphContext: function () { return graph.getContext('2d'); },
      isOpen: function () { return !menu.hidden; },
      state: 'HOME'
    };

    function focusNick() {
      try { nick.focus(); } catch (e) { /* focus can fail on hidden or detached nodes */ }
    }
    // HOME: name entry and Play.
    api.showHome = function () {
      api.state = 'HOME';
      stats.hidden = true;
      namePanel.hidden = false;
      menu.hidden = false;
      focusNick();
    };
    // GAMEOVER: the panel with this life's numbers. opts.title: our free-room cash-out (Owen 2026-10-08: the run
    // ends with a results screen, no money) shows the same panel under CASHED_OUT_TITLE; a death keeps the
    // reference's title.
    api.showStats = function (snap, opts) {
      var v = statsValues(snap);
      var title = opts && typeof opts.title === 'string' ? opts.title : STATS_TITLE;
      if (centre.textContent !== title) centre.textContent = title;
      for (var k in valueEls) if (Object.prototype.hasOwnProperty.call(valueEls, k)) valueEls[k].textContent = v[k];
      api.state = 'GAMEOVER';
      namePanel.hidden = true;
      stats.hidden = false;
      menu.hidden = false;
    };
    api.hide = function () {
      menu.hidden = true;
    };
    // Menu box scale (client-hud 6.3), set by agMain on start-up, resize and quality changes.
    api.setScale = function (k) {
      menu.style.transform = 'translate(-50%, -50%)' + (k !== 1 ? ' scale(' + k + ')' : '');
    };
    api.setNick = function (name) { nick.value = String(name || '').slice(0, LAYOUT.nickMax); };
    api.setSettings = showSettings;
    api.settingsControls = { boxes: boxes, quality: qSelect };

    function play() {
      var name = String(nick.value || '').slice(0, LAYOUT.nickMax);
      api.state = 'PLAY';
      api.hide();
      if (opts.onPlay) opts.onPlay(name);
    }
    playBtn.addEventListener('click', play);
    nick.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); play(); }
    });
    specBtn.addEventListener('click', function () {
      api.state = 'SPECTATE';
      api.hide();
      if (opts.onSpectate) opts.onSpectate();
    });
    contBtn.addEventListener('click', function () {
      api.showHome();
      if (opts.onContinue) opts.onContinue();
    });
    return api;
  }

  // ---------------------------------------------------------------------------------------
  // Paid end card (ours, PAID-AGAR-DESIGN 6 "#ag-paid-end"): a separate overlay built from the shared end card's
  // classes (public/css/cashout.css co-*; the wrapper and its colours are in ag.css), never the parity-locked
  // #ag-stats panel. Built on first use, so the free page's DOM never has it. cashout.css and the card's fonts are
  // added to the head by loadPaidStyles once a paid room starts (agMain, at ag:joined with a stake or ag:money), so
  // the free page's head stays as it was and the card is styled by the time it shows.
  // ---------------------------------------------------------------------------------------

  var HOUSE_CUT_PCT = 10;   // server/paperPayout.js: the house keeps floor(gross / 10), Owen's 90/10
  var TX_URL = 'https://solscan.io/tx/';   // Paper's explorer link (public/js/paper/mp/paperArenaMain.js pp:paid)
  var PAID_CSS_URL = '/css/cashout.css';
  // The faces cashout.css names (Archivo, IBM Plex Mono): the same Google Fonts request as public/game.html, whose
  // #cashout-screen uses the same card.
  var PAID_FONT_URL = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap';
  // Texts CHOSEN (PARITY-LOG 2026-10-09 client-cashout), the figures are the server's own.
  var PAID_TEXT = {
    cashedTitle: 'Cashed out',
    autoTitle: 'Cashed out automatically',
    deadTitle: 'Eaten',
    closedTitle: 'Refunded',
    closedEmptyTitle: 'Room closed',
    heldTitle: 'On hold',
    sending: 'Sending to your wallet',
    recorded: 'Your payout is recorded and goes to your wallet.',
    sent: 'Sent to your wallet. ',
    view: 'View transaction',
    delayed: 'Payout delayed. Your winnings are recorded and will be sent.',
    // ag:closed by its why (server/ag/agRoom.js _paidClosed, agMoney emergencySettle / shutdownSettle / houseSettle)
    closed: 'The room closed on our side, so your whole balance goes back to your wallet, no house cut.',
    restart: 'The server is restarting, so your whole balance goes back to your wallet, no house cut, once it is back.',
    closedEmpty: 'The room closed on our side. Any balance you had goes back to your wallet in full, no house cut.',
    held: 'Something went wrong on our side. Your balance is held for review, to be paid back to your wallet by hand.',
    lobby: 'Back to lobby'
  };

  // Adds cashout.css and its fonts to the head once (paid rooms only). Safe to call again; never throws.
  function loadPaidStyles(doc) {
    try {
      doc = doc || root.document;
      if (!doc || !doc.head || doc.getElementById('ag-pe-css')) return false;
      var urls = [['ag-pe-css', PAID_CSS_URL], ['ag-pe-fonts', PAID_FONT_URL]];
      for (var i = 0; i < urls.length; i++) {
        var link = doc.createElement('link');
        link.setAttribute('id', urls[i][0]);
        link.setAttribute('rel', 'stylesheet');
        link.setAttribute('href', urls[i][1]);
        doc.head.appendChild(link);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function usd(micro) {
    return '$' + (Math.max(0, Number(micro) || 0) / 1e6).toFixed(2);
  }

  // opts: { doc, root (default body), onLobby() }
  function createPaidEnd(opts) {
    opts = opts || {};
    var doc = opts.doc || root.document;
    var host = opts.root || doc.body;
    loadPaidStyles(doc);
    function el(tag, attrs, text) {
      var e = doc.createElement(tag);
      if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      return e;
    }
    var wrap = el('div', { id: 'ag-paid-end', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ag-pe-title', hidden: '' });
    var card = el('div', { 'class': 'co-card' });
    var eyebrow = el('p', { 'class': 'co-eyebrow', id: 'ag-pe-title' }, '');
    var amount = el('p', { 'class': 'co-amount', id: 'ag-pe-amount' }, '');
    var sub = el('p', { 'class': 'co-sub', id: 'ag-pe-sub' }, '');
    var ledger = el('dl', { 'class': 'co-ledger', id: 'ag-pe-ledger' });
    function ledgerRow(label, cut, net) {
      var row = el('div', { 'class': 'co-row' + (net ? ' co-net' : '') });
      var dt = el('dt', null, label);
      if (cut) dt.appendChild(el('i', null, HOUSE_CUT_PCT + '%'));
      var dd = el('dd', null, '');
      row.appendChild(dt);
      row.appendChild(dd);
      ledger.appendChild(row);
      return dd;
    }
    var grossEl = ledgerRow('Cashed out', false, false);
    var cutEl = ledgerRow('House cut ', true, false);
    var netEl = ledgerRow('You receive', false, true);
    var settle = el('p', { 'class': 'co-settle', id: 'ag-pe-settle', 'data-state': 'pending' });
    settle.appendChild(el('span', { 'class': 'co-dot', 'aria-hidden': 'true' }));
    var settleText = el('span', { id: 'co-settle-text' }, PAID_TEXT.sending);
    settle.appendChild(settleText);
    var tx = el('a', { id: 'ag-pe-tx', href: '#', target: '_blank', rel: 'noopener noreferrer', hidden: '' }, PAID_TEXT.view);
    settle.appendChild(tx);
    // A restake's error or wait line (agPaid: the lobby wallet's answer to Play again), hidden until it has text.
    var errLine = el('p', { 'class': 'co-sub', id: 'ag-pe-error', role: 'status', hidden: '' }, '');
    var btns = el('div', { 'class': 'co-btns' });
    // Play again (agPaid, framed paid pages only, after a death or a cash-out): a new buy-in through the lobby's
    // wallet (duel:restake), shown by setAgain; every show below hides it again.
    var againBtn = el('button', { type: 'button', 'class': 'co-btn co-go', id: 'ag-pe-again', hidden: '' }, 'Play again');
    var lobbyBtn = el('button', { type: 'button', 'class': 'co-btn co-go', id: 'ag-pe-lobby' }, PAID_TEXT.lobby);
    btns.appendChild(againBtn);
    btns.appendChild(lobbyBtn);
    var parts = [eyebrow, amount, sub, ledger, settle, errLine, btns];
    for (var i = 0; i < parts.length; i++) card.appendChild(parts[i]);
    wrap.appendChild(card);
    host.appendChild(wrap);
    lobbyBtn.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (lobbyBtn.disabled) return;
      if (typeof opts.onLobby === 'function') opts.onLobby();
    });
    againBtn.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      if (againBtn.disabled || againBtn.hidden) return;
      if (typeof api.onAgain === 'function') api.onAgain();
    });

    var api = { element: wrap, kind: '', state: '', onAgain: null };
    function show(kind, withAmount) {
      amount.hidden = withAmount === false;
      api.kind = kind;
      wrap.setAttribute('data-kind', kind);
      wrap.hidden = false;
      errLine.hidden = true;
      errLine.textContent = '';
      againBtn.hidden = true;
      againBtn.disabled = false;
      lobbyBtn.hidden = false;
      lobbyBtn.disabled = false;
      lobbyBtn.className = 'co-btn co-go';
    }
    function setSettle(state, text) {
      api.state = state;
      settle.setAttribute('data-state', state);
      settleText.textContent = text;
    }
    // ag:cashedout { grossMicro, cutMicro, netMicro, resumed?, auto? }: display only, the server's own numbers. A
    // resumed receipt (agPaidDoor answerOutcome: the page asked again after the payout was ordered) gets no ag:paid
    // later, so its line says the payout is recorded instead of waiting on one.
    api.showCashed = function (p) {
      p = p || {};
      var gross = Number(p.grossMicro) || 0, cut = Number(p.cutMicro) || 0;
      var net = p.netMicro !== undefined ? Number(p.netMicro) || 0 : gross - cut;
      eyebrow.textContent = p.auto === true ? PAID_TEXT.autoTitle : PAID_TEXT.cashedTitle;
      amount.textContent = usd(net);
      sub.textContent = 'Cashed out ' + usd(gross) + ', you receive ' + usd(net) + ' (' + HOUSE_CUT_PCT + '% house)';
      grossEl.textContent = usd(gross);
      cutEl.textContent = '-' + usd(cut);
      netEl.textContent = usd(net);
      ledger.hidden = false;
      tx.hidden = true;
      settle.hidden = false;
      setSettle('pending', p.resumed === true ? PAID_TEXT.recorded : PAID_TEXT.sending);
      show('cashed');
    };
    // ag:dead { lostMicro, by }
    api.showDead = function (p) {
      p = p || {};
      var by = typeof p.by === 'string' && p.by ? p.by : '';
      eyebrow.textContent = PAID_TEXT.deadTitle;
      amount.textContent = usd(p.lostMicro);
      sub.textContent = 'You lost ' + usd(p.lostMicro) + (by ? ' to ' + by : '');
      ledger.hidden = true;
      settle.hidden = true;
      show('dead');
    };
    // ag:closed { refundedMicro, why }. 'emergency' (the room stopped), 'shutdown' and 'crash' (a restart: owed
    // refund rows the drainer pays once the server is back): Owen Q6, 100% back, no rake. 'frozen-settled' (the
    // zombie backstop, design 3.4 step 5): the balance went to the house as agar_breach for a refund by hand, so it
    // is never called a refund here. A zero amount (nothing left, or a seat whose account is still settling) shows
    // no figure.
    api.showClosed = function (p) {
      p = p || {};
      var why = typeof p.why === 'string' ? p.why : '';
      var micro = Math.max(0, Number(p.refundedMicro) || 0);
      ledger.hidden = true;
      settle.hidden = true;
      if (why === 'frozen-settled') {
        eyebrow.textContent = PAID_TEXT.heldTitle;
        amount.textContent = '';
        sub.textContent = PAID_TEXT.held;
        show('held', false);
        return;
      }
      if (micro <= 0) {
        eyebrow.textContent = PAID_TEXT.closedEmptyTitle;
        amount.textContent = '';
        sub.textContent = PAID_TEXT.closedEmpty;
        show('closed', false);
        return;
      }
      eyebrow.textContent = PAID_TEXT.closedTitle;
      amount.textContent = usd(micro);
      sub.textContent = why === 'shutdown' || why === 'crash' ? PAID_TEXT.restart : PAID_TEXT.closed;
      show('closed');
    };
    // ag:paid { sig }: the payout landed; the link opens the explorer (network: a cluster other than mainnet).
    api.paid = function (sig, network) {
      if (typeof sig !== 'string' || !sig) return false;
      var q = network && network !== 'mainnet-beta' ? '?cluster=' + encodeURIComponent(network) : '';
      setSettle('done', PAID_TEXT.sent);
      tx.setAttribute('href', TX_URL + encodeURIComponent(sig) + q);
      tx.hidden = false;
      settle.hidden = false;
      return true;
    };
    // ag:payerror { message }: the payout is recorded as owed and the drainer sends it.
    api.payError = function (message) {
      setSettle('fail', typeof message === 'string' && message ? message : PAID_TEXT.delayed);
      tx.hidden = true;
      settle.hidden = false;
    };
    // The paid hand-off's own states (agPaid): a refusal or an ended seat (kind 'refused' or 'gone': a title, a plain
    // line, an optional second line such as the refund, and Back to lobby), and the wait while joining or getting a
    // seat back (kind 'wait': the pending dot and its line; Back to lobby only when opts.lobby says so, because a
    // join in flight may already hold the player's money).
    api.showMessage = function (kind, title, text, extra) {
      eyebrow.textContent = title || '';
      amount.textContent = '';
      sub.textContent = text || '';
      ledger.hidden = true;
      tx.hidden = true;
      settle.hidden = !extra;
      if (extra) setSettle('info', extra);
      show(kind === 'gone' ? 'gone' : 'refused', false);
    };
    api.showWait = function (title, text, o) {
      eyebrow.textContent = title || '';
      amount.textContent = '';
      sub.textContent = '';
      ledger.hidden = true;
      tx.hidden = true;
      settle.hidden = false;
      setSettle('pending', text || '');
      show('wait', false);
      lobbyBtn.hidden = !(o && o.lobby === true);
    };
    // Play again: o = { text, disabled } shows it (Back to lobby turns into the quiet button beside it); null hides it.
    api.setAgain = function (o) {
      if (!o) {
        againBtn.hidden = true;
        lobbyBtn.className = 'co-btn co-go';
        return;
      }
      againBtn.textContent = o.text || 'Play again';
      againBtn.disabled = o.disabled === true;
      againBtn.hidden = false;
      lobbyBtn.className = 'co-btn co-ghost';
    };
    // Back to lobby shut while a Play again buy-in is with the lobby's wallet (Paper's lockLobby).
    api.setLobbyLocked = function (locked) { lobbyBtn.disabled = locked === true; };
    api.setError = function (text) {
      errLine.textContent = text || '';
      errLine.hidden = !text;
    };
    api.hide = function () { wrap.hidden = true; };
    api.shown = function () { return !wrap.hidden; };
    return api;
  }

  var agScreens = {
    STATS_TITLE: STATS_TITLE,
    CASHED_OUT_TITLE: CASHED_OUT_TITLE,
    PAID_TEXT: PAID_TEXT,
    PAID_CSS_URL: PAID_CSS_URL,
    PAID_FONT_URL: PAID_FONT_URL,
    loadPaidStyles: loadPaidStyles,
    createPaidEnd: createPaidEnd,
    usd: usd,
    cellScoreMass: cellScoreMass,
    boardPlace: boardPlace,
    createLifeStats: createLifeStats,
    graphPoints: graphPoints,
    drawMassGraph: drawMassGraph,
    formatSeconds: formatSeconds,
    statsValues: statsValues,
    STAT_BOXES: STAT_BOXES,
    LAYOUT: LAYOUT,
    SETTINGS_DEFAULTS: SETTINGS_DEFAULTS,
    SETTING_BOXES: SETTING_BOXES,
    QUALITY_OPTIONS: QUALITY_OPTIONS,
    menuScale: menuScale,
    SCREENS_CSS: SCREENS_CSS,
    createScreens: createScreens
  };
  A.agScreens = agScreens;
  if (typeof module !== 'undefined' && module.exports) module.exports = agScreens;
})(typeof window !== 'undefined' ? window : globalThis);
