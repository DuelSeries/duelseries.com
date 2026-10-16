// DuelSeries shared end screens: ONE result card (death, cash-out, win) and ONE in-game leaderboard for every game
// (Owen 2026-10-16: "one cashout screen, one death screen and one leaderboard ... for all the games"). His look C,
// "Ticket": a cream slip with a torn line between the result and the money; the board is fully clear, text only.
//
// Each game keeps its own logic and money flow and only maps its data in (a small adapter in the game's own files):
//   DSEnd.show(card)  -> the card on screen (replaces the one showing). card:
//     tone     'plain' | 'win' | 'loss'          colours the big figure
//     verdict  'Killed by Kestrel'                the line above the big figure
//     hero     '$2.16' | '1,284' | '1st'          the big figure; unit: the words after it ('to your wallet')
//     podium   [{ rank, name, me }]               battle royale top 3
//     facts    [[label, value]]                   up to three (Owen: time, rank, score)
//     ledger   [[label, value]]                   money rows; with two or more, the last is the net row
//     status   { text, state: 'pending'|'ok'|'err', link: { href, text } }
//     notes    ['...']                            small lines under the money (refusals, hints)
//     buttons  [{ id, text, primary, disabled, onClick }]
//     z, zoom, root                               stacking order, a page-zoom fix (/sl's 0.7 viewport), parent node
//   -> { update(partial), hide(), el, button(id), opacity(x) }
//   DSEnd.hide(), DSEnd.shown()
//   DSEnd.board(opts) -> { set(rows, me), show(), hide(), destroy(), el }
//     opts: { money, light, title, z, zoom, top, right, rowsPhone (5), rowsPC (10), root }
//     light: a game drawn on a light map (agar.io): ink text with a light halo instead of cream with a shadow
//     rows: [{ name, value, me }] in rank order; me: { rank, name, value } (pinned under the list when outside it)
//
// Display only. Every amount is a string the game formatted from the SERVER's own numbers (DSEnd.usd for micro-USDC);
// nothing here is ever read back for money. Player names go in as text, never markup.
(function (root) {
  'use strict';
  if (!root || !root.document) return;
  var doc = root.document;
  if (root.DSEnd && root.DSEnd.version) return;

  var FONT_HREF = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400..700&family=IBM+Plex+Mono:wght@500;600&display=swap';
  var PHONE_MAX = 760;

  var CSS = [
    // the card
    '.dse{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;' +
      'font-family:Archivo,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#100e0b;' +
      '-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent;text-align:left;line-height:1.35}',
    '.dse *{box-sizing:border-box}',
    '.dse-scrim{position:absolute;inset:0;background:rgba(16,14,11,.55)}',
    '.dse-card{position:relative;width:342px;max-width:100%;filter:drop-shadow(0 18px 40px rgba(0,0,0,.45))}',
    '@media (min-width:' + (PHONE_MAX + 1) + 'px){.dse-card{width:400px}}',
    '.dse-top{background:#f4f1ea;border-radius:18px 18px 0 0;padding:22px 22px 18px;' +
      '-webkit-mask:radial-gradient(circle 12px at 0 100%,#0000 11.5px,#000 12px) left/51% 100% no-repeat,' +
        'radial-gradient(circle 12px at 100% 100%,#0000 11.5px,#000 12px) right/51% 100% no-repeat;' +
      'mask:radial-gradient(circle 12px at 0 100%,#0000 11.5px,#000 12px) left/51% 100% no-repeat,' +
        'radial-gradient(circle 12px at 100% 100%,#0000 11.5px,#000 12px) right/51% 100% no-repeat}',
    '.dse-stub{position:relative;background:#e9e3d6;border-radius:0 0 18px 18px;padding:18px 22px 22px;' +
      '-webkit-mask:radial-gradient(circle 12px at 0 0,#0000 11.5px,#000 12px) left/51% 100% no-repeat,' +
        'radial-gradient(circle 12px at 100% 0,#0000 11.5px,#000 12px) right/51% 100% no-repeat;' +
      'mask:radial-gradient(circle 12px at 0 0,#0000 11.5px,#000 12px) left/51% 100% no-repeat,' +
        'radial-gradient(circle 12px at 100% 0,#0000 11.5px,#000 12px) right/51% 100% no-repeat}',
    '.dse-stub:before{content:"";position:absolute;left:18px;right:18px;top:0;border-top:2px dashed rgba(16,14,11,.2)}',
    '.dse p,.dse ol,.dse dl,.dse dd{margin:0;padding:0;list-style:none}',
    '.dse-v{font-size:15px;font-weight:650;color:#5d5346;overflow-wrap:anywhere}',
    '.dse-hero{display:flex;align-items:baseline;flex-wrap:wrap;column-gap:10px;margin:2px 0 0}',
    '.dse-big{font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;font-weight:600;font-size:56px;line-height:1.05;' +
      'letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:#100e0b}',
    '.dse-unit{font-size:15px;color:#6b6152}',
    '.dse.t-win .dse-big{color:#8a5600}',
    '.dse.t-loss .dse-big{color:#a8392a}',
    '.dse-pod{margin:14px 0 0}',
    '.dse-pod li{display:flex;gap:12px;padding:6px 0;font-size:16px;border-bottom:1px solid rgba(16,14,11,.1);overflow-wrap:anywhere}',
    '.dse-pod li i{font-style:normal;font-family:"IBM Plex Mono",ui-monospace,monospace;color:#6b6152;width:14px;flex:0 0 auto}',
    '.dse-pod li.me{font-weight:700;color:#8a5600}',
    '.dse-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:16px 0 0}',
    '.dse-facts dt{font-size:12px;color:#6b6152}',
    '.dse-facts dd{font:600 18px "IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums;color:#100e0b;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dse-lr{display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:15px;color:#4c4438}',
    '.dse-lr b{font:600 15px "IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums;color:#100e0b}',
    '.dse-lr.net{margin-top:4px;padding-top:9px;border-top:1px solid rgba(16,14,11,.15);font-weight:700;color:#100e0b}',
    '.dse-lr.net b{font-size:17px;color:#8a5600}',
    '.dse-st{font-size:14px;color:#5d5346;margin:10px 0 0}',
    '.dse-st i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#8a5600;margin-right:8px;vertical-align:1px}',
    '.dse-st.ok i{background:#3b6d11}',
    '.dse-st.err i{background:#a8392a}',
    '.dse-st a{color:#100e0b;font-weight:650;margin-left:6px}',
    '.dse-note{font-size:13.5px;color:#4c4438;margin:10px 0 0;overflow-wrap:anywhere}',
    '.dse-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px}',
    '.dse-stub>.dse-btns:first-child{margin-top:4px}',
    '.dse-btn{height:46px;border:0;border-radius:12px;font:650 15px Archivo,ui-sans-serif,system-ui,sans-serif;cursor:pointer;' +
      'background:transparent;color:#100e0b;box-shadow:inset 0 0 0 1.5px rgba(16,14,11,.28);touch-action:manipulation;' +
      '-webkit-user-select:none;user-select:none;padding:0 12px}',
    '.dse-btn:hover{background:rgba(16,14,11,.06)}',
    '.dse-btn.pri{grid-column:1/-1;height:52px;background:#100e0b;color:#f4f1ea;box-shadow:none;font-size:16px}',
    '.dse-btn.pri:hover{background:#2b261f}',
    '.dse-btn.solo{grid-column:1/-1}',
    '.dse-btn:disabled{opacity:.5;cursor:default}',
    '.dse-btn:focus-visible{outline:2px solid #8a5600;outline-offset:2px}',
    '@media (prefers-reduced-motion:no-preference){.dse-card.in{animation:dse-in .22s cubic-bezier(.2,.8,.2,1)}' +
      '@keyframes dse-in{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}}',
    // the board: fully clear (Owen 2026-10-16), text with a shadow, your row on a cream pill. Compact on a phone
    // (Owen: it never takes a big part of the screen): 11.5 px rows 16 px apart, names cut at about 10 characters.
    '.dsb{position:fixed;top:8px;right:8px;width:128px;pointer-events:none;color:#f5f1e8;font:600 11.5px Archivo,ui-sans-serif,system-ui,sans-serif;' +
      'text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 2px #000;-webkit-text-size-adjust:100%;line-height:1.3;text-align:left}',
    '.dsb p,.dsb ol{margin:0;padding:0;list-style:none}',
    '.dsb-t{font-size:10.5px;color:rgba(245,241,232,.75);margin:0 0 1px 1px}',
    '.dsb li{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:4px;align-items:baseline;line-height:16px;padding:0 4px;margin:0 -3px}',
    '.dsb li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:10ch}',
    '.dsb li i{font-style:normal;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:10.5px;color:rgba(245,241,232,.7)}',
    '.dsb li b{font:600 11px "IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}',
    '.dsb.money li b{color:#f0a830}',
    '.dsb li.me{background:#f4f1ea;color:#100e0b;border-radius:5px;text-shadow:none;font-weight:700}',
    '.dsb li.me i,.dsb li.me b{color:#100e0b}',
    '.dsb.money li.me b{color:#8a5600}',
    '.dsb li.gap{line-height:8px}',
    // a light map: ink text, a white halo, your row an ink pill
    '.dsb.light{color:#100e0b;text-shadow:0 0 2px #fff,0 0 3px #fff,0 1px 1px rgba(255,255,255,.9)}',
    '.dsb.light .dsb-t,.dsb.light li i{color:rgba(16,14,11,.7)}',
    '.dsb.light.money li b{color:#8a5600}',
    '.dsb.light li.me{background:#100e0b;color:#f4f1ea}',
    '.dsb.light li.me i,.dsb.light li.me b,.dsb.light.money li.me b{color:#f4f1ea}',
    // a computer: a little more room, still small
    '@media (min-width:' + (PHONE_MAX + 1) + 'px){.dsb{width:196px;font-size:13.5px;top:14px;right:14px}' +
      '.dsb-t{font-size:12px;margin-bottom:3px}' +
      '.dsb li{grid-template-columns:20px minmax(0,1fr) auto;gap:6px;line-height:21px;padding:0 6px;margin:0 -4px}' +
      '.dsb li span{max-width:14ch}.dsb li i{font-size:11.5px}.dsb li b{font-size:12.5px}' +
      '.dsb li.me{border-radius:6px}.dsb li.gap{line-height:10px}}'
  ].join('\n');

  var styled = false;
  function style() {
    if (styled) return;
    styled = true;
    var head = doc.head || doc.body;
    if (!doc.querySelector || !doc.querySelector('link[data-dse-font]')) {
      var l = doc.createElement('link');
      l.rel = 'stylesheet';
      l.href = FONT_HREF;
      l.setAttribute('data-dse-font', '1');
      head.appendChild(l);
    }
    var s = doc.createElement('style');
    s.setAttribute('data-dse', '1');
    s.textContent = CSS;
    head.appendChild(s);
  }

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  // [label, value] or { k, v }
  function pair(x) {
    if (x && typeof x === 'object' && !Array.isArray(x)) return [x.k != null ? x.k : x.label, x.v != null ? x.v : x.value];
    return Array.isArray(x) ? x : [String(x), ''];
  }
  // Clicks and touches on our nodes never reach the game under them (steering, boost, split).
  function guard(node) {
    ['pointerdown', 'mousedown', 'touchstart', 'touchmove', 'wheel', 'contextmenu'].forEach(function (t) {
      node.addEventListener(t, function (e) { e.stopPropagation(); }, { passive: true });
    });
  }

  // ---- the card
  var card = null;        // { el, opts, btns }

  function render(o) {
    var wrap = card.el;
    wrap.className = 'dse t-' + (o.tone === 'win' || o.tone === 'loss' ? o.tone : 'plain');
    wrap.style.zIndex = String(o.z != null ? o.z : 1000);
    if (o.zoom && o.zoom !== 1) wrap.style.zoom = String(o.zoom); else wrap.style.zoom = '';
    var had = doc.activeElement && doc.activeElement.getAttribute && doc.activeElement.getAttribute('data-dse-btn');
    while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
    wrap.appendChild(el('div', 'dse-scrim'));
    var box = el('div', 'dse-card' + (card.fresh ? ' in' : ''));   // slides in once, not on every update
    var top = el('div', 'dse-top');
    var stub = el('div', 'dse-stub');
    if (o.verdict) top.appendChild(el('p', 'dse-v', o.verdict));
    if (o.hero != null && o.hero !== '') {
      var hero = el('p', 'dse-hero');
      hero.appendChild(el('span', 'dse-big', o.hero));
      if (o.unit) hero.appendChild(el('span', 'dse-unit', o.unit));
      top.appendChild(hero);
    }
    if (o.podium && o.podium.length) {
      var pod = el('ol', 'dse-pod');
      o.podium.forEach(function (p) {
        var li = el('li', p.me ? 'me' : '');
        li.appendChild(el('i', null, p.rank));
        li.appendChild(el('span', null, p.name));
        pod.appendChild(li);
      });
      top.appendChild(pod);
    }
    if (o.facts && o.facts.length) {
      var dl = el('dl', 'dse-facts');
      o.facts.slice(0, 3).forEach(function (f) {
        f = pair(f);
        var d = el('div');
        d.appendChild(el('dt', null, f[0]));
        d.appendChild(el('dd', null, f[1]));
        dl.appendChild(d);
      });
      top.appendChild(dl);
    }
    if (o.ledger && o.ledger.length) {
      var led = el('div', 'dse-led');
      o.ledger.forEach(function (r, i) {
        r = pair(r);
        var row = el('div', 'dse-lr' + (o.ledger.length > 1 && i === o.ledger.length - 1 ? ' net' : ''));
        row.appendChild(el('span', null, r[0]));
        row.appendChild(el('b', null, r[1]));
        led.appendChild(row);
      });
      stub.appendChild(led);
    }
    if (o.status && o.status.text) {
      var st = el('p', 'dse-st' + (o.status.state === 'ok' ? ' ok' : o.status.state === 'err' ? ' err' : ''));
      st.appendChild(el('i'));
      st.appendChild(doc.createTextNode(String(o.status.text)));
      if (o.status.link && /^https:\/\//.test(String(o.status.link.href || ''))) {
        var a = el('a', null, o.status.link.text || 'View');
        a.href = o.status.link.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        st.appendChild(a);
      }
      stub.appendChild(st);
    }
    (o.notes || []).forEach(function (n) { if (n) stub.appendChild(el('p', 'dse-note', n)); });
    card.btns = {};
    var list = (o.buttons || []).filter(function (b) { return b && b.text; });
    if (list.length) {
      var btns = el('div', 'dse-btns');
      var secs = list.filter(function (b) { return !b.primary; }).length;
      list.forEach(function (b) {
        var btn = el('button', 'dse-btn' + (b.primary ? ' pri' : (secs === 1 ? ' solo' : '')), b.text);
        btn.type = 'button';
        if (b.id) btn.setAttribute('data-dse-btn', b.id);
        btn.disabled = !!b.disabled;
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (btn.disabled || typeof b.onClick !== 'function') return;
          b.onClick(e);
        });
        btns.appendChild(btn);
        if (b.id) card.btns[b.id] = btn;
      });
      stub.appendChild(btns);
    }
    box.appendChild(top);
    if (stub.firstChild) box.appendChild(stub);
    else top.style.borderRadius = '18px';
    wrap.appendChild(box);
    if (had && card.btns[had] && card.btns[had].focus) card.btns[had].focus();
  }

  function lastKid(n) { return n.lastChild || (n.children && n.children[n.children.length - 1]) || null; }
  // A card taller than the window (a phone on its side) is scaled down to fit, never cut off.
  function fit(box) {
    if (!box || !box.style) return;
    box.style.zoom = '';
    if (typeof box.getBoundingClientRect !== 'function') return;
    var h = box.getBoundingClientRect().height;
    var avail = (root.innerHeight || 0) - 24;
    if (h > 0 && avail > 0 && h > avail) box.style.zoom = String(Math.max(0.5, avail / h));
  }

  function show(o) {
    style();
    o = o || {};
    if (!card) {
      var wrap = el('div', 'dse');
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-live', 'polite');
      guard(wrap);
      card = { el: wrap, opts: {}, btns: {} };
    }
    card.opts = o;
    card.fresh = !shown();
    render(o);
    var parent = o.root || doc.body;
    if (card.el.parentNode !== parent) parent.appendChild(card.el);
    card.el.style.display = '';
    card.el.style.opacity = '';
    fit(lastKid(card.el));
    return handle;
  }
  var handle = {
    update: function (partial) {
      if (!card) return handle;
      var o = {}, k;
      for (k in card.opts) if (Object.prototype.hasOwnProperty.call(card.opts, k)) o[k] = card.opts[k];
      for (k in partial) if (Object.prototype.hasOwnProperty.call(partial, k)) o[k] = partial[k];
      card.opts = o;
      card.fresh = false;
      render(o);
      fit(lastKid(card.el));
      return handle;
    },
    hide: function () { hide(); },
    button: function (id) { return card && card.btns[id] || null; },
    opacity: function (x) { if (card) card.el.style.opacity = String(Math.max(0, Math.min(1, x))); },
    get el() { return card && card.el; }
  };
  function hide() {
    if (card && card.el.parentNode) card.el.parentNode.removeChild(card.el);
  }
  function shown() { return !!(card && card.el.parentNode); }

  // ---- the board
  function phone() {
    try { return root.matchMedia ? root.matchMedia('(max-width:' + PHONE_MAX + 'px)').matches : (root.innerWidth || 1000) <= PHONE_MAX; }
    catch (_) { return false; }
  }
  function board(opts) {
    style();
    opts = opts || {};
    var node = el('div', 'dsb' + (opts.money ? ' money' : '') + (opts.light ? ' light' : ''));
    node.setAttribute('aria-label', opts.title || 'Leaderboard');
    node.style.zIndex = String(opts.z != null ? opts.z : 900);
    if (opts.zoom && opts.zoom !== 1) node.style.zoom = String(opts.zoom);
    if (opts.top != null) node.style.top = opts.top + 'px';
    if (opts.right != null) node.style.right = opts.right + 'px';
    node.appendChild(el('p', 'dsb-t', opts.title || 'Leaderboard'));
    var ol = el('ol');
    node.appendChild(ol);
    (opts.root || doc.body).appendChild(node);
    var last = '';
    var b = {
      el: node,
      set: function (rows, me) {
        rows = Array.isArray(rows) ? rows : [];
        var n = phone() ? (opts.rowsPhone || 5) : (opts.rowsPC || 10);
        var shownRows = rows.slice(0, n);
        var mine = shownRows.some(function (r) { return r && r.me; });
        var out = shownRows.map(function (r, i) {
          return [r.rank != null ? r.rank : i + 1, r.name == null ? '' : String(r.name), r.value == null ? '' : String(r.value), !!r.me];
        });
        if (!mine && me && me.rank > 0) {
          out.push(null);
          out.push([me.rank, me.name == null ? '' : String(me.name), me.value == null ? '' : String(me.value), true]);
        }
        var key = JSON.stringify(out) + n;
        if (key === last) return;
        last = key;
        while (ol.firstChild) ol.removeChild(ol.firstChild);
        out.forEach(function (r) {
          var li;
          if (!r) {
            li = el('li', 'gap');
            li.appendChild(el('i'));
            li.appendChild(el('span', null, '…'));
            li.appendChild(el('b'));
          } else {
            li = el('li', r[3] ? 'me' : '');
            li.appendChild(el('i', null, r[0]));
            li.appendChild(el('span', null, r[1]));
            li.appendChild(el('b', null, r[2]));
          }
          ol.appendChild(li);
        });
      },
      show: function () { node.style.display = ''; },
      hide: function () { node.style.display = 'none'; },
      destroy: function () { if (node.parentNode) node.parentNode.removeChild(node); }
    };
    return b;
  }

  // ---- formatting (the games' own numbers in, text out)
  function usd(micro, sign) {
    var n = Math.round(Number(micro) || 0);
    var neg = n < 0 || sign === '-';
    var a = Math.abs(n) / 1e6;
    return (neg && a > 0 ? '−' : '') + '$' + a.toFixed(2);
  }
  function clock(ms) {
    var s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }
  function int(n) {
    var v = Math.round(Number(n) || 0);
    return String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',').replace(/^/, v < 0 ? '−' : '');
  }
  function ordinal(n) {
    var v = Math.round(Number(n) || 0);
    var t = v % 100, o = v % 10;
    return v + (t >= 11 && t <= 13 ? 'th' : o === 1 ? 'st' : o === 2 ? 'nd' : o === 3 ? 'rd' : 'th');
  }

  root.DSEnd = { version: 1, show: show, hide: hide, shown: shown, board: board,
    usd: usd, clock: clock, int: int, ordinal: ordinal, isPhone: phone };
})(typeof window !== 'undefined' ? window : null);
