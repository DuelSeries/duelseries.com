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
   phone there is no hover to fall back on and a 14px dot is not findable.

   Quiet stretches are squeezed (Owen, 2026-10-15: "squeeze with a break
   mark"). A month with no cash-out used to take a month of width, so the
   afternoon where everything happened was a hair-thin step at one edge. A
   long gap now shrinks to a thin band marked with a break and how long it
   was; the busy days get the width.

   Zoom (Owen, same day, on both the Wallet and the profile graph): pinch and
   two-finger drag on a phone, the wheel and a drag on a computer, and the
   − + Reset buttons under the graph on both. One finger still scrubs. */
(function () {
  const DAY = 864e5;
  const MAX_ZOOM = 40;          // the narrowest view is 1/40 of the whole line
  const BREAK_W = 0.06;         // a squeezed gap's share of the width
  const MAX_BREAKS = 4;
  let SEQ = 0;                  // gradient and clip ids, one set per chart on the page
  // When anything on the page last scrolled (each lobby screen scrolls itself on a phone).
  let lastScroll = -1e9;
  if (typeof document !== 'undefined' && document.addEventListener)
    document.addEventListener('scroll', () => { lastScroll = performance.now(); }, { capture: true, passive: true });

/* Axis labels drop the day and name the year once the span is long enough for
   "Sep 3" to appear three times meaning three different years; inside two
   days they give the hour, since that is what a zoomed-in view is about. */
function fmtAxis(t, span) {
  const d = new Date(t);
  if (span < 2 * DAY) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString('en-US',
    span > 300 * DAY ? { month: 'short', year: 'numeric' } : { month: 'short', day: 'numeric' });
}

  // The readout's date: the day, and the time too once the view is that close.
  function fmtDate(t, span) {
    if (isNaN(t)) return '';
    const d = new Date(t);
    const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return span < 3 * DAY ? day + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : day;
  }

  // "Sep 3 to Oct 15", or with the hours once the stretch is under three days.
  function rangeLabel(ta, tb) {
    const o = { month: 'short', day: 'numeric' };
    if (tb - ta >= 3 * DAY) return new Date(ta).toLocaleDateString('en-US', o) + ' to ' +
                                   new Date(tb).toLocaleDateString('en-US', o);
    const h = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    return new Date(ta).toLocaleString('en-US', h) + ' to ' + new Date(tb).toLocaleString('en-US', h);
  }

  // How long a squeezed gap was, in the unit a person would say it in.
  function fmtGap(ms) {
    const d = ms / DAY;
    if (d < 14) return Math.round(d) + ' d';
    if (d < 63) return Math.round(d / 7) + ' wk';
    if (d < 730) return Math.round(d / 30.4) + ' mo';
    return Math.round(d / 365) + ' yr';
  }

  /* ─── Time to width ─────────────────────────────────────────────────────────
     A piecewise straight map from a moment to a place along the line, 0 to 1.

     Quiet is judged against the player's own rhythm: a gap is quiet when it
     is at least two days AND at least three times their usual gap between
     cash-outs (the lower median). Someone who cashes out once a week keeps an
     even weekly line; someone who plays an evening, then nothing for a month,
     gets the evening wide and the month as a break. The lead-in from the day
     the account opened to the first cash-out, and the run from the last one
     to today, are judged the same way. The four longest quiet gaps each
     become a break BREAK_W wide, and the rest of the width is shared by time.

     ts: every moment on the line, oldest first: ts[0] is the account opening
     and, when tail is set, the last is "today" rather than a cash-out. */
  function timeMap(ts, tail) {
    const ev = ts.slice().sort((a, b) => a - b);
    const t0 = ev[0], t1 = ev[ev.length - 1], span = t1 - t0;
    const lin = {
      fwd: t => (span ? (t - t0) / span : 0.5),
      inv: u => t0 + u * span,
      segAt: () => ({ ta: t0, tb: t1 }),
      breaks: [], t0: t0, t1: t1,
    };
    if (!(span > 0)) return lin;
    // The usual gap between two cash-outs: not the lead-in, not the run to today.
    const inner = [];
    for (let i = 2; i < ev.length - (tail ? 1 : 0); i++) inner.push(ev[i] - ev[i - 1]);
    inner.sort((a, b) => a - b);
    const usual = inner.length ? inner[Math.floor((inner.length - 1) / 2)] : 0;
    const QUIET = Math.max(2 * DAY, 3 * usual);
    const gaps = [];
    for (let i = 1; i < ev.length; i++) {
      const g = ev[i] - ev[i - 1];
      if (g >= QUIET) gaps.push({ a: ev[i - 1], b: ev[i], g: g });
    }
    const quiet = gaps.sort((x, y) => y.g - x.g).slice(0, MAX_BREAKS);
    /* Every gap quiet (one cash-out, days after joining and days ago): the
       shortest of them keeps its width, or there would be nothing left to
       draw. Never the lead-in while another will do: that is a flat line at
       $0, and the run since the cash-out at least shows the total. */
    let active = span - quiet.reduce((s, q) => s + q.g, 0);
    while (quiet.length && !(active > 0)) {
      let k = quiet.length - 1;
      while (k > 0 && quiet[k].a === t0) k--;
      if (quiet[k].a === t0) k = quiet.length - 1;
      active += quiet.splice(k, 1)[0].g;
    }
    quiet.sort((x, y) => x.a - y.a);
    if (!quiet.length || !(active > 0)) return lin;
    const per = (1 - quiet.length * BREAK_W) / active;
    const segs = [];                       // { ta, tb, ua, ub, brk }
    let t = t0, u = 0;
    for (const q of quiet) {
      if (q.a > t) { const w = (q.a - t) * per; segs.push({ ta: t, tb: q.a, ua: u, ub: u + w }); u += w; }
      segs.push({ ta: q.a, tb: q.b, ua: u, ub: u + BREAK_W, brk: true }); u += BREAK_W;
      t = q.b;
    }
    if (t1 > t) segs.push({ ta: t, tb: t1, ua: u, ub: 1 });
    segs[segs.length - 1].ub = 1;         // no rounding sliver at the right edge
    const fwd = (x) => {
      if (x <= t0) return 0;
      if (x >= t1) return 1;
      for (const s of segs) if (x <= s.tb) return s.ua + (s.ub - s.ua) * ((x - s.ta) / ((s.tb - s.ta) || 1));
      return 1;
    };
    const inv = (v) => {
      if (v <= 0) return t0;
      if (v >= 1) return t1;
      for (const s of segs) if (v <= s.ub) return s.ta + (s.tb - s.ta) * ((v - s.ua) / ((s.ub - s.ua) || 1));
      return t1;
    };
    // The stretch of time a place on the line belongs to, for its axis label.
    const segAt = (v) => {
      for (const s of segs) if (v <= s.ub + 1e-12) return s;
      return segs[segs.length - 1];
    };
    return {
      fwd: fwd, inv: inv, segAt: segAt, t0: t0, t1: t1,
      breaks: segs.filter(s => s.brk).map(s => ({ u0: s.ua, u1: s.ub, ms: s.tb - s.ta })),
    };
  }

  /* The money axis on round steps (1, 2, 2.5 or 5 times a power of ten),
     starting AT zero when the whole line is in view and never goes below it.
     Zoomed in, the axis fits what is on screen instead, or a 45-cent step on
     a $50 total would be too small to see. */
  function moneyAxis(lo, hi, fromZero, money) {
    const raw = Math.max((hi - lo) / 5, fromZero ? 0.25 : 0.01);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
    const bot = fromZero && lo >= 0 ? 0 : Math.floor(lo / step) * step;
    const top = Math.max(bot + step, Math.ceil((hi + step * 0.25) / step) * step);
    const cents = step < 1 || Math.abs(step - Math.round(step)) > 1e-9 ||
                  Math.abs(bot - Math.round(bot)) > 1e-9;
    const marks = [];
    for (let v = bot; v <= top + step / 1000; v += step) {
      const a = Math.abs(v) < step / 1000 ? 0 : v, label = money(Math.abs(a));
      marks.push({ v: v, text: (a < 0 ? '−' : '') + (cents ? label : label.replace(/\.\d\d$/, '')) });
    }
    return { bot: bot, top: top, marks: marks };
  }

  /* Everything that does not change with zoom: the points, their times, the
     squeeze, and the viewBox.

     Everything is in viewBox units and the svg is width:100% with height:auto,
     so the whole drawing scales by (box width / W). On a phone the box is about
     347px, and against W=980 that is a scale of 0.35, which drew the axis
     labels at roughly four pixels. So the phone gets a NARROWER viewBox as well
     as a taller one: at W=420 the scale is 0.83, the same font-size lands near
     10px, and H=520 makes it about 430px tall instead of 152. boxW (the box the
     chart is drawn into, when the caller knows it) sets the desktop viewBox to
     about the box's own width, so the type lands at its stated size. */
  function model(pts, from, boxW) {
    const narrow = typeof matchMedia === 'function' && matchMedia('(max-width:520px)').matches;
    /* The line opens at zero on the day the account was opened, when the
       caller says when that was, so the first cash-out does not look like
       money that appeared from nowhere on day one. */
    const all = [{ d: from || pts[0].d, cum: 0, seed: true }].concat(pts);
    const ts = all.map(p => { const t = Date.parse(p.d); return isNaN(t) ? 0 : t; });
    const map = timeMap(ts, !!all[all.length - 1].end);
    return {
      narrow: narrow,
      W: narrow ? 420 : (boxW > 0 && boxW < 980 ? Math.max(560, Math.round(boxW)) : 980),
      H: narrow ? 520 : 430,
      PR: narrow ? 16 : 26, PT: 22, PB: 46,
      FS: narrow ? 14.5 : 12,     // 12 in the phone's 0.83-scale viewBox was 9px
      all: all, ts: ts, us: ts.map(map.fwd), values: all.map(p => p.cum), map: map,
    };
  }

  // The running total as of a place on the line: the last entry at or before it.
  function levelAt(m, u) {
    let i = 0;
    for (let k = 0; k < m.us.length; k++) { if (m.us[k] <= u + 1e-12) i = k; else break; }
    return i;
  }

  /* One drawing of the view [a, b] (a share of the whole line, 0 to 1).
     Returns the svg's inside and what the scrubber needs to read it back. */
  function draw(m, view, money, id) {
    const a = view[0], b = view[1], full = a <= 0 && b >= 1;
    const W = m.W, H = m.H, PR = m.PR, PT = m.PT, PB = m.PB, FS = m.FS;
    const ih = H - PT - PB;

    // What is on screen: the level carried in from the left, and every entry inside.
    const i0 = levelAt(m, a);
    const seen = [m.values[i0]];
    for (let i = 0; i < m.us.length; i++) if (m.us[i] >= a && m.us[i] <= b) seen.push(m.values[i]);
    const hi = Math.max.apply(null, full ? m.values.concat([0]) : seen);
    const lo = Math.min.apply(null, full ? m.values.concat([0]) : seen);
    const ax = moneyAxis(lo, hi, full, money);

    /* The left margin fits the widest money label (mono, about 0.62 em a
       character), so "$1,000" is never cut down to "1,000" at the edge. */
    const widest = Math.max.apply(null, ax.marks.map(k => k.text.length));
    const PL = Math.max(m.narrow ? 52 : 62, Math.ceil(widest * 0.62 * FS) + 14);
    const iw = W - PL - PR;
    const Xu = u => PL + iw * (u - a) / (b - a);
    const X = i => Xu(m.us[i]);
    const Y = v => PT + ih * (ax.top - v) / (ax.top - ax.bot);
    const base = PT + ih;

    // Money up the side, one label per step.
    let ticks = '';
    for (const k of ax.marks) {
      const y = Y(k.v).toFixed(1);
      ticks += '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + y + '" y2="' + y +
               '" stroke="var(--s2)" stroke-width="1"/>' +
               '<text x="' + (PL - 10) + '" y="' + (Y(k.v) + FS / 3).toFixed(1) +
               '" text-anchor="end" font-size="' + FS + '" fill="var(--tx3)" ' +
               'font-family="var(--fm)">' + k.text + '</text>';
    }

    /* Squeezed gaps: a quiet band, a break cut into the axis, and how long the
       gap really was, so nobody reads the band as an afternoon. */
    let breaks = '';
    for (const br of m.map.breaks) {
      if (br.u1 <= a || br.u0 >= b) continue;
      const x0 = Xu(Math.max(br.u0, a)), x1 = Xu(Math.min(br.u1, b)), cx = (x0 + x1) / 2;
      breaks += '<rect class="brk" x="' + x0.toFixed(1) + '" y="' + PT + '" width="' + (x1 - x0).toFixed(1) +
                '" height="' + ih + '" fill="var(--s2)" opacity=".55"/>';
      if (br.u0 >= a && br.u1 <= b) {
        breaks += '<path d="M' + (cx - 7).toFixed(1) + ' ' + (base + 7) + ' L' + (cx - 1).toFixed(1) + ' ' + (base - 7) +
                  ' M' + (cx + 1).toFixed(1) + ' ' + (base + 7) + ' L' + (cx + 7).toFixed(1) + ' ' + (base - 7) +
                  '" stroke="var(--tx3)" stroke-width="1.5" fill="none"/>';
        if (x1 - x0 >= FS * 2.2)
          breaks += '<text x="' + cx.toFixed(1) + '" y="' + (base - 14) + '" text-anchor="middle" font-size="' +
                    (FS - 1) + '" fill="var(--tx2)">' + fmtGap(br.ms) + '</text>';
      }
    }

    /* Dates along the bottom, evenly spaced across the VIEW, at most five (three
       on a phone) so they never collide. A place inside a squeezed band has no
       single date, so it gets no label: the band says how long it was. Inside a
       stretch shorter than two days (an evening of cash-outs given the width)
       the time goes under the date, or three labels would all read "Jul 11". */
    const inBreak = u => m.map.breaks.some(br => u > br.u0 + 1e-9 && u < br.u1 - 1e-9);
    const span = m.map.inv(b) - m.map.inv(a);
    const want = Math.min(m.narrow ? 3 : 5, Math.max(2, m.all.length));
    let dates = '', last = '';
    for (let k = 0; k < want; k++) {
      const frac = k / (want - 1), u = a + (b - a) * frac;
      if (inBreak(u)) continue;
      const t = m.map.inv(u), seg = m.map.segAt(u);
      const short = Math.min(span, seg.tb - seg.ta) < 2 * DAY;
      const day = fmtAxis(t, Math.max(span, 2 * DAY));
      const hour = short ? new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
      if (day + hour === last) continue;
      last = day + hour;
      const x = (PL + iw * frac).toFixed(1);
      const anchor = k === 0 ? 'start' : k === want - 1 ? 'end' : 'middle';
      dates += '<text x="' + x + '" y="' + (H - (short ? 27 : 22)) +
               '" text-anchor="' + anchor + '" font-size="' + FS + '" fill="var(--tx3)">' + day +
               (short ? '<tspan x="' + x + '" dy="' + (FS + 1) + '" font-size="' + (FS - 1.5) + '">' + hour + '</tspan>' : '') +
               '</text>';
    }

    /* A STEP line, not a sloped one. Your total does not drift upward through a
       quiet Tuesday: it sits still and then jumps the moment you cash out. The
       sloped version invented a number for every instant in between, which is
       also what made scrubbing impossible to get right: the dot on the slope and
       the total in the readout could not both be true. Flat, then a step. */
    const all = m.all;
    let line = 'M' + X(0).toFixed(1) + ' ' + Y(all[0].cum).toFixed(1);
    for (let i = 1; i < all.length; i++) {
      line += ' L' + X(i).toFixed(1) + ' ' + Y(all[i - 1].cum).toFixed(1) +
              ' L' + X(i).toFixed(1) + ' ' + Y(all[i].cum).toFixed(1);
    }
    // Out to the right edge of the whole line, so the last run is as long as it really is.
    const xEnd = Math.max(Xu(1), X(all.length - 1));
    line += ' L' + xEnd.toFixed(1) + ' ' + Y(all[all.length - 1].cum).toFixed(1);
    const area = line + ' L' + xEnd.toFixed(1) + ' ' + base.toFixed(1) +
                 ' L' + X(0).toFixed(1) + ' ' + base.toFixed(1) + ' Z';

    let dots = '';
    for (let i = 1; i < all.length; i++) {
      if (m.us[i] < a - 0.001 || m.us[i] > b + 0.001) continue;
      dots += '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(all[i].cum).toFixed(1) +
              '" r="3.2" fill="var(--money)"/>';
    }

    /* The fill is the line's own colour fading to nothing. Its id is this
       chart's own: the Wallet and a profile each draw one, and while both ids
       were "v2ag" the profile's fill pointed at the Wallet's gradient, which
       sits in a hidden screen, and Chrome paints a gradient from a hidden svg
       as nothing. That is why the profile graph had no fill. */
    const gid = 'v2ag' + id, cid = 'v2clip' + id;
    const html =
      '<defs><linearGradient id="' + gid + '" x1="0" x2="0" y1="0" y2="1">' +
      '<stop offset="0" style="stop-color:var(--money);stop-opacity:.32"/>' +
      '<stop offset=".7" style="stop-color:var(--money);stop-opacity:.08"/>' +
      '<stop offset="1" style="stop-color:var(--money);stop-opacity:0"/></linearGradient>' +
      '<clipPath id="' + cid + '"><rect x="' + PL + '" y="' + (PT - 8) + '" width="' + iw +
        '" height="' + (ih + 8) + '"/></clipPath></defs>' +
      ticks + breaks + dates +
      '<g clip-path="url(#' + cid + ')">' +
        '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
        '<path d="' + line + '" fill="none" stroke="var(--money)" stroke-width="2" ' +
          'stroke-linejoin="round" stroke-linecap="round"/>' + dots +
      '</g>' +
      '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + base.toFixed(1) + '" y2="' +
        base.toFixed(1) + '" stroke="var(--tx3)" stroke-width="1.5"/>' +
      '<line class="scrub" x1="0" x2="0" y1="' + PT + '" y2="' + base +
        '" stroke="var(--tx2)" stroke-width="1" opacity="0"/>' +
      '<circle class="scrubdot" r="6" fill="var(--money)" stroke="var(--bg)" ' +
        'stroke-width="2.5" opacity="0"/>';

    return { html: html, meta: { a: a, b: b, PL: PL, PR: W - PR, iw: iw, W: W, span: span, Y: Y } };
  }

  function svgOpen(m, money) {
    return '<svg class="v2chart" viewBox="0 0 ' + m.W + ' ' + m.H + '" role="img" ' +
      'aria-label="Running total earnings by date, ending at ' +
      money(m.values[m.values.length - 1]) + '">';
  }

  // The whole line as a string, for a caller that only wants the picture.
  function V2Chart(pts, money, from, boxW) {
    if (!pts || !pts.length) return '';
    money = money || (n => '$' + Number(n).toFixed(2));
    const m = model(pts, from, boxW);
    return svgOpen(m, money) + draw(m, [0, 1], money, ++SEQ).html + '</svg>';
  }

  /* The interactive graph: drawn into box, scrubbable and zoomable. The svg
     element stays put and only its inside is redrawn on a zoom, so a pinch
     or a drag in progress keeps its pointer. */
  function mount(box, pts, money, from, boxW) {
    const m = model(pts, from, boxW);
    const id = ++SEQ;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches;
    box.innerHTML = svgOpen(m, money) + '</svg>' +
      '<div class="chartZoom">' +
        '<span class="czr"></span>' +
        '<button type="button" class="czb" data-z="out" aria-label="Zoom out">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9"/></svg></button>' +
        '<button type="button" class="czb" data-z="in" aria-label="Zoom in">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9M8 3.5v9"/></svg></button>' +
        '<button type="button" class="czb czreset" data-z="reset" hidden>Reset</button>' +
      '</div>';
    const svg = box.querySelector('svg.v2chart');
    const zr = box.querySelector('.czr');
    const bIn = box.querySelector('[data-z="in"]'), bOut = box.querySelector('[data-z="out"]');
    const bReset = box.querySelector('[data-z="reset"]');
    let tip = box.querySelector('.chartTip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chartTip';
      box.appendChild(tip);
      if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    }

    const MINW = 1 / MAX_ZOOM;
    let view = [0, 1], meta = null, scrub = null, dot = null;
    const zoomed = () => view[1] - view[0] < 1 - 1e-9;

    function paint() {
      const r = draw(m, view, money, id);
      /* Nothing inside is a touch target: the svg itself is. A touch belongs to
         the node it started on, and a redraw mid-pinch removed that node, so
         the rest of the pinch (and its touchend) went nowhere. */
      svg.innerHTML = '<g pointer-events="none">' + r.html + '</g>';
      meta = r.meta;
      scrub = svg.querySelector('.scrub');
      dot = svg.querySelector('.scrubdot');
      const z = zoomed();
      bReset.hidden = !z;
      bIn.disabled = view[1] - view[0] <= MINW + 1e-9;
      bOut.disabled = !z;
      svg.classList.toggle('zoomed', z);
      /* Zoomed, the stretch on screen; not, how to zoom on this device. */
      zr.textContent = z ? rangeLabel(m.map.inv(view[0]), m.map.inv(view[1]))
                         : (coarse ? 'Pinch to zoom' : 'Scroll to zoom');
    }

    // Zoom by factor about a place on screen (frac of the plot's width, 0 to 1).
    function zoomAt(frac, factor) {
      const w = view[1] - view[0];
      const nw = Math.max(MINW, Math.min(1, w / factor));
      if (Math.abs(nw - w) < 1e-12) return false;
      const u = view[0] + w * frac;
      setView(u - nw * frac, nw);
      return true;
    }
    function setView(a, w) {
      a = Math.max(0, Math.min(1 - w, a));
      view = [a, a + w];
      hide();
      paint();
    }
    let raf = 0;
    const later = fn => { if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { raf = 0; fn(); }); };

    const svgX = (clientX) => {
      const r = svg.getBoundingClientRect();
      return (clientX - r.left) * (meta.W / r.width);
    };
    const fracOf = (clientX) => Math.max(0, Math.min(1, (svgX(clientX) - meta.PL) / meta.iw));

    function show(clientX) {
      const r = svg.getBoundingClientRect();
      // The SVG scales to its box, so client pixels convert through the viewBox.
      const x = Math.max(meta.PL, Math.min(meta.PR, svgX(clientX)));
      /* Straight to a DATE. Snapping to the nearest plotted point is what made
         this jump to the last time money came in and stay there. By INDEX,
         never by value: two entries can share a total. */
      const u = meta.a + (x - meta.PL) / meta.iw * (meta.b - meta.a);
      const t = m.map.inv(u);
      const i = levelAt(m, u);
      const v = m.values[i];
      scrub.setAttribute('x1', x.toFixed(1)); scrub.setAttribute('x2', x.toFixed(1));
      scrub.setAttribute('opacity', '.55');
      // On the step, so the dot and the figure can never disagree.
      dot.setAttribute('cx', x.toFixed(1)); dot.setAttribute('cy', meta.Y(v).toFixed(1));
      dot.setAttribute('opacity', '1');
      tip.innerHTML = '<b>' + money(v) + '</b><span>' + fmtDate(t, meta.span) + '</span>';
      tip.classList.add('on');
      // Keep the readout inside the box rather than letting it hang off an edge.
      const px = x / meta.W * r.width + (r.left - box.getBoundingClientRect().left);
      tip.style.left = Math.max(4, Math.min(box.clientWidth - tip.offsetWidth - 4,
        px - tip.offsetWidth / 2)) + 'px';
    }
    function hide() {
      if (scrub) scrub.setAttribute('opacity', '0');
      if (dot) dot.setAttribute('opacity', '0');
      tip.classList.remove('on');
    }

    /* Pointer events cover mouse, pen and touch in one path. touch-action
       pan-y keeps a one-finger vertical drag scrolling the page and hands a
       sideways one to the scrubber. Two fingers are a pinch, handled by the
       touch listeners below, which stop the page zooming instead. */
    svg.style.touchAction = 'pan-y';
    const downs = new Map();
    let dragging = false, pan = null, pinch = null;
    svg.addEventListener('pointerdown', e => {
      downs.set(e.pointerId, e.clientX);
      if (downs.size > 1 || pinch) { dragging = false; hide(); return; }
      try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      // A mouse drag on a zoomed graph moves it; hovering already reads it.
      if (e.pointerType === 'mouse' && zoomed()) {
        pan = { x: svgX(e.clientX), a: view[0] };
        svg.classList.add('panning');
        hide();
        return;
      }
      /* Tracked with a flag rather than inferred from e.pressure. Plenty of
         touch hardware reports pressure 0 for an ordinary finger, and buttons
         is 0 for touch as well. */
      dragging = true;
      show(e.clientX);
    });
    svg.addEventListener('pointermove', e => {
      if (downs.has(e.pointerId)) downs.set(e.pointerId, e.clientX);
      if (pinch || downs.size > 1) return;
      if (pan) {
        const w = view[1] - view[0];
        const dx = svgX(e.clientX) - pan.x;
        later(() => setView(pan ? pan.a - dx / meta.iw * w : view[0], w));
        return;
      }
      if (dragging || e.pointerType === 'mouse') show(e.clientX);
    });
    const up = e => {
      downs.delete(e.pointerId);
      dragging = false;
      if (pan) { pan = null; svg.classList.remove('panning'); }
      if (e.pointerType !== 'mouse' || e.type === 'pointercancel') hide();
    };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    // A mouse leaving clears it; a finger dragging past the edge does not, since
    // pointer capture means the drag is still going.
    svg.addEventListener('pointerleave', e => { if (!dragging && !pan) hide(e); });

    /* The pinch. Two fingers: their spread sets the zoom and their middle
       stays over the same moment, so the graph moves with the hand. */
    const mid = t => (t[0].clientX + t[1].clientX) / 2;
    const spread = t => Math.max(1, Math.abs(t[0].clientX - t[1].clientX));
    svg.addEventListener('touchstart', e => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      dragging = false; hide();
      const f = fracOf(mid(e.touches));
      pinch = { d: spread(e.touches), w: view[1] - view[0], u: view[0] + (view[1] - view[0]) * f };
    }, { passive: false });
    svg.addEventListener('touchmove', e => {
      if (!pinch || e.touches.length < 2) return;
      e.preventDefault();
      const nw = Math.max(MINW, Math.min(1, pinch.w * pinch.d / spread(e.touches)));
      const f = fracOf(mid(e.touches));
      later(() => { if (pinch) setView(pinch.u - nw * f, nw); });
    }, { passive: false });
    const endPinch = e => { if (pinch && e.touches.length < 2) { pinch = null; downs.clear(); } };
    svg.addEventListener('touchend', endPinch);
    svg.addEventListener('touchcancel', endPinch);

    /* The wheel zooms about the pointer, and a sideways scroll moves a zoomed
       graph. At either end of the zoom the wheel is left to scroll the page,
       so the graph never traps someone reading past it. */
    svg.addEventListener('wheel', e => {
      /* Someone scrolling the page whose pointer the graph has just slid
         under is still scrolling the page, not zooming. */
      if (performance.now() - lastScroll < 400) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        if (!zoomed()) return;
        e.preventDefault();
        const w = view[1] - view[0];
        setView(view[0] + e.deltaX / meta.iw * w, w);
        return;
      }
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      if (zoomAt(fracOf(e.clientX), Math.exp(-e.deltaY * unit * 0.0022))) e.preventDefault();
    }, { passive: false });

    bIn.addEventListener('click', () => zoomAt(0.5, 2));
    bOut.addEventListener('click', () => zoomAt(0.5, 0.5));
    bReset.addEventListener('click', () => { setView(0, 1); bIn.focus(); });

    paint();
  }

  /* The earnings graph, ONE implementation for the Wallet tab and a player's
     profile (Owen, 2026-10-15: the profile must be the exact graph the wallet
     shows). games is every cash-out [{ amount, at }] oldest first, joinedAt
     when the account was opened. */
  function earnings(box, games, joinedAt, money) {
    if (!box) return;
    money = money || (n => '$' + Number(n).toFixed(2));
    let run = 0;
    const pts = (games || []).map(g => ({ d: g.at, cum: (run += Number(g.amount) || 0) }));
    if (!pts.length) { box.innerHTML = ''; return; }
    /* Carried to today at the total it reached, so the line ends where you are
       standing rather than at the last time you happened to win. A long quiet
       run since is squeezed into a break like any other. */
    const lastAt = Date.parse(pts[pts.length - 1].d);
    if (!isNaN(lastAt) && Date.now() > lastAt + 60000)
      pts.push({ d: new Date().toISOString(), cum: run, end: true });
    /* The svg's own width: the box less its padding. */
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(box) : null;
    const inner = box.clientWidth - (cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0);
    mount(box, pts, money, joinedAt, inner);
  }

  window.V2Chart = V2Chart;
  window.V2EarningsChart = earnings;
  window.V2ChartTimeMap = timeMap;   // for the tests
})();
