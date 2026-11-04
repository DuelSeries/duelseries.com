// Ghost Train Duel page: your maze and the bot's, same seed, side by side (a phone shows the bot's small in a corner).
(function () {
  'use strict';
  var P = LabPage;
  var SKILL = { easy: 0.55, normal: 0.75, hard: 0.92 };
  var auto = P.q('auto') === '1';
  var D = DuelSim.create({ human: !auto, skillA: 0.85, skillB: SKILL[P.q('bots', 'normal')] || 0.75, base: P.qn('speed', 0.68), matchS: P.qn('time', 150) });
  var mine = D.boards[0], rival = D.boards[1];
  window.__lab = D;                             // for the headless checks
  var cvA = document.getElementById('cvA'), cvB = document.getElementById('cvB');
  var pxA = new ChompPixel(cvA, D.A), pxB = new ChompPixel(cvB, D.A);
  var popsA = new P.Pops(), popsB = new P.Pops();
  var pending = null, banner = { A: ['', 0], B: ['', 0], mid: ['', 0] };

  var ui = document.getElementById('ui');
  P.chips(ui, 'Start speed', [{ label: '60%', value: 0.6 }, { label: '68%', value: 0.68 }, { label: '75%', value: 0.75 }, { label: '80% arcade', value: 0.8 }], P.qn('speed', 0.68), function (v) { P.setQ({ speed: v }); });
  P.chips(ui, 'Bot', [{ label: 'Easy', value: 'easy' }, { label: 'Normal', value: 'normal' }, { label: 'Hard', value: 'hard' }], P.q('bots', 'normal'), function (v) { P.setQ({ bots: v }); });
  P.chips(ui, 'Match', [{ label: '1:30', value: 90 }, { label: '2:30', value: 150 }, { label: '3:00', value: 180 }], P.qn('time', 150), function (v) { P.setQ({ time: v }); });

  var wide = true;
  function layout() {
    var W = innerWidth, H = innerHeight;
    wide = W >= H * 1.15;
    if (wide) {
      var w = Math.floor(W / 2);
      P.fit(pxA, w, H - 30, 28, 38); P.fit(pxB, w, H - 30, 28, 38);
      cvA.style.left = '0px'; cvA.style.top = '30px'; cvB.style.left = w + 'px'; cvB.style.top = '30px';
      cvB.className = '';
    } else {
      P.fit(pxA, W, H, 28, 37);
      var mw = Math.round(W * 0.34), mh = Math.round(mw * 37 / 28);
      P.fit(pxB, mw, mh, 28, 34);
      cvA.style.left = '0px'; cvA.style.top = '0px';
      cvB.style.left = (W - mw - 6) + 'px'; cvB.style.top = Math.round(H * 0.06) + 'px';
      cvB.className = 'mini';
    }
  }
  addEventListener('resize', layout);
  layout();
  P.unlockAudio();
  P.input({ el: document.getElementById('stage'), onDir: function (d) { pending = d; }, onAction: function () { if (D.phase === 'over') location.reload(); } });

  function say(which, text, ms, color) { banner[which] = ['<span style="color:' + (color || '#ffd23a') + '">' + text + '</span>', performance.now() + ms]; }

  function events() {
    D.events.forEach(function (e) {
      var b = e.b != null ? e.b : null, isMe = b === 0, pops = b === 0 ? popsA : popsB, side = b === 0 ? 'A' : 'B';
      if (e.t === 'dot' && isMe) P.chewSound();
      else if (e.t === 'power') { if (isMe) P.sound('ch.power'); }
      else if (e.t === 'wake') { pops.add(e.x, e.y, '+' + e.n, '#ffb8ff', D.tick, true); }
      else if (e.t === 'chain') { pops.add(e.x, e.y, e.pts, '#00ffff', D.tick); if (isMe) P.sound('ch.ghost'); }
      else if (e.t === 'clear') { say(side, 'SPEED UP!\n<small>level ' + e.level + '  +' + e.pts + '</small>', 1500, '#00ff00'); if (isMe) P.sound('ch.life'); }
      else if (e.t === 'die') { if (isMe) P.sound('ch.death'); say(side, e.how === 'train' ? 'TURNED INTO\nYOUR TRAIN' : 'CAUGHT', 1300, '#ff0000'); }
      else if (e.t === 'jam') { say(e.to === 0 ? 'A' : 'B', 'SLOW BLOB\nINCOMING', 1500, '#9a9ab8'); if (e.to === 0) P.sound('ch.whoosh'); }
      else if (e.t === 'slowed' && isMe) { P.sound('ch.scared'); }
      else if (e.t === 'jamEat') { pops.add(e.x, e.y, 300, '#00ffff', D.tick); }
      else if (e.t === 'go') { P.sound('ch.ready'); }
      else if (e.t === 'over') {
        var w = e.winner;
        banner.mid = ['<span style="color:#ffd23a">' + (w === mine ? 'YOU WIN' : w ? 'BOT WINS' : 'DRAW') + '</span>\n<small>' + mine.score + ' to ' + rival.score + '\nSpace or tap to play again</small>', 9e9];
        P.sound(w === mine ? 'ch.life' : 'ch.death');
      }
    });
    D.events.length = 0;
  }

  P.loop(function () {
    DuelSim.step(D, pending == null ? null : { want: pending });
    pending = null;
    events();
  }, draw);

  function scene(b, pops) {
    var t = D.tick, p = b.p, players = [], ghosts = [];
    var powered = p.power > 0 && p.alive;
    if (p.alive || p.dyingT >= 0) {
      players.push({ x: p.x, y: p.y, dir: p.dir, frame: P.chewFrame('d' + b.idx, p.alive && p.moving), color: b.slow > 0 ? '#c8c8a0' : '#ffff00', me: true,
        dying: p.alive ? null : P.deathFrame(p.dyingT), speed: powered ? 2 : b.level > 1 ? 1 : 0, glow: powered ? '#ffffb8' : null,
        hidden: p.alive && p.safe > 0 && (t >> 2) % 2 === 1 });
    }
    b.jams.forEach(function (j, i) {
      players.push({ x: j.x, y: j.y, dir: j.dir, frame: P.chewFrame('j' + b.idx + i, true), color: powered ? '#2121ff' : '#8a8a9a', me: false, dying: null });
    });
    var look = P.blueLook(p.power, t);
    b.wild.forEach(function (g) {
      var lk = g.state === 'eyes' || g.state === 'enter' ? 'eyes' : g.state === 'out' && p.power > 0 && g.revivedAt < p.powerAt ? look : 'normal';
      ghosts.push(P.ghostSprite(g, lk, t));
    });
    p.train.forEach(function (g) { ghosts.push(P.ghostSprite(g, p.power > 0 ? look : 'normal', t)); });
    return { cam: { x: 14, y: 15.5 }, tick: t, dots: b.dots, ghosts: ghosts, players: players, fruit: [], pops: pops.scene(t), hud: null,
      banner: D.phase === 'ready' ? { text: 'READY!', color: '#ffff00', x: 14, y: 17.5 } : null };
  }

  var els = { hudA: document.getElementById('hudA'), hudB: document.getElementById('hudB'), clock: document.getElementById('clock'),
    banA: document.getElementById('banA'), banB: document.getElementById('banB'), mid: document.getElementById('banner') };
  var last = {};
  function setHtml(el, key, html) { if (last[key] !== html) { el.innerHTML = html; last[key] = html; } }

  function placeHud(px, cv, el, banEl, b, side, small) {
    var v = px.view, k = v.k, dpr = px.dpr, r = cv.getBoundingClientRect();
    var left = r.left + (v.ox * k) / dpr, top = r.top + ((v.oy - (small ? 14 : 18)) * k) / dpr, w = (28 * 8 * k) / dpr;
    el.style.left = left + 'px'; el.style.top = top + 'px'; el.style.width = w + 'px';
    el.style.fontSize = Math.max(small ? 7 : 9, (5.5 * k) / dpr) + 'px';
    var speed = Math.round(DuelSim.levelSpeed(D, b) * 100);
    setHtml(el, 'h' + side, '<span>' + b.name + ' <b>' + b.score + '</b></span><span>SPD ' + speed + '%</span><span class="tr">TRAIN ' + b.p.train.length + '</span>');
    var bn = banner[side], show = performance.now() < bn[1] ? bn[0] : '';
    setHtml(banEl, 'b' + side, show);
    banEl.style.left = (left + w / 2) + 'px'; banEl.style.top = (r.top + ((v.oy + 15 * 8) * k) / dpr) + 'px';
    banEl.style.fontSize = Math.max(small ? 8 : 11, (7 * k) / dpr) + 'px';
  }

  function draw() {
    pxA.frame(scene(mine, popsA)); P.drawSleepers(pxA, mine.sleepers, D.tick);
    pxB.frame(scene(rival, popsB)); P.drawSleepers(pxB, rival.sleepers, D.tick);
    placeHud(pxA, cvA, els.hudA, els.banA, mine, 'A', false);
    placeHud(pxB, cvB, els.hudB, els.banB, rival, 'B', !wide);
    var s = Math.ceil(DuelSim.timeLeft(D));
    setHtml(els.clock, 'clock', Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'));
    els.clock.style.top = wide ? '34px' : 'auto';
    els.clock.style.bottom = wide ? 'auto' : '28px';
    els.clock.style.fontSize = wide ? '16px' : '14px';
    var m = performance.now() < banner.mid[1] ? banner.mid[0] : '';
    setHtml(els.mid, 'mid', m);
    els.mid.style.fontSize = '22px';
  }
})();
