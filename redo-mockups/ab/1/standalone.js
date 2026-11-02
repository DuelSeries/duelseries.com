/* Layout 1, standalone pages: the one shared behaviour they add on top of ../kit.js (DSUI).
   [data-support] opens the Support sheet, today's public/js/v2/support.js panel (Copy, Open in Gmail, Ask on Discord),
   which works on the legal pages too. Built from the kit sheet, buttons and toast only. */
(function () {
  'use strict';
  const U = window.DSUI, I = window.DSKit.icon;
  const MAIL = 'playduelseries@gmail.com';

  function support() {
    U.sheet({ title: 'Support', html:
      '<p class="t-body">Email us, or ask in the Discord.</p>' +
      '<div class="addr-box">' + MAIL + '</div>',
      foot: '<button type="button" class="btn btn-primary btn-lg btn-block" data-mailcopy>' + I('copy', 18) + 'Copy the address</button>' +
        '<button type="button" class="btn btn-secondary btn-block" data-gmail>' + I('mail', 18) + 'Open in Gmail</button>' +
        '<button type="button" class="btn btn-secondary btn-block" data-discord>' + I('discord', 18) + 'Ask on Discord</button>',
      onOpen(el, close) {
        el.querySelector('[data-mailcopy]').addEventListener('click', () => {
          try { navigator.clipboard.writeText(MAIL).catch(() => {}); } catch (_) {}
          close(); U.toast('Email copied', 'ok', MAIL);
        });
        el.querySelector('[data-gmail]').addEventListener('click', () => U.toast('Gmail opens here', 'info', 'Mockup: a new tab with the address filled in.'));
        el.querySelector('[data-discord]').addEventListener('click', () => U.toast('Discord opens here', 'info', 'Mockup: the DuelSeries server invite.'));
      } });
  }
  document.addEventListener('click', e => { if (e.target.closest('[data-support]')) { e.preventDefault(); support(); } });

  window.SA = { support, MAIL };
})();
