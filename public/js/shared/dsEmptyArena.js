// The empty table under a Spectate (Owen 2026-10-16: "if there's no one in the lobby and the person presses Spectate,
// then it'll just default to spectating the whole map in the middle"). Shared by the three arena pages: slither.io's
// watcher layer (public/js/slx/slxWatch.js), agar.io (public/js/ag/agMain.js) and Paper.io
// (public/js/paper/mp/paperArenaMain.js). Each page shows it when its server says nobody is there to follow, keeps
// asking again as it already did, and hides it the moment a player is followed.
//
// What it draws: the whole arena, zoomed out and centred on the middle of the map, in that game's own colours
// (slither.io's hex tile and red rim, agar.io's grid, Paper.io's floor on its sky), a Lobby button top left and one
// line at the bottom saying the view switches by itself. Nothing here talks to a server, reads money or seats anyone.
// Free rooms always have bots, so in practice this is a paid table nobody is at.
//
// DSEmptyArena.show({ game: 'snake' | 'agar' | 'paper', stake, onLobby }), .hide(), .shown(). show again only
// updates the words.
(function (root) {
  'use strict';
  var doc = root.document;
  if (!doc) return;

  var FIT = 0.92; // the arena's width as a share of the smaller side of the space between the Lobby button and the words
  var TOP = 64; // px kept clear at the top (the Lobby button)
  var BOTTOM = 96; // px kept clear at the bottom (the words)
  var LOOKS = {
    // slither.io: black, their bg54 tile (public/hexbg.jpg) inside the circle, the dark red outside and its rim
    // (public/js/sl/slDrawWorld.js drawBackground and border: #300000 and #800000 at 0.8).
    snake: { shape: 'circle', world: 2 * 16384, tile: '/hexbg.jpg', minTile: 0.16, sky: '#000000', out: '#300000',
      rim: '#800000', rimWorld: 23 },
    // agar.io: the light background and its 50 unit grid (public/js/ag/agRender.js BG_LIGHT, LINE_LIGHT), map side L2.
    agar: { shape: 'square', world: 10000 * Math.SQRT2, grid: 50, minGrid: 14, sky: 'rgb(242,251,255)',
      floor: 'rgb(242,251,255)', line: 'rgba(0,0,0,0.09)', edge: 'rgba(0,0,0,0.22)' },
    // Paper.io: the floor and its edge on the sky gradient (public/js/paper/paperSkins.js arenaColor, borderColor,
    // backgroundTopColor, backgroundBottomColor).
    paper: { shape: 'circle', world: 2, skyTop: '#2d6998', skyBottom: '#81faff', floor: '#e7fff4', rim: '#88a799' }
  };
  var WORDS = {
    nobody: 'Nobody is playing right now',
    nobodyAt: 'Nobody is playing at $',
    rightNow: ' right now',
    sub: 'Watching the whole map. You will follow the first player who joins.',
    lobby: 'Lobby'
  };

  var CSS = [
    '#ds-empty{position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147480000;display:none;overflow:hidden;',
    'touch-action:none;user-select:none;-webkit-user-select:none;font-family:Arial,Helvetica,sans-serif;}',
    '#ds-empty.on{display:block;}',
    '#ds-empty canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block;}',
    '#ds-empty-lobby{position:absolute;left:16px;top:16px;display:inline-flex;align-items:center;gap:6px;',
    'box-sizing:border-box;height:36px;margin:0;padding:0 14px 0 10px;border:1px solid #d6cdbd;border-radius:8px;',
    'background:#f5f1e8;color:#100e0b;font:700 14px Arial,sans-serif;letter-spacing:0.02em;cursor:pointer;',
    'touch-action:manipulation;}',
    '#ds-empty-lobby:hover{background:#fff;}',
    '#ds-empty-lobby:focus-visible{outline:2px solid #100e0b;outline-offset:2px;}',
    '#ds-empty-lobby svg{width:16px;height:16px;flex:none;}',
    '#ds-empty-say{position:absolute;left:16px;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));',
    'text-align:center;pointer-events:none;}',
    '#ds-empty-chip{display:inline-block;max-width:100%;box-sizing:border-box;padding:10px 16px;border-radius:10px;',
    'background:rgba(16,14,11,0.66);color:#fff;}',
    '#ds-empty-title{font:700 17px Arial,sans-serif;letter-spacing:0.01em;}',
    '#ds-empty-sub{margin-top:5px;font:400 13px Arial,sans-serif;color:rgba(255,255,255,0.8);}',
    '#ds-empty-dot{display:inline-block;width:8px;height:8px;margin:0 8px 2px 0;border-radius:50%;background:#3ccf6e;',
    'vertical-align:middle;animation:ds-empty-pulse 1.6s ease-in-out infinite;}',
    '@keyframes ds-empty-pulse{0%,100%{opacity:1;}50%{opacity:0.25;}}',
    '@media (prefers-reduced-motion:reduce){#ds-empty-dot{animation:none;}}'
  ].join('');
  var ARROW = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var box = null;
  var canvas = null;
  var titleEl = null;
  var subEl = null;
  var lobbyBtn = null;
  var look = null;
  var opts = null;
  var tile = null; // slither.io's tile image, once loaded
  var tileWanted = false;
  var on = false;

  function build() {
    if (box) return true;
    if (!doc.body) return false;
    var st = doc.createElement('style');
    st.textContent = CSS;
    (doc.head || doc.body).appendChild(st);
    box = doc.createElement('div');
    box.id = 'ds-empty';
    canvas = doc.createElement('canvas');
    box.appendChild(canvas);
    lobbyBtn = doc.createElement('button');
    lobbyBtn.id = 'ds-empty-lobby';
    lobbyBtn.type = 'button';
    lobbyBtn.innerHTML = ARROW + '<span>' + WORDS.lobby + '</span>';
    box.appendChild(lobbyBtn);
    var say = doc.createElement('div');
    say.id = 'ds-empty-say';
    titleEl = doc.createElement('div');
    titleEl.id = 'ds-empty-title';
    var dot = doc.createElement('span');
    dot.id = 'ds-empty-dot';
    titleEl.appendChild(dot);
    titleEl.appendChild(doc.createTextNode(''));
    subEl = doc.createElement('div');
    subEl.id = 'ds-empty-sub';
    var chip = doc.createElement('div');
    chip.id = 'ds-empty-chip';
    chip.appendChild(titleEl);
    chip.appendChild(subEl);
    say.appendChild(chip);
    box.appendChild(say);
    // The game under it never hears a press meant for this view (their own input handlers listen on window).
    var stop = function (e) { e.stopPropagation(); };
    var kinds = ['mousedown', 'mouseup', 'mousemove', 'touchstart', 'touchmove', 'touchend', 'pointerdown', 'wheel'];
    for (var i = 0; i < kinds.length; i++) box.addEventListener(kinds[i], stop, { passive: true });
    lobbyBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var go = opts && opts.onLobby;
      if (typeof go === 'function') {
        try { go(); } catch (err) { /* the page's own way back failed: nothing else to do here */ }
      }
    });
    doc.body.appendChild(box);
    root.addEventListener('resize', function () { if (on) draw(); });
    return true;
  }

  function loadTile() {
    if (tileWanted || !look || !look.tile || typeof root.Image !== 'function') return;
    tileWanted = true;
    var img = new root.Image();
    img.onload = function () {
      tile = img;
      if (on) draw();
    };
    img.src = look.tile;
  }

  function money(stake) {
    var s = Number(stake);
    return isFinite(s) && s > 0 ? s.toFixed(2) : '';
  }

  function words() {
    var m = money(opts && opts.stake);
    titleEl.lastChild.nodeValue = m ? WORDS.nobodyAt + m + WORDS.rightNow : WORDS.nobody;
    subEl.textContent = WORDS.sub;
  }

  function draw() {
    if (!canvas || !look) return;
    var W = root.innerWidth || doc.documentElement.clientWidth || 800;
    var H = root.innerHeight || doc.documentElement.clientHeight || 600;
    var dpr = Math.min(2, root.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    var g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    var top = H > 360 ? TOP : 16;
    var room = Math.max(80, H - top - BOTTOM);
    var cx = W / 2;
    var cy = top + room / 2;
    var side = FIT * Math.min(W - 32, room);
    var s = side / look.world; // screen px per world unit
    var r = side / 2;

    if (look.skyTop) {
      var sky = g.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, look.skyTop);
      sky.addColorStop(1, look.skyBottom);
      g.fillStyle = sky;
    } else {
      g.fillStyle = look.sky;
    }
    g.fillRect(0, 0, W, H);

    if (look.shape === 'square') {
      g.fillStyle = look.floor;
      g.fillRect(cx - r, cy - r, side, side);
      var step = look.grid * s;
      while (step < look.minGrid) step *= 2;
      g.beginPath();
      for (var x = cx; x <= cx + r; x += step) { g.moveTo(x, cy - r); g.lineTo(x, cy + r); }
      for (x = cx - step; x >= cx - r; x -= step) { g.moveTo(x, cy - r); g.lineTo(x, cy + r); }
      for (var y = cy; y <= cy + r; y += step) { g.moveTo(cx - r, y); g.lineTo(cx + r, y); }
      for (y = cy - step; y >= cy - r; y -= step) { g.moveTo(cx - r, y); g.lineTo(cx + r, y); }
      g.strokeStyle = look.line;
      g.lineWidth = 1;
      g.stroke();
      g.strokeStyle = look.edge;
      g.lineWidth = 2;
      g.strokeRect(cx - r, cy - r, side, side);
      return;
    }

    if (look.tile) {
      // outside the map: their dark red over black
      g.save();
      g.globalAlpha = 0.8;
      g.fillStyle = look.out;
      g.fillRect(0, 0, W, H);
      g.restore();
      g.save();
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.clip();
      g.fillStyle = '#000000';
      g.fillRect(cx - r, cy - r, side, side);
      if (tile) {
        var ts = Math.max(s, look.minTile);
        var pat = g.createPattern(tile, 'repeat');
        g.translate(cx, cy);
        g.scale(ts, ts);
        g.fillStyle = pat;
        g.fillRect(-r / ts, -r / ts, side / ts, side / ts);
      }
      g.restore();
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.strokeStyle = look.rim;
      g.globalAlpha = 0.8;
      g.lineWidth = Math.max(3, look.rimWorld * s);
      g.stroke();
      g.globalAlpha = 1;
      return;
    }

    // Paper.io: the floor's raised edge, then the floor
    g.beginPath();
    g.arc(cx, cy + 4, r, 0, Math.PI * 2);
    g.fillStyle = look.rim;
    g.fill();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = look.floor;
    g.fill();
  }

  function show(o) {
    var next = o || {};
    var l = LOOKS[next.game];
    if (!l || !build()) return false;
    var redraw = look !== l || !on;
    opts = next;
    look = l;
    loadTile();
    words();
    if (!on) {
      on = true;
      box.className = 'on';
    }
    if (redraw) draw();
    return true;
  }

  function hide() {
    if (!on) return false;
    on = false;
    if (box) box.className = '';
    return true;
  }

  root.DSEmptyArena = {
    show: show,
    hide: hide,
    shown: function () { return on; },
    // For headless checks: what is drawn now.
    state: function () { return { on: on, game: look ? opts && opts.game : '', tile: !!tile, tileWanted: tileWanted }; },
    WORDS: WORDS
  };
})(typeof window !== 'undefined' ? window : globalThis);
