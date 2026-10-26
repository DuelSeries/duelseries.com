/* DSDialog: the one popup card for the lobby and every game (Owen's pick "A Gold card", 2026-10-17).
   A centred dark card with a gold rim: a turning ring while something is in flight, a red mark and
   a gold OK for an error, a gold button plus a quiet "no" for a question.

     DSDialog.busy({ title, line })               shows or updates the in-flight card
     DSDialog.alert({ title, line, ok })          resolves when OK is pressed
     DSDialog.confirm({ title, line, ok, cancel }) resolves true or false
     DSDialog.choose({ title, line, primary, secondary, divider, items, cancel, cancelId })
                                                  a pick (the sign-in sheets): resolves the id of the button or
                                                  row pressed, cancelId for the quiet button when given, or false
                                                  (Escape, or another card replacing it). primary (gold) and secondary (gold
                                                  outline) are { id, label }; each item { id, label, sub, icon,
                                                  badge, tone } (icon an image URL, tone 'ok' greens the badge)
     DSDialog.close()

   Builds its own styles, so a game page needs only this script. The wallet widget bundles it too
   (wallet-widget/src/main.jsx); the guard below keeps one copy per page.

   The ring turns for everyone, reduced motion included: Owen's PC reports reduced motion, and a
   still ring reads as a frozen page. The !important pair is what beats the lobby's global
   reduced-motion rule (v2.html), which forces every animation down to one 0.01ms run. */
(function () {
  if (typeof window === 'undefined' || window.DSDialog) return;
  var CSS =
    '.dsd{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;' +
      'background:rgba(8,7,5,.74);font-family:Archivo,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}' +
    '.dsd-card{width:min(340px,100%);box-sizing:border-box;background:#17140f;border:1.5px solid rgba(240,168,48,.55);' +
      'border-radius:22px;padding:22px 22px 16px;text-align:center;color:#f5f1e8;' +
      'box-shadow:0 0 40px -8px rgba(240,168,48,.2),0 24px 60px rgba(0,0,0,.6)}' +
    '.dsd-card.busy{padding-bottom:22px}' +
    '.dsd-spin{width:30px;height:30px;margin:2px auto 12px;box-sizing:border-box;border-radius:50%;' +
      'border:3px solid rgba(245,241,232,.14);border-top-color:#f0a830;' +
      'animation:dsd-spin .8s linear infinite!important;animation-duration:.8s!important;animation-iteration-count:infinite!important}' +
    '@keyframes dsd-spin{to{transform:rotate(360deg)}}' +
    '.dsd-ic{width:36px;height:36px;margin:0 auto 10px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:18px;line-height:1}' +
    '.dsd-ic.bad{background:rgba(224,112,95,.14);color:#e0705f;box-shadow:inset 0 0 0 1.5px rgba(224,112,95,.5)}' +
    '.dsd-ic.ask{background:rgba(240,168,48,.12);color:#f0a830;box-shadow:inset 0 0 0 1.5px rgba(240,168,48,.5)}' +
    '.dsd-title{margin:0 0 3px;font-size:18px;font-weight:700;line-height:1.25;letter-spacing:-.01em}' +
    '.dsd-line{margin:0;font-size:13.5px;line-height:1.45;color:#a89c8a;word-break:break-word}' +
    '.dsd-go{display:block;width:100%;height:44px;margin-top:16px;border:0;border-radius:999px;cursor:pointer;' +
      'font-weight:700;font-size:16px;line-height:44px;font-family:inherit;color:#100e0b;background:linear-gradient(to bottom,#f7c766,#f0a830 52%,#c98a22)}' +
    '.dsd-go:hover{filter:brightness(1.08)}' +
    '.dsd-no{display:block;margin:6px auto 0;padding:8px 14px;border:0;background:none;cursor:pointer;' +
      'font-weight:600;font-size:14px;font-family:inherit;color:#a89c8a}' +
    '.dsd-no:hover{color:#f5f1e8}' +
    '.dsd-go:focus-visible,.dsd-no:focus-visible{outline:2px solid #f4f1ea;outline-offset:3px}' +
    /* the pick list (choose): rows a thumb can hit, the list scrolls inside a short phone, the card never does */
    '.dsd-card.pick{width:min(360px,100%);max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);display:flex;flex-direction:column;padding:20px 18px 12px}' +
    '.dsd-card.pick .dsd-go{margin-top:14px;flex:none}' +
    '.dsd-alt{display:block;width:100%;height:44px;margin-top:10px;flex:none;border:1.5px solid rgba(240,168,48,.55);border-radius:999px;' +
      'cursor:pointer;background:transparent;color:#f0a830;font-weight:700;font-size:16px;font-family:inherit}' +
    '.dsd-alt:hover{background:rgba(240,168,48,.08)}' +
    '.dsd-alt:focus-visible{outline:2px solid #f4f1ea;outline-offset:3px}' +
    '.dsd-card.pick .dsd-list{margin-top:14px}' +
    '.dsd-or{display:flex;align-items:center;gap:10px;margin:16px 2px 8px;font-size:12.5px;color:#a89c8a;flex:none}' +
    '.dsd-or:before,.dsd-or:after{content:"";flex:1;height:1px;background:rgba(245,241,232,.1)}' +
    '.dsd-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;min-height:0;margin:0 -4px;padding:2px 4px}' +
    '.dsd-row{display:flex;align-items:center;gap:12px;width:100%;min-height:52px;box-sizing:border-box;padding:9px 12px;' +
      'border:1px solid rgba(245,241,232,.08);border-radius:14px;background:#1f1b15;color:#f5f1e8;cursor:pointer;' +
      'font-family:inherit;text-align:left}' +
    '.dsd-row:hover{border-color:rgba(240,168,48,.55);background:#241f17}' +
    '.dsd-row:focus-visible{outline:2px solid #f4f1ea;outline-offset:2px}' +
    '.dsd-row img,.dsd-row .dsd-mono{width:32px;height:32px;border-radius:9px;flex:none;object-fit:cover}' +
    '.dsd-row .dsd-mono{display:grid;place-items:center;background:#2c261d;color:#f0a830;font-weight:700;font-size:15px}' +
    '.dsd-name{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}' +
    '.dsd-name b{font-size:15px;font-weight:600;line-height:1.2}' +
    '.dsd-name small{font-size:12px;color:#a89c8a;line-height:1.3}' +
    '.dsd-badge{flex:none;font-size:12px;font-weight:600;color:#a89c8a;padding:3px 9px;border-radius:999px;background:rgba(245,241,232,.06)}' +
    '.dsd-badge.ok{color:#8fdc9a;background:rgba(143,220,154,.12)}';

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
