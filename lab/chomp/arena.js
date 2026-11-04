// Train Arena page: today's arena with ghost trains as weapons, pretend money, the camera on you.
(function () {
  'use strict';
  var P = LabPage;
  var auto = P.q('auto') === '1';
  var Z = ArenaSim.create({ human: true, bots: Math.round(P.qn('bots', 6)), pac: P.qn('speed', 0.72), trains: P.q('trains', '1') !== '0' });
  var me = Z.players[0];
  window.__lab = Z;                             // for the headless checks
  if (auto) me.bot = true;
  var A = Z.A;
  var cv = document.getElementById('cv');
  var px = new ChompPixel(cv, A);
  var pops = new P.Pops();
  var pending = null, holdKey = false, holdBtn = false, bannerUntil = 0, bannerText = '';
  var cam = { x: me.x, y: me.y };

  var ui = document.getElementById('ui');
  P.chips(ui, 'Speed', [{ label: '60%', value: 0.6 }, { label: '72%', value: 0.72 }, { label: '80% arcade', value: 0.8 }, { label: '116% today\'s cherry', value: 1.16 }], P.qn('speed', 0.72), function (v) { P.setQ({ speed: v }); });
  P.chips(ui, 'Trains', [{ label: 'On', value: '1' }, { label: 'Off (today)', value: '0' }], P.q('trains', '1'), function (v) { P.setQ({ trains: v }); });
  P.chips(ui, 'Bots', [{ label: '4', value: 4 }, { label: '6', value: 6 }, { label: '9', value: 9 }], Math.round(P.qn('bots', 6)), function (v) { P.setQ({ bots: v }); });

  function layout() { P.fit(px, innerWidth, innerHeight); }
  addEventListener('resize', layout);
  layout();
  P.unlockAudio();
  P.input({ el: document.getElementById('stage'), onDir: function (d) { pending = d; }, hold: function (on) { holdKey = on; } });
  var btn = document.getElementById('cash');
  ['touchstart', 'mousedown'].forEach(function (e) { btn.addEventListener(e, function (ev) { holdBtn = true; ev.preventDefault(); ev.stopPropagation(); }, { passive: false }); });
  ['touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(function (e) { btn.addEventListener(e, function () { holdBtn = false; }); });

  function money(v) { return '$' + v.toFixed(2); }
  function banner(text, ms, color) { bannerText = '<span style="color:' + (color || '#ffd23a') + '">' + text + '</span>'; bannerUntil = performance.now() + ms; }

  function events() {
    Z.events.forEach(function (e) {
      var mine = e.id === me.id;
      if (e.t === 'dot' && mine) P.chewSound();
      else if (e.t === 'power' && mine) P.sound('ch.power');
      else if (e.t === 'wake' && mine) { pops.add(e.x, e.y, '+' + e.n, '#ffb8ff', Z.tick, true); }
      else if (e.t === 'ghost') { pops.add(e.x, e.y, e.pts, '#00ffff', Z.tick); if (mine) P.sound('ch.ghost'); }
      else if (e.t === 'coin' && mine) { pops.add(e.x, e.y, '+' + money(e.v), '#f5b335', Z.tick, true); P.sound('ch.fruit'); }
      else if (e.t === 'out') {
        if (e.id === me.id) {
          P.sound('ch.death');
          var by = e.by != null ? Z.players[e.by] : null;
          banner(e.how === 'train' ? 'CAUGHT BY ' + by.name.toUpperCase() + '\'S TRAIN\n<small>' + money(e.v) + ' went to ' + by.name + '</small>' :
            e.how === 'power' ? 'EATEN BY ' + by.name.toUpperCase() + '\n<small>' + money(e.v) + ' went to ' + by.name + '</small>' :
            e.how === 'own' ? 'YOU TURNED INTO YOUR TRAIN\n<small>your coins dropped</small>' : 'CAUGHT BY A GHOST\n<small>your coins dropped</small>', 2600, '#ff4040');
        } else if (e.by === me.id) {
          P.sound('ch.player');
          pops.add(e.x, e.y, '+' + money(e.v), '#f5b335', Z.tick, true);
          banner((e.how === 'train' ? 'YOUR TRAIN CAUGHT ' : 'YOU ATE ') + Z.players[e.id].name.toUpperCase() + '\n<small>+' + money(e.v) + '</small>', 1600, '#f5b335');
        }
      } else if (e.t === 'cash' && mine) { P.sound('ch.life'); banner('CASHED OUT ' + money(e.pay) + '\n<small>90% of ' + money(e.v) + ', a new $1.00 seat</small>', 2600, '#f5b335'); }
    });
    Z.events.length = 0;
  }

  P.loop(function () {
    ArenaSim.step(Z, { want: pending, hold: holdKey || holdBtn });
    pending = null;
    events();
  }, draw);

  var meEl = document.getElementById('me'), boardEl = document.getElementById('board'), bannerEl = document.getElementById('banner');
  var last = {};
  function setHtml(el, key, html) { if (last[key] !== html) { el.innerHTML = html; last[key] = html; } }

  function near(o) { return { x: cam.x + A.dx(cam.x, o.x), y: cam.y + A.dy(cam.y, o.y) }; }

  function draw() {
    var t = Z.tick;
    if (me.alive) { cam.x = me.x; cam.y = me.y; }
    var players = [], ghosts = [], mePow = me.alive ? me.power : 0;
    Z.players.forEach(function (p) {
      if (!p.alive && p.dyingT < 0) return;
      var n = near(p), powered = p.alive && p.power > 0;
      players.push({ x: n.x, y: n.y, dir: p.dir, frame: P.chewFrame(p.id, p.alive && p.moving), color: '#ffff00', me: p === me,
        name: p.name + ' ' + money(p.worth), dying: p.alive ? null : P.deathFrame(p.dyingT), speed: powered ? 2 : 0, glow: powered ? '#ffffb8' : null,
        hidden: p.alive && p.safe > 0 && (t >> 2) % 2 === 1, scared: me.alive && mePow > 0 && !powered && p !== me });
      p.train.forEach(function (g) {
        var gn = near(g), look = mePow > 0 ? P.blueLook(mePow, t) : 'normal';
        ghosts.push(P.ghostSprite({ x: gn.x, y: gn.y, dir: g.dir, ki: g.ki }, look, t));
      });
    });
    Z.wild.forEach(function (g) {
      var gn = near(g), look = g.state === 'eyes' || g.state === 'enter' ? 'eyes' : g.state === 'out' && me.alive && ArenaSim.edible(me, g) ? P.blueLook(mePow, t) : 'normal';
      ghosts.push(P.ghostSprite({ x: gn.x, y: gn.y, dir: g.dir, ki: g.ki }, look, t));
    });
    var coins = Z.coins.map(function (c) { var n = near({ x: c.c + 0.5, y: c.r + 0.5 }); return { c: Math.floor(n.x), r: Math.floor(n.y) }; });
    px.frame({ cam: cam, tick: t, dots: Z.dots, ghosts: ghosts, players: players, fruit: [], pops: pops.scene(t).map(function (q) { var n = near(q); q.x = n.x; q.y = n.y; return q; }), hud: null, coins: coins });
    P.drawSleepers(px, Z.sleepers.map(function (s) { var n = near(s); n.ki = s.ki; return n; }), t);
    // the cash-out ring: a gold arc round you that fills while you hold and keep moving
    if (me.alive && me.cashT > 0) {
      var v = px.view, k = v.k, m = px.ctx, cx = (v.ox + me.x * 0 + Math.floor(cam.x * v.T)) * k, cy = (v.oy + Math.floor(cam.y * v.T)) * k;
      m.lineWidth = 2 * k; m.strokeStyle = '#f5b335'; m.beginPath();
      m.arc(cx, cy, 11 * k, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, me.cashT / (Z.cfg.cashHoldS * 60))); m.stroke();
    }
    setHtml(meEl, 'me', 'YOU <span class="gold">' + money(me.worth) + '</span><br>CASHED <span class="gold">' + money(me.cashed) + '</span><br>TRAIN ' + me.train.length);
    var top = Z.players.slice().sort(function (a, b) { return b.worth - a.worth; }).slice(0, 5);
    setHtml(boardEl, 'board', top.map(function (p) { return '<span class="' + (p === me ? 'you' : '') + '">' + p.name + '</span> <span class="gold">' + money(p.worth) + '</span>'; }).join('<br>'));
    var b = performance.now() < bannerUntil ? bannerText : '';
    setHtml(bannerEl, 'banner', b);
    bannerEl.style.fontSize = Math.max(12, Math.min(20, innerWidth / 40)) + 'px';
  }
})();
