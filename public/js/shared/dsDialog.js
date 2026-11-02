/* DSDialog: the one popup card for the lobby and every game (Owen's pick "A Gold card", 2026-10-17, redrawn as the
   site kit's sheet in the 2026-11-02 redo). A centred black card: a turning ring while something is in flight, a red
   mark and a bone OK for an error, a bone button plus a quiet "no" for a question.

     DSDialog.busy({ title, line })               shows or updates the in-flight card
     DSDialog.alert({ title, line, ok })          resolves when OK is pressed
     DSDialog.confirm({ title, line, ok, cancel }) resolves true or false
     DSDialog.choose({ title, line, primary, secondary, divider, items, cancel, cancelId })
                                                  a pick (the sign-in sheets): resolves the id of the button or
                                                  row pressed, cancelId for the quiet button when given, or false
                                                  (Escape, or another card replacing it). primary (bone) and secondary (raised
                                                  kit button) are { id, label }; each item { id, label, sub, icon,
                                                  badge, tone } (icon an image URL, tone 'ok' greens the badge)
     DSDialog.close()

   Builds its own styles, so a game page needs only this script. The wallet widget bundles it too
   (wallet-widget/src/main.jsx); the guard below keeps one copy per page.

   The ring turns for everyone, reduced motion included: Owen's PC reports reduced motion, and a
   still ring reads as a frozen page. The !important pair is what beats the lobby's global
   reduced-motion rule (v2.html), which forces every animation down to one 0.01ms run. */
(function () {
  if (typeof window === 'undefined' || window.DSDialog) return;
  /* The kit's one sheet (site redo 2026-11-02, layout 1): a black panel on the kit's line with the pop shadow, the
     bone primary for the next step, the raised secondary for the other, a quiet "no", kit option rows. Gold is left
     for money, so the rim and the buttons are no longer gold. */
  var CSS =
    '.dsd{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;' +
      'background:rgba(0,0,0,.78);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);' +
      'font-family:Archivo,"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}' +
    '.dsd-card{width:min(380px,100%);box-sizing:border-box;background:#0d0b08;border:0;' +
      'border-radius:18px;padding:24px 24px 16px;text-align:center;color:#f4f1ea;' +
      'box-shadow:0 28px 70px rgba(0,0,0,.8),0 0 0 1px #36291a}' +
    '.dsd-card.busy{padding-bottom:24px}' +
    '.dsd-spin{width:30px;height:30px;margin:2px auto 14px;box-sizing:border-box;border-radius:50%;' +
      'border:3px solid #272018;border-top-color:#f4f1ea;border-right-color:#f4f1ea;' +
      'animation:dsd-spin .8s linear infinite!important;animation-duration:.8s!important;animation-iteration-count:infinite!important}' +
    '@keyframes dsd-spin{to{transform:rotate(360deg)}}' +
    '.dsd-ic{width:40px;height:40px;margin:0 auto 12px;border-radius:10px;display:grid;place-items:center;font-weight:800;font-size:18px;line-height:1}' +
    '.dsd-ic.bad{background:rgba(239,116,97,.15);color:#ef7461}' +
    '.dsd-ic.ask{background:rgba(244,241,234,.1);color:#f4f1ea}' +
    '.dsd-title{margin:0 0 4px;font-size:18px;font-weight:700;line-height:1.25}' +
    '.dsd-line{margin:0;font-size:14px;line-height:1.5;color:#b3a792;word-break:break-word}' +
    '.dsd-go{display:block;width:100%;height:52px;margin-top:20px;border:0;border-radius:10px;cursor:pointer;' +
      'font-weight:700;font-size:16px;line-height:52px;font-family:inherit;color:#000;background:#f4f1ea;' +
      'transition:background-color .14s,box-shadow .14s,transform .08s}' +
    '.dsd-go:hover{background:#fff;box-shadow:0 0 0 4px rgba(244,241,234,.14)}' +
    '.dsd-go:active,.dsd-alt:active{transform:translateY(1px) scale(.985)}' +
    '.dsd-no{display:block;margin:6px auto 0;min-height:44px;padding:0 16px;border:0;border-radius:10px;background:none;cursor:pointer;' +
      'font-weight:650;font-size:15px;font-family:inherit;color:#b3a792}' +
    '.dsd-no:hover{color:#f4f1ea;background:#1a1611}' +
    '.dsd-go:focus-visible,.dsd-no:focus-visible{outline:2px solid #f4f1ea;outline-offset:2px}' +
    /* the pick list (choose): rows a thumb can hit, the list scrolls inside a short phone, the card never does */
    '.dsd-card.pick{width:min(400px,100%);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);display:flex;flex-direction:column;padding:22px 20px 12px}' +
    '.dsd-card.pick .dsd-go{margin-top:16px;flex:none}' +
    '.dsd-alt{display:block;width:100%;height:52px;margin-top:8px;flex:none;border:0;border-radius:10px;' +
      'cursor:pointer;background:#272018;color:#f4f1ea;font-weight:650;font-size:16px;font-family:inherit;box-shadow:inset 0 0 0 1px #36291a;' +
      'transition:background-color .14s,box-shadow .14s,transform .08s}' +
    '.dsd-alt:hover{background:#332a1f;box-shadow:inset 0 0 0 1px #5a4630}' +
    '.dsd-alt:focus-visible{outline:2px solid #f4f1ea;outline-offset:2px}' +
    '.dsd-card.pick .dsd-list{margin-top:14px}' +
    '.dsd-or{display:flex;align-items:center;gap:10px;margin:16px 2px 8px;font-size:13px;font-weight:600;color:#b3a792;flex:none}' +
    '.dsd-or:before,.dsd-or:after{content:"";flex:1;height:1px;background:#36291a}' +
    '.dsd-list{display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:0;margin:0 -4px;padding:2px 4px}' +
    '.dsd-row{display:flex;align-items:center;gap:12px;width:100%;min-height:60px;box-sizing:border-box;padding:10px 12px;' +
      'border:0;border-radius:10px;background:#1a1611;color:#f4f1ea;cursor:pointer;box-shadow:inset 0 0 0 1px #36291a;' +
      'font-family:inherit;text-align:left;transition:background-color .14s,box-shadow .14s}' +
    '.dsd-row:hover{background:#272018;box-shadow:inset 0 0 0 1px #5a4630}' +
    '.dsd-row:focus-visible{outline:2px solid #f4f1ea;outline-offset:2px}' +
    '.dsd-row img,.dsd-row .dsd-mono{width:40px;height:40px;border-radius:10px;flex:none;object-fit:cover}' +
    '.dsd-row .dsd-mono{display:grid;place-items:center;background:#000;color:#f4f1ea;font-weight:800;font-size:16px}' +
    '.dsd-name{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}' +
    '.dsd-name b{font-size:15px;font-weight:650;line-height:1.25}' +
    '.dsd-name small{font-size:13px;color:#b3a792;line-height:1.35}' +
    '.dsd-badge{flex:none;display:inline-flex;align-items:center;height:24px;font-size:12px;font-weight:650;color:#b3a792;padding:0 8px;border-radius:6px;background:#272018}' +
    '.dsd-badge.ok{color:#8ed081;background:rgba(142,208,129,.14)}';

  var root = null, settle = null;

  function style() {
    if (document.getElementById('dsd-css')) return;
    var s = document.createElement('style');
    s.id = 'dsd-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Replaces whatever card is up; a pending alert or confirm resolves as dismissed.
  function show(kind, o) {
    style();
    o = o || {};
    if (settle) { var s = settle; settle = null; s(kind === 'busy' ? undefined : false); }
    if (!root) {
      root = el('div', 'dsd');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      (document.body || document.documentElement).appendChild(root);
    }
    root.textContent = '';
    var card = el('div', 'dsd-card' + (kind === 'busy' ? ' busy' : ''));
    if (kind === 'busy') { card.appendChild(el('div', 'dsd-spin')); root.setAttribute('aria-busy', 'true'); }
    else { card.appendChild(el('div', 'dsd-ic ' + (kind === 'confirm' ? 'ask' : 'bad'), kind === 'confirm' ? '?' : '!')); root.removeAttribute('aria-busy'); }
    if (o.title) card.appendChild(el('h3', 'dsd-title', o.title));
    if (o.line) card.appendChild(el('p', 'dsd-line', o.line));
    root.appendChild(card);
    if (kind === 'busy') return Promise.resolve();
    return new Promise(function (resolve) {
      settle = resolve;
      var go = el('button', 'dsd-go', o.ok || 'OK');
      go.type = 'button';
      go.onclick = function () { done(true); };
      card.appendChild(go);
      if (kind === 'confirm') {
        var no = el('button', 'dsd-no', o.cancel || 'Cancel');
        no.type = 'button';
        no.onclick = function () { done(false); };
        card.appendChild(no);
      }
      try { go.focus({ preventScroll: true }); } catch (_) {}
    });
  }

  /* The pick list. Its own card, not show(): no mark at the top, the rows are the content. A press
     resolves that row's id; Escape and the quiet button resolve false. */
  function choose(o) {
    style();
    o = o || {};
    if (settle) { var s0 = settle; settle = null; s0(false); }
    if (!root) {
      root = el('div', 'dsd');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      (document.body || document.documentElement).appendChild(root);
    }
    root.textContent = '';
    root.removeAttribute('aria-busy');
    var card = el('div', 'dsd-card pick');
    if (o.title) card.appendChild(el('h3', 'dsd-title', o.title));
    if (o.line) card.appendChild(el('p', 'dsd-line', o.line));
    root.appendChild(card);
    return new Promise(function (resolve) {
      settle = resolve;
      var first = null;
      if (o.primary && o.primary.id) {
        var go = el('button', 'dsd-go', o.primary.label || 'Continue');
        go.type = 'button';
        go.setAttribute('data-id', o.primary.id);
        go.onclick = function () { done(o.primary.id); };
        card.appendChild(go);
        first = go;
      }
      if (o.secondary && o.secondary.id) {
        var alt = el('button', 'dsd-alt', o.secondary.label || 'More');
        alt.type = 'button';
        alt.setAttribute('data-id', o.secondary.id);
        alt.onclick = function () { done(o.secondary.id); };
        card.appendChild(alt);
        if (!first) first = alt;
      }
      var items = Array.isArray(o.items) ? o.items : [];
      if (items.length) {
        if (o.divider) card.appendChild(el('div', 'dsd-or', o.divider));
        var list = el('div', 'dsd-list');
        items.forEach(function (it) {
          if (!it || !it.id) return;
          var row = el('button', 'dsd-row');
          row.type = 'button';
          row.setAttribute('data-id', it.id);
          if (it.icon) {
            var img = el('img');
            img.src = it.icon;
            img.alt = '';
            img.width = 32; img.height = 32;
            row.appendChild(img);
          } else {
            row.appendChild(el('span', 'dsd-mono', String(it.label || '?').charAt(0)));
          }
          var name = el('span', 'dsd-name');
          name.appendChild(el('b', null, it.label || ''));
          if (it.sub) name.appendChild(el('small', null, it.sub));
          row.appendChild(name);
          if (it.badge) row.appendChild(el('span', 'dsd-badge' + (it.tone === 'ok' ? ' ok' : ''), it.badge));
          row.onclick = function () { done(it.id); };
          list.appendChild(row);
          if (!first) first = row;
        });
        card.appendChild(list);
      }
      var no = el('button', 'dsd-no', o.cancel || 'Not now');
      no.type = 'button';
      no.onclick = function () { done(o.cancelId || false); };
      card.appendChild(no);
      try { (first || no).focus({ preventScroll: true }); } catch (_) {}
    });
  }

  function done(v) {
    var s = settle;
    settle = null;
    close();
    if (s) s(v);
  }

  function close() {
    if (settle) { var s = settle; settle = null; s(false); }
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
  }

  document.addEventListener('keydown', function (e) {
    if (!settle || !root) return;
    if (e.key === 'Escape') { e.preventDefault(); done(false); }
  });

  window.DSDialog = {
    busy: function (o) { return show('busy', o); },
    alert: function (o) { return show('alert', typeof o === 'string' ? { line: o } : o); },
    confirm: function (o) { return show('confirm', typeof o === 'string' ? { line: o } : o); },
    choose: choose,
    close: close,
    isOpen: function () { return !!root; },
  };
})();
