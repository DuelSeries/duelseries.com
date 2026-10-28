'use strict';
/* ─── Air Hockey: the sound ──────────────────────────────────────────────────
   The house engine (dsSfx.js) and its Glass game pack (dsSfxGame.js), plus the
   sounds only an air hockey table makes, defined the same way: a few lines of
   numbers, synthesised once at load, no files.
     a mallet on the puck  ah.hit     a hard plastic clack, deeper and louder the harder the hit
     the rail              ah.rail    a short knock
     a post                ah.post    a ring off the metal edge of the mouth
     a goal                ah.goal    the puck dropping into the slot, then the buzzer
     the serve             ah.serve   a soft puff of air under the puck
     the end               ah.end     the long buzzer
     3, 2, 1 and go        g.tick / g.go
     match found / won / lost / refused   g.join, g.win, g.lose, g.err

   airhockey.js feeds it: attach() once with the socket, local() for every
   hit, rail and post the moment the screen predicts it (so a hit is heard on
   the frame it is seen). The server's copies of those are skipped for a
   player, except the other player's hits, which this screen can only guess.
   Watching a match: every sound comes from the server, and no win or loss. */

(function (root) {
  const S = root.DSSfx;
  if (!S) return;
  const mf = S.mf;
  let muted = false;
  S.setLevel(function () { return muted ? 0 : 1; });

  const thump = (f0, f1, d, v, at) => ({ o: 's', f: [f0, f1], d: d, v: v, e: d / 3.5, at: at || 0 });
  S.define({
    'ah.hit':   [{ o: 'n', d: 0.035, v: 0.3, bp: [3200, 1.4], e: 0.008 }, thump(520, 190, 0.07, 0.3),
                 { o: 't', f: [900, 420], d: 0.04, v: 0.08, e: 0.012 }],
    'ah.rail':  [{ o: 'n', d: 0.03, v: 0.16, bp: [1800, 1.1], e: 0.008 }, thump(300, 150, 0.06, 0.2)],
    'ah.post':  [{ o: 'fm', f: 1480, m: 1.41, i: 2.2, d: 0.4, v: 0.08, e: 0.12, ie: 0.05 }, thump(340, 180, 0.05, 0.14)],
    'ah.goal':  [thump(160, 60, 0.18, 0.4), { o: 'n', d: 0.22, v: 0.12, lp: [2400, 300], e: 0.07 },
                 { o: 'q', f: mf(57), du: 0.35, d: 0.62, v: 0.06, a: 0.01, e: 0.5, at: 0.12 },
                 { o: 'q', f: mf(64), du: 0.35, d: 0.62, v: 0.045, a: 0.01, e: 0.5, at: 0.12 }],
    'ah.serve': [{ o: 'n', d: 0.25, v: 0.07, a: 0.04, e: 0.1, bp: [[600, 2400], 0.7] }, thump(240, 160, 0.05, 0.08)],
    'ah.end':   [{ o: 'q', f: mf(52), du: 0.4, d: 1.1, v: 0.08, a: 0.01, e: 0.9 },
                 { o: 'q', f: mf(59), du: 0.4, d: 1.1, v: 0.06, a: 0.01, e: 0.9 }],
  });

  const now = () => (root.performance ? root.performance.now() : Date.now());
  const play = (name, opt) => S.play(name, opt);
  let get = () => ({});
  const view = () => { try { return get() || {}; } catch (_) { return {}; } };
  const W = (root.AHSim && root.AHSim.AH.W) || 600;
  const panAt = (x) => (typeof x === 'number' ? Math.max(-1, Math.min(1, x / W * 2 - 1)) * 0.4 : 0);
  let theirHitAt = -1e9;

  /* kind 'hit' | 'rail' | 'post'; v the strength (the impulse the sim reports); x for the pan (screen side). */
  function sound(kind, v, x) {
    const s = Math.max(0, Math.min(1, (v | 0) / 3000));
    if (kind === 'hit') play('ah.hit', { vol: 0.35 + 0.65 * s, rate: 1.15 - 0.3 * s, pan: panAt(x), gap: 40 });
    else if (kind === 'rail') { if (v > 80) play('ah.rail', { vol: 0.25 + 0.6 * s, rate: 0.95 + Math.random() * 0.1, pan: panAt(x), gap: 45 }); }
    else if (kind === 'post') play('ah.post', { vol: 0.5 + 0.5 * s, pan: panAt(x), gap: 90 });
  }

  function attach(socket, getter) {
    if (typeof getter === 'function') get = getter;
    socket.on('ah:start', () => { if (!view().watch) play('g.join'); });
    socket.on('ah:play', () => play('g.go', { vol: 0.8, gap: 400 }));
    socket.on('ah:serve', () => play('ah.serve', { gap: 300 }));
    socket.on('ah:ev', (list) => {
      if (!Array.isArray(list)) return;
      const v = view();
      for (let i = 0; i < list.length && i < 6; i++) {
        const e = list[i];
        if (!Array.isArray(e) || typeof e[0] !== 'string') continue;
        const kind = e[0] === 'h' ? 'hit' : e[0] === 'p' ? 'post' : 'rail';
        if (!v.watch) {
          // A player already heard everything the screen predicted: only the other player's hits come from here,
          // and only when the screen did not already guess that one.
          if (kind !== 'hit' || e[1] === v.mySide || now() - theirHitAt < 160) continue;
        }
        sound(kind, e[2], v.puckX);
      }
    });
    socket.on('ah:goal', () => play('ah.goal', { gap: 600 }));
    socket.on('ah:whistle', () => play('ah.end', { gap: 800 }));
    socket.on('ah:sudden', () => play('ah.end', { vol: 0.7, gap: 800 }));
    socket.on('ah:refused', () => play('g.err', { vol: 0.7 }));
    socket.on('ah:over', (m) => {
      const v = view();
      if (v.watch || !m) return;
      play(m.winnerId && m.winnerId === v.me ? 'g.win' : m.winnerId ? 'g.lose' : 'g.turn');
    });
  }

  /* The page's own predicted event. */
  function local(kind, side, v, x) {
    if (kind === 'hit' && side !== view().mySide) theirHitAt = now();
    sound(kind, v, x);
  }
  function count() { play('g.tick', { vol: 0.6, rate: 1.1, gap: 300 }); }

  /* ── the music ────────────────────────────────────────────────────────────
     Our own loop, written for this game (Owen 2026-10-28: an original background track with a mute button): 118 BPM
     in A minor, two bars each of Am, F, C and G. A four on the floor kick, a clap on 2 and 4, off-beat hats, an
     eighth-note bass and a sixteenth-note arpeggio over a soft pad, all synthesised live on the engine's own context
     and output (so the lobby's hold silences it too). It plays only while a match is on screen and the tab is
     visible, quietly under the effects; the page's music button turns it off and the choice is remembered. */
  const MUSIC_KEY = 'ah.music';
  let musicWanted = (() => { try { return root.localStorage.getItem(MUSIC_KEY) !== '0'; } catch (_) { return true; } })();
  let playing = false, timer = 0, nextAt = 0, step = 0, bus = null, noise = null;
  const BPM = 118, S16 = 60 / BPM / 4;
  const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];   // Am F C G
  const ARP = [0, 1, 2, 1, 0, 2, 1, 2];
  const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);

  function voice(c, type, f0, f1, at, dur, vol, filt) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, at + dur * 0.8);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + Math.min(0.012, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    let tail = g;
    if (filt) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filt; g.connect(f); tail = f; }
    o.connect(g); tail.connect(bus);
    o.start(at); o.stop(at + dur + 0.02);
  }
  function hiss(c, at, dur, vol, type, freq) {
    if (!noise) {
      noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = noise; f.type = type; f.frequency.value = freq;
    g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    s.connect(f); f.connect(g); g.connect(bus);
    s.start(at, Math.random() * 0.5); s.stop(at + dur + 0.02);
  }
  function note(c, i, at) {
    const s = i % 16, bar = Math.floor(i / 16) % 8, ch = CHORDS[bar >> 1];
    if (s % 4 === 0) voice(c, 'sine', 150, 42, at, 0.28, 0.55);
    if (s === 4 || s === 12) hiss(c, at, 0.13, 0.16, 'bandpass', 1700);
    if (s % 4 === 2) hiss(c, at, 0.04, 0.07, 'highpass', 7000);
    if (s % 2 === 0) voice(c, 'sawtooth', hz(ch[0] - 24), 0, at, S16 * 1.8, 0.13, 520);
    voice(c, 'triangle', hz(ch[ARP[s % 8]] + 12), 0, at, S16 * 1.6, 0.045);
    if (s === 0 && bar % 2 === 0) for (const n of ch) voice(c, 'sine', hz(n), 0, at, S16 * 30, 0.028);
  }
  function pump() {
    const c = S.context();
    if (!c || !playing) return;
    if (c.state !== 'running') { nextAt = 0; return; }            // waits for the first gesture without piling up
    if (!nextAt || nextAt < c.currentTime) nextAt = c.currentTime + 0.06;
    while (nextAt < c.currentTime + 0.22) { note(c, step, nextAt); nextAt += S16; step = (step + 1) % 128; }
  }
  function musicStart() {
    if (playing || !musicWanted || muted) return;
    const c = S.context();
    if (!c) return;
    bus = c.createGain(); bus.gain.value = 0.2; bus.connect(S.output());
    playing = true; nextAt = 0; step = 0;
    timer = root.setInterval(pump, 50);
    pump();
  }
  function musicStop() {
    if (!playing) return;
    playing = false;
    root.clearInterval(timer);
    const c = S.context(), b = bus;
    bus = null;
    if (c && b) { b.gain.setTargetAtTime(0.0001, c.currentTime, 0.08); root.setTimeout(() => { try { b.disconnect(); } catch (_) {} }, 600); }
  }
  let inMatch = false;
  function music(on) { inMatch = !!on; if (inMatch && !(root.document && root.document.hidden)) musicStart(); else musicStop(); }
  if (root.document) root.document.addEventListener('visibilitychange', () => music(inMatch));
  function toggleMusic() {
    musicWanted = !musicWanted;
    try { root.localStorage.setItem(MUSIC_KEY, musicWanted ? '1' : '0'); } catch (_) {}
    music(inMatch);
    return musicWanted;
  }

  root.AirHockeySound = { attach, local, count, music, toggleMusic, musicOn: () => musicWanted,
    setMuted: (v) => { muted = !!v; if (muted) musicStop(); } };
})(window);
