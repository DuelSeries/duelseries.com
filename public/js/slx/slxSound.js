// DuelSeries layer on the frozen slither.io client: the old game's sounds (Owen Q14 "keep all"; SERVER-DESIGN 15.3
// "Old extras kept"; task T17). Ours, not a parity area; their client has no sound.
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20).
//
// The old Web Audio synths, ported with their numbers unchanged (public/js/game.js:137-235, 320-358), and the one
// cash-out fanfare every game shares (public/js/cashoutSound.js, loaded once here; its comment asks for one copy).
// One shared AudioContext, resumed on the first gesture (game.js:137-155), so a phone or a fresh tab plays them.
// The old mute and volume globals are honoured as before (window.gameMuted, gameMasterVol, gameSfxVol).
//
// Triggers, from the tap (slxNet):
//   join      the own snake_add ('ownAdd'), once per socket
//   death     the own `dead` ('ownDead'), unless this socket cashed out
//   kill      the own kill_count rose ('ownKills'; their server sends the killer's total, slView L40)
//   cash-out  sl:x {t: 'cashed'} (the server sends it before the own `dead`, server/sl/slRoom.js _cashOut)
//   money     a paid room's own sl:x {t: 'w', d} with d > 0, the own snake ate gold (PAID-SL-DESIGN 9; only the own
//             seat's worth message carries d, server/sl/slRoom.js _worthAll): the old money chime, which the old game
//             played on each 'ate_dropped_food' (game.js:157-177, 238). A free room never sends it.
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var doc = root.document;
  if (!doc || typeof slx.on !== 'function') return;

  var CASHOUT_SRC = '/js/cashoutSound.js';
  // The gestures that unlock audio (game.js:150-155).
  var UNLOCK = ['pointerdown', 'mousedown', 'mousemove', 'touchstart', 'touchmove', 'keydown', 'click'];

  // ---- the shared context (game.js:137-155)
  var ctx = null;
  function getAudioCtx() {
    if (!ctx) {
      var AC = root.AudioContext || root.webkitAudioContext;
      if (typeof AC !== 'function') return null;
      try {
        ctx = new AC();
      } catch (e) {
        return null;
      }
    }
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try {
        var p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) { /* not allowed yet */ }
    }
    return ctx;
  }
  function unlock() {
    getAudioCtx();
  }
  for (var u = 0; u < UNLOCK.length; u++) root.addEventListener(UNLOCK[u], unlock, { once: true, passive: true });

  function muted() {
    return !!root.gameMuted;
  }
  function vol() {
    var m = root.gameMasterVol;
    var s = root.gameSfxVol;
    return (m == null ? 1 : m) * (s == null ? 0.5 : s);
  }

  // The fanfare, one copy for every game.
  if (!root.CashoutSound && typeof doc.createElement === 'function') {
    var script = doc.createElement('script');
    script.src = CASHOUT_SRC;
    (doc.head || doc.body).appendChild(script);
  }

  // Three ascending notes, C5 E5 G5, a quick staggered chime (game.js:320-358).
  function playJoin() {
    if (muted()) return;
    var ac = getAudioCtx();
    if (!ac) return;
    try {
      var notes = [{ freq: 523.25, t: 0.00 }, { freq: 659.25, t: 0.13 }, { freq: 783.99, t: 0.26 }];
      for (var i = 0; i < notes.length; i++) {
        var n = notes[i];
        var osc = ac.createOscillator();
        var gain = ac.createGain();
        var osc2 = ac.createOscillator();
        var gain2 = ac.createGain();
        osc.type = 'sine';
        osc2.type = 'sine';
        osc.frequency.value = n.freq;
        osc2.frequency.value = n.freq * 2;
        osc.connect(gain); gain.connect(ac.destination);
        osc2.connect(gain2); gain2.connect(ac.destination);
        var start = ac.currentTime + n.t;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.28 * vol(), start + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);
        gain2.gain.setValueAtTime(0, start);
        gain2.gain.linearRampToValueAtTime(0.07, start + 0.018);
        gain2.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
        osc.start(start); osc.stop(start + 0.6);
        osc2.start(start); osc2.stop(start + 0.4);
      }
    } catch (e) { /* audio not supported */ }
  }

  // A soft sine glide down plus a low thump (game.js:179-204).
  function playDeath() {
    if (muted()) return;
    var ac = getAudioCtx();
    if (!ac) return;
    try {
      var t = ac.currentTime;
      var osc = ac.createOscillator(), gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      osc.type = 'sine'; osc.frequency.setValueAtTime(523, t);
      osc.frequency.exponentialRampToValueAtTime(70, t + 0.55);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.3, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      osc.start(t); osc.stop(t + 0.62);
      var o2 = ac.createOscillator(), g2 = ac.createGain();
      o2.connect(g2); g2.connect(ac.destination);
      o2.type = 'sine'; o2.frequency.setValueAtTime(160, t);
      o2.frequency.exponentialRampToValueAtTime(55, t + 0.25);
      g2.gain.setValueAtTime(0.28, t);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o2.start(t); o2.stop(t + 0.32);
    } catch (e) { /* audio not supported */ }
  }

  // A punchy zap (game.js:205-228).
  function playKill() {
    if (muted()) return;
    var ac = getAudioCtx();
    if (!ac) return;
    try {
      var t = ac.currentTime;
      var osc = ac.createOscillator(), gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      osc.type = 'square'; osc.frequency.value = 660;
      osc.frequency.exponentialRampToValueAtTime(170, t + 0.12);
      gain.gain.setValueAtTime(0.28, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      osc.start(t); osc.stop(t + 0.16);
      var o2 = ac.createOscillator(), g2 = ac.createGain();
      o2.connect(g2); g2.connect(ac.destination);
      o2.type = 'square'; o2.frequency.value = 1320;
      g2.gain.setValueAtTime(0.14, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      o2.start(t); o2.stop(t + 0.09);
    } catch (e) { /* audio not supported */ }
  }

  // Four quick rising triangle notes, A5 to A6 (game.js:157-177).
  function playMoney() {
    if (muted()) return;
    var ac = getAudioCtx();
    if (!ac) return;
    try {
      var notes = [[880, 0], [1100, 0.07], [1320, 0.13], [1760, 0.19]];
      for (var i = 0; i < notes.length; i++) {
        var osc = ac.createOscillator();
        var gain = ac.createGain();
        osc.connect(gain);
        gain.connect(ac.destination);
        osc.type = 'triangle';
        osc.frequency.value = notes[i][0];
        var t = ac.currentTime + notes[i][1];
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.25, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
        osc.start(t);
        osc.stop(t + 0.28);
      }
    } catch (e) { /* audio not supported */ }
  }

  // The shared fanfare (game.js:231-236).
  function playCashout() {
    if (muted()) return;
    var ac = getAudioCtx();
    if (!ac) return;
    var cs = root.CashoutSound;
    if (cs && typeof cs.play === 'function') cs.play(ac, ac.destination, vol());
  }

  // ---- per socket
  var joined = false;
  var cashed = false;
  var kills = 0;
  var played = { join: 0, death: 0, kill: 0, cashout: 0 };

  slx.on('open', function () {
    joined = false;
    cashed = false;
    kills = 0;
  });
  slx.on('ownAdd', function () {
    if (joined) return;
    joined = true;
    played.join++;
    playJoin();
  });
  slx.on('ownDead', function () {
    if (cashed) return;
    played.death++;
    playDeath();
  });
  slx.on('ownKills', function (ev) {
    var n = ev && typeof ev.count === 'number' ? ev.count : 0;
    if (n > kills) {
      played.kill++;
      playKill();
    }
    if (n > kills) kills = n;
  });
  slx.on('x:cashed', function () {
    if (cashed) return;
    cashed = true;
    played.cashout++;
    playCashout();
  });
  var money = 0;
  slx.on('x:w', function (m) {
    if (!m || typeof m.d !== 'number' || !(m.d > 0)) return;
    money++;
    playMoney();
  });

  slx.sound = {
    // For tests and the console: how many times each sound was asked for.
    played: function () {
      return { join: played.join, death: played.death, kill: played.kill, cashout: played.cashout };
    },
    // The money chime's count, apart so played() keeps its shape for a free room.
    money: function () { return money; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
