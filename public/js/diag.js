'use strict';
/* ─── Client-side stall recorder ──────────────────────────────────────────────
   Three fixes have been aimed at a once-a-minute hitch and none of them landed,
   because every one of them was reasoned from server code toward a symptom
   only the player can see. This measures the symptom where it actually
   happens: in the browser tab that is drawing the snake.

   It records four things and posts a summary to the server, so the report can
   be read without the player having to open DevTools, pick the right iframe
   and copy a console dump.

     frames     gaps between animation frames. The renderer runs on rAF, so a
                gap here IS the visible freeze, whatever caused it.
     snapshots  gaps between server packets. Separates "the server went quiet"
                from "the browser stopped drawing" — the single most useful
                split, and the one that has been guessed at until now.
     longtasks  any main-thread task over 50ms, with its attribution. This is
                what names the culprit when the browser is the problem: a
                script, a layout, a garbage collection, the parent page.
     memory     JS heap, when the browser exposes it. A sawtooth here means the
                collector, in the TAB rather than on the server.

   Deliberately cheap: three PerformanceObservers and a counter, nothing per
   frame beyond a subtraction, and one small POST every 20 seconds. */

(function () {
  if (window.__duelDiag) return;

  const started = Date.now();
  const D = {
    frames: [],      // {atSec, ms}
    snaps: [],       // {atSec, ms}
    longtasks: [],   // {atSec, ms, name, container}
    heap: [],        // {atSec, usedMB}
    frameCount: 0,
    snapCount: 0,
    worstFrame: 0,
    worstSnapGap: 0,
  };
  window.__duelDiag = D;

  const sec = () => Math.round((Date.now() - started) / 1000);
  const keep = (arr, n) => { if (arr.length > n) arr.shift(); };

  /* ── Frame gaps ──────────────────────────────────────────────────────────
     A frame budget is 16.7ms. Anything past 50 is a visible stutter; the
     threshold is low enough to catch the shoulders of an event, not just its
     peak. */
  let lastFrame = performance.now();
  function frameTick(now) {
    const gap = now - lastFrame;
    lastFrame = now;
    D.frameCount++;
    if (gap > 50) {
      if (gap > D.worstFrame) D.worstFrame = gap;
      D.frames.push({ atSec: sec(), ms: Math.round(gap) });
      keep(D.frames, 60);
    }
    requestAnimationFrame(frameTick);
  }
  requestAnimationFrame(frameTick);

  /* ── Long tasks ──────────────────────────────────────────────────────────
     The important one. A longtask entry says the main thread was blocked and,
     via attribution, roughly by what — including whether it came from THIS
     frame or the page hosting it. */
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const attr = (e.attribution && e.attribution[0]) || {};
        D.longtasks.push({
          atSec: sec(),
          ms: Math.round(e.duration),
          name: e.name || null,                       // 'self', 'same-origin-descendant', ...
          container: attr.containerType || attr.name || null,
        });
        keep(D.longtasks, 60);
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (_) { D.longtaskUnsupported = true; }

  /* ── Heap, where exposed ─────────────────────────────────────────────── */
  setInterval(() => {
    const m = performance.memory;
    if (!m) return;
    D.heap.push({ atSec: sec(), usedMB: Math.round(m.usedJSHeapSize / 1048576) });
    keep(D.heap, 40);
  }, 2000);

  /* ── "It just happened" marker ────────────────────────────────────────────
     Every instrument here assumes the anomalies it records ARE the thing the
     player sees. That has never been checked, and after several wrong turns it
     is the assumption most worth testing.

     Press L the moment the snake hitches. That timestamp goes into the report
     alongside everything else, so the question stops being "which of these
     spikes is his?" and becomes "what was happening at 47 seconds?".

     If a mark lands on a snapshot gap, the instruments are pointed correctly.
     If marks land where every reading is clean, then whatever he is seeing is
     something none of this measures — which would be the single most useful
     thing to learn, and would explain why fixing real bugs kept not helping. */
  D.marks = [];

  function mark() {
    D.marks.push({ atSec: sec(), heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null });
    keep(D.marks, 40);
    // Visible acknowledgement, so it is obvious the press registered.
    try {
      const n = document.createElement('div');
      n.textContent = 'marked ' + sec() + 's';
      n.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999;' +
        'background:#f0a830;color:#100e0b;font:600 13px Archivo,sans-serif;padding:6px 12px;border-radius:8px';
      document.body.appendChild(n);
      setTimeout(() => n.remove(), 900);
    } catch (_) {}
    report();          // send immediately, so a mark is never lost to a refresh
  }

  /* THERE IS NO BUTTON. There used to be one, bottom left, because a keypress
     inside the game iframe goes to the lobby page unless the canvas has focus
     and a whole session of marks was lost to that. The reasoning was right and
     the button still had to go: it sits over the game, and an instrument that
     annoys the person holding it gets switched off, which measures nothing.

     The L key keeps its capture-phase listener below, and everything else this
     file records — frames, snapshots, long tasks, heap — needs no input at all
     and is the part that actually matters. window.__duelDiagMark() marks from
     the console if a mark is ever wanted again. */
  window.__duelDiagMark = function () { mark(); };

  // Capture phase, so the game's own handlers can't swallow it first.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'l' && e.key !== 'L') return;
    if (window._chatTyping) return;
    mark();
  }, true);

  /* And if the lobby page has focus, the press lands in the PARENT document.
     The lobby forwards it down; this accepts it. Same-origin only. */
  window.addEventListener('message', (e) => {
    if (e.origin !== window.location.origin) return;
    if (e.data && e.data.type === 'diag:mark') mark();
  });

  /* Round-trip time, fed from game.js's existing 2-second ping. Paired with
     the snapshot gaps this is what separates network from server: a ping that
     spikes alongside a gap means the wire, a ping that stays flat while
     snapshots gap means the packets left late. */
  D.pings = [];
  /* The drawn body, checked against the spacing it is supposed to have.

     Cheap enough to run every frame: one pass over the points, no
     allocation, and it only records when something is actually wrong. */
  D.body = [];
  D.bodyChecks = 0;
  D.bodyBad = 0;
  window.__duelDiagBody = function (segs, settled, numSegs) {
    if (!segs || segs.length < 8 || !(settled > 0)) return;
    D.bodyChecks++;
    var worstHi = 0, worstLo = Infinity, dupes = 0, loAt = -1;
    /* The last point is the sliding tail and is MEANT to be a fraction of a
       step, so it is excluded — including it reports a fault every frame. */
    for (var i = 2; i < segs.length - 2; i += 2) {
      var dx = segs[i] - segs[i-2], dy = segs[i+1] - segs[i-1];
      var g = Math.sqrt(dx*dx + dy*dy) / settled;   // 1.0 is perfect
      if (g > worstHi) worstHi = g;
      if (g < worstLo) { worstLo = g; loAt = i / 2; }
      if (g < 0.05) dupes++;
    }
    if (worstLo === Infinity) return;
    /* A tenth off is not visible. Half a step out, or a duplicate point, is
       a kink you can see. */
    if (worstHi > 1.5 || worstLo < 0.5 || dupes) {
      D.bodyBad++;
      if (D.body.length < 40) {
        D.body.push({ atSec: Math.round((Date.now() - started) / 1000),
                      hi: +worstHi.toFixed(2), lo: +worstLo.toFixed(2),
                      /* WHICH point, counted from the head. A kink at the head
                         and a kink two from the tail have completely different
                         causes, and the ratio alone cannot tell them apart. */
                      loAt: loAt, fromTail: (segs.length / 2) - loAt,
                      dupes: dupes, pts: segs.length / 2, want: numSegs || 0 });
      }
    }
  };

  /* WHERE THE FRAME GOES.

     "60-70fps, how do I 4x it" cannot be answered by reading the code,
     because the answer is a number and it is a number on HIS machine: his
     GPU, his browser, his monitor. Guessing which phase is expensive is the
     failure mode that has cost this project several rounds already.

     Four performance.now() calls a frame, summed, no allocation. */
  D.phase = Object.create(null);
  window.__duelDiagPhase = function (name, ms) {
    var p = D.phase[name] || (D.phase[name] = { n: 0, sum: 0, max: 0, over8: 0 });
    p.n++; p.sum += ms;
    if (ms > p.max) p.max = ms;
    if (ms > 8.33) p.over8++;      // a whole 120Hz frame in one phase
  };

  /* Every requestAnimationFrame callback, INCLUDING the ones the frame cap
     throws away. fps counts frames drawn; this counts frames offered, which
     is what the display is actually running at. Without it there is no way
     to tell a 240Hz monitor doing too much work from a 60Hz monitor doing
     fine, and those need opposite fixes. */
  D.rafTicks = 0;
  /* Per second, not just an average. The experiment changes the resolution
     partway through, so an average over the whole session would blend the
     two halves together and answer nothing. */
  D.rafTimeline = [];
  D.scaleMarks = [];
  D._rafSecTicks = 0;
  D._rafSecAt = Date.now();
  window.__duelDiagRaf = function () {
    D.rafTicks++; D._rafSecTicks++;
    var n = Date.now();
    if (n - D._rafSecAt >= 1000) {
      if (D.rafTimeline.length < 90) {
        D.rafTimeline.push({ atSec: Math.round((n - started) / 1000),
                             hz: +(D._rafSecTicks * 1000 / (n - D._rafSecAt)).toFixed(1) });
      }
      D._rafSecTicks = 0; D._rafSecAt = n;
    }
  };
  window.__duelDiagMarkScale = function (s) {
    D.scaleMarks.push({ atSec: Math.round((Date.now() - started) / 1000), scale: s });
  };
  window.__duelDiagDisplay = function (d) { D.display = d; };

  window.__duelDiagPing = function (ms) {
    D.pings.push({ atSec: sec(), ms });
    keep(D.pings, 90);
  };

  /* Called by game.js on every snapshot, so the recorder needs no knowledge of
     the socket. */
  window.__duelDiagSnapshot = function () {
    const now = performance.now();
    if (window.__duelDiag._lastSnap) {
      const gap = now - window.__duelDiag._lastSnap;
      if (gap > 100) {
        if (gap > D.worstSnapGap) D.worstSnapGap = gap;
        D.snaps.push({ atSec: sec(), ms: Math.round(gap) });
        keep(D.snaps, 60);
      }
    }
    window.__duelDiag._lastSnap = now;
    D.snapCount++;
  };

  function report() {
    if (!D.frameCount) return;
    const elapsed = Math.max(1, (Date.now() - started) / 1000);
    const body = {
      upSec: Math.round(elapsed),
      fps: +(D.frameCount / elapsed).toFixed(1),
      snapsPerSec: +(D.snapCount / elapsed).toFixed(1),
      worstFrameMs: Math.round(D.worstFrame),
      worstSnapGapMs: Math.round(D.worstSnapGap),
      inIframe: window.self !== window.top,
      frames: D.frames.slice(-25),
      snaps: D.snaps.slice(-25),
      longtasks: D.longtasks.slice(-25),
      heap: D.heap.slice(-20),
      pings: D.pings.slice(-45),
      marks: D.marks.slice(-20),
      rafHz: +((D.rafTicks || 0) / elapsed).toFixed(1),
      rafTimeline: D.rafTimeline || [],
      scaleMarks: D.scaleMarks || [],
      display: D.display || null,
      phases: (function () {
        var out = {};
        for (var k in D.phase) {
          var p = D.phase[k];
          out[k] = { avgMs: +(p.sum / Math.max(1, p.n)).toFixed(2),
                     maxMs: +p.max.toFixed(1), framesOver8ms: p.over8, n: p.n };
        }
        return out;
      })(),
      bodyChecks: D.bodyChecks || 0,
      bodyBad: D.bodyBad || 0,
      body: (D.body || []).slice(-25),
      longtaskUnsupported: !!D.longtaskUnsupported,
      ua: navigator.userAgent.slice(0, 120),
    };
    try {
      fetch('/api/debug/client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  }
  setInterval(report, 20000);
  window.addEventListener('pagehide', report);
})();
