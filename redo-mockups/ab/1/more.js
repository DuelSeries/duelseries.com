/* Layout 1 "Sidebar": shared behaviour for the sidebar's More pages (refer.html, join.html, support.html).
   Load after ../kit.js and layout.js. Mockup only: nothing talks to a server, Gmail and Discord open in a new tab.
   Everything lives on window.L1More:
     support(kind)     the one Support sheet ('help' | 'bug' | 'idea'), today's support.js panel rebuilt on the kit sheet:
                       the address with Copy, Open in Gmail (prefilled for a bug or an idea) and Ask on Discord
     copy(btn, text, toastTitle, toastMsg)  copies, flips the button to "Copied" for 2.2 s and shows the kit toast
     copyIcons()       the copy and check icons a .cp button carries
     MAIL, DISCORD, WHOP, gmail(subject, body)
   Any [data-help="bug|idea|help"] opens the Support sheet; any a[data-help] keeps its Gmail href for a new-tab click. */
(function () {
  'use strict';
  const K = window.DSKit, I = K.icon, esc = K.esc, U = window.DSUI;
  const MAIL = 'playduelseries@gmail.com';
  const DISCORD = 'https://discord.gg/TkFaefHDFr';               /* join.js LINKS.discord */
  const WHOP = 'https://whop.com/duelseries/clip-team-c9/';       /* join.js LINKS.whop */
  const gmail = (subject, body) => 'https://mail.google.com/mail/?view=cm&to=' + MAIL +
    (subject ? '&su=' + encodeURIComponent(subject) : '') + (body ? '&body=' + encodeURIComponent(body) : '');

  /* the three ways in that today's site has (sidebar Support and Settings Contact, Join us Report a bug, Join us Send an idea) */
  const KINDS = {
    help: { title: 'Support', sub: 'Email us, or ask in the Discord.' },
    bug: { title: 'Report a bug', sub: 'Tell us which game, what happened and roughly when.', subject: 'Bug report', body: 'Which game:\nWhat happened:\nRoughly when:\n' },
    idea: { title: 'Send an idea', sub: 'Tell us what you would add or change.', subject: 'Idea for DuelSeries' }
  };

  const copyIcons = () => I('copy', 16, 'class="i-cp"') + I('check', 16, 'class="i-ok"');
  function copy(btn, text, toastTitle, toastMsg) {
    try { navigator.clipboard.writeText(text).catch(() => {}); } catch (_) {}
    const lbl = btn.querySelector('[data-lbl]');
    if (lbl) {
      if (!btn.dataset.was) btn.dataset.was = lbl.textContent;
      lbl.textContent = btn.dataset.done || 'Copied';
    }
    btn.classList.add('is-done');
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.classList.remove('is-done'); if (lbl) lbl.textContent = btn.dataset.was; }, 2200);
    if (toastTitle) U.toast(toastTitle, 'ok', toastMsg);
  }

  function support(kind) {
    const k = KINDS[kind] || KINDS.help;
    const pre = k.subject ? '<div class="mail-pre"><span class="t-label">Gmail opens with this filled in</span>' +
      '<b>Subject: ' + esc(k.subject) + '</b>' + (k.body ? '<pre>' + esc(k.body.trim()) + '</pre>' : '') + '</div>' : '';
    return U.sheet({
      title: k.title,
      html: '<p class="hint">' + esc(k.sub) + '</p>' +
        '<div class="mail">' + I('mail', 20) + '<span class="mail-a">' + MAIL.replace('@', '<wbr>@') + '</span>' +
        '<button type="button" class="btn btn-secondary btn-sm cp" data-mailcopy aria-label="Copy the email address">' + copyIcons() + '<span data-lbl>Copy</span></button></div>' + pre,
      foot: '<a class="btn btn-primary btn-lg btn-block" href="' + esc(gmail(k.subject, k.body)) + '" target="_blank" rel="noopener noreferrer" data-out>' + I('ext', 18) + 'Open in Gmail</a>' +
        '<a class="btn btn-secondary btn-lg btn-block" href="' + DISCORD + '" target="_blank" rel="noopener noreferrer" data-out>' + I('discord', 18) + 'Ask on Discord</a>',
      focus: '[data-mailcopy]',
      onOpen(el, close) {
        el.querySelector('[data-mailcopy]').addEventListener('click', e => copy(e.currentTarget, MAIL, 'Email copied', MAIL));
        el.querySelectorAll('[data-out]').forEach(a => a.addEventListener('click', () => setTimeout(close, 0)));
      }
    });
  }

  /* a plain click opens the sheet; Ctrl, Shift or a middle click on an a[data-help] still opens Gmail in a tab */
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-help]');
    if (!t || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault(); support(t.dataset.help);
  });

  window.L1More = { support, copy, copyIcons, MAIL, DISCORD, WHOP, gmail };
})();
