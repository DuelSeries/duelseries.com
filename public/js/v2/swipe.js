'use strict';
/* ─── Swipe navigation ────────────────────────────────────────────────────────
   Two horizontal gestures, decided by what is under the finger:

     over the games rail   move through the games (a flick, one game per flick)
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

  const TABS = ['play', 'wallet', 'stats', 'social', 'locker', 'settings'];
  const SCREEN_IDS = ['home', 'allgames', 'detail', 'locker-screen', 'settings-screen',
                      'wallet-screen', 'stats-screen', 'social-screen', 'player-screen'];

  let x0 = 0, y0 = 0, t0 = 0, from = null;
  let tracking = false;     // a touch is down and might become a swipe
  let drag = null;          // the live drag, once one has been claimed

  const el = id => document.getElementById(id);
  const visible = e => e && getComputedStyle(e).display !== 'none';

  function onStart(e) {
    cancelSettle();
    if (e.touches.length !== 1) { tracking = false; return; }   // pinch, not swipe
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
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

    drag = { dir, tab, cur, incoming, saved, paned, w: window.innerWidth, dx: 0,
             lastX: x0, lastT: Date.now(), v: 0 };
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
      if (!beginDrag(dx < 0 ? 1 : -1)) { tracking = false; return; }
    }

    /* Velocity from the last move only, so a pause before release does not
       still count as a flick. Clamped to at least 1ms: two moves can land in
       the same millisecond during a genuinely fast flick, and dividing by zero
       there used to leave the velocity at 0 — the faster the flick, the more
       likely it was ignored. */
    const now = Date.now(), dt = Math.max(1, now - drag.lastT);
    drag.v = (t.clientX - drag.lastX) / dt;
    drag.lastX = t.clientX; drag.lastT = now;

    e.preventDefault();          // the gesture is ours; stop the page scrolling
    move(dx);
  }

  let settleTimer = null;
  function cancelSettle() {
    if (settleTimer) { clearTimeout(settleTimer); const f = settleTimer._done; settleTimer = null; if (f) f(); }
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
      settleTimer = null;
      d.cur.classList.remove('scr-live', 'scr-settle');
      d.incoming.classList.remove('scr-drag', 'scr-settle');
      d.cur.style.transform = '';
      d.cur.style.transitionDuration = '';
      d.incoming.setAttribute('style', d.saved);
      document.body.classList.remove('scr-dragging');
      if (commit) window.commitScreen(d.tab);
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
    settleTimer._done = done;
  }

  function onEnd(e) {
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
    if (drag) finish(false);
    tracking = false;
  }

  document.addEventListener('touchstart', onStart, { passive: true });
  // Not passive: once the drag is claimed it calls preventDefault so the page
  // does not scroll underneath the screens being moved.
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onEnd, { passive: true });
  document.addEventListener('touchcancel', onCancel, { passive: true });

  window.V2Swipe = { tabs: TABS, targetFor, get dragging() { return !!drag; } };
})();
