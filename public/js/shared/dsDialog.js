/* DSDialog: the one popup card for the lobby and every game (Owen's pick "A Gold card", 2026-10-17).
   A centred dark card with a gold rim: a turning ring while something is in flight, a red mark and
   a gold OK for an error, a gold button plus a quiet "no" for a question.

     DSDialog.busy({ title, line })               shows or updates the in-flight card
     DSDialog.alert({ title, line, ok })          resolves when OK is pressed
     DSDialog.confirm({ title, line, ok, cancel }) resolves true or false
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
    '.dsd-go:focus-visible,.dsd-no:focus-visible{outline:2px solid #f4f1ea;outline-offset:3px}';

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
    close: close,
    isOpen: function () { return !!root; },
  };
})();
