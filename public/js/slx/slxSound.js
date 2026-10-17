// DuelSeries layer on the frozen slither.io client: the game's sounds (Owen Q14 "keep all"; SERVER-DESIGN 15.3
// "Old extras kept"; task T17). Ours, not a parity area; their client has no sound.
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20).
//
// Every sound is a DSSfx buffer in the house Glass style (public/js/dsSfx.js engine, public/js/dsSfxGame.js sounds,
// both loaded by sl.html before the client): a trigger only starts a pre-rendered buffer, so nothing waits. This file
// owns no audio context and builds no oscillators. The old mute and volume globals are honoured as before
// (window.gameMuted, gameMasterVol, gameSfxVol) through DSSfx.setLevel; the engine unlocks itself on the first gesture.
//
// Triggers, from the tap (slxNet):
//   join      the own snake_add ('ownAdd'), once per socket                          g.join
//   death     the own `dead` ('ownDead'), unless this socket cashed out              g.death
//   kill      the own kill_count rose ('ownKills'; their server sends the killer's total, slView L40)   g.kill
//   cash-out  sl:x {t: 'cashed'} (the server sends it before the own `dead`, server/sl/slRoom.js _cashOut)   g.cashout
//   money     a paid room's own sl:x {t: 'w', d} with d > 0, the own snake ate gold (PAID-SL-DESIGN 9; only the own
//             seat's worth message carries d, server/sl/slRoom.js _worthAll). A free room never sends it.   g.pickup
//   eat       a frame's food_eat whose eater is the own snake: one soft pat per frame, rate varied, 40 ms apart   g.eat
//   boost     the outbound {type: 'boost', on}, only when it changes                 g.boostOn, g.boostOff
//   ring      sl:x {t: 'hold'} for the own snake (hold Q): it starts, or it ends with no cash-out and no death
//             (the server sends the ring's end before 'cashed' and the stream's `dead`, so a short wait decides)
//                                                                                    g.ringStart, g.ringCancel
//   battle royale, sl:x {t: 'br'} (slxBr.js): the last 3 whole seconds of the count, tick when their HUD number flips;
//             GO when the match starts; the circle's warning and closing once each; a win when the winner is this
//             player in play mode (slxBr's "You won")                                g.tick, g.go, g.warn, g.danger, g.win
//   chat      sl:x {t: 'chat'} from another name (never the own line)                g.chat
//   refused   sl:x {t: 'refused'}                                                    g.err
// A watcher (the free room's Spectate, the event's Watch) follows another snake as its own: no eat or ring sounds.
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var doc = root.document;
  if (!doc || typeof slx.on !== 'function') return;

  var EAT_GAP = 40; // ms between pats, so a big meal is a patter and not a buzz (Owen's brief)
  var EAT_RATE_MIN = 0.9; // the slowest pat (Owen's brief)
  var EAT_RATE_SPAN = 0.35; // up to 1.25 (Owen's brief)
  var CHAT_GAP = 400; // ms between chat pings (Owen's brief)
  var RING_WAIT = 50; // ms to see whether a ring's end was a cash-out or a death (both follow in the same flush)
  var COUNT_SECS = 3; // the last whole seconds of the count that tick (Owen's brief)

  // ---- the engine (public/js/dsSfx.js)
  function muted() {
    return !!root.gameMuted;
  }
  function vol() {
    var m = root.gameMasterVol;
    var s = root.gameSfxVol;
    return (m == null ? 1 : m) * (s == null ? 0.5 : s);
  }

  var bound = false;
  function sfx() {
    var s = root.DSSfx;
    if (!s || typeof s.play !== 'function') return null;
    if (!bound && typeof s.setLevel === 'function') {
      bound = true;
      s.setLevel(function () { return muted() ? 0 : vol(); });
    }
    return s;
  }
  sfx();

  function play(name, opts) {
    var s = sfx();
    if (!s) return false;
    try {
      return s.play(name, opts) !== false;
    } catch (e) {
      return false;
    }
  }

  // A small fixed generator for the eat pitch (the layer keeps to fixed sequences).
  var seed = 12345;
  function rand() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  // ---- who is who
  function ownId() {
    var S = D.S;
    var me = S ? S.slither : null;
    return me && typeof me.id === 'number' ? me.id : null;
  }
  function ownNick() {
    var m = D.slMain;
    return m && typeof m.nick === 'string' ? m.nick : '';
  }
  // Their client follows the watched snake as its own (slxWatch, slxBr watch mode).
  function watching() {
    var br = slx.br;
    if (br && typeof br.mode === 'function' && br.mode() === 'watch') return true;
    var w = slx.watch;
    return !!(w && typeof w.state === 'function' && w.state().on === true);
  }

  // ---- per socket
  var joined = false;
  var cashed = false;
  var kills = 0;
  var boosting = false;
  var ringOn = false;
  var ringTimer = null;
  var myId = 0; // the own snake's id (slxBr's winner check)
  var brState = null; // the last sl:x {t: 'br'} state; null before this socket's first
  var brPhase = '';
  var brTimers = [];
  var tickedK = COUNT_SECS + 1; // the lowest count second already ticked
  var played = { join: 0, death: 0, kill: 0, cashout: 0 };

  function clearRing() {
    ringOn = false;
    if (ringTimer !== null) {
      root.clearTimeout(ringTimer);
      ringTimer = null;
    }
  }
  function clearCount() {
    for (var i = 0; i < brTimers.length; i++) root.clearTimeout(brTimers[i]);
    brTimers = [];
  }

  slx.on('open', function () {
    joined = false;
    cashed = false;
    kills = 0;
    boosting = false;
    brState = null;
    brPhase = '';
    tickedK = COUNT_SECS + 1;
    clearRing();
    clearCount();
  });
  slx.on('close', function () {
    clearRing();
    clearCount();
  });
  slx.on('ownAdd', function (ev) {
    if (ev && typeof ev.id === 'number') myId = ev.id;
    if (joined) return;
    joined = true;
    played.join++;
    play('g.join');
  });
  slx.on('ownDead', function () {
    boosting = false;
    clearRing();
    if (cashed) return;
    played.death++;
    play('g.death');
  });
  slx.on('ownKills', function (ev) {
    var n = ev && typeof ev.count === 'number' ? ev.count : 0;
    if (n > kills) {
      played.kill++;
      play('g.kill');
    }
    if (n > kills) kills = n;
  });
  slx.on('x:cashed', function () {
    if (cashed) return;
    cashed = true;
    clearRing();
    played.cashout++;
    play('g.cashout');
  });
  var money = 0;
  slx.on('x:w', function (m) {
    if (!m || typeof m.d !== 'number' || !(m.d > 0)) return;
    money++;
    play('g.pickup');
  });

  // ---- eating: one pat per frame that has an own food_eat (slApply onFoodEat; the server sends cmd '<' with an eater)
  slx.on('frame', function (events) {
    if (!events) return;
    var id = ownId();
    if (id === null) return;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev && ev.type === 'food_eat' && ev.eater === id) {
        if (!watching()) play('g.eat', { rate: EAT_RATE_MIN + rand() * EAT_RATE_SPAN, gap: EAT_GAP });
        return;
      }
    }
  });

  // ---- boost: the outbound records, a sound only when the state changes
  slx.on('send', function (list) {
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!r || r.type !== 'boost') continue;
      var on = !!r.on;
      if (on === boosting) continue;
      boosting = on;
      play(on ? 'g.boostOn' : 'g.boostOff');
    }
  });

  // ---- the cash-out ring (hold Q): the own snake's {t: 'hold', id, on}
  slx.on('x:hold', function (m) {
    var id = ownId();
    if (!m || id === null || m.id !== id || watching()) return;
    if (m.on) {
      if (ringOn) return;
      ringOn = true;
      play('g.ringStart');
      return;
    }
    if (!ringOn) return;
    clearRing();
    // the end of a finished hold comes before 'cashed', and a death before the stream's `dead`: both clear this
    ringTimer = root.setTimeout(function () {
      ringTimer = null;
      play('g.ringCancel');
    }, RING_WAIT);
  });

  // ---- battle royale
  function won(m) {
    var w = m.winner;
    var br = slx.br;
    if (!w || typeof w.id !== 'number' || !br || typeof br.mode !== 'function' || br.mode() !== 'play') return false;
    var id = myId || ownId();
    return !!id && w.id === id;
  }
  // A tick when their HUD number flips to k (slxBr secsLeft: the seconds left, rounded up). The sl:x only comes about
  // once a second, so the flips ahead are timed from the message.
  function count(leftMs) {
    clearCount();
    var shown = Math.ceil(leftMs / 1000);
    for (var k = COUNT_SECS; k >= 1; k--) {
      if (k >= tickedK) continue;
      if (k === shown) {
        tickedK = k;
        play('g.tick');
      } else if (k < shown) {
        brTimers.push(root.setTimeout(tickFor(k), leftMs - k * 1000));
      }
    }
  }
  function tickFor(k) {
    return function () {
      if (k >= tickedK) return;
      tickedK = k;
      play('g.tick');
    };
  }
  slx.on('x:br', function (m) {
    if (!m) return;
    var state = typeof m.state === 'string' ? m.state : '';
    var phase = typeof m.phase === 'string' ? m.phase : '';
    var left = typeof m.countdownMs === 'number' && m.countdownMs > 0 ? m.countdownMs : 0;
    if (state === 'countdown') {
      count(left);
    } else {
      clearCount();
      tickedK = COUNT_SECS + 1;
    }
    // the first message of a socket is the baseline: joining a match that is on is not its start
    if (brState !== null) {
      if (brState === 'countdown' && state === 'running') play('g.go');
      if (state === 'running' && phase !== brPhase) {
        if (phase === 'warning') play('g.warn');
        else if (phase === 'closing') play('g.danger');
      }
      if (state === 'over' && brState !== 'over' && won(m)) play('g.win');
    }
    brState = state;
    brPhase = phase;
  });

  // ---- chat from others (slxChat shows the lines; the own line comes back under the own name)
  slx.on('x:chat', function (m) {
    if (!m || typeof m.text !== 'string' || !m.text) return;
    if (typeof m.name === 'string' && m.name === ownNick()) return;
    play('g.chat', { gap: CHAT_GAP });
  });

  slx.on('x:refused', function () {
    play('g.err');
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
