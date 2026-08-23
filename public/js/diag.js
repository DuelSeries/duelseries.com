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

  /* A whole session's presses were lost to this: the key listener lives inside
     the GAME IFRAME, so unless the canvas holds focus the keydown goes to the
     lobby page around it and never arrives. The player pressed, saw nothing,
     and the report came back with no marks — which reads exactly like "the
     instrument is broken" and wastes a whole round of testing.

     So the button is the primary control and the key is the shortcut. A button
     needs no focus, works on a phone where there is no L key at all, and is
     visibly there, which answers "did that register?" before it is asked. */
  try {
    const b = document.createElement('button');
    b.id = 'diag-mark-btn';
    b.type = 'button';
    b.textContent = '⚑ Mark lag';
    b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99998;' +
      'background:rgba(240,168,48,.92);color:#100e0b;border:0;border-radius:10px;' +
      'font:600 13px Archivo,system-ui,sans-serif;padding:10px 14px;cursor:pointer;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.35);touch-action:manipulation;-webkit-user-select:none;user-select:none';
    // pointerdown, not click: the moment of the hitch is what matters, and it
    // fires on a phone without waiting out the tap delay.
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); mark(); });
    const add = () => document.body && document.body.appendChild(b);
    if (document.body) add(); else window.addEventListener('DOMContentLoaded', add);
  } catch (_) {}

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
