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

  function fmtDate(d) {
    const t = Date.parse(d);
    if (isNaN(t)) return String(d == null ? '' : d).replace(/[<&>]/g, '');
    return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function V2Chart(pts, money) {
    if (!pts || !pts.length) return '';
    money = money || (n => '$' + Number(n).toFixed(2));

    /* The plot is drawn in viewBox units and the svg is width:100%/height:auto,
       so raising H alone makes it taller on screen without touching the type:
       the horizontal scale is unchanged, so labels render at the same size and
       simply get more room between them. */
    const W = 980, H = 430, PL = 62, PR = 26, PT = 22, PB = 46;
    const iw = W - PL - PR, ih = H - PT - PB;
    const all = [{ d: pts[0].d, cum: 0, seed: true }].concat(pts);
    const vals = all.map(p => p.cum);
    const hi = Math.max.apply(null, vals.concat([0]));
    const lo = Math.min.apply(null, vals.concat([0]));
    const pad = Math.max((hi - lo) * 0.14, 0.5);
    const top = hi + pad, bot = lo - pad;
    const X = i => PL + (all.length === 1 ? 0 : iw * i / (all.length - 1));
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
    let dates = '';
    const real = all.filter(p => !p.seed);
    const want = Math.min(5, real.length);
    for (let k = 0; k < want; k++) {
      const idx = want === 1 ? real.length - 1
                : Math.round(k * (real.length - 1) / (want - 1));
      const i = idx + 1;                    // +1 for the seed point at index 0
      const anchor = k === 0 ? 'start' : k === want - 1 ? 'end' : 'middle';
      dates += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 22) +
               '" text-anchor="' + anchor + '" font-size="12" fill="var(--tx3)">' +
               fmtDate(real[idx].d) + '</text>';
    }

    const line = all.map((p, i) =>
      (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.cum).toFixed(1)).join(' ');
    const area = line + ' L' + X(all.length - 1).toFixed(1) + ' ' + zy.toFixed(1) +
                 ' L' + X(0).toFixed(1) + ' ' + zy.toFixed(1) + ' Z';

    let dots = '';
    for (let i = 1; i < all.length; i++) {
      dots += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(all[i].cum).toFixed(1) +
              '" r="3.2" fill="var(--money)"/>';
    }

    // Geometry the scrubber needs, so it does not recompute any of this.
    const meta = {
      xs: all.map((_, i) => +X(i).toFixed(2)),
      ys: all.map(p => +Y(p.cum).toFixed(2)),
      labels: all.map(p => fmtDate(p.d)),
      values: all.map(p => p.cum),
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

    const nearest = (svgX) => {
      let best = 1, bestD = Infinity;
      // index 0 is the synthetic zero point; never report it as a reading.
      for (let i = 1; i < meta.xs.length; i++) {
        const d = Math.abs(meta.xs[i] - svgX);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    };

    function show(clientX) {
      const r = svg.getBoundingClientRect();
      // The SVG scales to its box, so client pixels convert through the viewBox.
      const svgX = (clientX - r.left) * (meta.W / r.width);
      const i = nearest(svgX);
      scrub.setAttribute('x1', meta.xs[i]); scrub.setAttribute('x2', meta.xs[i]);
      scrub.setAttribute('opacity', '.55');
      dot.setAttribute('cx', meta.xs[i]); dot.setAttribute('cy', meta.ys[i]);
      dot.setAttribute('opacity', '1');
      tip.innerHTML = '<b>' + money(meta.values[i]) + '</b><span>' + meta.labels[i] + '</span>';
      tip.classList.add('on');
      // Keep the readout inside the box rather than letting it hang off an edge.
      const px = meta.xs[i] / meta.W * r.width;
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
    svg.addEventListener('pointerdown', e => {
      svg.setPointerCapture(e.pointerId); show(e.clientX);
    });
    svg.addEventListener('pointermove', e => {
      if (e.pressure > 0 || e.buttons || e.pointerType === 'mouse') show(e.clientX);
    });
    svg.addEventListener('pointerup', hide);
    svg.addEventListener('pointercancel', hide);
    svg.addEventListener('pointerleave', hide);
  }

  window.V2Chart = V2Chart;
  window.V2ChartWire = wire;
})();
