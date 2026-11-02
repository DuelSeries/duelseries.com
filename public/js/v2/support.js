/* Support: one small panel for every "write to us" link on the site (Owen 2026-10-27).
   The links used to be mailto:, and on a PC with no mail app Windows answers with
   "Select an app to open this link", which looks like a scam. Now a link marked
   data-support opens this panel instead: the address with Copy, Open in Gmail (a new
   tab) and the Discord. The link's own href is the Gmail compose page, so a page whose
   script never ran still lands somewhere useful, and no mailto: is left anywhere.

     <a href="(GMAIL)" target="_blank" rel="noopener" data-support
        data-title="Report a bug" data-sub="..." data-subject="Bug report" data-body="...">

   Self-contained (its own styles, the lobby's tokens with fallbacks) so the legal pages
   load it too. A toast goes through DSToast where the page has it (the lobby). */
(function () {
  'use strict';
  var MAIL = 'playduelseries@gmail.com';
  var DISCORD = 'https://discord.gg/TkFaefHDFr';   // the same server as LINKS.discord in join.js

  function gmail(subject, body) {
    return 'https://mail.google.com/mail/?view=cm&to=' + MAIL
      + (subject ? '&su=' + encodeURIComponent(subject) : '')
      + (body ? '&body=' + encodeURIComponent(body) : '');
  }

  /* The kit's one sheet (site redo stage 3, ds-kit.css .ds-scrim and .ds-sheet), drawn here so the legal pages,
     which may not load the kit, get the same sheet: every value is a --ds- token with the kit's own value as its
     fallback. Centred on a PC, a bottom sheet with a grab handle on a phone. */
  var CSS =
    '.sup-ov{position:fixed;inset:0;z-index:210;background:rgba(0,0,0,.78);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);' +
      'display:flex;align-items:center;justify-content:center;padding:24px;opacity:0;transition:opacity .18s;' +
      'font-family:var(--ds-f,Archivo,"Segoe UI",system-ui,sans-serif)}' +
    '.sup-ov.in{opacity:1}' +
    '.sup{position:relative;width:min(460px,100%);max-height:calc(100dvh - 48px);overflow:auto;overscroll-behavior:contain;' +
      'background:var(--ds-s1,#0d0b08);border-radius:var(--ds-r3,18px);color:var(--ds-bone,#f4f1ea);line-height:1.5;' +
      'box-shadow:0 28px 70px rgba(0,0,0,.8),0 0 0 1px var(--ds-line,#36291a);transform:translateY(14px) scale(.98);' +
      'transition:transform var(--ds-dur-2,.24s) var(--ds-ease,cubic-bezier(.2,.8,.2,1))}' +
    '.sup-ov.in .sup{transform:none}' +
    '.sup-hd{display:flex;align-items:center;gap:12px;padding:16px 16px 0 24px}' +
    '.sup h3{flex:1;margin:0;font-size:18px;font-weight:700;line-height:1.25;color:var(--ds-bone,#f4f1ea)}' +
    '.sup-x{flex:none;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:var(--ds-r2,10px);background:transparent;' +
      'color:var(--ds-tx2,#b3a792);cursor:pointer;transition:background-color .14s,color .14s}' +
    '.sup-x:hover{background:var(--ds-s2,#1a1611);color:var(--ds-bone,#f4f1ea)}' +
    '.sup-bd{display:flex;flex-direction:column;gap:16px;padding:12px 24px 24px}' +
    '.sup-sub{margin:0;font-size:13px;color:var(--ds-tx2,#b3a792)}' +
    /* the address is the point of the sheet: big enough to read off and type in */
    '.sup-addr{display:flex;align-items:center;gap:12px;min-height:60px;padding:6px 6px 6px 16px;background:var(--ds-ink,#000);' +
      'border-radius:var(--ds-r2,10px);box-shadow:inset 0 0 0 1px var(--ds-line,#36291a)}' +
    '.sup-addr>svg{width:20px;height:20px;flex:none;color:var(--ds-tx2,#b3a792)}' +
    '.sup-mail{flex:1;min-width:0;font-size:17px;font-weight:700;letter-spacing:-.005em;color:var(--ds-bone,#f4f1ea);' +
      'overflow-wrap:anywhere;user-select:all;-webkit-user-select:all}' +
    '.sup-cp{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;min-width:92px;padding:0 12px;' +
      'border:0;border-radius:var(--ds-r2,10px);background:var(--ds-s3,#272018);color:var(--ds-bone,#f4f1ea);' +
      'box-shadow:inset 0 0 0 1px var(--ds-line,#36291a);font:650 13px/1 var(--ds-f,inherit);cursor:pointer;transition:background-color .14s,box-shadow .14s}' +
    '.sup-cp:hover{background:#332a1f;box-shadow:inset 0 0 0 1px var(--ds-line2,#5a4630)}' +
    '.sup-cp svg{width:16px;height:16px;color:inherit}' +
    '.sup-cp .ok{display:none}' +
    '.sup-cp.done .cp{display:none}' +
    '.sup-cp.done .ok{display:block;color:var(--ds-green,#8ed081)}' +
    /* what Gmail opens with, for a bug or an idea */
    '.sup-pre{display:flex;flex-direction:column;gap:6px;padding:12px 16px;border-radius:var(--ds-r2,10px);background:var(--ds-s2,#1a1611);' +
      'box-shadow:inset 0 0 0 1px var(--ds-line,#36291a)}' +
    '.sup-pre span{font-size:13px;font-weight:600;color:var(--ds-tx2,#b3a792)}' +
    '.sup-pre b{font-size:15px;font-weight:650;color:var(--ds-bone,#f4f1ea)}' +
    '.sup-pre pre{margin:0;font:inherit;font-size:13px;line-height:1.6;color:var(--ds-tx2,#b3a792);white-space:pre-wrap}' +
    '.sup-go{display:flex;flex-direction:column;gap:8px;padding:0 24px 24px;margin-top:-4px}' +
    '.sup-b{display:flex;align-items:center;justify-content:center;gap:8px;min-height:52px;padding:0 24px;border-radius:var(--ds-r2,10px);' +
      'font:650 16px/1 var(--ds-f,inherit);text-decoration:none;transition:background-color .14s,box-shadow .14s}' +
    '.sup-b svg{width:18px;height:18px;flex:none}' +
    '.sup-b.pri{background:var(--ds-bone,#f4f1ea);color:var(--ds-on-bone,#000);font-weight:700}' +
    '.sup-b.pri:hover{background:#fff;box-shadow:0 0 0 4px rgba(244,241,234,.14)}' +
    '.sup-b.sec{background:var(--ds-s3,#272018);color:var(--ds-bone,#f4f1ea);box-shadow:inset 0 0 0 1px var(--ds-line,#36291a)}' +
    '.sup-b.sec:hover{background:#332a1f;box-shadow:inset 0 0 0 1px var(--ds-line2,#5a4630)}' +
    '.sup svg{stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '.sup :focus-visible{outline:2px solid var(--ds-bone,#f4f1ea);outline-offset:2px}' +
    '.sup-grab{display:none}' +
    '@media(max-width:760px){' +
      '.sup-ov{align-items:flex-end;padding:0}' +
      '.sup{width:100%;max-height:92dvh;border-radius:var(--ds-r3,18px) var(--ds-r3,18px) 0 0;padding-bottom:env(safe-area-inset-bottom);transform:translateY(48px)}' +
      '.sup-grab{display:block;width:40px;height:4px;border-radius:999px;background:var(--ds-line2,#5a4630);margin:8px auto 0}' +
      '.sup-hd{padding:8px 12px 0 16px}' +
      '.sup-bd{padding:12px 16px 16px}' +
      '.sup-go{padding:0 16px 24px}' +
      '.sup-cp{height:44px}' +
      '.sup-mail{font-size:16px}' +
    '}' +
    '@media(prefers-reduced-motion:reduce){.sup-ov,.sup,.sup-b{transition:none}}';

  var ICON = {
    mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    copy: '<svg class="cp" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    ok: '<svg class="ok" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    discord: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 7.5c2.3-.7 4.7-.7 7 0M7.5 16.5c2.8 1 6.2 1 9 0"/><path d="M6.8 6.4C5 9 4.2 12 4.4 15.5c1.4 1.1 2.8 1.8 4.3 2.2l.9-1.6M17.2 6.4C19 9 19.8 12 19.6 15.5c-1.4 1.1-2.8 1.8-4.3 2.2l-.9-1.6"/><circle cx="9.5" cy="12.5" r="1.1"/><circle cx="14.5" cy="12.5" r="1.1"/></svg>'
  };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function track(action) { try { if (window.DSTrack) window.DSTrack.event('support', { action: action }); } catch (_) {} }

  var ov = null, back = null, styled = false;

  /* The sheet's Copy (and the Support page's Copy address, copyFrom): the address to the clipboard, the button says
     Copied for a moment, and a toast says so. */
  function copy(btn, onPage) {
    var lbl = btn.querySelector('.sup-cl');
    var was = lbl ? lbl.textContent : 'Copy';
    var mark = onPage ? 'is-done' : 'done';
    var done = function () {
      btn.classList.add(mark);
      if (lbl) lbl.textContent = 'Copied';
      clearTimeout(btn._t);
      btn._t = setTimeout(function () { btn.classList.remove(mark); if (lbl) lbl.textContent = was; }, 1800);
      if (window.DSToast) DSToast.show({ kind: 'ok', title: 'Email copied', detail: MAIL });
      track('copy');
    };
    var fallback = function () {
      var t = document.createElement('textarea');
      t.value = MAIL; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(t); t.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      t.remove();
      if (ok) return done();
      // Nothing would copy: leave the address selected so Ctrl+C (or a long press) takes it.
      var r = document.createRange(), sel = window.getSelection();
      var text = onPage ? document.getElementById('sup-big') : ov && ov.querySelector('.sup-mail');
      if (text) r.selectNodeContents(text);
      sel.removeAllRanges(); sel.addRange(r);
      var touch = window.matchMedia && matchMedia('(hover:none)').matches;
      if (window.DSToast) DSToast.show({ kind: 'info', title: 'Copy the address', detail: touch ? 'It is selected, tap Copy in the menu' : 'It is selected, press Ctrl+C' });
    };
    try {
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(MAIL).then(done, fallback);
      else fallback();
    } catch (_) { fallback(); }
  }

  function open(o) {
    o = o || {};
    if (ov) close();
    if (!styled) {
      var st = document.createElement('style');
      st.id = 'sup-css'; st.textContent = CSS;
      document.head.appendChild(st);
      styled = true;
    }
    back = document.activeElement;
    var title = o.title || 'Support';
    var sub = o.sub || 'Email us, or ask in the Discord.';
    ov = document.createElement('div');
    ov.className = 'sup-ov';
    // A bug report or an idea says what Gmail opens with, so nobody wonders what the button will write.
    var pre = o.subject ? '<div class="sup-pre"><span>Gmail opens with this filled in</span><b>Subject: ' + esc(o.subject) + '</b>' +
      (o.body ? '<pre>' + esc(String(o.body).trim()) + '</pre>' : '') + '</div>' : '';
    ov.innerHTML =
      '<div class="sup" role="dialog" aria-modal="true" aria-labelledby="sup-t">' +
        '<div class="sup-grab" aria-hidden="true"></div>' +
        '<div class="sup-hd"><h3 id="sup-t">' + esc(title) + '</h3>' +
          '<button class="sup-x" type="button" aria-label="Close">' + ICON.x + '</button></div>' +
        '<div class="sup-bd"><p class="sup-sub">' + esc(sub) + '</p>' +
        '<div class="sup-addr">' + ICON.mail + '<span class="sup-mail">' + MAIL.replace('@', '<wbr>@') + '</span>' +
          '<button class="sup-cp" type="button" aria-label="Copy the email address">' + ICON.copy + ICON.ok +
          '<span class="sup-cl" aria-live="polite">Copy</span></button></div>' + pre + '</div>' +
        '<div class="sup-go">' +
          '<a class="sup-b pri" href="' + esc(gmail(o.subject, o.body)) + '" target="_blank" rel="noopener noreferrer" data-a="gmail">' +
            ICON.open + 'Open in Gmail</a>' +
          '<a class="sup-b sec" href="' + DISCORD + '" target="_blank" rel="noopener noreferrer" data-a="discord">' +
            ICON.discord + 'Ask on Discord</a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    var card = ov.querySelector('.sup');
    ov.addEventListener('click', function (e) {
      if (e.target === ov || e.target.closest('.sup-x')) return close();
      if (e.target.closest('.sup-cp')) return copy(e.target.closest('.sup-cp'));
      var a = e.target.closest('[data-a]');
      if (a) { track(a.getAttribute('data-a')); setTimeout(close, 0); }
    });
    // Swipe down on a phone closes it, like the lobby's other sheets.
    var y0 = null;
    card.addEventListener('touchstart', function (e) { y0 = e.touches[0].clientY; }, { passive: true });
    card.addEventListener('touchend', function (e) {
      if (y0 != null && e.changedTouches[0].clientY - y0 > 70) close();
      y0 = null;
    }, { passive: true });
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(function () { if (ov) ov.classList.add('in'); });
    ov.querySelector('.sup-cp').focus();
    track('open');
  }

  function close() {
    if (!ov) return;
    document.removeEventListener('keydown', onKey, true);
    ov.remove();
    ov = null;
    if (back && back.focus && document.contains(back)) back.focus();
    back = null;
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the panel while it is up.
    var f = ov.querySelectorAll('button,a[href]');
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // Any data-support link opens the panel. Ctrl, Shift or a middle click still opens Gmail in a tab.
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-support]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    open({ title: a.dataset.title, sub: a.dataset.sub, subject: a.dataset.subject, body: a.dataset.body });
  });

  /* The Support page's Copy address (v2.html #support-screen). */
  function copyFrom(btn) { if (btn) copy(btn, true); }

  window.DSSupport = { open: open, close: close, gmail: gmail, copyFrom: copyFrom, MAIL: MAIL };
})();
