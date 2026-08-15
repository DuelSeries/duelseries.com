'use strict';
/* ─── Running-total line chart ────────────────────────────────────────────────
   One series, so one hue and no legend: the heading names it. The line opens
   at zero before the first entry, because otherwise the first point reads as
   money that appeared from nowhere.

   Takes points already accumulated: [{ d, cum }] where d is a label and cum is
   the running total at that point. Returns SVG markup. Each point carries a
   native <title>, which gives a tooltip on hover and is read out by screen
   readers, without a hover layer to wire up or tear down. */
(function () {
  function V2Chart(pts, money) {
    if (!pts || !pts.length) return '';
    money = money || (n => '$' + Number(n).toFixed(2));

    const W = 980, H = 240, PL = 58, PR = 62, PT = 20, PB = 30;
    const iw = W - PL - PR, ih = H - PT - PB;
    const all = [{ d: '', cum: 0, seed: true }].concat(pts);
    const vals = all.map(p => p.cum);
    const hi = Math.max.apply(null, vals.concat([0]));
    const lo = Math.min.apply(null, vals.concat([0]));
    const pad = Math.max((hi - lo) * 0.14, 0.5);
    const top = hi + pad, bot = lo - pad;
    const X = i => PL + (all.length === 1 ? 0 : iw * i / (all.length - 1));
    const Y = v => PT + ih * (top - v) / (top - bot);
    const zy = Y(0);

    let ticks = '';
    for (let i = 0; i <= 4; i++) {
      const v = bot + (top - bot) * i / 4, y = Y(v).toFixed(1);
      ticks += '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + y + '" y2="' + y +
               '" stroke="var(--s2)" stroke-width="1"/>' +
               '<text x="' + (PL - 10) + '" y="' + (Y(v) + 4).toFixed(1) +
               '" text-anchor="end" font-size="11" fill="var(--tx3)" ' +
               /* Sign goes outside the currency symbol: -$5, never $-5. */
               'font-family="var(--fm)">' + (v < 0 ? '-' : '') +
               money(Math.abs(v)).replace(/\.\d\d$/, '') + '</text>';
    }

    const line = all.map((p, i) =>
      (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.cum).toFixed(1)).join(' ');
    const area = line + ' L' + X(all.length - 1).toFixed(1) + ' ' + zy.toFixed(1) +
                 ' L' + X(0).toFixed(1) + ' ' + zy.toFixed(1) + ' Z';

    let dots = '';
    for (let i = 1; i < all.length; i++) {
      const p = all[i], cx = X(i).toFixed(1), cy = Y(p.cum).toFixed(1);
      dots += '<circle cx="' + cx + '" cy="' + cy + '" r="3.2" fill="var(--money)"/>' +
              /* A wide transparent target, so the tooltip does not need a 3px hit. */
              '<circle cx="' + cx + '" cy="' + cy + '" r="14" fill="transparent">' +
              '<title>' + label(p.d) + ': ' + money(p.cum) + ' total</title></circle>';
    }

    const end = all[all.length - 1];
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Running total, ' +
      'ending at ' + money(end.cum) + '">' +
      '<defs><linearGradient id="v2ag" x1="0" x2="0" y1="0" y2="1">' +
      '<stop offset="0" stop-color="#f0a830" stop-opacity=".26"/>' +
      '<stop offset="1" stop-color="#f0a830" stop-opacity="0"/></linearGradient></defs>' +
      ticks +
      '<line x1="' + PL + '" x2="' + (W - PR) + '" y1="' + zy.toFixed(1) + '" y2="' +
        zy.toFixed(1) + '" stroke="var(--tx3)" stroke-width="1.5"/>' +
      '<path d="' + area + '" fill="url(#v2ag)"/>' +
      '<path d="' + line + '" fill="none" stroke="var(--money)" stroke-width="2" ' +
        'stroke-linejoin="round" stroke-linecap="round"/>' + dots +
      '<text x="' + (X(all.length - 1) + 10).toFixed(1) + '" y="' + (Y(end.cum) + 4).toFixed(1) +
        '" font-size="13" font-family="var(--fm)" font-weight="600" fill="var(--money)">' +
        money(end.cum) + '</text></svg>';
  }

  /* Periods arrive as ISO timestamps from DATE_TRUNC, which are unreadable in a
     tooltip. Anything else is passed through as written. */
  function label(d) {
    if (!d) return '';
    const t = Date.parse(d);
    if (isNaN(t)) return String(d).replace(/[<&>]/g, '');
    return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  window.V2Chart = V2Chart;
})();
