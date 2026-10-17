/* The owner's maintenance, as the lobby shows it (Owen 2026-10-17).

   While Control has the site in maintenance a slim bar sits across the top of
   the lobby, PC and phone, saying "Updating, back in a few minutes" (the
   server's message), and Play refuses with the same words (play.js launch).
   Paid entry is refused by the server as well, so a stale page cannot stake.
   Anyone already in a game is left alone: the bar sits over the lobby, and a
   running game frame keeps playing and cashing out as normal.

   Two inputs, the same shape after norm(): /api/live's `maintenance`
   ({ on, message }, board.js) and the server's live 'maintenance' push
   ({ maintenance, message }, toasts.js's quiet socket). */
(function () {
  let state = { on: false, message: '' };
  let bar = null;

  function norm(m) {
    if (!m || typeof m !== 'object') return null;
    const on = typeof m.on === 'boolean' ? m.on : !!m.maintenance;
    const raw = typeof m.message === 'string' ? m.message : '';
    const message = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    return { on, message };
  }
  function text() { return state.message || 'Updating, back in a few minutes'; }

  function draw() {
    if (!document.body) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ds-maint';
      bar.setAttribute('role', 'status');
      bar.setAttribute('aria-live', 'polite');
      bar.hidden = true;
      const css = document.createElement('style');
      css.textContent =
        /* Above the header (50) and the nav (60), below the sheets (210) and
           the game frame (300): a running game is never covered. The header,
           the PC sidebar and the phone's scrolling area move down under it. */
        '#ds-maint{position:fixed;top:0;left:0;right:0;z-index:205;display:flex;align-items:center;' +
        'box-sizing:border-box;height:calc(36px + env(safe-area-inset-top,0px));' +
        'padding:env(safe-area-inset-top,0px) 16px 0;' +
        'justify-content:center;gap:10px;background:var(--s2,#1f1b15);color:var(--tx,#f5f1e8);' +
        'border-bottom:1px solid var(--money,#f0a830);font:600 13.5px/1.3 var(--f,system-ui,sans-serif);' +
        'letter-spacing:.01em;text-align:center;box-shadow:0 6px 20px rgba(0,0,0,.35)}' +
        '#ds-maint[hidden]{display:none}' +
        '#ds-maint i{flex:none;width:8px;height:8px;border-radius:50%;background:var(--money,#f0a830)}' +
        'body.ds-maint{padding-top:36px}' +
        'body.ds-maint header{top:36px}' +
        '@media(min-width:761px){body.ds-maint .nav{top:36px}}' +
        '@media(max-width:760px){body.ds-maint{padding-top:0}' +
        'body.ds-maint header{top:calc(36px + env(safe-area-inset-top,0px));padding-top:0}' +
        'body.ds-maint main.wrap{top:calc(92px + env(safe-area-inset-top,0px))}}';
      (document.head || document.body).appendChild(css);
      bar.appendChild(document.createElement('i'));
      bar.appendChild(document.createElement('span'));
      document.body.appendChild(bar);
    }
    bar.lastChild.textContent = text();
    bar.hidden = !state.on;
    document.body.classList.toggle('ds-maint', state.on);
  }

  function set(m) {
    const n = norm(m);
    if (!n) return;
    state = n;
    draw();
  }

  window.V2Maint = { set: set, on: () => state.on, message: text };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw);
})();
