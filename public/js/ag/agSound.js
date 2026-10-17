// In-game sounds for the agar.io redo: the house Glass sounds (public/js/dsSfx.js engine, dsSfxGame.js
// library) played by name at the reference client's cue points, ALWAYS ON (Owen 2026-10-15: every agar.io
// setting is gone, sound is hard-wired on; it was off by default with an on/off button, build brief fact
// 2.13, Q41; the sounds themselves are CHOSEN). The cue gates are the reference rules
// (protocol-semantics 3.2 "Sounds", client-camera-input 8.5 and 8.6); the sounds are ours.
// Loads in the browser (DuelAgarLib.agSound) and under node (the cue logic; no audio there).
(function (root) {
  'use strict';
  var A = root.DuelAgarLib = root.DuelAgarLib || {};

  var fround = Math.fround;

  // Cue names (ours). Their moments:
  //   split              Space pressed, 1..15 own cells and some displayed own size > 60
  //   shoot              W pressed, some own cell with size^2 > 3612.5
  //   eatCell            an eat whose eaten node is not food, not a virus and not flag 0x20
  //   gameOver           the same kind of eat when the eaten node is your only own cell
  //   eatOwnCell         an own cell eats another own cell (merge), any flags
  //   splitBecauseVirus  any eat of a virus
  // Ours, not in the reference (the page calls these from its own events):
  //   join        the first own cell appears
  //   holdStart   the hold-Q cash-out begins
  //   holdCancel  it is let go before the cash-out
  //   cashout     the cash-out went through
  // Two more are eatCell told apart by who ate whom (playCues, below): kill and hurt.
  var CUES = ['split', 'shoot', 'eatCell', 'eatOwnCell', 'gameOver', 'splitBecauseVirus',
    'join', 'holdStart', 'holdCancel', 'cashout'];

  // Split cue gate: the split packet is always sent; the sound needs 1 to 15 own cells and some
  // own displayed size strictly above 60 (single precision, as stored).
  function splitCue(ownSizes) {
    var n = ownSizes ? ownSizes.length : 0;
    if (n === 0 || n > 15) return null;
    for (var i = 0; i < n; i++) if (fround(ownSizes[i]) > 60) return 'split';
    return null;
  }

  // Eject cue gate: some own displayed size with size^2 > 3612.5 (size > 60.104), no count limit.
  function ejectCue(ownSizes) {
    var n = ownSizes ? ownSizes.length : 0;
    for (var i = 0; i < n; i++) {
      var s = fround(ownSizes[i]);
      if (s * s > 3612.5) return 'shoot';
    }
    return null;
  }

  // Cues for one processed eat, in order. e = { eaterOwn, eatenOwn, ownCount (own cells at the
  // time of the eat, before removals), food, virus, ejected (flag 0x20) }.
  function eatCues(e) {
    var out = [];
    if (!e) return out;
    if (!e.food && !e.virus && !e.ejected) {
      if (e.eaterOwn) out.push('eatCell');
      else if (e.eatenOwn && (e.ownCount | 0) <= 1) out.push('gameOver');
      else out.push('eatCell');
    }
    if (e.eaterOwn && e.eatenOwn) out.push('eatOwnCell');
    if (e.virus) out.push('splitBecauseVirus');
    return out;
  }

  // Our sounds (CHOSEN): the Glass name, then optional vol, rate and wobble (a fraction the rate varies
  // by, so the hundredth eat is not the same click) and gap (ms before the same sound may repeat).
  var TONES = {
    split: { sfx: 'g.split' },
    shoot: { sfx: 'g.eject' },
    eatCell: { sfx: 'g.eat', vol: 0.7, wobble: 0.08, gap: 60 },
    eatOwnCell: { sfx: 'g.merge' },
    gameOver: { sfx: 'g.death' },
    splitBecauseVirus: { sfx: 'g.explode', vol: 0.5, rate: 1.15 },
    join: { sfx: 'g.join' },
    holdStart: { sfx: 'g.ringStart' },
    holdCancel: { sfx: 'g.ringCancel' },
    cashout: { sfx: 'g.cashout' },
    kill: { sfx: 'g.kill' },
    hurt: { sfx: 'g.hurt' }
  };

  // A sound player, always on. env: { sfx } (default: the page's DSSfx; none under node, so silent).
  // Nothing is read from or written to storage: there is no on/off any more.
  function createSound(env) {
    env = env || {};
    var inGame = false;
    var played = [];
    var seed = 20261016;

    function engine() { return env.sfx || root.DSSfx || null; }
    // A small fixed generator for the rate wobble (same run, same sounds).
    function rnd() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    }

    function play(spec) {
      var s = engine();
      if (!s || !s.play) return false;
      var o = {};
      if (spec.vol) o.vol = spec.vol;
      if (spec.gap != null) o.gap = spec.gap;
      var rate = (spec.rate || 1) * (1 + (spec.wobble ? (rnd() * 2 - 1) * spec.wobble : 0));
      if (rate !== 1) o.rate = rate;
      return !!s.play(spec.sfx, o);
    }

    var api = {
      // Play one cue; dropped when the player is not in a game (the reference drops in-game
      // sounds the same way).
      playCue: function (name) {
        if (!inGame) return false;
        var spec = TONES[name];
        if (!spec) return false;
        played.push(name);
        if (played.length > 64) played.shift();
        return play(spec);
      },
      // e (optional, the eat the cues came from) tells an eatCell what it was: our cell eating a
      // player is a kill, one of ours eaten (not the last) is a hurt, a merge is left to eatOwnCell.
      playCues: function (names, e) {
        for (var i = 0; i < (names ? names.length : 0); i++) {
          var n = names[i];
          if (n === 'eatCell' && e) n = e.eaterOwn ? (e.eatenOwn ? null : 'kill') : (e.eatenOwn ? 'hurt' : n);
          if (n) api.playCue(n);
        }
      },
      isEnabled: function () { return true; },
      // Entering a game wakes the audio engine: it follows the Play press that led here, so the
      // first cue is not the one that has to wake it.
      setInGame: function (on) {
        inGame = !!on;
        var s = engine();
        if (inGame && s && s.wake) s.wake();
      },
      isInGame: function () { return inGame; },
      played: function () { return played.slice(); }
    };
    return api;
  }

  var shared = null;
  function instance() {
    if (!shared) shared = createSound();
    return shared;
  }

  var agSound = {
    CUES: CUES,
    TONES: TONES,
    splitCue: splitCue,
    ejectCue: ejectCue,
    eatCues: eatCues,
    createSound: createSound,
    // Module-level player: playCue(name).
    playCue: function (name) { return instance().playCue(name); },
    isEnabled: function () { return instance().isEnabled(); },
    setInGame: function (on) { return instance().setInGame(on); },
    instance: instance
  };
  A.agSound = agSound;
  if (typeof module !== 'undefined' && module.exports) module.exports = agSound;
})(typeof window !== 'undefined' ? window : globalThis);
