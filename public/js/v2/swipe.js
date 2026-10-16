'use strict';
/* ─── Swipe navigation ────────────────────────────────────────────────────────
   Three horizontal gestures, decided by what is under the finger:

     over the games rail   move through the games (a flick, one game per flick)
     on a game's screen    flip to the next or previous game's screen
     anywhere else         drag between tabs

   The tab gesture follows the finger. The next screen is dragged in from the
   edge as you move, so you can push it halfway, look at what is there, and
   either carry on or pull it back. On release it settles to whichever side it
   is closest to, or follows a fast flick even if it did not travel far.

   That is the whole reason this is not a flick handler any more: an
   instant swap, or even an animated one that fires after you let go, gives no
   feedback DURING the gesture, so a half-swipe feels like a tap that did
   nothing and you cannot tell what you are swiping towards.

   The interesting part remains everything that must NOT be treated as a swipe.
   The earnings chart is scrubbed by dragging horizontally, the appearance
   screen has its own left/right controls, and the lobby list scrolls
   vertically inside itself.

   Touch events only, deliberately. Pointer events would also fire for a mouse,
   and a click-drag on a desktop is a text selection, not a swipe. */

(function () {

  const CLAIM_PX = 12;      // horizontal travel before the drag owns the gesture
  const CLAIM_RATIO = 1.2;  // and it must be this much more horizontal than not
  const COMMIT_FRAC = 0.32; // past a third of the screen, it lands on the next tab
  const FLICK_VPX = 0.45;   // px/ms: a fast flick lands it regardless of distance

  /* How long the release takes to travel the distance still left, rather than
     a fixed duration for any distance. A fixed 240ms meant a screen with 30px
     to go spent the same time as one with 350px, crawling the last stretch —
     which is what "it takes half a second to line up" is: the screen arrives
     almost immediately and then creeps the last few pixels into place. */
  const SETTLE_PX_MS = 1.9;  // travel speed of the settle
  const SETTLE_MIN = 90;
  const SETTLE_MAX = 220;

  /* Anything here owns its own horizontal gestures.

     Form fields are deliberately NOT on this list. They were, and it meant the
     player search box on Social ate every swipe that started over it, which on
     a phone is a wide target sitting right where a thumb lands. A text field
     has no horizontal gesture worth protecting: dragging in one moves a caret,
     and the drag has to travel 12px before it claims anything, so a tap to
     focus and type still works exactly as before.

     The winners ticker is not exempt either. It is a CSS marquee with no
     controls of any kind by design, so there is no gesture of its own to
     protect — and it is a wide band sitting in the middle of the home screen,
     so exempting it carved a dead stripe across the most swiped page. */
  const EXEMPT = '.chartbox, .apscreen, #game-frame';

  const TABS = ['play', 'wallet', 'events', 'social', 'settings'];
  const SCREEN_IDS = ['home', 'allgames', 'detail', 'settings-screen',
                      'wallet-screen', 'events-screen', 'social-screen', 'player-screen'];

  let x0 = 0, y0 = 0, t0 = 0, from = null;
  let claimedAt = 0;        // when the last tab drag was claimed (the Shop's previews sit that frame out)
  let tracking = false;     // a touch is down and might become a swipe
  let drag = null;          // the live drag, once one has been claimed

  const el = id => document.getElementById(id);
  /* When the finger was there, not when this code got round to it. A drag's
     first move does real work (the next screen is staged), so the moves behind
     it arrive late and bunched; timed by Date.now() a quick flick read as slow
     and sprang back. The event's own stamp is the finger's clock. */
  const stamp = e => (e && e.timeStamp) || performance.now();
  /* A parked screen (v2.html parkScreen) is laid out but not showing. */
  const visible = e => e && (window.screenShown ? window.screenShown(e) : getComputedStyle(e).display !== 'none');

  function onStart(e) {
    cancelSettle();
    unhold();
    if (e.touches.length !== 1) { tracking = false; return; }   // pinch, not swipe
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; t0 = stamp(e);
    from = e.target;
    tracking = true;
    drag = null;
  }

  /* Which tab a swipe in this direction would land on, or null if there is
     nowhere to go. Screens reached from below the tabs (a game's detail page,
     a player profile) go back to where they came from instead. */
  function targetFor(dir) {
    if (visible(el('detail')) || visible(el('player-screen'))) return null;
    const now = TABS.indexOf(window.route || 'play');
    if (now < 0) return null;
    const next = now + dir;
    if (next < 0 || next >= TABS.length) return null;           // no wrap-around
    return TABS[next];
  }

  function beginDrag(dir) {
    const tab = targetFor(dir);
    if (!tab || !window.prepareScreen) return false;
    const cur = SCREEN_IDS.map(el).find(visible);
    if (!cur) return false;

    /* On a phone every screen is its own fixed scrolling pane, so the two
       already occupy the same box, neither can displace the other, and there
       is no document scroll to reconcile. Nothing needs pinning or measuring,
       and nothing has to be put back afterwards — which is what finally ends
       the pop at the end of a swipe.

       The other branch is the desktop layout, where the screens are still in
       normal flow and the incoming one has to be lifted out and placed over
       the outgoing one. Desktop has no touch, so it is close to unused, but it
       stays correct rather than quietly broken. */
    const paned = getComputedStyle(cur).position === 'fixed';

    /* Flow layout only. Measured BEFORE the incoming screen is shown, because
       prepareScreen puts it into flow for an instant and showing a screen that
       sits EARLIER in the document pushes the outgoing one down by its full
       height — which read as a top of ~1350px on an 812px screen. */
    const r = paned ? null : cur.getBoundingClientRect();

    /* Where a screen sits when the page is at the top, in document space. The
       header is fixed on a phone, so this is a constant: the band under it.

       The incoming screen is pinned HERE rather than at the outgoing screen's
       current position, which is the fix for the drop-and-snap. This used to
       scroll the page to the top first and then measure — but scroll-behavior
       is smooth, so scrollTo ANIMATED: the rect read a moment later was still
       the old scrolled one, the incoming screen got pinned that far down, and
       then the whole page slid up under it. Two visible faults from one line,
       and it also threw away your reading position on every half-swipe.

       Nothing scrolls now until a swipe actually commits, and then only
       instantly. Pinning at the resting position means the incoming screen is
       already exactly where it will end up, so there is nothing left to
       correct when it lands. */
    const restTop = paned ? 0 : r.top + window.scrollY;

    const incoming = window.prepareScreen(tab);
    if (!incoming || incoming === cur) return false;
    const saved = incoming.getAttribute('style') || '';
    incoming.classList.add('scr-drag');        // z-index and will-change
    incoming.style.display = 'block';
    if (paned) {
      /* Arrive at the top of the new screen. Set while it is still off-screen,
         so there is nothing for the eye to catch. */
      incoming.scrollTop = 0;
    } else {
      Object.assign(incoming.style, {
        top: restTop + 'px', left: '0px',
        width: window.innerWidth + 'px', margin: '0',
      });
    }
    cur.classList.add('scr-live');
    document.body.classList.add('scr-dragging');

    claimedAt = performance.now();
    drag = { dir, tab, cur, incoming, saved, paned, w: window.innerWidth, dx: 0,
             lastX: x0, lastT: t0, v: 0 };
    move(0);
    return true;
  }

  /* dx is the finger's travel. Both screens move together, the outgoing one
     off and the incoming one on, and neither is allowed past its stop: a drag
     back the way you came should not pull the previous screen into view from
     the wrong side. */
  function move(dx) {
    if (!drag) return;
    const lim = drag.dir > 0 ? Math.min(0, Math.max(-drag.w, dx))
                             : Math.max(0, Math.min(drag.w, dx));
    drag.dx = lim;
    drag.cur.style.transform = `translateX(${lim}px)`;
    drag.incoming.style.transform = `translateX(${lim + drag.dir * drag.w}px)`;
  }

  /* ── flipping through the games ─────────────────────────────────────────
     On a game's screen (where Free / $0.50 / $1.00 are) a sideways swipe goes
     to the next or previous game's screen, in the rail's order and wrapping
     like the rail, so a player can leaf through every game without going back
     to the list (Owen 2026-10-15).

     It is the tab drag, page for page (Owen 2026-10-15: "exactly like swiping
     between the main screen tabs"). The next game's whole screen, backdrop
     and all, is dragged in from the side the finger is pulling from while the
     one you are on goes out the other side, both 1:1 with the finger; release
     settles with the finger's own speed through the same finish() the tabs
     use, past a third or with a flick, else it springs back.

     It used to move only the column: out with a tween, then the next game's
     column in with a second tween. The second one set its start position and
     its transition in the same style pass, so the browser animated from where
     the first left off (a full screen out on the finger's side) back across
     the screen: swipe right and the new game slid in from the right, moving
     left, against the finger. Nothing here tweens twice any more.

     Two pages need two nodes, and only one game screen exists. So at the claim
     the screen you are on is copied (a still of it, ids kept so the same rules
     style it, canvases copied as pictures and unhooked from the painters, inert
     and hidden from screen readers), the copy is laid exactly over it, and the
     real screen is turned into the next game (V2Detail.flip) and moved to the
     side it comes in from. A commit just drops the copy. A spring-back turns
     the real screen back into the game you were on, with the backdrop's
     running world and the scroll it had, and drops the copy in the same frame.

     Taps are untouched (nothing is claimed before CLAIM_PX of mostly-sideways
     travel) and so is vertical scrolling (a mostly-vertical drag is let go at
     once). The name field keeps its gesture while it is open for typing, and
     nothing moves under the agar.io settings or any other sheet. */
  const anyVeil = () => !!document.querySelector('.howveil.on, .apscreen.on, .veil.on');

  function gBegin(dir, src) {
    if (!window.V2Detail || !window.V2Detail.flip || anyVeil()) return false;
    const name = el('play-name');
    if (src && name && src === name && !name.readOnly) return false;
    const det = el('detail');
    if (!det) return false;
    const paned = getComputedStyle(det).position === 'fixed';
    const r = det.getBoundingClientRect();          // before anything changes
    const keepTop = paned ? det.scrollTop : window.scrollY;

    const still = det.cloneNode(true);
    const live = det.querySelectorAll('canvas'), copy = still.querySelectorAll('canvas');
    copy.forEach((cv, i) => {
      for (const k of ['anim', 'game', 'look', 'half', 'swatch']) delete cv.dataset[k];
      try { if (live[i].width && live[i].height) cv.getContext('2d').drawImage(live[i], 0, 0); } catch (_) {}
    });
    still.setAttribute('aria-hidden', 'true');
    still.inert = true;
    still.classList.add('scr-still');
    /* A fixed pane needs nothing: the copy is the same pane. The game screen
       is not one, even on a phone (#detail.wrap is position:relative), so
       there, and in the desktop layout a tablet gets, the still is pinned
       exactly where the screen is now and the real one moves in flow. */
    if (!paned) Object.assign(still.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px',
                                              width: r.width + 'px', margin: '0', zIndex: '1' });
    det.after(still);                                // after, so getElementById still finds the real one
    if (paned) still.scrollTop = keepTop;

    const back = window.V2Detail.keepBackdrop ? window.V2Detail.keepBackdrop() : null;
    hold(from);
    if (!window.V2Detail.flip(dir)) { still.remove(); unhold(); return false; }

    const saved = det.getAttribute('style') || '';
    det.classList.add(paned ? 'scr-drag' : 'scr-live');
    still.classList.add('scr-live');
    document.body.classList.add('scr-dragging');
    drag = { dir, game: true, cur: still, incoming: det, saved, paned, keepTop, back,
             w: window.innerWidth, dx: 0, lastX: x0, lastT: t0, v: 0 };
    move(0);
    return true;
  }

  /* The finger keeps talking to the node it went down on, even after that
     node leaves the page. The flip above redraws the buy-in row, the lobby
     list and the rest, so a drag that started on a Free button is now aimed at
     a button nothing contains: its moves stop reaching the document, the drag
     is never fed again, nothing calls preventDefault, and Chrome takes the
     rest of a rightward drag as Back (measured: the page left for the previous
     URL). So the node itself passes its moves on for as long as it is out. */
  let held = null;
  const fwd = { move(e) { if (!e.currentTarget.isConnected) onMove(e); },
                end(e) { if (!e.currentTarget.isConnected) onEnd(e); },
                cancel(e) { if (!e.currentTarget.isConnected) onCancel(e); } };
  function hold(node) {
    unhold();
    if (!node || !node.addEventListener) return;
    held = node;
    node.addEventListener('touchmove', fwd.move, { passive: false });
    node.addEventListener('touchend', fwd.end, { passive: true });
    node.addEventListener('touchcancel', fwd.cancel, { passive: true });
  }
  function unhold() {
    if (!held) return;
    held.removeEventListener('touchmove', fwd.move, { passive: false });
    held.removeEventListener('touchend', fwd.end, { passive: true });
    held.removeEventListener('touchcancel', fwd.cancel, { passive: true });
    held = null;
  }

  /* The spring-back: the real screen becomes the game you were on again,
     with the same backdrop world and scroll, in the frame the still goes. */
  function gRestore(d) {
    window.V2Detail.flip(-d.dir);
    if (d.back && window.V2Detail.restoreBackdrop) window.V2Detail.restoreBackdrop(d.back);
    if (d.paned) d.incoming.scrollTop = d.keepTop;
    else if (d.keepTop) {
      const h = document.documentElement, prev = h.style.scrollBehavior;
      h.style.scrollBehavior = 'auto';
      window.scrollTo(0, d.keepTop);
      h.style.scrollBehavior = prev;
    }
  }

  function onMove(e) {
    if (!tracking || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;

    if (!drag) {
      if (Math.abs(dx) < CLAIM_PX) return;
      if (Math.abs(dx) < Math.abs(dy) * CLAIM_RATIO) { tracking = false; return; }
      const src = from && from.closest ? from : null;
      if (src && src.closest(EXEMPT)) { tracking = false; return; }
      if (src && src.closest('.railwrap')) return;      // rail keeps its flick
      const look = el('lookveil');
      if (look && look.classList.contains('on')) { tracking = false; return; }
      /* Finger left: the next one, in from the right. Both drags. */
      const dir = dx < 0 ? 1 : -1;
      if (visible(el('detail'))) {
        if (!gBegin(dir, src)) { tracking = false; return; }
      } else if (!beginDrag(dir)) { tracking = false; return; }
    }

    /* Velocity from the last move only, so a pause before release does not
       still count as a flick. Clamped to at least 1ms: two moves can land in
       the same millisecond during a genuinely fast flick, and dividing by zero
       there used to leave the velocity at 0 — the faster the flick, the more
       likely it was ignored. */
    const now = stamp(e), dt = Math.max(1, now - drag.lastT);
    drag.v = (t.clientX - drag.lastX) / dt;
    drag.lastX = t.clientX; drag.lastT = now;

    e.preventDefault();          // the gesture is ours; stop the page scrolling
    move(dx);
  }

  /* The settle still running, if any: its safety timer and its cleanup. A new
     touch finishes it at once (onStart), so a drag never begins on top of a
     screen that is still moving. The cleanup used to ride on the timer as
     settleTimer._done, but a timer id is a number in a browser and this file
     is strict, so that line threw at the end of every swipe and the cleanup
     was never found. */
  let settleTimer = null, settleDone = null;
  function cancelSettle() {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    const f = settleDone; settleDone = null;
    if (f) f();
  }

  function finish(commit) {
    const d = drag; drag = null;
    if (!d) return;
    const to = commit ? -d.dir * d.w : 0;

    /* Time the settle by the distance still to cover, and let a flick keep its
       own speed so letting go fast does not then finish slowly. */
    const remaining = Math.abs(to - d.dx);
    const speed = Math.max(SETTLE_PX_MS, Math.abs(d.v) || 0);
    const dur = Math.round(Math.min(SETTLE_MAX, Math.max(SETTLE_MIN, remaining / speed)));

    /* Reset the scroll NOW, at the start of the settle, rather than at the end
       when the incoming screen stops being fixed.

       This is the vertical pop. The incoming screen is fixed while it moves,
       so the page scroll does not affect it; the moment it becomes a normal
       part of the page it is placed relative to the document instead, and if
       the scroll is only reset at that same moment the page has to travel to
       catch up. Doing it here means that by the time the swap happens the
       page is already at the top and nothing has anywhere left to go.

       The outgoing screen is scrolled, so it is pushed back down by the same
       amount to keep it exactly where the eye last saw it while it slides
       away. Both happen in one go, so there is no frame in between. */
    /* Only the flow layout needs this. There, the incoming screen is lifted
       out of the page to move, so the moment it is put back it is measured
       against a document scrolled somewhere else and the page has to travel to
       catch up — the vertical pop. Resetting the scroll here, at the start of
       the settle rather than at the swap, means it is already at the top by
       then; the outgoing screen is pushed back down by the same amount so it
       stays where the eye last saw it while it slides away.

       With panes there is no document scroll and no lifting, so there is
       nothing to reset and nothing to compensate. */
    let comp = 0;
    if (commit && !d.paned && window.jumpToTop) comp = window.jumpToTop() || 0;

    /* The compensation has to land instantly, and merely setting it before the
       transition class is not enough: style is recalculated once at the end of
       the task, so the browser sees the new transform and the new transition
       together and animates between them — a 700px vertical slide of the
       screen that is supposed to be standing still. Suppressing the transition
       and reading a layout property forces the value to be committed as the
       base, so the settle that follows starts from it. */
    if (comp) {
      d.cur.style.transition = 'none';
      d.cur.style.transform = `translate(${d.dx}px, ${-comp}px)`;
      void d.cur.offsetHeight;                 // flush; do not remove
      d.cur.style.transition = '';
    }

    for (const e of [d.cur, d.incoming]) {
      e.classList.add('scr-settle');
      e.style.transitionDuration = dur + 'ms';
    }
    // Next frame, so the transition has a start value to animate from. The
    // outgoing screen keeps its vertical compensation for the whole slide.
    requestAnimationFrame(() => {
      d.cur.style.transform = `translate(${to}px, ${-comp}px)`;
      d.incoming.style.transform = `translateX(${to + d.dir * d.w}px)`;
    });

    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      d.incoming.removeEventListener('transitionend', onEndTx);
      clearTimeout(settleTimer);
      settleTimer = null; settleDone = null;
      parkSoon();
      if (d.game) {
        /* The real screen already shows the game it lands on; springing back
           turns it into the one you were on first. Then the still goes, in the
           same frame, so there is never a moment with neither or both. */
        if (!commit) gRestore(d);
        d.cur.remove();
        d.incoming.classList.remove('scr-drag', 'scr-live', 'scr-settle');
        d.incoming.setAttribute('style', d.saved);
        document.body.classList.remove('scr-dragging');
        return;
      }
      d.cur.classList.remove('scr-live', 'scr-settle');
      d.incoming.classList.remove('scr-drag', 'scr-settle');
      d.cur.style.transform = '';
      d.cur.style.transitionDuration = '';
      d.incoming.setAttribute('style', d.saved);
      document.body.classList.remove('scr-dragging');
      if (commit) window.commitScreen(d.tab);
      else if (window.putAway) window.putAway(d.incoming);   // Play is parked, not torn down
      else d.incoming.style.display = 'none';
    };
    /* transitionend rather than a timer alone, so the swap happens the instant
       the movement stops. The timer left a gap after the screen had visibly
       arrived, and under reduced motion — where the stylesheet forces the
       transition to almost nothing — it would have waited out the full
       duration for an animation that never ran. */
    function onEndTx(ev) { if (ev.propertyName === 'transform') done(); }
    d.incoming.addEventListener('transitionend', onEndTx);
    settleTimer = setTimeout(done, dur + 60);   // safety net only
    settleDone = done;
  }

  function onEnd(e) {
    unhold();
    if (drag) {
      const past = Math.abs(drag.dx) > drag.w * COMMIT_FRAC;
      // A flick counts only if it is still heading the way the drag started.
      const flick = Math.abs(drag.v) > FLICK_VPX &&
                    (drag.v < 0 ? 1 : -1) === drag.dir;
      finish(past || flick);
      tracking = false;
      return;
    }
    if (!tracking) return;
    tracking = false;

    /* The rail used to need a synthetic flick here, because it was a transform
       that could only be stepped one card at a time. It is a real scroll
       container now, so the browser handles the flick itself, with momentum
       and at whatever speed the finger actually moved. Calling spin() as well
       would have added a card on top of the distance the scroll already
       covered. onMove still leaves rail touches alone, so a sideways drag
       there scrolls the rail instead of changing tab. */
  }

  function onCancel() {
    unhold();
    if (drag) finish(false);
    tracking = false;
  }

  document.addEventListener('touchstart', onStart, { passive: true });
  // Not passive: once the drag is claimed it calls preventDefault so the page
  // does not scroll underneath the screens being moved.
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onEnd, { passive: true });
  document.addEventListener('touchcancel', onCancel, { passive: true });

  /* ── getting screens ready before a swipe needs them ────────────────────
     Both of these run in idle time, one piece per idle moment, and never while
     a finger is down, a drag or its settle is running, or a game is up (the
     game owns the thread then; they wait and try again). A swipe that comes
     first simply builds its screen the way it always did. */
  const gameUp = () => ['game-frame', 'agar-frame'].some(id => { const f = el(id); return !!f && f.style.display === 'block'; });
  const busy = () => !!(drag || tracking || settleDone || gameUp() || document.hidden);
  const idle = (f, wait = 1500) => window.requestIdleCallback
    ? window.requestIdleCallback(f, { timeout: wait })
    : setTimeout(f, 80);

  /* Warming. A screen's first show costs several times what every later one
     does (v2.html warmScreen says what and how much), and a swipe pays it in
     the frame that claims the drag. So once the page has loaded, each tab's
     screen is laid out once, unseen, the nearest tabs first. */
  function warmAll() {
    const here = TABS.indexOf(window.route || 'play');
    const queue = TABS.filter(t => t !== window.route)
      .sort((a, b) => Math.abs(TABS.indexOf(a) - here) - Math.abs(TABS.indexOf(b) - here));
    const step = () => {
      if (!queue.length || !window.warmScreen) { parkSoon(); return; }
      if (busy()) { setTimeout(() => idle(step), 1000); return; }
      try { window.warmScreen(queue.shift()); } catch (_) {}
      idle(step);
    };
    const first = () => {
      if (busy()) { setTimeout(() => idle(first), 1000); return; }
      warmFormats();
      idle(step);
    };
    idle(first);
  }
  /* The page's money and date formatting, first: the first toLocaleString in
     a page sets up its en-US number data, 7 ms at 1x and 28 at 4x, and dates
     another 1 and 6, after which each call is about free. It used to land in
     whichever swipe formatted the first figure: on the live site, the first
     visit to Social (2026-10-16). */
  function warmFormats() {
    try {
      (0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const d = new Date();
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch (_) {}
  }
  if (document.readyState === 'complete') warmAll();
  else window.addEventListener('load', warmAll, { once: true });

  /* Parking. On a phone Play is parked rather than torn down whenever it is
     left (v2.html putAway), so it is already built when a swipe brings it
     back. A lobby opened on another tab has never built it: that is done
     once here, in idle time, after the warm-up and after every landing
     (v2.html go calls landed()), until it has happened. */
  let parkAsked = false;
  function parkSoon() {
    if (parkAsked || !window.parkScreen) return;
    parkAsked = true;
    idle(() => {
      parkAsked = false;
      if (busy()) { setTimeout(parkSoon, 1000); return; }
      try { window.parkScreen(); } catch (_) {}
    }, 400);                                        // soon: a swipe straight back is common
  }

  window.V2Swipe = { tabs: TABS, targetFor, landed: parkSoon,
                     get dragging() { return !!drag; }, get claimedAt() { return claimedAt; } };
})();
