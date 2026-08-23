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
