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

  var CSS =
    '.sup-ov{position:fixed;inset:0;z-index:210;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;' +
      'opacity:0;transition:opacity .18s;font-family:var(--f,inherit)}' +
    '.sup-ov.in{opacity:1}' +
    '.sup{width:min(400px,calc(100vw - 32px));background:var(--s1,#17140f);border:1px solid var(--s3,#282219);border-radius:14px;' +
      'padding:16px 16px 18px;color:var(--tx2,#a89c8a);line-height:1.4;transform:translateY(12px);transition:transform .2s}' +
    '.sup-ov.in .sup{transform:none}' +
    '.sup-hd{display:flex;align-items:center;gap:8px}' +
    '.sup h3{margin:0;font-size:17px;font-weight:700;letter-spacing:-.01em;color:var(--tx,#f5f1e8)}' +
    '.sup-x{margin-left:auto;border:0;background:var(--s2,#1f1b15);color:var(--tx2,#a89c8a);width:30px;height:30px;border-radius:8px;' +
      'font:400 17px/1 var(--f,inherit);cursor:pointer;transition:background .15s,color .15s}' +
    '.sup-x:hover{background:var(--s3,#282219);color:var(--tx,#f5f1e8)}' +
    '.sup-sub{margin:6px 0 14px;font-size:13.5px;color:var(--tx3,#8d8171)}' +
    /* the address is the point of the panel: big enough to read off and type in */
    '.sup-addr{display:flex;align-items:center;gap:10px;min-height:54px;padding:0 6px 0 14px;background:var(--bg,#100e0b);' +
      'border:1px solid var(--s3,#282219);border-radius:10px}' +
    '.sup-addr svg{width:18px;height:18px;flex:none;color:var(--tx3,#8d8171)}' +
    '.sup-mail{flex:1;min-width:0;font-size:15.5px;font-weight:600;letter-spacing:-.01em;color:var(--tx,#f5f1e8);' +
      'overflow-wrap:anywhere;user-select:all;-webkit-user-select:all}' +
    '.sup-cp{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:40px;min-width:78px;padding:0 12px;' +
      'border:0;border-radius:8px;background:var(--s2,#1f1b15);color:var(--tx,#f5f1e8);font:600 13.5px/1 var(--f,inherit);cursor:pointer;' +
      'transition:background .15s}' +
    '.sup-cp:hover{background:var(--s3,#282219)}' +
    '.sup-cp svg{width:15px;height:15px;color:inherit}' +
    '.sup-cp .ok{display:none}' +
    '.sup-cp.done{color:var(--live,#8ed081)}' +
    '.sup-cp.done .cp{display:none}' +
    '.sup-cp.done .ok{display:block}' +
    '.sup-go{display:flex;flex-direction:column;gap:8px;margin-top:10px}' +
    '.sup-b{display:flex;align-items:center;justify-content:center;gap:9px;min-height:46px;padding:0 14px;border-radius:10px;' +
      'font:600 14px/1 var(--f,inherit);text-decoration:none;transition:background .15s,color .15s,transform .15s}' +
    '.sup-b svg{width:18px;height:18px;flex:none}' +
    '.sup-b.pri{background:var(--bone,#f4f1ea);color:var(--ink,#100e0b)}' +
    '.sup-b.pri:hover{transform:translateY(-1px)}' +
    '.sup-b.sec{background:var(--s2,#1f1b15);color:var(--tx2,#a89c8a)}' +
    '.sup-b.sec:hover{background:var(--s3,#282219);color:var(--tx,#f5f1e8)}' +
    '.sup svg{stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}' +
    '.sup svg.fill{fill:currentColor;stroke:none}' +
    '.sup :focus-visible{outline:2px solid var(--bone,#f4f1ea);outline-offset:2px}' +
    '.sup-grab{display:none}' +
    '@media(max-width:760px){' +
      '.sup-ov{align-items:flex-end}' +
      '.sup{width:100%;border-radius:20px 20px 0 0;border-bottom:0;padding-bottom:calc(20px + env(safe-area-inset-bottom));' +
        'transform:translateY(40px)}' +
      '.sup-grab{display:block;width:38px;height:4px;border-radius:2px;background:var(--s3,#282219);margin:0 auto 12px}' +
      '.sup-b{min-height:50px}' +
    '}' +
    '@media(prefers-reduced-motion:reduce){.sup-ov,.sup,.sup-b{transition:none}}';

  var ICON = {
    mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6 8.5-6"/></svg>',
    copy: '<svg class="cp" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    ok: '<svg class="ok" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    discord: '<svg class="fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.3 4.4a19.8 19.8 0 0 0-4.9-1.5l-.6 1.3a18.4 18.4 0 0 0-5.5 0L8.7 2.9a19.7 19.7 0 0 0-4.9 1.5C.5 9 -.3 13.6.1 18.1a19.9 19.9 0 0 0 6 3l1.3-2a12.9 12.9 0 0 1-1.9-.9l.4-.3a14.2 14.2 0 0 0 12.1 0l.4.3c-.6.4-1.2.7-1.9.9l1.2 2a19.8 19.8 0 0 0 6-3c.5-5.2-.8-9.7-3.5-13.7zM8 15.3c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4z"/></svg>'
  };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function track(action) { if (window.phEvent) window.phEvent('support', { action: action }); }

  var ov = null, back = null, styled = false;

  function copy(btn) {
    var done = function () {
      btn.classList.add('done');
      btn.querySelector('.sup-cl').textContent = 'Copied';
      clearTimeout(btn._t);
      btn._t = setTimeout(function () { btn.classList.remove('done'); btn.querySelector('.sup-cl').textContent = 'Copy'; }, 1800);
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
      r.selectNodeContents(ov.querySelector('.sup-mail'));
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
    ov.innerHTML =
      '<div class="sup" role="dialog" aria-modal="true" aria-labelledby="sup-t">' +
        '<div class="sup-grab" aria-hidden="true"></div>' +
        '<div class="sup-hd"><h3 id="sup-t">' + esc(title) + '</h3>' +
          '<button class="sup-x" type="button" aria-label="Close">×</button></div>' +
        '<p class="sup-sub">' + esc(sub) + '</p>' +
        '<div class="sup-addr">' + ICON.mail + '<span class="sup-mail">' + MAIL + '</span>' +
          '<button class="sup-cp" type="button" aria-label="Copy the email address">' + ICON.copy + ICON.ok +
          '<span class="sup-cl" aria-live="polite">Copy</span></button></div>' +
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

  window.DSSupport = { open: open, close: close, gmail: gmail, MAIL: MAIL };
})();
