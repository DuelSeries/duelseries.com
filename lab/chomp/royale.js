// Royale Rounds page: you plus bots on one maze, the real game's arcade renderer, a small HUD.
(function () {
  'use strict';
  var P = LabPage;
  var SKILL = { easy: 0.55, normal: 0.75, hard: 0.92 };
  var opts = {
    players: Math.round(P.qn('players', 4)), pac: P.qn('speed', 0.75), toWin: Math.round(P.qn('to', 3)),
    skill: SKILL[P.q('bots', 'normal')] || 0.75, roundS: P.qn('round', 90)
  };
  var S = RoyaleSim.create(opts);
  var me = S.players[0];
  window.__lab = S;                             // for the headless checks
  if (P.q('auto') === '1') me.bot = true;      // demo: a bot plays your seat (the concept page's clips)
  var cv = document.getElementById('cv');
  var px = new ChompPixel(cv, S.A);
  var pops = new P.Pops();
  var pending = null, bannerUntil = 0, bannerText = '';

  // ---- the strip of choices
  var ui = document.getElementById('ui');
  P.chips(ui, 'Players', [{ label: '2', value: 2, title: 'A 1v1 duel, the paid version' }, { label: '3', value: 3 }, { label: '4', value: 4 }], opts.players, function (v) { P.setQ({ players: v }); });
  P.chips(ui, 'Speed', [{ label: '60%', value: 0.6 }, { label: '70%', value: 0.7 }, { label: '75%', value: 0.75 }, { label: '80% arcade', value: 0.8 }, { label: '90%', value: 0.9 }], opts.pac, function (v) { P.setQ({ speed: v }); });
  P.chips(ui, 'Bots', [{ label: 'Easy', value: 'easy' }, { label: 'Normal', value: 'normal' }, { label: 'Hard', value: 'hard' }], P.q('bots', 'normal'), function (v) { P.setQ({ bots: v }); });

  function layout() {
    P.fit(px, innerWidth, innerHeight, 28, 37);
  }
  addEventListener('resize', layout);
  layout();
  P.unlockAudio();
  P.input({
    el: document.getElementById('stage'),
    onDir: function (d) { pending = d; },
    onAction: function () { if (S.phase === 'match') location.reload(); }
  });

  function banner(text, ms, color) { bannerText = '<span style="color:' + (color || '#ffd23a') + '">' + text + '</span>'; bannerUntil = performance.now() + ms; }

  function events() {
    S.events.forEach(function (e) {
      var mine = e.id === me.id;
      if (e.t === 'dot' && mine) P.chewSound();
      else if (e.t === 'power') { if (mine) P.sound('ch.power'); }
      else if (e.t === 'ghost') { pops.add(e.x, e.y, e.pts, '#00ffff', S.tick); if (mine) P.sound('ch.ghost'); }
      else if (e.t === 'eat') { pops.add(e.x, e.y, 'KO!', '#ffd23a', S.tick, true); P.sound('ch.player'); }
      else if (e.t === 'revenge') { pops.add(e.x, e.y, 'GHOST KO!', '#ffb851', S.tick, true); P.sound('ch.player'); }
      else if (e.t === 'out' && mine) { P.sound('ch.death'); }
      else if (e.t === 'ghostme' && mine) { banner('YOU ARE A GHOST\n<small>catch a chomper to knock them out</small>', 2200, '#ffb851'); }
      else if (e.t === 'bump') { pops.add(e.x, e.y, 'BUMP', '#dedeff', S.tick, true); }
      else if (e.t === 'hurry') { banner('HURRY!', 1500, '#ff0000'); P.sound('ch.whoosh'); }
      else if (e.t === 'pellets') { P.sound('ch.fruit'); }
      else if (e.t === 'ready') { P.sound('ch.ready'); }
      else if (e.t === 'round') {
        var w = e.winner;
        banner(w ? (w === me ? 'YOU TAKE THE ROUND' : w.name + ' TAKES THE ROUND') + (e.timeUp ? '\n<small>time up: most points</small>' : '') : 'NO WINNER', 2800, w ? w.color : '#dedeff');
      } else if (e.t === 'match') {
        var mw = e.winner;
        banner((mw === me ? 'YOU WIN THE MATCH' : mw.name + ' WINS THE MATCH') + '\n<small>Space or tap to play again</small>', 9e9, mw.color);
        P.sound(mw === me ? 'ch.life' : 'ch.death');
      }
    });
    S.events.length = 0;
  }

  P.loop(function () {
    RoyaleSim.step(S, pending == null ? null : { want: pending });
    pending = null;
    events();
  }, draw);

  var hudEl = document.getElementById('hud'), clockEl = document.getElementById('clock'), seatsEl = document.getElementById('seats');
  var bannerEl = document.getElementById('banner'), lastSeats = '', lastClock = '', lastBanner = '';

  function draw() {
    var t = S.tick, players = [], ghosts = [];
    S.players.forEach(function (p) {
      if (p.alive || p.dyingT >= 0) {
        var powered = p.power > 0 && p.alive;
        players.push({ x: p.x, y: p.y, dir: p.dir, frame: P.chewFrame(p.id, p.alive && p.moving), color: p.color, me: p === me, name: p.name,
          dying: p.alive ? null : P.deathFrame(p.dyingT), speed: powered ? 2 : 0, glow: powered ? (p.power < 90 && (t >> 3) % 2 ? null : '#ffffb8') : null,
          hidden: p.alive && p.safe > 0 && (t >> 2) % 2 === 1 });
      } else if (p.ghostMe && p.ghostMe.state === 'out') {
        var gm = p.ghostMe, look = me.alive && me.power > 0 && gm.revivedAt < me.powerAt ? P.blueLook(me.power, t) : 'normal';
        ghosts.push(P.ghostSprite(gm, look, t));
        players.push({ hidden: true, x: gm.x, y: gm.y, name: p === me ? 'YOU' : p.name, color: p.color, me: false, dying: null });
      }
    });
    S.ghosts.forEach(function (g) {
      var look = g.state === 'eyes' || g.state === 'enter' ? 'eyes' : g.state === 'out' && me.alive && RoyaleSim.eats(me, g) ? P.blueLook(me.power, t) : 'normal';
      ghosts.push(P.ghostSprite(g, look, t));
    });
    px.frame({
      cam: { x: 14, y: 15.5 }, tick: t, dots: S.dots, ghosts: ghosts, players: players, fruit: [], pops: pops.scene(t), hud: null,
      banner: S.phase === 'ready' ? { text: 'READY!', color: '#ffff00', x: 14, y: 17.5 } : null
    });
    // HUD over the maze's top rows
    var v = px.view, dpr = px.dpr, k = v.k, r = cv.getBoundingClientRect();
    var left = r.left + (v.ox * k) / dpr, top = r.top + ((v.oy - 22) * k) / dpr, w = (28 * 8 * k) / dpr;
    hudEl.style.left = left + 'px'; hudEl.style.top = top + 'px'; hudEl.style.width = w + 'px';
    hudEl.style.fontSize = Math.max(8, (6 * k) / dpr) + 'px';
    var secs = Math.max(0, Math.ceil(S.cfg.roundS - S.roundTick / 60));
    var clock = 'ROUND ' + S.round + '  ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
    if (clock !== lastClock) { clockEl.textContent = clock; lastClock = clock; }
    var seats = S.players.map(function (p) {
      var pips = ''; for (var i = 0; i < S.cfg.toWin; i++) pips += i < p.wins ? '●' : '○';
      return '<span class="seat' + (p.alive ? '' : ' out') + '"><i style="background:' + p.color + '"></i>' + p.name + ' <span class="pips">' + pips + '</span></span>';
    }).join('');
    if (seats !== lastSeats) { seatsEl.innerHTML = seats; lastSeats = seats; }
    var b = performance.now() < bannerUntil ? bannerText : '';
    if (b !== lastBanner) { bannerEl.innerHTML = b; lastBanner = b; }
    bannerEl.style.fontSize = Math.max(12, (9 * k) / dpr) + 'px';
  }
})();
