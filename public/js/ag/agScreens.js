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
    var centre = el('center', null, 'Match Results');
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
    // GAMEOVER: the panel with this life's numbers.
    api.showStats = function (snap) {
      var v = statsValues(snap);
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

  var agScreens = {
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
