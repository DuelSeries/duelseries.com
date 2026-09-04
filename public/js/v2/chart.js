'use strict';
/* ─── Running-total line chart ────────────────────────────────────────────────
   One series, so one hue and no legend: the heading names it. The line opens
   at zero before the first entry, because otherwise the first point reads as
   money that appeared from nowhere.

   Takes points already accumulated: [{ d, cum }] where d is a date (an ISO
   string or anything Date.parse understands) and cum is the running total at
   that point.

   Axes are labelled: dates along the bottom, money up the side.

   Scrubbing: drag a finger or the pointer across it and a line follows, with
   the date and the total at that moment. Touch is the primary case here, so
   the whole plot is one big hit area rather than per-point targets — on a
   phone there is no hover to fall back on and a 14px dot is not findable. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';

/* Axis labels drop the day and name the year once the span is long enough for
   "Sep 3" to appear three times meaning three different years. */
function fmtAxis(t, longSpan) {
  return new Date(t).toLocaleDateString('en-US',
    longSpan ? { month: 'short', year: 'numeric' } : { month: 'short', day: 'numeric' });
}

  function fmtDate(d) {
    const t = Date.parse(d);
    if (isNaN(t)) return String(d == null ? '' : d).replace(/[<&>]/g, '');
    return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function V2Chart(pts, money, from) {
    if (!pts || !pts.length) return '';
    money = money || (n => '$' + Number(n).toFixed(2));

    /* Everything here is in viewBox units and the svg is width:100% with
       height:auto, so the whole drawing scales by (box width / W). On a phone
       the box is about 347px, and against W=980 that is a scale of 0.35 — which
       is why the axis labels were rendering at roughly four pixels. Raising H
       alone would have made a taller chart with the same unreadable type.

       So the phone gets a NARROWER viewBox as well as a taller one: at W=420
       the scale is 0.83, the same font-size 12 lands near 10px, and H=520 makes
       it about 430px tall instead of 152. */
    const narrow = typeof matchMedia === 'function' &&
                   matchMedia('(max-width:520px)').matches;
    const W  = narrow ? 420 : 980, H  = narrow ? 520 : 430;
    const PL = narrow ? 52  : 62,  PR = narrow ? 16  : 26;
    const PT = 22, PB = 46;
    const iw = W - PL - PR, ih = H - PT - PB;
    /* The line opens at zero on the day the account was opened, when the
       caller says when that was. Falling back to the first entry's own date is
       what this did before, and it made the first cash-out look like money
       that appeared from nowhere on day one. */
    const all = [{ d: from || pts[0].d, cum: 0, seed: true }].concat(pts);
    const vals = all.map(p => p.cum);
    const hi = Math.max.apply(null, vals.concat([0]));
    const lo = Math.min.apply(null, vals.concat([0]));
    const pad = Math.max((hi - lo) * 0.14, 0.5);
    const top = hi + pad, bot = lo - pad;
    /* Placed by DATE, not by position in the list. Spacing the points evenly
       drew a year of nothing and an afternoon of three cash-outs at the same
       width, so the shape of the line said nothing about when anything
       happened. Now a quiet stretch is a long flat run, which is the whole
       point of plotting a total over time. */
    const ts = all.map(p => { const t = Date.parse(p.d); return isNaN(t) ? 0 : t; });
    const t0 = Math.min.apply(null, ts), t1 = Math.max.apply(null, ts);
    const X = i => PL + (t1 === t0 ? iw / 2 : iw * (ts[i] - t0) / (t1 - t0));
    const Y = v => PT + ih * (top - v) / (top - bot);
    const zy = Y(0);

    // Money up the side.
    let ticks = '';
    for (let i = 0; i <= 4; i++) {
      const v = bot + (top - bot) * i / 4, y = Y(v).toFixed(1);
      ticks += '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + y + '" y2="' + y +
               '" stroke="var(--s2)" stroke-width="1"/>' +
               '<text x="' + (PL - 10) + '" y="' + (Y(v) + 4).toFixed(1) +
               '" text-anchor="end" font-size="12" fill="var(--tx3)" ' +
               'font-family="var(--fm)">' + (v < 0 ? '-' : '') +
               money(Math.abs(v)).replace(/\.\d\d$/, '') + '</text>';
    }

    /* Dates along the bottom. At most five, evenly spaced, so they never
       collide however many points there are. */
    /* Evenly spaced along the TIME span rather than every Nth entry, so the
       labels describe the axis they sit under. Picking by entry put three
       labels inside one busy afternoon and none across the year beside it. */
    let dates = '';
    const want = Math.min(narrow ? 3 : 5, Math.max(2, all.length));
    for (let k = 0; k < want; k++) {
      const frac = want === 1 ? 1 : k / (want - 1);
      const x = PL + iw * frac;
      const anchor = k === 0 ? 'start' : k === want - 1 ? 'end' : 'middle';
      dates += '<text x="' + x.toFixed(1) + '" y="' + (H - 22) +
               '" text-anchor="' + anchor + '" font-size="12" fill="var(--tx3)">' +
               fmtAxis(t0 + (t1 - t0) * frac, t1 - t0 > 300 * 864e5) + '</text>';
    }

    /* A STEP line, not a sloped one. Your total does not drift upward through a
       quiet Tuesday — it sits still and then jumps the moment you cash out. The
       sloped version invented a number for every instant in between, which is
       also what made scrubbing impossible to get right: the dot on the slope and
       the total in the readout could not both be true. Flat, then a step. */
    let line = 'M' + X(0).toFixed(1) + ' ' + Y(all[0].cum).toFixed(1);
    for (let i = 1; i < all.length; i++) {
      line += ' L' + X(i).toFixed(1) + ' ' + Y(all[i - 1].cum).toFixed(1) +
              ' L' + X(i).toFixed(1) + ' ' + Y(all[i].cum).toFixed(1);
    }
    // Out to today, so the last run is as long as it really is.
    line += ' L' + (W - PR).toFixed(1) + ' ' + Y(all[all.length - 1].cum).toFixed(1);
    const area = line + ' L' + (W - PR).toFixed(1) + ' ' + zy.toFixed(1) +
                 ' L' + X(0).toFixed(1) + ' ' + zy.toFixed(1) + ' Z';

    let dots = '';
    for (let i = 1; i < all.length; i++) {
      dots += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(all[i].cum).toFixed(1) +
              '" r="3.2" fill="var(--money)"/>';
    }

    /* Geometry AND time. The scrubber used to be handed only the point
       positions, so the best it could do was snap to the closest one — which,
       on an account with a handful of cash-outs, meant the readout sat on the
       last one no matter where the finger went. With t0/t1 it can turn any x
       into a real date and read the total as of that day. */
    const meta = {
      xs: all.map((_, i) => +X(i).toFixed(2)),
      ys: all.map(p => +Y(p.cum).toFixed(2)),
      ts: ts,
      values: all.map(p => p.cum),
      t0: t0, t1: t1, iw: iw,
      PL: PL, PR: W - PR, PT: PT, PB: PT + ih, W: W, H: H,
    };

    return '<svg class="v2chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
      'data-meta="' + encodeURIComponent(JSON.stringify(meta)) + '" ' +
      'aria-label="Running total earnings by date, ending at ' +
        money(all[all.length - 1].cum) + '">' +
      '<defs><linearGradient id="v2ag" x1="0" x2="0" y1="0" y2="1">' +
      '<stop offset="0" stop-color="#f0a830" stop-opacity=".26"/>' +
      '<stop offset="1" stop-color="#f0a830" stop-opacity="0"/></linearGradient></defs>' +
      ticks + dates +
      '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + zy.toFixed(1) + '" y2="' +
        zy.toFixed(1) + '" stroke="var(--tx3)" stroke-width="1.5"/>' +
      '<path d="' + area + '" fill="url(#v2ag)"/>' +
      '<path d="' + line + '" fill="none" stroke="var(--money)" stroke-width="2" ' +
        'stroke-linejoin="round" stroke-linecap="round"/>' + dots +
      '<line class="scrub" x1="0" x2="0" y1="' + PT + '" y2="' + (PT + ih) +
        '" stroke="var(--tx2)" stroke-width="1" opacity="0"/>' +
      '<circle class="scrubdot" r="6" fill="var(--money)" stroke="var(--bg)" ' +
        'stroke-width="2.5" opacity="0"/>' +
      '</svg>';
  }

  /* Attach after the SVG is in the DOM. Idempotent: re-attaching replaces the
     old listeners rather than stacking a second set on the same element. */
  function wire(container, money) {
    const svg = container && container.querySelector('svg.v2chart');
    if (!svg || svg._wired) return;
    svg._wired = true;
    money = money || (n => '$' + Number(n).toFixed(2));

    let meta;
    try { meta = JSON.parse(decodeURIComponent(svg.dataset.meta)); } catch (_) { return; }

    const scrub = svg.querySelector('.scrub');
    const dot = svg.querySelector('.scrubdot');
    let tip = container.querySelector('.chartTip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chartTip';
      container.appendChild(tip);
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    }

    /* The running total as of a moment: the last entry at or before it. This is
       a step function, which is what the total actually is, so between two
       cash-outs every day reads the same figure — correctly. */
    const asOf = (t) => {
      let v = meta.values[0], i = 0;
      for (let k = 0; k < meta.ts.length; k++) {
        if (meta.ts[k] <= t) { v = meta.values[k]; i = k; } else break;
      }
      return { v: v, i: i };
    };
    const dayLabel = (t) => new Date(t).toLocaleDateString('en-US',
      { month: 'short', day: 'numeric', year: 'numeric' });

    function show(clientX) {
      const r = svg.getBoundingClientRect();
      // The SVG scales to its box, so client pixels convert through the viewBox.
      let svgX = (clientX - r.left) * (meta.W / r.width);
      svgX = Math.max(meta.PL, Math.min(meta.PR, svgX));
      /* Straight to a DATE. Snapping to the nearest plotted point is what made
         this jump to the last time money came in and stay there: with a handful
         of entries spread over months, almost every x on the axis is nearest to
         the same one. */
      const span = meta.t1 - meta.t0;
      const t = meta.t0 + (span ? (svgX - meta.PL) / meta.iw * span : 0);
      // By INDEX. Looking the level up by value would pick the wrong row the
      // moment two entries share a total, which a zero-value game does.
      const { v, i } = asOf(t);
      const yy = meta.ys[i];
      scrub.setAttribute('x1', svgX.toFixed(1)); scrub.setAttribute('x2', svgX.toFixed(1));
      scrub.setAttribute('opacity', '.55');
      // On the step, so the dot and the figure can never disagree.
      dot.setAttribute('cx', svgX.toFixed(1)); dot.setAttribute('cy', yy);
      dot.setAttribute('opacity', '1');
      tip.innerHTML = '<b>' + money(v) + '</b><span>' + dayLabel(t) + '</span>';
      tip.classList.add('on');
      // Keep the readout inside the box rather than letting it hang off an edge.
      const px = svgX / meta.W * r.width;
      tip.style.left = Math.max(4, Math.min(r.width - tip.offsetWidth - 4,
        px - tip.offsetWidth / 2)) + 'px';
    }
    function hide() {
      scrub.setAttribute('opacity', '0');
      dot.setAttribute('opacity', '0');
      tip.classList.remove('on');
    }

    /* Pointer events cover mouse, pen and touch in one path. touch-action on
       the element stops the browser treating a horizontal drag as a scroll, so
       scrubbing does not fight the page. */
    svg.style.touchAction = 'pan-y';
    /* Tracked with a flag rather than inferred from e.pressure. Plenty of touch
       hardware reports pressure 0 for an ordinary finger, and buttons is 0 for
       touch as well, so the move handler could drop every event in a drag and
       leave the readout frozen where it started. */
    let dragging = false;
    svg.addEventListener('pointerdown', e => {
      dragging = true;
      try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      show(e.clientX);
    });
    svg.addEventListener('pointermove', e => {
      if (dragging || e.pointerType === 'mouse') show(e.clientX);
    });
    svg.addEventListener('pointerup', e => { dragging = false; hide(e); });
    svg.addEventListener('pointercancel', e => { dragging = false; hide(e); });
    // A mouse leaving clears it; a finger dragging past the edge does not, since
    // pointer capture means the drag is still going.
    svg.addEventListener('pointerleave', e => { if (!dragging) hide(e); });
  }

  window.V2Chart = V2Chart;
  window.V2ChartWire = wire;
})();
