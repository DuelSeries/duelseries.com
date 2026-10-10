// slither.io redo: the in-game HUD (build brief section 11 "slHud", spec draw-world-hud.md section 3).
// Owns the DOM around the game canvas: the leaderboard (header, scores, names, positions), the "Your length / Your
// rank" box, "Today's longest", the minimap holder with its background image, two map canvases, "server N" label
// and own dot, the login layer with the last score, and every fade of those elements.
//
// Rules this module keeps:
// - Every HUD element is in sl.html with its inline style and a data-sl="<their name>" attribute; init binds them.
//   Fades are inline style.opacity writes, made in their order with the same numbers (the harness reads them).
// - State lives on S under their names. slApply initialises the shared keys (lb_fr, mm*, rank, ...); init here sets
//   only login_fr, login_iv, llgmtm, lgbsc, lgcsc, mmal, locu_mtm and u_m (brief 10.3).
// - The start fade is a real setInterval of 25 ms, like theirs, so timer and frame interleave the same way.
// - Menu parts of their blocks (nick box, Play button, tips, skin and server buttons, team score bar) are OUT; the
//   other writes of the same blocks are kept in order. The optional slLoop.hooks.onMenuShow / onMenuFade /
//   onMenuDone are called where their menu writes sit (no parity effect; the later Play UI layer hooks in there).
// - Nothing happens at script load; boot calls init(S).
(function (root) {
  'use strict';
  var D = root.DuelSlither = root.DuelSlither || {};

  var PI2 = 2 * Math.PI;            // game.js:125
  var LB_W = 180;                   // game.js:1426, width of the names column
  var GPU = 'translateZ(0)';        // game.js:115
  var WHITE = '#FFFFFF';
  var NO_CELLS = [];

  // data-sl labels bound by init, each stored on S under the same name (brief 10.5 step 4)
  var BOUND = ['lbh', 'lbs', 'lbn', 'lbp', 'lbf', 'vcm', 'loch', 'loc', 'asmc', 'asmc2', 'sid_tf', 'myloc', 'login',
    'lastscore'];

  var S = null;

  function st() {
    return S || D.S;
  }

  function now() {
    return D.slLoop.now();
  }

  function menuHook(name, arg) {
    var h = D.slLoop && D.slLoop.hooks;
    if (h && typeof h[name] === 'function') h[name](arg);
  }

  // ---- strings by language (lang = first 2 chars of navigator.language, game.js:20-21) ----

  function boardTitle(lang) {       // game.js:1444-1447
    if (lang == 'de') return 'Bestenliste';
    if (lang == 'fr') return 'Gagnants';
    if (lang == 'pt') return 'Líderes';
    return 'Leaderboard';
  }

  function lengthWords(lang) {      // game.js:6664-6706 (yl, ofstr, rstr)
    if (lang == 'de') return ['Deine Länge', 'von', 'Dein rang'];
    if (lang == 'fr') return ['Votre longueur', 'de', 'Ton rang'];
    if (lang == 'pt') return ['Seu comprimento', 'do', 'Seu classificação'];
    if (lang == 'es') return ['Tu longitud', 'de', 'Tu rango'];
    return ['Your length', 'of', 'Your rank'];
  }

  function finalWords(lang) {       // game.js:9049-9052 (no es branch in theirs)
    if (lang == 'de') return 'Deine endgültige Länge war';
    if (lang == 'fr') return 'Votre longueur finale était de';
    if (lang == 'pt') return 'Seu comprimento final foi de';
    return 'Your final length was';
  }

  function scaleText(sc) {
    return 'scale(' + sc + ',' + sc + ')';
  }

  // Score of a length and fullness, the expression of game.js:6708 and 9048 (tables from setMscps, 1990-2008).
  function scoreAt(s, sct, fam) {
    return Math.floor((s.fpsls[sct] + fam / s.fmlts[sct] - 1) * 15 - 5) / 1;
  }

  // ---- load ----

  function init(state) {
    S = state;
    var doc = root.document;
    for (var i = 0; i < BOUND.length; i++) {
      var el = doc.querySelector('[data-sl="' + BOUND[i] + '"]');
      if (!el) throw new Error('slHud: sl.html has no data-sl="' + BOUND[i] + '" element');
      S[BOUND[i]] = el;
    }
    S.u_m = [64, 32, 16, 8, 4, 2, 1];   // game.js:968, bit of each of the 7 cells in a map byte
    S.lgbsc = 1;                        // game.js:1112-1117
    S.lgcsc = 1;
    S.login_fr = 0;
    S.llgmtm = now();
    S.login_iv = -1;
    S.mmal = 0;                         // game.js:2014
    S.locu_mtm = 0;                     // game.js:7077

    S.lbh.textContent = boardTitle(S.lang);
    // A boolean IDL property: Chrome stores the attribute as translate="yes" (game.js:1472, quirk kept).
    S.lbn.translate = 'no';

    // Own dot image: a 14 x 14 white disc with a black ring, drawn once (game.js:1579-1589).
    var lc = doc.createElement('canvas');
    lc.width = lc.height = 14;
    var c = lc.getContext('2d');
    c.fillStyle = WHITE;
    c.strokeStyle = '#000000';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(7, 7, 2.5, 0, PI2);
    c.stroke();
    c.fill();
    // src, then class, then the styles, in their order (game.js:1589-1596): loch.innerHTML is compared, so the
    // attribute order and the inline style order of its children must be theirs. sl.html gives myloc only data-sl.
    var dot = S.myloc;
    dot.src = lc.toDataURL();
    dot.className = 'nsi';
    dot.style.position = 'absolute';
    dot.style.left = '0px';
    dot.style.top = '0px';
    dot.style.opacity = 1;
    dot.style.zIndex = 13;
    dot.style.transform = GPU;
  }

  // ---- game start: packet a (game.js:7368-7383, non-team branch) ----

  function reposLbf() {             // game.js:6793-6801, non-team branch
    var s = st();
    s.lbf.style.bottom = 4 + s.hsu + 'px';
    s.lbf.style.height = '37px';
  }

  // slApply calls this at the end of packet a, after its state steps, smus and setMscps (brief 10.4 row 22).
  function onInit() {
    var s = st();
    s.lbf.style.left = '8px';
    s.mmsta = .475;
    reposLbf();
    setMinimapSize(24, true);
    s.lbh.style.display = 'inline';
    s.lbs.style.display = 'inline';
    s.lbn.style.display = 'inline';
    s.lbp.style.display = 'inline';
    s.lbf.style.display = 'inline';
    s.vcm.style.display = 'inline';
    s.loch.style.display = 'inline';
    startShowGame();
  }

  function startShowGame() {        // game.js:2103-2124
    var s = st();
    s.llgmtm = now();
    // A start fade still running (a second init within 500 ms) is stopped first: theirs leaks it, and the
    // orphan keeps login_fr at 1 so the death fade never ends (their a handler, game.js:7368-7383, 2103-2124).
    // -1 and -2 are the idle and death-fade markers, not interval ids.
    if (s.login_iv != -1 && s.login_iv != -2) root.clearInterval(s.login_iv);
    s.login_iv = root.setInterval(loginFade, 25);
    s.mc.style.opacity = 0;
    s.mc.style.display = 'inline';
    s.lbh.style.opacity = s.lbs.style.opacity = s.lbn.style.opacity = s.lbp.style.opacity = s.lbf.style.opacity =
      s.vcm.style.opacity = 0;
    s.loch.style.opacity = 0;
    s.lb_fr = -1;
    D.slDrawWorld.buildTilePattern();
    D.slPage.resize();
  }

  // The 500 ms start fade, every 25 ms of wall time: the login layer out and up-scaled, the canvas in.
  function loginFade() {            // game.js:1119-1204
    var s = st();
    var t = now();
    var ticks = (t - s.llgmtm) / 25;
    s.llgmtm = t;
    s.login_fr += .05 * ticks;
    if (s.login_fr >= 1) {
      s.login_fr = 1;
      s.login.style.display = 'none';
      menuHook('onMenuFade', 1);
      s.login.style.opacity = 1;
      s.mc.style.opacity = 1;
      s.loch.style.opacity = s.mmal;
      root.clearInterval(s.login_iv);
      s.login_iv = -1;
      // the login transform keeps its last scale here (quirk kept)
    } else {
      s.lgcsc = 1 + .1 * Math.pow(s.login_fr, 2);
      var sc = Math.round(s.lgbsc * s.lgcsc * 1E5) / 1E5;
      s.login.style.transform = scaleText(sc);
      s.login.style.opacity = 1 - s.login_fr;
      menuHook('onMenuFade', s.login_fr);
      s.mc.style.opacity = s.login_fr;
      s.loch.style.opacity = s.login_fr * s.mmal;
    }
  }

  // ---- per oef ----

  // Leaderboard fade-in, death hold, death fade (game.js:4400-4486). slLoop calls it at oef step 7 from the first
  // oef after load, so the hidden board fades in once at load too (lb_fr starts 0, game.js:1114, quirk kept).
  function oefFades(ctm) {
    var s = st();
    if (s.dead_mtm == -1) {
      if (s.lb_fr != -1 && s.lb_fr != 1) {
        s.lb_fr += s.vfr * .01;
        if (s.lb_fr >= 1) s.lb_fr = 1;
        s.lbh.style.opacity = s.lb_fr * .85;
        s.lbs.style.opacity = s.lbn.style.opacity = s.lbp.style.opacity = s.lbf.style.opacity =
          s.vcm.style.opacity = s.lb_fr;
      }
    } else if (ctm - s.dead_mtm > 1600) {
      // While the start fade still runs, login_iv is its interval id and neither step below runs.
      if (s.login_iv == -1) {
        s.login_iv = -2;
        s.login.style.display = 'inline';
        menuHook('onMenuShow');
      }
      if (s.login_iv == -2) {
        s.login_fr -= .004 * s.vfr;
        s.lb_fr = s.login_fr;
        if (s.login_fr <= 0) {
          s.login_fr = 0;
          s.dead_mtm = -1;
          s.lb_fr = -1;
          s.playing = false;
          menuHook('onMenuDone');
        }
        menuHook('onMenuFade', s.login_fr);
        s.lgcsc = 1 + .1 * Math.pow(s.login_fr, 2);
        var sc = Math.round(s.lgbsc * s.lgcsc * 1E5) / 1E5;
        s.login.style.transform = sc == 1 ? '' : scaleText(sc);
        s.login.style.opacity = 1 - s.login_fr;
        s.mc.style.opacity = s.login_fr;
        s.loch.style.opacity = s.login_fr * s.mmal;
        // On the last step lb_fr is -1, so -0.85 and -1 are written (computed 0, quirk kept).
        s.lbh.style.opacity = s.lb_fr * .85;
        s.lbs.style.opacity = s.lbn.style.opacity = s.lbp.style.opacity = s.lbf.style.opacity =
          s.vcm.style.opacity = s.lb_fr;
      }
    }
  }

  // Minimap holder fade-in (per frame) and map crossfade (per vfr), game.js:4565-4577. slLoop calls it inside its
  // connected block (oef step 9d).
  function oefMinimap() {
    var s = st();
    if (s.mmgad) {
      if (s.mmal != 1) {
        s.mmal += .025;
        if (s.mmal >= 1) s.mmal = 1;
        s.loch.style.opacity = s.mmal;
      }
      if (s.mmbfr < 1) {
        s.mmbfr += s.vfr / 230;
        if (s.mmbfr >= 1) s.mmbfr = 1;
        s.asmc.style.opacity = s.mmsta * (1 - s.mmbfr);
        s.asmc2.style.opacity = 1 - (1 - s.mmsta) / (1 - s.mmsta * (1 - s.mmbfr));
      }
    }
  }

  // Own dot on the minimap, at most every 150 ms of wall time (game.js:4613-4619). Scaled by flux_grd, not grd;
  // the stamp is a fresh now(), not ctm.
  function oefDot(ctm) {
    var s = st();
    var o = s.slither;
    if (o != null && s.grd != 2147483647 && ctm - s.locu_mtm > 150) {
      s.locu_mtm = now();
      s.myloc.style.left = Math.round(10 * (s.mmrad + 12 + s.mmrad * (o.xx - s.grd) / s.flux_grd - 7)) / 10 + 'px';
      s.myloc.style.top = Math.round(10 * (s.mmrad + 12 + s.mmrad * (o.yy - s.grd) / s.flux_grd - 7)) / 10 + 'px';
    }
  }

  // "Your length / Your rank" rebuild, redraw row 22 (game.js:6658-6733, non-team branch). Reads slither with no
  // null check, as theirs: our server sends the own snake before the first leaderboard.
  function updateLengthBox() {
    var s = st();
    if (s.wumsts && s.rank > 0 && s.slither_count > 0 && s.playing) {
      s.wumsts = false;
      var w = lengthWords(s.lang);
      var o = s.slither;
      var score = scoreAt(s, o.sct + o.rsc, o.fam);
      s.lbf.innerHTML = '<span style="font-size: 14px;"><span style="opacity: .4;">' + w[0] +
        ': </span><span style="opacity: .8; font-weight: bold;">' + score + '</span></span>' +
        '<BR><span style="opacity: .3;">' + w[2] + ': </span><span style="opacity: .35;">' + s.rank +
        '</span><span style="opacity: .3;"> ' + w[1] + ' </span><span style="opacity: .35;">' + s.slither_count +
        '</span>';
    }
  }

  // ---- packet side effects (slApply runs the handlers and calls these) ----

  function setLeaderboard(scores, names, places) {   // game.js:7964-7966, in this order
    var s = st();
    s.lbs.innerHTML = scores;
    s.lbn.innerHTML = names;
    s.lbp.innerHTML = places;
  }

  function setVcm(h) {              // game.js:8066. Owen Q13 may change this (layered in a separate file)
    st().vcm.innerHTML = h;
  }

  // The last score under the logo (game.js:9049-9057). Their Play Again text and victory form are menu (OUT).
  // Owen Q11 may change this (layered in a separate file)
  function gameOver(finalScore, v) {
    var s = st();
    var exc = finalScore > 1E3 ? '!' : '';
    s.lastscore.innerHTML = '<span style="opacity: .45;">' + finalWords(s.lang) + ' </span><b>' + finalScore + '</b>' +
      exc;
  }

  // HUD part of resetGame (game.js:7160-7163): clear both map canvases at the current map size.
  function resetHud() {
    var s = st();
    var c = s.asmc.getContext('2d');
    c.clearRect(0, 0, s.mmsz, s.mmsz);
    c = s.asmc2.getContext('2d');
    c.clearRect(0, 0, s.mmsz, s.mmsz);
  }

  // ---- resize (slPage calls this inside its size-changed branch, after ww -= wsu) ----

  function resizeHud() {            // game.js:6858-6864, 6867, 6901-6911
    var s = st();
    var hsu = s.hsu;
    var wsu = s.wsu;
    s.loch.style.bottom = 16 + hsu + 'px';
    reposLbf();
    s.lbh.style.right = 4 + wsu + 'px';
    s.lbs.style.right = 4 + wsu + 'px';
    s.lbn.style.right = 64 + wsu + 'px';
    s.lbp.style.right = LB_W + 64 + 16 + wsu + 'px';
    s.loch.style.right = 16 + wsu + 'px';
    s.login.style.width = s.ww + 'px';
    // the login layer shrinks below 560 px of height (it holds the last score)
    if (s.hh < 560) s.lgbsc = Math.max(50, s.hh) / 560;
    else s.lgbsc = 1;
    var sc = Math.round(s.lgbsc * s.lgcsc * 1E5) / 1E5;
    if (sc == 1) {
      s.login.style.transform = '';
      s.login.style.top = '0px';
    } else {
      var lgt = Math.round(s.hh * (1 - s.lgbsc) * 1E5) / 1E5;
      s.login.style.top = -lgt + 'px';
      s.login.style.transform = scaleText(sc);
    }
  }

  // ---- minimap ----

  // New map size: state, holder and label size, a fresh background image, both map canvases resized (which clears
  // them). game.js:2029-2101.
  function setMinimapSize(sz, force) {
    var s = st();
    var rad = sz / 2;
    if (rad != s.mmrad || force) {
      s.mmrad = rad;
      s.mmsz = sz;
      s.mmdata = new Uint8Array(sz * sz);   // zero filled; their extra zero loop (2035) changes nothing
      s.loch.style.width = s.loch.style.height = rad * 2 + 24 + 'px';
      s.sid_tf.style.width = rad * 2 + 24 + 'px';
      s.sid_tf.style.top = rad * 2 + 24 - 7 + 'px';
      // Owen Q12 may change this (layered in a separate file)
      s.sid_tf.textContent = s.real_sid > 0 && !s.team_mode ? 'server ' + s.real_sid : '';
      drawMapBackground(rad);
      var loc = s.loc;
      loc.className = 'nsi';
      loc.style.position = 'absolute';
      loc.style.left = '0px';
      loc.style.top = '0px';
      loc.style.opacity = .45;
      loc.style.zIndex = 11;
      loc.style.transform = GPU;
      fitMapCanvas(s.asmc, rad, 12, s.mmsta);
      fitMapCanvas(s.asmc2, rad, 13, s.mmsta);
    }
  }

  // The round map background: dark disc with a drop shadow, two lighter quarters, a cross (game.js:2043-2078).
  function drawMapBackground(rad) {
    var s = st();
    var cx = 12 + rad;
    var cy = 12 + rad;
    var lc = root.document.createElement('canvas');
    lc.width = lc.height = rad * 2 + 24;    // height is written first, then width (logged by the harness)
    var c = lc.getContext('2d');
    c.save();
    c.fillStyle = '#202630';
    c.shadowBlur = 12;
    c.shadowOffsetY = 3;
    c.shadowColor = '#000000';
    c.beginPath();
    c.arc(cx, cy, rad, 0, PI2);
    c.fill();
    c.restore();
    c.fillStyle = '#404650';
    pieSlice(c, cx, cy, rad, 0, Math.PI / 2);                    // lower right quarter
    pieSlice(c, cx, cy, rad, Math.PI, 3 * Math.PI / 2);          // upper left quarter
    c.strokeStyle = '#202630';
    c.lineWidth = 1;
    strokeLine(c, cx, cy - rad, cx, cy + rad);
    strokeLine(c, cx - rad, cy, cx + rad, cy);
    s.loc.src = lc.toDataURL();
  }

  // A filled slice of the disc from its centre (their first slice starts at rad + 12, the same number as cx).
  function pieSlice(c, cx, cy, rad, from, to) {
    c.beginPath();
    c.moveTo(cx, cy);
    c.arc(cx, cy, rad, from, to);
    c.lineTo(cx, cy);
    c.fill();
  }

  function strokeLine(c, x1, y1, x2, y2) {
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
  }

  function fitMapCanvas(cv, rad, z, alpha) {   // game.js:2086-2099
    cv.width = rad * 2;
    cv.height = rad * 2;
    cv.className = 'nsi';
    cv.style.position = 'absolute';
    cv.style.left = cv.style.top = '12px';
    cv.style.zIndex = z;
    cv.style.opacity = alpha;
  }

  // Copy the back map (asmc2) onto the front one (asmc).
  function copyBackToFront(s) {
    var c = s.asmc.getContext('2d');
    c.clearRect(0, 0, s.mmsz, s.mmsz);
    c.drawImage(s.asmc2, 0, 0);
  }

  // A new map starts the crossfade: front at mmsta, back hidden (game.js:8088-8090 and the same lines per packet).
  function restartCrossfade(s) {
    s.mmbfr = 0;
    s.asmc.style.opacity = s.mmsta;
    s.asmc2.style.opacity = 0;
  }

  function finishFirstMap(s) {
    if (!s.mmgad) {
      s.mmgad = true;
      copyBackToFront(s);
    }
  }

  // Map packets U, L, M, V, u (game.js:8077-8337). The event carries the cells already walked in their order
  // (decode.js / slWire: U, L, M, V backward from (size - 1, size - 1), u forward on 80 x 80), each an [x, y].
  function onMinimap(ev) {
    var s = st();
    var cmd = ev.cmd;
    var c, cells, i, p, j;
    if (cmd == 'U') {
      if (s.mmsz != ev.size) setMinimapSize(ev.size, false);
      if (!s.mmgad) copyBackToFront(s);   // U copies BEFORE only while there is no map yet (8082, quirk kept)
      restartCrossfade(s);
      c = s.asmc2.getContext('2d');
      c.clearRect(0, 0, s.mmsz, s.mmsz);
      c.fillStyle = WHITE;
      cells = ev.pixels || NO_CELLS;
      for (i = 0; i < cells.length; i++) c.fillRect(cells[i][0], cells[i][1], 1, 1);
      finishFirstMap(s);
    } else if (cmd == 'L') {
      // Team map. No team gate in their client (8129-8189), so built. Two teams leave a save() open on asmc2.
      if (s.mmsz != ev.size) setMinimapSize(ev.size, false);
      if (s.mmgad) copyBackToFront(s);
      restartCrossfade(s);
      c = s.asmc2.getContext('2d');
      c.clearRect(0, 0, s.mmsz, s.mmsz);
      if (ev.teamCount == 2) {
        c.save();
        c.globalCompositeOperation = 'lighter';
        c.fillStyle = '#FF8080';
      } else c.fillStyle = WHITE;
      for (j = 1; j <= ev.teamCount; j++) {
        if (j == 2) c.fillStyle = '#99AAFF';
        cells = (ev.teams && ev.teams[j - 1]) || NO_CELLS;
        for (i = 0; i < cells.length; i++) c.fillRect(cells[i][0], cells[i][1], 1, 1);
      }
      finishFirstMap(s);
    } else if (cmd == 'M') {
      if (s.mmsz != ev.size) setMinimapSize(ev.size, false);
      s.mmdata.fill(0);
      if (s.mmgad) copyBackToFront(s);
      restartCrossfade(s);
      c = s.asmc2.getContext('2d');
      c.clearRect(0, 0, s.mmsz, s.mmsz);
      c.fillStyle = WHITE;
      cells = ev.pixels || NO_CELLS;
      for (i = 0; i < cells.length; i++) {
        p = cells[i];
        s.mmdata[p[1] * s.mmsz + p[0]] = 1;
        c.fillRect(p[0], p[1], 1, 1);
      }
      finishFirstMap(s);
    } else if (cmd == 'V') {
      // Toggles against the last full map; the back canvas is NOT cleared.
      if (s.mmgad) copyBackToFront(s);
      restartCrossfade(s);
      c = s.asmc2.getContext('2d');
      c.fillStyle = WHITE;
      cells = ev.toggles || NO_CELLS;
      for (i = 0; i < cells.length; i++) {
        p = cells[i];
        var k = p[1] * s.mmsz + p[0];
        if (s.mmdata[k] == 1) {
          s.mmdata[k] = 0;
          c.clearRect(p[0], p[1], 1, 1);
        } else {
          s.mmdata[k] = 1;
          c.fillRect(p[0], p[1], 1, 1);
        }
      }
      finishFirstMap(s);
    } else if (cmd == 'u') {
      // Legacy 80 x 80 map drawn straight onto the front canvas; no crossfade writes.
      s.mmgad = true;
      if (s.mmsz != 80) setMinimapSize(80, true);
      c = s.asmc.getContext('2d');
      c.clearRect(0, 0, 80, 80);
      c.fillStyle = WHITE;
      cells = ev.pixels || NO_CELLS;
      for (i = 0; i < cells.length; i++) c.fillRect(cells[i][0], cells[i][1], 1, 1);
    }
  }

  D.slHud = {
    init: init,
    onInit: onInit,
    startShowGame: startShowGame,
    loginFade: loginFade,
    setLeaderboard: setLeaderboard,
    setVcm: setVcm,
    onMinimap: onMinimap,
    setMinimapSize: setMinimapSize,
    oefFades: oefFades,
    oefMinimap: oefMinimap,
    oefDot: oefDot,
    updateLengthBox: updateLengthBox,
    resizeHud: resizeHud,
    resetHud: resetHud,
    gameOver: gameOver,
    reposLbf: reposLbf
  };
})(typeof window !== 'undefined' ? window : globalThis);
