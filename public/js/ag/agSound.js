// In-game sounds for the agar.io redo: OUR OWN short WebAudio tones played at the reference
// client's cue points, ALWAYS ON (Owen 2026-10-15: every agar.io setting is gone, sound is
// hard-wired on; it was off by default with an on/off button, build brief fact 2.13, Q41; the
// sounds themselves are CHOSEN). The cue gates are the reference rules
// (protocol-semantics 3.2 "Sounds", client-camera-input 8.5 and 8.6); the tones are ours.
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
  var CUES = ['split', 'shoot', 'eatCell', 'eatOwnCell', 'gameOver', 'splitBecauseVirus'];

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

  // Our tones (CHOSEN): oscillator type, start and end frequency (Hz), length (s), peak gain.
  var TONES = {
    split: { type: 'sine', f0: 320, f1: 640, dur: 0.12, gain: 0.5 },
    shoot: { type: 'square', f0: 220, f1: 130, dur: 0.06, gain: 0.25 },
    eatCell: { type: 'sine', f0: 520, f1: 900, dur: 0.08, gain: 0.5 },
    eatOwnCell: { type: 'triangle', f0: 440, f1: 660, dur: 0.10, gain: 0.5 },
    gameOver: { type: 'triangle', f0: 440, f1: 110, dur: 0.60, gain: 0.6 },
    splitBecauseVirus: { type: 'sawtooth', f0: 180, f1: 60, dur: 0.25, gain: 0.3 }
  };
  var MASTER = 0.15;

  // A sound player, always on. env: { createAudioContext() (default: window AudioContext) }.
  // Nothing is read from or written to storage: there is no on/off any more.
  function createSound(env) {
    env = env || {};
    var ac = null;
    var inGame = false;
    var played = [];

    function makeContext() {
      if (env.createAudioContext) return env.createAudioContext();
      var C = root.AudioContext || root.webkitAudioContext;
      return C ? new C() : null;
    }
    function audio() {
      if (!ac) {
        try { ac = makeContext(); } catch (e) { ac = null; }
      }
      if (ac && ac.state === 'suspended' && ac.resume) {
        try { ac.resume(); } catch (e) { /* resumes on the next gesture */ }
      }
      return ac;
    }

    function tone(spec) {
      var c = audio();
      if (!c) return false;
      var t0 = c.currentTime;
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = spec.type;
      osc.frequency.setValueAtTime(spec.f0, t0);
      osc.frequency.exponentialRampToValueAtTime(spec.f1, t0 + spec.dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(spec.gain * MASTER, t0 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur);
      osc.connect(g);
      g.connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + spec.dur + 0.02);
      return true;
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
        return tone(spec);
      },
      playCues: function (names) {
        for (var i = 0; i < (names ? names.length : 0); i++) api.playCue(names[i]);
      },
      isEnabled: function () { return true; },
      // Entering a game starts (or resumes) the audio context: it follows the Play press that
      // led here, so the first cue is not the one that has to wake it.
      setInGame: function (on) { inGame = !!on; if (inGame) audio(); },
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
